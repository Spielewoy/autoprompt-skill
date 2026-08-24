#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const {
  EventLog,
  atomicCreateJson,
  fsyncDirectory,
  readChecksummedJson,
  sha256,
} = require(path.join(WORKFLOW, 'event-log.js'))
const {
  RuntimeStateStore,
  isLegalTransition,
  prepareCrashCheckpoint,
  runtimeCrashPrecondition,
  validateCanonicalStateEvent,
} = require(path.join(WORKFLOW, 'runtime-state.js'))
const {
  MissionLock,
  physicalDirectoryIdentity,
  processIdentityForPid,
  predecessorReleaseHash,
} = require(path.join(WORKFLOW, 'mission-lock.js'))
const {
  AccountingAuthority,
  BudgetController,
  accountingRecordHash,
  accountingSnapshotHash,
  resolveCeilings,
} = require(path.join(WORKFLOW, 'budget-controller.js'))
const {
  ProcessOwner,
  createPosixProcessAdapter,
  createWindowsJobAdapter,
  getProcessAdapterContract,
  prepareProcessLaunchEnvironment,
  REQUIRED_PROCESS_ADAPTER_METHODS,
} = require(path.join(WORKFLOW, 'process-owner.js'))
const { CleanupRegistry, Finalizer } = require(path.join(WORKFLOW, 'finalizer.js'))
const { ensureWindowsPrivateAcl } = require(path.join(WORKFLOW, 'safe-run-root.js'))
const {
  RecoveryCheckpointAuthority,
  decodeSchedulerCheckpoint,
  prepareSchedulerCheckpoint,
  recoveryCheckpointEntryHash,
  recoveryCheckpointSnapshotHash,
} = require(path.join(WORKFLOW, 'recovery-checkpoint.js'))
const { OwnedCodexProxyRunner } = require(path.join(WORKFLOW, 'phase-budget.js'))
const TEST_CAPABILITIES = new WeakMap()

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-runtime-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function digest(value) {
  return sha256(String(value))
}

function ownedIdentityEvidence(owner, liveKeys = new Set()) {
  return (owner.ownedProcessHistory || owner.ownedProcessIdentities).map((identity) => ({
    ...identity,
    verified: true,
    alive: liveKeys.has(`${identity.kind}\0${identity.id}`),
    adapterEvidenceHash: digest(`adapter:${identity.kind}:${identity.id}:${liveKeys.has(`${identity.kind}\0${identity.id}`)}`),
  }))
}

function leaseProcessObserver(observe = () => null) {
  return (pid, requestedIdentity) => requestedIdentity || observe(pid)
}

function assertDraft202012Valid(schemaPath, records) {
  const script = [
    'import json, sys',
    'from jsonschema import Draft202012Validator, FormatChecker',
    "schema = json.load(open(sys.argv[1], encoding='utf-8'))",
    'records = json.load(sys.stdin)',
    'validator = Draft202012Validator(schema, format_checker=FormatChecker())',
    "errors = [error.message for record in records for error in validator.iter_errors(record)]",
    "print(json.dumps(errors)) if errors else None",
    'raise SystemExit(1 if errors else 0)',
  ].join('\n')
  const result = childProcess.spawnSync('python', ['-c', script, schemaPath], {
    input: JSON.stringify(records),
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stdout || result.stderr)
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`condition was not satisfied within ${timeoutMs}ms`)
}

function binding() {
  return {
    runId: 'run-0001',
    requestEnvelopeHash: digest('request'),
    targetIdentity: 'target:1:2',
    openedDirectoryIdentity: 'opened:1:2',
    digests: {
      contract: digest('contract'),
      prompt: digest('prompt'),
      provider: digest('provider'),
      tool: digest('tool'),
    },
  }
}

function accountingDelta(overrides = {}) {
  return {
    launches: 0,
    retries: 0,
    sessions: 0,
    elapsedMilliseconds: 0,
    costMicrounits: 0,
    tokenUsage: { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 },
    ...overrides,
    tokenUsage: {
      noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0,
      ...(overrides.tokenUsage || {}),
    },
  }
}

function schedulerUsage(overrides = {}) {
  return {
    noncachedInput: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    weightedCost: 0,
    latencyMs: 0,
    workMs: 0,
    ...overrides,
  }
}

function schedulerCheckpointFixture(options = {}) {
  return prepareSchedulerCheckpoint({
    state: options.state || {
      schemaVersion: 1,
      kind: 'scheduler-crash-checkpoint',
      runIdentity: 'run-0001',
      ownerSessionId: 'supervisor-session-001',
      schedulerState: { phase: options.phase || 'RUN_WORK', cursor: options.cursor || 1 },
      reserved: [],
      liveRecords: [],
      stateHash: digest('producer-supplied-hash-is-excluded'),
    },
    ownerSessionId: 'supervisor-session-001',
    route: options.route || 'LIGHT',
    phase: options.phase || 'RUN_WORK',
    candidate: options.candidate || { candidateId: null, candidateHash: null, frozen: false },
    completedWorkIds: options.completedWorkIds || [],
    completedCheckIds: options.completedCheckIds || [],
    openCheckIds: options.openCheckIds || [],
    nextReadyWorkIds: options.nextReadyWorkIds || [],
    leases: options.leases || [],
    usage: schedulerUsage(options.usage),
    reserves: schedulerUsage(options.reserves),
  })
}

function stateHarness(t, options = {}) {
  const directory = options.directory || temporary(t)
  const eventBinding = options.binding || binding()
  let clock = 0
  const now = () => new Date(Date.UTC(2026, 7, 21, 0, 0, clock++)).toISOString()
  const eventLog = new EventLog({
    logPath: path.join(directory, 'runtime', 'events.jsonl'),
    blobDirectory: path.join(directory, 'blobs'),
    binding: eventBinding,
    clock: now,
    maxInlineBytes: options.maxInlineBytes,
  })
  const issued = new WeakSet()
  const capability = options.capability || Object.freeze({ type: 'test-opaque-capability' })
  if (!options.capabilityVerifier) issued.add(capability)
  const capabilityBinding = {
    runId: eventBinding.runId,
    activationId: 'activation-001',
    missionHash: digest('mission'),
    nonce: 'nonce_123456789012',
    generation: 1,
    targetIdentity: eventBinding.targetIdentity,
  }
  const store = new RuntimeStateStore({
    paths: {
      runRecordRoot: directory,
      statePath: path.join(directory, 'runtime', 'state.json'),
      eventPath: path.join(directory, 'runtime', 'events.jsonl'),
      terminalPath: path.join(directory, 'runtime', 'terminal.json'),
    },
    eventLog,
    capabilityVerifier: options.capabilityVerifier || ((candidate) => (
      issued.has(candidate) ? { ...capabilityBinding } : null
    )),
    recoveryCheckpointVerifier: options.recoveryCheckpointVerifier,
    clock: now,
    randomId: () => 'mutation-permit-001',
    beforeCommit: options.beforeCommit,
  })
  TEST_CAPABILITIES.set(store, capability)
  if (options.create !== false) {
    store.create({
      ...eventBinding,
      activation: {
        id: 'activation-001',
        nonce: 'nonce_123456789012',
        missionHash: digest('mission'),
        sessionToken: 'session-token-001',
        generation: 1,
      },
      cause: 'test admission',
      capability,
      budgets: options.budgets,
      retryState: options.retryState,
      resourceState: options.resourceState,
    })
  }
  return {
    capability,
    directory,
    eventLog,
    store,
    advanceCapabilityGeneration() { capabilityBinding.generation += 1 },
  }
}

function transition(store, nextState, cause = 'test transition', eventId, frontier) {
  const fromState = store.load().state
  const preferred = {
    'START_ROUTE_ANALYST->SAVE_ROUTE_ANALYSIS': 'ROUTE_ANALYST_STARTED',
  }[`${fromState}->${nextState}`]
  return store.transition(nextState, {
    cause,
    capability: TEST_CAPABILITIES.get(store),
    eventId: eventId || preferred,
    frontier,
  })
}

function advanceToWork(store) {
  for (const state of [
    'LOAD_SKILL', 'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'ACQUIRE_TARGET_LOCK',
    'SELECT_SAFE_RUN_ROOT', 'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES',
    'START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION', 'PREPARE_WORK',
    'RUN_WORK',
  ]) transition(store, state)
}

function advanceToFinalCheck(store) {
  advanceToWork(store)
  transition(store, 'CHECK_WORK')
  transition(store, 'FINAL_CHECK')
}

test('runtime state admits every named admission/evolution case and rejects illegal edges', (t) => {
  assert.equal(isLegalTransition('RESOLVE_SETTINGS', 'CONFIG_REQUIRED'), true)
  assert.equal(isLegalTransition('CHECK_PROVIDER_CAPABILITIES', 'RELEASING_LOCK', 'PROVIDER_UNSUPPORTED'), true)
  assert.equal(isLegalTransition('L0_ROUTE_DECISION', 'RELEASING_LOCK', 'ROUTE_DECISION_TIMEOUT'), true)
  assert.equal(isLegalTransition('L0_ROUTE_DECISION', 'L0_ROUTE_DECISION', 'ROUTE_DECISION_INVALID_FIRST'), true)
  assert.equal(isLegalTransition('L0_ROUTE_DECISION', 'WAITING_USER'), true)
  assert.equal(isLegalTransition('CHECK_WORK', 'CHECK_INCONCLUSIVE'), true)
  assert.equal(isLegalTransition('RUN_WORK', 'WORKER_CONTEXT_LOST'), true)
  assert.equal(isLegalTransition('RUN_WORK', 'INTEGRATION_CONFLICT'), true)
  assert.equal(isLegalTransition('LOAD_SKILL', 'MIGRATING_CONTRACT', 'CONTRACT_UPGRADE_REQUIRED'), true)
  assert.equal(isLegalTransition('RUN_WORK', 'APPEND_REQUEST_STEERING', 'USER_UPDATE'), true)
  assert.equal(isLegalTransition('DONE', 'RUN_WORK'), false)

  const { store } = stateHarness(t)
  assert.throws(
    () => transition(store, 'DONE'),
    (error) => error.code === 'ILLEGAL_STATE_TRANSITION' && /BOOT -> DONE/.test(error.message),
  )
})

test('runtime mutation authority is opaque and activation identity cannot be patched from state.json values', (t) => {
  const harness = stateHarness(t)
  const { capability, store } = harness
  const copied = { ...capability }
  assert.throws(
    () => store.transition('LOAD_SKILL', { cause: 'forged public state', capability: copied }),
    (error) => error.code === 'LEASE_CAPABILITY_REQUIRED',
  )
  assert.throws(
    () => store.transition('LOAD_SKILL', {
      cause: 'activation takeover',
      capability,
      statePatch: { activation: { ...store.load().activation, generation: 99 } },
    }),
    (error) => error.code === 'IMMUTABLE_STATE_FIELD',
  )
  transition(store, 'LOAD_SKILL')
  transition(store, 'STORE_REQUEST_ENVELOPE')
  transition(store, 'RESOLVE_SETTINGS')
  transition(store, 'ACQUIRE_TARGET_LOCK')
  transition(store, 'SELECT_SAFE_RUN_ROOT')
  transition(store, 'CREATE_RUN_RECORD')
  transition(store, 'CHECK_PROVIDER_CAPABILITIES')
  transition(store, 'START_ROUTE_ANALYST')
  transition(store, 'SAVE_ROUTE_ANALYSIS')
  transition(store, 'L0_ROUTE_DECISION')
  transition(store, 'PREPARE_WORK')
  transition(store, 'PAUSED', 'saved budget frontier', 'BUDGET_EXHAUSTED_RESUMABLE', {
    resumeState: 'PREPARE_WORK',
    nextReadyWorkIds: ['work-1'],
    remainingBudgetSeconds: 10,
    continuationBindingHash: digest('continuation'),
  })
  harness.advanceCapabilityGeneration()
  const resumed = store.resumeGeneration({ capability, expectedGeneration: 1, cause: 'verified supervisor resume' })
  assert.equal(resumed.activation.generation, 2)
  assert.equal(resumed.activation.id, 'activation-001')
  assert.equal(resumed.activation.nonce, 'nonce_123456789012')
})

test('checksummed state and hash-chained events survive restart and fail closed on tamper', (t) => {
  const { directory, eventLog, store } = stateHarness(t)
  transition(store, 'LOAD_SKILL')
  const loaded = store.load()
  assert.equal(loaded.state, 'LOAD_SKILL')
  assert.equal(loaded.sequence, 1)
  const emitted = eventLog.readAll().at(-1)
  assert.equal(emitted.hash, loaded.lastEventHash)
  assert.equal(emitted.schemaVersion, '2.0.0')
  assert.equal(validateCanonicalStateEvent(emitted.details.stateEvent), true)
  assert.equal(emitted.details.stateEvent.humanDescription, 'load the pinned product contract')
  assertDraft202012Valid(
    path.join(ROOT, 'agents', 'contracts', 'schemas', 'state-event.schema.json'),
    [emitted.details.stateEvent],
  )

  const statePath = path.join(directory, 'runtime', 'state.json')
  const tampered = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  tampered.state = 'DONE'
  fs.writeFileSync(statePath, `${JSON.stringify(tampered)}\n`)
  assert.throws(() => store.load(), (error) => error.code === 'RUN_RECORD_FAILURE')
})

test('an interrupted state commit preserves the last state and replays its checksummed transition journal', (t) => {
  let failCommit = false
  const harness = stateHarness(t, {
    beforeCommit() {
      if (failCommit) throw new Error('injected rename veto')
    },
  })
  const before = readChecksummedJson(path.join(harness.directory, 'runtime', 'state.json'))
  failCommit = true
  assert.throws(
    () => transition(harness.store, 'LOAD_SKILL'),
    (error) => error.code === 'RUN_RECORD_FAILURE' && /atomic runtime-state write failed/.test(error.message),
  )
  const preserved = readChecksummedJson(path.join(harness.directory, 'runtime', 'state.json'))
  assert.equal(preserved.checksum, before.checksum)
  assert.equal(preserved.state, 'BOOT')
  failCommit = false
  assert.equal(harness.store.load().state, 'LOAD_SKILL')
  assert.equal(fs.existsSync(harness.store.registeredPaths.transactionPath), false)
})

test('large raw events are content-addressed while the event index stays bounded', (t) => {
  const directory = temporary(t)
  const log = new EventLog({
    logPath: path.join(directory, 'events.jsonl'),
    blobDirectory: path.join(directory, 'blobs'),
    binding: binding(),
    maxInlineBytes: 8,
  })
  const event = log.capture('TOOL_OUTPUT', 'this output is intentionally larger than eight bytes', { cause: 'tool completed' })
  const reference = event.details.evidence.contentRef
  assert.equal(reference.algorithm, 'sha256')
  assert.equal(log.readContent(reference).toString(), 'this output is intentionally larger than eight bytes')
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8'), /intentionally larger/)
})

test('event append is cross-process serialized with one sequence and hash-chain order', async (t) => {
  const directory = temporary(t)
  const logPath = path.join(directory, 'events.jsonl')
  const runner = path.join(directory, 'append.cjs')
  fs.writeFileSync(runner, [
    "'use strict'",
    `const { EventLog } = require(${JSON.stringify(path.join(WORKFLOW, 'event-log.js'))})`,
    `const binding = ${JSON.stringify(binding())}`,
    "const log = new EventLog({ logPath: process.env.EVENT_PATH, binding, lockTimeoutMs: 10000 })",
    "log.append({ type: 'RACE_EVENT', cause: process.env.EVENT_CAUSE })",
  ].join('\n'))
  const children = Array.from({ length: 12 }, (_, index) => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [runner], {
      env: { ...process.env, EVENT_PATH: logPath, EVENT_CAUSE: `writer-${index}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer ${index} exited ${code}: ${stderr}`)))
  }))
  await Promise.all(children)
  const log = new EventLog({ logPath, binding: binding() })
  const events = log.readAll()
  assert.equal(events.length, 12)
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 12 }, (_, index) => index + 1))
  assert.equal(new Set(events.map((event) => event.hash)).size, 12)
  assert.throws(
    () => new EventLog({ logPath: path.join(directory, 'unsafe.jsonl'), binding: binding(), locking: 'none' }),
    (error) => error.code === 'EVENT_LOCK_UNSUPPORTED',
  )
  for (const config of [
    { lockTimeoutMs: 0 },
    { lockTimeoutMs: Infinity },
    { lockPollMs: 0 },
    { lockTimeoutMs: 10, lockPollMs: 11 },
  ]) {
    assert.throws(
      () => new EventLog({ logPath: path.join(directory, `invalid-${Object.keys(config)[0]}.jsonl`), binding: binding(), ...config }),
      (error) => error.code === 'EVENT_LOG_CONFIG_INVALID',
    )
  }
})

test('authorized mutations compare preimages and terminal state permanently closes mutation authority', (t) => {
  const { capability, directory, store } = stateHarness(t)
  const deliverable = path.join(directory, 'result.txt')
  fs.writeFileSync(deliverable, 'version one\n')
  const firstHash = sha256(fs.readFileSync(deliverable))
  advanceToWork(store)
  const permit = store.beginAuthorizedMutation({
    capability,
    expectedEpoch: 0,
    cause: 'later user steering',
    authority: { runId: 'run-0001', activationId: 'activation-001', nonce: 'nonce_123456789012', generation: 1 },
    preimages: [{ path: deliverable, hash: firstHash }],
  })
  assert.equal(permit.epoch, 1)
  assert.equal(store.load().terminal, null)
  assert.equal(store.load().state, 'RUN_WORK')
  fs.writeFileSync(deliverable, 'version two\n')
  const secondHash = sha256(fs.readFileSync(deliverable))
  store.commitAuthorizedMutation(permit, {
    capability,
    cause: 'steered result persisted',
    postimages: [{ path: deliverable, hash: secondHash }],
  })
  assert.equal(store.load().workspaceEpoch, 1)
  transition(store, 'CHECK_WORK')
  transition(store, 'FINAL_CHECK')
  transition(store, 'FINALIZING')
  store.bindTerminal('DONE', {
    capability,
    cause: 'checks green',
    deliverables: [{ path: deliverable, hash: secondHash }],
  })
  store.completeReleasedTerminal('DONE', { capability, cause: 'lease release proven' })
  assert.equal(store.validateTerminal().valid, true)
  assert.throws(
    () => store.beginAuthorizedMutation({
      expectedEpoch: 1,
      capability,
      cause: 'competing writer',
      authority: { runId: 'run-0001', activationId: 'activation-001', nonce: 'nonce_123456789012', generation: 1 },
      preimages: [{ path: deliverable, hash: firstHash }],
    }),
    (error) => error.code === 'MUTATION_AFTER_TERMINAL',
  )
  fs.writeFileSync(deliverable, 'foreign change\n')
  assert.equal(store.validateTerminal().reason, 'DELIVERABLE_HASH_CHANGED')
})

test('failed workers close the exact live mutation permit without reopening the prior epoch', (t) => {
  const { capability, directory, store } = stateHarness(t)
  const deliverable = path.join(directory, 'failed-worker.txt')
  fs.writeFileSync(deliverable, 'before\n')
  advanceToWork(store)
  const permit = store.beginAuthorizedMutation({
    capability,
    expectedEpoch: 0,
    cause: 'admit worker preimage',
    authority: { runId: 'run-0001', activationId: 'activation-001', nonce: 'nonce_123456789012', generation: 1 },
    preimages: [{ path: deliverable, hash: sha256(fs.readFileSync(deliverable)) }],
  })
  const aborted = store.abortAuthorizedMutation(permit, {
    capability,
    cause: 'worker result rejected',
    failureCode: 'OWNERSHIP_SCOPE_VIOLATION',
  })
  assert.equal(aborted.activeMutation, null)
  assert.equal(aborted.workspaceEpoch, 1)
  assert.throws(
    () => store.commitAuthorizedMutation(permit, { capability, cause: 'stale retry', postimages: [] }),
    error => error.code === 'MUTATION_PERMIT_INVALID',
  )
})

test('worker mutation permits fail closed unless commit and abort bind the admitted private workspace', (t) => {
  const { capability, directory, store } = stateHarness(t)
  const deliverable = path.join(directory, 'isolated-worker.txt')
  fs.writeFileSync(deliverable, 'before\n')
  advanceToWork(store)
  const authority = {
    runId: 'run-0001', activationId: 'activation-001', nonce: 'nonce_123456789012', generation: 1,
  }
  assert.throws(
    () => store.beginAuthorizedMutation({
      capability, authority, expectedEpoch: 0, requireIsolation: true,
      preimages: [{ path: deliverable, hash: sha256(fs.readFileSync(deliverable)) }],
      cause: 'worker without private workspace',
    }),
    error => error.code === 'MUTATION_ISOLATION_REQUIRED',
  )
  const isolation = { bindingHash: sha256('private-worker-workspace') }
  const permit = store.beginAuthorizedMutation({
    capability, authority, expectedEpoch: 0, requireIsolation: true, isolation,
    preimages: [{ path: deliverable, hash: sha256(fs.readFileSync(deliverable)) }],
    cause: 'admit private worker workspace',
  })
  assert.equal(permit.isolationBindingHash, isolation.bindingHash)
  assert.throws(
    () => store.commitAuthorizedMutation(permit, {
      capability, isolationBindingHash: sha256('foreign-workspace'), postimages: [], cause: 'foreign commit',
    }),
    error => error.code === 'MUTATION_ISOLATION_MISMATCH',
  )
  const aborted = store.abortAuthorizedMutation(permit, {
    capability, isolationBindingHash: isolation.bindingHash, cause: 'bound abort',
  })
  assert.equal(aborted.activeMutation, null)
})

test('canonical release intents deterministically bind every T068-T072 outcome and reject mismatch, replay, and tamper', (t) => {
  const cases = [
    {
      outcome: 'DONE',
      prepare(store) { advanceToFinalCheck(store); transition(store, 'FINALIZING') },
    },
    {
      outcome: 'PARTIAL',
      prepare(store) {
        advanceToWork(store)
        transition(store, 'RELEASING_LOCK', 'final budget cannot resume', 'BUDGET_EXHAUSTED_FINAL')
      },
    },
    {
      outcome: 'BLOCKED',
      prepare(store) {
        advanceToWork(store)
        transition(store, 'RELEASING_LOCK', 'dependency unavailable', 'ENVIRONMENT_BLOCKED')
      },
    },
    {
      outcome: 'CANCELLED',
      prepare(store) {
        transition(store, 'LOAD_SKILL')
        transition(store, 'RELEASING_LOCK', 'authorized cancel', 'CANCEL_REQUESTED')
      },
    },
    {
      outcome: 'FAILED',
      prepare(store) {
        advanceToWork(store)
        transition(store, 'WORKER_CONTEXT_LOST')
        transition(store, 'RELEASING_LOCK', 'context is unrecoverable', 'WORKER_CONTEXT_UNRECOVERABLE')
      },
    },
  ]
  for (const entry of cases) {
    const harness = stateHarness(t)
    entry.prepare(harness.store)
    const before = harness.store.load()
    if (entry.outcome !== 'DONE') {
      assert.equal(before.state, 'RELEASING_LOCK')
      assert.equal(before.terminal, null, 'crash before deterministic bind remains retryable')
      const mismatch = entry.outcome === 'PARTIAL' ? 'BLOCKED' : 'PARTIAL'
      assert.throws(() => harness.store.bindTerminal(mismatch, {
        capability: harness.capability,
        cause: 'caller-selected mismatch',
      }), (error) => error.code === 'OUTCOME_MISMATCH')
    }
    const bound = harness.store.bindTerminal(entry.outcome, {
      capability: harness.capability,
      cause: `canonical ${entry.outcome} reason`,
      unblockPath: entry.outcome === 'BLOCKED' ? 'install the named dependency' : null,
      terminalEnvelope: { providerStatus: entry.outcome },
      deliverables: [],
    })
    assert.equal(bound.terminal.outcome, entry.outcome)
    assertDraft202012Valid(
      path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
      [bound.terminal.terminalEnvelope],
    )
    if (entry.outcome !== 'DONE') {
      const replay = harness.store.bindTerminal(entry.outcome, {
        capability: harness.capability,
        cause: `canonical ${entry.outcome} reason`,
        terminalEnvelope: { providerStatus: entry.outcome },
        deliverables: [],
      })
      assert.equal(replay.checksum, bound.checksum, 'same release intent is idempotent')
      assert.throws(() => harness.store.bindTerminal(entry.outcome === 'FAILED' ? 'PARTIAL' : 'FAILED', {
        capability: harness.capability,
        cause: 'replay with changed outcome',
      }), (error) => error.code === 'OUTCOME_MISMATCH')
    }
    harness.store.completeReleasedTerminal(entry.outcome, {
      capability: harness.capability,
      cause: 'physical release proven',
    })
    assert.equal(harness.store.load().state, entry.outcome)
  }

  const partialContext = stateHarness(t)
  advanceToWork(partialContext.store)
  transition(partialContext.store, 'WORKER_CONTEXT_LOST')
  transition(
    partialContext.store,
    'RELEASING_LOCK',
    'context is unrecoverable after an accepted requested result survived',
    'WORKER_CONTEXT_UNRECOVERABLE_AFTER_PARTIAL_RESULT',
  )
  assert.throws(() => partialContext.store.bindTerminal('FAILED', {
    capability: partialContext.capability,
    cause: 'caller cannot discard surviving accepted result evidence',
  }), (error) => error.code === 'OUTCOME_MISMATCH')
  const partialContextBound = partialContext.store.bindTerminal('PARTIAL', {
    capability: partialContext.capability,
    cause: 'surviving accepted requested result is preserved',
    terminalEnvelope: { providerStatus: 'PARTIAL' },
    deliverables: [],
  })
  assert.equal(partialContextBound.terminal.releaseIntent.transitionId, 'T076')
  assert.equal(partialContextBound.terminal.outcome, 'PARTIAL')
  partialContext.store.completeReleasedTerminal('PARTIAL', {
    capability: partialContext.capability,
    cause: 'physical release proven',
  })
  assert.equal(partialContext.store.load().state, 'PARTIAL')

  const tampered = stateHarness(t)
  advanceToWork(tampered.store)
  transition(tampered.store, 'RELEASING_LOCK', 'final budget cannot resume', 'BUDGET_EXHAUSTED_FINAL')
  const eventPath = tampered.eventLog.logPath
  const source = fs.readFileSync(eventPath, 'utf8')
  fs.writeFileSync(eventPath, source.replace('BUDGET_EXHAUSTED_FINAL', 'ENVIRONMENT_BLOCKED'))
  assert.throws(() => tampered.store.bindTerminal('PARTIAL', {
    capability: tampered.capability,
    cause: 'tampered source must fail',
  }), (error) => error.code === 'RUN_RECORD_FAILURE')
})

test('target lease conflicts touch no owner bytes and verified stale owners are quarantined', (t) => {
  const directory = temporary(t)
  assert.throws(() => new MissionLock({ leaseRoot: 'relative-locks' }), (error) => error.code === 'LEASE_CONFIG_INVALID')
  assert.throws(() => new MissionLock({ leaseRoot: path.parse(directory).root }), (error) => error.code === 'LEASE_CONFIG_INVALID')
  const target = path.join(directory, 'target')
  const leaseRoot = path.join(directory, 'leases')
  fs.mkdirSync(target)
  const input = {
    targetPath: target,
    ledgerPath: path.join(target, '.autoprompt'),
    runId: 'run-one',
    activationId: 'activation-one',
    missionHash: digest('mission-one'),
    nonce: 'nonce_123456789012',
    generation: 1,
    pid: 101,
    processIdentity: 'pid-101-start-a',
    token: 'a'.repeat(48),
  }
  const activeLock = new MissionLock({
    leaseRoot,
    processIdentityObserver: leaseProcessObserver((pid) => pid === 101 ? 'pid-101-start-a' : null),
    identityProbe: () => ({ alive: true, verified: true, processIdentity: 'pid-101-start-a' }),
    randomId: () => 'lease-one',
  })
  const lease = activeLock.acquire(input)
  const held = activeLock.describe(lease)
  const movedTarget = path.join(directory, 'moved-target')
  fs.renameSync(target, movedTarget)
  assert.equal(activeLock.identify(movedTarget, path.join(movedTarget, '.autoprompt')).key, held.owner.targetKey)
  assert.throws(
    () => activeLock.acquire({
      ...input,
      targetPath: movedTarget,
      ledgerPath: path.join(movedTarget, '.autoprompt'),
      pid: 404,
      processIdentity: 'pid-404-after-rename',
    }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT',
  )
  fs.renameSync(movedTarget, target)
  const before = fs.readFileSync(held.ownerPath)
  assert.throws(
    () => activeLock.acquire({
      ...input,
      ledgerPath: path.join(target, 'different-ledger'),
      runId: 'run-two',
      activationId: 'activation-two',
      pid: 202,
      processIdentity: 'pid-202-start-b',
    }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT',
  )
  assert.deepEqual(fs.readFileSync(held.ownerPath), before)

  activeLock.updateOwnedProcesses(lease, [{ kind: 'posix-process-group', id: 'posix-pgid:999' }])
  const descendantBlind = new MissionLock({
    leaseRoot,
    processIdentityObserver: leaseProcessObserver(),
    identityProbe: () => ({ alive: false, verified: true }),
  })
  assert.throws(
    () => descendantBlind.acquire({ ...input, pid: 303, processIdentity: 'pid-303-start-c' }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT',
  )

  activeLock.updateOwnedProcesses(lease, [])

  const forgedEmptyRegistry = new MissionLock({
    leaseRoot,
    processIdentityObserver: leaseProcessObserver(),
    identityProbe: () => ({ alive: false, verified: true, ownedIdentityEvidence: [] }),
  })
  assert.throws(
    () => forgedEmptyRegistry.acquire({ ...input, pid: 304, processIdentity: 'pid-304-empty-current-registry' }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT',
  )

  const priorChildStillLive = new MissionLock({
    leaseRoot,
    processIdentityObserver: leaseProcessObserver(),
    identityProbe: (owner) => ({
      alive: true,
      verified: true,
      ownedIdentityEvidence: ownedIdentityEvidence(owner, new Set(['posix-process-group\0posix-pgid:999'])),
    }),
  })
  assert.throws(
    () => priorChildStillLive.acquire({ ...input, pid: 305, processIdentity: 'pid-305-live-prior-child' }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT',
  )

  const staleLock = new MissionLock({
    leaseRoot,
    processIdentityObserver: leaseProcessObserver(),
    identityProbe: (owner) => ({
      alive: false,
      verified: true,
      ownedIdentityEvidence: ownedIdentityEvidence(owner),
    }),
    randomId: () => 'lease-two',
  })
  const replacement = staleLock.acquire({
    ...input,
    runId: 'run-two',
    activationId: 'activation-two',
    pid: 202,
    processIdentity: 'pid-202-start-b',
    token: 'b'.repeat(48),
  })
  assert.equal(staleLock.describe(replacement).owner.activationId, 'activation-two')
  assert.equal(fs.readdirSync(leaseRoot).filter((name) => name.includes('.stale.lease-one.')).length, 1)
  staleLock.release(replacement)
  assert.equal(staleLock.assertReleased(replacement), true)
})

test('mission takeover distinguishes an exact live root from a reused PID by OS process epoch', (t) => {
  const currentProcessIdentity = processIdentityForPid(process.pid)
  assert.equal(typeof currentProcessIdentity, 'string')
  assert.match(currentProcessIdentity, process.platform === 'win32' ? /^windows-process-v1:/ : /^posix-process-v1:/)
  const directory = temporary(t)
  const target = path.join(directory, 'target')
  fs.mkdirSync(target)
  const realLock = new MissionLock({ leaseRoot: path.join(directory, 'real-leases') })
  const realInput = {
    targetPath: target, ledgerPath: path.join(target, '.autoprompt-real'), runId: 'run-real-epoch',
    activationId: 'activation-real-epoch', missionHash: digest('real-epoch-mission'),
    nonce: 'nonce_real_epoch_1234', generation: 1, pid: process.pid,
    processIdentity: currentProcessIdentity, token: 'e'.repeat(48),
  }
  const realCapability = realLock.acquire(realInput)
  assert.throws(() => realLock.acquire({ ...realInput, token: 'f'.repeat(48) }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT' && error.details.probe.rootProcessEvidence.status === 'LIVE')
  realLock.release(realCapability)

  let observedPriorIdentity = 'os-epoch-owner-a'
  const lock = new MissionLock({
    leaseRoot: path.join(directory, 'leases'),
    processIdentityObserver: leaseProcessObserver((pid) => pid === 777 ? observedPriorIdentity : null),
    identityProbe: (owner) => ({
      // This aggregate claim is deliberately forged. Root liveness is derived
      // independently from the OS epoch observer and descendant evidence only
      // accounts for the exact persisted descendant set.
      alive: true,
      verified: true,
      rootProcessEvidence: { status: 'DEAD' },
      ownedIdentityEvidence: ownedIdentityEvidence(owner),
    }),
    randomId: (() => { let value = 0; return () => `epoch-lease-${++value}` })(),
  })
  const input = {
    targetPath: target,
    ledgerPath: path.join(target, '.autoprompt'),
    runId: 'run-epoch',
    activationId: 'activation-epoch',
    missionHash: digest('epoch-mission'),
    nonce: 'nonce_epoch_12345678',
    generation: 1,
    pid: 777,
    processIdentity: 'os-epoch-owner-a',
    token: 'a'.repeat(48),
  }
  lock.acquire(input)
  assert.throws(() => lock.acquire({
    ...input, pid: 778, processIdentity: 'replacement-while-live', token: 'b'.repeat(48),
  }), (error) => error.code === 'WORKSPACE_LEASE_CONFLICT' && error.details.probe.rootProcessEvidence.status === 'LIVE')

  observedPriorIdentity = undefined
  assert.throws(() => lock.acquire({
    ...input, pid: 778, processIdentity: 'replacement-while-unknown', token: 'c'.repeat(48),
  }), (error) => error.code === 'WORKSPACE_LEASE_CONFLICT' && error.details.probe.rootProcessEvidence.status === 'UNKNOWN')

  observedPriorIdentity = 'os-epoch-reused-pid'
  const replacement = lock.acquire({
    ...input, pid: 778, processIdentity: 'replacement-after-pid-reuse', token: 'd'.repeat(48),
  })
  const takeover = lock.verifyCapability(replacement).takeover
  assert.equal(takeover.ownerProcessEvidence.status, 'PID_REUSED')
  assert.equal(takeover.ownerProcessEvidence.expectedProcessIdentity, 'os-epoch-owner-a')
  assert.equal(takeover.ownerProcessEvidence.observedProcessIdentity, 'os-epoch-reused-pid')
  assert.equal(takeover.ownerProcessVerifiedDead, true)
})

test('physical target identity fails closed without a stable file id and create/release sync containing directories', (t) => {
  const directory = temporary(t)
  const target = path.join(directory, 'target')
  const ledger = path.join(directory, 'ledger')
  const leaseRoot = path.join(directory, 'leases')
  fs.mkdirSync(target)
  fs.mkdirSync(ledger)
  const unstableFs = Object.create(fs)
  unstableFs.statSync = (filename) => {
    const value = fs.statSync(filename)
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { dev: 0, ino: 0 })
  }
  assert.throws(() => physicalDirectoryIdentity(target, unstableFs), (error) => error.code === 'TARGET_IDENTITY_UNSUPPORTED')

  const descriptorKinds = new Map()
  let directorySyncAttempts = 0
  const syncFs = Object.create(fs)
  syncFs.openSync = (filename, flags, mode) => {
    const descriptor = fs.openSync(filename, flags, mode)
    descriptorKinds.set(descriptor, fs.statSync(filename).isDirectory())
    return descriptor
  }
  syncFs.closeSync = (descriptor) => {
    descriptorKinds.delete(descriptor)
    return fs.closeSync(descriptor)
  }
  syncFs.fsyncSync = (descriptor) => {
    if (descriptorKinds.get(descriptor)) directorySyncAttempts += 1
    return fs.fsyncSync(descriptor)
  }
  atomicCreateJson(path.join(directory, 'terminal.json'), { value: 1 }, { fsImpl: syncFs })
  assert.ok(directorySyncAttempts >= 2, 'create link and temporary unlink each sync their containing directory')

  const lock = new MissionLock({
    leaseRoot,
    fsImpl: syncFs,
    processIdentityObserver: leaseProcessObserver((pid) => pid === 901 ? 'sync-owner' : null),
    identityProbe: () => ({ alive: true, verified: true, processIdentity: 'sync-owner' }),
    randomId: () => 'sync-lease',
  })
  const capability = lock.acquire({
    targetPath: target,
    ledgerPath: ledger,
    runId: 'run-sync-001',
    activationId: 'activation-sync',
    missionHash: digest('sync-mission'),
    nonce: 'nonce_sync_123456789',
    generation: 1,
    pid: 901,
    processIdentity: 'sync-owner',
    token: 'd'.repeat(48),
  })
  const beforeRelease = directorySyncAttempts
  let failReleaseSync = true
  const originalFsync = syncFs.fsyncSync
  syncFs.fsyncSync = (descriptor) => {
    if (failReleaseSync && descriptorKinds.get(descriptor)) {
      failReleaseSync = false
      const error = new Error('injected lease-root directory sync crash')
      error.code = 'EIO'
      throw error
    }
    return originalFsync(descriptor)
  }
  assert.throws(() => lock.release(capability), /injected lease-root directory sync crash/)
  assert.equal(lock.describe(capability).status, 'ACTIVE', 'authority is not reported released before the root sync')
  lock.release(capability)
  assert.ok(directorySyncAttempts > beforeRelease, 'lease-root rename is synced before release is reported')

  const crashCreatePath = path.join(directory, 'crash-terminal.json')
  let failCreateSync = true
  syncFs.fsyncSync = (descriptor) => {
    if (failCreateSync && descriptorKinds.get(descriptor)) {
      failCreateSync = false
      const error = new Error('injected terminal directory sync crash')
      error.code = 'EIO'
      throw error
    }
    return originalFsync(descriptor)
  }
  assert.throws(() => atomicCreateJson(crashCreatePath, { terminal: true }, { fsImpl: syncFs }), /injected terminal directory sync crash/)
  assert.equal(readChecksummedJson(crashCreatePath).terminal, true, 'linked terminal remains recoverable after sync-boundary crash')
  assert.doesNotThrow(() => fsyncDirectory(directory, syncFs), 'retry sync reconciles the existing terminal before release')
})

test('a different live lease capability cannot mutate a runtime with matching public activation values', (t) => {
  const directory = temporary(t)
  const firstTarget = path.join(directory, 'target-one')
  const secondTarget = path.join(directory, 'target-two')
  const firstRun = path.join(directory, 'run-one')
  const secondRun = path.join(directory, 'run-two')
  for (const item of [firstTarget, secondTarget, firstRun, secondRun]) fs.mkdirSync(item)
  const lock = new MissionLock({
    leaseRoot: path.join(directory, 'leases'),
    processIdentityObserver: leaseProcessObserver(),
    identityProbe: () => ({ alive: true, verified: true }),
  })
  const leaseInput = {
    runId: 'run-0001',
    activationId: 'activation-001',
    missionHash: digest('mission'),
    nonce: 'nonce_123456789012',
    generation: 1,
    pid: 700,
    processIdentity: 'same-public-process',
  }
  const first = lock.acquire({ ...leaseInput, targetPath: firstTarget, ledgerPath: firstRun, token: 'd'.repeat(48) })
  const second = lock.acquire({
    ...leaseInput,
    targetPath: secondTarget,
    ledgerPath: secondRun,
    pid: 701,
    processIdentity: 'other-live-process',
    token: 'e'.repeat(48),
  })
  const harness = stateHarness(t, {
    directory: firstRun,
    capability: first,
    binding: { ...binding(), targetIdentity: lock.verifyCapability(first).targetIdentity },
    capabilityVerifier: (candidate) => lock.verifyCapability(candidate),
  })
  assert.throws(
    () => harness.store.transition('LOAD_SKILL', { capability: second, cause: 'wrong target lease' }),
    (error) => error.code === 'LEASE_CAPABILITY_REQUIRED',
  )
  transition(harness.store, 'LOAD_SKILL')
  for (const state of [
    'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'ACQUIRE_TARGET_LOCK', 'SELECT_SAFE_RUN_ROOT',
    'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES', 'START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS',
    'L0_ROUTE_DECISION', 'PREPARE_WORK', 'RUN_WORK',
  ]) transition(harness.store, state)
  transition(harness.store, 'PAUSED', 'persist exact continuation', 'BUDGET_EXHAUSTED_RESUMABLE', {
    resumeState: 'RUN_WORK',
    nextReadyWorkIds: ['work-1'],
    remainingBudgetSeconds: 5,
    continuationBindingHash: digest('live-lease-continuation'),
  })
  lock.advanceGeneration(first, 1)
  assert.equal(harness.store.resumeGeneration({
    capability: first,
    expectedGeneration: 1,
    cause: 'lease-first generation resume',
  }).activation.generation, 2)
  lock.release(first)
  lock.release(second)
})

test('non-resetting budgets use monotonic elapsed time and retain usage across resume generations', () => {
  let monotonic = 1000
  let persistedWall = 1000000
  let wall = '2026-08-21T00:00:00.000Z'
  const controller = new BudgetController({
    limits: { wallMs: 1000, tokens: 100, sessions: 3, launches: 3 },
    phases: { EXECUTION: { softMs: 100, hardMs: 200 } },
    finalizationReserveMs: 100,
    monotonicMs: () => monotonic,
    wallClock: () => wall,
    wallNowMs: () => persistedWall,
    bootId: 'boot-one',
  })
  controller.startPhase('EXECUTION')
  monotonic += 150
  wall = '2036-08-21T00:00:00.000Z'
  assert.equal(controller.phaseStatus('EXECUTION').level, 'SOFT')
  assert.equal(controller.supervisorDecision('EXECUTION').action, 'REQUEST_CONVERGENCE')
  controller.requestConvergence('EXECUTION', { reason: 'soft breach' })
  assert.equal(controller.supervisorDecision('EXECUTION').action, 'WAIT_FOR_CONVERGENCE')
  monotonic += 60
  assert.equal(controller.supervisorDecision('EXECUTION').action, 'STOP_PHASE')
  controller.consumeTokens(25)
  controller.recordLaunch()
  controller.startSession('session-one')
  controller.endSession('session-one', { status: 'DONE', evidenceHashes: [digest('evidence')] })
  const highWater = controller.elapsedMs()
  monotonic = 900
  wall = '1999-01-01T00:00:00.000Z'
  assert.equal(controller.elapsedMs(), highWater)
  const generation = controller.beginGeneration({ reason: 'forced resume' })
  assert.equal(generation.generation, 2)
  assert.equal(generation.retainedBreaches, 1)
  assert.equal(controller.snapshot().tokensUsed, 25)
  assert.equal(controller.snapshot().launches, 1)
  assert.deepEqual(controller.snapshot().pendingConvergence, {})

  const restored = new BudgetController({
    limits: { wallMs: 5000, tokens: 1000, sessions: 30, launches: 30 },
    phases: { EXECUTION: { softMs: 100, hardMs: 200 } },
    monotonicMs: () => 5000,
    wallNowMs: () => persistedWall,
    bootId: 'boot-one',
    snapshot: controller.snapshot(),
  })
  assert.deepEqual(restored.status().limits, { wallMs: 1000, tokens: 100, sessions: 3, launches: 3 })
  assert.equal(restored.snapshot().generation, 2)
  assert.equal(restored.snapshot().tokensUsed, 25)
})

test('budget resume uses boot evidence or conservative wall time and fails closed on rollback', () => {
  let monotonic = 100
  let wallNow = 10000
  const original = new BudgetController({
    limits: { wallMs: 1000, tokens: 100, sessions: 2, launches: 2 },
    monotonicMs: () => monotonic,
    wallNowMs: () => wallNow,
    bootId: 'boot-a',
  })
  monotonic = 300
  wallNow = 10200
  const snapshot = original.snapshot()
  wallNow = 10400
  const rebooted = new BudgetController({
    limits: { wallMs: 1000, tokens: 100, sessions: 2, launches: 2 },
    monotonicMs: () => 10,
    wallNowMs: () => wallNow,
    bootId: 'boot-b',
    snapshot,
  })
  assert.equal(rebooted.elapsedMs(), 400)
  assert.throws(
    () => new BudgetController({
      limits: { wallMs: 1000, tokens: 100, sessions: 2, launches: 2 },
      monotonicMs: () => 10,
      wallNowMs: () => 9000,
      bootId: 'boot-b',
      snapshot,
    }),
    (error) => error.code === 'BUDGET_CLOCK_RESET',
  )
})

test('AP-RUN-030 accounting: honest budget restart preserves verification reserve and exposes its ceiling', () => {
  let monotonic = 100
  let wallNow = 10000
  const original = new BudgetController({
    limits: { wallMs: 1000, tokens: 100, sessions: 2, launches: 2 },
    monotonicMs: () => monotonic,
    wallNowMs: () => wallNow,
    finalizationReserveMs: 100,
    verificationReserveMs: 75,
    bootId: 'boot-a',
  })
  monotonic = 250
  wallNow = 10150
  const restored = new BudgetController({
    limits: { wallMs: 1000, tokens: 100, sessions: 2, launches: 2 },
    monotonicMs: () => 10,
    wallNowMs: () => 10300,
    finalizationReserveMs: 100,
    verificationReserveMs: 75,
    bootId: 'boot-b',
    snapshot: original.snapshot(),
  })
  assert.equal(restored.snapshot().verificationReserveMs, 75)
  assert.equal(restored.status({ forExecution: true }).verificationReserveMs, 75)
  assert.deepEqual(restored.accountingCeilings({ retries: 3, costMicrounits: 1000 }), {
    wallMilliseconds: 1000,
    totalTokens: 100,
    sessions: 2,
    launches: 2,
    retries: 3,
    costMicrounits: 1000,
    verificationReserveMilliseconds: 75,
    finalizationReserveMilliseconds: 100,
  })
})

test('budget ceilings can only lower product safety limits and invalid phases fail before launch', () => {
  assert.deepEqual(resolveCeilings({
    product: { wallMs: 1000, tokens: 1000, sessions: 10, launches: 10 },
    task: { wallMs: 900, tokens: 900, sessions: 9, launches: 9 },
    environment: { wallMs: 9000, tokens: 800, sessions: 80, launches: 8 },
  }), { wallMs: 900, tokens: 800, sessions: 9, launches: 8 })
  assert.throws(
    () => new BudgetController({
      limits: { wallMs: 1000, tokens: 100, sessions: 2, launches: 2 },
      phases: { EXECUTION: { softMs: 200, hardMs: 100 } },
    }),
    (error) => error.code === 'BUDGET_CONFIG_INVALID',
  )
})

test('separate accounting authority hash-chains launch and streamed token deltas, replays crashes, and rejects rollback', (t) => {
  const harness = stateHarness(t)
  transition(harness.store, 'LOAD_SKILL')
  let monotonic = 100
  let wallMs = Date.parse('2026-08-22T00:00:00.000Z')
  const budget = new BudgetController({
    limits: { wallMs: 10000, tokens: 1000, sessions: 10, launches: 10 },
    finalizationReserveMs: 100,
    phases: {},
    monotonicMs: () => monotonic,
    wallNowMs: () => wallMs,
    wallClock: () => new Date(wallMs).toISOString(),
    bootId: 'test-boot-accounting',
  })
  const capabilityBinding = () => ({
    runId: 'run-0001', activationId: 'activation-001', missionHash: digest('mission'),
    nonce: 'nonce_123456789012', generation: 1, targetIdentity: binding().targetIdentity,
  })
  const paths = {
    runRecordRoot: harness.directory,
    logPath: path.join(harness.directory, 'runtime', 'accounting.jsonl'),
    snapshotPath: path.join(harness.directory, 'runtime', 'budget.json'),
  }
  const makeAuthority = () => new AccountingAuthority({
    paths,
    eventLog: harness.eventLog,
    stateProvider: () => harness.store.load(),
    capabilityVerifier: (candidate) => candidate === harness.capability ? capabilityBinding() : null,
    budgetController: budget,
    additionalCeilings: { retries: 5, costMicrounits: 100000 },
    monotonicMs: () => monotonic,
    wallNowMs: () => wallMs,
    clock: () => new Date(wallMs).toISOString(),
    bootId: 'test-boot-accounting',
  })
  const authority = makeAuthority()
  const launch = authority.checkpoint({
    capability: harness.capability,
    cause: { kind: 'LAUNCH', causeId: 'launch:1', humanDescription: 'Persist one owned launch before exposing it.' },
    delta: accountingDelta({ launches: 1, sessions: 1 }),
  })
  assert.equal(launch.record.sequence, 1)
  assert.equal(launch.record.previousHash, null)
  assert.equal(launch.record.entryHash, accountingRecordHash(launch.record))
  assert.equal(launch.snapshot.snapshotHash, accountingSnapshotHash(launch.snapshot))
  monotonic = 125
  wallMs += 25
  const usage = authority.checkpoint({
    capability: harness.capability,
    cause: { kind: 'TOKEN_USAGE_RECORDED', causeId: 'codex-jsonl:1', humanDescription: 'Persist one streamed cumulative usage delta.' },
    delta: accountingDelta({
      costMicrounits: 50,
      tokenUsage: { noncachedInput: 3, cachedInput: 4, output: 5, reasoning: 6 },
    }),
  })
  assert.equal(usage.record.delta.elapsedMilliseconds, 25)
  assert.deepEqual(usage.record.cumulative.tokenUsage, { noncachedInput: 3, cachedInput: 4, output: 5, reasoning: 6 })
  assertDraft202012Valid(
    path.join(ROOT, 'agents', 'contracts', 'schemas', 'accounting-record.schema.json'),
    authority.replay().records,
  )
  assertDraft202012Valid(
    path.join(ROOT, 'agents', 'contracts', 'schemas', 'accounting-snapshot.schema.json'),
    [usage.snapshot],
  )

  fs.unlinkSync(paths.snapshotPath)
  monotonic = 150
  wallMs += 25
  const reopened = makeAuthority()
  assert.equal(reopened.replay().recoveryRequired, true)
  const recovered = reopened.checkpoint({
    capability: harness.capability,
    cause: { kind: 'RECOVERY', causeId: 'supervisor:restart', humanDescription: 'Charge the uncertain restart interval and rebuild the derived snapshot.' },
    delta: accountingDelta(),
  })
  assert.equal(recovered.record.delta.elapsedMilliseconds, 25)
  assert.equal(reopened.replay().recoveryRequired, false)

  const goodLog = fs.readFileSync(paths.logPath, 'utf8')
  const rows = goodLog.trim().split('\n').map((line) => JSON.parse(line))
  rows[0].occurredAt = '2027-01-01T00:00:00.000Z'
  fs.writeFileSync(paths.logPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  assert.throws(() => reopened.replay(), (error) => error.code === 'ACCOUNTING_LOG_INVALID')
  fs.writeFileSync(paths.logPath, goodLog)
  assert.throws(() => reopened.checkpoint({
    capability: Object.freeze({ forged: true }),
    cause: { kind: 'CHECKPOINT', causeId: 'forged', humanDescription: 'Must not persist.' },
    delta: accountingDelta(),
  }), (error) => error.code === 'LEASE_CAPABILITY_REQUIRED')

  const finalLog = fs.readFileSync(paths.logPath, 'utf8')
  const finalSnapshot = fs.readFileSync(paths.snapshotPath, 'utf8')
  const mutateLast = (mutation) => {
    const changed = finalLog.trim().split('\n').map((line) => JSON.parse(line))
    mutation(changed.at(-1), changed.at(-2))
    changed.at(-1).entryHash = accountingRecordHash(changed.at(-1))
    fs.writeFileSync(paths.logPath, `${changed.map((row) => JSON.stringify(row)).join('\n')}\n`)
  }
  mutateLast((last) => { last.cumulative.launches = 0 })
  assert.throws(() => reopened.replay(), (error) => error.code === 'ACCOUNTING_ROLLBACK')
  fs.writeFileSync(paths.logPath, finalLog)
  mutateLast((last, previous) => { last.monotonicClock.observedMilliseconds = previous.monotonicClock.observedMilliseconds - 1 })
  assert.throws(() => reopened.replay(), (error) => error.code === 'ACCOUNTING_CLOCK_INVALID')
  fs.writeFileSync(paths.logPath, finalLog)
  mutateLast((last) => { last.sequence += 1 })
  assert.throws(() => reopened.replay(), (error) => error.code === 'ACCOUNTING_LOG_INVALID')
  fs.writeFileSync(paths.logPath, finalLog)

  const changedSnapshot = JSON.parse(finalSnapshot)
  changedSnapshot.ceilings.launches += 1
  changedSnapshot.ceilingContractHash = digest(JSON.stringify(changedSnapshot.ceilings))
  changedSnapshot.snapshotHash = accountingSnapshotHash(changedSnapshot)
  fs.writeFileSync(paths.snapshotPath, `${JSON.stringify(changedSnapshot)}\n`)
  assert.throws(() => reopened.replay(), (error) => error.code === 'ACCOUNTING_SNAPSHOT_INVALID')
  fs.writeFileSync(paths.snapshotPath, finalSnapshot)
  fs.appendFileSync(paths.logPath, '{"incomplete":')
  assert.throws(() => reopened.replay(), (error) => error.code === 'ACCOUNTING_RECOVERY_REQUIRED')
  assert.throws(() => reopened.recoverCrashTail({ capability: harness.capability }), (error) =>
    error.code === 'ACCOUNTING_RECOVERY_REQUIRED' && fs.existsSync(error.details.evidencePath))
  const tailRecovery = reopened.recoverCrashTail({ capability: harness.capability, truncateIncompleteTail: true })
  assert.equal(tailRecovery.recovered, true)
  assert.equal(reopened.replay().records.length, 3)
})

test('accounting restart rejects verification reserve drift before reusing resume evidence', (t) => {
  const harness = stateHarness(t)
  transition(harness.store, 'LOAD_SKILL')
  let monotonic = 100
  let wallMs = Date.parse('2026-08-22T00:00:00.000Z')
  const paths = {
    runRecordRoot: harness.directory,
    logPath: path.join(harness.directory, 'runtime', 'accounting.jsonl'),
    snapshotPath: path.join(harness.directory, 'runtime', 'budget.json'),
  }
  const capabilityBinding = () => ({
    runId: 'run-0001',
    activationId: 'activation-001',
    missionHash: digest('mission'),
    nonce: 'nonce_123456789012',
    generation: 1,
    targetIdentity: binding().targetIdentity,
  })
  const makeAuthority = (verificationReserveMs) => new AccountingAuthority({
    paths,
    eventLog: harness.eventLog,
    stateProvider: () => harness.store.load(),
    capabilityVerifier: (candidate) => candidate === harness.capability ? capabilityBinding() : null,
    budgetController: new BudgetController({
      limits: { wallMs: 10000, tokens: 1000, sessions: 10, launches: 10 },
      finalizationReserveMs: 100,
      verificationReserveMs,
      phases: {},
      monotonicMs: () => monotonic,
      wallNowMs: () => wallMs,
      wallClock: () => new Date(wallMs).toISOString(),
      bootId: 'test-boot-accounting',
    }),
    additionalCeilings: { retries: 5, costMicrounits: 100000 },
    monotonicMs: () => monotonic,
    wallNowMs: () => wallMs,
    clock: () => new Date(wallMs).toISOString(),
    bootId: 'test-boot-accounting',
  })

  const authority = makeAuthority(75)
  authority.checkpoint({
    capability: harness.capability,
    cause: { kind: 'LAUNCH', causeId: 'launch:1', humanDescription: 'Persist one owned launch before exposing it.' },
    delta: accountingDelta({ launches: 1, sessions: 1 }),
  })
  assert.equal(makeAuthority(75).resumeCheckpoint().lastAccountingSequence, 1)
  assert.throws(
    () => makeAuthority(76).resumeCheckpoint(),
    (error) => error.code === 'ACCOUNTING_SNAPSHOT_INVALID',
  )
})

test('AP-RUN-030 accounting: tampered persisted verification reserve and ceilings fail closed on recovery', (t) => {
  let monotonic = 100
  let wallMs = Date.parse('2026-08-22T00:00:00.000Z')
  const budgetOptions = {
    limits: { wallMs: 10000, tokens: 1000, sessions: 10, launches: 10 },
    finalizationReserveMs: 100,
    verificationReserveMs: 75,
    phases: {},
    monotonicMs: () => monotonic,
    wallNowMs: () => wallMs,
    wallClock: () => new Date(wallMs).toISOString(),
    bootId: 'test-boot-accounting',
  }
  const honestBudget = new BudgetController(budgetOptions)
  const tamperedBudgetSnapshot = {
    ...honestBudget.snapshot(),
    verificationReserveMs: 74,
  }
  assert.throws(
    () => new BudgetController({ ...budgetOptions, snapshot: tamperedBudgetSnapshot }),
    (error) => error.code === 'BUDGET_SNAPSHOT_INVALID',
  )

  const harness = stateHarness(t)
  transition(harness.store, 'LOAD_SKILL')
  const paths = {
    runRecordRoot: harness.directory,
    logPath: path.join(harness.directory, 'runtime', 'accounting.jsonl'),
    snapshotPath: path.join(harness.directory, 'runtime', 'budget.json'),
  }
  const capabilityBinding = () => ({
    runId: 'run-0001',
    activationId: 'activation-001',
    missionHash: digest('mission'),
    nonce: 'nonce_123456789012',
    generation: 1,
    targetIdentity: binding().targetIdentity,
  })
  const makeAuthority = () => new AccountingAuthority({
    paths,
    eventLog: harness.eventLog,
    stateProvider: () => harness.store.load(),
    capabilityVerifier: (candidate) => candidate === harness.capability ? capabilityBinding() : null,
    budgetController: new BudgetController(budgetOptions),
    additionalCeilings: { retries: 5, costMicrounits: 100000 },
    monotonicMs: () => monotonic,
    wallNowMs: () => wallMs,
    clock: () => new Date(wallMs).toISOString(),
    bootId: 'test-boot-accounting',
  })
  makeAuthority().checkpoint({
    capability: harness.capability,
    cause: { kind: 'LAUNCH', causeId: 'launch:1', humanDescription: 'Persist the reserve-bound accounting ceiling.' },
    delta: accountingDelta({ launches: 1, sessions: 1 }),
  })
  const persisted = JSON.parse(fs.readFileSync(paths.snapshotPath, 'utf8'))
  assert.equal(persisted.ceilings.verificationReserveMilliseconds, 75)
  persisted.ceilings.verificationReserveMilliseconds = 74
  persisted.ceilingContractHash = digest(JSON.stringify(persisted.ceilings))
  persisted.snapshotHash = accountingSnapshotHash(persisted)
  fs.writeFileSync(paths.snapshotPath, `${JSON.stringify(persisted)}\n`)
  assert.throws(
    () => makeAuthority().resumeCheckpoint(),
    (error) => error.code === 'ACCOUNTING_SNAPSHOT_INVALID',
  )
})

test('recovery checkpoint authority binds scheduler, accounting, state, and crash frontier', async (t) => {
  const directory = temporary(t)
  const capability = Object.freeze({ opaque: 'recovery-authority-capability' })
  const capabilityBinding = {
    runId: 'run-0001', activationId: 'activation-001', missionHash: digest('mission'),
    nonce: 'nonce_123456789012', generation: 1, targetIdentity: binding().targetIdentity,
  }
  const verifyCapability = (candidate) => {
    if (candidate !== capability) throw new Error('foreign capability')
    return { ...capabilityBinding }
  }
  const harness = stateHarness(t, { directory, capability, capabilityVerifier: verifyCapability })
  advanceToWork(harness.store)
  let monotonic = 100
  const wall = Date.parse('2026-08-22T02:00:00.000Z')
  const accounting = new AccountingAuthority({
    paths: {
      runRecordRoot: directory,
      logPath: path.join(directory, 'runtime', 'accounting.jsonl'),
      snapshotPath: path.join(directory, 'runtime', 'budget.json'),
    },
    eventLog: harness.eventLog, stateProvider: () => harness.store.load(), capabilityVerifier: verifyCapability,
    budgetController: new BudgetController({
      limits: { wallMs: 10000, tokens: 1000, sessions: 10, launches: 10 }, finalizationReserveMs: 100,
      phases: {}, monotonicMs: () => monotonic, wallNowMs: () => wall,
      wallClock: () => new Date(wall).toISOString(), bootId: 'boot-recovery',
    }),
    additionalCeilings: { retries: 5, costMicrounits: 100000 },
    monotonicMs: () => monotonic, wallNowMs: () => wall,
    clock: () => new Date(wall + monotonic).toISOString(), bootId: 'boot-recovery',
  })
  accounting.checkpoint({
    capability,
    cause: { kind: 'CHECKPOINT', causeId: 'recovery:first-accounting', humanDescription: 'Persist accounting before the scheduler checkpoint.' },
    delta: accountingDelta({ sessions: 1, launches: 1, tokenUsage: { output: 2 } }),
  })
  const paths = {
    runRecordRoot: directory,
    logPath: path.join(directory, 'runtime', 'recovery-checkpoints.jsonl'),
    snapshotPath: path.join(directory, 'runtime', 'recovery-checkpoint.json'),
  }
  let occurred = 0
  let durableResultCommit = null
  const resultCommitVerifier = () => {
    if (!durableResultCommit) throw new Error('terminal receipt is not durable')
    return { ...durableResultCommit }
  }
  const authority = new RecoveryCheckpointAuthority({
    paths, eventLog: harness.eventLog, stateProvider: () => harness.store.load(), capabilityVerifier: verifyCapability,
    accountingCheckpointVerifier: (evidence) => accounting.verifyResumeCheckpoint(evidence),
    accountingCheckpointProvider: () => accounting.resumeCheckpoint(),
    resultCommitVerifier,
    clock: () => new Date(Date.UTC(2026, 7, 22, 3, 0, occurred++)).toISOString(),
  })
  const scheduler = schedulerCheckpointFixture({
    route: 'LIGHT', phase: 'RUN_WORK', nextReadyWorkIds: ['work-2'], completedWorkIds: ['work-1'],
    usage: { output: 2 }, cursor: 1,
  })
  const decodedScheduler = decodeSchedulerCheckpoint(scheduler)
  assert.equal(decodedScheduler.stateHash, scheduler.stateHash)
  for (const field of ['ownerSessionId', 'route', 'phase', 'candidate', 'completedWorkIds', 'completedCheckIds',
    'openCheckIds', 'nextReadyWorkIds', 'leases', 'usage', 'reserves']) {
    assert.deepEqual(decodedScheduler[field], scheduler[field])
  }
  const checkpointInput = {
    capability, providerCapabilitiesHash: digest('provider-capabilities-v1'),
    accountingCheckpoint: accounting.resumeCheckpoint(), scheduler,
    recovery: {
      savedState: 'RUN_WORK', resumeState: 'RUN_WORK',
      frontier: { nextReadyWorkIds: ['work-2'], openCheckIds: [], acceptedResultIds: [scheduler.stateHash] },
      completedMilestones: ['route-analysis', 'route-decision', 'work-preparation'],
      externalRecovery: { status: 'none', operationIds: [], idempotencyKeys: [], receiptHashes: [] },
      releaseIntentHash: null,
    },
    immutableHashes: {
      requestEnvelopeHash: harness.store.load().requestEnvelopeHash,
      routeDecisionHash: digest('route-decision'), planHash: digest('plan'), candidateHash: null,
    },
    externalOperations: [],
    humanDescription: 'Persist the admitted scheduler frontier and exact accounting boundary.',
    cause: { kind: 'ADMISSION', causeId: 'scheduler:work-2', humanDescription: 'Scheduler admitted work-2.' },
  }
  const openLease = (leaseId, workItemId) => ({
    leaseId, workItemId, roleId: 'autoprompt.v2.ap-worker', status: 'OPEN', parentLeaseId: null,
    reservationId: `reservation-${leaseId}`, sessionId: `session-${leaseId}`, continuationId: `continuation-${leaseId}`,
    crashBindingHash: digest(`binding-${leaseId}`),
    resources: [{ id: path.join(directory, 'shared-resource'), kind: 'workspace', mode: 'exclusive', isolationId: leaseId }],
    usage: schedulerUsage(), reserves: schedulerUsage(),
    thread: { started: true, startedEventHash: digest(`thread-${leaseId}`), startedAt: '2026-08-22T02:00:00.000Z' },
  })
  const collidingScheduler = schedulerCheckpointFixture({
    route: 'LIGHT', phase: 'RUN_WORK', nextReadyWorkIds: ['work-2'], completedWorkIds: ['work-1'],
    leases: [openLease('lease-a', 'work-a'), openLease('lease-b', 'work-b')],
  })
  assert.throws(() => authority.appendCheckpoint({
    ...checkpointInput, scheduler: collidingScheduler,
    recovery: { ...checkpointInput.recovery, frontier: { ...checkpointInput.recovery.frontier, acceptedResultIds: [collidingScheduler.stateHash] } },
  }), (error) => error.code === 'RECOVERY_CHECKPOINT_INVALID' && /resource collision/.test(error.message))
  const externalOperations = ['one', 'two'].map((suffix) => ({
    operationId: `operation-${suffix}`, status: 'COMMITTED_UNRECONCILED', idempotencyKey: `idempotency-${suffix}`,
    prepareReceiptHash: digest(`prepare-${suffix}`), commitReceiptHash: digest(`commit-${suffix}`),
    reconcileReceiptHash: null, rollbackReceiptHash: null, nextAction: 'RECONCILE',
  }))
  assert.throws(() => authority.appendCheckpoint({
    ...checkpointInput,
    recovery: {
      ...checkpointInput.recovery, resumeState: 'CHECK_WORK',
      externalRecovery: {
        status: 'reconciliation-required', operationIds: ['operation-one'], idempotencyKeys: ['idempotency-one'],
        receiptHashes: [digest('commit-one')],
      },
    },
    externalOperations,
  }), (error) => error.code === 'RECOVERY_CHECKPOINT_INVALID' && /bijectively bind/.test(error.message))
  assert.throws(() => authority.appendCheckpoint({ ...checkpointInput, capability: Object.freeze({ forged: true }) }),
    (error) => error.code === 'LEASE_CAPABILITY_REQUIRED')
  const first = authority.appendCheckpoint(checkpointInput)
  assert.equal(authority.verifyResumeCheckpoint(authority.resumeCheckpoint()).record.entryHash, first.record.entryHash)
  assertDraft202012Valid(path.join(ROOT, 'agents', 'contracts', 'schemas', 'recovery-checkpoint-record.schema.json'), [first.record])
  assertDraft202012Valid(path.join(ROOT, 'agents', 'contracts', 'schemas', 'recovery-checkpoint-snapshot.schema.json'), [first.snapshot])

  const pendingScheduler = schedulerCheckpointFixture({ route: 'PENDING', phase: 'L0_ROUTE_DECISION', cursor: 0 })
  assert.throws(() => authority.appendCheckpoint({
    ...checkpointInput, scheduler: pendingScheduler,
    recovery: { ...checkpointInput.recovery, frontier: { ...checkpointInput.recovery.frontier, acceptedResultIds: [pendingScheduler.stateHash] } },
    immutableHashes: { ...checkpointInput.immutableHashes, routeDecisionHash: digest('invented') },
  }), (error) => error.code === 'RECOVERY_CHECKPOINT_IMMUTABLE_MISMATCH')

  monotonic += 10
  accounting.checkpoint({
    capability,
    cause: { kind: 'TOKEN_USAGE_RECORDED', causeId: 'usage:work-2', humanDescription: 'Persist usage before its recovery checkpoint.' },
    delta: accountingDelta({ tokenUsage: { output: 1 } }),
  })
  assert.throws(() => authority.resumeCheckpoint(), (error) => error.code === 'RECOVERY_CHECKPOINT_ACCOUNTING_STALE')
  const secondScheduler = schedulerCheckpointFixture({
    route: 'LIGHT', phase: 'RUN_WORK', nextReadyWorkIds: ['work-2'], completedWorkIds: ['work-1'],
    usage: { output: 3 }, cursor: 2,
  })
  const second = authority.appendCheckpoint({
    ...checkpointInput, accountingCheckpoint: accounting.resumeCheckpoint(), scheduler: secondScheduler,
    recovery: { ...checkpointInput.recovery, frontier: { ...checkpointInput.recovery.frontier, acceptedResultIds: [secondScheduler.stateHash] } },
    cause: { kind: 'USAGE_RECORDED', causeId: 'usage:work-2:2', humanDescription: 'Bind the latest streamed usage.' },
  })
  assert.equal(second.record.sequence, 2)
  assert.equal(second.record.previousHash, first.record.entryHash)
  const goodLog = fs.readFileSync(paths.logPath, 'utf8')
  const goodSnapshot = fs.readFileSync(paths.snapshotPath, 'utf8')
  fs.writeFileSync(paths.snapshotPath, `${JSON.stringify(first.snapshot)}\n`)
  assert.equal(authority.replay().recoveryRequired, true)
  assert.throws(() => authority.resumeCheckpoint(), (error) => error.code === 'RECOVERY_CHECKPOINT_RECOVERY_REQUIRED')
  fs.writeFileSync(paths.snapshotPath, goodSnapshot)

  const mutateLog = (mutation) => {
    const rows = goodLog.trim().split('\n').map((line) => JSON.parse(line))
    mutation(rows)
    fs.writeFileSync(paths.logPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  }
  mutateLog((rows) => { rows[0].occurredAt = '2027-01-01T00:00:00.000Z' })
  assert.throws(() => authority.replay(), (error) => error.code === 'RECOVERY_CHECKPOINT_LOG_INVALID')
  fs.writeFileSync(paths.logPath, goodLog)
  mutateLog((rows) => { rows[1].sequence = 4; rows[1].entryHash = recoveryCheckpointEntryHash(rows[1]) })
  assert.throws(() => authority.replay(), (error) => error.code === 'RECOVERY_CHECKPOINT_LOG_INVALID')
  fs.writeFileSync(paths.logPath, goodLog)
  mutateLog((rows) => { rows[0].authority.runId = 'foreign-run-0001'; rows[0].entryHash = recoveryCheckpointEntryHash(rows[0]) })
  assert.throws(() => authority.replay())
  fs.writeFileSync(paths.logPath, goodLog)

  const changedSnapshot = JSON.parse(goodSnapshot)
  changedSnapshot.recordedAt = '2027-01-01T00:00:00.000Z'
  changedSnapshot.snapshotHash = recoveryCheckpointSnapshotHash(changedSnapshot)
  fs.writeFileSync(paths.snapshotPath, `${JSON.stringify(changedSnapshot)}\n`)
  assert.throws(() => authority.replay(), (error) => error.code === 'RECOVERY_CHECKPOINT_SNAPSHOT_INVALID')
  fs.writeFileSync(paths.snapshotPath, goodSnapshot)
  fs.appendFileSync(paths.logPath, '{"incomplete":')
  assert.throws(() => authority.replay(), (error) => error.code === 'RECOVERY_CHECKPOINT_RECOVERY_REQUIRED')
  assert.throws(() => authority.recoverCrashTail({ capability }), (error) =>
    error.code === 'RECOVERY_CHECKPOINT_RECOVERY_REQUIRED' && fs.existsSync(error.details.evidencePath))
  assert.equal(authority.recoverCrashTail({ capability, truncateIncompleteTail: true }).recovered, true)
  assert.equal(authority.replay().records.length, 2)

  let injectSnapshotFailure = true
  const faultingAuthority = new RecoveryCheckpointAuthority({
    paths, eventLog: harness.eventLog, stateProvider: () => harness.store.load(), capabilityVerifier: verifyCapability,
    accountingCheckpointVerifier: (evidence) => accounting.verifyResumeCheckpoint(evidence),
    accountingCheckpointProvider: () => accounting.resumeCheckpoint(),
    clock: () => new Date(Date.UTC(2026, 7, 22, 3, 0, occurred++)).toISOString(),
    beforeSnapshotCommit: () => {
      if (injectSnapshotFailure) { injectSnapshotFailure = false; throw Object.assign(new Error('injected snapshot EIO'), { code: 'EIO' }) }
    },
  })
  assert.throws(() => faultingAuthority.appendCheckpoint({
    ...checkpointInput, accountingCheckpoint: accounting.resumeCheckpoint(), scheduler: secondScheduler,
    recovery: { ...checkpointInput.recovery, frontier: { ...checkpointInput.recovery.frontier, acceptedResultIds: [secondScheduler.stateHash] } },
    cause: { kind: 'CHECKPOINT', causeId: 'fault:snapshot', humanDescription: 'Inject failure after durable log append.' },
  }), (error) => error.code === 'EIO')
  assert.equal(authority.replay().recoveryRequired, true)
  const restartedAfterSnapshotFailure = new RecoveryCheckpointAuthority({
    paths, eventLog: harness.eventLog, stateProvider: () => harness.store.load(), capabilityVerifier: verifyCapability,
    accountingCheckpointVerifier: (evidence) => accounting.verifyResumeCheckpoint(evidence),
    accountingCheckpointProvider: () => accounting.resumeCheckpoint(),
    clock: () => new Date(Date.UTC(2026, 7, 22, 3, 0, occurred++)).toISOString(),
  })
  const rebuilt = restartedAfterSnapshotFailure.recoverCrashTail({ capability })
  assert.equal(rebuilt.recovered, true)
  assert.equal(rebuilt.recoveryKind, 'snapshot-rebuilt')
  assert.equal(rebuilt.records.length, 3)
  assert.equal(rebuilt.snapshot.lastCheckpointSequence, 3)
  assert.equal(restartedAfterSnapshotFailure.resumeCheckpoint().record.sequence, 3)
  assert.equal(restartedAfterSnapshotFailure.recoverCrashTail({ capability }).recovered, false)
  const rebuiltSnapshotBytes = fs.readFileSync(paths.snapshotPath, 'utf8')
  fs.unlinkSync(paths.snapshotPath)
  assert.equal(restartedAfterSnapshotFailure.reconcileSnapshot({ capability }).recovered, true)
  assert.equal(restartedAfterSnapshotFailure.resumeCheckpoint().record.sequence, 3)
  const divergentSnapshot = JSON.parse(rebuiltSnapshotBytes)
  divergentSnapshot.lastCheckpointHash = digest('foreign-checkpoint-entry')
  divergentSnapshot.snapshotHash = recoveryCheckpointSnapshotHash(divergentSnapshot)
  fs.writeFileSync(paths.snapshotPath, `${JSON.stringify(divergentSnapshot)}\n`)
  assert.throws(() => restartedAfterSnapshotFailure.reconcileSnapshot({ capability }), (error) =>
    error.code === 'RECOVERY_CHECKPOINT_SNAPSHOT_INVALID')
  fs.writeFileSync(paths.snapshotPath, rebuiltSnapshotBytes)
  const reconciled = authority.appendCheckpoint({
    ...checkpointInput, accountingCheckpoint: accounting.resumeCheckpoint(), scheduler: secondScheduler,
    recovery: { ...checkpointInput.recovery, frontier: { ...checkpointInput.recovery.frontier, acceptedResultIds: [secondScheduler.stateHash] } },
    cause: { kind: 'CHECKPOINT', causeId: 'fault:retry', humanDescription: 'Append after restart rebuilt the interrupted snapshot replace.' },
  })
  assert.equal(reconciled.record.sequence, 4)
  assert.equal(authority.replay().recoveryRequired, false)

  const childScript = [
    "const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'))",
    "const {EventLog,readChecksummedJson,stableStringify}=require(input.eventModule)",
    "const {RecoveryCheckpointAuthority}=require(input.recoveryModule)",
    "const eventLog=new EventLog({logPath:input.eventPath,blobDirectory:input.blobPath,binding:input.binding})",
    "const authority=new RecoveryCheckpointAuthority({paths:input.paths,eventLog,stateProvider:()=>readChecksummedJson(input.statePath),capabilityVerifier:(candidate)=>{if(!candidate||candidate.secret!=='cap')throw new Error('foreign');return input.capabilityBinding},accountingCheckpointVerifier:(evidence)=>{if(stableStringify(evidence)!==stableStringify(input.accounting))throw new Error('stale');return input.accounting},accountingCheckpointProvider:()=>input.accounting,clock:()=>input.occurredAt})",
    'authority.appendCheckpoint(input.checkpointInput)',
  ].join(';')
  const launchWriter = (causeId, secondOffset) => new Promise((resolve, reject) => {
    const childInput = {
      eventModule: path.join(WORKFLOW, 'event-log.js'), recoveryModule: path.join(WORKFLOW, 'recovery-checkpoint.js'),
      eventPath: path.join(directory, 'runtime', 'events.jsonl'), blobPath: path.join(directory, 'blobs'),
      statePath: harness.store.statePath, binding: binding(), paths, capabilityBinding,
      accounting: accounting.resumeCheckpoint(), occurredAt: new Date(Date.UTC(2026, 7, 22, 3, 1, secondOffset)).toISOString(),
      checkpointInput: {
        ...checkpointInput, capability: { secret: 'cap' }, accountingCheckpoint: accounting.resumeCheckpoint(),
        scheduler: secondScheduler,
        recovery: { ...checkpointInput.recovery, frontier: { ...checkpointInput.recovery.frontier, acceptedResultIds: [secondScheduler.stateHash] } },
        cause: { kind: 'CHECKPOINT', causeId, humanDescription: `Concurrent writer ${causeId}.` },
      },
    }
    const child = childProcess.spawn(process.execPath, ['-e', childScript, Buffer.from(JSON.stringify(childInput)).toString('base64')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer ${causeId} exited ${code}: ${stderr}`)))
  })
  await Promise.all([launchWriter('race:writer-a', 1), launchWriter('race:writer-b', 2)])
  const raced = authority.replay()
  assert.equal(raced.records.length, 6)
  assert.deepEqual(raced.records.map((record) => record.sequence), [1, 2, 3, 4, 5, 6])
  assert.equal(raced.snapshot.lastCheckpointSequence, 6)

  occurred = 120
  const committedLease = openLease('lease-result', 'work-result')
  const committedScheduler = schedulerCheckpointFixture({
    route: 'LIGHT', phase: 'RUN_WORK', nextReadyWorkIds: ['work-2'], completedWorkIds: ['work-1'],
    leases: [committedLease], usage: { output: 3 }, cursor: 3,
  })
  const resultCommit = {
    assignmentId: committedLease.workItemId,
    assignmentHash: digest('assignment-work-result'),
    leaseId: committedLease.leaseId,
    sessionId: committedLease.sessionId,
    continuationId: committedLease.continuationId,
    resultHash: digest('result-work-result'),
    receiptHash: digest('terminal-receipt-work-result'),
    candidateHash: null,
  }
  durableResultCommit = {
    runId: capabilityBinding.runId,
    activationId: capabilityBinding.activationId,
    generation: capabilityBinding.generation,
    ...resultCommit,
  }
  const committedInput = {
    ...checkpointInput,
    accountingCheckpoint: accounting.resumeCheckpoint(),
    scheduler: committedScheduler,
    recovery: {
      ...checkpointInput.recovery,
      frontier: {
        ...checkpointInput.recovery.frontier,
        acceptedResultIds: [committedScheduler.stateHash, resultCommit.receiptHash],
      },
    },
    cause: {
      kind: 'RESULT_COMMITTED',
      causeId: `scheduler:1:${committedLease.leaseId}:result:${resultCommit.receiptHash.slice(0, 24)}`,
      humanDescription: 'Persist the exact terminal receipt before releasing its scheduler lease.',
      resultCommit,
    },
  }
  const committed = authority.appendCheckpoint(committedInput)
  assert.equal(committed.record.sequence, 7)
  assertDraft202012Valid(path.join(ROOT, 'agents', 'contracts', 'schemas', 'recovery-checkpoint-record.schema.json'), [committed.record])
  const restartedWithReceipt = new RecoveryCheckpointAuthority({
    paths, eventLog: harness.eventLog, stateProvider: () => harness.store.load(), capabilityVerifier: verifyCapability,
    accountingCheckpointVerifier: (evidence) => accounting.verifyResumeCheckpoint(evidence),
    accountingCheckpointProvider: () => accounting.resumeCheckpoint(), resultCommitVerifier,
  })
  assert.equal(restartedWithReceipt.replay().records.at(-1).entryHash, committed.record.entryHash)
  const committedLogBytes = fs.readFileSync(paths.logPath, 'utf8')
  const tamperedCommitRows = committedLogBytes.trim().split('\n').map(line => JSON.parse(line))
  tamperedCommitRows.at(-1).cause.resultCommit.resultHash = digest('replayed-foreign-result')
  tamperedCommitRows.at(-1).entryHash = recoveryCheckpointEntryHash(tamperedCommitRows.at(-1))
  fs.writeFileSync(paths.logPath, `${tamperedCommitRows.map(row => JSON.stringify(row)).join('\n')}\n`)
  assert.throws(() => restartedWithReceipt.replay(), (error) => error.code === 'RECOVERY_CHECKPOINT_RESULT_UNVERIFIED')
  fs.writeFileSync(paths.logPath, committedLogBytes)

  const assertCommitMutationRejected = (field, value, mutateDurable = false) => {
    const changed = JSON.parse(JSON.stringify(committedInput))
    changed.capability = capability
    if (mutateDurable) durableResultCommit = { ...durableResultCommit, [field]: value }
    else changed.cause.resultCommit[field] = value
    assert.throws(() => authority.appendCheckpoint(changed), (error) =>
      ['RECOVERY_CHECKPOINT_RESULT_INVALID', 'RECOVERY_CHECKPOINT_RESULT_UNVERIFIED'].includes(error.code), field)
    durableResultCommit = { runId: capabilityBinding.runId, activationId: capabilityBinding.activationId,
      generation: capabilityBinding.generation, ...resultCommit }
  }
  assertCommitMutationRejected('assignmentId', 'wrong-assignment')
  assertCommitMutationRejected('sessionId', 'wrong-session')
  assertCommitMutationRejected('resultHash', digest('wrong-result'))
  assertCommitMutationRejected('candidateHash', digest('wrong-candidate'))
  assertCommitMutationRejected('receiptHash', digest('wrong-receipt'))
  assertCommitMutationRejected('assignmentHash', digest('wrong-assignment-hash'))
  assertCommitMutationRejected('generation', 2, true)
  transition(harness.store, 'CHECK_WORK')
  assert.throws(() => authority.resumeCheckpoint(), (error) => error.code === 'RECOVERY_CHECKPOINT_STATE_STALE')
})

test('canonical crash adoption restores exact analyst, L0, worker, and checker checkpoints without resetting accounting', (t) => {
  assert.throws(() => prepareCrashCheckpoint({
    savedState: 'RUN_WORK',
    resumeState: 'RUN_WORK',
    frontier: { nextReadyWorkIds: ['work-1'], openCheckIds: [], acceptedResultIds: [] },
    completedMilestones: ['external-prepare'],
    externalRecovery: {
      status: 'reconciliation-required', operationIds: ['operation-1'],
      idempotencyKeys: ['idempotency-1'], receiptHashes: [],
    },
    releaseIntentHash: null,
  }), (error) => error.code === 'CRASH_CHECKPOINT_INVALID')
  const cases = [
    {
      name: 'post-analyst',
      states: ['LOAD_SKILL', 'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'ACQUIRE_TARGET_LOCK',
        'SELECT_SAFE_RUN_ROOT', 'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES', 'START_ROUTE_ANALYST'],
      savedState: 'SAVE_ROUTE_ANALYSIS', eventId: 'ROUTE_ANALYST_STARTED', resumeState: 'L0_ROUTE_DECISION',
      completedMilestones: ['route-analysis'],
      frontier: { nextReadyWorkIds: [], openCheckIds: [], acceptedResultIds: [] },
      externalRecovery: { status: 'none', operationIds: [], idempotencyKeys: [], receiptHashes: [] },
    },
    {
      name: 'post-root-l0',
      states: ['LOAD_SKILL', 'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'ACQUIRE_TARGET_LOCK',
        'SELECT_SAFE_RUN_ROOT', 'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES', 'START_ROUTE_ANALYST',
        'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION'],
      savedState: 'PREPARE_WORK', resumeState: 'PREPARE_WORK',
      completedMilestones: ['route-analysis', 'route-decision'],
      frontier: { nextReadyWorkIds: ['work-1'], openCheckIds: [], acceptedResultIds: [] },
      externalRecovery: { status: 'none', operationIds: [], idempotencyKeys: [], receiptHashes: [] },
    },
    {
      name: 'post-worker',
      states: ['LOAD_SKILL', 'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'ACQUIRE_TARGET_LOCK',
        'SELECT_SAFE_RUN_ROOT', 'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES', 'START_ROUTE_ANALYST',
        'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION', 'PREPARE_WORK'],
      savedState: 'RUN_WORK', resumeState: 'CHECK_WORK',
      completedMilestones: ['route-analysis', 'route-decision', 'work-preparation', 'external-prepare', 'external-commit'],
      frontier: { nextReadyWorkIds: [], openCheckIds: ['check-work-1'], acceptedResultIds: ['result-work-1'] },
      externalRecovery: {
        status: 'reconciliation-required', operationIds: ['operation-work-1'],
        idempotencyKeys: ['idempotency-work-1'], receiptHashes: [digest('worker-receipt')],
      },
    },
    {
      name: 'post-checker',
      states: ['LOAD_SKILL', 'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'ACQUIRE_TARGET_LOCK',
        'SELECT_SAFE_RUN_ROOT', 'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES', 'START_ROUTE_ANALYST',
        'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION', 'PREPARE_WORK', 'RUN_WORK', 'CHECK_WORK'],
      savedState: 'FINAL_CHECK', resumeState: 'FINALIZING',
      completedMilestones: ['route-analysis', 'route-decision', 'work-preparation', 'external-prepare',
        'external-commit', 'external-reconcile', 'final-check'],
      frontier: { nextReadyWorkIds: [], openCheckIds: [], acceptedResultIds: ['result-work-1'] },
      externalRecovery: { status: 'none', operationIds: [], idempotencyKeys: [], receiptHashes: [] },
    },
  ]

  for (const entry of cases) {
    const directory = temporary(t)
    const target = path.join(directory, 'target')
    fs.mkdirSync(target)
    let ownerProbe = 'live'
    let leaseNumber = 0
    const lock = new MissionLock({
      leaseRoot: path.join(directory, 'leases'),
      processIdentityObserver: leaseProcessObserver((pid) =>
        pid === 101 && ownerProbe === 'live' ? `prior-root-${entry.name}` : null),
      identityProbe: (owner) => ownerProbe === 'stale'
        ? { alive: false, verified: true, ownedIdentityEvidence: ownedIdentityEvidence(owner) }
        : ownerProbe === 'undrained'
          ? { alive: false, verified: true, ownedIdentityEvidence: ownedIdentityEvidence(owner, new Set([`test-group\0owned-${entry.name}`])) }
          : { alive: true, verified: true },
      randomId: () => `lease-${entry.name}-${++leaseNumber}`,
    })
    const leaseInput = {
      targetPath: target, ledgerPath: path.join(target, '.autoprompt'), runId: 'run-0001',
      activationId: 'activation-001', missionHash: digest('mission'), nonce: 'nonce_123456789012',
      pid: 101, processIdentity: `prior-root-${entry.name}`, generation: 1, token: 'a'.repeat(48),
    }
    const priorCapability = lock.acquire(leaseInput)
    lock.updateOwnedProcesses(priorCapability, [{ id: `owned-${entry.name}`, kind: 'test-group' }])
    let accounting
    let recoveryAuthority
    const harness = stateHarness(t, {
      directory: path.join(directory, 'run-record'), capability: priorCapability,
      binding: { ...binding(), targetIdentity: lock.verifyCapability(priorCapability).targetIdentity },
      capabilityVerifier: (candidate) => lock.verifyCapability(candidate),
      recoveryCheckpointVerifier: (checkpoint) => recoveryAuthority.verifyResumeCheckpoint(checkpoint),
      budgets: { launches: 7, sessions: 4, tokens: 99 },
      resourceState: { schedulerSessions: [`session-${entry.name}`] },
    })
    for (const state of entry.states) transition(harness.store, state)
    harness.store.transition(entry.savedState, {
      capability: priorCapability, cause: `${entry.name} checkpoint persisted`, eventId: entry.eventId,
    })
    let abandonedPermit = null
    if (entry.name === 'post-worker') {
      const abandonedTarget = path.join(target, 'abandoned-worker.txt')
      fs.writeFileSync(abandonedTarget, 'pre-crash\n')
      abandonedPermit = harness.store.beginAuthorizedMutation({
        capability: priorCapability,
        expectedEpoch: 0,
        cause: 'bind the pre-crash worker mutation permit',
        authority: {
          runId: 'run-0001', activationId: 'activation-001',
          nonce: 'nonce_123456789012', generation: 1,
        },
        preimages: [{ path: abandonedTarget, hash: sha256(fs.readFileSync(abandonedTarget)) }],
      })
    }
    let monotonic = 100
    const wall = Date.parse('2026-08-22T02:00:00.000Z')
    const budget = new BudgetController({
      limits: { wallMs: 10000, tokens: 1000, sessions: 10, launches: 10 }, finalizationReserveMs: 100,
      phases: {}, monotonicMs: () => monotonic, wallNowMs: () => wall,
      wallClock: () => new Date(wall).toISOString(), bootId: `boot-${entry.name}`,
    })
    accounting = new AccountingAuthority({
      paths: {
        runRecordRoot: harness.directory,
        logPath: path.join(harness.directory, 'runtime', 'accounting.jsonl'),
        snapshotPath: path.join(harness.directory, 'runtime', 'budget.json'),
      },
      eventLog: harness.eventLog, stateProvider: () => harness.store.load(),
      capabilityVerifier: (candidate) => lock.verifyCapability(candidate), budgetController: budget,
      additionalCeilings: { retries: 5, costMicrounits: 100000 }, monotonicMs: () => monotonic,
      wallNowMs: () => wall, clock: () => new Date(wall).toISOString(), bootId: `boot-${entry.name}`,
    })
    accounting.checkpoint({
      capability: priorCapability,
      cause: { kind: 'CHECKPOINT', causeId: `crash:${entry.name}`, humanDescription: 'Persist exact pre-crash accounting.' },
      delta: accountingDelta({ launches: 1, sessions: 1, tokenUsage: { output: 3 } }),
    })
    const accountingEvidence = accounting.resumeCheckpoint()
    const scheduler = schedulerCheckpointFixture({
      route: entry.name === 'post-analyst' ? 'PENDING' : 'LIGHT',
      phase: entry.savedState,
      nextReadyWorkIds: entry.frontier.nextReadyWorkIds,
      openCheckIds: entry.frontier.openCheckIds,
      completedWorkIds: entry.completedMilestones.includes('work-preparation') ? ['work-1'] : [],
      completedCheckIds: entry.completedMilestones.includes('final-check') ? ['check-work-1'] : [],
      cursor: entry.name,
    })
    const checkpoint = prepareCrashCheckpoint({
      savedState: entry.savedState, resumeState: entry.resumeState,
      frontier: {
        ...entry.frontier,
        acceptedResultIds: [...new Set([...entry.frontier.acceptedResultIds, scheduler.stateHash])],
      },
      completedMilestones: entry.completedMilestones, externalRecovery: entry.externalRecovery,
      releaseIntentHash: null,
    })
    recoveryAuthority = new RecoveryCheckpointAuthority({
      paths: {
        runRecordRoot: harness.directory,
        logPath: path.join(harness.directory, 'runtime', 'recovery-checkpoints.jsonl'),
        snapshotPath: path.join(harness.directory, 'runtime', 'recovery-checkpoint.json'),
      },
      eventLog: harness.eventLog, stateProvider: () => harness.store.load(),
      capabilityVerifier: (candidate) => lock.verifyCapability(candidate),
      accountingCheckpointVerifier: (evidence) => accounting.verifyResumeCheckpoint(evidence),
      accountingCheckpointProvider: () => accounting.resumeCheckpoint(),
      clock: () => new Date(wall).toISOString(),
    })
    const externalOperations = entry.externalRecovery.status === 'reconciliation-required'
      ? [{
          operationId: entry.externalRecovery.operationIds[0], status: 'COMMITTED_UNRECONCILED',
          idempotencyKey: entry.externalRecovery.idempotencyKeys[0],
          prepareReceiptHash: digest(`prepare-${entry.name}`), commitReceiptHash: entry.externalRecovery.receiptHashes[0],
          reconcileReceiptHash: null, rollbackReceiptHash: null, nextAction: 'RECONCILE',
        }]
      : []
    const appendedCheckpoint = recoveryAuthority.appendCheckpoint({
      capability: priorCapability,
      providerCapabilitiesHash: digest(`provider-capabilities-${entry.name}`),
      accountingCheckpoint: accountingEvidence,
      scheduler,
      recovery: checkpoint,
      immutableHashes: {
        requestEnvelopeHash: harness.store.load().requestEnvelopeHash,
        routeDecisionHash: entry.name === 'post-analyst' ? null : digest(`route-${entry.name}`),
        planHash: entry.name === 'post-analyst' ? null : digest(`plan-${entry.name}`),
        candidateHash: null,
      },
      externalOperations,
      humanDescription: `Persist exact ${entry.name} scheduler frontier.`,
      cause: { kind: 'CHECKPOINT', causeId: `crash:${entry.name}`, humanDescription: `Persist ${entry.name} recovery checkpoint.` },
    })
    const recoveryEvidence = recoveryAuthority.resumeCheckpoint()
    assertDraft202012Valid(path.join(ROOT, 'agents', 'contracts', 'schemas', 'recovery-checkpoint-record.schema.json'), [appendedCheckpoint.record])
    assertDraft202012Valid(path.join(ROOT, 'agents', 'contracts', 'schemas', 'recovery-checkpoint-snapshot.schema.json'), [appendedCheckpoint.snapshot])
    const cumulativeBefore = accounting.replay().cumulative
    const runtimeBefore = harness.store.load()
    if (entry.name === 'post-analyst') {
      assert.throws(() => lock.acquire({
        ...leaseInput, pid: 202, processIdentity: 'replacement-live-owner', generation: 2, token: 'c'.repeat(48),
      }), (error) => error.code === 'WORKSPACE_LEASE_CONFLICT')
      ownerProbe = 'undrained'
      assert.throws(() => lock.acquire({
        ...leaseInput, pid: 202, processIdentity: 'replacement-undrained-owner', generation: 2, token: 'c'.repeat(48),
      }), (error) => error.code === 'WORKSPACE_LEASE_CONFLICT')
    }
    ownerProbe = 'stale'
    const nextCapability = lock.acquire({
      ...leaseInput, pid: 202, processIdentity: `replacement-root-${entry.name}`,
      generation: 2, token: 'b'.repeat(48),
    })
    TEST_CAPABILITIES.set(harness.store, nextCapability)
    if (entry.name === 'post-analyst') {
      fs.appendFileSync(recoveryAuthority.logPath, '{"takeover-tail":')
      assert.equal(recoveryAuthority.recoverCrashTail({
        capability: nextCapability,
        truncateIncompleteTail: true,
      }).recovered, true)
      assert.equal(recoveryAuthority.resumeCheckpoint().record.entryHash, recoveryEvidence.record.entryHash)
    }
    const adoptionInput = {
      capability: nextCapability, expectedGeneration: 1, expectedSavedState: entry.savedState,
      precondition: runtimeCrashPrecondition(runtimeBefore),
      recoveryCheckpoint: recoveryEvidence,
      expectedCheckpointPayloadHash: appendedCheckpoint.record.checkpointPayloadHash,
      cause: `verified crash adoption ${entry.name}`,
    }
    if (entry.name === 'post-analyst') {
      assert.throws(() => harness.store.adoptCrashedGeneration({
        ...adoptionInput,
        precondition: { ...adoptionInput.precondition, stateChecksum: digest('changed-state') },
      }), (error) => error.code === 'CRASH_PRECONDITION_MISMATCH')
      assert.throws(() => harness.store.adoptCrashedGeneration({
        ...adoptionInput,
        expectedCheckpointPayloadHash: digest('changed-frontier'),
      }), (error) => error.code === 'CRASH_CHECKPOINT_MISMATCH')
      assert.throws(() => harness.store.adoptCrashedGeneration({
        ...adoptionInput,
        recoveryCheckpoint: {
          ...recoveryEvidence,
          snapshot: { ...recoveryEvidence.snapshot, snapshotHash: digest('changed-checkpoint') },
        },
      }), (error) => error.code === 'CRASH_CHECKPOINT_MISMATCH')
      const actualBinding = lock.verifyCapability(nextCapability)
      const forgedCapability = Object.freeze({ forged: 'takeover-proof' })
      const forgedStore = new RuntimeStateStore({
        paths: harness.store.registeredPaths,
        eventLog: harness.eventLog,
        capabilityVerifier: (candidate) => candidate === forgedCapability
          ? { ...actualBinding, takeover: { ...actualBinding.takeover, receiptHash: digest('tampered-takeover') } }
          : lock.verifyCapability(candidate),
        recoveryCheckpointVerifier: (evidence) => recoveryAuthority.verifyResumeCheckpoint(evidence),
      })
      assert.throws(() => forgedStore.adoptCrashedGeneration({
        ...adoptionInput, capability: forgedCapability,
      }), (error) => error.code === 'CRASH_OWNER_UNVERIFIED')
      const crossRunCapability = Object.freeze({ forged: 'cross-run' })
      const crossRunStore = new RuntimeStateStore({
        paths: harness.store.registeredPaths,
        eventLog: harness.eventLog,
        capabilityVerifier: (candidate) => candidate === crossRunCapability
          ? { ...actualBinding, runId: 'foreign-run' }
          : lock.verifyCapability(candidate),
        recoveryCheckpointVerifier: (evidence) => recoveryAuthority.verifyResumeCheckpoint(evidence),
      })
      assert.throws(() => crossRunStore.adoptCrashedGeneration({
        ...adoptionInput, capability: crossRunCapability,
      }), (error) => error.code === 'LEASE_CAPABILITY_REQUIRED')
    }
    const adopted = harness.store.adoptCrashedGeneration({
      ...adoptionInput,
    })
    assert.equal(adopted.state, 'PAUSED')
    assert.equal(adopted.activation.generation, 2)
    assert.deepEqual(adopted.budgets, runtimeBefore.budgets)
    assert.deepEqual(adopted.resourceState.schedulerSessions, runtimeBefore.resourceState.schedulerSessions)
    assert.equal(adopted.frontier.savedState, entry.savedState)
    assert.equal(adopted.frontier.resumeState, entry.resumeState)
    assert.equal(adopted.frontier.accountingCheckpoint.snapshotHash, accountingEvidence.snapshotHash)
    assert.equal(adopted.frontier.priorOwner.processesDrained, true)
    if (entry.name === 'post-analyst') {
      assert.throws(() => harness.store.adoptCrashedGeneration(adoptionInput),
        (error) => error.code === 'CRASH_ADOPTION_CONFLICT')
      const replayedAdoption = harness.store.adoptCrashedGeneration({
        ...adoptionInput,
        expectedCheckpointHash: adopted.frontier.checkpointHash,
      })
      assert.equal(replayedAdoption.checksum, adopted.checksum)
    }
    const resumed = harness.store.resumeGeneration({
      capability: nextCapability, expectedGeneration: 2, cause: `resume adopted ${entry.name}`,
    })
    assert.equal(resumed.state, 'CHECK_PROVIDER_CAPABILITIES')
    assert.equal(resumed.activation.generation, 2, 'crash adoption increments generation exactly once')
    assert.equal(harness.store.acceptResumeCapabilities({
      capability: nextCapability, cause: `providers reverified ${entry.name}`,
    }).state, 'RESUME_EXACT_STATE')
    const restored = harness.store.restoreExactState({
      capability: nextCapability, cause: `restore exact ${entry.name}`,
    })
    assert.equal(restored.state, entry.resumeState)
    assert.equal(restored.frontier, null)
    if (abandonedPermit) {
      assert.equal(restored.activeMutation, null, 'the replacement generation revokes the dead owner permit')
      assert.equal(restored.workspaceEpoch, abandonedPermit.epoch, 'revocation never reopens the prior workspace epoch')
      assert.throws(
        () => harness.store.commitAuthorizedMutation(abandonedPermit, {
          capability: nextCapability, cause: 'stale owner attempts commit', postimages: [],
        }),
        error => error.code === 'MUTATION_PERMIT_INVALID',
      )
    }
    assert.deepEqual(restored.budgets, runtimeBefore.budgets)
    assert.deepEqual(restored.resourceState.schedulerSessions, runtimeBefore.resourceState.schedulerSessions)
    assert.deepEqual(accounting.replay().cumulative, cumulativeBefore, 'adoption does not reset or duplicate accounting')
    const resumedScheduler = schedulerCheckpointFixture({
      route: ['START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION'].includes(entry.resumeState) ? 'PENDING' : 'LIGHT',
      phase: entry.resumeState,
      nextReadyWorkIds: checkpoint.frontier.nextReadyWorkIds,
      openCheckIds: checkpoint.frontier.openCheckIds,
      completedWorkIds: entry.completedMilestones.includes('work-preparation') ? ['work-1'] : [],
      completedCheckIds: entry.completedMilestones.includes('final-check') ? ['check-work-1'] : [],
      cursor: `resumed-${entry.name}`,
    })
    const resumedRecovery = prepareCrashCheckpoint({
      savedState: entry.resumeState, resumeState: entry.resumeState,
      frontier: { ...checkpoint.frontier, acceptedResultIds: [resumedScheduler.stateHash] },
      completedMilestones: entry.completedMilestones,
      externalRecovery: entry.externalRecovery,
      releaseIntentHash: null,
    })
    const generationCheckpoint = recoveryAuthority.appendCheckpoint({
      capability: nextCapability,
      providerCapabilitiesHash: digest(`provider-capabilities-resumed-${entry.name}`),
      accountingCheckpoint: accountingEvidence,
      scheduler: resumedScheduler,
      recovery: resumedRecovery,
      immutableHashes: appendedCheckpoint.record.checkpoint.immutableHashes,
      externalOperations,
      humanDescription: `Bind the restored ${entry.name} scheduler to generation two.`,
      cause: { kind: 'CRASH_RECOVERY', causeId: `crash:restored:${entry.name}`, humanDescription: 'Bind the replacement capability after exact restore.' },
    })
    assert.equal(generationCheckpoint.record.authority.generation, 2)
    assert.equal(recoveryAuthority.resumeCheckpoint().record.entryHash, generationCheckpoint.record.entryHash)
    const recoveryEvents = harness.eventLog.readAll().slice(-4).map((event) => event.details.stateEvent)
    for (const stateEvent of recoveryEvents.filter((event) => ['T077', 'T078', 'T066'].includes(event.transitionId))) {
      assert.equal(validateCanonicalStateEvent(stateEvent), true)
      assertDraft202012Valid(path.join(ROOT, 'agents', 'contracts', 'schemas', 'state-event.schema.json'), [stateEvent])
    }
    assert.deepEqual(recoveryEvents.map((event) => event.transitionId), ['T077', 'T060', 'T078', 'T066'])
    lock.release(nextCapability)
    monotonic += 1
  }
})

test('crash adoption excludes release reconciliation and all terminal states', (t) => {
  const harness = stateHarness(t)
  advanceToWork(harness.store)
  transition(harness.store, 'RELEASING_LOCK', 'final budget cannot resume', 'BUDGET_EXHAUSTED_FINAL')
  assert.throws(() => harness.store.adoptCrashedGeneration({
    capability: harness.capability,
    expectedGeneration: 1,
    expectedSavedState: 'RELEASING_LOCK',
  }), (error) => error.code === 'RELEASE_RECONCILIATION_REQUIRED')
  harness.store.bindTerminal('PARTIAL', {
    capability: harness.capability,
    cause: 'release intent reconciled after crash',
    terminalEnvelope: { providerStatus: 'PARTIAL' },
    deliverables: [],
  })
  harness.store.completeReleasedTerminal('PARTIAL', {
    capability: harness.capability,
    cause: 'lease release proven',
  })
  assert.throws(() => harness.store.adoptCrashedGeneration({
    capability: harness.capability,
    expectedGeneration: 1,
    expectedSavedState: 'PARTIAL',
  }), (error) => error.code === 'CRASH_ADOPTION_FORBIDDEN')
})

test('release reconciliation adopts only the exact stale generation and finalizer retry stays deterministic', async (t) => {
  const directory = temporary(t)
  const target = path.join(directory, 'target')
  const runRoot = path.join(directory, 'run-record')
  fs.mkdirSync(target)
  let priorOwnerState = 'live'
  let leaseNumber = 0
  const lock = new MissionLock({
    leaseRoot: path.join(directory, 'leases'),
    processIdentityObserver: leaseProcessObserver((pid) =>
      pid === 401 && priorOwnerState === 'live' ? 'release-owner-generation-one' : null),
    identityProbe(owner) {
      if (priorOwnerState === 'live') return { alive: true, verified: true }
      if (priorOwnerState === 'undrained') {
        return {
          alive: false,
          verified: true,
          ownedIdentityEvidence: ownedIdentityEvidence(owner, new Set(['test-group\0release-group-1'])),
        }
      }
      return { alive: false, verified: true, ownedIdentityEvidence: ownedIdentityEvidence(owner) }
    },
    randomId: () => `release-lease-${++leaseNumber}`,
  })
  const leaseInput = {
    targetPath: target,
    ledgerPath: path.join(target, '.autoprompt'),
    runId: 'run-0001',
    activationId: 'activation-001',
    missionHash: digest('mission'),
    nonce: 'nonce_123456789012',
    generation: 1,
    pid: 401,
    processIdentity: 'release-owner-generation-one',
    token: 'a'.repeat(48),
  }
  const priorCapability = lock.acquire(leaseInput)
  lock.updateOwnedProcesses(priorCapability, [{ kind: 'test-group', id: 'release-group-1' }])
  const harness = stateHarness(t, {
    directory: runRoot,
    capability: priorCapability,
    binding: { ...binding(), targetIdentity: lock.verifyCapability(priorCapability).targetIdentity },
    capabilityVerifier: (candidate) => lock.verifyCapability(candidate),
  })
  advanceToWork(harness.store)
  transition(harness.store, 'RELEASING_LOCK', 'final budget cannot resume', 'BUDGET_EXHAUSTED_FINAL')
  const before = harness.store.load()
  const evidence = harness.store.prepareReleaseReconciliation()
  assert.equal(evidence.outcome, 'PARTIAL')
  assert.equal(evidence.transitionId, 'T059')
  assert.equal(evidence.stateEventHash, before.lastEventHash)
  assert.throws(() => lock.acquire({
    ...leaseInput, generation: 2, pid: 402, processIdentity: 'replacement-live', token: 'b'.repeat(48),
  }), (error) => error.code === 'WORKSPACE_LEASE_CONFLICT')
  priorOwnerState = 'undrained'
  assert.throws(() => lock.acquire({
    ...leaseInput, generation: 2, pid: 402, processIdentity: 'replacement-undrained', token: 'b'.repeat(48),
  }), (error) => error.code === 'WORKSPACE_LEASE_CONFLICT')
  priorOwnerState = 'stale'
  const replacementCapability = lock.acquire({
    ...leaseInput, generation: 2, pid: 402, processIdentity: 'release-owner-generation-two', token: 'b'.repeat(48),
  })
  TEST_CAPABILITIES.set(harness.store, replacementCapability)
  assert.throws(() => harness.store.adoptReleaseReconciliation({
    capability: replacementCapability,
    expectedGeneration: 1,
    evidence: { ...evidence, releaseIntentHash: digest('tampered-release-intent') },
  }), (error) => error.code === 'RELEASE_RECONCILIATION_MISMATCH')
  const forgedCapability = Object.freeze({ forged: 'release-cross-run' })
  const replacementBinding = lock.verifyCapability(replacementCapability)
  const crossRunStore = new RuntimeStateStore({
    paths: harness.store.registeredPaths,
    eventLog: harness.eventLog,
    capabilityVerifier: (candidate) => candidate === forgedCapability
      ? { ...replacementBinding, runId: 'foreign-run' }
      : lock.verifyCapability(candidate),
  })
  assert.throws(() => crossRunStore.adoptReleaseReconciliation({
    capability: forgedCapability, expectedGeneration: 1, evidence,
  }), (error) => error.code === 'LEASE_CAPABILITY_REQUIRED')
  const adopted = harness.store.adoptReleaseReconciliation({
    capability: replacementCapability,
    expectedGeneration: 1,
    evidence,
  })
  assert.equal(adopted.state, 'RELEASING_LOCK')
  assert.equal(adopted.activation.generation, 2)
  assert.equal(adopted.activation.status, 'RELEASING')
  for (const field of Object.keys(before).filter((field) => !['activation', 'checksum'].includes(field))) {
    assert.deepEqual(adopted[field], before[field], `release adoption changed ${field}`)
  }
  assert.throws(() => harness.store.adoptReleaseReconciliation({
    capability: replacementCapability, expectedGeneration: 1, evidence,
  }), (error) => error.code === 'GENERATION_CONFLICT')

  const processOwner = new ProcessOwner({
    adapter: new FakeProcessAdapter(),
    registryPath: path.join(runRoot, 'runtime', 'release-processes.json'),
    allowTestAdapter: true,
  })
  const scratchRoot = path.join(runRoot, 'scratch')
  fs.mkdirSync(scratchRoot)
  const cleanupRegistry = new CleanupRegistry({
    registryPath: path.join(runRoot, 'cleanup.json'),
    allowedRoots: [scratchRoot],
  })
  const finalizer = new Finalizer({
    stateStore: harness.store,
    processOwner,
    missionLock: lock,
    capability: replacementCapability,
    cleanupRegistry,
  })
  const finalOptions = {
    outcome: 'PARTIAL',
    reason: 'resume exact persisted release intent after owner death',
    expectedEpoch: 0,
    deliverables: [],
    terminalEnvelope: { providerStatus: 'PARTIAL' },
  }
  const finalized = await finalizer.finalize(finalOptions)
  assert.equal(finalized.state.state, 'PARTIAL')
  assert.equal(lock.assertReleased(replacementCapability), true)
  const retried = await finalizer.finalize(finalOptions)
  assert.equal(retried.state.checksum, finalized.state.checksum)
  assert.equal(retried.terminal.checksum, finalized.terminal.checksum)
})

test('release reconciliation accepts only a durable predecessor release after crash between lease release and terminal state', async (t) => {
  const directory = temporary(t)
  const target = path.join(directory, 'target')
  const runRoot = path.join(directory, 'run-record')
  fs.mkdirSync(target)
  let leaseNumber = 0
  let failReleaseRename = false
  const lockFs = Object.create(fs)
  lockFs.renameSync = (source, destination) => {
    if (failReleaseRename && source.endsWith('.lease') && destination.includes('.lease.released.')) {
      failReleaseRename = false
      throw Object.assign(new Error('injected crash after release receipt'), { code: 'EIO' })
    }
    return fs.renameSync(source, destination)
  }
  const lock = new MissionLock({
    leaseRoot: path.join(directory, 'leases'),
    fsImpl: lockFs,
    processIdentityObserver: leaseProcessObserver(),
    identityProbe: () => ({ alive: true, verified: true }),
    randomId: () => `released-predecessor-${++leaseNumber}`,
  })
  const leaseInput = {
    targetPath: target,
    ledgerPath: path.join(target, '.autoprompt'),
    runId: 'run-0001',
    activationId: 'activation-001',
    missionHash: digest('mission'),
    nonce: 'nonce_123456789012',
    generation: 1,
    pid: 501,
    processIdentity: 'release-predecessor-one',
    token: 'c'.repeat(48),
  }
  const priorCapability = lock.acquire(leaseInput)
  const harness = stateHarness(t, {
    directory: runRoot,
    capability: priorCapability,
    binding: { ...binding(), targetIdentity: lock.verifyCapability(priorCapability).targetIdentity },
    capabilityVerifier: (candidate) => lock.verifyCapability(candidate),
  })
  advanceToWork(harness.store)
  transition(harness.store, 'RELEASING_LOCK', 'final budget cannot resume', 'BUDGET_EXHAUSTED_FINAL')
  const processOwner = new ProcessOwner({
    adapter: new FakeProcessAdapter(),
    registryPath: path.join(runRoot, 'runtime', 'predecessor-processes.json'),
    allowTestAdapter: true,
  })
  const scratchRoot = path.join(runRoot, 'scratch')
  fs.mkdirSync(scratchRoot)
  const cleanupRegistry = new CleanupRegistry({
    registryPath: path.join(runRoot, 'cleanup.json'),
    allowedRoots: [scratchRoot],
  })
  const options = {
    outcome: 'PARTIAL',
    reason: 'release receipt survives terminal transition crash',
    expectedEpoch: 0,
    deliverables: [],
    terminalEnvelope: { providerStatus: 'PARTIAL' },
  }
  let failAfterRelease = true
  const firstFinalizer = new Finalizer({
    stateStore: harness.store,
    processOwner,
    missionLock: lock,
    capability: priorCapability,
    cleanupRegistry,
    beforeBoundary(boundary) {
      if (boundary === 'released-state' && failAfterRelease) throw new Error('injected crash after durable lease release')
    },
  })
  failReleaseRename = true
  await assert.rejects(firstFinalizer.finalize(options), /injected crash after release receipt/)
  const stillActive = lock.describe(priorCapability)
  assert.equal(stillActive.status, 'ACTIVE')
  assert.equal(fs.existsSync(path.join(stillActive.leasePath, 'release.json')), true)
  await assert.rejects(firstFinalizer.finalize(options), /injected crash after durable lease release/)
  assert.equal(lock.assertReleased(priorCapability), true)
  const pending = harness.store.load()
  assert.equal(pending.state, 'RELEASING_LOCK')
  const evidence = harness.store.prepareReleaseReconciliation()
  const replacementCapability = lock.acquire({
    ...leaseInput,
    generation: 2,
    pid: 502,
    processIdentity: 'release-predecessor-two',
    token: 'd'.repeat(48),
  })
  const replacementBinding = lock.verifyCapability(replacementCapability)
  assert.equal(replacementBinding.takeover, null)
  assert.equal(replacementBinding.predecessorRelease.releaseIntentHash, evidence.releaseIntentHash)
  assert.equal(replacementBinding.predecessorRelease.generation, 1)
  const forgedCapability = Object.freeze({ forged: 'released-predecessor' })
  const wrongIntentReceipt = {
    ...replacementBinding.predecessorRelease,
    releaseIntentHash: digest('wrong-release-intent'),
  }
  wrongIntentReceipt.receiptHash = predecessorReleaseHash(wrongIntentReceipt)
  const forgedStore = new RuntimeStateStore({
    paths: harness.store.registeredPaths,
    eventLog: harness.eventLog,
    capabilityVerifier: (candidate) => candidate === forgedCapability
      ? { ...replacementBinding, predecessorRelease: wrongIntentReceipt }
      : lock.verifyCapability(candidate),
  })
  assert.throws(() => forgedStore.adoptReleaseReconciliation({
    capability: forgedCapability,
    expectedGeneration: 1,
    evidence,
  }), (error) => error.code === 'CRASH_OWNER_UNVERIFIED')
  TEST_CAPABILITIES.set(harness.store, replacementCapability)
  const adopted = harness.store.adoptReleaseReconciliation({
    capability: replacementCapability,
    expectedGeneration: 1,
    evidence,
  })
  assert.equal(adopted.state, 'RELEASING_LOCK')
  assert.equal(adopted.activation.generation, 2)
  assert.throws(() => harness.store.adoptReleaseReconciliation({
    capability: replacementCapability,
    expectedGeneration: 1,
    evidence,
  }), (error) => error.code === 'GENERATION_CONFLICT')
  failAfterRelease = false
  const replacementFinalizer = new Finalizer({
    stateStore: harness.store,
    processOwner,
    missionLock: lock,
    capability: replacementCapability,
    cleanupRegistry,
  })
  const completed = await replacementFinalizer.finalize(options)
  assert.equal(completed.state.state, 'PARTIAL')
  assert.equal(lock.assertReleased(replacementCapability), true)
  const retry = await replacementFinalizer.finalize(options)
  assert.equal(retry.state.checksum, completed.state.checksum)
})

class FakeProcessAdapter {
  constructor() {
    this.kind = 'test'
    this.capabilities = {
      groupAtCreation: true,
      descendantEnumeration: true,
      groupSignal: true,
      stableIdentity: true,
      persistentIdentity: true,
      reservationRecovery: true,
    }
    this.groups = new Map()
    this.reservations = new Map()
    this.launches = []
    this.signals = []
    this.nextPid = 500
  }

  async admit() { return { supported: true } }

  async spawnOwned(spec) {
    this.launches.push(spec)
    const rootPid = this.nextPid++
    const groupIdentity = `group-${rootPid}`
    this.groups.set(groupIdentity, [rootPid, rootPid + 1000, rootPid + 2000])
    this.reservations.set(spec.reservationId, { rootPid, groupIdentity })
    return { rootPid, groupIdentity }
  }

  async recoverReservation(reservationId) {
    const owned = this.reservations.get(reservationId)
    return owned && (this.groups.get(owned.groupIdentity) || []).length ? { ...owned } : null
  }

  async listOwned(groupIdentity) {
    return [...(this.groups.get(groupIdentity) || [])]
  }

  async signalOwned(groupIdentity, signal) {
    this.signals.push([groupIdentity, signal])
    const members = this.groups.get(groupIdentity) || []
    this.groups.set(groupIdentity, signal === 'TERM' ? members.slice(-1) : [])
  }

  async verifyOwnership() { return true }

  async listTargetOwned() {
    return [...this.groups.values()].flat()
  }
}

test('process owner round-trips argv and drains descendants with bounded TERM/KILL', async (t) => {
  const adapter = new FakeProcessAdapter()
  const directory = temporary(t)
  let monotonic = 0
  const owner = new ProcessOwner({
    adapter,
    registryPath: path.join(directory, 'processes.json'),
    allowTestAdapter: true,
    monotonicMs: () => monotonic,
    wait: async (milliseconds) => { monotonic += milliseconds || 1 },
    pollMs: 1,
    randomId: () => 'ownership-one',
  })
  const argv = ['with spaces', '', 'a"quote', 'trailing\\', 'Grüße', '--leading']
  const launched = await owner.launch({ executable: 'C:\\Program Files\\fake.exe', argv, targetKey: 'target-key' })
  assert.deepEqual(adapter.launches[0].argv, argv)
  assert.equal(adapter.launches[0].shell, false)
  await assert.rejects(
    owner.verifyDrainedIdentities([{ kind: adapter.kind, id: launched.groupIdentity }]),
    (error) => error.code === 'PROCESS_DRAIN_TIMEOUT',
  )
  const terminal = await owner.cancelGroup(launched.ownershipId, { graceMs: 2, killMs: 2, reason: 'test stop' })
  assert.equal(terminal.status, 'CANCELLED')
  assert.deepEqual(adapter.signals.map((entry) => entry[1]), ['TERM', 'KILL'])
  const drainEvidence = await owner.verifyDrainedIdentities([{ kind: adapter.kind, id: launched.groupIdentity }])
  assert.deepEqual(drainEvidence.map(({ kind, id, verified, alive }) => ({ kind, id, verified, alive })), [{
    kind: adapter.kind, id: launched.groupIdentity, verified: true, alive: false,
  }])
  await owner.assertDrained()
  await owner.assertTargetDrained('target-key')
})

test('process owner finalizes conclusively drained groups but rejects live identity reuse', async t => {
  const directory = temporary(t)
  const drainedAdapter = new FakeProcessAdapter()
  let drainedIdentityChecks = 0
  drainedAdapter.verifyOwnership = async () => { drainedIdentityChecks += 1; return false }
  const drainedOwner = new ProcessOwner({
    adapter: drainedAdapter,
    registryPath: path.join(directory, 'drained-processes.json'),
    allowTestAdapter: true,
    pollMs: 1,
    zeroConfirmations: 2,
  })
  const drained = await drainedOwner.launch({ executable: 'fake', argv: [], targetKey: 'drained' })
  drainedAdapter.groups.set(drained.groupIdentity, [])
  const terminal = await drainedOwner.cancelGroup(drained.ownershipId, {
    graceMs: 0, killMs: 1, reason: 'already exited',
  })
  assert.equal(terminal.status, 'CANCELLED')
  assert.equal(drainedIdentityChecks, 0,
    'a durably empty group does not require a live process identity')
  drainedAdapter.groups.set(drained.groupIdentity, [drained.rootPid])
  await assert.rejects(drainedOwner.assertDrained(),
    error => error.code === 'PROCESS_IDENTITY_CHANGED')
  assert.deepEqual(drainedAdapter.signals, [],
    'a late PID under a terminal identity must not be signalled before identity verification')

  const residueAdapter = new FakeProcessAdapter()
  const residueOwner = new ProcessOwner({
    adapter: residueAdapter,
    registryPath: path.join(directory, 'terminal-residue-processes.json'),
    allowTestAdapter: true,
    pollMs: 1,
    zeroConfirmations: 2,
  })
  const residue = await residueOwner.launch({ executable: 'fake', argv: [], targetKey: 'residue' })
  residueAdapter.groups.set(residue.groupIdentity, [])
  await residueOwner.cancelGroup(residue.ownershipId, {
    graceMs: 0, killMs: 1, reason: 'terminal before residue',
  })
  residueAdapter.groups.set(residue.groupIdentity, [residue.rootPid])
  await residueOwner.assertDrained()
  assert.deepEqual(residueAdapter.signals, [[residue.groupIdentity, 'KILL']])

  const reusedAdapter = new FakeProcessAdapter()
  let reusedIdentityChecks = 0
  reusedAdapter.verifyOwnership = async () => { reusedIdentityChecks += 1; return false }
  const reusedOwner = new ProcessOwner({
    adapter: reusedAdapter,
    registryPath: path.join(directory, 'reused-processes.json'),
    allowTestAdapter: true,
    pollMs: 1,
  })
  const reused = await reusedOwner.launch({ executable: 'fake', argv: [], targetKey: 'reused' })
  reusedAdapter.groups.set(reused.groupIdentity, [reused.rootPid])
  await assert.rejects(reusedOwner.cancelGroup(reused.ownershipId, {
    graceMs: 0, killMs: 1, reason: 'must reject reused identity',
  }), error => error.code === 'PROCESS_IDENTITY_CHANGED')
  assert.equal(reusedIdentityChecks, 1)
  assert.deepEqual(reusedAdapter.signals, [])
  assert.equal(reusedOwner.listRecords()[0].status, 'RUNNING')
})

test('AP-RUN-032 process and cleanup registries bind activation generation and monotonic sequence', async (t) => {
  const directory = temporary(t)
  const binding = { activationId: 'activation-run-032', generationId: 7 }
  const processPath = path.join(directory, 'processes.json')
  const adapter = new FakeProcessAdapter()
  const owner = new ProcessOwner({
    adapter,
    registryPath: processPath,
    allowTestAdapter: true,
    controlBinding: binding,
  })
  const launched = await owner.launch({
    executable: 'fake', argv: ['--bound'], targetKey: 'target-run-032',
    reservationId: 'reservation-run-032', sessionId: 'session-run-032',
  })
  const firstProcessRegistry = readChecksummedJson(processPath)
  assert.equal(firstProcessRegistry.activationId, binding.activationId)
  assert.equal(firstProcessRegistry.generationId, binding.generationId)
  assert.equal(firstProcessRegistry.sequence, 2, 'reserve and attach are distinct monotonic commits')
  await owner.cancelGroup(launched.ownershipId, { graceMs: 0, killMs: 0, reason: 'focused cleanup' })
  const terminalProcessRegistry = readChecksummedJson(processPath)
  assert.ok(terminalProcessRegistry.sequence > firstProcessRegistry.sequence)
  assert.throws(() => new ProcessOwner({
    adapter: new FakeProcessAdapter(), registryPath: processPath, allowTestAdapter: true,
    controlBinding: { activationId: binding.activationId, generationId: binding.generationId + 1 },
  }), (error) => error.code === 'PROCESS_CONTROL_BINDING_MISMATCH')

  const scratchRoot = path.join(directory, 'scratch')
  const scratchOne = path.join(scratchRoot, 'one')
  const scratchTwo = path.join(scratchRoot, 'two')
  fs.mkdirSync(scratchOne, { recursive: true })
  fs.mkdirSync(scratchTwo)
  const cleanupPath = path.join(directory, 'cleanup.json')
  const cleanup = new CleanupRegistry({ registryPath: cleanupPath, allowedRoots: [scratchRoot], controlBinding: binding })
  cleanup.register({ path: scratchOne, owner: 'worker-one' })
  const firstCleanupRegistry = readChecksummedJson(cleanupPath)
  assert.deepEqual(
    { activationId: firstCleanupRegistry.activationId, generationId: firstCleanupRegistry.generationId },
    binding,
  )
  assert.equal(firstCleanupRegistry.sequence, 1)
  cleanup.register({ path: scratchTwo, owner: 'worker-two' })
  assert.equal(readChecksummedJson(cleanupPath).sequence, 2)
  cleanup.run()
  assert.equal(readChecksummedJson(cleanupPath).sequence, 4,
    'each cleanup transition advances the durable sequence within one loaded registry')
  assert.throws(() => new CleanupRegistry({
    registryPath: cleanupPath,
    allowedRoots: [scratchRoot],
    controlBinding: { activationId: 'foreign-activation', generationId: binding.generationId },
  }).load(), (error) => error.code === 'CLEANUP_CONTROL_BINDING_MISMATCH')
})

test('normal root exit still drains late descendants and keeps the typed terminal envelope', async (t) => {
  const adapter = new FakeProcessAdapter()
  const directory = temporary(t)
  let monotonic = 0
  const owner = new ProcessOwner({
    adapter,
    registryPath: path.join(directory, 'processes.json'),
    allowTestAdapter: true,
    monotonicMs: () => monotonic,
    wait: async (milliseconds) => { monotonic += milliseconds || 1 },
    pollMs: 1,
    randomId: () => 'ownership-two',
  })
  const launched = await owner.launch({ executable: 'fake', argv: [], targetKey: 'target-key' })
  const terminal = await owner.observeRootExit(launched.ownershipId, {
    code: 0,
    killMs: 2,
    terminalEnvelope: { status: 'DONE', evidenceHashes: [digest('work')] },
  })
  assert.equal(terminal.status, 'DONE')
  assert.deepEqual(await adapter.listOwned(launched.groupIdentity), [])
})

test('POSIX launch uses only the pre-attested exact environment and resolves no executable through PATH', async (t) => {
  const directory = temporary(t)
  let spawned = null
  const adapter = createPosixProcessAdapter({
    platform: 'linux',
    execFileSync: () => '',
    spawn(executable, argv, options) {
      spawned = { executable, argv, options }
      return { pid: 8123 }
    },
  })
  const owner = new ProcessOwner({
    adapter,
    registryPath: path.join(directory, 'processes.json'),
    randomId: () => 'posix-owned-id',
  })
  const poisoned = {
    PATH: 'poison-path', GH_TOKEN: 'poison-gh', GITHUB_TOKEN: 'poison-github',
    GIT_CONFIG_GLOBAL: 'poison-git-config', AUTOPROMPT_PRIVATE_SECRET: 'poison-secret',
  }
  const saved = Object.fromEntries(Object.keys(poisoned).map((key) => [key, process.env[key]]))
  Object.assign(process.env, poisoned)
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const reservationId = 'pre-attested-posix-reservation'
  const exactEnvironment = prepareProcessLaunchEnvironment(adapter, reservationId, {
    SAFE_FIELD: 'only-exact-value',
  })
  await assert.rejects(owner.launch({
    reservationId,
    executable: process.execPath,
    argv: ['--version'],
    env: { SAFE_FIELD: 'missing-control-marker' },
    targetKey: 'target-key',
  }), (error) => error.code === 'PROCESS_ENVIRONMENT_UNATTESTED')
  assert.equal(spawned, null)
  const launched = await owner.launch({
    reservationId,
    executable: process.execPath,
    argv: ['--version'],
    env: exactEnvironment,
    targetKey: 'target-key',
  })
  assert.equal(launched.reservationId, undefined, 'public launch result does not expose recovery internals')
  assert.equal(spawned.executable, process.execPath)
  assert.deepEqual(spawned.options.env, exactEnvironment)
  for (const key of Object.keys(poisoned)) assert.equal(Object.hasOwn(spawned.options.env, key), false)
  await assert.rejects(owner.launch({
    reservationId: 'relative-executable-reservation',
    executable: 'node', argv: [],
    env: prepareProcessLaunchEnvironment(adapter, 'relative-executable-reservation', {}),
    targetKey: 'target-key',
  }), (error) => error.code === 'LAUNCH_SPEC_INVALID')
})

test('late descendants cannot race drain confirmation and terminal null reservations are not enumerated', async (t) => {
  const directory = temporary(t)
  const adapter = new FakeProcessAdapter()
  let probes = 0
  const originalList = adapter.listOwned.bind(adapter)
  adapter.listOwned = async (identity) => {
    assert.notEqual(identity, null, 'terminal pre-identity reservations must never be enumerated')
    probes += 1
    if (probes === 1) return []
    if (probes === 2) {
      adapter.groups.set(identity, [202])
      return [202]
    }
    return originalList(identity)
  }
  let monotonic = 0
  const owner = new ProcessOwner({
    adapter,
    registryPath: path.join(directory, 'late.json'),
    allowTestAdapter: true,
    monotonicMs: () => monotonic,
    wait: async (milliseconds) => { monotonic += milliseconds || 1 },
    pollMs: 1,
    zeroConfirmations: 2,
    randomId: () => 'late-descendant',
  })
  const launched = await owner.launch({ executable: 'fake', argv: [], targetKey: 'target-key' })
  adapter.groups.set(launched.groupIdentity, [])
  const terminal = await owner.observeRootExit(launched.ownershipId, { code: 0, killMs: 2 })
  assert.equal(terminal.status, 'DONE')
  assert.ok(adapter.signals.some(([, signal]) => signal === 'KILL'))

  const noIdentityAdapter = new FakeProcessAdapter()
  noIdentityAdapter.spawnOwned = async () => { throw new Error('pre-identity failure') }
  noIdentityAdapter.listOwned = async (identity) => {
    assert.notEqual(identity, null)
    return []
  }
  const failedOwner = new ProcessOwner({
    adapter: noIdentityAdapter,
    registryPath: path.join(directory, 'failed.json'),
    allowTestAdapter: true,
    randomId: () => 'pre-identity-failure',
  })
  await assert.rejects(failedOwner.launch({ executable: 'fake', argv: [], targetKey: 'target-key' }), /pre-identity failure/)
  assert.equal(failedOwner.listRecords()[0].status, 'FAILED')
  assert.equal(await failedOwner.assertDrained(), true)
})

test('durable process ownership reloads after supervisor restart and unsupported adapters refuse before spawn', async (t) => {
  const directory = temporary(t)
  const registryPath = path.join(directory, 'processes.json')
  const adapter = new FakeProcessAdapter()
  const first = new ProcessOwner({
    adapter,
    registryPath,
    allowTestAdapter: true,
    randomId: () => 'persisted-ownership',
  })
  await first.launch({ executable: 'fake', argv: [], targetKey: 'target-key' })
  const restarted = new ProcessOwner({ adapter, registryPath, allowTestAdapter: true })
  assert.equal(restarted.listRecords()[0].groupIdentity, 'group-500')
  await restarted.cancelAll({ graceMs: 0, killMs: 10 })
  assert.deepEqual(await adapter.listOwned('group-500'), [])

  const refusing = new FakeProcessAdapter()
  refusing.admit = async () => ({ supported: false, reason: 'job objects unavailable' })
  const unsupported = new ProcessOwner({
    adapter: refusing,
    registryPath: path.join(directory, 'unsupported.json'),
    allowTestAdapter: true,
  })
  await assert.rejects(
    unsupported.launch({ executable: 'fake', argv: [], targetKey: 'target-key' }),
    (error) => error.code === 'PROVIDER_UNSUPPORTED',
  )
  assert.equal(refusing.launches.length, 0)
  const contract = getProcessAdapterContract()
  assert.deepEqual(contract.methods, [...REQUIRED_PROCESS_ADAPTER_METHODS])
  assert.ok(contract.methods.includes('recoverReservation'))
})

test('spawn is never exposed before durable attach and failed cleanup retains a recoverable reservation', async (t) => {
  const directory = temporary(t)
  const registryPath = path.join(directory, 'processes.json')
  const adapter = new FakeProcessAdapter()
  const originalSignal = adapter.signalOwned.bind(adapter)
  adapter.signalOwned = async () => { throw new Error('injected termination failure') }
  const owner = new ProcessOwner({
    adapter,
    registryPath,
    allowTestAdapter: true,
    randomId: () => 'reserved-before-spawn',
    beforeRegistryCommit({ phase }) {
      if (phase === 'attach') {
        const error = new Error('injected registry EIO')
        error.code = 'EIO'
        throw error
      }
    },
  })
  await assert.rejects(
    owner.launch({ executable: 'fake', argv: [], targetKey: 'target-key' }),
    (error) => error.code === 'OWNERSHIP_COMMIT_FATAL' &&
      error.details.registryCause.includes('EIO') && error.details.terminationCause.includes('termination failure'),
  )
  const reserved = readChecksummedJson(registryPath)
  assert.equal(reserved.records[0].status, 'RESERVED')
  assert.equal(reserved.records[0].groupIdentity, null)
  assert.deepEqual(owner.ownershipIdentities(), [{ kind: 'test-reservation', id: 'reserved-before-spawn' }])

  adapter.signalOwned = originalSignal
  const restarted = new ProcessOwner({ adapter, registryPath, allowTestAdapter: true })
  await restarted.cancelAll({ graceMs: 0, killMs: 10 })
  assert.equal(restarted.listRecords()[0].status, 'CANCELLED')
  assert.deepEqual(await adapter.listOwned('group-500'), [])
})

test('reservation recovery keeps pending startup nonterminal until live attachment or a conclusive result', async (t) => {
  const directory = temporary(t)
  const registryPath = path.join(directory, 'pending-reservation.json')
  const adapter = new FakeProcessAdapter()
  adapter.signalOwned = async () => { throw new Error('injected cleanup failure keeps the spawned group recoverable') }
  const first = new ProcessOwner({
    adapter,
    registryPath,
    allowTestAdapter: true,
    startupTimeoutMs: 20,
    randomId: () => 'pending-startup',
    beforeRegistryCommit({ phase }) {
      if (phase === 'attach') throw Object.assign(new Error('injected attach persistence failure'), { code: 'EIO' })
    },
  })
  await assert.rejects(
    first.launch({ executable: 'fake', argv: [], targetKey: 'target-key' }),
    (error) => error.code === 'OWNERSHIP_COMMIT_FATAL',
  )
  assert.equal(first.listRecords()[0].status, 'RESERVED')

  let probes = 0
  let monotonic = 0
  let wall = Date.parse(first.listRecords()[0].startedAt)
  adapter.probeReservation = async (record) => {
    probes += 1
    if (probes === 1) return { state: 'PENDING', evidence: { startupDeadlineAt: record.startupDeadlineAt } }
    return { state: 'LIVE', ownership: { rootPid: 500, groupIdentity: 'group-500' } }
  }
  const restarted = new ProcessOwner({
    adapter,
    registryPath,
    allowTestAdapter: true,
    startupTimeoutMs: 20,
    monotonicMs: () => monotonic,
    wallClock: () => new Date(wall).toISOString(),
    wait: async (milliseconds) => { monotonic += milliseconds; wall += milliseconds },
    pollMs: 1,
  })
  await restarted.recoverReservations()
  assert.equal(restarted.listRecords()[0].status, 'RUNNING')
  assert.ok(probes >= 2)

  const blockedRegistry = path.join(directory, 'blocked-reservation.json')
  const blockedAdapter = new FakeProcessAdapter()
  blockedAdapter.signalOwned = async () => { throw new Error('keep pending') }
  const blockedFirst = new ProcessOwner({
    adapter: blockedAdapter,
    registryPath: blockedRegistry,
    allowTestAdapter: true,
    startupTimeoutMs: 2,
    randomId: () => 'blocked-startup',
    beforeRegistryCommit({ phase }) { if (phase === 'attach') throw new Error('block attach') },
  })
  await assert.rejects(blockedFirst.launch({ executable: 'fake', argv: [], targetKey: 'target-key' }))
  let blockedMonotonic = 0
  let blockedWall = Date.parse(blockedFirst.listRecords()[0].startedAt)
  blockedAdapter.probeReservation = async () => ({ state: 'PENDING', evidence: { helperAlive: true } })
  const blockedRestart = new ProcessOwner({
    adapter: blockedAdapter,
    registryPath: blockedRegistry,
    allowTestAdapter: true,
    startupTimeoutMs: 2,
    monotonicMs: () => blockedMonotonic,
    wallClock: () => new Date(blockedWall).toISOString(),
    wait: async (milliseconds) => { blockedMonotonic += milliseconds; blockedWall += milliseconds },
    pollMs: 1,
  })
  await assert.rejects(
    blockedRestart.assertTargetDrained('target-key'),
    (error) => error.code === 'OWNERSHIP_RECOVERY_PENDING',
  )
  assert.equal(blockedRestart.listRecords()[0].status, 'RESERVED')
})

test('terminal process records mutate memory only after durable registry commit', async (t) => {
  const directory = temporary(t)
  const registryPath = path.join(directory, 'processes.json')
  const adapter = new FakeProcessAdapter()
  let failTerminal = true
  const owner = new ProcessOwner({
    adapter,
    registryPath,
    allowTestAdapter: true,
    randomId: () => 'terminal-transaction',
    beforeRegistryCommit({ phase }) {
      if (phase === 'terminal' && failTerminal) throw new Error('injected terminal registry failure')
    },
  })
  const launched = await owner.launch({ executable: 'fake', argv: [], targetKey: 'target-key' })
  await assert.rejects(
    owner.cancelGroup(launched.ownershipId, { graceMs: 0, killMs: 10 }),
    /injected terminal registry failure/,
  )
  assert.equal(owner.listRecords()[0].status, 'RUNNING')
  assert.equal(readChecksummedJson(registryPath).records[0].status, 'RUNNING')

  failTerminal = false
  const terminal = await owner.cancelGroup(launched.ownershipId, { graceMs: 0, killMs: 10 })
  assert.equal(terminal.status, 'CANCELLED')
  assert.equal(readChecksummedJson(registryPath).records[0].status, 'CANCELLED')
  const reopened = new ProcessOwner({ adapter, registryPath, allowTestAdapter: true })
  assert.equal(reopened.listRecords()[0].status, 'CANCELLED')
})

test('Windows Job adapter assigns before resume and drains a real child plus grandchild', {
  skip: process.platform !== 'win32',
  timeout: 90000,
}, async (t) => {
  const directory = temporary(t)
  const providerPrivateOwnershipRoot = path.join(directory, 'provider-private-ownership')
  fs.mkdirSync(providerPrivateOwnershipRoot)
  ensureWindowsPrivateAcl(providerPrivateOwnershipRoot)
  const controlRoot = path.join(providerPrivateOwnershipRoot, 'job-control')
  const childScript = path.join(directory, 'child.cjs')
  const grandchildScript = path.join(directory, 'grandchild.cjs')
  const rootMarker = path.join(directory, 'root.json')
  const grandchildMarker = path.join(directory, 'grandchild.json')
  const registryPath = path.join(directory, 'processes.json')
  fs.writeFileSync(grandchildScript, [
    "'use strict'",
    "const fs = require('node:fs')",
    "fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }))",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  fs.writeFileSync(childScript, [
    "'use strict'",
    "const childProcess = require('node:child_process')",
    "const fs = require('node:fs')",
    'const [grandchildScript, rootMarker, grandchildMarker, ...received] = process.argv.slice(2)',
    'const child = childProcess.spawn(process.execPath, [grandchildScript, grandchildMarker], {',
    "  stdio: 'ignore', windowsHide: true,",
    '})',
    'fs.writeFileSync(rootMarker, JSON.stringify({ pid: process.pid, grandchildPid: child.pid, received, environment: process.env }))',
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))

  const adapter = createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot })
  const owner = new ProcessOwner({
    adapter,
    registryPath,
    randomId: () => 'windows-real-job',
    pollMs: 25,
  })
  const exactArguments = ['with spaces', '', 'quote"arg', 'trailing\\', 'Gr\u00fc\u00dfe']
  const exactEnvironment = {
    AUTOPROMPT_EXACT_ENV: 'Gr\u00fc\u00dfe',
    SystemRoot: process.env.SystemRoot,
  }
  let launched
  t.after(async () => {
    if (!launched) return
    try { await adapter.signalOwned(launched.groupIdentity, 'KILL') } catch {}
  })
  launched = await owner.launch({
    executable: process.execPath,
    argv: [childScript, grandchildScript, rootMarker, grandchildMarker, ...exactArguments],
    env: exactEnvironment,
    targetKey: 'windows-target',
  })
  await waitFor(() => fs.existsSync(rootMarker) && fs.existsSync(grandchildMarker), 10000)
  const root = JSON.parse(fs.readFileSync(rootMarker, 'utf8'))
  const grandchild = JSON.parse(fs.readFileSync(grandchildMarker, 'utf8'))
  assert.deepEqual(root.received, exactArguments)
  assert.deepEqual(root.environment, exactEnvironment)
  assert.equal(root.pid, launched.rootPid)
  assert.equal(root.grandchildPid, grandchild.pid)
  await waitFor(() => adapter.listOwned(launched.groupIdentity).then((pids) => pids.length >= 2), 10000)
  assert.match(launched.groupIdentity, /^windows-job:v2:/)
  const differentControlRoot = path.join(providerPrivateOwnershipRoot, 'different-process-control')
  const isolatedAdapter = createWindowsJobAdapter({ controlRoot: differentControlRoot })
  await assert.rejects(
    isolatedAdapter.listOwned(launched.groupIdentity),
    (error) => error.code === 'PROCESS_IDENTITY_INVALID',
  )
  const tamperedOriginIdentity = launched.groupIdentity.replace(
    /^windows-job:v2:([a-f0-9]{64}):[a-f0-9]{64}:/,
    'windows-job:v2:$1:' + '0'.repeat(64) + ':',
  )
  await assert.rejects(
    adapter.listOwned(tamperedOriginIdentity),
    (error) => error.code === 'PROCESS_IDENTITY_INVALID',
  )
  const crossRootVerifier = new ProcessOwner({
    adapter: createWindowsJobAdapter({
      controlRoot: differentControlRoot,
      providerPrivateOwnershipRoot,
    }),
    registryPath: path.join(directory, 'different-process-registry.json'),
  })
  assert.equal((await crossRootVerifier.verifyOwnedIdentity({
    kind: adapter.kind, id: launched.groupIdentity,
  })).alive, true)
  await assert.rejects(
    crossRootVerifier.verifyDrainedIdentities([{ kind: adapter.kind, id: launched.groupIdentity }]),
    (error) => error.code === 'PROCESS_DRAIN_TIMEOUT',
  )

  const restarted = new ProcessOwner({
    adapter: createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot }),
    registryPath,
    pollMs: 25,
  })
  const terminal = await restarted.cancelGroup(launched.ownershipId, {
    graceMs: 2000,
    killMs: 5000,
    reason: 'Windows real job test',
  })
  assert.equal(terminal.status, 'CANCELLED')
  assert.deepEqual(await adapter.listOwned(launched.groupIdentity), [])
  const crossRootEvidence = await crossRootVerifier.verifyDrainedIdentities([{
    kind: adapter.kind,
    id: launched.groupIdentity,
  }])
  assert.equal(crossRootEvidence[0].alive, false)
  assert.equal((await crossRootVerifier.verifyOwnedIdentity({
    kind: adapter.kind, id: launched.groupIdentity,
  })).alive, false)
  assert.throws(() => process.kill(root.pid, 0))
  assert.throws(() => process.kill(grandchild.pid, 0))

  const delayedControlRoot = path.join(providerPrivateOwnershipRoot, 'delayed-job-control')
  const delayedAdapter = createWindowsJobAdapter({
    controlRoot: delayedControlRoot,
    providerPrivateOwnershipRoot,
    startupDelayMilliseconds: 750,
  })
  const delayedReservationId = 'delayed-reservation-publication'
  const delayedStartedAt = new Date().toISOString()
  const delayedDeadline = new Date(Date.now() + delayedAdapter.startupTimeoutMs).toISOString()
  const delayedReservationIdentity = delayedAdapter.reservationIdentity(delayedReservationId)
  const delayedRecord = {
    reservationId: delayedReservationId,
    reservationIdentity: delayedReservationIdentity,
    startupDeadlineAt: delayedDeadline,
    targetKey: 'delayed-windows-target',
  }
  delayedRecord.reservationBinding = delayedAdapter.prepareReservation(delayedRecord)
  const delayedSpawn = delayedAdapter.spawnOwned({
    ownershipId: 'delayed-windows-ownership',
    reservationId: delayedReservationId,
    reservationIdentity: delayedReservationIdentity,
    reservationBinding: delayedRecord.reservationBinding,
    startupDeadlineAt: delayedDeadline,
    targetKey: delayedRecord.targetKey,
    executable: process.execPath,
    argv: ['-e', 'setTimeout(() => {}, 30000)'],
    cwd: directory,
    env: { SystemRoot: process.env.SystemRoot },
    shell: false,
  })
  await waitFor(() => fs.existsSync(path.join(delayedControlRoot, digest(delayedReservationId), 'launcher.json')), 10000)
  const pendingProbe = await delayedAdapter.probeReservation(delayedRecord)
  assert.ok(['PENDING', 'LIVE'].includes(pendingProbe.state), `startup probe must never report drained: ${pendingProbe.state}`)
  const delayedCrossRoot = path.join(providerPrivateOwnershipRoot, 'delayed-cross-root')
  const delayedIdentityVerifier = new ProcessOwner({
    adapter: createWindowsJobAdapter({
      controlRoot: delayedCrossRoot,
      providerPrivateOwnershipRoot,
    }),
    registryPath: path.join(directory, 'delayed-cross-registry.json'),
  })
  try {
    const evidence = await delayedIdentityVerifier.probeOwnedIdentities([{
      kind: 'windows-job-object-reservation', id: delayedReservationIdentity,
    }])
    assert.equal(evidence[0].alive, true,
      `a startup that became ready during the probe must remain live, never drained: ${JSON.stringify({ pendingProbe, evidence })}`)
  } catch (error) {
    if (error.code !== 'OWNERSHIP_RECOVERY_PENDING') throw error
  }
  let delayedHandle
  try {
    delayedHandle = await delayedSpawn
    const liveProbe = await delayedAdapter.probeReservation(delayedRecord)
    assert.equal(liveProbe.state, 'LIVE')
    assert.equal(liveProbe.ownership.groupIdentity, delayedHandle.groupIdentity)
    assert.equal((await delayedIdentityVerifier.probeOwnedIdentities([{
      kind: 'windows-job-object-reservation', id: delayedReservationIdentity,
    }]))[0].alive, true)
  } finally {
    delayedHandle ||= await delayedSpawn
    await delayedAdapter.signalOwned(delayedHandle.groupIdentity, 'KILL')
    await waitFor(() => delayedAdapter.listOwned(delayedHandle.groupIdentity).then((pids) => pids.length === 0), 10000)
  }
  await waitFor(async () => (await delayedAdapter.probeReservation(delayedRecord)).state === 'DEAD', 10000)
  assert.equal((await delayedIdentityVerifier.probeOwnedIdentities([{
    kind: 'windows-job-object-reservation', id: delayedReservationIdentity,
  }]))[0].alive, false)
})

test('Windows Job adapter repeatedly drains terminal-then-live resumed children across control roots', {
  skip: process.platform !== 'win32',
  timeout: 120000,
}, async (t) => {
  const directory = temporary(t)
  const providerPrivateOwnershipRoot = path.join(directory, 'provider-private-ownership')
  fs.mkdirSync(providerPrivateOwnershipRoot)
  ensureWindowsPrivateAcl(providerPrivateOwnershipRoot)
  const childScript = path.join(directory, 'terminal-then-live.cjs')
  fs.writeFileSync(childScript, [
    "'use strict'",
    "process.stdin.resume()",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'44444444-4444-4444-8444-444444444444'})+'\\n')",
    "  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'terminal'}})+'\\n')",
    "  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_tokens:0}})+'\\n')",
    '  setInterval(() => {}, 1000)',
    '})',
    '',
  ].join('\n'))

  const priorIdentities = []
  const registryPath = path.join(providerPrivateOwnershipRoot, 'processes.json')
  // One independent adapter can verify every origin-bound identity beneath
  // the provider root. Rebuilding an identical verifier for each generation
  // only repeats Windows ACL and PowerShell cold-start work and adds no
  // additional cross-root assertion.
  const verifierRoot = path.join(providerPrivateOwnershipRoot, 'cross-root-verifier')
  const verifier = new ProcessOwner({
    adapter: createWindowsJobAdapter({
      controlRoot: verifierRoot,
      providerPrivateOwnershipRoot,
    }),
    registryPath: path.join(providerPrivateOwnershipRoot, 'verifier-processes.json'),
  })
  for (let generation = 1; generation <= 3; generation += 1) {
    const generationRoot = path.join(providerPrivateOwnershipRoot, `generation-${generation}`)
    const jobControlRoot = path.join(generationRoot, 'job-control')
    const proxyControlRoot = path.join(generationRoot, 'proxy-control')
    fs.mkdirSync(proxyControlRoot, { recursive: true })
    const adapter = createWindowsJobAdapter({
      controlRoot: jobControlRoot,
      providerPrivateOwnershipRoot,
    })
    const owner = new ProcessOwner({ adapter, registryPath, pollMs: 20 })
    const runner = new OwnedCodexProxyRunner({
      processOwner: owner,
      controlRoot: proxyControlRoot,
      targetKey: 'repeated-generation-target',
      pollMs: 10,
    })
    const reservationId = `resume-generation-${generation}`
    const sessionId = `resumed-session-${generation}`
    let stopPromise = null
    const diagnostic = () => {
      let registry = null
      try { registry = readChecksummedJson(registryPath) } catch (error) { registry = { readError: error.message } }
      const statuses = []
      if (fs.existsSync(jobControlRoot)) {
        for (const statusPath of fs.readdirSync(jobControlRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(jobControlRoot, entry.name, 'status.json'))
          .filter((entry) => fs.existsSync(entry))) {
          try { statuses.push(JSON.parse(fs.readFileSync(statusPath, 'utf8'))) } catch (error) {
            statuses.push({ path: statusPath, readError: error.message })
          }
        }
      }
      return JSON.stringify({ generation, registry, statuses })
    }
    let timeout
    try {
      const completed = runner.run({
        executable: process.execPath,
        argv: [childScript],
        cwd: directory,
        env: { SystemRoot: process.env.SystemRoot },
        stdin: `generation=${generation}\n`,
        sessionId,
        reservationId,
        onStdoutLine(line) {
          const event = JSON.parse(line)
          if (event.type === 'turn.completed' && !stopPromise) {
            stopPromise = runner.stop({ sessionId, reason: 'terminal result persisted' })
          }
        },
      })
      const result = await Promise.race([
        completed,
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(
            `generation ${generation} terminal drain timed out: ${diagnostic()}`,
          )), 60000)
        }),
      ])
      assert.equal(result.status, 0, diagnostic())
      assert.equal(result.drained, true, diagnostic())
      assert.equal(result.signal, 'OWNED_STOP', diagnostic())
      assert.ok(stopPromise, `generation ${generation} did not observe its terminal JSONL event`)
      assert.equal((await stopPromise).drained, true, diagnostic())
      await owner.assertDrained()
      const registry = readChecksummedJson(registryPath)
      assert.equal(registry.records.length, generation, diagnostic())
      assert.equal(registry.records.every((record) => record.status === 'CANCELLED'), true, diagnostic())
      const currentRecord = registry.records.find((record) => record.reservationId === reservationId)
      assert.ok(currentRecord, diagnostic())
      const groupIdentity = currentRecord.groupIdentity
      assert.match(groupIdentity, /^windows-job:v2:/)
      assert.deepEqual(await adapter.listOwned(groupIdentity), [], diagnostic())
      const statusDirectory = path.join(jobControlRoot, digest(reservationId))
      const status = JSON.parse(fs.readFileSync(path.join(statusDirectory, 'status.json'), 'utf8'))
      assert.equal(status.status, 'EXITED', diagnostic())
      assert.deepEqual(status.pids, [], diagnostic())
      assert.ok(Array.isArray(status.observedPids) && status.observedPids.length >= 1, diagnostic())
      for (const pid of new Set([...status.observedPids, status.rootPid, status.helperPid])) {
        assert.throws(() => process.kill(pid, 0), undefined,
          `generation ${generation} status claimed drained while OS pid ${pid} remained live: ${diagnostic()}`)
      }

      for (const identity of [...priorIdentities, { kind: adapter.kind, id: groupIdentity }]) {
        assert.equal((await verifier.verifyOwnedIdentity(identity)).alive, false, diagnostic())
      }
      priorIdentities.push({ kind: adapter.kind, id: groupIdentity })
    } finally {
      clearTimeout(timeout)
      try { await runner.stop({ sessionId, reason: 'test cleanup' }) } catch {}
      try { await owner.cancelAll({ graceMs: 0, killMs: 5000, reason: 'test cleanup' }) } catch {}
    }
  }
})

test('finalizer drains target-global liveness, cleans only registered scratch, binds DONE, and releases lease', async (t) => {
  const directory = temporary(t)
  const target = path.join(directory, 'target')
  const runRoot = path.join(directory, 'run')
  const scratchRoot = path.join(runRoot, 'scratch')
  fs.mkdirSync(target)
  fs.mkdirSync(scratchRoot, { recursive: true })
  const deliverable = path.join(target, 'result.txt')
  const scratch = path.join(scratchRoot, 'worker-one')
  fs.writeFileSync(deliverable, 'verified result\n')
  fs.mkdirSync(scratch)
  fs.writeFileSync(path.join(scratch, 'temporary.txt'), 'remove me\n')

  const lock = new MissionLock({
    leaseRoot: path.join(directory, 'leases'),
    processIdentityObserver: leaseProcessObserver((pid) => pid === 900 ? 'finalizer-process' : null),
    identityProbe: () => ({ alive: true, verified: true, processIdentity: 'finalizer-process' }),
    randomId: () => 'lease-finalizer',
  })
  const lease = lock.acquire({
    targetPath: target,
    ledgerPath: runRoot,
    runId: 'run-0001',
    activationId: 'activation-001',
    missionHash: digest('mission'),
    nonce: 'nonce_123456789012',
    generation: 1,
    pid: 900,
    processIdentity: 'finalizer-process',
    token: 'c'.repeat(48),
  })
  const harness = stateHarness(t, {
    directory: runRoot,
    capability: lease,
    binding: { ...binding(), targetIdentity: lock.verifyCapability(lease).targetIdentity },
    capabilityVerifier: (candidate) => lock.verifyCapability(candidate),
  })
  advanceToFinalCheck(harness.store)
  const adapter = new FakeProcessAdapter()
  const processOwner = new ProcessOwner({
    adapter,
    registryPath: path.join(runRoot, 'runtime', 'processes.json'),
    allowTestAdapter: true,
  })
  const cleanupRegistry = new CleanupRegistry({
    registryPath: path.join(runRoot, 'cleanup.json'),
    allowedRoots: [scratchRoot],
  })
  cleanupRegistry.register({ path: scratch, owner: 'worker-one' })
  assert.throws(() => new Finalizer({
    stateStore: harness.store,
    processOwner,
    missionLock: lock,
    capability: lease,
    terminalPath: path.join(runRoot, 'unregistered-terminal.json'),
    cleanupRegistry,
  }), (error) => error.code === 'TERMINAL_PATH_UNREGISTERED')

  let failAt = 'terminal-record'
  const finalizer = new Finalizer({
    stateStore: harness.store,
    processOwner,
    missionLock: lock,
    capability: lease,
    cleanupRegistry,
    beforeBoundary(boundary) {
      if (boundary === failAt) throw new Error(`injected ${boundary} failure`)
    },
  })
  const finalOptions = {
    outcome: 'DONE',
    reason: 'final hashes green',
    expectedEpoch: 0,
    deliverables: [{ path: deliverable, hash: sha256(fs.readFileSync(deliverable)) }],
    checkHashes: [digest('checks')],
    terminalEnvelope: { status: 'DONE' },
  }
  await assert.rejects(finalizer.finalize(finalOptions), /injected terminal-record failure/)
  assert.equal(harness.store.load().state, 'RELEASING_LOCK')
  assert.equal(fs.existsSync(harness.store.registeredPaths.terminalPath), false)
  lock.assertOwned(lease)

  failAt = 'lease-release'
  await assert.rejects(finalizer.finalize(finalOptions), /injected lease-release failure/)
  assert.equal(harness.store.load().state, 'RELEASING_LOCK')
  lock.assertOwned(lease)

  failAt = null
  const result = await finalizer.finalize(finalOptions)
  assert.equal(result.state.state, 'DONE')
  assert.equal(lock.assertReleased(lease), true)
  assert.equal(fs.existsSync(scratch), false)
  assert.equal(finalizer.validateTerminalRecord().valid, true)
  assert.equal(result.terminal.terminalEnvelope.code, 'DONE')
  assert.deepEqual(result.terminal.terminalEnvelope.payload.providerTerminal, { status: 'DONE' })
  assertDraft202012Valid(
    path.join(ROOT, 'agents', 'contracts', 'schemas', 'outcome.schema.json'),
    [result.terminal.terminalEnvelope],
  )
  fs.writeFileSync(deliverable, 'changed after done\n')
  assert.deepEqual(finalizer.validateTerminalRecord(), {
    valid: false,
    reason: 'DELIVERABLE_HASH_CHANGED',
    path: deliverable,
  })
})

test('finalizer retries a crash after deterministic direct release-intent binding without changing outcome', async (t) => {
  const harness = stateHarness(t)
  advanceToWork(harness.store)
  transition(harness.store, 'RELEASING_LOCK', 'budget final without resumable frontier', 'BUDGET_EXHAUSTED_FINAL')
  let leaseStatus = 'ACTIVE'
  const missionLock = {
    describe: () => ({ status: leaseStatus, owner: { targetKey: 'target-key' } }),
    assertOwned: () => { assert.equal(leaseStatus, 'ACTIVE'); return true },
    updateOwnedProcesses: () => true,
    release: () => { leaseStatus = 'RELEASED' },
    assertReleased: () => { assert.equal(leaseStatus, 'RELEASED'); return true },
  }
  const processOwner = {
    ownershipIdentities: () => [],
    cancelAll: async () => [],
    assertTargetDrained: async () => true,
  }
  const scratchRoot = path.join(harness.directory, 'scratch')
  fs.mkdirSync(scratchRoot)
  const cleanupRegistry = new CleanupRegistry({
    registryPath: path.join(harness.directory, 'cleanup.json'),
    allowedRoots: [scratchRoot],
  })
  let failTerminalRecord = true
  const finalizer = new Finalizer({
    stateStore: harness.store,
    processOwner,
    missionLock,
    capability: harness.capability,
    cleanupRegistry,
    beforeBoundary(boundary) {
      if (boundary === 'terminal-record' && failTerminalRecord) throw new Error('injected direct terminal crash')
    },
  })
  const options = {
    outcome: 'PARTIAL',
    reason: 'budget final without resumable frontier',
    expectedEpoch: 0,
    deliverables: [],
    terminalEnvelope: { providerStatus: 'PARTIAL' },
  }
  await assert.rejects(finalizer.finalize(options), /injected direct terminal crash/)
  const prepared = harness.store.load()
  assert.equal(prepared.state, 'RELEASING_LOCK')
  assert.equal(prepared.terminal.outcome, 'PARTIAL')
  assert.equal(leaseStatus, 'ACTIVE')
  failTerminalRecord = false
  const completed = await finalizer.finalize(options)
  assert.equal(completed.state.state, 'PARTIAL')
  assert.equal(completed.terminal.terminalEventType, 'BUDGET_EXHAUSTED_FINAL')
  assert.equal(finalizer.validateTerminalRecord().valid, true)
  assert.equal(leaseStatus, 'RELEASED')
})

test('AP-RUN-007 delegated POSIX runtime admission rejects every hostile nonce suffix', (t) => {
  const invalidNonces = [
    '',
    'a'.repeat(15),
    `${'a'.repeat(16)}/suffix`,
    `${'a'.repeat(16)}.suffix`,
    `${'a'.repeat(16)} suffix`,
    `${'a'.repeat(16)}*suffix`,
    `${'a'.repeat(16)}\nsuffix`,
    `${'a'.repeat(16)}а`,
    'a'.repeat(65),
  ]

  for (const nonce of invalidNonces) {
    const harness = stateHarness(t, { create: false })
    assert.throws(() => harness.store.create({
      ...binding(),
      activation: {
        id: 'activation-001', nonce, missionHash: digest('mission'),
        sessionToken: 'session-token-001', generation: 1,
      },
      capability: harness.capability,
      cause: 'hostile nonce admission probe',
    }), error => error.code === 'ACTIVATION_NONCE_INVALID', JSON.stringify(nonce))
  }
})
