'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const {
  activationAttestationPayload,
  applyProductionRuntimeTransition,
  CodexExecAdapter,
  CodexSupervisorRuntime,
  CompatibilityRecoveryAuthority,
  FrameworkOrchestrationAuthority,
  OwnedCodexProxyRunner,
  RolePolicy,
  RuntimeCapabilityAuthority,
  ROUTE_CAPABILITY_EFFECTS,
  activationRuntimeSettings,
  bindCanonicalMissionForChild,
  createCanonicalMissionProjection,
  createCheckerSnapshotFactory,
  validatePlanCheckerSnapshot,
  canonicalCompletedCheckerId,
  canonicalizeCheckerVerificationLimitation,
  controllerCheckerFailureIdentity,
  roadmapPlanOracleForWorkItem,
  checkerVerdictPassed,
  durableNextReadyAfter,
  recoveryGroupNextReady,
  adoptedLeaseMatchesStage,
  terminalFinalizationDiagnostics,
  createConcreteSupervisor,
  createDefaultRouteExecutor,
  createCheckerObservationBinding,
  createCheckerScratchFactory,
  codexPhysicalExecutionReceipt,
  createDefaultRuntimeOptions,
  createSupervisorOptions,
  canonicalEvidenceBinding,
  schedulerProgressEvidenceHashes,
  checkerRecoveryNextReady,
  assertDistinctEvidenceConsumption,
  evidenceInvalidationSet,
  ensureSafeEnvironment,
  phaseBudgetVerdict,
  persistTerminalSession,
  launchCodexChildWithCheckerReassessment,
  providerRuntimeIdentityHash,
  renderPlanArtifact,
  resolveTerminalReceiptCandidateHash,
  createRoadmapPlanLineageReceipt,
  resumePlanProjectionAccepted,
  safeEnvironmentFactory,
  selectWorkRecipe,
  validateLiveCheckingPlan,
  validateCodexAdvisoryPayloadBounds,
  verifyActivationProviderAttestation,
} = require(path.join(WORKFLOW, 'phase-budget.js'))
const { BudgetController } = require(path.join(WORKFLOW, 'budget-controller.js'))
const { CentralScheduler, ROUTE_BUDGETS } = require(path.join(WORKFLOW, 'scheduler.js'))
const { createPreMutationBaseline, createRunRecord, openRunRecord } = require(path.join(WORKFLOW, 'run-record.js'))
const { ensureWindowsPrivateAcl } = require(path.join(WORKFLOW, 'safe-run-root.js'))
const {
  ProcessOwner,
  createPosixProcessAdapter,
  createWindowsJobAdapter,
  prepareProcessLaunchEnvironment,
  selectWindowsLiveStatusPids,
} = require(path.join(WORKFLOW, 'process-owner.js'))
const { writeRequestEnvelope } = require(path.join(WORKFLOW, 'context-envelope.js'))
const localSafety = require('../../scripts/local-only-safety.cjs')
const {
  compileAutomaticRouteDecision,
  createRouteDecision,
  createRouteRecommendation,
  validateRouteDecision,
} = require(path.join(WORKFLOW, 'route-decision.js'))
const { deriveProfileLimits, renderProfile } = require(path.join(WORKFLOW, 'codex-agent-profile.js'))
const { resolveAgentAssignment } = require(path.join(WORKFLOW, 'codex-agent-casting.js'))
const { WorkerWorkspaceManager } = require(path.join(WORKFLOW, 'worker-workspace.js'))
const {
  createPersistentPidTreeAdapter,
  killAllPersistentPidTrees,
  livePersistentPidTrees,
} = require('../fixtures/codex-persistent-pid-tree-adapter.cjs')

const CANDIDATE_A = 'a'.repeat(64)
function adapterMissionFields(
  requestEnvelopeHash = 'hash',
  workItemId = 'adapter-work',
  mission = 'Complete the bounded adapter request.',
) {
  const activationId = 'adapter-activation'
  const generation = 1
  const projection = createCanonicalMissionProjection(mission)
  return {
    activationId,
    generation,
    workItemId,
    canonicalMission: projection.canonicalMission,
    missionBinding: bindCanonicalMissionForChild(projection, {
      sourceRequestHash: projection.sourceRequestHash,
      requestEnvelopeHash,
      activationId,
      generation,
      workItemId,
    }),
  }
}
const WORKER_EXECUTION_POLICY = Object.freeze({
  logicalRole: 'worker',
  physicalRole: 'autoprompt.v2.worker',
  providerRole: 'ap-worker',
  sandboxMode: 'workspace-write',
  policyId: 'autoprompt.codex.role-policy',
  policyVersion: '2.0.0',
})
const PROVIDER_CAPABILITIES = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})
const MODEL_REGISTRY = Object.freeze([Object.freeze({
  id: 'test-model',
  verified: true,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  capabilities: { contextFreeDispatch: true },
  price: { perTokens: 1000000, noncachedInput: 1, cachedInput: 0.1, output: 2 },
  latency: { p50Ms: 1, sampleSize: 100 },
  yield: { successRate: 1, sampleSize: 100 },
})])
const ZERO_USAGE = Object.freeze({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })

function adapterWorkerResult(overrides = {}) {
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: 'adapter-result',
    runId: 'run-adapter', assignmentId: 'work-adapter', logicalRoleId: 'worker',
    physicalRoleId: 'autoprompt.v2.worker', requestEnvelopeHash: 'a'.repeat(64),
    findingIds: ['AP-RUN-026'], startedAt: '2026-08-25T12:00:00.000Z',
    endedAt: '2026-08-25T12:00:01.000Z', filesChanged: [], resourcesChanged: [],
    behaviorChanged: ['Adapter fixture completed.'],
    commands: [{ command: 'true', exitCode: 0, result: 'passed' }],
    successItems: [{ id: 'adapter', status: 'pass', evidenceIds: ['command:true'] }],
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: { event: 'WORK_ITEM_VERIFIED', reason: 'Fixture passed.', invalidateEvidenceIds: [] },
    ...overrides,
  }
}

function checkerReferenceMethod(methodClass, label) {
  return {
    methodClass,
    source: `${label} independent source`,
    procedure: `${label} independently derives expected observations and executes the frozen result`,
    expectedOutputDerivedFromSubjectCode: false,
    subjectLogicReimplemented: false,
    positiveInvariants: [`${label} accepted behavior remains observable`],
    negativeInvariants: [`${label} forbidden behavior is rejected`],
    boundaryInvariants: [`${label} edge case remains within the requested behavior`],
  }
}

function testCapturedDomainPreWorkReceipt(admission) {
  const { stableStringify } = require(path.join(WORKFLOW, 'event-log.js'))
  const body = {
    schemaVersion: 2,
    kind: 'codex-captured-domain-pre-work-admission',
    runId: 'test-run',
    generation: 1,
    admissionHash: admission.admissionHash,
    admissionFileHash: 'a'.repeat(64),
    requestEnvelopeHash: admission.requestEnvelopeHash,
    routeDecisionHash: admission.routeDecisionHash,
    targetStateHash: admission.targetStateHash,
    imageCertificateHashes: admission.contracts
      .filter(contract => contract && contract.kind === 'IMAGE_DATUM')
      .map(contract => contract.certificateHash)
      .sort(),
    preWorkState: 'RUN_WORK',
    preWorkStateEventHash: 'b'.repeat(64),
    preWorkStateEventSequence: 1,
  }
  return {
    ...body,
    receiptHash: crypto.createHash('sha256').update(stableStringify(body)).digest('hex'),
    stateEventHash: body.preWorkStateEventHash,
    stateEventSequence: body.preWorkStateEventSequence,
  }
}

function checkerTestOutcomes(request, label = request.workItemId) {
  return (request.checks || []).map(command => ({
    command,
    status: 'PASS',
    fingerprint: crypto.createHash('sha256').update(`${label}:${command}`).digest('hex'),
  }))
}

function controllerBoundFailureOutcomes(request, semanticFailure, rawEvidence = semanticFailure) {
  return (request.checks || []).map(command => ({
    command,
    status: 'FAIL',
    fingerprint: crypto.createHash('sha256')
      .update(`failure-output:${rawEvidence}:${command}`).digest('hex'),
    commandHash: crypto.createHash('sha256')
      .update(`controller-harness:${command}`).digest('hex'),
    observationId: crypto.createHash('sha256')
      .update(`controller-observation:${request.candidateHash}:${request.workItemId}:${command}`)
      .digest('hex'),
    failureIdentity: controllerCheckerFailureIdentity({
      harnessCommandHash: crypto.createHash('sha256')
        .update(`controller-harness:${command}`).digest('hex'),
      failureCaseIds: [semanticFailure],
    }, command),
  }))
}

function controllerBoundSelectiveFailureOutcomes(request, failedCheckId, rawEvidence = failedCheckId) {
  return (request.checks || []).map(command => {
    const status = command === failedCheckId ? 'FAIL' : 'PASS'
    const harnessCommandHash = crypto.createHash('sha256')
      .update(`controller-harness:${command}`).digest('hex')
    return {
      command,
      status,
      fingerprint: crypto.createHash('sha256')
        .update(`${status.toLowerCase()}-output:${rawEvidence}:${command}`).digest('hex'),
      commandHash: harnessCommandHash,
      observationId: crypto.createHash('sha256')
        .update(`controller-observation:${request.candidateHash}:${request.workItemId}:${command}`)
        .digest('hex'),
      ...(status === 'FAIL' ? {
        failureIdentity: controllerCheckerFailureIdentity({
          harnessCommandHash,
          failureCaseIds: [rawEvidence],
        }, command),
      } : {}),
    }
  })
}

function checkerSeatChecks(routeDecision, seat = 0) {
  const recipe = selectWorkRecipe({
    ...routeDecision.gateSelection,
    route: routeDecision.route,
    checks: [],
    runtimeSignals: routeDecision.runtimeSignals || {},
    overlaySteps: routeDecision.overlaySteps || routeDecision.overlayExecution || [],
  })
  const named = [...new Set([
    ...recipe.checks, ...recipe.riskChecks, ...routeDecision.plannedChecks,
  ])]
  const obligations = (routeDecision.verificationObligations || [])
    .flatMap(obligation => obligation.cases.map(item =>
      `verification:${obligation.id}:${item.id}`))
  return [...new Set([...named, ...obligations])]
}

function withExactTwoCheckerPlan(routeDecision) {
  routeDecision.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: [
      'Execute the authoritative acceptance suite against the frozen candidate.',
      'Execute an independent black-box boundary corpus against the frozen candidate.',
    ],
    nonOverlapReason: 'The authoritative suite and black-box boundary corpus are distinct executable methods with separate evidence.',
  }
  return routeDecision
}

function testWorkspaceCandidateHash(repository) {
  const listed = spawnSync('git', ['-C', repository, 'ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: null, env: process.env, windowsHide: true,
  })
  assert.equal(listed.status, 0, String(listed.stderr || ''))
  const digest = crypto.createHash('sha256')
  for (const name of Buffer.from(listed.stdout).toString('utf8').split('\0').filter(Boolean).sort()) {
    const absolute = path.join(repository, ...name.split('/'))
    const stat = fs.lstatSync(absolute)
    digest.update(Buffer.from(`${name}\0${stat.mode & 0o777}\0${stat.size}\0`, 'utf8'))
    digest.update(fs.readFileSync(absolute))
    digest.update(Buffer.from('\0'))
  }
  return digest.digest('hex')
}

test('independent checks reject circular or common-mode reference methods despite distinct evidence ids', () => {
  const first = {
    checkerId: 'review', oracleId: 'requirements', evidenceIds: ['review-output'],
    requireReferenceMethod: true,
    referenceMethod: checkerReferenceMethod('independent-model', 'shared model'),
  }
  assert.throws(() => assertDistinctEvidenceConsumption([
    first,
    { ...first, checkerId: 'test', oracleId: 'behavior', evidenceIds: ['test-output'] },
  ]), error => error.code === 'DUPLICATE_REFERENCE_METHOD')
  assert.throws(() => assertDistinctEvidenceConsumption([{
    ...first,
    referenceMethod: {
      ...first.referenceMethod,
      expectedOutputDerivedFromSubjectCode: true,
    },
  }]), error => error.code === 'REFERENCE_METHOD_INVALID')
  assert.equal(assertDistinctEvidenceConsumption([
    first,
    {
      checkerId: 'test', oracleId: 'behavior', evidenceIds: ['test-output'],
      requireReferenceMethod: true,
      referenceMethod: checkerReferenceMethod('black-box-boundary', 'edge corpus'),
    },
  ]).referenceMethodHashes.length, 2)
  const sharedDigest = 'a'.repeat(64)
  assert.throws(() => assertDistinctEvidenceConsumption([
    { checkerId: 'review', oracleId: 'requirements', evidenceIds: [`sha256:${sharedDigest}`] },
    { checkerId: 'test', oracleId: 'behavior', evidenceIds: [`file-sha256:${sharedDigest}`] },
  ]), error => error.code === 'DUPLICATE_UNDERLYING_EVIDENCE' &&
    error.details.evidenceId === `sha256:${sharedDigest}`)
  for (const alias of [sharedDigest.toUpperCase(), `URN:SHA256:${sharedDigest}`, `SHA-256:${sharedDigest}?seat=2`]) {
    assert.throws(() => assertDistinctEvidenceConsumption([
      { checkerId: 'review', oracleId: 'requirements', evidenceIds: [`sha256:${sharedDigest}`] },
      { checkerId: 'test', oracleId: 'behavior', evidenceIds: [alias] },
    ]), error => error.code === 'DUPLICATE_UNDERLYING_EVIDENCE' &&
      error.details.evidenceId === `sha256:${sharedDigest}`)
  }
  assert.equal(assertDistinctEvidenceConsumption([
    { checkerId: 'review', oracleId: 'requirements', evidenceIds: [`signed-url/${sharedDigest}?seat=A`] },
    { checkerId: 'test', oracleId: 'behavior', evidenceIds: [`signed-url/${sharedDigest}?seat=a`] },
  ]).consumedEvidenceIds.length, 2)
  assert.equal(assertDistinctEvidenceConsumption([
    { checkerId: 'review', oracleId: 'requirements', evidenceIds: ['Path/CaseSensitive'] },
    { checkerId: 'test', oracleId: 'behavior', evidenceIds: ['path/casesensitive'] },
  ]).consumedEvidenceIds.length, 2)
  assert.throws(() => assertDistinctEvidenceConsumption([{
    checkerId: 'review', oracleId: 'requirements',
    evidenceIds: [`sha256:${sharedDigest}`, `file-sha256:${sharedDigest}`],
  }]), error => error.code === 'EVIDENCE_CONSUMPTION_INVALID')
})

test('ordinary checks admit only applicable independent invariant categories', () => {
  for (const [label, methodClass] of [
    ['ordinary response', 'requirements-review'],
    ['ordinary change', 'authoritative-suite'],
  ]) {
    const referenceMethod = {
      methodClass,
      source: `${label} independent source`,
      procedure: `${label} independently derives and observes the expected result`,
      expectedOutputDerivedFromSubjectCode: false,
      subjectLogicReimplemented: false,
      positiveInvariants: [`${label} named must-hold check passes`],
      negativeInvariants: [],
      boundaryInvariants: [],
    }
    assert.equal(assertDistinctEvidenceConsumption([{
      checkerId: `checker:${label}`, oracleId: `oracle:${label}`,
      evidenceIds: [`evidence:${label}`], requireReferenceMethod: true,
      requiredInvariantCategories: ['positive'], referenceMethod,
    }]).referenceMethodHashes.length, 1)
  }

  const activationMethod = {
    methodClass: 'black-box-boundary', source: 'activation timeline oracle',
    procedure: 'observe each explicitly declared activation phase',
    expectedOutputDerivedFromSubjectCode: false, subjectLogicReimplemented: false,
    positiveInvariants: ['active state is observed'], negativeInvariants: [],
    boundaryInvariants: ['boundary transition is observed'],
  }
  assert.throws(() => assertDistinctEvidenceConsumption([{
    checkerId: 'activation-checker', oracleId: 'activation-oracle',
    evidenceIds: ['activation-evidence'], requireReferenceMethod: true,
    requiredInvariantCategories: ['positive', 'negative', 'boundary'],
    referenceMethod: activationMethod,
  }]), error => error.code === 'REFERENCE_METHOD_INVALID')
})

test('checker contract defects return the usable candidate after distinct seats without fresh same-seat reassessment', async t => {
  const directory = tempDirectory(t, 'autoprompt-checker-contract-retry-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = withExactTwoCheckerPlan(decision('DIRECT'))
  const requests = []
  const transitions = []
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (event, state, details) => transitions.push({ event, state, details }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: crypto.createHash('sha256').update('checker-contract-build').digest('hex'),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT',
    decision: routeDecision,
    launch: async request => {
      requests.push(request)
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'checked'\n")
        return { reportId: request.workItemId, allAssignedItemsPass: true }
      }
      const first = request.workItemId.startsWith('independent-check-1')
      const methodClass = first ? 'invented-composite-method' : 'black-box-boundary'
      return {
        code: 'PASS',
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod(methodClass, request.workItemId),
          testOutcomes: request.checks.map(command => ({
            command, status: 'PASS', fingerprint: crypto.createHash('sha256')
              .update(`focused:${request.workItemId}:${command}`).digest('hex'),
          })),
        },
      }
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(result.terminalEnvelope.controllerReason, 'REFERENCE_METHOD_INVALID')
  const checks = requests.filter(request => request.logicalRole.startsWith('independent-'))
  assert.deepEqual(checks.map(request => request.workItemId), [
    'independent-check-1',
    'independent-check-2',
  ])
  assert.equal(checks.some(request => request.workItemId.includes('runtime-retry')), false)
  assert.equal(checks.every(request => request.deferProofAcceptance === true), true)
  assert.deepEqual(checks[0].checks, checks[1].checks,
    'both independent checker seats receive the complete named acceptance matrix')
  assert.deepEqual(
    checks[0].fetchedEvidence.verificationObligations,
    checks[1].fetchedEvidence.verificationObligations,
    'both checker seats receive the complete verification-obligation matrix')
  assert.ok(checks[0].checks.length > 0)
  assert.equal(transitions.filter(item => item.event === 'CHECK_INCONCLUSIVE').length, 1)
  assert.equal(transitions.filter(item => item.event === 'INDEPENDENT_VERDICT_RECORDED').length, 0)
})

test('duplicate aggregate evidence after all distinct seats returns the usable candidate with limitations', async t => {
  const directory = tempDirectory(t, 'autoprompt-duplicate-evidence-limitation-')
  const targetPath = createTempGitTarget(directory)
  const requests = []
  const result = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: crypto.createHash('sha256').update('duplicate-limitation-build').digest('hex'),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT',
    decision: withExactTwoCheckerPlan(decision('DIRECT')),
    launch: async request => {
      requests.push(request)
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'usable'\n")
        return { reportId: request.workItemId, allAssignedItemsPass: true }
      }
      const secondSeat = request.workItemId.startsWith('independent-check-2')
      return {
        code: 'PASS',
        payload: {
          evidenceIds: ['evidence:shared-even-after-correction'],
          referenceMethod: checkerReferenceMethod(
            secondSeat ? 'black-box-boundary' : 'requirements-review',
            request.workItemId,
          ),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(result.terminalEnvelope.controllerReason, 'DUPLICATE_UNDERLYING_EVIDENCE')
  assert.deepEqual(requests.filter(request => request.logicalRole.startsWith('independent-'))
    .map(request => request.workItemId), [
    'independent-check-1',
    'independent-check-2',
  ])
  assert.equal(requests.some(request => request.workItemId.includes('runtime-retry')), false)
})

test('one-checker PASS without an independent reference method returns the usable candidate without reassessment', async t => {
  for (const repeatedDefect of [false, true]) {
    const directory = tempDirectory(t, `autoprompt-one-checker-method-${repeatedDefect}-`)
    const targetPath = createTempGitTarget(directory)
    const requests = []
    const transitions = []
    const priorReportSentinel = `private-prior-report-bytes-${repeatedDefect}`
    const resultPointers = new Map()
    const persistResult = (workItemId, result) => {
      const resultPath = path.join(directory, `${workItemId}.json`)
      const bytes = Buffer.from(`${JSON.stringify(result)}\n`)
      fs.writeFileSync(resultPath, bytes)
      resultPointers.set(workItemId, {
        name: workItemId,
        path: resultPath,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      })
      return result
    }
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.independentCheckingPlan = {
      checkerCount: 1,
      responsibilities: ['Independently review and run the focused behavior check.'],
      nonOverlapReason: null,
    }
    const executor = createDefaultRouteExecutor({
      targetPath,
      gitEnvironment: () => process.env,
      transition: async (event, state, details) => transitions.push({ event, state, details }),
      resultPointer: workItemId => resultPointers.get(workItemId),
      harnessAttestation: (candidateHash, oracle) => ({
        repoHash: candidateHash,
        buildHash: crypto.createHash('sha256').update('one-checker-method-build').digest('hex'),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })
    const result = await executor({
      route: 'DIRECT',
      decision: routeDecision,
      launch: async request => {
        requests.push(request)
        if (request.logicalRole === 'worker') {
          fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'method-checked'\n")
          return { reportId: request.workItemId, allAssignedItemsPass: true }
        }
        const retry = request.workItemId.includes('runtime-retry')
        const maliciousWideCorrection = retry && !repeatedDefect
        const testOutcomes = checkerTestOutcomes(request)
        if (maliciousWideCorrection) {
          testOutcomes.splice(0, testOutcomes.length, ...testOutcomes.map(item => ({
            ...item, status: 'FAIL',
          })))
        }
        const checkerResult = {
          code: maliciousWideCorrection ? 'FAIL' : 'PASS',
          ...(maliciousWideCorrection ? {
            cause: {
              event: 'ASSERTION_FAILED',
              reason: 'attempted top-level overwrite outside the correction scope',
              unblockPath: 'must be ignored',
            },
            currentVersionHash: 'f'.repeat(64),
          } : {}),
          payload: {
            evidenceIds: [maliciousWideCorrection
              ? 'evidence:attempted-overwrite' : `evidence:${request.workItemId}`],
            controllerPrivatePriorReportBytes: maliciousWideCorrection
              ? 'attempted-overwrite' : priorReportSentinel,
            ...(!retry || repeatedDefect ? {} : {
              referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
            }),
            testOutcomes,
          },
        }
        return retry ? checkerResult : persistResult(request.workItemId, checkerResult)
      },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async () => ({}),
      resumeState: null,
    })
    assert.equal(result.outcome, 'DONE', JSON.stringify({
      result,
      transitions,
      requests: requests.map(request => request.workItemId),
    }))
    assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
    assert.equal(result.terminalEnvelope.controllerReason, 'REFERENCE_METHOD_INVALID')
    assert.deepEqual(requests.filter(request => request.logicalRole.startsWith('independent-'))
      .map(request => request.workItemId), [
      'independent-check-1',
    ])
    assert.equal(requests.some(request => request.workItemId.includes('runtime-retry')), false)
    const reassessment = transitions.find(item => item.event === 'CHECK_INCONCLUSIVE')
    assert.equal(reassessment.details.controllerReason, 'REFERENCE_METHOD_INVALID')
    assert.deepEqual(reassessment.details.nextReadyWorkIds, [])
    assert.equal(transitions.filter(item => item.event === 'CHECK_INCONCLUSIVE').length, 1)
    assert.equal(JSON.stringify(requests).includes(priorReportSentinel), false,
      'non-authoritative report bytes never enter another physical checker request')
  }
})

test('whole checker report defects stay non-authoritative without a fresh correction launch', async t => {
  const directory = tempDirectory(t, 'autoprompt-whole-report-correction-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently validate the complete exact result.'],
    nonOverlapReason: null,
  }
  const requests = []
  const transitions = []
  let priorResult
  let correctionResult
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (event, state, details) => transitions.push({ event, state, details }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: crypto.createHash('sha256').update('whole-report-correction-build').digest('hex'),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT',
    decision: routeDecision,
    launch: async request => {
      requests.push(request)
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'checked'\n")
        return { allAssignedItemsPass: true }
      }
      if (!request.workItemId.includes('runtime-retry')) {
        priorResult = {
          code: 'NONCANONICAL_CHECKER_CODE',
          description: 'prior description sentinel',
          stateClass: 'intermediate',
          runId: 'prior-run-sentinel',
          requestEnvelopeHash: routeDecision.requestEnvelopeHash,
          currentVersionHash: request.candidateHash,
          cause: {
            event: 'PRIOR_REPORT_INVALID',
            reason: 'prior cause sentinel',
            unblockPath: 'prior unblock sentinel',
          },
          payloadSchemaId: 'prior-payload-schema-sentinel',
          payload: { priorPayloadSentinel: true },
          contextId: 'prior-context-sentinel',
          transportEvidence: { priorTransportSentinel: true },
          evidenceHashes: ['a'.repeat(64)],
          controllerOnlyAuditSentinel: 'preserve-me',
        }
        return priorResult
      }
      correctionResult = {
        code: 'PASS',
        description: 'attacker description must not cross the allowlist',
        stateClass: 'resumable',
        runId: 'attacker-run',
        requestEnvelopeHash: 'f'.repeat(64),
        currentVersionHash: 'e'.repeat(64),
        cause: {
          event: 'ATTACKER_CAUSE',
          reason: 'attacker cause must not cross the allowlist',
          unblockPath: null,
        },
        payloadSchemaId: 'attacker-payload-schema',
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
        contextId: 'attacker-context',
        transportEvidence: { attackerTransport: true },
        evidenceHashes: ['b'.repeat(64)],
        attackerOnlyTopField: true,
      }
      return correctionResult
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(outcome.terminalEnvelope.controllerReason, 'CHECK_REPORT_INVALID')
  assert.equal(correctionResult, undefined)
  assert.equal(requests.some(request => request.workItemId.includes('runtime-retry')), false)
  assert.equal(transitions.some(item => item.event === 'INDEPENDENT_VERDICT_RECORDED'), false)
  assert.equal(priorResult.controllerOnlyAuditSentinel, 'preserve-me')
})

test('noncanonical checker correction scopes are rejected before any retry can launch', () => {
  const resultHash = 'a'.repeat(64)
  const basePayload = {
    eventId: 'CHECK_INCONCLUSIVE',
    nextState: 'CHECK_INCONCLUSIVE',
    details: {
      candidateHash: 'b'.repeat(64),
      checkerId: 'independent-check-1',
      checkerResultHash: resultHash,
      retryAttempt: 1,
      nextReadyWorkIds: ['independent-check-1-runtime-retry-1'],
    },
  }
  const authority = {
    stateStore: { load: () => ({ state: 'CHECK_WORK', retryState: {} }) },
    capability: {},
    budgetController: {},
  }
  for (const controllerReassessment of [
    {
      code: 'REFERENCE_METHOD_INVALID', priorResultEvidenceHash: resultHash,
      invalidFieldIds: ['code', 'payload.referenceMethod'], checkIds: [],
    },
    {
      code: 'TEST_OUTCOMES_INVALID', priorResultEvidenceHash: resultHash,
      invalidFieldIds: ['payload.testOutcomes'], checkIds: [],
    },
    {
      code: 'CHECK_REPORT_INVALID', priorResultEvidenceHash: resultHash,
      invalidFieldIds: ['code', 'payload'], checkIds: [],
    },
    {
      code: 'CHECK_INCONCLUSIVE', priorResultEvidenceHash: resultHash,
      invalidFieldIds: ['payload.evidenceIds'], checkIds: [],
    },
  ]) {
    assert.throws(() => applyProductionRuntimeTransition(authority, {
      ...basePayload,
      details: { ...basePayload.details, controllerReassessment },
    }), error => error.code === 'CHECK_RETRY_STATE_INVALID')
  }
})

test('checker PASS with a failed named outcome returns the usable candidate without fresh reassessment', async t => {
  for (const repeatedDefect of [false, true]) {
    const directory = tempDirectory(t, `autoprompt-one-checker-failed-outcome-${repeatedDefect}-`)
    const targetPath = createTempGitTarget(directory)
    const requests = []
    const transitions = []
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.independentCheckingPlan = {
      checkerCount: 1,
      responsibilities: ['Independently run every named acceptance check.'],
      nonOverlapReason: null,
    }
    const executor = createDefaultRouteExecutor({
      targetPath,
      gitEnvironment: () => process.env,
      transition: async (event, state, details) => transitions.push({ event, state, details }),
      harnessAttestation: (candidateHash, oracle) => ({
        repoHash: candidateHash,
        buildHash: crypto.createHash('sha256').update('failed-named-outcome-build').digest('hex'),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })
    const result = await executor({
      route: 'DIRECT',
      decision: routeDecision,
      launch: async request => {
        requests.push(request)
        if (request.logicalRole === 'worker') {
          fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'outcome-checked'\n")
          return { reportId: request.workItemId, allAssignedItemsPass: true }
        }
        const retry = request.workItemId.includes('runtime-retry')
        const outcomes = checkerTestOutcomes(request)
        if (!retry || repeatedDefect) outcomes[0] = { ...outcomes[0], status: 'FAIL' }
        return {
          code: 'PASS',
          payload: {
            evidenceIds: [`evidence:${request.workItemId}`],
            referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
            testOutcomes: outcomes,
          },
        }
      },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async () => ({}),
      resumeState: null,
    })
    assert.equal(result.outcome, 'DONE', JSON.stringify({
      result,
      transitions,
      requests: requests.map(request => request.workItemId),
    }))
    assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
    assert.equal(result.terminalEnvelope.controllerReason, 'TEST_OUTCOMES_INVALID')
    assert.deepEqual(requests.filter(request => request.logicalRole.startsWith('independent-'))
      .map(request => request.workItemId), [
      'independent-check-1',
    ])
    assert.equal(requests.some(request => request.workItemId.includes('runtime-retry')), false)
    assert.equal(transitions.filter(item => item.event === 'CHECK_INCONCLUSIVE').length, 1)
    assert.deepEqual(transitions.find(item => item.event === 'CHECK_INCONCLUSIVE')
      .details.nextReadyWorkIds, [])
  }
})

test('late checker binding mismatch preserves bound evidence without rerunning the matrix', async t => {
  const directory = tempDirectory(t, 'autoprompt-malformed-checker-retry-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = decision('DIRECT')
  routeDecision.plannedChecks = [
    'Reopen the serialized deliverable through the downstream consumer and require non-empty output.',
    'Exercise before, exactly at, between, and after each effective-date boundary.',
  ]
  const requests = []
  const persisted = []
  const executor = createDefaultRouteExecutor({
    runId: 'run-malformed-checker',
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: crypto.createHash('sha256').update('malformed-checker-build').digest('hex'),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT',
    decision: routeDecision,
    launch: async request => {
      requests.push(request)
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'checked'\n")
        return { reportId: request.workItemId, allAssignedItemsPass: true }
      }
      if (!request.workItemId.includes('runtime-retry')) {
        const invalidResult = {
          schemaVersion: '2.0.0', code: 'PASS', runId: 'foreign-run',
          requestEnvelopeHash: routeDecision.requestEnvelopeHash,
          currentVersionHash: request.candidateHash,
          candidateHash: request.candidateHash,
          contextId: 'checker-context-1', usage: ZERO_USAGE, usageStreamed: false,
          transportEvidence: {
            verificationObservations: {
              count: 1,
              evidenceHash: crypto.createHash('sha256')
                .update(`bound-observation:${request.workItemId}`).digest('hex'),
            },
          },
          payload: {
            evidenceIds: [`evidence:bound:${request.workItemId}`],
            referenceMethod: checkerReferenceMethod(
              request.workItemId.startsWith('independent-check-1')
                ? 'black-box-boundary' : 'authoritative-suite',
              request.workItemId,
            ),
            testOutcomes: checkerTestOutcomes(request),
          },
        }
        const error = Object.assign(new Error('checker binding rejected'), {
          code: 'CHECK_REPORT_INVALID',
          details: {
            mismatches: ['runId'], invalidCheckerResult: invalidResult,
            checkerTerminalEvidence: {
              rawOutputHash: '1'.repeat(64), eventStreamHash: '2'.repeat(64),
              sessionId: 'checker-context-1',
            },
          },
        })
        return launchCodexChildWithCheckerReassessment({
          async launch() { throw error },
        }, {
          ...request,
          runId: 'run-malformed-checker',
          dispatch: { requestPointer: { hash: routeDecision.requestEnvelopeHash } },
          continuationId: 'checker-context-1',
          onTerminalResult: receipt => persisted.push(receipt),
        }, 'run-malformed-checker')
      }
      assert.fail(`late binding repair must not relaunch ${request.workItemId}`)
    },
  })

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(persisted.length >= 1, true)
  assert.equal(persisted[0].code, 'PASS')
  assert.equal(persisted[0].runId, 'run-malformed-checker')
  assert.equal(persisted[0].transportEvidence.verificationObservations.count, 1)
  const checkRequests = requests.filter(request => request.logicalRole.startsWith('independent-'))
  assert.deepEqual(checkRequests.map(request => request.workItemId), ['independent-check-1'])
  assert.equal(checkRequests.some(request => request.workItemId.includes('runtime-retry')), false)
})

test('provisional PASS evidence advances only to a distinct checker seat and returns the usable candidate', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-single-check-proof-deferral-'))
  const checks = []
  const result = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: crypto.createHash('sha256').update('single-check-build').digest('hex'),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: withExactTwoCheckerPlan(decision('DIRECT')),
    launch: async request => {
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'single-check'\n")
        return { allAssignedItemsPass: true }
      }
      checks.push(request)
      const retry = request.workItemId.includes('runtime-retry')
      const second = request.workItemId.startsWith('independent-check-2')
      return {
        code: 'PASS',
        payload: {
          evidenceIds: !second && !retry ? [] : [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod(
            second ? 'black-box-boundary' : 'authoritative-suite', request.workItemId),
          testOutcomes: request.checks.map(command => ({
            command, status: 'PASS', fingerprint: crypto.createHash('sha256')
              .update(`focused:${request.workItemId}:${command}`).digest('hex'),
          })),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(result.terminalEnvelope.controllerReason, 'EVIDENCE_CONSUMPTION_INVALID')
  assert.deepEqual(checks.map(check => check.workItemId), [
    'independent-check-1', 'independent-check-2',
  ])
  assert.equal(checks.some(check => check.workItemId.includes('runtime-retry')), false)
  assert.equal(checks.every(check => check.deferProofAcceptance === true), true)
  assert.deepEqual(checks[0].checks, checks[1].checks)
  assert.equal(checks[1].fetchedEvidence.controllerReportCorrection, undefined)
})

test('checker PASS with a failed named outcome is never cached as accepted proof', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-regression-proof-deferral-'))
  const acceptedProofs = []
  const namedCheck = 'failing-to-passing-behavior'
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    readPreMutationBaseline: () => ({
      existingTests: [{
        id: namedCheck,
        command: namedCheck,
        status: 'PASS',
        outputHash: 'baseline-pass-fingerprint',
      }],
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: crypto.createHash('sha256').update('regression-proof-build').digest('hex'),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT',
    decision: decision('DIRECT'),
    launch: async request => {
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'regressed'\n")
        return { allAssignedItemsPass: true }
      }
      return {
        code: 'PASS',
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod(
            request.logicalRole === 'independent-reviewer'
              ? 'requirements-review' : 'black-box-boundary',
            request.workItemId,
          ),
          testOutcomes: request.checks.map(command => ({
            command,
            status: command === namedCheck ? 'FAIL' : 'PASS',
            fingerprint: command === namedCheck
              ? crypto.createHash('sha256').update('new-failure-fingerprint').digest('hex')
              : crypto.createHash('sha256').update(`pass:${command}`).digest('hex'),
          })),
        },
      }
    },
    acceptDeferredCheckerProof: checkerId => acceptedProofs.push(checkerId),
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(acceptedProofs, [])
})

test('crash-restored completed checker retry is consumed exactly once without a physical relaunch', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-completed-checker-retry-'))
  const candidateHash = 'a'.repeat(64)
  const retryId = 'independent-check-1-runtime-retry-1'
  const retryDecision = decision('DIRECT')
  const retryChecks = checkerSeatChecks(retryDecision, 0)
  const retryResult = {
    code: 'PASS',
    currentVersionHash: candidateHash,
    payload: {
      evidenceIds: [`evidence:${retryId}`],
      referenceMethod: checkerReferenceMethod('authoritative-suite', retryId),
      testOutcomes: retryChecks.map(command => ({
        command,
        status: 'PASS',
        fingerprint: crypto.createHash('sha256').update(`restored:${command}`).digest('hex'),
      })),
    },
  }
  const baseId = 'independent-check-1'
  const baseResult = {
    code: 'CHECK_INCONCLUSIVE',
    cause: { reason: 'base checker transport ended after durable evidence' },
  }
  const resultFiles = new Map()
  for (const [workItemId, result] of [[baseId, baseResult], [retryId, retryResult]]) {
    const resultPath = path.join(path.dirname(targetPath), `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    resultFiles.set(workItemId, {
      name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    })
  }
  const launches = []
  const transitions = []
  const verifiedReceipts = []
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (event, state, details) => transitions.push([
      event, state, details && details.checkerId, details && details.nextReadyWorkIds,
    ]),
    readResult: workItemId => workItemId === retryId ? retryResult
      : workItemId === baseId ? baseResult : null,
    resultPointer: workItemId => resultFiles.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      verifiedReceipts.push(workItemId)
      assert.equal(result, workItemId === retryId ? retryResult : baseResult)
      return true
    },
    harnessAttestation: (_candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT',
    decision: retryDecision,
    launch: async request => {
      launches.push(request.workItemId)
      assert.notEqual(request.workItemId, retryId, 'completed retry must not relaunch')
      return {
        code: 'PASS',
        currentVersionHash: candidateHash,
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE',
      candidateHash,
      completedWorkIds: ['work-1'],
      completedCheckIds: [baseId, retryId],
      acceptedResultIds: [],
      nextReadyWorkIds: [],
      retryState: {
        inconclusiveChecker: {
          checkerId: baseId,
          candidateHash,
          checkerResultHash: crypto.createHash('sha256')
            .update(JSON.stringify(baseResult)).digest('hex'),
          retryAttempt: 1,
          returnState: 'CHECK_WORK',
        },
      },
    },
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(launches.includes(retryId), false)
  assert.deepEqual(verifiedReceipts, [baseId, retryId])
  assert.deepEqual(transitions.filter(([event]) => event === 'CHECK_BECAME_CONCLUSIVE'), [
    ['CHECK_BECAME_CONCLUSIVE', 'CHECK_WORK', retryId, []],
  ])
})

test('controller-rejected provisional PASS cannot conflict with its completed corrected retry', async t => {
  const directory = tempDirectory(t, 'autoprompt-provisional-pass-retry-')
  const targetPath = createTempGitTarget(directory)
  const candidateHash = '9'.repeat(64)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently verify the corrected exact result.'],
    nonOverlapReason: null,
  }
  const retryChecks = checkerSeatChecks(routeDecision, 0)
  const baseId = 'independent-check-1'
  const retryId = `${baseId}-runtime-retry-1`
  const records = {
    [baseId]: {
      code: 'PASS', currentVersionHash: candidateHash,
      payload: {
        evidenceIds: ['evidence:provisional-base'],
        referenceMethod: checkerReferenceMethod('authoritative-suite', baseId),
        testOutcomes: retryChecks.map(command => ({
          command, status: 'FAIL', fingerprint: crypto.createHash('sha256')
            .update(`rejected:${command}`).digest('hex'),
        })),
      },
    },
    [retryId]: {
      code: 'PASS', currentVersionHash: candidateHash,
      payload: {
        evidenceIds: ['evidence:corrected-retry'],
        referenceMethod: checkerReferenceMethod('authoritative-suite', retryId),
        testOutcomes: retryChecks.map(command => ({
          command, status: 'PASS',
          fingerprint: crypto.createHash('sha256').update(`corrected:${command}`).digest('hex'),
        })),
      },
    },
  }
  const retryPath = path.join(directory, `${retryId}.json`)
  fs.writeFileSync(retryPath, `${JSON.stringify(records[retryId])}\n`)
  const retryBytes = fs.readFileSync(retryPath)
  const launches = []
  const verified = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => records[workItemId] || null,
    resultPointer: workItemId => {
      assert.equal(workItemId, retryId)
      return {
        name: retryId, path: retryPath,
        hash: crypto.createHash('sha256').update(retryBytes).digest('hex'), bytes: retryBytes.length,
      }
    },
    verifyDurableResultReceipt: (workItemId, result) => {
      verified.push(workItemId)
      assert.equal(workItemId, retryId)
      assert.equal(result, records[retryId])
      return true
    },
    harnessAttestation: (_candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      throw Object.assign(new Error('completed checker attempts must not relaunch'), { code: 'TEST_STOP' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1'], completedCheckIds: [baseId, retryId],
      acceptedResultIds: [], nextReadyWorkIds: [], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [])
  assert.deepEqual(verified, [retryId])
})

test('recovered ordinary checker retry defects return the usable candidate without another physical launch', async t => {
  for (const scenario of [
    {
      name: 'invalid-pass-payload',
      result: { code: 'PASS', payload: { evidenceIds: ['evidence:invalid-retry'] } },
      completed: true,
    },
    {
      name: 'persistent-inconclusive',
      result: {
        code: 'CHECK_INCONCLUSIVE',
        cause: {
          event: 'CHECK_INCONCLUSIVE', reason: 'retry remained inconclusive',
          unblockPath: 'repair implementation',
        },
        payload: {},
      },
      completed: true,
    },
    {
      name: 'unknown-code', result: { code: 'UNRECOGNIZED_CHECKER_REPORT' }, completed: false,
    },
  ]) {
    const directory = tempDirectory(t, `autoprompt-recovered-${scenario.name}-`)
    const targetPath = createTempGitTarget(directory)
    const candidateHash = testWorkspaceCandidateHash(targetPath)
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.independentCheckingPlan = {
      checkerCount: 1,
      responsibilities: ['Independently validate the recovered retry report.'],
      nonOverlapReason: null,
    }
    const baseId = 'independent-check-1'
    const retryId = `${baseId}-runtime-retry-1`
    const baseResult = {
      code: 'CHECK_INCONCLUSIVE', candidateHash,
      cause: { reason: 'base checker transport ended' },
    }
    const retryResult = { ...scenario.result, currentVersionHash: candidateHash }
    const records = { [baseId]: baseResult, [retryId]: retryResult }
    const pointers = new Map()
    for (const [workItemId, result] of Object.entries(records)) {
      const resultPath = path.join(directory, `${workItemId}.json`)
      fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
      const bytes = fs.readFileSync(resultPath)
      pointers.set(workItemId, { name: workItemId, path: resultPath,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
    }
    const launches = []
    const transitions = []
    const outcome = await createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env,
      transition: async (event, state, details) => transitions.push([event, state, details]),
      readResult: workItemId => records[workItemId] || null,
      resultPointer: workItemId => pointers.get(workItemId),
      verifyDurableResultReceipt: (workItemId, result) => {
        assert.deepEqual(result, records[workItemId]); return true
      },
      harnessAttestation: (versionHash, oracle) => ({
        repoHash: versionHash, buildHash: 'b'.repeat(64),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })({
      route: 'DIRECT', decision: routeDecision,
      launch: async request => { launches.push(request.workItemId); return { code: 'PASS' } },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
      resumeState: {
        resumeState: 'CHECK_INCONCLUSIVE', candidateHash,
        completedWorkIds: ['work-1'], completedCheckIds: scenario.completed ? [retryId] : [],
        acceptedResultIds: [], nextReadyWorkIds: [],
        retryState: { inconclusiveChecker: {
          checkerId: baseId, candidateHash,
          checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
          retryAttempt: 1, returnState: 'CHECK_WORK',
        } },
      },
    })
    assert.equal(outcome.outcome, 'DONE', scenario.name)
    assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS', scenario.name)
    assert.deepEqual(launches, [], scenario.name)
    assert.equal(transitions.filter(([event]) => event === 'CHECK_BECAME_CONCLUSIVE').length, 1,
      scenario.name)
    assert.equal(transitions.filter(([event]) => event === 'ACCEPTANCE_GREEN').length, 1,
      scenario.name)
    assert.equal(transitions.filter(([event]) => event === 'IMPLEMENTATION_DEFECT').length, 0,
      scenario.name)
    assert.equal(transitions.filter(([event]) => event === 'CHECK_REMAINS_INCONCLUSIVE').length, 0,
      scenario.name)
  }
})

test('durable checker frontier rejects unknown or ambiguous continuations before launch', async t => {
  for (const scenario of [
    { name: 'canonical', nextReady: ['independent-check-1'], valid: true },
    { name: 'empty-incomplete', nextReady: [], valid: false },
    { name: 'unknown', nextReady: ['bogus'], valid: false },
    { name: 'ambiguous', nextReady: ['independent-check-1', 'bogus'], valid: false },
  ]) {
    const targetPath = createTempGitTarget(tempDirectory(t, `autoprompt-frontier-${scenario.name}-`))
    const candidateHash = testWorkspaceCandidateHash(targetPath)
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.independentCheckingPlan = {
      checkerCount: 1, responsibilities: ['Verify the exact frontier.'], nonOverlapReason: null,
    }
    const launches = []
    const execution = createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env, transition: async () => {},
      readResult: () => null,
      resultPointer: () => { throw new Error('fresh frontier must not read a terminal result') },
      harnessAttestation: (versionHash, oracle) => ({
        repoHash: versionHash, buildHash: 'b'.repeat(64),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })({
      route: 'DIRECT', decision: routeDecision,
      launch: async request => {
        launches.push(request.workItemId)
        return { code: 'PASS', payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        } }
      },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
      resumeState: {
        resumeState: 'CHECK_WORK', candidateHash, completedWorkIds: ['work-1'],
        completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: scenario.nextReady,
        retryState: {},
      },
    })
    if (scenario.valid) {
      const outcome = await execution
      assert.ok(['DONE', 'PARTIAL'].includes(outcome.outcome))
      assert.deepEqual(launches, ['independent-check-1'])
    } else {
      await assert.rejects(execution, error => error.code === 'CHECK_RETRY_STATE_INVALID')
      assert.deepEqual(launches, [])
    }
  }
})

test('ordinary work recovery admits only the exact missing physical worker set', async t => {
  for (const scenario of [
    { name: 'canonical', nextReady: ['work-2'], valid: true },
    { name: 'missing-result', nextReady: ['work-2'], valid: false,
      expectedCode: 'CRASH_ADOPTION_CONFLICT', missingResult: true },
    { name: 'empty', nextReady: [], valid: false },
    { name: 'unknown', nextReady: ['bogus'], valid: false },
    { name: 'wrong-worker', nextReady: ['work-1'], valid: false },
  ]) {
    const targetPath = createTempGitTarget(tempDirectory(t, `autoprompt-work-frontier-${scenario.name}-`))
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.usefulWorkerCount = 2
    routeDecision.workerResponsibilities = ['Preserve completed work one.', 'Complete work two.']
    const launches = []
    const execution = createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env, transition: async () => {},
      harnessAttestation: (candidateHash, oracle) => ({
        repoHash: candidateHash, buildHash: 'b'.repeat(64),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })({
      route: 'DIRECT', decision: routeDecision,
      launch: async request => {
        launches.push(request.workItemId)
        if (request.logicalRole === 'worker') {
          fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'work-two'\n")
          return { allAssignedItemsPass: true }
        }
        return { code: 'PASS', payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        } }
      },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async () => scenario.missingResult ? ({}) : ({
        'work-1': { reportId: 'work-1', allAssignedItemsPass: true },
      }),
      resumeState: {
        resumeState: 'ITEM_VERIFIED', completedWorkIds: ['work-1'], completedCheckIds: [],
        acceptedResultIds: [], nextReadyWorkIds: scenario.nextReady, retryState: {},
      },
    })
    if (scenario.valid) {
      const outcome = await execution
      assert.ok(['DONE', 'PARTIAL'].includes(outcome.outcome))
      assert.equal(launches[0], 'work-2')
      assert.equal(launches.filter(id => id === 'work-2').length, 1)
    } else {
      await assert.rejects(execution, error =>
        error.code === (scenario.expectedCode || 'CHECK_RETRY_STATE_INVALID'))
      assert.deepEqual(launches, [])
    }
  }
})

test('post-result checker frontiers retire runtime retry or resume concrete repair without base relaunch', async t => {
  for (const kind of ['retry', 'repair']) {
    const directory = tempDirectory(t, `autoprompt-checker-post-result-${kind}-`)
    const targetPath = createTempGitTarget(directory)
    fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'rejected'\n")
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.independentCheckingPlan = {
      checkerCount: 1,
      responsibilities: ['Independently verify the exact recovered result.'],
      nonOverlapReason: null,
    }
    const checkerResult = kind === 'retry'
      ? { code: 'CHECK_INCONCLUSIVE', cause: { reason: 'checker transport ended after durable result' } }
      : {
          code: 'FAIL',
          cause: { event: 'ASSERTION_FAILED', reason: 'implementation defect', unblockPath: 'repair implementation' },
          payload: { findingIds: ['AP-RUN-026'] },
        }
    const resultPath = path.join(directory, 'independent-check-1.json')
    fs.writeFileSync(resultPath, `${JSON.stringify(checkerResult)}\n`)
    const bytes = fs.readFileSync(resultPath)
    const pointer = {
      name: 'independent-check-1', path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    }
    const nextReadyId = kind === 'retry'
      ? 'independent-check-1-runtime-retry-1' : 'work-1-repair-1'
    const launches = []
    const transitions = []
    const outcome = await createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env,
      transition: async (eventId, nextState, details) => transitions.push({ eventId, nextState, details }),
      readResult: workItemId => workItemId === 'independent-check-1' ? checkerResult : null,
      resultPointer: workItemId => {
        assert.equal(workItemId, 'independent-check-1')
        return pointer
      },
      verifyDurableResultReceipt: (workItemId, result) => {
        assert.equal(workItemId, 'independent-check-1')
        assert.equal(result, checkerResult)
        return true
      },
      harnessAttestation: (candidateHash, oracle) => ({
        repoHash: candidateHash, buildHash: 'b'.repeat(64),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })({
      route: 'DIRECT', decision: routeDecision,
      launch: async request => {
        launches.push(request.workItemId)
        if (request.workItemId === 'work-1-repair-1') {
          fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired'\n")
          return { allAssignedItemsPass: true }
        }
        return {
          code: 'PASS',
          payload: {
            evidenceIds: [`evidence:${request.workItemId}`],
            referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
            testOutcomes: checkerTestOutcomes(request),
          },
        }
      },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
      resumeState: {
        resumeState: 'CHECK_WORK', completedWorkIds: ['work-1'], completedCheckIds: [],
        acceptedResultIds: [], nextReadyWorkIds: [nextReadyId], retryState: {},
      },
    })
    assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
    if (kind === 'retry') {
      assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
      assert.deepEqual(launches, [])
    } else {
      assert.equal(launches[0], nextReadyId)
      assert.equal(launches.filter(id => id === nextReadyId).length, 1)
    }
    assert.equal(launches.includes('independent-check-1'), false)
    assert.equal(transitions[0].eventId,
      kind === 'retry' ? 'CHECK_INCONCLUSIVE' : 'IMPLEMENTATION_DEFECT')
  }
})

test('post-result recovery binds every eligible checker failure to the next exact repair', async t => {
  for (const scenario of [
    { name: 'second-checker-repair', checkerId: 'independent-check-2', nextReady: ['work-1-repair-1'], checkerCount: 2, workerCount: 1, expect: 'DONE' },
    { name: 'multi-worker-union-repair', checkerId: 'independent-check-1', nextReady: ['work-1-repair-1'], checkerCount: 1, workerCount: 2, expect: 'DONE' },
    { name: 'post-repair-terminal-fail', checkerId: 'independent-check-1-repair-1', nextReady: [], checkerCount: 1, workerCount: 1, expect: 'FAILED' },
  ]) {
    const directory = tempDirectory(t, `autoprompt-checker-${scenario.name}-`)
    const targetPath = createTempGitTarget(directory)
    fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'rejected'\n")
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.usefulWorkerCount = scenario.workerCount
    if (scenario.checkerCount === 2) withExactTwoCheckerPlan(routeDecision)
    const failure = {
      code: 'FAIL',
      cause: { event: 'ASSERTION_FAILED', reason: scenario.name, unblockPath: 'repair if eligible' },
      payload: { findingIds: ['AP-RUN-026'] },
    }
    const routeRecipe = selectWorkRecipe({
      ...routeDecision.gateSelection,
      route: 'DIRECT', checks: [], runtimeSignals: routeDecision.runtimeSignals || {},
      overlaySteps: routeDecision.overlaySteps || routeDecision.overlayExecution || [],
    })
    const namedChecks = [...new Set([...routeRecipe.checks, ...routeRecipe.riskChecks])]
    const priorPass = { code: 'PASS', payload: {
      evidenceIds: ['evidence:prior-checker-pass'],
      referenceMethod: checkerReferenceMethod('requirements-review', 'independent-check-1'),
      testOutcomes: namedChecks.map(command => ({
        command, status: 'PASS',
        fingerprint: crypto.createHash('sha256').update(`prior:${command}`).digest('hex'),
      })),
    } }
    const durableResults = { [scenario.checkerId]: failure }
    if (scenario.checkerCount === 2) durableResults['independent-check-1'] = priorPass
    const pointers = new Map()
    for (const [workItemId, result] of Object.entries(durableResults)) {
      const resultPath = path.join(directory, `${workItemId}.json`)
      fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
      const bytes = fs.readFileSync(resultPath)
      pointers.set(workItemId, {
        name: workItemId, path: resultPath,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      })
    }
    const launches = []
    const verified = []
    const outcome = await createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env, transition: async () => {},
      readResult: workItemId => workItemId === scenario.checkerId
        ? failure
        : scenario.checkerCount === 2 && workItemId === 'independent-check-1' ? priorPass : null,
      resultPointer: workItemId => pointers.get(workItemId),
      verifyDurableResultReceipt: (workItemId, result) => {
        if (workItemId === scenario.checkerId) {
          verified.push(workItemId)
          assert.equal(result, failure)
        } else {
          assert.equal(workItemId, 'independent-check-1')
          assert.equal(result, priorPass)
        }
        return true
      },
      harnessAttestation: (candidateHash, oracle) => ({
        repoHash: candidateHash, buildHash: 'b'.repeat(64),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })({
      route: 'DIRECT', decision: routeDecision,
      launch: async request => {
        launches.push(request.workItemId)
        if (/^work-1-repair-\d+$/u.test(request.workItemId)) {
          fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), `module.exports = '${request.workItemId}'\n`)
          return { allAssignedItemsPass: true }
        }
        const second = /(?:check-2|tester)/u.test(`${request.workItemId}:${request.logicalRole}`)
        return {
          code: 'PASS',
          payload: {
            evidenceIds: [`evidence:${request.workItemId}`],
            referenceMethod: checkerReferenceMethod(second ? 'black-box-boundary' : 'requirements-review', request.workItemId),
            testOutcomes: checkerTestOutcomes(request),
          },
        }
      },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
      resumeState: {
        resumeState: 'CHECK_WORK', completedWorkIds: [
          ...Array.from({ length: scenario.workerCount }, (_, index) => `work-${index + 1}`),
          ...(scenario.name === 'post-repair-terminal-fail' ? ['work-1-repair-1'] : []),
        ],
        completedCheckIds: scenario.checkerCount === 2 ? ['independent-check-1'] : [],
        acceptedResultIds: [], nextReadyWorkIds: scenario.nextReady, retryState: {},
      },
    })
    assert.equal(outcome.outcome, scenario.expect, JSON.stringify(outcome))
    assert.deepEqual(verified, [scenario.checkerId])
    if (scenario.expect === 'DONE') {
      assert.equal(launches[0], scenario.nextReady[0])
      assert.equal(launches.includes('independent-check-2'), false)
    } else {
      assert.deepEqual(launches, [])
    }
  }
})

test('post-retry durable terminal receipt returns the usable candidate without relaunching the legacy checker retry', async t => {
  const directory = tempDirectory(t, 'autoprompt-checker-post-retry-terminal-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently verify the exact recovered result.'],
    nonOverlapReason: null,
  }
  const baseId = 'independent-check-1'
  const retryId = 'independent-check-1-runtime-retry-1'
  const baseResult = { code: 'CHECK_INCONCLUSIVE', cause: { reason: 'durable base transport ended' } }
  const retryResult = { code: 'RUNTIME_FAILURE', cause: { reason: 'durable retry transport ended' } }
  const records = { [baseId]: baseResult, [retryId]: retryResult }
  const pointers = new Map()
  for (const [workItemId, result] of Object.entries(records)) {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, { name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => records[workItemId] || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.deepEqual(result, records[workItemId]); return true
    },
    harnessAttestation: candidateHash => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => { launches.push(request.workItemId); return { code: 'PASS' } },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE', completedWorkIds: ['work-1'], completedCheckIds: [],
      acceptedResultIds: [], nextReadyWorkIds: [],
      retryState: { inconclusiveChecker: {
        checkerId: baseId,
        candidateHash: testWorkspaceCandidateHash(targetPath),
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'CHECK_WORK',
      } },
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(outcome.terminalEnvelope.checkerId, retryId)
  assert.deepEqual(launches, [])
})

test('CHECK_INCONCLUSIVE crash before legacy retry authenticates the base receipt and preserves candidate', async t => {
  const directory = tempDirectory(t, 'autoprompt-checker-before-retry-launch-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently verify the exact recovered result.'],
    nonOverlapReason: null,
  }
  const baseId = 'independent-check-1'
  const retryId = `${baseId}-runtime-retry-1`
  const baseResult = { code: 'CHECK_INCONCLUSIVE', cause: { reason: 'base transport ended' } }
  const resultPath = path.join(directory, `${baseId}.json`)
  fs.writeFileSync(resultPath, `${JSON.stringify(baseResult)}\n`)
  const bytes = fs.readFileSync(resultPath)
  const pointer = { name: baseId, path: resultPath,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const launches = []
  const transitions = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env,
    transition: async eventId => transitions.push(eventId),
    readResult: workItemId => workItemId === baseId ? baseResult : null,
    resultPointer: workItemId => { assert.equal(workItemId, baseId); return pointer },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, baseId); assert.equal(result, baseResult); return true
    },
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE', completedWorkIds: ['work-1'], completedCheckIds: [],
      acceptedResultIds: [], nextReadyWorkIds: [retryId],
      retryState: { inconclusiveChecker: {
        checkerId: baseId, candidateHash,
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'CHECK_WORK',
      } },
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches, [])
  assert.equal(transitions.filter(event => event === 'CHECK_BECAME_CONCLUSIVE').length, 1)
  assert.equal(transitions.filter(event => event === 'CHECK_INCONCLUSIVE').length, 0)
})

test('post-repair checker retry FAIL terminates after the single bounded repair', async t => {
  const directory = tempDirectory(t, 'autoprompt-checker-post-repair-retry-fail-')
  const targetPath = createTempGitTarget(directory)
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired-but-invalid'\n")
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently verify the repaired exact result.'],
    nonOverlapReason: null,
  }
  const baseId = 'independent-check-1-repair-1'
  const retryId = 'independent-check-1-repair-1-runtime-retry-1'
  const baseResult = { code: 'CHECK_INCONCLUSIVE', cause: { reason: 'repair checker transport ended' } }
  const retryResult = { code: 'FAIL', payload: { findingIds: ['AP-RUN-026'] },
    cause: { event: 'ASSERTION_FAILED', reason: 'repair still invalid', unblockPath: 'terminal failure' } }
  const records = { [baseId]: baseResult, [retryId]: retryResult }
  const pointers = new Map()
  for (const [workItemId, result] of Object.entries(records)) {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, { name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => records[workItemId] || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(result, records[workItemId]); return true
    },
    harnessAttestation: versionHash => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      return {
        code: 'PASS',
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE',
      completedWorkIds: ['work-1', 'work-1-repair-1'], completedCheckIds: [],
      acceptedResultIds: [], nextReadyWorkIds: [],
      retryState: { inconclusiveChecker: {
        checkerId: baseId,
        candidateHash: testWorkspaceCandidateHash(targetPath),
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'CHECK_WORK',
      } },
    },
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.code, 'FAIL')
  assert.deepEqual(launches, [])
})

test('crash recovery preserves an identical prior checker-failure stop across repair generations', async t => {
  const directory = tempDirectory(t, 'autoprompt-repeated-failure-recovery-')
  const targetPath = createTempGitTarget(directory)
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repair-one'\n")
  const failure = {
    code: 'FAIL',
    payload: { findingIds: ['AP-RUN-026'] },
    cause: { event: 'ASSERTION_FAILED', reason: 'the identical defect remains', unblockPath: 'change strategy' },
  }
  const records = {
    'independent-check-1': failure,
    'independent-check-1-repair-1': structuredClone(failure),
  }
  const pointers = new Map()
  for (const [workItemId, result] of Object.entries(records)) {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, {
      name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    })
  }
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently verify the repaired result.'],
    nonOverlapReason: null,
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => records[workItemId] || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.deepEqual(result, records[workItemId]); return true
    },
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => { launches.push(request.workItemId); return { allAssignedItemsPass: true } },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', completedWorkIds: ['work-1', 'work-1-repair-1'],
      completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: [], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.deepEqual(launches, [])
})

test('obsolete inconclusive receipt cannot mask the exact later checker failure on recovery', async t => {
  const directory = tempDirectory(t, 'autoprompt-checker-obsolete-receipt-')
  const targetPath = createTempGitTarget(directory)
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'rejected'\n")
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Review requirements.', 'Exercise black-box boundaries.'],
    nonOverlapReason: 'Distinct requirement and boundary evidence.',
  }
  const records = {
    'independent-check-1': { code: 'CHECK_INCONCLUSIVE', cause: { reason: 'obsolete base report' } },
    'independent-check-1-runtime-retry-1': { code: 'PASS', payload: { evidenceIds: ['evidence:retry-pass'] } },
    'independent-check-2': { code: 'FAIL', payload: { findingIds: ['AP-RUN-026'] },
      cause: { event: 'ASSERTION_FAILED', reason: 'active checker defect', unblockPath: 'repair' } },
  }
  const resultPointers = new Map()
  for (const workItemId of ['independent-check-1-runtime-retry-1', 'independent-check-2']) {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(records[workItemId])}\n`)
    const bytes = fs.readFileSync(resultPath)
    resultPointers.set(workItemId, { name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => records[workItemId] || null,
    resultPointer: workItemId => resultPointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(result, records[workItemId]); return true
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1-repair-1') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired'\n")
        return { allAssignedItemsPass: true }
      }
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod(
          request.workItemId.includes('check-2') ? 'black-box-boundary' : 'requirements-review',
          request.workItemId,
        ),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', completedWorkIds: ['work-1'],
      completedCheckIds: ['independent-check-1-runtime-retry-1'], acceptedResultIds: [],
      nextReadyWorkIds: ['work-1-repair-1'], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(launches[0], 'work-1-repair-1')
  assert.equal(launches.includes('independent-check-1'), false)
  assert.equal(launches.includes('independent-check-1-runtime-retry-1'), false)
})

function representativeProbeResult(launch) {
  const assignment = launch.canonicalAssignment
  return {
    schemaVersion: '2.0.0', reportType: 'result', code: 'PASS',
    runId: assignment.runId, assignmentId: launch.workItemId,
    logicalRoleId: launch.logicalRole, physicalRoleId: launch.physicalRole,
    requestEnvelopeHash: assignment.requestEnvelopeHash,
    allAssignedItemsPass: true, filesChanged: [],
    commands: [{ command: 'read-only representative capability probe', exitCode: 0 }],
    successItems: [{
      id: 'representative-policy-probe', description: 'Read-only probe passed.', status: 'pass',
    }],
    findingIds: assignment.findingIds,
    requestedTransition: {
      event: 'WORK_ITEM_VERIFIED', reason: 'Representative policy probe passed.', invalidateEvidenceIds: [],
    },
    contextId: 'context:diagnostic-probe', usage: ZERO_USAGE, evidenceHashes: [CANDIDATE_A],
  }
}

function usableDoneFixture(harness, id) {
  const deliverable = path.join(harness.directory, `${id}.txt`)
  fs.writeFileSync(deliverable, `${id}\n`)
  return {
    outcome: 'DONE',
    deliverables: [deliverable],
    checkHashes: [crypto.createHash('sha256').update(fs.readFileSync(deliverable)).digest('hex')],
  }
}

test('ROADMAP checker terminal receipt preserves an authoritative null runtime candidate', () => {
  const planHash = 'd'.repeat(64)
  assert.equal(resolveTerminalReceiptCandidateHash({
    logicalRole: 'plan-checker',
    runtimeStateProvider: () => ({ candidateHash: null }),
    requestCandidateHash: planHash,
    resultCandidateHash: planHash,
  }), null)
  assert.equal(resolveTerminalReceiptCandidateHash({
    logicalRole: 'plan-checker',
    runtimeStateProvider: null,
    requestCandidateHash: planHash,
    resultCandidateHash: planHash,
  }), planHash)
  assert.equal(resolveTerminalReceiptCandidateHash({
    logicalRole: 'worker',
    runtimeStateProvider: () => ({ candidateHash: null }),
    requestCandidateHash: planHash,
    resultCandidateHash: planHash,
  }), planHash)
})

test('production resume authenticates every ROADMAP projection across the null checkpoint boundary', () => {
  const projectedPlanHash = 'd'.repeat(64)
  const validated = []
  const validateProjection = (_priorHash, hash) => {
    validated.push(hash)
    return hash === projectedPlanHash
  }

  assert.equal(resumePlanProjectionAccepted('ROADMAP', null, null, validateProjection), true)
  assert.deepEqual(validated, [])
  assert.equal(resumePlanProjectionAccepted('ROADMAP', projectedPlanHash, null, validateProjection), true)
  assert.deepEqual(validated, [projectedPlanHash])
  assert.equal(resumePlanProjectionAccepted('ROADMAP', 'e'.repeat(64), null, validateProjection), false)
  assert.equal(resumePlanProjectionAccepted('ROADMAP', null, projectedPlanHash, validateProjection), false)
  assert.equal(resumePlanProjectionAccepted('LIGHT', projectedPlanHash, null, validateProjection), false)
})

test('ROADMAP crash projection binds append-only receipts instead of frontier names', () => {
  const lineage = createRoadmapPlanLineageReceipt({
    priorPlanHash: 'a'.repeat(64),
    replacementPlanHash: 'b'.repeat(64),
    routeDecisionHash: 'c'.repeat(64),
    projectionReceiptHash: 'd'.repeat(64),
    artifactReceiptHash: 'e'.repeat(64),
    transactionReceiptHash: 'f'.repeat(64),
    previousCheckpointSequence: 7,
    previousCheckpointEntryHash: '1'.repeat(64),
    checkpointSequence: 8,
    stateEventSequence: 12,
    accountingSequence: 14,
    schedulerStateHash: '2'.repeat(64),
    causeKind: 'CRASH_RECOVERY',
  })
  assert.match(lineage.lineageReceiptHash, /^[a-f0-9]{64}$/u)
  assert.equal(lineage.previousCheckpointSequence, 7)
  assert.equal(lineage.checkpointSequence, 8)
  assert.equal(lineage.causeKind, 'CRASH_RECOVERY')
  assert.throws(() => createRoadmapPlanLineageReceipt({
    ...lineage,
    previousCheckpointEntryHash: '3'.repeat(64),
    checkpointSequence: 9,
  }), /exact predecessor/)
})

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    const makeRemovable = target => {
      let stat
      try { stat = fs.lstatSync(target) } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return
      fs.chmodSync(target, 0o700)
      for (const name of fs.readdirSync(target)) makeRemovable(path.join(target, name))
    }
    makeRemovable(directory)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function runBoundedNode(argv, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 60_000 : options.timeoutMs
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          encoding: 'utf8', windowsHide: true, timeout: 5_000,
        })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }
    }, timeoutMs)
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr, timedOut, pid: child.pid })
    })
  })
}

function osProcessesReferencingPath(searchPath) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$needle=[Environment]::GetEnvironmentVariable('AUTOPROMPT_TEST_PROCESS_PATH'); @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress",
    ], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, AUTOPROMPT_TEST_PROCESS_PATH: path.resolve(searchPath) },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const parsed = result.stdout.trim() === '' ? [] : JSON.parse(result.stdout)
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.split(/\r?\n/u).filter(line => line.includes(path.resolve(searchPath))).map(line => ({ commandLine: line.trim() }))
}

async function assertNoOsProcessesReferencingPath(searchPath, message) {
  const deadline = Date.now() + 5_000
  let live = []
  do {
    live = osProcessesReferencingPath(searchPath)
    if (live.length === 0) return
    await new Promise(resolve => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  assert.deepEqual(live, [], message)
}

function registeredOwnershipPids(owner, controlRoot) {
  const pids = new Set(owner.listRecords().map(record => record.rootPid).filter(Number.isSafeInteger))
  if (!fs.existsSync(controlRoot)) return [...pids]
  for (const relativePath of fs.readdirSync(controlRoot, { recursive: true })) {
    if (path.basename(String(relativePath)) !== 'status.json') continue
    let status
    try { status = JSON.parse(fs.readFileSync(path.join(controlRoot, relativePath), 'utf8')) } catch { continue }
    for (const value of [status.rootPid, status.helperPid, ...(status.pids || []), ...(status.observedPids || [])]) {
      if (Number.isSafeInteger(value) && value > 0) pids.add(value)
    }
  }
  return [...pids].sort((left, right) => left - right)
}

function liveRegisteredPids(pids) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ids=([Environment]::GetEnvironmentVariable('AUTOPROMPT_TEST_PROCESS_IDS') -split ',' | ForEach-Object {[int]$_}); @(Get-CimInstance Win32_Process | Where-Object {$ids -contains $_.ProcessId} | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress",
    ], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, AUTOPROMPT_TEST_PROCESS_IDS: pids.join(',') },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const parsed = result.stdout.trim() === '' ? [] : JSON.parse(result.stdout)
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  return pids.filter(pid => {
    try { process.kill(pid, 0); return true } catch { return false }
  }).map(pid => ({ processId: pid }))
}

async function assertRegisteredOwnershipPidsDead(owner, controlRoot, message) {
  const registered = registeredOwnershipPids(owner, controlRoot)
  const deadline = Date.now() + 5_000
  let live = []
  do {
    live = liveRegisteredPids(registered)
    if (live.length === 0) return
    await new Promise(resolve => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  assert.deepEqual(live, [], `${message}: registered=${JSON.stringify(registered)}`)
}

function createTempGitTarget(directory) {
  const target = path.join(directory, 'target')
  fs.mkdirSync(path.join(target, 'src'), { recursive: true })
  fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'ready'\n")
  fs.writeFileSync(path.join(target, 'focused.test.cjs'), [
    "'use strict'",
    "const test = require('node:test')",
    "const assert = require('node:assert/strict')",
    "test('fixture remains loadable', () => assert.equal(typeof require('./src/example.js'), 'string'))",
    '',
  ].join('\n'))
  for (const argv of [
    ['init', '-b', 'main', target],
    ['-C', target, 'config', 'user.email', 'autoprompt@example.invalid'],
    ['-C', target, 'config', 'user.name', 'Autoprompt Test'],
    ['-C', target, 'config', 'push.default', 'nothing'],
    ['-C', target, 'add', '--', 'src/example.js', 'focused.test.cjs'],
    ['-C', target, 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', argv, { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  fs.writeFileSync(path.join(target, '.git', 'hooks', 'pre-push'), localSafety.MANAGED_HOOK, {
    mode: 0o755,
  })
  return target
}

function strictLocalProfile() {
  return [
    'sandbox_mode = "workspace-write"', 'web_search = "disabled"', '',
    '[sandbox_workspace_write]', 'network_access = false', '', '[features]',
    'apps = false', 'enable_mcp_apps = false', 'plugins = false',
    'remote_plugin = false', 'browser_use = false', 'browser_use_external = false',
    'in_app_browser = false', 'computer_use = false', 'image_generation = false',
    'multi_agent = false', 'multi_agent_v2 = false', '',
  ].join('\n')
}

function recommendation(route = 'DIRECT') {
  return createRouteRecommendation({
    preWorkResult: 'CONTINUE',
    recommendedRoute: route,
    confidence: 'high',
    whatTheUserWants: ['Implement the bounded requested behavior.'],
    likelyAreas: ['src/example.js'],
    howSuccessCanBeChecked: ['node --test focused.test.cjs'],
    unknowns: [],
    risks: [],
    independentWorkItems: ['One bounded implementation item.'],
    dependencies: [],
    reasonsForDirect: ['The success checklist and check are already known.'],
    reasonsForLight: ['LIGHT would add planning without resolving an uncertainty.'],
    reasonsForRoadmap: ['No dependent work groups require integration.'],
    userInputNeeded: [],
  })
}

function decision(route = 'DIRECT', overrides = {}) {
  const rejected = route === 'DIRECT'
    ? {
        LIGHT: ['No reversible design uncertainty requires a short plan.'],
        ROADMAP: ['No dependent work groups require an integration owner.'],
      }
    : route === 'LIGHT'
      ? {
          DIRECT: ['A short reversible design choice must be ordered first.'],
          ROADMAP: ['No dependent work groups require an integration owner.'],
        }
      : {
          DIRECT: ['Dependent work groups make one bounded worker insufficient.'],
          LIGHT: ['The dependency order needs an integration owner.'],
        }
  return createRouteDecision({
    route,
    routeFacts: {
      schemaVersion: '2.0.0',
      requestedEffect: 'mutate',
      successCriteria: 'ready',
      dependency: {
        shape: route === 'LIGHT' ? 'connected' : route === 'ROADMAP' ? 'dependent-groups' : 'bounded',
        dependentWorkGroupCount: route === 'ROADMAP' ? 2 : 0,
        integrationOwnerRequired: route === 'ROADMAP',
        separateDependentBodies: route === 'ROADMAP' ? 2 : 0,
      },
      uncertainty: route === 'LIGHT' ? 'reversible-technical' : 'none',
      reversibility: 'fully-reversible',
      mutableResources: [{
        kind: 'file', identity: 'src/example.js', shared: false, ownershipMode: 'single-owner',
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
        level: 'ordinary', minimumCheckerCount: 1, namedDistinctResponsibilities: ['focused behavior'],
      },
      checkAndBaseline: {
        checkQuality: 'authoritative', availableCheckKinds: ['focused-test'],
        baselineStatus: 'recorded', hiddenExternalCheck: false,
      },
      deadlineBudget: {
        remainingSeconds: 600, admissionSeconds: 240, executionReserveSeconds: 180,
        verificationReserveSeconds: 120, recoveryAndFinalizationReserveSeconds: 60,
      },
      operatorMinimumRoute: route === 'ROADMAP' ? 'ROADMAP' : null,
      transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true },
      candidateFreeze: { required: true, available: true, environmentCanBeBound: true },
      missingUserInput: [],
      architectureImpact: route === 'ROADMAP' ? 'multi-system' : 'local',
      fitsLightPlan: true,
      approachNeedsShortPlanning: route === 'LIGHT',
      shortOrderUnclear: false,
    },
    mutableResourceOwnership: [{
      kind: 'file', identity: 'src/example.js', owner: 'worker-1', ownershipMode: 'single-owner',
    }],
    requestedResult: ['Implement the bounded requested behavior.'],
    successChecklist: ['The focused behavior check passes.'],
    checks: ['node --test focused.test.cjs'],
    likelyAreas: ['src/example.js'],
    risksAndMissingInformation: [],
    workers: {
      count: 1,
      responsibilities: ['Own the bounded implementation resource.'],
      non_overlap_reason: 'One worker has exclusive ownership of one resource.',
    },
    independentChecks: {
      checker_count: 1,
      responsibilities: ['Independently review and run the focused behavior check.'],
      separate_second_checker_reason: null,
    },
    chosenRouteReasons: ['The recorded facts satisfy this route contract.'],
    rejectedRouteReasons: rejected,
    analystComparison: {
      recommended_route: null,
      agrees: false,
      reason: 'The test L0 decision treats the analyst comparison as unavailable.',
      analyst_facts_fingerprint: 'b'.repeat(64),
      analyst_classifier_fingerprint: 'c'.repeat(64),
    },
    routeChangeTrigger: {
      event: route === 'DIRECT' ? 'SPEC_MISUNDERSTOOD' : 'MULTI_SURFACE_DISCOVERED',
      new_fact_required: true,
      matching_rule: route === 'DIRECT' ? 'DIRECT_TO_LIGHT' : 'LIGHT_TO_ROADMAP',
    },
    gateSelection: {
      baseWorkType: 'implement-build',
      resultFormat: 'new-build',
      artifactOverlays: ['executable-code'],
      acceptanceOverlays: ['failing-to-passing-behavior'],
      riskOverlays: [],
      riskEvidence: {},
    },
    requestEnvelopeHash: 'd'.repeat(64),
    recommendationHash: 'e'.repeat(64),
    ...overrides,
  })
}

function deterministicExactPathPreflight(route = 'DIRECT') {
  return async input => {
    const remainingMs = Number(input.budget?.remaining?.wallMs)
    const verificationReserveMs = Number(input.budget?.verificationReserveMs)
    const finalizationReserveMs = Number(input.budget?.finalizationReserveMs)
    assert.equal(Number.isFinite(remainingMs) && remainingMs > 0, true)
    assert.equal(Number.isFinite(verificationReserveMs) && verificationReserveMs >= 0, true)
    assert.equal(Number.isFinite(finalizationReserveMs) && finalizationReserveMs >= 0, true)
    assert.equal(verificationReserveMs + finalizationReserveMs < remainingMs, true)
    const routeFacts = structuredClone(decision(route).normalizedRouteFacts)
    routeFacts.deadlineBudget = {
      remainingSeconds: remainingMs / 1000,
      admissionSeconds: 0,
      executionReserveSeconds: (remainingMs - verificationReserveMs - finalizationReserveMs) / 1000,
      verificationReserveSeconds: verificationReserveMs / 1000,
      recoveryAndFinalizationReserveSeconds: finalizationReserveMs / 1000,
    }
    return {
      schemaVersion: 1,
      source: 'deterministic-preflight',
      requestEnvelopeHash: input.requestEnvelopeHash,
      targetIdentity: input.targetIdentity,
      providerCapabilitiesHash: input.providerCapabilitiesHash,
      budgetSnapshotHash: input.budgetSnapshotHash,
      evidenceHashes: ['b'.repeat(64)],
      routeFacts,
      verifiedCapabilities: [
        'toolOutputCapture', 'stableChildIdentity', 'cancellation', 'isolatedChecking',
        'processOwnership', 'eventStreaming', 'topologyEnforcement', 'sameContextContinuation',
      ],
    }
  }
}

test('non-authoritative ordinary checker receipts have no fresh retry frontier while FAIL can repair', () => {
  assert.deepEqual(
    checkerRecoveryNextReady('roadmap-plan-check', { code: 'CHECK_INCONCLUSIVE' }),
    ['roadmap-plan-check-runtime-retry'],
  )
  assert.deepEqual(
    checkerRecoveryNextReady('roadmap-plan-check-runtime-retry', { code: 'FAIL' }),
    ['roadmap-author-plan-repair'],
  )
  assert.deepEqual(
    checkerRecoveryNextReady('independent-check-1', { code: 'RUNTIME_FAILURE' }),
    [],
  )
  assert.deepEqual(
    checkerRecoveryNextReady('independent-check-1', { code: 'FAIL' }),
    ['work-1-repair-1'],
  )
  assert.deepEqual(
    checkerRecoveryNextReady('roadmap-plan-recheck-runtime-retry', { code: 'RUNTIME_FAILURE' }),
    [],
  )
})

test('explicitly planned recovery groups preserve their exact join frontier', () => {
  const group = ['roadmap-scout-1', 'roadmap-scout-2']
  const first = {
    workItemId: group[0], recoveryGroupWorkIds: group,
    recoveryJoinWorkIds: ['roadmap-author-revise'], nextReadyAfter: [group[1]],
  }
  const second = { ...first, workItemId: group[1] }
  assert.deepEqual(recoveryGroupNextReady(first, ['roadmap-author']), [group[1]])
  assert.deepEqual(recoveryGroupNextReady(second, ['roadmap-author', group[0]]), ['roadmap-author-revise'])
  assert.deepEqual(recoveryGroupNextReady({ ...second, recoveryJoinWorkIds: [] },
    ['roadmap-author', group[0]]), [])
  assert.throws(() => recoveryGroupNextReady({
    ...first, recoveryGroupWorkIds: [group[0], group[0]],
  }, ['roadmap-author']), error => error.code === 'CHECK_RETRY_STATE_INVALID')
})

test('SPLIT_REQUIRED cannot create workers outside the frozen topology', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-no-dynamic-split-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  const requests = []
  const result = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      requests.push(request)
      return {
        code: 'SPLIT_REQUIRED', allAssignedItemsPass: false, filesChanged: [],
        successItems: [], remainingConcerns: ['api', 'ui'],
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'FAILED')
  assert.equal(result.terminalEnvelope.code, 'IMPLEMENTATION_WORK_INCOMPLETE')
  assert.deepEqual(requests.map(request => request.workItemId), ['work-1'])
})

test('SPLIT_REQUIRED with an exact admitted product advances directly to independent checking', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-split-product-first-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  const requests = []
  const result = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readMutationAdmission: workItemId => {
      if (workItemId !== 'work-1') return null
      const bytes = fs.readFileSync(path.join(targetPath, 'src', 'example.js'))
      return { files: [{ relative: 'src/example.js', hash: crypto.createHash('sha256').update(bytes).digest('hex') }] }
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      requests.push(request)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'usable partial'\n")
        return {
          code: 'SPLIT_REQUIRED', allAssignedItemsPass: false,
          filesChanged: ['src/example.js'], successItems: [], remainingConcerns: ['api', 'ui'],
        }
      }
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(requests.map(request => request.workItemId), ['work-1', 'independent-check-1'])
  assert.equal(requests.some(request => request.workItemId.includes(':split:')), false)
})

test('fresh ROADMAP elides every advisory planner and starts product verification directly', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], { completeProduct: true })
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  const launchedRoles = fixture.harness.launches.map(launch => launch.logicalRole)
  const launchedIds = fixture.harness.launches.map(launch => launch.workItemId)
  assert.equal(launchedRoles.some(role => [
    'roadmap-author', 'scout', 'plan-checker', 'mission-coordinator', 'ap-work-group-manager',
  ].includes(role)), false)
  assert.deepEqual(launchedIds, ['work-1', 'independent-check-1'])
  assert.equal(fixture.routeRequests.get('work-1').parent, 'run-owner')
  assert.equal(fixture.routeRequests.get('work-1').fetchedEvidence.roadmapPlanningFallback.code,
    'DETERMINISTIC_ROADMAP')
})

test('full runtime keeps provider retry but stops non-authoritative checker evidence without fresh launches', async t => {
  const retryId = 'work-1-transport-retry-1'
  const priorHistorySentinel = `PRIOR_PROVIDER_HISTORY_${'h'.repeat(256 * 1024)}`
  const partialCandidate = `module.exports = '${'p'.repeat(640 * 1024)}'\n`
  const retryContextId = `context:${retryId}:${priorHistorySentinel}`
  const fixture = configureRoadmapCompositionHarness(t, [], {
    completeProduct: true,
    transportFailureOnFirstWorker: true,
    transportPartialBeforeFailure: partialCandidate,
    productCheckerCodes: ['MALFORMED_CHECKER_REPORT', 'FAIL', 'PASS'],
    contextIdForLaunch: launch => launch.workItemId === retryId ? retryContextId : null,
  })
  const runtime = new CodexSupervisorRuntime(fixture.harness.runtimeOptions)
  const result = await runtime.start()
  const launchedIds = fixture.harness.launches.map(launch => launch.workItemId)
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(result.terminalEnvelope.controllerReason, 'CHECK_REPORT_INVALID')
  assert.deepEqual(launchedIds, [
    'work-1', retryId,
    'independent-check-1',
  ])
  assert.equal(launchedIds.some(id => id.includes('runtime-retry')), false,
    'no fresh checker runtime retry is admitted')
  assert.equal(fixture.routeRequests.has('work-1-repair-1'), false)
  assert.equal(runtime.workerContexts.has('work-1'), false)
  assert.equal(runtime.workerContexts.get(retryId).contextId, retryContextId)
  assert.equal(result.scheduler.counters.totalLaunches, 3)
  assert.equal(result.scheduler.limits.maxChildLaunches, 8)
  assert.equal(result.scheduler.counters.rejectedByCode.LAUNCH_LIMIT || 0, 0)
})

test('exhausted provider transport successor surfaces its ownership-safe partial candidate without a third model', async t => {
  const partialCandidate = "module.exports = 'transport-partial-candidate'\n"
  const fixture = configureRoadmapCompositionHarness(t, [], {
    completeProduct: true,
    transportFailureOnFirstWorker: true,
    transportPartialBeforeFailure: partialCandidate,
    transportFailureOnWorkerSuccessor: true,
    productCheckerCodes: ['PASS'],
  })

  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
  const launches = fixture.harness.launches.map(item => item.workItemId)

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(launches, [
    'work-1', 'work-1-transport-retry-1', 'independent-check-1',
  ])
  assert.equal(launches.some(id => id.includes('transport-retry-1-transport-retry')), false)
  assert.equal(
    fs.readFileSync(path.join(fixture.harness.runtimeOptions.targetPath, 'src', 'example.js'), 'utf8'),
    partialCandidate,
  )
  assert.deepEqual(result.deliverables.map(item => item.path), [
    path.join(fixture.harness.runtimeOptions.targetPath, 'src', 'example.js'),
  ])
})

test('exhausted provider transport successor with zero admitted diff stays a concrete failure', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], {
    completeProduct: true,
    transportFailureOnFirstWorker: true,
    transportFailureOnWorkerSuccessor: true,
  })

  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
  const launches = fixture.harness.launches.map(item => item.workItemId)

  assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'CHILD_TRANSPORT_TIMEOUT')
  assert.deepEqual(launches, ['work-1', 'work-1-transport-retry-1'])
  assert.equal(
    fs.readFileSync(path.join(fixture.harness.runtimeOptions.targetPath, 'src', 'example.js'), 'utf8'),
    "module.exports = 'ready'\n",
  )
})

test('DONE retry keeps its private promotion transaction across one repair transport successor', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], {
    completeProduct: true,
    doneRetryPromotion: true,
    transportFailureOnRepairBase: true,
    productCheckerCodes: ['FAIL', 'PASS'],
  })

  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
  const launchedIds = fixture.harness.launches.map(launch => launch.workItemId)

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(launchedIds, [
    'work-1', 'independent-check-1',
    'work-1-repair-1', 'work-1-repair-1-transport-retry-1',
    'independent-check-1-repair-1',
  ])
  assert.equal(fixture.deferredPromotionState().status, 'PROMOTED')
  assert.equal(
    fs.readFileSync(path.join(fixture.harness.runtimeOptions.targetPath, 'src', 'example.js'), 'utf8'),
    "module.exports = 'work-1-repair-1-transport-retry-1'\n",
  )
})

test('DONE retry aborts its private promotion when the sole repair transport successor times out', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], {
    completeProduct: true,
    doneRetryPromotion: true,
    transportFailureOnRepairBase: true,
    transportFailureOnRepairSuccessor: true,
    productCheckerCodes: ['FAIL'],
  })

  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
  const launchedIds = fixture.harness.launches.map(launch => launch.workItemId)

  assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.code, 'FAIL')
  assert.equal(result.terminalEnvelope.cause.event, 'ASSERTION_FAILED')
  assert.deepEqual(launchedIds, [
    'work-1', 'independent-check-1',
    'work-1-repair-1', 'work-1-repair-1-transport-retry-1',
  ])
  assert.equal(fixture.deferredPromotionState().status, 'ABORTED')
  assert.equal(
    fs.readFileSync(path.join(fixture.harness.runtimeOptions.targetPath, 'src', 'example.js'), 'utf8'),
    "module.exports = 'ready'\n",
  )
})

test('checker recovery helpers enforce plan-stage adoption, canonical retry completion, PASS-only frontier, and diagnostics', () => {
  assert.equal(adoptedLeaseMatchesStage('ROADMAP', 'plan-checker', 'work'), true)
  assert.equal(adoptedLeaseMatchesStage('ROADMAP', 'plan-checker', 'check'), false)
  assert.equal(adoptedLeaseMatchesStage('DIRECT', 'independent-reviewer', 'check'), true)
  assert.equal(canonicalCompletedCheckerId('roadmap-plan-check-runtime-retry'), 'roadmap-plan-check')
  assert.equal(roadmapPlanOracleForWorkItem('roadmap-plan-recheck'), 'roadmap-plan-oracle-recheck')
  assert.equal(roadmapPlanOracleForWorkItem('roadmap-plan-recheck-runtime-retry'), 'roadmap-plan-oracle-recheck')
  assert.equal(canonicalCompletedCheckerId('independent-check-2-runtime-retry-1'), 'independent-check-2')
  assert.equal(canonicalCompletedCheckerId('independent-check-2-repair-1-runtime-retry-1'), 'independent-check-2')
  assert.equal(checkerVerdictPassed('plan-checker', { code: 'PASS' }), true)
  assert.deepEqual(durableNextReadyAfter(
    'plan-checker', { code: 'FAIL' }, ['mission-coordination'], [], 'roadmap-plan-check'),
  ['roadmap-author-plan-repair'])
  assert.deepEqual(durableNextReadyAfter(
    'plan-checker', { code: 'CHECK_INCONCLUSIVE' }, ['mission-coordination'], [], 'roadmap-plan-check'),
  ['roadmap-plan-check-runtime-retry'])
  assert.deepEqual(durableNextReadyAfter(
    'plan-checker', { code: 'RUNTIME_FAILURE' }, ['mission-coordination'], [], 'roadmap-plan-check'),
  ['roadmap-plan-check-runtime-retry'])
  assert.deepEqual(durableNextReadyAfter('plan-checker', { code: 'PASS' }, ['mission-coordination']),
    ['mission-coordination'])
  assert.deepEqual(terminalFinalizationDiagnostics({
    terminalEnvelope: {
      status: 'CHECK_REMAINS_INCONCLUSIVE',
      cause: { reason: 'checker runtime unavailable', unblockPath: 'restore checker storage' },
    },
  }), {
    terminalEnvelope: {
      status: 'CHECK_REMAINS_INCONCLUSIVE',
      cause: { reason: 'checker runtime unavailable', unblockPath: 'restore checker storage' },
    },
    reason: 'checker runtime unavailable', unblockPath: 'restore checker storage',
  })
})

test('drained legacy advisory adoption cannot relaunch when collapse hints are absent or partial', async t => {
  const cases = [
    ['roadmap-author', 'roadmap-author-revise', 'absent'],
    ['scout', 'roadmap-scout-1', 'partial'],
    ['plan-checker', 'roadmap-plan-check', 'absent'],
    ['mission-coordinator', 'mission-coordination', 'partial'],
    ['ap-work-group-manager', 'roadmap-work-group', 'absent'],
    ['diagnostic-probe', 'conditional-depth-prober', 'partial'],
  ]
  for (const [logicalRole, workItemId, hintMode] of cases) {
    await t.test(`${logicalRole} with ${hintMode} hints`, async () => {
      const leaseId = `lease:${logicalRole}`
      let completed = 0
      let providerLaunches = 0
      const persisted = []
      const terminalSessions = []
      const lease = {
        id: leaseId,
        complete() { completed += 1 },
      }
      const runtime = Object.create(CodexSupervisorRuntime.prototype)
      runtime.route = 'ROADMAP'
      runtime.activation = { generation: 2 }
      runtime.adoptedCrashScheduler = { leases: { [leaseId]: lease } }
      runtime.budget = {
        endSession(sessionId, details) {
          terminalSessions.push({ sessionId, details })
          return { sessionId, ...details }
        },
      }
      runtime.recoveryThreads = new Map([[leaseId, { authenticated: true }]])
      runtime.recoveryCompletedWorkIds = new Set(['work-1'])
      runtime.recoveryCompletedCheckIds = new Set()
      runtime.recoveryAcceptedResultIds = new Set()
      runtime._readChildRecoveryContract = () => null
      runtime._readTerminalReceipt = () => null
      runtime._persistRecoveryCheckpoint = (event, state) => persisted.push({ event, state })
      runtime._launchThroughScheduler = async () => { providerLaunches += 1 }
      const resumeState = {
        schedulerCrashCheckpoint: { authenticated: true },
        completedWorkIds: ['work-1'],
        completedCheckIds: [], acceptedResultIds: [],
        nextReadyWorkIds: [`reconcile:${workItemId}`],
        openLeaseIds: [leaseId],
        adoptedRecords: [{
          id: leaseId, workItemId, logicalRole,
          role: `autoprompt.v2.${logicalRole}`,
          depth: 1,
          crashBinding: {
            sessionId: `session:${logicalRole}`,
            continuationId: `thread:${logicalRole}`,
          },
        }],
      }
      const hints = hintMode === 'partial' ? {
        skipLegacyPlanningRetryIds: ['roadmap-author'],
        skippedPlanningNextReadyWorkIds: [],
      } : {}
      const results = await runtime._resumeAdoptedLaunches({
        resumeState, candidateHash: CANDIDATE_A,
        decision: { usefulWorkerCount: 3 }, stage: 'work', ...hints,
      })

      assert.deepEqual(results, {})
      assert.equal(providerLaunches, 0)
      assert.equal(completed, 1)
      assert.equal(runtime.recoveryThreads.has(leaseId), false)
      assert.deepEqual(terminalSessions, [{
        sessionId: `session:${logicalRole}`,
        details: { status: 'FAILED', evidenceHashes: [] },
      }])
      assert.deepEqual(persisted.at(-1).state.nextReadyWorkIds, ['work-2', 'work-3'])
    })
  }
})

test('ROADMAP CHECK_WORK restart reloads the frozen accepted plan pointer for downstream verification', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-check-resume-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = decision('ROADMAP')
  const acceptedPlan = {
    path: path.join(directory, 'ROADMAP.md'), sha256: CANDIDATE_A, bytes: 97,
  }
  const launches = []
  let pointerReads = 0
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: CANDIDATE_A, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64) }),
    writePlan: () => { throw new Error('accepted plan must not be rewritten on CHECK_WORK restart') },
    planExists: () => true,
    planPointer: () => { pointerReads += 1; return acceptedPlan },
  })
  const outcome = await executor({
    route: 'ROADMAP', decision: routeDecision,
    launch: async request => {
      launches.push(request)
      return {
        code: 'PASS',
        payload: {
          evidenceIds: [`resume-evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod(
            request.workItemId.endsWith('-2') ? 'black-box-boundary' : 'requirements-review',
            request.workItemId,
          ),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK',
      candidateHash: CANDIDATE_A,
      completedWorkIds: ['roadmap-author', 'roadmap-plan-check', 'mission-coordination', 'work-1'],
    },
  })
  assert.equal(outcome.outcome, 'DONE')
  assert.equal(pointerReads, 1)
  assert.ok(launches.length >= 1)
  assert.equal(launches.every(item => item.roadmapSlice === acceptedPlan), true)
})

test('completed same-author continuation restores only from a run, request, and mission-bound context record', t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-context-')
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.options = {
    runId: 'roadmap-context-run',
    resumeState: { completedWorkIds: ['roadmap-author'], completedCheckIds: [], acceptedResultIds: [] },
  }
  runtime.requestPointer = { hash: 'd'.repeat(64) }
  runtime.activation = { id: 'roadmap-context-activation', missionHash: 'e'.repeat(64) }
  runtime.workerContexts = new Map()
  runtime.record = {
    resolve: relative => path.join(directory, ...relative.split('/')),
    write(relative, bytes) {
      const absolute = this.resolve(relative)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, bytes)
    },
  }
  const result = { contextId: 'codex-thread-roadmap-author' }
  const receiptBody = {
    schemaVersion: 1,
    runId: runtime.options.runId,
    activationId: runtime.activation.id,
    workItemId: 'roadmap-author',
    logicalRole: 'worker',
    executorKey: 'roadmap-author',
    continuationId: result.contextId,
    workerContextBindingHash: null,
    assignmentHash: 'a'.repeat(64),
    resultHash: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    result,
  }
  const identity = {
    schemaVersion: 1,
    runId: runtime.options.runId,
    activationId: runtime.activation.id,
    requestEnvelopeHash: runtime.requestPointer.hash,
    missionHash: runtime.activation.missionHash,
    workItemId: 'roadmap-author',
    logicalRole: 'worker',
    executorKey: 'roadmap-author',
    contextId: 'codex-thread-roadmap-author',
  }
  receiptBody.workerContextBindingHash = crypto.createHash('sha256')
    .update(require(path.join(WORKFLOW, 'event-log.js')).stableStringify(identity)).digest('hex')
  const receipt = {
    ...receiptBody,
    receiptHash: crypto.createHash('sha256').update(JSON.stringify(receiptBody)).digest('hex'),
  }
  const receiptRelative = 'work/results/terminal-receipt-context.json'
  runtime.record.write(receiptRelative, `${JSON.stringify(receipt)}\n`)
  runtime.options.resumeState.acceptedResultIds.push(receipt.receiptHash)
  runtime._persistWorkerContext(
    'roadmap-author', 'roadmap-author', result.contextId, 'worker', receipt, receiptRelative,
  )
  runtime.workerContexts.clear()
  runtime._restoreCompletedWorkerContexts()
  assert.deepEqual(runtime.workerContexts.get('roadmap-author'), {
    executorKey: 'roadmap-author', contextId: 'codex-thread-roadmap-author', logicalRole: 'worker',
    contextBindingHash: receiptBody.workerContextBindingHash,
  })
  const foreignBody = {
    ...receiptBody,
    continuationId: 'foreign-codex-thread',
    result: { contextId: 'foreign-codex-thread' },
  }
  foreignBody.resultHash = crypto.createHash('sha256').update(JSON.stringify(foreignBody.result)).digest('hex')
  runtime.record.write(receiptRelative, `${JSON.stringify({
    ...foreignBody,
    receiptHash: crypto.createHash('sha256').update(JSON.stringify(foreignBody)).digest('hex'),
  })}\n`)
  assert.throws(() => runtime._restoreCompletedWorkerContexts(), error => error.code === 'CRASH_ADOPTION_CONFLICT')
  runtime.record.write(receiptRelative, `${JSON.stringify(receipt)}\n`)
  const contextPath = runtime.record.resolve(runtime._workerContextLocation('roadmap-author'))
  const changed = JSON.parse(fs.readFileSync(contextPath, 'utf8'))
  changed.contentHash = 'f'.repeat(64)
  changed.contentPath = `runtime/blobs/${changed.contentHash}`
  fs.writeFileSync(contextPath, `${JSON.stringify(changed)}\n`)
  assert.throws(() => runtime._restoreCompletedWorkerContexts(), error => error.code === 'CRASH_ADOPTION_CONFLICT')
})

test('successful provider retry context is required and restored under its physical retry identity', t => {
  const directory = tempDirectory(t, 'autoprompt-transport-retry-context-')
  const baseId = 'work-1'
  const retryId = `${baseId}-transport-retry-1`
  const contextId = `codex-thread:${retryId}`
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.options = {
    runId: 'transport-retry-context-run',
    resumeState: { completedWorkIds: [retryId], completedCheckIds: [], acceptedResultIds: [] },
  }
  runtime.requestPointer = { hash: 'd'.repeat(64) }
  runtime.activation = { id: 'transport-retry-context-activation', missionHash: 'e'.repeat(64) }
  runtime.workerContexts = new Map()
  runtime.record = {
    resolve: relative => path.join(directory, ...relative.split('/')),
    write(relative, bytes) {
      const absolute = this.resolve(relative)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, bytes)
    },
  }

  assert.throws(
    () => runtime._restoreCompletedWorkerContexts(),
    error => error.code === 'CRASH_ADOPTION_CONFLICT' && /retry continuation is missing/u.test(error.message),
  )

  const result = { contextId }
  const identity = {
    schemaVersion: 1,
    runId: runtime.options.runId,
    activationId: runtime.activation.id,
    requestEnvelopeHash: runtime.requestPointer.hash,
    missionHash: runtime.activation.missionHash,
    workItemId: retryId,
    logicalRole: 'worker',
    executorKey: baseId,
    contextId,
  }
  const receiptBody = {
    schemaVersion: 1,
    runId: runtime.options.runId,
    activationId: runtime.activation.id,
    workItemId: retryId,
    logicalRole: 'worker',
    executorKey: baseId,
    continuationId: contextId,
    workerContextBindingHash: crypto.createHash('sha256')
      .update(require(path.join(WORKFLOW, 'event-log.js')).stableStringify(identity)).digest('hex'),
    assignmentHash: 'a'.repeat(64),
    resultHash: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    result,
  }
  const receipt = {
    ...receiptBody,
    receiptHash: crypto.createHash('sha256').update(JSON.stringify(receiptBody)).digest('hex'),
  }
  const receiptRelative = 'work/results/terminal-receipt-transport-retry.json'
  runtime.record.write(receiptRelative, `${JSON.stringify(receipt)}\n`)
  runtime.options.resumeState.acceptedResultIds.push(receipt.receiptHash)
  runtime._persistWorkerContext(
    retryId, baseId, contextId, 'worker', receipt, receiptRelative,
  )
  runtime.workerContexts.clear()
  runtime._restoreCompletedWorkerContexts()
  assert.equal(runtime.workerContexts.has(baseId), false)
  assert.deepEqual(runtime.workerContexts.get(retryId), {
    executorKey: baseId,
    contextId,
    logicalRole: 'worker',
    contextBindingHash: receiptBody.workerContextBindingHash,
  })

  const pointerPath = runtime.record.resolve(runtime._workerContextLocation(retryId))
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'))
  pointer.contentHash = 'f'.repeat(64)
  pointer.contentPath = `runtime/blobs/${pointer.contentHash}`
  fs.writeFileSync(pointerPath, `${JSON.stringify(pointer)}\n`)
  assert.throws(
    () => runtime._restoreCompletedWorkerContexts(),
    error => error.code === 'CRASH_ADOPTION_CONFLICT',
  )
})

test('hidden external verification strengthens bounded local work without forcing an internal PARTIAL stop', async t => {
  const directory = tempDirectory(t, 'autoprompt-hidden-external-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = decision('DIRECT')
  routeDecision.capturedDomainContracts = [{
    schemaVersion: '1.0.0', kind: 'HIDDEN_EXTERNAL_ORACLE', externalOracleId: 'pixel-oracle',
    verificationRoute: 'EXTERNALLY_VERIFIABLE_ONLY', maxProvisionalWorkerLaunches: 1, localDoneAllowed: false,
  }]
  let persisted = null
  let admitted = null
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: CANDIDATE_A, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64) }),
    writeCapturedDomainAdmission: record => { admitted = record },
    writeCapturedDomainOutcomes: record => { persisted = record },
  })
  const launches = []
  const outcome = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      assert.ok(admitted && admitted.admittedBeforeWork === true, 'domain admission precedes first launch')
      launches.push(request)
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'provisional'\n")
      }
      if (request.logicalRole.startsWith('independent-')) {
        assert.ok(Array.isArray(request.fetchedEvidence.verificationDoctrine))
      }
      return request.logicalRole.startsWith('independent-')
        ? { code: 'PASS', payload: {
            evidenceIds: [`evidence:${request.workItemId}`],
            referenceMethod: checkerReferenceMethod(
              request.workItemId.endsWith('-2') ? 'black-box-boundary' : 'requirements-review',
              request.workItemId,
            ),
            testOutcomes: checkerTestOutcomes(request),
            capturedDomainOutcomes: [{
              schemaVersion: '1.0.0', kind: 'HIDDEN_EXTERNAL_ORACLE',
              verificationRoute: 'EXTERNALLY_VERIFIABLE_ONLY',
              externalBoundaryRecorded: true, localDoneRequested: false,
              externalOracleStatus: 'PASS', externalAcceptanceStatus: 'PASS',
            }],
          } }
        : { reportId: request.workItemId }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(launches.filter(item => item.logicalRole === 'worker').length, 1)
  assert.equal(launches.filter(item => item.logicalRole.startsWith('independent-')).length, 1)
  const assignedChecks = new Set(launches
    .filter(item => item.logicalRole.startsWith('independent-'))
    .flatMap(item => item.checks))
  assert.deepEqual(routeDecision.plannedChecks.filter(check => !assignedChecks.has(check)), [])
  assert.equal(outcome.outcome, 'DONE')
  assert.equal(persisted.evaluation.localDoneAllowed, true)
  assert.deepEqual(outcome.terminalEnvelope.externalVerification, {
    verificationRoute: 'EXTERNALLY_VERIFIABLE_ONLY',
    oracleStatus: 'NOT_RUN',
    acceptanceStatus: 'PENDING',
    localCandidateStatus: 'DONE',
  })
  const externalOutcome = persisted.outcomes.find(item => item.kind === 'HIDDEN_EXTERNAL_ORACLE')
  assert.equal(externalOutcome.externalOracleStatus, 'NOT_RUN')
  assert.equal(externalOutcome.externalAcceptanceStatus, 'PENDING')
  assert.equal(externalOutcome.localCandidateStatus, 'DONE')
  assert.equal(JSON.stringify(externalOutcome).includes('PASS'), false)

  const overCap = JSON.parse(JSON.stringify(routeDecision))
  overCap.usefulWorkerCount = 2
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: overCap, launch: async () => ({}), completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'PROVISIONAL_WORK_CAP_EXCEEDED')
})

test('LIGHT plan preserves semantic risks and unknowns as executable falsification obligations', () => {
  const routeDecision = withExactTwoCheckerPlan(decision('LIGHT'))
  routeDecision.plannedChecks = ['Confirm the output file exists.']
  routeDecision.risks = ['Effective-dated merges may collapse distinct donors before the transition.']
  routeDecision.missingInformation = ['Resolve pre-, at-, and post-effective identity semantics.']
  const plan = renderPlanArtifact('LIGHT', routeDecision)
  assert.match(plan, /Risks to falsify/u)
  assert.match(plan, /collapse distinct donors before the transition/u)
  assert.match(plan, /Information to resolve before editing/u)
  assert.match(plan, /pre-, at-, and post-effective identity semantics/u)
  assert.match(plan, /every explicitly typed case/u)
  assert.match(plan, /strongest applicable counterexamples/u)
  assert.match(plan, /Do not invent undeclared categories/u)
  assert.match(plan, /Seat 2:/u)
  const checking = validateLiveCheckingPlan(routeDecision)
  assert.equal(checking.checkerCount, 2)
  assert.match(checking.responsibilities[1], /collapse distinct donors before the transition/u)
  assert.match(checking.responsibilities[1], /pre-, at-, and post-effective identity semantics/u)
  assert.match(checking.nonOverlapReason, /distinct executable methods/u)
})

test('applicable captured domains are durably admitted and delivered before production work', async t => {
  const directory = tempDirectory(t, 'autoprompt-domain-prework-')
  const targetPath = createTempGitTarget(directory)
  const H = 'a'.repeat(64)
  const H2 = 'b'.repeat(64)
  const H3 = 'c'.repeat(64)
  const H4 = 'd'.repeat(64)
  const contracts = [
    {
      schemaVersion: '1.0.0', kind: 'MISSION_SOURCE_CONFLICT', certificateHash: H,
      sourceDataHash: H2, priorCertificateHash: H4, priorSourceDataHash: H,
      retryAuthority: { mode: 'NEW_SOURCE_DATA', sourceTransitionCertificateHash: H3 },
    },
    {
      schemaVersion: '1.0.0', kind: 'SIGNATURE_SEARCH', strongestInvariantInventoryHash: H,
      secondCandidateFamily: true, identifiabilityProofHash: H2,
    },
    {
      schemaVersion: '1.0.0', kind: 'FIXTURE_PROVENANCE', fixtureProvenanceHash: H,
      mutationReplayHash: H2, initialStatus: 'RED', executablePrebuildValidationRequired: true,
      executablePrebuildValidationHash: H3,
    },
    {
      schemaVersion: '1.0.0', kind: 'IMAGE_DATUM', imageEvidenceHash: H,
      selectedInterpretation: { id: 'top', interpretation: 'z=42 is the top datum' },
      alternativeInterpretations: ['z=42 is center'], rulingHash: H3, certificateHash: H4,
    },
  ]
  const routeDecision = decision('DIRECT')
  routeDecision.normalizedRouteFacts.capturedIncidentDomains = contracts.map(item => item.kind)
  routeDecision.capturedDomainContracts = contracts
  let admission = null
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: H, buildHash: H2, oracleHash: H3 }),
    writeCapturedDomainAdmission: record => {
      admission = record
      return testCapturedDomainPreWorkReceipt(record)
    },
  })
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      assert.equal(admission.admittedBeforeWork, true)
      assert.match(admission.admissionHash, /^[a-f0-9]{64}$/)
      assert.deepEqual(
        request.fetchedEvidence.capturedDomainAdmission.contracts.map(item => item.kind),
        contracts.map(item => item.kind),
      )
      const error = new Error('stop after pre-work admission proof')
      error.code = 'ADMISSION_PROVED'
      throw error
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'ADMISSION_PROVED')

  const missingReceiptExecutor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: H, buildHash: H2, oracleHash: H3 }),
    writeCapturedDomainAdmission: () => undefined,
  })
  await assert.rejects(() => missingReceiptExecutor({
    route: 'DIRECT', decision: routeDecision,
    launch: async () => assert.fail('IMAGE_DATUM work must not launch without its pre-work receipt'),
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'CAPTURED_DOMAIN_ADMISSION_REQUIRED')

  const missing = decision('DIRECT')
  missing.normalizedRouteFacts.capturedIncidentDomains = ['SIGNATURE_SEARCH']
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: missing, launch: async () => assert.fail('work must not launch'),
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'CAPTURED_DOMAIN_ADMISSION_REQUIRED')
})

test('identical NEW_SOURCE_DATA retries are rejected before persistence or launch', async t => {
  const directory = tempDirectory(t, 'autoprompt-identical-source-retry-')
  const targetPath = createTempGitTarget(directory)
  const H = 'a'.repeat(64)
  const H2 = 'b'.repeat(64)
  const routeDecision = decision('DIRECT')
  routeDecision.normalizedRouteFacts.capturedIncidentDomains = ['MISSION_SOURCE_CONFLICT']
  routeDecision.capturedDomainContracts = [{
    schemaVersion: '1.0.0', kind: 'MISSION_SOURCE_CONFLICT', certificateHash: H,
    sourceDataHash: H2, priorCertificateHash: H, priorSourceDataHash: H2,
    retryAuthority: { mode: 'NEW_SOURCE_DATA', sourceTransitionCertificateHash: 'c'.repeat(64) },
  }]
  let persisted = false
  let launched = false
  const executor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    writeCapturedDomainAdmission: () => { persisted = true },
  })
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async () => { launched = true }, completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'CAPTURED_DOMAIN_RETRY_INVALID')
  assert.equal(persisted, false)
  assert.equal(launched, false)
})

test('fixture executable validation must complete before any write-producing launch', async t => {
  const directory = tempDirectory(t, 'autoprompt-fixture-prebuild-')
  const targetPath = createTempGitTarget(directory)
  const H = 'a'.repeat(64)
  const H2 = 'b'.repeat(64)
  const H3 = 'c'.repeat(64)
  const contract = {
    schemaVersion: '1.0.0', kind: 'FIXTURE_PROVENANCE', fixtureProvenanceHash: H,
    mutationReplayHash: H2, initialStatus: 'RED', executablePrebuildValidationRequired: true,
    executablePrebuildValidationHash: H3,
  }
  const routeDecision = decision('DIRECT')
  routeDecision.normalizedRouteFacts.capturedIncidentDomains = [contract.kind]
  routeDecision.capturedDomainContracts = [contract]
  const events = []
  const executor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: () => ({ repoHash: H, buildHash: H2, oracleHash: H3 }),
    writeCapturedDomainAdmission: () => events.push('admitted'),
  })
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      events.push(request.workItemId)
      if (request.workItemId === 'fixture-prebuild-validation') {
        assert.equal(request.logicalRole, 'independent-tester')
        assert.equal(request.writeProducing, false)
        return { code: 'PASS', payload: { capturedDomainOutcomes: [{
          schemaVersion: '1.0.0', kind: 'FIXTURE_PROVENANCE', fixtureProvenanceHash: H,
          mutationReplayHash: H2, initialStatus: 'RED', executablePrebuildValidationStatus: 'PASS',
          executablePrebuildValidationHash: H3,
        }] } }
      }
      assert.deepEqual(events.slice(0, 2), ['admitted', 'fixture-prebuild-validation'])
      const error = new Error('stop after ordering proof')
      error.code = 'PREBUILD_ORDER_PROVED'
      throw error
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'PREBUILD_ORDER_PROVED')

  const missingPrebuildLaunches = []
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      missingPrebuildLaunches.push(request.workItemId)
      if (request.workItemId === 'fixture-prebuild-validation') {
        return { code: 'PASS', payload: { completedAt: '2026-08-23T00:00:00.000Z' } }
      }
      assert.equal(
        request.fetchedEvidence.fixturePrebuildValidation.status,
        'UNRESOLVED_PREBUILD_EVIDENCE',
      )
      throw Object.assign(new Error('worker reached after unresolved prebuild evidence'), {
        code: 'UNRESOLVED_PREBUILD_CONTINUED',
      })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'UNRESOLVED_PREBUILD_CONTINUED')
  assert.deepEqual(missingPrebuildLaunches, ['fixture-prebuild-validation', 'work-1'])

  const validationResult = { code: 'PASS', payload: { capturedDomainOutcomes: [{
    schemaVersion: '1.0.0', kind: 'FIXTURE_PROVENANCE', fixtureProvenanceHash: H,
    mutationReplayHash: H2, initialStatus: 'RED', executablePrebuildValidationStatus: 'PASS',
    executablePrebuildValidationHash: H3,
  }] } }
  const resultPath = path.join(directory, 'fixture-prebuild-validation.json')
  fs.writeFileSync(resultPath, `${JSON.stringify(validationResult)}\n`)
  const resultBytes = fs.readFileSync(resultPath)
  const pointer = { name: 'fixture-prebuild-validation', path: resultPath,
    hash: crypto.createHash('sha256').update(resultBytes).digest('hex'), bytes: resultBytes.length }
  const resumedLaunches = []
  const resumedExecutor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: () => ({ repoHash: H, buildHash: H2, oracleHash: H3 }),
    writeCapturedDomainAdmission: () => {},
    readResult: workItemId => workItemId === 'fixture-prebuild-validation' ? validationResult : null,
    resultPointer: workItemId => { assert.equal(workItemId, 'fixture-prebuild-validation'); return pointer },
    verifyDurableResultReceipt: () => true,
  })
  await assert.rejects(resumedExecutor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      resumedLaunches.push(request.workItemId)
      throw Object.assign(new Error('stop after durable fixture reuse'), { code: 'FIXTURE_REUSED' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'RUN_WORK', completedWorkIds: ['fixture-prebuild-validation'],
      completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: ['work-1'], retryState: {},
    },
  }), error => error.code === 'FIXTURE_REUSED')
  assert.deepEqual(resumedLaunches, ['work-1'])

  fs.writeFileSync(resultPath, '{}\n')
  await assert.rejects(resumedExecutor({
    route: 'DIRECT', decision: routeDecision,
    launch: async () => assert.fail('tampered durable fixture must not relaunch or reach work'),
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'RUN_WORK', completedWorkIds: ['fixture-prebuild-validation'],
      completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: ['work-1'], retryState: {},
    },
  }), error => error.code === 'RESULT_EVIDENCE_POINTER_INVALID' ||
      error.code === 'CRASH_ADOPTION_CONFLICT' || error.code === 'PLAN_CHECK_EVIDENCE_MISSING')
})

test('decision-bound wrong-layer evidence reaches product workers without a diagnostic generation', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-depth-frontier-'))
  const initialDecision = structuredClone(decision('DIRECT'))
  initialDecision.usefulWorkerCount = 2
  initialDecision.workerResponsibilities = ['Complete item one.', 'Complete item two.']
  initialDecision.gateSelection.baseWorkType = 'debug-fix'
  initialDecision.gateSelection.resultFormat = 'changed-files'
  initialDecision.runtimeSignals = { wrongLayerEvidence: true }
  await assert.rejects(createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
  })({
    route: 'DIRECT', decision: initialDecision,
    launch: async request => {
      assert.equal(request.workItemId, 'work-1')
      assert.equal(request.logicalRole, 'worker')
      assert.deepEqual(request.nextReadyAfter, ['work-2'])
      assert.deepEqual(
        request.fetchedEvidence.preProductionDepthDirective.reasons,
        ['wrong-layer-evidence'],
      )
      assert.equal(
        request.fetchedEvidence.preProductionDepthDirective.disposition,
        'PRODUCT_WORKER_INSPECT_IMPLEMENT_VERIFY',
      )
      throw Object.assign(new Error('product directive observed'), { code: 'PRODUCT_DIRECTIVE_OBSERVED' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'PRODUCT_DIRECTIVE_OBSERVED')

  const dynamicDecision = structuredClone(initialDecision)
  dynamicDecision.runtimeSignals = {}
  await assert.rejects(createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
  })({
    route: 'DIRECT', decision: dynamicDecision,
    launch: async request => {
      if (request.workItemId === 'work-1') return {
        allAssignedItemsPass: true,
        payload: { runtimeSignals: {
          wrongLayerEvidence: true, repeatedFailureCount: 0, crossModuleUncertainty: false,
          evidenceIds: ['evidence:wrong-layer'],
        } },
      }
      assert.equal(request.workItemId, 'work-2')
      throw Object.assign(new Error('second product worker observed'), { code: 'SECOND_WORKER_OBSERVED' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'SECOND_WORKER_OBSERVED')
})

test('controller representative proof and wrong-layer directives add no model launch', async t => {
  for (const mode of ['initial', 'live']) {
    await t.test(mode, async t => {
      const target = createTempGitTarget(tempDirectory(t, `autoprompt-controller-depth-${mode}-`))
      const hardened = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
        '--repo', target, '--expected-branch', 'main', '--repair', '--json',
      ], { encoding: 'utf8', windowsHide: true })
      assert.equal([0, 3].includes(hardened.status), true, hardened.stderr || hardened.stdout)
      const routeDecision = structuredClone(decision('DIRECT'))
      routeDecision.gateSelection.baseWorkType = 'debug-fix'
      routeDecision.gateSelection.resultFormat = 'changed-files'
      routeDecision.runtimeSignals = mode === 'initial' ? { wrongLayerEvidence: true } : {}
      const harness = makeHarness(t, {
        runtimeOptions: {
          targetPath: target,
          expectedBranch: 'main',
          gitEnvironment: () => process.env,
          decideRoute: async () => ({
            decision: routeDecision,
            submittedAtMs: 0,
            usage: ZERO_USAGE,
          }),
        },
      })
      harness.runtimeOptions.launcher = async launch => {
        harness.launches.push(launch)
        if (launch.logicalRole === 'route-analyst') {
          return {
            recommendation: recommendation('DIRECT'), events: [], elapsedMs: 1, usage: ZERO_USAGE,
          }
        }
        if (launch.logicalRole === 'diagnostic-probe') {
          assert.fail('wrong-layer evidence must never launch a diagnostic model')
        }
        if (launch.logicalRole === 'worker') {
          if (mode === 'initial') {
            assert.deepEqual(
              launch.dispatch.fetchedEvidence.preProductionDepthDirective.reasons,
              ['wrong-layer-evidence'],
            )
          } else {
            assert.equal(
              launch.dispatch.fetchedEvidence.preProductionDepthDirective,
              undefined,
            )
          }
          fs.writeFileSync(
            path.join(launch.workingDirectory, 'src', 'example.js'),
            `module.exports = 'controller-depth-${mode}'\n`,
          )
          return {
            ...roadmapCompositionRoleResult(launch, [`Complete the ${mode} depth-gate product.`]),
            filesChanged: ['src/example.js'],
          }
        }
        if (launch.logicalRole.startsWith('independent-')) {
          return roadmapCompositionProductCheckResult(
            launch, 'PASS', `The ${mode} depth-gate product passes independent verification.`,
          )
        }
        assert.fail(`unexpected depth-gate role ${launch.logicalRole}`)
      }
      const executor = createDefaultRouteExecutor({
        targetPath: target,
        gitEnvironment: () => process.env,
        transition: async () => {},
        harnessAttestation: candidateHash => ({
          repoHash: candidateHash,
          buildHash: crypto.createHash('sha256').update(`depth-build:${mode}`).digest('hex'),
          oracleHash: crypto.createHash('sha256').update(`depth-oracle:${mode}`).digest('hex'),
        }),
      })
      harness.runtimeOptions.executeRoute = input => executor({ ...input })

      const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

      assert.equal(result.outcome, 'DONE', JSON.stringify(result))
      const physicalDiagnostics = harness.launches.filter(launch =>
        launch.logicalRole === 'diagnostic-probe')
      assert.deepEqual(physicalDiagnostics, [])
      assert.equal(result.schedulerState.attempts['conditional-depth-prober'] || 0, 0)
      assert.equal(result.scheduler.counters.rejectedByCode.DIAGNOSTIC_WORKER_LIMIT || 0, 0)
      assert.equal(result.schedulerState.settings.budget.exactCompletionRequirement,
        codexPhysicalExecutionReceipt(routeDecision).requiredChildLaunches,
        'the exact completion formula reserves no launch for a deterministic controller directive')
      const representativeReceipt = harness.record.writes.get(
        `work/results/${crypto.createHash('sha256')
          .update('representative-role-policy-probe').digest('hex')}.json`,
      )
      assert.ok(representativeReceipt, 'the controller-only representative proof remains durable')
    })
  }
})

test('legacy completed depth-probe receipts are ignored and never gate product work', async t => {
  const directory = tempDirectory(t, 'autoprompt-depth-reuse-')
  const targetPath = createTempGitTarget(directory)
  const gateId = 'conditional-depth-prober'
  const gateResult = { code: 'PASS', payload: { evidenceIds: ['evidence:depth-probe'] } }
  const records = { [gateId]: gateResult }
  const pointers = new Map()
  for (const [workItemId, result] of Object.entries(records)) {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, { name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  const makeDecision = initial => {
    const value = structuredClone(decision('DIRECT'))
    value.usefulWorkerCount = 2
    value.workerResponsibilities = ['Complete item one.', 'Complete item two.']
    value.gateSelection.baseWorkType = 'debug-fix'
    value.gateSelection.resultFormat = 'changed-files'
    value.runtimeSignals = initial ? { wrongLayerEvidence: true } : {}
    return value
  }
  const runResume = async ({ initial, tamper = false }) => {
    const launches = []
    const verified = []
    if (tamper) fs.writeFileSync(pointers.get(gateId).path, '{}\n')
    const execution = createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env, transition: async () => {},
      readResult: workItemId => records[workItemId] || null,
      resultPointer: workItemId => pointers.get(workItemId),
      verifyDurableResultReceipt: workItemId => { verified.push(workItemId); return true },
    })({
      route: 'DIRECT', decision: makeDecision(initial),
      launch: async request => {
        launches.push(request.workItemId)
        throw Object.assign(new Error('stop after authenticated depth reuse'), { code: 'DEPTH_REUSED' })
      },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
      resumeState: initial ? {
        resumeState: 'RUN_WORK', completedWorkIds: [gateId], completedCheckIds: [],
        acceptedResultIds: [], nextReadyWorkIds: ['work-1', 'work-2'], retryState: {},
      } : {
        resumeState: 'ITEM_VERIFIED', completedWorkIds: ['work-1', gateId], completedCheckIds: [],
        acceptedResultIds: [], nextReadyWorkIds: ['work-2'], retryState: {},
      },
    })
    await assert.rejects(execution, error => error.code === 'DEPTH_REUSED')
    assert.deepEqual(launches, [initial ? 'work-1' : 'work-2'])
    assert.equal(verified.includes(gateId), false,
      'obsolete diagnostic bytes are neither authority nor a reason to stop product work')
    if (!initial) assert.equal(verified.includes('work-1'), true)
  }
  await runResume({ initial: true })
  await runResume({ initial: true, tamper: true })
})

test('open legacy depth-probe recovery retires the advisory lease before product work', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-depth-open-collapse-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.gateSelection.baseWorkType = 'debug-fix'
  routeDecision.gateSelection.resultFormat = 'changed-files'
  routeDecision.runtimeSignals = { wrongLayerEvidence: true }
  let adoption = null
  const executor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
  })
  await assert.rejects(executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      assert.equal(request.workItemId, 'work-1')
      assert.deepEqual(
        request.fetchedEvidence.preProductionDepthDirective.reasons,
        ['wrong-layer-evidence'],
      )
      throw Object.assign(new Error('product work reached'), { code: 'PRODUCT_WORK_REACHED' })
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async input => { adoption = input; return {} },
    resumeState: {
      resumeState: 'RUN_WORK', completedWorkIds: [], completedCheckIds: [], acceptedResultIds: [],
      nextReadyWorkIds: ['reconcile:conditional-depth-prober'], retryState: {},
      schedulerCrashCheckpoint: {}, openLeaseIds: ['legacy-depth-lease'],
      adoptedRecords: [{ id: 'legacy-depth-lease', workItemId: 'conditional-depth-prober' }],
    },
  }), error => error.code === 'PRODUCT_WORK_REACHED')
  assert.deepEqual(adoption.skipLegacyPlanningRetryIds, ['conditional-depth-prober'])
  assert.deepEqual(adoption.skippedPlanningNextReadyWorkIds, ['work-1'])
})

test('DONE retry promotes after final acceptance or an explicit bounded limitation, but concrete defects stay private', async t => {
  const directory = tempDirectory(t, 'autoprompt-done-retry-')
  const targetPath = createTempGitTarget(directory)
  const H = 'a'.repeat(64)
  const H2 = 'b'.repeat(64)
  const H3 = 'c'.repeat(64)
  const H4 = 'd'.repeat(64)
  const H5 = 'e'.repeat(64)
  const contract = {
    schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION', priorDoneCandidateHash: H,
    isolationCertificateHash: H3, requiredAcceptanceIds: ['focused'],
  }
  const routeDecision = withExactTwoCheckerPlan(decision('DIRECT'))
  routeDecision.normalizedRouteFacts.capturedIncidentDomains = [contract.kind]
  routeDecision.capturedDomainContracts = [contract]
  const events = []
  const privateCandidate = path.join(directory, 'private-candidate')
  const failedPrivateCandidate = path.join(directory, 'failed-private-candidate')
  fs.cpSync(targetPath, privateCandidate, { recursive: true })
  fs.cpSync(targetPath, failedPrivateCandidate, { recursive: true })
  fs.writeFileSync(path.join(privateCandidate, 'src', 'example.js'), "module.exports = 'accepted-retry'\n")
  fs.writeFileSync(path.join(failedPrivateCandidate, 'src', 'example.js'), "module.exports = 'failed-retry'\n")
  const deferredPromotion = {
    token: 'deferred-token', candidateHash: H2, workspacePath: privateCandidate,
    async commit(join) {
      assert.deepEqual(events, [
        'worker-finished', 'independent-check-1-started', 'independent-check-1-passed',
        'independent-check-2-started', 'independent-check-2-passed',
      ])
      assert.equal(join.candidateHash, H2)
      assert.equal(join.acceptanceJoinHash, H5)
      assert.ok(join.checkHashes.length > 0)
      fs.copyFileSync(path.join(privateCandidate, 'src', 'example.js'), path.join(targetPath, 'src', 'example.js'))
      events.push('promoted')
    },
    async abort() { events.push('aborted') },
  }
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: H2, buildHash: H3, oracleHash: H4 }),
    writeCapturedDomainAdmission: () => events.push('admitted'),
    writeCapturedDomainOutcomes: record => {
      const promoted = record.outcomes.find(item => item.kind === 'DONE_RETRY_PROMOTION')
      if (!promoted) return
      assert.equal(promoted.promotedCandidateHash, H2)
      assert.equal(promoted.promotionCommittedAfterAcceptanceJoin, true)
      events.push('outcomes-persisted')
    },
  })
  const outcome = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      if (request.logicalRole === 'worker') {
        assert.equal(request.deferPromotion, true)
        assert.equal(request.fetchedEvidence.capturedDomainAdmission.admittedBeforeWork, true)
        events.splice(0, events.length, 'worker-finished')
        return { reportId: request.workItemId, deferredPromotion }
      }
      events.push(`${request.workItemId}-started`)
      assert.equal(request.deferredPromotionToken, deferredPromotion.token)
      assert.equal(events.includes('promoted'), false)
      events.push(`${request.workItemId}-passed`)
      if (request.workItemId === 'independent-check-2') {
        return { code: 'PASS', payload: {
          evidenceIds: ['evidence:independent-check-2'],
          referenceMethod: checkerReferenceMethod('black-box-boundary', 'retry boundary'),
          testOutcomes: checkerTestOutcomes(request),
        } }
      }
      return {
        code: 'PASS',
        payload: {
          evidenceIds: ['evidence:independent-check-1'],
          referenceMethod: checkerReferenceMethod('requirements-review', 'retry contract'),
          testOutcomes: checkerTestOutcomes(request),
          capturedDomainOutcomes: [{
          schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION', priorDoneCandidateHash: H,
          isolationCertificateHash: H3, retryCandidateHash: H2, isolatedWorktreeHash: H4,
          isolationVerified: true,
          acceptanceResults: [{ id: 'focused', status: 'PASS', evidenceHash: H4 }],
          acceptanceJoinHash: H5, promotionCandidateHash: H2,
          }],
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(events, [
    'worker-finished', 'independent-check-1-started', 'independent-check-1-passed',
    'independent-check-2-started', 'independent-check-2-passed', 'promoted', 'outcomes-persisted',
  ])

  const failedEvents = []
  const failedHandle = {
    token: 'failed-token', candidateHash: H2, workspacePath: failedPrivateCandidate,
    async commit() { failedEvents.push('promoted') },
    async abort() { failedEvents.push('aborted') },
  }
  const failed = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => request.logicalRole === 'worker'
      ? { deferredPromotion: failedHandle }
      : { code: 'FAIL' },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(failed.outcome, 'FAILED')
  assert.deepEqual(failedEvents, ['aborted'])

  const inconclusiveEvents = []
  const inconclusiveHandle = {
    token: 'inconclusive-token', candidateHash: H2, workspacePath: failedPrivateCandidate,
    async commit(join) {
      assert.equal(join.verificationLimited, true)
      assert.ok(join.verificationLimitations.length >= 1)
      assert.match(join.acceptanceJoinHash, /^[a-f0-9]{64}$/u)
      assert.match(join.domainEvaluationHash, /^[a-f0-9]{64}$/u)
      fs.copyFileSync(
        path.join(failedPrivateCandidate, 'src', 'example.js'),
        path.join(targetPath, 'src', 'example.js'),
      )
      inconclusiveEvents.push('promoted')
    },
    async abort(reason) { inconclusiveEvents.push(`aborted:${reason}`) },
  }
  const beforeInconclusive = fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8')
  const inconclusiveLaunches = []
  const inconclusive = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      inconclusiveLaunches.push(request.workItemId)
      return request.logicalRole === 'worker'
        ? { deferredPromotion: inconclusiveHandle }
        : { code: 'CHECK_INCONCLUSIVE', payload: { unblockPath: 'provide checker scratch storage' } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(inconclusive.outcome, 'DONE', JSON.stringify(inconclusive))
  assert.equal(inconclusive.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8'),
    "module.exports = 'failed-retry'\n")
  assert.notEqual(beforeInconclusive, "module.exports = 'failed-retry'\n")
  assert.equal(inconclusiveLaunches.some(id => id.includes('runtime-retry')), false)
  assert.deepEqual(inconclusiveEvents, ['promoted'])

  const defectEvents = []
  const defectHandle = {
    token: 'defect-token', candidateHash: H2, workspacePath: failedPrivateCandidate,
    async commit() { defectEvents.push('promoted') },
    async abort() { defectEvents.push('aborted') },
  }
  const defectEvidence = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => request.logicalRole === 'worker'
      ? { deferredPromotion: defectHandle }
      : {
          code: 'CHECK_INCONCLUSIVE',
          cause: {
            event: 'DEPENDENCY_UNAVAILABLE',
            reason: 'The report also contains a concrete failing observation.',
            unblockPath: 'Repair the observed defect before acceptance.',
          },
          payload: {
            findingIds: ['CONCRETE-DEFECT-EVIDENCE'],
            testOutcomes: checkerTestOutcomes(request, 'FAIL'),
          },
        },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })
  assert.equal(defectEvidence.outcome, 'DONE')
  assert.equal(defectEvidence.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(defectEvents, ['promoted'])

  const causeOnlyEvents = []
  const causeOnlyHandle = {
    token: 'cause-only-defect-token', candidateHash: H2, workspacePath: failedPrivateCandidate,
    async commit() { causeOnlyEvents.push('promoted') },
    async abort() { causeOnlyEvents.push('aborted') },
  }
  const causeOnlyDefect = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => request.logicalRole === 'worker'
      ? { deferredPromotion: causeOnlyHandle }
      : {
          code: 'CHECK_INCONCLUSIVE',
          cause: {
            event: 'ASSERTION_FAILED',
            reason: 'The exact version violated an observed requirement.',
            unblockPath: 'Repair the exact-version defect.',
          },
          payload: {},
        },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })
  assert.equal(causeOnlyDefect.outcome, 'DONE')
  assert.equal(causeOnlyDefect.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(causeOnlyEvents, ['promoted'])

  const requiredCapabilityEvents = []
  const requiredCapabilityHandle = {
    token: 'required-capability-token', candidateHash: H2, workspacePath: failedPrivateCandidate,
    async commit() { requiredCapabilityEvents.push('promoted') },
    async abort() { requiredCapabilityEvents.push('aborted') },
  }
  const requiredCapability = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => request.logicalRole === 'worker'
      ? { deferredPromotion: requiredCapabilityHandle }
      : {
          code: 'CHECK_INCONCLUSIVE',
          cause: { event: 'DEPENDENCY_UNAVAILABLE', reason: 'A required product capability is missing.' },
          payload: {
            verificationLimitation: {
              kind: 'CAPABILITY_UNAVAILABLE',
              capabilityId: 'required.product-capability',
              explicitUserDeliverable: true,
              observedVersionDefectIds: [],
            },
          },
        },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })
  assert.equal(requiredCapability.outcome, 'FAILED')
  assert.equal(requiredCapability.terminalEnvelope.cause.event, 'DEPENDENCY_UNAVAILABLE')
  assert.deepEqual(requiredCapabilityEvents, ['aborted'])
})

test('DONE retry repairs its private candidate and promotes only after the repaired PASS join', async t => {
  const directory = tempDirectory(t, 'autoprompt-done-retry-private-repair-')
  const targetPath = createTempGitTarget(directory)
  const targetBefore = fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8')
  const privateCandidate = path.join(directory, 'private-repair-candidate')
  fs.cpSync(targetPath, privateCandidate, { recursive: true })
  fs.writeFileSync(path.join(privateCandidate, 'src', 'example.js'),
    "module.exports = 'isolated-defect'\n")
  const initialCandidateHash = testWorkspaceCandidateHash(privateCandidate)
  const priorDoneCandidateHash = 'a'.repeat(64)
  const isolationCertificateHash = 'c'.repeat(64)
  const acceptanceJoinHash = 'e'.repeat(64)
  const routeDecision = decision('DIRECT')
  routeDecision.normalizedRouteFacts.capturedIncidentDomains = ['DONE_RETRY_PROMOTION']
  routeDecision.capturedDomainContracts = [{
    schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION', priorDoneCandidateHash,
    isolationCertificateHash, requiredAcceptanceIds: ['focused'],
  }]
  const pointers = new Map()
  const persist = (workItemId, result) => {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, {
      name: workItemId, path: resultPath, bytes: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    })
    return result
  }
  let commitCount = 0
  let abortCount = 0
  let repairedCandidateHash = null
  const deferredPromotion = {
    token: 'deferred-private-repair-token',
    candidateHash: initialCandidateHash,
    workspacePath: privateCandidate,
    async commit(join) {
      commitCount += 1
      assert.equal(join.candidateHash, repairedCandidateHash)
      assert.equal(fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8'), targetBefore)
      fs.copyFileSync(path.join(privateCandidate, 'src', 'example.js'),
        path.join(targetPath, 'src', 'example.js'))
    },
    async abort() { abortCount += 1 },
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => pointers.get(workItemId),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
    writeCapturedDomainAdmission: () => {},
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return { deferredPromotion }
      if (request.workItemId === 'independent-check-1') {
        return persist(request.workItemId, {
          code: 'FAIL',
          cause: { event: 'ASSERTION_FAILED', reason: 'private defect A', unblockPath: 'repair' },
          payload: {
            findingIds: ['PRIVATE-A'],
            testOutcomes: controllerBoundFailureOutcomes(request, 'PRIVATE-A'),
          },
        })
      }
      if (request.workItemId === 'work-1-repair-1') {
        assert.equal(request.deferredPromotionRepairToken, deferredPromotion.token)
        assert.equal(request.candidateHash, initialCandidateHash)
        assert.equal(fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8'), targetBefore)
        fs.writeFileSync(path.join(privateCandidate, 'src', 'example.js'),
          "module.exports = 'isolated-repaired-pass'\n")
        repairedCandidateHash = testWorkspaceCandidateHash(privateCandidate)
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      assert.equal(request.workItemId, 'independent-check-1-repair-1')
      assert.equal(request.candidateHash, repairedCandidateHash)
      assert.equal(fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8'), targetBefore)
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: ['evidence:private-repaired-pass'],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
          capturedDomainOutcomes: [{
            schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION', priorDoneCandidateHash,
            isolationCertificateHash, retryCandidateHash: request.candidateHash,
            isolatedWorktreeHash: 'd'.repeat(64), isolationVerified: true,
            acceptanceResults: [{ id: 'focused', status: 'PASS', evidenceHash: 'f'.repeat(64) }],
            acceptanceJoinHash, promotionCandidateHash: request.candidateHash,
          }],
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(commitCount, 1)
  assert.equal(abortCount, 0)
  assert.equal(fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8'),
    "module.exports = 'isolated-repaired-pass'\n")
  assert.deepEqual(launches, [
    'work-1', 'independent-check-1', 'work-1-repair-1', 'independent-check-1-repair-1',
  ])
})

test('DONE retry recurring private failure aborts without promoting target bytes', async t => {
  const directory = tempDirectory(t, 'autoprompt-done-retry-private-recurrence-')
  const targetPath = createTempGitTarget(directory)
  const targetBefore = fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8')
  const privateCandidate = path.join(directory, 'private-recurrence-candidate')
  fs.cpSync(targetPath, privateCandidate, { recursive: true })
  fs.writeFileSync(path.join(privateCandidate, 'src', 'example.js'),
    "module.exports = 'isolated-recurring-defect'\n")
  const routeDecision = decision('DIRECT')
  routeDecision.normalizedRouteFacts.capturedIncidentDomains = ['DONE_RETRY_PROMOTION']
  routeDecision.capturedDomainContracts = [{
    schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION',
    priorDoneCandidateHash: 'a'.repeat(64), isolationCertificateHash: 'c'.repeat(64),
    requiredAcceptanceIds: ['focused'],
  }]
  const pointers = new Map()
  const persist = (workItemId, result) => {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, {
      name: workItemId, path: resultPath, bytes: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    })
    return result
  }
  let abortCount = 0
  let commitCount = 0
  const deferredPromotion = {
    token: 'deferred-private-recurrence-token',
    candidateHash: testWorkspaceCandidateHash(privateCandidate),
    workspacePath: privateCandidate,
    async commit() { commitCount += 1 },
    async abort() { abortCount += 1 },
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => pointers.get(workItemId),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
    writeCapturedDomainAdmission: () => {},
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return { deferredPromotion }
      if (request.workItemId === 'work-1-repair-1') {
        assert.equal(request.deferredPromotionRepairToken, deferredPromotion.token)
        fs.writeFileSync(path.join(privateCandidate, 'src', 'example.js'),
          "module.exports = 'isolated-change-same-defect'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      const failure = {
        code: 'FAIL',
        cause: { event: 'ASSERTION_FAILED', reason: 'recurring private defect A', unblockPath: 'repair' },
        payload: {
          findingIds: ['PRIVATE-A'],
          testOutcomes: controllerBoundFailureOutcomes(request, 'PRIVATE-A'),
        },
      }
      return persist(request.workItemId, failure)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.cause.reason, 'recurring private defect A')
  assert.equal(commitCount, 0)
  assert.equal(abortCount, 1)
  assert.equal(fs.readFileSync(path.join(targetPath, 'src', 'example.js'), 'utf8'), targetBefore)
  assert.deepEqual(launches, [
    'work-1', 'independent-check-1', 'work-1-repair-1', 'independent-check-1-repair-1',
  ])
})

test('deferred DONE promotion survives separate-process restarts at every CAS/state/finalize window exactly once', t => {
  const helper = path.join(ROOT, 'tests', 'fixtures', 'codex-deferred-promotion-restart.cjs')
  const runPhase = (configPath, phase, expectedStatus = 0) => {
    const result = spawnSync(process.execPath, [helper, configPath, phase], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    })
    assert.equal(result.status, expectedStatus, `${phase}: ${result.stderr || result.stdout}`)
    return result
  }
  const scenario = name => {
    const directory = tempDirectory(t, `autoprompt-deferred-restart-${name}-`)
    const config = {
      targetPath: createTempGitTarget(directory),
      privateRoot: path.join(directory, 'private'),
      stateFile: path.join(directory, 'deferred.json'),
      logFile: path.join(directory, 'events.log'),
      runId: `run-${name}`,
      activationId: `activation-${name}`,
    }
    const configPath = path.join(directory, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify(config))
    const prepared = runPhase(configPath, 'prepare')
    const candidateHash = prepared.stdout.trim()
    assert.match(candidateHash, /^[a-f0-9]{64}$/)
    assert.equal(fs.readFileSync(path.join(config.targetPath, 'src', 'example.js'), 'utf8'), "module.exports = 'ready'\n")
    return { config, configPath, candidateHash }
  }
  const state = item => JSON.parse(fs.readFileSync(item.config.stateFile, 'utf8'))
  const events = item => fs.readFileSync(item.config.logFile, 'utf8').trim().split(/\r?\n/u)

  const beforeCas = scenario('before-cas')
  runPhase(beforeCas.configPath, 'commit')
  assert.equal(events(beforeCas).filter(item => item === 'CAS').length, 1)
  assert.equal(events(beforeCas).filter(item => item === 'STATE_COMMIT').length, 1)
  assert.equal(events(beforeCas).filter(item => item === 'FINALIZE').length, 1)
  assert.equal(fs.existsSync(state(beforeCas).workspace.workspacePath), false)

  const afterCas = scenario('after-cas')
  runPhase(afterCas.configPath, 'physical-cas')
  runPhase(afterCas.configPath, 'commit')
  assert.equal(events(afterCas).filter(item => item === 'CAS').length, 1)
  assert.equal(events(afterCas).filter(item => item === 'STATE_RECOVER_COMMIT').length, 1)
  assert.equal(events(afterCas).filter(item => item === 'FINALIZE').length, 1)
  assert.equal(fs.existsSync(state(afterCas).workspace.workspacePath), false)

  const afterState = scenario('after-state')
  runPhase(afterState.configPath, 'crash-after-state', 86)
  assert.equal(state(afterState).status, 'PROMOTED')
  assert.equal(events(afterState).filter(item => item === 'CAS').length, 1)
  assert.equal(events(afterState).filter(item => item === 'STATE_COMMIT').length, 1)
  runPhase(afterState.configPath, 'resume-promoted')
  assert.equal(events(afterState).filter(item => item === 'CAS').length, 1)
  assert.equal(events(afterState).filter(item => item === 'STATE_COMMIT').length, 1)
  assert.equal(events(afterState).filter(item => item === 'FINALIZE').length, 1)
  assert.equal(events(afterState).filter(item => item === 'PROMOTED_REPLAY').length, 1)
  assert.equal(fs.existsSync(state(afterState).workspace.workspacePath), false)

  const inconsistent = scenario('promoted-with-prepared-journal')
  const inconsistentState = state(inconsistent)
  const join = {
    candidateHash: inconsistent.candidateHash,
    acceptanceJoinHash: 'a'.repeat(64),
    domainEvaluationHash: 'b'.repeat(64),
    checkHashes: ['c'.repeat(64)],
  }
  inconsistentState.status = 'PROMOTED'
  inconsistentState.join = join
  delete inconsistentState.stateHash
  inconsistentState.stateHash = crypto.createHash('sha256')
    .update(require(path.join(WORKFLOW, 'event-log.js')).stableStringify(inconsistentState))
    .digest('hex')
  fs.writeFileSync(inconsistent.config.stateFile, `${JSON.stringify(inconsistentState, null, 2)}\n`)
  const rejected = runPhase(inconsistent.configPath, 'commit', 1)
  assert.match(rejected.stderr, /DONE_RETRY_RECOVERY_INVALID/u)
  assert.equal(
    fs.readFileSync(path.join(inconsistent.config.targetPath, 'src', 'example.js'), 'utf8'),
    "module.exports = 'ready'\n",
    'recovery must not report a promotion that the workspace journal never committed',
  )
})

test('DONE retry CHECK_WORK restart restores the durable private candidate before checker join', async t => {
  const directory = tempDirectory(t, 'autoprompt-done-retry-check-resume-')
  const targetPath = createTempGitTarget(directory)
  const H = 'a'.repeat(64)
  const H2 = 'b'.repeat(64)
  const H3 = 'c'.repeat(64)
  const H4 = 'd'.repeat(64)
  const H5 = 'e'.repeat(64)
  const contract = {
    schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION', priorDoneCandidateHash: H,
    isolationCertificateHash: H3, requiredAcceptanceIds: ['focused'],
  }
  const routeDecision = withExactTwoCheckerPlan(decision('DIRECT'))
  routeDecision.normalizedRouteFacts.capturedIncidentDomains = [contract.kind]
  routeDecision.capturedDomainContracts = [contract]
  const events = []
  const privateCandidate = path.join(directory, 'private-candidate')
  fs.cpSync(targetPath, privateCandidate, { recursive: true })
  fs.writeFileSync(path.join(privateCandidate, 'src', 'example.js'), "module.exports = 'resumed-retry'\n")
  const handle = {
    token: 'restored-private-token', candidateHash: H2, status: 'PREPARED', workspacePath: privateCandidate,
    async commit(join) {
      events.push('commit')
      assert.equal(join.candidateHash, H2)
      fs.copyFileSync(path.join(privateCandidate, 'src', 'example.js'), path.join(targetPath, 'src', 'example.js'))
    },
    async abort() { events.push('abort') },
  }
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: H2, buildHash: H3, oracleHash: H4 }),
    writeCapturedDomainAdmission: () => {},
    writeCapturedDomainOutcomes: () => events.push('outcomes'),
    restoreDeferredPromotion: async workItemId => {
      events.push(`restore:${workItemId}`)
      return handle
    },
  })
  const outcome = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      events.push(request.workItemId)
      assert.equal(request.deferredPromotionToken, handle.token)
      return {
        code: 'PASS',
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod(
            request.workItemId.endsWith('-2') ? 'black-box-boundary' : 'requirements-review',
            request.workItemId,
          ),
          testOutcomes: checkerTestOutcomes(request),
          capturedDomainOutcomes: request.workItemId === 'independent-check-1' ? [{
          schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION', priorDoneCandidateHash: H,
          isolationCertificateHash: H3, retryCandidateHash: H2, isolatedWorktreeHash: H4,
          isolationVerified: true,
          acceptanceResults: [{ id: 'focused', status: 'PASS', evidenceHash: H4 }],
          acceptanceJoinHash: H5, promotionCandidateHash: H2,
          }] : [],
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash: H2, completedWorkIds: ['work-1'],
    },
  })
  assert.equal(outcome.outcome, 'DONE')
  assert.deepEqual(events, [
    'restore:work-1', 'independent-check-1', 'independent-check-2', 'commit', 'outcomes',
  ])
})

class FakeLock {
  constructor() {
    this.live = null
    this.acquireCalls = 0
    this.releaseCalls = 0
  }

  acquire(options) {
    this.acquireCalls++
    if (this.live) {
      const error = new Error('target already leased')
      error.code = 'WORKSPACE_LEASE_CONFLICT'
      throw error
    }
    this.live = { owner: { targetKey: 'target-key' }, options }
    return this.live
  }

  release(lease) {
    assert.equal(lease, this.live)
    this.live = null
    this.releaseCalls++
  }
}

function makeHarness(t, overrides = {}) {
  const directory = tempDirectory(t, 'autoprompt-supervisor-v2-')
  const configIsolationPath = path.join(directory, 'empty.gitconfig')
  const ghConfigDir = path.join(directory, 'gh-config')
  const profilePath = path.join(directory, 'autoprompt.config.toml')
  const profile = [
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    '',
    '[sandbox_workspace_write]',
    'network_access = false',
    '',
    '[features]',
    'apps = false',
    'enable_mcp_apps = false',
    'plugins = false',
    'remote_plugin = false',
    'browser_use = false',
    'browser_use_external = false',
    'in_app_browser = false',
    'computer_use = false',
    'image_generation = false',
    'multi_agent = false',
    'multi_agent_v2 = false',
    '',
  ].join('\n')
  fs.writeFileSync(configIsolationPath, '', { mode: 0o600 })
  fs.mkdirSync(ghConfigDir, { mode: 0o700 })
  fs.writeFileSync(profilePath, profile, { mode: 0o600 })
  const enforcementProof = {
    schemaVersion: 1,
    provider: 'codex',
    profilePath,
    profileSha256: crypto.createHash('sha256').update(profile).digest('hex'),
    selectedProfile: 'autoprompt',
    strictConfig: true,
  }
  const targetPath = createTempGitTarget(directory)
  const expectedBranch = spawnSync('git', ['-C', targetPath, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim()
  const requestPointer = writeRequestEnvelope(directory, 'Implement the bounded behavior exactly.\n')
  let monotonic = 0
  const missionLock = overrides.missionLock || new FakeLock()
  const processOwner = overrides.processOwner || {
    cancelled: 0,
    drained: 0,
    async cancelAll() { this.cancelled++ },
    async assertDrained() { this.drained++; return true },
  }
  const record = {
    events: [],
    writes: new Map(),
    initializeRouteTranscript() {},
    appendRouteEvent(event) { this.events.push(event) },
    write(name, bytes) { this.writes.set(name, String(bytes)) },
  }
  const finalizations = []
  const launches = []
  const capabilityChecks = []
  const settings = {
    explicit: { concurrency: { mode: 'tokensaver' } },
    capabilities: { modelRouting: false, wideMaxSubs: 10 },
    providerId: 'codex',
  }
  const budget = new BudgetController({
    limits: {
      wallMs: overrides.wallMs || 600000,
      tokens: 1000000,
      sessions: 20,
      launches: overrides.launchLimit || 20,
    },
    finalizationReserveMs: 10,
    phases: {},
    monotonicMs: () => monotonic,
    monotonicClockId: 'test-monotonic',
  })
  const runtimeOptions = {
    activationId: overrides.activationId || 'activation-1',
    activationNonce: 'a'.repeat(32),
    baseEnvironment: process.env,
    budgetController: budget,
    capabilityVerifier: async binding => {
      capabilityChecks.push(binding)
      return { verified: true, source: 'signed-test-dispatcher' }
    },
    checkerSnapshotFactory(checkerId) {
      const snapshot = path.join(directory, `${checkerId}-snapshot-${crypto.randomBytes(4).toString('hex')}`)
      const snapshotSource = overrides.runtimeOptions && overrides.runtimeOptions.targetPath || targetPath
      const clone = spawnSync('git', ['clone', '--quiet', '--no-local', '--no-hardlinks', '--', snapshotSource, snapshot], { encoding: 'utf8' })
      assert.equal(clone.status, 0, clone.stderr)
      const snapshotBranch = overrides.runtimeOptions && overrides.runtimeOptions.expectedBranch || expectedBranch
      const hardenedSnapshot = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
        '--repo', snapshot, '--expected-branch', snapshotBranch, '--repair', '--json',
      ], { encoding: 'utf8', windowsHide: true })
      assert.equal([0, 3].includes(hardenedSnapshot.status), true, hardenedSnapshot.stderr || hardenedSnapshot.stdout)
      const exactNames = repository => {
        const listed = spawnSync(
          'git', ['-C', repository, 'ls-files', '-co', '--exclude-standard', '-z'],
          { encoding: null, env: process.env, windowsHide: true },
        )
        assert.equal(listed.status, 0, String(listed.stderr || ''))
        return Buffer.from(listed.stdout).toString('utf8').split('\0').filter(Boolean)
      }
      const sourceNames = exactNames(snapshotSource)
      const sourceNameSet = new Set(sourceNames)
      for (const relative of exactNames(snapshot)) {
        if (sourceNameSet.has(relative)) continue
        const target = path.join(snapshot, ...relative.split('/'))
        if (fs.existsSync(target)) fs.unlinkSync(target)
      }
      for (const relative of sourceNames) {
        const source = path.join(snapshotSource, ...relative.split('/'))
        const target = path.join(snapshot, ...relative.split('/'))
        const stat = fs.lstatSync(source)
        assert.equal(stat.isFile() && !stat.isSymbolicLink(), true)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, target)
        fs.chmodSync(target, stat.mode & 0o777)
      }
      return snapshot
    },
    checkerScratchFactory(checkerId, frozenCandidateRoot, context = {}) {
      const writableScratchRoot = fs.mkdtempSync(path.join(directory, `${checkerId}-scratch-`))
      const temporaryRoot = path.join(writableScratchRoot, 'tmp')
      const outputRoot = path.join(writableScratchRoot, 'output')
      const cacheRoot = path.join(writableScratchRoot, 'cache')
      for (const child of [temporaryRoot, outputRoot, cacheRoot]) fs.mkdirSync(child, { mode: 0o700 })
      return Object.freeze({
        schemaVersion: 1, runId: overrides.runId || 'run-1', checkerId,
        candidateHash: context.candidateHash,
        frozenCandidateRoot: path.resolve(frozenCandidateRoot),
        writableScratchRoot, temporaryRoot, outputRoot, cacheRoot,
        capability: 'a'.repeat(64),
      })
    },
    decideRoute: overrides.decideRoute || (async () => ({
      decision: decision('DIRECT'), submittedAtMs: monotonic, usage: ZERO_USAGE,
    })),
    executeRoute: overrides.executeRoute,
    finalizerFactory: async ({ lease }) => ({
      async finalize(input) {
        finalizations.push(input)
        missionLock.release(lease)
        return { terminal: input.outcome }
      },
    }),
    launcher: async launch => {
      launches.push(launch)
      if (launch.logicalRole === 'route-analyst') {
        return { recommendation: recommendation('DIRECT'), events: [{ type: 'analysis', summary: 'bounded' }], elapsedMs: 1, usage: ZERO_USAGE }
      }
      if (launch.logicalRole === 'run-owner') {
        return { decision: decision('DIRECT'), submittedAtMs: monotonic, usage: ZERO_USAGE }
      }
      if (launch.logicalRole === 'diagnostic-probe') {
        return representativeProbeResult(launch)
      }
      return { contextId: `context:${launch.logicalRole}`, usage: ZERO_USAGE, evidenceHashes: [] }
    },
    lock: {
      targetPath: directory,
      ledgerPath: path.join(directory, '.autoprompt'),
      pid: 123,
      processIdentity: 'fake-process-identity',
    },
    mission: 'Implement the bounded behavior exactly.',
    missionLock,
    modelRegistry: MODEL_REGISTRY,
    now: () => monotonic,
    monotonicNow: () => monotonic,
    processOwner,
    providerCapabilities: PROVIDER_CAPABILITIES,
    recordFactory: async () => record,
    requestPointerFactory: async () => requestPointer,
    rolePolicy: new RolePolicy(),
    runId: overrides.runId || 'run-1',
    settings,
    targetIdentity: 'target-id',
    configIsolationPath,
    enforcementProof,
    expectedBranch,
    ghConfigDir,
    targetPath,
    ...overrides.runtimeOptions,
  }
  return {
    advance(milliseconds) { monotonic += milliseconds },
    currentTime() { return monotonic },
    budget,
    capabilityChecks,
    directory,
    finalizations,
    launches,
    missionLock,
    processOwner,
    record,
    runtimeOptions,
  }
}

function manualTimerApi() {
  let now = 0
  let nextId = 1
  const pending = new Map()
  return {
    setTimeout(callback, milliseconds) {
      const id = nextId++
      pending.set(id, { callback, deadline: now + Number(milliseconds) })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
    advance(milliseconds) {
      const target = now + Number(milliseconds)
      while (true) {
        const ready = [...pending.entries()]
          .filter(([, timer]) => timer.deadline <= target)
          .sort((left, right) => left[1].deadline - right[1].deadline || left[0] - right[0])[0]
        if (!ready) break
        const [id, timer] = ready
        pending.delete(id)
        now = timer.deadline
        timer.callback()
      }
      now = target
    },
    pendingCount() { return pending.size },
  }
}

async function flushMicrotasks(turns = 12) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

test('required local child can stay stdout-silent past the analyst watchdog and still complete', async t => {
  const timerApi = manualTimerApi()
  const harness = makeHarness(t, {
    activationId: 'activation-required-silence',
    runId: 'run-required-silence',
    runtimeOptions: {
      childTransportWatchdogMs: 5,
      timerApi,
      settings: run030ExactSettings(),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
    },
  })
  let announceLaunch
  let resolveChild
  let timeoutStops = 0
  const childLaunched = new Promise(resolve => { announceLaunch = resolve })
  harness.runtimeOptions.onChildTransportTimeout = async () => {
    timeoutStops += 1
    return { drained: true }
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const child = await launch({
      workItemId: 'silent-required-worker', logicalRole: 'worker', parent: 'run-owner',
      purpose: 'work', assignment: 'Complete the healthy long local reasoning turn.',
      success: ['The required local result completes.'], checks: ['healthy long completion'],
    })
    assert.equal(child.allAssignedItemsPass, true)
    return usableDoneFixture(harness, 'silent-required-result')
  }
  harness.runtimeOptions.launcher = launch => {
    assert.equal(launch.logicalRole, 'worker')
    assert.equal(launch.onTransportActivity, undefined,
      'required local completion must not receive a silence watchdog callback')
    announceLaunch()
    return new Promise(resolve => {
      resolveChild = () => resolve({
        ...roadmapCompositionRoleResult(launch, ['Complete after a healthy silent interval.']),
        contextId: `context:${launch.workItemId}`,
      })
    })
  }
  const runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
  let settled = false
  const started = runtime.start().then(result => { settled = true; return result })
  await childLaunched
  timerApi.advance(60_000)
  await flushMicrotasks()
  assert.equal(settled, false)
  assert.equal(timeoutStops, 0)
  resolveChild()
  const result = await started
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(timeoutStops, 0)
})

test('optional pre-route analyst timeout drains once and conservative local work continues', async t => {
  const timerApi = manualTimerApi()
  const harness = makeHarness(t, {
    activationId: 'activation-analyst-timeout',
    runId: 'run-analyst-timeout',
    runtimeOptions: { childTransportWatchdogMs: 5, timerApi },
  })
  let announceAnalyst
  const analystLaunched = new Promise(resolve => { announceAnalyst = resolve })
  let analystStops = 0
  let productLaunches = 0
  harness.runtimeOptions.onChildTransportTimeout = async input => {
    assert.equal(input.logicalRole, 'route-analyst')
    analystStops += 1
    return { drained: true }
  }
  harness.runtimeOptions.executeRoute = async ({ route, launch }) => {
    assert.equal(route, 'DIRECT')
    const child = await launch({
      workItemId: 'post-analyst-worker', logicalRole: 'worker', parent: 'run-owner',
      purpose: 'work', assignment: 'Continue from the conservative route fallback.',
      success: ['Local product work completes.'], checks: ['fallback product completion'],
    })
    assert.equal(child.allAssignedItemsPass, true)
    return usableDoneFixture(harness, 'post-analyst-result')
  }
  harness.runtimeOptions.launcher = launch => {
    if (launch.logicalRole === 'route-analyst') {
      assert.equal(typeof launch.onTransportActivity, 'function')
      announceAnalyst()
      return new Promise(() => {})
    }
    productLaunches += 1
    assert.equal(launch.onTransportActivity, undefined)
    return Promise.resolve({
      ...roadmapCompositionRoleResult(launch, ['Complete after conservative route fallback.']),
      contextId: `context:${launch.workItemId}`,
    })
  }
  const started = new CodexSupervisorRuntime(harness.runtimeOptions).start()
  await analystLaunched
  timerApi.advance(5)
  await flushMicrotasks(30)
  const result = await started
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(analystStops, 1)
  assert.equal(productLaunches, 1)
})

test('conclusively dead required transport uses exactly one bounded fresh retry', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], {
    completeProduct: true,
    transportFailureOnFirstWorker: true,
    transportFailureCode: 'CODEX_CHILD_FAILED',
    productCheckerCodes: ['PASS'],
  })
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(fixture.harness.launches
    .filter(launch => launch.logicalRole === 'worker')
    .map(launch => launch.workItemId), [
      'work-1', 'work-1-transport-retry-1',
    ])
})

test('full supervisor reconciles every transient local callback after drain without another model turn', async t => {
  const boundaries = [
    'transcript',
    'first-signal',
    'session',
    'usage',
    'terminal-receipt',
    'canonical-result',
    'RESULT_COMMITTED',
  ]
  for (const boundary of boundaries) {
    await t.test(boundary, async t => {
      const workItemId = `callback-${boundary}`
      const harness = makeHarness(t, {
        activationId: `activation-${boundary}`,
        runId: 'run-callback-1',
      })
      const baseWrite = harness.record.write.bind(harness.record)
      harness.record.resolve = relative => path.join(harness.directory, relative)
      let armed = false
      let injected = 0
      let reconciled = 0
      let drainReached = false
      let modelRuns = 0
      let transcriptSequence = 0
      const transientFailure = () => Object.assign(
        new Error(`transient ${boundary} persistence failure`),
        { code: 'EIO' },
      )
      const injectOnce = selected => {
        if (!armed || boundary !== selected || injected > 0) return false
        injected += 1
        throw transientFailure()
      }
      harness.record.write = (relative, bytes) => {
        if (boundary === 'terminal-receipt' && armed &&
            relative.startsWith('work/results/terminal-receipt-')) injectOnce('terminal-receipt')
        const canonicalResult = `work/results/${crypto.createHash('sha256').update(workItemId).digest('hex')}.json`
        if (boundary === 'canonical-result' && armed && relative === canonicalResult) {
          injectOnce('canonical-result')
        }
        fs.mkdirSync(path.dirname(harness.record.resolve(relative)), { recursive: true })
        fs.writeFileSync(harness.record.resolve(relative), String(bytes))
        baseWrite(relative, bytes)
        if (armed && ((boundary === 'terminal-receipt' &&
            relative.startsWith('work/results/terminal-receipt-')) ||
            (boundary === 'canonical-result' && relative === canonicalResult)) && injected > 0) {
          assert.equal(drainReached, true)
          reconciled += 1
        }
      }
      harness.runtimeOptions.transcriptStoreFactory = ({ request }) => ({
        append({ raw }) {
          if (request.workItemId === workItemId) injectOnce('transcript')
          transcriptSequence += 1
          if (boundary === 'transcript' && injected > 0) {
            assert.equal(drainReached, true)
            reconciled += 1
          }
          const bytes = Buffer.byteLength(String(raw), 'utf8')
          return {
            sequence: transcriptSequence,
            path: path.join(harness.directory, `transcript-${transcriptSequence}.json`),
            hash: crypto.createHash('sha256').update(String(raw)).digest('hex'),
            bytes,
          }
        },
      })
      harness.runtimeOptions.persistSchedulerCheckpoint = input => {
        if (input.request.workItemId === workItemId && input.continuationId) injectOnce('session')
        if (boundary === 'session' && injected > 0 && input.continuationId) {
          assert.equal(drainReached, true)
          reconciled += 1
        }
      }
      harness.runtimeOptions.accountingAuthority = {
        checkpoint(input) {
          if (armed && input.cause.kind === 'TOKEN_USAGE_RECORDED') injectOnce('usage')
          if (boundary === 'usage' && injected > 0 &&
              input.cause.kind === 'TOKEN_USAGE_RECORDED') {
            assert.equal(drainReached, true)
            reconciled += 1
          }
          return { record: { sequence: 1 } }
        },
      }
      harness.runtimeOptions.persistRecoveryCheckpoint = input => {
        if (armed && input.cause.kind === 'RESULT_COMMITTED') injectOnce('RESULT_COMMITTED')
        if (boundary === 'RESULT_COMMITTED' && injected > 0 &&
            input.cause.kind === 'RESULT_COMMITTED') {
          assert.equal(drainReached, true)
          reconciled += 1
        }
        return null
      }
      harness.runtimeOptions.executeRoute = async ({ launch }) => {
        const result = await launch({
          workItemId,
          logicalRole: 'worker',
          parent: 'run-owner',
          purpose: 'work',
          assignment: 'Produce one callback-reconciliation result.',
          success: ['The exact frozen result is persisted once.'],
          checks: ['callback reconciliation'],
        })
        assert.equal(result.allAssignedItemsPass, true)
        return usableDoneFixture(harness, `${boundary}-callback-result`)
      }
      let runtime
      const baseLauncher = harness.runtimeOptions.launcher
      const runner = {
        async run(spec) {
          modelRuns += 1
          const launch = runner.launch
          const continuationId = crypto.randomUUID()
          const result = adapterWorkerResult({
            reportId: `callback-result:${boundary}`,
            runId: 'run-callback-1',
            assignmentId: workItemId,
            physicalRoleId: launch.physicalRole,
            requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
            findingIds: [...launch.canonicalAssignment.findingIds],
            behaviorChanged: ['The callback result is frozen.'],
          })
          spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: continuationId }))
          spec.onStdoutLine(JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'product-edit', type: 'file_change', status: 'completed',
              changes: [{ path: 'callback-result.txt', kind: 'update' }],
            },
          }))
          spec.onStdoutLine(JSON.stringify({
            type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) },
          }))
          spec.onStdoutLine(JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 4, reasoning_tokens: 4 },
          }))
          return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
        },
        async stop() {
          drainReached = true
          return { drained: true }
        },
      }
      const adapter = new CodexExecAdapter({
        runner,
        targetPath: harness.runtimeOptions.targetPath,
        profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
        outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
      })
      harness.runtimeOptions.launcher = async launch => {
        if (launch.logicalRole === 'route-analyst') return baseLauncher(launch)
        assert.equal(launch.workItemId, workItemId)
        runner.launch = launch
        armed = true
        if (boundary === 'first-signal') {
          const original = runtime.scheduler.recordFirstProductSignal.bind(runtime.scheduler)
          runtime.scheduler.recordFirstProductSignal = measurement => {
            injectOnce('first-signal')
            const receipt = original(measurement)
            if (injected > 0) {
              assert.equal(drainReached, true)
              reconciled += 1
            }
            return receipt
          }
        }
        return adapter.launch(launch)
      }
      runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
      const result = await runtime.start()
      assert.equal(result.outcome, 'DONE', JSON.stringify(result))
      assert.equal(injected, 1)
      assert.ok(reconciled >= 1, `${boundary} was not replayed after drain`)
      assert.equal(modelRuns, 1)
      assert.deepEqual(result.scheduler.usage.work, {
        noncachedInput: 1, cachedInput: 2, output: 4, reasoning: 4,
        weightedCost: 0, latencyMs: 0, workMs: 0,
      })
      assert.equal(result.schedulerState.attempts[workItemId], 1)
    })
  }
})

test('full supervisor never reconciles forged session or invalid checker semantics as local persistence', async t => {
  for (const fault of ['forged-session', 'invalid-checker']) {
    await t.test(fault, async t => {
      const directory = tempDirectory(t, `autoprompt-callback-${fault}-`)
      const isolatedTarget = createTempGitTarget(directory)
      const targetPath = isolatedTarget
      const targetBranch = spawnSync(
        'git', ['-C', targetPath, 'branch', '--show-current'], { encoding: 'utf8' },
      ).stdout.trim()
      const runId = `run-callback-${fault}`
      const harness = makeHarness(t, {
        activationId: `activation-callback-${fault}`,
        runId,
        runtimeOptions: {
          targetPath, expectedBranch: targetBranch,
          gitEnvironment: () => process.env,
        },
      })
      harness.runtimeOptions.settings.explicit.path = 'direct'
      harness.runtimeOptions.exactPathPreflight = deterministicExactPathPreflight('DIRECT')
      harness.record.resolve = relative => path.join(harness.directory, relative)
      const candidateHash = testWorkspaceCandidateHash(targetPath)
      const workItemId = `callback-${fault}`
      let modelRuns = 0
      let launchRecord = null
      harness.runtimeOptions.executeRoute = async ({ launch }) => {
        const request = fault === 'invalid-checker'
          ? {
              workItemId,
              logicalRole: 'independent-reviewer',
              parent: 'run-owner',
              purpose: 'verification',
              assignment: 'Independently check the exact frozen callback candidate.',
              success: ['The exact candidate is checked against the named acceptance case.'],
              checks: ['Run the callback acceptance case.'],
              candidateHash,
              harnessAttestation: {
                repoHash: candidateHash,
                buildHash: crypto.createHash('sha256').update('callback-build').digest('hex'),
                oracleHash: crypto.createHash('sha256').update('callback-oracle').digest('hex'),
              },
            }
          : {
              workItemId,
              logicalRole: 'worker',
              parent: 'run-owner',
              purpose: 'work',
              assignment: 'Produce one callback identity result.',
              success: ['The terminal identity remains bound to its provider session.'],
              checks: ['callback session identity'],
            }
        await launch(request)
        assert.fail('a semantic callback-integrity failure must not return a child result')
      }
      const baseLauncher = harness.runtimeOptions.launcher
      const runner = {
        async run(spec) {
          modelRuns += 1
          const launch = launchRecord
          const continuationId = crypto.randomUUID()
          const output = fault === 'invalid-checker'
            ? {
                schemaVersion: '2.0.0', code: 'PASS',
                description: 'The checked result satisfies every requirement assigned to this check.',
                stateClass: 'terminal', runId: 'foreign-checker-run',
                requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
                currentVersionHash: launch.candidateHash,
                completedResults: [], nextReadyWork: [],
                cause: {
                  event: 'CHECK_COMPLETE', reason: 'The forged checker claims completion.',
                  unblockPath: null,
                },
                payloadSchemaId: 'autoprompt.callback-check.v2',
                payload: {
                  evidenceIds: ['callback-check-evidence'],
                  referenceMethod: checkerReferenceMethod('requirements-review', workItemId),
                  testOutcomes: checkerTestOutcomes(launch),
                },
                recordedAt: '2026-08-28T00:00:00.000Z',
              }
            : adapterWorkerResult({
                reportId: 'callback-forged-session-result', runId,
                assignmentId: workItemId, physicalRoleId: launch.physicalRole,
                requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
                findingIds: [...launch.canonicalAssignment.findingIds],
              })
          spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: continuationId }))
          spec.onStdoutLine(JSON.stringify({
            type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) },
          }))
          spec.onStdoutLine(JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
          }))
          return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
        },
        async stop() { return { drained: true } },
      }
      const adapter = new CodexExecAdapter({
        runner, targetPath,
        profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
        checkerScratchVerifier: launch => launch.checkerScratchBoundary,
        outputSchemaResolver: launch => path.join(
          ROOT, 'agents', 'contracts', 'schemas',
          launch.logicalRole.startsWith('independent-') ? 'outcome.schema.json' : 'role-report.schema.json',
        ),
      })
      harness.runtimeOptions.launcher = async launch => {
        if (launch.logicalRole === 'route-analyst') return baseLauncher(launch)
        launchRecord = launch
        if (fault === 'forged-session') {
          const onTerminalResult = launch.onTerminalResult
          launch = {
            ...launch,
            onTerminalResult(result, evidence) {
              return onTerminalResult(result, {
                ...evidence,
                sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              })
            },
          }
          launchRecord = launch
        }
        return adapter.launch(launch)
      }
      const runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
      const result = await runtime.start()
      assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
      assert.equal(result.terminalEnvelope.error.code,
        fault === 'invalid-checker' ? 'CHECK_REPORT_INVALID' : 'CRASH_ADOPTION_CONFLICT',
      JSON.stringify(result))
      assert.equal(modelRuns, 1)
      assert.equal(result.schedulerState.attempts[workItemId], 1)
      assert.equal([...harness.record.writes.keys()].some(name =>
        name.includes('callback-reconciliation-')), false)
    })
  }
})

test('persistent transcript callback outage degrades locally without stopping the frozen valid result', async t => {
  const workItemId = 'callback-persistent-outage'
  const harness = makeHarness(t, {
    activationId: 'activation-callback-persistent',
    runId: 'run-callback-persistent',
  })
  harness.runtimeOptions.settings.explicit.path = 'direct'
  harness.runtimeOptions.exactPathPreflight = deterministicExactPathPreflight('DIRECT')
  harness.record.resolve = relative => path.join(harness.directory, relative)
  let callbackAttempts = 0
  let modelRuns = 0
  let launchRecord = null
  harness.runtimeOptions.transcriptStoreFactory = ({ request }) => ({
    append() {
      if (request.workItemId === workItemId) {
        callbackAttempts += 1
        throw Object.assign(new Error('persistent local transcript outage'), { code: 'EIO' })
      }
      return {
        sequence: 1, path: path.join(harness.directory, 'route-transcript.jsonl'),
        hash: 'a'.repeat(64), bytes: 1,
      }
    },
  })
  let callbackDegradation = null
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const launched = await launch({
      workItemId, logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
      assignment: 'Produce the persistent-callback candidate.',
      success: ['The completed candidate remains resumable after local persistence loss.'],
      checks: ['persistent callback candidate'],
    })
    callbackDegradation = launched.localCallbackReconciliation
    return {
      outcome: 'PARTIAL',
      terminalEnvelope: {
        status: 'CHECK_REMAINS_INCONCLUSIVE',
        cause: { reason: 'test route stops after proving callback degradation' },
      },
    }
  }
  const baseLauncher = harness.runtimeOptions.launcher
  const runner = {
    async run(spec) {
      modelRuns += 1
      const continuationId = crypto.randomUUID()
      const output = adapterWorkerResult({
        reportId: 'callback-persistent-result', runId: 'run-callback-persistent',
        assignmentId: workItemId, physicalRoleId: launchRecord.physicalRole,
        requestEnvelopeHash: launchRecord.canonicalAssignment.requestEnvelopeHash,
        findingIds: [...launchRecord.canonicalAssignment.findingIds],
      })
      spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: continuationId }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 4, reasoning_tokens: 4 },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop() { return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  harness.runtimeOptions.launcher = async launch => {
    if (launch.logicalRole === 'route-analyst') return baseLauncher(launch)
    launchRecord = launch
    return adapter.launch(launch)
  }
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'PARTIAL', JSON.stringify(result))
  assert.notEqual(result.terminalEnvelope && result.terminalEnvelope.error &&
    result.terminalEnvelope.error.code, 'CALLBACK_RECONCILIATION_PENDING')
  assert.equal(modelRuns, 1)
  assert.equal(callbackAttempts, 4,
    'one live callback plus the fixed three post-drain replays exhausts the bounded journal')
  assert.equal(result.schedulerState.attempts[workItemId], 1)
  assert.equal(callbackDegradation.status, 'DEGRADED_LOCAL_TELEMETRY')
  assert.equal(callbackDegradation.durable, false)
  assert.equal(callbackDegradation.callbacks.some(item =>
    item.kind === 'transcript-event' && item.reasons.includes('REPLAY_EXHAUSTED')), true)
  assert.equal([...harness.record.writes.keys()].some(name =>
    name.includes('callback-reconciliation-')), false,
  'no write-only callback frontier is introduced without a startup consumer')
})

test('persistent essential terminal callback returns the authenticated result without another model turn', async t => {
  const workItemId = 'callback-essential-outage'
  const harness = makeHarness(t, {
    activationId: 'activation-callback-essential',
    runId: 'run-callback-essential',
  })
  harness.runtimeOptions.settings.explicit.path = 'direct'
  harness.runtimeOptions.exactPathPreflight = deterministicExactPathPreflight('DIRECT')
  harness.record.resolve = relative => path.join(harness.directory, relative)
  const write = harness.record.write.bind(harness.record)
  let terminalCallbackAttempts = 0
  harness.record.write = (name, bytes) => {
    if (name.includes('terminal-receipt-')) {
      terminalCallbackAttempts += 1
      throw Object.assign(new Error('persistent local terminal receipt outage'), {
        code: 'RUN_RECORD_WRITE_UNAVAILABLE',
      })
    }
    return write(name, bytes)
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const completed = await launch({
      workItemId, logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
      assignment: 'Produce the candidate before terminal receipt persistence fails.',
      success: ['Continue from the frozen authenticated result.'],
      checks: ['essential callback candidate'],
    })
    assert.equal(completed.reportId, 'callback-essential-result')
    return usableDoneFixture(harness, 'callback-essential-continuation')
  }
  let modelRuns = 0
  let launchRecord = null
  const baseLauncher = harness.runtimeOptions.launcher
  const runner = {
    async run(spec) {
      modelRuns += 1
      const continuationId = crypto.randomUUID()
      const output = adapterWorkerResult({
        reportId: 'callback-essential-result', runId: 'run-callback-essential',
        assignmentId: workItemId, physicalRoleId: launchRecord.physicalRole,
        requestEnvelopeHash: launchRecord.canonicalAssignment.requestEnvelopeHash,
        findingIds: [...launchRecord.canonicalAssignment.findingIds],
      })
      spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: continuationId }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 4, reasoning_tokens: 4 },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop() { return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  harness.runtimeOptions.launcher = async launch => {
    if (launch.logicalRole === 'route-analyst') return baseLauncher(launch)
    launchRecord = launch
    return adapter.launch(launch)
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(modelRuns, 1)
  assert.equal(terminalCallbackAttempts, 4)
  assert.equal(result.scheduler.counters.totalLaunches, 1)
  assert.equal(result.localPersistenceLimitations.some(item =>
    item.workItemId === workItemId && item.code === 'CALLBACK_RECONCILIATION_PENDING'), true)
})

test('terminal callback integrity and writer-lock failures never degrade into continuation', async t => {
  for (const errorCode of ['RUN_RECORD_FAILURE', 'RUN_RECORD_BUSY']) {
    await t.test(errorCode, async t => {
      const workItemId = `callback-integrity-${errorCode.toLowerCase()}`
      const harness = makeHarness(t, {
        activationId: `activation-${workItemId}`,
        runId: `run-${workItemId}`,
      })
      harness.runtimeOptions.settings.explicit.path = 'direct'
      harness.runtimeOptions.exactPathPreflight = deterministicExactPathPreflight('DIRECT')
      harness.record.resolve = relative => path.join(harness.directory, relative)
      const beforeHash = testWorkspaceCandidateHash(ROOT)
      const write = harness.record.write.bind(harness.record)
      let callbackAttempts = 0
      harness.record.write = (name, bytes) => {
        if (name.includes('terminal-receipt-')) {
          callbackAttempts += 1
          throw Object.assign(new Error(`terminal receipt fault: ${errorCode}`), {
            code: errorCode,
          })
        }
        return write(name, bytes)
      }
      harness.runtimeOptions.executeRoute = async ({ launch }) => {
        await launch({
          workItemId, logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
          assignment: 'Return one authenticated result before the integrity fault.',
          success: ['Integrity failures remain fail-closed.'],
          checks: ['terminal callback integrity'],
        })
        assert.fail('an integrity or concurrency callback failure must not return a child result')
      }
      let modelRuns = 0
      let launchRecord = null
      const baseLauncher = harness.runtimeOptions.launcher
      const runner = {
        async run(spec) {
          modelRuns += 1
          const continuationId = crypto.randomUUID()
          const output = adapterWorkerResult({
            reportId: `callback-integrity-result:${errorCode}`,
            runId: `run-${workItemId}`,
            assignmentId: workItemId,
            physicalRoleId: launchRecord.physicalRole,
            requestEnvelopeHash: launchRecord.canonicalAssignment.requestEnvelopeHash,
            findingIds: [...launchRecord.canonicalAssignment.findingIds],
          })
          spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: continuationId }))
          spec.onStdoutLine(JSON.stringify({
            type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) },
          }))
          spec.onStdoutLine(JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 4, reasoning_tokens: 4 },
          }))
          return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
        },
        async stop() { return { drained: true } },
      }
      const adapter = new CodexExecAdapter({
        runner, targetPath: ROOT,
        profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
        outputSchemaResolver: () => path.join(
          ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json',
        ),
      })
      harness.runtimeOptions.launcher = async launch => {
        if (launch.logicalRole === 'route-analyst') return baseLauncher(launch)
        launchRecord = launch
        return adapter.launch(launch)
      }

      const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
      assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
      assert.equal(result.terminalEnvelope.error.code, errorCode, JSON.stringify(result))
      assert.equal(modelRuns, 1)
      assert.equal(callbackAttempts, 1, 'integrity failures are never replayed as outages')
      assert.equal(testWorkspaceCandidateHash(ROOT), beforeHash)
      assert.equal(harness.launches.some(launch =>
        launch.logicalRole === 'independent-reviewer'), false)
      assert.equal(result.localPersistenceLimitations.some(item =>
        item.workItemId === workItemId), false)
    })
  }
})

function run030Deadline(absoluteDeadline, overrides = {}) {
  return {
    absoluteDeadline,
    source: 'task-host',
    verificationReservePercent: 25,
    recoveryAndFinalizationReservePercent: 10,
    ...overrides,
  }
}

function run030ExactSettings(deadline) {
  return {
    explicit: { concurrency: { mode: 'tokensaver' }, path: 'direct' },
    capabilities: { modelRouting: false, wideMaxSubs: 10 },
    providerId: 'codex',
    ...(deadline ? { deadline } : {}),
  }
}

function run030AutomaticSettings(deadline) {
  return {
    explicit: { concurrency: { mode: 'tokensaver' } },
    capabilities: { modelRouting: false, wideMaxSubs: 10 },
    providerId: 'codex',
    ...(deadline ? { deadline } : {}),
  }
}

function run030UsableDone() {
  return {
    outcome: 'DONE', deliverables: ['deadline-admission-fixture'],
    checkHashes: ['a'.repeat(64)], terminalEnvelope: { checkCount: 1 },
  }
}

test('AP-RUN-030 declared task deadline is authoritative in activation and the canonical budget', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const ttlMs = 1_200_000
  const declared = run030Deadline(new Date(wallNowMs + ttlMs).toISOString())
  const activationSettings = activationRuntimeSettings({
    requestArgv: ['Implement it.'],
    modelSelection: { mode: 'provider-default', selector: 'default', models: [] },
    deadline: declared,
  }, { providerMaximum: 10, nowMs: wallNowMs, productHardMaximumMs: 3_600_000 })
  let admittedActivation = null
  const harness = makeHarness(t, {
    wallMs: 3_600_000,
    runtimeOptions: {
      now: () => wallNowMs,
      productHardMaximumMs: 3_600_000,
      settings: run030ExactSettings(declared),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
      executeRoute: async () => run030UsableDone(),
    },
  })
  const recordFactory = harness.runtimeOptions.recordFactory
  harness.runtimeOptions.recordFactory = async input => {
    admittedActivation = input.activation
    return recordFactory(input)
  }
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.deepEqual({
    activationSettingsDeadline: activationSettings.deadline,
    activationDeadline: admittedActivation && admittedActivation.deadline,
    wallMs: result.budget.limits.wallMs,
    verificationReserveMs: result.budget.verificationReserveMs,
    finalizationReserveMs: result.budget.finalizationReserveMs,
  }, {
    activationSettingsDeadline: declared,
    activationDeadline: declared,
    wallMs: ttlMs,
    verificationReserveMs: 300_000,
    finalizationReserveMs: 120_000,
  })
})

test('AP-RUN-030 missing task deadline binds the injected product hard maximum', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const productHardMaximumMs = 1_800_000
  let admittedActivation = null
  const harness = makeHarness(t, {
    wallMs: 7_200_000,
    runtimeOptions: {
      now: () => wallNowMs,
      productHardMaximumMs,
      settings: run030ExactSettings(),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
      executeRoute: async () => run030UsableDone(),
    },
  })
  const recordFactory = harness.runtimeOptions.recordFactory
  harness.runtimeOptions.recordFactory = async input => {
    admittedActivation = input.activation
    return recordFactory(input)
  }
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.deepEqual({
    activationDeadline: admittedActivation && admittedActivation.deadline,
    wallMs: result.budget.limits.wallMs,
    verificationReserveMs: result.budget.verificationReserveMs,
    finalizationReserveMs: result.budget.finalizationReserveMs,
  }, {
    activationDeadline: run030Deadline(new Date(wallNowMs + productHardMaximumMs).toISOString(), {
      source: 'product-maximum',
    }),
    wallMs: productHardMaximumMs,
    verificationReserveMs: 450_000,
    finalizationReserveMs: 180_000,
  })
})

test('AP-RUN-030 an overlong wall target clamps locally and still completes production', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const productHardMaximumMs = 1_800_000
  const declared = run030Deadline(new Date(wallNowMs + productHardMaximumMs + 1).toISOString())
  let executionCalls = 0
  const harness = makeHarness(t, {
    runtimeOptions: {
      now: () => wallNowMs,
      productHardMaximumMs,
      settings: run030ExactSettings(declared),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
      executeRoute: async () => { executionCalls++; return run030UsableDone() },
    },
  })
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.deepEqual({
    outcome: result.outcome,
    wallMs: result.budget.limits.wallMs,
    executionCalls,
    launches: harness.launches.length,
  }, {
    outcome: 'DONE',
    wallMs: productHardMaximumMs,
    executionCalls: 1,
    launches: 0,
  })
})

test('AP-RUN-030 custom executor cannot start unclassified work inside the final-verification reserve', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const declared = run030Deadline(new Date(wallNowMs + 1_000).toISOString())
  let launchError = null
  const harness = makeHarness(t, {
    wallMs: 10_000,
    runtimeOptions: {
      now: () => wallNowMs,
      settings: run030ExactSettings(declared),
      exactPathPreflight: async input => {
        const preflight = await deterministicExactPathPreflight('DIRECT')(input)
        return {
          ...preflight,
          routeFacts: {
            ...preflight.routeFacts,
            deadlineBudget: {
              remainingSeconds: 1,
              admissionSeconds: 0,
              executionReserveSeconds: 0.65,
              verificationReserveSeconds: 0.25,
              recoveryAndFinalizationReserveSeconds: 0.10,
            },
          },
        }
      },
      executeRoute: async ({ launch }) => {
        harness.advance(651)
        try {
          await launch({
            workItemId: 'reserve-overrun', logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
            assignment: 'This work must not consume final verification time.',
            success: ['The final verification reserve remains intact.'], checks: ['focused check'],
          })
        } catch (error) { launchError = error }
        return { outcome: 'PARTIAL' }
      },
    },
  })
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.deepEqual({
    launchErrorCode: launchError && launchError.code,
    launched: harness.launches.some(item => item.workItemId === 'reserve-overrun'),
    verificationReserveMs: result.budget.verificationReserveMs,
  }, {
    launchErrorCode: 'FINAL_VERIFICATION_RESERVE_REQUIRED',
    launched: false,
    verificationReserveMs: 250,
  })
})

test('AP-RUN-030 insufficient and expired wall targets still complete required local production', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const cases = [
    {
      id: 'insufficient',
      deadline: run030Deadline(new Date(wallNowMs + 10_000).toISOString(), {
        verificationReservePercent: 91,
        recoveryAndFinalizationReservePercent: 10,
      }),
    },
    {
      id: 'expired',
      deadline: run030Deadline(new Date(wallNowMs - 1).toISOString()),
    },
  ]
  const observed = []
  for (const item of cases) {
    let executionCalls = 0
    const harness = makeHarness(t, {
      activationId: `run030-${item.id}`,
      runId: `run030-${item.id}-run`,
      runtimeOptions: {
        now: () => wallNowMs,
        settings: run030ExactSettings(item.deadline),
        exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
        executeRoute: async () => { executionCalls++; return run030UsableDone() },
      },
    })
    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    observed.push({
      id: item.id,
      outcome: result.outcome,
      wallMs: result.budget.limits.wallMs,
      executionCalls,
      launches: harness.launches.length,
    })
  }
  assert.deepEqual(observed, [{
    id: 'insufficient', outcome: 'DONE', wallMs: 10_000, executionCalls: 1, launches: 0,
  }, {
    id: 'expired', outcome: 'DONE', wallMs: 600_000, executionCalls: 1, launches: 0,
  }])
})

test('AP-RUN-030 resume preserves the exact persisted deadline and both reserves', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const declared = run030Deadline(new Date(wallNowMs + 1_200_000).toISOString())
  let firstActivation = null
  const first = makeHarness(t, {
    activationId: 'run030-resume', runId: 'run030-resume-run', wallMs: 3_600_000,
    runtimeOptions: {
      now: () => wallNowMs,
      settings: run030AutomaticSettings(declared),
      executeRoute: async () => ({ outcome: 'PARTIAL' }),
    },
  })
  const firstRecordFactory = first.runtimeOptions.recordFactory
  first.runtimeOptions.recordFactory = async input => {
    firstActivation = input.activation
    return firstRecordFactory(input)
  }
  const firstResult = await new CodexSupervisorRuntime(first.runtimeOptions).start()

  let resumedActivation = null
  const second = makeHarness(t, {
    missionLock: first.missionLock, activationId: 'run030-resume', runId: 'run030-resume-run',
    runtimeOptions: {
      now: () => wallNowMs,
      generation: 2,
      settings: run030AutomaticSettings(declared),
      previousBudgetSnapshot: firstResult.budget,
      budgetController: new BudgetController({
        limits: firstResult.budget.limits,
        finalizationReserveMs: firstResult.budget.finalizationReserveMs,
        phases: {}, monotonicMs: () => first.currentTime(), monotonicClockId: 'test-monotonic',
        wallNowMs: () => wallNowMs,
        snapshot: firstResult.budget,
      }),
      resumeState: {
        decision: decision('DIRECT'), schedulerState: firstResult.schedulerState,
        deadline: firstActivation && firstActivation.deadline,
      },
      executeRoute: async () => run030UsableDone(),
    },
  })
  const secondRecordFactory = second.runtimeOptions.recordFactory
  second.runtimeOptions.recordFactory = async input => {
    resumedActivation = input.activation
    return secondRecordFactory(input)
  }
  const result = await new CodexSupervisorRuntime(second.runtimeOptions).start()

  assert.deepEqual({
    first: firstActivation && firstActivation.deadline,
    resumed: resumedActivation && resumedActivation.deadline,
    verificationReserveMs: result.budget.verificationReserveMs,
    finalizationReserveMs: result.budget.finalizationReserveMs,
  }, {
    first: declared,
    resumed: declared,
    verificationReserveMs: 300_000,
    finalizationReserveMs: 120_000,
  })
})

test('AP-RUN-030 rejects tampered resume deadlines but completes locally after elapsed time', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const original = run030Deadline(new Date(wallNowMs + 600_000).toISOString())
  const cases = [
    {
      id: 'tampered',
      nowMs: wallNowMs,
      resumeDeadline: { ...original, verificationReservePercent: 24 },
      expected: 'RESUME_DEADLINE_INVALID',
    },
    {
      id: 'stale',
      nowMs: wallNowMs + 600_001,
      resumeDeadline: original,
      expected: null,
    },
  ]
  const observed = []
  for (const item of cases) {
    let executionCalls = 0
    const harness = makeHarness(t, {
      activationId: `run030-${item.id}-resume`, runId: `run030-${item.id}-resume-run`,
    })
    const prior = harness.budget.snapshot()
    harness.runtimeOptions.generation = 2
    harness.runtimeOptions.now = () => item.nowMs
    harness.runtimeOptions.settings = run030AutomaticSettings(original)
    harness.runtimeOptions.previousBudgetSnapshot = prior
    harness.runtimeOptions.budgetController = new BudgetController({
      limits: prior.limits, finalizationReserveMs: prior.finalizationReserveMs,
      phases: {}, monotonicMs: () => harness.currentTime(), monotonicClockId: 'test-monotonic',
      snapshot: prior,
    })
    harness.runtimeOptions.resumeState = {
      decision: decision('DIRECT'),
      schedulerState: new CentralScheduler({
        route: 'DIRECT', runIdentity: { runId: harness.runtimeOptions.runId, generation: 1 },
      }).exportState(),
      deadline: item.resumeDeadline,
    }
    harness.runtimeOptions.executeRoute = async () => {
      executionCalls++
      return usableDoneFixture(harness, `run030-${item.id}-completion`)
    }
    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    observed.push({
      id: item.id,
      outcome: result.outcome,
      status: result.terminalEnvelope && result.terminalEnvelope.status,
      executionCalls,
      launches: harness.launches.length,
    })
  }
  assert.deepEqual(observed, [{
    id: 'tampered', outcome: 'PARTIAL', status: 'RESUME_DEADLINE_INVALID',
    executionCalls: 0, launches: 0,
  }, {
    id: 'stale', outcome: 'DONE', status: null,
    executionCalls: 1, launches: 0,
  }])
})

test('activation path controls preserve ordinary mission text and fail closed on invalid or duplicate forms', () => {
  const activation = requestArgv => ({
    requestArgv,
    modelSelection: { mode: 'provider-default', selector: 'default', models: [] },
  })
  const resolve = argv => {
    const raw = activationRuntimeSettings(activation(argv), { providerMaximum: 10 })
    return require(path.join(WORKFLOW, 'settings.js')).resolveSettings(raw)
  }
  assert.equal(resolve(['path=direct', 'Implement it.']).path.exactRoute, 'DIRECT')
  assert.equal(resolve(['--path', 'light', 'Implement it.']).path.exactRoute, 'LIGHT')
  assert.equal(resolve(['--path=ROADMAP', 'Implement it.']).path.exactRoute, 'ROADMAP')
  assert.equal(resolve(['Document the literal text path=direct without selecting it.']).path.requested, 'auto')
  assert.equal(resolve(['Implement', 'path=direct', 'as an example.']).path.requested, 'auto')
  assert.equal(resolve(['Explain', '--path', 'roadmap', 'without selecting it.']).path.requested, 'auto')
  assert.equal(resolve(['"path=light"', 'is quoted mission text.']).path.requested, 'auto')
  const mixedControlArgv = [
    'tokensaver', '--concurrency', 'custom', '--max-subs', '2',
    '--path=direct', '--', 'Implement it.',
  ]
  const mixedControl = resolve(mixedControlArgv)
  let routeAnalystCalls = 0
  let l0Calls = 0
  let productionCalls = 0
  let providerCalls = 0
  if (mixedControl.ready) {
    routeAnalystCalls += 1
    l0Calls += 1
    productionCalls += 1
    providerCalls += 1
  }
  assert.equal(mixedControl.status, 'CONFIG_REQUIRED')
  assert.equal(mixedControl.settings, undefined)
  assert.equal(mixedControl.settings?.path?.exactRoute, undefined)
  assert.equal(mixedControl.path, undefined)
  assert.deepEqual({ routeAnalystCalls, l0Calls, productionCalls, providerCalls }, {
    routeAnalystCalls: 0, l0Calls: 0, productionCalls: 0, providerCalls: 0,
  })
  for (const argv of [
    ['path=bogus', 'Implement it.'],
    ['--path'],
    ['path=direct', '--path', 'direct', 'Implement it.'],
    ['--path=light', 'path=roadmap', 'Implement it.'],
  ]) {
    const result = resolve(argv)
    assert.equal(result.status, 'CONFIG_REQUIRED', JSON.stringify({ argv, result }))
    assert.equal(result.issues.some(issue => issue.field === 'path' && issue.code === 'INVALID' ||
      issue.field === 'path' && issue.code === 'MISSING'), true)
  }
})

test('explicit direct, light, and roadmap paths bypass analyst and root route-selection model work exactly', async t => {
  const expectedBudget = {
    direct: { launches: 8, depth: 2 },
    light: { launches: 8, depth: 3 },
    roadmap: { launches: 8, depth: 4 },
  }
  for (const requested of ['direct', 'light', 'roadmap']) {
    const observed = []
    const harness = makeHarness(t, {
      activationId: `exact-${requested}`,
      runId: `exact-${requested}-run`,
      executeRoute: async input => {
        observed.push(input)
        return {
          outcome: 'DONE',
          deliverables: [`exact-${requested}-route-fixture`],
          checkHashes: [CANDIDATE_A],
        }
      },
      decideRoute: async () => assert.fail('exact path must not invoke root route selection'),
      runtimeOptions: {
        maxChildLaunches: 1,
        lanes: { main: { maxLaunches: 1 } },
        exactPathPreflight: deterministicExactPathPreflight(requested.toUpperCase()),
        settings: {
          explicit: { concurrency: { mode: 'tokensaver' }, path: requested },
          capabilities: { modelRouting: false, wideMaxSubs: 10 },
          providerId: 'codex',
        },
      },
    })
    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    assert.equal(result.outcome, 'DONE', JSON.stringify({ requested, result }))
    assert.equal(observed.length, 1)
    assert.equal(observed[0].route, requested.toUpperCase())
    assert.equal(observed[0].decision.pathSelection.automaticSelectionBypassed, true)
    assert.equal(observed[0].decision.topology.counts.routeAnalysts, 0)
    assert.deepEqual(harness.launches.map(item => item.logicalRole), [])
    assert.equal(harness.record.writes.has('route/recommendation.json'), false)
    assert.equal(harness.record.writes.has('route/decision.json'), true)
    assert.equal(result.scheduler.counters.totalLaunches, 0)
    assert.equal(result.scheduler.limits.maxChildLaunches, expectedBudget[requested].launches)
    assert.equal(result.scheduler.lanes.main.limits.maxLaunches, expectedBudget[requested].launches)
    assert.equal(result.scheduler.limits.maxDepth, expectedBudget[requested].depth)
  }
})

test('automatic one-worker ROADMAP activation binds its declared topology to the economical launch ceiling', async t => {
  const routeDecision = decision('ROADMAP')
  const harness = makeHarness(t, {
    activationId: 'automatic-one-worker-roadmap',
    runId: 'automatic-one-worker-roadmap-run',
    decideRoute: async () => ({
      decision: routeDecision, submittedAtMs: 0, usage: ZERO_USAGE,
    }),
    executeRoute: async () => ({
      outcome: 'DONE', deliverables: ['automatic-roadmap-fixture'], checkHashes: [CANDIDATE_A],
    }),
  })
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(routeDecision.usefulWorkerCount, 1)
  assert.equal(routeDecision.topology.counts.workers, 1)
  assert.equal(routeDecision.topology.childSessions, 3)
  assert.equal(result.scheduler.limits.maxChildLaunches, 9)
  assert.equal(result.scheduler.limits.maxChildLaunches - routeDecision.topology.childSessions, 6)
  const physical = codexPhysicalExecutionReceipt(routeDecision)
  assert.equal(physical.executionMode, 'deterministic-roadmap-v1')
  assert.equal(physical.requiredChildLaunches, 9)
})

test('automatic ROADMAP ignores advisory scout expansion and keeps the finite physical completion requirement', async t => {
  const routeDecision = decision('ROADMAP', {
    scoutCount: 2,
    missingInformation: [
      'Which service owns the migration boundary?',
      'Which client deploys after the API?',
    ],
  })
  const harness = makeHarness(t, {
    activationId: 'automatic-roadmap-scout-topology',
    runId: 'automatic-roadmap-scout-topology-run',
    decideRoute: async () => ({
      decision: routeDecision, submittedAtMs: 0, usage: ZERO_USAGE,
    }),
    executeRoute: async () => ({
      outcome: 'DONE', deliverables: ['automatic-roadmap-scout-fixture'], checkHashes: [CANDIDATE_A],
    }),
  })
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(routeDecision.topology.counts.workers, 1)
  assert.equal(routeDecision.topology.counts.scouts, 0)
  assert.equal(routeDecision.topology.counts.roadmapAuthors, 0)
  assert.equal(routeDecision.topology.childSessions, 3)
  assert.equal(result.scheduler.limits.maxChildLaunches, 9)
  assert.ok(result.scheduler.limits.maxChildLaunches < ROUTE_BUDGETS.ROADMAP.maxChildLaunches)
})

test('exact path without deterministic facts fails typed before route models or production', async t => {
  let production = 0
  const harness = makeHarness(t, {
    activationId: 'exact-missing-preflight',
    runId: 'exact-missing-preflight-run',
    decideRoute: async () => assert.fail('exact path denial must not invoke route selection'),
    executeRoute: async () => { production += 1; return { outcome: 'DONE' } },
    runtimeOptions: {
      settings: {
        explicit: { concurrency: { mode: 'tokensaver' }, path: 'direct' },
        capabilities: { modelRouting: false, wideMaxSubs: 10 },
        providerId: 'codex',
      },
    },
  })
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'FAILED')
  assert.equal(result.terminalEnvelope.status, 'EXACT_PATH_PREFLIGHT_REQUIRED')
  assert.equal(production, 0)
  assert.deepEqual(harness.launches, [])
  assert.equal(result.scheduler, null)
})

test('settings and one saved analyst precede L0, and a late valid decision still reaches production', async t => {
  const harness = makeHarness(t)
  harness.runtimeOptions.decideRoute = async () => {
    harness.advance(240001)
    return { decision: decision('DIRECT'), submittedAtMs: 240001, usage: ZERO_USAGE }
  }
  harness.runtimeOptions.l0ViaScheduler = false
  harness.runtimeOptions.executeRoute = async () => usableDoneFixture(harness, 'late-l0-result')
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.route, 'DIRECT')
  assert.deepEqual(harness.launches.map(item => item.logicalRole), ['route-analyst'], JSON.stringify({ result, finalizations: harness.finalizations }))
  assert.equal(harness.record.events.length, 1)
  assert.ok(harness.record.writes.has('route/recommendation.json'), JSON.stringify(harness.record.events))
  assert.equal(harness.record.writes.has('route/decision.json'), true)
  assert.equal(harness.processOwner.drained > 0, true)
})

test('deterministic L0 falls back once without exposing a live unbound root checkpoint', async t => {
  const attempts = []
  const transitions = []
  const checkpoints = []
  let runtime
  const harness = makeHarness(t, {
    decideRoute: async input => {
      attempts.push(input.correctionAttempts)
      return { decision: {}, usage: ZERO_USAGE }
    },
    executeRoute: async ({ route, decision: selected }) => {
      assert.equal(route, 'DIRECT')
      assert.equal(validateRouteDecision(selected).valid, true)
      return usableDoneFixture(harness, 'deterministic-l0-fallback-result')
    },
    runtimeOptions: {
      deterministicRouteDecision: true,
      runtimeTransition: async payload => {
        transitions.push({
          eventId: payload.eventId,
          rootStatus: runtime.scheduler
            ? runtime.scheduler.getMetrics().rootAccounting.status : null,
        })
        return null
      },
      persistRecoveryCheckpoint: checkpoint => {
        checkpoints.push(checkpoint)
        return null
      },
    },
  })
  runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
  const result = await runtime.start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(attempts, [0])
  assert.equal(transitions.find(item =>
    item.eventId === 'ROUTE_DECISION_INVALID_FIRST').rootStatus, 'not-started')
  assert.equal(result.scheduler.rootAccounting.status, 'completed')
  assert.deepEqual(result.scheduler.rootAccounting.reported, {
    noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0,
    weightedCost: 0, latencyMs: 0, workMs: 0,
  })
  const l0Checkpoints = checkpoints.filter(checkpoint =>
    checkpoint.cause && checkpoint.cause.causeId === 'state:1:L0_ROUTE_DECISION:0')
  assert.ok(l0Checkpoints.length >= 2)
  assert.equal(l0Checkpoints.every(checkpoint =>
    checkpoint.hasLiveModelSession === false), true)
  assert.deepEqual(harness.launches.map(item => item.logicalRole), ['route-analyst'])
})

test('the single L0 correction is not abandoned solely because useful route work crosses the former absolute watchdog', async t => {
  const attempts = []
  const harness = makeHarness(t, {
    executeRoute: async ({ route, decision: selected }) => {
      assert.equal(route, 'DIRECT')
      assert.equal(selected.usefulWorkerCount, 1)
      assert.equal(selected.independentCheckingPlan.checkerCount, 1)
      return usableDoneFixture(harness, 'l0-watchdog-conservative-result')
    },
  })
  harness.runtimeOptions.decideRoute = async ({ correctionAttempts }) => {
    attempts.push({ correctionAttempts, at: harness.currentTime() })
    if (correctionAttempts === 0) {
      harness.advance(239_950)
      return { decision: {}, usage: ZERO_USAGE }
    }
    await new Promise(resolve => setImmediate(resolve))
    harness.advance(1_560_051)
    return { decision: decision('DIRECT'), usage: ZERO_USAGE }
  }
  harness.runtimeOptions.l0ViaScheduler = false

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(attempts, [
    { correctionAttempts: 0, at: 0 },
    { correctionAttempts: 1, at: 239_950 },
  ])
  assert.equal(harness.currentTime(), 1_800_001)
  assert.equal(harness.processOwner.drained > 0, true)
})

test('AP-CODEX-V2-035 committed invalid L0 result rotates to a fresh correction process', async t => {
  const attempts = []
  const harness = makeHarness(t, {
    executeRoute: async () => usableDoneFixture(harness, 'root-correction-rotation-result'),
    runtimeOptions: {
      safeEnvFactory: (_repository, baseEnvironment) => ({
        environment: { ...baseEnvironment, GIT_ALLOW_PROTOCOL: 'file' },
        attestation: {
          gitEnforced: true,
          mechanicallyEnforced: true,
          channels: Object.fromEntries([
            'repositoryGitBarrier',
            'gitCommandNetworkBarrier',
            'githubCliCredentialIsolation',
            'shellOutboundNetworkSandbox',
            'providerConnectorApiWriteToolDenial',
          ].map(name => [name, {
            applicable: true, enforced: true,
            evidence: { fixture: 'AP-CODEX-V2-035' }, residuals: [],
          }])),
        },
      }),
    },
  })
  harness.runtimeOptions.decideRoute = async callbacks => {
    harness.record.resolve = relative => path.join(harness.directory, relative)
    const attempt = callbacks.correctionAttempts
    const reservationId = `root-reservation-${attempt}`
    const transportSessionId = `root-transport-${attempt}`
    const continuationId = `${attempt + 1}1111111-1111-4111-8111-111111111111`
    attempts.push({ attempt, reservationId, transportSessionId, continuationId })
    callbacks.onLaunchPrepared({ reservationId, sessionId: transportSessionId, continuationId: null })
    callbacks.onSessionIdentified(continuationId, {
      reservationId, sessionId: transportSessionId,
      raw: `thread.started:${continuationId}`,
      event: { type: 'thread.started', thread_id: continuationId },
      occurredAt: new Date(0).toISOString(),
    })
    const terminal = {
      decision: attempt === 0 ? {} : decision('DIRECT'),
      usage: ZERO_USAGE,
      usageStreamed: true,
    }
    callbacks.onUsageDelta(ZERO_USAGE)
    callbacks.onTerminalResult(terminal, {
      assignmentHash: crypto.createHash('sha256').update(`root-assignment-${attempt}`).digest('hex'),
      sessionId: continuationId,
      controlSessionId: transportSessionId,
      rawOutputHash: crypto.createHash('sha256').update(`root-output-${attempt}`).digest('hex'),
      eventStreamHash: crypto.createHash('sha256').update(`root-events-${attempt}`).digest('hex'),
    })
    return terminal
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify({ result, events: harness.record.events }))
  assert.deepEqual(attempts.map(item => item.attempt), [0, 1])
  assert.notEqual(attempts[0].reservationId, attempts[1].reservationId)
  assert.notEqual(attempts[0].transportSessionId, attempts[1].transportSessionId)
  assert.equal(result.scheduler.rootAccounting.status, 'completed')
})

test('one mission lock rejects a second root before record creation or child launch', async t => {
  const lock = new FakeLock()
  let releaseAnalyst
  let enteredAnalyst
  const entered = new Promise(resolve => { enteredAnalyst = resolve })
  const gate = new Promise(resolve => { releaseAnalyst = resolve })
  const first = makeHarness(t, { missionLock: lock, activationId: 'first', runId: 'first-run' })
  first.runtimeOptions.launcher = async launch => {
    first.launches.push(launch)
    if (launch.logicalRole === 'route-analyst') {
      enteredAnalyst()
      await gate
      return { recommendation: recommendation(), events: [], elapsedMs: 1, usage: ZERO_USAGE }
    }
    if (launch.logicalRole === 'run-owner') return { decision: decision('DIRECT'), usage: ZERO_USAGE }
    if (launch.logicalRole === 'diagnostic-probe') {
      return representativeProbeResult(launch)
    }
    return { contextId: 'worker', usage: ZERO_USAGE }
  }
  const firstDeliverable = path.join(first.directory, 'mission-lock-result.txt')
  fs.writeFileSync(firstDeliverable, 'first activation completed\n')
  const firstDeliverableHash = crypto.createHash('sha256').update(fs.readFileSync(firstDeliverable)).digest('hex')
  first.runtimeOptions.executeRoute = async () => ({
    outcome: 'DONE', deliverables: [firstDeliverable], checkHashes: [firstDeliverableHash],
  })
  const firstPromise = new CodexSupervisorRuntime(first.runtimeOptions).start()
  await entered

  let secondRecords = 0
  const second = makeHarness(t, { missionLock: lock, activationId: 'second', runId: 'second-run' })
  second.runtimeOptions.recordFactory = async () => { secondRecords++; return second.record }
  const secondResult = await new CodexSupervisorRuntime(second.runtimeOptions).start()
  assert.equal(secondResult.outcome, 'WORKSPACE_LEASE_CONFLICT')
  assert.equal(secondRecords, 0)
  assert.equal(second.launches.length, 0)

  releaseAnalyst()
  const firstResult = await firstPromise
  assert.equal(firstResult.outcome, 'DONE', JSON.stringify(firstResult))
  assert.equal(lock.releaseCalls, 1)
})

test('all worker and checker launches use scheduler leases, context-free briefs, safe Git env, same-executor repair, and candidate-bound checks', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-scheduler-launches-'))
  const hardened = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal([0, 3].includes(hardened.status), true, hardened.stderr || hardened.stdout)
  const candidateHash = testWorkspaceCandidateHash(target)
  const harness = makeHarness(t, {
    runtimeOptions: {
      targetPath: target,
      expectedBranch: 'main',
      gitEnvironment: () => process.env,
    },
  })
  let duplicateCode = null
  harness.runtimeOptions.launcher = async launch => {
    harness.launches.push(launch)
    assert.match(launch.schedulerLeaseId, /^launch-/)
    assert.equal(launch.dispatch.fork_turns, 'none')
    assert.equal(launch.environment.GIT_ALLOW_PROTOCOL, 'file')
    if (launch.logicalRole === 'route-analyst') {
      return { recommendation: recommendation(), events: [], elapsedMs: 1, usage: ZERO_USAGE }
    }
    if (launch.logicalRole === 'run-owner') return { decision: decision('DIRECT'), usage: ZERO_USAGE }
    if (launch.logicalRole === 'diagnostic-probe') {
      return representativeProbeResult(launch)
    }
    if (launch.logicalRole === 'worker') {
      if (launch.continuationId) assert.equal(launch.continuationId, 'executor-context')
      return { contextId: 'executor-context', usage: ZERO_USAGE }
    }
    return {
      schemaVersion: '2.0.0', code: 'PASS', runId: 'run-1',
      requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
      candidateHash, currentVersionHash: candidateHash,
      payload: {
        evidenceIds: ['evidence:focused-oracle'],
        referenceMethod: checkerReferenceMethod('black-box-boundary', 'focused oracle'),
      },
      evidenceHashes: [], usage: ZERO_USAGE,
    }
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    await launch({
      workItemId: 'implementation', executorKey: 'same-executor', logicalRole: 'worker',
      parent: 'run-owner', depth: 1, purpose: 'work', assignment: 'Implement the bounded behavior.',
      ownership: ['src/example.js'], checks: ['focused check'], success: ['behavior passes'],
      strategyFingerprint: crypto.createHash('sha256').update('initial strategy').digest('hex'),
    })
    await launch({
      workItemId: 'repair', repairOf: 'implementation', executorKey: 'same-executor', logicalRole: 'worker',
      parent: 'run-owner', depth: 1, purpose: 'work', assignment: 'Repair the affected behavior.',
      ownership: ['src/example.js'], checks: ['focused check'], success: ['behavior passes'],
      strategyFingerprint: crypto.createHash('sha256').update('changed repair strategy').digest('hex'),
    })
    const checker = {
      workItemId: 'check-1', logicalRole: 'independent-reviewer', parent: 'run-owner', depth: 1,
      purpose: 'verification', assignment: 'Check the exact candidate.', checks: ['focused check'],
      success: ['request passes'], candidateHash, oracle: 'focused-oracle',
      harnessAttestation: {
        repoHash: candidateHash,
        buildHash: crypto.createHash('sha256').update('focused-build').digest('hex'),
        oracleHash: crypto.createHash('sha256').update('focused-oracle').digest('hex'),
      },
    }
    await launch(checker)
    try { await launch(checker) } catch (error) { duplicateCode = error.code }
    const usableDeliverable = path.join(harness.directory, 'scheduler-launch-result.txt')
    fs.writeFileSync(usableDeliverable, 'scheduler launch contract completed\n')
    const usableDeliverableHash = crypto.createHash('sha256')
      .update(fs.readFileSync(usableDeliverable)).digest('hex')
    return { outcome: 'DONE', deliverables: [usableDeliverable], checkHashes: [usableDeliverableHash] }
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(duplicateCode, 'RETRY_REASSESSMENT_REQUIRED')
  assert.deepEqual(harness.launches.map(item => item.logicalRole), [
    'route-analyst', 'worker', 'worker', 'independent-reviewer',
  ])
  assert.equal(result.scheduler.limits.maxChildLaunches, 9,
    'automatic DIRECT C1 reserves bounded worker/repair retries and independent scratch checks')
  assert.equal(result.scheduler.counters.totalLaunches, 4)
  assert.equal(result.budget.launches, 4)
  assert.equal(harness.launches.some(item => item.dispatch.fork_turns === 'all'), false)
  // The retry preflight rejects the duplicate before capability verification
  // or any checker resource is materialized.
  assert.equal(harness.capabilityChecks.length, harness.launches.length)
  for (const binding of harness.capabilityChecks) {
    assert.equal(binding.runId, 'run-1')
    assert.equal(binding.generation, 1)
    assert.match(binding.caller.physicalRole, /^autoprompt\.v2\./)
    assert.equal(binding.caller.sessionId.length > 0, true)
  }
})

test('normal history forks are denied while typed recovery is bounded to one through three turns', async t => {
  const harness = makeHarness(t, { runtimeOptions: { gitEnvironment: () => process.env } })
  const candidateHash = testWorkspaceCandidateHash(harness.runtimeOptions.targetPath)
  const usableDeliverable = path.join(harness.directory, 'bounded-recovery-result.txt')
  let forbiddenCode = null
  let recoveryDispatch = null
  let checkerRecoveryDispatch = null
  const baseLauncher = harness.runtimeOptions.launcher
  harness.runtimeOptions.launcher = async launch => {
    if (launch.logicalRole === 'worker' && launch.dispatch.recoveryContext) recoveryDispatch = launch.dispatch
    if (launch.logicalRole === 'independent-reviewer' && launch.dispatch.recoveryContext) {
      checkerRecoveryDispatch = launch.dispatch
      return {
        schemaVersion: '2.0.0', code: 'PASS', runId: 'run-1',
        requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
        candidateHash, currentVersionHash: candidateHash,
        payload: {
          evidenceIds: ['evidence:checker-reassessment'],
          referenceMethod: checkerReferenceMethod('black-box-boundary', 'checker reassessment'),
        },
        evidenceHashes: [], usage: ZERO_USAGE,
      }
    }
    return baseLauncher(launch)
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    try {
      await launch({
        workItemId: 'forbidden-history', logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
        assignment: 'This full-history launch must never run.', success: ['never'], checks: ['never'],
        forkTurns: 'all',
      })
    } catch (error) { forbiddenCode = error.code }
    await launch({
      workItemId: 'bounded-recovery', logicalRole: 'worker', parent: 'run-owner', purpose: 'recovery',
      assignment: 'Recover only the named local failure.', success: ['recovery is bounded'], checks: ['focused check'],
      forkTurns: 2, recoveryContext: { type: 'bounded-recovery', code: 'LOCAL_CHECK_FAILURE' },
      strategyFingerprint: crypto.createHash('sha256').update('bounded recovery').digest('hex'),
    })
    await launch({
      workItemId: 'checker-reassessment', logicalRole: 'independent-reviewer', parent: 'run-owner',
      purpose: 'verification', assignment: 'Repeat the checker with a distinct reference method.',
      success: ['the exact candidate is independently verified'], checks: ['focused check'],
      candidateHash, oracle: 'focused-oracle', forkTurns: 1,
      recoveryContext: { type: 'bounded-recovery', code: 'DUPLICATE_REFERENCE_METHOD_CLASS' },
      harnessAttestation: {
        repoHash: candidateHash,
        buildHash: crypto.createHash('sha256').update('focused-build').digest('hex'),
        oracleHash: crypto.createHash('sha256').update('focused-oracle').digest('hex'),
      },
    })
    fs.writeFileSync(usableDeliverable, 'bounded recovery completed\n')
    const buildAcceptanceHash = crypto.createHash('sha256')
      .update(fs.readFileSync(usableDeliverable)).digest('hex')
    return {
      outcome: 'DONE',
      deliverables: [usableDeliverable],
      checkHashes: [buildAcceptanceHash],
    }
  }
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(forbiddenCode, 'INHERITED_CONTEXT_FORBIDDEN')
  assert.equal(recoveryDispatch.fork_turns, '2')
  assert.deepEqual(recoveryDispatch.recoveryContext, { type: 'bounded-recovery', code: 'LOCAL_CHECK_FAILURE' })
  assert.equal(checkerRecoveryDispatch.fork_turns, '1')
  assert.deepEqual(checkerRecoveryDispatch.recoveryContext,
    { type: 'bounded-recovery', code: 'DUPLICATE_REFERENCE_METHOD_CLASS' })
  assert.equal(harness.launches.some(launch => launch.workItemId === 'forbidden-history'), false)
})

test('run-global elapsed target records its overrun without discarding a required usable result', async t => {
  const harness = makeHarness(t, { wallMs: 100 })
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    await launch({
      workItemId: 'productive-overrun', logicalRole: 'worker', parent: 'run-owner', depth: 1,
      purpose: 'work', assignment: 'Continue producing work.', success: ['work advances'],
      checks: ['focused check'],
    })
    return usableDoneFixture(harness, 'budget-overrun-result')
  }
  const baseLauncher = harness.runtimeOptions.launcher
  harness.runtimeOptions.launcher = async launch => {
    const result = await baseLauncher(launch)
    if (launch.logicalRole === 'worker') harness.advance(101)
    return result
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(harness.finalizations.at(-1).outcome, 'DONE')
  assert.equal(harness.processOwner.drained > 0, true)
  assert.ok(result.budget.consumedWallMs >= 101)
})

test('custom route executor cannot mint required-completion authority beyond an economic launch target', async t => {
  const harness = makeHarness(t, { launchLimit: 1 })
  // Custom embedding knobs are economic hints, but an injected executor is
  // not the controller-owned completion graph and cannot mint an override.
  harness.runtimeOptions.maxChildLaunches = 1
  harness.runtimeOptions.lanes = { main: { maxLaunches: 1 } }
  const accountingLaunches = []
  harness.runtimeOptions.accountingAuthority = {
    checkpoint(input) {
      if (input.delta.launches === 1) accountingLaunches.push(input)
      return { record: { sequence: accountingLaunches.length } }
    },
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    await launch({
      workItemId: 'required-direct-result', logicalRole: 'worker', parent: 'run-owner',
      purpose: 'work', missionEssential: true,
      requiredCompletion: true,
      requiredCompletionBinding: { forged: true },
      assignment: 'Produce the required direct result after the economic launch target.',
      success: ['The direct result is usable.'], checks: ['focused completion check'],
    })
    return usableDoneFixture(harness, 'undersized-launch-direct-result')
  }
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'PARTIAL', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'BUDGET_EXHAUSTED')
  assert.equal(result.scheduler.limits.maxChildLaunches, 9)
  assert.equal(result.scheduler.lanes.main.limits.maxLaunches, 9)
  assert.equal(result.budget.launches, 1)
  assert.equal(accountingLaunches.length, 1)
  assert.equal(accountingLaunches[0].requiredCompletion, false)
  assert.equal(harness.launches.some(item => item.workItemId === 'required-direct-result'), false)
  assert.throws(() => harness.budget.recordLaunch(), error => error.code === 'BUDGET_EXHAUSTED')
})

test('built-in deterministic executor crosses an economic launch target for its branded finite graph', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], {
    completeProduct: true,
    launchLimit: 1,
    productCheckerCodes: ['FAIL', 'PASS'],
  })
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(fixture.harness.launches.map(item => item.workItemId), [
    'work-1', 'independent-check-1',
    'work-1-repair-1', 'independent-check-1-repair-1',
  ])
  assert.equal(result.budget.launches, 4)
  assert.equal(result.scheduler.counters.requiredCompletionLaunches, 4)
  assert.equal(result.scheduler.counters.requiredCompletionLaunchOverruns > 0, false,
    'the controller brand crosses the runtime economic target without falsifying scheduler topology')
  for (const workItemId of [
    'work-1', 'independent-check-1',
    'work-1-repair-1', 'independent-check-1-repair-1',
  ]) {
    assert.match(
      fixture.routeRequests.get(workItemId).assignment,
      /Keep model-visible command output bounded/u,
    )
  }
})

test('built-in deterministic verification starts after an elapsed wall target and still returns DONE', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], {
    completeProduct: true,
    wallMs: 100,
    advanceAfterInitialWorkerMs: 101,
  })
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(fixture.harness.launches.map(item => item.workItemId), [
    'work-1', 'independent-check-1',
  ])
  assert.equal(result.budget.consumedWallMs >= 101, true)
  assert.equal(result.scheduler.counters.requiredCompletionLaunches, 2)
})

test('route activation rejects malformed lane containers before topology normalization', async t => {
  const malformed = [{}, [], 'x', 1, true]
  for (const [index, lanes] of malformed.entries()) {
    const harness = makeHarness(t, {
      activationId: `malformed-lanes-${index}`,
      runId: `malformed-lanes-${index}-run`,
    })
    let productionCalls = 0
    harness.runtimeOptions.lanes = lanes
    harness.runtimeOptions.executeRoute = async () => {
      productionCalls += 1
      return usableDoneFixture(harness, `malformed-lanes-${index}`)
    }

    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    assert.equal(result.outcome, 'FAILED', JSON.stringify({ lanes, result }))
    assert.equal(result.terminalEnvelope.status, 'INVALID_LANE_SETTINGS')
    assert.equal(productionCalls, 0)
  }
})

test('root terminal session retries one transient local persistence failure without another route-model call', async t => {
  const harness = makeHarness(t)
  let routeModelCalls = 0
  let rootPersistenceAttempts = 0
  harness.runtimeOptions.decideRoute = async () => {
    routeModelCalls += 1
    return {
      decision: decision('DIRECT'),
      submittedAtMs: harness.currentTime(),
      usage: ZERO_USAGE,
    }
  }
  harness.runtimeOptions.executeRoute = async () =>
    usableDoneFixture(harness, 'root-terminal-reconciliation-result')
  harness.budget.terminalSessionWriter = terminal => {
    if (terminal.sessionId.endsWith(':root-route-decision')) {
      rootPersistenceAttempts += 1
      if (rootPersistenceAttempts === 1) {
        throw Object.assign(new Error('transient root terminal-session outage'), { code: 'EIO' })
      }
    }
    return terminal
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(routeModelCalls, 1)
  assert.equal(rootPersistenceAttempts, 2)
  assert.equal(harness.budget.snapshot().sessions[`${harness.runtimeOptions.activationId}:root-route-decision`].status, 'DONE')
})

test('local terminal settlement admits only two explicitly classified write outages', () => {
  const makeController = code => {
    const controller = new BudgetController({
      limits: { wallMs: 100_000, tokens: 10_000, sessions: 4, launches: 4 },
      finalizationReserveMs: 1_000,
      phases: {},
      monotonicMs: () => 0,
      terminalSessionWriter() {
        throw Object.assign(new Error(`terminal persistence fault: ${code}`), { code })
      },
    })
    controller.startSession(`session-${code}`, {
      activationId: 'activation-terminal-classification', parentSessionId: 'root',
    })
    return controller
  }

  const unavailable = makeController('RUN_RECORD_WRITE_UNAVAILABLE')
  const settled = persistTerminalSession(
    unavailable,
    'session-RUN_RECORD_WRITE_UNAVAILABLE',
    { status: 'DONE', evidenceHashes: [] },
  )
  assert.equal(settled.status, 'DONE')
  assert.equal(settled.localPersistenceLimitation.code, 'SESSION_TERMINAL_PERSIST_FAILED')

  for (const code of ['RUN_RECORD_UNSAFE', 'RUN_RECORD_FAILURE', 'RUN_RECORD_BUSY',
    'SESSION_TERMINAL_INTEGRITY_FAILED']) {
    const controller = makeController(code)
    assert.throws(
      () => persistTerminalSession(
        controller, `session-${code}`, { status: 'DONE', evidenceHashes: [] },
      ),
      error => error.code === code,
    )
    assert.equal(controller.snapshot().sessions[`session-${code}`].status, 'RUNNING')
  }
})

test('child success retries one transient local terminal persistence failure without another model call', async t => {
  const harness = makeHarness(t, {
    runtimeOptions: {
      settings: run030ExactSettings(),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
    },
  })
  const workItemId = 'child-terminal-reconciliation'
  const baseLauncher = harness.runtimeOptions.launcher
  let modelCalls = 0
  let childPersistenceAttempts = 0
  harness.runtimeOptions.launcher = async launch => {
    if (launch.workItemId === workItemId) modelCalls += 1
    return baseLauncher(launch)
  }
  harness.budget.terminalSessionWriter = terminal => {
    if (!terminal.sessionId.endsWith(':root-route-decision')) {
      childPersistenceAttempts += 1
      if (childPersistenceAttempts === 1) {
        throw Object.assign(new Error('transient child terminal-session outage'), { code: 'EIO' })
      }
    }
    return terminal
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const child = await launch({
      workItemId, logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
      assignment: 'Return the authenticated child completion.',
      success: ['The child completion remains usable after local reconciliation.'],
      checks: ['terminal-session reconciliation'],
    })
    assert.equal(child.allAssignedItemsPass, undefined)
    return usableDoneFixture(harness, 'child-terminal-reconciliation-result')
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(modelCalls, 1)
  assert.equal(childPersistenceAttempts, 2)
  assert.equal(Object.values(harness.budget.snapshot().sessions)
    .filter(session => !session.sessionId.endsWith(':root-route-decision'))
    .every(session => session.status === 'DONE'), true)
})

test('authenticated provider failure retries local terminal persistence without another model call', async t => {
  const harness = makeHarness(t, {
    runtimeOptions: {
      settings: run030ExactSettings(),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
    },
  })
  const workItemId = 'provider-failure-terminal-reconciliation'
  const baseLauncher = harness.runtimeOptions.launcher
  harness.record.resolve = relative => path.join(harness.directory, relative)
  let modelCalls = 0
  let failedSessionPersistenceAttempts = 0
  harness.runtimeOptions.launcher = async launch => {
    if (launch.workItemId !== workItemId) return baseLauncher(launch)
    modelCalls += 1
    launch.onUsageDelta(ZERO_USAGE)
    throw Object.assign(new Error('authenticated provider transport ended'), {
      code: 'CHILD_TRANSPORT_TIMEOUT',
    })
  }
  harness.budget.terminalSessionWriter = terminal => {
    if (terminal.status === 'FAILED') {
      failedSessionPersistenceAttempts += 1
      if (failedSessionPersistenceAttempts === 1) {
        throw Object.assign(new Error('transient provider-result session outage'), { code: 'EIO' })
      }
    }
    return terminal
  }
  let providerFailure = null
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    providerFailure = await launch({
      workItemId, logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
      assignment: 'Return the exact provider failure evidence.',
      success: ['The provider outcome remains authenticated.'],
      checks: ['provider transport evidence'],
    })
    return {
      outcome: 'PARTIAL',
      terminalEnvelope: providerFailure.terminalEnvelope,
    }
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'PARTIAL', JSON.stringify(result))
  assert.equal(providerFailure.terminalEnvelope.status, 'CHILD_TRANSPORT_TIMEOUT')
  assert.equal(modelCalls, 1)
  assert.equal(failedSessionPersistenceAttempts, 2)
  assert.equal(Object.values(harness.budget.snapshot().sessions)
    .filter(session => session.status === 'FAILED').length, 1)
})

test('persistent child terminal persistence failure returns the candidate without another model call', async t => {
  const directory = tempDirectory(t, 'autoprompt-session-persistence-candidate-')
  const target = createTempGitTarget(directory)
  const hardenedTarget = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal([0, 3].includes(hardenedTarget.status), true, hardenedTarget.stderr || hardenedTarget.stdout)
  const harness = makeHarness(t, {
    runtimeOptions: {
      targetPath: target,
      expectedBranch: 'main',
      gitEnvironment: () => process.env,
      settings: run030ExactSettings(),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
    },
  })
  const workItemId = 'persistent-terminal-session-candidate'
  const candidatePath = path.join(target, 'src', 'terminal-candidate.js')
  const baseLauncher = harness.runtimeOptions.launcher
  let modelCalls = 0
  let childPersistenceAttempts = 0
  harness.runtimeOptions.launcher = async launch => {
    if (launch.workItemId !== workItemId) return baseLauncher(launch)
    modelCalls += 1
    fs.writeFileSync(candidatePath, "module.exports = 'preserved'\n")
    return baseLauncher(launch)
  }
  harness.budget.terminalSessionWriter = terminal => {
    if (!terminal.sessionId.endsWith(':root-route-decision')) {
      childPersistenceAttempts += 1
      throw Object.assign(new Error('persistent child terminal-session outage'), {
        code: 'RUN_RECORD_WRITE_UNAVAILABLE',
      })
    }
    return terminal
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const completed = await launch({
      workItemId, logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
      assignment: 'Produce the candidate before local terminal persistence fails.',
      success: ['The candidate remains usable after local terminal persistence fails.'],
      checks: ['persistent terminal-session candidate'],
    })
    assert.equal(completed.contextId, 'context:worker')
    return {
      outcome: 'DONE', deliverables: [candidatePath],
      checkHashes: [crypto.createHash('sha256').update(fs.readFileSync(candidatePath)).digest('hex')],
    }
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(modelCalls, 1)
  assert.equal(childPersistenceAttempts, 2)
  assert.equal(fs.readFileSync(candidatePath, 'utf8'), "module.exports = 'preserved'\n")
  assert.deepEqual(harness.finalizations.at(-1).deliverables, [candidatePath])
  assert.equal(Object.values(result.budget.sessions)
    .filter(session => !session.sessionId.endsWith(':root-route-decision'))
    .every(session => session.status === 'DONE'), true)
  assert.equal(result.localPersistenceLimitations.some(item =>
    item.workItemId === workItemId && item.code === 'SESSION_TERMINAL_PERSIST_FAILED'), true)
})

test('root, child launch, and all four usage categories cross the canonical accounting seam before continuation', async t => {
  const checkpoints = []
  const harness = makeHarness(t)
  harness.runtimeOptions.accountingAuthority = {
    checkpoint(input) {
      checkpoints.push(input)
      assert.equal(input.capability, harness.missionLock.live)
      assert.deepEqual(Object.keys(input.delta.tokenUsage).sort(), [
        'cachedInput', 'noncachedInput', 'output', 'reasoning',
      ])
      return { record: { sequence: checkpoints.length } }
    },
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    await launch({
      workItemId: 'accounted-work', logicalRole: 'worker', parent: 'run-owner',
      purpose: 'work', assignment: 'Perform one accounted work item.',
      success: ['The accounting seam is complete.'], checks: ['focused check'],
    })
    return usableDoneFixture(harness, 'accounted-work-result')
  }
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(checkpoints.filter(item => item.delta.launches === 1).length, 2)
  assert.equal(checkpoints.some(item => item.cause.causeId.startsWith('root-route-decision:') &&
    item.delta.sessions === 1 && item.delta.launches === 0), true)
  assert.equal(checkpoints.filter(item => item.cause.kind === 'TOKEN_USAGE_RECORDED').length, 3)
  assert.equal(checkpoints.every(item => item.delta.elapsedMilliseconds === 0 && item.delta.costMicrounits === 0), true)
})

test('every post-acquire pre-spawn failure releases its lease and only closes a session that actually started', async t => {
  const cases = [
    { id: 'pre-session-operation', expectedFailedSessions: 0 },
    { id: 'post-session-transcript', expectedFailedSessions: 1 },
    { id: 'post-session-null', expectedFailedSessions: 1, primary: null },
    { id: 'post-session-undefined', expectedFailedSessions: 1, primary: undefined },
    {
      id: 'post-session-frozen', expectedFailedSessions: 1,
      primary: Object.freeze(Object.assign(new Error('frozen primary'), { code: 'FROZEN_PRIMARY' })),
      failTerminalPersistenceOnce: true,
    },
  ]
  for (const entry of cases) {
    const workItemId = `cleanup-${entry.id}`
    const primary = Object.hasOwn(entry, 'primary')
      ? entry.primary
      : Object.assign(new Error(`injected ${entry.id} failure`), {
          code: `INJECTED_${entry.id.toUpperCase().replaceAll('-', '_')}`,
        })
    let runtime
    let observed = null
    let failTerminalPersistenceArmed = false
    const harness = makeHarness(t, {
      activationId: `activation-${entry.id}`,
      runId: `run-${entry.id}`,
      runtimeOptions: {
        ...(entry.id.startsWith('post-session-')
          ? {
              transcriptStoreFactory({ request }) {
                if (request.workItemId === workItemId) {
                  failTerminalPersistenceArmed = entry.failTerminalPersistenceOnce === true
                  throw primary
                }
                return null
              },
            }
          : {}),
        executeRoute: async ({ launch }) => {
          try {
            await launch({
              workItemId, logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
              assignment: 'Exercise the post-acquire cleanup boundary.',
              success: ['No scheduler lease or budget session remains live.'],
              checks: ['post-acquire cleanup'],
            })
            assert.fail(`${entry.id} must fail before launcher exposure`)
          } catch (error) {
            const budget = harness.budget.snapshot()
            observed = {
              primaryPreserved: error === primary,
              currentLiveChildren: runtime.scheduler.getMetrics().counters.currentLiveChildren,
              failedSessions: Object.values(budget.sessions).filter(session => session.status === 'FAILED').length,
              runningSessions: Object.values(budget.sessions).filter(session => session.status === 'RUNNING').length,
              launcherExposed: harness.launches.some(launchRecord => launchRecord.workItemId === workItemId),
            }
          }
          return usableDoneFixture(harness, `${entry.id}-result`)
        },
      },
    })
    if (entry.failTerminalPersistenceOnce) {
      const endSession = harness.budget.endSession.bind(harness.budget)
      let failedOnce = false
      harness.budget.endSession = (...args) => {
        if (failTerminalPersistenceArmed && !failedOnce) {
          failedOnce = true
          throw new Error('injected first terminal persistence failure')
        }
        return endSession(...args)
      }
    }
    runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
    if (entry.id === 'pre-session-operation') {
      const defaultExternalOperation = runtime._defaultExternalOperation.bind(runtime)
      runtime._defaultExternalOperation = (request, assignment) => {
        if (request.workItemId === workItemId) throw primary
        return defaultExternalOperation(request, assignment)
      }
    }

    const result = await runtime.start()
    assert.equal(result.outcome, 'DONE', `${entry.id}: ${JSON.stringify(result)}`)
    assert.deepEqual(observed, {
      primaryPreserved: true,
      currentLiveChildren: 0,
      failedSessions: entry.expectedFailedSessions,
      runningSessions: 0,
      launcherExposed: false,
    })
  }
})

test('top-level primitive and frozen controller failures still reach one typed terminal result', async t => {
  const cases = [
    { id: 'null', error: null, expectedStatus: 'FAILED' },
    { id: 'undefined', error: undefined, expectedStatus: 'FAILED' },
    {
      id: 'frozen',
      error: Object.freeze(Object.assign(new Error('frozen controller failure'), { code: 'FROZEN_PRIMARY' })),
      expectedStatus: 'FROZEN_PRIMARY',
    },
  ]
  for (const entry of cases) {
    const harness = makeHarness(t, {
      activationId: `activation-top-level-${entry.id}`,
      runId: `run-top-level-${entry.id}`,
      runtimeOptions: {
        executeRoute: async () => { throw entry.error },
      },
    })
    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    assert.equal(result.outcome, 'FAILED', `${entry.id}: ${JSON.stringify(result)}`)
    assert.equal(result.terminalEnvelope.status, entry.expectedStatus)
    assert.notEqual(result.terminalEnvelope.error && result.terminalEnvelope.error.name, 'TypeError')
    assert.equal(harness.finalizations.length, 1)
    assert.equal(harness.finalizations[0].outcome, 'FAILED')
  }
})

test('monotonic attended user wait is recorded separately and excluded from the admission hard sum', async t => {
  const harness = makeHarness(t)
  let runtime
  harness.runtimeOptions.executeRoute = async () => {
    runtime.recordUserWait(300000)
    return usableDoneFixture(harness, 'user-wait-result')
  }
  runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
  const result = await runtime.start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.scheduler.admission.waitingUserMs, 300000)
  assert.equal(result.scheduler.admission.includedMs, 0)
})

test('LIGHT planning target overrun records convergence pressure but still reaches essential execution', async t => {
  const harness = makeHarness(t)
  let executed = false
  harness.runtimeOptions.decideRoute = async () => ({
    decision: decision('LIGHT'), submittedAtMs: harness.currentTime(), usage: ZERO_USAGE,
  })
  harness.runtimeOptions.planPreparer = async () => { harness.advance(300001) }
  harness.runtimeOptions.executeRoute = async () => {
    executed = true
    return usableDoneFixture(harness, 'late-light-plan-result')
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.scheduler.admission.withinCeiling, false)
  assert.deepEqual(result.scheduler.admission.breaches, ['lightPlanning'])
  assert.equal(result.scheduler.admission.completionCanContinue, true)
  assert.equal(executed, true)
})

test('benchmark baseEnvironment keeps finite targets and records overruns while essential work completes', async t => {
  const harness = makeHarness(t)
  harness.runtimeOptions.baseEnvironment = {
    ...process.env,
    AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1',
  }
  harness.runtimeOptions.budgetController = new BudgetController({
    limits: { wallMs: 600000, tokens: 1000000, sessions: 20, launches: 20 },
    finalizationReserveMs: 10,
    phases: {},
    monotonicMs: () => harness.currentTime(),
    monotonicClockId: 'benchmark-unbounded-test-monotonic',
    wallTimeUnbounded: true,
  })
  const baseLauncher = harness.runtimeOptions.launcher
  harness.runtimeOptions.launcher = async launch => {
    const result = await baseLauncher(launch)
    if (launch.logicalRole === 'route-analyst') harness.advance(25 * 60 * 60 * 1000)
    return result
  }
  harness.runtimeOptions.decideRoute = async () => {
    harness.advance(25 * 60 * 60 * 1000)
    return { decision: decision('LIGHT'), submittedAtMs: harness.currentTime(), usage: ZERO_USAGE }
  }
  harness.runtimeOptions.planPreparer = async () => { harness.advance(48 * 60 * 60 * 1000) }
  harness.runtimeOptions.executeRoute = async () => usableDoneFixture(harness, 'benchmark-unbounded-result')

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(result.scheduler.admission.breaches, [
    'admissionP95', 'combined', 'lightPlanning', 'routeAnalyst', 'routeDecision',
  ])
  assert.equal(result.scheduler.admission.withinCeiling, false)
  assert.equal(result.scheduler.admission.completionCanContinue, true)
  assert.equal(result.schedulerState.settings.budget.admissionHardMs, ROUTE_BUDGETS.LIGHT.admissionHardMs)
  assert.equal(result.schedulerState.settings.budget.tokens.noncachedInput,
    ROUTE_BUDGETS.LIGHT.tokens.noncachedInput)
})

test('terminal finalization retries a transient drain without replacing its durable outcome', async () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  let drainAttempts = 0
  let finalizeCalls = 0
  const cancellationOptions = []
  Object.assign(runtime, {
    finished: false,
    finalizing: false,
    finalizationPromise: null,
    scheduler: null,
    route: 'DIRECT',
    lease: {},
    processOwner: {
      async cancelAll(options) {
        cancellationOptions.push(options)
        drainAttempts += 1
        if (drainAttempts === 1) throw Object.assign(new Error('transient drain failure'), { code: 'PROCESS_DRAIN_TIMEOUT' })
      },
      async assertDrained() { return true },
    },
    finalizer: { async finalize() { finalizeCalls += 1; return { durable: true } } },
    missionLock: { release() {} },
    budget: { snapshot: () => ({}) },
    _enforceBudgetPhase: () => ({ action: 'CONTINUE' }),
  })

  const result = await runtime._finish('FAILED')
  assert.equal(result.outcome, 'FAILED')
  assert.equal(runtime.finished, true)
  assert.equal(drainAttempts, 2)
  assert.equal(finalizeCalls, 1)
  assert.equal(cancellationOptions.every(options => options.waitForPending === true), true,
    'terminal release must wait through each durable RESERVED startup deadline')
})

test('full start retries one-shot process drains for WAITING_USER and budget PAUSED without losing resumable intent', async t => {
  const makeTransientOwner = failurePoint => ({
    cancelCalls: 0,
    drainCalls: 0,
    async cancelAll() {
      this.cancelCalls += 1
      if (failurePoint === 'cancelAll' && this.cancelCalls === 1) {
        throw Object.assign(new Error('transient cancellation drain failure'), { code: 'PROCESS_DRAIN_TIMEOUT' })
      }
    },
    async assertDrained() {
      this.drainCalls += 1
      if (failurePoint === 'assertDrained' && this.drainCalls === 1) {
        throw Object.assign(new Error('transient drain assertion failure'), { code: 'PROCESS_DRAIN_TIMEOUT' })
      }
      return true
    },
  })

  for (const failurePoint of ['cancelAll', 'assertDrained']) {
    const waitingOwner = makeTransientOwner(failurePoint)
    const waitingHarness = makeHarness(t, {
      runId: `run-waiting-${failurePoint}`,
      activationId: `activation-waiting-${failurePoint}`,
      processOwner: waitingOwner,
    })
    const waitingDecision = {
      ...decision('DIRECT'),
      status: 'WAITING_USER',
      route: null,
      userInputNeeded: ['Supply the exact authorized destination.'],
    }
    waitingHarness.runtimeOptions.decideRoute = async () => ({
      decision: waitingDecision,
      submittedAtMs: waitingHarness.currentTime(),
      usage: ZERO_USAGE,
    })
    waitingHarness.runtimeOptions.verifyAutomaticWaitingAuthority = () => ({
      authenticated: true,
      authorityClass: 'TARGET_AUTHORITY',
      evidenceHash: CANDIDATE_A,
    })
    const waitingResult = await new CodexSupervisorRuntime(waitingHarness.runtimeOptions).start()
    assert.equal(waitingResult.outcome, 'WAITING_USER', JSON.stringify(waitingResult))
    assert.equal(waitingResult.resumable, true)
    assert.equal(waitingOwner.cancelCalls, 2)
    assert.equal(waitingOwner.drainCalls, failurePoint === 'assertDrained' ? 2 : 1)
    assert.equal(waitingHarness.missionLock.releaseCalls, 1)

    const pausedOwner = makeTransientOwner(failurePoint)
    const pausedTransitions = []
    const pausedHarness = makeHarness(t, {
      runId: `run-paused-${failurePoint}`,
      activationId: `activation-paused-${failurePoint}`,
      processOwner: pausedOwner,
      runtimeOptions: {
        runtimeStateProvider: () => ({ state: 'RUN_WORK' }),
        persistRecoveryCheckpoint: () => ({
          record: { checkpointPayloadHash: 'b'.repeat(64) },
        }),
        runtimeTransition: async input => {
          pausedTransitions.push(input)
          return null
        },
      },
    })
    let pausedRuntime
    pausedHarness.runtimeOptions.executeRoute = async () => {
      pausedRuntime.latestRecoveryCheckpoint = {
        record: {
          checkpoint: {
            scheduler: { nextReadyWorkIds: ['work-1'] },
            recovery: { resumeState: 'RUN_WORK' },
          },
          checkpointPayloadHash: 'a'.repeat(64),
        },
      }
      throw Object.assign(new Error('pause with exact frontier'), { code: 'BUDGET_EXHAUSTED' })
    }
    pausedRuntime = new CodexSupervisorRuntime(pausedHarness.runtimeOptions)
    const pausedResult = await pausedRuntime.start()
    assert.equal(pausedResult.outcome, 'PAUSED', JSON.stringify(pausedResult))
    assert.equal(pausedResult.resumable, true)
    assert.equal(pausedOwner.cancelCalls, 2)
    assert.equal(pausedOwner.drainCalls, failurePoint === 'assertDrained' ? 2 : 1)
    assert.equal(pausedHarness.missionLock.releaseCalls, 1)
    assert.equal(pausedTransitions.filter(item => item.eventId === 'BUDGET_EXHAUSTED_RESUMABLE').length, 1)
  }
})

test('PAUSED recovery retries checkpoint, transition, and lease release without losing or duplicating the accepted pause', async t => {
  for (const failurePoint of ['checkpoint', 'transition', 'release']) {
    let runtimeState = 'RUN_WORK'
    let checkpointAttempts = 0
    let transitionAttempts = 0
    let acceptedTransitions = 0
    let releaseAttempts = 0
    const harness = makeHarness(t, {
      runId: `run-paused-boundary-${failurePoint}`,
      activationId: `activation-paused-boundary-${failurePoint}`,
      runtimeOptions: {
        runtimeStateProvider: () => ({ state: runtimeState }),
        persistRecoveryCheckpoint: payload => {
          const pauseCheckpoint = payload && payload.cause &&
            String(payload.cause.causeId || '').startsWith('pause-post-drain:')
          if (!pauseCheckpoint) return { record: { checkpointPayloadHash: 'c'.repeat(64) } }
          checkpointAttempts += 1
          if (failurePoint === 'checkpoint' && checkpointAttempts === 1) {
            throw Object.assign(new Error('transient pause checkpoint failure'), {
              code: 'PAUSE_DRAIN_CHECKPOINT_REQUIRED',
            })
          }
          return { record: { checkpointPayloadHash: 'b'.repeat(64) } }
        },
        runtimeTransition: async input => {
          if (input.eventId !== 'BUDGET_EXHAUSTED_RESUMABLE') {
            return null
          }
          transitionAttempts += 1
          if (failurePoint === 'transition' && transitionAttempts === 1) {
            throw Object.assign(new Error('transient pause transition failure'), {
              code: 'PAUSE_DRAIN_CHECKPOINT_REQUIRED',
            })
          }
          acceptedTransitions += 1
          runtimeState = 'PAUSED'
        },
      },
    })
    const originalRelease = harness.missionLock.release.bind(harness.missionLock)
    harness.missionLock.release = (...args) => {
      releaseAttempts += 1
      if (failurePoint === 'release' && releaseAttempts === 1) {
        throw Object.assign(new Error('transient pause release failure'), {
          code: 'MISSION_LOCK_RELEASE_FAILED',
        })
      }
      return originalRelease(...args)
    }
    let runtime
    harness.runtimeOptions.executeRoute = async () => {
      runtime.latestRecoveryCheckpoint = {
        record: {
          checkpoint: {
            scheduler: { nextReadyWorkIds: ['work-1'] },
            recovery: { resumeState: 'RUN_WORK' },
          },
          checkpointPayloadHash: 'a'.repeat(64),
        },
      }
      throw Object.assign(new Error('pause with exact frontier'), { code: 'BUDGET_EXHAUSTED' })
    }
    runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
    const result = await runtime.start()
    assert.equal(result.outcome, 'PAUSED', `${failurePoint}: ${JSON.stringify(result)}`)
    assert.equal(result.resumable, true)
    assert.equal(acceptedTransitions, 1)
    assert.equal(harness.missionLock.releaseCalls, 1)
    assert.equal(releaseAttempts, failurePoint === 'release' ? 2 : 1)
    assert.equal(checkpointAttempts, failurePoint === 'checkpoint' || failurePoint === 'transition' ? 2 : 1)
    assert.equal(transitionAttempts, failurePoint === 'transition' ? 2 : 1)
  }
})

test('WAITING_USER retries a one-shot lease release failure and preserves the immutable handoff', async t => {
  const harness = makeHarness(t, {
    runId: 'run-waiting-release-boundary', activationId: 'activation-waiting-release-boundary',
  })
  let releaseAttempts = 0
  const originalRelease = harness.missionLock.release.bind(harness.missionLock)
  harness.missionLock.release = (...args) => {
    releaseAttempts += 1
    if (releaseAttempts === 1) {
      throw Object.assign(new Error('transient waiting-user release failure'), {
        code: 'MISSION_LOCK_RELEASE_FAILED',
      })
    }
    return originalRelease(...args)
  }
  harness.runtimeOptions.decideRoute = async () => ({
    decision: {
      ...decision('DIRECT'), status: 'WAITING_USER', route: null,
      userInputNeeded: ['Supply the exact authorized destination.'],
    },
    submittedAtMs: harness.currentTime(), usage: ZERO_USAGE,
  })
  harness.runtimeOptions.verifyAutomaticWaitingAuthority = () => ({
    authenticated: true,
    authorityClass: 'TARGET_AUTHORITY',
    evidenceHash: CANDIDATE_A,
  })
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'WAITING_USER', JSON.stringify(result))
  assert.equal(result.resumable, true)
  assert.equal(releaseAttempts, 2)
  assert.equal(harness.missionLock.releaseCalls, 1)
})

test('model-authored WAITING_USER prose without authenticated authority collapses to local product completion', async t => {
  let executed = 0
  const harness = makeHarness(t, {
    runId: 'run-model-waiting-collapse',
    activationId: 'activation-model-waiting-collapse',
    executeRoute: async input => {
      executed += 1
      assert.equal(input.route, 'DIRECT')
      return usableDoneFixture(harness, 'model-waiting-collapsed-product')
    },
  })
  harness.runtimeOptions.decideRoute = async () => ({
    decision: {
      ...decision('DIRECT'),
      status: 'WAITING_USER',
      route: null,
      userInputNeeded: ['The model claims an uncertain external or irreversible choice.'],
    },
    submittedAtMs: harness.currentTime(),
    usage: ZERO_USAGE,
  })
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(executed, 1)
})

test('Codex advisory semantic caps reject large schema-valid strings and cardinality before dispatch', () => {
  assert.equal(validateCodexAdvisoryPayloadBounds({ likelyAreas: ['src/example.js'] }).valid, true)
  for (const oversized of [
    { likelyAreas: ['x'.repeat(64 * 1024)] },
    { likelyAreas: ['x'.repeat(8 * 1024 * 1024)] },
    { likelyAreas: Array.from({ length: 4096 }, (_, index) => `src/${index}.js`) },
  ]) {
    const verdict = validateCodexAdvisoryPayloadBounds(oversized)
    assert.equal(verdict.valid, false)
    assert.match(verdict.evidenceHash, /^[a-f0-9]{64}$/u)
    assert.ok(verdict.summary.violations.length > 0)
  }
})

test('schema-valid over-bound analyst bodies still enter the conservative product frontier', async t => {
  const cases = [
    ['64KiB string', { likelyAreas: ['x'.repeat(64 * 1024)] }],
    ['8MiB string', { likelyAreas: ['x'.repeat(8 * 1024 * 1024)] }],
    ['4096 entries', { likelyAreas: Array.from({ length: 4096 }, (_, index) => `src/${index}.js`) }],
  ]
  for (const [name, advisoryFields] of cases) await t.test(name, async () => {
    let productExecutions = 0
    let analysisStatus = null
    const harness = makeHarness(t, {
      runId: `semantic-cap-${name.replace(/\W+/gu, '-').toLowerCase()}`,
      activationId: `semantic-cap-activation-${name.replace(/\W+/gu, '-').toLowerCase()}`,
      executeRoute: async input => {
        productExecutions += 1
        assert.equal(input.route, 'DIRECT')
        return usableDoneFixture(harness, `semantic-cap-product-${productExecutions}`)
      },
    })
    const oversized = recommendation('DIRECT')
    Object.assign(oversized, advisoryFields)
    const baseLauncher = harness.runtimeOptions.launcher
    harness.runtimeOptions.launcher = async launch => {
      if (launch.logicalRole !== 'route-analyst') return baseLauncher(launch)
      harness.launches.push(launch)
      return {
        recommendation: oversized,
        events: [{ type: 'analysis', summary: 'schema-valid over-bound advisory' }],
        elapsedMs: 1,
        usage: ZERO_USAGE,
      }
    }
    harness.runtimeOptions.decideRoute = async ({ analysis }) => {
      analysisStatus = analysis.status
      return { decision: decision('DIRECT'), submittedAtMs: harness.currentTime(), usage: ZERO_USAGE }
    }

    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    assert.equal(result.outcome, 'DONE', JSON.stringify(result))
    assert.equal(analysisStatus, 'ROUTE_ANALYST_MALFORMED')
    assert.equal(productExecutions, 1)
    assert.deepEqual(harness.launches.map(launch => launch.logicalRole), ['route-analyst'])
    assert.equal(harness.record.writes.has('route/recommendation.json'), false)
  })
})

test('full start retries the exact verified DONE intent after one transient terminal drain failure', async t => {
  const processOwner = {
    cancelled: 0,
    drained: 0,
    async cancelAll() {
      this.cancelled += 1
      if (this.cancelled === 1) {
        throw Object.assign(new Error('transient drain failure'), { code: 'PROCESS_DRAIN_TIMEOUT' })
      }
    },
    async assertDrained() { this.drained += 1; return true },
  }
  const harness = makeHarness(t, { processOwner })
  harness.runtimeOptions.executeRoute = async () => usableDoneFixture(harness, 'drain-retry-done')

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(processOwner.cancelled, 2)
  assert.equal(processOwner.drained, 1)
  assert.deepEqual(harness.finalizations.map(item => item.outcome), ['DONE'])
  assert.equal(harness.missionLock.releaseCalls, 1)
})

test('durable-finalizer availability failure propagates without releasing or exposing DONE', async t => {
  const harness = makeHarness(t)
  let attempts = 0
  harness.runtimeOptions.finalizerFactory = async () => ({
    async finalize() {
      attempts += 1
      throw Object.assign(new Error('durable finalizer failure'), {
        code: 'FINALIZER_WRITE_INTERRUPTED',
      })
    },
  })
  harness.runtimeOptions.executeRoute = async () => usableDoneFixture(harness, 'finalizer-retry-done')

  await assert.rejects(
    new CodexSupervisorRuntime(harness.runtimeOptions).start(),
    error => error.code === 'FINALIZER_WRITE_INTERRUPTED',
  )
  assert.equal(attempts, 1)
  assert.deepEqual(harness.finalizations, [])
  assert.equal(harness.missionLock.releaseCalls, 0)
})

test('finalizer integrity disagreement propagates without retry or lease release', async t => {
  const harness = makeHarness(t)
  let attempts = 0
  harness.runtimeOptions.finalizerFactory = async () => ({
    async finalize() {
      attempts += 1
      throw Object.assign(new Error('workspace epoch changed before finalization'), {
        code: 'CONCURRENT_MUTATION',
      })
    },
  })
  const exact = usableDoneFixture(harness, 'persistent-finalizer-candidate')
  harness.runtimeOptions.executeRoute = async () => exact

  await assert.rejects(
    new CodexSupervisorRuntime(harness.runtimeOptions).start(),
    error => error.code === 'CONCURRENT_MUTATION',
  )
  assert.equal(attempts, 1)
  assert.equal(harness.missionLock.releaseCalls, 0)
  assert.deepEqual(harness.launches.map(item => item.logicalRole), ['route-analyst'])
})

test('concurrent start and explicit cancellation share one truthful terminal release', async t => {
  let rejectExecution
  let announceExecution
  const executionStarted = new Promise(resolve => { announceExecution = resolve })
  const processOwner = {
    cancelled: 0,
    drained: 0,
    async cancelAll() {
      this.cancelled += 1
      if (rejectExecution) {
        const reject = rejectExecution
        rejectExecution = null
        reject(Object.assign(new Error('owned execution cancelled'), { code: 'CODEX_CHILD_FAILED' }))
      }
    },
    async assertDrained() { this.drained += 1; return true },
  }
  const harness = makeHarness(t, { processOwner })
  harness.runtimeOptions.executeRoute = async () => new Promise((resolve, reject) => {
    rejectExecution = reject
    announceExecution()
  })
  const runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
  const started = runtime.start()
  await executionStarted
  const cancelled = runtime.cancel('test cancellation')
  const [startResult, cancelResult] = await Promise.all([started, cancelled])

  assert.equal(startResult.outcome, 'CANCELLED')
  assert.deepEqual(startResult, cancelResult)
  assert.equal(harness.finalizations.length, 1)
  assert.equal(harness.finalizations[0].outcome, 'CANCELLED')
  assert.equal(harness.missionLock.releaseCalls, 1)
})

test('cancellation at every pre-execution startup seam prevents post-cancel work and shares one result', async t => {
  {
    let announce
    let release
    const entered = new Promise(resolve => { announce = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const harness = makeHarness(t, { activationId: 'cancel-before-lock', runId: 'cancel-before-lock' })
    harness.runtimeOptions.beforeMissionAcquire = async () => { announce(); await gate }
    const runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
    const started = runtime.start()
    await entered
    const cancelled = runtime.cancel('cancel before mission acquire')
    release()
    const [startResult, cancelResult] = await Promise.all([started, cancelled])
    assert.deepEqual(startResult, cancelResult)
    assert.equal(startResult.outcome, 'CANCELLED')
    assert.equal(harness.missionLock.releaseCalls, 0)
    assert.deepEqual(harness.launches, [])
  }
  for (const seam of ['recordFactory', 'requestPointerFactory', 'finalizerFactory']) {
    let announce
    let release
    const entered = new Promise(resolve => { announce = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const harness = makeHarness(t, { activationId: `cancel-${seam}`, runId: `cancel-${seam}` })
    const original = harness.runtimeOptions[seam]
    harness.runtimeOptions[seam] = async (...args) => {
      announce()
      await gate
      return original(...args)
    }
    const runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
    const started = runtime.start()
    await entered
    const cancelled = runtime.cancel(`cancel during ${seam}`)
    release()
    const [startResult, cancelResult] = await Promise.all([started, cancelled])
    assert.deepEqual(startResult, cancelResult, seam)
    assert.equal(startResult.outcome, 'CANCELLED', seam)
    assert.equal(harness.missionLock.releaseCalls, 1, seam)
    assert.deepEqual(harness.launches, [], seam)
  }
})

test('late cancellation returns the immutable settled result without a second drain or release', async t => {
  const processOwner = {
    cancelCalls: 0,
    drainCalls: 0,
    async cancelAll() { this.cancelCalls += 1 },
    async assertDrained() { this.drainCalls += 1; return true },
  }
  const harness = makeHarness(t, { processOwner, activationId: 'late-cancel', runId: 'late-cancel' })
  harness.runtimeOptions.executeRoute = async () => usableDoneFixture(harness, 'late-cancel-done')
  const runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
  const settled = await runtime.start()
  const drainCounts = [processOwner.cancelCalls, processOwner.drainCalls]
  const releases = harness.missionLock.releaseCalls
  const lateCancel = await runtime.cancel('too late to replace DONE')
  assert.deepEqual(lateCancel, settled)
  assert.equal(lateCancel.outcome, 'DONE')
  assert.deepEqual([processOwner.cancelCalls, processOwner.drainCalls], drainCounts)
  assert.equal(harness.missionLock.releaseCalls, releases)
})

test('explicit cancellation retries one transient process drain and commits CANCELLED once', async t => {
  let rejectExecution
  let announceExecution
  const executionStarted = new Promise(resolve => { announceExecution = resolve })
  const processOwner = {
    cancelCalls: 0,
    drainCalls: 0,
    async cancelAll() {
      this.cancelCalls += 1
      if (this.cancelCalls === 1) {
        throw Object.assign(new Error('transient cancellation drain failure'), { code: 'PROCESS_DRAIN_TIMEOUT' })
      }
      if (rejectExecution) {
        const reject = rejectExecution
        rejectExecution = null
        reject(Object.assign(new Error('owned execution cancelled'), { code: 'CODEX_CHILD_FAILED' }))
      }
    },
    async assertDrained() { this.drainCalls += 1; return true },
  }
  const harness = makeHarness(t, { processOwner })
  harness.runtimeOptions.executeRoute = async () => new Promise((resolve, reject) => {
    rejectExecution = reject
    announceExecution()
  })
  const runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
  const started = runtime.start()
  await executionStarted
  const [startResult, cancelResult] = await Promise.all([
    started,
    runtime.cancel('authenticated cancellation'),
  ])

  assert.equal(startResult.outcome, 'CANCELLED')
  assert.deepEqual(startResult, cancelResult)
  assert.equal(processOwner.cancelCalls, 2)
  assert.equal(processOwner.drainCalls, 1)
  assert.deepEqual(harness.finalizations.map(item => item.outcome), ['CANCELLED'])
  assert.equal(harness.missionLock.releaseCalls, 1)
})

test('terminal release preserves worker, environment, controller, and authoritative-check provenance', async () => {
  const exercise = async (state, code, terminalEnvelope = null) => {
    const events = []
    let current = state
    const runtime = Object.create(CodexSupervisorRuntime.prototype)
    runtime.finalizer = {}
    runtime.options = { runtimeStateProvider: () => ({ state: current }) }
    runtime._runtimeTransition = async (eventId, nextState) => {
      events.push(eventId)
      current = nextState
    }
    const outcome = await runtime._enterTerminalRelease(
      'FAILED', Object.assign(new Error(code), { code }), terminalEnvelope,
    )
    return { events, outcome }
  }

  assert.deepEqual(await exercise('RUN_WORK', 'CODEX_SESSION_ID_MISSING'), {
    events: ['WORKER_CONTEXT_LOST', 'WORKER_CONTEXT_UNRECOVERABLE'], outcome: 'FAILED',
  })
  assert.deepEqual(await exercise('RUN_WORK', 'CODEX_TYPED_TERMINAL_MISSING'), {
    events: ['WORKER_CONTEXT_LOST', 'WORKER_CONTEXT_UNRECOVERABLE'], outcome: 'FAILED',
  })
  assert.deepEqual(await exercise('RUN_WORK', 'WORK_ITEM_RESULT_FAILED'), {
    events: ['CONTROLLER_FAILED_FINAL'], outcome: 'FAILED',
  })
  assert.deepEqual(await exercise('CHECK_WORK', 'PROVIDER_UNSUPPORTED'), {
    events: ['ENVIRONMENT_BLOCKED'], outcome: 'BLOCKED',
  })
  assert.deepEqual(await exercise('APPEND_REQUEST_STEERING', 'CHECK_RETRY_STATE_INVALID'), {
    events: ['CONTROLLER_FAILED_FINAL'], outcome: 'FAILED',
  })
  assert.deepEqual(await exercise('CHECK_WORK', 'CHECK_FAILED', { status: 'FAIL' }), {
    events: ['CHECK_FAILED_FINAL'], outcome: 'FAILED',
  })
})

test('every recoverable runtime transition requires exact physical next-ready identities', async () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  const checkpoints = []
  let sequence = 0
  Object.assign(runtime, {
    activation: { id: 'frontier-activation', generation: 1 },
    lastAcceptedProgress: null,
    scheduler: {},
    options: {
      runtimeTransition: async () => ({
        sequence: ++sequence,
        lastEventHash: crypto.createHash('sha256').update(`frontier-${sequence}`).digest('hex'),
      }),
    },
    _enforceBudgetPhase: () => null,
    _persistRecoveryCheckpoint: (cause, hints) => checkpoints.push({ cause, hints }),
  })
  const recoverable = [
    ['PREPARE_WORK', ['roadmap-author']],
    ['RUN_WORK', ['work-1']],
    ['ITEM_VERIFIED', ['independent-check-1']],
    ['CHECK_WORK', []],
    ['REPAIRING', ['work-1-repair-1']],
  ]
  for (const [state, nextReadyWorkIds] of recoverable) {
    await runtime._runtimeTransition('TEST_TRANSITION', state, { nextReadyWorkIds })
  }
  await runtime._runtimeTransition('TEST_EXPLICIT', 'CHECK_INCONCLUSIVE', {
    nextReadyWorkIds: ['independent-check-1-runtime-retry-1'],
  })
  assert.equal(checkpoints.length, 6)
  assert.deepEqual(checkpoints.slice(0, 5).map(item => item.hints.nextReadyWorkIds), [
    ['roadmap-author'],
    ['work-1'],
    ['independent-check-1'],
    [],
    ['work-1-repair-1'],
  ])
  assert.deepEqual(checkpoints.at(-1).hints.nextReadyWorkIds, [
    'independent-check-1-runtime-retry-1',
  ])
  await assert.rejects(
    runtime._runtimeTransition('TEST_MISSING', 'RUN_WORK'),
    error => error.code === 'RECOVERY_FRONTIER_REQUIRED',
  )
})

test('camel and snake optional scope flags cannot bypass marginal-value admission', async t => {
  for (const optionalField of ['optionalWork', 'optional_work']) {
    const harness = makeHarness(t, { activationId: `optional-${optionalField}`, runId: `run-${optionalField}` })
    let code = null
    harness.runtimeOptions.executeRoute = async ({ launch }) => {
      try {
        await launch({
          workItemId: `optional-${optionalField}`, logicalRole: 'worker', parent: 'run-owner',
          purpose: 'work', assignment: 'Attempt optional work without a value case.',
          success_checklist: ['The optional work would complete.'], checks: ['focused check'],
          [optionalField]: true,
        })
      } catch (error) { code = error.code }
      return usableDoneFixture(harness, `optional-${optionalField}-result`)
    }
    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    assert.equal(result.outcome, 'DONE', JSON.stringify(result))
    assert.equal(code, 'MARGINAL_VALUE_REQUIRED', optionalField)
    assert.equal(harness.launches.some(item => item.workItemId === `optional-${optionalField}`), false)
  }
})

test('snake context fields are delivered while checker resources remain manifest-derived', async t => {
  const harness = makeHarness(t)
  let workerDispatch = null
  let checkerOverrideCode = null
  const baseLauncher = harness.runtimeOptions.launcher
  harness.runtimeOptions.launcher = async launch => {
    if (launch.workItemId === 'snake-context') workerDispatch = launch.dispatch
    return baseLauncher(launch)
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    await launch({
      workItemId: 'snake-context', logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
      assignment: 'Consume the bounded snake-case context.',
      success_checklist: ['The context survives canonicalization.'], return_shape: 'typed result',
      evidence_pointers: [{ name: 'test-evidence', path: path.join(harness.directory, 'evidence.json'), hash: CANDIDATE_A }],
      roadmap_slice: { id: 'slice-1' }, manifest_pointers: [{ id: 'manifest-1' }],
      fetched_evidence: [{ id: 'evidence-1' }], checks: ['focused check'],
    })
    try {
      await launch({
        workItemId: 'checker-resource-override', logicalRole: 'independent-reviewer', parent: 'run-owner',
        purpose: 'verification', assignment: 'Attempt to replace the frozen checker manifest.',
        success: ['The override is rejected.'], checks: ['focused check'], candidateHash: CANDIDATE_A,
        oracle: 'override-oracle', scheduler_resources: [{ id: 'workspace:caller-owned', mode: 'shared' }],
      })
    } catch (error) { checkerOverrideCode = error.code }
    return usableDoneFixture(harness, 'snake-context-result')
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(workerDispatch.roadmapSlice, { id: 'slice-1' })
  assert.deepEqual(workerDispatch.manifests, [{ id: 'manifest-1' }])
  assert.deepEqual(workerDispatch.fetchedEvidence, [{ id: 'evidence-1' }])
  assert.match(workerDispatch.brief, /Success:\n- The context survives canonicalization\./)
  assert.match(workerDispatch.brief, /Return: typed result/)
  assert.equal(checkerOverrideCode, 'CHECKER_RESOURCE_OVERRIDE_DENIED')
  assert.equal(harness.launches.some(item => item.workItemId === 'checker-resource-override'), false)
})

test('tokensaver remains concurrency-width-only after route freeze', async t => {
  const harness = makeHarness(t)
  harness.runtimeOptions.executeRoute = async () => usableDoneFixture(harness, 'tokensaver-result')
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.schedulerState.settings.concurrencyPreset, 'tokensaver')
  assert.equal(result.schedulerState.settings.policyClass, 'concurrency-width-only')
  assert.equal(result.schedulerState.settings.economicPolicySource, 'route')
})

test('rejected optional launch cannot replace the startup marker or block later essential work', async t => {
  const harness = makeHarness(t)
  let rejectedCode = null
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    try {
      await launch({
        workItemId: 'marginal-without-value', logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
        assignment: 'This rejected launch must not consume startup admission.', success: ['never'], checks: ['never'],
        implied_scope: true,
      })
    } catch (error) { rejectedCode = error.code }
    harness.advance(130001)
    await launch({
      workItemId: 'late-valid-work', logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
      assignment: 'This valid launch is beyond the startup ceiling.', success: ['never starts'], checks: ['focused check'],
    })
    return usableDoneFixture(harness, 'scheduler-admission-result')
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(rejectedCode, 'MARGINAL_VALUE_REQUIRED')
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(result.scheduler.admission.breaches, ['bootstrap'])
  assert.equal(result.scheduler.admission.completionCanContinue, true)
  assert.equal(result.scheduler.admission.components.firstChildStartup, 130001)
  assert.equal(harness.launches.some(item => item.workItemId === 'late-valid-work'), true)
})

test('AP-RUN-010 same activation resume restores protected reserves and cumulative counters', async t => {
  const first = makeHarness(t, { activationId: 'resume-activation', runId: 'resume-run' })
  first.runtimeOptions.executeRoute = async ({ launch }) => {
    await launch({
      workItemId: 'first-work', logicalRole: 'worker', parent: 'run-owner', depth: 1,
      purpose: 'work', assignment: 'Complete the first saved slice.', success: ['slice saved'], checks: ['focused check'],
    })
    first.advance(25)
    return { outcome: 'PARTIAL' }
  }
  const firstResult = await new CodexSupervisorRuntime(first.runtimeOptions).start()
  assert.equal(firstResult.outcome, 'PARTIAL')
  assert.equal(firstResult.budget.launches, first.launches.length)
  assert.equal(first.launches.filter(item => item.logicalRole === 'diagnostic-probe').length, 0)

  const second = makeHarness(t, {
    missionLock: first.missionLock,
    activationId: 'resume-activation',
    runId: 'resume-run',
  })
  const resumedBudget = new BudgetController({
    limits: firstResult.budget.limits,
    finalizationReserveMs: firstResult.budget.finalizationReserveMs,
    verificationReserveMs: firstResult.budget.verificationReserveMs || 0,
    phases: {},
    monotonicMs: () => first.currentTime(),
    monotonicClockId: 'test-monotonic',
    wallNowMs: () => first.currentTime(),
    snapshot: firstResult.budget,
  })
  second.runtimeOptions.activationId = 'resume-activation'
  second.runtimeOptions.generation = 2
  second.runtimeOptions.budgetController = resumedBudget
  second.runtimeOptions.previousBudgetSnapshot = firstResult.budget
  second.runtimeOptions.resumeState = {
    decision: decision('DIRECT'), schedulerState: firstResult.schedulerState,
    deadline: firstResult.budget.deadline,
  }
  second.runtimeOptions.readResult = workItemId => {
    const relative = `work/results/${crypto.createHash('sha256').update(workItemId).digest('hex')}.json`
    const bytes = first.record.writes.get(relative)
    return bytes ? JSON.parse(bytes) : null
  }
  second.runtimeOptions.now = () => first.currentTime()
  second.runtimeOptions.executeRoute = async ({ launch }) => {
    await launch({
      workItemId: 'resumed-work', logicalRole: 'worker', parent: 'run-owner', depth: 1,
      purpose: 'work', assignment: 'Continue the exact saved state.', success: ['resume passes'], checks: ['focused check'],
    })
    return {
      outcome: 'DONE',
      deliverables: ['same-activation-resume-fixture'],
      checkHashes: [CANDIDATE_A],
    }
  }
  const secondResult = await new CodexSupervisorRuntime(second.runtimeOptions).start()
  assert.equal(secondResult.outcome, 'DONE', JSON.stringify(secondResult))
  assert.equal(secondResult.budget.launches, firstResult.budget.launches + second.launches.length)
  assert.equal(secondResult.budget.consumedWallMs >= firstResult.budget.consumedWallMs, true)
  assert.equal(second.launches.some(item => item.logicalRole === 'route-analyst'), false)
  assert.equal(secondResult.scheduler.counters.totalLaunches, secondResult.budget.launches)
})

test('resume rejects routeSource tampering before any resumed production launch', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const declared = run030Deadline(new Date(wallNowMs + 1_200_000).toISOString())
  const first = makeHarness(t, {
    activationId: 'source-resume', runId: 'source-resume-run', wallMs: 3_600_000,
    runtimeOptions: {
      now: () => wallNowMs,
      settings: run030AutomaticSettings(declared),
      l0ViaScheduler: false,
      decideRoute: async () => ({
        decision: decision('DIRECT'), submittedAtMs: wallNowMs, usage: ZERO_USAGE,
      }),
      executeRoute: async () => ({ outcome: 'PARTIAL' }),
    },
  })
  const firstResult = await new CodexSupervisorRuntime(first.runtimeOptions).start()
  assert.equal(firstResult.outcome, 'PARTIAL', JSON.stringify(firstResult))
  assert.equal(firstResult.schedulerState.routeSource, 'automatic')
  assert.deepEqual(firstResult.budget.deadline, declared)

  const second = makeHarness(t, {
    missionLock: first.missionLock, activationId: 'source-resume', runId: 'source-resume-run',
    runtimeOptions: { now: () => wallNowMs, settings: run030AutomaticSettings(declared) },
  })
  second.runtimeOptions.generation = 2
  second.runtimeOptions.previousBudgetSnapshot = firstResult.budget
  second.runtimeOptions.budgetController = new BudgetController({
    limits: firstResult.budget.limits,
    finalizationReserveMs: firstResult.budget.finalizationReserveMs,
    phases: {}, monotonicMs: () => second.currentTime(), monotonicClockId: 'test-monotonic',
    wallNowMs: () => wallNowMs,
    snapshot: firstResult.budget,
  })
  second.runtimeOptions.resumeState = {
    decision: decision('DIRECT'),
    schedulerState: { ...firstResult.schedulerState, routeSource: 'explicit_control' },
    deadline: firstResult.budget.deadline,
  }
  second.runtimeOptions.executeRoute = async () => assert.fail('tampered route source must not resume production')
  const result = await new CodexSupervisorRuntime(second.runtimeOptions).start()
  assert.equal(result.outcome, 'FAILED')
  assert.equal(result.terminalEnvelope.status, 'RESUME_STATE_INVALID')
  assert.deepEqual(second.launches, [])
})

test('resume rejects missing or invalid persisted deadline before any production launch', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const declared = run030Deadline(new Date(wallNowMs + 1_200_000).toISOString())
  for (const item of [
    { id: 'missing', deadline: undefined },
    { id: 'invalid', deadline: { ...declared, verificationReservePercent: 24 } },
  ]) {
    const first = makeHarness(t, {
      activationId: `deadline-source-${item.id}`, runId: `deadline-source-${item.id}-run`, wallMs: 3_600_000,
      runtimeOptions: {
        now: () => wallNowMs,
        settings: run030AutomaticSettings(declared),
        l0ViaScheduler: false,
        decideRoute: async () => ({
          decision: decision('DIRECT'), submittedAtMs: wallNowMs, usage: ZERO_USAGE,
        }),
        executeRoute: async () => ({ outcome: 'PARTIAL' }),
      },
    })
    const firstResult = await new CodexSupervisorRuntime(first.runtimeOptions).start()
    assert.deepEqual(firstResult.budget.deadline, declared)
    const second = makeHarness(t, {
      missionLock: first.missionLock,
      activationId: `deadline-source-${item.id}`,
      runId: `deadline-source-${item.id}-run`,
      runtimeOptions: { now: () => wallNowMs, settings: run030AutomaticSettings(declared) },
    })
    second.runtimeOptions.generation = 2
    second.runtimeOptions.previousBudgetSnapshot = firstResult.budget
    second.runtimeOptions.budgetController = new BudgetController({
      limits: firstResult.budget.limits,
      finalizationReserveMs: firstResult.budget.finalizationReserveMs,
      phases: {}, monotonicMs: () => second.currentTime(), monotonicClockId: 'test-monotonic',
      wallNowMs: () => wallNowMs,
      snapshot: firstResult.budget,
    })
    second.runtimeOptions.resumeState = {
      decision: decision('DIRECT'), schedulerState: firstResult.schedulerState,
      ...(item.deadline === undefined ? {} : { deadline: item.deadline }),
    }
    second.runtimeOptions.executeRoute = async () => assert.fail('invalid resume deadline must not start production')
    const result = await new CodexSupervisorRuntime(second.runtimeOptions).start()
    assert.equal(result.outcome, 'PARTIAL')
    assert.equal(result.terminalEnvelope.status, 'RESUME_DEADLINE_INVALID')
    assert.deepEqual(second.launches, [])
  }
})

test('resume after the saved analyst runs root L0 once and never launches a second analyst or decision child', async t => {
  const pending = new CentralScheduler({ route: 'PENDING', runIdentity: { runId: 'analyst-crash-run', generation: 1 } })
  const analystAuthority = pending.issueLaunchAuthority({
    callerRole: 'autoprompt.v2.deterministic-control-plane', sessionId: 'old-control-session',
    runId: 'analyst-crash-run', generation: 1, parentLease: null,
    providerCapabilities: PROVIDER_CAPABILITIES,
  })
  const analystLease = await pending.acquireWithAuthority(analystAuthority, {
    workItemId: 'route-analyst', equivalenceKey: 'route-analyst', lane: 'routeAnalyst',
    role: 'ap-route-analyst', logicalRole: 'route-analyst', purpose: 'planning',
  })
  analystLease.complete(ZERO_USAGE)

  const harness = makeHarness(t, { activationId: 'analyst-crash', runId: 'analyst-crash-run' })
  const priorBudget = harness.budget.snapshot()
  harness.runtimeOptions.generation = 2
  harness.runtimeOptions.previousBudgetSnapshot = priorBudget
  harness.runtimeOptions.budgetController = new BudgetController({
    limits: priorBudget.limits, finalizationReserveMs: priorBudget.finalizationReserveMs,
    phases: {}, monotonicMs: () => harness.currentTime(), snapshot: priorBudget,
  })
  harness.runtimeOptions.resumeState = {
    canonicalCrashAdopted: true,
    stage: 'AFTER_ANALYST',
    resumeState: 'L0_ROUTE_DECISION',
    recommendation: recommendation('DIRECT'),
    schedulerState: pending.exportState(),
  }
  let l0Calls = 0
  harness.runtimeOptions.decideRoute = async () => {
    l0Calls++
    return { decision: decision('DIRECT'), submittedAtMs: harness.currentTime(), usage: ZERO_USAGE }
  }
  const usableBuild = path.join(harness.directory, 'l0-once-resume-result.txt')
  fs.writeFileSync(usableBuild, 'verified resumed L0 route\n')
  const buildAcceptanceHash = crypto.createHash('sha256').update(fs.readFileSync(usableBuild)).digest('hex')
  harness.runtimeOptions.executeRoute = async () => ({
    outcome: 'DONE',
    deliverables: [usableBuild],
    checkHashes: [buildAcceptanceHash],
  })

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(l0Calls, 1)
  assert.deepEqual(harness.launches.map(launch => launch.logicalRole), [])
  assert.equal(result.scheduler.counters.totalLaunches, 1)
  assert.equal(result.scheduler.rootAccounting.status, 'completed')
})

test('resume preserves a recorded bootstrap breach without preventing essential completion', async t => {
  const first = makeHarness(t, { activationId: 'resume-admission', runId: 'resume-admission-run' })
  first.runtimeOptions.executeRoute = async () => ({ outcome: 'PARTIAL' })
  const firstResult = await new CodexSupervisorRuntime(first.runtimeOptions).start()
  assert.equal(firstResult.outcome, 'PARTIAL')

  const second = makeHarness(t, {
    missionLock: first.missionLock,
    activationId: 'resume-admission',
    runId: 'resume-admission-run',
  })
  const originalRecordFactory = second.runtimeOptions.recordFactory
  second.runtimeOptions.recordFactory = async input => {
    second.advance(61001)
    return originalRecordFactory(input)
  }
  second.runtimeOptions.activationId = 'resume-admission'
  second.runtimeOptions.generation = 2
  second.runtimeOptions.budgetController = new BudgetController({
    limits: { wallMs: 600000, tokens: 1000000, sessions: 20, launches: 20 },
    finalizationReserveMs: 10,
    phases: {},
    monotonicMs: () => second.currentTime(),
    monotonicClockId: 'test-monotonic',
    wallNowMs: () => second.currentTime(),
    snapshot: firstResult.budget,
  })
  second.runtimeOptions.previousBudgetSnapshot = firstResult.budget
  second.runtimeOptions.resumeState = {
    decision: decision('DIRECT'), schedulerState: firstResult.schedulerState,
    deadline: firstResult.budget.deadline,
  }
  second.runtimeOptions.executeRoute = async () => usableDoneFixture(second, 'resume-bootstrap-result')

  const result = await new CodexSupervisorRuntime(second.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.scheduler.admission.breaches.includes('bootstrap'), true)
  assert.equal(result.scheduler.admission.completionCanContinue, true)
})

test('work/check selection is deterministic and legacy fleets map only through canonical aliases', () => {
  const recipe = selectWorkRecipe({ workType: 'debug/fix', risks: ['concurrency/shared-state'] })
  assert.equal(recipe.status, 'SUPPORTED')
  assert.equal(recipe.workType, 'debug/fix')
  assert.deepEqual(recipe.selection, {
    baseWorkType: 'debug-fix', resultFormat: 'changed-files',
    artifactOverlays: ['executable-code'], acceptanceOverlays: ['failing-to-passing-behavior'],
    riskOverlays: ['concurrency-or-shared-state'],
    riskEvidence: { 'concurrency-or-shared-state': 'declared by route decision' },
  })
  assert.deepEqual(recipe.checks, ['failing-to-passing-behavior', 'build-or-run', 'behavior', 'regression'])
  assert.deepEqual(recipe.riskChecks, ['named-risk-check'])
  assert.equal(recipe.runtimeFrameworkGeneration, false)
  assert.equal(selectWorkRecipe({ workType: 'unknown quantum artifact' }).status, 'UNSUPPORTED_SHAPE')
  const policy = new RolePolicy()
  assert.throws(
    () => policy.validate({ route: 'DIRECT', parent: 'run-owner', child: 'ap-framework-generator' }),
    error => error.code === 'ROLE_POLICY_DENIED',
  )
  assert.deepEqual(policy.bindRootRunOwner(), {
    logicalRole: 'run-owner', physicalRole: 'autoprompt.v2.run-owner', providerRole: 'ap-run-owner',
    sandboxMode: 'read-only', policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
    canDispatch: true,
    resourceSets: { read: ['request-envelope', 'route-evidence'], write: [], exclusive: [] },
  })
  for (const [legacyId, logicalRole] of [
    ['ap-reviewer', 'independent-reviewer'], ['ap-verifier', 'independent-tester'],
  ]) {
    const compatibility = policy.validate({ route: 'DIRECT', parent: 'run-owner', child: legacyId })
    assert.equal(compatibility.child, logicalRole)
    assert.equal(compatibility.alias.legacyId, legacyId)
    const physical = policy.bindPhysicalChild({
      logicalRole, physicalRole: compatibility.definition.physicalId,
      providerRole: 'ap-independent-checker',
    })
    assert.equal(physical.providerRole, 'ap-independent-checker')
    assert.equal(physical.canDispatch, false)
  }
  assert.throws(
    () => policy.bindPhysicalChild({
      logicalRole: 'worker',
      physicalRole: 'autoprompt.v2.worker',
      providerRole: 'ap-implementer',
    }),
    error => error.code === 'ROLE_POLICY_DENIED',
  )
  assert.throws(
    () => policy.validate({ route: 'LIGHT', parent: 'run-owner', child: 'ap-mission-coordinator' }),
    error => error.code === 'ROLE_POLICY_DENIED',
  )
})

function frameworkAuthorityBinding(overrides = {}) {
  return {
    runId: 'framework-run-1', activationId: 'framework-activation-1', generation: 3,
    route: 'DIRECT', assignmentId: 'framework-assignment-1',
    findingIds: ['AP-LAYER-004'], requirementHash: 'f'.repeat(64),
    ...overrides,
  }
}

function generatedFrameworkCandidate(route = 'DIRECT') {
  return {
    schemaVersion: 1,
    frameworkId: 'generated-framework-1',
    route,
    checks: ['focused-behavior'],
    riskChecks: [],
    gateGraph: {
      graphId: 'generated-direct-v1', route,
      nodes: ['produce-candidate', 'independent-check'],
      edges: [['produce-candidate', 'independent-check']],
    },
  }
}

test('C0 framework orchestration rejects direct spawn, validator bypass, empty findings, and stale bindings', async () => {
  const policy = new RolePolicy()
  for (const child of [
    'framework-generator', 'ap-framework-generator',
    'framework-validator', 'ap-framework-validator',
  ]) {
    assert.throws(
      () => policy.validate({ route: 'DIRECT', parent: 'run-owner', child }),
      error => error.code === 'ROLE_POLICY_DENIED',
      child,
    )
  }

  assert.throws(
    () => new FrameworkOrchestrationAuthority({
      binding: frameworkAuthorityBinding(), readState: () => null, writeState: () => {},
      generate: async () => ({}),
    }),
    error => error.code === 'FRAMEWORK_VALIDATOR_REQUIRED',
  )
  assert.throws(
    () => new FrameworkOrchestrationAuthority({
      binding: frameworkAuthorityBinding({ findingIds: [] }),
      readState: () => null, writeState: () => {}, generate: async () => ({}), validate: async () => ({}),
    }),
    error => error.code === 'FRAMEWORK_BINDING_INVALID',
  )

  const stale = new FrameworkOrchestrationAuthority({
    binding: frameworkAuthorityBinding(), readState: () => null, writeState: () => {},
    generate: async handoff => ({
      generatorIdentity: 'C0/framework-generator', generation: handoff.receipt.generation - 1,
      assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
      candidate: generatedFrameworkCandidate(),
    }),
    validate: async () => assert.fail('stale generator output must never reach the validator'),
  })
  await assert.rejects(
    () => stale.run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_HANDOFF_STALE',
  )
  await assert.rejects(
    () => stale.run({ caller: 'run-owner' }),
    error => error.code === 'FRAMEWORK_COORDINATOR_REQUIRED',
  )
})

test('C0 framework candidate survives validator restart without regeneration', async () => {
  let durable = null
  const snapshots = []
  let crashValidation = true
  const generatorCalls = []
  const validatorCalls = []
  const binding = frameworkAuthorityBinding()
  const storage = {
    readState: () => durable && structuredClone(durable),
    writeState: state => { durable = structuredClone(state); snapshots.push(structuredClone(state)) },
  }
  const generate = async handoff => {
    generatorCalls.push(structuredClone(handoff))
    return {
      generatorIdentity: 'C0/framework-generator', generation: handoff.receipt.generation,
      assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
      candidate: generatedFrameworkCandidate(),
    }
  }
  const validate = async handoff => {
    validatorCalls.push(structuredClone(handoff))
    if (crashValidation) {
      crashValidation = false
      throw Object.assign(new Error('simulated coordinator crash during validation'), {
        code: 'SIMULATED_CRASH',
      })
    }
    return {
      validatorIdentity: 'C0/independent-framework-validator', generation: handoff.receipt.generation,
      assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
      candidateHash: handoff.candidateHash,
      status: 'PASS', findings: [],
    }
  }

  const firstProcess = new FrameworkOrchestrationAuthority({ binding, ...storage, generate, validate })
  await assert.rejects(
    () => firstProcess.run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'SIMULATED_CRASH',
  )
  assert.equal(durable.status, 'CANDIDATE_READY')
  const persistedCandidateHash = durable.candidateHash

  const resumedProcess = new FrameworkOrchestrationAuthority({ binding, ...storage, generate, validate })
  const admitted = await resumedProcess.run({ caller: 'deterministic-control-plane' })
  assert.equal(admitted.status, 'ADMITTED')
  assert.equal(admitted.generatorIdentity, 'C0/framework-generator')
  assert.equal(admitted.validatorReceipt.status, 'PASS')
  assert.equal(admitted.candidateHash, persistedCandidateHash)
  assert.deepEqual(generatorCalls.map(call => call.attempt), [1])
  assert.deepEqual(validatorCalls.map(call => call.attempt), [1, 1])
  assert.ok(snapshots.some(state => state.status === 'CANDIDATE_READY'))
  assert.equal(snapshots.at(-1).status, 'ADMITTED')
})

test('C0 framework validation FAIL blocks once with exact findings and remains tamper evident', async () => {
  let durable = null
  let generatorCalls = 0
  let validatorCalls = 0
  const binding = frameworkAuthorityBinding()
  const storage = {
    readState: () => durable && structuredClone(durable),
    writeState: state => { durable = structuredClone(state) },
  }
  const authority = new FrameworkOrchestrationAuthority({
    binding, ...storage,
    generate: async handoff => {
      generatorCalls += 1
      return {
        generatorIdentity: 'C0/framework-generator', generation: handoff.receipt.generation,
        assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
        candidate: generatedFrameworkCandidate(),
      }
    },
    validate: async handoff => {
      validatorCalls += 1
      return {
        validatorIdentity: 'C0/independent-framework-validator', generation: handoff.receipt.generation,
        assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
        candidateHash: handoff.candidateHash, status: 'FAIL',
        findings: [{ id: 'FRAMEWORK-FINDING-001', message: 'Exact structural defect.' }],
      }
    },
  })
  await assert.rejects(
    () => authority.run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_VALIDATION_FAILED' &&
      error.details.candidateHash === durable.candidateHash &&
      error.details.findings[0].message === 'Exact structural defect.',
  )
  assert.equal(durable.status, 'BLOCKED')
  assert.equal(durable.attempt, 1)
  assert.deepEqual({ generatorCalls, validatorCalls }, { generatorCalls: 1, validatorCalls: 1 })

  const resumedBlocked = new FrameworkOrchestrationAuthority({
    binding, ...storage,
    generate: async () => assert.fail('a persisted BLOCKED state cannot generate again'),
    validate: async () => assert.fail('a persisted BLOCKED state cannot validate again'),
  })
  await assert.rejects(
    () => resumedBlocked.run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_VALIDATION_FAILED' &&
      error.details.validatorReceipt.status === 'FAIL',
  )

  durable.validatorReceipt.findings[0].message = 'tampered after sealing'
  await assert.rejects(
    () => new FrameworkOrchestrationAuthority({ binding, ...storage,
      generate: async () => assert.fail('tampered state must fail before generation'),
      validate: async () => assert.fail('tampered state must fail before validation'),
    })
      .run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_STATE_INVALID',
  )
})

test('C0 framework admission is durable before any production worker can launch', async () => {
  const unsupportedDecision = {
    ...decision('DIRECT'),
    gateSelection: {
      baseWorkType: 'not-declared', resultFormat: 'new-build',
      artifactOverlays: ['executable-code'], acceptanceOverlays: ['failing-to-passing-behavior'],
      riskOverlays: [], riskEvidence: {},
    },
  }
  let launchCount = 0
  const rejectedExecutor = createDefaultRouteExecutor({
    frameworkAuthorityFactory: () => ({
      run: async () => ({ status: 'CANDIDATE_READY' }),
    }),
  })
  await assert.rejects(
    () => rejectedExecutor({
      route: 'DIRECT', decision: unsupportedDecision,
      launch: async () => { launchCount += 1 }, completeRetainedLease: () => {},
    }),
    error => error.code === 'FRAMEWORK_ADMISSION_INVALID',
  )
  assert.equal(launchCount, 0)

  let durable = null
  const statusOrder = []
  const binding = frameworkAuthorityBinding({ generation: 7 })
  const executor = createDefaultRouteExecutor({
    frameworkAuthorityFactory({ route, requirementHash }) {
      assert.equal(route, 'DIRECT')
      return new FrameworkOrchestrationAuthority({
        binding: { ...binding, route, requirementHash },
        readState: () => durable && structuredClone(durable),
        writeState(state) { durable = structuredClone(state); statusOrder.push(state.status) },
        generate: async handoff => ({
          generatorIdentity: 'C0/framework-generator', generation: handoff.receipt.generation,
          assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
          candidate: generatedFrameworkCandidate(route),
        }),
        validate: async handoff => ({
          validatorIdentity: 'C0/independent-framework-validator', generation: handoff.receipt.generation,
          assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
          candidateHash: handoff.candidateHash, status: 'PASS', findings: [],
        }),
      })
    },
  })
  await assert.rejects(
    () => executor({
      route: 'DIRECT', decision: unsupportedDecision, completeRetainedLease: () => {},
      launch: async request => {
        assert.equal(request.logicalRole, 'worker')
        assert.equal(durable.status, 'ADMITTED')
        assert.notEqual(durable.generatorIdentity, durable.validatorReceipt.validatorIdentity)
        statusOrder.push('PRODUCTION_WORKER')
        throw Object.assign(new Error('stop after proving launch order'), { code: 'LAUNCH_ORDER_PROVEN' })
      },
    }),
    error => error.code === 'LAUNCH_ORDER_PROVEN',
  )
  assert.deepEqual(statusOrder, ['CANDIDATE_READY', 'ADMITTED', 'PRODUCTION_WORKER'])
})

test('evidence binding invalidates both independent verdicts only for exact transitive inputs', () => {
  const base = canonicalEvidenceBinding({
    missionHash: '1'.repeat(64), planHash: '2'.repeat(64), candidateHash: '3'.repeat(64),
    environmentHash: '4'.repeat(64), oracleHash: '5'.repeat(64),
    assumptionsHash: '6'.repeat(64), dependencyHash: '7'.repeat(64),
  })
  assert.deepEqual(evidenceInvalidationSet(base, { ...base }), { changed: [], invalidates: [] })
  for (const field of [
    'missionHash', 'planHash', 'candidateHash', 'environmentHash',
    'oracleHash', 'assumptionsHash', 'dependencyHash',
  ]) {
    const changed = { ...base, [field]: '8'.repeat(64) }
    assert.deepEqual(evidenceInvalidationSet(base, changed), {
      changed: [field], invalidates: ['reviewer-verdict', 'tester-verdict'],
    })
  }
  assert.deepEqual(evidenceInvalidationSet(base, { ...base, unrelated: 'ignored' }), {
    changed: [], invalidates: [],
  })
})

test('post-promotion controller persistence failure preserves the physically committed candidate', async t => {
  const target = tempDirectory(t, 'autoprompt-post-promotion-')
  const changed = path.join(target, 'result.txt')
  let promotionCalls = 0
  let abortCalls = 0
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.options = {
    targetPath: target,
    mutationEnforcer: {
      async commit() {},
      async abort() { abortCalls += 1 },
    },
  }
  runtime.deferredPromotions = new Map()
  runtime._persistDeferredPromotionState = state => {
    if (state.status === 'PROMOTED') {
      throw Object.assign(new Error('injected post-promotion record write failure'), {
        code: 'RUN_RECORD_FAILURE',
      })
    }
    return structuredClone(state)
  }
  const token = 'promotion-token'
  const candidateHash = '1'.repeat(64)
  const pending = {
    token,
    state: { token, status: 'PREPARED' },
    candidateHash,
    workspacePath: path.join(target, 'private-candidate'),
    workerWorkspace: {
      binding: { bindingHash: '2'.repeat(64) },
      recordPath: path.join(target, 'workspace-record.json'),
      manager: {
        promote() {
          promotionCalls += 1
          fs.writeFileSync(changed, 'durable candidate\n')
          return [{ path: 'result.txt', hash: crypto.createHash('sha256').update('durable candidate\n').digest('hex') }]
        },
        abort() { abortCalls += 1 },
      },
    },
    mutationAdmission: {}, mutationPermit: {}, canonicalAssignment: {},
    postimages: [], workItemId: 'work-1', alreadyPromoted: false,
  }
  runtime.deferredPromotions.set(token, pending)
  const handle = runtime._deferredPromotionHandle(token, pending)
  await assert.rejects(() => handle.commit({
    candidateHash,
    acceptanceJoinHash: '3'.repeat(64),
    domainEvaluationHash: '4'.repeat(64),
    checkHashes: ['5'.repeat(64)],
  }), error => error.code === 'RUN_RECORD_FAILURE')
  assert.equal(fs.readFileSync(changed, 'utf8'), 'durable candidate\n')
  assert.equal(promotionCalls, 1, 'controller recovery never relaunches the model')
  assert.equal(pending.alreadyPromoted, true)
  await assert.rejects(() => handle.abort('outer controller failure'),
    error => error.code === 'DONE_RETRY_ALREADY_PROMOTED')
  assert.equal(abortCalls, 0)
  assert.equal(fs.readFileSync(changed, 'utf8'), 'durable candidate\n')
})

test('ordinary worker keeps its exact promoted candidate when mutation-state persistence stays unavailable', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-ordinary-post-promotion-'))
  const targetFile = path.join(target, 'src', 'example.js')
  const originalBytes = fs.readFileSync(targetFile)
  const harden = repository => spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', repository, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  const hardenedTarget = harden(target)
  assert.equal([0, 3].includes(hardenedTarget.status), true,
    hardenedTarget.stderr || hardenedTarget.stdout)

  const privateWorkspace = path.join(tempDirectory(t, 'autoprompt-ordinary-private-'), 'candidate')
  const cloned = spawnSync('git', ['clone', '--quiet', '--no-local', '--no-hardlinks', '--', target, privateWorkspace], {
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(cloned.status, 0, cloned.stderr)
  const hardenedPrivate = harden(privateWorkspace)
  assert.equal([0, 3].includes(hardenedPrivate.status), true,
    hardenedPrivate.stderr || hardenedPrivate.stdout)
  const privateFile = path.join(privateWorkspace, 'src', 'example.js')
  const cacheRoot = tempDirectory(t, 'autoprompt-ordinary-cache-')
  const promotedBytes = Buffer.from("module.exports = 'preserved-after-promotion'\n")
  const promotedHash = crypto.createHash('sha256').update(promotedBytes).digest('hex')
  let promoted = false
  let workspaceAbortCalls = 0
  let mutationAbortCalls = 0
  let commitAttempts = 0

  const harness = makeHarness(t, {
    activationId: 'activation-ordinary-post-promotion',
    runId: 'run-ordinary-post-promotion',
    runtimeOptions: {
      targetPath: target,
      expectedBranch: 'main',
      gitEnvironment: () => process.env,
      settings: run030ExactSettings(),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
    },
  })
  harness.record.resolve = relative => path.join(harness.directory, ...relative.split('/'))
  harness.record.write = (relative, bytes) => {
    harness.record.writes.set(relative, String(bytes))
    const destination = harness.record.resolve(relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, bytes)
  }
  let preMutationBaseline = null
  harness.record.writePreMutationBaseline = input => {
    preMutationBaseline = createPreMutationBaseline(input)
    const destination = harness.record.resolve('checks/pre-mutation-baseline.json')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, `${JSON.stringify(preMutationBaseline, null, 2)}\n`)
    return preMutationBaseline
  }
  harness.record.readPreMutationBaseline = () => preMutationBaseline
  harness.runtimeOptions.capturePreMutationBaseline = ({ request }) => ({
    capturedBeforeMutation: true,
    targetStateHash: crypto.createHash('sha256').update(originalBytes).digest('hex'),
    environmentHash: crypto.createHash('sha256').update('ordinary-post-promotion-environment').digest('hex'),
    dirtyTarget: { status: 'CLEAN', paths: [], snapshotHash: null },
    existingTests: [],
    fallback: {
      reason: 'NO_RELEVANT_EXISTING_TESTS',
      evidenceHash: crypto.createHash('sha256').update(JSON.stringify(request.checks)).digest('hex'),
      observableChecks: request.checks.map(String),
    },
    nowMs: 0,
  })
  harness.runtimeOptions.workerWorkspaceFactory = ({ assignment }) => ({
    workspaceId: 'ordinary-post-promotion-workspace',
    workspacePath: privateWorkspace,
    cacheRoot,
    binding: { bindingHash: 'd'.repeat(64) },
    assignment,
    manager: {
      inspect() {
        assert.deepEqual(fs.readFileSync(privateFile), promotedBytes)
        return {
          actualFilesChanged: ['src/example.js'],
          reportedNoopFiles: [],
          after: [{ path: 'src/example.js', hash: promotedHash, mode: 0o100644 }],
          transientArtifactsRemoved: [],
          postimages: [{ path: targetFile, hash: promotedHash }],
        }
      },
      promote() {
        fs.writeFileSync(targetFile, promotedBytes)
        promoted = true
        return [{ type: 'file', path: targetFile, hash: promotedHash }]
      },
      finalize() { assert.fail('unreconciled mutation state cannot finalize the private workspace') },
      abort() {
        workspaceAbortCalls += 1
        fs.writeFileSync(targetFile, originalBytes)
        promoted = false
      },
    },
  })
  harness.runtimeOptions.mutationEnforcer = {
    begin(input) {
      return { id: 'ordinary-post-promotion-permit', isolationBindingHash: input.isolation.bindingHash }
    },
    commit() {
      commitAttempts += 1
      throw Object.assign(new Error('persistent local mutation-state outage'), { code: 'EIO' })
    },
    abort() { mutationAbortCalls += 1 },
  }
  harness.runtimeOptions.launcher = async launch => {
    assert.equal(launch.logicalRole, 'worker')
    fs.writeFileSync(privateFile, promotedBytes)
    return {
      ...roadmapCompositionRoleResult(launch, ['Produce the exact promoted candidate.']),
      runId: 'run-ordinary-post-promotion',
      filesChanged: ['src/example.js'],
      contextId: `context:${launch.workItemId}`,
    }
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    await launch({
      workItemId: 'ordinary-promoted-work', logicalRole: 'worker', parent: 'run-owner',
      purpose: 'work', assignment: 'Change the one owned target file.',
      ownership: ['src/example.js'],
      manifests: [{
        kind: 'file', identity: 'src/example.js', owner: 'ordinary-promoted-work',
        ownershipMode: 'single-owner',
      }],
      success: ['The owned file contains the requested implementation.'],
      checks: ['ordinary promoted candidate check'],
    })
    assert.fail('persistent mutation-state persistence cannot authorize continued execution')
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'PARTIAL', JSON.stringify(result))
  assert.equal(result.resumable, true)
  assert.equal(result.terminalEnvelope.status, 'LOCAL_PERSISTENCE_PENDING')
  assert.equal(result.terminalEnvelope.error.code, 'CALLBACK_RECONCILIATION_PENDING')
  assert.equal(result.terminalEnvelope.error.details.callback.kind, 'mutation-state-commit')
  assert.equal(commitAttempts, 2)
  assert.equal(promoted, true)
  assert.equal(workspaceAbortCalls, 0)
  assert.equal(mutationAbortCalls, 0)
  assert.deepEqual(fs.readFileSync(targetFile), promotedBytes)
  const candidate = result.terminalEnvelope.bestAvailableCandidateEvidence
  assert.equal(candidate.kind, 'post-promotion-reconciliation-candidate')
  assert.equal(candidate.candidatePath, path.resolve(target))
  assert.equal(candidate.candidateHash, testWorkspaceCandidateHash(target))
  assert.match(candidate.bindingHash, /^[a-f0-9]{64}$/u)
})

function configureBookkeepingCandidateSurvivalHarness(t, options = {}) {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-candidate-survival-target-'))
  const targetFile = path.join(target, 'src', 'example.js')
  const originalBytes = fs.readFileSync(targetFile)
  const hardened = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal([0, 3].includes(hardened.status), true, hardened.stderr || hardened.stdout)
  const harness = makeHarness(t, {
    activationId: `activation-candidate-survival-${options.seam}`,
    runId: `run-candidate-survival-${options.seam}`,
    runtimeOptions: {
      targetPath: target,
      expectedBranch: 'main',
      gitEnvironment: () => process.env,
      settings: run030ExactSettings(),
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
    },
  })
  const recordRoot = path.join(harness.directory, 'candidate-survival-record')
  fs.mkdirSync(recordRoot, { recursive: true, mode: 0o700 })
  harness.record.resolve = relative => path.join(recordRoot, ...String(relative).split('/'))
  harness.record.write = (relative, bytes) => {
    if (options.seam === 'pre-promotion' && relative.startsWith('work/results/mutation-admission-')) {
      throw Object.assign(new Error('injected immutable run-record admission failure'), {
        code: options.prePromotionFailureCode || 'RUN_RECORD_WRITE_UNAVAILABLE',
      })
    }
    harness.record.writes.set(relative, String(bytes))
    const destination = harness.record.resolve(relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.writeFileSync(destination, bytes)
  }
  let preMutationBaseline = null
  harness.record.writePreMutationBaseline = input => {
    preMutationBaseline = createPreMutationBaseline(input)
    harness.record.write('checks/pre-mutation-baseline.json', `${JSON.stringify(preMutationBaseline, null, 2)}\n`)
    return preMutationBaseline
  }
  harness.record.readPreMutationBaseline = () => preMutationBaseline
  harness.runtimeOptions.capturePreMutationBaseline = ({ request }) => ({
    capturedBeforeMutation: true,
    targetStateHash: crypto.createHash('sha256').update(originalBytes).digest('hex'),
    environmentHash: crypto.createHash('sha256').update(`candidate-survival-${options.seam}`).digest('hex'),
    dirtyTarget: { status: 'CLEAN', paths: [], snapshotHash: null },
    existingTests: [],
    fallback: {
      reason: 'NO_RELEVANT_EXISTING_TESTS',
      evidenceHash: crypto.createHash('sha256').update(JSON.stringify(request.checks)).digest('hex'),
      observableChecks: request.checks.map(String),
    },
    nowMs: 0,
  })
  const privateRoot = tempDirectory(t, 'autoprompt-candidate-survival-private-')
  const workspaceManager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot,
    environment: process.env,
    runId: harness.runtimeOptions.runId,
    activationId: harness.runtimeOptions.activationId,
    hardenWorkspace(workspacePath) {
      const repair = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
        '--repo', workspacePath, '--expected-branch', 'main', '--repair', '--json',
      ], { encoding: 'utf8', windowsHide: true })
      return { accepted: [0, 3].includes(repair.status) }
    },
  })
  let promoted = false
  const promote = workspaceManager.promote.bind(workspaceManager)
  workspaceManager.promote = (...args) => {
    const postimages = promote(...args)
    promoted = true
    return postimages
  }
  harness.runtimeOptions.workerWorkspaceFactory = ({ assignment, workItemId }) =>
    workspaceManager.prepare({ assignment, workItemId })
  let mutationAbortCalls = 0
  let activeMutationPermit = null
  harness.runtimeOptions.mutationEnforcer = {
    begin({ isolation }) {
      activeMutationPermit = {
        id: 'candidate-survival-permit', isolationBindingHash: isolation.bindingHash,
      }
      return activeMutationPermit
    },
    commit() {
      if (options.seam !== 'post-promotion') return
      throw Object.assign(new Error('injected callback persistence failure'), { code: 'EIO' })
    },
    abort() {
      mutationAbortCalls += 1
      activeMutationPermit = null
    },
  }
  if (options.seam === 'post-promotion') {
    harness.runtimeOptions.runtimeStateProvider = () => ({
      activeMutation: options.foreignPermit && promoted
        ? { id: 'foreign-permit', isolationBindingHash: 'f'.repeat(64) }
        : activeMutationPermit,
    })
  }
  const candidateBytes = Buffer.from(`module.exports = 'survived-${options.seam}'\n`)
  harness.runtimeOptions.launcher = async launch => {
    harness.launches.push(launch)
    if (launch.logicalRole === 'worker') {
      fs.writeFileSync(path.join(launch.workingDirectory, 'src', 'example.js'), candidateBytes)
      return {
        ...roadmapCompositionRoleResult(launch, ['Produce one exact ownership-safe candidate.']),
        runId: harness.runtimeOptions.runId,
        filesChanged: ['src/example.js'],
        contextId: `context:${launch.workItemId}`,
      }
    }
    assert.equal(launch.logicalRole, 'independent-reviewer')
    return {
      schemaVersion: '2.0.0', code: 'PASS', runId: harness.runtimeOptions.runId,
      requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
      candidateHash: launch.candidateHash, currentVersionHash: launch.candidateHash,
      payload: {
        evidenceIds: [`evidence:${launch.workItemId}`],
        referenceMethod: checkerReferenceMethod('black-box-boundary', launch.workItemId),
        testOutcomes: checkerTestOutcomes({
          ...launch, checks: launch.canonicalAssignment.checks || [],
        }),
      },
      evidenceHashes: [], usage: ZERO_USAGE,
    }
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const worker = await launch({
      workItemId: 'candidate-survival-work', logicalRole: 'worker', parent: 'run-owner',
      purpose: 'work', assignment: 'Change the one owned implementation file.',
      ownership: ['src/example.js'],
      manifests: [{
        kind: 'file', identity: 'src/example.js', owner: 'candidate-survival-work',
        ownershipMode: 'single-owner',
      }],
      success: ['The exact implementation file contains the requested result.'],
      checks: ['candidate survival ownership check'],
    })
    assert.equal(worker.allAssignedItemsPass, true)
    assert.deepEqual(fs.readFileSync(targetFile), candidateBytes)
    const candidateHash = testWorkspaceCandidateHash(target)
    const checked = await launch({
      workItemId: 'candidate-survival-check', logicalRole: 'independent-reviewer',
      parent: 'run-owner', purpose: 'verification',
      assignment: 'Independently check the authenticated locally continued candidate.',
      checks: ['candidate survival ownership check'],
      success: ['The exact official target contains the candidate.'],
      candidateHash, oracle: 'candidate-survival-oracle',
      harnessAttestation: {
        repoHash: candidateHash,
        buildHash: crypto.createHash('sha256').update('candidate-survival-build').digest('hex'),
        oracleHash: crypto.createHash('sha256').update('candidate-survival-oracle').digest('hex'),
      },
    })
    assert.equal(checked.code, 'PASS')
    return {
      outcome: 'DONE', deliverables: [targetFile],
      checkHashes: [crypto.createHash('sha256').update(candidateBytes).digest('hex')],
    }
  }
  return {
    candidateBytes,
    harness,
    originalBytes,
    targetFile,
    workerLaunchCount: () => harness.launches.filter(launch => launch.logicalRole === 'worker').length,
    mutationAbortCalls: () => mutationAbortCalls,
  }
}

for (const integrityCode of ['RUN_RECORD_UNSAFE', 'RUN_RECORD_FAILURE', 'RUN_RECORD_BUSY',
  'RECOVERY_CHECKPOINT_LOG_INVALID', 'RECOVERY_CHECKPOINT_LOG_UNSAFE',
  'RECOVERY_CHECKPOINT_RECOVERY_REQUIRED']) {
  test(`${integrityCode} after an authenticated worker result cannot promote or launch a checker`, async t => {
    const fixture = configureBookkeepingCandidateSurvivalHarness(t, {
      seam: 'pre-promotion', prePromotionFailureCode: integrityCode,
    })
    const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
    assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
    assert.equal(result.terminalEnvelope.status, integrityCode)
    assert.deepEqual(fs.readFileSync(fixture.targetFile), fixture.originalBytes)
    assert.equal(fixture.workerLaunchCount(), 1)
    assert.equal(fixture.harness.launches.some(launch =>
      launch.logicalRole === 'independent-reviewer'), false)
  })
}

for (const seam of ['pre-promotion', 'post-promotion']) {
  test(`${seam} internal bookkeeping failure promotes the exact candidate and continues through checking`, async t => {
    const fixture = configureBookkeepingCandidateSurvivalHarness(t, { seam })
    const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
    assert.equal(result.outcome, 'DONE', JSON.stringify(result))
    assert.deepEqual(fs.readFileSync(fixture.targetFile), fixture.candidateBytes)
    assert.equal(fixture.workerLaunchCount(), 1, 'candidate preservation never launches another model')
    assert.equal(fixture.harness.launches.filter(launch =>
      launch.logicalRole === 'independent-reviewer').length, 1)
    assert.equal(fixture.mutationAbortCalls(), seam === 'post-promotion' ? 1 : 0,
      'only a persistently unavailable matching state commit closes through exact local abort')
    assert.equal(result.localPersistenceLimitations.some(item =>
      item.workItemId === 'candidate-survival-work' &&
      item.stage === 'authenticated-result-continuation'), true)
  })
}

test('a foreign post-promotion mutation permit still rolls back and fails closed', async t => {
  const fixture = configureBookkeepingCandidateSurvivalHarness(t, {
    seam: 'post-promotion', foreignPermit: true,
  })
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
  assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'CRASH_ADOPTION_CONFLICT')
  assert.deepEqual(fs.readFileSync(fixture.targetFile), fixture.originalBytes)
  assert.equal(fixture.workerLaunchCount(), 1)
  assert.equal(fixture.harness.launches.some(launch =>
    launch.logicalRole === 'independent-reviewer'), false)
})

test('terminal and resumable retry intents deep-snapshot nested caller data', async t => {
  const makeRuntime = () => {
    const runtime = Object.create(CodexSupervisorRuntime.prototype)
    Object.assign(runtime, {
      options: { targetPath: tempDirectory(t, 'autoprompt-intent-'), gitEnvironment: () => process.env },
      finished: false, finalizing: false, suspending: false, scheduler: null,
      terminalFinalizationIntent: null, resumableSuspensionIntent: null,
      finalizationPromise: null, suspensionPromise: null, route: 'DIRECT', lease: {},
      budget: { snapshot: () => ({ stable: true }) },
      missionLock: { release() {} },
      _enforceBudgetPhase: () => ({ accepted: true }),
    })
    let drains = 0
    runtime._drainOwnedProcessesWithOneRetry = async () => {
      if (++drains === 1) throw Object.assign(new Error('injected drain failure'), { code: 'DRAIN_FAILED' })
    }
    return runtime
  }

  const finishing = makeRuntime()
  let finalizedEnvelope
  finishing.finalizer = {
    async finalize(input) { finalizedEnvelope = input.terminalEnvelope; return { durable: true } },
  }
  const finishInput = {
    terminalEnvelope: { status: 'FAILED', details: { cause: 'original' } },
    deliverables: [{ path: 'result.txt', hash: '1'.repeat(64) }],
  }
  await assert.rejects(() => finishing._finish('FAILED', finishInput),
    error => error.code === 'DRAIN_FAILED')
  finishInput.terminalEnvelope.details.cause = 'mutated'
  finishInput.deliverables.push({ path: 'forged.txt', hash: '2'.repeat(64) })
  const finished = await finishing._finish('FAILED', { terminalEnvelope: { status: 'REPLACED' } })
  assert.equal(finished.outcome, 'FAILED')
  assert.equal(finalizedEnvelope.details.cause, 'original')
  assert.equal(finishing.terminalFinalizationIntent.result.deliverables.length, 1)

  const suspending = makeRuntime()
  const suspendInput = { terminalEnvelope: { status: 'PARTIAL', details: { cause: 'original' } } }
  await assert.rejects(() => suspending._suspendResumable('PARTIAL', suspendInput),
    error => error.code === 'DRAIN_FAILED')
  suspendInput.terminalEnvelope.details.cause = 'mutated'
  const suspended = await suspending._suspendResumable('PARTIAL', {
    terminalEnvelope: { status: 'REPLACED' },
  })
  assert.equal(suspended.terminalEnvelope.details.cause, 'original')
})

test('cancellation intent is durable before scheduler disposal and process drain', async () => {
  const order = []
  let state = 'RUN_WORK'
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(runtime, {
    options: {
      runtimeStateProvider: () => ({ state }),
      runtimeTransition: async ({ eventId, nextState }) => {
        order.push(eventId)
        state = nextState
        return { state: nextState }
      },
    },
    lease: {}, starting: false, finished: false, finalizing: false, suspending: false,
    settledResult: null, scheduler: { dispose() { order.push('DISPOSE') } },
    _enforceBudgetPhase: () => ({ accepted: true }),
    _drainOwnedProcessesWithOneRetry: async () => { order.push('DRAIN') },
    _bestEffortPostDrainCheckpoint: async () => null,
    _finish: async (outcome, result) => ({ outcome, ...result }),
  })
  const result = await runtime._cancelOnce('operator request')
  assert.equal(result.outcome, 'CANCELLED')
  assert.deepEqual(order.slice(0, 3), ['CANCEL_REQUESTED', 'DISPOSE', 'DRAIN'])
})

test('live worker admission binds ownership and releases mutation authority even when workspace abort fails', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-live-ownership-'))
  const hardened = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal([0, 3].includes(hardened.status), true, hardened.stderr || hardened.stdout)
  const outside = path.join(target, 'src', 'outside.js')
  fs.writeFileSync(outside, "module.exports = 'outside-before'\n")
  const harness = makeHarness(t)
  const mutations = { begun: [], committed: [], aborted: [] }
  let deferredPromotionState = null
  let durableDeferredPromotionState = null
  let physicalOverrideCode = null
  let outsideError = null
  harness.runtimeOptions.targetPath = target
  harness.runtimeOptions.expectedBranch = 'main'
  harness.runtimeOptions.gitEnvironment = () => process.env
  const baselinePath = path.join(harness.directory, 'checks', 'pre-mutation-baseline.json')
  let baselineCaptures = 0
  let preMutationBaseline = null
  harness.record.resolve = relative => path.join(harness.directory, ...relative.split('/'))
  harness.record.write = (relative, bytes) => {
    harness.record.writes.set(relative, String(bytes))
    const destination = harness.record.resolve(relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, bytes)
  }
  harness.record.writePreMutationBaseline = input => {
    assert.equal(preMutationBaseline, null, 'the pre-mutation baseline is immutable')
    preMutationBaseline = createPreMutationBaseline(input)
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(baselinePath, `${JSON.stringify(preMutationBaseline, null, 2)}\n`)
    return preMutationBaseline
  }
  harness.record.readPreMutationBaseline = () => {
    assert.ok(preMutationBaseline, 'the pre-mutation baseline was frozen before worker launch')
    return preMutationBaseline
  }
  harness.runtimeOptions.capturePreMutationBaseline = ({ request, targetPath: baselineTarget }) => {
    baselineCaptures += 1
    const status = spawnSync('git', [
      '-C', baselineTarget, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(status.status, 0, status.stderr || status.stdout)
    const dirtyPaths = [...new Set(status.stdout.split('\0').filter(Boolean)
      .map(entry => entry.slice(3).split(' -> ').at(-1)).filter(Boolean))].sort()
    const targetStateHash = crypto.createHash('sha256')
      .update(status.stdout)
      .update(fs.readFileSync(path.join(baselineTarget, 'src', 'example.js')))
      .digest('hex')
    const observableChecks = request.checks.map(String)
    return {
      capturedBeforeMutation: true,
      targetStateHash,
      environmentHash: crypto.createHash('sha256').update('live-worker-test-environment').digest('hex'),
      dirtyTarget: {
        status: dirtyPaths.length ? 'DIRTY' : 'CLEAN',
        paths: dirtyPaths,
        snapshotHash: dirtyPaths.length ? targetStateHash : null,
      },
      existingTests: [],
      fallback: {
        reason: 'NO_RELEVANT_EXISTING_TESTS',
        evidenceHash: crypto.createHash('sha256')
          .update(JSON.stringify({ observableChecks, targetStateHash }))
          .digest('hex'),
        observableChecks,
      },
      nowMs: 0,
    }
  }
  const workspaceManager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: tempDirectory(t, 'autoprompt-worker-private-'),
    environment: process.env,
    runId: 'run-1',
    activationId: 'activation-1',
    hardenWorkspace(workspacePath) {
      const repair = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
        '--repo', workspacePath, '--expected-branch', 'main', '--repair', '--json',
      ], { encoding: 'utf8', windowsHide: true })
      let parsed = null
      try { parsed = JSON.parse(repair.stdout) } catch {}
      return { accepted: [0, 3].includes(repair.status) && parsed && parsed.repositoryOk === true }
    },
  })
  workspaceManager.abort = () => {
    const error = new Error('simulated physical workspace cleanup failure')
    error.code = 'WORKSPACE_ABORT_SIMULATED'
    throw error
  }
  harness.runtimeOptions.workerWorkspaceFactory = ({ assignment, workItemId, transportQuarantine }) =>
    transportQuarantine
      ? workspaceManager.prepareFromQuarantine({
          assignment, workItemId, quarantine: transportQuarantine,
        })
      : workspaceManager.prepare({ assignment, workItemId })
  harness.runtimeOptions.writeDeferredPromotionState = state => {
    deferredPromotionState = JSON.parse(JSON.stringify(state))
  }
  harness.runtimeOptions.readDeferredPromotionState = () => deferredPromotionState
  harness.runtimeOptions.mutationEnforcer = {
    begin(input) {
      mutations.begun.push(input)
      return { id: `permit-${mutations.begun.length}`, isolationBindingHash: input.isolation.bindingHash }
    },
    commit(input) { mutations.committed.push(input) },
    abort(input) { mutations.aborted.push(input) },
  }
  harness.runtimeOptions.writeDeferredPromotionState = state => {
    durableDeferredPromotionState = structuredClone(state)
  }
  harness.runtimeOptions.launcher = async launch => {
    harness.launches.push(launch)
    if (launch.logicalRole === 'route-analyst') {
      return { recommendation: recommendation(), events: [], elapsedMs: 1, usage: ZERO_USAGE }
    }
    if (launch.logicalRole === 'diagnostic-probe') {
      return representativeProbeResult(launch)
    }
    assert.equal(launch.environment.PYTHONDONTWRITEBYTECODE, '1')
    assert.equal(launch.environment.PYTHONPYCACHEPREFIX, launch.environment.AUTOPROMPT_WORKER_CACHE_ROOT)
    assert.equal(launch.environment.TMPDIR, launch.environment.AUTOPROMPT_WORKER_CACHE_ROOT)
    assert.equal(launch.environment.TMP, launch.environment.AUTOPROMPT_WORKER_CACHE_ROOT)
    assert.equal(launch.environment.TEMP, launch.environment.AUTOPROMPT_WORKER_CACHE_ROOT)
    assert.equal(path.resolve(launch.environment.AUTOPROMPT_WORKER_CACHE_ROOT).startsWith(
      `${path.resolve(launch.workingDirectory)}${path.sep}`), false)
    const changed = launch.workItemId === 'owned-work' ? 'src/example.js' : 'src/outside.js'
    fs.writeFileSync(path.join(launch.workingDirectory, ...changed.split('/')), `module.exports = '${launch.workItemId}'\n`)
    assert.notEqual(path.resolve(launch.workingDirectory), path.resolve(target))
    assert.equal(
      fs.readFileSync(path.join(target, ...changed.split('/')), 'utf8'),
      changed === 'src/example.js' ? "module.exports = 'ready'\n" : "module.exports = 'outside-before'\n",
      'the real target remains unchanged while the worker is live in its private workspace',
    )
    const now = '2026-08-22T00:00:00.000Z'
    return {
      schemaVersion: '2.0.0', reportType: 'result', reportId: `result:${launch.workItemId}`,
      runId: 'run-1', assignmentId: launch.workItemId, logicalRoleId: 'worker',
      physicalRoleId: 'autoprompt.v2.worker', requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
      findingIds: launch.canonicalAssignment.findingIds, startedAt: now, endedAt: now, filesChanged: [changed], resourcesChanged: [],
      behaviorChanged: ['bounded mutation'], commands: [],
      firstProductSignal: { kind: 'PRODUCT_EDIT', elapsedMs: 0, evidenceHash: CANDIDATE_A },
      successItems: [{ id: 'success-1', status: 'pass', evidenceIds: ['observed-diff'] }],
      remainingConcerns: [], allAssignedItemsPass: true,
      requestedTransition: { event: 'WORK_ITEM_VERIFIED', reason: 'observed mutation matched ownership', invalidateEvidenceIds: [] },
      contextId: `context:${launch.workItemId}`, usage: ZERO_USAGE, evidenceHashes: [],
    }
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const deferred = await launch({
      workItemId: 'owned-work', logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
      assignment: 'Change one owned file.', ownership: ['src/example.js', 'local-cache-service'],
      manifests: [
        { kind: 'file', identity: 'src/example.js', owner: 'owned-work', ownershipMode: 'single-owner' },
        { kind: 'service', identity: 'local-cache-service', owner: 'owned-work', ownershipMode: 'exclusive-lease' },
      ],
      success: ['The owned file changes.'], checks: ['focused check'],
      deferPromotion: true,
    })
    assert.equal(durableDeferredPromotionState.status, 'PREPARED')
    assert.equal(fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8'), "module.exports = 'ready'\n")
    assert.equal(mutations.committed.length, 0)
    await assert.rejects(
      () => deferred.deferredPromotion.commit({ candidateHash: deferred.deferredPromotion.candidateHash }),
      error => error.code === 'DONE_RETRY_ACCEPTANCE_JOIN_REQUIRED',
    )
    await deferred.deferredPromotion.commit({
      candidateHash: deferred.deferredPromotion.candidateHash,
      acceptanceJoinHash: 'a'.repeat(64),
      domainEvaluationHash: 'b'.repeat(64),
      checkHashes: ['c'.repeat(64)],
    })
    try {
      await launch({
        workItemId: 'physical-override', logicalRole: 'worker', providerRole: 'ap-implementer',
        parent: 'run-owner', purpose: 'work', assignment: 'Bypass the physical role.',
        ownership: ['src/example.js'], success: ['never'], checks: ['never'],
      })
    } catch (error) { physicalOverrideCode = error.code }
    try {
      await launch({
        workItemId: 'outside-work', logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
        assignment: 'Attempt an out-of-scope write.', ownership: ['src/example.js'],
        success: ['The write is rejected.'], checks: ['focused check'],
      })
    } catch (error) { outsideError = error }
    return {
      outcome: 'DONE',
      deliverables: [path.join(target, 'src', 'example.js')],
      checkHashes: ['c'.repeat(64)],
    }
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify({ result, routeEvents: harness.record.events }))
  assert.equal(physicalOverrideCode, 'ROLE_POLICY_DENIED')
  assert.equal(outsideError && outsideError.code, 'OWNERSHIP_SCOPE_VIOLATION', JSON.stringify({
    code: outsideError && outsideError.code,
    message: outsideError && outsideError.message,
    details: outsideError && outsideError.details,
    mutations,
  }))
  assert.equal(outsideError.workspaceAbortError.code, 'WORKSPACE_ABORT_SIMULATED')
  const owned = harness.launches.find(launch => launch.workItemId === 'owned-work')
  const file = owned.canonicalAssignment.resources.find(resource => resource.identity === 'src/example.js')
  const service = owned.canonicalAssignment.resources.find(resource => resource.identity === 'local-cache-service')
  assert.equal(file.kind, 'file')
  assert.match(file.expectedPreimageHash, /^[a-f0-9]{64}$/)
  assert.equal(file.owner, 'owned-work')
  assert.equal(service.kind, 'service')
  assert.equal(service.expectedPreimageHash, null)
  assert.equal(service.ownershipMode, 'exclusive-lease')
  assert.equal(owned.schedulerResources.some(resource => resource.kind === 'workspace' && resource.mode === 'exclusive'), true)
  assert.equal(owned.schedulerResources.some(resource => resource.kind === 'service' && resource.id === 'local-cache-service'), true)
  assert.equal(owned.physicalExecutionPolicy.sandboxMode, 'workspace-write')
  assert.equal(mutations.begun.length, 2)
  assert.equal(baselineCaptures, 1)
  assert.equal(preMutationBaseline.capturedBeforeMutation, true)
  assert.equal(mutations.committed.length, 1)
  assert.equal(mutations.aborted.length, 1)
  assert.equal(fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8'), "module.exports = 'owned-work'\n")
  assert.equal(fs.readFileSync(outside, 'utf8'), "module.exports = 'outside-before'\n")
  assert.equal(mutations.committed[0].postimages[0].path, path.join(target, 'src', 'example.js'))
})

test('canonical mission paths fail before worker creation', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-mission-path-'))
  const hardened = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal([0, 3].includes(hardened.status), true, hardened.stderr || hardened.stdout)
  const harness = makeHarness(t, {
    runtimeOptions: {
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
      targetPath: target,
      expectedBranch: 'main',
      gitEnvironment: () => process.env,
      settings: {
        explicit: { concurrency: { mode: 'tokensaver' }, path: 'direct' },
        capabilities: { modelRouting: false, wideMaxSubs: 10 },
        providerId: 'codex',
      },
    },
  })
  let workerCreations = 0
  let pathError = null
  harness.runtimeOptions.launcher = async launch => {
    if (launch.logicalRole === 'diagnostic-probe') {
      return representativeProbeResult(launch)
    }
    if (launch.logicalRole === 'worker') workerCreations++
    return { contextId: 'unexpected-worker', usage: ZERO_USAGE, evidenceHashes: [] }
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    try {
      await launch({
        workItemId: 'missing-path', logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
        assignment: 'Close AP-TRACE-014 without relying on conversation memory.',
        findingIds: ['AP-TRACE-014', 'AP-DESIGN-023'],
        ownership: [{ kind: 'file', identity: 'src/does-not-exist.js', owner: 'missing-path' }],
        success: ['The path is validated before agent creation.'], checks: ['hostile missing-path check'],
      })
    } catch (error) { pathError = error }
    return {
      outcome: 'DONE',
      deliverables: [path.join(target, 'src', 'example.js')],
      checkHashes: [CANDIDATE_A],
    }
  }
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(pathError && pathError.code, 'MISSION_PATH_INVALID')
  assert.equal(workerCreations, 0)
  const missingAssignment = `work/assignments/${crypto.createHash('sha256').update('missing-path').digest('hex')}.json`
  assert.equal(harness.record.writes.has(missingAssignment), false)
})

test('production planning prose remains descriptive and never becomes filesystem ownership', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-production-planning-prose-'))
  const descriptiveArea = 'ERP planning, demand, engineering-release, routing, qualification, and WIP data exposed by the gateway'
  const routeDecision = decision('DIRECT', { likelyAreas: ['/app/data/dbgw.py', descriptiveArea] })
  const executor = createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({
      repoHash: CANDIDATE_A,
      buildHash: 'b'.repeat(64),
      oracleHash: 'c'.repeat(64),
    }),
  })
  let workerReached = false
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      assert.equal(JSON.stringify(request.ownership || []).includes(descriptiveArea), false)
      if (request.logicalRole === 'worker') {
        workerReached = true
        assert.deepEqual(request.ownership, ['src/example.js'])
        assert.deepEqual(request.fetchedEvidence.descriptiveLikelyAreas, ['/app/data/dbgw.py', descriptiveArea])
        const error = new Error('typed ownership reached production worker')
        error.code = 'TYPED_OWNERSHIP_PROVED'
        throw error
      }
      return { code: 'PASS', payload: {} }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'TYPED_OWNERSHIP_PROVED')
  assert.equal(workerReached, true)
})

test('one actionable checker FAIL launches one same-executor full-set repair and rechecks once', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-repair-'))
  const transitions = []
  const checkerCandidates = []
  const receiptPath = path.join(target, 'checker-fail-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const receiptHash = crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex')
  const executor = createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => transitions.push({ eventId, nextState, details }),
    resultPointer(workItemId) {
      assert.equal(workItemId, 'independent-check-1')
      return { name: workItemId, path: receiptPath, hash: receiptHash, bytes: fs.statSync(receiptPath).size }
    },
    harnessAttestation(candidateHash, oracle) {
      return { repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: crypto.createHash('sha256').update(oracle).digest('hex') }
    },
  })
  let checkerAttempt = 0
  let repairLaunches = 0
  const result = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      if (request.logicalRole === 'worker' && request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'rejected'\n")
        return { allAssignedItemsPass: true }
      }
      if (request.logicalRole === 'worker' && /^work-1-repair-\d+$/u.test(request.workItemId)) {
        repairLaunches += 1
        assert.equal(request.repairOf, 'work-1')
        assert.equal(request.executorKey, 'work-1')
        assert.equal(request.forkTurns, undefined)
        assert.equal(request.fetchedEvidence.rejectedCheckerReceipt.path, receiptPath)
        assert.equal(request.fetchedEvidence.rejectedCheckerReceipts.length, 1)
        assert.deepEqual(Object.keys(request.fetchedEvidence.rejectedCheckerReceipts[0]).sort(),
          ['bytes', 'hash', 'name', 'path', 'resultHash'])
        assert.match(request.assignment, /complete current aggregate/u)
        assert.match(request.assignment, /Generalize each fix/u)
        assert.match(request.assignment, /complete named and pre-existing regression matrix/u)
        assert.match(request.assignment, /bounded previews; never paste or dump full deliverables, logs, or transcripts/u)
        assert.match(request.strategyFingerprint, /^[a-f0-9]{64}$/)
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'accepted'\n")
        return { allAssignedItemsPass: true }
      }
      if (['independent-reviewer', 'independent-tester'].includes(request.logicalRole)) {
        checkerAttempt += 1
        checkerCandidates.push(request.candidateHash)
        assert.match(request.assignment,
          /Apply fetchedEvidence\.verificationDoctrine exactly to its named checks and verification obligations/u)
        assert.doesNotMatch(request.assignment, /full assigned matrix|testOutcomes entry|evidenceIds/u)
        const doctrine = request.fetchedEvidence.verificationDoctrine.join(' ')
        assert.match(doctrine, /finish the full assigned matrix after any failure/u)
        assert.match(doctrine, /every exact named check ID, return one testOutcomes entry/u)
        assert.match(doctrine,
          /containing checkId \(preferred; command and legacy id are accepted aliases\) and PASS or FAIL status/u)
        assert.match(doctrine,
          /Never use a tool-call or chunk ID, repeat a check ID, or supply conflicting identity aliases/u)
        assert.match(doctrine, /Do not inspect Autoprompt transcripts or compute observationId/u)
        assert.match(doctrine, /the controller owns execution identity and adds it only when/u)
        assert.match(doctrine, /PASS requires a unique zero exit bound to the exact version being checked/u)
        assert.match(doctrine, /authenticated nonzero test failure may bind FAIL and drive repair/u)
        assert.match(doctrine, /consumed underlying identifiers in evidenceIds and an allowed referenceMethod/u)
        assert.match(doctrine,
          /required consumer or independent check is unavailable, return CHECK_INCONCLUSIVE or RUNTIME_FAILURE/u)
        assert.match(doctrine,
          /strongest available consumer, or independently derived observable result/u)
        assert.match(doctrine, /forward soundness and reverse separation or injectivity/u)
        assert.match(doctrine,
          /before the first boundary, exactly at each boundary, between adjacent boundaries, and after the final boundary/u)
        assert.match(doctrine, /strongest locally available downstream consumer/u)
        assert.match(doctrine, /cross-product and batch composition/u)
        assert.match(doctrine, /static source or schema inspection alone never proves PASS/u)
        assert.match(doctrine,
          /Keep large evidence in scratch and return only bounded diagnostics/u)
        if (checkerAttempt === 1) return {
          code: 'FAIL', cause: { event: 'ASSERTION_FAILED', reason: 'exact behavior mismatch', unblockPath: 'repair implementation' },
          payload: {
            findingIds: ['AP-RUN-026'],
            testOutcomes: controllerBoundFailureOutcomes(request, 'AP-RUN-026'),
          },
        }
        return {
          code: 'PASS',
          payload: {
            evidenceIds: [`command:authoritative-check:${request.workItemId}`],
            referenceMethod: checkerReferenceMethod(
              request.logicalRole === 'independent-reviewer' ? 'requirements-review' : 'black-box-boundary',
              request.workItemId,
            ),
            testOutcomes: checkerTestOutcomes(request),
          },
        }
      }
      return { code: 'PASS', payload: {} }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(repairLaunches, 1)
  assert.equal(checkerAttempt, 2)
  assert.notEqual(checkerCandidates[0], checkerCandidates[1])
  assert.deepEqual(transitions.filter(item => ['IMPLEMENTATION_DEFECT', 'REPAIR_READY'].includes(item.eventId))
    .map(item => [item.eventId, item.nextState]), [
    ['IMPLEMENTATION_DEFECT', 'REPAIRING'],
    ['REPAIR_READY', 'CHECK_WORK'],
  ])
})

test('all checker seats inspect one frozen candidate and feed one aggregate repair', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-batch-repair-'))
  const receiptPath = path.join(target, 'checker-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const receiptHash = crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex')
  const checkerCandidates = []
  let repairLaunches = 0
  const executor = createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    transition: async () => {},
    resultPointer: workItemId => ({
      name: workItemId,
      path: receiptPath,
      hash: receiptHash,
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT', decision: withExactTwoCheckerPlan(decision('DIRECT')),
    launch: async request => {
      if (request.logicalRole === 'worker' && request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'initial'\n")
        return { allAssignedItemsPass: true }
      }
      if (request.logicalRole === 'worker' && /^work-1-repair-\d+$/u.test(request.workItemId)) {
        repairLaunches += 1
        assert.deepEqual(request.findingIds, ['AP-RUN-026', 'AP-RUN-027'])
        assert.equal(request.fetchedEvidence.rejectedCheckerReceipts.length, 2)
        assert.deepEqual(
          request.fetchedEvidence.rejectedCheckerReceipts.map(item => item.name),
          ['independent-check-1', 'independent-check-2'],
        )
        assert.equal(request.fetchedEvidence.checkerResultHashes.length, 2)
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'repaired'\n")
        return { allAssignedItemsPass: true }
      }
      if (['independent-reviewer', 'independent-tester'].includes(request.logicalRole)) {
        checkerCandidates.push(request.candidateHash)
        assert.equal(request.fetchedEvidence.verificationObligations.length, 1)
        assert.deepEqual(request.checks.filter(check => check.startsWith('verification:')), [
          'verification:obligation-1:expected',
        ], 'each checker seat receives the full verification matrix')
        if (repairLaunches === 0) {
          const first = request.logicalRole === 'independent-reviewer'
          return {
            code: 'FAIL',
            cause: {
              event: 'ASSERTION_FAILED',
              reason: first ? 'positive boundary defect' : 'negative boundary defect',
              unblockPath: 'repair implementation',
            },
            payload: { findingIds: [first ? 'AP-RUN-026' : 'AP-RUN-027'] },
          }
        }
        assert.deepEqual(
          request.evidencePointers.map(pointer => pointer.name),
          ['independent-check-1', 'independent-check-2'],
        )
        assert.deepEqual(
          request.fetchedEvidence.rejectedCheckerReceipts.map(receipt => receipt.name),
          ['independent-check-1', 'independent-check-2'],
        )
        assert.deepEqual(request.fetchedEvidence.rejectedFindingIds, ['AP-RUN-026', 'AP-RUN-027'])
        assert.match(request.fetchedEvidence.aggregateFailureHash, /^[a-f0-9]{64}$/u)
        assert.deepEqual(
          request.evidenceHashes,
          request.evidencePointers.map(pointer => pointer.hash),
        )
        return {
          code: 'PASS',
          payload: {
            evidenceIds: [`command:authoritative-check:${request.workItemId}`],
            referenceMethod: checkerReferenceMethod(
              request.logicalRole === 'independent-reviewer'
                ? 'requirements-review' : 'black-box-boundary',
              request.workItemId,
            ),
            testOutcomes: checkerTestOutcomes(request),
          },
        }
      }
      return { code: 'PASS', payload: {} }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(repairLaunches, 1)
  assert.equal(checkerCandidates.length, 4)
  assert.equal(checkerCandidates[0], checkerCandidates[1])
  assert.notEqual(checkerCandidates[1], checkerCandidates[2])
  assert.equal(checkerCandidates[2], checkerCandidates[3])
})

test('changed W2/W3 ROADMAP candidates receive one union repair and every fresh checker passes', async t => {
  for (const workerCount of [2, 3]) await t.test(`W${workerCount}`, async t => {
    const target = createTempGitTarget(tempDirectory(t, `autoprompt-roadmap-union-w${workerCount}-`))
    for (let index = 1; index <= workerCount; index++) {
      fs.writeFileSync(path.join(target, 'src', `work-${index}.js`), "module.exports = 'initial'\n")
    }
    const routeDecision = withExactTwoCheckerPlan(
      structuredClone(disjointAutomaticRoadmapDecision(workerCount)),
    )
    const planPath = path.join(target, 'plan', 'ROADMAP.md')
    const receiptPath = path.join(target, 'checker-receipt.json')
    fs.writeFileSync(receiptPath, '{}\n')
    let repairLaunches = 0
    let initialCheckerLaunches = 0
    let freshCheckerLaunches = 0
    const launches = []
    const executor = createDefaultRouteExecutor({
      targetPath: target,
      gitEnvironment: () => process.env,
      transition: async () => {},
      writePlan: (route, selectedDecision, projection) => {
        fs.mkdirSync(path.dirname(planPath), { recursive: true })
        fs.writeFileSync(planPath, renderPlanArtifact(route, selectedDecision, projection))
      },
      planExists: () => fs.existsSync(planPath),
      planPointer: () => {
        const bytes = fs.readFileSync(planPath)
        return {
          path: planPath,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
        }
      },
      resultPointer: workItemId => ({
        name: workItemId,
        path: receiptPath,
        hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
        bytes: fs.statSync(receiptPath).size,
      }),
      harnessAttestation: (candidateHash, oracle) => ({
        repoHash: candidateHash,
        buildHash: 'b'.repeat(64),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })
    const outcome = await executor({
      route: 'ROADMAP', decision: routeDecision,
      launch: async request => {
        launches.push(request.workItemId)
        if (request.logicalRole === 'worker' && /^work-\d+$/u.test(request.workItemId)) {
          fs.writeFileSync(
            path.join(target, 'src', `${request.workItemId}.js`),
            `module.exports = '${request.workItemId}'\n`,
          )
          return { allAssignedItemsPass: true, filesChanged: [`src/${request.workItemId}.js`] }
        }
        if (request.workItemId === 'work-1-repair-1') {
          repairLaunches += 1
          const expectedIdentities = Array.from(
            { length: workerCount }, (_, index) => `src/work-${index + 1}.js`,
          )
          assert.deepEqual(request.ownership.map(item => item.identity).sort(), expectedIdentities)
          assert.equal(request.ownership.every(item => item.owner === request.workItemId), true)
          assert.deepEqual(request.manifests, request.ownership)
          fs.writeFileSync(path.join(target, 'src', 'work-1.js'), "module.exports = 'repaired-union'\n")
          return { allAssignedItemsPass: true, filesChanged: ['src/work-1.js'] }
        }
        const repairCheck = /-repair-1$/u.test(request.workItemId)
        if (!repairCheck) {
          initialCheckerLaunches += 1
          return {
            code: 'FAIL',
            cause: {
              event: 'ASSERTION_FAILED',
              reason: `seat ${initialCheckerLaunches} found a concrete union defect`,
              unblockPath: 'repair the aggregate candidate',
            },
            payload: { findingIds: [`AP-UNION-${initialCheckerLaunches}`] },
          }
        }
        freshCheckerLaunches += 1
        return {
          code: 'PASS', currentVersionHash: request.candidateHash,
          payload: {
            evidenceIds: [`evidence:${request.workItemId}`],
            referenceMethod: checkerReferenceMethod(
              request.logicalRole === 'independent-reviewer'
                ? 'requirements-review' : 'black-box-boundary',
              request.workItemId,
            ),
            testOutcomes: checkerTestOutcomes(request),
          },
        }
      },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async () => ({}),
      resumeState: null,
    })
    assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
    assert.equal(repairLaunches, 1)
    assert.equal(initialCheckerLaunches, 2)
    assert.equal(freshCheckerLaunches, 2)
    assert.deepEqual(launches.filter(id => id === 'work-1-repair-1'), ['work-1-repair-1'])
  })
})

test('crash-restored first-seat FAIL joins the remaining seat in one aggregate repair', async t => {
  const directory = tempDirectory(t, 'autoprompt-batched-fail-resume-')
  const targetPath = createTempGitTarget(directory)
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'rejected'\n")
  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Reproduce requirement defects.', 'Reproduce boundary defects.'],
    nonOverlapReason: 'Requirement and boundary evidence are independently derived.',
  }
  const records = new Map()
  const pointers = new Map()
  const persistResult = (workItemId, result) => {
    records.set(workItemId, result)
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, { name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
    return result
  }
  const firstId = 'independent-check-1'
  const firstFailure = persistResult(firstId, {
    code: 'FAIL', currentVersionHash: candidateHash,
    cause: { event: 'ASSERTION_FAILED', reason: 'requirement defect', unblockPath: 'repair implementation' },
    payload: { findingIds: ['AP-RUN-026'] },
  })
  const launches = []
  let repairLaunches = 0
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => records.get(workItemId) || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, firstId); assert.equal(result, firstFailure); return true
    },
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'independent-check-2') {
        return persistResult(request.workItemId, {
          code: 'FAIL', currentVersionHash: request.candidateHash,
          cause: { event: 'ASSERTION_FAILED', reason: 'boundary defect', unblockPath: 'repair implementation' },
          payload: { findingIds: ['AP-RUN-027'] },
        })
      }
      if (request.workItemId === 'work-1-repair-1') {
        repairLaunches += 1
        assert.deepEqual(request.findingIds, ['AP-RUN-026', 'AP-RUN-027'])
        assert.equal(request.fetchedEvidence.rejectedCheckerReceipts.length, 2)
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired'\n")
        return { allAssignedItemsPass: true }
      }
      assert.match(request.workItemId, /^independent-check-[12]-repair-1$/u)
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod(
          request.workItemId.includes('check-1') ? 'requirements-review' : 'black-box-boundary',
          request.workItemId,
        ),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1'], completedCheckIds: [firstId],
      acceptedResultIds: [], nextReadyWorkIds: ['independent-check-2'], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(repairLaunches, 1)
  assert.deepEqual(launches, [
    'independent-check-2', 'work-1-repair-1',
    'independent-check-1-repair-1', 'independent-check-2-repair-1',
  ])
})

test('crash after the final checker FAIL restores the whole batch into one aggregate repair', async t => {
  const directory = tempDirectory(t, 'autoprompt-final-batched-fail-resume-')
  const targetPath = createTempGitTarget(directory)
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'rejected'\n")
  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Reproduce requirement defects.', 'Reproduce boundary defects.'],
    nonOverlapReason: 'Requirement and boundary evidence are independently derived.',
  }
  const records = new Map()
  const pointers = new Map()
  for (const [workItemId, findingId, reason] of [
    ['independent-check-1', 'AP-RUN-026', 'requirement defect'],
    ['independent-check-2', 'AP-RUN-027', 'boundary defect'],
  ]) {
    const result = {
      code: 'FAIL', currentVersionHash: candidateHash,
      cause: { event: 'ASSERTION_FAILED', reason, unblockPath: 'repair implementation' },
      payload: { findingIds: [findingId] },
    }
    records.set(workItemId, result)
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, { name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  const launches = []
  let repairLaunches = 0
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => records.get(workItemId) || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(result, records.get(workItemId)); return true
    },
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1-repair-1') {
        repairLaunches += 1
        assert.deepEqual(request.findingIds, ['AP-RUN-026', 'AP-RUN-027'])
        assert.deepEqual(
          request.fetchedEvidence.rejectedCheckerReceipts.map(item => item.name),
          ['independent-check-1', 'independent-check-2'],
        )
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired'\n")
        return { allAssignedItemsPass: true }
      }
      assert.match(request.workItemId, /^independent-check-[12]-repair-1$/u)
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod(
          request.workItemId.includes('check-1') ? 'requirements-review' : 'black-box-boundary',
          request.workItemId,
        ),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1'],
      completedCheckIds: ['independent-check-1', 'independent-check-2'],
      acceptedResultIds: [], nextReadyWorkIds: [], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(repairLaunches, 1)
  assert.deepEqual(launches, [
    'work-1-repair-1',
    'independent-check-1-repair-1', 'independent-check-2-repair-1',
  ])
})

test('an unsuccessful checker repair returns a bound task terminal instead of an internal controller failure', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-repair-unsuccessful-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently verify the candidate.'],
    nonOverlapReason: null,
  }
  const receiptPath = path.join(target, 'checker-fail-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => ({
      name: workItemId, path: receiptPath,
      hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'rejected'\n")
        return { allAssignedItemsPass: true }
      }
      if (request.workItemId === 'work-1-repair-1') return { allAssignedItemsPass: false }
      return {
        code: 'FAIL',
        cause: { event: 'ASSERTION_FAILED', reason: 'reproduced defect', unblockPath: 'repair implementation' },
        payload: { findingIds: ['AP-RUN-026'] },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'FAILED')
  assert.deepEqual(result.terminalEnvelope, {
    code: 'FAIL',
    cause: { event: 'ASSERTION_FAILED', reason: 'reproduced defect', unblockPath: 'repair implementation' },
    payload: { findingIds: ['AP-RUN-026'] },
  })
})

test('a checker capability-only FAIL is controller-classified as inconclusive and never launches implementation repair', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-capability-fail-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Verify with the strongest available independent method.'],
    nonOverlapReason: null,
  }
  const launches = []
  const receiptPath = path.join(target, 'capability-checker-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => ({
      name: workItemId,
      path: receiptPath,
      hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'candidate'\n")
        return { allAssignedItemsPass: true }
      }
      return {
        code: 'FAIL',
        cause: {
          event: 'DOWNSTREAM_CONSUMER_RECEIPT_MISSING',
          reason: 'the external CAD consumer is not installed in this environment',
          unblockPath: null,
        },
        payload: {
          verificationLimitation: {
            kind: 'CAPABILITY_UNAVAILABLE',
            capabilityId: 'external.cad-consumer',
            explicitUserDeliverable: false,
            observedVersionDefectIds: [],
          },
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'DONE')
  assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(result.terminalEnvelope.limitations[0].verificationLimitation.capabilityId,
    'external.cad-consumer')
  assert.deepEqual(launches, ['work-1', 'independent-check-1'])
  assert.equal(launches.some(id => /^work-1-repair-/u.test(id)), false)
})

test('malformed direct capability limitation returns the usable candidate without fresh reassessment', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-malformed-capability-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Verify with the strongest available independent method.'],
    nonOverlapReason: null,
  }
  const launches = []
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'candidate'\n")
        return { allAssignedItemsPass: true }
      }
      if (request.workItemId === 'independent-check-1') {
        return {
          code: 'CHECK_INCONCLUSIVE',
          cause: { event: 'CHECK_INCONCLUSIVE', reason: 'consumer could not be opened' },
          payload: { verificationLimitation: {
            kind: 'CAPABILITY_UNAVAILABLE', explicitUserDeliverable: false,
            observedVersionDefectIds: [],
          } },
        }
      }
      assert.fail(`non-authoritative capability evidence must not relaunch ${request.workItemId}`)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches, ['work-1', 'independent-check-1'])
  assert.equal(launches.some(id => id.includes('runtime-retry')), false)
  assert.equal(launches.some(id => /^work-1-repair-/u.test(id)), false)
})

test('crash-restored capability limitation advances to the next checker without repeating the unavailable consumer', async t => {
  const directory = tempDirectory(t, 'autoprompt-capability-resume-')
  const targetPath = createTempGitTarget(directory)
  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Reopen in the external consumer.', 'Independently inspect all portable properties.'],
    nonOverlapReason: 'Consumer admission and portable property checks use distinct evidence.',
  }
  const completedId = 'independent-check-1'
  const limitation = {
    code: 'FAIL', currentVersionHash: candidateHash,
    cause: { event: 'DOWNSTREAM_CONSUMER_RECEIPT_MISSING', reason: 'consumer unavailable', unblockPath: null },
    payload: { verificationLimitation: {
      kind: 'CAPABILITY_UNAVAILABLE', capabilityId: 'external.cad-consumer',
      explicitUserDeliverable: false, observedVersionDefectIds: [],
    } },
  }
  const resultPath = path.join(directory, `${completedId}.json`)
  fs.writeFileSync(resultPath, `${JSON.stringify(limitation)}\n`)
  const bytes = fs.readFileSync(resultPath)
  const pointer = { name: completedId, path: resultPath,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => workItemId === completedId ? limitation : null,
    resultPointer: workItemId => { assert.equal(workItemId, completedId); return pointer },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, completedId); assert.equal(result, limitation); return true
    },
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      assert.equal(request.workItemId, 'independent-check-2')
      return { code: 'PASS', payload: {
        evidenceIds: ['evidence:portable-properties'],
        referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1'], completedCheckIds: [completedId],
      acceptedResultIds: [], nextReadyWorkIds: ['independent-check-2'], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(outcome.terminalEnvelope.limitations[0].verificationLimitation.capabilityId,
    'external.cad-consumer')
  assert.deepEqual(launches, ['independent-check-2'])
})

test('crash-restored legacy capability-only FAIL matches live completion and cancels its obsolete repair frontier', async t => {
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Reopen the exact candidate in the strongest available independent consumer.'],
    nonOverlapReason: null,
  }
  const capabilityFailure = candidateHash => ({
    code: 'FAIL', currentVersionHash: candidateHash, candidateHash,
    cause: {
      event: 'DOWNSTREAM_CONSUMER_RECEIPT_MISSING',
      reason: 'the external CAD consumer is not installed in this environment',
      unblockPath: null,
    },
    payload: { verificationLimitation: {
      kind: 'CAPABILITY_UNAVAILABLE', capabilityId: 'external.cad-consumer',
      explicitUserDeliverable: false, observedVersionDefectIds: [],
    } },
  })
  const executorOptions = targetPath => ({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })

  const liveTarget = createTempGitTarget(tempDirectory(t, 'autoprompt-capability-live-parity-'))
  const liveLaunches = []
  const live = await createDefaultRouteExecutor(executorOptions(liveTarget))({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      liveLaunches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(liveTarget, 'src', 'example.js'), "module.exports = 'candidate'\n")
        return { allAssignedItemsPass: true }
      }
      return capabilityFailure(request.candidateHash)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(live.outcome, 'DONE', JSON.stringify(live))
  assert.equal(live.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(liveLaunches, ['work-1', 'independent-check-1'])

  const resumeDirectory = tempDirectory(t, 'autoprompt-capability-legacy-repair-resume-')
  const resumeTarget = createTempGitTarget(resumeDirectory)
  fs.writeFileSync(path.join(resumeTarget, 'src', 'example.js'), "module.exports = 'candidate'\n")
  const candidateHash = testWorkspaceCandidateHash(resumeTarget)
  const durableFailure = capabilityFailure(candidateHash)
  const resultPath = path.join(resumeDirectory, 'independent-check-1.json')
  fs.writeFileSync(resultPath, `${JSON.stringify(durableFailure)}\n`)
  const bytes = fs.readFileSync(resultPath)
  const pointer = {
    name: 'independent-check-1', path: resultPath,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  }
  const resumedLaunches = []
  const resumed = await createDefaultRouteExecutor({
    ...executorOptions(resumeTarget),
    readResult: workItemId => workItemId === 'independent-check-1' ? durableFailure : null,
    resultPointer: workItemId => { assert.equal(workItemId, 'independent-check-1'); return pointer },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, 'independent-check-1')
      assert.equal(result, durableFailure)
      return true
    },
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => { resumedLaunches.push(request.workItemId); assert.fail('resume must not launch obsolete repair work') },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1'], completedCheckIds: [], acceptedResultIds: [],
      nextReadyWorkIds: ['work-1-repair-1'], retryState: {},
    },
  })
  assert.equal(resumed.outcome, live.outcome, JSON.stringify(resumed))
  assert.equal(resumed.terminalEnvelope.status, live.terminalEnvelope.status)
  assert.deepEqual(resumed.terminalEnvelope.limitations.map(item => item.verificationLimitation),
    live.terminalEnvelope.limitations.map(item => item.verificationLimitation))
  assert.deepEqual(resumedLaunches, [])
})

test('capability classification never hides an explicit user deliverable or an observed exact-version defect', () => {
  const base = {
    code: 'FAIL',
    description: 'The checked result does not satisfy one or more named requirements.',
    stateClass: 'terminal',
    cause: {
      event: 'DOWNSTREAM_CONSUMER_RECEIPT_MISSING',
      reason: 'the external consumer receipt is absent',
      unblockPath: 'produce the required receipt',
    },
    payload: {
      verificationLimitation: {
        kind: 'CAPABILITY_UNAVAILABLE',
        capabilityId: 'external.cad-consumer',
        explicitUserDeliverable: false,
        observedVersionDefectIds: [],
      },
    },
  }
  assert.equal(canonicalizeCheckerVerificationLimitation(base).code, 'CHECK_INCONCLUSIVE')
  assert.equal(canonicalizeCheckerVerificationLimitation({
    ...base,
    payload: { verificationLimitation: {
      ...base.payload.verificationLimitation,
      explicitUserDeliverable: true,
    } },
  }).code, 'FAIL')
  assert.equal(canonicalizeCheckerVerificationLimitation({
    ...base,
    payload: { verificationLimitation: {
      ...base.payload.verificationLimitation,
      observedVersionDefectIds: ['CAD-EMPTY-GEOMETRY'],
    } },
  }).code, 'FAIL')
  assert.equal(canonicalizeCheckerVerificationLimitation({
    ...base,
    payload: { verificationLimitation: { kind: 'CAPABILITY_UNAVAILABLE' } },
  }).code, 'FAIL')
  assert.equal(canonicalizeCheckerVerificationLimitation({
    ...base,
    payload: {
      verificationLimitation: base.payload.verificationLimitation,
      findingIds: ['CAD-EMPTY-GEOMETRY'],
    },
  }).code, 'FAIL')
  assert.equal(canonicalizeCheckerVerificationLimitation({
    ...base,
    payload: {
      verificationLimitation: base.payload.verificationLimitation,
      testOutcomes: [{ command: 'reopen exact artifact', status: 'FAIL', fingerprint: 'f'.repeat(64) }],
    },
  }).code, 'FAIL')
})

test('a typed capability claim cannot hide contradictory failing checker evidence', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-capability-defect-conflict-'))
  const launches = []
  const receiptPath = path.join(target, 'contradictory-checker-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => ({
      name: workItemId,
      path: receiptPath,
      hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'defective candidate'\n")
        return { allAssignedItemsPass: true }
      }
      if (request.logicalRole === 'worker') return { allAssignedItemsPass: true }
      return {
        code: 'FAIL',
        cause: { event: 'CHECK_INCONCLUSIVE', reason: 'consumer unavailable' },
        payload: {
          findingIds: ['CAD-EMPTY-GEOMETRY'],
          testOutcomes: (request.checks || []).map(command => ({
            command, status: 'FAIL', fingerprint: 'f'.repeat(64),
          })),
          verificationLimitation: {
            kind: 'CAPABILITY_UNAVAILABLE', capabilityId: 'external.cad-consumer',
            explicitUserDeliverable: false, observedVersionDefectIds: [],
          },
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.code, 'FAIL')
  assert.deepEqual(result.terminalEnvelope.payload.findingIds, ['CAD-EMPTY-GEOMETRY'])
  assert.deepEqual(launches, ['work-1', 'independent-check-1', 'work-1-repair-1'])
})

test('an unsuccessful implementation result without a usable deliverable returns its bound task failure', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-worker-unsuccessful-'))
  fs.writeFileSync(path.join(target, 'preexisting-user-change.txt'), 'not produced by this worker\n')
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const failedResult = {
    allAssignedItemsPass: false,
    // The target is dirty, but no isolated mutation admission attributes
    // these bytes to this worker. A self-reported path must not make the
    // unsuccessful result usable.
    filesChanged: ['preexisting-user-change.txt'],
    successItems: [
      { id: 'implemented', status: 'pass', evidenceIds: ['evidence:implementation'] },
      { id: 'author-checks', status: 'fail', evidenceIds: ['evidence:author-checks'] },
      { id: 'remaining-boundary', status: 'blocked', evidenceIds: ['evidence:boundary'] },
    ],
  }
  const result = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => request.workItemId === 'work-1'
      ? failedResult
      : { code: 'PASS', payload: {} },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'FAILED')
  assert.deepEqual(result.terminalEnvelope, {
    code: 'IMPLEMENTATION_WORK_UNSUCCESSFUL',
    status: 'IMPLEMENTATION_WORK_UNSUCCESSFUL',
    reason: 'the implementation worker explicitly reported that its assigned implementation and author-side checks did not pass',
    workItemId: 'work-1',
    workResultHash: result.terminalEnvelope.workResultHash,
    failedSuccessItemIds: ['author-checks', 'remaining-boundary'],
  })
  assert.match(result.terminalEnvelope.workResultHash, /^[a-f0-9]{64}$/u)

  const adoptedResult = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async () => assert.fail('an adopted explicit result must not relaunch its worker'),
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({ 'work-1': failedResult }),
    resumeState: {
      resumeState: 'RUN_WORK',
      completedWorkIds: ['work-1'],
      completedCheckIds: [],
      nextReadyWorkIds: [],
      candidateHash: null,
    },
  })
  assert.deepEqual(adoptedResult, result)
})

test('a promoted usable deliverable reaches independent checking despite worker self-assessment', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-worker-product-first-'))
  const transitions = []
  const launches = []
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env,
    readMutationAdmission: () => ({
      files: [{
        relative: 'src/example.js',
        hash: crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(target, 'src', 'example.js'))).digest('hex'),
      }],
    }),
    transition: async (eventId, nextState, details) => {
      transitions.push({ eventId, nextState, details })
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const workerResult = {
    allAssignedItemsPass: false,
    filesChanged: ['src/example.js'],
    successItems: [
      { id: 'product-created', status: 'pass', evidenceIds: ['evidence:product'] },
      { id: 'author-confidence', status: 'fail', evidenceIds: ['evidence:self-check'] },
    ],
  }
  const independentPass = request => ({
    code: 'PASS',
    payload: {
      evidenceIds: ['evidence:independent-product-check'],
      referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
      testOutcomes: checkerTestOutcomes(request),
    },
  })
  const result = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'usable-product'\n")
        return workerResult
      }
      assert.equal(request.logicalRole, 'independent-reviewer')
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.deepEqual(launches, ['work-1', 'independent-check-1'])
  assert.equal(transitions.some(item => item.eventId === 'ALL_WORK_JOINED' &&
    item.nextState === 'CHECK_WORK'), true)
  assert.equal(result.deliverables.some(item => item.path === path.join(target, 'src', 'example.js')), true)

  const adoptedLaunches = []
  const adopted = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      adoptedLaunches.push(request.workItemId)
      assert.equal(request.logicalRole, 'independent-reviewer')
      return independentPass(request)
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async ({ stage }) => stage === 'work' ? { 'work-1': workerResult } : {},
    resumeState: {
      resumeState: 'RUN_WORK', completedWorkIds: ['work-1'], completedCheckIds: [],
      nextReadyWorkIds: [], candidateHash: null,
    },
  })
  assert.equal(adopted.outcome, 'DONE', JSON.stringify(adopted))
  assert.deepEqual(adoptedLaunches, ['independent-check-1'])
})

test('child transport timeouts retry workers but return checker-limited candidates without fresh reassessment', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-child-watchdog-'))
  const ordering = []
  const executor = createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    transition: async eventId => ordering.push(`transition:${eventId}`),
    persistControllerCheckerResult: async request => {
      ordering.push(`persist:${request.workItemId}`)
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const workerTransportFailure = request => ({
    allAssignedItemsPass: false,
    filesChanged: [], commands: [],
    successItems: [{ id: 'provider-transport', status: 'fail', evidenceIds: ['transport:evidence'] }],
    findingIds: ['provider-transport'], evidenceHashes: ['a'.repeat(64)],
    terminalEnvelope: { status: 'CHILD_TRANSPORT_TIMEOUT', reason: 'bounded provider watchdog' },
  })
  const checkerTransportFailure = request => ({
    schemaVersion: '2.0.0', code: 'RUNTIME_FAILURE', runId: 'run-1',
    requestEnvelopeHash: decision('DIRECT').requestEnvelopeHash,
    candidateHash: request.candidateHash, currentVersionHash: request.candidateHash,
    completedResults: [], nextReadyWork: [],
    cause: {
      event: 'CHILD_TRANSPORT_TIMEOUT', reason: 'bounded provider watchdog',
      unblockPath: 'Launch one fresh evidence-bound checker reassessment.',
    },
    payloadSchemaId: 'autoprompt.checker-launch-reassessment.v2', payload: {},
    recordedAt: new Date(0).toISOString(),
  })
  const workerLaunches = []
  const workerTimedOut = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      workerLaunches.push(request.workItemId)
      return workerTransportFailure(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(workerTimedOut.outcome, 'FAILED')
  assert.deepEqual(workerTimedOut.terminalEnvelope,
    workerTransportFailure({}).terminalEnvelope)
  assert.deepEqual(workerLaunches, ['work-1', 'work-1-transport-retry-1'])
  assert.deepEqual(ordering.filter(item => item.startsWith('persist:')), [])

  ordering.length = 0
  const checkerLaunches = []
  const checkerLimited = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'watchdog-product'\n")
        return {
          allAssignedItemsPass: true,
          filesChanged: ['src/example.js'],
          successItems: [{ id: 'implemented', status: 'pass', evidenceIds: ['worker:evidence'] }],
        }
      }
      checkerLaunches.push(request.workItemId)
      return checkerTransportFailure(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(checkerLimited.outcome, 'DONE', JSON.stringify(checkerLimited))
  assert.equal(checkerLimited.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(checkerLaunches, ['independent-check-1'])
  assert.equal(checkerLaunches.some(id => id.includes('runtime-retry')), false)
  assert.deepEqual(ordering.filter(item => item.startsWith('persist:')), [])
  assert.equal(ordering.includes('transition:CHECK_INCONCLUSIVE'), true)
})

test('each exact worker owns an independent provider transport contingency', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-worker-transport-per-item-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.usefulWorkerCount = 2
  routeDecision.workerResponsibilities = ['Complete item one.', 'Complete item two.']
  const launches = []
  const requestedRetries = new Map()
  const timeout = workItemId => ({
    allAssignedItemsPass: false,
    filesChanged: [], commands: [],
    successItems: [{ id: 'provider-transport', status: 'fail', evidenceIds: [`transport:${workItemId}`] }],
    findingIds: ['provider-transport'], evidenceHashes: ['a'.repeat(64)],
    terminalEnvelope: {
      status: 'CHILD_TRANSPORT_TIMEOUT',
      reason: `bounded provider watchdog for ${workItemId}`,
    },
  })
  const outcome = await createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1' || request.workItemId === 'work-2') {
        requestedRetries.set(request.workItemId, request.transportFailureRetryId)
        return timeout(request.workItemId)
      }
      if (request.workItemId === 'work-1-transport-retry-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'),
          "module.exports = 'both-transport-contingencies-used'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      if (request.workItemId === 'work-2-transport-retry-1') {
        return { allAssignedItemsPass: true, filesChanged: [] }
      }
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'work-1', 'work-1-transport-retry-1',
    'work-2', 'work-2-transport-retry-1',
    'independent-check-1',
  ])
  assert.deepEqual([...requestedRetries], [
    ['work-1', 'work-1-transport-retry-1'],
    ['work-2', 'work-2-transport-retry-1'],
  ])
})

test('a later worker retry timeout terminates with its exact provider failure', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-worker-transport-real-failure-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.usefulWorkerCount = 2
  routeDecision.workerResponsibilities = ['Complete item one.', 'Complete item two.']
  const launches = []
  const timeout = workItemId => ({
    allAssignedItemsPass: false,
    filesChanged: [], commands: [],
    successItems: [{ id: 'provider-transport', status: 'fail', evidenceIds: [`transport:${workItemId}`] }],
    findingIds: ['provider-transport'], evidenceHashes: ['a'.repeat(64)],
    terminalEnvelope: {
      status: 'CHILD_TRANSPORT_TIMEOUT',
      reason: `provider remained unavailable for ${workItemId}`,
      providerFailureId: `provider:${workItemId}`,
    },
  })
  const finalProviderFailure = timeout('work-2-transport-retry-1')
  const outcome = await createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return timeout(request.workItemId)
      if (request.workItemId === 'work-1-transport-retry-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'),
          "module.exports = 'first-worker-retried'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      if (request.workItemId === 'work-2') return timeout(request.workItemId)
      if (request.workItemId === 'work-2-transport-retry-1') return finalProviderFailure
      assert.fail(`unexpected launch ${request.workItemId}`)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'FAILED')
  assert.equal(outcome.terminalEnvelope, finalProviderFailure.terminalEnvelope)
  assert.deepEqual(launches, [
    'work-1', 'work-1-transport-retry-1',
    'work-2', 'work-2-transport-retry-1',
  ])
})

test('crash recovery restores transport contingency consumption per exact worker', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-worker-transport-per-item-resume-'))
  fs.writeFileSync(path.join(target, 'src', 'example.js'),
    "module.exports = 'durable-first-worker-retry'\n")
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.usefulWorkerCount = 2
  routeDecision.workerResponsibilities = ['Complete item one.', 'Complete item two.']
  const firstRetryId = 'work-1-transport-retry-1'
  const firstRetryResult = { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
  const resultPath = path.join(path.dirname(target), `${firstRetryId}.json`)
  fs.writeFileSync(resultPath, `${JSON.stringify(firstRetryResult)}\n`)
  const resultBytes = fs.readFileSync(resultPath)
  const pointer = {
    name: firstRetryId, path: resultPath, bytes: resultBytes.length,
    hash: crypto.createHash('sha256').update(resultBytes).digest('hex'),
  }
  const launches = []
  const secondBaseTimeout = {
    allAssignedItemsPass: false, filesChanged: [], commands: [],
    successItems: [{ id: 'provider-transport', status: 'fail', evidenceIds: ['transport:work-2'] }],
    findingIds: ['provider-transport'], evidenceHashes: ['a'.repeat(64)],
    terminalEnvelope: { status: 'CHILD_TRANSPORT_TIMEOUT', reason: 'work-2 provider timeout' },
  }
  const outcome = await createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => workItemId === firstRetryId ? firstRetryResult : null,
    resultPointer: workItemId => { assert.equal(workItemId, firstRetryId); return pointer },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, firstRetryId)
      assert.equal(result, firstRetryResult)
      return true
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-2') {
        assert.equal(request.transportFailureRetryId, 'work-2-transport-retry-1')
        return secondBaseTimeout
      }
      if (request.workItemId === 'work-2-transport-retry-1') {
        return { allAssignedItemsPass: true, filesChanged: [] }
      }
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async ({ stage }) => stage === 'work' ? {
      'work-1': firstRetryResult,
      [firstRetryId]: firstRetryResult,
    } : {},
    resumeState: {
      resumeState: 'RUN_WORK', completedWorkIds: [firstRetryId], completedCheckIds: [],
      acceptedResultIds: [], nextReadyWorkIds: ['work-2'], candidateHash: null, retryState: {},
    },
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'work-2', 'work-2-transport-retry-1', 'independent-check-1',
  ])
})

test('an implementation repair owns a provider transport retry before repaired recheck', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-repair-transport-success-'))
  const receiptPointers = new Map()
  const persist = (workItemId, result) => {
    const resultPath = path.join(path.dirname(target), `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    receiptPointers.set(workItemId, {
      name: workItemId, path: resultPath, bytes: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    })
    return result
  }
  const repairTimeout = {
    allAssignedItemsPass: false, filesChanged: [], commands: [],
    successItems: [{ id: 'provider-transport', status: 'fail', evidenceIds: ['transport:repair'] }],
    findingIds: ['provider-transport'], evidenceHashes: ['a'.repeat(64)],
    terminalEnvelope: { status: 'CHILD_TRANSPORT_TIMEOUT', reason: 'repair provider timeout' },
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => receiptPointers.get(workItemId),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'defect'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      if (request.workItemId === 'independent-check-1') {
        return persist(request.workItemId, {
          code: 'FAIL',
          cause: { event: 'ASSERTION_FAILED', reason: 'repair transport defect', unblockPath: 'repair' },
          payload: {
            findingIds: ['REPAIR-TRANSPORT'],
            testOutcomes: controllerBoundFailureOutcomes(request, 'REPAIR-TRANSPORT'),
          },
        })
      }
      if (request.workItemId === 'work-1-repair-1') {
        assert.equal(request.transportFailureRetryId,
          'work-1-repair-1-transport-retry-1')
        return repairTimeout
      }
      if (request.workItemId === 'work-1-repair-1-transport-retry-1') {
        assert.equal(request.executorKey, 'work-1')
        fs.writeFileSync(path.join(target, 'src', 'example.js'),
          "module.exports = 'repaired-after-transport'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'work-1', 'independent-check-1',
    'work-1-repair-1', 'work-1-repair-1-transport-retry-1',
    'independent-check-1-repair-1',
  ])
})

test('an exhausted implementation-repair transport successor returns the concrete product failure and existing candidate', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-repair-transport-failed-'))
  const receiptPointers = new Map()
  const persist = (workItemId, result) => {
    const resultPath = path.join(path.dirname(target), `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    receiptPointers.set(workItemId, {
      name: workItemId, path: resultPath, bytes: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    })
    return result
  }
  const timeout = reason => ({
    allAssignedItemsPass: false, filesChanged: [], commands: [],
    successItems: [{ id: 'provider-transport', status: 'fail', evidenceIds: ['transport:repair'] }],
    findingIds: ['provider-transport'], evidenceHashes: ['a'.repeat(64)],
    terminalEnvelope: { status: 'CHILD_TRANSPORT_TIMEOUT', reason },
  })
  const successorFailure = timeout('repair retry provider remained unavailable')
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => receiptPointers.get(workItemId),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'defect'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      if (request.workItemId === 'independent-check-1') {
        return persist(request.workItemId, {
          code: 'FAIL',
          cause: { event: 'ASSERTION_FAILED', reason: 'repair transport defect', unblockPath: 'repair' },
          payload: {
            findingIds: ['REPAIR-TRANSPORT'],
            testOutcomes: controllerBoundFailureOutcomes(request, 'REPAIR-TRANSPORT'),
          },
        })
      }
      if (request.workItemId === 'work-1-repair-1') return timeout('repair provider timeout')
      if (request.workItemId === 'work-1-repair-1-transport-retry-1') return successorFailure
      assert.fail(`unexpected third launch ${request.workItemId}`)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.code, 'FAIL')
  assert.equal(outcome.terminalEnvelope.cause.event, 'ASSERTION_FAILED')
  assert.deepEqual(outcome.deliverables.map(item => item.path), [
    path.join(target, 'src', 'example.js'),
  ])
  assert.deepEqual(launches, [
    'work-1', 'independent-check-1',
    'work-1-repair-1', 'work-1-repair-1-transport-retry-1',
  ])
})

test('crash after a durable worker transport timeout resumes only its one bounded contingency', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-worker-transport-resume-'))
  const baseId = 'work-1'
  const retryId = `${baseId}-transport-retry-1`
  const baseResult = {
    allAssignedItemsPass: false,
    filesChanged: [], commands: [], evidenceHashes: ['a'.repeat(64)],
    successItems: [{ id: 'provider-transport', status: 'fail', evidenceIds: ['transport:evidence'] }],
    findingIds: ['provider-transport'],
    terminalEnvelope: { status: 'CHILD_TRANSPORT_TIMEOUT', reason: 'bounded provider watchdog' },
  }
  const resultPath = path.join(path.dirname(target), 'work-1-timeout.json')
  fs.writeFileSync(resultPath, `${JSON.stringify(baseResult)}\n`)
  const bytes = fs.readFileSync(resultPath)
  const pointer = {
    name: baseId, path: resultPath, bytes: bytes.length,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    transition: async () => {},
    readResult: workItemId => workItemId === baseId ? baseResult : null,
    resultPointer: workItemId => { assert.equal(workItemId, baseId); return pointer },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, baseId)
      assert.equal(result, baseResult)
      return true
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.logicalRole === 'worker') {
        assert.equal(request.workItemId, retryId)
        assert.equal(request.executorKey, baseId)
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'transport-resumed'\n")
        return {
          allAssignedItemsPass: true, filesChanged: ['src/example.js'],
          commands: [{ command: 'focused check', exitCode: 0 }],
          successItems: [{ id: 'implemented', status: 'pass', evidenceIds: ['worker:evidence'] }],
        }
      }
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'RUN_WORK', completedWorkIds: [], completedCheckIds: [],
      nextReadyWorkIds: [retryId], candidateHash: null,
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [retryId, 'independent-check-1'])
})

test('CHECK_WORK recovery keeps a durable successful transport retry as the later repair context', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-transport-success-resume-'))
  const retryId = 'work-1-transport-retry-1'
  fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'retried-candidate'\n")
  const retryResult = {
    allAssignedItemsPass: true,
    filesChanged: ['src/example.js'],
    successItems: [{ id: 'implemented', status: 'pass', evidenceIds: ['retry:evidence'] }],
  }
  const durableResults = new Map([[retryId, retryResult]])
  const pointers = new Map()
  const persistResult = (workItemId, result) => {
    durableResults.set(workItemId, result)
    const resultPath = path.join(path.dirname(target), `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, {
      name: workItemId,
      path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    })
  }
  persistResult(retryId, retryResult)
  let checkerAttempt = 0
  const launches = []
  const executor = createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    transition: async () => {},
    readResult: workItemId => durableResults.get(workItemId) || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, retryId)
      assert.equal(result, retryResult)
      return true
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const outcome = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1-repair-1') {
        assert.equal(request.repairOf, retryId)
        assert.equal(request.executorKey, 'work-1')
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'repaired'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      checkerAttempt += 1
      if (checkerAttempt === 1) {
        const failure = {
          code: 'FAIL',
          cause: { event: 'ASSERTION_FAILED', reason: 'durable retry defect', unblockPath: 'repair' },
          payload: { findingIds: ['AP-TRANSPORT-REPAIR-001'] },
        }
        persistResult(request.workItemId, failure)
        return failure
      }
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK',
      candidateHash: testWorkspaceCandidateHash(target),
      completedWorkIds: [retryId],
      completedCheckIds: [],
      acceptedResultIds: [],
      nextReadyWorkIds: ['independent-check-1'],
      retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'independent-check-1', 'work-1-repair-1', 'independent-check-1-repair-1',
  ])
})

test('renaming the same semantic checker failure cannot buy another repair generation', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-progressive-checker-repair-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently reject each remaining defect, then verify the final candidate.'],
    nonOverlapReason: null,
  }
  const receiptPath = path.join(target, 'checker-fail-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const launches = []
  const repairRequests = []
  let repairAttempt = 0
  let checkerAttempt = 0
  const executor = createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    transition: async () => {},
    resultPointer: workItemId => ({
      name: workItemId,
      path: receiptPath,
      hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.logicalRole === 'worker') {
        if (/^work-1-repair-\d+$/u.test(request.workItemId)) {
          repairAttempt += 1
          repairRequests.push(request)
        }
        fs.writeFileSync(
          path.join(target, 'src', 'example.js'),
          `module.exports = 'candidate-${repairAttempt}'\n`,
        )
        return { allAssignedItemsPass: true }
      }
      checkerAttempt += 1
      if (checkerAttempt < 3) {
        return {
          code: 'FAIL',
          cause: {
            event: 'ASSERTION_FAILED',
            reason: `independent defect ${checkerAttempt}`,
            unblockPath: 'repair the implementation again',
          },
          payload: { findingIds: [`AP-REPAIR-${String(checkerAttempt).padStart(3, '0')}`] },
        }
      }
      return {
        code: 'PASS',
        payload: {
          evidenceIds: ['evidence:progressive-repair-pass'],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
  assert.equal(repairAttempt, 1)
  assert.deepEqual(repairRequests.map(request => ({
    repairOf: request.repairOf,
    executorKey: request.executorKey,
    forkTurns: request.forkTurns,
    receiptCount: request.fetchedEvidence.rejectedCheckerReceipts.length,
    receiptNames: request.fetchedEvidence.rejectedCheckerReceipts.map(item => item.name),
  })), [
    {
      repairOf: 'work-1', executorKey: 'work-1', forkTurns: undefined, receiptCount: 1,
      receiptNames: ['independent-check-1'],
    },
  ])
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
    'work-1-repair-1',
    'independent-check-1-repair-1',
  ])
})

test('a distinct post-repair failure returns the concrete candidate without authorizing repair two', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-novel-repair-progress-'))
  const receiptPath = path.join(target, 'checker-failure-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const routeDecision = structuredClone(decision('DIRECT'))
  const progressChecks = ['controller-obligation-A', 'controller-obligation-B']
  routeDecision.plannedChecks = progressChecks
  let repairAttempt = 0
  const launches = []
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => ({
      name: workItemId, path: receiptPath,
      hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const outcome = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.logicalRole === 'worker') {
        if (/^work-1-repair-\d+$/u.test(request.workItemId)) repairAttempt += 1
        fs.writeFileSync(path.join(target, 'src', 'example.js'),
          `module.exports = 'candidate-${repairAttempt}'\n`)
        return { allAssignedItemsPass: true }
      }
      if (repairAttempt < 2) {
        const failedCheckId = progressChecks[repairAttempt]
        return {
          code: 'FAIL',
          cause: { event: 'ASSERTION_FAILED', reason: failedCheckId, unblockPath: 'repair' },
          payload: {
            findingIds: [`AP-NOVEL-${repairAttempt + 1}`],
            testOutcomes: controllerBoundSelectiveFailureOutcomes(request, failedCheckId),
          },
        }
      }
      return { code: 'PASS', payload: {
        evidenceIds: ['evidence:novel-repair-pass'],
        referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.code, 'FAIL')
  assert.equal(outcome.terminalEnvelope.cause.reason, progressChecks[1])
  assert.equal(outcome.deliverables.some(item => item.path.endsWith('/src/example.js')), true)
  assert.equal(repairAttempt, 1)
  assert.deepEqual(launches.filter(id => /^work-1-repair-/u.test(id)), [
    'work-1-repair-1',
  ])
})

test('controller-assigned A-B failure succession returns the concrete post-repair FAIL', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-repair-cycle-'))
  const receiptPath = path.join(target, 'checker-failure-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const routeDecision = structuredClone(decision('DIRECT'))
  const progressChecks = ['controller-obligation-A', 'controller-obligation-B']
  routeDecision.plannedChecks = progressChecks
  let repairAttempt = 0
  let finalFailure = null
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => ({
      name: workItemId, path: receiptPath,
      hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const outcome = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      if (request.logicalRole === 'worker') {
        if (/^work-1-repair-\d+$/u.test(request.workItemId)) repairAttempt += 1
        fs.writeFileSync(path.join(target, 'src', 'example.js'),
          `module.exports = 'cycle-${repairAttempt}'\n`)
        return { allAssignedItemsPass: true }
      }
      const failedCheckId = repairAttempt === 1 ? progressChecks[1] : progressChecks[0]
      finalFailure = {
        code: 'FAIL',
        cause: { event: 'ASSERTION_FAILED', reason: failedCheckId, unblockPath: 'repair' },
        payload: {
          findingIds: [`AP-CYCLE-${repairAttempt + 1}`],
          testOutcomes: controllerBoundSelectiveFailureOutcomes(request, failedCheckId),
        },
      }
      return finalFailure
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope, finalFailure)
  assert.equal(outcome.terminalEnvelope.cause.reason, progressChecks[1])
  assert.equal(repairAttempt, 1)
})

test('REPAIRING resume launches the exact pending worker repair before any fresh checker', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-repair-resume-'))
  const retryId = 'work-1-transport-retry-1'
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently verify the repaired behavior.'],
    nonOverlapReason: null,
  }
  const receiptPath = path.join(target, 'checker-fail-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const receiptPointer = {
    name: 'independent-check-1', path: receiptPath,
    hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
    bytes: fs.statSync(receiptPath).size,
  }
  const checkerFailure = {
    code: 'FAIL',
    cause: { event: 'ASSERTION_FAILED', reason: 'resume repair defect', unblockPath: 'repair implementation' },
    payload: { findingIds: ['AP-RUN-026'] },
  }
  const retryResult = {
    allAssignedItemsPass: true,
    filesChanged: ['src/example.js'],
    successItems: [{ id: 'implemented', status: 'pass', evidenceIds: ['retry:evidence'] }],
  }
  const retryResultPath = path.join(target, 'transport-retry-result.json')
  fs.writeFileSync(retryResultPath, `${JSON.stringify(retryResult)}\n`)
  const retryPointer = {
    name: retryId, path: retryResultPath,
    hash: crypto.createHash('sha256').update(fs.readFileSync(retryResultPath)).digest('hex'),
    bytes: fs.statSync(retryResultPath).size,
  }
  let pending
  const firstExecutor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => {
      if (eventId === 'IMPLEMENTATION_DEFECT') {
        pending = details
        throw Object.assign(new Error('pause exactly before repair launch'), { code: 'PAUSE_AT_REPAIR' })
      }
    },
    resultPointer: () => receiptPointer,
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  await assert.rejects(firstExecutor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'rejected-before-resume'\n")
        return { allAssignedItemsPass: true }
      }
      return checkerFailure
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'PAUSE_AT_REPAIR')
  assert.deepEqual(pending.nextReadyWorkIds, ['work-1-repair-1'])

  const launches = []
  const resumedExecutor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => workItemId === retryId ? retryPointer : receiptPointer,
    readResult: workItemId => workItemId === 'independent-check-1'
      ? checkerFailure : workItemId === retryId ? retryResult : null,
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, retryId)
      assert.equal(result, retryResult)
      return true
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const durableRepairState = {
    resumeState: 'REPAIRING',
    candidateHash: pending.candidateHash,
    completedWorkIds: [retryId],
    completedCheckIds: [],
    retryState: {
      cumulativeRejectedCheckerReceipts: pending.rejectedCheckerReceipts,
      pendingImplementationRepair: {
        checkerId: pending.checkerId,
        checkerResultHash: pending.checkerResultHash,
        checkerReceiptPointer: pending.checkerReceiptPointer,
        rejectedCheckerReceipts: pending.rejectedCheckerReceipts,
        rejectedCandidateHash: pending.candidateHash,
        repairAttempt: pending.repairAttempt,
        repairWorkItemId: pending.repairWorkItemId,
      },
    },
  }
  for (const badNextReady of [[], ['bogus']]) {
    const invalidLaunches = []
    await assert.rejects(resumedExecutor({
      route: 'DIRECT', decision: routeDecision,
      launch: async request => { invalidLaunches.push(request.workItemId); return { code: 'PASS' } },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
      resumeState: { ...durableRepairState, nextReadyWorkIds: badNextReady },
    }), error => error.code === 'REPAIR_RECOVERY_INVALID')
    assert.deepEqual(invalidLaunches, [])
  }
  const result = await resumedExecutor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1-repair-1') {
        assert.equal(request.repairOf, retryId)
        assert.equal(request.executorKey, 'work-1')
        assert.equal(request.forkTurns, undefined)
        assert.equal(request.fetchedEvidence.rejectedCheckerReceipts.length, 1)
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'repaired-after-resume'\n")
        return { allAssignedItemsPass: true }
      }
      return {
        code: 'PASS',
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: { ...durableRepairState, nextReadyWorkIds: [pending.repairWorkItemId] },
  })
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(launches[0], 'work-1-repair-1')
  assert.equal(launches.filter(id => id === 'work-1-repair-1').length, 1)
  assert.equal(launches.includes('independent-check-1-repair-1'), true)
})

test('REPAIRING crash resume authenticates and launches only the queued repair transport successor', async t => {
  const directory = tempDirectory(t, 'autoprompt-repair-transport-resume-')
  const target = createTempGitTarget(directory)
  const routeDecision = decision('DIRECT')
  const results = new Map()
  const pointers = new Map()
  const persist = (workItemId, result) => {
    results.set(workItemId, result)
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, {
      name: workItemId, path: resultPath, bytes: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    })
    return result
  }
  let pending
  await assert.rejects(createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => {
      if (eventId === 'IMPLEMENTATION_DEFECT') {
        pending = details
        throw Object.assign(new Error('pause before repair provider launch'), {
          code: 'PAUSE_BEFORE_REPAIR_TRANSPORT',
        })
      }
    },
    resultPointer: workItemId => pointers.get(workItemId),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'),
          "module.exports = 'repair-transport-rejected'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      return persist(request.workItemId, {
        code: 'FAIL',
        cause: { event: 'ASSERTION_FAILED', reason: 'queued repair defect', unblockPath: 'repair' },
        payload: {
          findingIds: ['QUEUED-REPAIR-TRANSPORT'],
          testOutcomes: controllerBoundFailureOutcomes(request, 'QUEUED-REPAIR-TRANSPORT'),
        },
      })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'PAUSE_BEFORE_REPAIR_TRANSPORT')
  assert.ok(pending)

  const repairBaseId = pending.repairWorkItemId
  const repairRetryId = `${repairBaseId}-transport-retry-1`
  persist(repairBaseId, {
    allAssignedItemsPass: false, filesChanged: [], commands: [],
    successItems: [{ id: 'provider-transport', status: 'fail', evidenceIds: ['transport:repair'] }],
    findingIds: ['provider-transport'], evidenceHashes: ['a'.repeat(64)],
    terminalEnvelope: { status: 'CHILD_TRANSPORT_TIMEOUT', reason: 'durable repair timeout' },
  })
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => results.get(workItemId) || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, repairBaseId)
      assert.equal(result, results.get(repairBaseId))
      return true
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === repairRetryId) {
        assert.equal(request.executorKey, 'work-1')
        fs.writeFileSync(path.join(target, 'src', 'example.js'),
          "module.exports = 'queued-repair-transport-resumed'\n")
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'REPAIRING', candidateHash: pending.candidateHash,
      completedWorkIds: ['work-1'], completedCheckIds: [], acceptedResultIds: [],
      nextReadyWorkIds: [repairRetryId],
      retryState: {
        cumulativeRejectedCheckerReceipts: pending.rejectedCheckerReceipts,
        repairFailureFingerprintChain: pending.repairFailureFingerprintChain,
        pendingImplementationRepair: {
          checkerId: pending.checkerId,
          checkerResultHash: pending.checkerResultHash,
          checkerReceiptPointer: pending.checkerReceiptPointer,
          rejectedCheckerReceipts: pending.rejectedCheckerReceipts,
          rejectedCandidateHash: pending.candidateHash,
          repairAttempt: pending.repairAttempt,
          repairWorkItemId: pending.repairWorkItemId,
          repairFailureFingerprint: pending.repairFailureFingerprint,
          repairFailureFingerprints: pending.repairFailureFingerprints,
          repairFailureFingerprintChain: pending.repairFailureFingerprintChain,
        },
      },
    },
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [repairRetryId, 'independent-check-1-repair-1'])
})

test('REPAIRING crash resume rejects a legacy second repair as the bound product failure', async t => {
  const directory = tempDirectory(t, 'autoprompt-cumulative-repair-resume-')
  const target = createTempGitTarget(directory)
  fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'repair-one-rejected'\n")
  const candidateHash = testWorkspaceCandidateHash(target)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1,
    responsibilities: ['Independently verify the cumulative repair.'],
    nonOverlapReason: null,
  }
  const results = {
    'independent-check-1': {
      code: 'FAIL', cause: { event: 'ASSERTION_FAILED', reason: 'first defect', unblockPath: 'repair' },
      payload: { findingIds: ['AP-RUN-026'] },
    },
    'independent-check-1-repair-1': {
      code: 'FAIL', cause: { event: 'ASSERTION_FAILED', reason: 'second defect', unblockPath: 'repair' },
      payload: { findingIds: ['AP-RUN-027'] },
    },
  }
  const pointers = new Map()
  const ledger = []
  for (const [workItemId, result] of Object.entries(results)) {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    const pointer = {
      name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    }
    pointers.set(workItemId, pointer)
    ledger.push({
      ...pointer,
      resultHash: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    })
  }
  const latest = ledger[1]
  const launches = []
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => results[workItemId] || null,
    resultPointer: workItemId => pointers.get(workItemId),
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const outcome = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      return {
        code: 'PASS', payload: {
          evidenceIds: [`evidence:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'REPAIRING', candidateHash,
      completedWorkIds: ['work-1', 'work-1-repair-1'], completedCheckIds: [],
      acceptedResultIds: [], nextReadyWorkIds: ['work-1-repair-2'],
      retryState: {
        cumulativeRejectedCheckerReceipts: ledger,
        pendingImplementationRepair: {
          checkerId: latest.name,
          checkerResultHash: latest.resultHash,
          checkerReceiptPointer: pointers.get(latest.name),
          rejectedCheckerReceipts: ledger,
          rejectedCandidateHash: candidateHash,
          repairAttempt: 2,
          repairWorkItemId: 'work-1-repair-2',
        },
      },
    },
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.code, 'FAIL')
  assert.deepEqual(outcome.terminalEnvelope.payload.findingIds, ['AP-RUN-027'])
  assert.deepEqual(launches, [])
})

test('REPAIR_READY recovery invalidates prior-version checker seats and launches repaired checker one', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-repair-ready-resume-'))
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired-version'\n")
  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Recheck requirements after repair.', 'Recheck boundaries after repair.'],
    nonOverlapReason: 'The repaired version needs distinct requirements and boundary evidence.',
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: () => null,
    resultPointer: () => { throw new Error('fresh repaired checker must not read an old result') },
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      assert.match(request.workItemId, /^independent-check-[12]-repair-1$/u)
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod(
          request.workItemId.includes('check-1') ? 'requirements-review' : 'black-box-boundary',
          request.workItemId,
        ),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1', 'work-1-repair-1'],
      completedCheckIds: ['independent-check-1', 'independent-check-2'],
      acceptedResultIds: [], nextReadyWorkIds: ['independent-check-1-repair-1'], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'independent-check-1-repair-1', 'independent-check-2-repair-1',
  ])
})

test('repair recurrence chain survives a REPAIR_READY crash and stops the same observation', async t => {
  const directory = tempDirectory(t, 'autoprompt-repair-recurrence-resume-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = decision('DIRECT')
  const results = new Map()
  const pointers = new Map()
  const persistResult = (workItemId, result) => {
    results.set(workItemId, result)
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, {
      name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    })
  }
  let defectTransition
  let readyTransition
  const firstExecutor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => {
      if (eventId === 'IMPLEMENTATION_DEFECT') defectTransition = details
      if (eventId === 'REPAIR_READY') {
        readyTransition = details
        throw Object.assign(new Error('pause after durable repaired-version freeze'), {
          code: 'PAUSE_AFTER_REPAIR_READY',
        })
      }
    },
    readResult: workItemId => results.get(workItemId) || null,
    resultPointer: workItemId => pointers.get(workItemId),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  await assert.rejects(firstExecutor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'),
          request.workItemId === 'work-1'
            ? "module.exports = 'rejected'\n" : "module.exports = 'toggled'\n")
        const result = { allAssignedItemsPass: true }
        results.set(request.workItemId, result)
        return result
      }
      const result = {
        code: 'FAIL', currentVersionHash: request.candidateHash,
        cause: { event: 'ASSERTION_FAILED', reason: 'same resumed observation', unblockPath: 'repair' },
        payload: {
          findingIds: ['AP-RESUME-001'],
          testOutcomes: controllerBoundFailureOutcomes(request, 'resume-failure-A'),
        },
      }
      persistResult(request.workItemId, result)
      return result
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'PAUSE_AFTER_REPAIR_READY')
  assert.ok(defectTransition)
  assert.ok(readyTransition)

  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const recurrentId = 'independent-check-1-repair-1'
  const recurrentRequest = {
    workItemId: recurrentId,
    candidateHash,
    checks: checkerSeatChecks(routeDecision, 0),
  }
  const recurrentResult = {
    code: 'FAIL', candidateHash, currentVersionHash: candidateHash,
    cause: { event: 'ASSERTION_FAILED', reason: 'same resumed observation', unblockPath: 'repair' },
    payload: {
      findingIds: ['AP-RESUME-001'],
      testOutcomes: controllerBoundFailureOutcomes(recurrentRequest, 'resume-failure-A'),
    },
  }
  persistResult(recurrentId, recurrentResult)
  const resumeLaunches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => results.get(workItemId) || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: () => true,
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      resumeLaunches.push(request.workItemId)
      assert.fail(`recurring durable failure must not launch ${request.workItemId}`)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1', 'work-1-repair-1'],
      completedCheckIds: [recurrentId], acceptedResultIds: [], nextReadyWorkIds: [],
      retryState: {
        cumulativeRejectedCheckerReceipts: defectTransition.rejectedCheckerReceipts,
        repairFailureFingerprintChain: readyTransition.repairFailureFingerprintChain,
      },
    },
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.code, 'FAIL')
  assert.equal(outcome.terminalEnvelope.cause.reason, 'same resumed observation')
  assert.deepEqual(resumeLaunches, [])
})

test('changing failures across 55 obligations stop after one aggregate repair and return the candidate', async t => {
  const directory = tempDirectory(t, 'autoprompt-bounded-repair-history-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = structuredClone(decision('DIRECT'))
  const progressChecks = Array.from({ length: 55 }, (_, index) =>
    `controller-check-${String(index + 1).padStart(2, '0')}`)
  routeDecision.plannedChecks = progressChecks
  const pointers = new Map()
  const visibleContextBytes = { worker: [], checker: [] }
  const persistFailure = (workItemId, result) => {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, {
      name: workItemId, path: resultPath, bytes: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    })
    return result
  }
  const inspectBoundedHistory = request => {
    const receipts = request.fetchedEvidence && request.fetchedEvidence.rejectedCheckerReceipts
    if (!receipts) return
    assert.equal(receipts.length, 1)
    assert.equal((request.evidencePointers || []).length,
      request.logicalRole === 'worker' ? 0 : 1)
    const history = request.fetchedEvidence.repairHistory
    assert.ok(history)
    assert.equal(history.currentGenerationReceiptCount, 1)
    assert.equal(history.rejectedGenerationCount, history.rejectedReceiptCount)
    assert.match(history.historyDigest, /^[a-f0-9]{64}$/u)
    visibleContextBytes[request.logicalRole === 'worker' ? 'worker' : 'checker'].push(
      Buffer.byteLength(JSON.stringify({
      fetchedEvidence: request.fetchedEvidence,
      evidencePointers: request.evidencePointers,
      evidenceHashes: request.evidenceHashes,
      }), 'utf8'),
    )
  }
  let failuresReturned = 0
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => pointers.get(workItemId),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      inspectBoundedHistory(request)
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'),
          `module.exports = '${request.workItemId}'\n`)
        return { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      }
      if (failuresReturned < 2) {
        const failedCheckId = progressChecks[failuresReturned]
        failuresReturned += 1
        return persistFailure(request.workItemId, {
          code: 'FAIL', currentVersionHash: request.candidateHash,
          cause: {
            event: 'ASSERTION_FAILED', reason: `novel defect ${failuresReturned}`,
            unblockPath: 'repair the current exact version',
          },
          payload: {
            findingIds: [`NOVEL-${failuresReturned}`],
            testOutcomes: controllerBoundSelectiveFailureOutcomes(request, failedCheckId),
          },
        })
      }
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: ['evidence:bounded-history-pass'],
          referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.code, 'FAIL')
  assert.equal(outcome.terminalEnvelope.cause.reason, 'novel defect 2')
  assert.equal(failuresReturned, 2)
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
    'work-1-repair-1',
    'independent-check-1-repair-1',
  ])
  assert.equal(visibleContextBytes.worker.length, 1)
  assert.equal(visibleContextBytes.checker.length, 1)
  assert.equal(outcome.deliverables.some(item => item.path.endsWith('/src/example.js')), true)
  for (const contextSizes of Object.values(visibleContextBytes)) {
    assert.ok(Math.max(...contextSizes) < 16 * 1024)
  }
})

test('post-repair checker-one PASS recovery consumes it and launches only repaired checker two', async t => {
  const directory = tempDirectory(t, 'autoprompt-repair-checker-two-resume-')
  const targetPath = createTempGitTarget(directory)
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired-version'\n")
  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Recheck requirements after repair.', 'Recheck boundaries after repair.'],
    nonOverlapReason: 'The repaired version needs distinct requirements and boundary evidence.',
  }
  const completedId = 'independent-check-1-repair-1'
  const completedChecks = checkerSeatChecks(routeDecision, 0)
  const completedResult = { code: 'PASS', currentVersionHash: candidateHash, payload: {
    evidenceIds: ['evidence:repaired-checker-one'],
    referenceMethod: checkerReferenceMethod('requirements-review', completedId),
    testOutcomes: completedChecks.map(command => ({
      command, status: 'PASS',
      fingerprint: crypto.createHash('sha256').update(`repair-one:${command}`).digest('hex'),
    })),
  } }
  const resultPath = path.join(directory, `${completedId}.json`)
  fs.writeFileSync(resultPath, `${JSON.stringify(completedResult)}\n`)
  const bytes = fs.readFileSync(resultPath)
  const pointer = { name: completedId, path: resultPath,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => workItemId === completedId ? completedResult : null,
    resultPointer: workItemId => { assert.equal(workItemId, completedId); return pointer },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, completedId); assert.equal(result, completedResult); return true
    },
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      assert.equal(request.workItemId, 'independent-check-2-repair-1')
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1', 'work-1-repair-1'], completedCheckIds: [completedId],
      acceptedResultIds: [], nextReadyWorkIds: ['independent-check-2-repair-1'], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, ['independent-check-2-repair-1'])
})

test('controller-invalid repaired PASS returns the usable candidate without a fresh correction launch', async t => {
  const directory = tempDirectory(t, 'autoprompt-repair-invalid-final-pass-')
  const targetPath = createTempGitTarget(directory)
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired-invalid'\n")
  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 1, responsibilities: ['Validate the repaired result.'], nonOverlapReason: null,
  }
  const completedId = 'independent-check-1-repair-1'
  const completedResult = {
    code: 'PASS', currentVersionHash: candidateHash,
    payload: { evidenceIds: ['evidence:invalid-repaired-pass'] },
  }
  const resultPath = path.join(directory, `${completedId}.json`)
  fs.writeFileSync(resultPath, `${JSON.stringify(completedResult)}\n`)
  const bytes = fs.readFileSync(resultPath)
  const pointer = { name: completedId, path: resultPath,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => workItemId === completedId ? completedResult : null,
    resultPointer: workItemId => ({ ...pointer, name: workItemId }),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, completedId); assert.equal(result, completedResult); return true
    },
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === `${completedId}-runtime-retry-1`) {
        return { code: 'FAIL', payload: { findingIds: ['AP-RUN-026'] },
          cause: { event: 'ASSERTION_FAILED', reason: 'repaired version still fails', unblockPath: 'repair again' } }
      }
      assert.fail(`unexpected launch after persistent repaired-version failure: ${request.workItemId}`)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1', 'work-1-repair-1'], completedCheckIds: [completedId],
      acceptedResultIds: [], nextReadyWorkIds: [], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(outcome.terminalEnvelope.controllerReason, 'TEST_OUTCOMES_INVALID')
  assert.deepEqual(launches, [])
})

test('completed repaired checker group rejects every contradictory nonempty recovery continuation', async t => {
  for (const nextReadyWorkIds of [['bogus'], ['independent-check-1-repair-1'], ['work-1-repair-2']]) {
    const directory = tempDirectory(t, 'autoprompt-completed-repair-frontier-')
    const targetPath = createTempGitTarget(directory)
    fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired-valid'\n")
    const candidateHash = testWorkspaceCandidateHash(targetPath)
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.independentCheckingPlan = {
      checkerCount: 1, responsibilities: ['Validate the repaired result.'], nonOverlapReason: null,
    }
    const completedId = 'independent-check-1-repair-1'
    const completedChecks = checkerSeatChecks(routeDecision, 0)
    const completedResult = { code: 'PASS', currentVersionHash: candidateHash, payload: {
      evidenceIds: ['evidence:valid-repaired-pass'],
      referenceMethod: checkerReferenceMethod('requirements-review', completedId),
      testOutcomes: completedChecks.map(command => ({
        command, status: 'PASS',
        fingerprint: crypto.createHash('sha256').update(`valid-repair:${command}`).digest('hex'),
      })),
    } }
    const resultPath = path.join(directory, `${completedId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(completedResult)}\n`)
    const bytes = fs.readFileSync(resultPath)
    const pointer = { name: completedId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    const launches = []
    const execution = createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env, transition: async () => {},
      readResult: workItemId => workItemId === completedId ? completedResult : null,
      resultPointer: workItemId => { assert.equal(workItemId, completedId); return pointer },
      verifyDurableResultReceipt: () => true,
      harnessAttestation: (versionHash, oracle) => ({
        repoHash: versionHash, buildHash: 'b'.repeat(64),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })({
      route: 'DIRECT', decision: routeDecision,
      launch: async request => { launches.push(request.workItemId); return { code: 'PASS' } },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
      resumeState: {
        resumeState: 'CHECK_WORK', candidateHash,
        completedWorkIds: ['work-1', 'work-1-repair-1'], completedCheckIds: [completedId],
        acceptedResultIds: [], nextReadyWorkIds, retryState: {},
      },
    })
    await assert.rejects(execution, error => error.code === 'CHECK_RETRY_STATE_INVALID')
    assert.deepEqual(launches, [])
  }
})

test('repaired checker retry PASS preserves the seat, then a later defect terminates the bounded repair', async t => {
  const directory = tempDirectory(t, 'autoprompt-repaired-retry-seat-')
  const targetPath = createTempGitTarget(directory)
  fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repaired-retry'\n")
  const candidateHash = testWorkspaceCandidateHash(targetPath)
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Validate repaired requirements.', 'Validate repaired boundaries.'],
    nonOverlapReason: 'The repaired version needs distinct requirement and boundary evidence.',
  }
  const baseId = 'independent-check-1-repair-1'
  const retryId = `${baseId}-runtime-retry-1`
  const baseResult = { code: 'PASS', currentVersionHash: candidateHash,
    payload: { evidenceIds: ['evidence:controller-invalid-base'] } }
  const completedChecks = checkerSeatChecks(routeDecision, 0)
  const retryResult = { code: 'PASS', currentVersionHash: candidateHash, payload: {
    evidenceIds: ['evidence:repaired-retry-pass'],
    referenceMethod: checkerReferenceMethod('requirements-review', retryId),
    testOutcomes: completedChecks.map(command => ({
      command, status: 'PASS', fingerprint: crypto.createHash('sha256')
        .update(`repaired-retry:${command}`).digest('hex'),
    })),
  } }
  const records = { [baseId]: baseResult, [retryId]: retryResult }
  const pointers = new Map()
  for (const [workItemId, result] of Object.entries(records)) {
    const resultPath = path.join(directory, `${workItemId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`)
    const bytes = fs.readFileSync(resultPath)
    pointers.set(workItemId, { name: workItemId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  const launches = []
  const transitions = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env,
    transition: async (eventId, state, details) => transitions.push({ eventId, state, details }),
    readResult: workItemId => records[workItemId] || null,
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: () => true,
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'independent-check-2-repair-1') {
        const failure = { code: 'FAIL', payload: { findingIds: ['AP-RUN-026'] },
          cause: { event: 'ASSERTION_FAILED', reason: 'repaired boundary still fails', unblockPath: 'repair again' } }
        records[request.workItemId] = failure
        const resultPath = path.join(directory, `${request.workItemId}.json`)
        fs.writeFileSync(resultPath, `${JSON.stringify(failure)}\n`)
        const bytes = fs.readFileSync(resultPath)
        pointers.set(request.workItemId, {
          name: request.workItemId, path: resultPath,
          hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
        })
        return failure
      }
      const second = request.workItemId.includes('check-2')
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod(second ? 'black-box-boundary' : 'requirements-review', request.workItemId),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE', candidateHash,
      completedWorkIds: ['work-1', 'work-1-repair-1'], completedCheckIds: [retryId],
      acceptedResultIds: [], nextReadyWorkIds: ['independent-check-2-repair-1'],
      retryState: { inconclusiveChecker: {
        checkerId: baseId, candidateHash,
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'CHECK_WORK',
      } },
    },
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.code, 'FAIL')
  assert.deepEqual(launches, ['independent-check-2-repair-1'])
  assert.deepEqual(transitions.filter(item => item.eventId === 'CHECK_BECAME_CONCLUSIVE')[0]
    .details.nextReadyWorkIds, ['independent-check-2-repair-1'])
})

test('the same named failure with volatile output and an unrelated edit stops after one repair', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-repair-bound-'))
  const receiptPath = path.join(target, 'checker-fail-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  let checkerLaunches = 0
  let repairLaunches = 0
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    resultPointer: workItemId => ({
      name: workItemId, path: receiptPath,
      hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      if (request.logicalRole === 'worker') {
        if (/^work-1-repair-\d+$/u.test(request.workItemId)) repairLaunches += 1
        fs.writeFileSync(path.join(target, 'src', 'example.js'),
          `module.exports = 'still-rejected-${repairLaunches}'\n`)
        return { allAssignedItemsPass: true }
      }
      if (['independent-reviewer', 'independent-tester'].includes(request.logicalRole)) {
        checkerLaunches += 1
        return {
          code: 'FAIL',
          cause: { event: 'ASSERTION_FAILED', reason: 'same exact defect remains', unblockPath: 'manual intervention' },
          payload: {
            findingIds: ['AP-RUN-026'],
            testOutcomes: controllerBoundFailureOutcomes(
              request,
              'same-named-case',
              `observed=${new Date(1_700_000_000_000 + checkerLaunches).toISOString()} ` +
                `temp=/tmp/check-${checkerLaunches} random=run-${checkerLaunches}`,
            ),
          },
        }
      }
      return { code: 'PASS', payload: {} }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'FAILED')
  assert.equal(result.terminalEnvelope.code, 'FAIL')
  assert.equal(repairLaunches, 1)
  assert.equal(checkerLaunches, 2)
})

test('one-worker ROADMAP returns the usable candidate after first non-authoritative checker evidence', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-run-global-checker-correction-')
  const target = createTempGitTarget(directory)
  const routeDecision = decision('ROADMAP')
  const planPath = path.join(directory, 'ROADMAP.md')
  const launches = []
  const results = new Map()
  let repairLaunches = 0
  const executor = createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    transition: async () => {},
    writePlan: (route, decisionValue, authorResult) => {
      fs.writeFileSync(planPath, renderPlanArtifact(route, decisionValue, authorResult))
    },
    planExists: () => fs.existsSync(planPath),
    planPointer: () => {
      const bytes = fs.readFileSync(planPath)
      return {
        path: planPath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      }
    },
    readResult: workItemId => results.get(workItemId) || null,
    resultPointer: workItemId => {
      const result = results.get(workItemId)
      assert.ok(result, `missing result for ${workItemId}`)
      const bytes = Buffer.from(JSON.stringify(result))
      const resultPath = path.join(directory, `${workItemId}.json`)
      fs.writeFileSync(resultPath, bytes)
      return {
        name: workItemId,
        path: resultPath,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      }
    },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const outcome = await executor({
    route: 'ROADMAP',
    decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      let result
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'candidate'\n")
        result = { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      } else if (request.workItemId === 'independent-check-1') {
        result = {
          code: 'CHECK_INCONCLUSIVE', candidateHash: request.candidateHash,
          currentVersionHash: request.candidateHash,
          cause: { event: 'CHECK_RUNTIME_UNAVAILABLE', reason: 'first report was incomplete' },
          payload: {},
        }
      } else if (request.workItemId === 'independent-check-1-runtime-retry-1') {
        result = {
          code: 'FAIL', candidateHash: request.candidateHash,
          currentVersionHash: request.candidateHash,
          cause: {
            event: 'ASSERTION_FAILED', reason: 'the corrected report found a product defect',
            unblockPath: 'repair the implementation once',
          },
          payload: { findingIds: ['AP-RUN-026'] },
        }
      } else if (request.workItemId === 'work-1-repair-1') {
        repairLaunches += 1
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'repaired'\n")
        result = { allAssignedItemsPass: true, filesChanged: ['src/example.js'] }
      } else if (request.workItemId === 'independent-check-1-repair-1') {
        result = {
          code: 'CHECK_INCONCLUSIVE', candidateHash: request.candidateHash,
          currentVersionHash: request.candidateHash,
          cause: { event: 'CHECK_RUNTIME_UNAVAILABLE', reason: 'recheck report was incomplete' },
          payload: {},
        }
      } else if (request.workItemId === 'independent-check-1-repair-1-runtime-retry-1') {
        result = {
          code: 'PASS', candidateHash: request.candidateHash,
          currentVersionHash: request.candidateHash,
          payload: {
            evidenceIds: ['evidence:repaired-candidate-corrected-report'],
            referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
            testOutcomes: checkerTestOutcomes(request),
          },
        }
      } else {
        assert.fail(`unexpected launch ${request.workItemId}`)
      }
      results.set(request.workItemId, result)
      return result
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(outcome.terminalEnvelope.controllerReason, 'CHECK_RUNTIME_UNAVAILABLE')
  assert.equal(repairLaunches, 0)
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
  ])
  assert.equal(launches.some(workItemId =>
    /^(?:roadmap-(?:author|scout|plan-|work-group)|mission-coordination)/u.test(workItemId)), false)
  assert.equal(launches.some(workItemId => workItemId.includes('runtime-retry')), false)
  assert.equal(launches.length, 2)
})

test('a no-op checker repair fails directly without stale recheck or a second repair', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-repair-no-progress-'))
  const harnessPath = path.join(target, 'focused.test.cjs')
  fs.writeFileSync(harnessPath, "'use strict'\n")
  const receiptPath = path.join(target, 'checker-fail-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  const runId = 'run-controller-bound-aggregate-failure'
  const routeDecision = decision('DIRECT')
  routeDecision.plannedChecks = [
    'controller-bound failing check',
    'extra unbound failing claim',
  ]
  const cleanupEntries = []
  const cleanupRegistry = {
    register(entry) { cleanupEntries.push({ ...entry, status: 'REGISTERED' }) },
    load() { return { entries: cleanupEntries.map(entry => ({ ...entry })) } },
  }
  const scratchFactory = createCheckerScratchFactory({
    scratchRoot: path.join(path.dirname(target), 'checker-scratch'),
    cleanupRegistry,
    runId,
    targetPath: target,
  })
  let checkerLaunches = 0
  let repairLaunches = 0
  const launchedWorkIds = []
  let authoritativeFailure = null
  let checkerCheckIds = []
  const transitions = []
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env,
    transition: async (eventId, nextState) => transitions.push([eventId, nextState]),
    resultPointer: workItemId => ({
      name: workItemId, path: receiptPath,
      hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
      bytes: fs.statSync(receiptPath).size,
    }),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const result = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => {
      launchedWorkIds.push(request.workItemId)
      if (request.logicalRole === 'worker') {
        if (/^work-1-repair-\d+$/u.test(request.workItemId)) repairLaunches += 1
        else fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'rejected'\n")
        return { allAssignedItemsPass: true }
      }
      checkerLaunches += 1
      checkerCheckIds = [...request.checks]
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(harnessPath)}`
      const observationBinding = createCheckerObservationBinding({
        assignmentId: request.workItemId,
        candidateHash: request.candidateHash,
        requestEnvelopeHash: routeDecision.requestEnvelopeHash,
        checkIds: request.checks,
        commandBindings: request.checks.map((checkId, index) => ({
          checkId,
          command: index === 0 ? command : `${command} --never-emitted-${index}`,
        })),
      })
      const checkerOutput = {
        schemaVersion: '2.0.0',
        code: 'PASS',
        description: 'The checked result satisfies every requirement assigned to this check.',
        stateClass: 'terminal',
        runId,
        requestEnvelopeHash: routeDecision.requestEnvelopeHash,
        currentVersionHash: request.candidateHash,
        completedResults: [],
        nextReadyWork: [],
        cause: { event: 'CHECK_COMPLETE', reason: 'mistaken aggregate', unblockPath: null },
        payloadSchemaId: 'autoprompt.check.aggregate-contradiction.v2',
        payload: {
          testOutcomes: request.checks.map(checkId => ({ checkId, status: 'FAIL' })),
        },
        recordedAt: new Date().toISOString(),
      }
      const checkerScratchBoundary = scratchFactory(
        request.workItemId,
        target,
        { candidateHash: request.candidateHash, adoptedScratchRoots: [] },
      )
      const adapter = new CodexExecAdapter({
        runner: {
          async run(spec) {
            spec.onStdoutLine(JSON.stringify({
              type: 'thread.started', thread_id: 'thread-bound-aggregate-failure',
            }))
            spec.onStdoutLine(JSON.stringify({
              type: 'item.started',
              item: {
                id: 'command-bound-aggregate-failure',
                type: 'command_execution',
                command,
                status: 'in_progress',
              },
            }))
            spec.onStdoutLine(JSON.stringify({
              type: 'item.completed',
              item: {
                id: 'command-bound-aggregate-failure',
                type: 'command_execution',
                command,
                status: 'failed',
                exit_code: 1,
                aggregated_output: 'TAP version 13\nnot ok 1 - exact candidate defect\n# fail 1',
              },
            }))
            spec.onStdoutLine(JSON.stringify({
              type: 'item.completed',
              item: { type: 'agent_message', text: JSON.stringify(checkerOutput) },
            }))
            spec.onStdoutLine(JSON.stringify({
              type: 'turn.completed',
              usage: {
                input_tokens: 1, cached_input_tokens: 0,
                output_tokens: 1, reasoning_output_tokens: 0,
              },
            }))
            return {
              status: 0, stdout: '', stderr: '', processOwned: true,
              exactArgv: true, drained: true,
            }
          },
          async stop() { return { drained: true } },
        },
        targetPath: target,
        profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
        outputSchemaResolver: () => path.join(
          ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json',
        ),
        checkerScratchVerifier: scratchFactory.verify,
      })
      const checkerExecutionPolicy = {
        logicalRole: request.logicalRole,
        physicalRole: `autoprompt.v2.${request.logicalRole}`,
        providerRole: 'ap-independent-checker',
        sandboxMode: 'read-only',
        canDispatch: false,
        resourceSets: { read: ['target.snapshot.read'], write: [], exclusive: [] },
        policyId: 'autoprompt.codex.role-policy',
        policyVersion: '2.0.0',
      }
      authoritativeFailure = await adapter.launch({
        ...checkerExecutionPolicy,
        physicalExecutionPolicy: checkerExecutionPolicy,
        runId,
        candidateHash: request.candidateHash,
        purpose: 'check',
        ...adapterMissionFields(
          routeDecision.requestEnvelopeHash,
          request.workItemId,
          'Independently check the exact result.',
        ),
        canonicalAssignment: {
          assignmentId: request.workItemId,
          requestEnvelopeHash: routeDecision.requestEnvelopeHash,
          checks: request.checks,
          verificationObservationBinding: observationBinding,
        },
        dispatch: {
          brief: 'Execute the controller-bound checker.',
          requestPointer: { path: 'request', hash: routeDecision.requestEnvelopeHash },
        },
        environment: {},
        sessionId: 'session-bound-aggregate-failure',
        reservationId: 'reservation-bound-aggregate-failure',
        workingDirectory: checkerScratchBoundary.writableScratchRoot,
        canonicalTargetPath: target,
        checkerScratchBoundary,
        sandboxAssignment: { checkerId: request.workItemId },
      })
      assert.equal(authoritativeFailure.code, 'FAIL', JSON.stringify(authoritativeFailure))
      return authoritativeFailure
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'FAILED', JSON.stringify({ result, launchedWorkIds, transitions }))
  assert.equal(result.terminalEnvelope.code, 'FAIL')
  assert.equal(authoritativeFailure.code, 'FAIL')
  assert.equal(authoritativeFailure.cause.event, 'ASSERTION_FAILED')
  assert.equal(
    authoritativeFailure.payload.verificationObservationDisposition.reportedAggregateCode,
    'PASS',
  )
  assert.deepEqual(
    authoritativeFailure.payload.verificationObservationDisposition.commandBoundFailureCheckIds,
    [checkerCheckIds[0]],
  )
  assert.deepEqual(
    authoritativeFailure.payload.verificationObservationDisposition.unboundFailureCheckIds,
    checkerCheckIds.slice(1),
  )
  assert.equal(result.terminalEnvelope.cause.reason,
    authoritativeFailure.cause.reason,
    'a no-op repair preserves the exact authenticated failure')
  assert.equal(repairLaunches, 1)
  assert.equal(checkerLaunches, 1)
  assert.equal(launchedWorkIds.some(id => id.includes('runtime-retry')), false)
  assert.deepEqual(transitions.filter(([event]) => ['IMPLEMENTATION_DEFECT', 'REPAIR_READY'].includes(event)), [
    ['IMPLEMENTATION_DEFECT', 'REPAIRING'],
  ])
})

test('first inconclusive checker evidence returns the usable candidate with one checker launch and no repair', async t => {
  for (const code of ['CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE']) {
    const target = createTempGitTarget(tempDirectory(t, `autoprompt-checker-${code.toLowerCase()}-`))
    const receiptPath = path.join(target, 'checker-inconclusive-receipt.json')
    fs.writeFileSync(receiptPath, '{}\n')
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.independentCheckingPlan = {
      checkerCount: 1,
      responsibilities: ['Independently resolve the exact verification obligation.'],
      nonOverlapReason: null,
    }
    let repairLaunches = 0
    let checkerLaunches = 0
    const workItemIds = []
    const checkerTransitions = []
    const executor = createDefaultRouteExecutor({
      targetPath: target, gitEnvironment: () => process.env,
      transition: async (event, state) => { checkerTransitions.push([event, state]) },
      resultPointer: workItemId => ({
        name: workItemId,
        path: receiptPath,
        hash: crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
        bytes: fs.statSync(receiptPath).size,
      }),
      harnessAttestation: (candidateHash, oracle) => ({
        repoHash: candidateHash, buildHash: 'b'.repeat(64),
        oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
      }),
    })
    const result = await executor({
      route: 'DIRECT', decision: routeDecision,
      launch: async request => {
        workItemIds.push(request.workItemId)
        if (request.logicalRole === 'worker') {
          if (/^work-1-repair-\d+$/u.test(request.workItemId)) repairLaunches += 1
          fs.writeFileSync(path.join(target, 'src', 'example.js'),
            `module.exports = '${code}-${repairLaunches}'\n`)
          return { allAssignedItemsPass: true }
        }
        checkerLaunches += 1
        assert.match(request.assignment,
          /(?:<python3\|node\|ruby\|perl\|sh> <absolute sealed scratch program>|<absolute sealed executable>) <absolute frozen exact-version path being checked>/u)
        assert.match(request.assignment, /one direct JSON summary of at most 4 KiB/u)
        assert.doesNotMatch(request.assignment, /redirect large stdout\/stderr/u)
        return {
          code,
          cause: { event: code, reason: 'the independent check did not complete conclusively', unblockPath: 'repair implementation' },
          payload: {},
        }
      },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
    })
    assert.equal(result.outcome, 'DONE', JSON.stringify(result))
    assert.equal(result.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
    assert.equal(repairLaunches, 0)
    assert.equal(checkerLaunches, 1)
    assert.equal(workItemIds.some(id => id.includes('runtime-retry-1')), false)
    assert.deepEqual(workItemIds.filter(id => /^work-/u.test(id)), ['work-1'])
    assert.deepEqual(checkerTransitions.filter(([event]) => [
      'CHECK_BECAME_CONCLUSIVE', 'IMPLEMENTATION_DEFECT', 'REPAIR_READY',
    ].includes(event)), [
      ['CHECK_BECAME_CONCLUSIVE', 'CHECK_WORK'],
    ])
    assert.deepEqual(checkerTransitions.filter(([event]) => [
      'CHECK_INCONCLUSIVE', 'CHECK_REMAINS_INCONCLUSIVE',
    ].includes(event)), [
      ['CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE'],
    ])
  }
})

test('both checker seats receive one same-version attempt without fresh same-seat correction', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-per-checker-retry-'))
  const transitions = []
  const checkerLaunches = []
  const attempts = new Map()
  const twoCheckerDecision = withExactTwoCheckerPlan(decision('DIRECT'))
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env,
    transition: async (event, state, details) => { transitions.push([event, state, details]) },
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const outcome = await executor({
    route: 'DIRECT', decision: twoCheckerDecision,
    launch: async request => {
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'per-checker-retry'\n")
        return { allAssignedItemsPass: true }
      }
      checkerLaunches.push(request.workItemId)
      const canonicalId = request.workItemId.replace(/-runtime-retry-\d+$/u, '')
      const attempt = (attempts.get(canonicalId) || 0) + 1
      attempts.set(canonicalId, attempt)
      if (attempt === 1) {
        return {
          code: 'CHECK_INCONCLUSIVE', currentVersionHash: request.candidateHash,
          cause: { reason: 'one transient isolated runtime failure', unblockPath: 'retry once' },
          payload: {},
        }
      }
      return {
        code: 'PASS', currentVersionHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:${canonicalId}`],
          referenceMethod: checkerReferenceMethod(
            canonicalId.endsWith('-1') ? 'requirements-review' : 'black-box-boundary',
            canonicalId,
          ),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(checkerLaunches, [
    'independent-check-1', 'independent-check-2',
  ])
  assert.equal(checkerLaunches.some(id => id.includes('runtime-retry')), false)
  assert.deepEqual(transitions.filter(([event]) => [
    'CHECK_INCONCLUSIVE', 'CHECK_BECAME_CONCLUSIVE',
  ].includes(event)).map(([event, state, details]) => [
    event, state, details && details.checkerId, details && details.nextReadyWorkIds,
  ]), [
    ['CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE', 'independent-check-1', []],
    ['CHECK_BECAME_CONCLUSIVE', 'CHECK_WORK', 'independent-check-1', []],
  ])
  assert.deepEqual(transitions.filter(([event]) => event === 'TRANSIENT_RUNTIME'), [])
})

test('the same checker seat and candidate receive no fresh report correction', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-same-seat-correction-'))
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.logicalRole === 'worker') {
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'candidate'\n")
        return { allAssignedItemsPass: true }
      }
      return {
        code: 'CHECK_INCONCLUSIVE', currentVersionHash: request.candidateHash,
        cause: { event: 'CHECK_RUNTIME_UNAVAILABLE', reason: 'report remains malformed' },
        payload: {},
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches.filter(id => /^independent-check-/u.test(id)), [
    'independent-check-1',
  ])
  assert.equal(launches.some(id => id.includes('runtime-retry')), false)
})

test('legacy crash resume retires an observation/runtime retry without another physical launch', async t => {
  const directory = tempDirectory(t, 'autoprompt-correction-binding-resume-')
  const target = createTempGitTarget(directory)
  fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'candidate'\n")
  const candidateHash = testWorkspaceCandidateHash(target)
  const checkerId = 'independent-check-1'
  const baseResult = {
    code: 'CHECK_INCONCLUSIVE', candidateHash, currentVersionHash: candidateHash,
    cause: { event: 'CHECK_RUNTIME_UNAVAILABLE', reason: 'first report needs correction' },
    payload: {},
  }
  const resultPath = path.join(directory, `${checkerId}.json`)
  fs.writeFileSync(resultPath, `${JSON.stringify(baseResult)}\n`)
  const bytes = fs.readFileSync(resultPath)
  const pointer = {
    name: checkerId, path: resultPath,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  }
  const checkerResultHash = crypto.createHash('sha256')
    .update(JSON.stringify(baseResult)).digest('hex')
  const correctionBinding = { candidateHash, checkerSeat: checkerId }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    readResult: workItemId => workItemId === checkerId ? baseResult : null,
    resultPointer: workItemId => { assert.equal(workItemId, checkerId); return pointer },
    verifyDurableResultReceipt: () => true,
    harnessAttestation: (versionHash, oracle) => ({
      repoHash: versionHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })({
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      launches.push(request.workItemId)
      assert.fail(`legacy observation/runtime retry must not relaunch ${request.workItemId}`)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE', candidateHash,
      completedWorkIds: ['work-1'], completedCheckIds: [checkerId], acceptedResultIds: [],
      nextReadyWorkIds: ['independent-check-1-runtime-retry-1'],
      retryState: {
        checkerReportCorrectionBindings: [correctionBinding],
        inconclusiveChecker: {
          checkerId, candidateHash, checkerResultHash, retryAttempt: 1,
          returnState: 'CHECK_WORK',
        },
      },
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches, [])
})

test('live checker keeps target read-only while owning isolated workspace cache database service port and outputs', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-target-'))
  fs.mkdirSync(path.join(target, 'evidence'))
  fs.writeFileSync(path.join(target, 'evidence', 'baseline.txt'), 'baseline\n')
  const hardened = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal([0, 3].includes(hardened.status), true, hardened.stderr || hardened.stdout)
  const candidateHash = testWorkspaceCandidateHash(target)
  const snapshotRoot = tempDirectory(t, 'autoprompt-checker-snapshots-')
  const harness = makeHarness(t, {
    runtimeOptions: {
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
      targetPath: target,
      expectedBranch: 'main',
      gitEnvironment: () => process.env,
      checkerSnapshotFactory(checkerId) {
        const snapshot = path.join(snapshotRoot, checkerId)
        fs.cpSync(target, snapshot, { recursive: true })
        return snapshot
      },
      settings: {
        explicit: { concurrency: { mode: 'tokensaver' }, path: 'direct' },
        capabilities: { modelRouting: false, wideMaxSubs: 10 },
        providerId: 'codex',
      },
    },
  })
  harness.runtimeOptions.launcher = async launch => {
    harness.launches.push(launch)
    if (launch.logicalRole === 'diagnostic-probe') {
      return representativeProbeResult(launch)
    }
    assert.equal(launch.logicalRole, 'independent-reviewer')
    assert.notEqual(path.resolve(launch.workingDirectory), path.resolve(target))
    assert.equal(launch.physicalExecutionPolicy.sandboxMode, 'read-only')
    fs.mkdirSync(path.join(launch.workingDirectory, 'generated'), { recursive: true })
    fs.writeFileSync(path.join(launch.workingDirectory, 'generated', 'checker-evidence.txt'), 'isolated evidence\n')
    assert.equal(fs.existsSync(path.join(target, 'generated', 'checker-evidence.txt')), false)
    return {
      schemaVersion: '2.0.0', code: 'PASS', runId: 'run-1',
      requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
      currentVersionHash: candidateHash, candidateHash,
      contextId: 'checker-context', usage: ZERO_USAGE, evidenceHashes: [],
    }
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const oracleHash = '9'.repeat(64)
    await launch({
      workItemId: 'checker-resources', logicalRole: 'independent-reviewer', parent: 'run-owner',
      purpose: 'verification', assignment: `Check AP-LAYER-025 and AP-DESIGN-037 using ${path.join(target, 'evidence', 'baseline.txt')}.`,
      findingIds: ['AP-LAYER-025', 'AP-DESIGN-037'], candidateHash,
      oracle: 'hostile-resource-oracle', ownership: [
        { kind: 'evidence-root', identity: 'evidence', owner: 'target-owner' },
      ],
      isolation: 'snapshot', writeProducing: true,
      writeResources: [
        { kind: 'workspace', id: target },
        { kind: 'cache', id: path.join(target, '.cache') },
        { kind: 'database', id: 'checker-db' },
        { kind: 'service', id: 'checker-service' },
        { kind: 'port', id: '43127' },
        { kind: 'generated', id: path.join(target, 'generated') },
        { kind: 'temporary', id: path.join(target, 'tmp') },
      ],
      success: ['Target bytes stay unchanged and isolated evidence is returned.'],
      checks: ['hostile checker-resource check'],
      harnessAttestation: { repoHash: '7'.repeat(64), buildHash: '8'.repeat(64), oracleHash },
    })
    const report = path.join(harness.directory, 'checker-resource-report.txt')
    fs.writeFileSync(report, 'checker isolation and evidence return verified\n')
    return {
      outcome: 'DONE', deliverables: [report],
      checkHashes: [crypto.createHash('sha256').update(fs.readFileSync(report)).digest('hex')],
    }
  }
  const before = fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8')
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8'), before)
  assert.equal(fs.existsSync(path.join(target, 'generated')), false)
  const checker = harness.launches.find(launch => launch.workItemId === 'checker-resources')
  const persistedAssignment = [...harness.record.writes.entries()]
    .find(([name, bytes]) => name.startsWith('work/assignments/') &&
      JSON.parse(bytes).assignmentId === 'checker-resources')
  assert.ok(persistedAssignment, 'the context-free assignment is durable before the child result')
  const replay = JSON.parse(persistedAssignment[1])
  assert.deepEqual(replay, checker.canonicalAssignment)
  for (const field of [
    'findingIds', 'requestedResult', 'planReference', 'resources', 'allowedReads',
    'forbiddenChanges', 'successChecklist', 'checks', 'resultLocation',
  ]) assert.ok(replay[field], `context-loss replay retains ${field}`)
  const byKind = new Map(checker.canonicalAssignment.resources.map(resource => [resource.kind, resource]))
  assert.equal(checker.canonicalAssignment.findingIds.includes('AP-LAYER-025'), true)
  assert.equal(checker.canonicalAssignment.findingIds.includes('AP-DESIGN-037'), true)
  assert.equal(checker.canonicalAssignment.resources.find(resource => resource.identity === 'evidence').access, 'read')
  for (const kind of ['directory', 'cache', 'database', 'service', 'port', 'output']) {
    assert.equal(byKind.has(kind), true, `missing checker ${kind} assignment resource`)
  }
  for (const resource of checker.canonicalAssignment.resources.filter(resource => resource.identity !== 'evidence')) {
    if (resource.access === 'read') {
      assert.match(resource.expectedPreimageHash, /^[a-f0-9]{64}$/)
    } else {
      assert.equal(resource.access, 'exclusive')
      assert.equal(resource.owner, 'checker-resources')
    }
  }
  assert.equal(checker.schedulerResources.some(resource => String(resource.id).startsWith('cache:')), true)
  assert.equal(checker.schedulerResources.some(resource => String(resource.id) === 'database:checker-db'), true)
  assert.equal(checker.schedulerResources.some(resource => String(resource.id) === 'service:checker-service'), true)
  assert.equal(checker.schedulerResources.some(resource => String(resource.id) === 'port:43127'), true)
})

test('AP-RUN-037 checker snapshot repair ignores ambient Git command overrides and preserves the dirty candidate', t => {
  const directory = tempDirectory(t, 'autoprompt-snapshot-repair-')
  const target = createTempGitTarget(directory)
  const deletedPath = path.join(target, 'src', 'deleted-after-checkpoint.js')
  fs.writeFileSync(deletedPath, "module.exports = 'delete-me'\n")
  for (const argv of [
    ['-C', target, 'add', '--', 'src/deleted-after-checkpoint.js'],
    ['-C', target, 'commit', '-m', 'add deletion fixture'],
  ]) {
    const result = spawnSync('git', argv, { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  const profilePath = path.join(directory, 'autoprompt.config.toml')
  const profile = strictLocalProfile()
  fs.writeFileSync(profilePath, profile, { mode: 0o600 })
  const enforcementProofPath = path.join(directory, 'enforcement-proof.json')
  fs.writeFileSync(enforcementProofPath, `${JSON.stringify({
    schemaVersion: 1,
    provider: 'codex',
    profilePath,
    profileSha256: crypto.createHash('sha256').update(profile).digest('hex'),
    selectedProfile: 'autoprompt',
    strictConfig: true,
  })}\n`)
  const hardened = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair',
    '--enforcement-proof', enforcementProofPath, '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.ok([0, 3].includes(hardened.status), hardened.stderr || hardened.stdout)

  fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'dirty-candidate'\n")
  fs.writeFileSync(path.join(target, 'src', 'new-file.js'), "module.exports = 'untracked-candidate'\n")
  fs.unlinkSync(deletedPath)
  const stagedDeletion = spawnSync('git', ['-C', target, 'add', '-u', '--', 'src/deleted-after-checkpoint.js'], {
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(stagedDeletion.status, 0, stagedDeletion.stderr || stagedDeletion.stdout)
  const registrations = []
  const snapshotFactory = createCheckerSnapshotFactory({
    targetPath: target,
    snapshotRoot: path.join(directory, 'snapshots'),
    runId: 'snapshot-projection-run',
    generation: 1,
    cleanupRegistry: { register: entry => registrations.push(entry) },
    gitEnvironment: () => process.env,
    expectedBranch: 'main',
    enforcementProofPath,
    repairEnvironment: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: path.join(directory, 'foreign-hooks'),
    },
    safetyScriptPath: path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
  })

  const snapshot = snapshotFactory('resume-checker')
  assert.equal(fs.readFileSync(path.join(snapshot, 'src', 'example.js'), 'utf8'),
    "module.exports = 'dirty-candidate'\n")
  assert.equal(fs.readFileSync(path.join(snapshot, 'src', 'new-file.js'), 'utf8'),
    "module.exports = 'untracked-candidate'\n")
  assert.equal(fs.existsSync(path.join(snapshot, 'src', 'deleted-after-checkpoint.js')), false)
  assert.deepEqual(registrations, [{
    path: snapshot, kind: 'checker-snapshot', owner: 'resume-checker',
  }])
  const checked = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', snapshot, '--expected-branch', 'main',
    '--enforcement-proof', enforcementProofPath, '--json',
  ], { encoding: 'utf8', windowsHide: true })
  const safety = JSON.parse(checked.stdout)
  assert.equal(safety.networkContactAttempted, false)
  assert.equal(safety.repositoryOk, true, checked.stderr || checked.stdout)

  fs.mkdirSync(path.join(target, 'plan'), { recursive: true })
  fs.writeFileSync(path.join(target, 'plan', 'ROADMAP.md'), '# unrelated target roadmap\n')
  const admittedPath = path.join(directory, 'admitted-ROADMAP.md')
  const admittedBytes = Buffer.from('# exact admitted roadmap\n', 'utf8')
  fs.writeFileSync(admittedPath, admittedBytes)
  const projection = {
    relativePath: 'plan/ROADMAP.md', sourcePath: admittedPath,
    sha256: crypto.createHash('sha256').update(admittedBytes).digest('hex'), bytes: admittedBytes.length,
  }
  const projected = snapshotFactory('roadmap-plan-check', [], target, { projection })
  assert.equal(fs.readFileSync(path.join(projected.snapshotPath, 'plan', 'ROADMAP.md'), 'utf8'),
    admittedBytes.toString('utf8'))
  assert.equal(projected.projectionReceipt.sha256, projection.sha256)
  const request = { logicalRole: 'plan-checker', candidateHash: projection.sha256, roadmapSlice: {
    path: admittedPath, sha256: projection.sha256, bytes: projection.bytes,
  } }
  const projectionIdentity = {
    runId: 'snapshot-projection-run', generation: 1, checkerId: 'roadmap-plan-check',
  }
  assert.equal(validatePlanCheckerSnapshot(
    projected.snapshotPath, request, projected.projectionReceipt, projectionIdentity,
  ), projection.sha256)
  for (const foreignIdentity of [
    { ...projectionIdentity, runId: 'foreign-run' },
    { ...projectionIdentity, generation: 2 },
    { ...projectionIdentity, checkerId: 'foreign-checker' },
  ]) {
    assert.throws(
      () => validatePlanCheckerSnapshot(
        projected.snapshotPath, request, projected.projectionReceipt, foreignIdentity,
      ),
      error => error.code === 'PLAN_PROJECTION_MISMATCH',
    )
  }
  fs.chmodSync(path.join(projected.snapshotPath, 'plan', 'ROADMAP.md'), 0o600)
  fs.writeFileSync(path.join(projected.snapshotPath, 'plan', 'ROADMAP.md'), '# substituted\n')
  assert.throws(
    () => validatePlanCheckerSnapshot(
      projected.snapshotPath, request, projected.projectionReceipt, projectionIdentity,
    ),
    error => error.code === 'PLAN_PROJECTION_MISMATCH',
  )
  fs.writeFileSync(admittedPath, '# changed after admission\n')
  assert.throws(
    () => snapshotFactory('roadmap-plan-check-changed', [], target, { projection }),
    error => error.code === 'PLAN_PROJECTION_SOURCE_CHANGED',
  )
})

test('private worker removes only new unowned Python bytecode caches and journals the cleanup', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-python-cache-target-'))
  const manager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: tempDirectory(t, 'autoprompt-python-cache-private-'),
    environment: process.env,
    runId: 'python-cache-run',
    activationId: 'python-cache-activation',
  })
  const assignment = { resources: [
    { kind: 'file', identity: 'anon.py', access: 'write' },
    { kind: 'directory', identity: 'output', access: 'write' },
  ] }
  const session = manager.prepare({ assignment, workItemId: 'data-anonymization' })
  fs.writeFileSync(path.join(session.workspacePath, 'anon.py'), 'print("ready")\n')
  const compiled = spawnSync('python3', ['-m', 'py_compile', 'anon.py'], {
    cwd: session.workspacePath, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  const cacheName = fs.readdirSync(path.join(session.workspacePath, '__pycache__'))
    .find(name => /^anon\..*\.pyc$/u.test(name))
  assert.ok(cacheName)
  const cache = path.join(session.workspacePath, '__pycache__', cacheName)
  const admission = manager.inspect(session, { filesChanged: ['anon.py'] })
  assert.deepEqual(admission.actualFilesChanged, ['anon.py'])
  assert.deepEqual(admission.transientArtifactsRemoved.map(item => item.path),
    [`__pycache__/${cacheName}`])
  assert.equal(fs.existsSync(cache), false)
  const journal = JSON.parse(fs.readFileSync(session.recordPath, 'utf8'))
  assert.equal(journal.transientArtifactsRemoved[0].kind, 'python-bytecode-cache')
  assert.match(journal.transientCleanupHash, /^[a-f0-9]{64}$/)
  const repeated = manager.inspect(session, { filesChanged: ['anon.py'] })
  assert.deepEqual(repeated.transientArtifactsRemoved, admission.transientArtifactsRemoved)
  const reopened = manager.reopen({ assignment, workItemId: 'data-anonymization', recordPath: session.recordPath })
  const recovered = manager.inspect(reopened, { filesChanged: ['anon.py'] })
  assert.deepEqual(recovered, repeated)
  const promoted = manager.promote(reopened, recovered)
  assert.deepEqual(promoted.map(item => path.basename(item.path)), ['anon.py'])
  assert.equal(fs.readFileSync(path.join(target, 'anon.py'), 'utf8'), 'print("ready")\n')
  assert.equal(fs.existsSync(path.join(target, '__pycache__', cacheName)), false)
  manager.finalize(reopened)
})

test('private worker accepts owned byte-identical rewrites while requiring every physical diff', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-byte-identical-report-target-'))
  fs.writeFileSync(path.join(target, 'anon.py'), 'print("before")\n')
  fs.mkdirSync(path.join(target, 'output'))
  fs.writeFileSync(path.join(target, 'output', 'subjects.csv'), 'id,token\n1,stable\n')
  const manager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: tempDirectory(t, 'autoprompt-byte-identical-report-private-'),
    environment: process.env,
    runId: 'byte-identical-report-run',
    activationId: 'byte-identical-report-activation',
  })
  const assignment = { resources: [
    { kind: 'file', identity: 'anon.py', access: 'write' },
    { kind: 'directory', identity: 'output', access: 'write' },
  ] }
  const session = manager.prepare({ assignment, workItemId: 'generated-output-repair' })
  fs.writeFileSync(path.join(session.workspacePath, 'anon.py'), 'print("after")\n')
  fs.writeFileSync(path.join(session.workspacePath, 'output', 'subjects.csv'), 'id,token\n1,stable\n')

  const admission = manager.inspect(session, {
    filesChanged: ['anon.py', 'output/subjects.csv'],
  })
  assert.deepEqual(admission.actualFilesChanged, ['anon.py'])
  assert.deepEqual(admission.reportedNoopFiles, ['output/subjects.csv'])
  assert.throws(
    () => manager.inspect(session, { filesChanged: ['output/subjects.csv'] }),
    error => error.code === 'MUTATION_REPORT_MISMATCH' &&
      error.details.unreportedActual.includes('anon.py'),
  )
  manager.abort(session)
})

test('candidate survival rejects bytes changed after admission and retains no foreign evidence', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-survival-tamper-target-'))
  const privateRoot = tempDirectory(t, 'autoprompt-survival-tamper-private-')
  const manager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot,
    environment: process.env,
    runId: 'survival-tamper-run',
    activationId: 'survival-tamper-activation',
  })
  const assignment = { resources: [
    { kind: 'file', identity: 'src/example.js', access: 'write' },
  ] }
  const session = manager.prepare({ assignment, workItemId: 'survival-tamper-work' })
  const candidatePath = path.join(session.workspacePath, 'src', 'example.js')
  fs.writeFileSync(candidatePath, "module.exports = 'admitted-candidate'\n")
  const admission = manager.inspect(session, { filesChanged: ['src/example.js'] })
  fs.writeFileSync(candidatePath, "module.exports = 'foreign-after-admission'\n")
  assert.throws(
    () => manager.preserveCandidate(session, {
      admission,
      candidateHash: 'a'.repeat(64),
      reasonCode: 'RUN_RECORD_UNSAFE',
    }),
    error => error.code === 'WORKER_SURVIVAL_TAMPERED',
  )
  assert.deepEqual(fs.readdirSync(path.join(privateRoot, 'candidate-survivals')), [])
  assert.equal(fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8'),
    "module.exports = 'ready'\n")
  manager.abort(session)
})

test('worker Python environment redirects explicit compilation into an evidenced private cache root', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-python-private-cache-target-'))
  const manager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: tempDirectory(t, 'autoprompt-python-private-cache-root-'),
    environment: process.env,
    runId: 'python-private-cache-run',
    activationId: 'python-private-cache-activation',
  })
  const assignment = { resources: [{ kind: 'file', identity: 'anon.py', access: 'write' }] }
  const session = manager.prepare({ assignment, workItemId: 'data-anonymization-private-cache' })
  fs.writeFileSync(path.join(session.workspacePath, 'anon.py'), 'print("ready")\n')
  const environment = {
    ...process.env,
    TMPDIR: session.cacheRoot,
    TMP: session.cacheRoot,
    TEMP: session.cacheRoot,
    XDG_CACHE_HOME: session.cacheRoot,
    PYTHONPYCACHEPREFIX: session.cacheRoot,
    PYTHONDONTWRITEBYTECODE: '1',
    AUTOPROMPT_WORKER_CACHE_ROOT: session.cacheRoot,
  }
  const compiled = spawnSync('python3', ['-m', 'py_compile', 'anon.py'], {
    cwd: session.workspacePath, env: environment, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  assert.equal(fs.existsSync(path.join(session.workspacePath, '__pycache__')), false)
  const cacheFiles = fs.readdirSync(session.cacheRoot, { recursive: true }).map(String)
    .filter(name => /anon\..*\.pyc$/u.test(name))
  assert.equal(cacheFiles.length, 1)
  const expectedCacheHash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(session.cacheRoot, cacheFiles[0]))).digest('hex')
  const admission = manager.inspect(session, { filesChanged: ['anon.py'] })
  assert.deepEqual(admission.actualFilesChanged, ['anon.py'])
  const cacheEvidence = admission.transientArtifactsRemoved.find(item =>
    item.scope === 'configured-cache-root' && item.kind === 'private-worker-cache' &&
      /anon\..*\.pyc$/u.test(item.path))
  assert.ok(cacheEvidence)
  assert.equal(cacheEvidence.hash, expectedCacheHash)
  assert.deepEqual(fs.readdirSync(session.cacheRoot), [])
  const journal = JSON.parse(fs.readFileSync(session.recordPath, 'utf8'))
  assert.equal(journal.transientCleanup, null)
  assert.match(journal.transientCleanupHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(journal.transientArtifactsRemoved, admission.transientArtifactsRemoved)
  const promoted = manager.promote(session, admission)
  assert.deepEqual(promoted.map(item => path.basename(item.path)), ['anon.py'])
  manager.finalize(session)
  assert.equal(fs.existsSync(session.cacheRoot), false)
})

test('ignored Python caches are removed and evidenced without broadening ignored-file admission', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-python-ignored-cache-target-'))
  fs.writeFileSync(path.join(target, '.gitignore'), '__pycache__/\n*.pyc\n')
  for (const argv of [
    ['-C', target, 'add', '--', '.gitignore'],
    ['-C', target, 'commit', '-m', 'ignore Python cache fixture'],
  ]) {
    const result = spawnSync('git', argv, { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  const manager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: tempDirectory(t, 'autoprompt-python-ignored-cache-private-'),
    environment: process.env,
    runId: 'python-ignored-cache-run',
    activationId: 'python-ignored-cache-activation',
  })
  const assignment = { resources: [{ kind: 'file', identity: 'anon.py', access: 'write' }] }
  const session = manager.prepare({ assignment, workItemId: 'data-anonymization-ignored-cache' })
  fs.writeFileSync(path.join(session.workspacePath, 'anon.py'), 'print("ready")\n')
  const compiled = spawnSync('python3', ['-m', 'py_compile', 'anon.py'], {
    cwd: session.workspacePath, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  const cacheDirectory = path.join(session.workspacePath, '__pycache__')
  assert.equal(fs.existsSync(cacheDirectory), true)
  const admission = manager.inspect(session, { filesChanged: ['anon.py'] })
  assert.equal(fs.existsSync(cacheDirectory), false)
  assert.equal(admission.transientArtifactsRemoved.some(item =>
    item.scope === 'workspace' && item.kind === 'python-bytecode-cache' &&
      /^__pycache__\/anon\..*\.pyc$/u.test(item.path)), true)
  assert.deepEqual(admission.actualFilesChanged, ['anon.py'])
  manager.abort(session)
})

test('transient cleanup intent survives a crash after unlink and reconciles exact evidence on reopen', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-python-cleanup-crash-target-'))
  const privateRoot = tempDirectory(t, 'autoprompt-python-cleanup-crash-private-')
  let recordPath = null
  let recordRenameCount = 0
  let injectFailure = false
  const fsImpl = Object.create(fs)
  fsImpl.renameSync = (source, destination) => {
    if (injectFailure && recordPath && path.resolve(destination) === path.resolve(recordPath)) {
      recordRenameCount += 1
      if (recordRenameCount === 2) {
        const error = new Error('simulated crash before cleanup evidence commit')
        error.code = 'SIMULATED_CRASH'
        throw error
      }
    }
    return fs.renameSync(source, destination)
  }
  const manager = new WorkerWorkspaceManager({
    targetRoot: target, privateRoot, environment: process.env,
    runId: 'python-cleanup-crash-run', activationId: 'python-cleanup-crash-activation', fsImpl,
  })
  const assignment = { resources: [{ kind: 'file', identity: 'anon.py', access: 'write' }] }
  const session = manager.prepare({ assignment, workItemId: 'data-anonymization-cleanup-crash' })
  recordPath = session.recordPath
  fs.writeFileSync(path.join(session.workspacePath, 'anon.py'), 'print("ready")\n')
  fs.mkdirSync(path.join(session.workspacePath, '__pycache__'))
  const cachePath = path.join(session.workspacePath, '__pycache__', 'anon.cpython-312.pyc')
  fs.writeFileSync(cachePath, 'cache')
  fs.mkdirSync(path.join(session.cacheRoot, 'nested'))
  const privateCachePath = path.join(session.cacheRoot, 'nested', 'anon.cpython-312.pyc')
  fs.writeFileSync(privateCachePath, 'private cache')
  injectFailure = true
  assert.throws(() => manager.inspect(session, { filesChanged: ['anon.py'] }),
    error => error.code === 'SIMULATED_CRASH')
  assert.equal(fs.existsSync(cachePath), false)
  assert.equal(fs.existsSync(privateCachePath), false)
  const interrupted = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
  assert.equal(interrupted.transientCleanup.status, 'PREPARED')
  assert.deepEqual(interrupted.transientArtifactsRemoved, [])
  injectFailure = false
  const reopened = manager.reopen({
    assignment, workItemId: 'data-anonymization-cleanup-crash', recordPath,
  })
  const reconciled = manager.inspect(reopened, { filesChanged: ['anon.py'] })
  assert.equal(reconciled.transientArtifactsRemoved.some(item =>
    item.scope === 'workspace' && item.path === '__pycache__/anon.cpython-312.pyc'), true)
  assert.equal(reconciled.transientArtifactsRemoved.some(item =>
    item.scope === 'configured-cache-root' && item.path === 'nested/anon.cpython-312.pyc'), true)
  const recoveredJournal = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
  assert.equal(recoveredJournal.transientCleanup, null)
  assert.match(recoveredJournal.transientCleanupHash, /^[a-f0-9]{64}$/)
  manager.abort(reopened)
})

test('private worker never hides similar files, tracked caches, or owned cache deliverables', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-python-cache-deny-target-'))
  fs.mkdirSync(path.join(target, '__pycache__'))
  fs.writeFileSync(path.join(target, '__pycache__', 'tracked.pyc'), 'baseline')
  for (const argv of [['-C', target, 'add', '--', '__pycache__/tracked.pyc'],
    ['-C', target, 'commit', '-m', 'tracked cache fixture']]) {
    const result = spawnSync('git', argv, { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  const manager = new WorkerWorkspaceManager({
    targetRoot: target, privateRoot: tempDirectory(t, 'autoprompt-python-cache-deny-private-'),
    environment: process.env, runId: 'python-cache-deny-run', activationId: 'python-cache-deny-activation',
  })
  const assignment = { resources: [{ kind: 'file', identity: 'anon.py', access: 'write' }] }
  const similar = manager.prepare({ assignment, workItemId: 'similar-file' })
  fs.writeFileSync(path.join(similar.workspacePath, 'cache.pyz'), 'not bytecode')
  assert.throws(() => manager.inspect(similar, { filesChanged: [] }),
    error => error.code === 'OWNERSHIP_SCOPE_VIOLATION')
  manager.abort(similar)

  const cacheDirectoryNonBytecode = manager.prepare({ assignment, workItemId: 'cache-directory-non-bytecode' })
  fs.mkdirSync(path.join(cacheDirectoryNonBytecode.workspacePath, '__pycache__'), { recursive: true })
  fs.writeFileSync(path.join(cacheDirectoryNonBytecode.workspacePath, '__pycache__', 'notes.txt'), 'not bytecode')
  assert.throws(() => manager.inspect(cacheDirectoryNonBytecode, { filesChanged: [] }),
    error => error.code === 'OWNERSHIP_SCOPE_VIOLATION')
  manager.abort(cacheDirectoryNonBytecode)

  const tracked = manager.prepare({ assignment, workItemId: 'tracked-cache' })
  fs.writeFileSync(path.join(tracked.workspacePath, '__pycache__', 'tracked.pyc'), 'changed')
  assert.throws(() => manager.inspect(tracked, { filesChanged: [] }),
    error => error.code === 'OWNERSHIP_SCOPE_VIOLATION')
  manager.abort(tracked)

  const broadAssignment = { resources: [{ kind: 'directory', identity: '.', access: 'write' }] }
  const broad = manager.prepare({ assignment: broadAssignment, workItemId: 'broad-owned-tracked-cache' })
  fs.writeFileSync(path.join(broad.workspacePath, '__pycache__', 'tracked.pyc'), 'changed under broad ownership')
  assert.throws(() => manager.inspect(broad, { filesChanged: [] }),
    error => error.code === 'MUTATION_REPORT_MISMATCH')
  manager.abort(broad)

  const ownedAssignment = { resources: [{ kind: 'file', identity: '__pycache__/deliverable.pyc', access: 'write' }] }
  const owned = manager.prepare({ assignment: ownedAssignment, workItemId: 'owned-cache' })
  fs.writeFileSync(path.join(owned.workspacePath, '__pycache__', 'deliverable.pyc'), 'requested')
  assert.throws(() => manager.inspect(owned, { filesChanged: ['__pycache__/deliverable.pyc'] }),
    error => error.code === 'OWNERSHIP_SCOPE_VIOLATION')
  manager.abort(owned)

  if (process.platform !== 'win32') {
    const linked = manager.prepare({ assignment, workItemId: 'linked-cache' })
    fs.symlinkSync(path.join(linked.workspacePath, 'src', 'example.js'),
      path.join(linked.workspacePath, '__pycache__', 'linked.pyc'))
    assert.throws(() => manager.inspect(linked, { filesChanged: [] }),
      error => error.code === 'WORKER_WORKSPACE_UNSAFE_ENTRY')
    manager.abort(linked)

    const privateLinked = manager.prepare({ assignment, workItemId: 'private-linked-cache' })
    const outside = path.join(target, 'outside-cache-target')
    fs.writeFileSync(outside, 'outside remains unchanged')
    fs.symlinkSync(outside, path.join(privateLinked.cacheRoot, 'linked.pyc'))
    assert.throws(() => manager.inspect(privateLinked, { filesChanged: [] }),
      error => error.code === 'WORKER_WORKSPACE_UNSAFE_ENTRY')
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside remains unchanged')

    const privateHardlinked = manager.prepare({ assignment, workItemId: 'private-hardlinked-cache' })
    fs.linkSync(outside, path.join(privateHardlinked.cacheRoot, 'hardlinked.pyc'))
    assert.throws(() => manager.inspect(privateHardlinked, { filesChanged: [] }),
      error => error.code === 'WORKER_WORKSPACE_UNSAFE_ENTRY')
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside remains unchanged')
  }
})

test('private worker workspace keeps real target immutable and rejects stale owned preimages', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-isolated-cas-target-'))
  const manager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: tempDirectory(t, 'autoprompt-isolated-cas-private-'),
    environment: process.env,
    runId: 'isolated-cas-run',
    activationId: 'isolated-cas-activation',
  })
  const assignment = {
    resources: [{ kind: 'file', identity: path.join(target, 'src', 'example.js'), access: 'write' }],
  }
  const session = manager.prepare({ assignment, workItemId: 'isolated-cas-work' })
  const writer = spawnSync(process.execPath, [
    '-e',
    "const fs=require('node:fs');const path=require('node:path');fs.writeFileSync(path.join(process.argv[1],'src','example.js'),'isolated postimage\\n')",
    session.workspacePath,
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(writer.status, 0, writer.stderr)
  assert.equal(fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8'), "module.exports = 'ready'\n")
  const admission = manager.inspect(session, { filesChanged: ['src/example.js'] })
  assert.deepEqual(
    manager.inspect(session, { filesChanged: [path.join(target, 'src', 'example.js')] }).actualFilesChanged,
    ['src/example.js'],
  )
  assert.throws(
    () => manager.inspect(session, { filesChanged: [path.join(path.dirname(target), 'foreign.js')] }),
    error => error.code === 'WORKER_WORKSPACE_INVALID',
  )
  assert.throws(
    () => manager.inspect(session, { filesChanged: [session.workspacePath + '/src/example.js'] }),
    error => error.code === 'WORKER_WORKSPACE_INVALID',
  )
  fs.writeFileSync(path.join(target, 'src', 'example.js'), 'independent target change\n')
  assert.throws(
    () => manager.promote(session, admission),
    error => error.code === 'CONCURRENT_MUTATION',
  )
  assert.equal(fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8'), 'independent target change\n')
  assert.deepEqual(fs.readdirSync(path.join(target, 'src')).filter(name => name.startsWith('.autoprompt-cas-')), [])
  const aborted = manager.abort(session)
  assert.equal(aborted.status, 'ABORTED')

  const outputAssignment = {
    resources: [{
      kind: 'output', identity: 'plan/ROADMAP.md', access: 'write',
      owner: 'roadmap-author', ownershipMode: 'single-owner', expectedPreimageHash: null,
    }],
  }
  const authorSession = manager.prepare({ assignment: outputAssignment, workItemId: 'roadmap-author' })
  fs.mkdirSync(path.join(authorSession.workspacePath, 'plan'), { recursive: true })
  fs.writeFileSync(path.join(authorSession.workspacePath, 'plan', 'ROADMAP.md'), '# isolated roadmap\n')
  const authorAdmission = manager.inspect(authorSession, { filesChanged: ['plan/ROADMAP.md'] })
  manager.promote(authorSession, authorAdmission)
  assert.equal(fs.readFileSync(path.join(target, 'plan', 'ROADMAP.md'), 'utf8'), '# isolated roadmap\n')

  const foreignAssignment = {
    resources: [{ kind: 'file', identity: path.join(path.dirname(target), 'foreign.js'), access: 'write' }],
  }
  const foreignSession = manager.prepare({ assignment: foreignAssignment, workItemId: 'foreign-owner' })
  fs.writeFileSync(path.join(foreignSession.workspacePath, 'src', 'example.js'), 'foreign ownership attempt\n')
  assert.throws(
    () => manager.inspect(foreignSession, { filesChanged: ['src/example.js'] }),
    error => error.code === 'WORKER_WORKSPACE_INVALID',
  )
  manager.abort(foreignSession)
})

test('worker workspace rejects intermediate symlink and Windows junction escapes before creating leaves', t => {
  const root = tempDirectory(t, 'autoprompt-hostile-worker-root-')
  const target = createTempGitTarget(path.join(root, 'physical-target-parent'))
  const safePrivateParent = path.join(root, 'safe-private-parent')
  const escapedPrivateParent = path.join(root, 'escaped-private-parent')
  fs.mkdirSync(safePrivateParent)
  fs.mkdirSync(escapedPrivateParent)
  const targetRedirect = path.join(root, 'target-redirect')
  const privateRedirect = path.join(root, 'private-redirect')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(target, targetRedirect, linkType)
  fs.symlinkSync(escapedPrivateParent, privateRedirect, linkType)
  assert.throws(
    () => new WorkerWorkspaceManager({
      targetRoot: targetRedirect,
      privateRoot: path.join(safePrivateParent, 'new-leaf'),
      runId: 'hostile-target-run', activationId: 'hostile-target-activation',
    }),
    error => error.code === 'WORKER_ISOLATION_UNSUPPORTED',
  )
  assert.throws(
    () => new WorkerWorkspaceManager({
      targetRoot: target,
      privateRoot: path.join(privateRedirect, 'new-leaf'),
      runId: 'hostile-private-run', activationId: 'hostile-private-activation',
    }),
    error => error.code === 'WORKER_ISOLATION_UNSUPPORTED',
  )
  assert.equal(fs.existsSync(path.join(escapedPrivateParent, 'new-leaf')), false)
  const safe = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: path.join(safePrivateParent, 'new-leaf'),
    runId: 'safe-leaf-run', activationId: 'safe-leaf-activation',
  })
  assert.equal(fs.realpathSync.native(safe.privateRoot), fs.realpathSync.native(path.join(safePrivateParent, 'new-leaf')))
})

test('crash during isolated CAS promotion is recovered by exact preimage rollback', t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-isolated-crash-target-'))
  const privateRoot = tempDirectory(t, 'autoprompt-isolated-crash-private-')
  const assignment = {
    resources: [{ kind: 'file', identity: 'src/example.js', access: 'write' }],
  }
  const manager = new WorkerWorkspaceManager({
    targetRoot: target, privateRoot, environment: process.env,
    runId: 'isolated-crash-run', activationId: 'isolated-crash-activation',
  })
  const session = manager.prepare({ assignment, workItemId: 'isolated-crash-work' })
  fs.writeFileSync(path.join(session.workspacePath, 'src', 'example.js'), 'crash postimage\n')
  const childScript = [
    "const {WorkerWorkspaceManager}=require(process.argv[1])",
    'const target=process.argv[2], privateRoot=process.argv[3]',
    'const assignment=JSON.parse(process.argv[4])',
    "const manager=new WorkerWorkspaceManager({targetRoot:target,privateRoot,environment:process.env,runId:'isolated-crash-run',activationId:'isolated-crash-activation',afterPromotionStep(){process.exit(77)}})",
    "const session=manager.prepare({assignment,workItemId:'isolated-crash-work'})",
    "const admission=manager.inspect(session,{filesChanged:['src/example.js']})",
    'manager.promote(session,admission)',
  ].join(';')
  const crashed = spawnSync(process.execPath, [
    '-e', childScript, path.join(WORKFLOW, 'worker-workspace.js'), target, privateRoot, JSON.stringify(assignment),
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout)
  const recoveryDeadline = Date.now() + 8_000
  let guardianRecord = null
  while (Date.now() < recoveryDeadline) {
    try { guardianRecord = JSON.parse(fs.readFileSync(session.recordPath, 'utf8')) } catch {}
    const restored = fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8') === "module.exports = 'ready'\n"
    const clean = fs.readdirSync(path.join(target, 'src')).every(name => !name.startsWith('.autoprompt-cas-'))
    if (restored && clean && guardianRecord && guardianRecord.status === 'ROLLED_BACK' &&
        guardianRecord.transaction === null && guardianRecord.guardianOutcome === 'ROLLED_BACK') break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
  assert.equal(fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8'), "module.exports = 'ready'\n",
    'the detached guardian restores the preimage without another supervisor activation')
  assert.deepEqual(fs.readdirSync(path.join(target, 'src')).filter(name => name.startsWith('.autoprompt-cas-')), [])
  assert.equal(guardianRecord && guardianRecord.status, 'ROLLED_BACK')
  assert.equal(guardianRecord && guardianRecord.transaction, null)
  assert.equal(guardianRecord && guardianRecord.guardianOutcome, 'ROLLED_BACK')
  const recovered = manager.prepare({ assignment, workItemId: 'isolated-crash-work' })
  assert.equal(fs.readFileSync(path.join(target, 'src', 'example.js'), 'utf8'), "module.exports = 'ready'\n")
  assert.deepEqual(fs.readdirSync(path.join(target, 'src')).filter(name => name.startsWith('.autoprompt-cas-')), [])
  const aborted = manager.abort(recovered)
  assert.equal(aborted.status, 'ABORTED')
  assert.equal(fs.existsSync(recovered.workspacePath), false)
  assert.equal(JSON.parse(fs.readFileSync(recovered.recordPath, 'utf8')).transaction, null)
})

test('terminal Windows Job records do not mistake a reused historical PID for a live descendant', () => {
  const status = {
    status: 'EXITED',
    ready: true,
    assigned: true,
    helperPid: 420,
    rootPid: 410,
    pids: [],
    observedPids: [410, 411],
  }
  assert.deepEqual(selectWindowsLiveStatusPids(status, pid => pid === 411), [],
    'a PID reused after terminal publication is not the original owned process')
  assert.deepEqual(selectWindowsLiveStatusPids(status, pid => pid === 420), [],
    'EXITED already proves zero Job membership, so a reused helper PID is not owned')
  assert.deepEqual(selectWindowsLiveStatusPids({ ...status, status: 'FAILED' }, pid => pid === 420), [420],
    'FAILED remains conservative because it does not prove zero Job membership')
  assert.deepEqual(selectWindowsLiveStatusPids({ ...status, status: 'RUNNING' }, pid => pid === 411), [411],
    'historical membership remains a conservative fallback after a nonterminal helper crash')
})

test('phase hard maximum is independent, inverted budgets fail closed, and profile limits come from route plus user ceilings', () => {
  assert.equal(phaseBudgetVerdict({
    phase: 'verification', elapsedSec: 30, softSec: 20, hardSec: 30,
    graceSec: 60, priorForcedResets: 0, maxForcedResets: 1,
  }).action, 'hard-boundary')
  assert.equal(phaseBudgetVerdict({
    phase: 'verification', elapsedSec: 25, softSec: 20, hardSec: 30,
    scopeRequest: true,
  }).action, 'warn')
  assert.throws(
    () => phaseBudgetVerdict({ phase: 'work', elapsedSec: 6, softSec: 10, hardSec: 5 }),
    error => error.code === 'BUDGET_CONFIG_INVALID',
  )
  assert.deepEqual(deriveProfileLimits({}), {
    route: null, status: 'ROUTE_PENDING', maxDepth: 1, maxConcurrentThreads: 1,
  })
  assert.equal(deriveProfileLimits({ route: 'DIRECT', maxSubs: 99 }).maxConcurrentThreads, 3)
  assert.deepEqual(deriveProfileLimits({ route: 'LIGHT', maxSubs: 2 }), {
    route: 'LIGHT', status: 'ROUTE_BOUND', maxDepth: 3, maxConcurrentThreads: 2,
  })
  assert.equal(deriveProfileLimits({ route: 'ROADMAP', maxSubs: 9 }).maxConcurrentThreads, 5)
  assert.equal(deriveProfileLimits({ route: 'ROADMAP', maxSubs: 9, userLiveCeiling: 10 }).maxConcurrentThreads, 9)
  assert.doesNotMatch(renderProfile({
    route: 'DIRECT', maxSubs: 3,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    agentsDirectory: path.join(ROOT, 'agents', 'codex', 'agents'),
  }, ['ap-worker.toml']), /max_(?:depth|concurrent_threads_per_session) = 10/)
})

test('AP-RUN-003 residual scope accepts only current activation-generation scout evidence', () => {
  assert.deepEqual(phaseBudgetVerdict({
    phase: 'scope', elapsedSec: 5, softSec: 10, hardSec: 20,
    activationId: 'activation-current', generationId: 2,
    landedAngles: [
      { angle: 'old-activation', activationId: 'activation-old', generationId: 1 },
      { angle: 'old-generation', activationId: 'activation-current', generationId: 1 },
      { angle: 'current-scout', activationId: 'activation-current', generationId: 2 },
    ],
  }).residual, ['current-scout'], 'foreign scout evidence must not contaminate a new residual')
  assert.throws(
    () => phaseBudgetVerdict({
      phase: 'scope', elapsedSec: 5, softSec: 10, hardSec: 20,
      activationId: 'activation-current', generationId: 2, landedAngles: ['unbound-scout'],
    }),
    error => error.code === 'SCOPE_EVIDENCE_UNBOUND',
  )
})

test('AP-RUN-015 compatibility phase budgets reject equal soft and hard boundaries', () => {
  assert.throws(
    () => phaseBudgetVerdict({ phase: 'work', elapsedSec: 5, softSec: 10, hardSec: 10 }),
    error => error.code === 'BUDGET_CONFIG_INVALID',
    'the compatibility boundary requires a non-empty hard-only interval',
  )
})

test('AP-LAYER-017 casting honors explicit model/effort pins without using topology as an effort proxy', () => {
  const settings = {
    modelRouting: { explicitUserModelPin: 'pinned-model', explicitUserEffortPin: 'high' },
  }
  const assignment = resolveAgentAssignment({
    role: 'ap-worker', settings, selector: 'off',
    registryEntries: [{ ...MODEL_REGISTRY[0], id: 'pinned-model' }],
  })
  assert.equal(assignment.model, 'pinned-model')
  assert.equal(assignment.effort, 'high')
  assert.equal(assignment.pinned, true)
  assert.equal(assignment.routeIndependent, true)

  const common = {
    role: 'ap-worker', selector: 'auto', registryEntries: MODEL_REGISTRY,
    reasoningClass: 'task-specific', riskClass: 'assignment-bounded-write',
    difficulty: 'ordinary', risk: 'ordinary',
  }
  const l3Production = resolveAgentAssignment({ ...common, layer: 'L3', phase: 'production' })
  const l1Planning = resolveAgentAssignment({ ...common, layer: 'L1', phase: 'roadmap-planning' })
  assert.deepEqual(l3Production.policyBasis, {
    logicalRole: 'worker', reasoningClass: 'task-specific',
    riskClass: 'assignment-bounded-write', difficulty: 'ordinary', risk: 'ordinary',
  })
  assert.match(l3Production.policyBasisHash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(l3Production.policyBasisHash, l1Planning.policyBasisHash)
  assert.equal(l3Production.model, l1Planning.model)
  assert.equal(l3Production.effort, l1Planning.effort)
  assert.deepEqual(l3Production.topologyInputsUsed, [])

  const criticalRisk = resolveAgentAssignment({ ...common, layer: 'L3', phase: 'production', risk: 'critical' })
  assert.notEqual(criticalRisk.policyBasisHash, l3Production.policyBasisHash)
  assert.equal(criticalRisk.effort, 'xhigh', 'risk changes reasoning policy even when topology stays fixed')
})

test('default child environment is emitted and rechecked by the canonical local-only safety module', t => {
  const directory = tempDirectory(t, 'autoprompt-child-git-env-')
  const target = createTempGitTarget(directory)
  const isolation = path.join(directory, 'empty.gitconfig')
  const ghConfigDir = path.join(directory, 'gh-config')
  const profilePath = path.join(directory, 'autoprompt.config.toml')
  const profile = [
    'sandbox_mode = "workspace-write"', 'web_search = "disabled"', '',
    '[sandbox_workspace_write]', 'network_access = false', '', '[features]',
    'apps = false', 'enable_mcp_apps = false', 'plugins = false',
    'remote_plugin = false', 'browser_use = false', 'browser_use_external = false',
    'in_app_browser = false', 'computer_use = false', 'image_generation = false',
    'multi_agent = false', 'multi_agent_v2 = false', '',
  ].join('\n')
  fs.writeFileSync(isolation, '', { mode: 0o600 })
  fs.mkdirSync(ghConfigDir, { mode: 0o700 })
  fs.writeFileSync(profilePath, profile, { mode: 0o600 })
  const branch = spawnSync('git', ['-C', target, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim()
  const boundary = safeEnvironmentFactory()(target, process.env, {
    configIsolationPath: isolation,
    ghConfigDir,
    expectedBranch: branch,
    enforcementProof: {
      schemaVersion: 1,
      provider: 'codex',
      profilePath,
      profileSha256: crypto.createHash('sha256').update(profile).digest('hex'),
      selectedProfile: 'autoprompt',
      strictConfig: true,
    },
  })
  const { environment, attestation } = boundary
  assert.equal(environment.GIT_ALLOW_PROTOCOL, 'file')
  assert.equal(environment.GIT_CONFIG_GLOBAL, fs.realpathSync.native(isolation))
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0')
  assert.equal(environment.GIT_ASKPASS, undefined)
  assert.equal(attestation.mechanicallyEnforced, true)
  for (const channel of Object.values(attestation.channels)) {
    assert.equal(channel.applicable, true)
    assert.equal(channel.enforced, true)
    assert.deepEqual(channel.residuals, [])
    assert.ok(Object.keys(channel.evidence).length > 0)
  }
  const tampered = JSON.parse(JSON.stringify(attestation))
  tampered.channels.providerConnectorApiWriteToolDenial.enforced = false
  assert.throws(
    () => ensureSafeEnvironment({ environment, attestation: tampered }),
    error => error.code === 'SAFE_GIT_ENV_INVALID' &&
      error.details.invalidChannels.includes('providerConnectorApiWriteToolDenial'),
  )
})

test('external Codex adapter uses exact fresh/resume argv and drains terminal-then-sleep processes', async () => {
  const calls = []
  let sleepingResolve
  let terminalPersistedBeforeDrain = false
  const runner = {
    async run(spec) {
      calls.push(spec)
      const sleeping = new Promise(resolve => { sleepingResolve = resolve })
      spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(adapterWorkerResult()) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 4, reasoning_tokens: 4 },
      }))
      return sleeping
    },
    async stop() {
      assert.equal(terminalPersistedBeforeDrain, true,
        'typed terminal receipt must be durably handled before process drain/runner return')
      sleepingResolve({ status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true })
      return { drained: true }
    },
  }
  const adapter = new CodexExecAdapter({
    runner,
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  const base = {
    ...WORKER_EXECUTION_POLICY,
    physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: { GIT_ALLOW_PROTOCOL: 'file' },
    sessionId: 'run:DIRECT:launch-1',
    onSessionIdentified(sessionId) {
      assert.equal(sessionId, '11111111-1111-4111-8111-111111111111')
    },
    onUsageDelta(delta, cumulative) {
      assert.deepEqual(delta, { noncachedInput: 1, cachedInput: 2, output: 4, reasoning: 4 })
      assert.deepEqual(delta, cumulative)
      return { continue: true }
    },
    onTerminalResult(result, evidence) {
      assert.equal(result.reportType, 'result')
      assert.equal(evidence.sessionId, '11111111-1111-4111-8111-111111111111')
      assert.match(evidence.rawOutputHash, /^[a-f0-9]{64}$/)
      terminalPersistedBeforeDrain = true
    },
  }
  const fresh = await adapter.launch(base)
  assert.equal(fresh.reportType, 'result')
  assert.equal(fresh.completionRequested, true)
  assert.equal(fresh.recommendation, null)
  assert.deepEqual(calls[0].argv.slice(0, 2), ['exec', '--json'])
  assert.ok(calls[0].argv.includes('--output-schema'))
  assert.ok(calls[0].argv.includes('-p'))
  assert.ok(calls[0].argv.includes('-C'))
  assert.deepEqual(calls[0].argv.slice(calls[0].argv.indexOf('--sandbox'), calls[0].argv.indexOf('--sandbox') + 2), [
    '--sandbox', 'workspace-write',
  ])
  assert.doesNotMatch(calls[0].stdin, /AUTOPROMPT_REQUEST_ENVELOPE_V2|request_base64|REQUEST_ARGV_BEGIN/u)
  assert.match(calls[0].stdin, /^AUTOPROMPT_EXTERNAL_CHILD_V1\nrole=worker\n/)
  assert.match(calls[0].stdin, /AUTOPROMPT_CANONICAL_MISSION_V1\nCanonical original request:/u)
  assert.match(calls[0].stdin, /physical_role=autoprompt\.v2\.worker\nprovider_role=ap-worker\n/)
  assert.deepEqual(calls[0].argv.filter((value, index, all) => all[index - 1] === '--disable'), ['multi_agent', 'multi_agent_v2'])

  const resumeRunner = {
    async run(spec) {
      calls.push(spec)
      return {
        status: 0, processOwned: true, exactArgv: true, drained: true,
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(adapterWorkerResult({ reportId: 'adapter-resume' })) } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 } }),
          '',
        ].join('\n'),
      }
    },
  }
  const resumeAdapter = new CodexExecAdapter({
    runner: resumeRunner,
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  await resumeAdapter.launch({ ...base, continuationId: '11111111-1111-4111-8111-111111111111' })
  assert.deepEqual(calls[1].argv.slice(0, 2), ['exec', '--json'])
  assert.ok(calls[1].argv.indexOf('--sandbox') < calls[1].argv.indexOf('resume'))
  assert.equal(calls[1].argv[calls[1].argv.indexOf('resume') + 1], '11111111-1111-4111-8111-111111111111')
  assert.equal(calls[1].argv.includes('-p'), false)
  assert.equal(calls[1].argv.at(-2), '11111111-1111-4111-8111-111111111111')
  assert.equal(calls[1].argv.at(-1), '-')
})

test('external Codex child prompt carries one canonical mission with linear byte growth and rejects tampering before spawn', async () => {
  const calls = []
  const runner = {
    async run(spec) {
      calls.push(spec)
      return {
        status: 0, processOwned: true, exactArgv: true, drained: true,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: '12121212-1212-4212-8212-121212121212' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: JSON.stringify(adapterWorkerResult()) },
          }),
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0 },
          }),
          '',
        ].join('\n'),
      }
    },
  }
  const adapter = new CodexExecAdapter({
    runner,
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  const promptBytes = []
  const missionBytes = []
  for (const size of [4 * 1024, 16 * 1024]) {
    const sentinel = `MISSION_${size}_${'x'.repeat(size)}`
    const fields = adapterMissionFields('hash', `adapter-mission-${size}`, sentinel)
    await adapter.launch({
      ...WORKER_EXECUTION_POLICY,
      ...fields,
      physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
      dispatch: { brief: 'Complete the separately bound mission.', requestPointer: { path: 'request', hash: 'hash' } },
      environment: {}, sessionId: `adapter-mission-session-${size}`,
      reservationId: `adapter-mission-reservation-${size}`,
      onTerminalResult() {},
    })
    const stdin = calls.at(-1).stdin
    assert.equal(stdin.split(sentinel).length - 1, 1)
    assert.doesNotMatch(stdin,
      /AUTOPROMPT_REQUEST_ENVELOPE_V2|request_base64|request_argv_json|REQUEST_ARGV_BEGIN/u)
    promptBytes.push(Buffer.byteLength(stdin, 'utf8'))
    missionBytes.push(fields.missionBinding.canonicalMissionBytes)
  }
  assert.ok(promptBytes[1] - promptBytes[0] <= missionBytes[1] - missionBytes[0] + 64,
    JSON.stringify({ promptBytes, missionBytes }))

  const assignmentSentinel = `ASSIGNMENT_SINGLE_COPY_${'a'.repeat(8 * 1024)}`
  const assignmentFields = adapterMissionFields('hash', 'adapter-assignment-single-copy')
  await adapter.launch({
    ...WORKER_EXECUTION_POLICY,
    ...assignmentFields,
    physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
    dispatch: {
      brief: `Assignment: ${assignmentSentinel}`,
      briefBytes: Buffer.byteLength(assignmentSentinel, 'utf8'),
      fetchedEvidence: {
        briefSlice: {
          schemaVersion: 1,
          kind: 'context-brief-slice',
          fields: {
            assignment: assignmentSentinel,
            successChecklist: ['duplicate success'],
            ownership: ['workspace'],
            checks: ['duplicate check'],
            dependencies: ['preserve this dependency'],
            returnShape: { kind: 'preserve-this-return-shape' },
          },
        },
      },
      requestPointer: { path: 'request', hash: 'hash' },
    },
    canonicalAssignment: {
      requestedResult: assignmentSentinel,
      successChecklist: ['canonical success'],
      resources: [{ kind: 'directory', identity: 'workspace' }],
      checks: ['canonical check'],
    },
    environment: {}, sessionId: 'adapter-assignment-single-copy-session',
    reservationId: 'adapter-assignment-single-copy-reservation',
    onTerminalResult() {},
  })
  const assignmentInput = calls.at(-1).stdin
  assert.equal(assignmentInput.split(assignmentSentinel).length - 1, 1)
  assert.doesNotMatch(assignmentInput, /duplicate success|duplicate check/u)
  assert.match(assignmentInput, /preserve this dependency|preserve-this-return-shape/u)

  const unicodeEcho = `MISSION_ECHO_ユニコード_${'界'.repeat(8 * 1024)}`
  const canonicalSource = JSON.stringify({
    schemaVersion: 1,
    argv: ['--path', 'direct', '--', unicodeEcho, 'fix', 'literal path=roadmap'],
  })
  const projection = createCanonicalMissionProjection(canonicalSource, { strict: true })
  const echoWorkItemId = 'adapter-adversarial-mission-echo'
  const echoMissionBinding = bindCanonicalMissionForChild(projection, {
    sourceRequestHash: projection.sourceRequestHash,
    requestEnvelopeHash: 'hash',
    activationId: 'adapter-activation',
    generation: 1,
    workItemId: echoWorkItemId,
  })
  await adapter.launch({
    ...WORKER_EXECUTION_POLICY,
    activationId: 'adapter-activation', generation: 1, workItemId: echoWorkItemId,
    canonicalMission: projection.canonicalMission, missionBinding: echoMissionBinding,
    physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
    dispatch: {
      brief: `Assignment: ${unicodeEcho}`,
      route: 'direct',
      fetchedEvidence: {
        opaqueCanonicalMissionEcho: projection.canonicalMission,
        opaqueLongArgumentEcho: `Opaque ${unicodeEcho} echo`,
        verificationObligations: [{
          id: 'echo-case', kind: 'invariant',
          statement: `Before ${unicodeEcho} after`,
          cases: [{
            id: 'expected', phase: 'ordinary', polarity: 'must-hold',
            precondition: unicodeEcho,
            expectedObservation: `Observed ${unicodeEcho} exactly`,
          }],
        }],
      },
      requestPointer: { path: 'request', hash: 'hash' },
    },
    canonicalAssignment: {
      requestedResult: projection.canonicalMission,
      successChecklist: [{ id: 'success-1', description: unicodeEcho }],
      resources: [{ kind: 'directory', identity: 'workspace' }],
      checks: ['fix', 'prefix fixture suffix', `Check ${unicodeEcho} once`],
    },
    environment: {}, sessionId: 'adapter-adversarial-mission-echo-session',
    reservationId: 'adapter-adversarial-mission-echo-reservation',
    onTerminalResult() {},
  })
  const echoInput = calls.at(-1).stdin
  assert.equal(echoInput.split(unicodeEcho).length - 1, 1,
    'route-analyst echoes must not duplicate a large Unicode mission in child stdin')
  assert.equal(echoInput.split(projection.canonicalMission).length - 1, 1,
    'the exact canonical mission JSON must have one model-visible copy')
  assert.match(echoInput, /Before \[canonical-mission-argument:1:[a-f0-9]{64}\] after/u)
  assert.match(echoInput, /prefix fixture suffix/u,
    'short coincidental substrings must not be redacted')
  assert.doesNotMatch(echoInput, /Canonical assignment: .*"fix"/u,
    'an exact short whole-field echo is replaced by its stable mission reference')
  assert.match(echoInput, /"route":"direct"/u,
    'non-prose metadata matching a short argv literal must remain intact')
  assert.doesNotMatch(echoInput,
    /AUTOPROMPT_REQUEST_ENVELOPE_V2|request_base64|request_argv_json|REQUEST_ARGV_BEGIN|--path/u)

  const fields = adapterMissionFields('hash', 'adapter-mission-tamper', 'tamper sentinel')
  const spawnedBeforeTamper = calls.length
  await assert.rejects(adapter.launch({
    ...WORKER_EXECUTION_POLICY,
    ...fields,
    canonicalMission: `${fields.canonicalMission}x`,
    physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
    dispatch: { brief: 'Must fail before spawn.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {}, sessionId: 'adapter-mission-tamper-session',
    reservationId: 'adapter-mission-tamper-reservation',
  }), error => error.code === 'ACTIVATION_RECEIPT_INVALID')
  assert.equal(calls.length, spawnedBeforeTamper)
})

test('AP-RUN-013 two interleaved Codex sessions in one CWD bind only their own transcript', async () => {
  const pending = []
  const seenStops = []
  const runner = {
    run(spec) {
      return new Promise(resolve => {
        pending.push({ spec, resolve })
        if (pending.length !== 2) return
        const events = pending.map(({ spec }, index) => ({
          spec,
          threadId: `00000000-0000-4000-8000-00000000000${index + 1}`,
          marker: `session-${index + 1}`,
        }))
        for (const event of events) {
          event.spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: event.threadId }))
        }
        for (const event of events) {
          event.spec.onStdoutLine(JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: JSON.stringify(adapterWorkerResult({ reportId: event.marker })),
            },
          }))
        }
        for (const event of events) {
          event.spec.onStdoutLine(JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0 },
          }))
        }
        for (const item of pending) {
          item.resolve({ status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true })
        }
      })
    },
    async stop({ sessionId }) { seenStops.push(sessionId); return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner,
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  const identified = { one: [], two: [] }
  const makeRecord = id => ({
    ...WORKER_EXECUTION_POLICY,
    physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: `Do ${id}.`, requestPointer: { path: 'request', hash: 'hash' } },
    environment: {},
    workingDirectory: ROOT,
    sessionId: `run:DIRECT:${id}`,
    reservationId: `reservation:${id}`,
    onSessionIdentified(sessionId) { identified[id].push(sessionId) },
  })
  const [one, two] = await Promise.all([
    adapter.launch(makeRecord('one')),
    adapter.launch(makeRecord('two')),
  ])
  assert.deepEqual(identified, {
    one: ['00000000-0000-4000-8000-000000000001'],
    two: ['00000000-0000-4000-8000-000000000002'],
  })
  assert.equal(one.contextId, identified.one[0])
  assert.equal(two.contextId, identified.two[0])
  assert.equal(one.reportId, 'session-1')
  assert.equal(two.reportId, 'session-2')
  assert.deepEqual(seenStops.sort(), ['run:DIRECT:one', 'run:DIRECT:two'])
})

test('AP-RUN-032 proxy request and status records reject foreign generations and advance sequence', async t => {
  const directory = tempDirectory(t, 'autoprompt-proxy-binding-')
  const controlRoot = path.join(directory, 'control')
  fs.mkdirSync(controlRoot)
  const observed = []
  let foreignStatus = false
  let launchIndex = 0
  const processOwner = {
    async launch(spec) {
      launchIndex += 1
      const requestPath = spec.argv.at(-1)
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
      observed.push(request)
      fs.writeFileSync(request.stdoutPath, '')
      fs.writeFileSync(request.statusPath, `${JSON.stringify({
        schemaVersion: 2,
        activationId: request.activationId,
        generationId: foreignStatus ? request.generationId + 1 : request.generationId,
        sequence: request.sequence,
        argvHash: request.argvHash,
        codexPid: 1000 + launchIndex,
        code: 0,
        signal: null,
        error: null,
      })}\n`)
      return { ownershipId: `owned-${launchIndex}`, groupIdentity: `group-${launchIndex}` }
    },
    async observeRootExit(ownershipId) {
      return {
        ownershipId,
        groupIdentity: `group-${ownershipId.slice('owned-'.length)}`,
        status: 'DONE',
      }
    },
    async cancelGroup() { return { ownershipId: 'unused', groupIdentity: 'unused', status: 'CANCELLED' } },
  }
  const runner = new OwnedCodexProxyRunner({
    processOwner,
    controlRoot,
    targetKey: 'proxy-binding-target',
    activationId: 'activation-proxy-binding',
    generationId: 4,
    pollMs: 1,
  })
  const run = index => runner.run({
    executable: process.execPath,
    argv: ['-e', 'process.exit(0)'],
    cwd: directory,
    env: {},
    stdin: '',
    sessionId: `session-${index}`,
    reservationId: `reservation-${index}`,
  })
  await run(1)
  await run(2)
  assert.deepEqual(observed.map(({ activationId, generationId, sequence }) => ({
    activationId, generationId, sequence,
  })), [
    { activationId: 'activation-proxy-binding', generationId: 4, sequence: 1 },
    { activationId: 'activation-proxy-binding', generationId: 4, sequence: 2 },
  ])
  foreignStatus = true
  await assert.rejects(run(3), error => error.code === 'CODEX_PROXY_STATUS_INVALID')
})

test('owned external adapter incrementally stops a real fake CLI process tree after typed terminal usage', async t => {
  const directory = tempDirectory(t, 'autoprompt-fake-codex-cli-')
  const controlRoot = path.join(directory, 'control')
  const tracePath = path.join(directory, 'argv.json')
  const fakeCliPath = path.join(directory, 'fake-codex.cjs')
  fs.mkdirSync(controlRoot)
  fs.writeFileSync(fakeCliPath, [
    "'use strict'",
    "const fs = require('node:fs')",
    'const tracePath = process.argv[2]',
    "fs.writeFileSync(tracePath, JSON.stringify(process.argv.slice(3)))",
    "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'22222222-2222-4222-8222-222222222222'})+'\\n')",
    `process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(adapterWorkerResult({ reportId: 'owned-fake' }))})}})+'\\n')`,
    "process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_tokens:0}})+'\\n')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  const processAdapter = process.platform === 'win32'
    ? createWindowsJobAdapter({ controlRoot })
    : createPosixProcessAdapter()
  const owner = new ProcessOwner({
    adapter: processAdapter,
    registryPath: path.join(directory, 'process-registry.json'),
  })
  const reservationId = crypto.randomUUID()
  const environment = prepareProcessLaunchEnvironment(processAdapter, reservationId, process.env)
  const runner = new OwnedCodexProxyRunner({
    processOwner: owner,
    controlRoot,
    targetKey: 'fake-cli-target',
    pollMs: 5,
  })
  const adapter = new CodexExecAdapter({
    runner,
    executable: process.execPath,
    executableArgs: [fakeCliPath, tracePath],
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  const usage = []
  const result = await adapter.launch({
    ...WORKER_EXECUTION_POLICY,
    physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: 'Do one bounded fake-CLI trace.', requestPointer: { path: 'request', hash: 'hash' } },
    environment,
    sessionId: 'fake-cli-session',
    reservationId,
    onUsageDelta(delta) { usage.push(delta); return { continue: true } },
  })
  assert.equal(result.reportType, 'result')
  assert.equal(result.completionRequested, true)
  assert.deepEqual(usage, [{ noncachedInput: 1, cachedInput: 0, output: 1, reasoning: 0 }])
  const argv = JSON.parse(fs.readFileSync(tracePath, 'utf8'))
  assert.deepEqual(argv.slice(0, 2), ['exec', '--json'])
  assert.equal(argv.includes('--output-schema'), true)
  assert.equal(argv.includes('multi_agent'), true)
  assert.equal(argv.includes('multi_agent_v2'), true)
  await owner.assertTargetDrained('fake-cli-target')
  await owner.assertDrained()
})

test('successive owned resume generations persist terminal-before-stop and drain every real process group', async t => {
  const directory = tempDirectory(t, 'autoprompt-owned-resume-generations-')
  if (process.platform === 'win32') ensureWindowsPrivateAcl(directory)
  const fakeCliPath = path.join(directory, 'fake-codex.cjs')
  fs.writeFileSync(fakeCliPath, [
    "'use strict'",
    "process.stdin.resume()",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'44444444-4444-4444-8444-444444444444'})+'\\n')",
    `  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(adapterWorkerResult({ reportId: 'owned-resume' }))})}})+'\\n')`,
    "  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_tokens:0}})+'\\n')",
    '  setInterval(() => {}, 1000)',
    '})',
    '',
  ].join('\n'))

  for (let generation = 1; generation <= 3; generation += 1) {
    const controlRoot = path.join(directory, `control-${generation}`)
    fs.mkdirSync(controlRoot)
    const processAdapter = process.platform === 'win32'
      ? createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: directory })
      : createPosixProcessAdapter()
    const owner = new ProcessOwner({
      adapter: processAdapter,
      registryPath: path.join(directory, `process-registry-${generation}.json`),
    })
    const barriers = []
    const originalSignalOwned = processAdapter.signalOwned.bind(processAdapter)
    processAdapter.signalOwned = async (...args) => {
      barriers.push(`adapter-signal-${args[1]}`)
      return originalSignalOwned(...args)
    }
    const originalCancelGroup = owner.cancelGroup.bind(owner)
    owner.cancelGroup = async (...args) => {
      barriers.push('cancel-group-entry')
      const result = await originalCancelGroup(...args)
      barriers.push('cancel-group-complete')
      return result
    }
    const originalAssertDrained = owner.assertDrained.bind(owner)
    owner.assertDrained = async (...args) => {
      barriers.push('confirm-drained-entry')
      const result = await originalAssertDrained(...args)
      barriers.push('confirm-drained-complete')
      return result
    }
    const originalConfirmDrained = owner._confirmDrained.bind(owner)
    owner._confirmDrained = async (...args) => {
      barriers.push('confirm-group-drained-entry')
      const result = await originalConfirmDrained(...args)
      barriers.push('confirm-group-drained-complete')
      return result
    }
    const reservationId = crypto.randomUUID()
    const environment = prepareProcessLaunchEnvironment(processAdapter, reservationId, process.env)
    const runner = new OwnedCodexProxyRunner({
      processOwner: owner,
      controlRoot,
      targetKey: `fake-resume-target-${generation}`,
      pollMs: 5,
    })
    const originalStop = runner.stop.bind(runner)
    runner.stop = async (...args) => {
      barriers.push('runner-stop-entry')
      const result = await originalStop(...args)
      barriers.push('runner-stop-complete')
      return result
    }
    const adapter = new CodexExecAdapter({
      runner,
      executable: process.execPath,
      executableArgs: [fakeCliPath],
      targetPath: ROOT,
      profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
      outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
    })
    let timeout
    try {
      const result = await Promise.race([
        adapter.launch({
          ...WORKER_EXECUTION_POLICY,
          physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
          continuationId: generation === 1 ? null : '44444444-4444-4444-8444-444444444444',
          ...adapterMissionFields('hash'),
          dispatch: { brief: 'Resume one bounded fake-CLI turn.', requestPointer: { path: 'request', hash: 'hash' } },
          environment,
          sessionId: `fake-resume-session-${generation}`,
          reservationId,
          onUsageDelta() { return { continue: true } },
          onTerminalResult() { barriers.push('terminal-receipt-persisted') },
        }),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(Object.assign(new Error('owned resume generation timed out'), {
            code: 'OWNED_RESUME_TEST_TIMEOUT',
          })), 60_000)
        }),
      ])
      assert.equal(result.reportType, 'result')
    } catch (error) {
      await owner.cancelAll({ reason: 'bounded owned-resume test cleanup', graceMs: 0, killMs: 2000 }).catch(() => {})
      const registryPath = path.join(directory, `process-registry-${generation}.json`)
      const diagnostic = {
        generation,
        code: error.code,
        message: error.message,
        barriers,
        records: owner.listRecords(),
        registry: fs.existsSync(registryPath) ? fs.readFileSync(registryPath, 'utf8') : null,
        controlFiles: fs.existsSync(controlRoot)
          ? fs.readdirSync(controlRoot, { recursive: true }).map(value => String(value)).sort()
          : [],
      }
      assert.fail(JSON.stringify(diagnostic))
    } finally {
      clearTimeout(timeout)
    }
    assert.equal(barriers[0], 'terminal-receipt-persisted', JSON.stringify({ generation, barriers }))
    for (const required of [
      'runner-stop-entry', 'cancel-group-entry', 'adapter-signal-TERM',
      'confirm-group-drained-complete', 'cancel-group-complete', 'runner-stop-complete',
    ]) assert.ok(barriers.includes(required), JSON.stringify({ generation, barriers }))
    assert.ok(barriers.indexOf('terminal-receipt-persisted') < barriers.indexOf('runner-stop-entry'))
    assert.ok(barriers.indexOf('runner-stop-entry') < barriers.indexOf('cancel-group-entry'))
    assert.ok(barriers.indexOf('cancel-group-entry') < barriers.indexOf('cancel-group-complete'))
    await owner.assertTargetDrained(`fake-resume-target-${generation}`)
    await owner.assertDrained()
    await assertRegisteredOwnershipPidsDead(owner, controlRoot,
      `generation ${generation} left a registered observed/root/helper PID alive`)
    await assertNoOsProcessesReferencingPath(directory,
      `generation ${generation} reported drained while its helper/proxy/child process tree remained live`)
  }
})

test('per-child terminal receipts do not globally drain a legal live sibling or rescan terminal history', async t => {
  const directory = tempDirectory(t, 'autoprompt-owned-live-sibling-')
  if (process.platform === 'win32') ensureWindowsPrivateAcl(directory)
  const controlRoot = path.join(directory, 'control')
  fs.mkdirSync(controlRoot)
  const fakeCliPath = path.join(directory, 'fake-codex.cjs')
  fs.writeFileSync(fakeCliPath, [
    "'use strict'",
    "process.stdin.resume()",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'55555555-5555-4555-8555-555555555555'})+'\\n')",
    `  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(adapterWorkerResult({ reportId: 'owned-sibling' }))})}})+'\\n')`,
    "  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_tokens:0}})+'\\n')",
    '  setInterval(() => {}, 1000)',
    '})',
    '',
  ].join('\n'))
  const processAdapter = process.platform === 'win32'
    ? createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: directory })
    : createPosixProcessAdapter()
  const owner = new ProcessOwner({
    adapter: processAdapter,
    registryPath: path.join(directory, 'process-registry.json'),
  })
  let globalDrainCalls = 0
  const originalAssertDrained = owner.assertDrained.bind(owner)
  owner.assertDrained = async (...args) => {
    globalDrainCalls += 1
    return originalAssertDrained(...args)
  }
  const siblingReservationId = crypto.randomUUID()
  const sibling = await owner.launch({
    executable: process.execPath,
    argv: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: ROOT,
    env: prepareProcessLaunchEnvironment(processAdapter, siblingReservationId, process.env),
    shell: false,
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    sessionId: 'legal-live-sibling',
    reservationId: siblingReservationId,
    targetKey: 'shared-live-target',
    forWork: false,
  })
  const runner = new OwnedCodexProxyRunner({
    processOwner: owner,
    controlRoot,
    targetKey: 'shared-live-target',
    pollMs: 5,
  })
  const adapter = new CodexExecAdapter({
    runner,
    executable: process.execPath,
    executableArgs: [fakeCliPath],
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const reservationId = crypto.randomUUID()
    const result = await adapter.launch({
      ...WORKER_EXECUTION_POLICY,
      physicalExecutionPolicy: WORKER_EXECUTION_POLICY,
      continuationId: attempt === 1 ? null : '55555555-5555-4555-8555-555555555555',
      ...adapterMissionFields('hash'),
      dispatch: { brief: 'Complete while a legal sibling remains live.', requestPointer: { path: 'request', hash: 'hash' } },
      environment: prepareProcessLaunchEnvironment(processAdapter, reservationId, process.env),
      sessionId: `completed-child-${attempt}`,
      reservationId,
      onUsageDelta() { return { continue: true } },
    })
    assert.equal(result.reportType, 'result')
    assert.equal(globalDrainCalls, 0, 'per-child completion must not perform a global historical drain scan')
    assert.ok((await processAdapter.listOwned(sibling.groupIdentity)).length > 0,
      'a legal sibling must remain live until the terminal cancellation/finalization boundary')
  }
  assert.equal(owner.listRecords().filter(record => record.status === 'DONE').length, 3)
  assert.equal(owner.listRecords().filter(record => record.status === 'CANCELLED').length, 0)
  await owner.cancelAll({ reason: 'terminal-boundary sibling drain', graceMs: 0, killMs: 2000 })
  await owner.assertDrained()
  assert.equal((await processAdapter.listOwned(sibling.groupIdentity)).length, 0)
  assert.equal(globalDrainCalls, 2,
    'only cancelAll and the explicit final boundary assertion perform global drain checks')
  await assertRegisteredOwnershipPidsDead(owner, controlRoot,
    'terminal-boundary drain left a registered observed/root/helper PID alive')
  await assertNoOsProcessesReferencingPath(directory,
    'terminal-boundary drain reported success while a helper/proxy/child process remained live')
})

test('AP-CODEX-V2-036 concrete runtime repairs a checker FAIL in a bounded fresh Codex context, freezes C2, and rechecks', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-concrete-runtime-'))
  const pidTreeControlRoot = path.join(directory, 'pid-tree-control')
  t.after(() => {
    const remaining = killAllPersistentPidTrees(pidTreeControlRoot)
    fs.rmSync(directory, { recursive: true, force: true })
    assert.deepEqual(remaining, [], 'test cleanup left a persistent PID tree alive')
  })
  if (process.platform === 'win32') ensureWindowsPrivateAcl(directory)
  const activationRoot = path.join(directory, 'activation')
  const target = createTempGitTarget(directory)
  const detached = spawnSync('git', ['-C', target, 'checkout', '--quiet', '--detach', 'HEAD'], {
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(detached.status, 0, detached.stderr || detached.stdout)
  const detachedCommit = spawnSync('git', [
    '-C', target, 'commit', '--quiet', '--allow-empty', '-m', 'unreferenced detached runtime fixture',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(detachedCommit.status, 0, detachedCommit.stderr || detachedCommit.stdout)
  const detachedHeadOid = spawnSync('git', ['-C', target, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8', windowsHide: true,
  }).stdout.trim()
  const runId = 'apv2-concrete-default-runtime'
  fs.mkdirSync(activationRoot, { recursive: true })
  const record = createRunRecord({
    targetPath: target,
    canonicalProviderPrivateRoot: path.join(activationRoot, 'supervisor-runtime'),
    allowProjectMutation: true,
    readOnly: true,
    exactTree: true,
    runId,
    assertStartBoundary: false,
  })
  const profilePath = path.join(activationRoot, 'autoprompt.config.toml')
  const profile = strictLocalProfile()
  fs.writeFileSync(profilePath, profile, { mode: 0o600 })
  const configIsolationPath = path.join(activationRoot, 'empty.gitconfig')
  const ghConfigDir = path.join(activationRoot, 'gh-config')
  fs.writeFileSync(configIsolationPath, '', { mode: 0o600 })
  fs.mkdirSync(ghConfigDir, { mode: 0o700 })
  const enforcementProof = {
    schemaVersion: 1, provider: 'codex', profilePath,
    profileSha256: crypto.createHash('sha256').update(profile).digest('hex'),
    selectedProfile: 'autoprompt', strictConfig: true,
  }
  const enforcementProofPath = path.join(activationRoot, 'enforcement-proof.json')
  fs.writeFileSync(enforcementProofPath, `${JSON.stringify(enforcementProof, null, 2)}\n`)
  const repaired = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', '', '--repair',
    '--enforcement-proof', enforcementProofPath, '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.ok([0, 3].includes(repaired.status), repaired.stderr || repaired.stdout)
  const safety = require(path.join(ROOT, 'scripts', 'local-only-safety.cjs'))
  const preflightEnvironment = safety.createSafeChildGitEnvironment(target, process.env, {
    configIsolationPath, ghConfigDir,
  })
  const preflightSafety = safety.inspect(safety.discoverRepository(target), '', preflightEnvironment, {
    enforcementProof,
  })
  assert.equal(preflightSafety.mechanicallyEnforced, true, JSON.stringify(preflightSafety))
  const recommendationValue = recommendation('DIRECT')
  const decisionValue = decision('DIRECT')
  const missionSentinel = `CANONICAL_MISSION_SENTINEL_${'q'.repeat(16 * 1024)}`
  const fakeCliPath = path.join(activationRoot, 'fake-codex.cjs')
  const roleTracePath = path.join(activationRoot, 'model-role-trace.jsonl')
  fs.writeFileSync(fakeCliPath, [
    "'use strict'",
    "let input = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { input += chunk })",
    "process.stdin.on('end', () => {",
    "  const role = (/^role=(.+)$/m.exec(input) || [,'unknown'])[1]",
    `  const tracePath = ${JSON.stringify(roleTracePath)}`,
    "  const traceFs = require('node:fs')",
    "  const priorTrace = traceFs.existsSync(tracePath) ? traceFs.readFileSync(tracePath,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : []",
    "  const roleAttempt = priorTrace.filter(item => item.role === role).length + 1",
    "  const checkerAttempt = priorTrace.filter(item => /checker|reviewer|tester/.test(item.role)).length + 1",
    "  const assignmentMatch = /^Canonical assignment: (.+)$/m.exec(input)",
    "  const contextMatch = /^Canonical context envelope: (.+)$/m.exec(input)",
    "  const assignment = assignmentMatch ? JSON.parse(assignmentMatch[1]) : null",
    "  const context = contextMatch ? JSON.parse(contextMatch[1]) : null",
    "  const traceGit = require('node:child_process')",
    "  const gitRoot = process.env.AUTOPROMPT_CHECKER_CANDIDATE_ROOT || process.cwd()",
    "  const gitBranch = traceGit.spawnSync('git',['-C',gitRoot,'branch','--show-current'],{encoding:'utf8'}).stdout.trim()",
    "  const gitHead = traceGit.spawnSync('git',['-C',gitRoot,'rev-parse','--verify','HEAD'],{encoding:'utf8'}).stdout.trim()",
    `  const missionSentinel = ${JSON.stringify(missionSentinel)}`,
    "  const sentinelCount = input.split(missionSentinel).length - 1",
    "  traceFs.appendFileSync(tracePath, JSON.stringify({role,roleAttempt,assignmentId:assignment&&assignment.assignmentId,forkTurns:context&&context.fork_turns,repairContextBinding:context&&context.fetchedEvidence&&context.fetchedEvidence.repairContextBinding,sentinelCount,inputBytes:Buffer.byteLength(input),hasStructuralEnvelope:/AUTOPROMPT_REQUEST_ENVELOPE_V2|request_base64|REQUEST_ARGV_BEGIN/.test(input),hasRawExactRequest:Boolean(context&&context.exactRequest),argv:process.argv.slice(2),cwd:process.cwd(),gitBranch,gitHead,cacheEnvironment:{TMPDIR:process.env.TMPDIR,TMP:process.env.TMP,TEMP:process.env.TEMP,XDG_CACHE_HOME:process.env.XDG_CACHE_HOME,PYTHONPYCACHEPREFIX:process.env.PYTHONPYCACHEPREFIX,PYTHONDONTWRITEBYTECODE:process.env.PYTHONDONTWRITEBYTECODE,AUTOPROMPT_WORKER_CACHE_ROOT:process.env.AUTOPROMPT_WORKER_CACHE_ROOT}})+'\\n')",
    `  const recommendation = ${JSON.stringify(recommendationValue)}`,
    `  const decision = ${JSON.stringify(decisionValue)}`,
    "  const now = new Date().toISOString()",
    "  const checkerHarnessCommand = JSON.stringify([process.execPath,'--test','focused.test.cjs'])",
    "  const checkerHarnessOutput = checkerAttempt === 1 ? 'TAP version 13\\nnot ok 1 - frozen candidate behavior\\n# fail 1' : `TAP version 13\\nok 1 - frozen candidate behavior\\n# pass 1`",
    "  const checkerHarnessExitCode = checkerAttempt === 1 ? 1 : 0",
    "  const checkerHarnessStatus = checkerAttempt === 1 ? 'failed' : 'completed'",
    "  const checkerOutcomes = status => assignment.checks.map(command=>({command,status}))",
    "  if (role === 'worker') traceFs.writeFileSync(require('node:path').join(process.cwd(),'src','example.js'), `module.exports = '${roleAttempt === 1 ? 'rejected' : 'complete'}'\\n`)",
    "  let output",
    "  if (role === 'route-analyst') output = recommendation",
    "  else if (role === 'run-owner') output = decision",
    "  else if (/checker|reviewer|tester/.test(role)) output = {",
    "    schemaVersion:'2.0.0', code:checkerAttempt === 1 ? 'FAIL' : 'PASS',",
    "    description:checkerAttempt === 1 ? 'The checked result does not satisfy one or more named requirements.' : 'The checked result satisfies every requirement assigned to this check.',",
    "    stateClass:'terminal', runId:assignment.runId, requestEnvelopeHash:assignment.requestEnvelopeHash,",
    "    currentVersionHash:context.candidateHash, completedResults:[], nextReadyWork:[],",
    "    cause:{event:checkerAttempt === 1 ? 'ASSERTION_FAILED' : 'CHECK_COMPLETE',reason:checkerAttempt === 1 ? 'Exact candidate still contains the injected behavior defect.' : 'Fake local checker accepted the exact repaired candidate.',unblockPath:checkerAttempt === 1 ? 'repair the receipt-bound implementation defect' : null},",
    "    payloadSchemaId:'autoprompt.check.fake.v2', payload:checkerAttempt === 1 ? {findingIds:['AP-RUN-026'],testOutcomes:checkerOutcomes('FAIL')} : {evidenceIds:[`fake-cli-underlying-evidence:${assignment.assignmentId}`],referenceMethod:{methodClass:/tester/.test(role)?'black-box-boundary':'requirements-review',source:`${role} independent source`,procedure:`${role} independently derives and executes expected observations`,expectedOutputDerivedFromSubjectCode:false,subjectLogicReimplemented:false,positiveInvariants:[`${role} accepted behavior`],negativeInvariants:[`${role} rejected behavior`],boundaryInvariants:[`${role} edge behavior`]},testOutcomes:checkerOutcomes('PASS'),findings:[{id:'AP-CODEX-RUN-RECORD-001',severity:'P2',disposition:'advisory',resolution:'open'}]}, recordedAt:now",
    "  }",
    "  else output = {",
    "    schemaVersion:'2.0.0', reportType:'result', reportId:`result:${assignment.assignmentId}` ,",
    "    runId:assignment.runId, assignmentId:assignment.assignmentId, logicalRoleId:assignment.logicalRoleId,",
    "    physicalRoleId:assignment.physicalRoleId, requestEnvelopeHash:assignment.requestEnvelopeHash, findingIds:assignment.findingIds,",
    "    startedAt:now, endedAt:now, filesChanged:role === 'worker' ? ['src/example.js'] : [], resourcesChanged:[], behaviorChanged:['Fake local work completed.'],",
    "    commands:[], successItems:assignment.successChecklist.map(item => ({id:item.id,status:'pass',evidenceIds:['fake-cli']})),",
    "    remainingConcerns:[], allAssignedItemsPass:true,",
    "    requestedTransition:{event:'WORK_ITEM_VERIFIED',reason:'Every assigned fake result passed.',invalidateEvidenceIds:[]}",
    "  }",
    "  if (role === 'diagnostic-probe') output.commands = [{command:'read-only representative capability probe',exitCode:0,result:'PASS'}]",
    "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'33333333-3333-4333-8333-333333333333'})+'\\n')",
    "  if (/checker|reviewer|tester/.test(role)) process.stdout.write(JSON.stringify({type:'item.completed',item:{id:`checker-harness-${checkerAttempt}`,type:'command_execution',command:checkerHarnessCommand,status:checkerHarnessStatus,exit_code:checkerHarnessExitCode,aggregated_output:checkerHarnessOutput}})+'\\n')",
    "  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({canonicalJson:JSON.stringify(output)})}})+'\\n')",
    "  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_tokens:0}})+'\\n')",
    "  setInterval(() => {}, 1000)",
    "})",
    '',
  ].join('\n'))
  const metadataBytes = fs.readFileSync(record.paths.metadataPath)
  const requestArgv = [missionSentinel]
  const requestCanonicalJson = JSON.stringify({ schemaVersion: 1, argv: requestArgv })
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const modelSelection = {
    schemaVersion: 1, mode: 'provider-default', selector: 'provider-default', models: [],
    effort: null, castingHash: CANDIDATE_A, agentDefinitionsHash: CANDIDATE_A, registry: null,
    probeAcceptance: {
      strictConfig: true, profileAcceptedAt: new Date().toISOString(),
      explicitModelAndEffortAssignments: false,
    },
  }
  const activation = {
    activationAttestation: { hash: '1'.repeat(64) },
    activationRoot,
    enforcementProof,
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=concrete',
    modelRegistry: null,
    modelSelection,
    profilePath,
    requestArgv,
    runId,
    supervisorRuntime: {
      runPath: record.runPath, runId,
      metadataSha256: crypto.createHash('sha256').update(metadataBytes).digest('hex'),
      targetIdentity: record.targetIdentity,
    },
    record: {
      target: { realpath: target },
      request: { canonicalJson: requestCanonicalJson },
      capability: { generation: 1, expiresAt, parentSession: 'concrete-parent' },
      contractVersions: {
        settings: '2.0.0', requestEnvelopeEntry: '2.0.0', outcome: '2.0.0',
        providerCapabilities: '2.0.0', activationRequest: '1.0.0',
      },
      supervisorEntry: { promptSha256: '2'.repeat(64) },
      providerAttestation: { attestation: { activationNonce: '-Nun56FgLGR7mAQLNyqoNUrtGc7NNbCR' } },
      activationBoundary: {
        gitConfig: configIsolationPath, ghConfigDir,
        enforcementProof: { path: enforcementProofPath },
        supervisorAdapterSha256: '3'.repeat(64), payloadManifestSha256: '4'.repeat(64),
      },
      modelSelection,
    },
  }
  let finalMonotonic = 0
  const options = createDefaultRuntimeOptions({
    activation,
    probe: {
      supported: true, executable: process.execPath, cliVersion: 'fake-codex 1.0.0',
      evidenceHashes: ['5'.repeat(64)],
    },
    context: {
      executableArgs: [fakeCliPath], expectedBranch: '', providerMaximum: 2,
      environment: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: path.join(directory, 'foreign-ambient-hooks'),
      },
      tokenLimit: 1000, sessionLimit: 16, launchLimit: 16,
      trustedTestDeclarations: { controlPlane: [{
        id: 'focused-runtime-check', executable: process.execPath,
        argv: ['--test', 'focused.test.cjs'],
      }] },
      residualRiskAuthority({ findings }) {
        return { authority: 'codex-integration-run-owner', acceptedFindings: findings }
      },
      monotonicNow: () => ++finalMonotonic,
      processAdapter: createPersistentPidTreeAdapter({ controlRoot: pidTreeControlRoot }),
    },
  })
  let factoryError = null
  const concreteRecordFactory = options.recordFactory
  options.recordFactory = async input => {
    try { return await concreteRecordFactory(input) } catch (error) { factoryError = error; throw error }
  }
  for (const dependency of ['requestPointerFactory', 'finalizerFactory']) {
    const original = options[dependency]
    options[dependency] = async input => {
      try { return await original(input) } catch (error) { factoryError = error; throw error }
    }
  }
  const result = await new CodexSupervisorRuntime(options).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify({ result, factoryError: factoryError && {
    code: factoryError.code, message: factoryError.message, details: factoryError.details,
  } }))
  assert.equal(result.route, 'DIRECT')
  assert.equal(result.scheduler.counters.totalLaunches,
    4 + result.terminalEnvelope.checkCount)
  assert.equal(result.scheduler.rootAccounting.status, 'completed')
  assert.deepEqual(livePersistentPidTrees(pidTreeControlRoot), [])
  const unsupportedDecision = {
    ...decision('DIRECT'),
    gateSelection: {
      baseWorkType: 'codex-run-record-integration-fixture', resultFormat: 'new-build',
      artifactOverlays: ['executable-code'], acceptanceOverlays: ['failing-to-passing-behavior'],
      riskOverlays: [], riskEvidence: {},
    },
  }
  await assert.rejects(
    () => options.executeRoute({
      route: 'DIRECT', decision: unsupportedDecision,
      completeRetainedLease() {},
      launch: async () => {
        throw Object.assign(new Error('framework run-record state admitted'), {
          code: 'FRAMEWORK_RUN_RECORD_PATH_PROVEN',
        })
      },
    }),
    error => error.code === 'FRAMEWORK_RUN_RECORD_PATH_PROVEN',
  )
  const frameworkDirectory = path.join(record.runPath, 'work', 'framework-orchestration')
  const frameworkFiles = fs.readdirSync(frameworkDirectory)
  assert.equal(frameworkFiles.length, 1)
  assert.match(frameworkFiles[0], /^[a-f0-9]{64}\.json$/)
  const frameworkState = JSON.parse(fs.readFileSync(path.join(frameworkDirectory, frameworkFiles[0]), 'utf8'))
  assert.equal(frameworkState.status, 'ADMITTED')

  const residualDirectory = path.join(record.runPath, 'checks', 'residual-risk-authority')
  const residualFiles = fs.readdirSync(residualDirectory)
  assert.equal(residualFiles.length, 1)
  assert.match(residualFiles[0], /^[a-f0-9]{64}\.json$/)
  const residualRelative = `checks/residual-risk-authority/${residualFiles[0]}`
  const residualReceipt = JSON.parse(fs.readFileSync(record.resolve(residualRelative), 'utf8'))
  assert.equal(residualReceipt.candidateHash, residualFiles[0].slice(0, -'.json'.length))
  assert.deepEqual(residualReceipt.acceptedFindingIds, ['AP-CODEX-RUN-RECORD-001'])
  const reopenedRecord = openRunRecord(record.runPath)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(reopenedRecord.resolve(residualRelative), 'utf8')),
    residualReceipt,
  )
  assert.throws(
    () => reopenedRecord.write(residualRelative, `${JSON.stringify(residualReceipt)}\n`),
    error => error.code === 'RUN_RECORD_UNSAFE' && /immutable content-addressed/i.test(error.message),
  )
  assert.equal(fs.existsSync(record.paths.accounting.logPath), true)
  assert.equal(fs.existsSync(record.paths.accounting.snapshotPath), true)
  assert.equal(fs.existsSync(record.paths.terminalPath), true)
  assert.equal(fs.existsSync(record.paths.processRegistry), true)
  const persistedDecision = JSON.parse(fs.readFileSync(record.resolve('route/decision.json'), 'utf8'))
  assert.equal(persistedDecision.route, 'DIRECT')
  const terminal = JSON.parse(fs.readFileSync(record.paths.terminalPath, 'utf8'))
  assert.equal(terminal.outcome, 'DONE')
  assert.equal(terminal.terminalEnvelope.code, 'DONE')
  const checkerAssignment = JSON.parse(fs.readFileSync(record.resolve(
    `work/assignments/${crypto.createHash('sha256').update('independent-check-1').digest('hex')}.json`,
  ), 'utf8'))
  const expectedCheckerCommandHash = crypto.createHash('sha256')
    .update(JSON.stringify([process.execPath, '--test', 'focused.test.cjs'])).digest('hex')
  assert.deepEqual(
    [...new Set(checkerAssignment.verificationObservationBinding.observations
      .flatMap(item => item.exactCommandHashes))],
    [expectedCheckerCommandHash],
  )
  const traced = fs.readFileSync(roleTracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const tracedRoles = traced.map(item => item.role)
  assert.deepEqual([...new Set(traced.map(item => item.gitBranch))], [''])
  assert.deepEqual([...new Set(traced.map(item => item.gitHead))], [detachedHeadOid])
  assert.equal(tracedRoles.filter(role => role === 'route-analyst').length, 1)
  assert.equal(tracedRoles.filter(role => role === 'run-owner').length, 0)
  assert.equal(tracedRoles.filter(role => role === 'worker').length, 2)
  assert.equal(tracedRoles.filter(role => /checker|reviewer|tester/.test(role)).length, 2)
  const repairWorker = traced.find(item => item.role === 'worker' && item.roleAttempt === 2)
  assert.equal(repairWorker.assignmentId, 'work-1-repair-1')
  assert.equal(repairWorker.forkTurns, 'none')
  assert.equal(repairWorker.argv.includes('resume'), false)
  assert.equal(repairWorker.repairContextBinding.nativeProviderHistoryInherited, false)
  for (const child of traced) {
    assert.equal(child.sentinelCount, 1, `${child.role} received a duplicate canonical mission`)
    assert.equal(child.hasStructuralEnvelope, false)
    assert.equal(child.hasRawExactRequest, false)
    assert.ok(child.inputBytes < Buffer.byteLength(missionSentinel) + 96 * 1024)
  }
  for (const worker of traced.filter(item => item.role === 'worker')) {
    const cacheRoot = worker.cacheEnvironment.AUTOPROMPT_WORKER_CACHE_ROOT
    assert.equal(worker.cacheEnvironment.PYTHONDONTWRITEBYTECODE, '1')
    assert.equal(worker.cacheEnvironment.PYTHONPYCACHEPREFIX, cacheRoot)
    assert.equal(worker.cacheEnvironment.XDG_CACHE_HOME, cacheRoot)
    assert.equal(worker.cacheEnvironment.TMPDIR, cacheRoot)
    assert.equal(worker.cacheEnvironment.TMP, cacheRoot)
    assert.equal(worker.cacheEnvironment.TEMP, cacheRoot)
    assert.equal(path.resolve(cacheRoot).startsWith(`${path.resolve(worker.cwd)}${path.sep}`), false)
  }
  const stateEvents = fs.readFileSync(record.paths.eventLog.logPath, 'utf8')
  assert.doesNotMatch(stateEvents, /CRASH_DETECTED|RESUME_REQUESTED|EXACT_STATE_RESTORED/)
  assert.match(stateEvents, /IMPLEMENTATION_DEFECT/)
  assert.match(stateEvents, /REPAIR_READY/)
  assert.doesNotMatch(stateEvents, /ENVIRONMENT_BLOCKED|WORKER_CONTEXT_LOST/)
  await assertNoOsProcessesReferencingPath(directory,
    'the clean concrete runtime reached DONE while a proxy/child process remained live')
})

test('AP-RUN-037 production supervisor resumes a crashed worker with a fresh generation budget window and drains its process tree', {
  timeout: 180_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-production-resume-'))
  const pidTreeControlRoot = path.join(directory, 'pid-tree-control')
  t.after(() => {
    const remaining = killAllPersistentPidTrees(pidTreeControlRoot)
    fs.rmSync(directory, { recursive: true, force: true })
    assert.deepEqual(remaining, [], 'AP-RUN-037 cleanup left a persistent PID tree alive')
  })
  if (process.platform === 'win32') ensureWindowsPrivateAcl(directory)
  const activationRoot = path.join(directory, 'activation')
  const target = createTempGitTarget(directory)
  const runId = 'apv2-production-resume-runtime'
  fs.mkdirSync(activationRoot, { recursive: true })
  const record = createRunRecord({
    targetPath: target,
    canonicalProviderPrivateRoot: path.join(activationRoot, 'supervisor-runtime'),
    allowProjectMutation: true,
    readOnly: true,
    exactTree: true,
    runId,
    assertStartBoundary: false,
  })
  const profilePath = path.join(activationRoot, 'autoprompt.config.toml')
  const profile = strictLocalProfile()
  fs.writeFileSync(profilePath, profile, { mode: 0o600 })
  const configIsolationPath = path.join(activationRoot, 'empty.gitconfig')
  const ghConfigDir = path.join(activationRoot, 'gh-config')
  fs.writeFileSync(configIsolationPath, '', { mode: 0o600 })
  fs.mkdirSync(ghConfigDir, { mode: 0o700 })
  const enforcementProof = {
    schemaVersion: 1, provider: 'codex', profilePath,
    profileSha256: crypto.createHash('sha256').update(profile).digest('hex'),
    selectedProfile: 'autoprompt', strictConfig: true,
  }
  const enforcementProofPath = path.join(activationRoot, 'enforcement-proof.json')
  fs.writeFileSync(enforcementProofPath, `${JSON.stringify(enforcementProof, null, 2)}\n`)
  const repaired = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair',
    '--enforcement-proof', enforcementProofPath, '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.ok([0, 3].includes(repaired.status), repaired.stderr || repaired.stdout)

  const recommendationValue = recommendation('DIRECT')
  const decisionValue = decision('DIRECT')
  const fakeCliPath = path.join(activationRoot, 'fake-codex.cjs')
  fs.writeFileSync(fakeCliPath, [
    "'use strict'",
    "let input = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { input += chunk })",
    "process.stdin.on('end', () => {",
    "  const role = (/^role=(.+)$/m.exec(input) || [,'unknown'])[1]",
    "  const assignmentMatch = /^Canonical assignment: (.+)$/m.exec(input)",
    "  const contextMatch = /^Canonical context envelope: (.+)$/m.exec(input)",
    "  const assignment = assignmentMatch ? JSON.parse(assignmentMatch[1]) : null",
    "  const context = contextMatch ? JSON.parse(contextMatch[1]) : null",
    `  const recommendation = ${JSON.stringify(recommendationValue)}`,
    `  const decision = ${JSON.stringify(decisionValue)}`,
    "  const now = new Date().toISOString()",
    "  const checkerHarnessCommand = JSON.stringify([process.execPath,'--test','focused.test.cjs'])",
    "  const checkerHarnessOutput = `fake-checker-harness:${assignment&&assignment.assignmentId}`",
    "  const checkerOutcomes = status => assignment.checks.map(command=>({command,status}))",
    "  if (role === 'worker') require('node:fs').writeFileSync(require('node:path').join(process.cwd(),'src','example.js'), \"module.exports = 'resumed'\\n\")",
    "  let output",
    "  if (role === 'route-analyst') output = recommendation",
    "  else if (role === 'run-owner') output = decision",
    "  else if (/checker|reviewer|tester/.test(role)) output = {",
    "    schemaVersion:'2.0.0', code:'PASS', description:'The checked result satisfies every requirement assigned to this check.',",
    "    stateClass:'terminal', runId:assignment.runId, requestEnvelopeHash:assignment.requestEnvelopeHash,",
    "    currentVersionHash:context.candidateHash, completedResults:[], nextReadyWork:[],",
    "    cause:{event:'CHECK_COMPLETE',reason:'Fake checker accepted the resumed candidate.',unblockPath:null},",
    "    payloadSchemaId:'autoprompt.check.fake.v2', payload:{evidenceIds:[`fake-cli-underlying-evidence:${assignment.assignmentId}`],referenceMethod:{methodClass:/tester/.test(role)?'black-box-boundary':'requirements-review',source:`${role} independent source`,procedure:`${role} independently derives and executes expected observations`,expectedOutputDerivedFromSubjectCode:false,subjectLogicReimplemented:false,positiveInvariants:[`${role} accepted behavior`],negativeInvariants:[`${role} rejected behavior`],boundaryInvariants:[`${role} edge behavior`]},testOutcomes:checkerOutcomes('PASS')}, recordedAt:now",
    "  }",
    "  else output = {",
    "    schemaVersion:'2.0.0', reportType:'result', reportId:`result:${assignment.assignmentId}` ,",
    "    runId:assignment.runId, assignmentId:assignment.assignmentId, logicalRoleId:assignment.logicalRoleId,",
    "    physicalRoleId:assignment.physicalRoleId, requestEnvelopeHash:assignment.requestEnvelopeHash, findingIds:assignment.findingIds,",
    "    startedAt:now, endedAt:now, filesChanged:role === 'worker' ? ['src/example.js'] : [], resourcesChanged:[],",
    "    behaviorChanged:['The fake product edit survived supervisor crash recovery.'], commands:[],",
    "    successItems:assignment.successChecklist.map(item => ({id:item.id,status:'pass',evidenceIds:['fake-cli']})),",
    "    remainingConcerns:[], allAssignedItemsPass:true,",
    "    requestedTransition:{event:'WORK_ITEM_VERIFIED',reason:'Every resumed fake result passed.',invalidateEvidenceIds:[]}",
    "  }",
    "  if (role === 'diagnostic-probe') output.commands = [{command:'read-only representative capability probe',exitCode:0,result:'PASS'}]",
    "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'77777777-7777-4777-8777-777777777777'})+'\\n')",
    "  if (/checker|reviewer|tester/.test(role)) process.stdout.write(JSON.stringify({type:'item.completed',item:{id:`checker-harness-${assignment.assignmentId}`,type:'command_execution',command:checkerHarnessCommand,status:'completed',exit_code:0,aggregated_output:checkerHarnessOutput}})+'\\n')",
    "  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({canonicalJson:JSON.stringify(output)})}})+'\\n')",
    "  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_tokens:0}})+'\\n')",
    "  setInterval(() => {}, 1000)",
    "})",
    '',
  ].join('\n'))

  const metadataBytes = fs.readFileSync(record.paths.metadataPath)
  const requestArgv = ['implement', 'the', 'crash-resumable', 'widget']
  const requestCanonicalJson = JSON.stringify({ schemaVersion: 1, argv: requestArgv })
  const modelSelection = {
    schemaVersion: 1, mode: 'provider-default', selector: 'provider-default', models: [],
    effort: null, castingHash: CANDIDATE_A, agentDefinitionsHash: CANDIDATE_A, registry: null,
    probeAcceptance: {
      strictConfig: true, profileAcceptedAt: new Date().toISOString(),
      explicitModelAndEffortAssignments: false,
    },
  }
  const activation = {
    activationAttestation: { hash: '1'.repeat(64) },
    activationRoot,
    enforcementProof,
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=production-resume',
    modelRegistry: null,
    modelSelection,
    profilePath,
    requestArgv,
    runId,
    supervisorRuntime: {
      runPath: record.runPath, runId,
      metadataSha256: crypto.createHash('sha256').update(metadataBytes).digest('hex'),
      targetIdentity: record.targetIdentity,
    },
    record: {
      target: { realpath: target },
      request: { canonicalJson: requestCanonicalJson },
      capability: {
        generation: 1,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        parentSession: 'production-resume-parent',
      },
      contractVersions: {
        settings: '2.0.0', requestEnvelopeEntry: '2.0.0', outcome: '2.0.0',
        providerCapabilities: '2.0.0', activationRequest: '1.0.0',
      },
      supervisorEntry: { promptSha256: '2'.repeat(64) },
      providerAttestation: { attestation: { activationNonce: 'production-resume-nonce' } },
      activationBoundary: {
        gitConfig: configIsolationPath, ghConfigDir,
        enforcementProof: { path: enforcementProofPath },
        supervisorAdapterSha256: '3'.repeat(64), payloadManifestSha256: '4'.repeat(64),
      },
      modelSelection,
    },
  }

  const crashInputPath = path.join(activationRoot, 'worker-crash-input.json')
  const crashProgressPath = path.join(activationRoot, 'worker-crash-progress.json')
  const crashTracePath = path.join(activationRoot, 'worker-crash-trace.jsonl')
  const crashHelperPath = path.join(activationRoot, 'worker-crash.cjs')
  fs.writeFileSync(crashHelperPath, [
    "'use strict'",
    "const fs = require('node:fs')",
    `const { CodexSupervisorRuntime, createDefaultRuntimeOptions } = require(${JSON.stringify(path.join(WORKFLOW, 'phase-budget.js'))})`,
    `const { createPersistentPidTreeAdapter } = require(${JSON.stringify(path.join(ROOT, 'tests', 'fixtures', 'codex-persistent-pid-tree-adapter.cjs'))})`,
    "const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))",
    'const options = createDefaultRuntimeOptions({',
    '  activation: input.activation,',
    "  probe: {supported:true,executable:process.execPath,cliVersion:'fake-codex 1.0.0',evidenceHashes:['5'.repeat(64)]},",
    "  context: {executableArgs:[input.fakeCliPath],expectedBranch:'main',providerMaximum:2,tokenLimit:1000,sessionLimit:16,launchLimit:16,trustedTestDeclarations:{controlPlane:[{id:'focused-runtime-check',executable:process.execPath,argv:['--test','focused.test.cjs']}]},processAdapter:createPersistentPidTreeAdapter({controlRoot:input.pidTreeControlRoot})},",
    '})',
    'const originalRecordFactory = options.recordFactory',
    'options.recordFactory = async request => {',
    '  const record = await originalRecordFactory(request)',
    '  const persist = options.persistRecoveryCheckpoint',
    '  options.persistRecoveryCheckpoint = payload => {',
    '    const result = persist(payload)',
    "    const live = payload.schedulerCheckpoint && payload.schedulerCheckpoint.liveRecords || []",
    "    fs.appendFileSync(input.tracePath, `${JSON.stringify({at:Date.now(),cause:payload.cause,live:live.map(item=>({logicalRole:item.logicalRole,status:item.status}))})}\\n`)",
    "    if (payload.cause.kind === 'THREAD_STARTED' && live.some(item => item.logicalRole === 'worker')) {",
    "      fs.writeFileSync(input.progressPath, JSON.stringify({cause:payload.cause,budget:options.budgetController.snapshot(),liveRecords:live,records:options.processOwner.listRecords()}))",
    '      process.exit(91)',
    '    }',
    '    return result',
    '  }',
    '  return record',
    '}',
    'new CodexSupervisorRuntime(options).start().then(',
    "  result => { process.stderr.write(`unexpected terminal ${JSON.stringify(result)}\\n`); process.exit(92) },",
    "  error => { process.stderr.write(`${error.stack || error}\\n`); process.exit(93) },",
    ')',
    '',
  ].join('\n'))
  fs.writeFileSync(crashInputPath, `${JSON.stringify({
    activation, fakeCliPath, pidTreeControlRoot, progressPath: crashProgressPath, tracePath: crashTracePath,
  })}\n`)

  const crashed = await runBoundedNode([crashHelperPath, crashInputPath], { cwd: ROOT, timeoutMs: 90_000 })
  const crashTrace = fs.existsSync(crashTracePath) ? fs.readFileSync(crashTracePath, 'utf8') : ''
  assert.equal(crashed.timedOut, false, crashed.stderr || crashed.stdout || crashTrace)
  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout)
  assert.equal(fs.existsSync(crashProgressPath), true)
  const crashProgress = JSON.parse(fs.readFileSync(crashProgressPath, 'utf8'))
  assert.equal(crashProgress.cause.kind, 'THREAD_STARTED')
  assert.equal(crashProgress.budget.generation, 1)
  assert.ok(crashProgress.budget.launches >= 2)
  const crashedWorkerLease = crashProgress.liveRecords.find(item => item.logicalRole === 'worker')
  assert.ok(crashedWorkerLease && crashedWorkerLease.crashBinding,
    'the production crash must persist the scheduler worker lease and crash binding')
  const crashedWorkerRecord = crashProgress.records.find(item =>
    item.reservationId === crashedWorkerLease.crashBinding.reservationId)
  assert.equal(crashedWorkerRecord && crashedWorkerRecord.status, 'RUNNING',
    'the production crash must persist its worker ownership record before supervisor exit')
  assert.match(crashedWorkerRecord.groupIdentity, /^persistent-pid-tree:v1:\d+$/)

  activation.record.capability.generation = 2
  const options = createDefaultRuntimeOptions({
    activation,
    probe: {
      supported: true, executable: process.execPath, cliVersion: 'fake-codex 1.0.0',
      evidenceHashes: ['5'.repeat(64)],
    },
    context: {
      executableArgs: [fakeCliPath], expectedBranch: 'main', providerMaximum: 2,
      tokenLimit: 1000, sessionLimit: 16, launchLimit: 16,
      trustedTestDeclarations: { controlPlane: [{
        id: 'focused-runtime-check', executable: process.execPath,
        argv: ['--test', 'focused.test.cjs'],
      }] },
      processAdapter: createPersistentPidTreeAdapter({ controlRoot: pidTreeControlRoot }),
    },
  })
  const result = await new CodexSupervisorRuntime(options).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  const physicalRecords = options.processOwner.listRecords()
  assert.deepEqual(physicalRecords
    .filter(item => item.sessionId.includes(':process-probe'))
    .map(item => item.sessionId)
    .sort(), [
      `${runId}:generation:1:process-probe`,
      `${runId}:generation:2:process-probe`,
    ], 'each crash generation owns one non-aliasing process conformance session')
  assert.deepEqual(physicalRecords
    .filter(item => item.sessionId.endsWith(':DIRECT:launch-000002'))
    .map(item => item.sessionId)
    .sort(), [
      `${runId}:generation:1:DIRECT:launch-000002`,
      `${runId}:generation:2:DIRECT:launch-000002`,
    ], 'the adopted logical worker gets exactly one replacement physical continuation, never an extra product retry')
  assert.equal(result.schedulerState.attempts['work-1'], 1,
    'physical crash continuation does not buy a second logical product attempt')
  const resumedBudget = options.budgetController.snapshot()
  assert.equal(resumedBudget.generation, 2)
  assert.ok(resumedBudget.generationStartedAtElapsedMs >= crashProgress.budget.consumedWallMs,
    'resume must open generation 2 after the consumed generation-1 window')
  for (const field of ['consumedWallMs', 'tokensUsed', 'sessionsStarted', 'launches']) {
    assert.ok(resumedBudget[field] >= crashProgress.budget[field], `${field} reset across production resume`)
  }
  assert.equal(resumedBudget.deadline.absoluteDeadline, crashProgress.budget.deadline.absoluteDeadline)
  const events = fs.readFileSync(record.paths.eventLog.logPath, 'utf8')
  for (const eventId of ['CRASH_DETECTED', 'RESUME_REQUESTED', 'PROVIDER_CAPABILITIES_ACCEPTED_FOR_RESUME', 'EXACT_STATE_RESTORED']) {
    assert.match(events, new RegExp(eventId))
  }
  assert.deepEqual(livePersistentPidTrees(pidTreeControlRoot), [])
  await assertNoOsProcessesReferencingPath(directory,
    'AP-RUN-037 reached DONE while its crashed or resumed production process tree remained live')
})

test('runtime capability receipts remain valid for an admitted generation while rejecting forged, cross-run, and downgraded launches', () => {
  let now = Date.parse('2026-08-22T00:00:00.000Z')
  const identity = {
    activationAttestation: { hash: '1'.repeat(64) },
    runtimeMetadataSha256: '2'.repeat(64),
    profileSha256: '3'.repeat(64),
    payloadManifestSha256: '4'.repeat(64),
    runId: 'runtime-capability-run',
    generation: 2,
    targetIdentity: 'target:runtime-capability',
    now: () => now,
  }
  const authority = new RuntimeCapabilityAuthority(identity)
  const receipt = authority.issue({
    providerCapabilities: PROVIDER_CAPABILITIES,
    evidenceHashes: ['5'.repeat(64)],
    cliVersion: 'codex-cli 1.2.3',
    allowedRoutes: ['PRE_ROUTE', 'DIRECT'],
    allowedEffects: ['read', 'run', 'write'],
    routeEffects: { PRE_ROUTE: ['read'], DIRECT: ['read', 'run', 'write'] },
    expiresAtMs: now + 10_000,
  })
  const expected = {
    runId: identity.runId,
    generation: identity.generation,
    targetIdentity: identity.targetIdentity,
    route: 'DIRECT',
    effects: ['read', 'run', 'write'],
    assignmentId: 'work-capability-1',
    assignmentHash: '6'.repeat(64),
    requiredCapabilities: ['eventStreaming', 'stableChildIdentity', 'cancellation'],
  }
  const verified = authority.verify(receipt, expected)
  assert.equal(verified.verified, true)
  assert.equal(verified.launchBinding.assignmentId, expected.assignmentId)
  assert.equal(verified.launchBinding.assignmentHash, expected.assignmentHash)
  assert.match(verified.launchBindingSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(receipt.routeEffects, { PRE_ROUTE: ['read'], DIRECT: ['read', 'run', 'write'] })
  assert.throws(
    () => authority.verify(receipt, { ...expected, route: 'PRE_ROUTE', effects: ['write'] }),
    error => error.code === 'RUNTIME_CAPABILITY_INVALID',
  )
  assert.throws(
    () => authority.verify(receipt, { ...expected, effects: ['isolated-write'] }),
    error => error.code === 'RUNTIME_CAPABILITY_INVALID',
  )
  assert.throws(
    () => authority.verify(receipt, { ...expected, assignmentHash: null }),
    error => error.code === 'RUNTIME_CAPABILITY_INVALID',
  )
  assert.throws(() => authority.verify({ ...receipt }, expected), error => error.code === 'RUNTIME_CAPABILITY_INVALID')
  assert.throws(() => authority.verify(receipt, { ...expected, runId: 'foreign-run' }), error => error.code === 'RUNTIME_CAPABILITY_INVALID')
  assert.throws(
    () => authority.verify(receipt, { ...expected, requiredCapabilities: ['eventStreaming', 'imaginaryCapability'] }),
    error => error.code === 'PROVIDER_UNSUPPORTED' && error.details.missing.includes('imaginaryCapability'),
  )
  now += 10_000
  const afterExpiry = authority.verify(receipt, {
    ...expected,
    assignmentId: 'required-check-after-receipt-expiry',
    assignmentHash: '7'.repeat(64),
  })
  assert.equal(afterExpiry.verified, true)
  assert.equal(afterExpiry.launchBinding.assignmentId, 'required-check-after-receipt-expiry')
})

test('normal runs invoke neither recovery alias while legacy intake and canonical re-anchor stay deterministic one-shot', async t => {
  const authority = new CompatibilityRecoveryAuthority()
  assert.deepEqual(authority.normalNewRun(), { mode: 'NORMAL_NEW_RUN', rolesInvoked: [] })
  const translated = authority.translateLegacy({
    source: { schemaVersion: 1, state: 'RUN_WORK' },
    translate: source => ({ schemaVersion: '2.0.0', translatedState: source.state }),
  })
  assert.equal(translated.mode, 'LEGACY_TRANSLATED_ONCE')
  assert.deepEqual(translated.rolesInvoked, [])
  assert.throws(
    () => authority.translateLegacy({
      source: { schemaVersion: 1 }, translate: () => ({ schemaVersion: '2.0.0' }),
    }),
    error => error.code === 'LEGACY_TRANSLATION_ALREADY_CONSUMED',
  )
  assert.throws(
    () => new CompatibilityRecoveryAuthority().validateCanonical({ state: { schemaVersion: 1 } }),
    error => error.code === 'CANONICAL_REANCHOR_INVALID',
  )
  const reanchor = new CompatibilityRecoveryAuthority()
  const validated = reanchor.validateCanonical({ state: { schemaVersion: '2.0.0', state: 'CHECK_WORK' } })
  assert.equal(validated.mode, 'CANONICAL_VALIDATED_ONCE')
  assert.match(validated.stateHash, /^[a-f0-9]{64}$/)
  assert.throws(
    () => reanchor.validateCanonical({ state: { schemaVersion: '2.0.0' } }),
    error => error.code === 'CANONICAL_REANCHOR_ALREADY_CONSUMED',
  )

  const harness = makeHarness(t, {
    runtimeOptions: {
      exactPathPreflight: deterministicExactPathPreflight('DIRECT'),
      settings: {
        explicit: { concurrency: { mode: 'tokensaver' }, path: 'direct' },
        capabilities: { modelRouting: false, wideMaxSubs: 10 }, providerId: 'codex',
      },
      executeRoute: async () => {
        const report = path.join(harness.directory, 'normal-run-report.txt')
        fs.writeFileSync(report, 'normal run completed without recovery aliases\n')
        return {
          outcome: 'DONE', deliverables: [report],
          checkHashes: [crypto.createHash('sha256').update(fs.readFileSync(report)).digest('hex')],
        }
      },
    },
  })
  const runtime = new CodexSupervisorRuntime(harness.runtimeOptions)
  const result = await runtime.start()
  assert.equal(result.outcome, 'DONE')
  assert.deepEqual(runtime.compatibilityRecoveryAdmission, { mode: 'NORMAL_NEW_RUN', rolesInvoked: [] })
  assert.deepEqual(harness.launches, [])
  assert.equal(harness.launches.some(launch => ['intake', 're-anchor', 'ap-intake', 'ap-re-anchor'].includes(launch.logicalRole)), false)
})

test('concrete route capability matrix separates pre-route, production, coordination, plan, and isolated effects', () => {
  assert.deepEqual(ROUTE_CAPABILITY_EFFECTS.PRE_ROUTE, ['read'])
  assert.equal(ROUTE_CAPABILITY_EFFECTS.DIRECT.includes('coordinate'), false)
  assert.equal(ROUTE_CAPABILITY_EFFECTS.DIRECT.includes('plan-write'), false)
  assert.ok(ROUTE_CAPABILITY_EFFECTS.LIGHT.includes('technical-decision'))
  assert.ok(ROUTE_CAPABILITY_EFFECTS.ROADMAP.includes('coordinate'))
  assert.ok(ROUTE_CAPABILITY_EFFECTS.ROADMAP.includes('plan-write'))
  for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) {
    for (const effect of ['read', 'run', 'write', 'isolated-write']) {
      assert.ok(ROUTE_CAPABILITY_EFFECTS[route].includes(effect), `${route}:${effect}`)
    }
  }
})

test('AP-CODEX-V2-036 signed provider trust accepts the observed dash-prefixed Base64URL activation nonce', t => {
  const activationRoot = tempDirectory(t, 'autoprompt-receipt-')
  const adapterPath = path.join(activationRoot, 'skills', 'autoprompt', 'workflow', 'phase-budget.js')
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true })
  fs.copyFileSync(path.join(WORKFLOW, 'phase-budget.js'), adapterPath)
  const profilePath = path.join(activationRoot, 'autoprompt.config.toml')
  const payloadGeneration = 'codex-v2.0.0-0123456789abcdef'
  const providerRoles = Object.keys(require('../../agents/codex/agents/role-policy.json').physical_roles)
  const logicalToPhysicalProviderRole = Object.fromEntries(providerRoles.map(role => [
    role, `autoprompt-${payloadGeneration.replace(/[^a-z0-9]+/g, '-')}-${role}`,
  ]))
  const privateAgents = path.join(activationRoot, 'skills', 'autoprompt', 'agents-runtime')
  fs.mkdirSync(privateAgents, { recursive: true })
  const profileLines = ['sandbox_mode = "workspace-write"', '', '[agents]']
  for (const role of providerRoles) {
    const physical = logicalToPhysicalProviderRole[role]
    const relative = path.relative(activationRoot, path.join(privateAgents, `${physical}.toml`))
      .split(path.sep).join('/')
    profileLines.push('', `[agents."${physical}"]`, `config_file = "${relative}"`)
    fs.writeFileSync(path.join(privateAgents, `${physical}.toml`),
      `name = "${physical}"\nmodel = "test-model"\nmodel_reasoning_effort = "medium"\n`)
  }
  fs.writeFileSync(profilePath, `${profileLines.join('\n')}\n`)
  const checkerProfilePath = path.join(activationRoot, 'autoprompt-checker.config.toml')
  fs.copyFileSync(profilePath, checkerProfilePath)
  const proofPath = path.join(activationRoot, 'enforcement-proof.json')
  const profileSha256 = crypto.createHash('sha256').update(fs.readFileSync(profilePath)).digest('hex')
  const checkerProfileSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(checkerProfilePath)).digest('hex')
  fs.writeFileSync(proofPath, `${JSON.stringify({
    schemaVersion: 1, provider: 'codex', profilePath, profileSha256,
    checkerProfilePath, checkerProfileSha256,
    checkerSelectedProfile: 'autoprompt-checker',
    selectedProfile: 'autoprompt', strictConfig: true,
  }, null, 2)}\n`)
  const payloadManifestPath = path.join(activationRoot, 'activation-payload.json')
  fs.writeFileSync(payloadManifestPath, `${JSON.stringify({
    schemaVersion: 2,
    files: [{
      path: path.relative(activationRoot, adapterPath).split(path.sep).join('/'),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(adapterPath)).digest('hex'),
    }],
  }, null, 2)}\n`)
  const argv = ['repair', '', 'widget']
  const canonicalRequest = Buffer.from(JSON.stringify({ schemaVersion: 1, argv }))
  const recordPath = path.join(activationRoot, 'activation.json')
  const trustedExecutable = path.join(
    activationRoot, process.platform === 'win32' ? 'trusted-codex.exe' : 'trusted-codex',
  )
  const maliciousExecutable = path.join(
    activationRoot, process.platform === 'win32' ? 'path-codex.exe' : 'path-codex',
  )
  fs.writeFileSync(trustedExecutable, 'trusted-codex-fixture')
  fs.writeFileSync(maliciousExecutable, 'malicious-path-codex-fixture')
  if (process.platform !== 'win32') {
    fs.chmodSync(trustedExecutable, 0o755)
    fs.chmodSync(maliciousExecutable, 0o755)
  }
  const trustedRealpath = fs.realpathSync.native(trustedExecutable)
  const trustedIdentity = {
    realpath: trustedRealpath,
    platform: process.platform,
    arch: process.arch,
    basename: path.basename(trustedRealpath),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(trustedRealpath)).digest('hex'),
    version: 'codex-cli 1.2.3',
  }
  const trustedProvenance = {
    kind: 'explicit-absolute-path-v1', configuredPath: trustedRealpath,
  }
  const codexExecutable = {
    schemaVersion: 1,
    runtimeIdentityHash: CANDIDATE_A,
    executable: trustedRealpath,
    source: 'explicit-configured-runtime',
    packageRoot: null,
    identity: trustedIdentity,
    provenanceSha256: crypto.createHash('sha256')
      .update(Buffer.from(JSON.stringify(trustedProvenance))).digest('hex'),
  }
  const runId = 'apv2-11111111111111111111111111111111'
  const runPath = path.join(activationRoot, 'supervisor-runtime', 'runs', runId)
  fs.mkdirSync(runPath, { recursive: true })
  const runtimeMetadata = Buffer.from(`${JSON.stringify({
    run_id: runId,
    run_path: runPath,
    target_path: ROOT,
    target_identity: `filesystem:${ROOT}`,
    provider_id: 'codex',
    local_only: true,
    automatic_export_allowed: false,
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(runPath, 'metadata.json'), runtimeMetadata)
  const runtimeMetadataSha256 = crypto.createHash('sha256').update(runtimeMetadata).digest('hex')
  fs.writeFileSync(path.join(runPath, 'metadata.sha256'), `${runtimeMetadataSha256}\n`)
  const expiresAt = new Date(Date.now() + 60000).toISOString()
  const record = {
    schemaVersion: 2,
    activationId: runId,
    activationRoot,
    status: 'active',
    contractVersions: {
      settings: '2.0.0', requestEnvelopeEntry: '2.0.0', outcome: '2.0.0',
      providerCapabilities: '2.0.0', activationRequest: '1.0.0',
    },
    aliasTelemetry: {
      schemaVersion: '2.0.0', appendPath: 'compatibility/alias-telemetry.jsonl',
      registeredRunRecordPath: false,
    },
    providerCapabilities: { provider: 'codex', isolation: 'strict' },
    providerTrust: { status: 'VERIFIED', runtimeIdentityHash: CANDIDATE_A, sha256: CANDIDATE_A },
    providerProbe: {
      schemaVersion: 1, launcherHelpSha256: CANDIDATE_A,
      strictProfileOutputSha256: CANDIDATE_A, sandboxOutputSha256: CANDIDATE_A,
      probedAt: new Date().toISOString(),
    },
    safety: { schemaVersion: 1, mechanicallyEnforced: true },
    modelSelection: {
      schemaVersion: 1, mode: 'explicit', selector: 'test-model', models: ['test-model'],
      effort: 'medium', castingHash: CANDIDATE_A, agentDefinitionsHash: CANDIDATE_A,
      registry: null,
      probeAcceptance: {
        strictConfig: true, profileAcceptedAt: new Date().toISOString(),
        explicitModelAndEffortAssignments: true,
      },
    },
    roleProjection: {
      schemaVersion: 1,
      payloadGeneration,
      logicalToPhysicalProviderRole,
    },
    supervisorRuntime: {
      runPath,
      runId,
      metadataSha256: runtimeMetadataSha256,
      targetIdentity: `filesystem:${ROOT}`,
      createdAt: new Date().toISOString(),
    },
    request: {
      argv,
      bytes: canonicalRequest.length,
      canonicalBase64: canonicalRequest.toString('base64'),
      canonicalJson: canonicalRequest.toString('utf8'),
      sha256: crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    },
    target: { realpath: ROOT },
    capability: {
      status: 'consumed', singleUse: true, generation: 1,
      expiresAt,
      recordPath,
      parentSession: 'activation-parent',
      parentRole: 'dispatcher',
      legalChildren: ['ap-route-analyst'],
    },
    activationBoundary: {
      codexExecutable,
      configSha256: CANDIDATE_A,
      payloadManifest: payloadManifestPath,
      payloadManifestSha256: crypto.createHash('sha256').update(fs.readFileSync(payloadManifestPath)).digest('hex'),
      supervisorAdapter: adapterPath,
      supervisorAdapterSha256: crypto.createHash('sha256').update(fs.readFileSync(adapterPath)).digest('hex'),
      privatePermissions: {
        mechanism: process.platform === 'win32' ? 'windows-dacl' : 'posix-mode',
        auditedPaths: 1,
        auditedAt: new Date().toISOString(),
      },
      enforcementProof: {
        path: proofPath,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(proofPath)).digest('hex'),
        profilePath,
        profileSha256,
        checkerProfilePath,
        checkerProfileSha256,
        checkerSelectedProfile: 'autoprompt-checker',
        selectedProfile: 'autoprompt',
        strictConfig: true,
      },
    },
  }
  const runtimeReceiptPath = path.join(activationRoot, 'supervisor-runtime-binding.json')
  const runtimeReceipt = {
    schemaVersion: 1,
    activationId: runId,
    requestSha256: record.request.sha256,
    targetRealpath: ROOT,
    capabilityGeneration: 1,
    bindingSha256: crypto.createHash('sha256').update(Buffer.from(JSON.stringify(record.supervisorRuntime))).digest('hex'),
    binding: record.supervisorRuntime,
  }
  fs.writeFileSync(runtimeReceiptPath, `${JSON.stringify(runtimeReceipt, null, 2)}\n`)
  record.supervisorRuntimeReceipt = {
    path: runtimeReceiptPath,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(runtimeReceiptPath)).digest('hex'),
    capabilityGeneration: 1,
  }
  const entryPrompt = [
    '$autoprompt',
    'AUTOPROMPT_REQUEST_ENVELOPE_V2',
    `activation_id=${runId}`,
    `capability_record=${recordPath}`,
    `request_sha256=${record.request.sha256}`,
    `request_bytes=${record.request.bytes}`,
    `request_base64=${record.request.canonicalBase64}`,
    `request_argv_json=${JSON.stringify(argv)}`,
    `target_realpath=${ROOT}`,
    'parent_session=activation-parent',
    'parent_role=dispatcher',
    'legal_child=ap-route-analyst',
    'generation=1',
    `expires_at=${expiresAt}`,
    'REQUEST_ARGV_BEGIN',
    record.request.canonicalJson,
    'REQUEST_ARGV_END',
  ].join('\n')
  record.supervisorEntry = {
    schemaVersion: 1,
    prompt: entryPrompt,
    promptSha256: crypto.createHash('sha256').update(Buffer.from(entryPrompt)).digest('hex'),
    requestSha256: record.request.sha256,
    structuralInvocation: '$autoprompt',
  }
  const keyPair = crypto.generateKeyPairSync('ed25519')
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' })
  const keyId = crypto.createHash('sha256').update(publicKey).digest('hex')
  record.capability.providerAttestationKeyId = keyId
  const attestation = {
    schemaVersion: '2.0.0',
    attestationId: `codex:${runId}:1`,
    providerId: 'codex',
    issuer: 'autoprompt-codex-activation-v2',
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt,
    runtimeIdentityHash: providerRuntimeIdentityHash(record),
    activationNonce: '-Nun56FgLGR7mAQLNyqoNUrtGc7NNbCR',
    verificationMethod: 'live-conformance-suite',
    verifiedCapabilities: ['isolation', 'privateSkillRoot', 'processOwnership'],
    canonicalProviderTrustSha256: record.providerTrust.sha256,
    result: 'supported',
  }
  attestation.signature = {
    algorithm: 'ed25519', keyId,
    value: crypto.sign(null, activationAttestationPayload(attestation), keyPair.privateKey).toString('base64url'),
  }
  record.providerAttestation = {
    contractVersion: '2.0.0',
    attestationSha256: crypto.createHash('sha256').update(Buffer.from(JSON.stringify(attestation))).digest('hex'),
    providerCapabilitiesSha256: crypto.createHash('sha256').update(Buffer.from(JSON.stringify(record.providerCapabilities))).digest('hex'),
    publicKey: { algorithm: 'ed25519', format: 'spki-der', keyId, value: publicKey.toString('base64url') },
    attestation,
  }
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  const args = {
    'activation-record': recordPath,
    'enforcement-proof': proofPath,
    'profile-path': profilePath,
    'run-id': runId,
  }
  const probedExecutables = []
  const options = createSupervisorOptions(args, {
    adapterPath,
    executable: maliciousExecutable,
    processOwner: {},
    checkerSnapshotFactory() {},
    execFileSync(executable, command) {
      probedExecutables.push(executable)
      assert.equal(executable, trustedRealpath)
      if (command[0] === 'features') return 'multi_agent stable true\n'
      if (command[0] === '--version') return 'codex-cli 1.2.3\n'
      if (command[1] === 'resume') return '--json\n'
      return '--json --output-schema --profile --cd --strict-config\n'
    },
    runtimeOptionsFactory({ activation, probe }) {
      return { activation, probe, reached: true }
    },
  })
  assert.equal(options.reached, true)
  assert.equal(options.activation.runId, runId)
  assert.deepEqual(options.activation.requestArgv, argv)
  assert.equal(options.entryPrompt, entryPrompt)
  assert.equal(options.probe.supported, true)
  assert.deepEqual(probedExecutables, Array(4).fill(trustedRealpath))
  assert.equal(verifyActivationProviderAttestation(record, {}, Date.now()).hash, record.providerAttestation.attestationSha256)
  assert.throws(
    () => verifyActivationProviderAttestation(
      record,
      {},
      Date.parse(record.providerAttestation.attestation.expiresAt),
    ),
    error => error.code === 'ACTIVATION_ATTESTATION_INVALID',
  )
  const trustMismatch = JSON.parse(JSON.stringify(record))
  trustMismatch.activationBoundary.codexExecutable.runtimeIdentityHash = 'b'.repeat(64)
  trustMismatch.providerAttestation.attestation.runtimeIdentityHash =
    providerRuntimeIdentityHash(trustMismatch)
  trustMismatch.providerAttestation.attestation.signature.value = crypto.sign(
    null,
    activationAttestationPayload(trustMismatch.providerAttestation.attestation),
    keyPair.privateKey,
  ).toString('base64url')
  trustMismatch.providerAttestation.attestationSha256 = crypto.createHash('sha256')
    .update(Buffer.from(JSON.stringify(trustMismatch.providerAttestation.attestation))).digest('hex')
  fs.writeFileSync(recordPath, `${JSON.stringify(trustMismatch, null, 2)}\n`)
  let mismatchedExecutions = 0
  assert.throws(() => createSupervisorOptions(args, {
    adapterPath,
    execFileSync() {
      mismatchedExecutions += 1
      return '--json --output-schema --profile --cd --strict-config\n'
    },
    runtimeOptionsFactory() { return { reached: true } },
  }), error => error.code === 'PROVIDER_UNSUPPORTED')
  assert.equal(mismatchedExecutions, 0)
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  for (const mutate of [
    value => { value.request.sha256 = '8'.repeat(64) },
    value => { value.target = { ...value.target, realpath: `${value.target.realpath}-foreign` } },
    value => { value.activationBoundary.privatePermissions = {
      ...value.activationBoundary.privatePermissions,
      auditedPaths: value.activationBoundary.privatePermissions.auditedPaths + 1,
    } },
  ]) {
    const changed = JSON.parse(JSON.stringify(record))
    mutate(changed)
    assert.throws(
      () => verifyActivationProviderAttestation(changed, {}, Date.now()),
      error => error.code === 'ACTIVATION_ATTESTATION_INVALID',
    )
  }
})

test('shell adapters expose identical supported contract and concrete factory fails typed without an activation receipt', () => {
  const runtime = path.join(WORKFLOW, 'phase-budget.js')
  const expected = spawnSync(process.execPath, [runtime, '--supervisor', '--capabilities'], {
    cwd: ROOT, encoding: 'utf8',
  })
  assert.equal(expected.status, 0, expected.stderr)
  const expectedJson = JSON.parse(expected.stdout)
  assert.equal(expectedJson.defaultRoute, null)
  assert.equal(expectedJson.forkTurns, 'none')

  const powerShellExecutable = [process.platform === 'win32' ? 'powershell.exe' : 'pwsh', 'powershell']
    .find(executable => {
      const probe = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true,
      })
      return !probe.error && probe.status === 0
    })
  if (powerShellExecutable) {
    const ps = spawnSync(powerShellExecutable, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(WORKFLOW, 'supervisor.ps1'), '--capabilities',
    ], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(ps.status, 0, ps.stderr)
    assert.deepEqual(JSON.parse(ps.stdout), expectedJson)
  }

  const shellSource = fs.readFileSync(path.join(WORKFLOW, 'supervisor.sh'), 'utf8')
  assert.match(shellSource, /exec node "\$RUNTIME" --supervisor "\$@"/)
  assert.doesNotMatch(shellSource, /fork_turns=all|framework-generator|ap-janitor/)
  const powerShellSource = fs.readFileSync(path.join(WORKFLOW, 'supervisor.ps1'), 'utf8')
  assert.match(powerShellSource, /\$argumentList = @\(\$runtime, '--supervisor'\) \+ @\(\$SupervisorArguments\)/)
  assert.doesNotMatch(powerShellSource, /Start-Process|fork_turns=all/)

  assert.throws(createConcreteSupervisor, error => error.code === 'ACTIVATION_RECEIPT_INVALID')
})

function roadmapCompositionRoleResult(launch, behaviorChanged) {
  const now = '2026-08-25T00:00:00.000Z'
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: `result:${launch.workItemId}`,
    runId: 'run-1', assignmentId: launch.workItemId, logicalRoleId: launch.logicalRole,
    physicalRoleId: launch.physicalRole,
    requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
    findingIds: [...launch.canonicalAssignment.findingIds],
    startedAt: now, endedAt: now, filesChanged: [], resourcesChanged: [],
    behaviorChanged, commands: [],
    successItems: [{ id: 'composition-result', status: 'pass', evidenceIds: ['composition-fixture'] }],
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: {
      event: 'WORK_ITEM_VERIFIED', reason: 'The bounded composition fixture completed.',
      invalidateEvidenceIds: [],
    },
    contextId: launch.continuationId || `context:${launch.workItemId}`,
    usage: ZERO_USAGE, evidenceHashes: [],
  }
}

function roadmapCompositionCheckResult(launch, code, causeReason) {
  return {
    schemaVersion: '2.0.0', code,
    description: code === 'PASS'
      ? 'The checked roadmap satisfies every assigned requirement.'
      : code === 'FAIL'
        ? 'The checked roadmap has one concrete repairable defect.'
        : 'The isolated checker runtime could not produce an authoritative verdict.',
    stateClass: 'terminal', runId: 'run-1',
    requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
    candidateHash: launch.candidateHash, currentVersionHash: launch.candidateHash,
    completedResults: [], nextReadyWork: [],
    cause: {
      event: code === 'PASS' ? 'CHECK_COMPLETE'
        : code === 'FAIL' ? 'ASSERTION_FAILED' : 'CHECK_RUNTIME_UNAVAILABLE',
      reason: causeReason,
      unblockPath: code === 'PASS' ? null : 'consume the exact checker result in a fresh bounded attempt',
    },
    payloadSchemaId: 'autoprompt.check.composition-fixture.v2',
    payload: code === 'FAIL' ? { findings: ['Add the missing rollback ownership step.'] } : {},
    contextId: launch.continuationId || `context:${launch.workItemId}`,
    usage: ZERO_USAGE, evidenceHashes: [],
  }
}

function roadmapCompositionProductCheckResult(launch, code, causeReason) {
  const testOutcomes = (launch.canonicalAssignment.checks || []).map(command => ({
    command,
    status: code === 'FAIL' ? 'FAIL' : 'PASS',
    fingerprint: crypto.createHash('sha256')
      .update(`legacy-roadmap-resume:${launch.workItemId}:${command}:${code}`).digest('hex'),
  }))
  return {
    schemaVersion: '2.0.0', code,
    description: code === 'PASS'
      ? 'The resumed product candidate satisfies every assigned requirement.'
      : 'The resumed product candidate has one concrete repairable defect.',
    stateClass: 'terminal', runId: 'run-1',
    requestEnvelopeHash: launch.canonicalAssignment.requestEnvelopeHash,
    candidateHash: launch.candidateHash, currentVersionHash: launch.candidateHash,
    completedResults: [], nextReadyWork: [],
    cause: {
      event: code === 'PASS' ? 'CHECK_COMPLETE' : 'ASSERTION_FAILED',
      reason: causeReason,
      unblockPath: code === 'PASS' ? null : 'repair the exact failed candidate once and recheck it',
    },
    payloadSchemaId: 'autoprompt.check.composition-product-fixture.v2',
    payload: {
      evidenceIds: [`evidence:${launch.workItemId}`],
      findings: code === 'FAIL' ? ['Repair the concrete resumed product defect.'] : [],
      referenceMethod: checkerReferenceMethod('black-box-boundary', launch.workItemId),
      testOutcomes,
    },
    contextId: launch.continuationId || `context:${launch.workItemId}`,
    usage: ZERO_USAGE, evidenceHashes: [],
  }
}

function configureRoadmapCompositionHarness(t, checkerCodes, options = {}) {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-roadmap-composition-target-'))
  const hardening = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal([0, 3].includes(hardening.status), true, hardening.stderr || hardening.stdout)

  const doneRetryPromotionContract = options.doneRetryPromotion === true ? {
    schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION',
    priorDoneCandidateHash: 'a'.repeat(64), isolationCertificateHash: 'c'.repeat(64),
    requiredAcceptanceIds: ['focused'],
  } : null
  const compositionDecision = decision('ROADMAP')
  if (doneRetryPromotionContract) {
    compositionDecision.normalizedRouteFacts.capturedIncidentDomains = [
      doneRetryPromotionContract.kind,
    ]
    compositionDecision.capturedDomainContracts = [doneRetryPromotionContract]
  }
  let deferredPromotionState = null

  const harness = makeHarness(t, {
    ...(options.launchLimit !== undefined ? { launchLimit: options.launchLimit } : {}),
    ...(options.wallMs !== undefined ? { wallMs: options.wallMs } : {}),
    runtimeOptions: {
      targetPath: target,
      expectedBranch: 'main',
      gitEnvironment: () => process.env,
      settings: {
        explicit: { concurrency: { mode: 'tokensaver' }, path: 'roadmap' },
        capabilities: { modelRouting: false, wideMaxSubs: 10 },
      providerId: 'codex',
      },
      exactPathPreflight: deterministicExactPathPreflight('ROADMAP'),
      decideRoute: async () => ({
        decision: compositionDecision, submittedAtMs: 0, usage: ZERO_USAGE,
      }),
      ...(doneRetryPromotionContract ? {
        writeDeferredPromotionState: state => {
          deferredPromotionState = structuredClone(state)
        },
        readDeferredPromotionState: () => deferredPromotionState,
      } : {}),
    },
  })
  const recordRoot = path.join(harness.directory, 'composition-record')
  const resultRoot = path.join(harness.directory, 'composition-results')
  const planPath = path.join(harness.directory, 'ROADMAP.md')
  const snapshotRoot = path.join(harness.directory, 'composition-snapshots')
  const workerPrivateRoot = path.join(harness.directory, 'composition-worker-private')
  for (const directory of [recordRoot, resultRoot, snapshotRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  let frozenBaseline = null
  harness.record.runPath = recordRoot
  harness.record.resolve = relative => {
    const absolute = path.resolve(recordRoot, ...String(relative).split('/'))
    assert.equal(absolute === recordRoot || absolute.startsWith(`${recordRoot}${path.sep}`), true)
    return absolute
  }
  harness.record.write = (relative, bytes) => {
    const destination = harness.record.resolve(relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.writeFileSync(destination, bytes)
    harness.record.writes.set(relative, String(bytes))
  }
  harness.record.writePreMutationBaseline = input => {
    assert.equal(frozenBaseline, null, 'the composition baseline is immutable')
    frozenBaseline = createPreMutationBaseline(input)
    harness.record.write('checks/pre-mutation-baseline.json', `${JSON.stringify(frozenBaseline, null, 2)}\n`)
    return frozenBaseline
  }
  harness.record.readPreMutationBaseline = () => {
    assert.ok(frozenBaseline, 'the composition baseline was captured before private workspace admission')
    return frozenBaseline
  }

  let runtime = null
  let steeringEntry = null
  let steeringResult = null
  if (options.steerAtCoordinator) {
    const initialRequestPointerFactory = harness.runtimeOptions.requestPointerFactory
    harness.record.appendRequest = async turn => {
      assert.ok(runtime && runtime.requestPointer, 'steering requires the active bound runtime pointer')
      const entryBody = {
        entryType: 'steering-edge',
        steeringId: 'composition-steering-1',
        turn,
      }
      steeringEntry = {
        ...entryBody,
        entryHash: crypto.createHash('sha256').update(JSON.stringify(entryBody)).digest('hex'),
      }
      fs.appendFileSync(runtime.requestPointer.path, `${JSON.stringify(steeringEntry)}\n`)
      return steeringEntry
    }
    harness.record.loadRequest = () => {
      const bytes = fs.readFileSync(runtime.requestPointer.path)
      return {
        digest: crypto.createHash('sha256').update(bytes).digest('hex'),
        records: [steeringEntry],
      }
    }
    harness.runtimeOptions.requestPointerFactory = async () => {
      if (!runtime.requestPointer) return initialRequestPointerFactory()
      const bytes = fs.readFileSync(runtime.requestPointer.path)
      return Object.freeze({
        ...runtime.requestPointer,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      })
    }
  }

  const results = new Map()
  const routeReturns = new Map()
  const routeRequests = new Map()
  const planHashes = []
  const workspaceManager = new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: workerPrivateRoot,
    environment: process.env,
    runId: 'run-1',
    activationId: 'activation-1',
    hardenWorkspace(workspacePath) {
      const repair = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
        '--repo', workspacePath, '--expected-branch', 'main', '--repair', '--json',
      ], { encoding: 'utf8', windowsHide: true })
      let parsed = null
      try { parsed = JSON.parse(repair.stdout) } catch {}
      return { accepted: [0, 3].includes(repair.status) && parsed && parsed.repositoryOk === true }
    },
  })
  harness.runtimeOptions.workerWorkspaceFactory = ({ assignment, workItemId, transportQuarantine }) =>
    transportQuarantine
      ? workspaceManager.prepareFromQuarantine({
          assignment, workItemId, quarantine: transportQuarantine,
        })
      : workspaceManager.prepare({ assignment, workItemId })
  harness.runtimeOptions.mutationEnforcer = {
    begin({ isolation, workItemId }) {
      return { id: `permit:${workItemId}`, isolationBindingHash: isolation.bindingHash }
    },
    commit() {},
    abort() {},
  }
  harness.runtimeOptions.capturePreMutationBaseline = ({ request }) => ({
    capturedBeforeMutation: true,
    targetStateHash: crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(target, 'src', 'example.js'))).digest('hex'),
    environmentHash: crypto.createHash('sha256').update('composition-environment').digest('hex'),
    dirtyTarget: { status: 'CLEAN', paths: [], snapshotHash: null },
    existingTests: [],
    fallback: {
      reason: 'NO_RELEVANT_EXISTING_TESTS',
      evidenceHash: crypto.createHash('sha256').update('composition-observable-check').digest('hex'),
      observableChecks: request.checks.map(String),
    },
    nowMs: 0,
  })
  harness.runtimeOptions.checkerSnapshotFactory = (
    checkerId,
    _resources,
    candidateSourcePath = target,
    context = {},
  ) => {
    const snapshotPath = path.join(snapshotRoot, `${checkerId}-${crypto.randomBytes(6).toString('hex')}`)
    fs.cpSync(candidateSourcePath, snapshotPath, { recursive: true })
    const projection = context.projection
    if (!projection) return snapshotPath
    const destination = path.join(snapshotPath, 'plan', 'ROADMAP.md')
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.copyFileSync(projection.sourcePath, destination)
    const body = {
      schemaVersion: 1,
      runId: 'run-1',
      generation: 1,
      checkerId,
      relativePath: projection.relativePath,
      sourcePath: path.resolve(projection.sourcePath),
      sha256: projection.sha256,
      bytes: projection.bytes,
      snapshotPath: fs.realpathSync.native(snapshotPath),
      adoptedFromReceiptHash: null,
    }
    return Object.freeze({
      snapshotPath,
      projectionReceipt: Object.freeze({
        ...body,
        receiptHash: crypto.createHash('sha256')
          .update(require(path.join(WORKFLOW, 'event-log.js')).stableStringify(body)).digest('hex'),
      }),
    })
  }

  let checkIndex = 0
  let productCheckIndex = 0
  let firstWorkerTransportFailed = false
  let repairTransportFailed = false
  harness.runtimeOptions.launcher = async launch => {
    harness.launches.push(launch)
    if (launch.logicalRole === 'diagnostic-probe') return representativeProbeResult(launch)
    if (options.transportFailureOnFirstWorker === true &&
        launch.workItemId === 'work-1' && !firstWorkerTransportFailed) {
      firstWorkerTransportFailed = true
      if (typeof options.transportPartialBeforeFailure === 'string') {
        fs.writeFileSync(
          path.join(launch.workingDirectory, 'src', 'example.js'),
          options.transportPartialBeforeFailure,
        )
      }
      launch.onUsageDelta(ZERO_USAGE)
      throw Object.assign(new Error('the first product provider transport timed out'), {
        code: options.transportFailureCode || 'CHILD_TRANSPORT_TIMEOUT',
      })
    }
    if (options.transportFailureOnWorkerSuccessor === true &&
        launch.workItemId === 'work-1-transport-retry-1') {
      if (typeof options.transportSuccessorPartialBeforeFailure === 'string') {
        fs.writeFileSync(
          path.join(launch.workingDirectory, 'src', 'example.js'),
          options.transportSuccessorPartialBeforeFailure,
        )
      }
      launch.onUsageDelta(ZERO_USAGE)
      throw Object.assign(new Error('the product transport successor timed out'), {
        code: options.transportFailureCode || 'CHILD_TRANSPORT_TIMEOUT',
      })
    }
    if (options.transportFailureOnRepairBase === true &&
        launch.workItemId === 'work-1-repair-1' && !repairTransportFailed) {
      repairTransportFailed = true
      launch.onUsageDelta(ZERO_USAGE)
      throw Object.assign(new Error('the isolated repair provider transport timed out'), {
        code: 'CHILD_TRANSPORT_TIMEOUT',
      })
    }
    if (options.transportFailureOnRepairSuccessor === true &&
        launch.workItemId === 'work-1-repair-1-transport-retry-1') {
      launch.onUsageDelta(ZERO_USAGE)
      throw Object.assign(new Error('the isolated repair transport successor timed out'), {
        code: 'CHILD_TRANSPORT_TIMEOUT',
      })
    }
    let result
    if (launch.logicalRole === 'plan-checker') {
      const code = checkerCodes[checkIndex++]
      assert.ok(code, `unexpected physical plan-check launch ${launch.workItemId}`)
      result = roadmapCompositionCheckResult(
        launch,
        code,
        code === 'PASS' ? 'The exact roadmap passes.'
          : code === 'FAIL' ? 'The exact roadmap omits rollback ownership.'
            : 'The first isolated checker runtime lost its transport.',
      )
    } else if (launch.logicalRole === 'roadmap-author') {
      result = roadmapCompositionRoleResult(
        launch,
        launch.workItemId === 'roadmap-author'
          ? ['Create the initial dependency-ordered roadmap.']
          : ['Create the initial dependency-ordered roadmap.', 'Add rollback ownership before release.'],
      )
    } else if (options.completeProduct === true && launch.logicalRole === 'worker') {
      if (launch.workItemId === 'work-1-transport-retry-1' &&
          typeof options.transportPartialBeforeFailure === 'string') {
        const restoredPartial = fs.readFileSync(path.join(launch.workingDirectory, 'src', 'example.js'), 'utf8')
        assert.equal(
          crypto.createHash('sha256').update(restoredPartial).digest('hex'),
          crypto.createHash('sha256').update(options.transportPartialBeforeFailure).digest('hex'),
          'the fresh transport retry starts from the exact quarantined partial bytes',
        )
        assert.equal(JSON.stringify(launch).includes(options.transportPartialBeforeFailure.slice(0, 4096)), false,
          'partial workspace bytes never enter the model-visible launch context')
        assert.ok(Buffer.byteLength(JSON.stringify(launch), 'utf8') < 128 * 1024)
      }
      fs.writeFileSync(
        path.join(launch.workingDirectory, 'src', 'example.js'),
        `module.exports = '${launch.workItemId}'\n`,
      )
      result = {
        ...roadmapCompositionRoleResult(launch, [`Complete ${launch.workItemId} in the resumed product frontier.`]),
        filesChanged: ['src/example.js'],
      }
    } else if (options.completeProduct === true &&
        launch.logicalRole.startsWith('independent-')) {
      const code = (options.productCheckerCodes || ['PASS'])[productCheckIndex++]
      assert.ok(code, `unexpected physical product-check launch ${launch.workItemId}`)
      result = roadmapCompositionProductCheckResult(
        launch,
        code,
        code === 'PASS'
          ? 'The repaired resumed product passes the independent acceptance check.'
          : 'The first resumed product candidate fails the independent acceptance check.',
      )
      if (doneRetryPromotionContract && code === 'PASS') {
        result.payload.capturedDomainOutcomes = [{
          schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION',
          priorDoneCandidateHash: doneRetryPromotionContract.priorDoneCandidateHash,
          isolationCertificateHash: doneRetryPromotionContract.isolationCertificateHash,
          retryCandidateHash: launch.candidateHash,
          isolatedWorktreeHash: 'd'.repeat(64), isolationVerified: true,
          acceptanceResults: [{ id: 'focused', status: 'PASS', evidenceHash: 'f'.repeat(64) }],
          acceptanceJoinHash: 'e'.repeat(64), promotionCandidateHash: launch.candidateHash,
        }]
      }
    } else {
      result = roadmapCompositionRoleResult(launch, ['Retain the accepted roadmap coordination context.'])
    }
    if (typeof options.contextIdForLaunch === 'function') {
      const selectedContextId = options.contextIdForLaunch(launch, result.contextId)
      if (typeof selectedContextId === 'string' && selectedContextId) {
        result = { ...result, contextId: selectedContextId }
      }
    }
    results.set(launch.workItemId, result)
    return result
  }

  const executor = createDefaultRouteExecutor({
    targetPath: target,
    gitEnvironment: () => process.env,
    missionHash: crypto.createHash('sha256').update('composition-mission').digest('hex'),
    monotonicNow: () => harness.currentTime(),
    transition: async () => {},
    verifyL1RequestPointer: () => {},
    recordRoadmapPlanning: () => ({ withinCeiling: true }),
    harnessAttestation: candidateHash => ({
      repoHash: candidateHash,
      buildHash: crypto.createHash('sha256').update('composition-build').digest('hex'),
      oracleHash: crypto.createHash('sha256').update('composition-oracle').digest('hex'),
    }),
    writeCapturedDomainAdmission: () => ({}),
    writeCapturedDomainOutcomes: () => {},
    writePlan: (route, routeDecision, authorResult) => {
      const bytes = Buffer.from(renderPlanArtifact(route, routeDecision, authorResult), 'utf8')
      fs.writeFileSync(planPath, bytes)
      planHashes.push(crypto.createHash('sha256').update(bytes).digest('hex'))
    },
    planExists: () => fs.existsSync(planPath),
    planPointer: () => {
      const bytes = fs.readFileSync(planPath)
      return Object.freeze({
        path: planPath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      })
    },
    readResult: workItemId => results.get(workItemId) || null,
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.deepEqual(result, routeReturns.get(workItemId) || results.get(workItemId))
      return true
    },
    resultPointer: workItemId => {
      const result = routeReturns.get(workItemId) || results.get(workItemId)
      assert.ok(result, `missing composition result for ${workItemId}`)
      const bytes = Buffer.from(JSON.stringify(result), 'utf8')
      const resultPath = path.join(resultRoot, `${workItemId}.json`)
      fs.writeFileSync(resultPath, bytes)
      return Object.freeze({
        name: workItemId,
        path: resultPath,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      })
    },
  })
  const acceptedPlan = path.join(harness.directory, 'accepted-roadmap.txt')
  let advancedAfterInitialWorker = false
  harness.runtimeOptions.executeRoute = async input => {
    try {
      return await executor({
        ...input,
        ...(doneRetryPromotionContract ? { decision: compositionDecision } : {}),
        launch: async request => {
          routeRequests.set(request.workItemId, request)
          if (request.workItemId === 'mission-coordination') {
            if (options.steerAtCoordinator) {
              const coordinator = await input.launch(request)
              routeReturns.set(request.workItemId, coordinator)
              steeringResult = await runtime.applyUserSteering(
                'Keep the retained coordinator but add the receipt-bound rollback constraint.',
              )
              for (const workItemId of steeringResult.redispatchedRetainedL1Ids) {
                const retained = runtime.retainedL1Leases.get(workItemId)
                assert.ok(retained, `missing redispatched retained L1 ${workItemId}`)
                runtime.completeRetainedLease(retained)
              }
            }
            throw Object.assign(new Error('plan composition accepted'), { code: 'COMPOSITION_PLAN_ACCEPTED' })
          }
          if (request.workItemId === 'work-1' && !options.steerAtCoordinator &&
              options.completeProduct !== true) {
            assert.equal(request.parent, 'run-owner')
            assert.ok(request.roadmapSlice, 'the sole product worker retains the frozen roadmap pointer')
            throw Object.assign(new Error('plan composition accepted'), { code: 'COMPOSITION_PLAN_ACCEPTED' })
          }
          const result = await input.launch(request)
          if (!advancedAfterInitialWorker && request.workItemId === 'work-1' &&
              Number.isSafeInteger(options.advanceAfterInitialWorkerMs) &&
              options.advanceAfterInitialWorkerMs > 0) {
            harness.advance(options.advanceAfterInitialWorkerMs)
            advancedAfterInitialWorker = true
          }
          routeReturns.set(request.workItemId, result)
          return result
        },
      })
    } catch (error) {
      if (error.code !== 'COMPOSITION_PLAN_ACCEPTED') throw error
      fs.writeFileSync(acceptedPlan, `${planHashes.at(-1)}\n`)
      if (options.acceptedOutcome === 'PARTIAL') return { outcome: 'PARTIAL' }
      return {
        outcome: 'DONE', deliverables: [acceptedPlan],
        checkHashes: [crypto.createHash('sha256').update(fs.readFileSync(acceptedPlan)).digest('hex')],
      }
    }
  }
  return {
    harness, planHashes, results, routeRequests, routeReturns, recordRoot, workerPrivateRoot,
    deferredPromotionState: () => deferredPromotionState,
    setRuntime(value) { runtime = value },
    steeringResult() { return steeringResult },
  }
}

function workerWorkspaceJournalStatuses(privateRoot) {
  const records = path.join(privateRoot, 'records')
  if (!fs.existsSync(records)) return []
  return fs.readdirSync(records).filter(name => name.endsWith('.json')).sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(records, name), 'utf8')).status)
}

function roadmapCompositionProgressFingerprint(candidateHash, evidenceHashes) {
  const { stableStringify } = require(path.join(WORKFLOW, 'event-log.js'))
  return crypto.createHash('sha256').update(stableStringify({
    candidate: candidateHash || null,
    evidence: [...new Set(evidenceHashes)].sort(),
    strategy: null,
  })).digest('hex')
}

function disjointAutomaticRoadmapDecision(workerCount) {
  const resources = Array.from({ length: workerCount }, (_, index) => ({
    kind: 'file', identity: `src/work-${index + 1}.js`, shared: false,
    ownershipMode: 'single-owner',
  }))
  const independentWorkItems = resources.map((resource, index) =>
    `Complete worker ${index + 1} ownership in ${resource.identity}.`)
  const routeRecommendation = createRouteRecommendation({
    preWorkResult: 'CONTINUE',
    recommendedRoute: 'ROADMAP',
    confidence: 'high',
    whatTheUserWants: ['Complete every disjoint local product surface.'],
    likelyAreas: resources.map(resource => resource.identity),
    howSuccessCanBeChecked: ['Run the focused product acceptance check.'],
    unknowns: [],
    risks: ['Preserve disjoint ownership while joining the final candidate.'],
    independentWorkItems,
    dependencies: [],
    reasonsForDirect: ['Multiple disjoint writable surfaces require more than one useful worker.'],
    reasonsForLight: ['No reversible design uncertainty needs a separate planning generation.'],
    reasonsForRoadmap: ['The multi-surface product has exact disjoint ownership.'],
    userInputNeeded: [],
    evidenceIndex: [],
    routeFactProposal: {
      requestedEffect: 'mutate', dependencyShape: 'independent-edits',
      dependentWorkGroupCount: 0, integrationOwnerRequired: false,
      uncertainty: 'none', reversibility: 'locally-reversible',
      mutableResources: resources, sideEffects: ['deliverable-write'], externality: 'local-only',
      confidentiality: 'internal', thirdPartyImpact: 'none', riskLevel: 'ordinary',
      minimumCheckerCount: 1, namedDistinctResponsibilities: [],
      checkQuality: 'authoritative', availableCheckKinds: ['focused-test'], baselineStatus: 'recorded',
      hiddenExternalCheck: false, architectureImpact: 'multi-system', fitsLightPlan: true,
      approachNeedsShortPlanning: false, shortOrderUnclear: false,
    },
  })
  return compileAutomaticRouteDecision({
    recommendation: routeRecommendation,
    requestedResult: 'Complete every disjoint local product surface.',
    requestEnvelopeHash: 'd'.repeat(64),
    targetIdentity: '.',
    providerCapabilities: {
      sameContextContinuation: true, isolatedChecking: true, stableChildIdentity: true,
    },
    budget: { remaining: { wallMs: 60 * 60 * 1000 } },
    nowMs: 1,
  })
}

test('fresh ROADMAP projects one deterministic plan and starts product without planning model calls', async t => {
  const fixture = configureRoadmapCompositionHarness(t, ['FAIL'])
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(fixture.planHashes.length, 1)
  const planning = fixture.harness.launches.filter(launch =>
    ['roadmap-author', 'roadmap-author-plan-repair', 'roadmap-plan-check', 'roadmap-plan-recheck']
      .includes(launch.workItemId))
  assert.deepEqual(planning, [])
  const productWorker = fixture.routeRequests.get('work-1')
  assert.equal(productWorker.fetchedEvidence.roadmapPlanningFallback.code, 'DETERMINISTIC_ROADMAP')
  assert.equal(result.scheduler.counters.retriesStarted, 0)
  assert.equal(result.scheduler.counters.rejectedByCode.RETRY_PROGRESS_EVIDENCE_REQUIRED || 0, 0)
  assert.equal(result.scheduler.counters.rejectedByCode.RETRY_REASSESSMENT_REQUIRED || 0, 0)
  assert.doesNotMatch(JSON.stringify(result.terminalEnvelope || {}), /RETRY_(?:PROGRESS|REASSESSMENT)/u)
  assert.deepEqual(workerWorkspaceJournalStatuses(fixture.workerPrivateRoot), [])
})

test('Codex production source has no legacy planner launch or post-return L0 transport', () => {
  const source = fs.readFileSync(path.join(WORKFLOW, 'phase-budget.js'), 'utf8')
  assert.doesNotMatch(source, /legacyRoadmapRecovery\s*&&\s*!collapseLegacyRoadmapPlanning/u)
  assert.doesNotMatch(source,
    /logicalRole:\s*'(?:roadmap-author|plan-checker|mission-coordinator|ap-work-group-manager)'/u)
  assert.doesNotMatch(source, /canonicalWorkerRuntimeSignals/u)
  const deterministicDecisionStart = source.indexOf('decideRoute: async ({ analysis, requestPointer }) => {')
  const nextRuntimeOption = source.indexOf('assignmentResolver:', deterministicDecisionStart)
  assert.ok(deterministicDecisionStart >= 0 && nextRuntimeOption > deterministicDecisionStart)
  assert.doesNotMatch(source.slice(deterministicDecisionStart, nextRuntimeOption), /codexAdapter\.launch/u)
})

test('fresh and resumed W2/W3 ROADMAP frontiers launch only run-owner product workers and final verification', async t => {
  for (const workerCount of [2, 3]) for (const resumeMode of ['fresh', 'current', 'legacy-collapse']) {
    await t.test(`W${workerCount} ${resumeMode}`, async t => {
      const targetPath = createTempGitTarget(tempDirectory(t, `deterministic-roadmap-w${workerCount}-`))
      for (let index = 1; index <= workerCount; index++) {
        fs.writeFileSync(path.join(targetPath, 'src', `work-${index}.js`), "module.exports = 'initial'\n")
      }
      assert.equal(spawnSync('git', ['-C', targetPath, 'add', '.']).status, 0)
      assert.equal(spawnSync('git', ['-C', targetPath, 'commit', '-m', 'add disjoint surfaces']).status, 0)
      if (resumeMode === 'current') {
        fs.writeFileSync(path.join(targetPath, 'src', 'work-1.js'), "module.exports = 'work-1'\n")
      }
      const routeDecision = disjointAutomaticRoadmapDecision(workerCount)
      assert.equal(routeDecision.usefulWorkerCount, workerCount)
      const planPath = path.join(targetPath, 'plan', 'ROADMAP.md')
      const launched = []
      const executor = createDefaultRouteExecutor({
        targetPath,
        gitEnvironment: () => process.env,
        transition: async () => {},
        verifyL1RequestPointer: () => {},
        writePlan(route, selectedDecision, projection) {
          fs.mkdirSync(path.dirname(planPath), { recursive: true })
          fs.writeFileSync(planPath, renderPlanArtifact(route, selectedDecision, projection))
        },
        planExists: () => fs.existsSync(planPath),
        planPointer: () => {
          const bytes = fs.readFileSync(planPath)
          return {
            path: planPath,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
          }
        },
        harnessAttestation: (candidateHash, oracle) => ({
          repoHash: candidateHash,
          buildHash: crypto.createHash('sha256').update('disjoint-roadmap-build').digest('hex'),
          oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
        }),
      })
      const resumeState = resumeMode === 'current' ? {
        resumeState: 'ITEM_VERIFIED',
        completedWorkIds: ['work-1'], completedCheckIds: [], acceptedResultIds: [],
        nextReadyWorkIds: Array.from({ length: workerCount - 1 }, (_, index) => `work-${index + 2}`),
        retryState: {},
      } : resumeMode === 'legacy-collapse' ? {
        resumeState: 'RUN_WORK',
        completedWorkIds: ['roadmap-author'], completedCheckIds: [], acceptedResultIds: [],
        nextReadyWorkIds: ['mission-coordination'], retryState: {},
      } : null
      let adoption = null
      const outcome = await executor({
        route: 'ROADMAP',
        decision: routeDecision,
        launch: async request => {
          launched.push(request)
          if (request.logicalRole === 'worker') {
            assert.equal(request.parent, 'run-owner')
            fs.writeFileSync(
              path.join(targetPath, 'src', `${request.workItemId}.js`),
              `module.exports = '${request.workItemId}'\n`,
            )
            return { allAssignedItemsPass: true, filesChanged: [`src/${request.workItemId}.js`] }
          }
          assert.ok(request.logicalRole.startsWith('independent-'))
          return {
            code: 'PASS',
            payload: {
              evidenceIds: [`evidence:${request.workItemId}`],
              referenceMethod: checkerReferenceMethod('black-box-boundary', request.workItemId),
              testOutcomes: checkerTestOutcomes(request),
            },
          }
        },
        completeRetainedLease: () => {},
        resumeAdoptedLaunches: async input => {
          if (input.skipLegacyPlanningRetryIds) adoption = input
          return resumeMode === 'current' ? ({
            'work-1': { reportId: 'work-1', allAssignedItemsPass: true, filesChanged: ['src/work-1.js'] },
          }) : ({})
        },
        resumeState,
      })
      assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
      const workIds = launched.filter(item => item.logicalRole === 'worker').map(item => item.workItemId)
      assert.deepEqual(workIds, Array.from(
        { length: workerCount - (resumeMode === 'current' ? 1 : 0) },
        (_, index) => `work-${index + 1 + (resumeMode === 'current' ? 1 : 0)}`,
      ))
      if (resumeMode === 'legacy-collapse') {
        assert.deepEqual(adoption.skipLegacyPlanningRetryIds, ['roadmap-author', 'mission-coordination'])
        assert.deepEqual(adoption.skippedPlanningNextReadyWorkIds,
          Array.from({ length: workerCount }, (_, index) => `work-${index + 1}`))
      }
      assert.equal(launched.filter(item => [
        'roadmap-author', 'plan-checker', 'scout', 'mission-coordinator', 'ap-work-group-manager',
      ].includes(item.logicalRole)).length, 0)
      assert.deepEqual(
        launched.filter(item => item.logicalRole.startsWith('independent-')).map(item => item.workItemId),
        ['independent-check-1'],
      )
    })
  }
})

test('one-worker ROADMAP starts product work directly from run-owner with the frozen plan frontier', async t => {
  const fixture = configureRoadmapCompositionHarness(t, ['PASS'])
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(fixture.routeRequests.has('mission-coordination'), false)
  assert.equal(fixture.routeRequests.has('roadmap-work-group'), false)
  const worker = fixture.routeRequests.get('work-1')
  assert.ok(worker)
  assert.equal(worker.parent, 'run-owner')
  assert.equal(worker.roadmapSlice.sha256, fixture.planHashes[0])
  assert.deepEqual(worker.nextReadyAfter, [])
  assert.equal(result.scheduler.limits.maxChildLaunches, 8)
  const frozenDecision = JSON.parse(fixture.harness.record.writes.get('route/decision.json'))
  assert.equal(frozenDecision.topology.childSessions, 2)
  assert.equal(result.scheduler.limits.maxChildLaunches - frozenDecision.topology.childSessions, 6)
})

test('fresh ROADMAP plan acceptance is delegated directly to final product verification', async t => {
  const fixture = configureRoadmapCompositionHarness(t, ['FAIL'])
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(fixture.planHashes.length, 1)
  assert.equal(fixture.routeRequests.has('roadmap-plan-recheck'), false)
  assert.equal(fixture.routeRequests.has('roadmap-plan-check-runtime-retry'), false)
  const productWorker = fixture.routeRequests.get('work-1')
  assert.ok(productWorker, 'product work must start after the deterministic controller projection')
  assert.equal(fixture.routeRequests.has('mission-coordination'), false)
  assert.equal(productWorker.fetchedEvidence.roadmapPlanningFallback.code, 'DETERMINISTIC_ROADMAP')
  assert.equal(productWorker.fetchedEvidence.roadmapPlanningFallback.planHash, fixture.planHashes[0])
  assert.doesNotMatch(JSON.stringify(result.terminalEnvelope || {}), /RECOVERY_CHECKPOINT_ROLLBACK/u)
})

test('legacy ROADMAP plan recheck retry resumes through product repair at the frozen launch ceiling', async t => {
  const options = {
    acceptedOutcome: 'PARTIAL',
    completeProduct: false,
    productCheckerCodes: ['FAIL', 'PASS'],
  }
  const fixture = configureRoadmapCompositionHarness(t, ['FAIL'], options)
  const first = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(first.outcome, 'PARTIAL', JSON.stringify(first))
  assert.equal(first.scheduler.limits.maxChildLaunches, 8)
  assert.equal(first.scheduler.counters.totalLaunches, 0)
  assert.deepEqual(fixture.harness.launches.map(launch => launch.workItemId), [])

  const repairedPlanHash = fixture.planHashes.at(-1)
  const legacyRecheckId = 'roadmap-plan-recheck'
  const legacyRecheckResult = {
    code: 'CHECK_INCONCLUSIVE', candidateHash: repairedPlanHash,
    cause: {
      event: 'CHECK_RUNTIME_UNAVAILABLE',
      reason: 'The historical plan-recheck transport became unavailable.',
      unblockPath: 'Use the durable repaired plan and delegate acceptance to product verification.',
    },
  }
  fixture.results.set(legacyRecheckId, legacyRecheckResult)
  fixture.routeReturns.set(legacyRecheckId, legacyRecheckResult)
  const frozenDecision = JSON.parse(fixture.harness.record.writes.get('route/decision.json'))
  const priorBudget = first.budget
  options.completeProduct = true
  fixture.harness.runtimeOptions.generation = 2
  fixture.harness.runtimeOptions.previousBudgetSnapshot = priorBudget
  fixture.harness.runtimeOptions.budgetController = new BudgetController({
    limits: priorBudget.limits,
    finalizationReserveMs: priorBudget.finalizationReserveMs,
    verificationReserveMs: priorBudget.verificationReserveMs || 0,
    phases: {},
    monotonicMs: () => fixture.harness.currentTime(),
    monotonicClockId: 'test-monotonic',
    wallNowMs: () => fixture.harness.currentTime(),
    snapshot: priorBudget,
  })
  fixture.harness.runtimeOptions.resumeState = {
    decision: frozenDecision,
    schedulerState: first.schedulerState,
    deadline: priorBudget.deadline,
    resumeState: 'CHECK_INCONCLUSIVE',
    planHash: repairedPlanHash,
    candidateHash: null,
    completedWorkIds: ['roadmap-author', 'roadmap-author-plan-repair'],
    completedCheckIds: [],
    acceptedResultIds: [],
    nextReadyWorkIds: ['roadmap-plan-recheck-runtime-retry'],
    retryState: {
      inconclusiveChecker: {
        checkerId: legacyRecheckId,
        candidateHash: repairedPlanHash,
        checkerResultHash: crypto.createHash('sha256')
          .update(JSON.stringify(legacyRecheckResult)).digest('hex'),
        retryAttempt: 1,
        returnState: 'RUN_WORK',
      },
    },
  }
  fixture.harness.runtimeOptions.maxChildLaunches = 1
  fixture.harness.runtimeOptions.lanes = { main: { maxLaunches: 1 } }

  const launchBoundary = fixture.harness.launches.length
  const resumed = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()
  const resumedLaunches = fixture.harness.launches.slice(launchBoundary)
    .map(launch => launch.workItemId)

  assert.equal(resumed.outcome, 'DONE', JSON.stringify(resumed))
  assert.deepEqual(resumedLaunches, [
    'work-1', 'independent-check-1', 'work-1-repair-1', 'independent-check-1-repair-1',
  ])
  assert.equal(resumedLaunches.some(id => id.startsWith('roadmap-plan-')), false)
  assert.equal(resumed.scheduler.counters.totalLaunches, 4)
  assert.equal(resumed.scheduler.limits.maxChildLaunches, 8)
  assert.equal(resumed.scheduler.lanes.main.limits.maxLaunches, 8)
  assert.equal(resumed.scheduler.counters.rejectedByCode.LAUNCH_LIMIT || 0, 0)
  assert.equal(fixture.routeRequests.get('work-1').fetchedEvidence.roadmapPlanningFallback.code,
    'LEGACY_PLANNING_COLLAPSED')
  assert.equal(fixture.routeRequests.get('work-1-repair-1').repairOf, 'work-1')
  assert.doesNotMatch(JSON.stringify(resumed.terminalEnvelope || {}),
    /LAUNCH_LIMIT|RECOVERY_CHECKPOINT_ROLLBACK/u)
})

test('fresh ROADMAP allocates no plan-check proof, retry, or cache entry before product', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], { completeProduct: true })
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(fixture.harness.launches.some(launch => launch.logicalRole === 'plan-checker'), false)
  assert.equal(fixture.routeRequests.has('roadmap-plan-check-runtime-retry'), false)
  assert.deepEqual(fixture.harness.launches.map(launch => launch.workItemId), [
    'work-1', 'independent-check-1',
  ])
  assert.equal(result.scheduler.counters.retriesStarted, 0)
  assert.equal(result.scheduler.counters.proofCacheHits, 0)
  assert.equal(result.scheduler.counters.proofCacheMisses, 0)
})
test('fresh ROADMAP binds deterministic planning evidence and preserves product work', async t => {
  const fixture = configureRoadmapCompositionHarness(t, [], { completeProduct: true })
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  const productWorker = fixture.routeRequests.get('work-1')
  assert.ok(productWorker)
  assert.equal(productWorker.parent, 'run-owner')
  assert.equal(productWorker.fetchedEvidence.roadmapPlanningFallback.code,
    'DETERMINISTIC_ROADMAP')
  assert.equal(productWorker.fetchedEvidence.roadmapPlanningFallback.planHash,
    fixture.planHashes[0])
  assert.equal(fixture.harness.launches.some(launch => [
    'roadmap-author', 'scout', 'plan-checker', 'mission-coordinator', 'ap-work-group-manager',
  ].includes(launch.logicalRole)), false)
  assert.deepEqual(fixture.harness.launches.map(launch => launch.workItemId), [
    'work-1', 'independent-check-1',
  ])
})
test('one-worker ROADMAP creates no retained L1 coordination context', async t => {
  const fixture = configureRoadmapCompositionHarness(t, ['PASS'])
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(fixture.harness.launches.some(launch =>
    launch.logicalRole === 'mission-coordinator'), false)
  assert.equal(fixture.routeRequests.get('work-1').parent, 'run-owner')
  assert.equal(result.schedulerState.attempts['mission-coordination'], undefined)
})
