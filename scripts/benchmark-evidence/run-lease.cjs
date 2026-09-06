'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const { canonicalStringify, digestRecord, exactKeys, fail, hashPattern, isoDate, nonEmpty, readChecksummedJson, writeChecksummedJson } = require('./core.cjs')

const LOCK_SCHEMA = 'benchmark-run-lease-lock.v2'

function validateManifestLease(lease) {
  exactKeys(lease, ['nonce', 'issuer', 'validFrom', 'validUntil'], 'RUN_LEASE_INVALID', 'manifest run lease')
  nonEmpty(lease.nonce, 'RUN_LEASE_INVALID', 'runLease.nonce')
  nonEmpty(lease.issuer, 'RUN_LEASE_INVALID', 'runLease.issuer')
  isoDate(lease.validFrom, 'RUN_LEASE_INVALID', 'runLease.validFrom')
  isoDate(lease.validUntil, 'RUN_LEASE_INVALID', 'runLease.validUntil')
  if (Date.parse(lease.validFrom) >= Date.parse(lease.validUntil)) fail('RUN_LEASE_INVALID', 'run lease validity window is empty')
  return lease
}

function validateRegistry(record) {
  exactKeys(record, ['schemaVersion', 'registryId', 'issuer', 'entries', 'checksum'], 'RUN_LEASE_REGISTRY_INVALID', 'run lease registry')
  if (record.schemaVersion !== 'benchmark-run-lease-registry.v2' || !hashPattern(record.checksum) || record.checksum !== digestRecord(record, ['checksum'])) fail('RUN_LEASE_REGISTRY_INVALID', 'run lease registry checksum or version is invalid')
  nonEmpty(record.registryId, 'RUN_LEASE_REGISTRY_INVALID', 'registryId')
  nonEmpty(record.issuer, 'RUN_LEASE_REGISTRY_INVALID', 'issuer')
  if (!Array.isArray(record.entries)) fail('RUN_LEASE_REGISTRY_INVALID', 'run lease registry entries are invalid')
  const identities = new Set()
  const nonces = new Set()
  for (const entry of record.entries) {
    exactKeys(entry, ['manifestId', 'manifestDigest', 'nonce', 'consumptionId', 'consumedAt'], 'RUN_LEASE_REGISTRY_INVALID', 'consumed run lease')
    for (const field of ['manifestId', 'nonce', 'consumptionId']) nonEmpty(entry[field], 'RUN_LEASE_REGISTRY_INVALID', field)
    if (!hashPattern(entry.manifestDigest)) fail('RUN_LEASE_REGISTRY_INVALID', 'consumed manifest digest is invalid')
    isoDate(entry.consumedAt, 'RUN_LEASE_REGISTRY_INVALID', 'consumedAt')
    if (identities.has(entry.manifestId) || nonces.has(entry.nonce)) fail('RUN_LEASE_REGISTRY_INVALID', 'registry reuses a manifest identity or nonce')
    identities.add(entry.manifestId); nonces.add(entry.nonce)
  }
  return record
}

function createRunLeaseRegistry(filename, input) {
  if (!input || fs.existsSync(filename)) fail(fs.existsSync(filename) ? 'RUN_LEASE_REGISTRY_EXISTS' : 'RUN_LEASE_REGISTRY_INVALID', 'run lease registry input is invalid or already exists')
  const record = { schemaVersion: 'benchmark-run-lease-registry.v2', registryId: input.registryId, issuer: input.issuer, entries: [] }
  validateRegistry({ ...record, checksum: digestRecord(record) })
  return writeChecksummedJson(filename, record)
}

function loadRunLeaseRegistry(filename) {
  return validateRegistry(readChecksummedJson(filename, { code: 'RUN_LEASE_REGISTRY_INVALID' }))
}

function lockRecord(ownerPid, ownerToken, acquiredAt) {
  const core = { schemaVersion: LOCK_SCHEMA, ownerPid, ownerToken, acquiredAt }
  return { ...core, checksum: digestRecord(core) }
}

function readLockOwner(lock) {
  let record
  try { record = JSON.parse(fs.readFileSync(lock, 'utf8')) } catch { fail('RUN_LEASE_REGISTRY_BUSY', 'run lease registry lock owner cannot be proven dead') }
  exactKeys(record, ['schemaVersion', 'ownerPid', 'ownerToken', 'acquiredAt', 'checksum'], 'RUN_LEASE_REGISTRY_BUSY', 'run lease registry lock')
  if (record.schemaVersion !== LOCK_SCHEMA || !Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1 || typeof record.ownerToken !== 'string' || !/^[a-f0-9]{32}$/.test(record.ownerToken) || !hashPattern(record.checksum) || record.checksum !== digestRecord(record, ['checksum'])) fail('RUN_LEASE_REGISTRY_BUSY', 'run lease registry lock owner cannot be proven dead')
  isoDate(record.acquiredAt, 'RUN_LEASE_REGISTRY_BUSY', 'lock acquiredAt')
  return record
}

function processIsAlive(ownerPid) {
  try { process.kill(ownerPid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

function withRegistryLock(filename, operation) {
  const lock = `${filename}.lock`
  let descriptor
  try {
    try { descriptor = fs.openSync(lock, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = readLockOwner(lock)
      if (processIsAlive(owner.ownerPid)) fail('RUN_LEASE_REGISTRY_BUSY', 'run lease registry is owned by a live process', { ownerPid: owner.ownerPid, ownerToken: owner.ownerToken })
      fs.unlinkSync(lock)
      try { descriptor = fs.openSync(lock, 'wx', 0o600) } catch (retryError) {
        if (retryError.code === 'EEXIST') fail('RUN_LEASE_REGISTRY_BUSY', 'run lease registry was claimed during dead-owner recovery')
        throw retryError
      }
    }
    const owner = lockRecord(process.pid, crypto.randomBytes(16).toString('hex'), new Date().toISOString())
    fs.writeFileSync(descriptor, `${canonicalStringify(owner)}\n`)
    fs.fsyncSync(descriptor)
    return operation()
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
    if (descriptor !== undefined) try { fs.unlinkSync(lock) } catch {}
  }
}

function leaseView(registry, entry) {
  return Object.freeze({
    schemaVersion: 'benchmark-run-lease.v2', registryId: registry.registryId, issuer: registry.issuer,
    manifestId: entry.manifestId, manifestDigest: entry.manifestDigest, nonce: entry.nonce,
    consumptionId: entry.consumptionId, consumedAt: entry.consumedAt,
  })
}

function consumeRunLease(filename, manifest, options = {}) {
  if (!manifest || !hashPattern(manifest.manifestDigest)) fail('RUN_LEASE_INVALID', 'signed manifest is required before lease consumption')
  validateManifestLease(manifest.runLease)
  return withRegistryLock(filename, () => {
    const registry = loadRunLeaseRegistry(filename)
    if (registry.issuer !== manifest.runLease.issuer) fail('RUN_LEASE_ISSUER_MISMATCH', 'manifest run lease issuer differs from the trusted registry')
    const now = options.now || new Date().toISOString()
    isoDate(now, 'RUN_LEASE_INVALID', 'lease consumption time')
    if (Date.parse(now) < Date.parse(manifest.runLease.validFrom) || Date.parse(now) > Date.parse(manifest.runLease.validUntil)) fail('RUN_LEASE_EXPIRED', 'manifest run lease is outside its validity window')
    if (registry.entries.some(entry => entry.nonce === manifest.runLease.nonce || entry.manifestId === manifest.manifestId || entry.manifestDigest === manifest.manifestDigest)) fail('RUN_LEASE_REPLAY', 'manifest identity, digest, or nonce has already been consumed')
    const entry = {
      manifestId: manifest.manifestId, manifestDigest: manifest.manifestDigest, nonce: manifest.runLease.nonce,
      consumptionId: options.consumptionId || crypto.randomUUID(), consumedAt: now,
    }
    registry.entries.push(entry)
    const unsigned = { ...registry }; delete unsigned.checksum
    writeChecksummedJson(filename, unsigned)
    return leaseView(registry, entry)
  })
}

function assertRunLease(filename, lease, manifest) {
  exactKeys(lease, ['schemaVersion', 'registryId', 'issuer', 'manifestId', 'manifestDigest', 'nonce', 'consumptionId', 'consumedAt'], 'RUN_LEASE_INVALID', 'active run lease')
  if (lease.schemaVersion !== 'benchmark-run-lease.v2') fail('RUN_LEASE_INVALID', 'active run lease version is invalid')
  const registry = loadRunLeaseRegistry(filename)
  const entry = registry.entries.find(item => item.consumptionId === lease.consumptionId)
  if (!entry || canonicalStringify(lease) !== canonicalStringify(leaseView(registry, entry))) fail('RUN_LEASE_INVALID', 'active run lease is absent or altered')
  if (!manifest || entry.manifestId !== manifest.manifestId || entry.manifestDigest !== manifest.manifestDigest || entry.nonce !== manifest.runLease.nonce) fail('RUN_LEASE_MANIFEST_MISMATCH', 'active lease belongs to another run manifest')
  return lease
}

module.exports = { assertRunLease, consumeRunLease, createRunLeaseRegistry, loadRunLeaseRegistry, validateManifestLease }
