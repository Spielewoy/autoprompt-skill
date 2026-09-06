#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const decisions = require('../../agents/codex/workflow/route-decision.js')
const {
  canonicalizeCheckerVerificationLimitation,
  validateLiveCheckingPlan,
} = require('../../agents/codex/workflow/phase-budget.js')

const LIMITATION_EVENTS = Object.freeze([
  'DEPENDENCY_UNAVAILABLE',
  'DOWNSTREAM_CONSUMER_RECEIPT_MISSING',
  'EXTERNAL_CONSUMER_UNAVAILABLE',
  'EXTERNAL_LIBRARY_UNAVAILABLE',
  'EXTERNAL_TOOL_UNAVAILABLE',
  'REQUIRED_CHECK_RUNTIME_UNAVAILABLE',
])

function merge(base, overrides) {
  const output = structuredClone(base)
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) {
      output[key] = merge(output[key], value)
    } else {
      output[key] = structuredClone(value)
    }
  }
  return output
}

function routeFacts(overrides = {}) {
  return merge({
    schemaVersion: '2.0.0',
    requestedEffect: 'report',
    successCriteria: 'ready',
    dependency: {
      shape: 'bounded', dependentWorkGroupCount: 1,
      integrationOwnerRequired: false, separateDependentBodies: 1,
    },
    uncertainty: 'none',
    reversibility: 'fully-reversible',
    mutableResources: [],
    sideEffects: [],
    externality: 'local-only',
    confidentiality: 'internal',
    thirdPartyImpact: 'none',
    targetAuthorization: {
      targetIdentities: [], authorizedTargetIdentities: [], authorizationEvidenceHash: null,
    },
    costAuthority: {
      mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0,
      approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null,
    },
    riskAndIndependentCheckFloor: {
      level: 'ordinary', minimumCheckerCount: 1, namedDistinctResponsibilities: [],
    },
    checkAndBaseline: {
      checkQuality: 'authoritative', availableCheckKinds: ['observable-result'],
      baselineStatus: 'not-applicable', hiddenExternalCheck: false,
    },
    deadlineBudget: {
      remainingSeconds: 1200, admissionSeconds: 240, executionReserveSeconds: 480,
      verificationReserveSeconds: 240, recoveryAndFinalizationReserveSeconds: 120,
    },
    operatorMinimumRoute: null,
    transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true },
    candidateFreeze: { required: true, available: true, environmentCanBeBound: true },
    missingUserInput: [],
    architectureImpact: 'local',
    fitsLightPlan: true,
    approachNeedsShortPlanning: false,
    shortOrderUnclear: false,
  }, overrides)
}

function limitation(event, overrides = {}) {
  return merge({
    code: 'FAIL',
    description: 'The checker could not execute the required semantic consumer.',
    stateClass: 'terminal',
    cause: {
      event,
      reason: 'the required capability is unavailable in this environment',
      unblockPath: null,
    },
    payload: {
      verificationLimitation: {
        kind: 'CAPABILITY_UNAVAILABLE',
        capabilityId: 'external.semantic-consumer',
        explicitUserDeliverable: false,
        observedVersionDefectIds: [],
      },
    },
  }, overrides)
}

function stableLimitationEvent(input) {
  const event = input && input.cause && input.cause.event
  return LIMITATION_EVENTS.includes(event)
    ? event : 'REQUIRED_CHECK_RUNTIME_UNAVAILABLE'
}

test('every canonical verification-limitation event converts legacy FAIL exactly once', () => {
  for (const event of LIMITATION_EVENTS) {
    const input = limitation(event)
    const canonical = canonicalizeCheckerVerificationLimitation(input)
    assert.notStrictEqual(canonical, input, event)
    assert.equal(canonical.code, 'CHECK_INCONCLUSIVE', event)
    assert.equal(canonical.stateClass, 'intermediate', event)
    assert.equal(canonical.cause.event, event)
    assert.deepEqual(canonical.payload.verificationLimitation,
      input.payload.verificationLimitation)
  }
})

const ODD_LIMITATION_VOCABULARY = [
  ['custom alias', limitation('CAPABILITY_UNAVAILABLE')],
  ['CAD archive alias', limitation('AUTHORITATIVE_STEP_CONSUMER_UNAVAILABLE')],
  ['browser archive alias', limitation('DOWNSTREAM_BROWSER_UNAVAILABLE')],
  ['hidden-oracle archive alias', limitation('HIDDEN_EXTERNAL_ORACLE_UNAVAILABLE')],
  ['lowercase event', limitation('external_tool_unavailable')],
  ['whitespace-normalized event', limitation(' EXTERNAL_TOOL_UNAVAILABLE ')],
  ['canonical value only in cause.code', limitation('CHECK_INCONCLUSIVE', {
    cause: { event: 'CHECK_INCONCLUSIVE', code: 'EXTERNAL_TOOL_UNAVAILABLE' },
  })],
  ['canonical value only in payload.status', limitation('CHECK_INCONCLUSIVE', {
    payload: { status: 'EXTERNAL_TOOL_UNAVAILABLE' },
  })],
  ['canonical value only in payload.code', limitation('CHECK_INCONCLUSIVE', {
    payload: { code: 'EXTERNAL_TOOL_UNAVAILABLE' },
  })],
  ['redundant cause code alias', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    cause: { code: 'EXTERNAL_TOOL_UNAVAILABLE' },
  })],
  ['contradictory payload status', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { status: 'PASS' },
  })],
  ['missing cause', limitation('EXTERNAL_TOOL_UNAVAILABLE', { cause: null })],
  ['non-string event', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    cause: { event: 42 },
  })],
  ['already-inconclusive typed limitation', limitation('novel-capability-alias', {
    code: 'CHECK_INCONCLUSIVE', stateClass: 'intermediate',
  })],
  ['maximum-length capability identity', limitation('novel-capability-alias', {
    payload: { verificationLimitation: { capabilityId: `a${'x'.repeat(127)}` } },
  })],
  ['punctuated capability identity', limitation('novel-capability-alias', {
    payload: { verificationLimitation: { capabilityId: 'tool:browser-driver_v2' } },
  })],
]

for (const [name, input] of ODD_LIMITATION_VOCABULARY) {
  test(`exact typed verification limitation is authoritative despite odd vocabulary: ${name}`, () => {
    const canonical = canonicalizeCheckerVerificationLimitation(input)
    assert.notStrictEqual(canonical, input)
    assert.equal(canonical.code, 'CHECK_INCONCLUSIVE')
    assert.equal(canonical.stateClass, 'intermediate')
    assert.equal(canonical.cause.event, stableLimitationEvent(input))
    assert.deepEqual(canonical.payload.verificationLimitation,
      input.payload.verificationLimitation)
  })
}

const MALFORMED_TYPED_LIMITATIONS = [
  ['explicit requested deliverable', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { explicitUserDeliverable: true } },
  })],
  ['observed exact-version defect', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { observedVersionDefectIds: ['defect-1'] } },
  })],
  ['missing capability identity', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { capabilityId: '' } },
  })],
  ['extra limitation field', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { environment: 'same' } },
  })],
  ['wrong kind', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { kind: 'RUNTIME_UNAVAILABLE' } },
  })],
  ['invalid capability identity', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { capabilityId: 'External tool' } },
  })],
  ['overlong capability identity', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { capabilityId: `a${'x'.repeat(128)}` } },
  })],
  ['non-boolean explicit-deliverable flag', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { explicitUserDeliverable: 'false' } },
  })],
  ['non-array observed-defect list', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    payload: { verificationLimitation: { observedVersionDefectIds: null } },
  })],
  ['concrete failure nested in cause', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    cause: {
      status: 'ASSERTION_FAILED',
      completedResults: [{ code: 'FAIL', findingIds: ['exact-version-defect'] }],
    },
  })],
  ['nonzero command nested in completed result', limitation('EXTERNAL_TOOL_UNAVAILABLE', {
    completedResults: [{ commands: [{ command: 'exact oracle', exitCode: 1 }] }],
  })],
]

for (const key of [
  'kind', 'capabilityId', 'explicitUserDeliverable', 'observedVersionDefectIds',
]) {
  const input = limitation('EXTERNAL_TOOL_UNAVAILABLE')
  delete input.payload.verificationLimitation[key]
  MALFORMED_TYPED_LIMITATIONS.push([`missing ${key}`, input])
}

for (const [name, input] of MALFORMED_TYPED_LIMITATIONS) {
  test(`malformed typed verification limitation is rejected: ${name}`, () => {
    assert.strictEqual(canonicalizeCheckerVerificationLimitation(input), input)
  })
}

test('live checking plans accept only canonical one- or two-seat shapes', () => {
  assert.deepEqual(validateLiveCheckingPlan({ independentCheckingPlan: {
    checkerCount: 1,
    responsibilities: ['Run the combined requirements and black-box behavior method.'],
    nonOverlapReason: null,
  } }), {
    checkerCount: 1,
    responsibilities: ['Run the combined requirements and black-box behavior method.'],
    nonOverlapReason: null,
  })

  const two = validateLiveCheckingPlan({ independentCheckingPlan: {
    checkerCount: 2,
    responsibilities: [
      'Derive expected behavior from the requirements.',
      'Falsify boundaries through the shipped runtime.',
    ],
    nonOverlapReason: 'Requirements derivation and runtime falsification use distinct methods.',
  } })
  assert.equal(two.checkerCount, 2)
  assert.equal(new Set(two.responsibilities).size, 2)

  for (const invalid of [
    { checkerCount: 0, responsibilities: [] },
    { checkerCount: 3, responsibilities: ['one', 'two', 'three'] },
    { checkerCount: 1, responsibilities: ['one', 'two'] },
    { checkerCount: 2, responsibilities: ['same method', 'same method'] },
  ]) {
    assert.throws(
      () => validateLiveCheckingPlan({ independentCheckingPlan: invalid }),
      error => error.code === 'INDEPENDENT_CHECKING_PLAN_INVALID',
    )
  }
})

test('route selection admits a second checker only for two available typed executable methods', () => {
  const ordinary = decisions.selectIndependentChecking({ facts: routeFacts({
    riskAndIndependentCheckFloor: {
      level: 'elevated', minimumCheckerCount: 1, namedDistinctResponsibilities: [],
    },
    requestedEffect: 'mutate',
    mutableResources: [
      { kind: 'file', identity: 'src/local.js', shared: true, ownershipMode: 'exclusive-lease' },
    ],
    sideEffects: ['deliverable-write', 'permission-change'],
  }) })
  assert.equal(ordinary.valid, true)
  assert.equal(ordinary.checkerCount, 1)

  const methods = [
    '[command:requirements-suite] Derive expected outputs from the immutable requirements.',
    '[oracle:runtime-boundary] Exercise negative and boundary cases through the shipped runtime.',
  ]
  const explicit = decisions.selectIndependentChecking({ facts: routeFacts({
    riskAndIndependentCheckFloor: {
      level: 'elevated', minimumCheckerCount: 2, namedDistinctResponsibilities: methods,
    },
    checkAndBaseline: {
      availableCheckKinds: ['command:requirements-suite', 'oracle:runtime-boundary'],
    },
  }) })
  assert.equal(explicit.valid, true)
  assert.equal(explicit.checkerCount, 2)
  assert.match(explicit.responsibilities[0], new RegExp(methods[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(explicit.responsibilities[1], new RegExp(methods[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  for (const namedDistinctResponsibilities of [
    [],
    ['Only one named method is not enough.'],
    ['Same executable method.', ' same executable method. '],
    ['First executable method.', 'Second executable method.', 'Third executable method.'],
    ['[command:missing] Unbound command.', '[oracle:missing] Unbound oracle.'],
  ]) {
    const selected = decisions.selectIndependentChecking({ facts: routeFacts({
      riskAndIndependentCheckFloor: {
        level: 'elevated', minimumCheckerCount: 2, namedDistinctResponsibilities,
      },
    }) })
    assert.equal(selected.valid, true, JSON.stringify(namedDistinctResponsibilities))
    assert.equal(selected.checkerCount, 1, JSON.stringify(namedDistinctResponsibilities))
    assert.equal(selected.responsibilities.length, 1, JSON.stringify(namedDistinctResponsibilities))
    assert.match(selected.nonOverlapReason, /second checker was not admitted/u)
  }
})

test('checker selection remains bound to validated route facts', () => {
  const facts = routeFacts({
    riskAndIndependentCheckFloor: {
      level: 'elevated', minimumCheckerCount: 2,
      namedDistinctResponsibilities: [
        'Inspect the immutable request contract.',
        'Run an independent black-box observation.',
      ],
    },
  })
  const first = decisions.selectIndependentChecking({ facts })
  const second = decisions.selectIndependentChecking({ facts: structuredClone(facts) })
  assert.equal(first.valid, true)
  assert.deepEqual(second, first)
  assert.match(first.derivedFromFactsFingerprint, /^[a-f0-9]{64}$/)
})
