'use strict'

const { canonicalStringify, digestRecord, exactKeys, fail, hashPattern, isoDate, nonEmpty, sha256 } = require('./core.cjs')
const { requireRoleDigest, signRoleDigest } = require('./trust-registry.cjs')

const AUTHORITY_FIELDS = Object.freeze([
  'schemaVersion', 'manifestDigest', 'taskId', 'attemptId', 'issuedAt', 'verdict', 'reward', 'grader',
  'producer', 'rawHarborSha256', 'verifierSha256', 'resourceEvidenceSha256', 'attestationDigest', 'signature',
])

function authorityCore(record) {
  const value = { ...record }
  delete value.attestationDigest
  delete value.signature
  return value
}

function validateAuthorityCore(record) {
  if (record.schemaVersion !== 'benchmark-verifier-attestation.v2') fail('VERIFIER_ATTESTATION_INVALID', 'unsupported verifier attestation schema')
  for (const field of ['manifestDigest', 'rawHarborSha256', 'verifierSha256', 'resourceEvidenceSha256']) if (!hashPattern(record[field])) fail('VERIFIER_ATTESTATION_INVALID', `${field} must be sha256`)
  for (const field of ['taskId', 'attemptId']) nonEmpty(record[field], 'VERIFIER_ATTESTATION_INVALID', field)
  isoDate(record.issuedAt, 'VERIFIER_ATTESTATION_INVALID', 'issuedAt')
  if (!['pass', 'fail'].includes(record.verdict) || typeof record.reward !== 'number' || !Number.isFinite(record.reward)) fail('VERIFIER_ATTESTATION_INVALID', 'verdict or reward is invalid')
  exactKeys(record.grader, ['verdict', 'score'], 'VERIFIER_ATTESTATION_INVALID', 'attested grader')
  if (record.grader.verdict !== record.verdict || typeof record.grader.score !== 'number' || !Number.isFinite(record.grader.score)) fail('VERIFIER_ATTESTATION_INVALID', 'attested grader does not match verdict')
  exactKeys(record.producer, ['name', 'version', 'buildDigest'], 'VERIFIER_ATTESTATION_INVALID', 'attested producer')
  nonEmpty(record.producer.name, 'VERIFIER_ATTESTATION_INVALID', 'producer.name')
  nonEmpty(record.producer.version, 'VERIFIER_ATTESTATION_INVALID', 'producer.version')
  if (!hashPattern(record.producer.buildDigest)) fail('VERIFIER_ATTESTATION_INVALID', 'producer.buildDigest must be sha256')
}

function signVerifierAttestation(input, signer) {
  const core = { schemaVersion: 'benchmark-verifier-attestation.v2', ...input }
  exactKeys(core, AUTHORITY_FIELDS.filter(field => !['attestationDigest', 'signature'].includes(field)), 'VERIFIER_ATTESTATION_INVALID', 'verifier attestation input')
  validateAuthorityCore(core)
  const attestationDigest = digestRecord(core)
  return Object.freeze({ ...core, attestationDigest, signature: signRoleDigest('verifier', attestationDigest, core.issuedAt, signer) })
}

function validateVerifierAttestation(record, trustRegistry, expected = {}) {
  exactKeys(record, AUTHORITY_FIELDS, 'VERIFIER_ATTESTATION_INVALID', 'verifier attestation')
  if (AUTHORITY_FIELDS.some(field => !Object.hasOwn(record, field))) fail('VERIFIER_ATTESTATION_INVALID', 'verifier attestation has missing fields')
  validateAuthorityCore(record)
  const digest = digestRecord(authorityCore(record))
  if (!hashPattern(record.attestationDigest) || record.attestationDigest !== digest) fail('VERIFIER_ATTESTATION_INVALID', 'verifier attestation digest is invalid')
  const trust = requireRoleDigest(trustRegistry, 'verifier', digest, record.issuedAt, record.signature, 'VERIFIER_ATTESTATION_SIGNATURE_INVALID')
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && canonicalStringify(record[field]) !== canonicalStringify(value)) fail('VERIFIER_ATTESTATION_MISMATCH', `verifier attestation ${field} differs from controller evidence`)
  }
  return Object.freeze({ record, trust, signatureDigest: sha256(canonicalStringify(record.signature)) })
}

module.exports = { AUTHORITY_FIELDS, signVerifierAttestation, validateVerifierAttestation }
