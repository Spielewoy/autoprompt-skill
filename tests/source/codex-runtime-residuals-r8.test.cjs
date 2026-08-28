#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const { CentralScheduler } = require(path.join(WORKFLOW, 'scheduler.js'))
const requestEnvelope = require(path.join(WORKFLOW, 'request-envelope.js'))
const {
  CodexSupervisorRuntime, RolePolicy, billableModelTokens, createCodexJsonlAccumulator, roadmapAuthorArtifact,
  runCodexSupervisorEntryAdapter, runCodexTopLevelEntryAdapter, selectWorkRecipe,
} = require(path.join(WORKFLOW, 'phase-budget.js'))

const H = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const ZERO = Object.freeze({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
const CAPABILITIES = Object.freeze({
  eventStreaming: true, toolOutputCapture: true, stableChildIdentity: true,
  sameContextContinuation: true, isolatedChecking: true, cancellation: true,
})

test('token accounting does not add reasoning twice to billed model usage', () => {
  assert.equal(billableModelTokens({
    noncachedInput: 11, cachedInput: 13, output: 17, reasoning: 7,
  }), 41)
})

function authority(scheduler, id) {
  return scheduler.issueLaunchAuthority({
    callerRole: 'autoprompt.v2.run-owner', sessionId: `root:${id}`,
    runId: 'runtime-residual-r8', generation: 1, providerCapabilities: CAPABILITIES,
  })
}

test('RUN-023 heartbeat watermark stays bounded and snapshots history only on demand', () => {
  const accumulator = createCodexJsonlAccumulator()
  for (let index = 0; index < 20_000; index += 1) {
    accumulator.push(JSON.stringify({ type: 'item.started', index }))
    const watermark = accumulator.watermark()
    assert.equal(watermark.eventCount, index + 1)
    assert.equal(Object.hasOwn(watermark, 'events'), false)
  }
  assert.equal(accumulator.snapshot().events.length, 256)
})

test('RUN-018/022 arbitrary explicit fingerprints cannot reset equivalent retry admission', async () => {
  const scheduler = new CentralScheduler({ route: 'DIRECT', runIdentity: { runId: 'runtime-residual-r8', generation: 1 } })
  const first = await scheduler.acquireWithAuthority(authority(scheduler, 'one'), {
    workItemId: 'attempt-one', equivalenceKey: 'same-poison', role: 'ap-worker',
    progressFingerprint: 'caller-label-one', estimate: ZERO,
  })
  first.complete(ZERO)
  await assert.rejects(
    scheduler.acquireWithAuthority(authority(scheduler, 'two'), {
      workItemId: 'attempt-two', equivalenceKey: 'same-poison', role: 'ap-worker',
      progressFingerprint: 'caller-label-two', estimate: ZERO,
    }),
    error => error.code === 'RETRY_PROGRESS_EVIDENCE_REQUIRED',
  )
})

test('TRACE-006 late first product signal is enforced and reports the exact blocker', () => {
  const scheduler = new CentralScheduler({ route: 'DIRECT', runIdentity: { runId: 'runtime-residual-r8', generation: 1 } })
  const measurement = scheduler.recordFirstProductSignal({
    kind: 'PRODUCT_EDIT', elapsedMs: 360_001, evidenceHash: H('late'), reason: 'policy service denied the role',
  })
  assert.equal(measurement.withinCeiling, false)
  assert.equal(measurement.reason, 'policy service denied the role')
  assert.equal(scheduler.getMetrics().economics.firstProductSignal.withinCeiling, false)
  assert.equal(scheduler.getMetrics().economics.firstProductSignal.reason, 'policy service denied the role')
})

test('GATE selection rejects malformed null/object overlays without duplicate violations or crashes', () => {
  const result = selectWorkRecipe({
    baseWorkType: 'implement-build', resultFormat: 'new-build',
    artifactOverlays: null, acceptanceOverlays: null, riskOverlays: {}, riskEvidence: {},
  })
  assert.equal(result.status, 'UNSUPPORTED_SHAPE')
  assert.equal(new Set(result.errors).size, result.errors.length)
})

test('LAYER-008 accepts each distinct scout correction exactly once', () => {
  const corrections = [
    { workItemId: 'scout-1', correction: 'Bind the API.', evidenceHash: H('one') },
    { workItemId: 'scout-2', correction: 'Bind the UI.', evidenceHash: H('two') },
  ]
  assert.deepEqual(
    roadmapAuthorArtifact({ behaviorChanged: ['Bind the API.', 'Bind the UI.'] }, corrections)
      .scoutCorrections.map(item => item.workItemId),
    ['scout-1', 'scout-2'],
  )
  assert.throws(() => roadmapAuthorArtifact(
    { behaviorChanged: ['Same correction.'] },
    corrections.map(item => ({ ...item, correction: 'Same correction.' })),
  ), error => error.code === 'SCOUT_CORRECTION_DUPLICATE')
  assert.throws(() => roadmapAuthorArtifact(
    { behaviorChanged: ['Bind the API.', 'Bind the API.', 'Bind the UI.'] }, corrections,
  ), error => error.code === 'SCOUT_CORRECTION_NOT_MERGED')
})

test('representative role/policy admission is controller-attested without a model launch', async () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(runtime, {
    representativePolicyProbe: null,
    rolePolicy: new RolePolicy(),
    route: 'DIRECT',
    activation: { id: 'activation-r8', generation: 1 },
    requestPointer: { hash: H('request-envelope') },
    rootCallers: { runOwner: { logicalRole: 'run-owner', physicalRole: 'autoprompt.v2.run-owner', sessionId: 'root', runId: 'runtime-residual-r8', generation: 1 } },
    providerCapabilities: CAPABILITIES,
    diagnosticWorkerLaunches: 0,
    options: { runId: 'runtime-residual-r8' },
  })
  runtime.launchChild = async () => { throw new Error('controller policy validation must not launch a model') }
  assert.equal((await runtime._runRepresentativePolicyProbe()).verified, true)
  assert.equal(runtime.diagnosticWorkerLaunches, 0)
})

test('resume reopens the exact durable representative controller attestation instead of relaunching it', async () => {
  const workItemId = 'representative-role-policy-probe'
  const runId = 'runtime-residual-r8'
  const requestHash = H('request-envelope')
  const rolePolicy = new RolePolicy()
  const physicalRole = rolePolicy.validate({
    parent: 'run-owner', child: 'diagnostic-probe', route: 'DIRECT',
  }).definition.physicalId
  const stored = new Map()
  const fresh = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(fresh, {
    representativePolicyProbe: null,
    rolePolicy,
    route: 'DIRECT',
    activation: { id: 'activation-r8', generation: 1 },
    requestPointer: { hash: requestHash },
    recoveryCompletedWorkIds: new Set(),
    diagnosticWorkerLaunches: 0,
    record: { write(relative, bytes) { stored.set(relative, JSON.parse(bytes)) } },
    options: { runId },
  })
  let launches = 0
  fresh.launchChild = async () => { launches += 1; throw new Error('controller attestation must not launch') }
  const first = await fresh._runRepresentativePolicyProbe()
  assert.equal(first.verified, true)
  assert.equal(launches, 0)

  const resultPath = `work/results/${H(workItemId)}.json`
  const attestation = stored.get(resultPath)
  assert.equal(attestation.generation, 1)
  assert.equal(attestation.kind, 'representative-policy-controller-attestation')
  assert.deepEqual(attestation.claims, ['ROLE_SELECTION_ADMITTED', 'PROVIDER_ROLE_BOUND'])
  assert.equal(Object.hasOwn(attestation, 'result'), false)
  assert.equal(Object.hasOwn(attestation, 'commands'), false)
  assert.equal(Object.hasOwn(attestation, 'findingIds'), false)
  assert.doesNotMatch(JSON.stringify(attestation), /AP-(?:TRACE|DESIGN|RUN)-[0-9]{3}/u)
  const resumed = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(resumed, {
    representativePolicyProbe: null,
    rolePolicy: new RolePolicy(),
    route: 'DIRECT',
    activation: { id: 'activation-r8', generation: 2 },
    requestPointer: { hash: requestHash },
    recoveryCompletedWorkIds: new Set([workItemId]),
    diagnosticWorkerLaunches: 0,
    options: { runId, readResult: id => id === workItemId ? stored.get(resultPath) : null },
  })
  resumed.launchChild = async () => { throw new Error('durable completed probe must not relaunch') }
  const recovered = await resumed._runRepresentativePolicyProbe()
  assert.equal(recovered.verified, true)
  assert.equal(recovered.recoveredFromGeneration, 1)
  assert.equal(resumed.diagnosticWorkerLaunches, 0)

  const forged = { ...stored.get(resultPath), requestEnvelopeHash: H('foreign-request') }
  const denied = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(denied, {
    representativePolicyProbe: null,
    rolePolicy: new RolePolicy(), route: 'DIRECT',
    activation: { id: 'activation-r8', generation: 2 }, requestPointer: { hash: requestHash },
    recoveryCompletedWorkIds: new Set([workItemId]), diagnosticWorkerLaunches: 0,
    options: { runId, readResult: () => forged },
  })
  denied.launchChild = async () => { throw new Error('forged completed probe must not relaunch') }
  await assert.rejects(denied._runRepresentativePolicyProbe(), error => error.code === 'CRASH_ADOPTION_CONFLICT')
})

test('COST-020 crash adoption rebinds one replacement root, accounts its predecessor, and rejects a third live root', async () => {
  const oldRootId = 'old-root-context'
  const replacementRootId = 'replacement-root-context'
  const scheduler = new CentralScheduler({
    route: 'DIRECT', rootContextId: oldRootId,
    runIdentity: { runId: 'runtime-residual-r8', generation: 1 },
  })
  const lease = await scheduler.acquireWithAuthority(authority(scheduler, 'crash-root'), {
    workItemId: 'crash-root-work', equivalenceKey: 'crash-root-work', role: 'ap-worker', estimate: ZERO,
  })
  scheduler.bindCrashContinuation(lease, {
    reservationId: 'reservation-cost-020', sessionId: 'session-cost-020',
    continuationId: '20202020-2020-4020-8020-202020202020',
    frontier: { resumeState: 'CHECK_WORK', nextReadyWorkIds: [], openCheckIds: [], acceptedResultIds: [] },
  })
  const checkpoint = scheduler.exportCrashCheckpoint({ ownerSessionId: 'old-owner-cost-020' })
  const resumed = new CentralScheduler({
    settings: checkpoint.schedulerState.settings, rootContextId: replacementRootId,
    runIdentity: { runId: 'runtime-residual-r8', generation: 2 },
  })
  const adopted = resumed.adoptCrashCheckpoint(checkpoint, {
    ownerSessionId: 'old-owner-cost-020',
    recoveryContext: {
      priorOwner: { ownerId: 'old-owner-cost-020', processesDrained: true },
      frontier: { acceptedResultIds: [checkpoint.stateHash] },
    },
  })
  assert.deepEqual(adopted.rootContext, {
    mainContexts: 2, retainedRootContextId: oldRootId, activeRootContextId: replacementRootId,
  })
  assert.equal(resumed.getMetrics().counters.mainContexts, 2)
  assert.deepEqual(resumed.getMetrics().rootContextBinding, {
    activeRootContextId: replacementRootId, predecessorRootContextId: oldRootId, generation: 2,
  })
  assert.equal(resumed.registerRootContext(replacementRootId, { replace: true }), false)
  assert.equal(
    resumed.exportCrashCheckpoint({ ownerSessionId: 'replacement-owner-cost-020' }).schedulerState.rootContextId,
    replacementRootId,
  )
  assert.throws(
    () => resumed.registerRootContext('third-root-context', { replace: true }),
    error => error.code === 'ROOT_NOT_DRAINED',
  )
  adopted.leases[lease.id].complete(ZERO)
})

test('DESIGN-045 user steering appends, rebinds, and rechecks the live request pointer', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-r8-steering-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const requestDir = path.join(directory, 'request')
  requestEnvelope.createRequestEnvelope(requestDir, [{ id: 'original', content: 'original request' }], {
    runId: 'runtime-residual-r8',
  })
  const record = {
    appendRequest: (turn, options) => requestEnvelope.appendRequestTurn(requestDir, turn, options),
    loadRequest: () => requestEnvelope.loadRequestEnvelope(requestDir),
  }
  const pointerFactory = async () => {
    const loaded = record.loadRequest()
    const envelopePath = path.join(requestDir, 'envelope.jsonl')
    return Object.freeze({
      kind: 'request-envelope', path: envelopePath, hash: loaded.digest,
      bytes: fs.statSync(envelopePath).size, encoding: 'utf8',
    })
  }
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.record = record
  runtime.options = { requestPointerFactory: pointerFactory }
  runtime.requestPointer = await pointerFactory()
  const before = runtime.requestPointer
  const rebound = await runtime.applyUserSteering({
    id: 'steering-one', operation: 'ADD', content: 'also preserve this requirement',
  })
  assert.equal(rebound.entry.entryType, 'steering-edge')
  assert.equal(rebound.previousPointer.hash, before.hash)
  assert.notEqual(rebound.requestPointer.hash, before.hash)
  assert.ok(rebound.requestPointer.bytes > before.bytes)
  assert.equal(runtime.requestPointer.hash, record.loadRequest().digest)
  assert.equal(record.loadRequest().records.at(-1).steeringId, 'steering-one')
})

test('ISO-022 top-level and supervisor adapters execute one identical semantic trace', () => {
  const calls = []
  const execute = context => {
    calls.push(context)
    return {
      admission: {
        activationId: 'activation-entry-parity', runId: 'run-entry-parity',
        requestHash: H('request-entry-parity'), targetIdentity: 'target:repo',
      },
      route: { route: 'LIGHT', decisionHash: H('route-entry-parity') },
      capability: { receiptHash: H('capability-entry-parity'), generation: 2, status: 'active' },
      resume: { generation: 2, stateEventSequence: 17, stateHash: H('resume-entry-parity') },
    }
  }
  const topLevel = runCodexTopLevelEntryAdapter({ prompt: '$autoprompt repair this', execute })
  const supervisor = runCodexSupervisorEntryAdapter({
    activationReceipt: {
      verified: true, activationId: 'activation-entry-parity', runId: 'run-entry-parity',
    },
    execute,
  })
  assert.deepEqual(topLevel, supervisor)
  assert.deepEqual(calls.map(call => call.entry), ['top-level', 'supervisor'])
  assert.deepEqual(calls.map(call => call.admissionEvidence.kind), ['explicit-token', 'activation-receipt'])
  for (const field of ['admission', 'route', 'capability', 'resume']) {
    assert.deepEqual(topLevel[field], supervisor[field])
  }
})
