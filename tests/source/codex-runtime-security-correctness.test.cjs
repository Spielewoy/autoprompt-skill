'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  CodexSupervisorRuntime,
  createDefaultRouteExecutor,
  createMinimalTestEnvironment,
  executeExistingTestBaseline,
  resolveTrustedTestDeclarations,
} = require('../../agents/codex/workflow/phase-budget.js')
const {
  createRouteDecision,
  remainingL0DecisionBudgetMs,
} = require('../../agents/codex/workflow/route-decision.js')
const router = require('../../agents/codex/workflow/router.js')

const H = 'a'.repeat(64)

function git(cwd, argv) {
  const result = childProcess.spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function cleanRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-read-only-result-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(root, 'subject.txt'), 'bounded evidence\n')
  git(root, ['add', 'subject.txt'])
  git(root, ['commit', '-m', 'fixture'])
  return root
}

function readOnlyDecision(requestedEffect = 'inspect') {
  const facts = router.normalizeFacts({
    schemaVersion: '2.0.0',
    requestedEffect,
    successCriteria: 'ready',
    dependency: {
      shape: 'bounded', dependentWorkGroupCount: 0,
      integrationOwnerRequired: false, separateDependentBodies: 0,
    },
    uncertainty: 'none',
    reversibility: 'fully-reversible',
    mutableResources: [],
    sideEffects: [],
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
      checkQuality: 'observable', availableCheckKinds: ['receipt'],
      baselineStatus: 'recorded', hiddenExternalCheck: false,
    },
    deadlineBudget: {
      remainingSeconds: 600, admissionSeconds: 240, executionReserveSeconds: 180,
      verificationReserveSeconds: 120, recoveryAndFinalizationReserveSeconds: 60,
    },
    operatorMinimumRoute: null,
    transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true },
    candidateFreeze: { required: false, available: true, environmentCanBeBound: true },
    missingUserInput: [], architectureImpact: 'local', fitsLightPlan: true,
    approachNeedsShortPlanning: false, shortOrderUnclear: false,
  })
  const classified = router.classifyRoute(facts)
  return createRouteDecision({
    route: 'DIRECT', routeFacts: facts,
    requestedResult: 'Inspect subject.txt and report the finding.',
    successChecklist: ['The finding is evidence-backed.'],
    checks: ['Review the structured finding and its evidence receipt.'],
    likelyAreas: ['subject.txt'], risks: [], missingInformation: [],
    workers: {
      count: 1,
      responsibilities: ['Inspect the bounded target and return a structured result.'],
      nonOverlapReason: 'One read-only worker owns the bounded inspection.',
    },
    mutableResourceOwnership: [],
    chosenRouteReason: 'The read-only request is bounded and has a known check.',
    rejectedRouteReasons: {
      LIGHT: 'No reversible technical decision requires planning.',
      ROADMAP: 'No dependent work groups require coordination.',
    },
    analystComparison: {
      recommendedRoute: 'DIRECT', reason: 'The analyst and L0 classifier agree.',
      analystFactsFingerprint: classified.facts_fingerprint,
      analystClassifierFingerprint: classified.classifier_fingerprint,
    },
    routeChangeTrigger: {
      event: 'NEW_ROUTE_FACT', factRequired: 'A recorded fact changes route precedence.',
    },
    requestEnvelopeHash: H, recommendationHash: 'b'.repeat(64),
    gateSelection: requestedEffect === 'inspect'
      ? {
          baseWorkType: 'inspect-report', resultFormat: 'read-only-findings',
          artifactOverlays: ['read-only-result'], acceptanceOverlays: ['receipts'],
          riskOverlays: [], riskEvidence: {},
        }
      : {
          baseWorkType: 'research-decide', resultFormat: 'decision-record',
          artifactOverlays: ['read-only-result'], acceptanceOverlays: ['receipts'],
          riskOverlays: [], riskEvidence: {},
        },
  })
}

function structuredWorkerResult() {
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: 'result:work-1',
    allAssignedItemsPass: true, filesChanged: [], commands: [],
    successItems: [{ id: 'finding', status: 'pass', evidenceIds: ['subject.txt:1'] }],
    behaviorChanged: ['subject.txt contains the bounded evidence marker.'],
    remainingConcerns: [],
  }
}

test('read-only inspect/research routes complete DONE from a validated structured final response without a workspace diff', async t => {
  for (const requestedEffect of ['inspect', 'research']) {
    const targetPath = cleanRepository(t)
    const decision = readOnlyDecision(requestedEffect)
    const executor = createDefaultRouteExecutor({
      targetPath,
      gitEnvironment: () => process.env,
      transition: async () => {},
      harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    })
    const outcome = await executor({
      route: 'DIRECT', decision,
      launch: async request => request.workItemId === 'work-1'
        ? structuredWorkerResult()
        : {
            schemaVersion: '2.0.0', code: 'PASS',
            payload: { evidenceIds: ['subject.txt:1'] },
          },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async () => ({}),
      resumeState: null,
    })
    assert.equal(outcome.outcome, 'DONE')
    assert.deepEqual(outcome.deliverables, [])
    assert.equal(outcome.finalResponse.resultFormat, decision.gateSelection.resultFormat)
    assert.equal(outcome.finalResponse.results[0].successItems[0].evidenceIds[0], 'subject.txt:1')
    const runtime = Object.create(CodexSupervisorRuntime.prototype)
    Object.assign(runtime, {
      finished: false,
      route: 'DIRECT',
      scheduler: null,
      processOwner: { async cancelAll() {}, async assertDrained() {} },
      budget: { snapshot: () => ({}) },
      finalizer: { async finalize(input) { return { outcome: input.outcome } } },
      _enforceBudgetPhase: () => ({ withinBudget: true }),
    })
    const terminal = await runtime._finish('DONE', outcome)
    assert.equal(terminal.outcome, 'DONE')
    assert.equal(terminal.finalResponse.responseHash, outcome.finalResponse.responseHash)
  }
})

test('L0 correction inherits the remaining monotonic four-minute ceiling', () => {
  assert.equal(remainingL0DecisionBudgetMs({ startedAtMs: 10_000, nowMs: 249_950 }), 50)
  assert.equal(remainingL0DecisionBudgetMs({ startedAtMs: 10_000, nowMs: 250_000 }), 0)
  assert.throws(
    () => remainingL0DecisionBudgetMs({ startedAtMs: 10_001, nowMs: 10_000 }),
    error => error.code === 'ROUTE_DECISION_CLOCK_INVALID',
  )
})

test('model-like shell, credential, network, and path-escape test declarations are rejected before execution', async t => {
  const root = cleanRepository(t)
  const attempts = [
    { id: 'shell', command: `node --test ok.test.cjs & echo injected` },
    { id: 'redirect', executable: process.execPath, argv: ['--test', 'ok.test.cjs', '>', 'stolen.txt'] },
    { id: 'credential', executable: process.execPath, argv: ['--test', '../.codex/auth.json'] },
    { id: 'network', executable: process.execPath, argv: ['--test', 'https://example.invalid/test.cjs'] },
    { id: 'eval', executable: process.execPath, argv: ['-e', "require('node:fs').readFileSync(process.env.AUTOPROMPT_ACTIVATION_RECORD)"] },
  ]
  let executions = 0
  for (const declaration of attempts) {
    assert.throws(
      () => resolveTrustedTestDeclarations({ controlPlane: [declaration] }, { repository: root }),
      error => error.code === 'TRUSTED_TEST_DECLARATION_INVALID',
    )
  }
  assert.equal(executions, 0)
})

test('trusted executable+argv tests run shell-free with an owned cwd and minimal secret-free environment', async t => {
  const root = cleanRepository(t)
  const testPath = path.join(root, 'safe.test.cjs')
  fs.writeFileSync(testPath, [
    "'use strict'",
    "const test = require('node:test')",
    "const assert = require('node:assert/strict')",
    "test('safe', () => assert.equal(2 + 2, 4))",
    '',
  ].join('\n'))
  const resolved = resolveTrustedTestDeclarations({
    repository: [{ id: 'safe-node-test', executable: process.execPath, argv: ['--test', 'safe.test.cjs'] }],
  }, { repository: root })
  const isolatedHome = path.join(root, '.isolated-test-home')
  const environment = createMinimalTestEnvironment({
    ...process.env,
    OPENAI_API_KEY: 'must-not-leak',
    AUTOPROMPT_ACTIVATION_RECORD: path.join(root, 'activation', 'auth.json'),
  }, { isolationRoot: isolatedHome })
  let received = null
  const baseline = await executeExistingTestBaseline(resolved, {
    environment,
    runner: async launch => {
      received = launch
      const executed = childProcess.spawnSync(launch.executable, launch.argv, {
        cwd: launch.cwd, env: launch.environment, shell: launch.shell,
        encoding: 'utf8', windowsHide: true,
      })
      return { ...executed, processOwned: true, exactArgv: true, drained: true }
    },
  })
  assert.equal(baseline[0].status, 'PASS')
  assert.equal(received.shell, false)
  assert.equal(received.cwd, root)
  assert.deepEqual(received.argv, ['--test', 'safe.test.cjs'])
  assert.equal(received.environment.OPENAI_API_KEY, undefined)
  assert.equal(received.environment.AUTOPROMPT_ACTIVATION_RECORD, undefined)
  assert.equal(received.environment.CODEX_HOME.startsWith(isolatedHome), true)
})
