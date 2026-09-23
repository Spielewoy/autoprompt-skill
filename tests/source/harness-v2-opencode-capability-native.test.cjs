'use strict'

// Each provider runs the installed CLI through HarnessExecAdapter, ProcessOwner,
// bubblewrap command boundary and real MCP server. The HTTP model is only a
// deterministic tool-routing fixture. One scenario reuses its controller and
// native state across all capability assertions for that provider.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const controlled = require('../../scripts/harness-v2-controlled-tools.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessExecAdapter } = require('../../scripts/harness-v2-transport.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { modelService } = require('../helpers/harness-native-service.cjs')
const { privateDirectory, nativeProcessAdapter, nodeCommand, readCommand, withChallenge, requiredNativeCli, nativeEnvironment, cleanupNativeFixture, waitForNativeObservation } = require('../helpers/native-platform.cjs')

const selectedNativeCli = provider => process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`] ? requiredNativeCli(provider) : undefined
if (process.env.AUTOPROMPT_REQUIRE_NATIVE_TESTS === '1' && !process.env.AUTOPROMPT_OPENCODE_TEST_CLI && !process.env.AUTOPROMPT_KILO_TEST_CLI) throw new Error('AUTOPROMPT_OPENCODE_TEST_CLI or AUTOPROMPT_KILO_TEST_CLI is required; native certification cannot skip')
const providers = Object.freeze({ opencode: selectedNativeCli('opencode'), kilo: selectedNativeCli('kilo') })
// These shared scenarios include held/cancelled lifecycle cases. Kilo's
// serial witness and OpenCode's parallel witness exceed five minutes; the
// latter completed in 374 seconds with all functional witnesses available.
// Windows cold AppContainer setup completed every witness in 753 seconds.
// Its 900-second scenario allowance stays below the canary batch deadline;
// individual launches and controller cancellation retain their own bounds.
const CLOSED_NATIVE_CAPABILITY_TIMEOUT_MS = Object.freeze({ default: 300_000, kilo: 420_000, opencode: 420_000 })
function closedNativeCapabilityTimeout(provider) {
  return process.platform === 'win32' ? 900_000 : CLOSED_NATIVE_CAPABILITY_TIMEOUT_MS[provider] || CLOSED_NATIVE_CAPABILITY_TIMEOUT_MS.default
}

function closedCanaryBinding(provider) {
  const fields = ['AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT', 'AUTOPROMPT_CLOSED_CANARY_PROVIDER', 'AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID', 'AUTOPROMPT_CLOSED_CANARY_GENERATION', 'AUTOPROMPT_CLOSED_CANARY_CHALLENGE']
  const supplied = Object.fromEntries(fields.map(name => [name, process.env[name]]))
  if (!fields.some(name => supplied[name] !== undefined)) return null
  if (fields.some(name => typeof supplied[name] !== 'string' || !supplied[name])) throw new Error('closed canary ownership environment is incomplete')
  if (supplied.AUTOPROMPT_CLOSED_CANARY_PROVIDER !== provider || !path.isAbsolute(supplied.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT) || !/^\d+$/.test(supplied.AUTOPROMPT_CLOSED_CANARY_GENERATION) || !/^[A-Za-z0-9_-]{43}$/.test(supplied.AUTOPROMPT_CLOSED_CANARY_CHALLENGE)) throw new Error('closed canary ownership environment is invalid')
  return { root: path.resolve(supplied.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT), activationId: supplied.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID, generation: Number(supplied.AUTOPROMPT_CLOSED_CANARY_GENERATION), challenge: supplied.AUTOPROMPT_CLOSED_CANARY_CHALLENGE }
}
function canaryRegistry(provider, fallback) {
  const supplied = closedCanaryBinding(provider)
  if (!supplied) return fallback
  const root = privateDirectory(supplied.root), stat = fs.statSync(root)
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('closed canary ownership root is not private')
  const directory = privateDirectory(path.join(root, `${provider}-${crypto.randomUUID()}`))
  const registryPath = path.join(directory, 'processes.json'), registration = path.join(directory, 'registration.json')
  const body = { schemaVersion: 1, provider, activationId: supplied.activationId, generation: supplied.generation, challenge: supplied.challenge, registryPath }
  fs.writeFileSync(registration, JSON.stringify(body), { flag: 'wx', mode: 0o600 })
  return registryPath
}

function fixture(provider) {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-capability-native-`)))
  const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
  for (const dir of [target, controller, nativeRoot]) privateDirectory(dir)
  const closed = closedCanaryBinding(provider)
  const projection = core.createCanonicalMissionProjection('FIRST_CONTEXT_SENTINEL: use only the assigned controller command and return JSON.')
  const record = { activationId: closed?.activationId || `${provider}-closed-native-canary`, generation: closed?.generation || 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'closed-native-capability', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', canonicalMission: projection.canonicalMission, workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256(`${provider}-capability`) } } }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.physicalExecutionPolicy = { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }
  const scratch = path.join(nativeRoot, provider, native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch')
  const schema = path.join(controller, 'result.schema.json')
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }))
  return { root, target, controller, nativeRoot, record, projection, scratch, schema }
}
function connection(service, options = {}) {
  const providerId = options.providerId || 'fixture', modelId = options.modelId || 'model'
  return { model: `${providerId}/${modelId}`, providers: { [providerId]: { npm: options.npm || '@ai-sdk/openai-compatible', options: { baseURL: `${service.url}/v1`, apiKey: '<local-test-only>' }, models: { [modelId]: { name: 'Fixture Model', ...(options.wireModelId ? { id: options.wireModelId } : {}), limit: { context: 32768, output: 2048 }, variants: Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map(effort => [effort, { reasoningEffort: effort }])) } } } } }
}

function fixtureFailureDiagnostic(f, error) {
  // Capture the synthetic provider events before the real runner drains and
  // removes its private transcript. No ambient files or user logs are read.
  const output = { fixtureFailure: String(error.code || error.message).slice(0, 1024),
    details: error.details ? JSON.stringify(error.details).slice(0, 4096) : null,
    stderr: String(f.nativeStderr || '').slice(-8192), events: [...(f.nativeEvents || [])] }
  while (Buffer.byteLength(JSON.stringify(output)) > 65536) output.events.shift()
  console.error(JSON.stringify(output))
}

async function scenario(provider, options = {}) {
  const cli = providers[provider]; assert.ok(cli && fs.existsSync(cli), `AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI must name the installed ${provider} binary`)
  const sandbox = await boundary.probeCommandSandbox(); assert.equal(sandbox.supported, true, JSON.stringify(sandbox))
  const f = fixture(provider), candidate = path.join(f.target, 'candidate.txt'), secret = path.join(f.controller, 'private.txt'), marker = `${provider}-native-capability-${crypto.randomUUID()}`
  f.challenge = closedCanaryBinding(provider)?.challenge || crypto.randomBytes(32).toString('base64url')
  fs.writeFileSync(candidate, marker, { mode: 0o600 }); fs.writeFileSync(secret, 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE', { mode: 0o600 }); fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD', { mode: 0o600 })
  let service, owner
  try {
    service = await modelService(provider, options.tool || { name: controlled.toolName(provider, 'bash'), args: { command: readCommand(candidate) } }, { resetToolAfterCompletion: true, ...(options.serviceOptions || {}) })
    const binding = native.probeExecutable({ provider, executable: cli })
    const registryPath = canaryRegistry(provider, path.join(f.controller, 'processes.json')), processAdapter = nativeProcessAdapter(registryPath, path.dirname(registryPath)), ownerValue = new ProcessOwner({ adapter: processAdapter, registryPath, pollMs: 10 })
    owner = ownerValue
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
    const adapter = new HarnessExecAdapter({ provider, runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target, connection: connection(service, options.connection), credentialEnvironment: { OPENAI_API_KEY: '<local-test-only>', KILO_API_KEY: '<local-test-only>' }, outputSchemaResolver: () => f.schema, rolePrompt: () => 'Use only assigned controller tools and return one JSON object.' })
    const run = async overrides => {
      const record = { ...f.record, ...overrides }
      record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, nativeEnvironment())
      record.signal = overrides?.signal || AbortSignal.timeout(process.platform === 'win32' ? 300_000 : 90_000)
      try { return await adapter.launch(record) }
      catch (error) { fixtureFailureDiagnostic(f, error); throw error }
    }
    let closed = false
    return { ...f, provider, candidate, secret, marker, service, binding, owner, processAdapter, registryPath, adapter, run,
      async close() { if (closed) return; closed = true; await cleanupNativeFixture(f, provider, { stop: () => owner.cancelAll({ reason: `${provider} capability cleanup`, graceMs: 0, killMs: 2000, waitForPending: true }), close: () => service.close() }) } }
  } catch (error) {
    try { await cleanupNativeFixture(f, provider, { stop: () => owner?.cancelAll({ reason: `${provider} capability setup failed`, graceMs: 0, killMs: 2000, waitForPending: true }), close: () => service?.close() }) } catch {}
    throw error
  }
}
function good(result) { assert.equal(result.ok, true); assert.ok(result.transportEvidence.eventCount > 0); assert.match(result.contextId, /^[a-zA-Z0-9_-]+$/); assert.match(result.toolBoundaryEvidence.policySha256, /^[a-f0-9]{64}$/) }
function command(f, value) { f.service.tool.args.command = value }

async function runScenario(provider) {
  const hostile = await scenario(provider, { tool: { name: 'Task', args: { prompt: 'unauthorized nested dispatch' } }, serviceOptions: { forceFirstTool: true } })
  let f, listener
  try {
    await assert.rejects(hostile.run({}), { code: 'ROLE_POLICY_DENIED' })
    f = await scenario(provider)
    // A challenge is included in the controller-produced receipt bytes, not
    // merely in test metadata. This binds each observed tool exchange to the
    // active closed-canary invocation.
    const scratchFile = path.join(f.scratch, 'isolation.txt'), readback = path.join(f.scratch, 'receipt-readback.txt')
    const expectedReceipt = `${f.marker}\nCLOSED_CANARY_CHALLENGE:${f.challenge}\n`
    let contacted = false; listener = net.createServer(socket => { contacted = true; socket.destroy() })
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
    const port = listener.address().port, probe = `const n=require('node:net');const s=n.connect(${port},'127.0.0.1');s.on('connect',()=>process.exit(19));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),700)`
    command(f, withChallenge(`${readCommand(f.candidate)}; ${nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(readback)}, require('node:fs').readFileSync(${JSON.stringify(f.candidate)}, 'utf8') + ${JSON.stringify(`\nCLOSED_CANARY_CHALLENGE:${f.challenge}\n`)}); require('node:fs').writeFileSync(${JSON.stringify(scratchFile)}, 'scratch-ok'); try { require('node:fs').writeFileSync(${JSON.stringify(f.candidate)}, 'nope'); process.exit(18) } catch {} ; try { require('node:fs').readFileSync(${JSON.stringify(f.secret)}); process.exit(20) } catch {} ; ${probe}`)}`, f.challenge))
    const first = await f.run({ assignment: { model: 'fixture/model', effort: 'low' } }); good(first)
    assert.equal(fs.readFileSync(readback, 'utf8'), expectedReceipt, 'controller receipt body did not bind the exact candidate bytes and challenge')
    assert.equal(fs.readFileSync(f.candidate, 'utf8'), f.marker); assert.equal(fs.readFileSync(scratchFile, 'utf8'), 'scratch-ok'); assert.equal(contacted, false); assert.equal(first.toolBoundaryEvidence.receiptHashes.length, 1)
    const names = f.service.requests.filter(item => Array.isArray(item.body.tools)).flatMap(item => item.body.tools.map(tool => tool.function?.name || tool.name))
    assert.ok(names.includes(controlled.toolName(provider, 'bash'))); assert.ok(names.every(name => controlled.decodeToolName(provider, name)), JSON.stringify(names)); assert.equal(names.some(name => /agent|task|skill/i.test(name)), false)
    const privateAbsent = !f.service.requests.some(item => /AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD|PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE/.test(JSON.stringify(item.body)))
    assert.equal(privateAbsent, true)
    assert.ok(f.service.requests.some(item => item.path.includes('/chat/completions'))); assert.ok(f.service.requests.some(item => item.body.reasoning_effort === 'low'), JSON.stringify(f.service.requests.map(item => ({ path: item.path, model: item.body.model, effort: item.body.reasoning_effort }))))
    assert.throws(() => native.createLaunch({ provider, executable: f.binding.path, home: path.join(f.root, 'invalid'), sessionRoot: path.join(f.root, 'invalid-session'), targetPath: f.target, cwd: f.target, prompt: 'x', input: 'x', connection: connection(f.service), credentials: {}, environment: { PATH: process.env.PATH }, readOnly: true, effort: 'invalid' }), { code: 'PROFILE_INVALID' })
    command(f, readCommand(f.candidate)); const before = f.service.requests.length
    const resumed = await f.run({ reservationId: crypto.randomUUID(), continuationId: first.contextId, assignment: { model: 'fixture/model', effort: 'high' } }); good(resumed); assert.equal(resumed.contextId, first.contextId)
    const continuationCarriesPrompt = f.service.requests.slice(before).some(item => JSON.stringify(item.body).includes('FIRST_CONTEXT_SENTINEL')); assert.equal(continuationCarriesPrompt, true)
    const foreign = privateDirectory(path.join(f.root, 'foreign'))
    let foreignCode
    const foreignReservation = crypto.randomUUID()
    try { await f.adapter.launch({ ...f.record, reservationId: foreignReservation, continuationId: first.contextId, workingDirectory: foreign, environment: prepareProcessLaunchEnvironment(f.processAdapter, foreignReservation, nativeEnvironment()), signal: AbortSignal.timeout(30000) }) } catch (error) { foreignCode = error.code }
    assert.equal(foreignCode, 'SESSION_ID_MISMATCH')
    let peak = 0; const monitor = setInterval(() => { peak = Math.max(peak, f.owner.ownershipIdentities().length) }, 5)
    let siblings; try { siblings = await Promise.all([0, 1].map(index => { const ids = { sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: `sibling-${index}` }; return f.run({ ...ids, missionBinding: core.bindCanonicalMissionForChild(f.projection, { ...f.record, ...ids, sourceRequestHash: f.projection.sourceRequestHash, requestEnvelopeHash: f.record.dispatch.requestPointer.hash }) }) })) } finally { clearInterval(monitor) }
    assert.ok(siblings.every(item => item.ok)); assert.equal(new Set(siblings.map(item => item.contextId)).size, 2); assert.ok(peak >= 2); assert.deepEqual(f.owner.ownershipIdentities(), [])
    const originalTool = f.service.tool.args.command; command(f, readCommand(f.candidate))
    const delayed = await scenario(provider, { serviceOptions: { holdFirstMessage: true } })
    let pending, fastResult, recoveredLive
    try {
      const abort = new AbortController(); pending = delayed.run({ signal: abort.signal }); pending.catch(() => {})
      const observationMs = process.platform === 'win32' ? 180000 : 60000
      await waitForNativeObservation(pending, () => delayed.service.firstMessageHeld, observationMs, 'the held native model response before recovery')
      const recoveredOwner = new ProcessOwner({ adapter: nativeProcessAdapter(delayed.registryPath, path.dirname(delayed.registryPath)), registryPath: delayed.registryPath, pollMs: 10 }); await recoveredOwner.recoverReservations()
      const heldIdentity = recoveredOwner.ownershipIdentities(); assert.equal(heldIdentity.length, 1, 'fresh owner did not recover the persisted live child'); recoveredLive = heldIdentity[0]
      const fastIds = { sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'fast-sibling' }
      const fast = delayed.run({ ...fastIds, missionBinding: core.bindCanonicalMissionForChild(delayed.projection, { ...delayed.record, ...fastIds, sourceRequestHash: delayed.projection.sourceRequestHash, requestEnvelopeHash: delayed.record.dispatch.requestPointer.hash }) })
      fast.catch(() => {})
      await waitForNativeObservation(fast, () => delayed.owner.ownershipIdentities().length >= 2, observationMs, 'both owned native children before recovery cancellation')
      assert.ok(delayed.owner.ownershipIdentities().length >= 2, 'fast sibling did not overlap the held native child')
      const heldRecord = recoveredOwner.listRecords().find(record => record.reservationId === delayed.record.reservationId && record.groupIdentity === recoveredLive.id)
      assert.ok(heldRecord?.ownershipId, 'fresh owner must bind cancellation to the recovered held group')
      const heldTerminal = await recoveredOwner.cancelGroup(heldRecord.ownershipId, { reason: 'fresh-owner crash recovery', graceMs: 0, killMs: 2000 })
      assert.equal(heldTerminal.status, 'CANCELLED')
      assert.equal(heldTerminal.groupIdentity, recoveredLive.id)
      abort.abort()
      await assert.rejects(pending, { code: 'CHILD_CANCELLED' }); fastResult = await fast; good(fastResult); assert.deepEqual(delayed.owner.ownershipIdentities(), [])
    } finally { await delayed.close() }
    command(f, originalTool)
    const frozen = privateDirectory(path.join(f.root, 'frozen')), checkerScratch = privateDirectory(path.join(f.root, 'checker')); for (const name of ['tmp', 'output', 'cache']) privateDirectory(path.join(checkerScratch, name))
    const frozenFile = path.join(frozen, 'candidate.txt'); fs.writeFileSync(frozenFile, f.marker)
    const checkerBoundary = { schemaVersion: 1, capability: native.sha256('opencode-kilo-checker'), runId: 'closed-checker', checkerId: `${provider}-checker`, candidateHash: native.sha256(f.marker), frozenCandidateRoot: frozen, writableScratchRoot: checkerScratch, temporaryRoot: path.join(checkerScratch, 'tmp'), outputRoot: path.join(checkerScratch, 'output'), cacheRoot: path.join(checkerScratch, 'cache') }
    command(f, `${readCommand(frozenFile)}; ${nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(path.join(checkerScratch, 'checked.txt'))}, 'checked'); try { require('node:fs').writeFileSync(${JSON.stringify(frozenFile)}, 'wrong'); process.exit(19) } catch {}`)}`)
    const checker = new HarnessExecAdapter({ provider, runner: f.adapter.runner, nativeRoot: f.nativeRoot, executableBinding: f.binding, targetPath: checkerScratch, connection: connection(f.service), credentialEnvironment: { OPENAI_API_KEY: '<local-test-only>', KILO_API_KEY: '<local-test-only>' }, outputSchemaResolver: () => f.schema, rolePrompt: () => 'Use only controller checker tools and return one JSON object.', checkerScratchVerifier: () => checkerBoundary })
    const checkerRecord = { ...f.record, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', workingDirectory: checkerScratch, canonicalTargetPath: frozen, candidateHash: checkerBoundary.candidateHash, checkerScratchBoundary: checkerBoundary, physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } } }
    checkerRecord.environment = prepareProcessLaunchEnvironment(f.processAdapter, checkerRecord.reservationId, nativeEnvironment()); checkerRecord.signal = AbortSignal.timeout(90000); checkerRecord.missionBinding = core.bindCanonicalMissionForChild(f.projection, { ...checkerRecord, sourceRequestHash: f.projection.sourceRequestHash, requestEnvelopeHash: f.record.dispatch.requestPointer.hash }); const checked = await checker.launch(checkerRecord); good(checked)
    assert.equal(fs.readFileSync(frozenFile, 'utf8'), f.marker); assert.equal(fs.readFileSync(path.join(checkerScratch, 'checked.txt'), 'utf8'), 'checked')
    const registry = JSON.parse(fs.readFileSync(f.registryPath, 'utf8')); assert.ok(JSON.stringify(registry).includes(`native-${provider}-`)); const completedOwner = new ProcessOwner({ adapter: nativeProcessAdapter(f.registryPath, path.dirname(f.registryPath)), registryPath: f.registryPath, pollMs: 10 }); await completedOwner.recoverReservations(); assert.deepEqual(completedOwner.ownershipIdentities(), [])
    const recovery = await f.run({ sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() }); good(recovery); assert.deepEqual(f.owner.ownershipIdentities(), [])
    const receiptHash = first.toolBoundaryEvidence.receiptHashes[0]
    const witnesses = {
      isolation: { candidateHash: native.sha256(fs.readFileSync(f.candidate)), receiptBody: expectedReceipt, receiptHash, scratch: fs.readFileSync(scratchFile, 'utf8'), networkContacted: contacted },
      topologyEnforcement: { provider, deniedCode: 'ROLE_POLICY_DENIED', advertisedTools: names, policySha256: first.toolBoundaryEvidence.policySha256 },
      privateSkillRoot: { ambientAndPrivateAbsent: privateAbsent, requestCount: f.service.requests.length, challenge: f.challenge },
      eventStreaming: { eventCount: first.transportEvidence.eventCount, eventStreamHash: first.transportEvidence.eventStreamHash, contextId: first.contextId },
      toolOutputCapture: { receiptHash, receiptBody: expectedReceipt, marker: f.marker, readbackHash: native.sha256(fs.readFileSync(readback)) },
      stableChildIdentity: { siblingContexts: siblings.map(item => item.contextId), peakOwnedChildren: peak },
      sameContextContinuation: { firstContextId: first.contextId, resumedContextId: resumed.contextId, foreignDeniedCode: foreignCode, continuationCarriesPrompt },
      cancellation: { recoveredIdentity: recoveredLive, fastContextId: fastResult.contextId, overlapObserved: true, pendingCancelCode: 'CHILD_CANCELLED' },
      isolatedChecking: { frozenHash: native.sha256(fs.readFileSync(frozenFile)), checked: fs.readFileSync(path.join(checkerScratch, 'checked.txt'), 'utf8'), checkerContextId: checked.contextId },
      processOwnership: { registryHash: native.sha256(JSON.stringify(registry)), recoveredCompletedChildren: completedOwner.ownershipIdentities().length, recoveryContextId: recovery.contextId },
      modelRouting: { endpointObserved: f.service.requests.some(item => item.path.includes('/chat/completions')), lowEffortObserved: f.service.requests.some(item => item.body.reasoning_effort === 'low'), invalidEffortCode: 'PROFILE_INVALID' }
    }
    return Object.freeze(witnesses)
  } finally {
    if (listener) await new Promise(resolve => listener.close(resolve))
    if (f) await f.close()
    await hostile.close()
  }
}

const scenarioRuns = new Map()
function witnessesFor(provider) {
  if (!scenarioRuns.has(provider)) scenarioRuns.set(provider, runScenario(provider))
  return scenarioRuns.get(provider)
}
const capabilityChecks = Object.freeze({
  isolation: value => { assert.match(value.candidateHash, /^[a-f0-9]{64}$/); assert.match(value.receiptHash, /^[a-f0-9]{64}$/); assert.equal(value.scratch, 'scratch-ok'); assert.equal(value.networkContacted, false); assert.match(value.receiptBody, /^.+\nCLOSED_CANARY_CHALLENGE:[A-Za-z0-9_-]{43}\n$/) },
  topologyEnforcement: value => { assert.equal(value.deniedCode, 'ROLE_POLICY_DENIED'); assert.ok(value.advertisedTools.length); assert.ok(value.advertisedTools.every(name => controlled.decodeToolName(value.provider, name))); assert.match(value.policySha256, /^[a-f0-9]{64}$/) },
  privateSkillRoot: value => { assert.equal(value.ambientAndPrivateAbsent, true); assert.ok(value.requestCount > 0); assert.match(value.challenge, /^[A-Za-z0-9_-]{43}$/) },
  eventStreaming: value => { assert.ok(value.eventCount > 0); assert.match(value.eventStreamHash, /^[a-f0-9]{64}$/); assert.match(value.contextId, /^[A-Za-z0-9_-]+$/) },
  toolOutputCapture: value => { assert.match(value.receiptHash, /^[a-f0-9]{64}$/); assert.ok(value.receiptBody.includes(value.marker)); assert.match(value.readbackHash, /^[a-f0-9]{64}$/) },
  stableChildIdentity: value => { assert.equal(new Set(value.siblingContexts).size, 2); assert.ok(value.peakOwnedChildren >= 2) },
  sameContextContinuation: value => { assert.equal(value.firstContextId, value.resumedContextId); assert.equal(value.foreignDeniedCode, 'SESSION_ID_MISMATCH'); assert.equal(value.continuationCarriesPrompt, true) },
  cancellation: value => { assert.ok(value.recoveredIdentity && value.recoveredIdentity.id); assert.match(value.fastContextId, /^[A-Za-z0-9_-]+$/); assert.equal(value.overlapObserved, true); assert.equal(value.pendingCancelCode, 'CHILD_CANCELLED') },
  isolatedChecking: value => { assert.match(value.frozenHash, /^[a-f0-9]{64}$/); assert.equal(value.checked, 'checked'); assert.match(value.checkerContextId, /^[A-Za-z0-9_-]+$/) },
  processOwnership: value => { assert.match(value.registryHash, /^[a-f0-9]{64}$/); assert.equal(value.recoveredCompletedChildren, 0); assert.match(value.recoveryContextId, /^[A-Za-z0-9_-]+$/) },
  modelRouting: value => { assert.equal(value.endpointObserved, true); assert.equal(value.lowEffortObserved, true); assert.equal(value.invalidEffortCode, 'PROFILE_INVALID') }
})

for (const provider of Object.keys(providers)) {
  for (const capability of Object.keys(capabilityChecks)) {
    test(`${provider} closed native capability: ${capability}`, { skip: !providers[provider], timeout: closedNativeCapabilityTimeout(provider) }, async () => {
      const value = (await witnessesFor(provider))[capability]
      assert.ok(value, `missing real witness for ${provider}/${capability}`)
      capabilityChecks[capability](value)
    })
  }
}

for (const [provider, cli] of Object.entries(providers)) test(`${provider} native durable quota settles each tool turn exactly once`, { skip: !cli, timeout: 180000 }, async t => {
  const f = await scenario(provider)
  t.after(() => f.close())
  const starts = [], settlements = [], debits = [], unknown = []
  const result = await f.run({ assignment: { model: f.adapter.connection.model, effort: 'low' }, providerTokenLimit: 100000, finiteTokenBudget: false,
    onProviderRequestStarted: value => starts.push(value),
    onProviderRequestSettled: value => settlements.push(value),
    onUnknownProviderSpend: value => unknown.push(value),
    onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } },
  })
  assert.equal(result.ok, true)
  assert.ok(f.service.requests.length > 0)
  for (const { body } of f.service.requests) {
    const fields = ['max_tokens', 'max_completion_tokens'].filter(field => Object.hasOwn(body, field))
    assert.equal(fields.length, 1, `${provider} must send exactly one output cap`)
    assert.equal(body[fields[0]], 2048, `${provider} must preserve its configured model output ceiling`)
    assert.equal(body.reasoning_effort, 'low')
  }
  assert.equal(starts.length, 2)
  assert.equal(settlements.length, 2)
  assert.equal(debits.length, 2)
  assert.equal(unknown.length, 0)
  assert.deepEqual(result.usage, debits.at(-1).cumulative)
  for (let index = 0; index < 2; index++) {
    assert.equal(debits[index].evidence.requestOrdinal, index + 1)
    assert.equal(settlements[index].disposition, 'ACCOUNTED')
  }
})

test('kilo OpenRouter Chat projection restores the configured Luna cap before exact quota admission', { skip: !providers.kilo, timeout: 180000 }, async t => {
  const f = await scenario('kilo', { connection: { providerId: 'openrouter', modelId: 'openai/gpt-5.6-luna', npm: '@ai-sdk/openai-compatible' } })
  t.after(() => f.close())
  const upstream = f.adapter.connection.providers.openrouter.options.baseURL
  f.adapter.connection = {
    ...f.adapter.connection,
    providers: {
      ...f.adapter.connection.providers,
      openrouter: {
        ...f.adapter.connection.providers.openrouter,
        options: { ...f.adapter.connection.providers.openrouter.options, baseURL: 'https://openrouter.ai/api/v1' },
      },
    },
  }
  const nativeFetch = global.fetch, outbound = []
  global.fetch = async (target, init) => {
    assert.equal(String(target), 'https://openrouter.ai/api/v1/chat/completions')
    const body = JSON.parse(String(init.body)); outbound.push(body)
    return nativeFetch(`${upstream}/chat/completions`, init)
  }
  t.after(() => { global.fetch = nativeFetch })
  const starts = [], settlements = [], debits = [], unknown = []
  const result = await f.run({ assignment: { model: 'openrouter/openai/gpt-5.6-luna', effort: 'low' }, providerTokenLimit: 100000, finiteTokenBudget: false,
    onProviderRequestStarted: value => starts.push(value),
    onProviderRequestSettled: value => settlements.push(value),
    onUnknownProviderSpend: value => unknown.push(value),
    onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } },
  })
  good(result)
  assert.deepEqual(f.service.errors, [])
  assert.equal(outbound.length, 2)
  assert.ok(outbound.every(body => body.model === 'openai/gpt-5.6-luna' && body.max_tokens === 2048 && !Object.hasOwn(body, 'max_completion_tokens')))
  const advertised = outbound.flatMap(body => Array.isArray(body.tools) ? body.tools : [])
  assert.ok(advertised.length > 0, 'native Chat request omitted the controlled typed tools')
  assert.ok(advertised.every(tool => controlled.decodeToolName('kilo', tool.name || tool.function?.name)), JSON.stringify(advertised.map(tool => tool.name || tool.function?.name)))
  assert.equal(starts.length, 2); assert.equal(settlements.length, 2); assert.equal(debits.length, 2); assert.deepEqual(unknown, [])
  assert.deepEqual(result.usage, debits.at(-1).cumulative)
})

test('kilo OpenRouter selector projects its configured model id before exact quota admission', { skip: !providers.kilo, timeout: 180000 }, async t => {
  const f = await scenario('kilo', { connection: { providerId: 'openrouter', modelId: 'selector', wireModelId: 'openai/gpt-5.6-luna', npm: '@ai-sdk/openai-compatible' } })
  t.after(() => f.close())
  const upstream = f.adapter.connection.providers.openrouter.options.baseURL
  f.adapter.connection = { ...f.adapter.connection, providers: { ...f.adapter.connection.providers, openrouter: {
    ...f.adapter.connection.providers.openrouter, options: { ...f.adapter.connection.providers.openrouter.options, baseURL: 'https://openrouter.ai/api/v1' },
  } } }
  const nativeFetch = global.fetch, outbound = []
  global.fetch = async (target, init) => {
    assert.equal(String(target), 'https://openrouter.ai/api/v1/chat/completions')
    outbound.push(JSON.parse(String(init.body)))
    return nativeFetch(`${upstream}/chat/completions`, init)
  }
  t.after(() => { global.fetch = nativeFetch })
  const result = await f.run({ assignment: { model: 'openrouter/selector', effort: 'low' }, providerTokenLimit: 100000, finiteTokenBudget: false,
    onProviderRequestStarted() {}, onProviderRequestSettled() {}, onUnknownProviderSpend() {}, onUsageDelta: () => ({ continue: true }),
  })
  good(result)
  assert.equal(outbound.length, 2)
  assert.ok(outbound.every(body => body.model === 'openai/gpt-5.6-luna'))
})

test('kilo OpenAI Responses profile preserves GPT-5 output cap but requests encrypted reasoning state', { skip: !providers.kilo, timeout: 180000 }, async t => {
  const f = await scenario('kilo', { connection: { providerId: 'openrouter', modelId: 'openai/gpt-5.6-luna', npm: '@ai-sdk/openai' }, serviceOptions: { responses: true, noTool: true } })
  t.after(() => f.close())
  const result = await f.run({ assignment: { model: 'openrouter/openai/gpt-5.6-luna', effort: 'low' } })
  good(result)
  assert.equal(f.service.errors.length, 0, JSON.stringify(f.service.errors))
  assert.equal(f.service.requests.length, 1)
  for (const request of f.service.requests) {
    assert.equal(request.path, '/v1/responses')
    assert.equal(request.body.model, 'openai/gpt-5.6-luna')
    assert.equal(request.body.max_output_tokens, 2048)
    assert.deepEqual(request.body.include, ['reasoning.encrypted_content'])
    assert.equal(Object.hasOwn(request.body, 'max_tokens'), false)
    assert.equal(Object.hasOwn(request.body, 'max_completion_tokens'), false)
  }
})
