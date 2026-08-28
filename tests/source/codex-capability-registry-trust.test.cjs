#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const configure = require('../../scripts/codex-configure.cjs')
const runtimeIdentity = require('../../scripts/codex-runtime-identity.cjs')
const { providerProjectionPlan } = require('../../scripts/generate-provider-contracts.cjs')
const router = require('../../agents/codex/workflow/router.js')
const shippedRegistry = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'agents', 'contracts', 'providers.json'), 'utf8',
))

function promoteCodexAdmission(registry) {
  const provider = registry.providers.find(candidate => candidate.id === 'codex')
  provider.implementationStatus = 'verified'
  provider.currentIsolationClass = 'strict'
  provider.defaultAdmission = 'allow-verified-required-capabilities'
  provider.attestationRequired = true
  provider.capabilities.isolation = 'supported'
  provider.capabilities.topologyEnforcement = 'degraded'
  provider.capabilities.privateSkillRoot = 'supported'
  provider.capabilities.processOwnership = 'supported'
  provider.capabilities.modelRouting = 'unknown'
  return provider
}

function providerAdmissionSha256(provider) {
  const projection = structuredClone(provider)
  delete projection.verificationAttestation
  return sha256Bytes(Buffer.from(configure.stableJsonV1(projection), 'utf8'))
}

function externallyVerifiedRegistry(now = new Date('2026-08-23T12:00:00.000Z'),
  runtimeIdentityHash, activationNonce = 'external_live_nonce_1234',
  baseRegistry = shippedRegistry) {
  const registry = structuredClone(baseRegistry)
  const provider = promoteCodexAdmission(registry)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const keyId = crypto.createHash('sha256').update(
    publicKey.export({ type: 'spki', format: 'der' }),
  ).digest('hex')
  provider.verificationAttestation = {
    schemaVersion: '2.0.0',
    attestationId: 'attestation:codex:external-live',
    providerId: 'codex',
    issuer: 'independent-codex-conformance-service',
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    signature: { algorithm: 'ed25519', keyId, value: 'A'.repeat(86) },
    runtimeIdentityHash: runtimeIdentityHash ||
      configure.deriveCurrentCodexRuntimeIdentity().runtimeIdentityHash,
    activationNonce,
    providerAdmissionSha256: providerAdmissionSha256(provider),
    supportedEnvironment: {
      platform: 'win32',
      arch: 'x64',
      codexExecutableBasename: 'codex.exe',
      codexExecutableSha256: 'e'.repeat(64),
      codexExecutableVersion: 'codex-cli 1.2.3',
    },
    verificationMethod: 'live-conformance-suite',
    verifiedCapabilities: Object.entries(provider.capabilities)
      .filter(([, value]) => value === 'supported')
      .map(([capability]) => capability)
      .sort(),
    result: 'supported',
  }
  const resign = () => {
    provider.verificationAttestation.signature.value = crypto.sign(
      null, router.attestationSignedPayload(provider.verificationAttestation), privateKey,
    ).toString('base64url')
  }
  resign()
  return { keyId, privateKey, publicKey, registry, resign, trustedPublicKeys: { [keyId]: publicKey } }
}

function evaluateSignedIdentity(runtimeIdentityHash) {
  const now = new Date('2026-08-23T12:00:00.000Z')
  const { fixture, identity } = readyClosureFixture()
  const activationNonce = canonicalEvidenceNonce(identity)
  const { registry, trustedPublicKeys } = externallyVerifiedRegistry(
    now, runtimeIdentityHash, activationNonce,
  )
  return configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    registry, identity, { now, trustedPublicKeys, evidenceBytes: jsonBytes(fixture.evidence) },
  )
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function canonicalEvidenceNonce(identity) {
  const canonical = Buffer.from(configure.stableJsonV1(identity.evidence), 'utf8')
  return Buffer.from(sha256Bytes(canonical), 'hex').toString('base64url')
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function refreshManifest(manifest, providerRegistry = shippedRegistry) {
  const oldGeneration = manifest.payloadGeneration
  manifest.providerContractCoreSha256 = runtimeIdentity.providerContractCoreSha256(providerRegistry)
  const deployCore = runtimeIdentity.deriveCodexDeployCore(manifest, { providerRegistry })
  manifest.payloadDigest = deployCore.payloadDigest
  manifest.payloadGeneration = deployCore.payloadGeneration
  const replace = value => typeof value === 'string'
    ? value.replaceAll(oldGeneration, manifest.payloadGeneration)
    : Array.isArray(value) ? value.map(replace)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
        : value
  manifest.logicalToPhysicalProviderRole = replace(manifest.logicalToPhysicalProviderRole)
  manifest.physicalRoles = replace(manifest.physicalRoles)
  manifest.embeddedReceipt = '.autoprompt-runtime-manifest.json'
  delete manifest.payloadClosureDigest
  manifest.payloadClosureDigest = runtimeIdentity.codexPayloadClosureDigest(manifest)
}

function closureFixture() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'manifests', 'codex-runtime.json'), 'utf8',
  ))
  const providers = structuredClone(shippedRegistry)
  const keyRing = {
    schemaVersion: '1.0.0', providerId: 'codex',
    keys: [{
      algorithm: 'ed25519', format: 'spki-pem', keyId: 'd'.repeat(64),
      notBefore: '2026-08-23T11:00:00.000Z', notAfter: '2026-08-23T13:00:00.000Z',
      publicKeyPem: 'fixture-public-key', status: 'trusted',
    }],
  }
  const evidence = {
    schemaVersion: 'codex-live-conformance-evidence.v1', result: 'PASS', fixtureOnly: false,
    runtimeIdentityHash: '0'.repeat(64), evidence: {
      canarySchema: 'codex-live-canary.v1', canaryResult: 'PASS',
      codexExecutable: {
        realpath: 'C:\\verifier\\codex.exe', platform: 'win32', arch: 'x64',
        basename: 'codex.exe', sha256: 'e'.repeat(64), version: 'codex-cli 1.2.3',
      },
    },
  }
  const sources = {
    'agents/contracts/providers.json': jsonBytes(providers),
    'agents/contracts/codex-trusted-public-keys.json': jsonBytes(keyRing),
    'agents/contracts/codex-live-conformance-evidence.json': jsonBytes(evidence),
  }
  for (const [source, bytes] of Object.entries(sources)) {
    let dependency = manifest.externalDependencies.find(candidate => candidate.source === source)
    if (!dependency) {
      dependency = { source, destination: source.replace(/^agents\//, 'skills/'), kind: 'trust-artifact' }
      manifest.externalDependencies.push(dependency)
      manifest.externalDependencies.sort((left, right) => left.source.localeCompare(right.source))
    }
    dependency.sha256 = sha256Bytes(bytes)
  }
  refreshManifest(manifest, providers)
  return {
    codexConfigureBytes: fs.readFileSync(path.join(ROOT, 'scripts', 'codex-configure.cjs')),
    codexExecutable: {
      realpath: 'C:\\verifier\\codex.exe', platform: 'win32', arch: 'x64',
      basename: 'codex.exe', sha256: 'e'.repeat(64), version: 'codex-cli 1.2.3',
    },
    contractVersion: '2.0.0', evidence, keyRing, manifest, providers,
  }
}

function deriveFixture(fixture) {
  return configure.deriveCodexRuntimeIdentity({
    runtimeManifestBytes: jsonBytes(fixture.manifest),
    codexConfigureBytes: fixture.codexConfigureBytes,
    providerRegistryBytes: jsonBytes(fixture.providers),
    trustedKeyRingBytes: jsonBytes(fixture.keyRing),
    evidenceBytes: jsonBytes(fixture.evidence),
    codexExecutable: fixture.codexExecutable,
    contractVersion: fixture.contractVersion,
  })
}

function readyClosureFixture() {
  const fixture = closureFixture()
  promoteCodexAdmission(fixture.providers)
  fixture.manifest.externalDependencies.find(dependency =>
    dependency.source === 'agents/contracts/providers.json').sha256 =
      sha256Bytes(jsonBytes(fixture.providers))
  refreshManifest(fixture.manifest, fixture.providers)
  const provisional = deriveFixture(fixture)
  fixture.evidence.runtimeIdentityHash = provisional.runtimeIdentityHash
  fixture.manifest.externalDependencies.find(dependency =>
    dependency.source === 'agents/contracts/codex-live-conformance-evidence.json').sha256 =
      sha256Bytes(jsonBytes(fixture.evidence))
  refreshManifest(fixture.manifest, fixture.providers)
  const identity = deriveFixture(fixture)
  assert.equal(identity.runtimeIdentityHash, provisional.runtimeIdentityHash)
  return { fixture, identity }
}

test('AP-ISO-018 exact pre-canary blockers admit only pending local conformance', t => {
  const provider = shippedRegistry.providers.find(candidate => candidate.id === 'codex')
  assert.equal(provider.implementationStatus, 'verified')
  assert.equal(provider.currentIsolationClass, 'strict')
  assert.equal(provider.defaultAdmission, 'allow-verified-required-capabilities')
  assert.equal(provider.attestationRequired, true)
  assert.deepEqual(provider.capabilities, {
    isolation: 'supported',
    topologyEnforcement: 'degraded',
    privateSkillRoot: 'supported',
    eventStreaming: 'unknown',
    toolOutputCapture: 'unknown',
    stableChildIdentity: 'unknown',
    sameContextContinuation: 'unknown',
    cancellation: 'unknown',
    isolatedChecking: 'unknown',
    processOwnership: 'supported',
    modelRouting: 'unknown',
  })
  assert.equal(provider.verificationAttestation, null)
  const trust = configure.evaluateCanonicalCodexCapabilityTrust(shippedRegistry, {
    now: new Date('2026-08-23T12:00:00.000Z'),
  })
  assert.equal(trust.ready, false)
  assert.equal(trust.status, 'PROVIDER_UNSUPPORTED')
  assert.deepEqual(trust.blockers, [
    'canonical-live-evidence-invalid',
    'external-attestation-missing',
    'external-attestation-verification-method-invalid',
    'supported-capability-unattested-isolation',
    'supported-capability-unattested-privateSkillRoot',
    'supported-capability-unattested-processOwnership',
  ])
  const cleanEnv = { ...process.env }
  delete cleanEnv.AUTOPROMPT_BENCHMARK_UNATTESTED_BETA
  const pending = configure.requireCanonicalCodexCapabilityTrust({
    env: cleanEnv,
    providerRegistry: shippedRegistry,
    now: new Date('2026-08-23T12:00:00.000Z'),
  })
  assert.equal(pending.ready, false)
  assert.equal(pending.status, 'LOCAL_CONFORMANCE_PENDING')
  assert.equal(pending.localConformancePending, true)
  assert.deepEqual(pending.blockers, trust.blockers)
  assert.deepEqual(pending.verifiedCapabilities, [])

  const ambientOverride = configure.requireCanonicalCodexCapabilityTrust({
    env: {
      ...cleanEnv,
      AUTOPROMPT_BENCHMARK_UNATTESTED_BETA: 'acknowledged-local-beta-override',
    },
    providerRegistry: shippedRegistry,
    now: new Date('2026-08-23T12:00:00.000Z'),
  })
  assert.equal(ambientOverride.status, pending.status)
  assert.equal(ambientOverride.localConformancePending, pending.localConformancePending)
  assert.deepEqual(ambientOverride.blockers, pending.blockers)
  assert.equal(ambientOverride.runtimeIdentity.runtimeIdentityHash,
    pending.runtimeIdentity.runtimeIdentityHash,
    'the retired benchmark variable must not change admission or runtime trust')

  const seventhBlocker = structuredClone(shippedRegistry)
  seventhBlocker.providers.find(candidate => candidate.id === 'codex')
    .capabilities.modelRouting = 'supported'
  assert.throws(() => configure.requireCanonicalCodexCapabilityTrust({
    env: cleanEnv,
    providerRegistry: seventhBlocker,
    now: new Date('2026-08-23T12:00:00.000Z'),
  }), error => error.code === 'PROVIDER_UNSUPPORTED' &&
      error.reason === 'canonical-provider-capability-refusal',
  'pending local conformance must fail closed when any seventh blocker appears')

  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ap-cap-trust-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const installRoot = path.join(sandbox, 'codex-root')
  const target = path.join(sandbox, 'target')
  fs.mkdirSync(installRoot)
  fs.mkdirSync(target)
  assert.throws(() => configure.prepareActivation({
    env: { ...process.env, AUTOPROMPT_INSTALL_ROOT: installRoot },
    mission: 'must refuse an uninstalled payload before activation mutation',
    target,
  }))
  assert.equal(fs.existsSync(path.join(installRoot, '.a')), false)
})

test('source generation allows only the Codex pre-canary pending-attestation state', () => {
  const pending = providerProjectionPlan({ providers: shippedRegistry })
    .find(decision => decision.provider === 'codex')
  assert.deepEqual(pending, {
    provider: 'codex',
    portOpen: true,
    runtimeAdmitted: false,
    projectionMode: 'SAFE_DEGRADED',
    claimsRealBehavior: false,
    reason: 'attestation-required-before-runtime-admission',
  })

  const nonCodex = structuredClone(shippedRegistry)
  const claude = nonCodex.providers.find(provider => provider.id === 'claude')
  claude.implementationStatus = 'verified'
  claude.attestationRequired = true
  claude.capabilities.processOwnership = 'supported'
  assert.throws(
    () => providerProjectionPlan({ providers: nonCodex }),
    /cannot declare the Codex pre-canary attestation policy/,
  )
})

test('activation attestations use the exact canonical supported provider capability set', () => {
  const exact = ['isolation', 'privateSkillRoot', 'processOwnership']
  assert.deepEqual(configure.canonicalCodexVerifiedCapabilities(), exact)
  assert.equal(configure.isCanonicalCodexVerifiedCapabilities(exact), true)
  for (const wrong of [
    ['isolation', 'privateSkillRoot'],
    ['isolation', 'privateSkillRoot', 'processOwnership', 'topologyEnforcement'],
    ['privateSkillRoot', 'isolation', 'processOwnership'],
    ['isolation', 'privateSkillRoot', 'modelRouting'],
  ]) assert.equal(configure.isCanonicalCodexVerifiedCapabilities(wrong), false)

  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'codex-configure.cjs'), 'utf8')
  assert.doesNotMatch(source, /verifiedCapabilities:\s*\['isolation', 'privateSkillRoot'\]/)
  assert.match(source, /verifiedCapabilities:\s*\[\.\.\.canonicalCodexVerifiedCapabilities\(\)\]/)
  assert.match(source, /verifiedCapabilities:\s*\[\.\.\.providerTrust\.verifiedCapabilities\]/)
  assert.match(source, /JSON\.stringify\(attestation\.verifiedCapabilities\)[\s\S]*JSON\.stringify\(providerTrustValidation\.verifiedCapabilities\)/)
  assert.match(source, /isCanonicalCodexVerifiedCapabilities\(providerTrust\.verifiedCapabilities/)
})

test('AP-PKG-019 local live-conformance attestation cannot upgrade canonical refusal', t => {
  const now = new Date('2026-08-23T12:00:00.000Z')
  const { fixture, identity } = readyClosureFixture()
  const nonce = canonicalEvidenceNonce(identity)
  const { keyId, publicKey, registry, trustedPublicKeys } = externallyVerifiedRegistry(
    now, identity.runtimeIdentityHash, nonce,
  )
  const external = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    registry, identity, { now, trustedPublicKeys },
  )
  assert.equal(external.ready, true)
  assert.equal(external.externalAttestation.issuer, 'independent-codex-conformance-service')
  assert.deepEqual(
    providerProjectionPlan({ providers: registry })
      .find(decision => decision.provider === 'codex'),
    {
      provider: 'codex', portOpen: true, runtimeAdmitted: true,
      projectionMode: 'VERIFIED', claimsRealBehavior: true,
      reason: 'verified-provider-capability-contract',
    },
  )

  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ap-key-ring-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const keyRingPath = path.join(sandbox, 'codex-trusted-public-keys.json')
  fs.writeFileSync(keyRingPath, `${JSON.stringify({
    schemaVersion: '1.0.0',
    providerId: 'codex',
    keys: [{
      algorithm: 'ed25519', format: 'spki-pem', keyId,
      notBefore: '2026-08-23T11:00:00.000Z', notAfter: '2026-08-23T13:00:00.000Z',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), status: 'trusted',
    }],
  }, null, 2)}\n`)
  const releaseKeys = configure.loadReleaseCodexTrustedPublicKeys({
    now, providerTrustedKeyRingPath: keyRingPath,
  })
  assert.equal(configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    registry, identity, { now, trustedPublicKeys: releaseKeys },
  ).ready, true)

  const selfIssued = structuredClone(registry)
  const provider = selfIssued.providers.find(candidate => candidate.id === 'codex')
  provider.verificationAttestation.issuer = 'autoprompt-codex-activation-v2'
  const rejected = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    selfIssued, identity, { now, trustedPublicKeys },
  )
  assert.equal(rejected.ready, false)
  assert.ok(rejected.blockers.includes('external-attestation-self-issued'))
})

test('signed current Codex bytes produce the only accepted runtime identity', () => {
  const { identity: current } = readyClosureFixture()
  assert.deepEqual(Object.keys(current.identity), [
    'providerId', 'contractVersion', 'payloadGeneration', 'payloadDigest',
    'runtimeManifestSha256', 'providerAdmissionSha256', 'providerContractCoreSha256',
    'trustedKeyRingSha256',
    'codexConfigureSha256', 'codexExecutablePlatform', 'codexExecutableArch',
    'codexExecutableBasename', 'codexExecutableSha256', 'codexExecutableVersion',
  ])
  assert.equal(evaluateSignedIdentity(current.runtimeIdentityHash).ready, true)
})

test('signed attestation-supplied runtime identity mismatch is rejected', () => {
  const rejected = evaluateSignedIdentity('b'.repeat(64))
  assert.equal(rejected.ready, false)
  assert.ok(rejected.blockers.includes('external-attestation-runtime-identity-mismatch'))
})

test('signed attestation cannot be replayed across Codex provider admission policy changes', () => {
  const { identity } = readyClosureFixture()
  const now = new Date('2026-08-23T12:00:00.000Z')
  const signed = externallyVerifiedRegistry(
    now, identity.runtimeIdentityHash, canonicalEvidenceNonce(identity),
  )
  const mutations = [
    provider => { provider.implementationStatus = 'declared-unverified' },
    provider => { provider.currentIsolationClass = 'prompt-guarded' },
    provider => { provider.defaultAdmission = 'allow-different-policy' },
    provider => { provider.attestationRequired = false },
    ...Object.keys(signed.registry.providers.find(provider => provider.id === 'codex').capabilities)
      .map(capability => provider => {
        const current = provider.capabilities[capability]
        provider.capabilities[capability] = current === 'supported'
          ? 'degraded'
          : current === 'degraded' ? 'unknown' : 'degraded'
      }),
  ]
  for (const mutate of mutations) {
    const replayed = structuredClone(signed.registry)
    mutate(replayed.providers.find(provider => provider.id === 'codex'))
    const rejected = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
      replayed, identity, { now, trustedPublicKeys: signed.trustedPublicKeys },
    )
    assert.equal(rejected.ready, false)
    assert.ok(rejected.blockers.includes('external-attestation-provider-admission-mismatch'))
  }
})

test('Codex supported capability coverage is exact and leaves model routing unverified', () => {
  const { identity } = readyClosureFixture()
  const now = new Date('2026-08-23T12:00:00.000Z')
  const signed = externallyVerifiedRegistry(
    now, identity.runtimeIdentityHash, canonicalEvidenceNonce(identity),
  )
  const provider = signed.registry.providers.find(candidate => candidate.id === 'codex')
  provider.capabilities.modelRouting = 'supported'
  provider.verificationAttestation.providerAdmissionSha256 = providerAdmissionSha256(provider)
  signed.resign()
  const unattested = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    signed.registry, identity, { now, trustedPublicKeys: signed.trustedPublicKeys },
  )
  assert.equal(unattested.ready, false)
  assert.ok(unattested.blockers.includes('supported-capability-unattested-modelRouting'))

  provider.capabilities.modelRouting = 'unknown'
  provider.verificationAttestation.providerAdmissionSha256 = providerAdmissionSha256(provider)
  provider.verificationAttestation.verifiedCapabilities.push('modelRouting')
  provider.verificationAttestation.verifiedCapabilities.sort()
  signed.resign()
  const overclaimed = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    signed.registry, identity, { now, trustedPublicKeys: signed.trustedPublicKeys },
  )
  assert.equal(overclaimed.ready, false)
  assert.ok(overclaimed.blockers.includes('attested-capability-not-supported-modelRouting'))
})

test('evaluated registry trust policy must match the signed deploy-core registry', () => {
  const { identity } = readyClosureFixture()
  const now = new Date('2026-08-23T12:00:00.000Z')
  const signed = externallyVerifiedRegistry(
    now, identity.runtimeIdentityHash, canonicalEvidenceNonce(identity),
  )
  signed.registry.attestationVerificationPolicy.acceptedAlgorithms.reverse()
  const rejected = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    signed.registry, identity, { now, trustedPublicKeys: signed.trustedPublicKeys },
  )
  assert.equal(rejected.ready, false)
  assert.ok(rejected.blockers.includes('candidate-provider-contract-mismatch'))
})

test('Codex deploy-core identity excludes unrelated provider records', () => {
  const { fixture, identity } = readyClosureFixture()
  const unrelated = structuredClone(fixture)
  unrelated.codexConfigureBytes = fixture.codexConfigureBytes
  unrelated.providers.providers.find(provider => provider.id === 'claude')
    .safeDegradedBehavior = 'unrelated provider-only policy change'
  unrelated.manifest.externalDependencies.find(dependency =>
    dependency.source === 'agents/contracts/providers.json').sha256 =
      sha256Bytes(jsonBytes(unrelated.providers))
  refreshManifest(unrelated.manifest, unrelated.providers)
  assert.equal(deriveFixture(unrelated).runtimeIdentityHash, identity.runtimeIdentityHash)
})

test('signed identity for tampered runtime-manifest or configure bytes is rejected', () => {
  const manifestFixture = readyClosureFixture().fixture
  manifestFixture.manifest.entrypoints = [...manifestFixture.manifest.entrypoints, 'workflow/tamper.js']
  refreshManifest(manifestFixture.manifest, manifestFixture.providers)
  const tamperedManifest = deriveFixture(manifestFixture)
  const configureFixture = readyClosureFixture().fixture
  configureFixture.codexConfigureBytes = Buffer.concat([
    configureFixture.codexConfigureBytes, Buffer.from(' '),
  ])
  const tamperedConfigure = deriveFixture(configureFixture)
  for (const candidate of [tamperedManifest, tamperedConfigure]) {
    const rejected = evaluateSignedIdentity(candidate.runtimeIdentityHash)
    assert.equal(rejected.ready, false)
    assert.ok(rejected.blockers.includes('external-attestation-runtime-identity-mismatch'))
  }
})

test('signed identity for an old Codex payload generation and digest is rejected', () => {
  const stale = readyClosureFixture().fixture
  stale.manifest.payloadDigest = 'c'.repeat(64)
  stale.manifest.payloadGeneration = `codex-v2.0.0-${'c'.repeat(16)}`
  assert.throws(() => deriveFixture(stale), /runtime identity deploy-core binding is invalid/)
})

test('signed identity for a different provider contract version is rejected', () => {
  const fixture = readyClosureFixture().fixture
  fixture.contractVersion = '1.9.0'
  fixture.manifest.contractVersion = '1.9.0'
  refreshManifest(fixture.manifest, fixture.providers)
  const mismatched = deriveFixture(fixture)
  const rejected = evaluateSignedIdentity(mismatched.runtimeIdentityHash)
  assert.equal(rejected.ready, false)
  assert.ok(rejected.blockers.includes('external-attestation-runtime-identity-mismatch'))
})

test('trust-envelope staging is non-cyclic while runtime, configure, and key bytes stay bound', () => {
  const before = closureFixture()
  promoteCodexAdmission(before.providers)
  before.manifest.externalDependencies.find(dependency =>
    dependency.source === 'agents/contracts/providers.json').sha256 =
      sha256Bytes(jsonBytes(before.providers))
  refreshManifest(before.manifest, before.providers)
  const beforeIdentity = deriveFixture(before)
  const deployed = runtimeIdentity.deriveCodexDeployCore(before.manifest, {
    providerRegistry: before.providers,
  })
  assert.equal(beforeIdentity.identity.payloadDigest, before.manifest.payloadDigest)
  assert.equal(beforeIdentity.identity.payloadDigest, deployed.payloadDigest)
  assert.equal(beforeIdentity.identity.payloadGeneration, before.manifest.payloadGeneration)
  assert.equal(beforeIdentity.identity.payloadGeneration, deployed.payloadGeneration)
  const after = structuredClone(before)
  after.codexConfigureBytes = before.codexConfigureBytes
  const codex = after.providers.providers.find(provider => provider.id === 'codex')
  codex.verificationAttestation = { staged: true }
  after.evidence.runtimeIdentityHash = beforeIdentity.runtimeIdentityHash
  for (const [source, bytes] of [
    ['agents/contracts/providers.json', jsonBytes(after.providers)],
    ['agents/contracts/codex-live-conformance-evidence.json', jsonBytes(after.evidence)],
  ]) {
    after.manifest.externalDependencies.find(dependency => dependency.source === source).sha256 =
      sha256Bytes(bytes)
  }
  refreshManifest(after.manifest, after.providers)
  assert.equal(deriveFixture(after).runtimeIdentityHash, beforeIdentity.runtimeIdentityHash)

  const admissionTamper = structuredClone(before)
  admissionTamper.codexConfigureBytes = before.codexConfigureBytes
  admissionTamper.providers.providers.find(provider => provider.id === 'codex')
    .defaultAdmission = 'allow-different-policy'
  admissionTamper.manifest.externalDependencies.find(dependency =>
    dependency.source === 'agents/contracts/providers.json').sha256 =
      sha256Bytes(jsonBytes(admissionTamper.providers))
  refreshManifest(admissionTamper.manifest, admissionTamper.providers)
  assert.notEqual(
    deriveFixture(admissionTamper).runtimeIdentityHash,
    beforeIdentity.runtimeIdentityHash,
  )

  const runtimeTamper = structuredClone(before)
  runtimeTamper.codexConfigureBytes = before.codexConfigureBytes
  runtimeTamper.manifest.entrypoints = [...runtimeTamper.manifest.entrypoints, 'workflow/tamper.js']
  refreshManifest(runtimeTamper.manifest, runtimeTamper.providers)
  assert.notEqual(deriveFixture(runtimeTamper).runtimeIdentityHash, beforeIdentity.runtimeIdentityHash)

  const configureTamper = { ...before,
    codexConfigureBytes: Buffer.concat([before.codexConfigureBytes, Buffer.from(' ')]),
  }
  assert.notEqual(deriveFixture(configureTamper).runtimeIdentityHash, beforeIdentity.runtimeIdentityHash)

  const keyTamper = structuredClone(before)
  keyTamper.codexConfigureBytes = before.codexConfigureBytes
  keyTamper.keyRing.keys[0].notAfter = '2026-08-23T14:00:00.000Z'
  keyTamper.manifest.externalDependencies.find(dependency =>
    dependency.source === 'agents/contracts/codex-trusted-public-keys.json').sha256 =
      sha256Bytes(jsonBytes(keyTamper.keyRing))
  refreshManifest(keyTamper.manifest, keyTamper.providers)
  assert.notEqual(deriveFixture(keyTamper).runtimeIdentityHash, beforeIdentity.runtimeIdentityHash)
})

test('frozen pre-canary admission refuses until PASS evidence and attestation are added core-neutrally', () => {
  const preCanary = closureFixture()
  promoteCodexAdmission(preCanary.providers)
  preCanary.evidence.result = 'PENDING'
  preCanary.evidence.fixtureOnly = true
  preCanary.evidence.evidence.canaryResult = 'PENDING'
  for (const [source, bytes] of [
    ['agents/contracts/providers.json', jsonBytes(preCanary.providers)],
    ['agents/contracts/codex-live-conformance-evidence.json', jsonBytes(preCanary.evidence)],
  ]) {
    preCanary.manifest.externalDependencies.find(dependency => dependency.source === source).sha256 =
      sha256Bytes(bytes)
  }
  refreshManifest(preCanary.manifest, preCanary.providers)
  const preCanaryIdentity = deriveFixture(preCanary)
  const now = new Date('2026-08-23T12:00:00.000Z')
  const refused = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    preCanary.providers, preCanaryIdentity, { now, trustedPublicKeys: {} },
  )
  assert.equal(refused.ready, false)
  assert.ok(refused.blockers.includes('external-attestation-missing'))
  assert.ok(refused.blockers.includes('canonical-live-evidence-invalid'))

  const postCanary = structuredClone(preCanary)
  postCanary.codexConfigureBytes = preCanary.codexConfigureBytes
  postCanary.evidence.result = 'PASS'
  postCanary.evidence.fixtureOnly = false
  postCanary.evidence.runtimeIdentityHash = preCanaryIdentity.runtimeIdentityHash
  postCanary.evidence.evidence.canaryResult = 'PASS'
  const nonce = Buffer.from(sha256Bytes(Buffer.from(
    configure.stableJsonV1(postCanary.evidence), 'utf8',
  )), 'hex').toString('base64url')
  const signed = externallyVerifiedRegistry(
    now, preCanaryIdentity.runtimeIdentityHash, nonce, preCanary.providers,
  )
  postCanary.providers = signed.registry
  for (const [source, bytes] of [
    ['agents/contracts/providers.json', jsonBytes(postCanary.providers)],
    ['agents/contracts/codex-live-conformance-evidence.json', jsonBytes(postCanary.evidence)],
  ]) {
    postCanary.manifest.externalDependencies.find(dependency => dependency.source === source).sha256 =
      sha256Bytes(bytes)
  }
  refreshManifest(postCanary.manifest, postCanary.providers)
  const postCanaryIdentity = deriveFixture(postCanary)
  assert.equal(postCanaryIdentity.runtimeIdentityHash, preCanaryIdentity.runtimeIdentityHash)
  assert.equal(postCanaryIdentity.identity.payloadDigest, preCanaryIdentity.identity.payloadDigest)
  assert.equal(
    postCanaryIdentity.identity.payloadGeneration,
    preCanaryIdentity.identity.payloadGeneration,
  )
  assert.equal(configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    postCanary.providers, postCanaryIdentity, {
      now, trustedPublicKeys: signed.trustedPublicKeys,
    },
  ).ready, true)
})

test('signed attestation nonce is derived from immutable PASS evidence, never itself', () => {
  const { fixture, identity } = readyClosureFixture()
  const now = new Date('2026-08-23T12:00:00.000Z')
  const signed = externallyVerifiedRegistry(now, identity.runtimeIdentityHash)
  const attestation = signed.registry.providers.find(provider => provider.id === 'codex')
    .verificationAttestation
  attestation.activationNonce = 'attestation_chosen_nonce'
  signed.resign()
  const rejected = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    signed.registry, identity, {
      now, trustedPublicKeys: signed.trustedPublicKeys,
      evidenceBytes: jsonBytes(fixture.evidence),
    },
  )
  assert.equal(rejected.ready, false)
  assert.ok(rejected.blockers.includes('external-attestation-evidence-binding-mismatch'))
})

test('portable Codex executable environment is identity-bound while realpath is audit-only', () => {
  const fixture = closureFixture()
  const current = deriveFixture(fixture)
  const relocated = closureFixture()
  relocated.codexExecutable.realpath = 'D:\\portable\\codex.exe'
  relocated.evidence.evidence.codexExecutable.realpath = relocated.codexExecutable.realpath
  relocated.manifest.externalDependencies.find(dependency =>
    dependency.source === 'agents/contracts/codex-live-conformance-evidence.json').sha256 =
      sha256Bytes(jsonBytes(relocated.evidence))
  refreshManifest(relocated.manifest, relocated.providers)
  assert.equal(deriveFixture(relocated).runtimeIdentityHash, current.runtimeIdentityHash)
  for (const field of ['platform', 'arch', 'basename', 'sha256', 'version']) {
    const changed = closureFixture()
    changed.codexExecutable[field] = field === 'sha256' ? 'f'.repeat(64) : `${changed.codexExecutable[field]}-changed`
    assert.notEqual(deriveFixture(changed).runtimeIdentityHash, current.runtimeIdentityHash)
  }
})

test('Codex attestation schema permits only Ed25519 and SHA256 SPKI key ids', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'contracts', 'schemas', 'providers.schema.json'), 'utf8',
  ))
  const signature = schema.$defs.codexAttestation.allOf[1].properties.signature.properties
  assert.deepEqual(schema.$defs.codexAttestation.allOf[1].required, [
    'providerAdmissionSha256', 'supportedEnvironment',
  ])
  assert.deepEqual(signature.algorithm, { const: 'ed25519' })
  assert.deepEqual(signature.keyId, { pattern: '^[a-f0-9]{64}$' })
  assert.deepEqual(
    schema.$defs.attestation.properties.signature.properties.algorithm.enum,
    ['ed25519', 'ecdsa-p256-sha256'],
  )
  assert.deepEqual(
    shippedRegistry.attestationVerificationPolicy.acceptedAlgorithms,
    ['ed25519', 'ecdsa-p256-sha256'],
  )
  assert.deepEqual(
    shippedRegistry.verificationAttestationSchema.properties.signature.properties.algorithm.enum,
    ['ed25519', 'ecdsa-p256-sha256'],
  )
})

test('FAIL, fixture, wrong-canary, executable/environment drift, and ECDSA evidence never admit', () => {
  const now = new Date('2026-08-23T12:00:00.000Z')
  for (const mutation of [
    'FAIL', 'fixture', 'canary', 'executable', 'environment', 'environment-missing', 'ecdsa',
  ]) {
    const { fixture, identity } = readyClosureFixture()
    const nonce = canonicalEvidenceNonce(identity)
    const signed = externallyVerifiedRegistry(now, identity.runtimeIdentityHash, nonce)
    if (mutation === 'ecdsa') {
      signed.registry.providers.find(provider => provider.id === 'codex')
        .verificationAttestation.signature.algorithm = 'ecdsa-p256-sha256'
      signed.resign()
    } else if (mutation === 'environment') {
      signed.registry.providers.find(provider => provider.id === 'codex')
        .verificationAttestation.supportedEnvironment.arch = 'arm64'
      signed.resign()
    } else if (mutation === 'environment-missing') {
      delete signed.registry.providers.find(provider => provider.id === 'codex')
        .verificationAttestation.supportedEnvironment
      signed.resign()
    } else {
      if (mutation === 'FAIL') fixture.evidence.result = 'FAIL'
      if (mutation === 'fixture') fixture.evidence.fixtureOnly = true
      if (mutation === 'canary') fixture.evidence.evidence.canaryResult = 'FAIL'
      if (mutation === 'executable') fixture.evidence.evidence.codexExecutable.sha256 = 'f'.repeat(64)
      fixture.manifest.externalDependencies.find(dependency =>
        dependency.source === 'agents/contracts/codex-live-conformance-evidence.json').sha256 =
          sha256Bytes(jsonBytes(fixture.evidence))
      refreshManifest(fixture.manifest, fixture.providers)
    }
    const candidate = deriveFixture(fixture)
    const rejected = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
      signed.registry, candidate, { now, trustedPublicKeys: signed.trustedPublicKeys },
    )
    assert.equal(rejected.ready, false, mutation)
  }
})

test('raw providers, key-ring, and evidence tamper fails exact manifest dependency binding', () => {
  for (const field of ['providers', 'keyRing', 'evidence']) {
    const { fixture } = readyClosureFixture()
    if (field === 'providers') fixture.providers.verificationMarker = 'tamper'
    if (field === 'keyRing') fixture.keyRing.verificationMarker = 'tamper'
    if (field === 'evidence') fixture.evidence.verificationMarker = 'tamper'
    assert.throws(() => deriveFixture(fixture), /runtime identity input is invalid/, field)
  }
})
