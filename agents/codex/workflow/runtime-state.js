#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  atomicWriteJson,
  canonicalize,
  readChecksummedJson,
  sha256,
  stableStringify,
} = require('./event-log.js')
const {
  ACTIVATION_NONCE_PATTERN: NONCE_PATTERN,
  validatePredecessorRelease,
  validateTakeoverReceipt,
} = require('./mission-lock.js')

const STATE_MACHINE = require('../../contracts/state-machine.json')
const STATE_EVENT_SCHEMA = require('../../contracts/schemas/state-event.schema.json')
const PLAIN_LANGUAGE = require('../../contracts/plain-language.json')

const STATE_SCHEMA_VERSION = STATE_MACHINE.contractVersion
const HASH_PATTERN = /^[a-f0-9]{64}$/
const INTERNAL = Symbol('runtime-state-internal')

if (STATE_MACHINE.contractVersion !== '2.0.0' || STATE_EVENT_SCHEMA.properties.contractVersion.const !== STATE_MACHINE.contractVersion) {
  throw new Error('canonical state-machine and state-event contracts are incompatible')
}

const STATES = Object.freeze([...STATE_MACHINE.states])
const FINAL_OUTCOMES = Object.freeze([...STATE_MACHINE.terminalStates])
const RESUMABLE_STATES = Object.freeze([...STATE_MACHINE.resumableStates])
const HALTED_BEFORE_LEASE = RESUMABLE_STATES
const TERMINAL_STATES = FINAL_OUTCOMES
const OUTCOME_DESCRIPTIONS = Object.freeze(Object.fromEntries(
  PLAIN_LANGUAGE.userVisibleCodes.map((entry) => [entry.code, entry.description]),
))
const RELEASE_INTENT_OUTCOMES = Object.freeze({
  T010: 'BLOCKED',
  T012: 'FAILED',
  T014: 'BLOCKED',
  T021: 'FAILED',
  T022: 'FAILED',
  T035: 'PARTIAL',
  T038: 'FAILED',
  T049: 'BLOCKED',
  T056: 'BLOCKED',
  T057: 'CANCELLED',
  T059: 'PARTIAL',
  T076: 'PARTIAL',
})
const CRASH_RECOVERY_POLICY = STATE_MACHINE.crashRecoveryPolicy
const RECOVERY_MILESTONES = Object.freeze([
  'route-analysis', 'route-decision', 'work-preparation', 'external-prepare',
  'external-commit', 'external-reconcile', 'final-check',
])
const CRASH_CHECKPOINT_FIELDS = Object.freeze([
  'savedState', 'resumeState', 'frontier', 'completedMilestones', 'externalRecovery', 'releaseIntentHash',
])
const CRASH_PRECONDITION_FIELDS = Object.freeze([
  'runId', 'activationId', 'missionHash', 'activationNonce', 'generation', 'targetIdentity',
  'stateChecksum', 'stateEventSequence', 'stateEventHash', 'resourceStateHash', 'retryStateHash', 'budgetsHash',
])
const RESTORABLE_STATES = [...CRASH_RECOVERY_POLICY.recoverableActiveStates]
const EVIDENCE_INPUT_IDS = Object.freeze([
  'mission', 'plan', 'candidate', 'environment', 'oracle', 'assumptions',
])
const INDEPENDENT_VERDICT_IDS = Object.freeze(['reviewer-verdict', 'tester-verdict'])
const CANONICAL_TRANSITIONS = Object.freeze(STATE_MACHINE.transitions.flatMap((transition) => {
  const fromStates = Array.isArray(transition.from) ? transition.from : [transition.from]
  return fromStates.flatMap((fromState) => {
    const toStates = transition.to === '$same'
      ? [fromState]
      : transition.to === '$savedResumeState' ? RESTORABLE_STATES : [transition.to]
    return toStates.map((toState) => Object.freeze({
      id: transition.id,
      event: transition.event,
      from: fromState,
      to: toState,
      humanDescription: transition.effect,
    }))
  })
}))
const LEGAL_TRANSITIONS = Object.freeze(Object.fromEntries(STATES.map((state) => [
  state,
  Object.freeze([...new Set(CANONICAL_TRANSITIONS.filter((entry) => entry.from === state).map((entry) => entry.to))]),
])))

function matchingTransitions(from, to, eventId) {
  return CANONICAL_TRANSITIONS.filter((entry) => entry.from === from && entry.to === to &&
    (eventId === undefined || entry.event === eventId))
}

class RuntimeStateError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RuntimeStateError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new RuntimeStateError(code, message, details)
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value) fail('STATE_INPUT_INVALID', `${field} is required`)
  return value
}

function resolveCanonicalTransition(from, to, eventId) {
  const matches = matchingTransitions(from, to, eventId)
  if (matches.length !== 1) {
    fail('ILLEGAL_STATE_TRANSITION', `canonical runtime transition is missing or ambiguous: ${from} -> ${to}`, {
      eventId: eventId || null,
      matches: matches.map((entry) => ({ transitionId: entry.id, eventId: entry.event })),
    })
  }
  return matches[0]
}

function validateCanonicalStateEvent(event) {
  const allowed = new Set(Object.keys(STATE_EVENT_SCHEMA.properties))
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      Object.keys(event).some((key) => !allowed.has(key)) ||
      STATE_EVENT_SCHEMA.required.some((key) => !Object.hasOwn(event, key))) return false
  if (event.contractVersion !== STATE_MACHINE.contractVersion || !/^T[0-9]{3}$/.test(event.transitionId || '') ||
      !/^[A-Z][A-Z0-9_]+$/.test(event.eventId || '') || typeof event.runId !== 'string' || event.runId.length < 8 ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(event.activationNonce || '') || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      !HASH_PATTERN.test(event.requestEnvelopeHash || '') || !HASH_PATTERN.test(event.targetIdentityHash || '') ||
      !(event.candidateHash === null || HASH_PATTERN.test(event.candidateHash || '')) ||
      !Array.isArray(event.evidenceHashes) || new Set(event.evidenceHashes).size !== event.evidenceHashes.length ||
      event.evidenceHashes.some((hash) => !HASH_PATTERN.test(hash)) || !Array.isArray(event.openIds) ||
      new Set(event.openIds).size !== event.openIds.length || event.openIds.some((id) => typeof id !== 'string' || !id) ||
      !Number.isSafeInteger(event.attempt) || event.attempt < 1 ||
      !(event.causalParent === null || (typeof event.causalParent === 'string' && event.causalParent)) ||
      Number.isNaN(Date.parse(event.occurredAt)) || typeof event.humanDescription !== 'string' || !event.humanDescription) return false
  const matches = matchingTransitions(event.fromState, event.toState, event.eventId)
  if (matches.length !== 1 || matches[0].id !== event.transitionId ||
      event.humanDescription !== matches[0].humanDescription) return false
  const requiresRecovery = ['T066', 'T077', 'T078'].includes(event.transitionId)
  if (requiresRecovery !== Object.hasOwn(event, 'recoveryContext')) return false
  if (!requiresRecovery) return true
  try {
    const recovery = normalizeRecoveryContext(event.recoveryContext)
    if (event.transitionId === 'T077' && recovery.savedState !== event.fromState) return false
    if (event.transitionId === 'T066' && recovery.resumeState !== event.toState) return false
    return true
  } catch { return false }
}

function uniqueStringArray(value, field) {
  if (!Array.isArray(value) || new Set(value).size !== value.length ||
      value.some((entry) => typeof entry !== 'string' || !entry)) {
    fail('CRASH_CHECKPOINT_INVALID', `${field} must be a unique string array`)
  }
  return [...value]
}

function crashCheckpointBindingHash(checkpoint) {
  const input = {}
  for (const field of CRASH_CHECKPOINT_FIELDS) input[field] = checkpoint[field]
  return sha256(stableStringify(input))
}

function recoveryFrontierHash(frontier) {
  return sha256(stableStringify(frontier))
}

function recoveryCheckpointHash(recoveryContext) {
  const input = {}
  for (const field of CRASH_RECOVERY_POLICY.checkpointDigest.checkpointHashFields) input[field] = recoveryContext[field]
  return sha256(stableStringify(input))
}

function normalizeExternalRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['none', 'reconciliation-required'].includes(value.status)) {
    fail('CRASH_CHECKPOINT_INVALID', 'externalRecovery is invalid')
  }
  const normalized = canonicalize({
    status: value.status,
    operationIds: uniqueStringArray(value.operationIds, 'externalRecovery.operationIds'),
    idempotencyKeys: uniqueStringArray(value.idempotencyKeys, 'externalRecovery.idempotencyKeys'),
    receiptHashes: uniqueStringArray(value.receiptHashes, 'externalRecovery.receiptHashes'),
  })
  if (normalized.receiptHashes.some((hash) => !HASH_PATTERN.test(hash))) {
    fail('CRASH_CHECKPOINT_INVALID', 'external recovery receipt hashes must be sha256')
  }
  if (normalized.status === 'none' &&
      (normalized.operationIds.length || normalized.idempotencyKeys.length || normalized.receiptHashes.length)) {
    fail('CRASH_CHECKPOINT_INVALID', 'externalRecovery none cannot carry operation evidence')
  }
  if (normalized.status === 'reconciliation-required' &&
      (!normalized.operationIds.length || !normalized.idempotencyKeys.length)) {
    fail('CRASH_CHECKPOINT_INVALID', 'external reconciliation requires operation and idempotency identities')
  }
  return normalized
}

function normalizeRecoveryFrontier(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CRASH_CHECKPOINT_INVALID', 'recovery frontier is required')
  }
  return canonicalize({
    nextReadyWorkIds: uniqueStringArray(value.nextReadyWorkIds, 'frontier.nextReadyWorkIds'),
    openCheckIds: uniqueStringArray(value.openCheckIds, 'frontier.openCheckIds'),
    acceptedResultIds: uniqueStringArray(value.acceptedResultIds, 'frontier.acceptedResultIds'),
  })
}

function prepareCrashCheckpoint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !CRASH_RECOVERY_POLICY.recoverableActiveStates.includes(input.savedState) ||
      !CRASH_RECOVERY_POLICY.recoverableActiveStates.includes(input.resumeState)) {
    fail('CRASH_CHECKPOINT_INVALID', 'crash checkpoint states are not canonically recoverable')
  }
  const frontier = normalizeRecoveryFrontier(input.frontier)
  const completedMilestones = uniqueStringArray(input.completedMilestones, 'completedMilestones')
  if (completedMilestones.some((entry) => !RECOVERY_MILESTONES.includes(entry))) {
    fail('CRASH_CHECKPOINT_INVALID', 'crash checkpoint has an unknown completed milestone')
  }
  const externalRecovery = normalizeExternalRecovery(input.externalRecovery)
  if (externalRecovery.status === 'reconciliation-required' &&
      input.resumeState !== CRASH_RECOVERY_POLICY.externalInFlightResumeState) {
    fail('CRASH_CHECKPOINT_INVALID', 'uncertain external effects must resume through CHECK_WORK reconciliation')
  }
  if (['external-prepare', 'external-commit'].some((entry) => completedMilestones.includes(entry)) &&
      !completedMilestones.includes('external-reconcile') && externalRecovery.status !== 'reconciliation-required') {
    fail('CRASH_CHECKPOINT_INVALID', 'prepared or committed external effects require reconciliation evidence')
  }
  if (completedMilestones.includes('route-analysis') && input.resumeState === 'START_ROUTE_ANALYST') {
    fail('CRASH_CHECKPOINT_INVALID', 'completed route analysis cannot be relaunched during exact resume')
  }
  if (completedMilestones.includes('route-decision') &&
      ['START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION'].includes(input.resumeState)) {
    fail('CRASH_CHECKPOINT_INVALID', 'completed L0 route decision cannot be repeated during exact resume')
  }
  if (completedMilestones.includes('final-check') && input.resumeState !== 'FINALIZING') {
    fail('CRASH_CHECKPOINT_INVALID', 'completed final check must resume at FINALIZING')
  }
  const releaseIntentHash = input.releaseIntentHash === null ? null : input.releaseIntentHash
  if (!(releaseIntentHash === null || HASH_PATTERN.test(releaseIntentHash || ''))) {
    fail('CRASH_CHECKPOINT_INVALID', 'releaseIntentHash must be null or sha256')
  }
  const checkpoint = canonicalize({
    schemaVersion: STATE_MACHINE.contractVersion,
    savedState: input.savedState,
    resumeState: input.resumeState,
    frontier,
    completedMilestones,
    externalRecovery,
    releaseIntentHash,
    bindingHash: '0'.repeat(64),
  })
  checkpoint.bindingHash = crashCheckpointBindingHash(checkpoint)
  return Object.freeze(checkpoint)
}

function normalizeRecoveryContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('CRASH_CHECKPOINT_INVALID', 'canonical recovery context is required')
  }
  const frontier = normalizeRecoveryFrontier(input.frontier)
  const completedMilestones = uniqueStringArray(input.completedMilestones, 'completedMilestones')
  if (completedMilestones.some((entry) => !RECOVERY_MILESTONES.includes(entry)) ||
      !CRASH_RECOVERY_POLICY.recoverableActiveStates.includes(input.savedState) ||
      !CRASH_RECOVERY_POLICY.recoverableActiveStates.includes(input.resumeState)) {
    fail('CRASH_CHECKPOINT_INVALID', 'recovery context states or milestones are invalid')
  }
  const externalRecovery = normalizeExternalRecovery(input.externalRecovery)
  if (externalRecovery.status === 'reconciliation-required' &&
      input.resumeState !== CRASH_RECOVERY_POLICY.externalInFlightResumeState) {
    fail('CRASH_CHECKPOINT_INVALID', 'recovery context bypasses required external reconciliation')
  }
  const priorOwner = input.priorOwner
  const accounting = input.accountingCheckpoint
  if (!priorOwner || typeof priorOwner.ownerId !== 'string' || !priorOwner.ownerId ||
      !HASH_PATTERN.test(priorOwner.staleOwnerEvidenceHash || '') || priorOwner.processesDrained !== true ||
      !HASH_PATTERN.test(priorOwner.processDrainEvidenceHash || '') || !accounting ||
      !HASH_PATTERN.test(accounting.snapshotHash || '') ||
      !Number.isSafeInteger(accounting.lastAccountingSequence) || accounting.lastAccountingSequence < 1 ||
      !HASH_PATTERN.test(accounting.lastAccountingHash || '') ||
      !(input.releaseIntentHash === null || HASH_PATTERN.test(input.releaseIntentHash || ''))) {
    fail('CRASH_CHECKPOINT_INVALID', 'recovery owner, accounting, or release evidence is invalid')
  }
  const normalized = canonicalize({
    savedState: input.savedState,
    resumeState: input.resumeState,
    checkpointHash: input.checkpointHash,
    frontierHash: input.frontierHash,
    frontier,
    completedMilestones,
    priorOwner,
    externalRecovery,
    releaseIntentHash: input.releaseIntentHash,
    accountingCheckpoint: accounting,
  })
  if (normalized.frontierHash !== recoveryFrontierHash(normalized.frontier) ||
      normalized.checkpointHash !== recoveryCheckpointHash(normalized)) {
    fail('CRASH_CHECKPOINT_INVALID', 'recovery context digest does not bind its exact frontier and checkpoint')
  }
  return normalized
}

function runtimeCrashPrecondition(state) {
  const precondition = canonicalize({
    runId: state.runId,
    activationId: state.activation.id,
    missionHash: state.activation.missionHash,
    activationNonce: state.activation.nonce,
    generation: state.activation.generation,
    targetIdentity: state.targetIdentity,
    stateChecksum: state.checksum,
    stateEventSequence: state.sequence,
    stateEventHash: state.lastEventHash,
    resourceStateHash: sha256(stableStringify(state.resourceState)),
    retryStateHash: sha256(stableStringify(state.retryState)),
    budgetsHash: sha256(stableStringify(state.budgets)),
  })
  return Object.freeze(precondition)
}

function releaseReconciliationEvidence(state, eventLog) {
  if (!state || state.state !== 'RELEASING_LOCK') {
    fail('RELEASE_RECONCILIATION_REQUIRED', 'release reconciliation requires the exact persisted RELEASING_LOCK state')
  }
  const sourceEvent = eventLog.readAll().at(-1)
  const stateEvent = sourceEvent && sourceEvent.details && sourceEvent.details.stateEvent
  if (!sourceEvent || sourceEvent.sequence !== state.sequence || sourceEvent.hash !== state.lastEventHash ||
      !validateCanonicalStateEvent(stateEvent) || stateEvent.sequence !== sourceEvent.sequence ||
      stateEvent.toState !== 'RELEASING_LOCK') {
    fail('RELEASE_INTENT_INVALID', 'release reconciliation cannot bind the canonical entering event')
  }
  let outcome = RELEASE_INTENT_OUTCOMES[stateEvent.transitionId] || null
  if (stateEvent.transitionId === 'T055') {
    if (!state.terminal || !FINAL_OUTCOMES.includes(state.terminal.outcome) ||
        !sourceEvent.details || stableStringify(sourceEvent.details.terminal) !== stableStringify(state.terminal)) {
      fail('RELEASE_INTENT_INVALID', 'FINAL_RECORD_READY does not bind the exact persisted terminal')
    }
    outcome = state.terminal.outcome
  }
  if (!outcome) {
    fail('RELEASE_INTENT_INVALID', 'RELEASING_LOCK was not entered by one canonical terminal release intent')
  }
  if (state.terminal && state.terminal.outcome !== outcome) {
    fail('OUTCOME_MISMATCH', 'persisted terminal conflicts with its canonical release intent')
  }
  const terminalHash = state.terminal === null ? null : sha256(stableStringify(state.terminal))
  const releaseIntent = canonicalize({
    transitionId: stateEvent.transitionId,
    eventId: stateEvent.eventId,
    eventSequence: sourceEvent.sequence,
    eventHash: sourceEvent.hash,
    outcome,
    terminalHash,
  })
  return Object.freeze(canonicalize({
    runId: state.runId,
    activationId: state.activation.id,
    missionHash: state.activation.missionHash,
    activationNonce: state.activation.nonce,
    generation: state.activation.generation,
    targetIdentity: state.targetIdentity,
    state: state.state,
    stateChecksum: state.checksum,
    stateEventSequence: state.sequence,
    stateEventHash: state.lastEventHash,
    transitionId: stateEvent.transitionId,
    eventId: stateEvent.eventId,
    outcome,
    releaseIntentHash: sha256(stableStringify(releaseIntent)),
    terminalHash,
    candidateHash: state.candidateHash,
    frontierHash: sha256(stableStringify(state.frontier)),
  }))
}

function normalizeFrontier(frontier, currentState) {
  if (!frontier || typeof frontier !== 'object' ||
      !['PREPARE_WORK', 'RUN_WORK', 'CHECK_WORK', 'REPAIRING'].includes(frontier.resumeState) ||
      frontier.resumeState !== currentState || !Array.isArray(frontier.nextReadyWorkIds) ||
      !frontier.nextReadyWorkIds.length || new Set(frontier.nextReadyWorkIds).size !== frontier.nextReadyWorkIds.length ||
      frontier.nextReadyWorkIds.some((id) => typeof id !== 'string' || !id) ||
      typeof frontier.remainingBudgetSeconds !== 'number' || !Number.isFinite(frontier.remainingBudgetSeconds) ||
      frontier.remainingBudgetSeconds < 0 || !HASH_PATTERN.test(frontier.continuationBindingHash || '')) {
    fail('PAUSED_FRONTIER_INVALID', 'PAUSED requires one exact, non-empty canonical continuation frontier')
  }
  return canonicalize(frontier)
}

function terminalProducedEvidenceHashes(manifest, checkHashes = []) {
  const hashes = [...new Set([
    ...manifest.map(entry => entry.hash),
    ...checkHashes,
  ])].sort()
  if (hashes.some(hash => !HASH_PATTERN.test(hash))) fail('OUTCOME_INVALID', 'terminal evidence hashes must be sha256')
  return Object.freeze(hashes)
}

function canonicalTerminalOutcome(outcome, state, manifest, manifestHash, options, recordedAt) {
  const producedEvidenceHashes = terminalProducedEvidenceHashes(manifest, options.checkHashes || [])
  return canonicalize({
    schemaVersion: STATE_MACHINE.contractVersion,
    code: outcome,
    description: OUTCOME_DESCRIPTIONS[outcome],
    stateClass: 'terminal',
    runId: state.runId,
    requestEnvelopeHash: state.requestEnvelopeHash,
    currentVersionHash: manifestHash,
    completedResults: manifest.map((entry, index) => ({
      id: `result-${index + 1}`,
      sha256: entry.hash,
      description: `Verified requested result ${index + 1}.`,
    })),
    nextReadyWork: [],
    cause: {
      event: 'FINAL_RECORD_READY',
      reason: options.cause,
      unblockPath: options.unblockPath || null,
    },
    payloadSchemaId: 'autoprompt.terminal.v2',
    payload: {
      deliverableManifestHash: manifestHash,
      producedEvidenceHashes,
      workspaceEpoch: state.workspaceEpoch,
      providerTerminal: options.terminalEnvelope || null,
    },
    recordedAt,
  })
}

function validateCanonicalTerminalOutcome(value) {
  const allowed = new Set([
    'schemaVersion', 'code', 'description', 'stateClass', 'runId', 'requestEnvelopeHash',
    'currentVersionHash', 'completedResults', 'nextReadyWork', 'cause', 'payloadSchemaId',
    'payload', 'recordedAt',
  ])
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== allowed.size || Object.keys(value).some((key) => !allowed.has(key)) ||
      value.schemaVersion !== STATE_MACHINE.contractVersion || !FINAL_OUTCOMES.includes(value.code) ||
      value.description !== OUTCOME_DESCRIPTIONS[value.code] || value.stateClass !== 'terminal' ||
      typeof value.runId !== 'string' || value.runId.length < 8 ||
      !HASH_PATTERN.test(value.requestEnvelopeHash || '') || !HASH_PATTERN.test(value.currentVersionHash || '') ||
      !Array.isArray(value.completedResults) || !Array.isArray(value.nextReadyWork) || value.nextReadyWork.length !== 0 ||
      value.payloadSchemaId !== 'autoprompt.terminal.v2' || !value.payload || typeof value.payload !== 'object' ||
      Array.isArray(value.payload) || Number.isNaN(Date.parse(value.recordedAt))) return false
  if (value.completedResults.some((entry) => {
    const keys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : []
    return keys.length !== 3 || !keys.every((key) => ['id', 'sha256', 'description'].includes(key)) ||
      typeof entry.id !== 'string' || !entry.id || !HASH_PATTERN.test(entry.sha256 || '') ||
      typeof entry.description !== 'string' || !entry.description
  })) return false
  const cause = value.cause
  return Boolean(cause && typeof cause === 'object' && !Array.isArray(cause) &&
    Object.keys(cause).length === 3 && ['event', 'reason', 'unblockPath'].every((key) => Object.hasOwn(cause, key)) &&
    /^[A-Z][A-Z0-9_]+$/.test(cause.event || '') && typeof cause.reason === 'string' && cause.reason &&
    (cause.unblockPath === null || (typeof cause.unblockPath === 'string' && cause.unblockPath)))
}

function validateActivation(activation) {
  if (!activation || typeof activation !== 'object') fail('STATE_INPUT_INVALID', 'activation is required')
  requireString(activation.id, 'activation.id')
  if (!NONCE_PATTERN.test(activation.nonce || '')) fail('ACTIVATION_NONCE_INVALID', 'activation nonce has an invalid format')
  if (!HASH_PATTERN.test(activation.missionHash || '')) fail('STATE_INPUT_INVALID', 'activation.missionHash must be sha256')
  requireString(activation.sessionToken, 'activation.sessionToken')
  if (!Number.isSafeInteger(activation.generation) || activation.generation < 1) {
    fail('STATE_INPUT_INVALID', 'activation.generation must be a positive safe integer')
  }
}

function validateInitial(input) {
  requireString(input.runId, 'runId')
  if (input.runId.length < 8) fail('STATE_INPUT_INVALID', 'runId must contain at least 8 characters')
  if (!HASH_PATTERN.test(input.requestEnvelopeHash || '')) fail('STATE_INPUT_INVALID', 'requestEnvelopeHash must be sha256')
  requireString(input.targetIdentity, 'targetIdentity')
  requireString(input.openedDirectoryIdentity, 'openedDirectoryIdentity')
  validateActivation(input.activation)
  if (!input.digests || typeof input.digests !== 'object') fail('STATE_INPUT_INVALID', 'digests are required')
  for (const field of ['contract', 'prompt', 'provider', 'tool']) requireString(input.digests[field], `digests.${field}`)
}

const CAPABILITY_BINDING_FIELDS = Object.freeze([
  'runId', 'activationId', 'missionHash', 'nonce', 'generation', 'targetIdentity',
])

function capabilityExpectation(state, generation = state.activation.generation) {
  return {
    runId: state.runId,
    activationId: state.activation.id,
    missionHash: state.activation.missionHash,
    nonce: state.activation.nonce,
    generation,
    targetIdentity: state.targetIdentity,
  }
}

function validateCapabilityBinding(binding, expected) {
  if (!binding || typeof binding !== 'object') return false
  return CAPABILITY_BINDING_FIELDS.every((field) => binding[field] === expected[field])
}

function hashFileStrict(filePath, fsImpl = fs) {
  const item = fsImpl.lstatSync(filePath)
  if (!item.isFile() || item.isSymbolicLink()) fail('PREIMAGE_UNSAFE', `deliverable is not a regular physical file: ${filePath}`)
  return sha256(fsImpl.readFileSync(filePath))
}

function normalizeManifest(entries) {
  if (!Array.isArray(entries)) fail('MANIFEST_INVALID', 'deliverable manifest must be an array')
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || !HASH_PATTERN.test(entry.hash || '')) {
      fail('MANIFEST_INVALID', 'each deliverable requires an absolute path and sha256 hash')
    }
    return { path: path.resolve(entry.path), hash: entry.hash }
  }).sort((left, right) => left.path.localeCompare(right.path))
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) fail('MANIFEST_INVALID', 'deliverable paths must be unique')
  }
  return normalized
}

function evidenceGraphHash(graph) {
  const unsigned = { ...graph }
  delete unsigned.graphHash
  return sha256(stableStringify(unsigned))
}

function validateEvidenceInvalidationGraph(graph) {
  const errors = []
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || graph.schemaVersion !== 1 ||
      !Array.isArray(graph.nodes)) return { valid: false, errors: ['evidence invalidation graph must be schema version 1'] }
  const nodes = new Map()
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.id !== 'string' || !node.id ||
        !['input', 'evidence', 'verdict'].includes(node.kind) || !HASH_PATTERN.test(node.hash || '') ||
        !Array.isArray(node.dependsOn) || new Set(node.dependsOn).size !== node.dependsOn.length ||
        node.dependsOn.some(id => typeof id !== 'string' || !id)) {
      errors.push('every evidence graph node requires a unique id, kind, SHA-256 hash, and unique dependency ids')
      continue
    }
    if (nodes.has(node.id)) errors.push(`duplicate evidence graph node: ${node.id}`)
    nodes.set(node.id, node)
  }
  for (const inputId of EVIDENCE_INPUT_IDS) {
    const node = nodes.get(inputId)
    if (!node || node.kind !== 'input' || node.dependsOn.length !== 0) {
      errors.push(`evidence graph requires dependency-free input ${inputId}`)
    }
  }
  for (const node of nodes.values()) {
    if (node.kind === 'input' && !EVIDENCE_INPUT_IDS.includes(node.id)) errors.push(`unknown evidence input: ${node.id}`)
    for (const dependency of node.dependsOn) {
      if (!nodes.has(dependency)) errors.push(`${node.id} depends on missing node ${dependency}`)
      if (dependency === node.id) errors.push(`${node.id} cannot depend on itself`)
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) { errors.push(`evidence graph cycle reaches ${id}`); return }
    if (visited.has(id) || !nodes.has(id)) return
    visiting.add(id)
    for (const dependency of nodes.get(id).dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of nodes.keys()) visit(id)
  if (!HASH_PATTERN.test(graph.graphHash || '') || graph.graphHash !== evidenceGraphHash(graph)) {
    errors.push('graphHash must bind the exact evidence dependency graph')
  }
  return { valid: errors.length === 0, errors }
}

function createEvidenceInvalidationGraph(input = {}) {
  const bindings = input.bindings || {}
  const inputNodes = EVIDENCE_INPUT_IDS.map(id => ({
    id,
    kind: 'input',
    hash: bindings[`${id}Hash`] ?? bindings[id],
    dependsOn: [],
  }))
  const supplied = [...(input.evidence || []), ...(input.verdicts || [])].map(node => ({
    id: node.id,
    kind: node.kind,
    hash: node.hash,
    dependsOn: [...(node.dependsOn || [])].sort(),
  }))
  const graph = canonicalize({
    schemaVersion: 1,
    nodes: [...inputNodes, ...supplied].sort((left, right) => left.id.localeCompare(right.id)),
    graphHash: '0'.repeat(64),
  })
  graph.graphHash = evidenceGraphHash(graph)
  const validation = validateEvidenceInvalidationGraph(graph)
  if (!validation.valid) fail('EVIDENCE_GRAPH_INVALID', validation.errors.join('; '))
  return Object.freeze(graph)
}

function transitiveDependents(graph, roots) {
  const reverse = new Map(graph.nodes.map(node => [node.id, []]))
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) reverse.get(dependency).push(node.id)
  }
  const seen = new Set(roots)
  const queue = [...roots]
  while (queue.length) {
    for (const dependent of reverse.get(queue.shift()) || []) {
      if (!seen.has(dependent)) { seen.add(dependent); queue.push(dependent) }
    }
  }
  return seen
}

function executeEvidenceInvalidation(graph, changes = {}) {
  const validation = validateEvidenceInvalidationGraph(graph)
  if (!validation.valid) fail('EVIDENCE_GRAPH_INVALID', validation.errors.join('; '))
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const changedInputs = new Set(Array.isArray(changes.changedInputs) ? changes.changedInputs : [])
  const nextBindings = changes.bindings || {}
  for (const inputId of EVIDENCE_INPUT_IDS) {
    const value = nextBindings[`${inputId}Hash`] ?? nextBindings[inputId]
    if (value !== undefined && value !== nodes.get(inputId).hash) changedInputs.add(inputId)
  }
  if ([...changedInputs].some(id => !EVIDENCE_INPUT_IDS.includes(id))) {
    fail('EVIDENCE_INVALIDATION_INVALID', 'changed inputs must name canonical evidence binding inputs')
  }
  const invalidated = transitiveDependents(graph, changedInputs)
  const invalidatedNodes = graph.nodes.filter(node => invalidated.has(node.id) && node.kind !== 'input')
  return Object.freeze({
    changedInputs: Object.freeze([...changedInputs].sort()),
    invalidatedEvidenceIds: Object.freeze(invalidatedNodes.filter(node => node.kind === 'evidence').map(node => node.id).sort()),
    invalidatedVerdictIds: Object.freeze(invalidatedNodes.filter(node => node.kind === 'verdict').map(node => node.id).sort()),
    rerunIds: Object.freeze(invalidatedNodes.map(node => node.id).sort()),
    unaffectedIds: Object.freeze(graph.nodes.filter(node => node.kind !== 'input' && !invalidated.has(node.id)).map(node => node.id).sort()),
  })
}

function verdictDependsOnCandidate(graph, verdictId) {
  return transitiveDependents(graph, ['candidate']).has(verdictId)
}

class RuntimeStateStore {
  constructor(options) {
    if (!options || !options.paths || !options.eventLog || typeof options.capabilityVerifier !== 'function') {
      fail('STATE_STORE_CONFIG_INVALID', 'state store requires registered paths, eventLog, and capabilityVerifier')
    }
    const registered = options.paths
    const runRecordRoot = path.resolve(requireString(registered.runRecordRoot, 'paths.runRecordRoot'))
    const statePath = path.resolve(requireString(registered.statePath, 'paths.statePath'))
    const eventPath = path.resolve(requireString(registered.eventPath, 'paths.eventPath'))
    const terminalPath = path.resolve(requireString(registered.terminalPath, 'paths.terminalPath'))
    const transactionPath = path.resolve(registered.transactionPath || `${statePath}.transaction`)
    const paths = [statePath, eventPath, terminalPath, transactionPath]
    for (const candidate of paths) {
      const relative = path.relative(runRecordRoot, candidate)
      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        fail('STATE_STORE_CONFIG_INVALID', `registered runtime path escapes run record: ${candidate}`)
      }
    }
    if (new Set(paths).size !== paths.length || path.resolve(options.eventLog.logPath) !== eventPath) {
      fail('STATE_STORE_CONFIG_INVALID', 'state, event, and terminal paths must be distinct and event-bound')
    }
    this.registeredPaths = Object.freeze({ runRecordRoot, statePath, eventPath, terminalPath, transactionPath })
    this.statePath = statePath
    this.eventLog = options.eventLog
    this.capabilityVerifier = options.capabilityVerifier
    this.recoveryCheckpointVerifier = options.recoveryCheckpointVerifier || null
    this.fs = options.fsImpl || fs
    this.clock = options.clock || (() => new Date().toISOString())
    this.randomId = options.randomId || (() => crypto.randomBytes(16).toString('hex'))
    this.beforeCommit = options.beforeCommit
  }

  create(input) {
    validateInitial(input)
    this._authorize(input.capability, 'create runtime state', capabilityExpectation(input))
    this._recoverTransaction()
    for (const field of ['runId', 'requestEnvelopeHash', 'targetIdentity', 'openedDirectoryIdentity']) {
      if (input[field] !== this.eventLog.binding[field]) fail('STATE_INPUT_INVALID', `state has foreign ${field}`)
    }
    if (stableStringify(input.digests) !== stableStringify(this.eventLog.binding.digests)) {
      fail('STATE_INPUT_INVALID', 'state has foreign interpretation digests')
    }
    if (this.fs.existsSync(this.statePath) || this.eventLog.readAll().length) {
      fail('RUN_RECORD_EXISTS', `run state already exists: ${this.statePath}`)
    }
    const base = canonicalize({
      schemaVersion: STATE_SCHEMA_VERSION,
      runId: input.runId,
      requestEnvelopeHash: input.requestEnvelopeHash,
      targetIdentity: input.targetIdentity,
      openedDirectoryIdentity: input.openedDirectoryIdentity,
      digests: input.digests,
      activation: { ...input.activation, status: input.activation.status || 'ACTIVE' },
      state: 'BOOT',
      sequence: 0,
      lastEventHash: null,
      workspaceEpoch: 0,
      candidateHash: null,
      frontier: null,
      terminal: null,
      activeMutation: null,
      verifiedItems: [],
      waitingUser: null,
      assurance: {
        candidateFreeze: null,
        evidenceGraph: null,
        verdicts: Object.fromEntries(INDEPENDENT_VERDICT_IDS.map(id => [id, { status: 'missing', hash: null }])),
        lastInvalidation: null,
      },
      retryState: input.retryState || {},
      resourceState: input.resourceState || {},
      budgets: input.budgets || null,
      createdAt: String(this.clock()),
      updatedAt: String(this.clock()),
    })
    return this._write(base)
  }

  load() {
    this._recoverTransaction()
    let state
    try { state = readChecksummedJson(this.statePath, { fsImpl: this.fs }) } catch (error) {
      fail('RUN_RECORD_FAILURE', `cannot load a valid runtime state: ${this.statePath}`, {
        cause: error.message,
        sourceCode: error.code,
      })
    }
    this._validateState(state)
    let events
    try { events = this.eventLog.readAll() } catch (error) {
      fail('RUN_RECORD_FAILURE', 'cannot validate the append-only event log', {
        cause: error.message,
        sourceCode: error.code,
      })
    }
    const last = events.at(-1)
    if (events.length !== state.sequence ||
        (state.sequence === 0 ? state.lastEventHash !== null : (!last || last.hash !== state.lastEventHash))) {
      fail('RUN_RECORD_FAILURE', 'state and event log sequences diverge; no new work is safe', {
        stateSequence: state.sequence,
        eventSequence: events.length,
      })
    }
    return state
  }

  transition(nextState, options = {}) {
    if (!STATES.includes(nextState)) fail('STATE_UNKNOWN', `unknown runtime state: ${nextState}`)
    const current = this.load()
    this._authorize(
      options.capability,
      `transition to ${nextState}`,
      capabilityExpectation(current, options.expectedCapabilityGeneration || current.activation.generation),
    )
    const canonicalTransition = resolveCanonicalTransition(current.state, nextState, options.eventId || options.eventType)
    if (FINAL_OUTCOMES.includes(nextState) && options[INTERNAL] !== true) {
      fail('FINALIZATION_REQUIRED', `outcome ${nextState} requires hash-bound terminal finalization`)
    }
    const next = this._patched(current, options.statePatch, options[INTERNAL] === true)
    next.state = nextState
    next.updatedAt = String(this.clock())
    if (nextState === 'PAUSED') {
      next.frontier = canonicalTransition.id === CRASH_RECOVERY_POLICY.crashTransitionId
        ? normalizeRecoveryContext(options.recoveryContext || (options.statePatch && options.statePatch.frontier))
        : normalizeFrontier(options.frontier || (options.statePatch && options.statePatch.frontier), current.state)
      next.activation.status = 'PAUSED'
    }
    if (nextState === 'WAITING_USER') next.activation.status = 'WAITING_USER'
    if (nextState === 'RESUME_EXACT_STATE') next.activation.status = 'RESUMING'
    if (canonicalTransition.id === CRASH_RECOVERY_POLICY.restoreTransitionId) next.activation.status = 'ACTIVE'
    if (nextState === 'RELEASING_LOCK') next.activation.status = 'RELEASING'
    if (FINAL_OUTCOMES.includes(nextState)) next.activation.status = 'ENDED'
    const evidenceHashes = [...new Set([...(options.workHashes || []), ...(options.checkHashes || [])])]
    const openIds = options.openIds || (next.frontier && next.frontier.nextReadyWorkIds) || []
    const stateEvent = canonicalize({
      contractVersion: STATE_MACHINE.contractVersion,
      transitionId: canonicalTransition.id,
      eventId: canonicalTransition.event,
      runId: next.runId,
      activationNonce: next.activation.nonce,
      sequence: current.sequence + 1,
      fromState: current.state,
      toState: nextState,
      requestEnvelopeHash: next.requestEnvelopeHash,
      targetIdentityHash: HASH_PATTERN.test(next.targetIdentity) ? next.targetIdentity : sha256(next.targetIdentity),
      candidateHash: next.candidateHash || null,
      evidenceHashes,
      openIds,
      attempt: options.attempt === undefined ? 1 : options.attempt,
      causalParent: current.lastEventHash,
      occurredAt: String(this.clock()),
      humanDescription: canonicalTransition.humanDescription,
      resourceState: next.resourceState,
      retryState: next.retryState,
      ...(options.recoveryContext ? { recoveryContext: normalizeRecoveryContext(options.recoveryContext) } : {}),
    })
    if (!validateCanonicalStateEvent(stateEvent)) {
      fail('STATE_EVENT_INVALID', `canonical state event validation failed: ${canonicalTransition.id}`, { stateEvent })
    }
    return this._commit(next, {
      type: canonicalTransition.event,
      cause: requireString(options.cause, 'transition cause'),
      stateBefore: current.state,
      stateAfter: nextState,
      generation: next.activation.generation,
      workspaceEpoch: next.workspaceEpoch,
      workHashes: options.workHashes,
      checkHashes: options.checkHashes,
      retryState: next.retryState,
      resourceState: next.resourceState,
      details: { ...(options.details || {}), stateEvent },
    }, current)
  }

  record(type, options = {}) {
    const current = this.load()
    if (FINAL_OUTCOMES.includes(current.state) || current.state === 'RELEASING_LOCK') {
      fail('RECORD_AFTER_TERMINAL', `record mutation is forbidden in ${current.state}`)
    }
    return this.transition(current.state, { ...options, eventId: type })
  }

  recordItemVerified(options = {}) {
    const current = this.load()
    this._authorize(options.capability, 'record verified work item', capabilityExpectation(current))
    const itemId = requireString(options.itemId, 'itemId')
    const resultHash = options.resultHash
    const versionHash = options.versionHash
    const checkHashes = Array.isArray(options.checkHashes) ? [...new Set(options.checkHashes)].sort() : []
    if (!HASH_PATTERN.test(resultHash || '') || !HASH_PATTERN.test(versionHash || '') ||
        checkHashes.length === 0 || checkHashes.some(hash => !HASH_PATTERN.test(hash))) {
      fail('ITEM_VERIFICATION_INVALID', 'ITEM_VERIFIED requires one result, version, and non-empty item-level check hashes')
    }
    if (current.state !== 'RUN_WORK') fail('ITEM_VERIFICATION_INVALID', 'work items can be verified only from RUN_WORK')
    if (current.verifiedItems.some(item => item.itemId === itemId)) {
      fail('ITEM_VERIFICATION_DUPLICATE', `work item is already verified: ${itemId}`)
    }
    const item = canonicalize({ itemId, resultHash, versionHash, checkHashes })
    return this.transition('ITEM_VERIFIED', {
      capability: options.capability,
      cause: requireString(options.cause, 'item verification cause'),
      eventId: 'WORK_ITEM_VERIFIED',
      statePatch: { verifiedItems: [...current.verifiedItems, item] },
      workHashes: [resultHash, versionHash],
      checkHashes,
      openIds: options.openIds || [],
      details: { item },
    })
  }

  freezeCandidateForChecks(options = {}) {
    const current = this.load()
    this._authorize(options.capability, 'freeze candidate for independent checks', capabilityExpectation(current))
    if (!['RUN_WORK', 'ITEM_VERIFIED'].includes(current.state)) {
      fail('CANDIDATE_FREEZE_INVALID', 'candidate freeze requires joined work in RUN_WORK or ITEM_VERIFIED')
    }
    if (!HASH_PATTERN.test(options.candidateHash || '') || !HASH_PATTERN.test(options.environmentHash || '') ||
        !HASH_PATTERN.test(options.dependencyHash || '')) {
      fail('CANDIDATE_FREEZE_INVALID', 'candidate, environment, and dependency hashes are required')
    }
    const graph = options.evidenceGraph
    const validation = validateEvidenceInvalidationGraph(graph)
    if (!validation.valid) fail('EVIDENCE_GRAPH_INVALID', validation.errors.join('; '))
    const requiredVerdictIds = Array.isArray(options.requiredVerdictIds)
      ? [...options.requiredVerdictIds] : [...INDEPENDENT_VERDICT_IDS]
    if (![1, 2].includes(requiredVerdictIds.length) ||
        requiredVerdictIds.some(id => !INDEPENDENT_VERDICT_IDS.includes(id)) ||
        new Set(requiredVerdictIds).size !== requiredVerdictIds.length) {
      fail('CANDIDATE_FREEZE_INVALID', 'candidate freeze requires one or two canonical independent verdict ids')
    }
    const candidateNode = graph.nodes.find(node => node.id === 'candidate')
    if (!candidateNode || candidateNode.hash !== options.candidateHash ||
        requiredVerdictIds.some(id => {
          const node = graph.nodes.find(candidate => candidate.id === id)
          return !node || node.kind !== 'verdict' || !verdictDependsOnCandidate(graph, id)
        })) {
      fail('CANDIDATE_FREEZE_INVALID', 'every required independent verdict must transitively depend on the exact frozen candidate')
    }
    const candidateFreeze = canonicalize({
      candidateHash: options.candidateHash,
      environmentHash: options.environmentHash,
      dependencyHash: options.dependencyHash,
      evidenceGraphHash: graph.graphHash,
    })
    candidateFreeze.freezeHash = sha256(stableStringify(candidateFreeze))
    return this.transition('CHECK_WORK', {
      capability: options.capability,
      cause: requireString(options.cause, 'candidate freeze cause'),
      eventId: 'ALL_WORK_JOINED',
      statePatch: {
        candidateHash: options.candidateHash,
        assurance: {
          candidateFreeze,
          evidenceGraph: graph,
          requiredVerdictIds,
          verdicts: Object.fromEntries(requiredVerdictIds.map(id => [id, { status: 'pending', hash: null }])),
          lastInvalidation: null,
        },
      },
      workHashes: [options.candidateHash, options.dependencyHash],
      details: { candidateFreeze },
    })
  }

  recordIndependentVerdict(options = {}) {
    const current = this.load()
    this._authorize(options.capability, 'record independent verdict', capabilityExpectation(current))
    const requiredVerdictIds = current.assurance && Array.isArray(current.assurance.requiredVerdictIds)
      ? current.assurance.requiredVerdictIds : INDEPENDENT_VERDICT_IDS
    if (current.state !== 'CHECK_WORK' || !requiredVerdictIds.includes(options.verdictId) ||
        !HASH_PATTERN.test(options.verdictHash || '') || !current.assurance.candidateFreeze ||
        !current.assurance.evidenceGraph) {
      fail('VERDICT_BINDING_INVALID', 'verdict requires CHECK_WORK and one frozen graph-bound candidate')
    }
    const verdicts = { ...current.assurance.verdicts, [options.verdictId]: {
      status: 'valid', hash: options.verdictHash,
    } }
    return this.record('TRANSIENT_RUNTIME', {
      capability: options.capability,
      cause: requireString(options.cause, 'verdict cause'),
      checkHashes: [options.verdictHash],
      statePatch: { assurance: { ...current.assurance, verdicts } },
      details: {
        verdictId: options.verdictId,
        verdictHash: options.verdictHash,
        candidateFreezeHash: current.assurance.candidateFreeze.freezeHash,
      },
    })
  }

  pauseForBudget(options = {}) {
    return this.transition('PAUSED', {
      capability: options.capability,
      cause: requireString(options.cause, 'budget pause cause'),
      eventId: 'BUDGET_EXHAUSTED_RESUMABLE',
      frontier: options.frontier,
      details: { boundary: 'BUDGET_EXHAUSTED', terminal: false, resumable: true },
    })
  }

  waitForUser(options = {}) {
    const current = this.load()
    this._authorize(options.capability, 'wait for indispensable user input', capabilityExpectation(current))
    const choice = requireString(options.choice, 'user choice')
    if (!HASH_PATTERN.test(options.artifactHash || '')) {
      fail('WAITING_USER_INVALID', 'WAITING_USER requires a hash-bound saved artifact/frontier')
    }
    const waitingUser = canonicalize({
      choice,
      artifactHash: options.artifactHash,
      resumeState: current.state,
    })
    return this.transition('WAITING_USER', {
      capability: options.capability,
      cause: requireString(options.cause, 'waiting user cause'),
      eventId: options.eventId || (current.state === 'L0_ROUTE_DECISION' ? 'ROUTE_DECISION_NEEDS_USER' : 'AUTHORITY_REQUIRED'),
      statePatch: { waitingUser },
      details: { waitingUser, terminal: false, resumable: true },
    })
  }

  beginAuthorizedMutation(options) {
    const current = this.load()
    this._authorize(options && options.capability, 'begin authorized mutation', capabilityExpectation(current))
    if (FINAL_OUTCOMES.includes(current.state) || ['RELEASING_LOCK', 'FINALIZING', 'PAUSED'].includes(current.state)) {
      fail('MUTATION_AFTER_TERMINAL', `mutation is forbidden in ${current.state}`)
    }
    const authority = options && options.authority
    if (!authority || authority.runId !== current.runId || authority.activationId !== current.activation.id ||
        authority.nonce !== current.activation.nonce || authority.generation !== current.activation.generation) {
      fail('MUTATION_AUTHORITY_INVALID', 'mutation authority is not bound to the active run and generation')
    }
    if (options.expectedEpoch !== current.workspaceEpoch) {
      fail('CONCURRENT_MUTATION', 'workspace epoch changed before mutation', {
        expected: options.expectedEpoch,
        actual: current.workspaceEpoch,
      })
    }
    if (current.activeMutation) fail('CONCURRENT_MUTATION', 'another authorized mutation is already active')
    const preimages = normalizeManifest(options.preimages || [])
    for (const entry of preimages) {
      const actual = hashFileStrict(entry.path, this.fs)
      if (actual !== entry.hash) {
        fail('CONCURRENT_MUTATION', `candidate preimage changed: ${entry.path}`, { expected: entry.hash, actual })
      }
    }
    const permit = {
      id: this.randomId(),
      runId: current.runId,
      activationId: current.activation.id,
      fromEpoch: current.workspaceEpoch,
      epoch: current.workspaceEpoch + 1,
      preimageManifestHash: sha256(stableStringify(preimages)),
      isolationBindingHash: options.isolation && HASH_PATTERN.test(options.isolation.bindingHash || '')
        ? options.isolation.bindingHash : null,
      issuedAt: String(this.clock()),
    }
    if (options.requireIsolation === true && !permit.isolationBindingHash) {
      fail('MUTATION_ISOLATION_REQUIRED', 'authorized worker mutation requires a hash-bound private workspace')
    }
    if (!['RUN_WORK', 'CHECK_WORK', 'FINAL_CHECK'].includes(current.state)) {
      fail('MUTATION_STATE_INVALID', `authorized mutation is not canonical from ${current.state}`)
    }
    const nextState = current.state === 'FINAL_CHECK' ? 'RUN_WORK' : current.state
    const invalidationRequired = ['CHECK_WORK', 'FINAL_CHECK'].includes(current.state)
    const assurance = current.assurance || {
      candidateFreeze: null, evidenceGraph: null,
      verdicts: Object.fromEntries(INDEPENDENT_VERDICT_IDS.map(id => [id, { status: 'missing', hash: null }])),
      lastInvalidation: null,
    }
    const lastInvalidation = invalidationRequired
      ? assurance.evidenceGraph
        ? executeEvidenceInvalidation(assurance.evidenceGraph, { changedInputs: ['candidate'] })
        : Object.freeze({
            changedInputs: Object.freeze(['candidate']), invalidatedEvidenceIds: Object.freeze([]),
            invalidatedVerdictIds: Object.freeze([...INDEPENDENT_VERDICT_IDS]),
            rerunIds: Object.freeze([...INDEPENDENT_VERDICT_IDS]), unaffectedIds: Object.freeze([]),
          })
      : assurance.lastInvalidation
    const nextAssurance = invalidationRequired ? {
      candidateFreeze: null,
      evidenceGraph: assurance.evidenceGraph,
      verdicts: Object.fromEntries(INDEPENDENT_VERDICT_IDS.map(id => [id, {
        status: 'invalidated', hash: null,
      }])),
      lastInvalidation,
    } : assurance
    const next = this._patched(current, {
      workspaceEpoch: permit.epoch,
      terminal: null,
      activeMutation: permit,
      ...(invalidationRequired ? { candidateHash: null, assurance: nextAssurance } : {}),
      state: nextState,
    }, true)
    next.updatedAt = String(this.clock())
    this.transition(nextState, {
      capability: options.capability,
      cause: requireString(options.cause, 'mutation cause'),
      eventId: current.state === 'FINAL_CHECK' ? 'SMALL_REFINEMENT_SELECTED' : 'TRANSIENT_RUNTIME',
      statePatch: {
        workspaceEpoch: permit.epoch, terminal: null, activeMutation: permit,
        ...(invalidationRequired ? { candidateHash: null, assurance: nextAssurance } : {}),
      },
      [INTERNAL]: true,
      details: { permit, preimages, ...(invalidationRequired ? { invalidation: lastInvalidation } : {}) },
    })
    return permit
  }

  commitAuthorizedMutation(permit, options = {}) {
    const current = this.load()
    this._authorize(options.capability, 'commit authorized mutation', capabilityExpectation(current))
    if (!permit || !current.activeMutation || stableStringify(permit) !== stableStringify(current.activeMutation)) {
      fail('MUTATION_PERMIT_INVALID', 'mutation permit is not active')
    }
    if (permit.isolationBindingHash && options.isolationBindingHash !== permit.isolationBindingHash) {
      fail('MUTATION_ISOLATION_MISMATCH', 'mutation commit is not bound to its admitted private workspace')
    }
    const postimages = normalizeManifest(options.postimages || [])
    for (const entry of postimages) {
      const actual = hashFileStrict(entry.path, this.fs)
      if (actual !== entry.hash) {
        fail('MUTATION_RESULT_MISMATCH', `candidate result hash mismatch: ${entry.path}`, {
          expected: entry.hash,
          actual,
        })
      }
    }
    const deletions = Array.isArray(options.deletions) ? [...new Set(options.deletions)] : []
    if (deletions.some(filePath => typeof filePath !== 'string' || !path.isAbsolute(filePath))) {
      fail('MUTATION_RESULT_MISMATCH', 'mutation deletions must be unique absolute paths')
    }
    for (const filePath of deletions) {
      if (this.fs.existsSync(filePath)) {
        fail('MUTATION_RESULT_MISMATCH', `candidate deletion was not promoted: ${filePath}`)
      }
    }
    return this.record('TRANSIENT_RUNTIME', {
      capability: options.capability,
      cause: requireString(options.cause, 'mutation commit cause'),
      workHashes: [
        ...postimages.map((entry) => entry.hash),
        ...deletions.map(filePath => sha256(`autoprompt-deleted-v1\0${filePath}`)),
      ],
      statePatch: { activeMutation: null },
      [INTERNAL]: true,
      details: { permitId: permit.id, postimages, deletions },
    })
  }

  abortAuthorizedMutation(permit, options = {}) {
    const current = this.load()
    this._authorize(options.capability, 'abort authorized mutation', capabilityExpectation(current))
    if (!permit || !current.activeMutation || stableStringify(permit) !== stableStringify(current.activeMutation)) {
      fail('MUTATION_PERMIT_INVALID', 'mutation permit is not active')
    }
    if (permit.isolationBindingHash && options.isolationBindingHash !== permit.isolationBindingHash) {
      fail('MUTATION_ISOLATION_MISMATCH', 'mutation abort is not bound to its admitted private workspace')
    }
    return this.record('TRANSIENT_RUNTIME', {
      capability: options.capability,
      cause: requireString(options.cause, 'mutation abort cause'),
      statePatch: { activeMutation: null },
      [INTERNAL]: true,
      details: {
        permitId: permit.id,
        failureCode: typeof options.failureCode === 'string' && options.failureCode ? options.failureCode : 'WORKER_FAILED',
      },
    })
  }

  bindTerminal(outcome, options = {}) {
    if (!FINAL_OUTCOMES.includes(outcome)) fail('OUTCOME_INVALID', `invalid final outcome: ${outcome}`)
    const current = this.load()
    this._authorize(options.capability, `bind terminal ${outcome}`, capabilityExpectation(current))
    if (current.state === 'RELEASING_LOCK') {
      return this._bindReleaseIntentTerminal(outcome, current, options)
    }
    if (current.state !== 'FINALIZING') fail('FINALIZATION_REQUIRED', 'terminal result can only bind from FINALIZING or a canonical release intent')
    if (current.activeMutation) fail('MUTATION_INCOMPLETE', 'cannot finalize while a mutation permit is active')
    const manifest = normalizeManifest(options.deliverables || [])
    for (const entry of manifest) {
      const actual = hashFileStrict(entry.path, this.fs)
      if (actual !== entry.hash) fail('CONCURRENT_MUTATION', `deliverable changed during finalization: ${entry.path}`)
    }
    const completedAt = String(this.clock())
    const deliverableManifestHash = sha256(stableStringify(manifest))
    const terminalEnvelope = canonicalTerminalOutcome(
      outcome,
      current,
      manifest,
      deliverableManifestHash,
      { ...options, cause: requireString(options.cause, 'terminal cause') },
      completedAt,
    )
    if (!validateCanonicalTerminalOutcome(terminalEnvelope)) {
      fail('OUTCOME_INVALID', 'terminal result does not satisfy the canonical outcome contract')
    }
    const terminal = canonicalize({
      schemaVersion: '2.0.0',
      outcome,
      runId: current.runId,
      activationId: current.activation.id,
      generation: current.activation.generation,
      sequence: current.sequence + 1,
      missionHash: current.activation.missionHash,
      requestEnvelopeHash: current.requestEnvelopeHash,
      workspaceEpoch: current.workspaceEpoch,
      deliverableManifest: manifest,
      deliverableManifestHash,
      producedEvidenceHashes: terminalProducedEvidenceHashes(manifest, options.checkHashes || []),
      terminalEnvelope,
      completedAt,
    })
    return this.transition('RELEASING_LOCK', {
      capability: options.capability,
      cause: requireString(options.cause, 'terminal cause'),
      eventId: 'FINAL_RECORD_READY',
      workHashes: manifest.map((entry) => entry.hash),
      checkHashes: options.checkHashes,
      statePatch: { terminal, candidateHash: terminal.deliverableManifestHash },
      [INTERNAL]: true,
      details: { terminal },
    })
  }

  _bindReleaseIntentTerminal(outcome, current, options) {
    if (current.activeMutation) fail('MUTATION_INCOMPLETE', 'cannot finalize while a mutation permit is active')
    const sourceEvent = this.eventLog.readAll().at(-1)
    const stateEvent = sourceEvent && sourceEvent.details && sourceEvent.details.stateEvent
    if (!sourceEvent || sourceEvent.sequence !== current.sequence || sourceEvent.hash !== current.lastEventHash ||
        !validateCanonicalStateEvent(stateEvent) || stateEvent.sequence !== sourceEvent.sequence ||
        stateEvent.toState !== 'RELEASING_LOCK' || stateEvent.transitionId === 'T055') {
      fail('RELEASE_INTENT_INVALID', 'RELEASING_LOCK does not bind one valid canonical failure/cancel/budget intent')
    }
    const derivedOutcome = RELEASE_INTENT_OUTCOMES[stateEvent.transitionId]
    if (!derivedOutcome || outcome !== derivedOutcome) {
      fail('OUTCOME_MISMATCH', 'terminal outcome must equal the canonical entering release intent', {
        transitionId: stateEvent.transitionId,
        expectedOutcome: derivedOutcome || null,
        requestedOutcome: outcome,
      })
    }
    if (current.terminal) {
      const validation = this.validateTerminal(current)
      if (!validation.valid || current.terminal.outcome !== derivedOutcome) {
        fail('TERMINAL_REPLAY_CONFLICT', 'persisted release-intent terminal cannot be replaced')
      }
      return current
    }
    const manifest = normalizeManifest(options.deliverables || [])
    for (const entry of manifest) {
      const actual = hashFileStrict(entry.path, this.fs)
      if (actual !== entry.hash) fail('CONCURRENT_MUTATION', `deliverable changed during finalization: ${entry.path}`)
    }
    const completedAt = String(this.clock())
    const deliverableManifestHash = sha256(stableStringify(manifest))
    const terminalEnvelope = canonicalTerminalOutcome(
      derivedOutcome,
      current,
      manifest,
      deliverableManifestHash,
      { ...options, cause: requireString(options.cause, 'terminal cause') },
      completedAt,
    )
    if (!validateCanonicalTerminalOutcome(terminalEnvelope)) {
      fail('OUTCOME_INVALID', 'release-intent terminal does not satisfy the canonical outcome contract')
    }
    const releaseIntent = canonicalize({
      transitionId: stateEvent.transitionId,
      eventId: stateEvent.eventId,
      eventSequence: sourceEvent.sequence,
      eventHash: sourceEvent.hash,
      sourceStateChecksum: current.checksum,
      stateChecksum: current.checksum,
    })
    const terminal = canonicalize({
      schemaVersion: STATE_MACHINE.contractVersion,
      outcome: derivedOutcome,
      runId: current.runId,
      activationId: current.activation.id,
      generation: current.activation.generation,
      sequence: sourceEvent.sequence,
      missionHash: current.activation.missionHash,
      requestEnvelopeHash: current.requestEnvelopeHash,
      workspaceEpoch: current.workspaceEpoch,
      deliverableManifest: manifest,
      deliverableManifestHash,
      producedEvidenceHashes: terminalProducedEvidenceHashes(manifest, options.checkHashes || []),
      terminalEnvelope,
      releaseIntent,
      completedAt,
    })
    const next = this._patched(current, { terminal, candidateHash: deliverableManifestHash }, true)
    // The release-intent event is already durable and canonical. Binding its
    // deterministic terminal projection changes no state-machine state or
    // sequence, so it is one atomic checksummed snapshot write, not a fake
    // self-transition.
    return this._write(next)
  }

  completeReleasedTerminal(outcome, options = {}) {
    if (!FINAL_OUTCOMES.includes(outcome)) fail('OUTCOME_INVALID', `invalid final outcome: ${outcome}`)
    const current = this.load()
    if (current.state !== 'RELEASING_LOCK' || !current.terminal || current.terminal.outcome !== outcome) {
      fail('FINALIZATION_REQUIRED', 'released terminal completion requires the matching prepared outcome')
    }
    const eventId = `LOCK_RELEASED_${outcome}`
    return this.transition(outcome, {
      capability: options.capability,
      cause: requireString(options.cause, 'released terminal cause'),
      eventId,
      [INTERNAL]: true,
      workHashes: current.terminal.deliverableManifest.map((entry) => entry.hash),
      checkHashes: options.checkHashes,
      details: { terminal: current.terminal },
    })
  }

  validateTerminal(state = this.load()) {
    if (!state.terminal || state.terminal.workspaceEpoch !== state.workspaceEpoch ||
        state.terminal.runId !== state.runId || state.terminal.activationId !== state.activation.id ||
        state.terminal.requestEnvelopeHash !== state.requestEnvelopeHash ||
        !validateCanonicalTerminalOutcome(state.terminal.terminalEnvelope) ||
        state.terminal.terminalEnvelope.code !== state.terminal.outcome ||
        state.terminal.terminalEnvelope.runId !== state.runId ||
        state.terminal.terminalEnvelope.requestEnvelopeHash !== state.requestEnvelopeHash ||
        state.terminal.terminalEnvelope.currentVersionHash !== state.terminal.deliverableManifestHash) {
      return { valid: false, reason: 'TERMINAL_BINDING_MISMATCH' }
    }
    const manifest = normalizeManifest(state.terminal.deliverableManifest)
    const evidenceHashes = state.terminal.producedEvidenceHashes
    if (!Array.isArray(evidenceHashes) || new Set(evidenceHashes).size !== evidenceHashes.length ||
        evidenceHashes.some(hash => !HASH_PATTERN.test(hash)) ||
        manifest.some(entry => !evidenceHashes.includes(entry.hash)) ||
        stableStringify(state.terminal.terminalEnvelope.payload.producedEvidenceHashes) !== stableStringify(evidenceHashes)) {
      return { valid: false, reason: 'TERMINAL_EVIDENCE_MISMATCH' }
    }
    if (sha256(stableStringify(manifest)) !== state.terminal.deliverableManifestHash) {
      return { valid: false, reason: 'TERMINAL_MANIFEST_MISMATCH' }
    }
    for (const entry of manifest) {
      let actual
      try { actual = hashFileStrict(entry.path, this.fs) } catch {
        return { valid: false, reason: 'DELIVERABLE_MISSING_OR_UNSAFE', path: entry.path }
      }
      if (actual !== entry.hash) return { valid: false, reason: 'DELIVERABLE_HASH_CHANGED', path: entry.path }
    }
    if (state.terminal.releaseIntent) {
      const intent = state.terminal.releaseIntent
      const event = this.eventLog.readAll()[intent.eventSequence - 1]
      const stateEvent = event && event.details && event.details.stateEvent
      if (!event || event.hash !== intent.eventHash || !validateCanonicalStateEvent(stateEvent) ||
          stateEvent.transitionId !== intent.transitionId || stateEvent.eventId !== intent.eventId ||
          stateEvent.toState !== 'RELEASING_LOCK' || RELEASE_INTENT_OUTCOMES[intent.transitionId] !== state.terminal.outcome ||
          intent.stateChecksum !== intent.sourceStateChecksum || !HASH_PATTERN.test(intent.sourceStateChecksum || '')) {
        return { valid: false, reason: 'TERMINAL_RELEASE_INTENT_MISMATCH' }
      }
      if (state.state === 'RELEASING_LOCK') {
        if (event.sequence !== state.sequence || event.hash !== state.lastEventHash) {
          return { valid: false, reason: 'TERMINAL_RELEASE_INTENT_MISMATCH' }
        }
      } else if (FINAL_OUTCOMES.includes(state.state)) {
        const releaseEvent = this.eventLog.readAll()[state.sequence - 1]
        const releaseStateEvent = releaseEvent && releaseEvent.details && releaseEvent.details.stateEvent
        if (!releaseEvent || releaseEvent.hash !== state.lastEventHash || state.sequence !== intent.eventSequence + 1 ||
            !validateCanonicalStateEvent(releaseStateEvent) || releaseStateEvent.fromState !== 'RELEASING_LOCK' ||
            releaseStateEvent.toState !== state.terminal.outcome ||
            releaseStateEvent.eventId !== `LOCK_RELEASED_${state.terminal.outcome}`) {
          return { valid: false, reason: 'TERMINAL_RELEASE_INTENT_MISMATCH' }
        }
      }
    }
    return { valid: true, terminal: state.terminal }
  }

  adoptCrashedGeneration(options = {}) {
    let current = this.load()
    if (current.state === 'RELEASING_LOCK') {
      fail('RELEASE_RECONCILIATION_REQUIRED', 'a crash after release intent must be reconciled by the deterministic finalizer')
    }
    if (FINAL_OUTCOMES.includes(current.state)) {
      fail('CRASH_ADOPTION_FORBIDDEN', `terminal state ${current.state} cannot be adopted`)
    }
    if (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 1) {
      fail('GENERATION_CONFLICT', 'crash adoption requires the exact prior generation')
    }
    if (current.state === 'PAUSED' && current.activation.generation === options.expectedGeneration + 1) {
      this._authorize(options.capability, 'reconcile crash adoption retry', capabilityExpectation(current))
      const recovery = normalizeRecoveryContext(current.frontier)
      if (recovery.savedState !== options.expectedSavedState ||
          !HASH_PATTERN.test(options.expectedCheckpointHash || '') ||
          recovery.checkpointHash !== options.expectedCheckpointHash) {
        fail('CRASH_ADOPTION_CONFLICT', 'persisted crash adoption differs from the retry precondition')
      }
      return current
    }
    if (typeof this.recoveryCheckpointVerifier !== 'function') {
      fail('RECOVERY_CHECKPOINT_CONFIG_INVALID', 'crash adoption requires the separate persisted recovery-checkpoint authority')
    }
    let recoveryEvidence
    try { recoveryEvidence = this.recoveryCheckpointVerifier(options.recoveryCheckpoint) } catch (error) {
      fail('CRASH_CHECKPOINT_MISMATCH', 'latest recovery checkpoint evidence failed verification', { cause: error.message })
    }
    if (!recoveryEvidence || stableStringify(recoveryEvidence) !== stableStringify(options.recoveryCheckpoint) ||
        !recoveryEvidence.record || !recoveryEvidence.snapshot ||
        recoveryEvidence.record.checkpointPayloadHash !== options.expectedCheckpointPayloadHash) {
      fail('CRASH_CHECKPOINT_MISMATCH', 'crash adoption evidence is not the exact latest checkpoint')
    }
    if (!CRASH_RECOVERY_POLICY.recoverableActiveStates.includes(current.state)) {
      fail('CRASH_ADOPTION_FORBIDDEN', `state ${current.state} is not a canonical crash-adoption source`)
    }
    if (options.expectedSavedState !== current.state) {
      fail('CRASH_PRECONDITION_MISMATCH', 'crash adoption expected state differs from the persisted state')
    }
    if (current.activation.generation !== options.expectedGeneration) {
      fail('GENERATION_CONFLICT', 'persisted runtime generation changed before crash adoption')
    }
    const expectedPrecondition = runtimeCrashPrecondition(current)
    if (!options.precondition || stableStringify(options.precondition) !== stableStringify(expectedPrecondition)) {
      fail('CRASH_PRECONDITION_MISMATCH', 'crash adoption does not bind the exact persisted runtime checkpoint')
    }
    const binding = this._authorize(
      options.capability,
      'adopt crashed generation',
      capabilityExpectation(current, current.activation.generation + 1),
    )
    const priorOwner = this._crashPriorOwner(binding.takeover, current)
    const record = recoveryEvidence.record
    const journalCheckpoint = record.checkpoint
    const authority = record.authority
    if (!journalCheckpoint || !authority || record.checkpointPayloadHash !== options.expectedCheckpointPayloadHash ||
        recoveryEvidence.snapshot.checkpointPayloadHash !== record.checkpointPayloadHash ||
        recoveryEvidence.snapshot.lastCheckpointSequence !== record.sequence ||
        recoveryEvidence.snapshot.lastCheckpointHash !== record.entryHash ||
        authority.runId !== current.runId || authority.activationId !== current.activation.id ||
        authority.activationNonce !== current.activation.nonce || authority.missionHash !== current.activation.missionHash ||
        authority.targetIdentity !== current.targetIdentity || authority.generation !== current.activation.generation ||
        journalCheckpoint.stateEvent.sequence !== current.sequence ||
        journalCheckpoint.stateEvent.eventHash !== current.lastEventHash ||
        journalCheckpoint.stateEvent.state !== current.state || journalCheckpoint.stateEvent.stateChecksum !== current.checksum ||
        journalCheckpoint.immutableHashes.requestEnvelopeHash !== current.requestEnvelopeHash ||
        journalCheckpoint.immutableHashes.candidateHash !== (current.candidateHash || null) ||
        !journalCheckpoint.recovery.frontier.acceptedResultIds.includes(journalCheckpoint.scheduler.stateHash)) {
      fail('CRASH_CHECKPOINT_MISMATCH', 'latest recovery checkpoint is foreign, stale, or does not bind the exact runtime and scheduler frontier')
    }
    let checkpoint
    try { checkpoint = prepareCrashCheckpoint(journalCheckpoint.recovery) } catch (error) {
      fail('CRASH_CHECKPOINT_MISMATCH', 'journal recovery projection is invalid', { cause: error.message })
    }
    const checkpointProjection = { ...checkpoint }
    delete checkpointProjection.schemaVersion
    if (stableStringify(checkpointProjection) !== stableStringify(journalCheckpoint.recovery) || checkpoint.savedState !== current.state) {
      fail('CRASH_CHECKPOINT_MISMATCH', 'journal recovery binding or saved state changed')
    }
    const accounting = journalCheckpoint.accounting
    if (!accounting || !HASH_PATTERN.test(accounting.snapshotHash || '') ||
        !Number.isSafeInteger(accounting.lastAccountingSequence) || accounting.lastAccountingSequence < 1 ||
        !HASH_PATTERN.test(accounting.lastAccountingHash || '')) {
      fail('ACCOUNTING_CHECKPOINT_INVALID', 'journal checkpoint lacks exact persisted accounting evidence')
    }
    const recoveryContext = {
      savedState: checkpoint.savedState,
      resumeState: checkpoint.resumeState,
      checkpointHash: '0'.repeat(64),
      frontierHash: recoveryFrontierHash(checkpoint.frontier),
      frontier: checkpoint.frontier,
      completedMilestones: checkpoint.completedMilestones,
      priorOwner,
      externalRecovery: checkpoint.externalRecovery,
      releaseIntentHash: checkpoint.releaseIntentHash,
      accountingCheckpoint: {
        snapshotHash: accounting.snapshotHash,
        lastAccountingSequence: accounting.lastAccountingSequence,
        lastAccountingHash: accounting.lastAccountingHash,
      },
    }
    recoveryContext.checkpointHash = recoveryCheckpointHash(recoveryContext)
    const normalizedRecovery = normalizeRecoveryContext(recoveryContext)
    current = this.transition('PAUSED', {
      capability: options.capability,
      cause: requireString(options.cause, 'crash adoption cause'),
      eventId: 'CRASH_DETECTED',
      expectedCapabilityGeneration: current.activation.generation + 1,
      statePatch: {
        activation: { ...current.activation, generation: current.activation.generation + 1 },
      },
      [INTERNAL]: true,
      recoveryContext: normalizedRecovery,
      workHashes: checkpoint.frontier.acceptedResultIds.filter((value) => HASH_PATTERN.test(value)),
      checkHashes: checkpoint.externalRecovery.receiptHashes,
      openIds: [...new Set([...checkpoint.frontier.nextReadyWorkIds, ...checkpoint.frontier.openCheckIds])],
      details: {
        crashAdoption: {
          priorGeneration: options.expectedGeneration,
          checkpointBindingHash: checkpoint.bindingHash,
          checkpointPayloadHash: record.checkpointPayloadHash,
          accountingSnapshotHash: accounting.snapshotHash,
          takeoverReceiptHash: binding.takeover.receiptHash,
        },
        recoveryContext: normalizedRecovery,
      },
    })
    return current
  }

  prepareReleaseReconciliation() {
    const current = this.load()
    const evidence = releaseReconciliationEvidence(current, this.eventLog)
    if (current.terminal) {
      const validation = this.validateTerminal(current)
      if (!validation.valid) {
        fail('RELEASE_INTENT_INVALID', `persisted release terminal is invalid: ${validation.reason}`)
      }
    }
    return evidence
  }

  adoptReleaseReconciliation(options = {}) {
    const current = this.load()
    if (current.state !== 'RELEASING_LOCK') {
      fail('RELEASE_RECONCILIATION_REQUIRED', `release reconciliation is forbidden in ${current.state}`)
    }
    if (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 1 ||
        current.activation.generation !== options.expectedGeneration) {
      fail('GENERATION_CONFLICT', 'release reconciliation requires the exact prior runtime generation')
    }
    const expectedEvidence = this.prepareReleaseReconciliation()
    if (!options.evidence || stableStringify(options.evidence) !== stableStringify(expectedEvidence)) {
      fail('RELEASE_RECONCILIATION_MISMATCH', 'release reconciliation does not bind the exact persisted intent, outcome, and state')
    }
    const binding = this._authorize(
      options.capability,
      'adopt release reconciliation',
      capabilityExpectation(current, current.activation.generation + 1),
    )
    const priorOwner = binding.takeover
      ? this._crashPriorOwner(binding.takeover, current)
      : this._releasedPriorOwner(binding.predecessorRelease, current, expectedEvidence)
    if (priorOwner.processesDrained !== true ||
        !HASH_PATTERN.test(priorOwner.staleOwnerEvidenceHash || '') ||
        !HASH_PATTERN.test(priorOwner.processDrainEvidenceHash || '')) {
      fail('CRASH_OWNER_UNVERIFIED', 'release reconciliation lacks durable owner-death and descendant-drain evidence')
    }
    if (current.terminal) {
      const validation = this.validateTerminal(current)
      if (!validation.valid || current.terminal.outcome !== expectedEvidence.outcome) {
        fail('RELEASE_INTENT_INVALID', `release reconciliation terminal is invalid: ${validation.reason || 'outcome mismatch'}`)
      }
    }
    const unsigned = { ...current }
    delete unsigned.checksum
    const next = canonicalize({
      ...unsigned,
      activation: {
        ...current.activation,
        generation: current.activation.generation + 1,
        status: 'RELEASING',
      },
    })
    const written = this._write(next)
    const unchangedFields = Object.keys(unsigned).filter((field) => field !== 'activation')
    if (unchangedFields.some((field) => stableStringify(written[field]) !== stableStringify(current[field])) ||
        written.state !== 'RELEASING_LOCK' || written.sequence !== current.sequence ||
        written.lastEventHash !== current.lastEventHash) {
      fail('RUN_RECORD_FAILURE', 'release reconciliation changed canonical work, frontier, terminal, or event authority')
    }
    return written
  }

  acceptResumeCapabilities(options = {}) {
    const current = this.load()
    if (current.state !== 'CHECK_PROVIDER_CAPABILITIES') {
      fail('RESUME_STATE_INVALID', `resume capabilities cannot be accepted from ${current.state}`)
    }
    this._authorize(options.capability, 'accept resume provider capabilities', capabilityExpectation(current))
    const recoveryContext = normalizeRecoveryContext(current.frontier)
    return this.transition('RESUME_EXACT_STATE', {
      capability: options.capability,
      cause: requireString(options.cause, 'resume capability cause'),
      eventId: 'PROVIDER_CAPABILITIES_ACCEPTED_FOR_RESUME',
      recoveryContext,
      details: { recoveryContext },
    })
  }

  restoreExactState(options = {}) {
    const current = this.load()
    if (current.state !== 'RESUME_EXACT_STATE') {
      fail('RESUME_STATE_INVALID', `exact state cannot be restored from ${current.state}`)
    }
    this._authorize(options.capability, 'restore exact crash checkpoint', capabilityExpectation(current))
    const recoveryContext = normalizeRecoveryContext(current.frontier)
    const abandonedMutation = current.activeMutation ? canonicalize({
      permitId: current.activeMutation.id,
      isolationBindingHash: current.activeMutation.isolationBindingHash || null,
      priorGeneration: current.activation.generation - 1,
      staleOwnerEvidenceHash: recoveryContext.priorOwner.staleOwnerEvidenceHash,
      processDrainEvidenceHash: recoveryContext.priorOwner.processDrainEvidenceHash,
    }) : null
    return this.transition(recoveryContext.resumeState, {
      capability: options.capability,
      cause: requireString(options.cause, 'exact restore cause'),
      eventId: 'EXACT_STATE_RESTORED',
      statePatch: {
        activation: { ...current.activation, status: 'ACTIVE' },
        frontier: null,
        // Crash adoption proves the prior owner is dead and every owned
        // descendant is drained.  Its permit cannot be resumed by the new
        // generation; revoke it atomically while retaining the bumped epoch.
        ...(abandonedMutation ? { activeMutation: null } : {}),
      },
      [INTERNAL]: true,
      recoveryContext,
      openIds: [...new Set([...recoveryContext.frontier.nextReadyWorkIds, ...recoveryContext.frontier.openCheckIds])],
      details: {
        recoveryContext,
        ...(abandonedMutation ? { abandonedMutation } : {}),
      },
    })
  }

  _crashPriorOwner(takeover, current) {
    let verifiedTakeover
    try { verifiedTakeover = validateTakeoverReceipt(takeover) } catch {}
    if (!verifiedTakeover ||
        verifiedTakeover.runId !== current.runId || verifiedTakeover.activationId !== current.activation.id ||
        verifiedTakeover.missionHash !== current.activation.missionHash || verifiedTakeover.nonce !== current.activation.nonce ||
        verifiedTakeover.generation !== current.activation.generation || verifiedTakeover.targetIdentity !== current.targetIdentity ||
        verifiedTakeover.ownerProcessVerifiedDead !== true || verifiedTakeover.descendantsVerifiedDrained !== true) {
      fail('CRASH_OWNER_UNVERIFIED', 'new generation capability lacks exact stale-owner and descendant-drain evidence')
    }
    const processDrainEvidenceHash = sha256(stableStringify({
      persistedOwnedProcessIdentities: verifiedTakeover.persistedOwnedProcessIdentities,
      ownedIdentityEvidence: verifiedTakeover.ownedIdentityEvidence,
      ownerProcessVerifiedDead: verifiedTakeover.ownerProcessVerifiedDead,
      descendantsVerifiedDrained: verifiedTakeover.descendantsVerifiedDrained,
    }))
    return canonicalize({
      ownerId: verifiedTakeover.priorLeaseId,
      staleOwnerEvidenceHash: verifiedTakeover.receiptHash,
      processesDrained: true,
      processDrainEvidenceHash,
    })
  }

  _releasedPriorOwner(predecessorRelease, current, evidence) {
    let receipt
    try { receipt = validatePredecessorRelease(predecessorRelease) } catch {}
    if (!receipt || receipt.runId !== current.runId || receipt.activationId !== current.activation.id ||
        receipt.missionHash !== current.activation.missionHash || receipt.nonce !== current.activation.nonce ||
        receipt.generation !== current.activation.generation || receipt.targetIdentity !== current.targetIdentity ||
        receipt.releaseIntentHash !== evidence.releaseIntentHash || receipt.outcome !== evidence.outcome ||
        receipt.stateChecksum !== evidence.stateChecksum || receipt.stateEventSequence !== evidence.stateEventSequence ||
        receipt.stateEventHash !== evidence.stateEventHash || receipt.processesDrained !== true) {
      fail('CRASH_OWNER_UNVERIFIED', 'new generation capability lacks an exact predecessor-release receipt')
    }
    const processDrainEvidenceHash = sha256(stableStringify({
      persistedOwnedProcessIdentities: receipt.persistedOwnedProcessIdentities,
      ownedIdentityEvidence: receipt.ownedIdentityEvidence,
      processesDrained: receipt.processesDrained,
    }))
    return canonicalize({
      ownerId: receipt.priorLeaseId,
      staleOwnerEvidenceHash: receipt.receiptHash,
      processesDrained: true,
      processDrainEvidenceHash,
    })
  }

  resumeGeneration(options = {}) {
    const current = this.load()
    if (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration !== current.activation.generation) {
      fail('GENERATION_CONFLICT', 'resume generation does not match persisted activation')
    }
    if (current.state !== 'PAUSED') {
      fail('RESUME_AFTER_TERMINAL', `generation resume is forbidden in ${current.state}`)
    }
    let crashRecovery = null
    try { crashRecovery = normalizeRecoveryContext(current.frontier) } catch {}
    if (crashRecovery) {
      this._authorize(options.capability, 'resume adopted crash generation', capabilityExpectation(current))
      return this.transition('CHECK_PROVIDER_CAPABILITIES', {
        capability: options.capability,
        cause: requireString(options.cause, 'resume cause'),
        eventId: 'RESUME_REQUESTED',
        statePatch: { activation: { ...current.activation, status: 'RESUMING' } },
        [INTERNAL]: true,
        details: {
          previousGeneration: current.activation.generation - 1,
          adoptedGeneration: current.activation.generation,
          recoveryContext: crashRecovery,
        },
      })
    }
    this._authorize(
      options.capability,
      'resume generation',
      capabilityExpectation(current, current.activation.generation + 1),
    )
    const next = this._patched(current, {
      activation: { ...current.activation, generation: current.activation.generation + 1, status: 'RESUMING' },
      budgets: options.budgets === undefined ? current.budgets : options.budgets,
      retryState: {
        ...current.retryState,
        pendingRequest: null,
        generationResumedFrom: current.activation.generation,
      },
    }, true)
    next.updatedAt = String(this.clock())
    return this.transition('CHECK_PROVIDER_CAPABILITIES', {
      capability: options.capability,
      cause: requireString(options.cause, 'resume cause'),
      eventId: 'RESUME_REQUESTED',
      expectedCapabilityGeneration: current.activation.generation + 1,
      statePatch: {
        activation: next.activation,
        budgets: next.budgets,
        retryState: next.retryState,
      },
      [INTERNAL]: true,
      details: { previousGeneration: current.activation.generation, frontier: current.frontier },
    })
  }

  _patched(current, patch, internal = false) {
    if (!patch) {
      const unsigned = { ...current }
      delete unsigned.checksum
      return canonicalize(unsigned)
    }
    const forbidden = [
      'schemaVersion', 'runId', 'requestEnvelopeHash', 'targetIdentity',
      'openedDirectoryIdentity', 'digests', 'sequence', 'lastEventHash', 'createdAt', 'checksum',
    ]
    if (!internal) forbidden.push('activation', 'state', 'workspaceEpoch', 'terminal', 'activeMutation')
    for (const key of forbidden) {
      if (Object.hasOwn(patch, key)) fail('IMMUTABLE_STATE_FIELD', `state patch cannot change ${key}`)
    }
    const unsigned = { ...current }
    delete unsigned.checksum
    return canonicalize({ ...unsigned, ...patch })
  }

  _write(state) {
    const unsigned = { ...state }
    delete unsigned.checksum
    try {
      return atomicWriteJson(this.statePath, unsigned, {
        fsImpl: this.fs,
        beforeCommit: this.beforeCommit,
      })
    } catch (error) {
      fail('RUN_RECORD_FAILURE', `atomic runtime-state write failed: ${this.statePath}`, {
        cause: error.message,
      })
    }
  }

  _commit(next, eventInput, current) {
    const durableEventInput = JSON.parse(JSON.stringify(eventInput))
    const transaction = {
      schemaVersion: STATE_SCHEMA_VERSION,
      expectedSequence: current ? current.sequence : 0,
      expectedStateChecksum: current ? current.checksum : null,
      next,
      eventInput: durableEventInput,
    }
    atomicWriteJson(this.registeredPaths.transactionPath, transaction, { fsImpl: this.fs })
    let event
    try {
      event = this.eventLog.append(durableEventInput)
      next.sequence = event.sequence
      next.lastEventHash = event.hash
      const written = this._write(next)
      this.fs.unlinkSync(this.registeredPaths.transactionPath)
      return written
    } catch (error) {
      throw error
    }
  }

  _recoverTransaction() {
    const transactionPath = this.registeredPaths.transactionPath
    if (!this.fs.existsSync(transactionPath)) return
    let transaction
    try { transaction = readChecksummedJson(transactionPath, { fsImpl: this.fs }) } catch (error) {
      fail('RUN_RECORD_FAILURE', 'runtime transition journal is invalid', { cause: error.message })
    }
    if (transaction.schemaVersion !== STATE_SCHEMA_VERSION || !Number.isSafeInteger(transaction.expectedSequence) ||
        !transaction.next || !transaction.eventInput) {
      fail('RUN_RECORD_FAILURE', 'runtime transition journal schema is invalid')
    }
    let state = null
    if (this.fs.existsSync(this.statePath)) {
      try { state = readChecksummedJson(this.statePath, { fsImpl: this.fs }) } catch (error) {
        fail('RUN_RECORD_FAILURE', 'runtime state is invalid during transition recovery', { cause: error.message })
      }
    }
    let events
    try { events = this.eventLog.readAll() } catch (error) {
      fail('RUN_RECORD_FAILURE', 'event log is invalid during transition recovery', { cause: error.message })
    }
    if (state && state.sequence === transaction.expectedSequence + 1 && events.length === state.sequence &&
        state.lastEventHash === events.at(-1).hash) {
      this.fs.unlinkSync(transactionPath)
      return
    }
    if ((state ? state.sequence : 0) !== transaction.expectedSequence ||
        (state ? state.checksum : null) !== transaction.expectedStateChecksum) {
      fail('RUN_RECORD_FAILURE', 'transition journal does not bind the last valid state')
    }
    if (events.length === transaction.expectedSequence) {
      this.fs.unlinkSync(transactionPath)
      return
    }
    if (events.length !== transaction.expectedSequence + 1) {
      fail('RUN_RECORD_FAILURE', 'transition journal cannot reconcile event sequence')
    }
    const event = events.at(-1)
    if (event.type !== transaction.eventInput.type || event.stateBefore !== transaction.eventInput.stateBefore ||
        event.stateAfter !== transaction.eventInput.stateAfter) {
      fail('RUN_RECORD_FAILURE', 'transition journal does not bind the appended event')
    }
    const recovered = { ...transaction.next, sequence: event.sequence, lastEventHash: event.hash }
    this._write(recovered)
    this.fs.unlinkSync(transactionPath)
  }

  _validateState(state) {
    if (state.schemaVersion !== STATE_SCHEMA_VERSION || !STATES.includes(state.state)) {
      fail('CONTRACT_UPGRADE_REQUIRED', 'runtime state schema or state is not supported')
    }
    validateInitial(state)
    if (!Number.isSafeInteger(state.sequence) || state.sequence < 0 ||
        !Number.isSafeInteger(state.workspaceEpoch) || state.workspaceEpoch < 0 ||
        !(state.sequence === 0 ? state.lastEventHash === null : HASH_PATTERN.test(state.lastEventHash || '')) ||
        !(state.candidateHash === null || HASH_PATTERN.test(state.candidateHash || '')) ||
        (state.terminal !== null && !validateCanonicalTerminalOutcome(state.terminal.terminalEnvelope))) {
      fail('RUN_RECORD_FAILURE', 'runtime state counters or event binding are invalid')
    }
    for (const field of ['runId', 'requestEnvelopeHash', 'targetIdentity', 'openedDirectoryIdentity']) {
      if (state[field] !== this.eventLog.binding[field]) fail('RUN_RECORD_FAILURE', `state has foreign ${field}`)
    }
    if (stableStringify(state.digests) !== stableStringify(this.eventLog.binding.digests)) {
      fail('CONTRACT_UPGRADE_REQUIRED', 'runtime interpretation digests changed')
    }
  }

  _authorize(capability, action, expected) {
    try {
      const binding = this.capabilityVerifier(capability)
      if (!validateCapabilityBinding(binding, expected)) throw new Error('capability binding does not match runtime state')
      return binding
    } catch (error) {
      fail('LEASE_CAPABILITY_REQUIRED', `opaque live lease capability required to ${action}`, { cause: error.message })
    }
  }
}

function isLegalTransition(from, to, eventType) {
  if (!STATES.includes(from) || !STATES.includes(to)) return false
  return matchingTransitions(from, to, eventType).length > 0
}

module.exports = {
  CRASH_PRECONDITION_FIELDS,
  CRASH_RECOVERY_POLICY,
  FINAL_OUTCOMES,
  CAPABILITY_BINDING_FIELDS,
  CANONICAL_TRANSITIONS,
  HALTED_BEFORE_LEASE,
  LEGAL_TRANSITIONS,
  NONCE_PATTERN,
  RESUMABLE_STATES,
  RELEASE_INTENT_OUTCOMES,
  EVIDENCE_INPUT_IDS,
  INDEPENDENT_VERDICT_IDS,
  RuntimeStateError,
  RuntimeStateStore,
  STATES,
  STATE_SCHEMA_VERSION,
  TERMINAL_STATES,
  hashFileStrict,
  capabilityExpectation,
  isLegalTransition,
  createEvidenceInvalidationGraph,
  executeEvidenceInvalidation,
  normalizeManifest,
  normalizeRecoveryContext,
  prepareCrashCheckpoint,
  recoveryCheckpointHash,
  recoveryFrontierHash,
  resolveCanonicalTransition,
  runtimeCrashPrecondition,
  releaseReconciliationEvidence,
  validateCapabilityBinding,
  validateCanonicalStateEvent,
  validateCanonicalTerminalOutcome,
  validateEvidenceInvalidationGraph,
  terminalProducedEvidenceHashes,
}
