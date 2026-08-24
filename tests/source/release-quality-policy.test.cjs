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
const QUALITY_GATE_PATH = path.join(ROOT, 'scripts', 'benchmark-evidence', 'quality-gate.cjs')
const POLICY_PATH = path.join(ROOT, 'scripts', 'benchmark-evidence', 'release-quality-policy.json')
const quality = require(QUALITY_GATE_PATH)
const H = 'a'.repeat(64)

function aggregateTrust() {
  const pair = crypto.generateKeyPairSync('ed25519')
  const signer = { privateKey: pair.privateKey, issuer: 'release-quality-test', keyId: 'release-quality-test-key' }
  const trustInput = {
    schemaVersion: 'benchmark-trust-registry.v2', catalogs: {}, roles: { aggregate: {
      issuer: signer.issuer, keyId: signer.keyId, algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', fixtureOnly: false,
    } },
  }
  return {
    signer,
    trustInput,
    trustRegistry: require('../../scripts/benchmark-evidence/trust-registry.cjs').createTrustRegistry(trustInput),
  }
}

function qualityInput(policy, treatmentAccepted = [true, true]) {
  return {
    schemaVersion: 'benchmark-paired-quality-evidence.v1', evidenceClass: 'controlled-effects', fixtureOnly: false,
    policy: { policyId: policy.policyId, policyDigest: policy.policyDigest },
    cohortId: 'release-quality-test-cohort', runManifestHash: H, issuedAt: '2026-08-24T12:00:00.000Z',
    pairs: treatmentAccepted.map((accepted, index) => ({
      pairId: `pair-${index + 1}`, taskId: `task-${index + 1}`, repetition: 1,
      baseline: { attemptId: `baseline-${index + 1}`, accepted: true, reward: 1, cost: 10, terminalState: 'PASS', snapshotHash: 'b'.repeat(64) },
      treatment: { attemptId: `treatment-${index + 1}`, accepted, reward: accepted ? 1 : 0, cost: 8, terminalState: accepted ? 'PASS' : 'FAIL', snapshotHash: 'c'.repeat(64) },
    })),
  }
}

test('release quality evidence is signed against the exact independent policy identity', () => {
  const policy = quality.loadReleaseQualityPolicy(POLICY_PATH)
  const { signer, trustRegistry } = aggregateTrust()
  const signed = quality.signPairedQualityEvidence(qualityInput(policy), signer, policy)
  const ready = quality.assertReleaseQualityReady({ qualityEvidence: signed, trustRegistry, qualityPolicy: policy })

  assert.equal(ready.ready, true)
  assert.equal(ready.policyId, policy.policyId)
  assert.equal(ready.policyDigest, policy.policyDigest)

  const evidenceOwnedThresholds = { ...qualityInput(policy), thresholds: { minimumAcceptanceRatio: 0, minimumRewardRatio: 0, maximumCostPerSolveRatio: 999 } }
  assert.throws(
    () => quality.signPairedQualityEvidence(evidenceOwnedThresholds, signer, policy),
    error => error.code === 'PAIRED_QUALITY_INVALID',
  )
})

test('a differently identified policy cannot authorize evidence for the canonical release policy', t => {
  const canonicalPolicy = quality.loadReleaseQualityPolicy(POLICY_PATH)
  const { signer, trustRegistry } = aggregateTrust()
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-release-policy-'))
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
  const alternatePath = path.join(temporaryRoot, 'policy.json')
  const alternate = {
    schemaVersion: 'benchmark-release-quality-policy.v1',
    policyId: 'alternate-release-policy',
    thresholds: { minimumAcceptanceRatio: 0, minimumRewardRatio: 0, maximumCostPerSolveRatio: 999 },
  }
  fs.writeFileSync(alternatePath, `${JSON.stringify(alternate)}\n`)
  const alternatePolicy = quality.loadReleaseQualityPolicy(alternatePath)
  const signed = quality.signPairedQualityEvidence(qualityInput(alternatePolicy), signer, alternatePolicy)

  assert.throws(
    () => quality.assertReleaseQualityReady({ qualityEvidence: signed, trustRegistry, qualityPolicy: canonicalPolicy }),
    error => error.code === 'PAIRED_QUALITY_POLICY_MISMATCH',
  )
})

test('conditional release quality CLI skips only when neither canonical signed input is supplied', () => {
  const env = { ...process.env }
  delete env.AUTOPROMPT_RELEASE_QUALITY_EVIDENCE_PATH
  delete env.AUTOPROMPT_RELEASE_QUALITY_TRUST_REGISTRY_PATH
  const skipped = childProcess.spawnSync(process.execPath, [QUALITY_GATE_PATH, '--policy', POLICY_PATH, '--if-supplied'], {
    cwd: ROOT, env, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(skipped.status, 0, skipped.stderr)
  assert.deepEqual(JSON.parse(skipped.stdout), {
    ready: false,
    skipped: true,
    reason: 'canonical-signed-evidence-not-supplied',
  })

  env.AUTOPROMPT_RELEASE_QUALITY_EVIDENCE_PATH = 'paired.json'
  const incomplete = childProcess.spawnSync(process.execPath, [QUALITY_GATE_PATH, '--policy', POLICY_PATH, '--if-supplied'], {
    cwd: ROOT, env, encoding: 'utf8', windowsHide: true,
  })
  assert.notEqual(incomplete.status, 0)
  assert.match(incomplete.stderr, /RELEASE_QUALITY_CONFIG_INVALID/)
})
