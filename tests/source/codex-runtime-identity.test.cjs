#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const identity = require('../../scripts/codex-runtime-identity.cjs')
const runtime = require('../../scripts/runtime-payload.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const H = value => identity.sha256(Buffer.from(value, 'utf8'))

function inputs() {
  const providers = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'contracts', 'providers.json'), 'utf8'))
  const providerBytes = Buffer.from(`${JSON.stringify(providers, null, 2)}\n`)
  const keyRing = {
    schemaVersion: '1.0.0', providerId: 'codex',
    keys: [{ algorithm: 'ed25519', format: 'spki-pem', keyId: 'a'.repeat(64),
      notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z',
      publicKeyPem: 'fixture-public-key', status: 'trusted' }],
  }
  const evidence = {
    schemaVersion: 'codex-live-conformance-evidence.v1', result: 'PASS', fixtureOnly: false,
    runtimeIdentityHash: 'b'.repeat(64), evidence: { canarySchema: 'codex-live-canary.v1', canaryResult: 'PASS' },
  }
  const keyBytes = Buffer.from(`${JSON.stringify(keyRing, null, 2)}\n`)
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)
  const manifest = {
    schemaVersion: 1,
    provider: 'codex',
    sourceRoot: 'agents/codex',
    files: ['SKILL.md'],
    sha256: { 'SKILL.md': H('skill') },
    contractVersion: '2.0.0',
    rolePolicy: 'agents/role-policy.json',
    logicalRoles: ['ap-worker'],
    entrypoints: ['workflow/phase-budget.js'],
    externalDependencies: [
      { source: identity.EVIDENCE_SOURCE, destination: 'skills/contracts/codex-live-conformance-evidence.json', sha256: H(evidenceBytes) },
      { source: identity.KEY_RING_SOURCE, destination: 'skills/contracts/codex-trusted-public-keys.json', sha256: H(keyBytes) },
      { source: identity.PROVIDERS_SOURCE, destination: 'skills/contracts/providers.json', sha256: H(providerBytes) },
    ],
    dynamicRequires: [],
    localRequireClosure: 'complete-declared-local-external-and-dynamic-requires',
    providerContractCoreSha256: identity.providerContractCoreSha256(providers),
  }
  const core = identity.deriveCodexDeployCore(manifest, { providerRegistry: providers })
  manifest.payloadDigest = core.payloadDigest
  manifest.payloadGeneration = core.payloadGeneration
  manifest.logicalToPhysicalProviderRole = {
    'ap-worker': `autoprompt-${core.payloadGeneration.replace(/[^a-z0-9]+/g, '-')}-ap-worker`,
  }
  manifest.physicalRoles = [manifest.logicalToPhysicalProviderRole['ap-worker']]
  manifest.embeddedReceipt = '.autoprompt-runtime-manifest.json'
  manifest.payloadClosureDigest = identity.codexPayloadClosureDigest(manifest)
  return { evidence, evidenceBytes, keyRing, keyBytes, manifest, providerBytes, providers }
}

function refreshRawBinding(state) {
  state.providerBytes = Buffer.from(`${JSON.stringify(state.providers, null, 2)}\n`)
  state.evidenceBytes = Buffer.from(`${JSON.stringify(state.evidence, null, 2)}\n`)
  state.keyBytes = Buffer.from(`${JSON.stringify(state.keyRing, null, 2)}\n`)
  const dependencies = new Map(state.manifest.externalDependencies.map(item => [item.source, item]))
  dependencies.get(identity.PROVIDERS_SOURCE).sha256 = H(state.providerBytes)
  dependencies.get(identity.KEY_RING_SOURCE).sha256 = H(state.keyBytes)
  dependencies.get(identity.EVIDENCE_SOURCE).sha256 = H(state.evidenceBytes)
  state.manifest.providerContractCoreSha256 = identity.providerContractCoreSha256(state.providers)
  const core = identity.deriveCodexDeployCore(state.manifest, { providerRegistry: state.providers })
  state.manifest.payloadDigest = core.payloadDigest
  state.manifest.payloadGeneration = core.payloadGeneration
  state.manifest.payloadClosureDigest = identity.codexPayloadClosureDigest(state.manifest)
  return core
}

test('Codex deploy-core generation is stable across attestation/evidence bytes and exact closure is not', () => {
  const base = inputs()
  const first = identity.deriveCodexDeployCore(base.manifest, { providerRegistry: base.providers })
  const firstClosure = base.manifest.payloadClosureDigest
  const codex = base.providers.providers.find(provider => provider.id === 'codex')
  codex.verificationAttestation = { fixture: 'changed-trust-envelope' }
  base.evidence.evidence.transcriptSha256 = 'c'.repeat(64)
  const second = refreshRawBinding(base)
  assert.equal(second.payloadDigest, first.payloadDigest)
  assert.equal(second.payloadGeneration, first.payloadGeneration)
  assert.notEqual(base.manifest.payloadClosureDigest, firstClosure)

  for (const field of [
    'implementationStatus', 'currentIsolationClass', 'defaultAdmission', 'capabilities',
    'safeDegradedBehavior', 'verificationRequired',
  ]) {
    const changed = inputs()
    const record = changed.providers.providers.find(provider => provider.id === 'codex')
    record[field] = field === 'capabilities'
      ? { ...(record[field] || {}), fixtureCapabilityTamper: 'verified' }
      : `${JSON.stringify(record[field])}-tampered`
    const changedCore = refreshRawBinding(changed)
    assert.notEqual(changedCore.payloadDigest, first.payloadDigest, field)
  }

  base.keyRing.keys[0].status = 'revoked'
  const keyChanged = refreshRawBinding(base)
  assert.notEqual(keyChanged.payloadDigest, first.payloadDigest, 'key-ring trust belongs to deploy core')

  base.providers.contractVersion = `${base.providers.contractVersion || '2.0.0'}-changed`
  const contractChanged = refreshRawBinding(base)
  assert.notEqual(contractChanged.payloadDigest, keyChanged.payloadDigest,
    'non-envelope provider contract changes must alter the deploy core')

  const policyChanged = inputs()
  policyChanged.providers.attestationVerificationPolicy.acceptedResult = 'degraded'
  const policyCore = refreshRawBinding(policyChanged)
  assert.notEqual(policyCore.payloadDigest, first.payloadDigest,
    'Codex-consumed global verification policy belongs to the deploy core')

  const otherProviderChanged = inputs()
  otherProviderChanged.providers.providers.push({ id: 'fixture-other-provider', capabilities: {} })
  const otherProviderCore = refreshRawBinding(otherProviderChanged)
  assert.equal(otherProviderCore.payloadDigest, first.payloadDigest,
    'non-Codex provider bodies are outside the Codex deploy core')
})

test('portable runtime identity binds exact raw trust bytes and keeps realpath audit-only', () => {
  const state = inputs()
  const executable = {
    realpath: 'C:\\Program Files\\Codex\\codex.exe', platform: 'win32', arch: 'x64',
    basename: 'codex.exe', sha256: 'd'.repeat(64), version: 'codex-cli 1.2.3',
  }
  const input = {
    runtimeManifestBytes: Buffer.from(`${JSON.stringify(state.manifest, null, 2)}\n`),
    providerRegistryBytes: state.providerBytes,
    trustedKeyRingBytes: state.keyBytes,
    evidenceBytes: state.evidenceBytes,
    codexConfigureBytes: Buffer.from('configure-runtime'),
    codexExecutable: executable,
  }
  const first = identity.deriveCodexRuntimeIdentity(input)
  const relocated = identity.deriveCodexRuntimeIdentity({
    ...input, codexExecutable: { ...executable, realpath: 'D:\\Portable\\codex.exe' },
  })
  assert.equal(relocated.runtimeIdentityHash, first.runtimeIdentityHash)
  assert.notEqual(relocated.codexExecutableRealpath, first.codexExecutableRealpath)
  assert.equal(first.identity.codexExecutablePlatform, 'win32')
  assert.equal(first.identity.codexExecutableBasename, 'codex.exe')
  assert.equal(first.identity.providerAdmissionSha256,
    identity.codexProviderAdmissionSha256(state.providers.providers.find(provider => provider.id === 'codex')))

  const tampered = Buffer.from(state.evidenceBytes)
  tampered[tampered.length - 2] ^= 1
  assert.throws(() => identity.deriveCodexRuntimeIdentity({ ...input, evidenceBytes: tampered }),
    /trust dependency binding|input is invalid|evidence is invalid/)
})

test('Codex package registry declares all trust materials fail-closed', () => {
  assert.deepEqual(runtime.CODEX_PACKAGE_REGISTRY.installation.trustArtifacts, [
    { source: identity.PROVIDERS_SOURCE, destination: 'skills/contracts/providers.json' },
    { source: identity.KEY_RING_SOURCE, destination: 'skills/contracts/codex-trusted-public-keys.json' },
    { source: identity.EVIDENCE_SOURCE, destination: 'skills/contracts/codex-live-conformance-evidence.json' },
  ])
  const dependencies = runtime.discoverCodexExternalRuntimeDependencies(ROOT)
  for (const source of [identity.PROVIDERS_SOURCE, identity.KEY_RING_SOURCE, identity.EVIDENCE_SOURCE]) {
    const dependency = dependencies.find(item => item.source === source)
    assert.ok(dependency, source)
    assert.ok(dependency.requiredBy.some(site => site.kind === 'trust-material'), source)
  }
})
