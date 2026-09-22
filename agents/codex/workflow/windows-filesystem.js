#!/usr/bin/env node
'use strict'

// Unwired controller binding: native proof is required before activation.
// The helper retains HANDLE authority; only closed, bounded captures cross it.
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createWindowsCompilerDirectory, windowsControllerEnvironment } = require('./safe-run-root.js')
const MAX_RECORD_BYTES = 8 * 1024 * 1024 + 1
const MAX_TREE_ENTRIES = 16384
const MAX_RECORD_ENTRIES = 4096
const MAX_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024
const IDENTITY = /^[0-9a-f]{8}:[0-9a-f]{16}$/u
const DIGEST = /^[a-f0-9]{64}$/u

class WindowsFilesystemError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'WindowsFilesystemError'; this.code = code; this.details = details }
}
function fail(code, message) { throw new WindowsFilesystemError(code, message) }
function invocationDiagnostics(stderr) {
  const phases = ['input', 'input-encoding-created', 'input-encoding-set', 'input-initialized', 'input-reading', 'input-eof', 'compile', 'compiled', 'dispatch', 'completed']
  const phaseElapsedMs = {}; let index = 0, previous = 0
  let remaining = String(stderr || '')
  for (const phase of phases) {
    const match = /^AUTOPROMPT_CAPTURE_PHASE:([a-z-]+):(0|[1-9][0-9]{0,5})\r?\n/u.exec(remaining)
    if (!match || match[1] !== phase) break
    const elapsed = Number(match[2])
    if (elapsed > 300000 || elapsed < previous) break
    phaseElapsedMs[phase] = elapsed; previous = elapsed
    remaining = remaining.slice(match[0].length); index++
  }
  return { helperPhase: index ? phases[index - 1] : 'startup', phaseElapsedMs, stderr: remaining }
}
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function bounded(value, max) { return Number.isSafeInteger(value) && value >= 0 && value <= max }
function validComponent(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' &&
    !/[\\/:\x00-\x1f?*<>|"]/u.test(value) && !/[. ]$/u.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value
}
function parseStat(stat, identity, directory, attributes) {
  if (!exact(stat, ['dev', 'ino', 'mode', 'nlink', 'size']) || typeof stat.dev !== 'string' || typeof stat.ino !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,19})$/u.test(stat.dev) || !/^(?:0|[1-9][0-9]{0,19})$/u.test(stat.ino) ||
      BigInt(stat.dev) !== BigInt('0x' + identity.slice(0, 8)) || BigInt(stat.ino) !== BigInt('0x' + identity.slice(9)) ||
      !bounded(stat.mode, 0xffff) || (stat.mode & 0o170000) !== (directory ? 0o040000 : 0o100000) ||
      !bounded(stat.nlink, 0xffffffff) || stat.nlink < 1 || (!directory && stat.nlink !== 1) || !bounded(stat.size, MAX_BYTES)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture stat is malformed')
  const allowed = [0o444, 0o666]
  if (!allowed.includes(stat.mode & 0o777) || (attributes !== undefined && (stat.mode & 0o777) !== allowed[(attributes & 1) ? 0 : 1])) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture stat permissions are malformed')
  return Object.freeze({ ...stat })
}
function fileContent(value) {
  if (typeof value.dataBase64 !== 'string' || value.dataBase64.length !== Math.ceil(value.length / 3) * 4) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture bytes are malformed')
  const content = Buffer.from(value.dataBase64, 'base64')
  if (content.toString('base64') !== value.dataBase64 || content.length !== value.length || crypto.createHash('sha256').update(content).digest('hex') !== value.sha256) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture bytes are not bound to digest')
  return content
}
function parseTree(value) {
  if (!exact(value, ['schemaVersion', 'status', 'operation', 'bytes', 'entries']) || value.schemaVersion !== 1 || value.status !== 'TREE_CAPTURED' || value.operation !== 'tree' ||
      !bounded(value.bytes, MAX_BYTES) || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_TREE_ENTRIES) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows tree capture is malformed')
  const seen = new Map(), identities = new Set()
  let bytes = 0
  const entries = value.entries.map((entry, index) => {
    if (!entry || !['file', 'directory'].includes(entry.type) || typeof entry.path !== 'string' ||
        (index === 0 ? entry.path !== '' || entry.type !== 'directory' : !entry.path || !entry.path.split('/').every(validComponent)) ||
        entry.path.split('/').length > 128 || typeof entry.identity !== 'string' || !IDENTITY.test(entry.identity) ||
        !bounded(entry.attributes, 0xffffffff) || (entry.attributes & 0x400) || Boolean(entry.attributes & 0x10) !== (entry.type === 'directory')) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows tree entry is malformed')
    const key = entry.path.toUpperCase()
    if (seen.has(key) || identities.has(entry.identity) || (index && entry.identity.slice(0, 8) !== value.entries[0].identity.slice(0, 8))) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows tree identity is ambiguous')
    if (index) {
      const separator = entry.path.lastIndexOf('/')
      const parent = separator < 0 ? '' : entry.path.slice(0, separator)
      if (seen.get(parent.toUpperCase())?.type !== 'directory' || seen.get(parent.toUpperCase()).path !== parent) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows tree ancestry is malformed')
    }
    const common = ['identity', 'path', 'type', 'attributes', 'stat']
    const stat = parseStat(entry.stat, entry.identity, entry.type === 'directory', entry.attributes)
    let content
    if (entry.type === 'file') {
      if (!exact(entry, [...common, 'length', 'sha256', 'dataBase64']) || !bounded(entry.length, MAX_BYTES - bytes) || typeof entry.sha256 !== 'string' || !DIGEST.test(entry.sha256)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows tree file is malformed')
      if (stat.size !== entry.length) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows tree file size is malformed')
      content = fileContent(entry); bytes += entry.length
    } else if (!exact(entry, common)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows tree directory is malformed')
    // Match Node's Windows stat permission projection for the shared digest.
    const mode = (entry.attributes & 1) ? 0o444 : 0o666
    const result = Object.freeze({ ...entry, stat, mode, ...(content ? { content } : {}) })
    seen.set(key, result); identities.add(entry.identity)
    return result
  })
  if (bytes !== value.bytes) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows tree byte count is malformed')
  const children = new Map()
  for (const entry of entries.slice(1)) {
    const separator = entry.path.lastIndexOf('/')
    const parent = separator < 0 ? '' : entry.path.slice(0, separator)
    const list = children.get(parent) || []; list.push(entry); children.set(parent, list)
  }
  for (const list of children.values()) list.sort((a, b) => path.posix.basename(a.path).localeCompare(path.posix.basename(b.path)))
  const hash = crypto.createHash('sha256')
  const visit = parent => {
    for (const entry of children.get(parent) || []) {
      if (entry.type === 'directory') { hash.update('directory\0' + entry.path + '\0' + entry.mode + '\0'); visit(entry.path) }
      else { hash.update('file\0' + entry.path + '\0' + entry.mode + '\0' + entry.length + '\0'); hash.update(entry.content); hash.update('\0') }
    }
  }
  visit('')
  return Object.freeze({ ...value, entries: Object.freeze(entries), hash: hash.digest('hex') })
}
function parseCapture(stdout, operation) {
  if (!['read', 'hash', 'tree'].includes(operation)) fail('FILESYSTEM_BACKEND_INVALID', 'Windows capture operation is invalid')
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture response is too large')
  let value; try { value = JSON.parse(stdout) } catch { fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture response is not JSON') }
  if (value && value.status === 'REFUSED') {
    if (!exact(value, ['schemaVersion', 'status', 'code']) || value.schemaVersion !== 1 || typeof value.code !== 'string' || !/^[A-Z_]{3,80}$/u.test(value.code)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture refusal is malformed')
    fail(value.code === 'FILESYSTEM_NOT_FOUND' ? 'ENOENT' : value.code, 'Windows capture helper refused request')
  }
  if (operation === 'tree') return parseTree(value)
  const keys = operation === 'read' ? ['schemaVersion', 'status', 'operation', 'identity', 'length', 'sha256', 'stat', 'dataBase64'] : ['schemaVersion', 'status', 'operation', 'identity', 'length', 'sha256', 'stat']
  if (!exact(value, keys) || value.schemaVersion !== 1 || value.status !== 'CAPTURED' || value.operation !== operation ||
      typeof value.identity !== 'string' || !IDENTITY.test(value.identity) || !bounded(value.length, MAX_BYTES) || typeof value.sha256 !== 'string' || !DIGEST.test(value.sha256)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture response is malformed')
  const stat = parseStat(value.stat, value.identity, false)
  if (stat.size !== value.length) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture file size is malformed')
  return Object.freeze({ ...value, stat, entries: Object.freeze([Object.freeze({ path: '', type: 'file', stat })]), hash: value.sha256, bytes: value.length, ...(operation === 'read' ? { content: fileContent(value) } : {}) })
}
function validateOwnedIdentity(value, target, code = 'FILESYSTEM_BACKEND_INVALID') {
  if (!exact(value, target ? ['type', 'dev', 'ino'] : ['dev', 'ino']) || (target && !['file', 'directory'].includes(value.type)) ||
      typeof value.dev !== 'string' || typeof value.ino !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value.dev) || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value.ino) ||
      BigInt(value.dev) > 0xffffffffn || BigInt(value.ino) > 0xffffffffffffffffn) fail(code, 'Windows owned target identity is malformed')
  return Object.freeze({ ...value })
}
function parseRecordResult(stdout, operation, content, leaf) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 2 * 1024 * 1024) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows record response is too large')
  let value; try { value = JSON.parse(stdout) } catch { fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows record response is not JSON') }
  if (value?.status === 'REFUSED') {
    if (!exact(value, ['schemaVersion', 'status', 'code']) || value.schemaVersion !== 1 || typeof value.code !== 'string' || !/^[A-Z_]{3,80}$/u.test(value.code)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows record refusal is malformed')
    fail(value.code === 'FILESYSTEM_ALREADY_EXISTS' ? 'EEXIST' : value.code === 'FILESYSTEM_NOT_FOUND' ? 'ENOENT' : value.code, `Windows record helper refused ${operation}`)
  }
  if (operation === 'inspect-owned-target') {
    if (!exact(value, ['schemaVersion', 'status', 'parentIdentity', 'targetIdentity']) || value.schemaVersion !== 1 || value.status !== 'INSPECTED') fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows target inspection is malformed')
    const parentIdentity = validateOwnedIdentity(value.parentIdentity, false, 'FILESYSTEM_BACKEND_UNAVAILABLE')
    const targetIdentity = validateOwnedIdentity(value.targetIdentity, true, 'FILESYSTEM_BACKEND_UNAVAILABLE')
    if (parentIdentity.dev !== targetIdentity.dev) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows target crosses a volume')
    return Object.freeze({ parentIdentity, targetIdentity })
  }
  if (operation === 'remove-owned-target') {
    if (!exact(value, ['schemaVersion', 'status', 'removed']) || value.schemaVersion !== 1 || value.status !== 'REMOVED' || typeof value.removed !== 'boolean') fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows target removal is malformed')
    return Object.freeze({ removed: value.removed })
  }
  if (operation === 'recover-record-publication') {
    if (!exact(value, ['schemaVersion', 'status', 'removed']) || value.schemaVersion !== 1 || value.status !== 'RECOVERED' || !validComponent(leaf) ||
        !Array.isArray(value.removed) || value.removed.length > MAX_RECORD_ENTRIES || new Set(value.removed).size !== value.removed.length) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows record recovery response is malformed')
    const prefix = '.' + leaf + '.'
    for (const name of value.removed) {
      if (!validComponent(name) || !name.startsWith(prefix) || !/^[1-9][0-9]{0,9}\.[a-f0-9]{16}\.(?:tmp|create)$/u.test(name.slice(prefix.length)) ||
          Number(name.slice(prefix.length).split('.')[0]) > 0xffffffff) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows recovered record name is malformed')
    }
    return Object.freeze(value.removed.slice())
  }
  const publish = operation === 'publish-record-exclusive'
  if (!['assert-record-parent', 'publish-record-exclusive'].includes(operation) || !exact(value, publish ? ['schemaVersion', 'status', 'identity', 'stat', 'length', 'sha256'] : ['schemaVersion', 'status', 'identity', 'stat']) ||
      value.schemaVersion !== 1 || value.status !== (publish ? 'PUBLISHED' : 'PARENT_VERIFIED') || typeof value.identity !== 'string' || !IDENTITY.test(value.identity)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows record response is malformed')
  const stat = parseStat(value.stat, value.identity, !publish)
  if (publish && (!Buffer.isBuffer(content) || content.length > MAX_RECORD_BYTES || value.length !== content.length || stat.size !== content.length ||
      typeof value.sha256 !== 'string' || value.sha256 !== crypto.createHash('sha256').update(content).digest('hex'))) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows published record is not bound to its bytes')
  return Object.freeze({ stat })
}
const TRANSACTIONS = new Set(['fsync-directory', 'fsync-tree', 'mkdir-exclusive', 'write-exclusive', 'copy-tree-exclusive', 'rename-tree-no-replace'])
function parseTransactionResult(stdout, operation, content, mode) {
  if (!TRANSACTIONS.has(operation) || typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16384) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows transaction response is invalid')
  let value; try { value = JSON.parse(stdout) } catch { fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows transaction response is invalid JSON') }
  if (exact(value, ['schemaVersion', 'status', 'code']) && value.schemaVersion === 1 && value.status === 'REFUSED' && typeof value.code === 'string' && /^[A-Z_]{3,80}$/.test(value.code)) {
    fail(({ FILESYSTEM_ALREADY_EXISTS: 'EEXIST', FILESYSTEM_NOT_FOUND: 'ENOENT', FILESYSTEM_CROSS_DEVICE: 'EXDEV' })[value.code] || value.code, 'Windows transaction refused request')
  }
  if (!exact(value, ['schemaVersion', 'status', 'operation', 'result']) || value.schemaVersion !== 1 || value.status !== 'TRANSACTED' || value.operation !== operation) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows transaction response is malformed')
  const result = value.result
  if (operation.startsWith('fsync-')) {
    if (!exact(result, ['flushed']) || typeof result.flushed !== 'boolean' || (operation === 'fsync-directory' && !result.flushed)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows durability response is malformed')
    return Object.freeze({ flushed: result.flushed })
  }
  const write = operation === 'write-exclusive'
  if (!exact(result, write ? ['identity', 'stat', 'type', 'length', 'sha256'] : ['identity', 'stat', 'type']) || typeof result.identity !== 'string' || !IDENTITY.test(result.identity) || !['file', 'directory'].includes(result.type) || (operation === 'mkdir-exclusive' && result.type !== 'directory') || (write && result.type !== 'file')) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows transaction identity is malformed')
  const stat = parseStat(result.stat, result.identity, result.type === 'directory')
  if ((write || operation === 'mkdir-exclusive') && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777 || (stat.mode & 0o777) !== ((mode & 0o222) ? 0o666 : 0o444))) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows transaction mode is unbound')
  if (write && (!Buffer.isBuffer(content) || result.length !== content.length || stat.size !== content.length || result.sha256 !== crypto.createHash('sha256').update(content).digest('hex'))) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows transaction bytes are unbound')
  return Object.freeze({ stat })
}
function transactionMode(mode) {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) fail('FILESYSTEM_BACKEND_INVALID', 'Windows transaction mode is invalid')
  return mode
}
function requestTarget(root, components) {
  if (components === undefined) {
    if (typeof root !== 'string' || !/^[A-Za-z]:\\/u.test(root) || path.win32.normalize(root) !== root) fail('FILESYSTEM_BACKEND_INVALID', 'Windows capture path is not canonical')
    components = root.slice(3).split('\\'); root = root.slice(0, 3)
  }
  if (typeof root !== 'string' || !/^[A-Za-z]:\\$/u.test(root) || !Array.isArray(components) || components.length < 1 || components.length > 128 || !components.every(validComponent)) fail('FILESYSTEM_BACKEND_INVALID', 'Windows capture request is invalid')
  return { root, components }
}
function sameStat(a, b) {
  return a.isFile() && b.isFile() && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino) &&
    a.size === b.size && a.mode === b.mode && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}
function bindPhysical(filename, label, maxBytes, singleLink) {
  if (typeof filename !== 'string' || !/^[A-Za-z]:\\/u.test(filename) || path.win32.normalize(filename) !== filename) fail('FILESYSTEM_BACKEND_INVALID', label + ' must be an absolute physical path')
  let descriptor
  try {
    const named = fs.lstatSync(filename), canonical = fs.realpathSync.native(filename)
    if (!named.isFile() || named.isSymbolicLink() || canonical.toLowerCase() !== filename.toLowerCase() ||
        !bounded(named.size, maxBytes) || named.size < 1 || (singleLink && named.nlink !== 1)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', label + ' is not a bounded physical file')
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY)
    const stat = fs.fstatSync(descriptor)
    if (!sameStat(named, stat)) fail('FILESYSTEM_BACKEND_MISMATCH', label + ' changed while opening')
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, stat.size)), hash = crypto.createHash('sha256')
    for (let offset = 0; offset < stat.size;) {
      const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
      if (read < 1) fail('FILESYSTEM_BACKEND_MISMATCH', label + ' changed while reading')
      hash.update(buffer.subarray(0, read)); offset += read
    }
    if (!sameStat(stat, fs.fstatSync(descriptor)) || !sameStat(stat, fs.lstatSync(canonical)) || fs.realpathSync.native(filename).toLowerCase() !== canonical.toLowerCase()) fail('FILESYSTEM_BACKEND_MISMATCH', label + ' changed while binding')
    return { descriptor, stat, binding: Object.freeze({ path: canonical, sha256: hash.digest('hex'), device: String(stat.dev), inode: String(stat.ino), size: stat.size }) }
  } catch (error) {
    if (Number.isInteger(descriptor)) fs.closeSync(descriptor)
    if (error instanceof WindowsFilesystemError) throw error
    fail('FILESYSTEM_BACKEND_UNAVAILABLE', label + ' is unavailable')
  }
}
function equalBinding(a, b) { return a.path === b.path && a.sha256 === b.sha256 && a.device === b.device && a.inode === b.inode && a.size === b.size }
function createWindowsFilesystemCapture(options = {}) {
  if (process.platform !== 'win32') fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows filesystem capture is unavailable on this platform')
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows system root is unavailable')
  const helper = options.helper || path.join(__dirname, 'windows-filesystem.ps1')
  const powershell = options.powershell || path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const initialHelper = bindPhysical(helper, 'Windows filesystem helper', 4 * 1024 * 1024, true)
  let initialPowerShell
  try { initialPowerShell = bindPhysical(powershell, 'Windows PowerShell', MAX_BYTES, false) } finally { fs.closeSync(initialHelper.descriptor) }
  fs.closeSync(initialPowerShell.descriptor)
  const helperBinding = initialHelper.binding, powershellBinding = initialPowerShell.binding
  const invoke = (operation, root, components, maxBytes = MAX_BYTES, recordBytes, ownership) => {
    const target = requestTarget(root, components)
    if (!bounded(maxBytes, MAX_BYTES)) fail('FILESYSTEM_BACKEND_INVALID', 'Windows capture byte limit is invalid')
    // Large copies perform creation, exact readback, and final durability checks
    // for every object; all other operations retain the shorter deadline.
    const timeoutMs = operation === 'copy-tree-exclusive' ? 120000 : 30000
    const transaction = TRANSACTIONS.has(operation)
    const publish = operation === 'publish-record-exclusive' || operation === 'write-exclusive'
    if (publish && (!Buffer.isBuffer(recordBytes) || recordBytes.length > MAX_RECORD_BYTES)) fail('FILESYSTEM_BACKEND_INVALID', 'Windows record bytes exceed the publication limit')
    const request = JSON.stringify({ schemaVersion: 1, operation, ...target, ...(publish ? { ...ownership, bytesBase64: recordBytes.toString('base64') } : ownership ? ownership : { maxBytes }) })
    if (Buffer.byteLength(request, 'utf8') > (publish ? 12 * 1024 * 1024 : 16384)) fail('FILESYSTEM_BACKEND_INVALID', 'Windows capture request is too large')
    const heldHelper = bindPhysical(helperBinding.path, 'Windows filesystem helper', 4 * 1024 * 1024, true)
    let heldPowerShell, temporary
    try {
      heldPowerShell = bindPhysical(powershellBinding.path, 'Windows PowerShell', MAX_BYTES, false)
      if (!equalBinding(heldHelper.binding, helperBinding) || !equalBinding(heldPowerShell.binding, powershellBinding)) fail('FILESYSTEM_BACKEND_MISMATCH', 'Windows filesystem runtime changed after binding')
      temporary = createWindowsCompilerDirectory('autoprompt-windows-capture-')
      const invocationStarted = process.hrtime.bigint()
      const result = cp.spawnSync(powershellBinding.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperBinding.path, '-Request'], {
        input: request, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false,
        cwd: path.win32.dirname(powershellBinding.path),
        env: { ...windowsControllerEnvironment(systemRoot, temporary), AUTOPROMPT_CAPTURE_PHASES: '1' },
      })
      const invocationElapsedMs = Number((process.hrtime.bigint() - invocationStarted) / 1000000n)
      for (const [held, expected, label, cap, singleLink] of [[heldHelper, helperBinding, 'Windows filesystem helper', 4 * 1024 * 1024, true], [heldPowerShell, powershellBinding, 'Windows PowerShell', MAX_BYTES, false]]) {
        const after = bindPhysical(expected.path, label, cap, singleLink)
        try {
          if (!sameStat(held.stat, fs.fstatSync(held.descriptor)) || !equalBinding(after.binding, expected)) fail('FILESYSTEM_BACKEND_MISMATCH', label + ' changed during invocation')
        } finally { fs.closeSync(after.descriptor) }
      }
      const diagnostic = invocationDiagnostics(result.stderr)
      if (result.error || result.signal || result.status !== 0 || diagnostic.stderr) {
        const cause = typeof result.error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(result.error.code) ? result.error.code : `status ${result.status}`
        const unaccountedMs = Math.max(0, invocationElapsedMs - (diagnostic.phaseElapsedMs[diagnostic.helperPhase] || 0))
        const timings = Object.entries(diagnostic.phaseElapsedMs).map(([phase, elapsed]) => `${phase}=${elapsed}`).join(',') || 'none'
        throw new WindowsFilesystemError('FILESYSTEM_BACKEND_UNAVAILABLE', `Windows capture helper invocation failed (${diagnostic.helperPhase}: ${cause}; totalMs=${invocationElapsedMs}; phaseMs=${timings}; unaccountedMs=${unaccountedMs})`, {
          stage: 'windows-capture-invocation', helperPhase: diagnostic.helperPhase, phaseElapsedMs: diagnostic.phaseElapsedMs,
          invocationElapsedMs,
          // Includes startup before the script clock and work since the last
          // marker; it cannot identify either interval independently.
          unaccountedMs,
          status: result.status,
          cause: result.error?.code, signal: result.signal, timeoutMs, stderr: diagnostic.stderr.slice(0, 2048),
        })
      }
      if (transaction) return parseTransactionResult(result.stdout, operation, recordBytes, ownership?.mode)
      if (publish || operation === 'assert-record-parent' || operation === 'recover-record-publication' || operation === 'inspect-owned-target' || operation === 'remove-owned-target') return parseRecordResult(result.stdout, operation, recordBytes, target.components.at(-1))
      const captured = parseCapture(result.stdout, operation)
      if (captured.bytes > maxBytes) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Windows capture exceeds the request byte limit')
      return captured
    } finally {
      fs.closeSync(heldHelper.descriptor)
      if (heldPowerShell) fs.closeSync(heldPowerShell.descriptor)
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
  return Object.freeze({ kind: 'windows-handle-capture-v1',
    fsyncDirectory: absolute => invoke('fsync-directory', absolute),
    fsyncTree: absolute => invoke('fsync-tree', absolute),
    mkdirExclusive: (absolute, mode = 0o700) => invoke('mkdir-exclusive', absolute, undefined, MAX_BYTES, undefined, { mode: transactionMode(mode) }),
    writeExclusive: (absolute, bytes, mode = 0o600) => invoke('write-exclusive', absolute, undefined, MAX_RECORD_BYTES, bytes, { mode: transactionMode(mode) }),
    copyTreeExclusive: (source, destination) => invoke('copy-tree-exclusive', source, undefined, MAX_BYTES, undefined, { destination: requestTarget(destination) }),
    renameTreeNoReplace: (source, destination) => invoke('rename-tree-no-replace', source, undefined, MAX_BYTES, undefined, { destination: requestTarget(destination) }),
    inspectOwnedTarget: absolute => invoke('inspect-owned-target', absolute, undefined, 0),
    removeOwnedTarget: (absolute, parentIdentity, targetIdentity) => invoke('remove-owned-target', absolute, undefined, 0, undefined, { parentIdentity: validateOwnedIdentity(parentIdentity, false), targetIdentity: validateOwnedIdentity(targetIdentity, true) }),
    assertRecordParent: absolute => invoke('assert-record-parent', absolute, undefined, 0),
    publishRecordExclusive: (absolute, bytes) => invoke('publish-record-exclusive', absolute, undefined, MAX_RECORD_BYTES, bytes),
    recoverRecordPublication: absolute => invoke('recover-record-publication', absolute, undefined, 0),
    helper: helperBinding, powershell: powershellBinding, captureFileBytes: (root, components, maxBytes) => invoke('read', root, components, maxBytes), captureFile: (root, components, maxBytes) => invoke('hash', root, components, maxBytes), captureTree: (root, components, maxBytes) => invoke('tree', root, components, maxBytes) })
}
function createWindowsFilesystemMutations(options = {}) { return createWindowsFilesystemCapture(options) }
module.exports = { WindowsFilesystemError, invocationDiagnostics, parseCapture, parseRecordResult, parseTransactionResult, createWindowsFilesystemCapture, createWindowsFilesystemMutations }
