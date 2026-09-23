'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const { HarnessExecAdapter } = require('../../scripts/harness-v2-transport.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { privateDirectory, nativeProcessAdapter, nativeEnvironment, nodeCommand, cleanupNativeFixture, drainNativeCommandOwners } = require('../helpers/native-platform.cjs')
const enabled = Boolean(process.env.AUTOPROMPT_VSCODE_TEST_CLI)

function closedBinding() {
  const names = ['AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT', 'AUTOPROMPT_CLOSED_CANARY_PROVIDER', 'AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID', 'AUTOPROMPT_CLOSED_CANARY_GENERATION', 'AUTOPROMPT_CLOSED_CANARY_CHALLENGE']
  const value = Object.fromEntries(names.map(name => [name, process.env[name]]))
  if (!names.some(name => value[name] !== undefined)) return null
  if (names.some(name => typeof value[name] !== 'string' || !value[name]) || value.AUTOPROMPT_CLOSED_CANARY_PROVIDER !== 'vscode' || !path.isAbsolute(value.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT) || !/^\d+$/.test(value.AUTOPROMPT_CLOSED_CANARY_GENERATION) || !/^[A-Za-z0-9_-]{43}$/.test(value.AUTOPROMPT_CLOSED_CANARY_CHALLENGE)) throw new Error('closed canary VS Code binding is invalid')
  const root = privateDirectory(value.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT), stat = fs.statSync(root)
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('closed canary VS Code ownership root is not private')
  return { root, activationId: value.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID, generation: Number(value.AUTOPROMPT_CLOSED_CANARY_GENERATION), challenge: value.AUTOPROMPT_CLOSED_CANARY_CHALLENGE }
}

async function fixture(t, options = {}) {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-owned-')))
  const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
  for (const dir of [target, controller, nativeRoot]) privateDirectory(dir)
  const closed = closedBinding()
  const projection = core.createCanonicalMissionProjection('Read the assigned candidate and return {"ok":true}.')
  const record = { activationId: closed?.activationId || 'vscode-owned-native', generation: closed?.generation || 1, workItemId: 'read', sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), logicalRole: 'worker', providerRole: 'ap-worker', physicalRole: 'ap-worker', canonicalMission: projection.canonicalMission, workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256('native vscode assignment') } } }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.physicalExecutionPolicy = { logicalRole: 'worker', providerRole: 'ap-worker', physicalRole: 'ap-worker', sandboxMode: 'read-only' }
  const environment = { ...nativeEnvironment(), ...Object.fromEntries(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'].filter(name => process.env[name]).map(name => [name, process.env[name]])) }
  const scratch = path.join(nativeRoot, 'vscode', native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch')
  const schema = path.join(controller, 'schema.json')
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }))
  const binding = native.probeExecutable({ provider: 'vscode', executable: process.env.AUTOPROMPT_VSCODE_TEST_CLI, env: environment })
  const registrationRoot = closed ? privateDirectory(path.join(closed.root, `vscode-${crypto.randomUUID()}`)) : controller
  if (closed) { fs.writeFileSync(path.join(registrationRoot, 'registration.json'), JSON.stringify({ schemaVersion: 1, provider: 'vscode', activationId: closed.activationId, generation: closed.generation, challenge: closed.challenge, registryPath: path.join(registrationRoot, 'processes.json') }), { flag: 'wx', mode: 0o600 }) }
  const registryPath = path.join(registrationRoot, 'processes.json')
  const adapter = nativeProcessAdapter(registryPath, path.dirname(registryPath))
  record.environment = prepareProcessLaunchEnvironment(adapter, record.reservationId, environment)
  const owner = new ProcessOwner({ adapter, registryPath, pollMs: 10 })
  const proxy = privateDirectory(path.join(controller, 'proxy'))
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: 'vscode-owned', pollMs: 10 })
  const requests = [], errors = []
  const server = http.createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk
      const body = JSON.parse(text); requests.push(body)
      assert.equal(req.headers.authorization, 'Bearer local-fixture')
      if (options.gate) await options.gate(requests.length)
      if (typeof options.respond === 'function') {
        await options.respond({ req, res, body, requests, root, target, controller, nativeRoot, scratch })
        return
      }
      const first = requests.length === 1 && !options.noTools
      const command = nodeCommand(`const fs=require('node:fs');const candidate=${JSON.stringify(path.join(target, 'candidate.txt'))};process.stdout.write(fs.readFileSync(candidate));fs.writeFileSync(${JSON.stringify(path.join(scratch, 'checked.txt'))},'checked');try{fs.writeFileSync(candidate,'wrong');process.exitCode=19}catch{};try{fs.readFileSync(${JSON.stringify(path.join(controller, 'private.txt'))});process.exitCode=20}catch{}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      const structured = body.response_format?.json_schema
      if (structured) assert.deepEqual(structured, { name: 'autoprompt_result', strict: true, schema: { type: 'object', properties: { canonicalJson: { type: 'string' } }, required: ['canonicalJson'], additionalProperties: false } })
      res.end(JSON.stringify({ id: `owned-request-${requests.length}`, model: 'fixture', choices: [{ index: 0, finish_reason: first ? 'tool_calls' : 'stop', message: first ? { role: 'assistant', content: '', tool_calls: [{ id: 'check-1', type: 'function', function: { name: 'autoprompt_owned_bash', arguments: JSON.stringify({ command }) } }] } : { role: 'assistant', content: structured ? '{"canonicalJson":"{\\"ok\\":true}"}' : '{"ok":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 2 } } }))
    } catch (error) { errors.push(error.message); res.writeHead(500); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const execution = new HarnessExecAdapter({ provider: 'vscode', runner, nativeRoot, executableBinding: binding, targetPath: target,
    connection: { model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, maxTokens: 128, maxSteps: 4, ...(options.structured ? { supportsStructuredOutput: true } : {}) }, credentialEnvironment: { OPENROUTER_API_KEY: 'local-fixture' }, rolePrompt: () => 'Use the owned tools and return JSON.', outputSchemaResolver: () => schema })
  t.after(async () => {
    if (process.env.AUTOPROMPT_VSCODE_TEST_KEEP) {
      await owner.cancelAll({ reason: 'VS Code native test cleanup', graceMs: 0, killMs: 2000 })
      await drainNativeCommandOwners(nativeRoot, 'vscode', record)
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); t.diagnostic(root); return
    }
    await cleanupNativeFixture({ root, nativeRoot, record }, 'vscode', {
      stop: () => owner.cancelAll({ reason: 'VS Code native test cleanup', graceMs: 0, killMs: 2000 }),
      close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
    })
  })
  return { root, target, controller, scratch, nativeRoot, record, requests, errors, runner, execution }
}

if (require.main === module) test('real VS Code owned BYOK session executes controlled tools, bills exact usage, and resumes privately', { skip: !enabled, timeout: 150000 }, async t => {
  const f = await fixture(t, { structured: true })
  fs.writeFileSync(path.join(f.target, 'candidate.txt'), 'native-vscode-candidate')
  fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'FOREIGN_VSCODE_PROMPT_MUST_NOT_LOAD')
  fs.writeFileSync(path.join(f.controller, 'private.txt'), 'PRIVATE_VSCODE_CONTROLLER')
  f.record.assignment = { effort: 'low' }
  const first = await f.execution.launch(f.record)
  assert.equal(first.ok, true)
  assert.deepEqual(first.usage, { noncachedInput: 160, cachedInput: 40, output: 20, reasoning: 4 })
  assert.equal(first.toolBoundaryEvidence.receiptHashes.length, 1)
  assert.equal(fs.readFileSync(path.join(f.scratch, 'checked.txt'), 'utf8'), 'checked')
  assert.equal(fs.readFileSync(path.join(f.target, 'candidate.txt'), 'utf8'), 'native-vscode-candidate')
  assert.equal(JSON.stringify(f.requests).includes('PRIVATE_VSCODE_CONTROLLER'), false)
  assert.equal(JSON.stringify(f.requests).includes('FOREIGN_VSCODE_PROMPT_MUST_NOT_LOAD'), false)
  const resumed = await f.execution.launch({ ...f.record, reservationId: crypto.randomUUID(), continuationId: first.contextId })
  assert.equal(resumed.contextId, first.contextId)
  assert.deepEqual(resumed.usage, { noncachedInput: 80, cachedInput: 20, output: 10, reasoning: 2 })
  assert.equal(f.requests[2].messages.some(message => message.role === 'tool'), true)
  const fresh = await f.execution.launch({ ...f.record, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() })
  assert.notEqual(fresh.contextId, first.contextId)
  assert.equal(f.requests[3].messages.some(message => message.role === 'tool'), false)
  assert.deepEqual(f.errors, [])
  assert.ok(f.requests.every(request => request.reasoning?.effort === 'low'), 'The pinned effort must reach the actual provider request')
  assert.ok(f.requests.every(request => request.response_format?.json_schema?.strict === true), 'Every native request must carry the opted-in strict schema')
})

module.exports = { fixture }

if (require.main === module) test('real VS Code zero-tool reservation advertises no tools', { skip: !enabled, timeout: 90000 }, async t => {
  const f = await fixture(t, { noTools: true })
  const result = await f.execution.launch({ ...f.record, providerToolCallLimit: 0 })
  assert.equal(result.ok, true)
  assert.ok(f.requests.length > 0)
  for (const request of f.requests) {
    assert.deepEqual(request.tools || [], [])
    assert.equal(request.response_format, undefined, 'structured output must remain off until the explicit capability opt-in')
  }
  assert.equal(result.toolBoundaryEvidence.receiptHashes.length, 0)
})

if (require.main === module) test('real VS Code rejects a terminal that violates the opted-in canonicalJson schema', { skip: !enabled, timeout: 90000 }, async t => {
  const f = await fixture(t, { structured: true, noTools: true, respond: ({ res, body }) => {
    assert.deepEqual(body.response_format?.json_schema, { name: 'autoprompt_result', strict: true, schema: { type: 'object', properties: { canonicalJson: { type: 'string' } }, required: ['canonicalJson'], additionalProperties: false } })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'owned-schema-mismatch', model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{\"ok\":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 2 } } }))
  } })
  await assert.rejects(f.execution.launch(f.record), { code: 'CHILD_RESULT_INVALID' })
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.errors, [])
})

if (require.main === module) test('real VS Code classifies prose-wrapped terminal JSON as an invalid child result', { skip: !enabled, timeout: 90000 }, async t => {
  const f = await fixture(t, { structured: true, noTools: true, respond: ({ res, body }) => {
    assert.equal(body.response_format?.json_schema?.strict, true)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'owned-prose-wrapped-result', model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Now I have the result.\n```json\n{"canonicalJson":"{\\"ok\\":true}"}\n```' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 2 } } }))
  } })
  await assert.rejects(f.execution.launch(f.record), { code: 'CHILD_RESULT_INVALID', message: 'Owned VS Code session failed' })
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.errors, [])
})

if (require.main === module) test('real VS Code concurrent owned sessions isolate sibling cancellation and drain', { skip: !enabled, timeout: 150000 }, async t => {
  const pending = new Map()
  const f = await fixture(t, { noTools: true, gate: count => new Promise(resolve => pending.set(count, resolve)) })
  t.after(() => { for (const release of pending.values()) release() })
  const contexts = [], cancel = new AbortController()
  let firstError, secondError, secondDone = false
  const firstRecord = { ...f.record, signal: cancel.signal, onSessionIdentified: id => { contexts[0] = id } }
  const first = f.execution.launch(firstRecord); first.catch(error => { firstError = error })
  const secondRecord = { ...f.record, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), onSessionIdentified: id => { contexts[1] = id } }
  const second = f.execution.launch(secondRecord); second.then(() => { secondDone = true }, error => { secondError = error })
  const deadline = Date.now() + 60000
  while (pending.size < 2 && !firstError && !secondError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  if (firstError) throw firstError
  if (secondError) throw secondError
  assert.equal(pending.size, 2)
  assert.equal(typeof contexts[0], 'string'); assert.equal(typeof contexts[1], 'string'); assert.notEqual(contexts[0], contexts[1])
  cancel.abort()
  await assert.rejects(first, { code: 'CHILD_CANCELLED' })
  assert.equal(secondDone, false); assert.equal(secondError, undefined)
  for (const release of pending.values()) release()
  const output = await second
  assert.equal(output.contextId, contexts[1]); assert.equal(output.ok, true)
  assert.deepEqual(output.usage, { noncachedInput: 80, cachedInput: 20, output: 10, reasoning: 2 })
  for (const record of [firstRecord, secondRecord]) {
    const stopped = await f.runner.stop({ sessionId: `native-vscode-${native.sha256(JSON.stringify([record.sessionId, record.reservationId]))}`, reason: 'native concurrent drain evidence' })
    assert.equal(stopped.drained, true)
  }
})

if (require.main === module) test('real VS Code preserves a validated receipt when the provider rejects its finish reason', { skip: !enabled, timeout: 150000 }, async t => {
  const f = await fixture(t, { noTools: true, respond: ({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'owned-rejected-receipt', model: 'fixture', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{"ok":true}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 2 } } }))
  } })
  const debits = []
  await assert.rejects(f.execution.launch({ ...f.record, onUsageDelta: delta => { debits.push(delta); return { continue: true } } }), { code: 'CHILD_RUNTIME_FAILURE' })
  assert.deepEqual(debits, [{ noncachedInput: 80, cachedInput: 20, output: 10, reasoning: 2 }])
})

if (require.main === module) test('real VS Code owned BYOK live model reads the candidate through controlled tools', {
  skip: !enabled || !process.env.AUTOPROMPT_VSCODE_LIVE_KEY_FILE, timeout: 150000,
}, async t => {
  const f = await fixture(t, { noTools: true })
  const marker = crypto.randomBytes(12).toString('hex')
  fs.writeFileSync(path.join(f.target, 'candidate.txt'), marker)
  f.execution.connection = { model: 'deepseek/deepseek-v4-flash', baseUrl: 'https://openrouter.ai/api/v1', maxTokens: 512, maxSteps: 4, reasoningEffort: 'low' }
  f.execution.credentialEnvironment = { OPENROUTER_API_KEY: fs.readFileSync(process.env.AUTOPROMPT_VSCODE_LIVE_KEY_FILE, 'utf8').trim() }
  f.execution.rolePrompt = () => `Read ${JSON.stringify(path.join(f.target, 'candidate.txt'))} using the owned read tool before answering. Return only {"ok":true} after reading it. Do not output Markdown.`
  const events = []
  const result = await f.execution.launch({ ...f.record, onEvent: event => events.push(event) })
  assert.equal(result.ok, true)
  assert.ok(result.toolBoundaryEvidence.receiptHashes.length > 0)
  assert.ok(events.some(event => event.type === 'owned.tool.end' && JSON.parse(event.output).output.includes(marker)))
  const receipts = events.filter(event => event.type === 'owned.usage')
  assert.ok(receipts.length >= 2)
  const cost = receipts.reduce((sum, event) => sum + (event.cost || 0), 0)
  assert.ok(cost < 0.5)
  t.diagnostic(JSON.stringify({ model: f.execution.connection.model, usage: result.usage, reportedCostUSD: cost, requestIds: receipts.map(receipt => receipt.requestId), toolReceipts: result.toolBoundaryEvidence.receiptHashes.length }))
})
