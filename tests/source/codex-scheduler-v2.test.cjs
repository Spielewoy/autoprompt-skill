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

function createTestScheduler(options = {}) {
  return new CentralScheduler({ route: 'DIRECT', runIdentity: TEST_RUN, ...options })
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
      DIRECT: [6, 4, 2, 220000, 900000, 40000],
      LIGHT: [8, 4, 3, 500000, 2200000, 70000],
      ROADMAP: [18, 6, 4, 1200000, 5000000, 160000],
    },
  )
  assert.equal(resolveRouteBudget('ROADMAP', { workGroups: 1 }).maxChildLaunches, 8)
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

  const first = await admit(scheduler, { workItemId: 'attempt-1', equivalenceKey: 'same-fix', candidateHash: 'candidate-a' })
  first.fail(new Error('red'), ZERO_USAGE)
  const retry = await admit(scheduler, { workItemId: 'attempt-2', equivalenceKey: 'same-fix', attempt: 2, candidateHash: 'candidate-b' })
  finish(retry, { noncachedInput: 100, output: 10 })
  await assert.rejects(
    admit(scheduler, { workItemId: 'attempt-3', equivalenceKey: 'same-fix', candidateHash: 'candidate-b' }),
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

test('optional work needs positive marginal value and cannot consume verification reserve', async () => {
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
  await assert.rejects(
    admit(scheduler, {
      workItemId: 'planning-over-reserve',
      purpose: 'planning',
      estimate: { noncachedInput: 150000 },
    }),
    (error) => error.code === 'BUDGET_RESERVE',
  )
  await assert.rejects(
    admit(scheduler, {
      workItemId: 'work-over-both-reserves',
      purpose: 'work',
      estimate: { noncachedInput: 150000 },
    }),
    (error) => error.code === 'BUDGET_RESERVE',
  )
  const admittedOptional = await admit(scheduler, {
    workItemId: 'separate-positive-scout',
    optional: true,
    valueCase: optionalValue(),
  })
  finish(admittedOptional)
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
  scheduler.recordAdmissionComponent('routeAnalyst', 100000)
  scheduler.recordAdmissionComponent('routeDecision', 200000)
  const admission = scheduler.recordAdmissionComponent('lightPlanning', 200000)
  assert.equal(admission.withinCeiling, true)
  assert.equal(admission.includedMs, 540000)
  scheduler.recordAdmissionComponent('waitingUser', 999999)
  assert.equal(scheduler.checkAdmissionTime().includedMs, 540000)

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
  })
  assert.equal(metrics.economics.costPerAcceptedSolve, 1.25)
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
  assert.throws(() => buildContextFreeBrief({
    role: 'ap-implementer',
    assignment: 'x'.repeat(MAX_L3_BRIEF_BYTES),
    requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
  }), (error) => error.code === 'BRIEF_TOO_LARGE')
  assert.equal(auditDispatch({ role: 'ap-worker', fork_turns: 'all', fullHistory: [] }).conformant, false)
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

test('fake stream accounts reasoning as output and stops optional work at lane hard ceiling', async () => {
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
  assert.equal(lease.authorizeUsage({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 30 }).allowed, false)
  const stopped = lease.reportUsage({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 30 })
  assert.equal(stopped.continue, false)
  assert.equal(stopped.code, 'BUDGET_EXHAUSTED')
  assert.deepEqual(stopped.hardCeilings, ['lane:optional:output'])
  assert.throws(() => lease.complete(), (error) => error.code === 'BUDGET_EXHAUSTED')
  const metrics = scheduler.getMetrics()
  assert.equal(metrics.usageTotals.output, 40)
  assert.equal(metrics.usageTotals.reasoning, 70)
  assert.equal(metrics.usageTotals.outputIncludingReasoning, 110)
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
  assert.deepEqual(tamper.resume(), {
    status: 'COMPLETE', eventCount: 2, nextSequence: 3, headHash: second.hash,
  })
  assert.throws(() => tamper.readAll({ maxEvents: 1, maxBytes: 100000 }),
    (error) => error.code === 'TRANSCRIPT_READ_BOUND')
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

test('an admission component breach denies the next acquisition', async () => {
  const scheduler = createTestScheduler()
  const verdict = scheduler.recordAdmissionComponent('routeAnalyst', (2 * 60 * 1000) + 1)
  assert.equal(verdict.withinCeiling, false)
  await assert.rejects(admit(scheduler, { workItemId: 'late-start' }), (error) => {
    assert.equal(error.code, 'ADMISSION_COMPONENT_TIMEOUT')
    assert.deepEqual(error.details.breaches, ['routeAnalyst'])
    return true
  })
})

test('final cumulative hard-cap exhaustion releases as failed and never completes successfully', async () => {
  const settings = resolveSchedulerSettings({
    route: 'DIRECT',
    lanes: { main: { tokens: { noncachedInput: 1000, cachedInput: 1000, output: 100 } } },
  })
  const scheduler = createTestScheduler({ settings })
  const streamed = await admit(scheduler, { workItemId: 'stream-over-hard' })
  const stopped = streamed.reportUsage({ noncachedInput: 0, cachedInput: 0, output: 70, reasoning: 40 })
  assert.equal(stopped.code, 'BUDGET_EXHAUSTED')
  assert.throws(() => streamed.complete(), (error) => error.code === 'BUDGET_EXHAUSTED')
  assert.equal(scheduler.getMetrics().counters.currentLiveChildren, 0)

  const finalScheduler = createTestScheduler({ settings })
  const finalOnly = await admit(finalScheduler, { workItemId: 'final-over-hard' })
  assert.throws(() => finalOnly.complete({ noncachedInput: 0, cachedInput: 0, output: 80, reasoning: 30 }),
    (error) => error.code === 'BUDGET_EXHAUSTED')
  assert.equal(finalScheduler.getMetrics().counters.currentLiveChildren, 0)
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
  assert.ok(auditDispatch({ ...checker, fetchedEvidence: 'y'.repeat(5000) }).violations.some(
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
  const essential = await admit(scheduler, {
    workItemId: 'required-scout', logicalRole: 'ap-scout', mission_essential: true,
  })
  finish(essential)
})

test('changed retry fingerprints continue beyond fixed retry settings while identical work reassesses', async () => {
  const scheduler = createTestScheduler({ maxRetriesPerWorkItem: 0 })
  const first = await admit(scheduler, { workItemId: 'progress-1', equivalenceKey: 'progress-loop', candidateHash: 'a' })
  first.fail(new Error('red'), ZERO_USAGE)
  await assert.rejects(admit(scheduler, { workItemId: 'progress-missing', equivalenceKey: 'progress-loop' }),
    (error) => error.code === 'RETRY_PROGRESS_EVIDENCE_REQUIRED')
  const second = await admit(scheduler, { workItemId: 'progress-2', equivalenceKey: 'progress-loop', candidateHash: 'b' })
  second.fail(new Error('still red'), ZERO_USAGE)
  await assert.rejects(admit(scheduler, { workItemId: 'progress-identical', equivalenceKey: 'progress-loop', candidateHash: 'b' }),
    (error) => error.code === 'RETRY_REASSESSMENT_REQUIRED')
  const third = await admit(scheduler, {
    workItemId: 'progress-3', equivalenceKey: 'progress-loop', candidateHash: 'b', strategy_fingerprint: 'new-strategy',
  })
  finish(third)
  assert.equal(scheduler.getMetrics().counters.retriesStarted, 2)
  assert.equal(scheduler.getMetrics().counters.retryReassessments, 1)
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
