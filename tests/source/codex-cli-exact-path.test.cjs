#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')

const {
  activationRuntimeSettings,
  productionExactPathPreflight,
  RuntimeCapabilityAuthority,
  runSupervisorCli,
} = require('../../agents/codex/workflow/phase-budget.js')
const {
  stableStringify: serializeCanonicalValue,
} = require('../../agents/codex/workflow/request-envelope.js')
const { resolveSettings } = require('../../agents/codex/workflow/settings.js')

const H = 'a'.repeat(64)
const H3 = 'c'.repeat(64)
const providerCapabilities = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})
const H2 = crypto.createHash('sha256').update(serializeCanonicalValue(providerCapabilities)).digest('hex')
const targetIdentity = 'filesystem:C:/workspace'
const capabilityAuthority = new RuntimeCapabilityAuthority({
  activationAttestation: { hash: H },
  runtimeMetadataSha256: H,
  profileSha256: H2,
  payloadManifestSha256: H3,
  runId: 'cli-exact-path-fixture',
  generation: 1,
  targetIdentity,
  now: () => 1_000,
  key: Buffer.alloc(32, 7),
})
const routeEffects = Object.freeze({
  PRE_ROUTE: Object.freeze(['read']),
  DIRECT: Object.freeze(['isolated-write', 'read', 'run', 'write']),
  LIGHT: Object.freeze(['isolated-write', 'read', 'run', 'technical-decision', 'write']),
  ROADMAP: Object.freeze(['coordinate', 'isolated-write', 'plan-write', 'read', 'run', 'write']),
})
const allowedEffects = [...new Set(Object.values(routeEffects).flat())].sort()
const capabilityReceipt = capabilityAuthority.issue({
  providerCapabilities,
  evidenceHashes: [H, H2, H3],
  cliVersion: 'codex-cli fixture',
  allowedRoutes: Object.keys(routeEffects),
  allowedEffects,
  routeEffects,
  controlCapabilities: ['processOwnership', 'topologyEnforcement'],
  expiresAtMs: 61_000,
})
const verifiedCapabilities = Object.freeze([
  ...new Set([
    ...capabilityReceipt.capabilitySet,
    ...capabilityReceipt.controlCapabilitySet,
  ]),
].sort())
const capabilityReceiptHash = crypto.createHash('sha256')
  .update(JSON.stringify(capabilityReceipt)).digest('hex')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonicalRequestEnvelope(argv) {
  const bytes = Buffer.from(serializeCanonicalValue({ schemaVersion: 1, argv }), 'utf8')
  return Object.freeze({ bytes, hash: sha256(bytes) })
}

function resolvedSettings(argv) {
  return resolveSettings(activationRuntimeSettings({
    requestArgv: argv,
    modelSelection: { mode: 'provider-default', selector: 'default', models: [] },
  }, { providerMaximum: 10 }))
}

function canonicalInput(route, overrides = {}) {
  const {
    argv = [`path=${route.toLowerCase()}`, 'Review the contained local source files.'],
    ...inputOverrides
  } = overrides
  const requestEnvelope = canonicalRequestEnvelope(argv)
  return {
    route,
    mission: requestEnvelope.bytes.toString('utf8'),
    requestEnvelopeBytes: requestEnvelope.bytes,
    requestEnvelopeHash: requestEnvelope.hash,
    targetIdentity,
    targetEvidence: {
      source: 'authenticated-activation-target', targetIdentity,
      authorizationEvidenceHash: H, evidenceHashes: [H],
    },
    providerCapabilities,
    providerCapabilitiesHash: H2,
    providerCapabilityEvidence: {
      source: 'authenticated-runtime-capability-receipt', providerCapabilitiesHash: H2,
      verifiedCapabilities,
      evidenceHashes: [...capabilityReceipt.probeEvidenceHashes],
      receipt: capabilityReceipt,
      receiptHash: capabilityReceiptHash,
    },
    budget: {
      remaining: { wallMs: 600_000 },
      verificationReserveMs: 150_000,
      finalizationReserveMs: 60_000,
    },
    budgetSnapshotHash: H3,
    settings: { path: { exactRoute: route } },
    ...inputOverrides,
  }
}

test('production supervisor CLI installs its private deterministic exact-path preflight', () => {
  const productionEntry = Function.prototype.toString.call(runSupervisorCli)
  assert.match(productionEntry,
    /createSupervisorOptions\(args,\s*\{\s*adapterPath,\s*exactPathPreflight:\s*productionExactPathPreflight,?\s*\}\)/)
})

test('production exact-path receipts accept contained read-only direct, light, and roadmap only from attested bindings', () => {
  for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) {
    const input = canonicalInput(route)
    const receipt = productionExactPathPreflight(input)
    assert.equal(receipt.source, 'deterministic-preflight')
    assert.equal(receipt.requestEnvelopeHash, input.requestEnvelopeHash)
    assert.equal(receipt.targetIdentity, 'filesystem:C:/workspace')
    assert.equal(receipt.providerCapabilitiesHash, H2)
    assert.equal(receipt.budgetSnapshotHash, H3)
    assert.equal(receipt.routeFacts.requestedEffect, 'inspect')
    assert.deepEqual(receipt.routeFacts.mutableResources, [])
    assert.deepEqual(receipt.routeFacts.sideEffects, [])
    assert.equal(receipt.routeFacts.operatorMinimumRoute, route)
    assert.deepEqual(receipt.routeFacts.deadlineBudget, {
      remainingSeconds: 600,
      admissionSeconds: 0,
      executionReserveSeconds: 390,
      verificationReserveSeconds: 150,
      recoveryAndFinalizationReserveSeconds: 60,
    })
  }
})

test('leading explicit path strips only its control and conservatively denies preserved inline or quoted path prose', () => {
  for (const argv of [
    ['path=direct', 'Review literal path=light prose in the contained local source files.'],
    ['--path', 'direct', '"path=light" is quoted prose in the contained local source files.'],
  ]) {
    const original = [...argv]
    const settings = resolvedSettings(argv)
    const envelope = canonicalRequestEnvelope(argv)
    let routeModelCalls = 0
    let l0Calls = 0
    let productionCalls = 0

    assert.equal(settings.status, 'READY', JSON.stringify(argv))
    assert.equal(settings.path.exactRoute, 'DIRECT', JSON.stringify(argv))
    assert.deepEqual(JSON.parse(envelope.bytes.toString('utf8')).argv, original)
    assert.throws(() => productionExactPathPreflight(canonicalInput('DIRECT', {
      argv,
    })), error => error && error.code === 'EXACT_PATH_FACTS_REQUIRED')
    assert.deepEqual(argv, original)
    assert.deepEqual({ routeModelCalls, l0Calls, productionCalls }, {
      routeModelCalls: 0,
      l0Calls: 0,
      productionCalls: 0,
    })
  }
})

test('inline path text without a leading control preserves the entire mission and remains automatic', () => {
  for (const argv of [
    ['Review literal path=direct prose in the contained local source files.'],
    ['"path=direct" is quoted prose in the contained local source files.'],
  ]) {
    const original = [...argv]
    const settings = resolvedSettings(argv)
    const envelope = canonicalRequestEnvelope(argv)

    assert.equal(settings.status, 'READY', JSON.stringify(argv))
    assert.equal(settings.path.requested, 'auto', JSON.stringify(argv))
    assert.equal(settings.path.mode, 'automatic', JSON.stringify(argv))
    assert.equal(settings.path.exactRoute, null, JSON.stringify(argv))
    assert.deepEqual(JSON.parse(envelope.bytes.toString('utf8')).argv, original)
    assert.deepEqual(argv, original)
  }
})

test('production exact-path refuses unknown, mutating, authority-bearing, or unauthenticated facts before models or production', () => {
  const cases = [
    [canonicalInput('DIRECT', { argv: ['path=direct', ''] }), 'EXACT_PATH_FACTS_REQUIRED'],
    [canonicalInput('DIRECT', {
      argv: ['path=direct', 'Consider the repository.'],
    }), 'EXACT_PATH_FACTS_REQUIRED'],
    [canonicalInput('DIRECT', {
      argv: ['path=direct', 'Implement the bounded local change.'],
    }), 'EXACT_PATH_FACTS_REQUIRED'],
    [canonicalInput('DIRECT', {
      argv: ['path=direct', 'Send an email to a third party.'],
    }), 'EXACT_PATH_FACTS_REQUIRED'],
    [canonicalInput('DIRECT', {
      argv: ['path=direct', 'Review and change repository permissions.'],
    }), 'EXACT_PATH_FACTS_REQUIRED'],
    [canonicalInput('DIRECT', { targetEvidence: null }), 'EXACT_PATH_FACTS_REQUIRED'],
    [canonicalInput('DIRECT', {
      targetEvidence: {
        source: 'authenticated-activation-target', targetIdentity: 'filesystem:C:/foreign',
        authorizationEvidenceHash: H, evidenceHashes: [H],
      },
    }), 'EXACT_PATH_FACTS_REQUIRED'],
    [canonicalInput('DIRECT', {
      providerCapabilities: { ...providerCapabilities, isolatedChecking: false },
    }), 'EXACT_PATH_PROVIDER_UNSUPPORTED'],
    [canonicalInput('DIRECT', { providerCapabilityEvidence: null }), 'EXACT_PATH_PROVIDER_UNSUPPORTED'],
    [canonicalInput('ROADMAP', {
      providerCapabilityEvidence: {
        source: 'authenticated-runtime-capability-receipt', providerCapabilitiesHash: H2,
        verifiedCapabilities: verifiedCapabilities.filter(item => item !== 'topologyEnforcement'),
        evidenceHashes: [...capabilityReceipt.probeEvidenceHashes],
        receipt: capabilityReceipt,
        receiptHash: capabilityReceiptHash,
      },
    }), 'EXACT_PATH_PROVIDER_UNSUPPORTED'],
    [canonicalInput('DIRECT', {
      budget: { remaining: { wallMs: 200_000 }, verificationReserveMs: 150_000, finalizationReserveMs: 60_000 },
    }), 'EXACT_PATH_BUDGET_INSUFFICIENT'],
  ]
  for (const [input, code] of cases) {
    assert.throws(() => productionExactPathPreflight(input), error => error && error.code === code)
  }
})
