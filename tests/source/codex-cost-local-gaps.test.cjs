'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const workflow = path.join(root, 'agents', 'codex', 'workflow')
const { CentralScheduler, bindRoadmapExpansionAdmission } = require(path.join(workflow, 'scheduler.js'))
const { BudgetController } = require(path.join(workflow, 'budget-controller.js'))
const {
  sealReceiptBoundRegistry,
  selectModelAssignment,
  validateReceiptBoundRegistry,
} = require(path.join(workflow, 'effort-policy.js'))
const {
  appendCanonicalRouteEvent,
  assignmentLocalFindingId,
  CodexSupervisorRuntime,
  emitItemVerifiedTransition,
  explicitFindingIds,
  readPrivateAgentAssignment,
  readPersistedWorkerAssignment,
  replayRequestFromPersistedAssignment,
  renderRouteDecisionMarkdown,
  verifyRequestPointer,
  writeRouteDecisionArtifacts,
} = require(path.join(workflow, 'phase-budget.js'))
const { Finalizer } = require(path.join(workflow, 'finalizer.js'))

const RUN = Object.freeze({ runId: 'cost-local-gaps', generation: 1 })
const ZERO = Object.freeze({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
const CAPABILITIES = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})
let sequence = 0

function authority(scheduler, parentLease = null) {
  sequence += 1
  return scheduler.issueLaunchAuthority({
    callerRole: parentLease ? 'ap-parent' : 'ap-root',
    sessionId: `cost-session-${sequence}`,
    ...RUN,
    parentLease,
    providerCapabilities: CAPABILITIES,
  })
}

function admit(scheduler, request, parentLease = null) {
  return scheduler.acquireWithAuthority(authority(scheduler, parentLease), {
    role: 'ap-worker',
    ...request,
  })
}

function finish(lease) {
  lease.complete(ZERO)
}

function valueCase(boundary) {
  return {
    failureMode: 'a separate optional check misses a production defect',
    disjointBoundary: boundary,
    estimatedTokens: 1,
    estimatedMs: 1,
    defectProbability: 1,
    severityWeight: 10,
    avoidedRework: 100,
  }
}

test('AP-COST-005 four nested levels share one live-cap semaphore', async () => {
  const scheduler = new CentralScheduler({
    route: 'ROADMAP',
    liveCeiling: 5,
    runIdentity: RUN,
  })
  const level1 = await admit(scheduler, { workItemId: 'level-1' })
  const level2 = await admit(scheduler, { workItemId: 'level-2' }, level1)
  const level3 = await admit(scheduler, { workItemId: 'level-3' }, level2)
  const level4 = await admit(scheduler, { workItemId: 'level-4' }, level3)
  let overflowStarted = false
  const overflowPromise = admit(scheduler, { workItemId: 'queued-overflow' })
    .then(lease => { overflowStarted = true; return lease })
  await Promise.resolve()
  assert.equal(overflowStarted, false)
  assert.equal(scheduler.getMetrics().counters.currentLiveIncludingRoot, 5)
  assert.equal(scheduler.getMetrics().counters.peakLiveIncludingRoot, 5)
  assert.equal(scheduler.getMetrics().counters.maxDepthObserved, 4)

  finish(level4)
  const overflow = await overflowPromise
  assert.equal(overflowStarted, true)
  assert.equal(scheduler.getMetrics().counters.peakLiveIncludingRoot, 5)
  finish(overflow)
  finish(level3)
  finish(level2)
  finish(level1)
})

test('AP-COST-009 records and restores roadmap/user-ask ratio with the plan hash', () => {
  const scheduler = new CentralScheduler({ route: 'ROADMAP', runIdentity: RUN })
  const expansionAdmission = bindRoadmapExpansionAdmission({
    accepted: true,
    authorityId: 'independent-scope-review',
    authorityReceiptHash: 'd'.repeat(64),
    admittedAskCount: 3,
    missionScopeHash: 'e'.repeat(64),
    planSha256: 'a'.repeat(64),
    necessityEvidenceHash: 'b'.repeat(64),
    marginalValueEvidenceHash: 'c'.repeat(64),
  })
  const measurement = scheduler.recordRoadmapAskRatio({
    roadmapAskCount: 6,
    userAskCount: 3,
    missionScopeHash: 'e'.repeat(64),
    planSha256: 'a'.repeat(64),
    expansionAdmission,
  })
  assert.deepEqual(measurement, {
    roadmapAskCount: 6,
    userAskCount: 3,
    roadmapAskToUserAskRatio: 2,
    missionScopeHash: 'e'.repeat(64),
    planSha256: 'a'.repeat(64),
    askCeiling: 6,
    expansionAdmission,
  })
  assert.deepEqual(scheduler.getMetrics().economics.roadmapAskMeasurement, measurement)
  const restored = new CentralScheduler({ runIdentity: RUN, state: scheduler.exportState() })
  assert.deepEqual(restored.getMetrics().economics.roadmapAskMeasurement, measurement)
  assert.throws(() => scheduler.recordRoadmapAskRatio({
    roadmapAskCount: 6,
    userAskCount: 3,
    missionScopeHash: 'f'.repeat(64),
    planSha256: 'a'.repeat(64),
    expansionAdmission,
  }), error => error.code === 'ROADMAP_EXPANSION_NOT_ADMITTED')
})

test('AP-COST-011 agents=off applies role effort instead of inheriting root xhigh', () => {
  const activation = { modelSelection: { mode: 'provider-default' } }
  assert.deepEqual(readPrivateAgentAssignment(activation, 'ap-finalizer', 'finalizer'), {
    model: null,
    effort: 'low',
    source: 'role-effort-policy',
    registryMatched: false,
    routeIndependent: true,
  })
  assert.equal(readPrivateAgentAssignment(activation, 'ap-worker', 'worker').effort, 'medium')
})

test('AP-COST-012 accepts only a fresh evidence-bound economic registry envelope', () => {
  const nowMs = Date.parse('2026-08-23T12:00:00.000Z')
  const registry = sealReceiptBoundRegistry({
    schemaVersion: 'codex-model-registry.v1',
    issuer: 'independent-model-benchmark',
    observedAt: '2026-08-23T10:00:00.000Z',
    expiresAt: '2026-08-24T10:00:00.000Z',
    evidenceSha256: 'b'.repeat(64),
    entries: [{
      id: 'measured-cheapest', verified: true, efforts: ['medium'], capabilities: { tools: true },
      price: { perTokens: 1000000, noncachedInput: 1, cachedInput: 0.5, output: 2 },
      latency: { p50Ms: 20, sampleSize: 30 }, yield: { successRate: 0.9, sampleSize: 30 },
    }],
  })
  assert.equal(validateReceiptBoundRegistry(registry, { nowMs }).entries.length, 1)
  const selected = selectModelAssignment({
    role: 'worker', registry, nowMs, requiredCapabilities: ['tools'],
    workload: { noncachedInput: 1000, cachedInput: 1000, output: 100 },
  })
  assert.equal(selected.model, 'measured-cheapest')
  assert.equal(selected.registryReceiptSha256, registry.bindingSha256)
  assert.throws(
    () => validateReceiptBoundRegistry({ ...registry, issuer: 'tampered' }, { nowMs }),
    error => error.code === 'MODEL_REGISTRY_RECEIPT_INVALID',
  )
})

test('AP-COST-016/021 preserve optional aliases and reject duplicate sweep boundaries', async () => {
  const scheduler = new CentralScheduler({ route: 'ROADMAP', runIdentity: RUN })
  await assert.rejects(admit(scheduler, {
    workItemId: 'alias-without-value',
    role: 'autoprompt.v2.ap-juror@generation-1',
  }), error => error.code === 'MARGINAL_VALUE_REQUIRED')

  const sweep = await admit(scheduler, {
    workItemId: 'sweep-auth',
    role: 'autoprompt.v2.ap-sweeper@generation-1',
    valueCase: valueCase('authorization boundary'),
  })
  await assert.rejects(admit(scheduler, {
    workItemId: 'juror-same-boundary',
    role: 'autoprompt.v2.ap-juror@generation-1',
    valueCase: valueCase('AUTHORIZATION BOUNDARY'),
  }), error => error.code === 'OPTIONAL_BOUNDARY_DUPLICATE')
  assert.equal(scheduler.getMetrics().economics.optionalBoundaryCount, 1)
  finish(sweep)
})

test('AP-COST-020 resumes a deadline-bound activation with its persisted reserves', () => {
  let monotonicNow = 100
  const admittedAtMs = Date.parse('2026-08-23T12:00:00.000Z')
  const options = {
    limits: { wallMs: 1000, tokens: 1000, sessions: 10, launches: 10 },
    finalizationReserveMs: 1,
    monotonicClockId: 'cost-monotonic-clock',
    monotonicMs: () => monotonicNow,
    wallNowMs: () => admittedAtMs,
    wallClock: () => '2026-08-23T12:00:00.000Z',
  }
  const initial = new BudgetController(options)
  initial.bindDeadline({
    deadline: {
      absoluteDeadline: '2026-08-23T12:00:01.000Z',
      source: 'product-maximum',
      verificationReservePercent: 25,
      recoveryAndFinalizationReservePercent: 10,
    },
    wallMs: 1000,
    verificationReserveMs: 250,
    finalizationReserveMs: 100,
    admittedAtMs,
  })
  monotonicNow = 101
  const snapshot = initial.snapshot()
  const restored = new BudgetController({ ...options, snapshot }).snapshot()
  assert.equal(restored.verificationReserveMs, 250)
  assert.equal(restored.finalizationReserveMs, 100)

  assert.throws(
    () => new BudgetController({
      ...options,
      snapshot: { ...snapshot, verificationReserveMs: 249 },
    }),
    error => error.code === 'BUDGET_SNAPSHOT_INVALID',
  )
})

test('AP-DESIGN-003 writes a readable decision markdown derived from canonical JSON', () => {
  const decision = {
    route: 'LIGHT', routeSource: 'automatic', decidedAt: '2026-08-23T12:00:00.000Z',
    requestedResult: 'Close the local routing gap.',
    successChecklist: ['The saved choice can be audited.'],
    plannedChecks: ['Run the focused route artifact test.'],
    likelyAreas: ['agents/codex/workflow/phase-budget.js'],
    risks: ['Markdown must remain derived from the canonical object.'],
    missingInformation: [],
    usefulWorkerCount: 1,
    workerOwnershipReason: 'One writer owns the narrow persistence seam.',
    independentCheckingPlan: {
      checkerCount: 1,
      responsibilities: ['Check both persisted formats for the same reasoning.'],
      nonOverlapReason: 'One independent responsibility is sufficient.',
    },
    chosenRouteReason: 'A short design pass is useful before the bounded change.',
    rejectedRouteReasons: {
      DIRECT: 'The persistence format needs a small design choice.',
      ROADMAP: 'There is no cross-system dependency.',
    },
    analystDisagreement: null,
    routeChangeTrigger: {
      event: 'MULTI_SURFACE_DISCOVERED',
      factRequired: 'Evidence of a second dependent writable output.',
    },
  }
  const writes = new Map()
  writeRouteDecisionArtifacts({ write: (relative, content) => writes.set(relative, content) }, decision)
  assert.deepEqual(JSON.parse(writes.get('route/decision.json')), decision)
  assert.equal(writes.get('route/decision.md'), renderRouteDecisionMarkdown(decision))
  for (let section = 1; section <= 12; section += 1) {
    assert.match(writes.get('route/decision.md'), new RegExp(`^## ${section}\\. `, 'm'))
  }
  assert.match(writes.get('route/decision.md'), /Why Other Routes Were Rejected/)
  assert.match(writes.get('route/decision.md'), /Evidence of a second dependent writable output\./)
})

test('AP-DESIGN-002 appends each route event at the streaming boundary', () => {
  const appended = []
  const event = { id: 'stream-1', type: 'message', text: 'evidence arrived' }
  appendCanonicalRouteEvent({ appendRouteEvent: (...args) => appended.push(args) }, event, '{"id":"stream-1"}\n')
  assert.equal(appended.length, 1)
  assert.equal(appended[0][0], event)
  assert.equal(appended[0][1].rawBytes.toString('utf8'), '{"id":"stream-1"}\n')
})

test('AP-DESIGN-005 completion boundary blocks terminal binding', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cost-finalizer-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const terminalPath = path.join(directory, 'terminal.json')
  const deliverablePath = path.join(directory, 'user-usable-build.txt')
  fs.writeFileSync(deliverablePath, 'verified user-usable build\n')
  const deliverableHash = crypto.createHash('sha256').update(fs.readFileSync(deliverablePath)).digest('hex')
  let bindCalls = 0
  const state = { state: 'FINALIZING', workspaceEpoch: 0 }
  const finalizer = new Finalizer({
    stateStore: {
      registeredPaths: { runRecordRoot: directory, terminalPath },
      load: () => state,
      bindTerminal: () => { bindCalls += 1 },
    },
    processOwner: {
      ownershipIdentities: () => [], cancelAll: async () => [], assertTargetDrained: async () => true,
    },
    missionLock: {
      describe: () => ({ status: 'ACTIVE', owner: { targetKey: 'target', ownedProcessHistory: [] } }),
      assertOwned: () => true, updateOwnedProcesses: () => true,
    },
    capability: {},
    cleanupRegistry: { run: () => true },
    completionBoundary: () => { const error = new Error('tracked run record'); error.code = 'RUN_RECORD_UNSAFE'; throw error },
  })
  await assert.rejects(finalizer.finalize({
    outcome: 'DONE',
    expectedEpoch: 0,
    deliverables: [{ path: deliverablePath, hash: deliverableHash }],
    checkHashes: ['a'.repeat(64)],
  }),
    error => error.code === 'RUN_RECORD_UNSAFE')
  assert.equal(bindCalls, 0)
})

test('AP-DESIGN-023 fresh replay is derived only from the persisted assignment', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cost-assignment-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workItemId = 'work-1'
  const relative = `work/assignments/${require('node:crypto').createHash('sha256').update(workItemId).digest('hex')}.json`
  const absolute = path.join(directory, ...relative.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const assignment = {
    schemaVersion: '2.0.0', reportType: 'assignment', assignmentId: workItemId,
    runId: 'persisted-run', requestEnvelopeHash: 'f'.repeat(64), logicalRoleId: 'worker',
    findingIds: ['AP-DESIGN-023'], requestedResult: 'Replay this exact bounded assignment.',
    resources: [
      {
        kind: 'file', identity: 'src/owned.js', owner: 'worker-1',
        ownershipMode: 'single-owner', access: 'write',
      },
      {
        kind: 'file', identity: 'request/input.json', owner: 'worker-1',
        ownershipMode: 'single-owner', access: 'read',
      },
    ],
    successChecklist: [{ id: 'success-1', description: 'Owned behavior passes.' }],
    checks: ['node --test focused.test.cjs'], forbiddenChanges: ['Do not touch other files.'],
    resultLocation: 'work/results/result.json',
  }
  fs.writeFileSync(absolute, `${JSON.stringify(assignment)}\n`)
  const record = { resolve: candidate => path.join(directory, ...candidate.split('/')) }
  const opened = readPersistedWorkerAssignment(record, workItemId, {
    runId: 'persisted-run', requestEnvelopeHash: 'f'.repeat(64), logicalRoleId: 'worker',
  })
  assert.deepEqual(replayRequestFromPersistedAssignment(opened), {
    assignment: assignment.requestedResult,
    successChecklist: ['Owned behavior passes.'], success: ['Owned behavior passes.'],
    checks: assignment.checks,
    findingIds: assignment.findingIds,
    ownership: [{
      kind: 'file', identity: 'src/owned.js', owner: 'worker-1', ownershipMode: 'single-owner',
    }],
    manifests: [{
      kind: 'file', identity: 'src/owned.js', owner: 'worker-1', ownershipMode: 'single-owner',
    }],
    snapshotProjection: null,
    replayedAssignmentPath: relative,
  })
})

test('assignment findings consume only explicit fields and use a stable local fallback', () => {
  const request = {
    workItemId: 'work-unrelated', logicalRole: 'worker', parent: 'run-owner',
    assignment: 'Write the ordinary response; the quoted history mentions AP-DESIGN-023.',
    successChecklist: ['Do not infer AP-TRACE-013 from this prose.'],
    checks: ['Confirm output without treating AP-RUN-026 as a finding.'],
  }
  assert.deepEqual(explicitFindingIds(
    request,
    request.assignment,
    'mission text mentions AP-RUN-027',
  ), [])
  const binding = { requestEnvelopeHash: 'a'.repeat(64) }
  const freshId = assignmentLocalFindingId(request, binding)
  const resumedId = assignmentLocalFindingId(structuredClone(request), structuredClone(binding))
  assert.match(freshId, /^AP-WORK-[0-9]{3}$/u)
  assert.equal(resumedId, freshId)
  assert.doesNotMatch(freshId, /AP-(?:DESIGN|TRACE|RUN)-/u)
  assert.deepEqual(explicitFindingIds({
    ...request,
    findingIds: ['customer-finding-7'],
  }), ['customer-finding-7'])
})

test('W3/C2 assignment-local finding ids are unique and resume-stable across corrections and repair', () => {
  const requests = [
    { workItemId: 'route-analyst', logicalRole: 'route-analyst' },
    ...[1, 2, 3].map(ordinal => ({
      workItemId: `work-${ordinal}`, logicalRole: 'worker',
    })),
    ...[1, 2, 3].map(ordinal => ({
      workItemId: `work-${ordinal}-transport-retry-1`, logicalRole: 'worker',
    })),
    { workItemId: 'work-1-repair-1', logicalRole: 'worker' },
    ...[1, 2].flatMap(seat => {
      const logicalRole = seat === 1 ? 'independent-reviewer' : 'independent-tester'
      return [
        { workItemId: `independent-check-${seat}`, logicalRole },
        { workItemId: `independent-check-${seat}-runtime-retry-1`, logicalRole },
        { workItemId: `independent-check-${seat}-repair-1`, logicalRole },
        { workItemId: `independent-check-${seat}-repair-1-runtime-retry-1`, logicalRole },
      ]
    }),
  ].map(request => ({
    ...request,
    parent: request.logicalRole === 'route-analyst' ? 'deterministic-control-plane' : 'run-owner',
    assignment: `Exact assignment for ${request.workItemId}`,
    checks: [`Verify ${request.workItemId}`],
  }))
  const binding = { requestEnvelopeHash: 'b'.repeat(64) }
  const freshRegistry = new Map()
  const freshIds = requests.map(request =>
    assignmentLocalFindingId(request, binding, freshRegistry))
  assert.deepEqual(freshIds, [
    'AP-WORK-001',
    'AP-WORK-101', 'AP-WORK-102', 'AP-WORK-103',
    'AP-WORK-201', 'AP-WORK-202', 'AP-WORK-203',
    'AP-WORK-301',
    'AP-WORK-401', 'AP-WORK-421', 'AP-WORK-441', 'AP-WORK-461',
    'AP-WORK-402', 'AP-WORK-422', 'AP-WORK-442', 'AP-WORK-462',
  ])
  assert.equal(new Set(freshIds).size, requests.length)
  const resumedRegistry = new Map()
  const resumedIds = structuredClone(requests).map(request =>
    assignmentLocalFindingId(request, structuredClone(binding), resumedRegistry))
  assert.deepEqual(resumedIds, freshIds)

  const exoticRegistry = new Map()
  assert.throws(() => {
    for (let ordinal = 0; ordinal <= 200; ordinal += 1) {
      assignmentLocalFindingId({
        workItemId: `extension-assignment-${ordinal}`,
        logicalRole: 'worker',
        assignment: `Extension assignment ${ordinal}`,
      }, binding, exoticRegistry)
    }
  }, error => error.code === 'ASSIGNMENT_FINDING_ID_COLLISION')
})

test('AP-ROUTE-025 emits item verification before more work continues', async () => {
  const transitions = []
  await emitItemVerifiedTransition(async (...args) => transitions.push(args), {
    workItemId: 'work-1', resultHash: '1'.repeat(64), candidateHash: '2'.repeat(64),
    nextReadyWorkIds: ['work-2'],
  })
  assert.deepEqual(transitions.map(item => item.slice(0, 2)), [
    ['WORK_ITEM_VERIFIED', 'ITEM_VERIFIED'], ['MORE_WORK_READY', 'RUN_WORK'],
  ])
})

test('AP-ROUTE-028/DESIGN-042 stop resumably without finalizer terminalization', async () => {
  let released = 0
  let finalized = 0
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(runtime, {
    finished: false, scheduler: null, route: null, lease: {},
    processOwner: { cancelAll: async () => {}, assertDrained: async () => true },
    missionLock: { release: () => { released += 1 } },
    finalizer: { finalize: async () => { finalized += 1 } },
    budget: { snapshot: () => ({ generation: 1 }) },
  })
  assert.equal(runtime._budgetPauseFrontier(), null)
  const result = await runtime._suspendResumable('WAITING_USER', {
    terminalEnvelope: { status: 'WAITING_USER', route: null },
  })
  assert.equal(result.outcome, 'WAITING_USER')
  assert.equal(result.resumable, true)
  assert.equal(released, 1)
  assert.equal(finalized, 0)
})

test('AP-DESIGN-035 ROADMAP admission includes planning with p95 and hard bounds', () => {
  const within = new CentralScheduler({ route: 'ROADMAP', runIdentity: RUN })
  const atCeiling = within.recordAdmissionComponent('roadmapPlanning', 15 * 60 * 1000)
  assert.equal(atCeiling.withinCeiling, true)
  assert.equal(atCeiling.p95TargetMs, 18 * 60 * 1000)
  assert.equal(atCeiling.combinedHardMs, 22 * 60 * 1000)
  assert.equal(atCeiling.components.roadmapPlanning, 15 * 60 * 1000)

  const exceeded = new CentralScheduler({ route: 'ROADMAP', runIdentity: RUN })
    .recordAdmissionComponent('roadmapPlanning', (15 * 60 * 1000) + 1)
  assert.equal(exceeded.withinCeiling, false)
  assert.equal(exceeded.withinTarget, false)
  assert.equal(exceeded.convergenceRequired, true)
  assert.equal(exceeded.completionCanContinue, true)
  assert.deepEqual(exceeded.breaches, ['roadmapPlanning'])
  assert.equal(exceeded.convergencePolicy.kind, 'essential-sequential-collapse')
})

test('AP-DESIGN-045 L1 request pointer is hash-checked before reuse', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-request-pointer-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const absolute = path.join(directory, 'request.jsonl')
  const original = Buffer.from('{"request":"frozen"}\n')
  fs.writeFileSync(absolute, original)
  const pointer = {
    kind: 'request-envelope', path: absolute, bytes: original.length,
    hash: crypto.createHash('sha256').update(original).digest('hex'), encoding: 'utf8',
  }
  assert.equal(verifyRequestPointer(pointer), pointer)
  fs.writeFileSync(absolute, '{"request":"steered"}\n')
  assert.throws(() => verifyRequestPointer(pointer), error => error.code === 'REQUEST_POINTER_CHANGED')
})

test('AP-DESIGN-016/ROUTE-019 production calls freeze fallback and baseline before mutation', () => {
  const source = fs.readFileSync(path.join(workflow, 'phase-budget.js'), 'utf8')
  assert.match(source, /writeRouteAnalystFallbackState\(evaluated\.recommendation_state\)/)
  const baselineCall = source.indexOf('this.record.writePreMutationBaseline(baselineInput)')
  const mutationBegin = source.indexOf('this.options.mutationEnforcer.begin({', baselineCall)
  assert.ok(baselineCall > 0)
  assert.ok(mutationBegin > baselineCall)
  assert.match(source.slice(baselineCall, mutationBegin), /readPreMutationBaseline\(\)/)
})
