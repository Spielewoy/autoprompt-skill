#!/usr/bin/env node
'use strict'

// A model worker never receives the real target as its writable workspace.
// It edits a private physical clone and the deterministic supervisor promotes
// only the exact observed/declared files after rechecking every owned preimage.

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  atomicWriteJson,
  fsyncDirectory,
  readChecksummedJson,
  sha256,
  stableStringify,
} = require('./event-log.js')
const {
  ensureDirectoryNoFollow,
  inspectPathNoFollow,
  pathIsInside,
} = require('./safe-run-root.js')

const HASH_PATTERN = /^[a-f0-9]{64}$/

class WorkerWorkspaceError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'WorkerWorkspaceError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new WorkerWorkspaceError(code, message, details)
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail('WORKER_WORKSPACE_INVALID', 'workspace paths must be non-empty strings without NUL bytes')
  }
  const relative = value.replace(/\\/g, '/')
  if (relative.startsWith('/') || /^[A-Za-z]:\//.test(relative) ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('WORKER_WORKSPACE_INVALID', `workspace path is not canonical relative text: ${value}`)
  }
  return relative
}

function resolveInside(root, relative) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...normalizeRelative(relative).split('/'))
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail('WORKER_WORKSPACE_INVALID', `workspace path escapes its root: ${relative}`)
  }
  return resolved
}

function fileState(absolute, fsImpl = fs) {
  let inspected
  try { inspected = inspectPathNoFollow(absolute, { mustBeDirectory: false }) } catch (error) {
    fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `workspace path crosses a link, junction, or reparse point: ${absolute}`, {
      cause: error.code || error.message,
    })
  }
  if (!inspected.exists) return null
  const stat = fsImpl.lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) {
    fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `worker isolation accepts only single-link regular files: ${absolute}`)
  }
  return Object.freeze({ hash: sha256(fsImpl.readFileSync(absolute)), mode: stat.mode & 0o777 })
}

function runGit(repository, argv, options = {}) {
  const result = childProcess.spawnSync('git', ['-C', repository, ...argv], {
    encoding: options.encoding === null ? null : 'utf8',
    env: options.environment || process.env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    fail('WORKER_ISOLATION_UNSUPPORTED', `local Git operation failed: ${argv.join(' ')}`, {
      status: result.status,
      stderr: String(result.stderr || ''),
    })
  }
  return result.stdout
}

function repositorySnapshot(repository, environment, fsImpl = fs) {
  const root = path.resolve(repository)
  const raw = Buffer.from(runGit(root, ['ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: null,
    environment,
  }))
  const names = raw.toString('utf8').split('\0').filter(Boolean).map(normalizeRelative).sort()
  const rows = []
  for (const relative of names) {
    const absolute = resolveInside(root, relative)
    const state = fileState(absolute, fsImpl)
    rows.push(Object.freeze({ path: relative, hash: state && state.hash || null, mode: state && state.mode || null }))
  }
  return Object.freeze(rows)
}

function snapshotMap(snapshot) {
  return new Map(snapshot.map(entry => [entry.path, entry]))
}

function snapshotsEqual(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function assignmentHash(assignment) {
  return sha256(stableStringify(assignment))
}

function resourcePath(targetRoot, resource) {
  if (!resource || !['file', 'directory', 'output', 'cache', 'evidence-root'].includes(resource.kind)) return null
  const identity = String(resource.identity || '').replace(/\\/g, '/')
  if (identity === 'workspace' || identity === '.') return path.resolve(targetRoot)
  return resolveInside(targetRoot, identity)
}

function ownsRelative(targetRoot, resources, relative) {
  const absolute = resolveInside(targetRoot, relative)
  return resources.some(resource => {
    if (!resource || resource.access === 'read') return false
    const owned = resourcePath(targetRoot, resource)
    if (!owned) return false
    return ['directory', 'output', 'cache', 'evidence-root'].includes(resource.kind)
      ? absolute === owned || absolute.startsWith(`${owned}${path.sep}`)
      : absolute === owned
  })
}

function scopedSnapshot(snapshot, targetRoot, resources) {
  return snapshot.filter(entry => ownsRelative(targetRoot, resources, entry.path))
}

function ensurePhysicalDirectory(directory, boundary, fsImpl = fs) {
  const root = path.resolve(boundary)
  const target = path.resolve(directory)
  if (!pathIsInside(root, target)) {
    fail('WORKER_WORKSPACE_INVALID', 'directory creation escaped its boundary')
  }
  try {
    inspectPathNoFollow(root)
    ensureDirectoryNoFollow(target, root)
    inspectPathNoFollow(target)
  } catch (error) {
    fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `workspace directory crosses a link, junction, or reparse point: ${target}`, {
      cause: error.code || error.message,
    })
  }
}

function removeFileIfPresent(filename, fsImpl = fs) {
  if (!fsImpl.existsSync(filename)) return
  const stat = fsImpl.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `refusing to remove a non-regular workspace entry: ${filename}`)
  }
  fsImpl.unlinkSync(filename)
}

function removeEmptyParents(start, boundary, fsImpl = fs) {
  const root = path.resolve(boundary)
  let cursor = path.resolve(start)
  while (cursor !== root && cursor.startsWith(`${root}${path.sep}`)) {
    if (!fsImpl.existsSync(cursor) || fsImpl.readdirSync(cursor).length !== 0) break
    fsImpl.rmdirSync(cursor)
    cursor = path.dirname(cursor)
  }
}

function fsyncFile(filename, fsImpl = fs) {
  const descriptor = fsImpl.openSync(filename, 'r+')
  try { fsImpl.fsyncSync(descriptor) } finally { fsImpl.closeSync(descriptor) }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return Boolean(error && error.code !== 'ESRCH') }
}

function waitForFile(filename, timeoutMs, fsImpl = fs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fsImpl.existsSync(filename)) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  return fsImpl.existsSync(filename)
}

class WorkerWorkspaceManager {
  constructor(options = {}) {
    if (typeof options.targetRoot !== 'string' || typeof options.privateRoot !== 'string') {
      fail('WORKER_ISOLATION_UNSUPPORTED', 'worker isolation requires exact target and private roots')
    }
    this.fs = options.fsImpl || fs
    this.targetRoot = path.resolve(options.targetRoot)
    this.privateRoot = path.resolve(options.privateRoot)
    this.environment = options.environment || process.env
    this.runId = String(options.runId || '')
    this.activationId = String(options.activationId || '')
    this.afterPromotionStep = typeof options.afterPromotionStep === 'function'
      ? options.afterPromotionStep : null
    this.hardenWorkspace = typeof options.hardenWorkspace === 'function'
      ? options.hardenWorkspace : null
    let targetInspection
    try { targetInspection = inspectPathNoFollow(this.targetRoot) } catch (error) {
      fail('WORKER_ISOLATION_UNSUPPORTED', 'worker target path crosses a link, junction, or reparse point', {
        cause: error.code || error.message,
      })
    }
    if (!targetInspection.exists) {
      fail('WORKER_ISOLATION_UNSUPPORTED', 'worker target must be one existing physical directory')
    }
    this.targetRoot = targetInspection.realpath
    const privateParent = path.dirname(this.privateRoot)
    try {
      inspectPathNoFollow(privateParent)
      ensureDirectoryNoFollow(this.privateRoot, privateParent)
    } catch (error) {
      fail('WORKER_ISOLATION_UNSUPPORTED', 'private worker root crosses a link, junction, or reparse point', {
        cause: error.code || error.message,
      })
    }
    const privateInspection = inspectPathNoFollow(this.privateRoot)
    this.privateRoot = privateInspection.realpath
    if (!this.runId || !this.activationId ||
        this.privateRoot === this.targetRoot || this.privateRoot.startsWith(`${this.targetRoot}${path.sep}`) ||
        this.targetRoot.startsWith(`${this.privateRoot}${path.sep}`)) {
      fail('WORKER_ISOLATION_UNSUPPORTED', 'private worker workspaces must be outside the real target')
    }
    ensurePhysicalDirectory(path.join(this.privateRoot, 'workspaces'), this.privateRoot, this.fs)
    ensurePhysicalDirectory(path.join(this.privateRoot, 'records'), this.privateRoot, this.fs)
    ensurePhysicalDirectory(path.join(this.privateRoot, 'transactions'), this.privateRoot, this.fs)
  }

  prepare(options = {}) {
    const assignment = options.assignment
    if (!assignment || !Array.isArray(assignment.resources) || typeof options.workItemId !== 'string') {
      fail('WORKER_WORKSPACE_INVALID', 'worker workspace requires a canonical assignment and work item')
    }
    const boundAssignmentHash = assignmentHash(assignment)
    const workspaceId = sha256(stableStringify({
      runId: this.runId,
      activationId: this.activationId,
      workItemId: options.workItemId,
      assignmentHash: boundAssignmentHash,
    })).slice(0, 40)
    const workspacePath = path.join(this.privateRoot, 'workspaces', workspaceId)
    const recordPath = path.join(this.privateRoot, 'records', `${workspaceId}.json`)
    if (this.fs.existsSync(recordPath)) {
      const existing = readChecksummedJson(recordPath, { fsImpl: this.fs })
      this._validateRecord(existing, { workspaceId, boundAssignmentHash, workspacePath })
      this.recover(existing)
      const recovered = readChecksummedJson(recordPath, { fsImpl: this.fs })
      if (['COMMITTED', 'FINALIZED'].includes(recovered.status)) {
        fail('WORKER_WORKSPACE_ALREADY_PROMOTED', `worker workspace ${workspaceId} was already promoted`)
      }
      if (!this.fs.existsSync(workspacePath)) {
        fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'prepared worker workspace disappeared before reuse')
      }
      return this._session(recovered, assignment)
    }

    const baseline = repositorySnapshot(this.targetRoot, this.environment, this.fs)
    const parent = path.dirname(workspacePath)
    ensurePhysicalDirectory(parent, this.privateRoot, this.fs)
    const clone = childProcess.spawnSync('git', [
      'clone', '--no-local', '--no-hardlinks', '--', this.targetRoot, workspacePath,
    ], {
      encoding: 'utf8', env: this.environment, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    })
    if (clone.status !== 0) {
      fail('WORKER_ISOLATION_UNSUPPORTED', 'could not materialize a private physical Git clone', {
        status: clone.status, stderr: String(clone.stderr || ''),
      })
    }
    runGit(workspacePath, ['remote', 'remove', 'origin'], { environment: this.environment })
    const alternates = path.join(workspacePath, '.git', 'objects', 'info', 'alternates')
    if (this.fs.existsSync(alternates)) {
      fail('WORKER_ISOLATION_UNSUPPORTED', 'private clone unexpectedly shares the target object database')
    }
    if (this.hardenWorkspace) {
      const hardened = this.hardenWorkspace(workspacePath)
      if (!hardened || hardened.accepted !== true) {
        fail('WORKER_ISOLATION_UNSUPPORTED', 'private clone did not pass the local-only Git safety repair')
      }
    }
    for (const entry of baseline) {
      const source = resolveInside(this.targetRoot, entry.path)
      const destination = resolveInside(workspacePath, entry.path)
      ensurePhysicalDirectory(path.dirname(destination), workspacePath, this.fs)
      if (entry.hash === null) {
        removeFileIfPresent(destination, this.fs)
        continue
      }
      const sourceState = fileState(source, this.fs)
      if (!sourceState || sourceState.hash !== entry.hash) {
        fail('CONCURRENT_MUTATION', `target changed while the private workspace was materialized: ${entry.path}`)
      }
      removeFileIfPresent(destination, this.fs)
      this.fs.copyFileSync(source, destination, this.fs.constants.COPYFILE_EXCL)
      this.fs.chmodSync(destination, entry.mode)
    }
    const cloned = repositorySnapshot(workspacePath, this.environment, this.fs)
    if (!snapshotsEqual(cloned, baseline)) {
      fail('WORKER_ISOLATION_MISMATCH', 'private workspace does not reproduce the target working tree exactly')
    }
    const binding = {
      schemaVersion: 1,
      workspaceId,
      assignmentHash: boundAssignmentHash,
      targetSnapshotHash: sha256(stableStringify(baseline)),
    }
    binding.bindingHash = sha256(stableStringify(binding))
    const record = {
      schemaVersion: 1,
      workspaceId,
      runId: this.runId,
      activationId: this.activationId,
      workItemId: options.workItemId,
      assignmentHash: boundAssignmentHash,
      targetRootHash: sha256(this.targetRoot),
      workspacePath,
      recordPath,
      status: 'PREPARED',
      baseline,
      actualFilesChanged: [],
      transaction: null,
      binding,
    }
    atomicWriteJson(recordPath, record, { fsImpl: this.fs })
    return this._session(record, assignment)
  }

  reopen(options = {}) {
    const assignment = options.assignment
    if (!assignment || !Array.isArray(assignment.resources) || typeof options.workItemId !== 'string') {
      fail('WORKER_WORKSPACE_INVALID', 'worker workspace recovery requires a canonical assignment and work item')
    }
    const boundAssignmentHash = assignmentHash(assignment)
    const workspaceId = sha256(stableStringify({
      runId: this.runId,
      activationId: this.activationId,
      workItemId: options.workItemId,
      assignmentHash: boundAssignmentHash,
    })).slice(0, 40)
    const workspacePath = path.join(this.privateRoot, 'workspaces', workspaceId)
    const recordPath = path.join(this.privateRoot, 'records', `${workspaceId}.json`)
    if (options.recordPath && path.resolve(options.recordPath) !== path.resolve(recordPath)) {
      fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'deferred promotion record points to a foreign workspace journal')
    }
    if (!this.fs.existsSync(recordPath)) {
      fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'deferred promotion workspace journal is missing')
    }
    const existing = readChecksummedJson(recordPath, { fsImpl: this.fs })
    this._validateRecord(existing, { workspaceId, boundAssignmentHash, workspacePath })
    if (!['COMMITTED', 'FINALIZED'].includes(existing.status)) this.recover(existing)
    const recovered = readChecksummedJson(recordPath, { fsImpl: this.fs })
    this._validateRecord(recovered, { workspaceId, boundAssignmentHash, workspacePath })
    return this._session(recovered, assignment)
  }

  inspect(session, result) {
    const record = this._readSession(session)
    const after = repositorySnapshot(record.workspacePath, this.environment, this.fs)
    const beforeMap = snapshotMap(record.baseline)
    const afterMap = snapshotMap(after)
    const names = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()
    const actual = names.filter(relative =>
      (beforeMap.get(relative) && beforeMap.get(relative).hash || null) !==
      (afterMap.get(relative) && afterMap.get(relative).hash || null))
    const outside = actual.filter(relative => !ownsRelative(this.targetRoot, session.assignment.resources, relative))
    if (outside.length) {
      fail('OWNERSHIP_SCOPE_VIOLATION', 'worker changed files outside its admitted ownership in the private workspace', {
        outside,
        admitted: session.assignment.resources.filter(resource => resource.access !== 'read')
          .map(resource => `${resource.kind}:${resource.identity}`),
      })
    }
    const reported = Array.isArray(result && result.filesChanged)
      ? [...new Set(result.filesChanged.map(normalizeRelative))].sort() : []
    if (stableStringify(reported) !== stableStringify(actual)) {
      fail('MUTATION_REPORT_MISMATCH', 'worker file report does not match the isolated physical diff', {
        reported, actual,
      })
    }
    return Object.freeze({
      actualFilesChanged: Object.freeze(actual),
      after: Object.freeze(after),
      postimages: Object.freeze(actual.map(relative => {
        const entry = afterMap.get(relative)
        return Object.freeze({ path: resolveInside(this.targetRoot, relative), hash: entry && entry.hash || null })
      })),
    })
  }

  promote(session, admission) {
    let record = this._readSession(session)
    if (!admission || !Array.isArray(admission.actualFilesChanged) || !Array.isArray(admission.after)) {
      fail('WORKER_PROMOTION_INVALID', 'promotion requires the exact inspected isolated diff')
    }
    if (record.status === 'COMMITTED') return this._committedPostimages(record)
    if (record.status !== 'PREPARED' && record.status !== 'ROLLED_BACK') {
      fail('WORKER_PROMOTION_INVALID', `worker workspace cannot promote from ${record.status}`)
    }
    const currentTarget = repositorySnapshot(this.targetRoot, this.environment, this.fs)
    const expectedScope = scopedSnapshot(record.baseline, this.targetRoot, session.assignment.resources)
    const currentScope = scopedSnapshot(currentTarget, this.targetRoot, session.assignment.resources)
    if (!snapshotsEqual(currentScope, expectedScope)) {
      fail('CONCURRENT_MUTATION', 'owned target resources changed before isolated CAS promotion', {
        expectedScopeHash: sha256(stableStringify(expectedScope)),
        actualScopeHash: sha256(stableStringify(currentScope)),
      })
    }
    const beforeMap = snapshotMap(record.baseline)
    const afterMap = snapshotMap(admission.after)
    const transactionId = crypto.randomBytes(12).toString('hex')
    const transactionRoot = path.join(this.privateRoot, 'transactions', `${record.workspaceId}-${transactionId}`)
    this.fs.mkdirSync(path.join(transactionRoot, 'backups'), { recursive: true, mode: 0o700 })
    const entries = admission.actualFilesChanged.map((relative, index) => {
      const before = beforeMap.get(relative) || { path: relative, hash: null, mode: null }
      const after = afterMap.get(relative) || { path: relative, hash: null, mode: null }
      const target = resolveInside(this.targetRoot, relative)
      const source = resolveInside(record.workspacePath, relative)
      const suffix = `${record.workspaceId.slice(0, 10)}-${transactionId}-${index}`
      const staged = path.join(path.dirname(target), `.autoprompt-cas-${suffix}.new`)
      const displaced = path.join(path.dirname(target), `.autoprompt-cas-${suffix}.old`)
      const backup = path.join(transactionRoot, 'backups', String(index))
      ensurePhysicalDirectory(path.dirname(target), this.targetRoot, this.fs)
      if (before.hash !== null) {
        const state = fileState(target, this.fs)
        if (!state || state.hash !== before.hash) fail('CONCURRENT_MUTATION', `target preimage changed: ${relative}`)
        this.fs.copyFileSync(target, backup, this.fs.constants.COPYFILE_EXCL)
        this.fs.chmodSync(backup, before.mode)
        fsyncFile(backup, this.fs)
      }
      if (after.hash !== null) {
        const state = fileState(source, this.fs)
        if (!state || state.hash !== after.hash) fail('WORKER_PROMOTION_INVALID', `isolated postimage changed: ${relative}`)
        this.fs.copyFileSync(source, staged, this.fs.constants.COPYFILE_EXCL)
        this.fs.chmodSync(staged, after.mode)
        fsyncFile(staged, this.fs)
      }
      return {
        path: relative,
        beforeHash: before.hash,
        beforeMode: before.mode,
        afterHash: after.hash,
        afterMode: after.mode,
        target,
        staged,
        displaced,
        backup: before.hash === null ? null : backup,
      }
    })
    record = {
      ...record,
      status: 'PREPARED_PROMOTION',
      actualFilesChanged: [...admission.actualFilesChanged],
      transaction: { id: transactionId, root: transactionRoot, appliedCount: 0, entries },
    }
    atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
    record = { ...record, status: 'PROMOTING' }
    atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
    record = this._armRollbackGuardian(record)
    try {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        const current = fileState(entry.target, this.fs)
        if ((current && current.hash || null) !== entry.beforeHash) {
          fail('CONCURRENT_MUTATION', `target changed during CAS promotion: ${entry.path}`)
        }
        if (entry.beforeHash !== null) this.fs.renameSync(entry.target, entry.displaced)
        if (entry.afterHash !== null) this.fs.renameSync(entry.staged, entry.target)
        fsyncDirectory(path.dirname(entry.target), this.fs)
        if (this.afterPromotionStep) this.afterPromotionStep({
          workspaceId: record.workspaceId,
          transactionId,
          index,
          path: entry.path,
        })
        record = {
          ...record,
          transaction: { ...record.transaction, appliedCount: index + 1 },
        }
        atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
      }
      for (const entry of entries) {
        const current = fileState(entry.target, this.fs)
        if ((current && current.hash || null) !== entry.afterHash) {
          fail('MUTATION_RESULT_MISMATCH', `promoted target does not match the isolated postimage: ${entry.path}`)
        }
      }
      record = { ...record, status: 'COMMITTED' }
      atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
      return this._committedPostimages(record)
    } catch (error) {
      try {
        record = this._rollback(readChecksummedJson(record.recordPath, { fsImpl: this.fs }))
        this._disarmRollbackGuardian(record)
      } catch (rollbackError) {
        fail('WORKER_ROLLBACK_FAILED', 'isolated CAS promotion failed and exact rollback could not be proven', {
          promotionCode: error.code || 'WORKER_PROMOTION_FAILED',
          promotionMessage: error.message,
          rollbackCode: rollbackError.code || 'WORKER_ROLLBACK_FAILED',
          rollbackMessage: rollbackError.message,
        })
      }
      throw error
    }
  }

  _armRollbackGuardian(record) {
    const token = crypto.randomBytes(24).toString('hex')
    const base = `${record.recordPath}.guardian-${record.transaction.id}`
    const guardian = {
      token,
      requestPath: `${base}.request.json`,
      readyPath: `${base}.ready.json`,
      disarmPath: `${base}.disarm.json`,
      resultPath: `${base}.result.json`,
      ownerPid: process.pid,
    }
    record = {
      ...record,
      transaction: { ...record.transaction, guardian },
    }
    atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
    atomicWriteJson(guardian.requestPath, {
      schemaVersion: 1,
      token,
      recordPath: record.recordPath,
      targetRoot: this.targetRoot,
      privateRoot: this.privateRoot,
      runId: this.runId,
      activationId: this.activationId,
      ownerPid: process.pid,
      readyPath: guardian.readyPath,
      disarmPath: guardian.disarmPath,
      resultPath: guardian.resultPath,
    }, { fsImpl: this.fs })
    const child = childProcess.spawn(process.execPath, [__filename, '--rollback-guardian', guardian.requestPath], {
      detached: true,
      windowsHide: true,
      // The IPC pipe is an exact owner-process lifetime signal. Unlike PID
      // polling, it cannot be confused by PID reuse after an abrupt exit.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: this.environment,
    })
    child.unref()
    if (child.channel && typeof child.channel.unref === 'function') child.channel.unref()
    if (!waitForFile(guardian.readyPath, 5_000, this.fs)) {
      try { process.kill(child.pid) } catch {}
      fail('WORKER_GUARDIAN_UNAVAILABLE', 'rollback guardian did not prove readiness before target promotion')
    }
    const ready = readChecksummedJson(guardian.readyPath, { fsImpl: this.fs })
    if (!ready || ready.token !== token || ready.ownerPid !== process.pid || ready.ipcBound !== true) {
      fail('WORKER_GUARDIAN_UNAVAILABLE', 'rollback guardian readiness receipt is foreign')
    }
    return record
  }

  _disarmRollbackGuardian(record) {
    const guardian = record && record.transaction && record.transaction.guardian
    if (!guardian) return
    if (!this.fs.existsSync(guardian.disarmPath)) {
      atomicWriteJson(guardian.disarmPath, { schemaVersion: 1, token: guardian.token }, { fsImpl: this.fs })
    }
    if (!waitForFile(guardian.resultPath, 5_000, this.fs)) {
      fail('WORKER_GUARDIAN_UNAVAILABLE', 'rollback guardian did not acknowledge disarm within the bounded window')
    }
    const result = readChecksummedJson(guardian.resultPath, { fsImpl: this.fs })
    if (!result || result.token !== guardian.token || !['DISARMED', 'ROLLED_BACK', 'COMMITTED'].includes(result.status)) {
      fail('WORKER_GUARDIAN_UNAVAILABLE', 'rollback guardian returned a foreign or invalid result')
    }
  }

  recover(recordOrSession) {
    const record = recordOrSession && recordOrSession.recordPath
      ? readChecksummedJson(recordOrSession.recordPath, { fsImpl: this.fs })
      : recordOrSession
    if (!record || typeof record.status !== 'string') fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'workspace recovery record is invalid')
    if (['PREPARED_PROMOTION', 'PROMOTING'].includes(record.status)) return this._rollback(record)
    if (record.status === 'COMMITTED') {
      this._committedPostimages(record)
      return record
    }
    return record
  }

  finalize(session) {
    let record = this._readSession(session)
    if (record.status !== 'COMMITTED') fail('WORKER_PROMOTION_INVALID', 'only a committed workspace can be finalized')
    this._disarmRollbackGuardian(record)
    this._cleanupTransaction(record)
    if (this.fs.existsSync(record.workspacePath)) this.fs.rmSync(record.workspacePath, { recursive: true, force: false })
    record = { ...record, status: 'FINALIZED', transaction: null }
    atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
    return record
  }

  abort(session) {
    let record = this._readSession(session)
    if (['PREPARED_PROMOTION', 'PROMOTING'].includes(record.status)) record = this._rollback(record)
    if (record.status === 'COMMITTED') record = this._rollbackCommitted(record)
    this._disarmRollbackGuardian(record)
    if (this.fs.existsSync(record.workspacePath)) this.fs.rmSync(record.workspacePath, { recursive: true, force: false })
    this._cleanupTransaction(record)
    record = { ...record, status: 'ABORTED', transaction: null }
    atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
    return record
  }

  _rollbackCommitted(record) {
    return this._rollback(record)
  }

  _rollback(record) {
    const transaction = record.transaction
    if (!transaction || !Array.isArray(transaction.entries)) {
      if (record.status === 'PREPARED') return record
      fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'incomplete promotion lacks its rollback manifest')
    }
    for (let index = transaction.entries.length - 1; index >= 0; index -= 1) {
      const entry = transaction.entries[index]
      const current = fileState(entry.target, this.fs)
      const currentHash = current && current.hash || null
      const displacedExists = this.fs.existsSync(entry.displaced)
      if (![entry.beforeHash, entry.afterHash, null].includes(currentHash)) {
        fail('WORKER_ROLLBACK_CONFLICT', `target changed independently during rollback: ${entry.path}`)
      }
      if (currentHash === entry.afterHash && entry.afterHash !== entry.beforeHash) removeFileIfPresent(entry.target, this.fs)
      if (entry.beforeHash !== null) {
        if (displacedExists) {
          removeFileIfPresent(entry.target, this.fs)
          this.fs.renameSync(entry.displaced, entry.target)
        } else {
          const backupState = entry.backup && fileState(entry.backup, this.fs)
          if (!backupState || backupState.hash !== entry.beforeHash) {
            fail('WORKER_ROLLBACK_FAILED', `rollback backup is absent or corrupt: ${entry.path}`)
          }
          removeFileIfPresent(entry.target, this.fs)
          const restore = `${entry.target}.autoprompt-restore-${transaction.id}`
          removeFileIfPresent(restore, this.fs)
          this.fs.copyFileSync(entry.backup, restore, this.fs.constants.COPYFILE_EXCL)
          this.fs.chmodSync(restore, entry.beforeMode)
          fsyncFile(restore, this.fs)
          this.fs.renameSync(restore, entry.target)
        }
      } else {
        removeFileIfPresent(entry.target, this.fs)
        removeEmptyParents(path.dirname(entry.target), this.targetRoot, this.fs)
      }
      removeFileIfPresent(entry.staged, this.fs)
      removeFileIfPresent(entry.displaced, this.fs)
      fsyncDirectory(path.dirname(entry.target), this.fs)
      const restored = fileState(entry.target, this.fs)
      if ((restored && restored.hash || null) !== entry.beforeHash) {
        fail('WORKER_ROLLBACK_FAILED', `rollback did not restore the admitted preimage: ${entry.path}`)
      }
    }
    const rolledBack = { ...record, status: 'ROLLED_BACK' }
    atomicWriteJson(record.recordPath, rolledBack, { fsImpl: this.fs })
    return rolledBack
  }

  _cleanupTransaction(record) {
    if (!record.transaction) return
    for (const entry of record.transaction.entries || []) {
      removeFileIfPresent(entry.staged, this.fs)
      removeFileIfPresent(entry.displaced, this.fs)
    }
    if (record.transaction.root && this.fs.existsSync(record.transaction.root)) {
      this.fs.rmSync(record.transaction.root, { recursive: true, force: false })
    }
    const guardian = record.transaction.guardian
    if (guardian) {
      for (const filename of [guardian.requestPath, guardian.readyPath, guardian.disarmPath, guardian.resultPath]) {
        removeFileIfPresent(filename, this.fs)
      }
    }
  }

  _committedPostimages(record) {
    if (!record.transaction || !Array.isArray(record.transaction.entries)) {
      fail('WORKER_PROMOTION_INVALID', 'committed workspace lacks a promotion transaction')
    }
    return Object.freeze(record.transaction.entries.map(entry => {
      const current = fileState(entry.target, this.fs)
      if ((current && current.hash || null) !== entry.afterHash) {
        fail('MUTATION_RESULT_MISMATCH', `committed target postimage changed: ${entry.path}`)
      }
      return Object.freeze({
        type: entry.afterHash === null ? 'missing' : 'file',
        path: entry.target,
        hash: entry.afterHash,
      })
    }))
  }

  _session(record, assignment) {
    return Object.freeze({
      workspaceId: record.workspaceId,
      workspacePath: record.workspacePath,
      recordPath: record.recordPath,
      binding: Object.freeze({ ...record.binding }),
      assignment,
      manager: this,
    })
  }

  _readSession(session) {
    if (!session || session.manager !== this || typeof session.recordPath !== 'string') {
      fail('WORKER_WORKSPACE_INVALID', 'workspace session was not issued by this manager')
    }
    const record = readChecksummedJson(session.recordPath, { fsImpl: this.fs })
    this._validateRecord(record, {
      workspaceId: session.workspaceId,
      boundAssignmentHash: assignmentHash(session.assignment),
      workspacePath: session.workspacePath,
    })
    return record
  }

  _validateRecord(record, expected) {
    if (!record || record.schemaVersion !== 1 || record.workspaceId !== expected.workspaceId ||
        record.runId !== this.runId || record.activationId !== this.activationId ||
        record.assignmentHash !== expected.boundAssignmentHash ||
        record.targetRootHash !== sha256(this.targetRoot) ||
        path.resolve(record.workspacePath) !== path.resolve(expected.workspacePath) ||
        !record.binding || !HASH_PATTERN.test(record.binding.bindingHash || '') ||
        record.binding.bindingHash !== sha256(stableStringify({
          schemaVersion: record.binding.schemaVersion,
          workspaceId: record.binding.workspaceId,
          assignmentHash: record.binding.assignmentHash,
          targetSnapshotHash: record.binding.targetSnapshotHash,
        }))) {
      fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'private worker workspace record is foreign or corrupt')
    }
  }
}

function runRollbackGuardian(requestPath) {
  const request = readChecksummedJson(path.resolve(requestPath))
  if (!request || request.schemaVersion !== 1 || !/^[a-f0-9]{48}$/.test(request.token || '') ||
      ![request.recordPath, request.targetRoot, request.privateRoot, request.readyPath,
        request.disarmPath, request.resultPath].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      !Number.isSafeInteger(request.ownerPid) || request.ownerPid < 1) {
    fail('WORKER_GUARDIAN_INVALID', 'rollback guardian request is invalid')
  }
  if (typeof process.connected !== 'boolean' || process.connected !== true) {
    fail('WORKER_GUARDIAN_INVALID', 'rollback guardian lacks an exact owner-process IPC binding')
  }
  for (const filename of [request.readyPath, request.disarmPath, request.resultPath]) {
    if (path.dirname(filename) !== path.dirname(request.recordPath)) {
      fail('WORKER_GUARDIAN_INVALID', 'rollback guardian control path escaped the private record directory')
    }
  }
  atomicWriteJson(request.readyPath, {
    schemaVersion: 1, token: request.token, ownerPid: request.ownerPid, ipcBound: true,
  })
  while (true) {
    if (fs.existsSync(request.disarmPath)) {
      const disarm = readChecksummedJson(request.disarmPath)
      if (!disarm || disarm.token !== request.token) fail('WORKER_GUARDIAN_INVALID', 'guardian disarm token changed')
      const record = readChecksummedJson(request.recordPath)
      const status = record.status === 'COMMITTED' ? 'COMMITTED' : 'DISARMED'
      atomicWriteJson(request.resultPath, { schemaVersion: 1, token: request.token, status })
      return status
    }
    // IPC loss is the authoritative signal and remains exact even if the OS
    // immediately reuses ownerPid. PID polling is only an earlier conservative
    // signal; a time limit never rolls back a transaction owned by a live process.
    if (!process.connected || !processIsAlive(request.ownerPid)) {
      const manager = new WorkerWorkspaceManager({
        targetRoot: request.targetRoot,
        privateRoot: request.privateRoot,
        runId: request.runId,
        activationId: request.activationId,
      })
      let record = readChecksummedJson(request.recordPath)
      record = manager.recover(record)
      const status = record.status === 'COMMITTED' ? 'COMMITTED' : 'ROLLED_BACK'
      atomicWriteJson(request.resultPath, { schemaVersion: 1, token: request.token, status })
      manager._cleanupTransaction(record)
      atomicWriteJson(request.recordPath, {
        ...record,
        status: status === 'COMMITTED' ? 'COMMITTED' : 'ROLLED_BACK',
        transaction: null,
        guardianOutcome: status,
      })
      return status
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
}

if (require.main === module && process.argv[2] === '--rollback-guardian') {
  try { runRollbackGuardian(process.argv[3]) } catch { process.exitCode = 2 }
}

module.exports = {
  WorkerWorkspaceError,
  WorkerWorkspaceManager,
  repositorySnapshot,
  runRollbackGuardian,
}
