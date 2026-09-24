'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { ensureWindowsPrivateAcl, auditPrivatePermissions, createWindowsCompilerDirectory, windowsControllerEnvironment, inspectPathNoFollow } = require('./safe-run-root.js')
const { createWindowsFilesystemCapture } = require('./windows-filesystem.js')
const FILES = Object.freeze(['windows-appcontainer.ps1', 'windows-appcontainer-native.cs',
  'windows-appcontainer-resources.ps1', 'windows-appcontainer-resources-native.cs'])
function fail(message) { const error = new Error(message); error.code = 'WINDOWS_RUNTIME_MISMATCH'; throw error }
function same(a, b) { return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]) }
function readHelper(file) {
  if (fs.realpathSync.native(file).toLowerCase() !== path.resolve(file).toLowerCase()) fail('Native helper source must be canonical')
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || (cursor !== file && !stat.isDirectory())) fail('Native helper source ancestry must be physical')
    if (cursor === path.parse(cursor).root) break
  }
  const before = fs.lstatSync(file, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 4n * 1024n * 1024n) fail('Native helper source must be bounded and singly linked')
  const fd = fs.openSync(file, 'r')
  try {
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) fail('Native helper source changed while opening')
    const bytes = fs.readFileSync(fd)
    if (BigInt(bytes.length) !== before.size || !same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true }))) fail('Native helper source changed while reading')
    return bytes
  } finally { fs.closeSync(fd) }
}
function physicalDirectory(root) {
  let item
  try { item = inspectPathNoFollow(root) } catch { fail('Private helper deployment must be a physical directory') }
  if (!item.exists || !item.realpath || !item.identity) fail('Private helper deployment must be a physical directory')
  return item
}
function sameWindowsPath(left, right) { return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase() }
function helperCleanupBinding(root, identity) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !identity || typeof identity !== 'object' ||
      !/^(?:0|[1-9][0-9]*)$/u.test(String(identity.dev)) || !/^(?:0|[1-9][0-9]*)$/u.test(String(identity.ino))) fail('Private helper cleanup binding is invalid')
  return Object.freeze({ root, identity: Object.freeze({ dev: String(identity.dev), ino: String(identity.ino) }) })
}
function assertTrustedWindowsHelperDeployment(controlRoot, root) {
  if (process.platform !== 'win32' || typeof controlRoot !== 'string' || !path.isAbsolute(controlRoot) || typeof root !== 'string' || !path.isAbsolute(root) ||
      !/^native-helpers-[A-Za-z0-9]{6}$/u.test(path.basename(root))) fail('Private helper deployment is invalid')
  const capture = createWindowsFilesystemCapture()
  const control = physicalDirectory(controlRoot)
  const deployment = physicalDirectory(root)
  const parent = physicalDirectory(path.dirname(root))
  if (sameWindowsPath(parent.realpath, control.realpath)) {
    capture.assertRecordParent(path.join(root, 'native-helper-parent-check'))
  } else {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR
    let environment
    try { environment = windowsControllerEnvironment(systemRoot) } catch { fail('Private helper deployment profile root is unavailable') }
    const trustedParent = physicalDirectory(environment.LOCALAPPDATA)
    if (!sameWindowsPath(parent.realpath, trustedParent.realpath)) fail('Private helper deployment is outside the authenticated token profile')
    // LOCALAPPDATA itself is intentionally inherited.  The direct child is
    // independently ACL-protected and nofollow-bound before it is accepted.
    try { auditPrivatePermissions(deployment.realpath, { recurse: false }) }
    catch { fail('Private helper deployment is not private') }
    capture.assertRecordParent(path.join(deployment.realpath, 'native-helper-parent-check'))
  }
  return Object.freeze({ root: deployment.realpath, identity: deployment.identity })
}
function cleanupWindowsHelperDeployment(controlRoot, binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).sort().join(',') !== 'identity,root' ||
      !binding.identity || typeof binding.identity !== 'object' || Array.isArray(binding.identity) || Object.keys(binding.identity).sort().join(',') !== 'dev,ino') {
    fail('Private helper cleanup binding is invalid')
  }
  const expected = helperCleanupBinding(binding.root, binding.identity)
  if (!fs.existsSync(expected.root)) return Object.freeze({ removed: false, absent: true })
  const trusted = process.platform === 'win32' ? assertTrustedWindowsHelperDeployment(controlRoot, expected.root) : physicalDirectory(expected.root)
  if (trusted.identity.dev !== expected.identity.dev || trusted.identity.ino !== expected.identity.ino) fail('Private helper deployment changed before cleanup')
  fs.rmSync(expected.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (fs.existsSync(expected.root)) fail('Private helper deployment remained after cleanup')
  return Object.freeze({ removed: true, absent: false })
}
function stageWindowsHelperDeployment(controlRoot, options = {}) {
  if (process.platform !== 'win32') fail('Private Windows helper deployment requires Windows')
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'shortPrivateRoot') ||
      options.shortPrivateRoot !== undefined && options.shortPrivateRoot !== true) fail('Private Windows helper deployment options are invalid')
  const capture = createWindowsFilesystemCapture()
  // Ordinary npm/source installs inherit their directory ACLs. Never relabel
  // those shared paths: copy the exact helper closure into controller storage.
  capture.assertRecordParent(path.join(controlRoot, 'native-helper-parent-check'))
  // PowerShell/.NET helper startup cannot consume deeply nested controller
  // paths before its own long-path policy is active.  The optional compiler
  // root is a direct, token-backed LOCALAPPDATA child with its own protected
  // DACL; its exact path and helper bytes remain sealed into the broker
  // request for recovery.
  const root = options.shortPrivateRoot ? createWindowsCompilerDirectory('native-helpers-') : fs.mkdtempSync(path.join(controlRoot, 'native-helpers-'))
  const created = physicalDirectory(root)
  const cleanupBinding = helperCleanupBinding(created.realpath, created.identity)
  const removeCreated = () => cleanupWindowsHelperDeployment(controlRoot, cleanupBinding)
  try {
    ensureWindowsPrivateAcl(root)
    capture.assertRecordParent(path.join(root, 'native-helper-parent-check'))
    for (const name of FILES) {
      const bytes = readHelper(path.join(__dirname, name))
      const destination = path.join(root, name)
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
      if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(readHelper(destination)).digest(), crypto.createHash('sha256').update(bytes).digest())) fail('Staged native helper bytes changed')
    }
    const binding = assertTrustedWindowsHelperDeployment(controlRoot, root)
    if (binding.identity.dev !== created.identity.dev || binding.identity.ino !== created.identity.ino) fail('Private helper deployment changed while staging')
    return Object.freeze({ root: binding.root, cleanupBinding, cleanup: removeCreated })
  } catch (error) {
    try { removeCreated() }
    catch (cleanup) {
      error.cleanupConfirmed = false
      error.retainedHelperRoot = root
      error.cleanupCode = String(cleanup.code || 'cleanup-failed').slice(0, 64)
    }
    throw error
  }
}
module.exports = { stageWindowsHelperDeployment, assertTrustedWindowsHelperDeployment, cleanupWindowsHelperDeployment }
