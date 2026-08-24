#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { atomicWriteJson, fsyncDirectory, readChecksummedJson, sha256, stableStringify } = require('./event-log.js')
const { auditPrivatePermissions, ensureWindowsPrivateAcl } = require('./safe-run-root.js')

const LEASE_SCHEMA_VERSION = 3
const TOKEN_PATTERN = /^[a-f0-9]{32,64}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const MISSION_CAPABILITY_BINDING_FIELDS = Object.freeze([
  'runId', 'activationId', 'missionHash', 'nonce', 'generation', 'targetIdentity',
])
const TAKEOVER_RECEIPT_VERSION = 3
const PREDECESSOR_RELEASE_VERSION = 1
const QUARANTINE_NAME_VERSION = 1
const QUARANTINE_RETRY_LIMIT = 32

class MissionLockError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MissionLockError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new MissionLockError(code, message, details)
}

function comparable(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function physicalDirectoryIdentity(directory, fsImpl) {
  const resolved = path.resolve(directory)
  const item = fsImpl.lstatSync(resolved)
  if (!item.isDirectory() || item.isSymbolicLink()) fail('TARGET_UNSAFE', `target is not a physical directory: ${resolved}`)
  const real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(resolved) : fsImpl.realpathSync(resolved)
  const stat = fsImpl.statSync(real)
  const device = String(stat.dev)
  const fileId = String(stat.ino)
  const stablePhysicalId = (device !== 'undefined' && fileId !== 'undefined' &&
    !(device === '0' && fileId === '0')) ? `${device}:${fileId}` : null
  if (!stablePhysicalId) {
    fail('TARGET_IDENTITY_UNSUPPORTED', `filesystem cannot provide a stable physical directory identity: ${resolved}`)
  }
  return {
    path: comparable(real),
    identity: stablePhysicalId,
    stablePhysicalId,
  }
}

function ledgerIdentity(ledgerPath, fsImpl) {
  const resolved = path.resolve(ledgerPath)
  if (fsImpl.existsSync(resolved)) {
    const item = fsImpl.lstatSync(resolved)
    if (!item.isDirectory() || item.isSymbolicLink()) fail('TARGET_UNSAFE', `ledger is not a physical directory: ${resolved}`)
    return physicalDirectoryIdentity(resolved, fsImpl)
  }
  const parent = physicalDirectoryIdentity(path.dirname(resolved), fsImpl)
  return { path: comparable(resolved), identity: `${parent.identity}:new:${path.basename(resolved)}` }
}

function processIdentityForPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('PROCESS_IDENTITY_INVALID', 'process identity requires a positive pid')
  if (process.platform === 'win32') {
    const script = [
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      "if ($null -eq $p) { Write-Output 'null'; exit 0 }",
      "$record=[ordered]@{pid=[int]$p.Id;startTicks=[string]$p.StartTime.ToUniversalTime().Ticks;path=[string]$p.Path}",
      '$record | ConvertTo-Json -Compress',
    ].join(';')
    let output
    try {
      output = childProcess.execFileSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()
    } catch (error) {
      try { process.kill(pid, 0) } catch (probeError) {
        if (probeError && probeError.code === 'ESRCH') return null
      }
      return undefined
    }
    if (output === 'null' || output === '') return null
    let observed
    try { observed = JSON.parse(output) } catch { return undefined }
    if (observed.pid !== pid || typeof observed.startTicks !== 'string' || !/^\d+$/.test(observed.startTicks) ||
        typeof observed.path !== 'string' || !observed.path) return undefined
    return `windows-process-v1:${pid}:${observed.startTicks}:${sha256(comparable(observed.path))}`
  }
  const procRoot = `/proc/${pid}`
  try {
    const stat = fs.readFileSync(path.join(procRoot, 'stat'), 'utf8')
    const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    const startTicks = afterCommand[19]
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase()
    const executable = fs.realpathSync(path.join(procRoot, 'exe'))
    if (!/^\d+$/.test(startTicks || '') || !/^[a-f0-9-]{36}$/.test(bootId)) return undefined
    return `posix-process-v1:${pid}:${bootId}:${startTicks}:${sha256(comparable(executable))}`
  } catch (error) {
    if (error && error.code === 'ESRCH') return null
    if (error && error.code === 'ENOENT' && fs.existsSync('/proc/self/stat')) return null
    try { process.kill(pid, 0) } catch (probeError) {
      if (probeError && probeError.code === 'ESRCH') return null
    }
    return undefined
  }
}

function rootProcessEvidence(owner, observer = processIdentityForPid) {
  let observed
  try { observed = observer(owner.pid) } catch { observed = undefined }
  const status = observed === null ? 'DEAD'
    : typeof observed !== 'string' ? 'UNKNOWN'
      : observed === owner.processIdentity ? 'LIVE' : 'PID_REUSED'
  const evidence = {
    pid: owner.pid,
    expectedProcessIdentity: owner.processIdentity,
    observedProcessIdentity: typeof observed === 'string' ? observed : null,
    status,
    evidenceHash: '0'.repeat(64),
  }
  const unsigned = { ...evidence }
  delete unsigned.evidenceHash
  evidence.evidenceHash = sha256(stableStringify(unsigned))
  return Object.freeze(evidence)
}

function validateRootProcessEvidence(evidence, owner) {
  const fields = ['pid', 'expectedProcessIdentity', 'observedProcessIdentity', 'status', 'evidenceHash']
  if (!evidence || Object.keys(evidence).length !== fields.length || fields.some((field) => !Object.hasOwn(evidence, field)) ||
      evidence.pid !== owner.pid || evidence.expectedProcessIdentity !== owner.processIdentity ||
      !['LIVE', 'DEAD', 'PID_REUSED', 'UNKNOWN'].includes(evidence.status) ||
      !(evidence.observedProcessIdentity === null ||
        (typeof evidence.observedProcessIdentity === 'string' && evidence.observedProcessIdentity)) ||
      !HASH_PATTERN.test(evidence.evidenceHash || '')) return false
  const unsigned = { ...evidence }
  delete unsigned.evidenceHash
  if (evidence.evidenceHash !== sha256(stableStringify(unsigned))) return false
  if (evidence.status === 'LIVE') return evidence.observedProcessIdentity === owner.processIdentity
  if (evidence.status === 'PID_REUSED') return typeof evidence.observedProcessIdentity === 'string' &&
    evidence.observedProcessIdentity !== owner.processIdentity
  return evidence.observedProcessIdentity === null
}

function defaultIdentityProbe(owner) {
  if (owner.ownedProcessIdentities && owner.ownedProcessIdentities.length) {
    return { alive: true, verified: false, reason: 'descendant-liveness-adapter-required' }
  }
  if (owner.hostname !== os.hostname()) return { alive: true, verified: false, reason: 'foreign-host' }
  try {
    process.kill(owner.pid, 0)
    return { alive: true, verified: true, processIdentity: null }
  } catch (error) {
    if (error && error.code === 'ESRCH') return { alive: false, verified: true }
    return { alive: true, verified: false, reason: error && error.code }
  }
}

function validateOwner(owner) {
  if (!owner || owner.schemaVersion !== LEASE_SCHEMA_VERSION ||
      typeof owner.leaseId !== 'string' || !owner.leaseId ||
      !TOKEN_PATTERN.test(owner.token || '') || !HASH_PATTERN.test(owner.targetKey || '') ||
      typeof owner.runId !== 'string' || !owner.runId ||
      typeof owner.activationId !== 'string' || !owner.activationId ||
      !HASH_PATTERN.test(owner.missionHash || '') ||
      typeof owner.nonce !== 'string' || !owner.nonce ||
      !Number.isSafeInteger(owner.generation) || owner.generation < 1 ||
      !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      typeof owner.processIdentity !== 'string' || !owner.processIdentity ||
      typeof owner.hostname !== 'string' || !owner.hostname ||
      !Array.isArray(owner.ownedProcessIdentities) ||
      owner.ownedProcessIdentities.some((entry) => !entry || typeof entry.id !== 'string' || !entry.id ||
        typeof entry.kind !== 'string' || !entry.kind) ||
      new Set(owner.ownedProcessIdentities.map(identityKey)).size !== owner.ownedProcessIdentities.length ||
      !Array.isArray(owner.ownedProcessHistory) ||
      owner.ownedProcessHistory.some((entry) => !entry || typeof entry.id !== 'string' || !entry.id ||
        typeof entry.kind !== 'string' || !entry.kind) ||
      new Set(owner.ownedProcessHistory.map(identityKey)).size !== owner.ownedProcessHistory.length ||
      typeof owner.acquiredAt !== 'string' || typeof owner.heartbeatAt !== 'string') {
    fail('LEASE_UNVERIFIABLE', 'lease owner record is invalid')
  }
  return owner
}

function takeoverReceiptHash(receipt) {
  const unsigned = { ...receipt }
  delete unsigned.receiptHash
  return sha256(stableStringify(unsigned))
}

function quarantineBindingHash(owner) {
  return sha256(stableStringify({
    schemaVersion: QUARANTINE_NAME_VERSION,
    targetKey: owner.targetKey,
    leaseId: owner.leaseId,
    priorOwnerChecksum: owner.checksum,
    activationId: owner.activationId,
    nonce: owner.nonce,
    generation: owner.generation,
  }))
}

function quarantineLeaseLabel(leaseId) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(leaseId) ? leaseId : sha256(leaseId).slice(0, 32)
}

function identityKey(identity) {
  return `${identity.kind}\0${identity.id}`
}

function validateOwnedIdentityEvidence(evidence, persisted) {
  if (!Array.isArray(evidence) || evidence.length !== persisted.length) return false
  const expected = new Map(persisted.map((entry) => [identityKey(entry), entry]))
  if (expected.size !== persisted.length) return false
  const observed = new Set()
  for (const entry of evidence) {
    if (!entry || typeof entry.kind !== 'string' || !entry.kind ||
        typeof entry.id !== 'string' || !entry.id || entry.verified !== true ||
        typeof entry.alive !== 'boolean' || !HASH_PATTERN.test(entry.adapterEvidenceHash || '')) return false
    const key = identityKey(entry)
    if (!expected.has(key) || observed.has(key)) return false
    observed.add(key)
  }
  return observed.size === expected.size
}

function validateTakeoverReceipt(receipt) {
  if (receipt === null || receipt === undefined) return null
  if (!receipt || receipt.schemaVersion !== TAKEOVER_RECEIPT_VERSION ||
      typeof receipt.priorLeaseId !== 'string' || !receipt.priorLeaseId ||
      !HASH_PATTERN.test(receipt.priorOwnerChecksum || '') ||
      !Number.isSafeInteger(receipt.priorOwnerPid) || receipt.priorOwnerPid < 1 ||
      typeof receipt.priorProcessIdentity !== 'string' || !receipt.priorProcessIdentity ||
      typeof receipt.runId !== 'string' || !receipt.runId ||
      typeof receipt.activationId !== 'string' || !receipt.activationId ||
      !HASH_PATTERN.test(receipt.missionHash || '') || typeof receipt.nonce !== 'string' || !receipt.nonce ||
      !Number.isSafeInteger(receipt.generation) || receipt.generation < 1 ||
      !HASH_PATTERN.test(receipt.targetIdentity || '') ||
      !Array.isArray(receipt.persistedOwnedProcessIdentities) ||
      receipt.persistedOwnedProcessIdentities.some((entry) => !entry || typeof entry.id !== 'string' || !entry.id ||
        typeof entry.kind !== 'string' || !entry.kind) ||
      !validateOwnedIdentityEvidence(receipt.ownedIdentityEvidence, receipt.persistedOwnedProcessIdentities) ||
      receipt.ownedIdentityEvidence.some((entry) => entry.alive !== false) ||
      !validateRootProcessEvidence(receipt.ownerProcessEvidence, {
        pid: receipt.priorOwnerPid,
        processIdentity: receipt.priorProcessIdentity,
      }) || !['DEAD', 'PID_REUSED'].includes(receipt.ownerProcessEvidence.status) ||
      receipt.ownerProcessVerifiedDead !== true || receipt.descendantsVerifiedDrained !== true ||
      typeof receipt.quarantineName !== 'string' || !receipt.quarantineName ||
      Number.isNaN(Date.parse(receipt.verifiedAt)) || !HASH_PATTERN.test(receipt.receiptHash || '') ||
      receipt.receiptHash !== takeoverReceiptHash(receipt)) {
    fail('LEASE_UNVERIFIABLE', 'stale-owner takeover receipt is invalid')
  }
  return receipt
}

function predecessorReleaseHash(receipt) {
  const unsigned = { ...receipt }
  delete unsigned.receiptHash
  delete unsigned.checksum
  return sha256(stableStringify(unsigned))
}

function validatePredecessorRelease(receipt) {
  if (receipt === null || receipt === undefined) return null
  if (!receipt || receipt.schemaVersion !== PREDECESSOR_RELEASE_VERSION ||
      typeof receipt.priorLeaseId !== 'string' || !receipt.priorLeaseId ||
      !HASH_PATTERN.test(receipt.priorOwnerChecksum || '') ||
      typeof receipt.runId !== 'string' || !receipt.runId ||
      typeof receipt.activationId !== 'string' || !receipt.activationId ||
      !HASH_PATTERN.test(receipt.missionHash || '') || typeof receipt.nonce !== 'string' || !receipt.nonce ||
      !Number.isSafeInteger(receipt.generation) || receipt.generation < 1 ||
      !HASH_PATTERN.test(receipt.targetIdentity || '') || !HASH_PATTERN.test(receipt.releaseIntentHash || '') ||
      !HASH_PATTERN.test(receipt.stateChecksum || '') || !Number.isSafeInteger(receipt.stateEventSequence) ||
      receipt.stateEventSequence < 1 || !HASH_PATTERN.test(receipt.stateEventHash || '') ||
      !['DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED'].includes(receipt.outcome) ||
      !Array.isArray(receipt.persistedOwnedProcessIdentities) ||
      !validateOwnedIdentityEvidence(receipt.ownedIdentityEvidence, receipt.persistedOwnedProcessIdentities) ||
      receipt.ownedIdentityEvidence.some((entry) => entry.alive !== false) ||
      receipt.processesDrained !== true || Number.isNaN(Date.parse(receipt.releasedAt)) ||
      !HASH_PATTERN.test(receipt.receiptHash || '') || receipt.receiptHash !== predecessorReleaseHash(receipt)) {
    fail('LEASE_UNVERIFIABLE', 'predecessor release receipt is invalid')
  }
  return receipt
}

class MissionLock {
  constructor(options) {
    if (!options || typeof options.leaseRoot !== 'string' || !options.leaseRoot.trim() ||
        !path.isAbsolute(options.leaseRoot) || path.parse(options.leaseRoot).root === path.resolve(options.leaseRoot)) {
      fail('LEASE_CONFIG_INVALID', 'mission lock requires a non-root absolute private leaseRoot')
    }
    this.leaseRoot = path.resolve(options.leaseRoot)
    this.fs = options.fsImpl || fs
    this.clock = options.clock || (() => new Date().toISOString())
    this.identityProbe = options.identityProbe || defaultIdentityProbe
    this.processIdentityObserver = options.processIdentityObserver || processIdentityForPid
    this.hostname = options.hostname || os.hostname()
    this.randomToken = options.randomToken || (() => crypto.randomBytes(24).toString('hex'))
    this.randomId = options.randomId || (() => crypto.randomUUID())
    this.beforeCommit = options.beforeCommit
    this.capabilities = new WeakMap()
  }

  identify(targetPath, ledgerPath) {
    const target = physicalDirectoryIdentity(targetPath, this.fs)
    const ledger = ledgerIdentity(ledgerPath, this.fs)
    // The mutable workspace is the singleton. Ledger identity is audit metadata,
    // never part of the exclusion key.
    const keyBasis = { kind: 'physical-file-id', value: target.stablePhysicalId }
    const key = sha256(stableStringify(keyBasis))
    return { key, keyBasis, target, ledger }
  }

  leasePathFor(targetPath, ledgerPath) {
    return path.join(this.leaseRoot, `${this.identify(targetPath, ledgerPath).key}.lease`)
  }

  acquire(options) {
    if (!options) fail('LEASE_INPUT_INVALID', 'lease options are required')
    const identity = this.identify(options.targetPath, options.ledgerPath)
    const leasePath = path.join(this.leaseRoot, `${identity.key}.lease`)
    const ownerPath = path.join(leasePath, 'owner.json')
    const pid = options.pid === undefined ? process.pid : options.pid
    const token = options.token || this.randomToken()
    if (!Number.isSafeInteger(pid) || pid < 1 || !TOKEN_PATTERN.test(token) ||
        typeof options.processIdentity !== 'string' || !options.processIdentity ||
        typeof options.runId !== 'string' || !options.runId ||
        typeof options.activationId !== 'string' || !options.activationId ||
        !HASH_PATTERN.test(options.missionHash || '') ||
        typeof options.nonce !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/.test(options.nonce) ||
        !Number.isSafeInteger(options.generation) || options.generation < 1) {
      fail('LEASE_INPUT_INVALID', 'lease identity, activation, or process arguments are invalid')
    }
    const observedProcessIdentity = this.processIdentityObserver(pid, options.processIdentity)
    if (typeof observedProcessIdentity !== 'string' || observedProcessIdentity !== options.processIdentity) {
      fail('LEASE_INPUT_INVALID', 'lease processIdentity does not match the live operating-system process epoch', {
        pid,
        observedProcessIdentity: observedProcessIdentity || null,
      })
    }
    this.fs.mkdirSync(this.leaseRoot, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32' && this.fs === fs) {
      ensureWindowsPrivateAcl(this.leaseRoot)
      auditPrivatePermissions(this.leaseRoot, { recurse: false })
    }
    const leaseRootItem = this.fs.lstatSync(this.leaseRoot)
    if (!leaseRootItem.isDirectory() || leaseRootItem.isSymbolicLink()) {
      fail('TARGET_UNSAFE', `lease root is not a physical directory: ${this.leaseRoot}`)
    }
    let takeover = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.fs.mkdirSync(leasePath, { mode: 0o700 })
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
        const observed = this._readObserved(leasePath, ownerPath)
        if (!this._sameTargetIdentity(identity, observed.owner)) {
          fail('TARGET_KEY_COLLISION', 'target lease key is occupied by a different physical identity')
        }
        const status = this._probeOwner(observed.owner)
        if (!status.stale) {
          fail('WORKSPACE_LEASE_CONFLICT', `target is leased by run ${observed.owner.runId}`, {
            owner: observed.owner,
            probe: status || null,
          })
        }
        if (attempt > 0) fail('WORKSPACE_LEASE_CONFLICT', 'stale lease replacement raced with another owner')
        takeover = this._quarantineStale(leasePath, ownerPath, observed)
        continue
      }
      const timestamp = String(this.clock())
      let predecessorRelease = null
      try {
        predecessorRelease = takeover ? null : this._findPredecessorRelease(identity, options)
        if (!takeover && options.generation > 1 && !predecessorRelease) {
          fail('LEASE_PREDECESSOR_UNVERIFIABLE', 'a replacement generation requires exact takeover or predecessor-release proof')
        }
      } catch (error) {
        try { this.fs.rmdirSync(leasePath) } catch {}
        throw error
      }
      const owner = {
        schemaVersion: LEASE_SCHEMA_VERSION,
        leaseId: this.randomId(),
        token,
        targetKey: identity.key,
        target: identity.target,
        ledger: identity.ledger,
        runId: options.runId,
        activationId: options.activationId,
        missionHash: options.missionHash,
        nonce: options.nonce,
        generation: options.generation,
        pid,
        processIdentity: options.processIdentity,
        hostname: this.hostname,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        ownedProcessIdentities: [],
        ownedProcessHistory: [],
        takeover,
        predecessorRelease,
      }
      try {
        const signed = atomicWriteJson(ownerPath, owner, {
          fsImpl: this.fs,
          beforeCommit: this.beforeCommit,
        })
        const capability = Object.freeze({ type: 'MissionLeaseCapability' })
        this.capabilities.set(capability, {
          leasePath,
          ownerPath,
          owner: signed,
          identity,
          status: 'ACTIVE',
          releasePath: null,
        })
        return capability
      } catch (error) {
        try { this.fs.rmdirSync(leasePath) } catch {}
        throw error
      }
    }
    fail('WORKSPACE_LEASE_CONFLICT', 'target lease could not be acquired')
  }

  heartbeat(lease) {
    const handle = this._handle(lease)
    const current = this.assertOwned(lease)
    if (this.fs.existsSync(path.join(handle.leasePath, 'release.json'))) {
      fail('LEASE_RELEASING', 'lease owner is frozen after its durable release intent')
    }
    const next = { ...current, heartbeatAt: String(this.clock()) }
    delete next.checksum
    const signed = atomicWriteJson(handle.ownerPath, next, { fsImpl: this.fs })
    handle.owner = signed
    return signed
  }

  updateOwnedProcesses(lease, identities) {
    const handle = this._handle(lease)
    const current = this.assertOwned(lease)
    if (!Array.isArray(identities)) fail('LEASE_INPUT_INVALID', 'owned process identities must be an array')
    const normalized = identities.map((identity) => {
      if (!identity || typeof identity.id !== 'string' || !identity.id ||
          typeof identity.kind !== 'string' || !identity.kind) {
        fail('LEASE_INPUT_INVALID', 'owned process identity is invalid')
      }
      return { id: identity.id, kind: identity.kind }
    }).sort((left, right) => left.id.localeCompare(right.id))
    if (new Set(normalized.map(identityKey)).size !== normalized.length) {
      fail('LEASE_INPUT_INVALID', 'owned process identities must be unique')
    }
    if (this.fs.existsSync(path.join(handle.leasePath, 'release.json'))) {
      if (stableStringify(normalized) !== stableStringify(current.ownedProcessIdentities)) {
        fail('LEASE_RELEASING', 'owned process identities cannot change after durable release intent')
      }
      return current
    }
    const history = new Map(current.ownedProcessHistory.map((identity) => [identityKey(identity), identity]))
    for (const identity of normalized) history.set(identityKey(identity), identity)
    const next = {
      ...current,
      ownedProcessIdentities: normalized,
      ownedProcessHistory: [...history.values()].sort((left, right) => identityKey(left).localeCompare(identityKey(right))),
      heartbeatAt: String(this.clock()),
    }
    delete next.checksum
    const signed = atomicWriteJson(handle.ownerPath, next, { fsImpl: this.fs })
    handle.owner = signed
    return signed
  }

  assertOwned(lease) {
    const handle = this._handle(lease)
    if (handle.status !== 'ACTIVE') fail('LEASE_LOST', 'lease capability is no longer active')
    let current
    try { current = validateOwner(readChecksummedJson(handle.ownerPath, { fsImpl: this.fs })) } catch (error) {
      fail('LEASE_LOST', 'lease owner cannot be verified', { cause: error.message })
    }
    const expected = handle.owner
    if (current.leaseId !== expected.leaseId || current.token !== expected.token ||
        current.targetKey !== expected.targetKey || current.activationId !== expected.activationId ||
        current.processIdentity !== expected.processIdentity) {
      fail('LEASE_LOST', 'lease is no longer owned by this activation')
    }
    return current
  }

  describe(lease) {
    const handle = this._handle(lease)
    return JSON.parse(JSON.stringify({
      status: handle.status,
      leasePath: handle.leasePath,
      ownerPath: handle.ownerPath,
      releasePath: handle.releasePath,
      owner: handle.owner,
      identity: handle.identity,
    }))
  }

  verifyCapability(lease) {
    const handle = this._handle(lease)
    const owner = handle.status === 'RELEASED'
      ? (this.assertReleased(lease), handle.owner)
      : this.assertOwned(lease)
    return Object.freeze({
      runId: owner.runId,
      activationId: owner.activationId,
      missionHash: owner.missionHash,
      nonce: owner.nonce,
      generation: owner.generation,
      targetIdentity: owner.targetKey,
      takeover: owner.takeover ? JSON.parse(JSON.stringify(validateTakeoverReceipt(owner.takeover))) : null,
      predecessorRelease: owner.predecessorRelease
        ? JSON.parse(JSON.stringify(validatePredecessorRelease(owner.predecessorRelease)))
        : null,
    })
  }

  advanceGeneration(lease, expectedGeneration) {
    const handle = this._handle(lease)
    const current = this.assertOwned(lease)
    if (!Number.isSafeInteger(expectedGeneration) || current.generation !== expectedGeneration) {
      fail('GENERATION_CONFLICT', 'lease generation does not match resume precondition')
    }
    const next = { ...current, generation: expectedGeneration + 1, heartbeatAt: String(this.clock()) }
    delete next.checksum
    const signed = atomicWriteJson(handle.ownerPath, next, { fsImpl: this.fs })
    handle.owner = signed
    return this.verifyCapability(lease)
  }

  release(lease, options = {}) {
    const handle = this._handle(lease)
    if (handle.status === 'RELEASED') return this.describe(lease)
    const releasePath = handle.releasePath || `${handle.leasePath}.released.${handle.owner.leaseId}`
    if (!this.fs.existsSync(handle.leasePath) && this.fs.existsSync(releasePath)) {
      let releasedOwner
      try { releasedOwner = validateOwner(readChecksummedJson(path.join(releasePath, 'owner.json'), { fsImpl: this.fs })) } catch (error) {
        fail('LEASE_RELEASE_INCOMPLETE', 'release receipt cannot be reconciled', { cause: error.message })
      }
      if (releasedOwner.leaseId !== handle.owner.leaseId || releasedOwner.token !== handle.owner.token) {
        fail('LEASE_RELEASE_INCOMPLETE', 'release receipt belongs to another lease')
      }
      fsyncDirectory(this.leaseRoot, this.fs)
      handle.status = 'RELEASED'
      handle.releasePath = releasePath
      return this.describe(lease)
    }
    const current = this.assertOwned(lease)
    const entries = this.fs.readdirSync(handle.leasePath)
    if (entries.some((entry) => !['owner.json', 'release.json'].includes(entry))) {
      fail('LEASE_CONTAINS_FOREIGN_DATA', 'lease directory contains unowned entries')
    }
    if (options.releaseEvidence) {
      this._writeReleaseReceipt(handle, current, options)
    }
    if (this.fs.existsSync(releasePath)) fail('LEASE_RELEASE_COLLISION', 'lease release receipt path already exists')
    this.fs.renameSync(handle.leasePath, releasePath)
    handle.releasePath = releasePath
    fsyncDirectory(this.leaseRoot, this.fs)
    handle.status = 'RELEASED'
    return this.describe(lease)
  }

  _writeReleaseReceipt(handle, owner, options) {
    const evidence = options.releaseEvidence
    const ownedIdentityEvidence = options.ownedIdentityEvidence
    if (!evidence || evidence.runId !== owner.runId || evidence.activationId !== owner.activationId ||
        evidence.missionHash !== owner.missionHash || evidence.activationNonce !== owner.nonce ||
        evidence.generation !== owner.generation || evidence.targetIdentity !== owner.targetKey ||
        evidence.state !== 'RELEASING_LOCK' || !HASH_PATTERN.test(evidence.stateChecksum || '') ||
        !Number.isSafeInteger(evidence.stateEventSequence) || evidence.stateEventSequence < 1 ||
        !HASH_PATTERN.test(evidence.stateEventHash || '') || !HASH_PATTERN.test(evidence.releaseIntentHash || '') ||
        !['DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED'].includes(evidence.outcome) ||
        !validateOwnedIdentityEvidence(ownedIdentityEvidence, owner.ownedProcessHistory) ||
        ownedIdentityEvidence.some((entry) => entry.alive !== false)) {
      fail('LEASE_RELEASE_EVIDENCE_INVALID', 'lease release requires exact runtime intent and per-identity drain evidence')
    }
    const receipt = {
      schemaVersion: PREDECESSOR_RELEASE_VERSION,
      priorLeaseId: owner.leaseId,
      priorOwnerChecksum: owner.checksum,
      runId: owner.runId,
      activationId: owner.activationId,
      missionHash: owner.missionHash,
      nonce: owner.nonce,
      generation: owner.generation,
      targetIdentity: owner.targetKey,
      releaseIntentHash: evidence.releaseIntentHash,
      outcome: evidence.outcome,
      stateChecksum: evidence.stateChecksum,
      stateEventSequence: evidence.stateEventSequence,
      stateEventHash: evidence.stateEventHash,
      persistedOwnedProcessIdentities: owner.ownedProcessHistory.map((entry) => ({ ...entry })),
      ownedIdentityEvidence: ownedIdentityEvidence.map((entry) => ({ ...entry })),
      processesDrained: true,
      releasedAt: String(this.clock()),
      receiptHash: '0'.repeat(64),
    }
    receipt.receiptHash = predecessorReleaseHash(receipt)
    const releasePath = path.join(handle.leasePath, 'release.json')
    if (this.fs.existsSync(releasePath)) {
      const existing = validatePredecessorRelease(readChecksummedJson(releasePath, { fsImpl: this.fs }))
      const unsignedExisting = { ...existing }
      delete unsignedExisting.checksum
      const comparableExisting = { ...unsignedExisting }
      const comparableRequested = { ...receipt }
      for (const field of ['releasedAt', 'receiptHash']) {
        delete comparableExisting[field]
        delete comparableRequested[field]
      }
      if (stableStringify(comparableExisting) !== stableStringify(comparableRequested)) {
        fail('LEASE_RELEASE_EVIDENCE_INVALID', 'persisted release receipt conflicts with the requested release')
      }
      return existing
    }
    const written = atomicWriteJson(releasePath, receipt, { fsImpl: this.fs })
    fsyncDirectory(handle.leasePath, this.fs)
    return written
  }

  _findPredecessorRelease(identity, options) {
    const prefix = `${identity.key}.lease.released.`
    const matching = []
    for (const name of this.fs.readdirSync(this.leaseRoot).filter((entry) => entry.startsWith(prefix)).sort()) {
      const releasedPath = path.join(this.leaseRoot, name)
      let owner
      try {
        const item = this.fs.lstatSync(releasedPath)
        if (!item.isDirectory() || item.isSymbolicLink()) fail('LEASE_PREDECESSOR_UNVERIFIABLE', 'released predecessor is not a physical directory')
        owner = validateOwner(readChecksummedJson(path.join(releasedPath, 'owner.json'), { fsImpl: this.fs }))
      } catch (error) {
        if (error instanceof MissionLockError) throw error
        fail('LEASE_PREDECESSOR_UNVERIFIABLE', 'released predecessor owner is unreadable', { cause: error.message })
      }
      if (owner.targetKey !== identity.key || owner.runId !== options.runId || owner.activationId !== options.activationId ||
          owner.missionHash !== options.missionHash || owner.nonce !== options.nonce) continue
      const receiptPath = path.join(releasedPath, 'release.json')
      if (!this.fs.existsSync(receiptPath)) {
        fail('LEASE_PREDECESSOR_UNVERIFIABLE', 'matching predecessor has no durable release receipt')
      }
      let receipt
      try { receipt = validatePredecessorRelease(readChecksummedJson(receiptPath, { fsImpl: this.fs })) } catch (error) {
        fail('LEASE_PREDECESSOR_UNVERIFIABLE', 'matching predecessor release receipt is invalid', { cause: error.message })
      }
      if (receipt.priorLeaseId !== owner.leaseId || receipt.priorOwnerChecksum !== owner.checksum ||
          receipt.targetIdentity !== identity.key || receipt.generation !== owner.generation) {
        fail('LEASE_PREDECESSOR_UNVERIFIABLE', 'predecessor release receipt does not bind its exact owner')
      }
      const unsignedReceipt = { ...receipt }
      delete unsignedReceipt.checksum
      matching.push(unsignedReceipt)
    }
    if (!matching.length) return null
    const maximumGeneration = Math.max(...matching.map((receipt) => receipt.generation))
    if (maximumGeneration !== options.generation - 1 ||
        matching.filter((receipt) => receipt.generation === maximumGeneration).length !== 1) {
      fail('LEASE_PREDECESSOR_UNVERIFIABLE', 'predecessor release generation is missing, ambiguous, or replayed')
    }
    return matching.find((receipt) => receipt.generation === maximumGeneration)
  }

  assertReleased(lease) {
    const handle = this._handle(lease)
    if (handle.status !== 'RELEASED') {
      fail('LEASE_RELEASE_INCOMPLETE', 'lease release is not durably visible')
    }
    if (this.fs.existsSync(handle.leasePath)) {
      let current
      try { current = readChecksummedJson(path.join(handle.leasePath, 'owner.json'), { fsImpl: this.fs }) } catch (error) {
        fail('LEASE_RELEASE_INCOMPLETE', 'replacement lease cannot be verified', { cause: error.message })
      }
      if (current.leaseId === handle.owner.leaseId) fail('LEASE_RELEASE_INCOMPLETE', 'released lease is still active')
    }
    return true
  }

  _readObserved(leasePath, ownerPath) {
    let bytes
    let owner
    let leaseIdentity
    try {
      const item = this.fs.lstatSync(leasePath)
      if (!item.isDirectory() || item.isSymbolicLink()) fail('LEASE_UNVERIFIABLE', 'lease path is not a physical directory')
      leaseIdentity = physicalDirectoryIdentity(leasePath, this.fs).stablePhysicalId
      bytes = this.fs.readFileSync(ownerPath)
      owner = validateOwner(readChecksummedJson(ownerPath, { fsImpl: this.fs }))
    } catch (error) {
      if (error instanceof MissionLockError) throw error
      fail('LEASE_UNVERIFIABLE', 'existing lease owner cannot be verified', { cause: error.message })
    }
    return { bytes, owner, leaseIdentity }
  }

  _quarantineStale(leasePath, ownerPath, observed) {
    const second = this._readObserved(leasePath, ownerPath)
    if (second.leaseIdentity !== observed.leaseIdentity || !second.bytes.equals(observed.bytes)) {
      fail('WORKSPACE_LEASE_CONFLICT', 'lease source or owner changed during stale verification')
    }
    const status = this._probeOwner(second.owner)
    if (!status.stale) {
      fail('WORKSPACE_LEASE_CONFLICT', 'lease became live or unverifiable during stale takeover')
    }
    const bindingHash = quarantineBindingHash(second.owner)
    const leaseLabel = quarantineLeaseLabel(second.owner.leaseId)
    let quarantine = null
    for (let counter = 0; counter < QUARANTINE_RETRY_LIMIT; counter += 1) {
      const candidate = path.join(
        this.leaseRoot,
        `${path.basename(leasePath)}.stale.${leaseLabel}.${bindingHash}.${String(counter).padStart(2, '0')}`,
      )
      try {
        // mkdir is the cross-platform no-replace claim. The stale directory is
        // moved beneath this newly owned, private container, so rename never
        // targets a name that an earlier quarantine or attacker already owns.
        this.fs.mkdirSync(candidate, { mode: 0o700 })
        quarantine = candidate
        break
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
      }
    }
    if (!quarantine) {
      fail('LEASE_QUARANTINE_COLLISION', 'stale lease quarantine namespace is exhausted', {
        attempts: QUARANTINE_RETRY_LIMIT,
        bindingHash,
      })
    }
    const quarantinedLeasePath = path.join(quarantine, 'lease')
    try {
      this.fs.renameSync(leasePath, quarantinedLeasePath)
    } catch (error) {
      try { this.fs.rmdirSync(quarantine) } catch {}
      throw error
    }
    fsyncDirectory(quarantine, this.fs)
    fsyncDirectory(this.leaseRoot, this.fs)
    let quarantined
    try {
      quarantined = this._readObserved(quarantinedLeasePath, path.join(quarantinedLeasePath, 'owner.json'))
    } catch (error) {
      fail('LEASE_QUARANTINE_SOURCE_CHANGED', 'quarantined lease source cannot be verified', {
        quarantineName: path.basename(quarantine),
        cause: error.message,
      })
    }
    if (quarantined.leaseIdentity !== second.leaseIdentity || !quarantined.bytes.equals(second.bytes)) {
      fail('LEASE_QUARANTINE_SOURCE_CHANGED', 'quarantined lease is not the exact stale source', {
        quarantineName: path.basename(quarantine),
        expectedLeaseIdentity: second.leaseIdentity,
        observedLeaseIdentity: quarantined.leaseIdentity,
      })
    }
    const receipt = {
      schemaVersion: TAKEOVER_RECEIPT_VERSION,
      priorLeaseId: second.owner.leaseId,
      priorOwnerChecksum: second.owner.checksum,
      priorOwnerPid: second.owner.pid,
      priorProcessIdentity: second.owner.processIdentity,
      runId: second.owner.runId,
      activationId: second.owner.activationId,
      missionHash: second.owner.missionHash,
      nonce: second.owner.nonce,
      generation: second.owner.generation,
      targetIdentity: second.owner.targetKey,
      persistedOwnedProcessIdentities: second.owner.ownedProcessHistory.map((entry) => ({ ...entry })),
      ownedIdentityEvidence: status.ownedIdentityEvidence.map((entry) => ({ ...entry })),
      ownerProcessVerifiedDead: true,
      ownerProcessEvidence: status.rootProcessEvidence,
      descendantsVerifiedDrained: true,
      quarantineName: path.basename(quarantine),
      verifiedAt: String(this.clock()),
      receiptHash: '0'.repeat(64),
    }
    receipt.receiptHash = takeoverReceiptHash(receipt)
    return Object.freeze(receipt)
  }

  _probeOwner(owner) {
    const probe = this.identityProbe(owner)
    const processEvidence = rootProcessEvidence(owner, this.processIdentityObserver)
    const persisted = owner.ownedProcessHistory
    const evidence = persisted.length === 0 && (!probe || probe.ownedIdentityEvidence === undefined)
      ? []
      : probe && probe.ownedIdentityEvidence
    const descendantsAccounted = validateOwnedIdentityEvidence(evidence, persisted)
    const liveDescendants = descendantsAccounted
      ? evidence.filter((entry) => entry.alive).length
      : persisted.length
    return {
      ...probe,
      ownedIdentityEvidence: descendantsAccounted
        ? evidence.map((entry) => ({ ...entry })).sort((left, right) => identityKey(left).localeCompare(identityKey(right)))
        : [],
      rootProcessEvidence: processEvidence,
      stale: Boolean(validateRootProcessEvidence(processEvidence, owner) &&
        ['DEAD', 'PID_REUSED'].includes(processEvidence.status) &&
        probe && probe.verified === true &&
        descendantsAccounted && liveDescendants === 0),
    }
  }

  _sameTargetIdentity(identity, owner) {
    if (!owner.target || owner.targetKey !== identity.key) return false
    if (identity.target.stablePhysicalId || owner.target.stablePhysicalId) {
      return Boolean(identity.target.stablePhysicalId &&
        identity.target.stablePhysicalId === owner.target.stablePhysicalId)
    }
    return identity.target.path === owner.target.path
  }

  _handle(capability) {
    const handle = capability && this.capabilities.get(capability)
    if (!handle) fail('LEASE_INVALID', 'an opaque lease capability issued by this lock is required')
    return handle
  }
}

module.exports = {
  LEASE_SCHEMA_VERSION,
  MISSION_CAPABILITY_BINDING_FIELDS,
  TAKEOVER_RECEIPT_VERSION,
  PREDECESSOR_RELEASE_VERSION,
  MissionLock,
  MissionLockError,
  defaultIdentityProbe,
  physicalDirectoryIdentity,
  takeoverReceiptHash,
  predecessorReleaseHash,
  validateOwnedIdentityEvidence,
  validateRootProcessEvidence,
  rootProcessEvidence,
  processIdentityForPid,
  validatePredecessorRelease,
  validateTakeoverReceipt,
  verifyMissionLeaseCapability: (lock, capability) => lock.verifyCapability(capability),
}
