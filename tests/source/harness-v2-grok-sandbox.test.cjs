'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const test = require('node:test')
const { createModelProxy } = require('../../scripts/harness-v2-bridge/grok/model-proxy.cjs')
const { createWindowsRelayPath, validateRelayAddress, createUnixRelay, createUnixRelayFetch, createPreconnectedRelayClient } = require('../../scripts/harness-v2-bridge/grok/unix-relay.cjs')
const { createHostMcpRelay } = require('../../scripts/harness-v2-bridge/grok/host-mcp-relay.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { createSandboxLaunch, grokRuntime } = require('../../scripts/harness-v2-bridge/grok/sandbox-launch.cjs')
const { createRequestQuota } = require('../../scripts/harness-v2-request-quota.cjs')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')

const relayToken = () => crypto.randomBytes(32).toString('hex')
async function close(server) { await new Promise(resolve => server.close(resolve)) }
async function start(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }
}
async function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => resolve(socket)); socket.once('error', reject)
  })
}
function nativeTools() {
  return ['run_terminal_command', 'search_tool', 'use_tool'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }))
}
function sandboxToolOptions(root) {
  const toolPolicyPath = path.join(root, 'tool-policy.json'), bytes = Buffer.from('{}')
  fs.writeFileSync(toolPolicyPath, bytes, { mode: 0o600 })
  return { toolRuntimeRoot: path.resolve(__dirname, '../..'), toolPolicyPath, toolPolicySha256: crypto.createHash('sha256').update(bytes).digest('hex'), readOnlyRoots: [path.join(root, 'work')], writableRoots: [path.join(root, 'work')], allowedMcpTools: { autoprompt_owned__bash: 'bash' } }
}
function ownedSse() {
  const event = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'owned-1', type: 'function', function: { name: 'use_tool', arguments: JSON.stringify({ tool_name: 'autoprompt_owned__bash', tool_input: { command: 'pwd' } }) } }] } }] }
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`
}

test('Grok relay derives only collision-resistant authenticated Windows pipe names', () => {
  const address = createWindowsRelayPath(length => Buffer.alloc(length, 0x5a))
  assert.equal(address, `\\\\.\\pipe\\autoprompt-grok-${'5a'.repeat(32)}`)
  assert.equal(validateRelayAddress(address, 'win32'), address)
  for (const rejected of ['C:\\controller\\relay.sock', '\\\\.\\pipe\\foreign', `\\\\.\\pipe\\autoprompt-grok-${'a'.repeat(63)}`, `\\\\.\\pipe\\autoprompt-grok-${'A'.repeat(64)}`]) {
    assert.throws(() => validateRelayAddress(rejected, 'win32'), { code: 'GROK_RELAY_CONFIG_INVALID' })
  }
  assert.equal(validateRelayAddress('/private/controller/relay.sock', 'linux'), '/private/controller/relay.sock')
})

test('Grok relay preserves authenticated framing over a native Windows named pipe', { skip: process.platform !== 'win32' }, async t => {
  const token = relayToken(), socketPath = createWindowsRelayPath()
  const relay = createUnixRelay({ socketPath, relayToken: token, upstreamUrl: 'http://unused.invalid', upstreamAuthorization: 'Bearer fixture',
    fetchImpl: async () => new Response('windows-pipe-response', { status: 200, headers: { 'content-type': 'text/plain' } }) })
  t.after(() => relay.close())
  assert.equal(await relay.listen(), socketPath)
  const request = createUnixRelayFetch({ socketPath, relayToken: token })
  assert.equal(await (await request('relay://controller', { method: 'POST', headers: {}, body: '{}' })).text(), 'windows-pipe-response')
  await assert.rejects(createUnixRelayFetch({ socketPath, relayToken: relayToken() })('relay://controller', { method: 'POST', headers: {}, body: '{}' }), { code: 'GROK_RELAY_AUTH_DENIED' })
})

// The host relay is the only component that accepts the provider credential. The
// sandbox-visible proxy only receives the relay capability token.
test('Grok relay keeps the provider credential at the host boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-relay-test-'))
  const socketPath = path.join(root, 'relay.sock'), token = relayToken()
  const seen = []
  const upstream = await start(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    seen.push({ authorization: req.headers.authorization, childHeader: req.headers['x-child-only'], body: JSON.parse(raw) })
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(ownedSse())
  })
  const relay = createUnixRelay({ socketPath, relayToken: token, upstreamUrl: upstream.url, upstreamAuthorization: 'Bearer host-provider-secret' })
  await relay.listen()
  const proxy = createModelProxy({
    upstreamUrl: 'relay://controller/v1/chat/completions', childToken: 'sandbox-only', upstreamAuthorization: `Bearer ${token}`,
    fetchImpl: createUnixRelayFetch({ socketPath, relayToken: token }), allowedMcpTools: { autoprompt_owned__bash: () => {} },
  })
  const address = await proxy.listen()
  const reply = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sandbox-only', 'x-child-only': 'must-not-reach-upstream' },
    body: JSON.stringify({ model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: nativeTools() }),
  })
  const replyBody = await reply.text()
  assert.equal(reply.status, 200, replyBody)
  assert.match(replyBody, /autoprompt_owned__bash/)
  assert.deepEqual(seen, [{ authorization: 'Bearer host-provider-secret', childHeader: undefined, body: seen[0].body }])
  assert.deepEqual(seen[0].body.tools.map(entry => entry.function.name), ['search_tool', 'use_tool'])
  const rejectedFetch = createUnixRelayFetch({ socketPath, relayToken: relayToken() })
  await assert.rejects(
    rejectedFetch('relay://controller/v1/chat/completions', { method: 'POST', body: '{}', headers: {} }),
    error => error.code === 'GROK_RELAY_AUTH_DENIED',
  )
  assert.equal(seen.length, 1, 'a rejected relay credential must not reach the upstream')
  await proxy.close(); await relay.close(); await close(upstream.server)
  fs.rmSync(root, { recursive: true, force: true })
})

test('Grok relay blocks retries before upstream fetch after controller budget rejection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-relay-budget-'))
  const token = relayToken(); let requests = 0, failure
  const upstream = await start((req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n')
  })
  const relay = createUnixRelay({ socketPath: path.join(root, 'relay.sock'), relayToken: token,
    upstreamUrl: upstream.url, upstreamAuthorization: 'Bearer local-test-only',
    beforeModelRequest() { if (failure) throw failure },
    onModelResponse() { failure = Object.assign(new Error('known usage exhausts budget'), { code: 'BUDGET_EXHAUSTED' }); throw failure },
  })
  t.after(async () => { await relay.close(); await close(upstream.server); fs.rmSync(root, { recursive: true, force: true }) })
  const socketPath = await relay.listen(), request = createUnixRelayFetch({ socketPath, relayToken: token })
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(request('relay://controller/v1/chat/completions', { method: 'POST', body: '{}', headers: {} }), { code: 'BUDGET_EXHAUSTED' })
  }
  assert.equal(requests, 1, 'a refused retry must not start another paid request')
})

test('Grok relay binds the exact follow-up request before upstream admission', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-relay-follow-up-'))
  const token = relayToken(); let requests = 0; const admissions = []
  const upstream = await start((req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n')
  })
  const relay = createUnixRelay({ socketPath: path.join(root, 'relay.sock'), relayToken: token,
    upstreamUrl: upstream.url, upstreamAuthorization: 'Bearer local-test-only',
    beforeModelRequest(admission) {
      admissions.push(admission)
      assert.equal(Object.isFrozen(admission), true)
      assert.equal(typeof admission.request, 'string')
      if (admissions.length > 1) throw Object.assign(new Error('follow-up exceeds the live envelope'), { code: 'CHILD_TOKEN_LIMIT_EXHAUSTED' })
    },
  })
  t.after(async () => { await relay.close(); await close(upstream.server); fs.rmSync(root, { recursive: true, force: true }) })
  const socketPath = await relay.listen(), request = createUnixRelayFetch({ socketPath, relayToken: token })
  await request('relay://controller/v1/chat/completions', { method: 'POST', body: '{"first":true}', headers: {} })
  const followUp = JSON.stringify({ followUp: 'x'.repeat(1024) })
  await assert.rejects(request('relay://controller/v1/chat/completions', { method: 'POST', body: followUp, headers: {} }), { code: 'CHILD_TOKEN_LIMIT_EXHAUSTED' })
  assert.equal(requests, 1, 'the denied follow-up never reaches the upstream provider')
  assert.deepEqual(admissions.map(value => value.request), ['{"first":true}', followUp])
})

test('Grok relay denies an unaffordable first request before upstream and latches unknown spend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-relay-durable-quota-'))
  const token = relayToken(); let upstreamCalls = 0
  const starts = [], unknown = []
  const record = {
    providerTokenLimit: 1000,
    onUsageDelta() {},
    onProviderRequestStarted: evidence => starts.push(evidence),
    onProviderRequestSettled() {},
    onUnknownProviderSpend: evidence => unknown.push(evidence),
  }
  const quota = createRequestQuota({ record, protocol: 'grok-chat-completions', maxOutputField: 'max_tokens' })
  const upstream = await start(async (req, res) => {
    upstreamCalls++
    let raw = ''; for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw)
    assert.ok(request.max_tokens > 0 && request.max_tokens < 900, 'controller admission must cap the outbound output')
    // An admitted non-success has no exact usage receipt and therefore must
    // take the same conservative unknown-spend path as a broken stream.
    res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":"limited"}')
  })
  const relay = createUnixRelay({ socketPath: path.join(root, 'relay.sock'), relayToken: token,
    upstreamUrl: upstream.url, upstreamAuthorization: 'Bearer local-test-only',
    beforeModelRequest: ({ request }) => quota.admit({ rawBody: request, body: JSON.parse(request), cumulative: { noncachedInput: 0, cachedInput: 0, output: 0 } }),
    onModelResponse: response => { assert.equal(response.status, 429); throw Object.assign(new Error('no accountable upstream receipt'), { code: 'PROVIDER_USAGE_UNKNOWN' }) },
    onModelRequestFailed: ({ error }) => quota.unknown(error),
  })
  t.after(async () => { await relay.close(); await close(upstream.server); fs.rmSync(root, { recursive: true, force: true }) })
  const socketPath = await relay.listen(), request = createUnixRelayFetch({ socketPath, relayToken: token })
  const unaffordable = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }], max_tokens: 1 })
  record.providerTokenLimit = 20
  await assert.rejects(request('relay://controller/v1/chat/completions', { method: 'POST', body: unaffordable, headers: {} }), { code: 'CHILD_TOKEN_LIMIT_EXHAUSTED' })
  assert.equal(upstreamCalls, 0, 'an unaffordable first request must never reach the provider')
  assert.equal(starts.length, 0)
  record.providerTokenLimit = 1000
  const admitted = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }], max_tokens: 900 })
  await assert.rejects(request('relay://controller/v1/chat/completions', { method: 'POST', body: admitted, headers: {} }))
  assert.equal(upstreamCalls, 1)
  assert.equal(starts.length, 1)
  assert.equal(unknown.length, 1)
  await assert.rejects(request('relay://controller/v1/chat/completions', { method: 'POST', body: admitted, headers: {} }), { code: 'CHILD_TOKEN_LIMIT_EXHAUSTED' })
  assert.equal(upstreamCalls, 1, 'unknown provider spend must close the relay quota permanently')
})

test('preconnected Grok relay fetch honors abort signals without reusing an ordered response channel', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-relay-abort-'))
  const token = relayToken(); let upstreamCalls = 0, upstreamAborted = false
  const relay = createUnixRelay({ socketPath: path.join(root, 'relay.sock'), relayToken: token,
    upstreamUrl: 'http://unused.invalid/v1/chat/completions', upstreamAuthorization: 'Bearer local-test-only',
    fetchImpl: async (_url, init) => {
      upstreamCalls++
      return await new Promise((resolve, reject) => {
        const abort = () => { upstreamAborted = true; reject(Object.assign(new Error('upstream aborted'), { name: 'AbortError' })) }
        if (init.signal.aborted) return abort()
        init.signal.addEventListener('abort', abort, { once: true })
      })
    },
  })
  t.after(async () => { await relay.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const socketPath = await relay.listen(), socket = await connect(socketPath)
  const client = createPreconnectedRelayClient({ socket, relayToken: token })
  const beforeSend = new AbortController(); beforeSend.abort()
  await assert.rejects(client.fetch('relay://controller/v1/chat/completions', { method: 'POST', body: '{}', signal: beforeSend.signal }), { code: 'GROK_RELAY_ABORTED' })
  assert.equal(upstreamCalls, 0, 'an already-aborted fetch must not write a relay frame')
  const inflight = new AbortController()
  const pending = client.fetch('relay://controller/v1/chat/completions', { method: 'POST', body: '{}', signal: inflight.signal })
  for (let count = 0; count < 100 && upstreamCalls !== 1; count += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(upstreamCalls, 1, 'the admitted request must reach the host relay once')
  // This second frame is intentionally queued on the same ordered socket
  // while the first request is in flight. Closing the first must not allow
  // the server chain to begin an upstream call for the queued frame.
  const queued = client.fetch('relay://controller/v1/chat/completions', { method: 'POST', body: '{"queued":true}' })
  inflight.abort()
  await assert.rejects(pending, { code: 'GROK_RELAY_ABORTED' })
  await assert.rejects(queued, { code: 'GROK_RELAY_ABORTED' })
  for (let count = 0; count < 100 && !upstreamAborted; count += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(upstreamAborted, true, 'closing the ordered client channel must abort the host upstream request')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(upstreamCalls, 1, 'a frame queued before disconnect must not start a second upstream request')
  await assert.rejects(client.fetch('relay://controller/v1/chat/completions', { method: 'POST', body: '{}' }), { code: 'GROK_RELAY_ABORTED' })
})

test('preconnected host relay FD remains usable after bwrap removes network access', { skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/bwrap') }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-relay-bwrap-test-'))
  const socketPath = path.join(root, 'relay.sock'), token = relayToken()
  const upstream = await start((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'))
  const relay = createUnixRelay({ socketPath, relayToken: token, upstreamUrl: upstream.url, upstreamAuthorization: 'Bearer host-provider-secret' })
  await relay.listen()
  const connected = await connect(socketPath)
  const relayModule = path.resolve(__dirname, '../../scripts/harness-v2-bridge/grok/unix-relay.cjs')
  const program = `const {createPreconnectedRelayFetch}=require(${JSON.stringify(relayModule)});createPreconnectedRelayFetch({fd:0,relayToken:${JSON.stringify(token)}})('relay://controller/v1/chat/completions',{method:'POST',headers:{},body:'{}'}).then(async r=>{process.stdout.write(String(r.status)+':'+await r.text());process.exit(0)},e=>{process.stderr.write(e.stack||String(e));process.exit(1)})`
  const child = childProcess.spawn('/usr/bin/bwrap', ['--die-with-parent', '--unshare-net', '--new-session', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--clearenv', '--', process.execPath, '-e', program], { stdio: [connected, 'pipe', 'pipe'], shell: false })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('bwrap relay proof timed out')) }, 15000)
    child.once('error', reject)
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }) })
  })
  assert.deepEqual(status, { code: 0, signal: null }, stderr)
  assert.equal(stdout, '200:data: [DONE]\n\n')
  connected.destroy(); await relay.close(); await close(upstream.server)
  fs.rmSync(root, { recursive: true, force: true })
})

test('Grok sandbox maps a verified raw executable inside the namespace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-raw-runtime-')), executable = path.join(root, 'grok')
  try {
    fs.writeFileSync(executable, '#!/bin/false\n', { mode: 0o700 })
    assert.deepEqual(grokRuntime(executable), { executable: '/opt/grok/grok', mounts: [[fs.realpathSync.native(executable), '/opt/grok/grok']] })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Grok sandbox preserves the official npm wrapper and platform payload layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-wrapper-runtime-'))
  const modules = path.join(root, 'node_modules'), scope = path.join(modules, '@xai-official')
  const wrapper = path.join(scope, 'grok'), platform = path.join(scope, `grok-${process.platform}-${process.arch}`)
  try {
    fs.mkdirSync(path.join(wrapper, 'bin'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(platform, 'bin'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(wrapper, 'package.json'), JSON.stringify({ name: '@xai-official/grok', version: '1.0.13', bin: { grok: 'bin/grok' } }), { mode: 0o600 })
    fs.writeFileSync(path.join(platform, 'package.json'), JSON.stringify({ name: `@xai-official/grok-${process.platform}-${process.arch}`, version: '1.0.13' }), { mode: 0o600 })
    fs.writeFileSync(path.join(wrapper, 'bin', 'grok'), '#!/usr/bin/env node\n', { mode: 0o700 })
    fs.writeFileSync(path.join(platform, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'), 'native', { mode: 0o700 })
    const runtime = grokRuntime(path.join(wrapper, 'bin', 'grok'))
    assert.equal(runtime.executable, '/opt/autoprompt-grok-node/node_modules/@xai-official/grok/bin/grok')
    assert.deepEqual(runtime.mounts, [[fs.realpathSync.native(wrapper), '/opt/autoprompt-grok-node/node_modules/@xai-official/grok'], [fs.realpathSync.native(platform), `/opt/autoprompt-grok-node/node_modules/@xai-official/grok-${process.platform}-${process.arch}`]])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Grok sandbox launch requires bwrap network isolation and passes only a preconnected relay stream', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-launch-test-')), grok = path.join(root, 'grok')
  fs.mkdirSync(path.join(root, 'work')); fs.mkdirSync(path.join(root, 'home')); fs.writeFileSync(grok, '#!/bin/false\n', { mode: 0o700 })
  const stdin = new PassThrough()
  const spec = createSandboxLaunch({
    root, sessionHome: path.join(root, 'home'), grokExecutable: grok, nodeExecutable: process.execPath, model: 'local', proxyToken: 'proxy', relayToken: relayToken(), cwd: path.join(root, 'work'), relayStdin: stdin,
    ...sandboxToolOptions(root),
  })
  assert.equal(spec.executable, '/usr/bin/bwrap'); assert.equal(spec.stdin, stdin)
  assert.ok(spec.argv.includes('--unshare-net')); assert.ok(spec.argv.includes('--clearenv')); assert.ok(spec.argv.includes('--die-with-parent'))
  assert.equal(spec.argv.includes('--new-session'), false, 'ProcessOwner must retain its POSIX group across bwrap')
  assert.equal(spec.argv.includes('Bearer host-provider-secret'), false)
  assert.equal(spec.argv.includes('--share-net'), false); assert.match(spec.argv.join('\u0000'), /AUTOPROMPT_GROK_RELAY_FD\u00000/)
  stdin.destroy(); fs.rmSync(root, { recursive: true, force: true })
})


test('ProcessOwner cancels the complete bwrap-owned Grok process group', { skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/bwrap') }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-owner-test-')), grok = path.join(root, 'grok')
  for (const part of ['work', 'home', 'home/config', 'home/data', 'home/state', 'home/cache']) fs.mkdirSync(path.join(root, part), { recursive: true, mode: 0o700 })
  fs.writeFileSync(grok, '#!/bin/sh\nsleep 60\n', { mode: 0o700 })
  const token = relayToken(), socketPath = path.join(root, 'relay.sock')
  const upstream = await start((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'))
  const relay = createUnixRelay({ socketPath, relayToken: token, upstreamUrl: upstream.url, upstreamAuthorization: 'Bearer host-provider-secret' })
  await relay.listen(); const connected = await connect(socketPath)
  const adapter = createPosixProcessAdapter(), owner = new ProcessOwner({ adapter, registryPath: path.join(root, 'processes.json'), pollMs: 10, startupTimeoutMs: 5000 })
  let launched
  try {
    const reservationId = 'grok-cancellation-proof'
    const launch = createSandboxLaunch({
      root, sessionHome: path.join(root, 'home'), grokExecutable: grok, nodeExecutable: process.execPath, model: 'local', proxyToken: 'proxy', relayToken: token,
      cwd: path.join(root, 'work'), relayStdin: connected, ...sandboxToolOptions(root),
    })
    const spec = { ...launch, targetKey: 'grok-cancel', sessionId: 'grok-cancel-session', reservationId, env: prepareProcessLaunchEnvironment(adapter, reservationId, launch.env) }
    launched = await owner.launch(spec)
    await new Promise(resolve => setTimeout(resolve, 100))
    const live = await adapter.listOwned(launched.groupIdentity)
    assert.ok(live.length >= 2, `expected bwrap and its native descendant in ${launched.groupIdentity}`)
    const terminal = await owner.cancelGroup(launched.ownershipId, { reason: 'conformance cancellation', graceMs: 100, killMs: 2000 })
    assert.equal(terminal.status, 'CANCELLED')
    assert.deepEqual(await adapter.listOwned(launched.groupIdentity), [])
  } finally {
    if (launched) await owner.cancelGroup(launched.ownershipId, { reason: 'test cleanup', graceMs: 0, killMs: 100 }).catch(() => {})
    connected.destroy(); await relay.close().catch(() => {}); await close(upstream.server).catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})


test('host-owned MCP relay uses the existing tool server and commits a receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-host-mcp-test-')), task = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-host-mcp-task-'))
  fs.writeFileSync(path.join(task, 'input.txt'), 'owned receipt proof\n')
  const prepared = boundary.prepareBoundary({ provider: 'hermes', root, policy: { activationId: 'a', sessionId: 's', reservationId: 'r', readOnly: true, targetPath: task, scratchPath: null, readableRoots: [task], writableRoots: [], nestedDispatch: false, commandBoundary: true, externalWrites: false } })
  const hostMcp = createHostMcpRelay({ boundary: prepared }), token = relayToken(), socketPath = path.join(root, 'relay.sock')
  const upstream = await start((req, res) => res.writeHead(200).end())
  const relay = createUnixRelay({ socketPath, relayToken: token, upstreamUrl: upstream.url, upstreamAuthorization: 'Bearer host-only', mcpHandler: request => hostMcp.handle(request) })
  await relay.listen(); const socket = await connect(socketPath), client = createPreconnectedRelayClient({ socket, relayToken: token })
  try {
    const initialize = await client.mcp({ line: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) })
    assert.match(initialize.line, /autoprompt-owned-tools/)
    await client.mcp({ line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    const called = await client.mcp({ line: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { path: path.join(task, 'input.txt') } } }) })
    assert.match(called.line, /autoprompt\/receipt/)
    assert.equal(boundary.readReceipts(prepared).length, 1)
  } finally { socket.destroy(); await hostMcp.close(); await relay.close(); await close(upstream.server); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(task, { recursive: true, force: true }) }
})

test('Grok private native projection excludes task roots while retaining its reservation-local cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-private-projection-test-')), grok = path.join(root, 'grok')
  const task = path.join(root, 'task'), nativeCwd = path.join(root, 'native-cwd')
  for (const directory of [task, nativeCwd, path.join(root, 'home')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(task, 'AGENTS.md'), 'must never be visible to Grok', { mode: 0o600 })
  fs.writeFileSync(grok, '#!/bin/false\n', { mode: 0o700 })
  const stdin = new PassThrough()
  try {
    const spec = createSandboxLaunch({
      root, sessionHome: path.join(root, 'home'), grokExecutable: grok, nodeExecutable: process.execPath, model: 'local', proxyToken: 'proxy', relayToken: relayToken(), cwd: nativeCwd, relayStdin: stdin,
      ...sandboxToolOptions(root), nativeReadOnlyRoots: [nativeCwd], nativeWritableRoots: [nativeCwd],
    })
    assert.ok(spec.argv.includes(nativeCwd)); assert.equal(spec.argv.includes(task), false)
    assert.equal(spec.argv.includes(path.join(task, 'AGENTS.md')), false)
  } finally { stdin.destroy(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('Grok relay serves deep installed paths through a private directory descriptor', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-relay-deep-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'nested-install-'.repeat(12))
  fs.mkdirSync(directory, { mode: 0o700 })
  const socketPath = path.join(directory, 'relay.sock'), token = relayToken()
  const relay = createUnixRelay({ socketPath, relayToken: token, upstreamUrl: 'http://unused.invalid', upstreamAuthorization: 'Bearer fixture',
    fetchImpl: async () => new Response('actual relay response') })
  t.after(() => relay.close())
  const address = await relay.listen()
  assert.ok(Buffer.byteLength(address) < 104)
  assert.ok(fs.lstatSync(socketPath).isSocket())
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600)
  const request = createUnixRelayFetch({ socketPath: address, relayToken: token })
  assert.equal(await (await request('relay://controller', { method: 'POST', headers: {}, body: '{}' })).text(), 'actual relay response')
  await assert.rejects(createUnixRelayFetch({ socketPath: address, relayToken: relayToken() })('relay://controller', { method: 'POST', headers: {}, body: '{}' }), { code: 'GROK_RELAY_AUTH_DENIED' })
  await relay.close()
  assert.equal(fs.existsSync(socketPath), false)
  fs.writeFileSync(socketPath, 'foreign')
  const collision = createUnixRelay({ socketPath, relayToken: token, upstreamUrl: 'http://unused.invalid', upstreamAuthorization: 'Bearer fixture' })
  await assert.rejects(collision.listen(), { code: 'GROK_RELAY_SOCKET_EXISTS' })
  await collision.close()
  assert.equal(fs.readFileSync(socketPath, 'utf8'), 'foreign')
})


test('Grok relay close preserves a replacement file at either short or deep socket paths', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-replacement-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of ['short', 'deep-'.repeat(30)]) {
    const directory = path.join(root, name)
    fs.mkdirSync(directory, { mode: 0o700 })
    const socketPath = path.join(directory, 'relay.sock')
    const relay = createUnixRelay({ socketPath, relayToken: relayToken(), upstreamUrl: 'http://unused.invalid', upstreamAuthorization: 'Bearer fixture' })
    await relay.listen()
    fs.unlinkSync(socketPath)
    fs.writeFileSync(socketPath, 'foreign replacement')
    await relay.close()
    assert.equal(fs.readFileSync(socketPath, 'utf8'), 'foreign replacement')
  }
})
