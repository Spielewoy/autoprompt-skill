#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const ROUTE_CONTRACT = require('../../contracts/routes.json')
const PROVIDER_CONTRACT = require('../../contracts/providers.json')

const ROUTES = Object.freeze(['DIRECT', 'LIGHT', 'ROADMAP'])
const ROUTE_ORDER = Object.freeze({ DIRECT: 0, LIGHT: 1, ROADMAP: 2 })
const ROUTE_FACTS_SCHEMA_VERSION = ROUTE_CONTRACT.contractVersion
const ROUTE_FACTS_SCHEMA = ROUTE_CONTRACT.routeFactsSchema
const REQUESTED_EFFECTS = Object.freeze(Object.keys(ROUTE_CONTRACT.effectAcceptance))
const PROBE_REASONS = Object.freeze([
  'debug-red',
  'behavior-characterization',
  'focused-route-fact',
])
const HASH_PATTERN = /^[a-f0-9]{64}$/u

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key)
}

function firstOwn(object, keys) {
  for (const key of keys) {
    if (own(object, key)) return object[key]
  }
  return undefined
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

const REPOSITORY_DESIGNATION_AUTHORITIES = Object.freeze(['system', 'operator', 'request'])

function repositoryAuthorityDesignationHash(designation = {}) {
  return fingerprint({
    schemaVersion: designation.schemaVersion,
    designatedBy: designation.designatedBy,
    repositoryPath: designation.repositoryPath,
    contentHash: designation.contentHash,
    purpose: designation.purpose,
  })
}

function resolveRepositoryInstructionAuthority(input = {}) {
  const artifact = isObject(input.artifact) ? input.artifact : {}
  const designation = isObject(input.designation) ? input.designation : null
  const untrusted = errors => Object.freeze({
    status: errors.length ? 'REPOSITORY_DESIGNATION_INVALID' : 'UNTRUSTED_REPOSITORY_DATA',
    authoritative: false,
    maySupplyRouteFacts: false,
    mayOverrideHigherInstructions: false,
    authorityScope: 'none',
    errors: Object.freeze(errors),
  })
  if (typeof artifact.repositoryPath !== 'string' || !artifact.repositoryPath ||
      !HASH_PATTERN.test(artifact.contentHash || '')) {
    return untrusted(['repository file requires an exact path and SHA-256 content hash'])
  }
  if (designation === null) return untrusted([])
  const errors = []
  if (designation.schemaVersion !== 1 ||
      !REPOSITORY_DESIGNATION_AUTHORITIES.includes(designation.designatedBy)) {
    errors.push('designation must come explicitly from system, operator, or request authority')
  }
  if (designation.repositoryPath !== artifact.repositoryPath || designation.contentHash !== artifact.contentHash) {
    errors.push('designation must bind the exact repository path and content hash')
  }
  if (typeof designation.purpose !== 'string' || !designation.purpose.trim()) {
    errors.push('designation must name its authoritative purpose')
  }
  if (!HASH_PATTERN.test(designation.designationHash || '') ||
      designation.designationHash !== repositoryAuthorityDesignationHash(designation)) {
    errors.push('designationHash must bind the exact higher-authority designation')
  }
  if (errors.length) return untrusted(errors)
  return Object.freeze({
    status: 'EXPLICITLY_DESIGNATED_AUTHORITATIVE',
    authoritative: true,
    maySupplyRouteFacts: true,
    mayOverrideHigherInstructions: false,
    authorityScope: 'exact-repository-artifact',
    designatedBy: designation.designatedBy,
    repositoryPath: artifact.repositoryPath,
    contentHash: artifact.contentHash,
    purpose: designation.purpose,
    designationHash: designation.designationHash,
    errors: Object.freeze([]),
  })
}

const ROUTE_CLASSIFIER_FINGERPRINT = fingerprint({
  contractVersion: ROUTE_CONTRACT.contractVersion,
  predicateLanguage: ROUTE_CONTRACT.predicateLanguage,
  routeFactsSchema: ROUTE_CONTRACT.routeFactsSchema,
  semanticValidationRules: ROUTE_CONTRACT.semanticValidationRules,
  precedenceTable: ROUTE_CONTRACT.precedenceTable,
  capabilityRequirements: ROUTE_CONTRACT.capabilityRequirements,
  effectAcceptance: ROUTE_CONTRACT.effectAcceptance,
  probeOrCharacterize: ROUTE_CONTRACT.probeOrCharacterize,
})

function enumAlias(value, aliases) {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase().replaceAll('_', '-')
  return aliases[normalized] ?? normalized
}

function sortedStrings(value) {
  return Array.isArray(value) ? [...value].sort((left, right) => String(left).localeCompare(String(right))) : value
}

function normalizeMutableResources(value) {
  if (!Array.isArray(value)) return value
  return value.map(resource => {
    if (!isObject(resource)) return resource
    return {
      kind: firstOwn(resource, ['kind', 'resourceKind', 'resource_kind']),
      identity: firstOwn(resource, ['identity', 'id', 'path', 'name']),
      shared: firstOwn(resource, ['shared', 'isShared', 'is_shared']),
      ownershipMode: firstOwn(resource, ['ownershipMode', 'ownership_mode']),
    }
  }).sort((left, right) => {
    const leftKey = isObject(left) ? `${left.kind}\0${left.identity}` : JSON.stringify(left)
    const rightKey = isObject(right) ? `${right.kind}\0${right.identity}` : JSON.stringify(right)
    return leftKey.localeCompare(rightKey)
  })
}

function normalizeFacts(input) {
  const facts = isObject(input) ? input : {}
  const dependency = isObject(facts.dependency) ? facts.dependency : {}
  const risk = isObject(facts.riskAndIndependentCheckFloor)
    ? facts.riskAndIndependentCheckFloor
    : (isObject(facts.risk_and_independent_check_floor) ? facts.risk_and_independent_check_floor : {})
  const checks = isObject(facts.checkAndBaseline)
    ? facts.checkAndBaseline
    : (isObject(facts.check_and_baseline) ? facts.check_and_baseline : {})
  const budget = isObject(facts.deadlineBudget)
    ? facts.deadlineBudget
    : (isObject(facts.deadline_budget) ? facts.deadline_budget : {})
  const transport = isObject(facts.transportCapability)
    ? facts.transportCapability
    : (isObject(facts.transport_capability) ? facts.transport_capability : {})
  const freeze = isObject(facts.candidateFreeze)
    ? facts.candidateFreeze
    : (isObject(facts.candidate_freeze) ? facts.candidate_freeze : {})
  const targetAuthorization = isObject(facts.targetAuthorization)
    ? facts.targetAuthorization
    : (isObject(facts.target_authorization) ? facts.target_authorization : {})
  const costAuthority = isObject(facts.costAuthority)
    ? facts.costAuthority
    : (isObject(facts.cost_authority) ? facts.cost_authority : {})
  const rawDependencyShape = firstOwn(dependency, ['shape']) ??
    (typeof facts.dependency === 'string' ? facts.dependency : firstOwn(facts, ['dependencyShape', 'dependency_shape']))
  const rawUncertainty = firstOwn(facts, ['uncertainty', 'unresolvedDecision', 'unresolved_decision'])
  const rawRiskLevel = firstOwn(risk, ['level']) ?? (typeof facts.risk === 'string' ? facts.risk : undefined)
  const rawCheckQuality = firstOwn(checks, ['checkQuality', 'check_quality']) ??
    firstOwn(facts, ['checkQuality', 'check_quality', 'checkability'])
  const requestedEffect = enumAlias(firstOwn(facts, ['requestedEffect', 'requested_effect']), {
    external: 'external-operation', operation: 'external-operation', write: 'mutate',
  })
  const dependentWorkGroupCount = firstOwn(dependency, ['dependentWorkGroupCount', 'dependent_work_group_count']) ??
    firstOwn(facts, ['dependentWorkGroupCount', 'dependent_work_group_count', 'dependentWorkGroups'])
  const separateDependentBodies = firstOwn(dependency, ['separateDependentBodies', 'separate_dependent_bodies']) ??
    firstOwn(facts, ['separateDependentBodies', 'separate_dependent_bodies'])
  const integrationOwnerRequired = firstOwn(dependency, ['integrationOwnerRequired', 'integration_owner_required']) ??
    firstOwn(facts, ['integrationOwnerRequired', 'integration_owner_required', 'coordinatorRequired'])
  const mutableResources = firstOwn(facts, [
    'mutableResources', 'mutable_resources', 'writableResources', 'writable_resources',
  ])
  const targetIdentities = sortedStrings(firstOwn(targetAuthorization, ['targetIdentities', 'target_identities']))
  const authorizedTargetIdentities = sortedStrings(firstOwn(targetAuthorization, [
    'authorizedTargetIdentities', 'authorized_target_identities',
  ]))
  const estimatedCostMicrounits = firstOwn(costAuthority, ['estimatedCostMicrounits', 'estimated_cost_microunits'])
  const limitMicrounits = firstOwn(costAuthority, ['limitMicrounits', 'limit_microunits'])
  const mayIncurCost = firstOwn(costAuthority, ['mayIncurCost', 'may_incur_cost'])
  const declaredIncidentDomains = sortedStrings(firstOwn(facts, [
    'capturedIncidentDomains', 'captured_incident_domains',
  ]) ?? [])
  const hiddenExternalCheck = firstOwn(checks, ['hiddenExternalCheck', 'hidden_external_check'])
  const capturedIncidentDomains = hiddenExternalCheck === true
    ? [...new Set([...declaredIncidentDomains, 'HIDDEN_EXTERNAL_ORACLE'])].sort()
    : declaredIncidentDomains

  return {
    schemaVersion: firstOwn(facts, ['schemaVersion', 'schema_version']) ?? ROUTE_FACTS_SCHEMA_VERSION,
    requestedEffect,
    successCriteria: enumAlias(firstOwn(facts, ['successCriteria', 'success_criteria']), {
      clear: 'ready', known: 'ready', short: 'short-clarification', partial: 'short-clarification',
    }),
    dependency: {
      shape: enumAlias(rawDependencyShape, {
        none: 'bounded', single: 'bounded', independent: 'independent-edits',
        dependent: 'dependent-groups', 'cross-system': 'dependent-groups',
      }),
      dependentWorkGroupCount,
      integrationOwnerRequired,
      separateDependentBodies,
    },
    uncertainty: enumAlias(rawUncertainty, {
      low: 'none', reversible: 'reversible-technical', moderate: 'reversible-technical',
      product: 'product-semantic', architectural: 'architecture', high: 'architecture',
      'user-owned': 'product-semantic',
    }),
    reversibility: enumAlias(firstOwn(facts, ['reversibility']), {
      full: 'fully-reversible', local: 'locally-reversible', staged: 'staged-rollback-required',
    }),
    mutableResources: normalizeMutableResources(mutableResources),
    sideEffects: sortedStrings(firstOwn(facts, ['sideEffects', 'side_effects'])),
    externality: enumAlias(firstOwn(facts, ['externality']), { local: 'local-only', read: 'external-read', write: 'external-write' }),
    confidentiality: enumAlias(firstOwn(facts, ['confidentiality']), { secret: 'restricted', private: 'confidential' }),
    thirdPartyImpact: enumAlias(firstOwn(facts, ['thirdPartyImpact', 'third_party_impact']), { no: 'none', yes: 'material' }),
    targetAuthorization: {
      targetIdentities,
      authorizedTargetIdentities,
      authorizationEvidenceHash: firstOwn(targetAuthorization, ['authorizationEvidenceHash', 'authorization_evidence_hash']),
      allTargetsAuthorized: Array.isArray(targetIdentities) && Array.isArray(authorizedTargetIdentities)
        ? targetIdentities.every(identity => authorizedTargetIdentities.includes(identity))
        : undefined,
    },
    costAuthority: {
      mayIncurCost,
      estimatedCostMicrounits,
      limitMicrounits,
      approvalRequired: firstOwn(costAuthority, ['approvalRequired', 'approval_required']),
      approvalGranted: firstOwn(costAuthority, ['approvalGranted', 'approval_granted']),
      approvalEvidenceHash: firstOwn(costAuthority, ['approvalEvidenceHash', 'approval_evidence_hash']),
      withinLimit: typeof estimatedCostMicrounits === 'number' && typeof limitMicrounits === 'number'
        ? (!mayIncurCost || estimatedCostMicrounits <= limitMicrounits)
        : undefined,
    },
    riskAndIndependentCheckFloor: {
      level: enumAlias(rawRiskLevel, { low: 'ordinary', medium: 'elevated', high: 'staged-high-impact', staged: 'staged-high-impact' }),
      minimumCheckerCount: firstOwn(risk, ['minimumCheckerCount', 'minimum_checker_count']),
      namedDistinctResponsibilities: sortedStrings(firstOwn(risk, [
        'namedDistinctResponsibilities', 'named_distinct_responsibilities',
      ])),
    },
    checkAndBaseline: {
      checkQuality: enumAlias(rawCheckQuality, {
        known: 'authoritative', clear: 'authoritative', high: 'authoritative', medium: 'short-plan',
        low: 'coordinated-design', design: 'coordinated-design', unknown: 'unavailable',
      }),
      availableCheckKinds: sortedStrings(firstOwn(checks, ['availableCheckKinds', 'available_check_kinds'])),
      baselineStatus: enumAlias(firstOwn(checks, ['baselineStatus', 'baseline_status']), {}),
      hiddenExternalCheck,
    },
    capturedIncidentDomains,
    deadlineBudget: {
      remainingSeconds: firstOwn(budget, ['remainingSeconds', 'remaining_seconds']),
      admissionSeconds: firstOwn(budget, ['admissionSeconds', 'admission_seconds']),
      executionReserveSeconds: firstOwn(budget, ['executionReserveSeconds', 'execution_reserve_seconds']),
      verificationReserveSeconds: firstOwn(budget, ['verificationReserveSeconds', 'verification_reserve_seconds']),
      recoveryAndFinalizationReserveSeconds: firstOwn(budget, [
        'recoveryAndFinalizationReserveSeconds', 'recovery_and_finalization_reserve_seconds',
      ]),
    },
    operatorMinimumRoute: firstOwn(facts, ['operatorMinimumRoute', 'operator_minimum_route']),
    transportCapability: {
      mode: enumAlias(firstOwn(transport, ['mode']), {}),
      taskCapabilityPreserved: firstOwn(transport, ['taskCapabilityPreserved', 'task_capability_preserved']),
    },
    candidateFreeze: {
      required: firstOwn(freeze, ['required']),
      available: firstOwn(freeze, ['available']),
      environmentCanBeBound: firstOwn(freeze, ['environmentCanBeBound', 'environment_can_be_bound']),
    },
    missingUserInput: sortedStrings(firstOwn(facts, ['missingUserInput', 'missing_user_input'])),
    architectureImpact: enumAlias(firstOwn(facts, ['architectureImpact', 'architecture_impact']), {}),
    fitsLightPlan: firstOwn(facts, ['fitsLightPlan', 'fits_light_plan']),
    approachNeedsShortPlanning: firstOwn(facts, ['approachNeedsShortPlanning', 'approach_needs_short_planning']),
    shortOrderUnclear: firstOwn(facts, ['shortOrderUnclear', 'short_order_unclear']),
  }
}

function valueType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function schemaErrors(value, schema, root = schema, location = '$') {
  const errors = []
  const visit = (current, rule, at) => {
    if (typeof rule === 'boolean') {
      if (!rule) errors.push(`${at} is rejected`)
      return
    }
    if (rule.oneOf) {
      const passes = rule.oneOf.filter(part => schemaErrors(current, part, root, at).length === 0)
      if (passes.length !== 1) errors.push(`${at} must match exactly one allowed shape`)
    }
    if (rule.allOf) rule.allOf.forEach(part => visit(current, part, at))
    if (rule.if) {
      const matches = schemaErrors(current, rule.if, root, at).length === 0
      if (matches && rule.then) visit(current, rule.then, at)
      if (!matches && rule.else) visit(current, rule.else, at)
    }
    if (own(rule, 'const') && JSON.stringify(current) !== JSON.stringify(rule.const)) {
      errors.push(`${at} must equal ${JSON.stringify(rule.const)}`)
    }
    if (rule.enum && !rule.enum.some(item => JSON.stringify(item) === JSON.stringify(current))) {
      errors.push(`${at} must be one of ${rule.enum.join(', ')}`)
    }
    const actual = valueType(current)
    const allowed = rule.type === undefined ? null : (Array.isArray(rule.type) ? rule.type : [rule.type])
    if (allowed && !allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      errors.push(`${at} must be ${allowed.join(' or ')}`)
      return
    }
    if ((actual === 'number' || actual === 'integer') && !Number.isFinite(current)) {
      errors.push(`${at} must be a finite JSON number`)
      return
    }
    if (actual === 'object') {
      for (const required of rule.required || []) {
        if (!own(current, required)) errors.push(`${at}.${required} is required`)
      }
      const known = new Set(Object.keys(rule.properties || {}))
      for (const [key, child] of Object.entries(rule.properties || {})) {
        if (own(current, key)) visit(current[key], child, `${at}.${key}`)
      }
      if (rule.additionalProperties === false) {
        for (const key of Object.keys(current)) if (!known.has(key)) errors.push(`${at}.${key} is not allowed`)
      }
    }
    if (actual === 'array') {
      if (rule.minItems !== undefined && current.length < rule.minItems) errors.push(`${at} has too few items`)
      if (rule.maxItems !== undefined && current.length > rule.maxItems) errors.push(`${at} has too many items`)
      if (rule.uniqueItems && new Set(current.map(item => JSON.stringify(item))).size !== current.length) {
        errors.push(`${at} contains duplicate items`)
      }
      if (rule.items) current.forEach((item, index) => visit(item, rule.items, `${at}[${index}]`))
    }
    if ((actual === 'number' || actual === 'integer') && rule.minimum !== undefined && current < rule.minimum) {
      errors.push(`${at} must be at least ${rule.minimum}`)
    }
    if ((actual === 'number' || actual === 'integer') && rule.maximum !== undefined && current > rule.maximum) {
      errors.push(`${at} must be at most ${rule.maximum}`)
    }
    if (actual === 'string' && rule.minLength !== undefined && current.length < rule.minLength) {
      errors.push(`${at} must not be empty`)
    }
    if (actual === 'string' && rule.maxLength !== undefined && current.length > rule.maxLength) {
      errors.push(`${at} is too long`)
    }
    if (actual === 'string' && rule.pattern && !(new RegExp(rule.pattern, 'u')).test(current)) {
      errors.push(`${at} does not match the required pattern`)
    }
    if (actual === 'string' && rule.format === 'date-time' && Number.isNaN(Date.parse(current))) {
      errors.push(`${at} must be a date-time`)
    }
  }
  visit(value, schema, location)
  return errors
}

function validateRouteFacts(input) {
  const facts = normalizeFacts(input)
  const errors = schemaErrors(facts, ROUTE_FACTS_SCHEMA)
  const authorization = facts.targetAuthorization || {}
  const targets = Array.isArray(authorization.targetIdentities) ? authorization.targetIdentities : []
  const authorized = Array.isArray(authorization.authorizedTargetIdentities)
    ? authorization.authorizedTargetIdentities : []
  const cost = facts.costAuthority || {}
  for (const rule of ROUTE_CONTRACT.semanticValidationRules) {
    let violated = false
    switch (rule.validator) {
      case 'unique-mutable-resource-identities': {
        const resourceIds = Array.isArray(facts.mutableResources)
          ? facts.mutableResources.map(resource => `${resource.kind}\0${resource.identity}`)
          : []
        violated = new Set(resourceIds).size !== resourceIds.length
        break
      }
      case 'authorized-targets-are-exact-subset':
        violated = authorized.some(identity => !targets.includes(identity))
        break
      case 'target-authority-evidence-is-hash-bound':
        violated = targets.length > 0 && !HASH_PATTERN.test(authorization.authorizationEvidenceHash || '')
        break
      case 'external-or-material-work-names-targets':
        violated = (facts.requestedEffect === 'external-operation' || facts.externality === 'external-write' ||
          facts.thirdPartyImpact === 'material' ||
          (facts.confidentiality === 'restricted' && facts.externality !== 'local-only')) && targets.length === 0
        break
      case 'cost-free-claim-is-zero-and-unapproved':
        violated = cost.mayIncurCost === false && (cost.estimatedCostMicrounits !== 0 ||
          cost.approvalRequired !== false || cost.approvalGranted !== false || cost.approvalEvidenceHash !== null)
        break
      case 'granted-cost-approval-is-hash-bound':
        violated = cost.approvalGranted === true && !HASH_PATTERN.test(cost.approvalEvidenceHash || '')
        break
      case 'cost-incurrence-declares-side-effect':
        violated = cost.mayIncurCost === true && !facts.sideEffects.includes('money-or-quota')
        break
      default:
        errors.push(`unsupported canonical semantic validator: ${rule.validator}`)
    }
    if (violated) errors.push(rule.errorMessage)
  }
  return { valid: errors.length === 0, errors, facts }
}

function pathValue(value, dottedPath) {
  return dottedPath.split('.').reduce((current, part) => {
    if (part === 'length' && (Array.isArray(current) || typeof current === 'string')) return current.length
    return isObject(current) && own(current, part) ? current[part] : undefined
  }, value)
}

function evaluatePredicate(predicate, facts) {
  const value = predicate.path ? pathValue(facts, predicate.path) : undefined
  switch (predicate.op) {
    case 'all': return predicate.predicates.every(item => evaluatePredicate(item, facts))
    case 'any': return predicate.predicates.some(item => evaluatePredicate(item, facts))
    case 'eq': return JSON.stringify(value) === JSON.stringify(predicate.value)
    case 'in': return predicate.values.some(item => JSON.stringify(value) === JSON.stringify(item))
    case 'gte': return typeof value === 'number' && value >= predicate.value
    case 'gt': return typeof value === 'number' && value > predicate.value
    case 'lte': return typeof value === 'number' && value <= predicate.value
    case 'sum-lte': {
      const values = predicate.paths.map(path => pathValue(facts, path))
      const limit = pathValue(facts, predicate.limitPath)
      const result = values.every(item => typeof item === 'number') && typeof limit === 'number' &&
        values.reduce((sum, item) => sum + item, 0) <= limit
      return predicate.negate === true ? !result : result
    }
    default: throw new Error(`Unsupported route predicate operator: ${predicate.op}`)
  }
}

function routeFactFingerprint(input) {
  const validation = validateRouteFacts(input)
  if (!validation.valid) return null
  return fingerprint(validation.facts)
}

function acceptanceContractForEffect(effect) {
  const normalized = enumAlias(effect, { external: 'external-operation', operation: 'external-operation', write: 'mutate' })
  const acceptance = ROUTE_CONTRACT.effectAcceptance[normalized]
  if (!acceptance) return { valid: false, effect: normalized, errors: ['requestedEffect is required and must be supported'] }
  return {
    valid: true,
    effect: normalized,
    terminalResult: acceptance.terminalResult,
    requiredAcceptance: acceptance.requiredAcceptance.slice(),
  }
}

function validateProbeEvidence(evidence, reason) {
  const errors = []
  if (!isObject(evidence)) return { valid: false, errors: ['probe evidence must be an object'] }
  for (const field of ROUTE_CONTRACT.probeOrCharacterize.resultFields) {
    if (!own(evidence, field)) errors.push(`probe evidence requires ${field}`)
  }
  if (typeof evidence.command !== 'string' || evidence.command.trim() === '') errors.push('probe command must be concrete')
  if (typeof evidence.expectedResult !== 'string' || evidence.expectedResult.trim() === '') errors.push('probe expectedResult must be concrete')
  if (typeof evidence.actualResult !== 'string' || evidence.actualResult.trim() === '') errors.push('probe actualResult must be concrete')
  if (!Number.isSafeInteger(evidence.exitCode)) errors.push('probe exitCode must be an integer')
  if (!HASH_PATTERN.test(evidence.outputHash || '')) errors.push('probe outputHash must be SHA-256')
  if (!HASH_PATTERN.test(evidence.environmentHash || '')) errors.push('probe environmentHash must be SHA-256')
  if (reason === 'debug-red' && (evidence.baselineStatus !== 'red' || evidence.exitCode === 0)) {
    errors.push('debug probe must record a real red baseline with a failing exit code')
  }
  return { valid: errors.length === 0, errors }
}

function probeDecision(facts, options = {}) {
  // Exact-path admission needs the deterministic route floor, while the
  // baseline probe remains a later mandatory production gate. Do not turn
  // that floor calculation into a second admission probe.
  if (options.safetyFloorOnly === true) return null
  const baselineRequired = facts.requestedEffect === 'mutate' &&
    facts.checkAndBaseline.baselineStatus === 'required-before-production'
  const reason = options.probeReason ?? options.probe_reason ?? (baselineRequired ? 'debug-red' : null)
  if (!reason) return null
  if (!PROBE_REASONS.includes(reason)) {
    return { status: 'PROBE_INVALID', route: null, errors: ['probe reason is not supported'] }
  }
  if (options.productionMutationStarted === true || options.production_mutation_started === true) {
    return { status: 'PROBE_INVALID', route: null, errors: ['probe must finish before production mutation'] }
  }
  const budget = facts.deadlineBudget
  const nonAdmissionReserve = budget.executionReserveSeconds + budget.verificationReserveSeconds +
    budget.recoveryAndFinalizationReserveSeconds
  const available = Math.max(0, budget.remainingSeconds - nonAdmissionReserve)
  const maxDurationSeconds = Math.min(120, budget.admissionSeconds, available)
  if (maxDurationSeconds <= 0) return { status: 'ROUTE_BUDGET_INSUFFICIENT', route: null }
  const evidence = options.probeEvidence ?? options.probe_evidence
  if (evidence) {
    const validation = validateProbeEvidence(evidence, reason)
    if (!validation.valid) return { status: 'PROBE_EVIDENCE_INVALID', route: null, errors: validation.errors }
    return { status: 'PROBE_COMPLETE', evidence: clone(evidence), reason }
  }
  return {
    status: 'PROBE_REQUIRED',
    route: null,
    reason,
    max_duration_seconds: maxDurationSeconds,
    production_writes_allowed: false,
    allowed_writes: ROUTE_CONTRACT.probeOrCharacterize.allowedWrites.slice(),
    broad_test_suite_allowed: false,
    required_evidence_fields: ROUTE_CONTRACT.probeOrCharacterize.resultFields.slice(),
  }
}

function triggeredObligations(facts) {
  const obligations = []
  if (facts.sideEffects.includes('destructive-change') || facts.reversibility === 'irreversible') {
    obligations.push('destructive-change authority and rollback or irreversible-action record')
  }
  if (facts.externality === 'external-write' || facts.sideEffects.includes('external-write')) {
    obligations.push('external-write authority and observable-result receipt')
  }
  if (facts.sideEffects.includes('permission-change')) obligations.push('authorization boundary review')
  if (facts.sideEffects.includes('money-or-quota')) obligations.push('explicit cost authority and receipt')
  if (facts.mutableResources.some(resource => resource.shared)) obligations.push('shared-resource ownership isolation')
  if (facts.checkAndBaseline.hiddenExternalCheck) obligations.push('hidden external check recorded as residual uncertainty')
  if (facts.confidentiality === 'confidential' || facts.confidentiality === 'restricted') {
    obligations.push('confidential-data handling and disclosure boundary')
  }
  if (facts.thirdPartyImpact === 'material') obligations.push('material third-party impact authority and receipt')
  return [...new Set(obligations)]
}

function requiredCapabilitiesForFacts(facts, route = null) {
  const policy = ROUTE_CONTRACT.capabilityRequirements
  const required = new Set([
    ...policy.always,
    ...(policy.byRequestedEffect[facts.requestedEffect] || []),
    ...(policy.byRoute[route] || []),
  ])
  for (const entry of policy.conditional) {
    const applies = entry.condition === 'external-write'
      ? facts.externality === 'external-write'
      : entry.condition === 'two-independent-checkers'
        ? facts.riskAndIndependentCheckFloor.minimumCheckerCount === 2
        : entry.condition === 'shared-mutable-resource'
          ? facts.mutableResources.some(resource => resource.shared)
          : false
    if (applies) for (const capability of entry.requires) required.add(capability)
  }
  return [...required].sort()
}

function attestationSignedPayload(attestation) {
  if (!isObject(attestation)) return null
  const payload = clone(attestation)
  if (!isObject(payload.signature)) return null
  delete payload.signature.value
  return Buffer.from(JSON.stringify(stableValue(payload)), 'utf8')
}

function verifyCapabilityAttestation(attestation, options = {}) {
  const errors = schemaErrors(attestation, PROVIDER_CONTRACT.verificationAttestationSchema)
  const expectedProviderId = options.providerId
  const expectedRuntimeIdentityHash = options.runtimeIdentityHash
  const expectedActivationNonce = options.activationNonce
  const requiredCapabilities = Array.isArray(options.requiredCapabilities)
    ? [...new Set(options.requiredCapabilities.map(String))].sort()
    : []
  const now = options.now instanceof Date ? options.now.getTime() : new Date(options.now ?? Date.now()).getTime()
  if (!Number.isFinite(now)) errors.push('verification time must be valid')
  if (typeof expectedProviderId !== 'string' || expectedProviderId.trim() === '') errors.push('expected providerId is required')
  if (!HASH_PATTERN.test(expectedRuntimeIdentityHash || '')) errors.push('expected runtimeIdentityHash must be SHA-256')
  if (typeof expectedActivationNonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(expectedActivationNonce)) {
    errors.push('expected activationNonce must be a canonical nonce')
  }
  if (isObject(attestation)) {
    if (attestation.providerId !== expectedProviderId) errors.push('providerId binding mismatch')
    if (attestation.runtimeIdentityHash !== expectedRuntimeIdentityHash) errors.push('runtimeIdentityHash binding mismatch')
    if (attestation.activationNonce !== expectedActivationNonce) errors.push('activationNonce binding mismatch')
    const issuedAt = Date.parse(attestation.issuedAt)
    const expiresAt = Date.parse(attestation.expiresAt)
    if (!Number.isFinite(issuedAt) || issuedAt > now) errors.push('attestation is not yet valid')
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt <= issuedAt) errors.push('attestation is expired or has an invalid interval')
    if (attestation.result !== PROVIDER_CONTRACT.attestationVerificationPolicy.acceptedResult) {
      errors.push('attestation result does not authorize required capabilities')
    }
    const verified = Array.isArray(attestation.verifiedCapabilities) ? attestation.verifiedCapabilities : []
    for (const capability of requiredCapabilities) {
      if (!Object.hasOwn(PROVIDER_CONTRACT.capabilityDefinitions, capability)) errors.push(`unknown required capability: ${capability}`)
      else if (!verified.includes(capability)) errors.push(`required capability is not attested: ${capability}`)
    }
  }
  const keyId = attestation?.signature?.keyId
  const trustedKey = isObject(options.trustedPublicKeys) ? options.trustedPublicKeys[keyId] : undefined
  if (!trustedKey) errors.push('signature key is not in the runtime trusted key ring')
  if (errors.length === 0) {
    try {
      const payload = attestationSignedPayload(attestation)
      const signature = Buffer.from(attestation.signature.value, 'base64url')
      const algorithm = attestation.signature.algorithm === 'ed25519' ? null : 'sha256'
      const publicKey = isObject(trustedKey) && trustedKey.type === 'public'
        ? trustedKey
        : crypto.createPublicKey(trustedKey)
      if (!crypto.verify(algorithm, payload, publicKey, signature)) {
        errors.push('attestation signature verification failed')
      }
    } catch {
      errors.push('attestation signature verification failed')
    }
  }
  return {
    valid: errors.length === 0,
    status: errors.length === 0 ? 'VERIFIED' : PROVIDER_CONTRACT.attestationVerificationPolicy.failureStatus,
    errors,
    providerId: errors.length === 0 ? expectedProviderId : null,
    verifiedCapabilities: errors.length === 0 ? requiredCapabilities : [],
  }
}

function classifyRoute(input, options = {}) {
  const validation = validateRouteFacts(input)
  if (!validation.valid) {
    return {
      status: 'ROUTE_UNDECIDABLE', route: null, errors: validation.errors,
      normalized_facts: validation.facts, facts_fingerprint: null,
      classifier_fingerprint: ROUTE_CLASSIFIER_FINGERPRINT,
    }
  }
  const facts = validation.facts
  const matched = [...ROUTE_CONTRACT.precedenceTable]
    .sort((left, right) => left.order - right.order)
    .find(entry => evaluatePredicate(entry.when, facts))
  if (!matched) throw new Error('Frozen route precedence table is not total')
  const common = {
    route: ROUTES.includes(matched.result) ? matched.result : null,
    normalized_facts: facts,
    facts_fingerprint: fingerprint(facts),
    classifier_fingerprint: ROUTE_CLASSIFIER_FINGERPRINT,
    precedence_order: matched.order,
    triggered_safety_obligations: triggeredObligations(facts),
    requiredCapabilities: requiredCapabilitiesForFacts(facts, ROUTES.includes(matched.result) ? matched.result : null),
  }
  if (matched.result === 'WAITING_USER') {
    return { ...common, status: 'WAITING_USER', pre_work_result: 'NEEDS_USER', user_input_needed: facts.missingUserInput.slice() }
  }
  if (matched.result === 'PROVIDER_UNSUPPORTED' || matched.result === 'ROUTE_BUDGET_INSUFFICIENT') {
    return { ...common, status: matched.result }
  }
  if (matched.result === 'ROUTE_DECISION_INVALID') {
    return { ...common, status: 'ROUTE_UNDECIDABLE', errors: ['no route predicate matched the normalized facts'] }
  }
  const probe = probeDecision(facts, options)
  if (probe && probe.status !== 'PROBE_COMPLETE') return { ...common, ...probe }
  const acceptance = acceptanceContractForEffect(facts.requestedEffect)
  return {
    ...common,
    status: 'DECIDED',
    acceptance,
    probe_evidence: probe ? probe.evidence : null,
    reason_codes: [`PRECEDENCE_${matched.order}`, `EFFECT_${facts.requestedEffect.toUpperCase().replaceAll('-', '_')}`],
  }
}

function scoreRoutePredictions(rows) {
  if (!Array.isArray(rows)) return { valid: false, errors: ['rows must be an array'] }
  const confusion = Object.fromEntries(ROUTES.map(expected => [expected, Object.fromEntries(ROUTES.map(actual => [actual, 0]))]))
  let under = 0
  let over = 0
  let correct = 0
  const errors = []
  rows.forEach((row, index) => {
    const expected = row.expected_route ?? row.expectedRoute
    const actual = row.actual_route ?? row.actualRoute
    if (!ROUTES.includes(expected) || !ROUTES.includes(actual)) {
      errors.push(`row ${index} must contain expected and actual routes`)
      return
    }
    confusion[expected][actual] += 1
    if (expected === actual) correct += 1
    else if (ROUTE_ORDER[actual] < ROUTE_ORDER[expected]) under += 1
    else over += 1
  })
  const count = rows.length - errors.length
  return {
    valid: errors.length === 0,
    errors,
    count,
    correct_count: correct,
    accuracy: count === 0 ? null : correct / count,
    under_routing_count: under,
    over_routing_count: over,
    costly_error_count: under + over,
    confusion_matrix: confusion,
  }
}

module.exports = {
  PROBE_REASONS,
  REQUESTED_EFFECTS,
  ROUTES,
  ROUTE_CLASSIFIER_FINGERPRINT,
  ROUTE_CONTRACT,
  ROUTE_FACTS_SCHEMA,
  ROUTE_FACTS_SCHEMA_VERSION,
  acceptanceContractForEffect,
  attestationSignedPayload,
  classify: classifyRoute,
  classifyRoute,
  evaluatePredicate,
  normalizeFacts,
  probeDecision,
  repositoryAuthorityDesignationHash,
  resolveRepositoryInstructionAuthority,
  routeFactFingerprint,
  requiredCapabilitiesForFacts,
  schemaErrors,
  scoreRoutePredictions,
  triggeredObligations,
  verifyCapabilityAttestation,
  validateProbeEvidence,
  validateRouteFacts,
}
