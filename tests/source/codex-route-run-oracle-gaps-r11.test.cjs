#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const { BudgetController } = require(path.join(WORKFLOW, 'budget-controller.js'))
const { EventLog, sha256 } = require(path.join(WORKFLOW, 'event-log.js'))
const { assertGenerationControlAuthority } = require(path.join(WORKFLOW, 'generation-control.js'))
const { MissionLock } = require(path.join(WORKFLOW, 'mission-lock.js'))
const {
  CodexSupervisorRuntime,
  createSupervisorOptions,
  productionPhaseBudgets,
  reconstructTypedExitZeroResult,
  validateCanonicalChildResult,
} = require(path.join(WORKFLOW, 'phase-budget.js'))
const { RuntimeStateStore } = require(path.join(WORKFLOW, 'runtime-state.js'))

function temporary(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function stateFixture(t) {
  const directory = temporary(t, 'autoprompt-run-oracles-r11-')
  const runtimeDirectory = path.join(directory, 'runtime')
  const statePath = path.join(runtimeDirectory, 'state.json')
  const eventPath = path.join(runtimeDirectory, 'events.jsonl')
  const terminalPath = path.join(runtimeDirectory, 'terminal.json')
  const transactionPath = `${statePath}.transaction`
  const binding = {
    runId: 'run-oracle-001',
    requestEnvelopeHash: sha256('oracle request'),
    targetIdentity: 'target:oracle',
    openedDirectoryIdentity: 'opened:oracle',
    digests: {
      contract: sha256('oracle contract'),
      prompt: sha256('oracle prompt'),
      provider: sha256('oracle provider'),
      tool: sha256('oracle tool'),
    },
  }
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++)).toISOString()
  const eventLog = new EventLog({
    logPath: eventPath,
    blobDirectory: path.join(runtimeDirectory, 'blobs'),
    binding,
    clock,
  })
  const capability = Object.freeze({ type: 'oracle-capability' })
  const capabilityBinding = {
    runId: binding.runId,
    activationId: 'activation-oracle',
    missionHash: sha256('mission alpha'),
    nonce: 'nonce_123456789012',
    generation: 1,
    targetIdentity: binding.targetIdentity,
  }
  const paths = { runRecordRoot: directory, statePath, eventPath, terminalPath, transactionPath }
  const capabilityVerifier = candidate => candidate === capability ? { ...capabilityBinding } : null
  const store = new RuntimeStateStore({ paths, eventLog, capabilityVerifier, clock })
  store.create({
    ...binding,
    activation: {
      id: capabilityBinding.activationId,
      missionHash: capabilityBinding.missionHash,
      nonce: capabilityBinding.nonce,
      generation: capabilityBinding.generation,
      sessionToken: 'mission-alpha-secret-session-token',
    },
    capability,
  })
  return { binding, capability, capabilityBinding, capabilityVerifier, clock, directory, eventLog, paths, store }
}

test('AP-ROUTE-029 safety cancellation drains before a best-effort checkpoint and records checkpoint failure nonfatally', async () => {
  const order = []
  const makeRuntime = checkpointFailure => {
    const runtime = Object.create(CodexSupervisorRuntime.prototype)
    Object.assign(runtime, {
      activation: { generation: 1 },
      budget: { snapshot: () => ({ bounded: true }) },
      cancelled: false,
      finalizer: {
        async finalize(input) {
          order.push('finalize')
          assert.equal(input.outcome, 'CANCELLED')
          return { durable: true, outcome: input.outcome }
        },
      },
      finished: false,
      lease: Object.freeze({ type: 'oracle-lease' }),
      options: {
        persistRecoveryCheckpoint() {
          order.push('checkpoint')
          if (checkpointFailure) throw new Error('injected checkpoint failure')
          return { record: { checkpointPayloadHash: 'a'.repeat(64) } }
        },
      },
      processOwner: {
        async cancelAll({ reason }) { order.push(`cancel:${reason}`) },
        async assertDrained() { order.push('drain') },
      },
      recoveryAcceptedResultIds: new Set(),
      recoveryCompletedCheckIds: new Set(),
      recoveryCompletedWorkIds: new Set(),
      recoveryExternalOperations: new Map(),
      recoveryThreads: new Map(),
      rootCallers: { controlPlane: { sessionId: 'control-plane' } },
      route: 'LIGHT',
      scheduler: {
        dispose(reason) { order.push(`dispose:${reason}`) },
        exportState: () => ({ drained: true }),
        getMetrics: () => ({
          counters: { currentLiveChildren: 0 },
          rootAccounting: { status: 'completed' },
        }),
      },
    })
    return runtime
  }

  const result = await makeRuntime(false).cancel('operator safety stop')

  assert.equal(result.outcome, 'CANCELLED')
  assert.deepEqual(order.slice(0, 3), [
    'dispose:operator safety stop',
    'cancel:operator safety stop',
    'drain',
  ])
  assert.ok(order.indexOf('drain') < order.indexOf('checkpoint'))
  assert.ok(order.indexOf('checkpoint') < order.indexOf('finalize'))
  assert.equal(result.postDrainCheckpoint.status, 'PERSISTED')

  order.length = 0
  const failedCheckpoint = await makeRuntime(true).cancel('operator safety stop')
  assert.equal(failedCheckpoint.outcome, 'CANCELLED')
  assert.deepEqual(order.slice(0, 5), [
    'dispose:operator safety stop',
    'cancel:operator safety stop',
    'drain',
    'checkpoint',
    'finalize',
  ])
  assert.equal(failedCheckpoint.postDrainCheckpoint.status, 'FAILED')
  assert.match(failedCheckpoint.postDrainCheckpoint.error.message, /injected checkpoint failure/)
})

test('AP-RUN-026 reconstructed failed work cannot join, emit WORK_ITEM_VERIFIED, or reach assurance', () => {
  const requestEnvelopeHash = sha256('reconstructed request')
  const record = {
    logicalRole: 'worker', physicalRole: 'autoprompt.v2.ap-worker',
    runId: 'run-reconstructed', workItemId: 'work-1', findingIds: ['AP-RUN-026'],
    dispatch: { requestPointer: { hash: requestEnvelopeHash } },
  }
  const reconstructed = reconstructTypedExitZeroResult(record, {})
  assert.equal(reconstructed.allAssignedItemsPass, false)
  assert.throws(
    () => validateCanonicalChildResult(record, reconstructed, record.runId, requestEnvelopeHash),
    error => error.code === 'WORK_ITEM_RESULT_FAILED' && error.details.workItemId === 'work-1',
  )
})

test('AP-RUN-005 stale RUN-ENDED cannot be observed by or launch a new-generation child', (t) => {
  const runPath = temporary(t, 'autoprompt-run-ended-r11-')
  fs.writeFileSync(path.join(runPath, 'RUN-ENDED'), 'stale predecessor marker\n')
  let admittedChildren = 0
  const admitChild = () => {
    const authority = assertGenerationControlAuthority({
      runPath,
      activationId: 'activation-new-generation',
      generation: 2,
    })
    admittedChildren += 1
    return authority
  }

  assert.throws(admitChild, error =>
    error.code === 'GENERATION_CONTROL_DENIED' &&
    error.details.record === 'RUN-ENDED' &&
    error.details.reason === 'unbound-legacy-control')
  assert.equal(admittedChildren, 0)

  fs.unlinkSync(path.join(runPath, 'RUN-ENDED'))
  assert.equal(admitChild().authorized, true)
  assert.equal(admittedChildren, 1)
})

test('AP-RUN-011 a foreign mission capability cannot resume or disclose the persisted session token', (t) => {
  const fixture = stateFixture(t)
  const foreignCapability = Object.freeze({ type: 'foreign-mission-capability' })
  const foreignBinding = {
    ...fixture.capabilityBinding,
    activationId: 'activation-foreign',
    missionHash: sha256('mission beta'),
    nonce: 'nonce_abcdefghijkl',
  }
  const foreignStore = new RuntimeStateStore({
    paths: fixture.paths,
    eventLog: fixture.eventLog,
    capabilityVerifier: candidate => candidate === foreignCapability ? { ...foreignBinding } : null,
    clock: fixture.clock,
  })

  let rejection
  assert.throws(
    () => foreignStore.transition('LOAD_SKILL', {
      capability: foreignCapability,
      cause: 'foreign mission attempts resume',
      eventId: 'BOOTSTRAP',
    }),
    error => {
      rejection = error
      return error.code === 'LEASE_CAPABILITY_REQUIRED'
    },
  )
  assert.equal(fixture.store.load().state, 'BOOT')
  assert.equal(fixture.eventLog.readAll().length, 0)
  assert.doesNotMatch(JSON.stringify({ message: rejection.message, details: rejection.details }), /mission-alpha-secret-session-token/)
})

test('AP-RUN-014 invalid runtime configuration matrix terminates before launcher admission', () => {
  let launcherAdmissions = 0
  const valid = {
    limits: { wallMs: 100, tokens: 10, sessions: 2, launches: 3 },
    phases: { EXECUTION: { softMs: 10, hardMs: 20 } },
    monotonicMs: () => 0,
    wallNowMs: () => 0,
    bootId: null,
  }
  const invalid = [
    [undefined, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, limits: { ...valid.limits, wallMs: 0 } }, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, limits: { ...valid.limits, tokens: Number.MAX_SAFE_INTEGER + 1 } }, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, phases: { execution: { softMs: 10, hardMs: 20 } } }, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, phases: { EXECUTION: { softMs: 0, hardMs: 20 } } }, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, phases: { EXECUTION: { softMs: 20, hardMs: 20 } } }, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, finalizationReserveMs: -1 }, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, finalizationReserveMs: 60, verificationReserveMs: 40 }, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, monotonicClockId: '' }, 'BUDGET_CONFIG_INVALID'],
    [{ ...valid, monotonicMs: () => Number.NaN }, 'BUDGET_CLOCK_INVALID'],
    [{ ...valid, wallNowMs: () => Number.POSITIVE_INFINITY }, 'BUDGET_CLOCK_INVALID'],
  ]

  for (const [options, expectedCode] of invalid) {
    assert.throws(() => {
      const budget = new BudgetController(options)
      launcherAdmissions += 1
      return budget
    }, error => error.code === expectedCode)
  }
  assert.equal(launcherAdmissions, 0)
})

test('AP-RUN-020 stale quarantine atomically retries a precreated destination without clobbering evidence', (t) => {
  const directory = temporary(t, 'autoprompt-quarantine-r11-')
  const targetPath = path.join(directory, 'target')
  const ledgerPath = path.join(targetPath, '.autoprompt')
  const leaseRoot = path.join(directory, 'leases')
  fs.mkdirSync(targetPath)
  const firstInput = {
    targetPath,
    ledgerPath,
    runId: 'run-oracle-one',
    activationId: 'activation-one',
    missionHash: sha256('mission one'),
    nonce: 'nonce_123456789012',
    generation: 1,
    pid: 101,
    processIdentity: 'pid-one',
    token: 'a'.repeat(48),
  }
  const first = new MissionLock({
    leaseRoot,
    processIdentityObserver: (pid, identity) => identity,
    identityProbe: () => ({ alive: true, verified: true, ownedIdentityEvidence: [] }),
    randomId: () => 'lease-one',
  })
  const firstLease = first.acquire(firstInput)
  const description = first.describe(firstLease)
  const ownerBefore = fs.readFileSync(description.ownerPath)

  let collisionPath = null
  let quarantineDestination = null
  const injectedFs = Object.create(fs)
  injectedFs.mkdirSync = (candidate, options) => {
    if (String(candidate).includes('.stale.') && collisionPath === null) {
      collisionPath = String(candidate)
      fs.mkdirSync(candidate, options)
      fs.writeFileSync(path.join(candidate, 'attacker.txt'), 'must survive')
    }
    return fs.mkdirSync(candidate, options)
  }
  injectedFs.renameSync = (source, destination) => {
    if (String(destination).includes('.stale.')) quarantineDestination = String(destination)
    return fs.renameSync(source, destination)
  }
  const replacement = new MissionLock({
    leaseRoot,
    fsImpl: injectedFs,
    processIdentityObserver: (pid, identity) => pid === 202 ? identity : null,
    identityProbe: () => ({ alive: false, verified: true, ownedIdentityEvidence: [] }),
    randomId: () => 'lease-two',
  })

  const replacementLease = replacement.acquire({
    ...firstInput,
    runId: 'run-oracle-two',
    activationId: 'activation-two',
    missionHash: sha256('mission two'),
    pid: 202,
    processIdentity: 'pid-two',
    token: 'b'.repeat(48),
  })
  const takeover = replacement.describe(replacementLease).owner.takeover
  assert.match(path.basename(collisionPath), /\.stale\.lease-one\.[a-f0-9]{64}\.00$/)
  assert.equal(fs.readFileSync(path.join(collisionPath, 'attacker.txt'), 'utf8'), 'must survive')
  assert.equal(quarantineDestination, path.join(leaseRoot, takeover.quarantineName, 'lease'))
  assert.deepEqual(fs.readFileSync(path.join(quarantineDestination, 'owner.json')), ownerBefore)
})

test('AP-RUN-028 production lifecycle starts and decides route-neutral execution assurance recovery and finalization budgets', async () => {
  const phases = productionPhaseBudgets(1_000)
  const deadlineBound = new BudgetController({
    limits: { wallMs: 1_000, tokens: 100, sessions: 10, launches: 20 },
    phases,
    phaseBudgetFactory: productionPhaseBudgets,
    monotonicMs: () => 0,
    wallNowMs: () => 0,
    bootId: null,
  })
  deadlineBound.bindDeadline({
    wallMs: 500,
    verificationReserveMs: 50,
    finalizationReserveMs: 50,
    admittedAtMs: 0,
    deadline: {
      absoluteDeadline: new Date(500).toISOString(),
      verificationReservePercent: 10,
      recoveryAndFinalizationReservePercent: 10,
    },
  })
  assert.deepEqual(deadlineBound.phases, productionPhaseBudgets(500),
    'the authoritative task deadline must rescale production phase ceilings before phase entry')

  for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) {
    let now = 0
    const budget = new BudgetController({
      route,
      limits: { wallMs: 1000, tokens: 100, sessions: 10, launches: 20 },
      phases,
      monotonicMs: () => now,
      wallNowMs: () => 0,
      bootId: null,
    })
    const transitions = []
    const runtime = Object.create(CodexSupervisorRuntime.prototype)
    Object.assign(runtime, {
      activation: { id: `activation-${route}`, generation: 1 }, budget, lastAcceptedProgress: null,
      options: { runtimeTransition: async payload => { transitions.push(payload.nextState); return null } },
      route, scheduler: null,
    })
    await runtime._runtimeTransition('WORK_PREPARED', 'RUN_WORK')
    await runtime._runtimeTransition('ALL_WORK_JOINED', 'CHECK_WORK')
    await runtime._runtimeTransition('EXACT_STATE_RESTORED', 'RESUME_EXACT_STATE')
    await runtime._runtimeTransition('CANCEL_REQUESTED', 'RELEASING_LOCK')
    assert.deepEqual(Object.keys(budget.snapshot().phaseStartedAtElapsedMs).sort(), Object.keys(phases).sort())
    assert.deepEqual(transitions, ['RUN_WORK', 'CHECK_WORK', 'RESUME_EXACT_STATE', 'RELEASING_LOCK'])

    const originalExecutionStart = budget.snapshot().phaseStartedAtElapsedMs.EXECUTION_BUILD
    now = phases.EXECUTION_BUILD.hardMs
    await assert.rejects(
      runtime._runtimeTransition('MORE_WORK_READY', 'RUN_WORK'),
      error => error.code === 'PHASE_BUDGET_EXHAUSTED' && error.details.phase === 'EXECUTION_BUILD',
    )
    assert.equal(budget.snapshot().phaseStartedAtElapsedMs.EXECUTION_BUILD, originalExecutionStart,
      `${route}: repeated phase entry reset the hard deadline`)
    assert.deepEqual(transitions, ['RUN_WORK', 'CHECK_WORK', 'RESUME_EXACT_STATE', 'RELEASING_LOCK'])
  }
})

test('AP-RUN-034 state-store commit failure has bounded typed recovery and no relaunch loop', (t) => {
  const fixture = stateFixture(t)
  let failedStateCommits = 0
  const failingStore = new RuntimeStateStore({
    paths: fixture.paths,
    eventLog: fixture.eventLog,
    capabilityVerifier: fixture.capabilityVerifier,
    clock: fixture.clock,
    beforeCommit({ filePath }) {
      if (path.resolve(filePath) === path.resolve(fixture.paths.statePath)) {
        failedStateCommits += 1
        throw new Error('injected durable state-store failure')
      }
    },
  })

  assert.throws(() => failingStore.transition('LOAD_SKILL', {
    capability: fixture.capability,
    cause: 'exercise typed state-store failure',
    eventId: 'BOOTSTRAP',
  }), error => error.code === 'RUN_RECORD_FAILURE' && /injected durable state-store failure/.test(error.details.cause))
  assert.equal(failedStateCommits, 1)
  assert.equal(fs.existsSync(fixture.paths.transactionPath), true)
  assert.equal(fixture.eventLog.readAll().length, 1)

  assert.throws(() => failingStore.load(), error => error.code === 'RUN_RECORD_FAILURE')
  assert.equal(failedStateCommits, 2)

  const recoveredStore = new RuntimeStateStore({
    paths: fixture.paths,
    eventLog: fixture.eventLog,
    capabilityVerifier: fixture.capabilityVerifier,
    clock: fixture.clock,
  })
  const recovered = recoveredStore.load()
  assert.equal(recovered.state, 'LOAD_SKILL')
  assert.equal(recovered.sequence, 1)
  assert.equal(fixture.eventLog.readAll().length, 1)
  assert.equal(fs.existsSync(fixture.paths.transactionPath), false)
  assert.equal(failedStateCommits, 2)
})

test('AP-RUN-035 modern supervisor rejects parsed/glob legacy sentinel allowlists before probing or launching', () => {
  const legacySentinels = [
    'DONE-*',
    '../foreign-ledger/DONE-*',
    'RUN-ENDED .scope-phase-start',
    'inside-one/DONE-* inside-two/DONE-*',
    'RUN-ENDED\n../../outside/DONE-*',
  ]
  let probes = 0
  let runtimeFactories = 0
  for (const SENTINEL of legacySentinels) {
    assert.throws(() => createSupervisorOptions({}, {
      environment: { SENTINEL },
      execFileSync() { probes += 1 },
      runtimeOptionsFactory() { runtimeFactories += 1; return {} },
    }), error => error.code === 'LEGACY_SENTINEL_UNSUPPORTED')
  }
  assert.equal(probes, 0)
  assert.equal(runtimeFactories, 0)
})
