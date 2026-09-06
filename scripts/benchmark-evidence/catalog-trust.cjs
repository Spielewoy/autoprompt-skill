'use strict'

const crypto = require('node:crypto')
const { canonicalStringify, digestRecord, exactKeys, fail, hashPattern, isoDate } = require('./core.cjs')
const { FIXTURE_CATALOG_TRUST, trustedCatalog } = require('./trust-registry.cjs')

// Exported only as public fixture trust configuration. Validation never consults
// this object implicitly; callers must supply a separately constructed registry.
const TRUSTED_CATALOGS = Object.freeze({ 'terminal-bench-3.0-cpu-fixture-2026-08-22': FIXTURE_CATALOG_TRUST })

function catalogAttestationPayload(attestation) {
  return {
    schemaVersion: attestation.schemaVersion,
    issuer: attestation.issuer,
    keyId: attestation.keyId,
    algorithm: attestation.algorithm,
    catalogDigest: attestation.catalogDigest,
    taskCount: attestation.taskCount,
    taskIdsDigest: attestation.taskIdsDigest,
  }
}

function verifyTaskCatalogAttestation(catalog, trustRegistry, options = {}) {
  const trust = trustedCatalog(trustRegistry, catalog && catalog.catalogId)
  const checkedAt = options.checkedAt || new Date().toISOString()
  isoDate(checkedAt, 'TASK_CATALOG_ATTESTATION_INVALID', 'catalog trust verification time')
  if (Date.parse(checkedAt) < Date.parse(trust.validFrom) || Date.parse(checkedAt) > Date.parse(trust.validUntil)) fail('TASK_CATALOG_TRUST_EXPIRED', 'catalog trust issuer is outside its configured validity window')
  if (!catalog.attestation) fail('TASK_CATALOG_ATTESTATION_INVALID', 'independent upstream catalog attestation is required')
  exactKeys(catalog.attestation, ['schemaVersion', 'issuer', 'keyId', 'algorithm', 'catalogDigest', 'taskCount', 'taskIdsDigest', 'signature'], 'TASK_CATALOG_ATTESTATION_INVALID', 'catalog attestation')
  const ids = catalog.tasks.map(task => task.taskId)
  const expectedIds = [...trust.pinnedTaskIds]
  const attestation = catalog.attestation
  if (attestation.schemaVersion !== 'benchmark-catalog-attestation.v2' || attestation.issuer !== trust.issuer || attestation.keyId !== trust.keyId || attestation.algorithm !== trust.algorithm) {
    fail('TASK_CATALOG_ATTESTATION_INVALID', 'catalog issuer, key, algorithm, or version differs from its independent pin')
  }
  if (catalog.digest !== trust.pinnedDigest || attestation.catalogDigest !== catalog.digest || attestation.taskCount !== trust.pinnedTaskCount || ids.length !== trust.pinnedTaskCount) {
    fail('TASK_CATALOG_PIN_MISMATCH', 'catalog digest or task count differs from its independent pin')
  }
  if (canonicalStringify(ids) !== canonicalStringify(expectedIds)) fail('TASK_CATALOG_PIN_MISMATCH', 'catalog task IDs differ from the exact independent pin')
  const idsDigest = digestRecord({ taskIds: ids })
  if (attestation.taskIdsDigest !== idsDigest || !hashPattern(attestation.taskIdsDigest)) fail('TASK_CATALOG_ATTESTATION_INVALID', 'attested task-ID digest is invalid')
  let signature
  try { signature = Buffer.from(attestation.signature, 'base64') } catch { fail('TASK_CATALOG_ATTESTATION_INVALID', 'catalog attestation signature is invalid') }
  if (!signature.length || !crypto.verify(null, Buffer.from(canonicalStringify(catalogAttestationPayload(attestation))), trust.publicKeyPem, signature)) {
    fail('TASK_CATALOG_ATTESTATION_INVALID', 'catalog attestation signature is invalid')
  }
  if (catalog.fixtureOnly !== trust.fixtureOnly) fail('TASK_CATALOG_PIN_MISMATCH', 'catalog fixture status differs from its independent pin')
  return Object.freeze({ catalogId: catalog.catalogId, issuer: trust.issuer, keyId: trust.keyId, fixtureOnly: trust.fixtureOnly, attestationDigest: digestRecord(attestation) })
}

module.exports = { TRUSTED_CATALOGS, catalogAttestationPayload, verifyTaskCatalogAttestation }
