'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const grok = require('../../scripts/harness-v2-grok.cjs')
const native = require('../../scripts/harness-v2-native.cjs')
const { grokTerminalObject, decodeNativeWireOutput } = require('../../scripts/harness-v2-transport.cjs')
const { nativeOutcomeDescriptionProjection } = require('../../scripts/harness-v2-native-wire-projection.cjs')
const { canonicalJsonWireProjection } = require('../../scripts/harness-v2-canonical-json-wire.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')

test('Grok prepare binds persistent home, full prompt/input, fixed MCP bridge, and exact tool policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-prepare-')), task = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-task-')), home = path.join(root, 'home')
  fs.mkdirSync(home, { mode: 0o700 }); fs.writeFileSync(path.join(root, 'grok'), '', { mode: 0o700 })
  const tool = boundary.prepareBoundary({ provider: 'grok', root, policy: { readOnly: false, targetPath: task, scratchPath: null, readableRoots: [task], writableRoots: [task], nestedDispatch: false, commandBoundary: true, externalWrites: false } })
  const outputSchema = { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }
  const options = { sessionHome: home, toolBoundary: tool, executable: path.join(root, 'grok'), model: 'openrouter/model', baseUrl: 'http://127.0.0.1:19777/v1', proxyToken: 'stable-child-token', prompt: 'ROLE\nSCHEMA', input: '{"canonical":"mission"}', effort: 'high', continuationId: 'session-1', outputSchema, maxCompletionTokens: 4096 }
  const prepared = grok.prepare(options)
  assert.deepEqual(prepared.argv.slice(0, 18), ['--no-alt-screen', '--verbatim', '--no-subagents', '--system-prompt-override', grok.SYSTEM_PROMPT, '-p', 'ROLE\nSCHEMA\n\n{"canonical":"mission"}', '--output-format', 'streaming-json', '--json-schema', JSON.stringify(outputSchema), '--always-approve', '-m', 'openrouter/model', '--tools', 'run_terminal_command', '--resume', 'session-1'])
  assert.match(grok.SYSTEM_PROMPT, /search_tool only discovers/i)
  assert.match(grok.SYSTEM_PROMPT, /use_tool with a tool_name returned/i)
  assert.match(grok.SYSTEM_PROMPT, /\"query\":\"read list search write edit bash\"/i)
  assert.match(grok.SYSTEM_PROMPT, /limit\":32/i)
  assert.match(grok.SYSTEM_PROMPT, /read \{path,startLine\?,lineCount\?\}/i)
  assert.match(grok.SYSTEM_PROMPT, /never add query, limit, description/i)
  const config = fs.readFileSync(prepared.configPath, 'utf8')
  assert.match(config, /mcp-loopback\.cjs/); assert.match(config, /reasoning_effort="high"/); assert.match(config, /max_completion_tokens=4096/); assert.match(config, /ignore=\["\*"\]/); assert.match(config, /\[features\][\s\S]*turn_summary=false[\s\S]*title_refresh=false[\s\S]*two_pass_compaction=false/)
  assert.match(config, /\[memory\]\nenabled=false/); assert.match(config, /session_recap=false\nauto_wake=false/); assert.match(config, /\.laziness_detector\]\nenabled=false/)
  assert.deepEqual(prepared.allowedMcpTools, { autoprompt_owned__read: 'read', autoprompt_owned__list: 'list', autoprompt_owned__search: 'search', autoprompt_owned__write: 'write', autoprompt_owned__edit: 'edit', autoprompt_owned__bash: 'bash' })
  assert.equal(grok.prepare(options).payloadSha256, prepared.payloadSha256)
  // Grok 1.0.13 appends this documented migration after first launch; a
  // resumed reservation must accept precisely those durable bytes and no more.
  fs.appendFileSync(prepared.configPath, '\n[marketplace]\ndefault_skills_installs_purged = true\n')
  assert.equal(grok.prepare(options).payloadSha256, prepared.payloadSha256)
  assert.throws(() => grok.prepare({ ...options, proxyToken: 'changed' }), /persistent config changed/)
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(task, { recursive: true, force: true })
})

test('Grok connection and effort inputs stay closed', () => {
  assert.deepEqual(grok.sanitizeConnection({ model: 'grok-4', environment: { GROK_BASE_URL: 'https://api.example/v1' } }), { model: 'grok-4', environment: { GROK_BASE_URL: 'https://api.example/v1' } })
  assert.equal(grok.selectApiKey({ OPENROUTER_API_KEY: 'key' }), 'key')
  assert.equal(grok.selectApiKey('https://openrouter.ai/api/v1', { GROK_API_KEY: 'wrong-for-openrouter', OPENROUTER_API_KEY: 'right-for-openrouter' }), 'right-for-openrouter')
  assert.equal(grok.upstreamChatCompletionsUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(grok.upstreamChatCompletionsUrl('https://api.example/v1/chat/completions'), 'https://api.example/v1/chat/completions')
  assert.throws(() => grok.sanitizeConnection({ command: 'bad' }))
  assert.equal(grok.EFFORTS.includes('high'), true)
  assert.equal(grok.EFFORTS.includes('ultra'), false)
  assert.throws(() => native.validateEffort('grok', 'ultra'), { code: 'PROFILE_INVALID' })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-effort-')), task = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-effort-task-')), home = path.join(root, 'home')
  fs.mkdirSync(home, { mode: 0o700 }); fs.writeFileSync(path.join(root, 'grok'), '', { mode: 0o700 })
  const tool = boundary.prepareBoundary({ provider: 'grok', root, policy: { readOnly: false, targetPath: task, scratchPath: null, readableRoots: [task], writableRoots: [task], nestedDispatch: false, commandBoundary: true, externalWrites: false } })
  const base = { sessionHome: home, toolBoundary: tool, executable: path.join(root, 'grok'), model: 'fixture/grok', baseUrl: 'http://127.0.0.1:19777/v1', proxyToken: 'stable-child-token', prompt: 'ROLE', input: '{"canonical":"mission"}', outputSchema: { type: 'object' } }
  assert.match(fs.readFileSync(grok.prepare(base).configPath, 'utf8'), /default_reasoning_effort="none"/)
  assert.throws(() => grok.prepare({ ...base, effort: 'ultra' }), /reasoning effort/)
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(task, { recursive: true, force: true })
})

test('Grok Windows runtime projection emits private paths and an inline MCP command', () => {
  const base = { model: 'fixture/grok', baseUrl: 'http://127.0.0.1:19777/v1', proxyToken: 'token', effort: 'none', maxCompletionTokens: 32 }
  const projected = grok.configText({ ...base, runtimeProjection: { platform: 'win32', nodeExecutable: 'C:\\Private Node\\node.exe', skillsPath: 'C:\\Private Skills\\skills', mcpPort: 19778 } })
  assert.match(projected, /command="C:\\\\Private Node\\\\node\.exe"/)
  assert.match(projected, /paths=\["C:\\\\Private Skills\\\\skills"\]/)
  assert.match(projected, /args=\["-e",/)
  assert.match(projected, /autoprompt-grok-inline-mcp\.cjs/)
  assert.match(projected, /"--port","19778"/)
  assert.throws(() => grok.configText({ ...base, runtimeProjection: { platform: 'win32', nodeExecutable: 'node.exe', skillsPath: 'C:\\skills', mcpPort: 19778 } }), /runtime projection paths/)
  assert.throws(() => grok.configText({ ...base, runtimeProjection: { platform: 'win32', nodeExecutable: 'C:\\node.exe', skillsPath: 'C:\\skills', mcpPort: 80 } }), /runtime MCP port/)
  assert.throws(() => grok.configText({ ...base, runtimeProjection: { platform: 'linux', nodeExecutable: '/usr/bin/node', skillsPath: '/skills', mcpPort: 19778 } }), /runtime projection/)
  const darwin = grok.configText({ ...base, baseUrl: 'http://[::1]:19777/v1', runtimeProjection: { platform: 'darwin', nodeExecutable: '/private/node', skillsPath: '/private/skills', mcpPort: 19778, proxyPort: 19777 } })
  assert.match(darwin, /base_url="http:\/\/\[::1\]:19777\/v1"/)
  assert.match(darwin, /paths=\["\/private\/skills"\]/)
  assert.match(darwin, /"--host","::1"/)
  assert.throws(() => grok.configText({ ...base, runtimeProjection: { platform: 'darwin', nodeExecutable: '/private/node', skillsPath: '/private/skills', mcpPort: 19778, proxyPort: 19778 } }), /runtime proxy port/)
  assert.throws(() => grok.configText({ ...base, runtimeProjection: { platform: 'darwin', nodeExecutable: 'node', skillsPath: '/private/skills', mcpPort: 19778, proxyPort: 19777 } }), /runtime projection paths/)
})

test('Grok sends the closed canonicalJson envelope around the authenticated checker wire projection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-checker-wire-')), task = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-checker-task-')), home = path.join(root, 'home')
  fs.mkdirSync(home, { mode: 0o700 }); fs.writeFileSync(path.join(root, 'grok'), '', { mode: 0o700 })
  const tool = boundary.prepareBoundary({ provider: 'grok', root, policy: { readOnly: false, targetPath: task, scratchPath: null, readableRoots: [task], writableRoots: [task], nestedDispatch: false, commandBoundary: true, externalWrites: false } })
  const canonical = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/contracts/schemas/outcome.schema.json'), 'utf8'))
  const record = { logicalRole: 'independent-checker', providerRole: 'ap-independent-checker' }
  const projection = nativeOutcomeDescriptionProjection(record, canonical)
  assert.ok(projection)
  const envelope = canonicalJsonWireProjection(projection.wireSchema, { provider: 'grok', label: 'Grok', version: 'grok-canonical-envelope-v1' })
  const prepared = grok.prepare({ sessionHome: home, toolBoundary: tool, executable: path.join(root, 'grok'), model: 'fixture/grok', baseUrl: 'http://127.0.0.1:19777/v1', proxyToken: 'stable-child-token', prompt: 'CHECKER', input: '{"canonical":"mission"}', outputSchema: envelope.wireSchema })
  const wire = JSON.parse(prepared.argv[prepared.argv.indexOf('--json-schema') + 1])
  assert.deepEqual(wire, envelope.wireSchema)
  assert.deepEqual(wire, { type: 'object', properties: { canonicalJson: { type: 'string' } }, required: ['canonicalJson'], additionalProperties: false })
  assert.equal(projection.wireSchema.required.includes('description'), false)
  for (const branch of projection.wireSchema.allOf.find(clause => Array.isArray(clause.oneOf)).oneOf) {
    assert.equal(branch.required.includes('description'), false)
    if (branch.properties.code.const === 'DONE') {
      assert.deepEqual(branch.properties.description.enum, [
        'Every requested result passed its current required checks.',
        'The usable requested results are preserved, but the required verification evidence is incomplete.',
      ])
    } else assert.equal(typeof branch.properties.description.const, 'string')
  }
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(task, { recursive: true, force: true })
})

test('Grok canonicalJson envelope decodes before checker description derivation and canonical validation', () => {
  const canonical = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/contracts/schemas/outcome.schema.json'), 'utf8'))
  const outcome = nativeOutcomeDescriptionProjection({ logicalRole: 'independent-checker', providerRole: 'ap-independent-checker' }, canonical)
  assert.ok(outcome)
  const envelope = canonicalJsonWireProjection(outcome.wireSchema, { provider: 'grok', label: 'Grok', version: 'grok-canonical-envelope-v1' })
  const hash = 'a'.repeat(64)
  const inner = { schemaVersion: '2.0.0', code: 'PASS', stateClass: 'terminal', runId: 'grok-envelope-unit', requestEnvelopeHash: hash, currentVersionHash: hash,
    completedResults: [], nextReadyWork: [], cause: { event: 'CHECK_COMPLETE', reason: 'The controller fixture completed the assigned check.', unblockPath: null },
    payloadSchemaId: 'autoprompt.independent-check.v2', payload: {}, recordedAt: '2026-09-08T00:00:00.000Z' }
  const decoded = decodeNativeWireOutput({ canonicalJson: JSON.stringify(inner) }, envelope, outcome)
  assert.equal(decoded.description, outcome.descriptionByCode.PASS)
  assert.throws(() => decodeNativeWireOutput({ canonicalJson: JSON.stringify({ ...inner, description: 'model-selected contradiction' }) }, envelope, outcome), { code: 'CHILD_RESULT_INVALID' })
  assert.throws(() => decodeNativeWireOutput({ canonicalJson: JSON.stringify(inner), extra: true }, envelope, outcome), { code: 'CHILD_RESULT_INVALID' })
  assert.throws(() => decodeNativeWireOutput({ canonicalJson: 'not json' }, envelope, outcome), { code: 'CHILD_RESULT_INVALID' })
})

test('Grok accepts only a whole labelled JSON result fence', () => {
  assert.deepEqual(grokTerminalObject(' \n```json\n{"ok":true}\n```\n'), { ok: true })
  assert.throws(() => grokTerminalObject('Tool summary.\n\n```json\n{"ok":true}\n```'), /exactly one JSON object/)
  assert.throws(() => grokTerminalObject('```json\n{"ok":true}\n```\n```json\n{"ok":false}\n```'), /exactly one JSON object/)
  assert.throws(() => grokTerminalObject('```json\n{"ok":true}\n```\ntrailing data'), /exactly one JSON object/)
})

test('Grok adapter terminals require native structured output and never recover text', () => {
  const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
  const usage = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 }
  const terminal = extra => ({ type: 'end', stopReason: 'end_turn', sessionId: 'session-structured', requestId: 'request-structured', usage, ...extra })
  const accepted = new HarnessEventStream('grok', { grokStructuredOutputRequired: true })
  accepted.grokAccountResponse('{"native":true}', usage)
  accepted.push(JSON.stringify({ type: 'usage', usage }))
  accepted.push(JSON.stringify({ type: 'text', data: 'explanatory prose before the native result' }))
  accepted.push(JSON.stringify(terminal({ structuredOutput: { ok: true } })))
  assert.deepEqual(accepted.terminal, { ok: true })
  const absent = new HarnessEventStream('grok', { grokStructuredOutputRequired: true })
  absent.grokAccountResponse('{"native":false}', usage); absent.push(JSON.stringify({ type: 'usage', usage })); absent.push(JSON.stringify({ type: 'text', data: '{"ok":true}' }))
  assert.throws(() => absent.push(JSON.stringify(terminal({ requestId: 'request-missing' }))), { code: 'CHILD_RESULT_INVALID' })
  const failed = new HarnessEventStream('grok', { grokStructuredOutputRequired: true })
  failed.grokAccountResponse('{"native":"failed"}', usage); failed.push(JSON.stringify({ type: 'usage', usage }))
  assert.throws(() => failed.push(JSON.stringify(terminal({ requestId: 'request-error', structuredOutputError: 'output does not match schema' }))), { code: 'CHILD_RESULT_INVALID' })
})

test('Grok structured-output rejection still binds paid usage and fresh host-tool callbacks', () => {
  const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
  const usage = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 }
  for (const extra of [{ structuredOutput: null }, { structuredOutputError: 'native schema rejected the result' }]) {
    const callbacks = [], debits = []
    const stream = new HarnessEventStream('grok', { grokStructuredOutputRequired: true,
      onToolCallObserved: event => callbacks.push(event), onUsageDelta: delta => { debits.push(delta); return { continue: true } } })
    stream.grokHostEvent({ toolCallId: `host-${callbacks.length}-${Object.keys(extra)[0]}`, tool: 'read', argumentsSha256: 'a'.repeat(64) })
    stream.grokAccountResponse(JSON.stringify(extra), usage)
    stream.push(JSON.stringify({ type: 'usage', usage }))
    assert.throws(() => stream.push(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: `session-${Object.keys(extra)[0]}`, requestId: `request-${Object.keys(extra)[0]}`, usage, ...extra })), { code: 'CHILD_RESULT_INVALID' })
    assert.equal(debits.length, 1)
    assert.deepEqual(callbacks.map(event => ({ itemType: event.itemType, observedPhase: event.observedPhase, continuationId: event.continuationId })), [{ itemType: 'read', observedPhase: 'started', continuationId: `session-${Object.keys(extra)[0]}` }])
  }
})

test('Grok streaming trace rejects duplicate, unfinished, and post-terminal tool identities', () => {
  const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
  const stream = new HarnessEventStream('grok', {})
  const call = { type: 'tool_call', toolCallId: 'tool-1', toolName: 'autoprompt_owned__bash', kind: 'mcp', status: 'in_progress', title: 'owned bash', content: null, locations: [], rawInput: {} }
  stream.push(JSON.stringify(call))
  assert.throws(() => stream.push(JSON.stringify(call)), /Duplicate Grok native tool identity/)
  const pending = new HarnessEventStream('grok', {})
  pending.push(JSON.stringify(call))
  assert.throws(() => pending.push(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'session-1', requestId: 'request-1', usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 } })), /unsettled tool trace/)
  const settled = new HarnessEventStream('grok', {})
  const pendingCall = { ...call, toolCallId: 'tool-2', kind: null, status: 'pending' }
  settled.push(JSON.stringify(pendingCall)); settled.push(JSON.stringify({ type: 'tool_call_update', toolCallId: 'tool-2', status: null, content: null, rawOutput: null, locations: [] }))
  settled.push(JSON.stringify({ type: 'tool_call_update', toolCallId: 'tool-2', status: 'completed', content: null, rawOutput: null, locations: [] }))
  assert.throws(() => settled.push(JSON.stringify({ type: 'tool_call_update', toolCallId: 'tool-2', status: 'completed', content: null, rawOutput: null, locations: [] })), /followed a settled trace/)
  const failed = new HarnessEventStream('grok', {})
  const usage = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 }
  failed.grokAccountResponse('{"failed-tool":true}', usage)
  failed.push(JSON.stringify({ ...pendingCall, toolCallId: 'tool-3' }))
  failed.push(JSON.stringify({ type: 'tool_call_update', toolCallId: 'tool-3', status: 'failed', content: null, rawOutput: null, locations: [] }))
  failed.push(JSON.stringify({ type: 'usage', usage }))
  failed.push(JSON.stringify({ type: 'text', data: '{"ok":true}' }))
  failed.push(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'session-3', requestId: 'request-3', usage }))
  assert.deepEqual(failed.terminal, { ok: true })
})

test('Grok streaming thought and controller usage ledger remain bounded and reconciled', () => {
  const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
  const observed = [], debits = []
  const stream = new HarnessEventStream('grok', { onEvent: event => observed.push(event), onUsageDelta: delta => { debits.push(delta); return { continue: true } } })
  const usage = { input_tokens: 9, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 3, reasoning_tokens: 2, total_tokens: 13 }
  stream.grokAccountResponse('{"stream":true}', usage)
  stream.push(JSON.stringify({ type: 'thought', data: 'native fixture reasoning' }))
  stream.push(JSON.stringify({ type: 'usage', usage }))
  assert.equal(debits.length, 1); assert.ok(observed.some(event => event.event === 'native_thought' && event.contextState === 'unbound'))
  assert.throws(() => stream.push(JSON.stringify({ type: 'usage', usage: { ...usage, output_tokens: 4, total_tokens: 14 } })), /differs from the controller-observed response/)
})

test('Grok projects issued host MCP executions before dispatch and authenticates their results', { skip: process.platform !== 'linux' }, async () => {
  const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
  const { createHostMcpRelay } = require('../../scripts/harness-v2-bridge/grok/host-mcp-relay.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-host-observations-'))
  const task = path.join(root, 'task'), control = path.join(root, 'control')
  fs.mkdirSync(task); fs.mkdirSync(control, { mode: 0o700 }); fs.writeFileSync(path.join(task, 'input.txt'), 'real owned input\n')
  const prepared = boundary.prepareBoundary({ provider: 'grok', root: control, policy: {
    sessionId: 'session', reservationId: 'reservation', readOnly: false,
    targetPath: task, scratchPath: null, readableRoots: [task], writableRoots: [task],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
  const stream = new HarnessEventStream('grok', { toolBoundary: prepared, commandBoundary: true, providerToolCallLimit: 10 })
  const events = [], emit = stream.emit.bind(stream)
  stream.emit = event => { events.push(event); emit(event) }
  const host = createHostMcpRelay({ boundary: prepared }), calls = []
  const dispatch = async (id, name, args) => {
    const call = { id, name: 'use_tool', target: `autoprompt_owned__${name}`, arguments: boundary.canonicalJson({ tool_name: `autoprompt_owned__${name}`, tool_input: args }) }
    calls.push(call)
    stream.grokHostEvent({ toolCallId: id, tool: name, argumentsSha256: boundary.sha256(call.arguments) })
    const request = { line: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) }
    return { request, response: await stream.grokMcpRequest(request, { handle: async value => {
      assert.ok(events.some(event => event.type === 'item.started' && event.item.id === id), 'execution start must be projected before host dispatch')
      return host.handle(value)
    } }, calls) }
  }
  try {
    await host.handle({ line: JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-03-26' } }) })
    await host.handle({ line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    const read = await dispatch('read-1', 'read', { path: path.join(task, 'input.txt') })
    assert.equal(JSON.parse(read.response.line).result.isError, false)
    await assert.rejects(stream.grokMcpRequest(read.request, host, calls), { code: 'TOOL_RECEIPT_INVALID' })
    // A denied cwd is authenticated as NOT_STARTED, never a successful check.
    const denied = await dispatch('bash-1', 'bash', { command: 'printf never', cwd: '/outside-owned-root' })
    assert.equal(JSON.parse(denied.response.line).result.isError, true)
    const deniedEvent = events.find(event => event.item?.id === 'bash-1' && event.type === 'item.failed')
    assert.equal(deniedEvent.item.controllerReceiptDisposition, 'NOT_STARTED')
    assert.equal(deniedEvent.item.command, 'printf never')
    const executed = await dispatch('bash-2', 'bash', { command: 'printf execution-observed', cwd: task })
    assert.equal(JSON.parse(executed.response.line).result.isError, false)
    const completed = events.find(event => event.item?.id === 'bash-2' && event.type === 'item.completed')
    assert.equal(completed.item.type, 'command_execution')
    assert.equal(completed.item.exit_code, 0)
    assert.equal(completed.item.aggregated_output, 'execution-observed')
    assert.equal(stream.toolCount, 3, 'host projection must not count provider issuance twice')
    await assert.rejects(stream.grokMcpRequest({ line: JSON.stringify({ jsonrpc: '2.0', id: 'null-args', method: 'tools/call', params: { name: 'list', arguments: null } }) }, host, calls), { code: 'TRANSPORT_INVALID' })
    const parallel = ['input.txt', 'missing.txt'].map((name, index) => {
      const id = `parallel-${index}`, args = { path: path.join(task, name) }
      const call = { id, name: 'use_tool', target: 'autoprompt_owned__read', arguments: boundary.canonicalJson({ tool_name: 'autoprompt_owned__read', tool_input: args }) }
      calls.push(call); stream.grokHostEvent({ toolCallId: id, tool: 'read', argumentsSha256: boundary.sha256(call.arguments) })
      return { line: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read', arguments: args } }) }
    })
    await Promise.all(parallel.reverse().map(request => stream.grokMcpRequest(request, host, calls)))
    assert.equal(stream.toolCount, 5)
    stream.grokReconcileIssuedCalls(calls)
    assert.equal(stream.grokReceiptHashes.length, 5, 'receipt identity must survive reverse arrival of concurrently issued calls')
    await assert.rejects(stream.grokMcpRequest({ line: JSON.stringify({ jsonrpc: '2.0', id: 'foreign', method: 'tools/call', params: { name: 'read', arguments: { path: path.join(task, 'input.txt') } } }) }, host, []), { code: 'TOOL_RECEIPT_INVALID' })
  } finally { await host.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
