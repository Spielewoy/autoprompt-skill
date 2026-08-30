#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const artifact = require('../../scripts/codex-artifact.cjs')

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8', timeout: 120000, ...options,
  })
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function copyFixtureFile(root, destination, relative) {
  const source = path.join(root, ...relative.split('/'))
  const target = path.join(destination, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

function createExternallySignedReleaseFixture(sandbox) {
  const realConfigure = require('../../scripts/codex-configure.cjs')
  const runtimeIdentity = require('../../scripts/codex-runtime-identity.cjs')
  const router = require('../../agents/codex/workflow/router.js')
  const root = path.join(sandbox, 'signed-source')
  const manifest = structuredClone(require('../../agents/manifests/codex-runtime.json'))
  const explicit = [
    'packages/codex/package.json',
    'packages/codex/release.json',
    'packages/codex/release-history.json',
    'packages/codex/bin/autoprompt-codex.cjs',
    'scripts/install/codex-package-registry.json',
    'scripts/install/codex-discovery-shim.md',
    'scripts/install/legacy-codex-compat.json',
    'scripts/install/legacy-codex-role-hashes.json',
    'scripts/install/legacy-compat.cjs',
    'scripts/install/operation-lock.cjs',
    'scripts/runtime-payload.cjs',
    'scripts/codex-runtime-identity.cjs',
    'scripts/codex-configure.cjs',
    'scripts/codex-evidence-bundle.cjs',
    'scripts/codex-evidence/verification-bundle.cjs',
    'scripts/benchmark-evidence/core.cjs',
    'agents/manifests/codex-runtime.json',
  ]
  for (const relative of manifest.files) {
    copyFixtureFile(ROOT, root, `${manifest.sourceRoot}/${relative}`)
  }
  for (const dependency of manifest.externalDependencies) {
    copyFixtureFile(ROOT, root, dependency.source)
  }
  for (const relative of explicit) copyFixtureFile(ROOT, root, relative)

  const now = new Date('2026-08-24T12:00:00.000Z')
  const executable = Object.freeze({
    realpath: path.join(root, 'external-verifier', 'codex-fixture'),
    platform: process.platform,
    arch: process.arch,
    basename: process.platform === 'win32' ? 'codex.exe' : 'codex',
    sha256: 'e'.repeat(64),
    version: 'codex-cli externally-verified-fixture',
  })
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })
  const keyId = sha256(publicKeyDer)
  const keyRing = {
    schemaVersion: '1.0.0',
    providerId: 'codex',
    keys: [{
      algorithm: 'ed25519',
      format: 'spki-pem',
      keyId,
      notBefore: '2026-08-23T00:00:00.000Z',
      notAfter: '2026-08-26T00:00:00.000Z',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      status: 'trusted',
    }],
  }
  const registryPath = path.join(root, 'agents', 'contracts', 'providers.json')
  const evidencePath = path.join(
    root, 'agents', 'contracts', 'codex-live-conformance-evidence.json')
  const keyRingPath = path.join(
    root, 'agents', 'contracts', 'codex-trusted-public-keys.json')
  const manifestPath = path.join(root, 'agents', 'manifests', 'codex-runtime.json')
  const configurePath = path.join(root, 'scripts', 'codex-configure.cjs')
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  const provider = registry.providers.find(candidate => candidate.id === 'codex')
  provider.verificationAttestation = null
  const evidence = {
    evidence: {
      canaryResult: 'PASS',
      canarySchema: 'codex-live-canary.v1',
      codexExecutable: executable,
      providerAdmission: {
        verifiedCapabilities: ['isolation', 'privateSkillRoot', 'processOwnership'],
        verifiedCapabilitiesExact: true,
      },
      providerId: 'codex',
      result: 'PASS',
      schemaVersion: 'codex-live-conformance-observation.v1',
    },
    fixtureOnly: false,
    result: 'PASS',
    runtimeIdentityHash: '0'.repeat(64),
    schemaVersion: 'codex-live-conformance-evidence.v1',
  }
  writeJson(keyRingPath, keyRing)
  writeJson(registryPath, registry)
  writeJson(evidencePath, evidence)

  const refreshManifest = () => {
    for (const relative of manifest.files) {
      manifest.sha256[relative] = sha256(fs.readFileSync(path.join(
        root, ...manifest.sourceRoot.split('/'), ...relative.split('/'))))
    }
    for (const dependency of manifest.externalDependencies) {
      dependency.sha256 = sha256(fs.readFileSync(path.join(root, ...dependency.source.split('/'))))
    }
    const deployCore = runtimeIdentity.deriveCodexDeployCore(manifest, {
      providerRegistry: JSON.parse(fs.readFileSync(registryPath, 'utf8')),
    })
    manifest.payloadDigest = deployCore.payloadDigest
    manifest.payloadGeneration = deployCore.payloadGeneration
    manifest.providerContractCoreSha256 = deployCore.providerContractCoreSha256
    const generationSlug = manifest.payloadGeneration.replace(/[^a-z0-9]+/g, '-')
    manifest.logicalToPhysicalProviderRole = Object.fromEntries(manifest.logicalRoles.map(role => [
      role, `autoprompt-${generationSlug}-${role}`,
    ]))
    manifest.physicalRoles = Object.values(manifest.logicalToPhysicalProviderRole).sort()
    manifest.payloadClosureDigest = runtimeIdentity.codexPayloadClosureDigest(manifest)
    writeJson(manifestPath, manifest)
  }
  refreshManifest()

  const deriveIdentity = () => runtimeIdentity.deriveCodexRuntimeIdentity({
    runtimeManifestBytes: fs.readFileSync(manifestPath),
    providerRegistryBytes: fs.readFileSync(registryPath),
    trustedKeyRingBytes: fs.readFileSync(keyRingPath),
    evidenceBytes: fs.readFileSync(evidencePath),
    codexConfigureBytes: fs.readFileSync(configurePath),
    codexExecutable: executable,
    contractVersion: '2.0.0',
  })
  const unsignedIdentity = deriveIdentity()
  evidence.runtimeIdentityHash = unsignedIdentity.runtimeIdentityHash
  writeJson(evidencePath, evidence)
  const evidenceNonce = Buffer.from(sha256(Buffer.from(
    realConfigure.stableJsonV1(evidence), 'utf8')), 'hex').toString('base64url')
  const verifiedCapabilities = Object.entries(provider.capabilities)
    .filter(([, value]) => value === 'supported')
    .map(([capability]) => capability)
    .sort()
  provider.verificationAttestation = {
    schemaVersion: '2.0.0',
    attestationId: 'attestation:codex:external-release-fixture',
    providerId: 'codex',
    issuer: 'independent-codex-conformance-fixture',
    issuedAt: '2026-08-24T11:59:00.000Z',
    expiresAt: '2026-08-25T12:00:00.000Z',
    signature: { algorithm: 'ed25519', keyId, value: 'A'.repeat(86) },
    runtimeIdentityHash: unsignedIdentity.runtimeIdentityHash,
    activationNonce: evidenceNonce,
    providerAdmissionSha256: runtimeIdentity.codexProviderAdmissionSha256(provider),
    supportedEnvironment: {
      platform: executable.platform,
      arch: executable.arch,
      codexExecutableBasename: executable.basename,
      codexExecutableSha256: executable.sha256,
      codexExecutableVersion: executable.version,
    },
    verificationMethod: 'live-conformance-suite',
    verifiedCapabilities,
    result: 'supported',
  }
  provider.verificationAttestation.signature.value = crypto.sign(
    null, router.attestationSignedPayload(provider.verificationAttestation), privateKey,
  ).toString('base64url')
  writeJson(registryPath, registry)
  refreshManifest()
  const signedIdentity = deriveIdentity()
  assert.equal(signedIdentity.runtimeIdentityHash, unsignedIdentity.runtimeIdentityHash,
    'trust-envelope fixture must preserve its signed runtime identity')

  const historyPath = path.join(root, 'packages', 'codex', 'release-history.json')
  const releasePath = path.join(root, 'packages', 'codex', 'release.json')
  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
  const head = history.releases.at(-1)
  head.payloadGeneration = manifest.payloadGeneration
  head.payloadDigest = manifest.payloadDigest
  head.recordDigest = artifact.releaseRecordDigest(head)
  writeJson(historyPath, history)
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
  delete release.packedBytes
  delete release.fileCount
  delete release.externalDependencyCount
  release.payloadGeneration = manifest.payloadGeneration
  release.payloadDigest = manifest.payloadDigest
  release.historyHeadDigest = head.recordDigest
  writeJson(releasePath, release)

  const configure = {
    stableJsonV1: realConfigure.stableJsonV1,
    deriveCurrentCodexRuntimeIdentity: deriveIdentity,
    loadReleaseCodexTrustedPublicKeys: options =>
      realConfigure.loadReleaseCodexTrustedPublicKeys(options),
    evaluateCanonicalCodexCapabilityTrustAgainstIdentity:
      realConfigure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity,
  }
  return { configure, keyId, now, root }
}

test('Codex final artifact gate accepts only current externally signed PASS evidence', () => {
  assert.throws(() => artifact.assertCanonicalReleaseTrust(ROOT),
    /release trust|manifest|attestation|evidence/i)
  for (const blocker of [
    'external-attestation-missing', 'canonical-live-evidence-invalid',
    'external-attestation-unverified', 'external-attestation-runtime-identity-mismatch',
    'external-attestation-evidence-binding-mismatch', 'provider-trusted-key-ring-invalid',
    'external-attestation-expired', 'candidate-runtime-manifest-stale',
  ]) {
    const configure = {
      deriveCurrentCodexRuntimeIdentity: () => ({ runtimeIdentityHash: 'a'.repeat(64) }),
      loadReleaseCodexTrustedPublicKeys: () => ({}),
      evaluateCanonicalCodexCapabilityTrustAgainstIdentity: () => ({ ready: false, blockers: [blocker] }),
    }
    assert.throws(() => artifact.assertCanonicalReleaseTrust(ROOT, { configure }),
      new RegExp(blocker))
  }
  const configure = {
    deriveCurrentCodexRuntimeIdentity: () => ({ runtimeIdentityHash: 'a'.repeat(64) }),
    loadReleaseCodexTrustedPublicKeys: () => ({ trusted: true }),
    evaluateCanonicalCodexCapabilityTrustAgainstIdentity: () => ({ ready: true, blockers: [] }),
  }
  assert.equal(artifact.assertCanonicalReleaseTrust(ROOT, { configure }).ready, true)
})

test('Codex conformance-only staging preserves canonical unsigned FAIL evidence and remains unpublishable', t => {
  const realConfigure = require('../../scripts/codex-configure.cjs')
  const configure = {
    stableJsonV1: realConfigure.stableJsonV1,
    deriveCurrentCodexRuntimeIdentity: () => ({
      providerAdmissionSha256: '70921cc6f09b742f31766a915d8a9ea30aaa267576e276b6e6081e6db74dd222',
      providerContractCoreSha256: '5750d35c00d98503e6dbb11459ab4c1baba22ccf5dd56da41e3cdda14fca3745',
      runtimeIdentityHash: 'a'.repeat(64),
    }),
    loadReleaseCodexTrustedPublicKeys: () => ({ ['2'.repeat(64)]: { type: 'public' } }),
    evaluateCanonicalCodexCapabilityTrustAgainstIdentity: () => ({
      ready: false,
      blockers: ['canonical-live-evidence-invalid', 'external-attestation-missing'],
    }),
  }
  const identity = {
    codexProviderAdmissionSha256: () =>
      '70921cc6f09b742f31766a915d8a9ea30aaa267576e276b6e6081e6db74dd222',
    providerContractCoreSha256: () =>
      '5750d35c00d98503e6dbb11459ab4c1baba22ccf5dd56da41e3cdda14fca3745',
  }
  const result = artifact.assertConformanceOnlyTrust(ROOT, { configure, identity })
  assert.equal(result.refusal.ready, false)
  assert.equal(result.evidenceResult, 'FAIL')
  const evidenceBytes = fs.readFileSync(path.join(
    ROOT, 'agents', 'contracts', 'codex-live-conformance-evidence.json'))
  const evidence = JSON.parse(evidenceBytes)
  assert.deepEqual(evidence.publicProjection, {
    policy: 'codex-public-fail-evidence.v1',
    sourceEvidenceSha256: '2e24eda37043240b3cf3a008e6a3c628d87653741b21e38d4947d54955e01c59',
  })
  assert.deepEqual(evidence.evidence.providerAdmission, {
    verifiedCapabilities: [], verifiedCapabilitiesExact: false,
  })
  assert.equal(result.evidenceSha256,
    crypto.createHash('sha256').update(evidenceBytes).digest('hex'))
  assert.equal(result.evidenceActivationNonce,
    crypto.createHash('sha256').update(evidenceBytes).digest('base64url'))
  assert.equal(result.evidenceRuntimeIdentityHash, evidence.runtimeIdentityHash)
  assert.deepEqual(artifact.parse(['--stage', 'candidate', '--conformance-only']), {
    action: 'stage', destination: path.resolve('candidate'), conformanceOnly: true,
  })
  const acceptingConfigure = {
    ...configure,
    evaluateCanonicalCodexCapabilityTrustAgainstIdentity: () => ({ ready: true, blockers: [] }),
  }
  assert.throws(() => artifact.assertConformanceOnlyTrust(ROOT, {
    configure: acceptingConfigure, identity,
  }), /did not remain fail-closed/)

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-conformance-stage-'))
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }))
  artifact.stageArtifact(destination, ROOT, {
    conformanceOnly: true, configure, identity,
  })
  const packageRecord = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'))
  const marker = JSON.parse(fs.readFileSync(
    path.join(destination, '.autoprompt-conformance-only.json'), 'utf8',
  ))
  assert.equal(packageRecord.private, true)
  assert.equal(packageRecord.bin, undefined)
  assert.equal(packageRecord.autoprompt.conformanceOnly, true)
  assert.deepEqual(marker, {
    schemaVersion: 2, publishable: false, installable: false,
    evidenceResult: 'FAIL',
    evidenceSha256: result.evidenceSha256,
    evidenceActivationNonce: result.evidenceActivationNonce,
    evidenceRuntimeIdentityHash: evidence.runtimeIdentityHash,
    currentRuntimeIdentityHash: 'a'.repeat(64),
  })
  assert.equal(fs.existsSync(path.join(destination, 'bin', 'autoprompt-codex.cjs')), false)
  const stagedEvidence = fs.readFileSync(path.join(
    destination, 'agents', 'contracts', 'codex-live-conformance-evidence.json'))
  assert.equal(stagedEvidence.equals(evidenceBytes), true)
  assert.doesNotMatch(stagedEvidence.toString('utf8'),
    /[A-Za-z]:[\\/]|\b(?:pid|pids|sessionId|threadId|argv|credential|transcript|telemetry)\b/i)
  for (const relative of [
    'scripts/install/operation-lock.cjs',
    'scripts/install/legacy-compat.cjs',
    'scripts/install/legacy-codex-compat.json',
    'scripts/install/legacy-codex-role-hashes.json',
  ]) assert.equal(fs.existsSync(path.join(destination, ...relative.split('/'))), true, relative)

  const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-unsafe-conformance-'))
  t.after(() => fs.rmSync(unsafeRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(unsafeRoot, 'agents', 'contracts'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'agents', 'contracts', 'providers.json'),
    path.join(unsafeRoot, 'agents', 'contracts', 'providers.json'))
  fs.writeFileSync(
    path.join(unsafeRoot, 'agents', 'contracts', 'codex-live-conformance-evidence.json'),
    JSON.stringify({ ...evidence, execution: { launchedPids: [12345] } }),
  )
  assert.throws(() => artifact.assertConformanceOnlyTrust(unsafeRoot, { configure, identity }),
    /privacy-safe FAIL projection/)
})

test('Codex artifact release binding rejects payload digest reuse under one version', t => {
  artifact.checkRelease(ROOT)
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-release-guard-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  for (const relative of [
    'packages/codex/package.json',
    'packages/codex/release.json',
    'packages/codex/release-history.json',
    'scripts/install/codex-package-registry.json',
    'agents/codex/VERSION',
    'agents/manifests/codex-runtime.json',
  ]) {
    const source = path.join(ROOT, ...relative.split('/'))
    const target = path.join(sandbox, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
  const manifestPath = path.join(sandbox, 'agents', 'manifests', 'codex-runtime.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.payloadDigest = manifest.payloadDigest === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  assert.throws(
    () => artifact.checkRelease(sandbox),
    /payloadDigest/,
    'changed packed bytes must require a new Codex artifact version/release record',
  )
})

test('Codex local release history rejects version reuse and historical mutation', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-release-history-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  for (const relative of [
    'packages/codex/package.json', 'packages/codex/release.json',
    'packages/codex/release-history.json', 'scripts/install/codex-package-registry.json',
    'agents/codex/VERSION', 'agents/manifests/codex-runtime.json',
  ]) {
    const source = path.join(ROOT, ...relative.split('/'))
    const target = path.join(sandbox, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
  const historyPath = path.join(sandbox, 'packages', 'codex', 'release-history.json')
  const original = fs.readFileSync(historyPath)
  const reused = JSON.parse(original)
  reused.releases[1].version = reused.releases[0].version
  fs.writeFileSync(historyPath, `${JSON.stringify(reused, null, 2)}\n`)
  assert.throws(() => artifact.checkRelease(sandbox), /version reused/)

  const mutated = JSON.parse(original)
  mutated.releases[0].payloadDigest = 'f'.repeat(64)
  fs.writeFileSync(historyPath, `${JSON.stringify(mutated, null, 2)}\n`)
  assert.throws(() => artifact.checkRelease(sandbox), /history record was mutated|codex-v2\.0\.0/)
})

test('Codex source template is directly unpublishable and canonical FAIL/null cannot promote it', t => {
  const packageTemplate = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'packages', 'codex', 'package.json'), 'utf8'))
  assert.equal(packageTemplate.private, true)
  const unreleased = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'packages', 'codex', 'release.json'), 'utf8'))
  for (const field of ['packedBytes', 'fileCount', 'externalDependencyCount']) {
    assert.equal(Object.prototype.hasOwnProperty.call(unreleased, field), false,
      `${field} must remain absent until a signed PASS tarball is reopened`)
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-private-template-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const destination = path.join(sandbox, 'publishable-stage')
  assert.throws(() => artifact.stageArtifact(destination, ROOT),
    /release trust|canonical-live-evidence-invalid|external-attestation-missing/i)
  assert.equal(fs.existsSync(destination), false,
    'failed canonical promotion must not create a publishable destination')
})

test('Codex staging refuses stale destinations and source symlinks, and excludes untracked source files', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-stage-hardening-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const fixture = createExternallySignedReleaseFixture(sandbox)
  const trust = { configure: fixture.configure, now: fixture.now }
  const staleStage = path.join(sandbox, 'stale-stage')
  fs.mkdirSync(staleStage)
  fs.writeFileSync(path.join(staleStage, 'foreign.txt'), 'must survive\n')
  assert.throws(() => artifact.stageArtifact(staleStage, fixture.root, trust),
    /destination must be empty/)
  assert.equal(fs.readFileSync(path.join(staleStage, 'foreign.txt'), 'utf8'), 'must survive\n')
  const stalePack = path.join(sandbox, 'stale-pack')
  fs.mkdirSync(stalePack)
  fs.writeFileSync(path.join(stalePack, 'old.tgz'), 'stale\n')
  const releaseBeforeRejectedPack = fs.readFileSync(
    path.join(fixture.root, 'packages', 'codex', 'release.json'))
  assert.throws(() => artifact.packArtifact(stalePack, fixture.root, trust),
    /destination must be empty/)
  assert.equal(fs.readFileSync(path.join(stalePack, 'old.tgz'), 'utf8'), 'stale\n')
  assert.equal(fs.readFileSync(
    path.join(fixture.root, 'packages', 'codex', 'release.json'))
    .equals(releaseBeforeRejectedPack), true)

  const extra = path.join(fixture.root, 'agents', 'codex', 'untracked-release-secret.txt')
  fs.writeFileSync(extra, 'never stage me\n')
  const cleanStage = path.join(sandbox, 'clean-stage')
  artifact.stageArtifact(cleanStage, fixture.root, trust)
  assert.equal(fs.existsSync(path.join(cleanStage, 'agents', 'codex', path.basename(extra))), false)
  const inventory = artifact.validateArtifactInventory(cleanStage)
  assert.equal(inventory.files.some(entry => entry.path.endsWith(path.basename(extra))), false)

  const declaredSource = path.join(fixture.root, 'agents', 'codex', 'SKILL.md')
  const declaredBytes = fs.readFileSync(declaredSource)
  fs.appendFileSync(declaredSource, '\nstale source mutation\n')
  const staleSourceDestination = path.join(sandbox, 'stale-source-stage')
  assert.throws(() => artifact.stageArtifact(staleSourceDestination, fixture.root, trust),
    /declared source hash is stale/)
  assert.equal(fs.existsSync(staleSourceDestination), false)
  fs.writeFileSync(declaredSource, declaredBytes)

  const frameworks = path.join(fixture.root, 'agents', 'codex', 'frameworks')
  const linkedFrameworks = path.join(sandbox, 'linked-frameworks')
  fs.cpSync(frameworks, linkedFrameworks, { recursive: true })
  fs.rmSync(frameworks, { recursive: true, force: true })
  fs.symlinkSync(linkedFrameworks, frameworks, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => artifact.stageArtifact(
    path.join(sandbox, 'symlink-stage'), fixture.root, trust,
  ), /must not traverse a symlink/)
})

test('independent Codex artifact uses a hermetic externally signed PASS fixture for packed lifecycle', {
  timeout: 180000,
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-artifact-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const fixture = createExternallySignedReleaseFixture(sandbox)
  const output = path.join(sandbox, 'pack')
  const extracted = path.join(sandbox, 'extracted')
  const activationRoot = path.join(sandbox, 'activation')
  fs.mkdirSync(output)
  fs.mkdirSync(extracted)
  fs.mkdirSync(activationRoot)
  fs.writeFileSync(path.join(fixture.root, 'agents', 'codex', 'untracked-pack-file.txt'),
    'must not enter tarball\n')
  const packed = artifact.packArtifact(output, fixture.root, {
    configure: fixture.configure,
    now: fixture.now,
  })
  assert.equal(packed.name, '@autoprompt-skill/codex-runtime')
  assert.equal(packed.version, fs.readFileSync(
    path.join(fixture.root, 'agents', 'codex', 'VERSION'), 'utf8').trim())
  assert.ok(packed.packedBytes > 0)
  assert.ok(packed.fileCount > 0)
  assert.equal(packed.externalDependencyCount, JSON.parse(fs.readFileSync(
    path.join(fixture.root, 'agents', 'manifests', 'codex-runtime.json'), 'utf8',
  )).externalDependencies.length)
  assert.match(packed.tarballSha256, /^[a-f0-9]{64}$/)
  assert.match(packed.inventorySha256, /^[a-f0-9]{64}$/)
  assert.equal(sha256(fs.readFileSync(packed.tarball)), packed.tarballSha256)
  t.diagnostic(JSON.stringify({
    packedBytes: packed.packedBytes,
    fileCount: packed.fileCount,
    externalDependencyCount: packed.externalDependencyCount,
    inventorySha256: packed.inventorySha256,
    tarballSha256: packed.tarballSha256,
  }))
  const measuredRelease = JSON.parse(fs.readFileSync(
    path.join(fixture.root, 'packages', 'codex', 'release.json'), 'utf8'))
  assert.deepEqual({
    packedBytes: measuredRelease.packedBytes,
    fileCount: measuredRelease.fileCount,
    externalDependencyCount: measuredRelease.externalDependencyCount,
  }, {
    packedBytes: packed.packedBytes,
    fileCount: packed.fileCount,
    externalDependencyCount: packed.externalDependencyCount,
  })
  assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'packages', 'codex'))
    .filter(name => /^\.release\.json\..+\.tmp$/.test(name)), [],
  'atomic measurement commit must not leave a temporary release record')

  const unpacked = run('tar', ['-xf', packed.tarball, '-C', extracted])
  assert.equal(unpacked.status, 0, unpacked.stderr)
  const packageRoot = path.join(extracted, 'package')
  const files = artifact.listFiles(packageRoot)
  assert.equal(packed.fileCount, files.length)
  assert.equal(fs.existsSync(path.join(
    packageRoot, 'agents', 'codex', 'untracked-pack-file.txt')), false)
  const allowed = file => file === 'package.json' ||
    file === 'artifact-inventory.json' ||
    file === 'bin/autoprompt-codex.cjs' ||
    file === 'scripts/runtime-payload.cjs' ||
    file === 'scripts/codex-runtime-identity.cjs' ||
    file === 'scripts/codex-configure.cjs' ||
    file === 'scripts/local-only-safety.cjs' ||
    file === 'scripts/codex-evidence-bundle.cjs' ||
    file.startsWith('scripts/codex-evidence/') ||
    file === 'scripts/benchmark-evidence/core.cjs' ||
    file === 'release-history.json' ||
    file.startsWith('scripts/install/') ||
    file === 'agents/manifests/codex-runtime.json' ||
    file.startsWith('agents/codex/') ||
    file.startsWith('agents/contracts/')
  assert.equal(files.every(allowed), true, files.filter(file => !allowed).join('\n'))
  for (const provider of [
    'claude', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'reasonix',
  ]) {
    assert.equal(files.some(file => file.startsWith(`agents/${provider}/`)), false, provider)
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.private, undefined)
  assert.equal(packageJson.dependencies, undefined)
  assert.equal(packageJson.optionalDependencies, undefined)
  assert.deepEqual(files, ['package.json', ...packageJson.files].sort())
  assert.equal(packageJson.bin['autoprompt-codex-evidence'], 'scripts/codex-evidence-bundle.cjs')
  assert.equal(packageJson.autoprompt.provider, 'codex')
  assert.deepEqual(packageJson.autoprompt.compatibility,
    { codexCli: '>=0.148.0', runtimeContract: '2.0.0' })
  assert.match(packageJson.autoprompt.payloadDigest, /^[a-f0-9]{64}$/)
  assert.match(packageJson.autoprompt.payloadGeneration, /^codex-v2\.0\.0-[a-f0-9]{16}$/)
  assert.equal(artifact.validateArtifactInventory(packageRoot).inventorySha256,
    packed.inventorySha256)
  assert.doesNotThrow(() => require(path.join(packageRoot, 'scripts', 'codex-evidence', 'verification-bundle.cjs')))
  assert.doesNotThrow(() => require(path.join(packageRoot, 'scripts', 'codex-runtime-identity.cjs')))
  assert.doesNotThrow(() => require(path.join(packageRoot, 'scripts', 'runtime-payload.cjs')))

  const cli = path.join(packageRoot, 'bin', 'autoprompt-codex.cjs')
  const installed = run(process.execPath, [cli, 'install', '--root', activationRoot])
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
  const verified = run(process.execPath, [cli, 'verify', '--root', activationRoot])
  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`)
  const removed = run(process.execPath, [cli, 'uninstall', '--root', activationRoot])
  assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
  assert.deepEqual(JSON.parse(removed.stdout).retained, [])
})
