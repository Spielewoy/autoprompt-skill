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
  createDefaultRuntimeOptions,
  productionPhaseBudgets,
  runtimeCapabilityExpiryMs,
} = require('../../agents/codex/workflow/phase-budget.js')
const { createRunRecord } = require('../../agents/codex/workflow/run-record.js')
const { activationCapabilityTtlSeconds } = require('../../scripts/codex-configure.cjs')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const AMBIENT_MEASUREMENT_ENVIRONMENT = Object.freeze({ AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1' })
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
    monotonicClockId: 'completion-boundary-fake-clock',
    wallNowMs: () => clock.elapsedMs,
    wallClock: () => new Date(clock.elapsedMs).toISOString(),
    bootId: null,
    wallTimeUnbounded: options.wallTimeUnbounded === true,
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

function createProductionRuntimeOptionsFixture(directory, fixtureId, context = {}) {
  const activationRoot = path.join(directory, fixtureId, 'activation')
  const target = path.join(directory, fixtureId, 'target')
  fs.mkdirSync(activationRoot, { recursive: true })
  fs.mkdirSync(target, { recursive: true })
  const runId = `token-limit-${fixtureId}`
  const record = createRunRecord({
    targetPath: target,
    canonicalProviderPrivateRoot: path.join(activationRoot, 'supervisor-runtime'),
    allowProjectMutation: true,
    readOnly: true,
    exactTree: true,
    runId,
    assertStartBoundary: false,
  })
  const modelSelection = {
    schemaVersion: 1,
    mode: 'provider-default',
    selector: 'provider-default',
    models: [],
    effort: null,
    castingHash: '6'.repeat(64),
    agentDefinitionsHash: '7'.repeat(64),
    registry: null,
    probeAcceptance: {
      strictConfig: true,
      profileAcceptedAt: new Date().toISOString(),
      explicitModelAndEffortAssignments: false,
    },
  }
  const requestArgv = ['verify-production-token-limit']
  const activation = {
    activationAttestation: { hash: '1'.repeat(64) },
    activationRoot,
    enforcementProof: { profileSha256: '2'.repeat(64) },
    entryPrompt: 'verify production token-limit wiring',
    modelRegistry: null,
    modelSelection,
    profilePath: path.join(activationRoot, 'autoprompt.config.toml'),
    requestArgv,
    runId,
    supervisorRuntime: {
      runPath: record.runPath,
      runId,
      metadataSha256: '3'.repeat(64),
      targetIdentity: record.targetIdentity,
    },
    record: {
      target: { realpath: target },
      request: { canonicalJson: JSON.stringify({ schemaVersion: 1, argv: requestArgv }) },
      capability: {
        generation: 1,
        expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
        parentSession: 'token-limit-parent',
      },
      contractVersions: {},
      providerAttestation: { attestation: { activationNonce: 'token-limit-nonce' } },
      activationBoundary: {
        gitConfig: path.join(activationRoot, 'empty.gitconfig'),
        ghConfigDir: path.join(activationRoot, 'gh-config'),
        enforcementProof: { path: path.join(activationRoot, 'enforcement-proof.json') },
        supervisorAdapterSha256: '4'.repeat(64),
        payloadManifestSha256: '5'.repeat(64),
      },
      modelSelection,
    },
  }
  return createDefaultRuntimeOptions({
    activation,
    probe: {
      supported: true,
      executable: process.execPath,
      cliVersion: 'token-limit-wiring-fixture',
      evidenceHashes: ['8'.repeat(64)],
    },
    context: { expectedBranch: 'main', providerMaximum: 2, ...context },
  })
}

test('required local completion remains available across execution, work, and elapsed wall targets', () => {
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
      const status = budget.assertAvailable({ ...view, requiredCompletion: true })
      assert.equal(status.ok, true, `elapsed=${elapsedMs} view=${JSON.stringify(view)}`)
      assert.equal(status.remaining.wallMs >= 0, true)
      assert.equal(status.wallTimeUnbounded, false)
    }
    if (elapsedMs < DAY_MS) {
      assert.equal(budget.assertExternalWriteAllowed({ operationId: `write-${elapsedMs}` }).allowed, true)
    } else {
      assert.throws(
        () => budget.assertExternalWriteAllowed({ operationId: `write-${elapsedMs}` }),
        error => error.code === 'EXTERNAL_WRITE_DEADLINE_EXPIRED',
      )
    }
  }

  assert.equal(
    budget.accountingCeilings({ retries: 2, costMicrounits: 10 }).wallMilliseconds,
    DAY_MS,
  )
})

test('required phase work records elapsed targets and continues without an ambient bypass', () => {
  const clock = { elapsedMs: 0 }
  const budget = controllerAt(clock)
  budget.startPhase('EXECUTION_BUILD')
  clock.elapsedMs = 48 * HOUR_MS
  assert.equal(budget.supervisorDecision('EXECUTION_BUILD').action, 'STOP_ACTIVATION')

  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.options = { baseEnvironment: AMBIENT_MEASUREMENT_ENVIRONMENT }
  runtime.budget = budget
  runtime.route = 'DIRECT'
  const decision = runtime._enforceBudgetPhase('EXECUTION_BUILD', { requiredCompletion: true })
  assert.equal(decision.action, 'CONTINUE')
  assert.equal(decision.reason, 'REQUIRED_COMPLETION')
  assert.equal(Object.hasOwn(decision, 'targetAction'), false,
    'required completion must not publish an internal stop instruction')
  assert.equal(Object.hasOwn(decision, 'targetReason'), false)
  assert.equal(decision.completionCanContinue, true)
  assert.equal(decision.completionTargetOverrun, true)
})

test('production default runtime has no implicit activation token stop and validates explicit targets', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-production-token-limit-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const unboundedOptions = createProductionRuntimeOptionsFixture(directory, 'absent')
  assert.equal(unboundedOptions.budgetController.snapshot().limits.tokens, Number.MAX_SAFE_INTEGER)
  const unboundedRuntime = new CodexSupervisorRuntime(unboundedOptions)
  assert.equal(unboundedRuntime.budget, unboundedOptions.budgetController)
  assert.equal(unboundedRuntime.budget.snapshot().limits.tokens, Number.MAX_SAFE_INTEGER)

  const explicitOptions = createProductionRuntimeOptionsFixture(
    directory,
    'explicit',
    { tokenLimit: 1_234_567 },
  )
  assert.equal(explicitOptions.budgetController.snapshot().limits.tokens, 1_234_567)
  const explicitRuntime = new CodexSupervisorRuntime(explicitOptions)
  assert.equal(explicitRuntime.budget, explicitOptions.budgetController)
  assert.equal(explicitRuntime.budget.snapshot().limits.tokens, 1_234_567)

  assert.throws(
    () => createProductionRuntimeOptionsFixture(directory, 'zero', { tokenLimit: 0 }),
    error => error.code === 'BUDGET_CONFIG_INVALID',
  )
  assert.throws(
    () => createProductionRuntimeOptionsFixture(directory, 'unsafe', {
      tokenLimit: Number.MAX_SAFE_INTEGER + 1,
    }),
    error => error.code === 'BUDGET_CONFIG_INVALID',
  )
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

test('ambient measurement variables cannot change token, session, or launch ceilings', () => {
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

test('resume admits an expired persisted deadline for local work but denies external writes', () => {
  const clock = { elapsedMs: 25 * HOUR_MS }
  const initial = controllerAt(clock)
  const snapshot = initial.snapshot()
  clock.elapsedMs = 48 * HOUR_MS
  const restored = controllerAt(clock, { snapshot })
  assert.equal(restored.assertAvailable({ forExecution: true, requiredCompletion: true }).ok, true)
  assert.throws(
    () => restored.assertExternalWriteAllowed({ operationId: 'resumed-write' }),
    error => error.code === 'EXTERNAL_WRITE_DEADLINE_EXPIRED',
  )

  const boundedRuntime = Object.create(CodexSupervisorRuntime.prototype)
  boundedRuntime.options = { baseEnvironment: {}, resumeState: { deadline: deadline() } }
  boundedRuntime.activation = { generation: 2 }
  boundedRuntime.settings = { deadline: null }
  boundedRuntime.now = () => clock.elapsedMs
  boundedRuntime.budget = controllerAt(clock, { snapshot, wallTimeUnbounded: false })
  assert.deepEqual(boundedRuntime._admitTaskDeadline(), {
    valid: true,
    deadline: deadline(),
    convergenceRequired: true,
    completionCanContinue: true,
    completionTargetOverrun: ['WALL'],
    reason: 'persisted resume deadline elapsed; bounded local recovery and completion remain required',
  })
})

test('runtime capability expiry preserves one live controller but rejects restart and generation replay', () => {
  const issuedAtMs = Date.parse('2026-08-25T00:00:00.000Z')
  const clock = { now: issuedAtMs }
  const authorityWithAmbientVariable = new RuntimeCapabilityAuthority({
    ...RUNTIME_IDENTITY,
    environment: AMBIENT_MEASUREMENT_ENVIRONMENT,
    now: () => clock.now,
  })
  const issue = (authority, expiresAtMs = issuedAtMs + 72 * HOUR_MS) => authority.issue({
    providerCapabilities: PROVIDER_CAPABILITIES,
    evidenceHashes: ['5'.repeat(64)],
    cliVersion: 'codex-cli benchmark-boundary-fixture',
    allowedRoutes: Object.keys(ROUTE_CAPABILITY_EFFECTS),
    allowedEffects: [...new Set(Object.values(ROUTE_CAPABILITY_EFFECTS).flat())],
    routeEffects: ROUTE_CAPABILITY_EFFECTS,
    expiresAtMs,
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

  const benchmarkReceipt = issue(authorityWithAmbientVariable)
  clock.now = issuedAtMs + 48 * HOUR_MS
  assert.equal(authorityWithAmbientVariable.verify(benchmarkReceipt, expected(benchmarkReceipt)).verified, true)
  assert.equal(Date.parse(benchmarkReceipt.expiresAt), issuedAtMs + 72 * HOUR_MS)
  assert.equal(runtimeCapabilityExpiryMs(
    issuedAtMs + 72 * HOUR_MS, issuedAtMs, AMBIENT_MEASUREMENT_ENVIRONMENT,
  ), issuedAtMs + 72 * HOUR_MS)

  clock.now = issuedAtMs
  const normalAuthority = new RuntimeCapabilityAuthority({
    ...RUNTIME_IDENTITY,
    environment: {},
    now: () => clock.now,
  })
  const normalReceipt = issue(normalAuthority, issuedAtMs + 5 * 60 * 1000)
  clock.now = issuedAtMs + 5 * 60 * 1000
  assert.equal(normalAuthority.verify(normalReceipt, {
    ...expected(normalReceipt),
    assignmentId: 'required-check-after-admission-expiry',
  }).verified, true)
  assert.throws(
    () => normalAuthority.verify(JSON.parse(JSON.stringify(normalReceipt)), expected(normalReceipt)),
    error => error.code === 'RUNTIME_CAPABILITY_INVALID',
  )
  const restartedAuthority = new RuntimeCapabilityAuthority({
    ...RUNTIME_IDENTITY,
    environment: {},
    key: normalAuthority.key,
    now: () => clock.now,
  })
  assert.throws(
    () => restartedAuthority.verify(normalReceipt, expected(normalReceipt)),
    error => error.code === 'RUNTIME_CAPABILITY_INVALID',
  )
  const resumedAuthority = new RuntimeCapabilityAuthority({
    ...RUNTIME_IDENTITY,
    generation: RUNTIME_IDENTITY.generation + 1,
    environment: {},
    now: () => clock.now,
  })
  assert.throws(
    () => resumedAuthority.verify(normalReceipt, {
      ...expected(normalReceipt),
      generation: RUNTIME_IDENTITY.generation + 1,
    }),
    error => error.code === 'RUNTIME_CAPABILITY_INVALID',
  )

  const now = new Date(issuedAtMs)
  assert.equal(activationCapabilityTtlSeconds(DAY_MS / 1000, now, {}), DAY_MS / 1000)
  const observedTtlSeconds = activationCapabilityTtlSeconds(
    DAY_MS / 1000, now, AMBIENT_MEASUREMENT_ENVIRONMENT,
  )
  assert.equal(observedTtlSeconds, DAY_MS / 1000)
})

test('mission target expiry preserves bounded in-flight completion and cannot fabricate user cancellation', async () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.options = { baseEnvironment: {} }
  runtime.budget = { assertAvailable: () => ({ remaining: { wallMs: 1 } }) }
  runtime.scheduler = { dispose() {} }
  runtime.cancelled = false

  let operationRan = false
  const result = await runtime._withinMissionDeadline(async () => {
    operationRan = true
    return 'completed-result'
  })
  assert.equal(result, 'completed-result')
  assert.equal(operationRan, true)
  assert.equal(runtime.cancelled, false)

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
