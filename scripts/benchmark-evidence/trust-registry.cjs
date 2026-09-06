'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const { canonicalStringify, exactKeys, fail, hashPattern, isoDate, nonEmpty } = require('./core.cjs')

const TRUSTED_ROLES = Object.freeze(['manifest', 'aggregate', 'provider-receipt', 'verifier', 'controller'])
const REGISTRIES = new WeakSet()

const FIXTURE_CATALOG_TRUST = Object.freeze({
  issuer: 'terminal-bench-upstream-fixture',
  keyId: 'tb3-fixture-ed25519-2026-08-22',
  algorithm: 'ed25519',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAJdWQrptQ9uFFbbryEPk4zusFdQIbvbXytJzp7uUiEGM=\n-----END PUBLIC KEY-----\n',
  validFrom: '2026-08-22T00:00:00.000Z',
  validUntil: '2036-08-22T00:00:00.000Z',
  pinnedDigest: '71719019a380d3308217af326a02b3e2c59803d45016fc8d64bc9181888e0e4a',
  pinnedTaskCount: 2,
  pinnedTaskIds: Object.freeze(['task-alpha', 'task-excluded']),
  fixtureOnly: true,
})

function validatePublicKeyPem(value, code, label) {
  nonEmpty(value, code, label)
  if (/PRIVATE KEY/.test(value)) fail(code, `${label} must not contain private key material`)
  let key
  try { key = crypto.createPublicKey(value) } catch (error) { fail(code, `${label} is not a valid public key`, { cause: error.message }) }
  if (key.asymmetricKeyType !== 'ed25519') fail(code, `${label} must be an Ed25519 public key`)
  return key.export({ type: 'spki', format: 'pem' }).toString()
}

function validateTrustWindow(record, code, label) {
  isoDate(record.validFrom, code, `${label}.validFrom`)
  isoDate(record.validUntil, code, `${label}.validUntil`)
  if (Date.parse(record.validFrom) >= Date.parse(record.validUntil)) fail(code, `${label} validity window is empty`)
}

function normalizeRole(role, record) {
  exactKeys(record, ['issuer', 'keyId', 'algorithm', 'publicKeyPem', 'validFrom', 'validUntil', 'fixtureOnly'], 'TRUST_CONFIG_INVALID', `trusted ${role} signer`)
  for (const field of ['issuer', 'keyId']) nonEmpty(record[field], 'TRUST_CONFIG_INVALID', `${role}.${field}`)
  if (record.algorithm !== 'ed25519' || typeof record.fixtureOnly !== 'boolean') fail('TRUST_CONFIG_INVALID', `${role} signer metadata is invalid`)
  validateTrustWindow(record, 'TRUST_CONFIG_INVALID', role)
  return Object.freeze({ ...record, publicKeyPem: validatePublicKeyPem(record.publicKeyPem, 'TRUST_CONFIG_INVALID', `${role}.publicKeyPem`) })
}

function normalizeCatalog(catalogId, record) {
  exactKeys(record, ['issuer', 'keyId', 'algorithm', 'publicKeyPem', 'validFrom', 'validUntil', 'pinnedDigest', 'pinnedTaskCount', 'pinnedTaskIds', 'fixtureOnly'], 'TRUST_CONFIG_INVALID', `trusted catalog ${catalogId}`)
  const normalized = normalizeRole(`catalog:${catalogId}`, {
    issuer: record.issuer, keyId: record.keyId, algorithm: record.algorithm, publicKeyPem: record.publicKeyPem,
    validFrom: record.validFrom, validUntil: record.validUntil, fixtureOnly: record.fixtureOnly,
  })
  if (!hashPattern(record.pinnedDigest) || !Number.isSafeInteger(record.pinnedTaskCount) || record.pinnedTaskCount < 1 || !Array.isArray(record.pinnedTaskIds) || record.pinnedTaskIds.length !== record.pinnedTaskCount) {
    fail('TRUST_CONFIG_INVALID', `trusted catalog ${catalogId} pin is incomplete`)
  }
  if (new Set(record.pinnedTaskIds).size !== record.pinnedTaskIds.length || record.pinnedTaskIds.some(id => typeof id !== 'string' || !id)) fail('TRUST_CONFIG_INVALID', `trusted catalog ${catalogId} task IDs are invalid`)
  return Object.freeze({ ...normalized, pinnedDigest: record.pinnedDigest, pinnedTaskCount: record.pinnedTaskCount, pinnedTaskIds: Object.freeze([...record.pinnedTaskIds]) })
}

function createTrustRegistry(input) {
  exactKeys(input, ['schemaVersion', 'roles', 'catalogs'], 'TRUST_CONFIG_INVALID', 'benchmark trust registry')
  if (input.schemaVersion !== 'benchmark-trust-registry.v2' || !input.roles || typeof input.roles !== 'object' || Array.isArray(input.roles) || !input.catalogs || typeof input.catalogs !== 'object' || Array.isArray(input.catalogs)) fail('TRUST_CONFIG_INVALID', 'benchmark trust registry shape is invalid')
  const unknownRoles = Object.keys(input.roles).filter(role => !TRUSTED_ROLES.includes(role))
  if (unknownRoles.length) fail('TRUST_CONFIG_INVALID', 'trust registry has unknown signer roles', { unknownRoles })
  const roles = Object.fromEntries(Object.entries(input.roles).map(([role, record]) => [role, normalizeRole(role, record)]))
  const catalogs = Object.fromEntries(Object.entries(input.catalogs).map(([catalogId, record]) => {
    nonEmpty(catalogId, 'TRUST_CONFIG_INVALID', 'catalogId')
    return [catalogId, normalizeCatalog(catalogId, record)]
  }))
  const identities = [...Object.entries(roles).map(([role, value]) => [`role:${role}`, value]), ...Object.entries(catalogs).map(([id, value]) => [`catalog:${id}`, value])]
  const keyIds = new Map()
  const publicKeys = new Map()
  for (const [owner, value] of identities) {
    if (keyIds.has(value.keyId)) fail('TRUST_ROLE_COLLISION', `trusted keyId is reused across roles: ${value.keyId}`, { first: keyIds.get(value.keyId), second: owner })
    keyIds.set(value.keyId, owner)
    const fingerprint = crypto.createHash('sha256').update(value.publicKeyPem).digest('hex')
    if (publicKeys.has(fingerprint)) fail('TRUST_ROLE_COLLISION', 'trusted public key is reused across distinct trust roles', { first: publicKeys.get(fingerprint), second: owner, fingerprint })
    publicKeys.set(fingerprint, owner)
  }
  const registry = Object.freeze({ schemaVersion: input.schemaVersion, roles: Object.freeze(roles), catalogs: Object.freeze(catalogs) })
  REGISTRIES.add(registry)
  return registry
}

function loadTrustRegistry(filename) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) { fail('TRUST_CONFIG_INVALID', `cannot read benchmark trust registry: ${filename}`, { cause: error.message }) }
  return createTrustRegistry(parsed)
}

function assertTrustRegistry(registry) {
  if (!registry || !REGISTRIES.has(registry)) fail('TRUST_REGISTRY_REQUIRED', 'a separately constructed trusted registry is required')
  return registry
}

function trustedRole(registry, role) {
  assertTrustRegistry(registry)
  const trusted = registry.roles[role]
  if (!trusted) fail('TRUST_ROLE_REQUIRED', `trusted signer role is not configured: ${role}`)
  return trusted
}

function assertWithinValidity(trusted, issuedAt, code) {
  isoDate(issuedAt, code, 'signature time')
  if (Date.parse(issuedAt) < Date.parse(trusted.validFrom) || Date.parse(issuedAt) > Date.parse(trusted.validUntil)) fail(code, 'signature time is outside issuer validity')
}

function signaturePayload(role, digest, issuedAt) {
  if (!TRUSTED_ROLES.includes(role) || !hashPattern(digest)) fail('SIGNATURE_INVALID', 'signature role or digest is invalid')
  isoDate(issuedAt, 'SIGNATURE_INVALID', 'issuedAt')
  return canonicalStringify({ schemaVersion: 'benchmark-role-signature.v2', role, digest, issuedAt })
}

function signRoleDigest(role, digest, issuedAt, signer) {
  if (!signer || !signer.privateKey || !signer.issuer || !signer.keyId) fail('SIGNATURE_REQUIRED', `${role} private signer is required`)
  let key
  try { key = signer.privateKey && signer.privateKey.type === 'private' ? signer.privateKey : crypto.createPrivateKey(signer.privateKey) } catch (error) { fail('SIGNATURE_INVALID', `${role} private key is invalid`, { cause: error.message }) }
  if (key.asymmetricKeyType !== 'ed25519') fail('SIGNATURE_INVALID', `${role} private key must be Ed25519`)
  const value = crypto.sign(null, Buffer.from(signaturePayload(role, digest, issuedAt)), key).toString('base64')
  return Object.freeze({ algorithm: 'ed25519', issuer: signer.issuer, keyId: signer.keyId, value })
}

function verifyRoleDigest(registry, role, digest, issuedAt, signature) {
  try {
    const trusted = trustedRole(registry, role)
    exactKeys(signature, ['algorithm', 'issuer', 'keyId', 'value'], 'SIGNATURE_INVALID', `${role} signature`)
    if (signature.algorithm !== 'ed25519' || signature.issuer !== trusted.issuer || signature.keyId !== trusted.keyId || typeof signature.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature.value)) return false
    assertWithinValidity(trusted, issuedAt, 'SIGNATURE_INVALID')
    return crypto.verify(null, Buffer.from(signaturePayload(role, digest, issuedAt)), trusted.publicKeyPem, Buffer.from(signature.value, 'base64'))
  } catch { return false }
}

function requireRoleDigest(registry, role, digest, issuedAt, signature, code = 'SIGNATURE_INVALID') {
  if (!verifyRoleDigest(registry, role, digest, issuedAt, signature)) fail(code, `${role} signature is untrusted or invalid`)
  return trustedRole(registry, role)
}

function trustedCatalog(registry, catalogId) {
  assertTrustRegistry(registry)
  const trust = registry.catalogs[catalogId]
  if (!trust) fail('TASK_CATALOG_UNTRUSTED', `catalog identity is not configured by trusted policy: ${catalogId}`)
  return trust
}

function requireProductionCatalog(registry, catalogId) {
  const trust = trustedCatalog(registry, catalogId)
  if (trust.fixtureOnly) fail('PRODUCTION_CATALOG_TRUST_REQUIRED', 'fixture-only catalog trust cannot authorize a controlled benchmark')
  return trust
}

module.exports = {
  FIXTURE_CATALOG_TRUST,
  TRUSTED_ROLES,
  assertTrustRegistry,
  createTrustRegistry,
  loadTrustRegistry,
  requireProductionCatalog,
  requireRoleDigest,
  signRoleDigest,
  signaturePayload,
  trustedCatalog,
  trustedRole,
  verifyRoleDigest,
}
