#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const { isDeepStrictEqual } = require('node:util')

const ROOT = path.resolve(__dirname, '..', '..')
const { RecoveryCheckpointAuthority } = require(path.join(
  ROOT, 'agents', 'codex', 'workflow', 'recovery-checkpoint.js',
))
const RECORD_SCHEMA_PATH = path.join(ROOT, 'agents', 'contracts', 'schemas', 'recovery-checkpoint-record.schema.json')
const SNAPSHOT_SCHEMA_PATH = path.join(ROOT, 'agents', 'contracts', 'schemas', 'recovery-checkpoint-snapshot.schema.json')
const H = label => crypto.createHash('sha256').update(label).digest('hex')

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson(value[key])]))
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value))
}

function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function rawHash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function without(value, key) {
  const output = { ...value }
  delete output[key]
  return output
}

function draftResults(schemaPath, values) {
  const program = [
    'import json, sys',
    'from jsonschema import Draft202012Validator, FormatChecker',
    'payload=json.load(sys.stdin)',
    "schema=json.load(open(payload['schemaPath'], encoding='utf-8'))",
    'Draft202012Validator.check_schema(schema)',
    'validator=Draft202012Validator(schema, format_checker=FormatChecker())',
    "print(json.dumps([len(list(validator.iter_errors(value))) for value in payload['values']]))",
  ].join('\n')
  return JSON.parse(execFileSync('python', ['-c', program], {
    input: JSON.stringify({ schemaPath, values }), encoding: 'utf8', windowsHide: true,
  }))
}

function assertDraftValid(schemaPath, values) {
  assert.deepEqual(draftResults(schemaPath, values), values.map(() => 0))
}

function assertDraftInvalid(schemaPath, values) {
  const results = draftResults(schemaPath, values)
  assert.ok(results.every(count => count > 0), `all mutations must fail ${path.basename(schemaPath)}: ${results}`)
}

function usage(overrides = {}) {
  return {
    noncachedInput: 10, cachedInput: 20, output: 3, reasoning: 2,
    weightedCost: 35, latencyMs: 100, workMs: 80, ...overrides,
  }
}

function authority(overrides = {}) {
  const value = {
    runId: 'run-checkpoint-0001', activationId: 'activation-checkpoint-001',
    activationNonce: 'nonce_1234567890123456', generation: 1,
    missionHash: H('mission'), targetIdentity: 'workspace:C:/exact-target',
    targetIdentityHash: H('placeholder'), providerCapabilitiesHash: H('provider-capabilities'),
    capabilityBindingHash: H('placeholder'), ...overrides,
  }
  value.targetIdentityHash = rawHash(Buffer.from(value.targetIdentity, 'utf8'))
  value.capabilityBindingHash = stableHash(without(value, 'capabilityBindingHash'))
  return value
}

function recovery(overrides = {}) {
  const value = {
    savedState: 'RUN_WORK', resumeState: 'CHECK_WORK',
    frontier: {
      nextReadyWorkIds: ['work-2'], openCheckIds: ['check-1'], acceptedResultIds: ['result-work-0'],
    },
    completedMilestones: ['route-analysis', 'route-decision', 'work-preparation', 'external-prepare', 'external-commit'],
    externalRecovery: {
      status: 'reconciliation-required', operationIds: ['operation-1'],
      idempotencyKeys: ['idempotency-1'], receiptHashes: [H('commit-receipt')],
    },
    releaseIntentHash: null, bindingHash: H('placeholder'), ...overrides,
  }
  value.bindingHash = stableHash(without(value, 'bindingHash'))
  return value
}

function lease(overrides = {}) {
  return {
    leaseId: 'lease-1', workItemId: 'work-1', roleId: 'ap-worker', status: 'OPEN',
    parentLeaseId: null, reservationId: 'reservation-1', sessionId: 'session-1',
    continuationId: 'continuation-1', crashBindingHash: H('crash-binding'),
    resources: [{ id: 'workspace:C:/exact-target/file.js', kind: 'workspace', mode: 'exclusive', isolationId: null }],
    usage: usage(), reserves: usage({ noncachedInput: 50, output: 8, workMs: 200 }),
    thread: { started: true, startedEventHash: H('thread-started'), startedAt: '2026-08-22T01:00:00.000Z' },
    ...overrides,
  }
}

function frontierProjection(scheduler) {
  return Object.fromEntries([
    'route', 'phase', 'candidate', 'completedWorkIds', 'completedCheckIds', 'openCheckIds',
    'nextReadyWorkIds', 'leases', 'usage', 'reserves',
  ].map(field => [field, scheduler[field]]))
}

function scheduler(overrides = {}) {
  const value = {
    encoding: 'stable-json-v1-without-stateHash+base64', stateBytesBase64: '', stateByteLength: 0,
    stateHash: H('placeholder'), frontierHash: H('placeholder'), ownerSessionId: 'root-session-1',
    route: 'LIGHT', phase: 'RUN_WORK',
    candidate: { candidateId: 'candidate-1', candidateHash: H('candidate-1'), frozen: false },
    completedWorkIds: ['work-0'], completedCheckIds: ['check-0'], openCheckIds: ['check-1'],
    nextReadyWorkIds: ['work-2'], leases: [lease()], usage: usage(),
    reserves: usage({ noncachedInput: 100, output: 20, workMs: 500 }),
    ...overrides,
  }
  const rawState = {
    schemaVersion: 1, kind: 'scheduler-crash-checkpoint', ownerSessionId: value.ownerSessionId,
    ...frontierProjection(value),
  }
  const bytes = Buffer.from(stableStringify(rawState), 'utf8')
  value.stateBytesBase64 = bytes.toString('base64')
  value.stateByteLength = bytes.length
  value.stateHash = rawHash(bytes)
  value.frontierHash = stableHash(frontierProjection(value))
  return value
}

function checkpoint(overrides = {}) {
  const schedulerValue = overrides.scheduler || scheduler()
  return {
    stateEvent: { sequence: 20, eventHash: H('event-20'), state: schedulerValue.phase, stateChecksum: H('state-20') },
    accounting: { lastAccountingSequence: 5, lastAccountingHash: H('accounting-5'), snapshotHash: H('budget-5') },
    scheduler: schedulerValue,
    recovery: recovery({
      frontier: {
        nextReadyWorkIds: [...schedulerValue.nextReadyWorkIds], openCheckIds: [...schedulerValue.openCheckIds],
        acceptedResultIds: ['result-work-0'],
      },
    }),
    immutableHashes: {
      requestEnvelopeHash: H('request'), routeDecisionHash: H('decision'), planHash: H('plan'),
      candidateHash: schedulerValue.candidate.candidateHash,
    },
    externalOperations: [{
      operationId: 'operation-1', status: 'COMMITTED_UNRECONCILED', idempotencyKey: 'idempotency-1',
      prepareReceiptHash: H('prepare-receipt'), commitReceiptHash: H('commit-receipt'),
      reconcileReceiptHash: null, rollbackReceiptHash: null, nextAction: 'RECONCILE',
    }],
    humanDescription: 'Resume the exact worker frontier through external reconciliation.',
    ...overrides,
  }
}

function record(overrides = {}) {
  const value = {
    schemaVersion: '2.0.0', authority: authority(), checkpoint: checkpoint(), checkpointPayloadHash: H('placeholder'),
    cause: { kind: 'THREAD_STARTED', causeId: 'thread:lease-1', humanDescription: 'Persist thread.started and its continuation.' },
    sequence: 1, previousHash: null, entryHash: H('placeholder'), occurredAt: '2026-08-22T01:00:01.000Z',
    ...overrides,
  }
  value.checkpointPayloadHash = stableHash(value.checkpoint)
  value.entryHash = stableHash(without(value, 'entryHash'))
  return value
}

function snapshot(lastRecord, overrides = {}) {
  const value = {
    schemaVersion: '2.0.0', authority: clone(lastRecord.authority),
    lastCheckpointSequence: lastRecord.sequence, lastCheckpointHash: lastRecord.entryHash,
    checkpoint: clone(lastRecord.checkpoint), checkpointPayloadHash: lastRecord.checkpointPayloadHash,
    snapshotHash: H('placeholder'), recordedAt: lastRecord.occurredAt, ...overrides,
  }
  value.snapshotHash = stableHash(without(value, 'snapshotHash'))
  return value
}

function nextRecord(previous) {
  const nextScheduler = scheduler({
    candidate: clone(previous.checkpoint.scheduler.candidate),
    completedWorkIds: [...previous.checkpoint.scheduler.completedWorkIds, 'work-1'],
    completedCheckIds: [...previous.checkpoint.scheduler.completedCheckIds],
    openCheckIds: ['check-1'], nextReadyWorkIds: ['work-3'], leases: [],
    usage: usage({ noncachedInput: 18, cachedInput: 25, output: 7, reasoning: 4, weightedCost: 54, latencyMs: 140, workMs: 120 }),
    reserves: usage({ noncachedInput: 30, cachedInput: 10, output: 4, reasoning: 2, weightedCost: 46, latencyMs: 80, workMs: 100 }),
  })
  const nextCheckpoint = checkpoint({
    scheduler: nextScheduler,
    stateEvent: clone(previous.checkpoint.stateEvent),
    accounting: { lastAccountingSequence: 6, lastAccountingHash: H('accounting-6'), snapshotHash: H('budget-6') },
    recovery: recovery({
      frontier: { nextReadyWorkIds: ['work-3'], openCheckIds: ['check-1'], acceptedResultIds: ['result-work-0', 'result-work-1'] },
    }),
    immutableHashes: clone(previous.checkpoint.immutableHashes),
  })
  return record({
    authority: clone(previous.authority), checkpoint: nextCheckpoint,
    cause: { kind: 'LEASE_COMPLETED', causeId: 'lease:lease-1', humanDescription: 'Persist completed work and release its reservation.' },
    sequence: previous.sequence + 1, previousHash: previous.entryHash, occurredAt: '2026-08-22T01:00:02.000Z',
  })
}

function pendingRecord() {
  const pendingScheduler = scheduler({
    route: 'PENDING', phase: 'SAVE_ROUTE_ANALYSIS',
    candidate: { candidateId: null, candidateHash: null, frozen: false },
    completedWorkIds: [], completedCheckIds: [], openCheckIds: [], nextReadyWorkIds: [], leases: [],
    usage: usage({ noncachedInput: 2, cachedInput: 0, output: 1, reasoning: 1, weightedCost: 4, latencyMs: 20, workMs: 15 }),
    reserves: usage({ noncachedInput: 50, cachedInput: 100, output: 10, reasoning: 5, weightedCost: 165, latencyMs: 80, workMs: 100 }),
  })
  const pendingCheckpoint = checkpoint({
    scheduler: pendingScheduler,
    stateEvent: { sequence: 10, eventHash: H('event-10'), state: 'SAVE_ROUTE_ANALYSIS', stateChecksum: H('state-10') },
    recovery: recovery({
      savedState: 'SAVE_ROUTE_ANALYSIS', resumeState: 'L0_ROUTE_DECISION',
      frontier: { nextReadyWorkIds: [], openCheckIds: [], acceptedResultIds: [H('route-recommendation')] },
      completedMilestones: ['route-analysis'],
      externalRecovery: { status: 'none', operationIds: [], idempotencyKeys: [], receiptHashes: [] },
    }),
    immutableHashes: {
      requestEnvelopeHash: H('request'), routeDecisionHash: null, planHash: null, candidateHash: null,
    },
    externalOperations: [],
    humanDescription: 'Resume after the analyst without inventing an L0 route decision.',
  })
  return record({
    checkpoint: pendingCheckpoint,
    cause: { kind: 'CHECKPOINT', causeId: 'post-analyst', humanDescription: 'Persist the completed route recommendation before L0.' },
  })
}

function resultCommittedRecord() {
  const value = record()
  const resultCommit = {
    assignmentId: 'work-1', assignmentHash: H('assignment-work-1'), leaseId: 'lease-1',
    sessionId: 'session-1', continuationId: 'continuation-1', resultHash: H('result-work-1'),
    receiptHash: H('terminal-receipt-work-1'), candidateHash: value.checkpoint.scheduler.candidate.candidateHash,
  }
  value.checkpoint.recovery.frontier.acceptedResultIds = [
    value.checkpoint.scheduler.stateHash, resultCommit.receiptHash,
  ]
  value.checkpoint.recovery.bindingHash = stableHash(without(value.checkpoint.recovery, 'bindingHash'))
  value.checkpointPayloadHash = stableHash(value.checkpoint)
  value.cause = {
    kind: 'RESULT_COMMITTED',
    causeId: `scheduler:1:lease-1:result:${resultCommit.receiptHash.slice(0, 24)}`,
    humanDescription: 'Persist the exact terminal result receipt before releasing its scheduler lease.',
    resultCommit,
  }
  value.entryHash = stableHash(without(value, 'entryHash'))
  return value
}

function setIncludes(left, right) {
  const available = new Set(left)
  return right.every(value => available.has(value))
}

function exactSet(left, right) {
  return left.length === right.length && new Set(left).size === left.length &&
    new Set(right).size === right.length && setIncludes(left, right) && setIncludes(right, left)
}

function resourcePhysicalId(resource) {
  const kind = resource.kind.toLowerCase()
  const prefix = `${kind}:`
  const unprefixed = resource.id.toLowerCase().startsWith(prefix)
    ? resource.id.slice(prefix.length)
    : resource.id
  if (!['workspace', 'cache', 'generated', 'temporary'].includes(kind)) {
    return { kind, physical: unprefixed, pathKind: false }
  }
  let physical = path.resolve(unprefixed)
  if (process.platform === 'win32') physical = physical.toLowerCase()
  return { kind, physical, pathKind: true }
}

function resourcesConflict(left, right) {
  const a = resourcePhysicalId(left)
  const b = resourcePhysicalId(right)
  if (a.kind !== b.kind || (left.mode === 'read' && right.mode === 'read')) return false
  if (!a.pathKind) return a.physical === b.physical
  const within = (parent, child) => {
    const relative = path.relative(parent, child)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }
  return within(a.physical, b.physical) || within(b.physical, a.physical)
}

function schedulerSemanticErrors(checkpointValue) {
  const errors = []
  const value = checkpointValue.scheduler
  let bytes
  let decoded
  try {
    bytes = Buffer.from(value.stateBytesBase64, 'base64')
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch {
    errors.push('scheduler state bytes are not canonical JSON')
    return errors
  }
  if (bytes.length !== value.stateByteLength) errors.push('scheduler state byte length mismatch')
  if (rawHash(bytes) !== value.stateHash) errors.push('scheduler state hash mismatch')
  if (stableStringify(decoded) !== bytes.toString('utf8')) errors.push('scheduler state bytes are not stable-json-v1')
  if (value.frontierHash !== stableHash(frontierProjection(value))) errors.push('scheduler frontier hash mismatch')
  for (const field of ['ownerSessionId', ...Object.keys(frontierProjection(value))]) {
    if (!isDeepStrictEqual(decoded[field], value[field])) errors.push(`scheduler bytes disagree on ${field}`)
  }
  if (checkpointValue.stateEvent.state !== value.phase) errors.push('phase does not match current canonical state')
  if (checkpointValue.immutableHashes.candidateHash !== value.candidate.candidateHash) errors.push('candidate hash alias mismatch')
  const preRoutePhases = ['START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION']
  if (value.route === 'PENDING') {
    if (!preRoutePhases.includes(value.phase) || value.candidate.candidateHash !== null ||
        checkpointValue.immutableHashes.routeDecisionHash !== null ||
        checkpointValue.immutableHashes.planHash !== null || checkpointValue.immutableHashes.candidateHash !== null) {
      errors.push('PENDING checkpoint invents decided-route authority')
    }
  } else if (preRoutePhases.includes(value.phase) || checkpointValue.immutableHashes.routeDecisionHash === null) {
    errors.push('decided route lacks L0 decision authority')
  }
  if (!isDeepStrictEqual(checkpointValue.recovery.frontier.nextReadyWorkIds, value.nextReadyWorkIds) ||
      !isDeepStrictEqual(checkpointValue.recovery.frontier.openCheckIds, value.openCheckIds)) {
    errors.push('recovery frontier differs from scheduler frontier')
  }
  const leaseIds = value.leases.map(item => item.leaseId)
  if (new Set(leaseIds).size !== leaseIds.length) errors.push('duplicate lease id')
  const workIds = value.leases.map(item => item.workItemId)
  if (new Set(workIds).size !== workIds.length) errors.push('duplicate open work item')
  for (const item of value.leases) {
    if (item.parentLeaseId !== null && !leaseIds.includes(item.parentLeaseId)) errors.push('missing parent lease')
    const resources = item.resources.map(resource => `${resource.kind}\0${resource.id}\0${resource.isolationId || ''}`)
    if (new Set(resources).size !== resources.length) errors.push('duplicate lease resource')
  }
  for (let leftIndex = 0; leftIndex < value.leases.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < value.leases.length; rightIndex += 1) {
      for (const left of value.leases[leftIndex].resources) {
        for (const right of value.leases[rightIndex].resources) {
          if (resourcesConflict(left, right)) errors.push('cross-lease resource conflict')
        }
      }
    }
  }
  if (value.completedWorkIds.some(id => value.nextReadyWorkIds.includes(id) || workIds.includes(id))) errors.push('completed work remains ready or open')
  if (value.completedCheckIds.some(id => value.openCheckIds.includes(id))) errors.push('completed check remains open')
  const operationIds = checkpointValue.externalOperations.map(item => item.operationId)
  const idempotencyKeys = checkpointValue.externalOperations.map(item => item.idempotencyKey)
  if (new Set(operationIds).size !== operationIds.length || new Set(idempotencyKeys).size !== idempotencyKeys.length) {
    errors.push('duplicate external operation or idempotency identity')
  }
  const unresolved = checkpointValue.externalOperations.filter(item =>
    ['COMMITTING', 'COMMITTED_UNRECONCILED'].includes(item.status))
  if (checkpointValue.recovery.externalRecovery.status === 'reconciliation-required') {
    const operationIds = unresolved.map(item => item.operationId)
    const keys = unresolved.map(item => item.idempotencyKey)
    const latestReceipts = unresolved.map(item => item.commitReceiptHash || item.prepareReceiptHash)
    const recovery = checkpointValue.recovery.externalRecovery
    if (latestReceipts.some(receipt => receipt === null) || new Set(latestReceipts).size !== latestReceipts.length ||
        !exactSet(operationIds, recovery.operationIds) || !exactSet(keys, recovery.idempotencyKeys) ||
        !exactSet(latestReceipts, recovery.receiptHashes)) {
      errors.push('external recovery is not a bijection over unresolved operation, idempotency, and latest receipt evidence')
    }
  } else if (unresolved.length > 0) {
    errors.push('unresolved external operation lacks recovery barrier')
  }
  if (checkpointValue.recovery.bindingHash !== stableHash(without(checkpointValue.recovery, 'bindingHash'))) {
    errors.push('recovery binding hash mismatch')
  }
  return errors
}

function resultCommitErrors(recordValue, receipt = null) {
  if (recordValue.cause.kind !== 'RESULT_COMMITTED') return []
  const errors = []
  const binding = recordValue.cause.resultCommit
  if (!binding) return ['RESULT_COMMITTED lacks its structured binding']
  const leaseValue = recordValue.checkpoint.scheduler.leases.find(item => item.leaseId === binding.leaseId)
  if (!leaseValue || leaseValue.status !== 'OPEN' || leaseValue.workItemId !== binding.assignmentId) {
    errors.push('result assignment does not bind its open lease')
  }
  if (!leaseValue || leaseValue.sessionId !== binding.sessionId || leaseValue.continuationId !== binding.continuationId) {
    errors.push('result session or continuation does not bind its open lease')
  }
  if (binding.candidateHash !== recordValue.checkpoint.immutableHashes.candidateHash ||
      binding.candidateHash !== recordValue.checkpoint.scheduler.candidate.candidateHash) {
    errors.push('result candidate does not bind the checkpoint candidate')
  }
  if (!recordValue.checkpoint.recovery.frontier.acceptedResultIds.includes(binding.receiptHash)) {
    errors.push('terminal receipt is absent from the accepted recovery frontier')
  }
  if (receipt) {
    for (const field of [
      'assignmentId', 'assignmentHash', 'leaseId', 'sessionId', 'continuationId',
      'resultHash', 'receiptHash', 'candidateHash',
    ]) {
      if (binding[field] !== receipt[field]) errors.push(`durable receipt mismatch ${field}`)
    }
  }
  return errors
}

function replayErrors(records, latest = {}) {
  const errors = []
  let previous = null
  for (const item of records) {
    if (item.authority.targetIdentityHash !== rawHash(Buffer.from(item.authority.targetIdentity, 'utf8'))) errors.push('target identity hash')
    if (item.authority.capabilityBindingHash !== stableHash(without(item.authority, 'capabilityBindingHash'))) errors.push('capability binding hash')
    if (item.checkpointPayloadHash !== stableHash(item.checkpoint)) errors.push('checkpoint payload hash')
    if (item.entryHash !== stableHash(without(item, 'entryHash'))) errors.push('entry hash')
    errors.push(...schedulerSemanticErrors(item.checkpoint))
    errors.push(...resultCommitErrors(item))
    if (previous) {
      if (item.sequence !== previous.sequence + 1) errors.push('sequence gap')
      if (item.previousHash !== previous.entryHash) errors.push('previous hash')
      for (const field of ['runId', 'activationId', 'activationNonce', 'missionHash', 'targetIdentity', 'targetIdentityHash']) {
        if (item.authority[field] !== previous.authority[field]) errors.push(`cross-binding ${field}`)
      }
      const generationDelta = item.authority.generation - previous.authority.generation
      if (![0, 1].includes(generationDelta) || (generationDelta === 1 && item.cause.kind !== 'CRASH_RECOVERY')) errors.push('generation transition')
      if (generationDelta === 0 && (item.authority.capabilityBindingHash !== previous.authority.capabilityBindingHash ||
          item.authority.providerCapabilitiesHash !== previous.authority.providerCapabilitiesHash)) errors.push('capability changed in generation')
      if (item.checkpoint.immutableHashes.requestEnvelopeHash !== previous.checkpoint.immutableHashes.requestEnvelopeHash) {
        errors.push('immutable requestEnvelopeHash')
      }
      for (const field of ['routeDecisionHash', 'planHash']) {
        const prior = previous.checkpoint.immutableHashes[field]
        const current = item.checkpoint.immutableHashes[field]
        if (prior !== null && current !== prior) errors.push(`immutable ${field}`)
      }
      const priorCandidate = previous.checkpoint.immutableHashes.candidateHash
      const nextCandidate = item.checkpoint.immutableHashes.candidateHash
      if (priorCandidate !== null && nextCandidate !== priorCandidate) errors.push('candidate changed after binding')
      if (item.checkpoint.stateEvent.sequence < previous.checkpoint.stateEvent.sequence) errors.push('state event rollback')
      if (item.checkpoint.stateEvent.sequence === previous.checkpoint.stateEvent.sequence &&
          item.checkpoint.stateEvent.eventHash !== previous.checkpoint.stateEvent.eventHash) errors.push('state event hash rewrite')
      if (item.checkpoint.accounting.lastAccountingSequence < previous.checkpoint.accounting.lastAccountingSequence) errors.push('accounting rollback')
      if (!setIncludes(item.checkpoint.scheduler.completedWorkIds, previous.checkpoint.scheduler.completedWorkIds)) errors.push('completed work rollback')
      if (!setIncludes(item.checkpoint.scheduler.completedCheckIds, previous.checkpoint.scheduler.completedCheckIds)) errors.push('completed check rollback')
      for (const field of Object.keys(item.checkpoint.scheduler.usage)) {
        if (item.checkpoint.scheduler.usage[field] < previous.checkpoint.scheduler.usage[field]) errors.push(`usage rollback ${field}`)
      }
    } else {
      if (item.sequence !== 1 || item.previousHash !== null) errors.push('invalid genesis')
    }
    previous = item
  }
  if (previous && latest.stateEvent && !isDeepStrictEqual(previous.checkpoint.stateEvent, latest.stateEvent)) errors.push('stale state event')
  if (previous && latest.accounting && !isDeepStrictEqual(previous.checkpoint.accounting, latest.accounting)) errors.push('stale accounting')
  return errors
}

function snapshotErrors(value, lastRecord) {
  const errors = []
  if (value.snapshotHash !== stableHash(without(value, 'snapshotHash'))) errors.push('snapshot hash')
  if (value.lastCheckpointSequence !== lastRecord.sequence || value.lastCheckpointHash !== lastRecord.entryHash) errors.push('snapshot rollback or ahead')
  if (!isDeepStrictEqual(value.authority, lastRecord.authority) || !isDeepStrictEqual(value.checkpoint, lastRecord.checkpoint) ||
      value.checkpointPayloadHash !== lastRecord.checkpointPayloadHash) errors.push('snapshot record mismatch')
  return errors
}

function exposeResumeCheckpoint(records, value, latest) {
  const errors = [...replayErrors(records, latest), ...snapshotErrors(value, records.at(-1))]
  if (errors.length > 0) throw Object.assign(new Error(errors.join('; ')), { code: 'RECOVERY_CHECKPOINT_INVALID', errors })
  return clone(value.checkpoint)
}

test('recovery checkpoint schemas are official Draft 2020-12 and reject structural mutations', () => {
  const first = record()
  const second = nextRecord(first)
  const preRoute = pendingRecord()
  const committed = resultCommittedRecord()
  const latestSnapshot = snapshot(second)
  assertDraftValid(RECORD_SCHEMA_PATH, [preRoute, first, second, committed])
  assertDraftValid(SNAPSHOT_SCHEMA_PATH, [snapshot(preRoute), latestSnapshot])

  const missingSession = clone(first)
  delete missingSession.checkpoint.scheduler.leases[0].sessionId
  const openWithoutReservation = clone(first)
  openWithoutReservation.checkpoint.scheduler.leases[0].reservationId = null
  const falseThreadWithReceipt = clone(first)
  falseThreadWithReceipt.checkpoint.scheduler.leases[0].thread.started = false
  const reconciledWithoutReceipt = clone(first)
  reconciledWithoutReceipt.checkpoint.externalOperations[0].status = 'RECONCILED'
  reconciledWithoutReceipt.checkpoint.externalOperations[0].nextAction = 'NONE'
  reconciledWithoutReceipt.checkpoint.externalOperations[0].reconcileReceiptHash = null
  const extraCheckpointField = clone(first)
  extraCheckpointField.checkpoint.unregistered = true
  const invalidTimestamp = clone(first)
  invalidTimestamp.occurredAt = 'not-a-date-time'
  const invalidRoute = clone(preRoute)
  invalidRoute.checkpoint.scheduler.route = 'DEFAULT'
  const pendingAfterDecision = clone(preRoute)
  pendingAfterDecision.checkpoint.scheduler.phase = 'RUN_WORK'
  pendingAfterDecision.checkpoint.stateEvent.state = 'RUN_WORK'
  const pendingWithInventedDecision = clone(preRoute)
  pendingWithInventedDecision.checkpoint.immutableHashes.routeDecisionHash = H('invented-decision')
  const committedWithoutBinding = clone(committed)
  delete committedWithoutBinding.cause.resultCommit
  const nonCommitWithBinding = clone(committed)
  nonCommitWithBinding.cause.kind = 'FRONTIER_CHANGED'
  const incompleteCommit = clone(committed)
  delete incompleteCommit.cause.resultCommit.assignmentHash
  const extraCommitBinding = clone(committed)
  extraCommitBinding.cause.resultCommit.unregistered = H('unregistered')
  assertDraftInvalid(RECORD_SCHEMA_PATH, [
    missingSession, openWithoutReservation, falseThreadWithReceipt,
    reconciledWithoutReceipt, extraCheckpointField, invalidTimestamp, invalidRoute,
    pendingAfterDecision, pendingWithInventedDecision, committedWithoutBinding,
    nonCommitWithBinding, incompleteCommit, extraCommitBinding,
  ])

  const missingLastHash = clone(latestSnapshot)
  delete missingLastHash.lastCheckpointHash
  const extraSnapshotField = clone(latestSnapshot)
  extraSnapshotField.secondCheckpoint = clone(first.checkpoint)
  const invalidSnapshotCheckpoint = clone(latestSnapshot)
  invalidSnapshotCheckpoint.checkpoint.scheduler.leases = [{ arbitrary: true }]
  assertDraftInvalid(SNAPSHOT_SCHEMA_PATH, [missingLastHash, extraSnapshotField, invalidSnapshotCheckpoint])
})

test('ROADMAP repair advances plan hash exactly once at the authenticated plan-recheck lease boundary', () => {
  const nullCandidate = { candidateId: null, candidateHash: null, frozen: false }
  const repairId = 'roadmap-author-plan-repair'
  const recheckId = 'roadmap-plan-recheck'
  const priorScheduler = scheduler({
    route: 'ROADMAP', phase: 'RUN_WORK', candidate: nullCandidate,
    completedWorkIds: ['roadmap-author', repairId], completedCheckIds: [],
    openCheckIds: [], nextReadyWorkIds: [recheckId], leases: [],
  })
  const priorRecovery = recovery({
    frontier: {
      nextReadyWorkIds: [recheckId], openCheckIds: [],
      acceptedResultIds: [priorScheduler.stateHash, H('repair-result-receipt')],
    },
  })
  const priorCheckpoint = checkpoint({
    scheduler: priorScheduler, recovery: priorRecovery,
    immutableHashes: {
      requestEnvelopeHash: H('request'), routeDecisionHash: H('decision'),
      planHash: H('plan-before-repair'), candidateHash: null,
    },
  })
  const prior = record({
    checkpoint: priorCheckpoint,
    cause: {
      kind: 'LEASE_COMPLETED', causeId: 'scheduler:1:repair:completed',
      humanDescription: 'Persist the completed authenticated ROADMAP repair.',
    },
  })

  const recheckLease = lease({
    leaseId: 'lease-roadmap-recheck', workItemId: recheckId,
    roleId: 'ap-independent-checker', status: 'ADMITTED',
    reservationId: 'reservation-roadmap-recheck', sessionId: 'session-roadmap-recheck',
    continuationId: 'continuation-roadmap-recheck', crashBindingHash: H('recheck-crash-binding'),
    resources: [{ id: 'workspace:C:/exact-target/plan/ROADMAP.md', kind: 'workspace', mode: 'read', isolationId: null }],
    usage: usage({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0, weightedCost: 0, latencyMs: 0, workMs: 0 }),
    reserves: usage({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0, weightedCost: 0, latencyMs: 0, workMs: 0 }),
    thread: { started: false, startedEventHash: null, startedAt: null },
  })
  const recheckScheduler = scheduler({
    route: 'ROADMAP', phase: 'RUN_WORK', candidate: nullCandidate,
    completedWorkIds: [...priorScheduler.completedWorkIds], completedCheckIds: [],
    openCheckIds: [recheckId], nextReadyWorkIds: [`reconcile:${recheckId}`], leases: [recheckLease],
  })
  const recheckRecovery = recovery({
    frontier: {
      nextReadyWorkIds: [`reconcile:${recheckId}`], openCheckIds: [recheckId],
      acceptedResultIds: [priorScheduler.stateHash, H('repair-result-receipt'), recheckScheduler.stateHash],
    },
  })
  const current = record({
    checkpoint: checkpoint({
      scheduler: recheckScheduler, recovery: recheckRecovery,
      immutableHashes: {
        requestEnvelopeHash: H('request'), routeDecisionHash: H('decision'),
        planHash: H('plan-after-repair'), candidateHash: null,
      },
    }),
    cause: {
      kind: 'LEASE_STARTED', causeId: 'scheduler:1:recheck:lease-started',
      humanDescription: 'Persist the repaired-plan recheck lease before spawning it.',
    },
    sequence: 2, previousHash: prior.entryHash, occurredAt: '2026-08-22T01:00:02.000Z',
  })
  const events = Array.from({ length: 20 })
  events[19] = {
    hash: H('event-20'), stateAfter: 'RUN_WORK',
    details: { stateEvent: { runId: current.authority.runId, activationNonce: current.authority.activationNonce } },
  }
  const checkpointAuthority = new RecoveryCheckpointAuthority({
    paths: {
      runRecordRoot: ROOT,
      logPath: path.join(ROOT, '.test-recovery-checkpoints', 'records.jsonl'),
      snapshotPath: path.join(ROOT, '.test-recovery-checkpoints', 'snapshot.json'),
    },
    capabilityVerifier: () => ({}), stateProvider: () => ({}),
    accountingCheckpointVerifier: value => value, accountingCheckpointProvider: () => ({}),
    roadmapPlanAdvanceVerifier: () => true,
    eventLog: { readAll: () => events },
  })
  const rehash = value => {
    value.checkpointPayloadHash = stableHash(value.checkpoint)
    value.entryHash = stableHash(without(value, 'entryHash'))
    return value
  }

  assert.equal(checkpointAuthority._validateRecord(current, prior), true)

  const revisionScheduler = scheduler({
    route: 'ROADMAP', phase: 'RUN_WORK', candidate: nullCandidate,
    completedWorkIds: ['roadmap-author', 'roadmap-author-revise'], completedCheckIds: [],
    openCheckIds: [], nextReadyWorkIds: ['roadmap-plan-check'], leases: [],
  })
  const revisionPrior = record({
    checkpoint: checkpoint({
      scheduler: revisionScheduler,
      recovery: recovery({ frontier: {
        nextReadyWorkIds: ['roadmap-plan-check'], openCheckIds: [],
        acceptedResultIds: [revisionScheduler.stateHash, H('revision-result-receipt')],
      } }),
      immutableHashes: {
        requestEnvelopeHash: H('request'), routeDecisionHash: H('decision'),
        planHash: H('plan-before-revision'), candidateHash: null,
      },
    }),
    cause: { kind: 'LEASE_COMPLETED', causeId: 'scheduler:1:revision:completed', humanDescription: 'revision completed' },
  })
  const planCheckLease = {
    ...recheckLease,
    leaseId: 'lease-roadmap-plan-check', workItemId: 'roadmap-plan-check',
    reservationId: 'reservation-roadmap-plan-check', sessionId: 'session-roadmap-plan-check',
    continuationId: 'continuation-roadmap-plan-check', crashBindingHash: H('plan-check-crash-binding'),
  }
  const planCheckScheduler = scheduler({
    route: 'ROADMAP', phase: 'RUN_WORK', candidate: nullCandidate,
    completedWorkIds: [...revisionScheduler.completedWorkIds], completedCheckIds: [],
    openCheckIds: ['roadmap-plan-check'], nextReadyWorkIds: ['reconcile:roadmap-plan-check'], leases: [planCheckLease],
  })
  const revisionCurrent = record({
    checkpoint: checkpoint({
      scheduler: planCheckScheduler,
      recovery: recovery({ frontier: {
        nextReadyWorkIds: ['reconcile:roadmap-plan-check'], openCheckIds: ['roadmap-plan-check'],
        acceptedResultIds: [revisionScheduler.stateHash, H('revision-result-receipt'), planCheckScheduler.stateHash],
      } }),
      immutableHashes: {
        requestEnvelopeHash: H('request'), routeDecisionHash: H('decision'),
        planHash: H('plan-after-revision'), candidateHash: null,
      },
    }),
    cause: { kind: 'LEASE_STARTED', causeId: 'scheduler:1:plan-check:lease-started', humanDescription: 'plan check admitted' },
    sequence: 2, previousHash: revisionPrior.entryHash, occurredAt: '2026-08-22T01:00:02.000Z',
  })
  assert.equal(checkpointAuthority._validateRecord(revisionCurrent, revisionPrior), true)

  const unverifiedAuthority = new RecoveryCheckpointAuthority({
    paths: {
      runRecordRoot: ROOT,
      logPath: path.join(ROOT, '.test-recovery-checkpoints', 'unverified-records.jsonl'),
      snapshotPath: path.join(ROOT, '.test-recovery-checkpoints', 'unverified-snapshot.json'),
    },
    capabilityVerifier: () => ({}), stateProvider: () => ({}),
    accountingCheckpointVerifier: value => value, accountingCheckpointProvider: () => ({}),
    roadmapPlanAdvanceVerifier: () => false,
    eventLog: { readAll: () => events },
  })
  assert.throws(
    () => unverifiedAuthority._validateRecord(current, prior),
    error => error.code === 'RECOVERY_CHECKPOINT_ROLLBACK' && /planHash/.test(error.message),
  )

  const crashProjection = clone(current)
  crashProjection.checkpoint.scheduler = clone(prior.checkpoint.scheduler)
  crashProjection.checkpoint.recovery = clone(prior.checkpoint.recovery)
  crashProjection.checkpoint.stateEvent = clone(prior.checkpoint.stateEvent)
  crashProjection.cause = {
    kind: 'CRASH_RECOVERY', causeId: 'crash-restored:2',
    humanDescription: 'Persist the authenticated repaired plan projection after crash adoption.',
  }
  rehash(crashProjection)
  assert.equal(checkpointAuthority._validateRecord(crashProjection, prior), true)

  const committedProjection = clone(current)
  committedProjection.checkpoint.scheduler = clone(prior.checkpoint.scheduler)
  committedProjection.checkpoint.recovery = clone(prior.checkpoint.recovery)
  committedProjection.checkpoint.stateEvent = clone(prior.checkpoint.stateEvent)
  committedProjection.cause = {
    kind: 'PLAN_PROJECTION_COMMITTED', causeId: 'plan-projection:1:roadmap-author-plan-repair',
    humanDescription: 'Persist the authenticated repaired plan projection before its recheck.',
  }
  rehash(committedProjection)
  assert.equal(checkpointAuthority._validateRecord(committedProjection, prior), true)

  const committedWithChangedState = clone(committedProjection)
  committedWithChangedState.checkpoint.stateEvent.eventHash = H('foreign-plan-commit-event')
  rehash(committedWithChangedState)
  assert.throws(
    () => checkpointAuthority._validateRecord(committedWithChangedState, prior),
    error => [
      'RECOVERY_CHECKPOINT_INVALID', 'RECOVERY_CHECKPOINT_ROLLBACK',
      'RECOVERY_CHECKPOINT_STATE_INVALID', 'RECOVERY_CHECKPOINT_STATE_UNBOUND',
    ].includes(error.code),
  )

  const crashWithChangedScheduler = clone(crashProjection)
  crashWithChangedScheduler.checkpoint.scheduler.nextReadyWorkIds = ['foreign-work']
  rehash(crashWithChangedScheduler)
  assert.throws(
    () => checkpointAuthority._validateRecord(crashWithChangedScheduler, prior),
    error => ['RECOVERY_CHECKPOINT_INVALID', 'RECOVERY_CHECKPOINT_ROLLBACK'].includes(error.code),
  )

  const arbitrary = clone(current)
  arbitrary.cause = { ...arbitrary.cause, kind: 'CHECKPOINT', causeId: 'arbitrary-plan-change' }
  rehash(arbitrary)
  assert.throws(
    () => checkpointAuthority._validateRecord(arbitrary, prior),
    error => error.code === 'RECOVERY_CHECKPOINT_ROLLBACK' && /planHash/.test(error.message),
  )

  const changedRouteDecision = clone(current)
  changedRouteDecision.checkpoint.immutableHashes.routeDecisionHash = H('changed-decision')
  rehash(changedRouteDecision)
  assert.throws(
    () => checkpointAuthority._validateRecord(changedRouteDecision, prior),
    error => error.code === 'RECOVERY_CHECKPOINT_ROLLBACK' && /routeDecisionHash/.test(error.message),
  )

  const repeated = clone(current)
  repeated.sequence = 3
  repeated.previousHash = current.entryHash
  repeated.occurredAt = '2026-08-22T01:00:03.000Z'
  repeated.checkpoint.immutableHashes.planHash = H('second-plan-advance')
  repeated.cause.causeId = 'scheduler:1:recheck:repeated-lease-started'
  rehash(repeated)
  assert.throws(
    () => checkpointAuthority._validateRecord(repeated, current),
    error => error.code === 'RECOVERY_CHECKPOINT_ROLLBACK' && /planHash/.test(error.message),
  )
})

test('replay accepts one exact checkpoint and rejects gaps, tamper, rollback, cross-run, and stale accounting', () => {
  const first = record()
  const second = nextRecord(first)
  const latest = { stateEvent: clone(second.checkpoint.stateEvent), accounting: clone(second.checkpoint.accounting) }
  const currentSnapshot = snapshot(second)
  assert.deepEqual(replayErrors([first, second], latest), [])
  const exposed = exposeResumeCheckpoint([first, second], currentSnapshot, latest)
  assert.deepEqual(exposed, second.checkpoint)
  assert.equal(Array.isArray(exposed), false, 'one atomic snapshot exposes one resume checkpoint')

  const mutations = []
  const gap = clone(second)
  gap.sequence = 3
  gap.entryHash = stableHash(without(gap, 'entryHash'))
  mutations.push([first, gap])
  const wrongPrevious = clone(second)
  wrongPrevious.previousHash = H('forged-previous')
  wrongPrevious.entryHash = stableHash(without(wrongPrevious, 'entryHash'))
  mutations.push([first, wrongPrevious])
  const crossRun = clone(second)
  crossRun.authority = authority({ runId: 'foreign-run-0001' })
  crossRun.entryHash = stableHash(without(crossRun, 'entryHash'))
  mutations.push([first, crossRun])
  const stateRollback = clone(second)
  stateRollback.checkpoint.stateEvent.sequence = 19
  stateRollback.checkpointPayloadHash = stableHash(stateRollback.checkpoint)
  stateRollback.entryHash = stableHash(without(stateRollback, 'entryHash'))
  mutations.push([first, stateRollback])
  const accountingRollback = clone(second)
  accountingRollback.checkpoint.accounting = {
    lastAccountingSequence: 4, lastAccountingHash: H('accounting-4'), snapshotHash: H('budget-4'),
  }
  accountingRollback.checkpointPayloadHash = stableHash(accountingRollback.checkpoint)
  accountingRollback.entryHash = stableHash(without(accountingRollback, 'entryHash'))
  mutations.push([first, accountingRollback])
  const usageRollback = clone(second)
  usageRollback.checkpoint.scheduler.usage.output = 1
  usageRollback.checkpoint.scheduler = scheduler({ ...usageRollback.checkpoint.scheduler, usage: usageRollback.checkpoint.scheduler.usage })
  usageRollback.checkpointPayloadHash = stableHash(usageRollback.checkpoint)
  usageRollback.entryHash = stableHash(without(usageRollback, 'entryHash'))
  mutations.push([first, usageRollback])
  for (const records of mutations) assert.notDeepEqual(replayErrors(records), [])

  const staleAccounting = { ...latest, accounting: { ...latest.accounting, lastAccountingSequence: 7, lastAccountingHash: H('accounting-7'), snapshotHash: H('budget-7') } }
  assert.throws(() => exposeResumeCheckpoint([first, second], currentSnapshot, staleAccounting), /stale accounting/)
  const rollbackSnapshot = snapshot(first)
  assert.throws(() => exposeResumeCheckpoint([first, second], rollbackSnapshot, latest), /snapshot rollback or ahead|snapshot record mismatch/)
  const tamperedSnapshot = clone(currentSnapshot)
  tamperedSnapshot.checkpoint.humanDescription = 'tampered but well-formed'
  assert.throws(() => exposeResumeCheckpoint([first, second], tamperedSnapshot, latest), /snapshot hash|snapshot record mismatch/)
})

test('semantic mutations cannot alias candidate, scheduler bytes/frontier, leases, resources, or external recovery', () => {
  const base = record()
  const mutations = []
  const candidateAlias = clone(base.checkpoint)
  candidateAlias.immutableHashes.candidateHash = H('different-candidate')
  mutations.push(candidateAlias)
  const bytesTamper = clone(base.checkpoint)
  bytesTamper.scheduler.stateBytesBase64 = Buffer.from('{}').toString('base64')
  bytesTamper.scheduler.stateByteLength = 2
  bytesTamper.scheduler.stateHash = rawHash(Buffer.from('{}'))
  mutations.push(bytesTamper)
  const frontierTamper = clone(base.checkpoint)
  frontierTamper.scheduler.nextReadyWorkIds = ['different-work']
  mutations.push(frontierTamper)
  const duplicateLease = clone(base.checkpoint)
  duplicateLease.scheduler.leases.push(clone(duplicateLease.scheduler.leases[0]))
  mutations.push(duplicateLease)
  const duplicateResource = clone(base.checkpoint)
  duplicateResource.scheduler.leases[0].resources.push(clone(duplicateResource.scheduler.leases[0].resources[0]))
  mutations.push(duplicateResource)
  const completedStillOpen = clone(base.checkpoint)
  completedStillOpen.scheduler.completedWorkIds.push('work-1')
  mutations.push(completedStillOpen)
  const missingReconciliation = clone(base.checkpoint)
  missingReconciliation.recovery.externalRecovery = { status: 'none', operationIds: [], idempotencyKeys: [], receiptHashes: [] }
  missingReconciliation.recovery.bindingHash = stableHash(without(missingReconciliation.recovery, 'bindingHash'))
  mutations.push(missingReconciliation)
  for (const mutation of mutations) assert.notDeepEqual(schedulerSemanticErrors(mutation), [])
})

test('unresolved external recovery is an exact operation, key, and latest-receipt bijection', () => {
  const base = record().checkpoint
  assert.deepEqual(schedulerSemanticErrors(base), [])

  const unresolvedStrictSuperset = clone(base)
  unresolvedStrictSuperset.externalOperations.push({
    operationId: 'operation-2', status: 'COMMITTED_UNRECONCILED', idempotencyKey: 'idempotency-2',
    prepareReceiptHash: H('prepare-receipt-2'), commitReceiptHash: H('commit-receipt-2'),
    reconcileReceiptHash: null, rollbackReceiptHash: null, nextAction: 'RECONCILE',
  })
  unresolvedStrictSuperset.recovery.bindingHash = stableHash(without(unresolvedStrictSuperset.recovery, 'bindingHash'))
  assert.match(schedulerSemanticErrors(unresolvedStrictSuperset).join('; '), /not a bijection/)

  const recoveryStrictSuperset = clone(base)
  recoveryStrictSuperset.recovery.externalRecovery.operationIds.push('operation-ghost')
  recoveryStrictSuperset.recovery.externalRecovery.idempotencyKeys.push('idempotency-ghost')
  recoveryStrictSuperset.recovery.externalRecovery.receiptHashes.push(H('receipt-ghost'))
  recoveryStrictSuperset.recovery.bindingHash = stableHash(without(recoveryStrictSuperset.recovery, 'bindingHash'))
  assert.match(schedulerSemanticErrors(recoveryStrictSuperset).join('; '), /not a bijection/)

  const duplicateLatestReceipt = clone(base)
  duplicateLatestReceipt.externalOperations.push({
    operationId: 'operation-2', status: 'COMMITTED_UNRECONCILED', idempotencyKey: 'idempotency-2',
    prepareReceiptHash: H('prepare-receipt-2'), commitReceiptHash: H('commit-receipt'),
    reconcileReceiptHash: null, rollbackReceiptHash: null, nextAction: 'RECONCILE',
  })
  duplicateLatestReceipt.recovery.externalRecovery.operationIds.push('operation-2')
  duplicateLatestReceipt.recovery.externalRecovery.idempotencyKeys.push('idempotency-2')
  duplicateLatestReceipt.recovery.bindingHash = stableHash(without(duplicateLatestReceipt.recovery, 'bindingHash'))
  assert.match(schedulerSemanticErrors(duplicateLatestReceipt).join('; '), /not a bijection/)
})

test('RESULT_COMMITTED binds the exact assignment, lease session, result receipt, and candidate', () => {
  const committed = resultCommittedRecord()
  const receipt = clone(committed.cause.resultCommit)
  assert.deepEqual(resultCommitErrors(committed, receipt), [])

  for (const [field, changed] of [
    ['assignmentId', 'other-assignment'],
    ['assignmentHash', H('other-assignment')],
    ['leaseId', 'other-lease'],
    ['sessionId', 'other-session'],
    ['continuationId', 'other-continuation'],
    ['resultHash', H('other-result')],
    ['receiptHash', H('other-receipt')],
    ['candidateHash', H('other-candidate')],
  ]) {
    const mutation = clone(committed)
    mutation.cause.resultCommit[field] = changed
    assert.notDeepEqual(resultCommitErrors(mutation, receipt), [], `${field} mutation must fail semantic binding`)
  }

  const noFrontierReceipt = clone(committed)
  noFrontierReceipt.checkpoint.recovery.frontier.acceptedResultIds = [noFrontierReceipt.checkpoint.scheduler.stateHash]
  noFrontierReceipt.checkpoint.recovery.bindingHash = stableHash(without(noFrontierReceipt.checkpoint.recovery, 'bindingHash'))
  assert.match(resultCommitErrors(noFrontierReceipt, receipt).join('; '), /absent from the accepted recovery frontier/)

  const releasedBeforeCommit = clone(committed)
  releasedBeforeCommit.checkpoint.scheduler.leases[0].status = 'ADMITTED'
  assert.match(resultCommitErrors(releasedBeforeCommit, receipt).join('; '), /does not bind its open lease/)
})

test('global lease resources reject exact and ancestor exclusive conflicts regardless of isolation while read/read is allowed', () => {
  const base = record().checkpoint
  const secondLease = resource => lease({
    leaseId: 'lease-2', workItemId: 'work-3', reservationId: 'reservation-2', sessionId: 'session-2',
    continuationId: 'continuation-2', crashBindingHash: H('crash-binding-2'), resources: [resource],
    thread: { started: true, startedEventHash: H('thread-started-2'), startedAt: '2026-08-22T01:00:00.500Z' },
  })

  const exactConflict = clone(base)
  exactConflict.scheduler.leases[0].resources[0].isolationId = 'isolation-a'
  exactConflict.scheduler = scheduler({
    ...exactConflict.scheduler,
    leases: [exactConflict.scheduler.leases[0], secondLease({
      id: exactConflict.scheduler.leases[0].resources[0].id,
      kind: 'workspace', mode: 'read', isolationId: 'isolation-b',
    })],
  })
  assert.ok(schedulerSemanticErrors(exactConflict).includes('cross-lease resource conflict'))

  const ancestorConflict = clone(base)
  ancestorConflict.scheduler.leases[0].resources = [{
    id: 'workspace:C:/exact-target', kind: 'workspace', mode: 'exclusive', isolationId: 'parent-isolation',
  }]
  ancestorConflict.scheduler = scheduler({
    ...ancestorConflict.scheduler,
    leases: [ancestorConflict.scheduler.leases[0], secondLease({
      id: 'workspace:C:/exact-target/nested/file.js', kind: 'workspace', mode: 'read', isolationId: 'child-isolation',
    })],
  })
  assert.ok(schedulerSemanticErrors(ancestorConflict).includes('cross-lease resource conflict'))

  const readRead = clone(ancestorConflict)
  readRead.scheduler.leases[0].resources[0].mode = 'read'
  readRead.scheduler = scheduler({ ...readRead.scheduler, leases: readRead.scheduler.leases })
  assert.deepEqual(schedulerSemanticErrors(readRead), [])
})

test('product and run-record contracts register the independent atomic recovery authority', () => {
  const product = readJson('agents/contracts/product.json')
  const productSchema = readJson('agents/contracts/schemas/product.schema.json')
  const runRecordSchema = readJson('agents/contracts/schemas/run-record.schema.json')
  assertDraftValid(path.join(ROOT, 'agents', 'contracts', 'schemas', 'product.schema.json'), [product])
  assert.equal(product.runtimeSchemas.recoveryCheckpointRecord,
    'agents/contracts/schemas/recovery-checkpoint-record.schema.json')
  assert.equal(product.runtimeSchemas.recoveryCheckpointSnapshot,
    'agents/contracts/schemas/recovery-checkpoint-snapshot.schema.json')
  assert.equal(product.runtimeRecoveryCheckpointPolicy.recordPath, 'runtime/recovery-checkpoints.jsonl')
  assert.equal(product.runtimeRecoveryCheckpointPolicy.snapshotPath, 'runtime/recovery-checkpoint.json')
  assert.deepEqual(product.runtimeRecoveryCheckpointPolicy.commitOrder, [
    'append-complete-record-and-newline', 'sync-record-log', 'write-and-sync-temporary-snapshot',
    'atomically-replace-snapshot', 'sync-containing-directory',
  ])
  assert.equal(product.runtimeRecoveryCheckpointPolicy.oneResumeCheckpoint, true)
  assert.ok(productSchema.required.includes('runtimeRecoveryCheckpointPolicy'))
  assert.ok(runRecordSchema.properties.paths.required.includes('recoveryCheckpointRecords'))
  assert.ok(runRecordSchema.properties.paths.required.includes('recoveryCheckpointSnapshot'))
  assert.equal(runRecordSchema.properties.paths.properties.recoveryCheckpointRecords.const,
    'runtime/recovery-checkpoints.jsonl')
  assert.equal(runRecordSchema.properties.paths.properties.recoveryCheckpointSnapshot.const,
    'runtime/recovery-checkpoint.json')
  const recordSchema = readJson('agents/contracts/schemas/recovery-checkpoint-record.schema.json')
  const snapshotSchema = readJson('agents/contracts/schemas/recovery-checkpoint-snapshot.schema.json')
  assert.match(recordSchema['x-autopromptDurability'].visibilityBarrier, /thread\.started/)
  assert.match(recordSchema['x-autopromptDurability'].staleAccountingPolicy, /resume is rejected/)
  assert.match(recordSchema['x-autopromptCheckpointHash'].t077Mapping, /not state-event recoveryContext\.checkpointHash/)
  assert.match(snapshotSchema['x-autopromptAtomicSnapshot'].replayPolicy, /stale or ahead snapshot/)
})
