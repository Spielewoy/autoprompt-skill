'use strict'

// Eleven independent capability probes against the installed VS Code extension
// host. The localhost endpoint only chooses deterministic model turns; the
// extension host, owned provider, controlled tools, receipt journal, context
// persistence, and ProcessOwner are all production code.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { privateDirectory, nativeProcessAdapter, nativeEnvironment, nodeCommand, readCommand } = require('../helpers/native-platform.cjs')
const { fixture } = require('./harness-v2-vscode-owned-native.test.cjs')

const CLI = process.env.AUTOPROMPT_VSCODE_TEST_CLI
const enabled = Boolean(CLI)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function ownedErrorDiagnostic(event) {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(event?.code || '') ? event.code : 'CHILD_RUNTIME_FAILURE'
  const message = String(event?.message || '')
    .replace(/\b(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET)|AUTHORIZATION)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gu, 'Bearer <redacted>')
    .replace(/[A-Za-z]:\\(?:[^\s:'"<>|?*]+\\?)+/gu, '<path>')
    .replace(/(?:\/[^\s:'"<>]+){2,}/gu, '<path>')
    .slice(0, 512)
  return Object.freeze({ code, message })
}

test('VS Code fixture error diagnostic bounds and redacts owned error details', () => {
  assert.deepEqual(ownedErrorDiagnostic({ code: 'PROFILE_INVALID', message: 'OPENAI_API_KEY=fixture-secret Bearer abcdefghijklmnop /private/controller/session.json' }), {
    code: 'PROFILE_INVALID', message: '<redacted> Bearer <redacted> <path>',
  })
  assert.deepEqual(ownedErrorDiagnostic({ code: 'not-safe', message: 'x'.repeat(700) }), {
    code: 'CHILD_RUNTIME_FAILURE', message: 'x'.repeat(512),
  })
})

function sessionDriverDiagnostic(f, record) {
  // This is the one fixed journal location derived from the authenticated
  // owned-request parent. Do not walk the fixture tree or expose its paths.
  const file = path.join(f.nativeRoot, 'vscode', native.sha256(record.sessionId), native.sha256(record.reservationId), 'home', 'session-driver-phase.jsonl')
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) return { state: 'invalid' }
    const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    if (!entries.length || entries.length > 32 || entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !['entry', 'beforeactivation', 'afteractivation', 'channelconnected', 'runSession', 'complete', 'error', 'before-session-setup', 'after-session-persist', 'before-model-select', 'after-model-select',
        'before-model-request', 'after-model-request', 'after-tool-event', 'after-tool-persist',
        'first-before-model-request', 'first-after-model-request', 'next-before-model-request', 'next-after-model-request',
        'first-provider-enter', 'first-provider-before-fetch', 'first-provider-after-headers', 'first-provider-after-body',
        'next-provider-enter', 'next-provider-before-fetch', 'next-provider-after-headers', 'next-provider-after-body'].includes(entry.stage) ||
      (entry.stage === 'error' && !/^[A-Z][A-Z0-9_]{0,63}$/.test(entry.code || '')) ||
      Object.keys(entry).sort().join('\0') !== (entry.stage === 'error' ? 'code\0stage' : 'stage'))) return { state: 'invalid' }
    return { state: 'present', stages: entries.map(entry => entry.stage === 'error' ? `error:${entry.code}` : entry.stage) }
  } catch (error) { return error?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' } }
}

function closedBinding() {
  const fields = ['AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT', 'AUTOPROMPT_CLOSED_CANARY_PROVIDER', 'AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID', 'AUTOPROMPT_CLOSED_CANARY_GENERATION', 'AUTOPROMPT_CLOSED_CANARY_CHALLENGE']
  const value = Object.fromEntries(fields.map(name => [name, process.env[name]]))
  if (!fields.some(name => value[name] !== undefined)) return null
  if (fields.some(name => typeof value[name] !== 'string' || !value[name]) || value.AUTOPROMPT_CLOSED_CANARY_PROVIDER !== 'vscode' || !path.isAbsolute(value.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT) || !/^[1-9][0-9]*$/.test(value.AUTOPROMPT_CLOSED_CANARY_GENERATION) || !/^[A-Za-z0-9_-]{43}$/.test(value.AUTOPROMPT_CLOSED_CANARY_CHALLENGE)) throw new Error('closed canary VS Code binding is invalid')
  const stat = fs.statSync(value.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT)
  if (!stat.isDirectory() || stat.mode & 0o077) throw new Error('closed canary VS Code ownership root is not private')
  return { root: value.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT, activationId: value.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID, generation: Number(value.AUTOPROMPT_CLOSED_CANARY_GENERATION), challenge: value.AUTOPROMPT_CLOSED_CANARY_CHALLENGE }
}

function reply(res, body, first) {
  const model = body.model || 'fixture-vscode-model'
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: `vscode-capability-${crypto.randomUUID()}`, model,
    choices: [{ index: 0, finish_reason: first ? 'tool_calls' : 'stop', message: first ? {
      role: 'assistant', content: '', tool_calls: [first],
    } : { role: 'assistant', content: '{"ok":true}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 2 } },
  }))
}

function hasToolResult(body) { return Array.isArray(body.messages) && body.messages.some(message => message?.role === 'tool') }
function scratchFor(f, record = f.record) { return path.join(f.nativeRoot, 'vscode', native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch') }
function toolRootFor(f, record = f.record) { return path.join(f.nativeRoot, 'vscode', native.sha256(record.sessionId), native.sha256(record.reservationId), 'tool-control') }
// The fixture's original record does not expose its projection. Rebind from a
// new canonical projection, matching the launch data before a sibling starts.
function siblingRecord(f, name) {
  const id = { sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: name }
  const projection = core.createCanonicalMissionProjection('Read the assigned candidate and return {"ok":true}.')
  return { ...f.record, ...id, missionBinding: core.bindCanonicalMissionForChild(projection, { ...f.record, ...id, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: f.record.dispatch.requestPointer.hash }) }
}

function receipt(f, result, record = f.record) {
  const root = toolRootFor(f, record)
  const directories = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))
  assert.equal(directories.length, 1, `one private tool policy for ${record.reservationId}`)
  const values = boundary.readReceipts({ policyPath: path.join(directories[0], 'policy.json'), policySha256: result.toolBoundaryEvidence.policySha256 })
  return values
}

async function scenario(t, options = {}) {
  const challenge = closedBinding()?.challenge || crypto.randomBytes(32).toString('base64url')
  const seen = []
  let holdConsumed = false
  const f = await fixture(t, { respond: async value => {
    const { req, res, body } = value
    seen.push({ body, authorization: req.headers.authorization })
    if (options.gate) await options.gate({ ...value, number: seen.length })
    if (options.hold && !holdConsumed && !hasToolResult(body)) {
      holdConsumed = true
      await new Promise(resolve => { req.once('aborted', resolve); res.once('close', resolve) })
      return
    }
    const first = !options.noTools && !hasToolResult(body)
    const tool = first ? { id: `vscode-tool-${crypto.randomUUID()}`, type: 'function', function: { name: options.toolName || 'autoprompt_owned_bash', arguments: JSON.stringify({ command: typeof options.command === 'function' ? options.command(f, challenge) : (options.command || readCommand(path.join(f.target, 'candidate.txt'))) }) } } : null
    reply(res, body, tool)
  } })
  f.challenge = challenge
  f.seen = seen
  f.processAdapter = f.runner.processOwner.adapter
  f.registryPath = f.runner.processOwner.registryPath
  const original = f.execution.checkerScratchVerifier
  f.execution.checkerScratchVerifier = record => record.checkerScratchBoundary || original?.(record)
  f.run = async (overrides = {}) => {
    const record = { ...f.record, ...overrides }
    const startedAt = Date.now()
    const failedTools = [], eventTypes = [], eventTimings = [], ownedErrors = [], originalEvent = record.onEvent
    record.onEvent = (event, raw) => {
      if (typeof event?.type === 'string') {
        eventTypes.push(event.type.slice(0, 96))
        if (eventTypes.length > 8) eventTypes.shift()
        eventTimings.push({ type: event.type.slice(0, 96), elapsedMs: Date.now() - startedAt })
        if (eventTimings.length > 16) eventTimings.shift()
      }
      if (event?.type === 'owned.tool.end' && event.error === true) {
        failedTools.push({ id: event.id, output: String(event.output || '').slice(0, 4096) })
        if (failedTools.length > 4) failedTools.shift()
      }
      if (event?.type === 'owned.error') {
        ownedErrors.push(ownedErrorDiagnostic(event))
        if (ownedErrors.length > 2) ownedErrors.shift()
      }
      originalEvent?.(event, raw)
    }
    record.environment = prepareProcessLaunchEnvironment(f.processAdapter, record.reservationId, {
      ...nativeEnvironment(),
      ...Object.fromEntries(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'].filter(name => process.env[name]).map(name => [name, process.env[name]])),
    })
    record.signal = overrides.signal || AbortSignal.timeout(options.runTimeoutMs || 120000)
    try { return await f.execution.launch(record) } catch (error) {
      // The runner's durable transcript remains private under the fixture root.
      // Emit bounded raw bytes only for failed native probes, so CI can distinguish
      // a provider startup failure from a controller-side classification.
      t.diagnostic(JSON.stringify({ vscodeNativeFailure: { code: error?.code || null, message: error?.message || String(error), failedTools, ownedErrors, lastEventTypes: eventTypes, sessionDriver: sessionDriverDiagnostic(f, record), proxy: f.proxyDiagnostic() } }))
      throw error
    } finally {
      t.diagnostic(JSON.stringify({ vscodeNativeTiming: { elapsedMs: Date.now() - startedAt, modelRequests: seen.length, events: eventTimings } }))
    }
  }
  return f
}

function good(result) {
  assert.equal(result.ok, true)
  assert.match(result.contextId, /^vscode-owned-[a-f0-9-]{36}$/)
  assert.ok(result.transportEvidence.eventCount >= 3, JSON.stringify(result.transportEvidence))
  assert.match(result.transportEvidence.eventStreamHash, /^[a-f0-9]{64}$/)
}

test('vscode native capability isolation', { skip: !enabled, timeout: 420000 }, async t => {
  let contacted = false
  const listener = net.createServer(socket => { contacted = true; socket.destroy() })
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  try {
    // This probe includes a cold GUI host, fresh native sandbox admission,
    // and the tool round trip. CI134 reached the controlled tool but the old
    // two-minute fixture cancellation cut off Windows and Intel macOS before
    // completion. Keep a bounded native budget and record phase timings.
    const f = await scenario(t, { runTimeoutMs: 300000, command: (value, challenge) => {
      const candidate = path.join(value.target, 'candidate.txt'), secret = path.join(value.controller, 'private.txt'), scratch = scratchFor(value)
      return nodeCommand(`const fs=require('node:fs'),net=require('node:net');const candidate=${JSON.stringify(candidate)},secret=${JSON.stringify(secret)};process.stdout.write(fs.readFileSync(candidate));fs.writeFileSync(${JSON.stringify(path.join(scratch, 'isolation.txt'))},'scratch-ok');try{fs.writeFileSync(candidate,'forbidden');process.exit(18)}catch{};try{fs.readFileSync(secret);process.exit(19)}catch{};let done=false;const finish=()=>{if(done)return;done=true;process.stdout.write(${JSON.stringify(`CLOSED_CANARY_CHALLENGE:${challenge}\n`)})};const socket=net.connect(${listener.address().port},'127.0.0.1');socket.on('connect',()=>process.exit(21));socket.on('error',finish);setTimeout(finish,500)`)
    } })
    fs.writeFileSync(path.join(f.target, 'candidate.txt'), 'vscode-isolation-marker')
    fs.writeFileSync(path.join(f.controller, 'private.txt'), 'PRIVATE_VSCODE_CONTROLLER')
    const result = await f.run(); good(result)
    assert.equal(fs.readFileSync(path.join(f.target, 'candidate.txt'), 'utf8'), 'vscode-isolation-marker')
    assert.equal(fs.readFileSync(path.join(scratchFor(f), 'isolation.txt'), 'utf8'), 'scratch-ok')
    assert.equal(contacted, false)
    assert.equal(receipt(f, result)[0].status, 'completed')
  } finally { await new Promise(resolve => listener.close(resolve)) }
})

test('vscode native capability topologyEnforcement', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t, { toolName: 'Task', command: 'ignored' })
  await assert.rejects(f.run(), error => ['ROLE_POLICY_DENIED', 'CHILD_RUNTIME_FAILURE'].includes(error.code))
  const root = toolRootFor(f)
  const directories = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  assert.equal(directories.length, 1)
  const policy = JSON.parse(fs.readFileSync(path.join(root, directories[0].name, 'policy.json'), 'utf8'))
  const denied = boundary.readReceipts({ policyPath: path.join(root, directories[0].name, 'policy.json'), policySha256: native.sha256(boundary.canonicalJson(policy)) })
  assert.deepEqual(denied, [])
  assert.equal(fs.existsSync(path.join(f.target, 'forbidden')), false)
})

test('vscode native capability privateSkillRoot', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t)
  fs.writeFileSync(path.join(f.target, 'candidate.txt'), 'private-skill-marker')
  fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_LOAD')
  privateDirectory(path.join(f.target, '.vscode'))
  fs.writeFileSync(path.join(f.target, '.vscode', 'settings.json'), '{"autoprompt":"AMBIENT_VSCODE_SKILL_MUST_NOT_LOAD"}')
  fs.writeFileSync(path.join(f.controller, 'private.txt'), 'PRIVATE_VSCODE_CONTROLLER_MUST_NOT_LOAD')
  const result = await f.run(); good(result)
  const wire = JSON.stringify(f.seen)
  for (const value of ['AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_LOAD', 'AMBIENT_VSCODE_SKILL_MUST_NOT_LOAD', 'PRIVATE_VSCODE_CONTROLLER_MUST_NOT_LOAD']) assert.equal(wire.includes(value), false, value)
})

test('vscode native capability eventStreaming', { skip: !enabled, timeout: 180000 }, async t => {
  let releaseFinal
  const f = await scenario(t, { noTools: true, gate: async value => {
    if (value.number === 1) await new Promise(resolve => { releaseFinal = resolve })
  } }), events = [], identified = []
  t.after(() => releaseFinal?.())
  const pending = f.run({ onEvent: event => events.push(event), onSessionIdentified: id => identified.push(id) })
  pending.catch(() => {})
  for (let index = 0; index < 2400 && (!events.some(event => event.type === 'owned.session') || f.seen.length !== 1); index++) await wait(25)
  const early = events.find(event => event.type === 'owned.session')
  assert.ok(early, 'owned.session was not streamed while the real model response was held')
  assert.match(early.sessionId, /^vscode-owned-[a-f0-9-]{36}$/)
  assert.equal(f.seen.length, 1, 'the held final-model request was not observed')
  assert.equal(typeof releaseFinal, 'function')
  releaseFinal(); releaseFinal = undefined
  const result = await pending; good(result)
  assert.deepEqual(identified, [result.contextId])
  assert.equal(early.sessionId, result.contextId)
  assert.deepEqual(events.map(event => event.type), ['owned.session', 'owned.usage', 'owned.result'])
  assert.ok(events.every(event => !event.sessionId || event.sessionId === result.contextId))
})

test('vscode native capability toolOutputCapture', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t, { command: (value, challenge) => nodeCommand(`process.stdout.write(${JSON.stringify('exact-utf8:☃:é\n')}+${JSON.stringify(`CLOSED_CANARY_CHALLENGE:${challenge}\n`)})`) })
  const result = await f.run(); good(result)
  const expected = `exact-utf8:☃:é\nCLOSED_CANARY_CHALLENGE:${f.challenge}\n`
  const stored = receipt(f, result)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].outputSha256, native.sha256(expected))
  const toolRequest = f.seen.map(item => item.body).flatMap(body => body.messages || []).find(message => message.role === 'tool')
  assert.ok(toolRequest)
  assert.equal(JSON.parse(toolRequest.content).output, expected)
  assert.equal(Buffer.byteLength(JSON.parse(toolRequest.content).output), Buffer.byteLength(expected))
})

test('vscode native capability stableChildIdentity', { skip: !enabled, timeout: 180000 }, async t => {
  const releases = [], arrivals = []
  const f = await scenario(t, { noTools: true, gate: async value => {
    if (value.number > 2) return
    arrivals.push(value.number)
    await new Promise(resolve => releases.push(resolve))
  } })
  let peak = 0
  const monitor = setInterval(() => { peak = Math.max(peak, f.runner.processOwner.ownershipIdentities().length) }, 5)
  try {
    const first = f.run({ onSessionIdentified: id => { f.firstContext = id } })
    const second = f.run(siblingRecord(f, 'vscode-overlap-sibling'))
    for (let index = 0; index < 2400 && arrivals.length < 2; index++) await wait(25)
    assert.equal(arrivals.length, 2, 'two actual owned extension hosts did not reach the model endpoint')
    while (releases.length) releases.shift()()
    const values = await Promise.all([first, second]); values.forEach(good)
    assert.notEqual(values[0].contextId, values[1].contextId)
    assert.ok(peak >= 2, `overlap peak was ${peak}`)
    assert.deepEqual(f.runner.processOwner.ownershipIdentities(), [])
  } finally { clearInterval(monitor); while (releases.length) releases.shift()() }
})

test('vscode native capability sameContextContinuation', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t)
  const first = await f.run(); good(first)
  const resumed = await f.run({ reservationId: crypto.randomUUID(), continuationId: first.contextId }); good(resumed)
  assert.equal(resumed.contextId, first.contextId)
  assert.equal(resumed.toolBoundaryEvidence.receiptHashes.length, 0)
  const foreign = privateDirectory(path.join(f.root, 'foreign'))
  await assert.rejects(f.execution.launch({ ...f.record, reservationId: crypto.randomUUID(), continuationId: first.contextId, workingDirectory: foreign,
    environment: prepareProcessLaunchEnvironment(f.processAdapter, crypto.randomUUID(), nativeEnvironment()), signal: AbortSignal.timeout(30000) }), { code: 'SESSION_ID_MISMATCH' })
})

test('vscode native capability cancellation', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t, { noTools: true, hold: true })
  const abort = new AbortController()
  const pending = f.run({ signal: abort.signal })
  // Keep the expected cancellation observed while the independent sibling is
  // still proving that its own native process remains healthy.
  pending.catch(() => {})
  for (let index = 0; index < 2400 && f.seen.length === 0; index++) await wait(25)
  assert.equal(f.seen.length, 1, 'held extension host did not issue a real local-model request')
  // The second request must stay alive while only the held reservation is cancelled.
  f.execution.connection.maxSteps = 4
  const fast = f.run(siblingRecord(f, 'vscode-fast-sibling'))
  for (let index = 0; index < 2400 && f.seen.length < 2; index++) await wait(25)
  assert.equal(f.seen.length, 2)
  abort.abort()
  const result = await fast; good(result)
  await assert.rejects(pending, { code: 'CHILD_CANCELLED' })
  assert.deepEqual(f.runner.processOwner.ownershipIdentities(), [])
})

test('vscode native capability isolatedChecking', { skip: !enabled, timeout: 180000 }, async t => {
  let frozen, scratch, candidate, checker
  const checked = await scenario(t, { command: () => nodeCommand(`const fs=require('node:fs');const candidate=${JSON.stringify(candidate)};process.stdout.write(fs.readFileSync(candidate));fs.writeFileSync(${JSON.stringify(path.join(scratch, 'checker.txt'))},'checked');try{fs.writeFileSync(candidate,'wrong');process.exit(19)}catch{}`) })
  frozen = path.join(checked.root, 'frozen'); scratch = path.join(checked.root, 'checker-scratch')
  frozen = privateDirectory(frozen); scratch = privateDirectory(scratch)
  for (const name of ['tmp', 'output', 'cache']) privateDirectory(path.join(scratch, name))
  candidate = path.join(frozen, 'candidate.txt'); fs.writeFileSync(candidate, 'frozen-vscode-candidate', { mode: 0o600 })
  checker = { schemaVersion: 1, capability: native.sha256('vscode-native-checker'), runId: 'vscode-native-checker', checkerId: 'vscode-independent', candidateHash: native.sha256('frozen-vscode-candidate'), frozenCandidateRoot: frozen, writableScratchRoot: scratch, temporaryRoot: path.join(scratch, 'tmp'), outputRoot: path.join(scratch, 'output'), cacheRoot: path.join(scratch, 'cache') }
  const record = { ...checked.record, logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', workingDirectory: scratch, canonicalTargetPath: frozen, candidateHash: checker.candidateHash, checkerScratchBoundary: checker,
    physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } } }
  const result = await checked.run(record); good(result)
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'frozen-vscode-candidate')
  assert.equal(fs.readFileSync(path.join(scratch, 'checker.txt'), 'utf8'), 'checked')
})

test('vscode native capability processOwnership', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t, { noTools: true, hold: true })
  const pending = f.run()
  for (let index = 0; index < 2400 && f.seen.length === 0; index++) await wait(25)
  assert.equal(f.seen.length, 1)
  const recovered = new ProcessOwner({ adapter: nativeProcessAdapter(f.registryPath, path.dirname(f.registryPath)), registryPath: f.registryPath, pollMs: 10 })
  await recovered.recoverReservations()
  assert.equal(recovered.ownershipIdentities().length, 1, 'fresh ProcessOwner did not recover the live VS Code host')
  await recovered.cancelAll({ reason: 'simulated VS Code controller crash', graceMs: 0, killMs: 2000, waitForPending: true })
  await assert.rejects(pending, error => ['CHILD_CANCELLED', 'CHILD_RUNTIME_FAILURE', 'PROCESS_DRAIN_TIMEOUT'].includes(error.code) || /owned|controller|terminal/i.test(error.message))
  assert.deepEqual(recovered.ownershipIdentities(), [])
})

test('vscode native capability modelRouting', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t, { noTools: true })
  f.execution.connection.model = 'fixture-vscode-model'
  const result = await f.run({ assignment: { model: 'fixture-vscode-model', effort: 'high' } }); good(result)
  assert.equal(f.seen.length, 1)
  assert.equal(f.seen[0].body.model, 'fixture-vscode-model')
  assert.equal(f.seen[0].body.reasoning?.effort, 'high')
  await assert.rejects(f.run({ reservationId: crypto.randomUUID(), assignment: { model: 'fixture-vscode-model', effort: 'invalid-effort' } }), { code: 'PROFILE_INVALID' })
  assert.equal(f.seen.length, 1, 'invalid model effort reached the local provider')
})

function durableQuotaProbe(limit = 100000) {
  const starts = [], settlements = [], debits = [], unknown = []
  return { starts, settlements, debits, unknown, record: {
    providerTokenLimit: limit, finiteTokenBudget: false,
    onProviderRequestStarted: value => starts.push(value),
    onProviderRequestSettled: value => settlements.push(value),
    onUnknownProviderSpend: value => unknown.push(value),
    onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } },
  } }
}

test('vscode native durable quota accounts tool turns once and preserves resume identity', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t)
  const first = durableQuotaProbe()
  const result = await f.run({ ...first.record, assignment: { model: 'fixture', effort: 'low' } }); good(result)
  assert.equal(first.starts.length, 2)
  assert.equal(first.settlements.length, 2)
  assert.equal(first.debits.length, 2)
  assert.equal(first.unknown.length, 0)
  assert.deepEqual(result.usage, { noncachedInput: 160, cachedInput: 40, output: 20, reasoning: 4 })
  for (let index = 0; index < 2; index++) {
    assert.equal(first.debits[index].evidence.requestOrdinal, index + 1)
    assert.equal(first.settlements[index].disposition, 'ACCOUNTED')
  }
  const resumed = durableQuotaProbe()
  const next = await f.run({ ...resumed.record, assignment: { model: 'fixture', effort: 'low' }, reservationId: crypto.randomUUID(), continuationId: result.contextId })
  good(next)
  assert.equal(next.contextId, result.contextId)
  assert.equal(resumed.debits.length, 1)
  assert.equal(resumed.unknown.length, 0)
})

test('vscode native durable quota denies insufficient first allowance without upstream spend', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t, { noTools: true })
  const quota = durableQuotaProbe(1)
  await assert.rejects(f.run(quota.record), error => error.code === 'CHILD_TOKEN_LIMIT_EXHAUSTED')
  assert.equal(f.seen.length, 0)
  assert.equal(quota.starts.length, 0)
  assert.equal(quota.debits.length, 0)
  assert.equal(quota.unknown.length, 0)
})

test('vscode native durable quota keeps concurrent child reservations independent', { skip: !enabled, timeout: 180000 }, async t => {
  const f = await scenario(t)
  const left = durableQuotaProbe(), right = durableQuotaProbe()
  const siblings = [siblingRecord(f, 'quota-left'), siblingRecord(f, 'quota-right')]
  const results = await Promise.all(siblings.map((record, index) => f.run({ ...record, ...[left, right][index].record,
    assignment: { model: 'fixture', effort: 'low' },
  })))
  assert.notEqual(results[0].contextId, results[1].contextId)
  for (let index = 0; index < 2; index++) {
    good(results[index])
    const quota = [left, right][index]
    assert.deepEqual(quota.starts.map(value => value.requestOrdinal), [1, 2])
    assert.equal(quota.settlements.length, 2)
    assert.equal(quota.debits.length, 2)
    assert.equal(quota.unknown.length, 0)
    assert.deepEqual(results[index].usage, quota.debits.at(-1).cumulative)
  }
})
