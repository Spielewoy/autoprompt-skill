'use strict'

// Closed native capability probes for the official Prime and OMP CLIs.  The
// model endpoint is local and deterministic; every observed tool call still
// travels through HarnessExecAdapter, the real CLI extension, ProcessOwner,
// and the operating-system command boundary.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessExecAdapter } = require('../../scripts/harness-v2-transport.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { piModelService } = require('../helpers/harness-pi-native-service.cjs')
const { privateDirectory, nativeProcessAdapter, nodeCommand, readCommand, withChallenge, nativeEnvironment, cleanupNativeFixture } = require('../helpers/native-platform.cjs')

const CLIS = Object.freeze({ prime: process.env.AUTOPROMPT_PRIME_TEST_CLI, omp: process.env.AUTOPROMPT_OMP_TEST_CLI })
if (process.env.AUTOPROMPT_REQUIRE_NATIVE_TESTS === '1' && !CLIS.prime && !CLIS.omp) throw new Error('AUTOPROMPT_PRIME_TEST_CLI or AUTOPROMPT_OMP_TEST_CLI is required; native certification cannot skip')
// Each scenario still creates an independent service, owner, adapter, and
// native launch. The executable probe itself is immutable for one exact
// provider/CLI pair, while HarnessExecAdapter.launch reopens the executable
// and complete runtime dependency identity before every individual launch.
// Cache only a completed probe: a failed probe must remain retryable.
const probeBindings = new Map()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Native Windows AppContainer admission and per-tool materialization take
// 80–130 seconds in CI110. Keep explicit aborts for cancellation scenarios,
// while allowing ordinary native calls the same bound as OpenCode/DeepSeek.
const NATIVE_CALL_TIMEOUT_MS = process.platform === 'win32' ? 300000 : 90000

function probeBinding(provider, cli) {
  const key = `${provider}\0${cli}`
  const cached = probeBindings.get(key)
  if (cached) return cached
  const binding = native.probeExecutable({ provider, executable: cli })
  const immutable = Object.freeze(binding)
  probeBindings.set(key, immutable)
  return immutable
}

async function waitForNativeRequest(service, pending, timeoutMs = process.platform === 'win32' ? 120000 : 30000) {
  let settled = false, failure
  // Observe rejection immediately, even while another native sibling starts.
  pending.then(() => { settled = true }, error => { settled = true; failure = error })
  const deadline = Date.now() + timeoutMs
  while (service.requests.length === 0 && !settled && Date.now() < deadline) await wait(25)
  if (failure) throw failure
  assert.ok(service.requests.length > 0, 'held native child did not make a model request within its startup bound')
}

function ownershipRegistry(provider, f) {
  const fields = ['AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT', 'AUTOPROMPT_CLOSED_CANARY_PROVIDER', 'AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID', 'AUTOPROMPT_CLOSED_CANARY_GENERATION', 'AUTOPROMPT_CLOSED_CANARY_CHALLENGE']
  const supplied = Object.fromEntries(fields.map(name => [name, process.env[name]]))
  if (!fields.some(name => supplied[name] !== undefined)) return path.join(f.controller, 'processes.json')
  if (fields.some(name => typeof supplied[name] !== 'string' || !supplied[name]) || supplied.AUTOPROMPT_CLOSED_CANARY_PROVIDER !== provider ||
      supplied.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID !== f.record.activationId || supplied.AUTOPROMPT_CLOSED_CANARY_GENERATION !== String(f.record.generation) ||
      !path.isAbsolute(supplied.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT) || !/^[A-Za-z0-9_-]{43}$/.test(supplied.AUTOPROMPT_CLOSED_CANARY_CHALLENGE)) {
    throw new Error('closed canary ownership registration is invalid')
  }
  const root = privateDirectory(path.resolve(supplied.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT)), stat = fs.statSync(root)
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('closed canary ownership root is not private')
  const directory = privateDirectory(path.join(root, `${provider}-${crypto.randomUUID()}`))
  const registryPath = path.join(directory, 'processes.json')
  fs.writeFileSync(path.join(directory, 'registration.json'), JSON.stringify({ schemaVersion: 1, provider, activationId: f.record.activationId,
    generation: f.record.generation, challenge: supplied.AUTOPROMPT_CLOSED_CANARY_CHALLENGE, registryPath }), { flag: 'wx', mode: 0o600 })
  return registryPath
}

function fixture(provider) {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-closed-capability-`)))
  const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
  for (const directory of [target, controller, nativeRoot]) privateDirectory(directory)
  const suppliedChallenge = process.env.AUTOPROMPT_CLOSED_CANARY_CHALLENGE
  if (suppliedChallenge !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(suppliedChallenge)) throw new Error('AUTOPROMPT_CLOSED_CANARY_CHALLENGE must be one base64url nonce')
  const suppliedActivationId = process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID
  const suppliedGeneration = process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION
  const suppliedGenerationNumber = suppliedGeneration === undefined ? null : Number(suppliedGeneration)
  if ((suppliedActivationId === undefined) !== (suppliedGeneration === undefined) ||
      suppliedActivationId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(suppliedActivationId) || !/^[1-9][0-9]*$/.test(suppliedGeneration) || !Number.isSafeInteger(suppliedGenerationNumber))) {
    throw new Error('closed canary activation binding is invalid')
  }
  const challenge = suppliedChallenge || crypto.randomBytes(32).toString('base64url')
  const projection = core.createCanonicalMissionProjection(`FIRST_CONTEXT_SENTINEL: use only one controller tool and return JSON.\nCLOSED_CANARY_CHALLENGE: ${challenge}`)
  const record = { activationId: suppliedActivationId || `${provider}-closed-native-canary`, generation: suppliedGenerationNumber || 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
    workItemId: 'closed-native-capability', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', canonicalMission: projection.canonicalMission,
    workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256(`${provider}:closed-capability:${challenge}`) } } }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.physicalExecutionPolicy = { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', sandboxMode: 'read-only', canDispatch: false,
    resourceSets: { read: [], write: [], exclusive: [] } }
  const schema = path.join(controller, 'result.schema.json')
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true }, marker: { type: ['string', 'null'] } }, required: ['ok', 'marker'], additionalProperties: false }), { mode: 0o600 })
  return { root, target, controller, nativeRoot, challenge, projection, record, schema }
}

function connection(service) {
  return { modelProvider: 'fixture', model: 'controller-fixture', providers: { fixture: { baseUrl: `${service.url}/v1`, api: 'openai-completions', apiKey: '<local-test-only>',
    models: [{ id: 'controller-fixture', name: 'Controller fixture', reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsUsageInStreaming: true, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_completion_tokens' } }],
  } } }
}

function fixtureFailureDiagnostic(f, error) {
  // Preserve the synthetic provider events and native stderr before cleanup
  // drains the child. This is bounded fixture data, not an ambient log dump.
  const output = { fixtureFailure: String(error.code || error.message).slice(0, 1024),
    failureDetails: error.details?.proxyFailure || null,
    stderr: String(f.nativeStderr || '').slice(-8192), events: [...(f.nativeEvents || [])] }
  const proxy = path.join(f.controller, 'proxy')
  output.proxy = []
  for (const name of fs.existsSync(proxy) ? fs.readdirSync(proxy, { recursive: true }) : []) {
    if (!/(?:^|[\\/])(?:stderr\.log|status\.json|proxy-error\.json)$/.test(name)) continue
    const file = path.join(proxy, name), stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue
    output.proxy.push({ name, text: fs.readFileSync(file, 'utf8').slice(-4096) })
    if (output.proxy.length >= 4) break
  }
  while (Buffer.byteLength(JSON.stringify(output)) > 65536) output.events.shift()
  console.error(JSON.stringify(output))
}

function sibling(f, label) {
  const ids = { sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: label }
  return { ...ids, missionBinding: core.bindCanonicalMissionForChild(f.projection, { ...f.record, ...ids,
    sourceRequestHash: f.projection.sourceRequestHash, requestEnvelopeHash: f.record.dispatch.requestPointer.hash }) }
}

function scratchFor(f, record = f.record) {
  return path.join(f.nativeRoot, f.provider, native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch')
}

function findReceipts(f, result) {
  const matches = []
  const visit = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name)
      if (item.isDirectory()) visit(file)
      else if (item.name === 'policy.json') {
        try {
          const state = boundary.loadBoundary(file, result.toolBoundaryEvidence.policySha256)
          matches.push(...boundary.readReceipts(state))
        } catch {}
      }
    }
  }
  visit(f.nativeRoot)
  return matches
}

async function scenario(t, provider, options = {}) {
  const cli = CLIS[provider]
  assert.ok(cli, `AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI is required for this native capability suite`)
  const sandbox = await boundary.probeCommandSandbox()
  assert.equal(sandbox.supported, true, JSON.stringify(sandbox))
  const f = fixture(provider)
  const candidate = path.join(f.target, 'candidate.txt'), secret = path.join(f.controller, 'private.txt'), marker = `${provider}-native-capability-${crypto.randomUUID()}`
  fs.writeFileSync(candidate, marker, { mode: 0o600 }); fs.writeFileSync(secret, 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE', { mode: 0o600 })
  fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD', { mode: 0o600 })
  const base = typeof options.command === 'function' ? options.command({ ...f, provider, candidate, secret, marker, scratch: scratchFor({ ...f, provider }) }) : options.command || readCommand(candidate)
  const calls = options.calls || [{ id: 'owned-command', name: 'autoprompt_owned_bash', args: { command: withChallenge(base, f.challenge) } }]
  let service, owner
  try {
    service = await piModelService(calls, { marker, ...(options.serviceOptions || {}) })
    const binding = probeBinding(provider, cli)
    const registryPath = ownershipRegistry(provider, f), processAdapter = nativeProcessAdapter(registryPath, path.dirname(registryPath))
    owner = new ProcessOwner({ adapter: processAdapter, registryPath, pollMs: 10 })
    const proxy = privateDirectory(path.join(f.controller, 'proxy'))
    const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: `${provider}-closed-native-canary`, pollMs: 10 })
    const ownedRun = runner.run.bind(runner)
    runner.run = async spec => {
      f.nativeEvents = []; f.nativeStderr = ''
      const result = await ownedRun({ ...spec, onStdoutLine: line => {
        f.nativeEvents.push(String(line).slice(-8192))
        if (f.nativeEvents.length > 16) f.nativeEvents.shift()
        return spec.onStdoutLine?.(line)
      } })
      f.nativeStderr = result.stderr
      return result
    }
    const adapter = new HarnessExecAdapter({ provider, runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target, connection: connection(service),
      credentialEnvironment: { OPENAI_API_KEY: '<local-test-only>', OPENROUTER_API_KEY: '<local-test-only>' }, outputSchemaResolver: () => f.schema,
      rolePrompt: () => 'Use only assigned controller tools and return exactly one JSON object.' })
    const run = async (overrides = {}) => {
      const record = { ...f.record, ...overrides }
      record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, nativeEnvironment())
      record.signal = overrides.signal || AbortSignal.timeout(NATIVE_CALL_TIMEOUT_MS)
      try { return await adapter.launch(record) }
      catch (error) { fixtureFailureDiagnostic(f, error); throw error }
    }
    let closed = false
    t.after(async () => {
      if (closed) return
      closed = true
      await cleanupNativeFixture(f, provider, { stop: () => owner.cancelAll({ reason: `${provider} capability cleanup`, graceMs: 0, killMs: 2000, waitForPending: true }), close: () => service.close() })
    })
    return { ...f, provider, cli, candidate, secret, marker, calls, service, binding, processAdapter, registryPath, owner, runner, adapter, run }
  } catch (error) {
    try { await cleanupNativeFixture(f, provider, { stop: () => owner?.cancelAll({ reason: `${provider} capability setup failure`, graceMs: 0, killMs: 2000, waitForPending: true }), close: () => service?.close() }) } catch {}
    throw error
  }
}

function successful(result) {
  assert.equal(result.ok, true)
  assert.match(result.contextId, /^[A-Za-z0-9_.:-]{1,256}$/)
  assert.ok(result.transportEvidence.eventCount > 0, JSON.stringify(result.transportEvidence))
  assert.match(result.transportEvidence.eventStreamHash, /^[a-f0-9]{64}$/)
  assert.match(result.toolBoundaryEvidence.policySha256, /^[a-f0-9]{64}$/)
}

const options = { skip: !CLIS.prime && !CLIS.omp, timeout: process.platform === 'win32' ? 900000 : 240000 }
for (const provider of ['prime', 'omp']) {
  const providerOptions = { ...options, skip: options.skip || !CLIS[provider] }

  test(`${provider} closed native capability: all six owned tools enforce write/private/network isolation and scratch witness`, providerOptions, async t => {
    let contacted = false
    const listener = net.createServer(socket => { contacted = true; socket.destroy() })
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
    try {
      const f = await scenario(t, provider, { calls: [] })
      const scratchFile = scratchFor(f) + '/six-tools.txt'
      const network = `const n=require('node:net');const s=n.connect(${listener.address().port},'127.0.0.1');s.on('connect',()=>process.exit(19));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),700)`
      f.calls.push(
        { id: 'read', name: 'autoprompt_owned_read', args: { path: f.candidate } },
        { id: 'list', name: 'autoprompt_owned_list', args: { path: f.target } },
        { id: 'search', name: 'autoprompt_owned_search', args: { path: f.target, text: f.marker } },
        { id: 'write', name: 'autoprompt_owned_write', args: { path: scratchFile, content: 'before' } },
        { id: 'edit', name: 'autoprompt_owned_edit', args: { path: scratchFile, oldText: 'before', newText: 'after' } },
        { id: 'bash', name: 'autoprompt_owned_bash', args: { command: withChallenge(`${readCommand(f.candidate)}; ${nodeCommand(`try { require('node:fs').writeFileSync(${JSON.stringify(f.candidate)}, 'forbidden'); process.exit(18) } catch {} ; try { require('node:fs').readFileSync(${JSON.stringify(f.secret)}); process.exit(20) } catch {} ; ${network}`)}`, f.challenge) } },
      )
      const result = await f.run({}); successful(result)
      assert.equal(fs.readFileSync(f.candidate, 'utf8'), f.marker); assert.equal(fs.readFileSync(scratchFile, 'utf8'), 'after'); assert.equal(contacted, false)
      assert.equal(result.toolBoundaryEvidence.receiptHashes.length, 6)
    } finally { await new Promise(resolve => listener.close(resolve)) }
  })

  test(`${provider} closed native capability: hostile nested dispatch is denied and only the fixed controller topology is advertised`, providerOptions, async t => {
    const hostile = await scenario(t, provider, { calls: [{ id: 'hostile', name: 'Task', args: { prompt: 'unauthorized nested dispatch' } }] })
    await assert.rejects(hostile.run({}), error => ['ROLE_POLICY_DENIED', 'CHILD_RUNTIME_FAILURE', 'TOOL_DENIED'].includes(error.code))
    const f = await scenario(t, provider)
    const result = await f.run({}); successful(result)
    const names = f.service.requests.flatMap(request => request.body.tools || []).map(tool => tool.function?.name || tool.name)
    assert.deepEqual([...new Set(names)].sort(), ['autoprompt_owned_bash', 'autoprompt_owned_edit', 'autoprompt_owned_list', 'autoprompt_owned_read', 'autoprompt_owned_search', 'autoprompt_owned_write'])
  })

  test(`${provider} closed native capability: private and ambient configuration are absent from actual model requests`, providerOptions, async t => {
    const f = await scenario(t, provider)
    privateDirectory(path.join(f.target, provider === 'prime' ? '.prime' : '.omp'))
    fs.writeFileSync(path.join(f.target, provider === 'prime' ? '.prime/settings.json' : '.omp/config.yml'), 'AMBIENT_HOOK_MUST_NOT_LOAD', { mode: 0o600 })
    const result = await f.run({}); successful(result)
    const wire = JSON.stringify(f.service.requests)
    for (const text of ['AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD', 'AMBIENT_HOOK_MUST_NOT_LOAD', 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE']) assert.equal(wire.includes(text), false, text)
  })

  test(`${provider} closed native capability: native event stream stays correlated to one context`, providerOptions, async t => {
    const f = await scenario(t, provider), events = []
    const result = await f.run({ onEvent: event => events.push(event) }); successful(result)
    assert.ok(events.length >= 3, JSON.stringify(events))
    const identifiers = events.map(event => event.session_id || event.sessionId || event.id).filter(value => typeof value === 'string')
    assert.ok(identifiers.includes(result.contextId), JSON.stringify(events))
    assert.ok(events.every(event => !event.session_id || event.session_id === result.contextId), JSON.stringify(events))
  })

  test(`${provider} closed native capability: exact output bytes are committed in the controller receipt`, providerOptions, async t => {
    const f = await scenario(t, provider, { command: ({ candidate }) => `${nodeCommand("process.stdout.write('exact:')")}; ${readCommand(candidate)}` })
    const result = await f.run({}); successful(result)
    const receipts = findReceipts(f, result)
    assert.equal(receipts.length, 1)
    const expected = `exact:${f.marker}\nCLOSED_CANARY_CHALLENGE:${f.challenge}\n`
    assert.equal(receipts[0].outputSha256, native.sha256(expected)); assert.equal(receipts[0].status, 'completed')
    assert.ok(f.service.requests.some(request => JSON.stringify(request.body.messages).includes(`exact:${f.marker}`)))
  })

  test(`${provider} closed native capability: overlapping siblings retain unique contexts and drain`, providerOptions, async t => {
    const f = await scenario(t, provider, { command: ({ candidate }) => `${nodeCommand("setTimeout(()=>{},1000)")}; ${readCommand(candidate)}` })
    let peak = 0; const monitor = setInterval(() => { peak = Math.max(peak, f.owner.ownershipIdentities().length) }, 5)
    let values
    try { values = await Promise.all([f.run(sibling(f, 'sibling-a')), f.run(sibling(f, 'sibling-b'))]) } finally { clearInterval(monitor) }
    values.forEach(successful); assert.equal(new Set(values.map(value => value.contextId)).size, 2); assert.ok(peak >= 2, `owned children did not overlap: ${peak}`); assert.deepEqual(f.owner.ownershipIdentities(), [])
  })

  test(`${provider} closed native capability: resume reuses only its bound target context`, providerOptions, async t => {
    const f = await scenario(t, provider), first = await f.run({}); successful(first)
    const before = f.service.requests.length, resumed = await f.run({ reservationId: crypto.randomUUID(), continuationId: first.contextId }); successful(resumed)
    assert.equal(resumed.contextId, first.contextId); assert.ok(f.service.requests.slice(before).some(request => JSON.stringify(request.body.messages).includes('FIRST_CONTEXT_SENTINEL')))
    const foreign = privateDirectory(path.join(f.root, 'foreign')), foreignReservation = crypto.randomUUID()
    await assert.rejects(f.adapter.launch({ ...f.record, reservationId: foreignReservation, continuationId: first.contextId, workingDirectory: foreign,
      environment: prepareProcessLaunchEnvironment(f.processAdapter, foreignReservation, nativeEnvironment()), signal: AbortSignal.timeout(30000) }), { code: 'SESSION_ID_MISMATCH' })
  })

  test(`${provider} closed native capability: held child cancels while a fast sibling remains alive and drained`, providerOptions, async t => {
    const held = await scenario(t, provider, { serviceOptions: { hold: true } }), controller = new AbortController(), pending = held.run({ signal: controller.signal })
    try {
      await waitForNativeRequest(held.service, pending)
      const fast = await scenario(t, provider), result = await fast.run({}); successful(result)
      controller.abort(); await assert.rejects(pending, { code: 'CHILD_CANCELLED' }); assert.equal(result.ok, true); assert.deepEqual(held.owner.ownershipIdentities(), [])
    } finally {
      controller.abort()
      await pending.catch(() => {})
    }
  })

  test(`${provider} closed native capability: checker sees frozen candidate but writes only authenticated scratch`, providerOptions, async t => {
    const f = await scenario(t, provider)
    const frozen = privateDirectory(path.join(f.root, 'frozen')), scratch = privateDirectory(path.join(f.root, 'checker-scratch'))
    for (const name of ['tmp', 'output', 'cache']) privateDirectory(path.join(scratch, name))
    const candidate = path.join(frozen, 'candidate.txt'); fs.writeFileSync(candidate, f.marker, { mode: 0o600 })
    const checker = { schemaVersion: 1, capability: native.sha256(`${provider}:checker`), runId: `${provider}-closed-checker`, checkerId: `${provider}-closed-native`, candidateHash: native.sha256(f.marker), frozenCandidateRoot: frozen,
      writableScratchRoot: scratch, temporaryRoot: path.join(scratch, 'tmp'), outputRoot: path.join(scratch, 'output'), cacheRoot: path.join(scratch, 'cache') }
    f.calls[0].args.command = withChallenge(`${readCommand(candidate)}; ${nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(path.join(scratch, 'checker.txt'))}, 'checked'); try { require('node:fs').writeFileSync(${JSON.stringify(candidate)}, 'forbidden'); process.exit(19) } catch {}`)}`, f.challenge)
    const record = { ...f.record, logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', workingDirectory: scratch, canonicalTargetPath: frozen,
      candidateHash: checker.candidateHash, checkerScratchBoundary: checker, physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } } }
    const adapter = new HarnessExecAdapter({ provider, runner: f.runner, nativeRoot: f.nativeRoot, executableBinding: f.binding, targetPath: scratch, connection: connection(f.service),
      credentialEnvironment: { OPENAI_API_KEY: '<local-test-only>' }, outputSchemaResolver: () => f.schema, rolePrompt: () => 'Use only controller checker tools.', checkerScratchVerifier: () => checker })
    record.environment = prepareProcessLaunchEnvironment(f.processAdapter, record.reservationId, { PATH: process.env.PATH }); record.signal = AbortSignal.timeout(90000)
    const result = await adapter.launch(record); successful(result); assert.equal(fs.readFileSync(candidate, 'utf8'), f.marker); assert.equal(fs.readFileSync(path.join(scratch, 'checker.txt'), 'utf8'), 'checked')
  })

  test(`${provider} closed native capability: crash recovery drains the durable owned child`, providerOptions, async t => {
    const f = await scenario(t, provider, { serviceOptions: { hold: true } }), pending = f.run({})
    try {
    await waitForNativeRequest(f.service, pending)
    assert.equal(f.owner.ownershipIdentities().length, 1, 'native process was not durably registered')
    const recovered = new ProcessOwner({ adapter: nativeProcessAdapter(f.registryPath, path.dirname(f.registryPath)), registryPath: f.registryPath, pollMs: 10 })
    await recovered.cancelAll({ reason: 'simulated controller crash recovery', graceMs: 0, killMs: 2000, waitForPending: true })
    await assert.rejects(pending, error => ['CHILD_CANCELLED', 'CHILD_RUNTIME_FAILURE', 'PROCESS_DRAIN_TIMEOUT'].includes(error.code) ||
      /durable terminal status|controller child/i.test(error.message)); assert.deepEqual(recovered.ownershipIdentities(), [])
    // The crashed controller object's local lease cache is deliberately stale;
    // a fresh drain reconciles it against the durable registry left empty by
    // recovery instead of treating an in-memory lease as a live process.
    await f.owner.cancelAll({ reason: 'post-recovery owner reconciliation', graceMs: 0, killMs: 2000, waitForPending: true })
    assert.deepEqual(f.owner.ownershipIdentities(), [])
    } finally {
      await f.owner.cancelAll({ reason: 'crash probe cleanup', graceMs: 0, killMs: 2000, waitForPending: true })
      await pending.catch(() => {})
    }
  })

  test(`${provider} closed native capability: model and effort reach native wire while unsupported assignment is refused`, providerOptions, async t => {
    const f = await scenario(t, provider), result = await f.run({ assignment: { model: 'controller-fixture', effort: 'high' } }); successful(result)
    assert.ok(f.service.requests.length > 0); assert.ok(f.service.requests.every(request => request.body.model === 'controller-fixture' && request.body.reasoning_effort === 'high'), JSON.stringify(f.service.requests.map(request => ({ model: request.body.model, effort: request.body.reasoning_effort }))))
    await assert.rejects(f.run({ reservationId: crypto.randomUUID(), assignment: { model: 'controller-fixture', effort: 'invalid-effort' } }), { code: 'PROFILE_INVALID' })
  })
}

for (const [provider, cli] of Object.entries(CLIS)) test(`${provider} native durable quota settles each tool turn exactly once`, { skip: !cli, timeout: 180000 }, async t => {
  const f = await scenario(t, provider)

  const starts = [], settlements = [], debits = [], unknown = []
  const result = await f.run({ assignment: { model: f.adapter.connection.model, effort: 'low' }, providerTokenLimit: 100000, finiteTokenBudget: false,
    onProviderRequestStarted: value => starts.push(value),
    onProviderRequestSettled: value => settlements.push(value),
    onUnknownProviderSpend: value => unknown.push(value),
    onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } },
  })
  assert.equal(result.ok, true)
  assert.equal(starts.length, 2)
  assert.equal(settlements.length, 2)
  assert.equal(debits.length, 2)
  assert.equal(unknown.length, 0)
  assert.ok(f.service.requests.every(request => request.body.max_completion_tokens === 2048 && request.body.max_tokens === undefined),
    `Pi omitted or changed the controller output cap: ${JSON.stringify(f.service.requests.map(request => ({ max_completion_tokens: request.body.max_completion_tokens, max_tokens: request.body.max_tokens })))}`)
  assert.ok(f.service.requests.every(request => request.body.reasoning_effort === 'low'),
    `Pi omitted or changed the assigned low effort: ${JSON.stringify(f.service.requests.map(request => request.body.reasoning_effort))}`)
  assert.deepEqual(result.usage, debits.at(-1).cumulative)
  for (let index = 0; index < 2; index++) {
    assert.equal(debits[index].evidence.requestOrdinal, index + 1)
    assert.equal(settlements[index].disposition, 'ACCOUNTED')
  }
})
