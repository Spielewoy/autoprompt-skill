'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const test = require('node:test')
const filename = path.resolve(__dirname, '../../agents/codex/workflow/phase-budget.js')
const HASH = 'a'.repeat(64)
const PIPE = `\\\\.\\pipe\\autoprompt-grok-${'b'.repeat(64)}`
function projectedRunner(platform) {
  const exports = {}, module = { exports }, projected = Object.create(process)
  Object.defineProperty(projected, 'platform', { value: platform })
  const context = vm.createContext({ module, exports, require: createRequire(filename), __filename: filename,
    __dirname: path.dirname(filename), process: projected, Buffer, console, setTimeout, clearTimeout, setImmediate, clearImmediate, URL, AbortController })
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  return module.exports.OwnedCodexProxyRunner
}
const Runner = projectedRunner('win32')
function fixture(t, resource, specChanges = {}, Class = Runner) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-proxy-resource-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const events = [], pending = new Error('physical spawn remains pending')
  const owner = { cancelGroup() {}, async launch(spec) {
    events.push('owner-entered')
    assert.equal(spec.launchBindingHash, HASH)
    const request = JSON.parse(fs.readFileSync(spec.argv.at(-1), 'utf8'))
    assert.equal(request.relayStdin.socketPath, PIPE)
    assert.deepEqual(request.argv, ['--broker'])
    throw pending
  } }
  const runner = new Class({ controlRoot: root, processOwner: owner, targetKey: 'target' })
  const spec = { sessionId: 'session', reservationId: 'reservation', executable: process.execPath,
    argv: [], cwd: root, env: {}, prepareLaunch: async () => ({
      relayStdin: { socketPath: PIPE }, launchBindingHash: HASH,
      markReservationEntered() { events.push('marked') },
      cleanup() { events.push(events.includes('marked') ? 'retain-until-owned-drain' : 'prestart-cleanup') },
      launch: { executable: process.execPath, argv: ['--broker'], cwd: root, env: {} }, ...resource,
    }), ...specChanges }
  return { runner, spec, events, pending }
}
test('prepared resource binding and entry marker precede an ambiguous owned launch', async t => {
  const f = fixture(t)
  await assert.rejects(f.runner.run(f.spec), error => error === f.pending)
  assert.deepEqual(f.events, ['marked', 'owner-entered', 'retain-until-owned-drain'])
})
test('incomplete, nonstring and conflicting resource bindings reject before owner entry', async t => {
  for (const [resource, changes] of [
    [{ markReservationEntered: undefined }, {}], [{ launchBindingHash: undefined }, {}],
    [{ launchBindingHash: [HASH] }, {}], [{ launchBindingHash: 'bad' }, {}],
    [{}, { launchBindingHash: 'c'.repeat(64) }],
  ]) {
    const f = fixture(t, resource, changes)
    await assert.rejects(f.runner.run(f.spec), { code: 'CODEX_PROXY_REQUEST_INVALID' })
    assert.deepEqual(f.events, ['prestart-cleanup'])
  }
})
test('Windows prepared relays reject arbitrary pipe namespaces and file paths', async t => {
  for (const socketPath of ['C:\\private\\socket', '\\\\server\\pipe\\autoprompt-grok-' + 'b'.repeat(64),
    '\\\\.\\pipe\\other-' + 'b'.repeat(64), PIPE + '\\child', PIPE + '\0', PIPE.toUpperCase(), '/tmp/socket']) {
    const f = fixture(t, { relayStdin: { socketPath } })
    await assert.rejects(f.runner.run(f.spec), { code: 'CODEX_PROXY_REQUEST_INVALID' })
    assert.deepEqual(f.events, ['prestart-cleanup'])
  }
})
test('POSIX prepared relays retain physical private socket checks', async t => {
  const f = fixture(t, {}, {}, projectedRunner('linux'))
  f.spec.prepareLaunch = async ({ sessionRoot }) => {
    const socketPath = path.join(sessionRoot, 'ordinary-file')
    fs.writeFileSync(socketPath, '', { mode: 0o600 })
    return { relayStdin: { socketPath }, cleanup() { f.events.push('prestart-cleanup') } }
  }
  await assert.rejects(f.runner.run(f.spec), { code: 'CODEX_PROXY_REQUEST_INVALID' })
  assert.deepEqual(f.events, ['prestart-cleanup'])
})

test('native owned proxy preserves a duplex relay and issues the prepared resource exact drain receipt', {
  timeout: 180000,
}, async t => {
  const net = require('node:net'), crypto = require('node:crypto')
  const { OwnedCodexProxyRunner } = require(filename)
  const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
  const { privateDirectory, nativeProcessAdapter } = require('../helpers/native-platform.cjs')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ap-pr-')))
  privateDirectory(root)
  const controller = privateDirectory(path.join(root, 'controller'))
  const proxy = privateDirectory(path.join(controller, 'proxy'))
  const processRoot = privateDirectory(path.join(controller, 'processes'))
  let owner, server, socketPath, relayDirectoryFd, entered = false, released = false, response = ''
  const sockets = new Set()
  t.after(async () => {
    if (owner) {
      await owner.cancelAll({ reason: 'prepared relay test cleanup', graceMs: 0, killMs: 10000, waitForPending: true })
      await owner.assertDrained()
    }
    for (const socket of sockets) socket.destroy()
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (relayDirectoryFd !== undefined) { fs.closeSync(relayDirectoryFd); relayDirectoryFd = undefined }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const registryPath = path.join(processRoot, 'registry.json')
  const adapter = nativeProcessAdapter(registryPath, controller)
  owner = new ProcessOwner({ adapter, registryPath, pollMs: 10 })
  const sessionId = 'native-relay', reservationId = crypto.randomUUID(), targetKey = 'native-relay-target'
  const launchBindingHash = crypto.createHash('sha256').update(reservationId).digest('hex')
  const binding = { sessionId, reservationId, targetKey, launchBindingHash }
  const runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey, pollMs: 10 })
  const result = await runner.run({ sessionId, reservationId, executable: process.execPath,
    argv: ['-e', "const fs=require('node:fs');const b=Buffer.alloc(4);let n=0;while(n<4)n+=fs.readSync(0,b,n,4-n);if(b.toString()!=='ping')throw Error('foreign relay');fs.writeSync(0,'pong');console.log(JSON.stringify({duplex:true}))"],
    cwd: root, env: prepareProcessLaunchEnvironment(adapter, reservationId, process.env),
    prepareLaunch: async ({ sessionRoot }) => {
      socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\autoprompt-grok-${crypto.randomBytes(32).toString('hex')}` : path.join(sessionRoot, 'relay.sock')
      // Linux's sockaddr_un limit requires a short FD-anchored address, as in
      // the production relay. Use a shorter private test root on other POSIX hosts.
      let address = socketPath
      if (process.platform === 'linux') {
        relayDirectoryFd = fs.openSync(sessionRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
        address = `/proc/${process.pid}/fd/${relayDirectoryFd}/relay.sock`
      }
      server = net.createServer(socket => {
        sockets.add(socket); socket.on('error', () => {}); socket.on('data', bytes => { response += bytes.toString() }); socket.write('ping')
      })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve) })
      if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600)
      return { relayStdin: { socketPath: address }, launchBindingHash,
        markReservationEntered() { entered = true },
        async cleanup() {
          if (entered) {
            const receipt = await owner.issueBoundDrainReceipt(binding)
            assert.equal(owner.verifyBoundDrainReceipt(receipt, binding), true)
          }
          for (const socket of sockets) socket.destroy()
          await new Promise(resolve => server.close(resolve))
          if (relayDirectoryFd !== undefined) { fs.closeSync(relayDirectoryFd); relayDirectoryFd = undefined }
          released = true
        },
      }
    },
  })
  assert.equal(result.drained, true); assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '{"duplex":true}'); assert.equal(response, 'pong')
  assert.equal(entered, true); assert.equal(released, true)
})
