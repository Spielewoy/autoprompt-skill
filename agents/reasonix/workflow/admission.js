'use strict'

const path = require('node:path')
const { readBound, sha256, ReasonixError } = require('./native.js')
const { verifyCapabilityAttestation } = require('../../codex/workflow/router.js')
const localCanary = require('../../../scripts/harness-v2-canary.cjs')

const REQUIRED = Object.freeze(['isolation', 'topologyEnforcement', 'privateSkillRoot', 'eventStreaming', 'toolOutputCapture', 'stableChildIdentity', 'sameContextContinuation', 'cancellation', 'isolatedChecking', 'processOwnership', 'modelRouting'])
const HASH = /^[a-f0-9]{64}$/
function importedTrustDirectory(root) { return path.join(path.resolve(root), '.autoprompt-private', 'conformance', 'v2', 'reasonix') }

// Release conformance is independent of this activation. A local hash is an
// integrity binding, never evidence that a provider capability was verified.
function runtimeIdentityBody(installed, executable) {
  const dependencies = executable?.runtimeIdentity
  if (installed?.provider !== 'reasonix' || executable?.provider !== 'reasonix' ||
      !path.isAbsolute(executable.path || '') || !HASH.test(executable.sha256 || '') ||
      typeof executable.version !== 'string' || !installed.files || Array.isArray(installed.files) ||
      !dependencies || !HASH.test(dependencies.sha256 || '') ||
      !Number.isSafeInteger(dependencies.fileCount) || dependencies.fileCount < 1 ||
      !Number.isSafeInteger(dependencies.packageCount) || dependencies.packageCount < 0) {
    throw new ReasonixError('PROVIDER_IDENTITY_MISMATCH', 'Reasonix admission requires the complete installed and native runtime identity')
  }
  const excluded = new Set(['agents/contracts/reasonix-live-conformance-evidence.json', 'agents/contracts/reasonix-trusted-public-keys.json'])
  const files = Object.fromEntries(Object.entries(installed.files).filter(([file]) => !excluded.has(file))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  for (const [file, hash] of Object.entries(files)) {
    if (path.isAbsolute(file) || file.includes('\\') || file.includes(':') ||
        file.split('/').some(part => !part || part === '.' || part === '..') || !HASH.test(hash)) {
      throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix runtime inventory contains an invalid path or digest')
    }
  }
  return { provider: 'reasonix', executablePath: executable.path, executableSha256: executable.sha256,
    nativeRuntimeIdentity: { sha256: dependencies.sha256, fileCount: dependencies.fileCount, packageCount: dependencies.packageCount },
    version: executable.version, platform: process.platform, architecture: process.arch, files }
}

function runtimeIdentity(installed, executable) { return sha256(JSON.stringify(runtimeIdentityBody(installed, executable))) }

const REVIEWED_LOCAL_EVIDENCE = 'scripts/harness-v2-trust/evidence.json'
function reviewedLocalPending(installed, executable, options = {}) {
  let evidence
  try { evidence = JSON.parse(readBound(path.join(installed.bundle, REVIEWED_LOCAL_EVIDENCE))) } catch { return null }
  try {
    return localCanary.pendingFromEvidence(evidence, 'reasonix', installed, executable, options.now)
  }
  catch (error) { throw new ReasonixError('PROVIDER_UNSUPPORTED', `Reasonix reviewed-local release record is rejected: ${error.message}`) }
}
// This legacy placeholder proves neither capability nor trust. It only gates
// the reviewed-local pending path when no private import was supplied.
function awaitingIndependentConformance(installed) {
  let evidence, ring
  try {
    evidence = JSON.parse(readBound(path.join(installed.bundle, 'agents/contracts/reasonix-live-conformance-evidence.json')))
    ring = JSON.parse(readBound(path.join(installed.bundle, 'agents/contracts/reasonix-trusted-public-keys.json')))
  } catch { return false }
  return Boolean(evidence?.schemaVersion === 'reasonix-live-conformance-evidence.v1' && evidence.providerId === 'reasonix' &&
    evidence.status === 'awaiting-independent-conformance' && evidence.attestation === null && evidence.activationNonce === null &&
    ring?.schemaVersion === 1 && ring.providerId === 'reasonix' && Array.isArray(ring.keys) && ring.keys.length === 0)
}

function verifyAdmission(installed, executable, options = {}) {
  const imported = options.trustDirectory
  if (imported !== undefined && (!path.isAbsolute(imported) || !HASH.test(options.conformanceRequestSha256 || '') ||
      path.resolve(imported) === path.resolve(installed.bundle) || path.resolve(imported).startsWith(`${path.resolve(installed.bundle)}${path.sep}`))) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported conformance trust must be external and bound to an exact reviewed request')
  }
  const evidencePath = imported ? path.join(imported, 'evidence.json') : path.join(installed.bundle, 'agents/contracts/reasonix-live-conformance-evidence.json')
  const keyPath = imported ? path.join(imported, 'trusted-public-keys.json') : path.join(installed.bundle, 'agents/contracts/reasonix-trusted-public-keys.json')
  const evidenceBytes = readBound(evidencePath), keyBytes = readBound(keyPath)
  const evidence = JSON.parse(evidenceBytes)
  const ring = JSON.parse(keyBytes)
  const attestation = evidence.attestation
  const trustedPublicKeys = Object.fromEntries((ring.keys || []).map(key => [key.keyId, key.publicKeyPem]))
  const key = (ring.keys || []).filter(item => item?.keyId === attestation?.signature?.keyId)
  if (evidence.status !== 'passed' || key.length !== 1 || key[0].independent !== true || key[0].issuer !== attestation?.issuer ||
      !Array.isArray(key[0].providers) || !key[0].providers.includes('reasonix') || attestation?.verificationMethod !== 'live-conformance-suite' ||
      /autoprompt.*activation/i.test(attestation?.issuer || '') || attestation?.signature?.algorithm !== 'ed25519') {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix v2 requires an independent signed live-conformance record for this runtime before activation')
  }
  const identity = runtimeIdentity(installed, executable)
  if (imported && attestation?.providerAdmissionSha256 !== options.conformanceRequestSha256) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported certificate is not bound to the reviewed local admission request')
  }
  const verification = verifyCapabilityAttestation(attestation, {
    providerId: 'reasonix', runtimeIdentityHash: identity, activationNonce: evidence.activationNonce,
    requiredCapabilities: REQUIRED, trustedPublicKeys,
  })
  if (!verification.valid) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix live-conformance admission failed', { errors: verification.errors })
  return { ...verification, runtimeIdentityBody: runtimeIdentityBody(installed, executable), runtimeIdentityHash: identity, evidenceSha256: sha256(JSON.stringify(evidence)),
    trustSource: { kind: imported ? 'explicit-private-import' : 'shipped-release', directory: imported || installed.bundle,
      evidenceSha256: sha256(evidenceBytes), keyRingSha256: sha256(keyBytes), ...(imported ? { conformanceRequestSha256: options.conformanceRequestSha256 } : {}) } }
}

module.exports = { REQUIRED, REVIEWED_LOCAL_EVIDENCE, runtimeIdentityBody, runtimeIdentity, importedTrustDirectory, reviewedLocalPending, awaitingIndependentConformance, verifyAdmission }
