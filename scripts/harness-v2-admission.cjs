'use strict'

const path = require('node:path')
const { descriptor, executableInvocation, fail, readBound, sha256 } = require('./harness-v2-native.cjs')
const { verifyCapabilityAttestation } = require('../agents/codex/workflow/router.js')
const localCanary = require('./harness-v2-canary.cjs')

const EVIDENCE = 'scripts/harness-v2-trust/evidence.json'
const KEY_RING = 'scripts/harness-v2-trust/trusted-public-keys.json'
const REQUIRED = Object.freeze([
  'isolation', 'topologyEnforcement', 'privateSkillRoot', 'eventStreaming',
  'toolOutputCapture', 'stableChildIdentity', 'sameContextContinuation',
  'cancellation', 'isolatedChecking', 'processOwnership', 'modelRouting',
])
const HASH = /^[a-f0-9]{64}$/
const IMPORTED_TRUST_DIRECTORY = Object.freeze(['.autoprompt-private', 'conformance', 'v2'])

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function importedTrustDirectory(root, provider) {
  descriptor(provider)
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('INVALID_INPUT', 'Imported conformance trust requires an absolute provider root')
  return path.join(path.resolve(root), ...IMPORTED_TRUST_DIRECTORY, provider)
}

function readTrustFile(directory, name) {
  const root = path.resolve(directory)
  const candidate = path.join(root, name)
  try {
    const stat = require('node:fs').lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PROVIDER_UNSUPPORTED', 'Imported conformance trust directory is not a real directory')
    if (!pathWithin(root, candidate)) fail('PROVIDER_UNSUPPORTED', 'Imported conformance trust file escapes its directory')
    return readBound(candidate)
  } catch (error) {
    if (error?.code === 'PROVIDER_UNSUPPORTED') throw error
    fail('PROVIDER_UNSUPPORTED', 'Imported conformance trust record is unreadable')
  }
}

function trustSource(provider, installed, options = {}) {
  const directory = options.trustDirectory
  if (directory === undefined) {
    return { kind: 'shipped-release', directory: installed.bundle,
      evidenceBytes: readBound(path.join(installed.bundle, EVIDENCE)),
      keyRingBytes: readBound(path.join(installed.bundle, KEY_RING)) }
  }
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    fail('PROVIDER_UNSUPPORTED', 'Imported conformance trust requires an absolute private trust directory')
  }
  const resolved = path.resolve(directory)
  if (pathWithin(path.resolve(installed.bundle), resolved)) {
    fail('PROVIDER_UNSUPPORTED', 'Imported conformance trust must remain outside the installed runtime bundle')
  }
  if (!HASH.test(options.conformanceRequestSha256 || '')) {
    fail('PROVIDER_UNSUPPORTED', 'Imported conformance trust requires the exact reviewed admission-request digest')
  }
  return { kind: 'explicit-private-import', directory: resolved,
    evidenceBytes: readTrustFile(resolved, 'evidence.json'), keyRingBytes: readTrustFile(resolved, 'trusted-public-keys.json'),
    conformanceRequestSha256: options.conformanceRequestSha256 }
}

function runtimeIdentityBody(provider, installed, executable) {
  descriptor(provider)
  if (installed?.provider !== provider || executable?.provider !== provider ||
      !path.isAbsolute(executable.path || '') || !HASH.test(executable.sha256 || '') ||
      typeof executable.version !== 'string' || !installed.files || Array.isArray(installed.files)) {
    fail('PROVIDER_IDENTITY_MISMATCH', 'Admission requires the exact installed provider and native executable')
  }
  const dependencies = executable.runtimeIdentity
  if (!dependencies || !HASH.test(dependencies.sha256 || '') ||
      !Number.isSafeInteger(dependencies.fileCount) || dependencies.fileCount < 1 ||
      !Number.isSafeInteger(dependencies.packageCount) || dependencies.packageCount < 0) {
    fail('PROVIDER_IDENTITY_MISMATCH', 'Admission requires the exact native runtime dependency inventory')
  }
  // Exclude only the two release trust documents to avoid a circular signature.
  // A similarly named file anywhere else is still part of the signed runtime.
  const files = Object.fromEntries(Object.entries(installed.files)
    .filter(([file]) => file !== EVIDENCE && file !== KEY_RING)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  for (const [file, hash] of Object.entries(files)) {
    if (path.isAbsolute(file) || file.includes('\\') || file.includes(':') ||
        file.split('/').some(part => !part || part === '.' || part === '..') || !HASH.test(hash)) {
      fail('PAYLOAD_INVALID', 'Admission runtime inventory contains an invalid path or digest')
    }
  }
  // Windows npm shims are never executed through cmd.exe. Their raw shim hash
  // remains the executable identity, while this separately binds the exact
  // Node interpreter and package script used for every shell:false launch.
  const launchInvocationSha256 = executable.invocation ? (() => {
    executableInvocation(executable)
    return executable.invocation.sha256
  })() : undefined
  return { provider, executablePath: executable.path, executableSha256: executable.sha256,
    ...(launchInvocationSha256 ? { executableLaunchInvocationSha256: launchInvocationSha256 } : {}),
    nativeRuntimeIdentity: { sha256: dependencies.sha256, fileCount: dependencies.fileCount,
      packageCount: dependencies.packageCount },
    version: executable.version, platform: process.platform, architecture: process.arch, files }
}

function runtimeIdentity(provider, installed, executable) {
  return sha256(JSON.stringify(runtimeIdentityBody(provider, installed, executable)))
}

// A bundled reviewed-local record is authenticated by the immutable installed
// payload, but is deliberately distinct from independently signed live trust.
// It only opens a pending state; configure must execute the closed per-install
// canary before the mission and bind its fresh observations.
function reviewedLocalPending(provider, installed, executable, options = {}) {
  let evidence
  try { evidence = JSON.parse(readBound(path.join(installed.bundle, EVIDENCE))) } catch { return null }
  try {
    return localCanary.pendingFromEvidence(evidence, provider, installed, executable, options.now)
  }
  catch (error) { fail('PROVIDER_UNSUPPORTED', `Reviewed-local release record is rejected: ${error.message}`) }
}

function verifyAdmission(provider, installed, executable, options = {}) {
  const body = runtimeIdentityBody(provider, installed, executable)
  const identity = sha256(JSON.stringify(body))
  let evidence, ring
  let source
  try {
    source = trustSource(provider, installed, options)
    evidence = JSON.parse(source.evidenceBytes)
    ring = JSON.parse(source.keyRingBytes)
  } catch {
    fail('PROVIDER_UNSUPPORTED', `${provider} has no readable independent conformance evidence`)
  }
  if (evidence?.schemaVersion !== 'harness-v2-live-conformance.v1' || !Array.isArray(evidence.records) ||
      ring?.schemaVersion !== 'harness-v2-trusted-keys.v1' || !Array.isArray(ring.keys)) {
    fail('PROVIDER_UNSUPPORTED', 'Native conformance records or trust schema are invalid')
  }
  const matches = evidence.records.filter(record => record?.provider === provider &&
    record.status === 'passed' && record.attestation?.runtimeIdentityHash === identity)
  if (matches.length !== 1) {
    fail('PROVIDER_UNSUPPORTED', `${provider} v2 requires one independent signed live-conformance record for this runtime before activation`,
      { provider, runtimeIdentityHash: identity, matchingRecords: matches.length })
  }
  const record = matches[0]
  const attestation = record.attestation
  if (source.kind === 'explicit-private-import' && attestation.providerAdmissionSha256 !== source.conformanceRequestSha256) {
    fail('PROVIDER_UNSUPPORTED', 'Imported conformance certificate is not bound to the reviewed local admission request')
  }
  const keys = ring.keys.filter(key => key?.keyId === attestation.signature?.keyId)
  const key = keys[0]
  if (keys.length !== 1 || key.independent !== true || !Array.isArray(key.providers) ||
      !key.providers.includes(provider) || key.issuer !== attestation.issuer ||
      typeof key.publicKeyPem !== 'string' || /autoprompt.*activation/i.test(attestation.issuer || '') ||
      attestation.verificationMethod !== 'live-conformance-suite' || attestation.signature?.algorithm !== 'ed25519') {
    fail('PROVIDER_UNSUPPORTED', 'Native conformance issuer is not an independent, provider-scoped release authority')
  }
  const verified = verifyCapabilityAttestation(attestation, {
    providerId: provider, runtimeIdentityHash: identity, activationNonce: record.activationNonce,
    requiredCapabilities: REQUIRED, trustedPublicKeys: { [key.keyId]: key.publicKeyPem },
  })
  if (!verified.valid) fail('PROVIDER_UNSUPPORTED', 'Native live-conformance admission failed', { errors: verified.errors })
  return { ...verified, attestation, runtimeIdentityBody: body, runtimeIdentityHash: identity,
    evidenceSha256: sha256(JSON.stringify({ record, key })), trustSource: {
      kind: source.kind, directory: source.directory, evidenceSha256: sha256(source.evidenceBytes),
      keyRingSha256: sha256(source.keyRingBytes), ...(source.conformanceRequestSha256 ? { conformanceRequestSha256: source.conformanceRequestSha256 } : {}),
    } }
}

module.exports = { EVIDENCE, KEY_RING, REQUIRED, IMPORTED_TRUST_DIRECTORY, importedTrustDirectory, trustSource,
  runtimeIdentityBody, runtimeIdentity, reviewedLocalPending, verifyAdmission }
