'use strict'

const {
  canonicalStringify,
  digestRecord,
  exactKeys,
  fail,
  hashPattern,
  isoDate,
  nonEmpty,
  positiveInteger,
} = require('./core.cjs')
const { buildCanaryAttempts, evaluateCanaries, validateRunManifest } = require('./manifest.cjs')
const { describeEvidenceFile, normalizeEvidencePath, readVerifiedJson, resolveContained, validateBlobDescriptor, verifyEvidenceFile } = require('./files.cjs')
const { parseSessionJsonl, validateSessionSet } = require('./sessions.cjs')
const { verifySnapshot } = require('./snapshot.cjs')
const { validateResultBundle } = require('./result-bundle.cjs')
const { deriveCanaryResult, validateCanaryControllerRecord } = require('./canary.cjs')
const { validateVerifierAttestation } = require('./authority.cjs')
const { parseExecutionLedger } = require('./execution-ledger.cjs')
const { createTrustRegistry, requireRoleDigest, signRoleDigest, trustedCatalog, trustedRole } = require('./trust-registry.cjs')

const TERMINAL_STATES = Object.freeze(['PASS', 'FAIL', 'CANCELLED', 'CENSORED', 'CRASH'])
const NONTERMINAL_STATES = Object.freeze(['LIVE', 'ABSENT', 'UNKNOWN'])
const ATTEMPT_KEYS = Object.freeze([
  'schemaVersion', 'manifestDigest', 'attempt', 'resources', 'startedAt', 'endedAt', 'system', 'harbor',
  'result', 'authority', 'artifacts', 'sessions', 'sessionLog', 'costs', 'provenance', 'canary', 'checksum',
])

function executionDescriptors(attempt) {
  const execution = attempt.execution
  if (!execution) fail('EVIDENCE_EXECUTION_INVALID', 'attempt lacks signed execution inputs')
  const descriptors = attempt.attemptClass === 'canary'
    ? [execution.input, execution.fixture, execution.environment, execution.toolchain, ...(execution.faultInjector ? [execution.faultInjector.artifact] : [])]
    : [execution.input, execution.environment, execution.toolchain]
  for (const descriptor of descriptors) validateBlobDescriptor(descriptor, 'EVIDENCE_EXECUTION_INVALID')
  return descriptors
}

function required(value, fields, code, label) {
  exactKeys(value, fields, code, label)
  const missing = fields.filter(field => !Object.hasOwn(value, field))
  if (missing.length) fail(code, `${label} is missing required fields`, { missing })
}

function deriveTerminalState(input) {
  const harbor = input && input.harbor || {}
  const system = input && input.system || {}
  if (system.hostKillTriggered === true) return 'CENSORED'
  if (system.cancelled === true) return 'CANCELLED'
  if ((Number.isInteger(system.exitCode) && system.exitCode !== 0) || system.signal) return 'CRASH'
  if (harbor.status === 'completed') {
    if (harbor.result === 'pass') return 'PASS'
    if (harbor.result === 'fail') return 'FAIL'
    return 'UNKNOWN'
  }
  if (system.containerState === 'running' || harbor.status === 'running') return 'LIVE'
  if (harbor.status === 'absent' && system.containerState === 'absent') return 'ABSENT'
  return 'UNKNOWN'
}

function sealPricing(pricing) {
  const unsigned = { ...pricing }
  delete unsigned.digest
  validatePricing(unsigned, { allowMissingDigest: true })
  return Object.freeze({ ...unsigned, digest: digestRecord(unsigned) })
}

function modelPriceKey(identity) {
  if (!identity || typeof identity.provider !== 'string' || !identity.provider || typeof identity.model !== 'string' || !identity.model || typeof identity.version !== 'string' || !identity.version) fail('PRICING_SCHEMA_INVALID', 'model price identity is incomplete')
  return digestRecord({ provider: identity.provider, model: identity.model, version: identity.version })
}

function validatePricing(pricing, options = {}) {
  required(pricing, ['schemaVersion', 'pricingId', 'effectiveAt', 'currency', 'models', 'host', 'storage', 'setup', ...(options.allowMissingDigest ? [] : ['digest'])], 'PRICING_SCHEMA_INVALID', 'pricing')
  if (pricing.schemaVersion !== 'benchmark-pricing.v2') fail('PRICING_SCHEMA_INVALID', 'unsupported pricing schema')
  nonEmpty(pricing.pricingId, 'PRICING_SCHEMA_INVALID', 'pricingId')
  isoDate(pricing.effectiveAt, 'PRICING_SCHEMA_INVALID', 'effectiveAt')
  nonEmpty(pricing.currency, 'PRICING_SCHEMA_INVALID', 'currency')
  if (!pricing.models || typeof pricing.models !== 'object' || Array.isArray(pricing.models) || !Object.keys(pricing.models).length) fail('PRICING_SCHEMA_INVALID', 'model pricing must be a non-empty identity-keyed object')
  for (const [key, model] of Object.entries(pricing.models)) {
    if (!hashPattern(key)) fail('PRICING_SCHEMA_INVALID', 'model pricing key must be the canonical identity digest')
    required(model, ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion', 'reasoningPerMillion'], 'PRICING_SCHEMA_INVALID', 'model price')
    for (const field of ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion', 'reasoningPerMillion']) {
      if (typeof model[field] !== 'number' || !Number.isFinite(model[field]) || model[field] < 0) fail('PRICING_SCHEMA_INVALID', `${field} must be a non-negative finite number`)
    }
  }
  for (const [name, value, field] of [
    ['host', pricing.host, 'perSecond'], ['storage', pricing.storage, 'perByteMonth'], ['setup', pricing.setup, 'perUnit'],
  ]) {
    required(value, [field], 'PRICING_SCHEMA_INVALID', name)
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0) fail('PRICING_SCHEMA_INVALID', `${name}.${field} must be non-negative`)
  }
  if (!options.allowMissingDigest && (!hashPattern(pricing.digest) || pricing.digest !== digestRecord(pricing, ['digest']))) fail('PRICING_DIGEST_MISMATCH', 'pricing digest is invalid')
  return pricing
}

function sealAttempt(record) {
  const unsigned = { ...record }
  delete unsigned.checksum
  return Object.freeze({ ...unsigned, checksum: digestRecord(unsigned) })
}

function systemCore(system) {
  return {
    containerState: system.containerState,
    exitCode: system.exitCode,
    signal: system.signal,
    hostKillTriggered: system.hostKillTriggered,
    cancelled: system.cancelled,
    hostKill: {
      enforcer: system.hostKill.enforcer,
      deadlineAt: system.hostKill.deadlineAt,
      triggeredAt: system.hostKill.triggeredAt,
    },
  }
}

function harborCore(harbor) {
  return {
    status: harbor.status,
    result: harbor.result,
    reward: harbor.reward,
    grader: harbor.grader === null ? null : { verdict: harbor.grader.verdict, score: harbor.grader.score },
  }
}

function resourceCore(resources) {
  return {
    instanceId: resources.instanceId,
    bucket: resources.bucket,
    runRoot: resources.runRoot,
    containerNamespace: resources.containerNamespace,
    trialPrefix: resources.trialPrefix,
  }
}

function validateSystem(record, manifest, evidenceRoot) {
  const system = record.system
  required(system, ['containerState', 'exitCode', 'signal', 'hostKillTriggered', 'cancelled', 'hostKill', 'evidence'], 'EVIDENCE_SYSTEM_INVALID', 'system evidence')
  if (!['running', 'exited', 'absent'].includes(system.containerState)) fail('EVIDENCE_SYSTEM_INVALID', 'containerState is invalid')
  if (system.exitCode !== null && !Number.isSafeInteger(system.exitCode)) fail('EVIDENCE_SYSTEM_INVALID', 'exitCode must be null or an integer')
  if (system.signal !== null && (typeof system.signal !== 'string' || !system.signal)) fail('EVIDENCE_SYSTEM_INVALID', 'signal must be null or non-empty')
  if (typeof system.hostKillTriggered !== 'boolean' || typeof system.cancelled !== 'boolean') fail('EVIDENCE_SYSTEM_INVALID', 'system booleans are required')
  required(system.hostKill, ['enforcer', 'deadlineAt', 'triggeredAt', 'evidence'], 'EVIDENCE_HOST_KILL_INVALID', 'host kill evidence')
  if (system.hostKill.enforcer !== 'external-process') fail('EVIDENCE_HOST_KILL_INVALID', 'host kill must be enforced by an external process')
  isoDate(system.hostKill.deadlineAt, 'EVIDENCE_HOST_KILL_INVALID', 'deadlineAt')
  isoDate(system.hostKill.triggeredAt, 'EVIDENCE_HOST_KILL_INVALID', 'triggeredAt', { nullable: true })
  const expectedDeadline = new Date(Date.parse(record.startedAt) + manifest.budgets.hostKillMs).toISOString()
  if (system.hostKill.deadlineAt !== expectedDeadline) fail('EVIDENCE_HOST_KILL_INVALID', 'host kill deadline differs from the signed manifest budget')
  if (system.hostKillTriggered !== (system.hostKill.triggeredAt !== null)) fail('EVIDENCE_HOST_KILL_INVALID', 'host kill trigger and evidence disagree')
  if (system.hostKillTriggered && system.hostKill.triggeredAt !== system.hostKill.deadlineAt) fail('EVIDENCE_HOST_KILL_INVALID', 'external host kill must trigger at the signed deadline')
  if (record.endedAt && Date.parse(record.endedAt) - Date.parse(record.startedAt) > manifest.budgets.hostKillMs && !system.hostKillTriggered) {
    fail('EVIDENCE_TIMEOUT_EXCEEDED', 'attempt duration exceeded the signed external host-kill deadline')
  }
  if (system.hostKill.triggeredAt && Date.parse(system.hostKill.triggeredAt) > Date.parse(system.hostKill.deadlineAt)) {
    fail('EVIDENCE_TIMEOUT_EXCEEDED', 'external host kill was triggered after the signed deadline')
  }
  validateBlobDescriptor(system.evidence, 'EVIDENCE_SYSTEM_INVALID')
  validateBlobDescriptor(system.hostKill.evidence, 'EVIDENCE_HOST_KILL_INVALID')
  const rawSystem = readVerifiedJson(evidenceRoot, system.evidence, 'EVIDENCE_SYSTEM_INVALID')
  const rawHostKill = readVerifiedJson(evidenceRoot, system.hostKill.evidence, 'EVIDENCE_HOST_KILL_INVALID')
  if (canonicalStringify(rawSystem) !== canonicalStringify(systemCore(system))) fail('EVIDENCE_SYSTEM_INVALID', 'structured system fields differ from raw system evidence')
  if (canonicalStringify(rawHostKill) !== canonicalStringify(systemCore(system).hostKill)) fail('EVIDENCE_HOST_KILL_INVALID', 'structured host-kill fields differ from raw external evidence')
}

function validateHarbor(record, evidenceRoot) {
  const harbor = record.harbor
  required(harbor, ['status', 'result', 'reward', 'grader', 'evidence'], 'EVIDENCE_HARBOR_INVALID', 'Harbor evidence')
  if (!['completed', 'running', 'absent'].includes(harbor.status)) fail('EVIDENCE_HARBOR_INVALID', 'Harbor status is invalid')
  validateBlobDescriptor(harbor.evidence, 'EVIDENCE_HARBOR_INVALID')
  if (harbor.status === 'completed') {
    if (!['pass', 'fail'].includes(harbor.result) || typeof harbor.reward !== 'number' || !Number.isFinite(harbor.reward)) fail('EVIDENCE_HARBOR_INVALID', 'completed Harbor evidence requires result and reward')
    required(harbor.grader, ['verdict', 'score', 'details'], 'EVIDENCE_GRADER_MISSING', 'grader evidence')
    if (!['pass', 'fail'].includes(harbor.grader.verdict) || harbor.grader.verdict !== harbor.result || typeof harbor.grader.score !== 'number' || !Number.isFinite(harbor.grader.score)) fail('EVIDENCE_GRADER_MISMATCH', 'Harbor result and grader verdict must agree')
    validateBlobDescriptor(harbor.grader.details, 'EVIDENCE_GRADER_MISSING')
    verifyEvidenceFile(evidenceRoot, harbor.grader.details, 'EVIDENCE_GRADER_MISSING')
  } else if (harbor.result !== null || harbor.reward !== null || harbor.grader !== null) {
    fail('EVIDENCE_HARBOR_INVALID', 'non-completed Harbor evidence cannot contain a result, reward, or grader')
  }
  const rawHarbor = readVerifiedJson(evidenceRoot, harbor.evidence, 'EVIDENCE_HARBOR_INVALID')
  if (canonicalStringify(rawHarbor) !== canonicalStringify(harborCore(harbor))) fail('EVIDENCE_HARBOR_INVALID', 'structured Harbor fields differ from raw Harbor evidence')
}

function validateSnapshotBinding(record, manifest, evidenceRoot, descriptors, snapshotCache = new Map()) {
  const provenance = record.provenance
  if (provenance.kind === 'live-partial') {
    required(provenance, ['kind', 'observedAt', 'sourceRunId', 'sourceRelativePath'], 'EVIDENCE_PROVENANCE_INVALID', 'live provenance')
    nonEmpty(provenance.sourceRunId, 'EVIDENCE_PROVENANCE_INVALID', 'sourceRunId')
    isoDate(provenance.observedAt, 'EVIDENCE_PROVENANCE_INVALID', 'observedAt')
    const source = resolveContained(evidenceRoot, provenance.sourceRelativePath, { directory: true })
    const prefix = `${source.relativePath}/`
    for (const descriptor of descriptors) {
      if (!descriptor.relativePath.startsWith(prefix)) fail('EVIDENCE_PROVENANCE_INVALID', `evidence blob is outside its live source: ${descriptor.relativePath}`)
    }
    return []
  }
  required(provenance, ['kind', 'snapshotId', 'snapshotDigest', 'snapshotRelativePath', 'observedAt'], 'EVIDENCE_PROVENANCE_INVALID', 'immutable provenance')
  if (provenance.kind !== 'immutable-snapshot') fail('EVIDENCE_PROVENANCE_INVALID', 'unknown provenance kind')
  nonEmpty(provenance.snapshotId, 'EVIDENCE_PROVENANCE_INVALID', 'snapshotId')
  if (!hashPattern(provenance.snapshotDigest)) fail('EVIDENCE_PROVENANCE_INVALID', 'snapshotDigest must be sha256')
  isoDate(provenance.observedAt, 'EVIDENCE_PROVENANCE_INVALID', 'observedAt')
  const snapshot = resolveContained(evidenceRoot, provenance.snapshotRelativePath, { directory: true })
  const cacheKey = `${snapshot.resolved}\u0000${provenance.snapshotDigest}`
  const verified = snapshotCache.get(cacheKey) || verifySnapshot(snapshot.resolved).manifest
  snapshotCache.set(cacheKey, verified)
  if (verified.snapshotId !== provenance.snapshotId || verified.digest !== provenance.snapshotDigest || verified.manifestDigest !== manifest.manifestDigest) {
    fail('EVIDENCE_PROVENANCE_INVALID', 'attempt provenance does not match the opened immutable snapshot')
  }
  const prefix = `${snapshot.relativePath}/`
  for (const descriptor of descriptors) {
    if (!descriptor.relativePath.startsWith(prefix)) fail('EVIDENCE_PROVENANCE_INVALID', `evidence blob is outside its immutable snapshot: ${descriptor.relativePath}`)
  }
  return [
    ...verified.files.map(file => ({ relativePath: `${snapshot.relativePath}/${file.path}`, sha256: file.sha256, bytes: file.bytes })),
    describeEvidenceFile(evidenceRoot, `${snapshot.relativePath}/snapshot-manifest.json`),
  ]
}

function validateAttemptShape(record, manifest, options = {}) {
  required(record, ATTEMPT_KEYS, 'EVIDENCE_SCHEMA_INVALID', 'attempt evidence')
  if (!options.evidenceRoot) fail('EVIDENCE_ROOT_REQUIRED', 'attempt validation requires a contained evidence root')
  if (record.schemaVersion !== 'benchmark-attempt-evidence.v2') fail('EVIDENCE_SCHEMA_INVALID', 'unsupported attempt evidence schema')
  if (!hashPattern(record.checksum) || record.checksum !== digestRecord(record, ['checksum'])) fail('CHECKSUM_MISMATCH', `attempt checksum mismatch: ${record.attempt && record.attempt.attemptId}`)
  if (record.manifestDigest !== manifest.manifestDigest) fail('EVIDENCE_MANIFEST_MISMATCH', 'attempt is bound to another manifest')
  required(record.resources, ['instanceId', 'bucket', 'runRoot', 'containerNamespace', 'trialPrefix', 'evidence'], 'EVIDENCE_RESOURCE_MISMATCH', 'resource consumption')
  if (canonicalStringify(resourceCore(record.resources)) !== canonicalStringify(manifest.resources)) fail('EVIDENCE_RESOURCE_MISMATCH', 'attempt resources differ from the signed manifest')
  validateBlobDescriptor(record.resources.evidence, 'EVIDENCE_RESOURCE_MISMATCH')
  const rawResources = readVerifiedJson(options.evidenceRoot, record.resources.evidence, 'EVIDENCE_RESOURCE_MISMATCH')
  if (canonicalStringify(rawResources) !== canonicalStringify(manifest.resources)) fail('EVIDENCE_RESOURCE_MISMATCH', 'raw resource consumption differs from the signed manifest')
  isoDate(record.startedAt, 'EVIDENCE_SCHEMA_INVALID', 'startedAt')
  isoDate(record.endedAt, 'EVIDENCE_SCHEMA_INVALID', 'endedAt', { nullable: true })
  if (record.endedAt && Date.parse(record.endedAt) < Date.parse(record.startedAt)) fail('EVIDENCE_SCHEMA_INVALID', 'attempt ends before it starts')
  if (!record.attempt || !['scored', 'repair', 'canary'].includes(record.attempt.attemptClass)) fail('EVIDENCE_SCHEMA_INVALID', 'attemptClass must be scored, repair, or canary')
  const attemptFields = record.attempt.attemptClass === 'scored'
    ? ['attemptId', 'attemptClass', 'taskId', 'armId', 'repetition', 'pairedOrder', 'execution']
    : record.attempt.attemptClass === 'repair'
      ? ['attemptId', 'attemptClass', 'repairOfAttemptId', 'taskId', 'armId', 'repetition']
      : ['attemptId', 'attemptClass', 'armId', 'repetition', 'stage', 'canaryId', 'polarity', 'checks', 'execution']
  if (record.attempt.attemptClass === 'canary') {
    exactKeys(record.attempt, [...attemptFields, 'expectedDiagnosis'], 'EVIDENCE_SCHEMA_INVALID', 'canary attempt')
    const missing = attemptFields.filter(field => !Object.hasOwn(record.attempt, field))
    if (missing.length) fail('EVIDENCE_SCHEMA_INVALID', 'canary attempt is missing required fields', { missing })
    if (record.attempt.polarity === 'negative' && !Object.hasOwn(record.attempt, 'expectedDiagnosis')) fail('EVIDENCE_SCHEMA_INVALID', 'negative canary requires expectedDiagnosis')
    if (record.attempt.polarity === 'positive' && Object.hasOwn(record.attempt, 'expectedDiagnosis')) fail('EVIDENCE_SCHEMA_INVALID', 'positive canary cannot declare expectedDiagnosis')
  } else required(record.attempt, attemptFields, 'EVIDENCE_SCHEMA_INVALID', `${record.attempt.attemptClass} attempt`)
  nonEmpty(record.attempt.attemptId, 'EVIDENCE_SCHEMA_INVALID', 'attemptId')
  nonEmpty(record.attempt.armId, 'EVIDENCE_SCHEMA_INVALID', 'armId')
  if (!manifest.arms.some(arm => arm.armId === record.attempt.armId)) fail('EVIDENCE_UNKNOWN', `unknown arm: ${record.attempt.armId}`)
  if (record.attempt.attemptClass !== 'canary') positiveInteger(record.attempt.repetition, 'EVIDENCE_SCHEMA_INVALID', 'repetition')

  validateSystem(record, manifest, options.evidenceRoot)
  validateHarbor(record, options.evidenceRoot)
  const terminalState = deriveTerminalState(record)
  if (terminalState === 'UNKNOWN') fail('EVIDENCE_TERMINAL_INVALID', 'attempt terminal state is unclassified')
  const terminal = TERMINAL_STATES.includes(terminalState)
  if (terminal && record.endedAt === null) fail('EVIDENCE_TERMINAL_INVALID', 'terminal attempt requires endedAt')
  if (!terminal && record.endedAt !== null) fail('EVIDENCE_TERMINAL_INVALID', 'nonterminal attempt cannot have endedAt')
  if (NONTERMINAL_STATES.includes(terminalState) && record.provenance.kind !== 'live-partial') fail('EVIDENCE_PROVENANCE_INVALID', 'nonterminal evidence must be live-partial')
  if (terminal && record.provenance.kind !== 'immutable-snapshot') fail('EVIDENCE_PROVENANCE_INVALID', 'terminal evidence must come from an immutable snapshot')

  const descriptors = [record.resources.evidence, record.system.evidence, record.system.hostKill.evidence, record.harbor.evidence]
  const executionEvidence = []
  for (const descriptor of executionDescriptors(record.attempt)) {
    verifyEvidenceFile(options.evidenceRoot, descriptor, 'EVIDENCE_EXECUTION_INVALID')
    executionEvidence.push(descriptor)
  }
  if (record.harbor.grader) descriptors.push(record.harbor.grader.details)
  if (['PASS', 'FAIL'].includes(terminalState) && record.attempt.attemptClass === 'scored') {
    if (!record.result) fail('EVIDENCE_RESULT_MISSING', 'scored pass/fail requires canonical result bytes')
  } else if (record.result !== null) fail('EVIDENCE_RESULT_INVALID', 'only scored pass/fail attempts may carry a canonical result')
  if (record.result) {
    if (!record.authority) fail('VERIFIER_ATTESTATION_MISSING', 'scored pass/fail requires controller-owned verifier attestation')
    validateBlobDescriptor(record.authority, 'VERIFIER_ATTESTATION_INVALID')
    const attestation = readVerifiedJson(options.evidenceRoot, record.authority, 'VERIFIER_ATTESTATION_INVALID')
    const producer = manifest.arms.find(arm => arm.armId === record.attempt.armId).producer
    const authority = validateVerifierAttestation(attestation, options.trustRegistry, {
      manifestDigest: manifest.manifestDigest,
      taskId: record.attempt.taskId,
      attemptId: record.attempt.attemptId,
      verdict: record.harbor.result,
      reward: record.harbor.reward,
      grader: { verdict: record.harbor.grader.verdict, score: record.harbor.grader.score },
      producer,
      rawHarborSha256: record.harbor.evidence.sha256,
      verifierSha256: record.harbor.grader.details.sha256,
      resourceEvidenceSha256: record.resources.evidence.sha256,
    })
    validateBlobDescriptor(record.result, 'EVIDENCE_RESULT_MISSING')
    const bundle = readVerifiedJson(options.evidenceRoot, record.result, 'EVIDENCE_RESULT_MISSING')
    validateResultBundle(bundle, {
      manifestDigest: manifest.manifestDigest,
      taskId: record.attempt.taskId,
      attemptId: record.attempt.attemptId,
      verdict: record.harbor.result,
      reward: record.harbor.reward,
      grader: { verdict: record.harbor.grader.verdict, score: record.harbor.grader.score },
      producer,
      rawHarborSha256: record.harbor.evidence.sha256,
      verifierSha256: record.harbor.grader.details.sha256,
      resourceEvidenceSha256: record.resources.evidence.sha256,
      authorityAttestationSha256: record.authority.sha256,
      authoritySignatureSha256: authority.signatureDigest,
    })
    descriptors.push(record.authority, record.result)
  } else if (record.authority !== null) fail('VERIFIER_ATTESTATION_INVALID', 'only scored pass/fail attempts may carry verifier authority')
  if (!Array.isArray(record.artifacts) || !record.artifacts.length) fail('EVIDENCE_ARTIFACTS_MISSING', 'content-addressed artifacts are required')
  const artifactPaths = new Set()
  for (const artifact of record.artifacts) {
    validateBlobDescriptor(artifact, 'EVIDENCE_ARTIFACT_INVALID')
    if (artifactPaths.has(artifact.relativePath)) fail('EVIDENCE_ARTIFACT_INVALID', `duplicate artifact: ${artifact.relativePath}`)
    artifactPaths.add(artifact.relativePath)
    verifyEvidenceFile(options.evidenceRoot, artifact, 'EVIDENCE_ARTIFACT_INVALID')
    descriptors.push(artifact)
  }
  validateBlobDescriptor(record.sessionLog, 'SESSION_LOG_INVALID')
  const sessionBytes = verifyEvidenceFile(options.evidenceRoot, record.sessionLog, 'SESSION_LOG_INVALID').bytes
  const parsedSessions = parseSessionJsonl(sessionBytes, { attemptId: record.attempt.attemptId })
  validateSessionSet(record.sessions, { attemptId: record.attempt.attemptId })
  if (canonicalStringify(parsedSessions) !== canonicalStringify(record.sessions)) fail('SESSION_LOG_MISMATCH', 'embedded sessions differ from the opened session JSONL')
  descriptors.push(record.sessionLog)
  required(record.costs, ['hostSeconds', 'storageByteMonths', 'setupUnits'], 'EVIDENCE_COST_INVALID', 'cost evidence')
  for (const field of ['hostSeconds', 'storageByteMonths', 'setupUnits']) {
    if (typeof record.costs[field] !== 'number' || !Number.isFinite(record.costs[field]) || record.costs[field] < 0) fail('EVIDENCE_COST_INVALID', `${field} must be non-negative`)
  }
  if (record.attempt.attemptClass === 'canary') {
    required(record.canary, ['passed', 'diagnosis', 'evidence', 'controllerEvidence'], 'CANARY_RESULT_INVALID', 'canary result')
    if (record.canary.passed !== true) fail('CANARY_FAILED', `canary failed: ${record.attempt.attemptId}`)
    if (record.attempt.polarity === 'negative' && record.canary.diagnosis !== record.attempt.expectedDiagnosis) fail('CANARY_DIAGNOSIS_MISMATCH', 'negative canary diagnosis differs from its preregistration')
    if (record.attempt.polarity === 'positive' && record.canary.diagnosis !== null) fail('CANARY_RESULT_INVALID', 'positive canary cannot report a diagnosis')
    validateBlobDescriptor(record.canary.evidence, 'CANARY_RESULT_INVALID')
    validateBlobDescriptor(record.canary.controllerEvidence, 'CANARY_CONTROLLER_INVALID')
    const rawCanary = readVerifiedJson(options.evidenceRoot, record.canary.evidence, 'CANARY_RESULT_INVALID')
    const derived = deriveCanaryResult(record.attempt, rawCanary)
    if (canonicalStringify(derived) !== canonicalStringify({ passed: record.canary.passed, diagnosis: record.canary.diagnosis })) fail('CANARY_RESULT_INVALID', 'structured canary result differs from independently derived observations')
    const controllerRecord = readVerifiedJson(options.evidenceRoot, record.canary.controllerEvidence, 'CANARY_CONTROLLER_INVALID')
    validateCanaryControllerRecord(controllerRecord, manifest.manifestDigest, record.attempt, record.canary.evidence, options.trustRegistry)
    descriptors.push(record.canary.evidence, record.canary.controllerEvidence)
  } else if (record.canary !== null) fail('CANARY_RESULT_INVALID', 'non-canary attempt cannot carry canary results')
  const snapshotObjects = validateSnapshotBinding(record, manifest, options.evidenceRoot, descriptors, options.snapshotCache)
  return { record, terminalState, descriptors: [...descriptors, ...executionEvidence], snapshotObjects }
}

function modelCost(session, pricing) {
  const match = pricing.models[modelPriceKey({ provider: session.model.provider, model: session.model.name, version: session.model.version })]
  if (!match) fail('PRICING_MODEL_MISSING', `no versioned price for ${session.model.provider}/${session.model.name}/${session.model.version}`)
  const uncached = session.usage.inputTokens - session.usage.cachedInputTokens
  return (uncached * match.inputPerMillion + session.usage.cachedInputTokens * match.cachedInputPerMillion + session.usage.outputTokens * match.outputPerMillion + session.usage.reasoningTokens * match.reasoningPerMillion) / 1_000_000
}

function emptyCost() { return { model: 0, host: 0, storage: 0, setup: 0, canary: 0, repair: 0, scoredRun: 0, total: 0 } }

function emptyTokens() { return { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 } }

function addAttemptCost(target, record, pricing) {
  const model = record.sessions.reduce((sum, session) => sum + modelCost(session, pricing), 0)
  const host = record.costs.hostSeconds * pricing.host.perSecond
  const storage = record.costs.storageByteMonths * pricing.storage.perByteMonth
  const setup = record.costs.setupUnits * pricing.setup.perUnit
  const total = model + host + storage + setup
  target.model += model; target.host += host; target.storage += storage; target.setup += setup; target.total += total
  if (record.attempt.attemptClass === 'canary') target.canary += total
  if (record.attempt.attemptClass === 'repair') target.repair += total
  if (record.attempt.attemptClass === 'scored') target.scoredRun += total
}

function addAttemptTokens(target, record) {
  for (const session of record.sessions) {
    target.noncachedInput += session.usage.inputTokens - session.usage.cachedInputTokens
    target.cachedInput += session.usage.cachedInputTokens
    target.output += session.usage.outputTokens
    target.reasoning += session.usage.reasoningTokens
  }
}

function aggregateSpans(attempts) {
  const result = { planning: 0, execution: 0, review: 0, repair: 0, unknown: 0 }
  for (const attempt of attempts) for (const session of attempt.sessions) for (const span of session.spans) result[span.kind] += Date.parse(span.endedAt) - Date.parse(span.startedAt)
  return result
}

function collectEvidenceObjects(validated, extra = []) {
  const byPath = new Map()
  for (const descriptor of [...validated.flatMap(checked => [...checked.descriptors, ...checked.snapshotObjects]), ...extra]) {
    const object = { digest: descriptor.sha256, relativePath: descriptor.relativePath }
    const previous = byPath.get(object.relativePath)
    if (previous && previous.digest !== object.digest) fail('EVIDENCE_OBJECT_COLLISION', `one evidence path has multiple digests: ${object.relativePath}`)
    byPath.set(object.relativePath, object)
  }
  return [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.digest.localeCompare(b.digest))
}

function validateObservedChronology(manifest, validated) {
  const byId = new Map(validated.map(item => [item.record.attempt.attemptId, item.record]))
  const scoredIds = manifest.plannedAttempts.map(item => item.attemptId)
  const midpoint = manifest.canaries.midAfterScoredAttempts
  const canaryIds = stage => buildCanaryAttempts(manifest).filter(item => item.stage === stage).map(item => item.attemptId)
  const groups = [canaryIds('pre'), scoredIds.slice(0, midpoint), canaryIds('mid'), scoredIds.slice(midpoint), canaryIds('post')]
  for (let index = 0; index < groups.length - 1; index += 1) {
    const before = groups[index].map(id => byId.get(id)).filter(record => record && record.endedAt !== null)
    const after = groups[index + 1].map(id => byId.get(id)).filter(record => record && record.startedAt)
    if (!before.length || !after.length) continue
    const latestEnd = Math.max(...before.map(record => Date.parse(record.endedAt)))
    const earliestStart = Math.min(...after.map(record => Date.parse(record.startedAt)))
    if (latestEnd >= earliestStart) fail('EVIDENCE_CHRONOLOGY_INVALID', 'observed attempt times require strict separation across signed pre, scored, mid, scored, post chronology', { boundary: index })
  }
}

const AGGREGATE_FIELDS = Object.freeze([
  'schemaVersion', 'generatedAt', 'manifestId', 'manifestDigest', 'catalog', 'pricing', 'attempts', 'terminalStates',
  'costsByArm', 'tokensByArm', 'costPerAcceptedSolve', 'spansMs', 'livePartial', 'controlledEffectEligible', 'analysisClass', 'canarySummary',
  'claimProvenance', 'executionLedger', 'reconstructionInputs', 'trustMetadata', 'evidenceObjects', 'reportDigest', 'signature',
])

function validateAggregateReport(report, trustRegistry) {
  required(report, AGGREGATE_FIELDS, 'AGGREGATE_REPORT_INVALID', 'aggregate report')
  if (report.schemaVersion !== 'benchmark-aggregate.v2') fail('AGGREGATE_REPORT_INVALID', 'unsupported aggregate report schema')
  isoDate(report.generatedAt, 'AGGREGATE_REPORT_INVALID', 'generatedAt')
  nonEmpty(report.manifestId, 'AGGREGATE_REPORT_INVALID', 'manifestId')
  if (!hashPattern(report.manifestDigest) || !hashPattern(report.reportDigest) || report.reportDigest !== digestRecord(report, ['reportDigest', 'signature'])) fail('AGGREGATE_REPORT_INVALID', 'aggregate report digest or manifest digest is invalid')
  required(report.catalog, ['catalogId', 'digest', 'taskCount', 'issuer', 'keyId', 'fixtureOnly'], 'AGGREGATE_REPORT_INVALID', 'aggregate catalog')
  required(report.pricing, ['pricingId', 'digest', 'currency'], 'AGGREGATE_REPORT_INVALID', 'aggregate pricing')
  for (const [value, label] of [[report.catalog.catalogId, 'catalogId'], [report.catalog.issuer, 'catalog issuer'], [report.catalog.keyId, 'catalog keyId'], [report.pricing.pricingId, 'pricingId'], [report.pricing.currency, 'pricing currency']]) nonEmpty(value, 'AGGREGATE_REPORT_INVALID', label)
  if (!hashPattern(report.catalog.digest) || !Number.isSafeInteger(report.catalog.taskCount) || report.catalog.taskCount < 1 || typeof report.catalog.fixtureOnly !== 'boolean' || !hashPattern(report.pricing.digest)) fail('AGGREGATE_REPORT_INVALID', 'aggregate catalog or pricing metadata is invalid')
  required(report.attempts, ['total', 'scored', 'repairs', 'canaries', 'censored'], 'AGGREGATE_REPORT_INVALID', 'aggregate attempts')
  for (const value of Object.values(report.attempts)) if (!Number.isSafeInteger(value) || value < 0) fail('AGGREGATE_REPORT_INVALID', 'aggregate attempt counts must be non-negative integers')
  if (report.attempts.total !== report.attempts.scored + report.attempts.repairs + report.attempts.canaries || report.attempts.censored > report.attempts.scored) fail('AGGREGATE_REPORT_INVALID', 'aggregate attempt count relations are invalid')
  exactKeys(report.terminalStates, [...TERMINAL_STATES, ...NONTERMINAL_STATES], 'AGGREGATE_REPORT_INVALID', 'aggregate terminal states')
  for (const value of Object.values(report.terminalStates)) if (!Number.isSafeInteger(value) || value < 0) fail('AGGREGATE_REPORT_INVALID', 'aggregate terminal state counts are invalid')
  if (!report.costsByArm || typeof report.costsByArm !== 'object' || Array.isArray(report.costsByArm) || !Object.keys(report.costsByArm).length) fail('AGGREGATE_REPORT_INVALID', 'aggregate costsByArm is invalid')
  for (const costs of Object.values(report.costsByArm)) {
    required(costs, ['model', 'host', 'storage', 'setup', 'canary', 'repair', 'scoredRun', 'total'], 'AGGREGATE_REPORT_INVALID', 'aggregate arm costs')
    if (Object.values(costs).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail('AGGREGATE_REPORT_INVALID', 'aggregate arm costs must be non-negative finite numbers')
  }
  required(report.tokensByArm, Object.keys(report.costsByArm), 'AGGREGATE_REPORT_INVALID', 'aggregate tokens by arm')
  for (const tokens of Object.values(report.tokensByArm)) {
    required(tokens, ['noncachedInput', 'cachedInput', 'output', 'reasoning'], 'AGGREGATE_REPORT_INVALID', 'aggregate arm tokens')
    if (Object.values(tokens).some(value => !Number.isSafeInteger(value) || value < 0)) fail('AGGREGATE_REPORT_INVALID', 'aggregate arm tokens must be non-negative safe integers')
  }
  required(report.costPerAcceptedSolve, Object.keys(report.costsByArm), 'AGGREGATE_REPORT_INVALID', 'aggregate cost per accepted solve')
  if (Object.values(report.costPerAcceptedSolve).some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) fail('AGGREGATE_REPORT_INVALID', 'aggregate cost per accepted solve must be null or a non-negative finite number')
  required(report.spansMs, ['planning', 'execution', 'review', 'repair', 'unknown'], 'AGGREGATE_REPORT_INVALID', 'aggregate spans')
  if (Object.values(report.spansMs).some(value => !Number.isSafeInteger(value) || value < 0)) fail('AGGREGATE_REPORT_INVALID', 'aggregate spans are invalid')
  required(report.canarySummary, ['ready', 'expected', 'completed', 'terminalImmutable', 'digest'], 'AGGREGATE_REPORT_INVALID', 'aggregate canary summary')
  if (typeof report.canarySummary.ready !== 'boolean' || typeof report.canarySummary.terminalImmutable !== 'boolean' || !Number.isSafeInteger(report.canarySummary.expected) || !Number.isSafeInteger(report.canarySummary.completed) || !hashPattern(report.canarySummary.digest)) fail('AGGREGATE_REPORT_INVALID', 'aggregate canary summary is invalid')
  required(report.claimProvenance, ['immutable', 'livePartial'], 'AGGREGATE_REPORT_INVALID', 'claim provenance')
  if (!Array.isArray(report.claimProvenance.immutable) || !Array.isArray(report.claimProvenance.livePartial)) fail('AGGREGATE_REPORT_INVALID', 'claim provenance lists are invalid')
  for (const item of report.claimProvenance.immutable) {
    required(item, ['attemptId', 'observedAt', 'sessionIds', 'snapshotId', 'snapshotDigest'], 'AGGREGATE_REPORT_INVALID', 'immutable claim provenance')
    for (const [value, label] of [[item.attemptId, 'claim attemptId'], [item.snapshotId, 'claim snapshotId']]) nonEmpty(value, 'AGGREGATE_REPORT_INVALID', label)
    isoDate(item.observedAt, 'AGGREGATE_REPORT_INVALID', 'claim observedAt')
    if (!hashPattern(item.snapshotDigest) || !Array.isArray(item.sessionIds) || item.sessionIds.some(value => typeof value !== 'string' || !value) || new Set(item.sessionIds).size !== item.sessionIds.length) fail('AGGREGATE_REPORT_INVALID', 'immutable claim provenance is invalid')
  }
  for (const item of report.claimProvenance.livePartial) {
    required(item, ['attemptId', 'observedAt', 'sessionIds', 'sourceRunId', 'sourceRelativePath'], 'AGGREGATE_REPORT_INVALID', 'live claim provenance')
    for (const [value, label] of [[item.attemptId, 'claim attemptId'], [item.sourceRunId, 'claim sourceRunId']]) nonEmpty(value, 'AGGREGATE_REPORT_INVALID', label)
    isoDate(item.observedAt, 'AGGREGATE_REPORT_INVALID', 'claim observedAt')
    try { normalizeEvidencePath(item.sourceRelativePath) } catch { fail('AGGREGATE_REPORT_INVALID', 'live claim source path is unsafe') }
    if (!Array.isArray(item.sessionIds) || item.sessionIds.some(value => typeof value !== 'string' || !value) || new Set(item.sessionIds).size !== item.sessionIds.length) fail('AGGREGATE_REPORT_INVALID', 'live claim provenance is invalid')
  }
  required(report.executionLedger, ['relativePath', 'sha256', 'bytes', 'entries', 'complete'], 'AGGREGATE_REPORT_INVALID', 'execution ledger summary')
  validateBlobDescriptor({ relativePath: report.executionLedger.relativePath, sha256: report.executionLedger.sha256, bytes: report.executionLedger.bytes }, 'AGGREGATE_REPORT_INVALID')
  if (!Number.isSafeInteger(report.executionLedger.entries) || report.executionLedger.entries < 0 || typeof report.executionLedger.complete !== 'boolean') fail('AGGREGATE_REPORT_INVALID', 'execution ledger summary is invalid')
  required(report.reconstructionInputs, ['manifest', 'catalog', 'pricing', 'trustRegistry'], 'AGGREGATE_REPORT_INVALID', 'aggregate reconstruction inputs')
  for (const [name, descriptor] of Object.entries(report.reconstructionInputs)) validateBlobDescriptor(descriptor, 'AGGREGATE_REPORT_INVALID', `aggregate reconstruction input ${name}`)
  required(report.trustMetadata, ['catalog', 'manifest', 'aggregate', 'providerReceipt', 'verifier', 'controller', 'fixtureOnly'], 'AGGREGATE_REPORT_INVALID', 'aggregate trust metadata')
  for (const role of ['catalog', 'manifest', 'aggregate', 'providerReceipt', 'verifier', 'controller']) {
    required(report.trustMetadata[role], ['issuer', 'keyId', 'fixtureOnly'], 'AGGREGATE_REPORT_INVALID', `aggregate trust ${role}`)
    nonEmpty(report.trustMetadata[role].issuer, 'AGGREGATE_REPORT_INVALID', `${role} issuer`)
    nonEmpty(report.trustMetadata[role].keyId, 'AGGREGATE_REPORT_INVALID', `${role} keyId`)
    if (typeof report.trustMetadata[role].fixtureOnly !== 'boolean') fail('AGGREGATE_REPORT_INVALID', `${role} fixtureOnly must be boolean`)
  }
  if (typeof report.trustMetadata.fixtureOnly !== 'boolean' || typeof report.livePartial !== 'boolean' || typeof report.controlledEffectEligible !== 'boolean' || !['controlled-effects', 'descriptive-only'].includes(report.analysisClass)) fail('AGGREGATE_REPORT_INVALID', 'aggregate classification fields are invalid')
  if (!Array.isArray(report.evidenceObjects)) fail('AGGREGATE_REPORT_INVALID', 'aggregate evidenceObjects must be an array')
  const paths = new Set()
  for (const object of report.evidenceObjects) {
    exactKeys(object, ['digest', 'relativePath'], 'AGGREGATE_REPORT_INVALID', 'aggregate evidence object')
    try { normalizeEvidencePath(object.relativePath) } catch { fail('AGGREGATE_REPORT_INVALID', 'aggregate evidence object path is unsafe') }
    if (!hashPattern(object.digest) || paths.has(object.relativePath)) fail('AGGREGATE_REPORT_INVALID', 'aggregate evidence object is invalid or duplicated')
    paths.add(object.relativePath)
  }
  for (const descriptor of Object.values(report.reconstructionInputs)) {
    if (!report.evidenceObjects.some(object => object.relativePath === descriptor.relativePath && object.digest === descriptor.sha256)) fail('AGGREGATE_REPORT_INVALID', 'reconstruction input is absent from the exact evidence object closure')
  }
  const catalogTrust = trustedCatalog(trustRegistry, report.catalog.catalogId)
  const expectedTrust = {
    catalog: catalogTrust,
    manifest: trustedRole(trustRegistry, 'manifest'), aggregate: trustedRole(trustRegistry, 'aggregate'),
    providerReceipt: trustedRole(trustRegistry, 'provider-receipt'), verifier: trustedRole(trustRegistry, 'verifier'), controller: trustedRole(trustRegistry, 'controller'),
  }
  for (const role of Object.keys(expectedTrust)) {
    const expected = expectedTrust[role]
    if (canonicalStringify(report.trustMetadata[role]) !== canonicalStringify({ issuer: expected.issuer, keyId: expected.keyId, fixtureOnly: expected.fixtureOnly })) fail('AGGREGATE_REPORT_INVALID', `aggregate trust metadata differs from trusted configuration: ${role}`)
  }
  const fixtureOnly = Object.values(expectedTrust).some(value => value.fixtureOnly)
  if (report.catalog.issuer !== catalogTrust.issuer || report.catalog.keyId !== catalogTrust.keyId || report.catalog.fixtureOnly !== catalogTrust.fixtureOnly || report.trustMetadata.fixtureOnly !== fixtureOnly) fail('AGGREGATE_REPORT_INVALID', 'aggregate catalog or fixture trust metadata is invalid')
  if (report.controlledEffectEligible !== (report.analysisClass === 'controlled-effects')) fail('AGGREGATE_REPORT_INVALID', 'aggregate controlled classification is inconsistent')
  if (report.controlledEffectEligible && (report.livePartial || fixtureOnly || !report.canarySummary.ready || !report.canarySummary.terminalImmutable || !report.executionLedger.complete)) fail('AGGREGATE_REPORT_INVALID', 'aggregate controlled classification violates its publication invariants')
  requireRoleDigest(trustRegistry, 'aggregate', report.reportDigest, report.generatedAt, report.signature, 'AGGREGATE_SIGNATURE_INVALID')
  return report
}

function signAggregateReport(unsigned, options) {
  if (!options || !options.signer || !options.trustRegistry) fail('AGGREGATE_SIGNATURE_REQUIRED', 'aggregate report requires an asymmetric aggregate signer and trusted registry')
  const reportDigest = digestRecord(unsigned)
  const report = Object.freeze({ ...unsigned, reportDigest, signature: signRoleDigest('aggregate', reportDigest, unsigned.generatedAt, options.signer) })
  validateAggregateReport(report, options.trustRegistry)
  return report
}

function verifyAggregateReport(report, trustRegistry) {
  try { validateAggregateReport(report, trustRegistry); return true } catch { return false }
}

function openReconstructionInputs(options) {
  if (!options.inputEvidence) fail('RECONSTRUCTION_INPUT_MISSING', 'manifest, catalog, pricing, and public trust registry bytes are required')
  required(options.inputEvidence, ['manifest', 'catalog', 'pricing', 'trustRegistry'], 'RECONSTRUCTION_INPUT_INVALID', 'reconstruction inputs')
  const opened = Object.fromEntries(Object.entries(options.inputEvidence).map(([name, descriptor]) => {
    validateBlobDescriptor(descriptor, 'RECONSTRUCTION_INPUT_INVALID')
    return [name, readVerifiedJson(options.evidenceRoot, descriptor, 'RECONSTRUCTION_INPUT_INVALID')]
  }))
  if (canonicalStringify(opened.manifest) !== canonicalStringify(options.manifest) || canonicalStringify(opened.catalog) !== canonicalStringify(options.catalog) || canonicalStringify(opened.pricing) !== canonicalStringify(options.pricing)) fail('RECONSTRUCTION_INPUT_MISMATCH', 'opened reconstruction inputs differ from the objects being aggregated')
  const reopenedTrust = createTrustRegistry(opened.trustRegistry)
  if (canonicalStringify(reopenedTrust) !== canonicalStringify(options.trustRegistry)) fail('RECONSTRUCTION_INPUT_MISMATCH', 'opened public trust registry differs from the configured verifier trust')
  return Object.freeze({ ...options.inputEvidence })
}

function aggregateEvidence(options) {
  if (!options || !Array.isArray(options.attempts) || !options.evidenceRoot || !options.catalog || !options.trustRegistry) fail('EVIDENCE_INPUT_INVALID', 'catalog, manifest, trusted signer registry, pricing, evidence root, and attempts are required')
  if (!options.executionLedger) fail('EXECUTION_LEDGER_INCOMPLETE', 'aggregation requires a complete signed execution ledger')
  const reconstructionInputs = openReconstructionInputs(options)
  const manifest = options.manifest
  validateRunManifest(manifest, { trustRegistry: options.trustRegistry, catalog: options.catalog })
  const pricing = validatePricing(options.pricing)
  if (pricing.pricingId !== manifest.pricingRef.pricingId || pricing.digest !== manifest.pricingRef.digest) fail('PRICING_REFERENCE_MISMATCH', 'pricing snapshot does not match preregistration')
  const planned = new Map(manifest.plannedAttempts.map(item => [item.attemptId, item]))
  const canaryPlans = new Map(buildCanaryAttempts(manifest).map(item => [item.attemptId, item]))
  const seen = new Set()
  const globalSessionIds = new Set()
  const snapshotCache = new Map()
  const validated = []
  for (const record of options.attempts) {
    if (!record || typeof record !== 'object' || !record.attempt || typeof record.attempt.attemptId !== 'string') fail('EVIDENCE_SCHEMA_INVALID', 'attempt evidence lacks typed identity')
    const id = record.attempt.attemptId
    if (seen.has(id)) fail('EVIDENCE_DUPLICATE', `duplicate canonical attempt: ${id}`)
    seen.add(id)
    if (record.attempt.attemptClass === 'scored') {
      const expected = planned.get(id)
      if (!expected || canonicalStringify(record.attempt) !== canonicalStringify(expected)) fail('EVIDENCE_UNKNOWN', `unknown or altered scored attempt: ${id}`)
    } else if (record.attempt.attemptClass === 'repair') {
      const expected = planned.get(record.attempt.repairOfAttemptId)
      if (!expected || record.attempt.taskId !== expected.taskId || record.attempt.armId !== expected.armId || record.attempt.repetition !== expected.repetition) fail('EVIDENCE_UNKNOWN', `repair does not exactly bind a planned scored attempt: ${id}`)
    } else if (record.attempt.attemptClass === 'canary') {
      const expected = canaryPlans.get(id)
      if (!expected || canonicalStringify(record.attempt) !== canonicalStringify(expected)) fail('EVIDENCE_UNKNOWN', `unknown or altered canary attempt: ${id}`)
    } else fail('EVIDENCE_SCHEMA_INVALID', 'unknown attempt class')
    const checked = validateAttemptShape(record, manifest, { evidenceRoot: options.evidenceRoot, snapshotCache, trustRegistry: options.trustRegistry })
    for (const session of checked.record.sessions) {
      if (globalSessionIds.has(session.sessionId)) fail('SESSION_DUPLICATE', `session identity is reused across attempts: ${session.sessionId}`)
      globalSessionIds.add(session.sessionId)
    }
    validated.push(checked)
  }
  const missing = [...planned.keys()].filter(id => !seen.has(id))
  if (missing.length) fail('EVIDENCE_MISSING', 'preregistered scored attempts are missing', { missing })
  const missingCanaries = [...canaryPlans.keys()].filter(id => !seen.has(id))
  if (missingCanaries.length) fail('CANARY_MISSING', 'preregistered canary attempts are missing', { missing: missingCanaries })
  validateObservedChronology(manifest, validated)
  validateBlobDescriptor(options.executionLedger, 'EXECUTION_LEDGER_INVALID')
  const ledgerBytes = verifyEvidenceFile(options.evidenceRoot, options.executionLedger, 'EXECUTION_LEDGER_INVALID').bytes
  const ledger = parseExecutionLedger(ledgerBytes, { manifest, trustRegistry: options.trustRegistry, requireComplete: !options.allowLivePartial })
  const validatedById = new Map(validated.map(item => [item.record.attempt.attemptId, item]))
  for (const entry of ledger) {
    const checked = validatedById.get(entry.attemptId)
    if (!checked || entry.startedAt !== checked.record.startedAt || entry.endedAt !== checked.record.endedAt || entry.terminalState !== checked.terminalState || entry.evidenceChecksum !== checked.record.checksum) fail('EXECUTION_LEDGER_EVIDENCE_MISMATCH', 'execution ledger differs from immutable attempt evidence')
  }
  const canaryResults = validated.filter(item => item.record.attempt.attemptClass === 'canary').map(item => ({ attemptId: item.record.attempt.attemptId, ...item.record.canary }))
  const canaryStatus = evaluateCanaries(manifest, canaryResults)

  let livePartial = false
  let censored = 0
  const terminalStates = {}
  const scoredValidated = validated.filter(item => item.record.attempt.attemptClass === 'scored')
  const canaryValidated = validated.filter(item => item.record.attempt.attemptClass === 'canary')
  for (const checked of scoredValidated) {
    terminalStates[checked.terminalState] = (terminalStates[checked.terminalState] || 0) + 1
    if (NONTERMINAL_STATES.includes(checked.terminalState)) {
      livePartial = true
      if (!options.allowLivePartial) fail('NONTERMINAL_SCORED_ATTEMPT', `scored attempt is not terminal: ${checked.record.attempt.attemptId}`)
    }
    if (checked.terminalState === 'CENSORED') censored += 1
  }
  const costsByArm = Object.fromEntries(manifest.arms.map(arm => [arm.armId, emptyCost()]))
  const tokensByArm = Object.fromEntries(manifest.arms.map(arm => [arm.armId, emptyTokens()]))
  for (const { record } of validated) {
    addAttemptCost(costsByArm[record.attempt.armId], record, pricing)
    addAttemptTokens(tokensByArm[record.attempt.armId], record)
  }
  const scored = scoredValidated.map(item => item.record)
  const acceptedByArm = Object.fromEntries(manifest.arms.map(arm => [arm.armId, 0]))
  for (const { record, terminalState } of scoredValidated) {
    if (terminalState === 'PASS' && record.harbor.reward > 0) acceptedByArm[record.attempt.armId] += 1
  }
  const costPerAcceptedSolve = Object.fromEntries(manifest.arms.map(arm => [
    arm.armId,
    acceptedByArm[arm.armId] === 0 ? null : costsByArm[arm.armId].total / acceptedByArm[arm.armId],
  ]))
  const canaryTerminalImmutable = canaryValidated.every(({ record, terminalState }) => record.provenance.kind === 'immutable-snapshot' && TERMINAL_STATES.includes(terminalState))
  if (validated.some(({ terminalState }) => NONTERMINAL_STATES.includes(terminalState))) livePartial = true
  const catalogTrust = options.trustRegistry.catalogs[options.catalog.catalogId]
  const roleTrust = Object.fromEntries(['manifest', 'aggregate', 'provider-receipt', 'verifier', 'controller'].map(role => [role, trustedRole(options.trustRegistry, role)]))
  const fixtureOnly = catalogTrust.fixtureOnly || Object.values(roleTrust).some(trust => trust.fixtureOnly)
  const controlledEffectEligible = canaryStatus.ready && canaryTerminalImmutable && !livePartial && !fixtureOnly && scoredValidated.every(({ record, terminalState }) =>
    record.provenance.kind === 'immutable-snapshot' && ['PASS', 'FAIL'].includes(terminalState)
  )
  const immutable = []
  const live = []
  for (const record of scored) {
    const common = { attemptId: record.attempt.attemptId, observedAt: record.provenance.observedAt, sessionIds: record.sessions.map(session => session.sessionId) }
    if (record.provenance.kind === 'immutable-snapshot') immutable.push({ ...common, snapshotId: record.provenance.snapshotId, snapshotDigest: record.provenance.snapshotDigest })
    else live.push({ ...common, sourceRunId: record.provenance.sourceRunId, sourceRelativePath: record.provenance.sourceRelativePath })
  }
  const unsigned = {
    schemaVersion: 'benchmark-aggregate.v2',
    generatedAt: options.generatedAt || new Date().toISOString(),
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    catalog: { catalogId: options.catalog.catalogId, digest: options.catalog.digest, taskCount: options.catalog.tasks.length, issuer: catalogTrust.issuer, keyId: catalogTrust.keyId, fixtureOnly: catalogTrust.fixtureOnly },
    pricing: { pricingId: pricing.pricingId, digest: pricing.digest, currency: pricing.currency },
    attempts: { total: validated.length, scored: scored.length, repairs: validated.filter(item => item.record.attempt.attemptClass === 'repair').length, canaries: canaryResults.length, censored },
    terminalStates,
    costsByArm,
    tokensByArm,
    costPerAcceptedSolve,
    spansMs: aggregateSpans(validated.map(item => item.record)),
    livePartial,
    controlledEffectEligible,
    analysisClass: controlledEffectEligible ? 'controlled-effects' : 'descriptive-only',
    canarySummary: { ...canaryStatus, ready: canaryStatus.ready && canaryTerminalImmutable, terminalImmutable: canaryTerminalImmutable, digest: digestRecord({ results: canaryResults.sort((a, b) => a.attemptId.localeCompare(b.attemptId)) }) },
    claimProvenance: { immutable, livePartial: live },
    executionLedger: { ...options.executionLedger, entries: ledger.length, complete: ledger.length === manifest.executionOrder.length },
    reconstructionInputs,
    trustMetadata: {
      catalog: { issuer: catalogTrust.issuer, keyId: catalogTrust.keyId, fixtureOnly: catalogTrust.fixtureOnly },
      manifest: { issuer: roleTrust.manifest.issuer, keyId: roleTrust.manifest.keyId, fixtureOnly: roleTrust.manifest.fixtureOnly },
      aggregate: { issuer: roleTrust.aggregate.issuer, keyId: roleTrust.aggregate.keyId, fixtureOnly: roleTrust.aggregate.fixtureOnly },
      providerReceipt: { issuer: roleTrust['provider-receipt'].issuer, keyId: roleTrust['provider-receipt'].keyId, fixtureOnly: roleTrust['provider-receipt'].fixtureOnly },
      verifier: { issuer: roleTrust.verifier.issuer, keyId: roleTrust.verifier.keyId, fixtureOnly: roleTrust.verifier.fixtureOnly },
      controller: { issuer: roleTrust.controller.issuer, keyId: roleTrust.controller.keyId, fixtureOnly: roleTrust.controller.fixtureOnly },
      fixtureOnly,
    },
    evidenceObjects: collectEvidenceObjects(validated, [options.executionLedger, ...Object.values(reconstructionInputs)]),
  }
  if (controlledEffectEligible && live.length) fail('MIXED_PROVENANCE_FORBIDDEN', 'controlled effects cannot mix immutable and live evidence')
  return signAggregateReport(unsigned, { signer: options.reportSigner, trustRegistry: options.trustRegistry })
}

module.exports = {
  NONTERMINAL_STATES,
  TERMINAL_STATES,
  aggregateEvidence,
  deriveTerminalState,
  modelPriceKey,
  sealAttempt,
  sealPricing,
  signAggregateReport,
  validateAggregateReport,
  validateAttemptShape,
  validatePricing,
  verifyAggregateReport,
}
