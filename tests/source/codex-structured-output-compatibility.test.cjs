#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  CodexExecAdapter,
  appendSupervisorRecordedCapturedDomainOutcomes,
  applyBenchmarkEffortPin,
  benchmarkFirstProductSignalDeadlineEnabled,
  benchmarkPhaseTimeoutMs,
  canonicalAssignmentResources,
  createCheckerScratchFactory,
  validateCheckerScratchDirectories,
  decisionReadOnlyOwnership,
  executionMutableResourceOwnership,
  decodeCodexProviderEnvelope,
  materializeCodexProviderEnvelopeSchema,
  productionRoadmapExpansionAuthority,
  readPrivateAgentAssignment,
  resolvePreMutationRouteDecisionHash,
  runtimeCapabilityExpiryMs,
} = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js'))
const { CleanupRegistry } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'finalizer.js'))
const { validateJsonSchema } = require(
  path.join(ROOT, 'agents', 'codex', 'workflow', 'json-schema-validator.js'),
)
const { remainingL0DecisionBudgetMs } = require(
  path.join(ROOT, 'agents', 'codex', 'workflow', 'route-decision.js'),
)
const {
  CONTEXT_ROUTE_CAPS,
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
    fields: { successChecklist, ownership, checks, dependencies, returnShape },
  })
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
  const canonicalOutput = canonicalWorkerResult()
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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
  assert.match(observed.stdin, /Canonical output schema:/)
  assert.deepEqual(terminal.behaviorChanged, canonicalOutput.behaviorChanged)
  assert.deepEqual(observedUsage, { noncachedInput: 4, cachedInput: 7, output: 1, reasoning: 0 })
  assert.equal(result.reportType, 'result')
  assert.equal(Object.hasOwn(result, 'canonicalJson'), false)
})

test('Codex adapter preserves a final CHECK_INCONCLUSIVE instead of reconstructing FAIL', async t => {
  const directory = temporaryDirectory(t)
  const canonicalOutput = canonicalOutcome('CHECK_INCONCLUSIVE', {
    runId: 'run-inconclusive', payload: { unblockPath: 'provide isolated scratch storage' },
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
    dispatch: { brief: 'Check the bounded candidate.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {}, sessionId: 'run:DIRECT:check-inconclusive', reservationId: 'reservation-inconclusive',
    onUsageDelta() { return { continue: true } },
    onTerminalResult(value) { terminal = value },
  })
  assert.equal(stopReason, 'typed terminal CHECK_INCONCLUSIVE')
  assert.equal(result.code, 'CHECK_INCONCLUSIVE')
  assert.equal(terminal.code, 'CHECK_INCONCLUSIVE')
  assert.equal(Object.hasOwn(result, 'reconstructedTerminal'), false)
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
    dispatch: { brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: 'hash' } },
    environment: {}, sessionId: 'committed-race', reservationId: 'committed-race-reservation',
    onTerminalResult(value) { terminal = value; terminalCount += 1 },
  })
  assert.equal(terminalCount, 1)
  assert.equal(result.reportId, 'committed-result')
  assert.deepEqual(result, terminal)
  assert.notEqual(result.reportId, late.reportId)
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
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

test('benchmark no-limit overrides cover tokens and admission time for every scheduler', () => {
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
    assert.equal(settings.budget.admissionHardMs, Number.MAX_SAFE_INTEGER)
    assert.deepEqual(settings.budget.tokens, {
      noncachedInput: Number.MAX_SAFE_INTEGER,
      cachedInput: Number.MAX_SAFE_INTEGER,
      output: Number.MAX_SAFE_INTEGER,
    })
    for (const lane of Object.values(settings.lanes)) {
      assert.deepEqual(lane.tokens, settings.budget.tokens)
    }
  }
  assert.equal(benchmarkPhaseTimeoutMs(1234, {}), 1234)
  assert.equal(benchmarkPhaseTimeoutMs(1234, {
    AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1',
  }), Number.POSITIVE_INFINITY)
  assert.equal(benchmarkFirstProductSignalDeadlineEnabled(5_000, {}), true)
  assert.equal(benchmarkFirstProductSignalDeadlineEnabled(Number.MAX_SAFE_INTEGER, {}), false)
  assert.equal(benchmarkFirstProductSignalDeadlineEnabled(5_000, {
    AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1',
  }), false)
  assert.equal(remainingL0DecisionBudgetMs({
    startedAtMs: 0,
    nowMs: 5 * 60 * 1000,
    environment: { AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1' },
  }), Number.POSITIVE_INFINITY)
  const issuedAtMs = Date.parse('2026-08-24T00:00:00.000Z')
  const requestedExpiryMs = issuedAtMs + 24 * 60 * 60 * 1000
  assert.equal(runtimeCapabilityExpiryMs(requestedExpiryMs, issuedAtMs, {}),
    issuedAtMs + 5 * 60 * 1000)
  assert.equal(runtimeCapabilityExpiryMs(requestedExpiryMs, issuedAtMs, {
    AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT: '1',
  }), Date.parse('9999-12-31T23:59:59.999Z'))
})

test('benchmark xhigh pin overrides every resolved role effort and rejects ambiguous values', () => {
  const ordinary = { model: null, effort: 'medium', source: 'role-effort-policy' }
  assert.equal(applyBenchmarkEffortPin(ordinary, {}), ordinary)
  assert.deepEqual(applyBenchmarkEffortPin(ordinary, {
    AUTOPROMPT_BENCHMARK_FORCE_EFFORT: 'xhigh',
  }), {
    model: null,
    effort: 'xhigh',
    source: 'benchmark-explicit-xhigh-pin',
    routeIndependent: true,
  })
  assert.throws(
    () => applyBenchmarkEffortPin(ordinary, { AUTOPROMPT_BENCHMARK_FORCE_EFFORT: 'high' }),
    error => error.code === 'INVALID_EFFORT',
  )
  assert.equal(readPrivateAgentAssignment({
    modelSelection: { mode: 'provider-default' },
  }, 'ap-run-owner', 'run-owner', {
    AUTOPROMPT_BENCHMARK_FORCE_EFFORT: 'xhigh',
  }).effort, 'xhigh')
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

test('production supervisor binds ROADMAP decomposition authority independently of author evidence', () => {
  const input = {
    admittedAskCount: 3,
    missionScopeHash: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    requestVersionPointer: { sequence: 1, digest: 'c'.repeat(64) },
  }
  const first = productionRoadmapExpansionAuthority({
    ...input,
    proposedEvidence: { necessityEvidenceHash: 'd'.repeat(64) },
  })
  const second = productionRoadmapExpansionAuthority({
    ...input,
    proposedEvidence: { necessityEvidenceHash: 'e'.repeat(64) },
  })
  assert.deepEqual(first, second)
  assert.equal(first.accepted, true)
  assert.equal(first.authorityId, 'production-supervisor-roadmap-expansion')
  assert.match(first.authorityReceiptHash, /^[a-f0-9]{64}$/)
  assert.match(first.necessityEvidenceHash, /^[a-f0-9]{64}$/)
  assert.match(first.marginalValueEvidenceHash, /^[a-f0-9]{64}$/)
  assert.notEqual(first.necessityEvidenceHash, first.marginalValueEvidenceHash)
  assert.throws(
    () => productionRoadmapExpansionAuthority({ ...input, planSha256: null }),
    error => error.code === 'ROADMAP_EXPANSION_NOT_ADMITTED',
  )
})

test('production supervisor records a missing pre-work IMAGE_DATUM outcome', () => {
  const contract = {
    schemaVersion: '1.0.0',
    kind: 'IMAGE_DATUM',
    imageEvidenceHash: 'a'.repeat(64),
    selectedInterpretation: { id: 'front', interpretation: 'front reference plane' },
    alternativeInterpretations: ['rear reference plane'],
    rulingHash: 'b'.repeat(64),
    certificateHash: 'c'.repeat(64),
  }
  const outcomes = appendSupervisorRecordedCapturedDomainOutcomes([contract], [])
  assert.deepEqual(outcomes, [{
    schemaVersion: '1.0.0',
    kind: 'IMAGE_DATUM',
    certificateHash: 'c'.repeat(64),
    rulingHash: 'b'.repeat(64),
    selectedInterpretationId: 'front',
    certificateRecordedBeforeGeometryWrites: true,
  }])
  assert.equal(appendSupervisorRecordedCapturedDomainOutcomes([contract], outcomes).length, 1)
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
