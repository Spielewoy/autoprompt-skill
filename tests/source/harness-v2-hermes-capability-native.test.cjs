'use strict'
// Native Hermes capability probes. The localhost server selects tool calls;
// Hermes owns its real Python tool loop, SQLite journal, and child process.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
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
const CLI = process.env.AUTOPROMPT_HERMES_TEST_CLI
const options = { skip: !CLI, timeout: 300000 }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeFixture() {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-capability-native-')))
  const target = path.join(root, 'target'), controller = path.join(root, 'controller')
  privateDirectory(target); privateDirectory(controller)
  const supplied = process.env.AUTOPROMPT_CLOSED_CANARY_CHALLENGE
  if (supplied !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(supplied)) throw new Error('AUTOPROMPT_CLOSED_CANARY_CHALLENGE must be a 32-byte base64url nonce')
  const outerActivation = process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID
  const outerGeneration = process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION
  if ((outerActivation === undefined) !== (outerGeneration === undefined) ||
      (outerActivation !== undefined && (!/^[A-Za-z0-9_.:-]{1,256}$/.test(outerActivation) || !/^[1-9][0-9]*$/.test(outerGeneration) || !Number.isSafeInteger(Number(outerGeneration))))) {
    throw new Error('closed canary activation binding is invalid')
  }
  const challenge = supplied || crypto.randomBytes(32).toString('base64url')
  const projection = core.createCanonicalMissionProjection('FIRST_CONTEXT_SENTINEL: use exactly one assigned controller tool.\nCLOSED_CANARY_CHALLENGE: ' + challenge)
  const record = { activationId: outerActivation || 'hermes-closed-native-canary', generation: outerGeneration === undefined ? 1 : Number(outerGeneration), sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'hermes-capability', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', canonicalMission: projection.canonicalMission, workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256('hermes-capability:' + challenge) } } }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.physicalExecutionPolicy = { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }
  const schema = path.join(controller, 'result.schema.json')
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true }, resumed: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }), { mode: 0o600 })
  return { root, target, controller, nativeRoot: path.join(controller, 'native'), projection, record, schema, challenge }
}
function chunk(tool) {
  return { id: 'hermes-tool', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + crypto.randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, finish_reason: null }] }
}
function final(text, stop) { return { id: 'hermes-final', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [{ index: 0, delta: text === null ? {} : { role: 'assistant', content: text }, finish_reason: stop || null }] } }
function tokens(input, output) { return { id: 'hermes-usage', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } } }
async function modelService(config) {
  const requests = []
  const emittedToolNames = []
  const server = http.createServer((request, response) => {
    let bytes = ''
    request.on('data', part => { bytes += part })
    request.on('end', () => {
      if (!request.url.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return }
      let body; try { body = JSON.parse(bytes) } catch { response.writeHead(400); response.end(); return }
      requests.push(body)
      const hasTool = body.messages.some(message => message.role === 'tool')
      if (!hasTool && config.hold) return
      if (hasTool && config.holdFinal) {
        config.finalHeld?.()
        config.releaseFinal.then(() => send())
        return
      }
      send()
      function send() {
      const responseId = 'hermes-response-' + crypto.randomUUID()
      if (!hasTool) emittedToolNames.push(config.tool.name)
      const events = hasTool
        ? [final(JSON.stringify({ ok: true, resumed: JSON.stringify(body.messages).includes('FIRST_CONTEXT_SENTINEL') })), final(null, 'stop'), tokens(19, 7)]
        : [chunk(config.tool), final(null, 'tool_calls'), tokens(11, 5)]
      for (const event of events) event.id = responseId
      const wire = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n'
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(wire) }); response.end(wire)
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, requests, emittedToolNames, port: server.address().port, tool: config.tool }
}
function ownership(f) {
  const makeOwner = registryPath => new ProcessOwner({ adapter: nativeProcessAdapter(registryPath, path.dirname(registryPath)), registryPath, pollMs: 10 })
  const root = process.env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT
  if (!root) return makeOwner(path.join(f.controller, 'processes.json'))
  if (!path.isAbsolute(root) || process.env.AUTOPROMPT_CLOSED_CANARY_PROVIDER !== 'hermes' || process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID !== f.record.activationId || process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION !== String(f.record.generation)) throw new Error('closed canary ownership registration binding is invalid')
  const directory = privateDirectory(path.join(root, 'hermes-' + crypto.randomUUID())), registryPath = path.join(directory, 'processes.json')
  fs.writeFileSync(path.join(directory, 'registration.json'), JSON.stringify({ schemaVersion: 1, provider: 'hermes', activationId: f.record.activationId, generation: f.record.generation, challenge: f.challenge, registryPath }), { flag: 'wx', mode: 0o600 })
  return makeOwner(registryPath)
}
function scratchFor(f, record) { record ||= f.record; return path.join(f.nativeRoot, 'hermes', native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch') }
function toolsFor(f, record) { record ||= f.record; return path.join(f.nativeRoot, 'hermes', native.sha256(record.sessionId), native.sha256(record.reservationId), 'tool-control') }
function hermesMessages(f) {
  const db = path.join(f.nativeRoot, 'hermes', native.sha256(f.record.sessionId), 'state.db')
  assert.ok(fs.existsSync(db), 'Hermes did not persist its native session journal')
  const closureRoot = path.dirname(path.dirname(CLI)), manifestFile = path.join(closureRoot, '.autoprompt-hermes-linux-closure.json')
  let python
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), relative = manifest?.entrypoint?.python
    assert.equal(manifest?.kind, 'autoprompt-hermes-linux-closure-v1', 'Hermes closure manifest is not the expected portable format')
    assert.equal(manifest?.provider, 'hermes', 'Hermes closure manifest provider changed')
    assert.equal(typeof relative, 'string', 'Hermes closure has no Python wrapper binding')
    assert.equal(path.isAbsolute(relative), false, 'Hermes closure Python wrapper must be relative')
    assert.equal(relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..'), false, 'Hermes closure Python wrapper is unsafe')
    python = path.join(closureRoot, relative)
    const stat = fs.lstatSync(python)
    assert.equal(stat.isFile(), true, 'Hermes closure Python wrapper is missing')
    assert.equal(stat.isSymbolicLink(), false, 'Hermes closure Python wrapper must be physical')
  } else {
    const launcher = fs.readFileSync(CLI, 'utf8').slice(0, 512)
    python = /^#!([^\r\n\s]+)/.exec(launcher)?.[1]
  }
  assert.ok(python && path.isAbsolute(python), 'pinned Hermes launcher has no absolute Python binding')
  const script = "import json,sqlite3,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(json.dumps(c.execute('select role,content from messages order by id').fetchall()))"
  const result = cp.spawnSync(python, ['-c', script, db], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
async function scenario(t, config = {}) {
  assert.ok(CLI, 'AUTOPROMPT_HERMES_TEST_CLI is required')
  const sandbox = await boundary.probeCommandSandbox(); assert.equal(sandbox.supported, true, JSON.stringify(sandbox))
  const f = makeFixture(); privateDirectory(f.nativeRoot)
  const candidate = path.join(f.target, 'candidate.txt'), secret = path.join(f.controller, 'private.txt'), marker = 'hermes-native-capability-' + crypto.randomUUID(), scratch = scratchFor(f)
  fs.writeFileSync(candidate, marker, { mode: 0o600 }); fs.writeFileSync(secret, 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE', { mode: 0o600 }); fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD', { mode: 0o600 })
  const values = { ...f, candidate, secret, marker, scratch }
  const original = typeof config.command === 'function' ? config.command(values) : config.command || readCommand(candidate)
  const command = withChallenge(original, f.challenge)
  let releaseFinal; const finalReleased = new Promise(resolve => { releaseFinal = resolve }); let heldFinal
  const finalHeld = new Promise(resolve => { heldFinal = resolve })
  const service = await modelService({ tool: config.tool || { name: 'autoprompt_owned_bash', args: { command } }, hold: config.hold, holdFinal: config.holdFinal, releaseFinal: finalReleased, finalHeld: () => heldFinal() })
  service.releaseFinal = releaseFinal; service.finalHeld = finalHeld
  const binding = native.probeExecutable({ provider: 'hermes', executable: CLI, env: { PATH: process.env.PATH } })
  const owner = ownership(f), processAdapter = owner.adapter
  const proxy = privateDirectory(path.join(f.controller, 'proxy'))
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: 'hermes-closed-native-canary', pollMs: 10 })
  const adapter = new HarnessExecAdapter({ provider: 'hermes', runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target, connection: { model: 'fixture/model', modelProvider: 'custom', environment: { HERMES_BASE_URL: 'http://127.0.0.1:' + service.port + '/v1' } }, credentialEnvironment: { OPENROUTER_API_KEY: '<local-test-only>' }, outputSchemaResolver: () => f.schema, rolePrompt: () => 'Use only assigned controller tools and return one JSON object.' })
  const run = async (overrides = {}) => {
    const record = { ...f.record, ...overrides }
    record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, { ...nativeEnvironment(), PATH: path.dirname(CLI) + path.delimiter + (process.env.PATH || ''), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
    record.signal = overrides.signal || AbortSignal.timeout(120000)
    const result = await adapter.launch(record)
    assert.ok(service.requests.some(request => JSON.stringify(request.messages).includes('CLOSED_CANARY_CHALLENGE:' + f.challenge)), 'actual Hermes controller output omitted canary challenge')
    return result
  }
  t.after(async () => { await cleanupNativeFixture(f, 'hermes', { stop: () => owner.cancelAll({ reason: 'hermes native capability cleanup', graceMs: 0, killMs: 2000, waitForPending: true }), close: async () => { service.server.closeAllConnections?.(); await new Promise(resolve => service.server.close(resolve)) } }) })
  return { ...values, service, binding, owner, adapter, processAdapter, run }
}
function successful(result, expectedReceipts = 1) {
  assert.equal(result.ok, true); assert.match(result.contextId, /^[A-Za-z0-9_.:-]{1,256}$/)
  assert.ok(result.transportEvidence.eventCount >= 3, JSON.stringify(result.transportEvidence)); assert.match(result.transportEvidence.eventStreamHash, /^[a-f0-9]{64}$/)
  assert.equal(result.toolBoundaryEvidence.receiptHashes.length, expectedReceipts)
}
function receipt(f, result, record) {
  const root = toolsFor(f, record), directories = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => path.join(root, item.name))
  assert.equal(directories.length, 1)
  const values = boundary.readReceipts({ policyPath: path.join(directories[0], 'policy.json'), policySha256: result.toolBoundaryEvidence.policySha256 })
  assert.equal(values.length, 1); assert.equal(values[0].hash, result.toolBoundaryEvidence.receiptHashes[0]); return values[0]
}
function sibling(f, label) {
  const id = { sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: label }
  return { ...id, missionBinding: core.bindCanonicalMissionForChild(f.projection, { ...f.record, ...id, sourceRequestHash: f.projection.sourceRequestHash, requestEnvelopeHash: f.record.dispatch.requestPointer.hash }) }
}

test('hermes closed native capability: isolation denies candidate/private/network while allowing scratch', options, async t => {
  let contacted = false; const listener = net.createServer(socket => { contacted = true; socket.destroy() })
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  try {
    const port = listener.address().port
    const f = await scenario(t, { command: values => {
      const network = "const n=require('node:net');const s=n.connect(" + port + ",'127.0.0.1');s.on('connect',()=>process.exit(19));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),700)"
      return readCommand(values.candidate) + '; ' + nodeCommand("require('node:fs').writeFileSync(" + JSON.stringify(path.join(values.scratch, 'isolation.txt')) + ",'scratch-ok'); try { require('node:fs').writeFileSync(" + JSON.stringify(values.candidate) + ",'forbidden'); process.exit(18) } catch {} ; try { require('node:fs').readFileSync(" + JSON.stringify(values.secret) + "); process.exit(20) } catch {} ; " + network)
    } })
    const result = await f.run({}); successful(result)
    assert.equal(fs.readFileSync(f.candidate, 'utf8'), f.marker); assert.equal(fs.readFileSync(path.join(f.scratch, 'isolation.txt'), 'utf8'), 'scratch-ok'); assert.equal(contacted, false, 'controller command sandbox reached host network')
    const r = receipt(f, result); assert.equal(r.status, 'completed'); assert.equal(r.exitCode, 0)
  } finally { await new Promise(resolve => listener.close(resolve)) }
})
test('hermes closed native capability: topology rejects injected nested tool and admits controller edge', options, async t => {
  const hostile = await scenario(t, { tool: { name: 'Task', args: { prompt: 'unauthorized nested dispatch' } } })
  // Hermes has no Task registration in the fixed plugin.  It cannot turn this
  // injected model call into a controller request, so the owned launch is
  // cancelled instead of treating an unregistered tool as a successful turn.
  const controller = new AbortController(), pending = hostile.run({ signal: controller.signal })
  // Do not allow an assertion before the expected owned-child rejection to
  // publish a detached unhandled rejection after this test has already ended.
  void pending.catch(() => {})
  try {
    for (let index = 0; index < 1600 && hostile.service.requests.length === 0; index++) await wait(25)
    assert.ok(hostile.service.requests.length > 0, 'the hostile model response was never delivered to the real Hermes loop')
    assert.deepEqual(hostile.service.emittedToolNames, ['Task'], 'fixture did not deliver the injected nested tool to Hermes')
    const toolRoot = toolsFor(hostile), directories = fs.readdirSync(toolRoot, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => path.join(toolRoot, item.name))
    assert.equal(directories.length, 1)
    const policy = JSON.parse(fs.readFileSync(path.join(directories[0], 'policy.json'), 'utf8'))
    const denied = boundary.readReceipts({ policyPath: path.join(directories[0], 'policy.json'), policySha256: native.sha256(boundary.canonicalJson(policy)) })
    assert.deepEqual(denied, [], 'injected Task must not create a controller execution receipt')
    assert.equal(fs.readFileSync(hostile.candidate, 'utf8'), hostile.marker, 'injected Task changed the candidate')
    await wait(500)
    const journal = hermesMessages(hostile), journalText = JSON.stringify(journal)
    assert.match(journalText, /Task/, 'Hermes journal omitted the delivered nested-tool request')
    assert.match(journalText, /(?:does not exist|unknown|not found|not registered|unavailable|invalid tool)/i, 'Hermes journal omitted its native denial for Task')
    await assert.rejects(pending, error => ['TOOL_RECEIPT_INVALID', 'CHILD_RUNTIME_FAILURE'].includes(error.code))
  } finally {
    controller.abort()
    await pending.catch(() => {})
    await hostile.owner.cancelAll({ reason: 'topology hostile launch cleanup', graceMs: 0, killMs: 2000, waitForPending: true })
  }
  const f = await scenario(t, { command: values => readCommand(values.candidate) }); const result = await f.run({}); successful(result)
  const names = f.service.requests.flatMap(request => request.tools || []).map(tool => tool.function?.name || tool.name)
  assert.ok(names.includes('autoprompt_owned_bash'), JSON.stringify(names)); assert.equal(names.some(name => /^(?:Task|Agent|Skill|tool_search)$/i.test(name)), false)
})
test('hermes closed native capability: ambient configuration skills and hooks stay absent', options, async t => {
  const f = await scenario(t, { command: values => readCommand(values.candidate) })
  privateDirectory(path.join(f.target, '.hermes')); fs.writeFileSync(path.join(f.target, '.hermes', 'config.yaml'), 'hooks: [AMBIENT_HOOK_MUST_NOT_LOAD]\nskills: [AMBIENT_SKILL_MUST_NOT_LOAD]\n', { mode: 0o600 })
  const result = await f.run({}); successful(result); const wire = JSON.stringify(f.service.requests)
  for (const sentinel of ['AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD', 'AMBIENT_HOOK_MUST_NOT_LOAD', 'AMBIENT_SKILL_MUST_NOT_LOAD', 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE']) assert.equal(wire.includes(sentinel), false, sentinel)
})
test('hermes closed native capability: real intermediate tool journal event is correlated before final response', options, async t => {
  const f = await scenario(t, { command: values => readCommand(values.candidate), holdFinal: true }), raw = [], ids = []
  let settled = false
  const pending = f.run({ onEvent: event => raw.push(event), onSessionIdentified: id => ids.push(id) }).then(value => { settled = true; return value })
  await Promise.race([f.service.finalHeld, wait(90000).then(() => { throw new Error('Hermes never held its post-tool final response') })])
  for (let index = 0; index < 200 && !raw.some(event => event.event === 'intermediate' && event.role === 'tool' && event.content.includes('CLOSED_CANARY_CHALLENGE:' + f.challenge)); index++) await wait(100)
  const intermediate = raw.find(event => event.event === 'intermediate' && event.role === 'tool' && event.content.includes('CLOSED_CANARY_CHALLENGE:' + f.challenge))
  assert.ok(intermediate, JSON.stringify(raw)); assert.equal(settled, false); assert.equal(ids.length, 1); assert.equal(ids[0], intermediate.sessionId)
  f.service.releaseFinal(); const result = await pending; successful(result)
  assert.equal(result.contextId, intermediate.sessionId); assert.ok(raw.some(event => event.event === 'final' && event.sessionId === result.contextId)); assert.ok(fs.existsSync(path.join(f.nativeRoot, 'contexts', native.sha256(result.contextId) + '.json')))
})
test('hermes closed native capability: exact controller output bytes bind to receipt', options, async t => {
  const f = await scenario(t, { command: values => nodeCommand("process.stdout.write('exact:')") + '; ' + readCommand(values.candidate) }); const result = await f.run({}); successful(result)
  const r = receipt(f, result), tool = f.service.requests.flatMap(request => request.messages).find(message => message.role === 'tool')
  const content = typeof tool?.content === 'string' ? tool.content : tool?.content?.map(part => part.text || '').join('')
  const nativeResult = JSON.parse(content)
  assert.match(nativeResult.output, new RegExp('exact:' + f.marker + '\\nCLOSED_CANARY_CHALLENGE:' + f.challenge + '\\n$'))
  assert.equal(r.outputSha256, native.sha256(nativeResult.output)); assert.equal(r.status, 'completed'); assert.equal(r.exitCode, 0)
})
test('hermes closed native capability: concurrent siblings keep separate identities', options, async t => {
  const f = await scenario(t, { command: values => nodeCommand('setTimeout(() => {}, 1000)') + '; ' + readCommand(values.candidate) }); let peak = 0
  const monitor = setInterval(() => { peak = Math.max(peak, f.owner.ownershipIdentities().length) }, 5)
  let values; try { values = await Promise.all([f.run(sibling(f, 'hermes-sibling-a')), f.run(sibling(f, 'hermes-sibling-b'))]) } finally { clearInterval(monitor) }
  values.forEach(value => successful(value)); assert.equal(new Set(values.map(value => value.contextId)).size, 2); assert.ok(peak >= 2, 'owned sibling processes did not overlap'); assert.deepEqual(f.owner.ownershipIdentities(), [])
})
test('hermes closed native capability: continuation resumes and foreign target is denied', options, async t => {
  const f = await scenario(t, { command: values => readCommand(values.candidate) }); const first = await f.run({}); successful(first)
  const resumed = await f.run({ reservationId: crypto.randomUUID(), continuationId: first.contextId }); successful(resumed, 0); assert.equal(resumed.contextId, first.contextId)
  const foreign = privateDirectory(path.join(f.root, 'foreign'))
  await assert.rejects(f.adapter.launch({ ...f.record, reservationId: crypto.randomUUID(), continuationId: first.contextId, workingDirectory: foreign, environment: prepareProcessLaunchEnvironment(f.processAdapter, crypto.randomUUID(), nativeEnvironment()), signal: AbortSignal.timeout(30000) }), { code: 'SESSION_ID_MISMATCH' })
})
test('hermes closed native capability: cancellation drains held child while sibling succeeds', options, async t => {
  const held = await scenario(t, { command: values => readCommand(values.candidate), hold: true }), controller = new AbortController(), pending = held.run({ signal: controller.signal })
  for (let index = 0; index < 800 && held.service.requests.length === 0; index++) await wait(25)
  assert.ok(held.service.requests.length > 0, 'held child did not reach a real model request')
  const fast = await scenario(t, { command: values => readCommand(values.candidate) }); const result = await fast.run({}); successful(result)
  controller.abort(); await assert.rejects(pending, { code: 'CHILD_CANCELLED' }); assert.deepEqual(held.owner.ownershipIdentities(), []); assert.equal(result.ok, true)
})
test('Hermes owned adapter retains authentic usage arriving during cancellation drain', options, async t => {
  const f = await scenario(t, { holdFinal: true }), controller = new AbortController()
  const runner = f.adapter.runner, originalRun = runner.run.bind(runner)
  let cancelledAtUsage = false, terminals = 0
  const debits = []
  // Keep the real process owner, wrapper, database, and model service. Arrange
  // cancellation at the exact delivery boundary so a periodic poll cannot
  // hide the adapter's obligation to account for drain-time stdout.
  runner.run = spec => originalRun({ ...spec, onStdoutLine: line => {
    let event; try { event = JSON.parse(line) } catch {}
    if (!cancelledAtUsage && event?.type === 'hermes' && event.event === 'usage' && event.usage?.input > 0) {
      cancelledAtUsage = true
      controller.abort()
    }
    spec.onStdoutLine(line)
  } })
  await assert.rejects(f.run({ signal: controller.signal,
    onUsageDelta: usage => debits.push(usage), onTerminalResult: () => { terminals++ },
  }), { code: 'CHILD_CANCELLED' })
  assert.equal(cancelledAtUsage, true)
  assert.ok(debits.length > 0, 'exact native usage was lost after cancellation')
  assert.equal(debits.reduce((total, usage) => total + usage.noncachedInput, 0), 11)
  assert.equal(debits.reduce((total, usage) => total + usage.output, 0), 5)
  assert.equal(terminals, 0)
  assert.deepEqual(f.owner.ownershipIdentities(), [])
})
test('hermes closed native capability: independent checker freezes candidate and writes scratch', options, async t => {
  const f = await scenario(t, { command: values => readCommand(values.candidate) }), frozen = path.join(f.root, 'frozen'), scratch = path.join(f.root, 'checker-scratch')
  privateDirectory(frozen); privateDirectory(scratch); for (const name of ['tmp', 'output', 'cache']) privateDirectory(path.join(scratch, name))
  const candidate = path.join(frozen, 'candidate.txt'); fs.writeFileSync(candidate, f.marker, { mode: 0o600 })
  const checker = { schemaVersion: 1, capability: native.sha256('hermes-native-checker-boundary'), runId: 'hermes-native-checker', checkerId: 'hermes-closed-native', candidateHash: native.sha256(f.marker), frozenCandidateRoot: frozen, writableScratchRoot: scratch, temporaryRoot: path.join(scratch, 'tmp'), outputRoot: path.join(scratch, 'output'), cacheRoot: path.join(scratch, 'cache') }
  f.service.tool.args.command = withChallenge(readCommand(candidate) + '; ' + nodeCommand("require('node:fs').writeFileSync(" + JSON.stringify(path.join(scratch, 'checker.txt')) + ",'checked'); try { require('node:fs').writeFileSync(" + JSON.stringify(candidate) + ",'wrong'); process.exit(19) } catch {}"), f.challenge)
  const record = { ...f.record, logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', workingDirectory: scratch, canonicalTargetPath: frozen, candidateHash: checker.candidateHash, checkerScratchBoundary: checker, physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } } }
  const adapter = new HarnessExecAdapter({ provider: 'hermes', runner: f.adapter.runner, nativeRoot: f.nativeRoot, executableBinding: f.binding, targetPath: scratch, connection: f.adapter.connection, credentialEnvironment: { OPENROUTER_API_KEY: '<local-test-only>' }, outputSchemaResolver: () => f.schema, rolePrompt: () => 'Use only controller checker tools.', checkerScratchVerifier: () => checker })
  record.environment = prepareProcessLaunchEnvironment(f.processAdapter, record.reservationId, nativeEnvironment()); record.signal = AbortSignal.timeout(120000)
  const result = await adapter.launch(record); successful(result); assert.equal(fs.readFileSync(candidate, 'utf8'), f.marker); assert.equal(fs.readFileSync(path.join(scratch, 'checker.txt'), 'utf8'), 'checked')
})
test('hermes closed native capability: durable owner recovery drains live crashed controller child', options, async t => {
  const f = await scenario(t, { command: values => readCommand(values.candidate), hold: true }), pending = f.run({})
  for (let index = 0; index < 800 && f.service.requests.length === 0; index++) await wait(25)
  assert.equal(f.owner.ownershipIdentities().length, 1, 'live native child was not durably registered')
  const recovered = new ProcessOwner({ adapter: nativeProcessAdapter(path.join(f.controller, 'processes.json'), f.controller), registryPath: path.join(f.controller, 'processes.json'), pollMs: 10 })
  await recovered.cancelAll({ reason: 'simulated controller crash recovery', graceMs: 0, killMs: 2000, waitForPending: true })
  await assert.rejects(pending)
  await f.owner.cancelAll({ reason: 'confirm original live-owner drain after recovery', graceMs: 0, killMs: 2000, waitForPending: true })
  assert.deepEqual(recovered.ownershipIdentities(), []); assert.deepEqual(f.owner.ownershipIdentities(), [])
})
test('hermes closed native capability: model effort is wired and unsupported effort is denied', options, async t => {
  const f = await scenario(t, { command: values => readCommand(values.candidate) }); const result = await f.run({ assignment: { model: 'fixture/model', effort: 'high' } }); successful(result)
  assert.ok(f.service.requests.every(request => request.model === 'fixture/model'), JSON.stringify(f.service.requests.map(request => request.model)))
  const specs = []; const visit = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) visit(file); else if (item.name === 'autoprompt-hermes-launch.json') specs.push(file) } }; visit(f.nativeRoot)
  assert.ok(specs.some(file => JSON.parse(fs.readFileSync(file, 'utf8')).argv.includes('high')), 'native launch omitted --reasoning high')
  await assert.rejects(f.run({ assignment: { model: 'fixture/model', effort: 'unauthorized' } }), { code: 'PROFILE_INVALID' })
})

test('hermes native durable quota settles each tool turn exactly once', { skip: options.skip, timeout: 180000 }, async t => {
  const f = await scenario(t)

  const starts = [], settlements = [], debits = [], unknown = []
  const upstream = f.adapter.connection.environment.HERMES_BASE_URL
  const nativeFetch = global.fetch, outbound = []
  // Hermes itself sees the reservation-private loopback URL, while this
  // in-process relay fetch intercept proves that the production OpenRouter
  // projection reaches the actual upstream wire with its bound low effort.
  f.adapter.connection = { ...f.adapter.connection, environment: { HERMES_BASE_URL: 'https://openrouter.ai/api/v1' } }
  global.fetch = async (target, init) => {
    assert.equal(String(target), 'https://openrouter.ai/api/v1/chat/completions')
    outbound.push(JSON.parse(init.body))
    return nativeFetch(`${upstream}/chat/completions`, init)
  }
  let result
  try {
    result = await f.run({ assignment: { model: f.adapter.connection.model, effort: 'low' }, providerTokenLimit: 100000, finiteTokenBudget: false,
      onProviderRequestStarted: value => starts.push(value),
      onProviderRequestSettled: value => settlements.push(value),
      onUnknownProviderSpend: value => unknown.push(value),
      onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } },
    })
  } finally { global.fetch = nativeFetch }
  assert.equal(result.ok, true)
  assert.equal(starts.length, 2)
  assert.equal(settlements.length, 2)
  assert.equal(debits.length, 2)
  assert.equal(unknown.length, 0)
  assert.ok(f.service.requests.every(request => request.max_tokens === 4096), 'Hermes omitted the finite controller output cap')
  assert.ok(outbound.length === 2 && outbound.every(request => request.reasoning?.enabled === true && request.reasoning?.effort === 'low'),
    JSON.stringify(outbound.map(request => request.reasoning)))
  assert.deepEqual(result.usage, debits.at(-1).cumulative)
  for (let index = 0; index < 2; index++) {
    assert.equal(debits[index].evidence.requestOrdinal, index + 1)
    assert.equal(settlements[index].disposition, 'ACCOUNTED')
  }
})
