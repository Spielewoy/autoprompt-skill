'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { atomicCreateJson, atomicWriteJson, checksumRecord, sha256, stableStringify } = require('../agents/codex/workflow/event-log.js')
const { readFileNoFollow } = require('../agents/codex/workflow/safe-run-root.js')

const SCHEMA_VERSION = 1
const RESOURCE_TYPE_DARWIN = 'vscode-darwin-ipc-alias'
const RESOURCE_TYPE_WINDOWS = 'vscode-windows-storage-alias'
const MAX_WINDOWS_ALIAS_CHARS = 120
const STATES = new Set(['INTENT', 'ALLOCATED', 'READY', 'RESERVATION_ENTERED', 'RELEASING', 'CLEANED'])
const HASH = /^[a-f0-9]{64}$/u
const ACTIVE_HANDLES = new WeakMap()

class VscodeIpcAliasError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'VscodeIpcAliasError'
    this.code = code
    this.details = details
  }
}
function fail(code, message, details) { throw new VscodeIpcAliasError(code, message, details) }
function boundedCause(error) {
  const source = error && typeof error === 'object' ? error : {}
  const details = source.details && typeof source.details === 'object' && !Array.isArray(source.details) ? source.details : {}
  return Object.freeze({
    code: typeof source.code === 'string' ? source.code.slice(0, 128) : null,
    message: typeof source.message === 'string' ? source.message.slice(0, 1024) : null,
    status: Number.isInteger(details.status) ? details.status : null,
    cause: typeof details.cause === 'string' ? details.cause.slice(0, 128) : null,
    phase: typeof details.phase === 'string' ? details.phase.slice(0, 128) : null,
    stderr: typeof details.stderr === 'string' ? details.stderr.slice(0, 2048) : null,
  })
}
function windows() { return process.platform === 'win32' }
function resourceType() { return windows() ? RESOURCE_TYPE_WINDOWS : RESOURCE_TYPE_DARWIN }
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return windows() ? left.toLowerCase() === right.toLowerCase() : left === right
}
function exactObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === fields.slice().sort().join('\0')
}
function exactBinding(binding) {
  const fields = ['reservationId', 'sessionId', 'targetKey']
  if (!exactObject(binding, fields) || fields.some(field => typeof binding[field] !== 'string' || !binding[field] || binding[field].includes('\0'))) {
    fail('VSCODE_IPC_ALIAS_INVALID', 'VS Code IPC alias requires an exact process binding')
  }
  return Object.freeze({ reservationId: binding.reservationId, sessionId: binding.sessionId, targetKey: binding.targetKey })
}
function identity(stats, type) {
  if (!stats || (type === 'directory' && !stats.isDirectory()) || (type === 'symlink' && !stats.isSymbolicLink())) {
    fail('VSCODE_IPC_ALIAS_UNSAFE', `VS Code IPC alias ${type} identity is invalid`)
  }
  return Object.freeze({ type, dev: String(stats.dev), ino: String(stats.ino), uid: Number(stats.uid), mode: Number(stats.mode & 0o777n) })
}
function sameIdentity(left, right) {
  return Boolean(left && right && left.type === right.type && left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode)
}
function validStoredIdentity(value, type) {
  return exactObject(value, ['type', 'dev', 'ino', 'uid', 'mode']) && value.type === type &&
    typeof value.dev === 'string' && /^\d+$/u.test(value.dev) &&
    typeof value.ino === 'string' && /^\d+$/u.test(value.ino) &&
    Number.isSafeInteger(value.uid) && value.uid >= 0 &&
    Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777
}
function physicalDirectory(directory, label, requirePrivate = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory.includes('\0')) {
    fail('VSCODE_IPC_ALIAS_INVALID', `${label} must be an absolute canonical directory`)
  }
  let item, real
  try { item = fs.lstatSync(directory, { bigint: true }); real = fs.realpathSync.native(directory) } catch (error) {
    fail('VSCODE_IPC_ALIAS_UNSAFE', `${label} is unavailable`, { cause: error && error.code })
  }
  if (!item.isDirectory() || item.isSymbolicLink() || !samePath(real, directory)) fail('VSCODE_IPC_ALIAS_UNSAFE', `${label} is not a physical directory`)
  const captured = identity(item, 'directory')
  if (typeof process.getuid === 'function' && captured.uid !== process.getuid()) fail('VSCODE_IPC_ALIAS_UNSAFE', `${label} has a foreign owner`)
  if (requirePrivate) {
    if (windows()) {
      try { require('../agents/codex/workflow/safe-run-root.js').auditPrivatePermissions(directory, { recurse: false }) }
      catch (error) { fail('VSCODE_IPC_ALIAS_UNSAFE', `${label} is not private`, { audit: boundedCause(error) }) }
    } else if (captured.mode !== 0o700) fail('VSCODE_IPC_ALIAS_UNSAFE', `${label} is not private`)
  }
  return captured
}
function runtimeShortRoot(options) {
  if (process.platform === 'darwin') {
    if (options._testShortRoot !== undefined) fail('VSCODE_IPC_ALIAS_INVALID', 'test short roots are forbidden on Darwin')
    if (typeof process.getuid !== 'function') fail('VSCODE_IPC_ALIAS_UNSUPPORTED', 'Darwin UID is unavailable')
    return `/private/tmp/ap-vsc-${process.getuid()}`
  }
  if (windows()) {
    if (options._testShortRoot !== undefined) fail('VSCODE_IPC_ALIAS_INVALID', 'test short roots are forbidden on Windows')
    const safeRoot = require('../agents/codex/workflow/safe-run-root.js')
    let environment
    try { environment = safeRoot.windowsControllerEnvironment(process.env.SystemRoot || process.env.WINDIR) }
    catch (error) { fail('VSCODE_IPC_ALIAS_UNSUPPORTED', 'Windows token profile is unavailable for the VS Code alias', { cause: error && error.code }) }
    return path.join(environment.LOCALAPPDATA, 'ap-vsc')
  }
  if (typeof options._testShortRoot !== 'string') fail('VSCODE_IPC_ALIAS_UNSUPPORTED', 'VS Code IPC aliases are available only on Darwin')
  return path.resolve(options._testShortRoot)
}
function establishShortRoot(root) {
  let created = false
  try { fs.mkdirSync(root, { mode: 0o700 }); created = true } catch (error) { if (!error || error.code !== 'EEXIST') throw error }
  if (windows() && created) {
    try { require('../agents/codex/workflow/safe-run-root.js').ensureWindowsPrivateAcl(root) }
    catch (error) { fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC short root could not be made private', { cause: error && error.code }) }
  }
  return physicalDirectory(root, 'VS Code IPC short root', true)
}
function journalParent(journalPath) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath) || !samePath(path.resolve(journalPath), journalPath) || journalPath.includes('\0')) {
    fail('VSCODE_IPC_ALIAS_INVALID', 'VS Code IPC journal path must be absolute and canonical')
  }
  physicalDirectory(path.dirname(journalPath), 'VS Code IPC journal parent', true)
}
function writeJournal(journalPath, record) {
  const body = { ...record }
  delete body.checksum
  atomicWriteJson(journalPath, body, { mode: 0o600 })
  return body
}
function immutableRecord(record) {
  return {
    schemaVersion: SCHEMA_VERSION,
    resourceType: record.resourceType,
    binding: record.binding,
    target: record.target,
    shortRoot: record.shortRoot,
    child: record.child,
    link: record.link,
  }
}
function refreshLaunchBinding(record) {
  record.launchBindingHash = sha256(stableStringify(immutableRecord(record)))
  return record.launchBindingHash
}
function readJournal(journalPath, options = {}) {
  journalParent(journalPath)
  const stat = fs.lstatSync(journalPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) fail('VSCODE_IPC_ALIAS_JOURNAL_INVALID', 'VS Code IPC alias journal is not one bounded regular file')
  const bytes = readFileNoFollow(journalPath)
  if (!bytes || bytes.length > 64 * 1024) fail('VSCODE_IPC_ALIAS_JOURNAL_INVALID', 'VS Code IPC alias journal is unavailable or oversized')
  let record
  try { record = JSON.parse(bytes.toString('utf8')) } catch { fail('VSCODE_IPC_ALIAS_JOURNAL_INVALID', 'VS Code IPC alias journal JSON is invalid') }
  if (!record || typeof record !== 'object' || Array.isArray(record) || !HASH.test(record.checksum || '') || checksumRecord(record) !== record.checksum) {
    fail('VSCODE_IPC_ALIAS_JOURNAL_INVALID', 'VS Code IPC alias journal checksum is invalid')
  }
  const fields = ['schemaVersion', 'resourceType', 'binding', 'target', 'shortRoot', 'child', 'link', 'launchBindingHash', 'state', 'checksum']
  if (!exactObject(record, fields) || record.schemaVersion !== SCHEMA_VERSION || record.resourceType !== resourceType() || !STATES.has(record.state) ||
      !HASH.test(record.launchBindingHash || '') || !exactObject(record.target, ['path', 'identity']) ||
      !exactObject(record.shortRoot, ['path', 'identity']) || !exactObject(record.child, ['path', 'identity']) ||
      !exactObject(record.link, ['path', 'tombstonePath', 'targetPath', 'identity']) ||
      ![record.target.path, record.shortRoot.path, record.child.path, record.link.path, record.link.tombstonePath, record.link.targetPath]
        .every(value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')) ||
      !validStoredIdentity(record.target.identity, 'directory') || !validStoredIdentity(record.shortRoot.identity, 'directory') ||
      (record.child.identity !== null && !validStoredIdentity(record.child.identity, 'directory')) ||
      (record.link.identity !== null && !validStoredIdentity(record.link.identity, 'symlink')) ||
      (record.state === 'INTENT' && (record.child.identity !== null || record.link.identity !== null)) ||
      (record.state === 'ALLOCATED' && (!record.child.identity || record.link.identity !== null)) ||
      (['READY', 'RESERVATION_ENTERED', 'RELEASING'].includes(record.state) && (!record.child.identity || !record.link.identity))) {
    fail('VSCODE_IPC_ALIAS_JOURNAL_INVALID', 'VS Code IPC alias journal schema is invalid')
  }
  const binding = exactBinding(record.binding)
  if (sha256(stableStringify(immutableRecord(record))) !== record.launchBindingHash) fail('VSCODE_IPC_ALIAS_JOURNAL_INVALID', 'VS Code IPC alias immutable binding changed')
  const expectedRoot = runtimeShortRoot(options)
  if (!samePath(record.shortRoot.path, expectedRoot) || !samePath(path.dirname(record.child.path), expectedRoot) ||
      path.basename(record.child.path) !== sha256(stableStringify(binding)).slice(0, 32) ||
      !samePath(record.link.path, path.join(record.child.path, 'u')) ||
      !samePath(record.link.tombstonePath, path.join(record.child.path, '.u-cleanup')) ||
      !samePath(record.link.targetPath, record.target.path)) {
    fail('VSCODE_IPC_ALIAS_JOURNAL_INVALID', 'VS Code IPC alias paths differ from their binding')
  }
  return { ...record, binding }
}
function verifyDirectory(pathname, expected, label, allowAbsent = false) {
  let item
  try { item = fs.lstatSync(pathname, { bigint: true }) } catch (error) {
    if (allowAbsent && error && error.code === 'ENOENT') return null
    fail('VSCODE_IPC_ALIAS_UNSAFE', `${label} is unavailable`, { cause: error && error.code })
  }
  const current = identity(item, 'directory')
  if (!sameIdentity(expected, current) || !samePath(fs.realpathSync.native(pathname), pathname)) fail('VSCODE_IPC_ALIAS_UNSAFE', `${label} changed identity`)
  return current
}
function normalizedLinkTarget(value) {
  if (!windows()) return value
  let normalized = String(value)
  if (/^\\\\\?\\UNC\\/iu.test(normalized)) normalized = `\\\\${normalized.slice(8)}`
  else if (/^\\\\\?\\/u.test(normalized)) normalized = normalized.slice(4)
  else if (/^\\\?\?\\/u.test(normalized)) normalized = normalized.slice(4)
  return path.win32.normalize(normalized).toLowerCase()
}
function verifyLink(pathname, expected, targetPath, allowAbsent = false) {
  let item
  try { item = fs.lstatSync(pathname, { bigint: true }) } catch (error) {
    if (allowAbsent && error && error.code === 'ENOENT') return null
    fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias link is unavailable', { cause: error && error.code })
  }
  const current = identity(item, 'symlink')
  let target
  try { target = fs.readlinkSync(pathname) } catch (error) { fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias link cannot be read', { cause: error.code }) }
  let resolved
  try { resolved = fs.realpathSync.native(pathname) } catch (error) { fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias target cannot be resolved', { cause: error.code }) }
  if (!sameIdentity(expected, current) || normalizedLinkTarget(target) !== normalizedLinkTarget(targetPath) || !samePath(resolved, targetPath)) {
    fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias link changed identity')
  }
  return current
}
function assertStaticIdentities(record) {
  const target = physicalDirectory(record.target.path, 'VS Code IPC deep target', true)
  const root = physicalDirectory(record.shortRoot.path, 'VS Code IPC short root', true)
  if (!sameIdentity(record.target.identity, target) || !sameIdentity(record.shortRoot.identity, root)) {
    fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias root or target changed identity')
  }
}
function cleanup(record, journalPath) {
  assertStaticIdentities(record)
  const child = verifyDirectory(record.child.path, record.child.identity, 'VS Code IPC alias child', true)
  if (!child) {
    for (const candidate of [record.link.path, record.link.tombstonePath]) {
      try { fs.lstatSync(candidate); fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias child disappeared with residual names') }
      catch (error) { if (error instanceof VscodeIpcAliasError) throw error; if (!error || error.code !== 'ENOENT') throw error }
    }
    record.state = 'CLEANED'; writeJournal(journalPath, record); return
  }
  const link = verifyLink(record.link.path, record.link.identity, record.link.targetPath, true)
  const tombstone = verifyLink(record.link.tombstonePath, record.link.identity, record.link.targetPath, true)
  if (link && tombstone) fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias has both live and cleanup names')
  if (!link && !tombstone && record.state !== 'RELEASING') fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias disappeared before cleanup authority')
  if (record.state !== 'RELEASING') { record.state = 'RELEASING'; writeJournal(journalPath, record) }
  if (link) {
    try { fs.renameSync(record.link.path, record.link.tombstonePath) } catch (error) { fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias could not enter cleanup quarantine', { cause: error.code }) }
    verifyLink(record.link.tombstonePath, record.link.identity, record.link.targetPath)
  }
  if (verifyLink(record.link.tombstonePath, record.link.identity, record.link.targetPath, true)) {
    if (windows()) fs.rmdirSync(record.link.tombstonePath)
    else fs.unlinkSync(record.link.tombstonePath)
  }
  const residue = fs.readdirSync(record.child.path)
  if (residue.length) fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias child contains unowned residue', { entries: residue.slice(0, 8) })
  verifyDirectory(record.child.path, record.child.identity, 'VS Code IPC alias child')
  try { fs.rmdirSync(record.child.path) } catch (error) { fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias child could not be retired', { cause: error.code }) }
  record.state = 'CLEANED'
  writeJournal(journalPath, record)
}
function expected(record) { return { ...record.binding, launchBindingHash: record.launchBindingHash } }
function owner(processOwner) {
  if (!processOwner || typeof processOwner.issueBoundDrainReceipt !== 'function' || typeof processOwner.verifyBoundDrainReceipt !== 'function') {
    fail('VSCODE_IPC_ALIAS_INVALID', 'VS Code IPC alias requires ProcessOwner drain authority')
  }
  return processOwner
}
function handleFor(journalPath, processOwner, record, options) {
  const authority = stableStringify({ binding: record.binding, launchBindingHash: record.launchBindingHash })
  const assertAuthority = current => {
    if (stableStringify({ binding: current.binding, launchBindingHash: current.launchBindingHash }) !== authority) {
      fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'VS Code IPC alias handle authority changed')
    }
  }
  let entered = record.state === 'RESERVATION_ENTERED' || record.state === 'RELEASING'
  let closed = record.state === 'CLEANED'
  const handle = Object.freeze({
    userDataDir: record.link.path,
    launchBindingHash: record.launchBindingHash,
    markReservationEntered() {
      if (closed) fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'cleaned VS Code IPC alias cannot enter reservation')
      if (entered) return
      const current = readJournal(journalPath, options)
      assertAuthority(current)
      if (current.state !== 'READY') fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'VS Code IPC alias is not ready for reservation')
      current.state = 'RESERVATION_ENTERED'; writeJournal(journalPath, current); entered = true
    },
    abortBeforeReservation() {
      if (closed) return
      if (entered) fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'VS Code IPC alias entered reservation and cannot use prelaunch cleanup')
      const capability = ACTIVE_HANDLES.get(handle)
      if (!capability || capability.journalPath !== journalPath) fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'VS Code IPC prelaunch capability is foreign')
      const current = readJournal(journalPath, options)
      assertAuthority(current)
      if (!['READY', 'ALLOCATED', 'INTENT'].includes(current.state)) fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'VS Code IPC alias cannot be aborted from its current state')
      if (current.child.identity && current.link.identity) cleanup(current, journalPath)
      else if (current.child.identity) {
        assertStaticIdentities(current)
        const child = verifyDirectory(current.child.path, current.child.identity, 'VS Code IPC alias child')
        if (fs.readdirSync(current.child.path).length) fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias allocation contains residue')
        fs.rmdirSync(current.child.path); current.state = 'CLEANED'; writeJournal(journalPath, current)
      } else { current.state = 'CLEANED'; writeJournal(journalPath, current) }
      closed = true
    },
    async release() {
      if (closed) return
      if (!entered) fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'VS Code IPC alias must enter reservation before release')
      const current = readJournal(journalPath, options)
      assertAuthority(current)
      const receipt = await processOwner.issueBoundDrainReceipt(expected(current))
      processOwner.verifyBoundDrainReceipt(receipt, expected(current))
      cleanup(current, journalPath); closed = true
    },
  })
  ACTIVE_HANDLES.set(handle, { journalPath })
  return handle
}
function prepare(options = {}) {
  const processOwner = owner(options.processOwner)
  const binding = exactBinding(options.binding)
  journalParent(options.journalPath)
  if (typeof options.targetPath !== 'string' || !path.isAbsolute(options.targetPath) || !samePath(path.resolve(options.targetPath), options.targetPath) || options.targetPath.includes('\0')) {
    fail('VSCODE_IPC_ALIAS_INVALID', 'VS Code IPC deep target path must be absolute and canonical')
  }
  const targetPath = options.targetPath
  const targetIdentity = physicalDirectory(targetPath, 'VS Code IPC deep target', true)
  const shortRoot = runtimeShortRoot(options)
  const shortRootIdentity = establishShortRoot(shortRoot)
  const childPath = path.join(shortRoot, sha256(stableStringify(binding)).slice(0, 32))
  const linkPath = path.join(childPath, 'u')
  const record = { schemaVersion: SCHEMA_VERSION, resourceType: resourceType(), binding,
    target: { path: targetPath, identity: targetIdentity }, shortRoot: { path: shortRoot, identity: shortRootIdentity },
    child: { path: childPath, identity: null }, link: { path: linkPath, tombstonePath: path.join(childPath, '.u-cleanup'), targetPath, identity: null },
    launchBindingHash: null, state: 'INTENT' }
  refreshLaunchBinding(record)
  try { atomicCreateJson(options.journalPath, record, { mode: 0o600 }) } catch (error) {
    fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'VS Code IPC alias journal could not be exclusively created', { cause: error && error.code })
  }
  try {
    fs.mkdirSync(childPath, { mode: 0o700 })
    if (windows()) require('../agents/codex/workflow/safe-run-root.js').ensureWindowsPrivateAcl(childPath)
    record.child.identity = physicalDirectory(childPath, 'VS Code IPC alias child', true)
    record.state = 'ALLOCATED'; refreshLaunchBinding(record); writeJournal(options.journalPath, record)
    fs.symlinkSync(targetPath, linkPath, windows() ? 'junction' : 'dir')
    record.link.identity = identity(fs.lstatSync(linkPath, { bigint: true }), 'symlink')
    verifyLink(linkPath, record.link.identity, targetPath)
    record.state = 'READY'; refreshLaunchBinding(record); writeJournal(options.journalPath, record)
    if (!windows() && Buffer.byteLength(path.join(linkPath, '0000-main.sock'), 'utf8') >= 103) {
      fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code IPC alias is not short enough for Darwin IPC')
    }
    if (windows() && linkPath.length >= MAX_WINDOWS_ALIAS_CHARS) fail('VSCODE_IPC_ALIAS_UNSAFE', 'VS Code storage alias is not short enough for Windows descendants')
  } catch (error) {
    // This process has not returned a launch capability yet. Retire only
    // allocations whose exact identities were captured; otherwise preserve
    // the journal and external path for conservative recovery.
    try {
      if (record.child.identity && record.link.identity) cleanup(record, options.journalPath)
      else if (record.child.identity) {
        assertStaticIdentities(record)
        verifyDirectory(record.child.path, record.child.identity, 'VS Code IPC alias child')
        if (fs.readdirSync(record.child.path).length) throw new Error('unowned residue')
        fs.rmdirSync(record.child.path); record.state = 'CLEANED'; writeJournal(options.journalPath, record)
      }
    } catch (cleanupError) {
      if (error && typeof error === 'object') error.cleanupFailure = cleanupError.code || cleanupError.message
    }
    throw error
  }
  return handleFor(options.journalPath, processOwner, record, options)
}
async function recover(options = {}) {
  const processOwner = owner(options.processOwner)
  const record = readJournal(options.journalPath, options)
  if (record.state === 'CLEANED') return Object.freeze({ userDataDir: record.link.path, launchBindingHash: record.launchBindingHash, recovered: true, cleaned: true, alreadyCleaned: true })
  if (!['RESERVATION_ENTERED', 'RELEASING'].includes(record.state)) fail('VSCODE_IPC_ALIAS_STATE_INVALID', 'VS Code IPC alias has no durable reservation entry')
  const receipt = await processOwner.issueBoundDrainReceipt(expected(record))
  processOwner.verifyBoundDrainReceipt(receipt, expected(record))
  cleanup(record, options.journalPath)
  return Object.freeze({ userDataDir: record.link.path, launchBindingHash: record.launchBindingHash, recovered: true, cleaned: true, alreadyCleaned: false })
}

module.exports = { prepare, recover, VscodeIpcAliasError }
