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
  assertIndependentScratchPassConfirmations,
  checkerRecoveryNextReady,
  codexPhysicalExecutionReceipt,
  createDefaultRouteExecutor,
  createMinimalTestEnvironment,
  executeExistingTestBaseline,
  persistCapturedDomainAdmissionTransaction,
  promoteIndependentScratchPass,
  resolveTrustedTestDeclarations,
} = require('../../agents/codex/workflow/phase-budget.js')
const { BudgetController } = require('../../agents/codex/workflow/budget-controller.js')
const { EventLog, stableStringify } = require('../../agents/codex/workflow/event-log.js')
const { RuntimeStateStore } = require('../../agents/codex/workflow/runtime-state.js')
const runRecord = require('../../agents/codex/workflow/run-record.js')
const {
  CentralScheduler,
  resolveSchedulerSettings,
} = require('../../agents/codex/workflow/scheduler.js')
const {
  createRouteDecision,
  remainingL0DecisionBudgetMs,
} = require('../../agents/codex/workflow/route-decision.js')
const router = require('../../agents/codex/workflow/router.js')

const H = 'a'.repeat(64)

function digest(value) {
  return crypto.createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : String(value)).digest('hex')
}

function capturedDomainAdmissionFixture(t, failureBoundary = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-captured-admission-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runId = 'captured-admission-run'
  const event = {
    type: 'WORK_PREPARED',
    generation: 1,
    stateBefore: 'PREPARE_WORK',
    stateAfter: 'RUN_WORK',
    sequence: 1,
    details: {
      stateEvent: {
        runId,
        sequence: 1,
        fromState: 'PREPARE_WORK',
        toState: 'RUN_WORK',
      },
    },
  }
  event.hash = digest(JSON.stringify(event))
  const events = [event]
  const runtimeState = {
    runId,
    activation: { generation: 1 },
    state: 'RUN_WORK',
    sequence: 1,
    lastEventHash: event.hash,
  }
  let injected = false
  const injectAfter = boundary => {
    if (injected || failureBoundary !== boundary) return
    injected = true
    const error = new Error(`simulated crash after ${boundary}`)
    error.code = 'SIMULATED_CRASH'
    throw error
  }
  const record = {
    resolve(relative) { return path.join(root, ...relative.split('/')) },
    write(relative, bytes) {
      const target = this.resolve(relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bytes, { flag: 'wx' })
      injectAfter(relative.endsWith('-receipt.json') ? 'receipt' : 'admission')
    },
  }
  const stateStore = {
    eventLog: { readAll: () => events.map(event => structuredClone(event)) },
    load: () => structuredClone(runtimeState),
  }
  const admission = Object.freeze({
    schemaVersion: 1,
    route: 'DIRECT',
    requestEnvelopeHash: '1'.repeat(64),
    routeDecisionHash: '2'.repeat(64),
    targetStateHash: '3'.repeat(64),
    admittedBeforeWork: true,
    contracts: Object.freeze([]),
    admissionHash: '4'.repeat(64),
  })
  const input = {
    record,
    stateStore,
    capability: Object.freeze({ id: 'test-capability' }),
    runId,
    generation: 1,
    admission,
  }
  return { root, events, input }
}

function capturedDomainAdmissionRuntimeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-captured-admission-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  fs.mkdirSync(target)
  const record = runRecord.createRunRecord({
    targetPath: target,
    canonicalProviderPrivateRoot: path.join(root, 'private'),
    exactTree: true,
    runId: 'captured-admission-runtime-run',
    assertStartBoundary: false,
  })
  const binding = {
    runId: record.runId,
    requestEnvelopeHash: digest('captured-admission-request'),
    targetIdentity: record.targetIdentity,
    openedDirectoryIdentity: digest(JSON.stringify(record.runBinding)),
    digests: {
      contract: digest('contract'), prompt: digest('prompt'),
      provider: digest('provider'), tool: digest('tool'),
    },
  }
  const capability = Object.freeze({ type: 'captured-admission-runtime-capability' })
  const capabilityBinding = {
    runId: record.runId,
    activationId: 'captured-admission-activation',
    missionHash: digest('captured-admission-mission'),
    nonce: 'captured_nonce_123456789',
    generation: 1,
    targetIdentity: record.targetIdentity,
  }
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 7, 28, 0, 0, tick++)).toISOString()
  const openState = () => {
    const eventLog = new EventLog({ ...record.paths.eventLog, binding, clock })
    return {
      eventLog,
      stateStore: new RuntimeStateStore({
        ...record.paths.stateStore,
        eventLog,
        capabilityVerifier: candidate => candidate === capability ? capabilityBinding : null,
        clock,
      }),
    }
  }
  const opened = openState()
  opened.stateStore.create({
    ...binding,
    capability,
    activation: {
      id: capabilityBinding.activationId,
      nonce: capabilityBinding.nonce,
      missionHash: capabilityBinding.missionHash,
      sessionToken: 'captured-admission-session',
      generation: 1,
    },
  })
  for (const nextState of [
    'LOAD_SKILL', 'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'ACQUIRE_TARGET_LOCK',
    'SELECT_SAFE_RUN_ROOT', 'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES',
    'START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION', 'PREPARE_WORK',
    'RUN_WORK',
  ]) {
    opened.stateStore.transition(nextState, {
      capability,
      cause: 'advance real captured-domain admission fixture to RUN_WORK',
      ...(nextState === 'SAVE_ROUTE_ANALYSIS' ? { eventId: 'ROUTE_ANALYST_STARTED' } : {}),
    })
  }
  const admission = Object.freeze({
    schemaVersion: 1,
    route: 'DIRECT',
    requestEnvelopeHash: binding.requestEnvelopeHash,
    routeDecisionHash: digest('captured-admission-route-decision'),
    targetStateHash: digest('captured-admission-target-state'),
    admittedBeforeWork: true,
    contracts: Object.freeze([]),
    admissionHash: digest('captured-admission'),
  })
  return {
    admission,
    capability,
    generation: 1,
    openState,
    record,
    runId: record.runId,
    stateStore: opened.stateStore,
  }
}

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

function scratchReferenceMethod(label) {
  return {
    methodClass: 'black-box-boundary',
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
  candidateHash = digest('scratch-candidate'),
  requestEnvelopeHash = digest('scratch-request'),
  workItemId,
  oracleId,
  checks = ['focused scratch behavior'],
  label,
  evidenceId = `sha256:${digest(`evidence:${label}`)}`,
  programDigest = digest(`program:${label}`),
  programPathHash = digest(`program-path:${label}`),
  programIdentityHash = digest(`program-identity:${label}`),
}) {
  const contextId = `context:${label}`
  const authorityChecks = [...checks].sort().map(checkId => Object.freeze({
    authority: 'SCRATCH_HARNESS',
    checkId,
    commandHash: digest(`command:${label}:${checkId}`),
    harnessCommandHash: digest(`harness-command:${label}:${checkId}`),
    fingerprint: digest(`fingerprint:${label}:${checkId}`),
    observationHash: digest(`observation:${label}:${checkId}`),
    observationId: digest(`observation-id:${label}:${checkId}`),
    programBytes: Buffer.byteLength(`program:${label}`),
    programDigest,
    programPathHash,
    programIdentityHash,
  }))
  const authorityBody = Object.freeze({
    schemaVersion: 1,
    candidateHash,
    requestEnvelopeHash,
    assignmentId: `assignment:${label}`,
    workItemId,
    oracleId,
    contextId,
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
    contextId,
    cause: Object.freeze({
      event: 'CHECK_SCRATCH_CONFIRMATION_REQUIRED',
      reason: 'The independently authored scratch validator is provisional PASS evidence.',
      unblockPath: 'Join it with one disjoint controller-bound scratch PASS authority.',
    }),
    payload: Object.freeze({
      evidenceIds: Object.freeze([evidenceId]),
      referenceMethod: Object.freeze(scratchReferenceMethod(label)),
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

function structurallyUnboundPass(event = 'CHECK_OBSERVATION_INCOMPLETE') {
  return {
    code: 'CHECK_INCONCLUSIVE',
    cause: {
      event,
      reason: 'The reported PASS lacked controller-bound command observations.',
      unblockPath: 'Supply command-bound observations for every named check.',
    },
    payload: {
      verificationObservationDisposition: {
        reportedAggregateCode: 'PASS',
        missingCheckIds: ['Review the structured finding and its evidence receipt.'],
        conflictingCommandHashes: [],
      },
    },
  }
}

test('captured-domain admission resumes every pre-work crash window as one exact transaction', t => {
  for (const boundary of ['admission', 'receipt']) {
    const fixture = capturedDomainAdmissionFixture(t, boundary)
    assert.throws(
      () => persistCapturedDomainAdmissionTransaction(fixture.input),
      error => error.code === 'SIMULATED_CRASH',
      boundary,
    )
    const recovered = persistCapturedDomainAdmissionTransaction(fixture.input)
    const replayed = persistCapturedDomainAdmissionTransaction(fixture.input)
    assert.deepEqual(replayed, recovered, boundary)
    assert.match(recovered.receiptHash, /^[a-f0-9]{64}$/u, boundary)
    assert.match(recovered.stateEventHash, /^[a-f0-9]{64}$/u, boundary)
    assert.equal(fixture.events.length, 1, boundary)
    assert.equal(fixture.events[0].stateAfter, 'RUN_WORK', boundary)
    assert.equal(recovered.schemaVersion, 2, boundary)
    assert.equal(recovered.preWorkStateEventHash, fixture.events[0].hash, boundary)
    assert.equal(fs.existsSync(path.join(
      fixture.root, 'work', 'captured-domain-admission.json')),
    true, boundary)
    assert.equal(fs.existsSync(path.join(
      fixture.root, 'work', 'captured-domain-admission-receipt.json')),
    true, boundary)
  }
})

test('captured-domain admission recovery rejects rewritten bytes, receipts, and event anchors', t => {
  for (const corruption of ['admission-bytes', 'receipt', 'event-anchor']) {
    const fixture = capturedDomainAdmissionFixture(t)
    persistCapturedDomainAdmissionTransaction(fixture.input)
    if (corruption === 'admission-bytes') {
      const target = path.join(fixture.root, 'work', 'captured-domain-admission.json')
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
      fs.writeFileSync(target, `${JSON.stringify(parsed)}\n`)
    } else if (corruption === 'receipt') {
      const target = path.join(
        fixture.root, 'work', 'captured-domain-admission-receipt.json')
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
      parsed.receiptHash = 'f'.repeat(64)
      fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`)
    } else {
      fixture.events[0].hash = 'e'.repeat(64)
    }
    assert.throws(
      () => persistCapturedDomainAdmissionTransaction(fixture.input),
      error => error.code === 'CRASH_ADOPTION_CONFLICT',
      corruption,
    )
  }
})

test('captured-domain admission binds the existing RUN_WORK transition without mutating shared state', t => {
  const fixture = capturedDomainAdmissionRuntimeFixture(t)
  const input = {
    record: fixture.record,
    stateStore: fixture.stateStore,
    capability: fixture.capability,
    runId: fixture.runId,
    generation: fixture.generation,
    admission: fixture.admission,
  }
  const initialState = fixture.stateStore.load()
  const initialEvent = fixture.stateStore.eventLog.readAll().at(-1)
  const persisted = persistCapturedDomainAdmissionTransaction(input)
  const reopened = fixture.openState()
  assert.equal(reopened.stateStore.load().state, 'RUN_WORK')
  const replayed = persistCapturedDomainAdmissionTransaction({
    ...input,
    stateStore: reopened.stateStore,
  })

  assert.deepEqual(replayed, persisted)
  assert.equal(reopened.stateStore.load().sequence, initialState.sequence)
  assert.equal(persisted.preWorkState, 'RUN_WORK')
  assert.equal(persisted.preWorkStateEventHash, initialState.lastEventHash)
  assert.equal(persisted.preWorkStateEventSequence, initialState.sequence)
  const admissionEvents = reopened.eventLog.readAll().filter(event =>
    event.type === 'CAPTURED_DOMAIN_ADMISSION_RECORDED' && event.details &&
    event.details.recoveryKind === 'CAPTURED_DOMAIN_ADMISSION_RECORDED')
  assert.equal(admissionEvents.length, 0)
  assert.equal(reopened.eventLog.readAll().at(-1).hash, initialEvent.hash)
  assert.equal(reopened.eventLog.readAll().at(-1).details.stateEvent.toState, 'RUN_WORK')
})

test('structurally unbound or inconclusive evidence has no retry frontier while FAIL keeps repair authority', () => {
  const recovery = {
    nonAuthoritativeRetryId: 'independent-check-1-runtime-retry-1',
    failureRepairId: 'work-1-repair-1',
    stableLimitationNextReadyId: 'independent-check-2',
  }
  for (const event of [
    'CHECK_OBSERVATION_INCOMPLETE',
    'CHECK_OBSERVATION_CONTRADICTION',
  ]) {
    assert.deepEqual(
      checkerRecoveryNextReady('independent-check-1', structurallyUnboundPass(event), recovery),
      ['independent-check-2'],
      event,
    )
  }
  assert.deepEqual(checkerRecoveryNextReady(
    'independent-check-1',
    structurallyUnboundPass(),
    { ...recovery, nonAuthoritativeRetryId: null },
  ), ['independent-check-2'])
  assert.deepEqual(checkerRecoveryNextReady(
    'independent-check-1',
    structurallyUnboundPass(),
    { ...recovery, nonAuthoritativeRetryId: null, stableLimitationNextReadyId: null },
  ), [])
  assert.deepEqual(checkerRecoveryNextReady('independent-check-1', {
    ...structurallyUnboundPass(),
    payload: {
      verificationObservationDisposition: { reportedAggregateCode: 'FAIL' },
    },
  }, recovery), ['independent-check-2'])
  assert.deepEqual(checkerRecoveryNextReady('independent-check-1', {
    code: 'FAIL', cause: { event: 'ASSERTION_FAILED' },
  }, recovery), ['work-1-repair-1'])
})

test('same-class scratch PASS authorities pair only when their full methods and evidence are independent', () => {
  const common = {
    candidateHash: digest('same frozen candidate'),
    requestEnvelopeHash: digest('same request envelope'),
    checks: ['Exercise the frozen boundary with an independent oracle.'],
  }
  const primary = scratchPassResult({
    ...common,
    workItemId: 'independent-check-1',
    oracleId: 'primary-boundary-oracle',
    label: 'primary corpus',
  })
  const confirmation = scratchPassResult({
    ...common,
    workItemId: 'independent-check-1-scratch-confirmation-1',
    oracleId: 'confirmation-boundary-oracle',
    label: 'confirmation corpus',
  })

  assert.equal(primary.payload.referenceMethod.methodClass, 'black-box-boundary')
  assert.equal(confirmation.payload.referenceMethod.methodClass, 'black-box-boundary')
  assert.notDeepEqual(primary.payload.referenceMethod, confirmation.payload.referenceMethod)
  for (const field of [
    'assignmentId', 'workItemId', 'oracleId', 'contextId', 'bindingHash',
    'observationEvidenceHash', 'scratchBoundaryHash', 'frozenCandidateRootPathHash',
    'writableScratchRootPathHash',
  ]) {
    assert.notEqual(
      primary.payload.verificationAuthority[field],
      confirmation.payload.verificationAuthority[field],
      field,
    )
  }
  for (const field of ['programDigest', 'programPathHash', 'programIdentityHash']) {
    assert.notEqual(
      primary.payload.verificationAuthority.checks[0][field],
      confirmation.payload.verificationAuthority.checks[0][field],
      field,
    )
  }

  const join = assertIndependentScratchPassConfirmations(primary, confirmation, common)
  assert.equal(join.kind, 'scratch-pass-confirmation-join')
  assert.match(join.joinHash, /^[a-f0-9]{64}$/u)
  const promoted = promoteIndependentScratchPass(primary, confirmation, common)
  assert.equal(promoted.code, 'PASS')
  assert.equal(promoted.cause, null)
  assert.equal(promoted.payload.verificationScratchConfirmation.joinHash, join.joinHash)

  const reusedProgram = scratchPassResult({
    ...common,
    workItemId: 'independent-check-1-scratch-confirmation-1',
    oracleId: 'replacement-program-oracle',
    label: 'replacement program corpus',
    programDigest: primary.payload.verificationAuthority.checks[0].programDigest,
  })
  assert.throws(
    () => promoteIndependentScratchPass(primary, reusedProgram, common),
    error => error.code === 'SCRATCH_PASS_CONFIRMATION_NOT_INDEPENDENT' &&
      error.details.field === 'programDigest',
  )

  const reusedEvidence = scratchPassResult({
    ...common,
    workItemId: 'independent-check-1-scratch-confirmation-1',
    oracleId: 'replacement-evidence-oracle',
    label: 'replacement evidence corpus',
    evidenceId: primary.payload.evidenceIds[0],
  })
  assert.throws(
    () => promoteIndependentScratchPass(primary, reusedEvidence, common),
    error => error.code === 'SCRATCH_PASS_CONFIRMATION_NOT_INDEPENDENT' &&
      /disjoint underlying evidence/u.test(error.message),
  )
})

test('invalid checker report returns the candidate without consuming correction or repair launches', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate', 1, 1)
  const topology = codexPhysicalExecutionReceipt(decision)
  const economicTarget = new BudgetController({
    limits: { wallMs: 10_000, tokens: 10, sessions: 1, launches: 1 },
    phases: {},
  })
  const schedulerRun = { runId: 'scratch-topology-run', generation: 1 }
  const issuerCapability = Object.freeze({})
  const scheduler = new CentralScheduler({
    route: 'DIRECT',
    runIdentity: schedulerRun,
    requiredCompletionIssuerCapability: issuerCapability,
    settings: resolveSchedulerSettings({
      route: 'DIRECT', requiredChildLaunches: topology.requiredChildLaunches,
    }),
  })
  let schedulerSession = 0
  const admitRequiredLaunch = async workItemId => {
    const schedulerRequest = {
      workItemId,
      equivalenceKey: `physical:${workItemId}`,
      role: 'ap-worker',
      purpose: 'work',
      lane: 'main',
    }
    const requiredCompletionBinding =
      scheduler.issueRequiredCompletionBinding(schedulerRequest, issuerCapability)
    schedulerSession += 1
    const authority = scheduler.issueLaunchAuthority({
      callerRole: 'ap-root',
      sessionId: `scratch-topology-session-${schedulerSession}`,
      ...schedulerRun,
      parentLease: null,
      providerCapabilities: {
        eventStreaming: true,
        toolOutputCapture: true,
        stableChildIdentity: true,
        sameContextContinuation: true,
        isolatedChecking: true,
        cancellation: true,
      },
      requiredCompletionBinding,
    })
    const lease = await scheduler.acquireWithAuthority(authority, {
      ...schedulerRequest,
      requiredCompletionBinding,
    })
    economicTarget.recordLaunch(scheduler.authorizeRequiredCompletionAccounting(lease))
    lease.complete({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
  }
  await admitRequiredLaunch('route-analyst')

  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-scratch-topology-'))
  t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
  const receiptPointers = new Map()
  const persistResult = (workItemId, result) => {
    const target = path.join(receiptRoot, `${workItemId}.json`)
    const bytes = Buffer.from(`${JSON.stringify(result)}\n`)
    fs.writeFileSync(target, bytes)
    receiptPointers.set(workItemId, {
      name: workItemId,
      path: target,
      hash: digest(bytes),
      bytes: bytes.length,
    })
    return result
  }
  const concreteFailure = {
    schemaVersion: '2.0.0',
    code: 'FAIL',
    cause: {
      event: 'ASSERTION_FAILED',
      reason: 'The scratch confirmation found the requested edit was absent.',
      unblockPath: 'Repair the product, then run a fresh checker and scratch confirmation.',
    },
    payload: { findingIds: ['SCRATCH-CONFIRMATION-DEFECT'] },
  }
  const launches = []
  const transitions = []
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (eventId, nextState, details) => {
      transitions.push({ eventId, nextState, details })
    },
    resultPointer: workItemId => receiptPointers.get(workItemId),
    harnessAttestation: (candidateHash, oracle) => ({
      repoHash: candidateHash,
      buildHash: digest(`build:${candidateHash}`),
      oracleHash: digest(`oracle:${oracle}`),
    }),
    persistStructuredFinalResponse: structuredResponsePersistence(t),
  })({
    route: 'DIRECT',
    decision,
    launch: async request => {
      launches.push(request.workItemId)
      await admitRequiredLaunch(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      if (request.workItemId === 'independent-check-1') {
        return { schemaVersion: '2.0.0', code: 'MALFORMED_VERDICT', payload: {} }
      }
      if (request.workItemId === 'independent-check-1-runtime-retry-1') {
        assert.equal(request.recoveryContext.code, 'CHECK_REPORT_INVALID')
        return scratchPassResult({
          candidateHash: request.candidateHash,
          requestEnvelopeHash: decision.requestEnvelopeHash,
          workItemId: request.workItemId,
          oracleId: request.oracle,
          checks: request.checks,
          label: 'corrected primary scratch pass',
        })
      }
      if (request.workItemId === 'independent-check-1-scratch-confirmation-1') {
        return persistResult(request.workItemId, concreteFailure)
      }
      if (request.workItemId === 'work-1-repair-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'bounded evidence\nrepaired after scratch confirmation\n')
        return { allAssignedItemsPass: true }
      }
      if (request.workItemId === 'independent-check-1-repair-1') {
        return scratchPassResult({
          candidateHash: request.candidateHash,
          requestEnvelopeHash: decision.requestEnvelopeHash,
          workItemId: request.workItemId,
          oracleId: request.oracle,
          checks: request.checks,
          label: 'repaired primary scratch pass',
        })
      }
      assert.equal(request.workItemId,
        'independent-check-1-repair-1-scratch-confirmation-1')
      return scratchPassResult({
        candidateHash: request.candidateHash,
        requestEnvelopeHash: decision.requestEnvelopeHash,
        workItemId: request.workItemId,
        oracleId: request.oracle,
        checks: request.checks,
        label: 'repaired independent scratch confirmation',
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
  ])
  assert.equal(transitions.some(item => item.eventId === 'CHECK_INCONCLUSIVE'), true)
  assert.equal(transitions.some(item => item.eventId === 'IMPLEMENTATION_DEFECT'), false)
  assert.equal(transitions.some(item => item.eventId === 'REPAIR_READY'), false)
  assert.equal(economicTarget.snapshot().launches,
    topology.analystLaunches + launches.length)
  assert.equal(topology.requiredChildLaunches, 9,
    'the frozen bounded contingency graph remains the economic target')
  const schedulerMetrics = scheduler.getMetrics()
  assert.equal(schedulerMetrics.counters.totalLaunches, 3)
  assert.equal(schedulerMetrics.counters.requiredCompletionLaunches, 3)
  assert.equal(schedulerMetrics.counters.requiredCompletionLaunchOverruns, 0)
  assert.equal(schedulerMetrics.lanes.main.requiredCompletionLaunches, 3)
  assert.equal(schedulerMetrics.lanes.main.requiredCompletionLaunchOverruns, 0)
  assert.throws(() => economicTarget.recordLaunch(), error => error.code === 'BUDGET_EXHAUSTED')
})

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

test('structurally unbound checker evidence reaches every distinct seat before returning the candidate', async t => {
  for (const event of [
    'CHECK_OBSERVATION_INCOMPLETE',
    'CHECK_OBSERVATION_CONTRADICTION',
  ]) {
    for (const checkerCount of [1, 2]) {
      const targetPath = cleanRepository(t)
      const launches = []
      const transitions = []
      const outcome = await createDefaultRouteExecutor({
        targetPath,
        gitEnvironment: () => process.env,
        transition: async (eventId, nextState, details) => {
          transitions.push({ eventId, nextState, details })
        },
        harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
        persistStructuredFinalResponse: structuredResponsePersistence(t),
      })({
        route: 'DIRECT', decision: readOnlyDecision('inspect', 1, checkerCount),
        launch: async request => {
          launches.push(request.workItemId)
          if (request.workItemId === 'work-1') return structuredWorkerResult()
          return structurallyUnboundPass(event)
        },
        completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
      })

      assert.equal(outcome.outcome, 'DONE', `${event}/C${checkerCount}`)
      assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS', event)
      assert.deepEqual(launches, [
        'work-1',
        'independent-check-1',
        ...(checkerCount === 2 ? ['independent-check-2'] : []),
      ], event)
      assert.equal(transitions.some(item => item.eventId === 'IMPLEMENTATION_DEFECT'), false, event)
      const inconclusive = transitions.filter(item => item.eventId === 'CHECK_INCONCLUSIVE')
      assert.equal(inconclusive.length, 1, event)
      assert.deepEqual(inconclusive[0].details.nextReadyWorkIds, [], event)
      assert.equal(inconclusive.every(item =>
        item.details.controllerReassessment.code === event), true, event)
      assert.equal(transitions.some(item => item.eventId === 'CHECK_BECAME_CONCLUSIVE'), true, event)
      assert.equal(transitions.some(item => item.eventId === 'ACCEPTANCE_GREEN'), true, event)
      assert.equal(outcome.checkHashes.length, 1, event)
    }
  }
})

test('an unbound first checker yields to a distinct authenticated checker and product repair', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate', 1, 2)
  const failure = {
    code: 'FAIL',
    cause: {
      event: 'ASSERTION_FAILED',
      reason: 'The distinct black-box checker reproduced a concrete product defect.',
      unblockPath: 'Repair the product and re-run both independent seats.',
    },
    payload: { findingIds: ['DISTINCT-CHECKER-DEFECT'] },
  }
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-distinct-fail-'))
  t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
  const receiptPath = path.join(receiptRoot, 'independent-check-2.json')
  const receiptBytes = Buffer.from(`${JSON.stringify(failure)}\n`)
  fs.writeFileSync(receiptPath, receiptBytes)
  const failurePointer = {
    name: 'independent-check-2', path: receiptPath,
    hash: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
    bytes: receiptBytes.length,
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    resultPointer: workItemId => workItemId === 'independent-check-2' ? failurePointer : null,
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse: structuredResponsePersistence(t),
  })({
    route: 'DIRECT', decision,
    launch: async request => {
      launches.push(request.workItemId)
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      if (request.workItemId === 'independent-check-1') return structurallyUnboundPass()
      if (request.workItemId === 'independent-check-1-runtime-retry-1') {
        assert.equal(request.forkTurns, 'none')
        assert.equal(request.recoveryContext, undefined)
        return structurallyUnboundPass()
      }
      if (request.workItemId === 'independent-check-2') return failure
      if (request.workItemId === 'work-1-repair-1') {
        fs.writeFileSync(path.join(targetPath, 'subject.txt'), 'bounded evidence\nrepaired\n')
        return { allAssignedItemsPass: true }
      }
      return passingCheckerResult(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, [
    'work-1',
    'independent-check-1',
    'independent-check-2',
    'work-1-repair-1',
    'independent-check-1-repair-1',
    'independent-check-2-repair-1',
  ])
  assert.equal(launches.filter(id => id.includes('runtime-retry')).length, 0)
})

test('an unbound aggregate PASS yields to a distinct authenticated PASS with an explicit limitation', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('inspect', 1, 2)
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
      if (request.workItemId === 'work-1') return structuredWorkerResult()
      if (request.workItemId === 'independent-check-1') {
        return structurallyUnboundPass('CHECK_OBSERVATION_CONTRADICTION')
      }
      assert.equal(request.workItemId, 'independent-check-2')
      return passingCheckerResult(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })

  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches, ['work-1', 'independent-check-1', 'independent-check-2'])
})

test('resume retires a durable f1de11a same-seat retry and still runs a distinct checker', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('inspect', 1, 2)
  const workerResult = structuredWorkerResult()
  const persistStructuredFinalResponse = structuredResponsePersistence(t)
  let freezeDetails
  await assert.rejects(createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async (eventId, _nextState, details) => {
      if (eventId === 'ALL_WORK_JOINED') {
        freezeDetails = details
        throw Object.assign(new Error('crash before checker launch'), {
          code: 'CRASH_BEFORE_CHECKER',
        })
      }
    },
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse,
  })({
    route: 'DIRECT', decision,
    launch: async () => workerResult,
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  }), error => error.code === 'CRASH_BEFORE_CHECKER')

  const checkerResult = structurallyUnboundPass('CHECK_OBSERVATION_CONTRADICTION')
  const checkerResultHash = crypto.createHash('sha256')
    .update(JSON.stringify(checkerResult)).digest('hex')
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-unbound-pass-resume-'))
  t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
  const receiptPath = path.join(receiptRoot, 'independent-check-1.json')
  const receiptBytes = Buffer.from(`${JSON.stringify(checkerResult)}\n`)
  fs.writeFileSync(receiptPath, receiptBytes)
  const checkerPointer = {
    name: 'independent-check-1', path: receiptPath,
    hash: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
    bytes: receiptBytes.length,
  }
  const launches = []
  const outcome = await createDefaultRouteExecutor({
    targetPath,
    gitEnvironment: () => process.env,
    transition: async () => {},
    readResult: workItemId => workItemId === 'work-1' ? workerResult
      : workItemId === 'independent-check-1' ? checkerResult : null,
    resultPointer: workItemId => workItemId === 'independent-check-1' ? checkerPointer : null,
    verifyDurableResultReceipt: () => {},
    harnessAttestation: () => ({ repoHash: H, buildHash: H, oracleHash: H }),
    persistStructuredFinalResponse,
  })({
    route: 'DIRECT', decision,
    launch: async request => {
      launches.push(request.workItemId)
      assert.equal(request.workItemId, 'independent-check-2')
      return passingCheckerResult(request)
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}),
    resumeState: {
      resumeState: 'CHECK_INCONCLUSIVE',
      candidateHash: freezeDetails.candidateHash,
      completedWorkIds: ['work-1'], completedCheckIds: [], acceptedResultIds: [],
      // This is the obsolete full-checker retry frontier emitted by f1de11a.
      nextReadyWorkIds: ['independent-check-1-runtime-retry-1'],
      retryState: {
        inconclusiveChecker: {
          checkerId: 'independent-check-1',
          candidateHash: freezeDetails.candidateHash,
          checkerResultHash,
          retryAttempt: 1,
          returnState: 'CHECK_WORK',
          controllerReassessment: {
            code: 'CHECK_OBSERVATION_CONTRADICTION',
            priorResultEvidenceHash: checkerResultHash,
          },
        },
      },
    },
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
  assert.deepEqual(launches, ['independent-check-2'])
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

test('W2/W3 malformed checker output exhausts distinct seats without correction or repair', async t => {
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
      assert.equal(outcome.terminalEnvelope.status, 'DONE_WITH_VERIFICATION_LIMITATIONS')
      assert.deepEqual(launches, [
        ...Array.from({ length: workerCount }, (_, index) => `work-${index + 1}`),
        'independent-check-1',
        ...(checkerCount === 2 ? ['independent-check-2'] : []),
      ])
      assert.equal(launches.filter(id => id.includes('runtime-retry')).length, 0)
      assert.equal(launches.filter(id => id === 'work-1-repair-1').length, 0)
      assert.equal(transitions.some(item => item.eventId === 'CHECK_INCONCLUSIVE'), true)
      assert.equal(transitions.some(item => item.eventId === 'CHECK_BECAME_CONCLUSIVE'), true)
      assert.equal(transitions.some(item => item.eventId === 'ACCEPTANCE_GREEN'), true)
      assert.equal(transitions.some(item => item.eventId === 'IMPLEMENTATION_DEFECT'), false)
      assert.equal(transitions.some(item => item.eventId === 'REPAIR_READY'), false)
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

test('a fresh checker FAIL gets one aggregate repair and then returns the concrete product failure', async t => {
  const targetPath = cleanRepository(t)
  const decision = readOnlyDecision('mutate', 2)
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-response-one-repair-'))
  t.after(() => fs.rmSync(receiptRoot, { recursive: true, force: true }))
  const receiptPointers = new Map()
  const launches = []
  const failureFor = request => ({
    code: 'FAIL',
    cause: {
      event: 'ASSERTION_FAILED', reason: `defect from ${request.workItemId}`,
      unblockPath: 'Repair the requested implementation.',
    },
    payload: {
      findingIds: [`DEFECT-${request.workItemId}`],
      testOutcomes: (request.checks || []).map(command => ({
        command,
        status: 'FAIL',
        fingerprint: crypto.createHash('sha256')
          .update(`failure:${request.workItemId}:${command}`).digest('hex'),
        observationId: crypto.createHash('sha256')
          .update(`observation:${request.candidateHash}:${command}`).digest('hex'),
        commandHash: crypto.createHash('sha256')
          .update(`command:${request.workItemId}:${command}`).digest('hex'),
        failureIdentity: crypto.createHash('sha256')
          .update(`failure-identity:${request.workItemId}:${command}`).digest('hex'),
      })),
    },
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
      if (request.workItemId === 'work-1-repair-2') {
        return { allAssignedItemsPass: true }
      }
      return persistReceipt(request.workItemId, failureFor(request))
    },
    completeRetainedLease: () => {}, resumeAdoptedLaunches: async () => ({}), resumeState: null,
  })
  assert.equal(outcome.outcome, 'FAILED', JSON.stringify(outcome))
  assert.equal(outcome.terminalEnvelope.cause.reason,
    'defect from independent-check-1-repair-1')
  assert.equal(outcome.deliverables.some(deliverable =>
    deliverable.path === path.join(targetPath, 'subject.txt')), true,
  'the concrete model/product failure cannot make its usable candidate disappear')
  assert.deepEqual(launches, [
    'work-1', 'work-2', 'independent-check-1',
    'work-1-repair-1', 'independent-check-1-repair-1',
  ])
  assert.equal(launches.filter(id => id === 'work-1-repair-1').length, 1)
  assert.equal(launches.filter(id => id === 'work-1-repair-2').length, 0)
  assert.equal(fs.readFileSync(path.join(targetPath, 'subject.txt'), 'utf8'),
    'bounded evidence\none repair\n')
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
