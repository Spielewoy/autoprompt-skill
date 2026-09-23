'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const test = require('node:test')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const bridge = require('../../scripts/harness-v2-bridge/pi/controller.cjs')
const { HarnessEventStream, prime072ExpectedUsage } = require('../../scripts/harness-v2-transport.cjs')
const { piModelService, piLaunch, parsePiEvents, runNative } = require('../helpers/harness-pi-native-service.cjs')

function fixture(t, provider = 'prime', policy = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-controller-v2-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dirs = Object.fromEntries(['target', 'scratch', 'private', 'cwd', 'home', 'sessions', 'outside'].map(name => [name, path.join(root, name)]))
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { mode: 0o700 })
  const marker = `marker-${provider}-${path.basename(root)}`, file = path.join(dirs.target, 'marker.txt')
  fs.writeFileSync(file, marker, { mode: 0o600 })
  const prepared = boundary.prepareBoundary({ provider, root: dirs.private, policy: {
    readOnly: true, targetPath: dirs.target, scratchPath: dirs.scratch,
    readableRoots: [dirs.target, dirs.scratch], writableRoots: [dirs.scratch],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
    ...policy,
  } })
  const env = { AUTOPROMPT_TOOL_POLICY: prepared.policyPath, AUTOPROMPT_TOOL_POLICY_SHA256: prepared.policySha256, HOME: dirs.home }
  return { root, ...dirs, marker, file, prepared, env }
}

function committed(f, response, name, args) {
  const actual = JSON.parse(response.content[0].text)
  assert.deepEqual(response.content, [{ type: 'text', text: JSON.stringify(actual) }])
  assert.deepEqual(response.details.actualResult, actual)
  const receipt = boundary.readReceipts(f.prepared).find(item => item.hash === response.details.receiptSha256)
  assert.ok(receipt, 'Receipt must already be durable when execute resolves')
  assert.equal(receipt.tool, name)
  assert.equal(receipt.policySha256, f.prepared.policySha256)
  assert.equal(receipt.argsSha256, boundary.sha256(boundary.canonicalJson(args)))
  assert.equal(receipt.resultSha256, boundary.sha256(boundary.canonicalJson(actual)))
  assert.equal(receipt.outputSha256, actual.outputSha256)
  return actual
}

test('Prime 0.7.2 cache receipt transform is checked against raw provider categories', () => {
  const receipt = value => ({ responseIdHash: crypto.createHash('sha256').update('receipt').digest('hex'),
    completionTokens: 39, reasoningTokens: 8, ...value })
  assert.deepEqual(prime072ExpectedUsage(receipt({ promptTokens: 100, cachedTokens: 0, cacheWriteTokens: 100 })),
    { input: 0, cacheRead: 0, cacheWrite: 100, output: 39, totalTokens: 139 })
  assert.deepEqual(prime072ExpectedUsage(receipt({ promptTokens: 6815, cachedTokens: 6246, cacheWriteTokens: 566 })),
    { input: 569, cacheRead: 5680, cacheWrite: 566, output: 39, totalTokens: 6854 })
})

test('Pi controller keeps trusted runtime failure codes bounded without exposing exception text', () => {
  assert.equal(bridge.failureCode({ code: 'WINDOWS_PROFILE_UNAVAILABLE', message: 'C:\\private\\secret' }), 'WINDOWS_PROFILE_UNAVAILABLE')
  assert.equal(bridge.failureCode({ code: 'EACCES' }), 'EACCES')
  assert.equal(bridge.failureCode({ code: 'bad-code' }), 'TOOL_FAILED')
  assert.equal(bridge.failureCode({ code: 'WINDOWS_PROFILE_UNAVAILABLE' }, true), 'TOOL_CANCELLED')
})

test('Prime transport binds its native receipt by hash without retaining a raw response id', () => {
  const responseId = 'prime-response-receipt-1'
  const usage = { input: 569, cacheRead: 5680, cacheWrite: 566, output: 39, reasoning: 8, totalTokens: 6854 }
  const message = { role: 'assistant', responseId, stopReason: 'stop', content: [{ type: 'text', text: '{"ok":true}' }], usage }
  const stream = new HarnessEventStream('prime')
  for (const event of [{ type: 'session', id: 'prime-receipt-session' }, { type: 'agent_start' }, { type: 'turn_start' },
    { type: 'message_end', message }, { type: 'turn_end', message }, { type: 'agent_end', messages: [message] }]) stream.push(JSON.stringify(event))
  const [receipt] = stream.finish().piProviderReceipts
  assert.deepEqual(receipt, { responseIdHash: crypto.createHash('sha256').update(responseId).digest('hex'), usage })
  assert.equal(Object.hasOwn(receipt, 'responseId'), false)
})

for (const provider of ['prime', 'omp']) {
  test(`${provider} zero-tool policy keeps native inventory empty and denies direct execution`, async t => {
    const f = fixture(t, provider, { toolFree: true }), host = apiDouble()
    host.ctx.cwd = f.cwd
    bridge.install(host.pi, provider, host.Type, f.env)
    t.after(() => host.emit('session_shutdown'))
    await host.emit('session_start')
    assert.deepEqual(host.pi.getActiveTools(), [])
    assert.equal((await host.emit('tool_call', { toolName: bridge.NAMES[0] }))[0].block, true)
    const denied = await host.registered.get(bridge.NAMES[0]).execute('id', { path: f.file })
    assert.equal(committed(f, denied, 'read', { path: f.file }).code, 'TOOL_DENIED')
    await host.pi.setActiveTools(['bash'])
    await host.emit('turn_start')
    assert.deepEqual(host.pi.getActiveTools(), [])
  })

  test(`${provider} controller uses actual bounded files and commits exact results before return (not native conformance)`, async t => {
    const f = fixture(t, provider), controller = bridge.openController(provider, f.env)
    t.after(() => controller.close())
    const run = async (name, args) => committed(f, await controller.execute(`autoprompt_owned_${name}`, args), name, args)
    const read = await run('read', { path: f.file })
    assert.equal(read.output, f.marker)
    const scratch = path.join(f.scratch, 'written.txt')
    assert.equal((await run('write', { path: scratch, content: 'before' })).status, 'completed')
    assert.equal((await run('edit', { path: scratch, oldText: 'before', newText: 'after' })).status, 'completed')
    assert.equal(fs.readFileSync(scratch, 'utf8'), 'after')
    assert.match((await run('list', { path: f.target })).output, /marker.txt/)
    assert.match((await run('search', { path: f.target, text: f.marker })).output, /marker.txt/)
    for (const file of [f.file, path.join(f.outside, 'escape.txt'), f.prepared.policyPath]) {
      assert.equal((await run('write', { path: file, content: 'forbidden' })).code, 'TOOL_PATH_DENIED')
    }
    assert.equal((await run('read', { path: f.prepared.policyPath })).code, 'TOOL_PATH_DENIED')
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.marker)
    assert.equal(fs.existsSync(path.join(f.outside, 'escape.txt')), false)
    assert.equal(boundary.readReceipts(f.prepared).length, 9)
  })
}

test('Prime REAL native CLI returns a receipt-bound no-spawn cwd denial and continues with one exact foreground retry', {
  skip: !process.env.AUTOPROMPT_PRIME_TEST_CLI ? 'BLOCKED: set AUTOPROMPT_PRIME_TEST_CLI to the official native executable; no mock is substituted' : false,
  timeout: 120000,
}, async t => {
  const f = fixture(t, 'prime')
  const deniedArgs = { command: 'printf must-not-run', cwd: path.join(f.scratch, 'missing-cwd'), timeoutMs: 3000 }
  const retryArgs = { command: 'printf exact-retry', cwd: f.scratch, timeoutMs: 3000 }
  const calls = [
    { id: 'pre-execution-denial', name: 'autoprompt_owned_bash', args: deniedArgs },
    { id: 'foreground-retry', name: 'autoprompt_owned_bash', args: retryArgs },
  ]
  const service = await piModelService(calls, { marker: f.marker })
  t.after(() => service.close())
  const launch = piLaunch({ provider: 'prime', home: f.home, cwd: f.cwd, sessions: f.sessions,
    boundary: f.prepared, url: service.url, input: 'Use each controller tool result, then return the exact JSON object.' })
  const result = await runNative(process.env.AUTOPROMPT_PRIME_TEST_CLI, launch, { timeoutMs: 90000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(result.signal, null)
  assert.equal(result.timedOut, false)
  assert.deepEqual(service.errors, [])
  const parsed = parsePiEvents(result.stdout)
  assert.deepEqual(parsed.output, { ok: true, marker: f.marker })
  const nativeTools = parsed.tools.filter(event => event.toolName === 'autoprompt_owned_bash')
  assert.equal(nativeTools.length, 2)
  const denied = committed(f, nativeTools.find(event => event.toolCallId === 'pre-execution-denial').result, 'bash', deniedArgs)
  const retry = committed(f, nativeTools.find(event => event.toolCallId === 'foreground-retry').result, 'bash', retryArgs)
  assert.equal(denied.executionState, 'NOT_STARTED')
  assert.equal(denied.exitCode, null)
  assert.equal(denied.command, deniedArgs.command)
  assert.equal(Object.hasOwn(denied, 'background'), false)
  assert.equal(retry.status, 'completed')
  assert.equal(retry.exitCode, 0)
  assert.equal(retry.background, false)
  const receipts = boundary.readReceipts(f.prepared)
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].executionState, 'NOT_STARTED')
  assert.equal(receipts[1].executionState, undefined)
  const transport = new HarnessEventStream('prime', { readOnly: true, commandBoundary: true, toolBoundary: f.prepared })
  for (const line of result.stdout.split(/\r?\n/)) if (line.trim()) transport.push(line)
  const normalized = transport.finish()
  const noSpawnEvent = normalized.events.find(event => event.type === 'item.failed' && event.item?.controllerReceiptDisposition === 'NOT_STARTED')
  assert.ok(noSpawnEvent, 'transport must expose only the receipt-authenticated no-spawn disposition')
  assert.equal(noSpawnEvent.item.command, deniedArgs.command)
  assert.equal(noSpawnEvent.item.exit_code, null)
  assert.equal(normalized.toolReceiptHashes.length, 2)
})

test('controller rejects concurrent ownership and releases the lock only after draining', async t => {
  const f = fixture(t), controller = bridge.openController('prime', f.env)
  assert.throws(() => bridge.openController('prime', f.env), { code: 'EEXIST' })
  const args = { path: path.join(f.scratch, 'queued.txt'), content: 'must not run' }
  const pending = controller.execute('autoprompt_owned_write', args)
  const closed = controller.close()
  assert.equal(fs.existsSync(path.join(f.prepared.root, 'server.lock')), true)
  const result = committed(f, await pending, 'write', args)
  assert.equal(result.code, 'TOOL_CANCELLED')
  await closed
  assert.equal(fs.existsSync(args.path), false)
  assert.equal(fs.existsSync(path.join(f.prepared.root, 'server.lock')), false)
  await assert.rejects(controller.execute('autoprompt_owned_read', { path: f.file }), { code: 'TOOL_CLOSED' })
  const reopened = bridge.openController('prime', f.env)
  await reopened.close()
})

test('queued caller cancellation cannot mutate files, and subsequent live calls still run', async t => {
  const f = fixture(t), controller = bridge.openController('prime', f.env)
  t.after(() => controller.close())
  const abort = new AbortController(), file = path.join(f.scratch, 'cancelled.txt')
  const first = controller.execute('autoprompt_owned_read', { path: f.file })
  const cancelled = controller.execute('autoprompt_owned_write', { path: file, content: 'no' }, abort.signal)
  abort.abort()
  const final = controller.execute('autoprompt_owned_read', { path: f.file })
  await first
  assert.equal((await cancelled).details.actualResult.code, 'TOOL_CANCELLED')
  assert.equal((await final).details.actualResult.output, f.marker)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(boundary.readReceipts(f.prepared).map(item => item.status), ['completed', 'failed', 'completed'])
})

test('queued arguments are snapshotted and every concurrent operation gets one chained receipt', async t => {
  const f = fixture(t), controller = bridge.openController('prime', f.env)
  t.after(() => controller.close())
  const original = { path: path.join(f.scratch, 'snapshot.txt'), content: 'original' }
  const first = controller.execute('autoprompt_owned_write', original)
  original.content = 'changed after dispatch'
  const calls = Array.from({ length: 12 }, () => controller.execute('autoprompt_owned_read', { path: f.file }))
  await Promise.all([first, ...calls])
  assert.equal(fs.readFileSync(original.path, 'utf8'), 'original')
  assert.equal(boundary.readReceipts(f.prepared).length, 13)
})

test('policy and receipt corruption fail closed before queued mutations can run', async t => {
  for (const corrupt of ['policy', 'receipt']) {
    const f = fixture(t), controller = bridge.openController('prime', f.env)
    t.after(() => controller.close())
    if (corrupt === 'policy') fs.appendFileSync(f.prepared.policyPath, ' ')
    else fs.appendFileSync(f.prepared.receiptPath, 'incomplete')
    const file = path.join(f.scratch, 'must-not-run.txt')
    const first = controller.execute('autoprompt_owned_read', { path: f.file })
    const second = controller.execute('autoprompt_owned_write', { path: file, content: 'bad' })
    const results = await Promise.allSettled([first, second])
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'TOOL_RECEIPT_INVALID'))
    assert.equal(fs.existsSync(file), false)
  }
})

test('controller rejects wrong provider, absent policy, native names, linked paths and schema expansion', async t => {
  const f = fixture(t)
  assert.throws(() => bridge.openController('omp', f.env), { code: 'TOOL_POLICY_INVALID' })
  assert.throws(() => bridge.openController('prime', {}), { code: 'TOOL_POLICY_INVALID' })
  const controller = bridge.openController('prime', f.env)
  t.after(() => controller.close())
  for (const name of ['read', 'bash', 'task', 'ipython', 'rlm', '__proto__', 'autoprompt_owned_task']) {
    await assert.rejects(controller.execute(name, {}), { code: 'TOOL_DENIED' })
  }
  const link = path.join(f.scratch, 'link')
  fs.symlinkSync(f.file, link)
  assert.equal((await controller.execute('autoprompt_owned_write', { path: link, content: 'bad' })).details.actualResult.code, 'TOOL_PATH_DENIED')
  assert.equal((await controller.execute('autoprompt_owned_read', { path: f.file, module: 'node:fs' })).details.actualResult.code, 'TOOL_ARGUMENTS_INVALID')
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.marker)
})

test('controller bash records the actual OS sandbox outcome without upgrading an unsupported backend', async t => {
  const f = fixture(t), controller = bridge.openController('prime', f.env)
  t.after(() => controller.close())
  const probe = await boundary.probeCommandSandbox()
  const args = { command: 'printf sandbox-marker', cwd: f.scratch, timeoutMs: 3000 }
  const result = committed(f, await controller.execute('autoprompt_owned_bash', args), 'bash', args)
  if (probe.supported) {
    assert.equal(result.status, 'completed')
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'sandbox-marker')
    assert.equal(result.background, false)
  } else {
    t.diagnostic(`Actual bubblewrap launch blocked: ${probe.code}: ${probe.reason}`)
    assert.equal(result.status, 'failed')
    assert.ok(result.code === 'COMMAND_SANDBOX_UNSUPPORTED' || result.exitCode !== 0)
    assert.notEqual(result.output, 'sandbox-marker')
  }
})

test('Pi controller rejects a native-private bash cwd before any foreground command starts', async t => {
  const f = fixture(t), controller = bridge.openController('prime', f.env)
  t.after(() => controller.close())
  const args = { command: 'printf must-not-run', cwd: f.cwd, timeoutMs: 3000 }
  const result = await controller.execute('autoprompt_owned_bash', args)
  const actual = committed(f, result, 'bash', args)
  assert.equal(actual.status, 'failed')
  assert.equal(actual.code, 'TOOL_PATH_DENIED')
  assert.equal(actual.executionState, 'NOT_STARTED')
  assert.equal(actual.exitCode, null)
  assert.equal(actual.command, args.command)
  assert.equal(Object.hasOwn(actual, 'background'), false)
  const [receipt] = boundary.readReceipts(f.prepared)
  assert.equal(receipt.executionState, 'NOT_STARTED')
})

// This host is explicitly an API double. Its tests exercise async activation
// ordering and fail-closed hooks; only the CLI cases below are native evidence.
function apiDouble() {
  const handlers = new Map(), registered = new Map()
  let active = ['task', 'ipython', 'bash'], aborts = 0, shutdowns = 0
  const Type = {
    String: () => ({ type: 'string' }), Boolean: () => ({ type: 'boolean' }),
    Integer: spec => ({ type: 'integer', ...spec }), Optional: spec => ({ ...spec, optional: true }),
    Object: (properties, options) => ({ type: 'object', properties, ...options }),
  }
  const pi = { on(name, callback) { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list) },
    registerTool(tool) { registered.set(tool.name, tool) },
    async setActiveTools(names) { await new Promise(resolve => setImmediate(resolve)); active = [...names] },
    getActiveTools: () => [...active] }
  const ctx = { abort: () => { aborts++ }, shutdown: () => { shutdowns++ } }
  return { pi, Type, ctx, registered, get aborts() { return aborts }, get shutdowns() { return shutdowns },
    async emit(name, event = {}) { const results = []; for (const handler of handlers.get(name) || []) results.push(await handler(event, ctx)); return results } }
}

for (const provider of ['prime', 'omp']) {
  test(`${provider} API double awaits native activation and denies builtin/recursive dispatch`, async t => {
    const f = fixture(t, provider), host = apiDouble()
    host.ctx.cwd = f.cwd
    host.ctx.sessionManager = { getSessionFile: () => path.join(f.sessions, 'history.jsonl') }
    bridge.install(host.pi, provider, host.Type, f.env)
    t.after(() => host.emit('session_shutdown'))
    assert.equal((await host.emit('tool_call', { toolName: bridge.NAMES[0] }))[0].block, true)
    await host.emit('session_start')
    assert.deepEqual(host.pi.getActiveTools(), bridge.NAMES)
    for (const name of ['read', 'write', 'edit', 'bash', 'task', 'ipython', 'rlm', 'python', 'subagent', 'tool_search']) {
      assert.equal((await host.emit('tool_call', { toolName: name }))[0].block, true)
    }
    assert.equal((await host.emit('tool_call', { toolName: bridge.NAMES[0] }))[0], undefined)
    const result = await host.registered.get(bridge.NAMES[0]).execute('id', { path: f.file })
    assert.equal(committed(f, result, 'read', { path: f.file }).output, f.marker)
    const deniedArgs = { path: f.file, content: 'no' }
    const denied = await host.registered.get('autoprompt_owned_write').execute('denied', deniedArgs)
    const corrected = (await host.emit('tool_result', { toolName: 'autoprompt_owned_write', ...denied, isError: false }))[0]
    assert.equal(corrected.isError, true, 'Prime requires the result hook to set its native error flag')
    assert.equal(committed(f, corrected, 'write', deniedArgs).code, 'TOOL_PATH_DENIED')
    await host.pi.setActiveTools(['ipython'])
    await host.emit('turn_start')
    assert.deepEqual(host.pi.getActiveTools(), bridge.NAMES)
    assert.deepEqual((await host.emit('session_before_switch'))[0], { cancel: true })
    await host.emit('session_shutdown')
    assert.equal((await host.emit('tool_call', { toolName: bridge.NAMES[0] }))[0].block, true)
  })
}

test('unsafe native history location disables all tools and shuts down the session', async t => {
  const f = fixture(t), host = apiDouble()
  host.ctx.cwd = f.target
  bridge.install(host.pi, 'prime', host.Type, f.env)
  t.after(() => host.emit('session_shutdown'))
  await assert.rejects(host.emit('session_start'), { code: 'TOOL_POLICY_INVALID' })
  assert.deepEqual(host.pi.getActiveTools(), [])
  assert.equal(host.aborts, 1)
  assert.equal(host.shutdowns, 1)
})

test('changed native result is rejected against the durable receipt and disables the session', async t => {
  const f = fixture(t), host = apiDouble()
  host.ctx.cwd = f.cwd
  bridge.install(host.pi, 'prime', host.Type, f.env)
  t.after(() => host.emit('session_shutdown'))
  await host.emit('session_start')
  const result = await host.registered.get('autoprompt_owned_read').execute('id', { path: f.file })
  result.details.actualResult.output = 'fabricated'
  await assert.rejects(host.emit('tool_result', { toolName: 'autoprompt_owned_read', ...result }), { code: 'TOOL_RECEIPT_INVALID' })
  assert.deepEqual(host.pi.getActiveTools(), [])
  assert.equal(host.shutdowns, 1)
})

test('overlapping turn notifications do not deny an already-admitted controller tool', async t => {
  const f = fixture(t, 'omp'), host = apiDouble()
  host.ctx.cwd = f.cwd
  bridge.install(host.pi, 'omp', host.Type, f.env)
  t.after(() => host.emit('session_shutdown'))
  await host.emit('session_start')
  const turns = [host.emit('turn_start'), host.emit('before_agent_start')]
  assert.equal((await host.emit('tool_call', { toolName: 'autoprompt_owned_read' }))[0], undefined)
  const args = { path: f.file }
  assert.equal(committed(f, await host.registered.get('autoprompt_owned_read').execute('overlap', args), 'read', args).output, f.marker)
  await Promise.all(turns)
  await host.emit('session_shutdown')
  await assert.rejects(host.emit('turn_start'), { code: 'TOOL_CLOSED' })
  assert.deepEqual(host.pi.getActiveTools(), [])
})

for (const provider of ['prime', 'omp']) {
  const executable = process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`]
  test(`${provider} REAL native CLI: fixed tools, actual files, durable receipts, precise usage and same-history resume`, {
    skip: !executable && !process.env.AUTOPROMPT_PI_NATIVE_REQUIRED
      ? `BLOCKED: set AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI to the official native executable; no mock is substituted` : false,
    timeout: 180000,
  }, async t => {
    assert.ok(executable, 'Required real native executable is absent')
    const f = fixture(t, provider)
    // Admission resolves npm's command symlink to its real cli.js entry point.
    // The native help identity below distinguishes these distributions; a
    // basename check rejects the exact executable admission has bound.
    const version = cp.spawnSync(executable, ['--version'], { cwd: f.cwd, env: { PATH: process.env.PATH, HOME: f.home }, encoding: 'utf8', timeout: 20000 })
    assert.equal(version.status, 0, version.stderr)
    const help = cp.spawnSync(executable, ['--help'], { cwd: f.cwd, env: { PATH: process.env.PATH, HOME: f.home }, encoding: 'utf8', timeout: 20000 })
    assert.equal(help.status, 0, help.stderr)
    assert.match(`${help.stdout}\n${help.stderr}`, provider === 'prime' ? /prime-agent/ : /omp/)
    const scratchFile = path.join(f.scratch, 'native.txt'), outsideFile = path.join(f.outside, 'native-escape.txt')
    const calls = [
      { id: 'owned-read', name: 'autoprompt_owned_read', args: { path: f.file } },
      { id: 'owned-list', name: 'autoprompt_owned_list', args: { path: f.target } },
      { id: 'owned-search', name: 'autoprompt_owned_search', args: { path: f.target, text: f.marker } },
      { id: 'owned-write', name: 'autoprompt_owned_write', args: { path: scratchFile, content: 'native-before' } },
      { id: 'owned-edit', name: 'autoprompt_owned_edit', args: { path: scratchFile, oldText: 'native-before', newText: 'native-after' } },
      { id: 'denied-candidate', name: 'autoprompt_owned_write', args: { path: f.file, content: 'bad' } },
      { id: 'denied-outside', name: 'autoprompt_owned_write', args: { path: outsideFile, content: 'bad' } },
      { id: 'denied-private', name: 'autoprompt_owned_read', args: { path: f.prepared.policyPath } },
      { id: 'denied-task', name: 'task', args: { prompt: 'write outside the assignment' } },
      { id: 'denied-ipython', name: 'ipython', args: { code: `open(${JSON.stringify(outsideFile)},'w').write('bad')` } },
      { id: 'denied-builtin', name: 'bash', args: { command: 'exit 99' } },
    ]
    fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD')
    const service = await piModelService(calls, { marker: f.marker, onRequest(_body, results) {
      const receipts = boundary.readReceipts(f.prepared)
      for (const message of results) {
        const call = calls.find(item => item.id === message.tool_call_id)
        if (!call?.name.startsWith('autoprompt_owned_')) continue
        const text = typeof message.content === 'string' ? message.content : message.content.map(item => item.text).join('')
        const result = JSON.parse(text)
        assert.ok(receipts.some(receipt => receipt.resultSha256 === boundary.sha256(boundary.canonicalJson(result)) &&
          receipt.argsSha256 === boundary.sha256(boundary.canonicalJson(call.args))), 'Native model sees only already-committed actual results')
      }
    } })
    t.after(() => service.close())
    const evidenceRoot = process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT
    const launches = []
    async function run(number, resume) {
      const launch = piLaunch({ provider, home: f.home, cwd: f.cwd, sessions: f.sessions, boundary: f.prepared,
        url: service.url, input: number === 1 ? 'FIRST_CONTEXT_SENTINEL: execute the requested tool sequence.' : 'Continue the same history.', resume })
      launches.push(launch)
      const result = await runNative(executable, launch, { timeoutMs: 70000, evidenceRoot, evidenceName: `${provider}-${number}` })
      assert.equal(result.timedOut, false, result.stderr)
      assert.equal(result.status, 0, result.stderr + result.stdout)
      assert.equal(result.signal, null)
      assert.equal(result.truncated, false)
      assert.deepEqual(service.errors, [], 'The native model requests must satisfy the fixture protocol and fixed tool surface')
      return { ...parsePiEvents(result.stdout), stdout: result.stdout }
    }
    try {
      const first = await run(1)
      assert.equal(first.output.ok, true)
      assert.ok(first.stdout.includes(f.marker))
      assert.equal(fs.readFileSync(scratchFile, 'utf8'), 'native-after')
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.marker)
      assert.equal(fs.existsSync(outsideFile), false)
      assert.equal(first.usage.noncachedInput, (calls.length + 1) * 126)
      assert.equal(first.usage.cachedInput, (calls.length + 1) * 11)
      assert.equal(first.usage.output, (calls.length + 1) * 19)
      assert.equal(boundary.readReceipts(f.prepared).length, 8)
      for (const event of first.tools.filter(event => event.toolName.startsWith('autoprompt_owned_'))) {
        const call = calls.find(item => item.id === event.toolCallId)
        assert.ok(call)
        committed(f, event.result, call.name.slice('autoprompt_owned_'.length), call.args)
      }
      assert.equal(first.tools.filter(event => event.toolName.startsWith('autoprompt_owned_')).length, 8)
      const before = service.requests.length
      const resumed = await run(2, first.sessionId)
      assert.equal(resumed.sessionId, first.sessionId)
      assert.deepEqual(resumed.usage, { noncachedInput: 126, cachedInput: 11, output: 19 })
      assert.ok(service.requests.slice(before).some(request => JSON.stringify(request.body.messages).includes('FIRST_CONTEXT_SENTINEL')))
      assert.equal(service.completed, calls.length + 2, 'Auxiliary requests must be accounted for, never ignored')
      assert.ok(service.requests.every(request => !JSON.stringify(request.body).includes('PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD')))
      assert.deepEqual(service.errors, [])
      assert.equal(fs.existsSync(path.join(f.prepared.root, 'server.lock')), false)
    } finally {
      if (evidenceRoot) {
        fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(evidenceRoot, `${provider}-native-evidence.json`), JSON.stringify({
          executable, version: version.stdout.trim(), launches, requests: service.requests, errors: service.errors,
          receipts: boundary.readReceipts(f.prepared),
        }, null, 2), { mode: 0o600 })
      }
    }
  })
}
