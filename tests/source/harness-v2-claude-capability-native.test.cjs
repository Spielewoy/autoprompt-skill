'use strict'

// Closed, native Claude capability probes.  The model endpoint is deliberately
// deterministic, but every case starts the installed Claude CLI through the
// production HarnessExecAdapter, its owned ProcessOwner, and the real MCP tool
// server.  Each test has a distinct observable that is used by the reviewed
// local canary; a successful generic conversation is not treated as proof.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const native = require('../../scripts/harness-v2-native.cjs')
const controlled = require('../../scripts/harness-v2-controlled-tools.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessExecAdapter, HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { modelService } = require('../helpers/harness-native-service.cjs')

const { privateDirectory, nativeProcessAdapter, nodeCommand, readCommand, withChallenge, requiredNativeCli, nativeEnvironment } = require('../helpers/native-platform.cjs')
const CLI = requiredNativeCli('claude')

function createFixture() {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-capability-native-')))
  const target = path.join(root, 'target'), controller = path.join(root, 'controller')
  fs.mkdirSync(target, { mode: 0o700 }); fs.mkdirSync(controller, { mode: 0o700 })
  const nativeRoot = path.join(controller, 'native'); fs.mkdirSync(nativeRoot, { mode: 0o700 })
  const suppliedChallenge = process.env.AUTOPROMPT_CLOSED_CANARY_CHALLENGE
  if (suppliedChallenge !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(suppliedChallenge)) throw new Error('AUTOPROMPT_CLOSED_CANARY_CHALLENGE must be one 32-byte base64url nonce')
  const challenge = suppliedChallenge || crypto.randomBytes(32).toString('base64url')
  const activationId = process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID || 'claude-closed-native-canary'
  const generation = Number(process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION || 1)
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(activationId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid closed-canary activation binding')
  const projection = core.createCanonicalMissionProjection([
    'FIRST_CONTEXT_SENTINEL: use the one assigned controller command and return the result.',
    ...(challenge ? [`CLOSED_CANARY_CHALLENGE: ${challenge}`] : []),
  ].join('\n'))
  const record = {
    activationId, generation,
    sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
    workItemId: 'closed-native-capability', logicalRole: 'worker',
    physicalRole: 'ap-worker', providerRole: 'ap-worker',
    canonicalMission: projection.canonicalMission, workingDirectory: target,
    dispatch: { requestPointer: { hash: native.sha256(`claude closed capability request${challenge ? `:${challenge}` : ''}`) } },
  }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, {
    ...record, sourceRequestHash: projection.sourceRequestHash,
    requestEnvelopeHash: record.dispatch.requestPointer.hash,
  })
  record.physicalExecutionPolicy = {
    logicalRole: record.logicalRole, physicalRole: record.physicalRole,
    providerRole: record.providerRole, sandboxMode: 'read-only', canDispatch: false,
    resourceSets: { read: [], write: [], exclusive: [] },
  }
  const sessionRoot = path.join(nativeRoot, 'claude', native.sha256(record.sessionId))
  const scratch = path.join(sessionRoot, native.sha256(record.reservationId), 'scratch')
  const schema = path.join(controller, 'result.schema.json')
  fs.writeFileSync(schema, JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://autoprompt.local/schemas/v2/closed-native-capability.schema.json',
    type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false,
  }), { mode: 0o600 })
  return { root, target, controller, nativeRoot, record, projection, scratch, schema, challenge }
}

function registeredProcessOwner(f) {
  const root = process.env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT
  if (!root) {
    const registryPath = path.join(f.controller, 'processes.json')
    return new ProcessOwner({ adapter: nativeProcessAdapter(registryPath), registryPath, pollMs: 10 })
  }
  if (!path.isAbsolute(root) || !/^[A-Za-z0-9_-]{43}$/.test(f.challenge) ||
      process.env.AUTOPROMPT_CLOSED_CANARY_PROVIDER !== 'claude' ||
      process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID !== f.record.activationId ||
      process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION !== String(f.record.generation)) {
    throw new Error('closed canary ownership registration binding is invalid')
  }
  const directory = path.join(root, `claude-${crypto.randomUUID()}`)
  privateDirectory(directory)
  const registryPath = path.join(directory, 'processes.json')
  fs.writeFileSync(path.join(directory, 'registration.json'), JSON.stringify({ schemaVersion: 1,
    provider: 'claude', activationId: f.record.activationId, generation: f.record.generation,
    challenge: f.challenge, registryPath }), { flag: 'wx', mode: 0o600 })
  return new ProcessOwner({ adapter: nativeProcessAdapter(registryPath, root), registryPath, pollMs: 10 })
}

async function scenario(t, options = {}) {
  assert.ok(CLI, 'AUTOPROMPT_CLAUDE_TEST_CLI is required for this native capability suite')
  const sandbox = await boundary.probeCommandSandbox()
  assert.equal(sandbox.supported, true, JSON.stringify(sandbox))
  const f = createFixture()
  let service, owner
  t.after(async () => {
    try { if (owner) await owner.cancelAll({ reason: 'claude native capability cleanup', graceMs: 0, killMs: 2000 }) }
    finally { try { if (service) await service.close() } finally { fs.rmSync(f.root, { recursive: true, force: true }) } }
  })
  const candidate = path.join(f.target, 'candidate.txt')
  const secret = path.join(f.controller, 'private.txt')
  const marker = `claude-native-capability-${crypto.randomUUID()}`
  fs.writeFileSync(candidate, marker, { mode: 0o600 })
  fs.writeFileSync(secret, 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE', { mode: 0o600 })
  fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD', { mode: 0o600 })
  let command = typeof options.command === 'function'
    ? options.command({ ...f, candidate, secret, marker })
    : options.command || readCommand(candidate)
  command = withChallenge(command, f.challenge)
  service = await modelService('claude', options.tool || { name: controlled.toolName('claude', 'bash'), args: { command } }, options.serviceOptions)
  const binding = native.probeExecutable({ provider: 'claude', executable: CLI })
  owner = registeredProcessOwner(f)
  const processAdapter = owner.adapter
  const proxy = path.join(f.controller, 'proxy'); fs.mkdirSync(proxy, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: 'claude-closed-native-canary', pollMs: 10 })
  const adapter = new HarnessExecAdapter({
    provider: 'claude', runner, nativeRoot: f.nativeRoot, executableBinding: binding,
    targetPath: f.target, connection: { model: 'claude-sonnet-4-6', environment: { ANTHROPIC_BASE_URL: service.url } },
    credentialEnvironment: { ANTHROPIC_API_KEY: '<local-test-only>' },
    outputSchemaResolver: () => f.schema,
    rolePrompt: () => 'Use only the assigned controller tools and return one JSON object.',
    ...(options.adapterOptions || {}),
  })
  const debits = []
  const run = async overrides => {
    const record = { ...f.record, ...overrides }
    record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, nativeEnvironment())
    record.onUsageDelta = (delta, cumulative, evidence) => { debits.push(delta); return overrides?.onUsageDelta ? overrides.onUsageDelta(delta, cumulative, evidence) : { continue: true } }
    record.signal = overrides?.signal || AbortSignal.timeout(90000)
    const result = await adapter.launch(record)
    assert.ok(service.requests.some(request => JSON.stringify(request.body).includes(`CLOSED_CANARY_CHALLENGE:${f.challenge}`)), 'the actual native tool result omitted its closed-canary challenge')
    return result
  }
  return { ...f, candidate, secret, marker, service, binding, owner, adapter, run, debits, command }
}

function checkerCommand(candidate, receipt) {
  return nodeCommand(`const fs=require('node:fs');process.stdout.write(fs.readFileSync(${JSON.stringify(candidate)}));fs.writeFileSync(${JSON.stringify(receipt)},'checked');let denied=false;try{fs.writeFileSync(${JSON.stringify(candidate)},'wrong')}catch(error){denied=['EACCES','EPERM','EROFS'].includes(error.code)}if(!denied)throw Error('Checker modified frozen candidate')`)
}

function assertSuccessful(result) {
  assert.equal(result.ok, true)
  assert.match(result.contextId, /^[0-9a-f-]{36}$/i)
  assert.ok(result.transportEvidence.eventCount > 0)
  assert.match(result.transportEvidence.eventStreamHash, /^[a-f0-9]{64}$/)
}

const nativeOptions = { skip: !CLI, timeout: 240000 }

test('claude closed native capability: full canonical role schema is accepted and validated', nativeOptions, async t => {
  const output = {
    schemaVersion: '2.0.0', reportType: 'result', reportId: 'canonical-role-schema-proof',
    runId: 'canonical-role-schema-run', assignmentId: 'canonical-role-schema-assignment',
    logicalRoleId: 'worker', physicalRoleId: 'autoprompt.v2.worker',
    requestEnvelopeHash: '1'.repeat(64), findingIds: ['AP-WORK-101'],
    startedAt: '2026-09-09T00:00:00.000Z', endedAt: '2026-09-09T00:00:01.000Z',
    filesChanged: [], resourcesChanged: [], behaviorChanged: ['Canonical schema reached the installed native CLI.'],
    commands: [{ command: 'fixture canonical schema validation', exitCode: 0, result: 'Installed native CLI returned its structured result.' }],
    successItems: [{ id: 'canonical-schema', status: 'pass', evidenceIds: ['installed-native-cli'] }],
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: { event: 'WORK_ITEM_VERIFIED', reason: 'The exact structured result passed.', invalidateEvidenceIds: [] },
  }
  const f = await scenario(t, { serviceOptions: { structuredOutput: output } })
  fs.copyFileSync(path.join(__dirname, '..', '..', 'agents', 'contracts', 'schemas', 'role-report.schema.json'), f.schema)
  let result
  const quotaHooks = {
    providerTokenLimit: 100000, finiteTokenBudget: false,
    onProviderRequestStarted() {}, onProviderRequestSettled() {}, onUnknownProviderSpend() {},
  }
  try { result = await f.run(quotaHooks) } catch (error) {
    const pending = [f.controller]
    while (pending.length) {
      const directory = pending.pop()
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name)
        if (entry.isDirectory()) pending.push(item)
        else if (entry.name === 'stderr.log') process.stderr.write(fs.readFileSync(item, 'utf8').slice(0, 4096))
      }
    }
    throw error
  }
  assert.match(result.contextId, /^[0-9a-f-]{36}$/i)
  assert.ok(result.transportEvidence.eventCount > 0)
  assert.match(result.transportEvidence.eventStreamHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(Object.fromEntries(Object.entries(output).filter(([key]) => !['candidateHash'].includes(key))),
    Object.fromEntries(Object.entries(result).filter(([key]) => Object.hasOwn(output, key))))
  const messages = f.service.requests.filter(request => request.path.includes('/messages'))
  assert.ok(messages.length > 0)
  for (const request of messages) {
    const structured = request.body.tools?.find(tool => tool.name === 'StructuredOutput')?.input_schema
    assert.equal(structured?.type, 'object', 'the canonical role union must retain its implied root object at the native boundary')
    assert.equal(Object.hasOwn(structured?.properties || {}, 'value'), false, 'the native schema must not request a string-wrapped result')
  }
  assert.ok(messages.every(request => request.body.max_tokens === 16384),
    `Claude output ceiling was not projected: ${JSON.stringify(messages.map(request => request.body.max_tokens))}`)

  const surplus = await scenario(t, { serviceOptions: { structuredOutput: { ...output, controllerUnauthorized: true } } })
  fs.copyFileSync(path.join(__dirname, '..', '..', 'agents', 'contracts', 'schemas', 'role-report.schema.json'), surplus.schema)
  await assert.rejects(surplus.run({}), { code: 'CHILD_RESULT_INVALID' })
})

test('claude closed native capability: isolation denies candidate/private/network while allowing scratch', nativeOptions, async t => {
  const net = require('node:net')
  let contacted = false
  const listener = net.createServer(socket => { contacted = true; socket.destroy() })
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  try {
    const f = await scenario(t, { command: ({ candidate, secret, scratch }) => {
      const scratchFile = path.join(scratch, 'isolation.txt')
      return nodeCommand(`
        const fs=require('node:fs'),net=require('node:net');
        const denied=operation=>{let error;try{operation()}catch(value){error=value}if(!error||!['EACCES','EPERM','EROFS','ENOENT'].includes(error.code))throw Error('Expected permission denial')};
        process.stdout.write(fs.readFileSync(${JSON.stringify(candidate)}));
        fs.writeFileSync(${JSON.stringify(scratchFile)},'scratch-ok');
        denied(()=>fs.writeFileSync(${JSON.stringify(candidate)},'forbidden'));
        denied(()=>fs.readFileSync(${JSON.stringify(secret)}));
        const s=net.connect(${port},'127.0.0.1');
        const timer=setTimeout(()=>{s.destroy();process.exitCode=21},3000);
        s.once('connect',()=>{clearTimeout(timer);s.destroy();process.exitCode=19});
        s.once('error',error=>{clearTimeout(timer);if(!['EACCES','EPERM','ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(error.code))process.exitCode=22});
      `)
    } })
    const result = await f.run({})
    assertSuccessful(result)
    assert.equal(fs.readFileSync(f.candidate, 'utf8'), f.marker)
    assert.equal(fs.readFileSync(path.join(f.scratch, 'isolation.txt'), 'utf8'), 'scratch-ok')
    assert.equal(contacted, false, 'the real command sandbox reached the host network')
  } finally { await new Promise(resolve => listener.close(resolve)) }
})

test('claude closed native capability: topology rejects injected nested dispatch and permits only its controller edge', nativeOptions, async t => {
  const hostile = await scenario(t, { tool: { name: 'Task', args: { prompt: 'unauthorized nested dispatch' } }, serviceOptions: { forceFirstTool: true } })
  await assert.rejects(hostile.run({}), { code: 'ROLE_POLICY_DENIED' })
  const f = await scenario(t, { command: ({ candidate }) => readCommand(candidate) })
  const result = await f.run({})
  assertSuccessful(result)
  const advertised = f.service.requests.filter(request => Array.isArray(request.body.tools))
    .flatMap(request => request.body.tools.map(tool => tool.name))
  assert.ok(advertised.includes(controlled.toolName('claude', 'bash')))
  assert.ok(advertised.every(name => controlled.decodeToolName('claude', name) || name === 'EndConversation' || name === 'StructuredOutput'), JSON.stringify(advertised))
  assert.ok(advertised.includes('StructuredOutput'))
  assert.equal(advertised.some(name => /^(?:Task|Agent|Skill|mcp__.*__(?:task|agent|skill))$/i.test(name)), false)
  assert.match(result.toolBoundaryEvidence.policySha256, /^[a-f0-9]{64}$/)
})

test('claude closed native capability: private skill root and ambient project configuration stay outside the model', nativeOptions, async t => {
  const f = await scenario(t, { command: ({ candidate }) => readCommand(candidate) })
  fs.mkdirSync(path.join(f.target, '.claude'), { mode: 0o700 })
  fs.writeFileSync(path.join(f.target, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ command: 'false' }] } }), { mode: 0o600 })
  const result = await f.run({})
  assertSuccessful(result)
  assert.equal(f.service.requests.some(request => JSON.stringify(request.body).includes('AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD')), false)
  assert.equal(f.service.requests.some(request => JSON.stringify(request.body).includes('PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE')), false)
  assert.equal(f.service.requests.some(request => JSON.stringify(request.body).includes('PreToolUse')), false)
})

test('claude closed native capability: intermediate stream events remain correlated to the native session', nativeOptions, async t => {
  const f = await scenario(t, { command: ({ candidate }) => readCommand(candidate) })
  const raw = []
  const result = await f.run({ onEvent: event => raw.push(event) })
  assertSuccessful(result)
  assert.ok(raw.length >= 4, `expected native intermediate events, got ${raw.length}`)
  assert.ok(raw.some(event => event.type === 'stream_event'))
  assert.ok(raw.some(event => event.type === 'assistant'))
  assert.ok(raw.some(event => event.type === 'user'))
  assert.ok(raw.filter(event => event.session_id).every(event => event.session_id === result.contextId), JSON.stringify(raw.map(event => event.session_id)))
})

test('Claude exact post-message ping is ignored without opening a request', () => {
  // This is the exact inner frame retained from Claude Code 2.1.263's public
  // run after message_stop. It is a keepalive, not a provider response.
  const stream = new HarnessEventStream('claude')
  const session = '00000000-0000-0000-0000-000000000000'
  stream.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }))
  stream.push(JSON.stringify({ type: 'stream_event', session_id: session, event: { type: 'ping' } }))
  assert.equal(stream.claudeCurrent, null)
  assert.equal(stream.claudeMessages.size, 0)
  assert.equal(stream.usageByRequest.size, 0)
  assert.throws(() => stream.push(JSON.stringify({ type: 'stream_event', session_id: session, event: { type: 'ping', data: 'unexpected' } })),
    { code: 'TRANSPORT_INVALID' })
})

test('claude closed native capability: exact controller tool receipt binds the real command output', nativeOptions, async t => {
  const f = await scenario(t, { command: ({ candidate, scratch }) => {
    const receipt = path.join(scratch, 'receipt.txt')
    return nodeCommand(`const fs=require('node:fs');process.stdout.write(fs.readFileSync(${JSON.stringify(candidate)}));fs.writeFileSync(${JSON.stringify(receipt)},'exact-receipt')`)
  } })
  const raw = []
  const result = await f.run({ onEvent: event => raw.push(event) })
  assertSuccessful(result)
  assert.equal(result.toolBoundaryEvidence.receiptHashes.length, 1)
  assert.match(result.toolBoundaryEvidence.receiptHashes[0], /^[a-f0-9]{64}$/)
  assert.equal(fs.readFileSync(path.join(f.scratch, 'receipt.txt'), 'utf8'), 'exact-receipt')
  assert.ok(raw.some(event => event.type === 'user' && JSON.stringify(event).includes(f.marker)), 'the exact native tool result omitted command output bytes')
})

test('claude closed native capability: concurrently owned siblings receive separate native identities', nativeOptions, async t => {
  const f = await scenario(t, { command: ({ candidate }) => readCommand(candidate) })
  let peak = 0
  const monitor = setInterval(() => { peak = Math.max(peak, f.owner.ownershipIdentities().length) }, 5)
  let results
  try {
    results = await Promise.all([0, 1].map(index => {
      const identities = { sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: `sibling-${index}` }
      return f.run({ ...identities, missionBinding: core.bindCanonicalMissionForChild(f.projection, {
        ...f.record, ...identities, sourceRequestHash: f.projection.sourceRequestHash,
        requestEnvelopeHash: f.record.dispatch.requestPointer.hash,
      }) })
    }))
  } finally { clearInterval(monitor) }
  assert.ok(results.every(result => result.ok === true))
  assert.equal(new Set(results.map(result => result.contextId)).size, 2)
  assert.ok(peak >= 2, `sibling CLI processes did not overlap; peak=${peak}`)
  assert.deepEqual(f.owner.ownershipIdentities(), [])
})

test('claude closed native capability: same-context continuation succeeds while foreign target reuse is refused', nativeOptions, async t => {
  const f = await scenario(t, { command: ({ candidate }) => readCommand(candidate) })
  const first = await f.run({})
  assertSuccessful(first)
  const before = f.service.requests.length
  const resumed = await f.run({ reservationId: crypto.randomUUID(), continuationId: first.contextId })
  assertSuccessful(resumed)
  assert.equal(resumed.contextId, first.contextId)
  assert.ok(f.service.requests.slice(before).some(request => JSON.stringify(request.body).includes('FIRST_CONTEXT_SENTINEL')))
  const foreignTarget = path.join(f.root, 'foreign-target'); fs.mkdirSync(foreignTarget, { mode: 0o700 })
  await assert.rejects(f.adapter.launch({
    ...f.record, reservationId: crypto.randomUUID(), continuationId: first.contextId,
    workingDirectory: foreignTarget,
    environment: prepareProcessLaunchEnvironment(f.owner.adapter, crypto.randomUUID(), nativeEnvironment()),
    signal: AbortSignal.timeout(30000),
  }), { code: 'SESSION_ID_MISMATCH' })
})

test('claude closed native capability: cancellation drains the held child and a sibling remains operational', nativeOptions, async t => {
  const f = await scenario(t, {
    command: ({ candidate }) => readCommand(candidate),
    serviceOptions: { delayMessagesMs: 4000 },
  })
  const controller = new AbortController()
  const pending = f.run({ signal: controller.signal })
  pending.catch(() => {})
  for (let i = 0; i < 100 && f.service.requests.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  const identities = { sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'fast-sibling' }
  const fast = f.run({ ...identities, missionBinding: core.bindCanonicalMissionForChild(f.projection, {
    ...f.record, ...identities, sourceRequestHash: f.projection.sourceRequestHash,
    requestEnvelopeHash: f.record.dispatch.requestPointer.hash,
  }) })
  fast.catch(() => {})
  for (let i = 0; i < 1000 && f.owner.ownershipIdentities().length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.owner.ownershipIdentities().length, 2, 'both owned native children must be live at cancellation')
  controller.abort()
  await assert.rejects(pending, { code: 'CHILD_CANCELLED' })
  const fastResult = await fast
  assertSuccessful(fastResult)
  assert.deepEqual(f.owner.ownershipIdentities(), [])
  assert.equal(fastResult.ok, true, 'the concurrent sibling must remain operational when the held child is cancelled')
  assert.deepEqual(f.owner.ownershipIdentities(), [])
})

test('claude closed native capability: isolated checker receives read-only candidate and private scratch', nativeOptions, async t => {
  const f = await scenario(t, { command: ({ candidate, scratch }) => {
    const checked = path.join(scratch, 'checker.txt')
    return checkerCommand(candidate, checked)
  } })
  const frozen = path.join(f.root, 'frozen'); fs.mkdirSync(frozen, { mode: 0o700 })
  const frozenCandidate = path.join(frozen, 'candidate.txt'); fs.writeFileSync(frozenCandidate, f.marker, { mode: 0o600 })
  const checkerScratch = path.join(f.root, 'checker-scratch'); fs.mkdirSync(checkerScratch, { mode: 0o700 })
  for (const name of ['tmp', 'output', 'cache']) fs.mkdirSync(path.join(checkerScratch, name), { mode: 0o700 })
  const checkerBoundary = {
    schemaVersion: 1, capability: native.sha256('closed-native-checker-boundary'), runId: 'closed-native-checker',
    checkerId: 'claude-closed-native', candidateHash: native.sha256(f.marker), frozenCandidateRoot: frozen,
    writableScratchRoot: checkerScratch, temporaryRoot: path.join(checkerScratch, 'tmp'),
    outputRoot: path.join(checkerScratch, 'output'), cacheRoot: path.join(checkerScratch, 'cache'),
  }
  f.service.tool.args.command = withChallenge(checkerCommand(frozenCandidate, path.join(checkerScratch, 'checker.txt')), f.challenge)
  const checkerRecord = {
    ...f.record, logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker',
    workingDirectory: checkerScratch, canonicalTargetPath: frozen, candidateHash: checkerBoundary.candidateHash, checkerScratchBoundary: checkerBoundary,
    physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } },
  }
  const checkerAdapter = new HarnessExecAdapter({
    provider: 'claude', runner: f.adapter.runner, nativeRoot: f.nativeRoot, executableBinding: f.binding, targetPath: checkerScratch,
    connection: f.adapter.connection, credentialEnvironment: { ANTHROPIC_API_KEY: '<local-test-only>' }, outputSchemaResolver: () => f.schema,
    rolePrompt: () => 'Use only the controller checker tools and return one JSON object.', checkerScratchVerifier: () => checkerBoundary,
  })
  checkerRecord.environment = prepareProcessLaunchEnvironment(f.owner.adapter, checkerRecord.reservationId, nativeEnvironment())
  checkerRecord.signal = AbortSignal.timeout(90000)
  const result = await checkerAdapter.launch(checkerRecord)
  assertSuccessful(result)
  assert.equal(fs.readFileSync(frozenCandidate, 'utf8'), f.marker)
  assert.equal(fs.readFileSync(path.join(checkerScratch, 'checker.txt'), 'utf8'), 'checked')
})

test('claude closed native capability: process ownership records completion and recovers a fresh session', nativeOptions, async t => {
  const f = await scenario(t, { command: ({ candidate }) => readCommand(candidate), serviceOptions: { delayMessagesMs: 10000 } })
  const abort = new AbortController()
  const pending = f.run({ signal: abort.signal })
  pending.catch(() => {})
  for (let i = 0; i < 1500 && f.service.requests.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(f.service.requests.length > 0, 'native request must start before recovering its durable owner')
  const registry = JSON.parse(fs.readFileSync(f.owner.registryPath, 'utf8'))
  assert.ok(JSON.stringify(registry).includes('native-claude-'), 'owned native process was not durably registered')
  const replacement = new ProcessOwner({ adapter: nativeProcessAdapter(f.owner.registryPath, process.env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT || f.controller), registryPath: f.owner.registryPath, pollMs: 10 })
  await replacement.recoverReservations()
  assert.equal(replacement.ownershipIdentities().length, 1, 'replacement owner must recover the actual live CLI')
  try {
    await replacement.cancelAll({ reason: 'recover persisted native child', graceMs: 0, killMs: 5000, waitForPending: true })
  } catch (error) { t.diagnostic(JSON.stringify(error.details)); throw error }
  abort.abort()
  await assert.rejects(pending)
  assert.deepEqual(replacement.ownershipIdentities(), [])
  const recovered = await f.run({ sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() })
  assertSuccessful(recovered)
  assert.deepEqual(f.owner.ownershipIdentities(), [])
})

test('claude closed native capability: exact model effort is wired and unsupported assignment is refused', nativeOptions, async t => {
  const f = await scenario(t, { command: ({ candidate }) => readCommand(candidate) })
  const result = await f.run({ assignment: { model: 'claude-sonnet-4-6', effort: 'high' } })
  assertSuccessful(result)
  const modelRequests = f.service.requests.filter(request => request.path.includes('/messages'))
  assert.ok(modelRequests.length > 0)
  assert.ok(modelRequests.every(request => request.body.model === 'claude-sonnet-4-6' && request.body.output_config?.effort === 'high'), JSON.stringify(modelRequests.map(request => ({ model: request.body.model, effort: request.body.output_config }))))
  assert.ok(modelRequests.every(request => request.body.tools?.some(tool => tool.name === 'StructuredOutput' && tool.input_schema?.properties?.ok?.const === true)),
    JSON.stringify(modelRequests.map(request => (request.body.tools || []).map(tool => tool.name))))
  assert.throws(() => native.createLaunch({ provider: 'claude', executable: f.binding.path, home: path.join(f.root, 'invalid-home'), sessionRoot: path.join(f.root, 'invalid-session'), targetPath: f.target, cwd: f.target, prompt: 'x', input: 'x', connection: f.adapter.connection, credentials: { ANTHROPIC_API_KEY: '<local-test-only>' }, environment: nativeEnvironment(), readOnly: true, effort: 'unauthorized' }), { code: 'PROFILE_INVALID' })
})

for (const deferredInputUsage of [false, true]) {
test(`claude native durable quota settles each tool turn exactly once${deferredInputUsage ? ' with deferred cumulative input' : ''}`, { skip: !CLI, timeout: 180000 }, async t => {
  const f = await scenario(t, { serviceOptions: { deferredInputUsage, terminalDoneSentinel: deferredInputUsage ? 'data' : false, explicitThinkingReplay: deferredInputUsage } })

  const starts = [], settlements = [], debits = [], unknown = []
  const result = await f.run({ assignment: { model: f.adapter.connection.model, effort: 'low' }, providerTokenLimit: 100000, finiteTokenBudget: false,
    onProviderRequestStarted: value => starts.push(value),
    onProviderRequestSettled: value => settlements.push(value),
    onUnknownProviderSpend: value => unknown.push(value),
    onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } },
  }).catch(error => { t.diagnostic(JSON.stringify({ code: error.code, details: error.details })); throw error })
  assert.equal(result.ok, true)
  assert.equal(starts.length, 2)
  assert.equal(settlements.length, 2)
  assert.equal(debits.length, 2)
  assert.equal(unknown.length, 0)
  const modelRequests = f.service.requests.filter(request => request.path.includes('/messages'))
  assert.ok(modelRequests.length > 0 && modelRequests.every(request => request.body.output_config?.effort === 'low'),
    JSON.stringify(modelRequests.map(request => request.body.output_config)))
  if (deferredInputUsage) {
    const thinking = f.service.requests.flatMap(request => request.body.messages || [])
      .flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(part => part.type === 'thinking')
    assert.ok(thinking.length > 0, 'the real SDK must replay the explicit thinking block')
    assert.ok(thinking.every(part => part.signature === '' && part.thinking === 'Fixture planning text.'))
  }
  assert.deepEqual(result.usage, debits.at(-1).cumulative)
  for (let index = 0; index < 2; index++) {
    assert.equal(debits[index].evidence.requestOrdinal, index + 1)
    assert.equal(settlements[index].disposition, 'ACCOUNTED')
  }
})
}
