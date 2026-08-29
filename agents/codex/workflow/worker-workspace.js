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
const TRANSPORT_RETRY_PATTERN = /^(.+)-transport-retry-1$/u

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

function normalizeReportedPath(value, targetRoot) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail('WORKER_WORKSPACE_INVALID', 'workspace paths must be non-empty strings without NUL bytes')
  }
  if (!path.isAbsolute(value)) return normalizeRelative(value)
  if (value.split(/[\\/]/).some(part => part === '.' || part === '..')) {
    fail('WORKER_WORKSPACE_INVALID', `workspace absolute path is not canonical text: ${value}`)
  }
  const root = path.resolve(targetRoot)
  const absolute = path.resolve(value)
  const relative = path.relative(root, absolute)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail('WORKER_WORKSPACE_INVALID', `workspace absolute path is outside its canonical target root: ${value}`)
  }
  return normalizeRelative(relative)
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
  try { inspected = inspectPathNoFollow(absolute, { mustBeDirectory: false, fsImpl }) } catch (error) {
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

function ignoredPythonTransientSnapshot(repository, environment, fsImpl = fs) {
  const root = path.resolve(repository)
  const raw = Buffer.from(runGit(root, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
  ], {
    encoding: null,
    environment,
  }))
  const names = raw.toString('utf8').split('\0').filter(Boolean)
    .map(normalizeRelative).filter(isPythonTransient).sort()
  return Object.freeze(names.map(relative => {
    const state = fileState(resolveInside(root, relative), fsImpl)
    if (!state) {
      fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `ignored interpreter cache changed during admission: ${relative}`)
    }
    return Object.freeze({ path: relative, hash: state.hash, mode: state.mode })
  }))
}

function configuredCacheSnapshot(cacheRoot, privateRoot, fsImpl = fs) {
  const root = path.resolve(cacheRoot)
  if (!pathIsInside(privateRoot, root)) {
    fail('WORKER_WORKSPACE_INVALID', 'configured worker cache escaped its private boundary')
  }
  let rootInspection
  try { rootInspection = inspectPathNoFollow(root, { fsImpl }) } catch (error) {
    fail('WORKER_WORKSPACE_UNSAFE_ENTRY', 'configured worker cache crosses a link, junction, or reparse point', {
      cause: error.code || error.message,
    })
  }
  if (!rootInspection.exists) return Object.freeze([])
  const rows = []
  const visit = directory => {
    let names
    try { names = fsImpl.readdirSync(directory).sort() } catch (error) {
      fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `configured worker cache is not readable: ${directory}`, {
        cause: error.code || error.message,
      })
    }
    for (const name of names) {
      const absolute = path.join(directory, name)
      let inspection
      try { inspection = inspectPathNoFollow(absolute, { mustBeDirectory: false, fsImpl }) } catch (error) {
        fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `configured worker cache crosses a link, junction, or reparse point: ${absolute}`, {
          cause: error.code || error.message,
        })
      }
      if (!inspection.exists) {
        fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `configured worker cache changed during admission: ${absolute}`)
      }
      const stat = fsImpl.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `configured worker cache contains a symbolic link: ${absolute}`)
      }
      if (stat.isDirectory()) {
        visit(absolute)
        continue
      }
      const state = fileState(absolute, fsImpl)
      if (!state) {
        fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `configured worker cache changed during admission: ${absolute}`)
      }
      const relative = normalizeRelative(path.relative(root, absolute).replace(/\\/g, '/'))
      rows.push(Object.freeze({ path: relative, hash: state.hash, mode: state.mode }))
    }
  }
  visit(root)
  return Object.freeze(rows.sort((left, right) => left.path.localeCompare(right.path)))
}

function snapshotMap(snapshot) {
  return new Map(snapshot.map(entry => [entry.path, entry]))
}

function snapshotsEqual(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function isPythonTransient(relative) {
  const normalized = normalizeRelative(relative)
  const parts = normalized.split('/')
  const filename = parts.at(-1)
  return (parts.includes('__pycache__') && /\.py[cod]$/u.test(filename)) || /\.py[co]$/u.test(filename)
}

function transientEvidenceEntry(entry) {
  return Object.freeze({
    scope: entry.scope,
    path: entry.path,
    hash: entry.hash,
    kind: entry.kind,
  })
}

function validTransientEntry(entry) {
  if (!entry || !['workspace', 'configured-cache-root'].includes(entry.scope) ||
      typeof entry.path !== 'string' || !HASH_PATTERN.test(entry.hash || '') ||
      !['python-bytecode-cache', 'private-worker-cache'].includes(entry.kind)) return false
  try { return normalizeRelative(entry.path) === entry.path } catch { return false }
}

function validTransientCleanup(cleanup) {
  if (!cleanup || cleanup.schemaVersion !== 1 || cleanup.status !== 'PREPARED' ||
      !Array.isArray(cleanup.entries) || cleanup.entries.length === 0 ||
      cleanup.entries.some(entry => !validTransientEntry(entry))) return false
  const identities = cleanup.entries.map(entry => `${entry.scope}:${entry.path}`)
  return new Set(identities).size === identities.length &&
    cleanup.cleanupHash === sha256(stableStringify(cleanup.entries))
}

function assignmentHash(assignment) {
  return sha256(stableStringify(assignment))
}

function changedSnapshotPaths(before, after) {
  const beforeMap = snapshotMap(before)
  const afterMap = snapshotMap(after)
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort().filter(relative =>
    (beforeMap.get(relative) && beforeMap.get(relative).hash || null) !==
    (afterMap.get(relative) && afterMap.get(relative).hash || null))
}

function quarantineBody(record, input) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'provider-transport-partial-candidate',
    sourceWorkspaceId: record.workspaceId,
    sourceWorkItemId: record.workItemId,
    retryWorkItemId: input.retryWorkItemId,
    sourceAssignmentHash: record.assignmentHash,
    sourceBindingHash: record.binding.bindingHash,
    transportReceiptHash: input.transportReceiptHash,
    candidateHash: input.candidateHash,
    changedPathCount: input.actualFilesChanged.length,
    changedPathsHash: sha256(stableStringify(input.actualFilesChanged)),
  })
}

function validQuarantine(record) {
  const quarantine = record && record.transportQuarantine
  if (quarantine === undefined || quarantine === null) {
    return !record || !['QUARANTINED', 'QUARANTINE_CONSUMED'].includes(record.status)
  }
  const match = TRANSPORT_RETRY_PATTERN.exec(quarantine.retryWorkItemId || '')
  const { bindingHash, consumedBy, ...body } = quarantine
  return Boolean(
    quarantine.schemaVersion === 1 && quarantine.kind === 'provider-transport-partial-candidate' &&
    match && match[1] === quarantine.sourceWorkItemId &&
    quarantine.sourceWorkspaceId === record.workspaceId &&
    quarantine.sourceWorkItemId === record.workItemId &&
    quarantine.sourceAssignmentHash === record.assignmentHash &&
    quarantine.sourceBindingHash === record.binding.bindingHash &&
    [quarantine.transportReceiptHash, quarantine.candidateHash,
      quarantine.changedPathsHash, bindingHash].every(value => HASH_PATTERN.test(value || '')) &&
    Number.isSafeInteger(quarantine.changedPathCount) && quarantine.changedPathCount > 0 &&
    bindingHash === sha256(stableStringify(body)) &&
    (record.status === 'QUARANTINED'
      ? consumedBy === undefined || consumedBy === null
      : record.status === 'QUARANTINE_CONSUMED' && consumedBy &&
        typeof consumedBy === 'object' && HASH_PATTERN.test(consumedBy.retryBindingHash || '') &&
        typeof consumedBy.retryWorkspaceId === 'string' && consumedBy.retryWorkspaceId.length > 0)
  )
}

function validTransportSeed(record) {
  const seed = record && record.transportSeed
  if (seed === undefined || seed === null) return true
  const { bindingHash, ...body } = seed
  return Boolean(
    seed.schemaVersion === 1 && seed.kind === 'provider-transport-quarantine-seed' &&
    seed.retryWorkspaceId === record.workspaceId && seed.retryAssignmentHash === record.assignmentHash &&
    [seed.sourceQuarantineBindingHash, seed.transportReceiptHash, seed.sourceCandidateHash,
      seed.changedPathsHash, seed.seededSnapshotHash, bindingHash]
      .every(value => HASH_PATTERN.test(value || '')) &&
    Number.isSafeInteger(seed.changedPathCount) && seed.changedPathCount > 0 &&
    bindingHash === sha256(stableStringify(body))
  )
}

function survivalBody(record, input) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'controller-owned-candidate-survival',
    runId: record.runId,
    activationId: record.activationId,
    sourceWorkspaceId: record.workspaceId,
    sourceWorkItemId: record.workItemId,
    sourceAssignmentHash: record.assignmentHash,
    sourceBindingHash: record.binding.bindingHash,
    sourceStatus: record.status,
    reasonCode: input.reasonCode,
    candidateHash: input.candidateHash,
    snapshotHash: input.snapshotHash,
    changedPathCount: input.files.length,
    changedPathsHash: sha256(stableStringify(input.files.map(item => item.relative))),
    files: input.files,
  })
}

function validSurvivalManifest(manifest, record) {
  if (!manifest || manifest.schemaVersion !== 1 ||
      manifest.kind !== 'controller-owned-candidate-survival' ||
      manifest.runId !== record.runId || manifest.activationId !== record.activationId ||
      manifest.sourceWorkspaceId !== record.workspaceId ||
      manifest.sourceWorkItemId !== record.workItemId ||
      manifest.sourceAssignmentHash !== record.assignmentHash ||
      manifest.sourceBindingHash !== record.binding.bindingHash ||
      !['PREPARED', 'ROLLED_BACK', 'COMMITTED'].includes(manifest.sourceStatus) ||
      typeof manifest.reasonCode !== 'string' || !manifest.reasonCode ||
      !HASH_PATTERN.test(manifest.candidateHash || '') ||
      !HASH_PATTERN.test(manifest.snapshotHash || '') ||
      !HASH_PATTERN.test(manifest.changedPathsHash || '') ||
      !HASH_PATTERN.test(manifest.survivalHash || '') ||
      !Number.isSafeInteger(manifest.changedPathCount) || manifest.changedPathCount < 1 ||
      !Array.isArray(manifest.files) || manifest.files.length !== manifest.changedPathCount) return false
  const paths = []
  for (const entry of manifest.files) {
    if (!entry || typeof entry.relative !== 'string' ||
        !['file', 'missing'].includes(entry.type) ||
        (entry.type === 'file' && (!HASH_PATTERN.test(entry.hash || '') ||
          !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) ||
        (entry.type === 'missing' && (entry.hash !== null || entry.mode !== null))) return false
    try {
      if (normalizeRelative(entry.relative) !== entry.relative) return false
    } catch { return false }
    paths.push(entry.relative)
  }
  if (new Set(paths).size !== paths.length ||
      manifest.changedPathsHash !== sha256(stableStringify(paths))) return false
  const { checksum, survivalHash, ...body } = manifest
  return survivalHash === sha256(stableStringify(body))
}

function resourcePath(targetRoot, resource) {
  if (!resource || !['file', 'directory', 'output', 'cache', 'evidence-root'].includes(resource.kind)) return null
  const identity = String(resource.identity || '')
  if (identity === 'workspace' || identity === '.') return path.resolve(targetRoot)
  if (path.isAbsolute(identity)) {
    const root = path.resolve(targetRoot)
    const absolute = path.resolve(identity)
    const relative = path.relative(root, absolute)
    if (!relative) return root
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      // Exact external-local resources are audited by the supervisor and are
      // deliberately absent from this activation-target clone/CAS mechanism.
      if (HASH_PATTERN.test(resource.expectedPreimageHash || '') &&
          typeof resource.owner === 'string' && resource.owner &&
          typeof resource.ownershipMode === 'string' && resource.ownershipMode) return null
    }
  }
  return resolveInside(targetRoot, normalizeReportedPath(identity, targetRoot))
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
    const parent = path.dirname(cursor)
    fsImpl.rmdirSync(cursor)
    fsyncDirectory(parent, fsImpl)
    cursor = parent
  }
}

function removeEmptyTree(rootDirectory, boundary, fsImpl = fs) {
  const root = path.resolve(rootDirectory)
  if (!pathIsInside(boundary, root) || !fsImpl.existsSync(root)) return
  configuredCacheSnapshot(root, boundary, fsImpl)
  const remove = directory => {
    for (const name of fsImpl.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const stat = fsImpl.lstatSync(absolute)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `configured worker cache was not empty during cleanup: ${absolute}`)
      }
      remove(absolute)
    }
    fsImpl.rmdirSync(directory)
    fsyncDirectory(path.dirname(directory), fsImpl)
  }
  remove(root)
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
    ensurePhysicalDirectory(path.join(this.privateRoot, 'caches'), this.privateRoot, this.fs)
    ensurePhysicalDirectory(path.join(this.privateRoot, 'candidate-survivals'), this.privateRoot, this.fs)
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
    const cacheRoot = path.join(this.privateRoot, 'caches', workspaceId)
    const recordPath = path.join(this.privateRoot, 'records', `${workspaceId}.json`)
    if (this.fs.existsSync(recordPath)) {
      const existing = readChecksummedJson(recordPath, { fsImpl: this.fs })
      this._validateRecord(existing, { workspaceId, boundAssignmentHash, workspacePath })
      this.recover(existing)
      const recovered = readChecksummedJson(recordPath, { fsImpl: this.fs })
      if (['COMMITTED', 'FINALIZED', 'QUARANTINED', 'QUARANTINE_CONSUMED'].includes(recovered.status)) {
        fail('WORKER_WORKSPACE_ALREADY_PROMOTED', `worker workspace ${workspaceId} was already promoted`)
      }
      if (!this.fs.existsSync(workspacePath)) {
        fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'prepared worker workspace disappeared before reuse')
      }
      ensurePhysicalDirectory(cacheRoot, this.privateRoot, this.fs)
      return this._session(recovered, assignment)
    }

    const baseline = repositorySnapshot(this.targetRoot, this.environment, this.fs)
    const parent = path.dirname(workspacePath)
    ensurePhysicalDirectory(parent, this.privateRoot, this.fs)
    ensurePhysicalDirectory(cacheRoot, this.privateRoot, this.fs)
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
      transientArtifactsRemoved: [],
      transientCleanup: null,
      transaction: null,
      binding,
    }
    atomicWriteJson(recordPath, record, { fsImpl: this.fs })
    return this._session(record, assignment)
  }

  quarantine(session, options = {}) {
    let record = this._readSession(session)
    const retryMatch = TRANSPORT_RETRY_PATTERN.exec(options.retryWorkItemId || '')
    if (!retryMatch || retryMatch[1] !== record.workItemId ||
        !HASH_PATTERN.test(options.transportReceiptHash || '')) {
      fail('WORKER_QUARANTINE_INVALID', 'transport quarantine requires the exact receipt and its single retry identity')
    }
    if (record.status === 'QUARANTINED' || record.status === 'QUARANTINE_CONSUMED') {
      const pointer = this._quarantinePointer(record)
      if (pointer.retryWorkItemId !== options.retryWorkItemId ||
          pointer.transportReceiptHash !== options.transportReceiptHash) {
        fail('WORKER_QUARANTINE_INVALID', 'transport quarantine binding changed after first persistence')
      }
      return pointer
    }
    if (record.status !== 'PREPARED' && record.status !== 'ROLLED_BACK') {
      fail('WORKER_QUARANTINE_INVALID', `worker workspace cannot be quarantined from ${record.status}`)
    }
    const rawAfter = repositorySnapshot(record.workspacePath, this.environment, this.fs)
    const observedPaths = changedSnapshotPaths(record.baseline, rawAfter)
    const admission = this.inspect(session, { filesChanged: observedPaths })
    if (admission.actualFilesChanged.length === 0) {
      this.abort(session)
      return null
    }
    record = this._readSession(session)
    const body = quarantineBody(record, {
      retryWorkItemId: options.retryWorkItemId,
      transportReceiptHash: options.transportReceiptHash,
      candidateHash: sha256(stableStringify(admission.after)),
      actualFilesChanged: admission.actualFilesChanged,
    })
    const transportQuarantine = Object.freeze({
      ...body,
      bindingHash: sha256(stableStringify(body)),
    })
    record = { ...record, status: 'QUARANTINED', transportQuarantine }
    atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
    return this._quarantinePointer(record)
  }

  preserveCandidate(session, options = {}) {
    const record = this._readSession(session)
    const admission = options.admission
    const reasonCode = typeof options.reasonCode === 'string' && options.reasonCode
      ? options.reasonCode : 'CONTROLLER_BOOKKEEPING_FAILURE'
    if (!['PREPARED', 'ROLLED_BACK', 'COMMITTED'].includes(record.status) ||
        !admission || !Array.isArray(admission.actualFilesChanged) ||
        !Array.isArray(admission.after) || admission.actualFilesChanged.length === 0) {
      fail('WORKER_SURVIVAL_INVALID', 'exact-version survival requires one admitted private or committed work product')
    }
    const actual = admission.actualFilesChanged.map(normalizeRelative)
    if (new Set(actual).size !== actual.length ||
        actual.some(relative => !ownsRelative(this.targetRoot, session.assignment.resources, relative))) {
      fail('WORKER_SURVIVAL_INVALID', 'exact-version survival paths exceed their admitted ownership')
    }
    const privateSnapshot = repositorySnapshot(record.workspacePath, this.environment, this.fs)
    if (!snapshotsEqual(privateSnapshot, admission.after) ||
        stableStringify(changedSnapshotPaths(record.baseline, privateSnapshot)) !== stableStringify(actual)) {
      fail('WORKER_SURVIVAL_TAMPERED', 'private exact-version bytes differ from the mutation admission')
    }
    const after = snapshotMap(privateSnapshot)
    const files = Object.freeze(actual.map(relative => {
      const state = after.get(relative) || null
      return Object.freeze({
        relative,
        type: state && state.hash !== null ? 'file' : 'missing',
        hash: state && state.hash || null,
        mode: state && state.mode || null,
      })
    }))
    const snapshotHash = sha256(stableStringify(privateSnapshot))
    const candidateHash = HASH_PATTERN.test(options.candidateHash || '')
      ? options.candidateHash : snapshotHash
    const body = survivalBody(record, { reasonCode, candidateHash, snapshotHash, files })
    const survivalHash = sha256(stableStringify(body))
    const survivalRoot = path.join(this.privateRoot, 'candidate-survivals', survivalHash)
    const filesRoot = path.join(survivalRoot, 'files')
    const manifestPath = path.join(survivalRoot, 'manifest.json')
    if (!this.fs.existsSync(survivalRoot)) {
      ensurePhysicalDirectory(survivalRoot, this.privateRoot, this.fs)
      ensurePhysicalDirectory(filesRoot, survivalRoot, this.fs)
      for (const entry of files) {
        if (entry.type === 'missing') continue
        const source = resolveInside(record.workspacePath, entry.relative)
        const destination = resolveInside(filesRoot, entry.relative)
        const sourceState = fileState(source, this.fs)
        if (!sourceState || sourceState.hash !== entry.hash || sourceState.mode !== entry.mode) {
          fail('WORKER_SURVIVAL_TAMPERED', `postimage changed before exact-version survival copy: ${entry.relative}`)
        }
        ensurePhysicalDirectory(path.dirname(destination), filesRoot, this.fs)
        this.fs.copyFileSync(source, destination, this.fs.constants.COPYFILE_EXCL)
        const copied = fileState(destination, this.fs)
        if (!copied || copied.hash !== entry.hash) {
          fail('WORKER_SURVIVAL_TAMPERED', `exact-version survival copy differs from its admitted postimage: ${entry.relative}`)
        }
        fsyncFile(destination, this.fs)
        this.fs.chmodSync(destination, entry.mode & 0o111 ? 0o500 : 0o400)
      }
      const signed = atomicWriteJson(manifestPath, { ...body, survivalHash }, { fsImpl: this.fs, mode: 0o400 })
      if (!validSurvivalManifest(signed, record)) {
        fail('WORKER_SURVIVAL_INVALID', 'exact-version survival manifest failed its own binding validation')
      }
      const directories = [filesRoot]
      const visit = directory => {
        for (const name of this.fs.readdirSync(directory)) {
          const absolute = path.join(directory, name)
          const stat = this.fs.lstatSync(absolute)
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            visit(absolute)
            directories.push(absolute)
          }
        }
      }
      visit(filesRoot)
      for (const directory of directories.sort((left, right) => right.length - left.length)) {
        this.fs.chmodSync(directory, 0o500)
      }
      this.fs.chmodSync(survivalRoot, 0o500)
      fsyncDirectory(path.dirname(survivalRoot), this.fs)
    }
    let rootInspection
    let manifestInspection
    try {
      rootInspection = inspectPathNoFollow(survivalRoot, { fsImpl: this.fs })
      manifestInspection = inspectPathNoFollow(manifestPath, { mustBeDirectory: false, fsImpl: this.fs })
    } catch (error) {
      fail('WORKER_SURVIVAL_INVALID', 'exact-version survival crosses a link, junction, or reparse point', {
        cause: error.code || error.message,
      })
    }
    if (!rootInspection.exists || !manifestInspection.exists) {
      fail('WORKER_SURVIVAL_INVALID', 'exact-version survival manifest is missing')
    }
    const manifest = readChecksummedJson(manifestPath, { fsImpl: this.fs })
    if (!validSurvivalManifest(manifest, record) || manifest.survivalHash !== survivalHash) {
      fail('WORKER_SURVIVAL_INVALID', 'exact-version survival manifest is foreign or corrupt')
    }
    for (const entry of manifest.files) {
      if (entry.type === 'missing') continue
      const preserved = fileState(resolveInside(filesRoot, entry.relative), this.fs)
      if (!preserved || preserved.hash !== entry.hash) {
        fail('WORKER_SURVIVAL_TAMPERED', `exact-version survival postimage changed: ${entry.relative}`)
      }
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: 'controller-owned-candidate-survival-pointer',
      disposition: 'PRESERVED_WITHOUT_DONE_AUTHORITY',
      candidateHash: manifest.candidateHash,
      candidateRoot: filesRoot,
      manifestPath,
      manifestHash: sha256(stableStringify(manifest)),
      survivalHash,
      changedPathCount: manifest.changedPathCount,
    })
  }

  quarantinePointer(options = {}) {
    const recordsRoot = path.join(this.privateRoot, 'records')
    const matches = []
    for (const name of this.fs.readdirSync(recordsRoot).sort()) {
      if (!/^[a-f0-9]{40}\.json$/u.test(name)) continue
      const recordPath = path.join(recordsRoot, name)
      let inspection
      try { inspection = inspectPathNoFollow(recordPath, { mustBeDirectory: false, fsImpl: this.fs }) } catch (error) {
        fail('WORKER_QUARANTINE_INVALID', 'transport quarantine record crosses a link, junction, or reparse point', {
          cause: error.code || error.message,
        })
      }
      if (!inspection.exists) continue
      const record = readChecksummedJson(recordPath, { fsImpl: this.fs })
      if (record && record.workItemId === options.sourceWorkItemId && record.transportQuarantine &&
          record.transportQuarantine.retryWorkItemId === options.retryWorkItemId &&
          record.transportQuarantine.transportReceiptHash === options.transportReceiptHash) {
        this._validateRecord(record, {
          workspaceId: record.workspaceId,
          boundAssignmentHash: record.assignmentHash,
          workspacePath: record.workspacePath,
        })
        matches.push(record)
      }
    }
    if (matches.length === 0) {
      fail('WORKER_QUARANTINE_NOT_FOUND', 'transport retry has no frozen partial work product and must use the canonical base')
    }
    if (matches.length !== 1) {
      fail('WORKER_QUARANTINE_INVALID', 'transport retry lacks one exact receipt-bound quarantine journal')
    }
    return this._quarantinePointer(matches[0])
  }

  prepareFromQuarantine(options = {}) {
    const assignment = options.assignment
    const pointer = options.quarantine
    if (!assignment || !Array.isArray(assignment.resources) || typeof options.workItemId !== 'string' ||
        !pointer || typeof pointer.recordPath !== 'string') {
      fail('WORKER_QUARANTINE_INVALID', 'transport retry requires a canonical assignment and quarantine pointer')
    }
    const retryMatch = TRANSPORT_RETRY_PATTERN.exec(options.workItemId)
    const recordPath = path.resolve(pointer.recordPath)
    const recordsRoot = path.join(this.privateRoot, 'records')
    if (!retryMatch || !pathIsInside(recordsRoot, recordPath)) {
      fail('WORKER_QUARANTINE_INVALID', 'transport retry quarantine pointer escaped its exact private record boundary')
    }
    try { inspectPathNoFollow(recordPath, { mustBeDirectory: false, fsImpl: this.fs }) } catch (error) {
      fail('WORKER_QUARANTINE_INVALID', 'transport retry quarantine record crosses a link, junction, or reparse point', {
        cause: error.code || error.message,
      })
    }
    const source = readChecksummedJson(recordPath, { fsImpl: this.fs })
    this._validateRecord(source, {
      workspaceId: source && source.workspaceId,
      boundAssignmentHash: source && source.assignmentHash,
      workspacePath: source && source.workspacePath,
    })
    const reopenedPointer = this._quarantinePointer(source)
    if (stableStringify(reopenedPointer) !== stableStringify(pointer) ||
        reopenedPointer.retryWorkItemId !== options.workItemId ||
        reopenedPointer.sourceWorkItemId !== retryMatch[1]) {
      fail('WORKER_QUARANTINE_INVALID', 'transport retry quarantine pointer changed before consumption')
    }
    const retryAssignmentHash = assignmentHash(assignment)
    const retryWorkspaceId = sha256(stableStringify({
      runId: this.runId,
      activationId: this.activationId,
      workItemId: options.workItemId,
      assignmentHash: retryAssignmentHash,
    })).slice(0, 40)
    if (source.status === 'QUARANTINE_CONSUMED') {
      if (source.transportQuarantine.consumedBy.retryWorkspaceId !== retryWorkspaceId) {
        fail('WORKER_QUARANTINE_INVALID', 'consumed transport quarantine points to a foreign retry workspace')
      }
      const retryRecordPath = path.join(this.privateRoot, 'records', `${retryWorkspaceId}.json`)
      if (!this.fs.existsSync(retryRecordPath)) {
        fail('WORKER_QUARANTINE_TAMPERED', 'consumed transport quarantine retry journal is missing')
      }
      const retryRecord = readChecksummedJson(retryRecordPath, { fsImpl: this.fs })
      this._validateRecord(retryRecord, {
        workspaceId: retryWorkspaceId,
        boundAssignmentHash: retryAssignmentHash,
        workspacePath: path.join(this.privateRoot, 'workspaces', retryWorkspaceId),
      })
      const seed = retryRecord.transportSeed
      if (!seed || seed.sourceQuarantineBindingHash !== source.transportQuarantine.bindingHash ||
          seed.transportReceiptHash !== source.transportQuarantine.transportReceiptHash ||
          seed.sourceCandidateHash !== source.transportQuarantine.candidateHash ||
          source.transportQuarantine.consumedBy.retryBindingHash !== retryRecord.binding.bindingHash ||
          !this.fs.existsSync(retryRecord.workspacePath) ||
          sha256(stableStringify(repositorySnapshot(
            retryRecord.workspacePath,
            this.environment,
            this.fs,
          ))) !== seed.seededSnapshotHash) {
        fail('WORKER_QUARANTINE_TAMPERED', 'consumed transport quarantine retry bytes changed before launch')
      }
      return this._session(retryRecord, assignment)
    }
    let sourceInspection
    try { sourceInspection = inspectPathNoFollow(source.workspacePath, { fsImpl: this.fs }) } catch (error) {
      fail('WORKER_QUARANTINE_TAMPERED', 'transport quarantine workspace crosses a link, junction, or reparse point', {
        cause: error.code || error.message,
      })
    }
    if (!sourceInspection.exists || sourceInspection.realpath !== path.resolve(source.workspacePath)) {
      fail('WORKER_QUARANTINE_TAMPERED', 'transport quarantine workspace is missing or was redirected')
    }
    const sourceAfter = repositorySnapshot(source.workspacePath, this.environment, this.fs)
    const actual = changedSnapshotPaths(source.baseline, sourceAfter)
    if (actual.length !== source.transportQuarantine.changedPathCount ||
        sha256(stableStringify(actual)) !== source.transportQuarantine.changedPathsHash ||
        sha256(stableStringify(sourceAfter)) !== source.transportQuarantine.candidateHash) {
      fail('WORKER_QUARANTINE_TAMPERED', 'transport quarantine bytes differ from the frozen work-product journal')
    }
    const outside = actual.filter(relative => !ownsRelative(this.targetRoot, assignment.resources, relative))
    if (outside.length) {
      fail('OWNERSHIP_SCOPE_VIOLATION', 'transport quarantine no longer fits the retry assignment ownership', { outside })
    }

    const retry = this.prepare({ assignment, workItemId: options.workItemId })
    let retryRecord = this._readSession(retry)
    const sourceAfterMap = snapshotMap(sourceAfter)
    if (retryRecord.transportSeed) {
      const seed = retryRecord.transportSeed
      if (seed.sourceQuarantineBindingHash !== source.transportQuarantine.bindingHash ||
          seed.transportReceiptHash !== source.transportQuarantine.transportReceiptHash ||
          seed.sourceCandidateHash !== source.transportQuarantine.candidateHash ||
          sha256(stableStringify(repositorySnapshot(
            retryRecord.workspacePath,
            this.environment,
            this.fs,
          ))) !== seed.seededSnapshotHash) {
        fail('WORKER_QUARANTINE_TAMPERED', 'existing transport retry workspace differs from its seed journal')
      }
    } else {
      const retryBeforeSeed = repositorySnapshot(retry.workspacePath, this.environment, this.fs)
      const unexpected = changedSnapshotPaths(retryRecord.baseline, retryBeforeSeed)
        .filter(relative => !actual.includes(relative))
      if (unexpected.length) {
        fail('WORKER_QUARANTINE_TAMPERED', 'unseeded transport retry workspace contains foreign changes', { unexpected })
      }
    }
    for (const relative of actual) {
      const destination = resolveInside(retry.workspacePath, relative)
      const sourceState = sourceAfterMap.get(relative) || null
      removeFileIfPresent(destination, this.fs)
      if (!sourceState || sourceState.hash === null) {
        removeEmptyParents(path.dirname(destination), retry.workspacePath, this.fs)
        continue
      }
      const sourceFile = resolveInside(source.workspacePath, relative)
      const verified = fileState(sourceFile, this.fs)
      if (!verified || verified.hash !== sourceState.hash || verified.mode !== sourceState.mode) {
        fail('WORKER_QUARANTINE_TAMPERED', `transport quarantine postimage changed: ${relative}`)
      }
      ensurePhysicalDirectory(path.dirname(destination), retry.workspacePath, this.fs)
      this.fs.copyFileSync(sourceFile, destination, this.fs.constants.COPYFILE_EXCL)
      this.fs.chmodSync(destination, sourceState.mode)
      fsyncFile(destination, this.fs)
    }
    const retryAfter = repositorySnapshot(retry.workspacePath, this.environment, this.fs)
    const retryAfterMap = snapshotMap(retryAfter)
    for (const relative of actual) {
      const expected = sourceAfterMap.get(relative) || null
      const observed = retryAfterMap.get(relative) || null
      if ((expected && expected.hash || null) !== (observed && observed.hash || null) ||
          (expected && expected.mode || null) !== (observed && observed.mode || null)) {
        fail('WORKER_QUARANTINE_TAMPERED', `transport retry did not receive the exact frozen postimage: ${relative}`)
      }
    }
    const seedBody = Object.freeze({
      schemaVersion: 1,
      kind: 'provider-transport-quarantine-seed',
      retryWorkspaceId: retryRecord.workspaceId,
      retryAssignmentHash: retryRecord.assignmentHash,
      sourceWorkspaceId: source.workspaceId,
      sourceQuarantineBindingHash: source.transportQuarantine.bindingHash,
      transportReceiptHash: source.transportQuarantine.transportReceiptHash,
      sourceCandidateHash: source.transportQuarantine.candidateHash,
      changedPathCount: source.transportQuarantine.changedPathCount,
      changedPathsHash: source.transportQuarantine.changedPathsHash,
      seededSnapshotHash: sha256(stableStringify(retryAfter)),
    })
    const transportSeed = Object.freeze({
      ...seedBody,
      bindingHash: sha256(stableStringify(seedBody)),
    })
    if (retryRecord.transportSeed && stableStringify(retryRecord.transportSeed) !== stableStringify(transportSeed)) {
      fail('WORKER_QUARANTINE_TAMPERED', 'transport retry workspace was previously seeded from different bytes')
    }
    retryRecord = { ...retryRecord, transportSeed }
    atomicWriteJson(retryRecord.recordPath, retryRecord, { fsImpl: this.fs })

    const consumedBy = Object.freeze({
      retryWorkspaceId: retryRecord.workspaceId,
      retryBindingHash: retryRecord.binding.bindingHash,
    })
    const consumed = { ...source, status: 'QUARANTINE_CONSUMED', transportQuarantine: {
      ...source.transportQuarantine,
      consumedBy,
    } }
    atomicWriteJson(source.recordPath, consumed, { fsImpl: this.fs })
    if (this.fs.existsSync(source.workspacePath)) {
      this.fs.rmSync(source.workspacePath, { recursive: true, force: false })
    }
    removeEmptyTree(path.join(this.privateRoot, 'caches', source.workspaceId), this.privateRoot, this.fs)
    return this._session(retryRecord, assignment)
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
    const cacheRoot = path.join(this.privateRoot, 'caches', workspaceId)
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
    ensurePhysicalDirectory(cacheRoot, this.privateRoot, this.fs)
    return this._session(recovered, assignment)
  }

  inspect(session, result) {
    let record = this._readSession(session)
    if (record.transientCleanup) {
      this.recover(record)
      record = this._readSession(session)
    }
    let after = repositorySnapshot(record.workspacePath, this.environment, this.fs)
    const beforeMap = snapshotMap(record.baseline)
    let afterMap = snapshotMap(after)
    const workspaceTransientMap = new Map()
    for (const entry of [...after, ...ignoredPythonTransientSnapshot(
      record.workspacePath,
      this.environment,
      this.fs,
    )]) {
      if (beforeMap.has(entry.path) || !isPythonTransient(entry.path)) continue
      workspaceTransientMap.set(entry.path, entry)
    }
    const transientArtifacts = []
    for (const entry of [...workspaceTransientMap.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      if (ownsRelative(this.targetRoot, session.assignment.resources, entry.path)) {
        fail('OWNERSHIP_SCOPE_VIOLATION', 'an explicitly owned deliverable cannot be discarded as an interpreter cache', {
          transientCandidate: entry.path,
        })
      }
      transientArtifacts.push(transientEvidenceEntry({
        scope: 'workspace',
        path: entry.path,
        hash: entry.hash,
        kind: 'python-bytecode-cache',
      }))
    }
    const cacheRoot = path.join(this.privateRoot, 'caches', record.workspaceId)
    for (const entry of configuredCacheSnapshot(cacheRoot, this.privateRoot, this.fs)) {
      transientArtifacts.push(transientEvidenceEntry({
        scope: 'configured-cache-root',
        path: entry.path,
        hash: entry.hash,
        kind: 'private-worker-cache',
      }))
    }
    if (transientArtifacts.length > 0) {
      record = this._prepareTransientCleanup(record, transientArtifacts)
      record = this._reconcileTransientCleanup(record)
      after = repositorySnapshot(record.workspacePath, this.environment, this.fs)
      afterMap = snapshotMap(after)
    }
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
    const recordedTransientArtifacts = Array.isArray(record.transientArtifactsRemoved)
      ? record.transientArtifactsRemoved : []
    const transientPaths = new Set(recordedTransientArtifacts
      .filter(item => !item.scope || item.scope === 'workspace').map(item => item.path))
    const reported = Array.isArray(result && result.filesChanged)
      ? [...new Set(result.filesChanged.map(value => normalizeReportedPath(value, this.targetRoot)))]
          .filter(relative => !transientPaths.has(relative)).sort() : []
    const reportedOutside = reported.filter(relative =>
      !ownsRelative(this.targetRoot, session.assignment.resources, relative))
    if (reportedOutside.length) {
      fail('OWNERSHIP_SCOPE_VIOLATION', 'worker reported files outside its admitted ownership', {
        outside: reportedOutside,
        admitted: session.assignment.resources.filter(resource => resource.access !== 'read')
          .map(resource => `${resource.kind}:${resource.identity}`),
      })
    }
    const reportedSet = new Set(reported)
    const unreportedActual = actual.filter(relative => !reportedSet.has(relative))
    if (unreportedActual.length) {
      fail('MUTATION_REPORT_MISMATCH', 'worker omitted an observed isolated physical diff from its file report', {
        reported, actual, unreportedActual,
      })
    }
    // A worker may write a generated file whose bytes are already canonical.
    // That is an observed no-op, not an orchestration failure.  Preserve the
    // distinction for evidence while promoting only byte-different postimages.
    const actualSet = new Set(actual)
    const reportedNoopFiles = reported.filter(relative => !actualSet.has(relative))
    return Object.freeze({
      actualFilesChanged: Object.freeze(actual),
      reportedNoopFiles: Object.freeze(reportedNoopFiles),
      after: Object.freeze(after),
      transientArtifactsRemoved: Object.freeze(recordedTransientArtifacts.map(item => Object.freeze({ ...item }))),
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

  _prepareTransientCleanup(record, entries) {
    if (!Array.isArray(entries) || entries.length === 0 || entries.some(entry => !validTransientEntry(entry))) {
      fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'transient cleanup intent is invalid')
    }
    const sorted = entries.map(entry => transientEvidenceEntry(entry))
      .sort((left, right) => `${left.scope}:${left.path}`.localeCompare(`${right.scope}:${right.path}`))
    const identities = sorted.map(entry => `${entry.scope}:${entry.path}`)
    if (new Set(identities).size !== identities.length) {
      fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'transient cleanup intent contains duplicate paths')
    }
    const prepared = {
      ...record,
      transientCleanup: {
        schemaVersion: 1,
        status: 'PREPARED',
        entries: sorted,
        cleanupHash: sha256(stableStringify(sorted)),
      },
    }
    atomicWriteJson(record.recordPath, prepared, { fsImpl: this.fs })
    return prepared
  }

  _reconcileTransientCleanup(record) {
    const cleanup = record && record.transientCleanup
    if (!cleanup) return record
    if (!validTransientCleanup(cleanup)) {
      fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'transient cleanup journal is foreign or corrupt')
    }
    for (const entry of cleanup.entries) {
      const boundary = entry.scope === 'workspace'
        ? record.workspacePath
        : path.join(this.privateRoot, 'caches', record.workspaceId)
      const absolute = resolveInside(boundary, entry.path)
      const state = fileState(absolute, this.fs)
      if (state && state.hash !== entry.hash) {
        fail('WORKER_WORKSPACE_UNSAFE_ENTRY', `transient changed before cleanup reconciliation: ${entry.path}`)
      }
      if (state) {
        this.fs.unlinkSync(absolute)
        fsyncDirectory(path.dirname(absolute), this.fs)
        removeEmptyParents(path.dirname(absolute), boundary, this.fs)
      }
    }
    const existing = Array.isArray(record.transientArtifactsRemoved) ? record.transientArtifactsRemoved : []
    const combined = [...existing, ...cleanup.entries.map(entry => transientEvidenceEntry(entry))]
    const reconciled = {
      ...record,
      transientArtifactsRemoved: combined,
      transientCleanupHash: sha256(stableStringify(combined)),
      transientCleanup: null,
    }
    atomicWriteJson(record.recordPath, reconciled, { fsImpl: this.fs })
    return reconciled
  }

  _cleanupConfiguredCache(record) {
    const cacheRoot = path.join(this.privateRoot, 'caches', record.workspaceId)
    const entries = configuredCacheSnapshot(cacheRoot, this.privateRoot, this.fs).map(entry =>
      transientEvidenceEntry({
        scope: 'configured-cache-root',
        path: entry.path,
        hash: entry.hash,
        kind: 'private-worker-cache',
      }))
    if (entries.length === 0) return record
    return this._reconcileTransientCleanup(this._prepareTransientCleanup(record, entries))
  }

  recover(recordOrSession) {
    let record = recordOrSession && recordOrSession.recordPath
      ? readChecksummedJson(recordOrSession.recordPath, { fsImpl: this.fs })
      : recordOrSession
    if (!record || typeof record.status !== 'string') fail('WORKER_WORKSPACE_RECOVERY_FAILED', 'workspace recovery record is invalid')
    if (record.transientCleanup) record = this._reconcileTransientCleanup(record)
    if (['PREPARED_PROMOTION', 'PROMOTING'].includes(record.status)) return this._rollback(record)
    if (record.status === 'COMMITTED') {
      this._committedPostimages(record)
      return record
    }
    return record
  }

  finalize(session) {
    let record = this._readSession(session)
    if (record.transientCleanup) record = this.recover(record)
    if (record.status !== 'COMMITTED') fail('WORKER_PROMOTION_INVALID', 'only a committed workspace can be finalized')
    record = this._cleanupConfiguredCache(record)
    this._disarmRollbackGuardian(record)
    this._cleanupTransaction(record)
    if (this.fs.existsSync(record.workspacePath)) this.fs.rmSync(record.workspacePath, { recursive: true, force: false })
    const cacheRoot = path.join(this.privateRoot, 'caches', record.workspaceId)
    removeEmptyTree(cacheRoot, this.privateRoot, this.fs)
    record = { ...record, status: 'FINALIZED', transaction: null }
    atomicWriteJson(record.recordPath, record, { fsImpl: this.fs })
    return record
  }

  abort(session) {
    let record = this._readSession(session)
    if (record.transientCleanup) record = this.recover(record)
    if (['PREPARED_PROMOTION', 'PROMOTING'].includes(record.status)) record = this._rollback(record)
    if (record.status === 'COMMITTED') record = this._rollbackCommitted(record)
    record = this._cleanupConfiguredCache(record)
    this._disarmRollbackGuardian(record)
    if (this.fs.existsSync(record.workspacePath)) this.fs.rmSync(record.workspacePath, { recursive: true, force: false })
    const cacheRoot = path.join(this.privateRoot, 'caches', record.workspaceId)
    removeEmptyTree(cacheRoot, this.privateRoot, this.fs)
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
      cacheRoot: path.join(this.privateRoot, 'caches', record.workspaceId),
      binding: Object.freeze({ ...record.binding }),
      assignment,
      manager: this,
    })
  }

  _quarantinePointer(record) {
    if (!validQuarantine(record)) {
      fail('WORKER_QUARANTINE_INVALID', 'transport quarantine journal is foreign or corrupt')
    }
    const quarantine = record.transportQuarantine
    const body = Object.freeze({
      schemaVersion: 1,
      kind: 'provider-transport-quarantine-pointer',
      recordPath: record.recordPath,
      sourceWorkspaceId: quarantine.sourceWorkspaceId,
      sourceWorkItemId: quarantine.sourceWorkItemId,
      retryWorkItemId: quarantine.retryWorkItemId,
      transportReceiptHash: quarantine.transportReceiptHash,
      candidateHash: quarantine.candidateHash,
      quarantineBindingHash: quarantine.bindingHash,
    })
    return Object.freeze({ ...body, pointerHash: sha256(stableStringify(body)) })
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
    const transientArtifacts = record && Array.isArray(record.transientArtifactsRemoved)
      ? record.transientArtifactsRemoved
      : record && record.transientArtifactsRemoved === undefined ? [] : null
    const transientEvidenceValid = transientArtifacts &&
      transientArtifacts.every(entry => validTransientEntry({ ...entry, scope: entry.scope || 'workspace' })) &&
      (transientArtifacts.length === 0
        ? record.transientCleanupHash === undefined || record.transientCleanupHash === null
        : record.transientCleanupHash === sha256(stableStringify(transientArtifacts)))
    const transientCleanupValid = !record || record.transientCleanup === undefined ||
      record.transientCleanup === null || validTransientCleanup(record.transientCleanup)
    const canonicalRecordPath = record && typeof record.workspaceId === 'string'
      ? path.join(this.privateRoot, 'records', `${record.workspaceId}.json`) : null
    const canonicalWorkspacePath = record && typeof record.workspaceId === 'string'
      ? path.join(this.privateRoot, 'workspaces', record.workspaceId) : null
    if (!record || record.schemaVersion !== 1 || record.workspaceId !== expected.workspaceId ||
        record.runId !== this.runId || record.activationId !== this.activationId ||
        record.assignmentHash !== expected.boundAssignmentHash ||
        record.targetRootHash !== sha256(this.targetRoot) ||
        path.resolve(record.recordPath || '') !== path.resolve(canonicalRecordPath || '') ||
        path.resolve(record.workspacePath || '') !== path.resolve(canonicalWorkspacePath || '') ||
        path.resolve(record.workspacePath) !== path.resolve(expected.workspacePath) ||
        !transientEvidenceValid || !transientCleanupValid ||
        !validQuarantine(record) || !validTransportSeed(record) ||
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
