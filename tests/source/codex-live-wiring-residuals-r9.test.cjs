#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const { BudgetController } = require(path.join(WORKFLOW, 'budget-controller.js'))
const { CentralScheduler } = require(path.join(WORKFLOW, 'scheduler.js'))
const {
  CodexExecAdapter, CodexSupervisorRuntime, applyProductionRuntimeTransition,
  bindResidualRiskAuthorityReceipt, createCodexJsonlAccumulator,
  createDefaultExternalOperation, createResidualRiskDisposition, executeExistingTestBaseline,
  persistTerminalSession, phaseBudgetVerdict, reconcileExternalOperationTimeout,
  resolveTrustedTestDeclarations, validateResumedBudget,
} = require(path.join(WORKFLOW, 'phase-budget.js'))
const { validateEvidenceInvalidationGraph } = require(path.join(WORKFLOW, 'runtime-state.js'))

const H = value => crypto.createHash('sha256').update(String(value)).digest('hex')

function budget(snapshot) {
  return new BudgetController({
    limits: { wallMs: 100_000, tokens: 10_000, sessions: 20, launches: 20 },
    finalizationReserveMs: 1_000, phases: {}, snapshot,
    monotonicMs: () => 0, wallNowMs: () => 0, wallClock: () => '2026-01-01T00:00:00.000Z', bootId: null,
  })
}

test('RUN-002 hostile historical implementation evidence cannot disable the current scope clock', () => {
  const historicalImplementation = {
    angle: 'prior-prompt-impl-v999.md',
    kind: 'implementation-artifact',
    activationId: 'activation-prior-prompt',
    generationId: 99,
  }
  const current = {
    phase: 'scope', softSec: 10, hardSec: 20,
    activationId: 'activation-current-prompt', generationId: 1,
    landedAngles: [historicalImplementation],
  }

  assert.deepEqual(phaseBudgetVerdict({ ...current, elapsedSec: 11 }), {
    action: 'warn', canReset: false, hardReached: false,
    code: 'PHASE_SOFT_WARNING', residual: [],
  })
  assert.deepEqual(phaseBudgetVerdict({ ...current, elapsedSec: 20 }), {
    action: 'hard-boundary', canReset: true, hardReached: true,
    code: 'PHASE_HARD_BOUNDARY', residual: [],
  })
})

test('RUN-018 production transition progress is activation-bound; overwrite/delete/junk cannot reset crashes', async () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(runtime, {
    activation: { id: 'activation-r9', generation: 1 }, scheduler: null,
    options: { runtimeTransition: async () => ({ sequence: 7, lastEventHash: H('accepted-transition') }) },
  })
  await runtime._runtimeTransition('WORK_ITEM_VERIFIED', 'ITEM_VERIFIED')
  assert.deepEqual(runtime.lastAcceptedProgress, {
    kind: 'transition', accepted: true, activationId: 'activation-r9', generation: 1,
    sequence: 7, evidenceHash: H('accepted-transition'),
  })
  const controller = budget()
  assert.equal(controller.recordCrash('same', {
    activationId: 'activation-r9', progressEvidence: runtime.lastAcceptedProgress,
  }).equivalentCount, 1)
  for (const action of ['overwrite', 'delete', 'junk']) {
    const state = controller.recordCrash('same', {
      activationId: 'activation-r9',
      progressEvidence: {
        kind: 'deliverable', accepted: true, action, activationId: 'activation-r9', generation: 1,
        sequence: 8, evidenceHash: H(action), beforeHash: H('before'), afterHash: H('after'),
      },
    })
    assert.ok(state.equivalentCount > 1)
  }
})

test('RUN-022 production resume reader exhausts equivalentCount/backoffExponent', () => {
  const controller = budget()
  for (let index = 0; index < 3; index += 1) controller.recordCrash('poison', { activationId: 'activation-r9' })
  const prior = controller.snapshot()
  assert.deepEqual(controller.crashRetryVerdict(), {
    exhausted: true, code: 'CRASH_RETRY_EXHAUSTED', equivalentCount: 3,
    backoffExponent: 2, maximumEquivalentCrashes: 3,
  })
  assert.throws(() => validateResumedBudget(controller, prior, 2), error => error.code === 'CRASH_RETRY_EXHAUSTED')
})

test('RUN-023 large JSONL stream retains a bounded tail and constant-size watermark', () => {
  const accumulator = createCodexJsonlAccumulator()
  const startedAt = performance.now()
  for (let index = 0; index < 250_000; index += 1) {
    accumulator.push(JSON.stringify({ type: 'item.started', index }))
    if (index % 10_000 === 0) assert.equal(Object.hasOwn(accumulator.watermark(), 'events'), false)
  }
  const snapshot = accumulator.snapshot()
  assert.equal(snapshot.eventCount, 250_000)
  assert.equal(snapshot.retainedEventCount, 256)
  assert.equal(snapshot.events[0].index, 249_744)
  assert.match(snapshot.eventStreamHash, /^[a-f0-9]{64}$/)
  assert.ok(performance.now() - startedAt < 10_000)
})

test('TRACE-006 production deadline check fails when no first signal was supplied', () => {
  const scheduler = new CentralScheduler({
    route: 'DIRECT', runIdentity: { runId: 'runtime-residual-r9', generation: 1 },
  })
  assert.throws(
    () => scheduler.assertFirstProductSignalDue({ elapsedMs: 360_001 }),
    error => error.code === 'FIRST_PRODUCT_SIGNAL_MISSING' &&
      error.details.firstProductSignal.kind === 'MISSING' &&
      error.details.firstProductSignal.withinCeiling === false,
  )
})

test('TRACE-011 external writes get a default producer and terminal reconciled timeout outcome', () => {
  const operation = createDefaultExternalOperation({
    runId: 'runtime-residual-r9', generation: 1,
    request: { workItemId: 'publish-result' },
    assignment: { resources: [{ kind: 'external-system', identity: 'service:release', access: 'write' }] },
  })
  assert.equal(operation.status, 'PREPARED')
  assert.match(operation.operationId, /^external:[a-f0-9]{64}$/)
  const operations = new Map([[operation.operationId, operation]])
  const reconciled = reconcileExternalOperationTimeout(operation, operations)
  assert.equal(reconciled.status, 'RECONCILED_TIMEOUT')
  assert.match(reconciled.reconciledPartialStateHash, /^[a-f0-9]{64}$/)
})

function adapterRecord(overrides = {}) {
  return {
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\n{}',
    logicalRole: 'worker', physicalRole: 'autoprompt.v2.worker', providerRole: 'ap-worker',
    physicalExecutionPolicy: {
      logicalRole: 'worker', physicalRole: 'autoprompt.v2.worker', providerRole: 'ap-worker',
      sandboxMode: 'workspace-write', policyId: 'policy-r9', policyVersion: 1,
      canDispatch: false, resourceSets: { read: [], write: ['workspace'], exclusive: [] },
    },
    dispatch: { brief: 'bounded work', requestPointer: { hash: H('request-r9') } },
    sessionId: 'session-r9', reservationId: 'reservation-r9', environment: {},
    ...overrides,
  }
}

test('TRACE-011 default adapter denies or intercepts the actual external-write boundary', async () => {
  let writes = 0
  const runner = {
    supportsExternalWriteBoundary: true,
    async run(spec) {
      spec.beforeExternalWrite()
      writes += 1
      throw new Error('write should not execute')
    },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT, profilePath: ROOT, outputSchemaResolver: () => ROOT,
  })
  const deadline = Object.assign(new Error('external write deadline elapsed'), {
    code: 'EXTERNAL_WRITE_DEADLINE_EXPIRED',
  })
  await assert.rejects(adapter.launch(adapterRecord({
    externalOperation: { operationId: 'external:r9' },
    beforeExternalWrite() { throw deadline },
  })), error => error.code === 'EXTERNAL_WRITE_DEADLINE_EXPIRED')
  assert.equal(writes, 0)

  const unavailable = new CodexExecAdapter({
    runner: { run: async () => { writes += 1 } },
    targetPath: ROOT, profilePath: ROOT, outputSchemaResolver: () => ROOT,
  })
  await assert.rejects(unavailable.launch(adapterRecord({
    externalOperation: { operationId: 'external:r9-unavailable' }, beforeExternalWrite() {},
  })), error => error.code === 'EXTERNAL_WRITE_BOUNDARY_UNAVAILABLE')
  assert.equal(writes, 0)
})

test('TRACE-006 adapter emits a validated product signal while the child remains running', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const signals = []
  const adapter = new CodexExecAdapter({
    runner: {
      async run(spec) {
        spec.onStdoutLine(JSON.stringify({
          type: 'item.completed', item: { type: 'file_change', status: 'completed', path: 'result.txt' },
        }))
        await gate
        throw Object.assign(new Error('bounded test stop'), { code: 'TEST_STOP' })
      },
    },
    targetPath: ROOT, profilePath: ROOT, outputSchemaResolver: () => ROOT,
  })
  const launched = adapter.launch(adapterRecord({ onFirstProductSignal: signal => signals.push(signal) }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(signals.length, 1)
  assert.equal(signals[0].kind, 'PRODUCT_EDIT')
  assert.match(signals[0].evidenceHash, /^[a-f0-9]{64}$/)
  release()
  await assert.rejects(launched, error => error.code === 'TEST_STOP')
})

test('TRACE-021 terminal session record is activation/parent bound and immutable', () => {
  const controller = budget()
  controller.startSession('session-r9', {
    activationId: 'activation-r9', parentSessionId: 'parent-r9',
  })
  const terminal = controller.endSession('session-r9', {
    status: 'DONE', evidenceHashes: [H('evidence-r9')], lastToolAt: '2026-01-01T00:00:01.000Z',
  })
  assert.equal(terminal.activationId, 'activation-r9')
  assert.equal(terminal.parentSessionId, 'parent-r9')
  assert.equal(terminal.status, 'DONE')
  assert.match(terminal.recordHash, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(controller.state.sessions['session-r9']), true)
  assert.throws(() => controller.endSession('session-r9', { status: 'FAILED', evidenceHashes: [] }),
    error => error.code === 'SESSION_RECORD_INVALID')
})

test('TRACE-021 failure terminal persistence retries and preserves the primary error', () => {
  let attempts = 0
  const controller = new BudgetController({
    limits: { wallMs: 100_000, tokens: 10_000, sessions: 20, launches: 20 },
    finalizationReserveMs: 1_000, phases: {},
    monotonicMs: () => 0, wallNowMs: () => 0, wallClock: () => '2026-01-01T00:00:00.000Z', bootId: null,
    terminalSessionWriter() {
      attempts += 1
      throw Object.assign(new Error('disk unavailable'), { code: 'RUN_RECORD_FAILURE' })
    },
  })
  controller.startSession('failed-session-r9', {
    activationId: 'activation-r9', parentSessionId: 'parent-r9',
  })
  const primary = Object.assign(new Error('worker failed'), { code: 'WORKER_FAILED' })
  assert.throws(
    () => persistTerminalSession(controller, 'failed-session-r9', { status: 'FAILED', evidenceHashes: [] }, primary),
    error => error === primary && error.terminalPersistenceFailure.code === 'SESSION_TERMINAL_PERSIST_FAILED' &&
      error.terminalPersistenceFailure.attempts.length === 2,
  )
  assert.equal(attempts, 2)
  assert.equal(controller.state.sessions['failed-session-r9'].status, 'RUNNING')
})

test('GATE-023 production baseline runner records real unrelated-red outcomes', async () => {
  const calls = []
  const declarations = resolveTrustedTestDeclarations({ controlPlane: [
    { id: 'green', executable: process.execPath, argv: ['--test', 'tests/source/green.test.cjs'] },
    { id: 'unrelated-red', executable: process.execPath, argv: ['--test', 'tests/source/red.test.cjs'] },
  ] }, { repository: ROOT })
  const baseline = await executeExistingTestBaseline(declarations, {
    environment: { SAFE: '1' },
    runner: async input => {
      calls.push(input)
      return input.id === 'green'
        ? { status: 0, stdout: 'ok', stderr: '', processOwned: true, exactArgv: true, drained: true }
        : { status: 7, stdout: '', stderr: 'known failure', processOwned: true, exactArgv: true, drained: true }
    },
  })
  assert.deepEqual(baseline.map(item => [item.id, item.status, item.exitCode]), [
    ['green', 'PASS', 0], ['unrelated-red', 'FAIL', 7],
  ])
  assert.equal(calls.length, 2)
  assert.ok(baseline.every(item => /^[a-f0-9]{64}$/.test(item.outputHash)))
})

test('ROUTE-013 live safe degradation reclassifies DIRECT to sequential LIGHT', () => {
  const scheduler = new CentralScheduler({
    route: 'DIRECT', runIdentity: { runId: 'runtime-residual-r9', generation: 1 },
  })
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(runtime, {
    route: 'DIRECT', routeSource: 'automatic',
    options: { safeDegradationEvaluator: () => ({ accepted: true, evaluationHash: H('degraded') }) },
  })
  const request = { route: 'DIRECT' }
  const verification = runtime._applySafeTransportDegradation({
    verified: false,
    degradedTransport: {
      mode: 'sequential-isolated', taskCapabilityPreserved: true,
      independencePreserved: true, acceptancePreserved: true,
    },
  }, request, scheduler)
  assert.equal(verification.verified, true)
  assert.equal(request.route, 'LIGHT')
  assert.equal(runtime.route, 'LIGHT')
  assert.equal(scheduler.getMetrics().route, 'LIGHT')
})

test('ROUTE-016/018 production transition freezes full graph and records both bound verdicts', () => {
  const calls = []
  const stateStore = {
    freezeCandidateForChecks(input) { calls.push(['freeze', input]); return { sequence: 1, lastEventHash: H('freeze') } },
    recordIndependentVerdict(input) { calls.push(['verdict', input]); return { sequence: calls.length, lastEventHash: H(input.verdictId) } },
    transition() { throw new Error('generic transition must not handle graph-bound events') },
  }
  const authority = { stateStore, capability: { opaque: true }, budgetController: budget() }
  const details = {
    missionHash: H('mission'), planHash: H('plan'), candidateHash: H('candidate'),
    environmentHash: H('environment'), oracleHash: H('oracle'), assumptionsHash: H('assumptions'),
    dependencyHash: H('dependencies'),
  }
  applyProductionRuntimeTransition(authority, { eventId: 'ALL_WORK_JOINED', nextState: 'CHECK_WORK', details })
  for (const verdictId of ['reviewer-verdict', 'tester-verdict']) {
    applyProductionRuntimeTransition(authority, {
      eventId: 'INDEPENDENT_VERDICT_RECORDED', nextState: 'CHECK_WORK',
      details: { verdictId, verdictHash: H(verdictId) },
    })
  }
  const frozen = calls[0][1]
  assert.equal(frozen.dependencyHash, details.dependencyHash)
  assert.equal(frozen.environmentHash, details.environmentHash)
  assert.equal(validateEvidenceInvalidationGraph(frozen.evidenceGraph).valid, true)
  assert.deepEqual(calls.slice(1).map(call => call[1].verdictId), ['reviewer-verdict', 'tester-verdict'])
})

test('GATE-030 advisory authority cannot conceal a severity downgrade', () => {
  assert.throws(() => createResidualRiskDisposition({
    findings: [{
      id: 'finding-r9', originalSeverity: 'P1', severity: 'P3', disposition: 'advisory', resolution: 'open',
    }],
    authorityReceipt: { authority: 'owner', receiptHash: H('authority'), acceptedFindingIds: ['finding-r9'] },
  }), error => error.code === 'SEVERITY_DOWNGRADE_FORBIDDEN')
})

test('GATE-030 post-finding authority is exact, hash-bound, and cannot accept blocking findings', () => {
  const advisory = [{ id: 'finding-r9-advisory', severity: 'P2', disposition: 'advisory', resolution: 'open' }]
  const receipt = bindResidualRiskAuthorityReceipt({
    findings: advisory,
    decision: { authority: 'release-owner', acceptedFindings: [{ id: 'finding-r9-advisory', severity: 'P2' }] },
    candidateHash: H('candidate-r9'), runId: 'run-r9', activationId: 'activation-r9', generation: 1,
  })
  assert.deepEqual(createResidualRiskDisposition({ findings: advisory, authorityReceipt: receipt }).advisoryFindingIds,
    ['finding-r9-advisory'])
  assert.throws(() => createResidualRiskDisposition({
    findings: advisory,
    authorityReceipt: { ...receipt, acceptedFindings: [{ id: 'finding-r9-advisory', severity: 'P3' }] },
  }), error => error.code === 'RESIDUAL_RISK_AUTHORITY_REQUIRED')
  assert.throws(() => createResidualRiskDisposition({
    findings: [{ id: 'finding-r9-blocking', severity: 'P1', disposition: 'blocking', resolution: 'open' }],
    authorityReceipt: receipt,
  }), error => error.code === 'BLOCKING_FINDING_OPEN')
})
