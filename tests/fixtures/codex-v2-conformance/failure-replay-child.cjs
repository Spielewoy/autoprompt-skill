#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SUT_ROOT = path.resolve(process.env.AUTOPROMPT_CONFORMANCE_SUT_ROOT || path.join(__dirname, '..', '..', '..'))
const workflow = name => require(path.join(SUT_ROOT, 'agents', 'codex', 'workflow', name))
const { EventLog } = workflow('event-log.js')
const { RuntimeStateStore } = workflow('runtime-state.js')
const decisions = workflow('route-decision.js')
const router = workflow('router.js')
const { buildContextFreeBrief, validateProviderCapabilities } = workflow('context-envelope.js')
const boundaryChild = path.join(__dirname, 'runtime-boundary-child.cjs')
const H = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const id = process.argv[process.argv.indexOf('--case') + 1]

function merge(base, overrides) {
  const result = structuredClone(base)
  for (const [key, value] of Object.entries(overrides || {})) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key]
      ? merge(result[key], value)
      : structuredClone(value)
  }
  return result
}

function facts(overrides = {}) {
  return merge({
    schemaVersion: '2.0.0', requestedEffect: 'report', successCriteria: 'ready',
    dependency: { shape: 'bounded', dependentWorkGroupCount: 1, integrationOwnerRequired: false, separateDependentBodies: 1 },
    uncertainty: 'none', reversibility: 'fully-reversible', mutableResources: [], sideEffects: [], externality: 'local-only', confidentiality: 'internal', thirdPartyImpact: 'none',
    targetAuthorization: { targetIdentities: [], authorizedTargetIdentities: [], authorizationEvidenceHash: null },
    costAuthority: { mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0, approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null },
    riskAndIndependentCheckFloor: { level: 'ordinary', minimumCheckerCount: 1, namedDistinctResponsibilities: [] },
    checkAndBaseline: { checkQuality: 'authoritative', availableCheckKinds: ['observable-result'], baselineStatus: 'not-applicable', hiddenExternalCheck: false },
    deadlineBudget: { remainingSeconds: 4000, admissionSeconds: 240, executionReserveSeconds: 600, verificationReserveSeconds: 300, recoveryAndFinalizationReserveSeconds: 180 },
    operatorMinimumRoute: null, transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true }, candidateFreeze: { required: true, available: true, environmentCanBeBound: true },
    missingUserInput: [], architectureImpact: 'local', fitsLightPlan: true, approachNeedsShortPlanning: false, shortOrderUnclear: false,
  }, overrides)
}

function createHarness(caseId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-failure-${caseId}-`))
  fs.mkdirSync(path.join(directory, 'runtime'), { recursive: true })
  const binding = {
    runId: `failure-${caseId}`,
    requestEnvelopeHash: H(`request:${caseId}`),
    targetIdentity: `target:${caseId}`,
    openedDirectoryIdentity: `opened:${caseId}`,
    digests: { contract: H('contract'), prompt: H('prompt'), provider: H('provider'), tool: H('tool') },
  }
  const capability = Object.freeze({ kind: 'opaque-failure-replay-capability' })
  const activation = {
    id: `activation-${caseId}`, nonce: `nonce_${H(caseId).slice(0, 24)}`,
    missionHash: H(`mission:${caseId}`), sessionToken: `session-${caseId}`, generation: 1,
  }
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++)).toISOString()
  const eventLog = new EventLog({
    logPath: path.join(directory, 'runtime', 'events.jsonl'),
    blobDirectory: path.join(directory, 'blobs'), binding, clock,
  })
  const store = new RuntimeStateStore({
    paths: {
      runRecordRoot: directory,
      statePath: path.join(directory, 'runtime', 'state.json'),
      eventPath: path.join(directory, 'runtime', 'events.jsonl'),
      terminalPath: path.join(directory, 'runtime', 'terminal.json'),
    },
    eventLog,
    capabilityVerifier: candidate => candidate === capability ? {
      runId: binding.runId, activationId: activation.id, missionHash: activation.missionHash,
      nonce: activation.nonce, generation: activation.generation, targetIdentity: binding.targetIdentity,
    } : null,
    clock,
  })
  store.create({ ...binding, activation, capability, cause: `create ${caseId} replay` })
  return { capability, directory, eventLog, store }
}

function move(harness, nextState, eventId) {
  return harness.store.transition(nextState, {
    capability: harness.capability,
    cause: `advance ${id} to ${nextState}`,
    ...(eventId ? { eventId } : {}),
  })
}

function advance(harness, nextState) {
  const states = [
    ['LOAD_SKILL'], ['STORE_REQUEST_ENVELOPE'], ['RESOLVE_SETTINGS'], ['ACQUIRE_TARGET_LOCK'],
    ['SELECT_SAFE_RUN_ROOT'], ['CREATE_RUN_RECORD'], ['CHECK_PROVIDER_CAPABILITIES'],
    ['START_ROUTE_ANALYST'], ['SAVE_ROUTE_ANALYSIS', 'ROUTE_ANALYST_STARTED'],
    ['L0_ROUTE_DECISION'], ['PREPARE_WORK'], ['RUN_WORK'], ['CHECK_WORK'],
  ]
  for (const [state, eventId] of states) {
    move(harness, state, eventId)
    if (state === nextState) return
  }
  throw new Error(`cannot advance fixture to ${nextState}`)
}

function finishRelease(harness, outcome) {
  harness.store.bindTerminal(outcome, {
    capability: harness.capability,
    cause: `${id} reached ${outcome}`,
    unblockPath: outcome === 'BLOCKED' ? 'Restore the named production dependency and resume.' : null,
  })
  harness.store.completeReleasedTerminal(outcome, {
    capability: harness.capability,
    cause: `${id} release completed`,
  })
}

function oracleFailureStatus() {
  return decisions.evaluateRouteEvent({
    event: 'ORACLE_FAILURE', currentRoute: 'DIRECT',
    evidence: [
      { kind: 'exact-check', value: 'focused-runtime-boundary', evidence_ref: 'fixture:focused-runtime-boundary' },
      { kind: 'authority', value: 'deterministic-local-process', evidence_ref: 'fixture:child-exit-record' },
      { kind: 'classification', value: 'unavailable-or-contradictory', evidence_ref: 'fixture:typed-observation' },
    ],
  })
}

function runStateCase(caseId) {
  const harness = createHarness(caseId)
  try {
    let status
    let injectionObserved = false
    let startSequence = 0

    if (caseId === 'spawn-crash') {
      advance(harness, 'START_ROUTE_ANALYST')
      startSequence = harness.eventLog.readAll().length
      const crashed = childProcess.spawnSync(process.execPath, [boundaryChild, '--mode', 'crash'], { encoding: 'utf8', shell: false, windowsHide: true })
      injectionObserved = crashed.status === 19
      const evaluated = decisions.evaluateRouteAnalystResult({ elapsedMs: 1, outcome: injectionObserved ? 'CRASH' : 'MALFORMED' })
      status = evaluated.status
      move(harness, 'SAVE_ROUTE_ANALYSIS', status === 'ROUTE_ANALYST_CRASH' ? 'ROUTE_ANALYST_FAILED_TO_START' : 'ROUTE_ANALYST_STARTED')
      move(harness, 'L0_ROUTE_DECISION')
      move(harness, 'PREPARE_WORK')
      move(harness, 'RUN_WORK')
      move(harness, 'CHECK_WORK')
      move(harness, 'FINAL_CHECK')
      move(harness, 'FINALIZING')
      finishRelease(harness, 'DONE')
    } else if (caseId === 'non-return') {
      advance(harness, 'L0_ROUTE_DECISION')
      startSequence = harness.eventLog.readAll().length
      const timedOut = childProcess.spawnSync(process.execPath, [boundaryChild, '--mode', 'non-return'], {
        encoding: 'utf8', shell: false, windowsHide: true, timeout: 50,
      })
      injectionObserved = timedOut.error?.code === 'ETIMEDOUT'
      const evaluated = decisions.evaluateL0Decision({
        startedAtMs: 0,
        submittedAtMs: decisions.L0_DECISION_MAX_DURATION_MS,
        nowMs: decisions.L0_DECISION_MAX_DURATION_MS,
        decision: null,
      })
      status = evaluated.status
      move(harness, 'RELEASING_LOCK', status)
      finishRelease(harness, 'FAILED')
    } else if (caseId === 'policy-denial') {
      advance(harness, 'CHECK_PROVIDER_CAPABILITIES')
      startSequence = harness.eventLog.readAll().length
      try {
        validateProviderCapabilities({ eventStreaming: true, toolOutputCapture: true, stableChildIdentity: true, sameContextContinuation: true, isolatedChecking: true, cancellation: false })
      } catch (error) {
        status = error.code
        injectionObserved = error.code === 'PROVIDER_UNSUPPORTED'
      }
      move(harness, 'RELEASING_LOCK', status)
      finishRelease(harness, 'BLOCKED')
    } else if (caseId === 'deadline-timeout') {
      advance(harness, 'PREPARE_WORK')
      startSequence = harness.eventLog.readAll().length
      const evaluated = router.classifyRoute(facts({
        deadlineBudget: { remainingSeconds: 1080, admissionSeconds: 240, executionReserveSeconds: 600, verificationReserveSeconds: 300, recoveryAndFinalizationReserveSeconds: 180 },
      }), { probeReason: 'characterize' })
      status = evaluated.status
      injectionObserved = status === 'ROUTE_BUDGET_INSUFFICIENT'
      harness.store.pauseForBudget({
        capability: harness.capability, cause: status,
        frontier: { resumeState: 'PREPARE_WORK', nextReadyWorkIds: ['work-after-budget'], remainingBudgetSeconds: 0, continuationBindingHash: H('budget-continuation') },
      })
    } else if (caseId === 'flaky-test') {
      advance(harness, 'CHECK_WORK')
      startSequence = harness.eventLog.readAll().length
      const observations = [1, 2].map(attempt => childProcess.spawnSync(
        process.execPath, [boundaryChild, '--mode', 'flaky-check', '--attempt', String(attempt)],
        { encoding: 'utf8', shell: false, windowsHide: true },
      )).map(result => JSON.parse(result.stdout.trim()))
      injectionObserved = new Set(observations.map(item => item.status)).size > 1
      const evaluated = oracleFailureStatus()
      status = evaluated.status
      move(harness, 'CHECK_INCONCLUSIVE', status)
      move(harness, 'RELEASING_LOCK', 'CHECK_REMAINS_INCONCLUSIVE')
      finishRelease(harness, 'PARTIAL')
    } else if (caseId === 'missing-credential') {
      advance(harness, 'PREPARE_WORK')
      startSequence = harness.eventLog.readAll().length
      const evaluated = router.classifyRoute(facts({ missingUserInput: ['Provide the required credential.'] }))
      status = evaluated.status
      injectionObserved = status === 'WAITING_USER'
      harness.store.waitForUser({
        capability: harness.capability, choice: evaluated.user_input_needed[0],
        artifactHash: H('credential-frontier'), cause: status,
      })
    } else if (caseId === 'unavailable-oracle') {
      advance(harness, 'CHECK_WORK')
      startSequence = harness.eventLog.readAll().length
      const unavailable = childProcess.spawnSync(process.execPath, [boundaryChild, '--mode', 'unavailable-oracle'], { encoding: 'utf8', shell: false, windowsHide: true })
      injectionObserved = unavailable.status === 44 && /MODULE_NOT_FOUND/.test(unavailable.stderr)
      const evaluated = oracleFailureStatus()
      status = evaluated.status
      move(harness, 'REASSESS_STRATEGY', 'ORACLE_FAILURE')
      move(harness, 'RELEASING_LOCK', 'STRATEGY_BLOCKED')
      finishRelease(harness, 'BLOCKED')
    } else {
      throw new Error(`unknown state replay: ${caseId}`)
    }

    const emitted = harness.eventLog.readAll().slice(startSequence).map(event => event.details.stateEvent)
    return {
      status, injectionObserved,
      boundary: harness.store.load().state,
      transitionIds: emitted.map(event => event.transitionId),
    }
  } finally {
    fs.rmSync(harness.directory, { recursive: true, force: true })
  }
}

function runMalformedBrief() {
  let status = null
  let injectionObserved = false
  try {
    buildContextFreeBrief({ fullHistory: ['forbidden inherited conversation'] })
  } catch (error) {
    status = error.code
    injectionObserved = error.code === 'INHERITED_CONTEXT_FORBIDDEN'
  }
  return { status, injectionObserved, boundary: injectionObserved ? 'PRE_SPAWN_REFUSAL' : null, transitionIds: [] }
}

const observed = id === 'malformed-brief' ? runMalformedBrief() : runStateCase(id)
process.stdout.write(`${JSON.stringify({ schemaVersion: 'codex-failure-replay.v1', id, ...observed })}\n`)
