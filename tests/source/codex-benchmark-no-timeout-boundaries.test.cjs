#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { BudgetController } = require('../../agents/codex/workflow/budget-controller.js')
const { Finalizer } = require('../../agents/codex/workflow/finalizer.js')
const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')
const {
  CodexSupervisorRuntime,
  ROUTE_CAPABILITY_EFFECTS,
  RuntimeCapabilityAuthority,
  productionPhaseBudgets,
  runtimeCapabilityExpiryMs,
} = require('../../agents/codex/workflow/phase-budget.js')
const { activationCapabilityTtlSeconds } = require('../../scripts/codex-configure.cjs')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const BENCHMARK_ENVIRONMENT = Object.freeze({ AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1' })
const HASH = 'a'.repeat(64)
const RUNTIME_IDENTITY = Object.freeze({
  activationAttestation: Object.freeze({ hash: '1'.repeat(64) }),
  runtimeMetadataSha256: '2'.repeat(64),
  profileSha256: '3'.repeat(64),
  payloadManifestSha256: '4'.repeat(64),
  runId: 'benchmark-no-timeout-boundary-run',
  generation: 2,
  targetIdentity: 'target:benchmark-no-timeout',
})
const PROVIDER_CAPABILITIES = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})

function deadline() {
  return Object.freeze({
    absoluteDeadline: new Date(DAY_MS).toISOString(),
    source: 'product-maximum',
    verificationReservePercent: 25,
    recoveryAndFinalizationReservePercent: 10,
  })
}

function controllerAt(clock, options = {}) {
  const limits = options.limits || {
    wallMs: DAY_MS,
    tokens: 10,
    sessions: 3,
    launches: 3,
  }
  const controller = new BudgetController({
    limits,
    phases: productionPhaseBudgets(limits.wallMs),
    phaseBudgetFactory: productionPhaseBudgets,
    monotonicMs: () => clock.elapsedMs,
    monotonicClockId: 'benchmark-boundary-fake-clock',
    wallNowMs: () => clock.elapsedMs,
    wallClock: () => new Date(clock.elapsedMs).toISOString(),
    bootId: null,
    wallTimeUnbounded: options.wallTimeUnbounded !== false,
    snapshot: options.snapshot,
  })
  if (!options.snapshot) {
    controller.bindDeadline({
      deadline: deadline(),
      wallMs: DAY_MS,
      verificationReserveMs: DAY_MS / 4,
      finalizationReserveMs: DAY_MS / 10,
      admittedAtMs: 0,
    })
  }
  return controller
}

function assertBudgetError(action, code, dimension) {
  assert.throws(action, error => {
    assert.equal(error.code, code)
    if (dimension) assert.ok(error.details.exhausted.includes(dimension))
    return true
  })
}

test('benchmark no-timeout remains available at execution, work, 24h, 25h, and 48h boundaries', () => {
  const clock = { elapsedMs: 0 }
  const budget = controllerAt(clock)
  const boundaries = [
    Math.floor(DAY_MS * 0.65) - 1,
    Math.floor(DAY_MS * 0.65),
    Math.floor(DAY_MS * 0.65) + 1,
    Math.floor(DAY_MS * 0.90) - 1,
    Math.floor(DAY_MS * 0.90),
    Math.floor(DAY_MS * 0.90) + 1,
    DAY_MS - 1,
    DAY_MS,
    DAY_MS + 1,
    25 * HOUR_MS,
    48 * HOUR_MS,
  ]

  for (const elapsedMs of boundaries) {
    clock.elapsedMs = elapsedMs
    for (const view of [{ forExecution: true }, { forWork: true }, {}]) {
      const status = budget.assertAvailable(view)
      assert.equal(status.ok, true, `elapsed=${elapsedMs} view=${JSON.stringify(view)}`)
      assert.deepEqual(status.exhausted, [])
      assert.equal(status.remaining.wallMs, Number.MAX_SAFE_INTEGER)
      assert.equal(status.wallTimeUnbounded, true)
    }
    assert.equal(budget.assertExternalWriteAllowed({ operationId: `write-${elapsedMs}` }).allowed, true)
  }

  assert.equal(
    budget.accountingCeilings({ retries: 2, costMicrounits: 10 }).wallMilliseconds,
    Number.MAX_SAFE_INTEGER,
  )
})

test('benchmark runtime bypasses elapsed phase convergence and hard-stop decisions at 48h', () => {
  const clock = { elapsedMs: 0 }
  const budget = controllerAt(clock)
  budget.startPhase('EXECUTION_BUILD')
  clock.elapsedMs = 48 * HOUR_MS
  assert.equal(budget.supervisorDecision('EXECUTION_BUILD').action, 'STOP_PHASE')

  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.options = { baseEnvironment: BENCHMARK_ENVIRONMENT }
  runtime.budget = budget
  runtime.route = 'DIRECT'
  assert.deepEqual(runtime._enforceBudgetPhase('EXECUTION_BUILD'), {
    action: 'CONTINUE',
    reason: 'authenticated benchmark time policy is unbounded',
  })
})

test('normal wall limits still stop at the exact execution, work, deadline, and external-write boundaries', () => {
  const clock = { elapsedMs: 0 }
  const budget = controllerAt(clock, { wallTimeUnbounded: false })

  clock.elapsedMs = DAY_MS * 0.65
  assertBudgetError(
    () => budget.assertAvailable({ forExecution: true }),
    'FINAL_VERIFICATION_RESERVE_REQUIRED',
    'EXECUTION_WALL',
  )
  clock.elapsedMs = DAY_MS * 0.90
  assertBudgetError(() => budget.assertAvailable({ forWork: true }), 'BUDGET_EXHAUSTED', 'WORK_WALL')
  clock.elapsedMs = DAY_MS
  assertBudgetError(() => budget.assertAvailable(), 'BUDGET_EXHAUSTED', 'WALL')
  assert.throws(
    () => budget.assertExternalWriteAllowed({ operationId: 'normal-expired-write' }),
    error => error.code === 'EXTERNAL_WRITE_DEADLINE_EXPIRED',
  )
})

test('benchmark no-timeout preserves token, session, and launch ceilings', () => {
  const tokenClock = { elapsedMs: 48 * HOUR_MS }
  const tokenBudget = controllerAt(tokenClock, {
    limits: { wallMs: DAY_MS, tokens: 2, sessions: 3, launches: 3 },
  })
  tokenBudget.consumeTokens(2)
  assertBudgetError(() => tokenBudget.assertAvailable(), 'BUDGET_EXHAUSTED', 'TOKENS')

  const sessionClock = { elapsedMs: 48 * HOUR_MS }
  const sessionBudget = controllerAt(sessionClock, {
    limits: { wallMs: DAY_MS, tokens: 10, sessions: 2, launches: 3 },
  })
  sessionBudget.startSession('session-one')
  sessionBudget.startSession('session-two')
  assertBudgetError(() => sessionBudget.startSession('session-three'), 'BUDGET_EXHAUSTED', 'SESSIONS')

  const launchClock = { elapsedMs: 48 * HOUR_MS }
  const launchBudget = controllerAt(launchClock, {
    limits: { wallMs: DAY_MS, tokens: 10, sessions: 3, launches: 2 },
  })
  launchBudget.recordLaunch()
  launchBudget.recordLaunch()
  assertBudgetError(() => launchBudget.recordLaunch(), 'BUDGET_EXHAUSTED', 'LAUNCHES')
})

test('benchmark resume admits an expired persisted deadline and retains useful work at 48h', () => {
  const clock = { elapsedMs: 25 * HOUR_MS }
  const initial = controllerAt(clock)
  const snapshot = initial.snapshot()
  clock.elapsedMs = 48 * HOUR_MS
  const restored = controllerAt(clock, { snapshot })
  assert.equal(restored.assertAvailable({ forExecution: true }).ok, true)
  assert.equal(restored.assertExternalWriteAllowed({ operationId: 'resumed-write' }).allowed, true)

  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.options = {
    baseEnvironment: BENCHMARK_ENVIRONMENT,
    resumeState: { deadline: deadline() },
  }
  runtime.activation = { generation: 2 }
  runtime.settings = { deadline: null }
  runtime.now = () => clock.elapsedMs
  runtime.budget = restored
  assert.deepEqual(runtime._admitTaskDeadline(), { valid: true, deadline: deadline() })

  const boundedRuntime = Object.create(CodexSupervisorRuntime.prototype)
  boundedRuntime.options = { baseEnvironment: {}, resumeState: { deadline: deadline() } }
  boundedRuntime.activation = { generation: 2 }
  boundedRuntime.settings = { deadline: null }
  boundedRuntime.now = () => clock.elapsedMs
  boundedRuntime.budget = controllerAt(clock, { snapshot, wallTimeUnbounded: false })
  assert.equal(boundedRuntime._admitTaskDeadline().code, 'RESUME_DEADLINE_EXPIRED')
})

test('benchmark runtime and launcher capabilities remain valid beyond 48h while normal lifetimes stay bounded', () => {
  const issuedAtMs = Date.parse('2026-08-25T00:00:00.000Z')
  const clock = { now: issuedAtMs }
  const benchmarkAuthority = new RuntimeCapabilityAuthority({
    ...RUNTIME_IDENTITY,
    environment: BENCHMARK_ENVIRONMENT,
    now: () => clock.now,
  })
  const issue = authority => authority.issue({
    providerCapabilities: PROVIDER_CAPABILITIES,
    evidenceHashes: ['5'.repeat(64)],
    cliVersion: 'codex-cli benchmark-boundary-fixture',
    allowedRoutes: Object.keys(ROUTE_CAPABILITY_EFFECTS),
    allowedEffects: [...new Set(Object.values(ROUTE_CAPABILITY_EFFECTS).flat())],
    routeEffects: ROUTE_CAPABILITY_EFFECTS,
    expiresAtMs: issuedAtMs + DAY_MS,
  })
  const expected = receipt => ({
    runId: RUNTIME_IDENTITY.runId,
    generation: RUNTIME_IDENTITY.generation,
    targetIdentity: RUNTIME_IDENTITY.targetIdentity,
    route: 'DIRECT',
    effects: ['read'],
    assignmentId: 'benchmark-boundary-assignment',
    assignmentHash: HASH,
    requiredCapabilities: receipt.capabilitySet,
  })

  const benchmarkReceipt = issue(benchmarkAuthority)
  clock.now = issuedAtMs + 48 * HOUR_MS
  assert.equal(benchmarkAuthority.verify(benchmarkReceipt, expected(benchmarkReceipt)).verified, true)
  assert.ok(Date.parse(benchmarkReceipt.expiresAt) > issuedAtMs + 48 * HOUR_MS)
  assert.ok(runtimeCapabilityExpiryMs(issuedAtMs + DAY_MS, issuedAtMs, BENCHMARK_ENVIRONMENT) > issuedAtMs + 48 * HOUR_MS)

  clock.now = issuedAtMs
  const normalAuthority = new RuntimeCapabilityAuthority({
    ...RUNTIME_IDENTITY,
    environment: {},
    now: () => clock.now,
  })
  const normalReceipt = issue(normalAuthority)
  clock.now = issuedAtMs + 5 * 60 * 1000
  assert.throws(
    () => normalAuthority.verify(normalReceipt, expected(normalReceipt)),
    error => error.code === 'RUNTIME_CAPABILITY_INVALID',
  )

  const now = new Date(issuedAtMs)
  assert.equal(activationCapabilityTtlSeconds(DAY_MS / 1000, now, {}), DAY_MS / 1000)
  const benchmarkTtlSeconds = activationCapabilityTtlSeconds(DAY_MS / 1000, now, BENCHMARK_ENVIRONMENT)
  assert.ok(now.getTime() + benchmarkTtlSeconds * 1000 > issuedAtMs + 48 * HOUR_MS)
})

test('mission expiry and crash cleanup statuses cannot fabricate user cancellation', async () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  let drainedWith = null
  runtime.options = { baseEnvironment: {} }
  runtime.budget = { assertAvailable: () => ({ remaining: { wallMs: 1 } }) }
  runtime.scheduler = { dispose() {} }
  runtime.processOwner = {
    async cancelAll(options) { drainedWith = options },
    async assertDrained() {},
  }
  runtime.timerApi = {
    setTimeout(callback) {
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {},
  }
  runtime.cancelled = false

  await assert.rejects(
    runtime._withinMissionDeadline(() => new Promise(() => {})),
    error => error.code === 'MISSION_TIMEOUT',
  )
  assert.equal(runtime.cancelled, false)
  assert.equal(drainedWith.terminalStatus, 'PARTIAL')

  const processOwner = Object.create(ProcessOwner.prototype)
  assert.equal(processOwner._statusFromExit({ terminalEnvelope: { status: 'LOST' } }), 'LOST')
  assert.equal(processOwner._statusFromExit({ terminalEnvelope: { status: 'FAILED' } }), 'FAILED')
})

test('terminal safety drains propagate the actual task outcome; only explicit cancel uses CANCELLED', async () => {
  let drainedWith = null
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.finished = false
  runtime.route = 'DIRECT'
  runtime.scheduler = {
    dispose() {},
    getMetrics: () => ({ counters: { currentLiveChildren: 0 } }),
    exportState: () => ({ phase: 'done' }),
  }
  runtime.processOwner = {
    async cancelAll(options) { drainedWith = options },
    async assertDrained() {},
  }
  runtime._enforceBudgetPhase = () => ({ action: 'CONTINUE' })
  runtime.finalizer = { finalize: async options => ({ outcome: options.outcome, durable: true }) }
  runtime.budget = { snapshot: () => ({ generation: 1 }) }
  runtime.missionLock = { release() {} }
  runtime.lease = { id: 'lease' }

  const result = await runtime._finish('FAILED', {
    terminalEnvelope: { status: 'FAILED', reason: 'runtime failure' },
  })
  assert.equal(result.outcome, 'FAILED')
  assert.equal(drainedWith.terminalStatus, 'FAILED')
  assert.notEqual(drainedWith.terminalStatus, 'CANCELLED')
})

test('the explicit cancellation entry point is the user-cancellation status provenance', async () => {
  let drainedWith = null
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.cancelled = false
  runtime.finished = false
  runtime.lease = null
  runtime.scheduler = { dispose() {} }
  runtime.processOwner = {
    async cancelAll(options) { drainedWith = options },
    async assertDrained() {},
  }
  runtime._bestEffortPostDrainCheckpoint = async reason => ({ status: 'UNAVAILABLE', reason })

  const result = await runtime.cancel('authenticated user cancellation')
  assert.equal(runtime.cancelled, true)
  assert.equal(drainedWith.terminalStatus, 'CANCELLED')
  assert.equal(result.outcome, 'CANCELLED')
  assert.equal(result.reason, 'authenticated user cancellation')
})

test('finalizer safety drain propagates FAILED instead of fabricating CANCELLED', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-finalizer-status-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const terminalDirectory = path.join(root, 'terminal')
  fs.mkdirSync(terminalDirectory)
  const terminalPath = path.join(terminalDirectory, 'outcome.json')
  let drainedWith = null
  const sentinel = new Error('stop after observing the drain status')
  const finalizer = new Finalizer({
    stateStore: {
      registeredPaths: { runRecordRoot: root, terminalPath },
      load: () => ({ state: 'RUN_WORK', workspaceEpoch: 0 }),
    },
    processOwner: {
      ownershipIdentities: () => [],
      async cancelAll(options) { drainedWith = options },
      async assertTargetDrained() { throw sentinel },
    },
    missionLock: {
      describe: () => ({ status: 'ACTIVE', owner: { targetKey: 'target-key' } }),
      assertOwned() {},
      updateOwnedProcesses() {},
    },
    capability: Object.freeze({ opaque: true }),
    cleanupRegistry: { run() {} },
  })

  await assert.rejects(
    finalizer.finalize({ outcome: 'FAILED', reason: 'runtime failed', deliverables: [] }),
    error => error === sentinel,
  )
  assert.equal(drainedWith.terminalStatus, 'FAILED')
  assert.notEqual(drainedWith.terminalStatus, 'CANCELLED')
})
