'use strict'

// A launchd job gives each reservation an immutable resource coalition. PID
// lists discover signal targets; only kernel coalition accounting proves zero
// remaining tasks. This backend is admitted only with an explicitly bound
// native helper. The observer in darwin-process.js remains observer-only.
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { atomicWriteJson, stableStringify } = require('./event-log.js')
const { auditPrivatePermissions, inspectPathNoFollow, pathIsInside } = require('./safe-run-root.js')
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const DECIMAL = /^(0|[1-9][0-9]*)$/
const kind = 'darwin-launchd-coalition'
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function requestDigest(request) { const body = { ...request }; delete body.checksum; return digest(stableStringify(body)) }
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function readPrivate(file) {
  const item = fs.lstatSync(file)
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.mode & 0o077 || item.size > 1024 * 1024) fail('PROCESS_IDENTITY_INVALID', 'Darwin control record is not one bounded private file')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd)
    if (opened.dev !== item.dev || opened.ino !== item.ino) fail('PROCESS_IDENTITY_CHANGED', 'Darwin control record changed while opening')
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('PROCESS_IDENTITY_CHANGED', 'Darwin control record changed while reading')
    return JSON.parse(bytes)
  } finally { fs.closeSync(fd) }
}
function writeExclusive(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function readBoundExecutable(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).sort().join(',') !== 'path,sha256' ||
      !path.isAbsolute(binding.path || '') || !HASH.test(binding.sha256 || '')) fail('PROVIDER_UNSUPPORTED', 'Darwin helper requires an exact executable binding')
  const before = inspectPathNoFollow(binding.path, { mustBeDirectory: false })
  if (!before.exists || before.realpath !== binding.path) fail('PROCESS_IDENTITY_CHANGED', 'Darwin helper executable binding drifted')
  const descriptor = fs.openSync(binding.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || String(opened.dev) !== before.identity.dev || String(opened.ino) !== before.identity.ino) fail('PROCESS_IDENTITY_CHANGED', 'Darwin helper changed while opening')
    const bytes = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || digest(bytes) !== binding.sha256) fail('PROCESS_IDENTITY_CHANGED', 'Darwin helper executable binding drifted')
    return bytes
  } finally { fs.closeSync(descriptor) }
}
function materializeHelper(binding, controlRoot) {
  const bytes = readBoundExecutable(binding)
  const target = path.join(controlRoot, `coalition-helper-${binding.sha256}`)
  if (!fs.existsSync(target)) {
    const descriptor = fs.openSync(target, 'wx', 0o500)
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  }
  const privateBinding = { path: target, sha256: binding.sha256 }
  readBoundExecutable(privateBinding)
  const privateStats = fs.lstatSync(target)
  if (!privateStats.isFile() || privateStats.isSymbolicLink() || privateStats.nlink !== 1 || (privateStats.mode & 0o277) !== 0) fail('PROCESS_IDENTITY_CHANGED', 'Private Darwin helper permissions are unsafe')
  return Object.freeze(privateBinding)
}
function boundExecutable(binding) {
  readBoundExecutable(binding)
  return binding.path
}
function helperCall(binding, argv) {
  const deadline = Date.now() + 2000
  let observedBoot = null
  for (let attempt = 0; ; attempt++) {
    const result = cp.spawnSync(boundExecutable(binding), argv, { shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    let value
    try { value = JSON.parse(result.stdout) } catch { fail('PROCESS_OBSERVATION_FAILED', 'Darwin helper returned no complete JSON response') }
    const validBoot = value.schemaVersion === 1 && UUID.test(value.bootUuid || '')
    if (validBoot && observedBoot && observedBoot !== value.bootUuid) fail('PROCESS_IDENTITY_CHANGED', 'Darwin boot changed during process observation')
    if (validBoot) observedBoot = value.bootUuid
    if (!result.error && result.status === 0 && !result.signal && validBoot && value.ok === true) return value
    // A UID-wide PID snapshot can race an unrelated process exit. Retry the
    // complete kernel query; never turn a partial census into an empty group.
    // Atomic coalition task counters remain the only proof of a drained group.
    const exitedSnapshotMember = !result.error && !result.signal && result.status === 74 && validBoot &&
      ['census', 'signal'].includes(argv[0]) && value.command === argv[0] && value.resourceCoalitionId === argv[1] &&
      value.ok === false && value.complete === false && Array.isArray(value.errors) && value.errors.length > 0 &&
      value.errors.every(error => Number.isSafeInteger(error.pid) && error.pid > 0 &&
        ['bind-before', 'coalition-query', 'bind-after', 'audit-signal'].includes(error.phase) && [2, 3].includes(error.errno))
    if (exitedSnapshotMember && attempt < 7 && Date.now() < deadline) continue
    const error = new Error('Darwin helper could not establish kernel authority')
    error.code = 'PROCESS_OBSERVATION_FAILED'
    error.details = { command: argv[0], status: result.status, signal: result.signal,
      helperError: value.error || null, errors: Array.isArray(value.errors) ? value.errors.slice(0, 8) : null }
    throw error
  }
}
function xml(value) {
  if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('LAUNCH_SPEC_INVALID', 'Darwin launch argument is not XML-safe text')
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
function launchPlist(label, requestPath, nodePath = process.execPath) {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${[nodePath, __filename, '--job', requestPath].map(value => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><false/><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`
}
function sameMissingServiceResponse(remaining, label, reference, missingLabel) {
  const normalize = (result, name) => {
    if (!Number.isInteger(result.status) || result.status === 0 || result.error || result.signal || result.stdout.trim()) return null
    const marker = `Could not find service "${name}" in domain for `
    if (!result.stderr.includes(marker) || result.stderr.split(name).length !== 2) return null
    return result.stderr.replace(name, '<owned-service>')
  }
  const expected = normalize(reference, missingLabel)
  return expected !== null && remaining.status === reference.status && normalize(remaining, label) === expected
}
function createDarwinCoalitionAdapter(options = {}) {
  if (process.platform !== 'darwin') fail('PROVIDER_UNSUPPORTED', 'Darwin launchd ownership requires native macOS')
  if (!path.isAbsolute(options.controlRoot || '')) fail('PROCESS_OWNER_CONFIG_INVALID', 'Darwin ownership requires a private control root')
  const controlRoot = path.resolve(options.controlRoot)
  const trustedRoot = options.providerPrivateOwnershipRoot
  if (!path.isAbsolute(trustedRoot || '') || !pathIsInside(trustedRoot, controlRoot)) fail('PROCESS_OWNER_CONFIG_INVALID', 'Darwin control root must belong to its private ownership root')
  auditPrivatePermissions(trustedRoot, { recurse: false })
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 })
  auditPrivatePermissions(controlRoot, { recurse: false })
  const helper = materializeHelper(options.helper, controlRoot)
  const nodeExecutable = Object.freeze({ ...(options.nodeExecutable || { path: fs.realpathSync.native(process.execPath), sha256: digest(fs.readFileSync(fs.realpathSync.native(process.execPath))) }) })
  readBoundExecutable(nodeExecutable)
  const bootUuid = helperCall(helper, ['boot']).bootUuid
  const uid = process.getuid()
  const controlRootHash = digest(controlRoot)
  const identity = reservationId => `darwin-reservation:${controlRootHash}:${digest(reservationId)}`
  const directory = reservationId => path.join(controlRoot, digest(reservationId))
  const files = dir => ({ dir, request: path.join(dir, 'request.json'), ready: path.join(dir, 'ready.json'), gate: path.join(dir, 'go.json'), stopped: path.join(dir, 'stopped.json'), plist: path.join(dir, 'job.plist') })
  const call = argv => {
    const value = helperCall(helper, argv)
    if (value.bootUuid !== bootUuid) fail('PROCESS_IDENTITY_CHANGED', 'Darwin boot session changed')
    return value
  }
  function readRequest(dir) {
    if (path.dirname(dir) !== controlRoot || !HASH.test(path.basename(dir))) fail('PROCESS_IDENTITY_INVALID', 'Darwin reservation is outside its controller root')
    const request = readPrivate(files(dir).request)
    if (request.schemaVersion !== 1 || request.binding?.adapterKind !== kind || request.binding.bootUuid !== bootUuid || request.binding.controlRootHash !== controlRootHash || request.binding.reservationIdentity !== identity(request.binding.reservationId) || dir !== directory(request.binding.reservationId) || stableStringify(request.helper) !== stableStringify(helper) || stableStringify(request.nodeExecutable) !== stableStringify(nodeExecutable) || request.checksum !== requestDigest(request)) fail('PROCESS_IDENTITY_INVALID', 'Darwin immutable launch request does not match its reservation')
    return request
  }
  function readReady(dir, request = readRequest(dir)) {
    if (!fs.existsSync(files(dir).ready)) return null
    const ready = readPrivate(files(dir).ready)
    if (ready.schemaVersion !== 1 || ready.ok !== true || ready.command !== 'inspect' || ready.requestChecksum !== request.checksum || ready.bootUuid !== bootUuid || ready.uid !== uid || !Number.isSafeInteger(ready.pid) || ready.pid < 1 || !Number.isSafeInteger(ready.pidVersion) || !DECIMAL.test(ready.resourceCoalitionId || '') || ready.resourceCoalitionId === '0') fail('PROCESS_IDENTITY_INVALID', 'Darwin job published a foreign kernel identity')
    return ready
  }
  const group = (dir, ready) => `darwin-coalition:${path.basename(dir)}:${ready.resourceCoalitionId}`
  function fromGroup(value) {
    const match = /^darwin-coalition:([a-f0-9]{64}):([1-9][0-9]*)$/.exec(value || '')
    if (!match) fail('PROCESS_IDENTITY_INVALID', 'Darwin coalition identity is invalid')
    const dir = path.join(controlRoot, match[1]), request = readRequest(dir), ready = readReady(dir, request)
    if (!ready || ready.resourceCoalitionId !== match[2]) fail('PROCESS_IDENTITY_CHANGED', 'Darwin coalition identity changed')
    return { dir, request, ready }
  }
  function launchctl(argv) { return cp.spawnSync('/bin/launchctl', argv, { shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }) }
  function absentService(request) {
    const domain = launchctl(['print', request.domain])
    if (domain.status !== 0 || domain.error || domain.signal) return false
    // launchctl's named-service errors use its own status namespace, not
    // errno. Bind the complete response to a fresh, never-bootstrapped label
    // in the same live domain instead of treating any nonzero exit as absent.
    const missingLabel = `com.autoprompt.absence.${crypto.randomUUID()}`
    const reference = launchctl(['print', `${request.domain}/${missingLabel}`])
    const remaining = launchctl(['print', `${request.domain}/${request.label}`])
    return sameMissingServiceResponse(remaining, request.label, reference, missingLabel)
  }
  function stopJob(dir, request) {
    const job = `${request.domain}/${request.label}`
    const result = launchctl(['bootout', job])
    if (result.error || result.signal) fail('PROCESS_DRAIN_TIMEOUT', 'Darwin launchd stop did not settle')
    if (!absentService(request)) fail('PROCESS_DRAIN_TIMEOUT', 'Darwin launchd job absence was not established')
    if (!fs.existsSync(files(dir).stopped)) writeExclusive(files(dir).stopped, { requestChecksum: request.checksum, bootUuid })
  }
  function activeTasks(ready) {
    const usage = call(['usage', ready.resourceCoalitionId])
    if (usage.exists === false) return 0n
    if (usage.exists !== true || !DECIMAL.test(usage.tasksStarted || '') || !DECIMAL.test(usage.tasksExited || '')) fail('PROCESS_OBSERVATION_FAILED', 'Darwin kernel task counters are unavailable')
    const active = BigInt(usage.tasksStarted) - BigInt(usage.tasksExited)
    if (active < 0n) fail('PROCESS_OBSERVATION_FAILED', 'Darwin kernel task counters are inconsistent')
    return active
  }
  function members(ready) {
    const census = call(['census', ready.resourceCoalitionId])
    if (census.complete !== true || !Array.isArray(census.errors) || census.errors.length || !Array.isArray(census.members) || census.members.some(member => !Number.isSafeInteger(member.pid) || member.pid < 1 || !Number.isSafeInteger(member.pidVersion))) fail('PROCESS_OBSERVATION_FAILED', 'Darwin coalition enumeration is incomplete')
    return census.members.map(member => member.pid)
  }
  const adapter = {
    kind, startupTimeoutMs: 30000,
    capabilities: Object.fromEntries(['groupAtCreation', 'descendantEnumeration', 'groupSignal', 'stableIdentity', 'persistentIdentity', 'reservationRecovery'].map(name => [name, true])),
    reservationIdentity: identity,
    childControlEnvironment: reservationId => ({ AUTOPROMPT_OWNERSHIP_RESERVATION: reservationId }),
    prepareReservation: input => ({ schemaVersion: 1, adapterKind: kind, bootUuid, controlRootHash, ...input }),
    validateReservationBinding(record) {
      const expected = adapter.prepareReservation({ reservationId: record.reservationId, reservationIdentity: record.reservationIdentity, startupDeadlineAt: record.startupDeadlineAt, targetKey: record.targetKey })
      if (stableStringify(expected) !== stableStringify(record.reservationBinding)) fail('PROCESS_IDENTITY_INVALID', 'Darwin durable reservation binding changed')
      return expected
    },
    async admit() { call(['boot']); return { supported: true } },
    async spawnOwned(spec) {
      adapter.validateReservationBinding(spec)
      if (spec.shell || !path.isAbsolute(spec.executable || '') || !Array.isArray(spec.argv) || spec.argv.some(value => typeof value !== 'string' || value.includes('\0')) || !path.isAbsolute(spec.cwd || '') || !spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env) || Object.entries(spec.env).some(([name, value]) => !name || name.includes('\0') || typeof value !== 'string' || value.includes('\0')) || spec.env.AUTOPROMPT_OWNERSHIP_RESERVATION !== spec.reservationId || [spec.stdin, spec.stdout, spec.stderr].some(value => value !== undefined && value !== 'ignore')) fail('LAUNCH_SPEC_INVALID', 'Darwin owned proxy requires exact shell-free paths, environment and ignored direct stdio')
      const dir = directory(spec.reservationId), f = files(dir)
      fs.mkdirSync(dir, { mode: 0o700 })
      // Choose an existing user domain before writing the immutable request.
      const domain = [`gui/${uid}`, `user/${uid}`].find(value => launchctl(['print', value]).status === 0)
      if (!domain) fail('PROVIDER_UNSUPPORTED', 'Darwin user launchd domain is unavailable')
      const request = { schemaVersion: 1, binding: spec.reservationBinding, helper, nodeExecutable, domain, label: `com.autoprompt.owned.${controlRootHash.slice(0, 16)}.${digest(spec.reservationId)}`, executable: spec.executable, argv: spec.argv, cwd: spec.cwd, env: spec.env }
      request.checksum = digest(stableStringify(request))
      writeExclusive(f.request, request)
      fs.writeFileSync(f.plist, launchPlist(request.label, f.request, boundExecutable(nodeExecutable)), { flag: 'wx', mode: 0o600 })
      const bootstrap = launchctl(['bootstrap', domain, f.plist])
      if (bootstrap.status !== 0 || bootstrap.error || bootstrap.signal) fail('PROCESS_RESERVATION_FAILURE', 'Darwin launchd bootstrap failed; durable reservation requires recovery')
      while (Date.now() < Date.parse(spec.startupDeadlineAt)) {
        const ready = readReady(dir, request)
        if (ready) {
          const current = call(['inspect', String(ready.pid)])
          if (current.pidVersion !== ready.pidVersion || current.resourceCoalitionId !== ready.resourceCoalitionId || current.uid !== uid) fail('PROCESS_IDENTITY_CHANGED', 'Darwin job root changed before launch admission')
          writeExclusive(f.gate, { requestChecksum: request.checksum })
          return { rootPid: ready.pid, groupIdentity: group(dir, ready) }
        }
        await delay(20)
      }
      fail('PROCESS_RESERVATION_FAILURE', 'Darwin job failed to publish its kernel identity before the startup deadline')
    },
    async recoverReservation(reservationId) {
      const dir = directory(reservationId)
      if (!fs.existsSync(files(dir).request)) return null
      const ready = readReady(dir)
      if (!ready) fail('OWNERSHIP_RECOVERY_PENDING', 'Darwin launchd reservation has no committed kernel identity')
      return { rootPid: ready.pid, groupIdentity: group(dir, ready) }
    },
    async probeReservation(record) {
      adapter.validateReservationBinding(record)
      const dir = directory(record.reservationId)
      // Absence of a request is not physical absence: a spawn operation may
      // still be between its durable ProcessOwner reservation and this
      // adapter's first filesystem publication. Never turn that gap into a
      // DEAD result while a late launch remains possible.
      if (!fs.existsSync(files(dir).request)) return { state: 'PENDING', evidence: { reason: 'launch-request-not-yet-published' } }
      const request = readRequest(dir)
      const ready = readReady(dir, request)
      if (ready) return { state: 'LIVE', ownership: { rootPid: ready.pid, groupIdentity: group(dir, ready) } }
      if (Date.now() < Date.parse(record.startupDeadlineAt)) return { state: 'PENDING' }
      stopJob(dir, request)
      const late = readReady(dir, request)
      if (late) return { state: 'LIVE', ownership: { rootPid: late.pid, groupIdentity: group(dir, late) } }
      return { state: 'DEAD', evidence: { reason: 'launchd-absent-without-published-identity' } }
    },
    async listOwned(value) {
      const { dir, request, ready } = fromGroup(value)
      // A task can disappear from BSD's PID table before Mach releases its
      // coalition reference (also during exec). Retry that transition, keeping
      // the atomic kernel count as the only authority for an empty result.
      const deadline = Date.now() + 2000
      let active
      do {
        active = activeTasks(ready)
        if (active === 0n) {
          stopJob(dir, request)
          if (activeTasks(ready) === 0n) return []
        }
        const pids = members(ready)
        if (pids.length) return pids
        active = activeTasks(ready)
        if (active === 0n) {
          stopJob(dir, request)
          if (activeTasks(ready) === 0n) return []
        }
        await delay(25)
      } while (Date.now() < deadline)
      fail('PROCESS_OBSERVATION_FAILED', `Darwin coalition ${ready.resourceCoalitionId} has ${active} kernel tasks but no enumerable PIDs`)
    },
    async signalOwned(value, signal) {
      if (!['TERM', 'KILL'].includes(signal)) fail('PROCESS_IDENTITY_INVALID', 'Darwin ownership signal is invalid')
      const { dir, request, ready } = fromGroup(value)
      stopJob(dir, request)
      if (activeTasks(ready) === 0n) return
      const result = call(['signal', ready.resourceCoalitionId, signal])
      if (result.complete !== true || !Array.isArray(result.errors) || result.errors.length) fail('PROCESS_DRAIN_TIMEOUT', 'Darwin audited coalition signal was incomplete')
    },
    async verifyOwnership({ reservationId, rootPid, groupIdentity }) {
      const recovered = await adapter.recoverReservation(reservationId)
      return Boolean(recovered && recovered.rootPid === rootPid && recovered.groupIdentity === groupIdentity)
    },
    async listTargetOwned(targetKey, records) {
      const pids = []
      for (const record of records.filter(value => value.targetKey === targetKey)) {
        const owned = record.groupIdentity ? record : await adapter.recoverReservation(record.reservationId)
        if (owned) pids.push(...await adapter.listOwned(owned.groupIdentity))
      }
      return [...new Set(pids)]
    },
  }
  return adapter
}

async function runJob(requestPath) {
  const request = readPrivate(requestPath), directory = path.dirname(requestPath)
  if (request.checksum !== requestDigest(request) || request.binding?.adapterKind !== kind || Date.now() >= Date.parse(request.binding.startupDeadlineAt)) fail('PROCESS_IDENTITY_INVALID', 'Darwin job request is invalid or expired')
  readBoundExecutable(request.nodeExecutable)
  const own = helperCall(request.helper, ['inspect', String(process.pid)])
  if (own.bootUuid !== request.binding.bootUuid || own.uid !== process.getuid()) fail('PROCESS_IDENTITY_CHANGED', 'Darwin job boot identity changed')
  writeExclusive(path.join(directory, 'ready.json'), { ...own, requestChecksum: request.checksum })
  while (!fs.existsSync(path.join(directory, 'go.json'))) {
    if (Date.now() >= Date.parse(request.binding.startupDeadlineAt)) return
    await delay(20)
  }
  if (readPrivate(path.join(directory, 'go.json')).requestChecksum !== request.checksum) fail('PROCESS_IDENTITY_INVALID', 'Darwin launch gate is foreign')
  const child = cp.spawn(request.executable, request.argv, { cwd: request.cwd, env: request.env, shell: false, stdio: 'ignore' })
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  atomicWriteJson(path.join(directory, 'exit.json'), { ...result, requestChecksum: request.checksum })
}
if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== '--job' || process.platform !== 'darwin') process.exitCode = 64
  else runJob(process.argv[3]).catch(() => { process.exitCode = 1 })
}
module.exports = { createDarwinCoalitionAdapter, helperCall, launchPlist, sameMissingServiceResponse }
