'use strict'

// Eleven closed Grok capabilities against the installed 1.0.13 CLI. The model
// is a local OpenAI-compatible stream; proxy, relay, preconnected bwrap FD,
// MCP server, process owner, receipts, and persistence are production code.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessExecAdapter } = require('../../scripts/harness-v2-transport.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { privateDirectory, nativeProcessAdapter, nodeCommand, readCommand, withChallenge, nativeEnvironment, cleanupNativeFixture } = require('../helpers/native-platform.cjs')

const CLI = process.env.AUTOPROMPT_GROK_TEST_CLI
const skip = !CLI || !fs.existsSync(CLI)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
function exactCommand(prefix, values) { return withChallenge(nodeCommand(`process.stdout.write(${JSON.stringify(`${prefix}:${values.marker}`)})`), values.challenge) }

function chunk(id, delta, finish, usage = true) {
  return { id, object: 'chat.completion.chunk', created: 1, model: 'fixture/grok', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } } : {}) }
}
function toolSse(id, name, args) {
  return `data: ${JSON.stringify(chunk(`grok-${id}`, { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null, false))}\n\ndata: ${JSON.stringify(chunk(`grok-${id}`, {}, 'tool_calls'))}\n\ndata: [DONE]\n\n`
}
function finalSse(includeThought = false, result = { ok: true }) {
  const thought = includeThought ? `data: ${JSON.stringify(chunk('grok-final', { role: 'assistant', reasoning_content: 'fixture native reasoning progress' }, null, false))}\n\n` : ''
  return `${thought}data: ${JSON.stringify(chunk('grok-final', { role: 'assistant', content: JSON.stringify(result) }, null, false))}\n\ndata: ${JSON.stringify(chunk('grok-final', {}, 'stop'))}\n\ndata: [DONE]\n\n`
}
async function modelService(calls, options = {}) {
  const requests = []; let index = 0, hold = false
  let releaseFinal; const finalRelease = new Promise(resolve => { releaseFinal = resolve }); let notifyFinalHeld; const finalHeld = new Promise(resolve => { notifyFinalHeld = resolve })
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part
      const body = JSON.parse(raw); requests.push({ body, authorization: req.headers.authorization })
      if (hold) {
        hold = false
        await new Promise(resolve => { req.once('aborted', resolve); res.once('close', resolve) })
        return
      }
      const call = calls[index++]
      if (!call && options.holdFinal) {
        notifyFinalHeld()
        await finalRelease
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const structured = body.response_format?.json_schema?.schema?.properties?.canonicalJson
      res.end(call ? toolSse(call.id, call.name, call.args) : finalSse(options.includeThought === true, structured ? { canonicalJson: JSON.stringify(options.result || { ok: true }) } : (options.result || { ok: true })))
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { calls, requests, url: `http://127.0.0.1:${server.address().port}/v1`, finalHeld, releaseFinal, holdNext: () => { hold = true }, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }) }
}
function fixture() {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-closed-capability-')))
  const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
  for (const directory of [target, controller, nativeRoot]) privateDirectory(directory)
  const challenge = process.env.AUTOPROMPT_CLOSED_CANARY_CHALLENGE || crypto.randomBytes(32).toString('base64url')
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error('Grok closed-canary challenge is invalid')
  const activationId = process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID || 'grok-closed-native-canary'
  const generationText = process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION
  if ((process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID === undefined) !== (generationText === undefined) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(activationId) || generationText !== undefined && (!/^[1-9][0-9]*$/.test(generationText) || !Number.isSafeInteger(Number(generationText)))) throw new Error('Grok closed-canary activation binding is invalid')
  const projection = core.createCanonicalMissionProjection(`FIRST_CONTEXT_SENTINEL: use only assigned controller tools and return JSON.\nCLOSED_CANARY_CHALLENGE: ${challenge}`)
  const record = { activationId, generation: generationText ? Number(generationText) : 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'grok-closed-capability', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', canonicalMission: projection.canonicalMission, workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256(`grok-capability:${challenge}`) } } }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.physicalExecutionPolicy = { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }
  const schema = path.join(controller, 'result.schema.json'); fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }), { mode: 0o600 })
  return { root, target, controller, nativeRoot, challenge, projection, record, schema }
}
function ownershipRegistry(f) {
  const root = process.env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT
  if (!root) return path.join(f.controller, 'processes.json')
  if (!path.isAbsolute(root) || process.env.AUTOPROMPT_CLOSED_CANARY_PROVIDER !== 'grok' || process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID !== f.record.activationId || process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION !== String(f.record.generation)) throw new Error('Grok closed-canary ownership registration is invalid')
  const privateRoot = privateDirectory(root), stat = fs.statSync(privateRoot); if (!stat.isDirectory() || (process.platform !== 'win32' && stat.mode & 0o077)) throw new Error('Grok closed-canary ownership root is not private')
  const directory = privateDirectory(path.join(privateRoot, `grok-${crypto.randomUUID()}`))
  const registryPath = path.join(directory, 'processes.json')
  fs.writeFileSync(path.join(directory, 'registration.json'), JSON.stringify({ schemaVersion: 1, provider: 'grok', activationId: f.record.activationId, generation: f.record.generation, challenge: f.challenge, registryPath }), { flag: 'wx', mode: 0o600 })
  return registryPath
}
function scratchFor(f, record = f.record) { return path.join(f.nativeRoot, 'grok', native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch') }
const GROK_PROXY_DIAGNOSTIC_MAX_SESSIONS = 8
const GROK_PROXY_DIAGNOSTIC_MAX_FILE_BYTES = 64 * 1024
const GROK_PROXY_DIAGNOSTIC_SLICE_BYTES = 2048
function samePhysicalPath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
function physicalSingleLinkRegular(file, maximum) {
  const item = fs.lstatSync(file, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || item.size > BigInt(maximum)) return null
  const resolved = fs.realpathSync.native(file)
  if (!samePhysicalPath(resolved, path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)))) return null
  return { item, size: Number(item.size) }
}
function redactGrokDiagnostic(value) {
  return String(value)
    .replace(/local-test-secret/gu, '<redacted>')
    .replace(/\b((?:OPENROUTER|GROK|XAI|OPENAI)_API_KEY|AUTOPROMPT_GROK_[A-Z0-9_]*TOKEN)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1$2<redacted>')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{12,}/gu, '$1 <redacted>')
}
function boundedGrokProxyFile(file, parser) {
  try {
    const checked = physicalSingleLinkRegular(file, GROK_PROXY_DIAGNOSTIC_MAX_FILE_BYTES)
    if (!checked) return { status: 'unavailable' }
    const bytes = fs.readFileSync(file)
    const after = physicalSingleLinkRegular(file, GROK_PROXY_DIAGNOSTIC_MAX_FILE_BYTES)
    if (!after || after.item.dev !== checked.item.dev || after.item.ino !== checked.item.ino || after.item.size !== checked.item.size) return { status: 'changed' }
    return parser(bytes, checked.size)
  } catch { return { status: 'pending' } }
}
function boundedGrokProxyDiagnostic(runner) {
  const root = runner?.controlRoot
  if (typeof root !== 'string') return []
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const sessions = entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{32}$/u.test(entry.name))
  if (sessions.length > GROK_PROXY_DIAGNOSTIC_MAX_SESSIONS) return [{ status: 'directory-limit', count: sessions.length }]
  return sessions.map(entry => {
    const directory = path.join(root, entry.name)
    try {
      const item = fs.lstatSync(directory, { bigint: true })
      if (!item.isDirectory() || item.isSymbolicLink()) return { status: 'invalid-directory' }
    } catch { return { status: 'pending' } }
    const status = boundedGrokProxyFile(path.join(directory, 'status.json'), bytes => {
      const value = JSON.parse(bytes.toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' }
      return { code: value.code || null, signal: value.signal || null,
        proxyError: value.error && typeof value.error === 'object' ? { code: value.error.code || null, message: redactGrokDiagnostic(String(value.error.message || '')).slice(0, 512) } : null }
    })
    const stderr = boundedGrokProxyFile(path.join(directory, 'stderr.log'), (bytes, size) => {
      const head = bytes.subarray(0, Math.min(bytes.length, GROK_PROXY_DIAGNOSTIC_SLICE_BYTES))
      const tail = bytes.subarray(Math.max(0, bytes.length - GROK_PROXY_DIAGNOSTIC_SLICE_BYTES))
      return { bytes: size, head: redactGrokDiagnostic(head.toString('utf8')), tail: redactGrokDiagnostic(tail.toString('utf8')) }
    })
    return { status, stderr }
  })
}
test('Grok fixture proxy diagnostics are bounded, physical, and redact fixture credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-proxy-diagnostic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const session = path.join(root, 'a'.repeat(32)); fs.mkdirSync(session)
  fs.writeFileSync(path.join(session, 'status.json'), JSON.stringify({ code: 'CHILD_RUNTIME_FAILURE', error: { code: 'FAILED', message: 'OPENROUTER_API_KEY=local-test-secret' } }))
  fs.writeFileSync(path.join(session, 'stderr.log'), 'before local-test-secret\nAUTOPROMPT_GROK_RELAY_TOKEN=runtime-token-value\nafter\n')
  fs.linkSync(path.join(session, 'stderr.log'), path.join(session, 'stderr-copy.log'))
  assert.equal(boundedGrokProxyDiagnostic({ controlRoot: root })[0].stderr.status, 'unavailable')
  fs.unlinkSync(path.join(session, 'stderr-copy.log'))
  const diagnostic = boundedGrokProxyDiagnostic({ controlRoot: root })
  assert.equal(diagnostic.length, 1)
  assert.equal(JSON.stringify(diagnostic).includes('local-test-secret'), false)
  assert.equal(JSON.stringify(diagnostic).includes('runtime-token-value'), false)
  assert.equal(diagnostic[0].stderr.bytes > 0, true)
  for (let index = 1; index <= GROK_PROXY_DIAGNOSTIC_MAX_SESSIONS; index++) fs.mkdirSync(path.join(root, index.toString(16).padStart(32, '0')))
  assert.deepEqual(boundedGrokProxyDiagnostic({ controlRoot: root }), [{ status: 'directory-limit', count: GROK_PROXY_DIAGNOSTIC_MAX_SESSIONS + 1 }])
})
function sibling(f, name) { const ids = { sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: name }; return { ...ids, missionBinding: core.bindCanonicalMissionForChild(f.projection, { ...f.record, ...ids, sourceRequestHash: f.projection.sourceRequestHash, requestEnvelopeHash: f.record.dispatch.requestPointer.hash }) } }
function receipts(f, result) {
  const found = []; const visit = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) visit(file); else if (item.name === 'policy.json') try { const state = boundary.loadBoundary(file, result.toolBoundaryEvidence.policySha256); found.push(...boundary.readReceipts(state)) } catch {} } }
  visit(f.nativeRoot); return found
}
async function scenario(t, setup) {
  const f = fixture(), read = path.join(f.target, 'input.txt'), secret = path.join(f.controller, 'private.txt'), marker = `grok-native-capability-${crypto.randomUUID()}`
  fs.writeFileSync(read, `${marker}\n`, { mode: 0o600 }); fs.writeFileSync(secret, 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE', { mode: 0o600 }); fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD', { mode: 0o600 })
  const calls = typeof setup?.calls === 'function' ? setup.calls({ ...f, read, secret, marker, scratch: scratchFor(f) }) : Array.isArray(setup?.calls) ? setup.calls : []
  const service = await modelService(calls, { holdFinal: setup?.holdFinal === true, includeThought: setup?.includeThought === true }), binding = native.probeExecutable({ provider: 'grok', executable: CLI })
  const registryPath = ownershipRegistry(f), processAdapter = nativeProcessAdapter(registryPath, path.dirname(registryPath)), owner = new ProcessOwner({ adapter: processAdapter, registryPath, pollMs: 10, startupTimeoutMs: 10000 })
  const proxy = privateDirectory(path.join(f.controller, 'proxy'))
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: 'grok-closed-native-canary', pollMs: 10 })
  const adapter = new HarnessExecAdapter({ provider: 'grok', runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target, connection: { model: 'fixture/grok', environment: { GROK_BASE_URL: service.url } }, credentialEnvironment: { OPENROUTER_API_KEY: 'local-test-secret' }, rolePrompt: () => 'Use only controller-owned tools and return exactly one JSON object.', outputSchemaResolver: () => f.schema })
  let fixtureClosing = false
  const activeLaunches = new Set(), launchControllers = new Set()
  const launch = async (overrides = {}) => {
    const record = { ...f.record, ...overrides }
    record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, nativeEnvironment())
    record.onUsageDelta = () => ({ continue: true })
    try { return await adapter.launch(record) } catch (error) {
      t.diagnostic(JSON.stringify({ grokNativeFailure: { code: error?.code || null, message: redactGrokDiagnostic(String(error?.message || error)).slice(0, 512), proxy: boundedGrokProxyDiagnostic(runner) } }))
      throw error
    }
  }
  const run = (overrides = {}) => {
    if (fixtureClosing) return Promise.reject(new Error('Grok fixture is closing'))
    const controller = new AbortController()
    launchControllers.add(controller)
    const signals = [controller.signal, overrides.signal || AbortSignal.timeout(90000)]
    const operation = launch({ ...overrides, signal: AbortSignal.any(signals) })
    activeLaunches.add(operation)
    operation.finally(() => { activeLaunches.delete(operation); launchControllers.delete(controller) }).catch(() => {})
    return operation
  }
  t.after(async () => {
    fixtureClosing = true
    for (const controller of launchControllers) controller.abort()
    await Promise.allSettled([...activeLaunches])
    await cleanupNativeFixture(f, 'grok', { stop: async () => {
      await owner.cancelAll({ reason: 'Grok capability cleanup', graceMs: 0, killMs: 2000, waitForPending: true })
      await owner.assertDrained()
    }, close: () => service.close() })
  })
  return { ...f, read, secret, marker, calls, service, binding, processAdapter, owner, runner, adapter, run }
}
function good(result) { assert.equal(result.ok, true); assert.match(result.contextId, /^[A-Za-z0-9_.:-]{1,256}$/); assert.ok(result.transportEvidence.eventCount > 0); assert.match(result.transportEvidence.eventStreamHash, /^[a-f0-9]{64}$/) }

const capabilityOptions = { skip, timeout: 120000 }
async function withWindowsLaunchDiagnostics(t, body) {
  if (process.platform !== 'win32') return body(t)
  // A cancelled prelaunch has no proxy stderr yet. Record the real preparation
  // boundaries without copying arguments, environment values, or credentials.
  const started = Date.now(), replacements = []
  let records = 0
  const report = (stage, phase, began, error) => {
    if (++records > 64) return
    t.diagnostic(JSON.stringify({ grokLaunchStage: stage, phase, elapsedMs: Date.now() - started,
      ...(began === undefined ? {} : { durationMs: Date.now() - began }),
      ...(error ? { code: typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'ERROR' } : {}) }))
  }
  const wrap = (target, name, stage) => {
    const original = target[name]
    assert.equal(typeof original, 'function')
    target[name] = function (...args) {
      const began = Date.now(); report(stage, 'started')
      const done = value => { report(stage, 'completed', began); return value }
      const failed = error => { report(stage, 'failed', began, error); throw error }
      try {
        const value = Reflect.apply(original, this, args)
        return value && typeof value.then === 'function' ? value.then(done, failed) : done(value)
      } catch (error) { return failed(error) }
    }
    replacements.push(() => { target[name] = original })
  }
  try {
    const launch = require('../../scripts/harness-v2-bridge/grok/windows-launch.cjs')
    wrap(launch, 'prepareSession', 'session')
    wrap(launch, 'prepareLaunch', 'launch-resource')
    wrap(require('../../agents/codex/workflow/windows-helper-deployment.js'), 'stageWindowsHelperDeployment', 'helper-deployment')
    wrap(require('../../agents/codex/workflow/windows-appcontainer-resources.js'), 'prepareWindowsAppContainerResources', 'appcontainer-resources')
    wrap(ProcessOwner.prototype, 'launch', 'owned-process')
    return await body(t)
  } finally {
    for (const restore of replacements.reverse()) restore()
  }
}
const capability = (name, body) => test(`grok closed native capability: ${name}`, capabilityOptions, t => withWindowsLaunchDiagnostics(t, body))

capability('all six owned tools enforce write/private/network isolation and scratch witness', async t => {
  let contacted = false
  const listener = net.createServer(socket => { contacted = true; socket.destroy() })
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  try {
    const f = await scenario(t, { calls: values => {
      const output = path.join(values.scratch, 'six-tools.txt')
      return [
        { id: 'search-meta', name: 'search_tool', args: { query: 'autoprompt owned tools' } },
        { id: 'read', name: 'use_tool', args: { tool_name: 'autoprompt_owned__read', tool_input: { path: values.read, startLine: 1, lineCount: 2 } } },
        { id: 'list', name: 'use_tool', args: { tool_name: 'autoprompt_owned__list', tool_input: { path: values.target } } },
        { id: 'search', name: 'use_tool', args: { tool_name: 'autoprompt_owned__search', tool_input: { path: values.target, text: values.marker, maxResults: 10 } } },
        { id: 'write', name: 'use_tool', args: { tool_name: 'autoprompt_owned__write', tool_input: { path: output, content: 'before' } } },
        { id: 'edit', name: 'use_tool', args: { tool_name: 'autoprompt_owned__edit', tool_input: { path: output, oldText: 'before', newText: 'after' } } },
        { id: 'bash-exact', name: 'use_tool', args: { tool_name: 'autoprompt_owned__bash', tool_input: { command: exactCommand('exact', values), cwd: values.target, timeoutMs: 30000 } } },
        { id: 'bash-denied', name: 'use_tool', args: { tool_name: 'autoprompt_owned__bash', tool_input: { command: nodeCommand(`const fs=require('node:fs'),net=require('node:net'); try { fs.writeFileSync(${JSON.stringify(values.read)}, 'forbidden'); process.exit(18) } catch {} try { fs.readFileSync(${JSON.stringify(values.secret)}); process.exit(20) } catch {} const s=net.connect(${listener.address().port}, '127.0.0.1'); s.on('connect',()=>process.exit(21)); s.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(0),700)`), cwd: values.target, timeoutMs: 30000 } } },
      ]
    } })
    const result = await f.run({ assignment: { model: 'fixture/grok', effort: 'high' } }); good(result)
    assert.equal(result.toolBoundaryEvidence.receiptHashes.length, 7)
    assert.equal(fs.readFileSync(path.join(scratchFor(f), 'six-tools.txt'), 'utf8'), 'after')
    assert.equal(fs.readFileSync(f.read, 'utf8'), `${f.marker}\n`); assert.equal(contacted, false)
  } finally { await new Promise(resolve => listener.close(resolve)) }
})

capability('private and ambient configuration are absent from actual model requests', async t => {
  const f = await scenario(t, { calls: [] })
  privateDirectory(path.join(f.target, '.grok')); fs.writeFileSync(path.join(f.target, '.grok', 'config'), 'AMBIENT_GROK_CONFIG_MUST_NOT_LOAD')
  good(await f.run({}))
  const wire = JSON.stringify(f.service.requests)
  for (const sentinel of ['AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD', 'AMBIENT_GROK_CONFIG_MUST_NOT_LOAD', 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE']) assert.equal(wire.includes(sentinel), false, sentinel)
})

capability('native event stream stays correlated to one context', async t => {
  const f = await scenario(t, { holdFinal: true, includeThought: true, calls: values => [{ id: 'event-tool', name: 'use_tool', args: { tool_name: 'autoprompt_owned__bash', tool_input: { command: exactCommand('event-tool', values), cwd: values.target, timeoutMs: 30000 } } }] }), events = [], identified = [], observedTools = []
  let settled = false
  const pending = f.run({ onEvent: event => events.push(event), onSessionIdentified: id => identified.push(id), onToolCallObserved: event => observedTools.push(event) }).then(value => { settled = true; return value })
  await Promise.race([f.service.finalHeld, wait(90000).then(() => { throw new Error('Grok never held the post-tool final response') })])
  for (let index = 0; index < 200 && !events.some(event => event.event === 'host_tool_request' && event.source === 'host-relay'); index++) await wait(100)
  const observed = events.find(event => event.event === 'host_tool_request' && event.source === 'host-relay')
  assert.ok(observed, JSON.stringify(events)); assert.equal(f.service.requests.length, 2); assert.equal(observed.contextState, 'unbound'); assert.equal(Object.hasOwn(observed, 'sessionId'), false); assert.equal(settled, false)
  f.service.releaseFinal(); const result = await pending; good(result)
  const nativeCall = events.find(event => event.event === 'native_tool_call' && event.source === 'native-cli')
  assert.ok(nativeCall, JSON.stringify(events)); assert.ok(['search_tool', 'use_tool'].includes(nativeCall.toolName)); assert.equal(nativeCall.contextState, 'unbound'); assert.equal(Object.hasOwn(nativeCall, 'sessionId'), false)
  assert.ok(events.some(event => event.event === 'host_tool_request' && event.source === 'host-relay' && event.tool === 'bash')); assert.deepEqual(identified, [result.contextId]); assert.deepEqual(observedTools.map(event => ({ attemptedCount: event.attemptedCount, itemType: event.itemType, observedPhase: event.observedPhase })), [{ attemptedCount: 1, itemType: 'bash', observedPhase: 'started' }]); assert.ok(events.some(event => event.type === 'end' && event.sessionId === result.contextId)); assert.ok(events.some(event => event.event === 'native_thought' && event.source === 'native-cli' && event.data === 'fixture native reasoning progress')); assert.ok(fs.existsSync(path.join(f.nativeRoot, 'contexts', native.sha256(result.contextId) + '.json')))
})

capability('exact output bytes are committed in the controller receipt', async t => {
  const f = await scenario(t, { calls: values => [{ id: 'bash-exact', name: 'use_tool', args: { tool_name: 'autoprompt_owned__bash', tool_input: { command: exactCommand('exact', values), cwd: values.target, timeoutMs: 30000 } } }] })
  const result = await f.run({}); good(result)
  const bash = receipts(f, result).find(item => item.tool === 'bash'); assert.ok(bash)
  assert.equal(bash.outputSha256, native.sha256(`exact:${f.marker}\nCLOSED_CANARY_CHALLENGE:${f.challenge}\n`)); assert.equal(bash.status, 'completed')
})

capability('overlapping siblings retain unique contexts and drain', async t => {
  const f = await scenario(t, { calls: [] }); let peak = 0
  const monitor = setInterval(() => { peak = Math.max(peak, f.owner.ownershipIdentities().length) }, 5)
  let values; try { values = await Promise.all([f.run(sibling(f, 'grok-sibling-a')), f.run(sibling(f, 'grok-sibling-b'))]) } finally { clearInterval(monitor) }
  values.forEach(good); assert.equal(new Set(values.map(value => value.contextId)).size, 2); assert.ok(peak >= 2); assert.deepEqual(f.owner.ownershipIdentities(), [])
})

capability('resume reuses only its bound target context', async t => {
  const f = await scenario(t, { calls: [] })
  const first = await f.run({ assignment: { model: 'fixture/grok', effort: 'high' } }); good(first)
  const resumed = await f.run({ reservationId: crypto.randomUUID(), continuationId: first.contextId, assignment: { model: 'fixture/grok', effort: 'high' } }); good(resumed); assert.equal(resumed.contextId, first.contextId)
  const foreign = privateDirectory(path.join(f.root, 'foreign')), foreignReservation = crypto.randomUUID()
  await assert.rejects(f.adapter.launch({ ...f.record, reservationId: foreignReservation, continuationId: first.contextId, assignment: { model: 'fixture/grok', effort: 'high' }, workingDirectory: foreign, environment: prepareProcessLaunchEnvironment(f.processAdapter, foreignReservation, nativeEnvironment()), signal: AbortSignal.timeout(30000) }), error => ['SESSION_ID_MISMATCH', 'CONTINUATION_NOT_FOUND', 'CONTINUATION_INVALID'].includes(error.code))
})

capability('hostile native tool topology is denied before an owned controller call', async t => {
  const hostile = await scenario(t, { calls: () => [{ id: 'native-tool', name: 'run_terminal_command', args: { command: 'touch forbidden', description: 'forbidden' } }] })
  await assert.rejects(hostile.run({}), error => ['GROK_PROXY_TOOL_DENIED', 'CHILD_RUNTIME_FAILURE', 'TRANSPORT_INVALID'].includes(error.code))
  assert.equal(fs.existsSync(path.join(hostile.target, 'forbidden')), false); assert.equal(hostile.service.requests.length, 1)
})

capability('held child cancels while a fast sibling remains alive and drained', async t => {
  const held = await scenario(t, { calls: [] }); held.service.holdNext(); const abort = new AbortController(), pending = held.run({ signal: abort.signal }); pending.catch(() => {})
  for (let index = 0; index < 300 && held.service.requests.length === 0; index++) await wait(50)
  assert.ok(held.service.requests.length > 0)
  const fast = await scenario(t, { calls: [] }); good(await fast.run({})); abort.abort(); await assert.rejects(pending, { code: 'CHILD_CANCELLED' }); assert.deepEqual(held.owner.ownershipIdentities(), [])
})

capability('checker sees frozen candidate but writes only authenticated scratch', async t => {
  const checkerFixture = await scenario(t, { calls: values => [{ id: 'checker', name: 'use_tool', args: { tool_name: 'autoprompt_owned__bash', tool_input: { command: `${readCommand(path.join(values.root, 'frozen', 'candidate.txt'))} && ${nodeCommand(`const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(values.root, 'checker-scratch', 'checker.txt'))}, 'checked'); try { fs.writeFileSync(${JSON.stringify(path.join(values.root, 'frozen', 'candidate.txt'))}, 'wrong'); process.exit(19) } catch {}`)}`, cwd: path.join(values.root, 'checker-scratch'), timeoutMs: 30000 } } }] })
  const frozen = privateDirectory(path.join(checkerFixture.root, 'frozen')), scratch = privateDirectory(path.join(checkerFixture.root, 'checker-scratch')); for (const name of ['tmp', 'output', 'cache']) privateDirectory(path.join(scratch, name))
  const candidate = path.join(frozen, 'candidate.txt'); fs.writeFileSync(candidate, `${checkerFixture.marker}\n`)
  const checker = { schemaVersion: 1, capability: native.sha256('grok-closed-checker'), runId: 'grok-closed-checker', checkerId: 'grok-closed-native', candidateHash: native.sha256(`${checkerFixture.marker}\n`), frozenCandidateRoot: frozen, writableScratchRoot: scratch, temporaryRoot: path.join(scratch, 'tmp'), outputRoot: path.join(scratch, 'output'), cacheRoot: path.join(scratch, 'cache') }
  const record = { ...checkerFixture.record, logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', workingDirectory: scratch, canonicalTargetPath: frozen, candidateHash: checker.candidateHash, checkerScratchBoundary: checker, physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } } }
  const adapter = new HarnessExecAdapter({ provider: 'grok', runner: checkerFixture.runner, nativeRoot: checkerFixture.nativeRoot, executableBinding: checkerFixture.binding, targetPath: scratch, connection: { model: 'fixture/grok', environment: { GROK_BASE_URL: checkerFixture.service.url } }, credentialEnvironment: { OPENROUTER_API_KEY: 'local-test-secret' }, rolePrompt: () => 'Use only controller checker tools.', outputSchemaResolver: () => checkerFixture.schema, checkerScratchVerifier: () => checker })
  record.environment = prepareProcessLaunchEnvironment(checkerFixture.processAdapter, record.reservationId, nativeEnvironment()); record.signal = AbortSignal.timeout(90000); record.onUsageDelta = () => ({ continue: true })
  good(await adapter.launch(record)); assert.equal(fs.readFileSync(candidate, 'utf8'), `${checkerFixture.marker}\n`); assert.equal(fs.readFileSync(path.join(scratch, 'checker.txt'), 'utf8'), 'checked')
})

capability('crash recovery drains the durable owned child', async t => {
  const crashed = await scenario(t, { calls: [] }); crashed.service.holdNext(); const pending = crashed.run({}); pending.catch(() => {})
  for (let index = 0; index < 300 && crashed.service.requests.length === 0; index++) await wait(50)
  assert.equal(crashed.owner.ownershipIdentities().length, 1)
  const recovered = new ProcessOwner({ adapter: nativeProcessAdapter(crashed.owner.registryPath, path.dirname(crashed.owner.registryPath)), registryPath: crashed.owner.registryPath, pollMs: 10 })
  await recovered.cancelAll({ reason: 'simulated Grok controller crash', graceMs: 0, killMs: 2000, waitForPending: true })
  await assert.rejects(pending, error => ['CHILD_CANCELLED', 'CHILD_RUNTIME_FAILURE', 'PROCESS_DRAIN_TIMEOUT'].includes(error.code) || /durable terminal status|controller child/i.test(error.message)); assert.deepEqual(recovered.ownershipIdentities(), [])
})

capability('model and effort reach native wire while unsupported assignment is refused', async t => {
  const f = await scenario(t, { calls: [] }); good(await f.run({ assignment: { model: 'fixture/grok', effort: 'high' } }))
  assert.ok(f.service.requests.every(request => request.authorization === 'Bearer local-test-secret' && request.body.model === 'fixture/grok'))
  const configs = []; const visit = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) visit(file); else if (item.name === 'config.toml') configs.push(fs.readFileSync(file, 'utf8')) } }; visit(f.nativeRoot)
  assert.ok(configs.some(source => source.includes('reasoning_effort="high"')))
  await assert.rejects(f.run({ reservationId: crypto.randomUUID(), assignment: { model: 'fixture/grok', effort: 'invalid-effort' } }), { code: 'PROFILE_INVALID' })
})
