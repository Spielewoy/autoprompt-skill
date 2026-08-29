#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const POWERSHELL_AVAILABLE = spawnSync(
  POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  { encoding: 'utf8', timeout: 10_000 },
).status === 0
const { BudgetController } = require(path.join(WORKFLOW, 'budget-controller.js'))
const {
  assertDistinctEvidenceConsumption,
  createCodexJsonlAccumulator,
  createResidualRiskDisposition,
  reconstructTypedExitZeroResult,
  requiredCompletionGates,
  validateWorkerRequestedTransition,
} = require(path.join(WORKFLOW, 'phase-budget.js'))

function controller(snapshot) {
  return new BudgetController({
    limits: { wallMs: 60_000, tokens: 100, sessions: 10, launches: 10 },
    phases: {}, finalizationReserveMs: 1_000,
    monotonicMs: () => 10, wallNowMs: () => 1_700_000_000_000,
    wallClock: () => '2023-11-14T22:13:20.000Z', bootId: 'test-boot', snapshot,
  })
}

test('RUN-021/022 crash allowance is activation-global across fingerprints and restart', () => {
  const first = controller()
  assert.equal(first.recordCrash('exception:a', { activationId: 'activation-r6' }).equivalentCount, 1)
  assert.equal(first.recordCrash('exception:b', { activationId: 'activation-r6' }).equivalentCount, 2,
    'arbitrary changed fingerprints cannot reset the retry allowance')
  const resumed = controller(first.snapshot())
  const third = resumed.recordCrash('exception:c', { activationId: 'activation-r6' })
  assert.equal(third.equivalentCount, 3)
  assert.equal(third.totalCrashes, 3)
  assert.equal(third.backoffExponent, 2)
  const accepted = resumed.recordCrash('exception:d', { activationId: 'activation-r6', progressEvidence: {
    kind: 'deliverable', action: 'accepted-change', activationId: 'activation-r6', generation: 1, sequence: 1,
    evidenceHash: 'a'.repeat(64), beforeHash: '1'.repeat(64), afterHash: '2'.repeat(64), accepted: true,
  } })
  assert.equal(accepted.equivalentCount, 1)
  assert.equal(accepted.backoffExponent, 0)
  assert.equal(resumed.recordCrash('exception:delete', { activationId: 'activation-r6', progressEvidence: {
    kind: 'deliverable', action: 'accepted-change', activationId: 'activation-r6', generation: 1, sequence: 2,
    evidenceHash: 'b'.repeat(64), beforeHash: '2'.repeat(64), afterHash: '3'.repeat(64), accepted: true,
  } }).equivalentCount, 1, 'accepted deletion with exact before/after binding is deliverable progress')
  assert.equal(resumed.recordCrash('exception:e', { activationId: 'activation-r6', progressEvidence: {
    kind: 'deliverable', action: 'accepted-change', activationId: 'foreign-activation', generation: 1, sequence: 3,
    evidenceHash: 'c'.repeat(64), beforeHash: '3'.repeat(64), afterHash: '4'.repeat(64), accepted: true,
  } }).equivalentCount, 2, 'foreign-run writes do not reset backoff')
  assert.equal(resumed.recordCrash('exception:f', { activationId: 'activation-r6', progressEvidence: {
    kind: 'junk-file', activationId: 'activation-r6', generation: 1, sequence: 4, evidenceHash: 'd'.repeat(64), accepted: true,
  } }).equivalentCount, 3, 'junk files do not reset backoff')
  assert.equal(resumed.recordCrash('exception:g', { activationId: 'activation-r6', progressEvidence: {
    kind: 'oracle', action: 'accepted-change', activationId: 'activation-r6', generation: 1, sequence: 5,
    evidenceHash: 'e'.repeat(64), beforeHash: '4'.repeat(64), afterHash: '5'.repeat(64), accepted: true,
  } }).equivalentCount, 1, 'accepted oracle evidence resets backoff')
})

test('RUN-023/026 JSONL is accumulated once and exit-zero missing results reconstruct terminal failure', () => {
  const accumulator = createCodexJsonlAccumulator()
  const expectedStreamHash = crypto.createHash('sha256')
  expectedStreamHash.update('[')
  let logicalEventCount = 0
  const consume = event => {
    const encoded = JSON.stringify(event)
    expectedStreamHash.update(logicalEventCount === 0 ? '' : ',').update(encoded)
    logicalEventCount += 1
    assert.deepEqual(accumulator.push(encoded), event)
    if (logicalEventCount % 1_000 === 0) {
      const progress = accumulator.watermark()
      assert.equal(progress.eventCount, logicalEventCount)
      assert.equal(progress.retainedEventCount, Math.min(logicalEventCount, 256))
      assert.equal(Object.hasOwn(progress, 'events'), false)
    }
  }
  for (let index = 0; index < 10_000; index += 1) {
    consume({ type: 'item.started', index })
  }
  consume({ type: 'thread.started', thread_id: 'thread-1' })
  consume({ type: 'turn.completed', usage: {
    input_tokens: 3, cached_input_tokens: 2, output_tokens: 4, reasoning_tokens: 4,
  } })
  const snapshot = accumulator.snapshot()
  assert.equal(logicalEventCount, 10_002)
  assert.equal(snapshot.eventCount, logicalEventCount)
  assert.equal(snapshot.eventStreamHash, expectedStreamHash.update(']').digest('hex'))
  assert.equal(snapshot.retainedEventCount, 256)
  assert.equal(snapshot.events.length, 256)
  assert.deepEqual(snapshot.events[0], { type: 'item.started', index: 9_746 })
  assert.deepEqual(snapshot.events.at(-2), { type: 'thread.started', thread_id: 'thread-1' })
  assert.equal(snapshot.sessionId, 'thread-1')
  assert.deepEqual(snapshot.usage, { noncachedInput: 1, cachedInput: 2, output: 4, reasoning: 4 })
  const reconstructed = reconstructTypedExitZeroResult({
    logicalRole: 'worker', physicalRole: 'autoprompt.v2.worker', runId: 'run-12345678',
    workItemId: 'work-1', findingIds: ['AP-RUN-026'], candidateHash: null,
    dispatch: { requestPointer: { hash: 'e'.repeat(64) } },
  }, snapshot)
  assert.equal(reconstructed.outcome, 'FAILED')
  assert.equal(reconstructed.reconstructedTerminal, true)
  assert.equal(reconstructed.requestedTransition.event, 'WORK_ITEM_VERIFIED')
})

test('LAYER transition, evidence, residual, and completion mechanisms fail closed', () => {
  assert.equal(validateWorkerRequestedTransition({ requestedTransition: {
    event: 'WORK_ITEM_VERIFIED', reason: 'Accepted exact result.', invalidateEvidenceIds: [],
  } }).event, 'WORK_ITEM_VERIFIED')
  assert.throws(() => validateWorkerRequestedTransition({ requestedTransition: {
    event: 'DONE', reason: 'worker self-promotes', invalidateEvidenceIds: [],
  } }), error => error.code === 'REQUESTED_TRANSITION_INVALID')

  assert.deepEqual(assertDistinctEvidenceConsumption([
    { checkerId: 'review', oracleId: 'requirements', evidenceIds: [' plan-diff '] },
    { checkerId: 'test', oracleId: 'behavior', evidenceIds: ['fresh-run'] },
  ]).consumedEvidenceIds, ['fresh-run', 'plan-diff'])
  assert.throws(() => assertDistinctEvidenceConsumption([
    { checkerId: 'one', oracleId: 'oracle-1', evidenceIds: ['same'] },
    { checkerId: 'two', oracleId: 'oracle-2', evidenceIds: ['same'] },
  ]), error => error.code === 'DUPLICATE_UNDERLYING_EVIDENCE')

  assert.deepEqual(createResidualRiskDisposition({ findings: [{
    id: 'P2-1', severity: 'P2', originalSeverity: 'P2', disposition: 'blocking',
    resolution: 'non-defect', evidenceIds: ['trace-1'],
  }] }).evidenceClosedFindingIds, ['P2-1'])
  assert.throws(() => createResidualRiskDisposition({ findings: [{
    id: 'P3-1', severity: 'P1', originalSeverity: 'P3', disposition: 'blocking',
    resolution: 'non-defect', evidenceIds: ['trace-2'],
  }] }), error => error.code === 'NON_DEFECT_EVIDENCE_REQUIRED')

  for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) for (const tier of ['T0', 'T1', 'T2', 'T3']) {
    const gates = requiredCompletionGates(route, tier)
    assert.ok(gates.includes('usable-build'))
    assert.equal(gates.includes('risk-sign-off'), tier === 'T3')
  }
})

test('RUN-016 PowerShell adapter rejects alternate, corrupt, and wrong-version controllers', {
  skip: !POWERSHELL_AVAILABLE,
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-runtime-controller-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const adapter = path.join(directory, 'supervisor.ps1')
  const runtime = path.join(directory, 'phase-budget.js')
  const alternate = path.join(directory, 'alternate.js')
  fs.copyFileSync(path.join(WORKFLOW, 'supervisor.ps1'), adapter)
  fs.writeFileSync(alternate, 'process.exit(0)\n')
  const invoke = env => spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', adapter, '--capabilities',
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })

  fs.writeFileSync(runtime, 'this is not javascript\n')
  assert.match(invoke({ AUTOPROMPT_RUNTIME: '' }).stderr, /RUNTIME_CONTROLLER_INVALID/)

  fs.writeFileSync(runtime,
    "if(process.argv.includes('--capabilities'))process.stdout.write(JSON.stringify({schemaVersion:1,provider:'codex'}))\n")
  assert.match(invoke({ AUTOPROMPT_RUNTIME: '' }).stderr, /version\/provider mismatch/)

  assert.match(invoke({ AUTOPROMPT_RUNTIME: alternate }).stderr, /ALTERNATE_RUNTIME_UNSUPPORTED/)
})
