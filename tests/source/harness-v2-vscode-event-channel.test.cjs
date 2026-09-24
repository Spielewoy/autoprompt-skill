'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const channel = require('../../scripts/harness-v2-bridge/vscode/event-channel.cjs')

function fixture(t, onEvent = () => {}, onFailure = () => {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-events-')))
  fs.chmodSync(root, 0o700)
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\autoprompt-vscode-${'a'.repeat(64)}`
    : path.join(root, 'events.sock')
  const descriptor = channel.descriptor({ endpoint, sessionId: 'native-vscode-session', reservationId: '12345678-1234-1234-1234-123456789abc' })
  const server = channel.createServer({ descriptor, onEvent, onFailure })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { descriptor, server }
}

test('VS Code event channel synchronously acknowledges ordered events before completion', async t => {
  const events = []
  const f = fixture(t, raw => events.push(JSON.parse(raw)))
  await f.server.ready()
  const client = channel.connect(f.descriptor)
  await client.emit({ type: 'owned.session', sessionId: 'vscode-owned-12345678-1234-1234-1234-123456789abc', contextKind: 'autoprompt-extension' })
  await client.emit({ type: 'owned.result', output: { ok: true } })
  await client.complete()
  f.server.assertComplete()
  assert.deepEqual(events.map(event => event.type), ['owned.session', 'owned.result'])
})

test('VS Code completion wait resolves only after the authenticated completion acknowledgement', async t => {
  const f = fixture(t)
  await f.server.ready()
  let settled = false
  f.server.completion.then(() => { settled = true })
  const client = channel.connect(f.descriptor)
  await client.emit({ type: 'owned.result', output: { ok: true } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  await client.complete()
  await f.server.completion
  assert.equal(settled, true)
  f.server.assertComplete()
})

test('VS Code event channel round-trips a one MiB HarnessEventStream event', async t => {
  const events = []
  const f = fixture(t, raw => events.push(JSON.parse(raw)))
  await f.server.ready()
  const client = channel.connect(f.descriptor)
  const payload = 'x'.repeat(1024 * 1024)
  await client.emit({ type: 'owned.result', output: payload })
  await client.complete()
  f.server.assertComplete()
  assert.equal(events.length, 1)
  assert.equal(events[0].output.length, payload.length)
})

test('VS Code event channel refuses an event above the eight MiB raw-event ceiling and closes the client', async t => {
  const f = fixture(t)
  await f.server.ready()
  const client = channel.connect(f.descriptor)
  const oversized = { type: 'owned.result', output: 'x'.repeat(8 * 1024 * 1024 + 1) }
  await assert.rejects(client.emit(oversized), { code: 'VSCODE_EVENT_CHANNEL_INVALID' })
  await assert.rejects(client.emit({ type: 'owned.result', output: { retry: true } }), { code: 'VSCODE_EVENT_CHANNEL_INVALID' })
  assert.throws(() => f.server.assertComplete(), { code: 'VSCODE_EVENT_CHANNEL_INCOMPLETE' })
})

test('VS Code event channel rejects a bad token and fails closed without completion', async t => {
  const failures = []
  const f = fixture(t, () => {}, error => failures.push(error.code))
  await f.server.ready()
  const client = channel.connect({ ...f.descriptor, token: 'z'.repeat(43) })
  await assert.rejects(client.emit({ type: 'owned.session' }))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(failures, ['VSCODE_EVENT_CHANNEL_AUTH_FAILED'])
  assert.throws(() => f.server.assertComplete(), { code: 'VSCODE_EVENT_CHANNEL_AUTH_FAILED' })
})

test('VS Code event channel refuses invalid descriptors before a listener is created', () => {
  assert.equal(channel.endpointValid('/tmp/events.sock', 'linux'), true)
  assert.equal(channel.endpointValid('\\\\.\\pipe\\autoprompt-vscode-' + 'a'.repeat(64), 'win32'), true)
  assert.equal(channel.endpointValid('\\\\.\\pipe\\autoprompt-vscode-' + 'A'.repeat(64), 'win32'), false)
  assert.equal(channel.descriptorValid({ version: 1, endpoint: '/tmp/events.sock', token: 'a'.repeat(43), sessionId: 'x', reservationId: '12345678-1234-1234-1234-123456789abc' }, 'linux'), true)
  assert.equal(channel.descriptorValid({ version: 1, endpoint: '/tmp/events.sock', token: 'a'.repeat(42), sessionId: 'x', reservationId: '12345678-1234-1234-1234-123456789abc' }, 'linux'), false)
})

test('VS Code event channel serializes concurrent sends and rejects a later send after completion', async t => {
  const events = []
  const f = fixture(t, raw => events.push(JSON.parse(raw)))
  await f.server.ready()
  const client = channel.connect(f.descriptor)
  await Promise.all([
    client.emit({ type: 'owned.session', sessionId: 'vscode-owned-12345678-1234-1234-1234-123456789abc', contextKind: 'autoprompt-extension' }),
    client.emit({ type: 'owned.result', output: { ok: true } }),
    client.complete(),
  ])
  await assert.rejects(client.emit({ type: 'owned.error', code: 'late', message: 'late' }), { code: 'VSCODE_EVENT_CHANNEL_INCOMPLETE' })
  f.server.assertComplete()
  assert.deepEqual(events.map(event => event.type), ['owned.session', 'owned.result'])
})

test('VS Code event channel rejects a malformed acknowledgement without leaving the caller pending', async t => {
  const net = require('node:net')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-events-malformed-')))
  fs.chmodSync(root, 0o700)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\autoprompt-vscode-${'b'.repeat(64)}` : path.join(root, 'events.sock')
  const fake = net.createServer(peer => peer.once('data', () => peer.end('{not-json}\n')))
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(endpoint, resolve) })
  t.after(async () => { await new Promise(resolve => fake.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) })
  const descriptor = channel.descriptor({ endpoint, sessionId: 'native-vscode-session', reservationId: '12345678-1234-1234-1234-123456789abc' })
  await assert.rejects(channel.connect(descriptor).emit({ type: 'owned.session' }), { code: 'VSCODE_EVENT_CHANNEL_INVALID' })
})

test('VS Code event channel never unlinks a replaced POSIX socket path', { skip: process.platform === 'win32' }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-events-replaced-')))
  fs.chmodSync(root, 0o700)
  const descriptor = channel.descriptor({ endpoint: path.join(root, 'events.sock'), sessionId: 'native-vscode-session', reservationId: '12345678-1234-1234-1234-123456789abc' })
  const server = channel.createServer({ descriptor, onEvent() {} })
  await server.ready()
  fs.unlinkSync(descriptor.endpoint)
  fs.writeFileSync(descriptor.endpoint, 'foreign', { mode: 0o600 })
  await assert.rejects(server.close(), { code: 'VSCODE_EVENT_CHANNEL_INVALID' })
  assert.equal(fs.readFileSync(descriptor.endpoint, 'utf8'), 'foreign')
  fs.rmSync(root, { recursive: true, force: true })
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
})

test('VS Code event listener fails closed without removing an occupied POSIX socket', { skip: process.platform === 'win32' }, async t => {
  const net = require('node:net')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-events-occupied-')))
  fs.chmodSync(root, 0o700)
  const endpoint = path.join(root, 'events.sock')
  const occupied = net.createServer()
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(endpoint, resolve) })
  const descriptor = channel.descriptor({ endpoint, sessionId: 'native-vscode-session', reservationId: '12345678-1234-1234-1234-123456789abc' })
  const candidate = channel.createServer({ descriptor, onEvent() {} })
  await assert.rejects(candidate.ready(), { code: 'VSCODE_EVENT_CHANNEL_FAILED' })
  assert.equal(fs.lstatSync(endpoint).isSocket(), true)
  await candidate.close()
  assert.equal(fs.lstatSync(endpoint).isSocket(), true)
  await new Promise(resolve => occupied.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
})
