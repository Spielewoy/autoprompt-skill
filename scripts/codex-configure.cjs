#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const operationLock = require('./install/operation-lock.cjs')
const { detectLegacyCodexInstall } = require('./install/legacy-compat.cjs')
const safeRunRoot = require('../agents/codex/workflow/safe-run-root.js')
const {
  admitCodexExecutable,
  bindAdmittedCodexExecutable,
  queryAdmittedCodexVersion,
  resolveCodexExecutable,
  withCodexManagedEnvironment,
} = require('../agents/codex/workflow/codex-executable.js')
const {
  createSafeChildGitEnvironment,
  discoverRepository,
  inspect,
} = require('./local-only-safety.cjs')
const {
  physicalProviderRole,
  validateCodexRoleProjection,
} = require('./runtime-payload.cjs')
const {
  codexProviderAdmissionProjection,
  codexProviderAdmissionSha256,
  deriveCodexRuntimeIdentity,
  providerContractCoreSha256,
  stableJsonV1,
} = require('./codex-runtime-identity.cjs')
const {
  verifyCapabilityAttestation,
} = require('../agents/codex/workflow/router.js')

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const RECEIPT = '.autoprompt-install-receipt.json'
const HASHES = '.autoprompt-install-hashes.json'
const AGENT_PATTERN = /^ap-[a-z0-9-]+\.toml$/
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const CASTING_HASH_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/
const ACTIVATION_SCHEMA_VERSION = 2
// The activation ID and safe-run-root layout add more than 150 characters.
// Keep the private namespace compact so Windows ACL tools can address every
// descendant without crossing their legacy MAX_PATH boundary.
const ACTIVATION_DIRECTORY = '.a'
const QUARANTINE_DIRECTORY = path.join('.autoprompt-private', 'quarantine', 'legacy-global-agents')
const ACTIVATION_RECORD = 'activation.json'
const ACTIVATION_PAYLOAD_MANIFEST = 'activation-payload.json'
const ENFORCEMENT_PROOF = 'enforcement-proof.json'
const SUPERVISOR_RUNTIME_RECEIPT = 'supervisor-runtime-binding.json'
const GIT_EMPTY_CONFIG = 'git-empty.config'
const GH_CONFIG_DIRECTORY = 'gh-config'
const DISCOVERY_SKILL_RELATIVE = path.join('skills', 'autoprompt', 'SKILL.md')
const PRIVATE_BUNDLE_DIRECTORY = path.join('.autoprompt-private', 'bundles')
const CODEX_TRUSTED_KEY_RING = path.join(
  PACKAGE_ROOT, 'agents', 'contracts', 'codex-trusted-public-keys.json',
)
const CODEX_LIVE_CONFORMANCE_EVIDENCE = path.join(
  PACKAGE_ROOT, 'agents', 'contracts', 'codex-live-conformance-evidence.json',
)
const PROFILE_NAME = 'autoprompt'
const CHECKER_PROFILE_NAME = 'autoprompt-checker'
const CONTRACT_VERSION = '2.0.0'
const ACTIVATION_ID_PATTERN = /^apv2-[a-f0-9]{32}$/
const DEFAULT_ACTIVATION_TTL_SECONDS = 4 * 60 * 60
const MAX_ACTIVATION_TTL_SECONDS = 24 * 60 * 60
const ROOT_LEGAL_CHILDREN = Object.freeze(['ap-route-analyst'])
const PROVIDER_CAPABILITIES = Object.freeze({
  provider: 'codex',
  isolation: 'strict',
  topologyEnforcement: 'prompt-guarded',
  privateSkillRoot: true,
  processOwnership: false,
  eventStreaming: false,
  toolOutputCapture: false,
  stableChildIdentity: false,
  sameContextContinuation: false,
  isolatedChecking: false,
  cancellation: false,
  modelRouting: true,
})
const LOCAL_CONFORMANCE_BLOCKERS = Object.freeze([
  'canonical-live-evidence-invalid',
  'external-attestation-missing',
  'external-attestation-verification-method-invalid',
  'supported-capability-unattested-isolation',
  'supported-capability-unattested-privateSkillRoot',
  'supported-capability-unattested-processOwnership',
])
const LOCAL_CONFORMANCE_STATUS = 'LOCAL_CONFORMANCE'
const LOCAL_CONFORMANCE_PENDING_STATUS = 'LOCAL_CONFORMANCE_PENDING'
const LOCAL_CONFORMANCE_VERIFICATION_METHOD = 'activation-local-conformance'
const DISABLED_CODEX_FEATURES = Object.freeze([
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'enable_mcp_apps',
  'external_agent_memory_import',
  'hooks',
  'image_generation',
  'in_app_browser',
  'mcp_2026_07_28',
  'multi_agent',
  'multi_agent_v2',
  'network_proxy',
  'non_prefixed_mcp_tool_names',
  'plugin_sharing',
  'plugins',
  'recommended_plugins',
  'remote_plugin',
  'request_permissions_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
])
const TIERS = Object.freeze([
  ['ap-scope-coordinator', 'ap-feature-coordinator', 'ap-sweep-coordinator', 'ap-run-coordinator', 'ap-work-group-manager', 'ap-manager'],
  ['ap-reviewer', 'ap-independent-checker', 'ap-fresh-verifier', 'ap-verifier', 'ap-juror', 'ap-goal-checker', 'ap-depth-prober', 'ap-arbiter', 'ap-framework-validator', 'ap-re-anchor'],
  ['ap-implementer', 'ap-worker', 'ap-roadmap-author', 'ap-roadmap-scout', 'ap-planner', 'ap-researcher', 'ap-scoper', 'ap-synthesizer', 'ap-execharness-resolver', 'ap-framework-generator'],
  ['ap-preflight-probe', 'ap-intake', 'ap-scribe'],
  ['ap-sweeper', 'ap-janitor', 'ap-route-analyst'],
])
const EFFORTS = ['xhigh', 'high', 'high', 'medium', 'low']
const ROLE_TIER = new Map(TIERS.flatMap((roles, tier) => roles.map(role => [role, tier])))

class ConfigureError extends Error {}
class ProviderUnsupportedError extends ConfigureError {
  constructor(reason, details = null) {
    const suffix = details
      ? ` file=${details.file} expected=${details.expected} actual=${details.actual}`
      : ''
    super(`PROVIDER_UNSUPPORTED provider=codex reason=${reason}${suffix}`)
    this.code = 'PROVIDER_UNSUPPORTED'
    this.reason = reason
    this.details = details ? Object.freeze({ ...details }) : null
  }
}

function fail(message) { throw new ConfigureError(message) }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function hasExactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()))
}
function castingDigest(value) {
  const match = CASTING_HASH_PATTERN.exec(String(value || ''))
  return match ? match[1] : ''
}
function comparable(file) {
  let resolved = path.resolve(file)
  try { resolved = fs.realpathSync.native(resolved) } catch {}
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function readJson(file, label) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail(`${label} is unreadable: ${file}`) }
  return parsed
}

function canonicalCodexVerifiedCapabilities(registry = null) {
  const providerRegistry = registry || readJson(
    path.join(PACKAGE_ROOT, 'agents', 'contracts', 'providers.json'), 'provider registry',
  )
  const provider = providerRegistry?.providers?.find(candidate => candidate?.id === 'codex')
  const admission = codexProviderAdmissionProjection(provider)
  const capabilities = Object.entries(admission.capabilities || {})
    .filter(([, support]) => support === 'supported')
    .map(([capability]) => capability)
    .sort()
  if (!capabilities.length) fail('Codex provider has no canonical supported capability set')
  return Object.freeze(capabilities)
}

function isCanonicalCodexVerifiedCapabilities(capabilities, registry = null) {
  return Array.isArray(capabilities) && JSON.stringify(capabilities) ===
    JSON.stringify(canonicalCodexVerifiedCapabilities(registry))
}

function codexExecutableIdentity(options = {}) {
  const env = options.env || process.env
  let runtime
  try {
    runtime = resolveCodexExecutable(options.codexExecutable || 'codex', {
      environment: env,
      expectedSha256: options.codexExecutableSha256,
      expectedVersion: options.codexExecutableVersion,
    })
  } catch {
    unsupported('codex-cli-missing')
  }
  if (!runtime.identity.version) unsupported('codex-cli-version-pin-unavailable')
  return Object.freeze({ identity: runtime.identity, runtime })
}

function deriveCurrentCodexRuntimeIdentity(options = {}) {
  const files = {
    runtimeManifestBytes: path.join(PACKAGE_ROOT, 'agents', 'manifests', 'codex-runtime.json'),
    providerRegistryBytes: path.join(PACKAGE_ROOT, 'agents', 'contracts', 'providers.json'),
    trustedKeyRingBytes: CODEX_TRUSTED_KEY_RING,
    evidenceBytes: CODEX_LIVE_CONFORMANCE_EVIDENCE,
    codexConfigureBytes: __filename,
  }
  for (const [label, file] of Object.entries(files)) assertRegularUnlinked(file, label)
  const executable = codexExecutableIdentity(options)
  const identity = deriveCodexRuntimeIdentity({
    ...Object.fromEntries(Object.entries(files).map(([label, file]) => [label, fs.readFileSync(file)])),
    codexExecutable: executable.identity,
    contractVersion: CONTRACT_VERSION,
  })
  return Object.freeze({ ...identity, codexExecutableRuntime: executable.runtime })
}

function loadReleaseCodexTrustedPublicKeys(options = {}) {
  if (options.providerTrustedPublicKeys || options.trustedPublicKeys) {
    return options.providerTrustedPublicKeys || options.trustedPublicKeys
  }
  const file = options.providerTrustedKeyRingPath || CODEX_TRUSTED_KEY_RING
  if (!fs.existsSync(file)) return {}
  assertRegularUnlinked(file, 'Codex provider trusted key ring')
  const ring = readJson(file, 'Codex provider trusted key ring')
  if (!ring || JSON.stringify(Object.keys(ring).sort()) !==
      JSON.stringify(['keys', 'providerId', 'schemaVersion']) ||
      ring.schemaVersion !== '1.0.0' || ring.providerId !== 'codex' ||
      !Array.isArray(ring.keys)) {
    unsupported('provider-trusted-key-ring-invalid')
  }
  const trusted = Object.create(null)
  const now = (options.now instanceof Date ? options.now : new Date()).getTime()
  for (const entry of ring.keys) {
    if (!entry || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([
      'algorithm', 'format', 'keyId', 'notAfter', 'notBefore', 'publicKeyPem', 'status',
    ]) || entry.algorithm !== 'ed25519' || entry.format !== 'spki-pem' ||
        !/^[a-f0-9]{64}$/.test(entry.keyId || '') ||
        !['trusted', 'revoked'].includes(entry.status) ||
        !Number.isFinite(Date.parse(entry.notBefore)) ||
        !Number.isFinite(Date.parse(entry.notAfter)) ||
        Date.parse(entry.notBefore) >= Date.parse(entry.notAfter) ||
        typeof entry.publicKeyPem !== 'string') {
      unsupported('provider-trusted-key-ring-invalid')
    }
    let publicKey
    let keyId
    try {
      publicKey = crypto.createPublicKey(entry.publicKeyPem)
      keyId = sha256(publicKey.export({ type: 'spki', format: 'der' }))
    } catch { unsupported('provider-trusted-key-ring-invalid') }
    if (publicKey.asymmetricKeyType !== 'ed25519' || keyId !== entry.keyId || trusted[keyId]) {
      unsupported('provider-trusted-key-ring-invalid')
    }
    if (entry.status === 'trusted' && now >= Date.parse(entry.notBefore) &&
        now < Date.parse(entry.notAfter)) trusted[keyId] = publicKey
  }
  return Object.freeze(trusted)
}

function evaluateCanonicalCodexCapabilityTrustAgainstIdentity(registry, runtimeIdentity,
  options = {}) {
  const blockers = []
  const requiredCapabilities = ['isolation', 'privateSkillRoot', 'processOwnership']
  if (!runtimeIdentity?.runtimeIdentityHash) blockers.push('candidate-runtime-identity-unavailable')
  const evidence = runtimeIdentity?.evidence
  const evidenceExecutable = evidence?.evidence?.codexExecutable
  const expectedEnvironment = runtimeIdentity?.identity ? {
    platform: runtimeIdentity.identity.codexExecutablePlatform,
    arch: runtimeIdentity.identity.codexExecutableArch,
    codexExecutableBasename: runtimeIdentity.identity.codexExecutableBasename,
    codexExecutableSha256: runtimeIdentity.identity.codexExecutableSha256,
    codexExecutableVersion: runtimeIdentity.identity.codexExecutableVersion,
  } : null
  const evidenceValid = evidence?.schemaVersion === 'codex-live-conformance-evidence.v1' &&
    evidence.result === 'PASS' && evidence.fixtureOnly === false &&
    evidence.runtimeIdentityHash === runtimeIdentity?.runtimeIdentityHash &&
    evidence?.evidence?.canarySchema === 'codex-live-canary.v1' &&
    evidence?.evidence?.canaryResult === 'PASS' &&
    evidenceExecutable?.realpath === runtimeIdentity?.codexExecutableRealpath &&
    evidenceExecutable?.platform === runtimeIdentity?.identity?.codexExecutablePlatform &&
    evidenceExecutable?.arch === runtimeIdentity?.identity?.codexExecutableArch &&
    evidenceExecutable?.basename === runtimeIdentity?.identity?.codexExecutableBasename &&
    evidenceExecutable?.sha256 === runtimeIdentity?.identity?.codexExecutableSha256 &&
    evidenceExecutable?.version === runtimeIdentity?.identity?.codexExecutableVersion
  if (runtimeIdentity && !evidenceValid) blockers.push('canonical-live-evidence-invalid')
  const evidenceCanonicalSha256 = evidence
    ? sha256(Buffer.from(stableJsonV1(evidence), 'utf8'))
    : null
  const expectedActivationNonce = evidenceCanonicalSha256
    ? Buffer.from(evidenceCanonicalSha256, 'hex').toString('base64url')
    : null
  const provider = registry?.providers?.find(candidate => candidate?.id === 'codex') || null
  const providerAdmissionSha256 = provider ? codexProviderAdmissionSha256(provider) : null
  const providerContractSha256 = provider ? providerContractCoreSha256(registry) : null
  if (runtimeIdentity && runtimeIdentity.providerContractCoreSha256 !== providerContractSha256) {
    blockers.push('candidate-provider-contract-mismatch')
  }
  if (!provider) blockers.push('codex-provider-entry-missing')
  if (provider && provider.implementationStatus !== 'verified') {
    blockers.push(`implementation-status-${provider.implementationStatus || 'missing'}`)
  }
  if (provider && provider.currentIsolationClass !== 'strict') {
    blockers.push(`isolation-class-${provider.currentIsolationClass || 'missing'}`)
  }
  const attestationGatedAdmission = provider?.attestationRequired === true &&
    provider.defaultAdmission === 'allow-verified-required-capabilities'
  if (provider && !attestationGatedAdmission) blockers.push('attestation-admission-policy-invalid')
  for (const capability of requiredCapabilities) {
    const value = provider?.capabilities?.[capability]
    if (value !== 'supported') {
      const label = capability === 'privateSkillRoot' ? 'private-skill-root' : capability
      blockers.push(`${label}-capability-${value || 'missing'}`)
    }
  }
  const attestation = provider?.verificationAttestation || null
  if (!attestation) blockers.push('external-attestation-missing')
  if (attestation?.issuer === 'autoprompt-codex-activation-v2') {
    blockers.push('external-attestation-self-issued')
  }
  if (attestation && (attestation.signature?.algorithm !== 'ed25519' ||
      !/^[a-f0-9]{64}$/.test(attestation.signature?.keyId || ''))) {
    blockers.push('external-attestation-signing-policy-invalid')
  }
  if (attestation?.verificationMethod !== 'live-conformance-suite') {
    blockers.push('external-attestation-verification-method-invalid')
  }
  if (attestation && (attestation.providerAdmissionSha256 !== providerAdmissionSha256 ||
      runtimeIdentity?.providerAdmissionSha256 !== providerAdmissionSha256)) {
    blockers.push('external-attestation-provider-admission-mismatch')
  }
  const supportedCapabilities = Object.entries(provider?.capabilities || {})
    .filter(([, value]) => value === 'supported')
    .map(([capability]) => capability)
    .sort()
  const attestedCapabilities = Array.isArray(attestation?.verifiedCapabilities)
    ? [...attestation.verifiedCapabilities]
    : []
  const canonicalAttestedCapabilities = [...new Set(attestedCapabilities)].sort()
  if (JSON.stringify(attestedCapabilities) !== JSON.stringify(canonicalAttestedCapabilities)) {
    blockers.push('external-attestation-capabilities-not-canonical')
  }
  for (const capability of supportedCapabilities) {
    if (!canonicalAttestedCapabilities.includes(capability)) {
      blockers.push(`supported-capability-unattested-${capability}`)
    }
  }
  for (const capability of canonicalAttestedCapabilities) {
    if (!supportedCapabilities.includes(capability)) {
      blockers.push(`attested-capability-not-supported-${capability}`)
    }
  }
  const environmentMatches = Boolean(attestation?.supportedEnvironment && expectedEnvironment &&
    stableJsonV1(attestation.supportedEnvironment) === stableJsonV1(expectedEnvironment))
  if (attestation && !environmentMatches) {
    blockers.push('external-attestation-environment-mismatch')
  }
  if (attestation && runtimeIdentity &&
      attestation.runtimeIdentityHash !== runtimeIdentity.runtimeIdentityHash) {
    blockers.push('external-attestation-runtime-identity-mismatch')
  }
  if (attestation && expectedActivationNonce &&
      attestation.activationNonce !== expectedActivationNonce) {
    blockers.push('external-attestation-evidence-binding-mismatch')
  }
  let verification = null
  if (attestation && runtimeIdentity &&
      attestation.issuer !== 'autoprompt-codex-activation-v2') {
    verification = verifyCapabilityAttestation(attestation, {
      providerId: 'codex',
      runtimeIdentityHash: runtimeIdentity.runtimeIdentityHash,
      activationNonce: expectedActivationNonce,
      requiredCapabilities: supportedCapabilities,
      now: options.now instanceof Date ? options.now : new Date(),
      trustedPublicKeys: options.trustedPublicKeys || {},
    })
    if (!verification.valid) blockers.push('external-attestation-unverified')
  }
  const registrySha256 = sha256(Buffer.from(JSON.stringify(registry ?? null), 'utf8'))
  const providerRecordSha256 = provider
    ? sha256(Buffer.from(JSON.stringify(provider), 'utf8'))
    : null
  const externalAttestationSha256 = attestation
    ? sha256(Buffer.from(JSON.stringify(attestation), 'utf8'))
    : null
  return Object.freeze({
    ready: blockers.length === 0,
    status: blockers.length === 0 ? 'VERIFIED' : 'PROVIDER_UNSUPPORTED',
    blockers: Object.freeze(blockers),
    registrySha256,
    providerRecordSha256,
    externalAttestationSha256,
    externalAttestation: attestation,
    runtimeIdentity,
    evidenceSha256: runtimeIdentity?.evidenceSha256 || null,
    evidenceCanonicalSha256,
    providerAdmissionSha256,
    providerContractCoreSha256: providerContractSha256,
    verifiedCapabilities: verification?.valid
      ? Object.freeze([...verification.verifiedCapabilities])
      : Object.freeze([]),
  })
}

function evaluateCanonicalCodexCapabilityTrust(registry, options = {}) {
  let runtimeIdentity = null
  try { runtimeIdentity = deriveCurrentCodexRuntimeIdentity(options) } catch {}
  return evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    registry, runtimeIdentity, options,
  )
}

function localConformancePending(trust, registry) {
  const provider = registry?.providers?.find(candidate => candidate?.id === 'codex') || null
  return Boolean(!trust.ready && trust.runtimeIdentity &&
    provider?.verificationAttestation === null &&
    JSON.stringify([...trust.blockers].sort()) ===
      JSON.stringify([...LOCAL_CONFORMANCE_BLOCKERS].sort()))
}

function requireCanonicalCodexCapabilityTrust(options = {}) {
  const registry = options.providerRegistry || readJson(
    path.join(PACKAGE_ROOT, 'agents', 'contracts', 'providers.json'), 'provider registry',
  )
  const trust = evaluateCanonicalCodexCapabilityTrust(registry, {
    codexExecutable: options.codexExecutable,
    codexExecutableSha256: options.codexExecutableSha256,
    codexExecutableVersion: options.codexExecutableVersion,
    env: options.env,
    now: options.now,
    trustedPublicKeys: loadReleaseCodexTrustedPublicKeys(options),
  })
  const localPending = localConformancePending(trust, registry)
  if (!trust.ready && !localPending) unsupported('canonical-provider-capability-refusal', {
    file: path.join(PACKAGE_ROOT, 'agents', 'contracts', 'providers.json'),
    expected: 'externally-verified-strict-isolation-and-private-skill-root',
    actual: trust.blockers.join(','),
  })
  let admittedRuntime
  try {
    admittedRuntime = admitCodexExecutable(
      trust.runtimeIdentity.codexExecutableRuntime,
      {
        realpath: trust.runtimeIdentity.codexExecutableRealpath,
        platform: trust.runtimeIdentity.identity.codexExecutablePlatform,
        arch: trust.runtimeIdentity.identity.codexExecutableArch,
        basename: trust.runtimeIdentity.identity.codexExecutableBasename,
        sha256: trust.runtimeIdentity.identity.codexExecutableSha256,
        version: trust.runtimeIdentity.identity.codexExecutableVersion,
      },
    )
    queryAdmittedCodexVersion(admittedRuntime, {
      cwd: PACKAGE_ROOT,
      environment: options.env || process.env,
      // LOCAL_CONFORMANCE must execute the exact admitted binary rather than a
      // caller-provided probe stub. The runtime identity is fixed before this
      // first execution and every later local capability is bound to it.
      spawnSync: localPending ? childProcess.spawnSync : options.spawnSync,
    })
  } catch {
    unsupported('codex-executable-post-admission-verification-failed')
  }
  return Object.freeze({
    ...trust,
    ...(localPending ? {
      status: LOCAL_CONFORMANCE_PENDING_STATUS,
      localConformancePending: true,
    } : { localConformancePending: false }),
    codexRuntime: admittedRuntime,
  })
}

function canonicalProviderTrustBinding(trust) {
  if (!trust || trust.ready !== true || trust.status !== 'VERIFIED') {
    unsupported('canonical-provider-trust-binding-invalid')
  }
  const binding = {
    schemaVersion: CONTRACT_VERSION,
    status: 'VERIFIED',
    registrySha256: trust.registrySha256,
    providerRecordSha256: trust.providerRecordSha256,
    externalAttestationSha256: trust.externalAttestationSha256,
    evidenceSha256: trust.evidenceSha256,
    externalIssuer: trust.externalAttestation.issuer,
    externalKeyId: trust.externalAttestation.signature.keyId,
    runtimeIdentityHash: trust.runtimeIdentity.runtimeIdentityHash,
    verifiedCapabilities: [...trust.verifiedCapabilities],
  }
  binding.sha256 = sha256(Buffer.from(JSON.stringify(binding), 'utf8'))
  return binding
}

function localConformanceTargetHash(target) {
  return sha256(Buffer.from(stableJsonV1(target), 'utf8'))
}

function validateOwnedProcessConformanceEvidence(record) {
  const evidence = record?.localConformance
  const probe = evidence?.processProbe
  const registry = evidence?.processRegistry
  if (!hasExactKeys(evidence, ['schemaVersion', 'processProbe', 'processRegistry']) ||
      evidence.schemaVersion !== 1 ||
      !hasExactKeys(probe, [
        'adapterKind', 'drained', 'groupIdentity', 'kind', 'ownershipId', 'probeHash',
        'schemaVersion', 'targetKey', 'terminalStatus',
      ]) || probe.schemaVersion !== 1 || probe.kind !== 'owned-process-conformance' ||
      !['posix-process-group', 'windows-job-object'].includes(probe.adapterKind) ||
      probe.drained !== true || probe.terminalStatus !== 'DONE' ||
      typeof probe.ownershipId !== 'string' || !probe.ownershipId ||
      typeof probe.groupIdentity !== 'string' || !probe.groupIdentity ||
      probe.targetKey !== localConformanceTargetHash(record.target) ||
      !/^[a-f0-9]{64}$/.test(probe.probeHash || '') ||
      !hasExactKeys(registry, ['path', 'sha256']) ||
      typeof registry.path !== 'string' || !path.isAbsolute(registry.path) ||
      !isWithin(record.activationRoot, path.resolve(registry.path)) ||
      !/^[a-f0-9]{64}$/.test(registry.sha256 || '')) {
    unsupported('local-conformance-process-evidence-invalid')
  }
  const probeBody = { ...probe }
  delete probeBody.probeHash
  if (probe.probeHash !== sha256(Buffer.from(stableJsonV1(probeBody), 'utf8'))) {
    unsupported('local-conformance-process-evidence-invalid')
  }
  const registryBytes = readRegularBound(registry.path, 'local-conformance-process-registry')
  if (sha256(registryBytes) !== registry.sha256) {
    unsupported('local-conformance-process-evidence-drift')
  }
  return evidence
}

function runLocalOwnedProcessConformance(record, environment) {
  const directory = ensurePrivateDirectory(
    record.activationRoot,
    path.join(record.activationRoot, 'local-conformance'),
    true,
  )
  const generation = Number(record.capability?.generation || 0)
  if (!Number.isSafeInteger(generation) || generation < 1) {
    unsupported('local-conformance-generation-invalid')
  }
  const registryPath = path.join(directory, `process-registry-${generation}.json`)
  const controlRoot = path.join(directory, `process-control-${generation}`)
  const input = Buffer.from(JSON.stringify({
    modulePath: path.join(PACKAGE_ROOT, 'agents', 'codex', 'workflow', 'process-owner.js'),
    activationId: record.activationId,
    generation,
    registryPath,
    controlRoot,
    activationRoot: record.activationRoot,
    targetPath: record.target.realpath,
    targetKey: localConformanceTargetHash(record.target),
  }), 'utf8').toString('base64url')
  const runner = String.raw`
'use strict'
const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'))
const ownerModule = require(input.modulePath)
const adapter = process.platform === 'win32'
  ? ownerModule.createWindowsJobAdapter({
      controlRoot: input.controlRoot,
      providerPrivateOwnershipRoot: input.activationRoot,
      trustedOwnershipRoots: [input.activationRoot],
    })
  : ownerModule.createPosixProcessAdapter()
const processOwner = new ownerModule.ProcessOwner({
  adapter,
  registryPath: input.registryPath,
  controlBinding: { activationId: input.activationId, generationId: input.generation },
})
;(async () => {
  try {
    if (process.argv[2] === 'cleanup') {
      await processOwner.cancelAll({
        reason: 'activation local process conformance recovery',
        graceMs: 0,
        killMs: 1000,
        terminalStatus: 'FAILED',
      })
      await processOwner.assertTargetDrained(input.targetKey)
      process.stdout.write('{"drained":true}\n')
      return
    }
    const probe = await ownerModule.runOwnedProcessConformanceProbe({
      adapter,
      processOwner,
      targetPath: input.targetPath,
      targetKey: input.targetKey,
      environment: process.env,
      sessionId: input.activationId + ':local-conformance',
      reason: 'activation local process conformance',
      killMs: 1000,
    })
    process.stdout.write(JSON.stringify(probe) + '\n')
  } catch (error) {
    try {
      await processOwner.cancelAll({
        reason: 'activation local process conformance failure',
        graceMs: 0,
        killMs: 1000,
        terminalStatus: 'FAILED',
      })
    } catch {}
    process.stderr.write(String(error && (error.code || error.message) || error) + '\n')
    process.exitCode = 1
  }
})()
`
  const spawnOptions = {
    cwd: record.target.realpath,
    env: environment,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }
  const result = childProcess.spawnSync(process.execPath, ['-e', runner, input], spawnOptions)
  if (!result || result.status !== 0 || result.error) {
    const cleanup = childProcess.spawnSync(process.execPath, ['-e', runner, input, 'cleanup'], {
      ...spawnOptions,
      timeout: 10_000,
    })
    unsupported('local-conformance-process-probe-failed', {
      expected: 'one bounded owned process must drain and crash recovery must leave no target process',
      actual: String(result?.error?.code || result?.signal || result?.status ||
        result?.stderr || 'unknown').slice(0, 768) +
        ` cleanup=${String(cleanup?.error?.code || cleanup?.signal || cleanup?.status ||
          cleanup?.stderr || 'unknown').slice(0, 256)}`,
    })
  }
  let processProbe
  try { processProbe = JSON.parse(String(result.stdout || '').trim()) } catch {
    unsupported('local-conformance-process-probe-invalid')
  }
  const registryBytes = readRegularBound(registryPath, 'local-conformance-process-registry')
  record.localConformance = {
    schemaVersion: 1,
    processProbe,
    processRegistry: { path: registryPath, sha256: sha256(registryBytes) },
  }
  validateOwnedProcessConformanceEvidence(record)
  return record.localConformance
}

function localProviderTrustBinding(trust, record, now) {
  if (!trust?.localConformancePending || trust.status !== LOCAL_CONFORMANCE_PENDING_STATUS) {
    unsupported('local-conformance-trust-pending-invalid')
  }
  const localEvidence = validateOwnedProcessConformanceEvidence(record)
  const body = {
    schemaVersion: CONTRACT_VERSION,
    status: LOCAL_CONFORMANCE_STATUS,
    admissionMode: 'explicit-local-activation',
    registrySha256: trust.registrySha256,
    providerRecordSha256: trust.providerRecordSha256,
    evidenceSha256: trust.evidenceSha256,
    runtimeIdentityHash: trust.runtimeIdentity.runtimeIdentityHash,
    providerAdmissionSha256: trust.providerAdmissionSha256,
    activationId: record.activationId,
    capabilityGeneration: record.capability.generation,
    requestSha256: record.request.sha256,
    targetIdentitySha256: localConformanceTargetHash(record.target),
    payloadManifestSha256: record.activationBoundary.payloadManifestSha256,
    enforcementProofSha256: record.activationBoundary.enforcementProof.sha256,
    providerProbeSha256: sha256(Buffer.from(stableJsonV1(record.providerProbe), 'utf8')),
    safetyInspectionSha256: sha256(Buffer.from(stableJsonV1(record.safety), 'utf8')),
    processOwnershipProbeSha256: sha256(Buffer.from(stableJsonV1(localEvidence), 'utf8')),
    verifiedCapabilities: [...canonicalCodexVerifiedCapabilities()],
    probedAt: now.toISOString(),
  }
  return Object.freeze({
    ...body,
    sha256: sha256(Buffer.from(stableJsonV1(body), 'utf8')),
  })
}
function readableRegularFile(file, label) {
  let stat
  try { stat = fs.lstatSync(file) } catch { fail(`${label} is missing: ${file}`) }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular file: ${file}`)
}
function resolveRoot(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir()
  const raw = env.AUTOPROMPT_INSTALL_ROOT || env.CODEX_HOME || path.join(home, '.codex')
  if (typeof raw !== 'string' || !raw || /[\u0000-\u001f\u007f"]/.test(raw) ||
      !path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    fail('Codex root must be an absolute path without traversal')
  }
  const root = path.resolve(raw)
  if (root === path.parse(root).root) fail('filesystem root is not a valid Codex root')
  let stat
  try { stat = fs.lstatSync(root) } catch { fail(`Codex root is not installed: ${root}`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Codex root must be a real directory')
  return root
}
function parseModelList(value) {
  const models = String(value).split(',').map(item => item.trim())
  if (!models.length || models.some(model => !MODEL_PATTERN.test(model))) fail('agents selector contains an invalid model identifier')
  if (new Set(models).size !== models.length) fail('agents selector contains duplicate models')
  if (models.length > 5) fail('Codex supports at most five selected models')
  return models
}
function readModelMap(modelMap) {
  if (!modelMap || !path.isAbsolute(modelMap)) fail('agents=auto requires an absolute readable --model-map')
  readableRegularFile(path.resolve(modelMap), 'model map')
  const parsed = readJson(modelMap, 'model map')
  if (!Array.isArray(parsed) || !parsed.length) fail('model map must be a non-empty JSON array')
  const seenNames = new Set()
  const seenModels = new Set()
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name ||
        typeof entry.modelString !== 'string' || !MODEL_PATTERN.test(entry.modelString)) {
      fail(`model map entry ${index + 1} is invalid`)
    }
    if (seenNames.has(entry.name) || seenModels.has(entry.modelString)) fail('model map names and model strings must be unique')
    seenNames.add(entry.name); seenModels.add(entry.modelString)
    const effort = entry.effortHint || 'medium'
    if (!['max', 'high', 'medium', 'low'].includes(effort)) fail(`model map entry ${entry.name} has an invalid effortHint`)
    return { name: entry.name, model: entry.modelString, effort, index }
  })
}
function resolveSelector(selector, modelMap) {
  const value = String(selector || '').trim()
  if (value.toLowerCase() === 'off') {
    if (modelMap) fail('--model-map is only valid with agents=auto')
    return { selector: 'off', models: [], registry: '' }
  }
  if (!/^auto(?::|$)/i.test(value)) {
    if (modelMap) fail('--model-map is only valid with agents=auto')
    return { selector: value, models: parseModelList(value), registry: '' }
  }
  const entries = readModelMap(modelMap)
  const pool = value.includes(':') ? value.slice(value.indexOf(':') + 1) : ''
  let selected = entries
  if (pool.trim()) {
    const names = pool.split(',').map(name => name.trim())
    if (names.some(name => !name) || new Set(names).size !== names.length) fail('agents=auto pool is invalid')
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    selected = names.map(name => byName.get(name) || fail(`unknown model map name: ${name}`))
  }
  if (selected.length > 5) fail('Codex supports at most five selected models')
  const weights = { max: 0, high: 1, medium: 2, low: 3 }
  selected = [...selected].sort((a, b) => weights[a.effort] - weights[b.effort] || a.index - b.index)
  return {
    selector: pool.trim() ? `auto:${pool}` : 'auto',
    models: selected.map(entry => entry.model),
    registry: path.resolve(modelMap),
  }
}
function modelIndexes(count) {
  return ({ 1: [0, 0, 0, 0, 0], 2: [0, 0, 1, 1, 1], 3: [0, 1, 1, 2, 2], 4: [0, 1, 2, 3, 3], 5: [0, 1, 2, 3, 4] })[count]
}
function renderAgent(bytes, role, selection) {
  const text = bytes.toString('utf8')
  const marker = 'developer_instructions = """'
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) fail(`agent definition is malformed: ${role}.toml`)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let header = text.slice(0, markerIndex)
  const body = text.slice(markerIndex)
  header = header.split(/\r?\n/)
    .filter(line => !/^(?:model|model_reasoning_effort)\s*=/.test(line))
  while (header.at(-1) === '') header.pop()
  if (selection.models.length) {
    const tier = ROLE_TIER.get(role)
    if (tier === undefined) fail(`installed role has no Codex casting tier: ${role}`)
    const model = selection.models[modelIndexes(selection.models.length)[tier]]
    const effort = EFFORTS[tier]
    const sandbox = header.findIndex(line => /^sandbox_mode\s*=/.test(line))
    if (sandbox < 0) fail(`agent definition has no sandbox_mode: ${role}.toml`)
    header.splice(sandbox + 1, 0, `model = "${model}"`, `model_reasoning_effort = "${effort}"`)
  }
  return Buffer.from(`${header.join(newline)}${newline}${newline}${body}`, 'utf8')
}
function runTool(script, args, options) {
  const result = childProcess.spawnSync(process.execPath, [script, ...args], {
    cwd: options.root, encoding: 'utf8', env: { ...options.env, HOME: options.env.HOME || options.env.USERPROFILE || options.root }, shell: false,
  })
  if (result.status !== 0) fail(String(result.stderr || result.stdout || `validator failed (${result.status})`).trim())
}
function atomicWrite(file, bytes, suffix, options) {
  const temporary = `${file}.autoprompt-configure-${suffix}`
  const { guard, index, phase, renameHook } = options
  guard.assertExisting(file, 'file')
  guard.assertParent(temporary)
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: fs.statSync(file).mode })
    guard.assertExisting(temporary, 'file')
    if (renameHook) renameHook({ file, index, phase, temporary })
    guard.assertExisting(file, 'file')
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) {
      guard.assertExisting(temporary, 'file')
      fs.unlinkSync(temporary)
    }
  }
}

function unsupported(reason, details = null) {
  throw new ProviderUnsupportedError(reason, details)
}

function directoryBinding(directory, label) {
  let stat
  try { stat = fs.lstatSync(directory, { bigint: true }) } catch { unsupported(`${label}-missing`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsupported(`${label}-not-real-directory`)
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    realpath: fs.realpathSync.native(directory),
  }
}

function assertDirectoryBinding(directory, binding, label) {
  const current = directoryBinding(directory, label)
  if (current.device !== binding.device || current.inode !== binding.inode ||
      comparable(current.realpath) !== comparable(binding.realpath)) {
    unsupported(`${label}-raced`)
  }
}

function sameFileIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function writePrivateFile(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const parent = path.dirname(file)
  const parentBinding = directoryBinding(parent, 'private-write-parent')
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  let temporaryIdentity = null
  try {
    const descriptor = fs.openSync(temporary, 'wx', mode)
    try {
      fs.writeFileSync(descriptor, bytes)
      fs.fsyncSync(descriptor)
      temporaryIdentity = fs.fstatSync(descriptor, { bigint: true })
    } finally {
      fs.closeSync(descriptor)
    }
    assertDirectoryBinding(parent, parentBinding, 'private-write-parent')
    if (fs.existsSync(file)) assertRegularUnlinked(file, 'private-write-target')
    fs.renameSync(temporary, file)
    const landed = assertRegularUnlinked(file, 'private-write-target')
    if (!temporaryIdentity || !sameFileIdentity(landed, temporaryIdentity)) {
      unsupported('private-write-target-raced')
    }
    assertDirectoryBinding(parent, parentBinding, 'private-write-parent')
    try { fs.chmodSync(file, mode) } catch {}
  } finally {
    try {
      const remaining = fs.lstatSync(temporary, { bigint: true })
      if (temporaryIdentity && sameFileIdentity(remaining, temporaryIdentity) &&
          !remaining.isSymbolicLink() && remaining.isFile()) {
        fs.unlinkSync(temporary)
      }
    } catch {}
  }
}

function writeJsonPrivate(file, value) {
  writePrivateFile(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

function writeJsonPrivateExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const parent = path.dirname(file)
  const parentBinding = directoryBinding(parent, 'private-exclusive-parent')
  const descriptor = fs.openSync(file, 'wx', 0o600)
  let opened
  try {
    fs.writeFileSync(descriptor, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
    fs.fsyncSync(descriptor)
    opened = fs.fstatSync(descriptor, { bigint: true })
  } finally {
    fs.closeSync(descriptor)
  }
  assertDirectoryBinding(parent, parentBinding, 'private-exclusive-parent')
  const landed = assertRegularUnlinked(file, 'private-exclusive-target')
  if (!opened || !sameFileIdentity(opened, landed)) unsupported('private-exclusive-target-raced')
  try { fs.chmodSync(file, 0o600) } catch {}
}

function assertRegularUnlinked(file, label) {
  let stat
  try { stat = fs.lstatSync(file, { bigint: true }) } catch { unsupported(`${label}-missing`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    unsupported(`${label}-not-regular`)
  }
  return stat
}

function readRegularBound(file, label) {
  const initial = assertRegularUnlinked(file, label)
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let opened
  let bytes
  try {
    opened = fs.fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n ||
        String(opened.dev) !== String(initial.dev) || String(opened.ino) !== String(initial.ino)) {
      unsupported(`${label}-raced`)
    }
    bytes = fs.readFileSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  const rebound = assertRegularUnlinked(file, label)
  if (String(rebound.dev) !== String(opened.dev) || String(rebound.ino) !== String(opened.ino) ||
      rebound.size !== BigInt(bytes.length)) {
    unsupported(`${label}-raced`)
  }
  return bytes
}

function validateWindowsSandboxIdentity(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1024 * 1024) {
    unsupported('codex-windows-sandbox-identity-invalid')
  }
  let identity
  try { identity = JSON.parse(bytes.toString('utf8')) } catch {
    unsupported('codex-windows-sandbox-identity-invalid')
  }
  const sid = value => typeof value === 'string' && /^S-\d+(?:-\d+){2,}$/.test(value)
  const map = value => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length <= 4096 && Object.entries(value).every(([key, mappedSid]) =>
      key.length > 0 && key.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(key) && sid(mappedSid))
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify([
        'readonly', 'workspace', 'workspace_by_cwd', 'writable_root_by_path',
      ]) || !sid(identity.workspace) || !sid(identity.readonly) ||
      !map(identity.workspace_by_cwd) || !map(identity.writable_root_by_path)) {
    unsupported('codex-windows-sandbox-identity-invalid')
  }
  return identity
}

function installWindowsSandboxIdentity(root, activationRoot) {
  if (process.platform !== 'win32') return null
  const source = path.join(root, 'cap_sid')
  let bytes
  try { bytes = readRegularBound(source, 'codex-windows-sandbox-identity') } catch (error) {
    if (error instanceof ProviderUnsupportedError &&
        error.message.endsWith('reason=codex-windows-sandbox-identity-missing')) {
      unsupported('codex-windows-sandbox-identity-unavailable')
    }
    unsupported('codex-windows-sandbox-identity-invalid')
  }
  validateWindowsSandboxIdentity(bytes)
  const destination = path.join(activationRoot, 'cap_sid')
  writePrivateFile(destination, bytes)
  return {
    kind: 'windows-cap-sid-v1',
    path: destination,
    sha256: sha256(bytes),
    sourceSha256: sha256(bytes),
  }
}

function inspectActivationPrerequisites(options = {}) {
  const env = options.env || process.env
  const root = resolveRoot(env)
  if (process.platform === 'win32') {
    const source = path.join(root, 'cap_sid')
    let bytes
    try {
      bytes = readRegularBound(source, 'codex-windows-sandbox-identity')
    } catch (error) {
      if (error instanceof ProviderUnsupportedError &&
          error.message.endsWith('reason=codex-windows-sandbox-identity-missing')) {
        unsupported('codex-windows-sandbox-identity-unavailable')
      }
      unsupported('codex-windows-sandbox-identity-invalid')
    }
    validateWindowsSandboxIdentity(bytes)
  }
  let runtime
  try {
    runtime = resolveCodexExecutable(options.codexExecutable || 'codex', {
      environment: env,
      expectedSha256: options.codexExecutableSha256,
      expectedVersion: options.codexExecutableVersion,
    })
  } catch {
    unsupported('codex-cli-missing')
  }
  return {
    schemaVersion: 1,
    provider: 'codex',
    activationPrerequisitesReady: true,
    dynamicSandboxPreflight: 'required-at-activation',
    sandboxIdentity: process.platform === 'win32' ? 'available' : 'not-required',
    runtimeSource: runtime.source,
  }
}

function verifyWindowsSandboxIdentity(activationRoot, binding) {
  if (process.platform !== 'win32') {
    if (binding !== null) unsupported('codex-windows-sandbox-identity-unexpected')
    return null
  }
  const expectedPath = path.join(activationRoot, 'cap_sid')
  if (!binding || binding.kind !== 'windows-cap-sid-v1' ||
      comparable(binding.path) !== comparable(expectedPath) ||
      !/^[a-f0-9]{64}$/.test(binding.sha256 || '') ||
      !/^[a-f0-9]{64}$/.test(binding.sourceSha256 || '')) {
    unsupported('codex-windows-sandbox-identity-invalid')
  }
  const bytes = readRegularBound(expectedPath, 'codex-windows-sandbox-identity')
  validateWindowsSandboxIdentity(bytes)
  if (sha256(bytes) !== binding.sha256) unsupported('codex-windows-sandbox-identity-drift')
  return binding
}

function assertRealDirectory(directory, label) {
  let stat
  try { stat = fs.lstatSync(directory) } catch { unsupported(`${label}-missing`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsupported(`${label}-not-real-directory`)
  return fs.realpathSync.native(directory)
}

function assertExistingDirectorySafe(directory, label) {
  if (!fs.existsSync(directory)) return false
  assertRealDirectory(directory, label)
  return true
}

function ensurePrivateDirectory(root, directory, create = false) {
  const relative = path.relative(root, directory)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    unsupported('private-state-path-invalid')
  }
  const rootReal = fs.realpathSync.native(root)
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (!create || error.code !== 'ENOENT') unsupported('private-state-directory-missing')
      try { fs.mkdirSync(current, { mode: 0o700 }) } catch { unsupported('private-state-create-failed') }
      stat = fs.lstatSync(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsupported('private-state-directory-unsafe')
    if (create) {
      try { fs.chmodSync(current, 0o700) } catch {}
    }
    const currentReal = fs.realpathSync.native(current)
    if (!isWithin(rootReal, currentReal)) unsupported('private-state-escape')
  }
  return current
}

function protectActivationRoot(activationRoot, recurse = false) {
  try {
    const established = safeRunRoot.ensureWindowsPrivateAcl(activationRoot)
    const audited = safeRunRoot.auditPrivatePermissions(activationRoot, {
      recurse,
      allowedOwnerReadableFiles: [path.join(activationRoot, 'installation_id')],
    })
    return {
      auditedPaths: audited.paths || 1,
      mechanism: audited.mechanism || established.mechanism,
    }
  } catch {
    unsupported('activation-private-permissions-unavailable')
  }
}

function auditActivationRoot(activationRoot, recurse = false) {
  try {
    return safeRunRoot.auditPrivatePermissions(activationRoot, {
      recurse,
      allowedOwnerReadableFiles: [path.join(activationRoot, 'installation_id')],
    })
  } catch (error) {
    unsupported('activation-private-permissions-invalid', {
      file: error && error.details && error.details.path || activationRoot,
      expected: JSON.stringify(error && error.details && error.details.expected || 'owner-only'),
      actual: JSON.stringify(error && error.details && error.details.actual || error && error.code || 'unknown'),
    })
  }
}

function targetIdentity(target) {
  const realpath = assertRealDirectory(target, 'target')
  const stat = fs.statSync(realpath, { bigint: true })
  return {
    path: path.resolve(target),
    realpath,
    device: String(stat.dev),
    inode: String(stat.ino),
  }
}

function managedHashIdentity(root, key) {
  if (typeof key !== 'string' || key.trim() === '' ||
      /[\u0000-\u001f\u007f]/.test(key) || /[\\/]$/.test(key)) {
    unsupported('managed-payload-hash-manifest-invalid')
  }
  const absolute = path.isAbsolute(key)
  if (!absolute && (/^(?:[A-Za-z]:|[\\/]{2})/.test(key) || key.includes(':'))) {
    unsupported('managed-payload-hash-manifest-invalid')
  }
  const rootLength = absolute ? path.parse(key).root.length : 0
  const tail = key.slice(rootLength)
  if (/[\\/]{2}/.test(tail) ||
      tail.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..') ||
      (absolute && tail.includes(':'))) {
    unsupported('managed-payload-hash-manifest-invalid')
  }
  const resolvedRoot = path.resolve(root)
  const resolved = absolute
    ? path.resolve(key)
    : path.resolve(resolvedRoot, key.split(/[\\/]/).join(path.sep))
  if (!isWithin(resolvedRoot, resolved)) {
    unsupported('managed-payload-hash-manifest-invalid')
  }
  return comparable(resolved)
}

function receiptFileUnderRoot(root, rootReal, declared) {
  if (typeof declared !== 'string' || !path.isAbsolute(declared) ||
      /[\u0000-\u001f\u007f]/.test(declared)) {
    unsupported('managed-payload-receipt-root-mismatch')
  }
  const resolvedRoot = path.resolve(root)
  const file = path.resolve(declared)
  if (!isWithin(resolvedRoot, file)) unsupported('managed-payload-receipt-root-mismatch')
  const parts = path.relative(resolvedRoot, file).split(path.sep).filter(Boolean)
  let current = resolvedRoot
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    let stat
    try { stat = fs.lstatSync(current) } catch {
      if (index + 1 === parts.length) unsupported('managed-payload-file-missing')
      unsupported('managed-payload-receipt-root-mismatch')
    }
    if (stat.isSymbolicLink()) unsupported('managed-payload-escape')
    if (index + 1 < parts.length && !stat.isDirectory()) {
      unsupported('managed-payload-receipt-root-mismatch')
    }
    if (index + 1 === parts.length && !stat.isFile()) {
      unsupported('managed-payload-file-not-regular')
    }
    let currentReal
    try { currentReal = fs.realpathSync.native(current) } catch {
      unsupported('managed-payload-receipt-root-mismatch')
    }
    if (!isWithin(rootReal, currentReal)) unsupported('managed-payload-escape')
  }
  return file
}

function lexicalPathIdentity(file) {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function captureManagedSource(root, rootReal, file, expected) {
  const resolved = receiptFileUnderRoot(root, rootReal, file)
  const stat = assertRegularUnlinked(resolved, 'managed-payload-file')
  const realpath = fs.realpathSync.native(resolved)
  if (!isWithin(rootReal, realpath)) unsupported('managed-payload-escape')
  const actual = sha256(readRegularBound(resolved, 'managed-payload-file'))
  if (!/^[a-f0-9]{64}$/.test(expected || '') || actual !== expected) {
    unsupported('managed-payload-drift', {
      file: path.relative(root, resolved).split(path.sep).join('/'),
      expected: /^[a-f0-9]{64}$/.test(expected || '') ? expected : 'missing',
      actual,
    })
  }
  return Object.freeze({
    device: String(stat.dev),
    file: resolved,
    inode: String(stat.ino),
    realpath,
    sha256: expected,
    size: String(stat.size),
  })
}

function managedCodexPayload(root) {
  const rootReal = assertRealDirectory(root, 'managed-install-root')
  const receiptPath = path.join(root, RECEIPT)
  const hashesPath = path.join(root, HASHES)
  assertRegularUnlinked(receiptPath, 'install-receipt')
  assertRegularUnlinked(hashesPath, 'hash-manifest')
  const receipt = readJson(receiptPath, 'install receipt')
  const hashes = readJson(hashesPath, 'hash manifest')
  if (!Array.isArray(receipt.files) || !hashes || typeof hashes !== 'object' || Array.isArray(hashes)) {
    unsupported('managed-payload-metadata-invalid')
  }
  const byIdentity = new Map()
  for (const key of Object.keys(hashes)) {
    const identity = managedHashIdentity(root, key)
    if (byIdentity.has(identity)) unsupported('managed-payload-hash-manifest-invalid')
    byIdentity.set(identity, hashes[key])
  }
  const receiptFiles = receipt.files.map(declared => receiptFileUnderRoot(root, rootReal, declared))
  const receiptOwned = new Set(receiptFiles.map(comparable))
  const runtimeManifestPath = path.join(
    PACKAGE_ROOT, 'agents', 'manifests', 'codex-runtime.json',
  )
  assertRegularUnlinked(runtimeManifestPath, 'codex-runtime-manifest')
  const runtimeManifestBytes = readRegularBound(runtimeManifestPath, 'codex-runtime-manifest')
  let runtimeManifest
  try { runtimeManifest = JSON.parse(runtimeManifestBytes.toString('utf8')) } catch {
    unsupported('codex-runtime-manifest-invalid')
  }
  if (runtimeManifest.provider !== 'codex' || !Array.isArray(runtimeManifest.files) ||
      !runtimeManifest.sha256 || !Array.isArray(runtimeManifest.externalDependencies) ||
      !/^[a-f0-9]{64}$/.test(runtimeManifest.payloadDigest || '') ||
      !/^codex-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$/.test(
        runtimeManifest.payloadGeneration || '',
      ) || !runtimeManifest.payloadGeneration.endsWith(runtimeManifest.payloadDigest.slice(0, 16))) {
    unsupported('codex-runtime-manifest-invalid')
  }
  const bundleRoot = path.join(
    root, PRIVATE_BUNDLE_DIRECTORY, runtimeManifest.payloadGeneration,
  )
  const bundleRootReal = assertRealDirectory(bundleRoot, 'managed-private-bundle-root')
  const skillRoot = path.join(bundleRoot, 'skills', 'autoprompt')
  const skillRootReal = assertRealDirectory(skillRoot, 'managed-private-skill-root')
  if (!isWithin(rootReal, bundleRootReal) || !isWithin(bundleRootReal, skillRootReal)) {
    unsupported('managed-private-bundle-escape')
  }
  const discoveryRoot = path.join(root, 'skills', 'autoprompt')
  const discoverySkill = path.join(root, DISCOVERY_SKILL_RELATIVE)
  const ambientOwned = receiptFiles.filter(file => isWithin(discoveryRoot, file))
  if (ambientOwned.length !== 1 || comparable(ambientOwned[0]) !== comparable(discoverySkill)) {
    unsupported('ambient-runtime-payload-exposed')
  }
  const discoveryExpected = byIdentity.get(comparable(discoverySkill))
  const discoveryBytes = readRegularBound(discoverySkill, 'managed-discovery-shim')
  const discoveryText = discoveryBytes.toString('utf8')
  if (!/^[a-f0-9]{64}$/.test(discoveryExpected || '') ||
      sha256(discoveryBytes) !== discoveryExpected) {
    unsupported('managed-payload-drift', {
      file: DISCOVERY_SKILL_RELATIVE.split(path.sep).join('/'),
      expected: /^[a-f0-9]{64}$/.test(discoveryExpected || '') ? discoveryExpected : 'missing',
      actual: sha256(discoveryBytes),
    })
  }
  if (!/^\s*activation:\s*explicit-only\s*$/mi.test(discoveryText) ||
      !/^\s*allow-implicit-invocation:\s*false\s*$/mi.test(discoveryText) ||
      !/autoprompt activate codex[^\r\n]*--\s*<mission>/i.test(discoveryText)) {
    unsupported('manual-entry-shim-policy-missing')
  }
  if (/\b(?:automatically|always)\s+(?:invoke|load|use|activate)\b|\b(?:use|invoke|load|activate)\s+(?:this\s+)?skill\s+(?:for|when(?:ever)?|on)\b/i.test(discoveryText)) {
    unsupported('manual-entry-generic-trigger-forbidden')
  }
  const files = []
  for (const file of receiptFiles) {
    if (!isWithin(skillRoot, file)) continue
    assertRegularUnlinked(file, 'managed-payload-file')
    const fileReal = fs.realpathSync.native(file)
    if (!isWithin(skillRootReal, fileReal)) unsupported('managed-payload-escape')
    const expected = byIdentity.get(comparable(file))
    const actual = sha256(fs.readFileSync(file))
    if (!/^[a-f0-9]{64}$/.test(expected || '') || actual !== expected) {
      unsupported('managed-payload-drift', {
        file: path.relative(skillRoot, file).split(path.sep).join('/'),
        expected: /^[a-f0-9]{64}$/.test(expected || '') ? expected : 'missing',
        actual,
      })
    }
    files.push({ file, relative: path.relative(skillRoot, file), sha256: expected })
  }
  const runtimeRoleProjection = validateRuntimeRoleProjection(runtimeManifest)
  const installedRuntime = new Map(files.map(entry => [
    entry.relative.split(path.sep).join('/'), entry,
  ]))
  const markerRelative = runtimeManifest.embeddedReceipt
  const marker = typeof markerRelative === 'string'
    ? installedRuntime.get(markerRelative)
    : null
  if (!marker) unsupported('managed-runtime-generation-marker-missing')
  const markerBytes = readRegularBound(marker.file, 'managed-runtime-generation-marker')
  let installedMarker
  try { installedMarker = JSON.parse(markerBytes.toString('utf8')) } catch {
    unsupported('managed-runtime-generation-mismatch')
  }
  if (installedMarker.provider !== runtimeManifest.provider ||
      installedMarker.payloadGeneration !== runtimeManifest.payloadGeneration ||
      installedMarker.payloadDigest !== runtimeManifest.payloadDigest ||
      sha256(markerBytes) !== marker.sha256 ||
      sha256(markerBytes) !== sha256(runtimeManifestBytes)) {
    unsupported('managed-runtime-generation-mismatch')
  }
  for (const relative of runtimeManifest.files) {
    const entry = installedRuntime.get(relative)
    if (!entry || runtimeManifest.sha256[relative] !== entry.sha256) {
      unsupported('managed-runtime-closure-incomplete', {
        file: relative,
        expected: runtimeManifest.sha256[relative] || 'missing',
        actual: entry?.sha256 || 'missing',
      })
    }
  }
  const externalFiles = []
  for (const dependency of runtimeManifest.externalDependencies) {
    if (!dependency || typeof dependency.destination !== 'string' ||
        !/^[a-f0-9]{64}$/.test(dependency.sha256 || '') ||
        path.isAbsolute(dependency.destination) || dependency.destination.includes('\\') ||
        dependency.destination.split('/').some(part => !part || part === '.' || part === '..')) {
      unsupported('codex-runtime-external-invalid')
    }
    const file = path.join(bundleRoot, ...dependency.destination.split('/'))
    if (!isWithin(bundleRoot, file) || !receiptOwned.has(comparable(file))) {
      unsupported('managed-runtime-external-unowned')
    }
    assertRegularUnlinked(file, 'managed-runtime-external')
    const expected = byIdentity.get(comparable(file))
    if (expected !== dependency.sha256 || sha256(fs.readFileSync(file)) !== expected) {
      unsupported('managed-runtime-external-drift')
    }
    externalFiles.push({ file, relative: dependency.destination, sha256: expected })
  }
  if (!files.some(entry => entry.relative === 'SKILL.md')) unsupported('manual-entry-missing')
  const metadata = files.find(entry => entry.relative === path.join('agents', 'openai.yaml'))
  if (!metadata || !/^\s*allow_implicit_invocation:\s*false\s*$/m.test(fs.readFileSync(metadata.file, 'utf8'))) {
    unsupported('manual-entry-policy-missing')
  }
  const profilePath = path.join(root, `${PROFILE_NAME}.config.toml`)
  assertRegularUnlinked(profilePath, 'private-profile')
  const profileExpected = byIdentity.get(comparable(profilePath))
  if (!/^[a-f0-9]{64}$/.test(profileExpected || '') ||
      sha256(fs.readFileSync(profilePath)) !== profileExpected) {
    unsupported('private-profile-drift')
  }
  const casting = files.find(entry => entry.relative ===
    path.join('agents-runtime', '.autoprompt-casting.json'))
  if (!casting) unsupported('managed-casting-manifest-missing')
  const castingRecord = readJson(casting.file, 'Codex casting manifest')
  const expectedCastingAgents = [...ROLE_TIER.keys()].map(role => `${role}.toml`).sort()
  if (castingRecord.schemaVersion !== 1 || castingRecord.provider !== 'codex' ||
      typeof castingRecord.selector !== 'string' ||
      typeof castingRecord.enabled !== 'boolean' || !Array.isArray(castingRecord.agents) ||
      castingRecord.agents.some(agent => typeof agent !== 'string') ||
      JSON.stringify([...castingRecord.agents].sort()) !== JSON.stringify(expectedCastingAgents) ||
      !Array.isArray(castingRecord.models) ||
      castingRecord.models.some(model => typeof model !== 'string' || !MODEL_PATTERN.test(model)) ||
      !castingDigest(castingRecord.agentDefinitionsHash) ||
      !castingDigest(castingRecord.castingHash) ||
      !(castingDigest(castingRecord.registryHash) ||
        castingRecord.registryHash === 'none')) {
    unsupported('managed-casting-manifest-invalid')
  }
  const modelMode = castingRecord.selector === 'off'
    ? 'provider-default'
    : /^auto(?::|$)/i.test(castingRecord.selector) ? 'auto' : 'explicit'
  let modelRegistry = null
  if (castingRecord.registryHash !== 'none') {
    if (typeof castingRecord.registryPath !== 'string' ||
        !path.isAbsolute(castingRecord.registryPath)) {
      unsupported('managed-model-registry-path-missing')
    }
    assertRegularUnlinked(castingRecord.registryPath, 'managed-model-registry')
    if (sha256(fs.readFileSync(castingRecord.registryPath)) !==
        castingDigest(castingRecord.registryHash)) {
      unsupported('managed-model-registry-drift')
    }
    modelRegistry = {
      path: path.resolve(castingRecord.registryPath),
      sha256: castingDigest(castingRecord.registryHash),
    }
  }
  const modelSelection = {
    schemaVersion: 1,
    mode: modelMode,
    selector: castingRecord.selector,
    models: [...castingRecord.models],
    effort: castingRecord.effort,
    castingHash: castingDigest(castingRecord.castingHash),
    agentDefinitionsHash: castingDigest(castingRecord.agentDefinitionsHash),
    registry: modelRegistry,
  }
  const validatedRoot = Object.freeze({ path: path.resolve(root), realpath: rootReal })
  const boundSources = [
    ...files,
    ...externalFiles,
    { file: profilePath, sha256: profileExpected },
  ]
  if (modelRegistry) boundSources.push({ file: modelRegistry.path, sha256: modelRegistry.sha256 })
  const sourceBindings = Object.create(null)
  for (const entry of boundSources) {
    const key = lexicalPathIdentity(entry.file)
    const bindingRoot = isWithin(validatedRoot.path, path.resolve(entry.file))
      ? validatedRoot
      : Object.freeze({
          path: path.dirname(path.resolve(entry.file)),
          realpath: assertRealDirectory(path.dirname(path.resolve(entry.file)), 'managed-source-root'),
        })
    const binding = captureManagedSource(
      bindingRoot.path, bindingRoot.realpath, entry.file, entry.sha256,
    )
    if (sourceBindings[key] && sourceBindings[key].sha256 !== binding.sha256) {
      unsupported('managed-payload-source-changed')
    }
    sourceBindings[key] = binding
  }
  return {
    bundleRoot,
    discoverySkill,
    externalFiles,
    files,
    modelSelection,
    payloadGeneration: runtimeManifest.payloadGeneration,
    roleProjection: runtimeRoleProjection,
    profilePath,
    skillRoot,
    sourceBindings: Object.freeze(sourceBindings),
    validatedRoot,
  }
}

function tomlString(value) {
  const escaped = String(value).replace(/[\u0000-\u001f\u007f"\\]/g, character => {
    const named = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' }
    return named[character] || `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  return `"${escaped}"`
}

function projectSkillFiles(target) {
  const files = []
  let current = path.resolve(target)
  while (true) {
    for (const relativeRoot of [path.join('.agents', 'skills'), path.join('.codex', 'skills')]) {
      const skillRoot = path.join(current, relativeRoot)
      let entries = []
      try { entries = fs.readdirSync(skillRoot, { withFileTypes: true }) } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue
        const skill = path.join(skillRoot, entry.name, 'SKILL.md')
        try {
          const stat = fs.lstatSync(skill)
          if (stat.isFile() && !stat.isSymbolicLink()) files.push(fs.realpathSync.native(skill))
        } catch {}
      }
    }
    if (fs.existsSync(path.join(current, '.git'))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return [...new Set(files)].sort()
}

function renderActivationConfig(skillPath, disabledSkills) {
  const lines = [
    '# Autoprompt v2 activation root. Ambient configuration is intentionally absent.',
    '[[skills.config]]',
    `path = ${tomlString(skillPath)}`,
    'enabled = true',
  ]
  for (const disabled of disabledSkills) {
    lines.push('', '[[skills.config]]', `path = ${tomlString(disabled)}`, 'enabled = false')
  }
  return `${lines.join('\n')}\n`
}

function versionedAgentName(agentFile, payloadGeneration) {
  return `${physicalProviderRole(path.basename(agentFile, '.toml'), payloadGeneration)}.toml`
}

function validateRuntimeRoleProjection(runtimeManifest) {
  if (runtimeManifest?.provider !== 'codex') unsupported('codex-runtime-role-projection-invalid')
  try {
    const projection = validateCodexRoleProjection(
      runtimeManifest,
      [...ROLE_TIER.keys()].sort(),
    )
    return Object.freeze({
      schemaVersion: projection.schemaVersion,
      payloadGeneration: projection.payloadGeneration,
      logicalToPhysicalProviderRole: Object.freeze({
        ...projection.logicalToPhysicalProviderRole,
      }),
    })
  } catch (error) {
    unsupported(error.message)
  }
}

function verifyRoleProjection(roleProjection, profilePath) {
  const aliases = roleProjection?.logicalToPhysicalProviderRole
  if (roleProjection?.schemaVersion !== 1 ||
      !/^codex-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$/.test(
        roleProjection?.payloadGeneration || '',
      ) || !aliases || typeof aliases !== 'object' || Array.isArray(aliases) ||
      Object.keys(aliases).length !== ROLE_TIER.size) {
    unsupported('private-role-projection-invalid')
  }
  const profile = readRegularBound(profilePath, 'activation-profile').toString('utf8')
  if (/^\[agents\.ap-[a-z0-9-]+\]$/m.test(profile)) {
    unsupported('private-role-projection-unversioned')
  }
  const declaredPhysicalRoles = [...profile.matchAll(/^\[agents\."([a-z0-9-]+)"\]$/gm)]
    .map(match => match[1])
  if (declaredPhysicalRoles.length !== ROLE_TIER.size ||
      new Set(declaredPhysicalRoles).size !== declaredPhysicalRoles.length) {
    unsupported('private-role-projection-inventory-mismatch')
  }
  for (const role of ROLE_TIER.keys()) {
    const physical = physicalProviderRole(role, roleProjection.payloadGeneration)
    if (aliases[role] !== physical || !declaredPhysicalRoles.includes(physical)) {
      unsupported('private-role-projection-generation-mismatch')
    }
    const section = profile.split(`[agents.${tomlString(physical)}]`)[1]
    if (section == null) unsupported('private-role-projection-profile-missing')
    const body = section.split(/^\[/m)[0]
    const configFile = /^config_file\s*=\s*"([^"\r\n]+)"$/m.exec(body)?.[1]
    if (!configFile || path.posix.basename(configFile.replaceAll('\\', '/')) !== `${physical}.toml`) {
      unsupported('private-role-projection-file-mismatch')
    }
    const agentPath = path.resolve(
      path.dirname(profilePath), ...configFile.replaceAll('\\', '/').split('/'),
    )
    const agentText = readRegularBound(agentPath, 'activation-physical-agent').toString('utf8')
    const names = [...agentText.matchAll(/^name\s*=\s*"([a-z0-9-]+)"\s*$/gm)]
    if (names.length !== 1 || names[0][1] !== physical) {
      unsupported('private-role-projection-name-mismatch')
    }
  }
  return roleProjection
}

function shellBoundaryEnvironment(environment) {
  const allowed = new Set([
    'APPDATA', 'CODEX_HOME', 'GCM_INTERACTIVE', 'GH_CONFIG_DIR', 'GH_PROMPT_DISABLED',
    'GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_SYSTEM', 'GIT_OPTIONAL_LOCKS', 'GIT_PROTOCOL_FROM_USER',
    'GIT_TERMINAL_PROMPT', 'HOME', 'LOCALAPPDATA', 'USERPROFILE', 'XDG_CONFIG_HOME',
  ])
  return Object.fromEntries(Object.entries(environment)
    .filter(([key]) => allowed.has(key) || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right)))
}

function renderSecurityProfile(environment, sandboxMode = 'workspace-write') {
  if (!['read-only', 'workspace-write'].includes(sandboxMode)) {
    unsupported('activation-sandbox-mode-invalid')
  }
  const setEntries = Object.entries(shellBoundaryEnvironment(environment))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
  const exclude = [
    '*AUTH*', '*COOKIE*', '*CREDENTIAL*', '*KEY*', '*PASSWORD*', '*PROXY*', '*SECRET*', '*TOKEN*',
    '*auth*', '*cookie*', '*credential*', '*key*', '*password*', '*proxy*', '*secret*', '*token*',
  ].map(tomlString).join(', ')
  return [
    '# Mechanically verified local-only Codex activation boundary.',
    `sandbox_mode = "${sandboxMode}"`,
    'web_search = "disabled"',
    '',
    ...(sandboxMode === 'workspace-write'
      ? ['[sandbox_workspace_write]', 'network_access = false', '']
      : []),
    '[shell_environment_policy]',
    'inherit = "core"',
    'ignore_default_excludes = false',
    `exclude = [${exclude}]`,
    `set = { ${setEntries.join(', ')} }`,
    '',
    '[features]',
    ...DISABLED_CODEX_FEATURES.map(feature => `${feature} = false`),
    '',
  ].join('\n')
}

function rewriteActivationProfile(profileBytes, activationSkillRoot, enforcementEnvironment, roleProjection) {
  let profile = profileBytes.toString('utf8')
  const replacements = []
  const payloadGeneration = roleProjection.payloadGeneration
  const logicalToPhysicalProviderRole = roleProjection.logicalToPhysicalProviderRole
  profile = profile.replace(/^\[agents\.(ap-[a-z0-9-]+)\]$/gm, (line, role) => {
    const physical = logicalToPhysicalProviderRole[role]
    if (!physical) unsupported('private-profile-role-projection-missing')
    return `[agents.${tomlString(physical)}]`
  })
  profile = profile.replace(/^(config_file\s*=\s*")(?:[^"\r\n]*\/)?(ap-[a-z0-9-]+\.toml)(")$/gm,
    (line, prefix, agent, suffix) => {
      const physicalRole = logicalToPhysicalProviderRole[path.basename(agent, '.toml')]
      if (!physicalRole) unsupported('private-profile-role-projection-missing')
      const physical = `${physicalRole}.toml`
      replacements.push({ agent, physical })
      return `${prefix}skills/autoprompt/agents-runtime/${physical}${suffix}`
    })
  if (!replacements.length) unsupported('private-profile-has-no-agents')
  const declared = new Set(replacements.map(entry => entry.agent))
  if (declared.size !== replacements.length) unsupported('private-profile-duplicate-agent')
  if (declared.size !== ROLE_TIER.size ||
      [...ROLE_TIER.keys()].some(role => !declared.has(`${role}.toml`) ||
        !logicalToPhysicalProviderRole[role])) {
    unsupported('private-profile-role-inventory-mismatch')
  }
  const expectedPhysical = new Set(
    [...ROLE_TIER.keys()].map(role => `${logicalToPhysicalProviderRole[role]}.toml`),
  )
  const declaredPhysical = new Set(replacements.map(entry => entry.physical))
  if (declaredPhysical.size !== expectedPhysical.size ||
      [...expectedPhysical].some(file => !declaredPhysical.has(file))) {
    unsupported('private-profile-physical-role-inventory-mismatch')
  }
  const profilePhysical = new Set(
    [...profile.matchAll(/^config_file\s*=\s*"([^"\r\n]+)"$/gm)]
      .map(match => path.posix.basename(match[1].replaceAll('\\', '/'))),
  )
  if (profilePhysical.size !== expectedPhysical.size ||
      [...expectedPhysical].some(file => !profilePhysical.has(file))) {
    unsupported('private-profile-config-file-inventory-mismatch')
  }
  for (const { agent, physical } of replacements) {
    const source = path.join(activationSkillRoot, 'agents-runtime', agent)
    const destination = path.join(activationSkillRoot, 'agents-runtime', physical)
    assertRegularUnlinked(source, 'private-agent')
    const logicalRole = path.basename(agent, '.toml')
    const physicalRole = path.basename(physical, '.toml')
    const projected = projectPhysicalAgentRoleConfig(
      readRegularBound(source, 'private-agent'), logicalRole, physicalRole,
    )
    writePrivateFile(destination, projected)
    fs.unlinkSync(source)
  }
  const landedPhysical = fs.readdirSync(path.join(activationSkillRoot, 'agents-runtime'))
    .filter(file => file.endsWith('.toml'))
  if (landedPhysical.length !== expectedPhysical.size ||
      new Set(landedPhysical).size !== landedPhysical.length ||
      landedPhysical.some(file => !expectedPhysical.has(file))) {
    unsupported('private-physical-role-inventory-mismatch')
  }
  return {
    bytes: Buffer.from(`${renderSecurityProfile(enforcementEnvironment)}${profile}`, 'utf8'),
    checkerBytes: Buffer.from(`${renderSecurityProfile(enforcementEnvironment, 'read-only')}${profile}`, 'utf8'),
    roleProjection: Object.freeze({
      schemaVersion: 1,
      payloadGeneration,
      logicalToPhysicalProviderRole: Object.freeze({ ...logicalToPhysicalProviderRole }),
    }),
  }
}

function projectPhysicalAgentRoleConfig(bytes, logicalRole, physicalRole) {
  if (!/^ap-[a-z0-9-]+$/.test(logicalRole || '') ||
      !/^autoprompt-codex-v[0-9]+-[0-9]+-[0-9]+-[a-f0-9]{16}-ap-[a-z0-9-]+$/.test(
        physicalRole || '',
      )) {
    unsupported('private-agent-role-name-invalid')
  }
  const text = Buffer.from(bytes).toString('utf8')
  const declarations = [...text.matchAll(/^name\s*=\s*"([a-z0-9-]+)"\s*$/gm)]
  if (declarations.length !== 1 || declarations[0][1] !== logicalRole) {
    unsupported('private-agent-role-name-mismatch')
  }
  const declaration = declarations[0]
  return Buffer.from(
    `${text.slice(0, declaration.index)}name = "${physicalRole}"${text.slice(
      declaration.index + declaration[0].length,
    )}`,
    'utf8',
  )
}

function refreshActivationSecurityProfile(profileBytes, enforcementEnvironment, sandboxMode = 'workspace-write') {
  const profile = profileBytes.toString('utf8')
  const marker = profile.indexOf('[agents]\n')
  if (marker < 0) unsupported('private-profile-agents-section-missing')
  return Buffer.from(`${renderSecurityProfile(enforcementEnvironment, sandboxMode)}${profile.slice(marker)}`, 'utf8')
}

function updateActivationPayloadHash(activationRoot, file) {
  const manifestPath = path.join(activationRoot, ACTIVATION_PAYLOAD_MANIFEST)
  const manifest = readJson(manifestPath, 'activation payload manifest')
  const relative = path.relative(activationRoot, file).split(path.sep).join('/')
  const entry = Array.isArray(manifest.files)
    ? manifest.files.find(candidate => candidate.path === relative)
    : null
  if (!entry) unsupported('activation-profile-receipt-missing')
  entry.sha256 = sha256(fs.readFileSync(file))
  writeJsonPrivate(manifestPath, manifest)
}

function createPrivateBoundary(activationRoot) {
  const gitConfig = path.join(activationRoot, GIT_EMPTY_CONFIG)
  if (fs.existsSync(gitConfig)) {
    const stat = assertRegularUnlinked(gitConfig, 'git-empty-config')
    if (stat.size !== 0n) unsupported('git-empty-config-not-empty')
  } else {
    writePrivateFile(gitConfig, Buffer.alloc(0))
  }
  const ghConfigDir = path.join(activationRoot, GH_CONFIG_DIRECTORY)
  ensurePrivateDirectory(activationRoot, ghConfigDir, true)
  if (fs.readdirSync(ghConfigDir).length !== 0) unsupported('github-cli-config-not-empty')
  const appData = ensurePrivateDirectory(activationRoot, path.join(activationRoot, 'appdata'), true)
  const localAppData = ensurePrivateDirectory(
    activationRoot, path.join(activationRoot, 'local-appdata'), true,
  )
  const xdgConfigHome = ensurePrivateDirectory(
    activationRoot, path.join(activationRoot, 'xdg-config'), true,
  )
  return { appData, ghConfigDir, gitConfig, localAppData, xdgConfigHome }
}

function rewriteSupervisorEntrypoints(skillRoot) {
  const shell = path.join(skillRoot, 'workflow', 'supervisor.sh')
  const powershell = path.join(skillRoot, 'workflow', 'supervisor.ps1')
  if (fs.existsSync(shell)) {
    let text = fs.readFileSync(shell, 'utf8')
    const currentAdapter = text.includes('AUTOPROMPT_ENTRY_PROMPT="\\$autoprompt"') &&
      text.includes('exec node "$RUNTIME" --supervisor "$@"')
    if (currentAdapter) {
      text = text.replace("AUTOPROMPT_RESUME_PROMPT='\\$autoprompt resume '",
        "AUTOPROMPT_RESUME_PROMPT='$autoprompt resume '")
    } else {
      const marker = '      if [ -n "$LAUNCH_CMD" ]; then\n'
      if (!text.includes(marker)) unsupported('supervisor-shell-shape-unsupported')
      text = text.replace(marker,
        '      if launch_resume_enabled; then\n' +
        '        AUTOPROMPT_ENTRY_PROMPT="\\$autoprompt resume ${AUTOPROMPT_ACTIVATION_ID:?}"$\'\\n\'"AUTOPROMPT_REQUEST_ENVELOPE_V2 record=${AUTOPROMPT_ACTIVATION_RECORD:?}"$\'\\n\'"$MISSION"\n' +
        '      else\n' +
        '        AUTOPROMPT_ENTRY_PROMPT="\\$autoprompt"$\'\\n\'"AUTOPROMPT_REQUEST_ENVELOPE_V2 record=${AUTOPROMPT_ACTIVATION_RECORD:?}"$\'\\n\'"$MISSION"\n' +
        '      fi\n' + marker)
      text = text.replace('$LAUNCH_CMD --profile "$CODEX_PROFILE_NAME" "$MISSION"',
        '$LAUNCH_CMD --profile "$CODEX_PROFILE_NAME" "$AUTOPROMPT_ENTRY_PROMPT"')
      text = text.replace('"$LAUNCHER" --profile "$CODEX_PROFILE_NAME" "$MISSION"',
        '"$LAUNCHER" --profile "$CODEX_PROFILE_NAME" "$AUTOPROMPT_ENTRY_PROMPT"')
    }
    writePrivateFile(shell, Buffer.from(text, 'utf8'), 0o700)
  }
  if (fs.existsSync(powershell)) {
    let text = fs.readFileSync(powershell, 'utf8')
    const currentAdapter = text.includes("$env:AUTOPROMPT_ENTRY_PROMPT = '$autoprompt'") &&
      text.includes("@($runtime, '--supervisor')")
    if (!currentAdapter) {
      const newline = text.includes('\r\n') ? '\r\n' : '\n'
      const marker = [
        '        try {',
        '            if (-not [string]::IsNullOrEmpty($launchCmd)) {',
      ].join(newline)
      if (!text.includes(marker)) unsupported('supervisor-powershell-shape-unsupported')
      const entry = [
        '        $entryPrefix = if (Test-LaunchResume -Index $idx) {',
        "            '$autoprompt resume ' + $env:AUTOPROMPT_ACTIVATION_ID",
        "        } else { '$autoprompt' }",
        "        $entryPrompt = $entryPrefix + \"`nAUTOPROMPT_REQUEST_ENVELOPE_V2 record=$env:AUTOPROMPT_ACTIVATION_RECORD`n\" + $mission",
        ''].join(newline)
      text = text.replace(marker, entry + marker)
      text = text.replace("@($rest + @('--profile', $codexProfileName, $mission))",
        "@($rest + @('--profile', $codexProfileName, $entryPrompt))")
      text = text.replace("@('--profile', $codexProfileName, $mission)",
        "@('--profile', $codexProfileName, $entryPrompt)")
    }
    writePrivateFile(powershell, Buffer.from(text, 'utf8'), 0o600)
  }
}

function probeCodexLauncher(options) {
  const executable = options.codexRuntime?.executable || 'codex'
  const result = (options.spawnSync || childProcess.spawnSync)(executable, ['--help'], {
    cwd: options.target, env: options.env, encoding: 'utf8', shell: false,
  })
  if (result.error && result.error.code === 'ENOENT') unsupported('codex-cli-missing')
  if (!result || result.status !== 0) unsupported('codex-cli-probe-failed')
  const help = String(result.stdout || '')
  for (const flag of ['--profile', '--strict-config', '--cd']) {
    if (!help.includes(flag)) unsupported(`codex-cli-missing-${flag.slice(2)}`)
  }
  return help
}

function localOnlyChildEnvironment(target, baseEnvironment, boundary) {
  const options = {
    configIsolationPath: boundary.gitConfig,
    ghConfigDir: boundary.ghConfigDir,
  }
  try {
    return createSafeChildGitEnvironment(target, baseEnvironment, options)
  } catch {
    unsupported('local-only-child-boundary-unavailable')
  }
}

function activationChildEnvironment(baseEnvironment, activationRoot, target, boundary, pointers = {}) {
  const candidate = {
    ...baseEnvironment,
    APPDATA: boundary.appData,
    CODEX_HOME: activationRoot,
    GH_CONFIG_DIR: boundary.ghConfigDir,
    GH_PROMPT_DISABLED: '1',
    HOME: activationRoot,
    LOCALAPPDATA: boundary.localAppData,
    USERPROFILE: activationRoot,
    XDG_CONFIG_HOME: boundary.xdgConfigHome,
    ...pointers,
  }
  return localOnlyChildEnvironment(target.realpath, candidate, boundary)
}

function enforcementProof(profilePath, profileSha256, checkerProfilePath, checkerProfileSha256) {
  return {
    schemaVersion: 1,
    provider: 'codex',
    profilePath,
    profileSha256,
    checkerProfilePath,
    checkerProfileSha256,
    checkerSelectedProfile: CHECKER_PROFILE_NAME,
    selectedProfile: PROFILE_NAME,
    strictConfig: true,
  }
}

function waitForProbeFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true
    Atomics.wait(sleeper, 0, 0, 20)
  }
  return fs.existsSync(file)
}

function waitForProbeToken(file, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < deadline) {
    try {
      if (readRegularBound(file, 'codex-network-probe-evidence')
        .toString('utf8').split(/\r?\n/).includes(token)) return true
    } catch (error) {
      if (!(error instanceof ProviderUnsupportedError) ||
          !error.message.endsWith('reason=codex-network-probe-evidence-missing')) throw error
    }
    Atomics.wait(sleeper, 0, 0, 20)
  }
  try {
    return readRegularBound(file, 'codex-network-probe-evidence')
      .toString('utf8').split(/\r?\n/).includes(token)
  } catch (error) {
    if (error instanceof ProviderUnsupportedError &&
        error.message.endsWith('reason=codex-network-probe-evidence-missing')) return false
    throw error
  }
}

function controlledNetworkProbeAddress() {
  const candidates = Object.values(os.networkInterfaces())
    .flatMap(entries => entries || [])
    .filter(entry => (entry.family === 'IPv4' || entry.family === 4) &&
      entry.internal !== true && typeof entry.address === 'string' &&
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(entry.address))
    .map(entry => entry.address)
  const unique = [...new Set(candidates)]
  if (!unique.length) unsupported('codex-network-probe-host-interface-unavailable')
  const privateAddress = unique.find(address => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address))
  return privateAddress || unique[0]
}

function unlinkProbeFile(file) {
  if (!fs.existsSync(file)) return
  assertRegularUnlinked(file, 'codex-network-probe-artifact')
  fs.unlinkSync(file)
}

function probeCodexCommandNetwork(options, spawn) {
  const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  const root = options.env.CODEX_HOME
  const address = controlledNetworkProbeAddress()
  const baselineToken = crypto.randomBytes(16).toString('hex')
  const sandboxToken = crypto.randomBytes(16).toString('hex')
  const readyPath = path.join(root, `.network-probe-ready-${nonce}`)
  const evidencePath = path.join(root, `.network-probe-connected-${nonce}`)
  const stopPath = path.join(root, `.network-probe-stop-${nonce}`)
  const closedPath = path.join(root, `.network-probe-closed-${nonce}`)
  const baselineResultPath = path.join(options.target, `.autoprompt-network-baseline-${nonce}`)
  const sandboxResultPath = path.join(options.target, `.autoprompt-network-sandbox-${nonce}`)
  const listenerScript = [
    'const fs=require("node:fs"),net=require("node:net")',
    'const [ready,evidence,stop,closed,address]=process.argv.slice(1)',
    'const server=net.createServer(socket=>{',
    '  let token="";socket.setEncoding("utf8")',
    '  socket.on("data",chunk=>{if(token.length<128)token+=chunk})',
    '  socket.on("end",()=>{',
    '    if(/^[a-f0-9]{32}$/.test(token)){try{fs.appendFileSync(evidence,token+"\\n",{mode:0o600})}catch{}}',
    '    socket.destroy()',
    '  })',
    '})',
    'let stopping=false',
    'function finish(){if(stopping)return;stopping=true;server.close(()=>{',
    '  try{fs.writeFileSync(closed,"closed",{flag:"wx",mode:0o600})}catch{}',
    '  process.exit(0)',
    '})}',
    'server.listen(0,address,()=>{',
    '  fs.writeFileSync(ready,JSON.stringify({address,port:server.address().port}),{flag:"wx",mode:0o600})',
    '})',
    'const timer=setInterval(()=>{if(fs.existsSync(stop)){clearInterval(timer);finish()}},20)',
    'setTimeout(finish,12000)',
  ].join(';')
  const listenerEnvironment = Object.fromEntries(
    ['ComSpec', 'SystemRoot', 'WINDIR'].filter(key => process.env[key])
      .map(key => [key, process.env[key]]),
  )
  const listener = childProcess.spawn(process.execPath, [
    '-e', listenerScript, readyPath, evidencePath, stopPath, closedPath, address,
  ], {
    cwd: options.target,
    env: listenerEnvironment,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  })
  let cleanShutdown = false
  try {
    if (!waitForProbeFile(readyPath, 5_000)) unsupported('codex-network-probe-listener-failed')
    let endpoint
    try {
      endpoint = JSON.parse(readRegularBound(readyPath, 'codex-network-probe-ready').toString('utf8'))
    } catch {
      unsupported('codex-network-probe-listener-invalid')
    }
    if (!endpoint || endpoint.address !== address || !Number.isSafeInteger(endpoint.port) ||
        endpoint.port < 1 || endpoint.port > 65535) unsupported('codex-network-probe-listener-invalid')
    const clientScript = [
      'const fs=require("node:fs"),net=require("node:net")',
      'const [port,address,token,result]=process.argv.slice(1)',
      'let finished=false',
      'function finish(value,status,output=""){',
      '  if(finished)return;finished=true',
      '  try{fs.writeFileSync(result,value,{flag:"wx",mode:0o600})}catch{process.exit(6)}',
      '  if(output)process.stdout.write(output)',
      '  process.exit(status)',
      '}',
      'const socket=net.connect(Number(port),address)',
      'socket.once("connect",()=>{',
      '  socket.end(token,()=>finish("OPEN",9,"AUTOPROMPT_NETWORK_OPEN"))',
      '})',
      'socket.once("error",error=>{',
      '  if(error.code==="EACCES"||error.code==="EPERM"){',
      '    finish("DENIED",0,"AUTOPROMPT_NETWORK_DENIED")',
      '  }',
      '  finish(`ERROR:${String(error.code||error.message)}`,8)',
      '})',
      'setTimeout(()=>finish("TIMEOUT",7),3000)',
    ].join(';')
    const baseline = spawn(process.execPath, [
      '-e', clientScript, String(endpoint.port), address, baselineToken, baselineResultPath,
    ], {
      cwd: options.target,
      env: options.env,
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
    })
    const baselineOutput = `${baseline?.stdout || ''}\n${baseline?.stderr || ''}`
    let baselineResult = null
    try { baselineResult = readRegularBound(baselineResultPath, 'codex-network-baseline-result').toString('utf8') } catch {}
    if (!baseline || baseline.error || baseline.status !== 9 ||
        baselineResult !== 'OPEN' ||
        !waitForProbeToken(evidencePath, baselineToken, 2_000)) {
      unsupported('codex-network-probe-positive-control-failed')
    }
    const result = spawn(options.codexRuntime?.executable || 'codex', [
      'sandbox',
      '--permission-profile', ':workspace',
      '--sandbox-state-disable-network',
      '--profile', PROFILE_NAME,
      '--cd', options.target,
      process.execPath, '-e', clientScript, String(endpoint.port), address, sandboxToken,
      sandboxResultPath,
    ], {
      cwd: options.target,
      env: options.env,
      encoding: 'utf8',
      shell: false,
      timeout: 15_000,
    })
    const output = `${result?.stdout || ''}\n${result?.stderr || ''}`
    let sandboxResult = null
    try { sandboxResult = readRegularBound(sandboxResultPath, 'codex-network-sandbox-result').toString('utf8') } catch {}
    if (waitForProbeToken(evidencePath, sandboxToken, 250) || result?.status === 9 ||
        sandboxResult === 'OPEN' || output.includes('AUTOPROMPT_NETWORK_OPEN')) {
      unsupported('codex-command-sandbox-network-open')
    }
    if (!result || result.error || result.status !== 0 ||
        sandboxResult !== 'DENIED') {
      unsupported('codex-command-sandbox-network-unproven')
    }
    return sha256(Buffer.from(`${output}\nresult=${sandboxResult}`, 'utf8'))
  } finally {
    try {
      if (!fs.existsSync(stopPath)) writePrivateFile(stopPath, Buffer.from('stop', 'utf8'))
      cleanShutdown = waitForProbeFile(closedPath, 2_000)
    } catch {}
    if (!cleanShutdown) {
      try { listener.kill() } catch {}
    }
    for (const file of [
      readyPath, evidencePath, stopPath, closedPath, baselineResultPath, sandboxResultPath,
    ]) {
      try { unlinkProbeFile(file) } catch {}
    }
    if (!cleanShutdown) unsupported('codex-network-probe-residue')
  }
}

function probeCodexProfile(options) {
  const spawn = options.spawnSync || childProcess.spawnSync
  const missingSchema = path.join(
    options.env.CODEX_HOME,
    `.strict-config-probe-${process.pid}-${crypto.randomBytes(8).toString('hex')}.schema.json`,
  )
  if (fs.existsSync(missingSchema)) unsupported('codex-strict-profile-probe-collision')
  const executable = options.codexRuntime?.executable || 'codex'
  const validation = spawn(executable, [
    'exec', '--strict-config', '--profile', PROFILE_NAME, '--cd', options.target,
    '--skip-git-repo-check', '--output-schema', missingSchema,
    'AUTOPROMPT_CONFIG_PROBE_MUST_NOT_RUN',
  ], {
    cwd: options.target,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
  })
  const validationOutput = `${validation?.stdout || ''}\n${validation?.stderr || ''}`
  if (!validation || validation.error || validation.status !== 1 ||
      !/Failed to read output schema file/i.test(validationOutput) ||
      /Error loading config|unknown configuration field/i.test(validationOutput)) {
    unsupported('codex-strict-profile-rejected')
  }
  const sandboxNonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  const sandboxMarker = path.join(options.target, `.autoprompt-command-probe-${sandboxNonce}`)
  const sandboxToken = crypto.randomBytes(16).toString('hex')
  const sandbox = spawn(executable, [
    'sandbox',
    '--permission-profile', ':workspace',
    '--sandbox-state-disable-network',
    '--profile', PROFILE_NAME,
    '--cd', options.target,
    process.execPath, '-e',
    'require("node:fs").writeFileSync(process.argv[1],process.argv[2],{flag:"wx",mode:0o600})',
    sandboxMarker, sandboxToken,
  ], {
    cwd: options.target,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
  })
  let sandboxMarkerValue = null
  try { sandboxMarkerValue = readRegularBound(sandboxMarker, 'codex-command-sandbox-marker').toString('utf8') } catch {}
  try {
    if (!sandbox || sandbox.error || sandbox.status !== 0 || sandboxMarkerValue !== sandboxToken) {
      unsupported('codex-command-sandbox-unavailable')
    }
  } finally {
    try { unlinkProbeFile(sandboxMarker) } catch {}
  }
  const networkProbeOutputSha256 = probeCodexCommandNetwork(options, spawn)
  return {
    networkProbeOutputSha256,
    strictProfileOutputSha256: sha256(Buffer.from(validationOutput, 'utf8')),
    sandboxOutputSha256: sha256(Buffer.from(
      `${sandbox.stdout || ''}\n${sandbox.stderr || ''}`, 'utf8',
    )),
  }
}

function proveLocalOnlySafety(target, environment, proof, spawnSync = childProcess.spawnSync) {
  let repository
  try {
    repository = discoverRepository(target)
  } catch {
    unsupported('local-only-git-repository-required')
  }
  const branch = spawnSync('git', [
    '-C', repository.worktreeRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD',
  ], {
    cwd: repository.worktreeRoot,
    env: environment,
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
  })
  const expectedBranch = String(branch?.stdout || '').trim()
  const namedBranch = branch && !branch.error && branch.status === 0 && expectedBranch !== ''
  const detachedHead = branch && !branch.error && branch.status === 1 && expectedBranch === ''
  if (!namedBranch && !detachedHead) {
    unsupported('local-only-expected-branch-unavailable')
  }
  let inspection
  try {
    inspection = inspect(repository, expectedBranch, environment, { enforcementProof: proof })
  } catch {
    unsupported('local-only-safety-inspection-failed')
  }
  if (!inspection.mechanicallyEnforced || Object.keys(inspection.channels || {}).length !== 5) {
    const code = inspection.residuals?.[0]?.code || 'MECHANICAL_ENFORCEMENT_UNPROVEN'
    unsupported(`local-only-safety-${String(code).toLowerCase().replace(/_/g, '-')}`)
  }
  return inspection
}

function verifyExplicitModelAssignments(activationRoot, profilePath, modelSelection) {
  if (modelSelection.mode === 'provider-default') return false
  if (!modelSelection.models.length) unsupported('explicit-model-selection-empty')
  const profile = fs.readFileSync(profilePath, 'utf8')
  const paths = [...profile.matchAll(/^config_file\s*=\s*"((?:\\.|[^"\\])*)"$/gm)]
    .map(match => match[1].replace(/\\([\\"])/g, '$1'))
  if (paths.length !== ROLE_TIER.size || new Set(paths).size !== paths.length) {
    unsupported('explicit-model-profile-incomplete')
  }
  for (const relative of paths) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) {
      unsupported('explicit-model-profile-path-invalid')
    }
    const file = path.resolve(activationRoot, relative)
    if (!isWithin(activationRoot, file)) unsupported('explicit-model-profile-path-invalid')
    const text = readRegularBound(file, 'explicit-model-agent').toString('utf8')
    const model = text.match(/^model\s*=\s*"([^"\r\n]+)"$/m)?.[1]
    const effort = text.match(/^model_reasoning_effort\s*=\s*"([^"\r\n]+)"$/m)?.[1]
    if (!modelSelection.models.includes(model) ||
        !['xhigh', 'high', 'medium', 'low'].includes(effort)) {
      unsupported('explicit-model-assignment-invalid')
    }
  }
  return true
}

function copyActivationPayload(root, activationRoot, payload, enforcementEnvironment) {
  const verifiedSourceBytes = (source, expectedSha256 = null) => {
    const binding = payload.sourceBindings?.[lexicalPathIdentity(source)]
    if (!binding || (expectedSha256 && binding.sha256 !== expectedSha256)) {
      unsupported('managed-payload-source-changed')
    }
    const insideManagedRoot = isWithin(payload.validatedRoot.path, path.resolve(source))
    const sourceRoot = insideManagedRoot
      ? payload.validatedRoot
      : { path: path.dirname(binding.file), realpath: path.dirname(binding.realpath) }
    const assertUnchanged = () => {
      const resolved = receiptFileUnderRoot(sourceRoot.path, sourceRoot.realpath, source)
      const stat = assertRegularUnlinked(resolved, 'managed-payload-source')
      const realpath = fs.realpathSync.native(resolved)
      if (lexicalPathIdentity(resolved) !== lexicalPathIdentity(binding.file) ||
          lexicalPathIdentity(realpath) !== lexicalPathIdentity(binding.realpath) ||
          String(stat.dev) !== binding.device || String(stat.ino) !== binding.inode ||
          String(stat.size) !== binding.size) {
        unsupported('managed-payload-source-changed')
      }
      return resolved
    }
    try {
      const resolved = assertUnchanged()
      const bytes = readRegularBound(resolved, 'managed-payload-source')
      if (sha256(bytes) !== binding.sha256) unsupported('managed-payload-source-changed')
      assertUnchanged()
      return { assertUnchanged, bytes }
    } catch (error) {
      if (error instanceof ProviderUnsupportedError &&
          error.reason === 'managed-payload-source-changed') throw error
      unsupported('managed-payload-source-changed')
    }
  }
  const bindDestinationAncestors = destination => {
    const resolvedRoot = path.resolve(activationRoot)
    const rootReal = assertRealDirectory(resolvedRoot, 'activation-payload-root')
    const parent = path.dirname(path.resolve(destination))
    if (!isWithin(resolvedRoot, parent)) unsupported('activation-payload-escape')
    const bindings = []
    let current = resolvedRoot
    for (const part of path.relative(resolvedRoot, parent).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      const binding = directoryBinding(current, 'private-write-parent')
      if (!isWithin(rootReal, binding.realpath)) unsupported('activation-payload-escape')
      bindings.push(Object.freeze({ path: current, ...binding }))
    }
    return Object.freeze({ bindings: Object.freeze(bindings), rootReal })
  }
  const assertDestinationAncestors = ancestry => {
    try {
      for (const binding of ancestry.bindings) {
        assertDirectoryBinding(binding.path, binding, 'private-write-parent')
        if (!isWithin(ancestry.rootReal, fs.realpathSync.native(binding.path))) {
          unsupported('activation-payload-escape')
        }
      }
    } catch (error) {
      if (error instanceof ProviderUnsupportedError &&
          error.reason === 'activation-payload-escape') throw error
      unsupported('private-write-parent-raced')
    }
  }
  const publishVerifiedCopy = (source, destination, expectedSha256) => {
    const captured = verifiedSourceBytes(source, expectedSha256)
    ensurePrivateDirectory(activationRoot, path.dirname(destination), true)
    const ancestry = bindDestinationAncestors(destination)
    const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    let temporaryIdentity = null
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600)
      try {
        fs.writeFileSync(descriptor, captured.bytes)
        fs.fsyncSync(descriptor)
        temporaryIdentity = fs.fstatSync(descriptor, { bigint: true })
      } finally {
        fs.closeSync(descriptor)
      }
      if (sha256(readRegularBound(temporary, 'activation-payload-temp')) !== expectedSha256) {
        unsupported('managed-payload-source-changed')
      }
      captured.assertUnchanged()
      assertDestinationAncestors(ancestry)
      try { fs.renameSync(temporary, destination) } catch {
        unsupported('private-write-parent-raced')
      }
      assertDestinationAncestors(ancestry)
      const landed = assertRegularUnlinked(destination, 'activation-payload-copy')
      if (!temporaryIdentity || !sameFileIdentity(landed, temporaryIdentity) ||
          sha256(readRegularBound(destination, 'activation-payload-copy')) !== expectedSha256) {
        unsupported('managed-payload-source-changed')
      }
    } finally {
      try {
        assertDestinationAncestors(ancestry)
        const remaining = fs.lstatSync(temporary, { bigint: true })
        if (temporaryIdentity && sameFileIdentity(remaining, temporaryIdentity) &&
            remaining.isFile() && !remaining.isSymbolicLink()) fs.unlinkSync(temporary)
      } catch {}
    }
  }
  const activationSkillRoot = path.join(activationRoot, 'skills', 'autoprompt')
  for (const entry of payload.files) {
    const destination = path.join(activationSkillRoot, entry.relative)
    if (!isWithin(activationSkillRoot, destination)) unsupported('activation-payload-escape')
    publishVerifiedCopy(entry.file, destination, entry.sha256)
  }
  const externalInventory = []
  for (const entry of payload.externalFiles) {
    const destination = path.join(activationRoot, ...entry.relative.split('/'))
    if (!isWithin(activationRoot, destination) || destination === activationRoot) {
      unsupported('activation-external-payload-escape')
    }
    ensurePrivateDirectory(activationRoot, path.dirname(destination), true)
    publishVerifiedCopy(entry.file, destination, entry.sha256)
    externalInventory.push(destination)
  }
  const modelSelection = JSON.parse(JSON.stringify(payload.modelSelection))
  if (modelSelection.registry) {
    const destination = path.join(activationRoot, 'model-registry.json')
    publishVerifiedCopy(
      modelSelection.registry.path, destination, modelSelection.registry.sha256,
    )
    modelSelection.registry.path = destination
    externalInventory.push(destination)
  }
  const profileBytes = verifiedSourceBytes(payload.profilePath).bytes
  const rewrittenProfile = rewriteActivationProfile(
    profileBytes, activationSkillRoot, enforcementEnvironment,
    payload.roleProjection,
  )
  const profilePath = path.join(activationRoot, `${PROFILE_NAME}.config.toml`)
  const checkerProfilePath = path.join(activationRoot, `${CHECKER_PROFILE_NAME}.config.toml`)
  writePrivateFile(profilePath, rewrittenProfile.bytes)
  writePrivateFile(checkerProfilePath, rewrittenProfile.checkerBytes)
  rewriteSupervisorEntrypoints(activationSkillRoot)
  const inventory = [...externalInventory]
  const pending = [activationSkillRoot]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) unsupported('activation-payload-symlink')
      if (stat.isDirectory()) pending.push(candidate)
      else if (stat.isFile()) inventory.push(candidate)
      else unsupported('activation-payload-special-file')
    }
  }
  inventory.push(profilePath, checkerProfilePath)
  writeJsonPrivate(path.join(activationRoot, ACTIVATION_PAYLOAD_MANIFEST), {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    files: inventory.sort().map(file => ({
      path: path.relative(activationRoot, file).split(path.sep).join('/'),
      sha256: sha256(fs.readFileSync(file)),
    })),
  })
  return {
    activationSkillRoot,
    modelSelection,
    payloadGeneration: payload.payloadGeneration,
    profilePath,
    profileSha256: sha256(rewrittenProfile.bytes),
    checkerProfilePath,
    checkerProfileSha256: sha256(rewrittenProfile.checkerBytes),
    roleProjection: rewrittenProfile.roleProjection,
  }
}

function verifyActivationPayload(activationRoot) {
  const manifestPath = path.join(activationRoot, ACTIVATION_PAYLOAD_MANIFEST)
  assertRegularUnlinked(manifestPath, 'activation-payload-manifest')
  const manifest = readJson(manifestPath, 'activation payload manifest')
  if (manifest.schemaVersion !== ACTIVATION_SCHEMA_VERSION || !Array.isArray(manifest.files) ||
      manifest.files.length === 0) fail('activation payload manifest is invalid')
  const seen = new Set()
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') ||
        path.isAbsolute(entry.path) || entry.path.includes('\\') ||
        entry.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(entry.path)) {
      fail('activation payload manifest is invalid')
    }
    seen.add(entry.path)
    const file = path.join(activationRoot, ...entry.path.split('/'))
    assertRegularUnlinked(file, 'activation-payload-file')
    if (sha256(fs.readFileSync(file)) !== entry.sha256) fail('activation payload has drift')
  }
}

function normalizeRequest(options) {
  let argv
  if (Array.isArray(options.missionArgs)) argv = [...options.missionArgs]
  else if (Object.prototype.hasOwnProperty.call(options, 'mission')) argv = [String(options.mission)]
  else argv = []
  if (argv.length === 0 || argv.some(argument => typeof argument !== 'string')) {
    fail('activation requires at least one exact mission argv')
  }
  const canonical = Buffer.from(JSON.stringify({ schemaVersion: 1, argv }), 'utf8')
  return {
    argv,
    bytes: canonical.length,
    canonicalBase64: canonical.toString('base64'),
    canonicalJson: canonical.toString('utf8'),
    encoding: 'utf8-json',
    sha256: sha256(canonical),
  }
}

function activationEnvelope(record, resumeActivationId = null) {
  const entry = resumeActivationId === null
    ? '$autoprompt'
    : `$autoprompt resume ${resumeActivationId}`
  return [
    entry,
    'AUTOPROMPT_REQUEST_ENVELOPE_V2',
    `activation_id=${record.activationId}`,
    `capability_record=${record.capability.recordPath}`,
    `request_sha256=${record.request.sha256}`,
    `request_bytes=${record.request.bytes}`,
    `request_base64=${record.request.canonicalBase64}`,
    `request_argv_json=${JSON.stringify(record.request.argv)}`,
    `target_realpath=${record.target.realpath}`,
    `parent_session=${record.capability.parentSession}`,
    `parent_role=${record.capability.parentRole}`,
    `legal_child=${record.capability.legalChildren.join(',')}`,
    `generation=${record.capability.generation}`,
    `expires_at=${record.capability.expiresAt}`,
    'REQUEST_ARGV_BEGIN',
    record.request.canonicalJson,
    'REQUEST_ARGV_END',
  ].join('\n')
}

function providerCapabilityBytes(record) {
  return Buffer.from(JSON.stringify(record.providerCapabilities), 'utf8')
}

function providerRuntimeIdentity(record) {
  const boundary = record.activationBoundary
  return sha256(Buffer.from(JSON.stringify({
    activationId: record.activationId,
    capabilityGeneration: record.capability.generation,
    requestSha256: record.request.sha256,
    targetIdentity: record.target,
    configSha256: boundary.configSha256,
    payloadManifestSha256: boundary.payloadManifestSha256,
    profileSha256: boundary.enforcementProof.profileSha256,
    privatePermissions: boundary.privatePermissions,
    sandboxIdentity: boundary.sandboxIdentity,
    modelSelectionSha256: sha256(Buffer.from(JSON.stringify(record.modelSelection), 'utf8')),
    roleProjectionSha256: sha256(Buffer.from(JSON.stringify(record.roleProjection), 'utf8')),
    providerProbeSha256: sha256(Buffer.from(JSON.stringify(record.providerProbe), 'utf8')),
    providerCapabilitiesSha256: sha256(providerCapabilityBytes(record)),
    canonicalProviderTrustSha256: record.providerTrust?.sha256 || null,
    codexExecutableAdmissionSha256: boundary.codexExecutable
      ? sha256(Buffer.from(JSON.stringify(boundary.codexExecutable), 'utf8'))
      : null,
    safetyInspectionSha256: sha256(Buffer.from(JSON.stringify(record.safety), 'utf8')),
    supervisorAdapterSha256: boundary.supervisorAdapterSha256,
  }), 'utf8'))
}

function providerAttestationPayload(attestation) {
  return Buffer.from(JSON.stringify({
    schemaVersion: attestation.schemaVersion,
    attestationId: attestation.attestationId,
    providerId: attestation.providerId,
    issuer: attestation.issuer,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
    runtimeIdentityHash: attestation.runtimeIdentityHash,
    activationNonce: attestation.activationNonce,
    verificationMethod: attestation.verificationMethod,
    verifiedCapabilities: attestation.verifiedCapabilities,
    canonicalProviderTrustSha256: attestation.canonicalProviderTrustSha256,
    result: attestation.result,
  }), 'utf8')
}

function validateBoundProviderTrust(record, currentRuntimeIdentity) {
  const providerTrust = record?.providerTrust
  if (!providerTrust || !/^[a-f0-9]{64}$/.test(providerTrust.sha256 || '') ||
      !currentRuntimeIdentity ||
      providerTrust.runtimeIdentityHash !== currentRuntimeIdentity.runtimeIdentityHash) {
    unsupported('provider-trust-binding-invalid')
  }
  if (providerTrust.status === 'VERIFIED') {
    if (!hasExactKeys(providerTrust, [
      'evidenceSha256', 'externalAttestationSha256', 'externalIssuer', 'externalKeyId',
      'providerRecordSha256', 'registrySha256', 'runtimeIdentityHash', 'schemaVersion',
      'sha256', 'status', 'verifiedCapabilities',
    ])) unsupported('provider-trust-binding-invalid')
    const unsigned = { ...providerTrust }
    delete unsigned.sha256
    if (providerTrust.schemaVersion !== CONTRACT_VERSION ||
        !/^[a-f0-9]{64}$/.test(providerTrust.registrySha256 || '') ||
        !/^[a-f0-9]{64}$/.test(providerTrust.providerRecordSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(providerTrust.externalAttestationSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(providerTrust.evidenceSha256 || '') ||
        providerTrust.externalIssuer === 'autoprompt-codex-activation-v2' ||
        typeof providerTrust.externalIssuer !== 'string' || !providerTrust.externalIssuer ||
        typeof providerTrust.externalKeyId !== 'string' || !providerTrust.externalKeyId ||
        !isCanonicalCodexVerifiedCapabilities(providerTrust.verifiedCapabilities) ||
        providerTrust.sha256 !== sha256(Buffer.from(JSON.stringify(unsigned), 'utf8'))) {
      unsupported('provider-trust-binding-invalid')
    }
    return Object.freeze({
      status: 'VERIFIED',
      verificationMethod: 'live-conformance-suite',
      verifiedCapabilities: Object.freeze([...providerTrust.verifiedCapabilities]),
    })
  }
  if (providerTrust.status !== LOCAL_CONFORMANCE_STATUS ||
      !hasExactKeys(providerTrust, [
        'activationId', 'admissionMode', 'capabilityGeneration', 'enforcementProofSha256',
        'evidenceSha256', 'payloadManifestSha256', 'probedAt', 'processOwnershipProbeSha256',
        'providerAdmissionSha256', 'providerProbeSha256', 'providerRecordSha256',
        'registrySha256', 'requestSha256', 'runtimeIdentityHash', 'safetyInspectionSha256',
        'schemaVersion', 'sha256', 'status', 'targetIdentitySha256', 'verifiedCapabilities',
      ])) unsupported('provider-trust-binding-invalid')
  const unsigned = { ...providerTrust }
  delete unsigned.sha256
  const registry = readJson(
    path.join(PACKAGE_ROOT, 'agents', 'contracts', 'providers.json'), 'provider registry',
  )
  const provider = registry.providers?.find(candidate => candidate?.id === 'codex') || null
  const evidence = validateOwnedProcessConformanceEvidence(record)
  if (providerTrust.schemaVersion !== CONTRACT_VERSION ||
      providerTrust.admissionMode !== 'explicit-local-activation' ||
      providerTrust.registrySha256 !== sha256(Buffer.from(JSON.stringify(registry), 'utf8')) ||
      providerTrust.providerRecordSha256 !== sha256(Buffer.from(JSON.stringify(provider), 'utf8')) ||
      providerTrust.evidenceSha256 !== currentRuntimeIdentity.evidenceSha256 ||
      providerTrust.providerAdmissionSha256 !== currentRuntimeIdentity.providerAdmissionSha256 ||
      providerTrust.activationId !== record.activationId ||
      providerTrust.capabilityGeneration !== record.capability.generation ||
      providerTrust.requestSha256 !== record.request.sha256 ||
      providerTrust.targetIdentitySha256 !== localConformanceTargetHash(record.target) ||
      providerTrust.payloadManifestSha256 !== record.activationBoundary.payloadManifestSha256 ||
      providerTrust.enforcementProofSha256 !== record.activationBoundary.enforcementProof.sha256 ||
      providerTrust.providerProbeSha256 !==
        sha256(Buffer.from(stableJsonV1(record.providerProbe), 'utf8')) ||
      providerTrust.safetyInspectionSha256 !==
        sha256(Buffer.from(stableJsonV1(record.safety), 'utf8')) ||
      providerTrust.processOwnershipProbeSha256 !==
        sha256(Buffer.from(stableJsonV1(evidence), 'utf8')) ||
      !Number.isFinite(Date.parse(providerTrust.probedAt)) ||
      !isCanonicalCodexVerifiedCapabilities(providerTrust.verifiedCapabilities) ||
      providerTrust.sha256 !== sha256(Buffer.from(stableJsonV1(unsigned), 'utf8'))) {
    unsupported('provider-trust-binding-invalid')
  }
  return Object.freeze({
    status: LOCAL_CONFORMANCE_STATUS,
    verificationMethod: LOCAL_CONFORMANCE_VERIFICATION_METHOD,
    verifiedCapabilities: Object.freeze([...providerTrust.verifiedCapabilities]),
  })
}

function createProviderAttestation(record, now, activationNonce = null) {
  let currentRuntimeIdentity
  try { currentRuntimeIdentity = deriveCurrentCodexRuntimeIdentity() } catch {
    unsupported('canonical-provider-runtime-identity-unavailable')
  }
  const providerTrust = validateBoundProviderTrust(record, currentRuntimeIdentity)
  const pair = crypto.generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' })
  const keyId = sha256(publicKey)
  const attestation = {
    schemaVersion: CONTRACT_VERSION,
    attestationId: `codex:${record.activationId}:${record.capability.generation}`,
    providerId: 'codex',
    issuer: 'autoprompt-codex-activation-v2',
    issuedAt: now.toISOString(),
    expiresAt: record.capability.expiresAt,
    runtimeIdentityHash: providerRuntimeIdentity(record),
    activationNonce: activationNonce || crypto.randomBytes(24).toString('base64url'),
    verificationMethod: providerTrust.verificationMethod,
    verifiedCapabilities: [...providerTrust.verifiedCapabilities],
    canonicalProviderTrustSha256: record.providerTrust.sha256,
    result: 'supported',
  }
  attestation.signature = {
    algorithm: 'ed25519',
    keyId,
    value: crypto.sign(null, providerAttestationPayload(attestation), pair.privateKey)
      .toString('base64url'),
  }
  record.capability.providerAttestationKeyId = keyId
  const attestationSha256 = sha256(Buffer.from(JSON.stringify(attestation), 'utf8'))
  return {
    contractVersion: CONTRACT_VERSION,
    attestationSha256,
    providerCapabilitiesSha256: sha256(providerCapabilityBytes(record)),
    publicKey: {
      algorithm: 'ed25519',
      format: 'spki-der',
      keyId,
      value: publicKey.toString('base64url'),
    },
    attestation,
  }
}

function verifyProviderAttestation(record, options = {}) {
  const binding = record.providerAttestation
  const attestation = binding?.attestation
  const publicKey = binding?.publicKey
  const signature = attestation?.signature
  const issuedAt = Date.parse(attestation?.issuedAt)
  const expiresAt = Date.parse(attestation?.expiresAt)
  const providerTrust = record.providerTrust
  let currentRuntimeIdentity
  try { currentRuntimeIdentity = deriveCurrentCodexRuntimeIdentity() } catch {
    unsupported('canonical-provider-runtime-identity-unavailable')
  }
  const providerTrustValidation = validateBoundProviderTrust(record, currentRuntimeIdentity)
  if (!binding || binding.contractVersion !== CONTRACT_VERSION ||
      JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify([
        'attestation', 'attestationSha256', 'contractVersion', 'providerCapabilitiesSha256',
        'publicKey',
      ]) ||
      binding.attestationSha256 !== sha256(Buffer.from(JSON.stringify(attestation), 'utf8')) ||
      binding.providerCapabilitiesSha256 !== sha256(providerCapabilityBytes(record)) ||
      !publicKey || publicKey.algorithm !== 'ed25519' || publicKey.format !== 'spki-der' ||
      JSON.stringify(Object.keys(publicKey).sort()) !==
        JSON.stringify(['algorithm', 'format', 'keyId', 'value']) ||
      !/^[a-f0-9]{64}$/.test(publicKey.keyId || '') ||
      !/^[A-Za-z0-9_-]{43,512}$/.test(publicKey.value || '') ||
      !attestation || attestation.schemaVersion !== CONTRACT_VERSION ||
      JSON.stringify(Object.keys(attestation).sort()) !== JSON.stringify([
        'activationNonce', 'attestationId', 'canonicalProviderTrustSha256', 'expiresAt',
        'issuedAt', 'issuer', 'providerId', 'result', 'runtimeIdentityHash', 'schemaVersion',
        'signature', 'verificationMethod', 'verifiedCapabilities',
      ]) ||
      attestation.attestationId !== `codex:${record.activationId}:${record.capability.generation}` ||
      attestation.providerId !== 'codex' || attestation.issuer !== 'autoprompt-codex-activation-v2' ||
      !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt ||
      attestation.expiresAt !== record.capability.expiresAt ||
      attestation.runtimeIdentityHash !== providerRuntimeIdentity(record) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(attestation.activationNonce || '') ||
      attestation.verificationMethod !== providerTrustValidation.verificationMethod ||
      JSON.stringify(attestation.verifiedCapabilities) !==
        JSON.stringify(providerTrustValidation.verifiedCapabilities) ||
      attestation.canonicalProviderTrustSha256 !== providerTrust.sha256 ||
      attestation.result !== 'supported' || !signature || signature.algorithm !== 'ed25519' ||
      JSON.stringify(Object.keys(signature).sort()) !==
        JSON.stringify(['algorithm', 'keyId', 'value']) ||
      signature.keyId !== publicKey.keyId ||
      !/^[A-Za-z0-9_-]{43,512}$/.test(signature.value || '')) {
    unsupported('provider-attestation-invalid')
  }
  if (record.capability.providerAttestationKeyId !== publicKey.keyId) {
    unsupported('provider-attestation-capability-binding-invalid')
  }
  let keyBytes
  let signatureBytes
  try {
    keyBytes = Buffer.from(publicKey.value, 'base64url')
    signatureBytes = Buffer.from(signature.value, 'base64url')
  } catch { unsupported('provider-attestation-encoding-invalid') }
  if (sha256(keyBytes) !== publicKey.keyId) unsupported('provider-attestation-key-invalid')
  let verified = false
  try {
    verified = crypto.verify(
      null,
      providerAttestationPayload(attestation),
      crypto.createPublicKey({ key: keyBytes, type: 'spki', format: 'der' }),
      signatureBytes,
    )
  } catch {}
  if (!verified) unsupported('provider-attestation-signature-invalid')
  if (options.requireFresh) {
    const current = (options.now instanceof Date ? options.now : new Date()).getTime()
    if (current < issuedAt || current >= expiresAt) unsupported('provider-attestation-not-fresh')
  }
  return binding
}

function canonicalSupervisorRuntimeBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      Object.keys(binding).length !== 5 ||
      !Object.keys(binding).every(key => [
        'runPath', 'runId', 'metadataSha256', 'targetIdentity', 'createdAt',
      ].includes(key)) ||
      typeof binding.runPath !== 'string' || !path.isAbsolute(binding.runPath) ||
      typeof binding.runId !== 'string' || !ACTIVATION_ID_PATTERN.test(binding.runId) ||
      !/^[a-f0-9]{64}$/.test(binding.metadataSha256 || '') ||
      typeof binding.targetIdentity !== 'string' || !binding.targetIdentity ||
      !Number.isFinite(Date.parse(binding.createdAt))) {
    unsupported('supervisor-runtime-binding-invalid')
  }
  return {
    runPath: path.resolve(binding.runPath),
    runId: binding.runId,
    metadataSha256: binding.metadataSha256,
    targetIdentity: binding.targetIdentity,
    createdAt: binding.createdAt,
  }
}

function inspectSupervisorRuntimeBinding(activationRoot, record, binding) {
  const normalized = canonicalSupervisorRuntimeBinding(binding)
  const ownedRuntimeRoot = path.join(activationRoot, 'r')
  if (!isWithin(ownedRuntimeRoot, normalized.runPath) || normalized.runPath === ownedRuntimeRoot ||
      isWithin(record.target.realpath, normalized.runPath)) {
    unsupported('supervisor-runtime-path-unowned')
  }
  ensurePrivateDirectory(activationRoot, normalized.runPath)
  const metadataPath = path.join(normalized.runPath, 'metadata.json')
  const metadataBytes = readRegularBound(metadataPath, 'supervisor-runtime-metadata')
  if (sha256(metadataBytes) !== normalized.metadataSha256) {
    unsupported('supervisor-runtime-metadata-drift')
  }
  const digestPath = path.join(normalized.runPath, 'metadata.sha256')
  if (readRegularBound(digestPath, 'supervisor-runtime-metadata-digest')
    .toString('utf8').trim() !== normalized.metadataSha256) {
    unsupported('supervisor-runtime-metadata-digest-drift')
  }
  let metadata
  try { metadata = JSON.parse(metadataBytes.toString('utf8')) } catch {
    unsupported('supervisor-runtime-metadata-invalid')
  }
  if (metadata.run_id !== normalized.runId || metadata.run_id !== record.activationId ||
      metadata.run_path !== normalized.runPath || metadata.target_path !== record.target.realpath ||
      metadata.target_identity !== normalized.targetIdentity || metadata.provider_id !== 'codex' ||
      metadata.local_only !== true || metadata.automatic_export_allowed !== false) {
    unsupported('supervisor-runtime-metadata-binding-invalid')
  }
  return normalized
}

function validateSupervisorRuntimeReceipt(activationRoot, record) {
  const binding = record.supervisorRuntime
  const receipt = record.supervisorRuntimeReceipt
  if (binding == null && receipt == null) return null
  if (!binding || !receipt || typeof receipt !== 'object' ||
      receipt.path !== path.join(activationRoot, SUPERVISOR_RUNTIME_RECEIPT) ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256 || '') ||
      !Number.isSafeInteger(receipt.capabilityGeneration) || receipt.capabilityGeneration < 1 ||
      receipt.capabilityGeneration > record.capability.generation) {
    unsupported('supervisor-runtime-receipt-binding-invalid')
  }
  const normalized = inspectSupervisorRuntimeBinding(activationRoot, record, binding)
  const receiptBytes = readRegularBound(receipt.path, 'supervisor-runtime-receipt')
  if (sha256(receiptBytes) !== receipt.sha256) unsupported('supervisor-runtime-receipt-drift')
  let saved
  try { saved = JSON.parse(receiptBytes.toString('utf8')) } catch {
    unsupported('supervisor-runtime-receipt-invalid')
  }
  const canonicalBytes = Buffer.from(JSON.stringify(normalized), 'utf8')
  if (saved.schemaVersion !== 1 || saved.activationId !== record.activationId ||
      saved.requestSha256 !== record.request.sha256 ||
      saved.targetRealpath !== record.target.realpath ||
      saved.capabilityGeneration !== receipt.capabilityGeneration ||
      saved.bindingSha256 !== sha256(canonicalBytes) ||
      JSON.stringify(saved.binding) !== JSON.stringify(normalized)) {
    unsupported('supervisor-runtime-receipt-invalid')
  }
  return normalized
}

function resolveActivationRecord(root, activationId) {
  if (!ACTIVATION_ID_PATTERN.test(activationId)) fail('activation id is invalid')
  const activationRoot = path.join(root, ACTIVATION_DIRECTORY, activationId)
  ensurePrivateDirectory(root, activationRoot)
  const recordPath = path.join(activationRoot, ACTIVATION_RECORD)
  assertRegularUnlinked(recordPath, 'activation-record')
  const record = readJson(recordPath, 'activation record')
  const capability = record?.capability
  const request = record?.request
  const target = record?.target
  const boundary = record?.activationBoundary
  const proof = boundary?.enforcementProof
  const boundaryPaths = [
    boundary?.configPath,
    proof?.path,
    proof?.profilePath,
    proof?.checkerProfilePath,
    boundary?.gitConfig,
    boundary?.ghConfigDir,
    boundary?.supervisorAdapter,
    boundary?.payloadManifest,
  ]
  if (process.platform === 'win32') boundaryPaths.push(boundary?.sandboxIdentity?.path)
  const sandboxIdentityValid = process.platform === 'win32'
    ? boundary?.sandboxIdentity?.kind === 'windows-cap-sid-v1' &&
      /^[a-f0-9]{64}$/.test(boundary.sandboxIdentity.sha256 || '') &&
      /^[a-f0-9]{64}$/.test(boundary.sandboxIdentity.sourceSha256 || '')
    : boundary?.sandboxIdentity === null
  const boundaryValid = boundaryPaths.every(candidate => typeof candidate === 'string' &&
    path.isAbsolute(candidate) && isWithin(activationRoot, path.resolve(candidate))) &&
    /^[a-f0-9]{64}$/.test(boundary?.configSha256 || '') &&
    /^[a-f0-9]{64}$/.test(proof?.sha256 || '') &&
    /^[a-f0-9]{64}$/.test(proof?.profileSha256 || '') &&
    /^[a-f0-9]{64}$/.test(proof?.checkerProfileSha256 || '') &&
    /^[a-f0-9]{64}$/.test(boundary?.payloadManifestSha256 || '') &&
    /^[a-f0-9]{64}$/.test(boundary?.supervisorAdapterSha256 || '') &&
    sandboxIdentityValid &&
    ['posix-mode', 'windows-dacl'].includes(boundary?.privatePermissions?.mechanism) &&
    Number.isSafeInteger(boundary?.privatePermissions?.auditedPaths) &&
    boundary.privatePermissions.auditedPaths > 0 &&
    Number.isFinite(Date.parse(boundary?.privatePermissions?.auditedAt)) &&
    proof?.selectedProfile === PROFILE_NAME &&
    proof?.checkerSelectedProfile === CHECKER_PROFILE_NAME && proof?.strictConfig === true
  let canonical = null
  if (request && Array.isArray(request.argv) &&
      request.argv.length > 0 && request.argv.every(value => typeof value === 'string')) {
    canonical = Buffer.from(JSON.stringify({ schemaVersion: 1, argv: request.argv }), 'utf8')
  }
  const dateFields = [capability?.issuedAt, capability?.expiresAt]
  if (record?.revokedAt) dateFields.push(record.revokedAt)
  if (capability?.consumedAt) dateFields.push(capability.consumedAt)
  if (capability?.revokedAt) dateFields.push(capability.revokedAt)
  const tokenBindingValid = capability?.status === 'issued'
    ? /^[a-f0-9]{64}$/.test(capability.tokenSha256 || '')
    : capability?.tokenSha256 === null
  if (record?.schemaVersion !== ACTIVATION_SCHEMA_VERSION || record.activationId !== activationId ||
      !record.activationRoot || comparable(record.activationRoot) !== comparable(activationRoot) ||
      !capability || typeof capability.recordPath !== 'string' ||
      comparable(capability.recordPath) !== comparable(recordPath) ||
      capability.runId !== activationId || capability.targetRealpath !== target?.realpath ||
      capability.requestSha256 !== request?.sha256 || capability.singleUse !== true ||
      !Number.isSafeInteger(capability.generation) || capability.generation < 1 ||
      !['issued', 'consumed', 'revoked'].includes(capability.status) ||
      !['active', 'revoked'].includes(record.status) ||
      (record.status === 'active' && capability.status === 'revoked') ||
      (record.status === 'revoked' && capability.status !== 'revoked') ||
      !Array.isArray(capability.legalChildren) || capability.legalChildren.length === 0 ||
      capability.legalChildren.some(child => typeof child !== 'string') ||
      typeof capability.parentSession !== 'string' || typeof capability.parentRole !== 'string' ||
      typeof capability.caller !== 'string' || !tokenBindingValid ||
      !canonical || request.encoding !== 'utf8-json' || request.bytes !== canonical.length ||
      request.canonicalJson !== canonical.toString('utf8') ||
      request.canonicalBase64 !== canonical.toString('base64') || request.sha256 !== sha256(canonical) ||
      !target || typeof target.realpath !== 'string' || typeof target.device !== 'string' ||
      typeof target.inode !== 'string' || dateFields.some(value => !Number.isFinite(Date.parse(value))) ||
      JSON.stringify(record.contractVersions) !== JSON.stringify({
        settings: CONTRACT_VERSION,
        requestEnvelopeEntry: CONTRACT_VERSION,
        outcome: CONTRACT_VERSION,
        providerCapabilities: CONTRACT_VERSION,
        activationRequest: '1.0.0',
      }) || record.aliasTelemetry?.schemaVersion !== CONTRACT_VERSION ||
      record.aliasTelemetry?.appendPath !== 'compatibility/alias-telemetry.jsonl' ||
      record.aliasTelemetry?.registeredRunRecordPath !== false ||
      !record.modelSelection ||
      !['provider-default', 'auto', 'explicit'].includes(record.modelSelection.mode) ||
      typeof record.modelSelection.selector !== 'string' ||
      !Array.isArray(record.modelSelection.models) ||
      record.modelSelection.models.some(model => typeof model !== 'string' || !MODEL_PATTERN.test(model)) ||
      !/^[a-f0-9]{64}$/.test(record.modelSelection.castingHash || '') ||
      !/^[a-f0-9]{64}$/.test(record.modelSelection.agentDefinitionsHash || '') ||
      (record.modelSelection.registry !== null && (
        typeof record.modelSelection.registry !== 'object' ||
        typeof record.modelSelection.registry.path !== 'string' ||
        !path.isAbsolute(record.modelSelection.registry.path) ||
        !isWithin(activationRoot, path.resolve(record.modelSelection.registry.path)) ||
        !/^[a-f0-9]{64}$/.test(record.modelSelection.registry.sha256 || '')
      )) ||
      (record.modelSelection.mode === 'auto' && record.modelSelection.registry === null) ||
      record.modelSelection.probeAcceptance?.strictConfig !== true ||
      !Number.isFinite(Date.parse(record.modelSelection.probeAcceptance?.profileAcceptedAt)) ||
      typeof record.modelSelection.probeAcceptance?.explicitModelAndEffortAssignments !== 'boolean' ||
      record.roleProjection?.schemaVersion !== 1 ||
      !/^codex-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$/.test(
        record.roleProjection?.payloadGeneration || '',
      ) || !record.roleProjection?.logicalToPhysicalProviderRole ||
      typeof record.roleProjection.logicalToPhysicalProviderRole !== 'object' ||
      Array.isArray(record.roleProjection.logicalToPhysicalProviderRole) ||
      record.providerProbe?.schemaVersion !== 1 ||
      !/^[a-f0-9]{64}$/.test(record.providerProbe?.launcherHelpSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(record.providerProbe?.strictProfileOutputSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(record.providerProbe?.sandboxOutputSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(record.providerProbe?.networkProbeOutputSha256 || '') ||
      !Number.isFinite(Date.parse(record.providerProbe?.probedAt)) ||
      !boundaryValid || record.safety?.mechanicallyEnforced !== true ||
      !record.supervisorEntry || record.supervisorEntry.schemaVersion !== 1 ||
      record.supervisorEntry.prompt !== activationEnvelope(
        record, record.supervisorEntry.resumeActivationId ?? null,
      ) ||
      record.supervisorEntry.promptSha256 !== sha256(Buffer.from(record.supervisorEntry.prompt, 'utf8')) ||
      record.supervisorEntry.requestSha256 !== request.sha256 ||
      record.supervisorEntry.structuralInvocation !== ((record.supervisorEntry.resumeActivationId ?? null) === null
        ? '$autoprompt'
        : `$autoprompt resume ${record.activationId}`) ||
      ![null, record.activationId].includes(record.supervisorEntry.resumeActivationId ?? null)) {
    fail('activation record binding is invalid')
  }
  verifyActivationPayload(activationRoot)
  verifyWindowsSandboxIdentity(activationRoot, boundary.sandboxIdentity || null)
  if (record.modelSelection.registry) {
    assertRegularUnlinked(record.modelSelection.registry.path, 'activation-model-registry')
    if (sha256(fs.readFileSync(record.modelSelection.registry.path)) !==
        record.modelSelection.registry.sha256) {
      fail('activation model registry binding is invalid')
    }
  }
  for (const [file, expected, label] of [
    [boundary.configPath, boundary.configSha256, 'activation-config'],
    [boundary.payloadManifest, boundary.payloadManifestSha256, 'activation-payload-manifest'],
    [boundary.supervisorAdapter, boundary.supervisorAdapterSha256, 'activation-supervisor-adapter'],
    [proof.path, proof.sha256, 'activation-enforcement-proof'],
    [proof.profilePath, proof.profileSha256, 'activation-profile'],
    [proof.checkerProfilePath, proof.checkerProfileSha256, 'activation-checker-profile'],
  ]) {
    assertRegularUnlinked(file, label)
    if (sha256(fs.readFileSync(file)) !== expected) fail(`${label} binding is invalid`)
  }
  const proofRecord = readJson(proof.path, 'activation enforcement proof')
  if (proofRecord.schemaVersion !== 1 || proofRecord.provider !== 'codex' ||
      proofRecord.profilePath !== proof.profilePath ||
      proofRecord.profileSha256 !== proof.profileSha256 ||
      proofRecord.checkerProfilePath !== proof.checkerProfilePath ||
      proofRecord.checkerProfileSha256 !== proof.checkerProfileSha256 ||
      proofRecord.selectedProfile !== PROFILE_NAME ||
      proofRecord.checkerSelectedProfile !== CHECKER_PROFILE_NAME ||
      proofRecord.strictConfig !== true) {
    fail('activation enforcement proof binding is invalid')
  }
  verifyRoleProjection(record.roleProjection, proof.profilePath)
  const gitConfig = assertRegularUnlinked(boundary.gitConfig, 'activation-git-config')
  if (gitConfig.size !== 0n) fail('activation Git config is not empty')
  assertRealDirectory(boundary.ghConfigDir, 'activation-github-config')
  if (fs.readdirSync(boundary.ghConfigDir).length !== 0) {
    fail('activation GitHub config is not empty')
  }
  auditActivationRoot(activationRoot, true)
  verifyProviderAttestation(record)
  validateSupervisorRuntimeReceipt(activationRoot, record)
  return { activationRoot, record, recordPath }
}

function issueCapability(record, recordPath, now, ttlSeconds) {
  const token = crypto.randomBytes(32).toString('base64url')
  const generation = Number(record.capability?.generation || 0) + 1
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()
  record.status = 'active'
  record.revokedAt = null
  record.revocationReason = null
  record.capability = {
    caller: 'autoprompt-dispatcher',
    requestSha256: record.request.sha256,
    targetRealpath: record.target.realpath,
    runId: record.activationId,
    parentSession: record.capability?.parentSession || `launcher:${process.pid}:${crypto.randomBytes(8).toString('hex')}`,
    parentRole: 'autoprompt-root',
    legalChildren: [...ROOT_LEGAL_CHILDREN],
    generation,
    issuedAt: now.toISOString(),
    expiresAt,
    status: 'issued',
    singleUse: true,
    consumedAt: null,
    revokedAt: null,
    tokenSha256: sha256(Buffer.from(token, 'utf8')),
    recordPath,
  }
  return token
}

function activationCapabilityTtlSeconds(ttlSeconds) {
  return ttlSeconds
}

function consumeCapability(recordPath, token, context, now = new Date()) {
  assertRegularUnlinked(recordPath, 'activation-capability-record')
  const opened = fs.openSync(
    recordPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  )
  let boundStat
  let bytes
  try {
    boundStat = fs.fstatSync(opened, { bigint: true })
    if (!boundStat.isFile()) unsupported('activation-capability-record-not-regular')
    bytes = fs.readFileSync(opened)
  } finally {
    fs.closeSync(opened)
  }
  let record
  try { record = JSON.parse(bytes.toString('utf8')) } catch { unsupported('activation-capability-record-invalid') }
  const capability = record.capability
  const actualTokenHash = sha256(Buffer.from(String(token), 'utf8'))
  const expected = Buffer.from(String(capability?.tokenSha256 || ''), 'utf8')
  const actual = Buffer.from(actualTokenHash, 'utf8')
  const valid = record.status === 'active' && capability?.status === 'issued' &&
    capability.singleUse === true && capability.consumedAt === null &&
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual) &&
    capability.requestSha256 === record.request?.sha256 &&
    capability.targetRealpath === record.target?.realpath &&
    capability.caller === context.caller &&
    capability.parentSession === context.parentSession &&
    capability.parentRole === context.parentRole &&
    capability.runId === context.runId &&
    capability.generation === context.generation &&
    context.requestSha256 === record.request?.sha256 &&
    context.targetRealpath === record.target?.realpath &&
    Array.isArray(capability.legalChildren) && capability.legalChildren.includes(context.legalChild) &&
    comparable(capability.recordPath) === comparable(recordPath) &&
    path.basename(recordPath) === ACTIVATION_RECORD &&
    new Date(capability.expiresAt).getTime() > now.getTime()
  if (!valid) unsupported('activation-capability-denied')
  const rebound = assertRegularUnlinked(recordPath, 'activation-capability-record')
  if (String(rebound.dev) !== String(boundStat.dev) || String(rebound.ino) !== String(boundStat.ino) ||
      sha256(fs.readFileSync(recordPath)) !== sha256(bytes)) {
    unsupported('activation-capability-record-raced')
  }
  capability.status = 'consumed'
  capability.consumedAt = now.toISOString()
  capability.tokenSha256 = null
  writeJsonPrivate(recordPath, record)
  return record
}

function acquireActivationOperationLock(root, operation, guard) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return operationLock.acquire(root, operation, { guard })
    } catch (error) {
      // A contender can observe the lock directory and then lose its owner.json
      // while acquire() is opening it because the winner has already released.
      // Retry the whole atomic mkdir boundary; never treat a vanished owner as
      // malformed state or continue without owning a lease.
      if (error?.code !== 'ENOENT') throw error
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
  unsupported('activation-operation-lock-unstable')
}

function registerSupervisorRuntime(recordPath, binding, context) {
  if (typeof recordPath !== 'string' || !path.isAbsolute(recordPath) ||
      path.basename(recordPath) !== ACTIVATION_RECORD) {
    unsupported('supervisor-runtime-record-path-invalid')
  }
  const activationRoot = path.dirname(recordPath)
  const activationId = path.basename(activationRoot)
  if (!ACTIVATION_ID_PATTERN.test(activationId)) unsupported('supervisor-runtime-activation-invalid')
  const root = path.resolve(activationRoot, '..', '..')
  if (path.join(root, ACTIVATION_DIRECTORY, activationId) !== activationRoot) {
    unsupported('supervisor-runtime-activation-path-invalid')
  }
  const guard = new operationLock.RootGuard(activationRoot)
  const lease = acquireActivationOperationLock(
    activationRoot, 'register-supervisor-runtime', guard,
  )
  try {
    const resolved = resolveActivationRecord(root, activationId)
    const record = resolved.record
    const capability = record.capability
    if (!context || context.caller !== 'autoprompt-dispatcher' ||
        capability.status !== 'consumed' || capability.consumedAt === null ||
        capability.caller !== context.caller || capability.generation !== context.generation ||
        capability.parentSession !== context.parentSession ||
        capability.parentRole !== context.parentRole || capability.runId !== context.runId ||
        capability.requestSha256 !== context.requestSha256 ||
        capability.targetRealpath !== context.targetRealpath ||
        !capability.legalChildren.includes(context.legalChild) ||
        context.runId !== record.activationId || context.requestSha256 !== record.request.sha256 ||
        context.targetRealpath !== record.target.realpath) {
      unsupported('supervisor-runtime-capability-denied')
    }
    const normalized = inspectSupervisorRuntimeBinding(activationRoot, record, binding)
    const bindingBytes = Buffer.from(JSON.stringify(normalized), 'utf8')
    const receiptPath = path.join(activationRoot, SUPERVISOR_RUNTIME_RECEIPT)
    const desiredReceipt = {
      schemaVersion: 1,
      activationId: record.activationId,
      requestSha256: record.request.sha256,
      targetRealpath: record.target.realpath,
      capabilityGeneration: capability.generation,
      bindingSha256: sha256(bindingBytes),
      binding: normalized,
    }
    if (fs.existsSync(receiptPath)) {
      let existing
      try {
        existing = JSON.parse(readRegularBound(
          receiptPath, 'supervisor-runtime-receipt',
        ).toString('utf8'))
      } catch (error) {
        if (error instanceof ProviderUnsupportedError) throw error
        unsupported('supervisor-runtime-receipt-invalid')
      }
      if (existing.schemaVersion !== 1 || existing.activationId !== desiredReceipt.activationId ||
          existing.requestSha256 !== desiredReceipt.requestSha256 ||
          existing.targetRealpath !== desiredReceipt.targetRealpath ||
          !Number.isSafeInteger(existing.capabilityGeneration) ||
          existing.capabilityGeneration > capability.generation ||
          existing.bindingSha256 !== desiredReceipt.bindingSha256 ||
          JSON.stringify(existing.binding) !== JSON.stringify(normalized)) {
        unsupported('supervisor-runtime-already-bound')
      }
    } else {
      try { writeJsonPrivateExclusive(receiptPath, desiredReceipt) } catch (error) {
        if (error?.code === 'EEXIST') unsupported('supervisor-runtime-already-bound')
        throw error
      }
    }
    const receiptSha256 = sha256(readRegularBound(receiptPath, 'supervisor-runtime-receipt'))
    const existingBinding = record.supervisorRuntime
    if (existingBinding && JSON.stringify(canonicalSupervisorRuntimeBinding(existingBinding)) !==
        JSON.stringify(normalized)) {
      unsupported('supervisor-runtime-already-bound')
    }
    const existingReceipt = record.supervisorRuntimeReceipt
    if (existingReceipt && (existingReceipt.path !== receiptPath ||
        existingReceipt.sha256 !== receiptSha256 ||
        !Number.isSafeInteger(existingReceipt.capabilityGeneration))) {
      unsupported('supervisor-runtime-record-receipt-drift')
    }
    if (!existingBinding || !existingReceipt) {
      const before = fs.readFileSync(recordPath)
      const beforeStat = assertRegularUnlinked(recordPath, 'activation-record')
      const latest = readJson(recordPath, 'activation record')
      if (latest.capability?.status !== 'consumed' ||
          latest.capability?.generation !== capability.generation ||
          latest.supervisorRuntime != null || latest.supervisorRuntimeReceipt != null ||
          sha256(Buffer.from(`${JSON.stringify(latest, null, 2)}\n`, 'utf8')) !== sha256(before)) {
        unsupported('supervisor-runtime-record-raced')
      }
      const rebound = assertRegularUnlinked(recordPath, 'activation-record')
      if (String(rebound.dev) !== String(beforeStat.dev) || String(rebound.ino) !== String(beforeStat.ino)) {
        unsupported('supervisor-runtime-record-raced')
      }
      latest.supervisorRuntime = normalized
      latest.supervisorRuntimeReceipt = {
        path: receiptPath,
        sha256: receiptSha256,
        capabilityGeneration: desiredReceipt.capabilityGeneration,
      }
      writeJsonPrivate(recordPath, latest)
    }
    const finalRecord = readJson(recordPath, 'activation record')
    validateSupervisorRuntimeReceipt(activationRoot, finalRecord)
    return finalRecord
  } finally {
    operationLock.release(lease)
  }
}

function createAndRegisterSupervisorRuntime(prepared, context, now = new Date()) {
  const { activationId, activationRoot, recordPath, target } = prepared
  let { record } = prepared
  let binding = record.supervisorRuntime
  if (!binding) {
    const privateRuntimeModule = path.join(
      activationRoot, 'skills', 'autoprompt', 'workflow', 'run-record.js',
    )
    assertRegularUnlinked(privateRuntimeModule, 'supervisor-run-record-module')
    const runRecord = require(privateRuntimeModule)
    // Keep the provider-private component short enough for Windows ACL tools,
    // which still reject otherwise-valid paths at the legacy MAX_PATH boundary.
    const canonicalProviderPrivateRoot = path.join(activationRoot, 'r')
    let runtimeRecord
    try {
      runtimeRecord = runRecord.createRunRecord({
        targetPath: target.realpath,
        canonicalProviderPrivateRoot,
        providerId: 'codex',
        readOnly: true,
        exactTree: true,
        runId: activationId,
        now,
        assertStartBoundary: false,
      })
    } catch (error) {
      if (error?.code !== 'RUN_ID_COLLISION') throw error
      const targetIdentity = `filesystem:${process.platform === 'win32'
        ? path.resolve(target.realpath).toLowerCase()
        : path.resolve(target.realpath)}`
      const expectedRunPath = path.join(
        canonicalProviderPrivateRoot, 'targets', sha256(Buffer.from(targetIdentity, 'utf8')),
        '.autoprompt', 'runs', activationId,
      )
      runtimeRecord = runRecord.openRunRecord(expectedRunPath)
    }
    const metadataPath = path.join(runtimeRecord.runPath, 'metadata.json')
    const metadataBytes = fs.readFileSync(metadataPath)
    binding = {
      runPath: runtimeRecord.runPath,
      runId: runtimeRecord.runId,
      metadataSha256: sha256(metadataBytes),
      targetIdentity: runtimeRecord.targetIdentity,
      createdAt: now.toISOString(),
    }
  }
  record = registerSupervisorRuntime(recordPath, binding, context)
  return { binding: record.supervisorRuntime, record }
}

function revokeActivation(recordPath, record, reason, now = new Date()) {
  try {
    assertRegularUnlinked(recordPath, 'activation-record')
    const latest = readJson(recordPath, 'activation record')
    if (latest.activationId === record.activationId &&
        latest.capability?.generation === record.capability?.generation) {
      record = latest
    }
  } catch {}
  record.status = 'revoked'
  record.revokedAt = now.toISOString()
  record.revocationReason = reason
  record.capability.status = 'revoked'
  record.capability.revokedAt = record.revokedAt
  record.capability.tokenSha256 = null
  const auth = path.join(record.activationRoot, 'auth.json')
  let authCleanupError = null
  if (fs.existsSync(auth)) {
    try {
      assertRegularUnlinked(auth, 'activation-auth')
      fs.unlinkSync(auth)
    } catch (error) {
      authCleanupError = error
    }
  }
  writeJsonPrivate(recordPath, record)
  if (authCleanupError) throw authCleanupError
}

function prepareActivation(options = {}) {
  if (options.compatibilityAlias === true) {
    unsupported('compatibility-alias-telemetry-path-unregistered')
  }
  const canonicalTrust = requireCanonicalCodexCapabilityTrust(options)
  let providerTrust = canonicalTrust.ready === true
    ? canonicalProviderTrustBinding(canonicalTrust) : null
  const codexExecutable = bindAdmittedCodexExecutable(
    canonicalTrust.codexRuntime, canonicalTrust.runtimeIdentity.runtimeIdentityHash,
  )
  const env = options.env || process.env
  const root = resolveRoot(env)
  const target = targetIdentity(options.target || process.cwd())
  const now = options.now instanceof Date ? options.now : new Date()
  const request = normalizeRequest(options)
  const ttlSeconds = options.ttlSeconds == null ? DEFAULT_ACTIVATION_TTL_SECONDS : Number(options.ttlSeconds)
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_ACTIVATION_TTL_SECONDS) {
    fail(`activation ttl must be an integer from 60 to ${MAX_ACTIVATION_TTL_SECONDS} seconds`)
  }
  const payload = managedCodexPayload(root)
  let activationId
  let activationRoot
  let recordPath
  let record
  let activationSkillRoot
  let profilePath
  let profileSha256
  let checkerProfilePath
  let checkerProfileSha256
  let modelSelection
  let roleProjection
  let launcherHelp
  let freshActivation = false
  let resumeRollback = null
  if (options.resume) {
    const resolved = resolveActivationRecord(root, options.resume)
    activationId = options.resume
    activationRoot = resolved.activationRoot
    recordPath = resolved.recordPath
    record = resolved.record
    if (canonicalTrust.ready === true && record.providerTrust?.sha256 !== providerTrust.sha256) {
      unsupported('canonical-provider-trust-binding-drift')
    }
    if (canonicalTrust.localConformancePending === true &&
        record.providerTrust?.status !== LOCAL_CONFORMANCE_STATUS) {
      unsupported('local-conformance-trust-binding-drift')
    }
    verifyActivationPayload(activationRoot)
    if (new Date(record.capability.expiresAt).getTime() > now.getTime() && record.status === 'active') {
      fail('activation is already active')
    }
    if (record.target.realpath !== target.realpath) fail('resume target does not match the activation')
    if (record.request.sha256 !== request.sha256 ||
        record.request.canonicalJson !== request.canonicalJson) {
      fail('resume request does not match the authoritative activation request')
    }
    activationSkillRoot = path.join(activationRoot, 'skills', 'autoprompt')
    profilePath = path.join(activationRoot, `${PROFILE_NAME}.config.toml`)
    checkerProfilePath = path.join(activationRoot, `${CHECKER_PROFILE_NAME}.config.toml`)
    assertRegularUnlinked(profilePath, 'activation-profile')
    assertRegularUnlinked(checkerProfilePath, 'activation-checker-profile')
    profileSha256 = sha256(fs.readFileSync(profilePath))
    checkerProfileSha256 = sha256(fs.readFileSync(checkerProfilePath))
    modelSelection = record.modelSelection
    roleProjection = record.roleProjection
  } else {
    activationId = `apv2-${crypto.randomBytes(16).toString('hex')}`
    activationRoot = path.join(root, ACTIVATION_DIRECTORY, activationId)
    recordPath = path.join(activationRoot, ACTIVATION_RECORD)
    ensurePrivateDirectory(root, path.dirname(activationRoot), true)
    try { fs.mkdirSync(activationRoot, { mode: 0o700 }) } catch { unsupported('activation-root-create-failed') }
    ensurePrivateDirectory(root, activationRoot)
    freshActivation = true
  }
  try {
    const installationIdentityPath = path.join(activationRoot, 'installation_id')
    if (!fs.existsSync(installationIdentityPath)) {
      writePrivateFile(installationIdentityPath, Buffer.from(`${crypto.randomUUID()}\n`, 'utf8'))
    } else {
      assertRegularUnlinked(installationIdentityPath, 'codex-installation-identity')
      try { fs.chmodSync(installationIdentityPath, 0o600) } catch {}
    }
    const initialPrivacy = protectActivationRoot(activationRoot)
    const boundary = createPrivateBoundary(activationRoot)
    const sandboxIdentity = options.resume
      ? verifyWindowsSandboxIdentity(activationRoot, record.activationBoundary?.sandboxIdentity || null)
      : installWindowsSandboxIdentity(root, activationRoot)
    const initialBoundaryEnvironment = activationChildEnvironment(env, activationRoot, target, boundary)
    const codexRuntime = canonicalTrust.codexRuntime
    const boundaryEnvironment = withCodexManagedEnvironment(
      initialBoundaryEnvironment, codexRuntime,
    )
    launcherHelp = probeCodexLauncher({
      ...options, codexRuntime, env: boundaryEnvironment, target: target.realpath,
    })
    if (options.resume) {
      const manifestPath = path.join(activationRoot, ACTIVATION_PAYLOAD_MANIFEST)
      const priorProfile = fs.readFileSync(profilePath)
      const priorCheckerProfile = fs.readFileSync(checkerProfilePath)
      const priorManifest = fs.readFileSync(manifestPath)
      resumeRollback = {
        manifestPath,
        priorManifest,
        priorProfile,
        priorCheckerProfile,
        priorProof: fs.readFileSync(path.join(activationRoot, ENFORCEMENT_PROOF)),
        priorSandboxIdentity: process.platform === 'win32'
          ? readRegularBound(sandboxIdentity.path, 'codex-windows-sandbox-identity')
          : null,
        profilePath,
        checkerProfilePath,
      }
      try {
        const refreshedProfile = refreshActivationSecurityProfile(
          priorProfile, boundaryEnvironment,
        )
        writePrivateFile(profilePath, refreshedProfile)
        profileSha256 = sha256(refreshedProfile)
        updateActivationPayloadHash(activationRoot, profilePath)
        const refreshedCheckerProfile = refreshActivationSecurityProfile(
          priorCheckerProfile, boundaryEnvironment, 'read-only',
        )
        writePrivateFile(checkerProfilePath, refreshedCheckerProfile)
        checkerProfileSha256 = sha256(refreshedCheckerProfile)
        updateActivationPayloadHash(activationRoot, checkerProfilePath)
        verifyActivationPayload(activationRoot)
      } catch (error) {
        try {
          writePrivateFile(profilePath, priorProfile)
          writePrivateFile(checkerProfilePath, priorCheckerProfile)
          writePrivateFile(manifestPath, priorManifest)
        } catch (rollbackError) {
          fail(`activation profile refresh failed and rollback failed: ${rollbackError.message}`)
        }
        throw error
      }
    } else {
      const copied = copyActivationPayload(
        root, activationRoot, payload, boundaryEnvironment,
      )
      activationSkillRoot = copied.activationSkillRoot
      profilePath = copied.profilePath
      profileSha256 = copied.profileSha256
      checkerProfilePath = copied.checkerProfilePath
      checkerProfileSha256 = copied.checkerProfileSha256
      modelSelection = copied.modelSelection
      roleProjection = copied.roleProjection
      writePrivateFile(path.join(activationRoot, 'config.toml'), Buffer.from(renderActivationConfig(
        path.join(activationSkillRoot, 'SKILL.md'), projectSkillFiles(target.realpath),
      ), 'utf8'))
      record = {
        schemaVersion: ACTIVATION_SCHEMA_VERSION,
        activationId,
        activationRoot,
        createdAt: now.toISOString(),
        status: 'preparing',
        providerCapabilities: PROVIDER_CAPABILITIES,
        providerTrust,
        contractVersions: {
          settings: CONTRACT_VERSION,
          requestEnvelopeEntry: CONTRACT_VERSION,
          outcome: CONTRACT_VERSION,
          providerCapabilities: CONTRACT_VERSION,
          activationRequest: '1.0.0',
        },
        aliasTelemetry: {
          schemaVersion: CONTRACT_VERSION,
          appendPath: 'compatibility/alias-telemetry.jsonl',
          registeredRunRecordPath: false,
        },
        modelSelection,
        roleProjection,
        request,
        target,
        capability: { generation: 0 },
        providerProbe: null,
        providerAttestation: null,
        supervisorRuntime: null,
        supervisorRuntimeReceipt: null,
      }
    }
    const supervisorAdapter = path.join(activationSkillRoot, 'workflow', 'phase-budget.js')
    assertRegularUnlinked(supervisorAdapter, 'supervisor-adapter')
    const proof = enforcementProof(
      profilePath, profileSha256, checkerProfilePath, checkerProfileSha256,
    )
    const proofPath = path.join(activationRoot, ENFORCEMENT_PROOF)
    writeJsonPrivate(proofPath, proof)
    const configPath = path.join(activationRoot, 'config.toml')
    assertRegularUnlinked(configPath, 'activation-config')
    record.activationBoundary = {
      codexExecutable,
      configPath,
      configSha256: sha256(fs.readFileSync(configPath)),
      payloadManifest: path.join(activationRoot, ACTIVATION_PAYLOAD_MANIFEST),
      payloadManifestSha256: sha256(fs.readFileSync(path.join(
        activationRoot, ACTIVATION_PAYLOAD_MANIFEST,
      ))),
      enforcementProof: {
        path: proofPath,
        sha256: sha256(fs.readFileSync(proofPath)),
        profilePath,
        profileSha256,
        checkerProfilePath,
        checkerProfileSha256,
        checkerSelectedProfile: CHECKER_PROFILE_NAME,
        selectedProfile: PROFILE_NAME,
        strictConfig: true,
      },
      gitConfig: boundary.gitConfig,
      ghConfigDir: boundary.ghConfigDir,
      sandboxIdentity,
      privatePermissions: {
        auditedAt: now.toISOString(),
        auditedPaths: initialPrivacy.auditedPaths,
        mechanism: initialPrivacy.mechanism,
      },
      supervisorAdapter,
      supervisorAdapterSha256: sha256(fs.readFileSync(supervisorAdapter)),
    }
    const rawProbeEnvironment = activationChildEnvironment(env, activationRoot, target, boundary, {
      AUTOPROMPT_ACTIVATION_ID: activationId,
      AUTOPROMPT_ACTIVATION_RECORD: recordPath,
      AUTOPROMPT_ENFORCEMENT_PROOF: proofPath,
      AUTOPROMPT_PROFILE: PROFILE_NAME,
      AUTOPROMPT_PROFILE_PATH: profilePath,
      AUTOPROMPT_CHECKER_PROFILE: CHECKER_PROFILE_NAME,
      AUTOPROMPT_CHECKER_PROFILE_PATH: checkerProfilePath,
      AUTOPROMPT_PROVIDER: 'codex',
      AUTOPROMPT_RUN_ID: activationId,
      AUTOPROMPT_SUPERVISOR_ADAPTER: supervisorAdapter,
    })
    const probeEnvironment = codexRuntime
      ? withCodexManagedEnvironment(rawProbeEnvironment, codexRuntime)
      : rawProbeEnvironment
    const profileProbe = probeCodexProfile({
      ...options, codexRuntime, env: probeEnvironment, target: target.realpath,
    })
    if (process.platform === 'win32') {
      const identityBytes = readRegularBound(
        sandboxIdentity.path, 'codex-windows-sandbox-identity',
      )
      validateWindowsSandboxIdentity(identityBytes)
      const identitySha256 = sha256(identityBytes)
      if (options.resume && identitySha256 !== sandboxIdentity.sha256) {
        unsupported('codex-windows-sandbox-identity-drift')
      }
      record.activationBoundary.sandboxIdentity.sha256 = identitySha256
    }
    record.providerProbe = {
      schemaVersion: 1,
      launcherHelpSha256: sha256(Buffer.from(launcherHelp, 'utf8')),
      ...profileProbe,
      probedAt: now.toISOString(),
    }
    record.modelSelection.probeAcceptance = {
      strictConfig: true,
      profileAcceptedAt: now.toISOString(),
      explicitModelAndEffortAssignments: verifyExplicitModelAssignments(
        activationRoot, profilePath, record.modelSelection,
      ),
    }
    const safetyInspection = proveLocalOnlySafety(
      target.realpath, probeEnvironment, proof, options.spawnSync || childProcess.spawnSync,
    )
    record.safety = {
    schemaVersion: 1,
    mechanicallyEnforced: safetyInspection.mechanicallyEnforced,
    repositoryGitBarrier: safetyInspection.channels.repositoryGitBarrier,
    gitCommandNetworkBarrier: safetyInspection.channels.gitCommandNetworkBarrier,
    githubCliCredentialIsolation: safetyInspection.channels.githubCliCredentialIsolation,
    shellOutboundNetworkSandbox: safetyInspection.channels.shellOutboundNetworkSandbox,
    providerConnectorApiWriteToolDenial:
      safetyInspection.channels.providerConnectorApiWriteToolDenial,
    gitNetworkDenial: safetyInspection.channels.repositoryGitBarrier.enforced &&
      safetyInspection.channels.gitCommandNetworkBarrier.enforced ? 'enforced' : 'unproven',
    githubCliCredentialIsolationStatus:
      safetyInspection.channels.githubCliCredentialIsolation.enforced ? 'enforced' : 'unproven',
    shellNetworkDenial:
      safetyInspection.channels.shellOutboundNetworkSandbox.enforced ? 'enforced' : 'unproven',
    providerApiWriteTools:
      safetyInspection.channels.providerConnectorApiWriteToolDenial.enforced
        ? 'denied-by-strict-profile'
        : 'unproven',
    modelApiTransport: 'codex-service-outside-command-sandbox',
    }
    const finalPrivacy = protectActivationRoot(activationRoot, true)
    record.activationBoundary.privatePermissions = {
      auditedAt: now.toISOString(),
      auditedPaths: finalPrivacy.auditedPaths,
      mechanism: finalPrivacy.mechanism,
    }
    const token = issueCapability(
      record,
      recordPath,
      now,
      activationCapabilityTtlSeconds(ttlSeconds, now, env),
    )
    if (canonicalTrust.localConformancePending === true) {
      runLocalOwnedProcessConformance(record, probeEnvironment)
      providerTrust = localProviderTrustBinding(canonicalTrust, record, now)
      record.providerTrust = providerTrust
    }
    const activationNonce = options.resume
      ? record.providerAttestation.attestation.activationNonce
      : null
    record.providerAttestation = createProviderAttestation(record, now, activationNonce)
    const resumeActivationId = options.resume ? activationId : null
    const structuralInvocation = resumeActivationId === null
      ? '$autoprompt'
      : `$autoprompt resume ${resumeActivationId}`
    const entryPrompt = activationEnvelope(record, resumeActivationId)
    record.supervisorEntry = {
      schemaVersion: 1,
      prompt: entryPrompt,
      promptSha256: sha256(Buffer.from(entryPrompt, 'utf8')),
      requestSha256: record.request.sha256,
      structuralInvocation,
      resumeActivationId,
    }
    writeJsonPrivate(recordPath, record)
    protectActivationRoot(activationRoot, true)
    resumeRollback = null
    return {
      activationId, activationRoot, boundary, probeEnvironment, record, recordPath,
      request, root, target, token,
    }
  } catch (error) {
    if (resumeRollback) {
      try {
        writePrivateFile(resumeRollback.profilePath, resumeRollback.priorProfile)
        writePrivateFile(
          resumeRollback.checkerProfilePath, resumeRollback.priorCheckerProfile,
        )
        writePrivateFile(resumeRollback.manifestPath, resumeRollback.priorManifest)
        writePrivateFile(
          path.join(activationRoot, ENFORCEMENT_PROOF), resumeRollback.priorProof,
        )
        if (resumeRollback.priorSandboxIdentity) {
          writePrivateFile(
            path.join(activationRoot, 'cap_sid'), resumeRollback.priorSandboxIdentity,
          )
        }
      } catch (rollbackError) {
        fail(`activation resume failed and rollback failed: ${rollbackError.message}`)
      }
    }
    if (freshActivation && activationRoot && fs.existsSync(activationRoot)) {
      const activationParent = path.join(root, ACTIVATION_DIRECTORY)
      if (path.dirname(activationRoot) === activationParent && isWithin(activationParent, activationRoot)) {
        fs.rmSync(activationRoot, { recursive: true, force: true })
        for (const emptyParent of [activationParent, path.dirname(activationParent)]) {
          try { fs.rmdirSync(emptyParent) } catch {}
        }
      }
    }
    throw error
  }
}

function copyEphemeralAuth(root, activationRoot) {
  const source = path.join(root, 'auth.json')
  if (!fs.existsSync(source)) return false
  assertRegularUnlinked(source, 'codex-auth')
  fs.copyFileSync(source, path.join(activationRoot, 'auth.json'), fs.constants.COPYFILE_EXCL)
  try { fs.chmodSync(path.join(activationRoot, 'auth.json'), 0o600) } catch {}
  return true
}

function launchActivation(options = {}) {
  const prepared = prepareActivation(options)
  const {
    activationId, activationRoot, probeEnvironment, recordPath, root, target, token,
  } = prepared
  let { record } = prepared
  const spawn = options.spawnSync || childProcess.spawnSync
  const childEnv = { ...probeEnvironment }
  childEnv.AUTOPROMPT_CAPABILITY_GENERATION = String(record.capability.generation)
  const prompt = record.supervisorEntry.prompt
  const supervisorAdapter = record.activationBoundary.supervisorAdapter
  const proofPath = record.activationBoundary.enforcementProof.path
  const profilePath = record.activationBoundary.enforcementProof.profilePath
  const args = [
    supervisorAdapter,
    '--supervisor',
    '--adapter', supervisorAdapter,
    '--activation-record', recordPath,
    '--enforcement-proof', proofPath,
    '--profile-path', profilePath,
    '--run-id', activationId,
  ]
  let result
  const capabilityContext = {
    caller: 'autoprompt-dispatcher',
    generation: record.capability.generation,
    legalChild: ROOT_LEGAL_CHILDREN[0],
    parentRole: 'autoprompt-root',
    parentSession: record.capability.parentSession,
    requestSha256: record.request.sha256,
    runId: activationId,
    targetRealpath: target.realpath,
  }
  try {
    copyEphemeralAuth(root, activationRoot)
    const launchNow = options.now instanceof Date ? options.now : new Date()
    record = consumeCapability(recordPath, token, capabilityContext, launchNow)
    const runtime = createAndRegisterSupervisorRuntime({ ...prepared, record }, capabilityContext, launchNow)
    record = runtime.record
    verifyProviderAttestation(record, { requireFresh: true, now: launchNow })
    childEnv.AUTOPROMPT_ACTIVATION_ATTESTATION_SHA256 =
      record.providerAttestation.attestationSha256
    childEnv.AUTOPROMPT_SUPERVISOR_RUN_PATH = runtime.binding.runPath
    childEnv.AUTOPROMPT_SUPERVISOR_RUN_METADATA_SHA256 = runtime.binding.metadataSha256
    result = spawn(process.execPath, args, {
      cwd: target.realpath,
      env: childEnv,
      shell: false,
      stdio: options.stdio || 'inherit',
      encoding: options.encoding,
    })
  } finally {
    revokeActivation(recordPath, record, 'launcher-exited', options.now instanceof Date ? options.now : new Date())
  }
  const launched = {
    activationId, activationRoot, args, prompt, record, recordPath, root, target,
  }
  if (result && Number.isInteger(result.status)) return { ...launched, status: result.status }
  if (result && !result.error && result.signal && os.constants.signals[result.signal]) {
    return { ...launched, status: 128 + os.constants.signals[result.signal] }
  }
  return { ...launched, status: 1 }
}

function historicalLegacyAgentHashes() {
  const packageRegistry = readJson(
    path.join(PACKAGE_ROOT, 'scripts', 'install', 'codex-package-registry.json'),
    'Codex package registry',
  )
  const relative = packageRegistry.historicalGlobalRoleHashes
  const expectedDigest = packageRegistry.historicalGlobalRoleHashesSha256
  if (relative !== 'scripts/install/legacy-codex-role-hashes.json' ||
      !/^[a-f0-9]{64}$/.test(expectedDigest || '')) {
    unsupported('historical-global-role-hash-registry-invalid')
  }
  const registryPath = path.join(PACKAGE_ROOT, ...relative.split('/'))
  const bytes = fs.readFileSync(registryPath)
  if (sha256(bytes) !== expectedDigest) unsupported('historical-global-role-hash-registry-drift')
  let registry
  try { registry = JSON.parse(bytes.toString('utf8')) } catch {
    unsupported('historical-global-role-hash-registry-invalid')
  }
  if (registry.schemaVersion !== 1 || registry.provider !== 'codex' ||
      registry.algorithm !== 'sha256' || !Array.isArray(registry.records) ||
      registry.records.length === 0) {
    unsupported('historical-global-role-hash-registry-invalid')
  }
  const expected = new Map()
  let previousVersion = null
  for (const record of registry.records) {
    if (!/^\d+\.\d+\.\d+$/.test(record?.releaseVersion || '') ||
        !Array.isArray(record.roles) || !record.roles.length ||
        (previousVersion && record.releaseVersion <= previousVersion)) {
      unsupported('historical-global-role-hash-registry-invalid')
    }
    previousVersion = record.releaseVersion
    const names = new Set()
    for (const role of record.roles) {
      if (!AGENT_PATTERN.test(role?.name || '') || !/^[a-f0-9]{64}$/.test(role?.sha256 || '') ||
          names.has(role.name)) unsupported('historical-global-role-hash-registry-invalid')
      names.add(role.name)
      expected.set(`${role.name}:${role.sha256}`, `historical-global-role-registry@${record.releaseVersion}`)
    }
  }
  return expected
}

function expectedLegacyAgentHashes(root) {
  const expected = historicalLegacyAgentHashes()
  let payload
  try { payload = managedCodexPayload(root) } catch { return expected }
  for (const entry of payload.files) {
    const parts = entry.relative.split(path.sep)
    if (parts.length !== 2 || parts[0] !== 'agents-runtime' || !AGENT_PATTERN.test(parts[1])) continue
    expected.set(`${parts[1]}:${entry.sha256}`, 'current-install-receipt-and-hash-manifest')
  }
  return expected
}

function inventoryIsolation(options = {}) {
  const env = options.env || process.env
  const root = resolveRoot(env)
  const expected = expectedLegacyAgentHashes(root)
  const managedSkill = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const metadata = path.join(root, 'skills', 'autoprompt', 'agents', 'openai.yaml')
  const globalRoot = path.join(root, 'agents')
  const knownLegacy = []
  const knownLegacyAssets = []
  const foreignCollisions = []
  const foreignCollisionAssets = []
  let entries = []
  if (assertExistingDirectorySafe(globalRoot, 'global-agent-root')) {
    try { entries = fs.readdirSync(globalRoot, { withFileTypes: true }) } catch {}
  }
  for (const entry of entries) {
    if (!entry.isFile() || !AGENT_PATTERN.test(entry.name)) continue
    const file = path.join(globalRoot, entry.name)
    assertRegularUnlinked(file, 'global-agent')
    const digest = sha256(fs.readFileSync(file))
    const key = `${entry.name}:${digest}`
    if (expected.has(key)) {
      knownLegacy.push(file)
      knownLegacyAssets.push({
        path: file,
        sha256: digest,
        provenance: expected.get(key),
      })
    } else {
      foreignCollisions.push(file)
      foreignCollisionAssets.push({ path: file, sha256: digest, provenance: 'foreign-preserve' })
    }
  }
  const active = []
  const expiredActivations = []
  const malformedActivations = []
  const activationRoot = path.join(root, ACTIVATION_DIRECTORY)
  let activations = []
  if (fs.existsSync(activationRoot)) {
    ensurePrivateDirectory(root, activationRoot)
    try { activations = fs.readdirSync(activationRoot, { withFileTypes: true }) } catch {}
  }
  for (const entry of activations) {
    if (!entry.isDirectory() || !ACTIVATION_ID_PATTERN.test(entry.name)) continue
    try {
      const { record } = resolveActivationRecord(root, entry.name)
      if (record.status === 'active') {
        active.push(entry.name)
        if (new Date(record.capability.expiresAt).getTime() <= Date.now()) {
          expiredActivations.push(entry.name)
        }
      }
    } catch (error) {
      malformedActivations.push({ activationId: entry.name, error: String(error.message || error) })
    }
  }
  const manualPolicy = fs.existsSync(metadata) &&
    /^\s*allow_implicit_invocation:\s*false\s*$/m.test(fs.readFileSync(metadata, 'utf8'))
  let managedPayload = fs.existsSync(managedSkill) ? 'invalid' : 'missing'
  let managedPayloadReason = ''
  if (managedPayload === 'invalid') {
    try {
      managedCodexPayload(root)
      managedPayload = 'verified'
    } catch (error) {
      managedPayloadReason = String(error.message || error)
    }
  }
  const recommendations = []
  if (knownLegacy.length) recommendations.push('quarantine-known-legacy')
  if (foreignCollisions.length) recommendations.push('preserve-and-exclude-foreign-collisions')
  if (managedPayload !== 'verified') recommendations.push('repair-managed-private-payload')
  if (malformedActivations.length) recommendations.push('repair-or-preserve-malformed-activation-records')
  let registryCapability = null
  let registryError = ''
  let capabilityTrust = null
  let capabilityConflicts = []
  let localConformanceAvailable = false
  try {
    const registry = options.providerRegistry || readJson(
      path.join(PACKAGE_ROOT, 'agents', 'contracts', 'providers.json'), 'provider registry',
    )
    registryCapability = registry.providers?.find(provider => provider.id === 'codex') || null
    capabilityTrust = evaluateCanonicalCodexCapabilityTrust(registry, {
      env,
      now: options.now,
      spawnSync: options.spawnSync,
      trustedPublicKeys: loadReleaseCodexTrustedPublicKeys(options),
    })
    capabilityConflicts = [...capabilityTrust.blockers]
    localConformanceAvailable = localConformancePending(capabilityTrust, registry)
    if (!registryCapability) registryError = 'codex provider entry is missing'
  } catch (error) {
    registryError = String(error.message || error)
  }
  return {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    provider: 'codex',
    capabilities: PROVIDER_CAPABILITIES,
    managedEntry: fs.existsSync(managedSkill),
    managedPayload,
    managedPayloadReason,
    manualPolicy,
    knownLegacy,
    knownLegacyAssets,
    knownLegacySkill: detectLegacyCodexInstall(root, { packageRoot: PACKAGE_ROOT }).matched,
    foreignCollisions,
    foreignCollisionAssets,
    activeActivations: active,
    expiredActivations,
    malformedActivations,
    ambientVisibleInternalRoles: knownLegacy,
    registryCapability,
    registryError,
    capabilityTrust,
    capabilityConflicts,
    canonicalTrustReady: capabilityTrust?.ready === true,
    localConformanceAvailable,
    recommendations,
    isolationReady: managedPayload === 'verified' && manualPolicy && knownLegacy.length === 0 &&
      malformedActivations.length === 0 && !registryError && capabilityTrust?.ready === true,
  }
}

function quarantineKnownLegacy(options = {}) {
  const env = options.env || process.env
  const root = resolveRoot(env)
  const inventory = inventoryIsolation({ env })
  const moved = []
  for (const source of inventory.knownLegacy) {
    assertRegularUnlinked(source, 'known-legacy-agent')
    const directory = path.join(root, QUARANTINE_DIRECTORY)
    ensurePrivateDirectory(root, directory, true)
    let destination = path.join(directory, path.basename(source))
    if (fs.existsSync(destination)) {
      destination = `${destination}.${crypto.randomBytes(6).toString('hex')}`
    }
    fs.renameSync(source, destination)
    moved.push({ source, destination, sha256: sha256(fs.readFileSync(destination)) })
  }
  if (moved.length) {
    const receipt = path.join(root, QUARANTINE_DIRECTORY, `quarantine-${Date.now()}-${process.pid}.json`)
    writeJsonPrivate(receipt, { schemaVersion: 1, provider: 'codex', moved })
  }
  return { moved, foreignCollisions: inventory.foreignCollisions }
}

function revokeAllActivations(options = {}) {
  const env = options.env || process.env
  const root = resolveRoot(env)
  const directory = path.join(root, ACTIVATION_DIRECTORY)
  let entries = []
  if (fs.existsSync(directory)) {
    ensurePrivateDirectory(root, directory)
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch {}
  }
  let revoked = 0
  const malformed = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ACTIVATION_ID_PATTERN.test(entry.name)) continue
    try {
      const resolved = resolveActivationRecord(root, entry.name)
      if (resolved.record.status === 'active') {
        revokeActivation(resolved.recordPath, resolved.record, options.reason || 'provider-uninstalled')
        revoked += 1
      }
    } catch (error) {
      malformed.push({ activationId: entry.name, error: String(error.message || error) })
    }
  }
  if (malformed.length) fail(`malformed activation records prevent complete revocation: ${JSON.stringify(malformed)}`)
  return { revoked }
}
function configureCodex(options = {}) {
  const env = options.env || process.env
  const packageRoot = options.packageRoot || PACKAGE_ROOT
  const root = resolveRoot(env)
  const guard = new operationLock.RootGuard(root)
  const lease = operationLock.acquire(root, 'configure-codex', { guard })
  try {
    const selection = resolveSelector(options.selector, options.modelMap || '')
    const managedPayload = managedCodexPayload(root)
    const agentsDirectory = path.join(managedPayload.skillRoot, 'agents-runtime')
    const castingPath = path.join(agentsDirectory, '.autoprompt-casting.json')
    const profilePath = managedPayload.profilePath
    const receiptPath = path.join(root, RECEIPT)
    const hashesPath = path.join(root, HASHES)
    for (const [file, label] of [[receiptPath, 'install receipt'], [hashesPath, 'hash manifest'], [castingPath, 'casting manifest'], [profilePath, 'Codex profile']]) {
      try { guard.assertExisting(file, 'file') } catch (error) { fail(`${label} failed physical containment: ${error.message}`) }
    }
    const receipt = readJson(receiptPath, 'install receipt')
    if (!Array.isArray(receipt.files)) fail('install receipt has no managed file inventory')
    const owned = new Set(receipt.files.map(comparable))
    const casting = readJson(castingPath, 'casting manifest')
    if (!Array.isArray(casting.agents) || !casting.agents.length || casting.agents.some(name => !AGENT_PATTERN.test(name)) || new Set(casting.agents).size !== casting.agents.length) fail('casting manifest has an invalid agent inventory')
    const declaredAgents = new Set(casting.agents)
    const undeclared = fs.readdirSync(agentsDirectory).filter(name => AGENT_PATTERN.test(name) && !declaredAgents.has(name))
    if (undeclared.length) fail(`unowned Codex agent collision: ${undeclared.join(', ')}`)
    const agentPaths = [...casting.agents].sort().map(name => path.join(agentsDirectory, name))
    const targets = [...agentPaths, castingPath, profilePath]
    for (const file of [...targets, hashesPath]) {
      if (!owned.has(comparable(file))) fail(`target is not receipt-owned: ${file}`)
      try { guard.assertExisting(file, 'file') } catch (error) { fail(`receipt-owned target failed physical containment: ${error.message}`) }
    }
    const hashes = readJson(hashesPath, 'hash manifest')
    if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) fail('hash manifest is invalid')
    const hashKeys = new Map(Object.keys(hashes).map(key => [managedHashIdentity(root, key), key]))
    for (const file of targets) {
      const key = hashKeys.get(comparable(file))
      if (!key || !/^[a-f0-9]{64}$/.test(hashes[key]) || sha256(fs.readFileSync(file)) !== hashes[key]) fail(`receipt-owned target has drift: ${file}`)
    }

    guard.assertRoot()
    const stage = fs.mkdtempSync(path.join(root, '.autoprompt-configure-'))
    const stageAgents = path.join(stage, path.relative(root, agentsDirectory))
    const stageProfile = path.join(stage, path.relative(root, profilePath))
    try {
      guard.assertExisting(stage, 'directory')
      const originals = new Map([...targets, hashesPath].map(file => [file, fs.readFileSync(file)]))
      fs.mkdirSync(stageAgents, { recursive: true })
    for (const file of agentPaths) {
      const role = path.basename(file, '.toml')
      fs.writeFileSync(path.join(stageAgents, path.basename(file)), renderAgent(fs.readFileSync(file), role, selection))
    }
    if (selection.models.length) {
      for (const name of casting.agents) {
        const staged = fs.readFileSync(path.join(stageAgents, name), 'utf8')
        if (!/^model\s*=\s*"/m.test(staged) || !/^model_reasoning_effort\s*=\s*"/m.test(staged)) {
          fail(`staged agent is missing casting fields: ${name}`)
        }
      }
    }
    const castingTool = path.join(packageRoot, 'agents', 'codex', 'workflow', 'codex-agent-casting.js')
    const profileTool = path.join(packageRoot, 'agents', 'codex', 'workflow', 'codex-agent-profile.js')
    const registryArgs = selection.registry ? ['--registry', selection.registry] : []
    runTool(castingTool, ['--write-manifest', '--agents-dir', stageAgents, '--selector', selection.selector, ...registryArgs], { env, root })
    const stagedCastingPath = path.join(stageAgents, '.autoprompt-casting.json')
    const stagedCasting = readJson(stagedCastingPath, 'staged casting manifest')
    if (selection.registry) {
      stagedCasting.registryPath = selection.registry
      writeJsonPrivate(stagedCastingPath, stagedCasting)
    }
    runTool(profileTool, ['--write', '--agents-dir', stageAgents, '--profile', stageProfile, '--workspace', root], { env, root })
    runTool(castingTool, ['--resolve', '--agents-dir', stageAgents, '--selector', selection.selector, ...registryArgs], { env, root })
    runTool(profileTool, ['--verify', '--agents-dir', stageAgents, '--profile', stageProfile, '--workspace', root], { env, root })
    const desired = new Map(agentPaths.map(file => [file, fs.readFileSync(path.join(stageAgents, path.basename(file)))]))
    desired.set(castingPath, fs.readFileSync(path.join(stageAgents, '.autoprompt-casting.json')))
    desired.set(profilePath, fs.readFileSync(stageProfile))
    const nextHashes = { ...hashes }
    for (const [file, bytes] of desired) nextHashes[hashKeys.get(comparable(file))] = sha256(bytes)
    desired.set(hashesPath, Buffer.from(`${JSON.stringify(nextHashes, null, 2)}\n`))
    const unchanged = [...desired].every(([file, bytes]) => originals.get(file).equals(bytes))
    if (unchanged) return { status: 'unchanged', selector: selection.selector, models: selection.models, agents: agentPaths.length }
      const committed = []
      const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`
      try {
        for (const [file, bytes] of desired) {
          const index = committed.length + 1
          atomicWrite(file, bytes, suffix, { guard, index, phase: 'commit', renameHook: options.renameHook })
          committed.push(file)
          if (options.faultAfterRename === committed.length) throw new Error('injected commit failure')
        }
        runTool(castingTool, ['--resolve', '--agents-dir', agentsDirectory, '--selector', selection.selector, ...registryArgs], { env, root })
        runTool(profileTool, ['--verify', '--agents-dir', agentsDirectory, '--profile', profilePath, '--workspace', root], { env, root })
      } catch (error) {
        const rollbackErrors = []
        let rollbackIndex = 0
        for (const file of committed.reverse()) {
          rollbackIndex += 1
          try {
            atomicWrite(file, originals.get(file), `${suffix}-rollback`, {
              guard, index: rollbackIndex, phase: 'rollback', renameHook: options.renameHook,
            })
          } catch (rollbackError) {
            rollbackErrors.push(`${file}: ${rollbackError.message}`)
          }
        }
        if (rollbackErrors.length) {
          throw new Error(`${error.message}; rollback errors: ${rollbackErrors.join('; ')}`)
        }
        throw error
      }
      return { status: 'updated', selector: selection.selector, models: selection.models, agents: agentPaths.length }
    } finally {
      guard.assertExisting(stage, 'directory')
      fs.rmSync(stage, { recursive: true, force: true })
    }
  } finally {
    operationLock.release(lease)
  }
}
function run(options = {}) {
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  try {
    const result = configureCodex(options)
    stdout.write(`Autoprompt Codex configured: status=${result.status} selector=${result.selector} models=${result.models.length} agents=${result.agents}\n`)
    return 0
  } catch (error) {
    stderr.write(`Autoprompt configure (codex): ${error.message}\n`)
    return error instanceof ConfigureError ? 1 : 1
  }
}

function runMaintenance(argv, options = {}) {
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  try {
    if (argv[0] === '--doctor-isolation' && argv.length === 1) {
      const report = inventoryIsolation(options)
      stdout.write(`${JSON.stringify(report)}\n`)
      return report.isolationReady ? 0 : 1
    }
    if (argv[0] === '--doctor-activation-prerequisites' && argv.length === 1) {
      const report = inspectActivationPrerequisites(options)
      stdout.write(`${JSON.stringify(report)}\n`)
      return 0
    }
    if (argv[0] === '--quarantine-known-legacy' && argv.length === 1) {
      const result = quarantineKnownLegacy(options)
      stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }
    if (argv[0] === '--revoke-all' && argv.length === 1) {
      const result = revokeAllActivations(options)
      stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }
    if (argv[0] === '--has-known-residue' && argv.length === 1) {
      const report = inventoryIsolation(options)
      const root = resolveRoot(options.env || process.env)
      const managedResidue = {
        discoveryEntry: report.managedEntry ? path.join(root, DISCOVERY_SKILL_RELATIVE) : null,
        hashManifest: fs.existsSync(path.join(root, HASHES)) ? path.join(root, HASHES) : null,
        installReceipt: fs.existsSync(path.join(root, RECEIPT)) ? path.join(root, RECEIPT) : null,
        payloadState: report.managedPayload,
      }
      const unresolvedCollisions = report.foreignCollisions
      stdout.write(`${JSON.stringify({
        managedResidue,
        knownLegacy: report.knownLegacy,
        knownLegacySkill: report.knownLegacySkill,
        unresolvedCollisions,
        activeActivations: report.activeActivations,
        malformedActivations: report.malformedActivations,
      })}\n`)
      return managedResidue.discoveryEntry || managedResidue.hashManifest || managedResidue.installReceipt ||
        report.knownLegacy.length || report.knownLegacySkill || unresolvedCollisions.length ||
        report.activeActivations.length || report.malformedActivations.length ? 3 : 0
    }
    stderr.write('Autoprompt Codex maintenance: unsupported command\n')
    return 2
  } catch (error) {
    stderr.write(`Autoprompt Codex maintenance: ${error.message}\n`)
    return 1
  }
}

if (require.main === module) {
  process.exitCode = process.argv[2]?.startsWith('--')
    ? runMaintenance(process.argv.slice(2))
    : run({ selector: process.argv[2], modelMap: process.argv[3] || '' })
}
module.exports = {
  ACTIVATION_SCHEMA_VERSION,
  ConfigureError,
  PROVIDER_CAPABILITIES,
  ProviderUnsupportedError,
  canonicalCodexVerifiedCapabilities,
  activationCapabilityTtlSeconds,
  activationEnvelope,
  configureCodex,
  controlledNetworkProbeAddress,
  copyActivationPayload,
  consumeCapability,
  deriveCodexRuntimeIdentity,
  deriveCurrentCodexRuntimeIdentity,
  evaluateCanonicalCodexCapabilityTrust,
  evaluateCanonicalCodexCapabilityTrustAgainstIdentity,
  inventoryIsolation,
  isCanonicalCodexVerifiedCapabilities,
  historicalLegacyAgentHashes,
  inspectActivationPrerequisites,
  launchActivation,
  loadReleaseCodexTrustedPublicKeys,
  managedCodexPayload,
  physicalProviderRole,
  prepareActivation,
  projectPhysicalAgentRoleConfig,
  probeCodexCommandNetwork,
  providerRuntimeIdentity,
  proveLocalOnlySafety,
  quarantineKnownLegacy,
  requireCanonicalCodexCapabilityTrust,
  renderSecurityProfile,
  registerSupervisorRuntime,
  renderAgent,
  resolveSelector,
  revokeAllActivations,
  run,
  runMaintenance,
  stableJsonV1,
  verifyProviderAttestation,
  validateRuntimeRoleProjection,
  verifyRoleProjection,
}
