'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const workflow = path.join(root, 'agents', 'codex', 'workflow')
const { stableStringify } = require(path.join(workflow, 'event-log.js'))
const { BudgetController } = require(path.join(workflow, 'budget-controller.js'))
const {
  CentralScheduler,
  ROUTE_BUDGETS,
  evaluateMarginalValue,
  phaseBudgetVerdict,
  resolveRouteBudget,
  resolveSchedulerSettings,
} = require(path.join(workflow, 'scheduler.js'))
const {
  CONTEXT_ROUTE_CAPS,
  MAX_L3_BRIEF_BYTES,
  TranscriptStore,
  auditDispatch,
  buildCheckerContext,
  buildContextFreeBrief,
  loadRequestEnvelope,
  transcriptRollingHash,
  writeRequestEnvelope,
} = require(path.join(workflow, 'context-envelope.js'))
const {
  decideCheckerPlan,
  selectEffort,
  selectModelAssignment,
} = require(path.join(workflow, 'effort-policy.js'))
const {
  TemporarySandboxRegistry,
  assertSafeParallel,
  materializeCheckerSandboxes,
  planCheckerSandboxes,
} = require(path.join(workflow, 'check-sandbox.js'))

const PROVIDER_CAPABILITIES = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})
const SERIAL_PROVIDER_CAPABILITIES = Object.freeze({ ...PROVIDER_CAPABILITIES, isolatedChecking: false })
const ZERO_USAGE = Object.freeze({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })

function finish(lease, usage = {}) {
  return lease.complete({ ...ZERO_USAGE, ...usage })
}

const TEST_RUN = Object.freeze({ runId: 'scheduler-v2-test', generation: 1 })
let sessionSequence = 0
const requiredCompletionIssuers = new WeakMap()

function createTestScheduler(options = {}) {
  const requiredCompletionIssuerCapability = options.requiredCompletionIssuerCapability || Object.freeze({})
  const scheduler = new CentralScheduler({
    route: 'DIRECT', runIdentity: TEST_RUN, ...options, requiredCompletionIssuerCapability,
  })
  requiredCompletionIssuers.set(scheduler, requiredCompletionIssuerCapability)
  return scheduler
}

function issueRequiredCompletionBinding(scheduler, request, capability = requiredCompletionIssuers.get(scheduler)) {
  return scheduler.issueRequiredCompletionBinding(request, capability)
}

function authority(scheduler, parentLease = null, overrides = {}) {
  sessionSequence++
  return scheduler.issueLaunchAuthority({
    callerRole: parentLease ? 'ap-parent' : 'ap-root',
    sessionId: `session-${sessionSequence}`,
    ...TEST_RUN,
    parentLease,
    providerCapabilities: PROVIDER_CAPABILITIES,
    ...overrides,
  })
}

function admit(scheduler, request, parentLease = null) {
  return scheduler.acquireWithAuthority(authority(scheduler, parentLease), {
    role: 'ap-worker',
    ...request,
  })
}

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function optionalValue(overrides = {}) {
  return {
    failureMode: 'the regression checker misses an authorization boundary',
    disjointBoundary: 'authorization policy, separate from runtime correctness',
    estimatedTokens: 100,
    estimatedMs: 1000,
    defectProbability: 0.5,
    severityWeight: 5,
    avoidedRework: 1000,
    ...overrides,
  }
}

test('benchmark scheduler keeps finite targets and collapses late admission without ending the mission', () => {
  const environment = { AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1' }
  const clock = { now: 0 }
  const scheduler = new CentralScheduler({
    route: 'DIRECT', runIdentity: TEST_RUN, environment, now: () => clock.now,
  })
  assert.equal(scheduler.budget.admissionHardMs, ROUTE_BUDGETS.DIRECT.admissionHardMs)
  assert.equal(scheduler.budget.tokens.noncachedInput, ROUTE_BUDGETS.DIRECT.tokens.noncachedInput)
  assert.equal(scheduler.budget.maxChildLaunches, ROUTE_BUDGETS.DIRECT.maxChildLaunches)
  assert.equal(scheduler.settings.lanes.main.maxLaunches, ROUTE_BUDGETS.DIRECT.maxChildLaunches)
  clock.now = 48 * 60 * 60 * 1000
  scheduler.recordAdmissionComponent('configuration', 25 * 60 * 60 * 1000)
  scheduler.recordAdmissionComponent('routeAnalyst', 23 * 60 * 60 * 1000)
  const convergedAdmission = scheduler.checkAdmissionTime()
  assert.equal(convergedAdmission.withinCeiling, false)
  assert.equal(convergedAdmission.withinTarget, false)
  assert.equal(convergedAdmission.completionCanContinue, true)
  assert.equal(convergedAdmission.convergenceRequired, true)
  assert.ok(convergedAdmission.breaches.includes('routeAnalyst'))
  assert.ok(convergedAdmission.breaches.includes('combined'))
  assert.equal(convergedAdmission.withinP95, false)
  assert.equal(scheduler.getMetrics().limits.effectiveMaxLiveIncludingRoot, 2)

  const ordinary = createTestScheduler()
  ordinary.recordAdmissionComponent('routeAnalyst', 25 * 60 * 60 * 1000)
  assert.ok(ordinary.checkAdmissionTime().breaches.includes('routeAnalyst'))
})

test('benchmark no-limit flags resolve to finite practical ceilings without repeated expansion', () => {
  const environment = {
    AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1',
    AUTOPROMPT_BENCHMARK_NO_TOKEN_LIMIT: '1',
  }
  const first = new CentralScheduler({ route: 'LIGHT', runIdentity: TEST_RUN, environment })
  assert.equal(first.budget.admissionHardMs, ROUTE_BUDGETS.LIGHT.admissionHardMs)
  assert.deepEqual(first.budget.tokens, ROUTE_BUDGETS.LIGHT.tokens)
  assert.equal(Object.values(first.budget.tokens).every(Number.isSafeInteger), true)
  const state = first.exportState()
  const resumed = new CentralScheduler({
    route: 'LIGHT', runIdentity: TEST_RUN, environment, state, settings: state.settings,
  })
  assert.deepEqual(resumed.budget.tokens, first.budget.tokens)
  assert.equal(resumed.budget.admissionHardMs, first.budget.admissionHardMs)
})

test('benchmark flags never authorize extra model generations', async () => {
  const scheduler = new CentralScheduler({
    route: 'DIRECT', runIdentity: TEST_RUN,
    environment: { AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1' },
  })
  for (let index = 1; index <= 9; index += 1) {
    finish(await admit(scheduler, { workItemId: `required-stage-${index}` }))
  }
  await assert.rejects(admit(scheduler, { workItemId: 'forbidden-generation-10' }),
    error => error.code === 'LAUNCH_LIMIT')
  assert.equal(scheduler.getMetrics().counters.totalLaunches, 9)
  assert.equal(scheduler.budget.maxChildLaunches, ROUTE_BUDGETS.DIRECT.maxChildLaunches)
})

test('orderly scheduler disposal is not reported as rejected work', async () => {
  const scheduler = createTestScheduler()
  const lease = await admit(scheduler, { workItemId: 'completed-before-close' })
  finish(lease)
  scheduler.dispose('normal terminal finalization')
  assert.equal(scheduler.getMetrics().counters.rejectedByCode.SCHEDULER_CLOSED || 0, 0)
  await assert.rejects(
    admit(scheduler, { workItemId: 'late-after-close' }),
    error => error.code === 'SCHEDULER_CLOSED',
  )
  assert.equal(scheduler.getMetrics().counters.rejectedByCode.SCHEDULER_CLOSED || 0, 0,
    'post-terminal caller mistakes remain errors but do not rewrite completed-run admission metrics')
})

test('undersized global launch targets yield only to issuer-authenticated required graph identities', async () => {
  const settings = resolveSchedulerSettings({ route: 'DIRECT', requiredChildLaunches: 2 })
  const scheduler = createTestScheduler({ settings })
  const economicTarget = new BudgetController({
    limits: { wallMs: 10_000, tokens: 10, sessions: 1, launches: 1 },
    phases: {},
  })
  for (const workItemId of ['required-result', 'required-check']) {
    const request = { workItemId, equivalenceKey: workItemId, role: 'ap-worker', lane: 'main' }
    const requiredCompletionBinding = issueRequiredCompletionBinding(scheduler, request)
    const lease = await scheduler.acquireWithAuthority(authority(scheduler, null, {
      requiredCompletionBinding,
    }), { ...request, requiredCompletionBinding })
    const completion = scheduler.authorizeRequiredCompletionAccounting(lease)
    assert.equal(completion.requiredCompletion, true)
    economicTarget.recordLaunch({ requiredCompletion: completion.requiredCompletion })
    finish(lease)
  }
  assert.equal(economicTarget.snapshot().launches, 2,
    'the second exact required node crosses only the economic launch target')
  assert.throws(() => economicTarget.recordLaunch(), error => error.code === 'BUDGET_EXHAUSTED')
  await assert.rejects(admit(scheduler, { workItemId: 'unregistered-extra', missionEssential: true }),
    error => error.code === 'LAUNCH_LIMIT')
  assert.throws(() => scheduler.authorizeRequiredCompletionAccounting({}),
    error => ['INVALID_LEASE', 'INVALID_LAUNCH_AUTHORITY'].includes(error.code))

  const optionalScheduler = createTestScheduler({ maxChildLaunches: 2 })
  const optional = await admit(optionalScheduler, {
    workItemId: 'optional-expansion', optionalWork: true, valueCase: optionalValue(),
  })
  assert.throws(() => optionalScheduler.authorizeRequiredCompletionAccounting(optional),
    error => error.code === 'INVALID_LAUNCH_AUTHORITY')
  finish(optional)
})

test('benchmark resume preserves the normal launch topology and counters', async () => {
  const legacy = createTestScheduler()
  for (let index = 1; index <= 8; index += 1) {
    finish(await admit(legacy, { workItemId: `legacy-stage-${index}` }))
  }
  const state = structuredClone(legacy.exportState())
  const resumed = new CentralScheduler({
    route: 'DIRECT', settings: state.settings, state,
    runIdentity: TEST_RUN,
    environment: { AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1' },
  })
  assert.equal(resumed.getMetrics().counters.totalLaunches, 8)
  assert.equal(resumed.budget.maxChildLaunches, 9)
  assert.equal(resumed.settings.lanes.main.maxLaunches, 9)
  finish(await admit(resumed, { workItemId: 'legacy-stage-9' }))
  await assert.rejects(admit(resumed, { workItemId: 'legacy-stage-10' }),
    error => error.code === 'LAUNCH_LIMIT')
  assert.equal(resumed.getMetrics().counters.totalLaunches, 9)
})

test('benchmark launch migration preserves explicit activation and lane ceilings', () => {
  const environment = { AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1' }
  const activationCapped = new CentralScheduler({
    route: 'DIRECT', runIdentity: TEST_RUN, environment, maxChildLaunches: 5,
  })
  assert.equal(activationCapped.budget.maxChildLaunches, 5)
  assert.equal(activationCapped.settings.lanes.main.maxLaunches, 5)

  const laneCapped = new CentralScheduler({
    route: 'DIRECT', runIdentity: TEST_RUN, environment,
    lanes: { main: { maxLaunches: 2 } },
  })
  assert.equal(laneCapped.budget.maxChildLaunches, 9)
  assert.equal(laneCapped.settings.lanes.main.maxLaunches, 2)
})

test('exact completion reserves admit only the executable fixture-provenance gate', () => {
  const ordinary = resolveSchedulerSettings({ route: 'DIRECT' })
  assert.equal(ordinary.budget.maxChildLaunches, 9)
  assert.equal(ordinary.budget.exactCompletionRequirement, undefined)

  const directWithFixtureGate = resolveSchedulerSettings({
    route: 'DIRECT', requiredChildLaunches: 10,
  })
  assert.equal(directWithFixtureGate.budget.maxChildLaunches, 10)
  assert.equal(directWithFixtureGate.budget.exactCompletionRequirement, 10)
  assert.equal(directWithFixtureGate.lanes.main.maxLaunches, 10)

  const roadmapWithFixtureGate = resolveSchedulerSettings({
    route: 'ROADMAP', requiredChildLaunches: 19,
  })
  assert.equal(roadmapWithFixtureGate.budget.maxChildLaunches, 19)
  assert.equal(roadmapWithFixtureGate.budget.exactCompletionRequirement, 19)

  assert.throws(
    () => resolveSchedulerSettings({ route: 'DIRECT', requiredChildLaunches: 11 }),
    error => error.code === 'ROUTE_LAUNCH_REQUIREMENT_INVALID',
  )
  assert.throws(
    () => resolveSchedulerSettings({ route: 'ROADMAP', requiredChildLaunches: 21 }),
    error => error.code === 'ROUTE_LAUNCH_REQUIREMENT_INVALID',
  )
  const laneTargetBelowGraph = resolveSchedulerSettings({
    route: 'DIRECT', requiredChildLaunches: 10,
    lanes: { main: { maxLaunches: 9 } },
  })
  assert.equal(laneTargetBelowGraph.lanes.main.maxLaunches, 9)
  assert.equal(laneTargetBelowGraph.budget.exactCompletionRequirement, 10)
})

test('exact completion frontier immutably reserves every physical launch slot from optional work', async () => {
  const settings = resolveSchedulerSettings({ route: 'DIRECT', requiredChildLaunches: 4 })
  const scheduler = createTestScheduler({ settings })

  await assert.rejects(admit(scheduler, {
    workItemId: 'optional-without-value-before-checker',
    optionalWork: true,
  }), error => error.code === 'MARGINAL_VALUE_REQUIRED')
  await assert.rejects(admit(scheduler, {
    workItemId: 'positive-value-optional-before-checker',
    optionalWork: true,
    valueCase: optionalValue(),
  }), error => error.code === 'ADMISSION_OPTIONAL_COLLAPSED' &&
    error.details.reason === 'required-work-reserved' &&
    error.details.requiredFrontierSlots === 4 &&
    error.details.optionalLaunchCapacity === 0)
  assert.equal(scheduler.getMetrics().counters.totalLaunches, 0)
  assert.equal(scheduler.getMetrics().counters.optionalAdmitted, 0)
  assert.equal(scheduler.getMetrics().counters.optionalEvaluated, 1,
    'a valid optional value case must collapse before value-admission side effects')
  assert.equal(scheduler.getMetrics().counters.optionalRejected, 1)

  const state = scheduler.exportState()
  const negativeOptionalCount = structuredClone(state)
  negativeOptionalCount.metrics.optionalAdmitted = -1
  assert.throws(() => createTestScheduler({
    settings: negativeOptionalCount.settings,
    state: negativeOptionalCount,
  }), error => error.code === 'INVALID_SCHEDULER_STATE')
  const impossibleOptionalCount = structuredClone(state)
  impossibleOptionalCount.metrics.optionalAdmitted = 1
  impossibleOptionalCount.metrics.optionalEvaluated = 1
  assert.throws(() => createTestScheduler({
    settings: impossibleOptionalCount.settings,
    state: impossibleOptionalCount,
  }), error => error.code === 'INVALID_SCHEDULER_STATE')

  const erasedReservation = structuredClone(state)
  erasedReservation.settings.budget.exactCompletionRequirement = 0
  assert.throws(() => createTestScheduler({
    settings: erasedReservation.settings,
    state: erasedReservation,
  }), error => error.code === 'INVALID_SCHEDULER_SETTINGS')

  const resumed = createTestScheduler({ settings: state.settings, state })
  await assert.rejects(admit(resumed, {
    workItemId: 'positive-value-optional-after-resume',
    optionalWork: true,
    valueCase: optionalValue({ disjointBoundary: 'a distinct resumed optional boundary' }),
  }), error => error.code === 'ADMISSION_OPTIONAL_COLLAPSED' &&
    error.details.reason === 'required-work-reserved')

  const requiredFrontier = [
    ['independent-checker', 'ap-independent-checker', 'verification'],
    ['checker-correction', 'ap-worker', 'work'],
    ['product-repair', 'ap-worker', 'work'],
    ['fresh-recheck', 'ap-independent-checker', 'verification'],
  ]
  for (const [workItemId, role, purpose] of requiredFrontier) {
    const request = { workItemId, equivalenceKey: workItemId, role, purpose, lane: 'main' }
    const requiredCompletionBinding = issueRequiredCompletionBinding(resumed, request)
    const lease = await resumed.acquireWithAuthority(authority(resumed, null, {
      requiredCompletionBinding,
    }), { ...request, requiredCompletionBinding })
    finish(lease)
  }

  assert.equal(resumed.getMetrics().counters.totalLaunches, 4)
  const beyondTarget = {
    workItemId: 'fifth-required-generation', equivalenceKey: 'fifth-required-generation',
    role: 'ap-worker', purpose: 'work', lane: 'main',
  }
  const beyondTargetBinding = issueRequiredCompletionBinding(resumed, beyondTarget)
  finish(await resumed.acquireWithAuthority(authority(resumed, null, {
    requiredCompletionBinding: beyondTargetBinding,
  }), { ...beyondTarget, requiredCompletionBinding: beyondTargetBinding }))
  assert.equal(resumed.getMetrics().counters.totalLaunches, 5)
  assert.equal(resumed.getMetrics().counters.requiredCompletionLaunchOverruns, 1)
  await assert.rejects(admit(resumed, {
    workItemId: 'sixth-unbound-generation', missionEssential: true,
  }), error => error.code === 'LAUNCH_LIMIT')
  const overrunState = resumed.exportState()
  const restoredOverrun = createTestScheduler({ settings: overrunState.settings, state: overrunState })
  assert.equal(restoredOverrun.getMetrics().counters.requiredCompletionLaunchOverruns, 1)
  assert.equal(restoredOverrun.getMetrics().lanes.main.requiredCompletionLaunchOverruns, 1)
  const erasedAuthenticatedOverrun = structuredClone(overrunState)
  erasedAuthenticatedOverrun.metrics.requiredCompletionLaunchOverruns = 0
  assert.throws(() => createTestScheduler({
    settings: erasedAuthenticatedOverrun.settings,
    state: erasedAuthenticatedOverrun,
  }), error => error.code === 'INVALID_SCHEDULER_STATE')
  const impossibleUnboundLaneExcess = structuredClone(overrunState)
  impossibleUnboundLaneExcess.laneCounters.main.requiredCompletionLaunches = 0
  assert.throws(() => createTestScheduler({
    settings: impossibleUnboundLaneExcess.settings,
    state: impossibleUnboundLaneExcess,
  }), error => error.code === 'INVALID_SCHEDULER_STATE')
})

test('aborted queued optional work never claims a durable marginal-value boundary', async () => {
  const scheduler = createTestScheduler()
  const blocker = await admit(scheduler, {
    workItemId: 'optional-boundary-blocker', resources: ['shared-optional-boundary'],
  })
  const controller = new AbortController()
  const queued = admit(scheduler, {
    workItemId: 'queued-optional-boundary', optionalWork: true,
    valueCase: optionalValue({ disjointBoundary: 'queued abort boundary' }),
    resources: ['shared-optional-boundary'], signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(queued, error => error.code === 'ADMISSION_CANCELLED')
  finish(blocker)
  assert.equal(scheduler.getMetrics().economics.optionalBoundaryCount, 0)
  const state = scheduler.exportState()
  assert.doesNotThrow(() => createTestScheduler({ settings: state.settings, state }))
})

test('resume authenticates supplied settings before any benchmark migration', () => {
  const saved = new CentralScheduler({
    route: 'DIRECT', runIdentity: TEST_RUN, maxChildLaunches: 5,
    lanes: { main: { maxLaunches: 2 } },
  }).exportState()
  assert.throws(() => new CentralScheduler({
    route: 'DIRECT', runIdentity: TEST_RUN, state: saved,
    settings: resolveSchedulerSettings({ route: 'DIRECT' }),
  }), error => error.code === 'INVALID_SCHEDULER_STATE')
})

test('P7 route ceilings are exact ceilings, not launch quotas', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(ROUTE_BUDGETS).map(([route, budget]) => [route, [
      budget.maxChildLaunches,
      budget.maxLiveIncludingRoot,
      budget.maxDepth,
      budget.tokens.noncachedInput,
      budget.tokens.cachedInput,
      budget.tokens.output,
    ]])),
    {
      DIRECT: [9, 4, 2, 220000, 900000, 40000],
      LIGHT: [9, 4, 3, 500000, 2200000, 70000],
      ROADMAP: [18, 6, 4, 1200000, 5000000, 160000],
    },
  )
  assert.equal(resolveRouteBudget('ROADMAP', { workGroups: 1 }).maxChildLaunches, 8)
  assert.equal(resolveRouteBudget('ROADMAP', {
    workGroups: 1, requiredChildLaunches: 11,
  }).maxChildLaunches, 11)
  assert.throws(() => resolveRouteBudget('ROADMAP', {
    workGroups: 1, requiredChildLaunches: 99,
  }), error => error.code === 'ROUTE_LAUNCH_REQUIREMENT_INVALID')
  assert.throws(() => resolveRouteBudget('DIRECT', {
    requiredChildLaunches: 6, maxChildLaunches: 5,
  }), error => error.code === 'ROUTE_LAUNCH_REQUIREMENT_INVALID')
  assert.equal(resolveRouteBudget('DIRECT', {
    requiredChildLaunches: 6, maxChildLaunches: 9,
  }).maxChildLaunches, 6)
  assert.equal(resolveRouteBudget('ROADMAP', { workGroups: 20 }).maxChildLaunches, 18)
  assert.equal(resolveRouteBudget('ROADMAP', { userLiveCeiling: 99 }).maxLiveIncludingRoot, 10)

  const unused = createTestScheduler().getMetrics()
  assert.equal(unused.counters.totalLaunches, 0)
  assert.equal(unused.counters.currentLiveIncludingRoot, 1)
})

test('central semaphore includes root, queues fairly, and releases file ownership', async () => {
  const scheduler = createTestScheduler()
  const first = await admit(scheduler, { workItemId: 'one', resources: ['workspace'] })
  const second = await admit(scheduler, { workItemId: 'two' }, first)
  const third = await admit(scheduler, { workItemId: 'three' })
  let fourthStarted = false
  const fourthPromise = admit(scheduler, { workItemId: 'four' })
    .then((lease) => { fourthStarted = true; return lease })
  await Promise.resolve()
  assert.equal(fourthStarted, false)
  assert.equal(scheduler.getMetrics().counters.peakLiveIncludingRoot, 4)

  finish(second)
  const fourth = await fourthPromise
  assert.equal(fourthStarted, true)

  let conflictingStarted = false
  const conflictPromise = admit(scheduler, { workItemId: 'conflict', resources: ['workspace'] })
    .then((lease) => { conflictingStarted = true; return lease })
  finish(third)
  await Promise.resolve()
  assert.equal(conflictingStarted, false, 'a free thread must not bypass exclusive resource ownership')
  finish(first)
  const conflicting = await conflictPromise
  assert.equal(conflictingStarted, true)
  finish(fourth)
  finish(conflicting)
})

test('launch, depth, and progress-aware retry state survive relaunch', async () => {
  const scheduler = createTestScheduler({ maxChildLaunches: 6, maxRetriesPerWorkItem: 1 })
  await assert.rejects(
    admit(scheduler, { workItemId: 'forged-depth', depth: 1 }),
    (error) => error.code === 'CALLER_DEPTH_FORBIDDEN',
  )
  const parent = await admit(scheduler, { workItemId: 'depth-parent' })
  const child = await admit(scheduler, { workItemId: 'depth-child' }, parent)
  await assert.rejects(
    admit(scheduler, { workItemId: 'too-deep' }, child),
    (error) => error.code === 'DEPTH_LIMIT',
  )
  finish(child)
  finish(parent)

  const first = await admit(scheduler, {
    workItemId: 'attempt-1', equivalenceKey: 'same-fix', candidateHash: 'a'.repeat(64),
  })
  first.fail(new Error('red'), ZERO_USAGE)
  const retry = await admit(scheduler, {
    workItemId: 'attempt-2', equivalenceKey: 'same-fix', attempt: 2, candidateHash: 'b'.repeat(64),
  })
  finish(retry, { noncachedInput: 100, output: 10 })
  await assert.rejects(
    admit(scheduler, {
      workItemId: 'attempt-3', equivalenceKey: 'same-fix', candidateHash: 'b'.repeat(64),
    }),
    (error) => error.code === 'RETRY_REASSESSMENT_REQUIRED',
  )

  const state = scheduler.exportState()
  const resumed = createTestScheduler({ maxChildLaunches: 6, maxRetriesPerWorkItem: 1, state })
  assert.equal(resumed.getMetrics().counters.totalLaunches, 4)
  assert.equal(resumed.getMetrics().usage.work.noncachedInput, 100)
  finish(await admit(resumed, { workItemId: 'different' }))
  finish(await admit(resumed, { workItemId: 'last' }))
  await assert.rejects(
    admit(resumed, { workItemId: 'over-ceiling' }),
    (error) => error.code === 'LAUNCH_LIMIT',
  )
})

test('optional work needs positive marginal value while required work converges through token reserves', async () => {
  assert.equal(evaluateMarginalValue(optionalValue()).admitted, true)
  assert.equal(evaluateMarginalValue(optionalValue({ disjointBoundary: '' })).code, 'MARGINAL_VALUE_REQUIRED')
  assert.equal(evaluateMarginalValue(optionalValue({ avoidedRework: 1 })).code, 'OPTIONAL_VALUE_TOO_LOW')

  const scheduler = createTestScheduler()
  await assert.rejects(
    admit(scheduler, {
      workItemId: 'low-value-scout',
      optional: true,
      valueCase: optionalValue({ avoidedRework: 1 }),
    }),
    (error) => error.code === 'OPTIONAL_VALUE_TOO_LOW',
  )
  const admittedOptional = await admit(scheduler, {
    workItemId: 'separate-positive-scout',
    optional: true,
    valueCase: optionalValue(),
  })
  finish(admittedOptional)
  const planning = await admit(scheduler, {
    workItemId: 'planning-over-reserve', purpose: 'planning',
    estimate: { noncachedInput: 150000 },
  })
  assert.equal(scheduler.checkAdmissionTime().convergenceRequired, true)
  finish(planning)
  const requiredWork = await admit(scheduler, {
    workItemId: 'work-over-both-reserves', purpose: 'work',
    estimate: { noncachedInput: 150000 },
  })
  finish(requiredWork)
  await assert.rejects(admit(scheduler, {
    workItemId: 'optional-after-convergence', optional: true, valueCase: optionalValue(),
  }), error => error.code === 'ADMISSION_OPTIONAL_COLLAPSED')
  const checker = await admit(scheduler, {
    workItemId: 'required-check',
    purpose: 'verification',
    estimate: { noncachedInput: 180000 },
  })
  finish(checker, { noncachedInput: 180000 })
  assert.equal(scheduler.getMetrics().usage.verification.noncachedInput, 180000)
})

test('fake clock triggers stable no-progress review without declaring success', () => {
  let now = 1000
  const scheduler = createTestScheduler({ now: () => now })
  now += (8 * 60 * 1000) - 1
  assert.equal(scheduler.checkNoProgress().reviewRequired, false)
  now++
  assert.deepEqual(scheduler.checkNoProgress(), {
    reviewRequired: true,
    code: 'NO_PROGRESS_REVIEW',
    idleMs: 8 * 60 * 1000,
    limitMs: 8 * 60 * 1000,
    lastProgressKind: 'activation',
  })
})

test('admission and session accounting stay componentized and reconcile exactly', async () => {
  const scheduler = createTestScheduler({ route: 'LIGHT' })
  scheduler.recordAdmissionComponent('configuration', 10000)
  scheduler.recordAdmissionComponent('runRecord', 10000)
  scheduler.recordAdmissionComponent('persistence', 10000)
  scheduler.recordAdmissionComponent('firstChildStartup', 10000)
  scheduler.recordAdmissionComponent('routeAnalyst', 60000)
  scheduler.recordAdmissionComponent('routeDecision', 200000)
  const admission = scheduler.recordAdmissionComponent('lightPlanning', 200000)
  assert.equal(admission.withinCeiling, true)
  assert.equal(admission.includedMs, 500000)
  scheduler.recordAdmissionComponent('waitingUser', 999999)
  assert.equal(scheduler.checkAdmissionTime().includedMs, 500000)

  const lease = await admit(scheduler, {
    workItemId: 'accounted-worker',
    estimate: { noncachedInput: 1, cachedInput: 2, output: 3 },
  })
  finish(lease, {
    noncachedInput: 10,
    cachedInput: 20,
    output: 30,
    reasoning: 40,
    weightedCost: 1.25,
    latencyMs: 500,
    workMs: 450,
  })
  scheduler.recordTerminalResult({ accepted: true, reward: 1 })
  const metrics = scheduler.getMetrics()
  assert.deepEqual(metrics.usageTotals, {
    noncachedInput: 10,
    cachedInput: 20,
    output: 30,
    reasoning: 40,
    outputIncludingReasoning: 70,
    weightedCost: 1.25,
    latencyMs: 500,
    workMs: 450,
    normalizedTokenCost: 132,
  })
  assert.equal(metrics.economics.costPerAcceptedSolve, 1.25)
  assert.equal(metrics.economics.costBasis, 'provider-weighted-cost')
})

test('context-free L3 brief stays under 2KB and L4 loads byte-identical request', t => {
  const directory = tempDirectory(t, 'autoprompt-envelope-')
  const original = 'Fix the parser. Preserve this exact trailing newline.\n'
  const pointer = writeRequestEnvelope(directory, original, { route: 'DIRECT' })
  assert.equal(loadRequestEnvelope(pointer), original)

  const dispatch = buildContextFreeBrief({
    role: 'ap-implementer',
    assignment: 'Repair the bounded parser behavior.',
    successChecklist: ['regression is red before and green after'],
    ownership: ['src/parser.js', 'test/parser.test.js'],
    checks: ['node --test test/parser.test.js'],
    requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
  })
  assert.equal(dispatch.fork_turns, 'none')
  assert.equal(dispatch.activation, 'context-free')
  assert.ok(dispatch.briefBytes <= MAX_L3_BRIEF_BYTES)
  assert.equal(dispatch.brief.includes(original), false)
  assert.equal(auditDispatch(dispatch).conformant, true)

  const checker = buildCheckerContext({
    role: 'ap-verifier',
    assignment: 'Check the exact candidate.',
    requestPointer: pointer,
    expectedRequestHash: pointer.hash,
    candidateHash: 'candidate-sha256',
    providerCapabilities: PROVIDER_CAPABILITIES,
  })
  assert.equal(checker.exactRequest, original)
  assert.equal(checker.exactRequestHash, pointer.hash)

  assert.throws(() => buildContextFreeBrief({
    role: 'ap-implementer',
    assignment: 'bad',
    requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
    fullHistory: ['unrelated turn'],
  }), (error) => error.code === 'INHERITED_CONTEXT_FORBIDDEN')
  const oversizedAssignment = buildContextFreeBrief({
    role: 'ap-implementer',
    assignment: 'x'.repeat(MAX_L3_BRIEF_BYTES),
    requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
  })
  assert.ok(oversizedAssignment.briefBytes <= MAX_L3_BRIEF_BYTES)
  assert.equal(oversizedAssignment.brief.includes('x'.repeat(64)), false)
  assert.equal(oversizedAssignment.fetchedEvidence.briefSlice.fields.assignment,
    'x'.repeat(MAX_L3_BRIEF_BYTES))
  assert.equal(auditDispatch(oversizedAssignment).conformant, true)
  const realisticCheckerAssignment = buildCheckerContext({
    role: 'ap-independent-checker', purpose: 'verification',
    assignment: 'Execute every exact route-planned acceptance check. '.repeat(120),
    checks: Array.from({ length: 8 }, (_, index) =>
      `Run downstream acceptance check ${index + 1} with positive, negative, and boundary cases.`),
    requestPointer: pointer, providerCapabilities: PROVIDER_CAPABILITIES,
    fetchedEvidence: {
      verificationDoctrine: Array.from({ length: 6 }, (_, index) =>
        `Independent verification obligation ${index + 1}: bind observed output to the saved deliverable.`),
    },
  })
  assert.ok(realisticCheckerAssignment.briefBytes <= MAX_L3_BRIEF_BYTES)
  assert.ok(realisticCheckerAssignment.contextBudget.componentBytes.fetchedEvidence <= 16384)
  assert.equal(auditDispatch(realisticCheckerAssignment).conformant, true)
  assert.equal(auditDispatch({ role: 'ap-worker', fork_turns: 'all', fullHistory: [] }).conformant, false)
})

test('typed checker reassessment carries bounded recovery context without an internal policy stop', t => {
  const directory = tempDirectory(t, 'autoprompt-checker-recovery-envelope-')
  const pointer = writeRequestEnvelope(directory, 'Verify the repaired candidate.\n', { route: 'DIRECT' })
  const recoveryContext = { type: 'bounded-recovery', code: 'DUPLICATE_REFERENCE_METHOD_CLASS' }
  const dispatch = buildCheckerContext({
    role: 'ap-independent-checker',
    purpose: 'verification',
    assignment: 'Repeat the independent check with a distinct reference method.',
    requestPointer: pointer,
    expectedRequestHash: pointer.hash,
    candidateHash: 'a'.repeat(64),
    providerCapabilities: PROVIDER_CAPABILITIES,
    forkTurns: 1,
    recoveryContext,
  })
  assert.equal(dispatch.fork_turns, '1')
  assert.deepEqual(dispatch.recoveryContext, recoveryContext)
  assert.equal(auditDispatch(dispatch).conformant, true)

  for (const code of ['PLAN_CHECK_RUNTIME_RETRY', 'PLAN_RECHECK_RUNTIME_RETRY']) {
    const planRetry = buildCheckerContext({
      role: 'ap-independent-checker', purpose: 'recovery',
      assignment: 'Retry the plan check with fresh evidence.',
      requestPointer: pointer, expectedRequestHash: pointer.hash,
      candidateHash: 'b'.repeat(64), providerCapabilities: PROVIDER_CAPABILITIES,
      forkTurns: 1, recoveryContext: { type: 'bounded-recovery', code },
    })
    assert.equal(auditDispatch(planRetry).conformant, true)
  }

  for (const [role, purpose, code] of [
    ['ap-worker', 'implementation', 'DUPLICATE_REFERENCE_METHOD_CLASS'],
    ['ap-independent-checker', 'verification', 'ARBITRARY_RECOVERY_CODE'],
    ['ap-independent-checker', 'recovery', 'ARBITRARY_RECOVERY_CODE'],
    ['ap-reviewer', 'recovery', 'PLAN_CHECK_RUNTIME_RETRY'],
    ['ap-run-owner', 'implementation', 'ARBITRARY_RECOVERY_CODE'],
    ['ap-run-owner', 'recovery', 'ARBITRARY_RECOVERY_CODE'],
    ['ap-route-analyst', 'recovery', 'ARBITRARY_RECOVERY_CODE'],
  ]) {
    assert.equal(auditDispatch({
      role, purpose, fork_turns: '1',
      recoveryContext: { type: 'bounded-recovery', code },
    }).conformant, false)
  }
})

test('route transcript content-addresses large outputs and rejects an oversized index', t => {
  const directory = tempDirectory(t, 'autoprompt-transcript-')
  const store = new TranscriptStore(directory, { largeOutputBytes: 16 })
  const entry = store.append({ type: 'tool-output', output: 'z'.repeat(100) })
  assert.equal(entry.blobs.length, 1)
  assert.equal(fs.readFileSync(entry.blobs[0].path, 'utf8'), 'z'.repeat(100))
  assert.ok(store.evidenceIndex([entry]).bytes > 0)
  const resumed = new TranscriptStore(directory, { largeOutputBytes: 16 })
  assert.equal(resumed.append({ type: 'resume' }).sequence, 2)
  assert.throws(
    () => store.evidenceIndex(Array.from({ length: 20 }, () => entry), { maxBytes: 100 }),
    (error) => error.code === 'EVIDENCE_INDEX_TOO_LARGE',
  )
})

test('TranscriptStore append work is linear and validates the existing chain only at resume', t => {
  const directory = tempDirectory(t, 'autoprompt-transcript-linear-')
  const operations = new Map()
  const observe = operation => operations.set(operation, (operations.get(operation) || 0) + 1)
  const store = new TranscriptStore(directory, {
    turnEventLimit: 200,
    turnByteLimit: 1024 * 1024,
    onStorageOperation: observe,
  })
  const eventCount = 120
  for (let index = 0; index < eventCount; index++) {
    store.append({ event: { type: 'item.completed', index }, raw: `event-${index}` })
  }

  assert.equal(operations.get('readdir'), 1)
  assert.equal(operations.get('event-read') || 0, 0)
  assert.equal(operations.get('head-read'), eventCount - 1)
  assert.equal(operations.get('blob-read') || 0, 0)

  const resumed = store.resume()
  assert.equal(resumed.eventCount, eventCount)
  assert.equal(operations.get('readdir'), 2)
  assert.equal(operations.get('event-read'), eventCount)
  assert.equal(operations.get('head-read'), eventCount - 1)
})

test('TranscriptStore bounds overflow storage while preserving exact raw audit and edge evidence', t => {
  const directory = tempDirectory(t, 'autoprompt-transcript-overflow-')
  const store = new TranscriptStore(directory, {
    largeOutputBytes: 16,
    turnEventLimit: 20,
    turnByteLimit: 180,
    edgeEvidenceEvents: 2,
    overflowEvidenceBytes: 256,
  })
  let rollingHash = null
  let totalBytes = 0
  let bytesAtFifty = null
  let finalEntry
  const diskBytes = () => [store.eventsDirectory, store.blobsDirectory]
    .flatMap(folder => fs.readdirSync(folder).map(name => path.join(folder, name)))
    .reduce((sum, file) => sum + fs.statSync(file).size, 0)

  for (let index = 1; index <= 500; index++) {
    const event = { type: 'item.completed', index, output: 'x'.repeat(64) }
    const raw = JSON.stringify(event)
    const rawBytes = Buffer.byteLength(raw, 'utf8')
    const rawHash = crypto.createHash('sha256').update(raw).digest('hex')
    totalBytes += rawBytes
    rollingHash = transcriptRollingHash(rollingHash, rawHash, rawBytes)
    finalEntry = store.append({ event, raw })
    if (index === 50) bytesAtFifty = diskBytes()
  }

  assert.equal(fs.readdirSync(store.eventsDirectory).length, 3)
  assert.equal(fs.readdirSync(store.blobsDirectory).length, 1)
  assert.ok(diskBytes() < bytesAtFifty + 4096)
  assert.equal(finalEntry.sequence, 500)
  assert.equal(finalEntry.storedSequence, 3)
  assert.equal(finalEntry.totalBytes, totalBytes)
  assert.equal(finalEntry.rollingHash, rollingHash)

  const first = store.read(1)
  assert.equal(Object.hasOwn(first.payload, 'raw'), false)
  assert.equal(first.payload.rawLine.bytes, Buffer.byteLength(JSON.stringify({
    type: 'item.completed', index: 1, output: 'x'.repeat(64),
  }), 'utf8'))
  const physical = store.readAll({ maxEvents: 10, maxBytes: 100000 }).events
  const summary = physical.at(-1).payload.$transcriptOverflow
  assert.equal(summary.eventCount, 500)
  assert.equal(summary.totalBytes, totalBytes)
  assert.equal(summary.rollingHash, rollingHash)
  assert.deepEqual(summary.firstEvidence.map(item => item.eventIndex), [1, 2])
  assert.deepEqual(summary.lastEvidence.map(item => item.eventIndex), [499, 500])

  const restarted = new TranscriptStore(directory, {
    largeOutputBytes: 16,
    turnEventLimit: 20,
    turnByteLimit: 180,
    edgeEvidenceEvents: 2,
    overflowEvidenceBytes: 256,
  }).resume()
  assert.equal(restarted.eventCount, 500)
  assert.equal(restarted.storedEventCount, 3)
  assert.equal(restarted.totalBytes, totalBytes)
  assert.equal(restarted.rollingHash, rollingHash)
  assert.equal(restarted.overflow, true)
})

test('TranscriptStore recovers an authenticated overflow-tail replacement interrupted before cleanup', t => {
  const directory = tempDirectory(t, 'autoprompt-transcript-tail-recovery-')
  let inject = true
  const options = {
    turnEventLimit: 1,
    turnByteLimit: 1024,
    edgeEvidenceEvents: 2,
    faultInjector(point) {
      if (inject && point === 'tail-written-before-old-remove') {
        inject = false
        throw new Error('simulated tail replacement crash')
      }
    },
  }
  const store = new TranscriptStore(directory, options)
  let rollingHash = null
  let totalBytes = 0
  const append = (target, index) => {
    const event = { type: 'item.completed', index }
    const raw = JSON.stringify(event)
    const rawBytes = Buffer.byteLength(raw, 'utf8')
    const rawHash = crypto.createHash('sha256').update(raw).digest('hex')
    totalBytes += rawBytes
    rollingHash = transcriptRollingHash(rollingHash, rawHash, rawBytes)
    return target.append({ event, raw })
  }

  append(store, 1)
  append(store, 2)
  append(store, 3)
  assert.throws(() => append(store, 4), /simulated tail replacement crash/)
  assert.equal(fs.readdirSync(store.eventsDirectory).length, 4)

  const recovered = new TranscriptStore(directory, {
    turnEventLimit: 1, turnByteLimit: 1024, edgeEvidenceEvents: 2,
  })
  assert.equal(fs.readdirSync(recovered.eventsDirectory).length, 3)
  assert.equal(recovered.resume().eventCount, 4)
  assert.equal(recovered.resume().totalBytes, totalBytes)
  assert.equal(recovered.resume().rollingHash, rollingHash)

  const finalEntry = append(recovered, 5)
  assert.equal(finalEntry.sequence, 5)
  assert.equal(finalEntry.storedSequence, 3)
  assert.equal(finalEntry.totalBytes, totalBytes)
  assert.equal(finalEntry.rollingHash, rollingHash)
  const restarted = new TranscriptStore(directory, {
    turnEventLimit: 1, turnByteLimit: 1024, edgeEvidenceEvents: 2,
  }).resume()
  assert.equal(restarted.eventCount, 5)
  assert.equal(restarted.storedEventCount, 3)
  assert.equal(restarted.totalBytes, totalBytes)
  assert.equal(restarted.rollingHash, rollingHash)
})

test('effort is independent of route, user pins win, and cheapest admissible model is selected', () => {
  const direct = selectEffort({ route: 'DIRECT', role: 'security-reviewer', risk: 'critical' })
  const roadmap = selectEffort({ route: 'ROADMAP', role: 'security-reviewer', risk: 'critical' })
  assert.equal(direct.effort, 'xhigh')
  assert.equal(roadmap.effort, direct.effort)
  assert.equal(selectEffort({ role: 'finalizer', difficulty: 'low' }).effort, 'low')
  assert.equal(selectEffort({ role: 'finalizer', explicitPin: { effort: 'max' } }).effort, 'max')

  const registry = [
    {
      id: 'expensive', verified: true, efforts: ['medium'], capabilities: { tools: true },
      price: { perTokens: 1000000, noncachedInput: 10, cachedInput: 2, output: 20 },
      latency: { p50Ms: 100, sampleSize: 50 }, yield: { successRate: 0.95, sampleSize: 50 },
    },
    {
      id: 'cheap', verified: true, efforts: ['medium'], capabilities: { tools: true },
      price: { perTokens: 1000000, noncachedInput: 1, cachedInput: 0.5, output: 2 },
      latency: { p50Ms: 200, sampleSize: 50 }, yield: { successRate: 0.9, sampleSize: 50 },
    },
  ]
  const selected = selectModelAssignment({
    role: 'worker',
    registry,
    requiredCapabilities: ['tools'],
    workload: { noncachedInput: 100000, output: 10000 },
  })
  assert.equal(selected.model, 'cheap')
  assert.equal(selectModelAssignment({
    role: 'worker', registry, explicitPin: { model: 'expensive', effort: 'medium' },
  }).model, 'expensive')
})

test('one-vs-two L4 matrix requires a named, distinct second responsibility', () => {
  assert.equal(decideCheckerPlan({ bounded: true, toolchains: 1 }).count, 1)
  const blocked = decideCheckerPlan({ bounded: true, toolchains: 1, security: true })
  assert.equal(blocked.count, 2)
  assert.equal(blocked.launchable, false)
  assert.equal(blocked.blocker, 'SECOND_CHECKER_RESPONSIBILITY_REQUIRED')
  const split = decideCheckerPlan({
    bounded: true,
    toolchains: 1,
    concurrency: true,
    firstResponsibility: 'static correctness review',
    secondResponsibility: 'race and runtime stress checks',
  })
  assert.equal(split.count, 2)
  assert.equal(split.launchable, true)
})

test('write-producing L4 checks isolate or serialize every realistic resource collision', t => {
  const directory = tempDirectory(t, 'autoprompt-checks-')
  const resources = [
    { kind: 'workspace', id: path.join(directory, 'repo') },
    { kind: 'cache', id: path.join(directory, 'cache') },
    { kind: 'database', id: 'test-db' },
    { kind: 'service', id: 'api-test' },
    { kind: 'port', id: '43123' },
  ]
  const checkers = [
    { id: 'reviewer', writeProducing: true, writeResources: resources },
    { id: 'tester', writeProducing: true, writeResources: resources },
  ]
  const exclusive = planCheckerSandboxes(checkers, {
    isolatedChecking: false,
    providerCapabilities: SERIAL_PROVIDER_CAPABILITIES,
  })
  assert.equal(exclusive.parallel, false)
  assert.deepEqual(exclusive.batches, [['reviewer'], ['tester']])
  assert.equal(exclusive.collisions[0].resources.length, 5)
  assert.throws(() => assertSafeParallel(exclusive), (error) => error.code === 'CHECK_RESOURCE_COLLISION')

  const isolated = planCheckerSandboxes(checkers, {
    isolatedChecking: true,
    providerCapabilities: PROVIDER_CAPABILITIES,
  })
  assert.equal(isolated.parallel, true)
  assert.deepEqual(isolated.batches, [['reviewer', 'tester']])
  assert.notEqual(
    isolated.assignments[0].schedulerResources[0].isolationId,
    isolated.assignments[1].schedulerResources[0].isolationId,
  )

  assert.throws(
    () => planCheckerSandboxes([{ id: 'unsafe', commands: ['node --test'] }], {
      workspace: path.join(directory, 'repo'),
      providerCapabilities: SERIAL_PROVIDER_CAPABILITIES,
    }),
    (error) => error.code === 'PROVIDER_UNSUPPORTED',
  )

  const registryRoot = path.join(directory, 'sandboxes')
  const registry = new TemporarySandboxRegistry(registryRoot)
  const registered = registry.create('runtime-checker')
  assert.ok(fs.existsSync(registered))
  assert.throws(() => registry.cleanup(directory), (error) => error.code === 'UNREGISTERED_SANDBOX')
  assert.equal(registry.cleanup(registered), true)
  assert.equal(fs.existsSync(registered), false)
})

test('fake stream records reasoning diagnostically without double-counting the output ceiling', async () => {
  const settings = resolveSchedulerSettings({
    route: 'DIRECT',
    lanes: {
      optional: {
        maxLaunches: 2,
        maxLive: 1,
        tokens: { noncachedInput: 1000, cachedInput: 1000, output: 100 },
      },
    },
  })
  let now = 0
  const scheduler = createTestScheduler({ settings, now: () => now })
  const lease = await admit(scheduler, {
    workItemId: 'streaming-scout',
    lane: 'optional',
    optional: true,
    valueCase: optionalValue(),
    estimate: { output: 10, reasoning: 10 },
  })
  now = 100
  const first = lease.reportUsage({
    noncachedInput: 0,
    cachedInput: 0,
    output: 40,
    reasoning: 40,
  }, { productive: true })
  assert.equal(first.continue, true)
  assert.equal(scheduler.getMetrics().progress.idleMs, 0)
  assert.equal(lease.authorizeUsage({ noncachedInput: 0, cachedInput: 0, output: 70, reasoning: 30 }).allowed, false)
  const stopped = lease.reportUsage({ noncachedInput: 0, cachedInput: 0, output: 70, reasoning: 30 })
  assert.equal(stopped.continue, false)
  assert.equal(stopped.code, 'ADMISSION_CONVERGENCE_REQUIRED')
  assert.deepEqual(stopped.hardCeilings, ['lane:optional:output'])
  lease.fail(new Error('optional stream collapsed'))
  const metrics = scheduler.getMetrics()
  assert.equal(metrics.usageTotals.output, 110)
  assert.equal(metrics.usageTotals.reasoning, 70)
  assert.equal(metrics.usageTotals.outputIncludingReasoning, 180)
  assert.equal(metrics.counters.streamReports, 2)
  assert.equal(metrics.counters.forcedStops, 1)
})

test('launch authority binds physical caller, run generation, parent, lane, and route live settings', async () => {
  assert.throws(() => createTestScheduler({
    settings: {
      schemaVersion: 1,
      route: 'DIRECT',
      budget: { ...ROUTE_BUDGETS.DIRECT, maxLiveIncludingRoot: 99 },
      lanes: { main: { maxLaunches: 1, maxLive: 1, tokens: ROUTE_BUDGETS.DIRECT.tokens } },
    },
  }), (error) => error.code === 'INVALID_SCHEDULER_SETTINGS')
  const settings = resolveSchedulerSettings({
    route: 'DIRECT',
    liveCeiling: 3,
    lanes: {
      a: { maxLaunches: 1, maxLive: 1 },
      b: { maxLaunches: 1, maxLive: 1 },
      c: { maxLaunches: 1, maxLive: 1 },
    },
  })
  const scheduler = createTestScheduler({ settings })
  assert.throws(() => scheduler.issueLaunchAuthority({
    callerRole: 'ap-root',
    sessionId: 'wrong-generation',
    runId: TEST_RUN.runId,
    generation: 99,
    providerCapabilities: PROVIDER_CAPABILITIES,
  }), (error) => error.code === 'RUN_GENERATION_MISMATCH')

  const authA = authority(scheduler)
  await assert.rejects(
    scheduler.acquire({ _authority: authA, workItemId: 'direct-bypass', role: 'ap-worker', lane: 'a' }),
    (error) => error.code === 'INVALID_LAUNCH_AUTHORITY',
  )
  const a = await scheduler.acquireWithAuthority(authA, { workItemId: 'a1', role: 'ap-worker', lane: 'a' })
  await assert.rejects(
    scheduler.acquireWithAuthority(authA, { workItemId: 'replay', role: 'ap-worker', lane: 'a' }),
    (error) => error.code === 'INVALID_LAUNCH_AUTHORITY',
  )
  const b = await admit(scheduler, { workItemId: 'b1', lane: 'b' })
  let thirdStarted = false
  const thirdPromise = admit(scheduler, { workItemId: 'c1', lane: 'c' }).then((lease) => {
    thirdStarted = true
    return lease
  })
  await Promise.resolve()
  assert.equal(thirdStarted, false)
  assert.equal(scheduler.getMetrics().counters.currentLiveIncludingRoot, 3)
  finish(b)
  const c = await thirdPromise
  assert.equal(thirdStarted, true)
  finish(a)
  finish(c)
  await assert.rejects(
    admit(scheduler, { workItemId: 'a2', lane: 'a' }),
    (error) => error.code === 'LANE_LAUNCH_LIMIT',
  )
})

test('finalization rejects missing token classes so output or reasoning cannot bypass accounting', async () => {
  const scheduler = createTestScheduler()
  const lease = await admit(scheduler, { workItemId: 'incomplete-accounting', resources: ['exclusive-workspace'] })
  assert.throws(() => lease.reportUsage({ output: 10 }), (error) => error.code === 'INCOMPLETE_USAGE_REPORT')
  assert.throws(() => lease.complete({ output: 10 }), (error) => error.code === 'INCOMPLETE_USAGE_ACCOUNTING')
  assert.equal(scheduler.getMetrics().counters.currentLiveChildren, 0)
  assert.equal(scheduler.getMetrics().usageTotals.output, 10, 'reported category is retained without inventing missing fields')
  const replacement = await admit(scheduler, { workItemId: 'replacement-accounting', resources: ['exclusive-workspace'] })
  replacement.reportUsage({ noncachedInput: 1, cachedInput: 2, output: 10, reasoning: 3 })
  assert.equal(replacement.complete(), true)
  assert.equal(scheduler.getMetrics().usageTotals.outputIncludingReasoning, 23)
})

test('phase integration never resets on grace before hard without typed no-progress', () => {
  assert.deepEqual(phaseBudgetVerdict({
    elapsedMs: 200,
    softMs: 100,
    hardMs: 1000,
    recoveryRequest: true,
  }), {
    action: 'warn', canReset: false, hardReached: false, code: 'PHASE_SOFT_WARNING',
  })
  assert.equal(phaseBudgetVerdict({
    elapsedMs: 500,
    softMs: 100,
    hardMs: 1000,
    noProgressInvariant: { code: 'NO_PROGRESS_INVARIANT', observedMs: 400, limitMs: 300 },
  }).canReset, true)
  assert.deepEqual(phaseBudgetVerdict({ elapsedMs: 1000, softMs: 100, hardMs: 1000 }), {
    action: 'hard-boundary', canReset: true, hardReached: true, code: 'PHASE_HARD_BOUNDARY',
  })
  assert.throws(() => phaseBudgetVerdict({ elapsedMs: 200, softMs: 100, hardMs: 1000, graceElapsed: true }),
    (error) => error.code === 'LEGACY_PHASE_GRACE_UNSUPPORTED')
})

test('provider capability contracts fail closed for dispatch and checking', t => {
  const directory = tempDirectory(t, 'autoprompt-capabilities-')
  const pointer = writeRequestEnvelope(directory, 'exact request')
  assert.throws(() => buildContextFreeBrief({
    role: 'ap-worker', assignment: 'work', requestPointer: pointer,
  }), (error) => error.code === 'PROVIDER_CAPABILITIES_UNKNOWN')
  assert.throws(() => buildContextFreeBrief({
    role: 'ap-worker', assignment: 'work', requestPointer: pointer,
    providerCapabilities: { ...PROVIDER_CAPABILITIES, eventStreaming: false },
  }), (error) => error.code === 'PROVIDER_UNSUPPORTED')
  assert.throws(() => planCheckerSandboxes([{
    id: 'checker', writeProducing: true, writeResources: [{ kind: 'workspace', id: directory }],
  }]), (error) => error.code === 'PROVIDER_CAPABILITIES_UNKNOWN')
})

test('TranscriptStore reports tamper, truncation, gaps, blob corruption, and bounded reads', t => {
  const tamperRoot = tempDirectory(t, 'autoprompt-transcript-tamper-')
  const tamper = new TranscriptStore(tamperRoot, { largeOutputBytes: 8 })
  const first = tamper.append({ type: 'one' })
  const second = tamper.append({ type: 'two' })
  assert.equal(tamper.read(1).payload.type, 'one')
  assert.deepEqual(
    Object.fromEntries(Object.entries(tamper.resume()).filter(([key]) =>
      ['status', 'eventCount', 'nextSequence', 'headHash'].includes(key))),
    { status: 'COMPLETE', eventCount: 2, nextSequence: 3, headHash: second.hash },
  )
  assert.throws(() => tamper.readAll({ maxEvents: 1, maxBytes: 100000 }),
    (error) => error.code === 'TRANSCRIPT_READ_BOUND')
  fs.appendFileSync(second.path, ' ')
  assert.throws(() => tamper.append({ type: 'three' }),
    (error) => error.code === 'TRANSCRIPT_APPEND_DRIFT')
  fs.appendFileSync(first.path, ' ')
  assert.throws(() => new TranscriptStore(tamperRoot),
    (error) => ['TRANSCRIPT_HASH_MISMATCH', 'TRANSCRIPT_CONTENT_INVALID'].includes(error.code))

  const truncatedRoot = tempDirectory(t, 'autoprompt-transcript-truncated-')
  const truncated = new TranscriptStore(truncatedRoot)
  const truncatedEntry = truncated.append({ type: 'one' })
  fs.writeFileSync(truncatedEntry.path, '{')
  assert.throws(() => new TranscriptStore(truncatedRoot), (error) => error.code === 'TRANSCRIPT_TRUNCATED')

  const gapRoot = tempDirectory(t, 'autoprompt-transcript-gap-')
  const gap = new TranscriptStore(gapRoot)
  gap.append({ type: 'one' })
  const gapSecond = gap.append({ type: 'two' })
  fs.renameSync(gapSecond.path, path.join(path.dirname(gapSecond.path), `00000003-${gapSecond.hash}.json`))
  assert.throws(() => gap.append({ type: 'three' }),
    (error) => error.code === 'TRANSCRIPT_APPEND_DRIFT')
  assert.throws(() => new TranscriptStore(gapRoot), (error) => error.code === 'TRANSCRIPT_GAP')

  const blobRoot = tempDirectory(t, 'autoprompt-transcript-blob-')
  const blob = new TranscriptStore(blobRoot, { largeOutputBytes: 8 })
  const blobEntry = blob.append({ output: 'x'.repeat(50) })
  fs.writeFileSync(blobEntry.blobs[0].path, 'corrupt')
  assert.throws(() => new TranscriptStore(blobRoot), (error) => error.code === 'TRANSCRIPT_BLOB_INVALID')
})

test('sandbox defaults unknown commands to serialized snapshots and rejects nested physical paths', t => {
  const directory = tempDirectory(t, 'autoprompt-sandbox-race-')
  const workspace = path.join(directory, 'workspace')
  fs.mkdirSync(workspace)
  const defaultPlan = planCheckerSandboxes([
    { id: 'one', commands: ['node --test'], workspace },
    { id: 'two', commands: [{ command: 'npm test' }], workspace },
  ], { providerCapabilities: PROVIDER_CAPABILITIES })
  assert.deepEqual(defaultPlan.batches, [['one'], ['two']])
  assert.equal(defaultPlan.assignments.every((assignment) => assignment.snapshotRequired), true)

  assert.throws(() => materializeCheckerSandboxes(defaultPlan, () => path.join(workspace, 'nested')),
    (error) => ['SNAPSHOT_CREATION_FAILED', 'SNAPSHOT_NOT_ISOLATED'].includes(error.code))

  const nested = path.join(workspace, 'nested-resource')
  const collisionPlan = planCheckerSandboxes([
    { id: 'parent', commands: ['test'], writeResources: [{ kind: 'workspace', id: workspace }] },
    { id: 'nested', commands: ['test'], writeResources: [{ kind: 'workspace', id: nested }] },
  ], { providerCapabilities: SERIAL_PROVIDER_CAPABILITIES })
  assert.equal(collisionPlan.parallel, false)
})

test('checker matrix recognizes canonical visual/destructive/external risks', () => {
  for (const risk of ['visual-behavior', 'destructive-change', 'external-change']) {
    const plan = decideCheckerPlan({
      bounded: true,
      toolchains: 1,
      risks: [risk],
      firstResponsibility: 'static change review',
      secondResponsibility: `${risk} behavior attack`,
    })
    assert.equal(plan.count, 2)
    assert.equal(plan.launchable, true)
    assert.match(plan.reasons.join(' '), new RegExp(risk))
  }
  assert.equal(decideCheckerPlan({ bounded: true, toolchains: 1 }).count, 1)
})

test('unverified or zero-fabricated model metadata is never cheapest or perfect', () => {
  const valid = {
    id: 'valid', verified: true, efforts: ['medium'], capabilities: { tools: true },
    price: { perTokens: 1000000, noncachedInput: 2, cachedInput: 1, output: 4 },
    latency: { p50Ms: 200, sampleSize: 25 }, yield: { successRate: 0.8, sampleSize: 25 },
  }
  const fabricated = {
    id: 'fabricated', efforts: ['medium'], capabilities: { tools: true },
    price: { perTokens: 1000000, noncachedInput: 0, cachedInput: 0, output: 0 },
    latencyP50Ms: 0, measuredSuccess: 1,
  }
  assert.equal(selectModelAssignment({
    role: 'worker', registry: [fabricated, valid], requiredCapabilities: ['tools'],
    workload: { noncachedInput: 100, cachedInput: 100, output: 100, reasoning: 100 },
  }).model, 'valid')
  assert.throws(() => selectModelAssignment({ role: 'worker', registry: [fabricated] }),
    (error) => error.code === 'NO_ADMISSIBLE_MODEL')
  assert.throws(() => selectModelAssignment({
    role: 'worker', registry: [fabricated, valid], explicitPin: { model: 'fabricated', effort: 'medium' },
  }), (error) => error.code === 'PINNED_MODEL_METADATA_INVALID')
})

test('context audit rejects normalized inherited-history aliases recursively with no fork history', t => {
  const directory = tempDirectory(t, 'autoprompt-context-aliases-')
  const pointer = writeRequestEnvelope(directory, 'exact')
  for (const forbidden of ['full_history', 'Full-History', 'FULL_HISTORY', 'conversation_history', 'Raw-Transcript']) {
    const dispatch = { role: 'ap-worker', fork_turns: 'none', nested: { [forbidden]: [] } }
    assert.equal(auditDispatch(dispatch).conformant, false, forbidden)
    assert.throws(() => buildContextFreeBrief({
      role: 'ap-worker', assignment: 'bounded', requestPointer: pointer,
      providerCapabilities: PROVIDER_CAPABILITIES, nested: { [forbidden]: [] },
    }), (error) => error.code === 'INHERITED_CONTEXT_FORBIDDEN')
  }
})

test('a nonempty resource manifest is write-producing and nested workspaces cannot run read-only in parallel', t => {
  const directory = tempDirectory(t, 'autoprompt-manifest-writes-')
  const workspace = path.join(directory, 'workspace')
  const nested = path.join(workspace, 'nested')
  fs.mkdirSync(nested, { recursive: true })
  const plan = planCheckerSandboxes([
    { id: 'declared-parent', readOnly: true, writeResources: [{ kind: 'workspace', id: workspace }] },
    { id: 'declared-child', writeProducing: false, writeManifest: [{ kind: 'workspace', id: nested }] },
  ], { providerCapabilities: SERIAL_PROVIDER_CAPABILITIES })
  assert.equal(plan.assignments.every((assignment) => assignment.writeProducing), true)
  assert.equal(plan.assignments.every((assignment) => assignment.mode === 'exclusive'), true)
  assert.deepEqual(plan.batches, [['declared-parent'], ['declared-child']])
})

test('an admission target breach admits essential work sequentially and collapses optional expansion', async () => {
  const scheduler = createTestScheduler()
  const verdict = scheduler.recordAdmissionComponent('routeAnalyst', (60 * 1000) + 1)
  assert.equal(verdict.withinCeiling, false)
  assert.equal(verdict.withinTarget, false)
  const required = await admit(scheduler, { workItemId: 'late-required-work' })
  let secondStarted = false
  const secondPromise = admit(scheduler, { workItemId: 'late-required-work-2' }).then(lease => {
    secondStarted = true
    return lease
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondStarted, false)
  finish(required)
  const second = await secondPromise
  assert.equal(secondStarted, true)
  finish(second)
  const requiredRecheck = await admit(scheduler, {
    workItemId: 'late-required-work-recheck', equivalenceKey: 'late-required-work',
    purpose: 'verification', candidateHash: 'a'.repeat(64),
  })
  finish(requiredRecheck)
  await assert.rejects(admit(scheduler, {
    workItemId: 'late-optional-expansion', optional: true, valueCase: optionalValue(),
  }), (error) => {
    assert.equal(error.code, 'ADMISSION_OPTIONAL_COLLAPSED')
    assert.deepEqual(error.details.breaches, ['routeAnalyst'])
    return true
  })
})

test('ROADMAP retained ancestors cannot deadlock low global or lane live ceilings', async () => {
  const scenarios = [
    { name: 'normal-global-2', liveCeiling: 2, converged: false },
    { name: 'converged-global-2', liveCeiling: 2, converged: true },
    { name: 'normal-global-3', liveCeiling: 3, converged: false },
    { name: 'converged-global-3', liveCeiling: 3, converged: true },
    { name: 'normal-lane-1', liveCeiling: 4, laneMaxLive: 1, converged: false },
    { name: 'converged-lane-1', liveCeiling: 4, laneMaxLive: 1, converged: true },
  ]
  for (const scenario of scenarios) {
    const settings = resolveSchedulerSettings({
      route: 'ROADMAP',
      liveCeiling: scenario.liveCeiling,
      lanes: { main: { maxLive: scenario.laneMaxLive } },
    })
    const scheduler = new CentralScheduler({ settings, runIdentity: TEST_RUN })
    if (scenario.converged) scheduler.recordAdmissionComponent('routeAnalyst', (60 * 1000) + 1)
    assert.equal(scheduler.checkAdmissionTime().convergenceRequired, scenario.converged, scenario.name)

    const coordinator = await admit(scheduler, {
      workItemId: `${scenario.name}-coordinator`, purpose: 'planning',
    })
    const manager = await admit(scheduler, {
      workItemId: `${scenario.name}-manager`, purpose: 'planning',
    }, coordinator)
    const worker = await admit(scheduler, {
      workItemId: `${scenario.name}-worker`, purpose: 'work',
    }, manager)
    assert.equal(scheduler.getMetrics().limits.effectiveMaxLiveIncludingRoot, 4, scenario.name)

    let siblingStarted = false
    const siblingPromise = admit(scheduler, {
      workItemId: `${scenario.name}-sibling`, purpose: 'work',
    }, manager).then(lease => { siblingStarted = true; return lease })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(siblingStarted, false, `${scenario.name} admits only one required leaf at a time`)
    finish(worker)
    const sibling = await siblingPromise
    assert.equal(siblingStarted, true, scenario.name)
    finish(sibling)
    finish(manager)
    finish(coordinator)
    assert.equal(scheduler.getMetrics().counters.currentLiveChildren, 0, scenario.name)
  }
})

test('required admission remains queued past an elapsed target and starts after its resource releases', async () => {
  const scheduler = createTestScheduler()
  const holder = await admit(scheduler, {
    workItemId: 'queue-watchdog-holder', resources: ['workspace'],
  })
  let waiterStarted = false
  const waiterPromise = admit(scheduler, {
    workItemId: 'queue-watchdog-waiter', resources: ['workspace'],
  }).then(lease => {
    waiterStarted = true
    return lease
  })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(waiterStarted, false)
  finish(holder)
  const waiter = await waiterPromise
  assert.equal(waiterStarted, true)
  finish(waiter)
  assert.equal(scheduler.getMetrics().counters.currentLiveChildren, 0)
})

test('unpriced provider usage gets a deterministic normalized cost without inventing provider billing', async () => {
  const scheduler = createTestScheduler()
  const lease = await admit(scheduler, { workItemId: 'unpriced-usage' })
  finish(lease, { noncachedInput: 10, cachedInput: 20, output: 30, reasoning: 5 })
  scheduler.recordTerminalResult({ accepted: true })
  const metrics = scheduler.getMetrics()
  assert.equal(metrics.usageTotals.weightedCost, 0)
  assert.equal(metrics.usageTotals.normalizedTokenCost, 132)
  assert.equal(metrics.economics.costPerAcceptedSolve, 132)
  assert.equal(metrics.economics.costBasis, 'normalized-token-cost')
})

test('token target breach converges while required repair/recheck remains admitted', async () => {
  const settings = resolveSchedulerSettings({
    route: 'DIRECT',
    lanes: { main: { tokens: { noncachedInput: 1000, cachedInput: 1000, output: 100 } } },
  })
  const scheduler = createTestScheduler({ settings })
  const streamed = await admit(scheduler, { workItemId: 'stream-over-hard' })
  const stopped = streamed.reportUsage({ noncachedInput: 0, cachedInput: 0, output: 110, reasoning: 40 })
  assert.equal(stopped.code, 'ADMISSION_CONVERGENCE_REQUIRED')
  assert.equal(stopped.continue, true)
  assert.equal(stopped.completionCanContinue, true)
  assert.equal(scheduler.checkAdmissionTime().withinCeiling, false)
  streamed.complete()
  assert.equal(scheduler.getMetrics().counters.currentLiveChildren, 0)
  const requiredRetry = await admit(scheduler, {
    workItemId: 'stream-over-hard-retry', equivalenceKey: 'stream-over-hard',
    purpose: 'verification', candidateHash: 'a'.repeat(64),
  })
  finish(requiredRetry)
  await assert.rejects(admit(scheduler, {
    workItemId: 'stream-over-hard-optional-retry', equivalenceKey: 'stream-over-hard',
    optional: true, valueCase: optionalValue(), candidateHash: 'b'.repeat(64),
  }), error => error.code === 'ADMISSION_OPTIONAL_COLLAPSED')
  const requiredContinuation = await admit(scheduler, {
    workItemId: 'required-direct-continuation', purpose: 'verification',
  })
  finish(requiredContinuation)

  const finalScheduler = createTestScheduler({ settings })
  const finalOnly = await admit(finalScheduler, { workItemId: 'final-over-hard' })
  finalOnly.complete({ noncachedInput: 0, cachedInput: 0, output: 110, reasoning: 30 })
  assert.equal(finalScheduler.getMetrics().counters.currentLiveChildren, 0)
  assert.equal(finalScheduler.getMetrics().counters.completed, 1)
})

test('pending scheduler launches exactly one analyst and root-accounts L0 without a child launch', async () => {
  const scheduler = new CentralScheduler({ route: 'PENDING', runIdentity: TEST_RUN })
  const analystAuthority = authority(scheduler)
  const analyst = await scheduler.acquireWithAuthority(analystAuthority, {
    workItemId: 'route-analyst', role: 'ap-route-analyst', lane: 'routeAnalyst',
    purpose: 'planning', estimate: { noncachedInput: 100 },
  })
  assert.throws(() => scheduler.freezeRoute('DIRECT', resolveSchedulerSettings({ route: 'DIRECT' })),
    (error) => error.code === 'ROUTE_FREEZE_NOT_DRAINED')
  finish(analyst, { noncachedInput: 100 })
  assert.throws(() => scheduler.freezeRoute('DIRECT', resolveSchedulerSettings({ route: 'DIRECT' })),
    (error) => error.code === 'ROUTE_DECISION_INCOMPLETE')
  await assert.rejects(scheduler.acquireWithAuthority(authority(scheduler), {
    workItemId: 'forged-l0-child', role: 'ap-run-owner', lane: 'routeDecision', purpose: 'planning',
  }), (error) => ['UNKNOWN_LANE', 'PENDING_ADMISSION_ROLE', 'LAUNCH_LIMIT'].includes(error.code))
  const decision = scheduler.beginRootAccounting({ phase: 'routeDecision', sessionId: 'root-l0-session' })
  assert.equal(scheduler.getMetrics().counters.totalLaunches, 1)
  assert.equal(scheduler.getMetrics().counters.currentLiveChildren, 0)
  const rootReport = decision.reportUsage({ noncachedInput: 20, cachedInput: 0, output: 0, reasoning: 0 })
  assert.equal(rootReport.continue, true)
  decision.complete({})
  const frozen = scheduler.freezeRoute('DIRECT', resolveSchedulerSettings({ route: 'DIRECT' }))
  assert.equal(frozen.route, 'DIRECT')
  assert.equal(frozen.rootDecisionAccounted, true)
  assert.equal(scheduler.getMetrics().counters.totalLaunches, 1)
  assert.equal(scheduler.getMetrics().usage.planning.noncachedInput, 120)
  const worker = await admit(scheduler, { workItemId: 'post-route-worker', lane: 'main' })
  finish(worker)
  assert.equal(scheduler.getMetrics().counters.totalLaunches, 2)
  const resumed = new CentralScheduler({ runIdentity: TEST_RUN, state: scheduler.exportState() })
  assert.equal(resumed.route, 'DIRECT')
  assert.equal(resumed.getMetrics().counters.totalLaunches, 2)
  assert.equal(resumed.getMetrics().usage.planning.noncachedInput, 120)
  assert.equal(resumed.getMetrics().rootAccounting.status, 'completed')
  assert.throws(() => scheduler.freezeRoute('LIGHT', resolveSchedulerSettings({ route: 'LIGHT' })),
    (error) => error.code === 'ROUTE_ALREADY_FROZEN')
})

test('late analyst and root usage remains factual while a valid DIRECT task continues', async () => {
  const scheduler = new CentralScheduler({
    route: 'PENDING', runIdentity: TEST_RUN,
    environment: {
      AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1',
      AUTOPROMPT_BENCHMARK_NO_TOKEN_LIMIT: '1',
    },
  })
  const analyst = await scheduler.acquireWithAuthority(authority(scheduler), {
    workItemId: 'route-analyst', role: 'ap-route-analyst', lane: 'routeAnalyst', purpose: 'planning',
  })
  const analystVerdict = analyst.reportUsage({
    noncachedInput: 230000, cachedInput: 0, output: 0, reasoning: 0,
  })
  assert.equal(analystVerdict.continue, true)
  assert.equal(analystVerdict.code, 'ADMISSION_CONVERGENCE_REQUIRED')
  analyst.complete()

  const root = scheduler.beginRootAccounting({ phase: 'routeDecision', sessionId: 'late-valid-root' })
  const rootVerdict = root.reportUsage({
    noncachedInput: 0, cachedInput: 0, output: 41000, reasoning: 0,
  })
  assert.equal(rootVerdict.continue, true)
  assert.equal(rootVerdict.completionCanContinue, true)
  root.complete()
  const measured = scheduler.checkAdmissionTime()
  assert.equal(measured.withinCeiling, false)
  assert.equal(measured.completionCanContinue, true)
  assert.ok(measured.breaches.includes('route:noncachedInput'))
  assert.ok(measured.breaches.includes('route:output'))

  scheduler.freezeRoute('DIRECT', resolveSchedulerSettings({ route: 'DIRECT' }))
  const required = await admit(scheduler, {
    workItemId: 'direct-required-after-late-valid-route', purpose: 'work', lane: 'main',
  })
  finish(required)
  assert.equal(scheduler.getMetrics().counters.completed, 2)
  assert.equal(scheduler.getMetrics().rootAccounting.status, 'completed')
})

test('invalid terminal root usage releases accounting without fabricating categories or enabling freeze', async () => {
  const scheduler = new CentralScheduler({ route: 'PENDING', runIdentity: TEST_RUN })
  const analyst = await scheduler.acquireWithAuthority(authority(scheduler), {
    workItemId: 'route-analyst', role: 'ap-route-analyst', lane: 'routeAnalyst', purpose: 'planning',
  })
  finish(analyst)
  const decision = scheduler.beginRootAccounting({ phase: 'routeDecision', sessionId: 'root-invalid-usage' })
  assert.throws(() => decision.complete({ noncachedInput: 1 }),
    (error) => error.code === 'INCOMPLETE_USAGE_ACCOUNTING')
  const metrics = scheduler.getMetrics()
  assert.equal(metrics.rootAccounting.status, 'failed')
  assert.equal(metrics.counters.currentLiveChildren, 0)
  assert.equal(metrics.usage.planning.noncachedInput, 1)
  assert.equal(metrics.usage.planning.cachedInput, 0)
  assert.throws(() => scheduler.freezeRoute('DIRECT', resolveSchedulerSettings({ route: 'DIRECT' })),
    (error) => error.code === 'ROUTE_DECISION_INCOMPLETE')
})

test('implied or nonessential scope requires marginal-value admission without relying on optional flag', async () => {
  const scheduler = createTestScheduler()
  await assert.rejects(admit(scheduler, {
    workItemId: 'implied-without-value', missionEssential: false, optional: false,
  }), (error) => error.code === 'MARGINAL_VALUE_REQUIRED')
  const admitted = await admit(scheduler, {
    workItemId: 'implied-with-value', impliedScope: true, optional: false, valueCase: optionalValue(),
  })
  finish(admitted)
  assert.equal(scheduler.getMetrics().counters.optionalAdmitted, 1)
})

test('route context caps reject oversized slices and total fetched evidence', t => {
  const directory = tempDirectory(t, 'autoprompt-route-context-cap-')
  const pointer = writeRequestEnvelope(directory, 'exact')
  assert.throws(() => buildContextFreeBrief({
    role: 'ap-worker', assignment: 'bounded', route: 'DIRECT', requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
    roadmapSlice: 'x'.repeat(CONTEXT_ROUTE_CAPS.DIRECT.roadmapSliceBytes + 1),
  }), (error) => error.code === 'CONTEXT_COMPONENT_TOO_LARGE')
  assert.throws(() => buildContextFreeBrief({
    role: 'ap-worker', assignment: 'bounded', route: 'DIRECT', requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
    fetchedEvidence: 'x'.repeat(CONTEXT_ROUTE_CAPS.DIRECT.totalEnvelopeBytes),
  }), (error) => ['CONTEXT_COMPONENT_TOO_LARGE', 'CONTEXT_ENVELOPE_TOO_LARGE'].includes(error.code))
})

test('L4 excludes only its exact hash-bound request from the auxiliary envelope ceiling', t => {
  const directory = tempDirectory(t, 'autoprompt-checker-exact-request-cap-')
  const exactRequest = 'x'.repeat(CONTEXT_ROUTE_CAPS.DIRECT.totalEnvelopeBytes)
  const pointer = writeRequestEnvelope(directory, exactRequest)
  const checker = buildCheckerContext({
    role: 'ap-independent-checker', assignment: 'Check the exact candidate.', route: 'DIRECT',
    requestPointer: pointer, expectedRequestHash: pointer.hash, candidateHash: 'candidate-sha256',
    providerCapabilities: PROVIDER_CAPABILITIES,
  })
  assert.deepEqual(auditDispatch(checker).violations, [])

  assert.deepEqual(auditDispatch({ ...checker, exactRequest: `${exactRequest}!` }).violations,
    ['checker exact request does not match its immutable request pointer'])
  assert.deepEqual(auditDispatch({ ...checker, requestPointer: { ...pointer, bytes: undefined } }).violations,
    ['checker exact request does not match its immutable request pointer'])
  assert.ok(auditDispatch({ ...checker, role: 'ap-worker' }).violations.includes(
    'non-L4 dispatch cannot carry the exact request'))
  assert.ok(auditDispatch({
    ...checker,
    fetchedEvidence: 'y'.repeat(CONTEXT_ROUTE_CAPS.DIRECT.fetchedEvidenceBytes + 1),
  }).violations.some(
    violation => violation.includes('fetchedEvidence exceeds')))

  const missing = { ...checker }
  delete missing.exactRequest
  assert.deepEqual(auditDispatch(missing).violations,
    ['L4 checker dispatch is missing its exact immutable request'])
})

test('hash-bound harness attestations and signed proof cache survive validated resume', () => {
  const digest = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex')
  const scheduler = createTestScheduler()
  const attestation = scheduler.recordHarnessAttestation({
    repoHash: digest('repo'), buildHash: digest('build'), oracleHash: digest('oracle'),
    rawOutputHash: digest('resolve-output'), persistedResultHash: digest('resolve-output'),
  })
  const proof = scheduler.recordProofCache({
    candidateHash: digest('candidate'), oracleHash: digest('oracle'), environmentHash: digest('environment'),
    rawOutputHash: digest('proof-output'), persistedResultHash: digest('proof-output'), verdict: 'PASS',
  })
  const state = scheduler.exportState()
  const resumed = createTestScheduler({ state })
  assert.equal(resumed.getHarnessAttestation(attestation.key).signature, attestation.signature)
  assert.equal(resumed.getHarnessAttestation(attestation).key, attestation.key)
  assert.equal(resumed.getProofCache(proof.key).signature, proof.signature)
  assert.equal(resumed.getProofCache(proof).key, proof.key)

  const tampered = JSON.parse(JSON.stringify(state))
  tampered.caches.proofs[0].signature = '0'.repeat(64)
  assert.throws(() => createTestScheduler({ state: tampered }), (error) => error.code === 'INVALID_SCHEDULER_STATE')
})

test('marginal admission normalizes snake/camel fields and optional role or purpose signals', async () => {
  const scheduler = createTestScheduler()
  for (const request of [
    { workItemId: 'snake-optional', optional_work: true },
    { workItemId: 'snake-implied', implied_scope: true },
    { workItemId: 'snake-essential', mission_essential: false },
    { workItemId: 'role-scout', logical_role: 'ap-scout' },
    { workItemId: 'role-manager', logical_role: 'ap-manager' },
    { workItemId: 'role-recovery-specialist', logical_role: 'ap-re-anchor' },
    { workItemId: 'purpose-sweep', purpose: 'sweep' },
  ]) {
    await assert.rejects(admit(scheduler, request), (error) => error.code === 'MARGINAL_VALUE_REQUIRED')
  }
  await assert.rejects(admit(scheduler, {
    workItemId: 'contradictory-required-scout', logicalRole: 'ap-scout', mission_essential: true,
  }), error => error.code === 'OPTIONAL_ESSENTIAL_CONFLICT')
  const essential = await admit(scheduler, {
    workItemId: 'required-worker', logicalRole: 'worker', mission_essential: true,
  })
  finish(essential)
})

test('optional signals cannot be elevated into required completion identities', async () => {
  const settings = resolveSchedulerSettings({ route: 'DIRECT', requiredChildLaunches: 3 })
  const scheduler = createTestScheduler({ settings })
  await assert.rejects(admit(scheduler, {
    workItemId: 'contradictory-admission',
    optionalWork: true, optional_work: false, missionEssential: true,
    valueCase: optionalValue(),
  }), error => error.code === 'OPTIONAL_ESSENTIAL_CONFLICT')
  const conflicts = [
    { optionalWork: true, missionEssential: true },
    { optionalWork: true, optional_work: false, missionEssential: true },
    { optionalWork: false, optional_work: true, missionEssential: true },
    { implied_scope: true, required_by_mission: true },
    { logicalRole: 'ap-scout', userRequested: true },
    { logicalRole: 'ap-scout', logical_role: 'worker', userRequested: true },
    { scopeKind: 'optional', scope_kind: 'required', missionEssential: true },
    { missionEssential: false, isMissionEssential: true },
  ]
  for (const [index, conflict] of conflicts.entries()) {
    assert.throws(() => issueRequiredCompletionBinding(scheduler, {
      workItemId: `conflicting-required-${index}`,
      equivalenceKey: `conflicting-required-${index}`,
      role: 'ap-worker',
      purpose: 'work',
      lane: 'main',
      ...conflict,
    }), error => error.code === 'OPTIONAL_ESSENTIAL_CONFLICT')
  }
  assert.equal(scheduler.getMetrics().counters.totalLaunches, 0)
})

test('changed retry fingerprints continue beyond fixed retry settings while identical work reassesses', async () => {
  const scheduler = createTestScheduler({ maxRetriesPerWorkItem: 0 })
  const first = await admit(scheduler, {
    workItemId: 'progress-1', equivalenceKey: 'progress-loop', candidateHash: 'a'.repeat(64),
  })
  first.fail(new Error('red'), ZERO_USAGE)
  await assert.rejects(admit(scheduler, { workItemId: 'progress-missing', equivalenceKey: 'progress-loop' }),
    (error) => error.code === 'RETRY_PROGRESS_EVIDENCE_REQUIRED')
  const second = await admit(scheduler, {
    workItemId: 'progress-2', equivalenceKey: 'progress-loop', candidateHash: 'b'.repeat(64),
  })
  second.fail(new Error('still red'), ZERO_USAGE)
  await assert.rejects(admit(scheduler, {
    workItemId: 'progress-identical', equivalenceKey: 'progress-loop', candidateHash: 'b'.repeat(64),
  }),
    (error) => error.code === 'RETRY_REASSESSMENT_REQUIRED')
  const third = await admit(scheduler, {
    workItemId: 'progress-3', equivalenceKey: 'progress-loop',
    candidateHash: 'b'.repeat(64), strategy_fingerprint: 'c'.repeat(64),
  })
  finish(third)
  assert.equal(scheduler.getMetrics().counters.retriesStarted, 2)
  assert.equal(scheduler.getMetrics().counters.retryReassessments, 1)
})

test('retry progress accepts only canonical digests and deduplicates evidence before comparison', async () => {
  const scheduler = createTestScheduler()
  const candidate = 'a'.repeat(64)
  const evidenceA = 'b'.repeat(64)
  const evidenceB = 'c'.repeat(64)
  const first = await admit(scheduler, {
    workItemId: 'digest-1', equivalenceKey: 'digest-loop', candidateHash: candidate,
  })
  first.fail(new Error('retry'), ZERO_USAGE)
  await assert.rejects(admit(scheduler, {
    workItemId: 'digest-invalid', equivalenceKey: 'digest-loop',
    candidateHash: candidate, evidenceHashes: ['arbitrary-variable'],
  }), error => error.code === 'RETRY_PROGRESS_EVIDENCE_INVALID')
  await assert.rejects(admit(scheduler, {
    workItemId: 'strategy-invalid', equivalenceKey: 'digest-loop',
    candidateHash: candidate, strategyFingerprint: 'changed-label',
  }), error => error.code === 'RETRY_PROGRESS_EVIDENCE_INVALID')
  const retry = await admit(scheduler, {
    workItemId: 'digest-2', equivalenceKey: 'digest-loop', candidateHash: candidate,
    evidenceHashes: [evidenceB, evidenceA, evidenceA],
  })
  retry.fail(new Error('same evidence'), ZERO_USAGE)
  await assert.rejects(admit(scheduler, {
    workItemId: 'digest-3', equivalenceKey: 'digest-loop', candidateHash: candidate,
    evidenceHashes: [evidenceA, evidenceB],
  }), error => error.code === 'RETRY_REASSESSMENT_REQUIRED')
})

test('retry preflight is side-effect free and rejects missing progress before resource materialization', async () => {
  const scheduler = createTestScheduler()
  const first = await admit(scheduler, {
    workItemId: 'preflight-1', equivalenceKey: 'preflight-loop', candidateHash: 'a'.repeat(64),
  })
  finish(first)
  const before = scheduler.getMetrics().counters
  assert.throws(() => scheduler.assertRetryProgress({
    workItemId: 'preflight-2', equivalenceKey: 'preflight-loop',
  }), error => error.code === 'RETRY_PROGRESS_EVIDENCE_REQUIRED')
  assert.deepEqual(scheduler.getMetrics().counters, before)
  assert.equal(scheduler.assertRetryProgress({
    workItemId: 'preflight-2', equivalenceKey: 'preflight-loop',
    evidenceHashes: ['b'.repeat(64)],
  }).priorAttempts, 1)
})

test('scheduler-bound completion identities require independent retry progress and cross launch targets', async () => {
  const settings = resolveSchedulerSettings({ route: 'DIRECT', requiredChildLaunches: 3 })
  const scheduler = createTestScheduler({ settings })
  const requiredRequest = (workItemId, progress = {}) => ({
    workItemId,
    equivalenceKey: 'required-executor',
    role: 'ap-worker',
    logicalRole: 'worker',
    purpose: 'work',
    lane: 'main',
    ...progress,
  })
  const launchRequired = async (workItemId, progress = {}) => {
    const request = requiredRequest(workItemId, progress)
    const requiredCompletionBinding = issueRequiredCompletionBinding(scheduler, request)
    assert.equal(scheduler.assertRetryProgress({
      ...request, requiredCompletionBinding,
    }).admitted, true)
    const lease = await scheduler.acquireWithAuthority(authority(scheduler, null, {
      requiredCompletionBinding,
    }), { ...request, requiredCompletionBinding })
    finish(lease)
  }

  await launchRequired('required-generation-1')
  const renamedWithoutProgress = requiredRequest('required-generation-renamed')
  const renamedBinding = issueRequiredCompletionBinding(scheduler, renamedWithoutProgress)
  assert.throws(() => scheduler.assertRetryProgress({
    ...renamedWithoutProgress, requiredCompletionBinding: renamedBinding,
  }), error => error.code === 'RETRY_PROGRESS_EVIDENCE_REQUIRED')
  await launchRequired('required-generation-2', { candidateHash: 'a'.repeat(64) })
  const duplicate = requiredRequest('required-generation-2', { candidateHash: 'a'.repeat(64) })
  const duplicateBinding = issueRequiredCompletionBinding(scheduler, duplicate)
  assert.throws(() => scheduler.assertRetryProgress({
    ...duplicate, requiredCompletionBinding: duplicateBinding,
  }), error => error.code === 'RETRY_REASSESSMENT_REQUIRED')
  await launchRequired('required-generation-3', { candidateHash: 'b'.repeat(64) })

  const extra = requiredRequest('required-generation-4', { candidateHash: 'c'.repeat(64) })
  const extraBinding = issueRequiredCompletionBinding(scheduler, extra)
  finish(await scheduler.acquireWithAuthority(authority(scheduler, null, {
    requiredCompletionBinding: extraBinding,
  }), { ...extra, requiredCompletionBinding: extraBinding }))
  assert.equal(scheduler.getMetrics().counters.requiredCompletionLaunchOverruns, 1)
  await assert.rejects(admit(scheduler, {
    ...requiredRequest('unbound-extra', { candidateHash: 'd'.repeat(64) }),
  }), error => error.code === 'LAUNCH_LIMIT')
  assert.throws(() => issueRequiredCompletionBinding(scheduler, {
    ...requiredRequest('optional-extra'), optionalWork: true,
  }), error => error.code === 'INVALID_LAUNCH_AUTHORITY')
  await assert.rejects(scheduler.acquireWithAuthority(authority(scheduler), {
    ...requiredRequest('forged-extra'),
    requiredCompletionBinding: { ...extraBinding },
  }), error => error.code === 'INVALID_LAUNCH_AUTHORITY')
})

test('required completion issuer capability is exact, private to the controller, and scheduler-local', () => {
  const settings = resolveSchedulerSettings({ route: 'DIRECT', requiredChildLaunches: 1 })
  const scheduler = createTestScheduler({ settings })
  const request = {
    workItemId: 'issuer-bound', equivalenceKey: 'issuer-bound',
    role: 'ap-worker', purpose: 'work', lane: 'main',
  }
  assert.throws(() => scheduler.issueRequiredCompletionBinding(request),
    error => error.code === 'INVALID_LAUNCH_AUTHORITY')
  assert.throws(() => scheduler.issueRequiredCompletionBinding(request, {}),
    error => error.code === 'INVALID_LAUNCH_AUTHORITY')
  const foreign = createTestScheduler({ settings })
  assert.throws(() => issueRequiredCompletionBinding(
    scheduler, request, requiredCompletionIssuers.get(foreign),
  ), error => error.code === 'INVALID_LAUNCH_AUTHORITY')
  const foreignBinding = issueRequiredCompletionBinding(foreign, request)
  assert.throws(() => authority(scheduler, null, {
    requiredCompletionBinding: foreignBinding,
  }), error => error.code === 'INVALID_LAUNCH_AUTHORITY')
  assert.equal(issueRequiredCompletionBinding(scheduler, request).workItemId, request.workItemId)
})

test('cache provenance migrates generations but rejects cross-run, changed inputs, and result-hash mismatch', () => {
  const digest = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex')
  const scheduler = createTestScheduler()
  const rawOutputHash = digest('raw')
  const attestation = scheduler.recordHarnessAttestation({
    repoHash: digest('repo'), buildHash: digest('build'), oracleHash: digest('oracle'),
    rawOutputHash, persistedResultHash: rawOutputHash,
  })
  assert.throws(() => scheduler.recordProofCache({
    candidateHash: digest('candidate'), oracleHash: digest('oracle'), environmentHash: digest('environment'),
    rawOutputHash, persistedResultHash: digest('different'), verdict: 'PASS',
  }), (error) => error.code === 'ATTESTATION_RESULT_HASH_MISMATCH')

  const state = scheduler.exportState()
  const nextIdentity = { runId: TEST_RUN.runId, generation: TEST_RUN.generation + 1 }
  const migrated = new CentralScheduler({ state: { ...state, runIdentity: nextIdentity }, runIdentity: nextIdentity })
  const restored = migrated.getHarnessAttestation(attestation)
  assert.equal(restored.provenance.createdGeneration, TEST_RUN.generation)
  assert.equal(restored.provenance.validatedGeneration, nextIdentity.generation)
  assert.equal(restored.provenance.migrations.length, 1)

  const crossRunIdentity = { runId: 'different-stable-run', generation: nextIdentity.generation }
  assert.throws(() => new CentralScheduler({
    state: { ...state, runIdentity: crossRunIdentity }, runIdentity: crossRunIdentity,
  }), (error) => error.code === 'INVALID_SCHEDULER_STATE')
  const changed = JSON.parse(JSON.stringify(state))
  changed.caches.harnessAttestations[0].repoHash = digest('changed-repo')
  assert.throws(() => createTestScheduler({ state: changed }), (error) => error.code === 'INVALID_SCHEDULER_STATE')
})

test('run-global resource registry collides separately launched hierarchical check resources', async t => {
  const directory = tempDirectory(t, 'autoprompt-global-resource-')
  const workspace = path.join(directory, 'workspace')
  const nested = path.join(workspace, 'nested')
  fs.mkdirSync(nested, { recursive: true })
  const scheduler = createTestScheduler()
  const first = await admit(scheduler, {
    workItemId: 'checker-parent', purpose: 'verification',
    resources: [
      { id: `workspace:${workspace}`, mode: 'exclusive' },
      { id: `cache:${path.join(workspace, '.cache')}`, mode: 'exclusive' },
      { id: 'database:test-db', mode: 'exclusive' },
      { id: 'service:test-api', mode: 'exclusive' },
      { id: 'port:41234', mode: 'exclusive' },
    ],
  })
  let started = false
  const secondPromise = admit(scheduler, {
    workItemId: 'checker-nested', purpose: 'verification',
    resources: [{ id: `workspace:${nested}`, mode: 'exclusive' }],
  }).then(lease => { started = true; return lease })
  await Promise.resolve()
  assert.equal(started, false)
  finish(first)
  const second = await secondPromise
  assert.equal(started, true)
  finish(second)
})

test('isolation labels cannot hide identical paths, databases, services, or ports', async t => {
  const directory = tempDirectory(t, 'autoprompt-global-identities-')
  const resourceCases = [
    [{ id: `workspace:${directory}`, isolationId: 'checker-a' }, { id: `cache:${path.join(directory, 'cache')}`, isolationId: 'checker-b' }],
    [{ id: 'database:test-db', isolationId: 'checker-a' }, { id: 'database:test-db', isolationId: 'checker-b' }],
    [{ id: 'service:test-api', isolationId: 'checker-a' }, { id: 'service:test-api', isolationId: 'checker-b' }],
    [{ id: 'port:41234', isolationId: 'checker-a' }, { id: 'port:41234', isolationId: 'checker-b' }],
  ]
  for (let index = 0; index < resourceCases.length; index++) {
    const scheduler = createTestScheduler()
    const first = await admit(scheduler, {
      workItemId: `identity-${index}-a`, purpose: 'verification', resources: [resourceCases[index][0]],
    })
    let started = false
    const waiting = admit(scheduler, {
      workItemId: `identity-${index}-b`, purpose: 'verification', resources: [resourceCases[index][1]],
    }).then(lease => { started = true; return lease })
    await Promise.resolve()
    assert.equal(started, false)
    finish(first)
    finish(await waiting)
  }
})

test('materialized checker resources claim snapshot paths and keep external identities exclusive', async t => {
  const directory = tempDirectory(t, 'autoprompt-materialized-resources-')
  const workspace = path.join(directory, 'workspace')
  const cache = path.join(workspace, '.cache')
  fs.mkdirSync(cache, { recursive: true })
  const plan = planCheckerSandboxes([{
    id: 'isolated-checker',
    writeProducing: true,
    writeResources: [
      { kind: 'workspace', id: workspace },
      { kind: 'cache', id: cache },
      { kind: 'database', id: 'shared-db' },
      { kind: 'service', id: 'shared-service' },
      { kind: 'port', id: '43123' },
    ],
  }], { isolatedChecking: true, providerCapabilities: PROVIDER_CAPABILITIES })
  const snapshot = path.join(directory, 'snapshot')
  fs.mkdirSync(snapshot, { recursive: true })
  const [assignment] = materializeCheckerSandboxes(plan, () => snapshot)
  assert.equal(assignment.schedulerResources.some(resource => resource.id === `workspace:${snapshot}`), true)
  assert.equal(assignment.schedulerResources.some(resource => resource.id === `cache:${path.join(snapshot, '.cache')}`), true)
  assert.equal(assignment.schedulerResources.some(resource => resource.id === 'database:shared-db'), true)
  assert.equal(assignment.schedulerResources.some(resource => resource.id === 'service:shared-service'), true)
  assert.equal(assignment.schedulerResources.some(resource => resource.id === 'port:43123'), true)
  assert.equal(assignment.schedulerResources.some(resource => resource.isolationId), false)
})

test('canonical context forwards snake/camel route slices and recovery forks are bounded and typed', t => {
  const directory = tempDirectory(t, 'autoprompt-forward-context-')
  const pointer = writeRequestEnvelope(directory, 'exact')
  const dispatch = buildContextFreeBrief({
    role: 'ap-worker', assignment: 'bounded', route: 'LIGHT', requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
    roadmap_slice: 'slice', manifest_pointers: [{ path: 'manifest' }], fetched_evidence: 'evidence',
  })
  assert.equal(dispatch.route, 'LIGHT')
  assert.equal(dispatch.roadmapSlice, 'slice')
  assert.deepEqual(dispatch.manifests, [{ path: 'manifest' }])
  assert.equal(dispatch.fetchedEvidence, 'evidence')
  assert.equal(auditDispatch(dispatch).conformant, true)

  assert.throws(() => buildContextFreeBrief({
    role: 'ap-re-anchor', assignment: 'recover', requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
  }), (error) => error.code === 'RECOVERY_FORK_BOUNDS_REQUIRED')
  for (const value of [undefined, 'all', 0, 4]) {
    const candidate = { role: 'ap-re-anchor', recoveryContext: { type: 'bounded-recovery', code: 'COMPACTION' } }
    if (value !== undefined) candidate.fork_turns = value
    assert.equal(auditDispatch(candidate).conformant, false)
  }
  for (const value of [1, 2, 3]) {
    const recovery = buildContextFreeBrief({
      role: 'ap-re-anchor', assignment: 'recover', requestPointer: pointer,
      providerCapabilities: PROVIDER_CAPABILITIES, fork_turns: value,
      recovery_context: { type: 'bounded-recovery', code: 'COMPACTION' },
    })
    assert.equal(recovery.fork_turns, String(value))
    assert.equal(auditDispatch(recovery).conformant, true)
  }
  const workerRecovery = buildContextFreeBrief({
    role: 'ap-worker', purpose: 'recovery', assignment: 'recover bounded state', route: 'DIRECT',
    requestPointer: pointer, providerCapabilities: PROVIDER_CAPABILITIES,
    fork_turns: 2, recovery_context: { type: 'bounded-recovery', code: 'STATE_RECOVERY' },
  })
  assert.equal(workerRecovery.fork_turns, '2')
  assert.equal(workerRecovery.purpose, 'recovery')
  assert.equal(auditDispatch(workerRecovery).conformant, true)
  assert.throws(() => buildContextFreeBrief({
    role: 'ap-worker', purpose: 'recovery', assignment: 'unsafe recovery', route: 'DIRECT',
    requestPointer: pointer, providerCapabilities: PROVIDER_CAPABILITIES,
  }), (error) => error.code === 'RECOVERY_FORK_BOUNDS_REQUIRED')
})

test('tokensaver is canonically concurrency-width-only while route owns economics', () => {
  const settings = resolveSchedulerSettings({ route: 'ROADMAP', concurrency_mode: 'tokensaver', userLiveCeiling: 10 })
  assert.equal(settings.policyClass, 'concurrency-width-only')
  assert.equal(settings.economicPolicySource, 'route')
  assert.equal(settings.concurrencyPreset, 'tokensaver')
  assert.ok(settings.budget.maxLiveIncludingRoot <= 7, 'six children plus the root is the absolute width')
  assert.deepEqual(settings.budget.tokens, ROUTE_BUDGETS.ROADMAP.tokens)
})

test('crash adoption restores one persisted live lease without double-counting or resource duplication', async () => {
  const scheduler = createTestScheduler()
  const lease = await admit(scheduler, {
    workItemId: 'crash-live-worker',
    equivalenceKey: 'crash-live-worker',
    purpose: 'work',
    resources: [{ id: 'workspace:/crash-owned', mode: 'exclusive' }],
    estimate: { noncachedInput: 100, cachedInput: 100, output: 100, reasoning: 100 },
    candidateHash: 'a'.repeat(64),
  })
  scheduler.bindCrashContinuation(lease, {
    reservationId: 'reservation-crash-live',
    sessionId: 'control-session-crash-live',
    continuationId: '11111111-1111-4111-8111-111111111111',
    frontier: {
      resumeState: 'CHECK_WORK',
      nextReadyWorkIds: ['reconcile-crash-live-worker'],
      openCheckIds: ['check-crash-live-worker'],
      acceptedResultIds: [],
    },
  })
  lease.authorizeUsage({ noncachedInput: 3, cachedInput: 0, output: 0, reasoning: 0 })
  lease.reportUsage({ noncachedInput: 3, cachedInput: 0, output: 0, reasoning: 0 })
  const checkpoint = scheduler.exportCrashCheckpoint({ ownerSessionId: 'old-control-owner' })
  const recoveryContext = {
    priorOwner: { ownerId: 'old-control-owner', processesDrained: true },
    frontier: { acceptedResultIds: [checkpoint.stateHash] },
  }

  const adoptedScheduler = new CentralScheduler({
    settings: checkpoint.schedulerState.settings,
    runIdentity: { runId: TEST_RUN.runId, generation: 2 },
  })
  const adopted = adoptedScheduler.adoptCrashCheckpoint(checkpoint, {
    recoveryContext,
    ownerSessionId: 'old-control-owner',
  })
  const adoptedLease = adopted.leases[lease.id]
  assert.ok(adoptedLease)
  assert.equal(adopted.counters.totalLaunches, 1)
  assert.equal(adopted.counters.admitted, 1)
  assert.deepEqual(adoptedScheduler.getMetrics().attempts, { 'crash-live-worker': 1 })
  assert.equal(adoptedScheduler.getMetrics().liveResources.length, 1)
  adoptedLease.reportUsage({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
  adoptedLease.complete({ noncachedInput: 3, cachedInput: 0, output: 0, reasoning: 0 })
  assert.equal(adoptedScheduler.getMetrics().counters.totalLaunches, 1)
  assert.equal(adoptedScheduler.getMetrics().counters.completed, 1)

  const retry = await adoptedScheduler.acquireWithAuthority(authority(adoptedScheduler, null, {
    generation: 2,
  }), {
    workItemId: 'crash-live-worker-retry', role: 'ap-worker', equivalenceKey: 'crash-live-worker',
    candidateHash: 'b'.repeat(64), resources: [{ id: 'workspace:/crash-owned', mode: 'exclusive' }],
  })
  finish(retry)
  assert.equal(adoptedScheduler.getMetrics().counters.totalLaunches, 2)
  assert.deepEqual(adoptedScheduler.getMetrics().attempts, { 'crash-live-worker': 2 })

  const tampered = JSON.parse(JSON.stringify(checkpoint))
  tampered.liveRecords[0].crashBinding.reservationId = 'forged-reservation'
  assert.throws(() => new CentralScheduler({
    settings: checkpoint.schedulerState.settings,
    runIdentity: { runId: TEST_RUN.runId, generation: 2 },
  }).adoptCrashCheckpoint(tampered, { recoveryContext }), error => error.code === 'CRASH_CHECKPOINT_INVALID')
  assert.throws(() => new CentralScheduler({
    settings: checkpoint.schedulerState.settings,
    runIdentity: { runId: 'foreign-run', generation: 2 },
  }).adoptCrashCheckpoint(checkpoint, { recoveryContext }), error => error.code === 'RUN_GENERATION_MISMATCH')
  assert.throws(() => new CentralScheduler({
    settings: checkpoint.schedulerState.settings,
    runIdentity: { runId: TEST_RUN.runId, generation: 3 },
  }).adoptCrashCheckpoint(checkpoint, { recoveryContext }), error => error.code === 'RUN_GENERATION_MISMATCH')
  assert.throws(() => new CentralScheduler({
    settings: checkpoint.schedulerState.settings,
    runIdentity: { runId: TEST_RUN.runId, generation: 2 },
  }).adoptCrashCheckpoint(checkpoint, {
    recoveryContext: { ...recoveryContext, priorOwner: { ownerId: 'old-control-owner', processesDrained: false } },
  }), error => error.code === 'CRASH_OWNER_UNVERIFIED')
})

test('checker crash adoption preserves its admitted inspected candidate and rejects missing or substituted bindings', async () => {
  const candidateHash = 'a'.repeat(64)
  const scheduler = createTestScheduler()
  const lease = await scheduler.acquireWithAuthority(authority(scheduler), {
    workItemId: 'crash-live-checker', role: 'ap-independent-checker',
    logicalRole: 'independent-reviewer', purpose: 'verification', candidateHash,
    resources: [{ id: 'workspace:/frozen-checker', mode: 'exclusive' }],
  })
  scheduler.bindCrashContinuation(lease, {
    reservationId: 'reservation-crash-checker', sessionId: 'control-session-crash-checker',
    continuationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    frontier: {
      resumeState: 'CHECK_WORK', nextReadyWorkIds: ['crash-live-checker'],
      openCheckIds: ['crash-live-checker'], acceptedResultIds: [],
    },
  })
  const checkpoint = scheduler.exportCrashCheckpoint({ ownerSessionId: 'checker-owner' })
  assert.equal(checkpoint.liveRecords[0].inspectedCandidateHash, candidateHash)
  const recoveryContextFor = value => ({
    priorOwner: { ownerId: 'checker-owner', processesDrained: true },
    frontier: { acceptedResultIds: [value.stateHash] },
  })
  const adoptedScheduler = new CentralScheduler({
    settings: checkpoint.schedulerState.settings,
    runIdentity: { runId: TEST_RUN.runId, generation: 2 },
  })
  adoptedScheduler.adoptCrashCheckpoint(checkpoint, { recoveryContext: recoveryContextFor(checkpoint) })
  assert.equal(adoptedScheduler.exportCrashCheckpoint({ ownerSessionId: 'replacement-checker-owner' })
    .liveRecords[0].inspectedCandidateHash, candidateHash)

  for (const replacement of [null, 'b'.repeat(64)]) {
    const forged = JSON.parse(JSON.stringify(checkpoint))
    forged.liveRecords[0].inspectedCandidateHash = replacement
    const unsigned = { ...forged }
    delete unsigned.stateHash
    forged.stateHash = crypto.createHash('sha256').update(stableStringify(unsigned)).digest('hex')
    assert.throws(() => new CentralScheduler({
      settings: checkpoint.schedulerState.settings,
      runIdentity: { runId: TEST_RUN.runId, generation: 2 },
    }).adoptCrashCheckpoint(forged, { recoveryContext: recoveryContextFor(forged) }),
    error => replacement === null
      ? error.code === 'CRASH_CHECKPOINT_INVALID'
      : error.code === 'CRASH_CHECKPOINT_INVALID' || error.code === 'CRASH_ADOPTION_CONFLICT')
  }
})

test('crash adoption restores live parent hierarchy and rejects forged accounting classes', async () => {
  const scheduler = createTestScheduler()
  const parent = await admit(scheduler, {
    workItemId: 'crash-parent',
    resources: [{ id: 'workspace:/crash-parent', mode: 'exclusive' }],
  })
  const child = await admit(scheduler, {
    workItemId: 'crash-child',
    resources: [{ id: 'workspace:/crash-child', mode: 'exclusive' }],
  }, parent)
  for (const [lease, suffix] of [[parent, 'parent'], [child, 'child']]) {
    scheduler.bindCrashContinuation(lease, {
      reservationId: `reservation-${suffix}`,
      sessionId: `session-${suffix}`,
      continuationId: `22222222-2222-4222-8222-22222222222${suffix === 'parent' ? '2' : '3'}`,
      frontier: {
        resumeState: 'CHECK_WORK',
        nextReadyWorkIds: [`reconcile-${suffix}`],
        openCheckIds: [],
        acceptedResultIds: [],
      },
    })
  }
  const checkpoint = scheduler.exportCrashCheckpoint({ ownerSessionId: 'hierarchy-owner' })
  const recoveryContext = {
    priorOwner: { ownerId: 'hierarchy-owner', processesDrained: true },
    frontier: { acceptedResultIds: [checkpoint.stateHash] },
  }
  const resumed = new CentralScheduler({
    settings: checkpoint.schedulerState.settings,
    runIdentity: { runId: TEST_RUN.runId, generation: 2 },
  })
  const adopted = resumed.adoptCrashCheckpoint(checkpoint, { recoveryContext })
  assert.equal(adopted.leases[parent.id].depth, 1)
  assert.equal(adopted.leases[child.id].depth, 2)
  assert.equal(resumed.getMetrics().counters.totalLaunches, 2)
  assert.equal(resumed.getMetrics().counters.currentLiveChildren, 2)
  assert.equal(resumed.getMetrics().liveResources.length, 2)
  await assert.rejects(adopted.leases[child.id].acquireChild(authority(
    resumed,
    adopted.leases[child.id],
    { generation: 2 },
  ), { workItemId: 'forged-grandchild', role: 'ap-worker' }), error => error.code === 'DEPTH_LIMIT')
  finish(adopted.leases[child.id])
  finish(adopted.leases[parent.id])

  const forged = JSON.parse(JSON.stringify(checkpoint))
  forged.liveRecords[0].budgetClass = '__proto__'
  const unsigned = { ...forged }
  delete unsigned.stateHash
  forged.stateHash = crypto.createHash('sha256').update(stableStringify(unsigned)).digest('hex')
  assert.throws(() => new CentralScheduler({
    settings: checkpoint.schedulerState.settings,
    runIdentity: { runId: TEST_RUN.runId, generation: 2 },
  }).adoptCrashCheckpoint(forged, {
    recoveryContext: {
      ...recoveryContext,
      frontier: { acceptedResultIds: [forged.stateHash] },
    },
  }), error => error.code === 'CRASH_CHECKPOINT_INVALID')
})

test('crash adoption restores the root L0 session without creating a child launch', async () => {
  const pending = new CentralScheduler({ route: 'PENDING', runIdentity: TEST_RUN })
  const analyst = await pending.acquireWithAuthority(authority(pending), {
    workItemId: 'route-analyst', role: 'ap-route-analyst', logicalRole: 'route-analyst',
    purpose: 'planning', lane: 'routeAnalyst',
  })
  finish(analyst)
  const root = pending.beginRootAccounting({ phase: 'routeDecision', sessionId: 'stable-root-l0' })
  pending.bindRootCrashContinuation(root, {
    reservationId: 'root-reservation',
    sessionId: 'stable-root-l0',
    continuationId: '33333333-3333-4333-8333-333333333333',
    frontier: {
      resumeState: 'L0_ROUTE_DECISION',
      nextReadyWorkIds: [],
      openCheckIds: [],
      acceptedResultIds: [],
    },
  })
  root.authorizeUsage({ noncachedInput: 2, cachedInput: 0, output: 1, reasoning: 0 })
  root.reportUsage({ noncachedInput: 2, cachedInput: 0, output: 1, reasoning: 0 })
  const checkpoint = pending.exportCrashCheckpoint({ ownerSessionId: 'old-root-owner' })
  assert.equal(checkpoint.liveRecords.length, 0)
  assert.equal(checkpoint.rootAccountingRecord.sessionId, 'stable-root-l0')

  const resumed = new CentralScheduler({ route: 'PENDING', runIdentity: { runId: TEST_RUN.runId, generation: 2 } })
  const adopted = resumed.adoptCrashCheckpoint(checkpoint, {
    recoveryContext: {
      priorOwner: { ownerId: 'old-root-owner', processesDrained: true },
      frontier: { acceptedResultIds: [checkpoint.stateHash] },
    },
  })
  assert.ok(adopted.rootAccountingLease)
  assert.equal(resumed.getMetrics().counters.totalLaunches, 1, 'only the analyst is a child launch')
  assert.equal(resumed.getMetrics().rootAccounting.status, 'live')
  const rebound = resumed.rebindAdoptedContinuation(adopted.rootAccountingLease, {
    priorBindingHash: checkpoint.rootAccountingRecord.crashBinding.bindingHash,
    reservationId: 'replacement-root-reservation',
    sessionId: 'replacement-root-transport',
    continuationId: checkpoint.rootAccountingRecord.crashBinding.continuationId,
  })
  assert.equal(rebound.reservationId, 'replacement-root-reservation')
  assert.equal(resumed.exportCrashCheckpoint({ ownerSessionId: 'replacement-owner' })
    .rootAccountingRecord.crashBinding.bindingHash, rebound.bindingHash)
  assert.throws(() => resumed.rebindAdoptedContinuation(adopted.rootAccountingLease, {
    priorBindingHash: rebound.bindingHash,
    reservationId: 'second-replacement',
    sessionId: 'second-transport',
    continuationId: rebound.continuationId,
  }), error => error.code === 'CRASH_ADOPTION_CONFLICT')
  const receiptHash = crypto.createHash('sha256').update('adopted-invalid-root-result').digest('hex')
  const rotationAuthority = resumed.authorizeRootCrashContinuationRotationAfterResult(
    adopted.rootAccountingLease,
    { priorBindingHash: rebound.bindingHash, priorResultReceiptHash: receiptHash },
  )
  const rotated = resumed.rotateRootCrashContinuationAfterResult(adopted.rootAccountingLease, {
    priorResultReceiptHash: receiptHash,
    resultCommitAuthority: rotationAuthority,
    reservationId: 'correction-root-reservation',
    sessionId: 'correction-root-transport',
    continuationId: null,
    frontier: { ...rebound.frontier, acceptedResultIds: [receiptHash] },
  })
  assert.equal(rotated.reservationId, 'correction-root-reservation')
  assert.throws(() => resumed.rotateRootCrashContinuationAfterResult(adopted.rootAccountingLease, {
    priorResultReceiptHash: receiptHash,
    resultCommitAuthority: rotationAuthority,
    reservationId: 'another-root-reservation',
    sessionId: 'another-root-transport',
    continuationId: null,
    frontier: rotated.frontier,
  }), error => error.code === 'CRASH_BINDING_ROTATION_INVALID')
  adopted.rootAccountingLease.reportUsage({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
  adopted.rootAccountingLease.complete({})
  assert.equal(resumed.getMetrics().rootAccounting.status, 'completed')
  assert.equal(resumed.getMetrics().counters.totalLaunches, 1)
})

test('committed root correction rotation is one-shot, fresh, and exact-frontier bound', async () => {
  const scheduler = new CentralScheduler({ route: 'PENDING', runIdentity: TEST_RUN })
  const analyst = await scheduler.acquireWithAuthority(authority(scheduler), {
    workItemId: 'route-analyst-for-root-rotation', role: 'ap-route-analyst',
    logicalRole: 'route-analyst', purpose: 'planning', lane: 'routeAnalyst',
  })
  finish(analyst)
  const rootLease = scheduler.beginRootAccounting({ phase: 'routeDecision', sessionId: 'root-owner' })
  const first = scheduler.bindRootCrashContinuation(rootLease, {
    reservationId: 'root-reservation-1', sessionId: 'root-transport-1',
    continuationId: '11111111-1111-4111-8111-111111111111',
    frontier: {
      resumeState: 'L0_ROUTE_DECISION', nextReadyWorkIds: ['root-route-decision'],
      openCheckIds: [], acceptedResultIds: [],
    },
  })
  const receiptHash = crypto.createHash('sha256').update('first-invalid-root-result').digest('hex')
  assert.throws(() => scheduler.rotateRootCrashContinuationAfterResult(rootLease, {
    priorResultReceiptHash: receiptHash, reservationId: 'root-reservation-2',
    sessionId: 'root-transport-2', continuationId: null,
    frontier: { ...first.frontier, acceptedResultIds: [receiptHash] },
  }), error => error.code === 'CRASH_BINDING_ROTATION_INVALID')
  const commitAuthority = scheduler.authorizeRootCrashContinuationRotationAfterResult(rootLease, {
    priorBindingHash: first.bindingHash, priorResultReceiptHash: receiptHash,
  })
  const rotate = overrides => scheduler.rotateRootCrashContinuationAfterResult(rootLease, {
    priorResultReceiptHash: receiptHash, resultCommitAuthority: commitAuthority,
    reservationId: 'root-reservation-2', sessionId: 'root-transport-2', continuationId: null,
    frontier: { ...first.frontier, acceptedResultIds: [receiptHash] }, ...overrides,
  })
  assert.throws(() => rotate({ reservationId: first.reservationId }), error => error.code === 'CRASH_BINDING_ROTATION_INVALID')
  assert.throws(() => rotate({ sessionId: first.sessionId }), error => error.code === 'CRASH_BINDING_ROTATION_INVALID')
  assert.throws(() => rotate({ frontier: { ...first.frontier, acceptedResultIds: [receiptHash, 'extra'] } }),
    error => error.code === 'CRASH_BINDING_ROTATION_INVALID')
  const rotated = rotate({})
  assert.deepEqual(rotated.frontier.acceptedResultIds, [receiptHash])
  assert.throws(() => rotate({ reservationId: 'root-reservation-3', sessionId: 'root-transport-3' }),
    error => error.code === 'CRASH_BINDING_ROTATION_INVALID')
})
