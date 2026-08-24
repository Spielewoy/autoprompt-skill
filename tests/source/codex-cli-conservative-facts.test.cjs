#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')

const {
  ROUTE_CAPABILITY_EFFECTS,
  RuntimeCapabilityAuthority,
  productionExactPathPreflight,
} = require('../../agents/codex/workflow/phase-budget.js')
const {
  stableStringify: serializeCanonicalValue,
} = require('../../agents/codex/workflow/request-envelope.js')
const router = require('../../agents/codex/workflow/router.js')

const H = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const H3 = 'c'.repeat(64)
const TARGET = 'filesystem:C:/workspace'
const IDENTITY = Object.freeze({
  activationAttestation: Object.freeze({ hash: '1'.repeat(64) }),
  runtimeMetadataSha256: '2'.repeat(64),
  profileSha256: '3'.repeat(64),
  payloadManifestSha256: '4'.repeat(64),
  runId: 'cli-conservative-facts-run',
  generation: 1,
  targetIdentity: TARGET,
})
const providerCapabilities = Object.freeze({
  cancellation: true,
  eventStreaming: true,
  isolatedChecking: true,
  sameContextContinuation: true,
  stableChildIdentity: true,
  toolOutputCapture: true,
})
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function issueLiveReceipt(route, options = {}) {
  const clock = { now: Date.parse('2026-08-23T00:00:00.000Z') }
  const liveProviderCapabilities = options.providerCapabilities || providerCapabilities
  const authority = new RuntimeCapabilityAuthority({ ...IDENTITY, now: () => clock.now })
  const receipt = authority.issue({
    providerCapabilities: liveProviderCapabilities,
    controlCapabilities: options.controlCapabilities === undefined
      ? (route === 'ROADMAP' ? ['topologyEnforcement'] : [])
      : options.controlCapabilities,
    evidenceHashes: [H2],
    cliVersion: 'codex-cli conservative-facts-test-1.0.0',
    allowedRoutes: ['PRE_ROUTE', 'DIRECT', 'LIGHT', 'ROADMAP'],
    allowedEffects: [...new Set(Object.values(ROUTE_CAPABILITY_EFFECTS).flat())],
    routeEffects: ROUTE_CAPABILITY_EFFECTS,
    expiresAtMs: clock.now + 60_000,
  })
  const verified = authority.verify(receipt, {
    runId: IDENTITY.runId,
    generation: IDENTITY.generation,
    targetIdentity: TARGET,
    route,
    effects: ['read'],
    assignmentId: 'exact-path-preflight',
    assignmentHash: H,
    requiredCapabilities: [],
  })
  return { providerCapabilities: liveProviderCapabilities, receipt, verified }
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

function canonicalInput(
  route,
  mission = 'Review the contained local source files.',
  overrides = {},
  live = issueLiveReceipt(route),
) {
  const providerCapabilitiesHash = sha256(serializeCanonicalValue(live.providerCapabilities))
  const requestEnvelope = canonicalRequestEnvelope([
    `path=${route.toLowerCase()}`,
    mission,
  ])
  const budget = {
    finalizationReserveMs: 60_000,
    remaining: { wallMs: 600_000 },
    verificationReserveMs: 150_000,
  }
  return {
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
    providerCapabilities: live.providerCapabilities,
    providerCapabilitiesHash,
    providerCapabilityEvidence: capabilityEvidence(live),
    budget,
    budgetSnapshotHash: sha256(serializeCanonicalValue(budget)),
    settings: { path: { exactRoute: route } },
    ...overrides,
  }
}

function canonicalInputFromArgv(route, argv, overrides = {}) {
  const requestEnvelope = canonicalRequestEnvelope(argv)
  return canonicalInput(route, undefined, {
    mission: requestEnvelope.bytes.toString('utf8'),
    requestEnvelopeBytes: requestEnvelope.bytes,
    requestEnvelopeHash: requestEnvelope.hash,
    ...overrides,
  })
}

function throwsCode(code) {
  return error => error && error.code === code
}

test('contained explicit inspect, review, and report requests admit direct, light, and roadmap from authenticated facts', () => {
  const effects = new Map([
    ['Inspect the contained local workspace files.', 'inspect'],
    ['Review the contained local source files.', 'inspect'],
    ['Report the contained local repository findings.', 'report'],
  ])

  for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) {
    for (const [mission, expectedEffect] of effects) {
      const input = canonicalInput(route, mission)
      const request = JSON.parse(input.mission)
      assert.deepEqual(request.argv, [`path=${route.toLowerCase()}`, mission])
      const receipt = productionExactPathPreflight(input)
      const validation = router.validateRouteFacts(receipt.routeFacts)

      assert.equal(receipt.source, 'deterministic-preflight', `${route}: ${mission}`)
      assert.equal(validation.valid, true, validation.errors.join('; '))
      assert.equal(receipt.routeFacts.requestedEffect, expectedEffect)
      assert.deepEqual(receipt.routeFacts.mutableResources, [])
      assert.deepEqual(receipt.routeFacts.sideEffects, [])
      assert.equal(receipt.routeFacts.externality, 'local-only')
      assert.deepEqual(receipt.routeFacts.targetAuthorization, {
        targetIdentities: [TARGET],
        authorizedTargetIdentities: [TARGET],
        authorizationEvidenceHash: H,
        allTargetsAuthorized: true,
      })

      const classified = router.classifyRoute(validation.facts)
      assert.equal(classified.status, 'DECIDED')
      assert.equal(classified.route, route)
      const required = router.requiredCapabilitiesForFacts(validation.facts, route)
      assert.deepEqual(classified.requiredCapabilities, required)
      assert.ok(required.every(capability => receipt.verifiedCapabilities.includes(capability)))
    }
  }
})

const safeWholeMissionGrammar = new Map([
  ['Inspect the contained local source files.', 'inspect'],
  ['Read the contained local source files.', 'inspect'],
  ['Summarize the contained local source files.', 'report'],
  ['List the contained local repository files.', 'report'],
  ['Report the contained local project findings.', 'report'],
])

for (const [mission, expectedEffect] of safeWholeMissionGrammar) {
  test(`narrow authorized local read-only grammar remains admissible: ${mission}`, () => {
    const input = canonicalInput('DIRECT', mission)
    assert.deepEqual(JSON.parse(input.mission).argv, ['path=direct', mission])
    const receipt = productionExactPathPreflight(input)
    assert.equal(receipt.source, 'deterministic-preflight')
    assert.equal(receipt.routeFacts.requestedEffect, expectedEffect)
    assert.deepEqual(receipt.routeFacts.mutableResources, [])
    assert.deepEqual(receipt.routeFacts.sideEffects, [])
  })
}

const decisionAmbiguityMissions = [
  'Review the contained local source files and decide the architecture/public-contract direction.',
  'Inspect the contained local repository and recommend the product design strategy.',
  'List the contained local project options and compare architecture directions.',
  'Report the contained local code findings and choose the public-contract product direction.',
  'Show the contained local source design and determine the strategy decision.',
  'rEvIeW the contained local source files and DeCiDe the architecture direction.',
  'Inspect the contained local source files; recommend a product strategy.',
  'Report the contained local repository findings，compare the public-contract designs.',
  'Inspect the contained local project and ｄｅｃｉｄｅ the architecture direction.',
  'Analyze the contained local code and settle which product direction to pursue.',
  'Explain the contained local repository and advise on the architecture.',
  'Audit the contained local source, then select a public-contract design.',
  'Research the contained local project and weigh competing product strategies.',
  'Investigate the contained local source and formulate the design decision.',
  'Review the contained local files. Next directive: determine the product direction.',
]

for (const mission of decisionAmbiguityMissions) {
  test(`read-only lead verb cannot hide unresolved decision semantics: ${mission}`, () => {
    let admitted = 0
    assert.throws(() => {
      productionExactPathPreflight(canonicalInput('DIRECT', mission))
      admitted += 1
    }, throwsCode('EXACT_PATH_FACTS_REQUIRED'))
    assert.equal(admitted, 0)
  })
}

const nonCanonicalMissionAliases = [
  ['hyphenated words', 'Review-the-contained-local-source-files.'],
  ['underscored words', 'Review_the_contained_local_source_files.'],
  ['double-quoted mission', '"Review the contained local source files."'],
  ['single-quoted mission', "'Review the contained local source files.'"],
  ['lowercase alias', 'review the contained local source files.'],
  ['uppercase alias', 'REVIEW THE CONTAINED LOCAL SOURCE FILES.'],
  ['mixed-case alias', 'ReViEw the contained local source files.'],
  ['fullwidth NFKC alias', 'Ｒｅｖｉｅｗ ｔｈｅ ｃｏｎｔａｉｎｅｄ ｌｏｃａｌ ｓｏｕｒｃｅ ｆｉｌｅｓ．'],
  ['Cyrillic homoglyph', 'Revіew the contained local source files.'],
  ['compatibility-ligature alias', 'Review the contained local source ﬁles.'],
  ['verb punctuation', 'Review: the contained local source files.'],
  ['missing terminal punctuation', 'Review the contained local source files'],
  ['extra terminal punctuation', 'Review the contained local source files..'],
  ['symbol terminal punctuation', 'Review the contained local source files!'],
  ['leading spacing', ' Review the contained local source files.'],
  ['trailing spacing', 'Review the contained local source files. '],
  ['repeated spacing', 'Review  the contained local source files.'],
  ['tab control', 'Review\tthe contained local source files.'],
  ['newline control', 'Review the contained local\nsource files.'],
  ['embedded symbol', 'Review the contained local source + files.'],
]

for (const [label, mission] of nonCanonicalMissionAliases) {
  test(`strict canonical mission grammar rejects ${label}`, () => {
    let admitted = 0
    assert.throws(() => {
      productionExactPathPreflight(canonicalInput('DIRECT', mission))
      admitted += 1
    }, throwsCode('EXACT_PATH_FACTS_REQUIRED'))
    assert.equal(admitted, 0)
  })
}

const canonicalReviewMission = 'Review the contained local source files.'
const nonCanonicalArgvVectors = [
  ['word split', ['path=direct', 'Review', 'the', 'contained', 'local', 'source', 'files.']],
  ['recombined prefix', ['path=direct', 'Review the contained', 'local source files.']],
  ['recombined suffix', ['path=direct', 'Review the contained local', 'source files.']],
  ['reordered pieces', ['path=direct', 'the contained local source files.', 'Review']],
  ['duplicated mission', ['path=direct', canonicalReviewMission, canonicalReviewMission]],
  ['leading empty mission token', ['path=direct', '', canonicalReviewMission]],
  ['middle empty mission token', ['path=direct', 'Review', '', 'the contained local source files.']],
  ['trailing empty mission token', ['path=direct', canonicalReviewMission, '']],
  ['split terminal punctuation', ['path=direct', 'Review the contained local source files', '.']],
  ['null-byte mission', ['path=direct', 'Review the contained local source\0files.']],
  ['optional control plus split mission', ['wide', 'path=direct', 'Review', 'the contained local source files.']],
]

for (const [label, argv] of nonCanonicalArgvVectors) {
  test(`exact path rejects ${label} even when tokens can resemble a canonical sentence`, () => {
    let admitted = 0
    assert.throws(() => {
      productionExactPathPreflight(canonicalInputFromArgv('DIRECT', argv))
      admitted += 1
    }, throwsCode('EXACT_PATH_FACTS_REQUIRED'))
    assert.equal(admitted, 0)
  })
}

test('exact path rejects substitution of the authenticated canonical request-envelope hash', () => {
  const input = canonicalInput('DIRECT', canonicalReviewMission)
  assert.equal(input.requestEnvelopeHash, sha256(input.mission))
  const substitutedHash = input.requestEnvelopeHash === H3 ? H2 : H3
  assert.throws(
    () => productionExactPathPreflight({ ...input, requestEnvelopeHash: substitutedHash }),
    throwsCode('EXACT_PATH_FACTS_REQUIRED'),
  )
})

test('ambiguous, unknown, mutating, permission, email, and external missions deny with exact facts-required status', () => {
  const denied = [
    'Consider the contained local source files.',
    'Handle the contained local source files.',
    'Implement the contained local source change.',
    'Review and change the contained repository permissions.',
    'Send an email about the contained local source files.',
    'Review https://example.invalid/source.',
  ]

  let admitted = 0
  for (const mission of denied) {
    assert.throws(() => {
      productionExactPathPreflight(canonicalInput('DIRECT', mission))
      admitted += 1
    }, throwsCode('EXACT_PATH_FACTS_REQUIRED'), mission)
  }
  assert.equal(admitted, 0)
})

test('missing or unauthenticated targets deny as facts-required and cannot self-authorize route facts', () => {
  const selfAuthorizedFacts = {
    targetAuthorization: {
      targetIdentities: [TARGET],
      authorizedTargetIdentities: [TARGET],
      authorizationEvidenceHash: H,
      allTargetsAuthorized: true,
    },
  }
  const cases = [
    { targetIdentity: '' },
    { targetEvidence: null },
    {
      targetEvidence: {
        source: 'caller-asserted-target',
        targetIdentity: TARGET,
        authorizationEvidenceHash: H,
        evidenceHashes: [H],
      },
    },
    {
      targetEvidence: {
        source: 'authenticated-activation-target',
        targetIdentity: 'filesystem:C:/foreign',
        authorizationEvidenceHash: H,
        evidenceHashes: [H],
      },
    },
    {
      targetEvidence: null,
      routeFacts: selfAuthorizedFacts,
    },
  ]

  let admitted = 0
  for (const overrides of cases) {
    assert.throws(() => {
      productionExactPathPreflight(canonicalInput('DIRECT', undefined, overrides))
      admitted += 1
    }, throwsCode('EXACT_PATH_FACTS_REQUIRED'), JSON.stringify(overrides))
  }
  assert.equal(admitted, 0)
})

test('each exact route denies when its router-required capability is not authenticated', () => {
  for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) {
    const admitted = productionExactPathPreflight(canonicalInput(route))
    const validation = router.validateRouteFacts(admitted.routeFacts)
    const required = router.requiredCapabilitiesForFacts(validation.facts, route)
    assert.ok(required.length > 0, `${route} must require proved provider capabilities`)

    for (const capability of required) {
      const live = capability === 'topologyEnforcement'
        ? issueLiveReceipt(route, { controlCapabilities: [] })
        : issueLiveReceipt(route)
      const withoutRequired = capabilityEvidence(live, {
        verifiedCapabilities: [
          ...live.receipt.capabilitySet,
          ...live.receipt.controlCapabilitySet,
        ].filter(item => item !== capability),
      })
      assert.throws(
        () => productionExactPathPreflight(canonicalInput(route, undefined, {
          providerCapabilityEvidence: withoutRequired,
        }, live)),
        throwsCode('EXACT_PATH_PROVIDER_UNSUPPORTED'),
        `${route}: ${capability}`,
      )
    }
  }
})

test('missing, unauthenticated, or contradicted capability evidence denies with exact provider status', () => {
  const live = issueLiveReceipt('DIRECT')
  const falseLive = issueLiveReceipt('DIRECT', {
    providerCapabilities: { ...providerCapabilities, isolatedChecking: false },
  })
  const cases = [
    { live, overrides: { providerCapabilityEvidence: null } },
    {
      live,
      overrides: {
        providerCapabilityEvidence: {
          ...capabilityEvidence(live),
          source: 'caller-asserted-capabilities',
        },
      },
    },
    { live: falseLive, overrides: {} },
    {
      live,
      overrides: {
        providerCapabilityEvidence: capabilityEvidence(live, {
          providerCapabilitiesHash: H3,
        }),
      },
    },
  ]

  let admitted = 0
  for (const { live: caseLive, overrides } of cases) {
    assert.throws(() => {
      productionExactPathPreflight(canonicalInput('DIRECT', undefined, overrides, caseLive))
      admitted += 1
    }, throwsCode('EXACT_PATH_PROVIDER_UNSUPPORTED'), JSON.stringify(overrides))
  }
  assert.equal(admitted, 0)
})

test('production classification validates facts and capabilities without re-running automatic route choice', () => {
  const originals = {
    validateRouteFacts: router.validateRouteFacts,
    classifyRoute: router.classifyRoute,
    requiredCapabilitiesForFacts: router.requiredCapabilitiesForFacts,
  }
  const calls = []
  for (const name of Object.keys(originals)) {
    router[name] = (...args) => {
      calls.push({ name, args })
      return originals[name](...args)
    }
  }

  let receipt
  try {
    receipt = productionExactPathPreflight(canonicalInput('LIGHT'))
  } finally {
    Object.assign(router, originals)
  }

  assert.equal(calls.some(call => call.name === 'classifyRoute'), false)
  assert.deepEqual(calls.map(call => call.name), [
    'validateRouteFacts',
    'requiredCapabilitiesForFacts',
    'validateRouteFacts',
    'requiredCapabilitiesForFacts',
    'requiredCapabilitiesForFacts',
  ])
  const normalized = originals.validateRouteFacts(receipt.routeFacts).facts
  for (const offset of [0, 2]) {
    assert.deepEqual(calls[offset].args[0], receipt.routeFacts)
    assert.deepEqual(calls[offset + 1].args, [normalized, 'LIGHT'])
  }
  assert.deepEqual(calls[4].args, [normalized, 'LIGHT'])
})
