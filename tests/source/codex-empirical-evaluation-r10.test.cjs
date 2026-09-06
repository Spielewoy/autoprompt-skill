'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const empirical = require('../../scripts/benchmark-evidence/empirical-r10.cjs')
const routeHoldout = require('../../scripts/benchmark-evidence/route-holdout.cjs')

const CONFIG = path.join(ROOT, 'tests', 'fixtures', 'codex-empirical-r10', 'preregistration.json')

function stableExecutionProjection(report) {
  return {
    preregistration: report.preregistration,
    cohort: report.cohort,
    sourceBindings: report.sourceBindings,
    attempts: report.attempts.map(attempt => ({
      taskId: attempt.taskId,
      repetition: attempt.repetition,
      pairedOrder: attempt.pairedOrder,
      armId: attempt.armId,
      expectedRoute: attempt.expectedRoute,
      predictedRoute: attempt.predictedRoute,
      terminalState: attempt.terminalState,
      sourceBinding: attempt.sourceBinding,
    })),
    arms: report.arms,
    findings: report.findings,
  }
}

test('r10 executes the complete preregistered deterministic cohort in three paired repetitions and exact three arms', () => {
  const preregistration = empirical.loadPreregistration(CONFIG)
  const first = empirical.runLocalEmpiricalEvaluation({
    repoRoot: ROOT,
    preregistration,
    generatedAt: '2026-08-23T12:00:00.000Z',
  })
  const second = empirical.runLocalEmpiricalEvaluation({
    repoRoot: ROOT,
    preregistration,
    generatedAt: '2026-08-23T12:00:00.000Z',
  })

  assert.deepEqual(stableExecutionProjection(second), stableExecutionProjection(first))
  assert.equal(first.preregistration.taskCount, 10)
  assert.equal(first.cohort.domains.length, 10)
  assert.deepEqual(first.cohort.expectedRouteDistribution, { DIRECT: 5, LIGHT: 3, ROADMAP: 2 })
  assert.equal(first.preregistration.exclusions.length, 0)
  assert.equal(first.preregistration.repetitions, 3)
  assert.deepEqual(first.preregistration.arms, ['base', 'current', 'redesign'])
  assert.equal(first.attempts.length, 10 * 3 * 3)
  assert.ok(first.attempts.every(attempt => ['PASS', 'FAIL'].includes(attempt.terminalState)))
  assert.ok(first.attempts.every(attempt => attempt.predictedRoute !== null))
  assert.ok(first.attempts.filter(attempt => attempt.armId === 'current').every(attempt => attempt.sourceBinding === 'executed-git-commit'))
  assert.ok(first.attempts.filter(attempt => attempt.armId === 'redesign').every(attempt => attempt.sourceBinding === 'executed-worktree-files'))
  assert.ok(first.attempts.filter(attempt => attempt.armId === 'base').every(attempt => attempt.sourceBinding === 'single-agent-no-router'))
  assert.ok(Object.values(first.arms).every(arm => arm.terminalCount === 30))
  assert.equal(first.arms.current.correct, 30)
  assert.equal(first.arms.redesign.correct, 30)
  assert.ok(first.arms.base.correct < first.arms.current.correct)
  assert.equal(first.comparison.redesignMinusCurrentCorrect, 0)
  assert.equal(first.liveModelCalls, 0)
  assert.equal(first.qualityClaimEligible, false)

  assert.equal(first.findings['AP-TEST-002'].status, 'SATISFIED_LOCAL')
  assert.equal(first.findings['AP-TEST-036'].status, 'SATISFIED_LOCAL')
  assert.equal(first.findings['AP-DESIGN-027'].status, 'SATISFIED_LOCAL')
  assert.equal(first.findings['AP-DESIGN-028'].status, 'SATISFIED_LOCAL')
  assert.equal(first.findings['AP-DESIGN-038'].status, 'BLOCKED_EXTERNAL_INPUT')
  assert.deepEqual(first.findings['AP-DESIGN-038'].missingExternalInput, [
    'a development-separated holdout task set not seen by prompt or classifier authors',
    'two independently produced human route-label files with distinct rater attestations',
    'adjudications with rationales for every rater disagreement',
    'a freeze record proving task bytes and labels were sealed before prompt tuning',
  ])
})

test('r10 measures deterministic analyst cost, actual transcript consumption, and route errors avoided without removing the required analyst', () => {
  const report = empirical.runLocalEmpiricalEvaluation({
    repoRoot: ROOT,
    preregistration: empirical.loadPreregistration(CONFIG),
    generatedAt: '2026-08-23T12:00:00.000Z',
  })
  const ablation = report.analystAblation

  assert.equal(ablation.observationKind, 'deterministic-local-analyst-replay')
  assert.equal(ablation.analystRemovedFromProduct, false)
  assert.equal(ablation.samples, 10)
  assert.equal(ablation.routeCoverageComplete, true)
  assert.equal(ablation.liveModelCalls, 0)
  assert.ok(ablation.value.errorsCorrected > 0)
  assert.equal(ablation.value.errorsRegressed, 0)
  assert.ok(ablation.value.netErrorCostAvoided > 0)
  assert.ok(ablation.value.netErrorCostAvoidedPerLocalComputeMs > 0)
  assert.ok(ablation.accounting.totals.sessionCount > 0)
  assert.ok(ablation.accounting.totals.callCount > 0)
  assert.ok(ablation.accounting.totals.noncachedInput > 0)
  assert.ok(ablation.accounting.totals.output > 0)
  assert.ok(ablation.accounting.distribution.durationMs.p50 <= ablation.limits.maxP50DurationMs)
  assert.ok(ablation.accounting.distribution.durationMs.p95 <= ablation.limits.maxP95DurationMs)
  assert.ok(ablation.accounting.distribution.weightedCost.p50 <= ablation.limits.maxP50WeightedCost)
  assert.ok(ablation.accounting.distribution.weightedCost.p95 <= ablation.limits.maxP95WeightedCost)
  assert.deepEqual(Object.fromEntries(Object.entries(ablation.accountingByExpectedRoute).map(([route, accounting]) => [route, accounting.samples])), {
    DIRECT: 5, LIGHT: 3, ROADMAP: 2,
  })
  assert.equal(ablation.transcript.unusedBytes, 0)
  assert.equal(ablation.transcript.consumptionRatio, 1)
  assert.ok(ablation.observations.every(observation => observation.transcript.consumedBytes === observation.transcript.bytes))
})

test('r10 preregistration rejects a post-hoc subset, fewer than three repetitions, and a missing frozen commit', () => {
  const original = empirical.loadPreregistration(CONFIG)
  const subset = structuredClone(original)
  subset.cohort.taskIds.pop()
  subset.cohort.expectedTaskCount -= 1
  assert.throws(() => empirical.runLocalEmpiricalEvaluation({ repoRoot: ROOT, preregistration: subset }), error => error.code === 'EMPIRICAL_COHORT_MISMATCH')

  const underRepeated = structuredClone(original)
  underRepeated.repetitions = 2
  underRepeated.pairedOrders.pop()
  assert.throws(() => empirical.runLocalEmpiricalEvaluation({ repoRoot: ROOT, preregistration: underRepeated }), error => error.code === 'EMPIRICAL_PREREGISTRATION_INVALID')

  const unboundedCost = structuredClone(original)
  delete unboundedCost.analystAblation.limits.maxP95WeightedCost
  assert.throws(() => empirical.runLocalEmpiricalEvaluation({ repoRoot: ROOT, preregistration: unboundedCost }), error => error.code === 'EMPIRICAL_PREREGISTRATION_INVALID')

  const missingCommit = structuredClone(original)
  missingCommit.currentCommit = 'a'.repeat(40)
  assert.throws(() => empirical.runLocalEmpiricalEvaluation({ repoRoot: ROOT, preregistration: missingCommit }), error => error.code === 'EMPIRICAL_SOURCE_BINDING_INVALID')
})

test('r10 human-label machinery computes Cohen kappa, adjudicates every disagreement, and enforces pre-tuning freeze', () => {
  const tasks = [
    { id: 'holdout-a', groupId: 'bounded', variantKind: 'canonical', overrides: { requestedEffect: 'report' } },
    { id: 'holdout-b', groupId: 'connected', variantKind: 'canonical', overrides: { architectureImpact: 'multi-system' } },
    { id: 'holdout-c', groupId: 'coordinated', variantKind: 'canonical', overrides: { dependency: { shape: 'dependent-groups' } } },
  ]
  const development = [{ id: 'development-a', groupId: 'development', variantKind: 'canonical', overrides: { requestedEffect: 'research' } }]
  const taskBytes = Buffer.from(tasks.map(JSON.stringify).join('\n') + '\n')
  const developmentBytes = Buffer.from(development.map(JSON.stringify).join('\n') + '\n')
  const freeze = {
    schemaVersion: 'codex-route-label-freeze.v1',
    holdoutId: 'external-human-holdout',
    taskSetFrozenAt: '2026-08-20T00:00:00.000Z',
    labelSetFrozenAt: '2026-08-21T12:00:00.000Z',
    promptTuningStartedAt: '2026-08-22T00:00:00.000Z',
    fixtureRelativePath: 'external/independent-human-holdout.jsonl',
    taskSetSha256: empirical.sha256(taskBytes),
    developmentSetSha256: empirical.sha256(developmentBytes),
    implementationFingerprint: 'f'.repeat(64),
    frozenBeforePromptTuning: true,
  }
  const raters = [
    {
      raterId: 'rater-a', independentHumanAttestationSha256: 'a'.repeat(64),
      labeledAt: '2026-08-21T00:00:00.000Z',
      labels: [
        { id: 'holdout-a', route: 'DIRECT', reasons: ['bounded'] },
        { id: 'holdout-b', route: 'LIGHT', reasons: ['connected'] },
        { id: 'holdout-c', route: 'ROADMAP', reasons: ['coordination'] },
      ],
    },
    {
      raterId: 'rater-b', independentHumanAttestationSha256: 'b'.repeat(64),
      labeledAt: '2026-08-21T01:00:00.000Z',
      labels: [
        { id: 'holdout-a', route: 'DIRECT', reasons: ['bounded'] },
        { id: 'holdout-b', route: 'ROADMAP', reasons: ['two systems'] },
        { id: 'holdout-c', route: 'ROADMAP', reasons: ['coordination'] },
      ],
    },
  ]
  const adjudications = [{
    id: 'holdout-b', route: 'ROADMAP', adjudicatorId: 'adjudicator-c',
    adjudicatedAt: '2026-08-21T02:00:00.000Z',
    rationale: 'Two dependent systems require an integration owner.',
  }]
  const result = empirical.evaluateIndependentHumanLabels({ taskBytes, developmentBytes, freeze, raters, adjudications })

  assert.equal(result.readyForQualityClaims, true)
  assert.equal(result.agreement.metric, 'cohen-kappa')
  assert.equal(result.agreement.value, 0.5)
  assert.deepEqual(result.disagreementIds, ['holdout-b'])
  assert.deepEqual(result.rows.map(row => [row.id, row.expectedRoute]), [
    ['holdout-a', 'DIRECT'], ['holdout-b', 'ROADMAP'], ['holdout-c', 'ROADMAP'],
  ])
  assert.equal(result.provenance.developmentExamplesSeparated, true)
  assert.equal(result.provenance.tuningFreeze.frozenBeforePromptTuning, true)
  const readiness = routeHoldout.assessRouteHoldoutReadiness(result.provenance, Buffer.from(result.fixtureJsonl))
  assert.equal(readiness.readyForQualityClaims, true)
  assert.deepEqual(readiness.blockers, [])

  assert.throws(
    () => empirical.evaluateIndependentHumanLabels({ taskBytes, developmentBytes, freeze, raters, adjudications: [] }),
    error => error.code === 'HUMAN_LABEL_ADJUDICATION_INCOMPLETE',
  )
  const overlappingDevelopment = Buffer.from(`${JSON.stringify({ id: 'holdout-a', groupId: 'leaked', variantKind: 'canonical', overrides: {} })}\n`)
  const overlapFreeze = { ...freeze, developmentSetSha256: empirical.sha256(overlappingDevelopment) }
  assert.throws(
    () => empirical.evaluateIndependentHumanLabels({ taskBytes, developmentBytes: overlappingDevelopment, freeze: overlapFreeze, raters, adjudications }),
    error => error.code === 'HUMAN_LABEL_DEVELOPMENT_LEAKAGE',
  )
  const lateFreeze = { ...freeze, labelSetFrozenAt: '2026-08-22T01:00:00.000Z' }
  assert.throws(
    () => empirical.evaluateIndependentHumanLabels({ taskBytes, developmentBytes, freeze: lateFreeze, raters, adjudications }),
    error => error.code === 'HUMAN_LABEL_FREEZE_INVALID',
  )
})
