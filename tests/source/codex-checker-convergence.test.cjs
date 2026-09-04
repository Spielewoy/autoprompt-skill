'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  canonicalCheckerVerificationAuthority,
  canonicalCheckerTestOutcomes,
  checkerRecoveryNextReady,
  checkerResultBoundToCommandExecutionEvidence,
  createCheckerObservationBinding,
  createCodexJsonlAccumulator,
  createDefaultRouteExecutor,
  normalizeCheckerOutcomeIdentity,
} = require('../../agents/codex/workflow/phase-budget.js')
const { stableStringify } = require('../../agents/codex/workflow/event-log.js')
const { createRouteDecision } = require('../../agents/codex/workflow/route-decision.js')
const router = require('../../agents/codex/workflow/router.js')

const H = 'a'.repeat(64)
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const providerCommand = inner => `/bin/bash -lc '${String(inner).replace(/'/gu, `'\\''`)}'`

function git(cwd, argv) {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function cleanRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-checker-route-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(root, 'subject.txt'), 'bounded evidence\n')
  git(root, ['add', 'subject.txt'])
  git(root, ['commit', '-m', 'fixture'])
  return root
}

function directDecision(checkerCount = 1, requestedEffect = 'inspect') {
  const mutating = requestedEffect === 'mutate'
  const mutableResources = mutating ? [{
    kind: 'file', identity: 'subject.txt', shared: false, ownershipMode: 'single-owner',
  }] : []
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
    sideEffects: mutating ? ['deliverable-write'] : [],
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
        : [mutating ? 'behavior-test' : 'receipt'],
      baselineStatus: 'recorded', hiddenExternalCheck: false,
    },
    deadlineBudget: {
      remainingSeconds: 600, admissionSeconds: 240, executionReserveSeconds: 180,
      verificationReserveSeconds: 120, recoveryAndFinalizationReserveSeconds: 60,
    },
    operatorMinimumRoute: null,
    transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true },
    candidateFreeze: { required: mutating, available: true, environmentCanBeBound: true },
    missingUserInput: [], architectureImpact: 'local', fitsLightPlan: true,
    approachNeedsShortPlanning: false, shortOrderUnclear: false,
  })
  const classified = router.classifyRoute(facts)
  return createRouteDecision({
    route: 'DIRECT', routeFacts: facts,
    requestedResult: mutating
      ? 'Update subject.txt and verify the result.'
      : 'Inspect subject.txt and report the finding.',
    successChecklist: ['The result is evidence-backed.'],
    checks: ['Review the structured result and its evidence receipt.'],
    likelyAreas: ['subject.txt'], risks: [], missingInformation: [],
    workers: {
      count: 1,
      responsibilities: ['Own the bounded target and return one structured result.'],
      nonOverlapReason: 'One worker owns the bounded target.',
    },
    mutableResourceOwnership: mutableResources.map(resource => ({ ...resource, owner: 'worker-1' })),
    chosenRouteReason: 'The bounded request has a known check.',
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
    gateSelection: mutating ? {
      baseWorkType: 'mechanical-change', resultFormat: 'changed-files',
      artifactOverlays: ['executable-code'], acceptanceOverlays: ['exact-diff'],
      riskOverlays: [], riskEvidence: {},
    } : {
      baseWorkType: 'inspect-report', resultFormat: 'read-only-findings',
      artifactOverlays: ['read-only-result'], acceptanceOverlays: ['receipts'],
      riskOverlays: [], riskEvidence: {},
    },
  })
}

function structuredWorkerResult() {
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: 'result:work-1',
    allAssignedItemsPass: true, filesChanged: [], commands: [],
    successItems: [{ id: 'result', status: 'pass', evidenceIds: ['subject.txt:1'] }],
    behaviorChanged: ['subject.txt contains the bounded evidence marker.'],
    remainingConcerns: [],
  }
}

function structuredResponsePersistence(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-checker-response-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return response => {
    const target = path.join(root, 'candidate.json')
    const bytes = Buffer.from(`${JSON.stringify(response, null, 2)}\n`)
    if (fs.existsSync(target)) assert.deepEqual(fs.readFileSync(target), bytes)
    else fs.writeFileSync(target, bytes)
    return {
      name: 'structured-final-response', path: target,
      hash: digest(bytes), bytes: bytes.length,
    }
  }
}

function directPassingCheckerResult(request) {
  return {
    schemaVersion: '2.0.0', code: 'PASS',
    payload: {
      evidenceIds: [`evidence:${request.workItemId}`],
      referenceMethod: {
        methodClass: 'requirements-review',
        source: `independent requirements for ${request.workItemId}`,
        procedure: 'Compare every typed obligation with the frozen candidate and response evidence.',
        expectedOutputDerivedFromSubjectCode: false,
        subjectLogicReimplemented: false,
        positiveInvariants: ['The requested positive behavior is present.'],
        negativeInvariants: ['Forbidden behavior is absent.'],
        boundaryInvariants: ['The bounded edge case remains correct.'],
      },
      testOutcomes: (request.checks || []).map(command => ({
        command, status: 'PASS', fingerprint: digest(`${request.workItemId}:${command}`),
      })),
    },
  }
}

function routeOptions(t, targetPath, transitions = []) {
  return {
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => {
      transitions.push({ eventId, nextState, details })
    },
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse: structuredResponsePersistence(t),
  }
}

function scratchFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-checker-convergence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const candidate = path.join(root, 'candidate')
  const scratch = path.join(root, 'scratch')
  const temporaryRoot = path.join(scratch, 'tmp')
  const outputRoot = path.join(scratch, 'output')
  const cacheRoot = path.join(scratch, 'cache')
  for (const directory of [candidate, scratch, temporaryRoot, outputRoot, cacheRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(path.join(candidate, 'subject.txt'), 'frozen candidate\n')
  const harness = path.join(scratch, 'check.py')
  fs.writeFileSync(harness, [
    'import hashlib, json, pathlib, sys',
    'subject = (pathlib.Path(sys.argv[1]) / "subject.txt").read_bytes()',
    'print(json.dumps({"status":"FAIL","failureCount":1,"subjectSha256":hashlib.sha256(subject).hexdigest()}))',
    'raise SystemExit(1)',
    '',
  ].join('\n'))
  const checkerScratchBoundary = {
    frozenCandidateRoot: candidate,
    writableScratchRoot: scratch,
    temporaryRoot,
    outputRoot,
    cacheRoot,
  }
  return {
    candidate,
    harness,
    context: { workingDirectory: scratch, checkerScratchBoundary },
    checkerScratchBoundary,
  }
}

function commandEvidence(context, command, output, { started = true } = {}) {
  const accumulator = createCodexJsonlAccumulator(context)
  if (started) {
    accumulator.push(JSON.stringify({
      type: 'item.started',
      item: { id: 'checker-command', type: 'command_execution', command },
    }))
  }
  accumulator.push(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'checker-command', type: 'command_execution', command,
      status: 'failed', exit_code: 1, aggregated_output: output,
    },
  }))
  return accumulator.snapshot()
}

function scratchReferenceMethod(label, methodClass = 'black-box-boundary') {
  return {
    methodClass,
    source: `${label} independently derived boundary corpus`,
    procedure: `${label} executes a separately authored validator and compares each observation with its own boundary oracle.`,
    expectedOutputDerivedFromSubjectCode: false,
    subjectLogicReimplemented: false,
    positiveInvariants: [`${label} observes the required positive behavior.`],
    negativeInvariants: [`${label} rejects the independently selected forbidden behavior.`],
    boundaryInvariants: [`${label} exercises its independently selected boundary case.`],
  }
}

function scratchPassResult({
  candidateHash,
  requestEnvelopeHash = H,
  workItemId,
  oracleId,
  checks,
  label,
  evidenceId = `sha256:${digest(`evidence:${label}`)}`,
  methodClass = 'black-box-boundary',
  methodLabel = label,
}) {
  const authorityChecks = [...checks].sort().map(checkId => Object.freeze({
    authority: 'SCRATCH_HARNESS',
    checkId,
    commandHash: digest(`command:${label}:${checkId}`),
    harnessCommandHash: digest(`harness-command:${label}:${checkId}`),
    fingerprint: digest(`fingerprint:${label}:${checkId}`),
    observationHash: digest(`observation:${label}:${checkId}`),
    observationId: digest(`observation-id:${label}:${checkId}`),
    programBytes: Buffer.byteLength(`program:${label}`),
    programDigest: digest(`program:${label}`),
    programPathHash: digest(`program-path:${label}`),
    programIdentityHash: digest(`program-identity:${label}`),
  }))
  const authorityBody = Object.freeze({
    schemaVersion: 1,
    candidateHash,
    requestEnvelopeHash,
    assignmentId: `assignment:${label}`,
    workItemId,
    oracleId,
    contextId: `context:${label}`,
    bindingHash: digest(`binding:${label}`),
    observationEvidenceHash: digest(`observation-evidence:${label}`),
    scratchBoundaryHash: digest(`scratch-boundary:${label}`),
    frozenCandidateRootPathHash: digest(`candidate-root:${label}`),
    writableScratchRootPathHash: digest(`scratch-root:${label}`),
    checks: authorityChecks,
  })
  const verificationAuthority = Object.freeze({
    ...authorityBody,
    authorityHash: digest(stableStringify(authorityBody)),
  })
  return Object.freeze({
    schemaVersion: '2.0.0',
    code: 'CHECK_INCONCLUSIVE',
    candidateHash,
    requestEnvelopeHash,
    contextId: authorityBody.contextId,
    cause: Object.freeze({
      event: 'CHECK_SCRATCH_CONFIRMATION_REQUIRED',
      reason: 'The independently authored scratch validator is provisional PASS evidence.',
      unblockPath: 'Join it with one disjoint controller-bound scratch PASS authority.',
    }),
    payload: Object.freeze({
      evidenceIds: Object.freeze([evidenceId]),
      referenceMethod: Object.freeze(scratchReferenceMethod(methodLabel, methodClass)),
      testOutcomes: Object.freeze([...checks].sort().map(command => Object.freeze({
        command,
        status: 'PASS',
        fingerprint: digest(`outcome:${label}:${command}`),
      }))),
      verificationAuthority,
      verificationObservationDisposition: Object.freeze({
        reportedAggregateCode: 'PASS',
        missingCheckIds: Object.freeze([]),
        conflictingCommandHashes: Object.freeze([]),
      }),
    }),
  })
}

function scratchResultForRequest(request, options = {}) {
  const result = scratchPassResult({
    candidateHash: request.candidateHash,
    workItemId: request.workItemId,
    oracleId: request.oracle,
    checks: request.checks,
    label: options.label || request.workItemId,
    ...(options.evidenceId ? { evidenceId: options.evidenceId } : {}),
    ...(options.methodClass ? { methodClass: options.methodClass } : {}),
    ...(options.methodLabel ? { methodLabel: options.methodLabel } : {}),
  })
  assert.ok(canonicalCheckerVerificationAuthority(result, request.checks))
  return result
}

function completeCommandReceiptAuthority(request, label = request.workItemId) {
  const checks = [...request.checks].sort().map(checkId => Object.freeze({
    authority: 'CANDIDATE_HARNESS',
    checkId,
    commandHash: digest(`command:${label}:${checkId}`),
    harnessCommandHash: digest(`harness-command:${label}:${checkId}`),
    fingerprint: digest(`fingerprint:${label}:${checkId}`),
    observationHash: digest(`observation:${label}:${checkId}`),
    observationId: digest(`observation-id:${label}:${checkId}`),
  }))
  const body = Object.freeze({
    schemaVersion: 1,
    candidateHash: request.candidateHash,
    requestEnvelopeHash: H,
    assignmentId: request.workItemId,
    workItemId: request.workItemId,
    oracleId: request.oracle,
    contextId: `context:${label}`,
    bindingHash: digest(`binding:${label}`),
    observationEvidenceHash: digest(`observation-evidence:${label}`),
    scratchBoundaryHash: digest(`scratch-boundary:${label}`),
    frozenCandidateRootPathHash: digest(`candidate-root:${label}`),
    writableScratchRootPathHash: digest(`scratch-root:${label}`),
    checks,
  })
  return Object.freeze({ ...body, authorityHash: digest(stableStringify(body)) })
}

function malformedReportWithCompleteReceipts(request, label = request.workItemId) {
  return Object.freeze({
    schemaVersion: '2.0.0',
    code: 'MALFORMED_CHECKER_VERDICT',
    candidateHash: request.candidateHash,
    currentVersionHash: request.candidateHash,
    contextId: `context:${label}`,
    payload: Object.freeze({
      verificationAuthority: completeCommandReceiptAuthority(request, label),
      verificationObservationDisposition: Object.freeze({
        reportedAggregateCode: 'FAIL',
        missingCheckIds: Object.freeze([]),
        commandBoundFailureCheckIds: Object.freeze([...request.checks]),
        unboundFailureCheckIds: Object.freeze([]),
        conflictingCommandHashes: Object.freeze([]),
      }),
    }),
  })
}

function authenticatedScratchFailureForRequest(request, options = {}) {
  const provisional = scratchResultForRequest(request, options)
  const payload = {
    ...provisional.payload,
    testOutcomes: provisional.payload.testOutcomes.map(outcome => ({
      ...outcome,
      status: 'FAIL',
      failureIdentity: digest(`failure:${request.workItemId}:${outcome.command}`),
    })),
  }
  delete payload.verificationObservationDisposition
  const result = Object.freeze({
    ...provisional,
    code: 'FAIL',
    cause: Object.freeze({
      event: 'ASSERTION_FAILED',
      reason: 'The direct sealed confirmation reproduced a concrete product defect.',
      unblockPath: 'Repair the product and run a fresh full check.',
    }),
    payload: Object.freeze(payload),
  })
  assert.ok(canonicalCheckerVerificationAuthority(result, request.checks))
  return result
}

function persistResultPointer(t, workItemId, result) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-checker-result-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, `${workItemId}.json`)
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`)
  fs.writeFileSync(target, bytes)
  return Object.freeze({
    name: workItemId,
    path: target,
    hash: digest(bytes),
    bytes: bytes.length,
  })
}

test('checker outcome aliases normalize to one named identity and reject conflicts, duplicates, and unknown IDs', () => {
  const checks = ['named-check-a', 'named-check-b']
  const fingerprint = digest('outcome')
  for (const alias of ['command', 'checkId', 'id']) {
    const item = { [alias]: checks[0], status: 'PASS', fingerprint }
    assert.equal(normalizeCheckerOutcomeIdentity(item, checks).command, checks[0], alias)
    assert.deepEqual(canonicalCheckerTestOutcomes([item], [checks[0]]), [{
      command: checks[0], status: 'PASS', fingerprint,
    }], alias)
  }
  assert.equal(normalizeCheckerOutcomeIdentity({
    command: checks[0], checkId: checks[1], status: 'PASS', fingerprint,
  }, checks), null)
  assert.equal(normalizeCheckerOutcomeIdentity({
    checkId: 'unknown-check', status: 'PASS', fingerprint,
  }, checks), null)
  assert.equal(canonicalCheckerTestOutcomes([
    { checkId: checks[0], status: 'PASS', fingerprint },
    { id: checks[0], status: 'PASS', fingerprint },
  ], checks), null)
})

test('one direct sealed scratch harness authenticates FAIL and routes to product repair', t => {
  const fixture = scratchFixture(t)
  const checkId = 'frozen-candidate-behavior'
  const directCommand = `python3 ${JSON.stringify(fixture.harness)} ${JSON.stringify(fixture.candidate)}`
  const command = providerCommand(directCommand)
  const executed = spawnSync('python3', [fixture.harness, fixture.candidate], {
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(executed.status, 1, executed.stderr)
  const summary = JSON.parse(executed.stdout)
  assert.equal(summary.subjectSha256, digest('frozen candidate\n'))
  const parsed = commandEvidence(fixture.context, command, executed.stdout)
  const binding = createCheckerObservationBinding({
    assignmentId: 'independent-check-1',
    candidateHash: H,
    requestEnvelopeHash: digest('request'),
    checkIds: [checkId],
  })
  const result = checkerResultBoundToCommandExecutionEvidence({
    code: 'PASS',
    payload: { testOutcomes: [{ checkId, status: 'FAIL' }] },
  }, parsed, {
    logicalRole: 'independent-reviewer',
    workItemId: 'independent-check-1',
    candidateHash: H,
    requestEnvelopeHash: digest('request'),
    canonicalAssignment: {
      assignmentId: 'independent-check-1',
      requestEnvelopeHash: digest('request'),
      checks: [checkId],
      verificationObservationBinding: binding,
    },
    checkerScratchBoundary: fixture.checkerScratchBoundary,
  })

  assert.equal(parsed.verificationObservations.receipts.length, 1)
  assert.equal(parsed.verificationObservations.receipts[0].failureHarnessAdmissible, true)
  assert.equal(result.code, 'FAIL')
  assert.deepEqual(result.payload.testOutcomes.map(item => [item.command, item.status]), [
    [checkId, 'FAIL'],
  ])
  assert.deepEqual(checkerRecoveryNextReady('independent-check-1', result, {
    nonAuthoritativeRetryId: 'independent-check-1-runtime-retry-1',
    failureRepairId: 'work-1-repair-1',
    stableLimitationNextReadyId: null,
  }), ['work-1-repair-1'])
})

test('one sealed nonzero harness covering mixed named outcomes triggers one aggregate repair without runtime retry', async t => {
  const targetPath = cleanRepository(t)
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-mixed-harness-'))
  t.after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }))
  const temporaryRoot = path.join(scratchRoot, 'tmp')
  const outputRoot = path.join(scratchRoot, 'output')
  const cacheRoot = path.join(scratchRoot, 'cache')
  for (const directory of [temporaryRoot, outputRoot, cacheRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const harness = path.join(scratchRoot, 'mixed-check.py')
  fs.writeFileSync(harness, [
    'import json, pathlib, sys',
    'subject = (pathlib.Path(sys.argv[1]) / "subject.txt").read_text()',
    'print(json.dumps({"status":"FAIL","failureCount":1,"bytes":len(subject)}))',
    'raise SystemExit(1)',
    '',
  ].join('\n'))
  const checkerScratchBoundary = {
    frozenCandidateRoot: targetPath,
    writableScratchRoot: scratchRoot,
    temporaryRoot,
    outputRoot,
    cacheRoot,
  }
  const pointers = new Map()
  const launches = []
  const transitions = []
  let aggregateFailure = null
  let harnessExecutions = 0
  let repairLaunches = 0
  const routeDecision = directDecision(1, 'mutate')
  const outcome = await createDefaultRouteExecutor({
    ...routeOptions(t, targetPath, transitions),
    resultPointer: workItemId => pointers.get(workItemId) || null,
  })({
    route: 'DIRECT',
    decision: routeDecision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      if (request.workItemId === 'work-1-repair-1') {
        repairLaunches += 1
        assert.equal(request.fetchedEvidence.rejectedCheckerReceipts.length, 1)
        assert.match(request.fetchedEvidence.aggregateFailureHash, /^[a-f0-9]{64}$/u)
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'bounded evidence\nrepaired once\n')
        return { allAssignedItemsPass: true }
      }
      if (request.workItemId === 'independent-check-1-repair-1') {
        return directPassingCheckerResult(request)
      }
      assert.equal(request.workItemId, 'independent-check-1')
      assert.ok(request.checks.length >= 2)
      const directCommand = `python3 ${JSON.stringify(harness)} ${JSON.stringify(targetPath)}`
      const command = providerCommand(directCommand)
      const executed = spawnSync('python3', [harness, targetPath], {
        encoding: 'utf8', windowsHide: true,
      })
      harnessExecutions += 1
      assert.equal(executed.status, 1, executed.stderr)
      const evidence = commandEvidence(
        { workingDirectory: scratchRoot, checkerScratchBoundary },
        command,
        executed.stdout,
      )
      const binding = createCheckerObservationBinding({
        assignmentId: request.workItemId,
        candidateHash: request.candidateHash,
        requestEnvelopeHash: routeDecision.requestEnvelopeHash,
        checkIds: request.checks,
      })
      const reportedOutcomes = request.checks.map((checkId, index) => ({
        checkId,
        status: index === 1 ? 'FAIL' : 'PASS',
      }))
      aggregateFailure = checkerResultBoundToCommandExecutionEvidence({
        code: 'PASS',
        payload: { testOutcomes: reportedOutcomes },
      }, evidence, {
        logicalRole: request.logicalRole,
        workItemId: request.workItemId,
        candidateHash: request.candidateHash,
        requestEnvelopeHash: routeDecision.requestEnvelopeHash,
        canonicalAssignment: {
          assignmentId: request.workItemId,
          requestEnvelopeHash: routeDecision.requestEnvelopeHash,
          checks: request.checks,
          verificationObservationBinding: binding,
        },
        checkerScratchBoundary,
      })
      assert.equal(aggregateFailure.code, 'FAIL', JSON.stringify(aggregateFailure))
      assert.equal(
        aggregateFailure.payload.verificationObservationDisposition.reportedAggregateCode,
        'PASS',
      )
      assert.deepEqual(
        aggregateFailure.payload.verificationObservationDisposition.commandBoundFailureCheckIds,
        [request.checks[1]],
      )
      pointers.set(request.workItemId,
        persistResultPointer(t, request.workItemId, aggregateFailure))
      return aggregateFailure
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(aggregateFailure.code, 'FAIL')
  assert.equal(harnessExecutions, 1)
  assert.equal(repairLaunches, 1)
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
    'work-1-repair-1',
    'independent-check-1-repair-1',
  ])
  assert.equal(launches.some(id => id.includes('runtime-retry')), false)
  assert.equal(transitions.filter(item => item.eventId === 'IMPLEMENTATION_DEFECT').length, 1)
  assert.equal(transitions.filter(item => item.eventId === 'REPAIR_READY').length, 1)
})

test('sealed native and non-Python scratch harnesses authenticate concrete FAIL', t => {
  const fixture = scratchFixture(t)
  const checkId = 'native-frozen-candidate-behavior'
  const nativeHarness = path.join(path.dirname(fixture.harness), 'native-check')
  const nodeHarness = path.join(path.dirname(fixture.harness), 'check.mjs')
  fs.writeFileSync(nativeHarness, [
    '#!/bin/sh',
    'printf \'%s\\n\' \'{"status":"FAIL","failureCount":1,"failed":["native-boundary"]}\'',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o700 })
  fs.writeFileSync(nodeHarness, [
    'console.log(JSON.stringify({status:"FAIL",failureCount:1,failed:["node-boundary"]}))',
    'process.exit(1)',
    '',
  ].join('\n'))
  for (const directCommand of [
    `${JSON.stringify(nativeHarness)} ${JSON.stringify(fixture.candidate)}`,
    `node ${JSON.stringify(nodeHarness)} ${JSON.stringify(fixture.candidate)}`,
  ]) {
    const summary = JSON.stringify({
      status: 'FAIL', failureCount: 1, failed: [directCommand.startsWith('node ')
        ? 'node-boundary' : 'native-boundary'],
    })
    const parsed = commandEvidence(fixture.context, providerCommand(directCommand), summary)
    const binding = createCheckerObservationBinding({
      assignmentId: 'independent-check-1',
      candidateHash: H,
      requestEnvelopeHash: digest(directCommand),
      checkIds: [checkId],
    })
    const result = checkerResultBoundToCommandExecutionEvidence({
      code: 'FAIL', payload: { testOutcomes: [{ checkId, status: 'FAIL' }] },
    }, parsed, {
      logicalRole: 'independent-reviewer',
      workItemId: 'independent-check-1',
      candidateHash: H,
      requestEnvelopeHash: digest(directCommand),
      canonicalAssignment: {
        assignmentId: 'independent-check-1',
        requestEnvelopeHash: digest(directCommand),
        checks: [checkId],
        verificationObservationBinding: binding,
      },
      checkerScratchBoundary: fixture.checkerScratchBoundary,
    })
    assert.equal(parsed.verificationObservations.receipts.length, 1, directCommand)
    assert.equal(parsed.verificationObservations.receipts[0].failureHarnessAdmissible, true,
      directCommand)
    assert.equal(result.code, 'FAIL', directCommand)
  }
})

test('scratch harness authority requires the direct sealed candidate argument and bounded JSON output', t => {
  const fixture = scratchFixture(t)
  const direct = `python3 ${JSON.stringify(fixture.harness)} ${JSON.stringify(fixture.candidate)}`
  const embedded = `python3 ${JSON.stringify(fixture.harness)}`
  const shellGlue = `${direct} > ${JSON.stringify(path.join(fixture.checkerScratchBoundary.outputRoot, 'result.json'))}`
  const summary = JSON.stringify({ status: 'FAIL', failureCount: 1, failed: ['boundary'] })

  assert.equal(commandEvidence(fixture.context, direct, summary)
    .verificationObservations.receipts[0].failureHarnessAdmissible, true)
  assert.equal(commandEvidence(fixture.context, providerCommand(direct), summary)
    .verificationObservations.receipts[0].failureHarnessAdmissible, true)
  assert.equal(commandEvidence(fixture.context, direct, summary, { started: false })
    .verificationObservations.receipts[0].failureHarnessAdmissible, false)
  assert.equal(commandEvidence(fixture.context, embedded, summary)
    .verificationObservations.receipts[0].failureHarnessAdmissible, false)
  assert.equal(commandEvidence(fixture.context, shellGlue, summary)
    .verificationObservations.receipts[0].failureHarnessAdmissible, false)
  for (const unsafeInner of [
    shellGlue,
    `${direct} | tee result.json`,
    `PYTHONPATH=/tmp ${direct}`,
    `${direct} fourth-argument`,
    `bash -lc ${JSON.stringify(direct)}`,
  ]) {
    assert.equal(commandEvidence(fixture.context, providerCommand(unsafeInner), summary)
      .verificationObservations.receipts[0].failureHarnessAdmissible, false, unsafeInner)
  }
  assert.equal(commandEvidence(fixture.context, direct, 'FAIL: boundary')
    .verificationObservations.receipts[0].failureHarnessAdmissible, false)
})

test('PASS remains strict and cannot bind to an inline or echo claim', () => {
  const checkId = 'strict-pass-check'
  const accumulator = createCodexJsonlAccumulator()
  accumulator.push(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'echo-pass', type: 'command_execution', command: 'echo PASS',
      status: 'completed', exit_code: 0, aggregated_output: 'PASS',
    },
  }))
  const binding = createCheckerObservationBinding({
    assignmentId: 'independent-check-1',
    candidateHash: H,
    requestEnvelopeHash: digest('strict request'),
    checkIds: [checkId],
  })
  const result = checkerResultBoundToCommandExecutionEvidence({
    code: 'PASS', payload: { testOutcomes: [{ checkId, status: 'PASS' }] },
  }, accumulator.snapshot(), {
    logicalRole: 'independent-reviewer',
    workItemId: 'independent-check-1',
    candidateHash: H,
    canonicalAssignment: {
      assignmentId: 'independent-check-1',
      requestEnvelopeHash: digest('strict request'),
      checks: [checkId],
      verificationObservationBinding: binding,
    },
  })
  assert.equal(result.code, 'CHECK_INCONCLUSIVE')
  assert.equal(result.cause.event, 'CHECK_OBSERVATION_INCOMPLETE')
})

test('unauthenticated and inconclusive checker evidence has no same-seat runtime retry frontier', () => {
  const disposition = {
    nonAuthoritativeRetryId: 'independent-check-1-runtime-retry-1',
    failureRepairId: 'work-1-repair-1',
    stableLimitationNextReadyId: 'independent-check-2',
  }
  for (const result of [
    {
      code: 'CHECK_INCONCLUSIVE',
      cause: { event: 'CHECK_OBSERVATION_INCOMPLETE' },
      payload: { verificationObservationDisposition: { reportedAggregateCode: 'PASS' } },
    },
    {
      code: 'CHECK_INCONCLUSIVE',
      cause: { event: 'CHECK_OBSERVATION_CONTRADICTION' },
      payload: { verificationObservationDisposition: { reportedAggregateCode: 'PASS' } },
    },
    { code: 'CHECK_INCONCLUSIVE', cause: { event: 'CHECK_RUNTIME_UNAVAILABLE' } },
    { code: 'RUNTIME_FAILURE', cause: { event: 'DEPENDENCY_UNAVAILABLE' } },
  ]) {
    assert.deepEqual(checkerRecoveryNextReady(
      'independent-check-1', result, disposition,
    ), ['independent-check-2'], result.cause.event)
  }
  assert.deepEqual(checkerRecoveryNextReady(
    'independent-check-2',
    { code: 'CHECK_INCONCLUSIVE', cause: { event: 'CHECK_OBSERVATION_INCOMPLETE' } },
    { ...disposition, stableLimitationNextReadyId: null },
  ), [])
})

test('duplicate or competing sealed failure receipts stay inconclusive despite a model-supplied selector', t => {
  const fixture = scratchFixture(t)
  const secondHarness = path.join(path.dirname(fixture.harness), 'check-second.py')
  fs.copyFileSync(fixture.harness, secondHarness)
  const firstCommand = providerCommand(
    `python3 ${JSON.stringify(fixture.harness)} ${JSON.stringify(fixture.candidate)}`,
  )
  const secondCommand = providerCommand(
    `python3 ${JSON.stringify(secondHarness)} ${JSON.stringify(fixture.candidate)}`,
  )
  const summary = JSON.stringify({ status: 'FAIL', failureCount: 1, failed: ['required behavior'] })
  const checkId = 'exactly-once-scratch-check'
  const binding = createCheckerObservationBinding({
    assignmentId: 'independent-check-1',
    candidateHash: H,
    requestEnvelopeHash: digest('multiple scratch request'),
    checkIds: [checkId],
  })

  for (const [label, commands] of [
    ['same command twice', [firstCommand, firstCommand]],
    ['two selectable paths', [firstCommand, secondCommand]],
  ]) {
    const accumulator = createCodexJsonlAccumulator(fixture.context)
    commands.forEach((command, index) => {
      const id = `checker-command-${index + 1}`
      accumulator.push(JSON.stringify({
        type: 'item.started', item: { id, type: 'command_execution', command },
      }))
      accumulator.push(JSON.stringify({
        type: 'item.completed',
        item: {
          id, type: 'command_execution', command, status: 'failed', exit_code: 1,
          aggregated_output: summary,
        },
      }))
    })
    const parsed = accumulator.snapshot()
    assert.equal(parsed.verificationObservations.scratchHarnessInvocationCount, 2, label)
    const result = checkerResultBoundToCommandExecutionEvidence({
      code: 'FAIL',
      payload: {
        testOutcomes: [{
          checkId, status: 'FAIL', commandHash: digest(firstCommand),
        }],
      },
    }, parsed, {
      logicalRole: 'independent-reviewer',
      workItemId: 'independent-check-1',
      candidateHash: H,
      requestEnvelopeHash: digest('multiple scratch request'),
      canonicalAssignment: {
        assignmentId: 'independent-check-1',
        requestEnvelopeHash: digest('multiple scratch request'),
        checks: [checkId],
        verificationObservationBinding: binding,
      },
      checkerScratchBoundary: fixture.checkerScratchBoundary,
    })
    assert.equal(result.code, 'CHECK_INCONCLUSIVE', label)
    assert.equal(result.cause.event, 'CHECK_OBSERVATION_INCOMPLETE', label)
    assert.match(result.cause.reason, label === 'same command twice'
      ? /invoked more than once/u : /lack a matching admissible command observation/u, label)
  }
})

test('a malformed first scratch execution remains bound when a later execution yields a valid FAIL', t => {
  const fixture = scratchFixture(t)
  const command = providerCommand(
    `python3 ${JSON.stringify(fixture.harness)} ${JSON.stringify(fixture.candidate)}`,
  )
  const summary = JSON.stringify({ status: 'FAIL', failureCount: 1, failed: ['required behavior'] })
  const checkId = 'malformed-first-scratch-check'
  const binding = createCheckerObservationBinding({
    assignmentId: 'independent-check-1',
    candidateHash: H,
    requestEnvelopeHash: digest('malformed first scratch request'),
    checkIds: [checkId],
  })
  const oneRun = commandEvidence(fixture.context, command, summary)
  const accumulator = createCodexJsonlAccumulator(fixture.context)
  accumulator.push(JSON.stringify({
    type: 'item.started',
    item: { id: 'malformed-first', type: 'command_execution', command },
  }))
  accumulator.push(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'malformed-first', type: 'command_execution', command,
      status: 'failed', exit_code: 1, aggregated_output: '',
    },
  }))
  accumulator.push(JSON.stringify({
    type: 'item.started',
    item: { id: 'valid-second', type: 'command_execution', command },
  }))
  accumulator.push(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'valid-second', type: 'command_execution', command,
      status: 'failed', exit_code: 1, aggregated_output: summary,
    },
  }))
  const parsed = accumulator.snapshot()
  assert.equal(parsed.verificationObservations.receipts.length, 1)
  assert.equal(parsed.verificationObservations.scratchHarnessInvocationCount, 2)
  assert.notEqual(
    parsed.verificationObservations.evidenceHash,
    oneRun.verificationObservations.evidenceHash,
  )
  const result = checkerResultBoundToCommandExecutionEvidence({
    code: 'FAIL', payload: { testOutcomes: [{ checkId, status: 'FAIL' }] },
  }, parsed, {
    logicalRole: 'independent-reviewer',
    workItemId: 'independent-check-1',
    candidateHash: H,
    requestEnvelopeHash: digest('malformed first scratch request'),
    canonicalAssignment: {
      assignmentId: 'independent-check-1',
      requestEnvelopeHash: digest('malformed first scratch request'),
      checks: [checkId],
      verificationObservationBinding: binding,
    },
    checkerScratchBoundary: fixture.checkerScratchBoundary,
  })
  assert.equal(result.code, 'CHECK_INCONCLUSIVE')
  assert.match(result.cause.reason, /invoked more than once/u)
})

test('configured C1 and C2 scratch authorities confirm each other without a third checker turn', async t => {
  const targetPath = cleanRepository(t)
  const launches = []
  const transitions = []
  const outcome = await createDefaultRouteExecutor(
    routeOptions(t, targetPath, transitions),
  )({
    route: 'DIRECT',
    decision: directDecision(2),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      return scratchResultForRequest(request, {
        label: request.workItemId,
        methodClass: request.workItemId === 'independent-check-1'
          ? 'black-box-boundary' : 'independent-model',
      })
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, ['work-1', 'independent-check-1', 'independent-check-2'])
  assert.equal(launches.some(id => id.includes('scratch-confirmation')), false)
  assert.equal(launches.some(id => id.includes('runtime-retry')), false)
  assert.equal(
    transitions.filter(item => item.eventId === 'INDEPENDENT_VERDICT_RECORDED').length,
    2,
  )
})

test('C1 and C2 reused scratch evidence or method returns the candidate after exactly two checker turns', async t => {
  for (const reuse of ['evidence', 'method']) {
    const targetPath = cleanRepository(t)
    const launches = []
    const outcome = await createDefaultRouteExecutor(routeOptions(t, targetPath))({
      route: 'DIRECT',
      decision: directDecision(2),
      launch: async request => {
        launches.push(request.workItemId)
        if (request.workItemId === 'work-1') return structuredWorkerResult()
        return scratchResultForRequest(request, {
          label: `${reuse}:${request.workItemId}`,
          evidenceId: reuse === 'evidence' ? `sha256:${digest('shared evidence')}` : undefined,
          methodClass: reuse === 'method'
            ? 'black-box-boundary'
            : request.workItemId === 'independent-check-1'
              ? 'black-box-boundary' : 'independent-model',
          methodLabel: reuse === 'method' ? 'shared method' : request.workItemId,
        })
      },
      completeRetainedLease: () => {},
      resumeAdoptedLaunches: async () => ({}),
      resumeState: null,
    })

    assert.equal(outcome.outcome, 'DONE', `${reuse}: ${JSON.stringify(outcome)}`)
    assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS', reuse)
    assert.deepEqual(
      launches,
      ['work-1', 'independent-check-1', 'independent-check-2'],
      reuse,
    )
    assert.equal(launches.some(id => id.includes('scratch-confirmation')), false, reuse)
    assert.equal(launches.some(id => id.includes('runtime-retry')), false, reuse)
  }
})

test('single-seat provisional scratch PASS receives one bounded independent confirmation', async t => {
  const targetPath = cleanRepository(t)
  const launches = []
  let confirmationRequest = null
  const outcome = await createDefaultRouteExecutor(routeOptions(t, targetPath))({
    route: 'DIRECT',
    decision: directDecision(1),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      if (request.workItemId.includes('scratch-confirmation')) confirmationRequest = request
      return scratchResultForRequest(request, {
        label: request.workItemId,
        methodClass: request.workItemId.includes('scratch-confirmation')
          ? 'independent-model' : 'black-box-boundary',
      })
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
    'independent-check-1-scratch-confirmation-1',
  ])
  assert.equal(launches.some(id => id.includes('runtime-retry')), false)
  assert.match(confirmationRequest.assignment, /Act as a coverage critic/u)
  assert.match(confirmationRequest.assignment, /targeted missing-property, negative, separation, boundary, and composition probes/u)
  assert.match(confirmationRequest.assignment, /Do not duplicate the full-scale matrix/u)
  assert.match(confirmationRequest.assignment, /only when scale itself is the unverified property/u)
  assert.equal(confirmationRequest.fetchedEvidence.primaryScratchCoverage.checkerId,
    'independent-check-1')
  assert.match(confirmationRequest.fetchedEvidence.primaryScratchCoverage.resultHash,
    /^[a-f0-9]{64}$/u)
  assert.equal(
    confirmationRequest.fetchedEvidence.primaryScratchCoverage.testOutcomes.length,
    confirmationRequest.checks.length,
  )
  assert.equal(
    confirmationRequest.fetchedEvidence.primaryScratchCoverage.verificationAuthority.workItemId,
    'independent-check-1',
  )
})

test('malformed single-seat scratch confirmation returns the candidate without correction or retry', async t => {
  const targetPath = cleanRepository(t)
  const launches = []
  const outcome = await createDefaultRouteExecutor(routeOptions(t, targetPath))({
    route: 'DIRECT',
    decision: directDecision(1),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      if (request.workItemId.endsWith('-scratch-confirmation-1')) {
        return { schemaVersion: '2.0.0', code: 'MALFORMED_VERDICT', payload: {} }
      }
      return scratchResultForRequest(request, {
        label: request.workItemId,
        methodClass: 'black-box-boundary',
      })
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
    'independent-check-1-scratch-confirmation-1',
  ])
  assert.equal(launches.some(id => id.includes('runtime-retry')), false)
})

test('authenticated single-seat scratch confirmation FAIL routes through repair and fresh checking', async t => {
  const targetPath = cleanRepository(t)
  const launches = []
  const transitions = []
  const pointers = new Map()
  const outcome = await createDefaultRouteExecutor({
    ...routeOptions(t, targetPath, transitions),
    resultPointer: workItemId => pointers.get(workItemId) || null,
  })({
    route: 'DIRECT',
    decision: directDecision(1, 'mutate'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      if (request.workItemId === 'independent-check-1') {
        return scratchResultForRequest(request, {
          label: request.workItemId,
          methodClass: 'black-box-boundary',
        })
      }
      if (request.workItemId.endsWith('-scratch-confirmation-1')) {
        const failure = authenticatedScratchFailureForRequest(request, {
          label: request.workItemId,
          methodClass: 'independent-model',
        })
        pointers.set(request.workItemId, persistResultPointer(t, request.workItemId, failure))
        return failure
      }
      if (request.workItemId === 'work-1-repair-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'bounded evidence\nrepaired\n')
        return { allAssignedItemsPass: true }
      }
      assert.equal(request.workItemId, 'independent-check-1-repair-1')
      return directPassingCheckerResult(request)
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
    'independent-check-1-scratch-confirmation-1',
    'work-1-repair-1',
    'independent-check-1-repair-1',
  ])
  assert.equal(launches.some(id => id.includes('runtime-retry')), false)
  assert.equal(transitions.some(item => item.eventId === 'IMPLEMENTATION_DEFECT'), true)
  assert.equal(transitions.some(item => item.eventId === 'REPAIR_READY'), true)
})

test('complete receipts plus a malformed report become a controller-local limitation with no model retry', async t => {
  const targetPath = cleanRepository(t)
  const launches = []
  const transitions = []
  const pointers = new Map()
  const outcome = await createDefaultRouteExecutor({
    ...routeOptions(t, targetPath, transitions),
    resultPointer: workItemId => pointers.get(workItemId) || null,
  })({
    route: 'DIRECT',
    decision: directDecision(1, 'mutate'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'defective candidate\n')
        return structuredWorkerResult()
      }
      if (request.workItemId === 'independent-check-1') {
        const malformed = malformedReportWithCompleteReceipts(request)
        assert.ok(canonicalCheckerVerificationAuthority(malformed, request.checks))
        pointers.set(request.workItemId, persistResultPointer(t, request.workItemId, malformed))
        return malformed
      }
      assert.fail(`report shape must not launch ${request.workItemId}`)
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.equal(
    outcome.terminalEnvelope.limitations[0].verificationLimitation.capabilityId,
    'autoprompt.independent-check-report-shape',
  )
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
  ])
  assert.equal(transitions.some(item => [
    'CHECK_INCONCLUSIVE', 'IMPLEMENTATION_DEFECT', 'REPAIR_READY',
  ].includes(item.eventId)), false)
})

test('one malformed report never prevents a genuinely distinct configured checker seat', async t => {
  const targetPath = cleanRepository(t)
  const launches = []
  const pointers = new Map()
  const outcome = await createDefaultRouteExecutor({
    ...routeOptions(t, targetPath),
    resultPointer: workItemId => pointers.get(workItemId) || null,
  })({
    route: 'DIRECT',
    decision: directDecision(2, 'mutate'),
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'candidate requiring report repair\n')
        return structuredWorkerResult()
      }
      if (request.workItemId === 'independent-check-1') {
        const malformed = malformedReportWithCompleteReceipts(request)
        pointers.set(request.workItemId, persistResultPointer(t, request.workItemId, malformed))
        return malformed
      }
      assert.equal(request.workItemId, 'independent-check-2')
      return directPassingCheckerResult(request)
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
    'independent-check-2',
  ])
})

test('legacy crash resume retires an authenticated report-correction checkpoint locally', async t => {
  const targetPath = cleanRepository(t)
  const pointers = new Map()
  let baseResult = null
  let baseRequest = null
  const initial = await createDefaultRouteExecutor({
    ...routeOptions(t, targetPath),
    resultPointer: workItemId => pointers.get(workItemId) || null,
  })({
    route: 'DIRECT',
    decision: directDecision(1, 'mutate'),
    launch: async request => {
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'candidate before correction crash\n')
        return structuredWorkerResult()
      }
      baseRequest = request
      baseResult = JSON.parse(stableStringify(malformedReportWithCompleteReceipts(request)))
      pointers.set(request.workItemId, persistResultPointer(t, request.workItemId, baseResult))
      return baseResult
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })
  assert.equal(initial.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.ok(baseRequest)
  const checkerResultHash = digest(stableStringify(baseResult))
  const correctionBinding = {
    candidateHash: baseRequest.candidateHash,
    checkerSeat: 'independent-check-1',
  }
  const controllerReassessment = {
    code: 'CHECK_REPORT_INVALID',
    priorResultEvidenceHash: checkerResultHash,
    invalidFieldIds: ['code', 'payload'],
    checkIds: [...baseRequest.checks],
  }

  const launches = []
  const verified = []
  const transitions = []
  const outcome = await createDefaultRouteExecutor({
    ...routeOptions(t, targetPath, transitions),
    readResult: workItemId => workItemId === 'independent-check-1' ? baseResult : null,
    resultPointer: workItemId => pointers.get(workItemId) || null,
    verifyDurableResultReceipt: (workItemId, result) => {
      verified.push(workItemId)
      assert.equal(workItemId, 'independent-check-1')
      assert.deepEqual(result, baseResult)
      return true
    },
  })({
    route: 'DIRECT',
    decision: directDecision(1, 'mutate'),
    launch: async request => {
      launches.push(request.workItemId)
      assert.fail(`legacy report correction must not relaunch ${request.workItemId}`)
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE',
      candidateHash: baseRequest.candidateHash,
      completedWorkIds: ['work-1'],
      completedCheckIds: ['independent-check-1'],
      acceptedResultIds: [],
      nextReadyWorkIds: ['independent-check-1-runtime-retry-1'],
      retryState: {
        checkerReportCorrectionBindings: [correctionBinding],
        inconclusiveChecker: {
          checkerId: 'independent-check-1',
          candidateHash: baseRequest.candidateHash,
          checkerResultHash,
          retryAttempt: 1,
          returnState: 'CHECK_WORK',
          controllerReassessment,
        },
      },
    },
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches, [])
  assert.deepEqual(verified, ['independent-check-1'])
  assert.equal(transitions.some(item => item.eventId === 'CHECK_BECAME_CONCLUSIVE'), true)
})

test('crash after limitation conversion resumes from the durable raw checker receipt', async t => {
  const targetPath = cleanRepository(t)
  const pointers = new Map()
  const initialTransitions = []
  let checkerRequest = null
  let rawCheckerResult = null
  const initial = await createDefaultRouteExecutor({
    ...routeOptions(t, targetPath, initialTransitions),
    resultPointer: workItemId => pointers.get(workItemId) || null,
  })({
    route: 'DIRECT', decision: directDecision(1, 'mutate'),
    launch: async request => {
      if (request.workItemId === 'work-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'candidate before limitation crash\n')
        return structuredWorkerResult()
      }
      checkerRequest = request
      rawCheckerResult = JSON.parse(stableStringify({
        schemaVersion: '2.0.0', code: 'MALFORMED_CHECKER_VERDICT',
        candidateHash: request.candidateHash,
        currentVersionHash: request.candidateHash,
        contextId: 'context:limitation-crash', payload: {},
      }))
      pointers.set(request.workItemId,
        persistResultPointer(t, request.workItemId, rawCheckerResult))
      return rawCheckerResult
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: null,
  })
  assert.equal(initial.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  const marker = initialTransitions.find(item => item.eventId === 'CHECK_INCONCLUSIVE')
  assert.ok(marker, JSON.stringify(initialTransitions))
  assert.equal(marker.details.retryAttempt, 0)
  assert.equal(marker.details.checkerResultHash, digest(stableStringify(rawCheckerResult)))
  assert.equal(
    marker.details.controllerReassessment.priorResultEvidenceHash,
    marker.details.checkerResultHash,
  )
  assert.equal(initial.terminalEnvelope.sourceCheckerResultHash, marker.details.checkerResultHash)
  assert.notEqual(initial.terminalEnvelope.checkerResultHash, marker.details.checkerResultHash,
    'the converted limitation and durable source receipt have distinct identities')

  const resumedTransitions = []
  const verified = []
  const resumed = await createDefaultRouteExecutor({
    ...routeOptions(t, targetPath, resumedTransitions),
    readResult: workItemId => workItemId === checkerRequest.workItemId
      ? rawCheckerResult : null,
    resultPointer: workItemId => pointers.get(workItemId) || null,
    verifyDurableResultReceipt: (workItemId, result) => {
      verified.push(workItemId)
      assert.deepEqual(result, rawCheckerResult)
      return true
    },
  })({
    route: 'DIRECT', decision: directDecision(1, 'mutate'),
    launch: async request => assert.fail(`crash recovery must not relaunch ${request.workItemId}`),
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE',
      candidateHash: checkerRequest.candidateHash,
      completedWorkIds: ['work-1'],
      completedCheckIds: [checkerRequest.workItemId],
      acceptedResultIds: [], nextReadyWorkIds: [],
      retryState: {
        inconclusiveChecker: {
          checkerId: checkerRequest.workItemId,
          candidateHash: checkerRequest.candidateHash,
          checkerResultHash: marker.details.checkerResultHash,
          retryAttempt: 0,
          returnState: 'CHECK_WORK',
          controllerReassessment: marker.details.controllerReassessment,
        },
      },
    },
  })
  assert.equal(resumed.outcome, 'DONE', JSON.stringify(resumed))
  assert.equal(resumed.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(verified, [checkerRequest.workItemId])
  assert.equal(resumedTransitions.some(item => item.eventId === 'CHECK_BECAME_CONCLUSIVE'), true)
})

test('missing residual-risk authority preserves the checked candidate and structured response', async t => {
  for (const mode of ['absent', 'throws']) {
    await t.test(mode, async t => {
      const targetPath = cleanRepository(t)
      const options = routeOptions(t, targetPath)
      if (mode === 'throws') {
        options.authorizeResidualRisk = async () => {
          throw Object.assign(new Error('authority unavailable'), {
            code: 'RESIDUAL_RISK_AUTHORITY_REQUIRED',
          })
        }
      }
      const outcome = await createDefaultRouteExecutor(options)({
        route: 'DIRECT',
        decision: directDecision(1),
        launch: async request => {
          if (request.workItemId === 'work-1') return structuredWorkerResult()
          const passed = directPassingCheckerResult(request)
          return {
            ...passed,
            payload: {
              ...passed.payload,
              findings: [{
                id: 'ADVISORY-001', severity: 'P2', disposition: 'advisory', resolution: 'open',
              }],
            },
          }
        },
        completeRetainedLease: () => {},
        resumeAdoptedLaunches: async () => ({}),
        resumeState: null,
      })

      assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
      assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
      assert.equal(outcome.terminalEnvelope.controllerReason, 'RESIDUAL_RISK_AUTHORITY_REQUIRED')
      assert.equal(outcome.terminalEnvelope.usableCandidatePreserved, true)
      assert.ok(outcome.finalResponse)
      assert.equal(fs.existsSync(outcome.finalResponse.evidencePointer.path), true)
    })
  }
})
