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
  CodexExecAdapter,
  CodexSupervisorRuntime,
  CompatibilityRecoveryAuthority,
  FrameworkOrchestrationAuthority,
  OwnedCodexProxyRunner,
  RolePolicy,
  RuntimeCapabilityAuthority,
  ROUTE_CAPABILITY_EFFECTS,
  activationRuntimeSettings,
  createCheckerSnapshotFactory,
  validatePlanCheckerSnapshot,
  canonicalCompletedCheckerId,
  canonicalizeCheckerVerificationLimitation,
  roadmapPlanOracleForWorkItem,
  checkerVerdictPassed,
  durableNextReadyAfter,
  recoveryGroupNextReady,
  adoptedLeaseMatchesStage,
  terminalFinalizationDiagnostics,
  createConcreteSupervisor,
  createDefaultRouteExecutor,
  createDefaultRuntimeOptions,
  createSupervisorOptions,
  canonicalEvidenceBinding,
  schedulerProgressEvidenceHashes,
  checkerRecoveryNextReady,
  assertDistinctEvidenceConsumption,
  evidenceInvalidationSet,
  ensureSafeEnvironment,
  phaseBudgetVerdict,
  launchCodexChildWithCheckerReassessment,
  providerRuntimeIdentityHash,
  renderPlanArtifact,
  resolveTerminalReceiptCandidateHash,
  resumePlanProjectionAccepted,
  safeEnvironmentFactory,
  selectWorkRecipe,
  validateLiveCheckingPlan,
  verifyActivationProviderAttestation,
} = require(path.join(WORKFLOW, 'phase-budget.js'))
const { BudgetController } = require(path.join(WORKFLOW, 'budget-controller.js'))
const { CentralScheduler, ROUTE_BUDGETS } = require(path.join(WORKFLOW, 'scheduler.js'))
const { createPreMutationBaseline, createRunRecord } = require(path.join(WORKFLOW, 'run-record.js'))
const { ensureWindowsPrivateAcl } = require(path.join(WORKFLOW, 'safe-run-root.js'))
const {
  ProcessOwner,
  createPosixProcessAdapter,
  createWindowsJobAdapter,
  prepareProcessLaunchEnvironment,
  selectWindowsLiveStatusPids,
} = require(path.join(WORKFLOW, 'process-owner.js'))
const { writeRequestEnvelope } = require(path.join(WORKFLOW, 'context-envelope.js'))
const { createRouteDecision, createRouteRecommendation } = require(path.join(WORKFLOW, 'route-decision.js'))
const { deriveProfileLimits, renderProfile } = require(path.join(WORKFLOW, 'codex-agent-profile.js'))
const { resolveAgentAssignment } = require(path.join(WORKFLOW, 'codex-agent-casting.js'))
const { WorkerWorkspaceManager } = require(path.join(WORKFLOW, 'worker-workspace.js'))
const {
  createPersistentPidTreeAdapter,
  killAllPersistentPidTrees,
  livePersistentPidTrees,
} = require('../fixtures/codex-persistent-pid-tree-adapter.cjs')

const CANDIDATE_A = 'a'.repeat(64)
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

function checkerTestOutcomes(request, label = request.workItemId) {
  return (request.checks || []).map(command => ({
    command,
    status: 'PASS',
    fingerprint: crypto.createHash('sha256').update(`${label}:${command}`).digest('hex'),
  }))
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
})

test('checker contract and aggregate evidence defects trigger bounded evidence-bound reassessment', async t => {
  const directory = tempDirectory(t, 'autoprompt-checker-contract-retry-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = decision('DIRECT', {
    independentChecks: {
      checker_count: 2,
      responsibilities: ['Review the exact requirements.', 'Test the independent boundary.'],
      separate_second_checker_reason: 'The boundary test uses a distinct method and evidence source.',
    },
  })
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
      const retry = request.workItemId.includes('runtime-retry')
      const first = request.workItemId.startsWith('independent-check-1')
      const methodClass = first && !retry
        ? 'invented-composite-method'
        : first ? 'requirements-review'
          : retry ? 'metamorphic-property' : 'black-box-boundary'
      const evidenceId = !first && retry ? 'evidence:second-reassessed' : 'evidence:shared-first-pass'
      return {
        code: 'PASS',
        payload: {
          evidenceIds: [evidenceId],
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
  const checks = requests.filter(request => request.logicalRole.startsWith('independent-'))
  assert.deepEqual(checks.map(request => request.workItemId), [
    'independent-check-1',
    'independent-check-1-runtime-retry-1',
    'independent-check-2',
    'independent-check-2-runtime-retry-1',
  ])
  assert.equal(checks.every(request => request.deferProofAcceptance === true), true)
  const { stableStringify } = require(path.join(WORKFLOW, 'event-log.js'))
  assert.deepEqual(checks[1].evidenceHashes, [
    crypto.createHash('sha256').update(stableStringify({
      code: 'PASS',
      payload: {
        evidenceIds: ['evidence:shared-first-pass'],
        referenceMethod: checkerReferenceMethod('invented-composite-method', 'independent-check-1'),
        testOutcomes: checks[0].checks.map(command => ({
          command, status: 'PASS', fingerprint: crypto.createHash('sha256')
            .update(`focused:independent-check-1:${command}`).digest('hex'),
        })),
      },
    })).digest('hex'),
  ])
  assert.deepEqual(checks[1].recoveryContext, {
    type: 'bounded-recovery', code: 'REFERENCE_METHOD_INVALID',
  })
  assert.equal(checks[1].fetchedEvidence.controllerReassessment.code, 'REFERENCE_METHOD_INVALID')
  assert.deepEqual(checks[3].recoveryContext, {
    type: 'bounded-recovery', code: 'DUPLICATE_UNDERLYING_EVIDENCE',
  })
  assert.equal(checks[3].fetchedEvidence.controllerReassessment.reassignedCheckerId,
    'independent-check-2')
  assert.match(checks[3].assignment, /Execute every accessible pre-existing test and acceptance command/u)
  assert.equal(transitions.filter(item => item.event === 'CHECK_INCONCLUSIVE').length, 2)
  assert.equal(transitions.filter(item => item.event === 'INDEPENDENT_VERDICT_RECORDED').length, 2)
})

test('one-checker PASS still requires an independent reference method and only one physical reassessment', async t => {
  for (const repeatedDefect of [false, true]) {
    const directory = tempDirectory(t, `autoprompt-one-checker-method-${repeatedDefect}-`)
    const targetPath = createTempGitTarget(directory)
    const requests = []
    const transitions = []
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
        return {
          code: 'PASS',
          payload: {
            evidenceIds: [`evidence:${request.workItemId}`],
            ...(!retry || repeatedDefect ? {} : {
              referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
            }),
            testOutcomes: checkerTestOutcomes(request),
          },
        }
      },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async () => ({}),
      resumeState: null,
    })
    assert.equal(result.outcome, repeatedDefect ? 'PARTIAL' : 'DONE', JSON.stringify({
      result,
      transitions,
      requests: requests.map(request => request.workItemId),
    }))
    assert.deepEqual(requests.filter(request => request.logicalRole.startsWith('independent-'))
      .map(request => request.workItemId), [
      'independent-check-1', 'independent-check-1-runtime-retry-1',
    ])
    const reassessment = transitions.find(item => item.event === 'CHECK_INCONCLUSIVE')
    assert.equal(reassessment.details.controllerReason, 'REFERENCE_METHOD_INVALID')
    assert.deepEqual(reassessment.details.nextReadyWorkIds, ['independent-check-1-runtime-retry-1'])
    assert.equal(transitions.filter(item => item.event === 'CHECK_INCONCLUSIVE').length, 1)
    if (repeatedDefect) {
      assert.equal(result.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
    }
  }
})

test('checker PASS with a failed named outcome is non-authoritative even without a regression baseline', async t => {
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
    assert.equal(result.outcome, repeatedDefect ? 'PARTIAL' : 'DONE', JSON.stringify({
      result,
      transitions,
      requests: requests.map(request => request.workItemId),
    }))
    assert.deepEqual(requests.filter(request => request.logicalRole.startsWith('independent-'))
      .map(request => request.workItemId), [
      'independent-check-1', 'independent-check-1-runtime-retry-1',
    ])
    const reassessment = transitions.find(item => item.event === 'CHECK_INCONCLUSIVE')
    assert.equal(reassessment.details.controllerReason, 'TEST_OUTCOMES_INVALID')
    assert.deepEqual(reassessment.details.nextReadyWorkIds, ['independent-check-1-runtime-retry-1'])
    assert.equal(transitions.filter(item => item.event === 'CHECK_INCONCLUSIVE').length, 1)
    if (repeatedDefect) assert.equal(result.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
  }
})

test('malformed adapter checker output becomes durable non-authoritative evidence and physically retries', async t => {
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
      return {
        schemaVersion: '2.0.0', code: 'PASS',
        runId: 'run-malformed-checker', requestEnvelopeHash: routeDecision.requestEnvelopeHash,
        currentVersionHash: request.candidateHash, candidateHash: request.candidateHash,
        payload: {
          evidenceIds: [`evidence:fresh:${request.workItemId}`],
          referenceMethod: checkerReferenceMethod(
            request.workItemId.startsWith('independent-check-1')
              ? 'black-box-boundary' : 'authoritative-suite',
            request.workItemId,
          ),
          testOutcomes: checkerTestOutcomes(request),
        },
      }
    },
  })

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(persisted.length >= 1, true)
  assert.equal(persisted[0].code, 'RUNTIME_FAILURE')
  assert.equal(persisted[0].payload.rejectedCode, 'CHECK_REPORT_INVALID')
  const checkRequests = requests.filter(request => request.logicalRole.startsWith('independent-'))
  assert.deepEqual(checkRequests.slice(0, 2).map(request => request.workItemId), [
    'independent-check-1', 'independent-check-1-runtime-retry-1',
  ])
  assert.equal(checkRequests[1].fetchedEvidence.controllerReassessment.code, 'RUNTIME_FAILURE')
})

test('every independent checker PASS stays provisional until evidence consumption validates', async t => {
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
    route: 'DIRECT', decision: decision('DIRECT'),
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
  assert.deepEqual(checks.map(check => check.workItemId), [
    'independent-check-1', 'independent-check-1-runtime-retry-1', 'independent-check-2',
  ])
  assert.equal(checks.every(check => check.deferProofAcceptance === true), true)
  assert.equal(checks[1].fetchedEvidence.controllerReassessment.code, 'EVIDENCE_CONSUMPTION_INVALID')
})

test('provisional checker PASS is never cached when a failed named outcome remains non-authoritative', async t => {
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

  assert.equal(outcome.outcome, 'PARTIAL', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
  assert.deepEqual(acceptedProofs, [])
})

test('crash-restored completed checker retry is consumed exactly once without a physical relaunch', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-completed-checker-retry-'))
  const candidateHash = 'a'.repeat(64)
  const retryId = 'independent-check-1-runtime-retry-1'
  const retryDecision = decision('DIRECT')
  const retryRecipe = selectWorkRecipe({
    ...retryDecision.gateSelection,
    route: 'DIRECT',
    checks: [],
    runtimeSignals: retryDecision.runtimeSignals || {},
    overlaySteps: retryDecision.overlaySteps || retryDecision.overlayExecution || [],
  })
  const retryChecks = [...new Set([
    ...retryRecipe.checks, ...retryRecipe.riskChecks, ...retryDecision.plannedChecks,
  ])]
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
      nextReadyWorkIds: ['independent-check-2'],
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
    ['CHECK_BECAME_CONCLUSIVE', 'CHECK_WORK', retryId, ['independent-check-2']],
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
  const retryRecipe = selectWorkRecipe({
    ...routeDecision.gateSelection,
    route: 'DIRECT',
    checks: [],
    runtimeSignals: routeDecision.runtimeSignals || {},
    overlaySteps: routeDecision.overlaySteps || routeDecision.overlayExecution || [],
  })
  const retryChecks = [...new Set([
    ...retryRecipe.checks, ...retryRecipe.riskChecks, ...routeDecision.plannedChecks,
  ])]
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

test('recovered checker retry reports remain provisional until controller validation', async t => {
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
    { name: 'unknown-code', result: { code: 'UNRECOGNIZED_CHECKER_REPORT' }, completed: false },
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
    assert.equal(outcome.outcome, 'PARTIAL', scenario.name)
    assert.equal(outcome.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE', scenario.name)
    assert.deepEqual(launches, [], scenario.name)
    assert.equal(transitions.filter(([event]) => event === 'CHECK_BECAME_CONCLUSIVE').length, 0,
      scenario.name)
    assert.equal(transitions.filter(([event]) => event === 'CHECK_REMAINS_INCONCLUSIVE').length, 1,
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

test('post-result independent checker frontiers resume the recorded retry or repair without base relaunch', async t => {
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
    assert.equal(launches[0], nextReadyId)
    assert.equal(launches.includes('independent-check-1'), false)
    assert.equal(launches.filter(id => id === nextReadyId).length, 1)
    assert.equal(transitions[0].eventId,
      kind === 'retry' ? 'CHECK_INCONCLUSIVE' : 'IMPLEMENTATION_DEFECT')
  }
})

test('post-result recovery binds every eligible checker failure to the next exact repair', async t => {
  for (const scenario of [
    { name: 'second-checker-repair', checkerId: 'independent-check-2', nextReady: ['work-1-repair-1'], checkerCount: 2, workerCount: 1, expect: 'DONE' },
    { name: 'ineligible-multi-worker-fail', checkerId: 'independent-check-1', nextReady: [], checkerCount: 1, workerCount: 2, expect: 'FAILED' },
    { name: 'post-repair-next-fix', checkerId: 'independent-check-1-repair-1', nextReady: ['work-1-repair-2'], checkerCount: 1, workerCount: 1, expect: 'DONE' },
  ]) {
    const directory = tempDirectory(t, `autoprompt-checker-${scenario.name}-`)
    const targetPath = createTempGitTarget(directory)
    fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'rejected'\n")
    const routeDecision = structuredClone(decision('DIRECT'))
    routeDecision.usefulWorkerCount = scenario.workerCount
    routeDecision.independentCheckingPlan = {
      checkerCount: scenario.checkerCount,
      responsibilities: Array.from({ length: scenario.checkerCount }, (_, index) => `Checker ${index + 1} responsibility.`),
      nonOverlapReason: scenario.checkerCount === 2 ? 'Distinct review and boundary testing.' : null,
    }
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
          ...(scenario.name === 'post-repair-next-fix' ? ['work-1-repair-1'] : []),
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

test('post-retry durable terminal receipt is consumed without relaunching the bounded checker retry', async t => {
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
  assert.equal(outcome.outcome, 'PARTIAL')
  assert.equal(outcome.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
  assert.deepEqual(launches, [])
})

test('CHECK_INCONCLUSIVE crash before retry launch authenticates the base receipt and launches the retry once', async t => {
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
  assert.deepEqual(launches, [retryId])
  assert.equal(transitions.filter(event => event === 'CHECK_INCONCLUSIVE').length, 0)
})

test('post-repair checker retry FAIL resumes into the next exact repair', async t => {
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
      if (request.workItemId === 'work-1-repair-2') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repair-two'\n")
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
      resumeState: 'CHECK_INCONCLUSIVE',
      completedWorkIds: ['work-1', 'work-1-repair-1'], completedCheckIds: [],
      acceptedResultIds: [], nextReadyWorkIds: ['work-1-repair-2'],
      retryState: { inconclusiveChecker: {
        checkerId: baseId,
        candidateHash: testWorkspaceCandidateHash(targetPath),
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'CHECK_WORK',
      } },
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, ['work-1-repair-2', 'independent-check-1-repair-2'])
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
  const validateProjection = hash => {
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

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
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
  for (const argv of [
    ['init', '-b', 'main', target],
    ['-C', target, 'config', 'user.email', 'autoprompt@example.invalid'],
    ['-C', target, 'config', 'user.name', 'Autoprompt Test'],
    ['-C', target, 'add', '--', 'src/example.js'],
    ['-C', target, 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', argv, { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
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
    howSuccessCanBeChecked: ['Run the focused behavior check.'],
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

test('non-authoritative and failed checker receipts preserve their exact recovery frontier', () => {
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
    ['independent-check-1-runtime-retry-1'],
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

test('split recovery checkpoints preserve exact remaining children and top-level controller frontiers', () => {
  const group = ['work-1:split:1', 'work-1:split:2']
  const first = {
    workItemId: group[0], recoveryGroupWorkIds: group,
    recoveryJoinWorkIds: ['work-2', 'work-3'], nextReadyAfter: [group[1]],
  }
  const second = { ...first, workItemId: group[1] }
  assert.deepEqual(recoveryGroupNextReady(first, ['work-1']), [group[1]])
  assert.deepEqual(recoveryGroupNextReady(second, ['work-1', group[0]]), ['work-2', 'work-3'])
  assert.deepEqual(recoveryGroupNextReady({ ...second, recoveryJoinWorkIds: [] },
    ['work-1', group[0]]), [])
  assert.throws(() => recoveryGroupNextReady({
    ...first, recoveryGroupWorkIds: [group[0], group[0]],
  }, ['work-1']), error => error.code === 'CHECK_RETRY_STATE_INVALID')
})

test('three-worker split execution binds every child checkpoint to all remaining top-level workers', async t => {
  const targetPath = createTempGitTarget(tempDirectory(t, 'autoprompt-split-frontier-'))
  const routeDecision = structuredClone(decision('DIRECT'))
  routeDecision.usefulWorkerCount = 3
  routeDecision.workerResponsibilities = ['Split the first item.', 'Complete item two.', 'Complete item three.']
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
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'split'\n")
        return { code: 'SPLIT_REQUIRED', remainingConcerns: ['api', 'ui'] }
      }
      if (request.logicalRole === 'worker') return { allAssignedItemsPass: true }
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.ok(['DONE', 'PARTIAL'].includes(result.outcome), JSON.stringify(result))
  const children = requests.filter(request => request.workItemId.startsWith('work-1:split:'))
  assert.equal(children.length, 2)
  for (const child of children) {
    assert.deepEqual(child.recoveryGroupWorkIds, ['work-1:split:1', 'work-1:split:2'])
    assert.deepEqual(child.recoveryJoinWorkIds, ['work-2', 'work-3'])
  }
})

test('ROADMAP executes every named scout, joins durable evidence into same-author revision, then checks the revised plan', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-scout-')
  const targetPath = createTempGitTarget(directory)
  const usableDeliverable = path.join(targetPath, 'dist', 'roadmap-result.txt')
  const launches = []
  const results = new Map()
  let plan = null
  const descriptiveLikelyArea = 'ERP planning, demand, engineering-release, routing, qualification, and WIP data exposed by the gateway'
  const routeDecision = decision('ROADMAP', {
    scoutCount: 2,
    missingInformation: ['Which service owns session migration?', 'Which client ships after the API?'],
    mutableResourceOwnership: [
      { kind: 'external-system', identity: 'ERP', owner: 'mission-coordinator', ownershipMode: 'single-owner' },
      { kind: 'file', identity: 'output/erp.sql', owner: 'worker-erp', ownershipMode: 'single-owner' },
      { kind: 'file', identity: 'output/mes.sql', owner: 'worker-mes', ownershipMode: 'single-owner' },
      { kind: 'file', identity: 'output/wms.sql', owner: 'worker-wms', ownershipMode: 'single-owner' },
    ],
    likelyAreas: [descriptiveLikelyArea],
    workers: {
      count: 3,
      responsibilities: ['Implement ERP writeback.', 'Implement MES writeback.', 'Implement WMS writeback.'],
      non_overlap_reason: 'Each worker owns one disjoint SQL deliverable.',
    },
  })
  const roadmapCandidate = 'd'.repeat(64)
  assert.equal(routeDecision.topology.coordination.scouts.count, 2)
  assert.deepEqual(routeDecision.topology.coordination.scouts.namedUnknowns,
    ['Which service owns session migration?', 'Which client ships after the API?'])
  const launch = async request => {
    launches.push(request)
    const scoutCorrections = {
      'roadmap-scout-1': 'Place session migration before API rollout.',
      'roadmap-scout-2': 'Ship the API before the dependent client.',
    }
    if (request.logicalRole === 'worker') {
      fs.mkdirSync(path.dirname(usableDeliverable), { recursive: true })
      fs.writeFileSync(usableDeliverable, 'dependency-ordered migration rollout\n')
    }
    const deliverableHash = fs.existsSync(usableDeliverable)
      ? crypto.createHash('sha256').update(fs.readFileSync(usableDeliverable)).digest('hex')
      : null
    const result = request.workItemId === 'roadmap-plan-check'
      ? {
          code: 'FAIL',
          events: [{ output: 'x'.repeat(512 * 1024) }],
          payload: { findings: ['dependency edge is missing'] },
        }
      : request.logicalRole === 'plan-checker'
        ? { code: 'PASS' }
        : request.logicalRole.startsWith('independent-')
          ? {
              code: 'PASS',
              payload: {
                evidenceIds: [`build-acceptance:${request.workItemId}`],
                referenceMethod: checkerReferenceMethod(
                  request.logicalRole === 'independent-reviewer'
                    ? 'requirements-review'
                    : 'black-box-boundary',
                  request.workItemId,
                ),
                testOutcomes: checkerTestOutcomes(request),
                buildAcceptance: {
                  status: 'PASS', deliverable: usableDeliverable, sha256: deliverableHash,
                },
              },
            }
        : {
          reportId: request.workItemId,
          successItems: [{ id: request.workItemId, description: request.assignment }],
          filesChanged: request.logicalRole === 'worker' ? ['dist/roadmap-result.txt'] : [],
          buildAcceptance: request.logicalRole === 'worker'
            ? { status: 'PASS', deliverable: usableDeliverable, sha256: deliverableHash }
            : null,
          behaviorChanged: request.logicalRole === 'scout'
            ? [scoutCorrections[request.workItemId]]
            : request.logicalRole === 'roadmap-author'
              ? request.workItemId === 'roadmap-author'
                ? ['Prepare the migration owner boundary.']
                : [
                    'Prepare the migration owner boundary.',
                    ...Object.values(scoutCorrections),
                    'Integrate and verify the dependent rollout.',
                  ]
              : ['Execute the accepted roadmap assignment.'],
        }
    if (request.retainLease) {
      result.retainedLease = {
        schedulerLease: {}, completed: false, workItemId: request.workItemId,
        caller: {},
      }
    }
    results.set(request.workItemId, result)
    return result
  }
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: CANDIDATE_A, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64) }),
    writePlan: (_route, _decision, authorResult) => { plan = renderPlanArtifact('ROADMAP', routeDecision, authorResult) },
    planExists: () => plan !== null,
    planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: roadmapCandidate, bytes: 1 }),
    readResult: workItemId => results.get(workItemId) || null,
    resultPointer: workItemId => {
      const resultPath = path.join(directory, `${workItemId}.json`)
      const bytes = Buffer.from(JSON.stringify(results.get(workItemId)))
      fs.writeFileSync(resultPath, bytes)
      return {
        name: workItemId, path: resultPath,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      }
    },
  })
  const completedRetained = []
  const outcome = await executor({
    route: 'ROADMAP', decision: routeDecision, launch,
    completeRetainedLease: retained => { retained.completed = true; completedRetained.push(retained.workItemId) },
    resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches.slice(0, 4).map(item => item.workItemId), [
    'roadmap-author', 'roadmap-scout-1', 'roadmap-scout-2', 'roadmap-author-revise',
  ])
  const revision = launches.find(item => item.workItemId === 'roadmap-author-revise')
  assert.equal(revision.repairOf, 'roadmap-author')
  assert.equal(revision.executorKey, 'roadmap-author')
  assert.deepEqual(revision.evidencePointers.map(pointer => pointer.name), ['roadmap-scout-1', 'roadmap-scout-2'])
  assert.deepEqual(
    schedulerProgressEvidenceHashes(revision),
    revision.evidencePointers.map(pointer => pointer.hash).sort(),
  )
  assert.deepEqual(revision.manifests.map(item => item.owner), [
    'mission-coordinator', 'worker-1', 'worker-2', 'worker-3',
  ])
  assert.deepEqual(launches.find(item => item.workItemId === 'roadmap-author').manifests, revision.manifests)
  assert.deepEqual(launches.find(item => item.workItemId === 'roadmap-author')
    .fetchedEvidence.descriptiveLikelyAreas, [descriptiveLikelyArea])
  for (const planningId of ['roadmap-scout-1', 'roadmap-scout-2']) {
    const planningLaunch = launches.find(item => item.workItemId === planningId)
    assert.deepEqual(planningLaunch.ownership, ['workspace'])
    assert.deepEqual(planningLaunch.fetchedEvidence.descriptiveLikelyAreas, [descriptiveLikelyArea])
  }
  const planCheck = launches.find(item => item.workItemId === 'roadmap-plan-check')
  assert.equal(planCheck.candidateHash, roadmapCandidate)
  assert.deepEqual(planCheck.evidencePointers.map(pointer => pointer.name), ['roadmap-scout-1', 'roadmap-scout-2'])
  const planRepair = launches.find(item => item.workItemId === 'roadmap-author-plan-repair')
  assert.equal(planRepair.repairOf, 'roadmap-author-revise')
  assert.equal(planRepair.executorKey, 'roadmap-author')
  assert.deepEqual(planRepair.evidencePointers.map(pointer => pointer.name), [
    'roadmap-scout-1', 'roadmap-scout-2', 'roadmap-plan-check',
  ])
  assert.equal(Object.hasOwn(planRepair.fetchedEvidence, 'planCheck'), false)
  assert.ok(Buffer.byteLength(JSON.stringify(planRepair.fetchedEvidence), 'utf8') < 16 * 1024)
  assert.deepEqual(planRepair.manifests, revision.manifests)
  const planRecheck = launches.find(item => item.workItemId === 'roadmap-plan-recheck')
  assert.equal(planRecheck.candidateHash, roadmapCandidate)
  assert.equal(planRecheck.repairOf, 'roadmap-plan-check')
  assert.equal(planRecheck.executorKey, 'roadmap-plan-check')
  assert.deepEqual(planRecheck.evidenceHashes, [planRepair.evidencePointers.at(-1).hash])
  assert.match(plan, /1\. Prepare the migration owner boundary\./)
  assert.match(plan, /Place session migration before API rollout\./)
  assert.match(plan, /Ship the API before the dependent client\./)
  assert.ok(plan.indexOf('Place session migration') < plan.indexOf('Ship the API'))
  const manager = launches.find(item => item.workItemId === 'roadmap-work-group')
  assert.deepEqual(manager.ownership, ['workspace'])
  assert.deepEqual(manager.fetchedEvidence.descriptiveLikelyAreas, [descriptiveLikelyArea])
  assert.deepEqual(manager.workGroupAdmission.workerAssignments.map(item => item.mutableResourceIdentities), [
    ['output/erp.sql'], ['output/mes.sql'], ['output/wms.sql'],
  ])
  assert.deepEqual(completedRetained, ['roadmap-work-group', 'mission-coordination'])
})

test('ROADMAP CHECK_INCONCLUSIVE retries with result-bound progress then returns PARTIAL without author repair', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-inconclusive-')
  const targetPath = createTempGitTarget(directory)
  const launches = []
  const transitions = []
  let planExists = false
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => transitions.push({ eventId, nextState, details }),
    harnessAttestation: () => ({ repoHash: CANDIDATE_A, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64) }),
    writePlan: () => { planExists = true },
    planExists: () => planExists,
    planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: 'd'.repeat(64), bytes: 1 }),
    resultPointer: () => assert.fail('inconclusive plan check must not resolve repair evidence'),
  })
  const outcome = await executor({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => {
      launches.push(request)
      if (request.workItemId.startsWith('roadmap-plan-check')) {
        return { code: 'CHECK_INCONCLUSIVE', payload: { unblockPath: 'provide checker scratch storage' } }
      }
      return { reportId: request.workItemId, behaviorChanged: ['Prepare the bounded roadmap.'] }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'PARTIAL')
  assert.equal(outcome.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
  assert.deepEqual(launches.map(item => item.workItemId), [
    'roadmap-author', 'roadmap-plan-check', 'roadmap-plan-check-runtime-retry',
  ])
  const retry = launches.at(-1)
  assert.deepEqual(retry.evidenceHashes, [
    crypto.createHash('sha256')
      .update(JSON.stringify({ code: 'CHECK_INCONCLUSIVE', payload: { unblockPath: 'provide checker scratch storage' } }))
      .digest('hex'),
  ])
  assert.equal(retry.executorKey, 'roadmap-plan-check')
  assert.deepEqual(
    transitions.find(item => item.eventId === 'CHECK_INCONCLUSIVE').details.nextReadyWorkIds,
    ['roadmap-plan-check-runtime-retry'],
  )
})

test('ROADMAP conclusive retry FAIL binds repair to the retry receipt, not the original inconclusive result', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-retry-fail-')
  const targetPath = createTempGitTarget(directory)
  const results = new Map()
  const launches = []
  const transitions = []
  const retryHash = 'f'.repeat(64)
  const executor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => transitions.push({ eventId, nextState, details }),
    harnessAttestation: candidateHash => ({ repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64) }),
    writePlan: () => {}, planExists: () => true,
    planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: retryHash, bytes: 1 }),
    resultPointer(workItemId) {
      assert.equal(workItemId, 'roadmap-plan-check-runtime-retry')
      const resultPath = path.join(directory, `${workItemId}.json`)
      const bytes = Buffer.from(JSON.stringify(results.get(workItemId)))
      fs.writeFileSync(resultPath, bytes)
      return {
        name: workItemId, path: resultPath,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      }
    },
  })
  await assert.rejects(executor({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'roadmap-author') return { behaviorChanged: ['Prepare the bounded roadmap.'] }
      if (request.workItemId === 'roadmap-plan-check') {
        const result = { code: 'CHECK_INCONCLUSIVE', cause: { reason: 'transport lost' } }
        results.set(request.workItemId, result)
        return result
      }
      if (request.workItemId === 'roadmap-plan-check-runtime-retry') {
        assert.equal(request.evidenceHashes.length, 1)
        assert.match(request.evidenceHashes[0], /^[a-f0-9]{64}$/u)
        const result = { code: 'FAIL', payload: { findings: ['missing dependency edge'] } }
        results.set(request.workItemId, result)
        return result
      }
      if (request.workItemId === 'roadmap-author-plan-repair') {
        assert.equal(request.evidencePointers.at(-1).name, 'roadmap-plan-check-runtime-retry')
        throw Object.assign(new Error('repair receipt verified'), { code: 'TEST_STOP' })
      }
      return { reportId: request.workItemId }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'TEST_STOP')
  assert.deepEqual(launches.slice(0, 4), [
    'roadmap-author', 'roadmap-plan-check', 'roadmap-plan-check-runtime-retry',
    'roadmap-author-plan-repair',
  ])
  assert.deepEqual(
    transitions.find(item => item.eventId === 'CHECK_BECAME_CONCLUSIVE').details.nextReadyWorkIds,
    ['roadmap-author-plan-repair'],
  )
})

test('ROADMAP terminal recheck FAIL resume consumes its durable disposition without relaunch', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-terminal-recheck-resume-')
  const targetPath = createTempGitTarget(directory)
  const planHash = 'd'.repeat(64)
  const checkerId = 'roadmap-plan-recheck-runtime-retry'
  const checkerResult = { code: 'FAIL', payload: { findings: ['repair remained invalid'] } }
  const resultPath = path.join(directory, `${checkerId}.json`)
  fs.writeFileSync(resultPath, `${JSON.stringify(checkerResult)}\n`)
  const bytes = fs.readFileSync(resultPath)
  const pointer = {
    name: checkerId, path: resultPath,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: candidateHash => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
    }),
    readResult: workItemId => workItemId === checkerId ? checkerResult : null,
    resultPointer: workItemId => {
      assert.equal(workItemId, checkerId)
      return pointer
    },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, checkerId)
      assert.equal(result, checkerResult)
      return true
    },
  })({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => { launches.push(request.workItemId); return { reportId: request.workItemId } },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'RUN_WORK', planHash, completedWorkIds: ['roadmap-author', 'roadmap-author-plan-repair'],
      completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: [],
      retryState: { conclusiveCheckerTerminal: {
        checkerId, candidateHash: planHash,
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(checkerResult)).digest('hex'),
        code: 'FAIL', returnState: 'RUN_WORK',
      } },
    },
  })
  assert.equal(outcome.outcome, 'FAILED')
  assert.equal(outcome.terminalEnvelope.code, 'FAIL')
  assert.deepEqual(launches, [])
})

test('ROADMAP post-retry durable non-authoritative result returns without relaunch', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-post-retry-terminal-')
  const targetPath = createTempGitTarget(directory)
  const planHash = 'd'.repeat(64)
  const baseId = 'roadmap-plan-recheck'
  const retryId = 'roadmap-plan-recheck-runtime-retry'
  const baseResult = {
    code: 'CHECK_INCONCLUSIVE', candidateHash: planHash,
    cause: { reason: 'durable base transport ended' },
  }
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
    harnessAttestation: candidateHash => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
    }),
    writePlan: () => {}, planExists: () => true,
    planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: planHash, bytes: 1 }),
    readResult: workItemId => records[workItemId] || (workItemId === 'roadmap-author-plan-repair'
      ? { behaviorChanged: ['Preserve the repaired roadmap.'] } : null),
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.deepEqual(result, records[workItemId]); return true
    },
  })({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => { launches.push(request.workItemId); return { reportId: request.workItemId } },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE', planHash,
      completedWorkIds: ['roadmap-author', 'roadmap-author-plan-repair'],
      completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: [],
      retryState: { inconclusiveChecker: {
        checkerId: baseId, candidateHash: planHash,
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'RUN_WORK',
      } },
    },
  })
  assert.equal(outcome.outcome, 'PARTIAL')
  assert.equal(outcome.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
  assert.deepEqual(launches, [])
})

test('ROADMAP post-retry PASS checkpoint is consumed once before controller transition', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-post-retry-pass-')
  const targetPath = createTempGitTarget(directory)
  const planHash = '7'.repeat(64)
  const baseId = 'roadmap-plan-check'
  const retryId = `${baseId}-runtime-retry`
  const baseResult = { code: 'CHECK_INCONCLUSIVE', candidateHash: planHash,
    cause: { reason: 'base plan transport ended' } }
  const retryResult = { code: 'PASS', candidateHash: planHash }
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
  const executor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env,
    transition: async (event, state, details) => transitions.push([event, state, details && details.checkerId]),
    writePlan: () => {}, planExists: () => true,
    planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: planHash, bytes: 1 }),
    readResult: workItemId => records[workItemId] ||
      (workItemId === 'roadmap-author' ? { behaviorChanged: ['Prepare the bounded roadmap.'] } : null),
    resultPointer: workItemId => pointers.get(workItemId),
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.deepEqual(result, records[workItemId]); return true
    },
    harnessAttestation: candidateHash => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
    }),
  })
  await assert.rejects(executor({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => {
      launches.push(request.workItemId)
      assert.equal(request.workItemId, 'mission-coordination')
      throw Object.assign(new Error('accepted plan reached coordination'), { code: 'TEST_STOP' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE', planHash,
      completedWorkIds: ['roadmap-author'], completedCheckIds: [retryId],
      acceptedResultIds: [], nextReadyWorkIds: ['mission-coordination'],
      retryState: { inconclusiveChecker: {
        checkerId: baseId, candidateHash: planHash,
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'RUN_WORK',
      } },
    },
  }), error => error.code === 'TEST_STOP')
  assert.deepEqual(launches, ['mission-coordination'])
  assert.deepEqual(transitions.filter(([event]) => event === 'CHECK_BECAME_CONCLUSIVE'), [
    ['CHECK_BECAME_CONCLUSIVE', 'RUN_WORK', retryId],
  ])
})

test('ROADMAP base recheck PASS or FAIL is consumed at its post-result controller boundary', async t => {
  for (const code of ['PASS', 'FAIL']) {
    const directory = tempDirectory(t, `autoprompt-roadmap-recheck-${code.toLowerCase()}-`)
    const targetPath = createTempGitTarget(directory)
    const planHash = crypto.createHash('sha256').update(code).digest('hex')
    const recheckId = 'roadmap-plan-recheck'
    const recheckResult = { code, candidateHash: planHash }
    const resultPath = path.join(directory, `${recheckId}.json`)
    fs.writeFileSync(resultPath, `${JSON.stringify(recheckResult)}\n`)
    const bytes = fs.readFileSync(resultPath)
    const pointer = { name: recheckId, path: resultPath,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    const launches = []
    const executor = createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env, transition: async () => {},
      writePlan: () => {}, planExists: () => true,
      planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: planHash, bytes: 1 }),
      readResult: workItemId => workItemId === recheckId ? recheckResult
        : workItemId === 'roadmap-author-plan-repair'
          ? { behaviorChanged: ['Preserve the repaired roadmap.'] }
          : workItemId === 'roadmap-author'
            ? { behaviorChanged: ['Prepare the bounded roadmap.'] } : null,
      resultPointer: workItemId => { assert.equal(workItemId, recheckId); return pointer },
      verifyDurableResultReceipt: (workItemId, result) => {
        assert.equal(workItemId, recheckId); assert.deepEqual(result, recheckResult); return true
      },
      harnessAttestation: candidateHash => ({
        repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
      }),
    })
    const resumeState = {
      resumeState: 'RUN_WORK', planHash,
      completedWorkIds: ['roadmap-author', 'roadmap-author-plan-repair'],
      completedCheckIds: code === 'PASS' ? [recheckId] : [], acceptedResultIds: [],
      nextReadyWorkIds: code === 'PASS' ? ['mission-coordination'] : [], retryState: {},
    }
    if (code === 'PASS') {
      await assert.rejects(executor({
        route: 'ROADMAP', decision: decision('ROADMAP'),
        launch: async request => {
          launches.push(request.workItemId)
          assert.equal(request.workItemId, 'mission-coordination')
          throw Object.assign(new Error('accepted recheck reached coordination'), { code: 'TEST_STOP' })
        },
        completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState,
      }), error => error.code === 'TEST_STOP')
      assert.deepEqual(launches, ['mission-coordination'])
    } else {
      const outcome = await executor({
        route: 'ROADMAP', decision: decision('ROADMAP'),
        launch: async request => { launches.push(request.workItemId); return { reportId: request.workItemId } },
        completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState,
      })
      assert.equal(outcome.outcome, 'FAILED')
      assert.deepEqual(launches, [])
    }
  }
})

test('ROADMAP resume consumes canonical PASS checkpoint and an adopted retry verdict without duplicate plan launches', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-plan-resume-')
  const targetPath = createTempGitTarget(directory)
  const planHash = 'd'.repeat(64)
  const baseId = 'roadmap-plan-check'
  const retryId = 'roadmap-plan-check-runtime-retry'
  const baseResult = {
    code: 'CHECK_INCONCLUSIVE', candidateHash: planHash,
    cause: { reason: 'base plan check transport ended' },
  }
  const basePath = path.join(directory, `${baseId}.json`)
  fs.writeFileSync(basePath, `${JSON.stringify(baseResult)}\n`)
  const baseBytes = fs.readFileSync(basePath)
  const basePointer = { name: baseId, path: basePath,
    hash: crypto.createHash('sha256').update(baseBytes).digest('hex'), bytes: baseBytes.length }
  const baseOptions = {
    targetPath, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: candidateHash => ({ repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64) }),
    writePlan: () => {}, planExists: () => true,
    planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: planHash, bytes: 1 }),
    readResult: workItemId => workItemId === 'roadmap-author'
      ? { behaviorChanged: ['Prepare the bounded roadmap.'] }
      : workItemId === baseId ? baseResult : null,
    resultPointer: workItemId => { assert.equal(workItemId, baseId); return basePointer },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, baseId); assert.equal(result, baseResult); return true
    },
  }
  const checkpointLaunches = []
  await assert.rejects(createDefaultRouteExecutor(baseOptions)({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => {
      checkpointLaunches.push(request.workItemId)
      assert.notEqual(request.logicalRole, 'plan-checker')
      throw Object.assign(new Error('checkpoint consumed'), { code: 'TEST_STOP' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'RUN_WORK', completedWorkIds: ['roadmap-author'],
      completedCheckIds: ['roadmap-plan-check-runtime-retry'], acceptedResultIds: [],
    },
  }), error => error.code === 'TEST_STOP')
  assert.equal(checkpointLaunches[0], 'mission-coordination')

  const orphanRetryResult = {
    code: 'CHECK_INCONCLUSIVE', candidateHash: planHash,
    cause: { reason: 'retry transport remained unavailable' },
  }
  const retryPath = path.join(directory, `${retryId}.json`)
  fs.writeFileSync(retryPath, `${JSON.stringify(orphanRetryResult)}\n`)
  const retryBytes = fs.readFileSync(retryPath)
  const retryPointer = { name: retryId, path: retryPath,
    hash: crypto.createHash('sha256').update(retryBytes).digest('hex'), bytes: retryBytes.length }
  const adoptedLaunches = []
  const adoptedOutcome = await createDefaultRouteExecutor({
    ...baseOptions,
    readResult: workItemId => workItemId === 'roadmap-author'
      ? { behaviorChanged: ['Prepare the bounded roadmap.'] }
      : workItemId === baseId ? baseResult : workItemId === retryId ? orphanRetryResult : null,
    resultPointer: workItemId => workItemId === baseId ? basePointer : retryPointer,
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, baseId, 'the orphan retry receipt is admitted by live-lease rematerialization')
      assert.equal(result, baseResult)
      return true
    },
  })({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => { adoptedLaunches.push(request.workItemId); return { reportId: request.workItemId } },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async ({ stage, candidateHash }) => {
      assert.equal(candidateHash, planHash)
      return stage === 'work' ? { [retryId]: orphanRetryResult } : {}
    },
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE', candidateHash: planHash, planHash,
      completedWorkIds: ['roadmap-author'],
      completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: [`reconcile:${retryId}`],
      schedulerCrashCheckpoint: { kind: 'scheduler-crash-checkpoint' },
      adoptedRecords: [{ id: 'lease-roadmap-retry', workItemId: retryId }],
      openLeaseIds: ['lease-roadmap-retry'],
      retryState: { inconclusiveChecker: {
        checkerId: baseId, candidateHash: planHash,
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'RUN_WORK',
      } },
    },
  })
  assert.equal(adoptedOutcome.outcome, 'PARTIAL')
  assert.equal(adoptedOutcome.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
  assert.equal(adoptedLaunches.some(id => id.startsWith('roadmap-plan-check')), false)
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

test('ROADMAP resume consumes adopted repaired-plan base and retry verdicts before any fresh plan check', async t => {
  for (const adoptedId of ['roadmap-plan-recheck', 'roadmap-plan-recheck-runtime-retry']) {
    const directory = tempDirectory(t, `autoprompt-roadmap-adopted-${adoptedId}-`)
    const targetPath = createTempGitTarget(directory)
    const planHash = crypto.createHash('sha256').update(adoptedId).digest('hex')
    const launches = []
    const transitions = []
    const retry = adoptedId.endsWith('-runtime-retry')
    const retryBaseId = 'roadmap-plan-recheck'
    const retryBaseResult = {
      code: 'CHECK_INCONCLUSIVE', candidateHash: planHash,
      cause: { reason: 'recheck transport ended before retry' },
    }
    const retryBasePath = path.join(directory, `${retryBaseId}.json`)
    fs.writeFileSync(retryBasePath, `${JSON.stringify(retryBaseResult)}\n`)
    const retryBaseBytes = fs.readFileSync(retryBasePath)
    const retryBasePointer = { name: retryBaseId, path: retryBasePath,
      hash: crypto.createHash('sha256').update(retryBaseBytes).digest('hex'), bytes: retryBaseBytes.length }
    const executor = createDefaultRouteExecutor({
      targetPath, gitEnvironment: () => process.env,
      transition: async (event, state, details) => transitions.push([event, state, details && details.checkerId]),
      harnessAttestation: candidateHash => ({
        repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
      }),
      writePlan: () => {}, planExists: () => true,
      planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: planHash, bytes: 1 }),
      readResult: workItemId => workItemId === 'roadmap-author'
        ? { behaviorChanged: ['Prepare the bounded roadmap.'] }
        : retry && workItemId === retryBaseId ? retryBaseResult : null,
      resultPointer: workItemId => {
        assert.equal(workItemId, retryBaseId)
        return retryBasePointer
      },
      verifyDurableResultReceipt: (workItemId, result) => {
        assert.equal(workItemId, retryBaseId); assert.equal(result, retryBaseResult); return true
      },
    })
    await assert.rejects(executor({
      route: 'ROADMAP', decision: decision('ROADMAP'),
      launch: async request => {
        launches.push(request.workItemId)
        assert.equal(request.logicalRole === 'plan-checker', false,
          `adopted ${adoptedId} must suppress every fresh plan check`)
        throw Object.assign(new Error('recheck consumed'), { code: 'TEST_STOP' })
      },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async ({ stage }) => stage === 'work'
        ? { [adoptedId]: { code: 'PASS', currentVersionHash: planHash } } : {},
      resumeState: retry ? {
        resumeState: 'CHECK_INCONCLUSIVE',
        completedWorkIds: ['roadmap-author', 'roadmap-author-plan-repair'],
        completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: [adoptedId],
        retryState: { inconclusiveChecker: {
          checkerId: retryBaseId, candidateHash: planHash,
          checkerResultHash: crypto.createHash('sha256')
            .update(JSON.stringify(retryBaseResult)).digest('hex'),
          retryAttempt: 1, returnState: 'RUN_WORK',
        } },
      } : {
        resumeState: 'RUN_WORK',
        completedWorkIds: ['roadmap-author', 'roadmap-author-plan-repair'],
        completedCheckIds: [], acceptedResultIds: [],
        nextReadyWorkIds: [`reconcile:${adoptedId}`],
        schedulerCrashCheckpoint: { kind: 'scheduler-crash-checkpoint' },
        adoptedRecords: [{ id: `lease-${adoptedId}`, workItemId: adoptedId }],
        openLeaseIds: [`lease-${adoptedId}`], retryState: {},
      },
    }), error => error.code === 'TEST_STOP')
    assert.equal(launches[0], 'mission-coordination')
    assert.deepEqual(transitions.filter(([event]) => event === 'CHECK_BECAME_CONCLUSIVE'),
      retry ? [['CHECK_BECAME_CONCLUSIVE', 'RUN_WORK', adoptedId]] : [])
  }
})

test('ROADMAP resume rematerializes a durable author repair before admitting its plan recheck', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-repair-render-crash-')
  const targetPath = createTempGitTarget(directory)
  const planPath = path.join(directory, 'ROADMAP.md')
  fs.writeFileSync(planPath, 'stale pre-repair roadmap\n')
  const staleHash = crypto.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex')
  const failResult = { code: 'FAIL', candidateHash: staleHash, payload: { findings: ['rollback owner missing'] } }
  const failPath = path.join(directory, 'roadmap-plan-check.json')
  fs.writeFileSync(failPath, `${JSON.stringify(failResult, null, 2)}\n`)
  const failBytes = fs.readFileSync(failPath)
  const failPointer = {
    name: 'roadmap-plan-check', path: failPath,
    hash: crypto.createHash('sha256').update(failBytes).digest('hex'), bytes: failBytes.length,
  }
  const repairedResult = {
    behaviorChanged: ['Prepare the bounded roadmap.', 'Assign rollback ownership before release.'],
  }
  const launches = []
  let rematerializedHash = null
  const executor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: candidateHash => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
    }),
    writePlan: (route, routeDecision, authorResult) => {
      fs.writeFileSync(planPath, renderPlanArtifact(route, routeDecision, authorResult))
      rematerializedHash = crypto.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex')
    },
    planExists: () => true,
    planPointer: () => {
      const bytes = fs.readFileSync(planPath)
      return { path: planPath, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    },
    readResult: workItemId => ({
      'roadmap-author': { behaviorChanged: ['Prepare the bounded roadmap.'] },
      'roadmap-author-plan-repair': repairedResult,
      'roadmap-plan-check': failResult,
    })[workItemId] || null,
    resultPointer: workItemId => {
      assert.equal(workItemId, 'roadmap-plan-check')
      return failPointer
    },
  })
  await assert.rejects(executor({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'roadmap-plan-recheck') {
        assert.ok(rematerializedHash)
        assert.notEqual(rematerializedHash, staleHash)
        assert.equal(request.candidateHash, rematerializedHash)
        assert.deepEqual(request.evidenceHashes, [failPointer.hash])
        return { code: 'PASS', currentVersionHash: rematerializedHash }
      }
      throw Object.assign(new Error('repaired plan rechecked'), { code: 'TEST_STOP' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'RUN_WORK', candidateHash: null,
      completedWorkIds: ['roadmap-author', 'roadmap-author-plan-repair'],
      completedCheckIds: [], acceptedResultIds: [], nextReadyWorkIds: ['roadmap-plan-recheck'],
      retryState: {},
    },
  }), error => error.code === 'TEST_STOP')
  assert.deepEqual(launches.slice(0, 2), ['roadmap-plan-recheck', 'mission-coordination'])
  assert.equal(launches.includes('roadmap-plan-check'), false)
})

test('ROADMAP crash after first inconclusive plan result resumes only the durable retry allowance', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-inconclusive-crash-')
  const targetPath = createTempGitTarget(directory)
  const planHash = 'e'.repeat(64)
  const baseResult = { code: 'CHECK_INCONCLUSIVE', candidateHash: planHash,
    cause: { reason: 'base plan checker snapshot ended' } }
  const baseResultPath = path.join(directory, 'roadmap-plan-check.json')
  fs.writeFileSync(baseResultPath, `${JSON.stringify(baseResult)}\n`)
  const baseBytes = fs.readFileSync(baseResultPath)
  const basePointer = { name: 'roadmap-plan-check', path: baseResultPath,
    hash: crypto.createHash('sha256').update(baseBytes).digest('hex'), bytes: baseBytes.length }
  const launches = []
  const transitions = []
  const executor = createDefaultRouteExecutor({
    targetPath, gitEnvironment: () => process.env,
    transition: async (event, state, details) => transitions.push([
      event, state, details && details.checkerId, details && details.nextReadyWorkIds,
    ]),
    harnessAttestation: candidateHash => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
    }),
    writePlan: () => {}, planExists: () => true,
    planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: planHash, bytes: 1 }),
    readResult: workItemId => workItemId === 'roadmap-author'
      ? { behaviorChanged: ['Prepare the bounded roadmap.'] }
      : workItemId === 'roadmap-plan-check' ? baseResult : null,
    resultPointer: workItemId => { assert.equal(workItemId, 'roadmap-plan-check'); return basePointer },
    verifyDurableResultReceipt: (workItemId, result) => {
      assert.equal(workItemId, 'roadmap-plan-check'); assert.equal(result, baseResult); return true
    },
  })
  await assert.rejects(executor({
    route: 'ROADMAP', decision: decision('ROADMAP'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'roadmap-plan-check-runtime-retry') {
        return { code: 'PASS', currentVersionHash: planHash }
      }
      assert.notEqual(request.logicalRole, 'plan-checker')
      throw Object.assign(new Error('durable retry consumed'), { code: 'TEST_STOP' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE', completedWorkIds: ['roadmap-author'],
      completedCheckIds: [], acceptedResultIds: [],
      nextReadyWorkIds: ['roadmap-plan-check-runtime-retry'],
      retryState: { inconclusiveChecker: {
        checkerId: 'roadmap-plan-check', candidateHash: planHash,
        checkerResultHash: crypto.createHash('sha256').update(JSON.stringify(baseResult)).digest('hex'),
        retryAttempt: 1, returnState: 'RUN_WORK',
      } },
    },
  }), error => error.code === 'TEST_STOP')
  assert.deepEqual(launches.slice(0, 2), [
    'roadmap-plan-check-runtime-retry', 'mission-coordination',
  ])
  assert.equal(launches.includes('roadmap-plan-check'), false)
  assert.deepEqual(transitions.filter(([event]) => event === 'CHECK_BECAME_CONCLUSIVE'), [[
    'CHECK_BECAME_CONCLUSIVE', 'RUN_WORK', 'roadmap-plan-check-runtime-retry', ['mission-coordination'],
  ]])
})

test('ROADMAP RUN_WORK crash frontier authenticates committed checker bytes before retry or repair', async t => {
  for (const recovery of [
    {
      name: 'runtime-retry', resultId: 'roadmap-plan-check',
      nextReadyWorkId: 'roadmap-plan-check-runtime-retry', code: 'CHECK_INCONCLUSIVE',
    },
    {
      name: 'author-repair', resultId: 'roadmap-plan-check',
      nextReadyWorkId: 'roadmap-author-plan-repair', code: 'FAIL',
    },
  ]) {
    await t.test(recovery.name, async t => {
      const directory = tempDirectory(t, `autoprompt-roadmap-frontier-${recovery.name}-`)
      const targetPath = createTempGitTarget(directory)
      const planHash = crypto.createHash('sha256').update(recovery.name).digest('hex')
      const durableResult = {
        code: recovery.code,
        candidateHash: planHash,
        payload: recovery.code === 'FAIL'
          ? { findings: ['missing dependency edge'] }
          : { unblockPath: 'rematerialize the exact checker snapshot' },
      }
      const resultPath = path.join(directory, `${recovery.resultId}.json`)
      fs.writeFileSync(resultPath, `${JSON.stringify(durableResult, null, 2)}\n`)
      const resultBytes = fs.readFileSync(resultPath)
      const resultPointer = {
        name: recovery.resultId,
        path: resultPath,
        hash: crypto.createHash('sha256').update(resultBytes).digest('hex'),
        bytes: resultBytes.length,
      }
      const launches = []
      const transitions = []
      const executor = createDefaultRouteExecutor({
        targetPath, gitEnvironment: () => process.env,
        transition: async (event, state, details) => transitions.push([
          event, state, details && details.checkerId, details && details.nextReadyWorkIds,
        ]),
        harnessAttestation: candidateHash => ({
          repoHash: candidateHash, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64),
        }),
        writePlan: () => {}, planExists: () => true,
        planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: planHash, bytes: 1 }),
        readResult: workItemId => workItemId === 'roadmap-author'
          ? { behaviorChanged: ['Prepare the bounded roadmap.'] }
          : workItemId === recovery.resultId ? durableResult : null,
        resultPointer: workItemId => {
          assert.equal(workItemId, recovery.resultId)
          return resultPointer
        },
      })
      await assert.rejects(executor({
        route: 'ROADMAP', decision: decision('ROADMAP'),
        launch: async request => {
          launches.push(request.workItemId)
          if (recovery.name === 'runtime-retry' &&
              request.workItemId === 'roadmap-plan-check-runtime-retry') {
            assert.deepEqual(request.evidenceHashes, [
              crypto.createHash('sha256').update(JSON.stringify(durableResult)).digest('hex'),
            ])
            return { code: 'PASS', currentVersionHash: planHash }
          }
          if (recovery.name === 'author-repair' &&
              request.workItemId === 'roadmap-author-plan-repair') {
            assert.deepEqual(request.evidenceHashes, [resultPointer.hash])
            assert.equal(request.evidencePointers.at(-1).hash, resultPointer.hash)
          }
          throw Object.assign(new Error('authenticated frontier consumed'), { code: 'TEST_STOP' })
        },
        completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
        resumeState: {
          resumeState: 'RUN_WORK', candidateHash: null, planHash,
          completedWorkIds: ['roadmap-author'], completedCheckIds: [], acceptedResultIds: [],
          nextReadyWorkIds: [recovery.nextReadyWorkId], retryState: {},
        },
      }), error => error.code === 'TEST_STOP')
      assert.equal(launches.includes('roadmap-plan-check'), false)
      if (recovery.name === 'runtime-retry') {
        assert.deepEqual(launches.slice(0, 2), [
          'roadmap-plan-check-runtime-retry', 'mission-coordination',
        ])
        assert.deepEqual(transitions.filter(([event]) => event === 'CHECK_BECAME_CONCLUSIVE'), [[
          'CHECK_BECAME_CONCLUSIVE', 'RUN_WORK', 'roadmap-plan-check-runtime-retry', ['mission-coordination'],
        ]])
      } else {
        assert.deepEqual(launches, ['roadmap-author-plan-repair'])
      }
    })
  }
})

test('ROADMAP resume consumes completed scout frontier and starts at same-author join without relaunching discovery', async t => {
  const directory = tempDirectory(t, 'autoprompt-roadmap-scout-resume-')
  const targetPath = createTempGitTarget(directory)
  const routeDecision = decision('ROADMAP', {
    scoutCount: 2,
    missingInformation: ['Unknown A', 'Unknown B'],
  })
  const launches = []
  const resumedDeliverable = path.join(targetPath, 'src', 'example.js')
  const restoredResult = workItemId => ({
    reportId: workItemId,
    successItems: [{ id: workItemId }],
    behaviorChanged: workItemId === 'roadmap-scout-1'
      ? ['Resolve Unknown A before dependent work.']
      : workItemId === 'roadmap-scout-2'
        ? ['Resolve Unknown B after Unknown A.']
        : ['Prepare the dependency-ordered roadmap.'],
  })
  const executor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: CANDIDATE_A, buildHash: 'b'.repeat(64), oracleHash: 'c'.repeat(64) }),
    writePlan: () => {}, planExists: () => true,
    planPointer: () => ({ path: path.join(directory, 'ROADMAP.md'), sha256: CANDIDATE_A, bytes: 1 }),
    readResult: restoredResult,
    resultPointer: workItemId => {
      const resultPath = path.join(directory, `${workItemId}.json`)
      const bytes = Buffer.from(JSON.stringify(restoredResult(workItemId)), 'utf8')
      fs.writeFileSync(resultPath, bytes)
      return {
        name: workItemId, path: resultPath,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      }
    },
  })
  const launch = async request => {
    launches.push(request)
    if (request.logicalRole === 'plan-checker' || request.logicalRole.startsWith('independent-')) {
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod(
          request.workItemId.endsWith('-2') ? 'black-box-boundary' : 'requirements-review',
          request.workItemId,
        ),
        testOutcomes: checkerTestOutcomes(request),
      } }
    }
    if (request.retainLease) return {
      retainedLease: { schedulerLease: {}, completed: false, workItemId: request.workItemId, caller: {} },
    }
    if (request.workItemId === 'roadmap-author-revise') {
      fs.writeFileSync(resumedDeliverable, "module.exports = 'resumed-roadmap'\n")
    }
    const result = {
      reportId: request.workItemId,
      successItems: [{ id: request.workItemId }],
      filesChanged: request.workItemId === 'roadmap-author-revise' ? ['src/example.js'] : [],
      behaviorChanged: request.logicalRole === 'roadmap-author'
        ? ['Prepare the dependency-ordered roadmap.', 'Resolve Unknown A before dependent work.', 'Resolve Unknown B after Unknown A.']
        : ['Complete the assigned work.'],
    }
    if (request.workItemId === 'roadmap-author-revise') {
      result.buildAcceptance = {
        status: 'PASS', deliverable: resumedDeliverable,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(resumedDeliverable)).digest('hex'),
      }
    }
    return result
  }
  const outcome = await executor({
    route: 'ROADMAP', decision: routeDecision, launch,
    completeRetainedLease: retained => { retained.completed = true },
    resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'RUN_WORK',
      completedWorkIds: ['roadmap-author', 'roadmap-scout-1', 'roadmap-scout-2'],
    },
  })
  assert.equal(outcome.outcome, 'DONE')
  assert.equal(launches.some(item => item.workItemId === 'roadmap-author'), false)
  assert.equal(launches.some(item => item.logicalRole === 'scout'), false)
  assert.equal(launches[0].workItemId, 'roadmap-author-revise')
  assert.equal(launches[0].repairOf, 'roadmap-author')
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
        assert.deepEqual(routeDecision.plannedChecks.filter(check => !request.checks.includes(check)), [])
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
          } }
        : { reportId: request.workItemId }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(launches.filter(item => item.logicalRole === 'worker').length, 1)
  assert.equal(launches.filter(item => item.logicalRole.startsWith('independent-')).length, 2)
  assert.equal(outcome.outcome, 'DONE')
  assert.equal(persisted.evaluation.localDoneAllowed, true)

  const overCap = JSON.parse(JSON.stringify(routeDecision))
  overCap.usefulWorkerCount = 2
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: overCap, launch: async () => ({}), completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'PROVISIONAL_WORK_CAP_EXCEEDED')
})

test('LIGHT plan preserves semantic risks and unknowns as executable falsification obligations', () => {
  const routeDecision = decision('LIGHT')
  routeDecision.plannedChecks = ['Confirm the output file exists.']
  routeDecision.risks = ['Effective-dated merges may collapse distinct donors before the transition.']
  routeDecision.missingInformation = ['Resolve pre-, at-, and post-effective identity semantics.']
  routeDecision.independentCheckingPlan.nonOverlapReason = 'One checker is sufficient.'
  const plan = renderPlanArtifact('LIGHT', routeDecision)
  assert.match(plan, /Risks to falsify/u)
  assert.match(plan, /collapse distinct donors before the transition/u)
  assert.match(plan, /Information to resolve before editing/u)
  assert.match(plan, /pre-, at-, and post-effective identity semantics/u)
  assert.match(plan, /positive, negative, and boundary witness/u)
  assert.match(plan, /Seat 2:/u)
  const checking = validateLiveCheckingPlan(routeDecision)
  assert.equal(checking.checkerCount, 2)
  assert.match(checking.responsibilities[1], /collapse distinct donors before the transition/u)
  assert.match(checking.responsibilities[1], /pre-, at-, and post-effective identity semantics/u)
  assert.doesNotMatch(checking.nonOverlapReason, /One checker is sufficient/u)
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
    writeCapturedDomainAdmission: record => { admission = record },
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

  let launches = 0
  await assert.rejects(() => executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async () => {
      launches += 1
      return { code: 'PASS', payload: { completedAt: '2026-08-23T00:00:00.000Z' } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'CAPTURED_DOMAIN_PREBUILD_VALIDATION_REQUIRED')
  assert.equal(launches, 1, 'a timestamp-only self-attestation must never reach a worker launch')

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

test('initial and dynamic depth probes publish exact multi-worker continuations', async t => {
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
      assert.equal(request.workItemId, 'conditional-depth-prober')
      assert.deepEqual(request.nextReadyAfter, ['work-1', 'work-2'])
      throw Object.assign(new Error('initial continuation observed'), { code: 'INITIAL_GATE_OBSERVED' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'INITIAL_GATE_OBSERVED')

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
      assert.equal(request.workItemId, 'conditional-depth-prober')
      assert.deepEqual(request.nextReadyAfter, ['work-2'])
      throw Object.assign(new Error('dynamic continuation observed'), { code: 'DYNAMIC_GATE_OBSERVED' })
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'DYNAMIC_GATE_OBSERVED')
})

test('completed initial and dynamic depth probes are authenticated and never relaunched', async t => {
  const directory = tempDirectory(t, 'autoprompt-depth-reuse-')
  const targetPath = createTempGitTarget(directory)
  const gateId = 'conditional-depth-prober'
  const gateResult = { code: 'PASS', payload: { evidenceIds: ['evidence:depth-probe'] } }
  const workerResult = { allAssignedItemsPass: true, payload: { runtimeSignals: {
    wrongLayerEvidence: true, repeatedFailureCount: 0, crossModuleUncertainty: false,
    evidenceIds: ['evidence:wrong-layer'],
  } } }
  const records = { [gateId]: gateResult, 'work-1': workerResult }
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
    if (tamper) {
      await assert.rejects(execution, error => error.code === 'RESULT_EVIDENCE_POINTER_INVALID' ||
        error.code === 'CRASH_ADOPTION_CONFLICT' || error.code === 'PLAN_CHECK_EVIDENCE_MISSING')
      assert.deepEqual(launches, [])
    } else {
      await assert.rejects(execution, error => error.code === 'DEPTH_REUSED')
      assert.deepEqual(launches, [initial ? 'work-1' : 'work-2'])
      assert.equal(verified.includes(gateId), true)
      if (!initial) assert.equal(verified.includes('work-1'), true)
    }
  }
  await runResume({ initial: true })
  await runResume({ initial: false })
  await runResume({ initial: true, tamper: true })
})

test('DONE retry keeps its isolated candidate unpromoted until the final acceptance join', async t => {
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
  const routeDecision = decision('DIRECT')
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
    async commit() { inconclusiveEvents.push('promoted') },
    async abort(reason) { inconclusiveEvents.push(`aborted:${reason}`) },
  }
  const inconclusive = await executor({
    route: 'DIRECT', decision: routeDecision,
    launch: async request => request.logicalRole === 'worker'
      ? { deferredPromotion: inconclusiveHandle }
      : { code: 'CHECK_INCONCLUSIVE', payload: { unblockPath: 'provide checker scratch storage' } },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(inconclusive.outcome, 'PARTIAL')
  assert.equal(inconclusive.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
  assert.equal(inconclusive.terminalEnvelope.code, 'CHECK_INCONCLUSIVE')
  assert.deepEqual(inconclusiveEvents, ['aborted:independent checker did not pass'])
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
  const routeDecision = decision('DIRECT')
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
  const expectedBranch = spawnSync('git', ['-C', ROOT, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim()
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
    limits: { wallMs: overrides.wallMs || 600000, tokens: 1000000, sessions: 20, launches: 20 },
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
      const snapshotSource = overrides.runtimeOptions && overrides.runtimeOptions.targetPath || ROOT
      const clone = spawnSync('git', ['clone', '--quiet', '--no-local', '--no-hardlinks', '--', snapshotSource, snapshot], { encoding: 'utf8' })
      assert.equal(clone.status, 0, clone.stderr)
      const snapshotBranch = overrides.runtimeOptions && overrides.runtimeOptions.expectedBranch || expectedBranch
      const hardenedSnapshot = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
        '--repo', snapshot, '--expected-branch', snapshotBranch, '--repair', '--json',
      ], { encoding: 'utf8', windowsHide: true })
      assert.equal([0, 3].includes(hardenedSnapshot.status), true, hardenedSnapshot.stderr || hardenedSnapshot.stdout)
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
    targetPath: ROOT,
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

test('AP-RUN-030 declared future deadline beyond the injected product hard maximum fails typed before production launch', async t => {
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
      executeRoute: async () => { executionCalls++; return { outcome: 'DONE' } },
    },
  })
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.deepEqual({
    outcome: result.outcome,
    status: result.terminalEnvelope && result.terminalEnvelope.status,
    executionCalls,
    launches: harness.launches.length,
  }, {
    outcome: 'PARTIAL',
    status: 'TASK_DEADLINE_EXCEEDS_PRODUCT_MAXIMUM',
    executionCalls: 0,
    launches: 0,
  })
})

test('AP-RUN-030 execution cannot consume the independent final-verification reserve', async t => {
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

test('AP-RUN-030 insufficient and expired deadlines fail typed before production launch', async t => {
  const wallNowMs = Date.parse('2026-08-23T10:00:00.000Z')
  const cases = [
    {
      id: 'insufficient',
      deadline: run030Deadline(new Date(wallNowMs + 10_000).toISOString(), {
        verificationReservePercent: 91,
        recoveryAndFinalizationReservePercent: 10,
      }),
      expected: 'TASK_DEADLINE_INSUFFICIENT',
    },
    {
      id: 'expired',
      deadline: run030Deadline(new Date(wallNowMs - 1).toISOString()),
      expected: 'TASK_DEADLINE_EXPIRED',
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
        executeRoute: async () => { executionCalls++; return { outcome: 'DONE' } },
      },
    })
    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    observed.push({
      id: item.id,
      outcome: result.outcome,
      status: result.terminalEnvelope && result.terminalEnvelope.status,
      executionCalls,
      launches: harness.launches.length,
    })
  }
  assert.deepEqual(observed, cases.map(item => ({
    id: item.id, outcome: 'PARTIAL', status: item.expected, executionCalls: 0, launches: 0,
  })))
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

test('AP-RUN-030 tampered and stale resume deadlines are rejected before execution', async t => {
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
      expected: 'RESUME_DEADLINE_EXPIRED',
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
    harness.runtimeOptions.executeRoute = async () => { executionCalls++; return { outcome: 'DONE' } }
    const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
    observed.push({
      id: item.id,
      outcome: result.outcome,
      status: result.terminalEnvelope && result.terminalEnvelope.status,
      executionCalls,
      launches: harness.launches.length,
    })
  }
  assert.deepEqual(observed, cases.map(item => ({
    id: item.id, outcome: 'PARTIAL', status: item.expected, executionCalls: 0, launches: 0,
  })))
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
    roadmap: { launches: 18, depth: 4 },
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
    assert.deepEqual(harness.launches.map(item => item.logicalRole), ['diagnostic-probe'])
    assert.equal(harness.record.writes.has('route/recommendation.json'), false)
    assert.equal(harness.record.writes.has('route/decision.json'), true)
    assert.equal(result.scheduler.counters.totalLaunches, 1)
    assert.equal(result.scheduler.limits.maxChildLaunches, expectedBudget[requested].launches)
    assert.equal(result.scheduler.limits.maxDepth, expectedBudget[requested].depth)
  }
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

test('settings and one saved analyst precede the four-minute L0 decision; no production launch starts first', async t => {
  const harness = makeHarness(t, { executeRoute: async () => assert.fail('execution must not start after decision timeout') })
  harness.runtimeOptions.decideRoute = async () => {
    harness.advance(240001)
    return { decision: decision('DIRECT'), submittedAtMs: 240001, usage: ZERO_USAGE }
  }
  harness.runtimeOptions.l0ViaScheduler = false
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.equal(result.outcome, 'FAILED')
  assert.equal(result.route, null)
  assert.deepEqual(harness.launches.map(item => item.logicalRole), ['route-analyst'], JSON.stringify({ result, finalizations: harness.finalizations }))
  assert.equal(harness.record.events.length, 1)
  assert.ok(harness.record.writes.has('route/recommendation.json'), JSON.stringify(harness.record.events))
  assert.equal(harness.record.writes.has('route/decision.json'), false)
  assert.equal(harness.processOwner.drained > 0, true)
})

test('the single L0 correction receives only the remainder of the monotonic four-minute ceiling', async t => {
  const attempts = []
  const timerDurations = []
  const harness = makeHarness(t, {
    executeRoute: async () => assert.fail('execution must not start after correction timeout'),
  })
  harness.runtimeOptions.decideRoute = async ({ correctionAttempts }) => {
    attempts.push({ correctionAttempts, at: harness.currentTime() })
    if (correctionAttempts === 0) {
      harness.advance(239_950)
      return { decision: {}, usage: ZERO_USAGE }
    }
    return new Promise(() => {})
  }
  harness.runtimeOptions.l0ViaScheduler = false
  harness.runtimeOptions.timerApi = {
    setTimeout(callback, milliseconds) {
      timerDurations.push(milliseconds)
      return { handle: setTimeout(callback, 0) }
    },
    clearTimeout(timer) { clearTimeout(timer.handle) },
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()

  assert.equal(result.outcome, 'FAILED')
  assert.deepEqual(attempts, [
    { correctionAttempts: 0, at: 0 },
    { correctionAttempts: 1, at: 239_950 },
  ])
  assert.deepEqual(timerDurations.filter(milliseconds => milliseconds <= 240_000).slice(-2), [240_000, 50])
  assert.equal(harness.processOwner.cancelled > 0, true)
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
      candidateHash: CANDIDATE_A, currentVersionHash: CANDIDATE_A,
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
      success: ['request passes'], candidateHash: CANDIDATE_A, oracle: 'focused-oracle',
      harnessAttestation: {
        repoHash: CANDIDATE_A,
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
    'route-analyst', 'diagnostic-probe', 'worker', 'worker', 'independent-reviewer',
  ])
  assert.equal(result.scheduler.counters.totalLaunches, 5)
  assert.equal(result.budget.launches, 5)
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
        candidateHash: CANDIDATE_A, currentVersionHash: CANDIDATE_A,
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
      candidateHash: CANDIDATE_A, oracle: 'focused-oracle', forkTurns: 1,
      recoveryContext: { type: 'bounded-recovery', code: 'DUPLICATE_REFERENCE_METHOD_CLASS' },
      harnessAttestation: {
        repoHash: CANDIDATE_A,
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

test('run-global hard budget does not reset on progress and drains descendants before typed PARTIAL finalization', async t => {
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
  assert.equal(result.outcome, 'PARTIAL', JSON.stringify(result))
  assert.equal(harness.finalizations.at(-1).outcome, 'PARTIAL')
  assert.equal(harness.processOwner.cancelled > 0, true)
  assert.equal(harness.processOwner.drained > 0, true)
  assert.ok(result.budget.consumedWallMs >= 101)
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
  assert.equal(checkpoints.filter(item => item.delta.launches === 1).length, 3)
  assert.equal(checkpoints.some(item => item.cause.causeId.startsWith('root-route-decision:') &&
    item.delta.sessions === 1 && item.delta.launches === 0), true)
  assert.equal(checkpoints.filter(item => item.cause.kind === 'TOKEN_USAGE_RECORDED').length, 4)
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

test('LIGHT planning admission timeout is terminal before route execution', async t => {
  const harness = makeHarness(t)
  let executed = false
  harness.runtimeOptions.decideRoute = async () => ({
    decision: decision('LIGHT'), submittedAtMs: harness.currentTime(), usage: ZERO_USAGE,
  })
  harness.runtimeOptions.planPreparer = async () => { harness.advance(300001) }
  harness.runtimeOptions.executeRoute = async () => {
    executed = true
    return { outcome: 'DONE' }
  }

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'ADMISSION_COMPONENT_TIMEOUT')
  assert.equal(result.scheduler.admission.withinCeiling, false)
  assert.deepEqual(result.scheduler.admission.breaches, ['lightPlanning'])
  assert.equal(executed, false)
})

test('benchmark baseEnvironment alone keeps analyst, L0, LIGHT planning, and scheduler time unbounded', async t => {
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
  assert.deepEqual(result.scheduler.admission.breaches, [])
  assert.equal(result.scheduler.admission.withinCeiling, true)
  assert.equal(result.schedulerState.settings.budget.admissionHardMs, Number.MAX_SAFE_INTEGER)
  assert.equal(result.schedulerState.settings.budget.tokens.noncachedInput,
    ROUTE_BUDGETS.LIGHT.tokens.noncachedInput)
})

test('terminal finalization is retryable after a drain failure and commits exactly once', async () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  let drainAttempts = 0
  let finalizeCalls = 0
  Object.assign(runtime, {
    finished: false,
    finalizing: false,
    finalizationPromise: null,
    scheduler: null,
    route: 'DIRECT',
    lease: {},
    processOwner: {
      async cancelAll() {
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

  await assert.rejects(runtime._finish('FAILED'), error => error.code === 'PROCESS_DRAIN_TIMEOUT')
  assert.equal(runtime.finished, false)
  assert.equal(runtime.finalizationPromise, null)
  const result = await runtime._finish('FAILED')
  assert.equal(result.outcome, 'FAILED')
  assert.equal(runtime.finished, true)
  assert.equal(finalizeCalls, 1)
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
  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'WAITING_USER', JSON.stringify(result))
  assert.equal(result.resumable, true)
  assert.equal(releaseAttempts, 2)
  assert.equal(harness.missionLock.releaseCalls, 1)
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

test('full start retries the exact verified DONE intent after one transient durable-finalizer failure', async t => {
  const harness = makeHarness(t)
  let attempts = 0
  harness.runtimeOptions.finalizerFactory = async ({ lease }) => ({
    async finalize(input) {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('transient durable finalizer failure'), { code: 'FINALIZER_WRITE_INTERRUPTED' })
      }
      harness.finalizations.push(input)
      harness.missionLock.release(lease)
      return { terminal: input.outcome }
    },
  })
  harness.runtimeOptions.executeRoute = async () => usableDoneFixture(harness, 'finalizer-retry-done')

  const result = await new CodexSupervisorRuntime(harness.runtimeOptions).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(attempts, 2)
  assert.deepEqual(harness.finalizations.map(item => item.outcome), ['DONE'])
  assert.equal(harness.missionLock.releaseCalls, 1)
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

test('mandatory diagnostic owns the startup marker and a rejected optional launch cannot replace it', async t => {
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
  assert.deepEqual(result.scheduler.admission.breaches, [])
  assert.equal(result.scheduler.admission.components.firstChildStartup, 0)
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
  assert.equal(first.launches.filter(item => item.logicalRole === 'diagnostic-probe').length, 1)

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
  assert.deepEqual(harness.launches.map(launch => launch.logicalRole), ['diagnostic-probe'])
  assert.equal(result.scheduler.counters.totalLaunches, 2)
  assert.equal(result.scheduler.rootAccounting.status, 'completed')
})

test('resume without a child cannot bypass a recorded bootstrap admission breach', async t => {
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
  second.runtimeOptions.executeRoute = async () => ({ outcome: 'DONE' })

  const result = await new CodexSupervisorRuntime(second.runtimeOptions).start()
  assert.equal(result.outcome, 'FAILED', JSON.stringify(result))
  assert.equal(result.terminalEnvelope.status, 'ADMISSION_COMPONENT_TIMEOUT')
  assert.equal(result.scheduler.admission.breaches.includes('bootstrap'), true)
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

test('C0 framework candidate survives restart and FAIL returns numbered findings to the same generator before PASS', async () => {
  let durable = null
  const snapshots = []
  let crashRepair = true
  const generatorCalls = []
  const validatorCalls = []
  const binding = frameworkAuthorityBinding()
  const storage = {
    readState: () => durable && structuredClone(durable),
    writeState: state => { durable = structuredClone(state); snapshots.push(structuredClone(state)) },
  }
  const generate = async handoff => {
    generatorCalls.push(structuredClone(handoff))
    if (handoff.attempt === 2 && crashRepair) {
      crashRepair = false
      throw Object.assign(new Error('simulated coordinator crash before repair result'), { code: 'SIMULATED_CRASH' })
    }
    return {
      generatorIdentity: 'C0/framework-generator', generation: handoff.receipt.generation,
      assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
      candidate: { ...generatedFrameworkCandidate(), frameworkId: `generated-framework-${handoff.attempt}` },
    }
  }
  const validate = async handoff => {
    validatorCalls.push(structuredClone(handoff))
    return {
      validatorIdentity: 'C0/independent-framework-validator', generation: handoff.receipt.generation,
      assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
      candidateHash: handoff.candidateHash,
      status: handoff.attempt === 1 ? 'FAIL' : 'PASS',
      findings: handoff.attempt === 1
        ? [{ id: 'FRAMEWORK-FINDING-001', message: 'Add the missing independent-check edge.' }]
        : [],
    }
  }

  const firstProcess = new FrameworkOrchestrationAuthority({ binding, ...storage, generate, validate, maxAttempts: 3 })
  await assert.rejects(
    () => firstProcess.run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'SIMULATED_CRASH',
  )
  assert.equal(durable.status, 'VALIDATION_FAILED')
  assert.deepEqual(durable.validatorReceipt.findings.map(item => item.id), ['FRAMEWORK-FINDING-001'])

  const resumedProcess = new FrameworkOrchestrationAuthority({ binding, ...storage, generate, validate, maxAttempts: 3 })
  const admitted = await resumedProcess.run({ caller: 'deterministic-control-plane' })
  assert.equal(admitted.status, 'ADMITTED')
  assert.equal(admitted.generatorIdentity, 'C0/framework-generator')
  assert.equal(admitted.validatorReceipt.status, 'PASS')
  assert.deepEqual(generatorCalls.map(call => call.attempt), [1, 2, 2])
  assert.deepEqual(generatorCalls.at(-1).repairFindingIds, ['FRAMEWORK-FINDING-001'])
  assert.ok(snapshots.some(state => state.status === 'CANDIDATE_READY'))
  assert.ok(snapshots.some(state => state.status === 'VALIDATION_FAILED'))
  assert.equal(snapshots.at(-1).status, 'ADMITTED')
})

test('C0 framework repair rejects a different author and repeated validation failure is bounded default-fail', async () => {
  let durable = null
  const binding = frameworkAuthorityBinding()
  const storage = {
    readState: () => durable && structuredClone(durable),
    writeState: state => { durable = structuredClone(state) },
  }
  const differentAuthor = new FrameworkOrchestrationAuthority({
    binding, ...storage, maxAttempts: 3,
    generate: async handoff => ({
      generatorIdentity: handoff.attempt === 1 ? 'C0/framework-generator' : 'C0/different-generator',
      generation: handoff.receipt.generation, assignmentId: handoff.receipt.assignmentId,
      findingIds: handoff.receipt.findingIds, candidate: generatedFrameworkCandidate(),
    }),
    validate: async handoff => ({
      validatorIdentity: 'C0/independent-framework-validator', generation: handoff.receipt.generation,
      assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
      candidateHash: handoff.candidateHash, status: 'FAIL',
      findings: [{ id: 'FRAMEWORK-FINDING-001', message: 'Repair required.' }],
    }),
  })
  await assert.rejects(
    () => differentAuthor.run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_REPAIR_AUTHOR_MISMATCH',
  )

  durable = null
  const bounded = new FrameworkOrchestrationAuthority({
    binding, ...storage, maxAttempts: 2,
    generate: async handoff => ({
      generatorIdentity: 'C0/framework-generator', generation: handoff.receipt.generation,
      assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
      candidate: generatedFrameworkCandidate(),
    }),
    validate: async handoff => ({
      validatorIdentity: 'C0/independent-framework-validator', generation: handoff.receipt.generation,
      assignmentId: handoff.receipt.assignmentId, findingIds: handoff.receipt.findingIds,
      candidateHash: handoff.candidateHash, status: 'FAIL',
      findings: [{ id: `FRAMEWORK-FINDING-00${handoff.attempt}`, message: 'Still invalid.' }],
    }),
  })
  await assert.rejects(
    () => bounded.run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_REPAIR_EXHAUSTED',
  )
  assert.equal(durable.status, 'BLOCKED')
  const persistedAttempt = durable.attempt
  const resumedBounded = new FrameworkOrchestrationAuthority({
    binding, ...storage, maxAttempts: 2,
    generate: async () => assert.fail('a persisted BLOCKED state cannot receive another generation attempt'),
    validate: async () => assert.fail('a persisted BLOCKED state cannot receive another validation attempt'),
  })
  await assert.rejects(
    () => resumedBounded.run({ caller: 'deterministic-control-plane' }),
    error => error.code === 'FRAMEWORK_REPAIR_EXHAUSTED',
  )
  assert.equal(durable.attempt, persistedAttempt)
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

test('live worker admission binds physical role, typed ownership, scheduler claims, CAS, and observed mutations', async t => {
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
  harness.runtimeOptions.workerWorkspaceFactory = ({ assignment, workItemId }) =>
    workspaceManager.prepare({ assignment, workItemId })
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

test('one actionable checker FAIL launches a fresh bounded full-set repair and rechecks once', async t => {
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
        assert.equal(request.repairOf, undefined)
        assert.equal(request.executorKey, request.workItemId)
        assert.equal(request.forkTurns, 'none')
        assert.equal(request.fetchedEvidence.rejectedCheckerReceipt.path, receiptPath)
        assert.equal(request.fetchedEvidence.rejectedCheckerReceipts.length, 1)
        assert.deepEqual(Object.keys(request.fetchedEvidence.rejectedCheckerReceipts[0]).sort(),
          ['bytes', 'hash', 'name', 'path', 'resultHash'])
        assert.match(request.assignment, /full cumulative union/u)
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
        assert.match(request.assignment, /complete applicable test matrix/u)
        assert.match(request.assignment, /Enumerate every reproducible defect/u)
        assert.match(request.assignment, /Never paste or dump a full large deliverable, log, or transcript/u)
        assert.match(request.fetchedEvidence.verificationDoctrine.join(' '),
          /unavailable external consumer, tool, library, or portable reopen receipt is a verification limitation/u)
        assert.match(request.fetchedEvidence.verificationDoctrine.join(' '), /strongest available independent method/u)
        if (checkerAttempt === 1) return {
          code: 'FAIL', cause: { event: 'ASSERTION_FAILED', reason: 'exact behavior mismatch', unblockPath: 'repair implementation' },
          payload: { findingIds: ['AP-RUN-026'] },
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
  assert.ok(checkerAttempt >= 2)
  assert.notEqual(checkerCandidates[0], checkerCandidates[1])
  assert.deepEqual(transitions.filter(item => ['IMPLEMENTATION_DEFECT', 'REPAIR_READY'].includes(item.eventId))
    .map(item => [item.eventId, item.nextState]), [
    ['IMPLEMENTATION_DEFECT', 'REPAIRING'],
    ['REPAIR_READY', 'CHECK_WORK'],
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
    code: 'IMPLEMENTATION_REPAIR_UNSUCCESSFUL',
    status: 'IMPLEMENTATION_REPAIR_UNSUCCESSFUL',
    reason: 'the fresh full-set repair worker could not repair the cumulative checker defect set',
    repairWorkItemId: 'work-1-repair-1',
    checkerIds: ['independent-check-1'],
    checkerResultHashes: [result.terminalEnvelope.checkerResultHashes[0]],
  })
  assert.match(result.terminalEnvelope.checkerResultHashes[0], /^[a-f0-9]{64}$/u)
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
          findingIds: ['AP-CHECK-CAPABILITY'],
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
  assert.equal(result.outcome, 'PARTIAL')
  assert.equal(result.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
  assert.equal(result.terminalEnvelope.code, 'CHECK_INCONCLUSIVE')
  assert.equal(result.terminalEnvelope.cause.event, 'DOWNSTREAM_CONSUMER_RECEIPT_MISSING')
  assert.deepEqual(launches, ['work-1', 'independent-check-1', 'independent-check-1-runtime-retry-1'])
  assert.equal(launches.some(id => /^work-1-repair-/u.test(id)), false)
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
})

test('an explicit unsuccessful implementation result returns a bound task terminal instead of an internal controller failure', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-worker-unsuccessful-'))
  const executor = createDefaultRouteExecutor({
    targetPath: target, gitEnvironment: () => process.env, transition: async () => {},
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const failedResult = {
    allAssignedItemsPass: false,
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

test('changed implementation repairs continue until the independent checker passes', async t => {
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
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(repairAttempt, 2)
  assert.deepEqual(repairRequests.map(request => ({
    repairOf: request.repairOf,
    executorKey: request.executorKey,
    forkTurns: request.forkTurns,
    receiptCount: request.fetchedEvidence.rejectedCheckerReceipts.length,
    receiptNames: request.fetchedEvidence.rejectedCheckerReceipts.map(item => item.name),
  })), [
    {
      repairOf: undefined, executorKey: 'work-1-repair-1', forkTurns: 'none', receiptCount: 1,
      receiptNames: ['independent-check-1'],
    },
    {
      repairOf: undefined, executorKey: 'work-1-repair-2', forkTurns: 'none', receiptCount: 2,
      receiptNames: ['independent-check-1', 'independent-check-1-repair-1'],
    },
  ])
  assert.deepEqual(launches.slice(0, 6), [
    'work-1',
    'independent-check-1',
    'work-1-repair-1',
    'independent-check-1-repair-1',
    'work-1-repair-2',
    'independent-check-1-repair-2',
  ])
})

test('REPAIRING resume launches the exact pending worker repair before any fresh checker', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-repair-resume-'))
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
    resultPointer: () => receiptPointer,
    readResult: workItemId => workItemId === 'independent-check-1' ? checkerFailure : null,
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash, buildHash: 'b'.repeat(64),
      oracleHash: crypto.createHash('sha256').update(oracle).digest('hex'),
    }),
  })
  const durableRepairState = {
    resumeState: 'REPAIRING',
    candidateHash: pending.candidateHash,
    completedWorkIds: ['work-1'],
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
        assert.equal(request.repairOf, undefined)
        assert.equal(request.executorKey, 'work-1-repair-1')
        assert.equal(request.forkTurns, 'none')
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

test('REPAIRING crash resume preserves the cumulative checker-receipt prefix for repair two', async t => {
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
  let repairCapsule = null
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
      if (request.workItemId === 'work-1-repair-2') {
        repairCapsule = request.fetchedEvidence.rejectedCheckerReceipts
        fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'repair-two-complete'\n")
        return { allAssignedItemsPass: true }
      }
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
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, ['work-1-repair-2', 'independent-check-1-repair-2'])
  assert.deepEqual(repairCapsule, ledger)
  assert.deepEqual(repairCapsule.slice(0, 1), ledger.slice(0, 1))
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
  const completedRecipe = selectWorkRecipe({
    ...routeDecision.gateSelection, route: 'DIRECT', checks: [],
    runtimeSignals: routeDecision.runtimeSignals || {},
    overlaySteps: routeDecision.overlaySteps || routeDecision.overlayExecution || [],
  })
  const completedChecks = [...new Set([
    ...completedRecipe.checks, ...completedRecipe.riskChecks, ...routeDecision.plannedChecks,
  ])]
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

test('controller-invalid repaired PASS retries, then routes a real defect into repair two', async t => {
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
      if (request.workItemId === 'work-1-repair-2') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repair-two'\n")
        return { allAssignedItemsPass: true }
      }
      assert.equal(request.workItemId, 'independent-check-1-repair-2')
      return { code: 'PASS', payload: {
        evidenceIds: [`evidence:${request.workItemId}`],
        referenceMethod: checkerReferenceMethod('requirements-review', request.workItemId),
        testOutcomes: checkerTestOutcomes(request),
      } }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash,
      completedWorkIds: ['work-1', 'work-1-repair-1'], completedCheckIds: [completedId],
      acceptedResultIds: [], nextReadyWorkIds: [], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    `${completedId}-runtime-retry-1`, 'work-1-repair-2', 'independent-check-1-repair-2',
  ])
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
    const completedRecipe = selectWorkRecipe({
      ...routeDecision.gateSelection, route: 'DIRECT', checks: [],
      runtimeSignals: routeDecision.runtimeSignals || {},
      overlaySteps: routeDecision.overlaySteps || routeDecision.overlayExecution || [],
    })
    const completedChecks = [...new Set([
      ...completedRecipe.checks, ...completedRecipe.riskChecks, ...routeDecision.plannedChecks,
    ])]
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

test('repaired checker retry PASS preserves the seat, then a later defect starts the next repair generation', async t => {
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
  const completedRecipe = selectWorkRecipe({
    ...routeDecision.gateSelection, route: 'DIRECT', checks: [],
    runtimeSignals: routeDecision.runtimeSignals || {},
    overlaySteps: routeDecision.overlaySteps || routeDecision.overlayExecution || [],
  })
  const completedChecks = [...new Set([
    ...completedRecipe.checks, ...completedRecipe.riskChecks, ...routeDecision.plannedChecks,
  ])]
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
      if (request.workItemId === 'work-1-repair-2') {
        fs.writeFileSync(path.join(targetPath, 'src', 'example.js'), "module.exports = 'repair-two'\n")
        return { allAssignedItemsPass: true }
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
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'independent-check-2-repair-1', 'work-1-repair-2',
    'independent-check-1-repair-2', 'independent-check-2-repair-2',
  ])
  assert.deepEqual(transitions.filter(item => item.eventId === 'CHECK_BECAME_CONCLUSIVE')[0]
    .details.nextReadyWorkIds, ['independent-check-2-repair-1'])
})

test('an equivalent post-repair checker failure stops after the single bounded repair', async t => {
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
          payload: { findingIds: ['AP-RUN-026'] },
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

test('a no-op checker repair fails directly without stale recheck or a second repair', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-checker-repair-no-progress-'))
  const receiptPath = path.join(target, 'checker-fail-receipt.json')
  fs.writeFileSync(receiptPath, '{}\n')
  let checkerLaunches = 0
  let repairLaunches = 0
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
    route: 'DIRECT', decision: decision('DIRECT'),
    launch: async request => {
      if (request.logicalRole === 'worker') {
        if (/^work-1-repair-\d+$/u.test(request.workItemId)) repairLaunches += 1
        else fs.writeFileSync(path.join(target, 'src', 'example.js'), "module.exports = 'rejected'\n")
        return { allAssignedItemsPass: true }
      }
      checkerLaunches += 1
      return {
        code: 'FAIL',
        cause: { event: 'ASSERTION_FAILED', reason: 'bound behavior mismatch', unblockPath: 'repair implementation' },
        payload: { findingIds: ['AP-RUN-026'] },
      }
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(result.outcome, 'FAILED')
  assert.equal(result.terminalEnvelope.status, 'REPAIR_NO_PROGRESS')
  assert.equal(repairLaunches, 1)
  assert.equal(checkerLaunches, 1)
  assert.deepEqual(transitions.filter(([event]) => ['IMPLEMENTATION_DEFECT', 'REPAIR_READY'].includes(event)), [
    ['IMPLEMENTATION_DEFECT', 'REPAIRING'],
  ])
})

test('persistent inconclusive checks remain verification limitations and never launch implementation repair', async t => {
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
        return {
          code,
          cause: { event: code, reason: 'the independent check did not complete conclusively', unblockPath: 'repair implementation' },
          payload: {},
        }
      },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
    })
    assert.equal(result.outcome, 'PARTIAL')
    assert.equal(result.terminalEnvelope.status, 'CHECK_REMAINS_INCONCLUSIVE')
    assert.equal(repairLaunches, 0)
    assert.equal(checkerLaunches, 2)
    assert.deepEqual(workItemIds.filter(id => /^work-/u.test(id)), ['work-1'])
    assert.deepEqual(checkerTransitions.filter(([event]) => [
      'CHECK_BECAME_CONCLUSIVE', 'IMPLEMENTATION_DEFECT', 'REPAIR_READY',
    ].includes(event)), [])
    assert.deepEqual(checkerTransitions.filter(([event]) => [
      'CHECK_INCONCLUSIVE', 'CHECK_REMAINS_INCONCLUSIVE',
    ].includes(event)), [
      ['CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE'],
      ['CHECK_REMAINS_INCONCLUSIVE', 'RELEASING_LOCK'],
    ])
  }
})

test('each independent checker gets one same-version inconclusive retry with canonical state transitions', async t => {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-per-checker-retry-'))
  const transitions = []
  const checkerLaunches = []
  const attempts = new Map()
  const twoCheckerDecision = decision('DIRECT', {
    independentChecks: {
      checker_count: 2,
      responsibilities: ['Independently review behavior.', 'Independently test boundaries.'],
      separate_second_checker_reason: 'Review and black-box boundary testing use distinct methods.',
    },
  })
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
  assert.deepEqual(checkerLaunches, [
    'independent-check-1', 'independent-check-1-runtime-retry-1',
    'independent-check-2', 'independent-check-2-runtime-retry-1',
  ])
  assert.deepEqual(transitions.filter(([event]) => [
    'CHECK_INCONCLUSIVE', 'CHECK_BECAME_CONCLUSIVE',
  ].includes(event)).map(([event, state, details]) => [
    event, state, details && details.checkerId, details && details.nextReadyWorkIds,
  ]), [
    ['CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE', 'independent-check-1', ['independent-check-1-runtime-retry-1']],
    ['CHECK_BECAME_CONCLUSIVE', 'CHECK_WORK', 'independent-check-1-runtime-retry-1', ['independent-check-2']],
    ['CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE', 'independent-check-2', ['independent-check-2-runtime-retry-1']],
    ['CHECK_BECAME_CONCLUSIVE', 'CHECK_WORK', 'independent-check-2-runtime-retry-1', []],
  ])
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
      currentVersionHash: CANDIDATE_A, candidateHash: CANDIDATE_A,
      contextId: 'checker-context', usage: ZERO_USAGE, evidenceHashes: [],
    }
  }
  harness.runtimeOptions.executeRoute = async ({ launch }) => {
    const oracleHash = '9'.repeat(64)
    await launch({
      workItemId: 'checker-resources', logicalRole: 'independent-reviewer', parent: 'run-owner',
      purpose: 'verification', assignment: `Check AP-LAYER-025 and AP-DESIGN-037 using ${path.join(target, 'evidence', 'baseline.txt')}.`,
      findingIds: ['AP-LAYER-025', 'AP-DESIGN-037'], candidateHash: CANDIDATE_A,
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
  const branch = spawnSync('git', ['-C', ROOT, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim()
  const boundary = safeEnvironmentFactory()(ROOT, process.env, {
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
        usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 3, reasoning_tokens: 4 },
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
    dispatch: { brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: { GIT_ALLOW_PROTOCOL: 'file' },
    sessionId: 'run:DIRECT:launch-1',
    onSessionIdentified(sessionId) {
      assert.equal(sessionId, '11111111-1111-4111-8111-111111111111')
    },
    onUsageDelta(delta, cumulative) {
      assert.deepEqual(delta, { noncachedInput: 1, cachedInput: 2, output: 3, reasoning: 4 })
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
  assert.match(calls[0].stdin, /^\$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\n/)
  assert.match(calls[0].stdin, /AUTOPROMPT_EXTERNAL_CHILD_V1\nrole=worker\n/)
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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
          entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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
      entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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

test('AP-CODEX-V2-036 concrete runtime repairs a checker FAIL in a fresh Codex worker, freezes C2, and rechecks', async t => {
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
    '--repo', target, '--expected-branch', 'main', '--repair',
    '--enforcement-proof', enforcementProofPath, '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.ok([0, 3].includes(repaired.status), repaired.stderr || repaired.stdout)
  const safety = require(path.join(ROOT, 'scripts', 'local-only-safety.cjs'))
  const preflightEnvironment = safety.createSafeChildGitEnvironment(target, process.env, {
    configIsolationPath, ghConfigDir,
  })
  const preflightSafety = safety.inspect(safety.discoverRepository(target), 'main', preflightEnvironment, {
    enforcementProof,
  })
  assert.equal(preflightSafety.mechanicallyEnforced, true, JSON.stringify(preflightSafety))
  const recommendationValue = recommendation('DIRECT')
  const decisionValue = decision('DIRECT')
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
    "  traceFs.appendFileSync(tracePath, JSON.stringify({role,roleAttempt,assignmentId:assignment&&assignment.assignmentId,forkTurns:context&&context.fork_turns,argv:process.argv.slice(2),cwd:process.cwd(),cacheEnvironment:{TMPDIR:process.env.TMPDIR,TMP:process.env.TMP,TEMP:process.env.TEMP,XDG_CACHE_HOME:process.env.XDG_CACHE_HOME,PYTHONPYCACHEPREFIX:process.env.PYTHONPYCACHEPREFIX,PYTHONDONTWRITEBYTECODE:process.env.PYTHONDONTWRITEBYTECODE,AUTOPROMPT_WORKER_CACHE_ROOT:process.env.AUTOPROMPT_WORKER_CACHE_ROOT}})+'\\n')",
    `  const recommendation = ${JSON.stringify(recommendationValue)}`,
    `  const decision = ${JSON.stringify(decisionValue)}`,
    "  const now = new Date().toISOString()",
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
    "    payloadSchemaId:'autoprompt.check.fake.v2', payload:checkerAttempt === 1 ? {findingIds:['AP-RUN-026']} : {evidenceIds:[`fake-cli-underlying-evidence:${assignment.assignmentId}`],referenceMethod:{methodClass:/tester/.test(role)?'black-box-boundary':'requirements-review',source:`${role} independent source`,procedure:`${role} independently derives and executes expected observations`,expectedOutputDerivedFromSubjectCode:false,subjectLogicReimplemented:false,positiveInvariants:[`${role} accepted behavior`],negativeInvariants:[`${role} rejected behavior`],boundaryInvariants:[`${role} edge behavior`]},testOutcomes:assignment.checks.map(command=>({command,status:'PASS',fingerprint:require('node:crypto').createHash('sha256').update(`fake-post-green:${command}`).digest('hex')}))}, recordedAt:now",
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
    "  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({canonicalJson:JSON.stringify(output)})}})+'\\n')",
    "  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_tokens:0}})+'\\n')",
    "  setInterval(() => {}, 1000)",
    "})",
    '',
  ].join('\n'))
  const metadataBytes = fs.readFileSync(record.paths.metadataPath)
  const requestArgv = ['implement', 'the', 'bounded', 'widget']
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
      executableArgs: [fakeCliPath], expectedBranch: 'main', providerMaximum: 2,
      tokenLimit: 1000, sessionLimit: 16, launchLimit: 16,
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
    5 + result.terminalEnvelope.checkCount)
  assert.equal(result.scheduler.rootAccounting.status, 'completed')
  assert.deepEqual(livePersistentPidTrees(pidTreeControlRoot), [])
  assert.equal(fs.existsSync(record.paths.accounting.logPath), true)
  assert.equal(fs.existsSync(record.paths.accounting.snapshotPath), true)
  assert.equal(fs.existsSync(record.paths.terminalPath), true)
  assert.equal(fs.existsSync(record.paths.processRegistry), true)
  const persistedDecision = JSON.parse(fs.readFileSync(record.resolve('route/decision.json'), 'utf8'))
  assert.equal(persistedDecision.route, 'DIRECT')
  const terminal = JSON.parse(fs.readFileSync(record.paths.terminalPath, 'utf8'))
  assert.equal(terminal.outcome, 'DONE')
  assert.equal(terminal.terminalEnvelope.code, 'DONE')
  const traced = fs.readFileSync(roleTracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const tracedRoles = traced.map(item => item.role)
  assert.equal(tracedRoles.filter(role => role === 'route-analyst').length, 1)
  assert.equal(tracedRoles.filter(role => role === 'run-owner').length, 1)
  assert.equal(tracedRoles.filter(role => role === 'worker').length, 2)
  assert.equal(tracedRoles.filter(role => /checker|reviewer|tester/.test(role)).length, 3)
  const repairWorker = traced.find(item => item.role === 'worker' && item.roleAttempt === 2)
  assert.equal(repairWorker.assignmentId, 'work-1-repair-1')
  assert.equal(repairWorker.forkTurns, 'none')
  assert.equal(repairWorker.argv.includes('resume'), false)
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
    "  if (role === 'worker') require('node:fs').writeFileSync(require('node:path').join(process.cwd(),'src','example.js'), \"module.exports = 'resumed'\\n\")",
    "  let output",
    "  if (role === 'route-analyst') output = recommendation",
    "  else if (role === 'run-owner') output = decision",
    "  else if (/checker|reviewer|tester/.test(role)) output = {",
    "    schemaVersion:'2.0.0', code:'PASS', description:'The checked result satisfies every requirement assigned to this check.',",
    "    stateClass:'terminal', runId:assignment.runId, requestEnvelopeHash:assignment.requestEnvelopeHash,",
    "    currentVersionHash:context.candidateHash, completedResults:[], nextReadyWork:[],",
    "    cause:{event:'CHECK_COMPLETE',reason:'Fake checker accepted the resumed candidate.',unblockPath:null},",
    "    payloadSchemaId:'autoprompt.check.fake.v2', payload:{evidenceIds:[`fake-cli-underlying-evidence:${assignment.assignmentId}`],referenceMethod:{methodClass:/tester/.test(role)?'black-box-boundary':'requirements-review',source:`${role} independent source`,procedure:`${role} independently derives and executes expected observations`,expectedOutputDerivedFromSubjectCode:false,subjectLogicReimplemented:false,positiveInvariants:[`${role} accepted behavior`],negativeInvariants:[`${role} rejected behavior`],boundaryInvariants:[`${role} edge behavior`]},testOutcomes:assignment.checks.map(command=>({command,status:'PASS',fingerprint:require('node:crypto').createHash('sha256').update(`fake-post-green:${command}`).digest('hex')}))}, recordedAt:now",
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
    "  context: {executableArgs:[input.fakeCliPath],expectedBranch:'main',providerMaximum:2,tokenLimit:1000,sessionLimit:16,launchLimit:16,processAdapter:createPersistentPidTreeAdapter({controlRoot:input.pidTreeControlRoot})},",
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
      processAdapter: createPersistentPidTreeAdapter({ controlRoot: pidTreeControlRoot }),
    },
  })
  const result = await new CodexSupervisorRuntime(options).start()
  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
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

test('runtime capability receipts reject forged, stale, cross-run, and downgraded launches', () => {
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
  assert.throws(() => authority.verify(receipt, expected), error => error.code === 'RUNTIME_CAPABILITY_INVALID')
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
  assert.equal(harness.launches.every(launch => launch.logicalRole === 'diagnostic-probe'), true)
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
      'model = "test-model"\nmodel_reasoning_effort = "medium"\n')
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
    providerTrust: { runtimeIdentityHash: CANDIDATE_A, sha256: CANDIDATE_A },
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

function configureRoadmapCompositionHarness(t, checkerCodes, options = {}) {
  const target = createTempGitTarget(tempDirectory(t, 'autoprompt-roadmap-composition-target-'))
  const hardening = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target, '--expected-branch', 'main', '--repair', '--json',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal([0, 3].includes(hardening.status), true, hardening.stderr || hardening.stdout)

  const harness = makeHarness(t, {
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
  harness.runtimeOptions.workerWorkspaceFactory = ({ assignment, workItemId }) =>
    workspaceManager.prepare({ assignment, workItemId })
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
  harness.runtimeOptions.launcher = async launch => {
    harness.launches.push(launch)
    if (launch.logicalRole === 'diagnostic-probe') return representativeProbeResult(launch)
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
    } else {
      result = roadmapCompositionRoleResult(launch, ['Retain the accepted roadmap coordination context.'])
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
  harness.runtimeOptions.executeRoute = async input => {
    try {
      return await executor({
        ...input,
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
          const result = await input.launch(request)
          routeReturns.set(request.workItemId, result)
          return result
        },
      })
    } catch (error) {
      if (error.code !== 'COMPOSITION_PLAN_ACCEPTED') throw error
      fs.writeFileSync(acceptedPlan, `${planHashes.at(-1)}\n`)
      return {
        outcome: 'DONE', deliverables: [acceptedPlan],
        checkHashes: [crypto.createHash('sha256').update(fs.readFileSync(acceptedPlan)).digest('hex')],
      }
    }
  }
  return {
    harness, planHashes, results, routeRequests, routeReturns, recordRoot, workerPrivateRoot,
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

test('ROADMAP runtime composes real scheduler repair admission from durable plan-check evidence', async t => {
  const fixture = configureRoadmapCompositionHarness(t, ['FAIL', 'PASS'])
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  assert.equal(fixture.planHashes.length, 2)
  assert.notEqual(fixture.planHashes[0], fixture.planHashes[1])
  const planning = fixture.harness.launches.filter(launch =>
    ['roadmap-author', 'roadmap-author-plan-repair', 'roadmap-plan-check', 'roadmap-plan-recheck']
      .includes(launch.workItemId))
  assert.deepEqual(planning.map(launch => [launch.workItemId, launch.schedulerAttempt]), [
    ['roadmap-author', 1],
    ['roadmap-plan-check', 1],
    ['roadmap-author-plan-repair', 2],
    ['roadmap-plan-recheck', 2],
  ])
  const author = planning[0]
  const repair = planning[2]
  assert.equal(repair.continuationId, author.contextId || 'context:roadmap-author')
  const repairRequest = fixture.routeRequests.get('roadmap-author-plan-repair')
  assert.deepEqual(repairRequest.evidenceHashes, [repairRequest.evidencePointers.at(-1).hash])
  assert.equal(result.schedulerState.progressFingerprints['roadmap-author'],
    roadmapCompositionProgressFingerprint(null, repairRequest.evidenceHashes))
  const recheckRequest = fixture.routeRequests.get('roadmap-plan-recheck')
  assert.equal(result.schedulerState.progressFingerprints['roadmap-plan-check'],
    roadmapCompositionProgressFingerprint(recheckRequest.candidateHash, recheckRequest.evidenceHashes))
  assert.equal(result.scheduler.counters.retriesStarted, 2)
  assert.equal(result.scheduler.counters.rejectedByCode.RETRY_PROGRESS_EVIDENCE_REQUIRED || 0, 0)
  assert.equal(result.scheduler.counters.rejectedByCode.RETRY_REASSESSMENT_REQUIRED || 0, 0)
  assert.doesNotMatch(JSON.stringify(result.terminalEnvelope || {}), /RETRY_(?:PROGRESS|REASSESSMENT)/u)
  const statuses = workerWorkspaceJournalStatuses(fixture.workerPrivateRoot)
  assert.equal(statuses.length, 2)
  assert.equal(statuses.every(status => status === 'FINALIZED'), true, JSON.stringify(statuses))
})

test('ROADMAP inconclusive plan check takes a fresh evidence-bound physical retry without proof replay', async t => {
  const fixture = configureRoadmapCompositionHarness(t, ['CHECK_INCONCLUSIVE', 'PASS'])
  const result = await new CodexSupervisorRuntime(fixture.harness.runtimeOptions).start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  const checks = fixture.harness.launches.filter(launch => launch.logicalRole === 'plan-checker')
  assert.deepEqual(checks.map(launch => [launch.workItemId, launch.schedulerAttempt]), [
    ['roadmap-plan-check', 1],
    ['roadmap-plan-check-runtime-retry', 2],
  ])
  assert.notEqual(checks[0].schedulerLeaseId, checks[1].schedulerLeaseId)
  assert.notEqual(checks[0].workingDirectory, checks[1].workingDirectory)
  assert.equal(checks[1].continuationId, null)
  const retryRequest = fixture.routeRequests.get('roadmap-plan-check-runtime-retry')
  assert.deepEqual(retryRequest.evidenceHashes, [
    crypto.createHash('sha256')
      .update(JSON.stringify(fixture.routeReturns.get('roadmap-plan-check'))).digest('hex'),
  ])
  assert.equal(retryRequest.forkTurns, 1)
  assert.deepEqual(retryRequest.recoveryContext, {
    type: 'bounded-recovery', code: 'PLAN_CHECK_RUNTIME_RETRY',
  })
  assert.equal(retryRequest.executorKey, 'roadmap-plan-check')
  assert.equal(fixture.routeReturns.get('roadmap-plan-check-runtime-retry').reusedProof, undefined)
  const proofRoot = path.join(fixture.recordRoot, 'checks', 'review-results')
  const proofs = fs.readdirSync(proofRoot).sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(proofRoot, name), 'utf8')))
  assert.equal(proofs.length, 2)
  const inconclusiveProof = proofs.find(proof => proof.result.code === 'CHECK_INCONCLUSIVE')
  const passProof = proofs.find(proof => proof.result.code === 'PASS')
  assert.ok(inconclusiveProof)
  assert.equal(inconclusiveProof.cacheEligible, false)
  assert.equal(inconclusiveProof.harnessRecord, null)
  assert.equal(inconclusiveProof.proofRecord, null)
  assert.ok(passProof)
  assert.equal(passProof.cacheEligible, true)
  assert.ok(passProof.harnessRecord)
  assert.ok(passProof.proofRecord)
  assert.equal(result.schedulerState.progressFingerprints['roadmap-plan-check'],
    roadmapCompositionProgressFingerprint(retryRequest.candidateHash, retryRequest.evidenceHashes))
  assert.equal(result.scheduler.counters.retriesStarted, 1)
  assert.equal(result.scheduler.counters.proofCacheHits, 0)
  assert.equal(result.scheduler.counters.rejectedByCode.RETRY_PROGRESS_EVIDENCE_REQUIRED || 0, 0)
  assert.equal(result.scheduler.counters.rejectedByCode.RETRY_REASSESSMENT_REQUIRED || 0, 0)
})

test('ROADMAP retained L1 steering redispatch uses the same executor with exact rebound evidence', async t => {
  const fixture = configureRoadmapCompositionHarness(t, ['PASS'], { steerAtCoordinator: true })
  const runtime = new CodexSupervisorRuntime(fixture.harness.runtimeOptions)
  fixture.setRuntime(runtime)
  const result = await runtime.start()

  assert.equal(result.outcome, 'DONE', JSON.stringify(result))
  const coordinators = fixture.harness.launches.filter(launch =>
    launch.logicalRole === 'mission-coordinator')
  assert.equal(coordinators.length, 2)
  assert.deepEqual(coordinators.map(launch => launch.schedulerAttempt), [1, 2])
  assert.notEqual(coordinators[0].schedulerLeaseId, coordinators[1].schedulerLeaseId)
  assert.equal(coordinators[1].continuationId, 'context:mission-coordination')
  assert.equal(coordinators[1].canonicalAssignment.requestEnvelopeHash,
    fixture.steeringResult().requestPointer.hash)
  assert.deepEqual(fixture.steeringResult().redispatchedRetainedL1Ids,
    [coordinators[1].workItemId])
  assert.equal(result.schedulerState.progressFingerprints['mission-coordination'],
    roadmapCompositionProgressFingerprint(null, [
      fixture.steeringResult().entry.entryHash,
      fixture.steeringResult().requestPointer.hash,
    ]))
  assert.equal(result.scheduler.counters.retriesStarted, 1)
  assert.equal(result.scheduler.counters.rejectedByCode.RETRY_PROGRESS_EVIDENCE_REQUIRED || 0, 0)
  assert.equal(result.scheduler.counters.rejectedByCode.RETRY_REASSESSMENT_REQUIRED || 0, 0)
})
