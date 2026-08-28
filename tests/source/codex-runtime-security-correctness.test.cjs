'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
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

function readOnlyDecision(requestedEffect = 'inspect', workerCount = 1, checkerCount = 1) {
  const mutatingClassification = requestedEffect === 'mutate'
  const mutableResources = mutatingClassification
    ? Array.from({ length: workerCount }, (_, index) => ({
        kind: 'file', identity: index === 0 ? 'subject.txt' : `future-${index + 1}.txt`,
        shared: false, ownershipMode: 'single-owner',
      }))
    : []
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
    mutableResources,
    sideEffects: mutatingClassification ? ['deliverable-write'] : [],
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
      level: checkerCount === 2 ? 'elevated' : 'ordinary',
      minimumCheckerCount: checkerCount,
      namedDistinctResponsibilities: checkerCount === 2 ? [
        '[command:behavior-test] Execute the focused behavioral check.',
        '[oracle:artifact] Independently inspect the frozen artifact.',
      ] : [],
    },
    checkAndBaseline: {
      checkQuality: 'observable',
      availableCheckKinds: checkerCount === 2
        ? ['command:behavior-test', 'oracle:artifact']
        : [mutatingClassification ? 'behavior-test' : 'receipt'],
      baselineStatus: 'recorded', hiddenExternalCheck: false,
    },
    deadlineBudget: {
      remainingSeconds: 600, admissionSeconds: 240, executionReserveSeconds: 180,
      verificationReserveSeconds: 120, recoveryAndFinalizationReserveSeconds: 60,
    },
    operatorMinimumRoute: null,
    transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true },
    candidateFreeze: {
      required: mutatingClassification, available: true, environmentCanBeBound: true,
    },
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
      count: workerCount,
      responsibilities: Array.from({ length: workerCount }, (_, index) =>
        `Inspect bounded target ${index + 1} and return a structured result.`),
      nonOverlapReason: workerCount === 1
        ? 'One worker owns the bounded target.'
        : 'Each worker owns one disjoint bounded target.',
    },
    mutableResourceOwnership: mutableResources.map((resource, index) => ({
      ...resource, owner: `worker-${index + 1}`,
    })),
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
      : requestedEffect === 'research' ? {
          baseWorkType: 'research-decide', resultFormat: 'decision-record',
          artifactOverlays: ['read-only-result'], acceptanceOverlays: ['receipts'],
          riskOverlays: [], riskEvidence: {},
        }
      : {
          baseWorkType: 'mechanical-change', resultFormat: 'changed-files',
          artifactOverlays: ['executable-code'], acceptanceOverlays: ['exact-diff'],
          riskOverlays: [], riskEvidence: {},
        },
  })
}

function structuredWorkerResult(workItemId = 'work-1') {
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: `result:${workItemId}`,
    allAssignedItemsPass: true, filesChanged: [], commands: [],
    successItems: [{ id: 'finding', status: 'pass', evidenceIds: ['subject.txt:1'] }],
    behaviorChanged: ['subject.txt contains the bounded evidence marker.'],
    remainingConcerns: [],
  }
}

function structuredResponsePersistence(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-structured-response-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return response => {
    const target = path.join(root, 'candidate.json')
    const bytes = Buffer.from(`${JSON.stringify(response, null, 2)}\n`)
    if (fs.existsSync(target)) assert.deepEqual(fs.readFileSync(target), bytes)
    else fs.writeFileSync(target, bytes)
    return {
      name: 'structured-final-response',
      path: target,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    }
  }
}

function passingCheckerResult(request) {
  const checkerSeat = /^independent-check-(\d+)/u.exec(request.workItemId || '')
  const secondCheckerSeat = checkerSeat && Number(checkerSeat[1]) === 2
  const methodClass = secondCheckerSeat ? 'black-box-boundary' : 'requirements-review'
  const methodLabel = secondCheckerSeat
    ? 'frozen-artifact boundary oracle'
    : 'independently derived request obligations'
  return {
    schemaVersion: '2.0.0', code: 'PASS',
    payload: {
      evidenceIds: [`evidence:${request.workItemId}`],
      referenceMethod: {
        methodClass,
        source: methodLabel,
        procedure: secondCheckerSeat
          ? 'Exercise the frozen artifact at the declared boundary and compare the observation with the independent oracle.'
          : 'Compare every typed obligation with the frozen candidate and response evidence.',
        expectedOutputDerivedFromSubjectCode: false,
        subjectLogicReimplemented: false,
        positiveInvariants: ['The requested positive behavior is present.'],
        negativeInvariants: ['Forbidden behavior is absent.'],
        boundaryInvariants: ['The bounded edge case remains correct.'],
      },
      testOutcomes: (request.checks || []).map(command => ({
        command, status: 'PASS',
        fingerprint: crypto.createHash('sha256')
          .update(`${request.workItemId}:${command}`).digest('hex'),
      })),
    },
  }
}

test('read-only inspect/research routes complete DONE from a validated structured final response without a workspace diff', async t => {
  for (const requestedEffect of ['inspect', 'research']) {
    const targetPath = cleanRepository(t)
    const decision = readOnlyDecision(requestedEffect)
    const persistStructuredFinalResponse = structuredResponsePersistence(t)
    const executor = createDefaultRouteExecutor({
      targetPath,
      gitEnvironment: () => process.env,
      transition: async () => {},
      harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
      persistStructuredFinalResponse,
    })
    const launches = []
    const outcome = await executor({
      route: 'DIRECT', decision,
      launch: async request => {
        launches.push(request)
        if (request.workItemId === 'work-1') return structuredWorkerResult()
        assert.equal(request.workItemId, 'independent-check-1')
        assert.equal(request.fetchedEvidence.structuredFinalResponse.resultFormat,
          decision.gateSelection.resultFormat)
        assert.equal(request.evidencePointers[0].name, 'structured-final-response')
        return passingCheckerResult(request)
      },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async () => ({}),
      resumeState: null,
    })
    assert.equal(outcome.outcome, 'DONE')
    assert.deepEqual(outcome.deliverables, [])
    assert.equal(outcome.finalResponse.resultFormat, decision.gateSelection.resultFormat)
    assert.equal(outcome.finalResponse.results[0].successItems[0].evidenceIds[0], 'subject.txt:1')
    assert.deepEqual(launches.map(request => request.workItemId), [
      'work-1', 'independent-check-1',
    ])
    const runtime = Object.create(CodexSupervisorRuntime.prototype)
    Object.assign(runtime, {
      finished: false,
      route: 'DIRECT',
      scheduler: null,
      processOwner: { async cancelAll() {}, async assertDrained() {} },
      budget: { snapshot: () => ({}) },
      finalizer: { async finalize(input) {
        assert.deepEqual(input.deliverables, [{
          path: outcome.finalResponse.evidencePointer.path,
          hash: outcome.finalResponse.evidencePointer.hash,
        }])
        return { outcome: input.outcome }
      } },
      _enforceBudgetPhase: () => ({ withinBudget: true }),
    })
    const terminal = await runtime._finish('DONE', outcome)
    assert.equal(terminal.outcome, 'DONE')
    assert.equal(terminal.finalResponse.responseHash, outcome.finalResponse.responseHash)
  }
})

test('a mutate-classified zero-diff structured response always reaches independent checking and PASS authorizes it', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate')
  const launches = []
  const transitions = []
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => transitions.push({ eventId, nextState, details }),
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse: structuredResponsePersistence(t),
  })({
    route: 'DIRECT', decision,
    launch: async request => {
      launches.push(request)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      assert.equal(request.workItemId, 'independent-check-1')
      assert.equal(request.fetchedEvidence.structuredFinalResponse.resultFormat, 'changed-files')
      assert.equal(request.evidencePointers[0].name, 'structured-final-response')
      return passingCheckerResult(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(outcome.deliverables, [])
  assert.equal(outcome.finalResponse.resultFormat, 'changed-files')
  assert.deepEqual(launches.map(request => request.workItemId), ['work-1', 'independent-check-1'])
  assert.equal(transitions.some(item => item.eventId === 'IMPLEMENTATION_DEFECT'), false)
  assert.equal(transitions.some(item => item.eventId === 'INDEPENDENT_VERDICT_RECORDED'), true)
  assert.equal(transitions.some(item => item.eventId === 'ACCEPTANCE_GREEN'), true)
})

test('a mutate-classified zero-diff response gets one checker-owned repair and a fresh repaired check', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate')
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-response-checker-'))
  t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
  const receiptPointers = new Map()
  const launches = []
  const failure = {
    code: 'FAIL',
    cause: {
      event: 'ASSERTION_FAILED',
      reason: 'The user requested an edit, but the structured response changed no file.',
      unblockPath: 'Create the requested file change.',
    },
    payload: { findingIds: ['ZERO-DIFF-EDIT-MISSING'] },
  }
  const persistReceipt = (workItemId, result) => {
    const target = path.join(receiptRoot, `${workItemId}.json`)
    const bytes = Buffer.from(`${JSON.stringify(result)}\n`)
    fs.writeFileSync(target, bytes)
    receiptPointers.set(workItemId, {
      name: workItemId, path: target,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    })
    return result
  }
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    resultPointer: workItemId => receiptPointers.get(workItemId),
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse: structuredResponsePersistence(t),
  })({
    route: 'DIRECT', decision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      if (request.workItemId === 'independent-check-1') {
        assert.equal(request.evidencePointers[0].name, 'structured-final-response')
        return persistReceipt(request.workItemId, failure)
      }
      if (request.workItemId === 'work-1-repair-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'bounded evidence\nrepaired edit\n')
        return { allAssignedItemsPass: true }
      }
      assert.equal(request.workItemId, 'independent-check-1-repair-1')
      assert.equal(request.fetchedEvidence.structuredFinalResponse, undefined)
      return passingCheckerResult(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.finalResponse, undefined)
  assert.deepEqual(launches, [
    'work-1', 'independent-check-1', 'work-1-repair-1', 'independent-check-1-repair-1',
  ])
})

test('W2/W3 aggregate zero-diff responses get one union-resource repair and fresh checking', async t => {
  for (const workerCount of [2, 3]) {
    const targetPath = cleanRepository(t)
    const decision = readOnlyDecision('mutate', workerCount)
    const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-response-w${workerCount}-`))
    t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
    const receiptPointers = new Map()
    const launches = []
    const failure = {
      code: 'FAIL',
      cause: {
        event: 'ASSERTION_FAILED',
        reason: 'The aggregate response omitted the requested local edit.',
        unblockPath: 'Create and verify the requested local edit.',
      },
      payload: { findingIds: [`ZERO-DIFF-W${workerCount}`] },
    }
    const persistReceipt = (workItemId, result) => {
      const target = path.join(receiptRoot, `${workItemId}.json`)
      const bytes = Buffer.from(`${JSON.stringify(result)}\n`)
      fs.writeFileSync(target, bytes)
      receiptPointers.set(workItemId, {
        name: workItemId, path: target,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      })
      return result
    }
    const outcome = await createDefaultRouteExecutor({
      targetPath,
      gitEnvironment: () => process.env,
      transition: async () => {},
      resultPointer: workItemId => receiptPointers.get(workItemId),
      harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
      persistStructuredFinalResponse: structuredResponsePersistence(t),
    })({
      route: 'DIRECT', decision,
      launch: async request => {
        launches.push(request)
        if (/^work-\d+$/u.test(request.workItemId)) {
          return structuredWorkerResult(request.workItemId)
        }
        if (request.workItemId === 'independent-check-1') {
          assert.equal(request.fetchedEvidence.structuredFinalResponse.resultHashes.length, workerCount)
          return persistReceipt(request.workItemId, failure)
        }
        if (request.workItemId === 'work-1-repair-1') {
          assert.deepEqual(request.ownership.map(item => item.owner),
            Array.from({ length: workerCount }, () => request.workItemId))
          assert.deepEqual(request.manifests.map(item => item.owner),
            Array.from({ length: workerCount }, () => request.workItemId))
          assert.deepEqual(request.ownership.map(item => item.identity).sort(),
            decision.mutableResourceOwnership.map(item => item.identity).sort())
          fs.writeFileSync(path.join(targetPath, 'subject.txt'),
            `bounded evidence\nunion repair for W${workerCount}\n`)
          return { allAssignedItemsPass: true }
        }
        assert.equal(request.workItemId, 'independent-check-1-repair-1')
        assert.equal(request.fetchedEvidence.structuredFinalResponse, undefined)
        return passingCheckerResult(request)
      },
      completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
    })
    assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
    assert.equal(outcome.finalResponse, undefined)
    assert.deepEqual(launches.map(request => request.workItemId), [
      ...Array.from({ length: workerCount }, (_, index) => `work-${index + 1}`),
      'independent-check-1', 'work-1-repair-1', 'independent-check-1-repair-1',
    ])
    assert.equal(launches.filter(request => request.workItemId === 'work-1-repair-1').length, 1)
  }
})

test('W2/W3 malformed checker correction can return FAIL, trigger union repair, and re-run all C1/C2 seats', async t => {
  for (const workerCount of [2, 3]) {
    for (const checkerCount of [1, 2]) {
      const targetPath = cleanRepository(t)
      const decision = readOnlyDecision('mutate', workerCount, checkerCount)
      assert.equal(decision.independentCheckingPlan.checkerCount, checkerCount)
      const receiptRoot = fs.mkdtempSync(path.join(
        os.tmpdir(), `autoprompt-combined-contingency-w${workerCount}-c${checkerCount}-`,
      ))
      t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
      const receiptPointers = new Map()
      const launches = []
      const transitions = []
      const correctedFailure = {
        schemaVersion: '2.0.0',
        code: 'FAIL',
        cause: {
          event: 'ASSERTION_FAILED',
          reason: `Corrected W${workerCount}/C${checkerCount} report found the missing edit.`,
          unblockPath: 'Create and independently verify the requested local edit.',
        },
        payload: { findingIds: [`CORRECTED-W${workerCount}-C${checkerCount}`] },
      }
      const persistReceipt = (workItemId, result) => {
        const target = path.join(receiptRoot, `${workItemId}.json`)
        const bytes = Buffer.from(`${JSON.stringify(result)}\n`)
        fs.writeFileSync(target, bytes)
        receiptPointers.set(workItemId, {
          name: workItemId, path: target,
          hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
        })
        return result
      }

      const outcome = await createDefaultRouteExecutor({
        targetPath,
        gitEnvironment: () => process.env,
        transition: async (eventId, nextState, details) => {
          transitions.push({ eventId, nextState, details })
        },
        resultPointer: workItemId => receiptPointers.get(workItemId),
        harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
        persistStructuredFinalResponse: structuredResponsePersistence(t),
      })({
        route: 'DIRECT', decision,
        launch: async request => {
          launches.push(request.workItemId)
          if (/^work-\d+$/u.test(request.workItemId)) {
            return structuredWorkerResult(request.workItemId)
          }
          if (request.workItemId === 'independent-check-1') {
            return { schemaVersion: '2.0.0', code: 'MALFORMED_VERDICT', payload: {} }
          }
          if (request.workItemId === 'independent-check-1-runtime-retry-1') {
            assert.equal(request.recoveryContext.code, 'CHECK_REPORT_INVALID')
            return persistReceipt(request.workItemId, correctedFailure)
          }
          if (request.workItemId === 'work-1-repair-1') {
            assert.deepEqual(
              request.ownership.map(item => item.owner),
              Array.from({ length: workerCount }, () => request.workItemId),
            )
            fs.writeFileSync(
              path.join(targetPath, 'subject.txt'),
              `bounded evidence\ncombined W${workerCount}/C${checkerCount} repair\n`,
            )
            return { allAssignedItemsPass: true }
          }
          return passingCheckerResult(request)
        },
        completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
      })

      assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
      assert.deepEqual(launches, [
        ...Array.from({ length: workerCount }, (_, index) => `work-${index + 1}`),
        'independent-check-1',
        'independent-check-1-runtime-retry-1',
        ...Array.from({ length: checkerCount - 1 }, (_, index) => `independent-check-${index + 2}`),
        'work-1-repair-1',
        ...Array.from({ length: checkerCount }, (_, index) =>
          `independent-check-${index + 1}-repair-1`),
      ])
      assert.equal(launches.filter(id => id.includes('runtime-retry')).length, 1)
      assert.equal(launches.filter(id => id === 'work-1-repair-1').length, 1)
      assert.equal(transitions.some(item => item.eventId === 'CHECK_INCONCLUSIVE'), true)
      assert.equal(transitions.some(item => item.eventId === 'CHECK_BECAME_CONCLUSIVE'), true)
      assert.equal(transitions.some(item => item.eventId === 'IMPLEMENTATION_DEFECT'), true)
      assert.equal(transitions.some(item => item.eventId === 'REPAIR_READY'), true)
    }
  }
})

test('one empty worker plus one changed worker checks the aggregate artifact without response repair', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate', 2)
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse: structuredResponsePersistence(t),
  })({
    route: 'DIRECT', decision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult(request.workItemId)
      if (request.workItemId === 'work-2') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'bounded evidence\nworker two edit\n')
        return { allAssignedItemsPass: true }
      }
      assert.equal(request.workItemId, 'independent-check-1')
      assert.equal(request.fetchedEvidence.structuredFinalResponse, undefined)
      return passingCheckerResult(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.finalResponse, undefined)
  assert.deepEqual(launches, ['work-1', 'work-2', 'independent-check-1'])
})

test('a rejected W2 zero-diff repair cannot repeat after the fresh checker also FAILs', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate', 2)
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-response-one-repair-'))
  t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
  const receiptPointers = new Map()
  const launches = []
  const failureFor = workItemId => ({
    code: 'FAIL',
    cause: {
      event: 'ASSERTION_FAILED', reason: `defect from ${workItemId}`,
      unblockPath: 'Repair the requested implementation.',
    },
    payload: { findingIds: [`DEFECT-${workItemId}`] },
  })
  const persistReceipt = (workItemId, result) => {
    const target = path.join(receiptRoot, `${workItemId}.json`)
    const bytes = Buffer.from(`${JSON.stringify(result)}\n`)
    fs.writeFileSync(target, bytes)
    receiptPointers.set(workItemId, {
      name: workItemId, path: target,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    })
    return result
  }
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    resultPointer: workItemId => receiptPointers.get(workItemId),
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse: structuredResponsePersistence(t),
  })({
    route: 'DIRECT', decision,
    launch: async request => {
      launches.push(request.workItemId)
      if (/^work-\d+$/u.test(request.workItemId)) return structuredWorkerResult(request.workItemId)
      if (request.workItemId === 'work-1-repair-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'bounded evidence\none repair\n')
        return { allAssignedItemsPass: true }
      }
      return persistReceipt(request.workItemId, failureFor(request.workItemId))
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.cause.reason,
    'defect from independent-check-1-repair-1')
  assert.deepEqual(launches, [
    'work-1', 'work-2', 'independent-check-1',
    'work-1-repair-1', 'independent-check-1-repair-1',
  ])
  assert.equal(launches.filter(id => id === 'work-1-repair-1').length, 1)
})

test('W2 zero-diff repair resumes exactly once from the durable defect marker', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate', 2)
  const workerResults = new Map([
    ['work-1', structuredWorkerResult('work-1')],
    ['work-2', structuredWorkerResult('work-2')],
  ])
  const checkerFailure = {
    code: 'FAIL',
    cause: {
      event: 'ASSERTION_FAILED', reason: 'The zero-diff response omitted a required edit.',
      unblockPath: 'Create the required local edit.',
    },
    payload: { findingIds: ['ZERO-DIFF-W2-CRASH'] },
  }
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-response-crash-repair-'))
  t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
  const receiptPath = path.join(receiptRoot, 'independent-check-1.json')
  const receiptBytes = Buffer.from(`${JSON.stringify(checkerFailure)}\n`)
  fs.writeFileSync(receiptPath, receiptBytes)
  const checkerPointer = {
    name: 'independent-check-1', path: receiptPath,
    hash: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
    bytes: receiptBytes.length,
  }
  const persistStructuredFinalResponse = structuredResponsePersistence(t)
  let pending
  await assert.rejects(createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (eventId, _nextState, details) => {
      if (eventId === 'IMPLEMENTATION_DEFECT') {
        pending = details
        throw Object.assign(new Error('crash before union repair'), { code: 'CRASH_BEFORE_REPAIR' })
      }
    },
    resultPointer: () => checkerPointer,
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse,
  })({
    route: 'DIRECT', decision,
    launch: async request => workerResults.get(request.workItemId) || checkerFailure,
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'CRASH_BEFORE_REPAIR')
  assert.deepEqual(pending.nextReadyWorkIds, ['work-1-repair-1'])

  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    resultPointer: () => checkerPointer,
    readResult: workItemId => workerResults.get(workItemId) ||
      (workItemId === 'independent-check-1' ? checkerFailure : null),
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse,
  })({
    route: 'DIRECT', decision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1-repair-1') {
        assert.deepEqual(request.ownership.map(item => item.owner),
          ['work-1-repair-1', 'work-1-repair-1'])
        fs.writeFileSync(path.join(targetPath, 'subject.txt'),
          'bounded evidence\nresumed union repair\n')
        return { allAssignedItemsPass: true }
      }
      assert.equal(request.workItemId, 'independent-check-1-repair-1')
      return passingCheckerResult(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'REPAIRING',
      candidateHash: pending.candidateHash,
      completedWorkIds: ['work-1', 'work-2'], completedCheckIds: [],
      nextReadyWorkIds: [pending.repairWorkItemId],
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
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, ['work-1-repair-1', 'independent-check-1-repair-1'])
})

test('a crash after durable zero-diff response persistence reuses identical bytes and launches only the checker', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate')
  const workerResult = structuredWorkerResult()
  const persist = structuredResponsePersistence(t)
  let persistenceCalls = 0
  const persistStructuredFinalResponse = response => {
    persistenceCalls += 1
    return persist(response)
  }
  let freezeDetails
  const firstLaunches = []
  const firstExecutor = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (eventId, _nextState, details) => {
      if (eventId === 'ALL_WORK_JOINED') {
        freezeDetails = details
        throw Object.assign(new Error('crash after structured response persistence'), {
          code: 'CRASH_AFTER_RESPONSE_PERSIST',
        })
      }
    },
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse,
  })
  await assert.rejects(firstExecutor({
    route: 'DIRECT', decision,
    launch: async request => {
      firstLaunches.push(request.workItemId)
      return workerResult
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'CRASH_AFTER_RESPONSE_PERSIST')
  assert.deepEqual(firstLaunches, ['work-1'])
  assert.equal(persistenceCalls, 1)

  const resumedLaunches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    readResult: workItemId => workItemId === 'work-1' ? workerResult : null,
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse,
  })({
    route: 'DIRECT', decision,
    launch: async request => {
      resumedLaunches.push(request.workItemId)
      assert.equal(request.workItemId, 'independent-check-1')
      return passingCheckerResult(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_WORK', candidateHash: freezeDetails.candidateHash,
      completedWorkIds: ['work-1'], completedCheckIds: [], acceptedResultIds: [],
      nextReadyWorkIds: ['independent-check-1'], retryState: {},
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(resumedLaunches, ['independent-check-1'])
  assert.equal(persistenceCalls, 2)
  assert.equal(outcome.finalResponse.evidencePointer.name, 'structured-final-response')
})

test('L0 correction keeps the four-minute target but owns one finite completion watchdog', () => {
  assert.equal(remainingL0DecisionBudgetMs({ startedAtMs: 10_000, nowMs: 249_950 }), 1_560_050)
  assert.equal(remainingL0DecisionBudgetMs({ startedAtMs: 10_000, nowMs: 1_810_000 }), 0)
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

test('a proven drained baseline timeout is recorded as an honest FAIL and unproven drain is rejected', async t => {
  const root = cleanRepository(t)
  const resolved = resolveTrustedTestDeclarations({
    repository: [{ id: 'slow-test', executable: process.execPath, argv: ['--test', 'slow.test.cjs'] }],
  }, { repository: root })
  const timeoutEvidenceHash = 'a'.repeat(64)
  const baseline = await executeExistingTestBaseline(resolved, {
    environment: {},
    runner: async () => ({
      exitCode: 124,
      stderr: `EXISTING_TEST_BASELINE_TIMEOUT ${timeoutEvidenceHash}`,
      processOwned: true,
      exactArgv: true,
      drained: true,
      timedOut: true,
      timeoutEvidenceHash,
    }),
  })
  assert.deepEqual({
    status: baseline[0].status,
    exitCode: baseline[0].exitCode,
    timedOut: baseline[0].timedOut,
    timeoutEvidenceHash: baseline[0].timeoutEvidenceHash,
  }, { status: 'FAIL', exitCode: 124, timedOut: true, timeoutEvidenceHash })

  await assert.rejects(executeExistingTestBaseline(resolved, {
    environment: {},
    runner: async () => ({
      exitCode: 124,
      processOwned: true,
      exactArgv: true,
      drained: false,
      timedOut: true,
      timeoutEvidenceHash,
    }),
  }), error => error.code === 'EXISTING_TEST_BASELINE_INVALID')
})
