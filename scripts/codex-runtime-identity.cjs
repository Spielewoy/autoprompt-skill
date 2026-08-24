'use strict'

const crypto = require('node:crypto')

const HASH_PATTERN = /^[a-f0-9]{64}$/
const PROVIDERS_SOURCE = 'agents/contracts/providers.json'
const KEY_RING_SOURCE = 'agents/contracts/codex-trusted-public-keys.json'
const EVIDENCE_SOURCE = 'agents/contracts/codex-live-conformance-evidence.json'
const ZERO_HASH = '0'.repeat(64)

function fail(message) { throw new Error(message) }

function sha256(value) {
  return crypto.createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'))
    .digest('hex')
}

function stableJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || seen.has(value)) {
    fail('stable-json-v1 accepts only acyclic JSON values')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map(item => stableJsonValue(item, seen))
    seen.delete(value)
    return result
  }
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('stable-json-v1 accepts only JSON values')
    result[key] = stableJsonValue(value[key], seen)
  }
  seen.delete(value)
  return result
}

function stableJsonV1(value) { return JSON.stringify(stableJsonValue(value)) }

function cloneJson(value) { return JSON.parse(JSON.stringify(value)) }

function providerContractCore(registry) {
  const codex = registry?.providers?.find(provider => provider?.id === 'codex')
  if (!codex) fail('Codex provider contract core is missing')
  return {
    $schema: cloneJson(registry.$schema),
    kind: cloneJson(registry.kind),
    contractVersion: cloneJson(registry.contractVersion),
    safeSupportValues: cloneJson(registry.safeSupportValues),
    capabilityDefinitions: cloneJson(registry.capabilityDefinitions),
    admissionPolicy: cloneJson(registry.admissionPolicy),
    attestationVerificationPolicy: cloneJson(registry.attestationVerificationPolicy),
    verificationAttestationSchema: cloneJson(registry.verificationAttestationSchema),
    providers: [codexProviderAdmissionProjection(codex)],
  }
}

function providerContractCoreSha256(registry) {
  return sha256(Buffer.from(stableJsonV1(providerContractCore(registry)), 'utf8'))
}

function codexProviderAdmissionProjection(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider) || provider.id !== 'codex') {
    fail('Codex provider admission record is invalid')
  }
  const projection = cloneJson(provider)
  delete projection.verificationAttestation
  return projection
}

function codexProviderAdmissionSha256(provider) {
  return sha256(Buffer.from(stableJsonV1(codexProviderAdmissionProjection(provider)), 'utf8'))
}

function codexPayloadDigestProjection(manifest) {
  return {
    provider: manifest.provider,
    sourceRoot: manifest.sourceRoot,
    contractVersion: manifest.contractVersion,
    rolePolicy: manifest.rolePolicy,
    logicalRoles: manifest.logicalRoles,
    entrypoints: manifest.entrypoints,
    files: manifest.files,
    sha256: manifest.sha256,
    externalDependencies: manifest.externalDependencies,
    dynamicRequires: manifest.dynamicRequires,
    localRequireClosure: manifest.localRequireClosure,
  }
}

function dependencyMap(manifest) {
  if (!Array.isArray(manifest?.externalDependencies)) {
    fail('Codex deploy-core external dependency inventory is missing')
  }
  const entries = manifest.externalDependencies.map(dependency => [dependency?.source, dependency])
  const dependencies = new Map(entries)
  if (dependencies.size !== entries.length) fail('Codex deploy-core dependency inventory has duplicates')
  return dependencies
}

function trustNeutralManifest(manifest, options = {}) {
  const normalized = cloneJson(manifest)
  const dependencies = dependencyMap(normalized)
  const providers = dependencies.get(PROVIDERS_SOURCE)
  const keyRing = dependencies.get(KEY_RING_SOURCE)
  const evidence = dependencies.get(EVIDENCE_SOURCE)
  const providerCoreSha256 = options.providerRegistry
    ? providerContractCoreSha256(options.providerRegistry)
    : normalized.providerContractCoreSha256
  if (!HASH_PATTERN.test(providerCoreSha256 || '') ||
      !HASH_PATTERN.test(providers?.sha256 || '') ||
      !HASH_PATTERN.test(keyRing?.sha256 || '') ||
      !HASH_PATTERN.test(evidence?.sha256 || '')) {
    fail('Codex deploy-core trust dependency binding is invalid')
  }
  if (normalized.providerContractCoreSha256 &&
      normalized.providerContractCoreSha256 !== providerCoreSha256) {
    fail('Codex deploy-core provider projection is stale')
  }
  providers.sha256 = providerCoreSha256
  evidence.sha256 = ZERO_HASH
  normalized.providerContractCoreSha256 = providerCoreSha256
  for (const field of [
    'payloadDigest', 'payloadGeneration', 'payloadClosureDigest',
    'logicalToPhysicalProviderRole', 'physicalRoles',
  ]) delete normalized[field]
  return normalized
}

function deriveCodexDeployCore(manifest, options = {}) {
  if (!manifest || manifest.provider !== 'codex' ||
      !/^\d+\.\d+\.\d+$/.test(manifest.contractVersion || '')) {
    fail('Codex deploy-core manifest is invalid')
  }
  const normalizedManifest = trustNeutralManifest(manifest, options)
  const payloadDigest = sha256(Buffer.from(stableJsonV1(
    codexPayloadDigestProjection(normalizedManifest),
  ), 'utf8'))
  return Object.freeze({
    payloadDigest,
    payloadGeneration: `codex-v${manifest.contractVersion}-${payloadDigest.slice(0, 16)}`,
    providerContractCoreSha256: normalizedManifest.providerContractCoreSha256,
    runtimeManifestCoreSha256: sha256(Buffer.from(stableJsonV1(normalizedManifest), 'utf8')),
    normalizedManifest: Object.freeze(normalizedManifest),
  })
}

function codexPayloadClosureDigest(manifest) {
  const closure = cloneJson(manifest)
  delete closure.payloadClosureDigest
  return sha256(Buffer.from(stableJsonV1(closure), 'utf8'))
}

function exactBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  fail(`${label} bytes are invalid`)
}

function parsedJsonBytes(value, label) {
  const bytes = exactBuffer(value, label)
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { fail(`${label} is invalid`) }
  return { bytes, parsed }
}

function deriveCodexRuntimeIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Codex runtime identity input is invalid')
  }
  const { bytes: manifestBytes, parsed: manifest } = parsedJsonBytes(
    input.runtimeManifestBytes, 'Codex runtime identity manifest',
  )
  const { bytes: providerRegistryBytes, parsed: providerRegistry } = parsedJsonBytes(
    input.providerRegistryBytes, 'Codex provider registry',
  )
  const { bytes: trustedKeyRingBytes } = parsedJsonBytes(
    input.trustedKeyRingBytes, 'Codex provider trusted key ring',
  )
  const { bytes: evidenceBytes, parsed: evidence } = parsedJsonBytes(
    input.evidenceBytes, 'Codex live conformance evidence',
  )
  const codexConfigureBytes = exactBuffer(input.codexConfigureBytes, 'Codex configure runtime')
  const executable = input.codexExecutable
  const canonicalManifest = `${JSON.stringify(manifest, null, 2)}\n`
  const dependencies = dependencyMap(manifest)
  if (manifestBytes.toString('utf8') !== canonicalManifest ||
      dependencies.get(PROVIDERS_SOURCE)?.sha256 !== sha256(providerRegistryBytes) ||
      dependencies.get(KEY_RING_SOURCE)?.sha256 !== sha256(trustedKeyRingBytes) ||
      dependencies.get(EVIDENCE_SOURCE)?.sha256 !== sha256(evidenceBytes) ||
      !executable || typeof executable.realpath !== 'string' ||
      typeof executable.platform !== 'string' || !executable.platform ||
      typeof executable.arch !== 'string' || !executable.arch ||
      typeof executable.basename !== 'string' || !executable.basename ||
      !/^[a-f0-9]{64}$/.test(executable.sha256 || '') ||
      typeof executable.version !== 'string' || !executable.version.trim() ||
      codexConfigureBytes.length === 0) {
    fail('Codex runtime identity input is invalid')
  }
  const deployCore = deriveCodexDeployCore(manifest, { providerRegistry })
  const codexProvider = providerRegistry.providers.find(provider => provider?.id === 'codex')
  const providerAdmissionSha256 = codexProviderAdmissionSha256(codexProvider)
  if (manifest.payloadDigest !== deployCore.payloadDigest ||
      manifest.payloadGeneration !== deployCore.payloadGeneration ||
      manifest.providerContractCoreSha256 !== deployCore.providerContractCoreSha256 ||
      manifest.payloadClosureDigest !== codexPayloadClosureDigest(manifest)) {
    fail('Codex runtime identity deploy-core binding is invalid')
  }
  const identity = Object.freeze({
    providerId: 'codex',
    contractVersion: manifest.contractVersion,
    payloadGeneration: deployCore.payloadGeneration,
    payloadDigest: deployCore.payloadDigest,
    runtimeManifestSha256: deployCore.runtimeManifestCoreSha256,
    providerAdmissionSha256,
    providerContractCoreSha256: deployCore.providerContractCoreSha256,
    trustedKeyRingSha256: sha256(trustedKeyRingBytes),
    codexConfigureSha256: sha256(codexConfigureBytes),
    codexExecutablePlatform: executable.platform,
    codexExecutableArch: executable.arch,
    codexExecutableBasename: executable.basename,
    codexExecutableSha256: executable.sha256,
    codexExecutableVersion: executable.version.trim(),
  })
  const canonicalJson = stableJsonV1(identity)
  return Object.freeze({
    identity,
    canonicalJson,
    runtimeIdentityHash: sha256(Buffer.from(canonicalJson, 'utf8')),
    evidence: Object.freeze(cloneJson(evidence)),
    evidenceSha256: sha256(evidenceBytes),
    providerRegistrySha256: sha256(providerRegistryBytes),
    providerAdmissionSha256,
    providerContractCoreSha256: deployCore.providerContractCoreSha256,
    trustedKeyRingSha256: sha256(trustedKeyRingBytes),
    codexExecutableRealpath: executable.realpath,
  })
}

module.exports = {
  EVIDENCE_SOURCE,
  HASH_PATTERN,
  KEY_RING_SOURCE,
  PROVIDERS_SOURCE,
  ZERO_HASH,
  codexPayloadClosureDigest,
  codexPayloadDigestProjection,
  codexProviderAdmissionProjection,
  codexProviderAdmissionSha256,
  deriveCodexDeployCore,
  deriveCodexRuntimeIdentity,
  providerContractCore,
  providerContractCoreSha256,
  sha256,
  stableJsonV1,
  trustNeutralManifest,
}
