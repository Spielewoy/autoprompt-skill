'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const discovery = require('../../scripts/harness-v2-command-owner-discovery.cjs')

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
function privateDirectory(directory) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); return fs.realpathSync.native(directory) }
function fixture(t) {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-command-discovery-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const policyRoot = privateDirectory(path.join(root, 'policy-root'))
  const providerRoot = privateDirectory(path.join(root, 'provider-root'))
  const manifestRoot = privateDirectory(path.join(providerRoot, 'manifest-root'))
  // A policy root belongs below the provider's authenticated private root.
  const privatePolicyRoot = privateDirectory(path.join(providerRoot, 'policy-root'))
  const policyPath = path.join(privatePolicyRoot, 'policy.json')
  const target = privateDirectory(path.join(root, 'target'))
  const scratch = privateDirectory(path.join(root, 'scratch'))
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, fixed: 'policy', provider: 'claude', activationId: 'activation-1', generation: 2, targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch] }))
  fs.writeFileSync(policyPath, bytes, { mode: 0o600 })
  return { root, policyRoot, manifestRoot, providerRoot, privatePolicyRoot, policyPath, policySha256: digest(bytes),
    binding: { provider: 'claude', activationId: 'activation-1', generation: 2 } }
}
function posixFactory() { return createPosixProcessAdapter() }


test('register fixes a secondary registry below an exact hashed policy and drains it through caller-owned roots', async t => {
  if (process.platform === 'win32') return t.skip('portable POSIX process-group fixture')
  const f = fixture(t)
  const registration = discovery.register(f.policyPath, f.policySha256, f.manifestRoot, f.binding)
  assert.equal(registration.stateRoot, path.join(f.privatePolicyRoot, discovery.STATE_CHILD))
  assert.equal(registration.registryPath, path.join(registration.stateRoot, 'processes.json'))
  assert.equal(registration.controlRoot, path.join(registration.stateRoot, 'process-control'))
  assert.equal(path.dirname(registration.manifestPath), f.manifestRoot)
  assert.deepEqual(discovery.register(f.policyPath, f.policySha256, f.manifestRoot, f.binding), registration)

  const adapter = createPosixProcessAdapter()
  const owner = new ProcessOwner({ adapter, registryPath: registration.registryPath, pollMs: 10 })
  const reservationId = `secondary-${crypto.randomUUID()}`
  await owner.launch({ executable: process.execPath, argv: ['-e', 'setTimeout(()=>{},30000)'], cwd: registration.stateRoot,
    env: prepareProcessLaunchEnvironment(adapter, reservationId, { PATH: process.env.PATH }), reservationId, sessionId: reservationId,
    targetKey: 'secondary-command', stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', forWork: false })
  const result = await discovery.drainAuthenticated(f.manifestRoot, f.binding, {
    platform: 'linux', providerPrivateOwnershipRoot: f.providerRoot, createPlatformAdapter: posixFactory,
  })
  assert.deepEqual(result, { discovered: 1 })
  const reopened = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: registration.registryPath, pollMs: 10 })
  await reopened.recoverReservations()
  assert.deepEqual(reopened.ownershipIdentities(), [])
})

test('discovery rejects manifest checksum, policy drift, symlink traversal, and caller-root escape before constructing an adapter', async t => {
  const f = fixture(t)
  const registration = discovery.register(f.policyPath, f.policySha256, f.manifestRoot, f.binding)
  let constructed = 0
  const options = { platform: 'linux', providerPrivateOwnershipRoot: f.providerRoot,
    createPlatformAdapter() { constructed += 1; return createPosixProcessAdapter() } }
  const manifest = JSON.parse(fs.readFileSync(registration.manifestPath, 'utf8'))
  fs.writeFileSync(registration.manifestPath, JSON.stringify({ ...manifest, registryPath: path.join(f.root, 'foreign.json') }))
  await assert.rejects(discovery.drainAuthenticated(f.manifestRoot, f.binding, options), { code: 'COMMAND_OWNER_DISCOVERY_INVALID' })
  assert.equal(constructed, 0)

  fs.rmSync(registration.manifestPath)
  const again = discovery.register(f.policyPath, f.policySha256, f.manifestRoot, f.binding)
  fs.writeFileSync(f.policyPath, '{"changed":true}')
  await assert.rejects(discovery.drainAuthenticated(f.manifestRoot, f.binding, options), { code: 'COMMAND_OWNER_DISCOVERY_INVALID' })
  assert.equal(constructed, 0)

  fs.rmSync(again.manifestPath)
  fs.symlinkSync(path.join(f.root, 'foreign-manifest.json'), again.manifestPath)
  await assert.rejects(discovery.drainAuthenticated(f.manifestRoot, f.binding, options), { code: 'COMMAND_OWNER_DISCOVERY_INVALID' })
  assert.equal(constructed, 0)
})

test('registration refuses policy-root traversal, non-private overlapping discovery roots, and foreign activation bindings', t => {
  const f = fixture(t)
  assert.throws(() => discovery.register(path.join(f.privatePolicyRoot, 'other.json'), f.policySha256, f.manifestRoot, f.binding), { code: 'COMMAND_OWNER_DISCOVERY_INVALID' })
  assert.throws(() => discovery.register(f.policyPath, f.policySha256, f.privatePolicyRoot, f.binding), { code: 'COMMAND_OWNER_DISCOVERY_INVALID' })
  const registration = discovery.register(f.policyPath, f.policySha256, f.manifestRoot, f.binding)
  assert.throws(() => discovery.register(f.policyPath, f.policySha256, f.manifestRoot, { ...f.binding, provider: 'grok' }), { code: 'COMMAND_OWNER_DISCOVERY_INVALID' })
  assert.throws(() => discovery.register(f.policyPath, f.policySha256, f.manifestRoot, { ...f.binding, activationId: 'activation-2' }), { code: 'COMMAND_OWNER_DISCOVERY_INVALID' })
  assert.throws(() => discovery.register(f.policyPath, f.policySha256, f.manifestRoot, { ...f.binding, generation: 3 }), { code: 'COMMAND_OWNER_DISCOVERY_INVALID' })
  assert.ok(fs.existsSync(registration.manifestPath))
})

test('scoped drain stops only its exact policy registry while full authenticated recovery drains sibling policies', async t => {
  if (process.platform === 'win32') return t.skip('portable POSIX process-group fixture')
  const f = fixture(t)
  const first = discovery.register(f.policyPath, f.policySha256, f.manifestRoot, f.binding)
  const secondPolicyRoot = privateDirectory(path.join(f.providerRoot, 'second-policy-root'))
  const secondPolicyPath = path.join(secondPolicyRoot, 'policy.json')
  const secondBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, provider: f.binding.provider, activationId: f.binding.activationId, generation: f.binding.generation,
    targetPath: privateDirectory(path.join(f.root, 'target-two')), scratchPath: privateDirectory(path.join(f.root, 'scratch-two')),
    readableRoots: [path.join(f.root, 'target-two'), path.join(f.root, 'scratch-two')], writableRoots: [path.join(f.root, 'scratch-two')] }))
  fs.writeFileSync(secondPolicyPath, secondBytes, { mode: 0o600 })
  const second = discovery.register(secondPolicyPath, digest(secondBytes), f.manifestRoot, f.binding)
  const launch = async registration => {
    const adapter = createPosixProcessAdapter(), owner = new ProcessOwner({ adapter, registryPath: registration.registryPath, pollMs: 10 })
    const reservationId = `parallel-${crypto.randomUUID()}`
    await owner.launch({ executable: process.execPath, argv: ['-e', 'setTimeout(()=>{},30000)'], cwd: registration.stateRoot,
      env: prepareProcessLaunchEnvironment(adapter, reservationId, { PATH: process.env.PATH }), reservationId, sessionId: reservationId,
      targetKey: reservationId, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', forWork: false })
    return owner
  }
  const firstOwner = await launch(first), secondOwner = await launch(second)
  const secondIdentity = secondOwner.listRecords().find(record => record.status === 'RUNNING').groupIdentity
  const options = { platform: 'linux', providerPrivateOwnershipRoot: f.providerRoot, createPlatformAdapter: posixFactory }
  assert.deepEqual(await discovery.drainOneAuthenticated(f.policyPath, f.policySha256, f.manifestRoot, f.binding, options), { discovered: 1 })
  assert.ok((await secondOwner.adapter.listOwned(secondIdentity)).length > 0, 'scoped policy drain must leave its sibling kernel group alive')
  await discovery.drainAuthenticated(f.manifestRoot, f.binding, options)
  const reopen = async registration => { const owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: registration.registryPath, pollMs: 10 }); await owner.recoverReservations(); return owner.ownershipIdentities() }
  assert.deepEqual(await reopen(first), [])
  assert.deepEqual(await reopen(second), [])
  void firstOwner
})
