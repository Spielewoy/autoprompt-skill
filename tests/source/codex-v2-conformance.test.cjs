#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'codex-v2-conformance')
const router = require('../../agents/codex/workflow/router.js')
const decisions = require('../../agents/codex/workflow/route-decision.js')
const settings = require('../../agents/codex/workflow/settings.js')
const runtimeState = require('../../agents/codex/workflow/runtime-state.js')
const { MissionLock } = require('../../agents/codex/workflow/mission-lock.js')
const { BudgetController, resolveCeilings, validatePhases } = require('../../agents/codex/workflow/budget-controller.js')
const {
  MAX_L3_BRIEF_BYTES,
  auditDispatch,
  buildCheckerContext,
  buildContextFreeBrief,
  loadRequestEnvelope,
  writeRequestEnvelope,
} = require('../../agents/codex/workflow/context-envelope.js')

const machine = require('../../agents/contracts/state-machine.json')
const providers = require('../../agents/contracts/providers.json')
const qualitySchema = require('../../agents/contracts/schemas/outcome-quality-gate.schema.json')
const routeCorpus = require('../fixtures/codex-v2-conformance/semantic-route-corpus.json')
const failureCorpus = require('../fixtures/codex-v2-conformance/failure-taxonomy.json')
const economicCorpus = require('../fixtures/codex-v2-conformance/economic-route-envelope.json')
const qualityCorpus = require('../fixtures/codex-v2-conformance/outcome-quality-fixtures.json')
const providerParity = require('../fixtures/codex-v2-conformance/cross-provider-capability-parity.json')

const H = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const PROVIDER_CAPABILITIES = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function merge(base, overrides) {
  const result = clone(base)
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value)
    } else result[key] = clone(value)
  }
  return result
}

function baseFacts(overrides = {}) {
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
      remainingSeconds: 2400, admissionSeconds: 240, executionReserveSeconds: 600,
      verificationReserveSeconds: 300, recoveryAndFinalizationReserveSeconds: 180,
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

function eventEvidence(event) {
  return router.ROUTE_CONTRACT.escalationEvents[event].requiredEvidence.map((kind, index) => ({
    kind, value: `recorded ${kind}`, evidence_ref: `events.jsonl#${index + 1}`,
  }))
}

function pointer(root, ref) {
  return ref.slice(2).split('/').reduce((value, part) => value[part.replaceAll('~1', '/').replaceAll('~0', '~')], root)
}

function schemaErrors(value, schema, root = schema, at = '$') {
  const errors = []
  const visit = (current, rule, location) => {
    if (rule.$ref) return visit(current, pointer(root, rule.$ref), location)
    if (Object.hasOwn(rule, 'const') && JSON.stringify(current) !== JSON.stringify(rule.const)) errors.push(`${location}: const`)
    if (rule.enum && !rule.enum.includes(current)) errors.push(`${location}: enum`)
    const actual = current === null ? 'null' : Array.isArray(current) ? 'array' : Number.isInteger(current) ? 'integer' : typeof current
    const types = rule.type === undefined ? null : Array.isArray(rule.type) ? rule.type : [rule.type]
    if (types && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
      errors.push(`${location}: type`)
      return
    }
    if (actual === 'object') {
      for (const key of rule.required || []) if (!Object.hasOwn(current, key)) errors.push(`${location}: missing ${key}`)
      for (const [key, child] of Object.entries(rule.properties || {})) {
        if (Object.hasOwn(current, key)) visit(current[key], child, `${location}.${key}`)
      }
      if (rule.additionalProperties === false) {
        for (const key of Object.keys(current)) if (!Object.hasOwn(rule.properties || {}, key)) errors.push(`${location}: extra ${key}`)
      }
    }
    if (actual === 'array') {
      if (rule.minItems !== undefined && current.length < rule.minItems) errors.push(`${location}: minItems`)
      if (rule.maxItems !== undefined && current.length > rule.maxItems) errors.push(`${location}: maxItems`)
      if (rule.uniqueItems && new Set(current.map(item => JSON.stringify(item))).size !== current.length) errors.push(`${location}: duplicate`)
      if (rule.items) current.forEach((item, index) => visit(item, rule.items, `${location}[${index}]`))
    }
    if (actual === 'string') {
      if (rule.minLength !== undefined && current.length < rule.minLength) errors.push(`${location}: minLength`)
      if (rule.maxLength !== undefined && current.length > rule.maxLength) errors.push(`${location}: maxLength`)
      if (rule.pattern && !(new RegExp(rule.pattern, 'u')).test(current)) errors.push(`${location}: pattern`)
    }
    if (actual === 'integer' || actual === 'number') {
      if (rule.minimum !== undefined && current < rule.minimum) errors.push(`${location}: minimum`)
      if (rule.maximum !== undefined && current > rule.maximum) errors.push(`${location}: maximum`)
    }
  }
  visit(value, schema, at)
  return errors
}

function qualityVerdict(record) {
  const baselineAcceptance = record.baseline.acceptedCount / record.baseline.completedCount
  const treatmentAcceptance = record.treatment.acceptedCount / record.treatment.completedCount
  const baselineReward = record.baseline.rewardSum / record.baseline.completedCount
  const treatmentReward = record.treatment.rewardSum / record.treatment.completedCount
  const baselineCostPerSolve = record.baseline.totalCost / record.baseline.acceptedCount
  const treatmentCostPerSolve = record.treatment.totalCost / record.treatment.acceptedCount
  const acceptanceNonInferior = treatmentAcceptance / baselineAcceptance >= record.thresholds.minimumAcceptanceRatio
  const rewardNonInferior = treatmentReward / baselineReward >= record.thresholds.minimumRewardRatio
  const costPerSolveWithinGuardrail = treatmentCostPerSolve / baselineCostPerSolve <= record.thresholds.maximumCostPerSolveRatio
  return {
    acceptanceNonInferior,
    rewardNonInferior,
    costPerSolveWithinGuardrail,
    releaseEligible: acceptanceNonInferior && rewardNonInferior && costPerSolveWithinGuardrail &&
      record.baseline.terminalResultsComplete && record.treatment.terminalResultsComplete &&
      record.baseline.scorable && record.treatment.scorable,
  }
}

function qualitySemanticErrors(record) {
  const errors = schemaErrors(record, qualitySchema)
  for (const arm of [record.baseline, record.treatment]) {
    if (arm.acceptedCount > arm.completedCount) errors.push(`${arm.armId}: accepted exceeds completed`)
    if (arm.acceptedCount === 0) errors.push(`${arm.armId}: cost per solve is undefined`)
  }
  if (record.baseline.armId === record.treatment.armId) errors.push('arms must be distinct')
  if (JSON.stringify(record.verdict) !== JSON.stringify(qualityVerdict(record))) errors.push('stored verdict does not match observations')
  return errors
}

test('AP-TEST-023 semantic router corpus classifies all ten requested domains without a default', () => {
  assert.equal(routeCorpus.evidenceClass, 'sealed-semantic-conformance-corpus')
  assert.deepEqual(routeCorpus.missions.map(({ domain }) => domain).sort(),
    ['binary', 'bug', 'cad', 'checkpoint', 'database-writeback', 'docs', 'research', 'soc', 'typo', 'xss'])
  const rows = routeCorpus.missions.map(mission => {
    const result = router.classifyRoute(baseFacts(mission.overrides))
    assert.equal(result.status, 'DECIDED', mission.id)
    assert.equal(result.route, mission.expectedRoute, mission.id)
    return { expected_route: mission.expectedRoute, actual_route: result.route }
  })
  const metrics = router.scoreRoutePredictions(rows)
  assert.equal(metrics.accuracy, 1)
  assert.equal(metrics.under_routing_count, 0)
  const missingEffect = baseFacts()
  delete missingEffect.requestedEffect
  assert.notEqual(router.classifyRoute(missingEffect).status, 'DECIDED')
})

test('AP-TEST-024 state graph has one next state, rejects invalid edges, reaches terminals, and keeps terminals closed', () => {
  const states = new Set(machine.states)
  const terminals = new Set(machine.terminalStates)
  const seen = new Set()
  const expanded = machine.transitions.flatMap(transition =>
    (Array.isArray(transition.from) ? transition.from : [transition.from]).map(from => ({ ...transition, from })))
  for (const transition of expanded) {
    const key = `${transition.from}\0${transition.event}`
    assert.equal(seen.has(key), false, key)
    seen.add(key)
    assert.equal(terminals.has(transition.from), false)
    const to = transition.to === '$same' ? transition.from : transition.to
    if (!to.startsWith('$')) assert.equal(runtimeState.isLegalTransition(transition.from, to, transition.event), true)
  }
  assert.equal(runtimeState.isLegalTransition('DONE', 'RUN_WORK', 'BOOTSTRAP'), false)
  assert.equal(runtimeState.isLegalTransition('RUN_WORK', 'DONE', 'MADE_UP'), false)
  const reachable = new Set([machine.initialState])
  for (let changed = true; changed;) {
    changed = false
    for (const transition of expanded) {
      const to = transition.to === '$same' ? transition.from : transition.to
      if (reachable.has(transition.from) && states.has(to) && !reachable.has(to)) {
        reachable.add(to); changed = true
      }
    }
  }
  for (const terminal of terminals) assert.equal(reachable.has(terminal), true, terminal)
})

test('AP-TEST-025 failure taxonomy replays typed statuses and every declared route is bounded', () => {
  const replays = {
    'route-analyst-crash': () => decisions.evaluateRouteAnalystResult({
      admission: decisions.createRouteAnalystAdmission(), elapsed_ms: 1, outcome: 'CRASH',
    }).status,
    'l0-timeout': () => decisions.evaluateL0Decision({
      started_at_ms: 0, submitted_at_ms: decisions.L0_DECISION_MAX_DURATION_MS + 1,
      now_ms: decisions.L0_DECISION_MAX_DURATION_MS + 1, decision: {},
    }).status,
    'provider-policy-denial': () => decisions.evaluateRouteEvent({
      event: 'CAPABILITY_LOST', evidence: eventEvidence('CAPABILITY_LOST'),
    }).status,
    'deadline-budget-insufficient': () => router.classifyRoute(baseFacts({
      deadlineBudget: {
        remainingSeconds: 1, admissionSeconds: 240, executionReserveSeconds: 600,
        verificationReserveSeconds: 300, recoveryAndFinalizationReserveSeconds: 180,
      },
    })).status,
    'malformed-context-brief': () => {
      try {
        buildContextFreeBrief({
          role: 'ap-worker', assignment: 'invalid inherited context',
          requestPointer: { path: 'request/envelope.jsonl', hash: H },
          providerCapabilities: PROVIDER_CAPABILITIES, fullHistory: ['forbidden'],
        })
      } catch (error) { return error.code }
      return 'UNEXPECTED_PASS'
    },
    'flaky-check': () => decisions.evaluateRouteEvent({
      event: 'ORACLE_FAILURE', evidence: eventEvidence('ORACLE_FAILURE'),
    }).status,
    'missing-user-credential': () => router.classifyRoute(baseFacts({
      missingUserInput: ['Provide the required credential through an authorized channel.'],
    })).status,
    'oracle-unavailable': () => decisions.evaluateRouteEvent({
      event: 'ORACLE_FAILURE', evidence: eventEvidence('ORACLE_FAILURE'),
    }).status,
  }
  const transitionIds = new Set(machine.transitions.map(({ id }) => id))
  for (const entry of failureCorpus.entries) {
    assert.equal(replays[entry.apiReplay](), entry.expectedStatus, entry.id)
    assert.ok(entry.transitionIds.length <= entry.maxTransitions, entry.id)
    for (const id of entry.transitionIds) assert.equal(transitionIds.has(id), true, `${entry.id}:${id}`)
  }
})

test('AP-TEST-026 duplicate target lease admits one owner, writes no second-owner bytes, and safely takes stale ownership', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-v2-lease-conformance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  const leaseRoot = path.join(root, 'leases')
  fs.mkdirSync(target)
  const base = {
    targetPath: target, ledgerPath: path.join(target, '.autoprompt'),
    runId: 'run-owner-one', activationId: 'activation-one', missionHash: H,
    nonce: 'nonce_123456789012', generation: 1, pid: 101,
    processIdentity: 'pid-101-start-a', token: 'a'.repeat(48),
  }
  // Match the runtime-state fixture's fake OS epoch semantics: acquire() may
  // echo the exact requested epoch, while probes of a persisted owner resolve
  // the deterministic epoch currently observed for that pid.
  const leaseProcessObserver = observe =>
    (pid, requestedIdentity) => requestedIdentity || observe(pid)
  const liveEpochObserver = leaseProcessObserver(pid =>
    pid === 101 ? 'pid-101-start-a' : null)
  const deadEpochObserver = leaseProcessObserver(() => null)

  const missingEpochLock = new MissionLock({
    leaseRoot: path.join(root, 'missing-epoch'), processIdentityObserver: () => null,
  })
  assert.throws(() => missingEpochLock.acquire(base), error => error.code === 'LEASE_INPUT_INVALID')
  const reusedPidLock = new MissionLock({
    leaseRoot: path.join(root, 'reused-pid'), processIdentityObserver: () => 'pid-101-start-reused',
  })
  assert.throws(() => reusedPidLock.acquire(base), error => error.code === 'LEASE_INPUT_INVALID')

  const firstLock = new MissionLock({
    processIdentityObserver: liveEpochObserver,
    leaseRoot, identityProbe: () => ({ alive: true, verified: true, processIdentity: 'pid-101-start-a' }),
    randomId: () => 'lease-one',
  })
  const first = firstLock.acquire(base)
  const ownerPath = firstLock.describe(first).ownerPath
  const before = fs.readFileSync(ownerPath)
  const secondLock = new MissionLock({
    processIdentityObserver: liveEpochObserver,
    leaseRoot, identityProbe: () => ({ alive: true, verified: true, processIdentity: 'pid-101-start-a' }),
  })
  assert.throws(() => secondLock.acquire({
    ...base, runId: 'run-owner-two', activationId: 'activation-two', pid: 202,
    processIdentity: 'pid-202-start-b', token: 'b'.repeat(48),
  }), error => error.code === 'WORKSPACE_LEASE_CONFLICT')
  assert.deepEqual(fs.readFileSync(ownerPath), before)
  const staleLock = new MissionLock({
    processIdentityObserver: deadEpochObserver,
    leaseRoot, identityProbe: () => ({ alive: false, verified: true, liveOwnedIdentities: [] }),
    randomId: () => 'lease-two',
  })
  const replacement = staleLock.acquire({
    ...base, runId: 'run-owner-two', activationId: 'activation-two', pid: 202,
    processIdentity: 'pid-202-start-b', token: 'b'.repeat(48),
  })
  assert.equal(staleLock.describe(replacement).owner.activationId, 'activation-two')
  assert.equal(fs.readdirSync(leaseRoot).filter(name => name.includes('.stale.lease-one.')).length, 1)
  staleLock.release(replacement)
})

test('AP-TEST-027 synthetic economic simulations stay within route envelopes and keep effort independent', () => {
  assert.match(economicCorpus.evidenceClass, /not-provider-canary/)
  for (const simulation of economicCorpus.simulations) {
    const cap = economicCorpus.routeCaps[simulation.route]
    for (const field of ['childLaunches', 'contextBytes', 'noncachedInputTokens', 'outputTokens', 'usefulWorkLatencyMs']) {
      assert.ok(simulation.observed[field] <= cap[field], `${simulation.id}:${field}`)
    }
    assert.ok(cap.allowedEfforts.includes(simulation.observed.effort), simulation.id)
    assert.ok(simulation.effortInput.role && simulation.effortInput.difficulty && simulation.effortInput.risk)
  }
  const mutation = clone(economicCorpus.simulations[0])
  mutation.observed.childLaunches = economicCorpus.routeCaps.DIRECT.childLaunches + 1
  assert.ok(mutation.observed.childLaunches > economicCorpus.routeCaps.DIRECT.childLaunches)
})

test('AP-TEST-028 outcome-quality gate requires non-inferior acceptance/reward and guarded cost per solve', () => {
  assert.match(qualityCorpus.evidenceClass, /not-provider-canary/)
  for (const fixture of qualityCorpus.cases) {
    assert.deepEqual(qualitySemanticErrors(fixture.record), [], fixture.id)
    assert.equal(fixture.record.verdict.releaseEligible, fixture.expectedReleaseEligible, fixture.id)
  }
  const swapped = clone(qualityCorpus.cases[0].record)
  swapped.verdict = clone(qualityCorpus.cases[1].record.verdict)
  assert.notDeepEqual(qualitySemanticErrors(swapped), [])
  const unscorable = clone(qualityCorpus.cases[0].record)
  unscorable.treatment.scorable = false
  unscorable.verdict = qualityVerdict(unscorable)
  assert.notDeepEqual(qualitySemanticErrors(unscorable), [])
  const extra = clone(qualityCorpus.cases[0].record)
  extra.uncontractedMetric = 1
  assert.notDeepEqual(qualitySemanticErrors(extra), [])
})

test('AP-TEST-029 nine-provider parity table fails closed without real signed canary evidence', () => {
  assert.equal(providerParity.evidenceClass, 'schema-conformance-not-real-provider-canary')
  assert.equal(providerParity.realProviderCanaryRequiredForSupportedClaim, true)
  const ids = providers.providers.map(({ id }) => id).sort()
  assert.deepEqual(ids, providerParity.providerIds)
  const axes = Object.keys(providers.capabilityDefinitions).sort()
  assert.deepEqual(axes, providerParity.requiredCapabilityAxes.slice().sort())
  for (const provider of providers.providers) {
    assert.deepEqual(Object.keys(provider.capabilities).sort(), axes)
    assert.equal(provider.verificationAttestation, null)
    assert.equal(provider.defaultAdmission, 'refuse-until-p8-verification')
    for (const value of Object.values(provider.capabilities)) assert.ok(providers.safeSupportValues.includes(value))
  }
  assert.deepEqual(providerParity.behavioralCases, ['route', 'edge', 'permission', 'resume', 'terminal'])
})

test('AP-TEST-030 hostile budget and settings inputs fail closed before any launch and cannot raise ceilings', () => {
  const product = { wallMs: 1000, tokens: 100, sessions: 3, launches: 4 }
  assert.deepEqual(resolveCeilings({ product, user: {
    wallMs: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER,
    sessions: Number.MAX_SAFE_INTEGER, launches: Number.MAX_SAFE_INTEGER,
  } }), product)
  for (const invalid of [0, -1, '4', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveCeilings({ product: { ...product, wallMs: invalid } }))
  }
  assert.throws(() => validatePhases({ EXECUTION: { softMs: 500, hardMs: 500 } }))
  assert.throws(() => validatePhases({ EXECUTION: { softMs: 600, hardMs: 500 } }))
  assert.throws(() => new BudgetController({
    limits: product, phases: {}, finalizationReserveMs: 1000,
    accountingCeilings: { retries: 1, costMicrounits: 1 },
  }))
  const hostileSettings = settings.resolveSettings({
    explicit: { concurrency: { mode: 'custom', maxSubs: Number.MAX_SAFE_INTEGER } },
    provider: { id: 'codex', wideMaxSubs: 8 }, capabilities: { modelRouting: false }, interactive: false,
  })
  assert.equal(hostileSettings.status, 'READY')
  assert.equal(hostileSettings.concurrency.effectiveMaxSubs, 8,
    'a syntactically valid large request is clamped to the provider ceiling')
  const malformedSettings = settings.resolveSettings({
    explicit: { concurrency: { mode: 'custom', maxSubs: Infinity } },
    provider: { id: 'codex', wideMaxSubs: 8 }, capabilities: { modelRouting: false }, interactive: false,
  })
  assert.notEqual(malformedSettings.status, 'READY')
})

test('AP-TEST-031 context envelope keeps L3 compact and lets L4 load the byte-identical exact request', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-v2-context-conformance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = Buffer.from('Fix the parser and preserve this exact trailing newline.\n', 'utf8')
  const pointerRecord = writeRequestEnvelope(root, original, { route: 'DIRECT' })
  assert.deepEqual(loadRequestEnvelope(pointerRecord, { asBuffer: true }), original)
  const dispatch = buildContextFreeBrief({
    role: 'ap-worker', assignment: 'Repair the bounded parser behavior.',
    successChecklist: ['The failing case turns green.'], ownership: ['src/parser.js'],
    checks: ['node --test test/parser.test.js'], requestPointer: pointerRecord,
    providerCapabilities: PROVIDER_CAPABILITIES,
  })
  assert.ok(dispatch.briefBytes <= MAX_L3_BRIEF_BYTES)
  assert.equal(dispatch.brief.includes(original.toString('utf8')), false)
  for (const forbidden of ['fullHistory', 'conversationHistory', 'priorVerdicts', 'foreignFrontier']) {
    assert.equal(Object.hasOwn(dispatch, forbidden), false)
  }
  const checker = buildCheckerContext({
    role: 'ap-independent-checker', assignment: 'Check the exact candidate.',
    requestPointer: pointerRecord, expectedRequestHash: pointerRecord.hash,
    candidateHash: H2, providerCapabilities: PROVIDER_CAPABILITIES,
  }, { asBuffer: true })
  assert.deepEqual(checker.exactRequest, original)
  assert.equal(checker.exactRequestHash, pointerRecord.hash)
})

test('AP-TEST-032 captured normal dispatches are context-free and full-history forks are rejected', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-v2-dispatch-conformance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pointerRecord = writeRequestEnvelope(root, 'Inspect the exact request.\n', { route: 'DIRECT' })
  const captured = [
    buildContextFreeBrief({
      role: 'ap-worker', assignment: 'Own one bounded result.', requestPointer: pointerRecord,
      providerCapabilities: PROVIDER_CAPABILITIES,
    }),
    buildCheckerContext({
      role: 'ap-independent-checker', assignment: 'Check one exact candidate.', requestPointer: pointerRecord,
      expectedRequestHash: pointerRecord.hash, candidateHash: H,
      providerCapabilities: PROVIDER_CAPABILITIES,
    }),
  ]
  for (const dispatch of captured) {
    assert.equal(dispatch.fork_turns, 'none')
    assert.equal(dispatch.activation, 'context-free')
    assert.deepEqual(auditDispatch(dispatch).violations, [])
  }
  const hostile = clone(captured[0])
  hostile.fork_turns = 'all'
  hostile.fullHistory = ['entire conversation']
  assert.equal(auditDispatch(hostile).conformant, false)
})
