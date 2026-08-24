'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')

const {
  ROUTE_CAPABILITY_EFFECTS,
  RuntimeCapabilityAuthority,
  activationRuntimeSettings,
  productionExactPathPreflight,
} = require('../../agents/codex/workflow/phase-budget.js')
const {
  stableStringify: serializeCanonicalValue,
} = require('../../agents/codex/workflow/request-envelope.js')
const { resolveSettings } = require('../../agents/codex/workflow/settings.js')
const { parseArgs } = require('../../bin/autoprompt.cjs')

const H = 'a'.repeat(64)
const H3 = 'c'.repeat(64)
const TARGET = 'filesystem:C:/workspace'
const IDENTITY = Object.freeze({
  activationAttestation: Object.freeze({ hash: '1'.repeat(64) }),
  runtimeMetadataSha256: '2'.repeat(64),
  profileSha256: '3'.repeat(64),
  payloadManifestSha256: '4'.repeat(64),
  runId: 'cli-control-prefix-run',
  generation: 1,
  targetIdentity: TARGET,
})
const providerCapabilities = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function issueLiveReceipt() {
  const now = Date.parse('2026-08-23T00:00:00.000Z')
  const authority = new RuntimeCapabilityAuthority({ ...IDENTITY, now: () => now })
  const receipt = authority.issue({
    providerCapabilities,
    evidenceHashes: ['5'.repeat(64)],
    cliVersion: 'codex-cli control-prefix-test-1.0.0',
    allowedRoutes: Object.keys(ROUTE_CAPABILITY_EFFECTS),
    allowedEffects: [...new Set(Object.values(ROUTE_CAPABILITY_EFFECTS).flat())],
    routeEffects: ROUTE_CAPABILITY_EFFECTS,
    controlCapabilities: ['processOwnership'],
    expiresAtMs: now + 60_000,
  })
  const verified = authority.verify(receipt, {
    runId: IDENTITY.runId,
    generation: IDENTITY.generation,
    targetIdentity: IDENTITY.targetIdentity,
    route: 'DIRECT',
    effects: ['read'],
    assignmentId: 'exact-path-preflight',
    assignmentHash: H,
    requiredCapabilities: receipt.capabilitySet,
  })
  return Object.freeze({ receipt, verified })
}

const live = issueLiveReceipt()
const providerCapabilitiesHash = sha256(serializeCanonicalValue(providerCapabilities))

function resolvedSettings(argv) {
  return resolveSettings(activationRuntimeSettings({
    requestArgv: argv,
    modelSelection: { mode: 'provider-default', selector: 'default', models: [] },
  }, { providerMaximum: 10 }))
}

function canonicalRequestEnvelope(argv) {
  const bytes = Buffer.from(serializeCanonicalValue({ schemaVersion: 1, argv }), 'utf8')
  return Object.freeze({ bytes, hash: sha256(bytes) })
}

function preflight(argv, route = 'DIRECT', settings = resolvedSettings(argv)) {
  const requestEnvelope = canonicalRequestEnvelope(argv)
  return productionExactPathPreflight({
    route,
    mission: requestEnvelope.bytes.toString('utf8'),
    requestEnvelopeBytes: requestEnvelope.bytes,
    requestEnvelopeHash: requestEnvelope.hash,
    targetIdentity: TARGET,
    targetEvidence: {
      source: 'authenticated-activation-target',
      targetIdentity: TARGET,
      authorizationEvidenceHash: H,
      evidenceHashes: [H],
    },
    providerCapabilities,
    providerCapabilitiesHash,
    providerCapabilityEvidence: {
      source: 'authenticated-runtime-capability-receipt',
      providerCapabilitiesHash,
      verifiedCapabilities: [...new Set([
        ...live.receipt.capabilitySet, ...(live.receipt.controlCapabilitySet || []),
      ])].sort(),
      evidenceHashes: [...live.receipt.probeEvidenceHashes],
      receipt: live.receipt,
      receiptHash: live.verified.receiptSha256,
    },
    budget: {
      remaining: { wallMs: 600_000 },
      verificationReserveMs: 150_000,
      finalizationReserveMs: 60_000,
    },
    budgetSnapshotHash: H3,
    settings,
  })
}

function exactFactsRequired(error) {
  return error && error.code === 'EXACT_PATH_FACTS_REQUIRED'
}

test('explicit path mixed with concurrency controls fails closed before route-model, L0, or production work', () => {
  const argv = ['wide', 'path=direct', 'Review the contained local source files.']
  const settings = resolvedSettings(argv)
  let routeModelCalls = 0
  let l0Calls = 0
  let productionCalls = 0

  if (settings.ready) {
    routeModelCalls += 1
    l0Calls += 1
    productionCalls += 1
    preflight(argv, 'DIRECT', settings)
  }

  assert.equal(settings.status, 'CONFIG_REQUIRED')
  assert.equal(settings.ready, false)
  assert.equal(settings.inspectionAllowed, false)
  assert.equal(settings.nextAction, 'STOP')
  assert.equal(settings.issues.some(issue => issue.field === 'path' && issue.code === 'INVALID'), true)
  assert.deepEqual({ routeModelCalls, l0Calls, productionCalls }, {
    routeModelCalls: 0,
    l0Calls: 0,
    productionCalls: 0,
  })
})

test('plain wide without an explicit path retains automatic routing behavior', () => {
  const settings = resolvedSettings(['wide', 'Review the contained local source files.'])

  assert.equal(settings.status, 'READY')
  assert.equal(settings.concurrency.friendlyMode, 'wide')
  assert.equal(settings.path.requested, 'auto')
  assert.equal(settings.path.mode, 'automatic')
  assert.equal(settings.path.exactRoute, null)
})

test('explicit path=auto retains automatic routing without exact-path bypass', () => {
  for (const argv of [
    ['path=auto', 'Review the contained local source files.'],
    ['--path=auto', 'Review the contained local source files.'],
    ['--path', 'auto', 'Review the contained local source files.'],
  ]) {
    const command = parseArgs(['activate', 'codex', '--', ...argv])
    assert.deepEqual(command.missionArgs, argv)
    const settings = resolvedSettings(command.missionArgs)
    assert.equal(settings.status, 'READY', JSON.stringify(argv))
    assert.equal(settings.path.requested, 'auto', JSON.stringify(argv))
    assert.equal(settings.path.mode, 'automatic', JSON.stringify(argv))
    assert.equal(settings.path.exactRoute, null, JSON.stringify(argv))
  }
})

test('path=auto keeps the control prefix open for following concurrency controls', () => {
  const cases = [
    {
      argv: ['path=auto', 'wide', 'Review the contained local source files.'],
      mode: 'wide',
    },
    {
      argv: ['--path=auto', '--concurrency', 'custom', '--max-subs', '3', 'Review the contained local source files.'],
      mode: 'custom',
      maxSubs: 3,
    },
    {
      argv: ['--path', 'auto', 'tokensaver', 'Review the contained local source files.'],
      mode: 'tokensaver',
    },
  ]

  for (const { argv, mode, maxSubs } of cases) {
    const settings = resolvedSettings(argv)
    assert.equal(settings.status, 'READY', JSON.stringify(argv))
    assert.equal(settings.path.mode, 'automatic', JSON.stringify(argv))
    assert.equal(settings.path.exactRoute, null, JSON.stringify(argv))
    assert.equal(settings.concurrency.friendlyMode, mode, JSON.stringify(argv))
    if (maxSubs !== undefined) {
      assert.equal(settings.concurrency.requestedMaxSubs, maxSubs, JSON.stringify(argv))
    }
  }
})

test('an exact path closes the control prefix and leaves every following token as mission content', () => {
  for (const { argv, route } of [
    {
      argv: ['path=direct', 'wide', 'Inspect the contained local workspace files.'],
      route: 'DIRECT',
    },
    {
      argv: ['--path=light', '--concurrency', 'custom', 'Implement the bounded local change.'],
      route: 'LIGHT',
    },
    {
      argv: ['--path', 'roadmap', '--max-subs', '2', 'Implement the bounded local change.'],
      route: 'ROADMAP',
    },
  ]) {
    const settings = resolvedSettings(argv)
    assert.equal(settings.status, 'READY', JSON.stringify(argv))
    assert.equal(settings.path.exactRoute, route, JSON.stringify(argv))
    assert.equal(settings.concurrency.friendlyMode, 'tokensaver', JSON.stringify(argv))
  }
})

test('an immediate second path control after an exact path is rejected', () => {
  for (const argv of [
    ['path=direct', 'path=light', 'Review the contained local source files.'],
    ['--path=direct', '--path=light', 'Review the contained local source files.'],
    ['--path', 'direct', '--path', 'light', 'Review the contained local source files.'],
  ]) {
    const original = [...argv]
    const settings = resolvedSettings(argv)
    assert.deepEqual(argv, original, 'control parsing must not mutate raw argv')
    assert.equal(settings.status, 'CONFIG_REQUIRED', JSON.stringify(argv))
    assert.equal(settings.issues.some(issue => issue.field === 'path' && issue.code === 'INVALID'), true)
  }
})

test('an explicit delimiter starts mission content and later path-like tokens stay literal', () => {
  for (const argv of [
    ['path=direct', '--', 'Review the contained local source files.'],
    ['path=direct', 'Review the contained local source files.', 'path=light'],
  ]) {
    const original = [...argv]
    const settings = resolvedSettings(argv)
    assert.deepEqual(argv, original, 'control parsing must not mutate raw argv')
    assert.equal(settings.status, 'READY', JSON.stringify(argv))
    assert.equal(settings.path.exactRoute, 'DIRECT', JSON.stringify(argv))
    if (argv[1] === '--') {
      assert.equal(preflight(argv, 'DIRECT', settings).routeFacts.requestedEffect, 'inspect')
    }
  }
})

test('controls before an exact path remain controls and retain fail-closed mixed-control semantics', () => {
  for (const { argv, mode, maxSubs } of [
    {
      argv: ['wide', 'path=direct', 'Review the contained local source files.'],
      mode: 'wide',
    },
    {
      argv: ['--concurrency', 'custom', '--max-subs', '2', '--path=light', 'Implement the bounded local change.'],
      mode: 'custom',
      maxSubs: '2',
    },
  ]) {
    const raw = activationRuntimeSettings({
      requestArgv: argv,
      modelSelection: { mode: 'provider-default', selector: 'default', models: [] },
    }, { providerMaximum: 10 })
    assert.equal(raw.explicit.concurrency.mode, mode, JSON.stringify(argv))
    if (maxSubs !== undefined) assert.equal(raw.explicit.concurrency.maxSubs, maxSubs, JSON.stringify(argv))

    const settings = resolveSettings(raw)
    assert.equal(settings.status, 'CONFIG_REQUIRED', JSON.stringify(argv))
    assert.equal(settings.issues.some(issue => issue.field === 'path' && issue.code === 'INVALID'), true)
  }
})

test('production controls accept every supported explicit direct path spelling', () => {
  for (const argv of [
    ['path=direct', 'Review the contained local source files.'],
    ['--path=direct', 'Review the contained local source files.'],
    ['--path', 'direct', 'Review the contained local source files.'],
  ]) {
    const settings = resolvedSettings(argv)
    assert.equal(settings.path.exactRoute, 'DIRECT', JSON.stringify(argv))
    assert.equal(preflight(argv, 'DIRECT', settings).routeFacts.requestedEffect, 'inspect')
  }
})

test('the first non-control token permanently ends control-prefix parsing', () => {
  for (const argv of [
    ['Review', 'path=direct', 'the', 'contained', 'local', 'source', 'files.'],
    ['Review', 'wide', '--path', 'direct', 'the', 'contained', 'local', 'source', 'files.'],
  ]) {
    const settings = resolvedSettings(argv)
    assert.equal(settings.path.mode, 'automatic', JSON.stringify(argv))
    assert.equal(settings.concurrency.friendlyMode, 'tokensaver', JSON.stringify(argv))
    assert.throws(
      () => preflight(argv, 'DIRECT', { ...settings, path: { exactRoute: 'DIRECT' } }),
      exactFactsRequired,
    )
  }
})

test('inline, quoted, and later path text remains ordinary mission content and selects automatic routing', () => {
  for (const argv of [
    ['Review the literal path=direct in the contained local source files.'],
    ['"path=direct"', 'is', 'quoted', 'mission', 'text', 'about', 'contained', 'local', 'files.'],
    ['Review', 'path=direct', 'as', 'literal', 'text', 'in', 'contained', 'local', 'files.'],
  ]) {
    const original = [...argv]
    const settings = resolvedSettings(argv)
    assert.equal(settings.path.requested, 'auto', JSON.stringify(argv))
    assert.equal(settings.path.mode, 'automatic', JSON.stringify(argv))
    assert.deepEqual(argv, original)
  }
})

test('mutating and ambiguous exact-path missions retain mutation safety classification', () => {
  for (const argv of [
    ['path=direct', 'Implement', 'the', 'bounded', 'contained', 'local', 'change.'],
    ['path=direct', 'Consider', 'the', 'contained', 'local', 'source', 'files.'],
    ['path=direct', 'Review', 'and', 'change', 'the', 'contained', 'local', 'source', 'files.'],
  ]) {
    const admitted = preflight(argv)
    assert.equal(admitted.routeFacts.requestedEffect, 'mutate', JSON.stringify(argv))
    assert.equal(admitted.routeFacts.candidateFreeze.required, true)
    assert.equal(admitted.routeFacts.checkAndBaseline.baselineStatus, 'required-before-production')
    assert.deepEqual(admitted.routeFacts.sideEffects, ['deliverable-write'])
  }
})

test('documented CLI argv reaches the real supervisor exact-path preflight as mutating work', () => {
  const command = parseArgs(['activate', 'codex', '--', 'path=direct', 'fix', 'the', 'bug'])
  assert.deepEqual(command.missionArgs, ['path=direct', 'fix', 'the', 'bug'])
  const settings = resolvedSettings(command.missionArgs)
  assert.equal(settings.status, 'READY')
  assert.equal(settings.path.exactRoute, 'DIRECT')
  const admitted = preflight(command.missionArgs, 'DIRECT', settings)
  assert.equal(admitted.routeFacts.requestedEffect, 'mutate')
  assert.equal(admitted.routeFacts.targetAuthorization.allTargetsAuthorized, true)
  assert.equal(admitted.routeFacts.candidateFreeze.required, true)
})
