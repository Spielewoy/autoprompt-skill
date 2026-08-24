#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { digestRecord, exactKeys, fail, hashPattern, isoDate, nonEmpty } = require('./core.cjs')
const { loadTrustRegistry, requireRoleDigest, signRoleDigest } = require('./trust-registry.cjs')

const TERMINALS = Object.freeze(['PASS', 'FAIL'])
const POLICY_SCHEMA = 'benchmark-release-quality-policy.v1'
const EVIDENCE_ENV = 'AUTOPROMPT_RELEASE_QUALITY_EVIDENCE_PATH'
const TRUST_REGISTRY_ENV = 'AUTOPROMPT_RELEASE_QUALITY_TRUST_REGISTRY_PATH'

function normalizeReleaseQualityPolicy(input) {
  const hasDigest = input && Object.hasOwn(input, 'policyDigest')
  exactKeys(
    input,
    hasDigest ? ['schemaVersion', 'policyId', 'thresholds', 'policyDigest'] : ['schemaVersion', 'policyId', 'thresholds'],
    'RELEASE_QUALITY_POLICY_INVALID',
    'release quality policy',
  )
  if (input.schemaVersion !== POLICY_SCHEMA) fail('RELEASE_QUALITY_POLICY_INVALID', 'unsupported release quality policy schema')
  nonEmpty(input.policyId, 'RELEASE_QUALITY_POLICY_INVALID', 'policyId')
  exactKeys(input.thresholds, ['minimumAcceptanceRatio', 'minimumRewardRatio', 'maximumCostPerSolveRatio'], 'RELEASE_QUALITY_POLICY_INVALID', 'quality policy thresholds')
  for (const field of ['minimumAcceptanceRatio', 'minimumRewardRatio', 'maximumCostPerSolveRatio']) {
    const value = input.thresholds[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('RELEASE_QUALITY_POLICY_INVALID', `invalid policy threshold: ${field}`)
  }
  const unsigned = { schemaVersion: input.schemaVersion, policyId: input.policyId, thresholds: input.thresholds }
  const policyDigest = digestRecord(unsigned)
  if (hasDigest && input.policyDigest !== policyDigest) fail('RELEASE_QUALITY_POLICY_INVALID', 'release quality policy digest is invalid')
  return Object.freeze({ ...unsigned, thresholds: Object.freeze({ ...input.thresholds }), policyDigest })
}

function loadReleaseQualityPolicy(filename) {
  let input
  try { input = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
    fail('RELEASE_QUALITY_POLICY_INVALID', 'cannot read release quality policy', { cause: error.message })
  }
  return normalizeReleaseQualityPolicy(input)
}

function validateAttempt(attempt, label) {
  exactKeys(attempt, ['attemptId', 'accepted', 'reward', 'cost', 'terminalState', 'snapshotHash'], 'PAIRED_QUALITY_INVALID', label)
  nonEmpty(attempt.attemptId, 'PAIRED_QUALITY_INVALID', `${label}.attemptId`)
  if (typeof attempt.accepted !== 'boolean' || typeof attempt.reward !== 'number' || !Number.isFinite(attempt.reward) || attempt.reward < 0 ||
      typeof attempt.cost !== 'number' || !Number.isFinite(attempt.cost) || attempt.cost < 0 || !TERMINALS.includes(attempt.terminalState) || !hashPattern(attempt.snapshotHash)) fail('PAIRED_QUALITY_INVALID', `${label} is not a complete scorable terminal observation`)
}

function requirePolicyIdentity(reference, qualityPolicy) {
  exactKeys(reference, ['policyId', 'policyDigest'], 'PAIRED_QUALITY_INVALID', 'paired quality policy identity')
  nonEmpty(reference.policyId, 'PAIRED_QUALITY_INVALID', 'policy.policyId')
  if (!hashPattern(reference.policyDigest)) fail('PAIRED_QUALITY_INVALID', 'policy.policyDigest must be a SHA-256 digest')
  const policy = normalizeReleaseQualityPolicy(qualityPolicy)
  if (reference.policyId !== policy.policyId || reference.policyDigest !== policy.policyDigest) {
    fail('PAIRED_QUALITY_POLICY_MISMATCH', 'paired evidence does not name the exact release quality policy', {
      actual: reference,
      expected: { policyId: policy.policyId, policyDigest: policy.policyDigest },
    })
  }
  return policy
}

function validateUnsigned(record, qualityPolicy) {
  exactKeys(record, ['schemaVersion', 'evidenceClass', 'fixtureOnly', 'policy', 'cohortId', 'runManifestHash', 'issuedAt', 'pairs'], 'PAIRED_QUALITY_INVALID', 'paired quality evidence')
  if (record.schemaVersion !== 'benchmark-paired-quality-evidence.v1' || record.evidenceClass !== 'controlled-effects' || record.fixtureOnly !== false) fail('PAIRED_QUALITY_INVALID', 'release evidence must be non-fixture controlled-effects evidence')
  const policy = requirePolicyIdentity(record.policy, qualityPolicy)
  nonEmpty(record.cohortId, 'PAIRED_QUALITY_INVALID', 'cohortId')
  isoDate(record.issuedAt, 'PAIRED_QUALITY_INVALID', 'issuedAt')
  if (!hashPattern(record.runManifestHash) || !Array.isArray(record.pairs) || record.pairs.length < 2) fail('PAIRED_QUALITY_INVALID', 'paired evidence requires a signed manifest and at least two pairs')
  const ids = new Set()
  for (const pair of record.pairs) {
    exactKeys(pair, ['pairId', 'taskId', 'repetition', 'baseline', 'treatment'], 'PAIRED_QUALITY_INVALID', 'quality pair')
    for (const field of ['pairId', 'taskId']) nonEmpty(pair[field], 'PAIRED_QUALITY_INVALID', field)
    if (ids.has(pair.pairId) || !Number.isSafeInteger(pair.repetition) || pair.repetition < 1) fail('PAIRED_QUALITY_INVALID', 'quality pairs must be unique and preregistered')
    ids.add(pair.pairId)
    validateAttempt(pair.baseline, `${pair.pairId}.baseline`)
    validateAttempt(pair.treatment, `${pair.pairId}.treatment`)
    if (pair.baseline.attemptId === pair.treatment.attemptId) fail('PAIRED_QUALITY_INVALID', 'paired arms must use distinct attempts')
  }
  return policy
}

function signPairedQualityEvidence(input, signer, qualityPolicy) {
  validateUnsigned(input, qualityPolicy)
  const recordDigest = digestRecord(input)
  return Object.freeze({ ...input, recordDigest, signature: signRoleDigest('aggregate', recordDigest, input.issuedAt, signer) })
}

function evaluatePairedQualityEvidence(record, trustRegistry, qualityPolicy) {
  exactKeys(record, ['schemaVersion', 'evidenceClass', 'fixtureOnly', 'policy', 'cohortId', 'runManifestHash', 'issuedAt', 'pairs', 'recordDigest', 'signature'], 'PAIRED_QUALITY_INVALID', 'signed paired quality evidence')
  const unsigned = { ...record }
  delete unsigned.recordDigest
  delete unsigned.signature
  const policy = validateUnsigned(unsigned, qualityPolicy)
  if (!hashPattern(record.recordDigest) || record.recordDigest !== digestRecord(unsigned)) fail('PAIRED_QUALITY_DIGEST_INVALID', 'paired quality evidence digest is invalid')
  const trusted = requireRoleDigest(trustRegistry, 'aggregate', record.recordDigest, record.issuedAt, record.signature, 'PAIRED_QUALITY_SIGNATURE_INVALID')
  if (trusted.fixtureOnly) fail('PAIRED_QUALITY_FIXTURE_TRUST', 'fixture-only aggregate trust cannot authorize a release')
  const totals = arm => record.pairs.reduce((sum, pair) => ({
    completed: sum.completed + 1,
    accepted: sum.accepted + Number(pair[arm].accepted),
    reward: sum.reward + pair[arm].reward,
    cost: sum.cost + pair[arm].cost,
  }), { completed: 0, accepted: 0, reward: 0, cost: 0 })
  const baseline = totals('baseline')
  const treatment = totals('treatment')
  if (baseline.accepted === 0 || treatment.accepted === 0 || baseline.reward === 0) fail('PAIRED_QUALITY_UNSCORABLE', 'acceptance, reward, and cost-per-solve denominators must be non-zero')
  const acceptanceRatio = (treatment.accepted / treatment.completed) / (baseline.accepted / baseline.completed)
  const rewardRatio = (treatment.reward / treatment.completed) / (baseline.reward / baseline.completed)
  const costPerSolveRatio = (treatment.cost / treatment.accepted) / (baseline.cost / baseline.accepted)
  const verdict = {
    acceptanceNonInferior: acceptanceRatio >= policy.thresholds.minimumAcceptanceRatio,
    rewardNonInferior: rewardRatio >= policy.thresholds.minimumRewardRatio,
    costPerSolveWithinGuardrail: costPerSolveRatio <= policy.thresholds.maximumCostPerSolveRatio,
  }
  return Object.freeze({
    ...verdict,
    releaseEligible: Object.values(verdict).every(Boolean),
    ratios: Object.freeze({ acceptanceRatio, rewardRatio, costPerSolveRatio }),
    evidenceDigest: record.recordDigest,
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
  })
}

function assertReleaseQualityReady(input) {
  const verdict = evaluatePairedQualityEvidence(input?.qualityEvidence, input?.trustRegistry, input?.qualityPolicy)
  if (!verdict.releaseEligible) fail('RELEASE_QUALITY_BLOCKED', 'paired outcome quality or cost-per-solve regressed', { verdict })
  return Object.freeze({
    ready: true,
    evidenceDigest: verdict.evidenceDigest,
    policyId: verdict.policyId,
    policyDigest: verdict.policyDigest,
    ratios: verdict.ratios,
  })
}

function parseArguments(argv, environment = process.env) {
  if (argv.length === 3 && argv[0] === '--policy' && argv[2] === '--if-supplied') {
    const evidencePath = environment[EVIDENCE_ENV]?.trim() || ''
    const trustRegistryPath = environment[TRUST_REGISTRY_ENV]?.trim() || ''
    if (!evidencePath && !trustRegistryPath) return { policyPath: path.resolve(argv[1]), skipped: true }
    if (!evidencePath || !trustRegistryPath) fail('RELEASE_QUALITY_CONFIG_INVALID', `${EVIDENCE_ENV} and ${TRUST_REGISTRY_ENV} must be supplied together`)
    return { policyPath: path.resolve(argv[1]), evidencePath: path.resolve(evidencePath), trustRegistryPath: path.resolve(trustRegistryPath), skipped: false }
  }
  if (argv.length === 6 && argv[0] === '--evidence' && argv[2] === '--trust-registry' && argv[4] === '--policy') {
    return { evidencePath: path.resolve(argv[1]), trustRegistryPath: path.resolve(argv[3]), policyPath: path.resolve(argv[5]), skipped: false }
  }
  fail('RELEASE_QUALITY_CONFIG_INVALID', 'usage: node quality-gate.cjs --evidence FILE --trust-registry FILE --policy FILE, or --policy FILE --if-supplied')
}

function main(argv, environment = process.env) {
  const args = parseArguments(argv, environment)
  const qualityPolicy = loadReleaseQualityPolicy(args.policyPath)
  if (args.skipped) {
    const result = { ready: false, skipped: true, reason: 'canonical-signed-evidence-not-supplied' }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result
  }
  const qualityEvidence = JSON.parse(fs.readFileSync(args.evidencePath, 'utf8'))
  const result = assertReleaseQualityReady({
    qualityEvidence,
    trustRegistry: loadTrustRegistry(args.trustRegistryPath),
    qualityPolicy,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.code || 'RELEASE_QUALITY_BLOCKED'}: ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  assertReleaseQualityReady,
  evaluatePairedQualityEvidence,
  loadReleaseQualityPolicy,
  main,
  normalizeReleaseQualityPolicy,
  parseArguments,
  signPairedQualityEvidence,
}
