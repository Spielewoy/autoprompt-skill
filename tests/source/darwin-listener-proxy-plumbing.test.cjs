'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const test = require('node:test')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')

const phasePath = path.resolve(__dirname, '../../agents/codex/workflow/phase-budget.js')
const listeners = () => ({ proxy: { fd: 3, host: '::1', port: 19777 }, mcp: { fd: 4, host: '::1', port: 19778 } })

function projectedRunner(platform) {
  const module = { exports: {} }, projected = Object.create(process)
  Object.defineProperty(projected, 'platform', { value: platform })
  vm.runInNewContext(fs.readFileSync(phasePath, 'utf8'), {
    module, exports: module.exports, require: createRequire(phasePath), __dirname: path.dirname(phasePath), __filename: phasePath,
    process: projected, Buffer, console, setTimeout, clearTimeout, setImmediate, clearImmediate, URL, AbortController,
  }, { filename: phasePath })
  return module.exports.OwnedCodexProxyRunner
}

function projectedProxyReceiver(onSpawn = () => {}) {
  const module = { exports: {} }, projected = Object.create(process)
  Object.defineProperty(projected, 'platform', { value: 'darwin' })
  const localRequire = createRequire(phasePath)
  const childProcess = {
    ...localRequire('node:child_process'),
    spawn(executable, argv, options) {
      onSpawn({ executable, argv, options })
      const child = new EventEmitter()
      child.pid = 4242
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      setImmediate(() => {
        child.emit('spawn')
        child.emit('close', 0, null)
      })
      return child
    },
  }
  const network = {
    ...localRequire('node:net'),
    createConnection() {
      const socket = new PassThrough()
      setImmediate(() => socket.emit('connect'))
      return socket
    },
  }
  const source = `${fs.readFileSync(phasePath, 'utf8')}\nmodule.exports.runOwnedCodexProxyForTest = runOwnedCodexProxy\n`
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name) {
      if (name === 'node:child_process') return childProcess
      if (name === 'node:net') return network
      return localRequire(name)
    },
    __dirname: path.dirname(phasePath), __filename: phasePath,
    process: projected, Buffer, console, setTimeout, clearTimeout, setImmediate, clearImmediate, URL, AbortController,
  }, { filename: phasePath })
  return module.exports.runOwnedCodexProxyForTest
}

function proxyRequest(root, overrides = {}) {
  const descriptor = overrides.darwinListeners || listeners()
  const executable = overrides.executable || process.execPath
  const argv = overrides.argv || ['-e', '']
  const argvHash = crypto.createHash('sha256').update(JSON.stringify({ executable, argv, darwinListeners: descriptor }), 'utf8').digest('hex')
  return {
    schemaVersion: 2, activationId: 'activation', generationId: 1, sequence: 1,
    executable, argv, cwd: root, stdin: '',
    relayStdin: { socketPath: path.join(root, 'relay.sock') },
    stdoutPath: path.join(root, 'stdout.bin'), stderrPath: path.join(root, 'stderr.log'), statusPath: path.join(root, 'status.json'),
    darwinListeners: descriptor, argvHash,
    ...overrides,
  }
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filePath)) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${path.basename(filePath)}`)
}

function deferred() {
  let resolve
  const promise = new Promise(value => { resolve = value })
  return { promise, resolve }
}

class DarwinAdapter {
  constructor() {
    this.kind = 'darwin-launchd-coalition'
    this.capabilities = { groupAtCreation: true, descendantEnumeration: true, groupSignal: true, stableIdentity: true, persistentIdentity: true, reservationRecovery: true }
    this.generation = 0; this.spawned = null; this.gate = deferred()
  }
  async admit() { await this.gate.promise; return { supported: true } }
  prepareReservation(value) { return { ...value, adapterKind: this.kind } }
  async spawnOwned(spec) { this.spawned = spec; return { rootPid: 700, groupIdentity: 'darwin-coalition:fixture:1' } }
  async recoverReservation() { return null }
  async probeReservation() { return { state: 'DEAD', evidence: { source: 'test' } } }
  async listOwned() { return [] }
  async signalOwned() {}
  async verifyOwnership() { return true }
  async listTargetOwned() { return [] }
  async probeOwnedIdentity() { return [] }
}

test('ProcessOwner snapshots exact Darwin listener pairs and rejects every non-Darwin descriptor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-listener-owner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const adapter = new DarwinAdapter()
  const owner = new ProcessOwner({ adapter, registryPath: path.join(root, 'processes.json'), startupTimeoutMs: 1000 })
  const source = listeners()
  const launched = owner.launch({ executable: process.execPath, argv: ['-e', ''], cwd: root, env: {}, targetKey: 'darwin-listener-test',
    sessionId: 's', reservationId: 'r', darwinListeners: source, forWork: false })
  source.proxy.port = 22001; source.mcp.port = 22002
  adapter.gate.resolve()
  await launched
  assert.deepEqual(adapter.spawned.darwinListeners, listeners())
  assert.equal(Object.isFrozen(adapter.spawned.darwinListeners.proxy), true)
  for (const [index, value] of [
    { proxy: { fd: 9, host: '::1', port: 19777 }, mcp: { fd: 4, host: '::1', port: 19778 } },
    { proxy: { fd: 3, host: '127.0.0.1', port: 19777 }, mcp: { fd: 4, host: '::1', port: 19778 } },
    { proxy: { fd: 3, host: '::1', port: 80 }, mcp: { fd: 4, host: '::1', port: 19778 } },
    { proxy: { fd: 3, host: '::1', port: 19777 }, mcp: { fd: 4, host: '::1', port: 19777 } },
    { proxy: { fd: 3, host: '::1', port: 19777, extra: true }, mcp: { fd: 4, host: '::1', port: 19778 } },
  ].entries()) {
    await assert.rejects(owner.launch({ executable: process.execPath, argv: [], cwd: root, env: {}, targetKey: 'bad-listener',
      sessionId: `s-${index}`, reservationId: `r-${index}`, darwinListeners: value }), { code: 'LAUNCH_SPEC_INVALID' })
  }

  adapter.kind = 'posix-process-group'
  const invalidOwner = new ProcessOwner({ adapter, registryPath: path.join(root, 'other.json'), startupTimeoutMs: 1000 })
  await assert.rejects(invalidOwner.launch({ executable: process.execPath, argv: [], cwd: root, env: {}, targetKey: 'wrong-platform', darwinListeners: {} }), { code: 'LAUNCH_SPEC_INVALID' })
})

test('Darwin proxy request binds one immutable FD3/FD4 pair and requires a prepared relay', async t => {
  const Runner = projectedRunner('darwin')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-listener-proxy-'))
  let server, cleaned = false
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const source = listeners(), stop = new Error('stop after request capture')
  let outer, request
  const owner = { adapter: { kind: 'darwin-launchd-coalition' }, cancelGroup() {}, async launch(spec) {
    outer = spec; request = JSON.parse(fs.readFileSync(spec.argv.at(-1), 'utf8')); throw stop
  } }
  const runner = new Runner({ processOwner: owner, controlRoot: root, targetKey: 'listener-proxy' })
  await assert.rejects(runner.run({ sessionId: 's', reservationId: 'r', executable: process.execPath, argv: [], cwd: root, env: {},
    prepareLaunch: async ({ sessionRoot }) => {
      const socketPath = path.join(sessionRoot, 'relay.sock')
      server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
      fs.chmodSync(socketPath, 0o600)
      return { relayStdin: { socketPath }, darwinListeners: source,
        launch: { executable: process.execPath, argv: ['-e', ''], cwd: root, env: {}, darwinListeners: source },
        cleanup() { cleaned = true } }
    },
  }), error => error === stop)
  source.proxy.port = 24001
  assert.equal(JSON.stringify(outer.darwinListeners), JSON.stringify(listeners()))
  assert.equal(JSON.stringify(request.darwinListeners), JSON.stringify(listeners()))
  assert.match(request.argvHash, /^[a-f0-9]{64}$/)
  assert.equal(cleaned, true)

  const LinuxRunner = projectedRunner('linux')
  const linuxControl = path.join(root, 'linux'); fs.mkdirSync(linuxControl)
  const rejected = new LinuxRunner({ processOwner: { adapter: { kind: 'posix-process-group' }, launch() { assert.fail('must not spawn') }, cancelGroup() {} }, controlRoot: linuxControl, targetKey: 'listener-proxy' })
  await assert.rejects(rejected.run({ sessionId: 'ls', reservationId: 'lr', executable: process.execPath, argv: [], cwd: root, env: {}, darwinListeners: listeners(),
    prepareLaunch: async () => ({ relayStdin: { socketPath: path.join(root, 'not-used') }, darwinListeners: listeners(), cleanup() {} }),
  }), { code: 'CODEX_PROXY_REQUEST_INVALID' })
})

test('Darwin proxy receiver forwards only its authenticated FD3/FD4 pair and rejects tampering before spawn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-listener-receiver-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const spawned = []
  const runOwnedCodexProxy = projectedProxyReceiver(value => spawned.push(value))

  const request = proxyRequest(root)
  const requestPath = path.join(root, 'request.json')
  fs.writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 })
  await runOwnedCodexProxy(requestPath)
  await waitForFile(request.statusPath)
  assert.equal(spawned.length, 1)
  assert.equal(typeof spawned[0].options.stdio[0].destroy, 'function')
  assert.deepEqual(Array.from(spawned[0].options.stdio).slice(1), ['pipe', 'pipe', 3, 4])
  assert.deepEqual(JSON.parse(fs.readFileSync(request.statusPath, 'utf8')).argvHash, request.argvHash)

  const tamperedRoot = path.join(root, 'tampered'); fs.mkdirSync(tamperedRoot)
  const tampered = proxyRequest(tamperedRoot)
  tampered.darwinListeners.proxy.port = 19779
  const tamperedPath = path.join(tamperedRoot, 'request.json')
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered), { mode: 0o600 })
  await assert.rejects(runOwnedCodexProxy(tamperedPath), { code: 'CODEX_PROXY_REQUEST_INVALID' })
  assert.equal(spawned.length, 1)

  const missingRelayRoot = path.join(root, 'missing-relay'); fs.mkdirSync(missingRelayRoot)
  const missingRelay = proxyRequest(missingRelayRoot)
  delete missingRelay.relayStdin
  missingRelay.argvHash = crypto.createHash('sha256').update(JSON.stringify({
    executable: missingRelay.executable, argv: missingRelay.argv, darwinListeners: missingRelay.darwinListeners,
  }), 'utf8').digest('hex')
  const missingRelayPath = path.join(missingRelayRoot, 'request.json')
  fs.writeFileSync(missingRelayPath, JSON.stringify(missingRelay), { mode: 0o600 })
  await assert.rejects(runOwnedCodexProxy(missingRelayPath), { code: 'CODEX_PROXY_REQUEST_INVALID' })
  assert.equal(spawned.length, 1)
})
