'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const evidence = require(path.join(ROOT, 'scripts', 'benchmark-evidence'))

function write(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, bytes)
}

function git(repo, argv) {
  const result = childProcess.spawnSync('git', argv, { cwd: repo, encoding: 'utf8', windowsHide: true, shell: false })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function temporaryRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-mechanism-test-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  git(repo, ['init', '--quiet'])
  git(repo, ['config', 'user.name', 'Mechanism Fixture'])
  git(repo, ['config', 'user.email', 'mechanism@example.invalid'])
  write(path.join(repo, 'marker.txt'), 'baseline\n')
  git(repo, ['add', 'marker.txt'])
  git(repo, ['commit', '--quiet', '-m', 'baseline'])
  const baselineSha = git(repo, ['rev-parse', 'HEAD'])
  write(path.join(repo, 'marker.txt'), 'candidate\n')
  git(repo, ['add', 'marker.txt'])
  git(repo, ['commit', '--quiet', '-m', 'candidate'])
  const candidateSha = git(repo, ['rev-parse', 'HEAD'])
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'codex-low-compute-v1'), path.join(repo, 'fixture'), { recursive: true })
  write(path.join(repo, 'blocker.md'), 'PROVIDER_UNSUPPORTED provider=codex reason=codex-command-sandbox-network-open\n')
  return { repo, baselineSha, candidateSha }
}

function definition() {
  const value = structuredClone(require('./autoprompt-benchmark.json'))
  value.task.fixtureDir = 'fixture/task'
  for (const arm of value.arms) arm.runner = 'fixture/deterministic-arm.cjs'
  value.realCodex.evidencePath = 'blocker.md'
  return value
}

test('one-task three-arm Codex mechanism canary is commit-bound, isolated, focused, and deterministic', t => {
  const fixture = temporaryRepo(t)
  const options = { repoRoot: fixture.repo, definition: definition(), baselineSha: fixture.baselineSha, candidateSha: fixture.candidateSha, generatedAt: '2026-08-22T12:00:00.000Z' }
  const first = evidence.runMechanismCanary(options)
  const second = evidence.runMechanismCanary(options)
  assert.deepEqual(second, first)
  assert.equal(first.mechanismVerified, true)
  assert.equal(first.provider, 'codex')
  assert.equal(first.qualityClaimEligible, false)
  assert.equal(first.comparisonClaimEligible, false)
  assert.notEqual(first.task.baselineFocusedCheck.exitCode, 0)
  assert.deepEqual(first.attempts.map(attempt => [attempt.armId, attempt.role, attempt.sourceSha, attempt.terminalState]), [
    ['base', 'single-agent-base', fixture.baselineSha, 'PASS'],
    ['current', 'frozen-current-autoprompt', fixture.baselineSha, 'PASS'],
    ['redesign', 'codex-redesign', fixture.candidateSha, 'PASS'],
  ])
  assert.ok(first.attempts.every(attempt => attempt.executionKind === 'deterministic-fixture-runner'))
  assert.ok(first.attempts.every(attempt => attempt.sourceBinding === 'declared-existing-commit-not-executed'))
  assert.ok(first.attempts.every(attempt => attempt.focusedCheck.exitCode === 0))
  assert.deepEqual(first.realCodex, {
    status: 'BLOCKED', phase: 'pre-route', code: 'PROVIDER_UNSUPPORTED', reason: 'codex-command-sandbox-network-open',
    evidencePath: 'blocker.md', evidenceSha256: evidence.sha256('PROVIDER_UNSUPPORTED provider=codex reason=codex-command-sandbox-network-open\n'),
    observationKind: 'carried-forward-not-rerun',
  })
})

test('mechanism canary fails closed on provider drift, unbound commits, stale blockers, and failed focused checks', t => {
  const fixture = temporaryRepo(t)
  const common = { repoRoot: fixture.repo, definition: definition(), baselineSha: fixture.baselineSha, candidateSha: fixture.candidateSha, generatedAt: '2026-08-22T12:00:00.000Z' }
  const wrongProvider = definition(); wrongProvider.provider = 'claude'
  assert.throws(() => evidence.runMechanismCanary({ ...common, definition: wrongProvider }), error => error.code === 'MECHANISM_PROVIDER_INVALID')
  assert.throws(() => evidence.runMechanismCanary({ ...common, candidateSha: fixture.baselineSha }), error => error.code === 'MECHANISM_COMMIT_INVALID')
  assert.throws(() => evidence.runMechanismCanary({ ...common, candidateSha: 'a'.repeat(40) }), error => error.code === 'MECHANISM_COMMIT_INVALID')
  const missingFixture = definition(); missingFixture.task.fixtureDir = 'missing/task'
  assert.throws(() => evidence.runMechanismCanary({ ...common, definition: missingFixture }), error => error.code === 'MECHANISM_FIXTURE_INVALID' && error.details.cause === 'ENOENT')
  write(path.join(fixture.repo, 'blocker.md'), 'not the observed blocker\n')
  assert.throws(() => evidence.runMechanismCanary(common), error => error.code === 'MECHANISM_REAL_CODEX_INVALID')
  write(path.join(fixture.repo, 'blocker.md'), 'PROVIDER_UNSUPPORTED provider=codex reason=codex-command-sandbox-network-open\n')
  write(path.join(fixture.repo, 'fixture', 'no-op.cjs'), "'use strict'\n")
  const failing = definition(); failing.arms[2].runner = 'fixture/no-op.cjs'
  const result = evidence.runMechanismCanary({ ...common, definition: failing })
  assert.equal(result.mechanismVerified, false, JSON.stringify(result.attempts[2]))
  assert.equal(result.attempts[2].terminalState, 'FAIL', JSON.stringify(result.attempts[2]))
})

test('route holdout provenance exposes synthetic labels and blocks quality claims until human evidence exists', () => {
  const fixtureBytes = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'codex-route-holdout-v2.jsonl'))
  const provenance = require('../fixtures/codex-route-holdout-v2.provenance.json')
  const rows = evidence.parseRows(fixtureBytes)
  assert.ok(rows.every(row => Array.isArray(row.expectedReasons) && row.expectedReasons.length > 0 &&
    row.expectedReasons.every(reason => typeof reason === 'string' && reason.trim())))
  const readiness = evidence.assessRouteHoldoutReadiness(provenance, fixtureBytes)
  assert.equal(readiness.readyForQualityClaims, false)
  assert.deepEqual(readiness.blockers, [
    'DEVELOPMENT_EXAMPLES_NOT_SEPARATED',
    'INDEPENDENT_HUMAN_LABELS_REQUIRED',
    'MULTIPLE_INDEPENDENT_RATERS_REQUIRED',
    'INTER_RATER_AGREEMENT_REQUIRED',
    'ADJUDICATION_EVIDENCE_REQUIRED',
    'PRE_TUNING_FREEZE_EVIDENCE_REQUIRED',
  ])
  const tampered = Buffer.concat([fixtureBytes, Buffer.from('\n')])
  assert.throws(() => evidence.assessRouteHoldoutReadiness(provenance, tampered), error => error.code === 'HOLDOUT_FIXTURE_MISMATCH')
  const dishonest = structuredClone(provenance)
  dishonest.labels.independentlyHumanLabeled = true
  assert.throws(() => evidence.validateProvenance(dishonest, fixtureBytes), error => error.code === 'HOLDOUT_PROVENANCE_INVALID')
  const wrongSource = structuredClone(provenance)
  wrongSource.labels.sourceKind = 'independent-human'
  wrongSource.labels.independentlyHumanLabeled = true
  wrongSource.labels.raterCount = 2
  wrongSource.labels.agreement = { metric: 'cohen-kappa', value: 1, evidenceSha256: 'a'.repeat(64) }
  wrongSource.labels.adjudicationEvidenceSha256 = 'b'.repeat(64)
  assert.throws(() => evidence.validateProvenance(wrongSource, fixtureBytes), error => error.code === 'HOLDOUT_LABEL_SOURCE_MISMATCH')
  const incompleteHuman = structuredClone(provenance)
  incompleteHuman.labels = { sourceKind: 'independent-human', independentlyHumanLabeled: true, raterCount: 1, agreement: { metric: null, value: null, evidenceSha256: null }, adjudicationEvidenceSha256: null }
  assert.throws(() => evidence.validateProvenance(incompleteHuman, fixtureBytes), error => error.code === 'HOLDOUT_PROVENANCE_INVALID')
  const malformedContrast = `${fixtureBytes.toString('utf8').trim()}\n${JSON.stringify({ id: 'bad-contrast', labelSource: 'synthetic-design-fixture', groupId: 'bad', contrastGroupId: 123, variantKind: 'canonical', expectedRoute: 'DIRECT', overrides: {} })}\n`
  assert.throws(() => evidence.parseRows(malformedContrast), error => error.code === 'HOLDOUT_ROWS_INVALID')
  const missingReasons = rows.map(row => ({ ...row }))
  delete missingReasons[0].expectedReasons
  assert.throws(() => evidence.parseRows(missingReasons.map(JSON.stringify).join('\n')), error => error.code === 'HOLDOUT_ROWS_INVALID')
})

test('route holdout scores costly routing errors and analyst value without promoting synthetic labels', () => {
  const fixtureBytes = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'codex-route-holdout-v2.jsonl'))
  const provenance = require('../fixtures/codex-route-holdout-v2.provenance.json')
  const rows = evidence.parseRows(fixtureBytes)
  const predictions = rows.map(row => ({ id: row.id, predictedRoute: row.expectedRoute }))
  predictions.find(item => item.id === 'h01-bounded-report').predictedRoute = 'ROADMAP'
  predictions.find(item => item.id === 'h08-dependent-groups').predictedRoute = 'DIRECT'
  const score = evidence.scoreRoutePredictions(provenance, fixtureBytes, predictions)
  assert.equal(score.qualityClaimEligible, false)
  assert.equal(score.analysisClass, 'development-mechanics-only')
  assert.deepEqual(score.summary.underRouting, { count: 1, cost: 4 })
  assert.deepEqual(score.summary.overRouting, { count: 1, cost: 2 })
  assert.equal(score.summary.totalErrorCost, 6)
  assert.equal(score.confusion.DIRECT.ROADMAP, 1)
  assert.equal(score.confusion.ROADMAP.DIRECT, 1)
  assert.ok(score.rows.every(row => Array.isArray(row.expectedReasons) && row.expectedReasons.length > 0))
  assert.equal(score.checksum, evidence.digestRecord(score, ['checksum']))

  const observations = rows.map((row, index) => {
    const transcript = `analyst evidence for ${row.id}`
    return {
      id: row.id,
      withoutAnalystRoute: index === 0 ? 'LIGHT' : row.expectedRoute,
      withAnalystRoute: row.expectedRoute,
      accounting: {
        sessionCount: 1, callCount: 1, durationMs: 100 + index,
        noncachedInput: 10 + index, cachedInput: 2, output: 3, reasoning: 1, weightedCost: 0.1 + (index / 100),
      },
      transcript: { sha256: evidence.sha256(transcript), bytes: Buffer.byteLength(transcript), consumedBytes: 8, citedItemCount: 1 },
    }
  })
  const limits = { maxP50WeightedCost: 1, maxP95WeightedCost: 1, maxP50DurationMs: 1000, maxP95DurationMs: 1000 }
  const report = evidence.evaluateRouteAnalystAblation(provenance, fixtureBytes, observations, limits)
  assert.equal(report.qualityClaimEligible, false)
  assert.equal(report.releaseGateReady, false)
  assert.equal(report.routeCoverageComplete, true)
  assert.equal(report.costWithinLimits, true)
  assert.equal(report.value.errorsCorrected, 1)
  assert.equal(report.value.errorsRegressed, 0)
  assert.equal(report.value.netErrorCostAvoided, 1)
  assert.ok(report.value.netErrorCostAvoidedPerWeightedCost > 0)
  assert.ok(report.transcript.consumedBytes > 0)
  assert.ok(report.accountingByExpectedRoute.DIRECT.samples > 0)
  assert.ok(report.accountingByExpectedRoute.LIGHT.samples > 0)
  assert.ok(report.accountingByExpectedRoute.ROADMAP.samples > 0)
  assert.equal(report.checksum, evidence.digestRecord(report, ['checksum']))
  assert.deepEqual(report.blockers, evidence.assessRouteHoldoutReadiness(provenance, fixtureBytes).blockers)

  const missing = observations.slice(1)
  assert.throws(() => evidence.evaluateRouteAnalystAblation(provenance, fixtureBytes, missing, limits), error => error.code === 'HOLDOUT_ANALYST_OBSERVATIONS_INVALID')
  const duplicate = [...observations, observations[0]]
  assert.throws(() => evidence.evaluateRouteAnalystAblation(provenance, fixtureBytes, duplicate, limits), error => error.code === 'HOLDOUT_ANALYST_OBSERVATIONS_INVALID')
  const unboundTranscript = structuredClone(observations)
  unboundTranscript[0].transcript.citedItemCount = 0
  assert.throws(() => evidence.evaluateRouteAnalystAblation(provenance, fixtureBytes, unboundTranscript, limits), error => error.code === 'HOLDOUT_ANALYST_TRANSCRIPT_INVALID')
  const duplicateSession = structuredClone(observations)
  duplicateSession[0].accounting.sessionCount = 2
  assert.throws(() => evidence.evaluateRouteAnalystAblation(provenance, fixtureBytes, duplicateSession, limits), error => error.code === 'HOLDOUT_ANALYST_ACCOUNTING_INVALID')
  const tight = evidence.evaluateRouteAnalystAblation(provenance, fixtureBytes, observations, { ...limits, maxP50WeightedCost: 0, maxP95WeightedCost: 0 })
  assert.equal(tight.costWithinLimits, false)
  assert.ok(tight.blockers.includes('ANALYST_COST_LIMIT_EXCEEDED'))
})
