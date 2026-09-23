'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const launch = require('../../scripts/harness-v2-bridge/grok/windows-launch.cjs')

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-win-launch-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pkg = path.join(root, 'node_modules', '@xai-official', 'grok')
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@xai-official/grok', version: '1.0.13' }))
  fs.writeFileSync(path.join(pkg, 'bin', 'grok'), '#!/usr/bin/env node\n')
  const sourceNode = path.join(root, 'node-source.exe'); fs.writeFileSync(sourceNode, 'stable-node-bytes')
  const sessionRoot = path.join(root, 'session'), launchRoot = path.join(sessionRoot, 'launch')
  return { root, pkg, grokExecutable: path.join(pkg, 'bin', 'grok'), sourceNode, sessionRoot, launchRoot }
}

test('prepareSession derives the official package root and exposes a stable closed projection', t => {
  const f = fixture(t), session = launch.prepareSession({ ...f, platform: 'win32', nodeExecutable: f.sourceNode })
  assert.equal(session.packageRoot, f.pkg)
  assert.equal(session.config.sessionHome, session.privateRoots.home)
  assert.deepEqual(session.config.runtimeProjection, { platform: 'win32', nodeExecutable: session.nodeExecutable, skillsPath: session.privateRoots.skills, mcpPort: 19778 })
  assert.equal(sha(fs.readFileSync(session.nodeExecutable)), session.nodeExecutableSha256)
  assert.equal(fs.readFileSync(session.nodeExecutable, 'utf8'), 'stable-node-bytes')
  assert.notEqual(session.privateRoots.control, session.privateRoots.cwd)
})

test('Node copy reuse verifies bytes and never overwrites a foreign existing file', t => {
  const f = fixture(t), first = launch.prepareSession({ ...f, platform: 'win32', nodeExecutable: f.sourceNode })
  fs.writeFileSync(f.sourceNode, 'changed-source')
  assert.throws(() => launch.prepareSession({ ...f, platform: 'win32', nodeExecutable: f.sourceNode }), { code: 'GROK_WINDOWS_LAUNCH_IDENTITY_CHANGED' })
  assert.equal(fs.readFileSync(first.nodeExecutable, 'utf8'), 'stable-node-bytes')
  fs.writeFileSync(first.nodeExecutable, 'tampered-copy')
  assert.throws(() => launch.copyExact(f.sourceNode, first.nodeExecutable), { code: 'GROK_WINDOWS_LAUNCH_IDENTITY_CHANGED' })
})

test('prepareLaunch passes reservation-private roots and closed Windows environments to the existing broker resource', async t => {
  const f = fixture(t), session = launch.prepareSession({ ...f, platform: 'win32', nodeExecutable: f.sourceNode })
  let observed
  const resource = Object.freeze({ cleanup() {} })
  const result = await launch.prepareLaunch({ session, config: { ...session.config, model: 'grok', relayToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), allowedMcpTools: { autoprompt_owned__read: 'read' }, issuedCalls: [], systemRoot: 'C:\\Windows', systemPath: 'C:\\Windows\\System32' }, sessionRoot: session.sessionRoot, launchRoot: session.launchRoot,
    grokExecutable: f.grokExecutable, processOwner: {}, binding: { reservationId: 'r', sessionId: 's', targetKey: 'grok' },
    pipe: { socketPath: '\\\\.\\pipe\\autoprompt-grok-' + 'a'.repeat(64) }, spec: { argv: ['--verbatim'], taskRoot: path.join(f.root, 'task'), candidateRoot: path.join(f.root, 'candidate') },
    _dependencies: { stageWindowsHelperDeployment: controlRoot => ({ root: path.join(controlRoot, 'staged-helper'), cleanup() {} }), prepareSandbox: async options => { observed = options; return resource } } })
  assert.equal(typeof result.cleanup, 'function')
  assert.deepEqual(observed.policy.writableRoots, [session.privateRoots.cwd, session.privateRoots.scratch, session.privateRoots.home])
  assert.equal(observed.controlRoot, session.privateRoots.control)
  assert.equal(observed.helperDeploymentRoot, path.join(session.privateRoots.control, 'staged-helper'))
  assert.equal(observed.workerEnvironment.AUTOPROMPT_GROK_PROXY_PORT, '19777')
  assert.equal(observed.workerEnvironment.AUTOPROMPT_GROK_MCP_PORT, '19778')
  assert.equal(observed.brokerEnvironment.TEMP, session.privateRoots.scratch)
  assert.ok(!observed.policy.writableRoots.includes(path.join(f.root, 'task')))
})

test('package entrypoint and manifest are fail-closed', t => {
  const f = fixture(t)
  assert.throws(() => launch.prepareSession({ ...f, platform: 'win32', grokExecutable: path.join(f.pkg, 'not-bin', 'grok') }), { code: 'GROK_WINDOWS_LAUNCH_INVALID' })
  fs.writeFileSync(path.join(f.pkg, 'package.json'), JSON.stringify({ name: '@xai-official/grok', version: '9.9.9' }))
  assert.throws(() => launch.prepareSession({ ...f, platform: 'win32' }), { code: 'GROK_WINDOWS_LAUNCH_INVALID' })
})

test('prepareLaunch reaches the real broker materializer with a sealed worker contract', async t => {
  const f = fixture(t), session = launch.prepareSession({ ...f, platform: 'win32', nodeExecutable: f.sourceNode })
  const runtimeExecutable = path.join(f.root, 'materialized-grok.exe')
  fs.writeFileSync(runtimeExecutable, 'grok')
  const stat = fs.statSync(runtimeExecutable, { bigint: true })
  const runtime = Object.freeze({ executable: Object.freeze({ path: runtimeExecutable, size: 4, sha256: sha('grok'), identity: Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) }) }) })
  const launcher = Object.freeze({ binding: Object.freeze({ helper: Object.freeze({ path: path.join(f.root, 'helper'), sha256: 'a'.repeat(64) }) }),
    proveNotStarted: value => Object.freeze({ value }), verifyDrainEvidence: (evidence, value) => JSON.stringify(evidence.value) === JSON.stringify(value) })
  const journal = path.join(session.privateRoots.control, '1'.repeat(32) + '.resources.json')
  fs.writeFileSync(journal, 'resource-journal')
  const journalStat = fs.statSync(journal, { bigint: true })
  let stagedCleanup = 0, released = 0
  const resources = { async prepareWindowsAppContainerResources(options) {
    assert.deepEqual(options.policy.writableRoots, [session.privateRoots.cwd, session.privateRoots.scratch, session.privateRoots.home])
    return Object.freeze({ profileName: 'Autoprompt_fixture', profileSid: 'S-1-15-2-1-2-3-4-5-6-7',
      environment: Object.freeze({ USERPROFILE: 'C:\\profile', HOME: 'C:\\profile', APPDATA: 'C:\\profile\\AppData\\Roaming', TEMP: session.privateRoots.scratch, TMP: session.privateRoots.scratch }),
      recovery: Object.freeze({ journalPath: journal, leaseId: '1'.repeat(32) }),
      async release(evidence) { assert.equal(options.verifyDrainEvidence(evidence, { profileSid: this.profileSid, leaseId: this.recovery.leaseId }), true); released++ },
    }) } }
  const owner = { async issueBoundDrainReceipt(expected) { return { expected } }, verifyBoundDrainReceipt(receipt, expected) { return JSON.stringify(receipt.expected) === JSON.stringify(expected) } }
  const config = { ...session.config, model: 'grok', relayToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), allowedMcpTools: { autoprompt_owned__read: 'read' }, issuedCalls: [], systemRoot: 'C:\\Windows', systemPath: 'C:\\Windows\\System32' }
  const prepared = await launch.prepareLaunch({ session, config, sessionRoot: session.sessionRoot, launchRoot: session.launchRoot, processOwner: owner,
    binding: { reservationId: 'r', sessionId: 's', targetKey: 'grok' }, pipe: { socketPath: '\\\\.\\pipe\\autoprompt-grok-' + 'a'.repeat(64) }, spec: { argv: ['--verbatim'] },
    _dependencies: { stageWindowsHelperDeployment: root => ({ root, cleanup() { stagedCleanup++ } }), materializeRuntime: () => runtime,
      buildWorker: () => ({ payloadSha256: 'c'.repeat(64), moduleSha256: { 'sandbox-worker.cjs': 'd'.repeat(64) }, executable: session.nodeExecutable, argv: ['-e', 'worker'] }),
      createLauncher: () => launcher, resources } })
  const request = JSON.parse(fs.readFileSync(prepared.launch.argv[4], 'utf8'))
  const environment = Object.fromEntries(request.appLaunch.environment.map(value => value.split(/=(.*)/s)))
  assert.equal(environment.AUTOPROMPT_GROK_AUDIT_PATH, path.join(session.privateRoots.scratch, 'audit.jsonl'))
  assert.equal(environment.USERPROFILE, 'C:\\profile')
  assert.equal(environment.APPDATA, 'C:\\profile\\AppData\\Roaming')
  assert.equal(environment.LOCALAPPDATA, 'C:\\profile\\AppData\\Local')
  assert.equal(environment.TEMP, session.privateRoots.scratch)
  prepared.markReservationEntered()
  await prepared.cleanup()
  assert.equal(released, 1)
  assert.equal(stagedCleanup, 1)
})
