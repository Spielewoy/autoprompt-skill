#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  CodexSupervisorRuntime,
  ROUTE_CAPABILITY_EFFECTS,
  RuntimeCapabilityAuthority,
  createDefaultRuntimeOptions,
  probeCodexExecCapabilities,
  productionExactPathPreflight,
  runSupervisorCli,
} = require('../../agents/codex/workflow/phase-budget.js')
const {
  admitCodexExecutable,
  resolveCodexExecutable,
} = require('../../agents/codex/workflow/codex-executable.js')
const {
  stableStringify: serializeCanonicalValue,
} = require('../../agents/codex/workflow/request-envelope.js')

const H = 'a'.repeat(64)
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-live-probe-'))
const FIXTURE_EXECUTABLE = path.join(
  FIXTURE_ROOT, process.platform === 'win32' ? 'codex.exe' : 'codex',
)
fs.writeFileSync(FIXTURE_EXECUTABLE, 'codex capability fixture')
if (process.platform !== 'win32') fs.chmodSync(FIXTURE_EXECUTABLE, 0o755)
const FIXTURE_VERSION = 'codex-cli test-live-1.0.0'
const FIXTURE_CANDIDATE = resolveCodexExecutable(FIXTURE_EXECUTABLE, {
  expectedVersion: FIXTURE_VERSION,
})
const FIXTURE_ADMISSION = admitCodexExecutable(
  FIXTURE_CANDIDATE, FIXTURE_CANDIDATE.identity,
)
test.after(() => fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }))
const TARGET = 'filesystem:C:/workspace'
const IDENTITY = Object.freeze({
  activationAttestation: Object.freeze({ hash: '1'.repeat(64) }),
  runtimeMetadataSha256: '2'.repeat(64),
  profileSha256: '3'.repeat(64),
  payloadManifestSha256: '4'.repeat(64),
  runId: 'cli-live-capability-run',
  generation: 1,
  targetIdentity: TARGET,
})

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fakeLocalProbe(overrides = {}) {
  return probeCodexExecCapabilities({
    admittedRuntime: FIXTURE_ADMISSION,
    processOwnership: true,
    isolatedChecking: true,
    execFileSync(_executable, argv) {
      if (argv[0] === 'features') return 'multi_agent stable true\n'
      if (argv[0] === '--version') return `${FIXTURE_VERSION}\n`
      if (argv[1] === 'resume') return '--json\n'
      return '--json --output-schema --profile --cd --strict-config\n'
    },
    ...overrides,
  })
}

function liveCapabilities(probe = fakeLocalProbe()) {
  assert.equal(probe.supported, true)
  return Object.freeze({
    eventStreaming: probe.eventStreaming,
    toolOutputCapture: probe.toolOutputCapture,
    stableChildIdentity: probe.stableChildIdentity,
    sameContextContinuation: probe.sameContextContinuation,
    isolatedChecking: probe.isolatedChecking,
    cancellation: probe.cancellation,
  })
}

function issueLiveReceipt(options = {}) {
  const clock = options.clock || { now: Date.parse('2026-08-23T00:00:00.000Z') }
  const providerCapabilities = options.providerCapabilities || liveCapabilities()
  const authority = new RuntimeCapabilityAuthority({ ...IDENTITY, now: () => clock.now })
  const receipt = authority.issue({
    providerCapabilities,
    controlCapabilities: options.controlCapabilities || [],
    evidenceHashes: ['5'.repeat(64), ...fakeLocalProbe().evidenceHashes],
    cliVersion: 'codex-cli test-live-1.0.0',
    allowedRoutes: ['PRE_ROUTE', 'DIRECT', 'LIGHT', 'ROADMAP'],
    allowedEffects: [...new Set(Object.values(ROUTE_CAPABILITY_EFFECTS).flat())],
    routeEffects: ROUTE_CAPABILITY_EFFECTS,
    expiresAtMs: clock.now + 60_000,
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
  return { authority, clock, providerCapabilities, receipt, verified }
}

function capabilityEvidence(live, overrides = {}) {
  return {
    source: 'authenticated-runtime-capability-receipt',
    providerCapabilitiesHash: sha256(serializeCanonicalValue(live.providerCapabilities)),
    verifiedCapabilities: [
      ...live.receipt.capabilitySet,
      ...live.receipt.controlCapabilitySet,
    ],
    evidenceHashes: [...live.receipt.probeEvidenceHashes],
    receipt: live.receipt,
    receiptHash: live.verified.receiptSha256,
    ...overrides,
  }
}

function canonicalRequestEnvelope(argv) {
  const bytes = Buffer.from(serializeCanonicalValue({ schemaVersion: 1, argv }), 'utf8')
  return Object.freeze({ bytes, hash: sha256(bytes) })
}

function canonicalInput(route, live, overrides = {}) {
  const providerCapabilitiesHash = sha256(serializeCanonicalValue(live.providerCapabilities))
  const requestEnvelope = canonicalRequestEnvelope([
    `path=${route.toLowerCase()}`,
    'Review the contained local source files.',
  ])
  return {
    route,
    mission: requestEnvelope.bytes.toString('utf8'),
    requestEnvelopeBytes: requestEnvelope.bytes,
    requestEnvelopeHash: requestEnvelope.hash,
    targetIdentity: TARGET,
    targetEvidence: {
      source: 'authenticated-activation-target',
      targetIdentity: TARGET,
      authorizationEvidenceHash: '6'.repeat(64),
      evidenceHashes: ['6'.repeat(64)],
    },
    providerCapabilities: live.providerCapabilities,
    providerCapabilitiesHash,
    providerCapabilityEvidence: capabilityEvidence(live),
    budget: {
      remaining: { wallMs: 600_000 },
      verificationReserveMs: 150_000,
      finalizationReserveMs: 60_000,
    },
    budgetSnapshotHash: '7'.repeat(64),
    settings: { path: { exactRoute: route } },
    ...overrides,
  }
}

function providerUnsupported(error) {
  return error && ['EXACT_PATH_PROVIDER_UNSUPPORTED', 'RUNTIME_CAPABILITY_INVALID', 'PROVIDER_UNSUPPORTED']
    .includes(error.code)
}

test('production CLI has no deferred or hard-coded bootstrap capability admission', () => {
  const cliSource = Function.prototype.toString.call(runSupervisorCli)
  const optionsSource = Function.prototype.toString.call(createDefaultRuntimeOptions)
  assert.match(cliSource, /exactPathPreflight:\s*productionExactPathPreflight/)
  assert.doesNotMatch(optionsSource, /deferredProviderCapabilityAdmission/)
  assert.doesNotMatch(
    optionsSource,
    /let providerCapabilities\s*=\s*Object\.freeze\(\{[\s\S]*?stableChildIdentity:\s*false[\s\S]*?cancellation:\s*false[\s\S]*?\}\)/,
  )
})

test('production exact-path refuses self-declared capability evidence without the authority-issued receipt', () => {
  const live = issueLiveReceipt()
  const selfDeclared = capabilityEvidence(live)
  delete selfDeclared.receipt
  assert.throws(
    () => productionExactPathPreflight(canonicalInput('DIRECT', live, {
      providerCapabilityEvidence: selfDeclared,
    })),
    providerUnsupported,
  )
})

test('false or unknown live capabilities deny the route and authentic true capabilities permit only proved requirements', async () => {
  const unowned = issueLiveReceipt()
  assert.throws(
    () => productionExactPathPreflight(canonicalInput('DIRECT', unowned)),
    error => providerUnsupported(error) && /processOwnership/u.test(error.message),
  )

  const live = issueLiveReceipt({ controlCapabilities: ['processOwnership'] })
  assert.equal(productionExactPathPreflight(canonicalInput('DIRECT', live)).source, 'deterministic-preflight')

  for (const providerCapabilities of [
    { ...live.providerCapabilities, toolOutputCapture: false },
    { ...live.providerCapabilities, toolOutputCapture: undefined },
  ]) {
    assert.throws(
      () => productionExactPathPreflight(canonicalInput('DIRECT', live, { providerCapabilities })),
      providerUnsupported,
    )
  }

  assert.throws(
    () => productionExactPathPreflight(canonicalInput('ROADMAP', live, {
      providerCapabilityEvidence: capabilityEvidence(live, {
        verifiedCapabilities: [...live.receipt.capabilitySet, 'topologyEnforcement'],
      }),
    })),
    providerUnsupported,
  )

  const provedRoadmap = issueLiveReceipt({
    controlCapabilities: ['processOwnership', 'topologyEnforcement'],
  })
  assert.equal(
    productionExactPathPreflight(canonicalInput('ROADMAP', provedRoadmap)).source,
    'deterministic-preflight',
  )

  const insertionOrderedCapabilities = {
    cancellation: true,
    isolatedChecking: true,
    sameContextContinuation: true,
    stableChildIdentity: true,
    toolOutputCapture: true,
    eventStreaming: true,
  }
  const seamLive = issueLiveReceipt({
    providerCapabilities: insertionOrderedCapabilities,
    controlCapabilities: ['processOwnership'],
  })
  const requestEnvelope = canonicalRequestEnvelope([
    'path=direct', 'Review the contained local source files.',
  ])
  const runtime = new CodexSupervisorRuntime({
    activationId: 'capability-hash-parity',
    activationNonce: '8'.repeat(32),
    budgetController: {
      snapshot: () => ({
        limits: { wallMs: 600_000, tokens: 1_000, sessions: 10, launches: 10 },
        consumedWallMs: 0, verificationReserveMs: 150_000, finalizationReserveMs: 60_000,
      }),
      assertAvailable: () => ({
        remaining: { wallMs: 0, tokens: 1_000, sessions: 10, launches: 10 },
        completionTargetOverrun: ['WALL'],
      }),
    },
    capabilityVerifier: async () => ({ verified: true }),
    decideRoute: async () => null,
    exactPathPreflight: input => productionExactPathPreflight({
      ...input, requestEnvelopeBytes: requestEnvelope.bytes,
    }),
    exactPathProviderCapabilityEvidence: ({ providerCapabilitiesHash }) =>
      capabilityEvidence(seamLive, { providerCapabilitiesHash }),
    exactPathTargetEvidence: () => ({
      source: 'authenticated-activation-target', targetIdentity: TARGET,
      authorizationEvidenceHash: '6'.repeat(64), evidenceHashes: ['6'.repeat(64)],
    }),
    finalizerFactory: async () => null,
    launcher: async () => null,
    mission: requestEnvelope.bytes.toString('utf8'),
    missionLock: { acquire: () => ({}) },
    now: () => seamLive.clock.now,
    processOwner: { cancelAll: async () => {}, assertDrained: async () => true },
    providerCapabilities: insertionOrderedCapabilities,
    recordFactory: async () => null,
    requestPointerFactory: async () => null,
    runId: IDENTITY.runId,
    targetIdentity: TARGET,
  })
  runtime.settings = { path: { exactRoute: 'DIRECT' } }
  runtime.requestPointer = { hash: requestEnvelope.hash }
  runtime.record = { write() {} }
  runtime._activateRouteScheduler = () => {}
  runtime._runtimeTransition = async () => {}
  const seamResult = await runtime._acceptExactPath()
  assert.equal(seamResult.status, 'ROUTE_DECIDED')
})

test('production exact-path rejects a stale authority-issued capability receipt', () => {
  const live = issueLiveReceipt()
  live.clock.now += 60_000
  assert.throws(() => productionExactPathPreflight(canonicalInput('DIRECT', live)), providerUnsupported)
})

test('production exact-path rejects a tampered authority-issued capability receipt', () => {
  const live = issueLiveReceipt()
  const receipt = { ...live.receipt, capabilitySet: [...live.receipt.capabilitySet, 'imaginaryCapability'] }
  assert.throws(
    () => productionExactPathPreflight(canonicalInput('DIRECT', live, {
      providerCapabilityEvidence: capabilityEvidence(live, { receipt }),
    })),
    providerUnsupported,
  )
})

test('production exact-path rejects a receipt whose declared hash does not bind its bytes', () => {
  const live = issueLiveReceipt()
  assert.throws(
    () => productionExactPathPreflight(canonicalInput('DIRECT', live, {
      providerCapabilityEvidence: capabilityEvidence(live, { receiptHash: 'f'.repeat(64) }),
    })),
    providerUnsupported,
  )
})

test('process ownership and topology count only from the authority-issued control capability set', () => {
  const absent = issueLiveReceipt()
  for (const capability of ['processOwnership', 'topologyEnforcement']) {
    assert.throws(
      () => absent.authority.verify(absent.receipt, {
        runId: IDENTITY.runId,
        generation: IDENTITY.generation,
        targetIdentity: IDENTITY.targetIdentity,
        route: 'DIRECT',
        effects: ['read'],
        assignmentId: `control-${capability}`,
        assignmentHash: H,
        requiredCapabilities: [capability],
      }),
      error => error && error.code === 'PROVIDER_UNSUPPORTED',
    )
  }

  const proved = issueLiveReceipt({
    controlCapabilities: ['processOwnership', 'topologyEnforcement'],
  })
  for (const capability of proved.receipt.controlCapabilitySet) {
    assert.equal(proved.authority.verify(proved.receipt, {
      runId: IDENTITY.runId,
      generation: IDENTITY.generation,
      targetIdentity: IDENTITY.targetIdentity,
      route: 'DIRECT',
      effects: ['read'],
      assignmentId: `control-${capability}`,
      assignmentHash: H,
      requiredCapabilities: [capability],
    }).verified, true)
  }
})
