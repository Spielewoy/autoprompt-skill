#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const workflow = name => require(path.join(ROOT, 'agents', 'codex', 'workflow', name))
const decisions = workflow('route-decision.js')
const router = workflow('router.js')
const runRecord = workflow('run-record.js')
const { EventLog, sha256 } = workflow('event-log.js')
const { RuntimeStateStore, createEvidenceInvalidationGraph, executeEvidenceInvalidation } = workflow('runtime-state.js')
const H = label => crypto.createHash('sha256').update(label).digest('hex')

function temporary(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function stateHarness(t) {
  const directory = temporary(t, 'ap-route-gaps-')
  fs.mkdirSync(path.join(directory, 'runtime'))
  const binding = {
    runId: 'run-route-gaps', requestEnvelopeHash: H('request'), targetIdentity: 'target:route-gaps',
    openedDirectoryIdentity: 'opened:route-gaps',
    digests: { contract: H('contract'), prompt: H('prompt'), provider: H('provider'), tool: H('tool') },
  }
  const capability = Object.freeze({ opaque: true })
  const eventLog = new EventLog({ logPath: path.join(directory, 'runtime', 'events.jsonl'), binding })
  const store = new RuntimeStateStore({
    paths: {
      runRecordRoot: directory, statePath: path.join(directory, 'runtime', 'state.json'),
      eventPath: path.join(directory, 'runtime', 'events.jsonl'), terminalPath: path.join(directory, 'terminal.json'),
    },
    eventLog,
    capabilityVerifier: token => token === capability ? {
      runId: binding.runId, activationId: 'activation-route', missionHash: H('mission'),
      nonce: 'nonce_route_gaps_001', generation: 1, targetIdentity: binding.targetIdentity,
    } : null,
    randomId: () => 'permit-route-gaps',
  })
  store.create({
    ...binding, capability,
    activation: { id: 'activation-route', missionHash: H('mission'), nonce: 'nonce_route_gaps_001', sessionToken: 'session', generation: 1 },
  })
  return { capability, directory, store }
}

function advance(store, capability, stop = 'RUN_WORK') {
  const states = ['LOAD_SKILL', 'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'ACQUIRE_TARGET_LOCK',
    'SELECT_SAFE_RUN_ROOT', 'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES', 'START_ROUTE_ANALYST',
    'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION', 'PREPARE_WORK', 'RUN_WORK']
  for (const nextState of states) {
    store.transition(nextState, {
      capability, cause: `advance to ${nextState}`,
      ...(nextState === 'SAVE_ROUTE_ANALYSIS' ? { eventId: 'ROUTE_ANALYST_STARTED' } : {}),
    })
    if (nextState === stop) break
  }
}

test('route negatives reject boilerplate and analyst failures persist one resumable fallback', t => {
  const validation = decisions.validateRouteDecision({
    schemaVersion: '2.0.0', status: 'DECIDED', route: 'DIRECT', routeSource: 'automatic',
    requestEnvelopeHash: H('request'), recommendationHash: H('recommendation'), decidedAt: new Date().toISOString(),
    rejectedRouteReasons: { LIGHT: 'not appropriate', ROADMAP: 'not needed' },
  })
  assert.ok(validation.errors.some(error => /evidence-bearing reasons/.test(error)))

  const evaluated = decisions.evaluateRouteAnalystResult({
    elapsedMs: 130000, outcome: 'TIMEOUT', requestEnvelopeHash: H('request'),
    transcriptHash: H('transcript'), evidenceIndexHash: H('index'), nowMs: 0,
  })
  assert.equal(evaluated.status, 'ROUTE_ANALYST_TIMEOUT')
  assert.equal(decisions.validateRouteAnalystFallbackState(evaluated.recommendation_state).valid, true)
  const directory = temporary(t, 'ap-route-record-')
  const target = path.join(directory, 'target')
  fs.mkdirSync(target)
  const record = runRecord.createRunRecord({
    targetPath: target, canonicalProviderPrivateRoot: path.join(directory, 'private'), exactTree: true,
    runId: 'route-fallback-run', assertStartBoundary: false,
  })
  record.writeRouteAnalystFallbackState(evaluated.recommendation_state)
  assert.deepEqual(record.readRouteAnalystFallbackState(), evaluated.recommendation_state)
  assert.throws(() => record.writeRouteAnalystFallbackState(evaluated.recommendation_state), /already frozen/)
})

test('dirty-target existing-test baseline is immutable and no-test fallback is evidence-bound', t => {
  const directory = temporary(t, 'ap-baseline-')
  const target = path.join(directory, 'target')
  fs.mkdirSync(target)
  const record = runRecord.createRunRecord({
    targetPath: target, canonicalProviderPrivateRoot: path.join(directory, 'private'), exactTree: true,
    runId: 'baseline-route-run', assertStartBoundary: false,
  })
  const baseline = record.writePreMutationBaseline({
    capturedBeforeMutation: true, targetStateHash: H('target-state'), environmentHash: H('environment'),
    dirtyTarget: { status: 'DIRTY', paths: ['user-change.js'], snapshotHash: H('dirty-snapshot') },
    existingTests: [{ id: 'existing-focused', command: 'node --test existing.test.cjs', exitCode: 1, status: 'FAIL', outputHash: H('known-failure') }],
    fallback: null, nowMs: 0,
  })
  assert.deepEqual(record.readPreMutationBaseline(), baseline)
  assert.throws(() => record.writePreMutationBaseline(baseline), /already frozen/)
  assert.throws(() => runRecord.createPreMutationBaseline({
    capturedBeforeMutation: true, targetStateHash: H('x'), environmentHash: H('y'),
    dirtyTarget: { status: 'CLEAN', paths: [], snapshotHash: null }, existingTests: [], fallback: null,
  }), error => error.code === 'BASELINE_INVALID')
  assert.equal(runRecord.validatePreMutationBaseline(runRecord.createPreMutationBaseline({
    capturedBeforeMutation: true, targetStateHash: H('x'), environmentHash: H('y'),
    dirtyTarget: { status: 'CLEAN', paths: [], snapshotHash: null }, existingTests: [],
    fallback: { reason: 'NO_RELEVANT_EXISTING_TESTS', evidenceHash: H('no-tests'), observableChecks: ['inspect exact output'] },
  })).valid, true)
})

test('transitive graph, candidate freeze, item terminal, and CHECK_WORK mutation invalidate exactly dependent evidence and both verdicts', t => {
  const graph = createEvidenceInvalidationGraph({
    bindings: Object.fromEntries(['mission', 'plan', 'candidate', 'environment', 'oracle', 'assumptions'].map(id => [`${id}Hash`, H(id)])),
    evidence: [
      { id: 'candidate-proof', kind: 'evidence', hash: H('candidate-proof'), dependsOn: ['candidate', 'environment'] },
      { id: 'plan-only-proof', kind: 'evidence', hash: H('plan-proof'), dependsOn: ['plan'] },
    ],
    verdicts: [
      { id: 'reviewer-verdict', kind: 'verdict', hash: H('review-contract'), dependsOn: ['candidate-proof', 'plan-only-proof'] },
      { id: 'tester-verdict', kind: 'verdict', hash: H('test-contract'), dependsOn: ['candidate-proof'] },
    ],
  })
  const invalidation = executeEvidenceInvalidation(graph, { changedInputs: ['candidate'] })
  assert.deepEqual(invalidation.invalidatedEvidenceIds, ['candidate-proof'])
  assert.deepEqual(invalidation.invalidatedVerdictIds, ['reviewer-verdict', 'tester-verdict'])
  assert.deepEqual(invalidation.unaffectedIds, ['plan-only-proof'])

  const { capability, directory, store } = stateHarness(t)
  advance(store, capability)
  store.recordItemVerified({ itemId: 'work-1', resultHash: H('result'), versionHash: H('candidate'), checkHashes: [H('item-check')], capability, cause: 'item checks share version' })
  assert.equal(store.load().state, 'ITEM_VERIFIED')
  store.freezeCandidateForChecks({ candidateHash: H('candidate'), environmentHash: H('environment'), dependencyHash: H('dependencies'), evidenceGraph: graph, capability, cause: 'joined exact candidate' })
  store.recordIndependentVerdict({ verdictId: 'reviewer-verdict', verdictHash: H('review-pass'), capability, cause: 'review passed' })
  store.recordIndependentVerdict({ verdictId: 'tester-verdict', verdictHash: H('test-pass'), capability, cause: 'tests passed' })
  const deliverable = path.join(directory, 'result.txt')
  fs.writeFileSync(deliverable, 'before')
  store.beginAuthorizedMutation({
    capability, expectedEpoch: 0, cause: 'repair after checking',
    authority: { runId: 'run-route-gaps', activationId: 'activation-route', nonce: 'nonce_route_gaps_001', generation: 1 },
    preimages: [{ path: deliverable, hash: sha256(fs.readFileSync(deliverable)) }],
  })
  const mutated = store.load()
  assert.equal(mutated.candidateHash, null)
  assert.deepEqual(Object.fromEntries(Object.entries(mutated.assurance.verdicts).map(([id, value]) => [id, value.status])), {
    'reviewer-verdict': 'invalidated', 'tester-verdict': 'invalidated',
  })
})

test('budget exhaustion pauses with an exact frontier while authority waits resumably for the user', t => {
  const paused = stateHarness(t)
  advance(paused.store, paused.capability)
  paused.store.pauseForBudget({
    capability: paused.capability, cause: 'budget reserve reached',
    frontier: { resumeState: 'RUN_WORK', nextReadyWorkIds: ['work-2'], openCheckIds: [], acceptedResultIds: ['work-1'], remainingBudgetSeconds: 0, continuationBindingHash: H('continuation') },
  })
  assert.equal(paused.store.load().state, 'PAUSED')
  assert.equal(paused.store.load().activation.status, 'PAUSED')

  const waiting = stateHarness(t)
  advance(waiting.store, waiting.capability, 'L0_ROUTE_DECISION')
  waiting.store.waitForUser({ capability: waiting.capability, choice: 'Choose the public behavior.', artifactHash: H('saved-route'), cause: 'product choice required' })
  assert.equal(waiting.store.load().state, 'WAITING_USER')
  assert.equal(waiting.store.load().activation.status, 'WAITING_USER')
  assert.equal(waiting.store.load().terminal, null)
})

test('assurance seats follow risk rather than edit count and recursive loss degrades only through LIGHT', () => {
  const facts = overrides => ({
    schemaVersion: '2.0.0', requestedEffect: 'mutate', successCriteria: 'ready',
    dependency: { shape: 'bounded', dependentWorkGroupCount: 1, integrationOwnerRequired: false, separateDependentBodies: 1 },
    uncertainty: 'none', reversibility: 'fully-reversible',
    mutableResources: [{ kind: 'file', identity: 'a.js', shared: false, ownershipMode: 'single-owner' }],
    sideEffects: ['deliverable-write'], externality: 'local-only', confidentiality: 'internal', thirdPartyImpact: 'none',
    targetAuthorization: { targetIdentities: [], authorizedTargetIdentities: [], authorizationEvidenceHash: null },
    costAuthority: { mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0, approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null },
    riskAndIndependentCheckFloor: { level: 'ordinary', minimumCheckerCount: 1, namedDistinctResponsibilities: [] },
    checkAndBaseline: { checkQuality: 'authoritative', availableCheckKinds: ['focused-test'], baselineStatus: 'recorded', hiddenExternalCheck: false },
    capturedIncidentDomains: [],
    deadlineBudget: { remainingSeconds: 1200, admissionSeconds: 120, executionReserveSeconds: 600, verificationReserveSeconds: 240, recoveryAndFinalizationReserveSeconds: 120 },
    operatorMinimumRoute: null, transportCapability: { mode: 'native-recursive', taskCapabilityPreserved: true },
    candidateFreeze: { required: true, available: true, environmentCanBeBound: true }, missingUserInput: [],
    architectureImpact: 'local', fitsLightPlan: true, approachNeedsShortPlanning: false, shortOrderUnclear: false,
    ...overrides,
  })
  const oneLineAuth = decisions.selectIndependentChecking({ facts: facts({ sideEffects: ['deliverable-write', 'permission-change'] }) })
  const lowRiskMultiFile = decisions.selectIndependentChecking({ facts: facts({
    mutableResources: ['a.js', 'b.js', 'c.js'].map(identity => ({ kind: 'file', identity, shared: false, ownershipMode: 'single-owner' })),
  }) })
  assert.equal(oneLineAuth.checkerCount, 1)
  assert.match(oneLineAuth.responsibilities[0], /authorization/u)
  assert.equal(lowRiskMultiFile.checkerCount, 1)

  const evidence = [
    { kind: 'required-capability', value: 'recursive transport', evidence_ref: 'runtime#required' },
    { kind: 'previous-verification', value: 'recursive transport was admitted', evidence_ref: 'runtime#previous' },
    { kind: 'current-failure', value: 'recursive transport unavailable', evidence_ref: 'runtime#failure' },
  ]
  const safe = { mode: 'sequential-isolated', taskCapabilityPreserved: true, independencePreserved: true, acceptancePreserved: true }
  assert.equal(decisions.evaluateRouteEvent({ event: 'CAPABILITY_LOST', evidence, current_route: 'LIGHT', degraded_transport: safe }).status, 'CONTINUE_WITH_SAFE_DEGRADATION')
  const reclassified = decisions.evaluateRouteEvent({ event: 'CAPABILITY_LOST', evidence, current_route: 'ROADMAP', degraded_transport: safe })
  assert.equal(reclassified.status, 'RECLASSIFY_TO_LIGHT_REQUIRED')
  assert.equal(reclassified.route, 'LIGHT')
  assert.equal(decisions.evaluateRouteEvent({ event: 'CAPABILITY_LOST', evidence, current_route: 'DIRECT', degraded_transport: { ...safe, acceptancePreserved: false } }).status, 'PROVIDER_UNSUPPORTED')
})

test('repository instructions remain untrusted unless higher authority designates the exact artifact', () => {
  const artifact = { repositoryPath: 'docs/agent-instructions.md', contentHash: H('repository-bytes') }
  const ordinary = router.resolveRepositoryInstructionAuthority({ artifact })
  assert.equal(ordinary.status, 'UNTRUSTED_REPOSITORY_DATA')
  assert.equal(ordinary.maySupplyRouteFacts, false)

  const explicit = {
    schemaVersion: 1, designatedBy: 'request', repositoryPath: artifact.repositoryPath,
    contentHash: artifact.contentHash, purpose: 'Supply the named project acceptance rules.',
  }
  explicit.designationHash = router.repositoryAuthorityDesignationHash(explicit)
  const accepted = router.resolveRepositoryInstructionAuthority({ artifact, designation: explicit })
  assert.equal(accepted.status, 'EXPLICITLY_DESIGNATED_AUTHORITATIVE')
  assert.equal(accepted.authorityScope, 'exact-repository-artifact')
  assert.equal(accepted.maySupplyRouteFacts, true)
  assert.equal(accepted.mayOverrideHigherInstructions, false)

  const selfDesignated = { ...explicit, designatedBy: 'repository' }
  selfDesignated.designationHash = router.repositoryAuthorityDesignationHash(selfDesignated)
  assert.equal(router.resolveRepositoryInstructionAuthority({ artifact, designation: selfDesignated }).status,
    'REPOSITORY_DESIGNATION_INVALID')
  assert.equal(router.resolveRepositoryInstructionAuthority({
    artifact, designation: { ...explicit, contentHash: H('changed-repository-bytes') },
  }).authoritative, false)
})
