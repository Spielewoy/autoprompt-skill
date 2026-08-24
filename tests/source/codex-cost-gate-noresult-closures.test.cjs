'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const PHASE_PATH = path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js')
const {
  RolePolicy,
  admitCodexRoleSelection,
  selectWorkRecipe,
  validateGeneratedFramework,
} = require(PHASE_PATH)
const router = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'router.js'))
const { CleanupRegistry, Finalizer } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'finalizer.js'))
const { assertPublicationReady } = require(path.join(ROOT, 'scripts', 'benchmark-evidence', 'spool.cjs'))

const H = value => crypto.createHash('sha256').update(value).digest('hex')

function routeFacts(overrides = {}) {
  return {
    schemaVersion: '2.0.0',
    requestedEffect: 'mutate',
    successCriteria: 'ready',
    dependency: {
      shape: 'bounded', dependentWorkGroupCount: 1,
      integrationOwnerRequired: false, separateDependentBodies: 1,
    },
    uncertainty: 'none',
    reversibility: 'fully-reversible',
    mutableResources: [{
      kind: 'file', identity: 'src/owned.js', shared: false, ownershipMode: 'single-owner',
    }],
    sideEffects: ['deliverable-write'],
    externality: 'local-only',
    confidentiality: 'internal',
    thirdPartyImpact: 'none',
    targetAuthorization: {
      targetIdentities: [], authorizedTargetIdentities: [], authorizationEvidenceHash: null,
    },
    costAuthority: {
      mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0,
      approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null,
    },
    riskAndIndependentCheckFloor: {
      level: 'ordinary', minimumCheckerCount: 1, namedDistinctResponsibilities: [],
    },
    checkAndBaseline: {
      checkQuality: 'authoritative', availableCheckKinds: ['focused-test'],
      baselineStatus: 'recorded', hiddenExternalCheck: false,
    },
    capturedIncidentDomains: [],
    deadlineBudget: {
      remainingSeconds: 1200, admissionSeconds: 120, executionReserveSeconds: 600,
      verificationReserveSeconds: 240, recoveryAndFinalizationReserveSeconds: 120,
    },
    operatorMinimumRoute: null,
    transportCapability: { mode: 'native-recursive', taskCapabilityPreserved: true },
    candidateFreeze: { required: true, available: true, environmentCanBeBound: true },
    missingUserInput: [],
    architectureImpact: 'local',
    fitsLightPlan: true,
    approachNeedsShortPlanning: false,
    shortOrderUnclear: false,
    ...overrides,
  }
}

function compilePrivatePhaseExports(names) {
  const source = fs.readFileSync(PHASE_PATH, 'utf8')
  const local = new Module(`${PHASE_PATH}:focused-private-exports`, module)
  local.filename = PHASE_PATH
  local.paths = Module._nodeModulePaths(path.dirname(PHASE_PATH))
  local._compile(`${source}\nmodule.exports.__focusedPrivate = { ${names.join(', ')} }\n`, PHASE_PATH)
  return local.exports.__focusedPrivate
}

test('AP-COST-013 governance finalization uses zero model sessions and deterministic terminal cleanup', async t => {
  const rolePolicy = new RolePolicy()
  let modelSessions = 0
  for (const child of ['scribe', 'janitor']) {
    assert.throws(() => admitCodexRoleSelection({
      rolePolicy,
      selection: { parent: 'run-owner', child, route: 'ROADMAP' },
      createChildSession() { modelSessions += 1 },
    }), error => error.code === 'ROLE_POLICY_DENIED')
  }
  assert.equal(modelSessions, 0)

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cost-013-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const runRoot = path.join(temporary, 'run-record')
  const scratch = path.join(temporary, 'scratch', 'owned')
  const terminalPath = path.join(runRoot, 'terminal.json')
  fs.mkdirSync(runRoot, { recursive: true })
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'temporary.txt'), 'remove deterministically\n')

  const cleanupRegistry = new CleanupRegistry({
    registryPath: path.join(runRoot, 'cleanup.json'),
    allowedRoots: [temporary],
    controlBinding: { activationId: 'cost-013-activation', generationId: 1 },
    clock: () => '2026-08-24T00:00:00.000Z',
    randomId: () => 'cost-013-scratch',
  })
  cleanupRegistry.register({ path: scratch, owner: 'deterministic-control-plane' })

  const terminalEvent = {
    sequence: 1, type: 'RELEASE_INTENT', hash: H('cost-013-release-intent'),
  }
  const terminal = {
    outcome: 'PARTIAL', runId: 'cost-013-run', activationId: 'cost-013-activation',
    generation: 1, sequence: 1, missionHash: H('cost-013-mission'),
    requestEnvelopeHash: H('cost-013-request'), workspaceEpoch: 0,
    deliverableManifestHash: H('[]'), deliverableManifest: [], producedEvidenceHashes: [],
    terminalEnvelope: null,
    releaseIntent: { eventSequence: 1, eventId: 'RELEASE_INTENT' },
  }
  let state = { state: 'FINALIZING', workspaceEpoch: 0, terminal: null }
  let bindCalls = 0
  const stateStore = {
    registeredPaths: { runRecordRoot: runRoot, terminalPath },
    eventLog: { readAll: () => [terminalEvent] },
    load: () => state,
    bindTerminal() {
      bindCalls += 1
      state = { ...state, state: 'RELEASING_LOCK', terminal }
      return state
    },
    validateTerminal: () => ({ valid: true }),
    prepareReleaseReconciliation: () => ({ hash: H('cost-013-release') }),
    completeReleasedTerminal(outcome) {
      state = { ...state, state: outcome }
      return state
    },
  }
  let active = true
  const missionLock = {
    describe: () => ({
      status: active ? 'ACTIVE' : 'RELEASED',
      owner: { targetKey: 'cost-013-target', ownedProcessHistory: [] },
    }),
    assertOwned: () => assert.equal(active, true),
    updateOwnedProcesses: () => true,
    release: () => { active = false },
    assertReleased: () => assert.equal(active, false),
  }
  const finalizer = new Finalizer({
    stateStore,
    processOwner: {
      ownershipIdentities: () => [], cancelAll: async () => [], assertTargetDrained: async () => true,
    },
    missionLock,
    capability: { activationId: 'cost-013-activation' },
    cleanupRegistry,
    clock: () => '2026-08-24T00:00:01.000Z',
  })
  const result = await finalizer.finalize({ outcome: 'PARTIAL', expectedEpoch: 0 })
  assert.equal(result.state.state, 'PARTIAL')
  assert.equal(bindCalls, 1)
  assert.equal(fs.existsSync(scratch), false)
  assert.equal(fs.existsSync(terminalPath), true)
  assert.deepEqual(cleanupRegistry.load().entries.map(entry => entry.status), ['CLEANED'])
})

test('AP-COST-017 unsupported economic claims stay withdrawn and publication defaults closed', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /currently makes no reproducible performance or cost-reduction claim/i)
  assert.match(readme, /signed aggregate report before publication/i)
  assert.doesNotMatch(readme, /(?:approximately|about|~)\s*3\s*[x×].{0,40}(?:time|faster)/i)
  assert.doesNotMatch(readme, /(?:approximately|about|~)\s*2\s*[x×].{0,40}tokens?/i)
  assert.throws(
    () => assertPublicationReady({}),
    error => error.code === 'PUBLICATION_BLOCKED' &&
      ['AGGREGATE_SIGNATURE_INVALID', 'AGGREGATE_EVIDENCE_INVALID', 'COST_PER_ACCEPTED_SOLVE_MISSING']
        .every(blocker => error.details.blockers.includes(blocker)),
  )
})

test('AP-GATE-013 generated validation has one independent validator and rejects duplicate fresh verification', () => {
  const candidate = {
    schemaVersion: 1,
    frameworkId: 'gate-013-generated',
    route: 'DIRECT',
    checks: ['focused-acceptance'],
    riskChecks: [],
    gateGraph: {
      graphId: 'gate-013-direct', route: 'DIRECT',
      nodes: ['produce-candidate', 'independent-check'],
      edges: [['produce-candidate', 'independent-check']],
    },
  }
  const accepted = validateGeneratedFramework(candidate, { route: 'DIRECT' })
  assert.equal(accepted.valid, true)
  assert.equal(accepted.candidate.assurance.independentValidatorGateId, 'independent-check')
  assert.equal(accepted.candidate.assurance.generatedFreshVerifyAfterValidator, false)

  const duplicated = structuredClone(candidate)
  duplicated.gateGraph.nodes.push('fresh-verify')
  duplicated.gateGraph.edges.push(['independent-check', 'fresh-verify'])
  const rejected = validateGeneratedFramework(duplicated, { route: 'DIRECT' })
  assert.equal(rejected.valid, false)
  assert.ok(rejected.errors.some(error => /fresh-verify cannot duplicate/i.test(error)))
})

test('AP-GATE-022 decision-free mechanical work is DIRECT without an explicit edit list; uncertainty is LIGHT', () => {
  const recipe = selectWorkRecipe({
    baseWorkType: 'mechanical-change',
    resultFormat: 'changed-files',
    artifactOverlays: ['executable-code'],
    acceptanceOverlays: ['exact-diff'],
    riskOverlays: [],
    riskEvidence: {},
    route: 'DIRECT',
  })
  assert.equal(recipe.status, 'SUPPORTED')
  assert.equal(Object.hasOwn(recipe.selection, 'editList'), false)
  assert.equal(Object.hasOwn(recipe.selection, 'knownLocation'), false)
  assert.equal(recipe.gateGraph.order.includes('short-plan'), false)
  assert.equal(router.classifyRoute(routeFacts()).route, 'DIRECT')
  assert.equal(router.classifyRoute(routeFacts({
    uncertainty: 'reversible-technical', approachNeedsShortPlanning: true,
  })).route, 'LIGHT')
})

test('AP-GATE-025 bounded refactor is DIRECT after characterization; unresolved reshape alone adds LIGHT planning', () => {
  const direct = selectWorkRecipe({ workType: 'refactor', route: 'DIRECT' })
  const light = selectWorkRecipe({ workType: 'refactor', route: 'LIGHT' })
  assert.equal(direct.status, 'SUPPORTED')
  assert.ok(direct.checks.includes('behavior-preservation'))
  assert.equal(direct.gateGraph.order.includes('short-plan'), false)
  assert.equal(light.gateGraph.order.includes('short-plan'), true)
  assert.equal(router.classifyRoute(routeFacts()).route, 'DIRECT')
  assert.equal(router.classifyRoute(routeFacts({
    dependency: {
      shape: 'connected', dependentWorkGroupCount: 1,
      integrationOwnerRequired: false, separateDependentBodies: 1,
    },
    approachNeedsShortPlanning: true,
  })).route, 'LIGHT')

  const procedure = fs.readFileSync(path.join(ROOT, 'agents', 'contracts', 'frameworks', 'refactor.md'), 'utf8')
  assert.match(procedure, /characterization directly to\s+G4/i)
  assert.match(procedure, /Conditional PLAN the reshape/i)
})

test('AP-GATE-029 framework MISS uses the deterministic compiler and cannot launch legacy generator models', async () => {
  let modelSessions = 0
  for (const child of ['framework-generator', 'framework-validator', 'ap-framework-generator', 'ap-framework-validator']) {
    assert.throws(() => admitCodexRoleSelection({
      rolePolicy: new RolePolicy(),
      selection: { parent: 'run-owner', child, route: 'DIRECT' },
      createChildSession() { modelSessions += 1 },
    }), error => error.code === 'ROLE_POLICY_DENIED')
  }
  assert.equal(modelSessions, 0)

  const { deterministicFrameworkGenerator, deterministicFrameworkValidator } = compilePrivatePhaseExports([
    'deterministicFrameworkGenerator', 'deterministicFrameworkValidator',
  ])
  const receipt = {
    requirementHash: H('gate-029-requirement'), generation: 1,
    assignmentId: 'gate-029-assignment', findingIds: ['AP-GATE-029'], route: 'DIRECT',
  }
  const handoff = { receipt, attempt: 1, repairFindingIds: [] }
  const first = await deterministicFrameworkGenerator(handoff)
  const second = await deterministicFrameworkGenerator(structuredClone(handoff))
  assert.deepEqual(first, second)
  assert.equal(first.generatorIdentity, 'C0/framework-generator')

  const normalized = validateGeneratedFramework(first.candidate, { route: 'DIRECT' })
  assert.equal(normalized.valid, true)
  const candidateHash = H(JSON.stringify(normalized.candidate))
  const verdict = await deterministicFrameworkValidator({
    receipt, attempt: 1, candidate: normalized.candidate, candidateHash,
  })
  assert.equal(verdict.status, 'PASS')
  assert.equal(verdict.candidateHash, candidateHash)
  assert.deepEqual(verdict.findings, [])
})
