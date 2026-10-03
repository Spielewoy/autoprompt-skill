'use strict'

// Durable discovery for secondary command ownership. The command ProcessOwner
// registry is fixed below the already-hashed tool policy root; an independently
// supplied controller-private manifest root is the only discovery authority.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { ProcessOwner, createPlatformProcessAdapter } = require('./process-owner.js')
const { auditPrivatePermissions, inspectPathNoFollow, pathIsInside } = require('./safe-run-root.js')

const HASH = /^[a-f0-9]{64}$/
const STATE_CHILD = 'darwin-command-owner-v1'
const MANIFEST_PREFIX = 'darwin-command-'
const MANIFEST_SUFFIX = '.json'
const MAX_BYTES = 1024 * 1024

class CommandOwnerDiscoveryError extends Error {
  constructor(code, message) { super(message); this.name = 'CommandOwnerDiscoveryError'; this.code = code }
}
function fail(code, message) { throw new CommandOwnerDiscoveryError(code, message) }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function canonical(value) {
  const order = item => Array.isArray(item) ? item.map(order) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])])) : item
  return JSON.stringify(order(value))
}
function equal(left, right) { return canonical(left) === canonical(right) }
function privateDirectory(directory, label) {
  if (!path.isAbsolute(directory || '')) fail('COMMAND_OWNER_DISCOVERY_INVALID', `${label} must be absolute`)
  const inspected = inspectPathNoFollow(directory)
  if (!inspected.exists || !inspected.identity) fail('COMMAND_OWNER_DISCOVERY_INVALID', `${label} must be an existing physical directory`)
  auditPrivatePermissions(directory, { recurse: false })
  return inspected.realpath
}
function boundedRegular(file, label) {
  const before = inspectPathNoFollow(file, { mustBeDirectory: false })
  if (!before.exists) fail('COMMAND_OWNER_DISCOVERY_INVALID', `${label} is missing`)
  const initial = fs.lstatSync(before.path)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > MAX_BYTES) fail('COMMAND_OWNER_DISCOVERY_INVALID', `${label} is not one bounded regular file`)
  const fd = fs.openSync(before.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size > MAX_BYTES) fail('COMMAND_OWNER_DISCOVERY_INVALID', `${label} changed while opening`)
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd)
    const namedAfter = inspectPathNoFollow(file, { mustBeDirectory: false })
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        !namedAfter.exists || namedAfter.realpath !== before.realpath || namedAfter.identity.dev !== before.identity.dev || namedAfter.identity.ino !== before.identity.ino) {
      fail('COMMAND_OWNER_DISCOVERY_INVALID', `${label} changed while reading`)
    }
    return bytes
  } finally { fs.closeSync(fd) }
}
function parsedRegular(file, label) {
  try { return JSON.parse(boundedRegular(file, label)) }
  catch (error) { if (error instanceof CommandOwnerDiscoveryError) throw error; fail('COMMAND_OWNER_DISCOVERY_INVALID', `${label} is not JSON`) }
}
function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      Object.keys(binding).sort().join(',') !== 'activationId,generation,provider' ||
      typeof binding.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(binding.provider) ||
      typeof binding.activationId !== 'string' || !binding.activationId || binding.activationId.length > 512 || binding.activationId.includes('\0') ||
      !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership binding is invalid')
  }
  return Object.freeze({ provider: binding.provider, activationId: binding.activationId, generation: binding.generation })
}
function parsePolicy(policyBytes) {
  try { return JSON.parse(policyBytes) } catch { fail('COMMAND_OWNER_DISCOVERY_INVALID', 'tool policy is not JSON') }
}
function policyBinding(policy) {
  return validateBinding({ provider: policy?.provider, activationId: policy?.activationId, generation: policy?.generation })
}
function assertTaskDisjoint(policyBytes, values) {
  const policy = parsePolicy(policyBytes)
  const roots = [policy?.targetPath, ...(policy?.scratchPath === undefined ? [] : [policy.scratchPath]), ...(Array.isArray(policy?.readableRoots) ? policy.readableRoots : []), ...(Array.isArray(policy?.writableRoots) ? policy.writableRoots : [])]
  if (!roots.length || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'tool policy task roots are invalid')
  for (const value of values) for (const taskRoot of roots) {
    if (pathIsInside(value, taskRoot) || pathIsInside(taskRoot, value)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership state overlaps a task root')
  }
}
function policyDescriptor(policyPath, policySha256) {
  if (!path.isAbsolute(policyPath || '') || !HASH.test(policySha256 || '') || path.basename(policyPath) !== 'policy.json') {
    fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command policy binding is invalid')
  }
  const absolute = path.resolve(policyPath), policyRoot = privateDirectory(path.dirname(absolute), 'tool policy root')
  if (absolute !== path.join(policyRoot, 'policy.json')) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command policy must be the fixed policy-root child')
  const policyBytes = boundedRegular(absolute, 'tool policy')
  if (sha256(policyBytes) !== policySha256) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'tool policy checksum changed')
  const policy = parsePolicy(policyBytes)
  const stateRoot = path.join(policyRoot, STATE_CHILD)
  assertTaskDisjoint(policyBytes, [policyRoot, stateRoot])
  return Object.freeze({ policyPath: absolute, policyRoot, policySha256, policy, binding: policyBinding(policy), stateRoot, registryPath: path.join(stateRoot, 'processes.json'), controlRoot: path.join(stateRoot, 'process-control') })
}
function existingDiscoveryRoot(providerPrivateOwnershipRoot, binding) {
  if (!fs.existsSync(providerPrivateOwnershipRoot)) return null
  const root = privateDirectory(providerPrivateOwnershipRoot, 'provider private ownership root')
  const exact = validateBinding(binding)
  const parent = path.join(root, 'darwin-command-discovery-v1')
  const child = path.join(parent, sha256(`${exact.activationId}\0${exact.generation}`))
  if (!fs.existsSync(parent)) return null
  privateDirectory(parent, 'command ownership discovery root')
  if (!fs.existsSync(child)) return null
  return privateDirectory(child, 'command ownership discovery root')
}
async function drainTrustedProviderRoot(providerPrivateOwnershipRoot, binding, options = {}) {
  const registryRoot = existingDiscoveryRoot(providerPrivateOwnershipRoot, binding)
  if (!registryRoot) return Object.freeze({ discovered: 0 })
  const exactBinding = validateBinding(binding)
  const drained = await drainAuthenticated(registryRoot, exactBinding, { ...options, providerPrivateOwnershipRoot })
  // A fixture may delete its private root immediately after this return. Retire
  // only sealed pointers that reopen to this exact already-drained root.
  retireTrustedCanaryPointers(providerPrivateOwnershipRoot, registryRoot, exactBinding, options.environment)
  return drained
}

function createDiscoveryRoot(providerPrivateOwnershipRoot, binding) {
  const root = privateDirectory(providerPrivateOwnershipRoot, 'provider private ownership root')
  const exact = validateBinding(binding)
  const parent = path.join(root, 'darwin-command-discovery-v1')
  const child = path.join(parent, sha256(`${exact.activationId}\0${exact.generation}`))
  for (const directory of [parent, child]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    privateDirectory(directory, 'command ownership discovery root')
  }
  return child
}
function manifestName(descriptor) { return `${MANIFEST_PREFIX}${sha256(`${descriptor.policyPath}\0${descriptor.policySha256}`)}${MANIFEST_SUFFIX}` }
function manifestBody(descriptor, registryRoot, binding) {
  const body = { schemaVersion: 1, kind: 'darwin-command-owner', binding, policyPath: descriptor.policyPath,
    policySha256: descriptor.policySha256, stateRoot: descriptor.stateRoot, registryPath: descriptor.registryPath,
    controlRoot: descriptor.controlRoot, manifestRoot: registryRoot }
  return { ...body, checksum: sha256(canonical(body)) }
}
function validateManifest(value, manifestPath, registryRoot, expectedBinding) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'binding,checksum,controlRoot,kind,manifestRoot,policyPath,policySha256,registryPath,schemaVersion,stateRoot' ||
      value.schemaVersion !== 1 || value.kind !== 'darwin-command-owner' || !HASH.test(value.checksum || '')) {
    fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership manifest schema is invalid')
  }
  const { checksum, ...body } = value
  if (checksum !== sha256(canonical(body))) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership manifest checksum changed')
  const binding = validateBinding(value.binding)
  if (expectedBinding && !equal(binding, expectedBinding)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership manifest belongs to another activation')
  if (value.manifestRoot !== registryRoot || path.dirname(manifestPath) !== registryRoot) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership manifest escaped its discovery root')
  if (manifestPath !== path.join(registryRoot, manifestName({ policyPath: value.policyPath, policySha256: value.policySha256 }))) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership manifest name is not bound to its policy')
  const descriptor = policyDescriptor(value.policyPath, value.policySha256)
  if (!equal(binding, descriptor.binding)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership binding differs from authenticated tool policy')
  if (value.stateRoot !== descriptor.stateRoot || value.registryPath !== descriptor.registryPath || value.controlRoot !== descriptor.controlRoot) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership manifest paths are not fixed policy children')
  if (pathIsInside(registryRoot, descriptor.policyRoot) || pathIsInside(descriptor.policyRoot, registryRoot)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership discovery root overlaps policy state')
  assertTaskDisjoint(boundedRegular(descriptor.policyPath, 'tool policy'), [registryRoot])
  return Object.freeze({ descriptor, binding })
}
function writeExclusiveOrMatch(file, value) {
  const text = `${JSON.stringify(value)}\n`
  let descriptor
  try {
    descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    fs.writeFileSync(descriptor, text)
    fs.fsyncSync(descriptor)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!equal(parsedRegular(file, 'existing command ownership manifest'), value)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership registration conflicts with existing manifest')
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}
function register(policyPath, policySha256, registryRoot, binding) {
  const descriptor = policyDescriptor(policyPath, policySha256)
  const manifestRoot = privateDirectory(registryRoot, 'command ownership discovery root')
  if (pathIsInside(manifestRoot, descriptor.policyRoot) || pathIsInside(descriptor.policyRoot, manifestRoot)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership discovery root overlaps policy state')
  assertTaskDisjoint(boundedRegular(descriptor.policyPath, 'tool policy'), [manifestRoot])
  const exactBinding = validateBinding(binding)
  if (!equal(exactBinding, descriptor.binding)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership binding differs from authenticated tool policy')
  try { fs.mkdirSync(descriptor.stateRoot, { mode: 0o700 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  privateDirectory(descriptor.stateRoot, 'command ownership state root')
  const manifestPath = path.join(manifestRoot, manifestName(descriptor))
  writeExclusiveOrMatch(manifestPath, manifestBody(descriptor, manifestRoot, exactBinding))
  const manifest = validateManifest(parsedRegular(manifestPath, 'command ownership manifest'), manifestPath, manifestRoot, exactBinding)
  return Object.freeze({ ...manifest.descriptor, manifestPath, binding: manifest.binding })
}
function drainOptions(options) {
  const providerPrivateOwnershipRoot = privateDirectory(options.providerPrivateOwnershipRoot, 'provider private ownership root')
  const platform = options.platform || process.platform
  const factory = options.createPlatformAdapter || createPlatformProcessAdapter
  if (typeof factory !== 'function') fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership platform factory is invalid')
  return { providerPrivateOwnershipRoot, platform, factory }
}
async function drainManifest(manifest, authority) {
  if (!pathIsInside(authority.providerPrivateOwnershipRoot, manifest.descriptor.controlRoot)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership control root is outside caller authority')
  if (!fs.existsSync(manifest.descriptor.registryPath)) return false
  let darwin
  if (authority.platform === 'darwin') {
    const nodeExecutable = manifest.descriptor.policy?.darwinCommandOwner?.nodeExecutable
    if (!nodeExecutable || Object.keys(nodeExecutable).sort().join(',') !== 'path,sha256' ||
        !path.isAbsolute(nodeExecutable.path || '') || !HASH.test(nodeExecutable.sha256 || '')) {
      fail('COMMAND_OWNER_DISCOVERY_INVALID', 'Darwin command ownership policy lacks its exact Node binding')
    }
    darwin = { controlRoot: manifest.descriptor.controlRoot, providerPrivateOwnershipRoot: authority.providerPrivateOwnershipRoot, nodeExecutable }
  }
  const adapter = authority.factory({ platform: authority.platform, ...(darwin ? { darwin } : {}) })
  const owner = new ProcessOwner({ adapter, registryPath: manifest.descriptor.registryPath, pollMs: 20 })
  await owner.recoverReservations()
  await owner.cancelAll({ reason: 'authenticated secondary command recovery', graceMs: 500, killMs: 2000, waitForPending: true })
  await owner.assertDrained()
  return true
}
async function drainOneAuthenticated(policyPath, policySha256, registryRoot, binding, options = {}) {
  const manifestRoot = privateDirectory(registryRoot, 'command ownership discovery root')
  const expectedBinding = validateBinding(binding)
  const descriptor = policyDescriptor(policyPath, policySha256)
  if (!equal(descriptor.binding, expectedBinding)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership binding differs from authenticated tool policy')
  if (pathIsInside(manifestRoot, descriptor.policyRoot) || pathIsInside(descriptor.policyRoot, manifestRoot)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership discovery root overlaps policy state')
  const manifestPath = path.join(manifestRoot, manifestName(descriptor))
  const manifest = validateManifest(parsedRegular(manifestPath, 'command ownership manifest'), manifestPath, manifestRoot, expectedBinding)
  const authority = drainOptions(options)
  if (!pathIsInside(authority.providerPrivateOwnershipRoot, manifestRoot)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership discovery root is outside caller authority')
  await drainManifest(manifest, authority)
  return Object.freeze({ discovered: 1 })
}
async function drainAuthenticated(registryRoot, binding, options = {}) {
  const manifestRoot = privateDirectory(registryRoot, 'command ownership discovery root')
  const expectedBinding = validateBinding(binding)
  const authority = drainOptions(options)
  if (!pathIsInside(authority.providerPrivateOwnershipRoot, manifestRoot)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership discovery root is outside caller authority')
  let failure = null, discovered = 0
  for (const entry of fs.readdirSync(manifestRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(MANIFEST_PREFIX) || !entry.name.endsWith(MANIFEST_SUFFIX) || !entry.isFile() || entry.isSymbolicLink()) {
      failure ||= new CommandOwnerDiscoveryError('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership discovery root contains a non-manifest entry'); continue
    }
    try {
      const manifestPath = path.join(manifestRoot, entry.name)
      const manifest = validateManifest(parsedRegular(manifestPath, 'command ownership manifest'), manifestPath, manifestRoot, expectedBinding)
      discovered += 1
      await drainManifest(manifest, authority)
    } catch (error) { failure ||= error }
  }
  if (failure) throw failure
  return Object.freeze({ discovered })
}

module.exports = { CommandOwnerDiscoveryError, STATE_CHILD, createDiscoveryRoot, drainTrustedProviderRoot, register, drainOneAuthenticated, drainAuthenticated }

// The reviewed-local canary has an explicit private ownership root. A fixture
// may keep its native root elsewhere, so publish only a sealed pointer to the
// already-authenticated policy descriptor there; recovery never scans fixture
// paths or trusts an ambient nativeRoot.
function canaryBindingFromEnvironment(environment = process.env) {
  const root = environment.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT
  const binding = { provider: environment.AUTOPROMPT_CLOSED_CANARY_PROVIDER, activationId: environment.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID, generation: Number(environment.AUTOPROMPT_CLOSED_CANARY_GENERATION) }
  if (!path.isAbsolute(root || '') || !/^[A-Za-z0-9_-]{43}$/.test(environment.AUTOPROMPT_CLOSED_CANARY_CHALLENGE || '')) return null
  try { return { root: privateDirectory(root, 'closed canary ownership root'), binding: validateBinding(binding), challenge: environment.AUTOPROMPT_CLOSED_CANARY_CHALLENGE } } catch { return null }
}
function canaryManifestName(policyPath, policySha256) { return `darwin-command-${sha256(`${policyPath}\0${policySha256}`)}.json` }
function registerCanaryDiscovery(policyPath, policySha256, commandOwner, environment = process.env) {
  const canary = canaryBindingFromEnvironment(environment)
  if (!canary) return null
  const descriptor = policyDescriptor(policyPath, policySha256)
  const owner = descriptor.policy?.darwinCommandOwner
  const ownerKeys = ['controlRoot', 'manifestRoot', 'nodeExecutable', 'providerPrivateOwnershipRoot', 'registryPath', 'schemaVersion', 'stateRoot']
  if (!equal(descriptor.binding, canary.binding) || !commandOwner || typeof commandOwner !== 'object' || !owner ||
      Object.keys(owner).sort().join(',') !== ownerKeys.sort().join(',') || owner.schemaVersion !== 1 || !equal(commandOwner, owner) ||
      owner.stateRoot !== descriptor.stateRoot || owner.registryPath !== descriptor.registryPath || owner.controlRoot !== descriptor.controlRoot ||
      !owner.nodeExecutable || Object.keys(owner.nodeExecutable).sort().join(',') !== 'path,sha256' ||
      !path.isAbsolute(owner.nodeExecutable.path || '') || !HASH.test(owner.nodeExecutable.sha256 || '') ||
      !path.isAbsolute(owner.manifestRoot || '') || !path.isAbsolute(owner.providerPrivateOwnershipRoot || '')) {
    fail('COMMAND_OWNER_DISCOVERY_INVALID', 'closed canary command registration differs from authenticated policy')
  }
  const manifestRoot = privateDirectory(owner.manifestRoot, 'command ownership discovery root')
  const providerPrivateOwnershipRoot = privateDirectory(owner.providerPrivateOwnershipRoot, 'provider private ownership root')
  if (!pathIsInside(providerPrivateOwnershipRoot, manifestRoot) || !pathIsInside(providerPrivateOwnershipRoot, descriptor.policyRoot)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'command ownership discovery root is outside policy authority')
  const body = { schemaVersion: 1, kind: 'darwin-command-canary-discovery', binding: canary.binding, challenge: canary.challenge,
    policyPath: descriptor.policyPath, policySha256: descriptor.policySha256, manifestRoot, providerPrivateOwnershipRoot }
  const value = { ...body, checksum: sha256(canonical(body)) }
  const directory = path.join(canary.root, 'darwin-command-discovery-v1')
  try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  privateDirectory(directory, 'closed canary command discovery directory')
  const file = path.join(directory, canaryManifestName(descriptor.policyPath, descriptor.policySha256))
  writeExclusiveOrMatch(file, value)
  return Object.freeze({ path: file })
}
function unregisterCanaryDiscovery(policyPath, policySha256, commandOwner, environment = process.env) {
  const canary = canaryBindingFromEnvironment(environment)
  if (!canary) return Object.freeze({ removed: false })
  const descriptor = policyDescriptor(policyPath, policySha256)
  const owner = descriptor.policy?.darwinCommandOwner
  if (!equal(descriptor.binding, canary.binding) || !owner || !equal(commandOwner, owner)) {
    fail('COMMAND_OWNER_DISCOVERY_INVALID', 'closed canary command removal differs from authenticated policy')
  }
  const directory = path.join(canary.root, 'darwin-command-discovery-v1')
  if (!fs.existsSync(directory)) return Object.freeze({ removed: false })
  privateDirectory(directory, 'closed canary command discovery directory')
  const file = path.join(directory, canaryManifestName(descriptor.policyPath, descriptor.policySha256))
  if (!fs.existsSync(file)) return Object.freeze({ removed: false })
  const value = parsedRegular(file, 'closed canary command discovery record')
  const { checksum, ...body } = value || {}
  if (!value || Object.keys(value).sort().join(',') !== 'binding,challenge,checksum,kind,manifestRoot,policyPath,policySha256,providerPrivateOwnershipRoot,schemaVersion' ||
      value.schemaVersion !== 1 || value.kind !== 'darwin-command-canary-discovery' || checksum !== sha256(canonical(body)) ||
      !equal(validateBinding(value.binding), canary.binding) || value.challenge !== canary.challenge ||
      value.policyPath !== descriptor.policyPath || value.policySha256 !== descriptor.policySha256 ||
      value.manifestRoot !== owner.manifestRoot || value.providerPrivateOwnershipRoot !== owner.providerPrivateOwnershipRoot) {
    fail('COMMAND_OWNER_DISCOVERY_INVALID', 'closed canary command discovery record changed')
  }
  fs.unlinkSync(file)
  return Object.freeze({ removed: true })
}

function retireTrustedCanaryPointers(providerPrivateOwnershipRoot, expectedRegistryRoot, binding, environment = process.env) {
  const canary = canaryBindingFromEnvironment(environment)
  if (!canary || !equal(canary.binding, binding)) return Object.freeze({ removed: 0 })
  const trustedRoot = privateDirectory(providerPrivateOwnershipRoot, 'provider private ownership root')
  const exactRegistryRoot = privateDirectory(expectedRegistryRoot, 'command ownership discovery root')
  if (!pathIsInside(trustedRoot, exactRegistryRoot)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'trusted command discovery root escaped provider authority')
  const directory = path.join(canary.root, 'darwin-command-discovery-v1')
  if (!fs.existsSync(directory)) return Object.freeze({ removed: 0 })
  privateDirectory(directory, 'closed canary command discovery directory')
  let removed = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^darwin-command-[a-f0-9]{64}\.json$/.test(entry.name)) continue
    const file = path.join(directory, entry.name), value = parsedRegular(file, 'closed canary command discovery record')
    const { checksum, ...body } = value || {}
    if (!value || Object.keys(value).sort().join(',') !== 'binding,challenge,checksum,kind,manifestRoot,policyPath,policySha256,providerPrivateOwnershipRoot,schemaVersion' ||
        value.schemaVersion !== 1 || value.kind !== 'darwin-command-canary-discovery' || checksum !== sha256(canonical(body)) ||
        !equal(validateBinding(value.binding), binding) || value.challenge !== canary.challenge ||
        entry.name !== canaryManifestName(value.policyPath, value.policySha256)) continue
    if (value.providerPrivateOwnershipRoot !== trustedRoot || value.manifestRoot !== exactRegistryRoot) continue
    const descriptor = policyDescriptor(value.policyPath, value.policySha256), owner = descriptor.policy?.darwinCommandOwner
    if (!owner || owner.manifestRoot !== exactRegistryRoot || owner.providerPrivateOwnershipRoot !== trustedRoot ||
        !equal(descriptor.binding, binding) || !pathIsInside(trustedRoot, descriptor.policyRoot)) {
      fail('COMMAND_OWNER_DISCOVERY_INVALID', 'trusted canary command pointer differs from authenticated policy')
    }
    const manifestPath = path.join(exactRegistryRoot, manifestName(descriptor))
    validateManifest(parsedRegular(manifestPath, 'authenticated secondary command manifest'), manifestPath, exactRegistryRoot, binding)
    fs.unlinkSync(file); removed += 1
  }
  return Object.freeze({ removed })
}

async function drainCanaryDiscovery(root, binding, challenge, options = {}) {
  const canaryRoot = privateDirectory(root, 'closed canary ownership root')
  const exactBinding = validateBinding(binding)
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge || '')) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'closed canary challenge is invalid')
  const directory = path.join(canaryRoot, 'darwin-command-discovery-v1')
  if (!fs.existsSync(directory)) return { discovered: 0 }
  privateDirectory(directory, 'closed canary command discovery directory')
  let discovered = 0, failure = null
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^darwin-command-[a-f0-9]{64}\.json$/.test(entry.name)) { failure ||= new CommandOwnerDiscoveryError('COMMAND_OWNER_DISCOVERY_INVALID', 'closed canary command discovery entry is invalid'); continue }
    try {
      const value = parsedRegular(path.join(directory, entry.name), 'closed canary command discovery record')
      const { checksum, ...body } = value || {}
      if (!value || Object.keys(value).sort().join(',') !== 'binding,challenge,checksum,kind,manifestRoot,policyPath,policySha256,providerPrivateOwnershipRoot,schemaVersion' ||
          value.schemaVersion !== 1 || value.kind !== 'darwin-command-canary-discovery' || checksum !== sha256(canonical(body)) ||
          !equal(validateBinding(value.binding), exactBinding) || value.challenge !== challenge || entry.name !== canaryManifestName(value.policyPath, value.policySha256)) fail('COMMAND_OWNER_DISCOVERY_INVALID', 'closed canary command discovery record changed')
      await drainOneAuthenticated(value.policyPath, value.policySha256, value.manifestRoot, exactBinding, { ...options, providerPrivateOwnershipRoot: value.providerPrivateOwnershipRoot })
      discovered += 1
    } catch (error) { failure ||= error }
  }
  if (failure) throw failure
  return Object.freeze({ discovered })
}
module.exports.registerCanaryDiscovery = registerCanaryDiscovery
module.exports.unregisterCanaryDiscovery = unregisterCanaryDiscovery
module.exports.retireTrustedCanaryPointers = retireTrustedCanaryPointers
module.exports.drainCanaryDiscovery = drainCanaryDiscovery
