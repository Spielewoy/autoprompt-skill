'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  RunRecordError, inspectPathNoFollow, auditPrivatePermissions,
  createWindowsCompilerDirectory, pathIsInside, readFileNoFollow,
} = require('./safe-run-root.js')
const { CleanupRegistry } = require('./finalizer.js')
const { createWindowsFilesystemCapture } = require('./windows-filesystem.js')

const ROOT_POLICIES = Object.freeze({
  'windows-checker-snapshots': Object.freeze({ prefix: 'ap-git-', leaf: /^[a-f0-9]{64}-[a-f0-9]{16}$/, entryKind: 'checker-snapshot' }),
  'windows-worker-workspaces': Object.freeze({ prefix: 'ap-work-', leaf: /^[a-f0-9]{40}$/, entryKind: 'worker-workspace' }),
})
// Git for Windows rejects child GIT_DIR values longer than PATH_MAX - 40.
// Reserve the existing 81-character snapshot leaf, separator and '/.git'.
const MAX_ROOT_LENGTH = 132

function refuse(message) { throw new RunRecordError('SNAPSHOT_ROOT_UNSAFE', message) }

function createWindowsGitRootValidator({ owner }) {
  if (typeof owner !== 'string' || !owner) refuse('Checker storage requires its activation owner')
  return (descriptor, phase) => {
    const policy = Object.hasOwn(ROOT_POLICIES, descriptor.id) && ROOT_POLICIES[descriptor.id]
    if (process.platform !== 'win32' || !policy || descriptor.kind !== descriptor.id || descriptor.owner !== owner ||
        typeof descriptor.path !== 'string' || !path.isAbsolute(descriptor.path) || path.resolve(descriptor.path) !== descriptor.path ||
        descriptor.path.length > MAX_ROOT_LENGTH || !new RegExp(`^${policy.prefix}[A-Za-z0-9]{6}$`).test(path.basename(descriptor.path))) {
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

function resolveGitStorageRoot({ fallbackRoot, cleanupRegistry, owner, rootId }) {
  if (process.platform !== 'win32') return path.resolve(fallbackRoot)
  if (!cleanupRegistry || typeof cleanupRegistry.getExternalRoot !== 'function' || typeof cleanupRegistry.registerExternalRoot !== 'function') {
    refuse('Windows checker storage requires durable external-root cleanup authority')
  }
  const existing = cleanupRegistry.getExternalRoot(rootId)
  if (existing) return existing.path
  const root = createWindowsCompilerDirectory(ROOT_POLICIES[rootId].prefix)
  const native = createWindowsFilesystemCapture()
  let identity
  try {
    identity = native.inspectOwnedTarget(root)
    createWindowsGitRootValidator({ owner })({ id: rootId, kind: rootId, owner, path: root, status: 'REGISTERED' }, 'register')
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
  cleanupRegistry.registerExternalRoot({ id: rootId, kind: rootId, owner, path: root })
  return root
}

function resolveCheckerSnapshotRoot({ snapshotRoot, cleanupRegistry, owner }) {
  return resolveGitStorageRoot({ fallbackRoot: snapshotRoot, cleanupRegistry, owner, rootId: 'windows-checker-snapshots' })
}

function resolveWorkerWorkspaceRoot({ workspaceRoot, cleanupRegistry, owner }) {
  return resolveGitStorageRoot({ fallbackRoot: workspaceRoot, cleanupRegistry, owner, rootId: 'windows-worker-workspaces' })
}

function readPrivateJson(filename, label) {
  let bytes
  try { bytes = readFileNoFollow(filename) } catch (error) {
    refuse(`${label} is not one private regular file (${error.code || error.message})`)
  }
  if (!bytes) refuse(`${label} is missing`)
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) } } catch {
    refuse(`${label} is invalid JSON`)
  }
}

function sameIdentity(left, right, includeType = false) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino &&
    (!includeType || left.type === right.type))
}

// Reopen only the current activation's durable cleanup authority. A path under
// LocalAppData is never sufficient: it must be the exact live child registered
// beneath the identity-bound checker root for this generation.
function verifyRegisteredGitWorkspace({ record, candidate }, expectedRootId = null) {
  if (process.platform !== 'win32' || !record || typeof record !== 'object' || Array.isArray(record) ||
      record.schemaVersion !== 2 || record.status !== 'active' || typeof record.activationId !== 'string' ||
      !record.activationId || typeof record.activationRoot !== 'string' || !path.isAbsolute(record.activationRoot) ||
      !record.capability || !Number.isFinite(Date.parse(record.capability.expiresAt)) ||
      Date.parse(record.capability.expiresAt) <= Date.now() ||
      !Number.isSafeInteger(record.capability.generation) || record.capability.generation < 1 ||
      typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    refuse('Checker snapshot verification requires the current active Windows activation')
  }
  const activationRoot = path.resolve(record.activationRoot)
  if (activationRoot !== record.activationRoot || fs.realpathSync.native(activationRoot) !== activationRoot) {
    refuse('Checker activation root changed its physical path')
  }
  const runtime = record.supervisorRuntime
  if (!runtime || typeof runtime.runPath !== 'string' || !path.isAbsolute(runtime.runPath) ||
      runtime.runId !== record.activationId || !/^[a-f0-9]{64}$/.test(runtime.metadataSha256 || '') ||
      typeof runtime.targetIdentity !== 'string' || !runtime.targetIdentity) {
    refuse('Checker supervisor runtime binding is invalid')
  }
  const resolvedRunPath = path.resolve(runtime.runPath)
  const runPath = fs.realpathSync.native(resolvedRunPath)
  if (resolvedRunPath !== runtime.runPath || runPath !== resolvedRunPath ||
      runPath === activationRoot || !pathIsInside(activationRoot, runPath)) {
    refuse('Checker supervisor runtime escapes its activation')
  }
  const metadataRecord = readPrivateJson(path.join(runPath, 'metadata.json'), 'Checker supervisor metadata')
  const metadataDigest = readFileNoFollow(path.join(runPath, 'metadata.sha256'))
  const metadataSha256 = crypto.createHash('sha256').update(metadataRecord.bytes).digest('hex')
  const metadata = metadataRecord.value
  if (!metadataDigest || metadataDigest.toString('utf8').trim() !== runtime.metadataSha256 ||
      metadataSha256 !== runtime.metadataSha256 || !metadata || typeof metadata !== 'object' ||
      metadata.run_id !== record.activationId || metadata.run_path !== runPath ||
      metadata.target_path !== record.target?.realpath || metadata.target_identity !== runtime.targetIdentity ||
      metadata.provider_id !== record.providerId || metadata.local_only !== true ||
      metadata.automatic_export_allowed !== false || metadata.runtime_authority?.cleanup_registry !== 'cleanup/registry.json') {
    refuse('Checker supervisor metadata no longer binds the active runtime')
  }
  const registryPath = path.join(runPath, 'cleanup', 'registry.json')
  // CleanupRegistry's generic reader accepts an fs implementation. Freeze one
  // no-follow, private snapshot so its repeated load/get calls cannot observe a
  // link swap or two different registry generations during this decision.
  auditPrivatePermissions(runPath, { recurse: false, additionalPaths: [registryPath] })
  const registryBytes = readFileNoFollow(registryPath)
  if (!registryBytes) refuse('Checker cleanup registry is missing')
  const native = createWindowsFilesystemCapture()
  const runtimeFs = Object.assign(Object.create(fs), {
    windowsCapture: native,
    windowsMutations: native,
    existsSync: filename => path.resolve(filename).toLowerCase() === registryPath.toLowerCase()
      ? true : fs.existsSync(filename),
    readFileSync: (filename, options) => {
      if (path.resolve(filename).toLowerCase() !== registryPath.toLowerCase()) return fs.readFileSync(filename, options)
      const copy = Buffer.from(registryBytes)
      if (typeof options === 'string') return copy.toString(options)
      if (options && typeof options === 'object' && options.encoding) return copy.toString(options.encoding)
      return copy
    },
  })
  const registry = new CleanupRegistry({
    registryPath,
    allowedRoots: [activationRoot],
    fsImpl: runtimeFs,
    controlBinding: { activationId: record.activationId, generationId: record.capability.generation },
    externalRootValidator: createWindowsGitRootValidator({ owner: record.activationId }),
  })
  const candidatePath = path.resolve(candidate)
  const resolvedCandidate = fs.realpathSync.native(candidatePath)
  if (candidatePath !== candidate || resolvedCandidate !== candidatePath) {
    refuse('Checker snapshot changed its physical path')
  }
  const rootId = Object.keys(ROOT_POLICIES).find(id => ROOT_POLICIES[id].leaf.test(path.basename(resolvedCandidate)))
  if (!rootId || (expectedRootId && expectedRootId !== rootId)) refuse('Git workspace has no admitted direct-child shape')
  const policy = ROOT_POLICIES[rootId]
  const root = registry.getExternalRoot(rootId)
  if (!root || path.dirname(resolvedCandidate).toLowerCase() !== root.path.toLowerCase()) {
    refuse('Checker snapshot is not one direct child of the registered external root')
  }
  const durable = registry.load()
  const matches = durable.entries.filter(entry => entry.status === 'REGISTERED' &&
    entry.kind === policy.entryKind && entry.path.toLowerCase() === resolvedCandidate.toLowerCase() &&
    (policy.entryKind !== 'worker-workspace' || entry.owner === path.basename(resolvedCandidate)))
  if (matches.length !== 1 || !sameIdentity(matches[0].parentIdentity, root.targetIdentity)) {
    refuse('Checker snapshot lacks one exact durable child registration')
  }
  const live = native.inspectOwnedTarget(resolvedCandidate)
  if (live.targetIdentity?.type !== 'directory' ||
      !sameIdentity(live.parentIdentity, matches[0].parentIdentity) ||
      !sameIdentity(live.targetIdentity, matches[0].targetIdentity, true)) {
    refuse('Checker snapshot changed physical identity after registration')
  }
  return true
}

function verifyRegisteredCheckerSnapshot(options) {
  return verifyRegisteredGitWorkspace(options, 'windows-checker-snapshots')
}

module.exports = {
  createWindowsCheckerRootValidator: createWindowsGitRootValidator,
  createWindowsGitRootValidator,
  resolveCheckerSnapshotRoot,
  resolveWorkerWorkspaceRoot,
  verifyRegisteredCheckerSnapshot,
  verifyRegisteredGitWorkspace,
}
