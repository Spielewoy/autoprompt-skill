#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const {
  canonicalStringify,
  digestRecord,
  exactKeys,
  fail,
  hashPattern,
  isoDate,
  nonEmpty,
  sha256,
  writeChecksummedJson,
} = require('./core.cjs')

const ROUTES = Object.freeze(['DIRECT', 'LIGHT', 'ROADMAP'])
const ROUTE_RANK = Object.freeze({ DIRECT: 0, LIGHT: 1, ROADMAP: 2 })
const ARM_DEFINITIONS = Object.freeze([
  Object.freeze({ armId: 'base', role: 'single-agent-base', sourceKind: 'single-agent-no-router' }),
  Object.freeze({ armId: 'current', role: 'frozen-current-autoprompt', sourceKind: 'git-commit' }),
  Object.freeze({ armId: 'redesign', role: 'codex-redesign', sourceKind: 'worktree-files' }),
])
const ROUTER_FILES = Object.freeze([
  'agents/codex/workflow/router.js',
  'agents/contracts/routes.json',
  'agents/contracts/providers.json',
])
const HUMAN_BLOCKERS = Object.freeze([
  'a development-separated holdout task set not seen by prompt or classifier authors',
  'two independently produced human route-label files with distinct rater attestations',
  'adjudications with rationales for every rater disagreement',
  'a freeze record proving task bytes and labels were sealed before prompt tuning',
])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function merge(base, overrides) {
  const result = clone(base)
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value)
    } else {
      result[key] = clone(value)
    }
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

function validateArmDefinitions(arms) {
  if (!Array.isArray(arms) || arms.length !== ARM_DEFINITIONS.length) fail('EMPIRICAL_PREREGISTRATION_INVALID', 'exactly three arms are required')
  arms.forEach((arm, index) => {
    exactKeys(arm, ['armId', 'role', 'sourceKind'], 'EMPIRICAL_PREREGISTRATION_INVALID', `arm ${index}`)
    if (canonicalStringify(arm) !== canonicalStringify(ARM_DEFINITIONS[index])) {
      fail('EMPIRICAL_PREREGISTRATION_INVALID', 'arms must be exact ordered base/current/redesign definitions')
    }
  })
}

function validatePreregistration(input) {
  exactKeys(input, [
    'schemaVersion', 'evidenceClass', 'corpusPath', 'corpusSha256', 'currentCommit',
    'cohort', 'repetitions', 'arms', 'pairedOrders', 'analystAblation',
  ], 'EMPIRICAL_PREREGISTRATION_INVALID', 'preregistration')
  if (input.schemaVersion !== 'codex-local-empirical-preregistration.v1' || input.evidenceClass !== 'deterministic-local-execution') {
    fail('EMPIRICAL_PREREGISTRATION_INVALID', 'unsupported empirical preregistration')
  }
  nonEmpty(input.corpusPath, 'EMPIRICAL_PREREGISTRATION_INVALID', 'corpusPath')
  if (path.isAbsolute(input.corpusPath) || input.corpusPath.includes('\\') || input.corpusPath.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('EMPIRICAL_PREREGISTRATION_INVALID', 'corpusPath must be a contained portable path')
  }
  if (!hashPattern(input.corpusSha256) || !/^[a-f0-9]{40}$/u.test(input.currentCommit)) fail('EMPIRICAL_PREREGISTRATION_INVALID', 'corpus and current source bindings must be full hashes')
  exactKeys(input.cohort, ['expectedTaskCount', 'taskIds', 'exclusions'], 'EMPIRICAL_PREREGISTRATION_INVALID', 'cohort')
  if (!Number.isSafeInteger(input.cohort.expectedTaskCount) || input.cohort.expectedTaskCount < 1 ||
      !Array.isArray(input.cohort.taskIds) || input.cohort.taskIds.length !== input.cohort.expectedTaskCount ||
      input.cohort.taskIds.some(id => typeof id !== 'string' || !id) || new Set(input.cohort.taskIds).size !== input.cohort.taskIds.length ||
      !Array.isArray(input.cohort.exclusions)) {
    fail('EMPIRICAL_PREREGISTRATION_INVALID', 'cohort must preregister a unique full task set and exclusions')
  }
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 3) fail('EMPIRICAL_PREREGISTRATION_INVALID', 'at least three repetitions are required')
  validateArmDefinitions(input.arms)
  if (!Array.isArray(input.pairedOrders) || input.pairedOrders.length !== input.repetitions) fail('EMPIRICAL_PREREGISTRATION_INVALID', 'one paired order is required per repetition')
  for (const [index, order] of input.pairedOrders.entries()) {
    if (!Array.isArray(order) || order.length !== 3 || [...order].sort().join(',') !== 'base,current,redesign') {
      fail('EMPIRICAL_PREREGISTRATION_INVALID', `paired order ${index} must contain every arm exactly once`)
    }
  }
  const firstThreePositions = Object.fromEntries(ARM_DEFINITIONS.map(arm => [arm.armId, new Set()]))
  input.pairedOrders.slice(0, 3).forEach(order => order.forEach((armId, position) => firstThreePositions[armId].add(position)))
  if (Object.values(firstThreePositions).some(positions => positions.size !== 3)) fail('EMPIRICAL_PREREGISTRATION_INVALID', 'the first three paired orders must balance arm position')
  exactKeys(input.analystAblation, ['withoutAnalystPolicy', 'withAnalystPolicy', 'analystMayBeRemoved', 'limits'], 'EMPIRICAL_PREREGISTRATION_INVALID', 'analystAblation')
  if (input.analystAblation.withoutAnalystPolicy !== 'effect-only-local-proxy-v1' ||
      input.analystAblation.withAnalystPolicy !== 'candidate-route-recommendation-v1' ||
      input.analystAblation.analystMayBeRemoved !== false) {
    fail('EMPIRICAL_PREREGISTRATION_INVALID', 'analyst ablation must preserve the required analyst and use registered policies')
  }
  exactKeys(input.analystAblation.limits, [
    'maxP50DurationMs', 'maxP95DurationMs', 'maxP50WeightedCost', 'maxP95WeightedCost',
  ], 'EMPIRICAL_PREREGISTRATION_INVALID', 'analyst limits')
  const limits = input.analystAblation.limits
  if (![limits.maxP50DurationMs, limits.maxP95DurationMs, limits.maxP50WeightedCost, limits.maxP95WeightedCost].every(value => Number.isFinite(value) && value >= 0) ||
      limits.maxP50DurationMs > limits.maxP95DurationMs || limits.maxP50WeightedCost > limits.maxP95WeightedCost) {
    fail('EMPIRICAL_PREREGISTRATION_INVALID', 'analyst p50/p95 duration limits are invalid')
  }
  return input
}

function loadPreregistration(filename) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) { fail('EMPIRICAL_PREREGISTRATION_INVALID', 'cannot read preregistration', { cause: error.message }) }
  return validatePreregistration(parsed)
}

function resolveContained(root, relative) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...relative.split('/'))
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail('EMPIRICAL_PREREGISTRATION_INVALID', 'path escapes repository root')
  return resolved
}

function loadCorpus(repoRoot, preregistration) {
  const filename = resolveContained(repoRoot, preregistration.corpusPath)
  let bytes
  let corpus
  try {
    bytes = fs.readFileSync(filename)
    corpus = JSON.parse(bytes)
  } catch (error) {
    fail('EMPIRICAL_CORPUS_INVALID', 'cannot read the preregistered corpus', { cause: error.message })
  }
  if (sha256(bytes) !== preregistration.corpusSha256) fail('EMPIRICAL_CORPUS_INVALID', 'corpus bytes changed after preregistration')
  exactKeys(corpus, ['schemaVersion', 'evidenceClass', 'missions'], 'EMPIRICAL_CORPUS_INVALID', 'corpus')
  if (corpus.evidenceClass !== 'sealed-semantic-conformance-corpus' || !Array.isArray(corpus.missions) || !corpus.missions.length) fail('EMPIRICAL_CORPUS_INVALID', 'corpus is not the sealed executable semantic cohort')
  const ids = corpus.missions.map(mission => mission.id)
  const routes = new Set()
  const domains = new Set()
  for (const [index, mission] of corpus.missions.entries()) {
    exactKeys(mission, ['id', 'domain', 'expectedRoute', 'overrides'], 'EMPIRICAL_CORPUS_INVALID', `mission ${index}`)
    nonEmpty(mission.id, 'EMPIRICAL_CORPUS_INVALID', `mission ${index}.id`)
    nonEmpty(mission.domain, 'EMPIRICAL_CORPUS_INVALID', `mission ${index}.domain`)
    if (!ROUTES.includes(mission.expectedRoute) || !mission.overrides || typeof mission.overrides !== 'object' || Array.isArray(mission.overrides)) fail('EMPIRICAL_CORPUS_INVALID', `mission ${mission.id} is invalid`)
    routes.add(mission.expectedRoute)
    domains.add(mission.domain)
  }
  if (new Set(ids).size !== ids.length || canonicalStringify(ids) !== canonicalStringify(preregistration.cohort.taskIds) ||
      preregistration.cohort.expectedTaskCount !== corpus.missions.length || preregistration.cohort.exclusions.length !== 0) {
    fail('EMPIRICAL_COHORT_MISMATCH', 'execution must cover the full preregistered cohort with no post-hoc subset or exclusions', { expected: preregistration.cohort.taskIds, actual: ids, exclusions: preregistration.cohort.exclusions })
  }
  if (routes.size !== ROUTES.length || domains.size !== corpus.missions.length) fail('EMPIRICAL_CORPUS_INVALID', 'the local cohort must cover all routes across distinct task domains')
  return { bytes, corpus }
}

function spawnGit(repoRoot, argv, encoding = null) {
  const result = childProcess.spawnSync('git', argv, { cwd: repoRoot, encoding, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0 || result.error || result.signal) fail('EMPIRICAL_SOURCE_BINDING_INVALID', 'cannot resolve frozen current source', { argv, stderr: encoding ? String(result.stderr || '').trim() : Buffer.from(result.stderr || '').toString('utf8').trim(), errorCode: result.error?.code || null })
  return result.stdout
}

function frozenSourceFiles(repoRoot, commit) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) fail('EMPIRICAL_SOURCE_BINDING_INVALID', 'currentCommit must be a full commit SHA')
  spawnGit(repoRoot, ['cat-file', '-e', `${commit}^{commit}`])
  return Object.fromEntries(ROUTER_FILES.map(relative => [relative, spawnGit(repoRoot, ['show', `${commit}:${relative}`])]))
}

function worktreeSourceFiles(repoRoot) {
  const files = {}
  for (const relative of ROUTER_FILES) {
    const filename = resolveContained(repoRoot, relative)
    try { files[relative] = fs.readFileSync(filename) } catch (error) { fail('EMPIRICAL_SOURCE_BINDING_INVALID', `cannot read candidate source: ${relative}`, { cause: error.code }) }
  }
  return files
}

function sourceDescriptor(kind, files, commit = null, classifierFingerprint = null) {
  const fileDigests = Object.fromEntries(ROUTER_FILES.map(relative => [relative, sha256(files[relative])]))
  const descriptor = { sourceBinding: kind, commit, classifierFingerprint, files: fileDigests }
  return Object.freeze({ ...descriptor, digest: digestRecord(descriptor) })
}

function loadCapturedRouter(files, label) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-r10-${label}-`))
  try {
    for (const relative of ROUTER_FILES) {
      const filename = path.join(temporaryRoot, ...relative.split('/'))
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, files[relative])
    }
    const router = require(path.join(temporaryRoot, 'agents', 'codex', 'workflow', 'router.js'))
    return { router, dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) }
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
    if (error && error.name === 'BenchmarkEvidenceError') throw error
    fail('EMPIRICAL_SOURCE_BINDING_INVALID', `cannot execute captured ${label} router`, { cause: error.message })
  }
}

function classify(router, mission) {
  const decision = router.classifyRoute(baseFacts(mission.overrides))
  if (decision.status !== 'DECIDED' || !ROUTES.includes(decision.route)) return { predictedRoute: null, status: decision.status, errors: decision.errors || [] }
  return { predictedRoute: decision.route, status: decision.status, errors: [] }
}

function aggregateAttempts(attempts, armId) {
  const selected = attempts.filter(attempt => attempt.armId === armId)
  const correct = selected.filter(attempt => attempt.terminalState === 'PASS').length
  const underRouting = selected.filter(attempt => attempt.predictedRoute !== null && ROUTE_RANK[attempt.predictedRoute] < ROUTE_RANK[attempt.expectedRoute]).length
  const overRouting = selected.filter(attempt => attempt.predictedRoute !== null && ROUTE_RANK[attempt.predictedRoute] > ROUTE_RANK[attempt.expectedRoute]).length
  return Object.freeze({ attempts: selected.length, terminalCount: selected.filter(attempt => ['PASS', 'FAIL'].includes(attempt.terminalState)).length, correct, accuracy: selected.length ? correct / selected.length : 0, underRouting, overRouting })
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function routeError(expected, actual) {
  const delta = ROUTE_RANK[actual] - ROUTE_RANK[expected]
  return { kind: delta === 0 ? 'correct' : delta < 0 ? 'under-routing' : 'over-routing', cost: Math.abs(delta) * (delta < 0 ? 2 : 1) }
}

function withoutAnalystPolicy(mission) {
  const effect = mission.overrides.requestedEffect || 'report'
  return ['report', 'inspect', 'research', 'decide'].includes(effect) ? 'DIRECT' : 'LIGHT'
}

function addAccounting(records) {
  const fields = ['sessionCount', 'callCount', 'durationMs', 'noncachedInput', 'cachedInput', 'output', 'reasoning', 'weightedCost']
  const totals = Object.fromEntries(fields.map(field => [field, records.reduce((sum, record) => sum + record.accounting[field], 0)]))
  return {
    samples: records.length,
    totals,
    units: { durationMs: 'observed-local-wall-ms', weightedCost: 'observed-local-compute-ms', inputOutput: 'bytes', sessionsAndCalls: 'count' },
    distribution: {
      durationMs: { p50: percentile(records.map(record => record.accounting.durationMs), 0.5), p95: percentile(records.map(record => record.accounting.durationMs), 0.95) },
      weightedCost: { p50: percentile(records.map(record => record.accounting.weightedCost), 0.5), p95: percentile(records.map(record => record.accounting.weightedCost), 0.95) },
    },
  }
}

function runAnalystAblation(corpus, candidateRouter, limits) {
  const observations = corpus.missions.map(mission => {
    const analystInput = { id: mission.id, domain: mission.domain, overrides: mission.overrides }
    const inputBytes = Buffer.from(canonicalStringify(analystInput), 'utf8')
    const started = performance.now()
    const decision = classify(candidateRouter, mission)
    if (decision.predictedRoute === null) fail('EMPIRICAL_ANALYST_REPLAY_FAILED', `candidate analyst replay did not decide ${mission.id}`, { status: decision.status, errors: decision.errors })
    const transcriptRecord = {
      schemaVersion: 'codex-local-route-analyst-transcript.v1',
      taskId: mission.id,
      recommendation: decision.predictedRoute,
      evidenceIndex: [{ id: mission.id, domain: mission.domain, inputSha256: sha256(inputBytes) }],
    }
    const transcriptBytes = Buffer.from(canonicalStringify(transcriptRecord), 'utf8')
    const consumed = JSON.parse(transcriptBytes.toString('utf8'))
    const durationMs = Math.max(1, Math.ceil(performance.now() - started))
    const withoutAnalystRoute = withoutAnalystPolicy(mission)
    const withAnalystRoute = consumed.recommendation
    const before = routeError(mission.expectedRoute, withoutAnalystRoute)
    const after = routeError(mission.expectedRoute, withAnalystRoute)
    return {
      id: mission.id,
      expectedRoute: mission.expectedRoute,
      withoutAnalystRoute,
      withAnalystRoute,
      before,
      after,
      accounting: {
        sessionCount: 1, callCount: 1, durationMs,
        noncachedInput: inputBytes.length, cachedInput: 0,
        output: transcriptBytes.length, reasoning: 0, weightedCost: durationMs,
      },
      transcript: { sha256: sha256(transcriptBytes), bytes: transcriptBytes.length, consumedBytes: transcriptBytes.length, citedItemCount: consumed.evidenceIndex.length },
    }
  })
  const accounting = addAccounting(observations)
  const accountingByExpectedRoute = Object.fromEntries(ROUTES.map(route => [
    route, addAccounting(observations.filter(observation => observation.expectedRoute === route)),
  ]))
  const transcript = {
    bytes: observations.reduce((sum, observation) => sum + observation.transcript.bytes, 0),
    consumedBytes: observations.reduce((sum, observation) => sum + observation.transcript.consumedBytes, 0),
  }
  transcript.unusedBytes = transcript.bytes - transcript.consumedBytes
  transcript.consumptionRatio = transcript.bytes === 0 ? 0 : transcript.consumedBytes / transcript.bytes
  const errorsCorrected = observations.filter(observation => observation.before.cost > 0 && observation.after.cost === 0).length
  const errorsRegressed = observations.filter(observation => observation.before.cost === 0 && observation.after.cost > 0).length
  const netErrorCostAvoided = observations.reduce((sum, observation) => sum + observation.before.cost - observation.after.cost, 0)
  const costWithinLimits = accounting.distribution.durationMs.p50 <= limits.maxP50DurationMs &&
    accounting.distribution.durationMs.p95 <= limits.maxP95DurationMs &&
    accounting.distribution.weightedCost.p50 <= limits.maxP50WeightedCost &&
    accounting.distribution.weightedCost.p95 <= limits.maxP95WeightedCost
  const routeCoverageComplete = new Set(observations.map(observation => observation.expectedRoute)).size === ROUTES.length
  return {
    schemaVersion: 'codex-local-route-analyst-ablation.v1',
    observationKind: 'deterministic-local-analyst-replay',
    limitations: 'This measures the deterministic recommendation/consumption mechanism on the sealed semantic corpus; it is not a claim about live model analyst quality.',
    realAgentClaimEligible: false,
    analystRemovedFromProduct: false,
    liveModelCalls: 0,
    samples: observations.length,
    routeCoverageComplete,
    limits: clone(limits),
    costWithinLimits,
    accounting,
    accountingByExpectedRoute,
    transcript,
    value: {
      decisionChanges: observations.filter(observation => observation.withoutAnalystRoute !== observation.withAnalystRoute).length,
      errorsCorrected,
      errorsRegressed,
      netErrorCostAvoided,
      netErrorCostAvoidedPerLocalComputeMs: netErrorCostAvoided / accounting.totals.weightedCost,
    },
    observations,
  }
}

function runLocalEmpiricalEvaluation(options) {
  const repoRoot = path.resolve(options.repoRoot)
  const preregistration = validatePreregistration(options.preregistration)
  const { corpus } = loadCorpus(repoRoot, preregistration)
  const generatedAt = options.generatedAt || new Date().toISOString()
  isoDate(generatedAt, 'EMPIRICAL_TIME_INVALID', 'generatedAt')
  const currentFiles = frozenSourceFiles(repoRoot, preregistration.currentCommit)
  const redesignFiles = worktreeSourceFiles(repoRoot)
  const currentCapture = loadCapturedRouter(currentFiles, 'current')
  const redesignCapture = loadCapturedRouter(redesignFiles, 'redesign')
  try {
    const sourceBindings = {
      base: { sourceBinding: 'single-agent-no-router', policy: 'all work stays in one root session; route equivalent DIRECT' },
      current: sourceDescriptor('executed-git-commit', currentFiles, preregistration.currentCommit, currentCapture.router.ROUTE_CLASSIFIER_FINGERPRINT),
      redesign: sourceDescriptor('executed-worktree-files', redesignFiles, null, redesignCapture.router.ROUTE_CLASSIFIER_FINGERPRINT),
    }
    const attempts = []
    for (let repetition = 0; repetition < preregistration.repetitions; repetition += 1) {
      const order = preregistration.pairedOrders[repetition]
      for (const mission of corpus.missions) {
        for (const armId of order) {
          const result = armId === 'base'
            ? { predictedRoute: 'DIRECT', status: 'DECIDED', errors: [] }
            : classify(armId === 'current' ? currentCapture.router : redesignCapture.router, mission)
          const terminalState = result.predictedRoute === mission.expectedRoute ? 'PASS' : 'FAIL'
          attempts.push({
            taskId: mission.id,
            domain: mission.domain,
            repetition: repetition + 1,
            pairedOrder: [...order],
            armId,
            expectedRoute: mission.expectedRoute,
            predictedRoute: result.predictedRoute,
            classifierStatus: result.status,
            terminalState,
            sourceBinding: sourceBindings[armId].sourceBinding,
            errors: result.errors,
          })
        }
      }
    }
    const arms = Object.fromEntries(ARM_DEFINITIONS.map(arm => [arm.armId, aggregateAttempts(attempts, arm.armId)]))
    const analystAblation = runAnalystAblation(corpus, redesignCapture.router, preregistration.analystAblation.limits)
    const allTerminal = attempts.every(attempt => ['PASS', 'FAIL'].includes(attempt.terminalState))
    const fullCohortRun = new Set(attempts.map(attempt => attempt.taskId)).size === preregistration.cohort.expectedTaskCount
    const exactArmsRun = Object.keys(arms).join(',') === 'base,current,redesign'
    const localAnalystValue = analystAblation.costWithinLimits && analystAblation.routeCoverageComplete && analystAblation.value.netErrorCostAvoided > 0
    const transcriptUseful = analystAblation.transcript.unusedBytes === 0 && analystAblation.value.errorsCorrected > 0 && analystAblation.value.errorsRegressed === 0
    const findings = {
      'AP-TEST-002': { status: fullCohortRun && allTerminal && preregistration.repetitions >= 3 ? 'SATISFIED_LOCAL' : 'FAILED', evidence: 'full preregistered cohort, zero exclusions, paired order, three repetitions, and terminal outcomes in every arm' },
      'AP-TEST-036': { status: exactArmsRun && allTerminal ? 'SATISFIED_LOCAL' : 'FAILED', evidence: 'single-agent base, frozen current Autoprompt commit, and worktree redesign executed on the same cohort' },
      'AP-DESIGN-027': { status: localAnalystValue ? 'SATISFIED_LOCAL' : 'FAILED', evidence: 'local analyst sessions/calls/duration/input/output and p50/p95 limits with errors avoided per observed local compute millisecond' },
      'AP-DESIGN-028': { status: transcriptUseful ? 'SATISFIED_LOCAL' : 'FAILED', evidence: 'non-removal ablation consumed the complete compact transcript and measured corrected/regressed route errors' },
      'AP-DESIGN-038': { status: 'BLOCKED_EXTERNAL_INPUT', missingExternalInput: [...HUMAN_BLOCKERS], executableMachinery: 'evaluateIndependentHumanLabels' },
    }
    const record = {
      schemaVersion: 'codex-local-empirical-evidence.v1',
      generatedAt,
      evidenceClass: preregistration.evidenceClass,
      qualityClaimEligible: false,
      limitations: [
        'The cohort is a sealed deterministic semantic conformance corpus, not an independently human-labeled quality holdout.',
        'The analyst ablation executes a deterministic local recommendation replay with zero live model calls.',
      ],
      liveModelCalls: 0,
      preregistration: {
        digest: digestRecord(preregistration),
        corpusPath: preregistration.corpusPath,
        corpusSha256: preregistration.corpusSha256,
        taskCount: preregistration.cohort.expectedTaskCount,
        taskIds: [...preregistration.cohort.taskIds],
        exclusions: [...preregistration.cohort.exclusions],
        repetitions: preregistration.repetitions,
        arms: preregistration.arms.map(arm => arm.armId),
        pairedOrders: preregistration.pairedOrders.map(order => [...order]),
      },
      cohort: {
        domains: corpus.missions.map(mission => mission.domain),
        expectedRouteDistribution: Object.fromEntries(ROUTES.map(route => [
          route, corpus.missions.filter(mission => mission.expectedRoute === route).length,
        ])),
      },
      sourceBindings,
      attempts,
      arms,
      comparison: {
        currentMinusBaseCorrect: arms.current.correct - arms.base.correct,
        redesignMinusBaseCorrect: arms.redesign.correct - arms.base.correct,
        redesignMinusCurrentCorrect: arms.redesign.correct - arms.current.correct,
      },
      analystAblation,
      findings,
    }
    const checksummed = { ...record, checksum: digestRecord(record) }
    if (options.outputPath) return writeChecksummedJson(path.resolve(options.outputPath), checksummed)
    return Object.freeze(checksummed)
  } finally {
    currentCapture.dispose()
    redesignCapture.dispose()
  }
}

function parseJsonLines(bytes, code, label) {
  const lines = Buffer.isBuffer(bytes) ? bytes.toString('utf8').trim().split(/\r?\n/u).filter(Boolean) : []
  if (!lines.length) fail(code, `${label} must contain at least one JSONL row`)
  let rows
  try { rows = lines.map(line => JSON.parse(line)) } catch (error) { fail(code, `${label} is malformed JSONL`, { cause: error.message }) }
  const ids = []
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(code, `${label} row ${index} must be an object`)
    nonEmpty(row.id, code, `${label} row ${index}.id`)
    ids.push(row.id)
  }
  if (new Set(ids).size !== ids.length) fail(code, `${label} contains duplicate ids`)
  return rows
}

function validateRater(rater, taskIds, index) {
  exactKeys(rater, ['raterId', 'independentHumanAttestationSha256', 'labeledAt', 'labels'], 'HUMAN_LABEL_INPUT_INVALID', `rater ${index}`)
  nonEmpty(rater.raterId, 'HUMAN_LABEL_INPUT_INVALID', `rater ${index}.raterId`)
  if (!hashPattern(rater.independentHumanAttestationSha256)) fail('HUMAN_LABEL_INPUT_INVALID', `rater ${index} needs an external human attestation digest`)
  isoDate(rater.labeledAt, 'HUMAN_LABEL_INPUT_INVALID', `rater ${index}.labeledAt`)
  if (!Array.isArray(rater.labels) || rater.labels.length !== taskIds.length) fail('HUMAN_LABEL_INPUT_INVALID', `rater ${index} must label the full task set`)
  const byId = new Map()
  for (const [labelIndex, label] of rater.labels.entries()) {
    exactKeys(label, ['id', 'route', 'reasons'], 'HUMAN_LABEL_INPUT_INVALID', `rater ${index} label ${labelIndex}`)
    if (!taskIds.includes(label.id) || byId.has(label.id) || !ROUTES.includes(label.route) || !Array.isArray(label.reasons) || !label.reasons.length || label.reasons.some(reason => typeof reason !== 'string' || !reason.trim())) {
      fail('HUMAN_LABEL_INPUT_INVALID', `rater ${index} label ${labelIndex} is invalid or incomplete`)
    }
    byId.set(label.id, label)
  }
  return byId
}

function cohenKappa(taskIds, left, right) {
  const agreements = taskIds.filter(id => left.get(id).route === right.get(id).route).length
  const observed = agreements / taskIds.length
  const expected = ROUTES.reduce((sum, route) => {
    const leftShare = taskIds.filter(id => left.get(id).route === route).length / taskIds.length
    const rightShare = taskIds.filter(id => right.get(id).route === route).length / taskIds.length
    return sum + (leftShare * rightShare)
  }, 0)
  if (expected === 1) fail('HUMAN_LABEL_AGREEMENT_UNDEFINED', 'Cohen kappa is undefined because both raters used one category only')
  return { observedAgreement: observed, expectedAgreement: expected, value: Number(((observed - expected) / (1 - expected)).toFixed(12)) }
}

function evaluateIndependentHumanLabels(input) {
  const tasks = parseJsonLines(input.taskBytes, 'HUMAN_LABEL_TASKS_INVALID', 'holdout tasks')
  const development = parseJsonLines(input.developmentBytes, 'HUMAN_LABEL_DEVELOPMENT_INVALID', 'development tasks')
  for (const [index, task] of tasks.entries()) {
    exactKeys(task, ['id', 'groupId', 'contrastGroupId', 'variantKind', 'overrides'], 'HUMAN_LABEL_TASKS_INVALID', `holdout task ${index}`)
    nonEmpty(task.groupId, 'HUMAN_LABEL_TASKS_INVALID', `holdout task ${index}.groupId`)
    if (!['canonical', 'paraphrase', 'counterexample'].includes(task.variantKind) || !task.overrides || typeof task.overrides !== 'object' || Array.isArray(task.overrides)) {
      fail('HUMAN_LABEL_TASKS_INVALID', `holdout task ${index} has an invalid variant or route-fact payload`)
    }
  }
  const taskIds = tasks.map(task => task.id)
  const developmentIds = new Set(development.map(task => task.id))
  if (taskIds.some(id => developmentIds.has(id))) fail('HUMAN_LABEL_DEVELOPMENT_LEAKAGE', 'development and holdout task ids overlap')
  const contentWithoutId = value => canonicalStringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id')))
  const developmentContent = new Set(development.map(contentWithoutId))
  if (tasks.some(task => developmentContent.has(contentWithoutId(task)))) fail('HUMAN_LABEL_DEVELOPMENT_LEAKAGE', 'development and holdout contain byte-equivalent examples under different ids')
  const freeze = input.freeze
  exactKeys(freeze, [
    'schemaVersion', 'holdoutId', 'taskSetFrozenAt', 'labelSetFrozenAt', 'promptTuningStartedAt',
    'fixtureRelativePath', 'taskSetSha256', 'developmentSetSha256', 'implementationFingerprint', 'frozenBeforePromptTuning',
  ], 'HUMAN_LABEL_FREEZE_INVALID', 'freeze')
  if (freeze.schemaVersion !== 'codex-route-label-freeze.v1' || !hashPattern(freeze.taskSetSha256) || !hashPattern(freeze.developmentSetSha256) || !hashPattern(freeze.implementationFingerprint) || freeze.frozenBeforePromptTuning !== true) {
    fail('HUMAN_LABEL_FREEZE_INVALID', 'freeze must bind task/development bytes and the pre-tuning implementation')
  }
  nonEmpty(freeze.holdoutId, 'HUMAN_LABEL_FREEZE_INVALID', 'freeze.holdoutId')
  nonEmpty(freeze.fixtureRelativePath, 'HUMAN_LABEL_FREEZE_INVALID', 'freeze.fixtureRelativePath')
  isoDate(freeze.taskSetFrozenAt, 'HUMAN_LABEL_FREEZE_INVALID', 'freeze.taskSetFrozenAt')
  isoDate(freeze.labelSetFrozenAt, 'HUMAN_LABEL_FREEZE_INVALID', 'freeze.labelSetFrozenAt')
  isoDate(freeze.promptTuningStartedAt, 'HUMAN_LABEL_FREEZE_INVALID', 'freeze.promptTuningStartedAt')
  if (freeze.taskSetSha256 !== sha256(input.taskBytes) || freeze.developmentSetSha256 !== sha256(input.developmentBytes)) fail('HUMAN_LABEL_FREEZE_INVALID', 'freeze digests do not match task or development bytes')
  if (!Array.isArray(input.raters) || input.raters.length !== 2) fail('HUMAN_LABEL_INPUT_INVALID', 'exactly two independently attested human raters are required for Cohen kappa')
  const raterMaps = input.raters.map((rater, index) => validateRater(rater, taskIds, index))
  if (new Set(input.raters.map(rater => rater.raterId)).size !== 2 || new Set(input.raters.map(rater => rater.independentHumanAttestationSha256)).size !== 2) fail('HUMAN_LABEL_INPUT_INVALID', 'rater identities and external attestation digests must be distinct')
  if (Date.parse(freeze.taskSetFrozenAt) >= Date.parse(freeze.labelSetFrozenAt) ||
      Date.parse(freeze.labelSetFrozenAt) >= Date.parse(freeze.promptTuningStartedAt) ||
      input.raters.some(rater => Date.parse(rater.labeledAt) <= Date.parse(freeze.taskSetFrozenAt) || Date.parse(rater.labeledAt) > Date.parse(freeze.labelSetFrozenAt))) {
    fail('HUMAN_LABEL_FREEZE_INVALID', 'tasks must be frozen before rating and all labels must be sealed before prompt tuning starts')
  }
  const kappa = cohenKappa(taskIds, raterMaps[0], raterMaps[1])
  const disagreementIds = taskIds.filter(id => raterMaps[0].get(id).route !== raterMaps[1].get(id).route)
  if (!Array.isArray(input.adjudications)) fail('HUMAN_LABEL_ADJUDICATION_INCOMPLETE', 'adjudications must be an array')
  const adjudications = new Map()
  for (const [index, adjudication] of input.adjudications.entries()) {
    exactKeys(adjudication, ['id', 'route', 'adjudicatorId', 'adjudicatedAt', 'rationale'], 'HUMAN_LABEL_ADJUDICATION_INCOMPLETE', `adjudication ${index}`)
    isoDate(adjudication.adjudicatedAt, 'HUMAN_LABEL_ADJUDICATION_INCOMPLETE', `adjudication ${index}.adjudicatedAt`)
    if (!disagreementIds.includes(adjudication.id) || adjudications.has(adjudication.id) || !ROUTES.includes(adjudication.route) ||
        typeof adjudication.rationale !== 'string' || !adjudication.rationale.trim() || typeof adjudication.adjudicatorId !== 'string' || !adjudication.adjudicatorId.trim() ||
        input.raters.some(rater => rater.raterId === adjudication.adjudicatorId) ||
        Date.parse(adjudication.adjudicatedAt) <= Math.max(...input.raters.map(rater => Date.parse(rater.labeledAt))) ||
        Date.parse(adjudication.adjudicatedAt) > Date.parse(freeze.labelSetFrozenAt)) {
      fail('HUMAN_LABEL_ADJUDICATION_INCOMPLETE', `adjudication ${index} is invalid, duplicated, or not independent`)
    }
    adjudications.set(adjudication.id, adjudication)
  }
  if (adjudications.size !== disagreementIds.length) fail('HUMAN_LABEL_ADJUDICATION_INCOMPLETE', 'every and only rater disagreement must be independently adjudicated', { disagreementIds, adjudicatedIds: [...adjudications.keys()] })
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const rows = taskIds.map(id => {
    const task = taskById.get(id)
    const left = raterMaps[0].get(id)
    const right = raterMaps[1].get(id)
    const adjudication = adjudications.get(id)
    return {
      id,
      labelSource: 'independent-human',
      groupId: task.groupId,
      ...(task.contrastGroupId === undefined ? {} : { contrastGroupId: task.contrastGroupId }),
      variantKind: task.variantKind,
      expectedRoute: adjudication ? adjudication.route : left.route,
      expectedReasons: adjudication ? [adjudication.rationale] : [...left.reasons],
      overrides: task.overrides,
    }
  })
  const fixtureJsonl = `${rows.map(row => canonicalStringify(row)).join('\n')}\n`
  const agreementEvidence = {
    schemaVersion: 'codex-route-label-agreement.v1',
    holdoutId: freeze.holdoutId,
    raterIds: input.raters.map(rater => rater.raterId),
    raterAttestationSha256: input.raters.map(rater => rater.independentHumanAttestationSha256),
    metric: 'cohen-kappa',
    ...kappa,
    disagreements: disagreementIds.length,
  }
  const adjudicationEvidence = {
    schemaVersion: 'codex-route-label-adjudication.v1',
    holdoutId: freeze.holdoutId,
    adjudications: [...adjudications.values()],
  }
  const freezeEvidence = {
    ...freeze,
    labeledFixtureSha256: sha256(fixtureJsonl),
    agreementEvidenceSha256: digestRecord(agreementEvidence),
    adjudicationEvidenceSha256: digestRecord(adjudicationEvidence),
  }
  const provenance = {
    schemaVersion: 'benchmark-route-holdout.v1',
    holdoutId: freeze.holdoutId,
    createdAt: freeze.taskSetFrozenAt,
    sealedAt: freeze.labelSetFrozenAt,
    purpose: 'Development-separated independently human-labeled route-quality holdout.',
    developmentExamplesSeparated: true,
    fixture: { relativePath: freeze.fixtureRelativePath, sha256: sha256(fixtureJsonl), rowCount: rows.length },
    labels: {
      sourceKind: 'independent-human', independentlyHumanLabeled: true, raterCount: 2,
      agreement: { metric: 'cohen-kappa', value: kappa.value, evidenceSha256: digestRecord(agreementEvidence) },
      adjudicationEvidenceSha256: digestRecord(adjudicationEvidence),
    },
    tuningFreeze: {
      frozenBeforePromptTuning: true,
      implementationFingerprint: freeze.implementationFingerprint,
      evidenceSha256: digestRecord(freezeEvidence),
    },
  }
  return Object.freeze({
    schemaVersion: 'codex-independent-human-route-labels.v1',
    evidenceClass: 'externally-supplied-human-attestations',
    readyForQualityClaims: true,
    agreement: { metric: 'cohen-kappa', ...kappa, evidenceSha256: provenance.labels.agreement.evidenceSha256 },
    disagreementIds,
    rows,
    fixtureJsonl,
    agreementEvidence,
    adjudicationEvidence,
    freezeEvidence,
    provenance,
    checksum: digestRecord({ fixtureJsonl, agreementEvidence, adjudicationEvidence, freezeEvidence, provenance }),
  })
}

function parseArguments(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--config', '--repo-root', '--output', '--generated-at'].includes(key) || value === undefined) fail('EMPIRICAL_ARGUMENTS_INVALID', 'usage: empirical-r10.cjs --config FILE --repo-root DIR --output FILE [--generated-at ISO]')
    args[key.slice(2)] = value
  }
  for (const required of ['config', 'repo-root', 'output']) if (!args[required]) fail('EMPIRICAL_ARGUMENTS_INVALID', `missing --${required}`)
  return args
}

function main(argv) {
  const args = parseArguments(argv)
  const record = runLocalEmpiricalEvaluation({
    repoRoot: args['repo-root'],
    preregistration: loadPreregistration(args.config),
    outputPath: args.output,
    generatedAt: args['generated-at'],
  })
  process.stdout.write(`${canonicalStringify({
    output: path.resolve(args.output), checksum: record.checksum,
    arms: record.arms, findings: record.findings, analystValue: record.analystAblation.value,
  })}\n`)
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.code || 'EMPIRICAL_R10_FAILED'}: ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  ARM_DEFINITIONS,
  HUMAN_BLOCKERS,
  evaluateIndependentHumanLabels,
  loadPreregistration,
  runLocalEmpiricalEvaluation,
  sha256,
  validatePreregistration,
}
