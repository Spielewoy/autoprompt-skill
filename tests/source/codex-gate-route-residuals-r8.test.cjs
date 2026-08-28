'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const H = value => crypto.createHash('sha256').update(value).digest('hex')
const route = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'route-decision.js'))
const records = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'run-record.js'))
const { selectWorkRecipe } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js'))

test('GATE-002 property: unsupported selector shapes are typed, total, unique, and reason-stable', () => {
  const invalidValues = [null, undefined, '', 'unknown', 0, false, {}, [], ['duplicate', 'duplicate']]
  const fields = ['baseWorkType', 'resultFormat', 'artifactOverlays', 'acceptanceOverlays', 'riskOverlays']
  for (const field of fields) {
    for (const invalid of invalidValues) {
      const input = {
        baseWorkType: 'debug-fix', resultFormat: 'changed-files',
        artifactOverlays: ['executable-code'], acceptanceOverlays: ['failing-to-passing-behavior'],
        riskOverlays: [], riskEvidence: {}, route: 'DIRECT',
        [field]: invalid,
      }
      const first = selectWorkRecipe(input)
      const second = selectWorkRecipe(structuredClone(input))
      assert.doesNotThrow(() => first)
      if (first.status === 'UNSUPPORTED_SHAPE') {
        assert.equal(first.reason.code, 'INVALID_GATE_SELECTION')
        assert.ok(first.reason.violations.length > 0)
        assert.deepEqual(first.reason, second.reason)
        assert.equal(new Set(first.reason.violations).size, first.reason.violations.length)
      } else {
        assert.equal(first.status, 'SUPPORTED')
      }
    }
  }
})

test('GATE-019 MISS cache identity binds the canonical route-schema digest', () => {
  const input = {
    axes: { deliverableKind: 'data-pipeline', targetLocus: 'in-repo' },
    acceptanceOverlays: ['unit-coverage', 'receipts'], riskOverlays: ['external-side-effect'],
  }
  const identity = route.createFrameworkMissCacheIdentity(input)
  const expectedDigest = H(JSON.stringify({
    routeDecision: route.ROUTE_DECISION_SCHEMA,
    routeRecommendation: route.CODEX_ROUTE_RECOMMENDATION_SCHEMA,
    routeContract: require(path.join(ROOT, 'agents', 'codex', 'workflow', 'router.js')).ROUTE_CONTRACT,
  }))
  assert.equal(identity.routeSchemaDigest, route.ROUTE_SCHEMA_DIGEST)
  assert.equal(identity.routeSchemaDigest, expectedDigest)
  assert.match(identity.routeSchemaDigest, /^[a-f0-9]{64}$/)
  assert.deepEqual(route.createFrameworkMissCacheIdentity(structuredClone(input)), identity)
  assert.notEqual(route.createFrameworkMissCacheIdentity({ ...input, riskOverlays: [] }).cacheKey, identity.cacheKey)
})

test('ROUTE-013 production safe degradation calls its evaluator and preserves its receipt', () => {
  let calls = 0
  const result = route.evaluateRouteEvent({
    event: 'CAPABILITY_LOST', currentRoute: 'LIGHT',
    evidence: [
      { kind: 'required', value: 'recursive transport', evidence_ref: 'runtime#required' },
      { kind: 'previous', value: 'recursive transport admitted', evidence_ref: 'runtime#previous' },
      { kind: 'failure', value: 'recursive transport lost', evidence_ref: 'runtime#failure' },
    ],
    degradedTransport: {
      mode: 'sequential-isolated', taskCapabilityPreserved: true,
      independencePreserved: true, acceptancePreserved: true,
    },
    safeDegradationEvaluator(candidate) {
      calls += 1
      return { accepted: candidate.acceptancePreserved, evaluator: 'production-evaluator', evaluationHash: H('evaluation') }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.status, 'CONTINUE_WITH_SAFE_DEGRADATION')
  assert.equal(result.degradation_evaluation.evaluator, 'production-evaluator')
})

test('GATE-023 production baseline binds route decision and populated existing tests', () => {
  const baseline = records.createProductionPreMutationBaseline({
    capturedBeforeMutation: true,
    routeDecision: { route: 'DIRECT', plannedChecks: ['node --test focused.test.cjs'] },
    targetStateHash: H('target'), environmentHash: H('environment'),
    dirtyTarget: { status: 'CLEAN', paths: [], snapshotHash: null },
    existingTests: [{ id: 'focused', command: 'node --test focused.test.cjs', exitCode: 1, status: 'FAIL', outputHash: H('red') }],
    fallback: null, nowMs: 0,
  })
  assert.equal(baseline.decisionBaseline.selection, 'EXISTING_TESTS')
  assert.deepEqual(baseline.decisionBaseline.selectedTestIds, ['focused'])
  assert.equal(records.validatePreMutationBaseline(baseline).valid, true)
})

test('GATE-030 P1 non-defect and advisory residual risk carry exact authority receipts', () => {
  const finding = {
    id: 'P1-accepted-non-defect', severity: 'P1', disposition: 'advisory',
    resolution: 'non-defect', evidenceIds: ['evidence:contract'],
  }
  assert.throws(() => route.createFindingDispositionDecision({ finding }),
    error => error.code === 'RESIDUAL_RISK_AUTHORITY_REQUIRED')
  const decision = route.createFindingDispositionDecision({
    finding,
    authorityReceipt: { authority: 'mission-owner', acceptedFindingIds: [finding.id], receiptHash: H('authority') },
  })
  assert.equal(decision.authorityReceipt.acceptedFindingIds[0], finding.id)
  assert.match(decision.decisionHash, /^[a-f0-9]{64}$/)
})

test('ROUTE-016/018 ALL_WORK_JOINED preserves six graph bindings and both verdicts', () => {
  const receipt = records.createAllWorkJoinedReceipt({
    graphBindings: Object.fromEntries(['mission', 'plan', 'candidate', 'environment', 'oracle', 'assumptions']
      .map(name => [`${name}Hash`, H(name)])),
    verdicts: [
      { kind: 'independent-review', status: 'PASS', verdictHash: H('review'), evidenceIds: ['review:evidence'] },
      { kind: 'independent-verification', status: 'PASS', verdictHash: H('verify'), evidenceIds: ['verify:evidence'] },
    ],
    nowMs: 0,
  })
  assert.equal(records.validateAllWorkJoinedReceipt(receipt).valid, true)
  const tampered = structuredClone(receipt)
  tampered.graphBindings.candidateHash = H('changed')
  assert.equal(records.validateAllWorkJoinedReceipt(tampered).valid, false)
})

test('GATE-010/024 shipped procedures use one ordinary verifier and conditional debug depth', () => {
  const frameworkRoot = path.join(ROOT, 'agents', 'contracts', 'frameworks')
  const doctrine = fs.readFileSync(path.join(frameworkRoot, 'README.md'), 'utf8')
  assert.match(doctrine, /one independent final verifier owns ordinary completeness/i)
  assert.match(doctrine, /extra independent-checking seat\s+requires a named distinct risk/i)
  for (const file of ['backend-fix.md', 'frontend-fix.md']) {
    const source = fs.readFileSync(path.join(frameworkRoot, file), 'utf8')
    assert.match(source, /reproduce.*implement.*verify/is)
    assert.match(source, /wrong-layer evidence.*repeated failure.*cross-module uncertainty/is)
    assert.doesNotMatch(source, /G1 PLAN\s*[→-]+\s*G3\.5 DEPTH-LOCK/i)
  }
})
