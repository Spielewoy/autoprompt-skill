'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const controlled = require('../../scripts/harness-v2-controlled-tools.cjs')
const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
const { modelService, runNative } = require('../helpers/harness-native-service.cjs')

function fixture(t, provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-controlled-native-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dirs = Object.fromEntries(['target', 'scratch', 'controller', 'empty', 'session'].map(name => [name, path.join(root, name)]))
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { mode: 0o700 })
  const policy = { provider, readOnly: true, targetPath: dirs.target, scratchPath: dirs.scratch,
    readableRoots: [dirs.target, dirs.scratch], writableRoots: [dirs.scratch], nestedDispatch: false,
    commandBoundary: true, externalWrites: false }
  return { root, ...dirs, boundary: boundary.prepareBoundary({ provider, root: dirs.controller, policy }) }
}

test('controlled native names never accept built-ins, foreign servers or prefix collisions', () => {
  for (const provider of controlled.PROVIDERS) {
    for (const tool of boundary.TOOLS) assert.equal(controlled.decodeToolName(provider, controlled.toolName(provider, tool.name)), tool.name)
    for (const name of ['read', 'Bash', 'Task', 'Agent', 'mcp__foreign__read', 'autoprompt_owned_read_extra']) {
      assert.equal(controlled.decodeToolName(provider, name), null)
    }
  }
})

test('OpenCode-family MCP deadlines cover permitted commands and bounded sandbox preparation', t => {
  const maximumCommandMs = boundary.TOOLS.find(tool => tool.name === 'bash').inputSchema.properties.timeoutMs.maximum
  for (const provider of ['opencode', 'kilo']) {
    const f = fixture(t, provider)
    const projection = controlled.opencodeProjection(f.boundary, provider)
    const server = projection.mcp[controlled.SERVER]
    assert.ok(Number.isSafeInteger(server.timeout) && server.timeout > maximumCommandMs)
    assert.ok(server.timeout <= 600_000, 'MCP waits must remain bounded')
    assert.equal(server.type, 'local')
    assert.equal(server.command[0], process.execPath)
    assert.equal(projection.permission['*'], 'deny')
  }
})

test('receipt verifier rejects model-written success, changed results, omitted executions and replay', async t => {
  const f = fixture(t, 'claude'), args = { path: f.target }
  const result = await boundary.executeTool(f.boundary.policy, 'list', args)
  const name = controlled.toolName('claude', 'list'), serialized = JSON.stringify(result)
  const verifier = new controlled.ReceiptVerifier('claude', f.boundary)
  assert.throws(() => verifier.verify(name, args, serialized, false), { code: 'TOOL_RECEIPT_INVALID' })
  boundary.appendReceipt(f.boundary, 'list', args, result, new Date().toISOString())
  assert.throws(() => verifier.finish(), { code: 'TOOL_RECEIPT_INVALID' })
  assert.throws(() => verifier.verify('Read', args, serialized, false), { code: 'ROLE_POLICY_DENIED' })
  assert.throws(() => verifier.verify(name, { path: f.scratch }, serialized, false), { code: 'TOOL_RECEIPT_INVALID' })
  assert.throws(() => verifier.verify(name, args, JSON.stringify({ ...result, output: 'forged' }), false), { code: 'TOOL_OUTPUT_INCOMPLETE' })
  verifier.verify(name, args, serialized, false)
  assert.equal(verifier.finish().length, 1)
  assert.throws(() => verifier.verify(name, args, serialized, false), { code: 'TOOL_RECEIPT_INVALID' })
})

test('receipt verifier admits only a journal-bound pre-spawn bash cwd refusal, then accepts an exact retry', async t => {
  const f = fixture(t, 'prime')
  const deniedArgs = { command: 'printf must-not-run', cwd: path.join(f.scratch, 'missing-cwd') }
  await assert.rejects(boundary.executeTool(f.boundary.policy, 'bash', { command: '', cwd: deniedArgs.cwd }), { code: 'TOOL_ARGUMENTS_INVALID' })
  const denied = await boundary.executeTool(f.boundary.policy, 'bash', deniedArgs)
  assert.deepEqual(Object.keys(denied).sort(), ['code', 'command', 'executionState', 'exitCode', 'output', 'outputSha256', 'status', 'tool'])
  assert.equal(denied.executionState, 'NOT_STARTED')
  assert.equal(denied.code, 'TOOL_PATH_INVALID')
  const receipt = boundary.appendReceipt(f.boundary, 'bash', deniedArgs, denied, new Date().toISOString())
  assert.equal(receipt.executionState, 'NOT_STARTED')
  const verifier = new controlled.ReceiptVerifier('prime', f.boundary)
  const name = controlled.toolName('prime', 'bash')
  const serialized = JSON.stringify(denied)
  assert.throws(() => verifier.verify(name, deniedArgs, JSON.stringify({ ...denied, executionState: undefined }), true), { code: 'TOOL_OUTPUT_INCOMPLETE' })
  assert.throws(() => verifier.verify(name, deniedArgs, JSON.stringify({ ...denied, background: false }), true), { code: 'TOOL_OUTPUT_INCOMPLETE' })
  assert.throws(() => verifier.verify(name, deniedArgs, JSON.stringify({ ...denied, signal: 'SIGTERM' }), true), { code: 'TOOL_OUTPUT_INCOMPLETE' })
  assert.throws(() => verifier.verify(name, deniedArgs, JSON.stringify({ ...denied, code: 'TOOL_CANCELLED' }), true), { code: 'TOOL_OUTPUT_INCOMPLETE' })
  assert.equal(verifier.verify(name, deniedArgs, serialized, true).executionState, 'NOT_STARTED')

  const sandbox = await boundary.probeCommandSandbox()
  if (!sandbox.supported) {
    t.diagnostic(`No exact retry on unsupported sandbox: ${sandbox.code || sandbox.backend}`)
    assert.equal(verifier.finish().length, 1)
    return
  }
  const retryArgs = { command: 'printf exact-retry', cwd: f.scratch, timeoutMs: 3000 }
  const retry = await boundary.executeTool(f.boundary.policy, 'bash', retryArgs)
  assert.equal(retry.status, 'completed')
  assert.equal(retry.exitCode, 0)
  boundary.appendReceipt(f.boundary, 'bash', retryArgs, retry, new Date().toISOString())
  assert.equal(verifier.verify(name, retryArgs, JSON.stringify(retry), false).exitCode, 0)
  assert.equal(verifier.finish().length, 2)
})

test('receipt-authenticated no-spawn bash is emitted as a typed failed lifecycle, not foreground output', async t => {
  const f = fixture(t, 'prime'), args = { command: 'printf must-not-run', cwd: path.join(f.scratch, 'missing-cwd') }
  const denied = await boundary.executeTool(f.boundary.policy, 'bash', args)
  boundary.appendReceipt(f.boundary, 'bash', args, denied, new Date().toISOString())
  const stream = new HarnessEventStream('prime', { commandBoundary: true, toolBoundary: f.boundary })
  const events = []; stream.emit = event => events.push(event)
  stream.startTool('no-spawn', controlled.toolName('prime', 'bash'), args)
  stream.finishTool('no-spawn', JSON.stringify(denied), { error: true })
  assert.deepEqual(events.map(event => event.type), ['item.started', 'item.failed'])
  const terminal = events.at(-1).item
  assert.equal(terminal.type, 'command_execution')
  assert.equal(terminal.command, args.command)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.exit_code, null)
  assert.equal(terminal.preExecutionDenied, true)
  assert.equal(terminal.controllerReceiptDisposition, 'NOT_STARTED')
  assert.equal(Object.hasOwn(terminal, 'aggregated_output'), true)
})

test('an actually started timed-out bash remains incomplete even with a matching receipt', async t => {
  const sandbox = await boundary.probeCommandSandbox()
  if (!sandbox.supported) return t.diagnostic(`No started-command timeout on unsupported sandbox: ${sandbox.code || sandbox.backend}`)
  const f = fixture(t, 'prime'), args = { command: 'sleep 1', cwd: f.scratch, timeoutMs: 20 }
  const result = await boundary.executeTool(f.boundary.policy, 'bash', args)
  assert.equal(result.executionState, undefined)
  assert.equal(result.timedOut, true)
  boundary.appendReceipt(f.boundary, 'bash', args, result, new Date().toISOString())
  const verifier = new controlled.ReceiptVerifier('prime', f.boundary)
  assert.throws(() => verifier.verify(controlled.toolName('prime', 'bash'), args, JSON.stringify(result), true), { code: 'TOOL_OUTPUT_INCOMPLETE' })
})

// Reasonix has its own native configuration and production-adapter suite.
for (const provider of ['claude', 'opencode', 'kilo']) {
  test(`${provider}: real native MCP executes an isolated checker command with private receipts`, {
    skip: !process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`], timeout: 150000,
  }, async t => {
    const sandbox = await boundary.probeCommandSandbox()
    assert.equal(sandbox.supported, true, JSON.stringify(sandbox))
    const executable = native.probeExecutable({ provider, executable: process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`] })
    const f = fixture(t, provider), candidate = path.join(f.target, 'candidate.txt'), scratch = path.join(f.scratch, 'checked.txt')
    const marker = `${provider}-actual-controlled-command`
    fs.writeFileSync(candidate, marker)
    fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'FOREIGN_PROJECT_INSTRUCTIONS_MUST_NOT_LOAD')
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`
    const command = `cat ${quote(candidate)}; printf checked > ${quote(scratch)}; if printf wrong > ${quote(candidate)} 2>/dev/null; then exit 19; fi`
    const name = controlled.toolName(provider, 'bash')
    const service = await modelService(provider, { name, args: { command } })
    try {
      const connection = provider === 'claude'
        ? { model: 'claude-sonnet-4-6', environment: { ANTHROPIC_BASE_URL: service.url } }
        : { model: 'fixture/model', providers: { fixture: { npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `${service.url}/v1`, apiKey: 'fixture-not-a-secret' },
          models: { model: { name: 'Fixture Model', limit: { context: 32768, output: 2048 } } } } } }
      const launch = native.createLaunch({ provider, home: path.join(f.root, 'launch'), sessionRoot: f.session,
        targetPath: f.target, cwd: f.empty, prompt: 'Use only the controller-owned tools. Return one JSON object.',
        input: 'Run the assigned checker command and return {"ok":true}.', connection,
        credentials: { ANTHROPIC_API_KEY: 'fixture-not-a-secret' }, environment: { PATH: process.env.PATH },
        readOnly: true, commandBoundary: true, toolBoundary: f.boundary })
      const completed = await runNative(executable.path, launch, { timeoutMs: 90000,
        evidenceRoot: process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT, evidenceName: `${provider}-controlled` })
      assert.equal(completed.status, 0, completed.stderr + completed.stdout)
      assert.equal(completed.signal, null); assert.equal(completed.truncated, false); assert.equal(completed.timedOut, false)
      const events = [], stream = new HarnessEventStream(provider, { readOnly: true, commandBoundary: true,
        toolBoundary: f.boundary, onEvent: event => events.push(event) })
      for (const line of completed.stdout.trim().split(/\r?\n/)) if (line.trim()) stream.push(line)
      const parsed = stream.finish()
      assert.deepEqual(parsed.output, { ok: true })
      assert.equal(parsed.toolReceiptHashes.length, 1)
      assert.equal(parsed.usage.noncachedInput, 200); assert.equal(parsed.usage.output, 20)
      assert.equal(service.completed, 2, 'Only the observed tool and final model requests are allowed')
      assert.deepEqual(service.errors, [])
      assert.equal(fs.readFileSync(candidate, 'utf8'), marker)
      assert.equal(fs.readFileSync(scratch, 'utf8'), 'checked')
      assert.ok(parsed.events.some(event => event.item?.type === 'command_execution' && event.item.aggregated_output?.includes(marker)), 'Normalized command evidence must retain the actual candidate bytes')
      for (const request of service.requests.filter(item => item.body.tools)) {
        const names = request.body.tools.map(tool => tool.name || tool.function?.name)
        assert.ok(names.includes(name), `Controlled command must be advertised: ${JSON.stringify(names)}`)
        assert.ok(names.every(tool => controlled.decodeToolName(provider, tool) || tool === 'EndConversation'), `Foreign native tools leaked: ${JSON.stringify(names)}`)
        assert.equal(JSON.stringify(request.body).includes('FOREIGN_PROJECT_INSTRUCTIONS_MUST_NOT_LOAD'), false)
      }
      controlled.assertStopped(f.boundary)
    } finally { await service.close() }
  })
}
