#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  atomicWriteFile,
  canonicalize,
  fsyncDirectory,
  sha256,
  stableStringify,
} = require('./event-log.js')
const {
  FILE_MODE,
  pathIsInside,
  readFileNoFollow,
  withOwnedLock,
} = require('./safe-run-root.js')
const { prepareCrashCheckpoint } = require('./runtime-state.js')
const { validateTakeoverReceipt } = require('./mission-lock.js')

const RECORD_SCHEMA = require('../../contracts/schemas/recovery-checkpoint-record.schema.json')
const SNAPSHOT_SCHEMA = require('../../contracts/schemas/recovery-checkpoint-snapshot.schema.json')

const SCHEMA_VERSION = '2.0.0'
const HASH_PATTERN = /^[a-f0-9]{64}$/
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const CAUSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CAUSE_KINDS = Object.freeze([
  'CHECKPOINT', 'ADMISSION', 'LEASE_STARTED', 'THREAD_STARTED', 'CONTINUATION_BOUND',
  'USAGE_RECORDED', 'LEASE_COMPLETED', 'CHECK_COMPLETED', 'CANDIDATE_FROZEN',
  'EXTERNAL_OPERATION', 'FRONTIER_CHANGED', 'RESULT_COMMITTED', 'CRASH_RECOVERY',
  'ROADMAP_RATIO_RECORDED', 'PLAN_PROJECTION_COMMITTED',
])
const RESULT_COMMIT_FIELDS = Object.freeze([
  'assignmentId', 'assignmentHash', 'leaseId', 'sessionId', 'continuationId',
  'resultHash', 'receiptHash', 'candidateHash',
])
const SCHEDULER_FRONTIER_FIELDS = Object.freeze([
  'route', 'phase', 'candidate', 'completedWorkIds', 'completedCheckIds', 'openCheckIds',
  'nextReadyWorkIds', 'leases', 'usage', 'reserves',
])
const AUTHORITY_FIELDS = Object.freeze([
  'runId', 'activationId', 'activationNonce', 'generation', 'missionHash', 'targetIdentity',
  'targetIdentityHash', 'providerCapabilitiesHash',
])
const RECOVERY_FIELDS = Object.freeze([
  'savedState', 'resumeState', 'frontier', 'completedMilestones', 'externalRecovery', 'releaseIntentHash',
])

if (RECORD_SCHEMA.properties.schemaVersion.const !== SCHEMA_VERSION ||
    SNAPSHOT_SCHEMA.properties.schemaVersion.const !== SCHEMA_VERSION) {
  throw new Error('canonical recovery checkpoint schemas are incompatible')
}

class RecoveryCheckpointError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RecoveryCheckpointError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new RecoveryCheckpointError(code, message, details)
}

function exactKeys(value, fields) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)))
}

function uniqueStrings(value, field, options = {}) {
  if (!Array.isArray(value) || new Set(value).size !== value.length ||
      value.some((entry) => typeof entry !== 'string' || !entry || (options.hash && !HASH_PATTERN.test(entry)))) {
    fail('RECOVERY_CHECKPOINT_INVALID', `${field} must be a unique ${options.hash ? 'sha256 ' : ''}string array`)
  }
  return value
}

function validateUsage(value, field) {
  const fields = ['noncachedInput', 'cachedInput', 'output', 'reasoning', 'weightedCost', 'latencyMs', 'workMs']
  if (!exactKeys(value, fields) || fields.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) {
    fail('RECOVERY_CHECKPOINT_INVALID', `${field} is not canonical usage accounting`)
  }
  return value
}

function recoveryCheckpointPayloadHash(checkpoint) {
  return sha256(stableStringify(checkpoint))
}

function recoveryCheckpointEntryHash(record) {
  const unsigned = { ...record }
  delete unsigned.entryHash
  return sha256(stableStringify(unsigned))
}

function recoveryCheckpointSnapshotHash(snapshot) {
  const unsigned = { ...snapshot }
  delete unsigned.snapshotHash
  return sha256(stableStringify(unsigned))
}

function recoveryAuthorityBindingHash(authority) {
  const unsigned = { ...authority }
  delete unsigned.capabilityBindingHash
  return sha256(stableStringify(unsigned))
}

function schedulerFrontierHash(scheduler) {
  const frontier = {}
  for (const field of SCHEDULER_FRONTIER_FIELDS) frontier[field] = scheduler[field]
  return sha256(stableStringify(frontier))
}

function recoveryBindingHash(recovery) {
  const unsigned = { ...recovery }
  delete unsigned.bindingHash
  return sha256(stableStringify(unsigned))
}

function prepareSchedulerCheckpoint(input = {}) {
  const state = input.state
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler checkpoint requires its complete canonical state object')
  }
  const stateWithoutHash = canonicalize({ ...state })
  delete stateWithoutHash.stateHash
  for (const field of ['ownerSessionId', ...SCHEDULER_FRONTIER_FIELDS]) stateWithoutHash[field] = canonicalize(input[field])
  const stateBytes = Buffer.from(stableStringify(stateWithoutHash), 'utf8')
  const scheduler = canonicalize({
    encoding: 'stable-json-v1-without-stateHash+base64',
    stateBytesBase64: stateBytes.toString('base64'),
    stateByteLength: stateBytes.length,
    stateHash: sha256(stateBytes),
    frontierHash: '0'.repeat(64),
    ownerSessionId: input.ownerSessionId,
    route: input.route,
    phase: input.phase,
    candidate: input.candidate,
    completedWorkIds: input.completedWorkIds,
    completedCheckIds: input.completedCheckIds,
    openCheckIds: input.openCheckIds,
    nextReadyWorkIds: input.nextReadyWorkIds,
    leases: input.leases,
    usage: input.usage,
    reserves: input.reserves,
  })
  scheduler.frontierHash = schedulerFrontierHash(scheduler)
  validateScheduler(scheduler)
  return Object.freeze(scheduler)
}

function decodeSchedulerCheckpoint(scheduler) {
  validateScheduler(scheduler)
  const parsed = JSON.parse(Buffer.from(scheduler.stateBytesBase64, 'base64').toString('utf8'))
  return Object.freeze(canonicalize({ ...parsed, stateHash: scheduler.stateHash }))
}

function validateCandidate(value) {
  if (!exactKeys(value, ['candidateId', 'candidateHash', 'frozen']) ||
      !(value.candidateId === null || (typeof value.candidateId === 'string' && value.candidateId)) ||
      !(value.candidateHash === null || HASH_PATTERN.test(value.candidateHash || '')) || typeof value.frozen !== 'boolean' ||
      (value.candidateHash === null && (value.candidateId !== null || value.frozen)) ||
      (value.frozen && (!value.candidateId || !value.candidateHash))) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler exact-version binding is invalid')
  }
}

function validateLease(lease, index) {
  const fields = [
    'leaseId', 'workItemId', 'roleId', 'status', 'parentLeaseId', 'reservationId', 'sessionId',
    'continuationId', 'crashBindingHash', 'resources', 'usage', 'reserves', 'thread',
  ]
  if (!exactKeys(lease, fields) || !['ADMITTED', 'OPEN'].includes(lease.status) ||
      ['leaseId', 'workItemId', 'roleId'].some((field) => typeof lease[field] !== 'string' || !lease[field]) ||
      ['parentLeaseId', 'reservationId', 'sessionId', 'continuationId'].some((field) =>
        !(lease[field] === null || (typeof lease[field] === 'string' && lease[field]))) ||
      !(lease.crashBindingHash === null || HASH_PATTERN.test(lease.crashBindingHash || '')) || !Array.isArray(lease.resources) ||
      !exactKeys(lease.thread, ['started', 'startedEventHash', 'startedAt']) || typeof lease.thread.started !== 'boolean') {
    fail('RECOVERY_CHECKPOINT_INVALID', `scheduler lease ${index} is invalid`)
  }
  for (const resource of lease.resources) {
    if (!exactKeys(resource, ['id', 'kind', 'mode', 'isolationId']) || typeof resource.id !== 'string' || !resource.id ||
        !['workspace', 'cache', 'generated', 'temporary', 'database', 'service', 'port', 'generic'].includes(resource.kind) ||
        !['read', 'exclusive'].includes(resource.mode) ||
        !(resource.isolationId === null || (typeof resource.isolationId === 'string' && resource.isolationId))) {
      fail('RECOVERY_CHECKPOINT_INVALID', `scheduler lease ${index} resource is invalid`)
    }
  }
  validateUsage(lease.usage, `scheduler lease ${index} usage`)
  validateUsage(lease.reserves, `scheduler lease ${index} reserves`)
  if (lease.thread.started) {
    if (!HASH_PATTERN.test(lease.thread.startedEventHash || '') || Number.isNaN(Date.parse(lease.thread.startedAt))) {
      fail('RECOVERY_CHECKPOINT_INVALID', `scheduler lease ${index} started thread evidence is invalid`)
    }
  } else if (lease.thread.startedEventHash !== null || lease.thread.startedAt !== null) {
    fail('RECOVERY_CHECKPOINT_INVALID', `scheduler lease ${index} unstarted thread has evidence`)
  }
  if (lease.status === 'OPEN' && (!lease.reservationId || !lease.sessionId || !lease.crashBindingHash || !lease.thread.started)) {
    fail('RECOVERY_CHECKPOINT_INVALID', `open scheduler lease ${index} is not durably identified`)
  }
}

function journalResourceClaim(resource) {
  const pathKind = ['workspace', 'cache', 'generated', 'temporary'].includes(resource.kind)
  const prefix = `${resource.kind}:`
  let physicalId = resource.id.startsWith(prefix) ? resource.id.slice(prefix.length) : resource.id
  if (pathKind) {
    physicalId = path.resolve(physicalId)
    try { physicalId = fs.realpathSync.native(physicalId) } catch {}
    if (process.platform === 'win32') physicalId = physicalId.toLowerCase()
  } else if (resource.kind === 'port') {
    const port = Number(physicalId)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail('RECOVERY_CHECKPOINT_INVALID', `invalid port resource: ${resource.id}`)
    }
    physicalId = String(port)
  }
  return {
    baseKey: resource.kind === 'generic' ? physicalId : `${resource.kind}:${physicalId}`,
    pathKind,
    physicalId,
    mode: resource.mode,
  }
}

function journalResourcesConflict(left, right) {
  if (left.mode === 'read' && right.mode === 'read') return false
  if (left.baseKey === right.baseKey) return true
  if (!left.pathKind || !right.pathKind) return false
  const inside = (parent, child) => {
    const relative = path.relative(parent, child)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  }
  return inside(left.physicalId, right.physicalId) || inside(right.physicalId, left.physicalId)
}

function validateScheduler(scheduler) {
  const fields = [
    'encoding', 'stateBytesBase64', 'stateByteLength', 'stateHash', 'frontierHash', 'ownerSessionId',
    ...SCHEDULER_FRONTIER_FIELDS,
  ]
  if (!exactKeys(scheduler, fields) || scheduler.encoding !== 'stable-json-v1-without-stateHash+base64' ||
      typeof scheduler.ownerSessionId !== 'string' || !scheduler.ownerSessionId ||
      !['PENDING', 'DIRECT', 'LIGHT', 'ROADMAP'].includes(scheduler.route) || !/^[A-Z][A-Z0-9_]+$/.test(scheduler.phase || '') ||
      !Array.isArray(scheduler.leases)) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler checkpoint shape is invalid')
  }
  const preRoutePhases = ['START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION']
  if ((scheduler.route === 'PENDING') !== preRoutePhases.includes(scheduler.phase) ||
      (scheduler.route === 'PENDING' && (scheduler.candidate.candidateId !== null ||
        scheduler.candidate.candidateHash !== null || scheduler.candidate.frozen))) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler PENDING route is allowed only before the route decision')
  }
  for (const field of ['completedWorkIds', 'completedCheckIds', 'openCheckIds', 'nextReadyWorkIds']) uniqueStrings(scheduler[field], `scheduler.${field}`)
  validateCandidate(scheduler.candidate)
  validateUsage(scheduler.usage, 'scheduler usage')
  validateUsage(scheduler.reserves, 'scheduler reserves')
  scheduler.leases.forEach(validateLease)
  if (new Set(scheduler.leases.map((lease) => lease.leaseId)).size !== scheduler.leases.length) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler lease identities must be unique')
  }
  let bytes
  try { bytes = Buffer.from(scheduler.stateBytesBase64, 'base64') } catch {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler state is not base64')
  }
  if (bytes.length < 2 || bytes.length !== scheduler.stateByteLength || sha256(bytes) !== scheduler.stateHash ||
      bytes.toString('base64') !== scheduler.stateBytesBase64) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler state bytes, length, or hash do not agree')
  }
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler state bytes are not JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.hasOwn(parsed, 'stateHash') ||
      stableStringify(parsed) !== bytes.toString('utf8') || scheduler.frontierHash !== schedulerFrontierHash(scheduler)) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler state or next ready work is not canonical')
  }
  for (const field of ['ownerSessionId', ...SCHEDULER_FRONTIER_FIELDS]) {
    if (stableStringify(parsed[field]) !== stableStringify(scheduler[field])) {
      fail('RECOVERY_CHECKPOINT_INVALID', `scheduler state bytes disagree with ${field}`)
    }
  }
  return scheduler
}

function prepareRecovery(input) {
  const prepared = prepareCrashCheckpoint(input)
  const recovery = {}
  for (const field of RECOVERY_FIELDS) recovery[field] = prepared[field]
  recovery.bindingHash = prepared.bindingHash
  return canonicalize(recovery)
}

function validateExternalOperations(operations) {
  if (!Array.isArray(operations) || new Set(operations.map((entry) => entry && entry.operationId)).size !== operations.length) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'external operations must have unique identities')
  }
  const fields = [
    'operationId', 'status', 'idempotencyKey', 'prepareReceiptHash', 'commitReceiptHash',
    'reconcileReceiptHash', 'rollbackReceiptHash', 'nextAction',
  ]
  for (const operation of operations) {
    if (!exactKeys(operation, fields) || typeof operation.operationId !== 'string' || !operation.operationId ||
        typeof operation.idempotencyKey !== 'string' || !operation.idempotencyKey ||
        !['PREPARED', 'COMMITTING', 'COMMITTED_UNRECONCILED', 'RECONCILED', 'ROLLED_BACK'].includes(operation.status) ||
        !['COMMIT', 'RECONCILE', 'ROLLBACK', 'NONE'].includes(operation.nextAction) ||
        ['prepareReceiptHash', 'commitReceiptHash', 'reconcileReceiptHash', 'rollbackReceiptHash'].some((field) =>
          !(operation[field] === null || HASH_PATTERN.test(operation[field] || '')))) {
      fail('RECOVERY_CHECKPOINT_INVALID', 'external operation is invalid')
    }
    if (operation.status === 'PREPARED' && (!operation.prepareReceiptHash || !['COMMIT', 'ROLLBACK'].includes(operation.nextAction))) fail('RECOVERY_CHECKPOINT_INVALID', 'prepared external operation is incomplete')
    if (['COMMITTING', 'COMMITTED_UNRECONCILED'].includes(operation.status) && (!operation.prepareReceiptHash || !['RECONCILE', 'ROLLBACK'].includes(operation.nextAction))) fail('RECOVERY_CHECKPOINT_INVALID', 'committing external operation is incomplete')
    if (operation.status === 'COMMITTED_UNRECONCILED' && !operation.commitReceiptHash) fail('RECOVERY_CHECKPOINT_INVALID', 'committed operation lacks its receipt')
    if (operation.status === 'RECONCILED' && (!operation.commitReceiptHash || !operation.reconcileReceiptHash || operation.nextAction !== 'NONE')) fail('RECOVERY_CHECKPOINT_INVALID', 'reconciled operation evidence is incomplete')
    if (operation.status === 'ROLLED_BACK' && (!operation.rollbackReceiptHash || operation.nextAction !== 'NONE')) fail('RECOVERY_CHECKPOINT_INVALID', 'rolled-back operation evidence is incomplete')
  }
  return operations
}

function validateCheckpointPayload(checkpoint) {
  if (!exactKeys(checkpoint, ['stateEvent', 'accounting', 'scheduler', 'recovery', 'immutableHashes', 'externalOperations', 'humanDescription']) ||
      !exactKeys(checkpoint.stateEvent, ['sequence', 'eventHash', 'state', 'stateChecksum']) ||
      !Number.isSafeInteger(checkpoint.stateEvent.sequence) || checkpoint.stateEvent.sequence < 1 ||
      !HASH_PATTERN.test(checkpoint.stateEvent.eventHash || '') || !HASH_PATTERN.test(checkpoint.stateEvent.stateChecksum || '') ||
      !/^[A-Z][A-Z0-9_]+$/.test(checkpoint.stateEvent.state || '') ||
      !exactKeys(checkpoint.accounting, ['lastAccountingSequence', 'lastAccountingHash', 'snapshotHash']) ||
      !Number.isSafeInteger(checkpoint.accounting.lastAccountingSequence) || checkpoint.accounting.lastAccountingSequence < 1 ||
      !HASH_PATTERN.test(checkpoint.accounting.lastAccountingHash || '') || !HASH_PATTERN.test(checkpoint.accounting.snapshotHash || '') ||
      !exactKeys(checkpoint.immutableHashes, ['requestEnvelopeHash', 'routeDecisionHash', 'planHash', 'candidateHash']) ||
      !HASH_PATTERN.test(checkpoint.immutableHashes.requestEnvelopeHash || '') ||
      !(checkpoint.immutableHashes.routeDecisionHash === null || HASH_PATTERN.test(checkpoint.immutableHashes.routeDecisionHash || '')) ||
      !(checkpoint.immutableHashes.planHash === null || HASH_PATTERN.test(checkpoint.immutableHashes.planHash || '')) ||
      !(checkpoint.immutableHashes.candidateHash === null || HASH_PATTERN.test(checkpoint.immutableHashes.candidateHash || '')) ||
      typeof checkpoint.humanDescription !== 'string' || !checkpoint.humanDescription || checkpoint.humanDescription.length > 500) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'checkpoint payload violates its canonical shape')
  }
  validateScheduler(checkpoint.scheduler)
  if (checkpoint.stateEvent.state !== checkpoint.scheduler.phase ||
      checkpoint.immutableHashes.candidateHash !== checkpoint.scheduler.candidate.candidateHash ||
      stableStringify(checkpoint.recovery.frontier.nextReadyWorkIds) !== stableStringify(checkpoint.scheduler.nextReadyWorkIds) ||
      stableStringify(checkpoint.recovery.frontier.openCheckIds) !== stableStringify(checkpoint.scheduler.openCheckIds)) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'checkpoint state, exact version, or recovery next-ready aliases disagree')
  }
  if (checkpoint.scheduler.route === 'PENDING') {
    if (checkpoint.immutableHashes.routeDecisionHash !== null || checkpoint.immutableHashes.planHash !== null ||
        checkpoint.immutableHashes.candidateHash !== null) {
      fail('RECOVERY_CHECKPOINT_INVALID', 'pre-route checkpoint has invented immutable hashes')
    }
  } else if (!HASH_PATTERN.test(checkpoint.immutableHashes.routeDecisionHash || '')) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'decided-route checkpoint lacks its route decision hash')
  }
  const preparedRecovery = prepareRecovery(checkpoint.recovery)
  if (stableStringify(preparedRecovery) !== stableStringify(checkpoint.recovery) ||
      checkpoint.stateEvent.state !== checkpoint.recovery.savedState ||
      !checkpoint.recovery.frontier.acceptedResultIds.includes(checkpoint.scheduler.stateHash)) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'checkpoint recovery does not bind its state and scheduler bytes')
  }
  validateExternalOperations(checkpoint.externalOperations)
  const leaseIds = checkpoint.scheduler.leases.map((lease) => lease.leaseId)
  const workItemIds = checkpoint.scheduler.leases.map((lease) => lease.workItemId)
  if (new Set(workItemIds).size !== workItemIds.length || checkpoint.scheduler.leases.some((lease) =>
    lease.parentLeaseId !== null && !leaseIds.includes(lease.parentLeaseId))) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'scheduler leases have duplicate work or a missing parent')
  }
  const heldResources = []
  for (const lease of checkpoint.scheduler.leases) {
    for (const resource of lease.resources) {
      const claim = journalResourceClaim(resource)
      // One lease may legitimately describe the same owned tree at multiple
      // granularities (for example a workspace plus one output beneath it).
      // Mutual exclusion is a cross-lease invariant; treating a lease as
      // conflicting with itself makes a recoverable checkpoint impossible.
      const collision = heldResources.find((held) =>
        held.leaseId !== lease.leaseId && journalResourcesConflict(held.claim, claim))
      if (collision) {
        fail('RECOVERY_CHECKPOINT_INVALID', `scheduler resource collision between ${collision.leaseId} and ${lease.leaseId}`)
      }
      heldResources.push({ leaseId: lease.leaseId, claim })
    }
  }
  if (checkpoint.scheduler.completedWorkIds.some((id) => checkpoint.scheduler.nextReadyWorkIds.includes(id) || workItemIds.includes(id)) ||
      checkpoint.scheduler.completedCheckIds.some((id) => checkpoint.scheduler.openCheckIds.includes(id))) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'completed scheduler work or checks remain ready or open')
  }
  const operationIds = checkpoint.externalOperations.map((operation) => operation.operationId)
  const idempotencyKeys = checkpoint.externalOperations.map((operation) => operation.idempotencyKey)
  if (new Set(idempotencyKeys).size !== idempotencyKeys.length) fail('RECOVERY_CHECKPOINT_INVALID', 'external idempotency keys must be unique')
  const unresolved = checkpoint.externalOperations.filter((operation) =>
    ['COMMITTING', 'COMMITTED_UNRECONCILED'].includes(operation.status))
  if (checkpoint.recovery.externalRecovery.status === 'reconciliation-required') {
    const recovery = checkpoint.recovery.externalRecovery
    const expectedOperationIds = unresolved.map((operation) => operation.operationId).sort()
    const expectedIdempotencyKeys = unresolved.map((operation) => operation.idempotencyKey).sort()
    const expectedReceiptHashes = unresolved.map((operation) =>
      operation.commitReceiptHash || operation.prepareReceiptHash).sort()
    if (!unresolved.length || new Set(expectedReceiptHashes).size !== unresolved.length ||
        stableStringify([...recovery.operationIds].sort()) !== stableStringify(expectedOperationIds) ||
        stableStringify([...recovery.idempotencyKeys].sort()) !== stableStringify(expectedIdempotencyKeys) ||
        stableStringify([...recovery.receiptHashes].sort()) !== stableStringify(expectedReceiptHashes)) {
      fail('RECOVERY_CHECKPOINT_INVALID', 'external recovery must bijectively bind every unresolved operation, idempotency key, and latest receipt')
    }
  } else if (unresolved.length) {
    fail('RECOVERY_CHECKPOINT_INVALID', 'unresolved external operation lacks a recovery barrier')
  }
  return checkpoint
}

function candidateAdvanceIsCanonical(previous, record, events) {
  let candidateHash = previous.checkpoint.immutableHashes.candidateHash
  const stateEvents = events
    .slice(previous.checkpoint.stateEvent.sequence, record.checkpoint.stateEvent.sequence)
    .map(event => event && event.details && event.details.stateEvent)
    .filter(Boolean)
  for (const event of stateEvents) {
    if (event.candidateHash === candidateHash) continue
    const invalidatedForRepair = candidateHash !== null && event.candidateHash === null &&
      event.transitionId === 'T032' && event.eventId === 'TRANSIENT_RUNTIME' &&
      event.fromState === 'REPAIRING' && event.toState === 'REPAIRING'
    const frozeCandidate = candidateHash === null && HASH_PATTERN.test(event.candidateHash || '') && (
      event.transitionId === 'T024' && event.eventId === 'WORK_ITEM_VERIFIED' && event.toState === 'ITEM_VERIFIED' ||
      ['T026', 'T031'].includes(event.transitionId) &&
        ['ALL_WORK_JOINED', 'REPAIR_READY'].includes(event.eventId) && event.toState === 'CHECK_WORK'
    )
    if (!invalidatedForRepair && !frozeCandidate) return false
    candidateHash = event.candidateHash
  }
  return candidateHash === record.checkpoint.immutableHashes.candidateHash
}

function roadmapPlanLineageIsCanonical(previous, record, lineage) {
  const before = previous.checkpoint
  const after = record.checkpoint
  const beforePlanHash = before.immutableHashes.planHash
  const afterPlanHash = after.immutableHashes.planHash
  const fields = [
    'schemaVersion', 'kind', 'priorPlanHash', 'replacementPlanHash', 'routeDecisionHash',
    'projectionReceiptHash', 'artifactReceiptHash', 'transactionReceiptHash', 'migration',
    'legacyCauseId',
    'previousCheckpointSequence', 'previousCheckpointEntryHash', 'checkpointSequence',
    'stateEventSequence', 'accountingSequence', 'schedulerStateHash', 'causeKind',
    'lineageReceiptHash',
  ]
  if (!exactKeys(lineage, fields) || lineage.schemaVersion !== 1 ||
      lineage.kind !== 'codex-roadmap-plan-lineage' ||
      !(lineage.priorPlanHash === null || HASH_PATTERN.test(lineage.priorPlanHash || '')) ||
      !HASH_PATTERN.test(lineage.replacementPlanHash || '') ||
      !HASH_PATTERN.test(lineage.routeDecisionHash || '') ||
      !HASH_PATTERN.test(lineage.projectionReceiptHash || '') ||
      !HASH_PATTERN.test(lineage.artifactReceiptHash || '') ||
      !(lineage.transactionReceiptHash === null || HASH_PATTERN.test(lineage.transactionReceiptHash || '')) ||
      typeof lineage.migration !== 'boolean' ||
      !(lineage.legacyCauseId === null || CAUSE_ID_PATTERN.test(lineage.legacyCauseId || '')) ||
      !Number.isSafeInteger(lineage.previousCheckpointSequence) ||
      !Number.isSafeInteger(lineage.checkpointSequence) ||
      !Number.isSafeInteger(lineage.stateEventSequence) ||
      !Number.isSafeInteger(lineage.accountingSequence) ||
      !HASH_PATTERN.test(lineage.previousCheckpointEntryHash || '') ||
      !HASH_PATTERN.test(lineage.schedulerStateHash || '') ||
      !['PLAN_PROJECTION_COMMITTED', 'CRASH_RECOVERY', 'LEASE_STARTED'].includes(lineage.causeKind) ||
      !HASH_PATTERN.test(lineage.lineageReceiptHash || '')) return false
  const unsigned = { ...lineage }
  delete unsigned.lineageReceiptHash
  const exactCauseBinding = lineage.migration === false
    ? lineage.transactionReceiptHash !== null && lineage.legacyCauseId === null &&
      ['PLAN_PROJECTION_COMMITTED', 'CRASH_RECOVERY'].includes(lineage.causeKind) &&
      record.cause.causeId === `plan-lineage:${lineage.lineageReceiptHash}`
    : lineage.transactionReceiptHash === null && lineage.legacyCauseId === record.cause.causeId &&
      ['PLAN_PROJECTION_COMMITTED', 'CRASH_RECOVERY', 'LEASE_STARTED'].includes(lineage.causeKind)
  return exactCauseBinding && lineage.lineageReceiptHash === sha256(stableStringify(unsigned)) &&
    before.scheduler.route === 'ROADMAP' && after.scheduler.route === 'ROADMAP' &&
    beforePlanHash !== afterPlanHash &&
    lineage.priorPlanHash === beforePlanHash &&
    lineage.replacementPlanHash === afterPlanHash &&
    lineage.routeDecisionHash === before.immutableHashes.routeDecisionHash &&
    lineage.routeDecisionHash === after.immutableHashes.routeDecisionHash &&
    before.immutableHashes.candidateHash === after.immutableHashes.candidateHash &&
    before.scheduler.candidate.candidateHash === after.scheduler.candidate.candidateHash &&
    lineage.previousCheckpointSequence === previous.sequence &&
    lineage.previousCheckpointEntryHash === previous.entryHash &&
    lineage.checkpointSequence === record.sequence &&
    lineage.stateEventSequence === after.stateEvent.sequence &&
    lineage.accountingSequence === after.accounting.lastAccountingSequence &&
    lineage.schedulerStateHash === after.scheduler.stateHash &&
    lineage.causeKind === record.cause.kind
}

class RecoveryCheckpointAuthority {
  constructor(options = {}) {
    if (!options.paths || typeof options.paths.runRecordRoot !== 'string' || typeof options.paths.logPath !== 'string' ||
        typeof options.paths.snapshotPath !== 'string' || typeof options.capabilityVerifier !== 'function' ||
        typeof options.stateProvider !== 'function' || typeof options.accountingCheckpointVerifier !== 'function' ||
        typeof options.accountingCheckpointProvider !== 'function' ||
        !options.eventLog || typeof options.eventLog.readAll !== 'function') {
      fail('RECOVERY_CHECKPOINT_CONFIG_INVALID', 'recovery checkpoints require registered paths and runtime, lease, event, and accounting authorities')
    }
    this.runRecordRoot = path.resolve(options.paths.runRecordRoot)
    this.logPath = path.resolve(options.paths.logPath)
    this.snapshotPath = path.resolve(options.paths.snapshotPath)
    if (!pathIsInside(this.runRecordRoot, this.logPath) || !pathIsInside(this.runRecordRoot, this.snapshotPath) ||
        this.logPath === this.snapshotPath) {
      fail('RECOVERY_CHECKPOINT_CONFIG_INVALID', 'recovery checkpoint paths must be distinct descendants of the run record')
    }
    this.capabilityVerifier = options.capabilityVerifier
    this.stateProvider = options.stateProvider
    this.accountingCheckpointVerifier = options.accountingCheckpointVerifier
    this.accountingCheckpointProvider = options.accountingCheckpointProvider
    this.roadmapPlanAdvanceVerifier = typeof options.roadmapPlanAdvanceVerifier === 'function'
      ? options.roadmapPlanAdvanceVerifier : null
    this.resultCommitVerifier = options.resultCommitVerifier || null
    this.eventLog = options.eventLog
    this.fs = options.fsImpl || fs
    this.clock = options.clock || (() => new Date().toISOString())
    this.beforeSnapshotCommit = options.beforeSnapshotCommit
    this.lockTimeoutMs = options.lockTimeoutMs === undefined ? 5000 : options.lockTimeoutMs
    this.lockPollMs = options.lockPollMs === undefined ? 10 : options.lockPollMs
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs <= 0 ||
        !Number.isFinite(this.lockPollMs) || this.lockPollMs <= 0 || this.lockPollMs > this.lockTimeoutMs) {
      fail('RECOVERY_CHECKPOINT_CONFIG_INVALID', 'checkpoint lock requires 0 < pollMs <= timeoutMs')
    }
  }

  appendCheckpoint(input = {}) {
    const state = this.stateProvider()
    const cause = this._validateCause(input.cause)
    const binding = this._authorize(input.capability, state, cause.kind)
    const accountingEvidence = this._verifyAccounting(input.accountingCheckpoint, state)
    const checkpoint = this._prepareCheckpoint(input, state, accountingEvidence)
    const lockPath = path.join(path.dirname(this.logPath), '.recovery-checkpoints.lock')
    const recoveryDirectory = path.join(path.dirname(this.logPath), 'recovered-locks')
    const deadline = Date.now() + this.lockTimeoutMs
    while (true) {
      try {
        return withOwnedLock(lockPath, () => {
          const records = this._readRecords()
          const priorSnapshot = this._readSnapshot(records)
          if (records.length && !priorSnapshot) {
            fail('RECOVERY_CHECKPOINT_RECOVERY_REQUIRED', 'checkpoint snapshot must be reconciled to the durable log tail before append')
          }
          const previous = records.at(-1) || null
          const authority = this._authority(binding, input.providerCapabilitiesHash)
          this._validateAuthorityAdvance(authority, previous, cause.kind)
          let occurredAt = String(this.clock())
          if (Number.isNaN(Date.parse(occurredAt))) fail('RECOVERY_CHECKPOINT_CLOCK_INVALID', 'checkpoint wall clock is not a date-time')
          // A host wall-clock correction is not evidence that authenticated
          // checkpoint state moved backward. Preserve a monotonic timestamp for
          // this new record at the already verified durable high-water; replay
          // still rejects any existing record whose timestamp/hash chain was
          // rewritten or whose state/accounting/external-operation lineage
          // regresses.
          if (previous && Date.parse(occurredAt) < Date.parse(previous.occurredAt)) {
            occurredAt = previous.occurredAt
          }
          const record = canonicalize({
            schemaVersion: SCHEMA_VERSION,
            authority,
            checkpoint,
            checkpointPayloadHash: recoveryCheckpointPayloadHash(checkpoint),
            cause,
            sequence: previous ? previous.sequence + 1 : 1,
            previousHash: previous ? previous.entryHash : null,
            entryHash: '0'.repeat(64),
            occurredAt,
          })
          record.entryHash = recoveryCheckpointEntryHash(record)
          this._validateRecord(record, previous)
          this._appendRecord(record)
          const snapshot = this._snapshotFor(record)
          atomicWriteFile(this.snapshotPath, `${stableStringify(snapshot)}\n`, {
            fsImpl: this.fs,
            mode: FILE_MODE,
            beforeCommit: this.beforeSnapshotCommit,
          })
          const replayed = this.replay()
          if (replayed.recoveryRequired || !replayed.snapshot || replayed.snapshot.snapshotHash !== snapshot.snapshotHash) {
            fail('RECOVERY_CHECKPOINT_COMMIT_INCOMPLETE', 'checkpoint log and snapshot did not durably converge')
          }
          return Object.freeze({ record: Object.freeze(record), snapshot: Object.freeze(snapshot) })
        }, { recoveryDirectory })
      } catch (error) {
        if (error.code !== 'RUN_RECORD_BUSY' || Date.now() >= deadline) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(this.lockPollMs, Math.max(1, deadline - Date.now())))
      }
    }
  }

  checkpoint(input = {}) { return this.appendCheckpoint(input) }

  replay() {
    const records = this._readRecords()
    const snapshot = this._readSnapshot(records)
    return Object.freeze({
      records,
      snapshot,
      recoveryRequired: Boolean(records.length && !snapshot),
      latest: snapshot ? Object.freeze({ record: records.at(-1), snapshot }) : null,
    })
  }

  resumeCheckpoint() {
    const replayed = this.replay()
    if (replayed.recoveryRequired || !replayed.latest) {
      fail('RECOVERY_CHECKPOINT_RECOVERY_REQUIRED', 'resume requires one matching durable checkpoint log record and snapshot')
    }
    const latest = replayed.latest
    const state = this.stateProvider()
    const stateEvent = latest.record.checkpoint.stateEvent
    const authority = latest.record.authority
    const lastEvent = this.eventLog.readAll().at(-1)
    const advancedEvent = lastEvent && lastEvent.details && lastEvent.details.stateEvent
    const exactlyOneTransitionAhead = Boolean(
      state.sequence === stateEvent.sequence + 1 && lastEvent && lastEvent.sequence === state.sequence &&
      lastEvent.hash === state.lastEventHash && advancedEvent &&
      advancedEvent.sequence === state.sequence && advancedEvent.causalParent === stateEvent.eventHash &&
      advancedEvent.fromState === stateEvent.state && advancedEvent.toState === state.state &&
      advancedEvent.candidateHash === (state.candidateHash || null) &&
      stableStringify(advancedEvent.retryState) === stableStringify(state.retryState) &&
      stableStringify(advancedEvent.resourceState) === stableStringify(state.resourceState) &&
      stableStringify([...advancedEvent.openIds].sort()) ===
        stableStringify([...latest.record.checkpoint.scheduler.nextReadyWorkIds].sort()),
    )
    const exactState = stateEvent.sequence === state.sequence && stateEvent.eventHash === state.lastEventHash &&
      stateEvent.state === state.state && stateEvent.stateChecksum === state.checksum &&
      latest.record.checkpoint.immutableHashes.candidateHash === (state.candidateHash || null)
    if (authority.runId !== state.runId || authority.activationId !== state.activation.id ||
        authority.activationNonce !== state.activation.nonce || authority.missionHash !== state.activation.missionHash ||
        authority.targetIdentity !== state.targetIdentity || authority.generation !== state.activation.generation ||
        latest.record.checkpoint.immutableHashes.requestEnvelopeHash !== state.requestEnvelopeHash ||
        (!exactState && !exactlyOneTransitionAhead)) {
      fail('RECOVERY_CHECKPOINT_STATE_STALE', 'latest recovery checkpoint does not equal the current canonical runtime state')
    }
    let currentAccounting
    try { currentAccounting = this.accountingCheckpointProvider() } catch (error) {
      fail('RECOVERY_CHECKPOINT_ACCOUNTING_INVALID', 'latest accounting evidence is unavailable', { cause: error.message })
    }
    const accounting = this._verifyAccounting(currentAccounting, state)
    if (stableStringify(this._accountingProjection(accounting)) !== stableStringify(latest.record.checkpoint.accounting)) {
      fail('RECOVERY_CHECKPOINT_ACCOUNTING_STALE', 'latest recovery checkpoint does not bind the latest accounting snapshot')
    }
    return Object.freeze(canonicalize({
      record: latest.record,
      snapshot: latest.snapshot,
    }))
  }

  resumePausedCheckpoint() {
    const replayed = this.replay()
    if (replayed.recoveryRequired || !replayed.latest) {
      fail('RECOVERY_CHECKPOINT_RECOVERY_REQUIRED', 'paused resume requires one matching durable checkpoint log record and snapshot')
    }
    const latest = replayed.latest
    const state = this.stateProvider()
    const lastEvent = this.eventLog.readAll().at(-1)
    const pauseEvent = lastEvent && lastEvent.details && lastEvent.details.stateEvent
    const stateEvent = latest.record.checkpoint.stateEvent
    const authority = latest.record.authority
    if (!state || state.state !== 'PAUSED' || !lastEvent || lastEvent.sequence !== state.sequence ||
        lastEvent.hash !== state.lastEventHash || !pauseEvent || pauseEvent.transitionId !== 'T058' ||
        pauseEvent.eventId !== 'BUDGET_EXHAUSTED_RESUMABLE' || pauseEvent.toState !== 'PAUSED' ||
        pauseEvent.causalParent !== stateEvent.eventHash || stateEvent.sequence !== state.sequence - 1 ||
        stateEvent.state !== pauseEvent.fromState ||
        state.frontier.resumeState !== stateEvent.state ||
        state.frontier.continuationBindingHash !== latest.record.checkpointPayloadHash ||
        authority.runId !== state.runId || authority.activationId !== state.activation.id ||
        authority.activationNonce !== state.activation.nonce || authority.missionHash !== state.activation.missionHash ||
        authority.targetIdentity !== state.targetIdentity || authority.generation !== state.activation.generation ||
        latest.record.checkpoint.immutableHashes.requestEnvelopeHash !== state.requestEnvelopeHash ||
        latest.record.checkpoint.immutableHashes.candidateHash !== (state.candidateHash || null)) {
      fail('RECOVERY_CHECKPOINT_STATE_STALE', 'latest recovery checkpoint is not the exact causal parent bound by PAUSED')
    }
    let currentAccounting
    try { currentAccounting = this.accountingCheckpointProvider() } catch (error) {
      fail('RECOVERY_CHECKPOINT_ACCOUNTING_INVALID', 'paused accounting evidence is unavailable', { cause: error.message })
    }
    const accounting = this._verifyAccounting(currentAccounting, state)
    if (stableStringify(this._accountingProjection(accounting)) !== stableStringify(latest.record.checkpoint.accounting)) {
      fail('RECOVERY_CHECKPOINT_ACCOUNTING_STALE', 'PAUSED recovery checkpoint does not bind the latest accounting snapshot')
    }
    return Object.freeze(canonicalize({ record: latest.record, snapshot: latest.snapshot }))
  }

  verifyResumeCheckpoint(evidence) {
    const expected = this.resumeCheckpoint()
    if (!evidence || stableStringify(evidence) !== stableStringify(expected)) {
      fail('RECOVERY_CHECKPOINT_EVIDENCE_INVALID', 'resume evidence does not equal the latest durable recovery checkpoint')
    }
    return expected
  }

  verifyPausedResumeCheckpoint(evidence) {
    const expected = this.resumePausedCheckpoint()
    if (!evidence || stableStringify(evidence) !== stableStringify(expected)) {
      fail('RECOVERY_CHECKPOINT_EVIDENCE_INVALID', 'paused resume evidence does not equal the bound durable checkpoint')
    }
    return expected
  }

  recoverCrashTail(input = {}) {
    const state = this.stateProvider()
    this._authorize(input.capability, state, 'CHECKPOINT', { allowVerifiedTakeover: true })
    const lockPath = path.join(path.dirname(this.logPath), '.recovery-checkpoints.lock')
    const recoveryDirectory = path.join(path.dirname(this.logPath), 'recovered-locks')
    return withOwnedLock(lockPath, () => {
      const bytes = readFileNoFollow(this.logPath)
      if (bytes === null || bytes.length === 0 || bytes.at(-1) === 0x0a) {
        const records = this._readRecords()
        const reconciled = this._reconcileSnapshotLocked(records)
        return Object.freeze({
          recovered: reconciled.rebuilt,
          recoveryKind: reconciled.rebuilt ? 'snapshot-rebuilt' : null,
          records,
          snapshot: reconciled.snapshot,
        })
      }
      const lastNewline = bytes.lastIndexOf(0x0a)
      const completeLength = lastNewline < 0 ? 0 : lastNewline + 1
      const tail = bytes.subarray(completeLength)
      const digest = sha256(tail)
      const evidenceDirectory = path.join(this.runRecordRoot, 'runtime', 'recovery', 'incomplete-recovery-checkpoint-tail')
      this.fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
      const evidencePath = path.join(evidenceDirectory, `${digest}.bin`)
      if (this.fs.existsSync(evidencePath)) {
        const retained = readFileNoFollow(evidencePath)
        if (!retained || !retained.equals(tail)) fail('RECOVERY_CHECKPOINT_LOG_UNSAFE', 'crash-tail evidence hash collision')
      } else {
        let evidenceDescriptor
        try {
          evidenceDescriptor = this.fs.openSync(evidencePath, this.fs.constants.O_WRONLY | this.fs.constants.O_CREAT |
            this.fs.constants.O_EXCL | (this.fs.constants.O_NOFOLLOW || 0), FILE_MODE)
          let offset = 0
          while (offset < tail.length) offset += this.fs.writeSync(evidenceDescriptor, tail, offset, tail.length - offset)
          this.fs.fsyncSync(evidenceDescriptor)
        } finally { if (evidenceDescriptor !== undefined) this.fs.closeSync(evidenceDescriptor) }
        fsyncDirectory(evidenceDirectory, this.fs)
      }
      if (input.truncateIncompleteTail !== true) {
        fail('RECOVERY_CHECKPOINT_RECOVERY_REQUIRED', 'checkpoint crash tail was preserved but requires explicit truncation', { evidencePath, incompleteBytes: tail.length })
      }
      let descriptor
      try {
        descriptor = this.fs.openSync(this.logPath, this.fs.constants.O_WRONLY | (this.fs.constants.O_NOFOLLOW || 0))
        this.fs.ftruncateSync(descriptor, completeLength)
        this.fs.fsyncSync(descriptor)
      } finally { if (descriptor !== undefined) this.fs.closeSync(descriptor) }
      const records = this._readRecords()
      const reconciled = this._reconcileSnapshotLocked(records)
      return Object.freeze({
        recovered: true,
        recoveryKind: reconciled.rebuilt ? 'tail-truncated-and-snapshot-rebuilt' : 'tail-truncated',
        evidencePath,
        incompleteBytes: tail.length,
        records,
        snapshot: reconciled.snapshot,
      })
    }, { recoveryDirectory })
  }

  reconcileSnapshot(input = {}) {
    const state = this.stateProvider()
    this._authorize(input.capability, state, 'CHECKPOINT', { allowVerifiedTakeover: true })
    const lockPath = path.join(path.dirname(this.logPath), '.recovery-checkpoints.lock')
    const recoveryDirectory = path.join(path.dirname(this.logPath), 'recovered-locks')
    return withOwnedLock(lockPath, () => {
      const records = this._readRecords()
      const reconciled = this._reconcileSnapshotLocked(records)
      return Object.freeze({
        recovered: reconciled.rebuilt,
        recoveryKind: reconciled.rebuilt ? 'snapshot-rebuilt' : null,
        records,
        snapshot: reconciled.snapshot,
      })
    }, { recoveryDirectory })
  }

  _reconcileSnapshotLocked(records) {
    const saved = this._readSnapshot(records)
    if (saved || !records.length) return { rebuilt: false, snapshot: saved }
    const rebuilt = this._snapshotFor(records.at(-1))
    atomicWriteFile(this.snapshotPath, `${stableStringify(rebuilt)}\n`, {
      fsImpl: this.fs,
      mode: FILE_MODE,
      beforeCommit: this.beforeSnapshotCommit,
    })
    const verified = this._readSnapshot(records)
    if (!verified || verified.snapshotHash !== rebuilt.snapshotHash) {
      fail('RECOVERY_CHECKPOINT_COMMIT_INCOMPLETE', 'rebuilt checkpoint snapshot did not durably bind the verified log tail')
    }
    return { rebuilt: true, snapshot: verified }
  }

  _validateCause(cause) {
    const fields = cause && cause.kind === 'RESULT_COMMITTED'
      ? ['kind', 'causeId', 'humanDescription', 'resultCommit']
      : ['kind', 'causeId', 'humanDescription']
    if (!exactKeys(cause, fields) || !CAUSE_KINDS.includes(cause.kind) ||
        !CAUSE_ID_PATTERN.test(cause.causeId || '') || typeof cause.humanDescription !== 'string' ||
        !cause.humanDescription || cause.humanDescription.length > 500) {
      fail('RECOVERY_CHECKPOINT_CAUSE_INVALID', 'checkpoint requires one canonical typed cause')
    }
    if (cause.kind === 'RESULT_COMMITTED') {
      const binding = cause.resultCommit
      if (!exactKeys(binding, RESULT_COMMIT_FIELDS) ||
          ['assignmentId', 'leaseId', 'sessionId', 'continuationId'].some((field) =>
            typeof binding[field] !== 'string' || !binding[field] || binding[field].length > 255) ||
          ['assignmentHash', 'resultHash', 'receiptHash'].some((field) => !HASH_PATTERN.test(binding[field] || '')) ||
          !(binding.candidateHash === null || HASH_PATTERN.test(binding.candidateHash || ''))) {
        fail('RECOVERY_CHECKPOINT_CAUSE_INVALID', 'RESULT_COMMITTED requires its exact canonical terminal receipt binding')
      }
    }
    return canonicalize(cause)
  }

  _verifyResultCommit(cause, checkpoint, authority) {
    if (cause.kind !== 'RESULT_COMMITTED') return
    const binding = cause.resultCommit
    const lease = checkpoint.scheduler.leases.find((entry) => entry.leaseId === binding.leaseId)
    if (!lease || lease.status !== 'OPEN' || lease.workItemId !== binding.assignmentId ||
        lease.sessionId !== binding.sessionId || lease.continuationId !== binding.continuationId) {
      fail('RECOVERY_CHECKPOINT_RESULT_INVALID', 'RESULT_COMMITTED does not bind the exact still-open scheduler lease')
    }
    if (binding.candidateHash !== checkpoint.immutableHashes.candidateHash ||
        binding.candidateHash !== checkpoint.scheduler.candidate.candidateHash) {
      fail('RECOVERY_CHECKPOINT_RESULT_INVALID', 'RESULT_COMMITTED exact version differs from the immutable scheduler version')
    }
    if (!checkpoint.recovery.frontier.acceptedResultIds.includes(binding.receiptHash)) {
      fail('RECOVERY_CHECKPOINT_RESULT_INVALID', 'RESULT_COMMITTED terminal receipt is absent from accepted recovery work')
    }
    if (typeof this.resultCommitVerifier !== 'function') {
      fail('RECOVERY_CHECKPOINT_RESULT_UNVERIFIED', 'RESULT_COMMITTED requires a durable terminal receipt verifier')
    }
    let verified
    try {
      verified = this.resultCommitVerifier(Object.freeze(canonicalize(binding)), Object.freeze({
        runId: authority.runId,
        activationId: authority.activationId,
        generation: authority.generation,
        allowPredecessorGeneration: /^adopted-result:\d+:.+:result:[a-f0-9]{24}$/u.test(cause.causeId),
        checkpointPayloadHash: recoveryCheckpointPayloadHash(checkpoint),
      }))
    } catch (error) {
      fail('RECOVERY_CHECKPOINT_RESULT_UNVERIFIED', 'durable terminal receipt verification failed', { cause: error.message })
    }
    const verificationFields = ['runId', 'activationId', 'generation', ...RESULT_COMMIT_FIELDS]
    const verifiedGeneration = verified && verified.generation
    const generationAccepted = verifiedGeneration === authority.generation ||
      (/^adopted-result:\d+:.+:result:[a-f0-9]{24}$/u.test(cause.causeId) &&
       verifiedGeneration + 1 === authority.generation)
    if (!exactKeys(verified, verificationFields) || verified.runId !== authority.runId ||
        verified.activationId !== authority.activationId || !generationAccepted ||
        RESULT_COMMIT_FIELDS.some((field) => verified[field] !== binding[field])) {
      fail('RECOVERY_CHECKPOINT_RESULT_UNVERIFIED', 'durable terminal receipt differs from RESULT_COMMITTED or its activation generation')
    }
  }

  _authorize(capability, state, causeKind, options = {}) {
    let binding
    try { binding = this.capabilityVerifier(capability) } catch (error) {
      fail('LEASE_CAPABILITY_REQUIRED', 'checkpoint requires the opaque live lease capability', { cause: error.message })
    }
    const exactBinding = Boolean(binding && binding.runId === state.runId && binding.activationId === state.activation.id &&
      binding.nonce === state.activation.nonce && binding.missionHash === state.activation.missionHash &&
      binding.targetIdentity === state.targetIdentity && binding.generation === state.activation.generation)
    let verifiedTakeover = false
    if (binding && options.allowVerifiedTakeover === true && binding.generation === state.activation.generation + 1) {
      let takeover
      try { takeover = validateTakeoverReceipt(binding.takeover) } catch {}
      verifiedTakeover = Boolean(takeover && takeover.runId === state.runId && takeover.activationId === state.activation.id &&
        takeover.nonce === state.activation.nonce && takeover.missionHash === state.activation.missionHash &&
        takeover.generation === state.activation.generation && takeover.targetIdentity === state.targetIdentity &&
        takeover.ownerProcessVerifiedDead === true && takeover.descendantsVerifiedDrained === true)
    }
    if (!exactBinding && !verifiedTakeover) {
      fail('LEASE_CAPABILITY_REQUIRED', 'checkpoint capability does not bind the exact runtime activation and allowed generation')
    }
    return binding
  }

  _authority(binding, providerCapabilitiesHash) {
    if (!HASH_PATTERN.test(providerCapabilitiesHash || '')) fail('RECOVERY_CHECKPOINT_AUTHORITY_INVALID', 'provider capability contract hash is required')
    const authority = canonicalize({
      runId: binding.runId,
      activationId: binding.activationId,
      activationNonce: binding.nonce,
      generation: binding.generation,
      missionHash: binding.missionHash,
      targetIdentity: binding.targetIdentity,
      targetIdentityHash: sha256(binding.targetIdentity),
      providerCapabilitiesHash,
      capabilityBindingHash: '0'.repeat(64),
    })
    authority.capabilityBindingHash = recoveryAuthorityBindingHash(authority)
    return authority
  }

  _verifyAccounting(evidence, state) {
    let verified
    try { verified = this.accountingCheckpointVerifier(evidence) } catch (error) {
      fail('RECOVERY_CHECKPOINT_ACCOUNTING_INVALID', 'accounting evidence failed verification', { cause: error.message })
    }
    if (!verified || verified.runId !== state.runId || verified.activationId !== state.activation.id ||
        verified.activationNonce !== state.activation.nonce || verified.generation > state.activation.generation ||
        !Number.isSafeInteger(verified.lastAccountingSequence) || verified.lastAccountingSequence < 1 ||
        !HASH_PATTERN.test(verified.lastAccountingHash || '') || !HASH_PATTERN.test(verified.snapshotHash || '')) {
      fail('RECOVERY_CHECKPOINT_ACCOUNTING_INVALID', 'accounting evidence is foreign or incomplete')
    }
    if (stableStringify(verified) !== stableStringify(evidence)) {
      fail('RECOVERY_CHECKPOINT_ACCOUNTING_INVALID', 'accounting evidence is not the exact latest persisted checkpoint')
    }
    return verified
  }

  _accountingProjection(evidence) {
    return canonicalize({
      lastAccountingSequence: evidence.lastAccountingSequence,
      lastAccountingHash: evidence.lastAccountingHash,
      snapshotHash: evidence.snapshotHash,
    })
  }

  _prepareCheckpoint(input, state, accounting) {
    const lastEvent = this.eventLog.readAll().at(-1)
    if (!lastEvent || lastEvent.sequence !== state.sequence || lastEvent.hash !== state.lastEventHash || !HASH_PATTERN.test(state.checksum || '')) {
      fail('RECOVERY_CHECKPOINT_STATE_UNBOUND', 'checkpoint requires the exact current canonical state event and checksum')
    }
    const scheduler = canonicalize(input.scheduler)
    validateScheduler(scheduler)
    const recovery = prepareRecovery(input.recovery)
    if (recovery.savedState !== state.state || !recovery.frontier.acceptedResultIds.includes(scheduler.stateHash)) {
      fail('RECOVERY_CHECKPOINT_FRONTIER_MISMATCH', 'recovery state and next ready work must bind the persisted scheduler state hash')
    }
    if (recovery.bindingHash !== recoveryBindingHash(recovery)) fail('RECOVERY_CHECKPOINT_INVALID', 'recovery binding hash changed')
    const immutable = input.immutableHashes
    if (!exactKeys(immutable, ['requestEnvelopeHash', 'routeDecisionHash', 'planHash', 'candidateHash']) ||
        !HASH_PATTERN.test(immutable.requestEnvelopeHash || '') || immutable.requestEnvelopeHash !== state.requestEnvelopeHash ||
        !(immutable.routeDecisionHash === null || HASH_PATTERN.test(immutable.routeDecisionHash || '')) ||
        !(immutable.planHash === null || HASH_PATTERN.test(immutable.planHash || '')) ||
        !(immutable.candidateHash === null || HASH_PATTERN.test(immutable.candidateHash || '')) ||
        immutable.candidateHash !== (state.candidateHash || null)) {
      fail('RECOVERY_CHECKPOINT_IMMUTABLE_MISMATCH', 'checkpoint immutable hashes do not bind the runtime state')
    }
    validateExternalOperations(input.externalOperations)
    if (typeof input.humanDescription !== 'string' || !input.humanDescription || input.humanDescription.length > 500) {
      fail('RECOVERY_CHECKPOINT_INVALID', 'checkpoint human description is required')
    }
    if (scheduler.route === 'PENDING' && (immutable.routeDecisionHash !== null || immutable.planHash !== null || immutable.candidateHash !== null)) {
      fail('RECOVERY_CHECKPOINT_IMMUTABLE_MISMATCH', 'pre-route checkpoint cannot invent decision, plan, or exact-version hashes')
    }
    if (scheduler.route !== 'PENDING' && !HASH_PATTERN.test(immutable.routeDecisionHash || '')) {
      fail('RECOVERY_CHECKPOINT_IMMUTABLE_MISMATCH', 'decided-route checkpoint requires its route decision hash')
    }
    const checkpoint = canonicalize({
      stateEvent: { sequence: state.sequence, eventHash: state.lastEventHash, state: state.state, stateChecksum: state.checksum },
      accounting: this._accountingProjection(accounting),
      scheduler,
      recovery,
      immutableHashes: immutable,
      externalOperations: input.externalOperations,
      humanDescription: input.humanDescription,
    })
    validateCheckpointPayload(checkpoint)
    return checkpoint
  }

  _validateAuthorityAdvance(authority, previous, causeKind) {
    if (!exactKeys(authority, [...AUTHORITY_FIELDS, 'capabilityBindingHash']) || !HASH_PATTERN.test(authority.missionHash || '') ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(authority.runId || '') ||
        typeof authority.activationId !== 'string' || !authority.activationId || authority.activationId.length > 255 ||
        typeof authority.targetIdentity !== 'string' || !authority.targetIdentity || authority.targetIdentity.length > 2048 ||
        !HASH_PATTERN.test(authority.targetIdentityHash || '') || authority.targetIdentityHash !== sha256(authority.targetIdentity) ||
        !HASH_PATTERN.test(authority.providerCapabilitiesHash || '') || !HASH_PATTERN.test(authority.capabilityBindingHash || '') ||
        authority.capabilityBindingHash !== recoveryAuthorityBindingHash(authority) || !NONCE_PATTERN.test(authority.activationNonce || '') ||
        !Number.isSafeInteger(authority.generation) || authority.generation < 1) {
      fail('RECOVERY_CHECKPOINT_AUTHORITY_INVALID', 'checkpoint authority is invalid')
    }
    if (!previous) return
    for (const field of ['runId', 'activationId', 'activationNonce', 'missionHash', 'targetIdentity', 'targetIdentityHash']) {
      if (authority[field] !== previous.authority[field]) fail('RECOVERY_CHECKPOINT_FOREIGN_BINDING', `checkpoint changed immutable ${field}`)
    }
    const generationDelta = authority.generation - previous.authority.generation
    if (generationDelta < 0 || generationDelta > 1 || (generationDelta === 1 && causeKind !== 'CRASH_RECOVERY')) {
      fail('RECOVERY_CHECKPOINT_GENERATION_INVALID', 'checkpoint generation may advance exactly once only for CRASH_RECOVERY')
    }
    const capabilityChanged = authority.capabilityBindingHash !== previous.authority.capabilityBindingHash ||
      authority.providerCapabilitiesHash !== previous.authority.providerCapabilitiesHash
    if ((generationDelta === 0 && capabilityChanged) || (generationDelta === 1 && !capabilityChanged)) {
      fail('RECOVERY_CHECKPOINT_GENERATION_INVALID', 'capability bindings may change exactly with a crash generation advance')
    }
  }

  _readRecords() {
    const bytes = readFileNoFollow(this.logPath)
    if (bytes === null || bytes.length === 0) return Object.freeze([])
    if (bytes.at(-1) !== 0x0a) fail('RECOVERY_CHECKPOINT_RECOVERY_REQUIRED', 'checkpoint log has an incomplete crash tail')
    const records = []
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line) continue
      let record
      try { record = JSON.parse(line) } catch (error) { fail('RECOVERY_CHECKPOINT_LOG_INVALID', 'checkpoint log contains malformed complete JSON', { cause: error.message }) }
      this._validateRecord(record, records.at(-1) || null)
      records.push(Object.freeze(record))
    }
    return Object.freeze(records)
  }

  _validateRecord(record, previous) {
    const fields = RECORD_SCHEMA.required
    if (!exactKeys(record, fields) || record.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(record.sequence) ||
        record.sequence !== (previous ? previous.sequence + 1 : 1) || record.previousHash !== (previous ? previous.entryHash : null) ||
        !HASH_PATTERN.test(record.entryHash || '') || record.entryHash !== recoveryCheckpointEntryHash(record) ||
        Number.isNaN(Date.parse(record.occurredAt)) || !HASH_PATTERN.test(record.checkpointPayloadHash || '') ||
        record.checkpointPayloadHash !== recoveryCheckpointPayloadHash(record.checkpoint)) {
      fail('RECOVERY_CHECKPOINT_LOG_INVALID', 'checkpoint record violates its canonical schema, sequence, or hash chain')
    }
    const cause = this._validateCause(record.cause)
    this._validateAuthorityAdvance(record.authority, previous, cause.kind)
    validateCheckpointPayload(record.checkpoint)
    this._verifyResultCommit(cause, record.checkpoint, record.authority)
    const events = this.eventLog.readAll()
    const event = events[record.checkpoint.stateEvent.sequence - 1]
    if (!event || event.hash !== record.checkpoint.stateEvent.eventHash || event.stateAfter !== record.checkpoint.stateEvent.state ||
        !event.details || !event.details.stateEvent || event.details.stateEvent.runId !== record.authority.runId ||
        event.details.stateEvent.activationNonce !== record.authority.activationNonce) {
      fail('RECOVERY_CHECKPOINT_STATE_UNBOUND', 'checkpoint record does not bind a canonical state event')
    }
    if (previous) {
      if (record.checkpoint.stateEvent.sequence < previous.checkpoint.stateEvent.sequence ||
          record.checkpoint.accounting.lastAccountingSequence < previous.checkpoint.accounting.lastAccountingSequence ||
          Date.parse(record.occurredAt) < Date.parse(previous.occurredAt)) {
        fail('RECOVERY_CHECKPOINT_ROLLBACK', 'checkpoint state, accounting, or wall time decreased')
      }
      if (record.checkpoint.stateEvent.sequence === previous.checkpoint.stateEvent.sequence &&
          (record.checkpoint.stateEvent.eventHash !== previous.checkpoint.stateEvent.eventHash ||
            record.checkpoint.stateEvent.stateChecksum !== previous.checkpoint.stateEvent.stateChecksum ||
            record.checkpoint.stateEvent.state !== previous.checkpoint.stateEvent.state)) {
        fail('RECOVERY_CHECKPOINT_ROLLBACK', 'checkpoint rewrote one canonical state-event sequence')
      }
      if (record.checkpoint.accounting.lastAccountingSequence === previous.checkpoint.accounting.lastAccountingSequence &&
          (record.checkpoint.accounting.lastAccountingHash !== previous.checkpoint.accounting.lastAccountingHash ||
            record.checkpoint.accounting.snapshotHash !== previous.checkpoint.accounting.snapshotHash)) {
        fail('RECOVERY_CHECKPOINT_ROLLBACK', 'checkpoint rewrote one accounting sequence')
      }
      for (const field of ['requestEnvelopeHash']) {
        if (record.checkpoint.immutableHashes[field] !== previous.checkpoint.immutableHashes[field]) {
          fail('RECOVERY_CHECKPOINT_ROLLBACK', `checkpoint changed immutable ${field}`)
        }
      }
      const priorRouteDecisionHash = previous.checkpoint.immutableHashes.routeDecisionHash
      if (priorRouteDecisionHash !== null && record.checkpoint.immutableHashes.routeDecisionHash !== priorRouteDecisionHash) {
        fail('RECOVERY_CHECKPOINT_ROLLBACK', 'checkpoint changed bound routeDecisionHash')
      }
      const priorPlanHash = previous.checkpoint.immutableHashes.planHash
      const replacementPlanHash = record.checkpoint.immutableHashes.planHash
      const requiresRoadmapLineage = replacementPlanHash !== priorPlanHash &&
        (priorPlanHash !== null || record.checkpoint.scheduler.route === 'ROADMAP')
      if (requiresRoadmapLineage) {
        let verifiedLineage = null
        if (this.roadmapPlanAdvanceVerifier) {
          try {
            verifiedLineage = this.roadmapPlanAdvanceVerifier(previous, record)
          } catch {}
        }
        if (!roadmapPlanLineageIsCanonical(previous, record, verifiedLineage)) {
          fail('RECOVERY_CHECKPOINT_ROLLBACK', 'checkpoint changed bound planHash')
        }
      }
      if (record.checkpoint.immutableHashes.candidateHash !== previous.checkpoint.immutableHashes.candidateHash &&
          !candidateAdvanceIsCanonical(previous, record, events)) {
        fail('RECOVERY_CHECKPOINT_ROLLBACK', 'checkpoint changed the bound exact-version hash')
      }
      for (const field of ['completedWorkIds', 'completedCheckIds']) {
        if (previous.checkpoint.scheduler[field].some((id) => !record.checkpoint.scheduler[field].includes(id))) {
          fail('RECOVERY_CHECKPOINT_ROLLBACK', `checkpoint removed ${field}`)
        }
      }
      for (const field of Object.keys(record.checkpoint.scheduler.usage)) {
        if (record.checkpoint.scheduler.usage[field] < previous.checkpoint.scheduler.usage[field]) {
          fail('RECOVERY_CHECKPOINT_ROLLBACK', `checkpoint decreased scheduler usage ${field}`)
        }
      }
      const currentOperations = new Map(record.checkpoint.externalOperations.map((operation) => [operation.operationId, operation]))
      const allowedOperationAdvance = {
        PREPARED: new Set(['PREPARED', 'COMMITTING', 'COMMITTED_UNRECONCILED', 'ROLLED_BACK']),
        COMMITTING: new Set(['COMMITTING', 'COMMITTED_UNRECONCILED', 'RECONCILED', 'ROLLED_BACK']),
        COMMITTED_UNRECONCILED: new Set(['COMMITTED_UNRECONCILED', 'RECONCILED', 'ROLLED_BACK']),
        RECONCILED: new Set(['RECONCILED']),
        ROLLED_BACK: new Set(['ROLLED_BACK']),
      }
      for (const priorOperation of previous.checkpoint.externalOperations) {
        const currentOperation = currentOperations.get(priorOperation.operationId)
        if (!currentOperation || currentOperation.idempotencyKey !== priorOperation.idempotencyKey ||
            !allowedOperationAdvance[priorOperation.status].has(currentOperation.status)) {
          fail('RECOVERY_CHECKPOINT_ROLLBACK', `external operation ${priorOperation.operationId} disappeared, aliased, or moved backward`)
        }
        for (const field of ['prepareReceiptHash', 'commitReceiptHash', 'reconcileReceiptHash', 'rollbackReceiptHash']) {
          if (priorOperation[field] !== null && currentOperation[field] !== priorOperation[field]) {
            fail('RECOVERY_CHECKPOINT_ROLLBACK', `external operation ${priorOperation.operationId} changed ${field}`)
          }
        }
      }
    }
    return true
  }

  _readSnapshot(records) {
    const bytes = readFileNoFollow(this.snapshotPath)
    if (bytes === null) return null
    let snapshot
    try { snapshot = JSON.parse(bytes.toString('utf8')) } catch (error) { fail('RECOVERY_CHECKPOINT_SNAPSHOT_INVALID', 'checkpoint snapshot is malformed', { cause: error.message }) }
    const last = records.at(-1)
    const bound = snapshot && Number.isSafeInteger(snapshot.lastCheckpointSequence)
      ? records[snapshot.lastCheckpointSequence - 1]
      : null
    if (!exactKeys(snapshot, SNAPSHOT_SCHEMA.required) || snapshot.schemaVersion !== SCHEMA_VERSION ||
        !HASH_PATTERN.test(snapshot.snapshotHash || '') || snapshot.snapshotHash !== recoveryCheckpointSnapshotHash(snapshot) ||
        !last || !bound || snapshot.lastCheckpointSequence > last.sequence || snapshot.lastCheckpointHash !== bound.entryHash ||
        stableStringify(snapshot.authority) !== stableStringify(bound.authority) ||
        stableStringify(snapshot.checkpoint) !== stableStringify(bound.checkpoint) ||
        snapshot.checkpointPayloadHash !== bound.checkpointPayloadHash || snapshot.recordedAt !== bound.occurredAt) {
      fail('RECOVERY_CHECKPOINT_SNAPSHOT_INVALID', 'checkpoint snapshot is corrupt, foreign, ahead, or not bound to its log')
    }
    if (snapshot.lastCheckpointSequence < last.sequence) return null
    return Object.freeze(snapshot)
  }

  _snapshotFor(record) {
    const snapshot = canonicalize({
      schemaVersion: SCHEMA_VERSION,
      authority: record.authority,
      lastCheckpointSequence: record.sequence,
      lastCheckpointHash: record.entryHash,
      checkpoint: record.checkpoint,
      checkpointPayloadHash: record.checkpointPayloadHash,
      snapshotHash: '0'.repeat(64),
      recordedAt: record.occurredAt,
    })
    snapshot.snapshotHash = recoveryCheckpointSnapshotHash(snapshot)
    return snapshot
  }

  _appendRecord(record) {
    this.fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 })
    let descriptor
    try {
      descriptor = this.fs.openSync(this.logPath, this.fs.constants.O_WRONLY | this.fs.constants.O_CREAT |
        this.fs.constants.O_APPEND | (this.fs.constants.O_NOFOLLOW || 0), FILE_MODE)
      const opened = this.fs.fstatSync(descriptor)
      const bound = this.fs.lstatSync(this.logPath)
      if (!opened.isFile() || bound.isSymbolicLink() || !bound.isFile() || Number(opened.nlink) !== 1 ||
          Number(bound.nlink) !== 1 || String(opened.dev) !== String(bound.dev) || String(opened.ino) !== String(bound.ino)) {
        fail('RECOVERY_CHECKPOINT_LOG_UNSAFE', 'checkpoint log is not one bound regular physical file')
      }
      const bytes = Buffer.from(`${stableStringify(record)}\n`, 'utf8')
      let offset = 0
      while (offset < bytes.length) offset += this.fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
      this.fs.fsyncSync(descriptor)
    } finally { if (descriptor !== undefined) this.fs.closeSync(descriptor) }
    fsyncDirectory(path.dirname(this.logPath), this.fs)
  }
}

module.exports = {
  CAUSE_KINDS,
  RecoveryCheckpointAuthority,
  RecoveryCheckpointError,
  decodeSchedulerCheckpoint,
  prepareSchedulerCheckpoint,
  recoveryAuthorityBindingHash,
  recoveryBindingHash,
  recoveryCheckpointEntryHash,
  recoveryCheckpointPayloadHash,
  recoveryCheckpointSnapshotHash,
  schedulerFrontierHash,
}
