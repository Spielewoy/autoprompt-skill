'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const test = require('node:test')
const sandbox = require('../../scripts/harness-v2-bridge/grok/windows-sandbox.cjs')

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
function fixture(t, changes = {}, fixtureOptions = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-win-sandbox-')))
  const root = path.join(base, 'control'), helperDeploymentRoot = path.join(base, 'native-helpers-ABC123')
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(helperDeploymentRoot, { mode: 0o700 })
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const helperStat = fs.statSync(helperDeploymentRoot, { bigint: true })
  const helperDeploymentBinding = Object.freeze({ root: helperDeploymentRoot, identity: Object.freeze({ dev: String(helperStat.dev), ino: String(helperStat.ino) }) })
  const executable = path.join(root, 'grok.exe'), node = path.join(root, 'node.exe'), brokerNode = path.join(root, 'broker-node.exe')
  fs.writeFileSync(executable, 'grok'); fs.writeFileSync(node, 'node'); fs.writeFileSync(brokerNode, 'broker-node')
  const binding = { reservationId: 'reservation-1', sessionId: 'session-1', targetKey: 'grok' }
  const prestart = new WeakSet(), releases = [], recoveryCalls = []
  const restoredPath = path.join(root, 'resources.json.restored')
  const resourcePlan = { entries: [{}] }
  const writeRestored = () => fs.writeFileSync(restoredPath, JSON.stringify({ schemaVersion: 1, leaseId: '1'.repeat(32), profileSid: 'S-1-15-2-1-2-3-4-5-6-7', result: { restored: 1, newEntries: 0, deletedEntries: 0 } }), { flag: fs.existsSync(restoredPath) ? 'w' : 'wx', mode: 0o600 })
  let prepareCalls = 0
  const makeOwner = () => {
    const receipts = new WeakSet()
    return { failure: null, issueCalls: 0,
      async issueBoundDrainReceipt(expected) {
        this.issueCalls += 1
        if (this.failure) throw this.failure
        const receipt = Object.freeze({ expected }); receipts.add(receipt); return receipt
      },
      verifyBoundDrainReceipt(receipt, expected) { return receipts.has(receipt) && JSON.stringify(receipt.expected) === JSON.stringify(expected) },
    }
  }
  const owner = makeOwner()
  const launcherBinding = Object.freeze({ helper: Object.freeze({ path: path.join(root, 'helper.ps1'), sha256: 'a'.repeat(64) }) })
  const launcher = {
    binding: launcherBinding,
    proveNotStarted(expected) { const evidence = Object.freeze({ expected }); prestart.add(evidence); return evidence },
    verifyDrainEvidence(evidence, expected) { return prestart.has(evidence) && JSON.stringify(evidence.expected) === JSON.stringify(expected) },
  }
  let verifier
  const resources = { async prepareWindowsAppContainerResources(options) {
    prepareCalls++
    verifier = options.verifyDrainEvidence
    const journalBody = { schemaVersion: 1, leaseId: '1'.repeat(32), plan: resourcePlan }
    fs.writeFileSync(path.join(root, 'resources.json'), JSON.stringify({ ...journalBody, sha256: hash(JSON.stringify(journalBody)) }))
    return Object.freeze({ profileName: 'Autoprompt_' + '1'.repeat(32), profileSid: 'S-1-15-2-1-2-3-4-5-6-7',
      environment: Object.freeze({ USERPROFILE: 'C:\\profile', HOME: 'C:\\profile', APPDATA: 'C:\\profile\\AppData\\Roaming', TEMP: 'C:\\scratch', TMP: 'C:\\scratch' }),
      recovery: Object.freeze({ journalPath: path.join(root, 'resources.json'), leaseId: '1'.repeat(32) }),
      async release(evidence) {
        if (!verifier(evidence, { profileSid: this.profileSid, leaseId: this.recovery.leaseId })) throw Object.assign(new Error('unconfirmed'), { code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' })
        releases.push(evidence); writeRestored()
      },
    })
  }, async recoverWindowsAppContainerResources(options) {
    if (!options.verifyDrainEvidence(options.evidence, { profileSid: 'S-1-15-2-1-2-3-4-5-6-7', leaseId: '1'.repeat(32) })) throw Object.assign(new Error('unconfirmed'), { code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' })
    recoveryCalls.push(options); writeRestored()
    return Object.freeze({ restored: 1, newEntries: 0, deletedEntries: 0 })
  } }
  const helperDeployment = {
    assertTrustedWindowsHelperDeployment(controlRoot, deploymentRoot) {
      assert.equal(controlRoot, root); assert.equal(deploymentRoot, helperDeploymentRoot)
      const stat = fs.lstatSync(deploymentRoot, { bigint: true })
      assert.equal(stat.isDirectory(), true); assert.equal(stat.isSymbolicLink(), false)
      return { root: fs.realpathSync.native(deploymentRoot), identity: { dev: String(stat.dev), ino: String(stat.ino) } }
    },
    cleanupWindowsHelperDeployment(controlRoot, expected) {
      assert.equal(controlRoot, root); assert.equal(expected.root, helperDeploymentRoot)
      if (!fs.existsSync(expected.root)) return { removed: false, absent: true }
      const stat = fs.lstatSync(expected.root, { bigint: true })
      if (String(stat.dev) !== expected.identity.dev || String(stat.ino) !== expected.identity.ino) {
        throw Object.assign(new Error('helper identity changed'), { code: 'WINDOWS_RUNTIME_MISMATCH' })
      }
      fs.rmSync(expected.root, { recursive: true })
      return { removed: true, absent: false }
    },
  }
  const executableStat = fs.statSync(executable, { bigint: true })
  const runtime = Object.freeze({ kind: 'grok-official-windows-runtime', closureSha256: 'b'.repeat(64), executable: Object.freeze({ path: executable,
    size: 4, sha256: hash('grok'), identity: Object.freeze({ dev: String(executableStat.dev), ino: String(executableStat.ino) }) }) })
  const worker = Object.freeze({ payloadSha256: 'c'.repeat(64), moduleSha256: Object.freeze({ 'sandbox-worker.cjs': 'd'.repeat(64) }), executable: node,
    argv: Object.freeze(['-e', 'inline-worker', '--', 'autoprompt-grok-inline-worker.cjs', '--model', 'grok']) })
  const options = {
    processOwner: owner, binding, controlRoot: root, helperDeploymentRoot, helperDeploymentBinding,
    brokerNodeExecutable: fixtureOptions.realBroker === true ? process.execPath : brokerNode,
    brokerNodeSha256: fixtureOptions.realBroker === true ? hash(fs.readFileSync(process.execPath)) : hash('broker-node'),
    brokerCwd: root, brokerEnvironment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' },
    nodeExecutable: node, nodeExecutableSha256: hash('node'), nodeArgs: [], workerArgs: ['--model', 'grok'],
    runtime: {}, policy: { readOnly: false, targetPath: 'C:\\workspace', scratchPath: 'C:\\scratch',
      readableRoots: ['C:\\workspace', 'C:\\scratch'], writableRoots: ['C:\\workspace', 'C:\\scratch'] },
    workerEnvironment: { SystemRoot: 'C:\\Windows', HOME: 'C:\\session-home', GROK_HOME: 'C:\\session-home', AUTOPROMPT_GROK_MODEL: 'grok', AUTOPROMPT_GROK_RELAY_TOKEN: 'token', AUTOPROMPT_GROK_PROXY_TOKEN: 'proxy', AUTOPROMPT_GROK_PROXY_PORT: '2', AUTOPROMPT_GROK_MCP_PORT: '1', AUTOPROMPT_GROK_ALLOWED_MCP_TOOLS: '{"x":"bash"}' },
    pipe: { socketPath: `\\\\.\\pipe\\autoprompt-grok-${'e'.repeat(64)}` }, cancellationPath: path.join(root, 'cancel'), timeoutMs: 1000, outputLimit: 65536,
    _dependencies: { materializeRuntime: () => runtime, buildWorker: () => worker, createLauncher: () => launcher, resources, helperDeployment },
    ...changes,
  }
  return { root, helperDeploymentRoot, helperDeploymentBinding, options, owner, makeOwner, binding, releases, recoveryCalls, launcher, launcherBinding,
    get prepareCalls() { return prepareCalls } }
}

test('helper deployment identity mismatch is rejected before resource allocation', async t => {
  const f = fixture(t)
  await assert.rejects(sandbox.prepareWindowsGrokSandbox({ ...f.options,
    helperDeploymentBinding: { ...f.helperDeploymentBinding, identity: { ...f.helperDeploymentBinding.identity, ino: String(BigInt(f.helperDeploymentBinding.identity.ino) + 1n) } } }),
  { code: 'GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED' })
  assert.equal(f.prepareCalls, 0)
})

test('pre-reservation cleanup uses only the launcher not-started capability and removes its exact broker request', async t => {
  const f = fixture(t), resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  assert.match(resource.launchBindingHash, /^[a-f0-9]{64}$/u)
  assert.equal(Object.isFrozen(resource.launch), true)
  const requestPath = resource.launch.argv[4]
  assert.equal(fs.existsSync(requestPath), true)
  await resource.cleanup()
  assert.equal(f.releases.length, 1)
  assert.equal(fs.existsSync(requestPath), false)
})

test('actual Node -e bootstrap forwards the module path and all four bound arguments', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-broker-bootstrap-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixtureModule = path.join(root, 'fixture.cjs')
  fs.writeFileSync(fixtureModule, `'use strict';exports.runBroker=async(...args)=>process.stdout.write(JSON.stringify(args))\n`)
  const moduleSha = hash(fs.readFileSync(fixtureModule))
  const result = childProcess.spawnSync(process.execPath, ['-e', sandbox.BROKER_BOOTSTRAP, '--', fixtureModule, 'request', 'request-sha', 'launch-hash', moduleSha], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [fixtureModule, 'request', 'request-sha', 'launch-hash', moduleSha])
})

test('bootstrap rejects changed broker bytes before their module side effects can execute', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-broker-tamper-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixtureModule = path.join(root, 'fixture.cjs'), marker = path.join(root, 'executed')
  fs.writeFileSync(fixtureModule, `'use strict';exports.runBroker=async()=>{}\n`)
  const admittedSha = hash(fs.readFileSync(fixtureModule))
  fs.writeFileSync(fixtureModule, `'use strict';require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');exports.runBroker=async()=>{}\n`)
  const result = childProcess.spawnSync(process.execPath, ['-e', sandbox.BROKER_BOOTSTRAP, '--', fixtureModule, 'request', 'request-sha', 'launch-hash', admittedSha], { encoding: 'utf8', timeout: 10000 })
  assert.notEqual(result.status, 0)
  assert.equal(fs.existsSync(marker), false)
})

test('entered reservation restores ACL resources only after an exact branded ProcessOwner drain receipt', async t => {
  const f = fixture(t), resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  resource.markReservationEntered()
  await resource.cleanup()
  assert.equal(f.releases.length, 1)
  assert.deepEqual(f.releases[0].expected, { ...f.binding, launchBindingHash: resource.launchBindingHash })
  await resource.cleanup()
  assert.equal(f.releases.length, 1)
})

test('ambiguous entered ownership and rebound request identity retain all cleanup resources', async t => {
  const f = fixture(t), resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  const requestPath = resource.launch.argv[4]
  resource.markReservationEntered()
  f.owner.failure = Object.assign(new Error('pending'), { code: 'OWNERSHIP_RECOVERY_PENDING' })
  await assert.rejects(resource.cleanup(), { code: 'OWNERSHIP_RECOVERY_PENDING' })
  assert.equal(f.releases.length, 0); assert.equal(fs.existsSync(requestPath), true)
  f.owner.failure = null
  const original = `${requestPath}.original`; fs.renameSync(requestPath, original); fs.copyFileSync(original, requestPath)
  await assert.rejects(resource.cleanup(), { code: 'GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED' })
  assert.equal(fs.existsSync(requestPath), true, 'same-byte replacement was not deleted')
})

test('starting any cleanup attempt permanently fences later reservation entry', async t => {
  const f = fixture(t), resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  const cleaning = resource.cleanup()
  assert.throws(() => resource.markReservationEntered(), { code: 'GROK_WINDOWS_SANDBOX_STATE_INVALID' })
  await cleaning
  assert.throws(() => resource.markReservationEntered(), { code: 'GROK_WINDOWS_SANDBOX_STATE_INVALID' })
})

test('full runtime, worker, environment, pipe and owner closure changes alter the launch binding', async t => {
  const first = fixture(t), second = fixture(t, { workerEnvironment: { ...first.options.workerEnvironment, AUTOPROMPT_GROK_MODEL: 'other' } })
  const left = await sandbox.prepareWindowsGrokSandbox(first.options), right = await sandbox.prepareWindowsGrokSandbox(second.options)
  assert.notEqual(left.launchBindingHash, right.launchBindingHash)
  await left.cleanup(); await right.cleanup()
})

test('broker and worker environments reject dynamic-code or ambient field injection and restore the unentered lease', async t => {
  for (const changes of [
    f => ({ brokerEnvironment: { ...f.options.brokerEnvironment, NODE_OPTIONS: '--require=foreign.cjs' } }),
    f => ({ workerEnvironment: { ...f.options.workerEnvironment, AWS_SECRET_ACCESS_KEY: 'foreign' } }),
  ]) {
    const f = fixture(t)
    await assert.rejects(sandbox.prepareWindowsGrokSandbox({ ...f.options, ...changes(f) }), { code: 'GROK_WINDOWS_SANDBOX_INVALID' })
    assert.equal(f.releases.length, 1)
  }
})

test('broker rebinds its module, request and AppContainer helper before launching the inherited relay', async t => {
  const f = fixture(t, {}, { realBroker: true }), resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  const args = resource.launch.argv
  let observed
  const result = await sandbox.runBroker(args[3], args[4], args[5], args[6], args[7], { createLauncher() {
    return { binding: f.launcherBinding, async launch(request, options) { observed = { request, options }; return { drained: true, profileSid: request.profileSid, exitCode: 0 } } }
  } })
  assert.equal(result.drained, true)
  assert.equal(observed.request.relayStdin, true)
  assert.equal(observed.options.relayStdin, process.stdin)
  await resource.cleanup()
})

test('broker refuses runtime executable or durable resource-journal replacement before launch', async t => {
  for (const select of [
    resource => JSON.parse(fs.readFileSync(resource.launch.argv[4], 'utf8')).runtime.executable.path,
    resource => JSON.parse(fs.readFileSync(resource.launch.argv[4], 'utf8')).lease.resourceJournalBinding.path,
  ]) {
    const f = fixture(t, {}, { realBroker: true }), resource = await sandbox.prepareWindowsGrokSandbox(f.options), args = resource.launch.argv
    const target = select(resource), bytes = fs.readFileSync(target), moved = `${target}.original`
    fs.renameSync(target, moved); fs.writeFileSync(target, bytes)
    await assert.rejects(sandbox.runBroker(args[3], args[4], args[5], args[6], args[7], { createLauncher: () => f.launcher }), { code: 'GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED' })
  }
})

test('fresh controller recovers an entered sandbox only with its exact persisted owner binding and branded drain receipt', async t => {
  const f = fixture(t)
  let resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  const brokerRequestPath = resource.launch.argv[4]
  const ownerBinding = { ...f.binding, launchBindingHash: resource.launchBindingHash }
  resource.markReservationEntered()
  resource = null
  const freshOwner = f.makeOwner()
  const result = await sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath, helperDeploymentRoot: f.helperDeploymentRoot,
    processOwner: freshOwner, binding: ownerBinding, _dependencies: f.options._dependencies })
  assert.deepEqual(result, { restored: 1, newEntries: 0, deletedEntries: 0 })
  assert.equal(freshOwner.issueCalls, 1)
  assert.equal(f.recoveryCalls.length, 1)
  assert.equal(fs.existsSync(brokerRequestPath), false)
  assert.equal(fs.existsSync(f.helperDeploymentRoot), false)
})

test('unknown ownership or rebound durable journal retains recovery resources without implicit drain', async t => {
  const pending = fixture(t), pendingResource = await sandbox.prepareWindowsGrokSandbox(pending.options)
  pendingResource.markReservationEntered()
  const pendingPath = pendingResource.launch.argv[4], pendingOwner = pending.makeOwner()
  pendingOwner.failure = Object.assign(new Error('pending'), { code: 'OWNERSHIP_RECOVERY_PENDING' })
  await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: pending.root, brokerRequestPath: pendingPath, helperDeploymentRoot: pending.helperDeploymentRoot,
    processOwner: pendingOwner, binding: { ...pending.binding, launchBindingHash: pendingResource.launchBindingHash }, _dependencies: pending.options._dependencies }), { code: 'OWNERSHIP_RECOVERY_PENDING' })
  assert.equal(pending.recoveryCalls.length, 0); assert.equal(fs.existsSync(pendingPath), true)

  const rebound = fixture(t), reboundResource = await sandbox.prepareWindowsGrokSandbox(rebound.options)
  reboundResource.markReservationEntered()
  const reboundPath = reboundResource.launch.argv[4], journal = path.join(rebound.root, 'resources.json'), bytes = fs.readFileSync(journal)
  fs.renameSync(journal, `${journal}.original`); fs.writeFileSync(journal, bytes)
  const reboundOwner = rebound.makeOwner()
  await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: rebound.root, brokerRequestPath: reboundPath, helperDeploymentRoot: rebound.helperDeploymentRoot,
    processOwner: reboundOwner, binding: { ...rebound.binding, launchBindingHash: reboundResource.launchBindingHash }, _dependencies: rebound.options._dependencies }), { code: 'GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED' })
  assert.equal(reboundOwner.issueCalls, 0); assert.equal(rebound.recoveryCalls.length, 0); assert.equal(fs.existsSync(reboundPath), true)
})

test('fresh recovery rejects a foreign drain receipt before resource restoration', async t => {
  const f = fixture(t), resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  resource.markReservationEntered()
  const foreignOwner = { async issueBoundDrainReceipt() { return Object.freeze({ foreign: true }) }, verifyBoundDrainReceipt() { return false } }
  await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: resource.launch.argv[4], helperDeploymentRoot: f.helperDeploymentRoot,
    processOwner: foreignOwner, binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies }), { code: 'GROK_WINDOWS_SANDBOX_RECOVERY_INVALID' })
  assert.equal(f.recoveryCalls.length, 0)
})

test('discovered recovery obtains its launch hash from the owned registry and retains unbound requests', async t => {
  const f = fixture(t)
  const resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  resource.markReservationEntered()
  const request = resource.launch.argv[4], owner = f.makeOwner()
  let records = []
  owner.listRecords = () => records
  const options = { controlRoot: f.root, brokerRequestPath: request, targetKey: f.binding.targetKey,
    processOwner: owner, _dependencies: f.options._dependencies }
  await assert.rejects(sandbox.recoverDiscoveredWindowsGrokSandbox(options), { code: 'PROCESS_IDENTITY_INVALID' })
  assert.equal(fs.existsSync(request), true)
  assert.equal(owner.issueCalls, 0)
  records = [{ ...f.binding, launchBindingHash: resource.launchBindingHash }]
  await sandbox.recoverDiscoveredWindowsGrokSandbox(options)
  assert.equal(f.recoveryCalls.length, 1)
  assert.equal(owner.issueCalls, 1)
  assert.equal(fs.existsSync(request), false)
})

test('fresh recovery retains a replaced helper deployment and its broker request', async t => {
  const f = fixture(t), resource = await sandbox.prepareWindowsGrokSandbox(f.options)
  resource.markReservationEntered()
  const request = resource.launch.argv[4], moved = `${f.helperDeploymentRoot}.original`
  fs.renameSync(f.helperDeploymentRoot, moved)
  fs.mkdirSync(f.helperDeploymentRoot, { mode: 0o700 })
  const owner = f.makeOwner()
  await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request,
    helperDeploymentRoot: f.helperDeploymentRoot, processOwner: owner,
    binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies }),
  { code: 'GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED' })
  assert.equal(fs.existsSync(request), true)
  assert.equal(fs.existsSync(f.helperDeploymentRoot), true)
})

test('committed helper cleanup resumes after interruption before helper deletion', async t => {
  const f = fixture(t), original = f.options._dependencies.helperDeployment
  let interrupted = true
  f.options._dependencies.helperDeployment = { ...original, cleanupWindowsHelperDeployment(...args) {
    if (interrupted) { interrupted = false; throw Object.assign(new Error('simulated crash boundary'), { code: 'INTERRUPTED' }) }
    return original.cleanupWindowsHelperDeployment(...args)
  } }
  const resource = await sandbox.prepareWindowsGrokSandbox(f.options), request = resource.launch.argv[4]
  resource.markReservationEntered()
  await assert.rejects(resource.cleanup(), { code: 'INTERRUPTED' })
  const commit = path.join(f.root, `grok-helper-cleanup-${'1'.repeat(32)}.json`)
  assert.equal(fs.existsSync(commit), true)
  assert.equal(fs.existsSync(request), true)
  assert.equal(fs.existsSync(f.helperDeploymentRoot), true)
  const owner = f.makeOwner()
  await sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request, helperDeploymentRoot: f.helperDeploymentRoot,
    processOwner: owner, binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies })
  assert.equal(fs.existsSync(request), false)
  assert.equal(fs.existsSync(f.helperDeploymentRoot), false)
  assert.equal(fs.existsSync(commit), true, 'durable cleanup tombstone remains until authenticated control-root retirement')
})

test('cleanup commit publication ignores a crash residue and atomically publishes the exact final record', async t => {
  const f = fixture(t), original = f.options._dependencies.helperDeployment
  let interrupted = true
  f.options._dependencies.helperDeployment = { ...original, cleanupWindowsHelperDeployment(...args) {
    if (interrupted) { interrupted = false; throw Object.assign(new Error('simulated crash boundary'), { code: 'INTERRUPTED' }) }
    return original.cleanupWindowsHelperDeployment(...args)
  } }
  const resource = await sandbox.prepareWindowsGrokSandbox(f.options), request = resource.launch.argv[4]
  const commitName = `grok-helper-cleanup-${'1'.repeat(32)}.json`
  const residue = path.join(f.root, `.${commitName}.9999.${'a'.repeat(16)}.create`)
  fs.writeFileSync(residue, '{"partial":', { flag: 'wx', mode: 0o600 })
  resource.markReservationEntered()
  await assert.rejects(resource.cleanup(), { code: 'INTERRUPTED' })
  const commit = path.join(f.root, commitName), parsed = JSON.parse(fs.readFileSync(commit, 'utf8'))
  assert.match(parsed.checksum, /^[a-f0-9]{64}$/u)
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(fs.readFileSync(residue, 'utf8'), '{"partial":')
  await sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request, helperDeploymentRoot: f.helperDeploymentRoot,
    processOwner: f.makeOwner(), binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies })
  assert.equal(fs.existsSync(request), false)
})

test('cleanup commit recovery removes only its exact same-inode atomic publication alias', async t => {
  const f = fixture(t), original = f.options._dependencies.helperDeployment
  let interrupted = true
  f.options._dependencies.helperDeployment = { ...original, cleanupWindowsHelperDeployment(...args) {
    if (interrupted) { interrupted = false; throw Object.assign(new Error('simulated crash boundary'), { code: 'INTERRUPTED' }) }
    return original.cleanupWindowsHelperDeployment(...args)
  } }
  const resource = await sandbox.prepareWindowsGrokSandbox(f.options), request = resource.launch.argv[4]
  resource.markReservationEntered()
  await assert.rejects(resource.cleanup(), { code: 'INTERRUPTED' })
  const commit = path.join(f.root, `grok-helper-cleanup-${'1'.repeat(32)}.json`)
  const alias = path.join(f.root, `.${path.basename(commit)}.4242.${'b'.repeat(16)}.create`)
  fs.linkSync(commit, alias)
  assert.equal(fs.statSync(commit, { bigint: true }).nlink, 2n)
  await sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request, helperDeploymentRoot: f.helperDeploymentRoot,
    processOwner: f.makeOwner(), binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies })
  assert.equal(fs.existsSync(alias), false)
  assert.equal(fs.statSync(commit, { bigint: true }).nlink, 1n)
  assert.equal(fs.existsSync(request), false)
})

test('cleanup commit recovery refuses malformed or foreign atomic publication aliases', async t => {
  for (const kind of ['malformed', 'foreign']) {
    const f = fixture(t), original = f.options._dependencies.helperDeployment
    f.options._dependencies.helperDeployment = { ...original, cleanupWindowsHelperDeployment() {
      throw Object.assign(new Error('simulated crash boundary'), { code: 'INTERRUPTED' })
    } }
    const resource = await sandbox.prepareWindowsGrokSandbox(f.options), request = resource.launch.argv[4]
    resource.markReservationEntered()
    await assert.rejects(resource.cleanup(), { code: 'INTERRUPTED' })
    const commit = path.join(f.root, `grok-helper-cleanup-${'1'.repeat(32)}.json`)
    const exactAlias = path.join(f.root, `.${path.basename(commit)}.4242.${'c'.repeat(16)}.create`)
    fs.linkSync(commit, kind === 'malformed' ? `${exactAlias}.wrong` : exactAlias)
    if (kind === 'foreign') {
      fs.writeFileSync(path.join(f.root, `.${path.basename(commit)}.4243.${'d'.repeat(16)}.create`), 'foreign', { flag: 'wx', mode: 0o600 })
    }
    await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request,
      helperDeploymentRoot: f.helperDeploymentRoot, processOwner: f.makeOwner(),
      binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies }),
    { code: 'GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED' })
    assert.equal(fs.existsSync(request), true)
    assert.equal(fs.statSync(commit, { bigint: true }).nlink, 2n)
  }
})

test('committed recovery treats a dangling helper junction as a retained identity replacement', async t => {
  const f = fixture(t), original = f.options._dependencies.helperDeployment
  f.options._dependencies.helperDeployment = { ...original, cleanupWindowsHelperDeployment(...args) {
    original.cleanupWindowsHelperDeployment(...args)
    throw Object.assign(new Error('simulated post-delete crash boundary'), { code: 'INTERRUPTED' })
  } }
  const resource = await sandbox.prepareWindowsGrokSandbox(f.options), request = resource.launch.argv[4]
  resource.markReservationEntered()
  await assert.rejects(resource.cleanup(), { code: 'INTERRUPTED' })
  const missingTarget = path.join(path.dirname(f.helperDeploymentRoot), 'removed-foreign-target')
  fs.mkdirSync(missingTarget, { mode: 0o700 })
  fs.symlinkSync(missingTarget, f.helperDeploymentRoot, process.platform === 'win32' ? 'junction' : 'dir')
  fs.rmdirSync(missingTarget)
  const owner = f.makeOwner()
  await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request,
    helperDeploymentRoot: f.helperDeploymentRoot, processOwner: owner,
    binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies }),
  { code: 'GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED' })
  assert.equal(owner.issueCalls, 0)
  assert.equal(fs.lstatSync(f.helperDeploymentRoot).isSymbolicLink(), true)
  assert.equal(fs.existsSync(request), true)
})

test('committed helper cleanup resumes after deletion before broker request removal and rejects replacement', async t => {
  const f = fixture(t), original = f.options._dependencies.helperDeployment
  let interrupted = true
  f.options._dependencies.helperDeployment = { ...original, cleanupWindowsHelperDeployment(...args) {
    const result = original.cleanupWindowsHelperDeployment(...args)
    if (interrupted) { interrupted = false; throw Object.assign(new Error('simulated post-delete crash boundary'), { code: 'INTERRUPTED' }) }
    return result
  } }
  const resource = await sandbox.prepareWindowsGrokSandbox(f.options), request = resource.launch.argv[4]
  resource.markReservationEntered()
  await assert.rejects(resource.cleanup(), { code: 'INTERRUPTED' })
  assert.equal(fs.existsSync(request), true)
  assert.equal(fs.existsSync(f.helperDeploymentRoot), false)
  const owner = f.makeOwner()
  await sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request, helperDeploymentRoot: f.helperDeploymentRoot,
    processOwner: owner, binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies })
  assert.equal(fs.existsSync(request), false)

  const replaced = fixture(t)
  const replacementOriginal = replaced.options._dependencies.helperDeployment
  replaced.options._dependencies.helperDeployment = { ...replacementOriginal, cleanupWindowsHelperDeployment(...args) {
    replacementOriginal.cleanupWindowsHelperDeployment(...args)
    throw Object.assign(new Error('simulated post-delete crash boundary'), { code: 'INTERRUPTED' })
  } }
  const replacementResource = await sandbox.prepareWindowsGrokSandbox(replaced.options)
  replacementResource.markReservationEntered()
  const replacementRequest = replacementResource.launch.argv[4]
  await assert.rejects(replacementResource.cleanup(), { code: 'INTERRUPTED' })
  // Keep the deleted directory's inode occupied so this is an actual
  // replacement rather than a same-identity allocator reuse in the fixture.
  const heldReplacement = `${replaced.helperDeploymentRoot}.replacement`
  fs.mkdirSync(heldReplacement, { mode: 0o700 })
  fs.mkdirSync(replaced.helperDeploymentRoot, { mode: 0o700 })
  const replacementOwner = replaced.makeOwner()
  await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: replaced.root, brokerRequestPath: replacementRequest,
    helperDeploymentRoot: replaced.helperDeploymentRoot, processOwner: replacementOwner,
    binding: { ...replaced.binding, launchBindingHash: replacementResource.launchBindingHash }, _dependencies: replaced.options._dependencies }),
  { code: 'GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED' })
  assert.equal(fs.existsSync(replacementRequest), true)
})

test('helper cleanup recovery rejects a tampered commit, missing commit, or mismatched restored entry count', async t => {
  const interruptedFixture = async mode => {
    const f = fixture(t), original = f.options._dependencies.helperDeployment
    f.options._dependencies.helperDeployment = { ...original, cleanupWindowsHelperDeployment(...args) {
      if (mode === 'before-delete') throw Object.assign(new Error('interrupted'), { code: 'INTERRUPTED' })
      const result = original.cleanupWindowsHelperDeployment(...args)
      throw Object.assign(new Error('interrupted'), { code: 'INTERRUPTED' })
    } }
    const resource = await sandbox.prepareWindowsGrokSandbox(f.options), request = resource.launch.argv[4]
    resource.markReservationEntered()
    await assert.rejects(resource.cleanup(), { code: 'INTERRUPTED' })
    return { f, resource, request, commit: path.join(f.root, `grok-helper-cleanup-${'1'.repeat(32)}.json`) }
  }
  {
    const { f, resource, request, commit } = await interruptedFixture('before-delete')
    fs.writeFileSync(commit, `${JSON.stringify({ schemaVersion: 1 })}\n`)
    await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request, helperDeploymentRoot: f.helperDeploymentRoot,
      processOwner: f.makeOwner(), binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies }),
    { code: 'GROK_WINDOWS_SANDBOX_RECOVERY_INVALID' })
    assert.equal(fs.existsSync(request), true)
  }
  {
    const { f, resource, request, commit } = await interruptedFixture('after-delete')
    fs.unlinkSync(commit)
    await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request, helperDeploymentRoot: f.helperDeploymentRoot,
      processOwner: f.makeOwner(), binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies }),
    { code: 'GROK_WINDOWS_SANDBOX_RECOVERY_INVALID' })
  }
  {
    const { f, resource, request } = await interruptedFixture('before-delete')
    fs.writeFileSync(path.join(f.root, 'resources.json.restored'), JSON.stringify({ schemaVersion: 1, leaseId: '1'.repeat(32), profileSid: 'S-1-15-2-1-2-3-4-5-6-7', result: { restored: 0, newEntries: 0, deletedEntries: 0 } }))
    await assert.rejects(sandbox.recoverWindowsGrokSandbox({ controlRoot: f.root, brokerRequestPath: request, helperDeploymentRoot: f.helperDeploymentRoot,
      processOwner: f.makeOwner(), binding: { ...f.binding, launchBindingHash: resource.launchBindingHash }, _dependencies: f.options._dependencies }),
    { code: 'GROK_WINDOWS_SANDBOX_RECOVERY_INVALID' })
  }
})
