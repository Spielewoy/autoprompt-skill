#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const router = require('./router.js')
const capturedDomain = require('./captured-domain.js')
const { validateJsonSchema } = require('./json-schema-validator.js')
const { ROUTES } = router
const GATE_CONTRACT = require('../../contracts/gates.json')

const ROUTE_RECOMMENDATION_SCHEMA = require('../../contracts/schemas/route-recommendation.schema.json')
const ROUTE_DECISION_SCHEMA = require('../../contracts/schemas/route-decision.schema.json')
const ROUTE_RECOMMENDATION_SCHEMA_VERSION = '2.0.0'
const ROUTE_DECISION_SCHEMA_VERSION = '2.0.0'
const ROUTE_RECOMMENDATION_SCHEMA_ID = ROUTE_RECOMMENDATION_SCHEMA.$id
const ROUTE_DECISION_SCHEMA_ID = ROUTE_DECISION_SCHEMA.$id
const ROUTE_ANALYST_ADMISSION_SCHEMA_ID = 'autoprompt.route-analyst-admission.v2'
const ROUTE_ANALYST_MAX_DURATION_MS = 2 * 60 * 1000
const L0_DECISION_MAX_DURATION_MS = 4 * 60 * 1000
const L0_DECISION_CONVERGENCE_WATCHDOG_MS = 30 * 60 * 1000
const LIGHT_PLAN_MAX_DURATION_MS = 5 * 60 * 1000
const MAX_LIGHT_PLAN_BULLETS = 15
const ROUTE_TOPOLOGY_CHILD_CEILINGS = Object.freeze({ DIRECT: 9, LIGHT: 9, ROADMAP: 18 })
const DETERMINISTIC_ROADMAP_EXECUTION_MODE = 'deterministic-roadmap-v1'
const EXECUTABLE_CHECK_KIND = /^(?:command|oracle|adapter):[a-z0-9][a-z0-9._/-]*$/u
const TYPED_CHECKER_METHOD = /^\[([^\]]+)\]\s+(.+)$/u

function l0DecisionMaxDurationMs() {
  return L0_DECISION_MAX_DURATION_MS
}

function routeAnalystMaxDurationMs() {
  return ROUTE_ANALYST_MAX_DURATION_MS
}

const RECOMMENDATION_ARRAY_FIELDS = Object.freeze([
  'whatTheUserWants',
  'likelyAreas',
  'howSuccessCanBeChecked',
  'unknowns',
  'risks',
  'independentWorkItems',
  'dependencies',
  'reasonsForDirect',
  'reasonsForLight',
  'reasonsForRoadmap',
  'userInputNeeded',
])

const DECISION_ARRAY_FIELDS = Object.freeze([
  'successChecklist',
  'plannedChecks',
  'likelyAreas',
  'risks',
  'missingInformation',
])

const ROUTE_CHANGE_RULES = Object.freeze({
  SPEC_MISUNDERSTOOD: Object.freeze({ directions: ['DIRECT>LIGHT'], description: 'Acceptance evidence proves the request or design was misunderstood.' }),
  REVERSIBLE_DESIGN_UNRESOLVED: Object.freeze({ directions: ['DIRECT>LIGHT'], description: 'A newly proven reversible technical choice needs short planning.' }),
  MULTI_SURFACE_DISCOVERED: Object.freeze({ directions: ['LIGHT>ROADMAP'], description: 'At least two dependent writable outputs now require integration.' }),
  ARCHITECTURE_FORK_DISCOVERED: Object.freeze({ directions: ['LIGHT>ROADMAP'], description: 'A newly proven architecture choice crosses systems or public contracts.' }),
  DEPENDENCY_REMOVED_BEFORE_PRODUCTION_WRITE: Object.freeze({ directions: ['ROADMAP>LIGHT'], description: 'New evidence removes the dependency or integration need before production writes.' }),
  UNCERTAINTY_RESOLVED_BEFORE_PRODUCTION_WRITE: Object.freeze({ directions: ['LIGHT>DIRECT'], description: 'New evidence resolves the implementation uncertainty before production writes.' }),
})

const ESCALATION_EVENTS = Object.freeze(Object.keys(router.ROUTE_CONTRACT.escalationEvents))
const NO_PROGRESS_BOUNDARIES = Object.freeze({
  BUDGET_EXHAUSTED: 'PAUSED',
  AUTHORITY_REQUIRED: 'WAITING_USER',
  PROVIDER_UNSUPPORTED: 'PROVIDER_UNSUPPORTED',
  ENVIRONMENT_BLOCKED: 'BLOCKED',
  CANCEL_REQUESTED: 'CANCELLED',
})

const NON_ROUTING_FAILURES = new Set([
  'IMPLEMENTATION_DEFECT',
  'MISSING_EDGE_CASE',
  'REGRESSION',
  'CHECK_DEFECT',
  'TRANSIENT_RUNTIME',
  'CHECK_INCONCLUSIVE',
  'NO_PROGRESS',
])

const ROUTE_ANALYST_FALLBACK_OUTCOMES = Object.freeze([
  'TIMEOUT', 'CRASH', 'PROVIDER_UNSUPPORTED', 'MALFORMED',
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.every(nonEmpty)
}

function requiredNonEmptyStringArray(value) {
  return nonEmptyStringArray(value) && value.length > 0
}

function concrete(value) {
  if (!nonEmpty(value)) return false
  const text = value.trim().toLowerCase()
  return !['n/a', 'none', 'tbd', 'todo', 'because', 'default', 'as needed', 'unknown'].includes(text)
}

const VERIFICATION_OBLIGATION_KINDS = new Set(['invariant', 'activation', 'ordered-activation'])
const VERIFICATION_PHASES = new Set(['ordinary', 'inactive', 'boundary', 'intermediate', 'active'])
const VERIFICATION_POLARITIES = new Set(['must-hold', 'must-not-hold'])

function defaultVerificationObligations(checks = []) {
  return (Array.isArray(checks) ? checks : []).map((statement, index) => ({
    id: `obligation-${index + 1}`,
    kind: 'invariant',
    statement: String(statement),
    cases: [
      {
        id: 'expected',
        phase: 'ordinary',
        polarity: 'must-hold',
        precondition: 'the named check is executed',
        expectedObservation: String(statement),
      },
    ],
  }))
}

function canonicalVerificationObligations(supplied, fallbackChecks = []) {
  const source = Array.isArray(supplied) && supplied.length > 0
    ? supplied : defaultVerificationObligations(fallbackChecks)
  if (source.length === 0) return null
  const obligationIds = new Set()
  const canonical = []
  for (const obligation of source) {
    if (!isObject(obligation) || !concrete(obligation.id) || obligationIds.has(obligation.id) ||
        !VERIFICATION_OBLIGATION_KINDS.has(obligation.kind) || !concrete(obligation.statement) ||
        !Array.isArray(obligation.cases) || obligation.cases.length === 0) return null
    obligationIds.add(obligation.id)
    const caseIds = new Set()
    const cases = []
    for (const item of obligation.cases) {
      if (!isObject(item) || !concrete(item.id) || caseIds.has(item.id) ||
          !VERIFICATION_PHASES.has(item.phase) || !VERIFICATION_POLARITIES.has(item.polarity) ||
          !concrete(item.precondition) || !concrete(item.expectedObservation)) return null
      caseIds.add(item.id)
      cases.push({
        id: item.id, phase: item.phase, polarity: item.polarity,
        precondition: item.precondition, expectedObservation: item.expectedObservation,
      })
    }
    const phases = new Set(cases.map(item => item.phase))
    const polarities = new Set(cases.map(item => item.polarity))
    const phasedActivation = obligation.kind === 'activation' || obligation.kind === 'ordered-activation'
    if (phasedActivation && (!polarities.has('must-hold') || !polarities.has('must-not-hold')) ||
        obligation.kind === 'activation' &&
          !['inactive', 'boundary', 'active'].every(phase => phases.has(phase)) ||
        obligation.kind === 'ordered-activation' &&
          (!['inactive', 'boundary', 'intermediate', 'active'].every(phase => phases.has(phase)) ||
           cases.filter(item => item.phase === 'boundary').length < 2)) return null
    canonical.push({ id: obligation.id, kind: obligation.kind, statement: obligation.statement, cases })
  }
  return canonical
}

function verificationObligationsForRequest(_requestedResult, supplied, fallbackChecks = []) {
  // The controller enforces exactly the supplied typed cases but never guesses
  // a task domain from keywords. Domain semantics belong to the route analyst's
  // structured obligations and the independent checker, so the same mechanism
  // generalizes without controller-authored expected answers.
  return canonicalVerificationObligations(supplied, fallbackChecks)
}

function defaultRouteFactProposal(route = 'DIRECT') {
  return {
    requestedEffect: 'mutate',
    dependencyShape: route === 'ROADMAP' ? 'dependent-groups' : route === 'LIGHT' ? 'connected' : 'bounded',
    dependentWorkGroupCount: route === 'ROADMAP' ? 2 : 0,
    integrationOwnerRequired: route === 'ROADMAP',
    uncertainty: route === 'LIGHT' ? 'reversible-technical' : 'none',
    reversibility: 'locally-reversible',
    mutableResources: [{ kind: 'directory', identity: '.', shared: false, ownershipMode: 'single-owner' }],
    sideEffects: ['deliverable-write'], externality: 'local-only', confidentiality: 'internal',
    thirdPartyImpact: 'none', riskLevel: 'ordinary', minimumCheckerCount: 1,
    namedDistinctResponsibilities: [],
    checkQuality: 'authoritative', availableCheckKinds: ['focused-test'], baselineStatus: 'recorded',
    hiddenExternalCheck: false, architectureImpact: route === 'ROADMAP' ? 'multi-system' : 'local',
    fitsLightPlan: true, approachNeedsShortPlanning: route === 'LIGHT', shortOrderUnclear: false,
  }
}

const ROUTER_PROPOSAL_FACTS = router.ROUTE_FACTS_SCHEMA.properties
const ROUTER_RESOURCE_KINDS = new Set(
  ROUTER_PROPOSAL_FACTS.mutableResources.items.properties.kind.enum,
)
const ROUTER_OWNERSHIP_MODES = new Set(
  ROUTER_PROPOSAL_FACTS.mutableResources.items.properties.ownershipMode.enum,
)
const ROUTER_SIDE_EFFECTS = new Set(ROUTER_PROPOSAL_FACTS.sideEffects.items.enum)
const PROVIDER_PROPOSAL_FACTS = ROUTE_RECOMMENDATION_SCHEMA.properties.routeFactProposal.properties
const CODEX_ROUTE_RECOMMENDATION_SCHEMA = structuredClone(ROUTE_RECOMMENDATION_SCHEMA)
const CODEX_PROPOSAL_FACTS = CODEX_ROUTE_RECOMMENDATION_SCHEMA.properties.routeFactProposal.properties
const enumUnion = (...schemas) => [...new Set(schemas.flatMap(schema => schema.enum))]
CODEX_PROPOSAL_FACTS.mutableResources = structuredClone(ROUTER_PROPOSAL_FACTS.mutableResources)
CODEX_PROPOSAL_FACTS.sideEffects = structuredClone(ROUTER_PROPOSAL_FACTS.sideEffects)
CODEX_PROPOSAL_FACTS.namedDistinctResponsibilities = structuredClone(
  ROUTER_PROPOSAL_FACTS.riskAndIndependentCheckFloor.properties.namedDistinctResponsibilities,
)
CODEX_PROPOSAL_FACTS.availableCheckKinds = {
  ...structuredClone(ROUTER_PROPOSAL_FACTS.checkAndBaseline.properties.availableCheckKinds),
  minItems: 1,
}
CODEX_PROPOSAL_FACTS.thirdPartyImpact.enum = enumUnion(
  PROVIDER_PROPOSAL_FACTS.thirdPartyImpact,
  ROUTER_PROPOSAL_FACTS.thirdPartyImpact,
)
CODEX_PROPOSAL_FACTS.baselineStatus.enum = enumUnion(
  PROVIDER_PROPOSAL_FACTS.baselineStatus,
  ROUTER_PROPOSAL_FACTS.checkAndBaseline.properties.baselineStatus,
)
CODEX_PROPOSAL_FACTS.architectureImpact.enum = enumUnion(
  PROVIDER_PROPOSAL_FACTS.architectureImpact,
  ROUTER_PROPOSAL_FACTS.architectureImpact,
)
const CODEX_THIRD_PARTY_IMPACTS = new Set(CODEX_PROPOSAL_FACTS.thirdPartyImpact.enum)
const CODEX_BASELINE_STATUSES = new Set(CODEX_PROPOSAL_FACTS.baselineStatus.enum)
const CODEX_ARCHITECTURE_IMPACTS = new Set(CODEX_PROPOSAL_FACTS.architectureImpact.enum)
const ROUTE_SCHEMA_DIGEST = crypto.createHash('sha256')
  .update(JSON.stringify({
    routeDecision: ROUTE_DECISION_SCHEMA,
    routeRecommendation: CODEX_ROUTE_RECOMMENDATION_SCHEMA,
    routeContract: router.ROUTE_CONTRACT,
  }))
  .digest('hex')

// The provider-neutral recommendation contract and the deterministic Codex
// router use three different labels for equivalent states. Keep the durable
// recommendation in its provider contract, then translate only at the router
// boundary. Intersecting the enums made truthful `minor`, `unknown`, and
// `single-system` recommendations schema-valid but unusable, which discarded
// the analyst's task-specific route and verification matrix.
function projectProviderProposalToRouter(proposal) {
  return {
    ...proposal,
    thirdPartyImpact: proposal.thirdPartyImpact === 'minor'
      ? 'incidental' : proposal.thirdPartyImpact,
    baselineStatus: proposal.baselineStatus === 'unknown'
      ? 'required-before-production' : proposal.baselineStatus,
    architectureImpact: proposal.architectureImpact === 'single-system'
      ? 'local' : proposal.architectureImpact,
  }
}

function validRouteFactProposal(value) {
  if (!isObject(value)) return false
  const required = Object.keys(defaultRouteFactProposal())
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key))) return false
  const resourceIdentities = Array.isArray(value.mutableResources)
    ? value.mutableResources.map(resource => isObject(resource)
      ? `${resource.kind}\0${resource.identity}` : null)
    : []
  return ['inspect', 'report', 'research', 'decide', 'mutate', 'external-operation'].includes(value.requestedEffect) &&
    ['bounded', 'connected', 'independent-edits', 'dependent-groups'].includes(value.dependencyShape) &&
    Number.isSafeInteger(value.dependentWorkGroupCount) && value.dependentWorkGroupCount >= 0 &&
    typeof value.integrationOwnerRequired === 'boolean' &&
    ['none', 'reversible-technical', 'product-semantic', 'architecture'].includes(value.uncertainty) &&
    ['fully-reversible', 'locally-reversible', 'staged-rollback-required', 'irreversible'].includes(value.reversibility) &&
    Array.isArray(value.mutableResources) && value.mutableResources.every(resource =>
      isObject(resource) && ROUTER_RESOURCE_KINDS.has(resource.kind) && concrete(resource.identity) &&
      typeof resource.shared === 'boolean' && ROUTER_OWNERSHIP_MODES.has(resource.ownershipMode)) &&
    new Set(resourceIdentities).size === resourceIdentities.length &&
    nonEmptyStringArray(value.sideEffects) && value.sideEffects.every(effect => ROUTER_SIDE_EFFECTS.has(effect)) &&
    new Set(value.sideEffects).size === value.sideEffects.length &&
    ['local-only', 'external-read', 'external-write'].includes(value.externality) &&
    ['public', 'internal', 'confidential', 'restricted'].includes(value.confidentiality) &&
    CODEX_THIRD_PARTY_IMPACTS.has(value.thirdPartyImpact) &&
    ['ordinary', 'elevated', 'staged-high-impact'].includes(value.riskLevel) &&
    validNamedCheckerMethods(value.minimumCheckerCount, value.namedDistinctResponsibilities) &&
    ['authoritative', 'short-plan', 'coordinated-design', 'unavailable'].includes(value.checkQuality) &&
    requiredNonEmptyStringArray(value.availableCheckKinds) &&
    new Set(value.availableCheckKinds).size === value.availableCheckKinds.length &&
    CODEX_BASELINE_STATUSES.has(value.baselineStatus) &&
    typeof value.hiddenExternalCheck === 'boolean' &&
    CODEX_ARCHITECTURE_IMPACTS.has(value.architectureImpact) &&
    ['fitsLightPlan', 'approachNeedsShortPlanning', 'shortOrderUnclear'].every(key => typeof value[key] === 'boolean')
}

function validNamedCheckerMethods(minimumCheckerCount, responsibilities) {
  if (![1, 2].includes(minimumCheckerCount) || !nonEmptyStringArray(responsibilities)) return false
  const normalized = responsibilities.map(item => item.trim().toLowerCase())
  if (new Set(normalized).size !== normalized.length || responsibilities.some(item => !concrete(item))) return false
  return minimumCheckerCount === 2
    ? responsibilities.length === 2
    : responsibilities.length <= 1
}

function exactTypedCheckerMethods(responsibilities, availableCheckKinds) {
  if (!Array.isArray(responsibilities) || responsibilities.length !== 2 ||
      !Array.isArray(availableCheckKinds)) return null
  const available = new Set(availableCheckKinds
    .filter(value => concrete(value))
    .map(value => value.trim().toLowerCase())
    .filter(value => EXECUTABLE_CHECK_KIND.test(value)))
  const parsed = responsibilities.map(responsibility => {
    if (!concrete(responsibility)) return null
    const match = TYPED_CHECKER_METHOD.exec(responsibility.trim())
    if (!match || !concrete(match[2])) return null
    const methodId = match[1].trim().toLowerCase()
    return EXECUTABLE_CHECK_KIND.test(methodId) && available.has(methodId)
      ? { methodId, responsibility: responsibility.trim() }
      : null
  })
  if (parsed.some(value => value === null) || parsed[0].methodId === parsed[1].methodId) return null
  return parsed
}

const ROUTE_REASON_BOILERPLATE = Object.freeze([
  /^(?:it is |this is |the route is )?not (?:appropriate|applicable|needed|necessary|suitable|selected)(?: here)?[.!]?$/u,
  /^(?:not|no) (?:direct|light|roadmap)[.!]?$/u,
  /^(?:does not|doesn't) fit[.!]?$/u,
  /^(?:wrong|other) route[.!]?$/u,
])

function concreteRouteReason(value) {
  if (!concrete(value)) return false
  const text = value.trim().toLowerCase().replace(/\s+/gu, ' ')
  return !ROUTE_REASON_BOILERPLATE.some(pattern => pattern.test(text))
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function createFrameworkMissCacheIdentity(input = {}) {
  const axes = input.axes
  const acceptanceOverlays = input.acceptanceOverlays
  const riskOverlays = input.riskOverlays ?? []
  if (!isObject(axes) || !nonEmpty(axes.deliverableKind) || !nonEmpty(axes.targetLocus) ||
      !requiredNonEmptyStringArray(acceptanceOverlays) || new Set(acceptanceOverlays).size !== acceptanceOverlays.length ||
      !nonEmptyStringArray(riskOverlays) || new Set(riskOverlays).size !== riskOverlays.length) {
    const error = new TypeError('framework MISS identity requires typed axes and unique acceptance/risk overlays')
    error.code = 'FRAMEWORK_MISS_IDENTITY_INVALID'
    throw error
  }
  const body = Object.freeze({
    schemaVersion: 1,
    routeSchemaDigest: ROUTE_SCHEMA_DIGEST,
    axes: Object.freeze({ deliverableKind: axes.deliverableKind, targetLocus: axes.targetLocus }),
    acceptanceOverlays: Object.freeze([...acceptanceOverlays]),
    riskOverlays: Object.freeze([...riskOverlays]),
  })
  return Object.freeze({ ...body, cacheKey: crypto.createHash('sha256').update(stableJson(body)).digest('hex') })
}

function evaluateSafeTransportDegradation(candidate = {}) {
  const accepted = isObject(candidate) && candidate.mode === 'sequential-isolated' &&
    candidate.taskCapabilityPreserved === true && candidate.independencePreserved === true &&
    candidate.acceptancePreserved === true
  return Object.freeze({
    accepted,
    evaluator: 'deterministic-safe-transport-v1',
    reason: accepted ? 'task-capability-independence-and-acceptance-preserved' : 'safe-degradation-invariants-not-preserved',
    evaluationHash: crypto.createHash('sha256').update(stableJson(candidate)).digest('hex'),
  })
}

function createFindingDispositionDecision(input = {}) {
  const suppliedFinding = input.finding
  const finding = isObject(suppliedFinding) ? {
    ...suppliedFinding,
    severity: suppliedFinding.severity ?? 'P3',
    resolution: suppliedFinding.resolution ?? 'open',
  } : suppliedFinding
  if (!isObject(finding) || !nonEmpty(finding.id) || !['P0', 'P1', 'P2', 'P3'].includes(finding.severity) ||
      !['blocking', 'advisory'].includes(finding.disposition) || !['open', 'fixed', 'non-defect'].includes(finding.resolution)) {
    const error = new TypeError('finding disposition requires a typed finding')
    error.code = 'FINDING_DISPOSITION_INVALID'
    throw error
  }
  if (finding.disposition === 'blocking' && finding.resolution === 'open') {
    const error = new Error('blocking findings remain open')
    error.code = 'BLOCKING_FINDING_OPEN'
    throw error
  }
  const receipt = input.authorityReceipt
  const receiptRequired = finding.disposition === 'advisory' ||
    (finding.severity === 'P1' && finding.resolution === 'non-defect')
  if (receiptRequired && (!isObject(receipt) || !nonEmpty(receipt.authority) ||
      !sha256(receipt.receiptHash) || !Array.isArray(receipt.acceptedFindingIds) ||
      receipt.acceptedFindingIds.length !== 1 || receipt.acceptedFindingIds[0] !== finding.id)) {
    const error = new Error('residual-risk or P1 non-defect disposition requires exact authority receipt')
    error.code = finding.disposition === 'advisory'
      ? 'RESIDUAL_RISK_AUTHORITY_REQUIRED'
      : 'FINDING_AUTHORITY_RECEIPT_REQUIRED'
    throw error
  }
  if (finding.resolution === 'non-defect' && (!requiredNonEmptyStringArray(finding.evidenceIds) ||
      finding.originalSeverity && finding.originalSeverity !== finding.severity)) {
    const error = new Error('non-defect disposition requires evidence without severity manipulation')
    error.code = 'NON_DEFECT_EVIDENCE_REQUIRED'
    throw error
  }
  const body = {
    schemaVersion: 1,
    finding: clone(finding),
    authorityReceipt: receiptRequired ? clone(receipt) : null,
  }
  return Object.freeze({ ...body, decisionHash: crypto.createHash('sha256').update(stableJson(body)).digest('hex') })
}

function sha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function exactPathSelection(value, route = null) {
  if (!isObject(value) || value.mode !== 'exact' || value.automaticSelectionBypassed !== true ||
      value.silentRouteChangesAllowed !== false || !ROUTES.includes(value.requestedRoute)) return null
  if (route !== null && value.requestedRoute !== route) return null
  return value
}

function normalizeOwnership(input, facts) {
  const supplied = input ?? []
  if (!Array.isArray(supplied)) return supplied
  return supplied.map(item => ({
    kind: item.kind,
    identity: item.identity,
    owner: item.owner,
    ownershipMode: item.ownershipMode ?? item.ownership_mode,
  })).sort((left, right) => `${left.kind}\0${left.identity}`.localeCompare(`${right.kind}\0${right.identity}`))
}

function validateOwnership(ownership, facts) {
  const errors = []
  if (!Array.isArray(ownership)) return { valid: false, errors: ['mutableResourceOwnership must be an array'] }
  const expected = facts.mutableResources.map(resource => ({
    kind: resource.kind,
    identity: resource.identity,
    ownershipMode: resource.ownershipMode,
  })).sort((left, right) => `${left.kind}\0${left.identity}`.localeCompare(`${right.kind}\0${right.identity}`))
  const actual = normalizeOwnership(ownership, facts)
  if (actual.length !== expected.length) errors.push('every mutable resource requires exactly one owner')
  expected.forEach((resource, index) => {
    const assigned = actual[index]
    if (!assigned || assigned.kind !== resource.kind || assigned.identity !== resource.identity ||
        assigned.ownershipMode !== resource.ownershipMode) {
      errors.push(`ownership must match mutable resource ${resource.kind}:${resource.identity}`)
    } else if (!concrete(assigned.owner)) {
      errors.push(`mutable resource ${resource.kind}:${resource.identity} requires a concrete owner`)
    }
  })
  if (new Set(actual.map(item => `${item.kind}\0${item.identity}`)).size !== actual.length) {
    errors.push('a mutable resource cannot have two ownership rows')
  }
  return { valid: errors.length === 0, errors, ownership: actual }
}

function candidateFreezeContract(facts) {
  return {
    required: facts.candidateFreeze.required,
    available: facts.candidateFreeze.available,
    environmentCanBeBound: facts.candidateFreeze.environmentCanBeBound,
    freezeBeforeIndependentCheck: true,
    frozenVersionIdRequired: facts.candidateFreeze.required,
  }
}

function derivedSafetyCheckObligations(facts) {
  const responsibilities = []
  const effects = new Set(facts.sideEffects)
  if (effects.has('destructive-change') || facts.reversibility === 'irreversible') {
    responsibilities.push('Independently check destructive-action authority and rollback or irreversible-action evidence.')
  }
  if (effects.has('external-write') || facts.externality === 'external-write') {
    responsibilities.push('Independently check external-action authority and the observable external result.')
  }
  if (effects.has('permission-change')) {
    responsibilities.push('Independently check authorization boundaries using distinct identities and access.')
  }
  if (effects.has('money-or-quota')) {
    responsibilities.push('Independently check explicit cost authority, limits, and receipts.')
  }
  if (facts.mutableResources.some(resource => resource.shared)) {
    responsibilities.push('Independently check shared-resource ownership, isolation, and concurrency behavior.')
  }
  if (facts.checkAndBaseline.hiddenExternalCheck) {
    responsibilities.push('Independently assess the hidden external check and record its residual uncertainty.')
  }
  return [...new Set(responsibilities)]
}

const ROUTE_ANALYST_ADMISSION = Object.freeze({
  schema: ROUTE_ANALYST_ADMISSION_SCHEMA_ID,
  schema_version: 2,
  required: true,
  role: 'route-analyst',
  layer: 'L3',
  parent: 'deterministic-control-plane',
  session_count: 1,
  max_sessions: 1,
  max_duration_ms: ROUTE_ANALYST_MAX_DURATION_MS,
  restart_policy: 'NEVER',
  permissions: Object.freeze({
    allowed_operations: Object.freeze(['list', 'read', 'search', 'inspect-test-build-configuration']),
    write: false,
    edit: false,
    delete: false,
    spawn_children: false,
    broad_build_or_test: false,
    network: false,
    final_route_decision: false,
    implementation_plan: false,
  }),
  transcript: Object.freeze({ required: true, stream_events_as_received: true, full_event_stream: true }),
  failure_behavior: Object.freeze({ relaunch: false, l0_continues: true, l0_confidence: 'low' }),
  value_measurement: Object.freeze({
    record_time_calls_and_tokens: true,
    measure_route_errors_avoided: true,
    tune_cost_and_useful_content_only: true,
    analyst_may_be_removed_by_ablation: false,
  }),
})

function createRouteAnalystAdmission(options = {}) {
  return {
    ...clone(ROUTE_ANALYST_ADMISSION),
    run_id: options.run_id ?? options.runId ?? null,
    request_envelope_hash: options.request_envelope_hash ?? options.requestEnvelopeHash ?? null,
    target_identity: options.target_identity ?? options.targetIdentity ?? null,
    transcript_path: options.transcript_path ?? options.transcriptPath ?? 'route/transcript.jsonl',
    recommendation_path: options.recommendation_path ?? options.recommendationPath ?? 'route/recommendation.json',
  }
}

function validateRouteAnalystAdmission(admission) {
  const errors = []
  if (!isObject(admission)) return { valid: false, errors: ['admission must be an object'] }
  if (admission.required !== true) errors.push('the route analyst is required')
  if (admission.role !== 'route-analyst') errors.push('role must be route-analyst')
  if (admission.layer !== 'L3' || admission.parent !== 'deterministic-control-plane') {
    errors.push('route analyst must be one L3 child of the deterministic control plane')
  }
  if (admission.session_count !== 1 || admission.max_sessions !== 1) errors.push('exactly one route-analyst session is required')
  if (admission.max_duration_ms !== ROUTE_ANALYST_MAX_DURATION_MS) errors.push('route analyst ceiling must be 120000ms')
  if (admission.restart_policy !== 'NEVER') errors.push('route analyst must not be relaunched')
  const permissions = admission.permissions
  if (!isObject(permissions)) {
    errors.push('permissions are required')
  } else {
    const allowed = permissions.allowed_operations
    if (!Array.isArray(allowed) || !['list', 'read', 'search'].every(item => allowed.includes(item))) {
      errors.push('route analyst must be able to list, read, and search')
    }
    for (const field of [
      'write', 'edit', 'delete', 'spawn_children', 'broad_build_or_test',
      'network', 'final_route_decision', 'implementation_plan',
    ]) {
      if (permissions[field] !== false) errors.push(`permissions.${field} must be false`)
    }
  }
  if (!isObject(admission.transcript) || admission.transcript.required !== true ||
      admission.transcript.stream_events_as_received !== true ||
      admission.transcript.full_event_stream !== true) {
    errors.push('complete streamed transcript capture is required')
  }
  if (!isObject(admission.failure_behavior) || admission.failure_behavior.relaunch !== false ||
      admission.failure_behavior.l0_continues !== true) {
    errors.push('analyst failure must fall back to L0 without relaunch')
  }
  if (!isObject(admission.value_measurement) ||
      admission.value_measurement.analyst_may_be_removed_by_ablation !== false) {
    errors.push('ablation may tune the required analyst but may not remove it')
  }
  return { valid: errors.length === 0, errors }
}

function validateRecommendation(recommendation) {
  const errors = []
  if (!isObject(recommendation)) return { valid: false, errors: ['recommendation must be an object'] }
  if (recommendation.schemaVersion !== ROUTE_RECOMMENDATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${ROUTE_RECOMMENDATION_SCHEMA_VERSION}`)
  }
  if (!['CONTINUE', 'NEEDS_USER'].includes(recommendation.preWorkResult)) {
    errors.push('preWorkResult must be CONTINUE or NEEDS_USER')
  }
  if (!['high', 'medium', 'low'].includes(recommendation.confidence)) {
    errors.push('confidence must be high, medium, or low')
  }
  for (const field of RECOMMENDATION_ARRAY_FIELDS) {
    if (!nonEmptyStringArray(recommendation[field])) errors.push(`${field} must be an array of non-empty strings`)
  }
  if (!validRouteFactProposal(recommendation.routeFactProposal)) {
    errors.push('routeFactProposal must contain the complete bounded semantic route inputs')
  }
  const canonicalRecommendationVerification = canonicalVerificationObligations(
    recommendation.verificationObligations,
  )
  const normalizedRecommendationVerification = verificationObligationsForRequest(
    '',
    recommendation.verificationObligations,
  )
  if (!canonicalRecommendationVerification || !normalizedRecommendationVerification ||
      !sameValue(canonicalRecommendationVerification, normalizedRecommendationVerification)) {
    errors.push('verificationObligations must preserve canonical explicitly typed acceptance cases')
  }
  if (!requiredNonEmptyStringArray(recommendation.whatTheUserWants)) {
    errors.push('whatTheUserWants must contain at least one item')
  }
  if (!Array.isArray(recommendation.evidenceIndex) || recommendation.evidenceIndex.some(entry =>
    !isObject(entry) || !concrete(entry.eventId) || !concrete(entry.reason) ||
    !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || !sha256(entry.sha256) ||
    typeof entry.truncated !== 'boolean')) {
    errors.push('evidenceIndex must contain typed evidence records')
  }
  if (recommendation.preWorkResult === 'NEEDS_USER') {
    if (recommendation.recommendedRoute !== null) errors.push('NEEDS_USER requires recommendedRoute=null')
    if (!requiredNonEmptyStringArray(recommendation.userInputNeeded)) {
      errors.push('NEEDS_USER requires at least one indispensable userInputNeeded item')
    }
  }
  if (recommendation.preWorkResult === 'CONTINUE') {
    if (!ROUTES.includes(recommendation.recommendedRoute)) {
      errors.push('CONTINUE requires recommendedRoute DIRECT, LIGHT, or ROADMAP')
    }
    if (Array.isArray(recommendation.userInputNeeded) && recommendation.userInputNeeded.length > 0) {
      errors.push('CONTINUE cannot carry indispensable userInputNeeded items')
    }
    if (!requiredNonEmptyStringArray(recommendation.howSuccessCanBeChecked)) {
      errors.push('CONTINUE requires at least one success check or observable result')
    }
    for (const field of ['reasonsForDirect', 'reasonsForLight', 'reasonsForRoadmap']) {
      if (!requiredNonEmptyStringArray(recommendation[field])) {
        errors.push(`${field} must contain factual route reasoning`)
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

function createRouteRecommendation(input = {}) {
  const recommendedRoute = input.recommendedRoute ?? input.recommended_route ?? null
  const checks = input.howSuccessCanBeChecked ?? input.how_success_can_be_checked ?? []
  return {
    schemaVersion: ROUTE_RECOMMENDATION_SCHEMA_VERSION,
    preWorkResult: input.preWorkResult ?? input.pre_work_result,
    recommendedRoute,
    confidence: input.confidence,
    whatTheUserWants: input.whatTheUserWants ?? input.what_the_user_wants ?? [],
    likelyAreas: input.likelyAreas ?? input.likely_areas ?? [],
    howSuccessCanBeChecked: checks,
    unknowns: input.unknowns ?? [],
    risks: input.risks ?? [],
    independentWorkItems: input.independentWorkItems ?? input.independent_work_items ?? [],
    dependencies: input.dependencies ?? [],
    reasonsForDirect: input.reasonsForDirect ?? input.reasons_for_direct ?? [],
    reasonsForLight: input.reasonsForLight ?? input.reasons_for_light ?? [],
    reasonsForRoadmap: input.reasonsForRoadmap ?? input.reasons_for_roadmap ?? [],
    userInputNeeded: input.userInputNeeded ?? input.user_input_needed ?? [],
    evidenceIndex: input.evidenceIndex ?? input.evidence_index ?? [],
    routeFactProposal: input.routeFactProposal ?? input.route_fact_proposal ??
      defaultRouteFactProposal(recommendedRoute || 'DIRECT'),
    verificationObligations: verificationObligationsForRequest(
      '',
      input.verificationObligations ?? input.verification_obligations,
      checks,
    ),
  }
}

function canonicalizeProviderVerificationObligations(supplied, fallbackChecks = []) {
  const alreadyCanonical = canonicalVerificationObligations(supplied, fallbackChecks)
  if (alreadyCanonical) return alreadyCanonical
  // The provider schema deliberately describes transport shape, not the full
  // cross-case matrix.  Its one safe deterministic default already exists:
  // derive invariant cases from the provider's own success checks.  Do not
  // infer activation ordering, security properties, or task-specific facts.
  return canonicalVerificationObligations(null, fallbackChecks)
}

/**
 * Provider structured output is a transport contract.  Convert a value which
 * satisfies that contract into the canonical controller representation before
 * semantic validation.  This keeps malformed transport fail-closed while
 * avoiding the old schema-valid-but-runtime-invalid gap.
 */
function canonicalizeProviderRecommendation(recommendation) {
  const schemaValidation = validateJsonSchema(CODEX_ROUTE_RECOMMENDATION_SCHEMA, recommendation)
  if (!schemaValidation.valid) {
    return {
      valid: false,
      errors: schemaValidation.errors.map(error =>
        `${error.path}: ${error.message}`),
      recommendation: null,
      canonicalized: false,
    }
  }
  const verificationObligations = canonicalizeProviderVerificationObligations(
    recommendation.verificationObligations,
    recommendation.howSuccessCanBeChecked,
  )
  const suppliedProposal = recommendation.routeFactProposal
  const typedMethods = suppliedProposal && suppliedProposal.minimumCheckerCount === 2
    ? exactTypedCheckerMethods(
        suppliedProposal.namedDistinctResponsibilities,
        suppliedProposal.availableCheckKinds,
      )
    : null
  // The provider may recommend a second physical seat only by binding each
  // responsibility to a different executable command/oracle/adapter identity
  // that it also declared available. Numeric risk prose is not launch
  // authority: deterministically collapse it to the ordinary combined seat.
  const routeFactProposal = suppliedProposal && suppliedProposal.minimumCheckerCount === 2 && !typedMethods
    ? {
        ...suppliedProposal,
        minimumCheckerCount: 1,
        namedDistinctResponsibilities: [],
      }
    : suppliedProposal
  const canonical = createRouteRecommendation({
    ...recommendation,
    routeFactProposal,
    verificationObligations,
  })
  const validation = validateRecommendation(canonical)
  return {
    valid: validation.valid,
    errors: validation.errors,
    recommendation: validation.valid ? canonical : null,
    canonicalized: validation.valid && !sameValue(canonical, recommendation),
  }
}

function createRouteAnalystFallbackState(input = {}) {
  const outcome = String(input.outcome || '').toUpperCase()
  const failure = {
    outcome,
    reason: nonEmpty(input.reason) ? input.reason.trim() : `Route analyst ${outcome.toLowerCase()} fallback.`,
    errors: Array.isArray(input.errors) ? input.errors.filter(nonEmpty) : [],
  }
  const state = {
    schemaVersion: 1,
    status: 'FALLBACK_RECOMMENDATION',
    outcome,
    route: null,
    confidence: 'low',
    l0MayDecide: true,
    relaunch: false,
    resumable: true,
    requestEnvelopeHash: input.requestEnvelopeHash ?? input.request_envelope_hash ?? null,
    transcriptHash: input.transcriptHash ?? input.transcript_hash ?? null,
    evidenceIndexHash: input.evidenceIndexHash ?? input.evidence_index_hash ?? null,
    failureEvidenceHash: crypto.createHash('sha256').update(JSON.stringify(failure)).digest('hex'),
    recordedAt: input.recordedAt ?? new Date(input.nowMs ?? Date.now()).toISOString(),
  }
  state.bindingHash = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex')
  return state
}

function validateRouteAnalystFallbackState(state) {
  const errors = []
  if (!isObject(state)) return { valid: false, errors: ['fallback recommendation state must be an object'] }
  const allowed = [
    'schemaVersion', 'status', 'outcome', 'route', 'confidence', 'l0MayDecide', 'relaunch',
    'resumable', 'requestEnvelopeHash', 'transcriptHash', 'evidenceIndexHash',
    'failureEvidenceHash', 'recordedAt', 'bindingHash',
  ]
  if (Object.keys(state).some(key => !allowed.includes(key)) || allowed.some(key => !own(state, key))) {
    errors.push('fallback recommendation state fields must match the canonical shape')
  }
  if (state.schemaVersion !== 1 || state.status !== 'FALLBACK_RECOMMENDATION' ||
      !ROUTE_ANALYST_FALLBACK_OUTCOMES.includes(state.outcome) || state.route !== null ||
      state.confidence !== 'low' || state.l0MayDecide !== true || state.relaunch !== false ||
      state.resumable !== true) errors.push('fallback recommendation lifecycle fields are invalid')
  for (const field of ['requestEnvelopeHash', 'transcriptHash', 'evidenceIndexHash', 'failureEvidenceHash', 'bindingHash']) {
    if (!sha256(state[field])) errors.push(`${field} must be SHA-256`)
  }
  if (Number.isNaN(Date.parse(state.recordedAt))) errors.push('recordedAt must be a date-time')
  if (sha256(state.bindingHash)) {
    const unsigned = { ...state }
    delete unsigned.bindingHash
    const expected = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')
    if (state.bindingHash !== expected) errors.push('bindingHash must bind the exact fallback recommendation state')
  }
  return { valid: errors.length === 0, errors }
}

function fallbackAnalystResult(input, status, outcome, errors = []) {
  const result = {
    status,
    l0_may_decide: true,
    relaunch: false,
    confidence: 'low',
    ...(errors.length ? { errors } : {}),
  }
  const fallback = createRouteAnalystFallbackState({
    ...input,
    outcome,
    errors,
    reason: input.reason || `${status} requires L0 to continue from the durable low-confidence fallback.`,
  })
  if (validateRouteAnalystFallbackState(fallback).valid) result.recommendation_state = fallback
  else result.recommendation_state_required = true
  return result
}

function evaluateRouteAnalystResult(input = {}) {
  const admissionValidation = validateRouteAnalystAdmission(input.admission || createRouteAnalystAdmission())
  if (!admissionValidation.valid) {
    return {
      status: 'ROUTE_ANALYST_ADMISSION_INVALID',
      l0_may_decide: false,
      relaunch: false,
      errors: admissionValidation.errors,
    }
  }
  const elapsed = Number(input.elapsed_ms ?? input.elapsedMs)
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return fallbackAnalystResult(input, 'ROUTE_ANALYST_RESULT_INVALID', 'MALFORMED', ['elapsed_ms must be non-negative'])
  }
  if (input.outcome === 'TIMEOUT') {
    return fallbackAnalystResult(input, 'ROUTE_ANALYST_TIMEOUT', 'TIMEOUT')
  }
  if (input.outcome === 'CRASH' || input.outcome === 'PROVIDER_UNSUPPORTED') {
    return fallbackAnalystResult(input, `ROUTE_ANALYST_${input.outcome}`, input.outcome)
  }
  const normalized = canonicalizeProviderRecommendation(input.recommendation)
  if (!normalized.valid) {
    return fallbackAnalystResult(input, 'ROUTE_ANALYST_MALFORMED', 'MALFORMED', normalized.errors)
  }
  const late = elapsed > routeAnalystMaxDurationMs()
  return {
    status: normalized.recommendation.preWorkResult === 'NEEDS_USER' ? 'WAITING_USER' : 'ROUTE_ANALYST_COMPLETE',
    l0_may_decide: normalized.recommendation.preWorkResult !== 'NEEDS_USER',
    relaunch: false,
    confidence: normalized.recommendation.confidence,
    recommendation: normalized.recommendation,
    canonicalized: normalized.canonicalized,
    convergence: late ? {
      required: true,
      action: 'USE_AVAILABLE_CANONICAL_RECOMMENDATION',
      ceiling_ms: ROUTE_ANALYST_MAX_DURATION_MS,
      elapsed_ms: elapsed,
    } : { required: false },
  }
}

function createRoadmapTopology(options = {}) {
  const namedUnknowns = options.named_unknowns ?? options.namedUnknowns ?? []
  const scoutCount = options.scout_count ?? options.scoutCount ?? 0
  const physicalCount = options.deterministic_controller_projection === true ||
    options.deterministicControllerProjection === true ? 0 : 1
  return {
    roadmapAuthor: {
      role: 'roadmap-author',
      layer: 'L3',
      parent: 'run-owner',
      count: physicalCount,
      output: 'plan/ROADMAP.md',
      repairOwner: 'SAME_AUTHOR',
      coordinatesImplementation: false,
    },
    scouts: {
      role: 'scout',
      layer: 'L3',
      parent: 'run-owner',
      count: scoutCount,
      namedUnknowns: Array.isArray(namedUnknowns) ? namedUnknowns.slice() : namedUnknowns,
      onlyForNamedUnknowns: true,
      outputsAreReadOnly: true,
    },
    scoutJoin: {
      afterAllNamedScouts: 'AUTHOR_REVISE',
      mergeOwner: 'SAME_AUTHOR',
    },
    planChecker: {
      role: 'plan-checker',
      layer: 'L4',
      parent: 'run-owner',
      count: physicalCount,
      independentFromAuthor: true,
      editsPlan: false,
      recheckOwner: 'SAME_CHECKER',
    },
    coordination: {
      beginsAfter: 'PLAN_ACCEPTED',
      integrationOwner: {
        role: 'mission-coordinator', layer: 'L1', parent: 'run-owner', count: physicalCount,
      },
      workGroupManagerAdmission: {
        role: 'ap-work-group-manager',
        physicalRoleId: 'autoprompt.v2.ap-work-group-manager',
        parent: 'mission-coordinator',
        route: 'ROADMAP',
        planPath: 'plan/ROADMAP.md',
        minimumUsefulWorkers: 2,
        disjointMutableResourceOwnershipRequired: true,
        singleWorkerGroupsStayWithParent: true,
      },
    },
  }
}

function validateRoadmapTopology(topology) {
  const errors = []
  if (!isObject(topology)) return { valid: false, errors: ['roadmap_topology must be an object'] }
  const author = topology.roadmapAuthor
  if (!isObject(author) || author.role !== 'roadmap-author' || author.layer !== 'L3' ||
      author.parent !== 'run-owner' || author.count !== 1 ||
      author.output !== 'plan/ROADMAP.md' || author.repairOwner !== 'SAME_AUTHOR' ||
      author.coordinatesImplementation !== false) {
    errors.push('ROADMAP requires exactly one non-coordinating L3 author and same-author repair')
  }
  const scouts = topology.scouts
  if (!isObject(scouts) || scouts.role !== 'scout' || scouts.layer !== 'L3' ||
      scouts.parent !== 'run-owner' || !Number.isSafeInteger(scouts.count) || scouts.count < 0 ||
      !nonEmptyStringArray(scouts.namedUnknowns) || scouts.onlyForNamedUnknowns !== true ||
      scouts.outputsAreReadOnly !== true) {
    errors.push('scouts must be read-only and tied to named unknowns')
  } else if (scouts.count > 0 && scouts.namedUnknowns.length === 0) {
    errors.push('each scout launch requires at least one named unknown')
  }
  const checker = topology.planChecker
  if (!isObject(checker) || checker.role !== 'plan-checker' || checker.layer !== 'L4' ||
      checker.parent !== 'run-owner' || checker.count !== 1 ||
      checker.independentFromAuthor !== true || checker.editsPlan !== false ||
      checker.recheckOwner !== 'SAME_CHECKER') {
    errors.push('ROADMAP requires exactly one independent L4 plan checker and same-checker recheck')
  }
  if (!isObject(topology.scoutJoin) || topology.scoutJoin.afterAllNamedScouts !== 'AUTHOR_REVISE' ||
      topology.scoutJoin.mergeOwner !== 'SAME_AUTHOR') {
    errors.push('scout results must join into same-author revision before plan checking')
  }
  const coordination = topology.coordination
  const manager = coordination && coordination.workGroupManagerAdmission
  if (!isObject(coordination) || coordination.beginsAfter !== 'PLAN_ACCEPTED' ||
      !isObject(coordination.integrationOwner) || coordination.integrationOwner.layer !== 'L1' ||
      coordination.integrationOwner.role !== 'mission-coordinator' ||
      coordination.integrationOwner.parent !== 'run-owner' || coordination.integrationOwner.count !== 1 ||
      !isObject(manager) || manager.role !== 'ap-work-group-manager' ||
      manager.physicalRoleId !== 'autoprompt.v2.ap-work-group-manager' || manager.parent !== 'mission-coordinator' ||
      manager.route !== 'ROADMAP' || manager.planPath !== 'plan/ROADMAP.md' ||
      manager.minimumUsefulWorkers !== 2 || manager.disjointMutableResourceOwnershipRequired !== true ||
      manager.singleWorkerGroupsStayWithParent !== true) {
    errors.push('one L1 integration owner may begin only after plan acceptance')
  }
  return { valid: errors.length === 0, errors }
}

function selectIndependentChecking(options = {}) {
  const factInput = options.route_facts ?? options.routeFacts ?? options.facts
  const factValidation = router.validateRouteFacts(factInput)
  if (!factValidation.valid) {
    return { valid: false, errors: factValidation.errors.map(error => `route_facts: ${error}`) }
  }
  const facts = factValidation.facts
  const acceptance = router.acceptanceContractForEffect(facts.requestedEffect)
  const floor = facts.riskAndIndependentCheckFloor.minimumCheckerCount
  const suppliedMethods = facts.riskAndIndependentCheckFloor.namedDistinctResponsibilities
  const namedMethods = [...new Set((Array.isArray(suppliedMethods) ? suppliedMethods : [])
    .filter(concrete).map(method => method.trim()))]
  const typedMethods = exactTypedCheckerMethods(
    Array.isArray(suppliedMethods) ? suppliedMethods : [],
    facts.checkAndBaseline.availableCheckKinds,
  )
  // A second physical checker is admitted only when the facts name exactly two
  // distinct executable methods. Legacy/provider records that state a numeric
  // floor without both methods safely converge to one combined checker instead
  // of failing route selection or inventing an unspecified second consumer.
  const useSecond = floor === 2 && namedMethods.length === 2 && typedMethods !== null
  const admittedMethods = useSecond
    ? typedMethods.map(method => method.responsibility)
    : namedMethods
  const safetyObligations = derivedSafetyCheckObligations(facts)
  const primary = `Combined requirements review and real behavior checking for ${facts.requestedEffect}: ${acceptance.requiredAcceptance.join('; ')}`
  const safetySuffix = safetyObligations.length > 0
    ? ` Safety obligations: ${safetyObligations.join('; ')}`
    : ''
  const singleMethod = floor === 1 && namedMethods.length >= 1
    ? ` Executable method: ${namedMethods[0]}` : ''
  return {
    valid: true,
    checkerCount: useSecond ? 2 : 1,
    responsibilities: useSecond
      ? [`Executable method: ${admittedMethods[0]}. ${primary}${safetySuffix}`, `Executable method: ${admittedMethods[1]}.`]
      : [`${primary}${singleMethod}${safetySuffix}`],
    nonOverlapReason: useSecond
      ? `Explicitly bound non-overlapping executable methods: ${typedMethods[0].methodId} / ${typedMethods[1].methodId}`
      : floor === 2
        ? 'A second checker was not admitted because the route facts did not bind exactly two distinct typed method identities to available evidence kinds; one checker owns the combined requirements review and real behavior check.'
        : 'One checker owns the combined requirements review and real behavior check.',
    derivedFromFactsFingerprint: router.routeFactFingerprint(facts),
    duplicateEvidenceConsumptionForbidden: useSecond,
  }
}

function hasExactDisjointAutomaticWorkerProof(route, facts, ownership, workers) {
  if (route !== 'ROADMAP' || !Number.isSafeInteger(workers) || workers < 2 || workers > 3 ||
      facts.requestedEffect === 'external-operation' || facts.externality === 'external-write' ||
      facts.dependency.shape !== 'independent-edits' || facts.dependency.integrationOwnerRequired ||
      facts.dependency.dependentWorkGroupCount > 0 || facts.mutableResources.length !== workers ||
      facts.mutableResources.some(resource => resource.shared || resource.identity === '.') ||
      !Array.isArray(ownership) || ownership.length !== workers) return false
  const expectedOwners = new Set(Array.from({ length: workers }, (_, index) => `worker-${index + 1}`))
  const actualOwners = new Set(ownership.map(item => item && item.owner))
  return actualOwners.size === workers && [...expectedOwners].every(owner => actualOwners.has(owner)) &&
    ownership.every(item => item && facts.mutableResources.some(resource =>
      resource.kind === item.kind && resource.identity === item.identity))
}

function completionLaunchRequirement(topology, options = {}) {
  if (!topology || !ROUTES.includes(topology.route) ||
      !Number.isSafeInteger(topology.childSessions) || topology.childSessions < 1 ||
      !topology.counts || ![1, 2].includes(topology.counts.finalCheckers) ||
      ![0, 1].includes(topology.counts.routeAnalysts) ||
      !Number.isSafeInteger(topology.counts.workers) || topology.counts.workers < 1) return null
  const additionalGateLaunches = options.additionalGateLaunches === undefined
    ? 0 : options.additionalGateLaunches
  if (!Number.isSafeInteger(additionalGateLaunches) || additionalGateLaunches < 0) return null
  const { finalCheckers } = topology.counts
  // B is the frozen initial topology. The first production worker may need one
  // provider-transport retry without consuming the later checker-driven
  // correction path. One bounded report correction may then produce concrete
  // repair evidence; the resulting product/union repair is followed by all C
  // fresh checker seats: B + T1 + R1 + P1 + C = B + 3 + C. Separate
  // deterministic gates are counted explicitly and never hidden in a
  // route-wide padded ceiling.
  const contingency = 3 + finalCheckers
  // Historical ROADMAP decisions counted an author, plan checker, and mission
  // coordinator in childSessions. Codex now projects that planning state in
  // the controller, so neither current nor legacy intake may turn those three
  // dormant declarations into provider-call budget.
  const physicalBase = topology.counts.routeAnalysts +
    topology.counts.workers + topology.counts.finalCheckers
  return physicalBase + contingency + additionalGateLaunches
}

function roadmapCompletionLaunchRequirement(topology, options = {}) {
  if (!topology || topology.route !== 'ROADMAP') return null
  return completionLaunchRequirement(topology, options)
}

function legacyRoadmapProviderTopology(currentTopology) {
  if (!currentTopology || currentTopology.route !== 'ROADMAP') return null
  return {
    ...currentTopology,
    counts: {
      ...currentTopology.counts,
      roadmapAuthors: 1,
      planCheckers: 1,
      missionCoordinators: 1,
    },
    childSessions: currentTopology.childSessions + 3,
    totalSessions: currentTopology.totalSessions + 3,
    coordination: createRoadmapTopology({
      scout_count: 0,
      named_unknowns: [],
    }),
  }
}

function buildRouteTopology(route, options = {}) {
  if (!ROUTES.includes(route)) return { valid: false, errors: ['route must be DIRECT, LIGHT, or ROADMAP'] }
  const factValidation = router.validateRouteFacts(options.route_facts ?? options.routeFacts ?? options.facts)
  if (!factValidation.valid) return { valid: false, errors: factValidation.errors.map(error => `route_facts: ${error}`) }
  const facts = factValidation.facts
  const explicitPath = exactPathSelection(options.pathSelection ?? options.path_selection, route)
  const classified = router.classifyRoute(facts, {
    probeEvidence: options.probe_evidence ?? options.probeEvidence,
    // Exact-path preflight already established the deterministic route floor.
    // Its real baseline probe is a later production gate; topology compilation
    // must not reinterpret that pending gate as an admission-time task stop.
    safetyFloorOnly: Boolean(explicitPath),
  })
  if (classified.status !== 'DECIDED' || (!explicitPath && classified.route !== route)) {
    return { valid: false, errors: [`route facts select ${classified.status === 'DECIDED' ? classified.route : classified.status}, not ${route}`] }
  }
  const ownership = normalizeOwnership(options.mutable_resource_ownership ?? options.mutableResourceOwnership, facts)
  const ownershipValidation = validateOwnership(ownership, facts)
  const checking = selectIndependentChecking({ facts })
  const workers = options.worker_count ?? options.workerCount ?? 1
  const checkers = checking.valid ? checking.checkerCount : 0
  const scouts = options.scout_count ?? options.scoutCount ?? 0
  const namedUnknowns = options.named_unknowns ?? options.namedUnknowns ?? []
  const suppliedManagers = options.manager_count ?? options.managerCount
  const managers = 0
  for (const [name, count] of Object.entries({ workers, checkers, scouts, managers })) {
    if (!Number.isSafeInteger(count) || count < 0) return { valid: false, errors: [`${name} must be a non-negative integer`] }
  }
  const errors = [...ownershipValidation.errors, ...(checking.errors || [])]
  if (workers < 1) errors.push('at least one useful worker is required')
  if (![1, 2].includes(checkers)) errors.push('one or two independent checkers are required')
  if (workers > 3) errors.push('a declared topology allows at most three useful workers')
  if (scouts > 0) errors.push(`${route} deterministic execution has no scout model sessions`)
  if (suppliedManagers !== undefined && suppliedManagers !== managers) {
    errors.push(`deterministic execution requires exactly ${managers} work-group managers`)
  }
  const roadmap = route === 'ROADMAP'
  const counts = {
    roots: 1,
    routeAnalysts: explicitPath ? 0 : 1,
    runOwners: 1,
    // Fresh Codex ROADMAP planning is a deterministic controller projection.
    // These retained names describe legacy intake only and are never physical
    // provider sessions in a newly compiled decision.
    roadmapAuthors: 0,
    scouts: 0,
    planCheckers: 0,
    missionCoordinators: 0,
    workGroupManagers: 0,
    workers,
    finalCheckers: checkers,
  }
  const routeAnalystCount = counts.routeAnalysts
  const childSessions = routeAnalystCount + counts.roadmapAuthors + counts.scouts +
    counts.planCheckers + counts.missionCoordinators + counts.workGroupManagers +
    counts.workers + counts.finalCheckers
  if (childSessions > ROUTE_TOPOLOGY_CHILD_CEILINGS[route]) {
    errors.push(`${route} declared topology requires ${childSessions} child sessions, exceeding its ${ROUTE_TOPOLOGY_CHILD_CEILINGS[route]}-launch ceiling`)
  }
  const topology = {
    valid: errors.length === 0,
    errors,
    route,
    routeFactsFingerprint: classified.facts_fingerprint,
    classifierFingerprint: classified.classifier_fingerprint,
    requestedEffect: facts.requestedEffect,
    acceptance: classified.acceptance,
    mutableResourceOwnership: ownership,
    candidateFreeze: candidateFreezeContract(facts),
    assurancePreconditions: {
      mutableResourceOwnershipValid: ownershipValidation.valid,
      frozenVersionIdRequired: facts.candidateFreeze.required,
      environmentBindingRequired: facts.candidateFreeze.required,
      checkerResponsibilities: checking,
    },
    workGroupManager: roadmap ? {
      role: 'ap-work-group-manager',
      physicalRoleId: 'autoprompt.v2.ap-work-group-manager',
      parent: 'mission-coordinator',
      count: 0,
      admitted: false,
      planPath: 'plan/ROADMAP.md',
      minimumUsefulWorkersPerManager: 2,
      assignedWorkerCount: workers,
      disjointMutableResourceOwnershipRequired: true,
    } : null,
    counts,
    childSessions,
    totalSessions: counts.roots + routeAnalystCount + counts.roadmapAuthors +
      counts.scouts + counts.planCheckers + counts.missionCoordinators +
      counts.workGroupManagers + counts.workers + counts.finalCheckers,
    coordination: roadmap ? createRoadmapTopology({
      scout_count: 0,
      named_unknowns: Array.isArray(namedUnknowns) ? namedUnknowns.slice(0, 0) : [],
      deterministic_controller_projection: true,
    }) : null,
  }
  const completionLaunches = completionLaunchRequirement(topology)
  if (completionLaunches !== null && completionLaunches > ROUTE_TOPOLOGY_CHILD_CEILINGS[route]) {
    errors.push(`${route} initial topology and bounded completion reserve require ${completionLaunches} child sessions, exceeding its ${ROUTE_TOPOLOGY_CHILD_CEILINGS[route]}-launch ceiling`)
    topology.valid = false
    topology.errors = errors
  }
  return topology
}

function validateWorkers(workers, errors) {
  if (!isObject(workers) || !Number.isSafeInteger(workers.count) || workers.count < 1) {
    errors.push('workers.count must be a positive integer')
    return
  }
  if (!requiredNonEmptyStringArray(workers.responsibilities)) {
    errors.push('workers.responsibilities must describe useful owned work')
  }
  if (!concrete(workers.non_overlap_reason)) {
    errors.push('workers.non_overlap_reason must explain why work does not overlap')
  }
}

function validateIndependentChecks(checks, errors) {
  if (!isObject(checks) || ![1, 2].includes(checks.checkerCount)) {
    errors.push('independentCheckingPlan.checkerCount must be one or two')
    return
  }
  if (!requiredNonEmptyStringArray(checks.responsibilities) ||
      checks.responsibilities.length !== checks.checkerCount) {
    errors.push('independentCheckingPlan must name one distinct responsibility per checker')
  }
  if (checks.checkerCount === 2 && !concrete(checks.nonOverlapReason)) {
    errors.push('a second checker requires a named separate responsibility')
  }
}

function canonicalCheckingPlan(checking) {
  return {
    checkerCount: checking.checkerCount,
    responsibilities: checking.responsibilities.slice(),
    nonOverlapReason: checking.nonOverlapReason,
  }
}

function validateAnalystComparison(comparison, chosenRoute, decision, errors) {
  if (!isObject(comparison)) {
    errors.push('analyst_comparison is required')
    return
  }
  const recommendation = comparison.recommended_route
  if (recommendation !== null && !ROUTES.includes(recommendation)) {
    errors.push('analyst_comparison.recommended_route must be a route or null')
    return
  }
  if (recommendation === chosenRoute && comparison.agrees !== true) {
    errors.push('matching analyst recommendation requires agrees=true')
  }
  if (recommendation !== null && recommendation !== chosenRoute &&
      (comparison.agrees !== false || !concrete(comparison.reason))) {
    errors.push('disagreement with the analyst requires agrees=false and a concrete reason')
  }
  if (recommendation === null && !concrete(comparison.reason)) {
    errors.push('missing analyst recommendation requires its failure or limitation reason')
  }
  for (const field of [
    'analyst_facts_fingerprint', 'l0_facts_fingerprint',
    'analyst_classifier_fingerprint', 'l0_classifier_fingerprint',
  ]) {
    if (!sha256(comparison[field])) errors.push(`analyst_comparison.${field} must be SHA-256`)
  }
  if (comparison.l0_facts_fingerprint !== decision.route_facts_fingerprint) {
    errors.push('analyst_comparison.l0_facts_fingerprint must bind the decision facts')
  }
  if (comparison.l0_classifier_fingerprint !== decision.classifier_fingerprint) {
    errors.push('analyst_comparison.l0_classifier_fingerprint must bind the frozen classifier')
  }
  const fingerprintChanged = comparison.analyst_facts_fingerprint !== comparison.l0_facts_fingerprint ||
    comparison.analyst_classifier_fingerprint !== comparison.l0_classifier_fingerprint
  if (recommendation !== null && recommendation !== chosenRoute && !fingerprintChanged) {
    errors.push('correcting a wrong analyst recommendation requires a changed fact or classifier fingerprint')
  }
  if (recommendation === chosenRoute && comparison.agrees === true && fingerprintChanged) {
    errors.push('agreement requires matching fact and classifier fingerprints')
  }
}

function validateRejectedRoutes(rejected, chosenRoute, errors) {
  if (!isObject(rejected)) {
    errors.push('rejected_route_reasons must be an object')
    return
  }
  const expected = ROUTES.filter(route => route !== chosenRoute).sort()
  const actual = Object.keys(rejected).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push('rejected_route_reasons must contain exactly the two rejected routes')
    return
  }
  for (const route of expected) {
    if (!requiredNonEmptyStringArray(rejected[route]) || rejected[route].some(item => !concreteRouteReason(item))) {
      errors.push(`rejected_route_reasons.${route} must contain evidence-bearing route reasons`)
    }
  }
}

function validateRouteChangeTrigger(trigger, errors) {
  if (!isObject(trigger) || !concrete(trigger.event) || trigger.new_fact_required !== true ||
      !concrete(trigger.matching_rule)) {
    errors.push('route_change_trigger must name an event, require a new fact, and state the matching rule')
  }
}

function canonicalAcceptance(acceptance) {
  if (!isObject(acceptance) || acceptance.valid !== true) return null
  return {
    terminalResult: acceptance.terminalResult,
    requiredAcceptance: acceptance.requiredAcceptance.slice(),
  }
}

function expectedRiskOverlays(facts) {
  const expected = new Set()
  if (facts.sideEffects.includes('permission-change') || ['confidential', 'restricted'].includes(facts.confidentiality)) {
    expected.add('authorization-security-privacy')
  }
  if (facts.sideEffects.includes('destructive-change')) expected.add('destructive-migration')
  if (facts.externality === 'external-write' || facts.sideEffects.some(effect => ['external-write', 'money-or-quota'].includes(effect))) {
    expected.add('external-write-or-cost')
  }
  if (facts.reversibility === 'irreversible') expected.add('irreversible-action')
  if (facts.mutableResources.some(resource => resource.shared)) expected.add('concurrency-or-shared-state')
  return [...expected].sort()
}

function gateRuleMatches(rule, selection) {
  const when = rule.when || {}
  if (when.baseWorkType && when.baseWorkType !== selection.baseWorkType) return false
  return !when.artifactOverlaysAny || when.artifactOverlaysAny.some(item => selection.artifactOverlays.includes(item))
}

function validateGateSelection(selection, factsInput) {
  if (!isObject(selection)) return { valid: false, status: 'GATE_SELECTION_REQUIRED', errors: ['gateSelection is required'] }
  const factValidation = router.validateRouteFacts(factsInput)
  if (!factValidation.valid) return { valid: false, status: 'GATE_SELECTION_INVALID', errors: factValidation.errors }
  const facts = factValidation.facts
  const errors = router.schemaErrors(selection, GATE_CONTRACT.composition.selectionSchema)
  const effectBases = {
    inspect: ['inspect-report'], report: ['inspect-report'], research: ['research-decide'], decide: ['research-decide'],
    mutate: ['mechanical-change', 'debug-fix', 'implement-build', 'refactor', 'review-polish'],
    'external-operation': ['external-operation'],
  }
  if (!effectBases[facts.requestedEffect].includes(selection.baseWorkType)) {
    errors.push(`baseWorkType ${selection.baseWorkType} is incompatible with requestedEffect ${facts.requestedEffect}`)
  }
  const selectedRisks = Array.isArray(selection.riskOverlays) ? selection.riskOverlays : []
  const riskEvidence = isObject(selection.riskEvidence) ? selection.riskEvidence : {}
  for (const requiredRisk of expectedRiskOverlays(facts)) {
    if (!selectedRisks.includes(requiredRisk)) errors.push(`gateSelection requires risk overlay ${requiredRisk}`)
  }
  if (!sameValue(Object.keys(riskEvidence).sort(), [...selectedRisks].sort())) {
    errors.push('riskEvidence keys must exactly match riskOverlays')
  }
  for (const incompatible of GATE_CONTRACT.composition.validation.incompatibleCombinations) {
    if (selection.baseWorkType === incompatible.baseWorkType && selectedRisks.includes(incompatible.riskOverlay)) {
      errors.push(incompatible.reason)
    }
  }
  for (const rule of GATE_CONTRACT.composition.validation.compoundRules) {
    if (!gateRuleMatches(rule, selection)) continue
    const required = rule.require || {}
    const forbidden = rule.forbid || {}
    if (required.resultFormats && !required.resultFormats.includes(selection.resultFormat)) errors.push(`${rule.id}: resultFormat`)
    for (const [field, values] of Object.entries(required)) {
      if (field === 'resultFormats') continue
      const targetField = field.replace(/Any$|All$/u, '')
      const actual = selection[targetField] || []
      if (field.endsWith('Any') && !values.some(value => actual.includes(value))) errors.push(`${rule.id}: ${field}`)
      if (field.endsWith('All') && !values.every(value => actual.includes(value))) errors.push(`${rule.id}: ${field}`)
    }
    for (const [field, values] of Object.entries(forbidden)) {
      const targetField = field.replace(/Any$|All$/u, '')
      const actual = selection[targetField] || []
      if (field.endsWith('Any') && values.some(value => actual.includes(value))) errors.push(`${rule.id}: forbids ${field}`)
    }
  }
  return {
    valid: errors.length === 0,
    status: errors.length === 0 ? 'GATE_SELECTION_ACCEPTED' : 'GATE_SELECTION_INVALID',
    errors,
  }
}

const DECISION_AUTHORITY = Object.freeze({
  FACTUAL: Object.freeze({ owner: 'evidence-owner', materiality: 'evidence-resolution', requiresUserDecision: false }),
  REVERSIBLE_TECHNICAL: Object.freeze({ owner: 'run-owner', materiality: 'reversible-default', requiresUserDecision: false }),
  PRODUCT_SEMANTIC: Object.freeze({ owner: 'user', materiality: 'material-user-decision', requiresUserDecision: true }),
  CONSEQUENTIAL_EXTERNAL: Object.freeze({ owner: 'user', materiality: 'material-user-decision', requiresUserDecision: true }),
  MISSION_CONTRADICTION: Object.freeze({ owner: 'user', materiality: 'material-user-decision', requiresUserDecision: true }),
})

function defaultDecisionClassifications(facts) {
  const classes = ['FACTUAL']
  if (facts.uncertainty === 'reversible-technical') classes.push('REVERSIBLE_TECHNICAL')
  if (facts.uncertainty === 'product-semantic') classes.push('PRODUCT_SEMANTIC')
  if (facts.externality === 'external-write' || facts.requestedEffect === 'external-operation' ||
      facts.sideEffects.some(effect => ['permission-change', 'money-or-quota', 'destructive-change'].includes(effect))) {
    classes.push('CONSEQUENTIAL_EXTERNAL')
  }
  return [...new Set(classes)].map(decisionClass => ({
    question: decisionClass === 'FACTUAL'
      ? 'Which recorded facts and checks determine the route?'
      : 'Which '+decisionClass.toLowerCase().replaceAll('_', ' ')+' choice remains?',
    class: decisionClass,
    ...DECISION_AUTHORITY[decisionClass],
  }))
}

function normalizeDecisionClassifications(input, facts) {
  const supplied = Array.isArray(input) && input.length > 0 ? input : defaultDecisionClassifications(facts)
  return supplied.map(item => ({
    question: item.question,
    class: item.class,
    owner: item.owner ?? DECISION_AUTHORITY[item.class]?.owner,
    materiality: item.materiality ?? DECISION_AUTHORITY[item.class]?.materiality,
    requiresUserDecision: item.requiresUserDecision ?? DECISION_AUTHORITY[item.class]?.requiresUserDecision,
  }))
}

function validateDecisionClassifications(classifications, errors) {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    errors.push('decisionClassifications must contain at least one authority decision')
    return
  }
  for (const item of classifications) {
    const authority = DECISION_AUTHORITY[item?.class]
    if (!authority || !concrete(item.question) || item.owner !== authority.owner ||
        item.materiality !== authority.materiality || item.requiresUserDecision !== authority.requiresUserDecision) {
      errors.push('decisionClassifications must bind '+(item?.class ?? 'unknown')+' to its exact authority')
    }
  }
}

function validateRouteDecision(decision) {
  const errors = []
  if (!isObject(decision)) return { valid: false, errors: ['decision must be an object'] }
  if (decision.schemaVersion !== ROUTE_DECISION_SCHEMA_VERSION) {
    errors.push('schemaVersion must be '+ROUTE_DECISION_SCHEMA_VERSION)
  }
  if (!sha256(decision.requestEnvelopeHash)) errors.push('requestEnvelopeHash must be SHA-256')
  if (!sha256(decision.recommendationHash)) errors.push('recommendationHash must be SHA-256')
  if (Number.isNaN(Date.parse(decision.decidedAt))) errors.push('decidedAt must be a date-time')
  if (decision.status === 'WAITING_USER') {
    if (decision.route !== null) errors.push('WAITING_USER requires route=null')
    if (decision.routeSource !== 'automatic') errors.push('WAITING_USER requires routeSource=automatic')
    if (!requiredNonEmptyStringArray(decision.userInputNeeded)) errors.push('WAITING_USER requires indispensable userInputNeeded')
    return { valid: errors.length === 0, errors }
  }
  if (decision.status !== 'DECIDED') errors.push('status must be DECIDED or WAITING_USER')
  if (!ROUTES.includes(decision.route)) errors.push('route must be DIRECT, LIGHT, or ROADMAP')
  const explicitPath = exactPathSelection(decision.pathSelection, decision.route)
  if (decision.pathSelection !== undefined && !explicitPath) {
    errors.push('pathSelection must bind an exact requested route, bypass automatic selection, and forbid silent route changes')
  }
  const expectedRouteSource = explicitPath ? 'explicit_control' : 'automatic'
  if (decision.routeSource !== expectedRouteSource) {
    errors.push(`routeSource must be ${expectedRouteSource} and is derived from pathSelection, never the route name`)
  }
  if (!concrete(decision.requestedResult)) errors.push('requestedResult must be non-empty')
  for (const field of DECISION_ARRAY_FIELDS) {
    if (!nonEmptyStringArray(decision[field])) errors.push(field+' must be an array of non-empty strings')
  }
  for (const field of ['successChecklist', 'plannedChecks', 'likelyAreas']) {
    if (!requiredNonEmptyStringArray(decision[field])) errors.push(field+' must contain at least one item')
  }
  const canonicalVerification = canonicalVerificationObligations(decision.verificationObligations)
  const requiredVerificationUnion = verificationObligationsForRequest(
    decision.requestedResult,
    decision.verificationObligations,
  )
  if (!canonicalVerification || !requiredVerificationUnion ||
      !sameValue(canonicalVerification, requiredVerificationUnion)) {
    errors.push('verificationObligations must preserve the canonical provider-authored typed acceptance matrix')
  }
  if (!Array.isArray(decision.existingTests) || decision.existingTests.length === 0 ||
      new Set(decision.existingTests.map(item => item && item.id)).size !== decision.existingTests.length ||
      decision.existingTests.some(item => !isObject(item) || !concrete(item.id) || !concrete(item.command))) {
    errors.push('existingTests must preserve a populated unique executable baseline')
  }
  if (!Number.isSafeInteger(decision.usefulWorkerCount) || decision.usefulWorkerCount < 1) errors.push('usefulWorkerCount must be a positive integer')
  if (!concrete(decision.workerOwnershipReason)) errors.push('workerOwnershipReason must be concrete')
  validateIndependentChecks(decision.independentCheckingPlan, errors)
  validateDecisionClassifications(decision.decisionClassifications, errors)
  const factValidation = router.validateRouteFacts(decision.normalizedRouteFacts)
  if (!factValidation.valid) {
    errors.push(...factValidation.errors.map(error => 'normalizedRouteFacts: '+error))
  } else {
    const facts = factValidation.facts
    const domainValidation = capturedDomain.validateContracts(decision.capturedDomainContracts, facts)
    if (!domainValidation.valid) errors.push(...domainValidation.errors.map(error => `capturedDomainContracts: ${error}`))
    const hiddenBoundary = domainValidation.contracts.find(contract => contract.kind === 'HIDDEN_EXTERNAL_ORACLE')
    if (hiddenBoundary && decision.usefulWorkerCount > hiddenBoundary.maxProvisionalWorkerLaunches) {
      errors.push('hidden external verification boundary exceeds its provisional worker cap')
    }
    // Exact-path admission already authenticated the deterministic safety
    // floor. Its required production baseline is a later execution gate, not
    // a second route-decision probe with an admission budget of its own.
    const classified = router.classifyRoute(facts, explicitPath ? { safetyFloorOnly: true } : {})
    if (classified.status !== 'DECIDED' || (!explicitPath && classified.route !== decision.route)) {
      errors.push('normalized route facts must compile to the recorded route unless an exact user path is locked')
    }
    if (decision.routeFactsFingerprint !== classified.facts_fingerprint) errors.push('routeFactsFingerprint must match the exact normalized facts')
    if (decision.classifierFingerprint !== router.ROUTE_CLASSIFIER_FINGERPRINT) errors.push('classifierFingerprint must match the frozen route contract')
    if (!sameValue(decision.acceptance, canonicalAcceptance(classified.acceptance))) errors.push('acceptance must be derived from requestedEffect')
    const expectedCapabilities = explicitPath
      ? router.requiredCapabilitiesForFacts(facts, decision.route)
      : classified.requiredCapabilities
    if (!sameValue(decision.requiredCapabilities, expectedCapabilities)) errors.push('requiredCapabilities must be derived from route and requested effect')
    const gateSelectionValidation = validateGateSelection(decision.gateSelection, facts)
    if (!gateSelectionValidation.valid) errors.push(...gateSelectionValidation.errors)
    const expectedFreeze = candidateFreezeContract(facts)
    if (!sameValue(decision.candidateFreeze, expectedFreeze)) errors.push('versionFreeze must match route facts and be required before checking')
    const ownership = validateOwnership(decision.mutableResourceOwnership, facts)
    errors.push(...ownership.errors)
    if (explicitPath && decision.usefulWorkerCount !== 1) {
      errors.push('an exact path admits exactly one useful worker')
    } else if (!explicitPath && decision.usefulWorkerCount !== 1 &&
        !hasExactDisjointAutomaticWorkerProof(
          decision.route, facts, ownership.ownership, decision.usefulWorkerCount,
        )) {
      errors.push('automatic routing admits multiple workers only for two or three exactly bound disjoint ROADMAP resources')
    }
    const expectedChecks = selectIndependentChecking({ facts })
    if (!expectedChecks.valid || !sameValue(decision.independentCheckingPlan, canonicalCheckingPlan(expectedChecks))) errors.push('independentCheckingPlan must be automatically derived from risk and requested effect')
    const expectedTopology = buildRouteTopology(decision.route, {
      facts,
      mutableResourceOwnership: ownership.ownership,
      workerCount: decision.usefulWorkerCount,
      scoutCount: 0,
      namedUnknowns: [],
      managerCount: 0,
      pathSelection: decision.pathSelection,
    })
    if (!expectedTopology.valid) {
      errors.push(...expectedTopology.errors.map(error => `topology: ${error}`))
    } else if (!sameValue(decision.topology, expectedTopology) &&
        !sameValue(decision.topology, legacyRoadmapProviderTopology(expectedTopology))) {
      errors.push('topology must equal the deterministic controller plan, worker, checker, and physical-session topology')
    }
    if (!isObject(decision.assurancePreconditions) || decision.assurancePreconditions.mutableResourceOwnershipValid !== true ||
        decision.assurancePreconditions.candidateFreezeBeforeCheck !== true ||
        decision.assurancePreconditions.frozenVersionIdRequired !== facts.candidateFreeze.required) {
      errors.push('checking preconditions must require ownership and a frozen version before checking')
    }
  }
  if (!concrete(decision.chosenRouteReason)) errors.push('chosenRouteReason must be concrete')
  const rejected = decision.rejectedRouteReasons
  if (!isObject(rejected)) errors.push('rejectedRouteReasons must be an object')
  else {
    const expected = ROUTES.filter(route => route !== decision.route).sort()
    if (!sameValue(Object.keys(rejected).sort(), expected) || expected.some(route => !concreteRouteReason(rejected[route]))) {
      errors.push('rejectedRouteReasons must contain exactly the two rejected routes with evidence-bearing reasons')
    }
  }
  if (!isObject(decision.routeChangeTrigger) || !concrete(decision.routeChangeTrigger.event) ||
      !concrete(decision.routeChangeTrigger.factRequired)) errors.push('routeChangeTrigger must name an event and the exact fact required')
  if (decision.analystDisagreement !== null) {
    const disagreement = decision.analystDisagreement
    if (!isObject(disagreement) || disagreement.recommendation === decision.route ||
        !ROUTES.includes(disagreement.recommendation) || !concrete(disagreement.concreteReason)) {
      errors.push('analystDisagreement must describe a different route and concrete reason')
    } else {
      for (const field of ['analystFactsFingerprint', 'l0FactsFingerprint', 'analystClassifierFingerprint', 'l0ClassifierFingerprint']) {
        if (!sha256(disagreement[field])) errors.push('analystDisagreement.'+field+' must be SHA-256')
      }
      const changed = disagreement.analystFactsFingerprint !== disagreement.l0FactsFingerprint ||
        disagreement.analystClassifierFingerprint !== disagreement.l0ClassifierFingerprint
      if (!changed) errors.push('wrong analyst correction requires a changed fact or classifier fingerprint')
      if (disagreement.l0FactsFingerprint !== decision.routeFactsFingerprint ||
          disagreement.l0ClassifierFingerprint !== decision.classifierFingerprint) errors.push('analystDisagreement must bind the final facts and classifier')
    }
  }
  if (!isObject(decision.topology) || decision.topology.valid !== true || decision.topology.route !== decision.route) errors.push('topology must be the valid topology for the chosen route')
  return { valid: errors.length === 0, errors }
}

function createWaitingUserDecision(userInputNeeded, options = {}) {
  return {
    schemaVersion: ROUTE_DECISION_SCHEMA_VERSION,
    status: 'WAITING_USER',
    route: null,
    routeSource: 'automatic',
    userInputNeeded: Array.isArray(userInputNeeded) ? userInputNeeded.slice() : [userInputNeeded],
    requestEnvelopeHash: options.requestEnvelopeHash ?? options.request_envelope_hash ?? null,
    recommendationHash: options.recommendationHash ?? options.recommendation_hash ?? null,
    decidedAt: options.decidedAt ?? new Date(options.nowMs ?? Date.now()).toISOString(),
  }
}

function createRouteDecision(input = {}) {
  const normalizedFacts = router.normalizeFacts(input.routeFacts ?? input.route_facts ?? input.normalizedRouteFacts ?? input.normalized_route_facts)
  const requestedExactPath = exactPathSelection(
    input.pathSelection ?? input.path_selection,
    input.route ?? null,
  )
  const classified = router.classifyRoute(normalizedFacts, requestedExactPath
    ? { safetyFloorOnly: true }
    : { probeEvidence: input.probeEvidence ?? input.probe_evidence })
  const route = input.route ?? (classified.status === 'DECIDED' ? classified.route : null)
  const pathSelection = exactPathSelection(input.pathSelection ?? input.path_selection, route)
  const independentCheckingPlan = selectIndependentChecking({ facts: normalizedFacts })
  const ownership = normalizeOwnership(input.mutableResourceOwnership ?? input.mutable_resource_ownership, normalizedFacts)
  const workers = isObject(input.workers) ? input.workers : {}
  const comparison = input.analystComparison ?? input.analyst_comparison
  const recommendation = comparison?.recommendedRoute ?? comparison?.recommended_route ?? null
  const analystDisagreement = recommendation !== null && recommendation !== route
    ? {
        recommendation,
        concreteReason: comparison.reason,
        analystFactsFingerprint: comparison.analystFactsFingerprint ?? comparison.analyst_facts_fingerprint,
        l0FactsFingerprint: classified.facts_fingerprint,
        analystClassifierFingerprint: comparison.analystClassifierFingerprint ?? comparison.analyst_classifier_fingerprint,
        l0ClassifierFingerprint: router.ROUTE_CLASSIFIER_FINGERPRINT,
      }
    : null
  const rejectedInput = input.rejectedRouteReasons ?? input.rejected_route_reasons ?? {}
  const rejectedRouteReasons = Object.fromEntries(Object.entries(rejectedInput).map(([rejectedRoute, reasons]) => [
    rejectedRoute,
    Array.isArray(reasons) ? reasons.join(' ') : reasons,
  ]))
  const routeChange = input.routeChangeTrigger ?? input.route_change_trigger ?? {}
  const topology = buildRouteTopology(route, {
    facts: normalizedFacts,
    mutableResourceOwnership: ownership,
    workerCount: workers.count ?? input.usefulWorkerCount ?? 1,
    scoutCount: 0,
    namedUnknowns: [],
    managerCount: 0,
    pathSelection,
  })
  const capturedDomainContracts = capturedDomain.normalizeContracts(
    input.capturedDomainContracts ?? input.captured_domain_contracts,
    normalizedFacts,
  )
  const plannedChecks = input.plannedChecks ?? input.checks ?? []
  const verificationObligations = verificationObligationsForRequest(
    input.requestedResult ?? input.requested_result,
    input.verificationObligations ?? input.verification_obligations,
    plannedChecks,
  )
  const suppliedExistingTests = input.existingTests ?? input.existing_tests
  const existingTests = Array.isArray(suppliedExistingTests) && suppliedExistingTests.length
    ? suppliedExistingTests.map(item => ({ id: String(item.id), command: String(item.command) }))
    : plannedChecks.map((command, index) => ({ id: `planned-check-${index + 1}`, command: String(command) }))
  return {
    schemaVersion: ROUTE_DECISION_SCHEMA_VERSION,
    status: 'DECIDED',
    route,
    routeSource: pathSelection ? 'explicit_control' : 'automatic',
    ...(pathSelection ? { pathSelection: clone(pathSelection) } : {}),
    requestedResult: Array.isArray(input.requestedResult ?? input.requested_result)
      ? (input.requestedResult ?? input.requested_result).join(' ')
      : (input.requestedResult ?? input.requested_result ?? ''),
    successChecklist: input.successChecklist ?? input.success_checklist ?? [],
    plannedChecks,
    verificationObligations,
    existingTests,
    likelyAreas: input.likelyAreas ?? input.likely_areas ?? [],
    risks: input.risks ?? input.risksAndMissingInformation ?? input.risks_and_missing_information ?? [],
    missingInformation: input.missingInformation ?? [],
    usefulWorkerCount: workers.count ?? input.usefulWorkerCount ?? 1,
    workerOwnershipReason: workers.nonOverlapReason ?? workers.non_overlap_reason ?? input.workerOwnershipReason ?? '',
    independentCheckingPlan: canonicalCheckingPlan(independentCheckingPlan),
    chosenRouteReason: Array.isArray(input.chosenRouteReason ?? input.chosenRouteReasons ?? input.chosen_route_reasons)
      ? (input.chosenRouteReason ?? input.chosenRouteReasons ?? input.chosen_route_reasons).join(' ')
      : (input.chosenRouteReason ?? input.chosenRouteReasons ?? input.chosen_route_reasons ?? ''),
    rejectedRouteReasons,
    analystDisagreement,
    routeChangeTrigger: {
      event: routeChange.event,
      factRequired: routeChange.factRequired ?? routeChange.matching_rule,
    },
    decisionClassifications: normalizeDecisionClassifications(input.decisionClassifications ?? input.decision_classifications, normalizedFacts),
    capturedDomainContracts,
    requestEnvelopeHash: input.requestEnvelopeHash ?? input.request_envelope_hash ?? null,
    recommendationHash: input.recommendationHash ?? input.recommendation_hash ??
      input.analystEvidenceIndexHash ?? input.analyst_evidence_index_hash ?? null,
    decidedAt: input.decidedAt ?? new Date(input.nowMs ?? Date.now()).toISOString(),
    normalizedRouteFacts: normalizedFacts,
    routeFactsFingerprint: classified.facts_fingerprint,
    classifierFingerprint: router.ROUTE_CLASSIFIER_FINGERPRINT,
    acceptance: canonicalAcceptance(classified.acceptance),
    requiredCapabilities: (pathSelection
      ? router.requiredCapabilitiesForFacts(normalizedFacts, route)
      : classified.requiredCapabilities).slice(),
    gateSelection: clone(input.gateSelection ?? input.gate_selection ?? null),
    mutableResourceOwnership: ownership,
    candidateFreeze: candidateFreezeContract(normalizedFacts),
    assurancePreconditions: {
      mutableResourceOwnershipValid: validateOwnership(ownership, normalizedFacts).valid,
      candidateFreezeBeforeCheck: true,
      frozenVersionIdRequired: normalizedFacts.candidateFreeze.required,
    },
    topology,
  }
}

const EXACT_PATH_ROUTE_RANK = Object.freeze({ DIRECT: 0, LIGHT: 1, ROADMAP: 2 })

function exactPathFailure(code, errors) {
  return { status: code, accepted: false, start_workers: false, errors: errors.slice() }
}

/**
 * Validate the output of a deterministic, non-model preflight. The receipt is
 * bound to the opened request envelope and must name its evidence and verified
 * capabilities; route facts are never guessed by the exact-path compiler.
 */
function evaluateExactPathPreflight(input = {}) {
  const route = String(input.route || '').toUpperCase()
  if (!ROUTES.includes(route)) return exactPathFailure('EXACT_PATH_INVALID', ['route must be DIRECT, LIGHT, or ROADMAP'])
  const preflight = input.preflight
  if (!isObject(preflight)) return exactPathFailure('EXACT_PATH_PREFLIGHT_REQUIRED', ['deterministic exact-path preflight is required'])
  if (preflight.schemaVersion !== 1 || preflight.source !== 'deterministic-preflight') {
    return exactPathFailure('EXACT_PATH_PREFLIGHT_INVALID', ['preflight schemaVersion/source is invalid'])
  }
  if (!sha256(input.requestEnvelopeHash) || preflight.requestEnvelopeHash !== input.requestEnvelopeHash) {
    return exactPathFailure('EXACT_PATH_PREFLIGHT_BINDING_INVALID', ['preflight is not bound to the opened request envelope'])
  }
  if (input.targetIdentity !== undefined && preflight.targetIdentity !== input.targetIdentity) {
    return exactPathFailure('EXACT_PATH_PREFLIGHT_BINDING_INVALID', ['preflight is not bound to the opened target identity'])
  }
  if (!sha256(input.providerCapabilitiesHash) || preflight.providerCapabilitiesHash !== input.providerCapabilitiesHash ||
      !sha256(input.budgetSnapshotHash) || preflight.budgetSnapshotHash !== input.budgetSnapshotHash) {
    return exactPathFailure('EXACT_PATH_PREFLIGHT_BINDING_INVALID', [
      'preflight is not bound to the current provider capability and budget snapshots',
    ])
  }
  if (!Array.isArray(preflight.evidenceHashes) || preflight.evidenceHashes.length === 0 ||
      preflight.evidenceHashes.some(hash => !sha256(hash))) {
    return exactPathFailure('EXACT_PATH_PREFLIGHT_EVIDENCE_INVALID', ['preflight requires one or more SHA-256 evidence hashes'])
  }
  if (!isObject(preflight.routeFacts)) {
    return exactPathFailure('EXACT_PATH_FACTS_REQUIRED', ['deterministic route facts are required'])
  }
  const factsValidation = router.validateRouteFacts(preflight.routeFacts)
  if (!factsValidation.valid) return exactPathFailure('EXACT_PATH_FACTS_INVALID', factsValidation.errors)
  const facts = factsValidation.facts
  if (facts.missingUserInput.length > 0 || facts.targetAuthorization.allTargetsAuthorized !== true ||
      facts.costAuthority.withinLimit !== true) {
    return exactPathFailure('EXACT_PATH_USER_INPUT_REQUIRED', ['exact-path safety facts require complete input, target authority, and cost authority'])
  }
  if (facts.transportCapability.taskCapabilityPreserved !== true ||
      (facts.candidateFreeze.required &&
        (!facts.candidateFreeze.available || !facts.candidateFreeze.environmentCanBeBound))) {
    return exactPathFailure('EXACT_PATH_PROVIDER_UNSUPPORTED', ['exact-path safety facts require preserved transport and exact-version isolation'])
  }
  const budgetParts = facts.deadlineBudget
  const requiredSeconds = budgetParts.admissionSeconds + budgetParts.executionReserveSeconds +
    budgetParts.verificationReserveSeconds + budgetParts.recoveryAndFinalizationReserveSeconds
  if (requiredSeconds > budgetParts.remainingSeconds + Number.EPSILON * Math.max(1, budgetParts.remainingSeconds)) {
    return exactPathFailure('EXACT_PATH_BUDGET_INSUFFICIENT', ['exact-path safety reserves exceed the live deadline budget'])
  }
  // Exact path selection may raise the route above the deterministic safety
  // floor, but it cannot waive that floor. In particular, irreversible or
  // otherwise staged work never becomes DIRECT merely because the user chose
  // the direct control path.
  const routeFloor = router.classifyRoute(facts, { safetyFloorOnly: true })
  if (routeFloor.status !== 'DECIDED' || !ROUTES.includes(routeFloor.route) ||
      EXACT_PATH_ROUTE_RANK[route] < EXACT_PATH_ROUTE_RANK[routeFloor.route]) {
    return exactPathFailure('EXACT_PATH_ROUTE_FLOOR_UNSATISFIED', [
      routeFloor.status === 'DECIDED' && ROUTES.includes(routeFloor.route)
        ? `exact path ${route} is below the deterministic ${routeFloor.route} safety floor`
        : `deterministic route floor is not satisfiable: ${routeFloor.status}`,
    ])
  }
  const classified = {
    ...routeFloor,
    route,
    acceptance: router.acceptanceContractForEffect(facts.requestedEffect),
    requiredCapabilities: router.requiredCapabilitiesForFacts(facts, route),
    exactPathSelectionBypassed: true,
  }
  const verified = new Set(Array.isArray(preflight.verifiedCapabilities) ? preflight.verifiedCapabilities : [])
  const required = router.requiredCapabilitiesForFacts(factsValidation.facts, route)
  const missing = required.filter(capability => !verified.has(capability))
  const contradicted = required.filter(capability =>
    isObject(input.providerCapabilities) && own(input.providerCapabilities, capability) &&
    input.providerCapabilities[capability] !== true)
  if (missing.length > 0 || contradicted.length > 0) {
    return exactPathFailure('EXACT_PATH_PROVIDER_UNSUPPORTED', [
      ...missing.map(capability => `unverified capability: ${capability}`),
      ...contradicted.map(capability => `live provider capability is unavailable: ${capability}`),
    ])
  }
  const liveRemainingMs = Number(input.budget?.remaining?.wallMs ??
    (Number(input.budget?.limits?.wallMs) - Number(input.budget?.consumedWallMs)))
  const factRemainingMs = factsValidation.facts.deadlineBudget.remainingSeconds * 1000
  if (!Number.isFinite(liveRemainingMs) || liveRemainingMs < factRemainingMs) {
    return exactPathFailure('EXACT_PATH_BUDGET_INSUFFICIENT', [
      'deterministic route facts exceed the current live wall-clock budget',
    ])
  }
  return {
    status: 'EXACT_PATH_PREFLIGHT_ACCEPTED', accepted: true, start_workers: true,
    route, routeFacts: factsValidation.facts, classification: classified,
    evidenceHashes: preflight.evidenceHashes.slice(), verifiedCapabilities: [...verified].sort(),
  }
}

function exactPathGateSelection(facts) {
  const riskOverlays = expectedRiskOverlays(facts)
  const riskEvidence = Object.fromEntries(riskOverlays.map(risk => [risk, `Deterministic route facts require ${risk}.`]))
  if (facts.requestedEffect === 'external-operation') return {
    baseWorkType: 'external-operation', resultFormat: 'external-receipt', artifactOverlays: ['external-system'],
    acceptanceOverlays: ['receipts', 'external-prepare', 'external-commit', 'external-reconcile', 'external-rollback', 'external-idempotency'],
    riskOverlays, riskEvidence,
  }
  if (['inspect', 'report'].includes(facts.requestedEffect)) return {
    baseWorkType: 'inspect-report', resultFormat: 'read-only-findings', artifactOverlays: ['read-only-result'],
    acceptanceOverlays: ['receipts'], riskOverlays, riskEvidence,
  }
  if (['research', 'decide'].includes(facts.requestedEffect)) return {
    baseWorkType: 'research-decide', resultFormat: 'decision-record', artifactOverlays: ['read-only-result'],
    acceptanceOverlays: ['receipts'], riskOverlays, riskEvidence,
  }
  return {
    baseWorkType: 'mechanical-change', resultFormat: 'changed-files', artifactOverlays: ['executable-code'],
    acceptanceOverlays: ['exact-diff'], riskOverlays, riskEvidence,
  }
}

function automaticProposalWithinActivationAuthority(proposal, targetIdentity = '.') {
  const authorityOnlyEffects = new Set([
    'external-write', 'message-or-notification', 'money-or-quota',
  ])
  const claimsUnattestedExternalAuthority = proposal.requestedEffect === 'external-operation' ||
    proposal.externality === 'external-write' ||
    proposal.thirdPartyImpact === 'material' ||
    proposal.sideEffects.some(effect => authorityOnlyEffects.has(effect))
  if (!claimsUnattestedExternalAuthority) return proposal

  // A route analyst is read-only advisory work. Its structured output can
  // characterize local work, but it cannot grant an external target, cost, or
  // notification authority that was absent from the controller activation.
  // Collapse such claims to one activation-target mutation. A separately
  // authenticated external operation remains a future controller boundary,
  // never something mission prose or model-authored facts can activate.
  return {
    ...proposal,
    requestedEffect: 'mutate',
    mutableResources: [{
      kind: 'directory',
      identity: nonEmpty(targetIdentity) ? targetIdentity.trim() : '.',
      shared: false,
      ownershipMode: 'single-owner',
    }],
    sideEffects: [
      ...new Set([
        ...proposal.sideEffects.filter(effect => !authorityOnlyEffects.has(effect)),
        'deliverable-write',
      ]),
    ].sort(),
    externality: 'local-only',
    thirdPartyImpact: 'none',
  }
}

function compileAutomaticRouteDecision(input = {}) {
  const normalized = canonicalizeProviderRecommendation(input.recommendation)
  const recommendation = normalized.recommendation
  if (!normalized.valid || recommendation.preWorkResult !== 'CONTINUE') {
    const error = new Error(normalized.errors.join('; ') || 'automatic decision requires CONTINUE')
    error.code = 'ROUTE_DECISION_INVALID'
    throw error
  }
  const proposal = projectProviderProposalToRouter(
    automaticProposalWithinActivationAuthority(
      recommendation.routeFactProposal,
      input.targetIdentity,
    ),
  )
  const remainingMs = Number(input.budget?.remaining?.wallMs ?? input.remainingMs ?? 3600000)
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    const error = new Error('automatic route compiler requires a positive live budget')
    error.code = 'ROUTE_DECISION_INVALID'
    throw error
  }
  const remainingSeconds = remainingMs / 1000
  const mutating = proposal.requestedEffect === 'mutate'
  const facts = {
    schemaVersion: router.ROUTE_FACTS_SCHEMA_VERSION,
    requestedEffect: proposal.requestedEffect,
    successCriteria: 'ready',
    dependency: {
      shape: proposal.dependencyShape,
      dependentWorkGroupCount: proposal.dependentWorkGroupCount,
      integrationOwnerRequired: proposal.integrationOwnerRequired,
      separateDependentBodies: proposal.dependentWorkGroupCount,
    },
    uncertainty: proposal.uncertainty,
    reversibility: proposal.reversibility,
    mutableResources: proposal.mutableResources,
    sideEffects: proposal.sideEffects,
    externality: proposal.externality,
    confidentiality: proposal.confidentiality,
    thirdPartyImpact: proposal.thirdPartyImpact,
    targetAuthorization: {
      targetIdentities: [], authorizedTargetIdentities: [], authorizationEvidenceHash: null,
    },
    costAuthority: {
      mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0,
      approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null,
    },
    riskAndIndependentCheckFloor: {
      level: proposal.riskLevel,
      minimumCheckerCount: proposal.minimumCheckerCount,
      namedDistinctResponsibilities: proposal.namedDistinctResponsibilities,
    },
    checkAndBaseline: {
      checkQuality: proposal.checkQuality,
      availableCheckKinds: proposal.availableCheckKinds,
      baselineStatus: proposal.baselineStatus,
      hiddenExternalCheck: proposal.hiddenExternalCheck,
    },
    capturedIncidentDomains: proposal.hiddenExternalCheck ? ['HIDDEN_EXTERNAL_ORACLE'] : [],
    deadlineBudget: {
      remainingSeconds,
      admissionSeconds: 0,
      executionReserveSeconds: remainingSeconds * 0.55,
      verificationReserveSeconds: remainingSeconds * 0.3,
      recoveryAndFinalizationReserveSeconds: remainingSeconds * 0.1,
    },
    operatorMinimumRoute: null,
    transportCapability: {
      mode: input.providerCapabilities?.sameContextContinuation === true
        ? 'native-recursive' : 'sequential-isolated',
      taskCapabilityPreserved: true,
    },
    candidateFreeze: {
      required: mutating,
      available: input.providerCapabilities?.isolatedChecking === true,
      environmentCanBeBound: input.providerCapabilities?.stableChildIdentity === true,
    },
    missingUserInput: recommendation.userInputNeeded,
    architectureImpact: proposal.architectureImpact,
    fitsLightPlan: proposal.fitsLightPlan,
    approachNeedsShortPlanning: proposal.approachNeedsShortPlanning,
    shortOrderUnclear: proposal.shortOrderUnclear,
  }
  // Automatic route compilation establishes the route floor. The immutable
  // executable baseline is captured by the later production gate; requiring
  // probe evidence here made a truthful provider `unknown` baseline collapse
  // before the worker could even reach that gate.
  const classified = router.classifyRoute(facts, { safetyFloorOnly: true })
  if (classified.status !== 'DECIDED') {
    const error = new Error(`deterministic automatic route classification returned ${classified.status}`)
    error.code = classified.status === 'WAITING_USER' ? 'WAITING_USER' : 'ROUTE_DECISION_INVALID'
    error.details = classified
    throw error
  }
  const route = classified.route
  if (recommendation.recommendedRoute !== route) {
    const error = new Error(
      `route analyst recommendation ${recommendation.recommendedRoute} contradicts its deterministic fact classification ${route}`,
    )
    error.code = 'ROUTE_DECISION_INVALID'
    throw error
  }
  const workerCount = automaticWorkerCount(route, recommendation, proposal)
  const ownership = facts.mutableResources.map((resource, index) => ({
    kind: resource.kind,
    identity: resource.identity,
    owner: `worker-${index % workerCount + 1}`,
    ownershipMode: resource.ownershipMode,
  }))
  const routeReasonField = `reasonsFor${route[0]}${route.slice(1).toLowerCase()}`
  const rejectedRouteReasons = Object.fromEntries(ROUTES.filter(other => other !== route).map(other => {
    const field = `reasonsFor${other[0]}${other.slice(1).toLowerCase()}`
    return [other, recommendation[field]]
  }))
  const recommendationHash = crypto.createHash('sha256').update(JSON.stringify(recommendation)).digest('hex')
  return createRouteDecision({
    route,
    routeFacts: facts,
    mutableResourceOwnership: ownership,
    requestedResult: input.requestedResult,
    successChecklist: recommendation.whatTheUserWants,
    plannedChecks: recommendation.howSuccessCanBeChecked,
    verificationObligations: recommendation.verificationObligations,
    likelyAreas: recommendation.likelyAreas,
    risks: [...recommendation.risks, ...recommendation.unknowns],
    missingInformation: recommendation.unknowns,
    workers: {
      count: workerCount,
      nonOverlapReason: workerCount === 1
        ? 'One worker owns the connected or coupled mutation boundary sequentially.'
        : 'Each named independent work item identifies one distinct, unshared mutable resource.',
    },
    chosenRouteReason: recommendation[routeReasonField].join(' '),
    rejectedRouteReasons,
    analystComparison: {
      recommendedRoute: recommendation.recommendedRoute,
      reason: recommendation.recommendedRoute === route
        ? 'The deterministic classifier agrees with the analyst fact proposal.'
        : 'The deterministic classifier corrected the advisory route from the normalized fact proposal.',
      analystFactsFingerprint: classified.facts_fingerprint,
      analystClassifierFingerprint: router.ROUTE_CLASSIFIER_FINGERPRINT,
    },
    routeChangeTrigger: {
      event: route === 'DIRECT' ? 'SPEC_MISUNDERSTOOD' : 'MULTI_SURFACE_DISCOVERED',
      factRequired: route === 'DIRECT'
        ? 'Acceptance evidence proves the request semantics were misunderstood.'
        : 'New evidence proves dependent writable surfaces require coordination.',
    },
    gateSelection: exactPathGateSelection(classified.normalized_facts),
    requestEnvelopeHash: input.requestEnvelopeHash,
    recommendationHash,
    nowMs: input.nowMs,
  })
}

function compileConservativeCompletionDecision(input = {}) {
  const requestedResult = nonEmpty(input.requestedResult)
    ? input.requestedResult.trim()
    : 'Complete the exact user request in the local workspace.'
  const successCheck = 'Independently exercise the requested result, its forbidden counterpart, and its exact boundary behavior.'
  const rawDescriptive = validateJsonSchema(
    CODEX_ROUTE_RECOMMENDATION_SCHEMA,
    input.descriptiveRecommendation,
  ).valid ? input.descriptiveRecommendation : null
  // Provider transport schemas cannot express every controller semantic
  // invariant (for example, a string containing only whitespace can satisfy a
  // minLength). Preserve the useful task-specific projection while trimming
  // and dropping only those unusable values; conservative routing must not
  // become another pre-work terminal merely because advisory prose is blank.
  const descriptiveStrings = (field, fallback = []) => {
    const values = rawDescriptive && Array.isArray(rawDescriptive[field])
      ? rawDescriptive[field].filter(value => typeof value === 'string')
          .map(value => value.trim()).filter(Boolean)
      : []
    return values.length > 0 ? values : [...fallback]
  }
  const descriptiveChecks = descriptiveStrings('howSuccessCanBeChecked', [successCheck])
  const descriptive = rawDescriptive ? {
    whatTheUserWants: descriptiveStrings('whatTheUserWants', [requestedResult]),
    likelyAreas: descriptiveStrings('likelyAreas', [
      nonEmpty(input.targetIdentity) ? input.targetIdentity.trim() : '.',
    ]),
    howSuccessCanBeChecked: descriptiveChecks,
    unknowns: descriptiveStrings('unknowns'),
    risks: descriptiveStrings('risks'),
    verificationObligations: canonicalizeProviderVerificationObligations(
      rawDescriptive.verificationObligations,
      descriptiveChecks,
    ),
  } : null
  const recommendation = createRouteRecommendation({
    preWorkResult: 'CONTINUE',
    recommendedRoute: 'DIRECT',
    confidence: 'low',
    whatTheUserWants: descriptive ? descriptive.whatTheUserWants : [requestedResult],
    likelyAreas: descriptive ? descriptive.likelyAreas : [
      nonEmpty(input.targetIdentity) ? input.targetIdentity.trim() : '.',
    ],
    howSuccessCanBeChecked: descriptive ? descriptive.howSuccessCanBeChecked : [successCheck],
    unknowns: descriptive ? descriptive.unknowns : [
      'The route-analysis provider did not produce a usable decision; the single completion worker must inspect the exact workspace before acting.',
    ],
    risks: descriptive ? descriptive.risks : [
      'Keep all effects local and reversible, preserve unrelated behavior, and require independent verification of the exact result.',
    ],
    independentWorkItems: [],
    dependencies: [],
    reasonsForDirect: ['One completion worker owns the bounded local workspace and can inspect, implement, and test the exact request sequentially.'],
    reasonsForLight: ['No verified reversible design uncertainty exists to justify a separate planning generation.'],
    reasonsForRoadmap: ['No verified dependent work groups or disjoint mutable ownership exist to justify coordination generations.'],
    userInputNeeded: [],
    evidenceIndex: [],
    routeFactProposal: defaultRouteFactProposal('DIRECT'),
    ...(descriptive && descriptive.verificationObligations
      ? { verificationObligations: descriptive.verificationObligations } : {}),
  })
  const reportedRemaining = Number(input.budget && input.budget.remaining && input.budget.remaining.wallMs)
  const completionBudget = {
    remaining: {
      wallMs: Number.isFinite(reportedRemaining) && reportedRemaining > 0
        ? reportedRemaining : L0_DECISION_CONVERGENCE_WATCHDOG_MS,
    },
  }
  return compileAutomaticRouteDecision({
    recommendation,
    requestedResult,
    requestEnvelopeHash: input.requestEnvelopeHash,
    providerCapabilities: input.providerCapabilities,
    budget: completionBudget,
    nowMs: input.nowMs,
  })
}

function automaticWorkerCount(route, recommendation, proposal) {
  if (route !== 'ROADMAP' || proposal.requestedEffect === 'external-operation' ||
      proposal.externality === 'external-write' || proposal.dependencyShape !== 'independent-edits' ||
      proposal.integrationOwnerRequired || proposal.dependentWorkGroupCount > 0 ||
      recommendation.dependencies.length > 0) return 1
  const items = recommendation.independentWorkItems
  const resources = proposal.mutableResources
  if (items.length < 2 || resources.length < 2 || items.length !== resources.length ||
      resources.some(resource => resource.shared || resource.identity === '.')) return 1
  const explicitlyBound = resources.every((resource, index) =>
    concrete(items[index]) && items[index].includes(resource.identity))
  return explicitlyBound ? Math.min(3, resources.length) : 1
}

function createExactPathDecision(input = {}) {
  const route = String(input.route || '').toUpperCase()
  if (!ROUTES.includes(route)) throw new TypeError('exact path route must be DIRECT, LIGHT, or ROADMAP')
  const preflight = evaluateExactPathPreflight({
    route, preflight: input.preflight, requestEnvelopeHash: input.requestEnvelopeHash,
    targetIdentity: input.targetIdentity,
    providerCapabilities: input.providerCapabilities,
    providerCapabilitiesHash: input.providerCapabilitiesHash,
    budget: input.budget,
    budgetSnapshotHash: input.budgetSnapshotHash,
  })
  if (!preflight.accepted) {
    const error = new Error(preflight.errors.join('; '))
    error.code = preflight.status
    error.details = preflight
    throw error
  }
  const facts = preflight.routeFacts
  const targetIdentity = input.targetIdentity || 'workspace'
  const request = typeof input.requestedResult === 'string' && input.requestedResult.trim()
    ? input.requestedResult.trim()
    : 'Complete the exact user request within the selected path.'
  const pathSelection = {
    mode: 'exact',
    requestedRoute: route,
    automaticSelectionBypassed: true,
    silentRouteChangesAllowed: false,
    conflictPolicy: 'fail-closed',
  }
  const rejectedRouteReasons = Object.fromEntries(ROUTES.filter(otherRoute => otherRoute !== route).map(otherRoute => [
    otherRoute,
    `The user selected exact path ${route}; ${otherRoute} cannot be substituted silently.`,
  ]))
  const recommendationHash = crypto.createHash('sha256').update(JSON.stringify(pathSelection)).digest('hex')
  return createRouteDecision({
    route,
    pathSelection,
    routeFacts: facts,
    mutableResourceOwnership: facts.mutableResources.map(resource => ({
      kind: resource.kind, identity: resource.identity, owner: 'worker-1', ownershipMode: resource.ownershipMode,
    })),
    requestedResult: request,
    successChecklist: ['The exact user request is completed within the selected path and no unrequested scope is added.'],
    checks: ['Independently verify the frozen result against the exact request and focused behavior evidence.'],
    likelyAreas: facts.mutableResources.length ? facts.mutableResources.map(resource => resource.identity) : [targetIdentity],
    risks: router.triggeredObligations(facts).length
      ? router.triggeredObligations(facts)
      : ['Hard safety, capability, ownership, and budget gates remain mandatory.'],
    workers: {
      count: 1,
      nonOverlapReason: 'One worker owns the selected path implementation boundary.',
    },
    chosenRouteReason: `The user explicitly selected exact path ${route}; automatic route analysis and selection were bypassed.`,
    rejectedRouteReasons,
    routeChangeTrigger: {
      event: 'EXACT_PATH_CONFLICT',
      factRequired: 'A hard safety, provider capability, ownership, or budget check proves the selected path unsatisfiable.',
    },
    gateSelection: exactPathGateSelection(facts),
    requestEnvelopeHash: input.requestEnvelopeHash,
    recommendationHash,
    nowMs: input.nowMs,
  })
}

function remainingL0DecisionBudgetMs(input = {}) {
  const started = Number(input.started_at_ms ?? input.startedAtMs)
  const now = Number(input.now_ms ?? input.nowMs)
  if (![started, now].every(Number.isFinite) || started < 0 || now < started) {
    const error = new RangeError('L0 decision budget requires a non-decreasing monotonic clock')
    error.code = 'ROUTE_DECISION_CLOCK_INVALID'
    throw error
  }
  // Four minutes remains the economic target reported by evaluateL0Decision.
  // The owned process gets one universal finite transport watchdog so a slow
  // required decision is not cancelled merely because the caller did not
  // provide a separate timeout override.
  return Math.max(0, L0_DECISION_CONVERGENCE_WATCHDOG_MS - Math.floor(now - started))
}

function protectedRequestLiterals(requestText) {
  const source = String(requestText || '')
  const literals = new Set()
  for (const match of source.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\[[^\]\r\n]+\])+/gu)) {
    literals.add(match[0])
  }
  for (const match of source.matchAll(/(?:^|\s)(--?[A-Za-z][A-Za-z0-9-]*)(?=\s|$)/gu)) {
    literals.add(match[1])
  }
  return [...literals].sort()
}

function validateRequestLiteralPreservation(requestText, decision) {
  const required = protectedRequestLiterals(requestText)
  if (required.length === 0) return { valid: true, required, missing: [] }
  const projected = [
    decision && decision.requestedResult,
    ...(Array.isArray(decision && decision.successChecklist) ? decision.successChecklist : []),
    ...(Array.isArray(decision && decision.plannedChecks) ? decision.plannedChecks : []),
    ...(Array.isArray(decision && decision.workerResponsibilities) ? decision.workerResponsibilities : []),
  ].filter(value => typeof value === 'string').join('\n')
  const missing = required.filter(literal => !projected.includes(literal))
  return { valid: missing.length === 0, required, missing }
}

function evaluateL0Decision(input = {}) {
  const started = Number(input.started_at_ms ?? input.startedAtMs)
  const now = Number(input.now_ms ?? input.nowMs ?? Date.now())
  const submittedRaw = input.submitted_at_ms ?? input.submittedAtMs
  const submitted = submittedRaw == null ? now : Number(submittedRaw)
  if (![started, now, submitted].every(Number.isFinite) || started < 0 || now < started || submitted < started) {
    return {
      status: 'ROUTE_DECISION_INVALID',
      start_workers: false,
      correction_allowed: false,
      errors: ['valid monotonic started_at_ms, submitted_at_ms, and now_ms are required'],
    }
  }
  const validation = validateRouteDecision(input.decision)
  const exactRequest = input.requestText ?? input.request_text
  const literalValidation = validateRequestLiteralPreservation(
    exactRequest,
    input.decision,
  )
  if (!literalValidation.valid) {
    validation.valid = false
    validation.errors.push(...literalValidation.missing.map(
      literal => `route decision omitted or changed protected request literal: ${literal}`,
    ))
  }
  const submittedElapsed = submitted - started
  const elapsed = now - started
  const maximumDurationMs = l0DecisionMaxDurationMs()
  const remainingMs = Math.max(0, maximumDurationMs - Math.floor(elapsed))
  if (validation.valid) {
    const waiting = input.decision.status === 'WAITING_USER'
    const late = submittedElapsed > maximumDurationMs
    return {
      status: waiting ? 'WAITING_USER' : 'ROUTE_DECIDED',
      route: input.decision.route,
      start_workers: !waiting,
      elapsed_ms: submittedElapsed,
      budget_remaining_ms: remainingMs,
      decision: input.decision,
      convergence: late ? {
        required: true,
        action: 'USE_AVAILABLE_VALID_DECISION',
        ceiling_ms: maximumDurationMs,
        elapsed_ms: submittedElapsed,
      } : { required: false },
    }
  }
  if (submittedElapsed > maximumDurationMs || elapsed >= maximumDurationMs) {
    return {
      status: 'ROUTE_DECISION_TIMEOUT',
      route: null,
      start_workers: false,
      resumable: true,
      elapsed_ms: elapsed,
      budget_remaining_ms: 0,
      unresolved_facts: validation.errors,
    }
  }
  const attempts = input.correction_attempts ?? input.correctionAttempts ?? 0
  return {
    status: 'ROUTE_DECISION_INVALID',
    route: null,
    start_workers: false,
    correction_allowed: attempts === 0,
    correction_attempts_remaining: attempts === 0 ? 1 : 0,
    elapsed_ms: elapsed,
    budget_remaining_ms: remainingMs,
    errors: validation.errors,
  }
}

function validateNewFact(newFact) {
  const errors = []
  if (!isObject(newFact)) return { valid: false, errors: ['new_fact must be a recorded object'] }
  for (const field of ['id', 'description', 'evidence_ref']) {
    if (!concrete(newFact[field])) errors.push(`new_fact.${field} must be concrete`)
  }
  return { valid: errors.length === 0, errors }
}

function noProgressFingerprint(input) {
  const candidate = input.candidate_fingerprint ?? input.candidateFingerprint
  const evidence = input.evidence_fingerprint ?? input.evidenceFingerprint
  const failure = input.failure_fingerprint ?? input.failureFingerprint
  if (![candidate, evidence, failure].every(sha256)) return null
  return `${candidate}:${evidence}:${failure}`
}

function evaluateNoProgress(input = {}) {
  const current = noProgressFingerprint(input)
  if (!current) {
    return { status: 'NO_PROGRESS_INVALID', same_executor: false, errors: ['version, evidence, and failure fingerprints must be SHA-256'] }
  }
  const history = Array.isArray(input.history) ? input.history : []
  const priorMatches = history.filter(item => noProgressFingerprint(item) === current).length
  const reassessments = input.strategy_reassessment_count ?? input.strategyReassessmentCount ?? 0
  if (!Number.isSafeInteger(reassessments) || reassessments < 0 || reassessments > 1) {
    return { status: 'NO_PROGRESS_INVALID', same_executor: false, errors: ['strategy reassessment count must be zero or one'] }
  }
  if (priorMatches === 0) {
    return {
      status: 'REPAIR_LOOP_REQUIRED',
      same_executor: true,
      repair_owner: 'SAME_EXECUTOR',
      no_progress_fingerprint: current,
      next_identical_attempt_allowed: false,
    }
  }
  if (reassessments === 0) {
    return {
      status: 'STRATEGY_REASSESSMENT_REQUIRED',
      same_executor: false,
      no_progress_fingerprint: current,
      strategy_reassessment_count: 1,
      next_identical_attempt_allowed: false,
    }
  }
  const boundary = input.boundary_event ?? input.boundaryEvent
  if (boundary && own(NO_PROGRESS_BOUNDARIES, boundary)) {
    return {
      status: NO_PROGRESS_BOUNDARIES[boundary],
      terminal_boundary: boundary,
      same_executor: false,
      no_progress_fingerprint: current,
      next_identical_attempt_allowed: false,
    }
  }
  return {
    status: 'DIFFERENT_STRATEGY_REQUIRED',
    same_executor: false,
    no_progress_fingerprint: current,
    strategy_reassessment_count: 1,
    next_identical_attempt_allowed: false,
    allowed_terminal_boundaries: Object.keys(NO_PROGRESS_BOUNDARIES),
  }
}

function validateEscalationEvidence(event, evidence) {
  const required = router.ROUTE_CONTRACT.escalationEvents[event].requiredEvidence
  const errors = []
  if (!Array.isArray(evidence) || evidence.length < required.length) {
    errors.push(`${event} requires evidence for: ${required.join('; ')}`)
  } else {
    evidence.forEach((item, index) => {
      if (!isObject(item) || !concrete(item.kind) || !concrete(item.value) || !concrete(item.evidence_ref)) {
        errors.push(`evidence[${index}] must contain kind, value, and evidence_ref`)
      }
    })
  }
  return { valid: errors.length === 0, errors }
}

function evaluateRouteEvent(input = {}) {
  const event = input.event
  if (event === 'NO_PROGRESS') return { event, ...evaluateNoProgress(input) }
  const routeChangeEvents = Object.values(router.ROUTE_CONTRACT.routeChangeEvents).flat()
  if (!ESCALATION_EVENTS.includes(event) && !routeChangeEvents.includes(event)) {
    return { event, status: 'ROUTE_EVENT_INVALID', errors: ['event is not canonical'] }
  }
  if (routeChangeEvents.includes(event) && input.proposed_route != null) {
    return { event, ...evaluateRouteChange({ ...input, matching_rule: event }) }
  }
  if (routeChangeEvents.includes(event) && !ESCALATION_EVENTS.includes(event)) {
    return { event, status: 'ROUTE_EVENT_INVALID', errors: ['route-change event requires proposed_route'] }
  }
  const validation = validateEscalationEvidence(event, input.evidence)
  if (!validation.valid) return { event, status: 'ROUTE_EVENT_INVALID', errors: validation.errors }
  const retained = [...new Set(input.triggered_safety_obligations ?? input.triggeredSafetyObligations ?? [])]
  if (event === 'CAPABILITY_LOST') {
    const degraded = input.degraded_transport ?? input.degradedTransport
    const currentRoute = input.current_route ?? input.currentRoute ?? null
    const evaluator = input.safe_degradation_evaluator ?? input.safeDegradationEvaluator ?? evaluateSafeTransportDegradation
    if (typeof evaluator !== 'function') {
      return { event, status: 'PROVIDER_UNSUPPORTED', errors: ['safe degradation evaluator is unavailable'], triggered_safety_obligations: retained }
    }
    const degradationEvaluation = evaluator(clone(degraded))
    const safeSequential = isObject(degradationEvaluation) && degradationEvaluation.accepted === true &&
      nonEmpty(degradationEvaluation.evaluator) && sha256(degradationEvaluation.evaluationHash)
    if (safeSequential && (currentRoute === null || currentRoute === 'LIGHT')) {
      return {
        event, status: 'CONTINUE_WITH_SAFE_DEGRADATION',
        route: 'LIGHT', route_reclassified: currentRoute === null,
        transport: clone(degraded), degradation_evaluation: clone(degradationEvaluation),
        triggered_safety_obligations: retained,
      }
    }
    if (safeSequential && ROUTES.includes(currentRoute)) {
      return {
        event, status: 'RECLASSIFY_TO_LIGHT_REQUIRED', current_route: currentRoute, route: 'LIGHT',
        transport: clone(degraded), degradation_evaluation: clone(degradationEvaluation),
        triggered_safety_obligations: retained,
      }
    }
    return {
      event, status: 'PROVIDER_UNSUPPORTED',
      degradation_evaluation: isObject(degradationEvaluation) ? clone(degradationEvaluation) : null,
      triggered_safety_obligations: retained,
    }
  }
  if (event === 'ORACLE_FAILURE') {
    return {
      event, status: 'CHECK_INCONCLUSIVE', next_action: 'CHECK_RESOLUTION_REQUIRED',
      triggered_safety_obligations: retained,
    }
  }
  const newFacts = input.new_route_facts ?? input.newRouteFacts
  const classification = newFacts ? router.classifyRoute(newFacts, { probeEvidence: input.probe_evidence }) : null
  return {
    event,
    status: 'STRATEGY_REASSESSMENT_REQUIRED',
    route_reclassification: classification,
    triggered_safety_obligations: classification
      ? [...new Set([...retained, ...classification.triggered_safety_obligations])]
      : retained,
    route_changes_only_if_precedence_changes: true,
  }
}

function evaluateRouteChange(input = {}) {
  const currentRoute = input.current_route ?? input.currentRoute
  const proposedRoute = input.proposed_route ?? input.proposedRoute
  const ruleName = input.matching_rule ?? input.matchingRule
  if (!ROUTES.includes(currentRoute) || !ROUTES.includes(proposedRoute)) {
    return { allowed: false, status: 'ROUTE_CHANGE_INVALID', errors: ['current_route and proposed_route must be routes'] }
  }
  const lockedPath = exactPathSelection(input.pathSelection ?? input.path_selection, currentRoute)
  if (lockedPath && currentRoute !== proposedRoute) {
    return {
      allowed: false,
      status: 'EXACT_PATH_CONFLICT',
      route: currentRoute,
      exactPath: currentRoute,
      errors: ['the user-selected exact path forbids silent route upgrades or downgrades'],
    }
  }
  if (currentRoute === proposedRoute) {
    return { allowed: false, status: 'ROUTE_UNCHANGED', route: currentRoute, errors: [] }
  }
  if (NON_ROUTING_FAILURES.has(ruleName)) {
    return {
      allowed: false,
      status: 'REPAIR_LOOP_REQUIRED',
      route: currentRoute,
      repair_owner: 'SAME_EXECUTOR',
      repeat_scope: 'AFFECTED_CHECKS_ONLY',
      errors: [`${ruleName} is not a route-change fact`],
    }
  }
  const rule = ROUTE_CHANGE_RULES[ruleName]
  const direction = `${currentRoute}>${proposedRoute}`
  const factValidation = validateNewFact(input.new_fact ?? input.newFact)
  const errors = factValidation.errors.slice()
  if (!rule) errors.push('matching_rule is not a recognized route-change rule')
  else if (!rule.directions.includes(direction)) errors.push(`${ruleName} does not allow ${direction}`)
  const deEscalating = ROUTES.indexOf(proposedRoute) < ROUTES.indexOf(currentRoute)
  if (deEscalating && (input.production_mutation_started ?? input.productionMutationStarted) === true) {
    errors.push('de-escalation is allowed only before production mutation')
  }
  const retained = [...new Set(input.triggered_safety_obligations ?? input.triggeredSafetyObligations ?? [])]
  const dropped = input.dropped_safety_obligations ?? input.droppedSafetyObligations ?? []
  if (Array.isArray(dropped) && dropped.length > 0) errors.push('route change cannot drop triggered safety obligations')
  if (errors.length > 0) {
    return { allowed: false, status: 'ROUTE_CHANGE_REJECTED', route: currentRoute, errors }
  }
  return {
    allowed: true,
    status: 'ROUTE_CHANGED',
    from_route: currentRoute,
    to_route: proposedRoute,
    matching_rule: ruleName,
    new_fact: clone(input.new_fact ?? input.newFact),
    rule_description: rule.description,
    retain_triggered_safety_obligations: true,
    triggered_safety_obligations: retained,
  }
}

module.exports = {
  DECISION_ARRAY_FIELDS,
  DETERMINISTIC_ROADMAP_EXECUTION_MODE,
  ESCALATION_EVENTS,
  L0_DECISION_MAX_DURATION_MS,
  L0_DECISION_CONVERGENCE_WATCHDOG_MS,
  LIGHT_PLAN_MAX_DURATION_MS,
  MAX_LIGHT_PLAN_BULLETS,
  NON_ROUTING_FAILURES,
  NO_PROGRESS_BOUNDARIES,
  RECOMMENDATION_ARRAY_FIELDS,
  ROUTE_ANALYST_ADMISSION,
  ROUTE_ANALYST_ADMISSION_SCHEMA_ID,
  ROUTE_ANALYST_MAX_DURATION_MS,
  ROUTE_CHANGE_RULES,
  ROUTE_DECISION_SCHEMA,
  ROUTE_DECISION_SCHEMA_ID,
  ROUTE_DECISION_SCHEMA_VERSION,
  ROUTE_RECOMMENDATION_SCHEMA_VERSION,
  ROUTE_RECOMMENDATION_SCHEMA,
  CODEX_ROUTE_RECOMMENDATION_SCHEMA,
  ROUTE_RECOMMENDATION_SCHEMA_ID,
  ROUTE_SCHEMA_DIGEST,
  buildRouteTopology,
  canonicalVerificationObligations,
  canonicalizeProviderRecommendation,
  compileAutomaticRouteDecision,
  completionLaunchRequirement,
  compileConservativeCompletionDecision,
  createFindingDispositionDecision,
  createFrameworkMissCacheIdentity,
  createRoadmapTopology,
  createRouteAnalystAdmission,
  createRouteAnalystFallbackState,
  createRouteDecision,
  createExactPathDecision,
  evaluateExactPathPreflight,
  createRouteRecommendation,
  createWaitingUserDecision,
  evaluateCapturedDomainOutcomes: capturedDomain.evaluateOutcomes,
  evaluateL0Decision,
  remainingL0DecisionBudgetMs,
  evaluateNoProgress,
  evaluateRouteAnalystResult,
  evaluateRouteChange,
  evaluateRouteEvent,
  evaluateSafeTransportDegradation,
  noProgressFingerprint,
  roadmapCompletionLaunchRequirement,
  selectIndependentChecking,
  validateRecommendation,
  validateRouteRecommendation: validateRecommendation,
  validateRoadmapTopology,
  validateRouteAnalystAdmission,
  validateRouteAnalystFallbackState,
  validateRequestLiteralPreservation,
  validateAnalystAdmission: validateRouteAnalystAdmission,
  validateGateSelection,
  validateRouteDecision,
  validateDecision: validateRouteDecision,
  validateCapturedDomainContracts: capturedDomain.validateContracts,
}
