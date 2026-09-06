'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  FrameworkOrchestrationAuthority,
  assertDistinctEvidenceConsumption,
  createArtifactCoverageContract,
  createResidualRiskDisposition,
  evaluateRegressionDelta,
  planOverlayExecution,
  selectRuntimeGateTriggers,
  selectWorkRecipe,
  validateGeneratedFramework,
} = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js'))

function binding() {
  return {
    runId: 'gate-runtime-run', activationId: 'gate-runtime-activation', generation: 1,
    route: 'DIRECT', assignmentId: 'gate-runtime-assignment',
    findingIds: ['AP-GATE-019'], requirementHash: 'a'.repeat(64),
  }
}

function candidate() {
  return {
    schemaVersion: 1, frameworkId: 'generated-runtime-gate', route: 'DIRECT',
    checks: ['focused-behavior'], riskChecks: [],
    gateGraph: {
      graphId: 'generated-runtime-gate-graph', route: 'DIRECT',
      nodes: ['produce-candidate', 'independent-check'],
      edges: [['produce-candidate', 'independent-check']],
    },
  }
}

test('selector returns typed UNSUPPORTED_SHAPE(reason) and identical MISS consumes zero new compiler calls', async () => {
  const miss = selectWorkRecipe({ workType: 'unknown quantum artifact', route: 'DIRECT' })
  assert.equal(miss.status, 'UNSUPPORTED_SHAPE')
  assert.equal(typeof miss.reason.code, 'string')
  assert.ok(miss.reason.violations.length > 0)

  let durable = null
  let generated = 0
  let validated = 0
  const create = () => new FrameworkOrchestrationAuthority({
    binding: binding(),
    readState: () => durable && structuredClone(durable),
    writeState: state => { durable = structuredClone(state) },
    generate: async handoff => {
      generated += 1
      return {
        generatorIdentity: 'C0/framework-generator', generation: handoff.receipt.generation,
        assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
        candidate: candidate(),
      }
    },
    validate: async handoff => {
      validated += 1
      return {
        validatorIdentity: 'C0/independent-framework-validator', generation: handoff.receipt.generation,
        assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
        candidateHash: handoff.candidateHash, status: 'PASS', findings: [],
      }
    },
  })
  await create().run({ caller: 'deterministic-control-plane' })
  await create().run({ caller: 'deterministic-control-plane' })
  assert.deepEqual({ generated, validated }, { generated: 1, validated: 1 })
})

test('GATE-019 shared immutable descriptor cache is cross-run while admission remains current-run bound', async () => {
  let cached = null
  const runStates = new Map()
  let generated = 0
  let validated = 0
  const create = (runId, activationId, generation) => new FrameworkOrchestrationAuthority({
    binding: { ...binding(), runId, activationId, generation, assignmentId: `assignment:${runId}` },
    readState: () => runStates.get(runId) && structuredClone(runStates.get(runId)),
    writeState: state => runStates.set(runId, structuredClone(state)),
    readCache: () => cached && structuredClone(cached),
    writeCache: descriptor => { cached = structuredClone(descriptor) },
    generate: async handoff => {
      generated += 1
      return {
        generatorIdentity: 'C0/framework-generator', generation: handoff.receipt.generation,
        assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
        candidate: candidate(),
      }
    },
    validate: async handoff => {
      validated += 1
      return {
        validatorIdentity: 'C0/independent-framework-validator', generation: handoff.receipt.generation,
        assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
        candidateHash: handoff.candidateHash, status: 'PASS', findings: [],
      }
    },
  })
  await create('run-one', 'activation-one', 1).run({ caller: 'deterministic-control-plane' })
  const second = await create('run-two', 'activation-two', 4).run({ caller: 'deterministic-control-plane' })
  assert.deepEqual({ generated, validated }, { generated: 1, validated: 1 })
  assert.equal(second.status, 'ADMITTED')
  assert.equal(runStates.get('run-two').binding.runId, 'run-two')
  assert.equal(runStates.get('run-two').cacheAdmissionReceipt.activationId, 'activation-two')
  assert.equal(runStates.get('run-two').cacheAdmissionReceipt.generation, 4)

  const original = cached
  cached = { ...original, candidateHash: 'f'.repeat(64) }
  await assert.rejects(
    create('run-three', 'activation-three', 1).run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_CACHE_INVALID',
  )
  cached = { ...original, cacheKey: 'e'.repeat(64) }
  await assert.rejects(
    create('run-four', 'activation-four', 1).run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_CACHE_INVALID',
  )
})

test('ordinary final verification rejects duplicate underlying evidence even under different oracle labels', () => {
  assert.throws(
    () => assertDistinctEvidenceConsumption([
      { checkerId: 'review', oracleId: 'requirements', evidenceIds: ['same-run-output'] },
      { checkerId: 'test', oracleId: 'behavior', evidenceIds: ['same-run-output'] },
    ]),
    error => error.code === 'DUPLICATE_UNDERLYING_EVIDENCE',
  )
  assert.equal(assertDistinctEvidenceConsumption([
    { checkerId: 'review', oracleId: 'requirements', evidenceIds: ['plan-diff'] },
    { checkerId: 'test', oracleId: 'behavior', evidenceIds: ['fresh-test-run'] },
  ]).valid, true)
})

test('generated validator enforces registry, terminal, order, command, oracle, risk, and bounded negative paths', () => {
  const malformed = {
    ...candidate(),
    riskChecks: ['named-risk-check'],
    gateGraph: {
      graphId: 'generated-runtime-gate-graph', route: 'DIRECT',
      nodes: ['produce-candidate', 'independent-check', 'fresh-verify'],
      edges: [['produce-candidate', 'independent-check'], ['independent-check', 'fresh-verify']],
    },
    gateRegistry: { gateIds: ['produce-candidate'], terminalGateId: 'independent-check' },
    gateOrder: ['independent-check', 'produce-candidate'],
    commandBindings: [], oracleBindings: [], riskTriggers: [], negativePaths: [],
  }
  const verdict = validateGeneratedFramework(malformed, { route: 'DIRECT' })
  assert.equal(verdict.valid, false)
  for (const fragment of ['registry', 'terminal', 'order', 'command', 'acceptance-check', 'bounded negative']) {
    assert.ok(verdict.errors.some(error => error.includes(fragment)), fragment)
  }
  assert.ok(verdict.errors.some(error => /independent recheck cannot duplicate/i.test(error)))
})

test('runtime gate plan has executable coverage, no-new-regression, conditional depth/docs/performance, and same-file handoff', () => {
  const coverage = createArtifactCoverageContract(['executable-code', 'documentation'])
  assert.deepEqual(coverage.executable.denominator, ['changed-executable-lines', 'changed-executable-branches'])
  assert.equal(coverage.artifacts.denominator, 'required-artifact-oracles')

  assert.deepEqual(evaluateRegressionDelta(
    [{ id: 'existing', status: 'FAIL', fingerprint: 'known' }],
    [{ id: 'existing', status: 'FAIL', fingerprint: 'known' }],
  ), { valid: true, newRegressions: [], preExistingFailures: ['existing'] })

  const debug = selectRuntimeGateTriggers({
    baseWorkType: 'debug-fix', artifactOverlays: ['executable-code'], riskOverlays: [],
  }, { wrongLayerEvidence: true })
  assert.equal(debug.depthProber.required, true)
  assert.equal(selectRuntimeGateTriggers({
    baseWorkType: 'debug-fix', artifactOverlays: ['executable-code'], riskOverlays: [],
  }, {}).depthProber.required, false)
  const docs = selectRuntimeGateTriggers({
    baseWorkType: 'review-polish', artifactOverlays: ['documentation'],
    riskOverlays: ['performance-or-service-level'],
  }, { audienceUnresolved: true })
  assert.equal(docs.documentationPlanning.required, true)
  assert.equal(docs.performance.required, true)

  const handoff = planOverlayExecution([
    { id: 'implementation', owner: 'worker-1', resources: ['app.js'], after: [] },
    { id: 'polish', owner: 'worker-2', resources: ['app.js'], after: ['implementation'] },
  ])
  assert.equal(handoff.status, 'SUPPORTED')
  assert.deepEqual(handoff.handoffs, [{ resource: 'app.js', from: 'worker-1', to: 'worker-2', after: 'implementation', before: 'polish' }])
})

test('advisory findings need an exact authority receipt while blocking findings cannot be waived', () => {
  assert.throws(
    () => createResidualRiskDisposition({
      findings: [{ id: 'F-1', disposition: 'advisory' }],
      authorityReceipt: { authority: 'owner', acceptedFindingIds: [], receiptHash: 'b'.repeat(64) },
    }),
    error => error.code === 'RESIDUAL_RISK_AUTHORITY_REQUIRED',
  )
  assert.throws(
    () => createResidualRiskDisposition({
      findings: [{ id: 'F-0', disposition: 'blocking' }],
      authorityReceipt: { authority: 'owner', acceptedFindingIds: ['F-0'], receiptHash: 'b'.repeat(64) },
    }),
    error => error.code === 'BLOCKING_FINDING_OPEN',
  )
})
