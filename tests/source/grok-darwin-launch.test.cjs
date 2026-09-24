'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')
const launch = require('../../scripts/harness-v2-bridge/grok/darwin-launch.cjs')
const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function machO(architecture = process.arch) {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4)
  bytes.writeUInt32LE(architecture === 'arm64' ? 0 : 3, 8)
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(32, 20)
  bytes.writeUInt32LE(1, 32); bytes.writeUInt32LE(32, 36)
  return bytes
}
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-darwin-launch-')))
  fs.chmodSync(base, 0o700)
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const official = path.join(base, 'source', 'node_modules', '@xai-official')
  const wrapper = path.join(official, 'grok'), platform = path.join(official, `grok-darwin-${process.arch}`)
  fs.mkdirSync(path.join(wrapper, 'bin'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(platform, 'bin'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(wrapper, 'package.json'), JSON.stringify({ name: '@xai-official/grok', version: launch.PINNED_VERSION,
    bin: { grok: 'bin/grok' }, optionalDependencies: { [`@xai-official/grok-darwin-${process.arch}`]: launch.PINNED_VERSION } }), { mode: 0o600 })
  fs.writeFileSync(path.join(platform, 'package.json'), JSON.stringify({ name: `@xai-official/grok-darwin-${process.arch}`, version: launch.PINNED_VERSION, os: ['darwin'], cpu: [process.arch] }), { mode: 0o600 })
  const grokExecutable = path.join(wrapper, 'bin', 'grok'), compressedGrok = path.join(platform, 'bin', 'grok.br'), nodeExecutable = path.join(base, 'node')
  fs.writeFileSync(grokExecutable, '#!/usr/bin/env node\n'); fs.writeFileSync(compressedGrok, zlib.brotliCompressSync(machO())); fs.writeFileSync(nodeExecutable, 'node-runtime')
  for (const file of [grokExecutable, nodeExecutable]) fs.chmodSync(file, 0o500)
  fs.chmodSync(compressedGrok, 0o400)
  const sessionRoot = path.join(base, 'private', 'session'), launchRoot = path.join(sessionRoot, 'launch')
  fs.mkdirSync(path.dirname(sessionRoot), { mode: 0o700 })
  return { base, wrapper, platform, grokExecutable, compressedGrok, nodeExecutable, sessionRoot, launchRoot }
}
const fixedPorts = () => Object.freeze({ proxyPort: 29777, mcpPort: 29778 })
function ownership(reservationId = 'darwin-owned-reservation') {
  const adapter = Object.freeze({ kind: 'darwin-launchd-coalition', childControlEnvironment: value => ({ AUTOPROMPT_OWNERSHIP_RESERVATION: value }) })
  return Object.freeze({ processOwner: Object.freeze({ adapter, launch() {} }), binding: Object.freeze({ sessionId: 'darwin-owned-session', reservationId, targetKey: 'darwin-owned-target' }) })
}
function admittedOwner(root) {
  const adapter = {
    kind: 'darwin-launchd-coalition',
    capabilities: { groupAtCreation: true, descendantEnumeration: true, groupSignal: true, stableIdentity: true, persistentIdentity: true, reservationRecovery: true },
    childControlEnvironment: value => ({ AUTOPROMPT_OWNERSHIP_RESERVATION: value }),
    async admit() { return { supported: true } },
    async spawnOwned(spec) { this.spawned = spec; return { rootPid: 731, groupIdentity: 'darwin-coalition:test:731' } },
    async recoverReservation() { return null }, async probeReservation() { return { state: 'DEAD' } },
    async listOwned() { return [] }, async signalOwned() {}, async verifyOwnership() { return true }, async listTargetOwned() { return [] }, async probeOwnedIdentity() { return [] },
  }
  return { adapter, owner: new ProcessOwner({ adapter, registryPath: path.join(root, 'processes.json'), startupTimeoutMs: 1000 }) }
}
async function session(f, overrides = {}) {
  return launch.prepareSession({ ...f, architecture: process.arch, _dependencies: { platform: 'darwin', reserveListeners: fixedPorts }, ...overrides })
}

test('Darwin session snapshots only exact Node and raw Grok bytes outside writable roots', async t => {
  const f = fixture(t), value = await session(f)
  assert.equal(value.platform, 'darwin'); assert.equal(value.architecture, process.arch)
  assert.equal(value.nodeExecutable, path.join(value.privateRoots.runtime, 'node'))
  assert.equal(value.grokExecutable, path.join(value.privateRoots.runtime, 'grok'))
  assert.equal(digest(value.nodeExecutable), digest(f.nodeExecutable)); assert.deepEqual(fs.readFileSync(value.grokExecutable), machO())
  assert.notEqual(value.privateRoots.runtime, value.privateRoots.home)
  assert.equal(value.privateRoots.runtime.startsWith(`${value.privateRoots.cwd}${path.sep}`), false)
  assert.deepEqual(value.darwinListeners, { proxy: { fd: 3, host: '::1', port: 29777 }, mcp: { fd: 4, host: '::1', port: 29778 } })
  assert.deepEqual(value.config.runtimeProjection, { platform: 'darwin', nodeExecutable: value.nodeExecutable, skillsPath: value.privateRoots.skills, proxyPort: 29777, mcpPort: 29778 })
  assert.equal(fs.statSync(value.nodeExecutable).mode & 0o777, 0o500)
  assert.equal(Object.isFrozen(value.privateRoots), true); assert.equal(Object.isFrozen(value.darwinListeners.proxy), true)
})

test('Darwin session reserves both IPv6 loopback ports simultaneously and releases them', { timeout: 10000 }, async t => {
  const f = fixture(t)
  const value = await launch.prepareSession({ ...f, architecture: process.arch, _dependencies: { platform: 'darwin' } })
  assert.notEqual(value.darwinListeners.proxy.port, value.darwinListeners.mcp.port)
  assert.ok(value.darwinListeners.proxy.port >= 1024); assert.ok(value.darwinListeners.mcp.port >= 1024)
})

test('Darwin session persists one private port pair across continuation launch roots', async t => {
  const f = fixture(t)
  let next = 31000
  const allocate = expected => expected || { proxyPort: next++, mcpPort: next++ }
  const first = await session(f, { _dependencies: { platform: 'darwin', reserveListeners: allocate } })
  const continuationRoot = path.join(f.sessionRoot, 'continuation')
  const second = await session(f, { launchRoot: continuationRoot, _dependencies: { platform: 'darwin', reserveListeners: allocate } })
  assert.deepEqual(second.config.runtimeProjection, first.config.runtimeProjection)
  assert.deepEqual(second.darwinListeners, first.darwinListeners)
  assert.notEqual(second.privateRoots.cwd, first.privateRoots.cwd)

  const other = fixture(t)
  const fresh = await session(other, { _dependencies: { platform: 'darwin', reserveListeners: allocate } })
  assert.notDeepEqual(fresh.config.runtimeProjection, first.config.runtimeProjection)
  assert.notEqual(fresh.darwinListeners.proxy.port, first.darwinListeners.proxy.port)
})

test('Darwin continuation refuses a recorded listener pair while either port is occupied', { timeout: 10000 }, async t => {
  const f = fixture(t), first = await launch.prepareSession({ ...f, architecture: process.arch, _dependencies: { platform: 'darwin' } })
  const blocker = net.createServer()
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen({ host: '::1', port: first.darwinListeners.proxy.port, ipv6Only: true, exclusive: true }, resolve) })
  t.after(() => new Promise(resolve => blocker.close(resolve)))
  await assert.rejects(launch.prepareSession({ ...f, launchRoot: path.join(f.sessionRoot, 'continuation'), architecture: process.arch, _dependencies: { platform: 'darwin' } }),
    { code: 'GROK_DARWIN_LISTENER_UNAVAILABLE' })
})

test('Darwin continuation rejects a mutable or multiply-linked listener record', async t => {
  const f = fixture(t), first = await session(f)
  const record = path.join(f.sessionRoot, '.grok-darwin-listeners.json')
  assert.equal(fs.statSync(record).mode & 0o777, 0o400)
  fs.linkSync(record, `${record}.foreign-link`)
  await assert.rejects(session(f, { launchRoot: path.join(f.sessionRoot, 'continuation') }), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  assert.deepEqual(first.darwinListeners, { proxy: { fd: 3, host: '::1', port: 29777 }, mcp: { fd: 4, host: '::1', port: 29778 } })
})

test('Darwin launch emits a closed Seatbelt worker projection with inherited FD3 and FD4', async t => {
  const f = fixture(t), prepared = await session(f), pipe = { socketPath: path.join(f.base, 'relay.sock') }
  const config = { ...prepared.config, model: 'grok-4', relayToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), allowedMcpTools: { autoprompt_owned__read: 'read' }, issuedCalls: [{ callId: 'one' }] }
  const value = await launch.prepareLaunch({ session: prepared, sessionRoot: f.sessionRoot, launchRoot: f.launchRoot, config, pipe, spec: { argv: ['--verbatim'] }, ...ownership() })
  assert.equal(value.launch.executable, '/usr/bin/sandbox-exec')
  assert.equal(value.launch.argv[0], '-p'); assert.match(value.launch.argv[1], /^\(version 1\)\n\(deny default\)/)
  assert.equal(value.launch.argv[2], prepared.nodeExecutable)
  assert.deepEqual(value.launch.argv.slice(-1), ['--verbatim'])
  assert.deepEqual(value.relayStdin, pipe); assert.deepEqual(value.darwinListeners, prepared.darwinListeners)
  assert.deepEqual(Object.keys(value.launch.env).sort(), [
    'AUTOPROMPT_GROK_ALLOWED_MCP_TOOLS', 'AUTOPROMPT_GROK_AUDIT_PATH', 'AUTOPROMPT_GROK_CWD', 'AUTOPROMPT_GROK_EXECUTABLE', 'AUTOPROMPT_GROK_ISSUED_CALLS',
    'AUTOPROMPT_GROK_MCP_LISTENER_FD', 'AUTOPROMPT_GROK_MCP_PORT', 'AUTOPROMPT_GROK_MODEL', 'AUTOPROMPT_GROK_PROXY_LISTENER_FD', 'AUTOPROMPT_GROK_PROXY_PORT',
    'AUTOPROMPT_GROK_PROXY_TOKEN', 'AUTOPROMPT_GROK_RELAY_FD', 'AUTOPROMPT_GROK_RELAY_TOKEN', 'GROK_HOME', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    'AUTOPROMPT_OWNERSHIP_RESERVATION',
  ].sort())
  assert.equal(value.launch.env.AUTOPROMPT_GROK_PROXY_LISTENER_FD, '3'); assert.equal(value.launch.env.AUTOPROMPT_GROK_MCP_LISTENER_FD, '4')
  assert.equal(value.launch.env.AUTOPROMPT_GROK_EXECUTABLE, prepared.grokExecutable)
  assert.equal(JSON.stringify(value.launch.env).includes(f.sessionRoot + '/controller'), false)
  await value.cleanup()
  assert.equal(fs.existsSync(prepared.grokExecutable), true, 'activation-root teardown owns persisted snapshots')
})

test('Darwin launch attests the reservation through the actual ProcessOwner admission check', async t => {
  const f = fixture(t), prepared = await session(f), admitted = admittedOwner(f.base)
  const binding = { sessionId: 'darwin-admission-session', reservationId: 'darwin-admission-reservation', targetKey: 'darwin-admission-target' }
  const config = { ...prepared.config, model: 'grok-4', relayToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), allowedMcpTools: { autoprompt_owned__read: 'read' }, issuedCalls: [] }
  const value = await launch.prepareLaunch({ session: prepared, sessionRoot: f.sessionRoot, launchRoot: f.launchRoot, config,
    pipe: { socketPath: path.join(f.base, 'relay.sock') }, processOwner: admitted.owner, binding,
    spec: { argv: ['--verbatim'], env: { AUTOPROMPT_OWNERSHIP_RESERVATION: 'foreign', HOME: '/foreign' } } })
  assert.equal(value.launch.env.AUTOPROMPT_OWNERSHIP_RESERVATION, binding.reservationId)
  await admitted.owner.launch({ executable: value.launch.executable, argv: value.launch.argv, cwd: value.launch.cwd, env: value.launch.env,
    shell: false, sessionId: binding.sessionId, reservationId: binding.reservationId, targetKey: binding.targetKey, forWork: false })
  assert.equal(admitted.adapter.spawned.env.AUTOPROMPT_OWNERSHIP_RESERVATION, binding.reservationId)
  assert.equal(admitted.adapter.spawned.env.HOME, prepared.privateRoots.home)
  await value.cleanup()
})

test('Darwin session refuses package drift, missing raw payload, linked input, and changed private snapshots', async t => {
  {
    const f = fixture(t); fs.unlinkSync(f.compressedGrok)
    await assert.rejects(session(f), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  }
  {
    const f = fixture(t), link = path.join(f.base, 'linked-node'); fs.symlinkSync(f.nodeExecutable, link)
    await assert.rejects(session(f, { nodeExecutable: link }), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  }
  {
    const f = fixture(t), wrong = process.arch === 'arm64' ? 'x64' : 'arm64'
    fs.chmodSync(f.compressedGrok, 0o600); fs.writeFileSync(f.compressedGrok, zlib.brotliCompressSync(machO(wrong))); fs.chmodSync(f.compressedGrok, 0o400)
    await assert.rejects(session(f), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  }
  {
    const f = fixture(t), first = await session(f)
    fs.chmodSync(first.nodeExecutable, 0o700); fs.writeFileSync(first.nodeExecutable, 'foreign-private-node'); fs.chmodSync(first.nodeExecutable, 0o500)
    await assert.rejects(session(f), { code: 'GROK_DARWIN_LAUNCH_IDENTITY_CHANGED' })
  }
  {
    const f = fixture(t), manifest = path.join(f.wrapper, 'package.json'), value = JSON.parse(fs.readFileSync(manifest)); value.version = '9.9.9'; fs.writeFileSync(manifest, JSON.stringify(value))
    await assert.rejects(session(f), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  }
})

test('Darwin launch rejects rebound config, ambiguous relay, and ambient policy fields', async t => {
  const f = fixture(t), prepared = await session(f)
  const base = { session: prepared, sessionRoot: f.sessionRoot, launchRoot: f.launchRoot, ...ownership(),
    config: { ...prepared.config, model: 'grok', relayToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), allowedMcpTools: { owned: 'read' }, issuedCalls: [] },
    pipe: { socketPath: path.join(f.base, 'relay.sock') }, spec: { argv: [] } }
  await assert.rejects(launch.prepareLaunch({ ...base, config: { ...base.config, runtimeProjection: { ...base.config.runtimeProjection, proxyPort: 12345 } } }), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  await assert.rejects(launch.prepareLaunch({ ...base, pipe: { socketPath: 'relative' } }), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  await assert.rejects(launch.prepareLaunch({ ...base, config: { ...base.config, allowedMcpTools: {} } }), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  fs.renameSync(prepared.grokExecutable, `${prepared.grokExecutable}.admitted`)
  fs.writeFileSync(prepared.grokExecutable, machO(), { mode: 0o500 })
  await assert.rejects(launch.prepareLaunch(base), { code: 'GROK_DARWIN_LAUNCH_IDENTITY_CHANGED' })
})

test('Darwin launch re-audits private root and snapshot permissions', async t => {
  const f = fixture(t), prepared = await session(f)
  const base = { session: prepared, sessionRoot: f.sessionRoot, launchRoot: f.launchRoot, ...ownership(),
    config: { ...prepared.config, model: 'grok', relayToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), allowedMcpTools: { owned: 'read' }, issuedCalls: [] },
    pipe: { socketPath: path.join(f.base, 'relay.sock') }, spec: { argv: [] } }
  fs.chmodSync(prepared.privateRoots.scratch, 0o770)
  await assert.rejects(launch.prepareLaunch(base), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
  fs.chmodSync(prepared.privateRoots.scratch, 0o700)
  fs.renameSync(prepared.privateRoots.scratch, `${prepared.privateRoots.scratch}.admitted`); fs.mkdirSync(prepared.privateRoots.scratch, { mode: 0o700 })
  await assert.rejects(launch.prepareLaunch(base), { code: 'GROK_DARWIN_LAUNCH_IDENTITY_CHANGED' })

  const other = fixture(t), second = await session(other)
  const secondLaunch = { session: second, sessionRoot: other.sessionRoot, launchRoot: other.launchRoot, ...ownership('darwin-second-reservation'),
    config: { ...second.config, model: 'grok', relayToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), allowedMcpTools: { owned: 'read' }, issuedCalls: [] },
    pipe: { socketPath: path.join(other.base, 'relay.sock') }, spec: { argv: [] } }
  fs.chmodSync(second.nodeExecutable, 0o570)
  await assert.rejects(launch.prepareLaunch(secondLaunch), { code: 'GROK_DARWIN_LAUNCH_INVALID' })
})
