'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const {
  canonicalStringify,
  digestRecord,
  exactKeys,
  fail,
  hashPattern,
  isoDate,
  nonEmpty,
  positiveInteger,
  readChecksummedJson,
  writeChecksummedJson,
} = require('./core.cjs')
const { verifyAggregateReport } = require('./aggregate.cjs')
const { normalizeEvidencePath, readVerifiedJson, validateBlobDescriptor } = require('./files.cjs')
const { requireRoleDigest, signRoleDigest } = require('./trust-registry.cjs')

const STATES = Object.freeze(['PENDING', 'UPLOADING', 'RETRY_WAIT', 'UPLOADED', 'EVIDENCE_INCOMPLETE'])
const LOCK_STALE_MS = 30000

function objectsDigest(objects) { return digestRecord({ objects }) }

function signUploadReceipt(spool, input) {
  if (!input || !input.signer) fail('UPLOAD_RECEIPT_INVALID', 'asymmetric provider receipt signer is required')
  const unsigned = {
    provider: input.provider,
    objectVersion: input.objectVersion,
    manifestDigest: spool.manifestDigest,
    objectsDigest: objectsDigest(spool.objects),
    uploadedAt: input.uploadedAt,
    algorithm: 'ed25519',
    issuer: input.signer.issuer,
    keyId: input.signer.keyId,
  }
  for (const field of ['provider', 'objectVersion', 'issuer', 'keyId']) nonEmpty(unsigned[field], 'UPLOAD_RECEIPT_INVALID', field)
  isoDate(unsigned.uploadedAt, 'UPLOAD_RECEIPT_INVALID', 'uploadedAt')
  const signature = signRoleDigest('provider-receipt', digestRecord(unsigned), unsigned.uploadedAt, input.signer).value
  return Object.freeze({ ...unsigned, signature })
}

function verifyUploadReceipt(spool, trustRegistry) {
  const receipt = spool.receipt
  if (!receipt || !trustRegistry) return false
  try {
    const fields = ['provider', 'objectVersion', 'manifestDigest', 'objectsDigest', 'uploadedAt', 'algorithm', 'issuer', 'keyId', 'signature']
    exactKeys(receipt, fields, 'UPLOAD_RECEIPT_INVALID', 'upload receipt')
    if (fields.some(field => !Object.hasOwn(receipt, field)) || receipt.algorithm !== 'ed25519') return false
    if (receipt.manifestDigest !== spool.manifestDigest || receipt.objectsDigest !== objectsDigest(spool.objects)) return false
    const unsigned = { ...receipt }; delete unsigned.signature
    const signature = { algorithm: receipt.algorithm, issuer: receipt.issuer, keyId: receipt.keyId, value: receipt.signature }
    requireRoleDigest(trustRegistry, 'provider-receipt', digestRecord(unsigned), receipt.uploadedAt, signature, 'UPLOAD_RECEIPT_INVALID')
    return true
  } catch { return false }
}

function validateSpool(record, options = {}) {
  const fields = ['schemaVersion', 'spoolId', 'manifestDigest', 'objects', 'maxAttempts', 'attempts', 'baseBackoffMs', 'maxBackoffMs', 'state', 'claim', 'nextAttemptAt', 'lastError', 'receipt', 'updatedAt', 'checksum']
  exactKeys(record, fields, 'UPLOAD_SPOOL_INVALID', 'upload spool')
  if (fields.some(field => !Object.hasOwn(record, field))) fail('UPLOAD_SPOOL_INVALID', 'upload spool has missing fields')
  if (record.schemaVersion !== 'benchmark-upload-spool.v2') fail('UPLOAD_SPOOL_INVALID', 'unsupported upload spool schema')
  if (!hashPattern(record.checksum) || record.checksum !== digestRecord(record, ['checksum'])) fail('UPLOAD_SPOOL_CHECKSUM_INVALID', 'upload spool checksum is invalid')
  nonEmpty(record.spoolId, 'UPLOAD_SPOOL_INVALID', 'spoolId')
  if (!hashPattern(record.manifestDigest)) fail('UPLOAD_SPOOL_INVALID', 'manifestDigest must be sha256')
  for (const field of ['maxAttempts', 'baseBackoffMs', 'maxBackoffMs']) positiveInteger(record[field], 'UPLOAD_SPOOL_INVALID', field)
  positiveInteger(record.attempts, 'UPLOAD_SPOOL_INVALID', 'attempts', { allowZero: true })
  if (record.maxBackoffMs < record.baseBackoffMs || record.attempts > record.maxAttempts || !STATES.includes(record.state)) fail('UPLOAD_SPOOL_INVALID', 'upload spool limits or state are invalid')
  if (!Array.isArray(record.objects) || !record.objects.length) fail('UPLOAD_SPOOL_INVALID', 'upload spool objects are required')
  const paths = new Set()
  for (const object of record.objects) {
    exactKeys(object, ['digest', 'relativePath'], 'UPLOAD_SPOOL_INVALID', 'upload object')
    try { normalizeEvidencePath(object.relativePath) } catch { fail('UPLOAD_SPOOL_INVALID', 'upload object path is unsafe') }
    if (!hashPattern(object.digest)) fail('UPLOAD_SPOOL_INVALID', 'upload object is invalid')
    if (paths.has(object.relativePath)) fail('UPLOAD_SPOOL_INVALID', 'duplicate upload object path')
    paths.add(object.relativePath)
  }
  isoDate(record.updatedAt, 'UPLOAD_SPOOL_INVALID', 'updatedAt')
  isoDate(record.nextAttemptAt, 'UPLOAD_SPOOL_INVALID', 'nextAttemptAt', { nullable: true })
  if (record.claim !== null) {
    exactKeys(record.claim, ['claimId', 'ownerPid', 'claimedAt'], 'UPLOAD_SPOOL_INVALID', 'upload claim')
    nonEmpty(record.claim.claimId, 'UPLOAD_SPOOL_INVALID', 'claimId')
    positiveInteger(record.claim.ownerPid, 'UPLOAD_SPOOL_INVALID', 'ownerPid')
    isoDate(record.claim.claimedAt, 'UPLOAD_SPOOL_INVALID', 'claimedAt')
  }
  if (record.lastError !== null) {
    exactKeys(record.lastError, ['code', 'at'], 'UPLOAD_SPOOL_INVALID', 'lastError')
    nonEmpty(record.lastError.code, 'UPLOAD_SPOOL_INVALID', 'lastError.code')
    isoDate(record.lastError.at, 'UPLOAD_SPOOL_INVALID', 'lastError.at')
  }
  if (record.state === 'PENDING' && (record.claim || record.nextAttemptAt || record.receipt || record.attempts >= record.maxAttempts)) fail('UPLOAD_SPOOL_INVALID', 'pending upload state is inconsistent')
  if (record.state === 'UPLOADING' && (!record.claim || record.nextAttemptAt || record.receipt || record.attempts < 1)) fail('UPLOAD_SPOOL_INVALID', 'uploading state is inconsistent')
  if (record.state === 'RETRY_WAIT' && (record.claim || !record.nextAttemptAt || !record.lastError || record.receipt || record.attempts >= record.maxAttempts)) fail('UPLOAD_SPOOL_INVALID', 'retry state is inconsistent')
  if (record.state === 'EVIDENCE_INCOMPLETE' && (record.claim || record.nextAttemptAt || !record.lastError || record.receipt || record.attempts !== record.maxAttempts)) fail('UPLOAD_SPOOL_INVALID', 'terminal incomplete state is inconsistent')
  if (record.state === 'UPLOADED' && (record.claim || record.nextAttemptAt || !record.receipt || record.lastError || record.attempts < 1)) fail('UPLOAD_SPOOL_INVALID', 'uploaded state is inconsistent')
  if (record.state === 'UPLOADED' && !verifyUploadReceipt(record, options.trustRegistry)) fail('UPLOAD_RECEIPT_INVALID', 'uploaded spool receipt is not authenticated and content-bound')
  return record
}

function lockPath(filename) { return `${filename}.lock` }

function withSpoolLock(filename, operation, options = {}) {
  const lock = lockPath(filename)
  let descriptor
  try {
    try { descriptor = fs.openSync(lock, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const stats = fs.statSync(lock)
      if ((options.nowMs || Date.now()) - stats.mtimeMs <= (options.lockStaleMs || LOCK_STALE_MS)) fail('UPLOAD_SPOOL_BUSY', 'upload spool is owned by another process')
      fs.unlinkSync(lock)
      descriptor = fs.openSync(lock, 'wx', 0o600)
    }
    fs.writeFileSync(descriptor, `${process.pid}\n`)
    fs.fsyncSync(descriptor)
    return operation()
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
    if (descriptor !== undefined) try { fs.unlinkSync(lock) } catch {}
  }
}

function createUploadSpool(filename, input) {
  if (!input || fs.existsSync(filename)) fail(fs.existsSync(filename) ? 'UPLOAD_SPOOL_EXISTS' : 'UPLOAD_SPOOL_INVALID', 'upload spool input is invalid or already exists')
  const now = input.now || new Date().toISOString()
  const record = {
    schemaVersion: 'benchmark-upload-spool.v2', spoolId: input.spoolId, manifestDigest: input.manifestDigest,
    objects: input.objects, maxAttempts: input.maxAttempts, attempts: 0,
    baseBackoffMs: input.baseBackoffMs, maxBackoffMs: input.maxBackoffMs,
    state: 'PENDING', claim: null, nextAttemptAt: null, lastError: null, receipt: null, updatedAt: now,
  }
  const sealed = { ...record, checksum: digestRecord(record) }
  validateSpool(sealed)
  return writeChecksummedJson(filename, record)
}

function loadUploadSpool(filename, options = {}) { return validateSpool(readChecksummedJson(filename, { code: 'UPLOAD_SPOOL_CHECKSUM_INVALID' }), options) }
function save(filename, record) { const unsigned = { ...record }; delete unsigned.checksum; return writeChecksummedJson(filename, unsigned) }

function claimUpload(filename, options = {}) {
  return withSpoolLock(filename, () => {
    const record = loadUploadSpool(filename)
    if (record.state !== 'PENDING') fail('UPLOAD_STATE_INVALID', `cannot claim upload from ${record.state}`)
    const claimedAt = options.now || new Date().toISOString()
    const claimId = options.claimId || crypto.randomUUID()
    nonEmpty(claimId, 'UPLOAD_CLAIM_INVALID', 'claimId')
    record.state = 'UPLOADING'; record.attempts += 1
    record.claim = { claimId, ownerPid: options.ownerPid || process.pid, claimedAt }
    record.updatedAt = claimedAt
    return save(filename, record)
  }, options)
}

function assertClaim(record, options) {
  if (!record.claim || !options.claimId || record.claim.claimId !== options.claimId) fail('UPLOAD_CLAIM_INVALID', 'upload completion does not own the durable claim')
}

function recordUploadFailure(filename, options = {}) {
  return withSpoolLock(filename, () => {
    const record = loadUploadSpool(filename)
    if (record.state !== 'UPLOADING') fail('UPLOAD_STATE_INVALID', `cannot fail upload from ${record.state}`)
    assertClaim(record, options); nonEmpty(options.code, 'UPLOAD_FAILURE_INVALID', 'failure code')
    const at = options.now || new Date().toISOString()
    record.lastError = { code: options.code, at }; record.claim = null; record.updatedAt = at
    if (record.attempts >= record.maxAttempts) {
      record.state = 'EVIDENCE_INCOMPLETE'; record.nextAttemptAt = null
    } else {
      const backoff = Math.min(record.maxBackoffMs, record.baseBackoffMs * (2 ** (record.attempts - 1)))
      record.state = 'RETRY_WAIT'; record.nextAttemptAt = new Date(Date.parse(at) + backoff).toISOString()
    }
    return save(filename, record)
  }, options)
}

function requeueUpload(filename, options = {}) {
  return withSpoolLock(filename, () => {
    const record = loadUploadSpool(filename)
    if (record.state !== 'RETRY_WAIT') fail('UPLOAD_STATE_INVALID', `cannot requeue upload from ${record.state}`)
    const now = options.now || new Date().toISOString()
    if (Date.parse(now) < Date.parse(record.nextAttemptAt)) fail('UPLOAD_BACKOFF_ACTIVE', 'upload retry backoff has not elapsed')
    record.state = 'PENDING'; record.nextAttemptAt = null; record.updatedAt = now
    return save(filename, record)
  }, options)
}

function uploadHealth(record, options = {}) {
  validateSpool(record, { trustRegistry: options.trustRegistry })
  const now = Date.parse(options.now || new Date().toISOString())
  const stale = record.state === 'UPLOADING' && now - Date.parse(record.claim.claimedAt) > (options.claimLeaseMs || LOCK_STALE_MS)
  return Object.freeze({ healthy: !stale && record.state !== 'EVIDENCE_INCOMPLETE', stale, state: record.state, nextAttemptAt: record.nextAttemptAt })
}

function recoverStaleUpload(filename, options = {}) {
  return withSpoolLock(filename, () => {
    const record = loadUploadSpool(filename)
    const health = uploadHealth(record, options)
    if (!health.stale) fail('UPLOAD_NOT_STALE', 'upload claim is not stale')
    const at = options.now || new Date().toISOString()
    record.claim = null; record.lastError = { code: 'STALE_UPLOAD_CLAIM', at }; record.updatedAt = at
    if (record.attempts >= record.maxAttempts) { record.state = 'EVIDENCE_INCOMPLETE'; record.nextAttemptAt = null }
    else { record.state = 'RETRY_WAIT'; record.nextAttemptAt = new Date(Date.parse(at) + record.baseBackoffMs).toISOString() }
    return save(filename, record)
  }, options)
}

function recordUploadSuccess(filename, options = {}) {
  return withSpoolLock(filename, () => {
    const record = loadUploadSpool(filename)
    if (record.state !== 'UPLOADING') fail('UPLOAD_STATE_INVALID', `cannot complete upload from ${record.state}`)
    assertClaim(record, options)
    record.receipt = signUploadReceipt(record, options.receipt)
    record.state = 'UPLOADED'; record.claim = null; record.lastError = null; record.nextAttemptAt = null
    record.updatedAt = record.receipt.uploadedAt
    return save(filename, record)
  }, options)
}

function assertPublicationReady(input) {
  const blockers = []
  const uploadedObjects = new Map()
  if (!input || !input.report || !verifyAggregateReport(input.report, input.trustRegistry)) blockers.push('AGGREGATE_SIGNATURE_INVALID')
  let aggregateObject = null
  try {
    if (!input || !input.evidenceRoot || !input.reportEvidence) throw new Error('missing aggregate evidence')
    validateBlobDescriptor(input.reportEvidence, 'AGGREGATE_EVIDENCE_INVALID')
    const reopened = readVerifiedJson(input.evidenceRoot, input.reportEvidence, 'AGGREGATE_EVIDENCE_INVALID')
    if (canonicalStringify(reopened) !== canonicalStringify(input.report)) throw new Error('aggregate evidence differs from report')
    aggregateObject = { digest: input.reportEvidence.sha256, relativePath: input.reportEvidence.relativePath }
  } catch { blockers.push('AGGREGATE_EVIDENCE_INVALID') }
  if (!input || !Array.isArray(input.uploadSpools) || !input.uploadSpools.length) blockers.push('UPLOAD_SPOOL_MISSING')
  else for (const spool of input.uploadSpools) {
    try { validateSpool(spool, { trustRegistry: input.trustRegistry }) } catch { blockers.push('UPLOAD_SPOOL_INVALID'); continue }
    if (input.report && spool.manifestDigest !== input.report.manifestDigest) blockers.push('UPLOAD_MANIFEST_MISMATCH')
    if (spool.state !== 'UPLOADED') blockers.push(spool.state === 'EVIDENCE_INCOMPLETE' ? 'EVIDENCE_INCOMPLETE' : 'UPLOAD_PENDING')
    if (spool.state === 'UPLOADED') for (const object of spool.objects) {
      if (uploadedObjects.has(object.relativePath)) blockers.push('UPLOAD_OBJECT_COLLISION')
      else uploadedObjects.set(object.relativePath, object.digest)
    }
  }
  if (input && input.report) {
    const required = [...(aggregateObject ? [aggregateObject] : []), ...(Array.isArray(input.report.evidenceObjects) ? input.report.evidenceObjects : [])]
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.digest.localeCompare(b.digest))
    const actual = [...uploadedObjects].map(([relativePath, digest]) => ({ digest, relativePath }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.digest.localeCompare(b.digest))
    if (canonicalStringify(actual) !== canonicalStringify(required)) blockers.push('UPLOAD_OBJECT_SET_MISMATCH')
  }
  if (!input || !input.report || !input.report.canarySummary || input.report.canarySummary.ready !== true) blockers.push('CANARIES_NOT_READY')
  if (!input || !input.report || input.report.controlledEffectEligible !== true || input.report.analysisClass !== 'controlled-effects') blockers.push('CONTROLLED_EFFECT_INELIGIBLE')
  if (!input || !input.report || !input.report.trustMetadata || input.report.trustMetadata.fixtureOnly !== false || input.report.catalog.fixtureOnly !== false) blockers.push('FIXTURE_ONLY_EVIDENCE')
  const maximumCostPerAcceptedSolve = input && input.maximumCostPerAcceptedSolve
  if (typeof maximumCostPerAcceptedSolve !== 'number' || !Number.isFinite(maximumCostPerAcceptedSolve) || maximumCostPerAcceptedSolve < 0) {
    blockers.push('COST_PER_ACCEPTED_SOLVE_THRESHOLD_INVALID')
  }
  const costPerAcceptedSolve = input && input.report && input.report.costPerAcceptedSolve
  const armIds = input && input.report && input.report.costsByArm && typeof input.report.costsByArm === 'object'
    ? Object.keys(input.report.costsByArm)
    : []
  if (!costPerAcceptedSolve || typeof costPerAcceptedSolve !== 'object' || Array.isArray(costPerAcceptedSolve) ||
      armIds.length === 0 || armIds.some(armId => typeof costPerAcceptedSolve[armId] !== 'number' || !Number.isFinite(costPerAcceptedSolve[armId]) || costPerAcceptedSolve[armId] < 0)) {
    blockers.push('COST_PER_ACCEPTED_SOLVE_MISSING')
  } else if (typeof maximumCostPerAcceptedSolve === 'number' && Number.isFinite(maximumCostPerAcceptedSolve) && maximumCostPerAcceptedSolve >= 0 &&
      armIds.some(armId => costPerAcceptedSolve[armId] > maximumCostPerAcceptedSolve)) {
    blockers.push('COST_PER_ACCEPTED_SOLVE_LIMIT_EXCEEDED')
  }
  if (blockers.length) fail('PUBLICATION_BLOCKED', 'benchmark evidence is not publication-ready', { blockers })
  return { ready: true, reportDigest: input.report.reportDigest }
}

module.exports = {
  STATES,
  assertPublicationReady,
  claimUpload,
  createUploadSpool,
  loadUploadSpool,
  objectsDigest,
  recordUploadFailure,
  recordUploadSuccess,
  recoverStaleUpload,
  requeueUpload,
  signUploadReceipt,
  uploadHealth,
  validateSpool,
  verifyUploadReceipt,
}
