#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { atomicWriteFile, atomicWriteJson, canonicalize, readChecksummedJson, stableStringify } = require('./event-log.js')
const { auditPrivatePermissions, ensureWindowsPrivateAcl, inspectPathNoFollow, pathIsInside } = require('./safe-run-root.js')

const PROCESS_REGISTRY_SCHEMA_VERSION = 4
const REQUIRED_PROCESS_ADAPTER_METHODS = Object.freeze([
  'admit', 'spawnOwned', 'recoverReservation', 'listOwned', 'signalOwned',
  'verifyOwnership', 'listTargetOwned',
])
const REQUIRED_PROCESS_CAPABILITIES = Object.freeze([
  'groupAtCreation', 'descendantEnumeration', 'groupSignal', 'stableIdentity',
  'persistentIdentity', 'reservationRecovery',
])
const POSIX_RESERVATION_ENV = 'AUTOPROMPT_OWNERSHIP_RESERVATION'

function hasExactNulDelimitedEntry(environment, entry) {
  if (!Buffer.isBuffer(environment) || typeof entry !== 'string' || !entry || entry.includes('\0')) return false
  const needle = Buffer.from(`${entry}\0`, 'utf8')
  let offset = 0
  while (offset < environment.length) {
    const match = environment.indexOf(needle, offset)
    if (match < 0) return false
    if (match === 0 || environment[match - 1] === 0) return true
    offset = match + 1
  }
  return false
}

class ProcessOwnerError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ProcessOwnerError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new ProcessOwnerError(code, message, details)
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function normalizeControlBinding(value, registryPath) {
  const binding = value || {
    activationId: `standalone:${sha256(path.resolve(registryPath))}`,
    generationId: 1,
  }
  if (!binding || typeof binding.activationId !== 'string' || !binding.activationId ||
      !Number.isSafeInteger(binding.generationId) || binding.generationId < 1 ||
      (binding.predecessorGenerationId !== undefined &&
        (!Number.isSafeInteger(binding.predecessorGenerationId) || binding.predecessorGenerationId < 1 ||
          binding.predecessorGenerationId >= binding.generationId))) {
    fail('PROCESS_OWNER_CONFIG_INVALID', 'process registry control binding is invalid')
  }
  return Object.freeze({
    activationId: binding.activationId,
    generationId: binding.generationId,
    predecessorGenerationId: binding.predecessorGenerationId ?? null,
  })
}

function validateAdapter(adapter, options = {}) {
  for (const method of REQUIRED_PROCESS_ADAPTER_METHODS) {
    if (!adapter || typeof adapter[method] !== 'function') {
      fail('PROVIDER_UNSUPPORTED', `process adapter lacks ${method}`)
    }
  }
  const capabilities = adapter.capabilities || {}
  for (const field of REQUIRED_PROCESS_CAPABILITIES) {
    if (capabilities[field] !== true) fail('PROVIDER_UNSUPPORTED', `process adapter lacks ${field}`)
  }
  if (!['posix-process-group', 'windows-job-object', 'test'].includes(adapter.kind)) {
    fail('PROVIDER_UNSUPPORTED', 'process adapter kind is not a supported ownership primitive')
  }
  if (adapter.kind === 'test' && options.allowTestAdapter !== true) {
    fail('PROVIDER_UNSUPPORTED', 'test process adapters are forbidden outside explicit tests')
  }
}

function processLaunchControlEnvironment(adapter, reservationId) {
  if (!adapter || typeof reservationId !== 'string' || !reservationId || reservationId.includes('\0')) {
    fail('LAUNCH_SPEC_INVALID', 'process launch control environment requires an adapter and reservationId')
  }
  const fields = typeof adapter.childControlEnvironment === 'function'
    ? adapter.childControlEnvironment(reservationId)
    : {}
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
      Object.entries(fields).some(([name, value]) => !name || name.includes('\0') ||
        typeof value !== 'string' || value.includes('\0'))) {
    fail('PROVIDER_UNSUPPORTED', 'process adapter returned invalid child control environment fields')
  }
  return Object.freeze({ ...fields })
}

function prepareProcessLaunchEnvironment(adapter, reservationId, environment = {}) {
  const controls = processLaunchControlEnvironment(adapter, reservationId)
  return adapter?.kind === 'windows-job-object'
    ? normalizeWindowsChildEnvironment(environment, controls)
    : Object.freeze({ ...environment, ...controls })
}

const WINDOWS_CANONICAL_ENVIRONMENT_KEYS = Object.freeze(new Map([
  'appdata', 'codex_home', 'comspec', 'home', 'localappdata', 'os', 'path', 'pathext',
  'systemdrive', 'systemroot', 'temp', 'tmp', 'userprofile', 'windir', 'xdg_config_home',
].map(name => [name, name.toUpperCase()])))

function normalizeWindowsChildEnvironment(environment = {}, overrides = {}) {
  const groups = new Map()
  for (const [priority, fields] of [[0, environment], [1, overrides]]) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      fail('LAUNCH_SPEC_INVALID', 'Windows child environment must be an exact string map')
    }
    for (const [name, value] of Object.entries(fields)) {
      if (!name || name.includes('\0') || typeof value !== 'string' || value.includes('\0')) {
        fail('LAUNCH_SPEC_INVALID', 'Windows child environment must be an exact string map')
      }
      const folded = name.toLowerCase()
      const group = groups.get(folded) || []
      group.push({ name, priority, value })
      groups.set(folded, group)
    }
  }
  const normalized = {}
  for (const [folded, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    if (new Set(group.map(item => item.value)).size !== 1) {
      fail('PROCESS_ENVIRONMENT_CONFLICT',
        `conflicting Windows child environment aliases: ${group.map(item => item.name).sort().join(', ')}`)
    }
    const override = group.filter(item => item.priority === 1)
      .sort((left, right) => left.name.localeCompare(right.name))[0]
    const name = override?.name || WINDOWS_CANONICAL_ENVIRONMENT_KEYS.get(folded) ||
      group.map(item => item.name).sort()[0]
    normalized[name] = group[0].value
  }
  return Object.freeze(normalized)
}

function selectWindowsLiveStatusPids(status, isAlive) {
  const pidList = (field) => {
    const value = status && status[field]
    if (value === undefined && field === 'observedPids') return []
    if (!Array.isArray(value) || value.some(pid => !Number.isSafeInteger(pid) || pid < 1)) {
      fail('PROCESS_ASSIGNMENT_ESCAPED', `Windows Job status has invalid ${field}`)
    }
    return value
  }
  if (!status || typeof isAlive !== 'function') {
    fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job status liveness probe is invalid')
  }
  const currentPids = pidList('pids')
  const observedPids = pidList('observedPids')
  // EXITED is published only after QueryInformationJobObject proves that the
  // Job has zero members. The helper may still be finishing its final few
  // instructions, but its PID is not a durable identity and can be reused by
  // a later helper. Treat only this fully assigned zero-membership state as
  // authoritative; FAILED and nonterminal records remain conservative.
  if (status.status === 'EXITED') {
    if (status.ready !== true || status.assigned !== true || currentPids.length !== 0) {
      fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job EXITED status does not prove zero assigned membership')
    }
    return []
  }
  const helperAlive = Number.isSafeInteger(status.helperPid) && status.helperPid > 0 &&
    isAlive(status.helperPid)
  const terminal = ['EXITED', 'FAILED'].includes(status.status)
  // observedPids is historical evidence, not a durable process identity. Once
  // the Job helper has published a terminal state, KILL_ON_JOB_CLOSE owns the
  // descendant boundary and a later process may reuse one of those PIDs. Only
  // consult the historical set while recovering a nonterminal record whose
  // helper disappeared before it could publish the current Job membership.
  const recoveryFallback = !terminal && !helperAlive ? observedPids : []
  return [...new Set([
    ...currentPids,
    ...recoveryFallback,
    ...(helperAlive ? [status.helperPid] : []),
  ])].filter(isAlive)
}

class ProcessOwner {
  constructor(options) {
    if (!options) fail('PROCESS_OWNER_CONFIG_INVALID', 'process owner options are required')
    validateAdapter(options.adapter, { allowTestAdapter: options.allowTestAdapter })
    if (typeof options.registryPath !== 'string') fail('PROCESS_OWNER_CONFIG_INVALID', 'durable process registryPath is required')
    this.adapter = options.adapter
    this.registryPath = path.resolve(options.registryPath)
    this.controlBinding = normalizeControlBinding(options.controlBinding, this.registryPath)
    this.registrySequence = 0
    this.fs = options.fsImpl || fs
    this.monotonicMs = options.monotonicMs || (() => Number(process.hrtime.bigint() / 1000000n))
    this.wallClock = options.wallClock || (() => new Date().toISOString())
    this.wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.pollMs = options.pollMs === undefined ? 25 : options.pollMs
    this.zeroConfirmations = options.zeroConfirmations === undefined ? 2 : options.zeroConfirmations
    this.startupTimeoutMs = options.startupTimeoutMs === undefined
      ? (options.adapter.startupTimeoutMs === undefined ? 10000 : options.adapter.startupTimeoutMs)
      : options.startupTimeoutMs
    this.adapterCallTimeoutMs = options.adapterCallTimeoutMs === undefined
      ? Math.max(10000, this.startupTimeoutMs + 1000) : options.adapterCallTimeoutMs
    this.budget = options.budget || null
    this.onTerminal = options.onTerminal || (() => {})
    this.onOwnershipChange = options.onOwnershipChange || (() => {})
    this.beforeRegistryCommit = options.beforeRegistryCommit || (() => {})
    this.randomId = options.randomId || (() => crypto.randomUUID())
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 0 ||
        !Number.isSafeInteger(this.startupTimeoutMs) || this.startupTimeoutMs < 1 ||
        !Number.isSafeInteger(this.adapterCallTimeoutMs) || this.adapterCallTimeoutMs < 1 ||
        !Number.isSafeInteger(this.zeroConfirmations) || this.zeroConfirmations < 1) {
      fail('PROCESS_OWNER_CONFIG_INVALID', 'poll, startup, adapter-call, or confirmation bounds are invalid')
    }
    this.groups = new Map()
    this.terminalRecords = new Map()
    // A durable RESERVED record is the crash-safe half of this fence.  The
    // in-memory half keeps observing the actual adapter promise after the
    // caller-facing watchdog fires, so a late physical spawn can never become
    // detached from ownership merely because its JavaScript call timed out.
    this.spawnOperationFences = new Map()
    this._restoreRegistry()
    this.onOwnershipChange(this.ownershipIdentities())
  }

  async _adapterCall(method, ...args) {
    if (typeof this.adapter[method] !== 'function') {
      fail('PROVIDER_UNSUPPORTED', `process adapter lacks ${method}`)
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new ProcessOwnerError(
          'PROCESS_DRAIN_TIMEOUT',
          `process adapter ${method} did not settle within its physical-operation watchdog`,
          { method, timeoutMs: this.adapterCallTimeoutMs },
        ))
      }, this.adapterCallTimeoutMs)
      Promise.resolve().then(() => this.adapter[method](...args)).then(
        value => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  _spawnOwnedWithFence(record, input) {
    const fence = {
      ownershipId: record.ownershipId,
      reservationId: record.reservationId,
      state: 'PENDING',
      timedOut: false,
      ownership: null,
      error: null,
      reconciliation: null,
      reconciliationError: null,
    }
    this.spawnOperationFences.set(record.ownershipId, fence)
    const physicalOperation = Promise.resolve().then(() => this.adapter.spawnOwned(input))
    physicalOperation.then(
      ownership => {
        fence.state = 'SETTLED_OWNERSHIP'
        fence.ownership = ownership
        if (fence.timedOut) this._scheduleLateSpawnReconciliation(record, fence)
      },
      error => {
        fence.state = 'SETTLED_ERROR'
        fence.error = error
        if (fence.timedOut) this._scheduleLateSpawnReconciliation(record, fence)
      },
    )
    return new Promise((resolve, reject) => {
      let callerSettled = false
      const timer = setTimeout(() => {
        if (callerSettled) return
        callerSettled = true
        fence.timedOut = true
        reject(new ProcessOwnerError(
          'PROCESS_DRAIN_TIMEOUT',
          'process adapter spawnOwned did not settle within its physical-operation watchdog',
          { method: 'spawnOwned', timeoutMs: this.adapterCallTimeoutMs },
        ))
      }, this.adapterCallTimeoutMs)
      physicalOperation.then(
        ownership => {
          if (callerSettled) return
          callerSettled = true
          clearTimeout(timer)
          resolve(ownership)
        },
        error => {
          if (callerSettled) return
          callerSettled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  _scheduleLateSpawnReconciliation(record, fence) {
    if (fence.reconciliation) return fence.reconciliation
    fence.reconciliation = Promise.resolve().then(async () => {
      if (fence.state === 'SETTLED_OWNERSHIP') {
        const current = this.groups.get(record.ownershipId)
        if (!current) {
          fail('OWNERSHIP_RECOVERY_FATAL', `late spawn ${record.reservationId} lost its durable reservation`)
        }
        if (current.status === 'RESERVED') {
          this._attachRecovered(current, fence.ownership, 'late-spawn-attach')
        } else if (current.groupIdentity !== fence.ownership?.groupIdentity ||
            current.rootPid !== fence.ownership?.rootPid) {
          fail('PROCESS_IDENTITY_CHANGED',
            `late spawn ${record.reservationId} conflicts with its recovered ownership identity`)
        }
        if (current.status === 'RUNNING') {
          await this.cancelGroup(current.ownershipId, {
            reason: 'late physical spawn settled after its caller-facing watchdog',
            graceMs: 0,
            killMs: Math.max(1, this.startupTimeoutMs),
            terminalStatus: 'FAILED',
          })
        } else {
          // Recovery may have attached and drained the group before the adapter
          // promise itself settled.  Re-probe the exact identity so a second
          // late member cannot hide behind the already-terminal record.
          let remaining = await this._adapterCall('listOwned', fence.ownership.groupIdentity)
          if (remaining.length) {
            await this._verifyOwnership({ ...current, ...fence.ownership })
            await this._adapterCall('signalOwned', fence.ownership.groupIdentity, 'KILL')
            remaining = await this._waitForZero({ ...current, ...fence.ownership }, Math.max(1, this.startupTimeoutMs))
          }
          if (remaining.length) {
            fail('PROCESS_DRAIN_TIMEOUT', `late spawn ${record.reservationId} did not drain`, { remaining })
          }
        }
        this.spawnOperationFences.delete(record.ownershipId)
        return
      }
      // A rejected adapter promise is not proof that no physical side effect
      // occurred.  Keep the durable reservation and let the adapter's
      // tri-state recovery prove LIVE or DEAD within the persisted deadline.
      try {
        await this.recoverReservations()
        const current = this.groups.get(record.ownershipId)
        if (current && current.status === 'RUNNING') {
          await this.cancelGroup(current.ownershipId, {
            reason: 'spawn adapter rejected after operation admission',
            graceMs: 0,
            killMs: Math.max(1, this.startupTimeoutMs),
            terminalStatus: 'FAILED',
          })
        }
      } finally {
        const current = this.groups.get(record.ownershipId)
        if (current && current.status !== 'RESERVED') {
          this.spawnOperationFences.delete(record.ownershipId)
        }
      }
    }).catch(error => {
      fence.reconciliationError = error
    })
    return fence.reconciliation
  }

  _assertUniqueLaunchIdentity(candidate) {
    for (const [field, value] of Object.entries(candidate)) {
      if (typeof value !== 'string' || !value || value.includes('\0')) {
        fail('LAUNCH_SPEC_INVALID', `launch ${field} must be a non-empty identity string`)
      }
    }
    for (const existing of this.groups.values()) {
      if (existing.ownershipId === candidate.ownershipId ||
          existing.reservationId === candidate.reservationId ||
          existing.reservationIdentity === candidate.reservationIdentity ||
          existing.sessionId === candidate.sessionId) {
        fail('LAUNCH_SPEC_INVALID', 'launch identities must be globally unique before reservation', {
          ownershipId: candidate.ownershipId,
          reservationId: candidate.reservationId,
          reservationIdentity: candidate.reservationIdentity,
          sessionId: candidate.sessionId,
          conflictingOwnershipId: existing.ownershipId,
        })
      }
    }
  }

  _assertUniqueAttachedIdentity(candidate) {
    for (const existing of this.groups.values()) {
      if (existing.ownershipId === candidate.ownershipId) continue
      if (existing.groupIdentity === candidate.groupIdentity || existing.rootPid === candidate.rootPid) {
        fail('PROCESS_IDENTITY_CHANGED',
          'spawned ownership aliases another durable process identity', {
            ownershipId: candidate.ownershipId,
            groupIdentity: candidate.groupIdentity,
            rootPid: candidate.rootPid,
            conflictingOwnershipId: existing.ownershipId,
          })
      }
    }
  }

  _assertUniqueRegistryRecords(records) {
    const fields = ['ownershipId', 'reservationId', 'reservationIdentity', 'sessionId']
    for (const field of fields) {
      const values = new Set()
      for (const record of records) {
        if (values.has(record[field])) {
          fail('PROCESS_REGISTRY_FAILURE', `persisted process ${field} values must be globally unique`)
        }
        values.add(record[field])
      }
    }
    for (const field of ['groupIdentity', 'rootPid']) {
      const values = new Set()
      for (const record of records) {
        if (record[field] === null || record[field] === undefined) continue
        if (values.has(record[field])) {
          fail('PROCESS_REGISTRY_FAILURE', `persisted process ${field} values must be globally unique`)
        }
        values.add(record[field])
      }
    }
  }

  async launch(spec) {
    if (!spec || typeof spec.executable !== 'string' || !spec.executable ||
        !Array.isArray(spec.argv) || spec.argv.some((argument) => typeof argument !== 'string')) {
      fail('LAUNCH_SPEC_INVALID', 'launch requires an executable and an exact string argv array')
    }
    if (spec.shell === true && spec.explicitShellMode !== true) {
      fail('LAUNCH_SPEC_INVALID', 'shell launch requires explicitShellMode')
    }
    if (spec.env !== undefined && (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env) ||
        Object.entries(spec.env).some(([name, value]) => !name || name.includes('\0') ||
          typeof value !== 'string' || value.includes('\0')))) {
      fail('LAUNCH_SPEC_INVALID', 'launch env must be an exact string-to-string map without NUL bytes')
    }
    if (typeof spec.targetKey !== 'string' || !spec.targetKey) fail('LAUNCH_SPEC_INVALID', 'launch requires targetKey')
    if (this.adapter.kind !== 'test' && !path.isAbsolute(spec.executable)) {
      fail('LAUNCH_SPEC_INVALID', 'owned executable must be an absolute path; child PATH resolution is forbidden')
    }
    const admission = await this._adapterCall('admit')
    if (!admission || admission.supported !== true) {
      fail('PROVIDER_UNSUPPORTED', admission && admission.reason ? admission.reason : 'process ownership adapter refused admission')
    }
    const ownershipId = this.randomId()
    const reservationId = spec.reservationId === undefined ? ownershipId : spec.reservationId
    const reservationIdentity = typeof this.adapter.reservationIdentity === 'function'
      ? this.adapter.reservationIdentity(reservationId)
      : reservationId
    const sessionId = spec.sessionId || ownershipId
    this._assertUniqueLaunchIdentity({ ownershipId, reservationId, reservationIdentity, sessionId })
    const requiredControlEnvironment = processLaunchControlEnvironment(this.adapter, reservationId)
    const exactEnvironment = spec.env === undefined ? {} : { ...spec.env }
    for (const [name, value] of Object.entries(requiredControlEnvironment)) {
      if (exactEnvironment[name] !== value) {
        fail('PROCESS_ENVIRONMENT_UNATTESTED', `child control field ${name} must be included before environment attestation`, {
          reservationId,
          requiredControlEnvironment,
        })
      }
    }
    if (this.budget) this.budget.recordLaunch({ forWork: spec.forWork !== false })
    if (this.budget) {
      this.budget.startSession(sessionId, {
        activationId: spec.activationId,
        parentSessionId: spec.parentSessionId,
        forWork: spec.forWork !== false,
      })
    }
    const startedAt = String(this.wallClock())
    const startedAtMs = Date.parse(startedAt)
    if (!Number.isFinite(startedAtMs)) fail('PROCESS_OWNER_CONFIG_INVALID', 'wallClock must return a date-time')
    const startupDeadlineAt = new Date(startedAtMs + this.startupTimeoutMs).toISOString()
    const reservationBinding = typeof this.adapter.prepareReservation === 'function'
      ? this.adapter.prepareReservation({ reservationId, reservationIdentity, startupDeadlineAt, targetKey: spec.targetKey })
      : null
    const record = {
      ownershipId,
      reservationId,
      sessionId,
      rootPid: null,
      groupIdentity: null,
      targetKey: spec.targetKey,
      adapterKind: this.adapter.kind,
      startedAt,
      startupDeadlineAt,
      reservationIdentity,
      reservationBinding,
      status: 'RESERVED',
      rootExit: null,
      terminal: null,
      handle: null,
    }
    this.groups.set(ownershipId, record)
    try {
      this._persistRegistry(null, 'reserve')
    } catch (error) {
      this.groups.delete(ownershipId)
      if (this.budget) this.budget.endSession(sessionId, { status: 'FAILED', evidenceHashes: [] })
      fail('PROCESS_RESERVATION_FAILURE', 'launch reservation could not be persisted before spawn', { cause: error.message })
    }
    try { this.onOwnershipChange(this.ownershipIdentities()) } catch (error) {
      fail('PROCESS_RESERVATION_FAILURE', 'durable reservation could not be bound to the target lease', {
        reservationId: record.reservationId,
        reservationIdentity: record.reservationIdentity,
        reservationBinding: record.reservationBinding,
        startupDeadlineAt: record.startupDeadlineAt,
        cause: error.message,
      })
    }

    let handle
    try {
      handle = await this._spawnOwnedWithFence(record, {
        ownershipId,
        reservationId: record.reservationId,
        reservationIdentity: record.reservationIdentity,
        reservationBinding: record.reservationBinding,
        startupDeadlineAt: record.startupDeadlineAt,
        targetKey: spec.targetKey,
        executable: spec.executable,
        argv: [...spec.argv],
        cwd: spec.cwd,
        env: exactEnvironment,
        shell: spec.shell === true,
        stdin: spec.stdin,
        stdout: spec.stdout,
        stderr: spec.stderr,
      })
    } catch (error) {
      // Once the durable reservation admits the physical operation, neither a
      // timeout nor an adapter rejection proves that no child/helper exists.
      // Recovery must make that determination; closing the reservation here
      // would allow a late settlement to become an orphan.
      try { this.onOwnershipChange(this.ownershipIdentities()) } catch {}
      throw error
    }
    if (!handle || !Number.isSafeInteger(handle.rootPid) || handle.rootPid < 1 ||
        typeof handle.groupIdentity !== 'string' || !handle.groupIdentity) {
      fail('OWNERSHIP_COMMIT_FATAL', 'adapter spawned without a recoverable root and group identity')
    }
    const attached = {
      ...record,
      rootPid: handle.rootPid,
      groupIdentity: handle.groupIdentity,
      status: 'RUNNING',
      handle,
    }
    try {
      this._assertUniqueAttachedIdentity(attached)
      this._persistRegistry(attached, 'attach')
    } catch (registryError) {
      let terminationError = null
      try {
        await this._adapterCall('signalOwned', attached.groupIdentity, 'KILL')
        const remaining = await this._adapterCall('listOwned', attached.groupIdentity)
        if (remaining.length) throw new Error(`owned members remain: ${remaining.join(',')}`)
      } catch (error) {
        terminationError = error
      }
      // Keep the durable RESERVED record. recoverReservation(reservationId)
      // is the authority after restart, even when emergency termination failed.
      fail('OWNERSHIP_COMMIT_FATAL', 'spawned ownership could not be committed durably', {
        reservationId: record.reservationId,
        groupIdentity: attached.groupIdentity,
        registryCause: registryError.message,
        terminationCause: terminationError && terminationError.message,
      })
    }
    Object.assign(record, attached)
    this.spawnOperationFences.delete(record.ownershipId)
    this.onOwnershipChange(this.ownershipIdentities())
    return canonicalize({
      ownershipId,
      sessionId,
      rootPid: record.rootPid,
      groupIdentity: record.groupIdentity,
      targetKey: record.targetKey,
      startedAt: record.startedAt,
      status: record.status,
    })
  }

  async observeRootExit(ownershipId, exit) {
    const record = this._group(ownershipId)
    if (record.rootExit) fail('PROCESS_TERMINAL_DUPLICATE', 'root exit was already recorded')
    const rootExit = canonicalize({
      code: exit && exit.code === undefined ? null : exit.code,
      signal: exit && exit.signal ? String(exit.signal) : null,
      terminalEnvelope: exit && exit.terminalEnvelope ? exit.terminalEnvelope : null,
      observedAt: String(this.wallClock()),
    })
    const exited = { ...record, rootExit }
    this._persistRegistry(exited, 'root-exit')
    record.rootExit = rootExit
    const confirmationMs = exit && exit.killMs !== undefined ? exit.killMs : 1000
    if (!Number.isSafeInteger(confirmationMs) || confirmationMs < 0) {
      fail('PROCESS_OWNER_CONFIG_INVALID', 'root-exit killMs is invalid')
    }
    const remaining = await this._confirmDrained(record, confirmationMs)
    if (remaining.length) {
      await this.cancelGroup(ownershipId, {
        reason: 'root exited with live descendants',
        graceMs: 0,
        killMs: exit && exit.killMs,
        terminalStatus: this._statusFromExit(record.rootExit),
      })
    } else {
      this._terminal(record, this._statusFromExit(record.rootExit), 'root exited and group drained')
    }
    return this.terminalRecords.get(ownershipId)
  }

  async cancelAll(options = {}) {
    let recoveryError = null
    try {
      await this.recoverReservations({ waitForPending: options.waitForPending === true })
    } catch (error) { recoveryError = error }
    const results = []
    const cleanupFailures = []
    for (const ownershipId of [...this.groups.keys()].sort()) {
      const record = this.groups.get(ownershipId)
      if (!record || record.status !== 'RUNNING') continue
      try { results.push(await this.cancelGroup(ownershipId, options)) } catch (error) {
        cleanupFailures.push({ ownershipId, code: error && error.code || 'ERROR', message: error && error.message || String(error) })
      }
    }
    try { await this.assertDrained({ skipRecovery: true, skipRunningDrain: true }) } catch (error) {
      cleanupFailures.push({ ownershipId: null, code: error && error.code || 'ERROR', message: error && error.message || String(error) })
    }
    if (cleanupFailures.length) {
      fail('PROCESS_DRAIN_TIMEOUT', 'one or more known owned process groups could not be drained', {
        cleanupFailures: canonicalize(cleanupFailures),
        recoveryFailure: recoveryError ? {
          code: recoveryError.code || 'ERROR', message: recoveryError.message,
          details: recoveryError.details || null,
        } : null,
      })
    }
    if (recoveryError) throw recoveryError
    return results
  }

  async cancelGroup(ownershipId, options = {}) {
    let record = this._group(ownershipId)
    if (record.status === 'RESERVED') {
      let recoveryError = null
      try { await this.recoverReservations({ waitForPending: false }) } catch (error) { recoveryError = error }
      record = this._group(ownershipId)
      if (record.status === 'RESERVED' && recoveryError) throw recoveryError
    }
    if (record.status !== 'RUNNING') return this.terminalRecords.get(ownershipId)
    const reason = options.reason || 'runtime cancellation'
    const graceMs = options.graceMs === undefined ? 1000 : options.graceMs
    const killMs = options.killMs === undefined ? 1000 : options.killMs
    for (const [name, value] of [['graceMs', graceMs], ['killMs', killMs]]) {
      if (!Number.isSafeInteger(value) || value < 0) fail('PROCESS_OWNER_CONFIG_INVALID', `${name} is invalid`)
    }
    let remaining = await this._adapterCall('listOwned', record.groupIdentity)
    if (remaining.length) {
      // A group may have exited and durably published zero membership before
      // cancellation observes it. Only live members require a live process
      // identity; every signal remains identity-gated to reject PID reuse.
      await this._verifyOwnership(record)
      await this._adapterCall('signalOwned', record.groupIdentity, 'TERM')
      remaining = await this._waitForZero(record, graceMs)
    }
    if (remaining.length) {
      await this._verifyOwnership(record)
      await this._adapterCall('signalOwned', record.groupIdentity, 'KILL')
      remaining = await this._waitForZero(record, killMs)
    }
    if (remaining.length) {
      fail('PROCESS_DRAIN_TIMEOUT', `owned process group did not drain: ${record.groupIdentity}`, {
        remaining: canonicalize(remaining),
      })
    }
    remaining = await this._confirmDrained(record, killMs)
    if (remaining.length) {
      await this._verifyOwnership(record)
      await this._adapterCall('signalOwned', record.groupIdentity, 'KILL')
      remaining = await this._waitForZero(record, killMs)
      if (!remaining.length) remaining = await this._confirmDrained(record, killMs)
    }
    if (remaining.length) {
      fail('PROCESS_DRAIN_TIMEOUT', `late owned process appeared while confirming drain: ${record.groupIdentity}`, {
        remaining: canonicalize(remaining),
      })
    }
    return this._terminal(record, options.terminalStatus || 'CANCELLED', reason)
  }

  async recoverReservations(options = {}) {
    const waitForPending = options.waitForPending !== false
    const recoveryStarted = this.monotonicMs()
    let unresolved = []
    while (true) {
      unresolved = []
      let nextWaitMs = null
      const reservations = [...this.groups.values()]
        .filter(entry => entry.status === 'RESERVED')
        .sort((left, right) => left.ownershipId.localeCompare(right.ownershipId))
      for (const record of reservations) {
        let probe
        try {
          probe = await this._probeReservation(record)
        } catch (error) {
          unresolved.push({
            ownershipId: record.ownershipId,
            reservationId: record.reservationId,
            state: 'UNKNOWN',
            evidence: { code: error && error.code || 'ERROR', message: error && error.message || String(error) },
          })
          continue
        }
        if (!probe || !['LIVE', 'DEAD', 'PENDING', 'UNKNOWN'].includes(probe.state)) {
          unresolved.push({
            ownershipId: record.ownershipId,
            reservationId: record.reservationId,
            state: 'UNKNOWN', evidence: { reason: 'invalid-recovery-state' },
          })
          continue
        }
        if (probe.state === 'LIVE') {
          try { this._attachRecovered(record, probe.ownership, 'recover-attach') } catch (error) {
            unresolved.push({
              ownershipId: record.ownershipId,
              reservationId: record.reservationId,
              state: 'UNKNOWN',
              evidence: { code: error && error.code || 'ERROR', message: error && error.message || String(error) },
            })
          }
          continue
        }
        if (probe.state === 'DEAD') {
          try { this._terminal(record, 'FAILED', 'durable launch reservation is conclusively dead') } catch (error) {
            unresolved.push({
              ownershipId: record.ownershipId,
              reservationId: record.reservationId,
              state: 'UNKNOWN',
              evidence: { code: error && error.code || 'ERROR', message: error && error.message || String(error) },
            })
          }
          continue
        }
        const remainingWallMs = Date.parse(record.startupDeadlineAt) - Date.parse(String(this.wallClock()))
        const elapsed = Math.max(0, this.monotonicMs() - recoveryStarted)
        const pendingWithinDeadline = probe.state === 'PENDING' && Number.isFinite(remainingWallMs) &&
          remainingWallMs > 0 && elapsed < this.startupTimeoutMs
        unresolved.push({
          ownershipId: record.ownershipId,
          reservationId: record.reservationId,
          state: probe.state,
          evidence: probe.evidence || null,
        })
        if (pendingWithinDeadline && waitForPending) {
          const bounded = Math.min(Math.max(1, this.pollMs), remainingWallMs, this.startupTimeoutMs - elapsed)
          nextWaitMs = nextWaitMs === null ? bounded : Math.min(nextWaitMs, bounded)
        }
      }
      if (nextWaitMs === null) break
      await this.wait(nextWaitMs)
    }
    if (unresolved.length) {
      const pendingOnly = unresolved.every(item => item.state === 'PENDING')
      fail(pendingOnly ? 'OWNERSHIP_RECOVERY_PENDING' : 'OWNERSHIP_RECOVERY_FATAL',
        'one or more durable launch reservations remain unresolved after the bounded recovery review', {
          reservations: canonicalize(unresolved),
        })
    }
    return this.listRecords()
  }

  async _probeReservation(record) {
    const fence = this.spawnOperationFences.get(record.ownershipId)
    if (fence && fence.state === 'SETTLED_OWNERSHIP') {
      return { state: 'LIVE', ownership: fence.ownership, evidence: { source: 'live-operation-fence' } }
    }
    if (fence && fence.state === 'PENDING') {
      const beforeDeadline = Date.parse(String(this.wallClock())) < Date.parse(record.startupDeadlineAt)
      return beforeDeadline
        ? { state: 'PENDING', evidence: { source: 'live-operation-fence' } }
        : { state: 'UNKNOWN', evidence: { source: 'live-operation-fence', reason: 'adapter-promise-unsettled-after-deadline' } }
    }
    if (typeof this.adapter.probeReservation === 'function') {
      return this._adapterCall('probeReservation', record)
    }
    const recovered = await this._adapterCall('recoverReservation', record.reservationId)
    if (recovered !== null) return { state: 'LIVE', ownership: recovered }
    const beforeDeadline = Date.parse(String(this.wallClock())) < Date.parse(record.startupDeadlineAt)
    return beforeDeadline
      ? { state: 'PENDING', evidence: { reason: 'point-scan-empty-before-startup-deadline' } }
      : { state: 'DEAD', evidence: { reason: 'point-scan-empty-after-startup-deadline' } }
  }

  _attachRecovered(record, recovered, phase) {
    if (!recovered || !Number.isSafeInteger(recovered.rootPid) || recovered.rootPid < 1 ||
        typeof recovered.groupIdentity !== 'string' || !recovered.groupIdentity) {
      fail('OWNERSHIP_RECOVERY_FATAL', `reservation ${record.reservationId} returned an invalid ownership identity`)
    }
    if (record.status === 'RUNNING') {
      if (record.rootPid !== recovered.rootPid || record.groupIdentity !== recovered.groupIdentity) {
        fail('PROCESS_IDENTITY_CHANGED', `reservation ${record.reservationId} resolved to conflicting ownership identities`)
      }
      return record
    }
    if (record.status !== 'RESERVED') {
      fail('OWNERSHIP_RECOVERY_FATAL', `reservation ${record.reservationId} settled after its durable fence closed`)
    }
    const attached = {
      ...record,
      rootPid: recovered.rootPid,
      groupIdentity: recovered.groupIdentity,
      status: 'RUNNING',
      handle: recovered,
    }
    this._persistRegistry(attached, phase)
    Object.assign(record, attached)
    this.onOwnershipChange(this.ownershipIdentities())
    return record
  }

  async assertDrained(options = {}) {
    let recoveryError = null
    if (options.skipRecovery !== true) {
      try { await this.recoverReservations({ waitForPending: false }) } catch (error) { recoveryError = error }
    }
    const cleanupFailures = options.skipRunningDrain === true
      ? [] : await this._drainRecoveredRunningGroups(() => true)
    await this._assertDrainedKnown()
    if (cleanupFailures.length) {
      fail('PROCESS_DRAIN_TIMEOUT', 'known recovered process groups failed to drain during the aggregate assertion', {
        cleanupFailures: canonicalize(cleanupFailures),
        recoveryFailure: recoveryError ? { code: recoveryError.code, message: recoveryError.message } : null,
      })
    }
    if (recoveryError) throw recoveryError
    return true
  }

  async _drainRecoveredRunningGroups(predicate) {
    const failures = []
    for (const record of [...this.groups.values()]
      .filter(entry => entry.status === 'RUNNING' && predicate(entry))
      .sort((left, right) => left.ownershipId.localeCompare(right.ownershipId))) {
      try {
        await this.cancelGroup(record.ownershipId, {
          reason: 'aggregate drain assertion recovered a live owned group',
          graceMs: 0,
          killMs: Math.max(1, this.startupTimeoutMs),
          terminalStatus: 'LOST',
        })
      } catch (error) {
        failures.push({
          ownershipId: record.ownershipId,
          code: error && error.code || 'ERROR',
          message: error && error.message || String(error),
        })
      }
    }
    return failures
  }

  async _assertDrainedKnown() {
    const live = []
    for (const record of this.groups.values()) {
      if (typeof record.groupIdentity !== 'string' || !record.groupIdentity) continue
      let members = await this._adapterCall('listOwned', record.groupIdentity)
      if (members.length && record.status !== 'RUNNING') {
        members = await this._confirmDrained(record, Math.max(1, this.pollMs))
        if (members.length) {
          await this._verifyOwnership(record)
          await this._adapterCall('signalOwned', record.groupIdentity, 'KILL')
          members = await this._waitForZero(record, Math.max(1, this.pollMs))
          if (!members.length) members = await this._confirmDrained(record, Math.max(1, this.pollMs))
        }
      }
      if (members.length) live.push({ ownershipId: record.ownershipId, members })
    }
    if (live.length) fail('OWNED_PROCESSES_LIVE', 'owned descendants are still live', { groups: canonicalize(live) })
    return true
  }

  async assertTargetDrained(targetKey) {
    if (typeof targetKey !== 'string' || !targetKey) fail('PROCESS_IDENTITY_INVALID', 'target identity is required')
    let recoveryError = null
    try { await this.recoverReservations({ waitForPending: false }) } catch (error) { recoveryError = error }
    const cleanupFailures = await this._drainRecoveredRunningGroups(record => record.targetKey === targetKey)
    if (typeof this.adapter.listTargetOwned !== 'function') {
      fail('PROVIDER_UNSUPPORTED', 'process adapter cannot prove target-global liveness')
    }
    const roots = await this._adapterCall('listTargetOwned', targetKey, this.listRecords())
    if (!Array.isArray(roots)) fail('PROCESS_IDENTITY_INVALID', 'target liveness probe returned an invalid result')
    if (roots.length) {
      fail('OWNED_PROCESSES_LIVE', 'target still has live roots or descendants', {
        targetKey,
        roots: canonicalize(roots),
        cleanupFailures: canonicalize(cleanupFailures),
      })
    }
    if (cleanupFailures.length) {
      fail('PROCESS_DRAIN_TIMEOUT', 'known target process groups failed to drain during the aggregate assertion', {
        targetKey,
        cleanupFailures: canonicalize(cleanupFailures),
        recoveryFailure: recoveryError ? { code: recoveryError.code, message: recoveryError.message } : null,
      })
    }
    if (recoveryError) throw recoveryError
    return true
  }

  listRecords() {
    return [...this.groups.values()].map((record) => canonicalize({
      ownershipId: record.ownershipId,
      reservationId: record.reservationId,
      sessionId: record.sessionId,
      rootPid: record.rootPid,
      groupIdentity: record.groupIdentity,
      targetKey: record.targetKey,
      adapterKind: record.adapterKind,
      startedAt: record.startedAt,
      startupDeadlineAt: record.startupDeadlineAt,
      reservationIdentity: record.reservationIdentity,
      reservationBinding: record.reservationBinding,
      status: record.status,
      rootExit: record.rootExit,
      terminal: record.terminal,
    }))
  }

  _group(ownershipId) {
    const record = this.groups.get(ownershipId)
    if (!record) fail('PROCESS_NOT_OWNED', `unknown ownership id: ${ownershipId}`)
    return record
  }

  async _verifyOwnership(record) {
    if (typeof this.adapter.verifyOwnership !== 'function') return
    const verified = await this._adapterCall('verifyOwnership', {
      ownershipId: record.ownershipId,
      reservationId: record.reservationId,
      reservationIdentity: record.reservationIdentity,
      rootPid: record.rootPid,
      groupIdentity: record.groupIdentity,
    })
    if (verified !== true) fail('PROCESS_IDENTITY_CHANGED', 'owned process group identity cannot be verified')
  }

  async _waitForZero(record, timeoutMs) {
    const start = this.monotonicMs()
    let remaining = await this._adapterCall('listOwned', record.groupIdentity)
    const maximumPolls = Math.ceil(timeoutMs / Math.max(1, this.pollMs)) + 1
    let polls = 0
    while (remaining.length && Math.max(0, this.monotonicMs() - start) < timeoutMs && polls < maximumPolls) {
      await this.wait(this.pollMs)
      polls += 1
      remaining = await this._adapterCall('listOwned', record.groupIdentity)
    }
    return remaining
  }

  async _confirmDrained(record, timeoutMs) {
    const start = this.monotonicMs()
    let confirmations = 0
    do {
      const remaining = await this._adapterCall('listOwned', record.groupIdentity)
      if (remaining.length) return remaining
      confirmations += 1
      if (confirmations >= this.zeroConfirmations) return []
      await this.wait(this.pollMs)
    } while (Math.max(0, this.monotonicMs() - start) <= timeoutMs + this.pollMs * this.zeroConfirmations)
    return this._adapterCall('listOwned', record.groupIdentity)
  }

  _statusFromExit(exit) {
    if (exit.terminalEnvelope && ['DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED', 'LOST'].includes(exit.terminalEnvelope.status)) {
      return exit.terminalEnvelope.status
    }
    return exit.code === 0 ? 'DONE' : 'FAILED'
  }

  _terminal(record, status, reason) {
    if (this.terminalRecords.has(record.ownershipId)) {
      this.onOwnershipChange(this.ownershipIdentities())
      return this.terminalRecords.get(record.ownershipId)
    }
    const terminal = canonicalize({
      ownershipId: record.ownershipId,
      sessionId: record.sessionId,
      rootPid: record.rootPid,
      groupIdentity: record.groupIdentity,
      startedAt: record.startedAt,
      endedAt: String(this.wallClock()),
      status,
      reason,
      rootExit: record.rootExit,
    })
    const committed = { ...record, status, terminal }
    this._persistRegistry(committed, 'terminal')
    record.status = status
    record.terminal = terminal
    this.terminalRecords.set(record.ownershipId, terminal)
    const fence = this.spawnOperationFences.get(record.ownershipId)
    if (fence && fence.state !== 'PENDING') this.spawnOperationFences.delete(record.ownershipId)
    this.onOwnershipChange(this.ownershipIdentities())
    if (this.budget) this.budget.endSession(record.sessionId, { status, evidenceHashes: [] })
    this.onTerminal(terminal)
    return terminal
  }

  ownershipIdentities() {
    return [...this.groups.values()]
      .filter((record) => ['RUNNING', 'RESERVED'].includes(record.status))
      .map((record) => record.status === 'RUNNING'
        ? { kind: record.adapterKind, id: record.groupIdentity }
        : {
            kind: `${record.adapterKind}-reservation`,
            id: record.reservationIdentity,
          })
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async probeOwnedIdentities(identities) {
    if (!Array.isArray(identities)) fail('PROCESS_IDENTITY_INVALID', 'drain evidence requires an identity array')
    const keys = new Set()
    const evidence = []
    for (const identity of identities) {
      if (!identity || typeof identity.kind !== 'string' || !identity.kind ||
          typeof identity.id !== 'string' || !identity.id) {
        fail('PROCESS_IDENTITY_INVALID', 'drain evidence contains an invalid ownership identity')
      }
      const key = `${identity.kind}\0${identity.id}`
      if (keys.has(key)) fail('PROCESS_IDENTITY_INVALID', 'drain evidence identities must be unique')
      keys.add(key)
      evidence.push(await this.verifyOwnedIdentity(identity))
    }
    evidence.sort((left, right) => `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`))
    return Object.freeze(canonicalize(evidence))
  }

  async verifyOwnedIdentity(identity) {
    if (!identity || typeof identity.kind !== 'string' || !identity.kind ||
        typeof identity.id !== 'string' || !identity.id) {
      fail('PROCESS_IDENTITY_INVALID', 'ownership identity must contain nonempty kind and id')
    }
    let observed
    if (typeof this.adapter.probeOwnedIdentity === 'function') {
      observed = await this._adapterCall('probeOwnedIdentity', identity)
      if (!Array.isArray(observed)) fail('PROCESS_IDENTITY_INVALID', `adapter returned invalid liveness for ${identity.id}`)
    } else if (identity.kind === this.adapter.kind) {
      observed = await this._adapterCall('listOwned', identity.id)
      if (!Array.isArray(observed)) fail('PROCESS_IDENTITY_INVALID', `adapter returned invalid liveness for ${identity.id}`)
    } else if (identity.kind === `${this.adapter.kind}-reservation`) {
      const record = [...this.groups.values()].find(entry => entry.reservationIdentity === identity.id)
      if (record && record.status === 'RESERVED') {
        const probe = await this._probeReservation(record)
        if (probe.state === 'LIVE') observed = [probe.ownership]
        else if (probe.state === 'DEAD') observed = []
        else fail(probe.state === 'PENDING' ? 'OWNERSHIP_RECOVERY_PENDING' : 'OWNERSHIP_RECOVERY_FATAL',
          `reservation identity ${identity.id} remains ${probe.state.toLowerCase()}`, {
            evidence: probe.evidence || null,
          })
      } else {
        const recovered = typeof this.adapter.recoverReservationIdentity === 'function'
          ? await this._adapterCall('recoverReservationIdentity', identity.id)
          : await this._adapterCall('recoverReservation', identity.id)
        observed = recovered === null ? [] : [recovered]
      }
    } else {
      fail('PROVIDER_UNSUPPORTED', `adapter ${this.adapter.kind} cannot verify ${identity.kind}`)
    }
    const alive = observed.length > 0
    const adapterEvidenceHash = sha256(stableStringify({
      adapterKind: this.adapter.kind,
      identity: { kind: identity.kind, id: identity.id },
      observed: canonicalize(observed),
    }))
    return Object.freeze(canonicalize({ kind: identity.kind, id: identity.id, verified: true, alive, adapterEvidenceHash }))
  }

  async verifyDrainedIdentities(identities) {
    const evidence = await this.probeOwnedIdentities(identities)
    const live = evidence.filter((entry) => entry.alive)
    if (live.length) {
      fail('PROCESS_DRAIN_TIMEOUT', 'persisted owned identities remain live', {
        live: live.map(({ kind, id, adapterEvidenceHash }) => ({ kind, id, adapterEvidenceHash })),
      })
    }
    return evidence
  }

  _restoreRegistry() {
    if (!this.fs.existsSync(this.registryPath)) return
    let registry
    try { registry = readChecksummedJson(this.registryPath, { fsImpl: this.fs }) } catch (error) {
      fail('PROCESS_REGISTRY_FAILURE', 'durable process registry is invalid', { cause: error.message })
    }
    if (registry.schemaVersion !== PROCESS_REGISTRY_SCHEMA_VERSION || !Array.isArray(registry.records) ||
        typeof registry.activationId !== 'string' || !registry.activationId ||
        !Number.isSafeInteger(registry.generationId) || registry.generationId < 1 ||
        !Number.isSafeInteger(registry.sequence) || registry.sequence < 1) {
      fail('PROCESS_REGISTRY_FAILURE', 'durable process registry schema is unsupported')
    }
    const currentBinding = registry.activationId === this.controlBinding.activationId &&
      registry.generationId === this.controlBinding.generationId
    const authorizedPredecessor = registry.activationId === this.controlBinding.activationId &&
      registry.generationId === this.controlBinding.predecessorGenerationId
    if (!currentBinding && !authorizedPredecessor) {
      fail('PROCESS_CONTROL_BINDING_MISMATCH', 'durable process registry belongs to a foreign activation generation')
    }
    if (registry.adapterKind !== this.adapter.kind) {
      fail('PROVIDER_UNSUPPORTED', `persisted ${registry.adapterKind} ownership cannot be reopened by ${this.adapter.kind}`)
    }
    const validated = []
    for (const saved of registry.records) {
      const allowedStatuses = ['RESERVED', 'RUNNING', 'DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED', 'LOST']
      const reserved = saved && saved.status === 'RESERVED'
      const hasOwnedIdentity = saved && typeof saved.groupIdentity === 'string' && saved.groupIdentity &&
        Number.isSafeInteger(saved.rootPid) && saved.rootPid > 0
      if (!saved || typeof saved.ownershipId !== 'string' || !saved.ownershipId ||
          !allowedStatuses.includes(saved.status) ||
          typeof saved.reservationId !== 'string' || !saved.reservationId ||
          typeof saved.reservationIdentity !== 'string' || !saved.reservationIdentity ||
          typeof saved.sessionId !== 'string' || !saved.sessionId ||
          Number.isNaN(Date.parse(saved.startupDeadlineAt)) ||
          (!reserved && !hasOwnedIdentity && !saved.terminal) ||
          saved.adapterKind !== this.adapter.kind || typeof saved.targetKey !== 'string' || !saved.targetKey) {
        fail('PROCESS_REGISTRY_FAILURE', 'persisted process ownership identity is invalid')
      }
      const expectedReservationIdentity = typeof this.adapter.reservationIdentity === 'function'
        ? this.adapter.reservationIdentity(saved.reservationId)
        : saved.reservationId
      if (saved.reservationIdentity !== expectedReservationIdentity) {
        fail('PROCESS_REGISTRY_FAILURE', 'persisted reservation identity does not match its adapter-derived origin')
      }
      const record = { ...saved, handle: null }
      try {
        if (typeof this.adapter.validateReservationBinding === 'function') {
          this.adapter.validateReservationBinding(record)
        } else if (typeof this.adapter.prepareReservation === 'function') {
          const expectedBinding = this.adapter.prepareReservation({
            reservationId: record.reservationId,
            reservationIdentity: record.reservationIdentity,
            startupDeadlineAt: record.startupDeadlineAt,
            targetKey: record.targetKey,
          })
          if (stableStringify(expectedBinding) !== stableStringify(record.reservationBinding)) {
            fail('PROCESS_REGISTRY_FAILURE', 'persisted reservation binding differs from its adapter-derived binding')
          }
        } else if (record.reservationBinding !== null && record.reservationBinding !== undefined) {
          fail('PROCESS_REGISTRY_FAILURE', 'adapter-less reservation binding is not permitted')
        }
      } catch (error) {
        if (error && error.code === 'PROCESS_REGISTRY_FAILURE') throw error
        fail('PROCESS_REGISTRY_FAILURE', 'persisted reservation binding is invalid', {
          cause: error && error.message ? error.message : String(error),
        })
      }
      validated.push(record)
    }
    this._assertUniqueRegistryRecords(validated)
    this.registrySequence = registry.sequence
    for (const record of validated) {
      this.groups.set(record.ownershipId, record)
      if (!['RUNNING', 'RESERVED'].includes(record.status) && record.terminal) {
        this.terminalRecords.set(record.ownershipId, record.terminal)
      }
    }
  }

  _persistRegistry(replacement = null, phase = 'update') {
    const records = [...this.groups.values()].map((existing) => {
      const record = replacement && replacement.ownershipId === existing.ownershipId ? replacement : existing
      return {
      ownershipId: record.ownershipId,
      reservationId: record.reservationId,
      sessionId: record.sessionId,
      rootPid: record.rootPid,
      groupIdentity: record.groupIdentity,
      targetKey: record.targetKey,
      adapterKind: record.adapterKind,
      startedAt: record.startedAt,
      startupDeadlineAt: record.startupDeadlineAt,
      reservationIdentity: record.reservationIdentity,
      reservationBinding: record.reservationBinding,
      status: record.status,
      rootExit: record.rootExit,
      terminal: record.terminal || this.terminalRecords.get(record.ownershipId) || null,
    }
    }).sort((left, right) => left.ownershipId.localeCompare(right.ownershipId))
    this._assertUniqueRegistryRecords(records)
    this.beforeRegistryCommit({ phase, records: canonicalize(records) })
    const sequence = this.registrySequence + 1
    atomicWriteJson(this.registryPath, {
      schemaVersion: PROCESS_REGISTRY_SCHEMA_VERSION,
      activationId: this.controlBinding.activationId,
      generationId: this.controlBinding.generationId,
      sequence,
      adapterKind: this.adapter.kind,
      records,
    }, { fsImpl: this.fs })
    this.registrySequence = sequence
  }
}

function createPosixProcessAdapter(options = {}) {
  const platform = options.platform || process.platform
  if (platform === 'win32') fail('PROVIDER_UNSUPPORTED', 'POSIX process groups are unavailable on Windows')
  const spawn = options.spawn || childProcess.spawn
  const execFileSync = options.execFileSync || childProcess.execFileSync
  const fsImpl = options.fsImpl || fs
  const wallNowMs = options.wallNowMs || Date.now
  function pgid(identity) {
    const match = /^posix-pgid:(\d+)$/.exec(identity)
    if (!match) fail('PROCESS_IDENTITY_INVALID', `invalid POSIX group identity: ${identity}`)
    return Number(match[1])
  }
  const adapter = {
    kind: 'posix-process-group',
    capabilities: {
      groupAtCreation: true,
      descendantEnumeration: true,
      groupSignal: true,
      stableIdentity: true,
      persistentIdentity: true,
      reservationRecovery: true,
    },
    childControlEnvironment(reservationId) {
      return { [POSIX_RESERVATION_ENV]: reservationId }
    },
    async admit() {
      if (platform !== 'linux' && typeof options.recoverReservation !== 'function') {
        return { supported: false, reason: 'POSIX reservation recovery requires Linux /proc or a provider implementation' }
      }
      try {
        execFileSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8', timeout: 10000 })
        return { supported: true }
      } catch (error) {
        return { supported: false, reason: `POSIX process-group probe failed: ${error.message}` }
      }
    },
    async spawnOwned(spec) {
      if (spec.shell) fail('PROVIDER_UNSUPPORTED', 'POSIX owned launch does not accept shell mode')
      if (!path.isAbsolute(spec.executable)) fail('LAUNCH_SPEC_INVALID', 'POSIX owned executable must be absolute')
      const requiredEnvironment = adapter.childControlEnvironment(spec.reservationId)
      if (!spec.env || Object.entries(requiredEnvironment).some(([name, value]) => spec.env[name] !== value)) {
        fail('PROCESS_ENVIRONMENT_UNATTESTED', 'POSIX reservation control must be present in the attested child environment')
      }
      const child = spawn(spec.executable, spec.argv, {
        cwd: spec.cwd,
        env: { ...spec.env },
        detached: true,
        shell: false,
        stdio: [spec.stdin || 'ignore', spec.stdout || 'ignore', spec.stderr || 'ignore'],
      })
      if (!child.pid) fail('PROCESS_IDENTITY_INVALID', 'spawn did not return a POSIX pid')
      return { rootPid: child.pid, groupIdentity: `posix-pgid:${child.pid}`, child }
    },
    async recoverReservation(reservationId) {
      if (typeof options.recoverReservation === 'function') return options.recoverReservation(reservationId)
      const marker = `${POSIX_RESERVATION_ENV}=${reservationId}`
      const matches = []
      for (const name of fsImpl.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
        try {
          const environment = fsImpl.readFileSync(`/proc/${name}/environ`)
          if (!hasExactNulDelimitedEntry(environment, marker)) continue
          const stat = fsImpl.readFileSync(`/proc/${name}/stat`, 'utf8')
          const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
          const processGroup = Number(fields[2])
          if (Number.isSafeInteger(processGroup) && processGroup > 0) matches.push(processGroup)
        } catch {}
      }
      if (!matches.length) return null
      const processGroup = Math.min(...matches)
      return { rootPid: processGroup, groupIdentity: `posix-pgid:${processGroup}` }
    },
    async probeReservation(record) {
      const ownership = await adapter.recoverReservation(record.reservationId)
      if (ownership !== null) return { state: 'LIVE', ownership }
      const deadline = Date.parse(record.startupDeadlineAt)
      if (!Number.isFinite(deadline)) {
        return { state: 'UNKNOWN', evidence: { reason: 'startup-deadline-invalid' } }
      }
      return wallNowMs() < deadline
        ? { state: 'PENDING', evidence: { reason: 'reservation-marker-not-yet-observed' } }
        : { state: 'DEAD', evidence: { reason: 'reservation-marker-absent-after-startup-deadline' } }
    },
    async listOwned(identity) {
      const group = pgid(identity)
      const source = execFileSync('ps', ['-eo', 'pid=,pgid=,stat='], {
        encoding: 'utf8', timeout: 10000,
      })
      return source.split(/\r?\n/).map((line) => {
        const [pidText, groupText, status = ''] = line.trim().split(/\s+/)
        return { pid: Number(pidText), processGroup: Number(groupText), status }
      })
        // A zombie has no executable side effect and cannot spawn descendants.
        // Keeping it in the live-member set after TERM would require a second
        // marker-authorized signal even though Linux exposes an empty environ
        // for the exited process. The unreaped PID also cannot yet be reused.
        .filter(({ pid, processGroup, status }) => Number.isSafeInteger(pid) &&
          processGroup === group && !/^Z/u.test(status))
        .map(({ pid }) => pid)
    },
    async signalOwned(identity, signal) { process.kill(-pgid(identity), signal === 'KILL' ? 'SIGKILL' : 'SIGTERM') },
    async verifyOwnership({ reservationId, rootPid, groupIdentity }) {
      if (typeof reservationId !== 'string' || !reservationId || pgid(groupIdentity) !== rootPid) return false
      const recovered = await adapter.recoverReservation(reservationId)
      return Boolean(recovered && recovered.rootPid === rootPid && recovered.groupIdentity === groupIdentity)
    },
    async listTargetOwned(targetKey, records) {
      const live = []
      const seen = new Set()
      for (const record of records.filter(entry => entry.targetKey === targetKey)) {
        let identity = typeof record.groupIdentity === 'string' && record.groupIdentity
          ? record.groupIdentity : null
        if (!identity && record.status === 'RESERVED') {
          const probe = await adapter.probeReservation(record)
          if (probe.state === 'LIVE') identity = probe.ownership.groupIdentity
        }
        if (!identity || seen.has(identity)) continue
        seen.add(identity)
        live.push(...await adapter.listOwned(identity))
      }
      return live
    },
  }
  return adapter
}

const WINDOWS_JOB_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$requestPath = $env:AUTOPROMPT_JOB_REQUEST
$statusPath = $env:AUTOPROMPT_JOB_STATUS
$killPath = $env:AUTOPROMPT_JOB_KILL
$encoding = New-Object System.Text.UTF8Encoding($false)
trap {
  try {
    $failure = [ordered]@{ schemaVersion = 1; reservationId = ''; helperPid = $PID; rootPid = $null;
      ready = $false; assigned = $false; status = 'FAILED'; pids = @();
      error = $_.Exception.ToString(); updatedAt = [DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText($statusPath, ($failure | ConvertTo-Json -Compress -Depth 5), $encoding)
  } catch {}
  exit 126
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public sealed class AutopromptOwnedJob : IDisposable {
  const UInt32 CREATE_SUSPENDED = 0x00000004;
  const UInt32 CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const UInt32 CREATE_NO_WINDOW = 0x08000000;
  const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public Int32 cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public UInt32 dwX; public UInt32 dwY; public UInt32 dwXSize; public UInt32 dwYSize;
    public UInt32 dwXCountChars; public UInt32 dwYCountChars; public UInt32 dwFillAttribute;
    public UInt32 dwFlags; public UInt16 wShowWindow; public UInt16 cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public UInt32 dwProcessId; public UInt32 dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit; public Int64 PerJobUserTimeLimit; public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity; public UInt32 PriorityClass; public UInt32 SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public UInt64 ReadOperationCount; public UInt64 WriteOperationCount; public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount; public UInt64 WriteTransferCount; public UInt64 OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, UInt32 length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, UInt32 flags, IntPtr environment, string currentDirectory,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern UInt32 ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, UInt32 code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, UInt32 code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass,
    IntPtr info, UInt32 length, out UInt32 returnedLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

  IntPtr job;
  IntPtr process;
  IntPtr thread;
  public Int32 RootPid { get; private set; }

  static string Quote(string value) {
    if (value.Length == 0) return "\"\"";
    if (!value.Any(c => Char.IsWhiteSpace(c) || c == '"')) return value;
    var output = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append('"'); slashes = 0; continue; }
      output.Append('\\', slashes); slashes = 0; output.Append(c);
    }
    output.Append('\\', slashes * 2); output.Append('"');
    return output.ToString();
  }

  public static AutopromptOwnedJob Start(string executable, string[] argv, string cwd,
      IDictionary<string,string> environment, DateTime startupDeadlineUtc) {
    var owned = new AutopromptOwnedJob();
    owned.job = CreateJobObject(IntPtr.Zero, null);
    if (owned.job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
    var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int limitSize = Marshal.SizeOf(limits);
    IntPtr limitPointer = Marshal.AllocHGlobal(limitSize);
    try {
      Marshal.StructureToPtr(limits, limitPointer, false);
      if (!SetInformationJobObject(owned.job, 9, limitPointer, (UInt32)limitSize))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
    } finally { Marshal.FreeHGlobal(limitPointer); }

    string[] all = (new [] { executable }).Concat(argv ?? new string[0]).ToArray();
    var command = new StringBuilder(String.Join(" ", all.Select(Quote)));
    var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup);
    var environmentText = String.Join("\0", environment.OrderBy(e => e.Key, StringComparer.OrdinalIgnoreCase)
      .Select(e => e.Key + "=" + e.Value)) + "\0\0";
    IntPtr environmentPointer = Marshal.StringToHGlobalUni(environmentText);
    PROCESS_INFORMATION created;
    try {
      if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
          environmentPointer, cwd, ref startup, out created))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess suspended failed");
    } finally { Marshal.FreeHGlobal(environmentPointer); }
    owned.process = created.hProcess; owned.thread = created.hThread; owned.RootPid = (Int32)created.dwProcessId;
    if (!AssignProcessToJobObject(owned.job, owned.process)) {
      int error = Marshal.GetLastWin32Error(); TerminateProcess(owned.process, 126); owned.Dispose();
      throw new Win32Exception(error, "AssignProcessToJobObject failed before child resume");
    }
    if (DateTime.UtcNow >= startupDeadlineUtc) {
      TerminateJobObject(owned.job, 124); owned.Dispose();
      throw new TimeoutException("Windows Job assignment missed its startup deadline before child resume");
    }
    if (ResumeThread(owned.thread) == UInt32.MaxValue) {
      int error = Marshal.GetLastWin32Error(); TerminateJobObject(owned.job, 126); owned.Dispose();
      throw new Win32Exception(error, "ResumeThread failed after assignment");
    }
    CloseHandle(owned.thread); owned.thread = IntPtr.Zero;
    return owned;
  }

  public static void Probe(string commandInterpreter, string cwd, IDictionary<string,string> environment) {
    AutopromptOwnedJob owned = null;
    try {
      owned = Start(commandInterpreter, new [] { "/d", "/c", "exit", "0" }, cwd, environment,
        DateTime.UtcNow.AddSeconds(10));
      owned.Terminate(0);
    } finally {
      if (owned != null) owned.Dispose();
    }
  }

  public Int64[] ProcessIds() {
    int capacity = 64;
    while (capacity <= 65536) {
      int size = 8 + capacity * IntPtr.Size;
      IntPtr pointer = Marshal.AllocHGlobal(size);
      try {
        UInt32 returned;
        if (QueryInformationJobObject(job, 3, pointer, (UInt32)size, out returned)) {
          int count = Marshal.ReadInt32(pointer, 4);
          var result = new Int64[count];
          for (int i = 0; i < count; i++) result[i] = Marshal.ReadIntPtr(pointer, 8 + i * IntPtr.Size).ToInt64();
          return result;
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 234) throw new Win32Exception(error, "QueryInformationJobObject failed");
      } finally { Marshal.FreeHGlobal(pointer); }
      capacity *= 2;
    }
    throw new InvalidOperationException("Job contains too many processes to enumerate safely");
  }

  public void Terminate(UInt32 code) {
    if (job != IntPtr.Zero && !TerminateJobObject(job, code))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");
  }
  public void Dispose() {
    if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
    if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
  }
}
'@

if ($env:AUTOPROMPT_JOB_PROBE -eq '1') {
  $probeEnvironment = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $probeEnvironment[[string]$entry.Key] = [string]$entry.Value
  }
  [AutopromptOwnedJob]::Probe([string]$env:ComSpec, [string]$env:SystemRoot, $probeEnvironment)
  exit 0
}

$request = Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Write-JobStatus([string]$state, [bool]$ready, [bool]$assigned, [object[]]$pids, [string]$errorText) {
  $script:observedPids = @($script:observedPids + @($pids) | Where-Object { $_ -is [ValueType] } | Sort-Object -Unique)
  $record = [ordered]@{ schemaVersion = 1; reservationId = [string]$request.reservationId;
    reservationIdentity = [string]$request.reservationIdentity; requestChecksum = [string]$request.checksum; helperPid = $PID;
    rootPid = if ($script:owned) { $script:owned.RootPid } else { $null }; ready = $ready; assigned = $assigned;
    status = $state; pids = @($pids); observedPids = @($script:observedPids); error = $errorText;
    updatedAt = [DateTime]::UtcNow.ToString('o') }
  $json = $record | ConvertTo-Json -Compress -Depth 5
  $temporary = "$statusPath.$PID.tmp"
  [IO.File]::WriteAllText($temporary, $json, $encoding)
  if (Test-Path -LiteralPath $statusPath) {
    $backup = "$statusPath.previous"
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    [IO.File]::Replace($temporary, $statusPath, $backup, $true)
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
  else { [IO.File]::Move($temporary, $statusPath) }
}

$script:owned = $null
$script:observedPids = @()
try {
  $startupDelay = [int]$request.startupDelayMilliseconds
  if ($startupDelay -gt 0) { Start-Sleep -Milliseconds $startupDelay }
  $environment = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($property in $request.environment.PSObject.Properties) { $environment[[string]$property.Name] = [string]$property.Value }
  $arguments = @($request.argv | ForEach-Object { [string]$_ })
  $startupDeadline = [DateTime]::Parse([string]$request.startupDeadlineAt).ToUniversalTime()
  $script:owned = [AutopromptOwnedJob]::Start([string]$request.executable, [string[]]$arguments,
    [string]$request.cwd, $environment, $startupDeadline)
  Write-JobStatus 'RUNNING' $true $true @($script:owned.ProcessIds()) $null
  while ($true) {
    if (Test-Path -LiteralPath $killPath) {
      $terminating = @($script:owned.ProcessIds())
      Write-JobStatus 'STOPPING' $true $true $terminating $null
      $script:owned.Terminate(143)
    }
    $pids = @($script:owned.ProcessIds())
    if ($pids.Count -eq 0) { break }
    Write-JobStatus 'RUNNING' $true $true $pids $null
    Start-Sleep -Milliseconds 50
  }
  Write-JobStatus 'EXITED' $true $true @() $null
} catch {
  try { Write-JobStatus 'FAILED' $false $false @() $_.Exception.ToString() } catch {}
  exit 126
} finally {
  if ($script:owned) { $script:owned.Dispose() }
}
`

function createWindowsJobAdapter(options = {}) {
  if (options && REQUIRED_PROCESS_ADAPTER_METHODS.every((method) => typeof options[method] === 'function')) {
    return {
      ...options,
      kind: 'windows-job-object',
      capabilities: Object.fromEntries(REQUIRED_PROCESS_CAPABILITIES.map((field) => [field, true])),
    }
  }
  if (process.platform !== 'win32') fail('PROVIDER_UNSUPPORTED', 'Windows Job Objects are unavailable on this platform')
  const fsImpl = options.fsImpl || fs
  const spawn = options.spawn || childProcess.spawn
  const execFileSync = options.execFileSync || childProcess.execFileSync
  const powershellPath = options.powershellPath || 'powershell.exe'
  const wallNowMs = options.wallNowMs || Date.now
  const monotonicMs = options.monotonicMs || (() => Number(process.hrtime.bigint() / 1000000n))
  const startupDelayMilliseconds = options.startupDelayMilliseconds === undefined ? 0 : options.startupDelayMilliseconds
  if (!Number.isSafeInteger(startupDelayMilliseconds) || startupDelayMilliseconds < 0 || startupDelayMilliseconds > 10000) {
    fail('PROCESS_OWNER_CONFIG_INVALID', 'Windows Job startupDelayMilliseconds must be bounded')
  }
  if (typeof options.controlRoot !== 'string' || !path.isAbsolute(options.controlRoot)) {
    fail('PROVIDER_UNSUPPORTED', 'Windows Job Object adapter requires an absolute private controlRoot')
  }
  const controlRoot = path.resolve(options.controlRoot)
  if (options.providerPrivateOwnershipRoot !== undefined &&
      (typeof options.providerPrivateOwnershipRoot !== 'string' || !path.isAbsolute(options.providerPrivateOwnershipRoot))) {
    fail('PROVIDER_UNSUPPORTED', 'Windows Job providerPrivateOwnershipRoot must be an absolute protected root')
  }
  const providerPrivateOwnershipRoot = options.providerPrivateOwnershipRoot === undefined
    ? null
    : path.resolve(options.providerPrivateOwnershipRoot)
  if (providerPrivateOwnershipRoot) {
    const protectedRoot = inspectPathNoFollow(providerPrivateOwnershipRoot)
    if (!protectedRoot.exists || !pathIsInside(providerPrivateOwnershipRoot, controlRoot)) {
      fail('PROVIDER_UNSUPPORTED', 'Windows Job controlRoot must be contained by providerPrivateOwnershipRoot')
    }
    if (fsImpl === fs) auditPrivatePermissions(providerPrivateOwnershipRoot, { recurse: false })
  }
  const trustedOwnershipRoots = (options.trustedOwnershipRoots || [providerPrivateOwnershipRoot || controlRoot]).map((entry) => {
    if (typeof entry !== 'string' || !path.isAbsolute(entry)) {
      fail('PROVIDER_UNSUPPORTED', 'Windows Job trusted ownership roots must be absolute')
    }
    const resolved = path.resolve(entry)
    if (providerPrivateOwnershipRoot && !pathIsInside(providerPrivateOwnershipRoot, resolved)) {
      fail('PROVIDER_UNSUPPORTED', 'Windows Job trusted ownership root escapes providerPrivateOwnershipRoot')
    }
    return resolved
  })
  fsImpl.mkdirSync(controlRoot, { recursive: true, mode: 0o700 })
  if (fsImpl === fs) {
    ensureWindowsPrivateAcl(controlRoot)
    auditPrivatePermissions(controlRoot, { recurse: false })
  }
  const helperHash = sha256(WINDOWS_JOB_HELPER)
  const helperPath = path.join(controlRoot, `job-helper-${helperHash}.ps1`)
  if (!fsImpl.existsSync(helperPath) || sha256(fsImpl.readFileSync(helperPath)) !== helperHash) {
    atomicWriteFile(helperPath, WINDOWS_JOB_HELPER, { fsImpl, mode: 0o600 })
  }
  const directoryForReservation = (reservationId) => path.join(controlRoot, sha256(reservationId))
  const controlRootHash = sha256(controlRoot.toLowerCase())
  const encodedControlRoot = Buffer.from(controlRoot, 'utf8').toString('base64url')
  const persistentIdentity = (reservationId) =>
    `windows-job:v2:${sha256(reservationId)}:${controlRootHash}:${encodedControlRoot}`
  const filesForDirectory = (directory, groupIdentity) => {
    return {
      directory,
      requestPath: path.join(directory, 'request.json'),
      statusPath: path.join(directory, 'status.json'),
      killPath: path.join(directory, 'terminate'),
      stderrPath: path.join(directory, 'helper.stderr.log'),
      launcherPath: path.join(directory, 'launcher.json'),
      groupIdentity,
    }
  }
  const filesForReservation = (reservationId) =>
    filesForDirectory(directoryForReservation(reservationId), persistentIdentity(reservationId))
  const readStatus = (statusPath) => {
    if (!fsImpl.existsSync(statusPath)) return null
    let item
    try { item = fsImpl.lstatSync(statusPath) } catch (error) {
      if (error && ['ENOENT', 'EBUSY'].includes(error.code)) return null
      throw error
    }
    if (!item.isFile() || item.isSymbolicLink() || Number(item.nlink) !== 1) {
      fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job status is not one physical control record')
    }
    try { return JSON.parse(fsImpl.readFileSync(statusPath, 'utf8')) } catch (error) {
      if (!error || ['ENOENT', 'EBUSY'].includes(error.code) || error instanceof SyntaxError) return null
      throw error
    }
  }
  const readStatusReliably = async (statusPath) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = readStatus(statusPath)
      if (status) return status
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return null
  }
  const processAlive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false
    try { process.kill(pid, 0); return true } catch (error) { return Boolean(error && error.code === 'EPERM') }
  }
  const liveStatusIdentities = (status) => selectWindowsLiveStatusPids(status, processAlive)
  const reservationFromIdentity = (identity) => {
    const legacy = /^windows-job:([a-f0-9]{64})$/.exec(identity)
    if (legacy) return path.join(controlRoot, legacy[1])
    const persistent = /^windows-job:v2:([a-f0-9]{64}):([a-f0-9]{64}):([A-Za-z0-9_-]+)$/.exec(identity)
    if (!persistent) fail('PROCESS_IDENTITY_INVALID', `invalid Windows Job identity: ${identity}`)
    let origin
    try { origin = Buffer.from(persistent[3], 'base64url').toString('utf8') } catch {}
    if (!origin || Buffer.from(origin, 'utf8').toString('base64url') !== persistent[3] || !path.isAbsolute(origin)) {
      fail('PROCESS_IDENTITY_INVALID', 'Windows Job identity has an invalid origin')
    }
    origin = path.resolve(origin)
    if (sha256(origin.toLowerCase()) !== persistent[2]) {
      fail('PROCESS_IDENTITY_INVALID', 'Windows Job identity origin hash is invalid')
    }
    if (!trustedOwnershipRoots.some((root) => origin === root || pathIsInside(root, origin))) {
      fail('PROCESS_IDENTITY_INVALID', 'Windows Job identity origin is outside the configured private ownership roots')
    }
    const item = fsImpl.lstatSync(origin)
    if (!item.isDirectory() || item.isSymbolicLink()) {
      fail('PROCESS_IDENTITY_INVALID', 'Windows Job identity origin is not a physical directory')
    }
    if (fsImpl === fs) auditPrivatePermissions(origin, { recurse: false })
    return path.join(origin, persistent[1])
  }
  const readRequestRecord = (directory) => {
    const directoryItem = fsImpl.lstatSync(directory)
    if (!directoryItem.isDirectory() || directoryItem.isSymbolicLink()) {
      fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job reservation directory is not physical')
    }
    const requestPath = path.join(directory, 'request.json')
    const requestItem = fsImpl.lstatSync(requestPath)
    if (!requestItem.isFile() || requestItem.isSymbolicLink() || Number(requestItem.nlink) !== 1) {
      fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job immutable request is not one physical control record')
    }
    let request
    try { request = readChecksummedJson(requestPath, { fsImpl }) } catch (error) {
      fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job immutable request record is missing or corrupt', { cause: error.message })
    }
    if (!request || request.schemaVersion !== 1 || typeof request.reservationId !== 'string' ||
        sha256(request.reservationId) !== path.basename(directory)) {
      fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job immutable request does not bind its hashed reservation directory')
    }
    return request
  }
  const validateControlRecord = (directory, status) => {
    const request = readRequestRecord(directory)
    if (status.reservationId !== request.reservationId || status.reservationIdentity !== request.reservationIdentity ||
        status.requestChecksum !== request.checksum) {
      fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job status does not bind its exact immutable request record')
    }
    return request
  }
  const reservationBindingFor = ({ reservationId, reservationIdentity, startupDeadlineAt, targetKey }) => canonicalize({
    schemaVersion: 1,
    adapterKind: 'windows-job-object',
    reservationId,
    reservationIdentity,
    controlRoot,
    controlRootHash,
    startupDeadlineAt,
    targetKey,
  })
  const validateReservationBinding = (binding, input) => {
    if (!binding || binding.schemaVersion !== 1 || binding.adapterKind !== 'windows-job-object' ||
        binding.reservationId !== input.reservationId || binding.reservationIdentity !== input.reservationIdentity ||
        binding.startupDeadlineAt !== input.startupDeadlineAt || binding.targetKey !== input.targetKey ||
        typeof binding.controlRoot !== 'string' || !path.isAbsolute(binding.controlRoot) ||
        binding.controlRootHash !== sha256(path.resolve(binding.controlRoot).toLowerCase())) {
      fail('PROCESS_IDENTITY_INVALID', 'Windows Job durable reservation binding is foreign or incomplete')
    }
    const boundDirectory = reservationFromIdentity(binding.reservationIdentity)
    if (path.dirname(boundDirectory) !== path.resolve(binding.controlRoot) ||
        path.basename(boundDirectory) !== sha256(binding.reservationId)) {
      fail('PROCESS_IDENTITY_INVALID', 'Windows Job reservation binding does not resolve to its exact origin control record')
    }
    return canonicalize(binding)
  }
  const adapter = {
    kind: 'windows-job-object',
    // Windows PowerShell cold-starts and compiles the native Job bridge before
    // it can create the suspended child. Keep that platform preparation inside
    // one explicit durable deadline rather than a shorter hidden adapter timer.
    startupTimeoutMs: 30000,
    capabilities: Object.fromEntries(REQUIRED_PROCESS_CAPABILITIES.map((field) => [field, true])),
    reservationIdentity(reservationId) { return persistentIdentity(reservationId) },
    prepareReservation(input) { return reservationBindingFor(input) },
    validateReservationBinding(record) {
      return validateReservationBinding(record.reservationBinding, {
        reservationId: record.reservationId,
        reservationIdentity: record.reservationIdentity,
        startupDeadlineAt: record.startupDeadlineAt,
        targetKey: record.targetKey,
      })
    },
    async probeReservation(record) {
      const binding = validateReservationBinding(record.reservationBinding, {
        reservationId: record.reservationId,
        reservationIdentity: record.reservationIdentity,
        startupDeadlineAt: record.startupDeadlineAt,
        targetKey: record.targetKey,
      })
      const files = filesForDirectory(
        reservationFromIdentity(record.reservationIdentity),
        record.reservationIdentity,
      )
      if (!fsImpl.existsSync(files.directory)) {
        return wallNowMs() < Date.parse(record.startupDeadlineAt)
          ? { state: 'PENDING', evidence: { reason: 'control-directory-publication-pending', bindingHash: sha256(stableStringify(binding)) } }
          : { state: 'DEAD', evidence: { reason: 'control-directory-never-created-before-deadline', bindingHash: sha256(stableStringify(binding)) } }
      }
      const status = readStatus(files.statusPath)
      if (status) {
        validateControlRecord(files.directory, status)
        const livePids = liveStatusIdentities(status)
        const helperAlive = processAlive(status.helperPid)
        if (status.assigned === true && status.ready === true && Number.isSafeInteger(status.rootPid) && livePids.length && helperAlive) {
          return {
            state: 'LIVE',
            ownership: { rootPid: status.rootPid, groupIdentity: files.groupIdentity, helperPid: status.helperPid },
          }
        }
        if (!livePids.length && !helperAlive && ['EXITED', 'FAILED'].includes(status.status)) {
          return { state: 'DEAD', evidence: { reason: `status-${String(status.status).toLowerCase()}`, helperPid: status.helperPid } }
        }
        if (wallNowMs() < Date.parse(record.startupDeadlineAt)) {
          return { state: 'PENDING', evidence: { reason: 'status-not-ready', helperPid: status.helperPid, livePids } }
        }
        return { state: 'UNKNOWN', evidence: { reason: 'status-inconclusive-after-deadline', helperPid: status.helperPid, livePids } }
      }
      let launcher = null
      if (fsImpl.existsSync(files.launcherPath)) {
        try { launcher = readChecksummedJson(files.launcherPath, { fsImpl }) } catch (error) {
          return { state: 'UNKNOWN', evidence: { reason: 'launcher-corrupt', cause: error.message } }
        }
        if (!launcher || launcher.schemaVersion !== 1 || launcher.reservationId !== record.reservationId ||
            launcher.reservationIdentity !== record.reservationIdentity ||
            launcher.reservationBindingHash !== sha256(stableStringify(binding)) ||
            launcher.startupDeadlineAt !== record.startupDeadlineAt ||
            !Number.isSafeInteger(launcher.helperPid) || launcher.helperPid < 1) {
          return { state: 'UNKNOWN', evidence: { reason: 'launcher-foreign' } }
        }
        if (!processAlive(launcher.helperPid) && wallNowMs() >= Date.parse(record.startupDeadlineAt)) {
          return { state: 'DEAD', evidence: { reason: 'launcher-dead-after-deadline', helperPid: launcher.helperPid } }
        }
      }
      if (wallNowMs() < Date.parse(record.startupDeadlineAt)) {
        return { state: 'PENDING', evidence: { reason: launcher ? 'helper-starting' : 'launch-publication-pending', helperPid: launcher && launcher.helperPid } }
      }
      return { state: 'UNKNOWN', evidence: { reason: launcher ? 'live-helper-without-status' : 'unpublished-helper-cannot-be-excluded' } }
    },
    async probeOwnedIdentity(identity) {
      if (!identity || ![adapter.kind, `${adapter.kind}-reservation`].includes(identity.kind)) {
        fail('PROCESS_IDENTITY_INVALID', 'Windows Job adapter cannot verify the requested identity kind')
      }
      const directory = reservationFromIdentity(identity.id)
      if (!fsImpl.existsSync(directory)) {
        fail('OWNERSHIP_RECOVERY_FATAL', 'origin-bound Windows Job control directory is missing')
      }
      const status = await readStatusReliably(path.join(directory, 'status.json'))
      if (status) {
        validateControlRecord(directory, status)
        return liveStatusIdentities(status)
      }
      if (identity.kind === adapter.kind) {
        fail('OWNERSHIP_RECOVERY_PENDING', 'persisted Windows Job group has no conclusive status record')
      }
      const request = readRequestRecord(directory)
      const record = {
        reservationId: request.reservationId,
        reservationIdentity: request.reservationIdentity,
        startupDeadlineAt: request.startupDeadlineAt,
        targetKey: request.targetKey,
      }
      record.reservationBinding = request.reservationBinding
      if (request.reservationBindingHash !== sha256(stableStringify(record.reservationBinding))) {
        fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job request changed its durable reservation binding')
      }
      const probe = await adapter.probeReservation(record)
      if (probe.state === 'DEAD') return []
      if (probe.state === 'LIVE') return adapter.listOwned(probe.ownership.groupIdentity)
      fail(probe.state === 'PENDING' ? 'OWNERSHIP_RECOVERY_PENDING' : 'OWNERSHIP_RECOVERY_FATAL',
        'origin-bound Windows Job reservation remains pending or unknown', { evidence: probe.evidence || null })
    },
    async recoverReservationIdentity(identity) {
      const directory = reservationFromIdentity(identity)
      const status = await readStatusReliably(path.join(directory, 'status.json'))
      if (!status) return null
      validateControlRecord(directory, status)
      if (path.basename(directory) !== sha256(status.reservationId || '') || status.assigned !== true) {
        fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job persistent reservation identity is foreign or unassigned')
      }
      const live = liveStatusIdentities(status)
      if (!processAlive(status.helperPid)) {
        if (live.length) fail('PROCESS_ASSIGNMENT_ESCAPED', 'Job helper exited while alleged members remained live')
        return null
      }
      if (!live.length) return null
      return { rootPid: status.rootPid, groupIdentity: identity, helperPid: status.helperPid }
    },
    async admit() {
      try {
        execFileSync(powershellPath, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 126 }",
        ], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
          env: process.env,
        })
        return { supported: true }
      } catch (error) {
        return { supported: false, reason: `Windows Job Object helper probe failed: ${error.message}` }
      }
    },
    async spawnOwned(spec) {
      const reservationBinding = validateReservationBinding(spec.reservationBinding, {
        reservationId: spec.reservationId,
        reservationIdentity: spec.reservationIdentity,
        startupDeadlineAt: spec.startupDeadlineAt,
        targetKey: spec.targetKey,
      })
      const files = filesForReservation(spec.reservationId)
      fsImpl.mkdirSync(files.directory, { recursive: true, mode: 0o700 })
      atomicWriteJson(files.requestPath, {
        schemaVersion: 1,
        reservationId: spec.reservationId,
        reservationIdentity: spec.reservationIdentity,
        reservationBindingHash: sha256(stableStringify(reservationBinding)),
        reservationBinding,
        startupDeadlineAt: spec.startupDeadlineAt,
        startupDelayMilliseconds,
        targetKey: spec.targetKey,
        executable: spec.executable,
        argv: spec.argv,
        cwd: spec.cwd || process.cwd(),
        // The helper has its own inherited control environment. The owned
        // child receives exactly the caller-authorized map and no ambient
        // supervisor variables.
        environment: { ...(spec.env || {}) },
      }, { fsImpl })
      try { fsImpl.unlinkSync(files.killPath) } catch {}
      const diagnosticDescriptor = fsImpl.openSync(files.stderrPath, 'a', 0o600)
      let helper
      try {
        helper = spawn(powershellPath, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', helperPath,
        ], {
          windowsHide: true,
          // Windows processes are independently owned after creation; keeping
          // this false avoids Node's detached-console launch losing -File on
          // legacy Windows PowerShell while unref still releases the JS loop.
          detached: false,
          stdio: ['ignore', 'ignore', diagnosticDescriptor],
          env: {
            ...process.env,
            AUTOPROMPT_JOB_REQUEST: files.requestPath,
            AUTOPROMPT_JOB_STATUS: files.statusPath,
            AUTOPROMPT_JOB_KILL: files.killPath,
          },
        })
      } finally {
        fsImpl.closeSync(diagnosticDescriptor)
      }
      if (!helper || !Number.isSafeInteger(helper.pid) || helper.pid < 1) {
        fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job helper launch returned no stable helper identity')
      }
      atomicWriteJson(files.launcherPath, {
        schemaVersion: 1,
        reservationId: spec.reservationId,
        reservationIdentity: spec.reservationIdentity,
        reservationBindingHash: sha256(stableStringify(reservationBinding)),
        startupDeadlineAt: spec.startupDeadlineAt,
        helperPid: helper.pid,
      }, { fsImpl })
      let helperError = null
      let helperExit = null
      helper.once('error', (error) => { helperError = error })
      helper.once('exit', (code, signal) => { helperExit = { code, signal } })
      helper.unref()
      const startupDeadlineMs = Date.parse(spec.startupDeadlineAt)
      const startupBudgetMs = startupDeadlineMs - wallNowMs()
      if (!Number.isFinite(startupDeadlineMs) || !Number.isFinite(startupBudgetMs) || startupBudgetMs <= 0) {
        fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job startup deadline expired before helper launch')
      }
      const started = monotonicMs()
      while (true) {
        const status = readStatus(files.statusPath)
        if (status && status.ready === true && status.assigned === true && Number.isSafeInteger(status.rootPid)) {
          return { rootPid: status.rootPid, groupIdentity: files.groupIdentity, helperPid: status.helperPid }
        }
        if (status && status.status === 'FAILED') {
          fail('PROCESS_ASSIGNMENT_ESCAPED', `Windows Job assignment failed before resume: ${status.error}`)
        }
        if (helperError || helperExit) {
          const diagnostic = fsImpl.existsSync(files.stderrPath)
            ? fsImpl.readFileSync(files.stderrPath, 'utf8').slice(-8192)
            : ''
          fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job helper exited before proving suspended assignment', {
            cause: helperError && helperError.message,
            exit: helperExit,
            diagnostic,
          })
        }
        // Always observe status once before enforcing the local polling
        // deadline. Synchronous Windows work (notably an ACL audit in a
        // sibling adapter construction) can stall this event loop while the
        // helper independently assigns the suspended child and publishes its
        // READY record. Rejecting solely from elapsed time would discard that
        // completed proof without reading it.
        if (monotonicMs() - started >= startupBudgetMs) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const diagnostic = fsImpl.existsSync(files.stderrPath)
        ? fsImpl.readFileSync(files.stderrPath, 'utf8').slice(-8192)
        : ''
      fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job helper did not prove suspended assignment before timeout', {
        diagnostic,
      })
    },
    async recoverReservation(reservationId) {
      const files = filesForReservation(reservationId)
      const status = await readStatusReliably(files.statusPath)
      if (!status) return null
      validateControlRecord(files.directory, status)
      if (status.reservationId !== reservationId || status.assigned !== true) {
        fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job reservation status is foreign or unassigned')
      }
      const live = liveStatusIdentities(status)
      if (!processAlive(status.helperPid)) {
        if (live.length) fail('PROCESS_ASSIGNMENT_ESCAPED', 'Job helper exited while alleged members remained live')
        return null
      }
      if (!live.length) return null
      return { rootPid: status.rootPid, groupIdentity: files.groupIdentity, helperPid: status.helperPid }
    },
    async listOwned(identity) {
      const directory = reservationFromIdentity(identity)
      const status = await readStatusReliably(path.join(directory, 'status.json'))
      if (!status) fail('PROCESS_ASSIGNMENT_ESCAPED', 'Windows Job control record is missing for a persisted identity')
      validateControlRecord(directory, status)
      return liveStatusIdentities(status)
    },
    async signalOwned(identity) {
      const directory = reservationFromIdentity(identity)
      const killPath = path.join(directory, 'terminate')
      try { fsImpl.writeFileSync(killPath, 'terminate\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }) } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
      }
    },
    async verifyOwnership({ rootPid, groupIdentity }) {
      const directory = reservationFromIdentity(groupIdentity)
      const status = await readStatusReliably(path.join(directory, 'status.json'))
      if (status) validateControlRecord(directory, status)
      return Boolean(status && status.assigned === true && status.ready === true && status.rootPid === rootPid &&
        processAlive(status.helperPid))
    },
    async listTargetOwned(targetKey, records) {
      const live = []
      const seen = new Set()
      for (const record of records.filter(entry => entry.targetKey === targetKey)) {
        let identity = typeof record.groupIdentity === 'string' && record.groupIdentity
          ? record.groupIdentity : null
        if (!identity && record.status === 'RESERVED') {
          const probe = await adapter.probeReservation(record)
          if (probe.state === 'LIVE') identity = probe.ownership.groupIdentity
        }
        if (!identity || seen.has(identity)) continue
        seen.add(identity)
        live.push(...await adapter.listOwned(identity))
      }
      return live
    },
  }
  return adapter
}

async function runOwnedProcessConformanceProbe(options = {}) {
  const adapter = options.adapter
  const processOwner = options.processOwner
  const targetKey = options.targetKey
  const targetPath = options.targetPath
  const environment = options.environment
  if (!adapter || !processOwner || typeof processOwner.launch !== 'function' ||
      typeof targetKey !== 'string' || !targetKey ||
      typeof targetPath !== 'string' || !path.isAbsolute(targetPath) ||
      !environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('PROCESS_OWNER_CONFIG_INVALID',
      'owned process conformance requires an adapter, owner, target, and exact environment')
  }
  const reservationId = options.reservationId || crypto.randomUUID()
  const exactEnvironment = prepareProcessLaunchEnvironment(adapter, reservationId, environment)
  // ProcessOwner.launch performs the bounded adapter admission itself. Avoid a
  // second unbounded provider call before the durable reservation exists.
  const launched = await processOwner.launch({
    executable: process.execPath,
    argv: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: targetPath,
    env: exactEnvironment,
    shell: false,
    sessionId: options.sessionId || `process-conformance:${reservationId}`,
    reservationId,
    targetKey,
    forWork: false,
  })
  let drained = false
  try {
    await processOwner.cancelGroup(launched.ownershipId, {
      reason: options.reason || 'owned process conformance probe',
      graceMs: 0,
      killMs: options.killMs === undefined ? 1000 : options.killMs,
      terminalStatus: 'DONE',
    })
    await processOwner.assertTargetDrained(targetKey)
    drained = true
  } finally {
    if (!drained) {
      try {
        await processOwner.cancelAll({
          reason: 'owned process conformance cleanup',
          graceMs: 0,
          killMs: options.killMs === undefined ? 1000 : options.killMs,
          terminalStatus: 'FAILED',
        })
      } catch {}
    }
  }
  const terminal = processOwner.listRecords().find(record =>
    record.ownershipId === launched.ownershipId)
  if (!terminal || terminal.status !== 'DONE' || terminal.targetKey !== targetKey ||
      terminal.groupIdentity !== launched.groupIdentity) {
    fail('PROCESS_DRAIN_TIMEOUT',
      'owned process conformance did not publish one exact drained terminal identity')
  }
  const body = canonicalize({
    schemaVersion: 1,
    kind: 'owned-process-conformance',
    adapterKind: adapter.kind,
    targetKey,
    ownershipId: launched.ownershipId,
    groupIdentity: launched.groupIdentity,
    terminalStatus: terminal.status,
    drained: true,
  })
  return Object.freeze({ ...body, probeHash: sha256(stableStringify(body)) })
}

module.exports = {
  REQUIRED_PROCESS_ADAPTER_METHODS,
  REQUIRED_PROCESS_CAPABILITIES,
  POSIX_RESERVATION_ENV,
  ProcessOwner,
  ProcessOwnerError,
  PROCESS_REGISTRY_SCHEMA_VERSION,
  createPosixProcessAdapter,
  createWindowsJobAdapter,
  getProcessAdapterContract: () => ({
    methods: [...REQUIRED_PROCESS_ADAPTER_METHODS],
    capabilities: [...REQUIRED_PROCESS_CAPABILITIES],
    launchFields: ['reservationId', 'ownershipId', 'executable', 'argv', 'targetKey'],
  }),
  processLaunchControlEnvironment,
  runOwnedProcessConformanceProbe,
  normalizeWindowsChildEnvironment,
  selectWindowsLiveStatusPids,
  prepareProcessLaunchEnvironment,
  validateAdapter,
  verifyProcessAdapter: validateAdapter,
}
