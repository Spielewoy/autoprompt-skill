'use strict'

const {
  digestRecord,
  exactKeys,
  fail,
  hashPattern,
  isoDate,
  nonEmpty,
  sha256,
} = require('./core.cjs')

const ROUTES = Object.freeze(['DIRECT', 'LIGHT', 'ROADMAP'])
const ROUTE_RANK = Object.freeze(Object.fromEntries(ROUTES.map((route, index) => [route, index])))
const DEFAULT_ERROR_COST_POLICY = Object.freeze({ underRoutingPerLevel: 2, overRoutingPerLevel: 1 })
const ACCOUNTING_FIELDS = Object.freeze([
  'sessionCount', 'callCount', 'durationMs', 'noncachedInput', 'cachedInput', 'output', 'reasoning', 'weightedCost',
])

function parseRows(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)
  const lines = text.trim().split(/\r?\n/u).filter(Boolean)
  let rows
  try { rows = lines.map(line => JSON.parse(line)) } catch (error) { fail('HOLDOUT_ROWS_INVALID', 'holdout JSONL is malformed', { cause: error.message }) }
  const ids = new Set()
  for (const [index, row] of rows.entries()) {
    exactKeys(row, ['id', 'labelSource', 'groupId', 'contrastGroupId', 'variantKind', 'expectedRoute', 'expectedReasons', 'overrides'], 'HOLDOUT_ROWS_INVALID', `holdout row ${index}`)
    for (const field of ['id', 'labelSource', 'groupId', 'variantKind', 'expectedRoute']) nonEmpty(row[field], 'HOLDOUT_ROWS_INVALID', `row ${index}.${field}`)
    if (ids.has(row.id)) fail('HOLDOUT_ROWS_INVALID', `duplicate holdout id: ${row.id}`)
    ids.add(row.id)
    if (!['canonical', 'paraphrase', 'counterexample'].includes(row.variantKind) || !ROUTES.includes(row.expectedRoute)) fail('HOLDOUT_ROWS_INVALID', `row ${row.id} has an invalid variant or route`)
    if (!Array.isArray(row.expectedReasons) || row.expectedReasons.length === 0 ||
        row.expectedReasons.some(reason => typeof reason !== 'string' || !reason.trim()) ||
        new Set(row.expectedReasons).size !== row.expectedReasons.length) {
      fail('HOLDOUT_ROWS_INVALID', `row ${row.id} expectedReasons must be a non-empty unique string array`)
    }
    if (row.contrastGroupId !== undefined && (typeof row.contrastGroupId !== 'string' || !row.contrastGroupId.trim())) fail('HOLDOUT_ROWS_INVALID', `row ${row.id} contrastGroupId must be a non-empty string when present`)
    if (!row.overrides || typeof row.overrides !== 'object' || Array.isArray(row.overrides)) fail('HOLDOUT_ROWS_INVALID', `row ${row.id} overrides must be an object`)
  }
  return rows
}

function validateProvenance(provenance, fixtureBytes) {
  exactKeys(provenance, ['schemaVersion', 'holdoutId', 'createdAt', 'sealedAt', 'purpose', 'developmentExamplesSeparated', 'fixture', 'labels', 'tuningFreeze'], 'HOLDOUT_PROVENANCE_INVALID', 'holdout provenance')
  if (provenance.schemaVersion !== 'benchmark-route-holdout.v1') fail('HOLDOUT_PROVENANCE_INVALID', 'unsupported holdout provenance schema')
  for (const field of ['holdoutId', 'purpose']) nonEmpty(provenance[field], 'HOLDOUT_PROVENANCE_INVALID', field)
  isoDate(provenance.createdAt, 'HOLDOUT_PROVENANCE_INVALID', 'createdAt')
  isoDate(provenance.sealedAt, 'HOLDOUT_PROVENANCE_INVALID', 'sealedAt')
  if (Date.parse(provenance.sealedAt) < Date.parse(provenance.createdAt)) fail('HOLDOUT_PROVENANCE_INVALID', 'sealedAt cannot precede createdAt')
  if (typeof provenance.developmentExamplesSeparated !== 'boolean') fail('HOLDOUT_PROVENANCE_INVALID', 'developmentExamplesSeparated must be boolean')
  exactKeys(provenance.fixture, ['relativePath', 'sha256', 'rowCount'], 'HOLDOUT_PROVENANCE_INVALID', 'fixture')
  nonEmpty(provenance.fixture.relativePath, 'HOLDOUT_PROVENANCE_INVALID', 'fixture.relativePath')
  if (!hashPattern(provenance.fixture.sha256) || !Number.isSafeInteger(provenance.fixture.rowCount) || provenance.fixture.rowCount < 1) fail('HOLDOUT_PROVENANCE_INVALID', 'fixture digest or row count is invalid')
  const rows = parseRows(fixtureBytes)
  if (sha256(fixtureBytes) !== provenance.fixture.sha256 || rows.length !== provenance.fixture.rowCount) fail('HOLDOUT_FIXTURE_MISMATCH', 'holdout bytes do not match sealed provenance')
  exactKeys(provenance.labels, ['sourceKind', 'independentlyHumanLabeled', 'raterCount', 'agreement', 'adjudicationEvidenceSha256'], 'HOLDOUT_PROVENANCE_INVALID', 'labels')
  if (!['synthetic-design-fixture', 'independent-human'].includes(provenance.labels.sourceKind)) fail('HOLDOUT_PROVENANCE_INVALID', 'labels.sourceKind is invalid')
  if (typeof provenance.labels.independentlyHumanLabeled !== 'boolean' || !Number.isSafeInteger(provenance.labels.raterCount) || provenance.labels.raterCount < 0) fail('HOLDOUT_PROVENANCE_INVALID', 'human label fields are invalid')
  if (provenance.labels.independentlyHumanLabeled !== (provenance.labels.sourceKind === 'independent-human')) fail('HOLDOUT_PROVENANCE_INVALID', 'human label claim conflicts with sourceKind')
  exactKeys(provenance.labels.agreement, ['metric', 'value', 'evidenceSha256'], 'HOLDOUT_PROVENANCE_INVALID', 'agreement')
  if (provenance.labels.agreement.metric !== null && !['cohen-kappa', 'fleiss-kappa', 'krippendorff-alpha'].includes(provenance.labels.agreement.metric)) fail('HOLDOUT_PROVENANCE_INVALID', 'agreement.metric is invalid')
  if (provenance.labels.agreement.value !== null && (typeof provenance.labels.agreement.value !== 'number' || !Number.isFinite(provenance.labels.agreement.value) || provenance.labels.agreement.value < -1 || provenance.labels.agreement.value > 1)) fail('HOLDOUT_PROVENANCE_INVALID', 'agreement.value must be null or within [-1,1]')
  for (const field of ['evidenceSha256']) if (provenance.labels.agreement[field] !== null && !hashPattern(provenance.labels.agreement[field])) fail('HOLDOUT_PROVENANCE_INVALID', `agreement.${field} must be null or sha256`)
  if (provenance.labels.adjudicationEvidenceSha256 !== null && !hashPattern(provenance.labels.adjudicationEvidenceSha256)) fail('HOLDOUT_PROVENANCE_INVALID', 'adjudicationEvidenceSha256 must be null or sha256')
  const agreementParts = [provenance.labels.agreement.metric, provenance.labels.agreement.value, provenance.labels.agreement.evidenceSha256]
  if (agreementParts.some(value => value === null) && agreementParts.some(value => value !== null)) fail('HOLDOUT_PROVENANCE_INVALID', 'agreement metric, value, and evidence must be present or null together')
  if (provenance.labels.sourceKind === 'independent-human' && (provenance.labels.raterCount < 2 || agreementParts.some(value => value === null) || provenance.labels.adjudicationEvidenceSha256 === null)) fail('HOLDOUT_PROVENANCE_INVALID', 'independent-human labels require two raters, agreement evidence, and adjudication evidence')
  if (provenance.labels.sourceKind === 'synthetic-design-fixture' && (provenance.labels.raterCount !== 0 || agreementParts.some(value => value !== null) || provenance.labels.adjudicationEvidenceSha256 !== null)) fail('HOLDOUT_PROVENANCE_INVALID', 'synthetic labels cannot carry human agreement or adjudication evidence')
  if (rows.some(row => row.labelSource !== provenance.labels.sourceKind)) fail('HOLDOUT_LABEL_SOURCE_MISMATCH', 'row labelSource differs from sealed provenance')
  exactKeys(provenance.tuningFreeze, ['frozenBeforePromptTuning', 'implementationFingerprint', 'evidenceSha256'], 'HOLDOUT_PROVENANCE_INVALID', 'tuningFreeze')
  if (typeof provenance.tuningFreeze.frozenBeforePromptTuning !== 'boolean') fail('HOLDOUT_PROVENANCE_INVALID', 'frozenBeforePromptTuning must be boolean')
  for (const field of ['implementationFingerprint', 'evidenceSha256']) if (provenance.tuningFreeze[field] !== null && !hashPattern(provenance.tuningFreeze[field])) fail('HOLDOUT_PROVENANCE_INVALID', `tuningFreeze.${field} must be null or sha256`)
  const freezeParts = [provenance.tuningFreeze.implementationFingerprint, provenance.tuningFreeze.evidenceSha256]
  if (provenance.tuningFreeze.frozenBeforePromptTuning !== freezeParts.every(value => value !== null)) fail('HOLDOUT_PROVENANCE_INVALID', 'tuning freeze claim requires both implementation and evidence digests')
  return { provenance, rows }
}

function assessRouteHoldoutReadiness(provenance, fixtureBytes) {
  const validated = validateProvenance(provenance, fixtureBytes)
  const blockers = []
  if (!provenance.developmentExamplesSeparated) blockers.push('DEVELOPMENT_EXAMPLES_NOT_SEPARATED')
  if (!provenance.labels.independentlyHumanLabeled) blockers.push('INDEPENDENT_HUMAN_LABELS_REQUIRED')
  if (provenance.labels.raterCount < 2) blockers.push('MULTIPLE_INDEPENDENT_RATERS_REQUIRED')
  if (provenance.labels.agreement.metric === null || provenance.labels.agreement.value === null || provenance.labels.agreement.evidenceSha256 === null) blockers.push('INTER_RATER_AGREEMENT_REQUIRED')
  if (provenance.labels.adjudicationEvidenceSha256 === null) blockers.push('ADJUDICATION_EVIDENCE_REQUIRED')
  if (!provenance.tuningFreeze.frozenBeforePromptTuning || provenance.tuningFreeze.implementationFingerprint === null || provenance.tuningFreeze.evidenceSha256 === null) blockers.push('PRE_TUNING_FREEZE_EVIDENCE_REQUIRED')
  return Object.freeze({
    schemaVersion: 'benchmark-route-holdout-readiness.v1',
    holdoutId: provenance.holdoutId,
    fixtureSha256: provenance.fixture.sha256,
    rowCount: validated.rows.length,
    readyForQualityClaims: blockers.length === 0,
    analysisClass: blockers.length === 0 ? 'sealed-independent-holdout' : 'development-mechanics-only',
    blockers,
  })
}

function requiredFields(value, fields, code, label) {
  exactKeys(value, fields, code, label)
  const missing = fields.filter(field => !Object.hasOwn(value, field))
  if (missing.length) fail(code, `${label} is missing required fields`, { missing })
}

function nonNegativeFinite(value, code, label, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (options.integer && !Number.isSafeInteger(value))) {
    fail(code, `${label} must be a non-negative${options.integer ? ' safe integer' : ' finite number'}`)
  }
  return value
}

function validateRoute(value, code, label) {
  if (!ROUTES.includes(value)) fail(code, `${label} must be DIRECT, LIGHT, or ROADMAP`)
  return value
}

function errorCostPolicy(input = DEFAULT_ERROR_COST_POLICY) {
  requiredFields(input, ['underRoutingPerLevel', 'overRoutingPerLevel'], 'HOLDOUT_ERROR_COST_POLICY_INVALID', 'route error cost policy')
  for (const field of ['underRoutingPerLevel', 'overRoutingPerLevel']) {
    if (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field] <= 0) fail('HOLDOUT_ERROR_COST_POLICY_INVALID', `${field} must be a positive finite number`)
  }
  return Object.freeze({ underRoutingPerLevel: input.underRoutingPerLevel, overRoutingPerLevel: input.overRoutingPerLevel })
}

function classifyRouteError(expectedRoute, predictedRoute, policy) {
  const delta = ROUTE_RANK[predictedRoute] - ROUTE_RANK[expectedRoute]
  const kind = delta === 0 ? 'correct' : delta < 0 ? 'under-routing' : 'over-routing'
  const levels = Math.abs(delta)
  const cost = levels * (delta < 0 ? policy.underRoutingPerLevel : policy.overRoutingPerLevel)
  return Object.freeze({ kind, levels, cost })
}

function scoreRoutePredictions(provenance, fixtureBytes, predictions, options = {}) {
  const readiness = assessRouteHoldoutReadiness(provenance, fixtureBytes)
  const rows = parseRows(fixtureBytes)
  if (!Array.isArray(predictions)) fail('HOLDOUT_PREDICTIONS_INVALID', 'route predictions must be an array')
  const byId = new Map()
  for (const [index, prediction] of predictions.entries()) {
    requiredFields(prediction, ['id', 'predictedRoute'], 'HOLDOUT_PREDICTIONS_INVALID', `route prediction ${index}`)
    nonEmpty(prediction.id, 'HOLDOUT_PREDICTIONS_INVALID', `route prediction ${index}.id`)
    validateRoute(prediction.predictedRoute, 'HOLDOUT_PREDICTIONS_INVALID', `route prediction ${prediction.id}.predictedRoute`)
    if (byId.has(prediction.id)) fail('HOLDOUT_PREDICTIONS_INVALID', `duplicate route prediction: ${prediction.id}`)
    byId.set(prediction.id, prediction.predictedRoute)
  }
  const rowIds = new Set(rows.map(row => row.id))
  const missing = rows.filter(row => !byId.has(row.id)).map(row => row.id)
  const unknown = [...byId.keys()].filter(id => !rowIds.has(id))
  if (missing.length || unknown.length) fail('HOLDOUT_PREDICTIONS_INVALID', 'predictions must cover the sealed holdout exactly once', { missing, unknown })
  const policy = errorCostPolicy(options.errorCostPolicy)
  const confusion = Object.fromEntries(ROUTES.map(expected => [expected, Object.fromEntries(ROUTES.map(predicted => [predicted, 0]))]))
  const scoredRows = rows.map(row => {
    const predictedRoute = byId.get(row.id)
    const error = classifyRouteError(row.expectedRoute, predictedRoute, policy)
    confusion[row.expectedRoute][predictedRoute] += 1
    return Object.freeze({ id: row.id, expectedRoute: row.expectedRoute, expectedReasons: [...row.expectedReasons], predictedRoute, ...error })
  })
  const count = kind => scoredRows.filter(row => row.kind === kind).length
  const cost = kind => scoredRows.filter(row => row.kind === kind).reduce((total, row) => total + row.cost, 0)
  const correct = count('correct')
  const record = {
    schemaVersion: 'benchmark-route-holdout-score.v1',
    holdoutId: provenance.holdoutId,
    fixtureSha256: provenance.fixture.sha256,
    analysisClass: readiness.analysisClass,
    qualityClaimEligible: readiness.readyForQualityClaims,
    blockers: [...readiness.blockers],
    errorCostPolicy: policy,
    summary: {
      total: scoredRows.length,
      correct,
      accuracy: scoredRows.length ? correct / scoredRows.length : 0,
      underRouting: { count: count('under-routing'), cost: cost('under-routing') },
      overRouting: { count: count('over-routing'), cost: cost('over-routing') },
      totalErrorCost: scoredRows.reduce((total, row) => total + row.cost, 0),
    },
    confusion,
    rows: scoredRows,
  }
  return Object.freeze({ ...record, checksum: digestRecord(record) })
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function accountingSummary(records) {
  const totals = Object.fromEntries(ACCOUNTING_FIELDS.map(field => [field, records.reduce((sum, record) => sum + record.accounting[field], 0)]))
  const distribution = fields => Object.fromEntries(fields.map(field => [field, {
    p50: percentile(records.map(record => record.accounting[field]), 0.50),
    p95: percentile(records.map(record => record.accounting[field]), 0.95),
  }]))
  return Object.freeze({ samples: records.length, totals, distribution: distribution(['durationMs', 'weightedCost']) })
}

function validateAccounting(accounting, label) {
  requiredFields(accounting, ACCOUNTING_FIELDS, 'HOLDOUT_ANALYST_ACCOUNTING_INVALID', label)
  for (const field of ACCOUNTING_FIELDS) nonNegativeFinite(accounting[field], 'HOLDOUT_ANALYST_ACCOUNTING_INVALID', `${label}.${field}`, { integer: field !== 'weightedCost' })
  if (accounting.sessionCount !== 1) fail('HOLDOUT_ANALYST_ACCOUNTING_INVALID', `${label}.sessionCount must be exactly one`)
  if (accounting.callCount < 1) fail('HOLDOUT_ANALYST_ACCOUNTING_INVALID', `${label}.callCount must be at least one`)
}

function validateTranscript(transcript, label) {
  requiredFields(transcript, ['sha256', 'bytes', 'consumedBytes', 'citedItemCount'], 'HOLDOUT_ANALYST_TRANSCRIPT_INVALID', label)
  if (!hashPattern(transcript.sha256)) fail('HOLDOUT_ANALYST_TRANSCRIPT_INVALID', `${label}.sha256 must be sha256`)
  for (const field of ['bytes', 'consumedBytes', 'citedItemCount']) nonNegativeFinite(transcript[field], 'HOLDOUT_ANALYST_TRANSCRIPT_INVALID', `${label}.${field}`, { integer: true })
  if (transcript.consumedBytes > transcript.bytes) fail('HOLDOUT_ANALYST_TRANSCRIPT_INVALID', `${label}.consumedBytes cannot exceed bytes`)
  if ((transcript.consumedBytes > 0) !== (transcript.citedItemCount > 0)) fail('HOLDOUT_ANALYST_TRANSCRIPT_INVALID', `${label} must bind consumed bytes to cited evidence items`)
}

function validateLimits(limits) {
  const fields = ['maxP50WeightedCost', 'maxP95WeightedCost', 'maxP50DurationMs', 'maxP95DurationMs']
  requiredFields(limits, fields, 'HOLDOUT_ANALYST_LIMITS_INVALID', 'route analyst limits')
  for (const field of fields) nonNegativeFinite(limits[field], 'HOLDOUT_ANALYST_LIMITS_INVALID', `route analyst limits.${field}`)
  if (limits.maxP50WeightedCost > limits.maxP95WeightedCost || limits.maxP50DurationMs > limits.maxP95DurationMs) fail('HOLDOUT_ANALYST_LIMITS_INVALID', 'p50 limits cannot exceed p95 limits')
  return Object.freeze({ ...limits })
}

function evaluateRouteAnalystAblation(provenance, fixtureBytes, observations, limits, options = {}) {
  const rows = parseRows(fixtureBytes)
  if (!Array.isArray(observations)) fail('HOLDOUT_ANALYST_OBSERVATIONS_INVALID', 'route analyst observations must be an array')
  const rowById = new Map(rows.map(row => [row.id, row]))
  const byId = new Map()
  for (const [index, observation] of observations.entries()) {
    requiredFields(observation, ['id', 'withoutAnalystRoute', 'withAnalystRoute', 'accounting', 'transcript'], 'HOLDOUT_ANALYST_OBSERVATIONS_INVALID', `route analyst observation ${index}`)
    nonEmpty(observation.id, 'HOLDOUT_ANALYST_OBSERVATIONS_INVALID', `route analyst observation ${index}.id`)
    if (!rowById.has(observation.id) || byId.has(observation.id)) fail('HOLDOUT_ANALYST_OBSERVATIONS_INVALID', `unknown or duplicate route analyst observation: ${observation.id}`)
    validateRoute(observation.withoutAnalystRoute, 'HOLDOUT_ANALYST_OBSERVATIONS_INVALID', `${observation.id}.withoutAnalystRoute`)
    validateRoute(observation.withAnalystRoute, 'HOLDOUT_ANALYST_OBSERVATIONS_INVALID', `${observation.id}.withAnalystRoute`)
    validateAccounting(observation.accounting, `${observation.id}.accounting`)
    validateTranscript(observation.transcript, `${observation.id}.transcript`)
    byId.set(observation.id, observation)
  }
  const missing = rows.filter(row => !byId.has(row.id)).map(row => row.id)
  if (missing.length) fail('HOLDOUT_ANALYST_OBSERVATIONS_INVALID', 'analyst observations must cover the sealed holdout exactly once', { missing })
  const ordered = rows.map(row => byId.get(row.id))
  const errorCost = options.errorCostPolicy
  const withoutAnalyst = scoreRoutePredictions(provenance, fixtureBytes, ordered.map(item => ({ id: item.id, predictedRoute: item.withoutAnalystRoute })), { errorCostPolicy: errorCost })
  const withAnalyst = scoreRoutePredictions(provenance, fixtureBytes, ordered.map(item => ({ id: item.id, predictedRoute: item.withAnalystRoute })), { errorCostPolicy: errorCost })
  const boundedLimits = validateLimits(limits)
  const withoutErrors = new Map(withoutAnalyst.rows.map(row => [row.id, row]))
  const withErrors = new Map(withAnalyst.rows.map(row => [row.id, row]))
  let corrected = 0
  let regressed = 0
  let decisionChanges = 0
  let netErrorCostAvoided = 0
  for (const observation of ordered) {
    const before = withoutErrors.get(observation.id)
    const after = withErrors.get(observation.id)
    if (observation.withoutAnalystRoute !== observation.withAnalystRoute) decisionChanges += 1
    if (before.cost > 0 && after.cost === 0) corrected += 1
    if (before.cost === 0 && after.cost > 0) regressed += 1
    netErrorCostAvoided += before.cost - after.cost
  }
  const accounting = accountingSummary(ordered)
  const byExpectedRoute = Object.fromEntries(ROUTES.map(route => [route, accountingSummary(ordered.filter(item => rowById.get(item.id).expectedRoute === route))]))
  const transcript = {
    bytes: ordered.reduce((sum, item) => sum + item.transcript.bytes, 0),
    consumedBytes: ordered.reduce((sum, item) => sum + item.transcript.consumedBytes, 0),
    citedItemCount: ordered.reduce((sum, item) => sum + item.transcript.citedItemCount, 0),
  }
  transcript.unusedBytes = transcript.bytes - transcript.consumedBytes
  transcript.consumptionRatio = transcript.bytes === 0 ? 0 : transcript.consumedBytes / transcript.bytes
  const costWithinLimits = accounting.distribution.weightedCost.p50 <= boundedLimits.maxP50WeightedCost &&
    accounting.distribution.weightedCost.p95 <= boundedLimits.maxP95WeightedCost &&
    accounting.distribution.durationMs.p50 <= boundedLimits.maxP50DurationMs &&
    accounting.distribution.durationMs.p95 <= boundedLimits.maxP95DurationMs
  const routeCoverageComplete = ROUTES.every(route => byExpectedRoute[route].samples > 0)
  const blockers = [...withAnalyst.blockers]
  if (!routeCoverageComplete) blockers.push('ROUTE_COVERAGE_INCOMPLETE')
  if (!costWithinLimits) blockers.push('ANALYST_COST_LIMIT_EXCEEDED')
  if (transcript.consumedBytes === 0) blockers.push('ANALYST_TRANSCRIPT_USE_NOT_OBSERVED')
  if (netErrorCostAvoided <= 0) blockers.push('ANALYST_VALUE_NOT_DEMONSTRATED')
  const record = {
    schemaVersion: 'benchmark-route-analyst-ablation.v1',
    holdoutId: provenance.holdoutId,
    fixtureSha256: provenance.fixture.sha256,
    analysisClass: withAnalyst.analysisClass,
    qualityClaimEligible: withAnalyst.qualityClaimEligible,
    releaseGateReady: blockers.length === 0,
    blockers,
    limits: boundedLimits,
    routeCoverageComplete,
    costWithinLimits,
    accounting,
    accountingByExpectedRoute: byExpectedRoute,
    transcript,
    value: {
      decisionChanges,
      errorsCorrected: corrected,
      errorsRegressed: regressed,
      netErrorCostAvoided,
      netErrorCostAvoidedPerWeightedCost: accounting.totals.weightedCost === 0 ? null : netErrorCostAvoided / accounting.totals.weightedCost,
    },
    withoutAnalyst,
    withAnalyst,
  }
  return Object.freeze({ ...record, checksum: digestRecord(record) })
}

module.exports = {
  DEFAULT_ERROR_COST_POLICY,
  assessRouteHoldoutReadiness,
  evaluateRouteAnalystAblation,
  parseRows,
  scoreRoutePredictions,
  validateProvenance,
}
