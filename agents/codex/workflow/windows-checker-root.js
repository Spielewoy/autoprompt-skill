'use strict'

const os = require('node:os')
const path = require('node:path')
const {
  RunRecordError, inspectPathNoFollow, auditPrivatePermissions,
  createWindowsCompilerDirectory,
} = require('./safe-run-root.js')
const { createWindowsFilesystemCapture } = require('./windows-filesystem.js')

const ROOT_ID = 'windows-checker-snapshots'
// Git for Windows rejects child GIT_DIR values longer than PATH_MAX - 40.
// Reserve the existing 81-character snapshot leaf, separator and '/.git'.
const MAX_ROOT_LENGTH = 132

function refuse(message) { throw new RunRecordError('SNAPSHOT_ROOT_UNSAFE', message) }

function createWindowsCheckerRootValidator({ owner }) {
  if (typeof owner !== 'string' || !owner) refuse('Checker storage requires its activation owner')
  return (descriptor, phase) => {
    if (process.platform !== 'win32' || descriptor.id !== ROOT_ID || descriptor.kind !== ROOT_ID || descriptor.owner !== owner ||
        typeof descriptor.path !== 'string' || !path.isAbsolute(descriptor.path) || path.resolve(descriptor.path) !== descriptor.path ||
        descriptor.path.length > MAX_ROOT_LENGTH || !/^ap-git-[A-Za-z0-9]{6}$/.test(path.basename(descriptor.path))) {
      refuse('Checker storage descriptor does not match this activation and native path policy')
    }
    const profile = os.userInfo().homedir
    if (typeof profile !== 'string' || !/^[A-Za-z]:\\/.test(profile)) refuse('Windows token profile is unavailable')
    const parent = inspectPathNoFollow(path.join(profile, 'AppData', 'Local'))
    if (!parent.exists || !parent.realpath || path.dirname(descriptor.path).toLowerCase() !== parent.realpath.toLowerCase()) {
      refuse('Checker storage is outside the physical Windows token application directory')
    }
    if (descriptor.status === 'CLEANED') return true
    const current = inspectPathNoFollow(descriptor.path)
    if (!current.exists) {
      if (phase === 'load' || phase === 'cleanup') return true
      refuse('Registered checker storage is missing')
    }
    if (!current.realpath || current.realpath.toLowerCase() !== descriptor.path.toLowerCase()) refuse('Checker storage changed its physical path')
    auditPrivatePermissions(descriptor.path, { recurse: false })
    return true
  }
}

function resolveCheckerSnapshotRoot({ snapshotRoot, cleanupRegistry, owner }) {
  if (process.platform !== 'win32') return path.resolve(snapshotRoot)
  if (!cleanupRegistry || typeof cleanupRegistry.getExternalRoot !== 'function' || typeof cleanupRegistry.registerExternalRoot !== 'function') {
    refuse('Windows checker storage requires durable external-root cleanup authority')
  }
  const existing = cleanupRegistry.getExternalRoot(ROOT_ID)
  if (existing) return existing.path
  const root = createWindowsCompilerDirectory('ap-git-')
  const native = createWindowsFilesystemCapture()
  let identity
  try {
    identity = native.inspectOwnedTarget(root)
    createWindowsCheckerRootValidator({ owner })({ id: ROOT_ID, kind: ROOT_ID, owner, path: root, status: 'REGISTERED' }, 'register')
  } catch (error) {
    // Bind rollback to the allocation's physical identity. The native helper
    // refuses replacement and nonempty storage, including unregistered bytes.
    if (identity) {
      try { native.removeOwnedEmptyDirectory(root, identity.parentIdentity, identity.targetIdentity) } catch {}
    }
    throw error
  }
  // Publication may have committed before a later durability error. Retain
  // storage on any registration failure so recovery can use that authority.
  cleanupRegistry.registerExternalRoot({ id: ROOT_ID, kind: ROOT_ID, owner, path: root })
  return root
}

module.exports = { createWindowsCheckerRootValidator, resolveCheckerSnapshotRoot }
