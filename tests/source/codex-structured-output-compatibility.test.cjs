#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  CodexExecAdapter,
  admitRoadmapExpansion,
  assignmentLocalFindingId,
  bindCanonicalMissionForChild,
  canonicalAssignmentResources,
  createCodexJsonlAccumulator,
  createCheckerObservationBinding,
  createCanonicalMissionProjection,
  createCheckerScratchFactory,
  validateCheckerScratchDirectories,
  decisionReadOnlyOwnership,
  executionMutableResourceOwnership,
  decodeCodexProviderEnvelope,
  materializeCodexProviderEnvelopeSchema,
  modelVisibleDispatch,
  parseCodexJsonl,
  productionTransportWatchdogMs,
  imageDatumOutcomeFromPreWorkAdmission,
  readPrivateAgentAssignment,
  readPersistedWorkerAssignment,
  resolvePreMutationRouteDecisionHash,
  runtimeCapabilityExpiryMs,
} = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js'))
const { stableStringify } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'event-log.js'))
const { CleanupRegistry } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'finalizer.js'))
const { validateJsonSchema } = require(
  path.join(ROOT, 'agents', 'codex', 'workflow', 'json-schema-validator.js'),
)
const {
  compileAutomaticRouteDecision,
  createRouteDecision,
  createRouteRecommendation,
  remainingL0DecisionBudgetMs,
} = require(
  path.join(ROOT, 'agents', 'codex', 'workflow', 'route-decision.js'),
)
const routeRouter = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'router.js'))
const {
  CONTEXT_ROUTE_CAPS,
  auditDispatch,
  buildCheckerContext,
  buildContextFreeBrief,
  writeRequestEnvelope,
} = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'context-envelope.js'))

const EXECUTION_POLICY = Object.freeze({
  logicalRole: 'worker',
  physicalRole: 'autoprompt.v2.worker',
  providerRole: 'ap-worker',
  sandboxMode: 'workspace-write',
  policyId: 'autoprompt.codex.role-policy',
  policyVersion: '2.0.0',
})
function adapterMissionFields(requestEnvelopeHash = 'hash', workItemId = 'adapter-work') {
  const activationId = 'adapter-activation'
  const generation = 1
  const projection = createCanonicalMissionProjection('Complete the bounded adapter request.')
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
const CHECKER_EXECUTION_POLICY = Object.freeze({
  logicalRole: 'independent-reviewer',
  physicalRole: 'autoprompt.v2.independent-reviewer',
  providerRole: 'ap-independent-checker',
  sandboxMode: 'read-only',
  canDispatch: false,
  resourceSets: Object.freeze({ read: Object.freeze(['target.snapshot.read']), write: Object.freeze([]), exclusive: Object.freeze([]) }),
  policyId: 'autoprompt.codex.role-policy',
  policyVersion: '2.0.0',
})

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-schema-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

const PROVIDER_CAPABILITIES = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})

function canonicalOutcome(code, overrides = {}) {
  const descriptions = {
    PASS: 'The checked result satisfies every requirement assigned to this check.',
    FAIL: 'The checked result does not satisfy one or more named requirements.',
    CHECK_INCONCLUSIVE: 'A required check could not determine whether the exact result passes.',
    RUNTIME_FAILURE: 'A tool or execution environment failed before the requested check could finish.',
  }
  return {
    schemaVersion: '2.0.0', code, description: descriptions[code],
    stateClass: code === 'CHECK_INCONCLUSIVE' ? 'intermediate' : 'terminal',
    runId: 'run-canonical', requestEnvelopeHash: 'a'.repeat(64),
    currentVersionHash: 'b'.repeat(64), completedResults: [], nextReadyWork: [],
    cause: { event: 'CHECK_COMPLETED', reason: 'Canonical checker fixture.', unblockPath: null },
    payloadSchemaId: 'autoprompt.test.v2', payload: {}, recordedAt: '2026-08-25T12:00:00.000Z',
    ...overrides,
  }
}

function canonicalWorkerResult(overrides = {}) {
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: 'result-1',
    runId: 'run-worker', assignmentId: 'work-1', logicalRoleId: 'worker',
    physicalRoleId: 'autoprompt.v2.worker', requestEnvelopeHash: 'a'.repeat(64),
    findingIds: ['AP-RUN-026'], startedAt: '2026-08-25T12:00:00.000Z',
    endedAt: '2026-08-25T12:00:01.000Z', filesChanged: [], resourcesChanged: [],
    behaviorChanged: ['Completed the bounded fixture.'],
    commands: [{ command: 'true', exitCode: 0, result: 'passed' }],
    successItems: [{ id: 'fixture', status: 'pass', evidenceIds: ['command:true'] }],
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: { event: 'WORK_ITEM_VERIFIED', reason: 'Fixture passed.', invalidateEvidenceIds: [] },
    ...overrides,
  }
}

function canonicalDirectRouteDecision() {
  const requestEnvelopeHash = 'a'.repeat(64)
  const recommendationHash = 'b'.repeat(64)
  const facts = routeRouter.normalizeFacts({
    schemaVersion: '2.0.0', requestedEffect: 'inspect', successCriteria: 'ready',
    dependency: {
      shape: 'bounded', dependentWorkGroupCount: 0,
      integrationOwnerRequired: false, separateDependentBodies: 0,
    },
    uncertainty: 'none', reversibility: 'fully-reversible', mutableResources: [],
    sideEffects: [], externality: 'local-only', confidentiality: 'internal', thirdPartyImpact: 'none',
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
  const classified = routeRouter.classifyRoute(facts)
  return createRouteDecision({
    route: 'DIRECT', routeFacts: facts,
    requestedResult: 'Inspect the bounded target and report the result.',
    successChecklist: ['The report is backed by an observable receipt.'],
    checks: ['Review the structured report and its evidence receipt.'],
    likelyAreas: ['/app'], risks: [], missingInformation: [],
    workers: {
      count: 1, responsibilities: ['Inspect the bounded target and return a structured result.'],
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
    requestEnvelopeHash, recommendationHash,
    gateSelection: {
      baseWorkType: 'inspect-report', resultFormat: 'read-only-findings',
      artifactOverlays: ['read-only-result'], acceptanceOverlays: ['receipts'],
      riskOverlays: [], riskEvidence: {},
    },
  })
}

test('oversized auxiliary brief fields are sliced losslessly into fetched evidence', t => {
  const directory = temporaryDirectory(t)
  const pointer = writeRequestEnvelope(directory, 'exact benchmark request')
  const successChecklist = Array.from({ length: 7 }, (_, index) => `success-${index}-${'s'.repeat(300)}`)
  const checks = [`check-${'c'.repeat(300)}`]
  const ownership = [{ kind: 'output', identity: '/app/schedule.json', owner: 'worker-1' }]
  const dependencies = ['route decision', 'input dataset']
  const returnShape = { required: ['allAssignedItemsPass', 'successItems'] }
  const fetchedEvidence = { existingPointer: { hash: 'a'.repeat(64) } }
  const dispatch = buildContextFreeBrief({
    role: 'ap-worker',
    assignment: 'Implement the assigned production-planning work item.',
    successChecklist,
    ownership,
    checks,
    dependencies,
    returnShape,
    fetchedEvidence,
    requestPointer: pointer,
    providerCapabilities: PROVIDER_CAPABILITIES,
    route: 'ROADMAP',
  })

  assert.ok(dispatch.briefBytes <= CONTEXT_ROUTE_CAPS.ROADMAP.briefBytes)
  assert.match(dispatch.brief, /fetchedEvidence\.briefSlice/)
  assert.equal(dispatch.brief.includes(successChecklist[0]), false)
  assert.deepEqual(dispatch.fetchedEvidence.existingPointer, fetchedEvidence.existingPointer)
  assert.deepEqual(dispatch.fetchedEvidence.briefSlice, {
    schemaVersion: 1,
    kind: 'context-brief-slice',
    fields: {
      assignment: 'Implement the assigned production-planning work item.',
      successChecklist, ownership, checks, dependencies, returnShape,
    },
  })
})

test('L4 verifies exact request controller-side but emits only its immutable binding to the model', t => {
  const directory = temporaryDirectory(t)
  const exactRequest = `L4_MODEL_OMISSION_SENTINEL_${'z'.repeat(32 * 1024)}`
  const pointer = writeRequestEnvelope(directory, exactRequest)
  const dispatch = buildCheckerContext({
    role: 'ap-independent-checker',
    route: 'DIRECT',
    assignment: 'Independently check the separately supplied canonical mission.',
    requestPointer: pointer,
    expectedRequestHash: pointer.hash,
    candidateHash: 'b'.repeat(64),
    providerCapabilities: PROVIDER_CAPABILITIES,
  })

  assert.equal(auditDispatch(dispatch).conformant, true)
  assert.equal(dispatch.exactRequest, exactRequest)
  const visible = modelVisibleDispatch(dispatch, { canonicalAssignment: true })
  assert.equal(Object.hasOwn(visible, 'exactRequest'), false)
  assert.deepEqual(visible.exactRequestControllerBinding, {
    controllerVerified: true,
    sha256: pointer.hash,
    bytes: Buffer.byteLength(exactRequest, 'utf8'),
  })
  assert.equal(JSON.stringify(visible).includes(exactRequest), false)

  fs.appendFileSync(pointer.path, '\ntampered after controller binding')
  assert.throws(
    () => buildCheckerContext({
      role: 'ap-independent-checker',
      route: 'DIRECT',
      assignment: 'Independently check the separately supplied canonical mission.',
      requestPointer: pointer,
      expectedRequestHash: pointer.hash,
      candidateHash: 'b'.repeat(64),
      providerCapabilities: PROVIDER_CAPABILITIES,
    }),
    error => error.code === 'REQUEST_HASH_MISMATCH',
  )
})

test('Codex provider envelope is a private supported root object', t => {
  const root = path.join(temporaryDirectory(t), 'provider-schemas')
  const filename = materializeCodexProviderEnvelopeSchema(root)
  const schema = JSON.parse(fs.readFileSync(filename, 'utf8'))
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      canonicalJson: {
        type: 'string',
        description: 'JSON-serialized canonical AutoPrompt output. The runtime decodes and validates it against the original role schema.',
      },
    },
    required: ['canonicalJson'],
    additionalProperties: false,
  })
  assert.equal(fs.statSync(root).mode & 0o777, 0o700)
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
  assert.equal(materializeCodexProviderEnvelopeSchema(root), filename)
})

test('Codex provider envelope decodes one canonical object and rejects transport ambiguity', () => {
  assert.deepEqual(
    decodeCodexProviderEnvelope({ canonicalJson: '{"schemaVersion":"2.0.0","code":"DONE"}' }),
    { schemaVersion: '2.0.0', code: 'DONE' },
  )
  assert.throws(
    () => decodeCodexProviderEnvelope({ canonicalJson: '[]' }),
    error => error.code === 'CODEX_OUTPUT_TRANSPORT_INVALID',
  )
  assert.throws(
    () => decodeCodexProviderEnvelope({ canonicalJson: '{}', extra: true }),
    error => error.code === 'CODEX_OUTPUT_TRANSPORT_INVALID',
  )
})

test('Codex checker setup failures remain audit evidence and never become product FAIL', async () => {
  const cases = [
    {
      name: 'exit-127',
      command: '/usr/bin/time python3 checker.py',
      status: 'completed', exit_code: 127,
      aggregated_output: 'env: /usr/bin/time: No such file or directory\n',
    },
    {
      name: 'unicode-harness-exit-1',
      command: 'python3 tmp/check_filter.py',
      status: 'completed', exit_code: 1,
      aggregated_output: 'UnicodeEncodeError: encoding with cp1252 codec failed\n',
    },
    {
      name: 'explicit-failed-missing-tool',
      command: 'required-checker-tool --verify',
      status: 'failed', exit_code: null,
      aggregated_output: 'required-checker-tool: command not found\n',
    },
  ]
  for (const scenario of cases) {
    const checkerOutput = canonicalOutcome('PASS', {
      runId: `run-${scenario.name}`, currentVersionHash: 'b'.repeat(64),
    })
    let terminal
    const adapter = new CodexExecAdapter({
      runner: {
        async run(spec) {
          spec.onStdoutLine(JSON.stringify({
            type: 'thread.started', thread_id: `thread-${scenario.name}`,
          }))
          spec.onStdoutLine(JSON.stringify({
            type: 'item.completed',
            item: {
              id: `command-${scenario.name}`, type: 'command_execution',
              command: scenario.command, status: scenario.status,
              exit_code: scenario.exit_code, aggregated_output: scenario.aggregated_output,
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
      targetPath: ROOT,
      profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
      outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
    })
    const result = await adapter.launch({
      ...CHECKER_EXECUTION_POLICY,
      physicalExecutionPolicy: CHECKER_EXECUTION_POLICY,
      runId: `run-${scenario.name}`, candidateHash: 'b'.repeat(64), purpose: 'check',
      ...adapterMissionFields('a'.repeat(64)),
      dispatch: {
        brief: 'Execute the authoritative verifier.',
        requestPointer: { path: 'request', hash: 'a'.repeat(64) },
      },
      environment: {}, sessionId: `session-${scenario.name}`,
      reservationId: `reservation-${scenario.name}`,
      onTerminalResult(value) { terminal = value },
    })
    assert.equal(result.code, 'PASS', scenario.name)
    assert.equal(terminal.code, 'PASS', scenario.name)
    assert.equal(result.transportEvidence.commandExecutionFailures.count, 1, scenario.name)
    assert.match(result.transportEvidence.commandExecutionFailures.evidenceHash, /^[a-f0-9]{64}$/u)
    assert.equal(result.transportEvidence.commandExecutionFailures.first.exitCode,
      scenario.exit_code, scenario.name)
    assert.match(result.transportEvidence.commandExecutionFailures.first.commandHash,
      /^[a-f0-9]{64}$/u)
  }
})

test('Codex checker verdicts bind named outcomes directly to substantive command events', async t => {
  const directory = temporaryDirectory(t)
  const target = path.join(directory, 'target')
  const frozen = path.join(directory, 'frozen')
  const scratchRoot = path.join(directory, 'checker-scratch')
  fs.mkdirSync(target, { mode: 0o700 })
  fs.mkdirSync(frozen, { mode: 0o700 })
  const discoveredNodeHarnessPath = path.join(frozen, 'focused-check.cjs')
  const discoveredShellHarnessPath = path.join(frozen, 'focused-check.sh')
  fs.writeFileSync(discoveredNodeHarnessPath, "'use strict'\n")
  fs.writeFileSync(discoveredShellHarnessPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const candidateHash = 'b'.repeat(64)
  const requestEnvelopeHash = 'a'.repeat(64)
  const checkId = 'verification:privacy:reverse-uniqueness:LONG_UNIQUE_CHECK_SENTINEL_7d0a2b41'
  const assignmentId = 'independent-check-1'
  const summary = 'authoritative harness: 17 assertions completed'
  const fingerprint = crypto.createHash('sha256').update(summary).digest('hex')
  const cleanupRegistry = new CleanupRegistry({
    registryPath: path.join(directory, 'cleanup-registry.json'),
    allowedRoots: [directory],
    controlBinding: { activationId: 'observation-test', generationId: 1 },
  })
  const scratchFactory = createCheckerScratchFactory({
    scratchRoot, cleanupRegistry, runId: 'run-observation', targetPath: target,
  })
  const checkerScratchBoundary = scratchFactory(assignmentId, frozen, {
    candidateHash, adoptedScratchRoots: [],
  })
  for (const relativeHarness of [
    'output/independent_harness.py',
    'tmp/independent_harness.py',
  ]) {
    const harnessPath = path.join(checkerScratchBoundary.writableScratchRoot, relativeHarness)
    fs.mkdirSync(path.dirname(harnessPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(harnessPath, 'raise SystemExit(0)\n', { mode: 0o600 })
  }
  const legacyBindingInput = {
    schemaVersion: 2,
    assignmentId,
    candidateHash,
    requestEnvelopeHash,
    checkIds: [checkId],
    commandBindings: [{ checkId, command: 'python3 independent_harness.py' }],
  }
  assert.deepEqual(
    createCheckerObservationBinding(legacyBindingInput),
    createCheckerObservationBinding(legacyBindingInput),
    'legacy exact-command bindings reconstruct deterministically during recovery',
  )
  const runScenario = async ({
    aggregateCode,
    commandOutput,
    outcomeStatus,
    outcomeStatuses,
    outcomeFingerprint,
    outcomeFingerprints,
    commandEvents,
    checkIds = [checkId],
    authorizedCommand = 'python3 independent_harness.py',
    outcomeCommandHash,
    outcomeCommandHashes,
    outcomeObservationId,
    compactOutcomes = false,
    outcomeItemOverrides = null,
    emitCommandStarts = true,
    beforeCommandCompletion = null,
    payloadOverrides = {},
  }) => {
    const binding = createCheckerObservationBinding({
      assignmentId, candidateHash, requestEnvelopeHash, checkIds,
      ...(authorizedCommand === null ? {} : {
        commandBindings: checkIds.map(namedCheck => ({
          checkId: namedCheck,
          command: authorizedCommand,
        })),
      }),
    })
    const observationByCheck = new Map(binding.observations
      .map(observation => [observation.checkId, observation]))
    const reportedCommand = authorizedCommand || commandEvents && commandEvents
      .find(commandEvent => commandEvent && Number.isFinite(commandEvent.exit_code))?.command || ''
    const checkerOutput = canonicalOutcome(aggregateCode, {
      runId: 'run-observation',
      currentVersionHash: candidateHash,
      payload: {
        ...payloadOverrides,
        testOutcomes: checkIds.map(command => {
          const status = outcomeStatuses && outcomeStatuses[command] || outcomeStatus
          const itemOverrides = typeof outcomeItemOverrides === 'function'
            ? outcomeItemOverrides({ command, status })
            : outcomeItemOverrides || {}
          if (compactOutcomes) return { command, status, ...itemOverrides }
          return {
            command,
            observationId: outcomeObservationId || observationByCheck.get(command).observationId,
            commandHash: outcomeCommandHashes && outcomeCommandHashes[command] || outcomeCommandHash || crypto.createHash('sha256')
              .update(reportedCommand).digest('hex'),
            status,
            fingerprint: outcomeFingerprints && outcomeFingerprints[command] || outcomeFingerprint || fingerprint,
            ...itemOverrides,
          }
        }),
      },
    })
    let terminal
    const adapter = new CodexExecAdapter({
      runner: {
        async run(spec) {
          for (const namedCheck of checkIds) {
            assert.equal(spec.stdin.split(namedCheck).length - 1, 1,
              'each named checker obligation reaches provider stdin exactly once')
            assert.equal(spec.stdin.includes(observationByCheck.get(namedCheck).observationId), false,
              'controller-issued observation ids never consume model context')
          }
          assert.doesNotMatch(spec.stdin,
            /verificationObservationCases|verificationObservationBinding|authorizedCommandHashes/u,
            'controller-owned receipt binding never enters the model-visible assignment')
          assert.doesNotMatch(spec.stdin, /AUTOPROMPT_(?:CHECKER_)?OBSERVATION/u,
            'controller command binding is not a model-emitted marker protocol')
          spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-observation' }))
          for (const [index, commandEvent] of (commandEvents || [{
            command: 'python3 independent_harness.py', status: 'completed', exit_code: 0,
            aggregated_output: commandOutput,
          }]).entries()) {
            if (emitCommandStarts) {
              spec.onStdoutLine(JSON.stringify({
                type: 'item.started',
                item: {
                  id: `command-observation-${index}`,
                  type: 'command_execution',
                  command: commandEvent.command,
                  status: 'in_progress',
                },
              }))
            }
            if (typeof beforeCommandCompletion === 'function') {
              beforeCommandCompletion({ index, commandEvent })
            }
            spec.onStdoutLine(JSON.stringify({
              type: 'item.completed',
              item: { id: `command-observation-${index}`, type: 'command_execution', ...commandEvent },
            }))
          }
          spec.onStdoutLine(JSON.stringify({
            type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(checkerOutput) },
          }))
          spec.onStdoutLine(JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          }))
          return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
        },
        async stop() { return { drained: true } },
      },
      targetPath: target,
      profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
      outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
      checkerScratchVerifier: scratchFactory.verify,
    })
    const result = await adapter.launch({
      ...CHECKER_EXECUTION_POLICY,
      physicalExecutionPolicy: CHECKER_EXECUTION_POLICY,
      runId: checkerOutput.runId, candidateHash, purpose: 'check',
      ...adapterMissionFields(requestEnvelopeHash, assignmentId),
      canonicalAssignment: {
        assignmentId, requestEnvelopeHash, checks: checkIds,
        verificationObservationBinding: binding,
      },
      dispatch: { brief: 'Execute the bound checker.', requestPointer: { path: 'request', hash: requestEnvelopeHash } },
      environment: {}, sessionId: 'session-observation', reservationId: 'reservation-observation',
      workingDirectory: checkerScratchBoundary.writableScratchRoot,
      canonicalTargetPath: frozen,
      checkerScratchBoundary,
      sandboxAssignment: { checkerId: assignmentId },
      onTerminalResult(value) { terminal = value },
    })
    assert.equal(terminal.code, result.code)
    return result
  }

  const pass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', commandOutput: `${summary}\n`,
  })
  assert.equal(pass.code, 'PASS')
  assert.equal(pass.transportEvidence.verificationObservations.count, 1)

  const compactPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', compactOutcomes: true,
    commandOutput: `${summary}\n`,
  })
  assert.equal(compactPass.code, 'PASS')
  assert.deepEqual(compactPass.payload.testOutcomes, [{
    command: checkId,
    status: 'PASS',
    fingerprint,
    observationId: createCheckerObservationBinding({
      assignmentId, candidateHash, requestEnvelopeHash, checkIds: [checkId],
      commandBindings: [{ checkId, command: 'python3 independent_harness.py' }],
    }).observations[0].observationId,
    commandHash: crypto.createHash('sha256').update('python3 independent_harness.py').digest('hex'),
  }], 'the controller enriches a compact report from its unique exact receipt')

  const forgedVerificationAuthority = {
    schemaVersion: 1,
    authorityHash: 'f'.repeat(64),
    checks: [{ checkId, authority: 'SCRATCH_HARNESS' }],
  }
  const forgedAuthorityPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', compactOutcomes: true,
    commandOutput: `${summary}\n`,
    payloadOverrides: { verificationAuthority: forgedVerificationAuthority },
  })
  assert.equal(forgedAuthorityPass.code, 'PASS')
  assert.notDeepEqual(forgedAuthorityPass.payload.verificationAuthority,
    forgedVerificationAuthority,
    'a checker cannot supply its own controller verification authority')
  assert.equal(forgedAuthorityPass.payload.verificationAuthority.schemaVersion, 1)
  assert.match(forgedAuthorityPass.payload.verificationAuthority.authorityHash,
    /^[a-f0-9]{64}$/u)
  assert.deepEqual(
    forgedAuthorityPass.payload.verificationAuthority.checks.map(item => ({
      checkId: item.checkId,
      authority: item.authority,
    })),
    [{ checkId, authority: 'EXACT_COMMAND' }],
    'the replacement authority is derived from the selected exact command receipt',
  )

  const exactHarnessFailure = 'FAIL: authoritative harness found a product defect'
  const fail = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL',
    outcomeFingerprint: crypto.createHash('sha256').update(exactHarnessFailure).digest('hex'),
    commandEvents: [{
      command: 'python3 independent_harness.py', status: 'failed', exit_code: 1,
      aggregated_output: exactHarnessFailure,
    }],
  })
  assert.equal(fail.code, 'FAIL', 'a named product FAIL remains the checker verdict')

  const compactFail = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', compactOutcomes: true,
    commandEvents: [{
      command: 'python3 independent_harness.py', status: 'failed', exit_code: 1,
      aggregated_output: exactHarnessFailure,
    }],
  })
  assert.equal(compactFail.code, 'FAIL',
    'the controller can bind a compact FAIL to one authenticated nonzero receipt')
  assert.equal(compactFail.payload.testOutcomes[0].fingerprint,
    crypto.createHash('sha256').update(exactHarnessFailure).digest('hex'))

  const aggregatePassWithBoundFail = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'FAIL', compactOutcomes: true,
    commandEvents: [{
      command: 'python3 independent_harness.py', status: 'failed', exit_code: 1,
      aggregated_output: exactHarnessFailure,
    }],
  })
  assert.equal(aggregatePassWithBoundFail.code, 'FAIL',
    'controller-bound nonzero evidence overrides an accidental model aggregate PASS')
  assert.equal(aggregatePassWithBoundFail.cause.event, 'ASSERTION_FAILED')
  assert.equal(
    aggregatePassWithBoundFail.payload.verificationObservationDisposition.reportedAggregateCode,
    'PASS',
  )
  assert.equal(
    aggregatePassWithBoundFail.payload.verificationObservationDisposition.controllerAggregateCode,
    'FAIL',
  )
  assert.deepEqual(
    aggregatePassWithBoundFail.payload.verificationObservationDisposition
      .commandBoundFailureCheckIds,
    [checkId],
  )
  assert.match(aggregatePassWithBoundFail.payload.testOutcomes[0].failureIdentity,
    /^[a-f0-9]{64}$/u)

  const volatileTapFailureOne = [
    'TAP version 13',
    'not ok 1 - preserves stable named behavior',
    '# observed 2026-08-28T10:00:00Z in /tmp/check-17 random=run-17',
    '# fail 1',
  ].join('\n')
  const volatileTapFailureTwo = [
    'TAP version 13',
    'not ok 1 - preserves stable named behavior',
    '# observed 2026-08-28T10:01:00Z in /tmp/check-18 random=run-18',
    '# fail 1',
  ].join('\n')
  const stableNamedFailureOne = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', compactOutcomes: true,
    commandEvents: [{
      command: 'python3 independent_harness.py', status: 'failed', exit_code: 1,
      aggregated_output: volatileTapFailureOne,
    }],
  })
  const stableNamedFailureTwo = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', compactOutcomes: true,
    outcomeItemOverrides: { failureIdentity: 'f'.repeat(64) },
    commandEvents: [{
      command: 'python3 independent_harness.py', status: 'failed', exit_code: 1,
      aggregated_output: volatileTapFailureTwo,
    }],
  })
  assert.notEqual(
    stableNamedFailureOne.payload.testOutcomes[0].fingerprint,
    stableNamedFailureTwo.payload.testOutcomes[0].fingerprint,
    'raw output remains distinct evidence',
  )
  assert.equal(
    stableNamedFailureOne.payload.testOutcomes[0].failureIdentity,
    stableNamedFailureTwo.payload.testOutcomes[0].failureIdentity,
    'volatile diagnostics do not change the controller-owned named failure identity',
  )
  assert.notEqual(
    stableNamedFailureTwo.payload.testOutcomes[0].failureIdentity,
    'f'.repeat(64),
    'a model-provided semantic identity is discarded before controller binding',
  )

  const renamedExactFailureOne = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', compactOutcomes: true,
    commandEvents: [{
      command: 'python3 independent_harness.py', status: 'failed', exit_code: 1,
      aggregated_output: 'TAP version 13\nnot ok 1 - candidate-owned-case-A\n# fail 1',
    }],
  })
  const renamedExactFailureTwo = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', compactOutcomes: true,
    commandEvents: [{
      command: 'python3 independent_harness.py', status: 'failed', exit_code: 1,
      aggregated_output: 'TAP version 13\nnot ok 1 - candidate-owned-case-B\n# fail 1',
    }],
  })
  assert.equal(
    renamedExactFailureOne.payload.testOutcomes[0].failureIdentity,
    renamedExactFailureTwo.payload.testOutcomes[0].failureIdentity,
    'renaming a candidate-owned case behind the same exact command cannot mint repair progress',
  )

  const missing = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', commandEvents: [],
  })
  assert.equal(missing.code, 'CHECK_INCONCLUSIVE')
  assert.equal(missing.cause.event, 'CHECK_OBSERVATION_INCOMPLETE')

  const echoOnly = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS',
    commandEvents: [{ command: `echo '${summary}'`, status: 'completed', exit_code: 0, aggregated_output: summary }],
  })
  assert.equal(echoOnly.code, 'CHECK_INCONCLUSIVE')

  const trueOnlyOutput = 'unrelated no-op succeeded'
  const trueOnly = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS',
    outcomeFingerprint: crypto.createHash('sha256').update(trueOnlyOutput).digest('hex'),
    commandEvents: [{ command: '/usr/bin/true', status: 'completed', exit_code: 0, aggregated_output: trueOnlyOutput }],
  })
  assert.equal(trueOnly.code, 'CHECK_INCONCLUSIVE')

  const unapprovedSummaryCommand = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS',
    authorizedCommand: null,
    commandEvents: [{
      command: `node -e "console.log('${summary}')"`, status: 'completed', exit_code: 0,
      aggregated_output: summary,
    }],
  })
  assert.equal(unapprovedSummaryCommand.code, 'CHECK_INCONCLUSIVE',
    'a successful generic command cannot cover a check unless the controller authorized that command identity')

  const unapprovedScratchRead = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS',
    authorizedCommand: null,
    commandEvents: [{
      command: 'cat scratch/oracle-output.txt', status: 'completed', exit_code: 0,
      aggregated_output: summary,
    }],
  })
  assert.equal(unapprovedScratchRead.code, 'CHECK_INCONCLUSIVE')

  const genericCommand = `node ${JSON.stringify(discoveredNodeHarnessPath)}`
  const authorizedGenericCommand = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: genericCommand,
    commandEvents: [{
      command: genericCommand, status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(authorizedGenericCommand.code, 'PASS',
    'controller authorization remains executable-agnostic')

  const authorizedWrappedGenericCommand = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: genericCommand,
    outcomeCommandHash: crypto.createHash('sha256').update(genericCommand).digest('hex'),
    commandEvents: [{
      command: `/bin/bash -lc ${JSON.stringify(genericCommand)}`,
      status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(authorizedWrappedGenericCommand.code, 'PASS',
    'an exact inner command authorization binds its Codex-owned shell wrapper')

  const discoveredHarness = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    commandEvents: [{
      command: genericCommand, status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(discoveredHarness.code, 'PASS',
    'a conservative candidate harness can cover a descriptive check without treating its prose as a command')

  const toolWrappedDiscoveredHarness = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [{
      command: `/bin/bash -lc ${JSON.stringify(genericCommand)}`,
      status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(toolWrappedDiscoveredHarness.code, 'PASS',
    'the exact Codex tool shell wrapper preserves an immutable candidate harness')

  const wrappedByTimeoutHarness = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [{
      command: `timeout 30s node ${JSON.stringify(discoveredNodeHarnessPath)}`,
      status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(wrappedByTimeoutHarness.code, 'PASS',
    'a transparent timeout wrapper preserves a real frozen-candidate harness binding')

  const ambiguousCompactPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    payloadOverrides: {
      verificationObservationDisposition: { reportedAggregateCode: 'FAIL' },
    },
    commandEvents: [
      {
        command: genericCommand, status: 'completed', exit_code: 0,
        aggregated_output: summary,
      },
      {
        command: `node --no-warnings ${JSON.stringify(discoveredNodeHarnessPath)}`,
        status: 'completed', exit_code: 0, aggregated_output: summary,
      },
    ],
  })
  assert.equal(ambiguousCompactPass.code, 'CHECK_INCONCLUSIVE',
    'a compact PASS cannot choose between distinct admissible command receipts')
  assert.equal(
    ambiguousCompactPass.payload.verificationObservationDisposition.reportedAggregateCode,
    'PASS',
    'the controller records the original aggregate code when it rejects PASS authority',
  )

  const discoveredShellHarness = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    commandEvents: [{
      command: `bash ${JSON.stringify(discoveredShellHarnessPath)}`,
      status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(discoveredShellHarness.code, 'PASS',
    'a script-file harness inside the frozen candidate is admissible without inline shell execution')

  const inlineShellHarness = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    commandEvents: [{
      command: `bash -c ${JSON.stringify(`printf '${summary}'`)}`,
      status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(inlineShellHarness.code, 'CHECK_INCONCLUSIVE')

  const nodeTapFailure = 'TAP version 13\nnot ok 1 - frozen candidate behavior\n# fail 1'
  const legitimateNonzeroFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeFingerprint: crypto.createHash('sha256').update(nodeTapFailure).digest('hex'),
    commandEvents: [{
      command: genericCommand, status: 'failed', exit_code: 1,
      aggregated_output: nodeTapFailure,
    }],
  })
  assert.equal(legitimateNonzeroFailure.code, 'FAIL',
    'a controller-observed nonzero test assertion binds a named product failure')

  const preservedCase = 'verification:preservation:clean-boundary'
  const rejectedCase = 'verification:security:active-content-boundary'
  const submittedCheckerHarness = `python3 output/independent_harness.py ${discoveredNodeHarnessPath}`
  const wrappedCheckerHarness = `/bin/bash -lc ${JSON.stringify(submittedCheckerHarness)}`
  const absoluteScratchHarness = path.join(
    checkerScratchBoundary.writableScratchRoot,
    'output',
    'independent_harness.py',
  )
  const submittedCheckerHarnessHash = crypto.createHash('sha256')
    .update(submittedCheckerHarness).digest('hex')
  const alternateScratchHarness = `python3 tmp/independent_harness.py ${discoveredNodeHarnessPath}`
  const checkerChosenFailureOne = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'failed', exit_code: 1,
      aggregated_output: 'TAP version 13\nnot ok 1 - checker-chosen-name-A\n# fail 1',
    }],
  })
  const checkerChosenFailureTwo = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [{
      command: `/bin/bash -lc ${JSON.stringify(alternateScratchHarness)}`,
      status: 'failed', exit_code: 1,
      aggregated_output: 'TAP version 13\nnot ok 1 - checker-chosen-name-B\n# fail 1',
    }],
  })
  assert.equal(checkerChosenFailureOne.code, 'FAIL')
  assert.equal(checkerChosenFailureTwo.code, 'FAIL')
  assert.equal(
    checkerChosenFailureOne.payload.testOutcomes[0].failureIdentity,
    checkerChosenFailureTwo.payload.testOutcomes[0].failureIdentity,
    'checker-chosen scratch command paths and printed names cannot mint semantic novelty',
  )
  const wrappedCheckerHarnessPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    outcomeCommandHash: submittedCheckerHarnessHash,
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'completed', exit_code: 0,
      aggregated_output: summary,
    }],
  })
  assert.equal(wrappedCheckerHarnessPass.code, 'CHECK_INCONCLUSIVE',
    'a scratch-authored zero-exit wrapper cannot promote its own PASS authority')
  assert.notEqual(
    wrappedCheckerHarnessPass.transportEvidence.verificationObservations.receipts[0].commandHash,
    wrappedCheckerHarnessPass.transportEvidence.verificationObservations.receipts[0].harnessCommandHash,
  )
  assert.equal(
    wrappedCheckerHarnessPass.transportEvidence.verificationObservations.receipts[0]
      .candidateHarnessAdmissible,
    false,
  )

  const strongScratchPassOutput = [
    'PASS behavior: 2081245 rows preserve schema and relationships',
    'PASS boundary: malformed memory and policy inputs are rejected',
    'PASS verification: repeated and changed seeds satisfy determinism invariants',
  ].join('\n')
  const sealedScratchHarnessPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'completed', exit_code: 0,
      aggregated_output: strongScratchPassOutput,
    }],
  })
  assert.equal(sealedScratchHarnessPass.code, 'CHECK_INCONCLUSIVE',
    'one start-sealed scratch validator is provisional rather than terminal PASS authority')
  assert.equal(sealedScratchHarnessPass.cause.event,
    'CHECK_SCRATCH_CONFIRMATION_REQUIRED')
  assert.equal(
    sealedScratchHarnessPass.payload.verificationObservationDisposition.reportedAggregateCode,
    'PASS',
  )
  assert.deepEqual(
    sealedScratchHarnessPass.payload.verificationAuthority.checks.map(item => ({
      checkId: item.checkId,
      authority: item.authority,
    })),
    [{ checkId, authority: 'SCRATCH_HARNESS' }],
  )
  assert.match(sealedScratchHarnessPass.payload.verificationAuthority.authorityHash,
    /^[a-f0-9]{64}$/u)
  assert.match(
    sealedScratchHarnessPass.transportEvidence.verificationObservations.receipts[0]
      .scratchHarnessProgramDigest,
    /^[a-f0-9]{64}$/u,
  )
  assert.equal(
    sealedScratchHarnessPass.payload.verificationAuthority.checks[0].programDigest,
    sealedScratchHarnessPass.transportEvidence.verificationObservations.receipts[0]
      .scratchHarnessProgramDigest,
    'the provisional authority retains the controller-observed sealed bytes',
  )

  const unsealedScratchHarnessPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    emitCommandStarts: false,
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'completed', exit_code: 0,
      aggregated_output: strongScratchPassOutput,
    }],
  })
  assert.equal(unsealedScratchHarnessPass.code, 'CHECK_INCONCLUSIVE',
    'a completed-only event cannot retroactively seal a mutable scratch validator')

  const originalScratchHarness = fs.readFileSync(absoluteScratchHarness, 'utf8')
  const changedDuringExecutionPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    beforeCommandCompletion() {
      fs.appendFileSync(absoluteScratchHarness, '# changed after command start\n')
    },
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'completed', exit_code: 0,
      aggregated_output: strongScratchPassOutput,
    }],
  })
  fs.writeFileSync(absoluteScratchHarness, originalScratchHarness, { mode: 0o600 })
  assert.equal(changedDuringExecutionPass.code, 'CHECK_INCONCLUSIVE',
    'a scratch validator changed after start cannot retain sealed PASS authority')

  const replacedScratchHarnessPath = `${absoluteScratchHarness}.started`
  const replacedWithIdenticalBytesPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    beforeCommandCompletion() {
      fs.renameSync(absoluteScratchHarness, replacedScratchHarnessPath)
      fs.writeFileSync(absoluteScratchHarness, originalScratchHarness, { mode: 0o600 })
    },
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'completed', exit_code: 0,
      aggregated_output: strongScratchPassOutput,
    }],
  })
  fs.unlinkSync(absoluteScratchHarness)
  fs.renameSync(replacedScratchHarnessPath, absoluteScratchHarness)
  assert.equal(replacedWithIdenticalBytesPass.code, 'CHECK_INCONCLUSIVE',
    'replacing a started validator with identical bytes cannot preserve its inode-bound seal')
  assert.equal(
    replacedWithIdenticalBytesPass.payload.verificationAuthority,
    undefined,
    'an identity-replaced scratch program produces no provisional PASS authority',
  )

  const wrappedCheckerHarnessFailure = await runScenario({
    aggregateCode: 'FAIL',
    outcomeStatus: 'FAIL',
    outcomeStatuses: { [preservedCase]: 'PASS', [rejectedCase]: 'FAIL' },
    authorizedCommand: null,
    checkIds: [preservedCase, rejectedCase],
    outcomeCommandHash: submittedCheckerHarnessHash,
    outcomeFingerprint: crypto.createHash('sha256').update(nodeTapFailure).digest('hex'),
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'failed', exit_code: 1,
      aggregated_output: nodeTapFailure,
    }],
  })
  assert.equal(wrappedCheckerHarnessFailure.code, 'FAIL',
    'a candidate-bound failure remains actionable when only positive coverage is incomplete')

  const absoluteScratchHarnessFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [{
      command: `/bin/bash -lc ${JSON.stringify(
        `python3 ${absoluteScratchHarness} ${discoveredNodeHarnessPath}`,
      )}`,
      status: 'failed', exit_code: 1, aggregated_output: nodeTapFailure,
    }],
  })
  assert.equal(absoluteScratchHarnessFailure.code, 'FAIL',
    'an absolute checker-scratch validator remains actionable only with a distinct frozen input')

  const f1deLegacyResultTelemetryFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeCommandHash: submittedCheckerHarnessHash,
    outcomeFingerprint: crypto.createHash('sha256').update(nodeTapFailure).digest('hex'),
    outcomeItemOverrides: {
      status: undefined,
      exitCode: 1,
      result: 'FAIL',
      admittedNonzeroTestFailure: true,
    },
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'failed', exit_code: 1,
      aggregated_output: nodeTapFailure,
    }],
  })
  const f1deStatusAndExtraTelemetryFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeCommandHash: submittedCheckerHarnessHash,
    outcomeFingerprint: crypto.createHash('sha256').update(nodeTapFailure).digest('hex'),
    outcomeItemOverrides: {
      exitCode: 1,
      result: 'FAIL',
      admittedNonzeroTestFailure: true,
    },
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'failed', exit_code: 1,
      aggregated_output: nodeTapFailure,
    }],
  })
  assert.deepEqual(
    [f1deLegacyResultTelemetryFailure.code, f1deStatusAndExtraTelemetryFailure.code],
    ['FAIL', 'FAIL'],
    'legacy result-only and status-plus-extra f1de telemetry cannot hide authentic bound FAILs',
  )
  assert.deepEqual(
    Object.keys(f1deLegacyResultTelemetryFailure.payload.testOutcomes[0]).sort(),
    ['command', 'commandHash', 'failureIdentity', 'fingerprint', 'observationId', 'status'],
    'controller canonicalization strips checker telemetry after binding it to the receipt',
  )
  assert.deepEqual(
    Object.keys(f1deStatusAndExtraTelemetryFailure.payload.testOutcomes[0]).sort(),
    ['command', 'commandHash', 'failureIdentity', 'fingerprint', 'observationId', 'status'],
    'known checker telemetry is projected away from the controller-owned outcome',
  )

  const productionVerifierOutput = JSON.stringify({
    total: 20,
    failureCount: 2,
    failures: ['capacity balance mismatch', 'missing schedule row'],
  })
  const productionVerifierFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [{
      command: `/bin/bash -lc ${JSON.stringify(
        `python3 ${absoluteScratchHarness} ${frozen}`,
      )}`,
      status: 'failed', exit_code: 1, aggregated_output: productionVerifierOutput,
    }],
  })
  assert.equal(productionVerifierFailure.code, 'FAIL',
    'a candidate-bound verifier JSON failureCount remains actionable')

  const changedScratchHarnessResult = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [
      {
        command: `/bin/bash -lc ${JSON.stringify(
          `python3 ${absoluteScratchHarness} ${frozen}`,
        )}`,
        status: 'failed', exit_code: 1, aggregated_output: productionVerifierOutput,
      },
      {
        command: `/bin/bash -lc ${JSON.stringify(
          `python3 ${absoluteScratchHarness} ${frozen}`,
        )}`,
        status: 'completed', exit_code: 0,
        aggregated_output: JSON.stringify({ total: 20, failureCount: 0, failures: [] }),
      },
    ],
  })
  assert.equal(changedScratchHarnessResult.code, 'CHECK_INCONCLUSIVE',
    'contradictory executions of one scratch-validator identity cannot preserve a stale FAIL')

  const selectedCheckFailureOutput = [
    'MODEL_STRUCTURE PASS faces=2756',
    'FACETED_BREP_SEMANTICS FAIL faces are not planar FACE_SURFACE records',
    'SELECTED_CHECK FAIL build-or-run',
  ].join('\n')
  const selectedCheckFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeCommandHash: submittedCheckerHarnessHash,
    outcomeFingerprint: crypto.createHash('sha256').update(selectedCheckFailureOutput).digest('hex'),
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'failed', exit_code: 1,
      aggregated_output: selectedCheckFailureOutput,
    }],
  })
  assert.equal(selectedCheckFailure.code, 'FAIL',
    'an anchored selected-check failure from a candidate-bound harness is substantive')

  const capturedCheckerCommand = `set -o pipefail\n${submittedCheckerHarness} | tee output/check-2.txt`
  const capturedCheckerCommandHash = crypto.createHash('sha256')
    .update(capturedCheckerCommand).digest('hex')
  const capturedCheckerFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeCommandHash: capturedCheckerCommandHash,
    outcomeFingerprint: crypto.createHash('sha256').update(selectedCheckFailureOutput).digest('hex'),
    commandEvents: [{
      command: `/bin/bash -lc "${capturedCheckerCommand}"`, status: 'failed', exit_code: 1,
      aggregated_output: selectedCheckFailureOutput,
    }],
  })
  assert.equal(capturedCheckerFailure.code, 'FAIL',
    'a pipefail harness with a bounded scratch capture retains candidate-bound failure authority')

  const incidentCapturedCheckerCommand = [
    'set -o pipefail;',
    `PYTHONDONTWRITEBYTECODE=1 python3 tmp/independent_harness.py ${discoveredNodeHarnessPath}`,
    '2>&1 | tee output/independent_harness.log',
  ].join(' ')
  const incidentCapturedCheckerFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeCommandHash: crypto.createHash('sha256')
      .update(incidentCapturedCheckerCommand).digest('hex'),
    outcomeFingerprint: crypto.createHash('sha256').update(selectedCheckFailureOutput).digest('hex'),
    commandEvents: [{
      command: `/bin/bash -lc ${JSON.stringify(incidentCapturedCheckerCommand)}`,
      status: 'failed', exit_code: 1, aggregated_output: selectedCheckFailureOutput,
    }],
  })
  assert.equal(incidentCapturedCheckerFailure.code, 'FAIL',
    'the exact Codex semicolon, stderr capture, and tee incident shape remains actionable')

  const timeoutCapturedCheckerCommand = [
    'set -o pipefail;',
    `timeout 30s env PYTHONDONTWRITEBYTECODE=1 python3 tmp/independent_harness.py ${discoveredNodeHarnessPath}`,
    '2>&1 | tee output/independent_harness.log',
  ].join(' ')
  const timeoutCapturedCheckerFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [{
      command: `/bin/bash -lc ${JSON.stringify(timeoutCapturedCheckerCommand)}`,
      status: 'failed', exit_code: 1, aggregated_output: selectedCheckFailureOutput,
    }],
  })
  assert.equal(timeoutCapturedCheckerFailure.code, 'FAIL',
    'a transparent timeout around the captured HTML/CAD harness retains failure authority')

  const uncapturedPipelineFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeFingerprint: crypto.createHash('sha256').update(selectedCheckFailureOutput).digest('hex'),
    commandEvents: [{
      command: `/bin/bash -lc "${submittedCheckerHarness} | tee output/check-2.txt"`,
      status: 'failed', exit_code: 1, aggregated_output: selectedCheckFailureOutput,
    }],
  })
  assert.equal(uncapturedPipelineFailure.code, 'CHECK_INCONCLUSIVE',
    'an arbitrary shell pipeline cannot acquire candidate-harness authority')

  const scratchOnlyFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeFingerprint: crypto.createHash('sha256').update(nodeTapFailure).digest('hex'),
    commandEvents: [{
      command: 'python3 output/independent_harness.py', status: 'failed', exit_code: 1,
      aggregated_output: nodeTapFailure,
    }],
  })
  assert.equal(scratchOnlyFailure.code, 'CHECK_INCONCLUSIVE',
    'a scratch-only failure cannot manufacture product-repair authority')

  const scratchCandidateNameDropPass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    outcomeCommandHash: crypto.createHash('sha256')
      .update(`python3 output/fake_harness.py ${discoveredNodeHarnessPath}`).digest('hex'),
    commandEvents: [{
      command: `python3 output/fake_harness.py ${discoveredNodeHarnessPath}`,
      status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(scratchCandidateNameDropPass.code, 'CHECK_INCONCLUSIVE',
    'a writable scratch program cannot acquire PASS authority by naming a frozen candidate argument')

  for (const command of [
    `bash output/fake_harness.sh ${discoveredNodeHarnessPath}`,
    `node --require=output/fake_harness.js ${discoveredNodeHarnessPath}`,
    `NODE_OPTIONS=--require=./output/fake_harness.js node ${discoveredNodeHarnessPath}`,
    `NODE_OPTIONS='--require ./output/fake_harness.js' node ${discoveredNodeHarnessPath}`,
    `env -S NODE_OPTIONS=--require=./output/fake_harness.js node ${discoveredNodeHarnessPath}`,
    `python3.12 output/fake_harness.py ${discoveredNodeHarnessPath}`,
    `PATH=output:/usr/bin fake_harness ${discoveredNodeHarnessPath}`,
    `python3 -c'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `python3 -qc'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `python3 -Oqc'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `python3 -moutput.fake_harness ${discoveredNodeHarnessPath}`,
    `perl -e'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `perl -E'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `perl -we'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `node -pe'"authoritative harness: 17 assertions completed"' ${discoveredNodeHarnessPath}`,
    `bash -c'printf authoritative' ${discoveredNodeHarnessPath}`,
    `timeout 30s node -pe'"authoritative harness: 17 assertions completed"' ${discoveredNodeHarnessPath}`,
    `/usr/bin/time -p python3 -qc'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `nice -n 5 perl -we'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `timeout 30s nice -n 5 node -pe'"authoritative harness: 17 assertions completed"' ${discoveredNodeHarnessPath}`,
    `command timeout 30s node -pe'"authoritative harness: 17 assertions completed"' ${discoveredNodeHarnessPath}`,
    `exec nice -n 5 python3 -qc'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `busybox timeout 30s perl -we'print("authoritative harness: 17 assertions completed")' ${discoveredNodeHarnessPath}`,
    `basename ${discoveredNodeHarnessPath}`,
    `dirname ${discoveredNodeHarnessPath}`,
    `sha224sum ${discoveredNodeHarnessPath}`,
    `sha384sum ${discoveredNodeHarnessPath}`,
    `sha512sum ${discoveredNodeHarnessPath}`,
    `b2sum ${discoveredNodeHarnessPath}`,
    `openssl dgst ${discoveredNodeHarnessPath}`,
    `git hash-object ${discoveredNodeHarnessPath}`,
    `cp -v ${discoveredNodeHarnessPath} output/copied-candidate`,
    `node --version ${discoveredNodeHarnessPath}`,
    `python3 --version ${discoveredNodeHarnessPath}`,
    `node ${discoveredNodeHarnessPath} --version`,
    `python3 ${discoveredNodeHarnessPath} --help`,
    `npm --prefix ${frozen} --version`,
    `pytest output/fake_test.py --rootdir ${frozen}`,
    `cmake -P output/fake.cmake ${discoveredNodeHarnessPath}`,
    `blender --python-expr 'raise AssertionError()' ${discoveredNodeHarnessPath}`,
  ]) {
    const alternateScratchProgramPass = await runScenario({
      aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
      outcomeCommandHash: crypto.createHash('sha256').update(command).digest('hex'),
      commandEvents: [{
        command, status: 'completed', exit_code: 0, aggregated_output: summary,
      }],
    })
    assert.equal(alternateScratchProgramPass.code, 'CHECK_INCONCLUSIVE',
      `scratch code-loading shape cannot acquire PASS authority: ${command}`)
  }

  for (const command of [
    `/bin/bash -lc ${JSON.stringify(`python3 output/fake_harness.py # ${discoveredNodeHarnessPath}`)}`,
    `/bin/bash -lc ${JSON.stringify(
      `set -o pipefail; python3 output/fake_harness.py # ${discoveredNodeHarnessPath} 2>&1 | tee output/h.log`,
    )}`,
  ]) {
    const commentedCandidateFailure = await runScenario({
      aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
      outcomeFingerprint: crypto.createHash('sha256').update(selectedCheckFailureOutput).digest('hex'),
      commandEvents: [{
        command, status: 'failed', exit_code: 1, aggregated_output: selectedCheckFailureOutput,
      }],
    })
    assert.equal(commentedCandidateFailure.code, 'CHECK_INCONCLUSIVE',
      'a shell-comment candidate name cannot acquire failure authority')
  }

  for (const inlineManufacturedFailureCommand of [
    `python3 -c'raise AssertionError("SELECTED_CHECK FAIL manufactured inline result")' ` +
      discoveredNodeHarnessPath,
    `python3 -qc'raise AssertionError("SELECTED_CHECK FAIL manufactured inline result")' ` +
      discoveredNodeHarnessPath,
    `python3 -Oqc'raise AssertionError("SELECTED_CHECK FAIL manufactured inline result")' ` +
      discoveredNodeHarnessPath,
    `perl -we'die "SELECTED_CHECK FAIL manufactured inline result"' ` +
      discoveredNodeHarnessPath,
    `node -pe'throw Error("SELECTED_CHECK FAIL manufactured inline result")' ` +
      discoveredNodeHarnessPath,
    `python3.12-dbg -c'raise AssertionError("SELECTED_CHECK FAIL manufactured inline result")' ` +
      discoveredNodeHarnessPath,
    `python3.12d -c'raise AssertionError("SELECTED_CHECK FAIL manufactured inline result")' ` +
      discoveredNodeHarnessPath,
    `python3.13t-dbg -c'raise AssertionError("SELECTED_CHECK FAIL manufactured inline result")' ` +
      discoveredNodeHarnessPath,
    `busybox ash -c'python3 -c "raise AssertionError()"' ${discoveredNodeHarnessPath}`,
    `timeout 30s busybox ash -c'python3 -c "raise AssertionError()"' ${discoveredNodeHarnessPath}`,
    `ksh -c'python3 -c "raise AssertionError()"' ${discoveredNodeHarnessPath}`,
    `fish -c'python3 -c "raise AssertionError()"' ${discoveredNodeHarnessPath}`,
    `nu -c'python3 -c "raise AssertionError()"' ${discoveredNodeHarnessPath}`,
    `xargs python3 -c'raise AssertionError()' ${discoveredNodeHarnessPath}`,
    `timeout 30s xargs python3 -c'raise AssertionError()' ${discoveredNodeHarnessPath}`,
    `strace python3 -c'raise AssertionError()' ${discoveredNodeHarnessPath}`,
    `prlimit python3 -c'raise AssertionError()' ${discoveredNodeHarnessPath}`,
    `taskset -c 0 python3 -c'raise AssertionError()' ${discoveredNodeHarnessPath}`,
    `parallel python3 -c'raise AssertionError()' ${discoveredNodeHarnessPath}`,
    `/bin/bash -lc ${JSON.stringify(
      `npm --prefix ${frozen} exec -c "python3 -c 'raise AssertionError()'"`,
    )}`,
    `lua5.4 -e'error("SELECTED_CHECK FAIL")' ${discoveredNodeHarnessPath}`,
    `php -r'throw new Exception("SELECTED_CHECK FAIL");' ${discoveredNodeHarnessPath}`,
    `Rscript -e'stop("SELECTED_CHECK FAIL")' ${discoveredNodeHarnessPath}`,
    `deno eval 'throw new Error("SELECTED_CHECK FAIL")' ${discoveredNodeHarnessPath}`,
    `julia -e'error("SELECTED_CHECK FAIL")' ${discoveredNodeHarnessPath}`,
    `sbcl --eval '(error "SELECTED_CHECK FAIL")' ${discoveredNodeHarnessPath}`,
    `file ${discoveredNodeHarnessPath}`,
    `test -f ${discoveredNodeHarnessPath}`,
    `cksum ${discoveredNodeHarnessPath}`,
    `busybox file ${discoveredNodeHarnessPath}`,
    `toybox cksum ${discoveredNodeHarnessPath}`,
  ]) {
    const inlineManufacturedFailure = await runScenario({
      aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
      outcomeFingerprint: crypto.createHash('sha256').update(selectedCheckFailureOutput).digest('hex'),
      commandEvents: [{
        command: inlineManufacturedFailureCommand,
        status: 'failed', exit_code: 1, aggregated_output: selectedCheckFailureOutput,
      }],
    })
    assert.equal(inlineManufacturedFailure.code, 'CHECK_INCONCLUSIVE',
      `an inline-code option cannot manufacture failure authority: ${inlineManufacturedFailureCommand}`)
  }

  const secondRejectedCase = 'verification:security:encoding-boundary'
  const partiallyBoundFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    checkIds: [rejectedCase, secondRejectedCase],
    outcomeCommandHash: submittedCheckerHarnessHash,
    outcomeFingerprints: {
      [rejectedCase]: crypto.createHash('sha256').update(nodeTapFailure).digest('hex'),
      [secondRejectedCase]: 'f'.repeat(64),
    },
    commandEvents: [{
      command: wrappedCheckerHarness, status: 'failed', exit_code: 1,
      aggregated_output: nodeTapFailure,
    }],
  })
  assert.equal(partiallyBoundFailure.code, 'FAIL',
    'an unobserved extra claim cannot erase one controller-bound product failure')
  assert.deepEqual(
    partiallyBoundFailure.payload.verificationObservationDisposition
      .commandBoundFailureCheckIds,
    [rejectedCase],
  )
  assert.deepEqual(
    partiallyBoundFailure.payload.verificationObservationDisposition.unboundFailureCheckIds,
    [secondRejectedCase],
  )

  const nonzeroCannotAuthorizePass = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    outcomeFingerprint: crypto.createHash('sha256').update(nodeTapFailure).digest('hex'),
    commandEvents: [{
      command: genericCommand, status: 'failed', exit_code: 1,
      aggregated_output: nodeTapFailure,
    }],
  })
  assert.equal(nonzeroCannotAuthorizePass.code, 'CHECK_INCONCLUSIVE')

  const commandNotFound = 'sh: node: command not found'
  const missingHarness = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeFingerprint: crypto.createHash('sha256').update(commandNotFound).digest('hex'),
    commandEvents: [{
      command: genericCommand, status: 'failed', exit_code: 127,
      aggregated_output: commandNotFound,
    }],
  })
  assert.equal(missingHarness.code, 'CHECK_INCONCLUSIVE')

  const setupError = `Error: Cannot find module ${discoveredNodeHarnessPath}`
  const brokenSetup = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeFingerprint: crypto.createHash('sha256').update(setupError).digest('hex'),
    commandEvents: [{
      command: genericCommand, status: 'failed', exit_code: 1,
      aggregated_output: setupError,
    }],
  })
  assert.equal(brokenSetup.code, 'CHECK_INCONCLUSIVE')

  const missingProductModule = [
    'TAP version 13',
    'not ok 1 - exports required module',
    `# Error: Cannot find module ${discoveredNodeHarnessPath}`,
    '# fail 1',
  ].join('\n')
  const missingProductModuleFailure = await runScenario({
    aggregateCode: 'FAIL', outcomeStatus: 'FAIL', authorizedCommand: null,
    outcomeFingerprint: crypto.createHash('sha256').update(missingProductModule).digest('hex'),
    commandEvents: [{
      command: genericCommand, status: 'failed', exit_code: 1,
      aggregated_output: missingProductModule,
    }],
  })
  assert.equal(missingProductModuleFailure.code, 'FAIL',
    'generic missing-file prose does not suppress a recognizable test-runner product failure')

  const wrongObservationId = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    outcomeObservationId: 'f'.repeat(64),
    commandEvents: [{
      command: genericCommand, status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(wrongObservationId.code, 'PASS',
    'a model-guessed controller observation ID is discarded instead of hiding real evidence')
  assert.notEqual(wrongObservationId.payload.testOutcomes[0].observationId, 'f'.repeat(64))

  const wrongCommandHash = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    outcomeCommandHash: 'e'.repeat(64),
    commandEvents: [{
      command: genericCommand, status: 'completed', exit_code: 0, aggregated_output: summary,
    }],
  })
  assert.equal(wrongCommandHash.code, 'CHECK_INCONCLUSIVE')

  const historicalScratchOutput = 'same frozen candidate, scratch oracle revision 1: FAIL'
  const unrelatedIntrospectionDrift = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', authorizedCommand: null,
    compactOutcomes: true,
    commandEvents: [
      {
        command: 'uname -a', status: 'completed', exit_code: 0,
        aggregated_output: 'kernel observation one',
      },
      {
        command: 'uname -a', status: 'completed', exit_code: 0,
        aggregated_output: 'kernel observation two',
      },
      {
        command: genericCommand, status: 'completed', exit_code: 0,
        aggregated_output: summary,
      },
    ],
  })
  assert.equal(unrelatedIntrospectionDrift.code, 'PASS',
    'changing output from an unrelated command cannot contradict a unique harness binding')

  const contradiction = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS',
    commandEvents: [
      {
        command: 'python3 independent_harness.py', status: 'completed', exit_code: 0,
        aggregated_output: historicalScratchOutput,
      },
      {
        command: 'python3 independent_harness.py', status: 'completed', exit_code: 0,
        aggregated_output: summary,
      },
    ],
  })
  assert.equal(contradiction.code, 'CHECK_INCONCLUSIVE')
  assert.equal(contradiction.cause.event, 'CHECK_OBSERVATION_CONTRADICTION')
  assert.equal(
    contradiction.payload.verificationObservationDisposition.conflictingCommandHashes.length,
    1,
  )

  const setupRecovery = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS',
    commandEvents: [
      {
        command: '/usr/bin/time python3 independent_harness.py', status: 'failed', exit_code: 127,
        aggregated_output: '/usr/bin/time: not found',
      },
      {
        command: 'python3 independent_harness.py', status: 'completed', exit_code: 0,
        aggregated_output: `${summary}\n`,
      },
    ],
  })
  assert.equal(setupRecovery.code, 'PASS')
  assert.equal(setupRecovery.transportEvidence.commandExecutionFailures.count, 1)

  const expectedNegativeSummary = JSON.stringify({
    tests: [{ name: 'reject-malformed-input', status: 'FAIL' }], status: 'PASS',
  })
  const expectedNegativeFingerprint = crypto.createHash('sha256')
    .update(expectedNegativeSummary).digest('hex')
  const expectedNegative = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', outcomeFingerprint: expectedNegativeFingerprint,
    commandOutput: `${expectedNegativeSummary}\n`,
  })
  assert.equal(expectedNegative.code, 'PASS',
    'an expected negative-test case is not an overall structured product failure')

  const secondCheckId = 'verification:privacy:stable-token-domain'
  const sharedHarness = await runScenario({
    aggregateCode: 'PASS', outcomeStatus: 'PASS', commandOutput: `${summary}\n`,
    checkIds: [checkId, secondCheckId],
  })
  assert.equal(sharedHarness.code, 'PASS',
    'one substantive harness event can cover multiple exact named outcomes')
  assert.equal(sharedHarness.transportEvidence.verificationObservations.count, 1)
})

test('controller receipts parse stable failure case IDs from common harness formats', () => {
  const parsedCaseIds = output => {
    const parsed = parseCodexJsonl([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'failed-command', type: 'command_execution', command: 'node test-harness.js',
          status: 'failed', exit_code: 1, aggregated_output: output,
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1, cached_input_tokens: 0, output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      }),
    ].join('\n'))
    return parsed.verificationObservations.receipts[0].failureCaseIds
  }
  assert.deepEqual(parsedCaseIds([
    'TAP version 13',
    'not ok 1 - rejects expired token',
    '# at 2026-08-28T10:00:00Z /tmp/node-test-17 random=run-17',
    '# fail 1',
  ].join('\n')), ['rejects expired token'])
  assert.deepEqual(parsedCaseIds([
    '================ FAILURES ================',
    'FAILED /tmp/pytest-18/tests/test_api.py::test_rejects_expired_token - AssertionError',
    '1 failed in 0.07s',
  ].join('\n')), ['test_rejects_expired_token'])
  assert.deepEqual(parsedCaseIds([
    'FAIL tests/token.test.js',
    '  ● token policy › rejects expired token (17 ms)',
    'Tests: 1 failed, 2 passed, 3 total',
  ].join('\n')), ['token policy › rejects expired token'])
  assert.deepEqual(parsedCaseIds([
    'TOKEN_SHAPE PASS',
    'TOKEN_EXPIRY FAIL observed timestamp=2026-08-28T10:00:00Z',
    'SELECTED_CHECK FAIL token-policy',
  ].join('\n')), ['TOKEN_EXPIRY', 'token-policy'])
  assert.deepEqual(parsedCaseIds(JSON.stringify({
    failureCount: 2,
    failures: [
      { assertionId: 'token-shape', status: 'FAILED', diagnostic: '/tmp/run-17' },
      { testName: 'token-expiry', status: 'FAIL', timestamp: '2026-08-28T10:00:00Z' },
    ],
  })), ['token-expiry', 'token-shape'])
})

test('worker result schema exposes the only transition accepted by the runtime', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
    'utf8',
  ))
  assert.deepEqual(
    schema.$defs.result.allOf[1].properties.requestedTransition.properties.event,
    { const: 'WORK_ITEM_VERIFIED' },
  )
})

test('Codex adapter sends the compatibility schema and restores canonical output before callbacks', async t => {
  const directory = temporaryDirectory(t)
  const canonicalSchema = path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json')
  let observed
  const fallbackFindingId = assignmentLocalFindingId({
    workItemId: 'dynamic-worker-repair', logicalRole: 'worker', parent: 'run-owner',
    assignment: 'Complete a dynamic repair assignment.', checks: ['Run its focused check.'],
  }, { requestEnvelopeHash: 'a'.repeat(64) })
  const canonicalOutput = canonicalWorkerResult({ findingIds: [fallbackFindingId] })
  const runner = {
    async run(spec) {
      observed = spec
      spec.onStdoutLine(JSON.stringify({
        type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111',
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(canonicalOutput) }) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 11, cached_input_tokens: 7, output_tokens: 1, reasoning_output_tokens: 0 },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop() { return { drained: true } },
  }
  let terminal
  let observedUsage
  const adapter = new CodexExecAdapter({
    runner,
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => canonicalSchema,
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    ...EXECUTION_POLICY,
    physicalExecutionPolicy: EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {},
    sessionId: 'run:DIRECT:launch-1',
    reservationId: 'reservation-1',
    onUsageDelta(value) { observedUsage = value; return { continue: true } },
    onTerminalResult(value) { terminal = value },
  })
  const providerSchema = observed.argv[observed.argv.indexOf('--output-schema') + 1]
  assert.notEqual(providerSchema, canonicalSchema)
  assert.match(observed.stdin, /AUTOPROMPT_CODEX_PROVIDER_TRANSPORT_V1/)
  assert.match(observed.stdin, /parent already activated and announced the AutoPrompt skill/)
  assert.match(observed.stdin, /Canonical output schema:/)
  const canonicalSchemaObject = JSON.parse(fs.readFileSync(canonicalSchema, 'utf8'))
  const schemaLine = observed.stdin.split('\n')
    .find(line => line.startsWith('Canonical output schema: '))
  const embeddedSchema = schemaLine.slice('Canonical output schema: '.length)
  const codexCanonicalSchemaObject = JSON.parse(embeddedSchema)
  assert.equal(
    canonicalSchemaObject.$defs.base.properties.findingIds.items.pattern,
    '^AP-[A-Z]+-[0-9]{3}$',
    'the shared provider-neutral role contract remains unchanged',
  )
  assert.equal(
    codexCanonicalSchemaObject.$defs.base.properties.findingIds.items.pattern,
    '^AP-[A-Z]+-(?:[0-9]{3}|[0-9]{78})$',
  )
  assert.equal(validateJsonSchema(canonicalSchemaObject, canonicalOutput).valid, false)
  assert.equal(validateJsonSchema(codexCanonicalSchemaObject, canonicalOutput).valid, true)
  assert.doesNotMatch(observed.stdin, /Canonical output schema: \{\n\s+"/u)
  assert.deepEqual(terminal.behaviorChanged, canonicalOutput.behaviorChanged)
  assert.deepEqual(observedUsage, { noncachedInput: 4, cachedInput: 7, output: 1, reasoning: 0 })
  assert.equal(result.reportType, 'result')
  assert.deepEqual(result.findingIds, [fallbackFindingId])
  assert.equal(Object.hasOwn(result, 'canonicalJson'), false)
})

test('fallible local bookkeeping callbacks cannot discard a schema-valid terminal result', async () => {
  for (const callbackName of [
    'onEvent', 'onFirstProductSignal', 'onSessionIdentified', 'onUsageDelta', 'onTerminalResult',
  ]) {
    let launches = 0
    let callbackAttempts = 0
    const canonicalOutput = canonicalWorkerResult({ reportId: `callback-${callbackName}` })
    const adapter = new CodexExecAdapter({
      runner: {
        async run(spec) {
          launches += 1
          for (const event of [
            { type: 'thread.started', thread_id: `thread-${callbackName}` },
            { type: 'item.completed', item: { id: 'edit-1', type: 'file_change', status: 'completed' } },
            { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(canonicalOutput) } },
            { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
          ]) spec.onStdoutLine(JSON.stringify(event))
          return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
        },
        async stop() { return { drained: true } },
      },
      targetPath: ROOT,
      profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
      outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
    })
    const callbacks = {
      [callbackName]() {
        callbackAttempts += 1
        if (callbackAttempts === 1) {
          throw Object.assign(new Error(`injected ${callbackName} persistence failure`), {
            code: 'RUN_RECORD_FAILURE',
          })
        }
        if (callbackName === 'onUsageDelta') return { continue: true }
      },
    }
    const result = await adapter.launch({
      ...EXECUTION_POLICY, physicalExecutionPolicy: EXECUTION_POLICY,
      ...adapterMissionFields('hash'),
      dispatch: { brief: 'Produce the bounded worker result.', requestPointer: { path: 'request', hash: 'hash' } },
      environment: {}, sessionId: `session-${callbackName}`, reservationId: `reservation-${callbackName}`,
      ...callbacks,
    })
    assert.equal(result.reportId, canonicalOutput.reportId, callbackName)
    assert.equal(launches, 1, callbackName)
    // A transient telemetry outage is coalesced behind one journal entry, so
    // subsequent streamed events do not multiply local callback work. Every
    // callback still receives one live attempt and one successful replay.
    assert.equal(callbackAttempts, 2, callbackName)
  }

  let persistentLaunches = 0
  let persistentAttempts = 0
  const persistentOutput = canonicalWorkerResult({ reportId: 'callback-persistent-local-outage' })
  const persistentAdapter = new CodexExecAdapter({
    runner: {
      async run(spec) {
        persistentLaunches += 1
        spec.onStdoutLine(JSON.stringify({
          type: 'thread.started', thread_id: 'thread-persistent-local-outage',
        }))
        spec.onStdoutLine(JSON.stringify({
          type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(persistentOutput) },
        }))
        spec.onStdoutLine(JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        }))
        return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
      },
      async stop() { return { drained: true } },
    },
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  await assert.rejects(() => persistentAdapter.launch({
    ...EXECUTION_POLICY, physicalExecutionPolicy: EXECUTION_POLICY,
    ...adapterMissionFields('hash', 'persistent-local-outage'),
    dispatch: { brief: 'Produce the bounded worker result.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {}, sessionId: 'session-persistent-local-outage',
    reservationId: 'reservation-persistent-local-outage',
    onTerminalResult() {
      persistentAttempts += 1
      throw Object.assign(new Error('persistent local terminal persistence outage'), {
        code: 'RUN_RECORD_FAILURE',
      })
    },
  }), error => error.code === 'CALLBACK_RECONCILIATION_PENDING' &&
    error.details.resumableCandidate &&
    error.details.resumableCandidate.kind === 'callback-reconciliation-candidate')
  assert.equal(persistentLaunches, 1)
  assert.equal(persistentAttempts, 4)

  let launches = 0
  const canonicalOutput = canonicalWorkerResult({ reportId: 'integrity-terminal' })
  const adapter = new CodexExecAdapter({
    runner: {
      async run(spec) {
        launches += 1
        spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-integrity' }))
        spec.onStdoutLine(JSON.stringify({
          type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(canonicalOutput) },
        }))
        spec.onStdoutLine(JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        }))
        return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
      },
      async stop() { return { drained: true } },
    },
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  await assert.rejects(() => adapter.launch({
    ...EXECUTION_POLICY, physicalExecutionPolicy: EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: 'Produce the bounded worker result.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {}, sessionId: 'session-integrity', reservationId: 'reservation-integrity',
    onTerminalResult() {
      throw Object.assign(new Error('injected unsafe receipt'), { code: 'RUN_RECORD_UNSAFE' })
    },
  }), error => error.code === 'RUN_RECORD_UNSAFE')
  assert.equal(launches, 1)
})

test('Codex terminal boundary accepts closure of pre-final items but rejects newly-started work', () => {
  const output = { canonicalJson: JSON.stringify(canonicalWorkerResult({ reportId: 'lifecycle-final' })) }
  const thread = { type: 'thread.started', thread_id: '14141414-1414-4414-8414-141414141414' }
  const priorTodo = {
    type: 'item.updated',
    item: { id: 'item_1', type: 'todo_list', items: [{ text: 'Finish work', completed: true }] },
  }
  const final = {
    type: 'item.completed',
    item: { id: 'item_27', type: 'agent_message', text: JSON.stringify(output) },
  }
  const closeTodo = {
    type: 'item.completed',
    item: { id: 'item_1', type: 'todo_list', items: [{ text: 'Finish work', completed: true }] },
  }
  const completed = {
    type: 'turn.completed',
    usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 },
  }
  const acceptedEvents = [thread, priorTodo, final, closeTodo, completed]
  const buffered = parseCodexJsonl(`${acceptedEvents.map(JSON.stringify).join('\n')}\n`)
  assert.equal(JSON.parse(buffered.output.canonicalJson).reportId, 'lifecycle-final')

  const streamed = createCodexJsonlAccumulator()
  acceptedEvents.forEach((event, index) => streamed.push(JSON.stringify(event), index + 1))
  assert.deepEqual(streamed.snapshot().output, buffered.output)

  for (const postFinalEvent of [
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'true' } },
    { type: 'item.completed', item: { id: 'item_new', type: 'command_execution', command: 'true' } },
  ]) {
    const rejected = parseCodexJsonl([
      thread, priorTodo, final, postFinalEvent, completed,
    ].map(JSON.stringify).join('\n'))
    assert.equal(rejected.output, null)
  }

  const inFlightCommand = {
    type: 'item.started',
    item: { id: 'item_command', type: 'command_execution', command: 'long-running-check' },
  }
  const commandClosureAfterFinal = {
    type: 'item.completed',
    item: {
      id: 'item_command', type: 'command_execution', command: 'long-running-check',
      status: 'completed', exit_code: 0,
    },
  }
  const premature = parseCodexJsonl([
    thread, priorTodo, inFlightCommand, final, commandClosureAfterFinal, completed,
  ].map(JSON.stringify).join('\n'))
  assert.equal(premature.output, null)

  const neverClosed = parseCodexJsonl([
    thread, inFlightCommand, final, completed,
  ].map(JSON.stringify).join('\n'))
  assert.equal(neverClosed.output, null,
    'turn.completed cannot commit a final message while earlier work remains in flight')

  const closedBeforeFinal = parseCodexJsonl([
    thread, inFlightCommand, commandClosureAfterFinal, final, completed,
  ].map(JSON.stringify).join('\n'))
  assert.equal(JSON.parse(closedBeforeFinal.output.canonicalJson).reportId, 'lifecycle-final')

  const typeChangedClosure = parseCodexJsonl([
    thread, inFlightCommand, final,
    { type: 'item.completed', item: { id: 'item_command', type: 'todo_list', items: [] } },
    completed,
  ].map(JSON.stringify).join('\n'))
  assert.equal(typeChangedClosure.output, null)
})

test('persisted assignment reads reject a symlink before following its JSON target', t => {
  const directory = temporaryDirectory(t)
  const outside = path.join(directory, 'outside-assignment.json')
  const linked = path.join(directory, 'linked-assignment.json')
  const assignment = {
    schemaVersion: '2.0.0', reportType: 'assignment', assignmentId: 'work-1',
    runId: 'run-1', requestEnvelopeHash: 'a'.repeat(64), findingIds: ['finding-1'],
    resources: [], successChecklist: ['done'], checks: ['check'],
    forbiddenChanges: ['outside'], resultLocation: 'work/results/result.json',
  }
  fs.writeFileSync(outside, `${JSON.stringify(assignment)}\n`)
  try { fs.symlinkSync(outside, linked, 'file') } catch (error) {
    t.skip(`file symlinks are unavailable: ${error.code || error.message}`)
    return
  }
  assert.throws(
    () => readPersistedWorkerAssignment({ resolve: () => linked }, 'work-1', {
      runId: 'run-1', requestEnvelopeHash: 'a'.repeat(64),
    }),
    error => error.code === 'ACTIVATION_RECEIPT_INVALID',
  )
})

test('Codex adapter preserves a final CHECK_INCONCLUSIVE instead of reconstructing FAIL', async t => {
  const directory = temporaryDirectory(t)
  const canonicalOutput = canonicalOutcome('CHECK_INCONCLUSIVE', {
    runId: 'run-inconclusive',
    payload: {
      unblockPath: 'provide isolated scratch storage',
      verificationObservationDisposition: { reportedAggregateCode: 'PASS' },
    },
  })
  let stopReason = null
  let terminal = null
  const runner = {
    async run(spec) {
      spec.onStdoutLine(JSON.stringify({
        type: 'thread.started', thread_id: '44444444-4444-4444-8444-444444444444',
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(canonicalOutput) }) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0 },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop(spec) { stopReason = spec.reason; return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    ...CHECKER_EXECUTION_POLICY,
    physicalExecutionPolicy: CHECKER_EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: 'Check the bounded candidate.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {}, sessionId: 'run:DIRECT:check-inconclusive', reservationId: 'reservation-inconclusive',
    onUsageDelta() { return { continue: true } },
    onTerminalResult(value) { terminal = value },
  })
  assert.equal(stopReason, 'typed terminal CHECK_INCONCLUSIVE')
  assert.equal(result.code, 'CHECK_INCONCLUSIVE')
  assert.equal(terminal.code, 'CHECK_INCONCLUSIVE')
  assert.equal(Object.hasOwn(result.payload, 'verificationObservationDisposition'), false,
    'a direct model-authored inconclusive result cannot forge controller binding disposition')
  assert.equal(Object.hasOwn(result, 'reconstructedTerminal'), false)
})

test('Codex adapter uses the last agent message at turn.completed even when earlier messages are schema-valid', async t => {
  const directory = temporaryDirectory(t)
  const invalid = canonicalOutcome('INVALID_INPUT', {
    description: 'The supplied input does not match the required format or facts.',
    cause: { event: 'INPUT_REJECTED', reason: 'The checker rejected its input.', unblockPath: 'Retry with the exact assignment.' },
  })
  const pass = canonicalOutcome('PASS')
  const launchWith = async (outputs, suffix, buffered = false) => {
    const runner = {
      async run(spec) {
        const events = [{
          type: 'thread.started', thread_id: `99999999-9999-4999-8999-99999999999${suffix}`,
        }]
        for (const output of outputs) {
          events.push({
            type: 'item.completed',
            item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(output) }) },
          })
        }
        events.push({
          type: 'turn.completed',
          usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        })
        if (!buffered) for (const event of events) spec.onStdoutLine(JSON.stringify(event))
        return {
          status: 0, stdout: buffered ? `${events.map(JSON.stringify).join('\n')}\n` : '', stderr: '',
          processOwned: true, exactArgv: true, drained: true,
        }
      },
      async stop() { return { drained: true } },
    }
    const adapter = new CodexExecAdapter({
      runner, targetPath: ROOT,
      profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
      outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
      providerSchemaRoot: path.join(directory, `provider-schemas-${suffix}`),
    })
    return adapter.launch({
      ...CHECKER_EXECUTION_POLICY, physicalExecutionPolicy: CHECKER_EXECUTION_POLICY,
    ...adapterMissionFields('a'.repeat(64)),
    dispatch: { brief: 'Run the exact check.', requestPointer: { path: 'request', hash: 'a'.repeat(64) } },
      environment: {}, sessionId: `terminal-conflict-${suffix}`, reservationId: `terminal-conflict-reservation-${suffix}`,
    })
  }

  assert.equal((await launchWith([invalid, pass], '1')).code, 'PASS')
  assert.equal((await launchWith([pass, invalid], '2')).code, 'RUNTIME_FAILURE')
  assert.equal((await launchWith([pass, pass], '3')).code, 'PASS')
  assert.equal((await launchWith([invalid, pass], '4', true)).code, 'PASS')
  assert.equal((await launchWith([pass, invalid], '5', true)).code, 'RUNTIME_FAILURE')
  assert.equal((await launchWith([pass, pass], '6', true)).code, 'PASS')
  assert.equal((await launchWith([invalid, ...Array(256).fill(pass)], '7', true)).code, 'PASS')
})

test('Codex route analyst may revise a schema-valid provisional recommendation before turn.completed', async t => {
  const directory = temporaryDirectory(t)
  const recommendation = (route, confidence, reason) => createRouteRecommendation({
    schemaVersion: '2.0.0', preWorkResult: 'CONTINUE', recommendedRoute: route, confidence,
    whatTheUserWants: ['Complete the requested benchmark deliverable.'],
    likelyAreas: ['/app'],
    howSuccessCanBeChecked: ['Run the authoritative verifier.'],
    unknowns: [], risks: [], independentWorkItems: [], dependencies: [],
    reasonsForDirect: [reason], reasonsForLight: [reason], reasonsForRoadmap: [reason],
    userInputNeeded: [], evidenceIndex: [],
  })
  const provisional = recommendation('LIGHT', 'low', 'Evidence inspection is still in progress.')
  const final = recommendation('ROADMAP', 'high', 'Observed dependent work groups require an integration owner.')
  let stopReason = null
  const runner = {
    async run(spec) {
      const events = [
        { type: 'thread.started', thread_id: '77777777-7777-4777-8777-777777777777' },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(provisional) }) } },
        { type: 'item.started', item: { type: 'command_execution', command: 'find /app -maxdepth 2 -type f', status: 'in_progress' } },
        { type: 'item.completed', item: { type: 'command_execution', command: 'find /app -maxdepth 2 -type f', status: 'completed', exit_code: 0 } },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(final) }) } },
        { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 } },
      ]
      for (const event of events) spec.onStdoutLine(JSON.stringify(event))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop(spec) { stopReason = spec.reason; return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'route-recommendation.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    logicalRole: 'route-analyst', physicalRole: 'autoprompt.v2.route-analyst',
    providerRole: 'ap-route-analyst', sandboxMode: 'read-only',
    policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
    route: 'PRE_ROUTE', physicalExecutionPolicy: {
      logicalRole: 'route-analyst', physicalRole: 'autoprompt.v2.route-analyst',
      providerRole: 'ap-route-analyst', sandboxMode: 'read-only',
      policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
    },
    ...adapterMissionFields('a'.repeat(64)),
    dispatch: { brief: 'Recommend the route.', requestPointer: { path: 'request', hash: 'a'.repeat(64) } },
    environment: {}, sessionId: 'route-revision', reservationId: 'route-revision-reservation',
    onUsageDelta() { return { continue: true } },
  })
  assert.equal(stopReason, 'typed terminal CONTINUE')
  assert.equal(result.recommendedRoute, 'ROADMAP')
  assert.equal(result.recommendation.recommendedRoute, 'ROADMAP')
  assert.equal(result.reconstructedTerminal, undefined)
})

test('Codex preserves shared route vocabulary and recovers malformed f1de11a task briefs', async t => {
  const directory = temporaryDirectory(t)
  const proposals = [
    {
      id: 'html-js-filter', route: 'LIGHT',
      mutableResources: [{
        kind: 'file', identity: '/app/filter.py', shared: false,
        ownershipMode: 'single-owner implementation',
      }],
      sideEffects: [
        'Creates or replaces /app/filter.py.',
        'When executed, the program rewrites the user-supplied HTML file in place.',
      ],
      baselineStatus: 'unknown',
    },
    {
      id: 'cad-model', route: 'LIGHT',
      mutableResources: [{
        kind: 'file', identity: '/app/out.step', shared: false,
        ownershipMode: 'single-writer output artifact',
      }],
      sideEffects: ['Create or replace /app/out.step.'],
    },
    {
      id: 'production-planning', route: 'ROADMAP',
      mutableResources: [{
        kind: 'database', identity: 'ERP planning_runs and planned_work_orders', shared: true,
        ownershipMode: 'gateway-only coordinated write',
      }],
      sideEffects: [
        'Creates three SQL artifacts.',
        'Inserts planning, work-order, dispatch, and reservation records into three databases.',
      ],
      baselineStatus: 'unknown',
    },
    {
      id: 'data-anonymization', route: 'ROADMAP',
      mutableResources: [{
        kind: 'source-file', identity: '/app/anon.py', shared: false,
        ownershipMode: 'single implementation owner',
      }],
      sideEffects: ['Creates or replaces anonymized CSV artifacts under /app/output.'],
      architectureImpact: 'single-system',
    },
    {
      id: 'shared-only-minor-impact', route: 'DIRECT',
      mutableResources: [{
        kind: 'file', identity: '/app/minor.txt', shared: false, ownershipMode: 'single-owner',
      }],
      sideEffects: ['deliverable-write'],
      thirdPartyImpact: 'minor',
    },
    {
      id: 'shared-only-duplicate-check-kind', route: 'DIRECT',
      mutableResources: [{
        kind: 'file', identity: '/app/duplicate-check.txt', shared: false,
        ownershipMode: 'single-owner',
      }],
      sideEffects: ['deliverable-write'],
      availableCheckKinds: ['focused-test', 'focused-test'],
    },
  ]
  const executionPolicy = {
    logicalRole: 'route-analyst', physicalRole: 'autoprompt.v2.route-analyst',
    providerRole: 'ap-route-analyst', sandboxMode: 'read-only',
    policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
  }
  let projectedProviderSchema = null

  for (const proposal of proposals) {
    const recommendation = createRouteRecommendation({
      schemaVersion: '2.0.0', preWorkResult: 'CONTINUE',
      recommendedRoute: proposal.route, confidence: 'high',
      whatTheUserWants: [`Complete the ${proposal.id} benchmark deliverable.`],
      likelyAreas: ['/app'], howSuccessCanBeChecked: ['Run the authoritative verifier.'],
      unknowns: [], risks: [], independentWorkItems: [], dependencies: [],
      reasonsForDirect: ['The work has one bounded implementation owner.'],
      reasonsForLight: ['A short reversible implementation choice may be useful.'],
      reasonsForRoadmap: ['Dependent work would require explicit coordination.'],
      userInputNeeded: [], evidenceIndex: [],
    })
    recommendation.routeFactProposal.mutableResources = proposal.mutableResources
    recommendation.routeFactProposal.sideEffects = proposal.sideEffects
    for (const field of [
      'thirdPartyImpact', 'baselineStatus', 'architectureImpact', 'availableCheckKinds',
    ]) {
      if (proposal[field]) recommendation.routeFactProposal[field] = proposal[field]
    }
    assert.equal(validateJsonSchema(
      require(path.join(ROOT, 'agents', 'contracts', 'schemas', 'route-recommendation.schema.json')),
      recommendation,
    ).valid, true, `${proposal.id} reproduces the shared-schema acceptance gap`)

    let providerPrompt = ''
    let stopReason = null
    const acceptedTerminals = []
    const runner = {
      async run(spec) {
        providerPrompt = spec.stdin
        for (const event of [
          { type: 'thread.started', thread_id: `route-replay-${proposal.id}` },
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: JSON.stringify({ canonicalJson: JSON.stringify(recommendation) }),
            },
          },
          {
            type: 'turn.completed',
            usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          },
        ]) spec.onStdoutLine(JSON.stringify(event))
        return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
      },
      async stop(spec) { stopReason = spec.reason; return { drained: true } },
    }
    const adapter = new CodexExecAdapter({
      runner, targetPath: ROOT,
      profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
      outputSchemaResolver: () => path.join(
        ROOT, 'agents', 'contracts', 'schemas', 'route-recommendation.schema.json',
      ),
      providerSchemaRoot: path.join(directory, `provider-schemas-${proposal.id}`),
    })
    const result = await adapter.launch({
      ...executionPolicy, route: 'PRE_ROUTE', physicalExecutionPolicy: executionPolicy,
      ...adapterMissionFields('a'.repeat(64)),
      dispatch: {
        brief: 'Recommend the route.',
        requestPointer: { path: 'request', hash: 'a'.repeat(64) },
      },
      environment: {}, sessionId: `route-replay-${proposal.id}`,
      reservationId: `route-replay-reservation-${proposal.id}`,
      onUsageDelta() { return { continue: true } },
      onTerminalResult(value) { acceptedTerminals.push(value) },
    })
    const schemaLine = providerPrompt.split('\n')
      .find(line => line.startsWith('Canonical output schema: '))
    const providerSchema = JSON.parse(schemaLine.slice('Canonical output schema: '.length))
    projectedProviderSchema = providerSchema
    const providerProposal = providerSchema.properties.routeFactProposal.properties
    assert.deepEqual(
      providerProposal.mutableResources,
      routeRouter.ROUTE_FACTS_SCHEMA.properties.mutableResources,
    )
    assert.deepEqual(providerProposal.sideEffects, routeRouter.ROUTE_FACTS_SCHEMA.properties.sideEffects)
    assert.deepEqual(providerProposal.thirdPartyImpact.enum,
      ['none', 'minor', 'material', 'incidental'])
    assert.deepEqual(providerProposal.baselineStatus.enum,
      ['recorded', 'not-applicable', 'unknown', 'required-before-production', 'unavailable'])
    assert.deepEqual(providerProposal.architectureImpact.enum,
      ['local', 'single-system', 'multi-system', 'public-contract'])
    assert.equal(providerProposal.namedDistinctResponsibilities.uniqueItems, true)
    assert.equal(providerProposal.availableCheckKinds.uniqueItems, true)
    assert.equal(providerProposal.availableCheckKinds.minItems, 1)
    const providerValid = proposal.id === 'shared-only-minor-impact'
    assert.equal(validateJsonSchema(providerSchema, recommendation).valid, providerValid)
    assert.equal(stopReason, providerValid
      ? 'typed terminal CONTINUE'
      : 'completed turn requires canonical correction')
    assert.equal(result.reconstructedTerminal, undefined)
    assert.equal(result.recommendedRoute, 'DIRECT')
    assert.equal(result.confidence, providerValid ? 'high' : 'low')
    assert.deepEqual(result.whatTheUserWants, recommendation.whatTheUserWants)
    assert.deepEqual(result.likelyAreas, recommendation.likelyAreas)
    assert.deepEqual(result.howSuccessCanBeChecked, recommendation.howSuccessCanBeChecked)
    assert.deepEqual(result.verificationObligations, recommendation.verificationObligations)
    if (providerValid) {
      assert.deepEqual(result.routeFactProposal, recommendation.routeFactProposal,
        `${proposal.id} provider-contract vocabulary must retain route authority`)
    } else {
      assert.notDeepEqual(result.routeFactProposal, recommendation.routeFactProposal,
        `${proposal.id} malformed model-authored route authority must be discarded`)
    }
    assert.equal(acceptedTerminals.length, 1)
    assert.equal(acceptedTerminals[0].recommendedRoute, 'DIRECT')
    assert.deepEqual(acceptedTerminals[0].whatTheUserWants, recommendation.whatTheUserWants,
      `${proposal.id} task detail must survive conservative route recovery`)
  }

  const projectedValid = createRouteRecommendation({
    preWorkResult: 'CONTINUE', recommendedRoute: 'DIRECT', confidence: 'high',
    whatTheUserWants: ['Preserve this exact provider-authored success item.'],
    likelyAreas: ['/app/projected-valid.txt'],
    howSuccessCanBeChecked: ['Run the projected contract check.'],
    unknowns: [], risks: [], independentWorkItems: [], dependencies: [],
    reasonsForDirect: ['The bounded mutation has one owner and no unresolved design choice.'],
    reasonsForLight: ['No reversible technical uncertainty requires short planning.'],
    reasonsForRoadmap: ['No dependent work groups require coordination.'],
    userInputNeeded: [], evidenceIndex: [],
  })
  projectedValid.routeFactProposal.mutableResources = [{
    kind: 'file', identity: '/app/projected-valid.txt', shared: false,
    ownershipMode: 'single-owner',
  }]
  assert.equal(validateJsonSchema(projectedProviderSchema, projectedValid).valid, true)
  const compiled = compileAutomaticRouteDecision({
    recommendation: projectedValid,
    requestedResult: 'Compile the provider-authored recommendation.',
    requestEnvelopeHash: 'a'.repeat(64), providerCapabilities: PROVIDER_CAPABILITIES,
    budget: { remaining: { wallMs: 60 * 60 * 1000 } }, nowMs: 1,
  })
  assert.equal(compiled.route, 'DIRECT')
  assert.deepEqual(compiled.successChecklist, projectedValid.whatTheUserWants,
    'the projected-valid proposal compiles directly instead of using the generic fallback')
  assert.deepEqual(compiled.likelyAreas, projectedValid.likelyAreas)

  const sharedVocabulary = structuredClone(projectedValid)
  sharedVocabulary.routeFactProposal.thirdPartyImpact = 'minor'
  sharedVocabulary.routeFactProposal.baselineStatus = 'unknown'
  sharedVocabulary.routeFactProposal.architectureImpact = 'single-system'
  assert.equal(validateJsonSchema(projectedProviderSchema, sharedVocabulary).valid, true)
  const translated = compileAutomaticRouteDecision({
    recommendation: sharedVocabulary,
    requestedResult: 'Compile provider-neutral facts without discarding the route.',
    requestEnvelopeHash: 'b'.repeat(64), providerCapabilities: PROVIDER_CAPABILITIES,
    budget: { remaining: { wallMs: 60 * 60 * 1000 } }, nowMs: 2,
  })
  assert.equal(translated.normalizedRouteFacts.thirdPartyImpact, 'incidental')
  assert.equal(translated.normalizedRouteFacts.checkAndBaseline.baselineStatus, 'required-before-production')
  assert.equal(translated.normalizedRouteFacts.architectureImpact, 'local')
  assert.deepEqual(translated.successChecklist, sharedVocabulary.whatTheUserWants)

  const routerVocabulary = structuredClone(projectedValid)
  routerVocabulary.recommendedRoute = 'ROADMAP'
  routerVocabulary.routeFactProposal.thirdPartyImpact = 'incidental'
  routerVocabulary.routeFactProposal.baselineStatus = 'unavailable'
  routerVocabulary.routeFactProposal.architectureImpact = 'public-contract'
  assert.equal(validateJsonSchema(projectedProviderSchema, routerVocabulary).valid, true)
  const routerNative = compileAutomaticRouteDecision({
    recommendation: routerVocabulary,
    requestedResult: 'Compile canonical Codex router facts without lossy aliases.',
    requestEnvelopeHash: 'c'.repeat(64), providerCapabilities: PROVIDER_CAPABILITIES,
    budget: { remaining: { wallMs: 60 * 60 * 1000 } }, nowMs: 3,
  })
  assert.equal(routerNative.route, 'ROADMAP')
  assert.equal(routerNative.normalizedRouteFacts.thirdPartyImpact, 'incidental')
  assert.equal(routerNative.normalizedRouteFacts.checkAndBaseline.baselineStatus, 'unavailable')
  assert.equal(routerNative.normalizedRouteFacts.architectureImpact, 'public-contract')
})

test('Codex correction boundary suppresses late session and usage callbacks without a valid terminal', async t => {
  const directory = temporaryDirectory(t)
  const sessions = []
  const usage = []
  const invalid = { canonicalJson: JSON.stringify({ schemaVersion: '2.0.0', preWorkResult: 'CONTINUE' }) }
  const runner = {
    async run(spec) {
      for (const event of [
        { type: 'thread.started', thread_id: '22222222-3333-4222-8222-222222222222' },
        { type: 'thread.started', thread_id: '00000000-3333-4000-8000-000000000000' },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(invalid) } },
        { type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
        { type: 'thread.started', thread_id: '11111111-3333-4111-8111-111111111111' },
        { type: 'turn.completed', usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 0 } },
      ]) spec.onStdoutLine(JSON.stringify(event))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop() { return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'route-recommendation.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const executionPolicy = {
    logicalRole: 'route-analyst', physicalRole: 'autoprompt.v2.route-analyst',
    providerRole: 'ap-route-analyst', sandboxMode: 'read-only',
    policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
  }
  const result = await adapter.launch({
    ...executionPolicy, route: 'PRE_ROUTE', physicalExecutionPolicy: executionPolicy,
    ...adapterMissionFields('a'.repeat(64)),
    dispatch: { brief: 'Recommend the route.', requestPointer: { path: 'request', hash: 'a'.repeat(64) } },
    environment: {}, sessionId: 'route-correction-boundary', reservationId: 'route-correction-boundary-reservation',
    onSessionIdentified(value) { sessions.push(value) },
    onUsageDelta(delta) { usage.push(delta); return { continue: true } },
  })
  assert.deepEqual(sessions, ['22222222-3333-4222-8222-222222222222'])
  assert.equal(usage.length, 1)
  assert.equal(result.contextId, '22222222-3333-4222-8222-222222222222')
  assert.equal(result.reconstructedTerminal, undefined)
  assert.equal(result.recommendedRoute, 'DIRECT')
  assert.equal(result.confidence, 'low')
})

test('Codex L0 owner may replace an internal WAITING_USER progress message with its final decision', async t => {
  const directory = temporaryDirectory(t)
  const provisional = {
    schemaVersion: '2.0.0', status: 'WAITING_USER', route: null, routeSource: 'automatic',
    requestEnvelopeHash: 'a'.repeat(64), recommendationHash: 'b'.repeat(64),
    decidedAt: '2026-08-26T14:45:42.638Z',
    userInputNeeded: ['Internal route inspection is still in progress.'],
  }
  const final = canonicalDirectRouteDecision()
  let stopReason = null
  const runner = {
    async run(spec) {
      for (const event of [
        { type: 'thread.started', thread_id: '33333333-4444-4333-8333-333333333333' },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(provisional) }) } },
        { type: 'item.started', item: { type: 'command_execution', command: 'inspect-route-evidence', status: 'in_progress' } },
        { type: 'item.completed', item: { type: 'command_execution', command: 'inspect-route-evidence', status: 'completed', exit_code: 0 } },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(final) }) } },
        { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 } },
      ]) spec.onStdoutLine(JSON.stringify(event))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop(spec) { stopReason = spec.reason; return { drained: true } },
  }
  const executionPolicy = {
    logicalRole: 'run-owner', physicalRole: 'autoprompt.v2.run-owner',
    providerRole: 'ap-run-owner', sandboxMode: 'read-only',
    policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'route-decision.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    ...executionPolicy, route: 'PRE_ROUTE', physicalExecutionPolicy: executionPolicy,
    ...adapterMissionFields('a'.repeat(64)),
    dispatch: { brief: 'Decide the route.', requestPointer: { path: 'request', hash: 'a'.repeat(64) } },
    environment: {}, sessionId: 'l0-revision', reservationId: 'l0-revision-reservation',
    onUsageDelta() { return { continue: true } },
  })
  assert.equal(stopReason, 'typed terminal DECIDED')
  assert.equal(result.status, 'DECIDED')
  assert.equal(result.route, 'DIRECT')
  assert.equal(result.reconstructedTerminal, undefined)
})

test('Codex adapter never promotes a schema-valid message followed by unfinished turn work', async t => {
  const directory = temporaryDirectory(t)
  const provisional = canonicalOutcome('PASS')
  let activeEvents = [
    { type: 'thread.started', thread_id: '44444444-4444-4444-8444-444444444444' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(provisional) }) } },
    { type: 'item.started', item: { type: 'command_execution', command: 'true', status: 'in_progress' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'true', status: 'completed', exit_code: 0 } },
    { type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
  ]
  const adapter = new CodexExecAdapter({
    runner: {
      async run() {
        return {
          status: 0, stdout: `${activeEvents.map(JSON.stringify).join('\n')}\n`, stderr: '',
          processOwned: true, exactArgv: true, drained: true,
        }
      },
      async stop() { return { drained: true } },
    },
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const launch = suffix => adapter.launch({
    ...CHECKER_EXECUTION_POLICY, physicalExecutionPolicy: CHECKER_EXECUTION_POLICY,
    runId: `run-stale-terminal-${suffix}`, candidateHash: 'b'.repeat(64),
    ...adapterMissionFields('a'.repeat(64)),
    dispatch: { brief: 'Run the exact check.', requestPointer: { path: 'request', hash: 'a'.repeat(64) } },
    environment: {}, sessionId: `stale-terminal-${suffix}`, reservationId: `stale-terminal-reservation-${suffix}`,
  })
  const result = await launch('missing')
  assert.equal(result.code, 'RUNTIME_FAILURE')
  assert.equal(result.payload.reconstructedTerminal, true)
  activeEvents = [
    ...activeEvents.slice(0, -1),
    { type: 'item.completed', item: { type: 'agent_message', text: '' } },
    activeEvents.at(-1),
  ]
  const emptyResult = await launch('empty')
  assert.equal(emptyResult.code, 'RUNTIME_FAILURE')
  assert.equal(emptyResult.payload.reconstructedTerminal, true)
  activeEvents = [
    activeEvents[0], activeEvents[1],
    { type: 'item.started' },
    activeEvents.at(-1),
  ]
  const malformedWorkResult = await launch('malformed-work')
  assert.equal(malformedWorkResult.code, 'RUNTIME_FAILURE')
  assert.equal(malformedWorkResult.payload.reconstructedTerminal, true)
})

test('bundled canonical schemas reject every missing required field and unknown top-level fields', () => {
  const outcomeSchema = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'), 'utf8',
  ))
  const roleSchema = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'), 'utf8',
  ))
  const outcome = canonicalOutcome('PASS')
  const role = canonicalWorkerResult()
  assert.equal(validateJsonSchema(outcomeSchema, outcome).valid, true)
  assert.equal(validateJsonSchema(roleSchema, role).valid, true)
  for (const field of outcomeSchema.required) {
    const malformed = { ...outcome }
    delete malformed[field]
    assert.equal(validateJsonSchema(outcomeSchema, malformed).valid, false, `outcome accepted without ${field}`)
  }
  assert.equal(validateJsonSchema(outcomeSchema, { ...outcome, undeclared: true }).valid, false)
  assert.equal(validateJsonSchema(roleSchema, { ...role, undeclared: true }).valid, false)
  assert.equal(validateJsonSchema(roleSchema, {
    ...role,
    commands: [{ command: 'true', exitCode: 'zero', result: 'passed' }],
  }).valid, false)
  assert.equal(validateJsonSchema({ type: 'array', contains: { const: 'required' } }, ['other']).valid, false)
  assert.equal(validateJsonSchema({
    type: 'object', minProperties: 1, maxProperties: 1,
    propertyNames: { pattern: '^[a-z]+$' }, additionalProperties: true,
  }, {}).valid, false)
  assert.equal(validateJsonSchema({
    type: 'object', propertyNames: { pattern: '^[a-z]+$' }, additionalProperties: true,
  }, { INVALID: true }).valid, false)
})

test('Codex adapter preserves a canonical RUNTIME_FAILURE as a direct terminal result', async t => {
  const directory = temporaryDirectory(t)
  const canonicalOutput = canonicalOutcome('RUNTIME_FAILURE')
  let stopReason = null
  const runner = {
    async run(spec) {
      spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: '66666666-6666-4666-8666-666666666666' }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(canonicalOutput) }) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0 },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop(spec) { stopReason = spec.reason; return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    ...CHECKER_EXECUTION_POLICY, physicalExecutionPolicy: CHECKER_EXECUTION_POLICY,
    ...adapterMissionFields('a'.repeat(64)),
    dispatch: { brief: 'Run the exact check.', requestPointer: { path: 'request', hash: 'a'.repeat(64) } },
    environment: {}, sessionId: 'runtime-failure', reservationId: 'runtime-failure-reservation',
  })
  assert.equal(stopReason, 'typed terminal RUNTIME_FAILURE')
  assert.equal(result.code, 'RUNTIME_FAILURE')
  assert.equal(Object.hasOwn(result, 'reconstructedTerminal'), false)
})

test('Codex adapter drains a schema-incomplete checker PASS and reconstructs a bound runtime failure', async t => {
  const directory = temporaryDirectory(t)
  let terminal = null
  let stopReason = null
  const runner = {
    async run(spec) {
      spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: '77777777-7777-4777-8777-777777777777' }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify({ code: 'PASS' }) }) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop({ reason }) { stopReason = reason; return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    ...CHECKER_EXECUTION_POLICY, physicalExecutionPolicy: CHECKER_EXECUTION_POLICY,
    runId: 'run-malformed', candidateHash: 'b'.repeat(64),
    ...adapterMissionFields('a'.repeat(64)),
    dispatch: { brief: 'Run the exact check.', requestPointer: { path: 'request', hash: 'a'.repeat(64) } },
    environment: {}, sessionId: 'malformed-pass', reservationId: 'malformed-pass-reservation',
    onTerminalResult(value) { terminal = value },
  })
  assert.equal(stopReason, 'typed terminal RUNTIME_FAILURE')
  assert.equal(result.code, 'RUNTIME_FAILURE')
  assert.equal(result.runId, 'run-malformed')
  assert.equal(result.requestEnvelopeHash, 'a'.repeat(64))
  assert.equal(result.currentVersionHash, 'b'.repeat(64))
  assert.equal(result.payload.reconstructedTerminal, true)
  assert.deepEqual(terminal, result)
})

test('Codex adapter returns the exact committed terminal receipt despite a late buffered agent message', async t => {
  const directory = temporaryDirectory(t)
  const committed = canonicalWorkerResult({ reportId: 'committed-result' })
  const late = canonicalWorkerResult({ reportId: 'late-result', behaviorChanged: ['Late buffered text.'] })
  let terminal = null
  let terminalCount = 0
  const identifiedSessions = []
  const runner = {
    async run(spec) {
      spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: '88888888-8888-4888-8888-888888888888' }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(committed) }) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'thread.started', thread_id: '99999999-8888-4888-8888-888888888888',
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(late) }) },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop() { return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    ...EXECUTION_POLICY, physicalExecutionPolicy: EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {}, sessionId: 'committed-race', reservationId: 'committed-race-reservation',
    onSessionIdentified(value) { identifiedSessions.push(value) },
    onTerminalResult(value) { terminal = value; terminalCount += 1 },
  })
  assert.equal(terminalCount, 1)
  assert.equal(result.reportId, 'committed-result')
  assert.equal(result.contextId, '88888888-8888-4888-8888-888888888888')
  assert.deepEqual(identifiedSessions, ['88888888-8888-4888-8888-888888888888'])
  assert.deepEqual(result, terminal)
  assert.notEqual(result.reportId, late.reportId)
})

test('Codex buffered parser freezes the final message at the first turn.completed boundary', async t => {
  const directory = temporaryDirectory(t)
  const committed = canonicalWorkerResult({ reportId: 'buffered-committed-result' })
  const late = canonicalWorkerResult({ reportId: 'buffered-late-result' })
  const events = [
    { type: 'thread.started', thread_id: '66666666-6666-4666-8666-666666666666' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(committed) }) } },
    { type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    { type: 'thread.started', thread_id: '55555555-5555-4555-8555-555555555555' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(late) }) } },
  ]
  const runner = {
    async run() {
      return {
        status: 0, stdout: `${events.map(JSON.stringify).join('\n')}\n`, stderr: '',
        processOwned: true, exactArgv: true, drained: true,
      }
    },
    async stop() { return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    ...EXECUTION_POLICY, physicalExecutionPolicy: EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {}, sessionId: 'buffered-boundary', reservationId: 'buffered-boundary-reservation',
  })
  assert.equal(result.reportId, committed.reportId)
  assert.equal(result.contextId, '66666666-6666-4666-8666-666666666666')
  assert.notEqual(result.reportId, late.reportId)
  assert.equal(Object.hasOwn(result, 'events'), false)
  assert.equal(result.transportEvidence.eventCount, 3)
  assert.equal(result.transportEvidence.retainedEventCount, 3)
  assert.match(result.transportEvidence.eventStreamHash, /^[a-f0-9]{64}$/u)
  assert.match(result.transportEvidence.rawOutputHash, /^[a-f0-9]{64}$/u)
})

test('Codex streamed and buffered delivery commit identical boundary results and evidence hashes', async t => {
  const directory = temporaryDirectory(t)
  const output = canonicalWorkerResult({ reportId: 'delivery-parity-result' })
  const events = [
    { type: 'thread.started', thread_id: '12121212-1212-4212-8212-121212121212' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(output) }) } },
    { type: 'turn.completed', usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 } },
    { type: 'thread.started', thread_id: '13131313-1313-4313-8313-131313131313' },
  ]
  // A stopped JSONL writer may leave a truncated late fragment. It is outside
  // the completed turn boundary and cannot invalidate the committed result.
  const lines = [...events.map(event => `  ${JSON.stringify(event)}  `), '{']
  const launchWith = async (buffered, suffix) => {
    let terminalEvidence = null
    const adapter = new CodexExecAdapter({
      runner: {
        async run(spec) {
          if (!buffered) for (const line of lines) spec.onStdoutLine(line)
          return {
            status: 0, stdout: buffered ? `${lines.join('\n')}\n` : '', stderr: '',
            processOwned: true, exactArgv: true, drained: true,
          }
        },
        async stop() { return { drained: true } },
      },
      targetPath: ROOT,
      profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
      outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
      providerSchemaRoot: path.join(directory, `provider-schemas-${suffix}`),
    })
    const result = await adapter.launch({
      ...EXECUTION_POLICY, physicalExecutionPolicy: EXECUTION_POLICY,
      ...adapterMissionFields('hash'),
      dispatch: { brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: 'hash' } },
      environment: {}, sessionId: `delivery-parity-${suffix}`, reservationId: `delivery-parity-reservation-${suffix}`,
      onTerminalResult(_value, evidence) { terminalEvidence = evidence },
    })
    return { result, terminalEvidence }
  }
  const streamed = await launchWith(false, 'streamed')
  const buffered = await launchWith(true, 'buffered')
  assert.deepEqual(streamed.result, buffered.result)
  assert.equal(streamed.terminalEvidence.eventStreamHash, buffered.terminalEvidence.eventStreamHash)
  assert.equal(streamed.terminalEvidence.rawOutputHash, buffered.terminalEvidence.rawOutputHash)
  assert.equal(streamed.result.contextId, '12121212-1212-4212-8212-121212121212')
  assert.equal(Object.hasOwn(streamed.result, 'events'), false)
  assert.equal(streamed.result.transportEvidence.eventCount, 3)
  assert.equal(streamed.result.transportEvidence.retainedEventCount, 3)
  assert.match(streamed.result.transportEvidence.eventStreamHash, /^[a-f0-9]{64}$/u)
  assert.match(streamed.result.transportEvidence.rawOutputHash, /^[a-f0-9]{64}$/u)
})

test('checker scratch authority creates private temp roots, enables non-Git Codex admission, and rejects target forgery', async t => {
  const directory = temporaryDirectory(t)
  const target = path.join(directory, 'target')
  const frozen = path.join(directory, 'frozen')
  const scratchRoot = path.join(directory, 'scratch-authority')
  fs.mkdirSync(target, { mode: 0o700 })
  fs.mkdirSync(frozen, { mode: 0o700 })
  const cleanupRegistry = new CleanupRegistry({
    registryPath: path.join(directory, 'cleanup-registry.json'),
    allowedRoots: [directory],
    controlBinding: { activationId: 'scratch-test', generationId: 1 },
  })
  const factory = createCheckerScratchFactory({
    scratchRoot, cleanupRegistry, runId: 'run-scratch', targetPath: target,
  })
  const candidateHash = 'b'.repeat(64)
  const boundary = factory('checker-scratch', frozen, { candidateHash, adoptedScratchRoots: [] })
  for (const owned of [
    boundary.writableScratchRoot, boundary.temporaryRoot, boundary.outputRoot, boundary.cacheRoot,
  ]) {
    assert.equal(fs.statSync(owned).isDirectory(), true)
    if (process.platform !== 'win32') assert.equal(fs.statSync(owned).mode & 0o777, 0o700)
  }
  const record = {
    checkerScratchBoundary: boundary,
    sandboxAssignment: { checkerId: 'checker-scratch' },
    candidateHash,
    canonicalTargetPath: frozen,
    workingDirectory: boundary.writableScratchRoot,
  }
  assert.equal(factory.verify(record), boundary)
  assert.throws(() => factory.verify({
    ...record,
    workingDirectory: target,
    checkerScratchBoundary: {
      ...boundary,
      writableScratchRoot: target,
      temporaryRoot: target,
      outputRoot: target,
      cacheRoot: target,
    },
  }), error => error.code === 'CHECKER_SCRATCH_BOUNDARY_INVALID')
  const nestedScratch = path.join(target, 'nested-scratch')
  fs.mkdirSync(nestedScratch, { mode: 0o700 })
  for (const child of ['tmp', 'output', 'cache']) fs.mkdirSync(path.join(nestedScratch, child), { mode: 0o700 })
  assert.throws(() => validateCheckerScratchDirectories({
    ...boundary,
    writableScratchRoot: nestedScratch,
    temporaryRoot: path.join(nestedScratch, 'tmp'),
    outputRoot: path.join(nestedScratch, 'output'),
    cacheRoot: path.join(nestedScratch, 'cache'),
  }, { realTargetPath: target }), error => error.code === 'CHECKER_SCRATCH_BOUNDARY_INVALID')
  const targetInsideScratch = path.join(boundary.writableScratchRoot, 'target-inside-scratch')
  fs.mkdirSync(targetInsideScratch, { mode: 0o700 })
  assert.throws(() => validateCheckerScratchDirectories(boundary, {
    realTargetPath: targetInsideScratch,
  }), error => error.code === 'CHECKER_SCRATCH_BOUNDARY_INVALID')
  assert.equal(cleanupRegistry.load().entries.some(entry =>
    entry.path === boundary.writableScratchRoot && entry.status === 'REGISTERED'), true)

  let observed = null
  const checkerOutput = canonicalOutcome('PASS', {
    runId: 'run-scratch', currentVersionHash: candidateHash,
  })
  const adapter = new CodexExecAdapter({
    runner: {
      async run(spec) {
        observed = spec
        spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: '99999999-9999-4999-8999-999999999999' }))
        spec.onStdoutLine(JSON.stringify({
          type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(checkerOutput) },
        }))
        spec.onStdoutLine(JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        }))
        return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
      },
      async stop() { return { drained: true } },
    },
    targetPath: target,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
    checkerScratchVerifier: factory.verify,
  })
  const result = await adapter.launch({
    ...CHECKER_EXECUTION_POLICY, physicalExecutionPolicy: CHECKER_EXECUTION_POLICY,
    runId: 'run-scratch', candidateHash,
    ...adapterMissionFields('a'.repeat(64)),
    dispatch: { brief: 'Execute the authoritative verifier.', requestPointer: { path: 'request', hash: 'a'.repeat(64) } },
    environment: {}, sessionId: 'scratch-check', reservationId: 'scratch-check-reservation',
    workingDirectory: boundary.writableScratchRoot, canonicalTargetPath: frozen,
    checkerScratchBoundary: boundary, sandboxAssignment: { checkerId: 'checker-scratch' },
  })
  assert.equal(result.code, 'PASS')
  assert.equal(observed.cwd, boundary.writableScratchRoot)
  assert.equal(observed.argv.includes('--skip-git-repo-check'), true)
  assert.equal(observed.argv[observed.argv.indexOf('--sandbox') + 1], 'workspace-write')
  assert.equal(observed.argv[observed.argv.indexOf('-C') + 1], boundary.writableScratchRoot)
  assert.match(observed.stdin, /AUTOPROMPT_CHECKER_SCRATCH_PROJECTION_V2/)
  assert.match(observed.stdin, new RegExp(JSON.stringify(frozen).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('Codex adapter ignores an early progress agent message until the final structured turn result', async t => {
  const directory = temporaryDirectory(t)
  const canonicalSchema = path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json')
  const canonicalOutput = canonicalWorkerResult({ reportId: 'result-progress' })
  let stopReason = null
  const runner = {
    async run(spec) {
      spec.onStdoutLine(JSON.stringify({
        type: 'thread.started', thread_id: '33333333-3333-4333-8333-333333333333',
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({ canonicalJson: 'I am inspecting the task before returning the canonical result.' }),
        },
      }))
      assert.equal(stopReason, null)
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(canonicalOutput) }) },
      }))
      assert.equal(stopReason, null)
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 1, reasoning_output_tokens: 0 },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop(spec) { stopReason = spec.reason; return { drained: true } },
  }
  let terminal
  const adapter = new CodexExecAdapter({
    runner,
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => canonicalSchema,
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const result = await adapter.launch({
    ...EXECUTION_POLICY,
    physicalExecutionPolicy: EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {},
    sessionId: 'run:DIRECT:launch-progress',
    reservationId: 'reservation-progress',
    onUsageDelta() { return { continue: true } },
    onTerminalResult(value) { terminal = value },
  })
  assert.equal(stopReason, 'typed terminal result')
  assert.deepEqual(terminal.behaviorChanged, canonicalOutput.behaviorChanged)
  assert.equal(result.reportType, 'result')
})

test('Codex adapter projects canonical target paths into the private worker clone', async t => {
  const directory = temporaryDirectory(t)
  const privateWorkspace = path.join(directory, 'private-worker-clone')
  const canonicalOutput = canonicalWorkerResult({ reportId: 'result-private' })
  let observed
  const runner = {
    async run(spec) {
      observed = spec
      spec.onStdoutLine(JSON.stringify({
        type: 'thread.started', thread_id: '22222222-2222-4222-8222-222222222222',
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ canonicalJson: JSON.stringify(canonicalOutput) }) },
      }))
      spec.onStdoutLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0 },
      }))
      return { status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop() { return { drained: true } },
  }
  const outputPath = path.join(ROOT, 'canary.txt')
  const adapter = new CodexExecAdapter({
    runner,
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  await adapter.launch({
    ...EXECUTION_POLICY,
    physicalExecutionPolicy: EXECUTION_POLICY,
    ...adapterMissionFields('hash'),
    dispatch: { brief: `Create ${outputPath}.`, requestPointer: { path: 'request', hash: 'hash' } },
    environment: {},
    sessionId: 'run:DIRECT:launch-private',
    reservationId: 'reservation-private',
    workingDirectory: privateWorkspace,
    canonicalTargetPath: ROOT,
    canonicalAssignment: {
      resources: [{ kind: 'output', identity: outputPath, access: 'write' }],
    },
    workerWorkspace: { workspaceId: 'private-1', binding: { bindingHash: 'a'.repeat(64) } },
  })
  assert.equal(observed.argv[observed.argv.indexOf('-C') + 1], privateWorkspace)
  assert.match(observed.stdin, /AUTOPROMPT_PRIVATE_WORKSPACE_PROJECTION_V1/)
  assert.match(observed.stdin, /AUTOPROMPT_WORKER_COMPLETION_BOUNDARY_V1/)
  assert.match(observed.stdin, /independent reviewer check is owned by the supervisor/)
  assert.match(observed.stdin, new RegExp(`"canonicalTargetRoot":${JSON.stringify(ROOT)}`))
  assert.match(observed.stdin, new RegExp(`"writableWorkspaceRoot":${JSON.stringify(privateWorkspace)}`))
  assert.match(observed.stdin, new RegExp(`"workspacePath":${JSON.stringify(path.join(privateWorkspace, 'canary.txt'))}`))
  assert.match(observed.stdin, /"reportPath":"canary\.txt"/)
  assert.ok(observed.stdin.indexOf('AUTOPROMPT_PRIVATE_WORKSPACE_PROJECTION_V1') >
    observed.stdin.indexOf('Canonical assignment:'))
})

test('ambient measurement variables cannot alter production ceilings or watchdogs', () => {
  const schedulerPath = path.join(ROOT, 'agents', 'codex', 'workflow', 'scheduler.js')
  const output = childProcess.execFileSync(process.execPath, ['-e', `
    const { CentralScheduler, resolveSchedulerSettings } = require(${JSON.stringify(schedulerPath)})
    const selected = resolveSchedulerSettings({ route: 'DIRECT' })
    const pending = new CentralScheduler({
      route: 'PENDING', routeSource: 'automatic',
      runIdentity: { runId: 'benchmark-unlimited', generation: 1 },
    }).settings
    process.stdout.write(JSON.stringify({ selected, pending }))
  `], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOPROMPT_BENCHMARK_NO_TOKEN_LIMIT: '1',
      AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1',
    },
  })
  const observed = JSON.parse(output)
  for (const settings of [observed.selected, observed.pending]) {
    assert.equal(settings.budget.admissionHardMs, 7 * 60 * 1000)
    assert.deepEqual(settings.budget.tokens, {
      noncachedInput: 220000,
      cachedInput: 900000,
      output: 40000,
    })
    assert.equal(Object.values(settings.budget.tokens).every(Number.isSafeInteger), true)
    for (const lane of Object.values(settings.lanes)) {
      assert.deepEqual(lane.tokens, settings.budget.tokens)
    }
  }
  assert.equal(productionTransportWatchdogMs(1234), 30 * 60 * 1000)
  assert.equal(Number.isFinite(productionTransportWatchdogMs(1234)), true)
  assert.equal(remainingL0DecisionBudgetMs({
    startedAtMs: 0,
    nowMs: 5 * 60 * 1000,
    environment: { AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1' },
  }), (30 - 5) * 60 * 1000)
  const issuedAtMs = Date.parse('2026-08-24T00:00:00.000Z')
  const requestedExpiryMs = issuedAtMs + 24 * 60 * 60 * 1000
  assert.equal(runtimeCapabilityExpiryMs(requestedExpiryMs, issuedAtMs, {}),
    requestedExpiryMs)
  assert.equal(runtimeCapabilityExpiryMs(requestedExpiryMs, issuedAtMs, {
    AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1',
  }), requestedExpiryMs)
  assert.equal(runtimeCapabilityExpiryMs(Number.NaN, issuedAtMs, {}),
    issuedAtMs + 5 * 60 * 1000)
})

test('ambient effort variables cannot override an authenticated model assignment', () => {
  const activation = {
    modelSelection: { mode: 'provider-default' },
  }
  const ordinary = readPrivateAgentAssignment(activation, 'ap-run-owner', 'run-owner')
  const withAmbientVariable = readPrivateAgentAssignment(activation, 'ap-run-owner', 'run-owner', {
    AUTOPROMPT_BENCHMARK_FORCE_EFFORT: 'xhigh',
  })
  assert.deepEqual(withAmbientVariable, ordinary)
})

test('pre-mutation baseline recovers the durable route hash for coordinator launches', () => {
  const persisted = 'a'.repeat(64)
  assert.equal(resolvePreMutationRouteDecisionHash({}, name => {
    assert.equal(name, 'route/decision.json')
    return persisted
  }), persisted)
  const explicit = 'b'.repeat(64)
  assert.equal(resolvePreMutationRouteDecisionHash({ routeDecisionHash: explicit }, () => {
    throw new Error('durable fallback must not be read when the request is already bound')
  }), explicit)
  assert.throws(
    () => resolvePreMutationRouteDecisionHash({}, () => null),
    error => error.code === 'PRE_MUTATION_BASELINE_INVALID',
  )
})

test('production ROADMAP expansion fails closed without external authority evidence', () => {
  const input = {
    admittedAskCount: 3,
    missionScopeHash: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    requestVersionPointer: { sequence: 1, digest: 'c'.repeat(64) },
  }
  assert.throws(
    () => admitRoadmapExpansion(null, input),
    error => error.code === 'ROADMAP_EXPANSION_NOT_ADMITTED',
  )
  assert.throws(() => admitRoadmapExpansion(() => ({
    authorityId: 'external-authority', accepted: true,
    authorityReceiptHash: 'd'.repeat(64),
    necessityEvidenceHash: 'e'.repeat(64),
    marginalValueEvidenceHash: 'e'.repeat(64),
  }), input), error => error.code === 'ROADMAP_EXPANSION_NOT_ADMITTED')
  const admitted = admitRoadmapExpansion(() => ({
    authorityId: 'external-authority', accepted: true,
    authorityReceiptHash: 'd'.repeat(64),
    necessityEvidenceHash: 'e'.repeat(64),
    marginalValueEvidenceHash: 'f'.repeat(64),
  }), input)
  assert.equal(admitted.accepted, true)
  assert.equal(admitted.authorityId, 'external-authority')
  assert.equal(admitted.missionScopeHash, input.missionScopeHash)
  assert.equal(admitted.planSha256, input.planSha256)
})

test('IMAGE_DATUM ordering requires an authenticated pre-work admission receipt', () => {
  const contract = {
    schemaVersion: '1.0.0',
    kind: 'IMAGE_DATUM',
    imageEvidenceHash: 'a'.repeat(64),
    selectedInterpretation: { id: 'front', interpretation: 'front reference plane' },
    alternativeInterpretations: ['rear reference plane'],
    rulingHash: 'b'.repeat(64),
    certificateHash: 'c'.repeat(64),
  }
  const admission = {
    requestEnvelopeHash: 'd'.repeat(64),
    routeDecisionHash: 'e'.repeat(64),
    targetStateHash: 'f'.repeat(64),
    admissionHash: '1'.repeat(64),
    contracts: [contract],
  }
  const receiptBody = {
    schemaVersion: 1,
    kind: 'codex-captured-domain-pre-work-admission',
    runId: 'run-1',
    generation: 1,
    admissionHash: admission.admissionHash,
    admissionFileHash: '2'.repeat(64),
    requestEnvelopeHash: admission.requestEnvelopeHash,
    routeDecisionHash: admission.routeDecisionHash,
    targetStateHash: admission.targetStateHash,
    imageCertificateHashes: [contract.certificateHash],
  }
  const receipt = {
    ...receiptBody,
    receiptHash: crypto.createHash('sha256').update(stableStringify(receiptBody)).digest('hex'),
    stateEventHash: '3'.repeat(64),
    stateEventSequence: 7,
  }
  assert.throws(
    () => imageDatumOutcomeFromPreWorkAdmission(contract, admission, null),
    error => error.code === 'CAPTURED_DOMAIN_ADMISSION_REQUIRED',
  )
  const outcome = imageDatumOutcomeFromPreWorkAdmission(contract, admission, receipt)
  assert.deepEqual(outcome, {
    schemaVersion: '1.0.0',
    kind: 'IMAGE_DATUM',
    certificateHash: 'c'.repeat(64),
    rulingHash: 'b'.repeat(64),
    selectedInterpretationId: 'front',
    certificateRecordedBeforeGeometryWrites: true,
    preWorkAdmissionReceiptHash: receipt.receiptHash,
    preWorkAdmissionEventHash: receipt.stateEventHash,
  })
  assert.throws(
    () => imageDatumOutcomeFromPreWorkAdmission(contract, admission, {
      ...receipt, stateEventHash: null,
    }),
    error => error.code === 'CAPTURED_DOMAIN_ADMISSION_REQUIRED',
  )
})

test('canonical worker authorization accepts only its matching implementation-worker alias', t => {
  const target = temporaryDirectory(t)
  const request = owner => ({
    workItemId: 'work-1',
    ownership: [{ kind: 'output', identity: 'artifact.txt', owner }],
    manifests: [],
  })
  const accepted = canonicalAssignmentResources({
    request: request('implementation-worker-1'),
    targetPath: target,
    logicalRole: 'worker',
    readOnly: false,
    enforcePreimages: true,
  })
  assert.equal(accepted[0].owner, 'implementation-worker-1')
  assert.equal(canonicalAssignmentResources({
    request: request('ap-worker-1'),
    targetPath: target,
    logicalRole: 'worker',
    readOnly: false,
    enforcePreimages: true,
  })[0].owner, 'ap-worker-1')
  assert.throws(() => canonicalAssignmentResources({
    request: request('implementation-worker-2'),
    targetPath: target,
    logicalRole: 'worker',
    readOnly: false,
    enforcePreimages: true,
  }), error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED')

  const directOwnership = [{ kind: 'file', identity: '/app/artifact.txt', owner: 'direct-worker' }]
  assert.equal(executionMutableResourceOwnership({
    mutableResourceOwnership: directOwnership,
  }, 'DIRECT', 1)[0].owner, 'worker-1')
  assert.equal(executionMutableResourceOwnership({
    mutableResourceOwnership: directOwnership,
  }, 'DIRECT', 2)[0].owner, 'direct-worker')
  assert.equal(executionMutableResourceOwnership({
    mutableResourceOwnership: directOwnership,
  }, 'LIGHT', 1)[0].owner, 'worker-1')

  const semanticOwnership = [{
    kind: 'output', identity: '/app/out.step', owner: 'geometry-worker', ownershipMode: 'single-owner',
  }]
  assert.equal(executionMutableResourceOwnership({
    mutableResourceOwnership: semanticOwnership,
  }, 'DIRECT', 1)[0].owner, 'worker-1')
  assert.equal(executionMutableResourceOwnership({
    mutableResourceOwnership: semanticOwnership,
  }, 'ROADMAP', 1)[0].owner, 'worker-1')
  assert.equal(executionMutableResourceOwnership({
    mutableResourceOwnership: semanticOwnership,
  }, 'ROADMAP', 2)[0].owner, 'worker-1')

  const multiWorkerOwnership = [
    { kind: 'external-system', identity: 'ERP', owner: 'mission-coordinator' },
    { kind: 'file', identity: '/app/output/erp.sql', owner: 'worker-erp' },
    { kind: 'file', identity: '/app/output/mes.sql', owner: 'worker-mes' },
    { kind: 'file', identity: '/app/output/wms.sql', owner: 'worker-wms' },
  ]
  assert.deepEqual(executionMutableResourceOwnership({
    mutableResourceOwnership: multiWorkerOwnership,
  }, 'ROADMAP', 3).map(item => item.owner), [
    'mission-coordinator', 'worker-1', 'worker-2', 'worker-3',
  ])

  const reserved = [
    { kind: 'file', identity: '/app/output/core.sql', owner: 'worker-2' },
    { kind: 'file', identity: '/app/output/erp.sql', owner: 'worker-erp' },
    { kind: 'file', identity: '/app/output/wms.sql', owner: 'worker-wms' },
  ]
  assert.deepEqual(executionMutableResourceOwnership({
    mutableResourceOwnership: reserved,
  }, 'ROADMAP', 3).map(item => item.owner), ['worker-2', 'worker-1', 'worker-3'])
})

test('read-only planning authority excludes databases, services, missing outputs, and likely-area prose', t => {
  const target = temporaryDirectory(t)
  fs.mkdirSync(path.join(target, 'data'))
  fs.mkdirSync(path.join(target, 'input'))
  fs.writeFileSync(path.join(target, 'data', 'dbgw.py'), 'gateway\n')
  fs.writeFileSync(path.join(target, 'policy.yaml'), 'policy: strict\n')
  const prose = 'ERP planning, demand, engineering-release, routing, qualification, and WIP data exposed by the gateway'
  const ownership = decisionReadOnlyOwnership({
    mutableResourceOwnership: [
      { kind: 'file', identity: 'data/dbgw.py', owner: 'worker-1', ownershipMode: 'single-owner' },
      { kind: 'database', identity: 'erp-db', owner: 'worker-1', ownershipMode: 'single-owner' },
      { kind: 'service', identity: 'gateway', owner: 'worker-1', ownershipMode: 'single-owner' },
      { kind: 'output', identity: 'output/erp_writeback.sql', owner: 'worker-1', ownershipMode: 'single-owner' },
    ],
    likelyAreas: [
      './data/dbgw.py',
      `${path.join(target, 'anon.py')}; ${path.join(target, 'policy.yaml')}; ${path.join(target, 'input', '*.csv')}; a disk-backed identity index`,
      prose,
    ],
  }, target)
  assert.deepEqual(ownership.map(item => [item.kind, item.identity]), [
    ['file', 'data/dbgw.py'],
    ['file', path.join(target, 'policy.yaml')],
    ['directory', path.join(target, 'input')],
  ])
  const resources = canonicalAssignmentResources({
    request: { workItemId: 'mission-coordination', ownership, manifests: [], assignment: 'Read existing planning inputs.' },
    targetPath: target, logicalRole: 'mission-coordinator', readOnly: true, enforcePreimages: false,
  })
  assert.equal(resources.length, 3)
  for (const resource of resources) assert.match(resource.expectedPreimageHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(decisionReadOnlyOwnership({
    mutableResourceOwnership: [{ kind: 'database', identity: 'erp-db', owner: 'worker-1' }],
    likelyAreas: [prose],
  }, target), ['workspace'])
})

test('canonical brief path validation distinguishes slash-separated prose from explicit paths', t => {
  const target = temporaryDirectory(t)
  const request = assignment => ({
    workItemId: 'work-1',
    assignment,
    ownership: [{ kind: 'output', identity: 'filter.py', owner: 'worker-1' }],
    manifests: [],
  })
  const resources = canonicalAssignmentResources({
    request: request('Remove JavaScript/XSS and create the declared output.'),
    targetPath: target,
    logicalRole: 'worker',
    readOnly: false,
    enforcePreimages: true,
  })
  assert.equal(resources.length, 1)
  assert.equal(resources[0].identity, 'filter.py')
  assert.throws(() => canonicalAssignmentResources({
    request: request('Read ./missing/input.txt before writing the declared output.'),
    targetPath: target,
    logicalRole: 'worker',
    readOnly: false,
    enforcePreimages: true,
  }), error => error.code === 'MISSION_PATH_INVALID')

  const absoluteOutput = path.join(target, 'output')
  const sentenceResources = canonicalAssignmentResources({
    request: {
      workItemId: 'work-1',
      assignment: `Write the artifacts inside ${absoluteOutput}.`,
      ownership: [{ kind: 'output', identity: absoluteOutput, owner: 'worker-1' }],
      manifests: [],
    },
    targetPath: target,
    canonicalTargetPath: target,
    logicalRole: 'worker',
    readOnly: false,
    enforcePreimages: true,
  })
  assert.equal(sentenceResources[0].identity, absoluteOutput)
  assert.throws(() => canonicalAssignmentResources({
    request: {
      workItemId: 'work-1',
      assignment: 'Implement the requested planning behavior.',
      ownership: ['ERP planning, demand, engineering-release, routing, qualification, and WIP data exposed by the gateway'],
      manifests: [],
    },
    targetPath: target,
    logicalRole: 'worker',
    readOnly: false,
    enforcePreimages: true,
  }), error => error.code === 'OWNERSHIP_RESOURCE_INVALID')
})

test('checker brief validation projects canonical absolute inputs into its snapshot', t => {
  const directory = temporaryDirectory(t)
  const canonicalTarget = path.join(directory, 'canonical-target')
  const checkerSnapshot = path.join(directory, 'checker-snapshot')
  fs.mkdirSync(canonicalTarget)
  fs.mkdirSync(checkerSnapshot)
  fs.writeFileSync(path.join(canonicalTarget, 'schematic.png'), 'canonical image bytes\n')
  fs.copyFileSync(
    path.join(canonicalTarget, 'schematic.png'),
    path.join(checkerSnapshot, 'schematic.png'),
  )
  const resources = canonicalAssignmentResources({
    request: {
      workItemId: 'final-check',
      assignment: `Inspect ${path.join(canonicalTarget, 'schematic.png')} against the candidate.`,
      ownership: ['workspace'],
      manifests: [],
    },
    targetPath: checkerSnapshot,
    canonicalTargetPath: canonicalTarget,
    logicalRole: 'independent-reviewer',
    readOnly: true,
    enforcePreimages: false,
  })
  assert.equal(resources.some(resource =>
    resource.identity === 'schematic.png' && resource.access === 'read'), true)
  assert.throws(() => canonicalAssignmentResources({
    request: {
      workItemId: 'final-check',
      assignment: `Inspect ${path.join(directory, 'foreign', 'schematic.png')}.`,
      ownership: ['workspace'],
      manifests: [],
    },
    targetPath: checkerSnapshot,
    canonicalTargetPath: canonicalTarget,
    logicalRole: 'independent-reviewer',
    readOnly: true,
    enforcePreimages: false,
  }), error => error.code === 'MISSION_PATH_INVALID')
})
