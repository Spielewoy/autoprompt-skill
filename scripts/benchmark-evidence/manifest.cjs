'use strict'

const fs = require('node:fs')
const {
  atomicWriteFile,
  canonicalStringify,
  digestRecord,
  exactKeys,
  fail,
  hashPattern,
  isoDate,
  nonEmpty,
  positiveInteger,
} = require('./core.cjs')
const { verifyTaskCatalogAttestation } = require('./catalog-trust.cjs')
const { validateBlobDescriptor } = require('./files.cjs')
const { requireRoleDigest, signRoleDigest } = require('./trust-registry.cjs')
const { validateManifestLease } = require('./run-lease.cjs')

const REQUIRED_ROLES = Object.freeze(['base', 'current', 'redesign'])
const REQUIRED_CANARY_STAGES = Object.freeze(['pre', 'mid', 'post'])
const RESOURCE_FIELDS = Object.freeze(['instanceId', 'bucket', 'runRoot', 'containerNamespace', 'trialPrefix'])
const REQUIRED_NEGATIVE_DIAGNOSES = Object.freeze([
  'WRONG_MODEL', 'MISSING_SUBAGENT_TRACE', 'BROKEN_VERIFIER', 'UPLOAD_DENIED',
])
const REQUIRED_POSITIVE_CHECKS = Object.freeze([
  'model-version', 'auth', 'tools', 'verifier', 'subagents', 'transcript', 'upload',
])
const FAULT_EXPECTATIONS = Object.freeze({ 'wrong-model': 'WRONG_MODEL', 'missing-subagent-trace': 'MISSING_SUBAGENT_TRACE', 'broken-verifier': 'BROKEN_VERIFIER', 'upload-denied': 'UPLOAD_DENIED' })

function validateProducer(producer, code = 'MANIFEST_ARMS_INVALID') {
  exactKeys(producer, ['name', 'version', 'buildDigest'], code, 'arm producer')
  nonEmpty(producer.name, code, 'producer.name')
  nonEmpty(producer.version, code, 'producer.version')
  if (!hashPattern(producer.buildDigest)) fail(code, 'producer.buildDigest must be sha256')
}

function validateArgv(argv, code, label) {
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || !value)) fail(code, `${label} must be a non-empty string array`)
}

function validateSignedBlob(descriptor, code, label) {
  try { validateBlobDescriptor(descriptor, code) } catch (error) { if (error.code === code) fail(code, `${label} is invalid`, { cause: error.message }); throw error }
}

function validateScoredExecution(execution) {
  exactKeys(execution, ['argv', 'environment', 'toolchain'], 'MANIFEST_EXECUTION_INVALID', 'scored execution')
  validateArgv(execution.argv, 'MANIFEST_EXECUTION_INVALID', 'scored argv')
  validateSignedBlob(execution.environment, 'MANIFEST_EXECUTION_INVALID', 'scored environment')
  validateSignedBlob(execution.toolchain, 'MANIFEST_EXECUTION_INVALID', 'scored toolchain')
}

function sealTaskCatalog(catalog) {
  const unsigned = { ...catalog }
  delete unsigned.digest
  delete unsigned.attestation
  exactKeys(unsigned, ['schemaVersion', 'catalogId', 'benchmarkId', 'fixtureOnly', 'tasks'], 'TASK_CATALOG_INVALID', 'task catalog')
  if (unsigned.schemaVersion !== 'benchmark-task-catalog.v2') fail('TASK_CATALOG_INVALID', 'unsupported task catalog schema')
  nonEmpty(unsigned.catalogId, 'TASK_CATALOG_INVALID', 'catalogId')
  nonEmpty(unsigned.benchmarkId, 'TASK_CATALOG_INVALID', 'benchmarkId')
  if (typeof unsigned.fixtureOnly !== 'boolean') fail('TASK_CATALOG_INVALID', 'fixtureOnly must be explicit')
  if (!Array.isArray(unsigned.tasks) || !unsigned.tasks.length) fail('TASK_CATALOG_INVALID', 'task catalog must contain the full benchmark task set')
  const ids = new Set()
  for (const task of unsigned.tasks) {
    exactKeys(task, ['taskId'], 'TASK_CATALOG_INVALID', 'catalog task')
    nonEmpty(task.taskId, 'TASK_CATALOG_INVALID', 'taskId')
    if (ids.has(task.taskId)) fail('TASK_CATALOG_INVALID', `duplicate catalog task: ${task.taskId}`)
    ids.add(task.taskId)
  }
  return Object.freeze({ ...unsigned, digest: digestRecord(unsigned) })
}

function validateTaskCatalog(catalog, trustRegistry, options = {}) {
  exactKeys(catalog, ['schemaVersion', 'catalogId', 'benchmarkId', 'fixtureOnly', 'tasks', 'digest', 'attestation'], 'TASK_CATALOG_INVALID', 'task catalog')
  if (!catalog || !hashPattern(catalog.digest)) fail('TASK_CATALOG_INVALID', 'task catalog digest is required')
  const sealed = sealTaskCatalog(catalog)
  if (sealed.digest !== catalog.digest) fail('TASK_CATALOG_INVALID', 'task catalog digest is invalid')
  const trust = verifyTaskCatalogAttestation(catalog, trustRegistry, options)
  return Object.freeze({ catalog, trust })
}

function validateArms(arms) {
  if (!Array.isArray(arms) || arms.length !== 3) fail('MANIFEST_ARMS_INVALID', 'exactly three preregistered arms are required')
  const ids = new Set()
  const roles = new Set()
  for (const arm of arms) {
    exactKeys(arm, ['armId', 'role', 'producer', 'execution'], 'MANIFEST_ARMS_INVALID', 'arm')
    nonEmpty(arm.armId, 'MANIFEST_ARMS_INVALID', 'armId')
    if (ids.has(arm.armId)) fail('MANIFEST_DUPLICATE_ARM', `duplicate arm: ${arm.armId}`)
    if (!REQUIRED_ROLES.includes(arm.role) || roles.has(arm.role)) fail('MANIFEST_ARMS_INVALID', `invalid or duplicate arm role: ${arm.role}`)
    validateProducer(arm.producer)
    validateScoredExecution(arm.execution)
    ids.add(arm.armId); roles.add(arm.role)
  }
  if (REQUIRED_ROLES.some(role => !roles.has(role))) fail('MANIFEST_ARMS_INVALID', 'base, current, and redesign arms are all required')
  return ids
}

function validateTasks(tasks, armIds, catalog, options = {}) {
  if (!Array.isArray(tasks) || !tasks.length) fail('MANIFEST_TASKS_INVALID', 'a preregistered task set is required')
  const ids = new Set()
  let included = 0
  for (const task of tasks) {
    exactKeys(task, ['taskId', 'included', 'exclusionReason', 'pairedOrder', 'input'], 'MANIFEST_TASKS_INVALID', 'task')
    nonEmpty(task.taskId, 'MANIFEST_TASKS_INVALID', 'taskId')
    if (ids.has(task.taskId)) fail('MANIFEST_DUPLICATE_TASK', `duplicate task: ${task.taskId}`)
    ids.add(task.taskId)
    if (typeof task.included !== 'boolean') fail('MANIFEST_TASKS_INVALID', `task ${task.taskId} requires included boolean`)
    if (task.included) {
      included += 1
      if (!Array.isArray(task.pairedOrder) || task.pairedOrder.length !== armIds.size ||
          new Set(task.pairedOrder).size !== armIds.size || task.pairedOrder.some(id => !armIds.has(id))) {
        fail('MANIFEST_PAIRED_ORDER_INVALID', `task ${task.taskId} must list every arm exactly once`)
      }
      if (task.exclusionReason !== undefined) fail('MANIFEST_TASKS_INVALID', `included task ${task.taskId} cannot have an exclusion reason`)
      validateSignedBlob(task.input, 'MANIFEST_TASKS_INVALID', `input for ${task.taskId}`)
    } else {
      nonEmpty(task.exclusionReason, 'MANIFEST_TASKS_INVALID', `exclusionReason for ${task.taskId}`)
      if (task.pairedOrder !== undefined) fail('MANIFEST_TASKS_INVALID', `excluded task ${task.taskId} cannot have pairedOrder`)
      if (task.input !== undefined) fail('MANIFEST_TASKS_INVALID', `excluded task ${task.taskId} cannot have input`)
    }
  }
  if (!included) fail('MANIFEST_TASKS_INVALID', 'at least one task must be included')
  if (catalog) {
    validateTaskCatalog(catalog, options.trustRegistry)
    const catalogIds = catalog.tasks.map(task => task.taskId).sort()
    const manifestIds = [...ids].sort()
    if (canonicalStringify(catalogIds) !== canonicalStringify(manifestIds)) {
      fail('MANIFEST_TASK_CATALOG_MISMATCH', 'manifest tasks do not exactly match the authoritative benchmark catalog', { catalogIds, manifestIds })
    }
  }
}

function validateBudgets(budgets) {
  exactKeys(budgets, ['agentTimeoutMs', 'verifierTimeoutMs', 'hostKillMs', 'maxTokens'], 'MANIFEST_BUDGET_INVALID', 'budgets')
  for (const field of ['agentTimeoutMs', 'verifierTimeoutMs', 'hostKillMs', 'maxTokens']) positiveInteger(budgets[field], 'MANIFEST_BUDGET_INVALID', field)
  if (budgets.hostKillMs <= Math.max(budgets.agentTimeoutMs, budgets.verifierTimeoutMs)) {
    fail('MANIFEST_BUDGET_INVALID', 'external host kill must exceed agent and verifier timeouts')
  }
}

function validateResources(resources) {
  exactKeys(resources, RESOURCE_FIELDS, 'MANIFEST_RESOURCES_INVALID', 'resources')
  for (const field of RESOURCE_FIELDS) nonEmpty(resources[field], 'MANIFEST_RESOURCES_INVALID', `resources.${field}`)
}

function validateCanaryExecution(execution, polarity) {
  exactKeys(execution, ['argv', 'input', 'fixture', 'environment', 'toolchain', 'faultInjector'], 'MANIFEST_CANARIES_INVALID', 'canary execution')
  validateArgv(execution.argv, 'MANIFEST_CANARIES_INVALID', 'canary argv')
  for (const field of ['input', 'fixture', 'environment', 'toolchain']) validateSignedBlob(execution[field], 'MANIFEST_CANARIES_INVALID', `canary ${field}`)
  if (polarity === 'positive') {
    if (execution.faultInjector !== null) fail('MANIFEST_CANARIES_INVALID', 'positive canary cannot inject a fault')
  } else {
    exactKeys(execution.faultInjector, ['name', 'argv', 'artifact'], 'MANIFEST_CANARIES_INVALID', 'canary fault injector')
    nonEmpty(execution.faultInjector.name, 'MANIFEST_CANARIES_INVALID', 'faultInjector.name')
    validateArgv(execution.faultInjector.argv, 'MANIFEST_CANARIES_INVALID', 'fault injector argv')
    validateSignedBlob(execution.faultInjector.artifact, 'MANIFEST_CANARIES_INVALID', 'fault injector artifact')
  }
}

function validateCanaries(canaries, scoredCount) {
  exactKeys(canaries, ['stages', 'midAfterScoredAttempts', 'definitions'], 'MANIFEST_CANARIES_INVALID', 'canaries')
  if (!Array.isArray(canaries.stages) || canonicalStringify(canaries.stages) !== canonicalStringify(REQUIRED_CANARY_STAGES)) {
    fail('MANIFEST_CANARIES_INVALID', 'canary stages must be pre, mid, post')
  }
  if (!Array.isArray(canaries.definitions) || !canaries.definitions.length) fail('MANIFEST_CANARIES_INVALID', 'canary definitions are required')
  const ids = new Set()
  let positive = 0
  let negative = 0
  for (const definition of canaries.definitions) {
    exactKeys(definition, ['canaryId', 'polarity', 'checks', 'expectedDiagnosis', 'execution'], 'MANIFEST_CANARIES_INVALID', 'canary definition')
    nonEmpty(definition.canaryId, 'MANIFEST_CANARIES_INVALID', 'canaryId')
    if (ids.has(definition.canaryId)) fail('MANIFEST_CANARIES_INVALID', `duplicate canary: ${definition.canaryId}`)
    ids.add(definition.canaryId)
    if (!['positive', 'negative'].includes(definition.polarity)) fail('MANIFEST_CANARIES_INVALID', `invalid canary polarity: ${definition.polarity}`)
    if (!Array.isArray(definition.checks) || !definition.checks.length || definition.checks.some(check => typeof check !== 'string' || !check)) {
      fail('MANIFEST_CANARIES_INVALID', `canary ${definition.canaryId} requires checks`)
    }
    if (new Set(definition.checks).size !== definition.checks.length) fail('MANIFEST_CANARIES_INVALID', `canary ${definition.canaryId} has duplicate checks`)
    validateCanaryExecution(definition.execution, definition.polarity)
    if (definition.polarity === 'negative') {
      negative += 1
      nonEmpty(definition.expectedDiagnosis, 'MANIFEST_CANARIES_INVALID', `expectedDiagnosis for ${definition.canaryId}`)
      if (!REQUIRED_NEGATIVE_DIAGNOSES.includes(definition.expectedDiagnosis) || FAULT_EXPECTATIONS[definition.execution.faultInjector.name] !== definition.expectedDiagnosis) fail('MANIFEST_CANARIES_INVALID', `negative canary ${definition.canaryId} diagnosis must exactly match its named fault injector`)
    } else {
      positive += 1
      if (definition.expectedDiagnosis !== undefined) fail('MANIFEST_CANARIES_INVALID', `positive canary ${definition.canaryId} cannot expect a failure diagnosis`)
    }
  }
  if (!positive || !negative) fail('MANIFEST_CANARIES_INVALID', 'positive and negative canaries are required')
  const positiveDefinition = canaries.definitions.find(item => item.polarity === 'positive')
  if (!positiveDefinition || REQUIRED_POSITIVE_CHECKS.some(check => !positiveDefinition.checks.includes(check))) {
    fail('MANIFEST_CANARIES_INVALID', 'positive canary must cover model/version, auth, tools, verifier, subagents, transcript, and upload')
  }
  const diagnoses = new Set(canaries.definitions.filter(item => item.polarity === 'negative').map(item => item.expectedDiagnosis))
  if (REQUIRED_NEGATIVE_DIAGNOSES.some(diagnosis => !diagnoses.has(diagnosis))) {
    fail('MANIFEST_CANARIES_INVALID', 'negative canaries must diagnose wrong model, missing subagent trace, broken verifier, and upload denial')
  }
  positiveInteger(canaries.midAfterScoredAttempts, 'MANIFEST_CANARIES_INVALID', 'midAfterScoredAttempts')
  if (scoredCount !== undefined && canaries.midAfterScoredAttempts >= scoredCount) fail('MANIFEST_CANARIES_INVALID', 'mid canaries must split scored work into non-empty before/after sets')
}

function buildPlannedAttempts(manifest, options = {}) {
  const armIds = validateArms(manifest.arms)
  validateTasks(manifest.tasks, armIds, options.catalog, { trustRegistry: options.trustRegistry })
  positiveInteger(manifest.repetitions, 'MANIFEST_REPETITIONS_INVALID', 'repetitions')
  if (manifest.repetitions < 3) fail('MANIFEST_REPETITIONS_INVALID', 'at least three repetitions are required')
  const result = []
  for (const task of manifest.tasks.filter(item => item.included)) {
    for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
      for (let order = 0; order < task.pairedOrder.length; order += 1) {
        const armId = task.pairedOrder[order]
        result.push({
          attemptId: `${task.taskId}::${armId}::${repetition}`,
          attemptClass: 'scored',
          taskId: task.taskId,
          armId,
          repetition,
          pairedOrder: order + 1,
          execution: {
            argv: [...manifest.arms.find(arm => arm.armId === armId).execution.argv],
            input: { ...task.input },
            environment: { ...manifest.arms.find(arm => arm.armId === armId).execution.environment },
            toolchain: { ...manifest.arms.find(arm => arm.armId === armId).execution.toolchain },
          },
        })
      }
    }
  }
  return result
}

function buildCanaryAttempts(manifest) {
  validateArms(manifest.arms)
  validateCanaries(manifest.canaries, manifest.plannedAttempts && manifest.plannedAttempts.length)
  const plans = []
  for (const stage of manifest.canaries.stages) {
    for (const [definitionIndex, definition] of manifest.canaries.definitions.entries()) {
      for (const arm of manifest.arms) {
        plans.push({
          attemptId: `canary::${stage}::c${definitionIndex + 1}::${arm.armId}`,
          attemptClass: 'canary',
          armId: arm.armId,
          repetition: 0,
          stage,
          canaryId: definition.canaryId,
          polarity: definition.polarity,
          checks: [...definition.checks],
          execution: {
            ...definition.execution,
            argv: [...definition.execution.argv],
            input: { ...definition.execution.input }, fixture: { ...definition.execution.fixture },
            environment: { ...definition.execution.environment }, toolchain: { ...definition.execution.toolchain },
            faultInjector: definition.execution.faultInjector && { ...definition.execution.faultInjector, argv: [...definition.execution.faultInjector.argv], artifact: { ...definition.execution.faultInjector.artifact } },
          },
          ...(definition.expectedDiagnosis ? { expectedDiagnosis: definition.expectedDiagnosis } : {}),
        })
      }
    }
  }
  return plans
}

function buildExecutionOrder(manifest) {
  const scored = buildPlannedAttempts(manifest)
  validateCanaries(manifest.canaries, scored.length)
  const canaries = buildCanaryAttempts({ ...manifest, plannedAttempts: scored })
  const stage = name => canaries.filter(item => item.stage === name).map(item => item.attemptId)
  const midpoint = manifest.canaries.midAfterScoredAttempts
  return [
    ...stage('pre'),
    ...scored.slice(0, midpoint).map(item => item.attemptId),
    ...stage('mid'),
    ...scored.slice(midpoint).map(item => item.attemptId),
    ...stage('post'),
  ]
}

function validateRunManifest(manifest, options = {}) {
  exactKeys(manifest, [
    'schemaVersion', 'manifestId', 'benchmarkId', 'createdAt', 'arms', 'repetitions', 'tasks', 'budgets',
    'resources', 'pricingRef', 'taskCatalogRef', 'runLease', 'canaries', 'plannedAttempts', 'executionOrder', 'manifestDigest', 'signature',
  ], 'MANIFEST_SCHEMA_INVALID', 'run manifest')
  if (manifest.schemaVersion !== 'benchmark-run-manifest.v2') fail('MANIFEST_SCHEMA_INVALID', 'unsupported run manifest schema')
  nonEmpty(manifest.manifestId, 'MANIFEST_SCHEMA_INVALID', 'manifestId')
  nonEmpty(manifest.benchmarkId, 'MANIFEST_SCHEMA_INVALID', 'benchmarkId')
  isoDate(manifest.createdAt, 'MANIFEST_SCHEMA_INVALID', 'createdAt')
  const armIds = validateArms(manifest.arms)
  if (!options.catalog) fail('TASK_CATALOG_REQUIRED', 'manifest validation requires the authoritative benchmark task catalog')
  const catalogValidation = validateTaskCatalog(options.catalog, options.trustRegistry, { checkedAt: manifest.createdAt })
  const catalog = catalogValidation.catalog
  if (catalog.benchmarkId !== manifest.benchmarkId) fail('MANIFEST_TASK_CATALOG_MISMATCH', 'catalog benchmarkId differs from the manifest')
  exactKeys(manifest.taskCatalogRef, ['catalogId', 'digest', 'taskCount', 'issuer', 'keyId', 'attestationDigest', 'fixtureOnly'], 'MANIFEST_TASK_CATALOG_MISMATCH', 'taskCatalogRef')
  if (manifest.taskCatalogRef.catalogId !== catalog.catalogId || manifest.taskCatalogRef.digest !== catalog.digest || manifest.taskCatalogRef.taskCount !== catalog.tasks.length || manifest.taskCatalogRef.issuer !== catalogValidation.trust.issuer || manifest.taskCatalogRef.keyId !== catalogValidation.trust.keyId || manifest.taskCatalogRef.attestationDigest !== catalogValidation.trust.attestationDigest || manifest.taskCatalogRef.fixtureOnly !== catalogValidation.trust.fixtureOnly) {
    fail('MANIFEST_TASK_CATALOG_MISMATCH', 'manifest task catalog reference does not match the authoritative catalog')
  }
  validateTasks(manifest.tasks, armIds, catalog, { trustRegistry: options.trustRegistry })
  validateManifestLease(manifest.runLease)
  positiveInteger(manifest.repetitions, 'MANIFEST_REPETITIONS_INVALID', 'repetitions')
  if (manifest.repetitions < 3) fail('MANIFEST_REPETITIONS_INVALID', 'at least three repetitions are required')
  validateBudgets(manifest.budgets)
  validateResources(manifest.resources)
  exactKeys(manifest.pricingRef, ['pricingId', 'digest'], 'MANIFEST_PRICING_INVALID', 'pricingRef')
  nonEmpty(manifest.pricingRef.pricingId, 'MANIFEST_PRICING_INVALID', 'pricingRef.pricingId')
  if (!hashPattern(manifest.pricingRef.digest)) fail('MANIFEST_PRICING_INVALID', 'pricingRef.digest must be sha256')
  const expected = buildPlannedAttempts(manifest, { catalog, trustRegistry: options.trustRegistry })
  if (canonicalStringify(manifest.plannedAttempts) !== canonicalStringify(expected)) fail('MANIFEST_ATTEMPTS_INVALID', 'plannedAttempts do not match the preregistered task/arm/repetition matrix')
  const ids = new Set()
  for (const item of manifest.plannedAttempts) {
    if (ids.has(item.attemptId)) fail('MANIFEST_DUPLICATE_ATTEMPT', `duplicate planned attempt: ${item.attemptId}`)
    ids.add(item.attemptId)
  }
  validateCanaries(manifest.canaries, expected.length)
  const expectedOrder = buildExecutionOrder({ ...manifest, plannedAttempts: expected })
  if (canonicalStringify(manifest.executionOrder) !== canonicalStringify(expectedOrder)) fail('MANIFEST_EXECUTION_ORDER_INVALID', 'executionOrder must declare pre, scored, mid, scored, post chronology exactly')
  if (manifest.manifestDigest !== undefined) {
    const expectedDigest = digestRecord(manifest, ['manifestDigest', 'signature'])
    if (!hashPattern(manifest.manifestDigest) || manifest.manifestDigest !== expectedDigest) fail('MANIFEST_DIGEST_MISMATCH', 'manifest digest does not match canonical preregistration bytes')
  }
  if ((manifest.manifestDigest === undefined) !== (manifest.signature === undefined)) fail('MANIFEST_SIGNATURE_INVALID', 'manifest digest and signature must be present together')
  if (manifest.signature !== undefined) {
    exactKeys(manifest.signature, ['algorithm', 'issuer', 'keyId', 'value'], 'MANIFEST_SIGNATURE_INVALID', 'manifest signature')
    if (manifest.signature.algorithm !== 'ed25519') fail('MANIFEST_SIGNATURE_INVALID', 'unsupported manifest signature algorithm')
    nonEmpty(manifest.signature.issuer, 'MANIFEST_SIGNATURE_INVALID', 'signature.issuer')
    nonEmpty(manifest.signature.keyId, 'MANIFEST_SIGNATURE_INVALID', 'signature.keyId')
    nonEmpty(manifest.signature.value, 'MANIFEST_SIGNATURE_INVALID', 'signature.value')
  }
  if (manifest.signature !== undefined && !verifyManifestSignature(manifest, options.trustRegistry)) fail('MANIFEST_SIGNATURE_INVALID', 'manifest signature is invalid')
  return { valid: true, plannedAttempts: expected.length, manifestDigest: manifest.manifestDigest || null }
}

function signManifest(manifest, options) {
  if (!options || !options.signer || !options.catalog || !options.trustRegistry) fail('MANIFEST_SIGNATURE_INVALID', 'manifest signing requires an asymmetric signer, trust registry, and authoritative task catalog')
  const unsigned = { ...manifest }
  delete unsigned.manifestDigest
  delete unsigned.signature
  validateRunManifest(unsigned, { catalog: options.catalog, trustRegistry: options.trustRegistry })
  const manifestDigest = digestRecord(unsigned)
  return Object.freeze({ ...unsigned, manifestDigest, signature: signRoleDigest('manifest', manifestDigest, unsigned.createdAt, options.signer) })
}

function verifyManifestSignature(manifest, trustRegistry) {
  try {
    if (!manifest || !manifest.signature || manifest.signature.algorithm !== 'ed25519') return false
    const digest = digestRecord(manifest, ['manifestDigest', 'signature'])
    if (digest !== manifest.manifestDigest) return false
    requireRoleDigest(trustRegistry, 'manifest', digest, manifest.createdAt, manifest.signature, 'MANIFEST_SIGNATURE_INVALID')
    return true
  } catch { return false }
}

function writeSignedManifest(filename, manifest, options) {
  if (fs.existsSync(filename)) fail('MANIFEST_EXISTS', `signed manifest already exists: ${filename}`)
  const signed = signManifest(manifest, options)
  atomicWriteFile(filename, `${canonicalStringify(signed)}\n`)
  const reopened = loadSignedManifest(filename, options.trustRegistry, options.catalog)
  if (reopened.manifestDigest !== signed.manifestDigest) fail('MANIFEST_DIGEST_MISMATCH', 'persisted manifest digest changed during atomic write')
  return reopened
}

function loadSignedManifest(filename, trustRegistry, catalog) {
  if (!trustRegistry || !catalog) fail('MANIFEST_SIGNATURE_REQUIRED', 'loading a signed manifest requires trusted signer configuration and authoritative task catalog')
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
    fail('MANIFEST_READ_INVALID', `cannot read signed manifest: ${filename}`, { cause: error.message })
  }
  validateRunManifest(manifest, { trustRegistry, catalog })
  return manifest
}

function evaluateCanaries(manifest, results) {
  const expected = buildCanaryAttempts(manifest)
  if (!Array.isArray(results)) fail('CANARY_MISSING', 'canary results are required')
  const byId = new Map()
  for (const result of results) {
    if (!result || typeof result.attemptId !== 'string') fail('CANARY_RESULT_INVALID', 'canary result lacks attemptId')
    if (byId.has(result.attemptId)) fail('CANARY_DUPLICATE', `duplicate canary result: ${result.attemptId}`)
    byId.set(result.attemptId, result)
  }
  for (const plan of expected) {
    const result = byId.get(plan.attemptId)
    if (!result) fail('CANARY_MISSING', `missing canary result: ${plan.attemptId}`)
    if (result.passed !== true) fail('CANARY_FAILED', `canary did not pass: ${plan.attemptId}`)
    if (plan.polarity === 'negative' && result.diagnosis !== plan.expectedDiagnosis) {
      fail('CANARY_DIAGNOSIS_MISMATCH', `negative canary diagnosis mismatch: ${plan.attemptId}`, { expected: plan.expectedDiagnosis, actual: result.diagnosis })
    }
    if (plan.polarity === 'positive' && result.diagnosis !== null && result.diagnosis !== undefined) fail('CANARY_RESULT_INVALID', `positive canary reported a diagnosis: ${plan.attemptId}`)
  }
  const unknown = [...byId.keys()].filter(id => !expected.some(plan => plan.attemptId === id))
  if (unknown.length) fail('CANARY_UNKNOWN', 'unknown canary results', { unknown })
  return { ready: true, expected: expected.length, completed: results.length }
}

module.exports = {
  REQUIRED_NEGATIVE_DIAGNOSES,
  REQUIRED_POSITIVE_CHECKS,
  RESOURCE_FIELDS,
  buildCanaryAttempts,
  buildExecutionOrder,
  buildPlannedAttempts,
  evaluateCanaries,
  loadSignedManifest,
  sealTaskCatalog,
  signManifest,
  validateTaskCatalog,
  validateRunManifest,
  verifyManifestSignature,
  writeSignedManifest,
}
