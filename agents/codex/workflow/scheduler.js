#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { validateProviderCapabilities } = require('./context-envelope.js')

const BENCHMARK_NO_TOKEN_LIMIT = process.env.AUTOPROMPT_BENCHMARK_NO_TOKEN_LIMIT === '1'
const BENCHMARK_NO_TIMEOUT_LIMIT = process.env.AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT === '1'
const benchmarkTokenCeilings = defaults => BENCHMARK_NO_TOKEN_LIMIT
  ? { noncachedInput: Number.MAX_SAFE_INTEGER, cachedInput: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER }
  : defaults
const benchmarkTimeCeiling = defaultMs => BENCHMARK_NO_TIMEOUT_LIMIT
  ? Number.MAX_SAFE_INTEGER
  : defaultMs

// C0's scheduling policy is deliberately kept in a require()-able module.  A
// provider adapter may implement the actual child launch, but it must obtain a
// lease here first.  Consequently a nested worker cannot turn a provider's
// thread setting into an accidental second scheduler.

const ROUTE_BUDGETS = deepFreeze({
  DIRECT: {
    maxChildLaunches: 6,
    normalChildLaunchRange: [3, 5],
    maxLiveIncludingRoot: 4,
    maxDepth: 2,
    noProgressMs: 8 * 60 * 1000,
    admissionHardMs: benchmarkTimeCeiling(7 * 60 * 1000),
    admissionP95Ms: 5 * 60 * 1000,
    tokens: benchmarkTokenCeilings({ noncachedInput: 220000, cachedInput: 900000, output: 40000 }),
  },
  LIGHT: {
    maxChildLaunches: 8,
    maxLiveIncludingRoot: 4,
    maxDepth: 3,
    noProgressMs: 20 * 60 * 1000,
    admissionHardMs: benchmarkTimeCeiling(12 * 60 * 1000),
    admissionP95Ms: 10 * 60 * 1000,
    tokens: benchmarkTokenCeilings({ noncachedInput: 500000, cachedInput: 2200000, output: 70000 }),
  },
  ROADMAP: {
    maxChildLaunches: 18,
    maxLiveIncludingRoot: 6,
    absoluteUserLiveCeiling: 10,
    maxDepth: 4,
    noProgressMs: 45 * 60 * 1000,
    admissionHardMs: benchmarkTimeCeiling(22 * 60 * 1000),
    admissionP95Ms: 18 * 60 * 1000,
    tokens: benchmarkTokenCeilings({ noncachedInput: 1200000, cachedInput: 5000000, output: 160000 }),
  },
})
const PENDING_ROUTE = 'PENDING'
const ROUTE_SOURCES = Object.freeze(['automatic', 'explicit_control'])
const PENDING_ROUTE_SETTINGS = deepFreeze({
  schemaVersion: 1,
  route: PENDING_ROUTE,
  policyClass: 'route-economic-policy',
  economicPolicySource: 'route',
  concurrencyPreset: null,
  budget: {
    maxChildLaunches: 1,
    maxLiveIncludingRoot: 2,
    maxDepth: 1,
    noProgressMs: 2 * 60 * 1000,
    admissionHardMs: ROUTE_BUDGETS.DIRECT.admissionHardMs,
    admissionP95Ms: ROUTE_BUDGETS.DIRECT.admissionP95Ms,
    tokens: { ...ROUTE_BUDGETS.DIRECT.tokens },
    verificationReserve: 0.25,
    recoveryReserve: 0.10,
  },
  lanes: {
    routeAnalyst: {
      maxLaunches: 1,
      maxLive: 1,
      tokens: { ...ROUTE_BUDGETS.DIRECT.tokens },
    },
  },
})

const TOKEN_DIMENSIONS = ['noncachedInput', 'cachedInput', 'output']
const ACCOUNTING_DIMENSIONS = [
  ...TOKEN_DIMENSIONS, 'reasoning', 'weightedCost', 'latencyMs', 'workMs',
]
const MODEL_USAGE_FIELDS = Object.freeze(['noncachedInput', 'cachedInput', 'output', 'reasoning'])
const VERIFICATION_RESERVE = 0.25
const RECOVERY_RESERVE = 0.10
const OPTIONAL_STOP_FRACTION = 0.80
const RETRY_POLICY = deepFreeze({
  kind: 'progress-aware-hard-budget',
  identicalFingerprintAction: 'reassessment-required',
  changedFingerprintBoundary: 'route-and-lane-launch-token-time-budgets',
  fixedAttemptStop: false,
})
const PHASE_BUDGET_CONTRACT = deepFreeze({
  schemaVersion: 1,
  rule: 'soft/grace boundaries may warn or escalate only; reset/kill is forbidden before hard unless a typed NO_PROGRESS_INVARIANT is present',
  noProgressCode: 'NO_PROGRESS_INVARIANT',
})
const ADMISSION_COMPONENT_CEILINGS_MS = deepFreeze({
  bootstrap: benchmarkTimeCeiling(60 * 1000),
  routeAnalyst: benchmarkTimeCeiling(2 * 60 * 1000),
  routeDecision: benchmarkTimeCeiling(4 * 60 * 1000),
  lightPlanning: benchmarkTimeCeiling(5 * 60 * 1000),
  roadmapPlanning: benchmarkTimeCeiling(15 * 60 * 1000),
})

class SchedulerAdmissionError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SchedulerAdmissionError'
    this.code = code
    this.details = details
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function normalizeRoute(route, options = {}) {
  const normalized = String(route || '').toUpperCase()
  if (options.allowPending && normalized === PENDING_ROUTE) return normalized
  if (!Object.hasOwn(ROUTE_BUDGETS, normalized)) {
    throw new SchedulerAdmissionError('INVALID_ROUTE', `unknown route: ${route || '<empty>'}`)
  }
  return normalized
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) output[key] = sortJson(value[key])
  return output
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function bindRoadmapExpansionAdmission(input = {}) {
  const body = {
    schemaVersion: 1,
    authority: 'supervisor-roadmap-expansion-authority',
    authorityId: nonEmpty(input.authorityId) ? input.authorityId.trim() : null,
    authorityReceiptHash: input.authorityReceiptHash,
    accepted: input.accepted === true,
    admittedAskCount: Number(input.admittedAskCount),
    missionScopeHash: input.missionScopeHash,
    planSha256: input.planSha256,
    necessityEvidenceHash: input.necessityEvidenceHash,
    marginalValueEvidenceHash: input.marginalValueEvidenceHash,
  }
  if (!body.authorityId || body.accepted !== true ||
      !Number.isSafeInteger(body.admittedAskCount) || body.admittedAskCount < 1 ||
      [body.authorityReceiptHash, body.missionScopeHash, body.planSha256,
        body.necessityEvidenceHash, body.marginalValueEvidenceHash]
        .some(value => !/^[a-f0-9]{64}$/.test(value || '')) ||
      body.necessityEvidenceHash === body.marginalValueEvidenceHash) {
    throw new SchedulerAdmissionError(
      'ROADMAP_EXPANSION_NOT_ADMITTED',
      'roadmap expansion authority must bind distinct necessity and marginal-value evidence to the immutable request and frozen plan',
    )
  }
  return Object.freeze({
    ...body,
    admissionHash: sha256(Buffer.from(stableStringify(body), 'utf8')),
  })
}

function validRoadmapExpansionAdmission(admission, expected = {}) {
  if (!admission || typeof admission !== 'object') return false
  let rebound
  try { rebound = bindRoadmapExpansionAdmission(admission) } catch { return false }
  return admission.admissionHash === rebound.admissionHash &&
    admission.admittedAskCount === expected.admittedAskCount &&
    admission.missionScopeHash === expected.missionScopeHash &&
    admission.planSha256 === expected.planSha256
}

function requireDigest(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new SchedulerAdmissionError('INVALID_CACHE_ATTESTATION', `${field} must be a lowercase sha256 digest`)
  }
  return value
}

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

function resolveRouteBudget(route, options = {}) {
  const normalized = normalizeRoute(route)
  const base = ROUTE_BUDGETS[normalized]
  const budget = {
    ...base,
    tokens: { ...base.tokens },
    verificationReserve: VERIFICATION_RESERVE,
    recoveryReserve: RECOVERY_RESERVE,
  }

  // A resolved live setting is enforced for every route. DIRECT/LIGHT may only
  // tighten their map ceiling; ROADMAP may expand only through the explicit
  // user ceiling and never beyond ten.
  const liveSetting = options.liveCeiling ?? options.maxLiveIncludingRoot ?? options.userLiveCeiling
  if (liveSetting !== undefined) {
    const requested = positiveInteger(liveSetting, base.maxLiveIncludingRoot)
    const maximum = normalized === 'ROADMAP' && options.userLiveCeiling !== undefined
      ? base.absoluteUserLiveCeiling
      : base.maxLiveIncludingRoot
    budget.maxLiveIncludingRoot = Math.min(requested, maximum)
  }

  // 5 + 3/work-group is itself a ceiling, capped by the activation-wide 18.
  // It never creates a minimum or a spawn quota.
  if (normalized === 'ROADMAP' && options.workGroups !== undefined) {
    const groups = positiveInteger(options.workGroups, 1)
    budget.maxChildLaunches = Math.min(base.maxChildLaunches, 5 + (3 * groups))
  }

  if (options.maxChildLaunches !== undefined) {
    budget.maxChildLaunches = Math.min(
      budget.maxChildLaunches,
      positiveInteger(options.maxChildLaunches, budget.maxChildLaunches),
    )
  }
  return deepFreeze(budget)
}

function resolveSchedulerSettings(options = {}) {
  const route = normalizeRoute(options.route)
  let budget = resolveRouteBudget(route, options)
  const fields = normalizedRequestFields(options)
  const concurrency = firstNormalizedField(fields, ['concurrencyMode', 'friendlyMode', 'widthPreset']) ||
    (options.concurrency && (options.concurrency.friendlyMode || options.concurrency.mode)) || null
  const concurrencyPreset = concurrency == null ? null : String(concurrency).toLowerCase()
  if (concurrencyPreset === 'tokensaver') {
    budget = deepFreeze({ ...budget, maxLiveIncludingRoot: Math.min(budget.maxLiveIncludingRoot, 7), tokens: { ...budget.tokens } })
  }
  const rawLanes = options.lanes || options.laneLimits || { main: {} }
  if (!rawLanes || typeof rawLanes !== 'object' || Array.isArray(rawLanes) || Object.keys(rawLanes).length === 0) {
    throw new SchedulerAdmissionError('INVALID_LANE_SETTINGS', 'at least one named lane is required')
  }
  const lanes = {}
  for (const name of Object.keys(rawLanes).sort()) {
    if (!nonEmpty(name)) throw new SchedulerAdmissionError('INVALID_LANE_SETTINGS', 'lane names must be non-empty')
    const lane = rawLanes[name] || {}
    lanes[name] = {
      maxLaunches: Math.min(budget.maxChildLaunches, positiveInteger(lane.maxLaunches, budget.maxChildLaunches)),
      maxLive: Math.min(
        budget.maxLiveIncludingRoot - 1,
        positiveInteger(lane.maxLive, budget.maxLiveIncludingRoot - 1),
      ),
      tokens: {
        noncachedInput: Math.min(budget.tokens.noncachedInput, positiveInteger(lane.tokens && lane.tokens.noncachedInput, budget.tokens.noncachedInput)),
        cachedInput: Math.min(budget.tokens.cachedInput, positiveInteger(lane.tokens && lane.tokens.cachedInput, budget.tokens.cachedInput)),
        output: Math.min(budget.tokens.output, positiveInteger(lane.tokens && lane.tokens.output, budget.tokens.output)),
      },
    }
  }
  return deepFreeze({
    schemaVersion: 1,
    route,
    policyClass: concurrencyPreset === 'tokensaver' ? 'concurrency-width-only' : 'route-economic-policy',
    economicPolicySource: 'route',
    concurrencyPreset,
    budget,
    lanes,
  })
}

function validateResolvedSchedulerSettings(settings) {
  if (!settings || settings.schemaVersion !== 1 || !settings.budget || !settings.lanes) {
    throw new SchedulerAdmissionError('INVALID_SCHEDULER_SETTINGS', 'settings must come from resolveSchedulerSettings()')
  }
  if (settings.economicPolicySource !== 'route' ||
      !['concurrency-width-only', 'route-economic-policy'].includes(settings.policyClass) ||
      (settings.concurrencyPreset === 'tokensaver' && settings.policyClass !== 'concurrency-width-only')) {
    throw new SchedulerAdmissionError('INVALID_SCHEDULER_SETTINGS', 'scheduler economics must come from route; tokensaver is concurrency-width-only')
  }
  const route = normalizeRoute(settings.route)
  const map = ROUTE_BUDGETS[route]
  const maximumLive = route === 'ROADMAP' ? map.absoluteUserLiveCeiling : map.maxLiveIncludingRoot
  const budget = settings.budget
  if (!(Number.isInteger(budget.maxChildLaunches) && budget.maxChildLaunches > 0 && budget.maxChildLaunches <= map.maxChildLaunches) ||
      !(Number.isInteger(budget.maxLiveIncludingRoot) && budget.maxLiveIncludingRoot > 0 && budget.maxLiveIncludingRoot <= maximumLive) ||
      !(Number.isInteger(budget.maxDepth) && budget.maxDepth > 0 && budget.maxDepth <= map.maxDepth)) {
    throw new SchedulerAdmissionError('INVALID_SCHEDULER_SETTINGS', 'route settings exceed the map ceiling')
  }
  for (const dimension of TOKEN_DIMENSIONS) {
    if (!(Number(budget.tokens && budget.tokens[dimension]) > 0) || budget.tokens[dimension] > map.tokens[dimension]) {
      throw new SchedulerAdmissionError('INVALID_SCHEDULER_SETTINGS', `invalid route token ceiling: ${dimension}`)
    }
  }
  const laneNames = Object.keys(settings.lanes)
  if (laneNames.length === 0) throw new SchedulerAdmissionError('INVALID_LANE_SETTINGS', 'at least one lane is required')
  for (const lane of laneNames) {
    const value = settings.lanes[lane]
    if (!nonEmpty(lane) || !value || !Number.isInteger(value.maxLaunches) || value.maxLaunches < 1 ||
        value.maxLaunches > budget.maxChildLaunches || !Number.isInteger(value.maxLive) || value.maxLive < 0 ||
        value.maxLive > budget.maxLiveIncludingRoot - 1) {
      throw new SchedulerAdmissionError('INVALID_LANE_SETTINGS', `invalid lane limits: ${lane}`)
    }
    for (const dimension of TOKEN_DIMENSIONS) {
      if (!(Number(value.tokens && value.tokens[dimension]) > 0) || value.tokens[dimension] > budget.tokens[dimension]) {
        throw new SchedulerAdmissionError('INVALID_LANE_SETTINGS', `invalid ${lane} token ceiling: ${dimension}`)
      }
    }
  }
  return deepFreeze(settings)
}

function phaseBudgetVerdict(state = {}) {
  if (Object.hasOwn(state, 'graceElapsed')) {
    throw new SchedulerAdmissionError('LEGACY_PHASE_GRACE_UNSUPPORTED', 'graceElapsed is retired; soft warnings never reset a phase')
  }
  const elapsedMs = finiteNonNegative(state.elapsedMs)
  const softMs = finiteNonNegative(state.softMs)
  const hardMs = finiteNonNegative(state.hardMs)
  if (!(hardMs > 0) || softMs > hardMs) {
    throw new SchedulerAdmissionError('INVALID_PHASE_BUDGET', 'phase budget requires 0 <= softMs <= hardMs')
  }
  const invariant = state.noProgressInvariant
  const typedNoProgress = Boolean(
    invariant && invariant.code === PHASE_BUDGET_CONTRACT.noProgressCode &&
    Number(invariant.observedMs) >= Number(invariant.limitMs) && Number(invariant.limitMs) > 0,
  )
  if (typedNoProgress) {
    return { action: 'escalate-no-progress', canReset: true, hardReached: elapsedMs >= hardMs, code: invariant.code }
  }
  if (elapsedMs >= hardMs) {
    return { action: 'hard-boundary', canReset: true, hardReached: true, code: 'PHASE_HARD_BOUNDARY' }
  }
  if (elapsedMs >= softMs || state.scopeRequest || state.recoveryRequest) {
    return { action: 'warn', canReset: false, hardReached: false, code: 'PHASE_SOFT_WARNING' }
  }
  return { action: 'continue', canReset: false, hardReached: false, code: 'PHASE_WITHIN_BUDGET' }
}

function evaluateMarginalValue(valueCase, options = {}) {
  const item = valueCase || {}
  const missing = []
  if (!nonEmpty(item.failureMode)) missing.push('failureMode')
  if (!nonEmpty(item.disjointBoundary || item.boundary)) missing.push('disjointBoundary')
  if (!(Number(item.estimatedTokens) > 0)) missing.push('estimatedTokens')
  if (!(Number(item.estimatedMs) > 0)) missing.push('estimatedMs')
  const probability = Number(item.defectProbability)
  if (!(probability > 0 && probability <= 1)) missing.push('defectProbability')
  if (!(Number(item.severityWeight) > 0)) missing.push('severityWeight')
  if (!(Number(item.avoidedRework) > 0)) missing.push('avoidedRework')

  if (missing.length > 0) {
    return {
      admitted: false,
      code: 'MARGINAL_VALUE_REQUIRED',
      missing,
      estimatedCost: null,
      expectedBenefit: null,
      margin: null,
    }
  }

  const timeCostPerSecond = finiteNonNegative(options.timeCostPerSecond, 1)
  const estimatedCost = Number(item.estimatedTokens) +
    ((Number(item.estimatedMs) / 1000) * timeCostPerSecond)
  const expectedBenefit = probability * Number(item.severityWeight) * Number(item.avoidedRework)
  const margin = expectedBenefit - estimatedCost
  return {
    admitted: margin > 0,
    code: margin > 0 ? 'MARGINAL_VALUE_ADMITTED' : 'OPTIONAL_VALUE_TOO_LOW',
    missing: [],
    estimatedCost,
    expectedBenefit,
    margin,
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizedFieldName(value) {
  return String(value).normalize('NFKC').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

function normalizedRequestFields(request = {}) {
  const fields = new Map()
  for (const [key, value] of Object.entries(request)) fields.set(normalizedFieldName(key), value)
  return fields
}

function firstNormalizedField(fields, names) {
  for (const name of names) {
    const key = normalizedFieldName(name)
    if (fields.has(key)) return fields.get(key)
  }
  return undefined
}

function normalizeEstimate(estimate, valueCase) {
  const source = estimate || {}
  const out = {}
  for (const dimension of TOKEN_DIMENSIONS) {
    out[dimension] = finiteNonNegative(source[dimension], 0)
  }
  if (out.noncachedInput === 0 && valueCase && Number(valueCase.estimatedTokens) > 0) {
    out.noncachedInput = Number(valueCase.estimatedTokens)
  }
  out.workMs = finiteNonNegative(source.workMs ?? source.durationMs, 0)
  if (out.workMs === 0 && valueCase && Number(valueCase.estimatedMs) > 0) {
    out.workMs = Number(valueCase.estimatedMs)
  }
  out.reasoning = finiteNonNegative(source.reasoning ?? source.reasoningTokens, 0)
  out.weightedCost = finiteNonNegative(source.weightedCost, 0)
  out.latencyMs = finiteNonNegative(source.latencyMs, 0)
  return out
}

function normalizeUsageDelta(delta, options = {}) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
    throw new SchedulerAdmissionError('INVALID_USAGE_REPORT', 'usage delta must be an object')
  }
  const aliases = { reasoningTokens: 'reasoning', durationMs: 'workMs' }
  const allowed = new Set([...ACCOUNTING_DIMENSIONS, ...Object.keys(aliases)])
  for (const [key, value] of Object.entries(delta)) {
    if (!allowed.has(key) || !Number.isFinite(Number(value)) || Number(value) < 0) {
      throw new SchedulerAdmissionError('INVALID_USAGE_REPORT', `invalid usage field: ${key}`)
    }
  }
  if (options.requireModelFields === true) {
    const fields = reportedFields(delta)
    const missing = MODEL_USAGE_FIELDS.filter((field) => !fields.has(field))
    if (missing.length > 0) {
      throw new SchedulerAdmissionError('INCOMPLETE_USAGE_REPORT', 'usage report must explicitly include every model token category', { missing })
    }
  }
  const out = emptyUsage()
  for (const dimension of ACCOUNTING_DIMENSIONS) {
    const source = dimension === 'reasoning'
      ? (delta.reasoning ?? delta.reasoningTokens)
      : dimension === 'workMs' ? (delta.workMs ?? delta.durationMs) : delta[dimension]
    out[dimension] = source === undefined ? 0 : Number(source)
  }
  return out
}

function accountingTotal(usage) {
  return ACCOUNTING_DIMENSIONS.reduce((sum, key) => sum + finiteNonNegative(usage[key]), 0)
}

function reportedFields(value) {
  const fields = new Set()
  if (!value || typeof value !== 'object') return fields
  for (const dimension of ACCOUNTING_DIMENSIONS) {
    if (Object.hasOwn(value, dimension) ||
        (dimension === 'reasoning' && Object.hasOwn(value, 'reasoningTokens')) ||
        (dimension === 'workMs' && Object.hasOwn(value, 'durationMs'))) fields.add(dimension)
  }
  return fields
}

function normalizeResources(resources) {
  if (resources === undefined || resources === null) return []
  if (!Array.isArray(resources)) {
    throw new SchedulerAdmissionError('INVALID_RESOURCE_MANIFEST', 'resources must be an array')
  }
  const normalized = resources.map((resource) => {
    const item = typeof resource === 'string' ? { id: resource, mode: 'exclusive' } : resource
    if (!item || !nonEmpty(item.id)) {
      throw new SchedulerAdmissionError('INVALID_RESOURCE_MANIFEST', 'every resource requires a non-empty id')
    }
    const mode = item.mode === 'read' ? 'read' : 'exclusive'
    const isolation = nonEmpty(item.isolationId) ? item.isolationId.trim() : ''
    let id = item.id.trim()
    let kind = nonEmpty(item.kind) ? item.kind.trim().toLowerCase() : 'generic'
    const encoded = /^(workspace|cache|generated|temporary|database|service|port):(.*)$/i.exec(id)
    if (kind === 'generic' && encoded && nonEmpty(encoded[2])) {
      kind = encoded[1].toLowerCase()
      id = encoded[2]
    }
    const pathKind = ['workspace', 'cache', 'generated', 'temporary'].includes(kind)
    let physicalId = id
    if (pathKind) {
      const resolved = path.resolve(id)
      try { physicalId = fs.realpathSync.native(resolved) } catch { physicalId = resolved }
      if (process.platform === 'win32') physicalId = physicalId.toLowerCase()
    } else if (kind === 'port') {
      const port = Number(id)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new SchedulerAdmissionError('INVALID_RESOURCE_MANIFEST', `invalid port resource: ${id}`)
      }
      physicalId = String(port)
    }
    const baseKey = kind === 'generic' ? physicalId : `${kind}:${physicalId}`
    return {
      id: baseKey,
      baseKey,
      key: isolation ? `${baseKey}\u0000${isolation}` : baseKey,
      kind,
      physicalId,
      pathKind,
      mode,
      isolationId: isolation || null,
    }
  })
  normalized.sort((a, b) => a.key.localeCompare(b.key) || a.mode.localeCompare(b.mode))
  return normalized
}

function physicalResourcesOverlap(left, right) {
  if (!left.pathKind || !right.pathKind) return false
  const relativeLeft = path.relative(left.physicalId, right.physicalId)
  const relativeRight = path.relative(right.physicalId, left.physicalId)
  const within = relative => relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  return within(relativeLeft) || within(relativeRight)
}

function schedulerResourcesConflict(left, right) {
  if (left.mode === 'read' && right.mode === 'read') return false
  // Isolation labels are bookkeeping, not proof of physical separation.  A
  // caller cannot make one path/database/service/port parallel-safe merely by
  // giving the two claims different namespace strings.  Materialized snapshots
  // must instead claim their distinct physical paths.
  if (left.baseKey === right.baseKey || physicalResourcesOverlap(left, right)) return true
  if (left.isolationId && right.isolationId && left.isolationId !== right.isolationId) return false
  return false
}

function budgetClass(request) {
  if (requiresMarginalValue(request)) return 'optional'
  const fields = normalizedRequestFields(request)
  const purpose = String(firstNormalizedField(fields, ['purpose', 'kind']) || 'work').toLowerCase()
  if (['verification', 'review', 'testing', 'checker', 'l4'].includes(purpose)) return 'verification'
  if (['recovery', 'finalization', 'finalizer'].includes(purpose)) return 'recovery'
  if (['planning', 'research', 'scouting'].includes(purpose)) return 'planning'
  return 'work'
}

function requiresMarginalValue(request = {}) {
  const fields = normalizedRequestFields(request)
  const optional = firstNormalizedField(fields, ['optional', 'optionalWork', 'isOptional'])
  const implied = firstNormalizedField(fields, ['impliedScope', 'isImplied', 'scopeImplied'])
  const essential = firstNormalizedField(fields, ['missionEssential', 'isMissionEssential'])
  const scope = String(firstNormalizedField(fields, ['scopeKind', 'scope', 'workScope']) || '')
    .toLowerCase().replace(/[_\s]+/g, '-')
  const roleIdentities = ['logicalRole', 'role', 'providerRole', 'legacyRole', 'roleAlias']
    .map(name => firstNormalizedField(fields, [name]))
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).normalize('NFKC').toLowerCase())
  const purpose = String(firstNormalizedField(fields, ['purpose', 'kind']) || '').toLowerCase()
  const optionalRoleIds = new Set([
    'ap-arbiter', 'ap-depth-prober', 'ap-manager', 'ap-re-anchor', 'ap-roadmap-scout',
    'ap-run-coordinator', 'ap-sweeper',
  ])
  const optionalRole = roleIdentities.some(role => optionalRoleIds.has(role) ||
    /(?:^|[-_.])(?:ap-)?(scout|sweeper|juror|researcher)(?:$|[-_.@])/.test(role)) ||
    ['scouting', 'sweep', 'optional-review', 'optional-research', 'extra-check'].includes(purpose)
  const explicitlyEssential = essential === true || firstNormalizedField(fields, ['requiredByMission', 'userRequested']) === true
  return !explicitlyEssential && (
    optional === true || implied === true || essential === false || optionalRole ||
    ['optional', 'implied', 'nonessential', 'non-essential'].includes(scope)
  )
}

function progressFingerprintFor(request = {}) {
  const fields = normalizedRequestFields(request)
  // Caller-authored labels are not progress. They let a poison retry change
  // one arbitrary string forever without changing candidate, evidence, or
  // strategy state.
  const candidate = firstNormalizedField(fields, ['candidateHash', 'candidateDigest'])
  const evidence = firstNormalizedField(fields, ['evidenceHashes', 'evidenceHash', 'evidenceDigest'])
  const strategy = firstNormalizedField(fields, ['strategyHash', 'strategyFingerprint', 'reassessmentHash'])
  const evidenceList = Array.isArray(evidence) ? evidence.map(String).sort() : evidence == null ? [] : [String(evidence)]
  if (!nonEmpty(String(candidate || '')) && evidenceList.length === 0 && !nonEmpty(String(strategy || ''))) return null
  return sha256(Buffer.from(stableStringify({ candidate: candidate || null, evidence: evidenceList, strategy: strategy || null }), 'utf8'))
}

function emptyUsage() {
  return {
    noncachedInput: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    weightedCost: 0,
    latencyMs: 0,
    workMs: 0,
  }
}

function addUsage(target, source, factor = 1) {
  for (const key of ACCOUNTING_DIMENSIONS) {
    target[key] += finiteNonNegative(source[key], 0) * factor
    // Avoid negative zero and floating point crumbs in persisted metrics.
    if (Math.abs(target[key]) < 1e-9) target[key] = 0
  }
}

function schedulerCrashStateHash(checkpoint) {
  const unsigned = { ...checkpoint }
  delete unsigned.stateHash
  return sha256(Buffer.from(stableStringify(unsigned), 'utf8'))
}

function normalizeCrashFrontier(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !nonEmpty(value.resumeState)) {
    throw new SchedulerAdmissionError('CRASH_BINDING_INVALID', 'live launch recovery requires a named resumeState')
  }
  const result = { resumeState: value.resumeState.trim() }
  for (const field of ['nextReadyWorkIds', 'openCheckIds', 'acceptedResultIds']) {
    const entries = value[field]
    if (!Array.isArray(entries) || new Set(entries).size !== entries.length ||
        entries.some((entry) => !nonEmpty(entry))) {
      throw new SchedulerAdmissionError('CRASH_BINDING_INVALID', `live launch recovery frontier ${field} is invalid`)
    }
    result[field] = entries.map((entry) => entry.trim())
  }
  return result
}

class SchedulerLease {
  constructor(scheduler, record) {
    this.id = record.id
    this.workItemId = record.workItemId
    this.depth = record.depth
    this.attempt = record.attempt
    this.lane = record.lane
    this.resources = record.resources.map(({ id, kind, mode, isolationId }) => ({ id, kind, mode, isolationId }))
    this._scheduler = scheduler
    this._released = false
  }

  progress(kind = 'work') {
    return this._scheduler.markMeaningfulProgress(kind, this.id)
  }

  acquireChild(authority, request = {}) {
    return this._scheduler.acquireChild(this, authority, request)
  }

  reportUsage(delta, options = {}) {
    return this._scheduler.reportUsage(this, delta, options)
  }

  authorizeUsage(delta) {
    return this._scheduler.authorizeUsage(this, delta)
  }

  complete(actualUsage = {}) {
    if (this._released) return false
    try {
      const released = this._scheduler._release(this.id, 'completed', actualUsage)
      if (released) this._released = true
      return released
    } catch (error) {
      if (error && ['BUDGET_EXHAUSTED', 'INCOMPLETE_USAGE_ACCOUNTING'].includes(error.code)) this._released = true
      throw error
    }
  }

  fail(error, actualUsage = {}) {
    if (this._released) return false
    try {
      const released = this._scheduler._release(this.id, 'failed', actualUsage, error)
      if (released) this._released = true
      return released
    } catch (releaseError) {
      if (releaseError && ['BUDGET_EXHAUSTED', 'INCOMPLETE_USAGE_ACCOUNTING'].includes(releaseError.code)) this._released = true
      throw releaseError
    }
  }

  release(actualUsage = {}) {
    return this.complete(actualUsage)
  }
}

class RootAccountingLease {
  constructor(scheduler, record) {
    this.id = record.id
    this.phase = record.phase
    this.sessionId = record.sessionId
    this._scheduler = scheduler
    this._released = false
  }

  authorizeUsage(delta) {
    return this._scheduler.authorizeRootUsage(this, delta)
  }

  reportUsage(delta, options = {}) {
    return this._scheduler.reportRootUsage(this, delta, options)
  }

  complete(actualUsage = {}) {
    if (this._released) return false
    try {
      const released = this._scheduler._releaseRootAccounting(this, 'completed', actualUsage)
      if (released) this._released = true
      return released
    } catch (error) {
      if (error && ['BUDGET_EXHAUSTED', 'INCOMPLETE_USAGE_ACCOUNTING'].includes(error.code)) this._released = true
      throw error
    }
  }

  fail(error, actualUsage = {}) {
    if (this._released) return false
    try {
      const released = this._scheduler._releaseRootAccounting(this, 'failed', actualUsage, error)
      if (released) this._released = true
      return released
    } catch (releaseError) {
      if (releaseError && ['BUDGET_EXHAUSTED', 'INCOMPLETE_USAGE_ACCOUNTING'].includes(releaseError.code)) this._released = true
      throw releaseError
    }
  }
}

class CentralScheduler {
  constructor(options = {}) {
    const identity = options.runIdentity
    if (!identity || !nonEmpty(identity.runId) || !Number.isInteger(Number(identity.generation)) || Number(identity.generation) < 0) {
      throw new SchedulerAdmissionError('RUN_IDENTITY_REQUIRED', 'scheduler requires runIdentity { runId, generation }')
    }
    this.runIdentity = Object.freeze({ runId: identity.runId.trim(), generation: Number(identity.generation) })
    this.routeSource = options.routeSource || (options.state && options.state.routeSource) || 'automatic'
    if (!ROUTE_SOURCES.includes(this.routeSource)) {
      throw new SchedulerAdmissionError('INVALID_ROUTE_SOURCE', 'scheduler routeSource must be automatic or explicit_control')
    }
    const requestedRoute = normalizeRoute(
      options.route || (options.settings && options.settings.route) || (options.state && options.state.route),
      { allowPending: true },
    )
    if (requestedRoute === PENDING_ROUTE) {
      if (options.settings && stableStringify(options.settings) !== stableStringify(PENDING_ROUTE_SETTINGS)) {
        throw new SchedulerAdmissionError('INVALID_PENDING_SETTINGS', 'pending admission uses the canonical one-analyst settings')
      }
      this.settings = PENDING_ROUTE_SETTINGS
      this.route = PENDING_ROUTE
    } else {
      this.settings = validateResolvedSchedulerSettings(options.settings || (options.state && options.state.settings) || resolveSchedulerSettings(options))
      this.route = normalizeRoute(this.settings.route)
    }
    this.budget = this.settings.budget
    this._now = typeof options.now === 'function' ? options.now : Date.now
    this._totalWorkMs = Number.isFinite(Number(options.totalWorkMs))
      ? finiteNonNegative(options.totalWorkMs)
      : null
    this._rootContextId = nonEmpty(options.rootContextId) ? options.rootContextId : 'root-1'
    this._rootContexts = 1
    this._rootContextAdoption = null
    this._safeSequentialTransport = false
    this._live = new Map()
    this._queue = []
    this._attempts = new Map()
    this._equivalenceLanes = new Map()
    this._progressFingerprints = new Map()
    this._laneCounters = Object.fromEntries(Object.keys(this.settings.lanes).map((lane) => [lane, {
      launches: 0,
      live: 0,
      usage: emptyUsage(),
      reserved: emptyUsage(),
    }]))
    this._resourceOwners = new Map()
    this._optionalBoundaryOwners = new Map()
    this._issuedLeases = new WeakSet()
    this._issuedRootAccountingLeases = new WeakSet()
    this._issuedAuthorities = new WeakSet()
    this._consumedAuthorities = new WeakSet()
    this._admittingAuthorities = new WeakSet()
    this._usage = {
      work: emptyUsage(),
      planning: emptyUsage(),
      optional: emptyUsage(),
      verification: emptyUsage(),
      recovery: emptyUsage(),
    }
    this._reserved = {
      work: emptyUsage(),
      planning: emptyUsage(),
      optional: emptyUsage(),
      verification: emptyUsage(),
      recovery: emptyUsage(),
    }
    this._startedAt = this._now()
    this._lastProgressAt = this._startedAt
    this._lastProgressKind = 'activation'
    this._admissionComponents = {
      configuration: 0,
      runRecord: 0,
      persistence: 0,
      firstChildStartup: 0,
      routeAnalyst: 0,
      routeDecision: 0,
      lightPlanning: 0,
      roadmapPlanning: 0,
      waitingUser: 0,
    }
    this._terminalResult = null
    this._roadmapAskMeasurement = null
    this._firstProductSignal = null
    this._topologyCounts = null
    this._rootDecisionAccounting = {
      status: 'not-started',
      sessionId: null,
      reported: emptyUsage(),
      usageFieldsSeen: new Set(),
      budgetExhaustion: null,
    }
    this._caches = { harnessAttestations: new Map(), proofs: new Map() }
    this._sequence = 0
    this._disposed = false
    this._metrics = {
      admitted: 0,
      completed: 0,
      failed: 0,
      queued: 0,
      dequeued: 0,
      totalLaunches: 0,
      maxDepthObserved: 0,
      peakLiveIncludingRoot: 1,
      optionalEvaluated: 0,
      optionalAdmitted: 0,
      optionalRejected: 0,
      retriesStarted: 0,
      retryReassessments: 0,
      rejectedByCode: {},
      budgetOverruns: 0,
      streamReports: 0,
      forcedStops: 0,
      productiveReports: 0,
      invalidAccounting: 0,
      rootAccountingSessions: 0,
      rootAccountingCompleted: 0,
      rootAccountingFailed: 0,
      harnessCacheHits: 0,
      harnessCacheMisses: 0,
      proofCacheHits: 0,
      proofCacheMisses: 0,
    }

    if (options.state) this._restore(options.state)
  }

  freezeRoute(route, resolvedSettings) {
    if (this.route !== PENDING_ROUTE) {
      throw this._error('ROUTE_ALREADY_FROZEN', `scheduler route is already frozen: ${this.route}`)
    }
    if (this._live.size > 0 || this._queue.length > 0) {
      throw this._error('ROUTE_FREEZE_NOT_DRAINED', 'route may freeze only after the analyst lease and queue drain')
    }
    if (this._laneCounters.routeAnalyst.launches !== 1 || this._rootDecisionAccounting.status !== 'completed') {
      throw this._error('ROUTE_DECISION_INCOMPLETE', 'route freeze requires one completed analyst child and one completed root-accounted L0 decision')
    }
    const targetRoute = normalizeRoute(route)
    const target = validateResolvedSchedulerSettings(resolvedSettings || resolveSchedulerSettings({ route: targetRoute }))
    if (target.route !== targetRoute) {
      throw this._error('INVALID_SCHEDULER_SETTINGS', 'resolved settings route does not match the frozen route')
    }
    const merged = validateResolvedSchedulerSettings(deepFreeze({
      schemaVersion: 1,
      route: targetRoute,
      policyClass: target.policyClass,
      economicPolicySource: target.economicPolicySource,
      concurrencyPreset: target.concurrencyPreset,
      budget: target.budget,
      lanes: { ...target.lanes, ...PENDING_ROUTE_SETTINGS.lanes },
    }))
    this._assertUsageWithinSettings(merged)
    const prior = this._laneCounters
    this.settings = merged
    this.route = targetRoute
    this.budget = merged.budget
    this._laneCounters = Object.fromEntries(Object.keys(merged.lanes).map((lane) => [lane, prior[lane] || {
      launches: 0,
      live: 0,
      usage: emptyUsage(),
      reserved: emptyUsage(),
    }]))
    return Object.freeze({
      route: this.route,
      settings: this.settings,
      preservedLaunches: this._metrics.totalLaunches,
      rootDecisionAccounted: true,
    })
  }

  recordHarnessAttestation(input = {}) {
    const rawOutputHash = requireDigest(input.rawOutputHash, 'rawOutputHash')
    const persistedResultHash = requireDigest(input.persistedResultHash || input.resultHash, 'persistedResultHash')
    if (persistedResultHash !== rawOutputHash) {
      throw this._error('ATTESTATION_RESULT_HASH_MISMATCH', 'persisted harness result must equal the attested raw output hash')
    }
    const payload = {
      schemaVersion: 1,
      kind: 'repo-build-oracle-attestation',
      provenance: this._newCacheProvenance(),
      repoHash: requireDigest(input.repoHash, 'repoHash'),
      buildHash: requireDigest(input.buildHash, 'buildHash'),
      oracleHash: requireDigest(input.oracleHash, 'oracleHash'),
      rawOutputHash,
      persistedResultHash,
    }
    return this._putCacheRecord('harnessAttestations', payload)
  }

  getHarnessAttestation(keyOrInputs) {
    const key = keyOrInputs && typeof keyOrInputs === 'object'
      ? this._cacheKeyFor('harnessAttestations', keyOrInputs)
      : keyOrInputs
    return this._getCacheRecord('harnessAttestations', key)
  }

  recordProofCache(input = {}) {
    if (!nonEmpty(input.verdict)) throw this._error('INVALID_CACHE_ATTESTATION', 'proof verdict is required')
    const rawOutputHash = requireDigest(input.rawOutputHash, 'rawOutputHash')
    const persistedResultHash = requireDigest(input.persistedResultHash || input.resultHash, 'persistedResultHash')
    if (persistedResultHash !== rawOutputHash) {
      throw this._error('ATTESTATION_RESULT_HASH_MISMATCH', 'persisted proof result must equal the attested raw output hash')
    }
    const payload = {
      schemaVersion: 1,
      kind: 'candidate-oracle-environment-proof',
      provenance: this._newCacheProvenance(),
      candidateHash: requireDigest(input.candidateHash, 'candidateHash'),
      oracleHash: requireDigest(input.oracleHash, 'oracleHash'),
      environmentHash: requireDigest(input.environmentHash, 'environmentHash'),
      rawOutputHash,
      persistedResultHash,
      verdict: input.verdict.trim().toUpperCase(),
    }
    return this._putCacheRecord('proofs', payload)
  }

  getProofCache(keyOrInputs) {
    const key = keyOrInputs && typeof keyOrInputs === 'object'
      ? this._cacheKeyFor('proofs', keyOrInputs)
      : keyOrInputs
    return this._getCacheRecord('proofs', key)
  }

  _putCacheRecord(cacheName, payload) {
    const key = this._cacheKeyFor(cacheName, payload)
    const record = Object.freeze({ ...payload, key, signature: this._cacheSignature(key, payload) })
    const existing = this._caches[cacheName].get(key)
    if (existing && stableStringify(existing) !== stableStringify(record)) {
      throw this._error('CACHE_ATTESTATION_CONFLICT', 'cache key already contains different signed evidence', { key })
    }
    this._caches[cacheName].set(key, record)
    return record
  }

  _getCacheRecord(cacheName, key) {
    const metric = cacheName === 'harnessAttestations' ? 'harnessCache' : 'proofCache'
    const record = this._caches[cacheName].get(String(key)) || null
    this._metrics[`${metric}${record ? 'Hits' : 'Misses'}`]++
    return record
  }

  _cacheSignature(key, payload) {
    const signed = {
      ...payload,
      provenance: {
        runId: payload.provenance && payload.provenance.runId,
        createdGeneration: payload.provenance && payload.provenance.createdGeneration,
      },
    }
    return sha256(Buffer.from(stableStringify({ schemaVersion: 1, key, payload: signed }), 'utf8'))
  }

  _newCacheProvenance() {
    return {
      runId: this.runIdentity.runId,
      createdGeneration: this.runIdentity.generation,
      validatedGeneration: this.runIdentity.generation,
      migrations: [],
    }
  }

  _migrationSignature(key, fromGeneration, toGeneration, previousSignature) {
    return sha256(Buffer.from(stableStringify({
      schemaVersion: 1,
      kind: 'scheduler-cache-generation-migration',
      runId: this.runIdentity.runId,
      key,
      fromGeneration,
      toGeneration,
      previousSignature,
    }), 'utf8'))
  }

  _cacheKeyFor(cacheName, input) {
    const binding = cacheName === 'harnessAttestations'
      ? {
          kind: 'repo-build-oracle-attestation', runId: input.provenance && input.provenance.runId || this.runIdentity.runId,
          repoHash: requireDigest(input.repoHash, 'repoHash'),
          buildHash: requireDigest(input.buildHash, 'buildHash'),
          oracleHash: requireDigest(input.oracleHash, 'oracleHash'),
        }
      : {
          kind: 'candidate-oracle-environment-proof', runId: input.provenance && input.provenance.runId || this.runIdentity.runId,
          candidateHash: requireDigest(input.candidateHash, 'candidateHash'),
          oracleHash: requireDigest(input.oracleHash, 'oracleHash'),
          environmentHash: requireDigest(input.environmentHash, 'environmentHash'),
        }
    return sha256(Buffer.from(stableStringify(binding), 'utf8'))
  }

  _restoreCacheRecord(cacheName, saved) {
    if (!saved || typeof saved !== 'object') throw this._error('INVALID_SCHEDULER_STATE', 'saved cache record is invalid')
    const payload = { ...saved }
    delete payload.key
    delete payload.signature
    const key = this._cacheKeyFor(cacheName, payload)
    const signature = this._cacheSignature(key, payload)
    const provenance = saved.provenance || {}
    if (saved.key !== key || saved.signature !== signature || provenance.runId !== this.runIdentity.runId) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved cache record failed its run-bound signature', { cacheName, key: saved.key })
    }
    const expectedKind = cacheName === 'harnessAttestations'
      ? 'repo-build-oracle-attestation'
      : 'candidate-oracle-environment-proof'
    if (saved.schemaVersion !== 1 || saved.kind !== expectedKind) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved cache record has an unsupported schema or kind', { cacheName })
    }
    if (saved.rawOutputHash !== saved.persistedResultHash) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved cache result hash differs from its raw output attestation', { cacheName, key })
    }
    const created = Number(provenance.createdGeneration)
    let validated = Number(provenance.validatedGeneration)
    const migrations = Array.isArray(provenance.migrations) ? provenance.migrations.map(item => ({ ...item })) : []
    if (!Number.isSafeInteger(created) || !Number.isSafeInteger(validated) || created < 0 || validated < created || validated > this.runIdentity.generation) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved cache generation provenance is invalid', { cacheName, key })
    }
    let previousSignature = signature
    let priorGeneration = created
    for (const migration of migrations) {
      const expectedMigration = this._migrationSignature(key, migration.fromGeneration, migration.toGeneration, migration.previousSignature)
      if (migration.fromGeneration !== priorGeneration || migration.toGeneration <= migration.fromGeneration ||
          migration.previousSignature !== previousSignature || migration.signature !== expectedMigration) {
        throw this._error('INVALID_SCHEDULER_STATE', 'saved cache generation migration chain is invalid', { cacheName, key })
      }
      priorGeneration = migration.toGeneration
      previousSignature = migration.signature
    }
    if (priorGeneration !== validated) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved cache validated generation does not match its migration chain', { cacheName, key })
    }
    if (validated < this.runIdentity.generation) {
      const migration = {
        fromGeneration: validated,
        toGeneration: this.runIdentity.generation,
        previousSignature,
      }
      migration.signature = this._migrationSignature(key, migration.fromGeneration, migration.toGeneration, migration.previousSignature)
      migrations.push(migration)
      validated = this.runIdentity.generation
    }
    const migrated = {
      ...saved,
      provenance: { runId: provenance.runId, createdGeneration: created, validatedGeneration: validated, migrations },
    }
    this._caches[cacheName].set(key, Object.freeze(migrated))
  }

  /**
   * Account model usage produced by the already-running L0/root context.  This
   * is deliberately not acquire(): it creates no child, consumes no launch or
   * lane allowance, and changes neither depth nor live-child telemetry.
   */
  beginRootAccounting(input = {}) {
    try {
      this._assertAdmissionOpen()
      if (this.route !== PENDING_ROUTE || input.phase !== 'routeDecision') {
        throw this._error('ROOT_ACCOUNTING_PHASE_INVALID', 'root accounting is reserved for the pending L0 route decision')
      }
      if (!nonEmpty(input.sessionId)) {
        throw this._error('ROOT_ACCOUNTING_SESSION_REQUIRED', 'root accounting requires a stable root sessionId')
      }
      if (this._laneCounters.routeAnalyst.launches !== 1 || this._laneCounters.routeAnalyst.live !== 0 ||
          this._live.size !== 0 || this._queue.length !== 0) {
        throw this._error('ROUTE_ANALYST_INCOMPLETE', 'root route-decision accounting begins only after the analyst child drains')
      }
      if (this._rootDecisionAccounting.status !== 'not-started') {
        throw this._error('ROOT_ACCOUNTING_DUPLICATE', 'the L0 route decision already has an accounting session')
      }
      const record = {
        status: 'live',
        id: 'root-route-decision',
        phase: 'routeDecision',
        sessionId: input.sessionId.trim(),
        reported: emptyUsage(),
        usageFieldsSeen: new Set(),
        budgetExhaustion: null,
        crashBinding: null,
      }
      this._rootDecisionAccounting = record
      this._metrics.rootAccountingSessions++
      const lease = new RootAccountingLease(this, record)
      this._issuedRootAccountingLeases.add(lease)
      return lease
    } catch (error) {
      throw this._recordRejection(error)
    }
  }

  beginRootSession(input = {}) {
    return this.beginRootAccounting(input)
  }

  _rootRecordForLease(lease) {
    if (!this._issuedRootAccountingLeases.has(lease) || this._rootDecisionAccounting.status !== 'live' ||
        lease.id !== this._rootDecisionAccounting.id) {
      throw this._recordRejection(this._error('ROOT_ACCOUNTING_LEASE_INVALID', 'root usage requires the live scheduler-issued root accounting lease'))
    }
    return this._rootDecisionAccounting
  }

  _continuedRootUsageVerdict(delta, afterAccounting) {
    const projected = totalUsage(this._usage)
    if (!afterAccounting) addUsage(projected, delta)
    const routeValues = {
      noncachedInput: projected.noncachedInput,
      cachedInput: projected.cachedInput,
      output: projected.output + projected.reasoning,
    }
    const hardCeilings = []
    const reserveStops = []
    const at = []
    for (const dimension of TOKEN_DIMENSIONS) {
      const limit = this.budget.tokens[dimension]
      if (routeValues[dimension] > limit) hardCeilings.push(`route:${dimension}`)
      if (routeValues[dimension] > limit * (1 - VERIFICATION_RESERVE - RECOVERY_RESERVE)) {
        reserveStops.push(`route:${dimension}`)
      }
      if (routeValues[dimension] >= limit) at.push(dimension)
    }
    if (this._totalWorkMs !== null) {
      if (projected.workMs > this._totalWorkMs) hardCeilings.push('route:workMs')
      if (projected.workMs > this._totalWorkMs * (1 - VERIFICATION_RESERVE - RECOVERY_RESERVE)) {
        reserveStops.push('route:workMs')
      }
      if (projected.workMs >= this._totalWorkMs) at.push('workMs')
    }
    return {
      allowed: hardCeilings.length === 0 && reserveStops.length === 0,
      atCeiling: at.length > 0,
      code: hardCeilings.length > 0
        ? 'HARD_USAGE_CEILING'
        : reserveStops.length > 0 ? 'BUDGET_RESERVE' : 'USAGE_ALLOWED',
      hardCeilings,
      reserveStops,
    }
  }

  authorizeRootUsage(lease, delta) {
    this._rootRecordForLease(lease)
    const usage = normalizeUsageDelta(delta, { requireModelFields: true })
    const verdict = this._continuedRootUsageVerdict(usage, false)
    return {
      ...verdict,
      allowed: verdict.allowed && !verdict.atCeiling,
      continue: verdict.allowed && !verdict.atCeiling,
      code: verdict.hardCeilings.length > 0 ? 'BUDGET_EXHAUSTED' : verdict.code,
    }
  }

  reportRootUsage(lease, delta, options = {}) {
    const record = this._rootRecordForLease(lease)
    const usage = normalizeUsageDelta(delta, { requireModelFields: true })
    const preflight = this._continuedRootUsageVerdict(usage, false)
    for (const field of reportedFields(delta)) record.usageFieldsSeen.add(field)
    addUsage(this._usage.planning, usage)
    addUsage(record.reported, usage)
    this._metrics.streamReports++
    if (options.productive === true && accountingTotal(usage) > 0) this._metrics.productiveReports++
    const after = this._continuedRootUsageVerdict(emptyUsage(), true)
    const hardCeilings = [...new Set([...preflight.hardCeilings, ...after.hardCeilings])].sort()
    const reserveStops = [...new Set([...preflight.reserveStops, ...after.reserveStops])].sort()
    const verdict = {
      continue: preflight.allowed && after.allowed && !after.atCeiling,
      code: hardCeilings.length > 0
        ? 'BUDGET_EXHAUSTED'
        : reserveStops.length > 0 ? 'BUDGET_RESERVE' : after.atCeiling ? 'USAGE_CEILING_REACHED' : 'USAGE_RECORDED',
      hardCeilings,
      reserveStops,
      accounted: { ...usage },
    }
    if (hardCeilings.length > 0) record.budgetExhaustion = Object.freeze({ ...verdict })
    if (!verdict.continue) this._metrics.forcedStops++
    return verdict
  }

  _releaseRootAccounting(lease, outcome, actualUsage, error) {
    const record = this._rootRecordForLease(lease)
    const finalFields = reportedFields(actualUsage)
    try {
      if (finalFields.size > 0) {
        // Preserve every valid category the provider did report. Missing
        // categories are rejected below; they are never manufactured as zero.
        const cumulative = normalizeUsageDelta(actualUsage)
        const delta = emptyUsage()
        for (const dimension of ACCOUNTING_DIMENSIONS) {
          if (!finalFields.has(dimension)) continue
          if (cumulative[dimension] < record.reported[dimension]) {
            throw this._error('USAGE_REGRESSION', `final root ${dimension} usage is below streamed usage`)
          }
          delta[dimension] = cumulative[dimension] - record.reported[dimension]
        }
        const before = this._continuedRootUsageVerdict(delta, false)
        for (const field of finalFields) record.usageFieldsSeen.add(field)
        addUsage(this._usage.planning, delta)
        addUsage(record.reported, delta)
        const after = this._continuedRootUsageVerdict(emptyUsage(), true)
        const hardCeilings = [...new Set([...before.hardCeilings, ...after.hardCeilings])].sort()
        if (hardCeilings.length > 0) record.budgetExhaustion = Object.freeze({ code: 'BUDGET_EXHAUSTED', hardCeilings })
      }
    } catch (usageError) {
      if (!['INCOMPLETE_USAGE_REPORT', 'INVALID_USAGE_REPORT', 'USAGE_REGRESSION'].includes(usageError.code)) throw usageError
      this._metrics.invalidAccounting++
      this._finalizeRootAccounting(record, 'failed', usageError)
      throw this._error('INCOMPLETE_USAGE_ACCOUNTING', 'root terminal usage is invalid or incomplete; accounting session was released', {
        cause: usageError.code,
      })
    }
    const missing = MODEL_USAGE_FIELDS.filter((field) => !record.usageFieldsSeen.has(field))
    if (missing.length > 0) {
      this._metrics.invalidAccounting++
      this._finalizeRootAccounting(record, 'failed')
      throw this._error('INCOMPLETE_USAGE_ACCOUNTING', 'root model usage must explicitly cover every token category', { missing })
    }
    const budgetExhausted = Boolean(record.budgetExhaustion)
    this._finalizeRootAccounting(record, outcome === 'completed' && budgetExhausted ? 'failed' : outcome, error)
    if (outcome === 'completed' && budgetExhausted) {
      throw this._error('BUDGET_EXHAUSTED', 'root route-decision usage exceeded the hard run budget', {
        hardCeilings: record.budgetExhaustion.hardCeilings,
      })
    }
    return true
  }

  _finalizeRootAccounting(record, outcome, error) {
    record.status = outcome
    record.errorCode = error && error.code || null
    this._metrics[outcome === 'completed' ? 'rootAccountingCompleted' : 'rootAccountingFailed']++
  }

  acquire(request = {}) {
    if (this._disposed) return Promise.reject(this._error('SCHEDULER_CLOSED', 'scheduler is closed'))
    let normalized
    try {
      normalized = this._normalizeRequest(request)
      this._validateBeforeQueue(normalized)
      const lease = this._tryStart(normalized)
      if (lease) return Promise.resolve(lease)
    } catch (error) {
      return Promise.reject(this._recordRejection(error))
    }

    return new Promise((resolve, reject) => {
      const queued = { request: normalized, resolve, reject, abortHandler: null }
      if (normalized.signal) {
        queued.abortHandler = () => {
          const index = this._queue.indexOf(queued)
          if (index !== -1) this._queue.splice(index, 1)
          reject(this._recordRejection(this._error('ADMISSION_CANCELLED', 'queued launch was cancelled')))
        }
        normalized.signal.addEventListener('abort', queued.abortHandler, { once: true })
      }
      this._queue.push(queued)
      this._metrics.queued++
    })
  }

  issueLaunchAuthority(binding = {}) {
    if (!nonEmpty(binding.callerRole) || !nonEmpty(binding.sessionId)) {
      throw this._error('INVALID_LAUNCH_AUTHORITY', 'callerRole and physical sessionId are required')
    }
    if (binding.runId !== this.runIdentity.runId || Number(binding.generation) !== this.runIdentity.generation) {
      throw this._error('RUN_GENERATION_MISMATCH', 'launch authority does not match scheduler run/generation')
    }
    let capabilities
    try { capabilities = validateProviderCapabilities(binding.providerCapabilities) } catch (error) {
      throw this._error(error.code, error.message, error.details)
    }
    const parentLease = binding.parentLease || null
    if (parentLease && (!this._issuedLeases.has(parentLease) || !this._live.has(parentLease.id))) {
      throw this._error('INVALID_PARENT_LEASE', 'launch authority parent must be a live scheduler-issued lease')
    }
    const authority = Object.freeze({
      kind: 'scheduler-launch-authority',
      callerRole: binding.callerRole.trim(),
      sessionId: binding.sessionId.trim(),
      runId: this.runIdentity.runId,
      generation: this.runIdentity.generation,
      parentLease,
      parentLeaseId: parentLease ? parentLease.id : null,
      providerCapabilities: capabilities,
    })
    this._issuedAuthorities.add(authority)
    return authority
  }

  acquireWithAuthority(authority, request = {}) {
    if (!this._issuedAuthorities.has(authority) || this._consumedAuthorities.has(authority)) {
      return Promise.reject(this._recordRejection(this._error(
        'INVALID_LAUNCH_AUTHORITY',
        'every model launch requires a fresh scheduler-issued authority',
      )))
    }
    this._consumedAuthorities.add(authority)
    this._admittingAuthorities.add(authority)
    try {
      return this.acquire({ ...request, _authority: authority, _parentLease: authority.parentLease })
    } finally {
      this._admittingAuthorities.delete(authority)
    }
  }

  acquireRoot(authority, request = {}) {
    if (authority && authority.parentLease) {
      return Promise.reject(this._recordRejection(this._error('INVALID_LAUNCH_AUTHORITY', 'root authority cannot bind a parent')))
    }
    return this.acquireWithAuthority(authority, request)
  }

  acquireChild(parentLease, authority, request = {}) {
    if (!this._issuedLeases.has(parentLease)) {
      return Promise.reject(this._recordRejection(this._error(
        'INVALID_PARENT_LEASE',
        'nested depth requires a live scheduler-issued parent lease',
      )))
    }
    if (!authority || authority.parentLease !== parentLease) {
      return Promise.reject(this._recordRejection(this._error('INVALID_LAUNCH_AUTHORITY', 'authority is not bound to this parent lease')))
    }
    return this.acquireWithAuthority(authority, request)
  }

  tryAcquire(request = {}) {
    try {
      if (this._disposed) throw this._error('SCHEDULER_CLOSED', 'scheduler is closed')
      const normalized = this._normalizeRequest(request)
      this._validateBeforeQueue(normalized)
      return this._tryStart(normalized)
    } catch (error) {
      throw this._recordRejection(error)
    }
  }

  tryAcquireWithAuthority(authority, request = {}) {
    if (!this._issuedAuthorities.has(authority) || this._consumedAuthorities.has(authority)) {
      throw this._recordRejection(this._error('INVALID_LAUNCH_AUTHORITY', 'fresh launch authority required'))
    }
    this._consumedAuthorities.add(authority)
    this._admittingAuthorities.add(authority)
    try {
      return this.tryAcquire({ ...request, _authority: authority, _parentLease: authority.parentLease })
    } finally {
      this._admittingAuthorities.delete(authority)
    }
  }

  async launch(request, work) {
    if (typeof work !== 'function') throw new TypeError('work must be a function')
    const lease = await this.acquire(request)
    try {
      const result = await work(lease)
      const usage = result && typeof result === 'object' && result.usage ? result.usage : {}
      lease.complete(usage)
      return result
    } catch (error) {
      lease.fail(error, error && error.usage ? error.usage : {})
      throw error
    }
  }

  async launchWithAuthority(authority, request, work) {
    if (typeof work !== 'function') throw new TypeError('work must be a function')
    const lease = await this.acquireWithAuthority(authority, request)
    try {
      const result = await work(lease)
      lease.complete(result && result.usage ? result.usage : {})
      return result
    } catch (error) {
      if (!lease._released) lease.fail(error, error && error.usage ? error.usage : {})
      throw error
    }
  }

  authorizeUsage(lease, delta) {
    const record = this._recordForLease(lease)
    const usage = normalizeUsageDelta(delta, { requireModelFields: true })
    const verdict = this._continuedUsageVerdict(record, usage, false)
    return {
      ...verdict,
      allowed: verdict.allowed && !verdict.atCeiling,
      continue: verdict.allowed && !verdict.atCeiling,
      code: verdict.hardCeilings.length > 0 ? 'BUDGET_EXHAUSTED' : verdict.code,
    }
  }

  reportUsage(lease, delta, options = {}) {
    const record = this._recordForLease(lease)
    const usage = normalizeUsageDelta(delta, { requireModelFields: true })
    const preflight = this._continuedUsageVerdict(record, usage, false)
    this._accountStreamDelta(record, usage, reportedFields(delta))
    this._metrics.streamReports++
    if (options.productive === true && accountingTotal(usage) > 0) {
      this._metrics.productiveReports++
      this.markMeaningfulProgress(options.progressKind || 'work', record.id)
    }
    const after = this._continuedUsageVerdict(record, emptyUsage(), true)
    const hardCeilings = [...new Set([...preflight.hardCeilings, ...after.hardCeilings])].sort()
    const verdict = {
      continue: preflight.allowed && after.allowed && !after.atCeiling,
      code: hardCeilings.length > 0
        ? 'BUDGET_EXHAUSTED'
        : !preflight.allowed ? preflight.code : after.atCeiling ? 'USAGE_CEILING_REACHED' : 'USAGE_RECORDED',
      hardCeilings,
      optionalStops: [...new Set([...preflight.optionalStops, ...after.optionalStops])].sort(),
      accounted: { ...usage },
    }
    if (hardCeilings.length > 0) record.budgetExhaustion = Object.freeze({ ...verdict })
    if (!verdict.continue) this._metrics.forcedStops++
    return verdict
  }

  markMeaningfulProgress(kind = 'work', leaseId = null) {
    const allowed = ['work', 'check', 'verification', 'test', 'recovery']
    if (!allowed.includes(String(kind).toLowerCase())) return false
    if (leaseId !== null && !this._live.has(leaseId)) return false
    this._lastProgressAt = this._now()
    this._lastProgressKind = String(kind).toLowerCase()
    return true
  }

  checkNoProgress() {
    const now = this._now()
    const idleMs = Math.max(0, now - this._lastProgressAt)
    return {
      reviewRequired: idleMs >= this.budget.noProgressMs,
      code: idleMs >= this.budget.noProgressMs ? 'NO_PROGRESS_REVIEW' : 'PROGRESS_OK',
      idleMs,
      limitMs: this.budget.noProgressMs,
      lastProgressKind: this._lastProgressKind,
    }
  }

  recordAdmissionComponent(component, durationMs) {
    const aliases = {
      config: 'configuration',
      recordCreation: 'runRecord',
      firstWorkerStartup: 'firstChildStartup',
      analyst: 'routeAnalyst',
      l0: 'routeDecision',
      planning: 'lightPlanning',
      roadmap: 'roadmapPlanning',
      userWait: 'waitingUser',
    }
    const name = aliases[component] || component
    if (!Object.hasOwn(this._admissionComponents, name)) {
      throw this._error('INVALID_ADMISSION_COMPONENT', `unknown admission component: ${component}`)
    }
    const duration = finiteNonNegative(durationMs, NaN)
    if (!Number.isFinite(duration)) {
      throw this._error('INVALID_ADMISSION_DURATION', 'admission duration must be a non-negative number')
    }
    this._admissionComponents[name] += duration
    return this.checkAdmissionTime()
  }

  checkAdmissionTime() {
    const bootstrap = ['configuration', 'runRecord', 'persistence', 'firstChildStartup']
      .reduce((sum, name) => sum + this._admissionComponents[name], 0)
    const included = bootstrap + this._admissionComponents.routeAnalyst +
      this._admissionComponents.routeDecision +
      (this.route === 'LIGHT' ? this._admissionComponents.lightPlanning : 0) +
      (this.route === 'ROADMAP' ? this._admissionComponents.roadmapPlanning : 0)
    const breaches = []
    if (bootstrap > ADMISSION_COMPONENT_CEILINGS_MS.bootstrap) breaches.push('bootstrap')
    for (const name of ['routeAnalyst', 'routeDecision']) {
      if (this._admissionComponents[name] > ADMISSION_COMPONENT_CEILINGS_MS[name]) breaches.push(name)
    }
    if (this.route === 'LIGHT' && this._admissionComponents.lightPlanning > ADMISSION_COMPONENT_CEILINGS_MS.lightPlanning) {
      breaches.push('lightPlanning')
    }
    if (this.route === 'ROADMAP' && this._admissionComponents.roadmapPlanning > ADMISSION_COMPONENT_CEILINGS_MS.roadmapPlanning) {
      breaches.push('roadmapPlanning')
    }
    if (this.budget.admissionHardMs && included > this.budget.admissionHardMs) breaches.push('combined')
    return {
      withinCeiling: breaches.length === 0,
      code: breaches.length === 0 ? 'ADMISSION_TIME_OK' : 'ADMISSION_COMPONENT_TIMEOUT',
      breaches,
      includedMs: included,
      waitingUserMs: this._admissionComponents.waitingUser,
      components: { ...this._admissionComponents, bootstrap },
      combinedHardMs: this.budget.admissionHardMs || null,
      p95TargetMs: this.budget.admissionP95Ms || null,
      withinP95: !this.budget.admissionP95Ms || included <= this.budget.admissionP95Ms,
    }
  }

  _assertAdmissionOpen() {
    const verdict = this.checkAdmissionTime()
    if (!verdict.withinCeiling) {
      throw this._error('ADMISSION_COMPONENT_TIMEOUT', 'admission component or combined hard ceiling was exceeded', {
        breaches: verdict.breaches,
        includedMs: verdict.includedMs,
        components: verdict.components,
        combinedHardMs: verdict.combinedHardMs,
      })
    }
    return verdict
  }

  recordTerminalResult(result) {
    if (!result || typeof result !== 'object' || typeof result.accepted !== 'boolean') {
      throw this._error('INVALID_TERMINAL_RESULT', 'terminal result requires accepted=true/false')
    }
    this._terminalResult = {
      accepted: result.accepted,
      reward: Number.isFinite(Number(result.reward)) ? Number(result.reward) : null,
      reason: nonEmpty(result.reason) ? result.reason.trim() : null,
    }
    return { ...this._terminalResult }
  }

  recordRoadmapAskRatio(measurement = {}) {
    if (this.route !== 'ROADMAP') {
      throw this._error('ROADMAP_ASK_RATIO_INVALID', 'roadmap ask measurement is valid only for ROADMAP')
    }
    const roadmapAskCount = Number(measurement.roadmapAskCount)
    const userAskCount = Number(measurement.userAskCount)
    if (!Number.isSafeInteger(roadmapAskCount) || roadmapAskCount < 1 ||
        !Number.isSafeInteger(userAskCount) || userAskCount < 1 ||
        !/^[a-f0-9]{64}$/.test(measurement.missionScopeHash || '') ||
        !/^[a-f0-9]{64}$/.test(measurement.planSha256 || '')) {
      throw this._error(
        'ROADMAP_ASK_RATIO_INVALID',
        'roadmap ask measurement requires positive exact counts, the immutable request scope hash, and the frozen plan hash',
      )
    }
    const expansionCount = Math.max(0, roadmapAskCount - userAskCount)
    const admission = measurement.expansionAdmission
    if (expansionCount > 0 && !validRoadmapExpansionAdmission(admission, {
      admittedAskCount: expansionCount,
      missionScopeHash: measurement.missionScopeHash,
      planSha256: measurement.planSha256,
    })) {
      throw this._error(
        'ROADMAP_EXPANSION_NOT_ADMITTED',
        'roadmap work beyond the immutable request ceiling requires supervisor-authorized, request-and-plan-bound necessity and marginal-value evidence',
        { roadmapAskCount, userAskCount, expansionCount },
      )
    }
    this._roadmapAskMeasurement = Object.freeze({
      roadmapAskCount,
      userAskCount,
      roadmapAskToUserAskRatio: roadmapAskCount / userAskCount,
      missionScopeHash: measurement.missionScopeHash,
      planSha256: measurement.planSha256,
      askCeiling: userAskCount + expansionCount,
      expansionAdmission: expansionCount > 0 ? Object.freeze({ ...admission }) : null,
    })
    return { ...this._roadmapAskMeasurement }
  }

  recordFirstProductSignal(measurement = {}) {
    if (this.route === PENDING_ROUTE || !['RED', 'PRODUCT_EDIT'].includes(measurement.kind) ||
        !Number.isSafeInteger(measurement.elapsedMs) || measurement.elapsedMs < 0 ||
        !/^[a-f0-9]{64}$/.test(measurement.evidenceHash || '')) {
      throw this._error('FIRST_PRODUCT_SIGNAL_INVALID', 'first product signal requires route, RED/product-edit kind, elapsed milliseconds, and evidence hash')
    }
    if (this._firstProductSignal) return { ...this._firstProductSignal }
    const ceilingMs = this.route === 'DIRECT'
      ? ADMISSION_COMPONENT_CEILINGS_MS.routeAnalyst + ADMISSION_COMPONENT_CEILINGS_MS.routeDecision
      : this.route === 'LIGHT'
        ? ADMISSION_COMPONENT_CEILINGS_MS.routeAnalyst + ADMISSION_COMPONENT_CEILINGS_MS.routeDecision +
          ADMISSION_COMPONENT_CEILINGS_MS.lightPlanning
        : this.budget.admissionHardMs
    const reason = nonEmpty(measurement.blocker || measurement.reason)
      ? String(measurement.blocker || measurement.reason).trim()
      : null
    this._firstProductSignal = Object.freeze({
      kind: measurement.kind,
      elapsedMs: measurement.elapsedMs,
      evidenceHash: measurement.evidenceHash,
      ceilingMs,
      withinCeiling: !ceilingMs || measurement.elapsedMs <= ceilingMs,
      reason,
    })
    if (!this._firstProductSignal.withinCeiling) {
      throw this._error(
        reason ? 'FIRST_PRODUCT_SIGNAL_LATE' : 'FIRST_PRODUCT_SIGNAL_REASON_REQUIRED',
        reason
          ? 'first RED/product edit missed the route ceiling; the exact blocker is recorded'
          : 'a late first RED/product edit must record the exact blocker or reason',
        { firstProductSignal: { ...this._firstProductSignal } },
      )
    }
    return { ...this._firstProductSignal }
  }

  assertFirstProductSignalDue(measurement = {}) {
    if (this._firstProductSignal) return { ...this._firstProductSignal }
    const elapsedMs = Number(measurement.elapsedMs)
    const ceilingMs = this.route === 'DIRECT'
      ? ADMISSION_COMPONENT_CEILINGS_MS.routeAnalyst + ADMISSION_COMPONENT_CEILINGS_MS.routeDecision
      : this.route === 'LIGHT'
        ? ADMISSION_COMPONENT_CEILINGS_MS.routeAnalyst + ADMISSION_COMPONENT_CEILINGS_MS.routeDecision +
          ADMISSION_COMPONENT_CEILINGS_MS.lightPlanning
        : this.budget.admissionHardMs
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw this._error('FIRST_PRODUCT_SIGNAL_INVALID', 'first-product deadline check requires elapsed milliseconds')
    }
    if (ceilingMs && elapsedMs > ceilingMs) {
      const reason = nonEmpty(measurement.reason) ? String(measurement.reason).trim() : 'no RED or product edit was emitted'
      this._firstProductSignal = Object.freeze({
        kind: 'MISSING', elapsedMs, evidenceHash: null, ceilingMs, withinCeiling: false, reason,
      })
      throw this._error('FIRST_PRODUCT_SIGNAL_MISSING', 'first RED/product edit was absent at the route ceiling', {
        firstProductSignal: { ...this._firstProductSignal },
      })
    }
    return null
  }

  recordTopologyCounts(measurement = {}) {
    const normalize = (value, label) => {
      if (!value || !Number.isSafeInteger(value.sessions) || value.sessions < 0 ||
          !Number.isSafeInteger(value.attempts) || value.attempts < 0) {
        throw this._error('TOPOLOGY_COUNTS_INVALID', `${label} topology requires non-negative exact session and attempt counts`)
      }
      return Object.freeze({ sessions: value.sessions, attempts: value.attempts })
    }
    const frozenSnapshot = normalize(measurement.frozenSnapshot, 'frozen-snapshot')
    const livePartial = normalize(measurement.livePartial, 'live-partial')
    if (livePartial.sessions < frozenSnapshot.sessions || livePartial.attempts < frozenSnapshot.attempts) {
      throw this._error('TOPOLOGY_COUNTS_INVALID', 'live-partial topology cannot precede its frozen snapshot')
    }
    if (this._topologyCounts && stableStringify(this._topologyCounts.frozenSnapshot) !== stableStringify(frozenSnapshot)) {
      throw this._error('TOPOLOGY_FROZEN_SNAPSHOT_CHANGED', 'the frozen topology snapshot is immutable')
    }
    this._topologyCounts = Object.freeze({ frozenSnapshot, livePartial })
    return { frozenSnapshot: { ...frozenSnapshot }, livePartial: { ...livePartial } }
  }

  registerRootContext(contextId, options = {}) {
    if (!nonEmpty(contextId)) throw this._error('INVALID_ROOT_CONTEXT', 'root context id is required')
    if (contextId === this._rootContextId) return false
    if (!options.replace) {
      throw this._error('ROOT_CONTEXT_ACTIVE', 'replacement root must be explicit')
    }
    if (this._live.size > 0 || this._queue.length > 0 || this._rootDecisionAccounting.status === 'live') {
      throw this._error('ROOT_NOT_DRAINED', 'the predecessor root must drain before replacement')
    }
    this._rootContextId = contextId
    this._rootContexts++
    return true
  }

  reclassifyForSafeDegradation(evaluation = {}) {
    if (evaluation.accepted !== true || !['DIRECT', 'ROADMAP', 'LIGHT'].includes(this.route)) {
      throw this._recordRejection(this._error('SAFE_DEGRADATION_INVALID', 'safe transport degradation lacks accepted invariants'))
    }
    this.route = 'LIGHT'
    this.routeSource = 'safe-transport-degradation'
    this._safeSequentialTransport = true
    return Object.freeze({ route: this.route, routeSource: this.routeSource, maxLiveChildren: 1 })
  }

  dispose(reason = 'scheduler closed') {
    if (this._disposed) return
    this._disposed = true
    const error = this._recordRejection(this._error('SCHEDULER_CLOSED', reason))
    for (const item of this._queue.splice(0)) {
      this._removeAbortHandler(item)
      item.reject(error)
    }
  }

  getMetrics() {
    const rejectedByCode = {}
    for (const code of Object.keys(this._metrics.rejectedByCode).sort()) {
      rejectedByCode[code] = this._metrics.rejectedByCode[code]
    }
    const liveResources = []
    for (const [key, owners] of [...this._resourceOwners.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      liveResources.push({ key, owners: [...owners].sort() })
    }
    const attempts = {}
    for (const [key, value] of [...this._attempts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      attempts[key] = value
    }
    const usage = cloneUsageGroups(this._usage)
    const usageTotals = totalUsage(this._usage)
    usageTotals.outputIncludingReasoning = usageTotals.output + usageTotals.reasoning
    const lanes = {}
    for (const lane of Object.keys(this._laneCounters).sort()) {
      lanes[lane] = {
        limits: this.settings.lanes[lane],
        launches: this._laneCounters[lane].launches,
        live: this._laneCounters[lane].live,
        usage: { ...this._laneCounters[lane].usage },
        reserved: { ...this._laneCounters[lane].reserved },
      }
    }
    return {
      schemaVersion: 1,
      route: this.route,
      routeSource: this.routeSource,
      runIdentity: this.runIdentity,
      limits: {
        maxChildLaunches: this.budget.maxChildLaunches,
        maxLiveIncludingRoot: this.budget.maxLiveIncludingRoot,
        maxDepth: this.budget.maxDepth,
        retryPolicy: RETRY_POLICY,
        tokens: { ...this.budget.tokens },
        outputIncludesReasoning: true,
        verificationReserve: VERIFICATION_RESERVE,
        recoveryReserve: RECOVERY_RESERVE,
        optionalStopFraction: OPTIONAL_STOP_FRACTION,
        totalWorkMs: this._totalWorkMs,
      },
      counters: {
        ...this._metrics,
        rejectedByCode,
        currentLiveChildren: this._live.size,
        currentLiveIncludingRoot: this._live.size + 1,
        queuedNow: this._queue.length,
        mainContexts: this._rootContexts,
      },
      usage,
      usageTotals,
      reserved: cloneUsageGroups(this._reserved),
      attempts,
      lanes,
      liveResources,
      rootAccounting: {
        phase: 'routeDecision',
        status: this._rootDecisionAccounting.status,
        sessionId: this._rootDecisionAccounting.sessionId,
        reported: { ...this._rootDecisionAccounting.reported },
      },
      rootContextBinding: this._rootContextAdoption
        ? { ...this._rootContextAdoption }
        : { activeRootContextId: this._rootContextId, predecessorRootContextId: null },
      progress: this.checkNoProgress(),
      admission: this.checkAdmissionTime(),
      economics: {
        terminalResult: this._terminalResult ? { ...this._terminalResult } : null,
        costPerAcceptedSolve: this._terminalResult && this._terminalResult.accepted
          ? usageTotals.weightedCost
          : null,
        roadmapAskMeasurement: this._roadmapAskMeasurement ? { ...this._roadmapAskMeasurement } : null,
        firstProductSignal: this._firstProductSignal ? { ...this._firstProductSignal } : null,
        topologyCounts: this._topologyCounts ? {
          frozenSnapshot: { ...this._topologyCounts.frozenSnapshot },
          livePartial: { ...this._topologyCounts.livePartial },
        } : null,
        optionalBoundaryCount: this._optionalBoundaryOwners.size,
      },
      caches: {
        harnessAttestations: this._caches.harnessAttestations.size,
        proofs: this._caches.proofs.size,
      },
    }
  }

  bindCrashContinuation(lease, binding = {}) {
    const record = this._recordForLease(lease)
    if (!nonEmpty(binding.reservationId) || !nonEmpty(binding.sessionId) ||
        !(binding.continuationId === null || binding.continuationId === undefined || nonEmpty(binding.continuationId))) {
      throw this._error('CRASH_BINDING_INVALID', 'live launch recovery requires reservation, control session, and typed continuation identities')
    }
    const normalized = {
      schemaVersion: 1,
      reservationId: binding.reservationId.trim(),
      sessionId: binding.sessionId.trim(),
      continuationId: binding.continuationId == null ? null : binding.continuationId.trim(),
      frontier: normalizeCrashFrontier(binding.frontier),
    }
    normalized.bindingHash = sha256(Buffer.from(stableStringify(normalized), 'utf8'))
    if (record.crashBinding) {
      const prior = record.crashBinding
      const immutablePrior = { ...prior, continuationId: null, bindingHash: null }
      const immutableNext = { ...normalized, continuationId: null, bindingHash: null }
      if (stableStringify(immutablePrior) !== stableStringify(immutableNext) ||
          (prior.continuationId && prior.continuationId !== normalized.continuationId)) {
        throw this._error('CRASH_BINDING_CONFLICT', 'live launch recovery binding cannot change identity or frontier')
      }
      if (!prior.continuationId && normalized.continuationId) record.crashBinding = Object.freeze(normalized)
      return record.crashBinding
    }
    record.crashBinding = Object.freeze(normalized)
    return record.crashBinding
  }

  bindRootCrashContinuation(lease, binding = {}) {
    const record = this._rootRecordForLease(lease)
    if (!nonEmpty(binding.reservationId) || !nonEmpty(binding.sessionId) ||
        !(binding.continuationId === null || binding.continuationId === undefined || nonEmpty(binding.continuationId))) {
      throw this._error('CRASH_BINDING_INVALID', 'root recovery requires its exact reservation, root session, and typed continuation identities')
    }
    const normalized = {
      schemaVersion: 1,
      reservationId: binding.reservationId.trim(),
      sessionId: binding.sessionId.trim(),
      continuationId: binding.continuationId == null ? null : binding.continuationId.trim(),
      frontier: normalizeCrashFrontier(binding.frontier),
    }
    normalized.bindingHash = sha256(Buffer.from(stableStringify(normalized), 'utf8'))
    if (record.crashBinding) {
      const prior = record.crashBinding
      const immutablePrior = { ...prior, continuationId: null, bindingHash: null }
      const immutableNext = { ...normalized, continuationId: null, bindingHash: null }
      if (stableStringify(immutablePrior) !== stableStringify(immutableNext) ||
          (prior.continuationId && prior.continuationId !== normalized.continuationId)) {
        throw this._error('CRASH_BINDING_CONFLICT', 'root recovery binding cannot change identity or frontier')
      }
      if (!prior.continuationId && normalized.continuationId) record.crashBinding = Object.freeze(normalized)
      return record.crashBinding
    }
    record.crashBinding = Object.freeze(normalized)
    return record.crashBinding
  }

  authorizeRootCrashContinuationRotationAfterResult(lease, binding = {}) {
    const record = this._rootRecordForLease(lease)
    const prior = record.crashBinding
    if (!prior || binding.priorBindingHash !== prior.bindingHash ||
        !/^[a-f0-9]{64}$/.test(binding.priorResultReceiptHash || '') ||
        prior.frontier.acceptedResultIds.includes(binding.priorResultReceiptHash) ||
        record.pendingRootCorrectionRotation) {
      throw this._error(
        'CRASH_BINDING_ROTATION_INVALID',
        'root correction rotation authority requires one new committed result bound to the exact current root process',
      )
    }
    const authority = Object.freeze({
      schemaVersion: 1,
      leaseId: record.id,
      priorBindingHash: prior.bindingHash,
      priorResultReceiptHash: binding.priorResultReceiptHash,
    })
    record.pendingRootCorrectionRotation = authority
    return authority
  }

  rotateRootCrashContinuationAfterResult(lease, binding = {}) {
    const record = this._rootRecordForLease(lease)
    const prior = record.crashBinding
    const authority = binding.resultCommitAuthority
    if (!prior || authority !== record.pendingRootCorrectionRotation ||
        !authority || authority.leaseId !== record.id ||
        authority.priorBindingHash !== prior.bindingHash ||
        authority.priorResultReceiptHash !== binding.priorResultReceiptHash ||
        !nonEmpty(binding.reservationId) || !nonEmpty(binding.sessionId) ||
        !(binding.continuationId === null || binding.continuationId === undefined || nonEmpty(binding.continuationId))) {
      throw this._error(
        'CRASH_BINDING_ROTATION_INVALID',
        'root correction rotation requires the exact prior binding, committed result receipt, and replacement transport identities',
      )
    }
    const reservationId = binding.reservationId.trim()
    const sessionId = binding.sessionId.trim()
    if (reservationId === prior.reservationId || sessionId === prior.sessionId ||
        (binding.continuationId != null && binding.continuationId.trim() === prior.continuationId)) {
      throw this._error(
        'CRASH_BINDING_ROTATION_INVALID',
        'root correction rotation requires fresh physical provider identities',
      )
    }
    const frontier = normalizeCrashFrontier(binding.frontier)
    const priorFrontier = normalizeCrashFrontier(prior.frontier)
    const expectedAcceptedResultIds = [
      ...priorFrontier.acceptedResultIds,
      binding.priorResultReceiptHash,
    ]
    if (frontier.resumeState !== priorFrontier.resumeState ||
        stableStringify(frontier.nextReadyWorkIds) !== stableStringify(priorFrontier.nextReadyWorkIds) ||
        stableStringify(frontier.openCheckIds) !== stableStringify(priorFrontier.openCheckIds) ||
        stableStringify(frontier.acceptedResultIds) !== stableStringify(expectedAcceptedResultIds)) {
      throw this._error(
        'CRASH_BINDING_ROTATION_INVALID',
        'root correction rotation must preserve the logical frontier and add exactly the committed prior result receipt',
      )
    }
    const normalized = {
      schemaVersion: 1,
      reservationId,
      sessionId,
      continuationId: binding.continuationId == null ? null : binding.continuationId.trim(),
      frontier,
    }
    normalized.bindingHash = sha256(Buffer.from(stableStringify(normalized), 'utf8'))
    record.crashBinding = Object.freeze(normalized)
    record.pendingRootCorrectionRotation = null
    record.adoptedFromCrash = false
    return record.crashBinding
  }

  rebindAdoptedContinuation(lease, binding = {}) {
    let record
    if (this._issuedLeases.has(lease)) record = this._recordForLease(lease)
    else if (this._issuedRootAccountingLeases.has(lease)) record = this._rootRecordForLease(lease)
    else throw this._error('CRASH_ADOPTION_CONFLICT', 'only a scheduler-adopted live lease can bind a replacement owned process')
    const prior = record.crashBinding
    if (record.adoptedFromCrash !== true || !prior || !prior.continuationId ||
        binding.priorBindingHash !== prior.bindingHash || !nonEmpty(binding.reservationId) ||
        !nonEmpty(binding.sessionId) || binding.continuationId !== prior.continuationId) {
      throw this._error('CRASH_ADOPTION_CONFLICT', 'replacement process must bind the exact adopted continuation and prior crash binding')
    }
    const normalized = {
      schemaVersion: 1,
      reservationId: binding.reservationId.trim(),
      sessionId: binding.sessionId.trim(),
      continuationId: binding.continuationId.trim(),
      frontier: normalizeCrashFrontier(binding.frontier || prior.frontier),
    }
    if (stableStringify(normalized.frontier) !== stableStringify(prior.frontier)) {
      throw this._error('CRASH_ADOPTION_CONFLICT', 'replacement process cannot change the adopted recovery frontier')
    }
    normalized.bindingHash = sha256(Buffer.from(stableStringify(normalized), 'utf8'))
    record.crashBinding = Object.freeze(normalized)
    record.adoptedFromCrash = false
    return record.crashBinding
  }

  exportCrashCheckpoint(options = {}) {
    if (!nonEmpty(options.ownerSessionId)) {
      throw this._error('CRASH_BINDING_INVALID', 'scheduler crash checkpoint requires the physical owner session')
    }
    if (this._queue.length > 0) {
      throw this._error('LIVE_STATE_NOT_CHECKPOINTABLE', 'queued work must settle before a crash checkpoint')
    }
    const liveRecords = [...this._live.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => {
        if (!record.crashBinding) {
          throw this._error('CRASH_BINDING_REQUIRED', `live lease ${record.id} lacks its reservation/session/frontier binding`)
        }
        return {
          id: record.id,
          workItemId: record.workItemId,
          role: record.role,
          logicalRole: record.logicalRole || null,
          purpose: record.purpose || null,
          caller: record.caller,
          providerCapabilities: record.providerCapabilities,
          equivalenceKey: record.equivalenceKey,
          progressFingerprint: record.progressFingerprint || null,
          depth: record.depth,
          lane: record.lane,
          parentLeaseId: record.parentLease ? record.parentLease.id : null,
          resources: record.resources,
          budgetClass: record.budgetClass,
          estimate: { ...record.estimate },
          remainingEstimate: { ...record.remainingEstimate },
          reported: { ...record.reported },
          hasReports: record.hasReports === true,
          usageFieldsSeen: [...record.usageFieldsSeen].sort(),
          attempt: record.attempt,
          budgetExhaustion: record.budgetExhaustion || null,
          crashBinding: record.crashBinding,
        }
      })
    let rootAccountingRecord = null
    if (this._rootDecisionAccounting.status === 'live') {
      const root = this._rootDecisionAccounting
      if (liveRecords.length > 0 || !root.crashBinding) {
        throw this._error('CRASH_BINDING_REQUIRED', 'live root accounting must be the sole model session and have a continuation binding')
      }
      rootAccountingRecord = {
        id: root.id,
        phase: root.phase,
        sessionId: root.sessionId,
        reported: { ...root.reported },
        usageFieldsSeen: [...root.usageFieldsSeen].sort(),
        budgetExhaustion: root.budgetExhaustion || null,
        crashBinding: root.crashBinding,
      }
    }
    const checkpoint = {
      schemaVersion: 1,
      kind: 'scheduler-crash-checkpoint',
      runIdentity: this.runIdentity,
      ownerSessionId: options.ownerSessionId.trim(),
      schedulerState: this._exportStateUnchecked(),
      reserved: cloneUsageGroups(this._reserved),
      liveRecords,
      rootAccountingRecord,
      stateHash: '0'.repeat(64),
    }
    checkpoint.stateHash = schedulerCrashStateHash(checkpoint)
    return deepFreeze(checkpoint)
  }

  adoptCrashCheckpoint(checkpoint, options = {}) {
    if (this._live.size || this._queue.length || this._sequence !== 0 || this._metrics.totalLaunches !== 0) {
      throw this._error('CRASH_ADOPTION_CONFLICT', 'crash checkpoint requires a fresh scheduler instance')
    }
    if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.kind !== 'scheduler-crash-checkpoint' ||
        checkpoint.stateHash !== schedulerCrashStateHash(checkpoint)) {
      throw this._error('CRASH_CHECKPOINT_INVALID', 'scheduler crash checkpoint is missing, unsupported, or tampered')
    }
    const priorIdentity = checkpoint.runIdentity || {}
    if (priorIdentity.runId !== this.runIdentity.runId ||
        Number(priorIdentity.generation) + 1 !== this.runIdentity.generation) {
      throw this._error('RUN_GENERATION_MISMATCH', 'scheduler crash checkpoint is not the exact preceding run generation')
    }
    const recovery = options.recoveryContext
    if (!recovery || !recovery.priorOwner || recovery.priorOwner.processesDrained !== true ||
        !nonEmpty(recovery.priorOwner.ownerId) || !Array.isArray(recovery.frontier && recovery.frontier.acceptedResultIds) ||
        !recovery.frontier.acceptedResultIds.includes(checkpoint.stateHash)) {
      throw this._error('CRASH_OWNER_UNVERIFIED', 'scheduler adoption requires canonical stale-owner drain evidence and frontier binding')
    }
    if (options.ownerSessionId !== undefined && checkpoint.ownerSessionId !== options.ownerSessionId) {
      throw this._error('CRASH_OWNER_MISMATCH', 'scheduler checkpoint owner session differs from the adopted physical owner')
    }
    const savedState = checkpoint.schedulerState
    if (!savedState || savedState.runIdentity.runId !== priorIdentity.runId ||
        savedState.runIdentity.generation !== priorIdentity.generation) {
      throw this._error('CRASH_CHECKPOINT_INVALID', 'saved scheduler state has a foreign run identity')
    }
    const replacementRootContextId = this._rootContextId
    if (!nonEmpty(savedState.rootContextId) || savedState.rootContexts !== 1) {
      throw this._error(
        'CRASH_ROOT_CONTEXT_INVALID',
        'crash adoption requires exactly one accounted predecessor root context',
      )
    }
    const restoredState = {
      ...savedState,
      runIdentity: this.runIdentity,
    }
    this._restore(restoredState, { allowLiveRootAccounting: true })
    if (this._rootContextId !== savedState.rootContextId || this._rootContexts !== 1) {
      throw this._error(
        'CRASH_ROOT_CONTEXT_INVALID',
        'crash adoption did not retain the single accounted predecessor root context',
      )
    }
    const adopted = new Map()
    const records = Array.isArray(checkpoint.liveRecords) ? checkpoint.liveRecords : []
    for (const saved of [...records].sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id))) {
      if (!/^launch-[0-9]{6}$/.test(saved.id || '') || !nonEmpty(saved.workItemId) || !nonEmpty(saved.role) ||
          !nonEmpty(saved.equivalenceKey) || !Number.isInteger(saved.depth) || saved.depth < 1 ||
          !Object.hasOwn(this.settings.lanes, saved.lane) || !Number.isInteger(saved.attempt) || saved.attempt < 1 ||
          this._attempts.get(saved.equivalenceKey) !== saved.attempt) {
        throw this._error('CRASH_CHECKPOINT_INVALID', 'saved live scheduler lease identity or attempt is invalid')
      }
      if (!Object.hasOwn(this._reserved, saved.budgetClass) ||
          !saved.caller || !nonEmpty(saved.caller.role) || !nonEmpty(saved.caller.sessionId)) {
        throw this._error('CRASH_CHECKPOINT_INVALID', 'saved live scheduler budget class or physical caller binding is invalid')
      }
      let providerCapabilities
      try { providerCapabilities = validateProviderCapabilities(saved.providerCapabilities) } catch (error) {
        throw this._error('CRASH_CHECKPOINT_INVALID', 'saved live scheduler provider capabilities are invalid', {
          cause: error.code || error.message,
        })
      }
      const parentLease = saved.parentLeaseId === null ? null : adopted.get(saved.parentLeaseId)
      if ((saved.parentLeaseId !== null && !parentLease) || (parentLease && parentLease.depth + 1 !== saved.depth)) {
        throw this._error('CRASH_CHECKPOINT_INVALID', 'saved live scheduler parent/depth binding is invalid')
      }
      const resources = normalizeResources(saved.resources)
      const crashBinding = this._validateSavedCrashBinding(saved.crashBinding)
      const record = {
        id: saved.id,
        workItemId: saved.workItemId,
        role: saved.role,
        logicalRole: saved.logicalRole,
        purpose: saved.purpose,
        caller: saved.caller,
        providerCapabilities,
        equivalenceKey: saved.equivalenceKey,
        progressFingerprint: saved.progressFingerprint,
        depth: saved.depth,
        lane: saved.lane,
        parentLease,
        resources,
        budgetClass: saved.budgetClass,
        estimate: normalizeUsageDelta(saved.estimate),
        remainingEstimate: normalizeUsageDelta(saved.remainingEstimate),
        reported: normalizeUsageDelta(saved.reported),
        hasReports: saved.hasReports === true,
        usageFieldsSeen: new Set(saved.usageFieldsSeen || []),
        attempt: saved.attempt,
        budgetExhaustion: saved.budgetExhaustion || null,
        crashBinding,
        adoptedFromCrash: true,
      }
      if ([...record.usageFieldsSeen].some((field) => !ACCOUNTING_DIMENSIONS.includes(field))) {
        throw this._error('CRASH_CHECKPOINT_INVALID', 'saved live scheduler usage fields are invalid')
      }
      this._live.set(record.id, record)
      this._claimResources(record)
      addUsage(this._reserved[record.budgetClass], record.remainingEstimate)
      this._laneCounters[record.lane].live++
      addUsage(this._laneCounters[record.lane].reserved, record.remainingEstimate)
      const lease = new SchedulerLease(this, record)
      this._issuedLeases.add(lease)
      adopted.set(record.id, lease)
    }
    let rootAccountingLease = null
    if (checkpoint.rootAccountingRecord !== null && checkpoint.rootAccountingRecord !== undefined) {
      const savedRoot = checkpoint.rootAccountingRecord
      const restoredRoot = this._rootDecisionAccounting
      const crashBinding = this._validateSavedCrashBinding(savedRoot.crashBinding)
      if (records.length > 0 || restoredRoot.status !== 'live' || savedRoot.id !== 'root-route-decision' ||
          savedRoot.phase !== 'routeDecision' || savedRoot.sessionId !== restoredRoot.sessionId ||
          stableStringify(savedRoot.reported) !== stableStringify(restoredRoot.reported) ||
          stableStringify(savedRoot.usageFieldsSeen) !== stableStringify([...restoredRoot.usageFieldsSeen].sort()) ||
          stableStringify(savedRoot.budgetExhaustion || null) !== stableStringify(restoredRoot.budgetExhaustion || null)) {
        throw this._error('CRASH_CHECKPOINT_INVALID', 'saved root-accounting session does not match the scheduler state')
      }
      restoredRoot.crashBinding = crashBinding
      restoredRoot.adoptedFromCrash = true
      rootAccountingLease = new RootAccountingLease(this, restoredRoot)
      this._issuedRootAccountingLeases.add(rootAccountingLease)
    } else if (this._rootDecisionAccounting.status === 'live') {
      throw this._error('CRASH_CHECKPOINT_INVALID', 'live root scheduler state lacks its recoverable session record')
    }
    if (stableStringify(this._reserved) !== stableStringify(checkpoint.reserved) ||
        Object.keys(this._laneCounters).some((lane) =>
          stableStringify(this._laneCounters[lane].reserved) !==
            stableStringify(checkpoint.schedulerState.laneCounters[lane].reserved) ||
          this._laneCounters[lane].live !== checkpoint.schedulerState.laneCounters[lane].live)) {
      throw this._error('CRASH_CHECKPOINT_INVALID', 'saved live reservations or lane ownership do not balance')
    }
    const predecessorRootContextId = this._rootContextId
    this._rootContextId = replacementRootContextId
    this._rootContexts += 1
    this._rootContextAdoption = Object.freeze({
      activeRootContextId: replacementRootContextId,
      predecessorRootContextId,
      generation: this.runIdentity.generation,
    })
    return Object.freeze({
      stateHash: checkpoint.stateHash,
      leases: Object.freeze(Object.fromEntries([...adopted.entries()])),
      rootAccountingLease,
      rootContext: Object.freeze({
        mainContexts: this._rootContexts,
        retainedRootContextId: predecessorRootContextId,
        activeRootContextId: this._rootContextId,
      }),
      counters: this.getMetrics().counters,
    })
  }

  _validateSavedCrashBinding(binding) {
    if (!binding || binding.schemaVersion !== 1 || !nonEmpty(binding.reservationId) || !nonEmpty(binding.sessionId) ||
        !(binding.continuationId === null || nonEmpty(binding.continuationId)) ||
        binding.bindingHash !== sha256(Buffer.from(stableStringify({ ...binding, bindingHash: undefined }), 'utf8'))) {
      // JSON omits the undefined bindingHash above, matching bindCrashContinuation's pre-hash object.
      throw this._error('CRASH_BINDING_INVALID', 'saved live continuation binding is invalid')
    }
    normalizeCrashFrontier(binding.frontier)
    return Object.freeze({ ...binding, frontier: normalizeCrashFrontier(binding.frontier) })
  }

  exportState() {
    if (this._live.size > 0 || this._queue.length > 0 || this._rootDecisionAccounting.status === 'live') {
      throw this._error('LIVE_STATE_NOT_EXPORTABLE', 'drain child and root-accounting sessions before exporting scheduler state')
    }
    return this._exportStateUnchecked()
  }

  _exportStateUnchecked() {
    return {
      schemaVersion: 1,
      route: this.route,
      routeSource: this.routeSource,
      runIdentity: this.runIdentity,
      totalLaunches: this._metrics.totalLaunches,
      sequence: this._sequence,
      attempts: Object.fromEntries([...this._attempts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      equivalenceLanes: Object.fromEntries([...this._equivalenceLanes.entries()].sort(([a], [b]) => a.localeCompare(b))),
      progressFingerprints: Object.fromEntries([...this._progressFingerprints.entries()].sort(([a], [b]) => a.localeCompare(b))),
      optionalBoundaryOwners: Object.fromEntries([...this._optionalBoundaryOwners.entries()].sort(([a], [b]) => a.localeCompare(b))),
      laneCounters: cloneLaneCounters(this._laneCounters),
      settings: this.settings,
      usage: cloneUsageGroups(this._usage),
      metrics: { ...this._metrics, rejectedByCode: { ...this._metrics.rejectedByCode } },
      startedAt: this._startedAt,
      lastProgressAt: this._lastProgressAt,
      lastProgressKind: this._lastProgressKind,
      rootContextId: this._rootContextId,
      rootContexts: this._rootContexts,
      rootContextAdoption: this._rootContextAdoption ? { ...this._rootContextAdoption } : null,
      rootDecisionAccounting: {
        status: this._rootDecisionAccounting.status,
        sessionId: this._rootDecisionAccounting.sessionId,
        reported: { ...this._rootDecisionAccounting.reported },
        usageFieldsSeen: [...this._rootDecisionAccounting.usageFieldsSeen].sort(),
        budgetExhaustion: this._rootDecisionAccounting.budgetExhaustion,
        errorCode: this._rootDecisionAccounting.errorCode || null,
        crashBinding: this._rootDecisionAccounting.crashBinding || null,
      },
      admissionComponents: { ...this._admissionComponents },
      terminalResult: this._terminalResult ? { ...this._terminalResult } : null,
      roadmapAskMeasurement: this._roadmapAskMeasurement ? { ...this._roadmapAskMeasurement } : null,
      firstProductSignal: this._firstProductSignal ? { ...this._firstProductSignal } : null,
      topologyCounts: this._topologyCounts ? {
        frozenSnapshot: { ...this._topologyCounts.frozenSnapshot },
        livePartial: { ...this._topologyCounts.livePartial },
      } : null,
      caches: {
        harnessAttestations: [...this._caches.harnessAttestations.values()].sort((a, b) => a.key.localeCompare(b.key)),
        proofs: [...this._caches.proofs.values()].sort((a, b) => a.key.localeCompare(b.key)),
      },
    }
  }

  _normalizeRequest(request) {
    if (!request || typeof request !== 'object') {
      throw this._error('INVALID_REQUEST', 'launch request must be an object')
    }
    const workItemId = request.workItemId || request.id
    if (!nonEmpty(workItemId)) throw this._error('INVALID_REQUEST', 'workItemId is required')
    if (!nonEmpty(request.role)) throw this._error('INVALID_REQUEST', 'physical child role is required')
    const authority = request._authority
    if (!this._issuedAuthorities.has(authority) || !this._admittingAuthorities.has(authority) ||
        authority.runId !== this.runIdentity.runId ||
        authority.generation !== this.runIdentity.generation) {
      throw this._error('INVALID_LAUNCH_AUTHORITY', 'model launch is not bound to this run/generation')
    }
    if (Object.hasOwn(request, 'depth')) {
      throw this._error('CALLER_DEPTH_FORBIDDEN', 'depth is derived from a scheduler-issued parent lease')
    }
    const parentLease = request._parentLease || null
    let parentRecord = null
    if (parentLease !== null) {
      if (!this._issuedLeases.has(parentLease)) {
        throw this._error('INVALID_PARENT_LEASE', 'parent lease was not issued by this scheduler')
      }
      parentRecord = this._live.get(parentLease.id)
      if (!parentRecord) throw this._error('PARENT_LEASE_RELEASED', 'parent lease is no longer live')
    }
    const depth = parentRecord ? parentRecord.depth + 1 : 1
    const laneNames = Object.keys(this.settings.lanes)
    const lane = nonEmpty(request.lane)
      ? request.lane.trim()
      : parentRecord ? parentRecord.lane : laneNames.length === 1 ? laneNames[0] : null
    if (!lane) throw this._error('LANE_REQUIRED', 'a named lane is required when multiple lanes are configured')
    if (!Object.hasOwn(this.settings.lanes, lane)) {
      throw this._error('UNKNOWN_LANE', `lane is not present in resolved settings: ${lane}`)
    }
    const equivalenceKey = nonEmpty(request.equivalenceKey)
      ? request.equivalenceKey.trim()
      : (nonEmpty(request.retryOf) ? request.retryOf.trim() : workItemId.trim())
    return {
      ...request,
      workItemId: workItemId.trim(),
      role: request.role.trim(),
      caller: Object.freeze({ role: authority.callerRole, sessionId: authority.sessionId }),
      providerCapabilities: authority.providerCapabilities,
      equivalenceKey,
      progressFingerprint: progressFingerprintFor(request),
      depth,
      lane,
      parentLease,
      resources: normalizeResources(request.resources),
      marginalValueRequired: requiresMarginalValue(request),
      budgetClass: budgetClass(request),
      estimate: normalizeEstimate(request.estimate, request.valueCase),
      signal: request.signal || null,
    }
  }

  _validateBeforeQueue(request) {
    this._assertAdmissionOpen()
    if (request.signal && request.signal.aborted) {
      throw this._error('ADMISSION_CANCELLED', 'launch was cancelled')
    }
    if (this.route === PENDING_ROUTE) {
      if (request.lane !== 'routeAnalyst' || request.role !== 'ap-route-analyst' || request.parentLease) {
        throw this._error('PENDING_ADMISSION_ROLE', 'pending child admission permits exactly one root route analyst; L0 uses root accounting')
      }
    }
    if (request.depth > this.budget.maxDepth) {
      throw this._error('DEPTH_LIMIT', 'route depth ceiling exceeded', {
        requested: request.depth,
        limit: this.budget.maxDepth,
      })
    }
    if (this._metrics.totalLaunches >= this.budget.maxChildLaunches) {
      throw this._error('LAUNCH_LIMIT', 'activation child-launch ceiling exhausted', {
        used: this._metrics.totalLaunches,
        limit: this.budget.maxChildLaunches,
      })
    }
    const laneState = this._laneCounters[request.lane]
    const laneLimit = this.settings.lanes[request.lane]
    if (laneState.launches >= laneLimit.maxLaunches) {
      throw this._error('LANE_LAUNCH_LIMIT', `lane child-launch ceiling exhausted: ${request.lane}`)
    }
    const boundLane = this._equivalenceLanes.get(request.equivalenceKey)
    if (boundLane && boundLane !== request.lane) {
      throw this._error('RETRY_LANE_MISMATCH', 'equivalent work cannot evade a lane counter', {
        equivalenceKey: request.equivalenceKey, expectedLane: boundLane, receivedLane: request.lane,
      })
    }
    if ([...this._live.values()].some((item) => item.workItemId === request.workItemId) ||
        this._queue.some((item) => item.request.workItemId === request.workItemId)) {
      throw this._error('DUPLICATE_WORK_ITEM', `work item is already live or queued: ${request.workItemId}`)
    }
    if (request.marginalValueRequired) {
      this._metrics.optionalEvaluated++
      request.marginalValue = evaluateMarginalValue(request.valueCase)
      if (!request.marginalValue.admitted) {
        this._metrics.optionalRejected++
        throw this._error(request.marginalValue.code, 'optional work lacks positive, separate marginal value', request.marginalValue)
      }
      request.marginalBoundary = String(request.valueCase.disjointBoundary || request.valueCase.boundary)
        .normalize('NFKC').trim().toLowerCase()
      const owner = this._optionalBoundaryOwners.get(request.marginalBoundary)
      if (owner && owner !== request.equivalenceKey) {
        this._metrics.optionalRejected++
        throw this._error('OPTIONAL_BOUNDARY_DUPLICATE', 'optional work must cover a named boundary not already admitted', {
          boundary: request.marginalBoundary,
          owner,
        })
      }
    }
    this._assertBudget(request)
    if (request.marginalValueRequired) {
      this._optionalBoundaryOwners.set(request.marginalBoundary, request.equivalenceKey)
    }
  }

  _tryStart(request) {
    this._assertAdmissionOpen()
    if (this._live.size + 1 >= (this._safeSequentialTransport ? 2 : this.budget.maxLiveIncludingRoot)) return null
    if (this._laneCounters[request.lane].live >= this.settings.lanes[request.lane].maxLive) return null
    this._assertParentLive(request)
    if ([...this._live.values()].some((item) => item.equivalenceKey === request.equivalenceKey)) return null
    if (this._hasResourceConflict(request.resources)) return null
    this._assertCanAttempt(request)
    this._assertBudget(request)
    return this._start(request)
  }

  _assertCanAttempt(request) {
    const prior = this._attempts.get(request.equivalenceKey) || 0
    const nextAttempt = prior + 1
    if (request.attempt !== undefined && Number(request.attempt) !== nextAttempt) {
      throw this._error('INVALID_ATTEMPT', 'attempt number must continue the equivalent work item', {
        expected: nextAttempt,
        received: request.attempt,
      })
    }
    if (prior > 0) {
      if (!request.progressFingerprint) {
        throw this._error('RETRY_PROGRESS_EVIDENCE_REQUIRED', 'retry admission requires a candidate/evidence/strategy fingerprint', {
          equivalenceKey: request.equivalenceKey, priorAttempts: prior,
        })
      }
      const previous = this._progressFingerprints.get(request.equivalenceKey)
      if (previous && previous === request.progressFingerprint) {
        this._metrics.retryReassessments++
        throw this._error('RETRY_REASSESSMENT_REQUIRED', 'identical retry fingerprint requires strategy reassessment before another launch', {
          equivalenceKey: request.equivalenceKey, fingerprint: previous, priorAttempts: prior,
        })
      }
    }
  }

  _assertParentLive(request) {
    if (!request.parentLease) return
    if (!this._issuedLeases.has(request.parentLease) || !this._live.has(request.parentLease.id)) {
      throw this._error('PARENT_LEASE_RELEASED', 'queued child cannot start after its parent lease released')
    }
  }

  _start(request) {
    if (this._metrics.totalLaunches >= this.budget.maxChildLaunches) {
      throw this._error('LAUNCH_LIMIT', 'activation child-launch ceiling exhausted')
    }
    if (this._laneCounters[request.lane].launches >= this.settings.lanes[request.lane].maxLaunches) {
      throw this._error('LANE_LAUNCH_LIMIT', `lane child-launch ceiling exhausted: ${request.lane}`)
    }
    const attempt = (this._attempts.get(request.equivalenceKey) || 0) + 1
    this._attempts.set(request.equivalenceKey, attempt)
    this._equivalenceLanes.set(request.equivalenceKey, request.lane)
    if (request.progressFingerprint) this._progressFingerprints.set(request.equivalenceKey, request.progressFingerprint)
    this._sequence++
    const id = `launch-${String(this._sequence).padStart(6, '0')}`
    const record = {
      ...request,
      id,
      attempt,
      reported: emptyUsage(),
      remainingEstimate: { ...request.estimate },
      hasReports: false,
      usageFieldsSeen: new Set(),
    }
    this._live.set(id, record)
    this._claimResources(record)
    addUsage(this._reserved[record.budgetClass], record.estimate)
    this._laneCounters[record.lane].launches++
    this._laneCounters[record.lane].live++
    addUsage(this._laneCounters[record.lane].reserved, record.estimate)

    this._metrics.admitted++
    this._metrics.totalLaunches++
    if (attempt > 1) this._metrics.retriesStarted++
    if (request.marginalValueRequired) this._metrics.optionalAdmitted++
    this._metrics.maxDepthObserved = Math.max(this._metrics.maxDepthObserved, request.depth)
    this._metrics.peakLiveIncludingRoot = Math.max(this._metrics.peakLiveIncludingRoot, this._live.size + 1)
    const lease = new SchedulerLease(this, record)
    this._issuedLeases.add(lease)
    return lease
  }

  _recordForLease(lease) {
    if (!this._issuedLeases.has(lease)) {
      throw this._recordRejection(this._error('INVALID_LEASE', 'usage requires a scheduler-issued lease'))
    }
    const record = this._live.get(lease.id)
    if (!record) throw this._recordRejection(this._error('LEASE_RELEASED', 'lease is no longer live'))
    return record
  }

  _continuedUsageVerdict(record, delta, afterAccounting) {
    const combined = totalUsage(this._usage)
    const reserved = totalUsage(this._reserved)
    const laneState = this._laneCounters[record.lane]
    const projected = emptyUsage()
    const laneProjected = emptyUsage()
    addUsage(projected, combined)
    addUsage(projected, reserved)
    addUsage(laneProjected, laneState.usage)
    addUsage(laneProjected, laneState.reserved)
    if (!afterAccounting) {
      for (const dimension of ACCOUNTING_DIMENSIONS) {
        const excess = Math.max(0, delta[dimension] - record.remainingEstimate[dimension])
        projected[dimension] += excess
        laneProjected[dimension] += excess
      }
    }
    const routeValues = {
      noncachedInput: projected.noncachedInput,
      cachedInput: projected.cachedInput,
      output: projected.output + projected.reasoning,
    }
    const laneValues = {
      noncachedInput: laneProjected.noncachedInput,
      cachedInput: laneProjected.cachedInput,
      output: laneProjected.output + laneProjected.reasoning,
    }
    const hardCeilings = []
    const at = []
    for (const dimension of TOKEN_DIMENSIONS) {
      if (routeValues[dimension] > this.budget.tokens[dimension]) hardCeilings.push(`route:${dimension}`)
      if (laneValues[dimension] > this.settings.lanes[record.lane].tokens[dimension]) {
        hardCeilings.push(`lane:${record.lane}:${dimension}`)
      }
      if (routeValues[dimension] >= this.budget.tokens[dimension] ||
          laneValues[dimension] >= this.settings.lanes[record.lane].tokens[dimension]) at.push(dimension)
    }
    if (this._totalWorkMs !== null) {
      if (projected.workMs > this._totalWorkMs) hardCeilings.push('route:workMs')
      if (projected.workMs >= this._totalWorkMs) at.push('workMs')
    }
    const optionalStops = []
    if (record.marginalValueRequired) {
      const optionalFraction = Math.min(
        OPTIONAL_STOP_FRACTION,
        1 - VERIFICATION_RESERVE - RECOVERY_RESERVE,
      )
      for (const dimension of TOKEN_DIMENSIONS) {
        if (routeValues[dimension] >= this.budget.tokens[dimension] * optionalFraction) {
          optionalStops.push(`route:${dimension}`)
        }
      }
      if (this._totalWorkMs !== null && projected.workMs >= this._totalWorkMs * optionalFraction) {
        optionalStops.push('route:workMs')
      }
    }
    const allowed = hardCeilings.length === 0 && optionalStops.length === 0
    return {
      allowed,
      atCeiling: at.length > 0,
      code: hardCeilings.length > 0
        ? 'HARD_USAGE_CEILING'
        : optionalStops.length > 0 ? 'OPTIONAL_USAGE_STOP' : 'USAGE_ALLOWED',
      hardCeilings,
      optionalStops,
    }
  }

  _accountStreamDelta(record, delta, fields = new Set()) {
    for (const field of fields) record.usageFieldsSeen.add(field)
    for (const dimension of ACCOUNTING_DIMENSIONS) {
      const covered = Math.min(delta[dimension], record.remainingEstimate[dimension])
      if (covered > 0) {
        this._reserved[record.budgetClass][dimension] -= covered
        this._laneCounters[record.lane].reserved[dimension] -= covered
        record.remainingEstimate[dimension] -= covered
      }
    }
    addUsage(this._usage[record.budgetClass], delta)
    addUsage(this._laneCounters[record.lane].usage, delta)
    addUsage(record.reported, delta)
    record.hasReports = true
  }

  _release(id, outcome, actualUsage, error) {
    const record = this._live.get(id)
    if (!record) return false
    const finalFields = reportedFields(actualUsage)
    try {
      if (finalFields.size > 0) {
        // Preserve every valid category the provider did report. Missing
        // categories are rejected below; they are never manufactured as zero.
        const cumulative = normalizeUsageDelta(actualUsage)
        const delta = emptyUsage()
        for (const dimension of ACCOUNTING_DIMENSIONS) {
          if (!finalFields.has(dimension)) continue
          if (cumulative[dimension] < record.reported[dimension]) {
            throw this._error('USAGE_REGRESSION', `final ${dimension} usage is below streamed usage`)
          }
          delta[dimension] = cumulative[dimension] - record.reported[dimension]
        }
        const before = this._continuedUsageVerdict(record, delta, false)
        this._accountStreamDelta(record, delta, finalFields)
        const after = this._continuedUsageVerdict(record, emptyUsage(), true)
        const hardCeilings = [...new Set([...before.hardCeilings, ...after.hardCeilings])].sort()
        if (hardCeilings.length > 0) {
          record.budgetExhaustion = Object.freeze({ code: 'BUDGET_EXHAUSTED', hardCeilings })
        }
      }
    } catch (usageError) {
      if (!['INCOMPLETE_USAGE_REPORT', 'INVALID_USAGE_REPORT', 'USAGE_REGRESSION'].includes(usageError.code)) throw usageError
      this._metrics.invalidAccounting++
      this._finalizeRecord(record, 'failed', usageError)
      throw this._error('INCOMPLETE_USAGE_ACCOUNTING', 'terminal usage is invalid or incomplete; lease was released without fabricating categories', {
        cause: usageError.code,
      })
    }
    const missing = MODEL_USAGE_FIELDS.filter((field) => !record.usageFieldsSeen.has(field))
    if (missing.length > 0) {
      this._metrics.invalidAccounting++
      this._finalizeRecord(record, 'failed')
      throw this._error('INCOMPLETE_USAGE_ACCOUNTING', 'final model usage must cover every token class; lease was released without fabricating categories', { missing })
    }
    const budgetExhausted = Boolean(record.budgetExhaustion)
    const finalOutcome = outcome === 'completed' && budgetExhausted ? 'failed' : outcome
    this._finalizeRecord(record, finalOutcome, error)
    if (outcome === 'completed' && budgetExhausted) {
      throw this._error('BUDGET_EXHAUSTED', 'lease usage exhausted a hard route, lane, or session ceiling', {
        hardCeilings: record.budgetExhaustion.hardCeilings,
        leaseId: id,
        workItemId: record.workItemId,
      })
    }
    return true
  }

  _finalizeRecord(record, outcome, error) {
    this._live.delete(record.id)
    this._releaseResources(record)
    addUsage(this._reserved[record.budgetClass], record.remainingEstimate, -1)
    addUsage(this._laneCounters[record.lane].reserved, record.remainingEstimate, -1)
    this._laneCounters[record.lane].live--
    this._metrics[outcome]++
    if (this._absoluteBudgetExceeded()) this._metrics.budgetOverruns++
    if (error && ['NO_PROGRESS', 'RETRY_REASSESSMENT_REQUIRED'].includes(error.code)) this._lastProgressKind = 'failed-no-progress'
    this._drain()
  }

  _drain() {
    if (this._disposed || this._queue.length === 0) return
    let index = 0
    let madeProgress = false
    while (index < this._queue.length && this._live.size + 1 < (this._safeSequentialTransport ? 2 : this.budget.maxLiveIncludingRoot)) {
      const item = this._queue[index]
      if (item.request.signal && item.request.signal.aborted) {
        this._queue.splice(index, 1)
        this._removeAbortHandler(item)
        item.reject(this._recordRejection(this._error('ADMISSION_CANCELLED', 'queued launch was cancelled')))
        continue
      }
      if (this._hasResourceConflict(item.request.resources)) {
        index++
        continue
      }
      if (this._laneCounters[item.request.lane].live >= this.settings.lanes[item.request.lane].maxLive) {
        index++
        continue
      }
      if ([...this._live.values()].some((live) => live.equivalenceKey === item.request.equivalenceKey)) {
        index++
        continue
      }
      try {
        this._assertAdmissionOpen()
        this._assertParentLive(item.request)
        this._assertCanAttempt(item.request)
        this._assertBudget(item.request)
        const lease = this._start(item.request)
        this._queue.splice(index, 1)
        this._removeAbortHandler(item)
        this._metrics.dequeued++
        item.resolve(lease)
        madeProgress = true
      } catch (error) {
        this._queue.splice(index, 1)
        this._removeAbortHandler(item)
        item.reject(this._recordRejection(error))
      }
    }
    // Releasing several disjoint resources can make a later queue entry ready
    // even when an earlier entry remains blocked.  One additional scan is enough
    // because every admission only consumes capacity.
    if (madeProgress && index > 0 && this._live.size + 1 < (this._safeSequentialTransport ? 2 : this.budget.maxLiveIncludingRoot)) this._drain()
  }

  _hasResourceConflict(resources) {
    for (const owner of this._live.values()) {
      for (const requested of resources) {
        if (owner.resources.some(held => schedulerResourcesConflict(requested, held))) return true
      }
    }
    return false
  }

  _claimResources(record) {
    for (const resource of record.resources) {
      const owners = this._resourceOwners.get(resource.key) || new Set()
      owners.add(record.id)
      this._resourceOwners.set(resource.key, owners)
    }
  }

  _releaseResources(record) {
    for (const resource of record.resources) {
      const owners = this._resourceOwners.get(resource.key)
      if (!owners) continue
      owners.delete(record.id)
      if (owners.size === 0) this._resourceOwners.delete(resource.key)
    }
  }

  _assertBudget(request) {
    const combined = emptyUsage()
    const nonVerification = emptyUsage()
    for (const group of Object.keys(this._usage)) {
      addUsage(combined, this._usage[group])
      addUsage(combined, this._reserved[group])
      if (!['verification', 'recovery'].includes(group)) {
        addUsage(nonVerification, this._usage[group])
        addUsage(nonVerification, this._reserved[group])
      }
    }
    addUsage(combined, request.estimate)
    if (!['verification', 'recovery'].includes(request.budgetClass)) addUsage(nonVerification, request.estimate)

    for (const dimension of TOKEN_DIMENSIONS) {
      const limit = this.budget.tokens[dimension]
      const totalProjected = dimension === 'output'
        ? combined.output + combined.reasoning
        : combined[dimension]
      if (totalProjected > limit) {
        throw this._error('TOKEN_BUDGET', `${dimension} token ceiling would be exceeded`, {
          dimension, projected: totalProjected, limit,
        })
      }
      let fraction = 1
      let projected = totalProjected
      if (request.budgetClass === 'optional') {
        fraction = Math.min(OPTIONAL_STOP_FRACTION, 1 - VERIFICATION_RESERVE - RECOVERY_RESERVE)
      } else if (request.budgetClass === 'planning') {
        fraction = 1 - VERIFICATION_RESERVE - RECOVERY_RESERVE
        projected = dimension === 'output'
          ? nonVerification.output + nonVerification.reasoning
          : nonVerification[dimension]
      } else if (request.budgetClass === 'work') {
        fraction = 1 - VERIFICATION_RESERVE - RECOVERY_RESERVE
        projected = dimension === 'output'
          ? nonVerification.output + nonVerification.reasoning
          : nonVerification[dimension]
      } else if (request.budgetClass === 'verification') fraction = 1 - RECOVERY_RESERVE
      if (projected > limit * fraction) {
        throw this._error('BUDGET_RESERVE', `${request.budgetClass} admission would consume a protected reserve`, {
          dimension, projected, allowed: limit * fraction,
          verificationReserve: VERIFICATION_RESERVE,
          recoveryReserve: RECOVERY_RESERVE,
        })
      }
    }

    const laneState = this._laneCounters[request.lane]
    const laneLimit = this.settings.lanes[request.lane]
    const laneProjected = emptyUsage()
    addUsage(laneProjected, laneState.usage)
    addUsage(laneProjected, laneState.reserved)
    addUsage(laneProjected, request.estimate)
    for (const dimension of TOKEN_DIMENSIONS) {
      const projected = dimension === 'output'
        ? laneProjected.output + laneProjected.reasoning
        : laneProjected[dimension]
      if (projected > laneLimit.tokens[dimension]) {
        throw this._error('LANE_TOKEN_BUDGET', `${request.lane} lane ${dimension} ceiling would be exceeded`, {
          lane: request.lane, dimension, projected, limit: laneLimit.tokens[dimension],
        })
      }
    }

    if (this._totalWorkMs !== null) {
      if (combined.workMs > this._totalWorkMs) {
        throw this._error('WORK_TIME_BUDGET', 'work-time ceiling would be exceeded')
      }
      const fraction = request.budgetClass === 'optional'
        ? Math.min(OPTIONAL_STOP_FRACTION, 1 - VERIFICATION_RESERVE - RECOVERY_RESERVE)
        : request.budgetClass === 'planning'
          ? 1 - VERIFICATION_RESERVE - RECOVERY_RESERVE
          : request.budgetClass === 'work'
            ? 1 - VERIFICATION_RESERVE - RECOVERY_RESERVE
            : request.budgetClass === 'verification'
              ? 1 - RECOVERY_RESERVE
              : 1
      const projected = ['planning', 'work'].includes(request.budgetClass)
        ? nonVerification.workMs
        : combined.workMs
      if (projected > this._totalWorkMs * fraction) {
        throw this._error('BUDGET_RESERVE', `${request.budgetClass} admission would consume protected work time`)
      }
    }
  }

  _absoluteBudgetExceeded() {
    const combined = emptyUsage()
    for (const usage of Object.values(this._usage)) addUsage(combined, usage)
    return combined.noncachedInput > this.budget.tokens.noncachedInput ||
      combined.cachedInput > this.budget.tokens.cachedInput ||
      combined.output + combined.reasoning > this.budget.tokens.output ||
      (this._totalWorkMs !== null && combined.workMs > this._totalWorkMs)
  }

  _assertUsageWithinSettings(settings) {
    const usage = totalUsage(this._usage)
    const failures = []
    if (this._metrics.totalLaunches > settings.budget.maxChildLaunches) failures.push('launches')
    if (this._metrics.maxDepthObserved > settings.budget.maxDepth) failures.push('depth')
    if (usage.noncachedInput > settings.budget.tokens.noncachedInput) failures.push('noncachedInput')
    if (usage.cachedInput > settings.budget.tokens.cachedInput) failures.push('cachedInput')
    if (usage.output + usage.reasoning > settings.budget.tokens.output) failures.push('output')
    if (this._totalWorkMs !== null && usage.workMs > this._totalWorkMs) failures.push('workMs')
    for (const [lane, counter] of Object.entries(this._laneCounters)) {
      const limit = settings.lanes[lane]
      if (!limit) continue
      if (counter.launches > limit.maxLaunches) failures.push(`lane:${lane}:launches`)
      if (counter.usage.noncachedInput > limit.tokens.noncachedInput) failures.push(`lane:${lane}:noncachedInput`)
      if (counter.usage.cachedInput > limit.tokens.cachedInput) failures.push(`lane:${lane}:cachedInput`)
      if (counter.usage.output + counter.usage.reasoning > limit.tokens.output) failures.push(`lane:${lane}:output`)
    }
    if (failures.length > 0) {
      throw this._error('ROUTE_FREEZE_BUDGET_EXCEEDED', 'pre-route usage cannot fit the resolved route settings', { failures })
    }
  }

  _removeAbortHandler(item) {
    if (item.abortHandler && item.request.signal) {
      item.request.signal.removeEventListener('abort', item.abortHandler)
    }
  }

  _recordRejection(error) {
    const normalized = error instanceof SchedulerAdmissionError
      ? error
      : this._error('ADMISSION_FAILED', error && error.message ? error.message : String(error))
    this._metrics.rejectedByCode[normalized.code] = (this._metrics.rejectedByCode[normalized.code] || 0) + 1
    return normalized
  }

  _error(code, message, details) {
    return new SchedulerAdmissionError(code, message, details)
  }

  _restore(state, options = {}) {
    if (!state || state.schemaVersion !== 1 || state.route !== this.route || state.routeSource !== this.routeSource) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved scheduler state is incompatible')
    }
    if (state.runIdentity && stableStringify(state.runIdentity) !== stableStringify(this.runIdentity)) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved state belongs to a different run generation')
    }
    if (state.settings && stableStringify(state.settings) !== stableStringify(this.settings)) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved route/lane settings do not match resolved settings')
    }
    this._sequence = positiveInteger(state.sequence, 0)
    this._attempts = new Map(Object.entries(state.attempts || {}).map(([key, value]) => [key, Number(value)]))
    this._equivalenceLanes = new Map(Object.entries(state.equivalenceLanes || {}))
    this._progressFingerprints = new Map(Object.entries(state.progressFingerprints || {}))
    this._optionalBoundaryOwners = new Map(Object.entries(state.optionalBoundaryOwners || {}))
    if ([...this._optionalBoundaryOwners.entries()].some(([boundary, owner]) => !nonEmpty(boundary) || !nonEmpty(owner))) {
      throw this._error('INVALID_SCHEDULER_STATE', 'saved optional marginal-value boundaries are invalid')
    }
    for (const group of Object.keys(this._usage)) {
      this._usage[group] = { ...emptyUsage(), ...((state.usage || {})[group] || {}) }
    }
    this._metrics = {
      ...this._metrics,
      ...(state.metrics || {}),
      rejectedByCode: { ...((state.metrics || {}).rejectedByCode || {}) },
    }
    this._metrics.totalLaunches = finiteNonNegative(state.totalLaunches, this._metrics.totalLaunches)
    this._startedAt = finiteNonNegative(state.startedAt, this._startedAt)
    this._lastProgressAt = finiteNonNegative(state.lastProgressAt, this._startedAt)
    this._lastProgressKind = state.lastProgressKind || 'activation'
    this._rootContextId = state.rootContextId || this._rootContextId
    this._rootContexts = positiveInteger(state.rootContexts, 1)
    this._rootContextAdoption = state.rootContextAdoption
      ? Object.freeze({ ...state.rootContextAdoption })
      : null
    if (state.roadmapAskMeasurement !== undefined && state.roadmapAskMeasurement !== null) {
      if (this.route !== 'ROADMAP') {
        throw this._error('INVALID_SCHEDULER_STATE', 'non-ROADMAP state contains a roadmap ask measurement')
      }
      const savedMeasurement = state.roadmapAskMeasurement
      const expectedRatio = Number(savedMeasurement.roadmapAskCount) / Number(savedMeasurement.userAskCount)
      if (!Number.isSafeInteger(savedMeasurement.roadmapAskCount) || savedMeasurement.roadmapAskCount < 1 ||
          !Number.isSafeInteger(savedMeasurement.userAskCount) || savedMeasurement.userAskCount < 1 ||
          savedMeasurement.roadmapAskToUserAskRatio !== expectedRatio ||
          !/^[a-f0-9]{64}$/.test(savedMeasurement.missionScopeHash || '') ||
          !/^[a-f0-9]{64}$/.test(savedMeasurement.planSha256 || '') ||
          savedMeasurement.askCeiling !== savedMeasurement.roadmapAskCount ||
          (savedMeasurement.roadmapAskCount > savedMeasurement.userAskCount &&
            !validRoadmapExpansionAdmission(savedMeasurement.expansionAdmission, {
              admittedAskCount: savedMeasurement.roadmapAskCount - savedMeasurement.userAskCount,
              missionScopeHash: savedMeasurement.missionScopeHash,
              planSha256: savedMeasurement.planSha256,
            }))) {
        throw this._error('INVALID_SCHEDULER_STATE', 'saved roadmap ask measurement is invalid')
      }
      this._roadmapAskMeasurement = Object.freeze({ ...savedMeasurement })
    }
    if (state.rootDecisionAccounting) {
      const savedRoot = state.rootDecisionAccounting
      const allowedRootStatuses = options.allowLiveRootAccounting === true
        ? ['not-started', 'live', 'completed', 'failed']
        : ['not-started', 'completed', 'failed']
      if (!allowedRootStatuses.includes(savedRoot.status) ||
          (savedRoot.status !== 'not-started' && !nonEmpty(savedRoot.sessionId))) {
        throw this._error('INVALID_SCHEDULER_STATE', 'saved root-accounting state is invalid or live')
      }
      const seen = new Set(Array.isArray(savedRoot.usageFieldsSeen) ? savedRoot.usageFieldsSeen : [])
      if ([...seen].some((field) => !ACCOUNTING_DIMENSIONS.includes(field))) {
        throw this._error('INVALID_SCHEDULER_STATE', 'saved root-accounting fields are invalid')
      }
      this._rootDecisionAccounting = {
        status: savedRoot.status,
        id: 'root-route-decision',
        phase: 'routeDecision',
        sessionId: savedRoot.sessionId || null,
        reported: { ...emptyUsage(), ...(savedRoot.reported || {}) },
        usageFieldsSeen: seen,
        budgetExhaustion: savedRoot.budgetExhaustion || null,
        errorCode: savedRoot.errorCode || null,
        crashBinding: savedRoot.crashBinding || null,
      }
    }
    this._admissionComponents = {
      ...this._admissionComponents,
      ...(state.admissionComponents || {}),
    }
    this._terminalResult = state.terminalResult ? { ...state.terminalResult } : null
    if (state.firstProductSignal) this.recordFirstProductSignal(state.firstProductSignal)
    if (state.topologyCounts) this.recordTopologyCounts(state.topologyCounts)
    const caches = state.caches || {}
    for (const cacheName of ['harnessAttestations', 'proofs']) {
      const records = caches[cacheName] || []
      if (!Array.isArray(records)) throw this._error('INVALID_SCHEDULER_STATE', `saved ${cacheName} cache must be an array`)
      for (const record of records) this._restoreCacheRecord(cacheName, record)
    }
    for (const lane of Object.keys(this._laneCounters)) {
      const saved = state.laneCounters && state.laneCounters[lane]
      if (!saved) continue
      this._laneCounters[lane] = {
        launches: nonNegativeInteger(saved.launches, 0),
        live: 0,
        usage: { ...emptyUsage(), ...(saved.usage || {}) },
        reserved: emptyUsage(),
      }
    }
  }
}

function cloneUsageGroups(groups) {
  const out = {}
  for (const key of Object.keys(groups).sort()) out[key] = { ...groups[key] }
  return out
}

function totalUsage(groups) {
  const total = emptyUsage()
  for (const usage of Object.values(groups)) addUsage(total, usage)
  return total
}

function cloneLaneCounters(lanes) {
  const out = {}
  for (const lane of Object.keys(lanes).sort()) {
    out[lane] = {
      launches: lanes[lane].launches,
      live: lanes[lane].live,
      usage: { ...lanes[lane].usage },
      reserved: { ...lanes[lane].reserved },
    }
  }
  return out
}

module.exports = {
  CentralScheduler,
  Scheduler: CentralScheduler,
  createScheduler: (options) => new CentralScheduler(options),
  SchedulerAdmissionError,
  SchedulerLease,
  RootAccountingLease,
  ROUTE_BUDGETS,
  PENDING_ROUTE,
  PENDING_ROUTE_SETTINGS,
  TOKEN_DIMENSIONS,
  ACCOUNTING_DIMENSIONS,
  MODEL_USAGE_FIELDS,
  ADMISSION_COMPONENT_CEILINGS_MS,
  VERIFICATION_RESERVE,
  RECOVERY_RESERVE,
  OPTIONAL_STOP_FRACTION,
  RETRY_POLICY,
  PHASE_BUDGET_CONTRACT,
  resolveRouteBudget,
  resolveSchedulerSettings,
  validateResolvedSchedulerSettings,
  phaseBudgetVerdict,
  bindRoadmapExpansionAdmission,
  evaluateMarginalValue,
  requiresMarginalValue,
  normalizeResources,
}
