#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')

// Reasoning strength is an assignment property, not a topology property.  This
// module intentionally never reads the DIRECT/LIGHT/ROADMAP route when scoring.

const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const MECHANICAL_ROLES = new Set([
  'scribe', 'janitor', 'finalizer', 'formatter', 'ledger-writer', 'record-writer',
  'cleanup', 'mechanical',
])
const DEEP_ROLES = new Set([
  'security', 'security-reviewer', 'cryptography', 'formal-proof', 'algorithm',
  'root-cause', 'depth-prober',
])
const DISTINCT_CHECK_RISKS = Object.freeze([
  'security', 'authorization', 'privacy', 'destructive', 'concurrency',
  'destructive-change', 'external-effect', 'external-change', 'visual',
  'visual-behavior', 'broad-regression',
])

class EffortPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'EffortPolicyError'
    this.code = code
    this.details = details
  }
}

function normalizeEffort(value) {
  const effort = String(value || '').toLowerCase()
  if (!EFFORTS.includes(effort)) {
    throw new EffortPolicyError('INVALID_EFFORT', `unsupported reasoning effort: ${value || '<empty>'}`)
  }
  return effort
}

function normalizeLevel(value) {
  if (typeof value === 'number') return Math.max(0, Math.min(3, Math.round(value)))
  switch (String(value || '').toLowerCase()) {
    case 'none':
    case 'routine':
    case 'low': return 0
    case 'ordinary':
    case 'moderate':
    case 'medium': return 1
    case 'difficult':
    case 'high': return 2
    case 'critical':
    case 'exceptional':
    case 'extreme': return 3
    default: return 1
  }
}

function explicitPins(input) {
  const pin = input.explicitPin || input.userPin || {}
  if (typeof pin === 'string') return { effort: pin, model: null }
  return {
    effort: input.effortPin || pin.effort || null,
    model: input.modelPin || pin.model || null,
  }
}

function selectEffort(input = {}) {
  const pins = explicitPins(input)
  if (pins.effort) {
    return Object.freeze({
      effort: normalizeEffort(pins.effort),
      model: pins.model || null,
      pinned: true,
      routeIndependent: true,
      reasons: ['explicit user effort pin'],
    })
  }

  const role = String(input.role || 'worker').toLowerCase()
  const difficulty = normalizeLevel(input.difficulty)
  const risk = normalizeLevel(input.risk)
  let index = 1 // medium is the ordinary useful-work baseline
  const reasons = []

  if (MECHANICAL_ROLES.has(role)) {
    index = 0
    reasons.push('mechanical or deterministic role')
  } else if (DEEP_ROLES.has(role)) {
    index = 2
    reasons.push('role requires deep specialist reasoning')
  } else {
    reasons.push('ordinary role baseline')
  }

  if (difficulty >= 3 || risk >= 3) {
    index = Math.max(index, 3)
    reasons.push(difficulty >= 3 ? 'exceptional task difficulty' : 'critical task risk')
  } else if (difficulty >= 2 || risk >= 2) {
    index = Math.max(index, 2)
    reasons.push(difficulty >= 2 ? 'high task difficulty' : 'high task risk')
  }

  // Empirical role yield may raise the floor, but only when the caller provides
  // measured success by effort and a required success level.  Price/latency are
  // handled during model selection, not by pretending a route is a proxy.
  const yieldByEffort = input.measuredYield && input.measuredYield.byEffort
  const minimumYield = Number(input.measuredYield && input.measuredYield.minimumSuccess)
  if (yieldByEffort && Number.isFinite(minimumYield)) {
    const firstPassing = EFFORTS.findIndex((effort) => Number(yieldByEffort[effort]) >= minimumYield)
    if (firstPassing !== -1 && firstPassing > index) {
      index = firstPassing
      reasons.push('measured role yield requires a stronger effort')
    }
  }

  return Object.freeze({
    effort: EFFORTS[index],
    model: pins.model || null,
    pinned: Boolean(pins.model),
    routeIndependent: true,
    reasons,
  })
}

function modelId(model) {
  return model && (model.id || model.model || model.name)
}

function supportsEffort(model, effort) {
  if (!model) return false
  const efforts = model.efforts || model.supportedEfforts
  return !Array.isArray(efforts) || efforts.includes(effort)
}

function supportsCapabilities(model, required) {
  const capabilities = model.capabilities || {}
  return required.every((name) => capabilities[name] === true ||
    (Array.isArray(capabilities) && capabilities.includes(name)))
}

function verifiedMetadata(model) {
  const verification = model && model.verification
  return Boolean(model && (model.verified === true || (
    verification && verification.price === true && verification.latency === true &&
    verification.capabilities === true && verification.yield === true
  )))
}

function validateModelMetadata(model) {
  const reasons = []
  const id = modelId(model)
  if (!id) reasons.push('id')
  if (!verifiedMetadata(model)) reasons.push('verified metadata')
  const efforts = model && (model.efforts || model.supportedEfforts)
  if (!Array.isArray(efforts) || efforts.length === 0 || efforts.some((effort) => !EFFORTS.includes(effort))) {
    reasons.push('supported efforts')
  }
  const capabilities = model && model.capabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities) ||
      Object.keys(capabilities).length === 0 || Object.values(capabilities).some((value) => typeof value !== 'boolean')) {
    reasons.push('boolean capability registry')
  }
  const price = (model && (model.price || model.pricing)) || {}
  const perTokens = Number(price.perTokens)
  const noncachedInput = Number(price.noncachedInput ?? price.input)
  const cachedInput = Number(price.cachedInput ?? price.cached)
  const output = Number(price.output)
  if (!(perTokens > 0) || !(noncachedInput > 0) || !(cachedInput > 0) || !(output > 0) ||
      ![perTokens, noncachedInput, cachedInput, output].every(Number.isFinite)) reasons.push('positive complete pricing')
  const latency = Number((model && model.latency && model.latency.p50Ms) ?? (model && model.latencyP50Ms))
  const latencySamples = Number((model && model.latency && model.latency.sampleSize) ?? (model && model.latencySampleSize))
  if (!(latency > 0) || !Number.isFinite(latency) || !(latencySamples > 0) || !Number.isFinite(latencySamples)) {
    reasons.push('measured p50 latency and sample size')
  }
  const measuredSuccess = Number((model && model.yield && model.yield.successRate) ?? (model && model.measuredSuccess))
  const yieldSamples = Number((model && model.yield && model.yield.sampleSize) ?? (model && model.yieldSampleSize))
  if (!(measuredSuccess > 0 && measuredSuccess <= 1) || !Number.isFinite(measuredSuccess) ||
      !(yieldSamples > 0) || !Number.isFinite(yieldSamples)) reasons.push('measured yield and sample size')
  return {
    valid: reasons.length === 0,
    reasons,
    normalized: {
      id,
      efforts,
      capabilities,
      price: { perTokens, noncachedInput, cachedInput, output },
      latencyP50Ms: latency,
      measuredSuccess,
    },
  }
}

function registryReceiptPayload(registry) {
  return {
    schemaVersion: registry.schemaVersion,
    issuer: registry.issuer,
    observedAt: registry.observedAt,
    expiresAt: registry.expiresAt,
    evidenceSha256: registry.evidenceSha256,
    entries: registry.entries,
  }
}

function registryBindingSha256(registry) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(registryReceiptPayload(registry)))
    .digest('hex')
}

function validateReceiptBoundRegistry(registry, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now())
  const observedAtMs = registry && Date.parse(registry.observedAt)
  const expiresAtMs = registry && Date.parse(registry.expiresAt)
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) ||
      registry.schemaVersion !== 'codex-model-registry.v1' ||
      typeof registry.issuer !== 'string' || !registry.issuer.trim() ||
      !Number.isFinite(observedAtMs) || !Number.isFinite(expiresAtMs) || observedAtMs >= expiresAtMs ||
      !Number.isFinite(nowMs) || nowMs >= expiresAtMs ||
      !/^[a-f0-9]{64}$/.test(registry.evidenceSha256 || '') ||
      !Array.isArray(registry.entries) || registry.entries.length === 0 ||
      registry.entries.some(entry => !validateModelMetadata(entry).valid) ||
      registry.bindingSha256 !== registryBindingSha256(registry)) {
    throw new EffortPolicyError(
      'MODEL_REGISTRY_RECEIPT_INVALID',
      'model registry requires fresh measurement evidence and an exact receipt binding over every economic entry',
    )
  }
  return Object.freeze({
    entries: Object.freeze(registry.entries.map(entry => Object.freeze({ ...entry }))),
    receiptSha256: registry.bindingSha256,
  })
}

function sealReceiptBoundRegistry(input) {
  const unsigned = { ...input }
  delete unsigned.bindingSha256
  return Object.freeze({ ...unsigned, bindingSha256: registryBindingSha256(unsigned) })
}

function expectedPrice(model, workload = {}) {
  const validation = validateModelMetadata(model)
  if (!validation.valid) {
    throw new EffortPolicyError('MODEL_METADATA_INVALID', 'model lacks complete verified economic metadata', {
      model: modelId(model), reasons: validation.reasons,
    })
  }
  const values = ['noncachedInput', 'cachedInput', 'output', 'reasoning'].map((field) => Number(workload[field] ?? 0))
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new EffortPolicyError('INVALID_WORKLOAD', 'workload token counts must be finite and non-negative')
  }
  const [noncached, cached, output, reasoning] = values
  const price = validation.normalized.price
  return ((noncached / price.perTokens) * price.noncachedInput) +
    ((cached / price.perTokens) * price.cachedInput) +
    (((output + reasoning) / price.perTokens) * price.output)
}

function selectModelAssignment(input = {}) {
  const effortDecision = selectEffort(input)
  const receipt = input.registry && !Array.isArray(input.registry)
    ? validateReceiptBoundRegistry(input.registry, { nowMs: input.nowMs })
    : null
  const registry = receipt ? receipt.entries : Array.isArray(input.registry) ? input.registry : []
  if (registry.length === 0) {
    throw new EffortPolicyError('MODEL_REGISTRY_REQUIRED', 'model assignment requires a verified registry')
  }

  const requiredCapabilities = Array.isArray(input.requiredCapabilities)
    ? [...new Set(input.requiredCapabilities.map(String))].sort()
    : []
  const maximumLatency = Number.isFinite(Number(input.maximumLatencyP50Ms))
    ? Number(input.maximumLatencyP50Ms)
    : Infinity
  const minimumSuccess = Number.isFinite(Number(input.minimumMeasuredSuccess))
    ? Number(input.minimumMeasuredSuccess)
    : 0
  const validations = new Map(registry.map((model) => [model, validateModelMetadata(model)]))
  let candidates = registry.filter((model) =>
    validations.get(model).valid &&
    supportsEffort(model, effortDecision.effort) &&
    supportsCapabilities(model, requiredCapabilities) &&
    validations.get(model).normalized.latencyP50Ms <= maximumLatency &&
    validations.get(model).normalized.measuredSuccess >= minimumSuccess,
  )

  if (effortDecision.model) {
    const pinned = registry.find((model) => modelId(model) === effortDecision.model)
    if (!pinned) {
      throw new EffortPolicyError('PINNED_MODEL_UNKNOWN', `pinned model is not in the registry: ${effortDecision.model}`)
    }
    if (!validations.get(pinned).valid) {
      throw new EffortPolicyError('PINNED_MODEL_METADATA_INVALID', 'pinned model lacks complete verified metadata', {
        model: effortDecision.model, reasons: validations.get(pinned).reasons,
      })
    }
    if (!candidates.includes(pinned)) {
      throw new EffortPolicyError('PINNED_MODEL_UNSUPPORTED', 'pinned model cannot satisfy the assignment', {
        model: effortDecision.model,
        effort: effortDecision.effort,
        requiredCapabilities,
      })
    }
    candidates = [pinned]
  }

  if (candidates.length === 0) {
    throw new EffortPolicyError('NO_ADMISSIBLE_MODEL', 'no registered model satisfies effort, capability, yield, and latency requirements', {
      effort: effortDecision.effort,
      requiredCapabilities,
      maximumLatency,
      minimumSuccess,
      invalidMetadata: registry.filter((model) => !validations.get(model).valid).map((model) => ({
        model: modelId(model) || null, reasons: validations.get(model).reasons,
      })),
    })
  }

  const ranked = candidates.map((model) => ({
    model,
    id: modelId(model),
    expectedPrice: expectedPrice(model, input.workload),
    latencyP50Ms: validations.get(model).normalized.latencyP50Ms,
    measuredSuccess: validations.get(model).normalized.measuredSuccess,
  })).sort((a, b) =>
    a.expectedPrice - b.expectedPrice ||
    a.latencyP50Ms - b.latencyP50Ms ||
    b.measuredSuccess - a.measuredSuccess ||
    a.id.localeCompare(b.id),
  )
  const chosen = ranked[0]
  return Object.freeze({
    ...effortDecision,
    model: chosen.id,
    expectedPrice: chosen.expectedPrice,
    latencyP50Ms: chosen.latencyP50Ms,
    measuredSuccess: chosen.measuredSuccess,
    registryMatched: true,
    registryReceiptSha256: receipt ? receipt.receiptSha256 : null,
    consideredModels: ranked.map((item) => item.id),
  })
}

function truthyNames(input, names) {
  return names.filter((name) => Boolean(input[name]))
}

/** Implements the section 3.14 one-vs-two L4 decision matrix. */
function decideCheckerPlan(input = {}) {
  const riskAliases = {
    destructive: 'destructive-change',
    'external-effect': 'external-change',
    visual: 'visual-behavior',
  }
  const namedRisks = Array.isArray(input.risks)
    ? input.risks.map((risk) => String(risk).toLowerCase().replace(/_/g, '-'))
      .map((risk) => riskAliases[risk] || risk)
    : []
  const matrixReasons = []

  if (input.bounded === false) matrixReasons.push('result is not bounded')
  if (Number(input.toolchains || 1) > 1) matrixReasons.push('multiple toolchains')
  if (input.distinctAccess) matrixReasons.push('review and runtime checks require distinct access')
  if (input.distinctExpertise) matrixReasons.push('review and runtime checks require distinct expertise')
  if (input.runtimeSeparate || input.distinctRuntime) matrixReasons.push('runtime checking is a separate responsibility')
  if (input.cannotCombine) matrixReasons.push('one checker cannot independently perform both jobs')
  if (typeof input.highRiskBoundary === 'string' && input.highRiskBoundary.trim()) {
    matrixReasons.push(`${input.highRiskBoundary.trim()} is a named high-risk boundary`)
  }

  const flagRisks = truthyNames(input, [
    'security', 'authorization', 'privacy', 'destructive', 'concurrency',
    'destructiveChange', 'externalEffects', 'externalEffect', 'externalChange',
    'visual', 'visualBehavior', 'broadRegression', 'regression',
  ]).map((name) => name === 'externalEffects'
    ? 'external-change'
    : (name === 'externalEffect' || name === 'externalChange') ? 'external-change'
      : (name === 'visual' || name === 'visualBehavior') ? 'visual-behavior'
        : (name === 'destructive' || name === 'destructiveChange') ? 'destructive-change'
          : (name === 'broadRegression' || name === 'regression') ? 'broad-regression' : name)
  const distinctRisks = [...new Set([...namedRisks, ...flagRisks])]
    .filter((risk) => DISTINCT_CHECK_RISKS.includes(risk))
    .sort()
  for (const risk of distinctRisks) matrixReasons.push(`${risk} boundary deserves a distinct attack`)

  if (matrixReasons.length === 0) {
    return Object.freeze({
      count: 1,
      launchable: true,
      combined: true,
      reasons: ['bounded single-toolchain work with no separate high-risk boundary'],
      responsibilities: ['combined requirements review and runtime testing'],
      secondResponsibility: null,
    })
  }

  const secondResponsibility = typeof input.secondResponsibility === 'string'
    ? input.secondResponsibility.trim()
    : ''
  const firstResponsibility = typeof input.firstResponsibility === 'string' && input.firstResponsibility.trim()
    ? input.firstResponsibility.trim()
    : 'static requirements and change review'
  const distinct = secondResponsibility.length > 0 &&
    secondResponsibility.toLowerCase() !== firstResponsibility.toLowerCase()
  return Object.freeze({
    count: 2,
    launchable: distinct,
    combined: false,
    reasons: matrixReasons,
    responsibilities: distinct ? [firstResponsibility, secondResponsibility] : [firstResponsibility],
    secondResponsibility: secondResponsibility || null,
    blocker: distinct ? null : 'SECOND_CHECKER_RESPONSIBILITY_REQUIRED',
  })
}

function assertCheckerPlan(input) {
  const plan = decideCheckerPlan(input)
  if (!plan.launchable) {
    throw new EffortPolicyError(
      'SECOND_CHECKER_RESPONSIBILITY_REQUIRED',
      'the second L4 checker must have a named, distinct responsibility before launch',
      { reasons: plan.reasons },
    )
  }
  return plan
}

module.exports = {
  EFFORTS,
  DISTINCT_CHECK_RISKS,
  EffortPolicyError,
  normalizeEffort,
  selectEffort,
  chooseEffort: selectEffort,
  selectModelAssignment,
  selectAssignment: selectModelAssignment,
  chooseModel: selectModelAssignment,
  expectedPrice,
  validateModelMetadata,
  registryBindingSha256,
  sealReceiptBoundRegistry,
  validateReceiptBoundRegistry,
  decideCheckerPlan,
  selectCheckerPlan: decideCheckerPlan,
  assertCheckerPlan,
}
