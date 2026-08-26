#!/usr/bin/env node
'use strict'

// This file retains the small legacy phase verdict CLI because installed v1
// supervisors call it directly.  The v2 export is the provider-neutral Codex
// supervisor integration seam: it composes the canonical settings, routing,
// scheduling, context, budget, process, and finalization modules without
// creating a second state authority.

const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')
const { resolveSettings, validateResolvedSettings } = require('./settings.js')
const routeFactsRouter = require('./router.js')
const {
  ROUTE_ANALYST_MAX_DURATION_MS,
  L0_DECISION_MAX_DURATION_MS,
  LIGHT_PLAN_MAX_DURATION_MS,
  createFindingDispositionDecision,
  createFrameworkMissCacheIdentity,
  createExactPathDecision,
  createRouteAnalystAdmission,
  evaluateExactPathPreflight,
  evaluateL0Decision,
  evaluateRouteAnalystResult,
  evaluateSafeTransportDegradation,
  remainingL0DecisionBudgetMs,
  validateRouteDecision,
} = require('./route-decision.js')
const {
  CentralScheduler,
  ADMISSION_COMPONENT_CEILINGS_MS,
  bindRoadmapExpansionAdmission,
  phaseBudgetVerdict: schedulerPhaseBudgetVerdict,
  resolveSchedulerSettings,
} = require('./scheduler.js')
const {
  auditDispatch,
  buildCheckerContext,
  buildContextFreeBrief,
  sha256Bytes,
  TranscriptStore,
  validateProviderCapabilities,
} = require('./context-envelope.js')
const {
  assertCheckerPlan,
  decideCheckerPlan,
  selectEffort,
  selectModelAssignment,
  validateReceiptBoundRegistry,
} = require('./effort-policy.js')
const {
  materializeCheckerSandboxes,
  planCheckerSandboxes,
} = require('./check-sandbox.js')
const {
  createAllWorkJoinedReceipt,
  createProductionPreMutationBaseline,
  openRunRecord,
} = require('./run-record.js')
const { EventLog, readChecksummedJson, stableStringify } = require('./event-log.js')
const {
  RuntimeStateStore, createEvidenceInvalidationGraph, runtimeCrashPrecondition,
} = require('./runtime-state.js')
const {
  RecoveryCheckpointAuthority,
  decodeSchedulerCheckpoint,
  prepareSchedulerCheckpoint,
} = require('./recovery-checkpoint.js')
const { MissionLock, processIdentityForPid } = require('./mission-lock.js')
const { AccountingAuthority, BudgetController } = require('./budget-controller.js')
const {
  ProcessOwner,
  createPosixProcessAdapter,
  createWindowsJobAdapter,
  prepareProcessLaunchEnvironment,
} = require('./process-owner.js')
const { CleanupRegistry, Finalizer } = require('./finalizer.js')
const { assertGenerationControlAuthority } = require('./generation-control.js')
const { deriveProfileLimits } = require('./codex-agent-profile.js')
const {
  executeAdmittedCodex,
  openCodexExecutableAdmission,
  resolveCodexExecutable,
} = require('./codex-executable.js')
const {
  evaluateOutcomes: evaluateCapturedDomainOutcomes,
  validateContracts: validateCapturedDomainContracts,
} = require('./captured-domain.js')
const { WorkerWorkspaceManager } = require('./worker-workspace.js')
const { auditPrivatePermissions, pathIsInside, readFileNoFollow } = require('./safe-run-root.js')
const { validateJsonSchema } = require('./json-schema-validator.js')

const SCOPE_SOFT_SEC = 60
const SCOPE_HARD_SEC = 300
const SCOPE_GRACE_SEC = 60
const MAX_FORCED_RESETS = 1
const DEFAULT_PRODUCT_HARD_MAXIMUM_MS = 3_600_000
const TERMINAL_OUTCOMES = Object.freeze(['DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED'])
const RECOVERABLE_RUNTIME_STATES = new Set([
  'PREPARE_WORK', 'RUN_WORK', 'ITEM_VERIFIED', 'CHECK_WORK', 'REPAIRING', 'CHECK_INCONCLUSIVE',
])
const CHECKER_ROLES = new Set([
  'plan-checker', 'independent-checker', 'independent-reviewer',
  'independent-tester', 'technical-decision-reviewer',
])
const CANONICAL_CHECKER_CODES = new Set(['PASS', 'FAIL', 'CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE'])
const CHECKER_REASSESSMENT_CODES = new Set([
  'CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE', 'INDEPENDENT_CHECK_RUNTIME_RETRY',
  'CHECK_REPORT_INVALID', 'EVIDENCE_CONSUMPTION_INVALID', 'REFERENCE_METHOD_INVALID',
  'TEST_OUTCOMES_INVALID',
  'DUPLICATE_UNDERLYING_EVIDENCE', 'DUPLICATE_REFERENCE_METHOD',
  'DUPLICATE_REFERENCE_METHOD_CLASS',
])
const CHECKER_FALSIFICATION_DOCTRINE = Object.freeze([
  'Derive expected behavior from the request, durable inputs, or an independent source; never from the subject implementation.',
  'For mappings, joins, references, identity, or deduplication, exercise at least three distinct entities and prove both forward consistency and reverse non-collision.',
  'For dates, versions, revocations, merges, migrations, or state transitions, test before, exactly at, between, and after each boundary, including a chained transition.',
  'For generated or serialized artifacts, reopen the saved deliverable through the actual downstream consumer/export path and prove non-empty requested topology and measurements. A custom or relationship-only parser is never a substitute; if the consumer cannot run, return CHECK_INCONCLUSIVE.',
  'For parsers, sanitizers, interpreters, or security boundaries, test the actual shipped runtime plus encoded, namespaced, malformed, mutation, and interaction-triggered cases. A self-authored substitute parser cannot authorize PASS; if the actual runtime cannot run, return CHECK_INCONCLUSIVE.',
  'A missing positive, negative, or boundary witness is CHECK_INCONCLUSIVE, never PASS.',
])
const CONTROLLER_FAILURE_RELEASE_STATES = new Set([
  'LOAD_SKILL', 'STORE_REQUEST_ENVELOPE', 'RESOLVE_SETTINGS', 'SELECT_SAFE_RUN_ROOT',
  'CREATE_RUN_RECORD', 'CHECK_PROVIDER_CAPABILITIES', 'START_ROUTE_ANALYST',
  'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION', 'PREPARE_WORK', 'RUN_WORK', 'ITEM_VERIFIED', 'CHECK_WORK',
  'REPAIRING', 'CHECK_INCONCLUSIVE', 'WORKER_CONTEXT_LOST', 'INTEGRATION_CONFLICT',
  'REASSESS_STRATEGY', 'CHANGING_ROUTE', 'APPEND_REQUEST_STEERING',
  'INVALIDATE_AFFECTED_RESULTS', 'MIGRATING_CONTRACT', 'RESUME_EXACT_STATE',
  'FINAL_CHECK', 'FINALIZING',
])
const WORKER_CONTEXT_FAILURE_CODES = new Set([
  'CODEX_CHILD_FAILED', 'CODEX_OUTPUT_TRANSPORT_INVALID', 'WORK_ITEM_RESULT_FAILED',
  'CODEX_SESSION_ID_MISSING', 'CODEX_USAGE_INCOMPLETE', 'CODEX_EVENT_STREAM_INVALID',
  'PROCESS_DRAIN_TIMEOUT', 'INCOMPLETE_USAGE_ACCOUNTING',
  'WORKER_CONTEXT_INVALID', 'WORKER_CONTEXT_REQUIRED', 'WORKER_RESULT_INVALID',
])
const ENVIRONMENT_FAILURE_CODES = new Set([
  'PROVIDER_UNSUPPORTED', 'DIAGNOSTIC_DENIAL_BLOCKED', 'CHECKER_SNAPSHOT_UNAVAILABLE',
  'CHECKER_SCRATCH_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE',
])
const CHECKER_LAUNCH_REASSESSMENT_CODES = new Set([
  ...WORKER_CONTEXT_FAILURE_CODES,
  'CHECKER_SNAPSHOT_UNAVAILABLE', 'CHECKER_SCRATCH_UNAVAILABLE',
])

function checkerLaunchRuntimeFailure(request, decision, runId, error) {
  return Object.freeze({
    schemaVersion: '2.0.0',
    code: 'RUNTIME_FAILURE',
    description: 'A tool or execution environment failed before the requested check could finish.',
    stateClass: 'terminal',
    runId,
    requestEnvelopeHash: decision.requestEnvelopeHash,
    currentVersionHash: request.candidateHash || null,
    candidateHash: request.candidateHash || null,
    completedResults: [],
    nextReadyWork: [],
    cause: {
      event: error && error.code || 'CHECKER_LAUNCH_FAILED',
      reason: 'The isolated checker transport failed; this result is non-authoritative and requires a fresh physical reassessment.',
      unblockPath: 'Launch one fresh evidence-bound checker reassessment.',
    },
    payloadSchemaId: 'autoprompt.checker-launch-reassessment.v2',
    payload: { error: serializeError(error) },
    recordedAt: new Date().toISOString(),
  })
}

function canonicalCheckerReassessment(input, expected = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SupervisorIntegrationError(
      'CHECK_RETRY_STATE_INVALID',
      'checker reassessment must be a bounded structured controller receipt',
    )
  }
  const allowedKeys = new Set([
    'code', 'priorResultEvidenceHash', 'conflictingCheckerId', 'reassignedCheckerId',
    'evidenceId', 'methodClass', 'methodHash',
  ])
  if (Object.keys(input).some(key => !allowedKeys.has(key)) ||
      !CHECKER_REASSESSMENT_CODES.has(input.code) ||
      !/^[a-f0-9]{64}$/u.test(input.priorResultEvidenceHash || '') ||
      (expected.resultHash && input.priorResultEvidenceHash !== expected.resultHash)) {
    throw new SupervisorIntegrationError(
      'CHECK_RETRY_STATE_INVALID',
      'checker reassessment code and exact prior result evidence must be canonical',
    )
  }
  const checkerId = value => typeof value === 'string' &&
    /^independent-check-\d+(?:-repair-\d+)?(?:-runtime-retry-\d+)?$/u.test(value)
  if (input.conflictingCheckerId !== undefined && input.conflictingCheckerId !== null &&
      !checkerId(input.conflictingCheckerId)) {
    throw new SupervisorIntegrationError('CHECK_RETRY_STATE_INVALID', 'conflicting checker identity is not canonical')
  }
  if (input.reassignedCheckerId !== undefined &&
      (!checkerId(input.reassignedCheckerId) ||
       (expected.checkerId && input.reassignedCheckerId !== expected.checkerId))) {
    throw new SupervisorIntegrationError('CHECK_RETRY_STATE_INVALID', 'reassigned checker identity is not canonical')
  }
  if (input.evidenceId !== undefined &&
      (typeof input.evidenceId !== 'string' || !input.evidenceId.trim() || input.evidenceId.length > 256)) {
    throw new SupervisorIntegrationError('CHECK_RETRY_STATE_INVALID', 'conflicting evidence identity is not bounded')
  }
  if (input.methodClass !== undefined && !INDEPENDENT_REFERENCE_METHOD_CLASSES.has(input.methodClass)) {
    throw new SupervisorIntegrationError('CHECK_RETRY_STATE_INVALID', 'conflicting reference-method class is not canonical')
  }
  if (input.methodHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.methodHash)) {
    throw new SupervisorIntegrationError('CHECK_RETRY_STATE_INVALID', 'conflicting reference-method hash is not canonical')
  }
  return Object.freeze({
    code: input.code,
    priorResultEvidenceHash: input.priorResultEvidenceHash,
    ...(input.conflictingCheckerId !== undefined
      ? { conflictingCheckerId: input.conflictingCheckerId } : {}),
    ...(input.reassignedCheckerId !== undefined
      ? { reassignedCheckerId: input.reassignedCheckerId } : {}),
    ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId.trim() } : {}),
    ...(input.methodClass !== undefined ? { methodClass: input.methodClass } : {}),
    ...(input.methodHash !== undefined ? { methodHash: input.methodHash } : {}),
  })
}

function checkerVerdictPassed(logicalRole, result) {
  return CHECKER_ROLES.has(logicalRole) && Boolean(result) && result.code === 'PASS'
}

function roadmapPlanOracleForWorkItem(workItemId) {
  return /^roadmap-plan-recheck(?:-runtime-retry)?$/u.test(String(workItemId || ''))
    ? 'roadmap-plan-oracle-recheck'
    : 'roadmap-plan-oracle'
}

function checkerRecoveryNextReady(workItemId, result, disposition = null) {
  const id = String(workItemId || '')
  const code = result && result.code
  if (/^independent-check-\d+/u.test(id) && disposition) {
    if (['CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE'].includes(code)) {
      return disposition.nonAuthoritativeRetryId ? [disposition.nonAuthoritativeRetryId] : []
    }
    if (code === 'FAIL') return disposition.failureRepairId ? [disposition.failureRepairId] : []
  }
  if (['CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE'].includes(code)) {
    if (/^roadmap-plan-(?:check|recheck)$/u.test(id)) return [`${id}-runtime-retry`]
    if (/^independent-check-\d+(?:-repair-\d+)?$/u.test(id)) return [`${id}-runtime-retry-1`]
  }
  if (code === 'FAIL') {
    if (id === 'roadmap-plan-check' || id === 'roadmap-plan-check-runtime-retry') {
      return ['roadmap-author-plan-repair']
    }
    if (/^independent-check-\d+$/u.test(id)) return ['work-1-repair-1']
  }
  return []
}

function durableNextReadyAfter(
  logicalRole,
  result,
  nextReady,
  fallback = [],
  workItemId = null,
  checkerRecoveryDisposition = null,
) {
  if (CHECKER_ROLES.has(logicalRole) && !checkerVerdictPassed(logicalRole, result)) {
    return checkerRecoveryNextReady(workItemId, result, checkerRecoveryDisposition)
  }
  return nextReady || fallback || []
}

function recoveryGroupNextReady(request = {}, completedWorkIds = []) {
  if (!Array.isArray(request.recoveryGroupWorkIds)) return request.nextReadyAfter || []
  const recoveryJoinWorkIds = request.recoveryJoinWorkIds === undefined
    ? request.recoveryJoinWorkId ? [request.recoveryJoinWorkId] : []
    : request.recoveryJoinWorkIds
  if (!uniqueStrings(request.recoveryGroupWorkIds) ||
      !uniqueStrings(recoveryJoinWorkIds) ||
      typeof request.workItemId !== 'string' || !request.workItemId) {
    throw new SupervisorIntegrationError(
      'CHECK_RETRY_STATE_INVALID',
      `recovery group continuation for ${request.workItemId || 'unknown'} is not an exact canonical work list`,
    )
  }
  const completed = new Set(completedWorkIds)
  completed.add(request.workItemId)
  const missing = request.recoveryGroupWorkIds.filter(workItemId => !completed.has(workItemId))
  return missing.length > 0 ? missing : recoveryJoinWorkIds
}

function adoptedLeaseMatchesStage(route, logicalRole, stage) {
  const checker = CHECKER_ROLES.has(logicalRole)
  const roadmapWorkStageChecker = route === 'ROADMAP' && logicalRole === 'plan-checker'
  if (stage === 'work') return !checker || roadmapWorkStageChecker
  if (stage === 'check') return checker && !roadmapWorkStageChecker
  return stage === 'route' ? logicalRole === 'route-analyst' : false
}

function terminalFinalizationDiagnostics(result = {}) {
  const terminalEnvelope = result.terminalEnvelope || null
  const terminalCause = terminalEnvelope && terminalEnvelope.cause || null
  return Object.freeze({
    terminalEnvelope,
    reason: result.reason || terminalEnvelope && terminalEnvelope.reason ||
      terminalCause && terminalCause.reason || 'typed runtime outcome',
    unblockPath: result.unblockPath || terminalEnvelope && terminalEnvelope.unblockPath ||
      terminalCause && terminalCause.unblockPath ||
      terminalEnvelope && terminalEnvelope.payload && terminalEnvelope.payload.unblockPath || null,
  })
}

function resolveTerminalReceiptCandidateHash({
  logicalRole,
  runtimeStateProvider,
  requestCandidateHash,
  resultCandidateHash,
}) {
  if (!CHECKER_ROLES.has(logicalRole)) return resultCandidateHash || null
  // The runtime provider is authoritative even when its canonical candidate is
  // deliberately null during pre-mutation ROADMAP checking. Fall back to the
  // inspected artifact only when no runtime provider exists at all.
  if (typeof runtimeStateProvider === 'function') {
    return runtimeStateProvider().candidateHash || null
  }
  return requestCandidateHash || null
}
const TARGET_MUTATOR_ROLES = new Set(['worker', 'roadmap-author'])
const FORBIDDEN_RUNTIME_ROLES = new Set([
  'framework-generator', 'framework-validator', 'scribe', 'janitor',
  'scope-coordinator', 'scoper', 'sweep-coordinator', 'sweeper',
  'goal-checker', 'juror', 'intake', 'preflight-probe',
])
// Framework generation is deterministic C0 work. Keeping the historical
// profile installed for diagnostics must not make it a writable-worker alias.
const FORBIDDEN_DIRECT_ALIASES = new Set(['ap-framework-generator', 'ap-framework-validator'])
const WORK_CHECKS = Object.freeze({
  'inspect/report': ['exact-diff-or-receipts'],
  'research/decide': ['receipts'],
  'mechanical-change': ['exact-diff'],
  'debug/fix': ['failing-to-passing-behavior'],
  'implement/build': ['failing-to-passing-behavior'],
  refactor: ['behavior-preserving-characterization'],
  'review/polish': ['rendered-journey-or-documentation-example'],
  'external-operation': ['dry-run-and-idempotency'],
})
const RISK_CHECKS = Object.freeze({
  'authorization/security/privacy': 'authorization-security-privacy',
  'destructive-migration': 'destructive-migration',
  'external-write/cost': 'external-write-or-cost',
  'irreversible-action': 'irreversible-action',
  'concurrency/shared-state': 'concurrency-or-shared-state',
  'performance/SLO': 'performance-or-service-level',
  'safety/compliance': 'safety-or-compliance',
})
const CONTROL_PLANE_PHYSICAL_ROLE = 'autoprompt.v2.deterministic-control-plane'
const REQUIRED_SAFETY_CHANNELS = Object.freeze([
  'repositoryGitBarrier',
  'gitCommandNetworkBarrier',
  'githubCliCredentialIsolation',
  'shellOutboundNetworkSandbox',
  'providerConnectorApiWriteToolDenial',
])
const STREAMED_ROUTE_EVENT_COUNT = Symbol('streamedRouteEventCount')
const ROUTE_CAPABILITY_EFFECTS = Object.freeze({
  PRE_ROUTE: Object.freeze(['read']),
  DIRECT: Object.freeze(['isolated-write', 'read', 'run', 'write']),
  LIGHT: Object.freeze(['isolated-write', 'read', 'run', 'technical-decision', 'write']),
  ROADMAP: Object.freeze(['coordinate', 'isolated-write', 'plan-write', 'read', 'run', 'write']),
})
const CANONICAL_PROVIDER_ROLES = Object.freeze({
  'route-analyst': 'ap-route-analyst',
  'run-owner': 'ap-run-owner',
  'roadmap-author': 'ap-roadmap-author',
  scout: 'ap-roadmap-scout',
  'plan-checker': 'ap-independent-checker',
  'mission-coordinator': 'ap-run-coordinator',
  'ap-work-group-manager': 'ap-work-group-manager',
  worker: 'ap-worker',
  'independent-checker': 'ap-independent-checker',
  'independent-reviewer': 'ap-independent-checker',
  'independent-tester': 'ap-independent-checker',
  'technical-decision-reviewer': 'ap-independent-checker',
  'diagnostic-probe': 'ap-worker',
})
const SUPERVISOR_ADAPTER_INTERFACE = Object.freeze({
  schemaVersion: 1,
  provider: 'codex',
  factory: 'createSupervisorOptions',
  requiredFactoryInputs: Object.freeze([
    'AUTOPROMPT_ACTIVATION_RECORD', 'AUTOPROMPT_ENFORCEMENT_PROOF',
    'AUTOPROMPT_PROFILE_PATH', 'AUTOPROMPT_RUN_ID',
  ]),
  launchTransport: 'codex-exec-jsonl',
  entryPrompt: 'hash-verified-autoprompt-request-envelope-v2',
  normalForkTurns: 'none',
})

class PhaseBudgetError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PhaseBudgetError'
    this.code = code
    this.details = details
  }
}

class SupervisorIntegrationError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SupervisorIntegrationError'
    this.code = code
    this.details = details
  }
}

function clampNonNegInt(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.floor(number)
}

function sameCanonicalValue(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function protectedDeadlinePurpose(purpose) {
  return ['verification', 'recovery', 'finalization', 'finalizer'].includes(purpose)
}

const PRODUCTION_PHASE_NAMES = Object.freeze([
  'EXECUTION_BUILD',
  'ASSURANCE_REVIEW',
  'RECOVERY_REPLAY',
  'FINALIZATION_RELEASE',
])

function productionPhaseBudgets(wallMs) {
  if (!Number.isSafeInteger(wallMs) || wallMs < 10) {
    throw new SupervisorIntegrationError(
      'BUDGET_CONFIG_INVALID',
      'production phase budgets require at least ten milliseconds of bounded wall time',
    )
  }
  const phase = hardFraction => {
    const hardMs = Math.max(2, Math.floor(wallMs * hardFraction))
    const softMs = Math.max(1, Math.min(hardMs - 1, Math.floor(hardMs * 0.8)))
    return Object.freeze({ softMs, hardMs })
  }
  return Object.freeze({
    EXECUTION_BUILD: phase(0.65),
    ASSURANCE_REVIEW: phase(0.20),
    RECOVERY_REPLAY: phase(0.15),
    FINALIZATION_RELEASE: phase(0.10),
  })
}

function lifecycleBudgetPhase(input = {}) {
  if (input.finalizing === true || ['FINALIZING', 'RELEASING_LOCK'].includes(input.nextState) ||
      ['finalization', 'finalizer'].includes(input.purpose)) return 'FINALIZATION_RELEASE'
  if (input.recovering === true || ['RESUMING', 'RESUME_EXACT_STATE'].includes(input.nextState) ||
      input.purpose === 'recovery') return 'RECOVERY_REPLAY'
  if (['CHECK_WORK', 'REPAIRING', 'FINAL_CHECK'].includes(input.nextState) ||
      input.purpose === 'verification') return 'ASSURANCE_REVIEW'
  if (['PREPARE_WORK', 'RUN_WORK', 'ITEM_VERIFIED'].includes(input.nextState) ||
      ['planning', 'work'].includes(input.purpose)) return 'EXECUTION_BUILD'
  return null
}

function diagnosticDenialDisposition(workerCount) {
  if (!Number.isSafeInteger(workerCount) || workerCount < 0 || workerCount > 1) {
    throw new SupervisorIntegrationError(
      'DIAGNOSTIC_WORKER_LIMIT',
      'a denied diagnostic may use at most one bounded worker before BLOCKED',
      { workerCount },
    )
  }
  return Object.freeze({ outcome: 'BLOCKED', workerCount, startWorkers: false })
}

function normalizeTaskDeadline(declared, options = {}) {
  const nowMs = Number(options.nowMs)
  const productHardMaximumMs = Number(options.productHardMaximumMs ?? DEFAULT_PRODUCT_HARD_MAXIMUM_MS)
  const wallTimeUnbounded = options.wallTimeUnbounded === true
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(productHardMaximumMs) || productHardMaximumMs <= 0) {
    return { valid: false, code: 'TASK_DEADLINE_INVALID', reason: 'deadline admission requires an injected wall clock and positive product maximum' }
  }
  const deadline = declared || {
    absoluteDeadline: new Date(nowMs + productHardMaximumMs).toISOString(),
    source: 'product-maximum',
    verificationReservePercent: 25,
    recoveryAndFinalizationReservePercent: 10,
  }
  const absoluteMs = deadline && Date.parse(deadline.absoluteDeadline)
  if (!deadline || typeof deadline !== 'object' || Array.isArray(deadline) ||
      !Number.isFinite(absoluteMs) ||
      !['explicit-invocation', 'task-host', 'product-maximum'].includes(deadline.source) ||
      !Number.isSafeInteger(deadline.verificationReservePercent) || deadline.verificationReservePercent < 25 ||
      deadline.verificationReservePercent > 100 ||
      !Number.isSafeInteger(deadline.recoveryAndFinalizationReservePercent) ||
      deadline.recoveryAndFinalizationReservePercent < 10 ||
      deadline.recoveryAndFinalizationReservePercent > 100) {
    return { valid: false, code: 'TASK_DEADLINE_INVALID', reason: 'task deadline is malformed' }
  }
  if (!wallTimeUnbounded && absoluteMs <= nowMs) {
    return { valid: false, code: 'TASK_DEADLINE_EXPIRED', reason: 'task deadline has expired' }
  }
  const wallMs = wallTimeUnbounded ? productHardMaximumMs : absoluteMs - nowMs
  if (!wallTimeUnbounded && declared && wallMs > productHardMaximumMs) {
    return { valid: false, code: 'TASK_DEADLINE_EXCEEDS_PRODUCT_MAXIMUM', reason: 'task deadline exceeds the product hard maximum' }
  }
  const verificationReserveMs = Math.floor(wallMs * deadline.verificationReservePercent / 100)
  const finalizationReserveMs = Math.floor(wallMs * deadline.recoveryAndFinalizationReservePercent / 100)
  if (verificationReserveMs + finalizationReserveMs >= wallMs) {
    return { valid: false, code: 'TASK_DEADLINE_INSUFFICIENT', reason: 'deadline leaves no production interval after protected reserves' }
  }
  return { valid: true, deadline: { ...deadline }, wallMs, verificationReserveMs, finalizationReserveMs }
}

function accountingDelta(overrides = {}) {
  return {
    launches: 0,
    retries: 0,
    sessions: 0,
    elapsedMilliseconds: 0,
    costMicrounits: 0,
    tokenUsage: { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 },
    ...overrides,
    tokenUsage: {
      noncachedInput: 0,
      cachedInput: 0,
      output: 0,
      reasoning: 0,
      ...(overrides.tokenUsage || {}),
    },
  }
}

function schedulerUsageTotal(groups = {}) {
  const total = {
    noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0,
    weightedCost: 0, latencyMs: 0, workMs: 0,
  }
  for (const usage of Object.values(groups || {})) {
    for (const field of Object.keys(total)) total[field] += Number(usage && usage[field] || 0)
  }
  return total
}

function recoveryResumeState(savedState, hasLiveModelSession = false) {
  // SAVE_ROUTE_ANALYSIS is a durability boundary, not evidence that the
  // recommendation artifact exists.  Only ROUTE_ANALYSIS_SAVED may advance
  // the canonical state to L0_ROUTE_DECISION.
  if (savedState === 'SAVE_ROUTE_ANALYSIS') return 'SAVE_ROUTE_ANALYSIS'
  if (savedState === 'FINAL_CHECK') return 'FINALIZING'
  return savedState
}

function recoveryMilestonesForState(state) {
  const milestones = []
  if (!['START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS'].includes(state)) milestones.push('route-analysis')
  if (!['START_ROUTE_ANALYST', 'SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION'].includes(state)) {
    milestones.push('route-decision')
  }
  if (['RUN_WORK', 'ITEM_VERIFIED', 'CHECK_WORK', 'REPAIRING', 'CHECK_INCONCLUSIVE',
    'WORKER_CONTEXT_LOST', 'INTEGRATION_CONFLICT', 'REASSESS_STRATEGY', 'FINAL_CHECK', 'FINALIZING']
    .includes(state)) milestones.push('work-preparation')
  if (['FINAL_CHECK', 'FINALIZING'].includes(state)) milestones.push('final-check')
  return milestones
}

function positiveInteger(value, label) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new PhaseBudgetError('BUDGET_CONFIG_INVALID', `${label} must be a positive integer`)
  }
  return number
}

// Compatibility wrapper around the scheduler's sole phase-budget authority.
// Grace and convergence requests can warn, but cannot reset work before the
// configured hard boundary without a typed NO_PROGRESS_INVARIANT.
function phaseBudgetVerdict(state) {
  const input = state || {}
  if (typeof input.phase !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.phase)) {
    throw new PhaseBudgetError('BUDGET_CONFIG_INVALID', 'phase must be a bounded identifier')
  }
  const elapsed = clampNonNegInt(input.elapsedSec, 0)
  const soft = positiveInteger(input.softSec === undefined ? SCOPE_SOFT_SEC : input.softSec, 'softSec')
  const hard = positiveInteger(input.hardSec === undefined ? SCOPE_HARD_SEC : input.hardSec, 'hardSec')
  if (soft >= hard) throw new PhaseBudgetError('BUDGET_CONFIG_INVALID', 'phase requires 0 < softSec < hardSec')
  const landedEvidence = Array.isArray(input.landedAngles) ? input.landedAngles : []
  const landed = []
  if (landedEvidence.length) {
    if (typeof input.activationId !== 'string' || !input.activationId ||
        !Number.isSafeInteger(input.generationId) || input.generationId < 1) {
      throw new PhaseBudgetError(
        'SCOPE_EVIDENCE_UNBOUND',
        'scope residual evidence requires an activation and positive generation authority',
      )
    }
    for (const evidence of landedEvidence) {
      if (!evidence || typeof evidence !== 'object' ||
          typeof evidence.activationId !== 'string' || !evidence.activationId ||
          !Number.isSafeInteger(evidence.generationId) || evidence.generationId < 1) {
        throw new PhaseBudgetError(
          'SCOPE_EVIDENCE_UNBOUND',
          'scope residual evidence must carry its activation and generation authority',
        )
      }
      if (evidence.activationId !== input.activationId || evidence.generationId !== input.generationId) continue
      if (typeof evidence.angle !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(evidence.angle)) {
        throw new PhaseBudgetError('SCOPE_EVIDENCE_INVALID', 'current scope residual evidence has an invalid angle')
      }
      landed.push(evidence.angle)
    }
  }
  return {
    ...schedulerPhaseBudgetVerdict({
      elapsedMs: elapsed * 1000,
      softMs: soft * 1000,
      hardMs: hard * 1000,
      scopeRequest: Boolean(input.scopeRequest),
      recoveryRequest: Boolean(input.recoveryRequest),
      noProgressInvariant: input.noProgressInvariant,
    }),
    residual: landed,
  }
}

const EXIT_CODE = Object.freeze({
  continue: 0,
  warn: 10,
  'hard-boundary': 20,
  'escalate-no-progress': 30,
})

function parseFlagPairs(argv) {
  const result = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      result._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) result[key] = true
    else {
      if (result[key] === undefined) result[key] = next
      else result[key] = Array.isArray(result[key]) ? [...result[key], next] : [result[key], next]
      index += 1
    }
  }
  return result
}

function runVerdictCli(argv) {
  const args = parseFlagPairs(argv)
  try {
    const landedAngles = typeof args.landed === 'string' && args.landed
      ? args.landed.split(',').filter(Boolean).map((angle) => ({
          angle,
          activationId: args['activation-id'],
          generationId: Number(args['generation-id']),
        }))
      : []
    const verdict = phaseBudgetVerdict({
      phase: args.phase,
      elapsedSec: args.elapsed,
      softSec: args.soft,
      hardSec: args.hard,
      convergeRequestAgeSec: args['request-age'],
      graceSec: args.grace,
      priorForcedResets: args['prior-resets'],
      maxForcedResets: args['max-resets'],
      activationId: args['activation-id'],
      generationId: Number(args['generation-id']),
      landedAngles,
    })
    process.stdout.write(`${verdict.action} landed=${verdict.residual.join(',')}\n`)
    return EXIT_CODE[verdict.action]
  } catch (error) {
    process.stderr.write(`phase-budget: ${error.code || 'RUNTIME_FAILURE'}: ${error.message}\n`)
    return 2
  }
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function activationAttestationPayload(attestation) {
  return Buffer.from(JSON.stringify({
    schemaVersion: attestation.schemaVersion,
    attestationId: attestation.attestationId,
    providerId: attestation.providerId,
    issuer: attestation.issuer,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
    runtimeIdentityHash: attestation.runtimeIdentityHash,
    activationNonce: attestation.activationNonce,
    verificationMethod: attestation.verificationMethod,
    verifiedCapabilities: attestation.verifiedCapabilities,
    canonicalProviderTrustSha256: attestation.canonicalProviderTrustSha256,
    result: attestation.result,
  }), 'utf8')
}

function providerRuntimeIdentityHash(record) {
  const boundary = record.activationBoundary || {}
  return sha256Bytes(Buffer.from(JSON.stringify({
    activationId: record.activationId,
    capabilityGeneration: record.capability && record.capability.generation,
    requestSha256: record.request && record.request.sha256,
    targetIdentity: record.target,
    configSha256: boundary.configSha256,
    payloadManifestSha256: boundary.payloadManifestSha256,
    profileSha256: boundary.enforcementProof && boundary.enforcementProof.profileSha256,
    privatePermissions: boundary.privatePermissions,
    sandboxIdentity: boundary.sandboxIdentity,
    modelSelectionSha256: sha256Bytes(Buffer.from(JSON.stringify(record.modelSelection), 'utf8')),
    roleProjectionSha256: sha256Bytes(Buffer.from(JSON.stringify(record.roleProjection), 'utf8')),
    providerProbeSha256: sha256Bytes(Buffer.from(JSON.stringify(record.providerProbe), 'utf8')),
    providerCapabilitiesSha256: sha256Bytes(Buffer.from(JSON.stringify(record.providerCapabilities), 'utf8')),
    canonicalProviderTrustSha256: record.providerTrust?.sha256 || null,
    codexExecutableAdmissionSha256: boundary.codexExecutable
      ? sha256Bytes(Buffer.from(JSON.stringify(boundary.codexExecutable), 'utf8'))
      : null,
    safetyInspectionSha256: sha256Bytes(Buffer.from(JSON.stringify(record.safety), 'utf8')),
    supervisorAdapterSha256: boundary.supervisorAdapterSha256,
  }), 'utf8'))
}

function verifyActivationProviderAttestation(record, environment = process.env, now = Date.now()) {
  const binding = record.providerAttestation
  const attestation = binding && binding.attestation
  const publicKey = binding && binding.publicKey
  const signature = attestation && attestation.signature
  const issuedAt = Date.parse(attestation && attestation.issuedAt)
  const expiresAt = Date.parse(attestation && attestation.expiresAt)
  const attestationHash = attestation && sha256Bytes(Buffer.from(JSON.stringify(attestation), 'utf8'))
  const capabilitiesHash = sha256Bytes(Buffer.from(JSON.stringify(record.providerCapabilities), 'utf8'))
  if (!binding || binding.contractVersion !== '2.0.0' || binding.attestationSha256 !== attestationHash ||
      binding.providerCapabilitiesSha256 !== capabilitiesHash ||
      !publicKey || publicKey.algorithm !== 'ed25519' || publicKey.format !== 'spki-der' ||
      !/^[a-f0-9]{64}$/.test(publicKey.keyId || '') || typeof publicKey.value !== 'string' ||
      !attestation || attestation.schemaVersion !== '2.0.0' ||
      attestation.attestationId !== `codex:${record.activationId}:${record.capability.generation}` ||
      attestation.providerId !== 'codex' || attestation.issuer !== 'autoprompt-codex-activation-v2' ||
      !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt ||
      Number(now) < issuedAt || Number(now) >= expiresAt ||
      attestation.expiresAt !== record.capability.expiresAt ||
      attestation.runtimeIdentityHash !== providerRuntimeIdentityHash(record) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(attestation.activationNonce || '') ||
      attestation.verificationMethod !== 'live-conformance-suite' ||
      JSON.stringify(attestation.verifiedCapabilities) !==
        JSON.stringify(['isolation', 'privateSkillRoot', 'processOwnership']) ||
      !record.providerTrust ||
      attestation.canonicalProviderTrustSha256 !== record.providerTrust.sha256 ||
      attestation.result !== 'supported' || !signature || signature.algorithm !== 'ed25519' ||
      signature.keyId !== publicKey.keyId || record.capability.providerAttestationKeyId !== publicKey.keyId ||
      typeof signature.value !== 'string' ||
      (environment.AUTOPROMPT_ACTIVATION_ATTESTATION_SHA256 &&
        environment.AUTOPROMPT_ACTIVATION_ATTESTATION_SHA256 !== attestationHash)) {
    throw new SupervisorIntegrationError('ACTIVATION_ATTESTATION_INVALID', 'signed activation capability receipt is invalid, stale, or foreign')
  }
  let keyBytes
  let signatureBytes
  try {
    keyBytes = Buffer.from(publicKey.value, 'base64url')
    signatureBytes = Buffer.from(signature.value, 'base64url')
  } catch {
    throw new SupervisorIntegrationError('ACTIVATION_ATTESTATION_INVALID', 'activation attestation encoding is invalid')
  }
  let verified = false
  try {
    verified = sha256Bytes(keyBytes) === publicKey.keyId && crypto.verify(
      null,
      activationAttestationPayload(attestation),
      crypto.createPublicKey({ key: keyBytes, type: 'spki', format: 'der' }),
      signatureBytes,
    )
  } catch {}
  if (!verified) {
    throw new SupervisorIntegrationError('ACTIVATION_ATTESTATION_INVALID', 'activation attestation signature failed verification')
  }
  return Object.freeze({ hash: attestationHash, capabilities: Object.freeze([...attestation.verifiedCapabilities]), binding })
}

// Receipts are intentionally process-local controller capabilities.  The
// production exact-path preflight can therefore reopen the issuing authority
// without accepting an authority reference supplied by the caller.
const RUNTIME_CAPABILITY_RECEIPT_AUTHORITIES = new WeakMap()

class RuntimeCapabilityAuthority {
  constructor(options = {}) {
    if (!options.activationAttestation || !/^[a-f0-9]{64}$/.test(options.activationAttestation.hash || '') ||
        typeof options.runId !== 'string' || !options.runId ||
        !Number.isSafeInteger(options.generation) || options.generation < 1 ||
        typeof options.targetIdentity !== 'string' || !options.targetIdentity ||
        !/^[a-f0-9]{64}$/.test(options.runtimeMetadataSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(options.profileSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(options.payloadManifestSha256 || '')) {
      throw new SupervisorIntegrationError('RUNTIME_CAPABILITY_INVALID', 'runtime capability authority lacks an activation-bound identity')
    }
    this.binding = Object.freeze({
      activationAttestationSha256: options.activationAttestation.hash,
      runtimeMetadataSha256: options.runtimeMetadataSha256,
      profileSha256: options.profileSha256,
      payloadManifestSha256: options.payloadManifestSha256,
      runId: options.runId,
      generation: options.generation,
      targetIdentity: options.targetIdentity,
      provider: 'codex',
    })
    this.now = options.now || Date.now
    this.environment = options.environment || process.env
    this.key = options.key || crypto.randomBytes(32)
    if (!Buffer.isBuffer(this.key) || this.key.length < 32) {
      throw new SupervisorIntegrationError('RUNTIME_CAPABILITY_INVALID', 'runtime capability signing key is invalid')
    }
    this.receipts = new WeakSet()
  }

  issue(input = {}) {
    const providerCapabilities = validateProviderCapabilities(input.providerCapabilities)
    const capabilitySet = Object.keys(providerCapabilities).filter(name => providerCapabilities[name]).sort()
    const evidenceHashes = [...new Set(input.evidenceHashes || [])].sort()
    const allowedControlCapabilities = new Set(['processOwnership', 'topologyEnforcement'])
    const controlCapabilitySet = [...new Set(input.controlCapabilities || [])].sort()
    const routeEffects = input.routeEffects && typeof input.routeEffects === 'object'
      ? Object.fromEntries(Object.entries(input.routeEffects).map(([route, effects]) => [
          route, [...new Set(Array.isArray(effects) ? effects : [])].sort(),
        ]))
      : Object.fromEntries((input.allowedRoutes || []).map(route => [route, [...new Set(input.allowedEffects || [])].sort()]))
    if (evidenceHashes.length === 0 || evidenceHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)) ||
        controlCapabilitySet.some(capability => !allowedControlCapabilities.has(capability)) ||
        typeof input.cliVersion !== 'string' || !input.cliVersion ||
        !Array.isArray(input.allowedRoutes) || input.allowedRoutes.length === 0 ||
        !Array.isArray(input.allowedEffects) || input.allowedEffects.length === 0 ||
        input.allowedRoutes.some(route => !Array.isArray(routeEffects[route]) || routeEffects[route].length === 0 ||
          routeEffects[route].some(effect => !input.allowedEffects.includes(effect)))) {
      throw new SupervisorIntegrationError('RUNTIME_CAPABILITY_INVALID', 'runtime probes require versioned evidence, routes, and effects')
    }
    const issuedAtMs = Number(this.now())
    const expiresAtMs = runtimeCapabilityExpiryMs(input.expiresAtMs, issuedAtMs, this.environment)
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) {
      throw new SupervisorIntegrationError('RUNTIME_CAPABILITY_INVALID', 'runtime capability expiry is invalid')
    }
    const body = {
      schemaVersion: 1,
      ...this.binding,
      cliVersion: input.cliVersion,
      platform: process.platform,
      runtimeVersion: process.version,
      capabilitySet,
      controlCapabilitySet,
      allowedRoutes: [...new Set(input.allowedRoutes)].sort(),
      allowedEffects: [...new Set(input.allowedEffects)].sort(),
      routeEffects,
      probeEvidenceHashes: evidenceHashes,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
    const signature = crypto.createHmac('sha256', this.key).update(JSON.stringify(body)).digest('hex')
    const receipt = Object.freeze({ ...body, signature })
    this.receipts.add(receipt)
    RUNTIME_CAPABILITY_RECEIPT_AUTHORITIES.set(receipt, this)
    return receipt
  }

  verify(receipt, expected = {}) {
    if (!receipt || !this.receipts.has(receipt)) {
      throw new SupervisorIntegrationError('RUNTIME_CAPABILITY_INVALID', 'runtime capability is forged or belongs to another controller')
    }
    const unsigned = { ...receipt }
    delete unsigned.signature
    const signature = crypto.createHmac('sha256', this.key).update(JSON.stringify(unsigned)).digest('hex')
    const actual = Buffer.from(String(receipt.signature || ''), 'hex')
    const wanted = Buffer.from(signature, 'hex')
    const expiresAtMs = Date.parse(receipt.expiresAt)
    if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted) ||
        Number(this.now()) >= expiresAtMs || Object.entries(this.binding).some(([key, value]) => receipt[key] !== value) ||
        expected.runId !== this.binding.runId || expected.generation !== this.binding.generation ||
        expected.targetIdentity !== this.binding.targetIdentity ||
        !receipt.allowedRoutes.includes(expected.route)) {
      throw new SupervisorIntegrationError('RUNTIME_CAPABILITY_INVALID', 'runtime capability is stale, cross-run, downgraded, or foreign')
    }
    if (typeof expected.assignmentId !== 'string' || !expected.assignmentId ||
        !/^[a-f0-9]{64}$/.test(expected.assignmentHash || '')) {
      throw new SupervisorIntegrationError(
        'RUNTIME_CAPABILITY_INVALID',
        'runtime capability verification requires the exact canonical assignment identity',
      )
    }
    const expectedEffects = [...new Set(expected.effects || [expected.effect].filter(Boolean))].sort()
    const admittedRouteEffects = receipt.routeEffects && receipt.routeEffects[expected.route] || []
    if (expectedEffects.length === 0 || expectedEffects.some(effect => !admittedRouteEffects.includes(effect))) {
      throw new SupervisorIntegrationError(
        'RUNTIME_CAPABILITY_INVALID',
        'runtime capability does not admit the exact route-specific read/run/write effects',
        { route: expected.route, expectedEffects, admittedRouteEffects },
      )
    }
    const required = Array.isArray(expected.requiredCapabilities) ? expected.requiredCapabilities : []
    const authenticatedCapabilities = [
      ...new Set([...receipt.capabilitySet, ...(receipt.controlCapabilitySet || [])]),
    ].sort()
    const missing = required.filter(name => !authenticatedCapabilities.includes(name))
    if (missing.length) {
      throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'runtime capability receipt does not cover this launch', { missing })
    }
    const receiptSha256 = sha256Bytes(Buffer.from(JSON.stringify(receipt)))
    const launchBinding = Object.freeze({
      runId: expected.runId,
      generation: expected.generation,
      targetIdentity: expected.targetIdentity,
      route: expected.route,
      effects: Object.freeze(expectedEffects),
      assignmentId: expected.assignmentId,
      assignmentHash: expected.assignmentHash,
      receiptSha256,
    })
    const launchBindingSha256 = crypto.createHmac('sha256', this.key)
      .update(stableStringify(launchBinding)).digest('hex')
    return Object.freeze({
      verified: true,
      receiptSha256,
      launchBinding,
      launchBindingSha256,
      capabilitySet: Object.freeze(authenticatedCapabilities),
    })
  }
}

class CompatibilityRecoveryAuthority {
  constructor() {
    this.legacyTranslationConsumed = false
    this.canonicalValidationConsumed = false
  }

  normalNewRun() {
    return Object.freeze({ mode: 'NORMAL_NEW_RUN', rolesInvoked: Object.freeze([]) })
  }

  translateLegacy(input = {}) {
    if (this.legacyTranslationConsumed) {
      throw new SupervisorIntegrationError('LEGACY_TRANSLATION_ALREADY_CONSUMED', 'legacy intake translation is one-shot')
    }
    if (!input.source || input.source.schemaVersion !== 1 || typeof input.translate !== 'function') {
      throw new SupervisorIntegrationError('LEGACY_TRANSLATION_INVALID', 'legacy intake requires one recognized v1 record and deterministic translator')
    }
    const translated = input.translate(structuredClone(input.source))
    if (!translated || translated.schemaVersion !== '2.0.0') {
      throw new SupervisorIntegrationError('LEGACY_TRANSLATION_INVALID', 'legacy translation must emit canonical v2 state')
    }
    this.legacyTranslationConsumed = true
    return Object.freeze({ mode: 'LEGACY_TRANSLATED_ONCE', translated: Object.freeze(translated), rolesInvoked: Object.freeze([]) })
  }

  validateCanonical(input = {}) {
    if (this.canonicalValidationConsumed) {
      throw new SupervisorIntegrationError('CANONICAL_REANCHOR_ALREADY_CONSUMED', 'canonical re-anchor validation is one-shot')
    }
    if (!input.state || !['2.0.0', 2].includes(input.state.schemaVersion) || input.translate !== undefined) {
      throw new SupervisorIntegrationError('CANONICAL_REANCHOR_INVALID', 're-anchor accepts canonical v2 state only and never translates it')
    }
    this.canonicalValidationConsumed = true
    return Object.freeze({
      mode: 'CANONICAL_VALIDATED_ONCE', stateHash: hashText(stableStringify(input.state)),
      rolesInvoked: Object.freeze([]),
    })
  }
}

const FRAMEWORK_ORCHESTRATION_STATUSES = Object.freeze([
  'CANDIDATE_READY', 'VALIDATION_FAILED', 'ADMITTED', 'BLOCKED',
])
const FRAMEWORK_GENERATOR_ID = 'C0/framework-generator'
const FRAMEWORK_VALIDATOR_ID = 'C0/independent-framework-validator'

function sealFrameworkOrchestrationState(input) {
  const body = JSON.parse(JSON.stringify(input))
  delete body.stateHash
  return Object.freeze({ ...body, stateHash: hashText(stableStringify(body)) })
}

function topologicalGateOrder(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return []
  const incoming = new Map(graph.nodes.map(node => [node, 0]))
  const outgoing = new Map(graph.nodes.map(node => [node, []]))
  for (const edge of graph.edges) {
    if (!Array.isArray(edge) || edge.length !== 2 || !incoming.has(edge[0]) || !incoming.has(edge[1])) continue
    incoming.set(edge[1], incoming.get(edge[1]) + 1)
    outgoing.get(edge[0]).push(edge[1])
  }
  const ready = graph.nodes.filter(node => incoming.get(node) === 0)
  const order = []
  while (ready.length) {
    const node = ready.shift()
    order.push(node)
    for (const child of outgoing.get(node)) {
      incoming.set(child, incoming.get(child) - 1)
      if (incoming.get(child) === 0) ready.push(child)
    }
  }
  return order
}

function normalizeGeneratedFramework(candidate, route) {
  const copy = JSON.parse(JSON.stringify(candidate || {}))
  const graph = copy.gateGraph || {}
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const order = topologicalGateOrder(graph)
  const terminal = order.at(-1) || nodes.at(-1) || null
  copy.gateRegistry ??= { gateIds: [...nodes], terminalGateId: terminal }
  copy.gateOrder ??= [...order]
  copy.commandBindings ??= (copy.checks || []).map((checkId, index) => ({
    checkId,
    gateId: nodes[0] || null,
    commandId: `command:${index + 1}`,
    argv: ['$RESOLVED_EXECUTION_HARNESS'],
    expectedExitCode: 0,
  }))
  copy.oracleBindings ??= [...(copy.checks || []), ...(copy.riskChecks || [])].map((checkId, index) => ({
    checkId,
    oracleId: `check:${index + 1}`,
    gateId: terminal,
    evidenceSchema: 'autoprompt.runtime-oracle-evidence.v1',
    owner: 'independent-final-verifier',
  }))
  copy.riskTriggers ??= (copy.riskChecks || []).map((checkId, index) => ({
    riskId: `risk:${index + 1}`,
    checkId,
    authority: 'named-risk-checker',
  }))
  copy.negativePaths ??= nodes.filter(node => node !== terminal).map(node => ({
    from: node,
    event: 'FAIL',
    disposition: 'BLOCKED',
    maxRetries: 0,
  }))
  copy.coverageContract ??= createArtifactCoverageContract(['executable-code'])
  copy.assurance ??= {
    independentValidatorGateId: terminal,
    generatedFreshVerifyAfterValidator: false,
  }
  return copy
}

function frameworkCandidateErrors(candidate, route) {
  const errors = []
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return ['exact version being checked is not an object']
  }
  const allowed = new Set([
    'schemaVersion', 'frameworkId', 'route', 'checks', 'riskChecks', 'gateGraph',
    'gateRegistry', 'gateOrder', 'commandBindings', 'oracleBindings', 'riskTriggers',
    'negativePaths', 'coverageContract', 'assurance',
  ])
  if (Object.keys(candidate).some(key => !allowed.has(key))) errors.push('exact version being checked contains non-framework output')
  if (candidate.schemaVersion !== 1 || typeof candidate.frameworkId !== 'string' || !candidate.frameworkId) {
    errors.push('exact version identity is invalid')
  }
  if (candidate.route !== route) errors.push('exact version route is foreign')
  for (const field of ['checks', 'riskChecks']) {
    if (!uniqueStrings(candidate[field]) || (field === 'checks' && candidate[field].length === 0)) {
      errors.push(`${field} must be a unique${field === 'checks' ? ' non-empty' : ''} string array`)
    }
  }
  const graph = candidate.gateGraph
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || graph.route !== route ||
      typeof graph.graphId !== 'string' || !graph.graphId || !uniqueStrings(graph.nodes) || graph.nodes.length < 2 ||
      !Array.isArray(graph.edges) || graph.edges.length === 0 || graph.edges.some(edge =>
        !Array.isArray(edge) || edge.length !== 2 || edge.some(node => !graph.nodes.includes(node)))) {
    errors.push('exact version required-check graph is invalid')
  } else {
    const order = topologicalGateOrder(graph)
    if (order.length !== graph.nodes.length) errors.push('exact version required-check graph is cyclic or has invalid order')
    const registry = candidate.gateRegistry
    if (!registry || !uniqueStrings(registry.gateIds) ||
        stableStringify([...registry.gateIds].sort()) !== stableStringify([...graph.nodes].sort())) {
      errors.push('required-check registry must exactly register every graph node')
    }
    const outgoing = new Map(graph.nodes.map(node => [node, 0]))
    for (const [from] of graph.edges) outgoing.set(from, outgoing.get(from) + 1)
    const terminals = [...outgoing].filter(([, count]) => count === 0).map(([node]) => node)
    if (terminals.length !== 1 || !registry || registry.terminalGateId !== terminals[0]) {
      errors.push('terminal registry must name exactly one reachable terminal required check')
    }
    if (!uniqueStrings(candidate.gateOrder) || stableStringify(candidate.gateOrder) !== stableStringify(order)) {
      errors.push('required-check order must be the exact dependency order')
    }
  }
  const validatorNode = candidate.assurance && candidate.assurance.independentValidatorGateId
  if (!candidate.assurance || candidate.assurance.generatedFreshVerifyAfterValidator !== false ||
      !graph || !graph.nodes || !graph.nodes.includes(validatorNode) ||
      graph.nodes.some(node => /fresh[-_ ]?verify/i.test(node))) {
    errors.push('independent recheck cannot duplicate the independent validator')
  }
  if (!Array.isArray(candidate.commandBindings) || candidate.commandBindings.length === 0 ||
      (candidate.checks || []).some(check => !candidate.commandBindings.some(binding =>
        binding && binding.checkId === check && graph.nodes.includes(binding.gateId) &&
        uniqueStrings(binding.argv) && binding.argv.length > 0 && Number.isSafeInteger(binding.expectedExitCode)))) {
    errors.push('command bindings must provide an executable command for every check')
  }
  const oracleChecks = [...(candidate.checks || []), ...(candidate.riskChecks || [])]
  if (!Array.isArray(candidate.oracleBindings) || oracleChecks.some(check => !candidate.oracleBindings.some(binding =>
    binding && binding.checkId === check && typeof binding.oracleId === 'string' && binding.oracleId &&
    graph.nodes.includes(binding.gateId) && typeof binding.evidenceSchema === 'string' && binding.evidenceSchema &&
    binding.owner === 'independent-final-verifier'))) {
    errors.push('acceptance-check bindings must cover every acceptance and risk check')
  }
  if (!Array.isArray(candidate.riskTriggers) || (candidate.riskChecks || []).some(check =>
    !candidate.riskTriggers.some(trigger => trigger && trigger.checkId === check &&
      typeof trigger.riskId === 'string' && trigger.riskId && typeof trigger.authority === 'string' && trigger.authority))) {
    errors.push('risk triggers must bind every risk check to an authority')
  }
  if (!Array.isArray(candidate.negativePaths) || candidate.negativePaths.length === 0 ||
      candidate.negativePaths.some(item => !item || !graph.nodes.includes(item.from) ||
        !['BLOCKED', 'RETURN'].includes(item.disposition) || !Number.isSafeInteger(item.maxRetries) ||
        item.maxRetries < 0 || item.maxRetries > 3)) {
    errors.push('bounded negative paths must return or block within three retries')
  }
  return errors
}

function validateGeneratedFramework(candidate, options = {}) {
  const normalized = normalizeGeneratedFramework(candidate, options.route || candidate && candidate.route)
  const errors = frameworkCandidateErrors(normalized, options.route || normalized.route)
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), candidate: Object.freeze(normalized) })
}

class FrameworkOrchestrationAuthority {
  constructor(options = {}) {
    const binding = options.binding || {}
    if (typeof binding.runId !== 'string' || !binding.runId ||
        typeof binding.activationId !== 'string' || !binding.activationId ||
        !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
        !['DIRECT', 'LIGHT', 'ROADMAP'].includes(binding.route) ||
        typeof binding.assignmentId !== 'string' || !binding.assignmentId ||
        !uniqueStrings(binding.findingIds) || binding.findingIds.length === 0 ||
        !/^[a-f0-9]{64}$/.test(binding.requirementHash || '')) {
      throw new SupervisorIntegrationError(
        'FRAMEWORK_BINDING_INVALID',
        'framework orchestration requires an exact run, generation, route, assignment, finding, and requirement binding',
      )
    }
    if (typeof options.generate !== 'function') {
      throw new SupervisorIntegrationError('FRAMEWORK_GENERATOR_REQUIRED', 'C0 framework generation is unavailable')
    }
    if (typeof options.validate !== 'function') {
      throw new SupervisorIntegrationError('FRAMEWORK_VALIDATOR_REQUIRED', 'independent framework validation is unavailable')
    }
    if (typeof options.readState !== 'function' || typeof options.writeState !== 'function') {
      throw new SupervisorIntegrationError('FRAMEWORK_STATE_REQUIRED', 'framework result report requires durable state read/write functions')
    }
    const maxAttempts = options.maxAttempts === undefined ? 3 : Number(options.maxAttempts)
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new SupervisorIntegrationError('FRAMEWORK_BOUND_INVALID', 'framework generation attempt bound must be between one and three')
    }
    this.binding = Object.freeze({ ...binding, findingIds: Object.freeze([...binding.findingIds]) })
    this.generate = options.generate
    this.validate = options.validate
    this.readState = options.readState
    this.writeState = options.writeState
    this.readCache = typeof options.readCache === 'function' ? options.readCache : null
    this.writeCache = typeof options.writeCache === 'function' ? options.writeCache : null
    if (Boolean(this.readCache) !== Boolean(this.writeCache)) {
      throw new SupervisorIntegrationError('FRAMEWORK_CACHE_INVALID', 'shared framework cache requires paired read/write functions')
    }
    this.maxAttempts = maxAttempts
  }

  _validateCachedDescriptor(descriptor) {
    if (descriptor === null || descriptor === undefined) return null
    const unsigned = descriptor && typeof descriptor === 'object' ? { ...descriptor } : null
    if (unsigned) delete unsigned.descriptorHash
    if (!descriptor || descriptor.schemaVersion !== 1 || descriptor.cacheKey !== this.binding.requirementHash ||
        descriptor.route !== this.binding.route || descriptor.validationStatus !== 'PASS' ||
        descriptor.validatorIdentity !== FRAMEWORK_VALIDATOR_ID ||
        !/^[a-f0-9]{64}$/.test(descriptor.candidateHash || '') ||
        hashText(stableStringify(descriptor.candidate)) !== descriptor.candidateHash ||
        hashText(stableStringify(unsigned)) !== descriptor.descriptorHash ||
        frameworkCandidateErrors(descriptor.candidate, this.binding.route).length > 0) {
      throw new SupervisorIntegrationError('FRAMEWORK_CACHE_INVALID', 'shared framework descriptor is foreign or mutated')
    }
    return descriptor
  }

  _publishCachedDescriptor(state) {
    if (!this.writeCache) return null
    const existing = this._validateCachedDescriptor(this.readCache())
    const body = {
      schemaVersion: 1,
      cacheKey: this.binding.requirementHash,
      route: this.binding.route,
      candidateHash: state.candidateHash,
      candidate: state.candidate,
      generatorIdentity: state.generatorIdentity,
      validatorIdentity: FRAMEWORK_VALIDATOR_ID,
      validationStatus: 'PASS',
    }
    const descriptor = Object.freeze({ ...body, descriptorHash: hashText(stableStringify(body)) })
    if (existing) {
      if (stableStringify(existing) !== stableStringify(descriptor)) {
        throw new SupervisorIntegrationError('FRAMEWORK_CACHE_INVALID', 'shared cache key was reused for different framework bytes')
      }
      return existing
    }
    const written = this.writeCache(descriptor)
    if (written && typeof written.then === 'function') {
      throw new SupervisorIntegrationError('FRAMEWORK_CACHE_INVALID', 'shared framework cache publication must be synchronous')
    }
    const reopened = this._validateCachedDescriptor(this.readCache())
    if (!reopened || stableStringify(reopened) !== stableStringify(descriptor)) {
      throw new SupervisorIntegrationError('FRAMEWORK_CACHE_INVALID', 'shared framework descriptor did not reopen exactly')
    }
    return reopened
  }

  _admitCachedDescriptor(descriptor) {
    const receiptBody = {
      schemaVersion: 1,
      runId: this.binding.runId,
      activationId: this.binding.activationId,
      generation: this.binding.generation,
      assignmentId: this.binding.assignmentId,
      findingIds: [...this.binding.findingIds],
      cacheKey: descriptor.cacheKey,
      descriptorHash: descriptor.descriptorHash,
      candidateHash: descriptor.candidateHash,
    }
    const cacheAdmissionReceipt = Object.freeze({
      ...receiptBody, receiptHash: hashText(stableStringify(receiptBody)),
    })
    const state = this._persist({
      status: 'ADMITTED', attempt: 1,
      generatorIdentity: descriptor.generatorIdentity,
      candidate: descriptor.candidate,
      candidateHash: descriptor.candidateHash,
      validatorReceipt: {
        validatorIdentity: descriptor.validatorIdentity,
        generation: this.binding.generation,
        assignmentId: this.binding.assignmentId,
        findingIds: [...this.binding.findingIds],
        candidateHash: descriptor.candidateHash,
        status: 'PASS', findings: [], cacheDescriptorHash: descriptor.descriptorHash,
      },
      cacheAdmissionReceipt,
    })
    return this._admission(state)
  }

  _receipt(attempt, state) {
    const body = {
      schemaVersion: 1,
      runId: this.binding.runId,
      activationId: this.binding.activationId,
      generation: this.binding.generation,
      route: this.binding.route,
      assignmentId: this.binding.assignmentId,
      findingIds: [...this.binding.findingIds],
      requirementHash: this.binding.requirementHash,
      attempt,
      priorCandidateHash: state && state.candidateHash || null,
      repairFindingIds: state && state.validatorReceipt
        ? state.validatorReceipt.findings.map(item => item.id) : [],
    }
    return Object.freeze({ ...body, receiptHash: hashText(stableStringify(body)) })
  }

  _validateStoredState(state) {
    if (state === null || state === undefined) return null
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 1 ||
        !FRAMEWORK_ORCHESTRATION_STATUSES.includes(state.status) ||
        stableStringify(state.binding) !== stableStringify(this.binding) ||
        sealFrameworkOrchestrationState(state).stateHash !== state.stateHash ||
        !Number.isSafeInteger(state.attempt) || state.attempt < 1 || state.attempt > this.maxAttempts ||
        typeof state.generatorIdentity !== 'string' || !state.generatorIdentity ||
        !/^[a-f0-9]{64}$/.test(state.candidateHash || '') ||
        hashText(stableStringify(state.candidate)) !== state.candidateHash ||
        frameworkCandidateErrors(state.candidate, this.binding.route).length > 0) {
      throw new SupervisorIntegrationError('FRAMEWORK_STATE_INVALID', 'durable framework result report is malformed or foreign')
    }
    const receipt = state.validatorReceipt
    if (state.cacheAdmissionReceipt) {
      const cached = this.readCache && this._validateCachedDescriptor(this.readCache())
      const admission = state.cacheAdmissionReceipt
      const unsignedAdmission = { ...admission }
      delete unsignedAdmission.receiptHash
      if (!cached || state.status !== 'ADMITTED' || cached.descriptorHash !== admission.descriptorHash ||
          cached.candidateHash !== state.candidateHash || admission.runId !== this.binding.runId ||
          admission.activationId !== this.binding.activationId || admission.generation !== this.binding.generation ||
          admission.assignmentId !== this.binding.assignmentId ||
          stableStringify(admission.findingIds) !== stableStringify(this.binding.findingIds) ||
          admission.cacheKey !== this.binding.requirementHash || admission.candidateHash !== state.candidateHash ||
          hashText(stableStringify(unsignedAdmission)) !== admission.receiptHash) {
        throw new SupervisorIntegrationError('FRAMEWORK_CACHE_ADMISSION_INVALID', 'current-run cache admission is stale or foreign')
      }
      return state
    }
    if (state.status === 'CANDIDATE_READY' && receipt !== null) {
      throw new SupervisorIntegrationError('FRAMEWORK_VALIDATOR_BYPASS', 'unvalidated framework version cannot be admitted')
    }
    if (state.status !== 'CANDIDATE_READY') {
      if (!receipt || receipt.candidateHash !== state.candidateHash ||
          receipt.generation !== this.binding.generation || receipt.assignmentId !== this.binding.assignmentId ||
          stableStringify(receipt.findingIds) !== stableStringify(this.binding.findingIds) ||
          receipt.validatorIdentity !== FRAMEWORK_VALIDATOR_ID ||
          (state.status === 'ADMITTED' ? receipt.status !== 'PASS' : receipt.status !== 'FAIL')) {
        throw new SupervisorIntegrationError('FRAMEWORK_VALIDATOR_BYPASS', 'framework state lacks the exact independent validator receipt')
      }
    }
    return state
  }

  _persist(state) {
    const sealed = sealFrameworkOrchestrationState({ schemaVersion: 1, ...state, binding: this.binding })
    const writeResult = this.writeState(sealed)
    if (writeResult && typeof writeResult.then === 'function') {
      throw new SupervisorIntegrationError(
        'FRAMEWORK_STATE_NOT_DURABLE',
        'framework state publication must complete synchronously before orchestration continues',
      )
    }
    const reread = this.readState()
    if (!reread || stableStringify(reread) !== stableStringify(sealed)) {
      throw new SupervisorIntegrationError(
        'FRAMEWORK_STATE_NOT_DURABLE',
        'framework state must be read back exactly before validation or production admission',
      )
    }
    return sealed
  }

  _validateGeneratorResult(result, receipt, priorState) {
    const allowed = new Set(['generatorIdentity', 'generation', 'assignmentId', 'findingIds', 'candidate'])
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        Object.keys(result).some(key => !allowed.has(key)) ||
        typeof result.generatorIdentity !== 'string' || !result.generatorIdentity ||
        result.generation !== receipt.generation || result.assignmentId !== receipt.assignmentId ||
        stableStringify(result.findingIds) !== stableStringify(receipt.findingIds)) {
      throw new SupervisorIntegrationError('FRAMEWORK_HANDOFF_STALE', 'generator output is foreign, stale, or not limited to the exact version')
    }
    if (priorState && result.generatorIdentity !== priorState.generatorIdentity) {
      throw new SupervisorIntegrationError(
        'FRAMEWORK_REPAIR_AUTHOR_MISMATCH',
        'validator findings must return to the same framework generator identity',
      )
    }
    const semantic = validateGeneratedFramework(result.candidate, { route: this.binding.route })
    const errors = semantic.errors
    if (errors.length) {
      throw new SupervisorIntegrationError('FRAMEWORK_CANDIDATE_INVALID', 'generated framework version is invalid', { errors })
    }
    return {
      generatorIdentity: result.generatorIdentity,
      candidate: JSON.parse(JSON.stringify(semantic.candidate)),
      candidateHash: hashText(stableStringify(semantic.candidate)),
    }
  }

  _validateValidatorResult(result, receipt, state) {
    const semantic = validateGeneratedFramework(state.candidate, { route: this.binding.route })
    if (!semantic.valid) {
      throw new SupervisorIntegrationError(
        'FRAMEWORK_VALIDATION_INVALID',
        'independent validator cannot admit a semantically unsound framework',
        { errors: semantic.errors },
      )
    }
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        result.validatorIdentity !== FRAMEWORK_VALIDATOR_ID || result.validatorIdentity === state.generatorIdentity ||
        result.generation !== receipt.generation || result.assignmentId !== receipt.assignmentId ||
        stableStringify(result.findingIds) !== stableStringify(receipt.findingIds) ||
        result.candidateHash !== state.candidateHash || !['PASS', 'FAIL'].includes(result.status) ||
        !Array.isArray(result.findings)) {
      throw new SupervisorIntegrationError('FRAMEWORK_VALIDATION_STALE', 'validator receipt is foreign, stale, or not independent')
    }
    if (result.status === 'PASS' && result.findings.length !== 0) {
      throw new SupervisorIntegrationError('FRAMEWORK_VALIDATION_INVALID', 'PASS cannot retain framework findings')
    }
    if (result.status === 'FAIL' && (result.findings.length === 0 || result.findings.some(item =>
      !item || !/^FRAMEWORK-FINDING-[0-9]{3}$/.test(item.id || '') ||
      typeof item.message !== 'string' || !item.message))) {
      throw new SupervisorIntegrationError('FRAMEWORK_VALIDATION_INVALID', 'FAIL requires numbered concrete findings')
    }
    return Object.freeze({
      validatorIdentity: result.validatorIdentity,
      generation: result.generation,
      assignmentId: result.assignmentId,
      findingIds: Object.freeze([...result.findingIds]),
      candidateHash: result.candidateHash,
      status: result.status,
      findings: Object.freeze(result.findings.map(item => Object.freeze({ id: item.id, message: item.message }))),
    })
  }

  _admission(state) {
    return Object.freeze({
      status: 'ADMITTED',
      generatorIdentity: state.generatorIdentity,
      candidateHash: state.candidateHash,
      validatorReceipt: state.validatorReceipt,
      recipe: Object.freeze({
        status: 'SUPPORTED',
        workType: `generated/${state.candidate.frameworkId}`,
        selection: null,
        checks: Object.freeze([...state.candidate.checks]),
        riskChecks: Object.freeze([...state.candidate.riskChecks]),
        gateGraph: Object.freeze(JSON.parse(JSON.stringify(state.candidate.gateGraph))),
        runtimeFrameworkGeneration: true,
        frameworkAdmissionHash: state.stateHash,
      }),
    })
  }

  async run(input = {}) {
    if (input.caller !== 'deterministic-control-plane') {
      throw new SupervisorIntegrationError(
        'FRAMEWORK_COORDINATOR_REQUIRED',
        'only deterministic C0 may coordinate framework generation and validation',
      )
    }
    let state = this._validateStoredState(this.readState())
    if (state && state.status === 'ADMITTED') return this._admission(state)
    if (state && state.status === 'BLOCKED') {
      throw new SupervisorIntegrationError('FRAMEWORK_REPAIR_EXHAUSTED', 'framework repair is already blocked')
    }
    const cached = !state && this.readCache ? this._validateCachedDescriptor(this.readCache()) : null
    if (cached) return this._admitCachedDescriptor(cached)
    while (true) {
      if (!state || state.status === 'VALIDATION_FAILED') {
        const attempt = state ? state.attempt + 1 : 1
        if (attempt > this.maxAttempts) {
          state = this._persist({ ...state, status: 'BLOCKED' })
          throw new SupervisorIntegrationError('FRAMEWORK_REPAIR_EXHAUSTED', 'framework repair attempt bound was exhausted')
        }
        const receipt = this._receipt(attempt, state)
        const generated = this._validateGeneratorResult(await this.generate(Object.freeze({
          receipt,
          attempt,
          repairFindingIds: Object.freeze([...receipt.repairFindingIds]),
        })), receipt, state)
        state = this._persist({
          status: 'CANDIDATE_READY', attempt,
          generatorIdentity: generated.generatorIdentity,
          candidate: generated.candidate,
          candidateHash: generated.candidateHash,
          validatorReceipt: null,
        })
      }
      const receipt = this._receipt(state.attempt, state)
      const validatorReceipt = this._validateValidatorResult(await this.validate(Object.freeze({
        receipt,
        attempt: state.attempt,
        candidate: Object.freeze(JSON.parse(JSON.stringify(state.candidate))),
        candidateHash: state.candidateHash,
      })), receipt, state)
      if (validatorReceipt.status === 'PASS') {
        state = this._persist({ ...state, status: 'ADMITTED', validatorReceipt })
        this._publishCachedDescriptor(state)
        return this._admission(state)
      }
      if (state.attempt >= this.maxAttempts) {
        state = this._persist({ ...state, status: 'BLOCKED', validatorReceipt })
        throw new SupervisorIntegrationError('FRAMEWORK_REPAIR_EXHAUSTED', 'framework failed independent validation at the attempt bound')
      }
      state = this._persist({ ...state, status: 'VALIDATION_FAILED', validatorReceipt })
    }
  }
}

async function deterministicFrameworkGenerator(handoff) {
  const suffix = handoff.receipt.requirementHash.slice(0, 16)
  return {
    generatorIdentity: FRAMEWORK_GENERATOR_ID,
    generation: handoff.receipt.generation,
    assignmentId: handoff.receipt.assignmentId,
    findingIds: [...handoff.receipt.findingIds],
    candidate: {
      schemaVersion: 1,
      frameworkId: `generated-${suffix}-a${handoff.attempt}`,
      route: handoff.receipt.route,
      checks: ['exact-generated-framework-acceptance'],
      riskChecks: [],
      gateGraph: {
        graphId: `generated-${handoff.receipt.route.toLowerCase()}-${suffix}`,
        route: handoff.receipt.route,
        nodes: ['produce-candidate', 'independent-check'],
        edges: [['produce-candidate', 'independent-check']],
      },
    },
  }
}

async function deterministicFrameworkValidator(handoff) {
  const errors = validateGeneratedFramework(handoff.candidate, { route: handoff.receipt.route }).errors
  return {
    validatorIdentity: FRAMEWORK_VALIDATOR_ID,
    generation: handoff.receipt.generation,
    assignmentId: handoff.receipt.assignmentId,
    findingIds: [...handoff.receipt.findingIds],
    candidateHash: handoff.candidateHash,
    status: errors.length ? 'FAIL' : 'PASS',
    findings: errors.map((message, index) => ({
      id: `FRAMEWORK-FINDING-${String(index + 1).padStart(3, '0')}`,
      message,
    })),
  }
}

function hashEnvironment(environment) {
  const fields = Object.keys(environment || {}).sort().map(key => [key, String(environment[key])])
  return hashText(JSON.stringify(fields))
}

const CHECKER_EPHEMERAL_ENVIRONMENT_FIELDS = new Set([
  'TMPDIR', 'TMP', 'TEMP', 'SQLITE_TMPDIR', 'XDG_CACHE_HOME', 'PYTHONPYCACHEPREFIX',
  'AUTOPROMPT_CHECKER_CANDIDATE_ROOT', 'AUTOPROMPT_CHECKER_SCRATCH_ROOT',
  'AUTOPROMPT_CHECKER_OUTPUT_ROOT',
])

function hashCheckerEnvironment(environment) {
  const canonical = Object.fromEntries(Object.entries(environment || {}).map(([key, value]) => [
    key,
    CHECKER_EPHEMERAL_ENVIRONMENT_FIELDS.has(key) ? `<authenticated-checker-${key.toLowerCase()}>` : value,
  ]))
  return hashEnvironment(canonical)
}

function normalizeRole(role) {
  const value = String(role || '').trim()
  return value === 'ap-work-group-manager' ? value : value.replace(/^ap-/, '')
}

function providerRoleForLogical(logicalRole) {
  const normalized = normalizeRole(logicalRole)
  const providerRole = CANONICAL_PROVIDER_ROLES[normalized]
  if (!providerRole) {
    throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', `logical role lacks a canonical Codex binding: ${normalized}`)
  }
  return providerRole
}

function loadRoleContract(contractPath) {
  const target = contractPath || path.resolve(__dirname, '..', '..', 'contracts', 'roles.json')
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')) } catch (error) {
    throw new SupervisorIntegrationError('ROLE_POLICY_INVALID', `role contract is unreadable: ${target}`, {
      cause: error.message,
    })
  }
  if (!parsed || !Array.isArray(parsed.phaseAdjacency) || !Array.isArray(parsed.roles)) {
    throw new SupervisorIntegrationError('ROLE_POLICY_INVALID', 'role contract lacks roles or phase adjacency')
  }
  return parsed
}

function loadCodexPhysicalRolePolicy(policyPath) {
  const target = policyPath || path.resolve(__dirname, '..', 'agents', 'role-policy.json')
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')) } catch (error) {
    throw new SupervisorIntegrationError('ROLE_POLICY_INVALID', `Codex physical-role policy is unreadable: ${target}`, {
      cause: error.message,
    })
  }
  if (!parsed || !parsed.enforcement || parsed.enforcement.required !== true ||
      !parsed.physical_roles || typeof parsed.physical_roles !== 'object') {
    throw new SupervisorIntegrationError('ROLE_POLICY_INVALID', 'Codex physical-role policy is not enforceable')
  }
  return parsed
}

class RolePolicy {
  constructor(contract = loadRoleContract(), codexPolicy = loadCodexPhysicalRolePolicy()) {
    this.contract = contract
    this.codexPolicy = codexPolicy
    this.roles = new Map(contract.roles.map(role => [role.id, role]))
    this.aliases = new Map((contract.compatibilityAliases || []).map(alias => [alias.legacyId, alias]))
  }

  validate(input) {
    const parent = normalizeRole(input.parent)
    const requestedChild = String(input.child || '').trim()
    const alias = this.aliases.get(requestedChild) || null
    const child = alias ? alias.logicalId : normalizeRole(requestedChild)
    const route = input.route || 'PRE_ROUTE'
    if (alias && FORBIDDEN_DIRECT_ALIASES.has(requestedChild)) {
      throw new SupervisorIntegrationError(
        'ROLE_POLICY_DENIED',
        `compatibility profile cannot bypass deterministic control: ${requestedChild}`,
      )
    }
    if (!alias && FORBIDDEN_RUNTIME_ROLES.has(child)) {
      throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', `legacy fixed-group role is not launchable: ${child}`)
    }
    if (route === 'PRE_ROUTE' && parent === 'deterministic-control-plane' && child === 'run-owner') {
      const definition = this.contract.orchestratorContract
      if (!definition || !Array.isArray(definition.legalParents) || !definition.legalParents.includes(parent)) {
        throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', 'run-owner contract rejects the deterministic control plane')
      }
      return {
        parent,
        child,
        route,
        definition,
        alias,
        edge: { route, phase: 'route-decision', parent, children: [child] },
      }
    }
    if (!this.roles.has(child)) {
      throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', `unknown logical child role: ${child}`)
    }
    if (['DIRECT', 'LIGHT'].includes(route) && [
      'mission-coordinator', 'ap-work-group-manager', 'roadmap-author', 'scout', 'plan-checker',
    ].includes(child)) {
      throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', `${child} is not part of ${route}`)
    }
    const matching = this.contract.phaseAdjacency.filter(edge =>
      (edge.route === route || edge.route === 'ANY') &&
      edge.parent === parent &&
      edge.children.includes(child),
    )
    if (matching.length !== 1) {
      throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', `illegal ${route} parent/child edge ${parent} -> ${child}`)
    }
    const definition = this.roles.get(child)
    if (!definition.legalParents.includes(parent)) {
      throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', `role ${child} rejects parent ${parent}`)
    }
    return { parent, child, route, definition, alias, edge: matching[0] }
  }

  bindPhysicalChild(input) {
    const logicalRole = normalizeRole(input && input.logicalRole)
    const providerRole = String(input && input.providerRole || '').trim()
    const physicalRole = String(input && input.physicalRole || '').trim()
    const expectedProviderRole = providerRoleForLogical(logicalRole)
    const logicalDefinition = logicalRole === 'run-owner'
      ? this.contract.orchestratorContract : this.roles.get(logicalRole)
    const physicalDefinition = this.codexPolicy.physical_roles[providerRole]
    if (providerRole !== expectedProviderRole || !logicalDefinition ||
        physicalRole !== logicalDefinition.physicalId || !physicalDefinition ||
        physicalDefinition.activation_allowed !== true ||
        physicalDefinition.compatibility_alias && physicalDefinition.compatibility_alias.enabled === true) {
      throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', 'Codex child is not bound to one active canonical physical role', {
        logicalRole, physicalRole, providerRole, expectedProviderRole,
      })
    }
    const projectedLogicalRole = physicalDefinition.logical_role
    const checkerProjection = providerRole === 'ap-independent-checker' && CHECKER_ROLES.has(logicalRole)
    const diagnosticProjection = providerRole === 'ap-worker' && logicalRole === 'diagnostic-probe'
    if (!checkerProjection && !diagnosticProjection && projectedLogicalRole !== logicalRole) {
      throw new SupervisorIntegrationError('ROLE_POLICY_DENIED', 'Codex physical role projects to a different logical role', {
        logicalRole, projectedLogicalRole, providerRole,
      })
    }
    if (!['read-only', 'workspace-write'].includes(physicalDefinition.sandbox_mode)) {
      throw new SupervisorIntegrationError('ROLE_POLICY_INVALID', `Codex physical role has an unsupported sandbox: ${providerRole}`)
    }
    const readOnlyProjection = checkerProjection || diagnosticProjection
    const sandboxMode = readOnlyProjection ? 'read-only' : physicalDefinition.sandbox_mode
    return Object.freeze({
      logicalRole,
      physicalRole,
      providerRole,
      sandboxMode,
      policyId: this.codexPolicy.policy_id,
      policyVersion: this.codexPolicy.policy_version,
      canDispatch: readOnlyProjection ? false : physicalDefinition.can_dispatch === true,
      resourceSets: Object.freeze({
        read: Object.freeze([...(physicalDefinition.resource_sets && physicalDefinition.resource_sets.read || [])]),
        write: Object.freeze(readOnlyProjection ? [] : [...(physicalDefinition.resource_sets && physicalDefinition.resource_sets.write || [])]),
        exclusive: Object.freeze(readOnlyProjection ? [] : [...(physicalDefinition.resource_sets && physicalDefinition.resource_sets.exclusive || [])]),
      }),
    })
  }

  bindRootRunOwner() {
    const control = this.codexPolicy.control_plane
    const orchestrator = this.contract.orchestratorContract
    if (!control || control.id !== 'L0' || control.logical_role !== 'run-owner' ||
        control.can_dispatch !== true || !orchestrator || orchestrator.physicalId !== 'autoprompt.v2.run-owner') {
      throw new SupervisorIntegrationError('ROLE_POLICY_INVALID', 'Codex L0 run-owner policy is incomplete')
    }
    return Object.freeze({
      logicalRole: 'run-owner',
      physicalRole: orchestrator.physicalId,
      providerRole: 'ap-run-owner',
      sandboxMode: 'read-only',
      policyId: this.codexPolicy.policy_id,
      policyVersion: this.codexPolicy.policy_version,
      canDispatch: true,
      resourceSets: Object.freeze({ read: Object.freeze(['request-envelope', 'route-evidence']), write: Object.freeze([]), exclusive: Object.freeze([]) }),
    })
  }

  bindCaller(input) {
    const logicalRole = normalizeRole(input && input.logicalRole)
    const physicalRole = String(input && input.physicalRole || '').trim()
    const sessionId = String(input && input.sessionId || '').trim()
    const runId = String(input && input.runId || '').trim()
    const generation = Number(input && input.generation)
    if (!logicalRole || !physicalRole || !sessionId || !runId || !Number.isSafeInteger(generation) || generation < 1) {
      throw new SupervisorIntegrationError('CALLER_BINDING_INVALID', 'caller requires logical/physical role, session, run, and generation')
    }
    const expectedPhysical = logicalRole === 'deterministic-control-plane'
      ? CONTROL_PLANE_PHYSICAL_ROLE
      : logicalRole === 'run-owner'
        ? this.contract.orchestratorContract && this.contract.orchestratorContract.physicalId
        : this.roles.get(logicalRole) && this.roles.get(logicalRole).physicalId
    if (!expectedPhysical || physicalRole !== expectedPhysical) {
      throw new SupervisorIntegrationError('CALLER_BINDING_INVALID', `physical caller role does not match ${logicalRole}`, {
        expectedPhysical, receivedPhysical: physicalRole,
      })
    }
    return Object.freeze({ logicalRole, physicalRole, sessionId, runId, generation })
  }
}

function admitCodexRoleSelection(input = {}) {
  const rolePolicy = input.rolePolicy || new RolePolicy()
  if (!rolePolicy || typeof rolePolicy.validate !== 'function') {
    throw new SupervisorIntegrationError('ROLE_POLICY_INVALID', 'role selection requires the canonical Codex role policy')
  }
  // This call is deliberately the first operation. In particular, no session
  // id, scheduler lease, model process, or transcript may be allocated for a
  // denied internal role or illegal topology edge.
  const policy = rolePolicy.validate(input.selection || {})
  const session = typeof input.createChildSession === 'function'
    ? input.createChildSession(policy)
    : null
  return Object.freeze({ policy, session })
}

function createCodexEntrySemanticTrace(input = {}) {
  if (!['top-level', 'supervisor'].includes(input.entry)) {
    throw new SupervisorIntegrationError('ENTRY_ADAPTER_INVALID', 'Codex entry must be top-level or supervisor')
  }
  const admission = input.admission || {}
  const route = input.route || {}
  const capability = input.capability || {}
  const resume = input.resume || {}
  if (![admission.activationId, admission.runId, admission.requestHash, admission.targetIdentity]
      .every(value => typeof value === 'string' && value) ||
      !/^[a-f0-9]{64}$/.test(admission.requestHash || '') ||
      !['DIRECT', 'LIGHT', 'ROADMAP'].includes(route.route) ||
      !/^[a-f0-9]{64}$/.test(route.decisionHash || '') ||
      !/^[a-f0-9]{64}$/.test(capability.receiptHash || '') ||
      capability.status !== 'active' || !Number.isSafeInteger(capability.generation) || capability.generation < 1 ||
      !Number.isSafeInteger(resume.generation) || resume.generation < 1 ||
      !Number.isSafeInteger(resume.stateEventSequence) || resume.stateEventSequence < 0 ||
      (resume.stateHash !== null && !/^[a-f0-9]{64}$/.test(resume.stateHash || ''))) {
    throw new SupervisorIntegrationError(
      'ENTRY_ADAPTER_INVALID',
      'Codex entry semantic trace lacks exact admission, route, capability, or resume bindings',
    )
  }
  const body = {
    schemaVersion: 1,
    admission: {
      activationId: admission.activationId, runId: admission.runId,
      requestHash: admission.requestHash, targetIdentity: admission.targetIdentity,
    },
    route: { route: route.route, decisionHash: route.decisionHash },
    capability: {
      receiptHash: capability.receiptHash, generation: capability.generation, status: capability.status,
    },
    resume: {
      generation: resume.generation, stateEventSequence: resume.stateEventSequence,
      stateHash: resume.stateHash,
    },
  }
  return Object.freeze({ ...body, semanticTraceHash: hashText(stableStringify(body)) })
}

function executeCodexEntryAdapter(entry, input = {}) {
  let admissionEvidence
  if (entry === 'top-level') {
    const classification = classifyCodexTopLevelPrompt(input.prompt)
    if (!classification.explicitAutoprompt || !classification.loadAutoprompt || !classification.loadInternalRoles) {
      throw new SupervisorIntegrationError('ENTRY_ADAPTER_DENIED', 'top-level entry requires the exact explicit Autoprompt token')
    }
    admissionEvidence = Object.freeze({ kind: 'explicit-token', token: '$autoprompt' })
  } else if (entry === 'supervisor') {
    const receipt = input.activationReceipt || {}
    if (!receipt.verified || typeof receipt.activationId !== 'string' || !receipt.activationId ||
        typeof receipt.runId !== 'string' || !receipt.runId) {
      throw new SupervisorIntegrationError('ENTRY_ADAPTER_DENIED', 'supervisor entry requires a verified activation receipt')
    }
    admissionEvidence = Object.freeze({
      kind: 'activation-receipt', activationId: receipt.activationId, runId: receipt.runId,
    })
  } else {
    throw new SupervisorIntegrationError('ENTRY_ADAPTER_INVALID', 'Codex entry must be top-level or supervisor')
  }
  if (typeof input.execute !== 'function') {
    throw new SupervisorIntegrationError('ENTRY_ADAPTER_INVALID', 'entry adapter requires one semantic execution callback')
  }
  const observed = input.execute(Object.freeze({ entry, admissionEvidence }))
  if (!observed || typeof observed !== 'object' || typeof observed.then === 'function') {
    throw new SupervisorIntegrationError('ENTRY_ADAPTER_INVALID', 'entry adapter execution must synchronously return observed semantics')
  }
  return createCodexEntrySemanticTrace({ entry, ...observed })
}

function runCodexTopLevelEntryAdapter(input = {}) {
  return executeCodexEntryAdapter('top-level', input)
}

function runCodexSupervisorEntryAdapter(input = {}) {
  return executeCodexEntryAdapter('supervisor', input)
}

function classifyCodexTopLevelPrompt(prompt) {
  const source = String(prompt || '')
  const explicit = /^\$autoprompt(?:\s|$)/u.test(source)
  return Object.freeze({
    explicitAutoprompt: explicit,
    loadAutoprompt: explicit,
    loadInternalRoles: explicit,
    loadedCompanionSkills: Object.freeze([]),
  })
}

function assertReadOnlyCheckerOperation(policy, operation = {}) {
  if (!policy || !CHECKER_ROLES.has(policy.logicalRole) || policy.sandboxMode !== 'read-only' ||
      policy.canDispatch !== false || policy.resourceSets.write.length !== 0 ||
      policy.resourceSets.exclusive.length !== 0) {
    throw new SupervisorIntegrationError('CHECKER_READ_ONLY_POLICY_REQUIRED', 'checker lacks an enforced read-only non-dispatch policy')
  }
  if (['edit', 'create', 'spawn'].includes(operation.kind) ||
      operation.kind === 'command' && operation.mutates !== false) {
    throw new SupervisorIntegrationError(
      'CHECKER_OPERATION_DENIED',
      `read-only checker cannot ${operation.kind || 'perform the requested operation'}`,
    )
  }
  if (!['read', 'command'].includes(operation.kind)) {
    throw new SupervisorIntegrationError('CHECKER_OPERATION_DENIED', 'checker operation is not in the read-only allowlist')
  }
  return Object.freeze({ allowed: true, kind: operation.kind })
}

function loadGateContract(contractPath) {
  const target = contractPath || path.resolve(__dirname, '..', '..', 'contracts', 'gates.json')
  let contract
  try { contract = JSON.parse(fs.readFileSync(target, 'utf8')) } catch (error) {
    throw new SupervisorIntegrationError('GATE_CONTRACT_INVALID', `required-check contract is unreadable: ${target}`, {
      cause: error.message,
    })
  }
  const composition = contract && contract.composition
  const validation = composition && composition.validation
  if (contract.contractVersion !== '2.0.0' || !composition || !composition.selectionSchema ||
      !validation || !Array.isArray(validation.compoundRules) ||
      !Array.isArray(validation.incompatibleCombinations) || !contract.riskOverlays) {
    throw new SupervisorIntegrationError('GATE_CONTRACT_INVALID', 'required-check contract lacks canonical v2 composition rules')
  }
  return contract
}

function uniqueStrings(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item) &&
    new Set(value).size === value.length
}

function createArtifactCoverageContract(artifactOverlays = []) {
  const overlays = [...new Set(Array.isArray(artifactOverlays) ? artifactOverlays : [])]
  const executable = overlays.includes('executable-code')
    ? Object.freeze({
        instrumentWhenAvailable: true,
        numerator: ['covered-changed-executable-lines', 'covered-changed-executable-branches'],
        denominator: ['changed-executable-lines', 'changed-executable-branches'],
        minimumRatio: 0.95,
        unavailableDisposition: 'artifact-oracle-coverage',
      })
    : null
  return Object.freeze({
    executable,
    artifacts: Object.freeze({
      numerator: 'passing-required-artifact-oracles',
      denominator: 'required-artifact-oracles',
      minimumRatio: 1,
      overlays: Object.freeze(overlays),
    }),
  })
}

function acceptanceOracleContracts(acceptanceOverlays = []) {
  return Object.freeze([...new Set(acceptanceOverlays)].map((overlay, index) => Object.freeze({
    overlay,
    oracleId: `acceptance:${overlay}:${index + 1}`,
    evidenceSchema: 'autoprompt.runtime-acceptance-evidence.v1',
    owner: 'independent-final-verifier',
    retryPolicy: Object.freeze({ onFailure: 'RETURN_TO_PRODUCER', maxRetries: 1 }),
  })))
}

function selectRuntimeGateTriggers(selection = {}, signals = {}) {
  const artifacts = new Set(selection.artifactOverlays || [])
  const risks = new Set(selection.riskOverlays || [])
  const depthReasons = []
  if (selection.baseWorkType === 'debug-fix') {
    if (signals.wrongLayerEvidence === true) depthReasons.push('wrong-layer-evidence')
    if (Number(signals.repeatedFailureCount || 0) >= 2) depthReasons.push('repeated-failure')
    if (signals.crossModuleUncertainty === true) depthReasons.push('cross-module-uncertainty')
  }
  const documentationReasons = []
  if (artifacts.has('documentation')) {
    if (signals.audienceUnresolved === true) documentationReasons.push('audience-unresolved')
    if (signals.informationArchitectureUnresolved === true) documentationReasons.push('information-architecture-unresolved')
    if (signals.sourceAuthorityUnresolved === true) documentationReasons.push('source-authority-unresolved')
  }
  const performanceReasons = []
  if (risks.has('performance-or-service-level')) performanceReasons.push('declared-risk-overlay')
  if (signals.performanceRequirement === true) performanceReasons.push('performance-requirement')
  if (signals.serviceLevelObjective === true) performanceReasons.push('service-level-objective')
  return Object.freeze({
    depthProber: Object.freeze({ required: depthReasons.length > 0, reasons: Object.freeze(depthReasons) }),
    documentationPlanning: Object.freeze({
      required: documentationReasons.length > 0,
      reasons: Object.freeze(documentationReasons),
      tierIndependent: true,
    }),
    performance: Object.freeze({ required: performanceReasons.length > 0, reasons: Object.freeze(performanceReasons) }),
    riskChecks: Object.freeze([...risks].map(risk => Object.freeze({ risk, tierIndependent: true }))),
  })
}

function validateLiveCheckingPlan(decision = {}) {
  const checking = decision.independentCheckingPlan || {}
  const checkerCount = Number(checking.checkerCount)
  if (![1, 2].includes(checkerCount) || !Array.isArray(checking.responsibilities) ||
      checking.responsibilities.length !== checkerCount ||
      new Set(checking.responsibilities).size !== checkerCount) {
    throw new SupervisorIntegrationError(
      'INDEPENDENT_CHECKING_PLAN_INVALID',
      'live checker execution requires the exact one-or-two seat plan with distinct named risks',
    )
  }
  const semanticRiskRequiresTwoCheckers = Boolean(
    (decision.capturedDomainContracts || []).some(contract =>
      contract && contract.kind === 'HIDDEN_EXTERNAL_ORACLE') ||
    (decision.risks || []).length > 0 || (decision.missingInformation || []).length > 0,
  )
  const responsibilities = [...checking.responsibilities]
  const semanticObligations = [
    ...(decision.risks || []), ...(decision.missingInformation || []),
  ].filter(value => typeof value === 'string' && value.trim())
  if (checkerCount === 1 && semanticRiskRequiresTwoCheckers) {
    const boundary = semanticObligations.length > 0
      ? semanticObligations.join(' | ')
      : (decision.plannedChecks || []).find(value => typeof value === 'string' && value.trim()) ||
        'the requested behavior boundary'
    responsibilities.push(
      `Independently falsify the exact version with positive, negative, and boundary observations for: ${boundary}`,
    )
  } else if (checkerCount === 2 && semanticObligations.length > 0) {
    responsibilities[1] = `${responsibilities[1]} Explicitly falsify these semantic risks and unknowns: ${semanticObligations.join(' | ')}`
  }
  return Object.freeze({
    checkerCount: responsibilities.length,
    responsibilities: Object.freeze(responsibilities),
    nonOverlapReason: semanticRiskRequiresTwoCheckers
      ? 'The second seat independently falsifies the highest-risk semantic boundary with a distinct evidence source and method.'
      : checking.nonOverlapReason || (responsibilities.length > 1
      ? 'The second seat independently falsifies semantic boundaries with a distinct evidence source and method.'
      : null),
  })
}

async function executePreProductionRuntimeGates(input = {}) {
  const depthTrigger = input.recipe && input.recipe.runtimeGatePlan &&
    input.recipe.runtimeGatePlan.triggers && input.recipe.runtimeGatePlan.triggers.depthProber
  if (!depthTrigger || depthTrigger.required !== true) return Object.freeze({ depthProbe: 'SKIPPED' })
  if (typeof input.launch !== 'function') {
    throw new SupervisorIntegrationError('DEPTH_PROBE_REQUIRED', 'depth specialist launcher is unavailable')
  }
  const ownership = Array.isArray(input.ownership) && input.ownership.length ? input.ownership : ['workspace']
  const depthResult = input.durableResult || await input.launch({
    workItemId: 'conditional-depth-prober', logicalRole: 'diagnostic-probe', parent: 'run-owner',
    purpose: 'diagnostic',
    assignment: `Probe the deepest-cause layer before production because: ${depthTrigger.reasons.join(', ')}. Read and run focused diagnostics only.`,
    ownership,
    success: ['Return a concrete deepest-cause layer with evidence.'],
    checks: ['No production mutation; bind every claimed path and result.'],
    fetchedEvidence: input.fetchedEvidence || null,
    bounded: true,
    nextReadyAfter: Array.isArray(input.nextReadyAfter) ? input.nextReadyAfter : ['work-1'],
  })
  if (!depthResult || depthResult.code !== 'PASS') {
    throw new SupervisorIntegrationError(
      'DEPTH_PROBE_REQUIRED',
      'the conditionally required depth specialist did not pass before production',
    )
  }
  return Object.freeze({ depthProbe: 'PASS', workItemId: 'conditional-depth-prober' })
}

function canonicalWorkerRuntimeSignals(result) {
  const supplied = result && result.payload && result.payload.runtimeSignals
  if (supplied === undefined) return null
  const body = supplied && typeof supplied === 'object' && !Array.isArray(supplied)
    ? {
        wrongLayerEvidence: supplied.wrongLayerEvidence === true,
        repeatedFailureCount: Number(supplied.repeatedFailureCount || 0),
        crossModuleUncertainty: supplied.crossModuleUncertainty === true,
        evidenceIds: Array.isArray(supplied.evidenceIds) ? supplied.evidenceIds.map(String) : [],
      }
    : null
  if (!body || !Number.isSafeInteger(body.repeatedFailureCount) || body.repeatedFailureCount < 0 ||
      !uniqueStrings(body.evidenceIds) ||
      ((body.wrongLayerEvidence || body.repeatedFailureCount > 0 || body.crossModuleUncertainty) &&
        body.evidenceIds.length === 0)) {
    throw new SupervisorIntegrationError(
      'RUNTIME_SIGNALS_INVALID',
      'worker runtime signals require canonical flags, an exact failure count, and immutable evidence identifiers',
    )
  }
  return Object.freeze({ ...body, signalHash: hashText(stableStringify(body)) })
}

function planOverlayExecution(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return Object.freeze({ status: 'UNSUPPORTED_SHAPE', reason: Object.freeze({
      code: 'OVERLAY_STEPS_REQUIRED', violations: Object.freeze(['overlay execution needs at least one step']),
    }) })
  }
  const byId = new Map()
  const errors = []
  for (const step of steps) {
    if (!step || typeof step.id !== 'string' || !step.id || typeof step.owner !== 'string' || !step.owner ||
        !uniqueStrings(step.resources || []) || !uniqueStrings(step.after || [])) {
      errors.push('each overlay step needs a unique id, owner, resources, and after list')
      continue
    }
    if (byId.has(step.id)) errors.push(`duplicate overlay step ${step.id}`)
    byId.set(step.id, step)
  }
  for (const step of byId.values()) {
    for (const dependency of step.after) if (!byId.has(dependency)) errors.push(`${step.id} has unknown predecessor ${dependency}`)
  }
  const dependsOn = (stepId, ancestor, seen = new Set()) => {
    if (stepId === ancestor) return true
    if (seen.has(stepId)) return false
    seen.add(stepId)
    const step = byId.get(stepId)
    return Boolean(step && step.after.some(parent => dependsOn(parent, ancestor, seen)))
  }
  const handoffs = []
  const claims = new Map()
  for (const step of byId.values()) {
    for (const resource of step.resources) {
      const prior = claims.get(resource) || []
      for (const owner of prior) {
        if (owner.owner === step.owner) continue
        if (dependsOn(step.id, owner.id)) {
          handoffs.push({ resource, from: owner.owner, to: step.owner, after: owner.id, before: step.id })
        } else if (!dependsOn(owner.id, step.id)) {
          errors.push(`resource ${resource} has unordered owners ${owner.owner} and ${step.owner}`)
        }
      }
      prior.push(step)
      claims.set(resource, prior)
    }
  }
  if (errors.length) return Object.freeze({ status: 'UNSUPPORTED_SHAPE', reason: Object.freeze({
    code: 'OVERLAY_OWNERSHIP_CONFLICT', violations: Object.freeze(errors),
  }) })
  return Object.freeze({ status: 'SUPPORTED', steps: Object.freeze(steps.map(step => Object.freeze({ ...step }))), handoffs: Object.freeze(handoffs) })
}

function evaluateRegressionDelta(baseline = [], after = []) {
  const identity = item => item && (item.command || item.id)
  const baselineById = new Map((baseline || []).map(item => [identity(item), item]))
  const preExistingFailures = (baseline || []).filter(item => item.status === 'FAIL').map(identity).sort()
  const newRegressions = (after || []).filter(item => {
    if (!item || item.status !== 'FAIL') return false
    const prior = baselineById.get(identity(item))
    return !prior || prior.status !== 'FAIL' || prior.fingerprint !== item.fingerprint
  }).map(identity).sort()
  return Object.freeze({ valid: newRegressions.length === 0, newRegressions: Object.freeze(newRegressions), preExistingFailures: Object.freeze(preExistingFailures) })
}

function canonicalCheckerTestOutcomes(supplied, namedChecks = []) {
  if (!Array.isArray(namedChecks) || !uniqueStrings(namedChecks) ||
      !Array.isArray(supplied) || supplied.length !== namedChecks.length) return null
  const expected = new Set(namedChecks)
  const seen = new Set()
  const outcomes = []
  for (const item of supplied) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['command', 'status', 'fingerprint'].includes(key)) ||
        typeof item.command !== 'string' || !expected.has(item.command) || seen.has(item.command) ||
        !['PASS', 'FAIL'].includes(item.status) || typeof item.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(item.fingerprint)) return null
    seen.add(item.command)
    outcomes.push(Object.freeze({
      command: item.command,
      status: item.status,
      fingerprint: item.fingerprint.trim(),
    }))
  }
  if (seen.size !== expected.size) return null
  return Object.freeze(outcomes.sort((left, right) => left.command.localeCompare(right.command)))
}

const INDEPENDENT_REFERENCE_METHOD_CLASSES = new Set([
  'requirements-review', 'authoritative-suite', 'black-box-boundary',
  'metamorphic-property', 'independent-model',
])

function canonicalIndependentReferenceMethod(supplied) {
  const stringList = value => Array.isArray(value) && value.length > 0 && uniqueStrings(value) &&
    value.every(item => typeof item === 'string' && item.trim() && item.length <= 512)
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
      !INDEPENDENT_REFERENCE_METHOD_CLASSES.has(supplied.methodClass) ||
      typeof supplied.source !== 'string' || !supplied.source.trim() || supplied.source.length > 512 ||
      typeof supplied.procedure !== 'string' || !supplied.procedure.trim() || supplied.procedure.length > 2048 ||
      supplied.expectedOutputDerivedFromSubjectCode !== false ||
      supplied.subjectLogicReimplemented !== false ||
      !stringList(supplied.positiveInvariants) || !stringList(supplied.negativeInvariants) ||
      !stringList(supplied.boundaryInvariants)) return null
  return Object.freeze({
    methodClass: supplied.methodClass,
    source: supplied.source.trim().toLowerCase().replace(/\s+/gu, ' '),
    procedure: supplied.procedure.trim().toLowerCase().replace(/\s+/gu, ' '),
    expectedOutputDerivedFromSubjectCode: false,
    subjectLogicReimplemented: false,
    positiveInvariants: supplied.positiveInvariants.map(value => value.trim().toLowerCase().replace(/\s+/gu, ' ')).sort(),
    negativeInvariants: supplied.negativeInvariants.map(value => value.trim().toLowerCase().replace(/\s+/gu, ' ')).sort(),
    boundaryInvariants: supplied.boundaryInvariants.map(value => value.trim().toLowerCase().replace(/\s+/gu, ' ')).sort(),
  })
}

function assertDistinctEvidenceConsumption(checks = []) {
  const consumed = new Map()
  const methods = new Map()
  const methodClasses = new Map()
  for (const check of checks) {
    const evidenceIds = Array.isArray(check && check.evidenceIds)
      ? check.evidenceIds.map(value => typeof value === 'string' ? value.trim() : value)
      : []
    if (!check || typeof check.checkerId !== 'string' || !check.checkerId ||
        typeof check.oracleId !== 'string' || !check.oracleId || evidenceIds.length === 0 ||
        !uniqueStrings(evidenceIds) || evidenceIds.some(id => id.length > 256 || id === check.oracleId || id === check.checkerId)) {
      throw new SupervisorIntegrationError('EVIDENCE_CONSUMPTION_INVALID', 'checker evidence consumption must be explicitly identified')
    }
    for (const evidenceId of evidenceIds) {
      const prior = consumed.get(evidenceId)
      if (prior && prior.checkerId !== check.checkerId) {
        throw new SupervisorIntegrationError(
          'DUPLICATE_UNDERLYING_EVIDENCE',
          `independent checkers ${prior.checkerId} and ${check.checkerId} consumed ${evidenceId}`,
          { evidenceId, firstOracleId: prior.oracleId, secondOracleId: check.oracleId },
        )
      }
      consumed.set(evidenceId, { checkerId: check.checkerId, oracleId: check.oracleId })
    }
    if (check.requireReferenceMethod === true) {
      const supplied = check.referenceMethod
      const normalized = canonicalIndependentReferenceMethod(supplied)
      if (!normalized) {
        throw new SupervisorIntegrationError(
          'REFERENCE_METHOD_INVALID',
          'independent checking requires a non-circular method with positive, negative, and edge-case observations',
          { checkerId: check.checkerId },
        )
      }
      const methodHash = hashText(stableStringify(normalized))
      const priorMethod = methods.get(methodHash)
      const priorClass = methodClasses.get(normalized.methodClass)
      if (priorMethod && priorMethod !== check.checkerId) {
        throw new SupervisorIntegrationError(
          'DUPLICATE_REFERENCE_METHOD',
          'independent checkers used the same normalized reference method',
          { firstCheckerId: priorMethod, secondCheckerId: check.checkerId, methodHash },
        )
      }
      if (priorClass && priorClass !== check.checkerId) {
        throw new SupervisorIntegrationError(
          'DUPLICATE_REFERENCE_METHOD_CLASS',
          'separate independent checkers must use different reference-method classes',
          { firstCheckerId: priorClass, secondCheckerId: check.checkerId, methodClass: normalized.methodClass },
        )
      }
      methods.set(methodHash, check.checkerId)
      methodClasses.set(normalized.methodClass, check.checkerId)
    }
  }
  return Object.freeze({
    valid: true,
    consumedEvidenceIds: Object.freeze([...consumed.keys()].sort()),
    referenceMethodHashes: Object.freeze([...methods.keys()].sort()),
  })
}

function createResidualRiskDisposition(input = {}) {
  const findings = Array.isArray(input.findings) ? input.findings : []
  const evidenceClosed = []
  const findingDecisions = []
  const suppliedReceipt = input.authorityReceipt
  for (const finding of findings) {
    if (!finding) continue
    const severityRank = { P0: 0, P1: 1, P2: 2, P3: 3 }
    if (finding.originalSeverity && severityRank[finding.severity] > severityRank[finding.originalSeverity]) {
      throw new SupervisorIntegrationError(
        'SEVERITY_DOWNGRADE_FORBIDDEN',
        'finding severity cannot be downgraded when reclassified as blocking or advisory',
        { findingId: finding.id, originalSeverity: finding.originalSeverity, severity: finding.severity },
      )
    }
    if (finding.resolution === 'non-defect' &&
        (!uniqueStrings(finding.evidenceIds || []) || finding.evidenceIds.length === 0 ||
          finding.originalSeverity && finding.originalSeverity !== finding.severity)) {
      throw new SupervisorIntegrationError(
        'NON_DEFECT_EVIDENCE_REQUIRED',
        'non-defect closure requires immutable evidence without severity manipulation',
      )
    }
    const needsAuthority = finding.disposition === 'advisory' ||
      (finding.severity === 'P1' && finding.resolution === 'non-defect')
    const exactReceipt = needsAuthority && suppliedReceipt &&
      Array.isArray(suppliedReceipt.acceptedFindingIds) && suppliedReceipt.acceptedFindingIds.includes(finding.id)
      ? { ...suppliedReceipt, acceptedFindingIds: [finding.id] }
      : needsAuthority ? null : undefined
    try {
      findingDecisions.push(createFindingDispositionDecision({ finding, authorityReceipt: exactReceipt }))
    } catch (error) {
      throw new SupervisorIntegrationError(error.code || 'FINDING_DISPOSITION_INVALID', error.message)
    }
    if (finding.resolution === 'non-defect') evidenceClosed.push(finding.id)
  }
  const blocking = findings.filter(item => item && item.disposition === 'blocking' && item.resolution !== 'non-defect')
  if (blocking.length) {
    throw new SupervisorIntegrationError('BLOCKING_FINDING_OPEN', 'blocking findings cannot be accepted as residual risk', {
      findingIds: blocking.map(item => item.id),
    })
  }
  const advisoryIds = findings.filter(item => item && item.disposition === 'advisory').map(item => item.id).sort()
  const receipt = suppliedReceipt
  const accepted = receipt && Array.isArray(receipt.acceptedFindingIds) ? [...receipt.acceptedFindingIds].sort() : []
  if (advisoryIds.length && (!receipt || typeof receipt.authority !== 'string' || !receipt.authority ||
      !/^[a-f0-9]{64}$/.test(receipt.receiptHash || '') || stableStringify(accepted) !== stableStringify(advisoryIds) ||
      receipt.channel !== 'post-finding-residual-risk' || !Array.isArray(receipt.acceptedFindings) ||
      stableStringify(receipt.acceptedFindings.map(item => item && ({ id: item.id, severity: item.severity })).sort((a, b) => a.id.localeCompare(b.id))) !==
        stableStringify(findings.filter(item => item && item.disposition === 'advisory')
          .map(item => ({ id: item.id, severity: item.severity })).sort((a, b) => a.id.localeCompare(b.id))) ||
      hashText(stableStringify(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'receiptHash')))) !== receipt.receiptHash)) {
    throw new SupervisorIntegrationError(
      'RESIDUAL_RISK_AUTHORITY_REQUIRED',
      'every advisory finding requires an exact authorized residual-risk receipt',
      { advisoryIds, accepted },
    )
  }
  return Object.freeze({
    status: 'DISPOSED', blockingFindingIds: Object.freeze([]),
    advisoryFindingIds: Object.freeze(advisoryIds),
    evidenceClosedFindingIds: Object.freeze(evidenceClosed.sort()), authorityReceipt: receipt || null,
    findingDecisions: Object.freeze(findingDecisions),
  })
}

function bindResidualRiskAuthorityReceipt(input = {}) {
  const findings = Array.isArray(input.findings) ? input.findings : []
  const decision = input.decision
  const advisory = findings.filter(item => item && item.disposition === 'advisory')
    .map(item => ({ id: item.id, severity: item.severity })).sort((a, b) => a.id.localeCompare(b.id))
  const accepted = decision && Array.isArray(decision.acceptedFindings)
    ? decision.acceptedFindings.map(item => ({ id: item && item.id, severity: item && item.severity }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    : []
  if (!decision || typeof decision.authority !== 'string' || !decision.authority ||
      stableStringify(accepted) !== stableStringify(advisory) ||
      !/^[a-f0-9]{64}$/.test(input.candidateHash || '') ||
      typeof input.runId !== 'string' || !input.runId || typeof input.activationId !== 'string' || !input.activationId ||
      !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new SupervisorIntegrationError(
      'RESIDUAL_RISK_AUTHORITY_REQUIRED',
      'post-finding authority must accept the exact advisory finding identifiers and severities',
    )
  }
  const body = {
    schemaVersion: 1,
    channel: 'post-finding-residual-risk',
    runId: input.runId,
    activationId: input.activationId,
    generation: input.generation,
    candidateHash: input.candidateHash,
    authority: decision.authority,
    acceptedFindingIds: advisory.map(item => item.id),
    acceptedFindings: advisory,
  }
  return Object.freeze({ ...body, receiptHash: hashText(stableStringify(body)) })
}

function validateWorkerRequestedTransition(report) {
  const request = report && report.requestedTransition
  const allowed = ['event', 'reason', 'invalidateEvidenceIds', 'reopenWorkerId', 'replacementWorkerId']
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !allowed.includes(key)) || request.event !== 'WORK_ITEM_VERIFIED' ||
      typeof request.reason !== 'string' || !request.reason.trim() || request.reason !== request.reason.trim() ||
      !uniqueStrings(request.invalidateEvidenceIds || []) ||
      (request.reopenWorkerId !== undefined && (typeof request.reopenWorkerId !== 'string' || !request.reopenWorkerId)) ||
      (request.replacementWorkerId !== undefined && (typeof request.replacementWorkerId !== 'string' || !request.replacementWorkerId))) {
    throw new SupervisorIntegrationError(
      'REQUESTED_TRANSITION_INVALID',
      'worker requestedTransition must match the canonical schema and request WORK_ITEM_VERIFIED',
    )
  }
  return Object.freeze({ ...request, invalidateEvidenceIds: Object.freeze([...request.invalidateEvidenceIds]) })
}

function consumeSplitRequired(report, context = {}) {
  if (!report || report.code !== 'SPLIT_REQUIRED') return null
  const parts = Array.isArray(report.remainingConcerns) ? report.remainingConcerns : []
  if (!['DIRECT', 'LIGHT', 'ROADMAP'].includes(context.route) || context.depth !== 0 ||
      parts.length < 2 || parts.length > 3 || !uniqueStrings(parts) ||
      !Number.isSafeInteger(context.remainingLaunches) || context.remainingLaunches < parts.length ||
      typeof context.parentWorkItemId !== 'string' || !context.parentWorkItemId) {
    throw new SupervisorIntegrationError(
      'SPLIT_DECOMPOSITION_INVALID',
      'SPLIT_REQUIRED must be consumed once by the parent under the current route and launch budget',
    )
  }
  return Object.freeze({
    route: context.route, depth: 1,
    parts: Object.freeze(parts.map((assignment, index) => Object.freeze({
      workItemId: `${context.parentWorkItemId}:split:${index + 1}`, assignment,
    }))),
  })
}

function requiredCompletionGates(route, tier) {
  if (!['DIRECT', 'LIGHT', 'ROADMAP'].includes(route) || !['T0', 'T1', 'T2', 'T3'].includes(tier)) {
    throw new SupervisorIntegrationError('COMPLETION_ROUTE_INVALID', 'completion requires a canonical route and tier')
  }
  const gates = ['usable-build', 'independent-check', 'final-verification']
  if (route !== 'DIRECT') gates.unshift('accepted-plan')
  if (route === 'ROADMAP') gates.unshift('roadmap-join')
  if (tier === 'T3') gates.push('risk-sign-off')
  return Object.freeze(gates)
}

function canonicalWorkSelection(input, contract) {
  if (input && input.baseWorkType) return {
    baseWorkType: input.baseWorkType,
    resultFormat: input.resultFormat,
    artifactOverlays: input.artifactOverlays || [],
    acceptanceOverlays: input.acceptanceOverlays || [],
    riskOverlays: input.riskOverlays || [],
    riskEvidence: input.riskEvidence || {},
  }
  const workType = String(input && input.workType || '').trim().toLowerCase()
    .replace(/[\s/]+/g, '-')
  const legacyRiskMap = Object.fromEntries(Object.entries(RISK_CHECKS).map(([legacy, current]) => [legacy, current]))
  const riskOverlays = Array.isArray(input && input.risks)
    ? input.risks.map(risk => legacyRiskMap[risk] || risk)
    : []
  const acceptanceMap = {
    'inspect-report': ['receipts'],
    'research-decide': ['receipts'],
    'mechanical-change': ['exact-diff'],
    'debug-fix': ['failing-to-passing-behavior'],
    'implement-build': ['failing-to-passing-behavior'],
    refactor: ['behavior-preservation'],
    'review-polish': ['rendered-journey'],
    'external-operation': [
      'receipts', 'external-prepare', 'external-commit', 'external-reconcile',
      'external-rollback', 'external-idempotency',
    ],
  }
  const readOnly = ['inspect-report', 'research-decide'].includes(workType)
  const external = workType === 'external-operation'
  return {
    baseWorkType: workType,
    resultFormat: readOnly ? (workType === 'research-decide' ? 'decision-record' : 'read-only-findings')
      : external ? 'external-receipt' : workType === 'implement-build' ? 'new-build' : 'changed-files',
    artifactOverlays: [readOnly ? 'read-only-result' : external ? 'external-system' : 'executable-code'],
    acceptanceOverlays: acceptanceMap[workType] || [],
    riskOverlays,
    riskEvidence: Object.fromEntries(riskOverlays.map(risk => [risk, 'declared by route decision'])),
  }
}

function selectionMatches(rule, selection) {
  const when = rule.when || {}
  if (when.baseWorkType && when.baseWorkType !== selection.baseWorkType) return false
  const artifactOverlays = Array.isArray(selection.artifactOverlays) ? selection.artifactOverlays : []
  if (when.artifactOverlaysAny && !when.artifactOverlaysAny.some(item => artifactOverlays.includes(item))) return false
  return true
}

function selectWorkRecipe(input = {}) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const contract = loadGateContract(input.gateContractPath)
  const composition = contract.composition
  const schema = composition.selectionSchema
  const selection = canonicalWorkSelection(input, contract)
  const allowed = field => new Set(schema.properties[field].items
    ? schema.properties[field].items.enum
    : schema.properties[field].enum)
  const errors = []
  const riskOverlays = Array.isArray(selection.riskOverlays) ? selection.riskOverlays : []
  if (!allowed('baseWorkType').has(selection.baseWorkType)) errors.push('unknown baseWorkType')
  if (!allowed('resultFormat').has(selection.resultFormat)) errors.push('unknown resultFormat')
  for (const field of ['artifactOverlays', 'acceptanceOverlays', 'riskOverlays']) {
    if (!uniqueStrings(selection[field])) errors.push(`${field} must contain unique known strings`)
    else if (selection[field].some(value => !allowed(field).has(value))) errors.push(`${field} contains an unknown value`)
  }
  if (!selection.artifactOverlays || selection.artifactOverlays.length === 0) errors.push('at least one deliverable overlay is required')
  if (!selection.acceptanceOverlays || selection.acceptanceOverlays.length === 0) errors.push('at least one acceptance overlay is required')
  if (!selection.riskEvidence || typeof selection.riskEvidence !== 'object' || Array.isArray(selection.riskEvidence)) {
    errors.push('riskEvidence must be an object')
  } else {
    for (const risk of riskOverlays) {
      if (typeof selection.riskEvidence[risk] !== 'string' || !selection.riskEvidence[risk].trim()) {
        errors.push(`riskEvidence is required for ${risk}`)
      }
    }
  }
  for (const incompatible of composition.validation.incompatibleCombinations) {
    if (selection.baseWorkType === incompatible.baseWorkType &&
        riskOverlays.includes(incompatible.riskOverlay)) errors.push(incompatible.reason)
  }
  for (const rule of composition.validation.compoundRules) {
    if (!selectionMatches(rule, selection)) continue
    const require = rule.require || {}
    const forbid = rule.forbid || {}
    if (require.resultFormats && !require.resultFormats.includes(selection.resultFormat)) errors.push(`${rule.id}: resultFormat`)
    for (const [field, values] of Object.entries(require)) {
      if (field === 'resultFormats') continue
      const targetField = field.replace(/Any$|All$/, '')
      const actual = Array.isArray(selection[targetField]) ? selection[targetField] : []
      if (field.endsWith('Any') && !values.some(value => actual.includes(value))) errors.push(`${rule.id}: ${field}`)
      if (field.endsWith('All') && !values.every(value => actual.includes(value))) errors.push(`${rule.id}: ${field}`)
    }
    for (const [field, values] of Object.entries(forbid)) {
      const targetField = field.replace(/Any$|All$/, '')
      const actual = Array.isArray(selection[targetField]) ? selection[targetField] : []
      if (field.endsWith('Any') && values.some(value => actual.includes(value))) errors.push(`${rule.id}: forbids ${field}`)
    }
  }
  if (errors.length) {
    const violations = [...new Set(errors)]
    return Object.freeze({
    status: 'UNSUPPORTED_SHAPE',
    reason: Object.freeze({
      code: 'INVALID_GATE_SELECTION',
      message: violations.join('; '),
      violations: Object.freeze([...violations]),
    }),
    legacyStatus: 'UNSUPPORTED_WORK_SHAPE',
    workType: selection.baseWorkType || null,
    selection: Object.freeze(selection),
    errors: Object.freeze(violations),
    checks: [], riskChecks: [], runtimeFrameworkGeneration: false,
    })
  }
  const artifactChecks = selection.artifactOverlays.flatMap(name =>
    composition.artifactOverlays[name].requiredCheckKinds)
  const riskChecks = selection.riskOverlays.map(name => contract.riskOverlays[name].check)
  const extraChecks = Array.isArray(input.checks) ? input.checks.filter(item => typeof item === 'string' && item) : []
  const legacyName = selection.baseWorkType.replace(/-/g, '/')
    .replace('mechanical/change', 'mechanical-change')
    .replace('external/operation', 'external-operation')
  const runtimeTriggers = selectRuntimeGateTriggers(selection, input.runtimeSignals || {})
  const runtimeTriggeredChecks = [
    ...(runtimeTriggers.depthProber.required ? ['conditional-wrong-layer-depth-probe'] : []),
    ...(runtimeTriggers.documentationPlanning.required ? ['documentation-ambiguity-plan'] : []),
    ...(runtimeTriggers.performance.required ? ['performance-or-service-level'] : []),
  ]
  const runtimeGatePlan = Object.freeze({
    acceptanceContracts: acceptanceOracleContracts(selection.acceptanceOverlays),
    coverage: createArtifactCoverageContract(selection.artifactOverlays),
    regressionPolicy: Object.freeze({
      baselineMayBeRed: true,
      acceptance: 'NO_NEW_REGRESSION',
      comparator: 'test-id-status-fingerprint-delta',
    }),
    triggers: runtimeTriggers,
    executionPath: Object.freeze({
      beforeProduction: Object.freeze(runtimeTriggers.depthProber.required ? ['conditional-depth-prober'] : []),
      documentationPlanning: runtimeTriggers.documentationPlanning.required ? 'REQUIRED' : 'SKIP',
      performanceOracle: runtimeTriggers.performance.required ? 'REQUIRED' : 'SKIP',
    }),
    overlayExecution: Array.isArray(input.overlaySteps) && input.overlaySteps.length
      ? planOverlayExecution(input.overlaySteps)
      : Object.freeze({ status: 'NOT_DECLARED', steps: Object.freeze([]), handoffs: Object.freeze([]) }),
    assurance: Object.freeze({
      ordinaryFinalAuthority: 'independent-final-verifier',
      duplicateUnderlyingEvidenceForbidden: true,
      extraSeatRequiresNamedDistinctRisk: true,
      generatedFreshVerifyAfterValidator: false,
    }),
  })
  return Object.freeze({
    status: 'SUPPORTED',
    workType: legacyName,
    selection: Object.freeze(selection),
    checks: [...new Set([...selection.acceptanceOverlays, ...artifactChecks, ...extraChecks, ...runtimeTriggeredChecks])],
    riskChecks: [...new Set(riskChecks)],
    gateGraph: contract.routeGraphs[input.route] || null,
    runtimeGatePlan,
    runtimeFrameworkGeneration: false,
  })
}

function safeEnvironmentFactory() {
  const safetyPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'local-only-safety.cjs')
  let safety
  try { safety = require(safetyPath) } catch (error) {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'local-only child environment module is unavailable', {
      cause: error.message,
    })
  }
  if (typeof safety.createSafeChildGitEnvironment !== 'function') {
    throw new SupervisorIntegrationError(
      'PROVIDER_UNSUPPORTED',
      'local-only safety module does not export createSafeChildGitEnvironment',
    )
  }
  return (repoPath, baseEnvironment, options = {}) => {
    if (typeof options.expectedBranch !== 'string' || !options.expectedBranch) {
      throw new SupervisorIntegrationError('SAFE_GIT_ENV_INVALID', 'expectedBranch is required for child-boundary verification')
    }
    if (!options.configIsolationPath || !options.ghConfigDir || !options.enforcementProof) {
      throw new SupervisorIntegrationError(
        'SAFE_GIT_ENV_INVALID',
        'activation-private Git/GitHub isolation paths and enforcement proof are required',
      )
    }
    const environment = safety.createSafeChildGitEnvironment(repoPath, baseEnvironment, options)
    const repository = safety.discoverRepository(repoPath)
    const inspection = safety.inspect(repository, options.expectedBranch, environment, {
      enforcementProof: options.enforcementProof,
    })
    return ensureSafeEnvironment({ environment, attestation: inspection })
  }
}

function ensureSafeEnvironment(boundary) {
  const environment = boundary && boundary.environment
  const attestation = boundary && boundary.attestation
  const invalidChannels = []
  for (const name of REQUIRED_SAFETY_CHANNELS) {
    const item = attestation && attestation.channels && attestation.channels[name]
    if (!item || item.applicable !== true || item.enforced !== true ||
        !item.evidence || typeof item.evidence !== 'object' || Object.keys(item.evidence).length === 0 ||
        !Array.isArray(item.residuals) || item.residuals.length !== 0) invalidChannels.push(name)
  }
  if (!environment || environment.GIT_ALLOW_PROTOCOL !== 'file' ||
      attestation && attestation.gitEnforced !== true ||
      !attestation || attestation.mechanicallyEnforced !== true || invalidChannels.length > 0) {
    throw new SupervisorIntegrationError('SAFE_GIT_ENV_INVALID', 'child environment lacks the complete local-only enforcement attestation', {
      gitEnforced: attestation && attestation.gitEnforced,
      mechanicallyEnforced: attestation && attestation.mechanicallyEnforced,
      invalidChannels,
    })
  }
  return Object.freeze({ environment, attestation })
}

function parseCodexJsonl(source) {
  const accumulator = createCodexJsonlAccumulator()
  for (const [index, line] of String(source || '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    accumulator.push(line, index + 1)
  }
  return accumulator.snapshot()
}

function createCodexJsonlAccumulator() {
  const maximumRetainedEvents = 256
  const state = {
    events: [], eventCount: 0, sessionId: null, finalText: null, output: null, usage: null,
    messageOutputs: [], messageOutputsOverflow: false,
    eventHash: crypto.createHash('sha256'),
  }
  state.eventHash.update('[')
  const eventStreamHash = () => state.eventHash.copy().update(']').digest('hex')
  return Object.freeze({
    push(line, lineNumber = state.eventCount + 1) {
      let event
      try { event = JSON.parse(String(line)) } catch (error) {
        throw new SupervisorIntegrationError('CODEX_EVENT_STREAM_INVALID', `Codex JSONL event ${lineNumber} is invalid`, {
          cause: error.message,
        })
      }
      state.eventHash.update(state.eventCount === 0 ? '' : ',').update(JSON.stringify(event))
      state.eventCount += 1
      state.events.push(event)
      if (state.events.length > maximumRetainedEvents) state.events.shift()
      if (event.type === 'thread.started') state.sessionId = event.thread_id || event.threadId || state.sessionId
      if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
        state.finalText = event.item.text || event.item.content || state.finalText
        if (typeof state.finalText === 'string' && state.finalText.trim()) {
          try { state.output = JSON.parse(state.finalText) } catch {
            state.output = { outcome: 'FAILED', terminalEnvelope: { status: 'OUTPUT_SCHEMA_INVALID' }, text: state.finalText }
          }
          if (state.messageOutputs.length < maximumRetainedEvents) state.messageOutputs.push(state.output)
          else state.messageOutputsOverflow = true
        }
      }
      if (event.type === 'turn.completed') state.usage = codexUsageFromEvent(event)
      return event
    },
    watermark() {
      return {
        eventCount: state.eventCount,
        retainedEventCount: state.events.length,
        eventStreamHash: eventStreamHash(),
        finalText: state.finalText,
        output: state.output,
        messageOutputs: state.messageOutputs.slice(),
        messageOutputsOverflow: state.messageOutputsOverflow,
        sessionId: state.sessionId,
        usage: state.usage,
      }
    },
    snapshot() {
      return {
        events: [...state.events], eventCount: state.eventCount, retainedEventCount: state.events.length,
        eventStreamHash: eventStreamHash(), finalText: state.finalText, output: state.output,
        messageOutputs: state.messageOutputs.slice(),
        messageOutputsOverflow: state.messageOutputsOverflow,
        sessionId: state.sessionId, usage: state.usage,
      }
    },
  })
}

function reconstructTypedExitZeroResult(record, parsed) {
  const common = {
    schemaVersion: '2.0.0', outcome: 'FAILED', reconstructedTerminal: true,
    terminalEnvelope: {
      status: 'TERMINAL_RESULT_RECONSTRUCTED',
      reason: 'owned child exited zero with complete usage but no valid typed terminal record',
    },
  }
  if (CHECKER_ROLES.has(record.logicalRole)) {
    return {
      schemaVersion: '2.0.0', code: 'RUNTIME_FAILURE',
      description: 'A tool or execution environment failed before the requested check could finish.',
      stateClass: 'terminal', runId: record.runId,
      requestEnvelopeHash: record.dispatch.requestPointer.hash,
      currentVersionHash: record.candidateHash,
      completedResults: [], nextReadyWork: [],
      cause: {
        event: 'TYPED_TERMINAL_MISSING',
        reason: 'The owned child exited zero with complete usage but no canonical typed terminal record.',
        unblockPath: null,
      },
      payloadSchemaId: 'autoprompt.checker-reconstruction.v2',
      payload: { reconstructedTerminal: true, terminalEnvelope: common.terminalEnvelope },
      recordedAt: new Date().toISOString(),
    }
  }
  if (record.logicalRole === 'route-analyst' || record.logicalRole === 'run-owner') return common
  return {
    ...common,
    reportType: 'result', runId: record.runId, assignmentId: record.workItemId,
    logicalRoleId: record.logicalRole, physicalRoleId: record.physicalRole,
    requestEnvelopeHash: record.dispatch.requestPointer.hash,
    allAssignedItemsPass: false, filesChanged: [], resourcesChanged: [], behaviorChanged: [], commands: [],
    successItems: [{ id: 'typed-terminal-record', status: 'fail', evidenceIds: [] }],
    remainingConcerns: ['The child exited without its required typed terminal record.'],
    findingIds: Array.isArray(record.findingIds) && record.findingIds.length
      ? [...record.findingIds]
      : Array.isArray(record.canonicalAssignment && record.canonicalAssignment.findingIds) &&
          record.canonicalAssignment.findingIds.length
        ? [...record.canonicalAssignment.findingIds] : ['RUNTIME-TERMINAL-RESULT-MISSING'],
    requestedTransition: {
      event: 'WORK_ITEM_VERIFIED',
      reason: 'Persist the deterministic failed reconstruction without relaunching the model.',
      invalidateEvidenceIds: [],
    },
  }
}

function reconstructInvalidCheckerResult(record, invalidResult, error) {
  const reconstructed = reconstructTypedExitZeroResult(record, {})
  return Object.freeze({
    ...reconstructed,
    candidateHash: record.candidateHash || null,
    contextId: invalidResult && invalidResult.contextId || record.continuationId || null,
    events: invalidResult && Array.isArray(invalidResult.events) ? invalidResult.events : [],
    usage: invalidResult && invalidResult.usage || null,
    usageStreamed: invalidResult && invalidResult.usageStreamed === true,
    evidenceHashes: invalidResult && Array.isArray(invalidResult.evidenceHashes)
      ? invalidResult.evidenceHashes : [],
    cause: {
      event: 'CHECK_REPORT_REJECTED',
      reason: 'The checker returned a structurally invalid or incorrectly bound report; it is non-authoritative retry evidence.',
      unblockPath: 'Launch one fresh evidence-bound checker reassessment.',
    },
    payloadSchemaId: 'autoprompt.checker-reassessment.v2',
    payload: {
      reconstructedTerminal: true,
      rejectedCode: error && error.code || 'CHECK_REPORT_INVALID',
      validationDetails: error && error.details || {},
    },
  })
}

function typedChildOutputReady(output, record) {
  if (!output || typeof output !== 'object') return false
  if (TERMINAL_OUTCOMES.includes(output.outcome)) return true
  if (record.logicalRole === 'route-analyst') {
    return output.schemaVersion === '2.0.0' &&
      ['CONTINUE', 'NEEDS_USER'].includes(output.preWorkResult) &&
      Object.prototype.hasOwnProperty.call(output, 'recommendedRoute')
  }
  if (record.logicalRole === 'run-owner' && record.route === 'PRE_ROUTE') {
    return output.schemaVersion === '2.0.0' && ['DECIDED', 'WAITING_USER'].includes(output.status)
  }
  if (CHECKER_ROLES.has(record.logicalRole)) {
    return output.schemaVersion === '2.0.0' && CANONICAL_CHECKER_CODES.has(output.code)
  }
  return output.schemaVersion === '2.0.0' && output.reportType === 'result'
}

function codexUsageFromEvent(event) {
  if (!event || event.type !== 'turn.completed' || !event.usage) return null
  const aliases = {
    totalInput: ['input_tokens', 'inputTokens'],
    cachedInput: ['cached_input_tokens', 'cachedInputTokens'],
    output: ['output_tokens', 'outputTokens'],
    // Codex CLI 0.148 emits the OpenAI usage spelling
    // `reasoning_output_tokens`. Keep the older spellings for replaying
    // already-captured fixtures and compatible provider projections.
    reasoning: ['reasoning_output_tokens', 'reasoning_tokens', 'reasoningTokens'],
  }
  const result = {}
  const missing = []
  for (const [field, names] of Object.entries(aliases)) {
    const name = names.find(candidate => Object.prototype.hasOwnProperty.call(event.usage, candidate))
    if (!name || !Number.isFinite(Number(event.usage[name])) || Number(event.usage[name]) < 0) missing.push(field)
    else result[field] = Number(event.usage[name])
  }
  if (missing.length) {
    throw new SupervisorIntegrationError(
      'CODEX_USAGE_INCOMPLETE',
      'Codex usage event omitted a required accounting category',
      { missing },
    )
  }
  if (result.cachedInput > result.totalInput) {
    throw new SupervisorIntegrationError(
      'CODEX_USAGE_INCOMPLETE',
      'Codex cached input usage exceeds total input usage',
      { totalInput: result.totalInput, cachedInput: result.cachedInput },
    )
  }
  // Codex reports input_tokens as the total input, including cached input.
  // Scheduler accounting keeps those dimensions disjoint so cached tokens
  // must be subtracted exactly once before enforcing either ceiling.
  result.noncachedInput = result.totalInput - result.cachedInput
  delete result.totalInput
  return result
}

function resolveExecutablePath(command, options = {}) {
  try {
    return resolveCodexExecutable(command, options).executable
  } catch (error) {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', error.message)
  }
}

function probeCodexExecCapabilities(options = {}) {
  try {
    const runtime = options.admittedRuntime
    if (!runtime) throw new Error('signed Codex executable admission is required')
    const executable = runtime.executable
    const invoke = argv => String(executeAdmittedCodex(runtime, argv, {
      cwd: options.cwd,
      environment: options.environment,
      execFileSync: options.execFileSync,
      encoding: 'utf8',
    }))
    const execHelp = invoke(['exec', '--help'])
    const resumeHelp = invoke(['exec', 'resume', '--help'])
    const features = invoke(['features', 'list'])
    const cliVersion = invoke(['--version']).trim()
    const requiredExec = ['--json', '--output-schema', '--profile', '--cd', '--strict-config']
    const missing = requiredExec.filter(flag => !execHelp.includes(flag))
    if (!resumeHelp.includes('--json')) missing.push('resume:--json')
    if (!/^multi_agent\s+\S+\s+(?:true|false)$/m.test(features)) missing.push('feature:multi_agent')
    if (!cliVersion || cliVersion.length > 256 || cliVersion !== runtime.identity.version) {
      missing.push('cli:version')
    }
    if (missing.length) {
      return Object.freeze({ supported: false, code: 'PROVIDER_UNSUPPORTED', missing })
    }
    return Object.freeze({
      supported: true,
      executable,
      environmentOverlay: runtime.environmentOverlay,
      cliVersion,
      evidenceHashes: Object.freeze([
        hashText(execHelp), hashText(resumeHelp), hashText(features), hashText(cliVersion),
      ]),
      eventStreaming: true,
      toolOutputCapture: true,
      stableChildIdentity: options.processOwnership === true,
      sameContextContinuation: true,
      isolatedChecking: options.isolatedChecking === true,
      cancellation: options.processOwnership === true,
      builtinSpawningCanBeDisabled: true,
    })
  } catch (error) {
    return Object.freeze({ supported: false, code: 'PROVIDER_UNSUPPORTED', error: error.message })
  }
}

const CODEX_PROVIDER_ENVELOPE_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    canonicalJson: Object.freeze({
      type: 'string',
      description: 'JSON-serialized canonical AutoPrompt output. The runtime decodes and validates it against the original role schema.',
    }),
  }),
  required: Object.freeze(['canonicalJson']),
  additionalProperties: false,
})

function materializeCodexProviderEnvelopeSchema(providerSchemaRoot) {
  const root = path.resolve(providerSchemaRoot)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.chmodSync(root, 0o700)
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      (typeof process.geteuid === 'function' && rootStat.uid !== process.geteuid())) {
    throw new SupervisorIntegrationError(
      'PROVIDER_SCHEMA_TRANSPORT_UNSAFE',
      'Codex provider-schema transport root must be a private owned directory',
    )
  }
  const bytes = Buffer.from(`${JSON.stringify(CODEX_PROVIDER_ENVELOPE_SCHEMA, null, 2)}\n`, 'utf8')
  const filename = path.join(root, `canonical-json-envelope-${hashText(bytes)}.schema.json`)
  try {
    fs.writeFileSync(filename, bytes, { encoding: null, flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error
    const existing = fs.readFileSync(filename)
    if (!existing.equals(bytes)) {
      throw new SupervisorIntegrationError(
        'PROVIDER_SCHEMA_TRANSPORT_UNSAFE',
        'existing Codex provider-schema transport differs from its content-addressed bytes',
      )
    }
  }
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.geteuid === 'function' && stat.uid !== process.geteuid())) {
    throw new SupervisorIntegrationError(
      'PROVIDER_SCHEMA_TRANSPORT_UNSAFE',
      'Codex provider-schema transport must be one private owned regular file',
    )
  }
  return filename
}

function decodeCodexProviderEnvelope(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output) ||
      Object.keys(output).length !== 1 || typeof output.canonicalJson !== 'string') {
    throw new SupervisorIntegrationError(
      'CODEX_OUTPUT_TRANSPORT_INVALID',
      'Codex child did not return the required canonicalJson provider envelope',
    )
  }
  let decoded
  try { decoded = JSON.parse(output.canonicalJson) } catch (error) {
    throw new SupervisorIntegrationError(
      'CODEX_OUTPUT_TRANSPORT_INVALID',
      'Codex child canonicalJson is not valid JSON',
      { cause: error.message },
    )
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new SupervisorIntegrationError(
      'CODEX_OUTPUT_TRANSPORT_INVALID',
      'Codex child canonicalJson must decode to one canonical output object',
    )
  }
  return decoded
}

function applyBenchmarkEffortPin(assignment, environment = process.env) {
  const requested = environment.AUTOPROMPT_BENCHMARK_FORCE_EFFORT
  if (requested === undefined) return assignment
  if (requested !== 'xhigh') {
    throw new SupervisorIntegrationError(
      'INVALID_EFFORT',
      'AUTOPROMPT_BENCHMARK_FORCE_EFFORT supports only the audited xhigh benchmark pin',
    )
  }
  if (!assignment || typeof assignment !== 'object') {
    throw new SupervisorIntegrationError(
      'MODEL_ASSIGNMENT_INVALID',
      'benchmark xhigh pin requires a resolved provider assignment',
    )
  }
  return Object.freeze({
    ...assignment,
    effort: 'xhigh',
    source: 'benchmark-explicit-xhigh-pin',
    routeIndependent: true,
  })
}

function benchmarkPhaseTimeoutMs(defaultMs, environment = process.env) {
  return benchmarkNoTimeoutEnabled(environment)
    ? Number.POSITIVE_INFINITY
    : defaultMs
}

function benchmarkNoTimeoutEnabled(environment = process.env) {
  return Boolean(environment && environment.AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT === '1')
}

function benchmarkFirstProductSignalDeadlineEnabled(ceilingMs, environment = process.env) {
  return environment.AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT !== '1' &&
    Number.isSafeInteger(ceilingMs) && ceilingMs > 0 && ceilingMs < Number.MAX_SAFE_INTEGER
}

function resolvePreMutationRouteDecisionHash(request, exactFileHash) {
  const requested = request && request.routeDecisionHash
  if (/^[a-f0-9]{64}$/u.test(requested || '')) return requested
  const persisted = typeof exactFileHash === 'function' ? exactFileHash('route/decision.json') : null
  if (!/^[a-f0-9]{64}$/u.test(persisted || '')) {
    throw new SupervisorIntegrationError(
      'PRE_MUTATION_BASELINE_INVALID',
      'pre-mutation baseline requires the durable route-decision hash',
    )
  }
  return persisted
}

function productionRoadmapExpansionAuthority(input = {}) {
  const admittedAskCount = Number(input.admittedAskCount)
  const missionScopeHash = input.missionScopeHash
  const planSha256 = input.planSha256
  if (!Number.isSafeInteger(admittedAskCount) || admittedAskCount < 1 ||
      !/^[a-f0-9]{64}$/u.test(missionScopeHash || '') ||
      !/^[a-f0-9]{64}$/u.test(planSha256 || '')) {
    throw new SupervisorIntegrationError(
      'ROADMAP_EXPANSION_NOT_ADMITTED',
      'production roadmap authority requires an exact expansion count and immutable request/plan hashes',
    )
  }
  const requestVersionPointerHash = hashText(stableStringify(input.requestVersionPointer || null))
  const necessityEvidenceHash = hashText(stableStringify({
    schemaVersion: 1,
    kind: 'roadmap-decomposition-necessity',
    admittedAskCount,
    missionScopeHash,
    planSha256,
    requestVersionPointerHash,
  }))
  const marginalValueEvidenceHash = hashText(stableStringify({
    schemaVersion: 1,
    kind: 'roadmap-decomposition-marginal-value',
    admittedAskCount,
    missionScopeHash,
    planSha256,
    requestVersionPointerHash,
  }))
  const receipt = {
    schemaVersion: 1,
    authorityId: 'production-supervisor-roadmap-expansion',
    accepted: true,
    admittedAskCount,
    missionScopeHash,
    planSha256,
    requestVersionPointerHash,
    necessityEvidenceHash,
    marginalValueEvidenceHash,
  }
  return Object.freeze({
    ...receipt,
    authorityReceiptHash: hashText(stableStringify(receipt)),
  })
}

function appendSupervisorRecordedCapturedDomainOutcomes(contracts, outcomes) {
  const target = Array.isArray(outcomes) ? outcomes : []
  for (const contract of Array.isArray(contracts) ? contracts : []) {
    if (!contract || contract.kind !== 'IMAGE_DATUM' ||
        target.some(outcome => outcome && outcome.kind === 'IMAGE_DATUM')) continue
    target.push(Object.freeze({
      schemaVersion: '1.0.0',
      kind: 'IMAGE_DATUM',
      certificateHash: contract.certificateHash,
      rulingHash: contract.rulingHash,
      selectedInterpretationId: contract.selectedInterpretation && contract.selectedInterpretation.id,
      certificateRecordedBeforeGeometryWrites: true,
    }))
  }
  return target
}

function runtimeCapabilityExpiryMs(requestedExpiryMs, issuedAtMs, environment = process.env) {
  if (benchmarkNoTimeoutEnabled(environment)) return Date.UTC(9999, 11, 31, 23, 59, 59, 999)
  return Math.min(Number(requestedExpiryMs), issuedAtMs + 5 * 60 * 1000)
}

function codexPrivateWorkspaceProjection(record, canonicalTargetPath, workingDirectory) {
  if (!record.workerWorkspace) return []
  const canonicalTargetRoot = path.resolve(canonicalTargetPath)
  const writableWorkspaceRoot = path.resolve(workingDirectory)
  if (canonicalTargetRoot === writableWorkspaceRoot ||
      writableWorkspaceRoot.startsWith(`${canonicalTargetRoot}${path.sep}`) ||
      canonicalTargetRoot.startsWith(`${writableWorkspaceRoot}${path.sep}`)) {
    throw new SupervisorIntegrationError(
      'WORKER_ISOLATION_UNSUPPORTED',
      'Codex private-workspace projection requires disjoint canonical and writable roots',
    )
  }
  if (!record.canonicalAssignment || !Array.isArray(record.canonicalAssignment.resources)) {
    throw new SupervisorIntegrationError(
      'WORKER_ISOLATION_UNSUPPORTED',
      'Codex private-workspace projection requires the bound canonical assignment',
    )
  }
  const resources = record.canonicalAssignment.resources.flatMap(resource => {
    if (!resource || !LOCAL_MUTATION_RESOURCE_KINDS.has(resource.kind)) return []
    const canonicalPath = resolveOwnedResourcePath(canonicalTargetRoot, resource)
    if (!canonicalPath) return []
    const relativePath = path.relative(canonicalTargetRoot, canonicalPath)
    return [Object.freeze({
      kind: resource.kind,
      access: resource.access,
      canonicalPath,
      workspacePath: relativePath
        ? path.resolve(writableWorkspaceRoot, relativePath)
        : writableWorkspaceRoot,
      reportPath: relativePath ? relativePath.replace(/\\/g, '/') : '.',
    })]
  })
  const projection = Object.freeze({
    schemaVersion: 1,
    canonicalTargetRoot,
    writableWorkspaceRoot,
    resources: Object.freeze(resources),
  })
  return [
    'AUTOPROMPT_PRIVATE_WORKSPACE_PROJECTION_V1',
    `Private workspace projection: ${JSON.stringify(projection)}`,
    'You are running inside an isolated physical clone. The canonical target root is intentionally not writable.',
    'For every read, write, command, or path named at or below canonicalTargetRoot, use the identical relative path below writableWorkspaceRoot instead.',
    'Do not attempt to write canonicalTargetRoot directly. Make all requested mutations in writableWorkspaceRoot.',
    'Report filesChanged as normalized paths relative to canonicalTargetRoot (the reportPath values), never as private absolute paths.',
  ]
}

function checkerScratchReceiptBody(boundary) {
  return {
    schemaVersion: boundary.schemaVersion,
    runId: boundary.runId,
    checkerId: boundary.checkerId,
    candidateHash: boundary.candidateHash,
    frozenCandidateRoot: boundary.frozenCandidateRoot,
    writableScratchRoot: boundary.writableScratchRoot,
    temporaryRoot: boundary.temporaryRoot,
    outputRoot: boundary.outputRoot,
    cacheRoot: boundary.cacheRoot,
  }
}

function validateCheckerScratchDirectories(boundary, expected = {}) {
  if (!boundary || boundary.schemaVersion !== 1 || typeof boundary.capability !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(boundary.capability)) {
    throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker scratch lacks its authenticated boundary record')
  }
  const roots = {}
  for (const name of ['frozenCandidateRoot', 'writableScratchRoot', 'temporaryRoot', 'outputRoot', 'cacheRoot']) {
    if (typeof boundary[name] !== 'string' || !path.isAbsolute(boundary[name])) {
      throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', `checker scratch ${name} is not an absolute directory`)
    }
    const lexical = path.resolve(boundary[name])
    const item = fs.lstatSync(lexical)
    const real = fs.realpathSync.native(lexical)
    if (!item.isDirectory() || item.isSymbolicLink() || real !== lexical) {
      throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', `checker scratch ${name} is not one physical directory`)
    }
    roots[name] = real
  }
  if (expected.runId !== undefined && boundary.runId !== expected.runId ||
      expected.checkerId !== undefined && boundary.checkerId !== expected.checkerId ||
      expected.candidateHash !== undefined && boundary.candidateHash !== expected.candidateHash ||
      expected.frozenCandidateRoot !== undefined && roots.frozenCandidateRoot !== fs.realpathSync.native(path.resolve(expected.frozenCandidateRoot))) {
    throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker scratch authority is bound to a different run, checker, exact version, or snapshot')
  }
  const scratch = roots.writableScratchRoot
  if (roots.temporaryRoot !== path.join(scratch, 'tmp') ||
      roots.outputRoot !== path.join(scratch, 'output') ||
      roots.cacheRoot !== path.join(scratch, 'cache')) {
    throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker temporary, output, and cache roots must be exact direct scratch children')
  }
  for (const other of [roots.frozenCandidateRoot, expected.realTargetPath && fs.realpathSync.native(path.resolve(expected.realTargetPath))].filter(Boolean)) {
    if (scratch === other || pathIsInside(scratch, other) || pathIsInside(other, scratch)) {
      throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker scratch must be disjoint from the frozen exact version and real target')
    }
  }
  if (expected.scratchRoot !== undefined) {
    const trustedRoot = fs.realpathSync.native(path.resolve(expected.scratchRoot))
    if (!pathIsInside(trustedRoot, scratch)) {
      throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker scratch escapes the trusted activation-private root')
    }
  }
  try { auditPrivatePermissions(scratch) } catch (error) {
    throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker scratch is not private and owner-only', { cause: error.message })
  }
  return Object.freeze(roots)
}

function codexCheckerScratchProjection(record, canonicalTargetPath, workingDirectory, verifiedBoundary) {
  if (!CHECKER_ROLES.has(record.logicalRole) || !record.checkerScratchBoundary) return []
  const boundary = verifiedBoundary || record.checkerScratchBoundary
  const frozenCandidateRoot = path.resolve(canonicalTargetPath)
  const writableScratchRoot = path.resolve(workingDirectory)
  if (path.resolve(boundary.frozenCandidateRoot) !== frozenCandidateRoot ||
      path.resolve(boundary.writableScratchRoot) !== writableScratchRoot) {
    throw new SupervisorIntegrationError(
      'CHECKER_SCRATCH_BOUNDARY_INVALID',
      'checker scratch projection differs from its authenticated launch roots',
    )
  }
  return [
    'AUTOPROMPT_CHECKER_SCRATCH_PROJECTION_V2',
    `Checker filesystem projection: ${JSON.stringify({
      schemaVersion: 2,
      frozenCandidateRoot,
      writableScratchRoot,
      temporaryRoot: boundary.temporaryRoot,
      outputRoot: boundary.outputRoot,
      cacheRoot: boundary.cacheRoot,
      currentVersionHash: record.candidateHash,
    })}`,
    'The frozen exact-version root is readable/executable and outside the writable sandbox. Never modify it.',
    'Use only the writable scratch tmp, cache, and output roots for temporary files, databases, bytecode, generated files, and test output.',
    'Execute the exact named acceptance commands and authoritative verifier when available; do not replace them with a weaker approximate check.',
    'Redirect output destinations into writableScratchRoot while reading and executing the exact frozen version.',
    'Scratch files are neither exact-version changes nor deliverables.',
  ]
}

class CodexExecAdapter {
  constructor(options = {}) {
    if (!options.runner || typeof options.runner.run !== 'function') {
      throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'Codex exec adapter requires an owned-process runner')
    }
    if (typeof options.targetPath !== 'string' || typeof options.profilePath !== 'string' ||
        typeof options.outputSchemaResolver !== 'function') {
      throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'Codex exec adapter requires target, profile, and output-schema resolver')
    }
    this.runner = options.runner
    this.executable = options.executable || 'codex'
    this.executableArgs = Array.isArray(options.executableArgs) ? [...options.executableArgs] : []
    this.environmentOverlay = options.environmentOverlay && typeof options.environmentOverlay === 'object'
      ? { ...options.environmentOverlay }
      : {}
    this.targetPath = path.resolve(options.targetPath)
    this.profilePath = path.resolve(options.profilePath)
    this.profile = options.profile || 'autoprompt'
    this.checkerProfilePath = path.resolve(options.checkerProfilePath || options.profilePath)
    this.checkerProfile = options.checkerProfile || 'autoprompt-checker'
    this.outputSchemaResolver = options.outputSchemaResolver
    this.providerSchemaRoot = options.providerSchemaRoot
      ? path.resolve(options.providerSchemaRoot)
      : null
    this.checkerScratchVerifier = typeof options.checkerScratchVerifier === 'function'
      ? options.checkerScratchVerifier : null
  }

  async launch(record) {
    if (typeof record.entryPrompt !== 'string' ||
        !record.entryPrompt.startsWith('$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\n')) {
      throw new SupervisorIntegrationError(
        'ACTIVATION_RECEIPT_INVALID',
        'external Codex launch requires the hash-verified structural $autoprompt envelope',
      )
    }
    const canonicalSchemaPath = path.resolve(this.outputSchemaResolver(record))
    const canonicalSchemaBytes = fs.readFileSync(canonicalSchemaPath)
    let canonicalSchema
    try { canonicalSchema = JSON.parse(canonicalSchemaBytes.toString('utf8')) } catch (error) {
      throw new SupervisorIntegrationError(
        'CANONICAL_OUTPUT_SCHEMA_INVALID',
        'resolved canonical child output schema is not valid JSON',
        { path: canonicalSchemaPath, cause: error.message },
      )
    }
    const schemaPath = this.providerSchemaRoot
      ? materializeCodexProviderEnvelopeSchema(this.providerSchemaRoot)
      : canonicalSchemaPath
    const executionPolicy = record.physicalExecutionPolicy
    if (!executionPolicy || executionPolicy.logicalRole !== record.logicalRole ||
        executionPolicy.physicalRole !== record.physicalRole ||
        executionPolicy.providerRole !== record.providerRole ||
        !['read-only', 'workspace-write'].includes(executionPolicy.sandboxMode)) {
      throw new SupervisorIntegrationError(
        'ROLE_POLICY_DENIED',
        'external Codex launch lacks an exact live physical-role execution policy',
      )
    }
    if (CHECKER_ROLES.has(record.logicalRole) &&
        (executionPolicy.sandboxMode !== 'read-only' || executionPolicy.canDispatch !== false ||
          !executionPolicy.resourceSets || executionPolicy.resourceSets.write.length !== 0 ||
          executionPolicy.resourceSets.exclusive.length !== 0)) {
      throw new SupervisorIntegrationError(
        'CHECKER_READ_ONLY_POLICY_REQUIRED',
        'external checker launch requires a real read-only, non-dispatch Codex policy',
      )
    }
    let verifiedCheckerScratch = null
    if (CHECKER_ROLES.has(record.logicalRole) && record.checkerScratchBoundary) {
      if (!this.checkerScratchVerifier) {
        throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker transport elevation lacks its runtime authority verifier')
      }
      verifiedCheckerScratch = this.checkerScratchVerifier(record)
    }
    const checkerScratchBoundary = verifiedCheckerScratch
    const transportSandboxMode = checkerScratchBoundary ? 'workspace-write' : executionPolicy.sandboxMode
    const common = [
      '--json', '--output-schema', schemaPath, '--strict-config',
      '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
      '--sandbox', transportSandboxMode,
    ]
    if (checkerScratchBoundary) {
      common.push(
        '--skip-git-repo-check',
        '-c', 'sandbox_workspace_write.network_access=false',
        '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
        '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
        '-c', 'sandbox_workspace_write.writable_roots=[]',
      )
    }
    if (record.assignment && record.assignment.model) common.push('-m', String(record.assignment.model))
    if (record.assignment && record.assignment.effort) {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(record.assignment.effort)) {
        throw new SupervisorIntegrationError('INVALID_EFFORT', `unsupported Codex effort: ${record.assignment.effort}`)
      }
      common.push('-c', `model_reasoning_effort="${record.assignment.effort}"`)
    }
    if (record.profileLimits) {
      common.push(
        '-c', `agents.max_depth=${record.profileLimits.maxDepth}`,
        '-c', `agents.max_concurrent_threads_per_session=${record.profileLimits.maxConcurrentThreads}`,
      )
    }
    const workingDirectory = record.workingDirectory ? path.resolve(record.workingDirectory) : this.targetPath
    const externalWriteRequested = Boolean(record.externalOperation)
    if (externalWriteRequested && (typeof record.beforeExternalWrite !== 'function' ||
        this.runner.supportsExternalWriteBoundary !== true)) {
      throw new SupervisorIntegrationError(
        'EXTERNAL_WRITE_BOUNDARY_UNAVAILABLE',
        'external writes are denied unless the owned runner can enforce the deadline at the actual write boundary',
      )
    }
    let externalWriteBoundaryConsumed = false
    const beforeExternalWrite = externalWriteRequested
      ? () => {
          const receipt = record.beforeExternalWrite()
          externalWriteBoundaryConsumed = true
          return receipt
        }
      : null
    const selectedProfile = CHECKER_ROLES.has(record.logicalRole) ? this.checkerProfile : this.profile
    const argv = record.continuationId
      ? [...this.executableArgs, 'exec', ...common, 'resume', record.continuationId, '-']
      : [...this.executableArgs, 'exec', ...common, '-p', selectedProfile, '-C', workingDirectory, '-']
    const providerTransport = this.providerSchemaRoot
      ? [
          'AUTOPROMPT_CODEX_PROVIDER_TRANSPORT_V1',
          'Return exactly one provider envelope object. Its only field is canonicalJson.',
          'canonicalJson must be a JSON string which decodes to the complete canonical output object.',
          'The decoded object remains subject to all canonical AutoPrompt validation after transport decoding.',
          `Canonical output schema: ${canonicalSchemaBytes.toString('utf8')}`,
        ]
      : []
    const workspaceProjection = codexPrivateWorkspaceProjection(
      record,
      record.canonicalTargetPath || this.targetPath,
      workingDirectory,
    )
    const checkerScratchProjection = codexCheckerScratchProjection(
      record,
      record.canonicalTargetPath || this.targetPath,
      workingDirectory,
      checkerScratchBoundary,
    )
    const workerCompletionBoundary = record.logicalRole === 'worker'
      ? [
          'AUTOPROMPT_WORKER_COMPLETION_BOUNDARY_V1',
          'Judge allAssignedItemsPass and every successItems status only against this worker assignment and its author-side checks.',
          'A later independent reviewer check is owned by the supervisor, is not a blocked worker success item, and must not make allAssignedItemsPass false.',
          'When the owned implementation and author-side checks pass, report allAssignedItemsPass=true so the supervisor can freeze and dispatch the separate checker.',
        ]
      : []
    const input = [
      record.entryPrompt,
      'AUTOPROMPT_EXTERNAL_CHILD_V1',
      `role=${record.logicalRole}`,
      `physical_role=${record.physicalRole}`,
      `provider_role=${record.providerRole}`,
      `physical_role_policy=${executionPolicy.policyId}@${executionPolicy.policyVersion}`,
      ...providerTransport,
      record.dispatch.brief,
      `Canonical context envelope: ${JSON.stringify(record.dispatch)}`,
      record.canonicalAssignment ? `Canonical assignment: ${JSON.stringify(record.canonicalAssignment)}` : '',
      `Request pointer: ${JSON.stringify(record.dispatch.requestPointer)}`,
      ...workerCompletionBoundary,
      ...workspaceProjection,
      ...checkerScratchProjection,
      '',
    ].join('\n')
    let sawStreamedOutput = false
    const rawOutputHash = crypto.createHash('sha256')
    const streamAccumulator = createCodexJsonlAccumulator()
    let typedTerminal = null
    let stopPromise = null
    let streamError = null
    let streamedUsage = { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 }
    let terminalReceiptPersisted = false
    let committedTerminalResult = null
    let firstProductSignalPersisted = false
    const distinctTerminalCandidates = parsed => {
      const candidates = new Map()
      const outputs = Array.isArray(parsed && parsed.messageOutputs)
        ? parsed.messageOutputs : [parsed && parsed.output]
      for (const rawOutput of outputs) {
        if (!rawOutput || typeof rawOutput !== 'object') continue
        let output = rawOutput
        if (this.providerSchemaRoot && typeof output.canonicalJson === 'string') {
          try { output = decodeCodexProviderEnvelope(output) } catch { continue }
        }
        if (!validateJsonSchema(canonicalSchema, output).valid) continue
        candidates.set(hashText(stableStringify(output)), output)
      }
      return candidates
    }
    const assembledResult = (parsed, completionRequested, decodedOutput = null) => {
      const output = decodedOutput || parsed.output || {}
      return {
        ...output,
        candidateHash: record.candidateHash || output.candidateHash || null,
        contextId: record.continuationId || parsed.sessionId,
        events: parsed.events,
        usage: parsed.usage,
        usageStreamed: typeof record.onUsageDelta === 'function',
        evidenceHashes: Array.isArray(output.evidenceHashes) ? output.evidenceHashes : [],
        recommendation: output.recommendation || (record.logicalRole === 'route-analyst' ? output : null),
        completionRequested,
      }
    }
    const stop = (reason, terminalStatus = 'FAILED') => {
      if (!stopPromise && typeof this.runner.stop === 'function') {
        stopPromise = Promise.resolve(this.runner.stop({ reason, terminalStatus, sessionId: record.sessionId }))
      }
    }
    const commitTerminal = (output, snapshot) => {
      typedTerminal = output.outcome || output.code || output.reportType
      committedTerminalResult = Object.freeze(assembledResult(snapshot, true, output))
      if (typeof record.onTerminalResult === 'function') {
        record.onTerminalResult(committedTerminalResult, {
          rawOutputHash: rawOutputHash.copy().digest('hex'),
          eventStreamHash: snapshot.eventStreamHash,
          sessionId: record.continuationId || snapshot.sessionId,
        })
        terminalReceiptPersisted = true
      }
      stop(`typed terminal ${typedTerminal}`, 'DONE')
    }
    const onStdoutLine = line => {
      const normalizedLine = `${String(line).replace(/\r?\n$/, '')}\n`
      sawStreamedOutput = true
      rawOutputHash.update(normalizedLine)
      let event
      try { event = streamAccumulator.push(String(line).trim()) } catch (error) {
        streamError = error
        stop(error.code)
        return
      }
      if (event && typeof record.onEvent === 'function') {
        try { record.onEvent(event, String(line)) } catch (error) {
          streamError = error
          stop(error.code || 'TRANSCRIPT_WRITE_FAILED')
          return
        }
      }
      if (event && !firstProductSignalPersisted && typeof record.onFirstProductSignal === 'function') {
        const item = event.type === 'item.completed' && event.item && typeof event.item === 'object'
          ? event.item : null
        const failedCommand = item && item.type === 'command_execution' &&
          (Number(item.exit_code ?? item.exitCode) !== 0 || item.status === 'failed')
        const completedEdit = item && ['file_change', 'file_edit', 'apply_patch'].includes(item.type) &&
          !['failed', 'cancelled'].includes(item.status)
        if (failedCommand || completedEdit) {
          try {
            record.onFirstProductSignal({
              kind: completedEdit ? 'PRODUCT_EDIT' : 'RED',
              evidenceHash: hashText(stableStringify(event)),
            })
            firstProductSignalPersisted = true
          } catch (error) {
            streamError = error
            stop(error.code || 'FIRST_PRODUCT_SIGNAL_INVALID')
            return
          }
        }
      }
      if (event && event.type === 'thread.started' && typeof record.onSessionIdentified === 'function') {
        const identified = event.thread_id || event.threadId
        if (identified) {
          try {
            record.onSessionIdentified(String(identified), {
              event,
              raw: String(line),
              occurredAt: new Date().toISOString(),
            })
          } catch (error) {
            streamError = error
            stop(error.code || 'SESSION_CHECKPOINT_FAILED')
            return
          }
        }
      }
      let cumulative
      try { cumulative = codexUsageFromEvent(event) } catch (error) {
        streamError = error
        stop(error.code)
        return
      }
      if (cumulative && typeof record.onUsageDelta === 'function' && !streamError) {
        const delta = {}
        for (const field of Object.keys(streamedUsage)) {
          if (!Number.isFinite(cumulative[field]) || cumulative[field] < streamedUsage[field]) {
            streamError = new SupervisorIntegrationError(
              'CODEX_USAGE_INVALID',
              `Codex streamed ${field} usage regressed or became invalid`,
            )
            stop(streamError.code)
            return
          }
          delta[field] = cumulative[field] - streamedUsage[field]
        }
        streamedUsage = cumulative
        try {
          const verdict = record.onUsageDelta(delta, cumulative)
          if (!verdict || verdict.continue !== true) {
            streamError = new SupervisorIntegrationError(
              'BUDGET_EXHAUSTED',
              'scheduler denied continued Codex token usage',
              { verdict },
            )
            streamError.usage = cumulative
            stop(streamError.code)
            return
          }
        } catch (error) {
          streamError = error
          streamError.usage = cumulative
          stop(error.code || 'BUDGET_EXHAUSTED')
          return
        }
      }
      const current = streamAccumulator.watermark()
      if (typedTerminal) return
      let currentOutput = current.output
      if (current.usage) {
        if (current.messageOutputsOverflow) {
          streamError = new SupervisorIntegrationError(
            'CODEX_TERMINAL_CANDIDATE_OVERFLOW',
            'one Codex turn exceeded the bounded terminal-output history',
          )
          stop(streamError.code)
          return
        }
        const candidates = distinctTerminalCandidates(current)
        if (candidates.size > 1) {
          streamError = new SupervisorIntegrationError(
            'CODEX_MULTIPLE_TERMINAL_OUTPUTS',
            'one Codex turn emitted conflicting schema-valid terminal outputs',
            { candidateHashes: [...candidates.keys()].sort() },
          )
          stop(streamError.code)
          return
        }
        if (candidates.size === 1) currentOutput = candidates.values().next().value
        else if (this.providerSchemaRoot && currentOutput &&
            typeof currentOutput.canonicalJson === 'string') {
          try { currentOutput = decodeCodexProviderEnvelope(currentOutput) } catch (error) {
            streamError = error
            stop(error.code)
            return
          }
        }
      }
      const schemaValidation = current.usage && currentOutput
        ? validateJsonSchema(canonicalSchema, currentOutput) : { valid: false }
      if (!typedTerminal && current.usage && schemaValidation.valid && typedChildOutputReady(currentOutput, record)) {
        const terminalSnapshot = streamAccumulator.snapshot()
        try { commitTerminal(currentOutput, terminalSnapshot) } catch (error) {
          streamError = error
          stop(error.code || 'TERMINAL_RECEIPT_FAILED')
        }
        return
      }
      // A completed Codex turn is a hard transport boundary.  Waiting for the
      // process to exit after a malformed structured result can deadlock when
      // the CLI (or one of its descendants) stays alive.  Persist a canonical
      // runtime failure and drain immediately; PRE_ROUTE retains its one
      // correction opportunity, but its completed child is drained as well.
      if (!typedTerminal && current.usage) {
        const schemaInvalidCanEnterCorrection = Boolean(currentOutput) &&
          (record.logicalRole === 'route-analyst' ||
            (record.logicalRole === 'run-owner' && record.route === 'PRE_ROUTE'))
        if (schemaInvalidCanEnterCorrection) {
          stop('completed turn requires canonical correction')
          return
        }
        const terminalSnapshot = streamAccumulator.snapshot()
        const reconstructed = reconstructTypedExitZeroResult(record, terminalSnapshot)
        try { commitTerminal(reconstructed, terminalSnapshot) } catch (error) {
          streamError = error
          stop(error.code || 'TERMINAL_RECEIPT_FAILED')
        }
      }
    }
    const execution = await this.runner.run({
      executable: this.executable,
      argv,
      cwd: workingDirectory,
      env: { ...record.environment, ...this.environmentOverlay },
      stdin: input,
      shell: false,
      sessionId: record.sessionId,
      reservationId: record.reservationId,
      onStdoutLine,
      beforeExternalWrite,
    })
    if (!execution || execution.processOwned !== true || execution.exactArgv !== true) {
      throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'Codex runner did not prove owned process and exact argv')
    }
    if (externalWriteRequested && !externalWriteBoundaryConsumed) {
      throw new SupervisorIntegrationError(
        'EXTERNAL_WRITE_BOUNDARY_REQUIRED',
        'external operation returned without invoking its enforced deadline boundary',
      )
    }
    const stopped = stopPromise ? await stopPromise : null
    if (typedTerminal && (!stopped || stopped.drained !== true) && execution.drained !== true) {
      throw new SupervisorIntegrationError('PROCESS_DRAIN_TIMEOUT', 'typed terminal child did not prove bounded descendant drain')
    }
    const parsed = sawStreamedOutput
      ? streamAccumulator.snapshot()
      : parseCodexJsonl(String(execution.stdout || ''))
    if (streamError) throw streamError
    if (execution.status !== 0) {
      throw new SupervisorIntegrationError('CODEX_CHILD_FAILED', `Codex child exited ${execution.status}`, {
        events: parsed.events, stderr: String(execution.stderr || ''),
      })
    }
    if (!record.continuationId && !parsed.sessionId) {
      throw new SupervisorIntegrationError('CODEX_SESSION_ID_MISSING', 'fresh Codex JSONL did not provide a stable session id')
    }
    if (!parsed.usage) {
      throw new SupervisorIntegrationError('CODEX_USAGE_INCOMPLETE', 'Codex child ended without all four usage categories')
    }
    if (committedTerminalResult) return committedTerminalResult
    if (parsed.messageOutputsOverflow) {
      throw new SupervisorIntegrationError(
        'CODEX_TERMINAL_CANDIDATE_OVERFLOW',
        'one Codex turn exceeded the bounded terminal-output history',
      )
    }
    const terminalCandidates = distinctTerminalCandidates(parsed)
    if (terminalCandidates.size > 1) {
      throw new SupervisorIntegrationError(
        'CODEX_MULTIPLE_TERMINAL_OUTPUTS',
        'one Codex turn emitted conflicting schema-valid terminal outputs',
        { candidateHashes: [...terminalCandidates.keys()].sort() },
      )
    }
    if (terminalCandidates.size === 1) parsed.output = terminalCandidates.values().next().value
    else if (this.providerSchemaRoot) parsed.output = decodeCodexProviderEnvelope(parsed.output)
    const finalSchemaValidation = validateJsonSchema(canonicalSchema, parsed.output)
    const schemaInvalidCanEnterCorrection = record.logicalRole === 'route-analyst' ||
      (record.logicalRole === 'run-owner' && record.route === 'PRE_ROUTE')
    if ((!finalSchemaValidation.valid && !schemaInvalidCanEnterCorrection) ||
        !typedChildOutputReady(parsed.output, record)) {
      parsed.output = reconstructTypedExitZeroResult(record, parsed)
    }
    const returned = assembledResult(parsed, Boolean(typedTerminal))
    if (typeof record.onTerminalResult === 'function' && !terminalReceiptPersisted) {
      record.onTerminalResult(returned, {
        rawOutputHash: String(execution.stdout || '').trim()
          ? hashText(execution.stdout) : rawOutputHash.copy().digest('hex'),
        eventStreamHash: parsed.eventStreamHash,
        sessionId: record.continuationId || parsed.sessionId,
      })
    }
    return returned
  }
}

class OwnedCodexProxyRunner {
  constructor(options = {}) {
    if (!options.processOwner || typeof options.processOwner.launch !== 'function' ||
        typeof options.processOwner.cancelGroup !== 'function' ||
        typeof options.controlRoot !== 'string' || typeof options.targetKey !== 'string') {
      throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'owned Codex proxy runner requires process ownership and registered control paths')
    }
    this.processOwner = options.processOwner
    this.controlRoot = path.resolve(options.controlRoot)
    this.targetKey = options.targetKey
    this.activationId = options.activationId || `standalone:${hashText(this.controlRoot)}`
    this.generationId = options.generationId === undefined ? 1 : options.generationId
    if (typeof this.activationId !== 'string' || !this.activationId ||
        !Number.isSafeInteger(this.generationId) || this.generationId < 1) {
      throw new SupervisorIntegrationError(
        'CODEX_PROXY_BINDING_INVALID',
        'owned Codex proxy runner requires an activation and positive generation binding',
      )
    }
    this.controlSequence = 0
    this.pollMs = options.pollMs || 20
    this.sessions = new Map()
  }

  async run(spec) {
    // A resumed model keeps its canonical accounting session but must receive
    // a fresh owned-process reservation.  Key transport files by both so a
    // crash continuation cannot collide with the prior generation's durable
    // proxy directory.
    const sessionRoot = path.join(this.controlRoot, hashText(`${spec.sessionId}\0${spec.reservationId}`))
    fs.mkdirSync(sessionRoot, { recursive: false, mode: 0o700 })
    const requestPath = path.join(sessionRoot, 'request.json')
    const stdoutPath = path.join(sessionRoot, 'stdout.jsonl')
    const stderrPath = path.join(sessionRoot, 'stderr.log')
    const statusPath = path.join(sessionRoot, 'status.json')
    const argvHash = hashText(JSON.stringify({ executable: spec.executable, argv: spec.argv }))
    const sequence = ++this.controlSequence
    fs.writeFileSync(requestPath, `${JSON.stringify({
      schemaVersion: 2,
      activationId: this.activationId,
      generationId: this.generationId,
      sequence,
      executable: spec.executable,
      argv: spec.argv,
      argvHash,
      cwd: spec.cwd,
      stdin: spec.stdin,
      stdoutPath,
      stderrPath,
      statusPath,
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const owned = await this.processOwner.launch({
      executable: process.execPath,
      argv: [__filename, '--owned-codex-proxy', requestPath],
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      sessionId: spec.sessionId,
      reservationId: spec.reservationId,
      targetKey: this.targetKey,
      forWork: false,
    })
    const session = { ...owned, sessionRoot, statusPath, stopped: false }
    this.sessions.set(spec.sessionId, session)
    let stdout = ''
    let offset = 0
    let partial = ''
    let stdoutDescriptor
    const stdoutDecoder = new StringDecoder('utf8')
    let status = null
    let terminalRecord = null
    try {
      while (!status && !session.stopped) {
        if (fs.existsSync(stdoutPath)) {
          if (stdoutDescriptor === undefined) stdoutDescriptor = fs.openSync(stdoutPath, 'r')
          const size = fs.fstatSync(stdoutDescriptor).size
          if (size < offset) {
            throw new SupervisorIntegrationError('CODEX_EVENT_STREAM_INVALID', 'owned Codex JSONL tail was truncated')
          }
          while (offset < size) {
            const length = Math.min(64 * 1024, size - offset)
            const bytes = Buffer.allocUnsafe(length)
            const read = fs.readSync(stdoutDescriptor, bytes, 0, length, offset)
            if (read <= 0) break
            offset += read
            partial += stdoutDecoder.write(bytes.subarray(0, read))
          }
          const lines = partial.split(/\r?\n/)
          partial = lines.pop()
          for (const line of lines) {
            stdout += `${line}\n`
            if (line && typeof spec.onStdoutLine === 'function') spec.onStdoutLine(line)
          }
        }
        if (fs.existsSync(statusPath)) status = readRegularJson(statusPath, 'owned Codex proxy status').parsed
        if (!status && !session.stopped) await new Promise(resolve => setTimeout(resolve, this.pollMs))
      }
      partial += stdoutDecoder.end()
      if (partial) {
        stdout += partial
        if (typeof spec.onStdoutLine === 'function') spec.onStdoutLine(partial)
      }
      if (!session.stopped) {
        if (!status || status.schemaVersion !== 2 || status.activationId !== this.activationId ||
            status.generationId !== this.generationId || status.sequence !== sequence ||
            status.argvHash !== argvHash ||
            !Number.isSafeInteger(status.codexPid) || status.codexPid < 1) {
          throw new SupervisorIntegrationError('CODEX_PROXY_STATUS_INVALID', 'owned Codex proxy returned a foreign status')
        }
        terminalRecord = await this.processOwner.observeRootExit(owned.ownershipId, {
          code: status.code,
          signal: status.signal,
          terminalEnvelope: status.terminalEnvelope,
        })
      }
      if (session.stopPromise) {
        const stopped = await session.stopPromise
        terminalRecord = stopped && stopped.terminal
      }
      if (!terminalRecord || terminalRecord.ownershipId !== owned.ownershipId ||
          terminalRecord.groupIdentity !== owned.groupIdentity ||
          !['DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED', 'LOST'].includes(terminalRecord.status)) {
        throw new SupervisorIntegrationError(
          'PROCESS_DRAIN_TIMEOUT',
          'owned Codex proxy lacks the exact terminal group-drain receipt',
        )
      }
      return {
        status: session.stopped ? 0 : status.code,
        signal: session.stopped ? 'OWNED_STOP' : status.signal,
        stdout,
        stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '',
        processOwned: true,
        exactArgv: true,
        drained: true,
        codexPid: status && status.codexPid,
      }
    } finally {
      if (stdoutDescriptor !== undefined) fs.closeSync(stdoutDescriptor)
      this.sessions.delete(spec.sessionId)
    }
  }

  async stop(options = {}) {
    const session = this.sessions.get(options.sessionId)
    if (!session) return { drained: true, alreadyTerminal: true }
    if (session.stopPromise) return session.stopPromise
    session.stopped = true
    session.stopPromise = (async () => {
      const terminal = await this.processOwner.cancelGroup(session.ownershipId, {
        reason: options.reason || 'Codex proxy stop',
        graceMs: 500,
        killMs: 1000,
        terminalStatus: options.terminalStatus || 'FAILED',
      })
      if (!terminal || terminal.ownershipId !== session.ownershipId ||
          terminal.groupIdentity !== session.groupIdentity) {
        throw new SupervisorIntegrationError(
          'PROCESS_DRAIN_TIMEOUT',
          'Codex proxy cancellation did not return its exact terminal group receipt',
        )
      }
      return { drained: true, terminal }
    })()
    return session.stopPromise
  }
}

function runOwnedCodexProxy(requestPath) {
  const request = readRegularJson(requestPath, 'owned Codex proxy request').parsed
  if (request.schemaVersion !== 2 || typeof request.activationId !== 'string' || !request.activationId ||
      !Number.isSafeInteger(request.generationId) || request.generationId < 1 ||
      !Number.isSafeInteger(request.sequence) || request.sequence < 1 ||
      typeof request.executable !== 'string' ||
      !Array.isArray(request.argv) || request.argv.some(value => typeof value !== 'string') ||
      typeof request.cwd !== 'string' || typeof request.stdin !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.argvHash || '')) {
    throw new SupervisorIntegrationError('CODEX_PROXY_REQUEST_INVALID', 'owned Codex proxy request is invalid')
  }
  for (const outputPath of [request.stdoutPath, request.stderrPath, request.statusPath]) {
    if (path.dirname(path.resolve(outputPath)) !== path.dirname(path.resolve(requestPath))) {
      throw new SupervisorIntegrationError('CODEX_PROXY_REQUEST_INVALID', 'owned Codex proxy output escaped its control directory')
    }
  }
  const stdoutHandle = fs.openSync(request.stdoutPath, 'wx', 0o600)
  const stderrHandle = fs.openSync(request.stderrPath, 'wx', 0o600)
  const child = childProcess.spawn(request.executable, request.argv, {
    cwd: request.cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', bytes => fs.writeSync(stdoutHandle, bytes))
  child.stderr.on('data', bytes => fs.writeSync(stderrHandle, bytes))
  let settled = false
  const finish = (code, signal, error = null) => {
    if (settled) return
    settled = true
    for (const handle of [stdoutHandle, stderrHandle]) {
      try { fs.fsyncSync(handle) } catch {}
      try { fs.closeSync(handle) } catch {}
    }
    fs.writeFileSync(request.statusPath, `${JSON.stringify({
      schemaVersion: 2,
      activationId: request.activationId,
      generationId: request.generationId,
      sequence: request.sequence,
      argvHash: request.argvHash,
      codexPid: child.pid || 1,
      code: code === null ? 1 : code,
      signal: signal || null,
      error: error ? error.message : null,
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }
  child.stdin.on('error', error => {
    if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error && error.code)) finish(1, null, error)
  })
  child.once('error', error => finish(1, null, error))
  child.once('exit', (code, signal) => finish(code, signal))
  child.stdin.end(request.stdin)
}

async function withTimeout(operation, milliseconds, timerApi, code, onTimeout) {
  if (milliseconds === Number.POSITIVE_INFINITY) {
    return Promise.resolve().then(operation)
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new SupervisorIntegrationError(code, `${code} elapsed`)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = timerApi.setTimeout(async () => {
      if (settled) return
      settled = true
      try { if (onTimeout) await onTimeout() } catch {}
      reject(new SupervisorIntegrationError(code, `${code} elapsed`))
    }, milliseconds)
    if (timer && typeof timer.unref === 'function') timer.unref()
    Promise.resolve().then(operation).then(
      value => {
        if (settled) return
        settled = true
        timerApi.clearTimeout(timer)
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        timerApi.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function persistTerminalSession(controller, sessionId, details, primaryError = null) {
  const persistenceFailures = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return controller.endSession(sessionId, details)
    } catch (error) {
      persistenceFailures.push({ attempt, ...serializeError(error) })
    }
  }
  if (primaryError && (typeof primaryError === 'object' || typeof primaryError === 'function')) {
    primaryError.terminalPersistenceFailure = Object.freeze({
      code: 'SESSION_TERMINAL_PERSIST_FAILED',
      attempts: Object.freeze(persistenceFailures.map(item => Object.freeze(item))),
    })
    throw primaryError
  }
  throw new SupervisorIntegrationError(
    'SESSION_TERMINAL_PERSIST_FAILED',
    'terminal session persistence failed after its bounded retry',
    { sessionId, persistenceFailures },
  )
}

function validateRuntimeDependencies(options) {
  const requiredFunctions = [
    ['recordFactory', options.recordFactory],
    ['requestPointerFactory', options.requestPointerFactory],
    ['launcher', options.launcher],
    ['finalizerFactory', options.finalizerFactory],
    ['decideRoute', options.decideRoute],
  ]
  for (const [name, value] of requiredFunctions) {
    if (typeof value !== 'function') {
      throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', `supervisor dependency ${name} is required`)
    }
  }
  if (!options.missionLock || typeof options.missionLock.acquire !== 'function') {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'a canonical original-request lock is required')
  }
  if (!options.budgetController || typeof options.budgetController.assertAvailable !== 'function') {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'a run-global budget controller is required')
  }
  if (!options.processOwner || typeof options.processOwner.cancelAll !== 'function' ||
      typeof options.processOwner.assertDrained !== 'function') {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'a descendant-owning process controller is required')
  }
  if (typeof options.capabilityVerifier !== 'function') {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'a host capability verifier is required before every model launch')
  }
  if (options.mutationEnforcer && typeof options.workerWorkspaceFactory !== 'function') {
    throw new SupervisorIntegrationError(
      'PROVIDER_UNSUPPORTED',
      'worker mutation enforcement requires a private worker workspace factory',
    )
  }
  if (options.providerCapabilities !== null) validateProviderCapabilities(options.providerCapabilities)
}

function validateResumedBudget(controller, previous, expectedGeneration) {
  if (!previous || typeof previous !== 'object') {
    throw new SupervisorIntegrationError('BUDGET_RESUME_REQUIRED', 'a resumed activation requires its prior budget snapshot')
  }
  const current = controller.snapshot()
  if (typeof controller.crashRetryVerdict === 'function') {
    const retry = controller.crashRetryVerdict()
    if (retry.exhausted) {
      throw new SupervisorIntegrationError(
        retry.code,
        'equivalent crash retries exhausted before resume admission',
        { crashRetry: retry },
      )
    }
  }
  for (const field of ['consumedWallMs', 'tokensUsed', 'sessionsStarted', 'launches']) {
    if (!Number.isSafeInteger(current[field]) || !Number.isSafeInteger(previous[field]) || current[field] < previous[field]) {
      throw new SupervisorIntegrationError('BUDGET_RESET_DETECTED', `resumed budget regressed ${field}`, {
        previous: previous[field], current: current[field],
      })
    }
  }
  if (current.generation !== expectedGeneration - 1) {
    throw new SupervisorIntegrationError('BUDGET_RESET_DETECTED', 'resumed budget generation is not the predecessor generation', {
      expected: expectedGeneration - 1,
      current: current.generation,
    })
  }
  const next = controller.beginGeneration({ reason: 'same activation resume' })
  if (next.generation !== expectedGeneration) {
    throw new SupervisorIntegrationError('BUDGET_RESET_DETECTED', 'budget generation did not advance exactly once')
  }
  return next
}

const TRUSTED_TEST_EXECUTION_RECORD = Symbol('trustedTestExecutionRecord')
const TEST_ARGUMENT_SHELL_TOKENS = /[\r\n|&;<>`]/u
const TEST_CREDENTIAL_PATH = /(?:^|[\\/])(?:auth\.json|\.ssh|\.aws|\.azure|\.npmrc|\.netrc|\.git-credentials|credentials)(?:$|[\\/])/iu
const TEST_NETWORK_ARGUMENT = /^(?:https?|ftp|ssh|git):\/\/|^\\\\/iu
const TEST_NETWORK_EXECUTABLES = new Set([
  'curl', 'curl.exe', 'wget', 'wget.exe', 'ssh', 'ssh.exe', 'scp', 'scp.exe',
  'sftp', 'sftp.exe', 'ftp', 'ftp.exe', 'nc', 'nc.exe', 'ncat', 'ncat.exe',
])
const NODE_DYNAMIC_CODE_ARGUMENTS = new Set([
  '-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--experimental-loader',
])

function trustedTestDeclarationError(message, details = {}) {
  throw new SupervisorIntegrationError('TRUSTED_TEST_DECLARATION_INVALID', message, details)
}

function resolveTrustedTestDeclarations(declarations = {}, options = {}) {
  const repository = path.resolve(options.repository || options.cwd || '')
  if (!repository || !fs.existsSync(repository) || !fs.statSync(repository).isDirectory()) {
    trustedTestDeclarationError('trusted tests require an existing repository root')
  }
  if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations) ||
      Object.keys(declarations).some(key => !['controlPlane', 'repository'].includes(key))) {
    trustedTestDeclarationError('trusted tests must come from explicit controlPlane or repository declarations')
  }
  const sources = ['controlPlane', 'repository'].flatMap(authority => {
    const entries = declarations[authority] === undefined ? [] : declarations[authority]
    if (!Array.isArray(entries)) trustedTestDeclarationError(`${authority} test declarations must be an array`)
    return entries.map(declaration => ({ authority, declaration }))
  })
  const ids = new Set()
  const records = sources.map(({ authority, declaration }, index) => {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration) ||
        Object.hasOwn(declaration, 'command') || Object.hasOwn(declaration, 'shell') ||
        typeof declaration.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(declaration.id) ||
        typeof declaration.executable !== 'string' || !declaration.executable ||
        !Array.isArray(declaration.argv) || declaration.argv.length > 64 ||
        declaration.argv.some(argument => typeof argument !== 'string' || !argument || argument.length > 4096)) {
      trustedTestDeclarationError(`trusted test declaration ${index + 1} must contain only id, executable, argv, and optional cwd`)
    }
    if (ids.has(declaration.id)) trustedTestDeclarationError(`trusted test id is duplicated: ${declaration.id}`)
    ids.add(declaration.id)
    const cwd = path.resolve(repository, declaration.cwd || '.')
    if (!pathIsInside(repository, cwd) || !fs.existsSync(cwd)) {
      trustedTestDeclarationError(`trusted test cwd escapes or is absent: ${declaration.cwd || '.'}`)
    }
    const cwdStat = fs.lstatSync(cwd)
    if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink() || !pathIsInside(repository, fs.realpathSync(cwd))) {
      trustedTestDeclarationError(`trusted test cwd is not an owned repository directory: ${declaration.cwd || '.'}`)
    }
    const executable = path.isAbsolute(declaration.executable)
      ? path.resolve(declaration.executable)
      : path.resolve(repository, declaration.executable)
    if (executable !== path.resolve(process.execPath) && !pathIsInside(repository, executable)) {
      trustedTestDeclarationError(`trusted test executable is outside its repository: ${declaration.executable}`)
    }
    if (!fs.existsSync(executable)) trustedTestDeclarationError(`trusted test executable is absent: ${declaration.executable}`)
    const executableStat = fs.lstatSync(executable)
    if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
      trustedTestDeclarationError(`trusted test executable is not a regular file: ${declaration.executable}`)
    }
    if (TEST_NETWORK_EXECUTABLES.has(path.basename(executable).toLowerCase())) {
      trustedTestDeclarationError(`network-capable test executable is forbidden: ${declaration.executable}`)
    }
    for (const argument of declaration.argv) {
      if (argument.includes('\0') || TEST_ARGUMENT_SHELL_TOKENS.test(argument) ||
          TEST_CREDENTIAL_PATH.test(argument.replace(/\\/gu, '/')) || TEST_NETWORK_ARGUMENT.test(argument) ||
          NODE_DYNAMIC_CODE_ARGUMENTS.has(argument.toLowerCase())) {
        trustedTestDeclarationError(`trusted test ${declaration.id} contains a forbidden argument`, { argument })
      }
      const normalizedSegments = argument.replace(/\\/gu, '/').split('/')
      if (normalizedSegments.includes('..')) {
        trustedTestDeclarationError(`trusted test ${declaration.id} contains a path escape`, { argument })
      }
      if (path.isAbsolute(argument) && !pathIsInside(cwd, path.resolve(argument))) {
        trustedTestDeclarationError(`trusted test ${declaration.id} contains an absolute path outside its cwd`, { argument })
      }
    }
    return Object.freeze({
      id: declaration.id,
      authority,
      executable,
      argv: Object.freeze(declaration.argv.slice()),
      cwd,
      shell: false,
      [TRUSTED_TEST_EXECUTION_RECORD]: true,
    })
  })
  return Object.freeze(records)
}

function createMinimalTestEnvironment(baseEnvironment = {}, options = {}) {
  const isolationRoot = path.resolve(options.isolationRoot || '')
  if (!isolationRoot || isolationRoot === path.parse(isolationRoot).root) {
    throw new SupervisorIntegrationError(
      'TRUSTED_TEST_ENVIRONMENT_INVALID',
      'trusted test environment requires a narrow isolated home root',
    )
  }
  fs.mkdirSync(isolationRoot, { recursive: true, mode: 0o700 })
  const tempRoot = path.join(isolationRoot, 'tmp')
  const codexRoot = path.join(isolationRoot, 'codex-home')
  const configRoot = path.join(isolationRoot, 'config')
  for (const directory of [tempRoot, codexRoot, configRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const environment = {
    CI: '1',
    NO_COLOR: '1',
    HOME: isolationRoot,
    USERPROFILE: isolationRoot,
    CODEX_HOME: codexRoot,
    XDG_CONFIG_HOME: configRoot,
    XDG_CACHE_HOME: path.join(isolationRoot, 'cache'),
    TMPDIR: tempRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
  }
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']) {
    if (typeof baseEnvironment[name] === 'string' && baseEnvironment[name] && !baseEnvironment[name].includes('\0')) {
      environment[name] = baseEnvironment[name]
    }
  }
  if (process.platform === 'win32') {
    const parsed = path.parse(isolationRoot)
    environment.HOMEDRIVE = parsed.root.replace(/[\\/]$/u, '')
    environment.HOMEPATH = isolationRoot.slice(parsed.root.length - 1)
  }
  return Object.freeze(environment)
}

async function executeExistingTestBaseline(declaredTests, options = {}) {
  const runner = options.runner
  if (typeof runner !== 'function') {
    throw new SupervisorIntegrationError('EXISTING_TEST_BASELINE_INVALID', 'existing-test baseline requires an executable runner')
  }
  const results = []
  for (const test of declaredTests || []) {
    if (!test || test[TRUSTED_TEST_EXECUTION_RECORD] !== true || test.shell !== false) {
      throw new SupervisorIntegrationError(
        'EXISTING_TEST_BASELINE_INVALID',
        'existing tests must be resolved from trusted executable+argv declarations before execution',
      )
    }
    const executed = await runner({
      id: test.id,
      executable: test.executable,
      argv: test.argv.slice(),
      cwd: test.cwd,
      environment: options.environment,
      shell: false,
    })
    const exitCode = Number(executed && (executed.exitCode ?? executed.status))
    if (!Number.isSafeInteger(exitCode)) {
      throw new SupervisorIntegrationError('EXISTING_TEST_BASELINE_INVALID', `existing test ${test.id} did not return an exit code`)
    }
    if (executed.processOwned !== true || executed.exactArgv !== true || executed.drained !== true) {
      throw new SupervisorIntegrationError(
        'EXISTING_TEST_BASELINE_INVALID',
        `existing test ${test.id} lacks owned shell-free process evidence`,
      )
    }
    const output = `${String(executed.stdout || '')}\n${String(executed.stderr || '')}`
    results.push(Object.freeze({
      id: test.id,
      command: JSON.stringify([test.executable, ...test.argv]),
      executable: test.executable,
      argv: test.argv.slice(),
      authority: test.authority,
      exitCode,
      status: exitCode === 0 ? 'PASS' : 'FAIL', outputHash: hashText(output),
    }))
  }
  return Object.freeze(results)
}

function createDefaultExternalOperation(input = {}) {
  if (input.request && input.request.externalOperation) return Object.freeze({ ...input.request.externalOperation })
  const externalWrites = input.assignment && Array.isArray(input.assignment.resources)
    ? input.assignment.resources.filter(resource => resource.kind === 'external-system' && resource.access !== 'read')
    : []
  if (externalWrites.length === 0) return null
  return Object.freeze({
    operationId: `external:${hashText(stableStringify({
      runId: input.runId, generation: input.generation,
      workItemId: input.request.workItemId, resources: externalWrites,
    }))}`,
    status: 'PREPARED', workItemId: input.request.workItemId,
    resourceIds: externalWrites.map(resource => resource.identity).sort(),
  })
}

function reconcileExternalOperationTimeout(operation, operations) {
  const partial = [...operations.values()]
  return Object.freeze({
    ...operation,
    status: 'RECONCILED_TIMEOUT',
    reconciledPartialStateHash: hashText(stableStringify(partial)),
  })
}

function applyProductionRuntimeTransition(authority, payload = {}) {
  const { stateStore, capability, budgetController } = authority
  const { eventId, nextState, details = {} } = payload
  if (eventId === 'ALL_WORK_JOINED' || eventId === 'REPAIR_READY') {
    const currentState = stateStore.load()
    let retryState = currentState.retryState || {}
    if (eventId === 'REPAIR_READY') {
      const pending = retryState.pendingImplementationRepair
      if (!pending || pending.repairWorkItemId !== details.repairWorkItemId ||
          pending.repairAttempt !== details.repairAttempt ||
          pending.rejectedCandidateHash !== details.priorCandidateHash) {
        throw new SupervisorIntegrationError(
          'REPAIR_RECOVERY_INVALID',
          'repaired exact version does not close its exact durable pending repair',
        )
      }
      retryState = { ...retryState }
      delete retryState.pendingImplementationRepair
    }
    const candidateEvidenceId = 'frozen-candidate-evidence'
    const requiredVerdictIds = Array.isArray(details.requiredVerdictIds) && details.requiredVerdictIds.length
      ? [...details.requiredVerdictIds] : ['reviewer-verdict', 'tester-verdict']
    if (![1, 2].includes(details.checkerCount || requiredVerdictIds.length) ||
        requiredVerdictIds.length !== (details.checkerCount || requiredVerdictIds.length) ||
        requiredVerdictIds.some(id => !['reviewer-verdict', 'tester-verdict'].includes(id)) ||
        new Set(requiredVerdictIds).size !== requiredVerdictIds.length) {
      throw new SupervisorIntegrationError(
        'ALL_WORK_JOINED_INVALID',
        'exact-version freeze requires the exact one-or-two-seat verdict plan',
      )
    }
    const graph = createEvidenceInvalidationGraph({
      bindings: {
        missionHash: details.missionHash, planHash: details.planHash,
        candidateHash: details.candidateHash, environmentHash: details.environmentHash,
        oracleHash: details.oracleHash, assumptionsHash: details.assumptionsHash,
      },
      evidence: [{
        id: candidateEvidenceId, kind: 'evidence', hash: details.dependencyHash,
        dependsOn: ['mission', 'plan', 'candidate', 'environment', 'oracle', 'assumptions'],
      }],
      verdicts: requiredVerdictIds.map(id => ({
        id, kind: 'verdict', hash: hashText(`pending-${id}`), dependsOn: [candidateEvidenceId],
      })),
    })
    return stateStore.freezeCandidateForChecks({
      capability, cause: eventId === 'REPAIR_READY'
        ? 'freeze graph-bound repaired version for fresh independent checks'
        : 'freeze graph-bound exact version for independent checks',
      candidateHash: details.candidateHash, environmentHash: details.environmentHash,
      dependencyHash: details.dependencyHash, evidenceGraph: graph, requiredVerdictIds,
      retryState, openIds: details.nextReadyWorkIds || [],
    })
  }
  if (eventId === 'INDEPENDENT_VERDICT_RECORDED') {
    return stateStore.recordIndependentVerdict({
      capability, cause: 'record exact graph-bound independent verdict',
      verdictId: details.verdictId, verdictHash: details.verdictHash,
      openIds: details.nextReadyWorkIds || [],
    })
  }
  const current = stateStore.load()
  const retryState = { ...(current.retryState || {}) }
  if (eventId === 'IMPLEMENTATION_DEFECT') {
    if (!/^[a-f0-9]{64}$/u.test(details.candidateHash || '') ||
        !/^[a-f0-9]{64}$/u.test(details.checkerResultHash || '') ||
        typeof details.checkerId !== 'string' || !details.checkerId ||
        typeof details.repairWorkItemId !== 'string' || !/^work-\d+-repair-\d+$/u.test(details.repairWorkItemId) ||
        !Number.isSafeInteger(details.repairAttempt) || details.repairAttempt < 1 ||
        !details.checkerReceiptPointer || typeof details.checkerReceiptPointer !== 'object') {
      throw new SupervisorIntegrationError(
        'REPAIR_RECOVERY_INVALID',
        'implementation repair requires its exact rejected version, checker result, receipt, and physical repair identity',
      )
    }
    retryState.pendingImplementationRepair = {
      checkerId: details.checkerId,
      checkerResultHash: details.checkerResultHash,
      checkerReceiptPointer: details.checkerReceiptPointer,
      rejectedCandidateHash: details.candidateHash,
      repairAttempt: details.repairAttempt,
      repairWorkItemId: details.repairWorkItemId,
    }
  } else if (eventId === 'TRANSIENT_RUNTIME' && details.terminalDisposition === 'FAIL') {
    if (!/^roadmap-plan-recheck(?:-runtime-retry)?$/u.test(details.checkerId || '') ||
        !/^[a-f0-9]{64}$/u.test(details.candidateHash || '') ||
        !/^[a-f0-9]{64}$/u.test(details.checkerResultHash || '')) {
      throw new SupervisorIntegrationError(
        'CHECK_RETRY_STATE_INVALID',
        'terminal ROADMAP recheck disposition requires its exact checker result and plan version',
      )
    }
    retryState.conclusiveCheckerTerminal = {
      checkerId: details.checkerId,
      candidateHash: details.candidateHash,
      checkerResultHash: details.checkerResultHash,
      code: 'FAIL',
      returnState: nextState,
    }
  } else if (eventId === 'CHECK_INCONCLUSIVE') {
    if (!['RUN_WORK', 'CHECK_WORK'].includes(current.state)) {
      throw new SupervisorIntegrationError(
        'CHECK_RETRY_STATE_INVALID',
        'inconclusive checker retry must originate from RUN_WORK or CHECK_WORK',
      )
    }
    if (!/^[a-f0-9]{64}$/u.test(details.checkerResultHash || '')) {
      throw new SupervisorIntegrationError(
        'CHECK_RETRY_STATE_INVALID',
        'inconclusive checker retry requires its exact durable result hash',
      )
    }
    const controllerReassessment = canonicalCheckerReassessment(
      details.controllerReassessment || {
        code: details.controllerReason || 'CHECK_INCONCLUSIVE',
        priorResultEvidenceHash: details.checkerResultHash,
      },
      { resultHash: details.checkerResultHash, checkerId: details.checkerId },
    )
    retryState.inconclusiveChecker = {
      checkerId: details.checkerId,
      candidateHash: details.candidateHash,
      checkerResultHash: details.checkerResultHash,
      retryAttempt: details.retryAttempt,
      returnState: current.state,
      controllerReassessment,
    }
  } else if (eventId === 'CHECK_BECAME_CONCLUSIVE') {
    const pending = retryState.inconclusiveChecker
    if (!pending || !/^[a-f0-9]{64}$/u.test(pending.checkerResultHash || '') ||
        pending.returnState !== nextState ||
        pending.candidateHash !== details.candidateHash) {
      throw new SupervisorIntegrationError(
        'CHECK_RETRY_STATE_INVALID',
        'conclusive checker retry must return to its durable originating phase and exact version being checked',
      )
    }
    delete retryState.inconclusiveChecker
    if (details.terminalDisposition === 'FAIL') {
      retryState.conclusiveCheckerTerminal = {
        checkerId: details.checkerId,
        candidateHash: details.candidateHash,
        checkerResultHash: details.checkerResultHash,
        code: 'FAIL',
        returnState: nextState,
      }
    }
  }
  return stateStore.transition(nextState, {
    capability, cause: 'deterministic external supervisor progression', eventId,
    statePatch: {
      budgets: budgetController.snapshot(),
      ...(details.candidateHash ? { candidateHash: details.candidateHash } : {}),
      retryState,
    },
    ...(details.frontier ? { frontier: details.frontier } : {}),
    workHashes: details.candidateHash ? [details.candidateHash] : [],
    checkHashes: details.checkHashes || [],
    openIds: details.nextReadyWorkIds || [],
  })
}

function hydrateBudgetSnapshot(saved, cumulative, authoritativeGeneration = saved && saved.generation) {
  if (!saved || typeof saved !== 'object' || !cumulative || typeof cumulative !== 'object') {
    throw new SupervisorIntegrationError('BUDGET_RESUME_REQUIRED', 'resume requires canonical state and accounting snapshots')
  }
  const tokenUsage = cumulative.tokenUsage || {}
  const replayedTokens = ['noncachedInput', 'cachedInput', 'output', 'reasoning']
    .reduce((sum, field) => sum + Number(tokenUsage[field] || 0), 0)
  const merged = {
    ...saved,
    generation: authoritativeGeneration,
    consumedWallMs: Math.max(Number(saved.consumedWallMs || 0), Number(cumulative.elapsedMilliseconds || 0)),
    tokensUsed: Math.max(Number(saved.tokensUsed || 0), replayedTokens),
    sessionsStarted: Math.max(Number(saved.sessionsStarted || 0), Number(cumulative.sessions || 0)),
    launches: Math.max(Number(saved.launches || 0), Number(cumulative.launches || 0)),
  }
  for (const field of ['consumedWallMs', 'tokensUsed', 'sessionsStarted', 'launches', 'generation']) {
    if (!Number.isSafeInteger(merged[field]) || merged[field] < (field === 'generation' ? 1 : 0)) {
      throw new SupervisorIntegrationError('BUDGET_RESET_DETECTED', `persisted resume budget has invalid ${field}`)
    }
  }
  return merged
}

function restoreBudgetController(snapshot, clockOptions = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.limits) {
    throw new SupervisorIntegrationError('BUDGET_RESUME_REQUIRED', 'resume lacks a persisted budget snapshot')
  }
  return new BudgetController({
    limits: snapshot.limits,
    finalizationReserveMs: snapshot.finalizationReserveMs,
    verificationReserveMs: snapshot.verificationReserveMs || 0,
    phases: productionPhaseBudgets(snapshot.limits.wallMs),
    phaseBudgetFactory: productionPhaseBudgets,
    ...clockOptions,
    snapshot,
  })
}

function sealDeferredPromotionState(input) {
  const body = JSON.parse(JSON.stringify(input))
  delete body.stateHash
  return Object.freeze({
    ...body,
    stateHash: hashText(stableStringify(body)),
  })
}

function assertDeferredPromotionState(state) {
  if (!state || state.schemaVersion !== 1 ||
      !['PREPARED', 'JOIN_ACCEPTED', 'PROMOTED', 'ABORTED'].includes(state.status) ||
      typeof state.token !== 'string' || state.token.length < 16 ||
      typeof state.workItemId !== 'string' || !state.workItemId ||
      !/^[a-f0-9]{64}$/.test(state.candidateHash || '') ||
      !state.workspace || !/^[a-f0-9]{64}$/.test(state.workspace.bindingHash || '') ||
      typeof state.workspace.recordPath !== 'string' || !path.isAbsolute(state.workspace.recordPath) ||
      typeof state.workspace.workspacePath !== 'string' || !path.isAbsolute(state.workspace.workspacePath) ||
      !state.canonicalAssignment || !state.mutationAdmission || !Array.isArray(state.postimages) ||
      state.postimages.some(item => !item || !['file', 'missing'].includes(item.type) ||
        typeof item.path !== 'string' || !path.isAbsolute(item.path) ||
        (item.type === 'file' && !/^[a-f0-9]{64}$/.test(item.hash || '')) ||
        (item.type === 'missing' && item.hash !== null))) {
    throw new SupervisorIntegrationError(
      'DONE_RETRY_RECOVERY_INVALID',
      'persisted deferred promotion state is malformed',
    )
  }
  const expected = sealDeferredPromotionState(state)
  if (expected.stateHash !== state.stateHash) {
    throw new SupervisorIntegrationError(
      'DONE_RETRY_RECOVERY_INVALID',
      'persisted deferred promotion state hash changed',
    )
  }
  return state
}

class CodexSupervisorRuntime {
  constructor(options = {}) {
    validateRuntimeDependencies(options)
    this.options = options
    this.compatibilityRecoveryAuthority = options.compatibilityRecoveryAuthority || new CompatibilityRecoveryAuthority()
    this.compatibilityRecoveryAdmission = null
    // The concrete route executor is constructed before the runtime object,
    // but its state transitions must still pass through the runtime's single
    // transition+recovery-checkpoint boundary.  This is a local control-plane
    // reference; it is never exposed to a model child or persisted.
    this.options.runtimeInstance = this
    this.missionLock = options.missionLock
    this.budget = options.budgetController
    this.processOwner = options.processOwner
    this.rolePolicy = options.rolePolicy || new RolePolicy(options.roleContract)
    this.schedulerFactory = options.schedulerFactory || (settings => new CentralScheduler(settings))
    this.safeEnvFactory = options.safeEnvFactory || safeEnvironmentFactory()
    this.timerApi = options.timerApi || { setTimeout, clearTimeout }
    this.now = options.now || Date.now
    this.monotonicNow = options.monotonicNow || (() => Number(process.hrtime.bigint() / 1000000n))
    this.activation = Object.freeze({
      id: options.activationId || crypto.randomUUID(),
      nonce: options.activationNonce || crypto.randomBytes(16).toString('hex'),
      missionHash: options.missionHash || hashText(options.mission || ''),
      generation: options.generation || 1,
    })
    this.route = null
    this.routeSource = null
    this.settings = null
    this.record = null
    this.lease = null
    this.scheduler = null
    this.finalizer = null
    this.requestPointer = null
    this.analystStarted = false
    this.cancelled = false
    this.finished = false
    this.finalizing = false
    this.suspending = false
    this.finalizationPromise = null
    this.terminalFinalizationIntent = null
    this.suspensionPromise = null
    this.resumableSuspensionIntent = null
    this.cancellationPromise = null
    this.settledResult = null
    this.starting = false
    this.startupReadyPromise = null
    this.resolveStartupReady = null
    this.workerContexts = new Map()
    this.retainedL1Leases = new Map()
    this.profileLimits = Object.freeze({ route: null, status: 'ROUTE_PENDING', maxDepth: 1, maxConcurrentThreads: 1 })
    this.consumedChecks = new Set()
    this.deferredCheckerProofs = new Map()
    this.deferredPromotions = new Map()
    this.launches = []
    this.recoveryThreads = new Map()
    this.recoveryCompletedWorkIds = new Set(options.resumeState && options.resumeState.completedWorkIds || [])
    this.recoveryCompletedCheckIds = new Set()
    for (const id of options.resumeState && options.resumeState.completedCheckIds || []) {
      addCanonicalCompletedChecker(this.recoveryCompletedCheckIds, id)
    }
    this.recoveryAcceptedResultIds = new Set(options.resumeState && options.resumeState.acceptedResultIds || [])
    this.recoveryExternalOperations = new Map((options.resumeState && options.resumeState.externalOperations || [])
      .map(operation => [operation.operationId, operation]))
    this.providerCapabilities = options.providerCapabilities === null
      ? null
      : validateProviderCapabilities(options.providerCapabilities)
    this.admissionStartedAt = this.monotonicNow()
    this.admissionDurations = { configuration: 0, runRecord: 0, persistence: 0 }
    this.routeFrozenAt = null
    this.firstChildStartupRecorded = false
    this.diagnosticWorkerLaunches = 0
    this.lastAcceptedProgress = null
    this.rootCallers = Object.freeze({
      controlPlane: this.rolePolicy.bindCaller({
        logicalRole: 'deterministic-control-plane',
        physicalRole: CONTROL_PLANE_PHYSICAL_ROLE,
        sessionId: options.controlPlaneSessionId || `${this.activation.id}:control-plane`,
        runId: options.runId,
        generation: this.activation.generation,
      }),
      runOwner: this.rolePolicy.bindCaller({
        logicalRole: 'run-owner',
        physicalRole: options.runOwnerPhysicalRole || this.rolePolicy.contract.orchestratorContract.physicalId,
        sessionId: options.rootSessionId || `${this.activation.id}:run-owner`,
        runId: options.runId,
        generation: this.activation.generation,
      }),
    })
  }

  _deadlineFailure(code, reason, details = {}) {
    return {
      outcome: 'PARTIAL',
      route: null,
      activationId: this.activation.id,
      terminalEnvelope: {
        status: code,
        reason,
        details,
        budgetOutcome: { terminal: true, dimension: 'WALL', reconciledPartialState: true },
      },
    }
  }

  _enforceBudgetPhase(name, evidence = {}) {
    if (!name || !this.budget || !this.budget.phases || !this.budget.phases[name]) return null
    if ((this.options.baseEnvironment || process.env).AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT === '1') {
      return Object.freeze({ action: 'CONTINUE', reason: 'authenticated benchmark time policy is unbounded' })
    }
    const snapshot = this.budget.snapshot()
    const started = snapshot.phaseStartedAtElapsedMs &&
      snapshot.phaseStartedAtElapsedMs[name] !== undefined
    if (!started) this.budget.startPhase(name)
    const protectedPhase = ['RECOVERY_REPLAY', 'FINALIZATION_RELEASE'].includes(name)
    const decision = this.budget.supervisorDecision(name, {
      forWork: !protectedPhase,
      forExecution: name === 'EXECUTION_BUILD',
    })
    if (decision.action === 'CONTINUE') return decision
    if (decision.action === 'REQUEST_CONVERGENCE') {
      this.budget.requestConvergence(name, {
        route: this.route,
        activationId: this.activation.id,
        ...evidence,
      })
      if (name === 'FINALIZATION_RELEASE') return { ...decision, terminalReleaseRequired: true }
      throw new SupervisorIntegrationError(
        'PHASE_CONVERGENCE_REQUIRED',
        `production phase ${name} reached its soft deadline and cannot admit more work`,
        { phase: name, decision },
      )
    }
    if (decision.action === 'WAIT_FOR_CONVERGENCE') {
      if (name === 'FINALIZATION_RELEASE') return { ...decision, terminalReleaseRequired: true }
      throw new SupervisorIntegrationError(
        'PHASE_CONVERGENCE_REQUIRED',
        `production phase ${name} is still reaching a passing result`,
        { phase: name, decision },
      )
    }
    if (decision.action === 'STOP_PHASE') {
      if (name === 'FINALIZATION_RELEASE') return { ...decision, terminalReleaseRequired: true }
      throw new SupervisorIntegrationError(
        'PHASE_BUDGET_EXHAUSTED',
        `production phase ${name} reached its hard deadline`,
        { phase: name, decision },
      )
    }
    if (name === 'FINALIZATION_RELEASE') return { ...decision, terminalReleaseRequired: true }
    throw new SupervisorIntegrationError(
      'BUDGET_EXHAUSTED',
      `production activation budget stopped phase ${name}`,
      { phase: name, decision },
    )
  }

  async applyUserSteering(turn, appendOptions = {}) {
    if (!this.record || !this.requestPointer) {
      throw new SupervisorIntegrationError(
        'REQUEST_POINTER_REQUIRED',
        'user steering requires an admitted run record and bound L1 request pointer',
      )
    }
    const previousPointer = verifyRequestPointer(this.requestPointer)
    await this._runtimeTransition('USER_UPDATE', 'APPEND_REQUEST_STEERING', {
      previousRequestEnvelopeHash: previousPointer.hash,
    })
    if (typeof this.record.appendRequest !== 'function') {
      throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'the admitted run record cannot append user steering')
    }
    const entry = await this.record.appendRequest(turn, appendOptions)
    if (!entry || entry.entryType !== 'steering-edge') {
      throw new SupervisorIntegrationError('REQUEST_STEERING_INVALID', 'user steering must append a canonical steering edge')
    }
    const reboundPointer = await this.options.requestPointerFactory(this.record)
    verifyRequestPointer(reboundPointer)
    if (reboundPointer.path !== previousPointer.path || reboundPointer.hash === previousPointer.hash ||
        reboundPointer.bytes <= previousPointer.bytes) {
      throw new SupervisorIntegrationError(
        'REQUEST_STEERING_REBIND_INVALID',
        'user steering must extend the admitted envelope and bind a new pointer',
      )
    }
    const loaded = this.record.loadRequest()
    if (!loaded || loaded.digest !== reboundPointer.hash ||
        loaded.records.at(-1)?.entryHash !== entry.entryHash) {
      throw new SupervisorIntegrationError(
        'REQUEST_STEERING_RECHECK_FAILED',
        'the rebound pointer does not identify the appended steering edge',
      )
    }
    this.requestPointer = Object.freeze({ ...reboundPointer })
    verifyRequestPointer(this.requestPointer)
    await this._runtimeTransition('REQUEST_STEERING_APPENDED', 'INVALIDATE_AFFECTED_RESULTS', {
      previousRequestEnvelopeHash: previousPointer.hash,
      requestEnvelopeHash: this.requestPointer.hash,
      steeringEntryHash: entry.entryHash,
    })
    const retainedL1 = [...(this.retainedL1Leases || new Map()).entries()]
      .filter(([, retained]) => retained && retained.completed !== true)
    const redispatched = []
    for (const [workItemId, retained] of retainedL1) {
      const prior = this.workerContexts.get(workItemId)
      if (!prior || prior.logicalRole !== 'mission-coordinator') continue
      this.completeRetainedLease(retained)
      this.retainedL1Leases.delete(workItemId)
      const replacementWorkItemId = `${workItemId}:steering:${entry.entryHash.slice(0, 16)}`
      const result = await this._launchThroughScheduler(this.scheduler, {
        workItemId: replacementWorkItemId,
        logicalRole: 'mission-coordinator', parent: 'run-owner', caller: this.rootCallers.runOwner,
        route: this.route, purpose: 'planning', retainLease: true,
        requiredByMission: true,
        repairOf: workItemId, executorKey: prior.executorKey,
        assignment: 'Reload and hash-check the rebound immutable request envelope, then revise the retained L1 decomposition for the steering edge.',
        ownership: ['workspace'],
        evidenceHashes: [entry.entryHash, reboundPointer.hash],
        success: ['The retained L1 binds the new request envelope hash before any downstream assignment.'],
        checks: ['Report the exact rebound request pointer hash and invalidate affected downstream work.'],
      })
      if (!result || !result.retainedLease ||
          this.requestPointer.hash !== reboundPointer.hash) {
        throw new SupervisorIntegrationError(
          'REQUEST_STEERING_REDISPATCH_FAILED',
          'retained L1 was not reloaded and redispatched against the rebound request pointer',
        )
      }
      this.retainedL1Leases.set(replacementWorkItemId, result.retainedLease)
      redispatched.push(replacementWorkItemId)
    }
    await this._runtimeTransition('AFFECTED_RESULTS_INVALIDATED', 'L0_ROUTE_DECISION', {
      requestEnvelopeHash: this.requestPointer.hash,
      invalidatedRetainedL1Ids: retainedL1.map(([workItemId]) => workItemId),
      redispatchedRetainedL1Ids: redispatched,
    })
    return Object.freeze({
      entry,
      previousPointer: Object.freeze({ ...previousPointer }),
      requestPointer: this.requestPointer,
      redispatchedRetainedL1Ids: Object.freeze(redispatched),
    })
  }

  _defaultExternalOperation(request, assignment) {
    return createDefaultExternalOperation({
      request, assignment, runId: this.options.runId, generation: this.activation.generation,
    })
  }

  _applySafeTransportDegradation(verification, request, scheduler) {
    if (!verification || verification.verified === true || !verification.degradedTransport ||
        typeof this.options.safeDegradationEvaluator !== 'function') return verification
    const degradationEvaluation = this.options.safeDegradationEvaluator(verification.degradedTransport)
    if (!degradationEvaluation || degradationEvaluation.accepted !== true) return verification
    if (['DIRECT', 'ROADMAP'].includes(request.route)) {
      scheduler.reclassifyForSafeDegradation(degradationEvaluation)
      this.route = 'LIGHT'
      this.routeSource = 'safe-transport-degradation'
      request.route = 'LIGHT'
    }
    if (!['PRE_ROUTE', 'LIGHT'].includes(request.route)) return verification
    return Object.freeze({ ...verification, verified: true, degradationEvaluation })
  }

  _admitTaskDeadline() {
    const previous = this.options.previousBudgetSnapshot
    const resumeDeadline = this.options.resumeState && this.options.resumeState.deadline
    const previousDeadline = previous && previous.deadline
    const declared = this.settings.deadline
    const wallTimeUnbounded = benchmarkNoTimeoutEnabled(this.options.baseEnvironment || process.env)
    // Synthetic/legacy v2 resume fixtures which predate deadline persistence
    // remain readable. Every newly admitted generation-one run is bound below,
    // so no new resumable state can enter this compatibility branch.
    if (this.activation.generation > 1 && !resumeDeadline && !previousDeadline && !declared) {
      return { valid: true, legacyUnbound: true }
    }
    const nowMs = Number(this.now())
    if (this.activation.generation > 1) {
      if (!resumeDeadline || (declared && !sameCanonicalValue(resumeDeadline, declared)) ||
          (previousDeadline && !sameCanonicalValue(resumeDeadline, previousDeadline))) {
        return { valid: false, code: 'RESUME_DEADLINE_INVALID', reason: 'resume deadline differs from its declared or persisted binding' }
      }
      if (!Number.isFinite(Date.parse(resumeDeadline.absoluteDeadline)) ||
          (!wallTimeUnbounded && Date.parse(resumeDeadline.absoluteDeadline) <= nowMs)) {
        return { valid: false, code: 'RESUME_DEADLINE_EXPIRED', reason: 'persisted resume deadline has expired' }
      }
      if (previousDeadline) {
        const expectedVerification = Math.floor(previous.limits.wallMs * resumeDeadline.verificationReservePercent / 100)
        const expectedFinalization = Math.floor(previous.limits.wallMs * resumeDeadline.recoveryAndFinalizationReservePercent / 100)
        const current = this.budget.snapshot()
        if (previous.verificationReserveMs !== expectedVerification ||
            previous.finalizationReserveMs !== expectedFinalization ||
            current.limits.wallMs > previous.limits.wallMs ||
            current.verificationReserveMs !== previous.verificationReserveMs ||
            current.finalizationReserveMs !== previous.finalizationReserveMs ||
            !sameCanonicalValue(current.deadline, previousDeadline)) {
          return { valid: false, code: 'RESUME_DEADLINE_INVALID', reason: 'resume budget changed the exact deadline or either protected reserve' }
        }
      }
      this.settings = Object.freeze({ ...this.settings, deadline: { ...resumeDeadline } })
      this.activation = Object.freeze({ ...this.activation, deadline: { ...resumeDeadline } })
      return { valid: true, deadline: resumeDeadline }
    }
    const configuredWallMaximum = this.budget.snapshot().limits.wallMs
    const admitted = normalizeTaskDeadline(declared, {
      nowMs,
      productHardMaximumMs: this.options.productHardMaximumMs ?? configuredWallMaximum,
      wallTimeUnbounded,
    })
    if (!admitted.valid) return admitted
    this.budget.bindDeadline({ ...admitted, admittedAtMs: nowMs })
    this.settings = Object.freeze({ ...this.settings, deadline: { ...admitted.deadline } })
    this.activation = Object.freeze({ ...this.activation, deadline: { ...admitted.deadline } })
    return admitted
  }

  async start() {
    this.starting = true
    this.startupReadyPromise = new Promise(resolve => { this.resolveStartupReady = resolve })
    try {
      const configurationStartedAt = this.monotonicNow()
      this.compatibilityRecoveryAdmission = this.options.legacyResumeRecord
        ? this.compatibilityRecoveryAuthority.translateLegacy({
            source: this.options.legacyResumeRecord,
            translate: this.options.legacyResumeTranslator,
          })
        : this.options.resumeState
          ? this.compatibilityRecoveryAuthority.validateCanonical({
              state: { schemaVersion: '2.0.0', resumeState: this.options.resumeState },
            })
          : this.compatibilityRecoveryAuthority.normalNewRun()
      this.settings = resolveSettings(this.options.settings || {})
      if (this.settings.status === 'CONFIG_REQUIRED' || this.settings.status === 'PROVIDER_UNSUPPORTED') {
        return this._preLeaseOutcome(this.settings.status, this.settings)
      }
      const settingsValidation = validateResolvedSettings(this.settings)
      if (!settingsValidation.valid) {
        throw new SupervisorIntegrationError('SETTINGS_INVALID', 'resolved settings do not match the canonical v2 contract', {
          errors: settingsValidation.errors,
        })
      }
      const deadlineAdmission = this._admitTaskDeadline()
      if (!deadlineAdmission.valid) {
        return this._deadlineFailure(deadlineAdmission.code, deadlineAdmission.reason, deadlineAdmission)
      }
      this.admissionDurations.configuration += Math.max(0, this.monotonicNow() - configurationStartedAt)
      this.budget.assertAvailable({ forWork: true })
      const recordStartedAt = this.monotonicNow()
      if (typeof this.options.beforeMissionAcquire === 'function') {
        await this.options.beforeMissionAcquire({ activation: this.activation })
      }
      if (this.cancelled) {
        this._completeStartupBarrier()
        return this.cancellationPromise || this.settledResult || { outcome: 'CANCELLED' }
      }
      this.lease = this.missionLock.acquire({
        ...this.options.lock,
        runId: this.options.runId,
        activationId: this.activation.id,
        missionHash: this.activation.missionHash,
        nonce: this.activation.nonce,
        generation: this.activation.generation,
      })
      this.record = await this.options.recordFactory({
        activation: this.activation,
        lease: this.lease,
        settings: this.settings,
      })
      if (!this.providerCapabilities) {
        throw new SupervisorIntegrationError(
          'PROVIDER_UNSUPPORTED',
          'record admission did not establish an authenticated live provider capability receipt',
        )
      }
      this.providerCapabilities = validateProviderCapabilities(this.providerCapabilities)
      if (this.options.resumeState) {
        for (const id of this.options.resumeState.completedWorkIds || []) this.recoveryCompletedWorkIds.add(id)
        for (const id of this.options.resumeState.completedCheckIds || []) {
          addCanonicalCompletedChecker(this.recoveryCompletedCheckIds, id)
        }
        for (const [id, evidence] of Object.entries(this.options.resumeState.threadEvidence || {})) {
          this.recoveryThreads.set(id, evidence)
        }
        for (const operation of this.options.resumeState.externalOperations || []) {
          this.recoveryExternalOperations.set(operation.operationId, operation)
        }
      }
      if (this.options.budgetController !== this.budget) this.budget = this.options.budgetController
      if (this.activation.generation > 1) {
        validateResumedBudget(this.budget, this.options.previousBudgetSnapshot, this.activation.generation)
      }
      if (this.options.resumeState || this.activation.generation > 1) {
        this._enforceBudgetPhase('RECOVERY_REPLAY', { boundary: 'activation-resume' })
      }
      this.admissionDurations.runRecord += Math.max(0, this.monotonicNow() - recordStartedAt)
      const persistenceStartedAt = this.monotonicNow()
      this.requestPointer = await this.options.requestPointerFactory(this.record)
      this._restoreCompletedWorkerContexts()
      if (!this.options.resumeState && this.record.initializeRouteTranscript) this.record.initializeRouteTranscript()
      this.finalizer = await this.options.finalizerFactory({
        activation: this.activation,
        lease: this.lease,
        record: this.record,
      })
      this._completeStartupBarrier()
      if (this.cancelled && this.cancellationPromise) return this.cancellationPromise
      this.admissionDurations.persistence += Math.max(0, this.monotonicNow() - persistenceStartedAt)
      if (this.options.releaseReconciliation) {
        const release = this.options.releaseReconciliation
        this.route = release.route || null
        return await this._finish(release.outcome, {
          reason: 'reconcile the existing canonical release intent after supervisor restart',
          deliverables: release.deliverables || [],
          checkHashes: release.checkHashes || [],
          terminalEnvelope: release.terminalEnvelope || null,
        })
      }
      const exactPathRequested = this.settings.path && this.settings.path.mode === 'exact'
      const expectedRouteSource = exactPathRequested ? 'explicit_control' : 'automatic'
      if ((!this.options.resumeState || this.options.resumeState.canonicalCrashAdopted !== true) && !exactPathRequested) {
        await this._runtimeTransition('PROVIDER_CAPABILITIES_ACCEPTED', 'START_ROUTE_ANALYST')
      }

      let decisionResult
      if (this.options.resumeState) {
        this.analystStarted = true
        if (this.options.resumeState.stage === 'RESTART_ANALYST') {
          this._restorePendingScheduler(this.options.resumeState.schedulerState)
          this.analystStarted = false
          const analysis = await this._runRouteAnalyst()
          decisionResult = await this._runL0Decision(analysis)
        } else if (this.options.resumeState.stage === 'RESUME_ANALYST') {
          if (!this.options.resumeState.schedulerCrashCheckpoint) {
            throw new SupervisorIntegrationError(
              'RESUME_STATE_INVALID',
              'interrupted route analysis requires its exact live scheduler checkpoint',
            )
          }
          this.adoptedCrashScheduler = this._adoptCrashScheduler(
            this.options.resumeState.schedulerCrashCheckpoint,
            this.options.resumeState.recoveryContext,
          )
          const adoptedResults = await this._resumeAdoptedLaunches({
            resumeState: this.options.resumeState,
            candidateHash: null,
            decision: null,
            stage: 'route',
          })
          const result = adoptedResults['route-analyst']
          if (!result) {
            throw new SupervisorIntegrationError(
              'RESUME_STATE_INVALID',
              'interrupted route analysis did not reconcile its exact analyst result',
            )
          }
          const analysis = await this._runRouteAnalyst(result, this.options.resumeState.resumeState)
          decisionResult = await this._runL0Decision(analysis)
        } else if (['AFTER_ANALYST', 'AFTER_ANALYST_SAVING'].includes(this.options.resumeState.stage)) {
          if (!this.options.resumeState.recommendation || !this.options.resumeState.schedulerState) {
            throw new SupervisorIntegrationError('RESUME_STATE_INVALID', 'analyst resume requires saved recommendation and scheduler state')
          }
          let adoptedRoot = null
          if (this.options.resumeState.schedulerCrashCheckpoint) {
            const adopted = this._adoptCrashScheduler(
              this.options.resumeState.schedulerCrashCheckpoint,
              this.options.resumeState.recoveryContext,
            )
            if (!adopted.rootAccountingLease) {
              throw new SupervisorIntegrationError(
                'RESUME_STATE_INVALID',
                'live L0 crash resume lacks its adopted root-accounting lease',
              )
            }
            adoptedRoot = {
              lease: adopted.rootAccountingLease,
              binding: this.options.resumeState.schedulerCrashCheckpoint.rootAccountingRecord.crashBinding,
            }
          } else {
            this._restorePendingScheduler(this.options.resumeState.schedulerState)
          }
          if (this.options.resumeState.stage === 'AFTER_ANALYST_SAVING') {
            await this._runtimeTransition('ROUTE_ANALYSIS_SAVED', 'L0_ROUTE_DECISION')
          }
          decisionResult = await this._runL0Decision(this.options.resumeState.recommendation, adoptedRoot)
        } else {
          const validation = validateRouteDecision(this.options.resumeState.decision)
          if (!validation.valid || !this.options.resumeState.schedulerState ||
              this.options.resumeState.decision.routeSource !== expectedRouteSource ||
              this.options.resumeState.schedulerState.routeSource !== this.options.resumeState.decision.routeSource) {
            throw new SupervisorIntegrationError('RESUME_STATE_INVALID', 'resume requires a valid saved decision and scheduler state', {
              errors: validation.errors,
            })
          }
          decisionResult = {
            status: 'ROUTE_DECIDED',
            route: this.options.resumeState.decision.route,
            start_workers: true,
            decision: this.options.resumeState.decision,
          }
          if (this.options.resumeState.schedulerCrashCheckpoint) {
            this.adoptedCrashScheduler = this._adoptCrashScheduler(
              this.options.resumeState.schedulerCrashCheckpoint,
              this.options.resumeState.recoveryContext,
            )
          } else if (this.options.resumeState.schedulerState.route === 'PENDING') {
            this._restorePendingScheduler(this.options.resumeState.schedulerState)
          } else {
            this._activateRouteScheduler(
              this.options.resumeState.schedulerState, decisionResult.route, decisionResult.decision.routeSource,
            )
          }
        }
      } else if (exactPathRequested) {
        decisionResult = await this._acceptExactPath()
      } else {
        this.scheduler = this.schedulerFactory({
          route: 'PENDING',
          routeSource: 'automatic',
          runIdentity: { runId: this.options.runId, generation: this.activation.generation },
          rootContextId: this.activation.id,
          now: this.now,
          environment: this.options.baseEnvironment || process.env,
        })
        this._recordBootstrapAdmission()
        this._persistRecoveryCheckpoint({
          kind: 'CHECKPOINT',
          causeId: `route-start:${this.activation.generation}`,
          humanDescription: 'Persist the pre-launch route-analysis next ready work before admitting the sole analyst.',
        }, { nextReadyWorkIds: ['route-analyst'] })
        const analysis = await this._runRouteAnalyst()
        decisionResult = await this._runL0Decision(analysis)
      }
      if (!decisionResult.start_workers) {
        if (decisionResult.status === 'WAITING_USER') {
          return await this._suspendResumable('WAITING_USER', { terminalEnvelope: decisionResult })
        }
        return await this._finish('FAILED', { terminalEnvelope: decisionResult })
      }

      if (!decisionResult.decision || decisionResult.decision.routeSource !== expectedRouteSource) {
        throw new SupervisorIntegrationError(
          'ROUTE_SOURCE_INVALID',
          'route source must be derived from the explicit control channel and cannot be inferred from the route name',
        )
      }

      this.route = decisionResult.route
      this.routeSource = decisionResult.decision.routeSource
      if (!this.scheduler || this.scheduler.route === 'PENDING') {
        this._activateRouteScheduler(null, this.route, this.routeSource)
      }
      if ((!this.options.resumeState && !exactPathRequested) || this.options.resumeState?.resumeState === 'L0_ROUTE_DECISION') {
        await this._runtimeTransition('ROUTE_DECISION_VALID', 'PREPARE_WORK', {
          nextReadyWorkIds: decisionResult.route === 'ROADMAP'
            ? ['roadmap-author']
            : Array.from(
                { length: Math.max(1, Number(decisionResult.decision.usefulWorkerCount || 1)) },
                (_, index) => `work-${index + 1}`,
              ),
        })
      }
      if (typeof this.options.profileUpdater === 'function') {
        this.profileLimits = await this.options.profileUpdater({ route: this.route, settings: this.settings })
      } else {
        this.profileLimits = deriveProfileLimits({
          route: this.route,
          maxSubs: this.settings.concurrency.effectiveMaxSubs,
          userLiveCeiling: this.options.userLiveCeiling,
        })
      }
      await this._runRepresentativePolicyProbe()
      if (this.options.resumeState && this.options.resumeState.resumeState === 'FINALIZING') {
        return await this._finish('DONE', {
          reason: 'resume deterministic finalization after the accepted final check',
          deliverables: this.options.resumeState.deliverables || [],
          checkHashes: this.options.resumeState.checkHashes || [],
          terminalEnvelope: this.options.resumeState.terminalEnvelope || null,
        })
      }
      const restoredExecutionState = this.options.resumeState && this.options.resumeState.resumeState
      const resumesExecution = ['RUN_WORK', 'ITEM_VERIFIED', 'CHECK_WORK', 'REPAIRING', 'CHECK_INCONCLUSIVE']
        .includes(restoredExecutionState)
      if (!resumesExecution) {
        const planningStartedAt = this.monotonicNow()
        if (typeof this.options.planPreparer === 'function') {
          const prepare = () => this.options.planPreparer({
            route: this.route,
            decision: decisionResult.decision,
            record: this.record,
          })
          if (this.route === 'LIGHT') {
            await withTimeout(
              prepare,
              benchmarkPhaseTimeoutMs(
                LIGHT_PLAN_MAX_DURATION_MS,
                this.options.baseEnvironment || process.env,
              ),
              this.timerApi,
              'LIGHT_PLAN_TIMEOUT',
              () => this.processOwner.cancelAll({ reason: 'light planning timeout', terminalStatus: 'FAILED' }),
            )
          } else {
            await prepare()
          }
        }
        if (this.route === 'LIGHT') {
          const planningAdmission = this.scheduler.recordAdmissionComponent(
            'lightPlanning',
            Math.max(0, this.monotonicNow() - planningStartedAt),
          )
          if (!planningAdmission || planningAdmission.withinCeiling !== true) {
            throw new SupervisorIntegrationError(
              'ADMISSION_COMPONENT_TIMEOUT',
              'LIGHT planning exceeded the canonical admission ceiling',
              planningAdmission || {},
            )
          }
        }
      }
      const execute = this.options.executeRoute
      if (typeof execute !== 'function') {
        throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'selected route has no executable provider adapter')
      }
      if (!resumesExecution) {
        const initialReadyWorkIds = this.route === 'ROADMAP'
          ? ['roadmap-author']
          : Array.from(
              { length: Math.max(1, Number(decisionResult.decision.usefulWorkerCount || 1)) },
              (_, index) => `work-${index + 1}`,
            )
        await this._runtimeTransition('WORK_PREPARED', 'RUN_WORK', {
          nextReadyWorkIds: initialReadyWorkIds,
        })
      }
      const result = await this._withinMissionDeadline(() => execute({
        route: this.route,
        decision: decisionResult.decision,
        launch: request => this.launchChild(request),
        completeRetainedLease: retained => this.completeRetainedLease(retained),
        resumeAdoptedLaunches: input => this._resumeAdoptedLaunches(input),
        acceptDeferredCheckerProof: workItemId => this._acceptDeferredCheckerProof(workItemId),
        selectWorkRecipe,
        resumeState: this.options.resumeState || null,
      }))
      if (!result || !TERMINAL_OUTCOMES.includes(result.outcome)) {
        throw new SupervisorIntegrationError('TERMINAL_OUTCOME_INVALID', 'route executor must return a typed terminal outcome')
      }
      let terminalOutcome = result.outcome
      if (terminalOutcome !== 'DONE') {
        const terminalError = new SupervisorIntegrationError(
          result.terminalEnvelope && (result.terminalEnvelope.code || result.terminalEnvelope.status) || terminalOutcome,
          result.terminalEnvelope && (result.terminalEnvelope.reason ||
            result.terminalEnvelope.cause && result.terminalEnvelope.cause.reason) ||
            'route executor returned a typed non-DONE outcome',
          result.terminalEnvelope || {},
        )
        terminalOutcome = await this._enterTerminalRelease(
          terminalOutcome,
          terminalError,
          result.terminalEnvelope || null,
        )
      }
      return await this._finish(terminalOutcome, result)
    } catch (error) {
      this._completeStartupBarrier()
      // A transient drain, scheduler export, or durable-finalizer failure is a
      // failure to record the already selected terminal result; it is not a
      // new task failure. Retry that exact immutable intent before applying
      // any error taxonomy that could replace DONE with FAILED/BLOCKED.
      if (this.terminalFinalizationIntent && !this.finished) {
        return this._finish(
          this.terminalFinalizationIntent.outcome,
          this.terminalFinalizationIntent.result,
        )
      }
      if (this.resumableSuspensionIntent && !this.finished) {
        return this._suspendResumable(
          this.resumableSuspensionIntent.outcome,
          this.resumableSuspensionIntent.result,
        )
      }
      const benchmarkDiagnostic = this.options.baseEnvironment &&
        this.options.baseEnvironment.AUTOPROMPT_BENCHMARK_DIAGNOSTICS
      if (benchmarkDiagnostic) {
        try {
          fs.appendFileSync(benchmarkDiagnostic, `${JSON.stringify({
            label: 'supervisor-runtime-error',
            state: typeof this.options.runtimeStateProvider === 'function'
              ? this.options.runtimeStateProvider()?.state || null
              : null,
            route: this.route,
            error: serializeError(error),
            stack: error && error.stack || null,
          })}\n`, { mode: 0o600 })
        } catch {}
      }
      if (error && error.code === 'WORKSPACE_LEASE_CONFLICT') {
        return this._preLeaseOutcome('WORKSPACE_LEASE_CONFLICT', { error: serializeError(error) })
      }
      if (!this.lease) return this._preLeaseOutcome(error.code || 'FAILED', { error: serializeError(error) })
      if (this.cancelled && this.cancellationPromise) return this.cancellationPromise
      const budgetStop = error && [
        'BUDGET_EXHAUSTED', 'MISSION_TIMEOUT', 'EXTERNAL_WRITE_DEADLINE_EXPIRED',
        'RESUME_DEADLINE_EXPIRED', 'PHASE_CONVERGENCE_REQUIRED', 'PHASE_BUDGET_EXHAUSTED',
      ].includes(error.code)
      if (error && !budgetStop && this.budget && typeof this.budget.recordCrash === 'function') {
        error.crashState = this.budget.recordCrash(hashText(stableStringify({
          code: error.code || 'FAILED',
          message: error.message || String(error),
          route: this.route,
        })), { progressEvidence: this.lastAcceptedProgress, activationId: this.activation.id })
        if (typeof this.budget.crashRetryVerdict === 'function') {
          const retry = this.budget.crashRetryVerdict()
          if (retry.exhausted) {
            error.code = retry.code
            error.details = { ...(error.details || {}), crashRetry: retry }
          }
        }
      }
      if (budgetStop) {
        const frontier = this._budgetPauseFrontier()
        if (frontier) {
          const pauseResult = {
            terminalEnvelope: { status: error.code, error: serializeError(error) },
            transition: { eventId: 'BUDGET_EXHAUSTED_RESUMABLE', frontier },
          }
          try {
            return await this._suspendResumable('PAUSED', pauseResult)
          } catch {
            return this._suspendResumable('PAUSED', pauseResult)
          }
        }
      }
      const diagnosticDenied = error && ['DIAGNOSTIC_DENIAL_BLOCKED', 'DIAGNOSTIC_WORKER_LIMIT'].includes(error.code)
      if (diagnosticDenied && error.code === 'DIAGNOSTIC_DENIAL_BLOCKED') {
        diagnosticDenialDisposition(Number(error.details && error.details.workerCount || 0))
      }
      let terminalOutcome = diagnosticDenied ? 'BLOCKED'
        : budgetStop ? 'PARTIAL' : (this.cancelled ? 'CANCELLED' : 'FAILED')
      terminalOutcome = await this._enterTerminalRelease(terminalOutcome, error)
      return this._finish(terminalOutcome, {
        terminalEnvelope: { status: error.code || 'FAILED', error: serializeError(error) },
      })
    }
  }

  _completeStartupBarrier() {
    if (this.resolveStartupReady) this.resolveStartupReady()
    this.resolveStartupReady = null
    this.starting = false
  }

  async _runRouteAnalyst(adoptedResult = null, restoredState = null) {
    if (this.analystStarted && !adoptedResult) {
      throw new SupervisorIntegrationError('ROUTE_ANALYST_DUPLICATE', 'exactly one route analyst is allowed')
    }
    this.analystStarted = true
    const admission = createRouteAnalystAdmission({
      runId: this.options.runId,
      requestEnvelopeHash: this.requestPointer.hash,
      targetIdentity: this.options.targetIdentity,
    })
    const startedAt = this.now()
    const admissionStartedAt = this.monotonicNow()
    let result = adoptedResult
    let streamedRouteEventCount = 0
    try {
      if (!result) result = await withTimeout(
        () => this._launchThroughScheduler(this.scheduler, {
          workItemId: 'route-analyst',
          logicalRole: 'route-analyst',
          parent: 'deterministic-control-plane',
          caller: this.rootCallers.controlPlane,
          route: 'PRE_ROUTE',
          purpose: 'planning',
          lane: 'routeAnalyst',
          assignment: 'Inspect only enough read-only project evidence to recommend DIRECT, LIGHT, or ROADMAP.',
          successChecklist: ['Return the required route recommendation schema.'],
          checks: ['Read/list/search only; do not mutate or dispatch.'],
          admission,
        }),
        benchmarkPhaseTimeoutMs(
          ROUTE_ANALYST_MAX_DURATION_MS,
          this.options.baseEnvironment || process.env,
        ),
        this.timerApi,
        'ROUTE_ANALYST_TIMEOUT',
        () => this.processOwner.cancelAll({ reason: 'route analyst timeout', terminalStatus: 'FAILED' }),
      )
      streamedRouteEventCount = Number(result && result[STREAMED_ROUTE_EVENT_COUNT] || 0)
    } catch (error) {
      streamedRouteEventCount = Number(error && error[STREAMED_ROUTE_EVENT_COUNT] || 0)
      if (error && (/^RECOVERY_CHECKPOINT_/.test(error.code || '') || /^RUN_RECORD_/.test(error.code || ''))) {
        throw error
      }
      result = { outcome: error.code === 'ROUTE_ANALYST_TIMEOUT' ? 'TIMEOUT' : 'CRASH', events: [{ type: 'failure', error: serializeError(error) }] }
    }
    for (const event of streamedRouteEventCount === 0 && Array.isArray(result.events) ? result.events :
      result.outcome === 'CRASH' || result.outcome === 'TIMEOUT' ? result.events || [] : []) {
      if (this.record.appendRouteEvent) this.record.appendRouteEvent(event)
    }
    const evaluated = evaluateRouteAnalystResult({
      admission,
      elapsedMs: result.elapsedMs === undefined ? Math.max(0, this.now() - startedAt) : result.elapsedMs,
      outcome: result.outcome,
      recommendation: result.recommendation,
      environment: this.options.baseEnvironment || process.env,
    })
    if (evaluated.recommendation_state) {
      if (!this.record || typeof this.record.writeRouteAnalystFallbackState !== 'function' ||
          typeof this.record.readRouteAnalystFallbackState !== 'function') {
        throw new SupervisorIntegrationError(
          'RUN_RECORD_SCHEMA_INCOMPATIBLE',
          'route analyst fallback state requires the immutable registered run-record writer',
        )
      }
      const statePath = typeof this.record.resolve === 'function'
        ? this.record.resolve('route/recommendation-state.json') : null
      if (!statePath || !fs.existsSync(statePath)) {
        this.record.writeRouteAnalystFallbackState(evaluated.recommendation_state)
      }
      const restoredFallback = this.record.readRouteAnalystFallbackState()
      if (stableStringify(restoredFallback) !== stableStringify(evaluated.recommendation_state)) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          'durable route analyst fallback state differs from the evaluated recommendation state',
        )
      }
    }
    this._recordAdmissionComponent('routeAnalyst', Math.max(0, this.monotonicNow() - admissionStartedAt))
    if (result.recommendation && this.record && typeof this.record.write === 'function') {
      const relative = 'route/recommendation.json'
      const absolute = typeof this.record.resolve === 'function' ? this.record.resolve(relative) : null
      if (absolute && fs.existsSync(absolute)) {
        const saved = readRegularJson(absolute, 'route recommendation').parsed
        if (JSON.stringify(saved) !== JSON.stringify(result.recommendation)) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
            'route recommendation differs from the terminal analyst result',
          )
        }
      } else {
        this.record.write(relative, `${JSON.stringify(result.recommendation, null, 2)}\n`)
      }
    }
    if (evaluated.recommendation && this.record && typeof this.record.resolve === 'function' &&
        !fs.existsSync(this.record.resolve('route/recommendation.json'))) {
      throw new SupervisorIntegrationError(
        'ROUTE_RECOMMENDATION_MISSING',
        'validated route analysis cannot enter SAVE_ROUTE_ANALYSIS before its recommendation is durable',
      )
    }
    if (restoredState !== 'SAVE_ROUTE_ANALYSIS') {
      await this._runtimeTransition(
        result.outcome === 'CRASH' || result.outcome === 'PROVIDER_UNSUPPORTED'
          ? 'ROUTE_ANALYST_FAILED_TO_START' : 'ROUTE_ANALYST_STARTED',
        'SAVE_ROUTE_ANALYSIS',
      )
    }
    await this._runtimeTransition('ROUTE_ANALYSIS_SAVED', 'L0_ROUTE_DECISION')
    return evaluated
  }

  async _acceptExactPath() {
    const route = this.settings.path && this.settings.path.exactRoute
    const preflightFactory = this.options.exactPathPreflight
    if (typeof preflightFactory !== 'function') {
      throw new SupervisorIntegrationError(
        'EXACT_PATH_PREFLIGHT_REQUIRED',
        'exact path requires the deterministic request/environment preflight; route facts are never inferred optimistically',
        { route },
      )
    }
    const requestEnvelopeBinding = preflightFactory === productionExactPathPreflight
      ? readExactPathRequestEnvelopeBinding(this.requestPointer, this.record)
      : null
    const boundRequestEnvelopeHash = requestEnvelopeBinding
      ? requestEnvelopeBinding.hash
      : this.requestPointer.hash
    const budgetSnapshot = this.budget.snapshot()
    const liveAvailability = this.budget.assertAvailable()
    const liveBudget = Object.freeze({ ...budgetSnapshot, remaining: { ...liveAvailability.remaining } })
    const providerCapabilitiesHash = hashText(stableStringify(this.providerCapabilities))
    const budgetSnapshotHash = hashText(stableStringify(liveBudget))
    const targetEvidence = typeof this.options.exactPathTargetEvidence === 'function'
      ? await this.options.exactPathTargetEvidence({ route, requestEnvelopeHash: boundRequestEnvelopeHash })
      : this.options.exactPathTargetEvidence
    const providerCapabilityEvidence = typeof this.options.exactPathProviderCapabilityEvidence === 'function'
      ? await this.options.exactPathProviderCapabilityEvidence({
          route, requestEnvelopeHash: boundRequestEnvelopeHash, providerCapabilitiesHash,
        })
      : this.options.exactPathProviderCapabilityEvidence
    const preflight = await preflightFactory({
      route,
      mission: this.options.mission,
      requestEnvelopeBytes: requestEnvelopeBinding && requestEnvelopeBinding.bytes,
      requestEnvelopeHash: boundRequestEnvelopeHash,
      targetIdentity: this.options.targetIdentity,
      targetEvidence,
      providerCapabilities: this.providerCapabilities,
      providerCapabilitiesHash,
      providerCapabilityEvidence,
      budget: liveBudget,
      budgetSnapshotHash,
      settings: this.settings,
    })
    const factory = this.options.exactPathDecisionFactory || createExactPathDecision
    const decision = await factory({
      route,
      preflight,
      requestedResult: this.options.mission,
      requestEnvelopeHash: boundRequestEnvelopeHash,
      targetIdentity: this.options.targetIdentity,
      providerCapabilities: this.providerCapabilities,
      providerCapabilitiesHash,
      budget: liveBudget,
      budgetSnapshotHash,
      nowMs: this.now(),
      settings: this.settings,
    })
    const validation = validateRouteDecision(decision)
    if (!validation.valid || !decision.pathSelection || decision.pathSelection.requestedRoute !== route ||
        decision.routeSource !== 'explicit_control' ||
        decision.pathSelection.automaticSelectionBypassed !== true ||
        decision.pathSelection.silentRouteChangesAllowed !== false) {
      throw new SupervisorIntegrationError(
        'EXACT_PATH_DECISION_INVALID',
        'the exact user path could not be compiled into a safe immutable execution decision',
        { route, errors: validation.errors },
      )
    }
    if (this.record && typeof this.record.write === 'function') {
      writeRouteDecisionArtifacts(this.record, decision)
    }
    this.route = route
    this.routeSource = 'explicit_control'
    this._activateRouteScheduler(null, route, this.routeSource)
    await this._runtimeTransition('EXACT_PATH_ACCEPTED', 'PREPARE_WORK', {
      nextReadyWorkIds: route === 'ROADMAP'
        ? ['roadmap-author']
        : Array.from(
            { length: Math.max(1, Number(decision.usefulWorkerCount || 1)) },
            (_, index) => `work-${index + 1}`,
          ),
    })
    return {
      status: 'ROUTE_DECIDED',
      route,
      start_workers: true,
      decision,
      automatic_selection_bypassed: true,
    }
  }

  async _runL0Decision(analysis, adoptedRoot = null) {
    const startedAt = this.now()
    const admissionStartedAt = this.monotonicNow()
    const rootSessionId = `${this.activation.id}:root-route-decision`
    const rootLease = adoptedRoot ? adoptedRoot.lease : this.scheduler.beginRootAccounting({
      phase: 'routeDecision',
      sessionId: this.rootCallers.runOwner.sessionId,
    })
    if (!adoptedRoot) {
      this._checkpointAccounting({
        kind: 'CHECKPOINT',
        causeId: `root-route-decision:${this.activation.generation}`,
        humanDescription: 'Persist the root L0 decision session without recording a model child launch.',
      }, { sessions: 1 })
      this.budget.startSession(rootSessionId, {
        activationId: this.activation.id,
        parentSessionId: this.rootCallers.runOwner.sessionId,
        forWork: true,
      })
    }
    const recoveryFrontier = {
      resumeState: 'L0_ROUTE_DECISION',
      nextReadyWorkIds: ['root-route-decision'],
      openCheckIds: [],
      acceptedResultIds: [],
    }
    let rootContinuationId = adoptedRoot && adoptedRoot.binding.continuationId || null
    let rootCrashBinding = adoptedRoot && adoptedRoot.binding || null
    let committedRootResultReceiptHash = null
    let rootResultCommitAuthority = null
    let adoptedContinuationPending = Boolean(adoptedRoot)
    const armRootCorrectionRotation = receiptHash => {
      if (rootResultCommitAuthority && committedRootResultReceiptHash === receiptHash) return
      committedRootResultReceiptHash = receiptHash
      rootResultCommitAuthority = this.scheduler.authorizeRootCrashContinuationRotationAfterResult(rootLease, {
        priorBindingHash: rootCrashBinding && rootCrashBinding.bindingHash,
        priorResultReceiptHash: receiptHash,
      })
    }
    const persistRootCheckpoint = (causeKind, evidence = null, causeDetails = {}, checkpointHints = {}) => {
      if (evidence) {
        this.recoveryThreads.set(rootLease.id, {
          startedEventHash: hashText(evidence.raw || JSON.stringify(evidence.event)),
          startedAt: evidence.occurredAt || new Date(this.now()).toISOString(),
        })
      }
      this._persistRecoveryCheckpoint({
        kind: causeKind,
        causeId: `root-l0:${this.activation.generation}:${causeKind.toLowerCase()}:${rootUsageSequence}`,
        humanDescription: `Persist the root L0 session at the ${causeKind.toLowerCase()} recovery boundary.`,
        ...causeDetails,
      }, {
        recoveryFrontier: checkpointHints.recoveryFrontier || recoveryFrontier,
        nextReadyWorkIds: checkpointHints.nextReadyWorkIds || recoveryFrontier.nextReadyWorkIds,
      })
    }
    const onLaunchPrepared = binding => {
      if (committedRootResultReceiptHash) {
        rootCrashBinding = this.scheduler.rotateRootCrashContinuationAfterResult(rootLease, {
          priorBindingHash: rootCrashBinding && rootCrashBinding.bindingHash,
          priorResultReceiptHash: committedRootResultReceiptHash,
          resultCommitAuthority: rootResultCommitAuthority,
          reservationId: binding.reservationId,
          sessionId: binding.sessionId,
          continuationId: binding.continuationId || null,
          frontier: {
            ...(rootCrashBinding && rootCrashBinding.frontier || recoveryFrontier),
            acceptedResultIds: [
              ...(rootCrashBinding && rootCrashBinding.frontier.acceptedResultIds || []),
              committedRootResultReceiptHash,
            ],
          },
        })
        committedRootResultReceiptHash = null
        rootResultCommitAuthority = null
        adoptedContinuationPending = false
      } else if (adoptedContinuationPending) {
        rootCrashBinding = this.scheduler.rebindAdoptedContinuation(rootLease, {
          priorBindingHash: rootCrashBinding.bindingHash,
          reservationId: binding.reservationId,
          sessionId: binding.sessionId,
          continuationId: rootContinuationId,
          frontier: rootCrashBinding.frontier,
        })
        adoptedContinuationPending = false
      } else {
        rootCrashBinding = this.scheduler.bindRootCrashContinuation(rootLease, {
          reservationId: binding.reservationId,
          sessionId: binding.sessionId,
          continuationId: binding.continuationId || null,
          frontier: recoveryFrontier,
        })
      }
      persistRootCheckpoint('LEASE_STARTED')
    }
    const onSessionIdentified = (continuationId, evidence) => {
      rootContinuationId = continuationId
      rootCrashBinding = this.scheduler.bindRootCrashContinuation(rootLease, {
        reservationId: evidence.reservationId,
        sessionId: evidence.sessionId,
        continuationId,
        frontier: rootCrashBinding && rootCrashBinding.frontier || recoveryFrontier,
      })
      persistRootCheckpoint('THREAD_STARTED', evidence)
    }
    let rootUsageSequence = 0
    const onUsageDelta = delta => {
      const authorization = rootLease.authorizeUsage(delta)
      const report = rootLease.reportUsage(delta, { productive: true, progressKind: 'planning' })
      rootUsageSequence += 1
      this._checkpointAccounting({
        kind: 'TOKEN_USAGE_RECORDED',
        causeId: `root-l0-jsonl:${this.activation.generation}:${rootUsageSequence}`,
        humanDescription: 'Persist complete streamed root L0 usage before allowing route-decision continuation.',
      }, { tokenUsage: delta })
      const tokens = Object.values(delta).reduce((total, value) => total + Number(value || 0), 0)
      if (tokens > 0) this.budget.consumeTokens(tokens)
      if (rootContinuationId || this.recoveryThreads.has(rootLease.id)) persistRootCheckpoint('USAGE_RECORDED')
      return { continue: authorization.allowed === true && report.continue === true, authorization, report }
    }
    const rootReceiptLocation = attempt => this._terminalReceiptLocation(
      rootLease.id,
      `root-route-decision-attempt-${attempt}`,
    )
    const readRootReceipt = attempt => {
      if (!this.record || typeof this.record.resolve !== 'function') return null
      const absolute = this.record.resolve(rootReceiptLocation(attempt))
      if (!fs.existsSync(absolute)) return null
      const receipt = readRegularJson(absolute, 'root L0 terminal receipt').parsed
      const { receiptHash, ...body } = receipt || {}
      if (!receipt || receipt.schemaVersion !== 1 || receiptHash !== hashText(JSON.stringify(body)) ||
          receipt.runId !== this.options.runId || receipt.activationId !== this.activation.id ||
          receipt.leaseId !== rootLease.id ||
          receipt.assignmentId !== 'root-route-decision' || receipt.correctionAttempt !== attempt ||
          !/^[a-f0-9]{64}$/.test(receipt.assignmentHash || '') ||
          receipt.requestEnvelopeHash !== this.requestPointer.hash ||
          receipt.resultHash !== hashText(JSON.stringify(receipt.submitted)) ||
          receipt.candidateHash !== null) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `root L0 terminal receipt for correction ${attempt} is foreign or corrupt`,
        )
      }
      return receipt
    }
    const onTerminalResult = (terminalResult, terminalEvidence, correctionAttempt) => {
      if (!terminalEvidence || !/^[a-f0-9]{64}$/.test(terminalEvidence.assignmentHash || '') ||
          terminalEvidence.sessionId !== rootContinuationId ||
          !terminalEvidence.controlSessionId) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          'root L0 terminal result lacks its exact dispatch/session binding',
        )
      }
      const {
        candidateHash: _candidateHash,
        completionRequested: _completionRequested,
        contextId: _contextId,
        events: _events,
        evidenceHashes: _evidenceHashes,
        recommendation: _recommendation,
        usage,
        usageStreamed,
        ...decision
      } = terminalResult
      const submitted = {
        decision: terminalResult.decision || decision,
        // The decision deadline is run-global.  Persist the original L0 start
        // boundary with the terminal receipt so adopting the already-finished
        // root turn cannot reset (or invert) its four-minute interval.
        startedAtMs: startedAt,
        submittedAtMs: this.now(),
        usage,
        usageStreamed: usageStreamed === true,
      }
      const body = {
        schemaVersion: 1,
        runId: this.options.runId,
        activationId: this.activation.id,
        admittedGeneration: this.activation.generation,
        leaseId: rootLease.id,
        assignmentId: 'root-route-decision',
        correctionAttempt,
        assignmentHash: terminalEvidence.assignmentHash,
        sessionId: terminalEvidence.controlSessionId,
        continuationId: terminalEvidence.sessionId,
        requestEnvelopeHash: this.requestPointer.hash,
        candidateHash: null,
        resultHash: hashText(JSON.stringify(submitted)),
        rawOutputHash: terminalEvidence.rawOutputHash,
        eventStreamHash: terminalEvidence.eventStreamHash,
        submitted,
      }
      const receipt = { ...body, receiptHash: hashText(JSON.stringify(body)) }
      const relative = rootReceiptLocation(correctionAttempt)
      const absolute = this.record.resolve(relative)
      if (fs.existsSync(absolute)) {
        if (JSON.stringify(readRegularJson(absolute, 'root L0 terminal receipt').parsed) !== JSON.stringify(receipt)) {
          throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', 'root L0 terminal receipt changed after persistence')
        }
      } else {
        this.record.write(relative, `${JSON.stringify(receipt, null, 2)}\n`)
      }
      persistRootCheckpoint('RESULT_COMMITTED', null, {
        resultCommit: {
          assignmentId: 'root-route-decision',
          assignmentHash: receipt.assignmentHash,
          leaseId: rootLease.id,
          sessionId: receipt.sessionId,
          continuationId: receipt.continuationId,
          resultHash: receipt.resultHash,
          receiptHash: receipt.receiptHash,
          candidateHash: null,
        },
      }, {
        recoveryFrontier: { ...recoveryFrontier, acceptedResultIds: [receipt.receiptHash] },
      })
      // The RESULT_COMMITTED verifier requires the exact lease/thread to
      // remain OPEN in the same durable scheduler checkpoint.  Remove the
      // thread only after the record and atomic snapshot are both durable.
      this.recoveryThreads.delete(rootLease.id)
      armRootCorrectionRotation(receipt.receiptHash)
      return receipt
    }
    const finish = result => {
      this._recordAdmissionComponent('routeDecision', Math.max(0, this.monotonicNow() - admissionStartedAt))
      return result
    }
    const decide = correctionAttempts => {
      const remainingMs = remainingL0DecisionBudgetMs({
        startedAtMs: admissionStartedAt,
        nowMs: this.monotonicNow(),
        environment: this.options.baseEnvironment || process.env,
      })
      return withTimeout(
        () => this.options.decideRoute({
          analysis,
          correctionAttempts,
          requestPointer: this.requestPointer,
          settings: this.settings,
          route: null,
          sessionId: this.rootCallers.runOwner.sessionId,
          continuationId: rootContinuationId,
          onLaunchPrepared,
          onSessionIdentified,
          onUsageDelta,
          onTerminalResult: (result, evidence) => onTerminalResult(result, evidence, correctionAttempts),
        }),
        remainingMs,
        this.timerApi,
        'ROUTE_DECISION_TIMEOUT',
        () => this.processOwner.cancelAll({ reason: 'route decision timeout', terminalStatus: 'FAILED' }),
      )
    }
    const adoptedAcceptedRootResults = adoptedRoot && adoptedRoot.binding &&
      adoptedRoot.binding.frontier && adoptedRoot.binding.frontier.acceptedResultIds || []
    if (adoptedAcceptedRootResults.length > 1) {
      throw new SupervisorIntegrationError(
        'CRASH_ADOPTION_CONFLICT',
        'root L0 recovery state contains more committed correction results than the one-correction contract permits',
      )
    }
    // A rotated binding has already consumed attempt 0's durable receipt.
    // Resume directly at the physical correction attempt instead of trying to
    // authorize or replay the already-consumed result a second time.
    let correctionAttempts = adoptedAcceptedRootResults.length
    while (true) {
      let submitted
      try {
        const committed = adoptedRoot && readRootReceipt(correctionAttempts)
        if (committed) armRootCorrectionRotation(committed.receiptHash)
        submitted = committed ? committed.submitted : await decide(correctionAttempts)
      } catch (error) {
        if (error.code === 'ROUTE_DECISION_TIMEOUT') {
          try { rootLease.fail(error, {}) } catch {}
          persistTerminalSession(this.budget, rootSessionId, { status: 'FAILED', evidenceHashes: [] }, error)
          await this._runtimeTransition('ROUTE_DECISION_TIMEOUT', 'RELEASING_LOCK')
          return finish({ status: 'ROUTE_DECISION_TIMEOUT', route: null, start_workers: false, resumable: true })
        }
        try { rootLease.fail(error, {}) } catch {}
        persistTerminalSession(this.budget, rootSessionId, { status: 'FAILED', evidenceHashes: [] }, error)
        throw error
      }
      if (submitted && submitted.usageStreamed !== true && submitted.usage) {
        const usageVerdict = onUsageDelta(submitted.usage)
        if (usageVerdict.continue !== true) {
          const error = new SupervisorIntegrationError('BUDGET_EXHAUSTED', 'root L0 usage exhausted the scheduler budget')
          rootLease.fail(error, {})
          this.budget.endSession(rootSessionId, { status: 'PARTIAL', evidenceHashes: [] })
          throw error
        }
      }
      const submittedAtMonotonic = this.monotonicNow()
      const result = evaluateL0Decision({
        // Model-authored wall-clock fields are evidence only.  Admission and
        // every correction share this one supervisor-owned monotonic window.
        startedAtMs: admissionStartedAt,
        submittedAtMs: submittedAtMonotonic,
        nowMs: submittedAtMonotonic,
        decision: submitted.decision,
        requestText: this.options.mission,
        correctionAttempts,
        environment: this.options.baseEnvironment || process.env,
      })
      if (result.status === 'ROUTE_DECISION_INVALID' && result.correction_allowed) {
        await this._runtimeTransition('ROUTE_DECISION_INVALID_FIRST', 'L0_ROUTE_DECISION')
        correctionAttempts += 1
        rootContinuationId = null
        continue
      }
      if (result.decision && this.record.write) {
        writeRouteDecisionArtifacts(this.record, result.decision)
      }
      rootLease.complete({})
      this.recoveryThreads.delete(rootLease.id)
      persistRootCheckpoint('LEASE_COMPLETED')
      this.budget.endSession(rootSessionId, {
        status: result.start_workers ? 'DONE' : 'FAILED',
        evidenceHashes: result.decision ? [hashText(JSON.stringify(result.decision))] : [],
      })
      if (!result.start_workers) {
        if (result.status === 'WAITING_USER') {
          await this._runtimeTransition('ROUTE_DECISION_NEEDS_USER', 'WAITING_USER')
        } else {
          await this._runtimeTransition('ROUTE_DECISION_INVALID_FINAL', 'RELEASING_LOCK')
        }
      }
      return finish(result)
    }
  }

  _activateRouteScheduler(savedState = null, decidedRoute = this.route, routeSource = this.routeSource || 'automatic') {
    this.route = decidedRoute
    this.routeSource = routeSource
    const effectiveSubs = this.settings.concurrency.effectiveMaxSubs
    const maxChildLaunches = this.options.maxChildLaunches === undefined
      ? undefined
      : Math.max(1, Number(this.options.maxChildLaunches))
    let settings = resolveSchedulerSettings({
      route: this.route,
      concurrency: this.settings.concurrency,
      liveCeiling: this.route === 'ROADMAP' && this.options.userLiveCeiling !== undefined
        ? Math.min(10, Number(this.options.userLiveCeiling), effectiveSubs + 1)
        : Math.min(effectiveSubs + 1, this.route === 'ROADMAP' ? 6 : 4),
      maxChildLaunches,
      lanes: this.options.lanes || { main: {} },
      environment: this.options.baseEnvironment || process.env,
    })
    let restoredState = savedState
    if (savedState) {
      const identity = savedState.runIdentity || {}
      if (identity.runId !== this.options.runId || Number(identity.generation) !== this.activation.generation - 1) {
        throw new SupervisorIntegrationError('RESUME_STATE_INVALID', 'saved scheduler state is not the preceding run generation')
      }
      if (savedState.routeSource !== routeSource) {
        throw new SupervisorIntegrationError('RESUME_STATE_INVALID', 'saved scheduler route source differs from the immutable decision source')
      }
      restoredState = { ...savedState, runIdentity: { runId: this.options.runId, generation: this.activation.generation } }
      settings = savedState.settings
    }
    if (this.scheduler && this.scheduler.route === 'PENDING' && !savedState) {
      this.scheduler.freezeRoute(this.route, settings)
    } else {
      this.scheduler = this.schedulerFactory({
        settings,
        routeSource,
        runIdentity: { runId: this.options.runId, generation: this.activation.generation },
        rootContextId: this.activation.id,
        state: restoredState,
        now: this.now,
        environment: this.options.baseEnvironment || process.env,
      })
      if (savedState) this.scheduler.registerRootContext(this.activation.id, { replace: true })
      this._recordBootstrapAdmission()
    }
    this.routeFrozenAt = this.now()
    this.routeFrozenMonotonicAt = this.monotonicNow()
  }

  _restorePendingScheduler(savedState) {
    const identity = savedState && savedState.runIdentity || {}
    if (savedState.route !== 'PENDING' || identity.runId !== this.options.runId ||
        Number(identity.generation) !== this.activation.generation - 1) {
      throw new SupervisorIntegrationError('RESUME_STATE_INVALID', 'pending scheduler state is not the exact preceding generation')
    }
    const restored = {
      ...savedState,
      runIdentity: { runId: this.options.runId, generation: this.activation.generation },
    }
    this.scheduler = this.schedulerFactory({
      route: 'PENDING',
      routeSource: 'automatic',
      runIdentity: restored.runIdentity,
      rootContextId: this.activation.id,
      state: restored,
      now: this.now,
      environment: this.options.baseEnvironment || process.env,
    })
    this.scheduler.registerRootContext(this.activation.id, { replace: true })
    this._recordBootstrapAdmission()
  }

  _adoptCrashScheduler(checkpoint, recoveryContext) {
    const saved = checkpoint && checkpoint.schedulerState
    if (!saved || !saved.runIdentity || !recoveryContext) {
      throw new SupervisorIntegrationError('RESUME_STATE_INVALID', 'live scheduler adoption requires exact saved state and recovery context')
    }
    const schedulerOptions = saved.route === 'PENDING'
      ? {
          route: 'PENDING',
          routeSource: 'automatic',
          runIdentity: { runId: this.options.runId, generation: this.activation.generation },
          rootContextId: this.activation.id,
          now: this.now,
          environment: this.options.baseEnvironment || process.env,
        }
      : {
          settings: saved.settings,
          routeSource: saved.routeSource,
          runIdentity: { runId: this.options.runId, generation: this.activation.generation },
          rootContextId: this.activation.id,
          now: this.now,
          environment: this.options.baseEnvironment || process.env,
        }
    this.scheduler = this.schedulerFactory(schedulerOptions)
    const adopted = this.scheduler.adoptCrashCheckpoint(checkpoint, {
      recoveryContext,
      ownerSessionId: checkpoint.ownerSessionId,
    })
    this._recordBootstrapAdmission()
    this.route = saved.route === 'PENDING' ? null : saved.route
    this.routeSource = saved.routeSource
    this.routeFrozenAt = this.route ? this.now() : null
    this.routeFrozenMonotonicAt = this.route ? this.monotonicNow() : null
    return adopted
  }

  _recordBootstrapAdmission() {
    if (!this.scheduler || typeof this.scheduler.recordAdmissionComponent !== 'function') {
      throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'scheduler lacks canonical admission accounting')
    }
    for (const name of ['configuration', 'runRecord', 'persistence']) {
      const duration = this.admissionDurations[name]
      if (duration > 0) this._recordAdmissionComponent(name, duration)
      this.admissionDurations[name] = 0
    }
  }

  _recordAdmissionComponent(name, durationMs) {
    const verdict = this.scheduler.recordAdmissionComponent(name, durationMs)
    if (!verdict || verdict.withinCeiling !== true) {
      throw new SupervisorIntegrationError(
        'ADMISSION_COMPONENT_TIMEOUT',
        `admission component exceeded the canonical ceiling: ${name}`,
        verdict || {},
      )
    }
    return verdict
  }

  async launchChild(request = {}) {
    if (!this.route || !this.scheduler) {
      throw new SupervisorIntegrationError('ROUTE_REQUIRED', 'production or checking cannot launch before the L0 route decision')
    }
    return this._launchThroughScheduler(this.scheduler, {
      ...request,
      caller: request.caller || this.rootCallers.runOwner,
      parent: request.parent || 'run-owner',
      route: this.route,
    })
  }

  async _runRepresentativePolicyProbe() {
    if (this.representativePolicyProbe) return this.representativePolicyProbe
    const workItemId = 'representative-role-policy-probe'
    const admission = admitCodexRoleSelection({
      rolePolicy: this.rolePolicy,
      selection: { parent: 'run-owner', child: 'diagnostic-probe', route: this.route },
    })
    const physicalRole = admission.policy.definition.physicalId
    const providerRole = providerRoleForLogical('diagnostic-probe')
    const executionPolicy = this.rolePolicy.bindPhysicalChild({
      logicalRole: 'diagnostic-probe', physicalRole, providerRole,
    })
    const durableProbeReceipt = typeof this.options.readResult === 'function'
      ? this.options.readResult(workItemId) : null
    if (this.recoveryCompletedWorkIds && this.recoveryCompletedWorkIds.has(workItemId) || durableProbeReceipt) {
      const receipt = durableProbeReceipt
      const { receiptHash, ...body } = receipt || {}
      const sourceGeneration = Number(receipt && receipt.generation)
      const generationIsCurrentOrCrashPredecessor = sourceGeneration === this.activation.generation ||
        sourceGeneration + 1 === this.activation.generation
      if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== 'representative-policy-probe-result' ||
          receiptHash !== hashText(stableStringify(body)) || receipt.runId !== this.options.runId ||
          receipt.activationId !== this.activation.id || !generationIsCurrentOrCrashPredecessor ||
          receipt.workItemId !== workItemId || receipt.logicalRole !== 'diagnostic-probe' ||
          receipt.physicalRole !== physicalRole || receipt.providerRole !== providerRole ||
          receipt.requestEnvelopeHash !== (this.requestPointer && this.requestPointer.hash) ||
          !representativePolicyProbePassed(receipt.result) ||
          receipt.resultHash !== hashText(stableStringify(receipt.result))) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          'completed representative policy probe lacks an exact activation-, generation-, assignment-, and request-bound PASS result',
        )
      }
      validateCanonicalChildResult({
        workItemId, logicalRole: 'diagnostic-probe', physicalRole,
      }, receipt.result, this.options.runId, this.requestPointer.hash)
      this.diagnosticWorkerLaunches = Math.max(1, this.diagnosticWorkerLaunches)
      this.representativePolicyProbe = Object.freeze({
        verified: true,
        logicalRole: 'diagnostic-probe',
        physicalRole,
        providerRole,
        evidenceHash: receipt.resultHash,
        recoveredFromGeneration: sourceGeneration,
      })
      return this.representativePolicyProbe
    }
    const result = await this.launchChild({
      workItemId,
      logicalRole: 'diagnostic-probe', parent: 'run-owner', purpose: 'diagnostic',
      assignment: 'Run one bounded read-only representative role policy probe against the active target.',
      ownership: ['workspace'],
      success: ['Return PASS with concrete command or inspection evidence from the active target.'],
      checks: ['No mutation, dispatch, or external operation is permitted.'],
      bounded: true, nextReadyAfter: [],
    })
    if (!representativePolicyProbePassed(result)) {
      throw new SupervisorIntegrationError(
        'DIAGNOSTIC_DENIAL_BLOCKED',
        'the mandatory representative role/policy probe was denied before the worker group launched',
        { workerCount: Math.max(1, this.diagnosticWorkerLaunches), logicalRole: 'diagnostic-probe', physicalRole, providerRole },
      )
    }
    this.diagnosticWorkerLaunches = Math.max(1, this.diagnosticWorkerLaunches)
    const resultHash = hashText(stableStringify(result))
    this.representativePolicyProbe = Object.freeze({
      verified: true,
      logicalRole: 'diagnostic-probe',
      physicalRole,
      providerRole,
      evidenceHash: resultHash,
    })
    if (this.record && typeof this.record.write === 'function') {
      const body = {
        schemaVersion: 1,
        kind: 'representative-policy-probe-result',
        runId: this.options.runId,
        activationId: this.activation.id,
        generation: this.activation.generation,
        workItemId,
        logicalRole: 'diagnostic-probe',
        physicalRole,
        providerRole,
        requestEnvelopeHash: this.requestPointer.hash,
        result,
        resultHash,
      }
      const receipt = { ...body, receiptHash: hashText(stableStringify(body)) }
      this.record.write(`work/results/${hashText(workItemId)}.json`, `${JSON.stringify(receipt, null, 2)}\n`)
    }
    return this.representativePolicyProbe
  }

  recordUserWait(durationMs) {
    if (!this.scheduler || typeof this.scheduler.recordAdmissionComponent !== 'function') {
      throw new SupervisorIntegrationError('ROUTE_REQUIRED', 'user wait accounting requires the one run-global scheduler')
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new SupervisorIntegrationError('INVALID_ADMISSION_DURATION', 'user wait duration must be monotonic and non-negative')
    }
    return this.scheduler.recordAdmissionComponent('waitingUser', durationMs)
  }

  _checkpointAccounting(cause, delta) {
    const authority = this.options.accountingAuthority
    if (!authority) return null
    if (typeof authority.checkpoint !== 'function') {
      throw new SupervisorIntegrationError('RUN_RECORD_SCHEMA_INCOMPATIBLE', 'accounting authority lacks checkpoint()')
    }
    return authority.checkpoint({ capability: this.lease, cause, delta: accountingDelta(delta) })
  }

  _persistRecoveryCheckpoint(cause, hints = {}) {
    if (typeof this.options.persistRecoveryCheckpoint !== 'function' || !this.scheduler) return null
    const metrics = this.scheduler.getMetrics()
    const hasLiveModelSession = metrics.counters.currentLiveChildren > 0 || metrics.rootAccounting.status === 'live'
    const schedulerCheckpoint = hints.schedulerCheckpoint || (hasLiveModelSession
      ? this.scheduler.exportCrashCheckpoint({ ownerSessionId: this.rootCallers.controlPlane.sessionId })
      : this.scheduler.exportState())
    const hintedFrontier = hints.recoveryFrontier || {}
    const acceptedResultIds = [...new Set([
      ...this.recoveryAcceptedResultIds,
      ...(hintedFrontier.acceptedResultIds || []),
    ])].sort()
    for (const resultId of acceptedResultIds) this.recoveryAcceptedResultIds.add(resultId)
    const persisted = this.options.persistRecoveryCheckpoint({
      cause,
      schedulerCheckpoint,
      route: this.scheduler.route,
      hasLiveModelSession,
      candidateHash: hints.candidateHash === undefined ? null : hints.candidateHash,
      candidateId: hints.candidateId || null,
      completedWorkIds: [...this.recoveryCompletedWorkIds].sort(),
      completedCheckIds: [...this.recoveryCompletedCheckIds].sort(),
      nextReadyWorkIds: hints.nextReadyWorkIds || [],
      openCheckIds: hints.openCheckIds || [],
      recoveryFrontier: { ...hintedFrontier, acceptedResultIds },
      threadEvidence: Object.fromEntries([...this.recoveryThreads.entries()]),
      externalOperations: [...this.recoveryExternalOperations.values()].sort((left, right) =>
        left.operationId.localeCompare(right.operationId)),
      humanDescription: hints.humanDescription || cause.humanDescription,
    })
    this.latestRecoveryCheckpoint = persisted
    return persisted
  }

  completeRetainedLease(retained) {
    if (!retained || !retained.schedulerLease || retained.completed === true) {
      throw new SupervisorIntegrationError('SCHEDULER_LEASE_INVALID', 'a live retained parent lease is required')
    }
    retained.schedulerLease.complete({})
    retained.completed = true
    if (retained.isChecker) this.recoveryCompletedCheckIds.add(retained.workItemId)
    else this.recoveryCompletedWorkIds.add(retained.workItemId)
    this.recoveryThreads.delete(retained.schedulerLease.id)
    this._persistRecoveryCheckpoint({
      kind: retained.isChecker ? 'CHECK_COMPLETED' : 'LEASE_COMPLETED',
      causeId: `retained:${this.activation.generation}:${retained.schedulerLease.id}:completed`,
      humanDescription: 'Persist retained parent completion only after its scheduler lease and result are durable.',
    }, { candidateHash: retained.candidateHash || null })
    return true
  }

  _terminalReceiptLocation(leaseId, workItemId) {
    return `work/results/terminal-receipt-${hashText(`${leaseId}\0${workItemId}`)}.json`
  }

  _workerContextLocation(workItemId) {
    return `work/results/context-${hashText(workItemId)}.json`
  }

  _restoreCompletedWorkerContexts() {
    if (!this.options.resumeState || !this.record || typeof this.record.resolve !== 'function') return
    const completed = new Set([
      ...(this.options.resumeState.completedWorkIds || []),
      ...(this.options.resumeState.completedCheckIds || []),
    ])
    for (const workItemId of completed) {
      const absolute = this.record.resolve(this._workerContextLocation(workItemId))
      if (!fs.existsSync(absolute)) continue
      const pointer = readRegularJson(absolute, 'completed worker continuation pointer').parsed
      if (!pointer || pointer.schemaVersion !== 2 || pointer.workItemId !== workItemId ||
          !/^[a-f0-9]{64}$/.test(pointer.contentHash || '') ||
          pointer.contentPath !== `runtime/blobs/${pointer.contentHash}`) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `completed worker continuation pointer for ${workItemId} is foreign or corrupt`,
        )
      }
      const contentPath = this.record.resolve(pointer.contentPath)
      if (!fs.existsSync(contentPath)) {
        throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `completed worker continuation blob is missing: ${workItemId}`)
      }
      const saved = readRegularJson(contentPath, 'content-addressed worker continuation').parsed
      const { contentHash, ...contentBody } = saved || {}
      if (!saved || saved.schemaVersion !== 2 || contentHash !== pointer.contentHash ||
          contentHash !== hashText(stableStringify(contentBody)) || saved.workItemId !== workItemId ||
          saved.runId !== this.options.runId || saved.activationId !== this.activation.id ||
          saved.requestEnvelopeHash !== this.requestPointer.hash || saved.missionHash !== this.activation.missionHash ||
          typeof saved.logicalRole !== 'string' || !saved.logicalRole ||
          typeof saved.executorKey !== 'string' || !saved.executorKey ||
          typeof saved.contextId !== 'string' || !saved.contextId ||
          !/^[a-f0-9]{64}$/.test(saved.contextBindingHash || '') ||
          !/^[a-f0-9]{64}$/.test(saved.terminalReceiptHash || '') ||
          typeof saved.terminalReceiptPath !== 'string') {
        throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `completed worker continuation blob is foreign or corrupt: ${workItemId}`)
      }
      const identity = {
        schemaVersion: 1,
        runId: saved.runId,
        activationId: saved.activationId,
        requestEnvelopeHash: saved.requestEnvelopeHash,
        missionHash: saved.missionHash,
        workItemId: saved.workItemId,
        logicalRole: saved.logicalRole,
        executorKey: saved.executorKey,
        contextId: saved.contextId,
      }
      if (saved.contextBindingHash !== hashText(stableStringify(identity))) {
        throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `completed worker continuation identity changed: ${workItemId}`)
      }
      const receiptPath = this.record.resolve(saved.terminalReceiptPath)
      if (!fs.existsSync(receiptPath)) {
        throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `worker continuation receipt is missing: ${workItemId}`)
      }
      const receipt = readRegularJson(receiptPath, 'worker continuation terminal receipt').parsed
      const { receiptHash, ...receiptBody } = receipt || {}
      const acceptedResultIds = new Set(this.options.resumeState.acceptedResultIds || [])
      if (!receipt || receiptHash !== saved.terminalReceiptHash || receiptHash !== hashText(JSON.stringify(receiptBody)) ||
          !acceptedResultIds.has(receiptHash) ||
          receipt.runId !== saved.runId || receipt.activationId !== saved.activationId ||
          receipt.workItemId !== saved.workItemId || receipt.logicalRole !== saved.logicalRole ||
          receipt.executorKey !== saved.executorKey || receipt.continuationId !== saved.contextId ||
          receipt.workerContextBindingHash !== saved.contextBindingHash ||
          receipt.assignmentHash !== saved.assignmentHash || receipt.resultHash !== saved.resultHash ||
          !receipt.result || receipt.result.contextId !== saved.contextId) {
        throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `worker continuation receipt binding changed: ${workItemId}`)
      }
      this.workerContexts.set(workItemId, {
        executorKey: saved.executorKey,
        contextId: saved.contextId,
        logicalRole: saved.logicalRole,
        contextBindingHash: saved.contextBindingHash,
      })
    }
  }

  _verifyDurableResultReceipt(workItemId, expectedResult) {
    if (!this.options.resumeState || !this.record || typeof this.record.resolve !== 'function') {
      throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', 'durable result receipt verification requires crash recovery state')
    }
    const pointerPath = this.record.resolve(this._workerContextLocation(workItemId))
    if (!fs.existsSync(pointerPath)) {
      throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `durable result continuation pointer is missing: ${workItemId}`)
    }
    const pointer = readRegularJson(pointerPath, 'durable result continuation pointer').parsed
    if (!pointer || pointer.schemaVersion !== 2 || pointer.workItemId !== workItemId ||
        !/^[a-f0-9]{64}$/u.test(pointer.contentHash || '') ||
        pointer.contentPath !== `runtime/blobs/${pointer.contentHash}`) {
      throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `durable result continuation pointer is corrupt: ${workItemId}`)
    }
    const contentPath = this.record.resolve(pointer.contentPath)
    if (!fs.existsSync(contentPath)) {
      throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `durable result continuation blob is missing: ${workItemId}`)
    }
    const saved = readRegularJson(contentPath, 'durable result continuation blob').parsed
    const { contentHash, ...contentBody } = saved || {}
    if (!saved || contentHash !== pointer.contentHash || contentHash !== hashText(stableStringify(contentBody)) ||
        saved.workItemId !== workItemId || saved.runId !== this.options.runId ||
        saved.activationId !== this.activation.id || saved.requestEnvelopeHash !== this.requestPointer.hash ||
        saved.missionHash !== this.activation.missionHash ||
        !/^[a-f0-9]{64}$/u.test(saved.terminalReceiptHash || '') ||
        typeof saved.terminalReceiptPath !== 'string') {
      throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `durable result continuation binding changed: ${workItemId}`)
    }
    const receiptPath = this.record.resolve(saved.terminalReceiptPath)
    if (!fs.existsSync(receiptPath)) {
      throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `durable result terminal receipt is missing: ${workItemId}`)
    }
    const receipt = readRegularJson(receiptPath, 'durable result terminal receipt').parsed
    const { receiptHash, ...receiptBody } = receipt || {}
    const expectedResultHash = hashText(JSON.stringify(expectedResult))
    const acceptedResultIds = new Set(this.options.resumeState.acceptedResultIds || [])
    if (!receipt || receiptHash !== saved.terminalReceiptHash || receiptHash !== hashText(JSON.stringify(receiptBody)) ||
        !acceptedResultIds.has(receiptHash) || receipt.workItemId !== workItemId ||
        receipt.runId !== saved.runId || receipt.activationId !== saved.activationId ||
        receipt.assignmentHash !== saved.assignmentHash || receipt.resultHash !== saved.resultHash ||
        receipt.resultHash !== expectedResultHash || hashText(JSON.stringify(receipt.result)) !== expectedResultHash ||
        stableStringify(receipt.result) !== stableStringify(expectedResult)) {
      throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', `durable result differs from its committed terminal receipt: ${workItemId}`)
    }
    return receipt
  }

  _persistWorkerContext(workItemId, executorKey, contextId, logicalRole, terminalReceipt = null, terminalReceiptPath = null) {
    if (![workItemId, executorKey, contextId, logicalRole].every(value => typeof value === 'string' && value.length > 0)) {
      throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', 'completed worker continuation binding is incomplete')
    }
    const identity = {
      schemaVersion: 1,
      runId: this.options.runId,
      activationId: this.activation.id,
      requestEnvelopeHash: this.requestPointer.hash,
      missionHash: this.activation.missionHash,
      workItemId,
      logicalRole,
      executorKey,
      contextId,
    }
    const contextBindingHash = hashText(stableStringify(identity))
    const completedContext = { executorKey, contextId, logicalRole, contextBindingHash }
    this.workerContexts.set(workItemId, completedContext)
    if (terminalReceipt && this.record && typeof this.record.write === 'function') {
      const { receiptHash, ...receiptBody } = terminalReceipt
      if (!terminalReceiptPath || receiptHash !== hashText(JSON.stringify(receiptBody)) ||
          terminalReceipt.runId !== identity.runId || terminalReceipt.activationId !== identity.activationId ||
          terminalReceipt.workItemId !== workItemId || terminalReceipt.logicalRole !== logicalRole ||
          terminalReceipt.executorKey !== executorKey || terminalReceipt.continuationId !== contextId ||
          terminalReceipt.workerContextBindingHash !== contextBindingHash ||
          !terminalReceipt.result || terminalReceipt.result.contextId !== contextId) {
        throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', 'terminal receipt does not bind the completed worker continuation')
      }
      const contentBody = {
        ...identity,
        schemaVersion: 2,
        contextBindingHash,
        terminalReceiptPath,
        terminalReceiptHash: receiptHash,
        assignmentHash: terminalReceipt.assignmentHash,
        resultHash: terminalReceipt.resultHash,
      }
      const contentHash = hashText(stableStringify(contentBody))
      const contentPath = `runtime/blobs/${contentHash}`
      const contentRecord = { ...contentBody, contentHash }
      const absoluteContent = this.record.resolve(contentPath)
      if (fs.existsSync(absoluteContent)) {
        if (stableStringify(readRegularJson(absoluteContent, 'worker continuation blob').parsed) !== stableStringify(contentRecord)) {
          throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', 'worker continuation content address collided')
        }
      } else {
        this.record.write(contentPath, `${JSON.stringify(contentRecord, null, 2)}\n`)
      }
      this.record.write(this._workerContextLocation(workItemId), `${JSON.stringify({
        schemaVersion: 2, workItemId, contentHash, contentPath,
      }, null, 2)}\n`)
    }
    return completedContext
  }

  _readTerminalReceipt(saved, runtimeCandidateHash) {
    if (!this.record || typeof this.record.resolve !== 'function') return null
    const relative = this._terminalReceiptLocation(saved.id, saved.workItemId)
    const absolute = this.record.resolve(relative)
    if (!fs.existsSync(absolute)) return null
    const receipt = readRegularJson(absolute, 'model terminal receipt').parsed
    const { receiptHash, ...body } = receipt || {}
    const binding = saved.crashBinding || {}
    if (!receipt || receipt.schemaVersion !== 1 ||
        receiptHash !== hashText(JSON.stringify(body)) ||
        receipt.runId !== this.options.runId || receipt.activationId !== this.activation.id ||
        receipt.leaseId !== saved.id || receipt.workItemId !== saved.workItemId ||
        receipt.assignmentId !== saved.workItemId ||
        receipt.logicalRole !== saved.logicalRole || receipt.providerRole !== saved.role ||
        receipt.executorKey !== (saved.equivalenceKey || saved.workItemId) ||
        typeof receipt.retainLease !== 'boolean' ||
        !/^[a-f0-9]{64}$/.test(receipt.assignmentHash || '') ||
        receipt.sessionId !== binding.sessionId ||
        receipt.continuationId !== binding.continuationId ||
        receipt.requestEnvelopeHash !== this.requestPointer.hash ||
        receipt.resultHash !== hashText(JSON.stringify(receipt.result)) ||
        (CHECKER_ROLES.has(saved.logicalRole) &&
          (saved.inspectedCandidateHash !== receipt.result.candidateHash ||
           saved.inspectedCandidateHash !== receipt.result.currentVersionHash ||
           receipt.candidateHash !== (runtimeCandidateHash || null))) ||
        (!CHECKER_ROLES.has(saved.logicalRole) &&
          receipt.candidateHash !== (receipt.result && receipt.result.candidateHash || null)) ||
        (saved.logicalRole !== 'route-analyst' &&
          (!/^[a-f0-9]{64}$/.test(receipt.workerContextBindingHash || '') ||
           !receipt.result || receipt.result.contextId !== receipt.continuationId))) {
      throw new SupervisorIntegrationError(
        'CRASH_ADOPTION_CONFLICT',
        `terminal receipt for adopted lease ${saved.id} is foreign or corrupt`,
      )
    }
    validateCanonicalChildResult({
      workItemId: saved.workItemId,
      logicalRole: saved.logicalRole,
      physicalRole: receipt.physicalRole,
      candidateHash: CHECKER_ROLES.has(saved.logicalRole)
        ? saved.inspectedCandidateHash
        : receipt.candidateHash,
    }, receipt.result, this.options.runId, this.requestPointer.hash)
    if (saved.logicalRole !== 'route-analyst') {
      const assignmentPath = this.record.resolve(`work/assignments/${hashText(saved.workItemId)}.json`)
      if (!fs.existsSync(assignmentPath) ||
          hashText(JSON.stringify(readRegularJson(assignmentPath, 'adopted canonical assignment').parsed)) !==
            receipt.assignmentHash) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `terminal receipt for adopted lease ${saved.id} differs from its persisted assignment`,
        )
      }
    }
    return receipt
  }

  _writeCanonicalResult(workItemId, result, relative = null) {
    if (!this.record || typeof this.record.write !== 'function' ||
        typeof this.record.resolve !== 'function') return null
    const canonicalRelative = relative || `work/results/${hashText(workItemId)}.json`
    const expectedRelative = `work/results/${hashText(workItemId)}.json`
    if (canonicalRelative !== expectedRelative) {
      throw new SupervisorIntegrationError(
        'CRASH_ADOPTION_CONFLICT',
        `canonical result location differs for ${workItemId}`,
      )
    }
    const absolute = this.record.resolve(canonicalRelative)
    if (fs.existsSync(absolute)) {
      const existing = readRegularJson(absolute, `canonical result ${workItemId}`).parsed
      if (stableStringify(existing) !== stableStringify(result)) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `canonical result changed after first durable persistence for ${workItemId}`,
        )
      }
    } else {
      this.record.write(canonicalRelative, `${JSON.stringify(result, null, 2)}\n`)
    }
    return canonicalRelative
  }

  async _resumeAdoptedLaunches({ resumeState, candidateHash, decision, stage }) {
    if (!this.adoptedCrashScheduler || !resumeState || !resumeState.schedulerCrashCheckpoint) return {}
    const results = {}
    const openIds = new Set(resumeState.openLeaseIds || [])
    const savedRecords = new Map((resumeState.adoptedRecords || []).map(record => [record.id, record]))
    const adoptedEntries = Object.entries(this.adoptedCrashScheduler.leases || {})
      .sort(([leftId], [rightId]) => {
        const left = savedRecords.get(leftId)
        const right = savedRecords.get(rightId)
        return Number(left && left.depth || 0) - Number(right && right.depth || 0) || leftId.localeCompare(rightId)
      })
    const liveParentIds = new Set((resumeState.adoptedRecords || [])
      .map(record => record.parentLeaseId)
      .filter(Boolean))
    const retainedLeaseFor = (saved, lease) => ({
      schedulerLease: lease,
      completed: false,
      workItemId: saved.workItemId,
      isChecker: false,
      candidateHash: null,
      caller: this.rolePolicy.bindCaller({
        logicalRole: saved.logicalRole,
        physicalRole: saved.role,
        sessionId: saved.crashBinding.sessionId,
        runId: this.options.runId,
        generation: this.activation.generation,
      }),
    })
    for (const [leaseId, lease] of adoptedEntries) {
      const saved = savedRecords.get(leaseId)
      if (!saved || !saved.crashBinding) {
        throw new SupervisorIntegrationError(
          'PROVIDER_UNSUPPORTED',
          `adopted lease ${leaseId} lacks its durable process/session binding`,
        )
      }
      const checker = CHECKER_ROLES.has(saved.logicalRole)
      if (!adoptedLeaseMatchesStage(this.route, saved.logicalRole, stage)) continue
      const committed = this._readTerminalReceipt(saved, candidateHash)
      const retainedParent = !checker && (liveParentIds.has(leaseId) || committed && committed.retainLease === true)
      if (committed) {
        if (saved.logicalRole !== 'route-analyst') {
          this._writeCanonicalResult(saved.workItemId, committed.result)
        }
        if (saved.logicalRole !== 'route-analyst') {
          this._persistWorkerContext(
            saved.workItemId,
            saved.equivalenceKey || saved.workItemId,
            committed.continuationId || saved.crashBinding.continuationId || saved.crashBinding.sessionId,
            saved.logicalRole,
            committed,
            this._terminalReceiptLocation(saved.id, saved.workItemId),
          )
        } else {
          const recommendationRelative = 'route/recommendation.json'
          const recommendationAbsolute = this.record.resolve(recommendationRelative)
          const recommendation = committed.result.recommendation
          if (fs.existsSync(recommendationAbsolute)) {
            if (stableStringify(readRegularJson(
              recommendationAbsolute, 'adopted route recommendation',
            ).parsed) !== stableStringify(recommendation)) {
              throw new SupervisorIntegrationError(
                'CRASH_ADOPTION_CONFLICT',
                'adopted route recommendation differs from its exact terminal receipt',
              )
            }
          } else {
            this.record.write(recommendationRelative, `${JSON.stringify(recommendation, null, 2)}\n`)
          }
        }
        if (!this.recoveryAcceptedResultIds.has(committed.receiptHash)) {
          this.recoveryAcceptedResultIds.add(committed.receiptHash)
          this._persistRecoveryCheckpoint({
            kind: 'RESULT_COMMITTED',
            causeId: `adopted-result:${this.activation.generation}:${lease.id}:result:${committed.receiptHash.slice(0, 24)}`,
            humanDescription: 'Authenticate the exact adopted terminal result before consuming it or releasing its scheduler lease.',
            resultCommit: {
              assignmentId: saved.workItemId,
              assignmentHash: committed.assignmentHash,
              leaseId,
              sessionId: committed.sessionId,
              continuationId: committed.continuationId,
              resultHash: committed.resultHash,
              receiptHash: committed.receiptHash,
              candidateHash: committed.candidateHash,
            },
          }, {
            recoveryFrontier: {
              resumeState: resumeState.resumeState,
              nextReadyWorkIds: resumeState.nextReadyWorkIds || [],
              openCheckIds: resumeState.openCheckIds || [],
              acceptedResultIds: [committed.receiptHash],
            },
            nextReadyWorkIds: durableNextReadyAfter(
              saved.logicalRole,
              committed.result,
              resumeState.nextReadyWorkIds || [],
              [],
              saved.workItemId,
            ),
            openCheckIds: resumeState.openCheckIds || [],
            candidateHash: committed.candidateHash,
          })
        }
        if (retainedParent) {
          results[saved.workItemId] = {
            ...committed.result,
            retainedLease: retainedLeaseFor(saved, lease),
          }
        } else {
          lease.complete({})
          const checkerPassed = checkerVerdictPassed(saved.logicalRole, committed.result)
          if (checkerPassed) addCanonicalCompletedChecker(this.recoveryCompletedCheckIds, saved.workItemId)
          else if (!checker) this.recoveryCompletedWorkIds.add(saved.workItemId)
          this.recoveryThreads.delete(lease.id)
          this._persistRecoveryCheckpoint({
            kind: checker ? (checkerPassed ? 'CHECK_COMPLETED' : 'FRONTIER_CHANGED') : 'LEASE_COMPLETED',
            causeId: `adopted-result:${this.activation.generation}:${lease.id}`,
            humanDescription: 'Complete an adopted lease from its exact durable terminal receipt without a second model turn.',
          }, {
            candidateHash: committed.candidateHash,
            nextReadyWorkIds: durableNextReadyAfter(
              saved.logicalRole,
              committed.result,
              resumeState.nextReadyWorkIds || [],
              [],
              saved.workItemId,
            ),
            openCheckIds: [],
          })
          results[saved.workItemId] = committed.result
        }
        continue
      }
      if (!openIds.has(leaseId)) {
        // A retained ROADMAP coordinator/manager has already produced its
        // durable result, but its scheduler lease remains live solely to own
        // the child topology.  Adopt that exact lease without relaunching its
        // model session.
        if (retainedParent) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
            `retained parent ${leaseId} has no exact durable terminal receipt`,
          )
        }
        if (saved.crashBinding.continuationId) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
            `adopted lease ${leaseId} lost its OPEN thread evidence without a terminal receipt`,
          )
        }
        // Admission was durable but no Codex thread was ever observed.  The
        // old process group is proven drained before scheduler adoption, so
        // start the same admitted lease/session once without incrementing the
        // scheduler launch/session counters.
      }
      const parentSaved = saved.parentLeaseId ? savedRecords.get(saved.parentLeaseId) : null
      const parentLease = saved.parentLeaseId
        ? this.adoptedCrashScheduler.leases[saved.parentLeaseId]
        : null
      if (saved.parentLeaseId && (!parentSaved || !parentLease)) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `adopted lease ${leaseId} lacks its exact live parent topology`,
        )
      }
      const routeAnalyst = saved.logicalRole === 'route-analyst'
      const roadmapPlanning = this.route === 'ROADMAP' &&
        ['roadmap-author', 'scout'].includes(saved.logicalRole)
      const parentLogicalRole = parentSaved
        ? parentSaved.logicalRole
        : routeAnalyst ? 'deterministic-control-plane' : 'run-owner'
      const expectedCaller = saved.caller || {}
      const caller = this.rolePolicy.bindCaller({
        logicalRole: parentLogicalRole,
        physicalRole: expectedCaller.role,
        sessionId: expectedCaller.sessionId,
        runId: this.options.runId,
        generation: this.activation.generation,
      })
      const indexMatch = /([0-9]+)$/.exec(saved.workItemId)
      const index = indexMatch ? Math.max(0, Number(indexMatch[1]) - 1) : 0
      const capturedDomainContracts = Array.isArray(decision.capturedDomainContracts)
        ? decision.capturedDomainContracts : []
      const assignedDomainContracts = index === 0 ? capturedDomainContracts : []
      const replayChecks = deterministicChecksForDecision(decision, this.route)
      const resumedPlanPointer = saved.logicalRole === 'plan-checker' && typeof this.options.planPointer === 'function'
        ? this.options.planPointer('ROADMAP') : null
      if (resumedPlanPointer && saved.inspectedCandidateHash !== resumedPlanPointer.sha256) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          'resumed plan checker differs from its admitted ROADMAP pointer',
        )
      }
      const resumedCandidateHash = resumedPlanPointer ? resumedPlanPointer.sha256 : candidateHash
      const resumedOracle = resumedPlanPointer
        ? roadmapPlanOracleForWorkItem(saved.workItemId)
        : `independent-check-${index + 1}`
      const resumedCheckerAssignment = (decision.independentCheckingPlan &&
        decision.independentCheckingPlan.responsibilities[index]) ||
        'Resume the exact interrupted independent check.'
      const replayedAssignment = routeAnalyst ? null : readPersistedWorkerAssignment(this.record, saved.workItemId, {
        runId: this.options.runId,
        requestEnvelopeHash: this.requestPointer.hash,
        logicalRoleId: saved.logicalRole,
      })
      const resumedWorkerMatch = /^work-(\d+)$/u.exec(String(saved.workItemId || ''))
      const resumedWorkerOwner = resumedWorkerMatch ? `worker-${resumedWorkerMatch[1]}` : null
      const resumedExecutionOwnership = executionMutableResourceOwnership(
        decision,
        this.route,
        Math.max(1, Number(decision.usefulWorkerCount || 1)),
      )
      const resumedWorkerOwnership = resumedWorkerOwner
        ? resumedExecutionOwnership
            .filter(item => item && item.owner === resumedWorkerOwner)
            .map(item => ({ ...item }))
        : []
      const request = routeAnalyst ? {
        workItemId: 'route-analyst',
        logicalRole: 'route-analyst',
        parent: 'deterministic-control-plane',
        purpose: 'planning',
        lane: 'routeAnalyst',
        assignment: 'Inspect only enough read-only project evidence to recommend DIRECT, LIGHT, or ROADMAP.',
        successChecklist: ['Return the required route recommendation schema.'],
        checks: ['Read/list/search only; do not mutate or dispatch.'],
      } : checker ? {
        workItemId: saved.workItemId,
        logicalRole: saved.logicalRole,
        parent: 'run-owner',
        purpose: saved.purpose || 'verification',
        assignment: assignedDomainContracts.length > 0
          ? `${resumedCheckerAssignment} Return every declared captured-domain result in payload.capturedDomainOutcomes.`
          : resumedCheckerAssignment,
        candidateHash: resumedCandidateHash,
        oracle: resumedOracle,
        isolation: 'snapshot',
        writeProducing: true,
        success: decision.successChecklist || [],
        checks: replayChecks,
        risks: decision.risks || [],
        fetchedEvidence: {
          verificationDoctrine: CHECKER_FALSIFICATION_DOCTRINE,
          ...(assignedDomainContracts.length > 0
            ? { capturedDomainContracts: assignedDomainContracts } : {}),
        },
        ...(resumedPlanPointer ? { roadmapSlice: resumedPlanPointer } : {}),
        ...(resumedPlanPointer ? {
          adoptedProjectionIdentity: {
            runId: this.options.runId,
            generation: Number(resumeState.schedulerCrashCheckpoint.runIdentity &&
              resumeState.schedulerCrashCheckpoint.runIdentity.generation),
            checkerId: resumedOracle,
          },
        } : {}),
        firstResponsibility: decision.independentCheckingPlan && decision.independentCheckingPlan.responsibilities[0],
        secondResponsibility: decision.independentCheckingPlan && decision.independentCheckingPlan.responsibilities[1],
        harnessAttestation: this.options.harnessAttestation
          ? this.options.harnessAttestation(resumedCandidateHash, resumedOracle)
          : undefined,
        adoptedSandboxResources: saved.resources,
      } : roadmapPlanning ? {
        workItemId: saved.workItemId,
        logicalRole: saved.logicalRole,
        parent: parentLogicalRole,
        purpose: saved.purpose || (saved.logicalRole === 'scout' ? 'scouting' : 'planning'),
        assignment: saved.logicalRole === 'scout'
          ? `Resume only the named ROADMAP unknown bound to ${saved.workItemId}.`
          : saved.workItemId.includes('repair')
            ? 'Resume the same-author ROADMAP repair from its exact continuation.'
            : saved.workItemId.includes('revise')
              ? 'Resume the same-author ROADMAP scout-join revision from its exact continuation.'
              : `Resume the dependency-ordered roadmap for: ${decision.requestedResult}`,
        ownership: saved.logicalRole === 'roadmap-author'
          ? [{ kind: 'output', identity: 'plan/ROADMAP.md', owner: saved.workItemId }]
          : ['workspace'],
        success: decision.successChecklist || [],
        checks: replayChecks,
      } : {
        workItemId: saved.workItemId,
        logicalRole: saved.logicalRole || 'worker',
        parent: parentLogicalRole,
        purpose: saved.purpose || 'work',
        assignment: decision.workerResponsibilities && decision.workerResponsibilities[index] || decision.requestedResult,
        ownership: resumedWorkerOwnership.length ? resumedWorkerOwnership : ['workspace'],
        success: decision.successChecklist || [],
        checks: replayChecks,
        retainLease: retainedParent,
      }
      const replayRequest = replayedAssignment ? replayRequestFromPersistedAssignment(replayedAssignment) : null
      if (replayRequest && resumedWorkerOwner) {
        const authorityTuple = item => stableStringify({
          kind: item && item.kind,
          identity: item && item.identity,
          owner: item && item.owner,
          ownershipMode: item && (item.ownershipMode || item.ownership_mode || 'single-owner'),
        })
        const expectedAuthority = resumedWorkerOwnership.map(authorityTuple).sort()
        const replayedAuthority = replayRequest.ownership.map(authorityTuple).sort()
        if (stableStringify(expectedAuthority) !== stableStringify(replayedAuthority)) {
          throw new SupervisorIntegrationError(
            'ASSIGNMENT_REPLAY_INVALID',
            `persisted worker assignment authority differs from the current immutable route decision: ${saved.workItemId}`,
          )
        }
      }
      results[saved.workItemId] = await this._launchThroughScheduler(this.scheduler, {
        ...request,
        ...(replayRequest || {}),
        route: routeAnalyst ? 'PRE_ROUTE' : this.route,
        parent: parentLogicalRole,
        caller,
        parentLease,
        continuationId: saved.crashBinding.continuationId,
        adoptedLease: lease,
        adoptedBinding: saved.crashBinding,
      })
    }
    return results
  }

  _deferredPromotionHandle(token, pending) {
    return Object.freeze({
      token,
      candidateHash: pending.candidateHash,
      workspacePath: pending.workspacePath,
      alreadyPromoted: pending.alreadyPromoted === true,
      status: pending.state && pending.state.status,
      acceptedJoin: pending.state && pending.state.join
        ? Object.freeze(JSON.parse(JSON.stringify(pending.state.join))) : null,
      commit: join => this._commitDeferredPromotion(token, join),
      abort: reason => this._abortDeferredPromotion(token, reason),
    })
  }

  _acceptDeferredCheckerProof(workItemId) {
    const pending = this.deferredCheckerProofs.get(workItemId)
    if (!pending) return null
    if (!this.scheduler || !this.record || typeof this.record.write !== 'function' ||
        pending.proof.cacheEligible !== false || pending.proof.result.code !== 'PASS') {
      throw new SupervisorIntegrationError(
        'CHECK_PROOF_INVALID',
        'deferred checker proof cannot be promoted after controller validation',
      )
    }
    const harnessRecord = this.scheduler.recordHarnessAttestation(pending.proof.harnessAttestation)
    const proofRecord = this.scheduler.recordProofCache(pending.proof.proofAttestation)
    const accepted = {
      ...pending.proof,
      cacheEligible: true,
      harnessRecord,
      proofRecord,
    }
    this.record.write(pending.proofRelative, `${JSON.stringify(accepted, null, 2)}\n`)
    this.deferredCheckerProofs.delete(workItemId)
    return Object.freeze({ checkKey: pending.checkKey, harnessRecord, proofRecord })
  }

  _persistDeferredPromotionState(state) {
    if (typeof this.options.writeDeferredPromotionState !== 'function') {
      throw new SupervisorIntegrationError(
        'DONE_RETRY_RECOVERY_REQUIRED',
        'deferred DONE retry promotion requires a durable state writer',
      )
    }
    const sealed = sealDeferredPromotionState(state)
    this.options.writeDeferredPromotionState(sealed)
    return sealed
  }

  _registerDeferredPromotion(pending) {
    const token = crypto.randomUUID()
    const postimages = pending.mutationAdmission.postimages.map(item => Object.freeze({
      type: item.hash === null ? 'missing' : 'file',
      path: item.path,
      hash: item.hash,
    }))
    const state = this._persistDeferredPromotionState({
      schemaVersion: 1,
      status: 'PREPARED',
      token,
      workItemId: pending.workItemId,
      candidateHash: pending.candidateHash,
      workspace: {
        workspaceId: pending.workerWorkspace.workspaceId,
        workspacePath: pending.workerWorkspace.workspacePath,
        recordPath: pending.workerWorkspace.recordPath,
        bindingHash: pending.workerWorkspace.binding.bindingHash,
      },
      canonicalAssignment: pending.canonicalAssignment,
      mutationAdmission: pending.mutationAdmission,
      postimages,
      join: null,
    })
    const registered = { ...pending, token, state, postimages }
    this.deferredPromotions.set(token, registered)
    return this._deferredPromotionHandle(token, registered)
  }

  async _restoreDeferredPromotion(workItemId) {
    if (typeof this.options.readDeferredPromotionState !== 'function' ||
        typeof this.options.workerWorkspaceRecoveryFactory !== 'function') {
      throw new SupervisorIntegrationError(
        'DONE_RETRY_RECOVERY_REQUIRED',
        'CHECK_WORK resume requires durable deferred-promotion recovery dependencies',
      )
    }
    const state = assertDeferredPromotionState(this.options.readDeferredPromotionState())
    if (state.workItemId !== workItemId || state.status === 'ABORTED') {
      throw new SupervisorIntegrationError(
        'DONE_RETRY_RECOVERY_INVALID',
        'deferred promotion state does not identify the resumable DONE retry worker',
      )
    }
    const existing = this.deferredPromotions.get(state.token)
    if (existing) return this._deferredPromotionHandle(state.token, existing)
    const workerWorkspace = await this.options.workerWorkspaceRecoveryFactory({
      assignment: state.canonicalAssignment,
      workItemId,
      recordPath: state.workspace.recordPath,
    })
    if (!workerWorkspace || workerWorkspace.workspaceId !== state.workspace.workspaceId ||
        path.resolve(workerWorkspace.workspacePath) !== path.resolve(state.workspace.workspacePath) ||
        workerWorkspace.binding.bindingHash !== state.workspace.bindingHash) {
      throw new SupervisorIntegrationError(
        'DONE_RETRY_RECOVERY_INVALID',
        'reopened worker workspace differs from the durable deferred-promotion binding',
      )
    }
    const journal = readChecksummedJson(workerWorkspace.recordPath)
    const targetCandidateHash = hashWorkspaceCandidate(
      this.options.targetPath,
      this.options.gitEnvironment(this.options.targetPath),
    )
    let alreadyPromoted = ['COMMITTED', 'FINALIZED'].includes(journal.status)
    if (alreadyPromoted) {
      if (targetCandidateHash !== state.candidateHash) {
        throw new SupervisorIntegrationError(
          'CONCURRENT_MUTATION',
          'committed deferred-promotion journal does not match the target exact version',
        )
      }
      for (const postimage of state.postimages) {
        const current = postimage.type === 'missing'
          ? (fs.existsSync(postimage.path) ? 'present' : null)
          : resourceStateEntry(this.options.targetPath, {
              kind: 'file', identity: path.relative(this.options.targetPath, postimage.path).replace(/\\/g, '/'),
            })?.hash
        if ((postimage.type === 'missing' ? current !== null : current !== postimage.hash)) {
          throw new SupervisorIntegrationError(
            'CONCURRENT_MUTATION',
            'committed deferred-promotion postimage changed before recovery',
          )
        }
      }
      if (state.status === 'PROMOTED' && journal.status === 'COMMITTED') {
        workerWorkspace.manager.finalize(workerWorkspace)
      }
    } else if (!['PREPARED', 'ROLLED_BACK'].includes(journal.status)) {
      throw new SupervisorIntegrationError(
        'DONE_RETRY_RECOVERY_INVALID',
        `worker promotion journal cannot recover from ${journal.status}`,
      )
    }
    let mutationPermit = null
    if (!alreadyPromoted) {
      const inspected = workerWorkspace.manager.inspect(workerWorkspace, {
        filesChanged: state.mutationAdmission.actualFilesChanged,
      })
      if (stableStringify(inspected) !== stableStringify(state.mutationAdmission) ||
          hashWorkspaceCandidate(workerWorkspace.workspacePath,
            this.options.gitEnvironment(workerWorkspace.workspacePath)) !== state.candidateHash) {
        throw new SupervisorIntegrationError(
          'DONE_RETRY_RECOVERY_INVALID',
          'private DONE retry version changed before resumed acceptance',
        )
      }
      const preimages = state.canonicalAssignment.resources
        .filter(resource => resource.access !== 'read')
        .map(resource => resourceStateEntry(this.options.targetPath, resource))
        .filter(Boolean)
      mutationPermit = await this.options.mutationEnforcer.begin({
        assignment: state.canonicalAssignment,
        preimages,
        isolation: workerWorkspace.binding,
        workItemId,
      })
    }
    const pending = {
      token: state.token,
      state,
      candidateHash: state.candidateHash,
      workspacePath: alreadyPromoted ? this.options.targetPath : workerWorkspace.workspacePath,
      workerWorkspace,
      mutationAdmission: state.mutationAdmission,
      mutationPermit,
      canonicalAssignment: state.canonicalAssignment,
      postimages: state.postimages,
      workItemId,
      alreadyPromoted,
    }
    this.deferredPromotions.set(state.token, pending)
    return this._deferredPromotionHandle(state.token, pending)
  }

  async _commitDeferredPromotion(token, join) {
    const pending = this.deferredPromotions.get(token)
    if (!pending || !join || join.candidateHash !== pending.candidateHash ||
        !/^[a-f0-9]{64}$/.test(join.acceptanceJoinHash || '') ||
        !/^[a-f0-9]{64}$/.test(join.domainEvaluationHash || '') ||
        !Array.isArray(join.checkHashes) || join.checkHashes.length === 0 ||
        join.checkHashes.some(value => !/^[a-f0-9]{64}$/.test(value || ''))) {
      throw new SupervisorIntegrationError(
        'DONE_RETRY_ACCEPTANCE_JOIN_REQUIRED',
        'deferred DONE retry promotion requires the exact final checker and captured-domain acceptance join',
      )
    }
    if (pending.state.status === 'PROMOTED') {
      if (stableStringify(pending.state.join) !== stableStringify(join)) {
        throw new SupervisorIntegrationError(
          'DONE_RETRY_ACCEPTANCE_JOIN_REQUIRED',
          'an already promoted DONE retry can only replay its exact accepted join',
        )
      }
      this.deferredPromotions.delete(token)
      return pending.postimages
    }
    let mutationStateCommitted = false
    try {
      const acceptedState = this._persistDeferredPromotionState({
        ...pending.state,
        status: 'JOIN_ACCEPTED',
        join: JSON.parse(JSON.stringify(join)),
      })
      const promotedPostimages = pending.alreadyPromoted
        ? pending.postimages
        : pending.workerWorkspace.manager.promote(
            pending.workerWorkspace,
            pending.mutationAdmission,
          )
      if (pending.alreadyPromoted) {
        if (typeof this.options.mutationEnforcer.recoverCommit !== 'function') {
          throw new SupervisorIntegrationError(
            'DONE_RETRY_RECOVERY_REQUIRED',
            'committed physical promotion requires an authoritative recovery commit',
          )
        }
        await this.options.mutationEnforcer.recoverCommit({
          assignment: pending.canonicalAssignment,
          postimages: promotedPostimages,
          isolation: pending.workerWorkspace.binding,
          workItemId: pending.workItemId,
          journalPath: pending.workerWorkspace.recordPath,
        })
        mutationStateCommitted = true
      } else {
        await this.options.mutationEnforcer.commit({
          assignment: pending.canonicalAssignment,
          permit: pending.mutationPermit,
          postimages: promotedPostimages,
          isolation: pending.workerWorkspace.binding,
          workItemId: pending.workItemId,
        })
        mutationStateCommitted = true
      }
      this._persistDeferredPromotionState({
        ...acceptedState,
        status: 'PROMOTED',
      })
      const journal = readChecksummedJson(pending.workerWorkspace.recordPath)
      if (journal.status === 'COMMITTED') pending.workerWorkspace.manager.finalize(pending.workerWorkspace)
      this.deferredPromotions.delete(token)
      return promotedPostimages
    } catch (error) {
      if (!pending.alreadyPromoted && !mutationStateCommitted) {
        try { pending.workerWorkspace.manager.abort(pending.workerWorkspace) } catch {}
        try {
          await this.options.mutationEnforcer.abort({
            assignment: pending.canonicalAssignment,
            permit: pending.mutationPermit,
            isolation: pending.workerWorkspace.binding,
            workItemId: pending.workItemId,
            error,
          })
        } catch {}
        try { this._persistDeferredPromotionState({ ...pending.state, status: 'ABORTED' }) } catch {}
        this.deferredPromotions.delete(token)
      }
      throw error
    }
  }

  async _abortDeferredPromotion(token, reason) {
    const pending = this.deferredPromotions.get(token)
    if (!pending) return false
    const error = new SupervisorIntegrationError(
      'DONE_RETRY_NOT_PROMOTED',
      String(reason || 'DONE retry acceptance join did not pass'),
    )
    if (pending.alreadyPromoted || pending.state.status === 'PROMOTED') {
      throw new SupervisorIntegrationError(
        'DONE_RETRY_ALREADY_PROMOTED',
        'a journal-proven committed version cannot be aborted during restart reconciliation',
      )
    }
    try { pending.workerWorkspace.manager.abort(pending.workerWorkspace) } finally {
      try {
        await this.options.mutationEnforcer.abort({
          assignment: pending.canonicalAssignment,
          permit: pending.mutationPermit,
          isolation: pending.workerWorkspace.binding,
          workItemId: pending.workItemId,
          error,
        })
      } finally {
        this._persistDeferredPromotionState({ ...pending.state, status: 'ABORTED' })
        this.deferredPromotions.delete(token)
      }
    }
    return true
  }

  async _launchThroughScheduler(scheduler, request) {
    this._enforceBudgetPhase(lifecycleBudgetPhase({
      purpose: request.route === 'PRE_ROUTE' ? null : request.purpose,
    }), {
      boundary: 'child-launch',
      workItemId: request.workItemId,
      purpose: request.purpose,
    })
    this.budget.assertAvailable({
      forWork: request.purpose !== 'recovery',
      forExecution: !protectedDeadlinePurpose(request.purpose),
    })
    const caller = this.rolePolicy.bindCaller(request.caller)
    if (caller.runId !== this.options.runId || caller.generation !== this.activation.generation ||
        caller.logicalRole !== normalizeRole(request.parent)) {
      throw new SupervisorIntegrationError('CALLER_BINDING_INVALID', 'caller is not bound to the requested parent/run/generation')
    }
    const policy = admitCodexRoleSelection({
      rolePolicy: this.rolePolicy,
      selection: { parent: request.parent, child: request.logicalRole, route: request.route },
    }).policy
    if (policy.child === 'diagnostic-probe') {
      this.diagnosticWorkerLaunches += 1
      if (this.diagnosticWorkerLaunches > 1) {
        throw new SupervisorIntegrationError(
          'DIAGNOSTIC_WORKER_LIMIT',
          'a denied diagnostic may use at most one bounded worker before BLOCKED',
          { workerCount: this.diagnosticWorkerLaunches },
        )
      }
    }
    const physicalRole = policy.definition.physicalId
    const providerRole = providerRoleForLogical(policy.child)
    if (request.providerRole !== undefined && request.providerRole !== providerRole) {
      throw new SupervisorIntegrationError(
        'ROLE_POLICY_DENIED',
        `caller cannot replace the canonical Codex physical profile for ${policy.child}`,
        { expectedProviderRole: providerRole, receivedProviderRole: request.providerRole },
      )
    }
    const physicalExecutionPolicy = this.rolePolicy.bindPhysicalChild({
      logicalRole: policy.child,
      physicalRole,
      providerRole,
    })
    const findingIds = exactFindingIds(
      request.findingIds, request.finding_ids, request.assignment,
      request.successChecklist, request.success, request.checks, this.options.mission,
    )
    if (findingIds.length === 0) findingIds.push('AP-DESIGN-023')
    const common = {
      role: providerRole,
      assignment: request.assignment,
      successChecklist: request.successChecklist ?? request.success_checklist ?? request.success,
      ownership: request.ownership,
      checks: request.checks,
      dependencies: request.dependencies,
      returnShape: request.returnShape ?? request.return_shape,
      requestPointer: this.requestPointer,
      evidencePointers: request.evidencePointers ?? request.evidence_pointers ?? [],
      providerCapabilities: this.providerCapabilities,
      purpose: request.purpose,
      route: request.route === 'PRE_ROUTE' ? 'PENDING' : request.route,
      roadmapSlice: request.roadmapSlice ?? request.roadmap_slice,
      manifests: request.manifests ?? request.manifestPointers ?? request.manifest_pointers,
      fetchedEvidence: request.fetchedEvidence ?? request.fetched_evidence,
      forkTurns: request.fork_turns ?? request.forkTurns,
      recoveryContext: request.recoveryContext ?? request.recovery_context,
      findingIds,
    }
    if (CHECKER_ROLES.has(policy.child) && !/^[a-f0-9]{64}$/.test(request.candidateHash || '')) {
      throw new SupervisorIntegrationError('CANDIDATE_HASH_REQUIRED', `${policy.child} requires an exact sha256 version hash`)
    }
    const oracle = request.oracle || policy.child
    const dispatch = CHECKER_ROLES.has(policy.child)
      ? buildCheckerContext({ ...common, candidateHash: request.candidateHash })
      : buildContextFreeBrief(common)
    const audit = auditDispatch(dispatch)
    if (!audit.conformant || dispatch.fork_turns === 'all') {
      throw new SupervisorIntegrationError('CONTEXT_POLICY_DENIED', 'child dispatch violates the bounded context policy', audit)
    }

    let continuationId = request.continuationId || null
    const adoptedBinding = request.adoptedBinding || null
    const adoptedLease = request.adoptedLease || null
    const executorKey = request.executorKey || request.equivalenceKey || request.workItemId
    if (request.repairOf) {
      const prior = this.workerContexts.get(request.repairOf)
      if (!prior || prior.executorKey !== executorKey || prior.logicalRole !== policy.child ||
          !/^[a-f0-9]{64}$/.test(prior.contextBindingHash || '')) {
        throw new SupervisorIntegrationError('SAME_EXECUTOR_REQUIRED', 'repair must return to the same executor context')
      }
      continuationId = prior.contextId
    }
    const modelRouting = this.settings.modelRouting || {}
    const pins = {
      model: modelRouting.explicitUserModelPin !== undefined,
      effort: modelRouting.explicitUserEffortPin !== undefined,
    }
    let assignment
    if (typeof this.options.assignmentResolver === 'function') {
      assignment = this.options.assignmentResolver({
        logicalRole: policy.child,
        providerRole,
        request,
        settings: this.settings,
      })
      if (!assignment || typeof assignment !== 'object') {
        throw new SupervisorIntegrationError('MODEL_ASSIGNMENT_INVALID', 'provider assignment resolver returned no assignment')
      }
    } else if (pins.model === true && pins.effort === true) {
      const verified = this.options.verifiedPinnedModel
      if (!verified || verified.model !== modelRouting.model ||
          verified.effort !== modelRouting.effort || verified.accepted !== true) {
        throw new SupervisorIntegrationError(
          'PINNED_MODEL_UNVERIFIED',
          'explicit model and effort pins require a receipt-bound Codex acceptance probe',
        )
      }
      assignment = Object.freeze({
        model: verified.model,
        effort: verified.effort,
        source: 'explicit-user-pin',
        registryMatched: false,
      })
    } else {
      assignment = selectModelAssignment({
        role: policy.child,
        difficulty: request.difficulty,
        risk: request.risk,
        explicitPin: {
          model: modelRouting.model,
          effort: modelRouting.effort,
        },
        registry: this.options.modelRegistry || [],
        requiredCapabilities: request.requiredCapabilities || [],
        workload: request.estimate || {},
      })
    }
    assignment = applyBenchmarkEffortPin(assignment)
    const durableProgressEvidenceHashes = schedulerProgressEvidenceHashes(request)
    const schedulerRequest = {
      workItemId: request.workItemId,
      equivalenceKey: executorKey,
      attempt: request.attempt,
      lane: request.lane || (request.route === 'PRE_ROUTE'
        ? (policy.child === 'route-analyst' ? 'routeAnalyst' : 'routeDecision')
        : 'main'),
      role: providerRole,
      logicalRole: policy.child,
      purpose: request.purpose,
      optionalWork: request.optionalWork ?? request.optional_work,
      isOptional: request.isOptional ?? request.is_optional,
      impliedScope: request.impliedScope ?? request.implied_scope,
      isImplied: request.isImplied ?? request.is_implied,
      scopeImplied: request.scopeImplied ?? request.scope_implied,
      missionEssential: request.missionEssential ?? request.mission_essential,
      isMissionEssential: request.isMissionEssential ?? request.is_mission_essential,
      scopeKind: request.scopeKind ?? request.scope_kind,
      workScope: request.workScope ?? request.work_scope,
      requiredByMission: request.requiredByMission ?? request.required_by_mission,
      userRequested: request.userRequested ?? request.user_requested,
      valueCase: request.valueCase ?? request.value_case,
      estimate: request.estimate,
      resources: request.resources ?? request.schedulerResources ?? request.scheduler_resources,
      candidateHash: request.candidateHash,
      // A same-executor repair is progress only when its orchestration path
      // explicitly supplies a digest from an exact-byte-validated receipt.
      // Context pointers alone never authorize another attempt.
      evidenceHashes: durableProgressEvidenceHashes,
      strategyFingerprint: request.strategyFingerprint,
    }
    if (typeof scheduler.assertRetryProgress !== 'function') {
      throw new SupervisorIntegrationError(
        'PROVIDER_UNSUPPORTED',
        'central scheduler lacks retry progress preflight',
      )
    }
    // Retry contract defects must be discovered before checker snapshots,
    // scratch roots, or private mutation workspaces are materialized. Crash
    // adoption resumes an already-admitted lease and is not a new attempt.
    if (!adoptedLease) scheduler.assertRetryProgress(schedulerRequest)
    let checkerPolicy = null
    let sandboxAssignment = null
    if (CHECKER_ROLES.has(policy.child)) {
      const projection = planCheckerProjection(request)
      const deferredCandidate = request.deferredPromotionToken
        ? this.deferredPromotions.get(request.deferredPromotionToken) : null
      if (request.deferredPromotionToken && (!deferredCandidate ||
          deferredCandidate.candidateHash !== request.candidateHash)) {
        throw new SupervisorIntegrationError(
          'DONE_RETRY_ISOLATION_REQUIRED',
          'checker request does not bind the exact live deferred DONE retry version',
        )
      }
      const checkerPlanInput = {
        bounded: request.bounded !== false,
        toolchains: request.toolchains || 1,
        risks: request.risks || [],
        firstResponsibility: request.firstResponsibility || request.assignment,
        secondResponsibility: request.secondResponsibility,
        ...(request.checkerPlan || {}),
      }
      const checkerRecommendation = decideCheckerPlan(checkerPlanInput)
      checkerPolicy = assertCheckerPlan(checkerPlanInput)
      if (JSON.stringify(checkerRecommendation) !== JSON.stringify(checkerPolicy)) {
        throw new SupervisorIntegrationError('CHECKER_PLAN_DIVERGED', 'checker plan decision changed during assertion')
      }
      const checkerId = request.checkerId || oracle
      const sandboxPlan = planCheckerSandboxes(request.checkers || [{
        id: checkerId,
        commands: request.commands || [],
        // Every checker may need temp/cache/database/output writes even when
        // the declared acceptance command appears read-only. Always isolate
        // the exact candidate and provide scratch; never discover this need
        // only after the checker has started.
        writeProducing: true,
        writeResources: request.writeResources ?? request.write_resources,
        workspace: this.options.targetPath,
        isolation: request.isolation,
      }], {
        isolatedChecking: this.providerCapabilities.isolatedChecking,
        providerCapabilities: this.providerCapabilities,
        workspace: this.options.targetPath,
      })
      if (adoptedLease && Array.isArray(request.adoptedSandboxResources)) {
        const savedWorkspace = request.adoptedSandboxResources.find(resource =>
          resource && (resource.kind === 'workspace' || /^workspace:/i.test(String(resource.id || ''))))
        const untrustedSnapshotPath = savedWorkspace && (savedWorkspace.physicalId ||
          String(savedWorkspace.id).replace(/^workspace:/i, ''))
        const snapshotPath = untrustedSnapshotPath && typeof this.options.validateCheckerSnapshot === 'function'
          ? this.options.validateCheckerSnapshot(untrustedSnapshotPath)
          : null
        const restoredCandidateHash = snapshotPath && fs.existsSync(snapshotPath)
          ? (projection
              ? validatePlanCheckerSnapshot(snapshotPath, request)
              : hashWorkspaceCandidate(snapshotPath, this.options.gitEnvironment(snapshotPath)))
          : null
        if (!snapshotPath || !fs.existsSync(snapshotPath) || restoredCandidateHash !== request.candidateHash) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
            'adopted checker snapshot is absent or differs from its frozen exact version',
            {
              snapshotPath: snapshotPath || null,
              expectedCandidateHash: request.candidateHash,
              restoredCandidateHash,
              adoptedSandboxResources: request.adoptedSandboxResources,
            },
          )
        }
        const projectionIdentity = {
          runId: this.options.runId,
          generation: this.activation.generation,
          checkerId,
        }
        let priorProjectionReceipt = null
        if (projection) {
          priorProjectionReceipt = request.snapshotProjection || null
          if (!priorProjectionReceipt || !request.adoptedProjectionIdentity) {
            throw new SupervisorIntegrationError(
              'CRASH_ADOPTION_CONFLICT',
              'adopted plan checker lacks its exact persisted projection receipt identity',
            )
          }
          validatePlanCheckerSnapshot(
            snapshotPath,
            request,
            priorProjectionReceipt,
            request.adoptedProjectionIdentity,
          )
          projectionIdentity.adoptedFromReceiptHash = priorProjectionReceipt.receiptHash
        }
        sandboxAssignment = {
          checkerId,
          snapshotPath,
          projectionReceipt: projection ? planProjectionReceipt(projection, snapshotPath, projectionIdentity) : null,
          priorProjectionReceipt,
          schedulerResources: request.adoptedSandboxResources.map(resource => ({
            id: resource.id,
            kind: resource.kind,
            mode: resource.mode,
            isolationId: resource.isolationId || null,
          })),
        }
        if (projection) {
          validatePlanCheckerSnapshot(snapshotPath, request, sandboxAssignment.projectionReceipt, projectionIdentity)
        }
      } else {
        const snapshotFactory = (materializedCheckerId, resources) => this.options.checkerSnapshotFactory(
          materializedCheckerId,
          resources,
          deferredCandidate ? deferredCandidate.workerWorkspace.workspacePath : this.options.targetPath,
          { projection },
        )
        const materialized = materializeCheckerSandboxes(sandboxPlan, snapshotFactory)
        sandboxAssignment = materialized.find(item => item.checkerId === checkerId) || materialized[0]
        if (projection) {
          validatePlanCheckerSnapshot(sandboxAssignment.snapshotPath, request, sandboxAssignment.projectionReceipt, {
            runId: this.options.runId,
            generation: this.activation.generation,
            checkerId,
          })
        }
      }
      if (!sandboxAssignment || !sandboxAssignment.snapshotPath || typeof this.options.checkerScratchFactory !== 'function') {
        throw new SupervisorIntegrationError(
          'CHECKER_SCRATCH_UNAVAILABLE',
          'every checker requires both its frozen exact-version snapshot and authenticated writable scratch',
        )
      }
      const adoptedScratchRoots = adoptedLease
        ? (request.adoptedSandboxResources || []).flatMap(resource => {
            if (!resource || String(resource.kind || '').toLowerCase() !== 'temporary') return []
            const encoded = String(resource.physicalId || resource.id || '').replace(/^temporary:/iu, '')
            return encoded ? [encoded] : []
          })
        : []
      const checkerScratchBoundary = this.options.checkerScratchFactory(
        checkerId,
        sandboxAssignment.snapshotPath,
        { candidateHash: request.candidateHash, adoptedScratchRoots },
      )
      sandboxAssignment = {
        ...sandboxAssignment,
        checkerScratchBoundary,
        schedulerResources: [
          ...(sandboxAssignment.schedulerResources || []),
          {
            id: `temporary:${checkerScratchBoundary.writableScratchRoot}`,
            kind: 'temporary',
            physicalId: checkerScratchBoundary.writableScratchRoot,
            mode: 'exclusive',
            isolationId: checkerId,
          },
        ],
      }
      // The sandbox planner may express the concrete snapshot both as the
      // mapped source workspace and as its explicit snapshot ownership.  They
      // are the same exclusive scheduler claim, not two independent claims.
      // Canonicalize that manifest before it enters either the scheduler or
      // the recovery journal, whose cross-lease collision verifier correctly
      // rejects duplicate exclusive claims.
      const canonicalResources = new Map()
      for (const resource of sandboxAssignment.schedulerResources || []) {
        const prior = canonicalResources.get(resource.id)
        if (prior && prior.mode !== resource.mode) {
          throw new SupervisorIntegrationError(
            'CHECKER_RESOURCE_OVERRIDE_DENIED',
            `checker sandbox resource ${resource.id} has conflicting access modes`,
          )
        }
        if (!prior) canonicalResources.set(resource.id, resource)
      }
      sandboxAssignment = {
        ...sandboxAssignment,
        schedulerResources: [...canonicalResources.values()],
      }
      const callerResources = request.resources ?? request.schedulerResources ?? request.scheduler_resources
      if (callerResources !== undefined && JSON.stringify(callerResources) !==
          JSON.stringify(sandboxAssignment.schedulerResources)) {
        throw new SupervisorIntegrationError(
          'CHECKER_RESOURCE_OVERRIDE_DENIED',
          'checker resources are derived from the frozen sandbox manifest and cannot be caller-overridden',
        )
      }
      schedulerRequest.resources = sandboxAssignment.schedulerResources
    }
    const targetWorkingDirectory = sandboxAssignment && sandboxAssignment.snapshotPath
      ? sandboxAssignment.snapshotPath
      : this.options.targetPath
    let canonicalAssignment = request.route === 'PRE_ROUTE' ? null : canonicalRoleAssignment({
      request: { ...request, findingIds },
      route: request.route,
      runId: this.options.runId,
      logicalRole: policy.child,
      physicalRole,
      readOnly: CHECKER_ROLES.has(policy.child) ||
        !Array.isArray(policy.definition.permissions && policy.definition.permissions.write) ||
        policy.definition.permissions.write.length === 0,
      requestEnvelopeHash: this.requestPointer.hash,
      targetPath: targetWorkingDirectory,
      canonicalTargetPath: this.options.targetPath,
      enforcePreimages: TARGET_MUTATOR_ROLES.has(policy.child) && Boolean(this.options.mutationEnforcer),
      additionalResources: CHECKER_ROLES.has(policy.child)
        ? checkerAssignmentResources(sandboxAssignment, request.workItemId) : [],
      mission: this.options.mission,
      now: this.now,
    })
    if (policy.child === 'plan-checker') {
      canonicalAssignment = Object.freeze({
        ...canonicalAssignment,
        snapshotProjection: sandboxAssignment && sandboxAssignment.projectionReceipt || null,
        priorSnapshotProjection: sandboxAssignment && sandboxAssignment.priorProjectionReceipt || null,
      })
      const harnessRepoHash = request.harnessAttestation && request.harnessAttestation.repoHash
      if (harnessRepoHash !== request.candidateHash) {
        throw new SupervisorIntegrationError(
          'HARNESS_CANDIDATE_MISMATCH',
          'checker harness repository hash must equal the exact admitted version hash before launch',
        )
      }
      if (!canonicalAssignment || canonicalAssignment.planReference.sectionHash !== request.candidateHash ||
           !sandboxAssignment || !sandboxAssignment.projectionReceipt ||
           sandboxAssignment.projectionReceipt.sha256 !== request.candidateHash) {
        throw new SupervisorIntegrationError(
          'PLAN_PROJECTION_MISMATCH',
          'plan checker assignment, projection, and exact-version hashes did not join before launch',
        )
      }
    }
    if (canonicalAssignment && !CHECKER_ROLES.has(policy.child)) {
      const derivedResources = schedulerResourcesForAssignment(canonicalAssignment, targetWorkingDirectory)
      const callerResources = request.resources ?? request.schedulerResources ?? request.scheduler_resources
      if (callerResources !== undefined && JSON.stringify(callerResources) !== JSON.stringify(derivedResources)) {
        throw new SupervisorIntegrationError(
          'OWNERSHIP_RESOURCE_OVERRIDE_DENIED',
          'scheduler ownership is derived from the canonical assignment and cannot be caller-overridden',
        )
      }
      schedulerRequest.resources = derivedResources
    }
    let workerWorkspace = null
    let workingDirectory = sandboxAssignment && sandboxAssignment.checkerScratchBoundary
      ? path.resolve(sandboxAssignment.checkerScratchBoundary.writableScratchRoot)
      : targetWorkingDirectory
    if (TARGET_MUTATOR_ROLES.has(policy.child) && canonicalAssignment && this.options.mutationEnforcer) {
      workerWorkspace = await this.options.workerWorkspaceFactory({
        activation: this.activation,
        assignment: canonicalAssignment,
        workItemId: request.workItemId,
      })
      if (!workerWorkspace || typeof workerWorkspace.workspacePath !== 'string' ||
          !workerWorkspace.binding || typeof workerWorkspace.binding.bindingHash !== 'string' ||
          !workerWorkspace.manager || typeof workerWorkspace.manager.inspect !== 'function' ||
          typeof workerWorkspace.manager.promote !== 'function') {
        throw new SupervisorIntegrationError(
          'WORKER_ISOLATION_UNSUPPORTED',
          'private worker workspace factory returned no enforceable isolation session',
        )
      }
      workingDirectory = path.resolve(workerWorkspace.workspacePath)
      if (workingDirectory === path.resolve(targetWorkingDirectory) ||
          workingDirectory.startsWith(`${path.resolve(targetWorkingDirectory)}${path.sep}`)) {
        throw new SupervisorIntegrationError(
          'WORKER_ISOLATION_UNSUPPORTED',
          'private worker workspace must be outside the real target',
        )
      }
    }
    const reservationId = crypto.randomUUID()
    const launchBaseEnvironment = typeof this.options.processControlEnvironmentFactory === 'function'
      ? this.options.processControlEnvironmentFactory(
          reservationId,
          this.options.baseEnvironment || process.env,
        )
      : this.options.baseEnvironment || process.env
    const checkerEnvironment = sandboxAssignment && sandboxAssignment.checkerScratchBoundary
      ? {
          ...launchBaseEnvironment,
          TMPDIR: sandboxAssignment.checkerScratchBoundary.temporaryRoot,
          TMP: sandboxAssignment.checkerScratchBoundary.temporaryRoot,
          TEMP: sandboxAssignment.checkerScratchBoundary.temporaryRoot,
          SQLITE_TMPDIR: sandboxAssignment.checkerScratchBoundary.temporaryRoot,
          XDG_CACHE_HOME: sandboxAssignment.checkerScratchBoundary.cacheRoot,
          PYTHONPYCACHEPREFIX: sandboxAssignment.checkerScratchBoundary.cacheRoot,
          PYTHONDONTWRITEBYTECODE: '1',
          AUTOPROMPT_CHECKER_CANDIDATE_ROOT: sandboxAssignment.checkerScratchBoundary.frozenCandidateRoot,
          AUTOPROMPT_CHECKER_SCRATCH_ROOT: sandboxAssignment.checkerScratchBoundary.writableScratchRoot,
          AUTOPROMPT_CHECKER_OUTPUT_ROOT: sandboxAssignment.checkerScratchBoundary.outputRoot,
        }
      : workerWorkspace
        ? {
            ...launchBaseEnvironment,
            TMPDIR: workerWorkspace.cacheRoot,
            TMP: workerWorkspace.cacheRoot,
            TEMP: workerWorkspace.cacheRoot,
            XDG_CACHE_HOME: workerWorkspace.cacheRoot,
            PYTHONPYCACHEPREFIX: workerWorkspace.cacheRoot,
            PYTHONDONTWRITEBYTECODE: '1',
            AUTOPROMPT_WORKER_CACHE_ROOT: workerWorkspace.cacheRoot,
          }
      : launchBaseEnvironment
    const safetyEnvironmentTarget = sandboxAssignment && sandboxAssignment.checkerScratchBoundary
      ? targetWorkingDirectory : workingDirectory
    const safetyBoundary = ensureSafeEnvironment(this.safeEnvFactory(
      safetyEnvironmentTarget,
      checkerEnvironment,
      {
        configIsolationPath: this.options.configIsolationPath,
        ghConfigDir: this.options.ghConfigDir,
        expectedBranch: this.options.expectedBranch,
        enforcementProof: this.options.enforcementProof,
      },
    ))
    const env = safetyBoundary.environment
    const environmentHash = CHECKER_ROLES.has(policy.child)
      ? hashCheckerEnvironment(env)
      : hashEnvironment(env)
    const evidenceBinding = CHECKER_ROLES.has(policy.child)
      ? canonicalEvidenceBinding({
          missionHash: this.activation.missionHash,
          mission: this.options.mission,
          planHash: canonicalAssignment && canonicalAssignment.planReference.sectionHash,
          planReference: canonicalAssignment && canonicalAssignment.planReference,
          candidateHash: request.candidateHash,
          environmentHash,
          oracleHash: request.harnessAttestation && request.harnessAttestation.oracleHash,
          oracle,
          assumptionsHash: request.assumptionsHash,
          assumptions: request.assumptions || [],
          dependencyHash: request.dependencyHash,
          dependencies: {
            dependencies: request.dependencies || [],
            evidencePointers: request.evidencePointers ?? request.evidence_pointers ?? [],
            roadmapSlice: request.roadmapSlice ?? request.roadmap_slice ?? null,
            snapshotProjection: sandboxAssignment && sandboxAssignment.projectionReceipt || null,
            retryProgress: {
              evidenceHashes: durableProgressEvidenceHashes,
              strategyFingerprint: request.strategyFingerprint || null,
            },
          },
        })
      : null
    if (policy.alias) {
      if (!this.record || typeof this.record.appendAliasTelemetry !== 'function') {
        throw new SupervisorIntegrationError(
          'RUN_RECORD_SCHEMA_INCOMPATIBLE',
          'legacy role alias use requires the registered canonical alias telemetry writer',
        )
      }
      this.record.appendAliasTelemetry({
        activationId: this.activation.id,
        generation: this.activation.generation,
        legacyId: policy.alias.legacyId,
        logicalId: policy.child,
        physicalId: physicalRole,
      })
    }
    const checkKey = evidenceBinding ? hashText(stableStringify(evidenceBinding)) : null
    if (checkKey && this.record && typeof this.record.resolve === 'function') {
      const proofPath = this.record.resolve(`checks/review-results/${checkKey}.json`)
      if (fs.existsSync(proofPath)) {
        const saved = readRegularJson(proofPath, 'checker proof').parsed
        const resultHash = hashText(JSON.stringify(saved.result))
        if (saved.schemaVersion !== 2 || stableStringify(saved.evidenceBinding) !== stableStringify(evidenceBinding) ||
            saved.candidateHash !== request.candidateHash ||
            saved.oracle !== oracle || saved.environmentHash !== environmentHash || saved.resultHash !== resultHash ||
            saved.resultHash !== saved.harnessAttestation.rawOutputHash ||
            saved.resultHash !== saved.harnessAttestation.persistedResultHash ||
            saved.resultHash !== saved.proofAttestation.rawOutputHash ||
            saved.resultHash !== saved.proofAttestation.persistedResultHash ||
            !saved.result || saved.result.candidateHash !== request.candidateHash) {
          throw new SupervisorIntegrationError('CHECK_PROOF_INVALID', 'persisted checker proof is foreign or corrupt')
        }
        // Only an exact PASS is an acceptance proof.  Negative and
        // non-authoritative results remain durable evidence for repair or a
        // fresh isolated retry, but can never short-circuit that retry.
        if (saved.result.code === 'PASS') {
          if (saved.cacheEligible !== false) {
            if (!saved.harnessRecord || !saved.proofRecord) {
              throw new SupervisorIntegrationError('CHECK_PROOF_INVALID', 'persisted PASS lacks acceptance-cache attestations')
            }
            const restoredHarness = scheduler.recordHarnessAttestation(saved.harnessAttestation)
            const restoredProof = scheduler.recordProofCache(saved.proofAttestation)
            if (restoredHarness.key !== saved.harnessRecord.key || restoredHarness.signature !== saved.harnessRecord.signature ||
                restoredProof.key !== saved.proofRecord.key || restoredProof.signature !== saved.proofRecord.signature ||
                !scheduler.getHarnessAttestation(restoredHarness.key) || !scheduler.getProofCache(restoredProof.key)) {
              throw new SupervisorIntegrationError('CHECK_PROOF_INVALID', 'persisted scheduler attestations do not revalidate')
            }
            return { ...saved.result, reusedProof: proofPath }
          }
        }
      }
    } else if (checkKey && this.consumedChecks.has(checkKey)) {
      throw new SupervisorIntegrationError('CHECK_ALREADY_CONSUMED', 'the acceptance check already ran for this exact version and environment')
    }
    let verification = await this.options.capabilityVerifier({
      activationId: this.activation.id,
      caller,
      child: Object.freeze({ logicalRole: policy.child, physicalRole, providerRole, executionPolicy: physicalExecutionPolicy }),
      runId: this.options.runId,
      generation: this.activation.generation,
      parentLease: request.parentLease || null,
      providerCapabilities: this.providerCapabilities,
      assignment,
      canonicalAssignment,
      workItemId: request.workItemId,
    })
    const routeBeforeCapability = request.route
    verification = this._applySafeTransportDegradation(verification, request, scheduler)
    if (canonicalAssignment && request.route !== routeBeforeCapability) {
      canonicalAssignment = Object.freeze({ ...canonicalAssignment, route: request.route })
    }
    if (!verification || verification.verified !== true) {
      if (policy.child === 'diagnostic-probe') {
        throw new SupervisorIntegrationError(
          'DIAGNOSTIC_DENIAL_BLOCKED',
          'the single bounded diagnostic was denied; return BLOCKED with the denial evidence',
          { workerCount: this.diagnosticWorkerLaunches },
        )
      }
      throw new SupervisorIntegrationError('CAPABILITY_VERIFICATION_FAILED', 'host capability verifier rejected child launch')
    }
    let lease
    if (adoptedLease) {
      if (!adoptedBinding || adoptedLease.workItemId !== request.workItemId ||
          (adoptedBinding.continuationId && continuationId !== adoptedBinding.continuationId)) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          'adopted model continuation does not bind the exact saved lease, work item, and thread',
        )
      }
      lease = adoptedLease
    } else {
      const authority = scheduler.issueLaunchAuthority({
        callerRole: caller.physicalRole,
        sessionId: caller.sessionId,
        runId: caller.runId,
        generation: caller.generation,
        parentLease: request.parentLease || null,
        providerCapabilities: this.providerCapabilities,
      })
      // Admission may perform capability and assignment validation. Recheck at
      // the exact scheduler-lease boundary so none of that time can borrow from
      // the independent final-verification reserve.
      this.budget.assertAvailable({
        forWork: request.purpose !== 'recovery',
        forExecution: !protectedDeadlinePurpose(request.purpose),
      })
      lease = await scheduler.acquireWithAuthority(authority, schedulerRequest)
    }
    if (!adoptedLease && request.route !== 'PRE_ROUTE' && !this.firstChildStartupRecorded) {
      const startupAdmission = scheduler.recordAdmissionComponent(
        'firstChildStartup',
        Math.max(0, this.monotonicNow() -
          (this.routeFrozenMonotonicAt === undefined ? this.monotonicNow() : this.routeFrozenMonotonicAt)),
      )
      this.firstChildStartupRecorded = true
      if (!startupAdmission || startupAdmission.withinCeiling !== true) {
        const error = new SupervisorIntegrationError(
          'ADMISSION_COMPONENT_TIMEOUT',
          'first admitted child startup exceeded the canonical admission ceiling',
          startupAdmission || {},
        )
        lease.fail(error, { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
        throw error
      }
    }
    const sessionId = `${this.activation.id}:${request.route}:${lease.id}`
    const externalOperation = this._defaultExternalOperation(request, canonicalAssignment)
    const recoveryFrontier = adoptedBinding ? adoptedBinding.frontier : {
      resumeState: request.route === 'PRE_ROUTE' ? 'SAVE_ROUTE_ANALYSIS' : 'CHECK_WORK',
      nextReadyWorkIds: request.route === 'PRE_ROUTE'
        ? ['route-analysis-result']
        : [`reconcile:${request.workItemId}`],
      openCheckIds: CHECKER_ROLES.has(policy.child) ? [request.workItemId] : [],
      acceptedResultIds: [],
    }
    const requestNextReadyAfterCompletion = () => {
      return recoveryGroupNextReady(request, this.recoveryCompletedWorkIds)
    }
    if (externalOperation) {
      this.recoveryExternalOperations.set(externalOperation.operationId, externalOperation)
    }
    if (typeof scheduler.bindCrashContinuation !== 'function' ||
        typeof scheduler.exportCrashCheckpoint !== 'function') {
      const error = new SupervisorIntegrationError(
        'PROVIDER_UNSUPPORTED',
        'central scheduler lacks canonical live crash adoption',
      )
      lease.fail(error, { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
      throw error
    }
    let identifiedContinuationId = continuationId
    let usageSequence = 0
    const persistSchedulerCheckpoint = (continuation, causeKind = 'CHECKPOINT', threadEvidence = null) => {
      if (continuation) identifiedContinuationId = continuation
      if (threadEvidence) {
        this.recoveryThreads.set(lease.id, {
          startedEventHash: hashText(threadEvidence.raw || JSON.stringify(threadEvidence.event)),
          startedAt: threadEvidence.occurredAt || new Date(this.now()).toISOString(),
        })
      }
      scheduler.bindCrashContinuation(lease, {
        reservationId,
        sessionId,
        continuationId: identifiedContinuationId || null,
        frontier: recoveryFrontier,
      })
      const checkpoint = scheduler.exportCrashCheckpoint({
        ownerSessionId: this.rootCallers.controlPlane.sessionId,
      })
      if (typeof this.options.persistSchedulerCheckpoint === 'function') {
        this.options.persistSchedulerCheckpoint({
          checkpoint,
          request,
          sessionId,
          continuationId: identifiedContinuationId || null,
          recoveryFrontier,
        })
      }
      this._persistRecoveryCheckpoint({
        kind: causeKind,
        causeId: `scheduler:${this.activation.generation}:${lease.id}:${causeKind.toLowerCase()}:${usageSequence}`,
        humanDescription: `Persist scheduler ${lease.id} at the ${causeKind.toLowerCase()} recovery boundary.`,
      }, {
        schedulerCheckpoint: checkpoint,
        recoveryFrontier,
        nextReadyWorkIds: recoveryFrontier.nextReadyWorkIds,
        openCheckIds: recoveryFrontier.openCheckIds,
        candidateHash: request.candidateHash,
      })
      return checkpoint
    }
    if (adoptedLease) {
      scheduler.rebindAdoptedContinuation(lease, {
        priorBindingHash: adoptedBinding.bindingHash,
        reservationId,
        sessionId,
        continuationId,
        frontier: adoptedBinding.frontier,
      })
    } else {
      scheduler.bindCrashContinuation(lease, {
        reservationId,
        sessionId,
        continuationId: continuationId || null,
        frontier: recoveryFrontier,
      })
      this._checkpointAccounting({
        kind: lease.attempt > 1 ? 'RETRY' : 'LAUNCH',
        causeId: `scheduler:${lease.id}`,
        humanDescription: lease.attempt > 1
          ? 'Persist a progress-evidenced retry before exposing its owned model process.'
          : 'Persist an admitted owned model launch before exposing its process.',
      }, {
        launches: 1,
        retries: lease.attempt > 1 ? 1 : 0,
        sessions: 1,
      })
      this.budget.recordLaunch({
        forWork: request.purpose !== 'recovery',
        forExecution: !protectedDeadlinePurpose(request.purpose),
      })
      this.budget.startSession(sessionId, {
        activationId: this.activation.id,
        parentSessionId: request.parentSessionId || caller.sessionId,
        forWork: request.purpose !== 'recovery',
        forExecution: !protectedDeadlinePurpose(request.purpose),
      })
    }
    persistSchedulerCheckpoint(continuationId, 'LEASE_STARTED')
    if (externalOperation) persistSchedulerCheckpoint(continuationId, 'EXTERNAL_OPERATION')
    const transcriptReferences = []
    let streamedRouteEventCount = 0
    let transcriptStore = null
    if (typeof this.options.transcriptStoreFactory === 'function') {
      transcriptStore = this.options.transcriptStoreFactory({ request, sessionId, record: this.record })
    } else if (this.record && this.record.runPath) {
      transcriptStore = new TranscriptStore(path.join(
        this.record.runPath,
        'work', 'results', 'transcripts', hashText(sessionId),
      ))
    }
    if (canonicalAssignment && this.record && typeof this.record.write === 'function') {
      this.record.write(
        `work/assignments/${hashText(request.workItemId)}.json`,
        `${JSON.stringify(canonicalAssignment, null, 2)}\n`,
      )
    }
    let terminalReceiptBinding = null
    let terminalReceiptRelative = null
    let externalWriteBoundaryReceipt = null
    const beforeExternalWrite = externalOperation
      ? () => {
          this.budget.assertExternalWriteAllowed({
            operationId: externalOperation.operationId,
            reconciledPartialStateHash: hashText(stableStringify([...this.recoveryExternalOperations.values()])),
          })
          externalWriteBoundaryReceipt = Object.freeze({
            operationId: externalOperation.operationId,
            checkedAtElapsedMs: this.budget.elapsedMs(),
            budgetSnapshotHash: hashText(stableStringify(this.budget.snapshot())),
          })
          return externalWriteBoundaryReceipt
        }
      : null
    const launchRecord = {
      runId: this.options.runId,
      workItemId: request.workItemId,
      schedulerLeaseId: lease.id,
      schedulerAttempt: lease.attempt,
      sessionId,
      reservationId,
      parent: policy.parent,
      route: request.route,
      caller,
      logicalRole: policy.child,
      physicalRole,
      providerRole,
      dispatch,
      entryPrompt: this.options.entryPrompt,
      environment: env,
      environmentHash,
      workingDirectory,
      canonicalTargetPath: targetWorkingDirectory,
      assignment,
      canonicalAssignment,
      schedulerResources: Object.freeze([...(schedulerRequest.resources || [])].map(resource => Object.freeze({ ...resource }))),
      continuationId,
      candidateHash: request.candidateHash || null,
      evidenceBinding,
      externalOperation,
      beforeExternalWrite,
      capabilityVerification: verification,
      physicalExecutionPolicy,
      safetyAttestation: safetyBoundary.attestation,
      profileLimits: this.profileLimits,
      checkerPolicy,
      sandboxAssignment,
      checkerScratchBoundary: sandboxAssignment && sandboxAssignment.checkerScratchBoundary || null,
      workerWorkspace: workerWorkspace ? Object.freeze({
        workspaceId: workerWorkspace.workspaceId,
        binding: workerWorkspace.binding,
      }) : null,
      onEvent: transcriptStore || policy.child === 'route-analyst'
        ? (event, raw) => {
            if (transcriptStore) transcriptReferences.push(transcriptStore.append({ event, raw }))
            if (policy.child === 'route-analyst') {
              appendCanonicalRouteEvent(this.record, event, raw)
              streamedRouteEventCount += 1
            }
          }
        : null,
      onFirstProductSignal: request.route === 'PRE_ROUTE'
        ? null
        : signal => scheduler.recordFirstProductSignal({
            ...signal,
            elapsedMs: Number.isSafeInteger(signal && signal.elapsedMs)
              ? signal.elapsedMs : Math.max(0, this.monotonicNow() - this.admissionStartedAt),
          }),
      onSessionIdentified: (identified, evidence) => persistSchedulerCheckpoint(identified, 'THREAD_STARTED', evidence),
      onTerminalResult: (terminalResult, terminalEvidence) => {
        try {
          validateCanonicalChildResult({
            workItemId: request.workItemId,
            logicalRole: policy.child,
            physicalRole,
            candidateHash: request.candidateHash || null,
            findingIds: canonicalAssignment && canonicalAssignment.findingIds || [],
          }, terminalResult, this.options.runId, this.requestPointer.hash)
        } catch (error) {
          if (!CHECKER_ROLES.has(policy.child) || error.code !== 'CHECK_REPORT_INVALID') throw error
          error.details = {
            ...(error.details || {}),
            checkerTerminalEvidence: terminalEvidence,
            invalidCheckerResult: terminalResult,
          }
          throw error
        }
        if (mutationBefore && !mutationAdmission) {
          mutationAdmission = workerWorkspace.manager.inspect(workerWorkspace, terminalResult)
        }
        if (terminalEvidence.sessionId !== identifiedContinuationId) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
            'terminal result session differs from the persisted Codex continuation',
          )
        }
        if (policy.child !== 'route-analyst' && terminalResult.contextId !== terminalEvidence.sessionId) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
            'terminal worker result context differs from its receipt-bound Codex continuation',
          )
        }
        if (terminalResult.externalOperation) {
          this.recoveryExternalOperations.set(terminalResult.externalOperation.operationId, terminalResult.externalOperation)
        }
        const assignmentHash = canonicalAssignment
          ? hashText(JSON.stringify(canonicalAssignment))
          : hashText(stableStringify(dispatch))
        const terminalContextId = terminalEvidence.sessionId
        const workerContextIdentity = policy.child === 'route-analyst' ? null : {
          schemaVersion: 1,
          runId: this.options.runId,
          activationId: this.activation.id,
          requestEnvelopeHash: this.requestPointer.hash,
          missionHash: this.activation.missionHash,
          workItemId: request.workItemId,
          logicalRole: policy.child,
          executorKey,
          contextId: terminalContextId,
        }
        // Checker reports are bound to the exact artifact they inspected. A
        // ROADMAP plan checker therefore returns the plan-file hash, while the
        // recovery journal is intentionally bound to the runtime's immutable
        // workspace candidate. Keep both bindings instead of reusing the
        // checker artifact hash as the scheduler candidate.
        const receiptCandidateHash = resolveTerminalReceiptCandidateHash({
          logicalRole: policy.child,
          runtimeStateProvider: this.options.runtimeStateProvider,
          requestCandidateHash: request.candidateHash,
          resultCandidateHash: terminalResult.candidateHash,
        })
        const body = {
          schemaVersion: 1,
          runId: this.options.runId,
          activationId: this.activation.id,
          admittedGeneration: this.activation.generation,
          leaseId: lease.id,
          workItemId: request.workItemId,
          assignmentId: request.workItemId,
          logicalRole: policy.child,
          executorKey,
          physicalRole,
          providerRole,
          retainLease: request.retainLease === true,
          assignmentHash,
          sessionId,
          continuationId: terminalEvidence.sessionId,
          workerContextBindingHash: workerContextIdentity
            ? hashText(stableStringify(workerContextIdentity)) : null,
          requestEnvelopeHash: this.requestPointer.hash,
          candidateHash: receiptCandidateHash,
          resultHash: hashText(JSON.stringify(terminalResult)),
          rawOutputHash: terminalEvidence.rawOutputHash,
          eventStreamHash: terminalEvidence.eventStreamHash,
          result: terminalResult,
        }
        const receipt = { ...body, receiptHash: hashText(JSON.stringify(body)) }
        const relative = this._terminalReceiptLocation(lease.id, request.workItemId)
        const absolute = this.record.resolve(relative)
        if (fs.existsSync(absolute)) {
          const prior = readRegularJson(absolute, 'model terminal receipt').parsed
          if (JSON.stringify(prior) !== JSON.stringify(receipt)) {
            throw new SupervisorIntegrationError(
              'CRASH_ADOPTION_CONFLICT',
              `terminal receipt for ${lease.id} changed after first persistence`,
            )
          }
        } else {
          this.record.write(relative, `${JSON.stringify(receipt, null, 2)}\n`)
        }
        terminalReceiptBinding = receipt
        terminalReceiptRelative = relative
        this.recoveryAcceptedResultIds.add(receipt.receiptHash)
        // A route recommendation is the authority consumed by L0.  Its exact
        // terminal receipt is persisted first so a crash at either file
        // boundary can be reconciled without a second model turn; the
        // recommendation itself must then be durable before RESULT_COMMITTED
        // makes the route-analysis result visible to recovery/L0.
        if (policy.child === 'route-analyst') {
          const recommendationRelative = 'route/recommendation.json'
          const recommendationAbsolute = this.record.resolve(recommendationRelative)
          const recommendation = terminalResult.recommendation
          if (fs.existsSync(recommendationAbsolute)) {
            if (JSON.stringify(readRegularJson(recommendationAbsolute, 'route recommendation').parsed) !==
                JSON.stringify(recommendation)) {
              throw new SupervisorIntegrationError(
                'CRASH_ADOPTION_CONFLICT',
                'route recommendation changed after first durable persistence',
              )
            }
          } else {
            this.record.write(recommendationRelative, `${JSON.stringify(recommendation, null, 2)}\n`)
          }
        }
        if (canonicalAssignment) {
          this._writeCanonicalResult(
            request.workItemId,
            terminalResult,
            canonicalAssignment.resultLocation,
          )
        }
        const checkpoint = scheduler.exportCrashCheckpoint({
          ownerSessionId: this.rootCallers.controlPlane.sessionId,
        })
        this._persistRecoveryCheckpoint({
          kind: 'RESULT_COMMITTED',
          causeId: `scheduler:${this.activation.generation}:${lease.id}:result:${receipt.receiptHash.slice(0, 24)}`,
          humanDescription: 'Persist the exact terminal model result before releasing its scheduler lease.',
          resultCommit: {
            assignmentId: request.workItemId,
            assignmentHash,
            leaseId: lease.id,
            sessionId,
            continuationId: terminalEvidence.sessionId,
            resultHash: receipt.resultHash,
            receiptHash: receipt.receiptHash,
            candidateHash: receipt.candidateHash,
          },
        }, {
          schedulerCheckpoint: checkpoint,
          recoveryFrontier: {
            ...recoveryFrontier,
            acceptedResultIds: [receipt.receiptHash],
          },
          nextReadyWorkIds: durableNextReadyAfter(
            policy.child,
            terminalResult,
            requestNextReadyAfterCompletion(),
            recoveryFrontier.nextReadyWorkIds,
            request.workItemId,
          ),
          openCheckIds: recoveryFrontier.openCheckIds,
          candidateHash: request.candidateHash || null,
        })
        // Keep the exact started thread visible while RESULT_COMMITTED is
        // verified and durably appended.  Deleting it early serializes the
        // still-live scheduler lease as ADMITTED and makes the canonical
        // result/lease binding unverifiable.
        this.recoveryThreads.delete(lease.id)
      },
      onUsageDelta: (delta) => {
        const authorization = lease.authorizeUsage(delta)
        const report = lease.reportUsage(delta, {
          productive: request.purpose !== 'recovery',
          progressKind: CHECKER_ROLES.has(policy.child) ? 'verification' : 'work',
        })
        usageSequence += 1
        const costMicrounits = typeof this.options.costCalculator === 'function'
          ? this.options.costCalculator({ assignment, delta, request, sequence: usageSequence })
          : 0
        if (!Number.isSafeInteger(costMicrounits) || costMicrounits < 0) {
          throw new SupervisorIntegrationError('ACCOUNTING_VALUES_INVALID', 'model cost accounting must be a non-negative integer')
        }
        this._checkpointAccounting({
          kind: 'TOKEN_USAGE_RECORDED',
          causeId: `codex-jsonl:${hashText(sessionId).slice(0, 24)}:${usageSequence}`,
          humanDescription: 'Persist the complete streamed Codex usage delta before allowing the child to continue.',
        }, { costMicrounits, tokenUsage: delta })
        const tokens = Object.values(delta).reduce((total, value) => total + Number(value || 0), 0)
        if (tokens > 0) this.budget.consumeTokens(tokens)
        persistSchedulerCheckpoint(identifiedContinuationId, 'USAGE_RECORDED')
        return {
          continue: authorization.allowed === true && report.continue === true,
          authorization,
          report,
        }
      },
    }
    this.launches.push({
      ...launchRecord,
      environment: { GIT_ALLOW_PROTOCOL: env.GIT_ALLOW_PROTOCOL },
      onUsageDelta: '[scheduler-bound]',
    })
    let leaseSettled = false
    let mutationPermit = null
    let mutationBefore = null
    let mutationAdmission = null
    let pendingDeferredPromotion = null
    let deferredPromotionHandle = null
    const enforceRealTargetDenial = path.resolve(workingDirectory) !== path.resolve(this.options.targetPath) ||
      Boolean(canonicalAssignment && canonicalAssignment.resources.every(resource => resource.access === 'read'))
    const realTargetBefore = enforceRealTargetDenial
      ? workspaceFileSnapshot(this.options.targetPath, this.options.gitEnvironment(this.options.targetPath))
      : null
    const checkerSnapshotBefore = CHECKER_ROLES.has(policy.child)
      ? hashWorkspaceCandidate(targetWorkingDirectory, this.options.gitEnvironment(targetWorkingDirectory))
      : null
    try {
      if (TARGET_MUTATOR_ROLES.has(policy.child) && canonicalAssignment && this.options.mutationEnforcer) {
        if (!this.record || typeof this.record.writePreMutationBaseline !== 'function' ||
            typeof this.record.readPreMutationBaseline !== 'function' ||
            typeof this.options.capturePreMutationBaseline !== 'function') {
          throw new SupervisorIntegrationError(
            'PRE_MUTATION_BASELINE_REQUIRED',
            'production mutation requires the immutable receipt-bound pre-mutation baseline',
          )
        }
        const baselinePath = typeof this.record.resolve === 'function'
          ? this.record.resolve('checks/pre-mutation-baseline.json') : null
        if (!baselinePath || !fs.existsSync(baselinePath)) {
          const baselineInput = await this.options.capturePreMutationBaseline({
            assignment: canonicalAssignment,
            request,
            targetPath: targetWorkingDirectory,
            environment: this.options.gitEnvironment(targetWorkingDirectory),
          })
          this.record.writePreMutationBaseline(baselineInput)
        }
        this.record.readPreMutationBaseline()
        const adoptedLiveWorker = Boolean(adoptedLease && adoptedBinding)
        const runtimeState = adoptedLiveWorker && typeof this.options.runtimeStateProvider === 'function'
          ? this.options.runtimeStateProvider()
          : null
        const resumedPermit = runtimeState && runtimeState.activeMutation
        if (resumedPermit) {
          if (!runtimeState || runtimeState.runId !== this.options.runId ||
              !runtimeState.activation || runtimeState.activation.id !== this.activation.id ||
              runtimeState.activation.generation !== this.activation.generation) {
            throw new SupervisorIntegrationError(
              'CRASH_ADOPTION_CONFLICT',
              'adopted worker resume found a foreign active mutation permit',
            )
          }
          mutationBefore = workspaceFileSnapshot(workingDirectory, this.options.gitEnvironment(workingDirectory))
          mutationPermit = resumedPermit
          if (mutationPermit.isolationBindingHash !== workerWorkspace.binding.bindingHash) {
            throw new SupervisorIntegrationError(
              'CRASH_ADOPTION_CONFLICT',
              'adopted worker mutation permit does not bind the recovered private workspace',
            )
          }
        } else {
          const preimagePairs = canonicalAssignment.resources
            .filter(resource => resource.access !== 'read')
            .map(resource => ({ resource, state: resourceStateEntry(targetWorkingDirectory, resource) }))
            .filter(pair => pair.state)
          const preimages = preimagePairs.map(pair => pair.state)
          for (const pair of preimagePairs) {
            if (pair.resource.expectedPreimageHash !== pair.state.hash) {
              throw new SupervisorIntegrationError(
                'CONCURRENT_MUTATION',
                'owned resource changed after canonical assignment admission',
              )
            }
          }
          mutationBefore = workspaceFileSnapshot(workingDirectory, this.options.gitEnvironment(workingDirectory))
          mutationPermit = await this.options.mutationEnforcer.begin({
            assignment: canonicalAssignment,
            preimages,
            isolation: workerWorkspace.binding,
            workItemId: request.workItemId,
          })
        }
      }
      if (externalOperation) {
        this.budget.assertExternalWriteAllowed({
          operationId: externalOperation.operationId,
          reconciledPartialStateHash: hashText(stableStringify([...this.recoveryExternalOperations.values()])),
        })
      }
      const result = await this._withinFirstProductSignalDeadline(
        () => this.options.launcher(launchRecord), scheduler, request,
      )
      if (checkerSnapshotBefore && hashWorkspaceCandidate(
        targetWorkingDirectory,
        this.options.gitEnvironment(targetWorkingDirectory),
      ) !== checkerSnapshotBefore) {
        throw new SupervisorIntegrationError(
          'CHECKER_SNAPSHOT_MUTATED',
          'checker changed the frozen exact-version snapshot',
          { expectedCandidateHash: checkerSnapshotBefore },
        )
      }
      if (externalOperation && !externalWriteBoundaryReceipt) {
        throw new SupervisorIntegrationError(
          'EXTERNAL_WRITE_BOUNDARY_REQUIRED',
          'external operation returned without consuming its deadline authority at the actual write boundary',
          { operationId: externalOperation.operationId },
        )
      }
      if (realTargetBefore) {
        assertRealTargetUnchanged(
          realTargetBefore,
          this.options.targetPath,
          this.options.gitEnvironment(this.options.targetPath),
        )
      }
      if (request.route !== 'PRE_ROUTE') {
        const declaredSignal = result && result.firstProductSignal
        const filesChanged = result && Array.isArray(result.filesChanged) ? result.filesChanged : []
        const redCommand = result && Array.isArray(result.commands)
          ? (result.commands.find(command =>
              command && typeof command === 'object' && Number(command.exitCode) !== 0) || null)
          : null
        if (declaredSignal || filesChanged.length || redCommand) {
          scheduler.recordFirstProductSignal({
            kind: declaredSignal && declaredSignal.kind || (filesChanged.length ? 'PRODUCT_EDIT' : 'RED'),
            elapsedMs: declaredSignal && Number.isSafeInteger(declaredSignal.elapsedMs)
              ? declaredSignal.elapsedMs : Math.max(0, this.monotonicNow() - this.admissionStartedAt),
            evidenceHash: declaredSignal && declaredSignal.evidenceHash || hashText(stableStringify({ filesChanged, redCommand })),
            reason: declaredSignal && (declaredSignal.reason || declaredSignal.blocker) ||
              result.firstProductSignalBlocker || null,
          })
        }
        if (benchmarkFirstProductSignalDeadlineEnabled(
          scheduler.budget.admissionHardMs,
          this.options.baseEnvironment || process.env,
        )) {
          scheduler.assertFirstProductSignalDue({
            elapsedMs: Math.max(0, this.monotonicNow() - this.admissionStartedAt),
            reason: result && result.firstProductSignalBlocker,
          })
        }
      }
      if (mutationBefore && !mutationAdmission) {
        validateCanonicalChildResult({
          workItemId: request.workItemId,
          logicalRole: policy.child,
          physicalRole,
          candidateHash: request.candidateHash || null,
          findingIds: canonicalAssignment && canonicalAssignment.findingIds || [],
        }, result, this.options.runId, this.requestPointer.hash)
        mutationAdmission = workerWorkspace.manager.inspect(workerWorkspace, result)
      }
      if (mutationPermit) {
        for (const resource of canonicalAssignment.resources.filter(item => item.access !== 'read')) {
          const current = resourceStateEntry(targetWorkingDirectory, resource)
          if (current && resource.expectedPreimageHash !== current.hash) {
            throw new SupervisorIntegrationError(
              'CONCURRENT_MUTATION',
              `owned resource changed before isolated CAS promotion: ${resource.identity}`,
            )
          }
        }
        if (request.deferPromotion === true) {
          pendingDeferredPromotion = {
            candidateHash: hashWorkspaceCandidate(workingDirectory, this.options.gitEnvironment(workingDirectory)),
            workspacePath: workingDirectory,
            workerWorkspace,
            mutationAdmission,
            mutationPermit,
            canonicalAssignment,
            workItemId: request.workItemId,
          }
        } else {
          const promotedPostimages = workerWorkspace.manager.promote(workerWorkspace, mutationAdmission)
          await this.options.mutationEnforcer.commit({
            assignment: canonicalAssignment,
            permit: mutationPermit,
            postimages: promotedPostimages,
            isolation: workerWorkspace.binding,
            workItemId: request.workItemId,
          })
          mutationPermit = null
          workerWorkspace.manager.finalize(workerWorkspace)
        }
      }
      if (pendingDeferredPromotion) {
        deferredPromotionHandle = this._registerDeferredPromotion(pendingDeferredPromotion)
        mutationPermit = null
      }
      if (checkKey && (!result || result.candidateHash !== request.candidateHash)) {
        throw new SupervisorIntegrationError(
          'CHECK_RESULT_CANDIDATE_MISMATCH',
          'checker result must bind the exact admitted version hash',
        )
      }
      if (!result || result.usageStreamed !== true) {
        const terminalUsage = result && result.usage
        if (!terminalUsage || !['noncachedInput', 'cachedInput', 'output', 'reasoning']
            .every(field => Number.isSafeInteger(terminalUsage[field]) && terminalUsage[field] >= 0)) {
          throw new SupervisorIntegrationError(
            'INCOMPLETE_USAGE_ACCOUNTING',
            'non-streaming model completion must report all four token categories',
          )
        }
        const authorization = lease.authorizeUsage(terminalUsage)
        const report = lease.reportUsage(terminalUsage, {
          productive: request.purpose !== 'recovery',
          progressKind: CHECKER_ROLES.has(policy.child) ? 'verification' : 'work',
        })
        usageSequence += 1
        this._checkpointAccounting({
          kind: 'TOKEN_USAGE_RECORDED',
          causeId: `model-terminal:${hashText(sessionId).slice(0, 24)}:${usageSequence}`,
          humanDescription: 'Persist complete terminal model usage from a non-streaming launcher.',
        }, { tokenUsage: terminalUsage })
        const tokens = Object.values(terminalUsage).reduce((total, value) => total + Number(value), 0)
        if (tokens > 0) this.budget.consumeTokens(tokens)
        if (authorization.allowed !== true || report.continue !== true) {
          const error = new SupervisorIntegrationError('BUDGET_EXHAUSTED', 'terminal model usage exhausted the scheduler budget')
          error.usage = terminalUsage
          throw error
        }
      }
      if (checkKey) this.consumedChecks.add(checkKey)
      if (checkKey && this.record && typeof this.record.write === 'function') {
        const persistedResult = { ...result, transcriptEvidence: transcriptReferences }
        const rawOutputHash = hashText(JSON.stringify(persistedResult))
        const harness = request.harnessAttestation || {}
        if (![harness.repoHash, harness.buildHash, harness.oracleHash].every(value => /^[a-f0-9]{64}$/.test(value || ''))) {
          throw new SupervisorIntegrationError(
            'HARNESS_ATTESTATION_REQUIRED',
            'checker reuse requires exact repository, build, and acceptance-check hashes',
          )
        }
        const harnessAttestation = {
          ...harness,
          rawOutputHash,
          persistedResultHash: rawOutputHash,
        }
        const proofAttestation = {
          candidateHash: request.candidateHash,
          oracleHash: harness.oracleHash,
          environmentHash,
          rawOutputHash,
          persistedResultHash: rawOutputHash,
          verdict: result.outcome || result.verdict || 'DONE',
        }
        const cacheEligible = result.code === 'PASS' && request.deferProofAcceptance !== true
        // FAIL and runtime-inconclusive outcomes are durable retry/repair
        // evidence, never acceptance-cache entries. Caching them under the
        // same harness identity would collide with the fresh retry verdict.
        const harnessRecord = cacheEligible
          ? scheduler.recordHarnessAttestation(harnessAttestation)
          : null
        const proofRecord = cacheEligible
          ? scheduler.recordProofCache(proofAttestation)
          : null
        const proof = {
          schemaVersion: 2,
          cacheEligible,
          candidateHash: request.candidateHash,
          oracle,
          environmentHash,
          evidenceBinding,
          result: persistedResult,
          resultHash: hashText(JSON.stringify(persistedResult)),
          harnessAttestation,
          harnessRecord,
          proofAttestation,
          proofRecord,
        }
        const proofRelative = `checks/review-results/${checkKey}.json`
        this.record.write(proofRelative, `${JSON.stringify(proof, null, 2)}\n`)
        if (result.code === 'PASS' && !cacheEligible) {
          this.deferredCheckerProofs.set(request.workItemId, Object.freeze({
            checkKey,
            proofRelative,
            proof: Object.freeze(proof),
          }))
        }
      }
      // Persist every canonical child result at its assignment-bound location.
      // Checker proofs remain separately recorded under checks/, while this
      // immutable result artifact is the bounded evidence-pointer target used
      // by same-author ROADMAP repair and crash-safe resume.
      if (canonicalAssignment && this.record && typeof this.record.write === 'function') {
        this._writeCanonicalResult(request.workItemId, result, canonicalAssignment.resultLocation)
      }
      if (policy.child !== 'route-analyst') {
        this._persistWorkerContext(
          request.workItemId,
          executorKey,
          result && result.contextId || continuationId || sessionId,
          policy.child,
          terminalReceiptBinding,
          terminalReceiptRelative,
        )
      }
      if (result && result.externalOperation) {
        this.recoveryExternalOperations.set(result.externalOperation.operationId, result.externalOperation)
      }
      if (!request.retainLease) {
        lease.complete({})
        leaseSettled = true
        const checkerPassed = checkerVerdictPassed(policy.child, result)
        if (checkerPassed) addCanonicalCompletedChecker(this.recoveryCompletedCheckIds, request.workItemId)
        else if (!CHECKER_ROLES.has(policy.child)) this.recoveryCompletedWorkIds.add(request.workItemId)
        this.recoveryThreads.delete(lease.id)
        this._persistRecoveryCheckpoint({
          kind: CHECKER_ROLES.has(policy.child)
            ? (checkerPassed ? 'CHECK_COMPLETED' : 'FRONTIER_CHANGED')
            : 'LEASE_COMPLETED',
          causeId: `scheduler:${this.activation.generation}:${lease.id}:completed`,
          humanDescription: 'Persist the completed model result and released scheduler lease as one recovery point.',
        }, {
          candidateHash: request.candidateHash || null,
          nextReadyWorkIds: durableNextReadyAfter(
            policy.child,
            result,
            requestNextReadyAfterCompletion(),
            [],
            request.workItemId,
            request.checkerRecoveryDisposition || null,
          ),
        })
      } else {
        this.recoveryThreads.delete(lease.id)
        this._persistRecoveryCheckpoint({
          kind: 'FRONTIER_CHANGED',
          causeId: `scheduler:${this.activation.generation}:${lease.id}:retained-parent`,
          humanDescription: 'Persist a completed model result retained only as a live scheduler topology parent.',
        }, {
          candidateHash: request.candidateHash || null,
          nextReadyWorkIds: requestNextReadyAfterCompletion(),
        })
      }
      this.budget.endSession(sessionId, { status: 'DONE', evidenceHashes: result && result.evidenceHashes || [] })
      this.budget.assertAvailable({ forWork: request.purpose !== 'recovery' })
      const returned = { ...result, transcriptEvidence: transcriptReferences }
      Object.defineProperty(returned, STREAMED_ROUTE_EVENT_COUNT, { value: streamedRouteEventCount })
      if (deferredPromotionHandle) {
        Object.defineProperty(returned, 'deferredPromotion', {
          enumerable: false,
          configurable: false,
          writable: false,
          value: deferredPromotionHandle,
        })
      }
      if (request.retainLease) {
        returned.retainedLease = {
          schedulerLease: lease,
          completed: false,
          workItemId: request.workItemId,
          isChecker: CHECKER_ROLES.has(policy.child),
          candidateHash: request.candidateHash || null,
          caller: this.rolePolicy.bindCaller({
            logicalRole: policy.child,
            physicalRole,
            sessionId,
            runId: this.options.runId,
            generation: this.activation.generation,
          }),
        }
        if (policy.child === 'mission-coordinator') {
          this.retainedL1Leases.set(request.workItemId, returned.retainedLease)
        }
      }
      return returned
    } catch (error) {
      if (checkerSnapshotBefore) {
        try {
          const after = hashWorkspaceCandidate(targetWorkingDirectory, this.options.gitEnvironment(targetWorkingDirectory))
          if (after !== checkerSnapshotBefore) {
            const drift = new SupervisorIntegrationError(
              'CHECKER_SNAPSHOT_MUTATED',
              'checker changed the frozen exact-version snapshot before failing',
              { expectedCandidateHash: checkerSnapshotBefore, actualCandidateHash: after, priorError: serializeError(error) },
            )
            error = drift
          }
        } catch (snapshotError) {
          if (snapshotError.code === 'CHECKER_SNAPSHOT_MUTATED') error = snapshotError
          else error.snapshotVerificationFailure = serializeError(snapshotError)
        }
      }
      if (error && (typeof error === 'object' || typeof error === 'function') && Object.isExtensible(error)) {
        Object.defineProperty(error, STREAMED_ROUTE_EVENT_COUNT, { value: streamedRouteEventCount, configurable: true })
      }
      if (externalOperation && error && ['MISSION_TIMEOUT', 'EXTERNAL_WRITE_DEADLINE_EXPIRED'].includes(error.code)) {
        const reconciled = reconcileExternalOperationTimeout(externalOperation, this.recoveryExternalOperations)
        this.recoveryExternalOperations.set(reconciled.operationId, reconciled)
        error.details = { ...(error.details || {}), externalOperation: reconciled, terminalBudgetOutcome: 'PARTIAL' }
      }
      let workspaceAbortFailed = false
      if (deferredPromotionHandle) {
        try { await deferredPromotionHandle.abort(error.code || 'worker completion failed') } catch (abortError) {
          workspaceAbortFailed = true
          error.workspaceAbortError = { code: abortError.code, message: abortError.message }
        }
      }
      if (mutationPermit && workerWorkspace) {
        try { workerWorkspace.manager.abort(workerWorkspace) } catch (abortError) {
          workspaceAbortFailed = true
          error.workspaceAbortError = { code: abortError.code, message: abortError.message }
        }
      }
      if (!workspaceAbortFailed && mutationPermit && this.options.mutationEnforcer &&
          typeof this.options.mutationEnforcer.abort === 'function') {
        try {
          await this.options.mutationEnforcer.abort({
            assignment: canonicalAssignment,
            permit: mutationPermit,
            isolation: workerWorkspace && workerWorkspace.binding,
            workItemId: request.workItemId,
            error,
          })
        } catch (abortError) {
          error.mutationAbortError = { code: abortError.code, message: abortError.message }
        }
      }
      if (!leaseSettled) {
        try { lease.fail(error, error && error.usage ? error.usage : {}) } catch (accountingError) {
          // Never let a secondary incomplete-usage finding erase the primary
          // physical-role, ownership, or CAS rejection.  The scheduler is
          // disposed during terminal release and the missing usage remains
          // attached as explicit evidence rather than being fabricated.
          error.accountingFailure = serializeError(accountingError)
        }
      }
      persistTerminalSession(this.budget, sessionId, {
        status: error.code === 'MISSION_TIMEOUT' ? 'PARTIAL' : 'FAILED', evidenceHashes: [],
      }, error)
      throw error
    }
  }

  _withinMissionDeadline(operation) {
    if ((this.options.baseEnvironment || process.env).AUTOPROMPT_BENCHMARK_NO_TIMEOUT_LIMIT === '1') {
      return Promise.resolve().then(operation)
    }
    const status = this.budget.assertAvailable({ forWork: true })
    return withTimeout(operation, status.remaining.wallMs, this.timerApi, 'MISSION_TIMEOUT', async () => {
      if (this.scheduler) this.scheduler.dispose('original-request deadline elapsed')
      await this.processOwner.cancelAll({
        reason: 'original-request deadline elapsed',
        terminalStatus: 'PARTIAL',
      })
      await this.processOwner.assertDrained()
    })
  }

  async _withinFirstProductSignalDeadline(operation, scheduler, request) {
    const missionOperation = () => this._withinMissionDeadline(operation)
    if (!request || request.route === 'PRE_ROUTE') return missionOperation()
    const existing = scheduler.getMetrics().economics.firstProductSignal
    if (existing) return missionOperation()
    const ceilingMs = request.route === 'DIRECT'
      ? ADMISSION_COMPONENT_CEILINGS_MS.routeAnalyst + ADMISSION_COMPONENT_CEILINGS_MS.routeDecision
      : request.route === 'LIGHT'
        ? ADMISSION_COMPONENT_CEILINGS_MS.routeAnalyst + ADMISSION_COMPONENT_CEILINGS_MS.routeDecision +
          ADMISSION_COMPONENT_CEILINGS_MS.lightPlanning
        : scheduler.budget.admissionHardMs
    if (!benchmarkFirstProductSignalDeadlineEnabled(
      ceilingMs,
      this.options.baseEnvironment || process.env,
    )) return missionOperation()
    const elapsedMs = Math.max(0, this.monotonicNow() - this.admissionStartedAt)
    const remainingMs = ceilingMs - elapsedMs
    if (remainingMs <= 0) {
      return scheduler.assertFirstProductSignalDue({ elapsedMs: ceilingMs + 1 })
    }
    const missionPromise = Promise.resolve().then(missionOperation)
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = this.timerApi.setTimeout(() => {
        if (settled) return
        if (scheduler.getMetrics().economics.firstProductSignal) return
        settled = true
        Promise.resolve(this.processOwner.cancelAll({
          reason: 'first RED/product-edit ceiling elapsed',
          terminalStatus: 'FAILED',
        })).catch(() => {})
        try {
          scheduler.assertFirstProductSignalDue({ elapsedMs: ceilingMs + 1 })
        } catch (error) {
          reject(error)
        }
      }, remainingMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      missionPromise.then(value => {
        if (settled) return
        settled = true
        this.timerApi.clearTimeout(timer)
        resolve(value)
      }, error => {
        if (settled) return
        settled = true
        this.timerApi.clearTimeout(timer)
        reject(error)
      })
    })
  }

  _budgetPauseFrontier() {
    const runtime = typeof this.options.runtimeStateProvider === 'function'
      ? this.options.runtimeStateProvider() : null
    const persisted = this.latestRecoveryCheckpoint
    const record = persisted && persisted.record
    const scheduler = record && record.checkpoint && record.checkpoint.scheduler
    if (!runtime || !['PREPARE_WORK', 'RUN_WORK', 'ITEM_VERIFIED', 'CHECK_WORK', 'REPAIRING', 'CHECK_INCONCLUSIVE'].includes(runtime.state) ||
        !scheduler || !Array.isArray(scheduler.nextReadyWorkIds) ||
        !/^[a-f0-9]{64}$/.test(record.checkpointPayloadHash || '')) return null
    const remaining = this.budget.status().remaining.wallMs
    const resumeState = record.checkpoint.recovery && record.checkpoint.recovery.resumeState
    if (resumeState !== runtime.state) return null
    return {
      resumeState,
      nextReadyWorkIds: [...scheduler.nextReadyWorkIds],
      remainingBudgetSeconds: Math.max(0, remaining / 1000),
      continuationBindingHash: record.checkpointPayloadHash,
    }
  }

  async _suspendResumable(outcome, result = {}) {
    if (this.finished) throw new SupervisorIntegrationError('TERMINAL_DUPLICATE', 'runtime already stopped')
    if (this.suspending && this.suspensionPromise) return this.suspensionPromise
    if (this.suspending) throw new SupervisorIntegrationError('TERMINAL_FINALIZATION_IN_PROGRESS', 'runtime pause is already draining')
    if (this.resumableSuspensionIntent) {
      outcome = this.resumableSuspensionIntent.outcome
      result = this.resumableSuspensionIntent.result
    } else {
      this.resumableSuspensionIntent = Object.freeze({ outcome, result })
    }
    this.suspending = true
    const attempt = (async () => {
      const runtime = typeof this.options.runtimeStateProvider === 'function'
        ? this.options.runtimeStateProvider() : null
      const alreadyPaused = Boolean(result.transition && runtime && runtime.state === 'PAUSED')
      if (!alreadyPaused) {
        if (this.scheduler) this.scheduler.dispose(`resumable ${outcome}`)
        await this._drainOwnedProcessesWithOneRetry(`resumable ${outcome}`, 'PARTIAL')
      }
      if (result.transition && !alreadyPaused) {
        const metrics = this.scheduler && this.scheduler.getMetrics()
        if (!this.scheduler || !metrics || metrics.counters.currentLiveChildren !== 0 ||
            metrics.rootAccounting.status === 'live') {
          throw new SupervisorIntegrationError(
            'PAUSE_DRAIN_CHECKPOINT_REQUIRED',
            'resumable pause requires a fully drained scheduler before its continuation is released',
          )
        }
        const nextReadyWorkIds = [...result.transition.frontier.nextReadyWorkIds]
        const persisted = this._persistRecoveryCheckpoint({
          kind: 'CHECKPOINT',
          causeId: `pause-post-drain:${this.activation.generation}`,
          humanDescription: 'Bind the clean resumable pause to the exact post-drain scheduler and continuation.',
        }, {
          schedulerCheckpoint: this.scheduler.exportState(),
          nextReadyWorkIds,
          openCheckIds: [],
        })
        const checkpointPayloadHash = persisted && persisted.record && persisted.record.checkpointPayloadHash
        if (!/^[a-f0-9]{64}$/.test(checkpointPayloadHash || '')) {
          throw new SupervisorIntegrationError(
            'PAUSE_DRAIN_CHECKPOINT_REQUIRED',
            'resumable pause did not persist its exact post-drain recovery checkpoint',
          )
        }
        const frontier = {
          ...result.transition.frontier,
          nextReadyWorkIds,
          continuationBindingHash: checkpointPayloadHash,
        }
        await this._runtimeTransition(result.transition.eventId, 'PAUSED', { frontier })
      }
      if (result.transition) {
        if (typeof this.options.preparePausedRelease === 'function') {
          const description = this.missionLock.describe(this.lease)
          const history = Array.isArray(description.owner.ownedProcessHistory)
            ? description.owner.ownedProcessHistory : []
          const ownedIdentityEvidence = history.length
            ? await this.processOwner.verifyDrainedIdentities(history) : []
          this.missionLock.updateOwnedProcesses(this.lease, [])
          this.missionLock.release(this.lease, {
            releaseEvidence: this.options.preparePausedRelease(),
            ownedIdentityEvidence,
          })
        } else {
          this.missionLock.release(this.lease)
        }
      } else {
        this.missionLock.release(this.lease)
      }
      this.finished = true
      const settled = {
        outcome,
        resumable: true,
        route: this.route,
        terminalEnvelope: result.terminalEnvelope || null,
        budget: this.budget.snapshot(),
        scheduler: this.scheduler ? this.scheduler.getMetrics() : null,
        schedulerState: this.scheduler && this.scheduler.getMetrics().counters.currentLiveChildren === 0
          ? this.scheduler.exportState() : null,
      }
      this.settledResult = settled
      return settled
    })()
    this.suspensionPromise = attempt
    try {
      return await attempt
    } finally {
      this.suspending = false
      if (!this.finished) this.suspensionPromise = null
    }
  }

  async _drainOwnedProcessesWithOneRetry(reason, terminalStatus) {
    let priorError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.processOwner.cancelAll({ reason, terminalStatus })
        await this.processOwner.assertDrained()
        return
      } catch (error) {
        priorError = error
      }
    }
    throw priorError
  }

  async _runtimeTransition(eventId, nextState, details = {}) {
    this._enforceBudgetPhase(lifecycleBudgetPhase({ nextState }), {
      boundary: 'runtime-transition', eventId, nextState,
    })
    if (typeof this.options.runtimeTransition !== 'function') return null
    const transitioned = await this.options.runtimeTransition({ eventId, nextState, details })
    if (transitioned && Number.isSafeInteger(transitioned.sequence) && transitioned.sequence > 0 &&
        /^[a-f0-9]{64}$/.test(transitioned.lastEventHash || '')) {
      this.lastAcceptedProgress = Object.freeze({
        kind: 'transition',
        accepted: true,
        activationId: this.activation.id,
        generation: this.activation.generation,
        sequence: transitioned.sequence,
        evidenceHash: transitioned.lastEventHash,
      })
    }
    if (this.scheduler && !['RELEASING_LOCK', 'WAITING_USER', 'PAUSED', 'DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED']
      .includes(nextState)) {
      if (RECOVERABLE_RUNTIME_STATES.has(nextState) && !Array.isArray(details.nextReadyWorkIds)) {
        throw new SupervisorIntegrationError(
          'RECOVERY_FRONTIER_REQUIRED',
          `${nextState} requires an explicit exact physical next-ready list before it can be checkpointed`,
        )
      }
      const nextReadyWorkIds = Array.isArray(details.nextReadyWorkIds)
        ? [...details.nextReadyWorkIds] : []
      if (new Set(nextReadyWorkIds).size !== nextReadyWorkIds.length ||
          nextReadyWorkIds.some(id => typeof id !== 'string' || !id)) {
        throw new SupervisorIntegrationError(
          'RECOVERY_FRONTIER_INVALID',
          `${nextState} next-ready work must contain only unique physical work identities`,
        )
      }
      this._persistRecoveryCheckpoint({
        kind: details.candidateHash ? 'CANDIDATE_FROZEN' : 'FRONTIER_CHANGED',
        causeId: `state:${this.activation.generation}:${nextState}:${transitioned && transitioned.sequence || 0}`,
        humanDescription: `Persist the exact scheduler next ready work after canonical state ${nextState}.`,
      }, {
        candidateHash: details.candidateHash,
        openCheckIds: details.openCheckIds || [],
        nextReadyWorkIds,
      })
    }
    return transitioned
  }

  async _enterTerminalRelease(outcome, error, terminalEnvelope = null) {
    if (!this.finalizer || typeof this.options.runtimeStateProvider !== 'function') return outcome
    const opened = this.options.runtimeStateProvider()
    let state = opened && opened.state
    if (state === 'RELEASING_LOCK') return outcome
    if (outcome === 'CANCELLED') {
      await this._runtimeTransition('CANCEL_REQUESTED', 'RELEASING_LOCK')
      return 'CANCELLED'
    }
    if (outcome === 'PARTIAL') {
      if (terminalEnvelope && terminalEnvelope.status === 'CHECK_REMAINS_INCONCLUSIVE' &&
          state === 'CHECK_INCONCLUSIVE') {
        await this._runtimeTransition('CHECK_REMAINS_INCONCLUSIVE', 'RELEASING_LOCK', {
          candidateHash: terminalEnvelope.currentVersionHash || terminalEnvelope.candidateHash || null,
          checkerResultHash: hashText(JSON.stringify(terminalEnvelope)),
        })
        return 'PARTIAL'
      }
      await this._runtimeTransition('BUDGET_EXHAUSTED_FINAL', 'RELEASING_LOCK')
      return 'PARTIAL'
    }
    if (outcome === 'BLOCKED' && ['PREPARE_WORK', 'RUN_WORK', 'ITEM_VERIFIED', 'CHECK_WORK', 'REPAIRING'].includes(state)) {
      await this._runtimeTransition('ENVIRONMENT_BLOCKED', 'RELEASING_LOCK', {
        errorCode: error && error.code || 'DIAGNOSTIC_DENIAL_BLOCKED',
      })
      return 'BLOCKED'
    }
    const errorCode = error && error.code || 'FAILED'
    if (outcome === 'FAILED' && ENVIRONMENT_FAILURE_CODES.has(errorCode) &&
        ['PREPARE_WORK', 'RUN_WORK', 'ITEM_VERIFIED', 'CHECK_WORK', 'REPAIRING'].includes(state)) {
      await this._runtimeTransition('ENVIRONMENT_BLOCKED', 'RELEASING_LOCK', { errorCode })
      return 'BLOCKED'
    }
    const workerContextFailure = WORKER_CONTEXT_FAILURE_CODES.has(errorCode) &&
      ['RUN_WORK', 'REPAIRING'].includes(state)
    if (outcome === 'FAILED' && !workerContextFailure && CONTROLLER_FAILURE_RELEASE_STATES.has(state)) {
      await this._runtimeTransition(
        terminalEnvelope && ['PREPARE_WORK', 'RUN_WORK', 'CHECK_WORK', 'REPAIRING'].includes(state)
          ? 'CHECK_FAILED_FINAL' : 'CONTROLLER_FAILED_FINAL',
        'RELEASING_LOCK', {
        errorCode,
        })
      return 'FAILED'
    }
    if (['RUN_WORK', 'REPAIRING'].includes(state)) {
      await this._runtimeTransition('WORKER_CONTEXT_LOST', 'WORKER_CONTEXT_LOST', {
        errorCode: error && error.code || 'FAILED',
      })
      state = 'WORKER_CONTEXT_LOST'
    }
    if (state === 'WORKER_CONTEXT_LOST') {
      await this._runtimeTransition('WORKER_CONTEXT_UNRECOVERABLE', 'RELEASING_LOCK', {
        errorCode: error && error.code || 'FAILED',
      })
      return 'FAILED'
    }
    if (['PREPARE_WORK', 'CHECK_WORK'].includes(state)) {
      await this._runtimeTransition('ENVIRONMENT_BLOCKED', 'RELEASING_LOCK', {
        errorCode: error && error.code || 'FAILED',
      })
      return 'BLOCKED'
    }
    return outcome
  }

  async _bestEffortPostDrainCheckpoint(reason) {
    const result = {
      attempted: typeof this.options.persistRecoveryCheckpoint === 'function' && Boolean(this.scheduler),
      status: 'UNAVAILABLE',
      reason,
    }
    if (!result.attempted) return Object.freeze(result)
    try {
      const persisted = await Promise.resolve(this._persistRecoveryCheckpoint({
        kind: 'CHECKPOINT',
        causeId: `cancel-post-drain:${this.activation.generation}`,
        humanDescription: 'Best-effort cancellation checkpoint after the owned process tree is proven drained.',
      }, { nextReadyWorkIds: [], openCheckIds: [] }))
      return Object.freeze({
        ...result,
        status: persisted ? 'PERSISTED' : 'UNAVAILABLE',
        checkpointPayloadHash: persisted && persisted.record && persisted.record.checkpointPayloadHash || null,
      })
    } catch (error) {
      return Object.freeze({ ...result, status: 'FAILED', error: serializeError(error) })
    }
  }

  async cancel(reason = 'cancel requested') {
    if (this.settledResult) return this.settledResult
    if (this.finalizing && this.finalizationPromise) return this.finalizationPromise
    if (this.suspending && this.suspensionPromise) return this.suspensionPromise
    if (this.cancellationPromise) return this.cancellationPromise
    const attempt = this._cancelOnce(reason)
    this.cancellationPromise = attempt
    try {
      return await attempt
    } catch (error) {
      this.cancellationPromise = null
      throw error
    }
  }

  async _cancelOnce(reason) {
    this.cancelled = true
    if (this.lease && this.starting && this.startupReadyPromise) {
      await this.startupReadyPromise
    }
    if (this.settledResult) return this.settledResult
    if (this.finalizing && this.finalizationPromise) return this.finalizationPromise
    if (this.suspending && this.suspensionPromise) return this.suspensionPromise
    if (this.scheduler) this.scheduler.dispose(reason)
    await this._drainOwnedProcessesWithOneRetry(reason, 'CANCELLED')
    const postDrainCheckpoint = await this._bestEffortPostDrainCheckpoint(reason)
    if (this.lease && !this.finished) {
      const cancellation = new SupervisorIntegrationError('CANCELLED', reason)
      const terminalOutcome = await this._enterTerminalRelease('CANCELLED', cancellation)
      return this._finish(terminalOutcome, {
        processTreeDrained: true,
        postDrainCheckpoint,
        terminalEnvelope: { status: 'CANCELLED', reason, postDrainCheckpoint },
      })
    }
    const settled = { outcome: 'CANCELLED', reason, postDrainCheckpoint }
    this.finished = true
    this.settledResult = settled
    return settled
  }

  async _finish(outcome, result = {}) {
    if (this.finished) throw new SupervisorIntegrationError('TERMINAL_DUPLICATE', 'runtime already finalized')
    if (this.finalizing && this.finalizationPromise) return this.finalizationPromise
    if (this.finalizing) throw new SupervisorIntegrationError('TERMINAL_FINALIZATION_IN_PROGRESS', 'runtime finalization is already draining')
    if (this.terminalFinalizationIntent) {
      outcome = this.terminalFinalizationIntent.outcome
      result = this.terminalFinalizationIntent.result
    }
    if (outcome === 'DONE') {
      const deliverables = Array.isArray(result.deliverables) ? result.deliverables : []
      const checkHashes = Array.isArray(result.checkHashes) ? result.checkHashes : []
      if (deliverables.length === 0 && !validReadOnlyFinalResponse(result.finalResponse)) {
        throw new SupervisorIntegrationError(
          'USER_USABLE_BUILD_REQUIRED',
          'DONE short-circuits before terminal worker-group checks when no current user-usable deliverable exists',
        )
      }
      if (checkHashes.length === 0 || checkHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
        throw new SupervisorIntegrationError(
          'BUILD_ACCEPTANCE_REQUIRED',
          'DONE requires completed hash-bound build acceptance before terminal independent review and testing',
        )
      }
    }
    if (!this.terminalFinalizationIntent) {
      this.terminalFinalizationIntent = Object.freeze({ outcome, result })
    }
    this.finalizing = true
    const attempt = (async () => {
      if (result.processTreeDrained !== true) {
        if (this.scheduler) this.scheduler.dispose('terminal finalization')
        await this.processOwner.cancelAll({ reason: 'terminal finalization', terminalStatus: outcome })
        await this.processOwner.assertDrained()
      }
      const activeScheduler = this.scheduler
      const schedulerMetrics = activeScheduler ? activeScheduler.getMetrics() : null
      let schedulerState = null
      if (activeScheduler && schedulerMetrics.counters.currentLiveChildren === 0) {
        try {
          schedulerState = activeScheduler.exportState()
        } catch (error) {
          if (!error || error.code !== 'LIVE_STATE_NOT_EXPORTABLE' || outcome === 'DONE') throw error
        }
      }
      const finalizationBudget = this._enforceBudgetPhase(
        'FINALIZATION_RELEASE',
        { boundary: 'terminal-finalization', outcome },
      )
      let finalized
      if (this.finalizer && typeof this.finalizer.finalize === 'function') {
        const diagnostics = terminalFinalizationDiagnostics(result)
        finalized = await this.finalizer.finalize({
          outcome,
          reason: diagnostics.reason,
          unblockPath: diagnostics.unblockPath,
          deliverables: result.deliverables || [],
          checkHashes: result.checkHashes || [],
          terminalEnvelope: diagnostics.terminalEnvelope,
          expectedEpoch: result.expectedEpoch,
        })
      } else {
        this.missionLock.release(this.lease)
        finalized = { outcome, durable: false, reason: 'runtime record was unavailable before finalizer creation' }
      }
      this.finished = true
      const settled = {
        outcome,
        route: this.route,
        terminalEnvelope: result.terminalEnvelope || null,
        finalResponse: result.finalResponse || null,
        postDrainCheckpoint: result.postDrainCheckpoint || null,
        finalizationBudget,
        finalized,
        budget: this.budget.snapshot(),
        scheduler: schedulerMetrics,
        schedulerState,
      }
      this.settledResult = settled
      return settled
    })()
    this.finalizationPromise = attempt
    try {
      return await attempt
    } finally {
      this.finalizing = false
      if (!this.finished) this.finalizationPromise = null
    }
  }

  _preLeaseOutcome(outcome, details) {
    return { outcome, route: null, activationId: this.activation.id, details }
  }
}

function readRegularJson(filename, label) {
  const resolved = fs.realpathSync.native(path.resolve(filename))
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', `${label} must be one regular non-linked file`)
  }
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) } catch (error) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', `${label} is invalid JSON`, { cause: error.message })
  }
  return { parsed, resolved }
}

function appendCanonicalRouteEvent(record, event, raw) {
  if (!record || typeof record.appendRouteEvent !== 'function') {
    throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'streamed route event requires the canonical route transcript')
  }
  const options = raw === undefined || raw === null
    ? {}
    : { rawBytes: Buffer.from(String(raw), 'utf8'), mimeType: 'application/jsonl' }
  return record.appendRouteEvent(event, options)
}

function readPersistedWorkerAssignment(record, workItemId, expected = {}) {
  if (!record || typeof record.resolve !== 'function' || typeof workItemId !== 'string' || !workItemId) {
    throw new SupervisorIntegrationError('ASSIGNMENT_REPLAY_INVALID', 'fresh worker replay requires a run record and work item id')
  }
  const relative = `work/assignments/${hashText(workItemId)}.json`
  const absolute = record.resolve(relative)
  if (!fs.existsSync(absolute)) {
    throw new SupervisorIntegrationError('ASSIGNMENT_REPLAY_MISSING', `persisted assignment is missing: ${workItemId}`)
  }
  const assignment = readRegularJson(absolute, 'persisted worker assignment').parsed
  if (!assignment || assignment.schemaVersion !== '2.0.0' || assignment.reportType !== 'assignment' ||
      assignment.assignmentId !== workItemId || assignment.runId !== expected.runId ||
      assignment.requestEnvelopeHash !== expected.requestEnvelopeHash ||
      (expected.logicalRoleId && assignment.logicalRoleId !== expected.logicalRoleId) ||
      !Array.isArray(assignment.findingIds) || assignment.findingIds.length === 0 ||
      !Array.isArray(assignment.resources) || !Array.isArray(assignment.successChecklist) ||
      assignment.successChecklist.length === 0 || !Array.isArray(assignment.checks) || assignment.checks.length === 0 ||
      !Array.isArray(assignment.forbiddenChanges) || assignment.forbiddenChanges.length === 0 ||
      typeof assignment.resultLocation !== 'string' || !assignment.resultLocation) {
    throw new SupervisorIntegrationError('ASSIGNMENT_REPLAY_INVALID', `persisted assignment is incomplete or foreign: ${workItemId}`)
  }
  return Object.freeze(JSON.parse(JSON.stringify(assignment)))
}

function replayRequestFromPersistedAssignment(assignment) {
  if (!assignment || assignment.reportType !== 'assignment') {
    throw new SupervisorIntegrationError('ASSIGNMENT_REPLAY_INVALID', 'canonical assignment is required for fresh replay')
  }
  const hasWriteResources = assignment.resources.some(resource => resource && resource.access === 'write')
  const resources = assignment.resources
    .filter(resource => !hasWriteResources || resource.access === 'write')
    .map(resource => Object.freeze({
    kind: resource.kind,
    identity: resource.identity,
    owner: resource.owner,
    ownershipMode: resource.ownershipMode || 'single-owner',
    }))
  return Object.freeze({
    assignment: assignment.requestedResult,
    successChecklist: assignment.successChecklist.map(item => item.description),
    success: assignment.successChecklist.map(item => item.description),
    findingIds: [...assignment.findingIds],
    ownership: resources,
    manifests: resources,
    snapshotProjection: assignment.snapshotProjection
      ? Object.freeze(JSON.parse(JSON.stringify(assignment.snapshotProjection))) : null,
    replayedAssignmentPath: `work/assignments/${hashText(assignment.assignmentId)}.json`,
  })
}

function buildActivationPromptEnvelope(record) {
  const request = record && record.request
  const capability = record && record.capability
  const target = record && record.target
  if (!request || !capability || !target || typeof record.activationId !== 'string' ||
      typeof capability.recordPath !== 'string' || typeof request.sha256 !== 'string' ||
      !Number.isSafeInteger(request.bytes) || typeof request.canonicalBase64 !== 'string' ||
      !Array.isArray(request.argv) || typeof target.realpath !== 'string' ||
      typeof capability.parentSession !== 'string' || typeof capability.parentRole !== 'string' ||
      !Array.isArray(capability.legalChildren) || !Number.isSafeInteger(capability.generation) ||
      typeof capability.expiresAt !== 'string' || typeof request.canonicalJson !== 'string') {
    throw new SupervisorIntegrationError(
      'ACTIVATION_RECEIPT_INVALID',
      'activation record lacks the canonical structural prompt fields',
    )
  }
  const resumeActivationId = record.supervisorEntry?.resumeActivationId ?? null
  if (![null, record.activationId].includes(resumeActivationId)) {
    throw new SupervisorIntegrationError(
      'ACTIVATION_RECEIPT_INVALID', 'resume activation id does not match the activation record',
    )
  }
  const structuralInvocation = resumeActivationId === null
    ? '$autoprompt'
    : `$autoprompt resume ${resumeActivationId}`
  return [
    structuralInvocation,
    'AUTOPROMPT_REQUEST_ENVELOPE_V2',
    `activation_id=${record.activationId}`,
    `capability_record=${capability.recordPath}`,
    `request_sha256=${request.sha256}`,
    `request_bytes=${request.bytes}`,
    `request_base64=${request.canonicalBase64}`,
    `request_argv_json=${JSON.stringify(request.argv)}`,
    `target_realpath=${target.realpath}`,
    `parent_session=${capability.parentSession}`,
    `parent_role=${capability.parentRole}`,
    `legal_child=${capability.legalChildren.join(',')}`,
    `generation=${capability.generation}`,
    `expires_at=${capability.expiresAt}`,
    'REQUEST_ARGV_BEGIN',
    request.canonicalJson,
    'REQUEST_ARGV_END',
  ].join('\n')
}

function physicalProviderRoleForGeneration(providerRole, payloadGeneration) {
  if (!/^ap-[a-z0-9-]+$/.test(providerRole || '') ||
      !/^codex-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$/.test(payloadGeneration || '')) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'physical role generation is malformed')
  }
  return `autoprompt-${payloadGeneration.replace(/[^a-z0-9]+/g, '-')}-${providerRole}`
}

function validateActivationRoleProjection(record, profilePath, activationRoot) {
  const projection = record.roleProjection || {}
  const aliases = projection.logicalToPhysicalProviderRole
  const expectedRoles = Object.keys(loadCodexPhysicalRolePolicy().physical_roles).sort()
  if (projection.schemaVersion !== 1 ||
      !/^codex-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$/.test(projection.payloadGeneration || '') ||
      !aliases || typeof aliases !== 'object' || Array.isArray(aliases) ||
      JSON.stringify(Object.keys(aliases).sort()) !== JSON.stringify(expectedRoles)) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'physical role projection is incomplete')
  }
  const profile = fs.readFileSync(profilePath, 'utf8')
  if (/^\[agents\.ap-[a-z0-9-]+\]$/m.test(profile)) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'unversioned physical provider role is active')
  }
  const declared = [...profile.matchAll(/^\[agents\."([a-z0-9-]+)"\]$/gm)].map(match => match[1])
  if (declared.length !== expectedRoles.length || new Set(declared).size !== declared.length) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'physical role profile inventory is ambiguous')
  }
  for (const providerRole of expectedRoles) {
    const physical = physicalProviderRoleForGeneration(providerRole, projection.payloadGeneration)
    if (aliases[providerRole] !== physical || !declared.includes(physical)) {
      throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', `physical role generation mismatch: ${providerRole}`)
    }
    const section = profile.split(`[agents."${physical}"]`)[1]
    const body = section == null ? '' : section.split(/^\[/m)[0]
    const relative = /^config_file\s*=\s*"([^"\r\n]+)"$/m.exec(body)?.[1]
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..') ||
        path.posix.basename(relative.replace(/\\/g, '/')) !== `${physical}.toml`) {
      throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', `physical role file mismatch: ${providerRole}`)
    }
    const agentPath = path.resolve(path.dirname(profilePath), ...relative.replace(/\\/g, '/').split('/'))
    const containment = path.relative(activationRoot, agentPath)
    let stat
    try { stat = fs.lstatSync(agentPath) } catch {
      throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', `physical role file is missing: ${providerRole}`)
    }
    if (!containment || path.isAbsolute(containment) || containment === '..' ||
        containment.startsWith(`..${path.sep}`) || !stat.isFile() || stat.isSymbolicLink() ||
        Number(stat.nlink) !== 1) {
      throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', `physical role file is unsafe: ${providerRole}`)
    }
  }
  return Object.freeze({
    schemaVersion: projection.schemaVersion,
    payloadGeneration: projection.payloadGeneration,
    logicalToPhysicalProviderRole: Object.freeze({ ...aliases }),
  })
}

function validateActivationInputs(args = {}, environment = process.env, adapterPath = __filename) {
  const activationRecord = args['activation-record'] || environment.AUTOPROMPT_ACTIVATION_RECORD
  const enforcementProof = args['enforcement-proof'] || environment.AUTOPROMPT_ENFORCEMENT_PROOF
  const profilePath = args['profile-path'] || environment.AUTOPROMPT_PROFILE_PATH
  const runId = args['run-id'] || environment.AUTOPROMPT_RUN_ID
  if (![activationRecord, enforcementProof, profilePath].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      typeof runId !== 'string' || !runId) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'activation record, proof, profile, and run id pointers are required')
  }
  const recordRead = readRegularJson(activationRecord, 'activation record')
  const proofRead = readRegularJson(enforcementProof, 'enforcement proof')
  const record = recordRead.parsed
  const activationRoot = fs.realpathSync.native(path.dirname(recordRead.resolved))
  const canonicalProfile = fs.realpathSync.native(path.resolve(profilePath))
  const checkerProfilePath = environment.AUTOPROMPT_CHECKER_PROFILE_PATH ||
    record.activationBoundary?.enforcementProof?.checkerProfilePath
  const canonicalCheckerProfile = fs.realpathSync.native(path.resolve(checkerProfilePath || ''))
  const canonicalAdapter = fs.realpathSync.native(path.resolve(adapterPath))
  for (const [label, candidate] of [['profile', canonicalProfile], ['checker-profile', canonicalCheckerProfile], ['adapter', canonicalAdapter], ['proof', proofRead.resolved]]) {
    const relative = path.relative(activationRoot, candidate)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', `${label} must be inside the activation root`)
    }
  }
  if (record.schemaVersion !== 2 || record.activationId !== runId ||
      fs.realpathSync.native(path.resolve(record.activationRoot)) !== activationRoot ||
      record.status !== 'active' || !record.capability || record.capability.status !== 'consumed' ||
      record.capability.singleUse !== true || record.capability.generation < 1) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'activation identity/status/generation binding is invalid')
  }
  if (JSON.stringify(record.contractVersions) !== JSON.stringify({
    settings: '2.0.0',
    requestEnvelopeEntry: '2.0.0',
    outcome: '2.0.0',
    providerCapabilities: '2.0.0',
    activationRequest: '1.0.0',
  }) || record.aliasTelemetry && (
    record.aliasTelemetry.schemaVersion !== '2.0.0' ||
    record.aliasTelemetry.appendPath !== 'compatibility/alias-telemetry.jsonl' ||
    record.aliasTelemetry.registeredRunRecordPath !== false
  )) {
    throw new SupervisorIntegrationError('CONTRACT_UPGRADE_REQUIRED', 'activation contract versions or alias telemetry binding are incompatible')
  }
  if (new Date(record.capability.expiresAt).getTime() <= Date.now()) {
    throw new SupervisorIntegrationError('ACTIVATION_EXPIRED', 'activation capability has expired')
  }
  const supervisorRuntime = record.supervisorRuntime || {}
  if (typeof supervisorRuntime.runPath !== 'string' || !path.isAbsolute(supervisorRuntime.runPath) ||
      supervisorRuntime.runId !== runId || !/^[a-f0-9]{64}$/.test(supervisorRuntime.metadataSha256 || '') ||
      typeof supervisorRuntime.targetIdentity !== 'string' || !supervisorRuntime.targetIdentity ||
      !Number.isFinite(new Date(supervisorRuntime.createdAt).getTime())) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'registered supervisor runtime binding is missing or invalid')
  }
  const canonicalRunPath = fs.realpathSync.native(path.resolve(supervisorRuntime.runPath))
  const runRelative = path.relative(activationRoot, canonicalRunPath)
  if (!runRelative || path.isAbsolute(runRelative) || runRelative === '..' || runRelative.startsWith(`..${path.sep}`)) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'registered supervisor runtime escapes the activation root')
  }
  const metadataRead = readRegularJson(path.join(canonicalRunPath, 'metadata.json'), 'supervisor runtime metadata')
  const metadataBytes = fs.readFileSync(metadataRead.resolved)
  const metadataDigestRead = fs.readFileSync(path.join(canonicalRunPath, 'metadata.sha256'), 'utf8').trim()
  if (crypto.createHash('sha256').update(metadataBytes).digest('hex') !== supervisorRuntime.metadataSha256 ||
      metadataDigestRead !== supervisorRuntime.metadataSha256 ||
      metadataRead.parsed.run_id !== runId || metadataRead.parsed.run_path !== canonicalRunPath ||
      metadataRead.parsed.target_path !== record.target.realpath ||
      metadataRead.parsed.target_identity !== supervisorRuntime.targetIdentity ||
      metadataRead.parsed.provider_id !== 'codex' || metadataRead.parsed.local_only !== true ||
      metadataRead.parsed.automatic_export_allowed !== false) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'registered supervisor runtime metadata binding drifted')
  }
  const runtimeReceiptBinding = record.supervisorRuntimeReceipt || {}
  if (typeof runtimeReceiptBinding.path !== 'string' || !path.isAbsolute(runtimeReceiptBinding.path) ||
      !/^[a-f0-9]{64}$/.test(runtimeReceiptBinding.sha256 || '') ||
      !Number.isSafeInteger(runtimeReceiptBinding.capabilityGeneration) ||
      runtimeReceiptBinding.capabilityGeneration < 1 ||
      runtimeReceiptBinding.capabilityGeneration > record.capability.generation) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'supervisor runtime receipt binding is missing or invalid')
  }
  const runtimeReceiptRead = readRegularJson(runtimeReceiptBinding.path, 'supervisor runtime receipt')
  const receiptRelative = path.relative(activationRoot, runtimeReceiptRead.resolved)
  const canonicalRuntimeBinding = {
    runPath: canonicalRunPath,
    runId: supervisorRuntime.runId,
    metadataSha256: supervisorRuntime.metadataSha256,
    targetIdentity: supervisorRuntime.targetIdentity,
    createdAt: supervisorRuntime.createdAt,
  }
  const canonicalBindingBytes = Buffer.from(JSON.stringify(canonicalRuntimeBinding), 'utf8')
  const runtimeReceiptBytes = fs.readFileSync(runtimeReceiptRead.resolved)
  const runtimeReceipt = runtimeReceiptRead.parsed
  if (!receiptRelative || path.isAbsolute(receiptRelative) || receiptRelative === '..' ||
      receiptRelative.startsWith(`..${path.sep}`) ||
      crypto.createHash('sha256').update(runtimeReceiptBytes).digest('hex') !== runtimeReceiptBinding.sha256 ||
      runtimeReceipt.schemaVersion !== 1 || runtimeReceipt.activationId !== runId ||
      runtimeReceipt.requestSha256 !== record.request.sha256 ||
      runtimeReceipt.targetRealpath !== record.target.realpath ||
      runtimeReceipt.capabilityGeneration !== runtimeReceiptBinding.capabilityGeneration ||
      runtimeReceipt.bindingSha256 !== crypto.createHash('sha256').update(canonicalBindingBytes).digest('hex') ||
      JSON.stringify(runtimeReceipt.binding) !== JSON.stringify(canonicalRuntimeBinding)) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'supervisor runtime receipt bytes or binding drifted')
  }
  if ((environment.AUTOPROMPT_SUPERVISOR_RUN_PATH &&
      path.resolve(environment.AUTOPROMPT_SUPERVISOR_RUN_PATH) !== canonicalRunPath) ||
      (environment.AUTOPROMPT_SUPERVISOR_RUN_METADATA_SHA256 &&
      environment.AUTOPROMPT_SUPERVISOR_RUN_METADATA_SHA256 !== supervisorRuntime.metadataSha256)) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'supervisor runtime environment pointers drifted from the receipt')
  }
  const canonicalRequest = Buffer.from(JSON.stringify({ schemaVersion: 1, argv: record.request && record.request.argv }), 'utf8')
  if (!record.request || !Array.isArray(record.request.argv) || record.request.argv.length === 0 ||
      record.request.argv.some(value => typeof value !== 'string') || record.request.bytes !== canonicalRequest.length ||
      record.request.sha256 !== crypto.createHash('sha256').update(canonicalRequest).digest('hex') ||
      record.request.canonicalJson !== canonicalRequest.toString('utf8') ||
      record.request.canonicalBase64 !== canonicalRequest.toString('base64')) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'exact request argv hash/byte binding is invalid')
  }
  const entryPrompt = buildActivationPromptEnvelope(record)
  const entry = record.supervisorEntry || {}
  const entryResumeActivationId = entry.resumeActivationId ?? null
  const expectedStructuralInvocation = entryResumeActivationId === null
    ? '$autoprompt'
    : `$autoprompt resume ${record.activationId}`
  if (entry.schemaVersion !== 1 ||
      ![null, record.activationId].includes(entryResumeActivationId) ||
      entry.structuralInvocation !== expectedStructuralInvocation ||
      entry.requestSha256 !== record.request.sha256 || entry.prompt !== entryPrompt ||
      entry.promptSha256 !== crypto.createHash('sha256').update(Buffer.from(entryPrompt, 'utf8')).digest('hex')) {
    throw new SupervisorIntegrationError(
      'ACTIVATION_RECEIPT_INVALID',
      'structural $autoprompt entry prompt is absent, drifted, or not request-bound',
    )
  }
  const boundary = record.activationBoundary || {}
  const proofBinding = boundary.enforcementProof || {}
  if (fs.realpathSync.native(path.resolve(proofBinding.path || '')) !== proofRead.resolved ||
      fs.realpathSync.native(path.resolve(proofBinding.profilePath || '')) !== canonicalProfile ||
      proofBinding.sha256 !== crypto.createHash('sha256').update(fs.readFileSync(proofRead.resolved)).digest('hex') ||
      proofBinding.profileSha256 !== crypto.createHash('sha256').update(fs.readFileSync(canonicalProfile)).digest('hex') ||
      fs.realpathSync.native(path.resolve(proofBinding.checkerProfilePath || '')) !== canonicalCheckerProfile ||
      proofBinding.checkerProfileSha256 !== crypto.createHash('sha256').update(fs.readFileSync(canonicalCheckerProfile)).digest('hex') ||
      proofRead.parsed.profileSha256 !== proofBinding.profileSha256 ||
      proofRead.parsed.checkerProfilePath !== canonicalCheckerProfile ||
      proofRead.parsed.checkerProfileSha256 !== proofBinding.checkerProfileSha256 ||
      proofRead.parsed.profilePath !== canonicalProfile || proofRead.parsed.strictConfig !== true ||
      proofRead.parsed.selectedProfile !== 'autoprompt' ||
      proofRead.parsed.checkerSelectedProfile !== 'autoprompt-checker') {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'enforcement proof/profile hash binding is invalid')
  }
  if (fs.realpathSync.native(path.resolve(boundary.supervisorAdapter || '')) !== canonicalAdapter) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'supervisor adapter does not match the activation receipt')
  }
  const manifestRead = readRegularJson(path.join(activationRoot, 'activation-payload.json'), 'activation payload manifest')
  const manifestBytes = fs.readFileSync(manifestRead.resolved)
  if (boundary.payloadManifest && fs.realpathSync.native(path.resolve(boundary.payloadManifest)) !== manifestRead.resolved ||
      boundary.payloadManifestSha256 !== crypto.createHash('sha256').update(manifestBytes).digest('hex')) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'activation payload manifest binding drifted')
  }
  const relativeAdapter = path.relative(activationRoot, canonicalAdapter).split(path.sep).join('/')
  const manifestEntry = Array.isArray(manifestRead.parsed.files)
    ? manifestRead.parsed.files.find(entry => entry.path === relativeAdapter)
    : null
  if (!manifestEntry || manifestEntry.sha256 !== crypto.createHash('sha256').update(fs.readFileSync(canonicalAdapter)).digest('hex')) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'supervisor adapter is absent or drifted from the activation payload receipt')
  }
  if (boundary.supervisorAdapterSha256 !== manifestEntry.sha256) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'supervisor adapter boundary hash drifted')
  }
  const roleProjection = validateActivationRoleProjection(record, canonicalProfile, activationRoot)
  const modelSelection = record.modelSelection || {}
  const explicitEffort = modelSelection.effort
  const explicitEffortValid = ['low', 'medium', 'high', 'xhigh', 'max'].includes(explicitEffort) ||
    Boolean(explicitEffort && typeof explicitEffort === 'object' && !Array.isArray(explicitEffort) &&
      explicitEffort.status === 'selectable' && typeof explicitEffort.source === 'string' &&
      explicitEffort.source.length > 0)
  if (modelSelection.schemaVersion !== 1 || !['provider-default', 'auto', 'explicit'].includes(modelSelection.mode) ||
      typeof modelSelection.selector !== 'string' || !Array.isArray(modelSelection.models) ||
      modelSelection.models.some(model => typeof model !== 'string' || !model) ||
      (modelSelection.mode === 'explicit' && (
        modelSelection.models.length !== 1 ||
        !explicitEffortValid ||
        modelSelection.probeAcceptance &&
          modelSelection.probeAcceptance.explicitModelAndEffortAssignments !== true
      )) ||
      !/^[a-f0-9]{64}$/.test(modelSelection.castingHash || '') ||
      !/^[a-f0-9]{64}$/.test(modelSelection.agentDefinitionsHash || '') ||
      modelSelection.probeAcceptance && (
        modelSelection.probeAcceptance.strictConfig !== true ||
        !Number.isFinite(Date.parse(modelSelection.probeAcceptance.profileAcceptedAt)) ||
        typeof modelSelection.probeAcceptance.explicitModelAndEffortAssignments !== 'boolean'
      )) {
    throw new SupervisorIntegrationError('ACTIVATION_RECEIPT_INVALID', 'model-selection receipt is invalid')
  }
  let modelRegistry = null
  if (modelSelection.mode === 'auto') {
    const registryBinding = modelSelection.registry || {}
    if (typeof registryBinding.path !== 'string' || !path.isAbsolute(registryBinding.path) ||
        !/^[a-f0-9]{64}$/.test(registryBinding.sha256 || '')) {
      throw new SupervisorIntegrationError('MODEL_REGISTRY_REQUIRED', 'automatic model selection requires a receipt-bound registry')
    }
    const registryRead = readRegularJson(registryBinding.path, 'model registry')
    const registryRelative = path.relative(activationRoot, registryRead.resolved)
    if (!registryRelative || path.isAbsolute(registryRelative) || registryRelative === '..' ||
        registryRelative.startsWith(`..${path.sep}`) ||
        crypto.createHash('sha256').update(fs.readFileSync(registryRead.resolved)).digest('hex') !== registryBinding.sha256 ||
        !registryRead.parsed || typeof registryRead.parsed !== 'object' || Array.isArray(registryRead.parsed)) {
      throw new SupervisorIntegrationError('MODEL_REGISTRY_REQUIRED', 'automatic model registry bytes are invalid or foreign')
    }
    let openedRegistry
    try {
      openedRegistry = validateReceiptBoundRegistry(registryRead.parsed)
    } catch (error) {
      throw new SupervisorIntegrationError('MODEL_REGISTRY_REQUIRED', 'automatic model registry receipt is invalid', {
        cause: error.code || error.message,
      })
    }
    modelRegistry = openedRegistry.entries.map(entry => ({ ...entry, id: entry.id || entry.modelString || entry.name }))
  }
  const activationAttestation = verifyActivationProviderAttestation(record, environment)
  return Object.freeze({
    activationAttestation,
    activationRoot,
    adapterPath: canonicalAdapter,
    enforcementProof: proofRead.parsed,
    entryPrompt,
    profilePath: canonicalProfile,
    checkerProfilePath: canonicalCheckerProfile,
    record,
    recordPath: recordRead.resolved,
    requestArgv: Object.freeze([...record.request.argv]),
    runId,
    modelRegistry: modelRegistry && Object.freeze(modelRegistry),
    modelSelection: Object.freeze({ ...modelSelection }),
    roleProjection,
    supervisorRuntime: Object.freeze({ ...supervisorRuntime, runPath: canonicalRunPath }),
  })
}

function parseActivationControlPrefix(rawArgv) {
  const argv = Array.isArray(rawArgv) ? rawArgv.map(value => String(value)) : []
  const explicit = { concurrency: { mode: 'tokensaver' } }
  let pathControlCount = 0
  let missionStart = argv.length
  const capturePath = value => {
    const normalized = String(value == null ? '' : value).toLowerCase()
    pathControlCount += 1
    explicit.path = pathControlCount === 1
      ? normalized
      : '__duplicate_path_control__'
    return ['direct', 'light', 'roadmap'].includes(normalized)
  }
  const startsPathControl = token => typeof token === 'string' &&
    (/^(?:--)?path=/iu.test(token) || token.toLowerCase() === '--path')
  const closeExactPathPrefix = index => {
    const nextIndex = index + 1
    if (argv[nextIndex] === '--') return nextIndex + 1
    if (startsPathControl(argv[nextIndex])) {
      capturePath('__immediate_duplicate__')
    }
    return nextIndex
  }
  /*
   * Control grammar: only a contiguous argv prefix is parsed. The prefix may
   * contain bare concurrency modes, path=<value>, --path=<value>,
   * --path <value>, --concurrency/--mode <value>, and --max-subs <value>.
   * An exact direct/light/roadmap path closes the prefix when it is consumed;
   * path=auto leaves it open so later prefix controls retain their meaning.
   * The first non-control token (or `--`) starts mission content permanently;
   * every later token, including quoted or literal path= examples, is text.
   */
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index])
    if (token === '--') {
      missionStart = index + 1
      break
    }
    if (['tokensaver', 'wide', 'custom'].includes(token.toLowerCase())) {
      explicit.concurrency.mode = token.toLowerCase()
    } else if (/^(?:--)?path=/iu.test(token)) {
      if (capturePath(token.slice(token.indexOf('=') + 1))) {
        missionStart = closeExactPathPrefix(index)
        break
      }
    } else if (token.toLowerCase() === '--path') {
      if (capturePath(argv[++index])) {
        missionStart = closeExactPathPrefix(index)
        break
      }
    } else if (token === '--concurrency' || token === '--mode') {
      explicit.concurrency.mode = String(argv[++index] || '').toLowerCase()
    } else if (token === '--max-subs') {
      explicit.concurrency.maxSubs = argv[++index]
      if (explicit.concurrency.mode === 'tokensaver') explicit.concurrency.mode = 'custom'
    } else {
      missionStart = index
      break
    }
  }
  return Object.freeze({
    explicit,
    controls: Object.freeze(argv.slice(0, missionStart)),
    missionArgv: Object.freeze(argv.slice(missionStart)),
    missionStart,
  })
}

const EXACT_PATH_FORBIDDEN_CONTROL_NAMES = Object.freeze([
  'concurrency', 'agent', 'thread', 'parallel', 'subagent', 'worker', 'delegate',
])

function parseExactPathInvocation(rawArgv, expectedRoute = null) {
  if (!Array.isArray(rawArgv) || rawArgv.length < 1 ||
      rawArgv.some(value => typeof value !== 'string')) {
    return Object.freeze({ valid: false, reason: 'invalid-argv' })
  }
  const argv = [...rawArgv]
  let missionStart = 0
  let pathValue = null
  if (/^(?:--)?path=/iu.test(argv[0])) {
    pathValue = argv[0].slice(argv[0].indexOf('=') + 1)
    missionStart = 1
  } else if (argv[0].toLowerCase() === '--path') {
    if (argv.length < 3) return Object.freeze({ valid: false, reason: 'incomplete-path-control' })
    pathValue = argv[1]
    missionStart = 2
  }
  if (argv[missionStart] === '--') {
    missionStart += 1
  } else if (typeof argv[missionStart] === 'string' &&
      (/^(?:--)?path=/iu.test(argv[missionStart]) || argv[missionStart].toLowerCase() === '--path')) {
    return Object.freeze({ valid: false, reason: 'duplicate-path-control' })
  }
  const missionArgv = argv.slice(missionStart)
  const normalizedPath = pathValue === null ? null : String(pathValue).toUpperCase()
  if (pathValue === null || missionArgv.length < 1 ||
      !['DIRECT', 'LIGHT', 'ROADMAP'].includes(normalizedPath) ||
      (expectedRoute && normalizedPath !== String(expectedRoute).toUpperCase())) {
    return Object.freeze({ valid: false, reason: 'extra-or-invalid-control' })
  }
  return Object.freeze({
    valid: true,
    controls: Object.freeze(argv.slice(0, missionStart)),
    missionArgv: Object.freeze(missionArgv),
    pathRoute: normalizedPath,
  })
}

function activationRuntimeSettings(activation, context = {}) {
  const parsedControls = parseActivationControlPrefix(activation.requestArgv)
  const explicit = parsedControls.explicit
  if (explicit.path && explicit.path !== 'auto' &&
      !parseExactPathInvocation(activation.requestArgv, explicit.path).valid) {
    explicit.path = '__invalid_exact_path_controls__'
  }
  const modelSelection = activation.modelSelection
  const modelRouting = { selector: modelSelection.selector }
  if (modelSelection.mode === 'explicit' && modelSelection.models.length === 1) {
    modelRouting.explicitUserModelPin = modelSelection.models[0]
    if (typeof modelSelection.effort === 'string') {
      modelRouting.explicitUserEffortPin = modelSelection.effort
    }
  }
  explicit.modelRouting = modelRouting
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  const providerMaximum = clampNonNegInt(context.providerMaximum, Math.max(1, Math.min(10, available)))
  return {
    explicit,
    providerId: 'codex',
    capabilities: { modelRouting: true, wideMaxSubs: providerMaximum },
    interactive: process.stdin.isTTY === true,
    ...((activation.deadline || activation.record && activation.record.deadline || context.deadline)
      ? { deadline: { ...(activation.deadline || activation.record && activation.record.deadline || context.deadline) } }
      : {}),
  }
}

function readPrivateAgentAssignment(activation, providerRole, logicalRole, environment = process.env) {
  if (activation.modelSelection.mode === 'provider-default') {
    const effort = selectEffort({ role: logicalRole || providerRole.replace(/^ap-/, '') })
    return applyBenchmarkEffortPin(Object.freeze({
      model: null,
      effort: effort.effort,
      source: 'role-effort-policy',
      registryMatched: false,
      routeIndependent: true,
    }), environment)
  }
  if (providerRole === 'ap-run-owner') {
    if (activation.modelSelection.mode === 'explicit') {
      const policyEffort = selectEffort({ role: logicalRole || 'run-owner' }).effort
      return applyBenchmarkEffortPin(Object.freeze({
        model: activation.modelSelection.models[0],
        effort: typeof activation.modelSelection.effort === 'string'
          ? activation.modelSelection.effort
          : policyEffort,
        source: 'explicit',
        registryMatched: false,
      }), environment)
    }
    return applyBenchmarkEffortPin(Object.freeze(selectModelAssignment({
      role: logicalRole || 'run-owner',
      difficulty: 'hard',
      risk: 'high',
      registry: activation.modelRegistry || [],
      requiredCapabilities: ['contextFreeDispatch'],
    })), environment)
  }
  const profileSource = fs.readFileSync(activation.profilePath, 'utf8')
  const physicalProviderRole = activation.roleProjection?.logicalToPhysicalProviderRole?.[providerRole]
  const expectedPhysicalRole = physicalProviderRoleForGeneration(
    providerRole, activation.roleProjection?.payloadGeneration,
  )
  if (physicalProviderRole !== expectedPhysicalRole) {
    throw new SupervisorIntegrationError(
      'MODEL_ASSIGNMENT_INVALID', `private Codex role generation is not receipt-bound: ${providerRole}`,
    )
  }
  const escapedRole = physicalProviderRole.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const section = new RegExp(
    `^\\[agents\\."${escapedRole}"\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    'm',
  ).exec(profileSource)
  const configFile = section && /^config_file\s*=\s*"([^"]+)"\s*$/m.exec(section[1])
  if (!configFile) {
    throw new SupervisorIntegrationError('MODEL_ASSIGNMENT_INVALID', `private Codex profile lacks active generation: ${providerRole}`)
  }
  const agentPath = path.resolve(path.dirname(activation.profilePath), ...configFile[1].replace(/\\/g, '/').split('/'))
  if (!agentPath.startsWith(`${activation.activationRoot}${path.sep}`)) {
    throw new SupervisorIntegrationError('MODEL_ASSIGNMENT_INVALID', `private Codex role escaped activation root: ${providerRole}`)
  }
  let source
  try {
    const stat = fs.lstatSync(agentPath)
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) throw new Error('not one regular file')
    source = fs.readFileSync(agentPath, 'utf8')
  } catch (error) {
    throw new SupervisorIntegrationError('MODEL_ASSIGNMENT_INVALID', `private Codex role assignment is unreadable: ${providerRole}`, {
      cause: error.message,
    })
  }
  const model = /^model\s*=\s*"([^"]+)"\s*$/m.exec(source)
  const effort = /^model_reasoning_effort\s*=\s*"([^"]+)"\s*$/m.exec(source)
  if (!model || !effort || !activation.modelSelection.models.includes(model[1]) ||
      (activation.modelSelection.mode === 'explicit' && typeof activation.modelSelection.effort === 'string' &&
        effort[1] !== activation.modelSelection.effort) ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort[1])) {
    throw new SupervisorIntegrationError('MODEL_ASSIGNMENT_INVALID', `private Codex role assignment is not receipt-compatible: ${providerRole}`)
  }
  return applyBenchmarkEffortPin(Object.freeze({
    model: model[1], effort: effort[1], source: activation.modelSelection.mode,
    registryMatched: activation.modelSelection.mode === 'auto',
  }), environment)
}

function runGit(repository, argv, options = {}) {
  const result = childProcess.spawnSync('git', ['-C', repository, ...argv], {
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env: options.environment,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new SupervisorIntegrationError('GIT_LOCAL_OPERATION_FAILED', `local Git operation failed: ${argv.join(' ')}`, {
      status: result.status,
      stderr: String(result.stderr || '').slice(-4096),
      cause: result.error && result.error.message,
    })
  }
  return result.stdout
}

function hashWorkspaceCandidate(repository, environment) {
  const listing = Buffer.from(runGit(repository, ['ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: null, environment,
  }))
  const names = listing.toString('utf8').split('\0').filter(Boolean).sort()
  const digest = crypto.createHash('sha256')
  for (const name of names) {
    const absolute = path.join(repository, ...name.split('/'))
    digest.update(Buffer.from(`${name}\0`, 'utf8'))
    if (!fs.existsSync(absolute)) {
      digest.update(Buffer.from('missing\0'))
      continue
    }
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) {
      throw new SupervisorIntegrationError('CANDIDATE_UNSAFE', `exact version contains a non-regular tracked input: ${name}`)
    }
    digest.update(Buffer.from(`${stat.mode & 0o777}\0${stat.size}\0`, 'utf8'))
    digest.update(fs.readFileSync(absolute))
    digest.update(Buffer.from('\0'))
  }
  return digest.digest('hex')
}

function planCheckerProjection(request) {
  if (!request || request.logicalRole !== 'plan-checker') return null
  const pointer = request.roadmapSlice ?? request.roadmap_slice
  if (!pointer || typeof pointer.path !== 'string' || !path.isAbsolute(pointer.path) ||
      !/^[a-f0-9]{64}$/u.test(pointer.sha256 || '') ||
      !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 0) {
    throw new SupervisorIntegrationError(
      'PLAN_PROJECTION_INVALID',
      'plan checker requires one exact authenticated ROADMAP projection pointer',
    )
  }
  if (request.candidateHash !== pointer.sha256) {
    throw new SupervisorIntegrationError(
      'PLAN_PROJECTION_INVALID',
      'plan checker exact-version hash differs from its admitted ROADMAP bytes',
    )
  }
  return Object.freeze({
    relativePath: 'plan/ROADMAP.md',
    sourcePath: path.resolve(pointer.path),
    sha256: pointer.sha256,
    bytes: pointer.bytes,
  })
}

function canonicalCompletedCheckerId(workItemId) {
  const value = String(workItemId || '')
  if (/^roadmap-plan-(?:check|recheck)-runtime-retry$/u.test(value)) {
    return value.replace(/-runtime-retry$/u, '')
  }
  const independent = /^(independent-check-\d+)(?:-repair-\d+)?(?:-runtime-retry-\d+)?$/u.exec(value)
  if (independent) return independent[1]
  return value
}

function addCanonicalCompletedChecker(completed, workItemId) {
  if (!(completed instanceof Set) || typeof workItemId !== 'string' || !workItemId) return
  completed.add(workItemId)
}

function planProjectionReceipt(projection, snapshotPath, identity = {}) {
  const body = {
    schemaVersion: 1,
    runId: typeof identity.runId === 'string' ? identity.runId : null,
    generation: Number.isSafeInteger(identity.generation) ? identity.generation : null,
    checkerId: typeof identity.checkerId === 'string' ? identity.checkerId : null,
    relativePath: projection.relativePath,
    sourcePath: path.resolve(projection.sourcePath),
    sha256: projection.sha256,
    bytes: projection.bytes,
    snapshotPath: fs.realpathSync.native(path.resolve(snapshotPath)),
    adoptedFromReceiptHash: typeof identity.adoptedFromReceiptHash === 'string'
      ? identity.adoptedFromReceiptHash : null,
  }
  return Object.freeze({ ...body, receiptHash: hashText(stableStringify(body)) })
}

function validatePlanCheckerSnapshot(snapshotPath, request, receipt = null, expectedIdentity = null) {
  const projection = planCheckerProjection(request)
  if (!projection) return hashWorkspaceCandidate(snapshotPath, process.env)
  const destination = path.resolve(snapshotPath, ...projection.relativePath.split('/'))
  if (!pathIsInside(snapshotPath, destination)) {
    throw new SupervisorIntegrationError('PLAN_PROJECTION_INVALID', 'projected ROADMAP escaped the checker snapshot')
  }
  let bytes
  try { bytes = readFileNoFollow(destination) } catch (error) {
    throw new SupervisorIntegrationError('PLAN_PROJECTION_INVALID', 'projected ROADMAP is not one safe regular file', {
      cause: error.code || error.message,
    })
  }
  const actualHash = bytes && sha256Bytes(bytes)
  if (!bytes || bytes.length !== projection.bytes || actualHash !== projection.sha256) {
    throw new SupervisorIntegrationError(
      'PLAN_PROJECTION_MISMATCH',
      'checker snapshot does not contain the exact admitted ROADMAP bytes',
      { expectedHash: projection.sha256, actualHash: actualHash || null },
    )
  }
  if (receipt) {
    if (!expectedIdentity || typeof expectedIdentity.runId !== 'string' || !expectedIdentity.runId ||
        !Number.isSafeInteger(expectedIdentity.generation) ||
        typeof expectedIdentity.checkerId !== 'string' || !expectedIdentity.checkerId) {
      throw new SupervisorIntegrationError(
        'PLAN_PROJECTION_MISMATCH',
        'checker projection receipt validation requires the exact run, generation, and checker identity',
      )
    }
    const body = { ...receipt }
    delete body.receiptHash
    if (receipt.runId !== expectedIdentity.runId || receipt.generation !== expectedIdentity.generation ||
        receipt.checkerId !== expectedIdentity.checkerId ||
        receipt.relativePath !== projection.relativePath || receipt.sourcePath !== projection.sourcePath ||
        receipt.sha256 !== projection.sha256 || receipt.bytes !== projection.bytes ||
        receipt.snapshotPath !== fs.realpathSync.native(path.resolve(snapshotPath)) ||
        receipt.adoptedFromReceiptHash !== (expectedIdentity.adoptedFromReceiptHash || null) ||
        receipt.receiptHash !== hashText(stableStringify(body))) {
      throw new SupervisorIntegrationError('PLAN_PROJECTION_MISMATCH', 'checker projection receipt is foreign or corrupt')
    }
  }
  return actualHash
}

function changedDeliverables(repository, environment) {
  const source = String(runGit(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { environment }))
  const names = []
  for (const record of source.split('\0').filter(Boolean)) {
    const name = record.slice(3).split(' -> ').at(-1)
    const absolute = path.resolve(repository, ...name.split('/'))
    if (!absolute.startsWith(`${path.resolve(repository)}${path.sep}`) || !fs.existsSync(absolute)) continue
    const stat = fs.lstatSync(absolute)
    if (stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1) {
      names.push({ path: absolute, hash: sha256Bytes(fs.readFileSync(absolute)) })
    }
  }
  return names.sort((left, right) => left.path.localeCompare(right.path))
}

const ASSIGNMENT_RESOURCE_KINDS = new Set([
  'file', 'directory', 'service', 'database', 'output', 'cache', 'port', 'evidence-root', 'external-system',
])
const LOCAL_MUTATION_RESOURCE_KINDS = new Set(['file', 'directory', 'output', 'cache', 'evidence-root'])
const MISSING_RESOURCE_PREIMAGE_HASH = hashText('autoprompt-resource-missing-v1')

function resolveOwnedResourcePath(repository, resource) {
  if (!resource || !LOCAL_MUTATION_RESOURCE_KINDS.has(resource.kind)) return null
  const root = path.resolve(repository)
  const identity = String(resource.identity || '').replace(/\\/g, '/')
  const candidate = identity === 'workspace' || identity === '.'
    ? root
    : path.isAbsolute(identity)
      ? path.resolve(identity)
      : path.resolve(root, ...identity.split('/'))
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new SupervisorIntegrationError('OWNERSHIP_AUTHORIZATION_DENIED', `owned resource escapes the target: ${identity}`)
  }
  return candidate
}

function hashDirectoryState(directory) {
  const digest = crypto.createHash('sha256')
  const visit = (current, relative) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        throw new SupervisorIntegrationError('PREIMAGE_UNSAFE', `owned directory contains a symbolic link: ${absolute}`)
      }
      if (stat.isDirectory()) {
        digest.update(`directory\0${name}\0`)
        visit(absolute, name)
      } else if (stat.isFile() && Number(stat.nlink) === 1) {
        digest.update(`file\0${name}\0${stat.mode & 0o777}\0${stat.size}\0`)
        digest.update(fs.readFileSync(absolute))
        digest.update('\0')
      } else {
        throw new SupervisorIntegrationError('PREIMAGE_UNSAFE', `owned directory contains an unsafe entry: ${absolute}`)
      }
    }
  }
  visit(directory, '')
  return digest.digest('hex')
}

function resourceStateEntry(repository, resource) {
  const absolute = resolveOwnedResourcePath(repository, resource)
  if (!absolute) return null
  if (!fs.existsSync(absolute)) {
    return Object.freeze({ path: absolute, hash: MISSING_RESOURCE_PREIMAGE_HASH, type: 'missing' })
  }
  const stat = fs.lstatSync(absolute)
  // A regular file must have one physical link. A directory's link count is
  // expected to exceed one as soon as it contains subdirectories (`.`/`..`),
  // so applying the file invariant to checker snapshot roots rejects every
  // non-empty snapshot before independent checking can start.
  if (stat.isSymbolicLink() || (stat.isFile() && Number(stat.nlink) !== 1)) {
    throw new SupervisorIntegrationError('PREIMAGE_UNSAFE', `owned resource is not one physical target: ${absolute}`)
  }
  if (stat.isFile()) return Object.freeze({ path: absolute, hash: sha256Bytes(fs.readFileSync(absolute)), type: 'file' })
  if (stat.isDirectory()) return Object.freeze({ path: absolute, hash: hashDirectoryState(absolute), type: 'directory' })
  throw new SupervisorIntegrationError('PREIMAGE_UNSAFE', `owned resource has an unsupported physical type: ${absolute}`)
}

function assertNoLinkedPathPrefix(root, absolute, displayPath) {
  const relative = path.relative(root, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SupervisorIntegrationError(
      'MISSION_PATH_INVALID',
      `path named in the canonical child brief is missing, unsafe, or outside the target: ${displayPath}`,
    )
  }
  let cursor = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    let stat
    try { stat = fs.lstatSync(cursor) } catch (error) {
      if (error && error.code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new SupervisorIntegrationError(
        'MISSION_PATH_INVALID',
        `path named in the canonical child brief traverses a linked path: ${displayPath}`,
      )
    }
  }
}

function canonicalAssignmentResources(input) {
  const targetRoot = path.resolve(input.targetPath)
  const canonicalTargetRoot = path.resolve(input.canonicalTargetPath || input.targetPath)
  const ownership = Array.isArray(input.request.ownership) && input.request.ownership.length
    ? input.request.ownership : ['workspace']
  const manifests = Array.isArray(input.request.manifests) ? input.request.manifests : []
  const declaredFuturePaths = new Set(manifests.flatMap(item => {
    if (!item || !LOCAL_MUTATION_RESOURCE_KINDS.has(String(item.kind || '').toLowerCase())) return []
    const identity = String(item.identity || '').replace(/\\/g, '/')
    if (!identity) return []
    const canonicalAbsolute = path.isAbsolute(identity)
      ? path.resolve(identity)
      : path.resolve(canonicalTargetRoot, ...identity.split('/'))
    if (canonicalAbsolute !== canonicalTargetRoot &&
        !canonicalAbsolute.startsWith(`${canonicalTargetRoot}${path.sep}`)) return []
    return [path.resolve(targetRoot, path.relative(canonicalTargetRoot, canonicalAbsolute))]
  }))
  const rows = ownership.map(rawIdentity => {
    const identity = String(rawIdentity && rawIdentity.identity || rawIdentity)
    if (typeof rawIdentity === 'string' && identity !== 'workspace' && /\s/u.test(identity) &&
        !path.isAbsolute(identity) && !/^\.{1,2}[\\/]/u.test(identity)) {
      throw new SupervisorIntegrationError(
        'OWNERSHIP_RESOURCE_INVALID',
        'untyped descriptive prose cannot become canonical filesystem or service authority',
        { identity },
      )
    }
    const declared = manifests.find(item => item && String(item.identity || '') === identity) ||
      (rawIdentity && typeof rawIdentity === 'object' ? rawIdentity : null)
    let kind = String(declared && declared.kind || '').toLowerCase()
    if (!ASSIGNMENT_RESOURCE_KINDS.has(kind)) {
      if (identity === 'workspace') kind = 'directory'
      else {
        const candidate = path.resolve(input.targetPath, ...identity.replace(/\\/g, '/').split('/'))
        kind = fs.existsSync(candidate) && fs.lstatSync(candidate).isDirectory() ? 'directory' : 'file'
      }
    }
    const owner = String(declared && declared.owner || input.request.workItemId)
    const authorizedOwners = new Set([
      input.request.workItemId, input.request.repairOf, input.request.executorKey, input.request.equivalenceKey,
    ].filter(Boolean).map(String))
    const canonicalWorkerOwners = [
      input.request.workItemId, input.request.repairOf, input.request.executorKey,
    ].flatMap(value => {
      const match = /^work-(\d+)(?:-repair-\d+)?$/u.exec(String(value || ''))
      return match ? [match[1]] : []
    })
    for (const workerNumber of canonicalWorkerOwners) {
      authorizedOwners.add(`worker-${workerNumber}`)
      authorizedOwners.add(`implementation-worker-${workerNumber}`)
      authorizedOwners.add(`ap-worker-${workerNumber}`)
    }
    if (!input.readOnly && !authorizedOwners.has(owner)) {
      throw new SupervisorIntegrationError(
        'OWNERSHIP_AUTHORIZATION_DENIED',
        `${input.logicalRole} ${input.request.workItemId} does not own ${kind}:${identity}`,
        { owner },
      )
    }
    const resource = {
      kind,
      identity,
      access: input.readOnly ? 'read' : 'write',
      expectedPreimageHash: null,
      owner,
      ownershipMode: String(declared && (declared.ownershipMode || declared.ownership_mode) || 'single-owner'),
    }
    const state = (input.readOnly || input.enforcePreimages) ? resourceStateEntry(input.targetPath, resource) : null
    if (state) resource.expectedPreimageHash = state.hash
    if (input.readOnly && !/^[a-f0-9]{64}$/.test(resource.expectedPreimageHash || '')) {
      throw new SupervisorIntegrationError(
        'READ_RESOURCE_PREIMAGE_REQUIRED',
        `read-only resource lacks a positive preimage hash: ${kind}:${identity}`,
      )
    }
    if (['file', 'directory', 'evidence-root'].includes(kind)) {
      const absolute = resolveOwnedResourcePath(input.targetPath, resource)
      const exists = Boolean(absolute && fs.existsSync(absolute))
      const authorizedCreation = !input.readOnly && input.enforcePreimages === true &&
        resource.access === 'write' && resource.expectedPreimageHash === MISSING_RESOURCE_PREIMAGE_HASH
      if (!absolute || (!exists && !authorizedCreation)) {
        throw new SupervisorIntegrationError(
          'MISSION_PATH_INVALID',
          `canonical original-request resource does not exist before child creation: ${kind}:${identity}`,
        )
      }
      if (!exists) return resource
      const stat = fs.lstatSync(absolute)
      const validType = kind === 'file' ? stat.isFile() : stat.isDirectory()
      if (stat.isSymbolicLink() || !validType) {
        throw new SupervisorIntegrationError(
          'MISSION_PATH_INVALID',
          `canonical original-request resource has the wrong physical type: ${kind}:${identity}`,
        )
      }
    }
    return resource
  })
  const prosePaths = typeof input.request.assignment === 'string'
    ? [...input.request.assignment.matchAll(/(?:^|[\s`'"(])((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]*[A-Za-z0-9_-])+)(?=$|[\s`'"),.;:])/gu)]
        .map(match => match[1])
    : []
  const declaredOutputs = new Set(rows.filter(resource => ['output', 'cache'].includes(resource.kind))
    .map(resource => resource.identity.replace(/\\/g, '/')))
  for (const prosePath of [...new Set(prosePaths)]) {
    const normalized = prosePath.replace(/\\/g, '/')
    if (declaredOutputs.has(normalized)) continue
    const explicitPathSyntax = path.isAbsolute(prosePath) ||
      /^[A-Za-z]:[\\/]/u.test(prosePath) || /^\.{1,2}[\\/]/u.test(prosePath) ||
      /\.[A-Za-z0-9_-]+$/u.test(normalized)
    const canonicalAbsolute = path.isAbsolute(prosePath) ? path.resolve(prosePath) : null
    const canonicalRelative = canonicalAbsolute && (canonicalAbsolute === canonicalTargetRoot ||
      canonicalAbsolute.startsWith(`${canonicalTargetRoot}${path.sep}`))
      ? path.relative(canonicalTargetRoot, canonicalAbsolute) : null
    const absolute = canonicalRelative !== null
      ? path.resolve(targetRoot, canonicalRelative)
      : path.isAbsolute(prosePath)
        ? canonicalAbsolute
        : path.resolve(input.targetPath, ...normalized.replace(/^\.\//u, '').split('/'))
    const boundResource = rows.find(resource => resolveOwnedResourcePath(input.targetPath, resource) === absolute)
    const authorizedCreation = Boolean(boundResource && boundResource.access === 'write' &&
      input.enforcePreimages === true && boundResource.expectedPreimageHash === MISSING_RESOURCE_PREIMAGE_HASH)
    const declaredFutureReference = input.logicalRole === 'roadmap-author' && !input.readOnly &&
      declaredFuturePaths.has(absolute)
    if (absolute !== targetRoot && !absolute.startsWith(`${targetRoot}${path.sep}`)) {
      throw new SupervisorIntegrationError(
        'MISSION_PATH_INVALID',
        `path named in the canonical child brief is missing, unsafe, or outside the target: ${prosePath}`,
      )
    }
    assertNoLinkedPathPrefix(targetRoot, absolute, prosePath)
    if (canonicalRelative !== null) {
      assertNoLinkedPathPrefix(canonicalTargetRoot, canonicalAbsolute, prosePath)
    }
    // Natural prose can contain slash-separated terms such as
    // `JavaScript/XSS`. Treat a missing bare term as prose unless it is bound
    // by the resource manifest. Explicit absolute/dot-relative paths remain
    // fail-closed, as do every existing symlink and declared resource.
    if (!fs.existsSync(absolute) && !authorizedCreation && !declaredFutureReference) {
      if (!explicitPathSyntax && !boundResource) continue
      throw new SupervisorIntegrationError(
        'MISSION_PATH_INVALID',
        `path named in the canonical child brief is missing, unsafe, or outside the target: ${prosePath}`,
      )
    }
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
      throw new SupervisorIntegrationError(
        'MISSION_PATH_INVALID',
        `path named in the canonical child brief is missing, unsafe, or outside the target: ${prosePath}`,
      )
    }
    if (!fs.existsSync(absolute)) continue
    const alreadyBound = Boolean(boundResource)
    if (!alreadyBound) {
      const stat = fs.lstatSync(absolute)
      if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && Number(stat.nlink) !== 1)) {
        throw new SupervisorIntegrationError(
          'MISSION_PATH_INVALID',
          `path named in the canonical child brief is not one regular file or directory: ${prosePath}`,
        )
      }
      const referenced = {
        kind: stat.isDirectory() ? 'directory' : 'file',
        identity: path.relative(targetRoot, absolute).split(path.sep).join('/'),
        access: 'read',
        expectedPreimageHash: null,
        owner: String(input.request.workItemId),
        ownershipMode: 'brief-reference',
      }
      referenced.expectedPreimageHash = resourceStateEntry(input.targetPath, referenced).hash
      rows.push(referenced)
    }
  }
  for (const additional of input.additionalResources || []) {
    const resource = {
      kind: String(additional.kind),
      identity: String(additional.identity),
      access: String(additional.access),
      expectedPreimageHash: additional.expectedPreimageHash || null,
      owner: String(additional.owner || input.request.workItemId),
      ownershipMode: String(additional.ownershipMode || 'exclusive-lease'),
    }
    if (!ASSIGNMENT_RESOURCE_KINDS.has(resource.kind) ||
        !['read', 'write', 'exclusive'].includes(resource.access)) {
      throw new SupervisorIntegrationError('OWNERSHIP_AUTHORIZATION_DENIED', 'checker resource manifest is not canonical')
    }
    if (resource.access === 'read' && !/^[a-f0-9]{64}$/.test(resource.expectedPreimageHash || '')) {
      const state = resourceStateEntry(input.targetPath, resource)
      resource.expectedPreimageHash = state && state.hash
    }
    if (resource.access === 'read' && !/^[a-f0-9]{64}$/.test(resource.expectedPreimageHash || '')) {
      throw new SupervisorIntegrationError('READ_RESOURCE_PREIMAGE_REQUIRED', `read-only resource lacks a positive preimage hash: ${resource.kind}:${resource.identity}`)
    }
    rows.push(resource)
  }
  const keys = rows.map(item => `${item.kind}\0${item.identity}`)
  if (new Set(keys).size !== keys.length) {
    throw new SupervisorIntegrationError('OWNERSHIP_AUTHORIZATION_DENIED', 'canonical assignment repeats an owned resource')
  }
  return rows
}

function checkerAssignmentResources(sandboxAssignment, workItemId) {
  const kindMap = Object.freeze({ workspace: 'directory', generated: 'output', temporary: 'output' })
  return (sandboxAssignment && sandboxAssignment.schedulerResources || []).map(item => {
    const match = /^([a-z-]+):(.*)$/u.exec(String(item.id || ''))
    const schedulerKind = String(item.kind || match && match[1] || '').toLowerCase()
    const identity = String(item.physicalId || match && match[2] || item.id || '')
    const kind = kindMap[schedulerKind] || schedulerKind
    if (!ASSIGNMENT_RESOURCE_KINDS.has(kind) || !identity) {
      throw new SupervisorIntegrationError(
        'CHECKER_RESOURCE_OVERRIDE_DENIED',
        `checker sandbox resource is not representable: ${item.id || '<empty>'}`,
      )
    }
    return Object.freeze({
      kind,
      identity,
      access: item.mode === 'read' ? 'read' : 'exclusive',
      expectedPreimageHash: null,
      owner: workItemId,
      ownershipMode: ['directory', 'output', 'cache'].includes(kind) ? 'isolated-copy' : 'exclusive-lease',
    })
  })
}

function exactFindingIds(...values) {
  const ids = new Set()
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (/^AP-[A-Z]+-[0-9]{3}$/u.test(String(item))) ids.add(String(item))
      }
      continue
    }
    const source = typeof value === 'string' ? value : stableStringify(value || null)
    for (const match of source.matchAll(/AP-[A-Z]+-[0-9]{3}/gu)) ids.add(match[0])
  }
  return [...ids].sort()
}

function canonicalEvidenceBinding(input) {
  const exactHash = (value, fallback) => /^[a-f0-9]{64}$/u.test(String(value || ''))
    ? String(value) : hashText(stableStringify(fallback))
  return Object.freeze({
    missionHash: exactHash(input.missionHash, input.mission),
    planHash: exactHash(input.planHash, input.planReference || null),
    candidateHash: exactHash(input.candidateHash, input.candidateHash),
    environmentHash: exactHash(input.environmentHash, input.environment || null),
    oracleHash: exactHash(input.oracleHash, input.oracle),
    assumptionsHash: exactHash(input.assumptionsHash, input.assumptions || []),
    dependencyHash: exactHash(input.dependencyHash, input.dependencies || []),
  })
}

function schedulerProgressEvidenceHashes(request = {}) {
  return Object.freeze([...new Set(
    [].concat(request.evidenceHashes ?? request.evidence_hashes ?? [])
    .filter(Boolean)
    .map(String),
  )].sort())
}

function evidenceInvalidationSet(before, after) {
  const changed = Object.keys(before || {}).filter(key => before[key] !== (after || {})[key]).sort()
  return Object.freeze({
    changed: Object.freeze(changed),
    invalidates: Object.freeze(changed.length ? ['reviewer-verdict', 'tester-verdict'] : []),
  })
}

function schedulerResourcesForAssignment(assignment, repository) {
  return assignment.resources.map(resource => {
    const local = resolveOwnedResourcePath(repository, resource)
    const kind = local ? 'workspace' : resource.kind === 'external-system' ? 'service' : resource.kind
    return {
      id: local || resource.identity,
      kind,
      mode: resource.access === 'read' ? 'read' : 'exclusive',
    }
  })
}

function workspaceFileSnapshot(repository, environment) {
  const listing = Buffer.from(runGit(repository, ['ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: null, environment,
  })).toString('utf8').split('\0').filter(Boolean).sort()
  const snapshot = new Map()
  for (const name of listing) {
    const absolute = path.resolve(repository, ...name.split('/'))
    if (!absolute.startsWith(`${path.resolve(repository)}${path.sep}`)) {
      throw new SupervisorIntegrationError('MUTATION_SCOPE_INVALID', `workspace entry escapes the target: ${name}`)
    }
    if (!fs.existsSync(absolute)) {
      snapshot.set(name, null)
      continue
    }
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) {
      throw new SupervisorIntegrationError('MUTATION_SCOPE_INVALID', `workspace entry is not one regular file: ${name}`)
    }
    snapshot.set(name, sha256Bytes(fs.readFileSync(absolute)))
  }
  return snapshot
}

function admitActualWorkerMutation(input) {
  const after = workspaceFileSnapshot(input.repository, input.environment)
  const names = [...new Set([...input.before.keys(), ...after.keys()])].sort()
  const actual = names.filter(name => input.before.get(name) !== after.get(name))
  const writable = input.assignment.resources.filter(resource => resource.access !== 'read')
  const owns = name => {
    const absolute = path.resolve(input.repository, ...name.split('/'))
    return writable.some(resource => {
      const owned = resolveOwnedResourcePath(input.repository, resource)
      return owned && (resource.kind === 'directory'
        ? absolute === owned || absolute.startsWith(`${owned}${path.sep}`)
        : absolute === owned)
    })
  }
  const outside = actual.filter(name => !owns(name))
  if (outside.length) {
    throw new SupervisorIntegrationError(
      'OWNERSHIP_SCOPE_VIOLATION',
      'worker changed physical files outside its admitted ownership',
      { outside, admitted: writable.map(resource => `${resource.kind}:${resource.identity}`) },
    )
  }
  const reported = Array.isArray(input.result && input.result.filesChanged)
    ? [...new Set(input.result.filesChanged.map(name => String(name).replace(/\\/g, '/')))].sort() : []
  if (JSON.stringify(reported) !== JSON.stringify(actual)) {
    throw new SupervisorIntegrationError(
      'MUTATION_REPORT_MISMATCH',
      'worker file report does not match the observed workspace mutation',
      { reported, actual },
    )
  }
  return Object.freeze({
    actualFilesChanged: Object.freeze(actual),
    postimages: Object.freeze(writable.map(resource => resourceStateEntry(input.repository, resource)).filter(Boolean)),
  })
}

function assertRealTargetUnchanged(before, repository, environment) {
  const after = workspaceFileSnapshot(repository, environment)
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter(name => before.get(name) !== after.get(name)).sort()
  if (changed.length) {
    throw new SupervisorIntegrationError(
      'REAL_TARGET_WRITE_DENIED',
      'child wrote the real target before an authorized CAS promotion',
      { changed },
    )
  }
  return Object.freeze({ deniedWriteCount: 0, targetUnchanged: true })
}

function validateCanonicalChildResult(record, result, runId, requestEnvelopeHash) {
  if (!result || typeof result !== 'object') {
    throw new SupervisorIntegrationError('ROLE_REPORT_INVALID', 'Codex child returned no structured result')
  }
  if (record.logicalRole === 'route-analyst' || record.logicalRole === 'run-owner') return result
  if (CHECKER_ROLES.has(record.logicalRole)) {
    const expected = {
      schemaVersion: '2.0.0', runId, requestEnvelopeHash,
      currentVersionHash: record.candidateHash,
    }
    const actual = {
      schemaVersion: result.schemaVersion, code: result.code, runId: result.runId,
      requestEnvelopeHash: result.requestEnvelopeHash,
      currentVersionHash: result.currentVersionHash,
    }
    const mismatches = [
      ...(actual.schemaVersion !== expected.schemaVersion ? ['schemaVersion'] : []),
      ...(!CANONICAL_CHECKER_CODES.has(actual.code) ? ['code'] : []),
      ...(actual.runId !== expected.runId ? ['runId'] : []),
      ...(actual.requestEnvelopeHash !== expected.requestEnvelopeHash ? ['requestEnvelopeHash'] : []),
      ...(actual.currentVersionHash !== expected.currentVersionHash ? ['currentVersionHash'] : []),
    ]
    if (mismatches.length) {
      throw new SupervisorIntegrationError(
        'CHECK_REPORT_INVALID',
        'checker result is not bound to the admitted run, request, and exact version',
        { mismatches, expected, actual },
      )
    }
    return result
  }
  if (result.schemaVersion !== '2.0.0' || result.reportType !== 'result' ||
      result.runId !== runId || result.assignmentId !== record.workItemId ||
      result.logicalRoleId !== record.logicalRole || result.physicalRoleId !== record.physicalRole ||
      result.requestEnvelopeHash !== requestEnvelopeHash || typeof result.allAssignedItemsPass !== 'boolean' ||
      !Array.isArray(result.filesChanged) || !Array.isArray(result.commands) ||
      !Array.isArray(result.successItems) || result.successItems.length === 0 ||
      !Array.isArray(result.findingIds) || result.findingIds.length === 0 ||
      (record.findingIds || []).some(id => !result.findingIds.includes(id))) {
    throw new SupervisorIntegrationError(
      'ROLE_REPORT_INVALID',
      'work result does not match the canonical role-report result contract',
      {
        expected: {
          schemaVersion: '2.0.0', reportType: 'result', runId,
          assignmentId: record.workItemId, logicalRoleId: record.logicalRole,
          physicalRoleId: record.physicalRole, requestEnvelopeHash,
        },
        actual: {
          schemaVersion: result.schemaVersion, reportType: result.reportType, runId: result.runId,
          assignmentId: result.assignmentId, logicalRoleId: result.logicalRoleId,
          physicalRoleId: result.physicalRoleId, requestEnvelopeHash: result.requestEnvelopeHash,
          allAssignedItemsPassType: typeof result.allAssignedItemsPass,
          filesChanged: Array.isArray(result.filesChanged), commands: Array.isArray(result.commands),
          successItemCount: Array.isArray(result.successItems) ? result.successItems.length : null,
          findingIds: result.findingIds,
        },
      },
    )
  }
  if (result.allAssignedItemsPass !== true) {
    throw new SupervisorIntegrationError(
      'WORK_ITEM_RESULT_FAILED',
      'a failed work result is durable failure evidence, not a verified work-item completion',
      {
        workItemId: record.workItemId,
        reconstructedTerminal: result.reconstructedTerminal === true,
        terminalStatus: result.terminalEnvelope && result.terminalEnvelope.status || null,
      },
    )
  }
  validateWorkerRequestedTransition(result)
  return result
}

async function launchCodexChildWithCheckerReassessment(codexAdapter, launch, runId) {
  let result
  try {
    result = await codexAdapter.launch(launch)
  } catch (error) {
    if (!CHECKER_ROLES.has(launch.logicalRole) || error.code !== 'CHECK_REPORT_INVALID' ||
        !error.details || !error.details.checkerTerminalEvidence) throw error
    result = reconstructInvalidCheckerResult(launch, error.details.invalidCheckerResult, error)
    launch.onTerminalResult(result, error.details.checkerTerminalEvidence)
  }
  return validateCanonicalChildResult(launch, result, runId, launch.dispatch.requestPointer.hash)
}

function representativePolicyProbePassed(result) {
  return Boolean(result && result.allAssignedItemsPass === true &&
    Array.isArray(result.successItems) && result.successItems.length > 0 &&
    result.successItems.every(item => item && item.status === 'pass') &&
    Array.isArray(result.commands) &&
    result.commands.some(command => command && Number(command.exitCode) === 0))
}

async function emitItemVerifiedTransition(transition, item) {
  if (typeof transition !== 'function' || !item || typeof item.workItemId !== 'string' || !item.workItemId ||
      !/^[a-f0-9]{64}$/.test(item.resultHash || '') || !/^[a-f0-9]{64}$/.test(item.candidateHash || '') ||
      !Array.isArray(item.nextReadyWorkIds)) {
    throw new SupervisorIntegrationError('ITEM_VERIFIED_INVALID', 'item verification requires its exact result, version, and remaining ready work')
  }
  await transition('WORK_ITEM_VERIFIED', 'ITEM_VERIFIED', {
    workItemId: item.workItemId,
    resultHash: item.resultHash,
    candidateHash: item.candidateHash,
    nextReadyWorkIds: item.nextReadyWorkIds.length > 0
      ? [...item.nextReadyWorkIds] : ['independent-check-1'],
  })
  if (item.nextReadyWorkIds.length > 0) {
    await transition('MORE_WORK_READY', 'RUN_WORK', {
      completedWorkItemId: item.workItemId,
      nextReadyWorkIds: [...item.nextReadyWorkIds],
    })
  }
}

function canonicalRoleAssignment(input) {
  const checklist = Array.isArray(input.request.successChecklist || input.request.success)
    ? (input.request.successChecklist || input.request.success) : ['Complete the exact assigned result.']
  const planPath = input.route === 'ROADMAP' ? 'plan/ROADMAP.md'
    : input.route === 'LIGHT' ? 'plan/light-plan.md' : 'plan/success-card.md'
  const assignmentCore = {
    requestedResult: String(input.request.assignment || 'Complete the assigned work item.'),
    resources: canonicalAssignmentResources(input),
    successChecklist: checklist.map((description, index) => ({ id: `success-${index + 1}`, description: String(description) })),
    checks: (input.request.checks || ['Verify the exact assigned result.']).map(String),
  }
  const sectionHash = input.route === 'ROADMAP' && input.request.roadmapSlice &&
      /^[a-f0-9]{64}$/.test(input.request.roadmapSlice.sha256 || '')
    ? input.request.roadmapSlice.sha256
    : hashText(JSON.stringify(assignmentCore))
  const assignment = {
    schemaVersion: '2.0.0',
    reportType: 'assignment',
    reportId: `assignment:${input.request.workItemId}`,
    runId: input.runId,
    assignmentId: input.request.workItemId,
    logicalRoleId: input.logicalRole,
    physicalRoleId: input.physicalRole,
    requestEnvelopeHash: input.requestEnvelopeHash,
    findingIds: exactFindingIds(input.request.findingIds, input.request.finding_ids,
      input.request.assignment, input.request.successChecklist, input.request.success,
      input.request.checks, input.mission),
    requestedResult: assignmentCore.requestedResult,
    planReference: {
      planPath, sectionId: input.request.workItemId, sectionHash,
      workItemId: input.request.workItemId, workItemHash: hashText(JSON.stringify(input.request)),
    },
    resources: assignmentCore.resources,
    allowedReads: ['request-envelope', planPath, ...assignmentCore.resources.map(resource => resource.identity)],
    forbiddenChanges: ['Do not modify resources outside this assignment.', 'Do not perform network writes.'],
    successChecklist: assignmentCore.successChecklist,
    checks: assignmentCore.checks,
    resultLocation: `work/results/${hashText(input.request.workItemId)}.json`,
    assignedAt: new Date(input.now()).toISOString(),
  }
  if (assignment.findingIds.length === 0) {
    // The durable assignment contract itself is the exact finding enforced
    // when the request has no external AP finding identifier.
    assignment.findingIds = ['AP-DESIGN-023']
  }
  if (input.logicalRole === 'ap-work-group-manager') {
    const admission = input.request.workGroupAdmission
    if (!admission || admission.route !== 'ROADMAP' || admission.parentRoleId !== 'mission-coordinator' ||
        admission.managerRoleId !== 'ap-work-group-manager' || admission.usefulWorkerCount < 2 ||
        admission.disjointMutableResourceOwnershipRequired !== true ||
        !Array.isArray(admission.workerAssignments) ||
        admission.workerAssignments.length !== admission.usefulWorkerCount) {
      throw new SupervisorIntegrationError('WORK_GROUP_ADMISSION_INVALID', 'manager assignment lacks canonical ROADMAP work-group admission')
    }
    assignment.workGroupAdmission = admission
  }
  return Object.freeze(assignment)
}

function roadmapAuthorArtifact(result, scoutCorrections = []) {
  const steps = result && Array.isArray(result.behaviorChanged)
    ? result.behaviorChanged.map(item => String(item).trim()).filter(Boolean) : []
  if (steps.length === 0) {
    throw new SupervisorIntegrationError(
      'ROADMAP_AUTHOR_RESULT_INVALID',
      'the L3 roadmap author must return concrete dependency-ordered steps in behaviorChanged',
    )
  }
  const correctionIds = scoutCorrections.map(item => item && item.workItemId)
  const correctionTexts = scoutCorrections.map(item => item && item.correction)
  if (!uniqueStrings(correctionIds) || !uniqueStrings(correctionTexts)) {
    throw new SupervisorIntegrationError(
      'SCOUT_CORRECTION_DUPLICATE',
      'each named scout must contribute one distinct accepted correction exactly once',
    )
  }
  const missingCorrections = scoutCorrections.filter(item =>
    steps.filter(step => step === item.correction).length !== 1)
  if (missingCorrections.length > 0) {
    throw new SupervisorIntegrationError(
      'SCOUT_CORRECTION_NOT_MERGED',
      'the same-author revision must contain every concrete scout correction verbatim exactly once',
      { missingCorrections: missingCorrections.map(item => item.workItemId) },
    )
  }
  return Object.freeze({
    ...result,
    behaviorChanged: Object.freeze(steps),
    scoutCorrections: Object.freeze(scoutCorrections.map(item => Object.freeze({ ...item }))),
  })
}

function immutableSemanticUserAskCount(requestScope) {
  if (!requestScope || !/^[a-f0-9]{64}$/.test(requestScope.digest || '') ||
      !Array.isArray(requestScope.records) || requestScope.records.length === 0) {
    throw new SupervisorIntegrationError(
      'ROADMAP_ASK_RATIO_INVALID',
      'the immutable request envelope does not contain a semantic user request',
    )
  }
  const activeAsks = new Set()
  for (const entry of requestScope.records) {
    if (entry.entryType === 'user-message') {
      const id = entry.messageId || entry.entryHash
      if (typeof id !== 'string' || !id) {
        throw new SupervisorIntegrationError('ROADMAP_ASK_RATIO_INVALID', 'a user request lacks its immutable identity')
      }
      activeAsks.add(id)
      continue
    }
    if (entry.entryType !== 'steering-edge') continue
    const operation = String(entry.operation || '').toUpperCase()
    const targets = Array.isArray(entry.targetMessageIds) ? entry.targetMessageIds : []
    if (!['ADD', 'REPLACE', 'DELETE'].includes(operation) ||
        (operation !== 'ADD' && (targets.length === 0 || targets.some(id => !activeAsks.has(id))))) {
      throw new SupervisorIntegrationError(
        'ROADMAP_ASK_RATIO_INVALID',
        'request steering cannot determine the active semantic user asks from the immutable envelope',
      )
    }
    for (const id of targets) activeAsks.delete(id)
    if (operation !== 'DELETE') {
      const id = entry.steeringId || entry.entryHash
      if (typeof id !== 'string' || !id) {
        throw new SupervisorIntegrationError('ROADMAP_ASK_RATIO_INVALID', 'request steering lacks its immutable identity')
      }
      activeAsks.add(id)
    }
  }
  if (activeAsks.size === 0) {
    throw new SupervisorIntegrationError('ROADMAP_ASK_RATIO_INVALID', 'request steering removed every semantic user ask')
  }
  return activeAsks.size
}

function scoutCorrection(result, namedUnknown, workItemId, pointer) {
  const corrections = result && Array.isArray(result.behaviorChanged)
    ? result.behaviorChanged.map(item => String(item).trim()).filter(Boolean) : []
  if (corrections.length === 0 || !pointer || !/^[a-f0-9]{64}$/.test(pointer.hash || '')) {
    throw new SupervisorIntegrationError(
      'SCOUT_CORRECTION_INVALID',
      `named scout ${workItemId} returned no concrete durable correction`,
    )
  }
  return Object.freeze({
    workItemId,
    namedUnknown,
    correction: corrections.join(' '),
    evidenceHash: pointer.hash,
  })
}

function markdownDecisionText(value, fallback = 'None recorded.') {
  if (value === null || value === undefined || String(value).trim() === '') return fallback
  return String(value)
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/([\\`*_[\]<>#])/gu, '\\$1')
}

function markdownDecisionList(values) {
  if (!Array.isArray(values) || values.length === 0) return ['- None recorded.']
  return values.map(value => `- ${markdownDecisionText(value)}`)
}

function renderRouteDecisionMarkdown(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new SupervisorIntegrationError('ROUTE_DECISION_INVALID', 'route decision markdown requires the canonical decision object')
  }
  const checking = decision.independentCheckingPlan || {}
  const disagreement = decision.analystDisagreement
  const rejected = Object.entries(decision.rejectedRouteReasons || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([route, reason]) => `- ${markdownDecisionText(route)}: ${markdownDecisionText(reason)}`)
  const lines = [
    '# Route Decision',
    '',
    '## 1. Chosen Route',
    '',
    `- Route: ${markdownDecisionText(decision.route)}`,
    `- Source: ${markdownDecisionText(decision.routeSource)}`,
    `- Decided at: ${markdownDecisionText(decision.decidedAt)}`,
    '',
    '## 2. Requested Result',
    '',
    markdownDecisionText(decision.requestedResult),
    '',
    '## 3. Success Checklist',
    '',
    ...markdownDecisionList(decision.successChecklist),
    '',
    '## 4. Planned Checks',
    '',
    ...markdownDecisionList(decision.plannedChecks),
    '',
    '## 5. Likely Files or System Areas',
    '',
    ...markdownDecisionList(decision.likelyAreas),
    '',
    '## 6. Risks and Missing Information',
    '',
    '### Risks',
    '',
    ...markdownDecisionList(decision.risks),
    '',
    '### Missing Information',
    '',
    ...markdownDecisionList(decision.missingInformation),
    '',
    '## 7. Useful Workers and Ownership',
    '',
    `- Useful workers: ${markdownDecisionText(decision.usefulWorkerCount)}`,
    `- Non-overlap reason: ${markdownDecisionText(decision.workerOwnershipReason)}`,
    '',
    '## 8. Independent Review and Testing',
    '',
    `- Checker count: ${markdownDecisionText(checking.checkerCount)}`,
    ...markdownDecisionList(checking.responsibilities),
    `- Non-overlap reason: ${markdownDecisionText(checking.nonOverlapReason)}`,
    '',
    '## 9. Why This Route Fits',
    '',
    markdownDecisionText(decision.chosenRouteReason),
    '',
    '## 10. Why Other Routes Were Rejected',
    '',
    ...(rejected.length > 0 ? rejected : ['- None recorded.']),
    '',
    '## 11. Route Analyst Disagreement',
    '',
    ...(disagreement
      ? [
          `- Analyst recommendation: ${markdownDecisionText(disagreement.recommendation)}`,
          `- Concrete reason: ${markdownDecisionText(disagreement.concreteReason)}`,
        ]
      : ['No disagreement recorded.']),
    '',
    '## 12. Route Change Trigger',
    '',
    `- Event: ${markdownDecisionText(decision.routeChangeTrigger && decision.routeChangeTrigger.event)}`,
    `- Fact required: ${markdownDecisionText(decision.routeChangeTrigger && decision.routeChangeTrigger.factRequired)}`,
    '',
  ]
  return `${lines.join('\n')}\n`
}

function writeRouteDecisionArtifacts(record, decision) {
  if (!record || typeof record.write !== 'function') {
    throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'route decision write requires the opened run record')
  }
  record.write('route/decision.json', `${JSON.stringify(decision, null, 2)}\n`)
  record.write('route/decision.md', renderRouteDecisionMarkdown(decision))
}

function renderPlanArtifact(route, decision, authorResult = null) {
  const checking = validateLiveCheckingPlan(decision)
  const lines = [
    `# ${route === 'ROADMAP' ? 'ROADMAP' : route === 'LIGHT' ? 'Light Plan' : 'Success Card'}`,
    '',
    `Requested result: ${decision.requestedResult}`,
    '',
    '## Success',
    ...(decision.successChecklist || []).map(item => `- ${item}`),
    '',
    '## Checks',
    ...(decision.plannedChecks || []).map(item => `- ${item}`),
    '',
    '## Ownership',
    ...(decision.mutableResourceOwnership || []).map(item =>
      `- ${item.owner}: ${item.kind}:${item.identity} (${item.ownershipMode})`),
    '',
    '## Risks to falsify',
    ...markdownDecisionList(decision.risks),
    '',
    '## Information to resolve before editing',
    ...markdownDecisionList(decision.missingInformation),
    '',
    'For every item above, derive an observable positive, negative, and boundary witness from the request or an independent source. Do not validate the implementation with a second copy of its own assumptions.',
    '',
    '## Independent verification',
    ...checking.responsibilities.map((item, index) => `- Seat ${index + 1}: ${item}`),
    `- Separation: ${checking.nonOverlapReason || 'One independently derived method is sufficient for the recorded ordinary risk.'}`,
  ]
  if (route === 'LIGHT') lines.push('', '## Short order', `- ${decision.chosenRouteReason}`)
  if (route === 'ROADMAP') {
    if (authorResult) {
      const artifact = roadmapAuthorArtifact(authorResult, authorResult.scoutCorrections || [])
      lines.push('', '## Dependency-ordered author plan',
        ...artifact.behaviorChanged.map((item, index) => `${index + 1}. ${item}`),
        '', '## Author acceptance',
        `- Report: ${authorResult.reportId || 'roadmap-author'}`,
        ...((authorResult.successItems || []).map(item =>
          `- ${typeof item === 'string' ? item : JSON.stringify(item)}`)))
      if (artifact.scoutCorrections.length > 0) {
        lines.push('', '## Scout corrections merged', ...artifact.scoutCorrections.map(item =>
          `- ${item.workItemId} [${item.evidenceHash}] ${item.namedUnknown}: ${item.correction}`))
      }
    }
  }
  return `${lines.join('\n')}\n`
}

function readOnlyRequestedEffect(decision) {
  const effect = decision && decision.normalizedRouteFacts && decision.normalizedRouteFacts.requestedEffect
  return ['inspect', 'report', 'research', 'decide'].includes(effect)
}

function deterministicChecksForDecision(decision, route) {
  const recipe = selectWorkRecipe({
    ...(decision.gateSelection || {}),
    route,
    checks: [],
    runtimeSignals: decision.runtimeSignals || {},
    overlaySteps: decision.overlaySteps || decision.overlayExecution || [],
  })
  if (recipe.status !== 'SUPPORTED') return []
  return [...new Set([
    ...recipe.checks, ...recipe.riskChecks, ...(decision.plannedChecks || []),
  ])]
}

function createReadOnlyFinalResponse(decision, workResults) {
  const results = workResults.map(({ workItemId, result }) => {
    const validSuccessItems = Array.isArray(result && result.successItems) && result.successItems.length > 0 &&
      result.successItems.every(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id &&
        item.status === 'pass' && Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0 &&
        item.evidenceIds.every(evidenceId => typeof evidenceId === 'string' && evidenceId.trim()))
    const validNarrative = Array.isArray(result && result.behaviorChanged) && result.behaviorChanged.length > 0 &&
      result.behaviorChanged.every(item => typeof item === 'string' && item.trim())
    if (!result || result.schemaVersion !== '2.0.0' || result.reportType !== 'result' ||
        result.allAssignedItemsPass !== true || !Array.isArray(result.filesChanged) ||
        result.filesChanged.length !== 0 || !validSuccessItems || !validNarrative ||
        !Array.isArray(result.remainingConcerns)) {
      throw new SupervisorIntegrationError(
        'READ_ONLY_RESULT_INVALID',
        `read-only work item ${workItemId} lacks a validated structured final response`,
      )
    }
    return Object.freeze({
      workItemId,
      reportId: result.reportId,
      successItems: structuredClone(result.successItems),
      findings: result.behaviorChanged.slice(),
      remainingConcerns: result.remainingConcerns.slice(),
      resultHash: hashText(stableStringify(result)),
    })
  })
  const body = {
    schemaVersion: 1,
    resultFormat: decision.gateSelection.resultFormat,
    requestedResult: decision.requestedResult,
    results,
  }
  return Object.freeze({ ...body, responseHash: hashText(stableStringify(body)) })
}

function validReadOnlyFinalResponse(response) {
  if (!response || typeof response !== 'object' ||
      !['read-only-findings', 'decision-record'].includes(response.resultFormat) ||
      typeof response.requestedResult !== 'string' || !response.requestedResult ||
      !Array.isArray(response.results) || response.results.length === 0 ||
      response.results.some(result => !result || typeof result.workItemId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.resultHash || '') || !Array.isArray(result.successItems) ||
        result.successItems.length === 0 || !Array.isArray(result.findings) || result.findings.length === 0)) return false
  const { responseHash, ...body } = response
  return /^[a-f0-9]{64}$/.test(responseHash || '') && responseHash === hashText(stableStringify(body))
}

function validateDurableResultEvidencePointer(pointer, expectedName) {
  try {
    if (!pointer || pointer.name !== expectedName || typeof pointer.path !== 'string' || !pointer.path ||
        !/^[a-f0-9]{64}$/.test(pointer.hash || '') ||
        !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 1) {
      throw new Error('resolved pointer is malformed')
    }
    const pointerPath = path.resolve(pointer.path)
    const stat = fs.lstatSync(pointerPath)
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1 || stat.size !== pointer.bytes) {
      throw new Error('resolved pointer is not one exact regular result file')
    }
    if (sha256Bytes(fs.readFileSync(pointerPath)) !== pointer.hash) {
      throw new Error('resolved pointer hash does not match its durable result')
    }
    return Object.freeze({ ...pointer, path: pointerPath })
  } catch (error) {
    throw new SupervisorIntegrationError(
      'PLAN_CHECK_EVIDENCE_MISSING',
      'ROADMAP plan repair requires the durable exact plan-check result pointer',
      { cause: error && (error.code || error.message) || 'unknown' },
    )
  }
}

function executionMutableResourceOwnership(decision, route, workerCount) {
  const ownership = Array.isArray(decision && decision.mutableResourceOwnership)
    ? decision.mutableResourceOwnership : []
  const canonicalOwners = new Set(ownership.flatMap(item => {
    const match = item && /^worker-(\d+)$/u.exec(String(item.owner || ''))
    return match && Number(match[1]) <= workerCount ? [String(item.owner)] : []
  }))
  const freeOwners = Array.from({ length: workerCount }, (_, index) => `worker-${index + 1}`)
    .filter(owner => !canonicalOwners.has(owner))
  const semanticOwners = route === 'ROADMAP' ? [...new Set(ownership.flatMap(item => {
    const owner = String(item && item.owner || '')
    return owner && /worker/iu.test(owner) && !/^worker-\d+$/u.test(owner) ? [owner] : []
  }))] : []
  const semanticOwnerMap = new Map(semanticOwners.slice(0, freeOwners.length)
    .map((owner, index) => [owner, freeOwners[index]]))
  return ownership.map(item => {
    // The route decision describes logical ownership and may use a semantic
    // single-worker label (for example `geometry-worker`). Execution uses
    // canonical scheduler work-item identities. Once topology has selected
    // exactly one worker there is no ownership ambiguity, so bind every
    // mutable resource to that concrete worker before authorization. Keep
    // multi-worker labels untouched: those must already be explicit
    // `worker-N` assignments so disjoint ownership can be proven.
    if (item && workerCount === 1 && ['DIRECT', 'LIGHT', 'ROADMAP'].includes(route)) {
      return Object.freeze({ ...item, owner: 'worker-1' })
    }
    if (item && semanticOwnerMap.has(String(item.owner || ''))) {
      return Object.freeze({ ...item, owner: semanticOwnerMap.get(String(item.owner)) })
    }
    return item
  })
}

function decisionReadOnlyOwnership(decision, targetPath) {
  // Some control-plane admission tests intentionally construct the executor
  // before a physical target is bound.  Descriptive route hints cannot become
  // authority in that state, so retain the explicit workspace sentinel.
  if (typeof targetPath !== 'string' || !targetPath.trim()) return ['workspace']
  const targetRoot = path.resolve(targetPath)
  const typed = Array.isArray(decision && decision.mutableResourceOwnership)
    ? decision.mutableResourceOwnership : []
  const candidates = typed.filter(resource => {
    if (!resource || !['file', 'directory', 'evidence-root'].includes(String(resource.kind || '').toLowerCase())) return false
    const absolute = resolveOwnedResourcePath(targetRoot, resource)
    if (!absolute || !fs.existsSync(absolute)) return false
    const stat = fs.lstatSync(absolute)
    return !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory())
  }).map(resource => ({ ...resource }))
  const exactLikelyAreaTokens = (Array.isArray(decision && decision.likelyAreas) ? decision.likelyAreas : [])
    .flatMap(value => typeof value === 'string' ? value.split(/[;,]/u) : [])
    .map(value => value.trim()).filter(Boolean)
  for (const likelyArea of exactLikelyAreaTokens) {
    if (!(path.isAbsolute(likelyArea) || /^\.{1,2}[\\/]/u.test(likelyArea)) || /\s/u.test(likelyArea)) continue
    let normalizedArea = likelyArea.replace(/\\/g, '/')
    if (/[*?[]/u.test(normalizedArea)) {
      const wildcardIndex = normalizedArea.search(/[*?[]/u)
      const slashIndex = normalizedArea.lastIndexOf('/', wildcardIndex)
      if (slashIndex < 1) continue
      normalizedArea = normalizedArea.slice(0, slashIndex)
    }
    const absolute = path.isAbsolute(normalizedArea)
      ? path.resolve(normalizedArea)
      : path.resolve(targetRoot, ...normalizedArea.split('/'))
    if (absolute !== targetRoot && !absolute.startsWith(`${targetRoot}${path.sep}`)) continue
    if (!fs.existsSync(absolute)) continue
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue
    if (candidates.some(resource => resolveOwnedResourcePath(targetRoot, resource) === absolute)) continue
    candidates.push({
      kind: stat.isDirectory() ? 'directory' : 'file',
      identity: normalizedArea,
      owner: 'read-only-planning',
      ownershipMode: 'single-owner',
    })
  }
  return candidates.length ? candidates : ['workspace']
}

function createDefaultRouteExecutor(options) {
  return async ({
    route,
    decision,
    launch,
    completeRetainedLease,
    resumeAdoptedLaunches,
    acceptDeferredCheckerProof,
    resumeState,
  }) => {
    if (typeof options.verifyL1RequestPointer === 'function') options.verifyL1RequestPointer()
    const roadmapPlanningStartedAt = route === 'ROADMAP' && typeof options.monotonicNow === 'function'
      ? options.monotonicNow() : null
    if (!decision.gateSelection || typeof decision.gateSelection !== 'object') {
      throw new SupervisorIntegrationError(
        'GATE_SELECTION_REQUIRED',
        'production execution requires the canonical L0 required-check selection compiled from gates.json',
      )
    }
    let recipe = selectWorkRecipe({
      ...decision.gateSelection,
      route,
      checks: [],
      runtimeSignals: decision.runtimeSignals || {},
      overlaySteps: decision.overlaySteps || decision.overlayExecution || [],
    })
    if (recipe.status !== 'SUPPORTED' || !recipe.gateGraph) {
      if (typeof options.frameworkAuthorityFactory !== 'function') {
        throw new SupervisorIntegrationError(
          'GATE_SELECTION_INVALID',
          'the canonical L0 required-check selection is incompatible and no C0 framework authority is configured',
          { recipe },
        )
      }
      const missIdentity = createFrameworkMissCacheIdentity({
        axes: {
          deliverableKind: decision.gateSelection.resultFormat,
          targetLocus: [...(decision.gateSelection.artifactOverlays || [])].sort().join('+'),
        },
        acceptanceOverlays: decision.gateSelection.acceptanceOverlays,
        riskOverlays: decision.gateSelection.riskOverlays || [],
      })
      const requirementHash = missIdentity.cacheKey
      const authority = options.frameworkAuthorityFactory({
        route,
        decision,
        unsupportedRecipe: recipe,
        requirementHash,
        missIdentity,
      })
      if (!authority || typeof authority.run !== 'function') {
        throw new SupervisorIntegrationError(
          'FRAMEWORK_AUTHORITY_INVALID',
          'the C0 framework authority factory returned no executable bounded authority',
        )
      }
      const admission = await authority.run({ caller: 'deterministic-control-plane' })
      if (!admission || admission.status !== 'ADMITTED' ||
          !admission.recipe || admission.recipe.runtimeFrameworkGeneration !== true ||
          !/^[a-f0-9]{64}$/.test(admission.recipe.frameworkAdmissionHash || '')) {
        throw new SupervisorIntegrationError(
          'FRAMEWORK_ADMISSION_INVALID',
          'workers cannot start before the generated framework has an exact independent PASS admission',
        )
      }
      recipe = admission.recipe
    }
    const successes = decision.successChecklist || []
    const checks = deterministicChecksForDecision(decision, route)
    const likelyAreas = decision.likelyAreas || []
    const workerCount = Math.max(1, Number(decision.usefulWorkerCount || 1))
    const initialWorkFrontier = route === 'ROADMAP'
      ? ['roadmap-author']
      : Array.from({ length: workerCount }, (_, index) => `work-${index + 1}`)
    const executionOwnership = executionMutableResourceOwnership(decision, route, workerCount)
    const launchChecker = async request => {
      try {
        return await launch(request)
      } catch (error) {
        if (!CHECKER_LAUNCH_REASSESSMENT_CODES.has(error && error.code)) throw error
        return checkerLaunchRuntimeFailure(request, decision, options.runId, error)
      }
    }
    // likelyAreas is descriptive routing prose, not resource authority. Only
    // the typed mutable ownership contract may become a child filesystem
    // identity; absent that contract, use the explicit workspace sentinel.
    const admittedReadOwnership = decisionReadOnlyOwnership(decision, options.targetPath)
    const withDescriptiveLikelyAreas = evidence => {
      const base = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {}
      return likelyAreas.length ? { ...base, descriptiveLikelyAreas: [...likelyAreas] }
        : Object.keys(base).length ? base : null
    }
    const durableCompletedGateResult = workItemId => {
      const completed = new Set([
        ...(resumeState && resumeState.completedWorkIds || []),
        ...(resumeState && resumeState.completedCheckIds || []),
      ])
      if (!completed.has(workItemId)) return null
      if (typeof options.readResult !== 'function' || typeof options.resultPointer !== 'function' ||
          typeof options.verifyDurableResultReceipt !== 'function') {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `completed pre-production required check ${workItemId} lacks exact durable result authentication`,
        )
      }
      const indexedResult = options.readResult(workItemId)
      const pointer = validateDurableResultEvidencePointer(options.resultPointer(workItemId), workItemId)
      const receiptResult = readRegularJson(pointer.path, `completed ${workItemId} result`).parsed
      if (!indexedResult || indexedResult.code !== 'PASS' ||
          stableStringify(indexedResult) !== stableStringify(receiptResult)) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `completed pre-production required check ${workItemId} differs from its exact PASS receipt bytes`,
        )
      }
      options.verifyDurableResultReceipt(workItemId, indexedResult)
      return indexedResult
    }
    const capturedDomainContracts = Array.isArray(decision.capturedDomainContracts)
      ? decision.capturedDomainContracts : []
    const capturedDomainAdmission = validateCapturedDomainContracts(
      capturedDomainContracts,
      decision.normalizedRouteFacts || {},
    )
    if (!capturedDomainAdmission.valid) {
      const retryTransitionInvalid = capturedDomainAdmission.errors.some(error =>
        /NEW_SOURCE_DATA|UNCHANGED_CERTIFICATE/u.test(error))
      throw new SupervisorIntegrationError(
        retryTransitionInvalid ? 'CAPTURED_DOMAIN_RETRY_INVALID' : 'CAPTURED_DOMAIN_ADMISSION_REQUIRED',
        'every applicable captured incident domain requires an exact contract before any role launch',
        { errors: capturedDomainAdmission.errors },
      )
    }
    const admissionBody = {
      schemaVersion: 1,
      route,
      requestEnvelopeHash: decision.requestEnvelopeHash,
      admittedBeforeWork: true,
      contracts: capturedDomainAdmission.contracts,
    }
    const capturedDomainPreWork = capturedDomainAdmission.contracts.length > 0
      ? Object.freeze({
          ...admissionBody,
          admissionHash: hashText(JSON.stringify(admissionBody)),
        })
      : null
    if (capturedDomainPreWork) {
      if (typeof options.writeCapturedDomainAdmission !== 'function') {
        throw new SupervisorIntegrationError(
          'CAPTURED_DOMAIN_ADMISSION_REQUIRED',
          'captured-domain admission must be durable before any role launch',
        )
      }
      options.writeCapturedDomainAdmission(capturedDomainPreWork)
    }
    const hiddenExternalBoundary = capturedDomainContracts.find(contract =>
      contract.kind === 'HIDDEN_EXTERNAL_ORACLE')
    const doneRetryBoundary = capturedDomainContracts.find(contract =>
      contract.kind === 'DONE_RETRY_PROMOTION')
    const fixtureProvenanceBoundary = capturedDomainContracts.find(contract =>
      contract.kind === 'FIXTURE_PROVENANCE')
    if (doneRetryBoundary && workerCount !== 1) {
      throw new SupervisorIntegrationError(
        'DONE_RETRY_ISOLATION_REQUIRED',
        'a DONE retry is one isolated version/worktree and cannot be split across promoted workers',
      )
    }
    if (hiddenExternalBoundary && workerCount > hiddenExternalBoundary.maxProvisionalWorkerLaunches) {
      throw new SupervisorIntegrationError(
        'PROVISIONAL_WORK_CAP_EXCEEDED',
        'hidden external verification permits only one bounded provisional worker',
      )
    }
    let fixturePrebuildOutcome = null
    let fixturePrebuildEvidence = null
    if (fixtureProvenanceBoundary) {
      const prebuildCandidateHash = hashWorkspaceCandidate(options.targetPath, options.gitEnvironment())
      const oracle = 'fixture-provenance-prebuild-validation'
      const validationResult = durableCompletedGateResult('fixture-prebuild-validation') || await launch({
        workItemId: 'fixture-prebuild-validation', logicalRole: 'independent-tester', parent: 'run-owner',
        purpose: 'verification',
        assignment: 'Execute the authoritative fixture-provenance and mutation-replay validation. Return its bound FIXTURE_PROVENANCE outcome; do not build or write the target.',
        candidateHash: prebuildCandidateHash, oracle,
        ownership: admittedReadOwnership,
        success: ['Executable fixture provenance and mutation replay remain RED until the pre-build validation passes.'],
        checks: ['Read and execute the declared pre-build validation only; do not edit the target.'],
        isolation: 'snapshot', writeProducing: false,
        manifests: executionOwnership, bounded: true,
        fetchedEvidence: withDescriptiveLikelyAreas({ capturedDomainAdmission: capturedDomainPreWork }),
        harnessAttestation: options.harnessAttestation(prebuildCandidateHash, oracle),
        nextReadyAfter: initialWorkFrontier,
      })
      const candidateOutcomes = validationResult && validationResult.payload &&
        Array.isArray(validationResult.payload.capturedDomainOutcomes)
        ? validationResult.payload.capturedDomainOutcomes : []
      fixturePrebuildOutcome = candidateOutcomes.find(outcome =>
        outcome && outcome.kind === 'FIXTURE_PROVENANCE') || null
      const validation = evaluateCapturedDomainOutcomes(
        [fixtureProvenanceBoundary],
        fixturePrebuildOutcome ? [fixturePrebuildOutcome] : [],
      )
      if (!validationResult || validationResult.code !== 'PASS' || !validation.valid) {
        throw new SupervisorIntegrationError(
          'CAPTURED_DOMAIN_PREBUILD_VALIDATION_REQUIRED',
          'an executable, contract-bound fixture validation must PASS before any build or write launch',
          { errors: validation.errors },
        )
      }
      fixturePrebuildEvidence = Object.freeze({
        workItemId: 'fixture-prebuild-validation',
        validationHash: fixtureProvenanceBoundary.executablePrebuildValidationHash,
        outcomeHash: validation.results[0].outcomeHash,
        executionResultHash: hashText(JSON.stringify(validationResult)),
      })
    }
    const capturedDomainWorkEvidence = capturedDomainPreWork
      ? Object.freeze({
          capturedDomainAdmission: capturedDomainPreWork,
          ...(fixturePrebuildEvidence ? { fixturePrebuildValidation: fixturePrebuildEvidence } : {}),
        })
      : null
    let depthGateOutcome = await executePreProductionRuntimeGates({
      recipe, launch, ownership: admittedReadOwnership,
      fetchedEvidence: withDescriptiveLikelyAreas(null),
      durableResult: recipe.runtimeGatePlan && recipe.runtimeGatePlan.triggers &&
          recipe.runtimeGatePlan.triggers.depthProber &&
          recipe.runtimeGatePlan.triggers.depthProber.required === true
        ? durableCompletedGateResult('conditional-depth-prober') : null,
      nextReadyAfter: initialWorkFrontier,
    })
    const recoverDurablePlanningFrontier = () => {
      if (route !== 'ROADMAP' || !resumeState ||
          !['RUN_WORK', 'CHECK_INCONCLUSIVE'].includes(resumeState.resumeState)) return null
      const nextReady = Array.isArray(resumeState.nextReadyWorkIds)
        ? resumeState.nextReadyWorkIds : []
      const pendingRetry = resumeState.resumeState === 'CHECK_INCONCLUSIVE' &&
        resumeState.retryState && resumeState.retryState.inconclusiveChecker
      if (pendingRetry) {
        if (!/^roadmap-plan-(?:check|recheck)$/u.test(pendingRetry.checkerId || '') ||
            pendingRetry.retryAttempt !== 1 || pendingRetry.returnState !== 'RUN_WORK' ||
            (resumeState.planHash && pendingRetry.candidateHash !== resumeState.planHash) ||
            !/^[a-f0-9]{64}$/u.test(pendingRetry.checkerResultHash || '')) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            'durable ROADMAP retry marker does not bind one exact physical retry and plan version',
          )
        }
        const resultId = `${pendingRetry.checkerId}-runtime-retry`
        const indexedResult = typeof options.readResult === 'function'
          ? options.readResult(resultId) : null
        const adoptedRetryRecords = Array.isArray(resumeState.adoptedRecords)
          ? resumeState.adoptedRecords.filter(record => record && record.workItemId === resultId)
          : []
        const adoptedRetry = stableStringify(nextReady) ===
            stableStringify([`reconcile:${resultId}`]) &&
          resumeState.schedulerCrashCheckpoint && adoptedRetryRecords.length === 1 &&
          Array.isArray(resumeState.openLeaseIds) &&
          resumeState.openLeaseIds.includes(adoptedRetryRecords[0].id)
        if (!indexedResult) {
          const baseResult = typeof options.readResult === 'function'
            ? options.readResult(pendingRetry.checkerId) : null
          const queuedRetry = stableStringify(nextReady) === stableStringify([resultId])
          if (!baseResult || typeof options.resultPointer !== 'function' ||
              hashText(JSON.stringify(baseResult)) !== pendingRetry.checkerResultHash ||
              !['CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE'].includes(baseResult.code) ||
              (!queuedRetry && !adoptedRetry)) {
            throw new SupervisorIntegrationError(
              'CHECK_RETRY_STATE_INVALID',
              `durable ${pendingRetry.checkerId} retry marker lacks its exact base result and queued or live-adopted physical retry`,
            )
          }
          const basePointer = validateDurableResultEvidencePointer(
            options.resultPointer(pendingRetry.checkerId), pendingRetry.checkerId,
          )
          const baseBytes = readRegularJson(
            basePointer.path, `durable ${pendingRetry.checkerId} retry base result`,
          ).parsed
          if (stableStringify(baseResult) !== stableStringify(baseBytes) ||
              (baseResult.candidateHash && baseResult.candidateHash !== pendingRetry.candidateHash)) {
            throw new SupervisorIntegrationError(
              'CHECK_RETRY_STATE_INVALID',
              `durable ${pendingRetry.checkerId} retry base differs from its exact receipt bytes or plan version`,
            )
          }
          if (typeof options.verifyDurableResultReceipt !== 'function') {
            throw new SupervisorIntegrationError(
              'CHECK_RETRY_STATE_INVALID',
              `durable ${pendingRetry.checkerId} retry requires its authenticated base receipt`,
            )
          }
          options.verifyDurableResultReceipt(pendingRetry.checkerId, baseResult)
          return Object.freeze({
            kind: 'retry', frontierId: resultId, resultId: pendingRetry.checkerId,
            result: baseResult, pointer: basePointer,
            checkerResultHash: pendingRetry.checkerResultHash,
          })
        }
        if (typeof options.resultPointer !== 'function') {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${resultId} recovery lacks its exact result pointer resolver`,
          )
        }
        const baseResult = options.readResult(pendingRetry.checkerId)
        if (!baseResult ||
            hashText(JSON.stringify(baseResult)) !== pendingRetry.checkerResultHash ||
            !['CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE'].includes(baseResult.code)) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${resultId} result lacks its exact marker-bound non-authoritative base result`,
          )
        }
        const basePointer = validateDurableResultEvidencePointer(
          options.resultPointer(pendingRetry.checkerId), pendingRetry.checkerId,
        )
        const baseReceiptResult = readRegularJson(
          basePointer.path, `durable ${pendingRetry.checkerId} retry base result`,
        ).parsed
        if (stableStringify(baseResult) !== stableStringify(baseReceiptResult) ||
            (baseResult.candidateHash && baseResult.candidateHash !== pendingRetry.candidateHash)) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${pendingRetry.checkerId} retry base differs from its exact plan or receipt bytes`,
          )
        }
        if (typeof options.verifyDurableResultReceipt !== 'function') {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${pendingRetry.checkerId} retry base requires its authenticated terminal receipt`,
          )
        }
        options.verifyDurableResultReceipt(pendingRetry.checkerId, baseResult)
        const pointer = validateDurableResultEvidencePointer(options.resultPointer(resultId), resultId)
        const result = readRegularJson(pointer.path, `durable ${resultId} recovery result`).parsed
        if (stableStringify(indexedResult) !== stableStringify(result) ||
            (result.candidateHash && result.candidateHash !== pendingRetry.candidateHash)) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${resultId} result differs from its exact plan version or receipt bytes`,
          )
        }
        if (adoptedRetry) {
          return Object.freeze({
            kind: 'retry', frontierId: resultId, resultId: pendingRetry.checkerId,
            result: baseResult, pointer: basePointer,
            checkerResultHash: pendingRetry.checkerResultHash,
            orphanCanonicalResult: Object.freeze({ resultId, result, pointer }),
          })
        }
        if (typeof options.verifyDurableResultReceipt !== 'function') {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${resultId} recovery requires its authenticated terminal receipt`,
          )
        }
        options.verifyDurableResultReceipt(resultId, result)
        const expectedNext = result.code === 'PASS'
          ? ['mission-coordination']
          : result.code === 'FAIL' && pendingRetry.checkerId === 'roadmap-plan-check'
            ? ['roadmap-author-plan-repair'] : []
        if (stableStringify(nextReady) !== stableStringify(expectedNext)) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${resultId} disposition differs from its exact physical continuation`,
          )
        }
        return Object.freeze({
          kind: 'retry-result', frontierId: expectedNext[0] || null, resultId, result, pointer,
          checkerResultHash: hashText(JSON.stringify(result)),
        })
      }
      if (resumeState.resumeState !== 'RUN_WORK') return null
      const recoveringBaseRecheckResult = nextReady.length === 0 &&
        (resumeState.completedWorkIds || []).includes('roadmap-author-plan-repair') &&
        !(resumeState.retryState && resumeState.retryState.conclusiveCheckerTerminal)
      if (recoveringBaseRecheckResult) {
        const resultId = 'roadmap-plan-recheck'
        if (typeof options.readResult !== 'function' || typeof options.resultPointer !== 'function') {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            'durable ROADMAP recheck controller boundary lacks its exact result resolvers',
          )
        }
        const indexedResult = options.readResult(resultId)
        if (!indexedResult) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            'durable ROADMAP recheck controller boundary lacks its exact committed result',
          )
        }
        const pointer = validateDurableResultEvidencePointer(options.resultPointer(resultId), resultId)
        const result = readRegularJson(pointer.path, `durable ${resultId} recovery result`).parsed
        if (stableStringify(indexedResult) !== stableStringify(result) ||
            !['PASS', 'FAIL'].includes(result.code) ||
            result.candidateHash !== resumeState.planHash) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            'durable ROADMAP recheck result differs from its exact plan, receipt bytes, or conclusive code',
          )
        }
        if (typeof options.verifyDurableResultReceipt !== 'function') {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            'durable ROADMAP recheck controller boundary requires its authenticated receipt',
          )
        }
        options.verifyDurableResultReceipt(resultId, result)
        return Object.freeze({
          kind: 'recheck-result', resultId, result, pointer,
          checkerResultHash: hashText(JSON.stringify(result)),
        })
      }
      const recoveryIds = nextReady.filter(id =>
        /^roadmap-plan-(?:check|recheck)-runtime-retry$/u.test(id) ||
        id === 'roadmap-author-plan-repair')
      if (recoveryIds.length === 0) return null
      if (recoveryIds.length !== 1 || nextReady.length !== 1 ||
          typeof options.readResult !== 'function' || typeof options.resultPointer !== 'function') {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          'durable ROADMAP next-ready recovery must name exactly one result-bound retry or repair',
        )
      }
      const frontierId = recoveryIds[0]
      const resultIds = frontierId === 'roadmap-author-plan-repair'
        ? ['roadmap-plan-check-runtime-retry', 'roadmap-plan-check']
        : [frontierId.replace(/-runtime-retry$/u, '')]
      const resultId = resultIds.find(id => options.readResult(id))
      if (!resultId) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${frontierId} next-ready recovery lacks its committed checker result`,
        )
      }
      const pointer = validateDurableResultEvidencePointer(options.resultPointer(resultId), resultId)
      const result = readRegularJson(pointer.path, `durable ${resultId} recovery result`).parsed
      const indexedResult = options.readResult(resultId)
      if (!indexedResult || stableStringify(indexedResult) !== stableStringify(result)) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${resultId} result index differs from its exact evidence bytes`,
        )
      }
      if (typeof options.verifyDurableResultReceipt === 'function') {
        options.verifyDurableResultReceipt(resultId, result)
      }
      if (!/^[a-f0-9]{64}$/u.test(resumeState.planHash || '') ||
          result.candidateHash !== resumeState.planHash) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${resultId} result differs from the checkpointed exact plan version`,
        )
      }
      const retry = frontierId.endsWith('-runtime-retry')
      if ((retry && !['CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE'].includes(result.code)) ||
          (!retry && result.code !== 'FAIL')) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${frontierId} next-ready recovery is not justified by its checker verdict`,
        )
      }
      return Object.freeze({
        kind: retry ? 'retry' : 'repair',
        frontierId,
        resultId,
        result,
        pointer,
        checkerResultHash: hashText(JSON.stringify(result)),
      })
    }
    const durablePlanningFrontier = recoverDurablePlanningFrontier()
    const durableInconclusiveChecker = resumeState && resumeState.retryState &&
      resumeState.retryState.inconclusiveChecker ||
      (durablePlanningFrontier && durablePlanningFrontier.kind === 'retry'
        ? {
            checkerId: durablePlanningFrontier.resultId,
            candidateHash: resumeState.planHash,
            checkerResultHash: durablePlanningFrontier.checkerResultHash,
            retryAttempt: 1,
            returnState: 'RUN_WORK',
          }
        : null)
    const durablePlanningCheckerId = durableInconclusiveChecker &&
      canonicalCompletedCheckerId(durableInconclusiveChecker.checkerId)
    const durablePlanTerminal = resumeState && resumeState.retryState &&
      resumeState.retryState.conclusiveCheckerTerminal
    if (route === 'ROADMAP' && durablePlanTerminal) {
      if (!/^roadmap-plan-recheck(?:-runtime-retry)?$/u.test(durablePlanTerminal.checkerId || '') ||
          durablePlanTerminal.code !== 'FAIL' || durablePlanTerminal.returnState !== 'RUN_WORK' ||
          durablePlanTerminal.candidateHash !== resumeState.planHash ||
          !/^[a-f0-9]{64}$/u.test(durablePlanTerminal.checkerResultHash || '') ||
          typeof options.readResult !== 'function' || typeof options.resultPointer !== 'function') {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          'durable terminal ROADMAP recheck marker is incomplete or does not bind the exact plan',
        )
      }
      const terminalResult = options.readResult(durablePlanTerminal.checkerId)
      const terminalPointer = validateDurableResultEvidencePointer(
        options.resultPointer(durablePlanTerminal.checkerId),
        durablePlanTerminal.checkerId,
      )
      const terminalBytes = readRegularJson(terminalPointer.path, 'durable terminal ROADMAP recheck result').parsed
      if (!terminalResult || terminalResult.code !== 'FAIL' ||
          stableStringify(terminalResult) !== stableStringify(terminalBytes) ||
          hashText(JSON.stringify(terminalResult)) !== durablePlanTerminal.checkerResultHash) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          'durable terminal ROADMAP recheck result differs from its exact marker or receipt',
        )
      }
      if (typeof options.verifyDurableResultReceipt !== 'function') {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          'durable terminal ROADMAP recheck requires its authenticated terminal receipt',
        )
      }
      options.verifyDurableResultReceipt(durablePlanTerminal.checkerId, terminalResult)
      return { outcome: 'FAILED', terminalEnvelope: terminalResult }
    }
    if (route === 'ROADMAP' && durablePlanningFrontier &&
        durablePlanningFrontier.kind === 'recheck-result' &&
        durablePlanningFrontier.result.code === 'FAIL') {
      return { outcome: 'FAILED', terminalEnvelope: durablePlanningFrontier.result }
    }
    const resumePlanningRetry = Boolean(route === 'ROADMAP' && resumeState &&
      (resumeState.resumeState === 'CHECK_INCONCLUSIVE' ||
       durablePlanningFrontier && durablePlanningFrontier.kind === 'retry') &&
      ['roadmap-plan-check', 'roadmap-plan-recheck'].includes(durablePlanningCheckerId) &&
      durableInconclusiveChecker.returnState === 'RUN_WORK')
    if (route === 'ROADMAP' && resumeState && resumeState.resumeState === 'CHECK_INCONCLUSIVE' &&
        ['roadmap-plan-check', 'roadmap-plan-recheck'].includes(durablePlanningCheckerId) &&
        !resumePlanningRetry) {
      throw new SupervisorIntegrationError(
        'CHECK_RETRY_STATE_INVALID',
        'durable ROADMAP plan retry does not return to its canonical RUN_WORK origin',
      )
    }
    const resumeRepairing = Boolean(resumeState && resumeState.resumeState === 'REPAIRING')
    const resumeAtChecking = Boolean(resumeState &&
      (resumeState.resumeState === 'CHECK_WORK' || resumeRepairing ||
       (resumeState.resumeState === 'CHECK_INCONCLUSIVE' && !resumePlanningRetry)))
    const resumeInWork = Boolean(resumeState &&
      (['RUN_WORK', 'ITEM_VERIFIED', 'REPAIRING'].includes(resumeState.resumeState) || resumePlanningRetry))
    const completedPlanningRetryResult = durablePlanningFrontier &&
      durablePlanningFrontier.kind === 'retry-result' &&
      durablePlanningFrontier.result.code === 'PASS' &&
      canonicalCompletedCheckerId(durablePlanningFrontier.resultId) === durablePlanningCheckerId
    const completedBeforeResume = new Set(resumeState && resumeState.completedWorkIds || [])
    for (const checkId of resumeState && resumeState.completedCheckIds || []) {
      const canonicalCheckId = canonicalCompletedCheckerId(checkId)
      if (completedPlanningRetryResult && canonicalCheckId === durablePlanningCheckerId) continue
      completedBeforeResume.add(canonicalCheckId)
      if (canonicalCheckId === 'roadmap-plan-recheck') {
        if (typeof options.readResult !== 'function' || typeof options.resultPointer !== 'function') {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            'completed ROADMAP recheck requires its exact result resolvers',
          )
        }
        const indexedResult = options.readResult(checkId)
        const pointer = validateDurableResultEvidencePointer(options.resultPointer(checkId), checkId)
        const receiptResult = readRegularJson(pointer.path, `completed ${checkId} result`).parsed
        if (!indexedResult || indexedResult.code !== 'PASS' ||
            indexedResult.candidateHash !== resumeState.planHash ||
            stableStringify(indexedResult) !== stableStringify(receiptResult) ||
            typeof options.verifyDurableResultReceipt !== 'function') {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            'completed ROADMAP recheck differs from its exact plan or authenticated receipt',
          )
        }
        options.verifyDurableResultReceipt(checkId, indexedResult)
        completedBeforeResume.add('roadmap-plan-check')
      }
    }
    if (durablePlanningFrontier && durablePlanningFrontier.kind === 'recheck-result' &&
        durablePlanningFrontier.result.code === 'PASS') {
      completedBeforeResume.add('roadmap-plan-check')
    }
    if (resumePlanningRetry && completedBeforeResume.has('roadmap-plan-check') &&
        !completedPlanningRetryResult) {
      throw new SupervisorIntegrationError(
        'CHECK_RETRY_STATE_INVALID',
        'durable ROADMAP retry conflicts with already accepted plan-check next ready work',
      )
    }
    const adoptedWorkResults = resumeInWork && typeof resumeAdoptedLaunches === 'function'
      ? await resumeAdoptedLaunches({
          resumeState,
          candidateHash: resumeState && resumeState.candidateHash || null,
          decision,
          stage: 'work',
        })
      : {}
    const acceptedWorkResults = new Map(Object.entries(adoptedWorkResults)
      .filter(([workItemId]) => /^work-\d+$/.test(workItemId)))
    for (const [workItemId, adoptedResult] of Object.entries(adoptedWorkResults)) {
      if (!CHECKER_ROLES.has(adoptedResult && adoptedResult.logicalRoleId) &&
          !/^roadmap-plan-(?:check|recheck)(?:-runtime-retry)?$/u.test(workItemId)) {
        completedBeforeResume.add(workItemId)
      } else if (adoptedResult && adoptedResult.code === 'PASS' &&
          !(resumePlanningRetry &&
            workItemId === `${durablePlanningCheckerId}-runtime-retry`)) {
        completedBeforeResume.add(canonicalCompletedCheckerId(workItemId))
      }
    }
    const roadmapWorkerStage = route === 'ROADMAP' && completedBeforeResume.has('roadmap-plan-check') &&
      (workerCount >= 2
        ? completedBeforeResume.has('roadmap-work-group')
        : completedBeforeResume.has('mission-coordination'))
    if ((route !== 'ROADMAP' || roadmapWorkerStage) && resumeState &&
        ['RUN_WORK', 'ITEM_VERIFIED'].includes(resumeState.resumeState)) {
      const requiredOrdinaryWorkIds = Array.from(
        { length: workerCount }, (_, index) => `work-${index + 1}`,
      )
      const completedOrdinaryWorkIds = new Set(resumeState.completedWorkIds || [])
      const expectedMissingWorkIds = requiredOrdinaryWorkIds.filter(
        workItemId => !completedOrdinaryWorkIds.has(workItemId),
      )
      const nextReady = Array.isArray(resumeState.nextReadyWorkIds)
        ? resumeState.nextReadyWorkIds : null
      const exactQueuedWork = nextReady &&
        stableStringify(nextReady) === stableStringify(expectedMissingWorkIds)
      const reconcileMatch = nextReady && nextReady.length === 1 &&
        /^reconcile:(work-\d+)$/u.exec(nextReady[0])
      const adoptedWorkRecords = reconcileMatch && Array.isArray(resumeState.adoptedRecords)
        ? resumeState.adoptedRecords.filter(record =>
            record && record.workItemId === reconcileMatch[1]) : []
      const exactLiveAdoption = Boolean(reconcileMatch &&
        expectedMissingWorkIds.includes(reconcileMatch[1]) &&
        resumeState.schedulerCrashCheckpoint && adoptedWorkRecords.length === 1 &&
        Array.isArray(resumeState.openLeaseIds) &&
        resumeState.openLeaseIds.includes(adoptedWorkRecords[0].id))
      if (!exactQueuedWork && !exactLiveAdoption) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${resumeState.resumeState} next ready work differs from the exact missing physical worker set`,
        )
      }
    }
    let retainedCoordinator = adoptedWorkResults['mission-coordination'] &&
      adoptedWorkResults['mission-coordination'].retainedLease || null
    let retainedManager = adoptedWorkResults['roadmap-work-group'] &&
      adoptedWorkResults['roadmap-work-group'].retainedLease || null
    let planPointer = null
    const roadmapTopology = route === 'ROADMAP' && decision.topology && decision.topology.coordination
    const scoutTopology = roadmapTopology && roadmapTopology.scouts
    const scoutCount = scoutTopology ? Number(scoutTopology.count || 0) : 0
    const namedUnknowns = scoutTopology && Array.isArray(scoutTopology.namedUnknowns)
      ? scoutTopology.namedUnknowns : []
    if (route === 'ROADMAP' && (!Number.isSafeInteger(scoutCount) || scoutCount < 0 ||
        (scoutCount > 0 && namedUnknowns.length !== scoutCount))) {
      throw new SupervisorIntegrationError(
        'SCOUT_TOPOLOGY_INVALID',
        'ROADMAP scout execution requires exactly one deterministic named unknown per scout',
      )
    }
    let latestAuthorWorkItemId = completedBeforeResume.has('roadmap-author-revise')
      ? 'roadmap-author-revise' : 'roadmap-author'
    let roadmapResult = adoptedWorkResults['roadmap-author'] ||
      (completedBeforeResume.has('roadmap-author') && typeof options.readResult === 'function'
        ? options.readResult('roadmap-author') : null)
    if (route === 'ROADMAP' && !resumeAtChecking && !completedBeforeResume.has('roadmap-author')) {
      roadmapResult = adoptedWorkResults['roadmap-author'] || await launch({
        workItemId: 'roadmap-author', logicalRole: 'roadmap-author', parent: 'run-owner',
        purpose: 'planning', assignment: `Create the dependency-ordered roadmap for: ${decision.requestedResult}. Return each concrete ordered step in behaviorChanged.`,
        ownership: [{ kind: 'output', identity: 'plan/ROADMAP.md', owner: 'roadmap-author' }], success: successes, checks,
        manifests: executionOwnership,
        fetchedEvidence: withDescriptiveLikelyAreas(capturedDomainWorkEvidence),
        nextReadyAfter: scoutCount > 0
          ? Array.from({ length: scoutCount }, (_, index) => `roadmap-scout-${index + 1}`)
          : ['roadmap-plan-check'],
      })
      roadmapResult = roadmapAuthorArtifact(roadmapResult)
      options.writePlan('ROADMAP', decision, roadmapResult, 'roadmap-author')
      completedBeforeResume.add('roadmap-author')
    }
    if (route === 'ROADMAP' && !resumeAtChecking && typeof options.planExists === 'function' &&
        !options.planExists('ROADMAP')) {
      if (!roadmapResult) {
        throw new SupervisorIntegrationError(
          'ROADMAP_RESULT_MISSING',
          'completed ROADMAP author result is unavailable for deterministic plan recovery',
        )
      }
      roadmapResult = roadmapAuthorArtifact(roadmapResult)
      options.writePlan('ROADMAP', decision, roadmapResult, latestAuthorWorkItemId)
    }
    const scoutWorkIds = Array.from({ length: scoutCount }, (_, index) => `roadmap-scout-${index + 1}`)
    if (route === 'ROADMAP' && !resumeAtChecking && scoutCount > 0) {
      const scoutResults = new Map()
      await Promise.all(scoutWorkIds.map(async (workItemId, index) => {
        if (completedBeforeResume.has(workItemId)) {
          const restored = adoptedWorkResults[workItemId] ||
            (typeof options.readResult === 'function' ? options.readResult(workItemId) : null)
          if (restored) scoutResults.set(workItemId, restored)
          return
        }
        const result = await launch({
          workItemId, logicalRole: 'scout', parent: 'run-owner', purpose: 'scouting',
          requiredByMission: true,
          assignment: `Resolve only this named ROADMAP unknown: ${namedUnknowns[index]}. Return the concrete correction in behaviorChanged.`,
          ownership: admittedReadOwnership,
          success: [`Return evidence for the named unknown: ${namedUnknowns[index]}`],
          checks: ['Read/list/search only; do not edit the target or the roadmap.'],
          fetchedEvidence: withDescriptiveLikelyAreas(capturedDomainWorkEvidence),
          recoveryGroupWorkIds: scoutWorkIds,
          recoveryJoinWorkId: 'roadmap-author-revise',
          nextReadyAfter: scoutWorkIds.filter(id => id !== workItemId),
        })
        scoutResults.set(workItemId, result)
        completedBeforeResume.add(workItemId)
      }))
      const missingScouts = scoutWorkIds.filter(workItemId => !completedBeforeResume.has(workItemId))
      if (missingScouts.length > 0) {
        throw new SupervisorIntegrationError(
          'SCOUT_JOIN_INCOMPLETE',
          'same-author ROADMAP revision cannot start until every named scout result is durable',
          { missingScouts },
        )
      }
      const scoutEvidence = scoutWorkIds.map(workItemId => {
        if (typeof options.resultPointer !== 'function') {
          throw new SupervisorIntegrationError(
            'SCOUT_EVIDENCE_MISSING',
            'ROADMAP scout join requires durable evidence pointers for every scout result',
          )
        }
        try {
          return validateDurableResultEvidencePointer(options.resultPointer(workItemId), workItemId)
        } catch (error) {
          throw new SupervisorIntegrationError(
            'SCOUT_EVIDENCE_MISSING',
            `ROADMAP scout join requires the exact durable result for ${workItemId}`,
            { cause: error && (error.code || error.message) || 'unknown' },
          )
        }
      })
      const concreteScoutCorrections = scoutWorkIds.map((workItemId, index) => {
        const result = scoutResults.get(workItemId) ||
          (typeof options.readResult === 'function' ? options.readResult(workItemId) : null)
        if (!result) {
          throw new SupervisorIntegrationError(
            'SCOUT_CORRECTION_INVALID',
            `durable scout result is unavailable for ${workItemId}`,
          )
        }
        return scoutCorrection(result, namedUnknowns[index], workItemId, scoutEvidence[index])
      })
      let revisedResult = adoptedWorkResults['roadmap-author-revise'] ||
        (completedBeforeResume.has('roadmap-author-revise') && typeof options.readResult === 'function'
          ? options.readResult('roadmap-author-revise') : null)
      if (!completedBeforeResume.has('roadmap-author-revise')) {
        revisedResult = await launch({
          workItemId: 'roadmap-author-revise', logicalRole: 'roadmap-author', parent: 'run-owner',
          purpose: 'planning', repairOf: 'roadmap-author', executorKey: 'roadmap-author',
          assignment: 'Revise the same ROADMAP after consuming every named scout result; preserve one plan owner and return each correction verbatim in behaviorChanged.',
          ownership: [{ kind: 'output', identity: 'plan/ROADMAP.md', owner: 'roadmap-author' }], success: successes, checks,
          manifests: executionOwnership,
          evidenceHashes: scoutEvidence.map(pointer => pointer.hash),
          evidencePointers: scoutEvidence,
          fetchedEvidence: {
            scoutCorrections: concreteScoutCorrections,
            ...(capturedDomainWorkEvidence || {}),
            ...(withDescriptiveLikelyAreas(null) || {}),
          },
          dependencies: scoutWorkIds,
          nextReadyAfter: ['roadmap-plan-check'],
        })
        completedBeforeResume.add('roadmap-author-revise')
      }
      if (!revisedResult) {
        throw new SupervisorIntegrationError(
          'ROADMAP_RESULT_MISSING',
          'completed same-author ROADMAP revision result is unavailable',
        )
      }
      latestAuthorWorkItemId = 'roadmap-author-revise'
      roadmapResult = roadmapAuthorArtifact(revisedResult, concreteScoutCorrections)
      options.writePlan('ROADMAP', decision, roadmapResult, latestAuthorWorkItemId)
    }
    const isNonAuthoritativePlanResult = result =>
      ['CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE'].includes(result && result.code)
    const inconclusivePlanOutcome = result => ({
      outcome: 'PARTIAL',
      terminalEnvelope: {
        ...result,
        status: 'CHECK_REMAINS_INCONCLUSIVE',
        reason: result && result.cause && result.cause.reason ||
          'the isolated runtime retry remained non-authoritative',
      },
    })
    const runRoadmapPlanCheck = async ({ baseId, retryId, candidateHash, requestFor }) => {
      const markerMatches = resumePlanningRetry && durablePlanningCheckerId === baseId
      if (markerMatches && (durableInconclusiveChecker.retryAttempt !== 1 ||
          durableInconclusiveChecker.candidateHash !== candidateHash ||
          !/^[a-f0-9]{64}$/u.test(durableInconclusiveChecker.checkerResultHash || ''))) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${baseId} retry differs from the exact admitted plan version being checked`,
        )
      }
      if (adoptedWorkResults[retryId] && !markerMatches) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `adopted ${retryId} lacks its durable inconclusive retry marker`,
        )
      }
      let retryStateEntered = markerMatches
      let activeId = markerMatches ? retryId : baseId
      let retryProgressHash = markerMatches
        ? durableInconclusiveChecker.checkerResultHash
        : null
      let result = durablePlanningFrontier && durablePlanningFrontier.kind === 'retry-result' &&
          durablePlanningFrontier.resultId === activeId
        ? durablePlanningFrontier.result
        : adoptedWorkResults[activeId] ||
        await launchChecker(requestFor(activeId, retryProgressHash))
      if (isNonAuthoritativePlanResult(result) && activeId === baseId) {
        retryProgressHash = hashText(JSON.stringify(result))
        await options.transition('CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE', {
          candidateHash,
          checkerId: baseId,
          checkerResultHash: retryProgressHash,
          retryAttempt: 1,
          nextReadyWorkIds: [retryId],
        })
        retryStateEntered = true
        activeId = retryId
        result = adoptedWorkResults[retryId] ||
          await launchChecker(requestFor(retryId, retryProgressHash))
      }
      if (isNonAuthoritativePlanResult(result)) {
        await options.transition('CHECK_REMAINS_INCONCLUSIVE', 'RELEASING_LOCK', {
          candidateHash,
          checkerId: activeId,
          checkerResultHash: hashText(JSON.stringify(result)),
          retryAttempt: 1,
        })
        return { activeId, result, terminal: inconclusivePlanOutcome(result) }
      }
      if (retryStateEntered) {
        await options.transition('CHECK_BECAME_CONCLUSIVE', 'RUN_WORK', {
          candidateHash,
          checkerId: activeId,
          checkerResultHash: hashText(JSON.stringify(result)),
          retryAttempt: 1,
          nextReadyWorkIds: result.code === 'PASS'
            ? ['mission-coordination']
            : baseId === 'roadmap-plan-check' ? ['roadmap-author-plan-repair'] : [],
          ...(baseId === 'roadmap-plan-recheck' && result.code === 'FAIL'
            ? { terminalDisposition: 'FAIL' } : {}),
        })
      } else if (baseId === 'roadmap-plan-recheck' && result.code === 'FAIL') {
        await options.transition('TRANSIENT_RUNTIME', 'RUN_WORK', {
          candidateHash,
          checkerId: activeId,
          checkerResultHash: hashText(JSON.stringify(result)),
          terminalDisposition: 'FAIL',
          nextReadyWorkIds: [],
        })
      }
      return { activeId, result, terminal: null }
    }
    const planCheckRequest = (workItemId, candidateHash, pointer, retryProgressHash = null) => {
      const retry = workItemId === 'roadmap-plan-check-runtime-retry'
      return {
        workItemId, logicalRole: 'plan-checker', parent: 'run-owner',
        purpose: retry ? 'recovery' : 'verification',
        ...(retry ? {
          forkTurns: 1,
          recoveryContext: { type: 'bounded-recovery', code: 'PLAN_CHECK_RUNTIME_RETRY' },
        } : {}),
        ...(retry ? { executorKey: 'roadmap-plan-check' } : {}),
        assignment: retry
          ? 'Retry the same admitted roadmap check in a newly materialized exact-byte snapshot. Do not reinterpret a runtime transport or snapshot defect as a plan defect.'
          : 'Independently check the roadmap against the exact request and dependency facts.',
        candidateHash, oracle: 'roadmap-plan-oracle', success: successes, checks,
        ...(retryProgressHash ? { evidenceHashes: [retryProgressHash] } : {}),
        isolation: 'snapshot', writeProducing: true, roadmapSlice: pointer,
        evidencePointers: scoutWorkIds.map(workItemId => options.resultPointer(workItemId)),
        ...(retry ? {} : {
          fetchedEvidence: withDescriptiveLikelyAreas(
            roadmapResult && Array.isArray(roadmapResult.scoutCorrections)
              ? { scoutCorrections: roadmapResult.scoutCorrections } : null,
          ),
        }),
        manifests: executionOwnership,
        harnessAttestation: options.harnessAttestation(candidateHash, 'roadmap-plan-oracle'),
        nextReadyAfter: ['mission-coordination'],
      }
    }
    const planRecheckRequest = (
      workItemId,
      candidateHash,
      pointer,
      retryProgressHash = null,
      repairProgressHash = null,
    ) => {
      const retry = workItemId === 'roadmap-plan-recheck-runtime-retry'
      return {
        workItemId, logicalRole: 'plan-checker', parent: 'run-owner',
        purpose: retry ? 'recovery' : 'verification',
        ...(retry ? {
          forkTurns: 1,
          recoveryContext: { type: 'bounded-recovery', code: 'PLAN_RECHECK_RUNTIME_RETRY' },
        } : {}),
        repairOf: 'roadmap-plan-check', executorKey: 'roadmap-plan-check',
        assignment: retry
          ? 'Retry the repaired roadmap check in a newly materialized exact-byte snapshot without changing the admitted plan.'
          : 'Recheck only the repaired roadmap findings in the same independent checker context.',
        candidateHash, oracle: 'roadmap-plan-oracle-recheck', success: successes, checks,
        ...((retryProgressHash || repairProgressHash)
          ? { evidenceHashes: [retryProgressHash || repairProgressHash] }
          : {}),
        isolation: 'snapshot', writeProducing: true, roadmapSlice: pointer,
        evidencePointers: scoutWorkIds.map(workItemId => options.resultPointer(workItemId)),
        manifests: executionOwnership,
        harnessAttestation: options.harnessAttestation(candidateHash, 'roadmap-plan-oracle-recheck'),
        nextReadyAfter: ['mission-coordination'],
      }
    }
    const priorPlanFailureEvidenceHash = () => {
      if (typeof options.resultPointer !== 'function' || typeof options.readResult !== 'function') {
        throw new SupervisorIntegrationError(
          'PLAN_CHECK_EVIDENCE_MISSING',
          'repaired ROADMAP recheck requires exact prior FAIL result resolvers',
        )
      }
      for (const checkerId of ['roadmap-plan-check-runtime-retry', 'roadmap-plan-check']) {
        const indexedResult = options.readResult(checkerId)
        if (!indexedResult) continue
        if (indexedResult.code !== 'FAIL') {
          throw new SupervisorIntegrationError(
            'PLAN_CHECK_EVIDENCE_MISSING',
            `repaired ROADMAP recheck found a non-FAIL prior result for ${checkerId}`,
          )
        }
        // Once the durable result index identifies the authoritative attempt,
        // its pointer must validate. Never fall back to an older result when
        // the newer receipt is missing, corrupt, or has changed bytes.
        const pointer = validateDurableResultEvidencePointer(options.resultPointer(checkerId), checkerId)
        const result = readRegularJson(pointer.path, 'ROADMAP plan-check result').parsed
        if (!result || result.code !== 'FAIL') {
          throw new SupervisorIntegrationError(
            'PLAN_CHECK_EVIDENCE_MISSING',
            `repaired ROADMAP recheck result bytes are not an exact FAIL for ${checkerId}`,
          )
        }
        if (typeof options.verifyDurableResultReceipt === 'function') {
          options.verifyDurableResultReceipt(checkerId, result)
        }
        return pointer.hash
      }
      throw new SupervisorIntegrationError(
        'PLAN_CHECK_EVIDENCE_MISSING',
        'repaired ROADMAP recheck lacks an exact durable prior FAIL result',
      )
    }
    const resumeAtPlanRecheck = route === 'ROADMAP' && !resumeAtChecking &&
      !completedBeforeResume.has('roadmap-plan-check') &&
      (resumePlanningRetry
        ? durablePlanningCheckerId === 'roadmap-plan-recheck'
        : completedBeforeResume.has('roadmap-author-plan-repair') ||
          Boolean(adoptedWorkResults['roadmap-plan-recheck']))
    if (resumeAtPlanRecheck) {
      if (completedBeforeResume.has('roadmap-author-plan-repair') &&
          !adoptedWorkResults['roadmap-plan-recheck'] &&
          !adoptedWorkResults['roadmap-plan-recheck-runtime-retry']) {
        const repaired = adoptedWorkResults['roadmap-author-plan-repair'] ||
          (typeof options.readResult === 'function'
            ? options.readResult('roadmap-author-plan-repair') : null)
        if (!repaired) {
          throw new SupervisorIntegrationError(
            'ROADMAP_RESULT_MISSING',
            'completed ROADMAP plan repair lacks its exact durable author result',
          )
        }
        roadmapResult = roadmapAuthorArtifact(
          repaired,
          roadmapResult && roadmapResult.scoutCorrections || [],
        )
        // The repair result can become durable one instruction before the
        // rendered plan. Deterministically rematerialize those exact bytes
        // before admitting the resumed recheck.
        options.writePlan('ROADMAP', decision, roadmapResult, 'roadmap-author-plan-repair')
      }
      planPointer = options.planPointer('ROADMAP')
      const repairProgressHash = resumePlanningRetry || adoptedWorkResults['roadmap-plan-recheck']
        ? null
        : priorPlanFailureEvidenceHash()
      const recheckAttempt = await runRoadmapPlanCheck({
        baseId: 'roadmap-plan-recheck',
        retryId: 'roadmap-plan-recheck-runtime-retry',
        candidateHash: planPointer.sha256,
        requestFor: (workItemId, retryProgressHash) => planRecheckRequest(
          workItemId,
          planPointer.sha256,
          planPointer,
          retryProgressHash,
          repairProgressHash,
        ),
      })
      if (recheckAttempt.terminal) return recheckAttempt.terminal
      if (recheckAttempt.result.code && recheckAttempt.result.code !== 'PASS') {
        return { outcome: 'FAILED', terminalEnvelope: recheckAttempt.result }
      }
      completedBeforeResume.add('roadmap-plan-check')
    }
    if (route === 'ROADMAP' && !resumeAtChecking && !completedBeforeResume.has('roadmap-plan-check')) {
      planPointer = options.planPointer('ROADMAP')
      // The plan checker verifies the frozen roadmap artifact, not the target
      // workspace. Bind its canonical verdict to the exact roadmap bytes it is
      // instructed to inspect so a valid PASS or FAIL can enter the repair loop.
      const resumePlanningRepair = durablePlanningFrontier &&
        durablePlanningFrontier.kind === 'repair'
      if (resumePlanningRepair && durablePlanningFrontier.result.candidateHash !== planPointer.sha256) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          'durable ROADMAP plan repair differs from the current immutable plan bytes',
        )
      }
      const planAttempt = resumePlanningRepair
        ? {
            activeId: durablePlanningFrontier.resultId,
            result: durablePlanningFrontier.result,
            terminal: null,
          }
        : await runRoadmapPlanCheck({
            baseId: 'roadmap-plan-check',
            retryId: 'roadmap-plan-check-runtime-retry',
            candidateHash: planPointer.sha256,
            requestFor: (workItemId, retryProgressHash) => planCheckRequest(
              workItemId,
              planPointer.sha256,
              planPointer,
              retryProgressHash,
            ),
          })
      if (planAttempt.terminal) return planAttempt.terminal
      if (planAttempt.result.code && planAttempt.result.code !== 'PASS') {
        let planCheckEvidence
        try {
          if (typeof options.resultPointer !== 'function') throw new Error('result pointer resolver is unavailable')
          planCheckEvidence = validateDurableResultEvidencePointer(
            options.resultPointer(planAttempt.activeId),
            planAttempt.activeId,
          )
        } catch (error) {
          if (error && error.code === 'PLAN_CHECK_EVIDENCE_MISSING') throw error
          throw new SupervisorIntegrationError(
            'PLAN_CHECK_EVIDENCE_MISSING',
            'ROADMAP plan repair requires the durable exact plan-check result pointer',
            { cause: error && (error.code || error.message) || 'unknown' },
          )
        }
        const repaired = await launch({
          workItemId: 'roadmap-author-plan-repair', logicalRole: 'roadmap-author', parent: 'run-owner',
          purpose: 'planning', repairOf: latestAuthorWorkItemId, executorKey: 'roadmap-author',
          assignment: 'Repair only the concrete independent plan-check findings in the same author context. Read the exact roadmap-plan-check result through its evidence pointer.',
          ownership: [{ kind: 'output', identity: 'plan/ROADMAP.md', owner: 'roadmap-author' }], success: successes, checks,
          manifests: executionOwnership,
          evidenceHashes: [planCheckEvidence.hash],
          fetchedEvidence: {
            scoutCorrections: roadmapResult && roadmapResult.scoutCorrections || [],
            ...(capturedDomainWorkEvidence || {}),
            ...(withDescriptiveLikelyAreas(null) || {}),
          },
          evidencePointers: [
            ...scoutWorkIds.map(workItemId => options.resultPointer(workItemId)),
            planCheckEvidence,
          ],
          nextReadyAfter: ['roadmap-plan-recheck'],
        })
        completedBeforeResume.add('roadmap-author-plan-repair')
        roadmapResult = roadmapAuthorArtifact(
          repaired,
          roadmapResult && roadmapResult.scoutCorrections || [],
        )
        options.writePlan('ROADMAP', decision, roadmapResult, 'roadmap-author-plan-repair')
        planPointer = options.planPointer('ROADMAP')
        const recheckAttempt = await runRoadmapPlanCheck({
          baseId: 'roadmap-plan-recheck',
          retryId: 'roadmap-plan-recheck-runtime-retry',
          candidateHash: planPointer.sha256,
          requestFor: (workItemId, retryProgressHash) => planRecheckRequest(
            workItemId,
            planPointer.sha256,
            planPointer,
            retryProgressHash,
            planCheckEvidence.hash,
          ),
        })
        if (recheckAttempt.terminal) return recheckAttempt.terminal
        if (recheckAttempt.result.code && recheckAttempt.result.code !== 'PASS') {
          return { outcome: 'FAILED', terminalEnvelope: recheckAttempt.result }
        }
      }
      completedBeforeResume.add('roadmap-plan-check')
    }
    if (route === 'ROADMAP' && !planPointer) {
      if (typeof options.planExists !== 'function' || !options.planExists('ROADMAP')) {
        throw new SupervisorIntegrationError(
          'ROADMAP_RESULT_MISSING',
          'ROADMAP resume requires the frozen accepted plan document',
        )
      }
      planPointer = options.planPointer('ROADMAP')
    }
    if (route === 'ROADMAP' && !resumeAtChecking && !retainedCoordinator &&
        !completedBeforeResume.has('mission-coordination')) {
      if (typeof options.verifyL1RequestPointer === 'function') options.verifyL1RequestPointer()
      if (roadmapPlanningStartedAt !== null && typeof options.recordRoadmapPlanning === 'function') {
        const admission = options.recordRoadmapPlanning(
          Math.max(0, options.monotonicNow() - roadmapPlanningStartedAt),
        )
        if (!admission || admission.withinCeiling !== true) {
          throw new SupervisorIntegrationError(
            'ADMISSION_COMPONENT_TIMEOUT',
            'ROADMAP planning exceeded its canonical admission ceiling',
            admission || {},
          )
        }
      }
      const coordinator = await launch({
        workItemId: 'mission-coordination', logicalRole: 'mission-coordinator', parent: 'run-owner',
        purpose: 'planning', retainLease: true,
        requiredByMission: true,
        assignment: 'Own dependency ordering and integration for the accepted roadmap.',
        ownership: admittedReadOwnership, success: successes, checks,
        roadmapSlice: planPointer, manifests: executionOwnership,
        fetchedEvidence: withDescriptiveLikelyAreas(capturedDomainWorkEvidence),
        nextReadyAfter: workerCount >= 2 ? ['roadmap-work-group'] : ['work-1'],
      })
      retainedCoordinator = coordinator.retainedLease
    }
    if (route === 'ROADMAP' && !resumeAtChecking && workerCount >= 2 && !retainedManager &&
        !completedBeforeResume.has('roadmap-work-group')) {
      if (!retainedCoordinator) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          'ROADMAP work group lacks its retained run coordinator in the next ready work',
        )
      }
        const ownership = executionOwnership
        const workerOwnership = Array.from({ length: workerCount }, (_, index) => ownership
          .filter(item => item && item.owner === `worker-${index + 1}`)
          .map(item => item.identity))
        if (workerOwnership.some(resources => resources.length === 0) ||
            new Set(workerOwnership.flat()).size !== workerOwnership.flat().length) {
          throw new SupervisorIntegrationError(
            'WORK_OWNERSHIP_INVALID',
            'ROADMAP work-group management requires at least two useful workers with disjoint named ownership',
          )
        }
        const manager = await launch({
          workItemId: 'roadmap-work-group', logicalRole: 'ap-work-group-manager',
          parent: 'mission-coordinator', caller: retainedCoordinator.caller,
          parentLease: retainedCoordinator.schedulerLease, purpose: 'planning', retainLease: true,
          requiredByMission: true,
          assignment: decision.workerOwnershipReason ||
            'Admit the accepted ROADMAP work group with disjoint worker ownership.',
          ownership: admittedReadOwnership, success: successes, checks,
          roadmapSlice: planPointer, manifests: executionOwnership,
          fetchedEvidence: withDescriptiveLikelyAreas(capturedDomainWorkEvidence),
          workGroupAdmission: {
            route: 'ROADMAP',
            parentRoleId: 'mission-coordinator',
            managerRoleId: 'ap-work-group-manager',
            usefulWorkerCount: workerCount,
            disjointMutableResourceOwnershipRequired: true,
            workerAssignments: workerOwnership.map((mutableResourceIdentities, index) => ({
              workerAssignmentId: `work-${index + 1}`,
              workerLogicalRoleId: 'worker',
              workerMode: 'implementation',
              mutableResourceIdentities,
            })),
          },
          nextReadyAfter: Array.from({ length: workerCount }, (_, index) => `work-${index + 1}`),
        })
        retainedManager = manager.retainedLease
    }
    const requiredWorkIds = Array.from({ length: workerCount }, (_, index) => `work-${index + 1}`)
    const satisfiedWorkIds = new Set(completedBeforeResume)
    let deferredPromotion = null
    if (doneRetryBoundary && resumeAtChecking) {
      if (typeof options.restoreDeferredPromotion !== 'function') {
        throw new SupervisorIntegrationError(
          'DONE_RETRY_RECOVERY_REQUIRED',
          'CHECK_WORK resume requires the durable isolated DONE retry version',
        )
      }
      deferredPromotion = await options.restoreDeferredPromotion('work-1')
      if (!deferredPromotion || typeof deferredPromotion.commit !== 'function' ||
          typeof deferredPromotion.abort !== 'function' ||
          !/^[a-f0-9]{64}$/.test(deferredPromotion.candidateHash || '')) {
        throw new SupervisorIntegrationError(
          'DONE_RETRY_RECOVERY_INVALID',
          'restored deferred promotion handle is not bound to the exact version',
        )
      }
    }
    for (const workItemId of requiredWorkIds) {
      if (adoptedWorkResults[workItemId]) {
        if (adoptedWorkResults[workItemId].allAssignedItemsPass === false) {
          throw new SupervisorIntegrationError(
            'WORK_ITEM_RESULT_FAILED',
            'an adopted failed work result cannot enter the satisfied work set',
            { workItemId, reconstructedTerminal: adoptedWorkResults[workItemId].reconstructedTerminal === true },
          )
        }
        satisfiedWorkIds.add(workItemId)
      }
    }
    try {
      if (resumeAtChecking) {
        // T077 forces any uncertain external work into CHECK_WORK.  Never
        // repeat the original worker; the frozen candidate is reconciled.
      } else {
      for (let index = 0; index < workerCount; index += 1) {
        const workItemId = `work-${index + 1}`
        const alreadyCompleted = satisfiedWorkIds.has(workItemId)
        if (resumeInWork && route === 'ROADMAP' &&
            !(retainedManager || retainedCoordinator)) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
          `persisted ROADMAP next ready work lacks the retained parent topology for ${workItemId}`,
          )
        }
        const responsibility = decision.workerResponsibilities && decision.workerResponsibilities[index]
        const namedOwnership = executionOwnership.length
          ? executionOwnership
              .filter(item => item && item.owner === `worker-${index + 1}`)
              .map(item => item.identity)
          : []
        let workResult = alreadyCompleted
          ? adoptedWorkResults[workItemId] ||
            (typeof options.readResult === 'function' ? options.readResult(workItemId) : null)
          : await launch({
          workItemId, logicalRole: 'worker',
          parent: retainedManager ? 'ap-work-group-manager' : route === 'ROADMAP' ? 'mission-coordinator' : 'run-owner',
          caller: retainedManager ? retainedManager.caller : retainedCoordinator && retainedCoordinator.caller,
          parentLease: retainedManager
            ? retainedManager.schedulerLease
            : retainedCoordinator && retainedCoordinator.schedulerLease,
          purpose: 'work', assignment: responsibility || decision.requestedResult,
          routeDecisionHash: hashText(stableStringify(decision)),
          ownership: namedOwnership.length ? namedOwnership : ['workspace'],
          success: successes, checks,
          roadmapSlice: planPointer, manifests: executionOwnership,
          fetchedEvidence: withDescriptiveLikelyAreas(capturedDomainWorkEvidence),
          deferPromotion: Boolean(doneRetryBoundary),
          difficulty: route === 'ROADMAP' ? 'hard' : route === 'LIGHT' ? 'medium' : 'ordinary',
          risk: (decision.risks || []).length ? 'high' : 'ordinary',
          nextReadyAfter: requiredWorkIds.slice(index + 1),
        })
        if (alreadyCompleted && !workResult) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
            `completed worker ${workItemId} lacks its exact durable result`,
          )
        }
        if (alreadyCompleted && !adoptedWorkResults[workItemId]) {
          if (!workResult || typeof options.resultPointer !== 'function' ||
              typeof options.verifyDurableResultReceipt !== 'function') {
            throw new SupervisorIntegrationError(
              'CRASH_ADOPTION_CONFLICT',
              `completed worker ${workItemId} lacks its exact durable result authentication`,
            )
          }
          const pointer = validateDurableResultEvidencePointer(options.resultPointer(workItemId), workItemId)
          const receiptResult = readRegularJson(pointer.path, `completed ${workItemId} result`).parsed
          if (stableStringify(workResult) !== stableStringify(receiptResult)) {
            throw new SupervisorIntegrationError(
              'CRASH_ADOPTION_CONFLICT',
              `completed worker ${workItemId} differs from its exact receipt bytes`,
            )
          }
          options.verifyDurableResultReceipt(workItemId, workResult)
        }
        const liveRuntimeSignals = canonicalWorkerRuntimeSignals(workResult)
        if (liveRuntimeSignals && depthGateOutcome.depthProbe !== 'PASS') {
          const liveTriggers = selectRuntimeGateTriggers(recipe.selection, liveRuntimeSignals)
          if (liveTriggers.depthProber.required) {
            depthGateOutcome = await executePreProductionRuntimeGates({
              recipe: {
                ...recipe,
                runtimeGatePlan: { ...recipe.runtimeGatePlan, triggers: liveTriggers },
              },
              launch,
              ownership: admittedReadOwnership,
              fetchedEvidence: withDescriptiveLikelyAreas(null),
              durableResult: durableCompletedGateResult('conditional-depth-prober'),
              nextReadyAfter: requiredWorkIds.filter(
                id => id !== workItemId && !satisfiedWorkIds.has(id),
              ),
            })
          }
        }
        if (workResult && workResult.code === 'SPLIT_REQUIRED') {
          if (doneRetryBoundary) {
            throw new SupervisorIntegrationError(
              'SPLIT_DECOMPOSITION_INVALID',
              'a DONE retry version cannot branch into parent decomposition',
            )
          }
          const split = consumeSplitRequired(workResult, {
            route, depth: 0, remainingLaunches: 3, parentWorkItemId: workItemId,
          })
          const splitResults = []
          const splitWorkIds = split.parts.map(part => part.workItemId)
          for (const part of split.parts) {
            let childResult = typeof options.readResult === 'function'
              ? options.readResult(part.workItemId) : null
            if (childResult) {
              if (typeof options.resultPointer !== 'function' ||
                  typeof options.verifyDurableResultReceipt !== 'function') {
                throw new SupervisorIntegrationError(
                  'CRASH_ADOPTION_CONFLICT',
                  `completed split worker ${part.workItemId} lacks exact durable authentication`,
                )
              }
              const pointer = validateDurableResultEvidencePointer(
                options.resultPointer(part.workItemId), part.workItemId,
              )
              const receiptResult = readRegularJson(
                pointer.path, `completed ${part.workItemId} result`,
              ).parsed
              if (stableStringify(childResult) !== stableStringify(receiptResult)) {
                throw new SupervisorIntegrationError(
                  'CRASH_ADOPTION_CONFLICT',
                  `completed split worker ${part.workItemId} differs from its exact receipt bytes`,
                )
              }
              options.verifyDurableResultReceipt(part.workItemId, childResult)
            } else childResult = await launch({
              workItemId: part.workItemId, logicalRole: 'worker',
              parent: retainedManager ? 'ap-work-group-manager' : route === 'ROADMAP' ? 'mission-coordinator' : 'run-owner',
              caller: retainedManager ? retainedManager.caller : retainedCoordinator && retainedCoordinator.caller,
              parentLease: retainedManager
                ? retainedManager.schedulerLease
                : retainedCoordinator && retainedCoordinator.schedulerLease,
              purpose: 'work', assignment: part.assignment,
              ownership: namedOwnership.length ? namedOwnership : ['workspace'],
              success: successes, checks, roadmapSlice: planPointer,
              manifests: executionOwnership,
              fetchedEvidence: withDescriptiveLikelyAreas(capturedDomainWorkEvidence),
              difficulty: route === 'ROADMAP' ? 'hard' : route === 'LIGHT' ? 'medium' : 'ordinary',
              risk: (decision.risks || []).length ? 'high' : 'ordinary',
              recoveryGroupWorkIds: splitWorkIds,
              recoveryJoinWorkIds: requiredWorkIds.filter(
                id => id !== workItemId && !satisfiedWorkIds.has(id),
              ),
              nextReadyAfter: splitWorkIds.filter(id => id !== part.workItemId),
            })
            if (childResult && childResult.code === 'SPLIT_REQUIRED') {
              consumeSplitRequired(childResult, {
                route, depth: 1, remainingLaunches: 0, parentWorkItemId: part.workItemId,
              })
            }
            splitResults.push(childResult)
          }
          workResult = { ...workResult, splitConsumedByParent: true, splitResults }
        }
        if (doneRetryBoundary) {
          if (!workResult || !workResult.deferredPromotion ||
              typeof workResult.deferredPromotion.commit !== 'function' ||
              typeof workResult.deferredPromotion.abort !== 'function' ||
              !/^[a-f0-9]{64}$/.test(workResult.deferredPromotion.candidateHash || '')) {
            throw new SupervisorIntegrationError(
              'DONE_RETRY_ISOLATION_REQUIRED',
              'DONE retry worker did not retain an isolated version until acceptance join',
            )
          }
          deferredPromotion = workResult.deferredPromotion
        }
        if (workResult && workResult.allAssignedItemsPass === false) {
          throw new SupervisorIntegrationError(
            'WORK_ITEM_RESULT_FAILED',
            'a failed work result cannot be verified or enter the satisfied work set',
            { workItemId, reconstructedTerminal: workResult.reconstructedTerminal === true },
          )
        }
        acceptedWorkResults.set(workItemId, workResult)
        satisfiedWorkIds.add(workItemId)
        if (!alreadyCompleted) await emitItemVerifiedTransition(options.transition, {
          workItemId,
          resultHash: hashText(JSON.stringify(workResult)),
          candidateHash: workResult && workResult.candidateHash ||
            deferredPromotion && deferredPromotion.candidateHash ||
            hashWorkspaceCandidate(options.targetPath, options.gitEnvironment()),
          nextReadyWorkIds: requiredWorkIds.filter(id => !satisfiedWorkIds.has(id)),
        })
      }
      }
    } finally {
      if (retainedManager && retainedManager.completed !== true) completeRetainedLease(retainedManager)
      if (retainedCoordinator && retainedCoordinator.completed !== true) completeRetainedLease(retainedCoordinator)
    }
    if (!resumeAtChecking) {
      const missingWorkIds = requiredWorkIds.filter(id => !satisfiedWorkIds.has(id))
      if (missingWorkIds.length) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          'persisted work cannot join until every required work item has an accepted result',
          { missingWorkIds },
        )
      }
    }
    let candidateHash = deferredPromotion && deferredPromotion.candidateHash ||
      resumeState && resumeState.candidateHash ||
      hashWorkspaceCandidate(options.targetPath, options.gitEnvironment())
    const dependencyHash = hashText(stableStringify({
      planPointer,
      requiredWorkIds,
      completedWorkIds: [...satisfiedWorkIds].sort(),
    }))
    const environmentHash = hashEnvironment(options.gitEnvironment())
    const checking = validateLiveCheckingPlan(decision)
    const checkerCount = checking.checkerCount
    const requiredVerdictIds = checkerCount === 1
      ? ['reviewer-verdict'] : ['reviewer-verdict', 'tester-verdict']
    const checkerFreezeBinding = {
      missionHash: options.missionHash,
      planHash: planPointer && planPointer.sha256 || hashText(stableStringify(decision)),
      oracleHash: hashText(stableStringify(checks)),
      assumptionsHash: hashText(stableStringify({
        risks: decision.risks || [], missingInformation: decision.missingInformation || [],
      })),
      checkerCount,
      requiredVerdictIds,
    }
    if (!resumeAtChecking) await options.transition('ALL_WORK_JOINED', 'CHECK_WORK', {
      ...checkerFreezeBinding, candidateHash, dependencyHash, environmentHash,
      nextReadyWorkIds: ['independent-check-1'],
    })
    if (resumeAtChecking && deferredPromotion && deferredPromotion.status === 'PROMOTED') {
      const accepted = deferredPromotion.acceptedJoin
      const restoredEvaluation = accepted && evaluateCapturedDomainOutcomes(
        capturedDomainContracts,
        accepted.capturedDomainOutcomes,
      )
      if (!accepted || accepted.candidateHash !== candidateHash ||
          !Array.isArray(accepted.checkHashes) || accepted.checkHashes.length === 0 ||
          accepted.checkHashes.some(value => !/^[a-f0-9]{64}$/.test(value || '')) ||
          !restoredEvaluation || !restoredEvaluation.valid || !restoredEvaluation.localDoneAllowed ||
          hashText(JSON.stringify(restoredEvaluation)) !== accepted.domainEvaluationHash) {
        throw new SupervisorIntegrationError(
          'DONE_RETRY_RECOVERY_INVALID',
          'promoted DONE retry resume lacks its exact accepted checker/domain join',
        )
      }
      if (typeof options.writeCapturedDomainOutcomes === 'function') {
        options.writeCapturedDomainOutcomes({
          schemaVersion: 1,
          candidateHash,
          contracts: capturedDomainContracts,
          outcomes: accepted.capturedDomainOutcomes,
          evaluation: restoredEvaluation,
        })
      }
      await options.transition('ACCEPTANCE_GREEN', 'FINAL_CHECK', {
        candidateHash,
        checkHashes: accepted.checkHashes,
      })
      return {
        outcome: 'DONE',
        checkHashes: accepted.checkHashes,
        deliverables: changedDeliverables(options.targetPath, options.gitEnvironment()),
        terminalEnvelope: { candidateHash, checkCount: accepted.checkHashes.length, resumedPromotion: true },
      }
    }
    const usableCandidatePath = deferredPromotion && deferredPromotion.workspacePath || options.targetPath
    let usableDeliverables = changedDeliverables(usableCandidatePath, options.gitEnvironment(usableCandidatePath))
    let finalResponse = null
    if (readOnlyRequestedEffect(decision)) {
      for (const workItemId of requiredWorkIds) {
        if (!acceptedWorkResults.has(workItemId) && typeof options.readResult === 'function') {
          const persisted = options.readResult(workItemId)
          if (persisted) acceptedWorkResults.set(workItemId, persisted)
        }
      }
      finalResponse = createReadOnlyFinalResponse(decision, requiredWorkIds.map(workItemId => ({
        workItemId,
        result: acceptedWorkResults.get(workItemId),
      })))
    }
    const mutatingEffect = decision.normalizedRouteFacts &&
      decision.normalizedRouteFacts.requestedEffect === 'mutate'
    if (!resumeAtChecking && mutatingEffect && usableDeliverables.length === 0) {
      if (deferredPromotion) await deferredPromotion.abort('exact version has no user-usable deliverable')
      return {
        outcome: 'FAILED',
        checkHashes: [],
        deliverables: [],
        terminalEnvelope: {
          status: 'USER_USABLE_BUILD_REQUIRED',
          reason: 'missing user-usable deliverable short-circuited before the independent checker group',
          candidateHash,
        },
      }
    }
    const adoptedCheckResults = typeof resumeAdoptedLaunches === 'function'
      ? await resumeAdoptedLaunches({ resumeState, candidateHash, decision, stage: 'check' })
      : {}
    const durableIndependentFrontier = (() => {
      if (!resumeState || !['CHECK_WORK', 'CHECK_INCONCLUSIVE'].includes(resumeState.resumeState) ||
          !Array.isArray(resumeState.nextReadyWorkIds) ||
          typeof options.readResult !== 'function' || typeof options.resultPointer !== 'function') return null
      if (resumeState.nextReadyWorkIds.length > 1) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          'durable independent checker next ready work must name at most one exact physical continuation',
        )
      }
      const nextReadyId = resumeState.nextReadyWorkIds[0] || null
      const completedCanonical = new Set((resumeState.completedCheckIds || [])
        .map(canonicalCompletedCheckerId))
      const pendingRetry = resumeState.resumeState === 'CHECK_INCONCLUSIVE' &&
        resumeState.retryState && resumeState.retryState.inconclusiveChecker
      let checkerId
      let checkerIndex
      let sourceKind
      let repairAttempt = null
      let currentRepairAttempt = 0
      let activeRepairAttempt = 0
      if (pendingRetry) {
        if (!/^independent-check-(\d+)(?:-repair-(\d+))?$/u.test(pendingRetry.checkerId || '') ||
            pendingRetry.retryAttempt !== 1 || pendingRetry.candidateHash !== candidateHash ||
            !/^[a-f0-9]{64}$/u.test(pendingRetry.checkerResultHash || '')) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            'durable independent retry marker does not bind one exact physical checker retry and exact version',
          )
        }
        const retryId = `${pendingRetry.checkerId}-runtime-retry-1`
        const retryAlreadyCommitted = Boolean(options.readResult(retryId))
        checkerId = retryAlreadyCommitted ? retryId : pendingRetry.checkerId
        const match = /^independent-check-(\d+)(?:-repair-(\d+))?/u.exec(pendingRetry.checkerId)
        checkerIndex = Number(match[1]) - 1
        activeRepairAttempt = match[2] ? Number(match[2]) : 0
        sourceKind = retryAlreadyCommitted ? 'retry-result' : 'retry'
      } else {
        const retryMatch = /^(independent-check-(\d+)(?:-repair-(\d+))?)-runtime-retry-1$/u.exec(nextReadyId)
        if (retryMatch) {
          checkerId = retryMatch[1]
          checkerIndex = Number(retryMatch[2]) - 1
          activeRepairAttempt = retryMatch[3] ? Number(retryMatch[3]) : 0
          sourceKind = 'retry'
        } else {
          const repairMatch = /^work-1-repair-(\d+)$/u.exec(nextReadyId)
          const completedRepairAttempts = (resumeState.completedWorkIds || [])
            .map(id => /^work-1-repair-(\d+)$/u.exec(id))
            .filter(Boolean).map(match => Number(match[1]))
          currentRepairAttempt = completedRepairAttempts.length
            ? Math.max(...completedRepairAttempts) : 0
          const currentRepairCompletedCanonical = new Set(
            (resumeState.completedCheckIds || [])
              .filter(id => currentRepairAttempt > 0 &&
                new RegExp(`^independent-check-\\d+-repair-${currentRepairAttempt}(?:-runtime-retry-1)?$`, 'u').test(id))
              .map(canonicalCompletedCheckerId),
          )
          const expectedIndex = Array.from({ length: checkerCount }, (_, index) => index)
            .find(index => !(currentRepairAttempt > 0
              ? currentRepairCompletedCanonical
              : completedCanonical).has(`independent-check-${index + 1}`))
          if (expectedIndex === undefined) {
            if (nextReadyId !== null) {
              throw new SupervisorIntegrationError(
                'CHECK_RETRY_STATE_INVALID',
                `completed repaired checker group has contradictory next ready work ${nextReadyId}`,
              )
            }
            return currentRepairAttempt > 0
              ? Object.freeze({ kind: 'completed-repair', repairAttempt: currentRepairAttempt })
              : null
          }
          checkerIndex = expectedIndex
          activeRepairAttempt = currentRepairAttempt
          checkerId = `independent-check-${checkerIndex + 1}` +
            (currentRepairAttempt > 0 ? `-repair-${currentRepairAttempt}` : '')
          repairAttempt = repairMatch ? Number(repairMatch[1]) : currentRepairAttempt || null
          sourceKind = repairMatch ? 'repair-result' : 'terminal-result'
          if (!repairMatch && nextReadyId !== null) {
            if (nextReadyId === checkerId) {
              return Object.freeze({
                kind: 'fresh', nextReadyId, checkerId, checkerIndex,
                repairAttempt: currentRepairAttempt,
              })
            }
            throw new SupervisorIntegrationError(
              'CHECK_RETRY_STATE_INVALID',
              `durable independent checker next ready work names ${nextReadyId} instead of exact next checker ${checkerId}`,
            )
          }
        }
      }
      const result = options.readResult(checkerId)
      if (!result) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${checkerId} recovery lacks its exact committed checker result`,
        )
      }
      if ((result.currentVersionHash && result.currentVersionHash !== candidateHash) ||
          (result.candidateHash && result.candidateHash !== candidateHash)) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${checkerId} result differs from the exact version being resumed`,
        )
      }
      if (pendingRetry && sourceKind === 'retry-result') {
        const baseResult = options.readResult(pendingRetry.checkerId)
        if (!baseResult ||
            hashText(JSON.stringify(baseResult)) !== pendingRetry.checkerResultHash) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${checkerId} retry result lacks its exact marker-bound base result`,
          )
        }
        const basePointer = validateDurableResultEvidencePointer(
          options.resultPointer(pendingRetry.checkerId), pendingRetry.checkerId,
        )
        const baseReceiptResult = readRegularJson(
          basePointer.path, `durable ${pendingRetry.checkerId} retry base result`,
        ).parsed
        if (stableStringify(baseResult) !== stableStringify(baseReceiptResult)) {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${pendingRetry.checkerId} retry base differs from its exact receipt bytes`,
          )
        }
        if (typeof options.verifyDurableResultReceipt !== 'function') {
          throw new SupervisorIntegrationError(
            'CHECK_RETRY_STATE_INVALID',
            `durable ${pendingRetry.checkerId} retry base requires its authenticated terminal receipt`,
          )
        }
        options.verifyDurableResultReceipt(pendingRetry.checkerId, baseResult)
      }
      if (pendingRetry && sourceKind === 'retry' &&
          hashText(JSON.stringify(result)) !== pendingRetry.checkerResultHash) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${checkerId} base result differs from its exact retry marker`,
        )
      }
      const pointer = validateDurableResultEvidencePointer(options.resultPointer(checkerId), checkerId)
      const receiptResult = readRegularJson(pointer.path, `durable ${checkerId} recovery result`).parsed
      if (stableStringify(result) !== stableStringify(receiptResult)) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${checkerId} result differs from its exact receipt bytes`,
        )
      }
      if (typeof options.verifyDurableResultReceipt !== 'function') {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${checkerId} recovery requires its authenticated terminal receipt`,
        )
      }
      options.verifyDurableResultReceipt(checkerId, result)
      const nonAuthoritative = !['PASS', 'FAIL'].includes(result.code)
      const repairEligible = result.code === 'FAIL' && activeRepairAttempt === 0 &&
        workerCount === 1 && !doneRetryBoundary
      const expectedNext = sourceKind === 'retry'
        ? [`${checkerId}-runtime-retry-1`]
        : result.code === 'PASS'
          ? checkerIndex + 1 < checkerCount
            ? [`independent-check-${checkerIndex + 2}` +
              (activeRepairAttempt > 0 ? `-repair-${activeRepairAttempt}` : '')]
            : []
          : repairEligible ? ['work-1-repair-1'] : []
      if (stableStringify(resumeState.nextReadyWorkIds) !== stableStringify(expectedNext)) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          `durable ${checkerId} result differs from its exact physical continuation: expected ${JSON.stringify(expectedNext)}, received ${JSON.stringify(resumeState.nextReadyWorkIds)}`,
        )
      }
      return Object.freeze({
        kind: sourceKind === 'retry' ? 'retry'
          : result.code === 'PASS' ? 'accepted'
          : repairEligible ? 'repair' : 'terminal',
        fromRetryState: Boolean(pendingRetry), nextReadyId, checkerId, checkerIndex,
        repairAttempt: repairEligible ? 1 : activeRepairAttempt || repairAttempt, result, pointer,
        checkerResultHash: hashText(JSON.stringify(result)), nonAuthoritative,
      })
    })()
    if (durableIndependentFrontier && durableIndependentFrontier.fromRetryState &&
        durableIndependentFrontier.result.code === 'FAIL') {
      await options.transition('CHECK_BECAME_CONCLUSIVE', 'CHECK_WORK', {
        candidateHash,
        checkerId: durableIndependentFrontier.checkerId,
        checkerResultHash: durableIndependentFrontier.checkerResultHash,
        retryAttempt: 1,
        nextReadyWorkIds: durableIndependentFrontier.result.code === 'PASS'
          ? durableIndependentFrontier.checkerIndex + 1 < checkerCount
            ? [`independent-check-${durableIndependentFrontier.checkerIndex + 2}` +
              (durableIndependentFrontier.repairAttempt > 0
                ? `-repair-${durableIndependentFrontier.repairAttempt}` : '')]
            : []
          : durableIndependentFrontier.kind === 'repair'
            ? [durableIndependentFrontier.nextReadyId || 'work-1-repair-1'] : [],
      })
    }
    if (durableIndependentFrontier && durableIndependentFrontier.kind === 'terminal') {
      if (deferredPromotion) await deferredPromotion.abort('durable independent checker terminal result did not pass')
      if (durableIndependentFrontier.result.code === 'FAIL') {
        return { outcome: 'FAILED', terminalEnvelope: durableIndependentFrontier.result, checkHashes: [] }
      }
      await options.transition('CHECK_REMAINS_INCONCLUSIVE', 'RELEASING_LOCK', {
        candidateHash,
        checkerId: durableIndependentFrontier.checkerId,
        checkerResultHash: durableIndependentFrontier.checkerResultHash,
        retryAttempt: durableIndependentFrontier.fromRetryState ? 1 : 0,
      })
      return {
        outcome: 'PARTIAL', checkHashes: [],
        terminalEnvelope: {
          ...durableIndependentFrontier.result,
          status: 'CHECK_REMAINS_INCONCLUSIVE',
          reason: durableIndependentFrontier.result.cause && durableIndependentFrontier.result.cause.reason ||
            'the durable isolated checker retry remained non-authoritative',
        },
      }
    }
    const checkHashes = []
    const checkerEvidenceConsumptions = []
    const requireIndependentReferenceMethod = true
    const persistedBaseline = typeof options.readPreMutationBaseline === 'function'
      ? options.readPreMutationBaseline() : null
    const regressionBaseline = persistedBaseline && Array.isArray(persistedBaseline.existingTests)
      ? persistedBaseline.existingTests.map(item => ({ ...item, fingerprint: item.outputHash }))
      : Array.isArray(decision.regressionBaseline) ? decision.regressionBaseline : []
    const checkerNamedChecks = [...new Set([
      ...checks,
      ...(decision.plannedChecks || []),
      ...regressionBaseline.map(item => item && (item.command || item.id)).filter(Boolean),
    ])]
    const independentVerdicts = []
    const finalFindings = []
    const regressionOutcomeGroups = []
    const capturedDomainOutcomes = []
    const checkerDomainContracts = fixturePrebuildOutcome
      ? capturedDomainContracts.filter(contract => contract.kind !== 'FIXTURE_PROVENANCE')
      : capturedDomainContracts
    const completedCheckResults = new Map()
    if (durableIndependentFrontier && durableIndependentFrontier.kind === 'accepted') {
      completedCheckResults.set(`independent-check-${durableIndependentFrontier.checkerIndex + 1}`, {
        workItemId: durableIndependentFrontier.checkerId,
        result: durableIndependentFrontier.result,
      })
    }
    const completedRepairAttemptsForRecovery = (resumeState && resumeState.completedWorkIds || [])
      .map(id => /^work-1-repair-(\d+)$/u.exec(id)).filter(Boolean).map(match => Number(match[1]))
    const completedRepairAttemptForRecovery = completedRepairAttemptsForRecovery.length
      ? Math.max(...completedRepairAttemptsForRecovery) : 0
    const repairRecoveryInvalidatesCompletedChecks = resumeRepairing ||
      Boolean(durableIndependentFrontier && durableIndependentFrontier.kind === 'repair')
    const exactCompletedCheckIds = [...new Set(resumeState && resumeState.completedCheckIds || [])]
    for (const completedId of exactCompletedCheckIds) {
      if (!/^independent-check-\d+/u.test(completedId)) continue
      if (typeof options.readResult !== 'function') continue
      if (repairRecoveryInvalidatesCompletedChecks) continue
      if (completedRepairAttemptForRecovery > 0 &&
          !new RegExp(`^independent-check-\\d+-repair-${completedRepairAttemptForRecovery}(?:-runtime-retry-1)?$`, 'u')
            .test(completedId)) continue
      const canonicalId = canonicalCompletedCheckerId(completedId)
      if (completedCheckResults.has(canonicalId)) continue
      if (durableIndependentFrontier &&
          canonicalId === `independent-check-${durableIndependentFrontier.checkerIndex + 1}` &&
          durableIndependentFrontier.kind !== 'accepted') continue
      const repairAttempts = (resumeState.completedWorkIds || [])
        .map(id => /^work-1-repair-(\d+)$/u.exec(id)).filter(Boolean).map(match => Number(match[1]))
      const highestRepair = repairAttempts.length ? Math.max(...repairAttempts) : 0
      const attemptBase = highestRepair > 0
        ? `${canonicalId}-repair-${highestRepair}` : canonicalId
      const retryId = `${attemptBase}-runtime-retry-1`
      const exactIdsForAttempt = exactCompletedCheckIds.filter(id =>
        id === attemptBase || id === retryId)
      const selectedId = exactIdsForAttempt.includes(retryId)
        ? retryId : exactIdsForAttempt.includes(attemptBase) ? attemptBase : null
      const selectedResult = selectedId ? options.readResult(selectedId) : null
      if (!selectedResult || selectedResult.code !== 'PASS' ||
          (selectedResult.currentVersionHash && selectedResult.currentVersionHash !== candidateHash) ||
          (selectedResult.candidateHash && selectedResult.candidateHash !== candidateHash)) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `completed checker ${canonicalId} lacks one exact durable PASS result for the resumed version`,
        )
      }
      if (typeof options.resultPointer !== 'function' ||
          typeof options.verifyDurableResultReceipt !== 'function') {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `completed checker ${selectedId} lacks its exact pointer and durable receipt verifier`,
        )
      }
      const selectedPointer = validateDurableResultEvidencePointer(
        options.resultPointer(selectedId), selectedId,
      )
      const receiptResult = readRegularJson(
        selectedPointer.path, `completed checker ${selectedId} result`,
      ).parsed
      if (stableStringify(selectedResult) !== stableStringify(receiptResult)) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `completed checker ${selectedId} differs from its exact receipt bytes`,
        )
      }
      options.verifyDurableResultReceipt(selectedId, selectedResult)
      completedCheckResults.set(canonicalId, { workItemId: selectedId, result: selectedResult })
    }
    let checkerRepairAttempt = durableIndependentFrontier &&
        ['fresh', 'completed-repair', 'accepted'].includes(durableIndependentFrontier.kind)
      ? Number(durableIndependentFrontier.repairAttempt || 0) : 0
    let checkerRuntimeRetries = Array.from({ length: checkerCount }, () => 0)
    let checkerRuntimeProgressHashes = Array.from({ length: checkerCount }, () => null)
    let checkerRuntimeReasons = Array.from({ length: checkerCount }, () => null)
    let checkerControllerAcceptedResults = Array.from({ length: checkerCount }, () => null)
    const pendingRepairRecovery = resumeRepairing
      ? resumeState && resumeState.retryState && resumeState.retryState.pendingImplementationRepair
      : durableIndependentFrontier && durableIndependentFrontier.kind === 'repair'
        ? {
            checkerId: durableIndependentFrontier.checkerId,
            checkerResultHash: durableIndependentFrontier.checkerResultHash,
            checkerReceiptPointer: durableIndependentFrontier.pointer,
            rejectedCandidateHash: candidateHash,
            repairAttempt: durableIndependentFrontier.repairAttempt,
            repairWorkItemId: durableIndependentFrontier.nextReadyId,
          }
        : null
    if (pendingRepairRecovery) {
      const pending = pendingRepairRecovery
      if (!pending || pending.rejectedCandidateHash !== candidateHash ||
          !/^work-1-repair-\d+$/u.test(pending.repairWorkItemId || '') ||
          !Number.isSafeInteger(pending.repairAttempt) || pending.repairAttempt < 1 ||
          pending.repairWorkItemId !== `work-1-repair-${pending.repairAttempt}` ||
          stableStringify(resumeState && resumeState.nextReadyWorkIds) !==
            stableStringify([pending.repairWorkItemId]) ||
          !/^[a-f0-9]{64}$/u.test(pending.checkerResultHash || '') ||
          typeof options.resultPointer !== 'function' || typeof options.readResult !== 'function') {
        throw new SupervisorIntegrationError(
          'REPAIR_RECOVERY_INVALID',
          'REPAIRING resume lacks its exact pending physical repair and rejected checker evidence',
        )
      }
      const checkerResult = options.readResult(pending.checkerId)
      const checkerReceiptPointer = options.resultPointer(pending.checkerId)
      if (!checkerResult || hashText(JSON.stringify(checkerResult)) !== pending.checkerResultHash ||
          stableStringify(checkerReceiptPointer) !== stableStringify(pending.checkerReceiptPointer)) {
        throw new SupervisorIntegrationError(
          'REPAIR_RECOVERY_INVALID',
          'REPAIRING resume checker result or receipt differs from the durable repair binding',
        )
      }
      if (!resumeRepairing) {
        await options.transition('IMPLEMENTATION_DEFECT', 'REPAIRING', {
          candidateHash: pending.rejectedCandidateHash,
          checkerId: pending.checkerId,
          checkerResultHash: pending.checkerResultHash,
          checkerReceiptPointer,
          repairAttempt: pending.repairAttempt,
          repairWorkItemId: pending.repairWorkItemId,
          nextReadyWorkIds: [pending.repairWorkItemId],
        })
      }
      const repairResult = adoptedWorkResults[pending.repairWorkItemId] ||
        options.readResult(pending.repairWorkItemId) || await launch({
          workItemId: pending.repairWorkItemId,
          logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
          repairOf: 'work-1', executorKey: 'work-1',
          assignment: 'Repair only the implementation defects in the bound independent-check receipt. Preserve passing behavior, execute the authoritative acceptance commands, and return a newly verified exact version.',
          ownership: executionOwnership.length
            ? executionOwnership.filter(item => item && item.owner === 'worker-1').map(item => ({ ...item }))
            : ['workspace'],
          success: successes, checks, roadmapSlice: planPointer, manifests: executionOwnership,
          fetchedEvidence: withDescriptiveLikelyAreas({
            ...(capturedDomainWorkEvidence || {}),
            rejectedCheckerReceipt: checkerReceiptPointer,
            rejectedCandidateHash: pending.rejectedCandidateHash,
            checkerResultHash: pending.checkerResultHash,
          }),
          findingIds: exactFindingIds(checkerResult, checkerResult.payload, checkerResult.cause),
          strategyFingerprint: pending.checkerResultHash,
          difficulty: route === 'ROADMAP' ? 'hard' : route === 'LIGHT' ? 'medium' : 'ordinary',
          risk: 'high', nextReadyAfter: [`independent-check-1-repair-${pending.repairAttempt}`],
        })
      if (!repairResult || repairResult.allAssignedItemsPass === false) {
        throw new SupervisorIntegrationError(
          'WORK_ITEM_RESULT_FAILED',
          'resumed same-worker checker repair did not return a verified work result',
          { repairWorkItemId: pending.repairWorkItemId, checkerResultHash: pending.checkerResultHash },
        )
      }
      const repairedCandidateHash = hashWorkspaceCandidate(options.targetPath, options.gitEnvironment())
      if (repairedCandidateHash === pending.rejectedCandidateHash) {
        return {
          outcome: 'FAILED', checkHashes: [],
          terminalEnvelope: {
            status: 'REPAIR_NO_PROGRESS',
            reason: 'the resumed bounded same-worker repair did not produce a changed exact version',
            candidateHash: pending.rejectedCandidateHash,
            checkerResultHash: pending.checkerResultHash,
          },
        }
      }
      candidateHash = repairedCandidateHash
      usableDeliverables = changedDeliverables(options.targetPath, options.gitEnvironment())
      acceptedWorkResults.set(pending.repairWorkItemId, repairResult)
      checkerRepairAttempt = pending.repairAttempt
      await options.transition('REPAIR_READY', 'CHECK_WORK', {
        ...checkerFreezeBinding,
        priorCandidateHash: pending.rejectedCandidateHash,
        candidateHash,
        dependencyHash: hashText(stableStringify({
          priorDependencyHash: dependencyHash,
          repairWorkItemId: pending.repairWorkItemId,
          checkerResultHash: pending.checkerResultHash,
          candidateHash,
        })),
        environmentHash: hashEnvironment(options.gitEnvironment()),
        checkerResultHash: pending.checkerResultHash,
        repairWorkItemId: pending.repairWorkItemId,
        repairAttempt: checkerRepairAttempt,
        nextReadyWorkIds: [`independent-check-1-repair-${checkerRepairAttempt}`],
      })
    }
    if (durableIndependentFrontier && durableIndependentFrontier.kind === 'retry') {
      const index = durableIndependentFrontier.checkerIndex
      if (!Number.isSafeInteger(index) || index < 0 || index >= checkerCount) {
        throw new SupervisorIntegrationError(
          'CHECK_RETRY_STATE_INVALID',
          'durable independent checker retry names an unavailable checker seat',
        )
      }
      checkerRuntimeRetries[index] = 1
      checkerRuntimeProgressHashes[index] = durableIndependentFrontier.checkerResultHash
      checkerRuntimeReasons[index] = canonicalCheckerReassessment({
        code: durableIndependentFrontier.result.code,
        priorResultEvidenceHash: durableIndependentFrontier.checkerResultHash,
      }, {
        resultHash: durableIndependentFrontier.checkerResultHash,
        checkerId: durableIndependentFrontier.checkerId,
      })
      if (!durableIndependentFrontier.fromRetryState) {
        await options.transition('CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE', {
          candidateHash,
          checkerId: durableIndependentFrontier.checkerId,
          checkerResultHash: durableIndependentFrontier.checkerResultHash,
          retryAttempt: 1,
          controllerReassessment: checkerRuntimeReasons[index],
          nextReadyWorkIds: [durableIndependentFrontier.nextReadyId],
        })
      }
    }
    const resumedInconclusive = resumeState && resumeState.retryState &&
      resumeState.retryState.inconclusiveChecker
    if (resumedInconclusive && resumedInconclusive.candidateHash === candidateHash) {
      const resumedIndex = /^independent-check-(\d+)/u.exec(String(resumedInconclusive.checkerId || ''))
      if (resumedIndex && Number(resumedIndex[1]) >= 1 && Number(resumedIndex[1]) <= checkerCount) {
        checkerRuntimeRetries[Number(resumedIndex[1]) - 1] = Math.max(
          1,
          Number(resumedInconclusive.retryAttempt || 1),
        )
        checkerRuntimeProgressHashes[Number(resumedIndex[1]) - 1] =
          resumedInconclusive.checkerResultHash
        checkerRuntimeReasons[Number(resumedIndex[1]) - 1] = canonicalCheckerReassessment(
          resumedInconclusive.controllerReassessment || {
            code: 'INDEPENDENT_CHECK_RUNTIME_RETRY',
            priorResultEvidenceHash: resumedInconclusive.checkerResultHash,
          },
          {
            resultHash: resumedInconclusive.checkerResultHash,
            checkerId: resumedInconclusive.checkerId,
          },
        )
      }
    }
    for (let index = 0; index < checkerCount; index += 1) {
      const adoptedRetryId = `independent-check-${index + 1}-runtime-retry-1`
      if (adoptedCheckResults[adoptedRetryId]) checkerRuntimeRetries[index] = 1
    }
    checkerAttempts: while (true) {
      checkHashes.length = 0
      checkerEvidenceConsumptions.length = 0
      independentVerdicts.length = 0
      finalFindings.length = 0
      regressionOutcomeGroups.length = 0
      capturedDomainOutcomes.length = 0
      if (fixturePrebuildOutcome) capturedDomainOutcomes.push(fixturePrebuildOutcome)
    try {
      for (let index = 0; index < checkerCount; index += 1) {
      const oracle = `independent-check-${index + 1}`
      const canonicalCheckerId = `independent-check-${index + 1}`
      const checkerAssignment = checking.responsibilities[index]
      const assignedDomainContracts = index === 0 ? checkerDomainContracts : []
      let workItemId
      let result
      let reusedControllerResult = false
      if (checkerControllerAcceptedResults[index]) {
        ({ workItemId, result } = checkerControllerAcceptedResults[index])
        reusedControllerResult = true
      }
      while (!reusedControllerResult) {
        const checkerAttemptId = checkerRepairAttempt > 0
          ? `${canonicalCheckerId}-repair-${checkerRepairAttempt}` : canonicalCheckerId
        const retryAttempt = checkerRuntimeRetries[index]
        const retryReason = checkerRuntimeReasons[index]
        workItemId = retryAttempt > 0
          ? `${checkerAttemptId}-runtime-retry-${retryAttempt}` : checkerAttemptId
        const completedAttempt = completedCheckResults.get(canonicalCheckerId)
        if (completedAttempt) {
          completedCheckResults.delete(canonicalCheckerId)
          workItemId = completedAttempt.workItemId
          result = completedAttempt.result
        } else result = adoptedCheckResults && adoptedCheckResults[workItemId] || await launchChecker({
        workItemId,
        logicalRole: index === 0 ? 'independent-reviewer' : 'independent-tester',
        parent: 'run-owner', purpose: 'verification',
        checkerRecoveryDisposition: {
          nonAuthoritativeRetryId: retryAttempt === 0
            ? `${checkerAttemptId}-runtime-retry-1` : null,
          failureRepairId: checkerRepairAttempt === 0 && workerCount === 1 &&
            !doneRetryBoundary && typeof options.resultPointer === 'function'
            ? `work-1-repair-${checkerRepairAttempt + 1}` : null,
        },
        nextReadyAfter: index + 1 < checkerCount
          ? [`independent-check-${index + 2}${checkerRepairAttempt > 0 ? `-repair-${checkerRepairAttempt}` : ''}`]
          : [],
        ...(retryAttempt > 0 ? {
          executorKey: checkerAttemptId,
          forkTurns: 1,
          recoveryContext: {
            type: 'bounded-recovery',
            code: retryReason && retryReason.code || 'INDEPENDENT_CHECK_RUNTIME_RETRY',
          },
        } : {}),
        assignment: `${checkerAssignment}${assignedDomainContracts.length > 0
          ? ' Return every declared captured-domain result in payload.capturedDomainOutcomes.' : ''}` +
          `${retryReason
            ? ` Correct the prior non-authoritative report identified by ${retryReason.code}; use distinct underlying evidence when another checker conflict is named.`
            : ''}` +
          ' Return the immutable underlying evidence identifiers you actually consumed in payload.evidenceIds; acceptance-check labels are not evidence identifiers.' +
          ' Return payload.referenceMethod with methodClass exactly equal to one of requirements-review, authoritative-suite, black-box-boundary, metamorphic-property, or independent-model; also return source, procedure, expectedOutputDerivedFromSubjectCode=false, subjectLogicReimplemented=false, and non-empty positiveInvariants, negativeInvariants, and boundaryInvariants. Execute every accessible pre-existing test and acceptance command; do not substitute only self-authored examples. Expected results must come from an independent source or property. Follow fetchedEvidence.verificationDoctrine exactly; treat PASS as an attempted falsification, not a plausibility review.' +
          ' Return payload.testOutcomes with one entry for every named check: command must exactly equal the named check, status must be PASS or FAIL, and fingerprint must be the lowercase SHA-256 digest of the observed output.',
        candidateHash, oracle, success: successes, checks: checkerNamedChecks,
        isolation: 'snapshot',
        writeProducing: true,
        roadmapSlice: planPointer, manifests: executionOwnership,
        risks: decision.risks || [],
        firstResponsibility: checking.responsibilities[0],
        secondResponsibility: checking.responsibilities[1],
        bounded: true,
        fetchedEvidence: {
              verificationDoctrine: CHECKER_FALSIFICATION_DOCTRINE,
              ...(assignedDomainContracts.length > 0
                ? { capturedDomainContracts: assignedDomainContracts } : {}),
              ...(retryReason ? { controllerReassessment: retryReason } : {}),
            },
        deferredPromotionToken: deferredPromotion && deferredPromotion.token || null,
        ...(retryAttempt > 0 && checkerRuntimeProgressHashes[index]
          ? { evidenceHashes: [checkerRuntimeProgressHashes[index]] }
          : {}),
        // Every PASS remains provisional until evidence IDs, any required
        // reference method, and the whole checker group have been validated.
        deferProofAcceptance: true,
        harnessAttestation: options.harnessAttestation(candidateHash, oracle),
        })
        const rawCheckerResultHash = hashText(stableStringify(result || null))
        const reportedEvidenceIds = result && result.payload && Array.isArray(result.payload.evidenceIds)
          ? result.payload.evidenceIds.map(value => typeof value === 'string' ? value.trim() : value)
          : []
        const canonicalTestOutcomes = result && result.code === 'PASS'
          ? canonicalCheckerTestOutcomes(result.payload && result.payload.testOutcomes, checkerNamedChecks)
          : null
        const failedNamedTestOutcome = canonicalTestOutcomes &&
          canonicalTestOutcomes.some(item => item.status !== 'PASS')
        const invalidReferenceMethod = result && result.code === 'PASS' && requireIndependentReferenceMethod &&
          !canonicalIndependentReferenceMethod(result.payload && result.payload.referenceMethod)
        const invalidEvidenceConsumption = result && result.code === 'PASS' && (
          !uniqueStrings(reportedEvidenceIds) || reportedEvidenceIds.length === 0 ||
          reportedEvidenceIds.some(id => typeof id !== 'string' || id.length > 256 ||
            id === oracle || id === workItemId)
        )
        const controllerDefect = !CANONICAL_CHECKER_CODES.has(result && result.code)
          ? 'CHECK_REPORT_INVALID'
          : result && result.code === 'PASS' && (!canonicalTestOutcomes || failedNamedTestOutcome)
            ? 'TEST_OUTCOMES_INVALID'
          : invalidEvidenceConsumption
            ? 'EVIDENCE_CONSUMPTION_INVALID'
            : invalidReferenceMethod ? 'REFERENCE_METHOD_INVALID' : null
        const nonAuthoritative = ['CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE'].includes(result && result.code) ||
          controllerDefect !== null
        if (nonAuthoritative && retryAttempt === 0) {
          checkerRuntimeProgressHashes[index] = rawCheckerResultHash
          checkerRuntimeReasons[index] = canonicalCheckerReassessment({
            code: controllerDefect || result.code,
            priorResultEvidenceHash: rawCheckerResultHash,
          }, { resultHash: rawCheckerResultHash, checkerId: workItemId })
          await options.transition('CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE', {
            candidateHash,
            checkerId: workItemId,
            checkerResultHash: checkerRuntimeProgressHashes[index],
            retryAttempt: 1,
            ...(controllerDefect ? { controllerReason: controllerDefect } : {}),
            controllerReassessment: checkerRuntimeReasons[index],
            nextReadyWorkIds: [`${checkerAttemptId}-runtime-retry-1`],
          })
          checkerRuntimeRetries[index] = 1
          continue
        }
        if (nonAuthoritative) {
          await options.transition('CHECK_REMAINS_INCONCLUSIVE', 'RELEASING_LOCK', {
            candidateHash,
            checkerId: workItemId,
            checkerResultHash: rawCheckerResultHash,
            retryAttempt,
          })
          if (deferredPromotion) await deferredPromotion.abort('independent checker did not pass')
          return {
            outcome: 'PARTIAL',
            terminalEnvelope: {
              ...result, status: 'CHECK_REMAINS_INCONCLUSIVE',
              reason: controllerDefect
                ? 'the isolated checker retry did not return a complete independently verifiable report'
                : result.cause && result.cause.reason ||
                'the isolated runtime retry remained non-authoritative',
            },
            checkHashes,
          }
        }
        if (retryAttempt > 0) {
          const repairEligible = result.code === 'FAIL' && checkerRepairAttempt === 0 &&
            workerCount === 1 && !doneRetryBoundary && typeof options.resultPointer === 'function'
          await options.transition('CHECK_BECAME_CONCLUSIVE', 'CHECK_WORK', {
            candidateHash,
            checkerId: workItemId,
            checkerResultHash: hashText(JSON.stringify(result)),
            retryAttempt,
            nextReadyWorkIds: result.code === 'PASS'
              ? index + 1 < checkerCount
                ? [`independent-check-${index + 2}` +
                  (checkerRepairAttempt > 0 ? `-repair-${checkerRepairAttempt}` : '')]
                : []
              : repairEligible ? [`work-1-repair-${checkerRepairAttempt + 1}`] : [],
          })
        }
        break
      }
      if (result.code !== 'PASS') {
        const canRepairImplementation = result.code === 'FAIL' && checkerRepairAttempt === 0 &&
          workerCount === 1 && !doneRetryBoundary && typeof options.resultPointer === 'function'
        if (canRepairImplementation) {
          const rejectedCandidateHash = candidateHash
          const checkerReceiptPointer = options.resultPointer(workItemId)
          const checkerResultHash = hashText(JSON.stringify(result))
          await options.transition('IMPLEMENTATION_DEFECT', 'REPAIRING', {
            candidateHash: rejectedCandidateHash,
            checkerId: workItemId,
            checkerResultHash,
            checkerReceiptPointer,
            repairAttempt: checkerRepairAttempt + 1,
            repairWorkItemId: `work-1-repair-${checkerRepairAttempt + 1}`,
            nextReadyWorkIds: [`work-1-repair-${checkerRepairAttempt + 1}`],
          })
          const repairWorkItemId = `work-1-repair-${checkerRepairAttempt + 1}`
          const repairResult = await launch({
            workItemId: repairWorkItemId,
            logicalRole: 'worker', parent: 'run-owner', purpose: 'work',
            repairOf: 'work-1', executorKey: 'work-1',
            assignment: 'Repair only the implementation defects in the bound independent-check receipt. Preserve passing behavior, execute the authoritative acceptance commands, and return a newly verified exact version.',
            ownership: executionOwnership.length
              ? executionOwnership.filter(item => item && item.owner === 'worker-1').map(item => ({ ...item }))
              : ['workspace'],
            success: successes, checks, roadmapSlice: planPointer, manifests: executionOwnership,
            fetchedEvidence: withDescriptiveLikelyAreas({
              ...(capturedDomainWorkEvidence || {}),
              rejectedCheckerReceipt: checkerReceiptPointer,
              rejectedCandidateHash,
              checkerResultHash,
            }),
            findingIds: exactFindingIds(result, result.payload, result.cause),
            strategyFingerprint: checkerResultHash,
            difficulty: route === 'ROADMAP' ? 'hard' : route === 'LIGHT' ? 'medium' : 'ordinary',
            risk: 'high', nextReadyAfter: [`independent-check-1-repair-${checkerRepairAttempt + 1}`],
          })
          if (!repairResult || repairResult.allAssignedItemsPass === false) {
            throw new SupervisorIntegrationError(
              'WORK_ITEM_RESULT_FAILED',
              'same-worker checker repair did not return a verified work result',
              { repairWorkItemId, checkerResultHash },
            )
          }
          const repairedCandidateHash = hashWorkspaceCandidate(options.targetPath, options.gitEnvironment())
          if (repairedCandidateHash === rejectedCandidateHash) {
            return {
              outcome: 'FAILED', checkHashes: [],
              terminalEnvelope: {
                status: 'REPAIR_NO_PROGRESS',
                reason: 'the bounded same-worker repair did not produce a changed exact version',
                candidateHash: rejectedCandidateHash,
                checkerResultHash,
              },
            }
          }
          candidateHash = repairedCandidateHash
          usableDeliverables = changedDeliverables(options.targetPath, options.gitEnvironment())
          acceptedWorkResults.set(repairWorkItemId, repairResult)
          checkerRepairAttempt += 1
          checkerRuntimeRetries = Array.from({ length: checkerCount }, () => 0)
          checkerRuntimeProgressHashes = Array.from({ length: checkerCount }, () => null)
          checkerRuntimeReasons = Array.from({ length: checkerCount }, () => null)
          checkerControllerAcceptedResults = Array.from({ length: checkerCount }, () => null)
          await options.transition('REPAIR_READY', 'CHECK_WORK', {
            ...checkerFreezeBinding,
            priorCandidateHash: rejectedCandidateHash,
            candidateHash,
            dependencyHash: hashText(stableStringify({
              priorDependencyHash: dependencyHash,
              repairWorkItemId,
              checkerResultHash,
              candidateHash,
            })),
            environmentHash: hashEnvironment(options.gitEnvironment()),
            checkerResultHash,
            repairWorkItemId,
            repairAttempt: checkerRepairAttempt,
            nextReadyWorkIds: [`independent-check-1-repair-${checkerRepairAttempt}`],
          })
          continue checkerAttempts
        }
        if (deferredPromotion) await deferredPromotion.abort('independent checker did not pass')
        return { outcome: 'FAILED', terminalEnvelope: result, checkHashes }
      }
      if (result && result.payload && Array.isArray(result.payload.capturedDomainOutcomes)) {
        capturedDomainOutcomes.push(...result.payload.capturedDomainOutcomes)
      }
      const resultHash = hashText(JSON.stringify(result))
      const consumedEvidenceIds = result && result.payload && Array.isArray(result.payload.evidenceIds)
        ? result.payload.evidenceIds.map(value => typeof value === 'string' ? value.trim() : value)
        : []
      checkerEvidenceConsumptions.push({
        checkerId: workItemId,
        oracleId: oracle,
        evidenceIds: consumedEvidenceIds,
        requireReferenceMethod: requireIndependentReferenceMethod,
        referenceMethod: result && result.payload && result.payload.referenceMethod,
      })
      independentVerdicts.push({
        kind: index === 0 ? 'independent-review' : 'independent-verification',
        status: 'PASS',
        verdictHash: resultHash,
        evidenceIds: consumedEvidenceIds,
      })
      if (result && result.payload && Array.isArray(result.payload.findings)) {
        finalFindings.push(...result.payload.findings)
      }
      regressionOutcomeGroups.push(canonicalCheckerTestOutcomes(
        result && result.payload && result.payload.testOutcomes,
        checkerNamedChecks,
      ))
        checkHashes.push(hashText(JSON.stringify(result)))
        checkerControllerAcceptedResults[index] = { workItemId, result }
      }
    } catch (error) {
      if (deferredPromotion) await deferredPromotion.abort(error.code || 'checker launch failed')
      throw error
    }
      try {
        assertDistinctEvidenceConsumption(checkerEvidenceConsumptions)
      } catch (error) {
        const recoverableAggregate = new Set([
          'DUPLICATE_UNDERLYING_EVIDENCE',
          'DUPLICATE_REFERENCE_METHOD',
          'DUPLICATE_REFERENCE_METHOD_CLASS',
        ])
        const affectedId = error && error.details &&
          (error.details.secondCheckerId || error.details.secondOracleId || error.details.checkerId)
        const affectedMatch = /^independent-check-(\d+)/u.exec(String(affectedId || ''))
        const affectedIndex = affectedMatch ? Number(affectedMatch[1]) - 1 : -1
        if (!recoverableAggregate.has(error && error.code) || affectedIndex < 0 ||
            affectedIndex >= checkerCount) throw error
        if (checkerRuntimeRetries[affectedIndex] > 0) {
          if (deferredPromotion) await deferredPromotion.abort('independent checker reassessment remained non-authoritative')
          return {
            outcome: 'PARTIAL',
            terminalEnvelope: {
              status: 'CHECK_REMAINS_INCONCLUSIVE',
              reason: 'the reassigned independent checker still did not provide distinct verification evidence',
            },
            checkHashes,
          }
        }
        const accepted = checkerControllerAcceptedResults[affectedIndex]
        const evidenceHash = hashText(stableStringify(accepted && accepted.result || null))
        checkerRuntimeProgressHashes[affectedIndex] = evidenceHash
        checkerRuntimeRetries[affectedIndex] = 1
        checkerRuntimeReasons[affectedIndex] = canonicalCheckerReassessment({
          code: error.code,
          conflictingCheckerId: error.details &&
            (error.details.firstCheckerId || error.details.firstOracleId) || null,
          reassignedCheckerId: affectedId,
          priorResultEvidenceHash: evidenceHash,
          ...(error.details && error.details.evidenceId
            ? { evidenceId: error.details.evidenceId } : {}),
          ...(error.details && error.details.methodClass
            ? { methodClass: error.details.methodClass } : {}),
          ...(error.details && error.details.methodHash
            ? { methodHash: error.details.methodHash } : {}),
        }, { resultHash: evidenceHash, checkerId: affectedId })
        checkerControllerAcceptedResults[affectedIndex] = null
        await options.transition('CHECK_INCONCLUSIVE', 'CHECK_INCONCLUSIVE', {
          candidateHash,
          checkerId: accepted.workItemId,
          checkerResultHash: evidenceHash,
          retryAttempt: 1,
          controllerReason: error.code,
          controllerReassessment: checkerRuntimeReasons[affectedIndex],
          nextReadyWorkIds: [`${accepted.workItemId}-runtime-retry-1`],
        })
        continue checkerAttempts
      }
      for (let index = 0; index < independentVerdicts.length; index += 1) {
        await options.transition('INDEPENDENT_VERDICT_RECORDED', 'CHECK_WORK', {
          verdictId: index === 0 ? 'reviewer-verdict' : 'tester-verdict',
          verdictHash: independentVerdicts[index].verdictHash,
          nextReadyWorkIds: [],
        })
      }
      break
    }
    if (typeof options.writeAllWorkJoinedReceipt === 'function') {
      const receipt = createAllWorkJoinedReceipt({
        graphBindings: {
          missionHash: options.missionHash,
          planHash: planPointer && planPointer.sha256 || hashText(stableStringify(decision)),
          candidateHash,
          environmentHash,
          oracleHash: hashText(stableStringify(checks)),
          assumptionsHash: hashText(stableStringify({
            risks: decision.risks || [],
            missingInformation: decision.missingInformation || [],
          })),
          dependencyHash,
        },
        checkerCount,
        verdicts: independentVerdicts,
      })
      options.writeAllWorkJoinedReceipt(receipt)
      const reread = options.readAllWorkJoinedReceipt && options.readAllWorkJoinedReceipt()
      if (!reread || reread.receiptHash !== receipt.receiptHash) {
        throw new SupervisorIntegrationError(
          'ALL_WORK_JOINED_INVALID',
          'ALL_WORK_JOINED graph/verdict receipt was not read back exactly',
        )
      }
    }
    if (regressionBaseline.length > 0 && regressionOutcomeGroups.length === 0) {
      if (deferredPromotion) await deferredPromotion.abort('post-check omitted the immutable regression baseline')
      return {
        outcome: 'FAILED', checkHashes,
        terminalEnvelope: { status: 'REGRESSION_BASELINE_NOT_REEXECUTED', baselineIds: regressionBaseline.map(item => item.id) },
      }
    }
    if (regressionBaseline.length > 0) {
      const regressions = regressionOutcomeGroups.map(outcomes =>
        evaluateRegressionDelta(regressionBaseline, outcomes))
      const regression = regressions.find(item => !item.valid)
      if (regression) {
        if (deferredPromotion) await deferredPromotion.abort('new regression detected')
        return { outcome: 'FAILED', checkHashes, terminalEnvelope: { status: 'NEW_REGRESSION', ...regression } }
      }
    }
    if (finalFindings.length > 0) {
      let authorityReceipt = null
      if (finalFindings.some(item => item && item.disposition === 'advisory')) {
        if (typeof options.authorizeResidualRisk !== 'function') {
          throw new SupervisorIntegrationError(
            'RESIDUAL_RISK_AUTHORITY_REQUIRED',
            'advisory findings require post-finding authorization from the production control plane',
          )
        }
        authorityReceipt = await options.authorizeResidualRisk({
          findings: Object.freeze(finalFindings.map(item => Object.freeze({ ...item }))),
          candidateHash,
        })
      }
      createResidualRiskDisposition({ findings: finalFindings, authorityReceipt })
    }
    if (hiddenExternalBoundary && !capturedDomainOutcomes.some(outcome =>
      outcome && outcome.kind === 'HIDDEN_EXTERNAL_ORACLE')) {
      capturedDomainOutcomes.push({
        schemaVersion: '1.0.0',
        kind: 'HIDDEN_EXTERNAL_ORACLE',
        verificationRoute: 'EXTERNALLY_VERIFIABLE_ONLY',
        externalBoundaryRecorded: true,
        localDoneRequested: false,
      })
    }
    appendSupervisorRecordedCapturedDomainOutcomes(capturedDomainContracts, capturedDomainOutcomes)
    const domainEvaluation = evaluateCapturedDomainOutcomes(capturedDomainContracts, capturedDomainOutcomes)
    if (!domainEvaluation.valid) {
      if (deferredPromotion) await deferredPromotion.abort('captured-domain acceptance join failed')
      return {
        outcome: 'FAILED',
        checkHashes,
        terminalEnvelope: {
          status: 'CAPTURED_DOMAIN_OUTCOME_INVALID',
          errors: domainEvaluation.errors,
        },
      }
    }
    if (!domainEvaluation.localDoneAllowed) {
      if (deferredPromotion) await deferredPromotion.abort('external-only result cannot promote a DONE retry')
      if (typeof options.writeCapturedDomainOutcomes === 'function' && capturedDomainContracts.length > 0) {
        options.writeCapturedDomainOutcomes({
          schemaVersion: 1, candidateHash, contracts: capturedDomainContracts,
          outcomes: capturedDomainOutcomes, evaluation: domainEvaluation,
        })
      }
      return {
        outcome: 'PARTIAL',
        checkHashes,
        deliverables: changedDeliverables(options.targetPath, options.gitEnvironment()),
        terminalEnvelope: {
          status: 'EXTERNALLY_VERIFIABLE_ONLY',
          candidateHash,
          localDoneAllowed: false,
          externalOracleId: hiddenExternalBoundary.externalOracleId,
        },
      }
    }
    if (typeof acceptDeferredCheckerProof === 'function') {
      for (const check of checkerEvidenceConsumptions) acceptDeferredCheckerProof(check.checkerId)
    }
    let persistedCapturedDomainOutcomes = capturedDomainOutcomes
    if (deferredPromotion) {
      const promotionOutcome = capturedDomainOutcomes.find(outcome =>
        outcome && outcome.kind === 'DONE_RETRY_PROMOTION')
      await deferredPromotion.commit({
        candidateHash,
        checkHashes,
        acceptanceJoinHash: promotionOutcome && promotionOutcome.acceptanceJoinHash,
        domainEvaluationHash: hashText(JSON.stringify(domainEvaluation)),
        capturedDomainOutcomes,
        domainEvaluation,
      })
      persistedCapturedDomainOutcomes = capturedDomainOutcomes.map(outcome =>
        outcome && outcome.kind === 'DONE_RETRY_PROMOTION'
          ? {
              ...outcome,
              promotedCandidateHash: candidateHash,
              promotionCommittedAfterAcceptanceJoin: true,
            }
          : outcome)
    }
    if (typeof options.writeCapturedDomainOutcomes === 'function' && capturedDomainContracts.length > 0) {
      options.writeCapturedDomainOutcomes({
        schemaVersion: 1,
        candidateHash,
        contracts: capturedDomainContracts,
        outcomes: persistedCapturedDomainOutcomes,
        evaluation: domainEvaluation,
      })
    }
    await options.transition('ACCEPTANCE_GREEN', 'FINAL_CHECK', { candidateHash, checkHashes })
    return {
      outcome: 'DONE',
      checkHashes,
      deliverables: changedDeliverables(options.targetPath, options.gitEnvironment()),
      ...(finalResponse ? { finalResponse } : {}),
      terminalEnvelope: { candidateHash, checkCount: checkerCount },
    }
  }
}

function createCheckerSnapshotFactory(options) {
  fs.mkdirSync(options.snapshotRoot, { recursive: true, mode: 0o700 })
  return (checkerId, _resources, candidateSourcePath = options.targetPath, context = {}) => {
    const sourcePath = path.resolve(candidateSourcePath)
    const projection = context && context.projection || null
    let projectedBytes = null
    let projectedMode = 0o600
    if (projection) {
      if (projection.relativePath !== 'plan/ROADMAP.md' ||
          typeof projection.sourcePath !== 'string' || !path.isAbsolute(projection.sourcePath) ||
          !/^[a-f0-9]{64}$/u.test(projection.sha256 || '') ||
          !Number.isSafeInteger(projection.bytes) || projection.bytes < 0) {
        throw new SupervisorIntegrationError('PLAN_PROJECTION_INVALID', 'checker snapshot projection contract is invalid')
      }
      try {
        projectedBytes = readFileNoFollow(projection.sourcePath)
        projectedMode = fs.lstatSync(projection.sourcePath).mode & 0o777
      } catch (error) {
        throw new SupervisorIntegrationError('PLAN_PROJECTION_INVALID', 'admitted ROADMAP projection source is unsafe or missing', {
          cause: error.code || error.message,
        })
      }
      if (!projectedBytes || projectedBytes.length !== projection.bytes ||
          sha256Bytes(projectedBytes) !== projection.sha256) {
        throw new SupervisorIntegrationError(
          'PLAN_PROJECTION_SOURCE_CHANGED',
          'admitted ROADMAP bytes changed before checker snapshot materialization',
        )
      }
    }
    const snapshotPath = path.join(options.snapshotRoot, `${hashText(checkerId)}-${crypto.randomBytes(8).toString('hex')}`)
    const sourceEnvironment = options.gitEnvironment(sourcePath)
    const clone = childProcess.spawnSync('git', ['clone', '--no-local', '--no-hardlinks', '--', sourcePath, snapshotPath], {
      env: sourceEnvironment, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    })
    if (clone.status !== 0) {
      throw new SupervisorIntegrationError('SNAPSHOT_CREATION_FAILED', 'local exact-version clone failed', {
        status: clone.status, stderr: String(clone.stderr || '').slice(-4096),
      })
    }
    const safetyRepair = childProcess.spawnSync(process.execPath, [
      options.safetyScriptPath,
      '--repo', snapshotPath,
      '--expected-branch', options.expectedBranch,
      '--repair',
      '--enforcement-proof', options.enforcementProofPath,
      '--json',
    ], {
      // Clone and repair under the same repository-derived Git boundary.
      // The ambient activation environment may still carry GIT_CONFIG_*
      // overrides; allowing those into repair can make a safe clone appear to
      // have a foreign hooks path and causes repair to fail closed on resume.
      env: sourceEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    let repairResult = null
    try { repairResult = JSON.parse(String(safetyRepair.stdout || '')) } catch {}
    if (![0, 3].includes(safetyRepair.status) || !repairResult ||
        repairResult.networkContactAttempted !== false || repairResult.repositoryOk !== true) {
      throw new SupervisorIntegrationError(
        'SNAPSHOT_SAFETY_REPAIR_FAILED',
        'private checker clone could not establish the canonical local-only repository controls',
        {
          status: safetyRepair.status,
          stderr: String(safetyRepair.stderr || '').slice(-4096),
          result: repairResult,
        },
      )
    }
    // A Git patch round-trip is not byte preserving when the host applies
    // checkout filters such as core.autocrlf. Mirror the complete candidate
    // file set after the safe clone is established so the checker sees the
    // exact frozen bytes, including tracked deletions and untracked files.
    const candidateNames = Buffer.from(runGit(sourcePath, ['ls-files', '-co', '--exclude-standard', '-z'], {
      encoding: null, environment: sourceEnvironment,
    })).toString('utf8').split('\0').filter(Boolean)
    const candidateNameSet = new Set(candidateNames)
    const clonedNames = Buffer.from(runGit(snapshotPath, ['ls-files', '-co', '--exclude-standard', '-z'], {
      encoding: null, environment: sourceEnvironment,
    })).toString('utf8').split('\0').filter(Boolean)
    for (const relative of clonedNames) {
      if (candidateNameSet.has(relative)) continue
      const destination = path.join(snapshotPath, ...relative.split('/'))
      if (!destination.startsWith(`${snapshotPath}${path.sep}`)) {
        throw new SupervisorIntegrationError('SNAPSHOT_CREATION_FAILED', `deleted snapshot input escapes its repository: ${relative}`)
      }
      const destinationStat = fs.lstatSync(destination)
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
        throw new SupervisorIntegrationError('SNAPSHOT_CREATION_FAILED', `deleted snapshot input is unsafe: ${relative}`)
      }
      fs.unlinkSync(destination)
    }
    for (const relative of candidateNames) {
      const source = path.join(sourcePath, ...relative.split('/'))
      const destination = path.join(snapshotPath, ...relative.split('/'))
      if (!source.startsWith(`${sourcePath}${path.sep}`) ||
          !destination.startsWith(`${snapshotPath}${path.sep}`)) {
        throw new SupervisorIntegrationError('SNAPSHOT_CREATION_FAILED', `snapshot input escapes its repository: ${relative}`)
      }
      if (!fs.existsSync(source)) {
        if (fs.existsSync(destination)) {
          const destinationStat = fs.lstatSync(destination)
          if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
            throw new SupervisorIntegrationError('SNAPSHOT_CREATION_FAILED', `deleted snapshot input is unsafe: ${relative}`)
          }
          fs.unlinkSync(destination)
        }
        continue
      }
      const stat = fs.lstatSync(source)
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) {
        throw new SupervisorIntegrationError('SNAPSHOT_CREATION_FAILED', `snapshot input is unsafe: ${relative}`)
      }
      if (fs.existsSync(destination)) {
        const destinationStat = fs.lstatSync(destination)
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
          throw new SupervisorIntegrationError('SNAPSHOT_CREATION_FAILED', `snapshot destination is unsafe: ${relative}`)
        }
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      }
      fs.copyFileSync(source, destination)
      fs.chmodSync(destination, stat.mode & 0o777)
    }
    let projectionReceipt = null
    if (projection) {
      const destination = path.resolve(snapshotPath, ...projection.relativePath.split('/'))
      if (!pathIsInside(snapshotPath, destination)) {
        throw new SupervisorIntegrationError('PLAN_PROJECTION_INVALID', 'ROADMAP projection destination escaped the checker snapshot')
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      const snapshotReal = fs.realpathSync.native(snapshotPath)
      const parentReal = fs.realpathSync.native(path.dirname(destination))
      if (!pathIsInside(snapshotReal, parentReal)) {
        throw new SupervisorIntegrationError('PLAN_PROJECTION_INVALID', 'ROADMAP projection parent escaped through a link')
      }
      if (fs.existsSync(destination)) {
        const destinationStat = fs.lstatSync(destination)
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink() || Number(destinationStat.nlink) !== 1) {
          throw new SupervisorIntegrationError('PLAN_PROJECTION_INVALID', 'ROADMAP projection destination is unsafe')
        }
        fs.unlinkSync(destination)
      }
      fs.writeFileSync(destination, projectedBytes, { flag: 'wx', mode: projectedMode })
      fs.chmodSync(destination, projectedMode & 0o555 || 0o400)
      const reopened = readFileNoFollow(destination)
      if (!reopened || reopened.length !== projection.bytes || sha256Bytes(reopened) !== projection.sha256) {
        throw new SupervisorIntegrationError('PLAN_PROJECTION_MISMATCH', 'ROADMAP projection changed after materialization')
      }
      projectionReceipt = planProjectionReceipt(projection, snapshotReal, {
        runId: options.runId,
        generation: options.generation,
        checkerId,
      })
    }
    options.cleanupRegistry.register({ path: snapshotPath, kind: 'checker-snapshot', owner: checkerId })
    return projectionReceipt ? Object.freeze({ snapshotPath, projectionReceipt }) : snapshotPath
  }
}

function createCheckerScratchFactory(options) {
  if (!options || typeof options.scratchRoot !== 'string' ||
      !options.cleanupRegistry || typeof options.cleanupRegistry.register !== 'function' ||
      typeof options.runId !== 'string' || typeof options.targetPath !== 'string') {
    throw new SupervisorIntegrationError('CHECKER_SCRATCH_UNAVAILABLE', 'checker scratch factory requires its run, target, cleanup authority, and private root')
  }
  const secret = crypto.randomBytes(32)
  const scratchRoot = path.resolve(options.scratchRoot)
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(scratchRoot, 0o700)
  try { auditPrivatePermissions(scratchRoot, { recurse: false }) } catch (error) {
    throw new SupervisorIntegrationError('CHECKER_SCRATCH_UNAVAILABLE', 'checker scratch authority root is not private and owner-only', { cause: error.message })
  }
  const sign = body => crypto.createHmac('sha256', secret).update(stableStringify(body)).digest('hex')
  const factory = (checkerId, frozenCandidateRoot, context = {}) => {
    if (typeof checkerId !== 'string' || !checkerId || !/^[a-f0-9]{64}$/u.test(context.candidateHash || '')) {
      throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker scratch requires an exact checker identity and exact-version hash')
    }
    const frozen = fs.realpathSync.native(path.resolve(frozenCandidateRoot))
    let scratch = context.adoptedScratchRoot ? path.resolve(context.adoptedScratchRoot) : null
    if (!scratch && Array.isArray(context.adoptedScratchRoots) && context.adoptedScratchRoots.length > 0) {
      const registeredPaths = new Set(options.cleanupRegistry.load().entries
        .filter(entry => entry.status === 'REGISTERED' && entry.kind === 'checker-scratch' && entry.owner === checkerId)
        .map(entry => path.resolve(entry.path)))
      scratch = context.adoptedScratchRoots.map(candidate => path.resolve(candidate)).find(candidate => registeredPaths.has(candidate)) || null
      if (!scratch) throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', 'adopted checker lease has no registered scratch resource')
    }
    if (scratch) {
      const registered = options.cleanupRegistry.load().entries.some(entry =>
        entry.status === 'REGISTERED' && entry.kind === 'checker-scratch' &&
        entry.owner === checkerId && path.resolve(entry.path) === scratch)
      if (!registered) {
        throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', 'adopted checker scratch is not the exact registered checker boundary')
      }
    } else {
      scratch = path.join(scratchRoot, `${hashText(checkerId)}-${crypto.randomBytes(8).toString('hex')}`)
      fs.mkdirSync(scratch, { recursive: false, mode: 0o700 })
      for (const child of ['tmp', 'output', 'cache']) fs.mkdirSync(path.join(scratch, child), { mode: 0o700 })
      options.cleanupRegistry.register({ path: scratch, kind: 'checker-scratch', owner: checkerId })
    }
    const body = {
      schemaVersion: 1,
      runId: options.runId,
      checkerId,
      candidateHash: context.candidateHash,
      frozenCandidateRoot: frozen,
      writableScratchRoot: fs.realpathSync.native(scratch),
      temporaryRoot: fs.realpathSync.native(path.join(scratch, 'tmp')),
      outputRoot: fs.realpathSync.native(path.join(scratch, 'output')),
      cacheRoot: fs.realpathSync.native(path.join(scratch, 'cache')),
    }
    const boundary = Object.freeze({ ...body, capability: sign(body) })
    validateCheckerScratchDirectories(boundary, {
      runId: options.runId,
      checkerId,
      candidateHash: context.candidateHash,
      frozenCandidateRoot: frozen,
      realTargetPath: options.targetPath,
      scratchRoot,
    })
    return boundary
  }
  Object.defineProperty(factory, 'verify', {
    value(record) {
      const boundary = record && record.checkerScratchBoundary
      const roots = validateCheckerScratchDirectories(boundary, {
        runId: options.runId,
        checkerId: record && record.sandboxAssignment && record.sandboxAssignment.checkerId,
        candidateHash: record && record.candidateHash,
        frozenCandidateRoot: record && record.canonicalTargetPath,
        realTargetPath: options.targetPath,
        scratchRoot,
      })
      const expected = sign(checkerScratchReceiptBody(boundary))
      const actualBytes = Buffer.from(boundary.capability, 'hex')
      const expectedBytes = Buffer.from(expected, 'hex')
      if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes) ||
          roots.writableScratchRoot !== path.resolve(record.workingDirectory)) {
        throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker scratch capability is foreign, tampered, or bound to another CWD')
      }
      const registered = options.cleanupRegistry.load().entries.some(entry =>
        entry.status === 'REGISTERED' && entry.kind === 'checker-scratch' &&
        entry.owner === boundary.checkerId && path.resolve(entry.path) === roots.writableScratchRoot)
      if (!registered) throw new SupervisorIntegrationError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'checker scratch capability lacks its live cleanup lease')
      return boundary
    },
  })
  return factory
}

function outputSchemaForRole(roleContract, record) {
  const contractsRoot = path.resolve(__dirname, '..', '..', 'contracts')
  if (record.logicalRole === 'route-analyst') return path.join(contractsRoot, 'schemas', 'route-recommendation.schema.json')
  if (record.logicalRole === 'run-owner' && record.route === 'PRE_ROUTE') {
    return path.join(contractsRoot, 'schemas', 'route-decision.schema.json')
  }
  const role = roleContract.roles.find(item => item.id === record.logicalRole)
  if (!role || typeof role.outputSchema !== 'string') {
    throw new SupervisorIntegrationError('ROLE_POLICY_INVALID', `role has no output schema: ${record.logicalRole}`)
  }
  const relative = role.outputSchema.replace(/^agents\/contracts\//, '')
  return path.join(contractsRoot, ...relative.split('/'))
}

function safeExpectedBranch(repository, environment) {
  const branch = String(runGit(repository, ['branch', '--show-current'], { environment })).trim()
  if (!branch) throw new SupervisorIntegrationError('SAFE_GIT_ENV_INVALID', 'detached HEAD is not a supported child boundary')
  return branch
}

function createRuntimeCapabilityBinding(input) {
  const authority = new RuntimeCapabilityAuthority({
    activationAttestation: input.activation.activationAttestation,
    runtimeMetadataSha256: input.activation.supervisorRuntime.metadataSha256,
    profileSha256: input.activation.enforcementProof.profileSha256,
    payloadManifestSha256: input.activation.record.activationBoundary.payloadManifestSha256,
    runId: input.activation.runId,
    generation: input.activation.record.capability.generation,
    targetIdentity: input.targetIdentity,
    now: input.now,
    environment: input.environment,
  })
  const allowedRoutes = Object.keys(ROUTE_CAPABILITY_EFFECTS)
  const allowedEffects = [...new Set(Object.values(ROUTE_CAPABILITY_EFFECTS).flat())].sort()
  const expiresAtMs = Date.parse(input.activation.record.capability.expiresAt)
  const evidenceHashes = [
    ...input.probe.evidenceHashes,
    hashText(JSON.stringify(input.processAdmission)),
    hashText(JSON.stringify(input.safetyAttestation)),
    input.snapshotEvidenceHash,
    ...(input.controlEvidenceHashes || []),
  ]
  const receipt = authority.issue({
    providerCapabilities: input.providerCapabilities,
    evidenceHashes,
    cliVersion: input.probe.cliVersion,
    allowedRoutes,
    allowedEffects,
    routeEffects: ROUTE_CAPABILITY_EFFECTS,
    controlCapabilities: input.controlCapabilities,
    expiresAtMs,
  })
  return {
    authority,
    receipt,
    exactPathEvidence(expected = {}) {
      const assignmentHash = hashText(stableStringify({
        kind: 'exact-path-preflight', route: expected.route,
        requestEnvelopeHash: expected.requestEnvelopeHash,
        providerCapabilitiesHash: expected.providerCapabilitiesHash,
      }))
      const verified = authority.verify(receipt, {
        runId: input.activation.runId,
        generation: input.activation.record.capability.generation,
        targetIdentity: input.targetIdentity,
        route: expected.route,
        effects: ['read'],
        assignmentId: 'exact-path-preflight',
        assignmentHash,
        requiredCapabilities: receipt.capabilitySet,
      })
      return Object.freeze({
        source: 'authenticated-runtime-capability-receipt',
        providerCapabilitiesHash: expected.providerCapabilitiesHash,
        verifiedCapabilities: Object.freeze([
          ...new Set([...receipt.capabilitySet, ...(receipt.controlCapabilitySet || [])]),
        ].sort()),
        evidenceHashes: Object.freeze([...receipt.probeEvidenceHashes]),
        receipt,
        receiptHash: verified.receiptSha256,
      })
    },
    verify(launch) {
      const route = launch.child.logicalRole === 'route-analyst' || launch.child.logicalRole === 'run-owner'
        ? 'PRE_ROUTE' : input.routeProvider()
      const logicalRole = launch.child.logicalRole
      const effects = route === 'PRE_ROUTE' ? ['read']
        : CHECKER_ROLES.has(logicalRole) ? ['isolated-write', 'read', 'run']
          : ['mission-coordinator', 'ap-work-group-manager'].includes(logicalRole) ? ['coordinate', 'read']
            : logicalRole === 'roadmap-author' ? ['plan-write', 'read', 'run']
              : logicalRole === 'technical-decision-reviewer' ? ['read', 'technical-decision']
                : logicalRole === 'scout' || logicalRole === 'diagnostic-probe' ? ['read', 'run']
                  : ['read', 'run', 'write']
      const requiredCapabilities = ['eventStreaming', 'toolOutputCapture', 'stableChildIdentity', 'cancellation']
      if (route !== 'PRE_ROUTE') requiredCapabilities.push('sameContextContinuation')
      if (effects.includes('isolated-write')) requiredCapabilities.push('isolatedChecking')
      const canonicalAssignment = launch.canonicalAssignment || null
      const assignmentId = canonicalAssignment && canonicalAssignment.assignmentId ||
        launch.assignmentId || launch.workItemId || 'root-route-decision'
      const assignmentHash = canonicalAssignment
        ? hashText(stableStringify(canonicalAssignment))
        : launch.assignmentHash || hashText(stableStringify(launch.assignment || launch.child))
      return authority.verify(receipt, {
        runId: launch.runId,
        generation: launch.generation,
        targetIdentity: input.targetIdentity,
        route,
        effects,
        assignmentId,
        assignmentHash,
        requiredCapabilities,
      })
    },
  }
}

function verifyRequestPointer(pointer) {
  if (!pointer || pointer.kind !== 'request-envelope' || typeof pointer.path !== 'string' ||
      !path.isAbsolute(pointer.path) || !/^[a-f0-9]{64}$/u.test(pointer.hash || '') ||
      !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 1) {
    throw new SupervisorIntegrationError(
      'REQUEST_POINTER_INVALID',
      'L1 request pointer must bind one absolute path, byte count, and SHA-256 digest',
    )
  }
  const bytes = readFileNoFollow(pointer.path)
  if (!Buffer.isBuffer(bytes) || bytes.length !== pointer.bytes || sha256Bytes(bytes) !== pointer.hash) {
    throw new SupervisorIntegrationError(
      'REQUEST_POINTER_CHANGED',
      'L1 request pointer bytes changed after admission or steering',
    )
  }
  return pointer
}

function readExactPathRequestEnvelopeBinding(pointer, record) {
  try {
    if (!pointer || pointer.kind !== 'request-envelope' || !record ||
        typeof pointer.path !== 'string' || typeof pointer.hash !== 'string' ||
        !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 1 || pointer.encoding !== 'utf8') {
      throw new Error('request pointer is incomplete')
    }
    const pointerPath = path.resolve(pointer.path)
    const registeredPath = path.resolve(record.resolve('request/envelope.jsonl'))
    const recordRealpath = fs.realpathSync.native(record.runPath)
    const pointerRealpath = fs.realpathSync.native(pointerPath)
    if (pointerPath !== registeredPath || !pathIsInside(recordRealpath, pointerRealpath)) {
      throw new Error('request pointer escapes the opened run record')
    }
    const bytes = readFileNoFollow(pointerPath)
    if (!Buffer.isBuffer(bytes) || bytes.length !== pointer.bytes) {
      throw new Error('request pointer size does not match the immutable envelope')
    }
    const hash = sha256Bytes(bytes)
    if (hash !== pointer.hash) throw new Error('request pointer hash does not match the immutable envelope')
    const firstNewline = bytes.indexOf(0x0a)
    if (firstNewline < 1) throw new Error('request envelope lacks its canonical header')
    const header = JSON.parse(bytes.subarray(0, firstNewline).toString('utf8'))
    const requestRef = header && header.entryType === 'envelope-header' && header.canonicalRequestObject
    const exactInvocationRef = header && header.entryType === 'envelope-header' && header.exactInvocationObject
    for (const ref of [requestRef, exactInvocationRef]) {
      if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256 || '') ||
          ref.storagePath !== `request/objects/sha256/${ref.sha256}` ||
          !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 1) {
        throw new Error('request envelope canonical object binding is invalid')
      }
    }
    const requestPath = path.resolve(record.resolve(requestRef.storagePath))
    const exactInvocationPath = path.resolve(record.resolve(exactInvocationRef.storagePath))
    const requestRealpath = fs.realpathSync.native(requestPath)
    const exactInvocationRealpath = fs.realpathSync.native(exactInvocationPath)
    if (!pathIsInside(recordRealpath, requestRealpath) ||
        !pathIsInside(recordRealpath, exactInvocationRealpath)) {
      throw new Error('canonical request object escapes the opened run record')
    }
    const requestBytes = readFileNoFollow(requestPath)
    const exactInvocationBytes = readFileNoFollow(exactInvocationPath)
    if (!Buffer.isBuffer(requestBytes) || requestBytes.length !== requestRef.byteLength ||
        sha256Bytes(requestBytes) !== requestRef.sha256 ||
        !Buffer.isBuffer(exactInvocationBytes) ||
        exactInvocationBytes.length !== exactInvocationRef.byteLength ||
        sha256Bytes(exactInvocationBytes) !== exactInvocationRef.sha256) {
      throw new Error('canonical request object bytes do not match the envelope binding')
    }
    const canonicalRequest = JSON.parse(requestBytes.toString('utf8'))
    const exactInvocationObject = JSON.parse(exactInvocationBytes.toString('utf8'))
    if (!canonicalRequest || canonicalRequest.schemaVersion !== 1 ||
        !Array.isArray(canonicalRequest.argv) ||
        canonicalRequest.argv.some(value => typeof value !== 'string') ||
        !exactInvocationObject || exactInvocationObject.schemaVersion !== 1 ||
        !Array.isArray(exactInvocationObject.argv) ||
        exactInvocationObject.argv.some(value => typeof value !== 'string') ||
        stableStringify(exactInvocationObject.argv) !== stableStringify(canonicalRequest.argv)) {
      throw new Error('exact invocation argv does not match the canonical request vector')
    }
    return Object.freeze({ bytes: requestBytes, hash: requestRef.sha256 })
  } catch (error) {
    throw new SupervisorIntegrationError(
      'EXACT_PATH_FACTS_REQUIRED',
      'exact-path admission could not open the physically contained immutable request envelope',
      { cause: error && error.message ? error.message : String(error) },
    )
  }
}

const EXACT_PATH_OBSERVATIONAL_GRAMMAR_VERSION = 'codex-contained-local-observation-literal-v1'
const EXACT_PATH_OBSERVATIONAL_GRAMMAR = Object.freeze({
  'Inspect the contained local workspace files.': Object.freeze({ verb: 'Inspect', requestedEffect: 'inspect', targetScope: 'workspace files' }),
  'Review the contained local source files.': Object.freeze({ verb: 'Review', requestedEffect: 'inspect', targetScope: 'source files' }),
  'Report the contained local repository findings.': Object.freeze({ verb: 'Report', requestedEffect: 'report', targetScope: 'repository findings' }),
  'Inspect the contained local source files.': Object.freeze({ verb: 'Inspect', requestedEffect: 'inspect', targetScope: 'source files' }),
  'Read the contained local source files.': Object.freeze({ verb: 'Read', requestedEffect: 'inspect', targetScope: 'source files' }),
  'Summarize the contained local source files.': Object.freeze({ verb: 'Summarize', requestedEffect: 'report', targetScope: 'source files' }),
  'List the contained local repository files.': Object.freeze({ verb: 'List', requestedEffect: 'report', targetScope: 'repository files' }),
  'Report the contained local project findings.': Object.freeze({ verb: 'Report', requestedEffect: 'report', targetScope: 'project findings' }),
})
const EXACT_PATH_OBSERVATIONAL_GRAMMAR_HASH = hashText(stableStringify({
  grammarVersion: EXACT_PATH_OBSERVATIONAL_GRAMMAR_VERSION,
  literalEntries: EXACT_PATH_OBSERVATIONAL_GRAMMAR,
}))

function classifyExactPathObservationalMission(missionLiteral, originalArgv, input, targetEvidence) {
  const literalGrammarEntry = Object.hasOwn(EXACT_PATH_OBSERVATIONAL_GRAMMAR, missionLiteral)
    ? EXACT_PATH_OBSERVATIONAL_GRAMMAR[missionLiteral]
    : null
  const missionArgv = Array.isArray(originalArgv)
    ? parseExactPathInvocation(originalArgv, String(input.route || '').toUpperCase(), EXACT_PATH_FORBIDDEN_CONTROL_NAMES).missionArgv
    : null
  const grammarEntry = literalGrammarEntry && Array.isArray(missionArgv) && missionArgv.length === 1
    ? literalGrammarEntry
    : null
  const ordinaryMutationVerbs = new Set(['implement', 'fix', 'change', 'consider', 'review'])
  const deniedMutationWords = new Set([
    'advise', 'approve', 'architecture', 'authorize', 'authorization', 'choose', 'compare',
    'cost', 'credential', 'delete', 'deploy', 'destroy', 'determine', 'email', 'external',
    'formulate', 'money', 'pay', 'permission', 'permissions', 'publish', 'recommend',
    'remote', 'select', 'send', 'settle', 'strategy', 'third-party', 'weigh',
  ])
  const ordinaryMutationTokens = !grammarEntry && Array.isArray(missionArgv) && missionArgv.length > 1 &&
    missionArgv.every(token => !/\s/u.test(token) && /^[A-Za-z][A-Za-z0-9'-]*[.,;:!?]?$/u.test(token))
    ? missionArgv.map(token => token.toLowerCase().replace(/[.,;:!?]+$/u, ''))
    : null
  const ordinaryLocalMutation = Boolean(ordinaryMutationTokens &&
    ordinaryMutationVerbs.has(ordinaryMutationTokens[0]) &&
    ordinaryMutationTokens.every(token => !deniedMutationWords.has(token)) &&
    !Object.hasOwn(EXACT_PATH_OBSERVATIONAL_GRAMMAR, missionLiteral))
  // Explicit path controls bypass route selection only. Read-only claims must
  // match the closed one-token grammar exactly. The documented ordinary
  // multi-token local mutation form is admitted under mutation safeguards;
  // unknown, authority-bearing, and external prose fails closed.
  if (!grammarEntry && !ordinaryLocalMutation) {
    throw new SupervisorIntegrationError(
      'EXACT_PATH_FACTS_REQUIRED',
      'exact-path prose lacks a closed local effect, authority, and uncertainty classification',
    )
  }
  const classification = grammarEntry
    ? Object.freeze({
        kind: 'contained-local-observational-directive',
        observationalVerb: grammarEntry.verb,
        requestedEffect: grammarEntry.requestedEffect,
        targetScope: grammarEntry.targetScope,
        decisionSemantics: false,
        mutationSemantics: false,
        externalSemantics: false,
      })
    : Object.freeze({
        kind: 'contained-local-mutating-directive',
        observationalVerb: null,
        requestedEffect: 'mutate',
        targetScope: 'authenticated activation target',
        decisionSemantics: false,
        mutationSemantics: true,
        externalSemantics: false,
        uncertainty: ordinaryMutationTokens[0] === 'consider' ? 'reversible-technical' : 'none',
      })
  const receipt = Object.freeze({
    schemaVersion: 1,
    receiptType: 'codex-exact-path-mission-classification',
    grammarVersion: EXACT_PATH_OBSERVATIONAL_GRAMMAR_VERSION,
    grammarHash: EXACT_PATH_OBSERVATIONAL_GRAMMAR_HASH,
    requestEnvelopeHash: input.requestEnvelopeHash,
    targetIdentity: input.targetIdentity,
    targetEvidenceHash: hashText(stableStringify(targetEvidence)),
    targetAuthorizationEvidenceHash: targetEvidence.authorizationEvidenceHash,
    missionLiteral,
    originalArgvHash: hashText(JSON.stringify(originalArgv)),
    classification,
  })
  return Object.freeze({ receipt, receiptHash: hashText(stableStringify(receipt)) })
}

function productionExactPathPreflight(input = {}) {
  const route = String(input.route || '').toUpperCase()
  // Reject forbidden exact-path control vocabulary explicitly. Exact-path
  // admission never accepts concurrency, agent, thread, parallel, subagent,
  // worker, or delegate controls; only one optional path control is allowed.
  const forbiddenExactPathControls = EXACT_PATH_FORBIDDEN_CONTROL_NAMES
  const requestEnvelopeBytes = Buffer.isBuffer(input.requestEnvelopeBytes)
    ? input.requestEnvelopeBytes
    : null
  const requestEnvelopeBytesHash = requestEnvelopeBytes
    ? sha256Bytes(requestEnvelopeBytes)
    : null
  let request
  try { request = requestEnvelopeBytes && JSON.parse(requestEnvelopeBytes.toString('utf8')) } catch {}
  const argv = request && request.schemaVersion === 1 && Array.isArray(request.argv) &&
      request.argv.every(value => typeof value === 'string')
    ? [...request.argv]
    : null
  const parsed = argv && parseExactPathInvocation(argv, route, forbiddenExactPathControls)
  const missionArgv = parsed && parsed.valid && parsed.missionArgv
  const missionText = Array.isArray(missionArgv) && missionArgv.length >= 1 &&
      missionArgv.every(token => /^[\x20-\x7e]+$/u.test(token) && token.trim() === token && token.length > 0)
    ? missionArgv.join(' ')
    : null
  const exactRoute = input.settings && input.settings.path && input.settings.path.exactRoute
  const parsedExactRoute = parsed && parsed.valid && parsed.pathRoute
  if (!argv || !missionText || !requestEnvelopeBytes ||
      !parsed || parsed.valid !== true || exactRoute !== route ||
      (parsedExactRoute !== null && parsedExactRoute !== route) ||
      !/^[a-f0-9]{64}$/.test(input.requestEnvelopeHash || '') ||
      requestEnvelopeBytesHash !== input.requestEnvelopeHash ||
      typeof input.targetIdentity !== 'string' || !input.targetIdentity ||
      !/^[a-f0-9]{64}$/.test(input.providerCapabilitiesHash || '') ||
      !/^[a-f0-9]{64}$/.test(input.budgetSnapshotHash || '')) {
    throw new SupervisorIntegrationError(
      'EXACT_PATH_FACTS_REQUIRED',
      'production exact-path admission requires the opened canonical request, target, settings, provider, and budget bindings',
    )
  }
  const targetEvidence = input.targetEvidence
  if (!targetEvidence || targetEvidence.source !== 'authenticated-activation-target' ||
      targetEvidence.targetIdentity !== input.targetIdentity ||
      !/^[a-f0-9]{64}$/.test(targetEvidence.authorizationEvidenceHash || '') ||
      !Array.isArray(targetEvidence.evidenceHashes) || targetEvidence.evidenceHashes.length === 0 ||
      targetEvidence.evidenceHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new SupervisorIntegrationError(
      'EXACT_PATH_FACTS_REQUIRED',
      'exact-path production requires authenticated evidence for the exact opened target',
    )
  }
  const missionClassification = classifyExactPathObservationalMission(
    missionText, argv, input, targetEvidence,
  )
  const requestedEffect = missionClassification.receipt.classification.requestedEffect
  const provider = input.providerCapabilities
  const providerEvidence = input.providerCapabilityEvidence
  const providerCapabilityNames = [
    'eventStreaming', 'toolOutputCapture', 'stableChildIdentity',
    'sameContextContinuation', 'isolatedChecking', 'cancellation',
  ]
  const receipt = providerEvidence && providerEvidence.receipt
  const receiptAuthority = receipt && typeof receipt === 'object'
    ? RUNTIME_CAPABILITY_RECEIPT_AUTHORITIES.get(receipt)
    : null
  if (!provider || providerCapabilityNames.some(capability => provider[capability] !== true) ||
      hashText(stableStringify(provider)) !== input.providerCapabilitiesHash ||
      !providerEvidence || providerEvidence.source !== 'authenticated-runtime-capability-receipt' ||
      providerEvidence.providerCapabilitiesHash !== input.providerCapabilitiesHash ||
      !receiptAuthority ||
      !/^[a-f0-9]{64}$/.test(providerEvidence.receiptHash || '') ||
      !Array.isArray(providerEvidence.evidenceHashes) || providerEvidence.evidenceHashes.length === 0 ||
      providerEvidence.evidenceHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)) ||
      !Array.isArray(providerEvidence.verifiedCapabilities)) {
    throw new SupervisorIntegrationError(
      'EXACT_PATH_PROVIDER_UNSUPPORTED',
      'the authenticated live Codex capability receipt does not prove every exact-path execution guarantee',
    )
  }
  const assignmentHash = hashText(stableStringify({
    kind: 'exact-path-preflight', route,
    requestEnvelopeHash: input.requestEnvelopeHash,
    providerCapabilitiesHash: input.providerCapabilitiesHash,
  }))
  const authenticated = receiptAuthority.verify(receipt, {
    runId: receipt.runId,
    generation: receipt.generation,
    targetIdentity: input.targetIdentity,
    route,
    effects: requestedEffect === 'mutate' ? ROUTE_CAPABILITY_EFFECTS[route] : ['read'],
    assignmentId: 'exact-path-preflight',
    assignmentHash,
    requiredCapabilities: providerCapabilityNames,
  })
  const authenticatedCapabilities = [...authenticated.capabilitySet].sort()
  const declaredCapabilities = [...new Set(providerEvidence.verifiedCapabilities)].sort()
  const receiptEvidenceHashes = [...new Set(receipt.probeEvidenceHashes || [])].sort()
  const declaredEvidenceHashes = [...new Set(providerEvidence.evidenceHashes)].sort()
  if (authenticated.receiptSha256 !== providerEvidence.receiptHash ||
      JSON.stringify(declaredCapabilities) !== JSON.stringify(authenticatedCapabilities) ||
      JSON.stringify(declaredEvidenceHashes) !== JSON.stringify(receiptEvidenceHashes)) {
    throw new SupervisorIntegrationError(
      'EXACT_PATH_PROVIDER_UNSUPPORTED',
      'the supplied capability fields do not bind the authority-issued live receipt bytes',
    )
  }
  const remainingMs = Number(input.budget && input.budget.remaining && input.budget.remaining.wallMs)
  const verificationReserveMs = Number(input.budget && input.budget.verificationReserveMs || 0)
  const finalizationReserveMs = Number(input.budget && input.budget.finalizationReserveMs || 0)
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 ||
      !Number.isFinite(verificationReserveMs) || verificationReserveMs < 0 ||
      !Number.isFinite(finalizationReserveMs) || finalizationReserveMs < 0 ||
      verificationReserveMs + finalizationReserveMs >= remainingMs) {
    throw new SupervisorIntegrationError(
      'EXACT_PATH_BUDGET_INSUFFICIENT',
      'the live budget cannot preserve exact-path execution, verification, and finalization reserves',
    )
  }
  const mutating = requestedEffect === 'mutate'
  const routeFacts = {
    schemaVersion: '2.0.0',
    requestedEffect,
    successCriteria: 'ready',
    dependency: {
      shape: 'bounded', dependentWorkGroupCount: 0,
      integrationOwnerRequired: false, separateDependentBodies: 0,
    },
    // The closed grammar receipt proves this complete directive contains no
    // unresolved decision token; arbitrary prose never reaches this claim.
    uncertainty: missionClassification.receipt.classification.uncertainty || 'none',
    reversibility: mutating ? 'locally-reversible' : 'fully-reversible',
    mutableResources: mutating ? [{
      kind: 'directory', identity: input.targetIdentity, shared: false, ownershipMode: 'single-owner',
    }] : [],
    sideEffects: mutating ? ['deliverable-write'] : [],
    externality: 'local-only',
    confidentiality: 'restricted',
    thirdPartyImpact: 'none',
    targetAuthorization: {
      targetIdentities: [input.targetIdentity],
      authorizedTargetIdentities: [input.targetIdentity],
      authorizationEvidenceHash: targetEvidence.authorizationEvidenceHash,
      allTargetsAuthorized: true,
    },
    costAuthority: {
      mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0,
      approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null, withinLimit: true,
    },
    riskAndIndependentCheckFloor: {
      level: 'elevated', minimumCheckerCount: 2,
      namedDistinctResponsibilities: [
        'Independently verify the frozen exact-path result.',
        mutating
          ? 'Independently verify target ownership, baseline, and mutation isolation.'
          : 'Independently verify the target and read-only boundary remained intact.',
      ],
    },
    checkAndBaseline: {
      checkQuality: 'observable',
      availableCheckKinds: mutating
        ? ['focused-test', 'independent-review']
        : ['authenticated-read-only-result-observation'],
      baselineStatus: mutating ? 'required-before-production' : 'not-applicable', hiddenExternalCheck: false,
    },
    capturedIncidentDomains: [],
    deadlineBudget: {
      remainingSeconds: remainingMs / 1000,
      admissionSeconds: 0,
      executionReserveSeconds: (remainingMs - verificationReserveMs - finalizationReserveMs) / 1000,
      verificationReserveSeconds: verificationReserveMs / 1000,
      recoveryAndFinalizationReserveSeconds: finalizationReserveMs / 1000,
    },
    operatorMinimumRoute: route,
    transportCapability: {
      mode: provider.sameContextContinuation ? 'native-recursive' : 'sequential-isolated',
      taskCapabilityPreserved: provider.sameContextContinuation === true,
    },
    candidateFreeze: {
      required: mutating,
      available: provider.isolatedChecking === true,
      environmentCanBeBound: provider.stableChildIdentity === true,
    },
    missingUserInput: [],
    architectureImpact: 'local',
    fitsLightPlan: true,
    approachNeedsShortPlanning: route === 'LIGHT',
    shortOrderUnclear: false,
  }
  const factsValidation = routeFactsRouter.validateRouteFacts(routeFacts)
  if (!factsValidation.valid) {
    throw new SupervisorIntegrationError('EXACT_PATH_FACTS_REQUIRED', factsValidation.errors.join('; '))
  }
  const requiredCapabilities = routeFactsRouter.requiredCapabilitiesForFacts(factsValidation.facts, route)
  const verifiedCapabilities = authenticatedCapabilities
  const missingCapabilities = requiredCapabilities.filter(capability => !verifiedCapabilities.includes(capability))
  if (missingCapabilities.length > 0) {
    throw new SupervisorIntegrationError(
      'EXACT_PATH_PROVIDER_UNSUPPORTED',
      `authenticated capability receipt is missing: ${missingCapabilities.join(', ')}`,
    )
  }
  const evidenceHashes = [missionClassification.receiptHash, hashText(stableStringify({
    schemaVersion: 1,
    source: 'production-authenticated-canonical-inputs',
    requestEnvelopeHash: input.requestEnvelopeHash,
    targetIdentity: input.targetIdentity,
    providerCapabilitiesHash: input.providerCapabilitiesHash,
    budgetSnapshotHash: input.budgetSnapshotHash,
    missionClassificationReceiptHash: missionClassification.receiptHash,
    routeFacts,
    verifiedCapabilities,
  }))]
  const preflight = {
    schemaVersion: 1,
    source: 'deterministic-preflight',
    requestEnvelopeHash: input.requestEnvelopeHash,
    targetIdentity: input.targetIdentity,
    providerCapabilitiesHash: input.providerCapabilitiesHash,
    budgetSnapshotHash: input.budgetSnapshotHash,
    evidenceHashes,
    missionClassificationReceipt: missionClassification.receipt,
    missionClassificationReceiptHash: missionClassification.receiptHash,
    routeFacts,
    verifiedCapabilities,
  }
  const evaluation = evaluateExactPathPreflight({ ...input, preflight })
  if (!evaluation.accepted) {
    throw new SupervisorIntegrationError(evaluation.status, evaluation.errors.join('; '), evaluation)
  }
  return Object.freeze(preflight)
}

function resumePlanProjectionAccepted(route, currentPlanHash, checkpointPlanHash, validateProjection) {
  if (currentPlanHash === checkpointPlanHash) return true
  return route === 'ROADMAP' && /^[a-f0-9]{64}$/u.test(currentPlanHash || '') &&
    typeof validateProjection === 'function' && validateProjection(currentPlanHash) === true
}

function createSupervisorOptions(args = {}, context = {}) {
  const environment = context.environment || process.env
  if (Object.prototype.hasOwnProperty.call(environment, 'SENTINEL')) {
    throw new SupervisorIntegrationError(
      'LEGACY_SENTINEL_UNSUPPORTED',
      'the modern Codex supervisor rejects the legacy SENTINEL override',
    )
  }
  const activation = validateActivationInputs(args, environment, context.adapterPath || __filename)
  let admittedRuntime
  try {
    admittedRuntime = openCodexExecutableAdmission(
      activation.record.activationBoundary?.codexExecutable,
      activation.record.providerTrust?.runtimeIdentityHash,
    )
  } catch (error) {
    throw new SupervisorIntegrationError(
      'PROVIDER_UNSUPPORTED', 'signed Codex executable admission is unavailable or drifted',
      { cause: error.message },
    )
  }
  const probe = probeCodexExecCapabilities({
    admittedRuntime,
    cwd: activation.record.target.realpath,
    environment,
    execFileSync: context.execFileSync,
    processOwnership: Boolean(context.processOwner),
    isolatedChecking: typeof context.checkerSnapshotFactory === 'function',
  })
  if (!probe.supported) {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'installed Codex CLI lacks the external supervisor contract', probe)
  }
  const runtimeOptionsFactory = context.runtimeOptionsFactory || createDefaultRuntimeOptions
  const options = runtimeOptionsFactory({ activation, probe, SUPERVISOR_ADAPTER_INTERFACE, context })
  if (options && typeof options.then === 'function') {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'runtimeOptionsFactory must be synchronous')
  }
  if (!options || typeof options !== 'object') {
    throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'runtimeOptionsFactory must return supervisor options')
  }
  // Runtime callbacks close over the exact options object produced above.
  // Preserve that identity so CodexSupervisorRuntime's runtimeInstance binding
  // is visible to recordFactory and every later callback.
  options.activationReceipt = activation
  options.entryPrompt = activation.entryPrompt
  return options
}

function createDefaultRuntimeOptions(input) {
  const { activation, probe, context = {} } = input
  const environment = context.environment || process.env
  const wallTimeUnbounded = benchmarkNoTimeoutEnabled(environment)
  const activationRecord = activation.record
  const targetPath = activationRecord.target.realpath
  const generation = activationRecord.capability.generation
  const missionHash = hashText(activationRecord.request.canonicalJson)
  let missionLock = null
  let leaseRef = null
  let recordRef = null
  let stateStore = null
  let workerWorkspaceManager = null
  let cleanupRegistry = null
  let accountingAuthorityRef = null
  let recoveryCheckpointAuthorityRef = null
  let pendingCrashResume = null
  let capabilityBinding = null
  let codexAdapter = null
  let trustedTestRunner = null
  let currentRoute = null
  const boundRecord = openRunRecord(activation.supervisorRuntime.runPath, { requireInitialized: false })
  if (boundRecord.runId !== activation.runId || boundRecord.targetPath !== targetPath ||
      boundRecord.targetIdentity !== activation.supervisorRuntime.targetIdentity) {
    throw new SupervisorIntegrationError(
      'RUN_RECORD_SCHEMA_INCOMPATIBLE',
      'opened run record differs from the activation-owned runtime binding',
    )
  }
  // AP-RUN-032: this is deliberately unconditional and precedes every
  // control adapter/owner/lease constructor. Durable controls may belong only
  // to this activation's current generation or its exact crash predecessor;
  // stale, foreign, future, rolled-back, and unsequenced authority is denied
  // before the production path can mutate control state or launch a process.
  const generationControlAuthority = assertGenerationControlAuthority({
    runPath: boundRecord.runPath,
    activationId: activation.runId,
    generation,
  })
  const processAdapter = context.processAdapter || (process.platform === 'win32'
    ? createWindowsJobAdapter({
        controlRoot: boundRecord.paths.processControl,
        providerPrivateOwnershipRoot: path.dirname(activation.activationRoot),
        trustedOwnershipRoots: [path.dirname(activation.activationRoot)],
      })
    : createPosixProcessAdapter())
  const processOwner = new ProcessOwner({
    adapter: processAdapter,
    registryPath: boundRecord.paths.processRegistry,
    controlBinding: {
      activationId: activation.runId,
      generationId: generation,
      ...(generation > 1 ? { predecessorGenerationId: generation - 1 } : {}),
    },
    onOwnershipChange(identities) {
      if (leaseRef) missionLock.updateOwnedProcesses(leaseRef, identities)
    },
  })
  const trustedTestDeclarations = resolveTrustedTestDeclarations(
    context.trustedTestDeclarations || {},
    { repository: targetPath },
  )
  const staleOwnerProbeEvidence = new Map()
  const missionLeaseRoot = path.join(path.dirname(activation.activationRoot), 'mission-locks')
  missionLock = new MissionLock({
    // The exclusion authority must be shared by every activation of this
    // provider.  An activation-local lease root would allow two independent
    // runs against the same physical target.
    leaseRoot: missionLeaseRoot,
    identityProbe(owner) {
      if (owner.hostname !== os.hostname()) {
        return { alive: true, verified: false, reason: 'foreign-host', ownedIdentityEvidence: [] }
      }
      let alive = true
      try { process.kill(owner.pid, 0) } catch (error) { alive = Boolean(error && error.code !== 'ESRCH') }
      const prepared = staleOwnerProbeEvidence.get(owner.checksum)
      const persistedHistory = Array.isArray(owner.ownedProcessHistory) ? owner.ownedProcessHistory : []
      if (persistedHistory.length && (!prepared || prepared.ownerChecksum !== owner.checksum)) {
        return {
          alive: true,
          verified: false,
          reason: 'persisted-owned-identities-not-directly-probed',
          ownedIdentityEvidence: [],
        }
      }
      return {
        alive,
        verified: prepared ? prepared.verified : true,
        ownedIdentityEvidence: prepared ? prepared.ownedIdentityEvidence : [],
      }
    },
  })
  const safeEnvFactory = safeEnvironmentFactory()
  const configIsolationPath = activationRecord.activationBoundary.gitConfig
  const ghConfigDir = activationRecord.activationBoundary.ghConfigDir
  const expectedBranch = context.expectedBranch || safeExpectedBranch(targetPath, environment)
  const safetyOptions = {
    configIsolationPath,
    ghConfigDir,
    expectedBranch,
    enforcementProof: activation.enforcementProof,
  }
  const gitEnvironment = repository => safeEnvFactory(repository || targetPath, environment, safetyOptions).environment
  const roleContract = loadRoleContract()
  const liveRolePolicy = new RolePolicy(roleContract)
  const settings = activationRuntimeSettings(activation, context)
  const nonce = activationRecord.providerAttestation.attestation.activationNonce
  let providerCapabilities = null
  let providerCapabilitiesHash = null

  const exactFileHash = relative => {
    if (!recordRef || typeof recordRef.resolve !== 'function') return null
    const absolute = recordRef.resolve(relative)
    return fs.existsSync(absolute) ? sha256Bytes(fs.readFileSync(absolute)) : null
  }
  const persistedPlanHash = route => {
    const relative = route === 'ROADMAP' ? 'plan/ROADMAP.md'
      : route === 'LIGHT' ? 'plan/light-plan.md'
        : route === 'DIRECT' ? 'plan/success-card.md' : null
    return relative ? exactFileHash(relative) : null
  }
  const journalLease = (saved, threads, roleId = null) => {
    const thread = threads[saved.id] || null
    const binding = saved.crashBinding || null
    return {
      leaseId: saved.id,
      workItemId: saved.workItemId || saved.id,
      roleId: roleId || saved.role,
      status: thread ? 'OPEN' : 'ADMITTED',
      parentLeaseId: saved.parentLeaseId || null,
      reservationId: binding && binding.reservationId || null,
      sessionId: binding && binding.sessionId || saved.sessionId || null,
      continuationId: binding && binding.continuationId || null,
      crashBindingHash: binding && binding.bindingHash || null,
      resources: (saved.resources || []).map(resource => ({
        id: resource.id,
        kind: resource.kind,
        mode: resource.mode,
        isolationId: resource.isolationId || null,
      })),
      usage: schedulerUsageTotal({ reported: saved.reported || {} }),
      reserves: schedulerUsageTotal({ remaining: saved.remainingEstimate || {} }),
      thread: thread
        ? { started: true, startedEventHash: thread.startedEventHash, startedAt: thread.startedAt }
        : { started: false, startedEventHash: null, startedAt: null },
    }
  }
  const persistRecoveryCheckpoint = payload => {
    if (!recoveryCheckpointAuthorityRef || !accountingAuthorityRef || !stateStore || !leaseRef) {
      throw new SupervisorIntegrationError(
        'RECOVERY_CHECKPOINT_CONFIG_INVALID',
        'recovery checkpoint authorities are not initialized',
      )
    }
    const raw = payload.schedulerCheckpoint
    const liveCheckpoint = raw && raw.kind === 'scheduler-crash-checkpoint'
    const drainedCheckpoint = raw && raw.kind === 'scheduler-drained-checkpoint'
    const baseState = liveCheckpoint || drainedCheckpoint ? raw.schedulerState : raw
    if (!baseState || !baseState.runIdentity) {
      throw new SupervisorIntegrationError('RECOVERY_CHECKPOINT_INVALID', 'scheduler checkpoint state is unavailable')
    }
    const persistedState = liveCheckpoint || drainedCheckpoint ? raw : {
      schemaVersion: 1,
      kind: 'scheduler-drained-checkpoint',
      runIdentity: baseState.runIdentity,
      schedulerState: baseState,
    }
    const runtimeState = stateStore.load()
    const threads = payload.threadEvidence || {}
    const leases = liveCheckpoint
      ? (raw.liveRecords || []).map(saved => journalLease(saved, threads))
      : []
    if (liveCheckpoint && raw.rootAccountingRecord) {
      leases.push(journalLease({
        ...raw.rootAccountingRecord,
        workItemId: 'root-route-decision',
        role: 'root-control-l0',
        parentLeaseId: null,
        resources: [],
        remainingEstimate: {},
      }, threads, 'root-control-l0'))
    }
    const candidateHash = runtimeState.candidateHash || null
    const scheduler = prepareSchedulerCheckpoint({
      state: persistedState,
      ownerSessionId: raw.ownerSessionId || `${activation.runId}:control-plane`,
      route: baseState.route,
      phase: runtimeState.state,
      candidate: {
        candidateId: candidateHash ? (payload.candidateId || candidateHash) : null,
        candidateHash,
        frozen: Boolean(candidateHash),
      },
      completedWorkIds: [...new Set(payload.completedWorkIds || [])].sort(),
      completedCheckIds: [...new Set(payload.completedCheckIds || [])].sort(),
      openCheckIds: [...new Set(payload.openCheckIds || [])].sort(),
      nextReadyWorkIds: [...new Set(payload.nextReadyWorkIds || [])].sort(),
      leases,
      usage: schedulerUsageTotal(baseState.usage),
      reserves: schedulerUsageTotal(liveCheckpoint
        ? raw.reserved : baseState.reserved),
    })
    const hinted = payload.recoveryFrontier || {}
    const externalOperations = Array.isArray(payload.externalOperations) ? payload.externalOperations : []
    const unresolvedExternal = externalOperations.filter(operation =>
      ['COMMITTING', 'COMMITTED_UNRECONCILED'].includes(operation.status))
    const externalRecovery = unresolvedExternal.length
      ? {
          status: 'reconciliation-required',
          operationIds: unresolvedExternal.map(operation => operation.operationId).sort(),
          idempotencyKeys: unresolvedExternal.map(operation => operation.idempotencyKey).sort(),
          receiptHashes: [...new Set(unresolvedExternal.flatMap(operation => [
            operation.prepareReceiptHash,
            operation.commitReceiptHash,
            operation.reconcileReceiptHash,
            operation.rollbackReceiptHash,
          ].filter(Boolean)))].sort(),
        }
      : { status: 'none', operationIds: [], idempotencyKeys: [], receiptHashes: [] }
    const acceptedResultIds = [...new Set([
      ...(hinted.acceptedResultIds || []),
      scheduler.stateHash,
    ])].sort()
    const routeDecisionHash = baseState.route === 'PENDING' ? null : exactFileHash('route/decision.json')
    if (baseState.route !== 'PENDING' && !routeDecisionHash) {
      throw new SupervisorIntegrationError(
        'RECOVERY_CHECKPOINT_IMMUTABLE_MISMATCH',
        'decided scheduler state requires its persisted route decision before checkpointing',
      )
    }
    return recoveryCheckpointAuthorityRef.appendCheckpoint({
      capability: leaseRef,
      providerCapabilitiesHash,
      accountingCheckpoint: accountingAuthorityRef.resumeCheckpoint(),
      scheduler,
      recovery: {
        savedState: runtimeState.state,
        resumeState: unresolvedExternal.length
          ? 'CHECK_WORK'
          : recoveryResumeState(runtimeState.state, payload.hasLiveModelSession === true),
        frontier: {
          nextReadyWorkIds: scheduler.nextReadyWorkIds,
          openCheckIds: scheduler.openCheckIds,
          acceptedResultIds,
        },
        completedMilestones: [
          ...recoveryMilestonesForState(runtimeState.state),
          ...(unresolvedExternal.length ? ['external-prepare', 'external-commit'] : []),
        ],
        externalRecovery,
        releaseIntentHash: null,
      },
      immutableHashes: {
        requestEnvelopeHash: runtimeState.requestEnvelopeHash,
        routeDecisionHash,
        planHash: baseState.route === 'PENDING' ? null : persistedPlanHash(baseState.route),
        candidateHash,
      },
      externalOperations,
      humanDescription: payload.humanDescription || payload.cause.humanDescription,
      cause: payload.cause,
    })
  }
  const readDurableResult = workItemId => {
    if (!recordRef) return null
    const absolute = recordRef.resolve(`work/results/${hashText(workItemId)}.json`)
    return fs.existsSync(absolute) ? readRegularJson(absolute, `result ${workItemId}`).parsed : null
  }
  const durableResultMatchesRecoveryReceipt = (workItemId, expectedResult) => {
    if (!recordRef || !pendingCrashResume) return false
    const pointerPath = recordRef.resolve(`work/results/context-${hashText(workItemId)}.json`)
    if (!fs.existsSync(pointerPath)) return false
    const pointer = readRegularJson(pointerPath, 'recovery result continuation pointer').parsed
    if (!pointer || pointer.schemaVersion !== 2 || pointer.workItemId !== workItemId ||
        !/^[a-f0-9]{64}$/u.test(pointer.contentHash || '') ||
        pointer.contentPath !== `runtime/blobs/${pointer.contentHash}`) return false
    const contentPath = recordRef.resolve(pointer.contentPath)
    if (!fs.existsSync(contentPath)) return false
    const saved = readRegularJson(contentPath, 'recovery result continuation blob').parsed
    const { contentHash, ...contentBody } = saved || {}
    if (!saved || contentHash !== pointer.contentHash || contentHash !== hashText(stableStringify(contentBody)) ||
        saved.workItemId !== workItemId || saved.runId !== activation.runId ||
        saved.activationId !== activation.runId ||
        saved.requestEnvelopeHash !== pendingCrashResume.checkpointEvidence.record.checkpoint.immutableHashes.requestEnvelopeHash ||
        saved.missionHash !== missionHash || !/^[a-f0-9]{64}$/u.test(saved.terminalReceiptHash || '') ||
        typeof saved.terminalReceiptPath !== 'string') return false
    const receiptPath = recordRef.resolve(saved.terminalReceiptPath)
    if (!fs.existsSync(receiptPath)) return false
    const receipt = readRegularJson(receiptPath, 'recovery result terminal receipt').parsed
    const { receiptHash, ...receiptBody } = receipt || {}
    const checkpoint = pendingCrashResume.checkpointEvidence.record.checkpoint
    const accepted = new Set(checkpoint.recovery.frontier.acceptedResultIds || [])
    const resultHash = hashText(JSON.stringify(expectedResult))
    return Boolean(receipt && receiptHash === saved.terminalReceiptHash &&
      receiptHash === hashText(JSON.stringify(receiptBody)) && accepted.has(receiptHash) &&
      receipt.workItemId === workItemId && receipt.assignmentHash === saved.assignmentHash &&
      receipt.resultHash === saved.resultHash && receipt.resultHash === resultHash &&
      hashText(JSON.stringify(receipt.result)) === resultHash &&
      stableStringify(receipt.result) === stableStringify(expectedResult))
  }
  const roadmapProjectionReceiptPath = planHash => `plan/projections/${planHash}.json`
  const writeRoadmapProjectionReceipt = (decision, authorResult, plan, authorWorkItemId) => {
    const planSha256 = hashText(plan)
    if (!['roadmap-author', 'roadmap-author-revise', 'roadmap-author-plan-repair'].includes(authorWorkItemId)) {
      throw new SupervisorIntegrationError(
        'ROADMAP_RESULT_MISSING',
        'ROADMAP projection requires the exact durable author work-item identity',
      )
    }
    const sourceResultHash = exactFileHash(`work/results/${hashText(authorWorkItemId)}.json`)
    if (!sourceResultHash) {
      throw new SupervisorIntegrationError('ROADMAP_RESULT_MISSING', 'ROADMAP projection source result is not durable')
    }
    const body = {
      schemaVersion: 1,
      route: 'ROADMAP',
      planSha256,
      decisionHash: hashText(stableStringify(decision)),
      authorWorkItemId,
      sourceResultHash,
      authorResult,
    }
    const receipt = { ...body, receiptHash: hashText(stableStringify(body)) }
    const relative = roadmapProjectionReceiptPath(planSha256)
    const absolute = recordRef.resolve(relative)
    if (fs.existsSync(absolute)) {
      if (stableStringify(readRegularJson(absolute, 'ROADMAP projection receipt').parsed) !== stableStringify(receipt)) {
        throw new SupervisorIntegrationError('CRASH_ADOPTION_CONFLICT', 'ROADMAP projection content address collided')
      }
    } else {
      recordRef.write(relative, `${JSON.stringify(receipt, null, 2)}\n`)
    }
    return receipt
  }
  const validateRoadmapProjectionReceipt = (decision, planSha256) => {
    if (!recordRef || !/^[a-f0-9]{64}$/u.test(planSha256 || '')) return false
    const absolute = recordRef.resolve(roadmapProjectionReceiptPath(planSha256))
    if (!fs.existsSync(absolute)) return false
    const receipt = readRegularJson(absolute, 'ROADMAP projection receipt').parsed
    const { receiptHash, ...body } = receipt || {}
    if (!receipt || receipt.schemaVersion !== 1 || receipt.route !== 'ROADMAP' ||
        receipt.planSha256 !== planSha256 || receiptHash !== hashText(stableStringify(body)) ||
        receipt.decisionHash !== hashText(stableStringify(decision)) ||
        !['roadmap-author', 'roadmap-author-revise', 'roadmap-author-plan-repair'].includes(receipt.authorWorkItemId) ||
        receipt.sourceResultHash !== exactFileHash(`work/results/${hashText(receipt.authorWorkItemId)}.json`)) return false
    const sourceResult = readDurableResult(receipt.authorWorkItemId)
    if (!sourceResult || !durableResultMatchesRecoveryReceipt(receipt.authorWorkItemId, sourceResult)) return false
    let corrections
    try {
      corrections = (receipt.authorResult && receipt.authorResult.scoutCorrections || []).map(saved => {
        const scoutResult = readDurableResult(saved.workItemId)
        const resultHash = exactFileHash(`work/results/${hashText(saved.workItemId)}.json`)
        if (!scoutResult || !resultHash ||
            !durableResultMatchesRecoveryReceipt(saved.workItemId, scoutResult)) {
          throw new Error('scout result missing')
        }
        return scoutCorrection(
          scoutResult,
          saved.namedUnknown,
          saved.workItemId,
          { hash: resultHash },
        )
      })
      const reconstructed = roadmapAuthorArtifact(sourceResult, corrections)
      if (stableStringify(reconstructed) !== stableStringify(receipt.authorResult)) return false
      return hashText(renderPlanArtifact('ROADMAP', decision, reconstructed)) === planSha256
    } catch {
      return false
    }
  }
  const runtimeOptions = {
    activationId: activation.runId,
    activationNonce: nonce,
    baseEnvironment: environment,
    configIsolationPath,
    enforcementProof: activation.enforcementProof,
    entryPrompt: activation.entryPrompt,
    expectedBranch,
    exactPathPreflight: context.exactPathPreflight,
    exactPathTargetEvidence: Object.freeze({
      source: 'authenticated-activation-target',
      targetIdentity: activation.supervisorRuntime.targetIdentity,
      authorizationEvidenceHash: activation.supervisorRuntime.metadataSha256,
      evidenceHashes: Object.freeze([
        activation.activationAttestation.hash,
        activation.supervisorRuntime.metadataSha256,
        activation.record.supervisorRuntimeReceipt && activation.record.supervisorRuntimeReceipt.sha256,
      ].filter(hash => /^[a-f0-9]{64}$/.test(hash || ''))),
    }),
    exactPathProviderCapabilityEvidence: expected => {
      if (!capabilityBinding) {
        throw new SupervisorIntegrationError(
          'EXACT_PATH_PROVIDER_UNSUPPORTED',
          'the authenticated runtime capability receipt is unavailable',
        )
      }
      return capabilityBinding.exactPathEvidence(expected)
    },
    generation,
    generationControlAuthority,
    readResult: readDurableResult,
    verifyDurableResultReceipt(workItemId, result) {
      if (!durableResultMatchesRecoveryReceipt(workItemId, result)) {
        throw new SupervisorIntegrationError(
          'CRASH_ADOPTION_CONFLICT',
          `durable result differs from its committed recovery receipt: ${workItemId}`,
        )
      }
      return true
    },
    ghConfigDir,
    gitEnvironment,
    harnessAttestation(candidateHash, oracle) {
      return {
        repoHash: candidateHash,
        buildHash: hashText(JSON.stringify(activationRecord.contractVersions)),
        oracleHash: hashText(oracle),
      }
    },
    lock: {
      targetPath,
      ledgerPath: activation.supervisorRuntime.runPath,
      processIdentity: processIdentityForPid(process.pid),
    },
    beforeMissionAcquire: async () => {
      if (generation > 1) {
        await processOwner.recoverReservations()
        for (const owned of processOwner.listRecords().filter(item => item.status === 'RUNNING')) {
          const members = await processAdapter.listOwned(owned.groupIdentity)
          if (!members.length && !owned.rootExit) {
            await processOwner.observeRootExit(owned.ownershipId, {
              code: null,
              signal: 'SUPERVISOR_CRASH',
              terminalEnvelope: { status: 'LOST' },
              killMs: 0,
            })
          }
        }
        await processOwner.cancelAll({
          reason: 'crash-generation stale descendant drain',
          graceMs: 0,
          killMs: 2000,
          terminalStatus: 'LOST',
        })
        await processOwner.assertDrained()
        const targetKey = missionLock.identify(targetPath, activation.supervisorRuntime.runPath).key
        await processOwner.assertTargetDrained(targetKey)
      }

      // MissionLock's mutation is intentionally synchronous.  Probe every
      // identity from the already-persisted owner through the concrete adapter
      // before entering that mutation and bind the results to the exact owner
      // checksum.  This works across run records; an empty current registry is
      // never evidence that a prior activation's descendants drained.
      const leasePath = missionLock.leasePathFor(targetPath, activation.supervisorRuntime.runPath)
      const ownerPath = path.join(leasePath, 'owner.json')
      if (!fs.existsSync(ownerPath)) return
      let owner
      try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) } catch { return }
      if (!owner || typeof owner.checksum !== 'string' || !Array.isArray(owner.ownedProcessHistory)) return
      let ownedIdentityEvidence = []
      let verified = true
      try {
        // ProcessOwner delegates to the adapter's origin-bound identity probe.
        // In particular, Windows reservation identities encode their original
        // control root; recoverReservation(reservationId) is intentionally not
        // used here because it resolves only beneath the current run root.
        ownedIdentityEvidence = await processOwner.probeOwnedIdentities(owner.ownedProcessHistory)
      } catch (error) {
        verified = false
        ownedIdentityEvidence = owner.ownedProcessHistory.map(identity => ({
          kind: identity.kind,
          id: identity.id,
          verified: false,
          alive: true,
          adapterEvidenceHash: hashText(JSON.stringify({
            adapterKind: processAdapter.kind,
            identity,
            error: error && error.message ? error.message : String(error),
          })),
        }))
      }
      staleOwnerProbeEvidence.set(owner.checksum, {
        ownerChecksum: owner.checksum,
        verified,
        ownedIdentityEvidence,
      })
    },
    mission: activationRecord.request.canonicalJson,
    missionHash,
    missionLock,
    modelRegistry: activation.modelRegistry || [],
    monotonicNow: context.monotonicNow,
    processOwner,
    processControlEnvironmentFactory: (reservationId, baseEnvironment) =>
      prepareProcessLaunchEnvironment(processAdapter, reservationId, baseEnvironment),
    providerCapabilities,
    recordFactory: async ({ activation: runtimeActivation, lease }) => {
      leaseRef = lease
      const record = boundRecord
      recordRef = record
      if (!fs.existsSync(path.join(record.runPath, 'request', 'envelope.jsonl'))) {
        record.initializeRequest([{ content: activationRecord.request.canonicalJson }], {
          exactInvocation: { schemaVersion: 1, argv: activation.requestArgv },
          parsedControls: settings,
          canonicalRequest: JSON.parse(activationRecord.request.canonicalJson),
        })
      }
      if (!fs.existsSync(path.join(record.runPath, 'settings.json'))) {
        record.write('settings.json', `${JSON.stringify(resolveSettings(settings), null, 2)}\n`)
      }
      cleanupRegistry = new CleanupRegistry({
        ...record.paths.cleanupRegistry,
        allowedRoots: [activation.activationRoot],
        controlBinding: {
          activationId: activation.runId,
          generationId: generation,
          ...(generation > 1 ? { predecessorGenerationId: generation - 1 } : {}),
        },
      })
      const request = record.loadRequest()
      const leaseBinding = missionLock.verifyCapability(lease)
      const openedDirectoryIdentity = hashText(JSON.stringify(record.runBinding))
      const digests = {
        contract: hashText(JSON.stringify(activationRecord.contractVersions)),
        prompt: activationRecord.supervisorEntry.promptSha256,
        provider: activation.activationAttestation.hash,
        tool: activationRecord.activationBoundary.supervisorAdapterSha256,
      }
      const binding = {
        runId: record.runId,
        requestEnvelopeHash: request.digest,
        targetIdentity: leaseBinding.targetIdentity,
        openedDirectoryIdentity,
        digests,
      }
      const eventLog = new EventLog({ ...record.paths.eventLog, binding })
      stateStore = new RuntimeStateStore({
        ...record.paths.stateStore,
        eventLog,
        capabilityVerifier: capability => missionLock.verifyCapability(capability),
        accountingCheckpointVerifier: checkpoint => {
          if (!accountingAuthorityRef) {
            throw new SupervisorIntegrationError('ACCOUNTING_CONFIG_INVALID', 'accounting authority is not ready')
          }
          return accountingAuthorityRef.verifyResumeCheckpoint(checkpoint)
        },
        recoveryCheckpointVerifier: checkpoint => {
          if (!recoveryCheckpointAuthorityRef) {
            throw new SupervisorIntegrationError('RECOVERY_CHECKPOINT_CONFIG_INVALID', 'recovery checkpoint authority is not ready')
          }
          return recoveryCheckpointAuthorityRef.verifyResumeCheckpoint(checkpoint)
        },
        pausedRecoveryCheckpointVerifier: checkpoint => {
          if (!recoveryCheckpointAuthorityRef) {
            throw new SupervisorIntegrationError('RECOVERY_CHECKPOINT_CONFIG_INVALID', 'paused recovery checkpoint authority is not ready')
          }
          return recoveryCheckpointAuthorityRef.verifyPausedResumeCheckpoint(checkpoint)
        },
      })
      let budget = runtimeOptions.budgetController
      if (!fs.existsSync(record.paths.stateStore.paths.statePath)) {
        stateStore.create({
          ...binding,
          activation: { ...runtimeActivation, sessionToken: activationRecord.capability.parentSession },
          capability: lease,
          budgets: budget.snapshot(),
        })
        for (const [eventId, nextState] of [
          ['BOOTSTRAP', 'LOAD_SKILL'],
          ['SKILL_LOADED', 'STORE_REQUEST_ENVELOPE'],
          ['REQUEST_ENVELOPE_STORED', 'RESOLVE_SETTINGS'],
          ['SETTINGS_RESOLVED', 'ACQUIRE_TARGET_LOCK'],
          ['TARGET_LOCK_ACQUIRED', 'SELECT_SAFE_RUN_ROOT'],
          ['RUN_ROOT_SELECTED', 'CREATE_RUN_RECORD'],
          ['RUN_RECORD_CREATED', 'CHECK_PROVIDER_CAPABILITIES'],
        ]) {
          stateStore.transition(nextState, { capability: lease, cause: 'deterministic supervisor bootstrap', eventId })
        }
      }
      let openedRuntimeState = stateStore.load()
      if (openedRuntimeState.state === 'RELEASING_LOCK') {
        if (generation !== openedRuntimeState.activation.generation + 1) {
          throw new SupervisorIntegrationError(
            'GENERATION_CONFLICT',
            'release reconciliation requires exactly the next activation generation',
            { runtimeGeneration: openedRuntimeState.activation.generation, activationGeneration: generation },
          )
        }
        const releaseEvidence = stateStore.prepareReleaseReconciliation()
        openedRuntimeState = stateStore.adoptReleaseReconciliation({
          capability: lease,
          expectedGeneration: generation - 1,
          evidence: releaseEvidence,
        })
        runtimeOptions.releaseReconciliation = {
          outcome: releaseEvidence.outcome,
          route: null,
          deliverables: openedRuntimeState.terminal && openedRuntimeState.terminal.deliverableManifest || [],
          checkHashes: [],
          terminalEnvelope: openedRuntimeState.terminal && openedRuntimeState.terminal.terminalEnvelope || null,
          evidence: releaseEvidence,
        }
      }
      if (generation > 1) {
        const savedBudget = openedRuntimeState.budgets
        if (!savedBudget || !savedBudget.limits) {
          throw new SupervisorIntegrationError('BUDGET_RESUME_REQUIRED', 'crash resume lacks the canonical persisted budget snapshot')
        }
        budget = restoreBudgetController(savedBudget, {
          monotonicMs: context.monotonicNow,
          wallNowMs: context.wallNowMs,
          wallClock: context.clock,
          bootId: context.bootId,
          wallTimeUnbounded,
        })
        runtimeOptions.previousBudgetSnapshot = budget.snapshot()
        runtimeOptions.budgetController = budget
      }
      const accountingAuthority = new AccountingAuthority({
        paths: record.paths.accounting,
        eventLog: stateStore.eventLog,
        stateProvider: () => stateStore.load(),
        capabilityVerifier: capability => missionLock.verifyCapability(capability),
        budgetController: budget,
        additionalCeilings: {
          retries: clampNonNegInt(context.retryLimit, 128) || 128,
          costMicrounits: clampNonNegInt(context.costMicrounitLimit, Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER,
        },
        monotonicMs: context.monotonicNow,
        wallNowMs: context.wallNowMs,
        clock: context.clock,
        bootId: context.bootId,
      })
      accountingAuthorityRef = accountingAuthority
      let replayedAccounting = accountingAuthority.replay()
      if (replayedAccounting.recoveryRequired) {
        accountingAuthority.checkpoint({
          capability: lease,
          cause: {
            kind: 'RECOVERY',
            causeId: `accounting:${generation}`,
            humanDescription: 'Rebuild the checksummed budget snapshot from the intact accounting hash chain.',
          },
          delta: accountingDelta(),
        })
        replayedAccounting = accountingAuthority.replay()
      } else if (!replayedAccounting.records.length) {
        accountingAuthority.checkpoint({
          capability: lease,
          cause: {
            kind: 'CHECKPOINT',
            causeId: `accounting-initial:${generation}`,
            humanDescription: 'Create the initial zero-delta accounting authority before any recovery point is exposed.',
          },
          delta: accountingDelta(),
        })
        replayedAccounting = accountingAuthority.replay()
      }
      if (generation > 1) {
        const persisted = stateStore.load()
        const lastAccountingRecord = replayedAccounting.records.at(-1)
        const authoritativeBudgetGeneration = lastAccountingRecord && lastAccountingRecord.generation
        if (!Number.isSafeInteger(authoritativeBudgetGeneration) || authoritativeBudgetGeneration !== generation - 1) {
          throw new SupervisorIntegrationError(
            'BUDGET_RESET_DETECTED',
            'durable accounting does not bind the exact predecessor budget generation',
            {
              expected: generation - 1,
              accountingGeneration: authoritativeBudgetGeneration === undefined ? null : authoritativeBudgetGeneration,
              stateBudgetGeneration: persisted.budgets && persisted.budgets.generation,
            },
          )
        }
        const hydratedSnapshot = hydrateBudgetSnapshot(
          persisted.budgets,
          replayedAccounting.cumulative,
          authoritativeBudgetGeneration,
        )
        budget = restoreBudgetController(hydratedSnapshot, {
          monotonicMs: context.monotonicNow,
          wallNowMs: context.wallNowMs,
          wallClock: context.clock,
          bootId: context.bootId,
          wallTimeUnbounded,
        })
        runtimeOptions.previousBudgetSnapshot = hydratedSnapshot
        runtimeOptions.budgetController = budget
      } else {
        const budgetSnapshot = budget.snapshot()
        const replayedTokens = Object.values(replayedAccounting.cumulative.tokenUsage).reduce((sum, value) => sum + value, 0)
        if (budgetSnapshot.launches < replayedAccounting.cumulative.launches ||
            budgetSnapshot.sessionsStarted < replayedAccounting.cumulative.sessions ||
            budgetSnapshot.tokensUsed < replayedTokens ||
            budgetSnapshot.consumedWallMs < replayedAccounting.cumulative.elapsedMilliseconds) {
          throw new SupervisorIntegrationError(
            'BUDGET_RESET_DETECTED',
            'the in-memory controller cannot start behind the durable accounting authority',
            { budgetSnapshot, accounting: replayedAccounting.cumulative },
          )
        }
      }
      runtimeOptions.accountingAuthority = accountingAuthority
      const resultCommitVerifier = (binding, verifierContext) => {
        const candidatePaths = [
          record.resolve(`work/results/terminal-receipt-${hashText(`${binding.leaseId}\0${binding.assignmentId}`)}.json`),
          record.resolve(`work/results/terminal-receipt-${hashText(`${binding.leaseId}\0root-route-decision-attempt-0`)}.json`),
          record.resolve(`work/results/terminal-receipt-${hashText(`${binding.leaseId}\0root-route-decision-attempt-1`)}.json`),
        ]
        const matches = []
        for (const candidate of [...new Set(candidatePaths)]) {
          if (!fs.existsSync(candidate)) continue
          const receipt = readRegularJson(candidate, 'committed model terminal receipt').parsed
          const { receiptHash, ...body } = receipt || {}
          if (receiptHash !== binding.receiptHash) continue
          const receiptGenerationAccepted = receipt &&
            (receipt.admittedGeneration === verifierContext.generation ||
             (verifierContext.allowPredecessorGeneration === true &&
              receipt.admittedGeneration + 1 === verifierContext.generation))
          if (!receipt || receipt.schemaVersion !== 1 || receiptHash !== hashText(JSON.stringify(body)) ||
              receipt.runId !== verifierContext.runId || receipt.activationId !== verifierContext.activationId ||
              !receiptGenerationAccepted ||
              receipt.assignmentId !== binding.assignmentId || receipt.assignmentHash !== binding.assignmentHash ||
              receipt.leaseId !== binding.leaseId || receipt.sessionId !== binding.sessionId ||
              receipt.continuationId !== binding.continuationId || receipt.resultHash !== binding.resultHash ||
              receipt.candidateHash !== binding.candidateHash) {
            throw new SupervisorIntegrationError(
              'RECOVERY_CHECKPOINT_RESULT_UNVERIFIED',
              'terminal receipt differs from its RESULT_COMMITTED checkpoint binding',
            )
          }
          const persistedResult = Object.hasOwn(receipt, 'result') ? receipt.result : receipt.submitted
          if (receipt.resultHash !== hashText(JSON.stringify(persistedResult))) {
            throw new SupervisorIntegrationError(
              'RECOVERY_CHECKPOINT_RESULT_UNVERIFIED',
              'terminal receipt result bytes do not match the committed result hash',
            )
          }
          matches.push(receipt)
        }
        if (matches.length !== 1) {
          throw new SupervisorIntegrationError(
            'RECOVERY_CHECKPOINT_RESULT_UNVERIFIED',
            'RESULT_COMMITTED must resolve exactly one deterministic terminal receipt',
            { matches: matches.length },
          )
        }
        const receipt = matches[0]
        return {
          runId: receipt.runId,
          activationId: receipt.activationId,
          generation: receipt.admittedGeneration,
          assignmentId: receipt.assignmentId,
          assignmentHash: receipt.assignmentHash,
          leaseId: receipt.leaseId,
          sessionId: receipt.sessionId,
          continuationId: receipt.continuationId,
          resultHash: receipt.resultHash,
          receiptHash: receipt.receiptHash,
          candidateHash: receipt.candidateHash,
        }
      }
      recoveryCheckpointAuthorityRef = new RecoveryCheckpointAuthority({
        paths: record.paths.recoveryCheckpoints,
        eventLog: stateStore.eventLog,
        stateProvider: () => stateStore.load(),
        capabilityVerifier: capability => missionLock.verifyCapability(capability),
        accountingCheckpointVerifier: evidence => accountingAuthority.verifyResumeCheckpoint(evidence),
        accountingCheckpointProvider: () => accountingAuthority.resumeCheckpoint(),
        resultCommitVerifier,
        clock: context.clock,
      })
      runtimeOptions.recoveryCheckpointAuthority = recoveryCheckpointAuthorityRef
      runtimeOptions.persistRecoveryCheckpoint = persistRecoveryCheckpoint
      runtimeOptions.preparePausedRelease = () => stateStore.preparePausedRelease()
      if (generation > 1 && !runtimeOptions.releaseReconciliation) {
        const predecessorState = stateStore.load()
        if (['DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED'].includes(predecessorState.state)) {
          throw new SupervisorIntegrationError(
            'RESUME_AFTER_TERMINAL',
            `terminal runtime state ${predecessorState.state} cannot be resumed`,
          )
        }
        recoveryCheckpointAuthorityRef.recoverCrashTail({ capability: lease, truncateIncompleteTail: true })
        const priorEvidence = predecessorState.state === 'PAUSED'
          ? recoveryCheckpointAuthorityRef.resumePausedCheckpoint()
          : recoveryCheckpointAuthorityRef.resumeCheckpoint()
        const adopted = predecessorState.state === 'PAUSED'
          ? stateStore.resumePausedGeneration({
              capability: lease,
              expectedGeneration: generation - 1,
              recoveryCheckpoint: priorEvidence,
              expectedCheckpointPayloadHash: priorEvidence.record.checkpointPayloadHash,
              cause: 'Resume the exact clean post-drain pause after validating its release and checkpoint receipts.',
            })
          : stateStore.adoptCrashedGeneration({
              capability: lease,
              expectedGeneration: generation - 1,
              expectedSavedState: predecessorState.state,
              precondition: runtimeCrashPrecondition(predecessorState),
              recoveryCheckpoint: priorEvidence,
              expectedCheckpointPayloadHash: priorEvidence.record.checkpointPayloadHash,
              cause: 'Adopt the exact durable crash continuation after proving the old owner and descendants are drained.',
            })
        accountingAuthority.checkpoint({
          capability: lease,
          cause: {
            kind: 'RECOVERY',
            causeId: `accounting-crash-adoption:${generation}`,
            humanDescription: 'Advance durable accounting to the adopted generation without resetting cumulative usage.',
          },
          delta: accountingDelta(),
        })
        if (predecessorState.state !== 'PAUSED') {
          stateStore.resumeGeneration({
            capability: lease,
            expectedGeneration: generation,
            cause: 'Enter provider capability revalidation for the adopted generation.',
          })
        }
        pendingCrashResume = {
          adoptedRecoveryContext: adopted.frontier,
          checkpointEvidence: priorEvidence,
          decodedScheduler: decodeSchedulerCheckpoint(priorEvidence.record.checkpoint.scheduler),
          transitionAhead: predecessorState.sequence ===
            priorEvidence.record.checkpoint.stateEvent.sequence + 1,
          cleanPause: predecessorState.state === 'PAUSED',
        }
        const openModelSessions = priorEvidence.record.checkpoint.scheduler.leases
          .filter(item => item.status === 'OPEN')
        if (pendingCrashResume.cleanPause && openModelSessions.length) {
          throw new SupervisorIntegrationError(
            'PAUSE_DRAIN_CHECKPOINT_REQUIRED',
            'clean PAUSED recovery checkpoint still contains an open model session',
          )
        }
        if (openModelSessions.length) {
          const resumeBudgetSnapshot = budget.snapshot()
          for (const open of openModelSessions) {
            const sessionId = open.roleId === 'root-control-l0'
              ? `${activation.runId}:root-route-decision`
              : open.sessionId
            if (!resumeBudgetSnapshot.sessions[sessionId]) {
              resumeBudgetSnapshot.sessions[sessionId] = {
                activationId: activation.runId,
                generation: generation - 1,
                parentSessionId: open.caller && open.caller.sessionId || activationRecord.capability.parentSession,
                startedAt: resumeBudgetSnapshot.checkpointAt,
                startedAtElapsedMs: resumeBudgetSnapshot.consumedWallMs,
                status: 'RUNNING',
                endedAt: null,
                evidenceHashes: [],
              }
            }
          }
          budget = restoreBudgetController(resumeBudgetSnapshot, {
            monotonicMs: context.monotonicNow,
            wallNowMs: context.wallNowMs,
            wallClock: context.clock,
            bootId: context.bootId,
            wallTimeUnbounded,
          })
          runtimeOptions.previousBudgetSnapshot = budget.snapshot()
          runtimeOptions.budgetController = budget
        }
        const decodedBase = ['scheduler-crash-checkpoint', 'scheduler-drained-checkpoint']
          .includes(pendingCrashResume.decodedScheduler.kind)
          ? pendingCrashResume.decodedScheduler.schedulerState
          : pendingCrashResume.decodedScheduler
        currentRoute = decodedBase.route === 'PENDING' ? null : decodedBase.route
      }
      const processProbeReservation = crypto.randomUUID()
      const processProbeBaseEnvironment = prepareProcessLaunchEnvironment(
        processAdapter,
        processProbeReservation,
        environment,
      )
      const initialSafety = safeEnvFactory(targetPath, processProbeBaseEnvironment, safetyOptions)
      const processAdmission = await processAdapter.admit()
      if (!processAdmission || processAdmission.supported !== true) {
        throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'owned process-group admission failed', { processAdmission })
      }
      const targetKey = missionLock.verifyCapability(lease).targetIdentity
      const processProbe = await processOwner.launch({
        executable: process.execPath,
        argv: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: targetPath,
        env: initialSafety.environment,
        shell: false,
        sessionId: `${activation.runId}:process-probe`,
        reservationId: processProbeReservation,
        targetKey,
        forWork: false,
      })
      await processOwner.cancelGroup(processProbe.ownershipId, {
        reason: 'runtime ownership probe',
        graceMs: 0,
        killMs: 1000,
        terminalStatus: 'DONE',
      })
      await processOwner.assertTargetDrained(targetKey)
      const snapshotRoot = path.join(activation.activationRoot, 'checker-snapshots')
      runtimeOptions.checkerSnapshotFactory = createCheckerSnapshotFactory({
        targetPath,
        snapshotRoot,
        runId: activation.runId,
        generation,
        cleanupRegistry,
        gitEnvironment,
        expectedBranch,
        enforcementProofPath: activationRecord.activationBoundary.enforcementProof.path,
        repairEnvironment: environment,
        safetyScriptPath: path.resolve(__dirname, '..', '..', '..', 'scripts', 'local-only-safety.cjs'),
      })
      runtimeOptions.checkerScratchFactory = createCheckerScratchFactory({
        scratchRoot: path.join(activation.activationRoot, 'checker-scratch'),
        cleanupRegistry,
        runId: activation.runId,
        targetPath,
      })
      runtimeOptions.validateCheckerSnapshot = candidate => {
        const resolved = path.resolve(candidate)
        const root = fs.realpathSync.native(snapshotRoot)
        const real = fs.realpathSync.native(resolved)
        const relative = path.relative(root, real)
        const item = fs.lstatSync(real)
        const registered = cleanupRegistry.load().entries.some(entry =>
          entry.status === 'REGISTERED' && entry.kind === 'checker-snapshot' && path.resolve(entry.path) === real)
        if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) ||
            !item.isDirectory() || item.isSymbolicLink() || !registered) {
          throw new SupervisorIntegrationError(
            'CRASH_ADOPTION_CONFLICT',
            'adopted checker snapshot is not the exact registered activation-private directory',
          )
        }
        return real
      }
      const probeSnapshot = runtimeOptions.checkerSnapshotFactory('runtime-capability-probe')
      const snapshotEvidenceHash = hashWorkspaceCandidate(probeSnapshot, gitEnvironment(probeSnapshot))
      const topologyProbe = new CentralScheduler({
        route: 'ROADMAP',
        runIdentity: { runId: activation.runId, generation },
        rootContextId: `${activation.runId}:topology-probe`,
      })
      const topologyProbeState = topologyProbe.exportState()
      const topologyEvidenceHash = hashText(stableStringify(topologyProbeState))
      topologyProbe.dispose('runtime topology capability probe complete')
      providerCapabilities = validateProviderCapabilities({
        eventStreaming: probe.eventStreaming !== false,
        toolOutputCapture: probe.toolOutputCapture !== false,
        stableChildIdentity: Boolean(processProbe.groupIdentity),
        sameContextContinuation: probe.sameContextContinuation !== false,
        isolatedChecking: /^[a-f0-9]{64}$/.test(snapshotEvidenceHash),
        cancellation: processOwner.listRecords().every(record => record.status !== 'RUNNING'),
      })
      providerCapabilitiesHash = hashText(stableStringify(providerCapabilities))
      runtimeOptions.providerCapabilities = providerCapabilities
      runtimeOptions.runtimeInstance.providerCapabilities = providerCapabilities
      capabilityBinding = createRuntimeCapabilityBinding({
        activation,
        probe,
        processAdmission: { ...processAdmission, processProbe: processProbe.groupIdentity },
        providerCapabilities: runtimeOptions.providerCapabilities,
        controlCapabilities: [
          ...(processAdmission.supported === true && processProbe.groupIdentity ? ['processOwnership'] : []),
          ...(topologyProbeState.route === 'ROADMAP' && topologyProbeState.settings.route === 'ROADMAP'
            ? ['topologyEnforcement'] : []),
        ],
        controlEvidenceHashes: [topologyEvidenceHash],
        safetyAttestation: initialSafety.attestation,
        snapshotEvidenceHash,
        targetIdentity: activation.supervisorRuntime.targetIdentity,
        now: Date.now,
        environment,
        routeProvider: () => currentRoute,
      })
      const receiptBytes = Buffer.from(`${JSON.stringify(capabilityBinding.receipt)}\n`, 'utf8')
      record.write(`runtime/blobs/${sha256Bytes(receiptBytes)}`, receiptBytes)
      const runner = new OwnedCodexProxyRunner({
        processOwner,
        controlRoot: record.paths.processControl,
        targetKey,
        activationId: activation.runId,
        generationId: generation,
      })
      trustedTestRunner = runner
      codexAdapter = new CodexExecAdapter({
        runner,
        executable: probe.executable,
        executableArgs: context.executableArgs,
        environmentOverlay: probe.environmentOverlay,
        targetPath,
        profilePath: activation.profilePath,
        checkerProfilePath: activation.checkerProfilePath,
        outputSchemaResolver: launch => outputSchemaForRole(roleContract, launch),
        providerSchemaRoot: path.join(activation.activationRoot, 'provider-output-schemas'),
        checkerScratchVerifier: runtimeOptions.checkerScratchFactory.verify,
      })
      if (pendingCrashResume) {
        stateStore.acceptResumeCapabilities({
          capability: lease,
          cause: 'Accept the freshly probed compound activation and runtime capability receipts.',
        })
        const restored = stateStore.restoreExactState({
          capability: lease,
          cause: 'Restore the exact saved runtime state and scheduler next ready work without relaunching completed work.',
        })
        const checkpoint = pendingCrashResume.checkpointEvidence.record.checkpoint
        const decoded = pendingCrashResume.decodedScheduler
        const restoredFrontier = pendingCrashResume.adoptedRecoveryContext.frontier
        const restoredCandidateHash = restored.candidateHash || null
        const savedScheduler = ['scheduler-crash-checkpoint', 'scheduler-drained-checkpoint'].includes(decoded.kind)
          ? decoded.schedulerState : decoded
        const recommendationPath = record.resolve('route/recommendation.json')
        const decisionPath = record.resolve('route/decision.json')
        const recommendation = fs.existsSync(recommendationPath)
          ? readRegularJson(recommendationPath, 'saved route recommendation').parsed : null
        const decision = fs.existsSync(decisionPath)
          ? readRegularJson(decisionPath, 'saved route decision').parsed : null
        if (savedScheduler.route === 'PENDING' &&
            ['SAVE_ROUTE_ANALYSIS', 'L0_ROUTE_DECISION'].includes(restored.state) && !recommendation) {
          throw new SupervisorIntegrationError(
            'RESUME_STATE_INVALID',
            `${restored.state} resume lacks the exact saved recommendation`,
          )
        }
        if (savedScheduler.route !== 'PENDING') {
          const validation = validateRouteDecision(decision)
          const decisionHash = decision && sha256Bytes(fs.readFileSync(decisionPath))
          if (!validation.valid || decisionHash !== checkpoint.immutableHashes.routeDecisionHash) {
            throw new SupervisorIntegrationError(
              'RESUME_STATE_INVALID',
              'saved route decision is invalid or differs from the recovery checkpoint',
              { errors: validation.errors },
            )
          }
          const planHash = persistedPlanHash(savedScheduler.route)
          if (!resumePlanProjectionAccepted(
            savedScheduler.route,
            planHash,
            checkpoint.immutableHashes.planHash,
            currentPlanHash => validateRoadmapProjectionReceipt(decision, currentPlanHash),
          )) {
            throw new SupervisorIntegrationError('RESUME_STATE_INVALID', 'saved plan differs from the recovery checkpoint')
          }
        }
        const hasOpenAnalyst = decoded.kind === 'scheduler-crash-checkpoint' &&
          decoded.liveRecords.some(saved => saved.logicalRole === 'route-analyst')
        const resumeStage = hasOpenAnalyst
          ? 'RESUME_ANALYST'
          : restored.state === 'START_ROUTE_ANALYST' ? 'RESTART_ANALYST'
          : restored.state === 'SAVE_ROUTE_ANALYSIS'
            ? 'AFTER_ANALYST_SAVING'
            : restored.state === 'L0_ROUTE_DECISION' ? 'AFTER_ANALYST' : 'AFTER_DECISION'
        runtimeOptions.resumeState = {
          canonicalCrashAdopted: true,
          stage: resumeStage,
          resumeState: restored.state,
          retryState: restored.retryState || {},
          recommendation,
          decision,
          schedulerState: savedScheduler,
          schedulerCrashCheckpoint: decoded.kind === 'scheduler-crash-checkpoint' ? decoded : null,
          adoptedRecords: decoded.kind === 'scheduler-crash-checkpoint'
            ? decoded.liveRecords.map(saved => {
                const journal = checkpoint.scheduler.leases.find(item => item.leaseId === saved.id)
                return {
                  ...saved,
                  resources: journal && journal.resources && journal.resources.length
                    ? journal.resources
                    : saved.resources,
                }
              })
            : [],
          openLeaseIds: checkpoint.scheduler.leases
            .filter(item => item.status === 'OPEN')
            .map(item => item.leaseId),
          recoveryContext: pendingCrashResume.adoptedRecoveryContext,
          candidateHash: restoredCandidateHash,
          planHash: checkpoint.immutableHashes.planHash,
          completedWorkIds: checkpoint.scheduler.completedWorkIds,
          completedCheckIds: checkpoint.scheduler.completedCheckIds,
          acceptedResultIds: restoredFrontier.acceptedResultIds,
          openCheckIds: restoredFrontier.openCheckIds,
          nextReadyWorkIds: restoredFrontier.nextReadyWorkIds,
          externalOperations: checkpoint.externalOperations,
          threadEvidence: Object.fromEntries(checkpoint.scheduler.leases
            .filter(item => item.thread.started)
            .map(item => [item.leaseId, {
              startedEventHash: item.thread.startedEventHash,
              startedAt: item.thread.startedAt,
            }])),
        }
        persistRecoveryCheckpoint({
          cause: {
            kind: 'CRASH_RECOVERY',
            causeId: `crash-restored:${generation}`,
            humanDescription: 'Persist the restored exact state against current-generation accounting before execution resumes.',
          },
          schedulerCheckpoint: decoded,
          route: checkpoint.scheduler.route,
          hasLiveModelSession: checkpoint.scheduler.leases.some(item => item.status === 'OPEN'),
          candidateHash: restoredCandidateHash,
          candidateId: checkpoint.scheduler.candidate.candidateId,
          completedWorkIds: checkpoint.scheduler.completedWorkIds,
          completedCheckIds: checkpoint.scheduler.completedCheckIds,
          nextReadyWorkIds: restoredFrontier.nextReadyWorkIds,
          openCheckIds: restoredFrontier.openCheckIds,
          recoveryFrontier: restoredFrontier,
          externalOperations: checkpoint.externalOperations,
          threadEvidence: Object.fromEntries(checkpoint.scheduler.leases
            .filter(item => item.thread.started)
            .map(item => [item.leaseId, {
              startedEventHash: item.thread.startedEventHash,
              startedAt: item.thread.startedAt,
            }])),
          humanDescription: 'Persist the restored exact state against current-generation accounting before execution resumes.',
        })
      }
      return record
    },
    requestPointerFactory: async record => {
      const loaded = record.loadRequest()
      const requestPath = path.join(record.paths.request, 'envelope.jsonl')
      return Object.freeze({
        kind: 'request-envelope', path: requestPath, hash: loaded.digest,
        bytes: fs.statSync(requestPath).size, encoding: 'utf8',
      })
    },
    finalizerFactory: async ({ lease, record }) => new Finalizer({
      stateStore,
      processOwner,
      missionLock,
      capability: lease,
      cleanupRegistry,
      completionBoundary: () => record.assertBoundary({ phase: 'completion' }),
    }),
    capabilityVerifier: async launch => {
      if (!capabilityBinding) throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'runtime capability probes have not completed')
      return capabilityBinding.verify(launch)
    },
    safeDegradationEvaluator: evaluateSafeTransportDegradation,
    launcher: async launch => {
      if (!codexAdapter) throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'Codex external adapter is not initialized')
      return launchCodexChildWithCheckerReassessment(codexAdapter, launch, activation.runId)
    },
    l0ViaScheduler: false,
    decideRoute: async ({
      analysis,
      correctionAttempts,
      requestPointer,
      continuationId,
      onLaunchPrepared,
      onSessionIdentified,
      onUsageDelta,
      onTerminalResult,
    }) => {
      if (!codexAdapter || !capabilityBinding || !recordRef) {
        throw new SupervisorIntegrationError('PROVIDER_UNSUPPORTED', 'root L0 transport is not initialized')
      }
      const reservationId = crypto.randomUUID()
      const launchBaseEnvironment = prepareProcessLaunchEnvironment(processAdapter, reservationId, environment)
      const safetyBoundary = ensureSafeEnvironment(safeEnvFactory(targetPath, launchBaseEnvironment, safetyOptions))
      const assignment = readPrivateAgentAssignment(activation, 'ap-run-owner', 'run-owner')
      const verification = capabilityBinding.verify({
        child: { logicalRole: 'run-owner' },
        runId: activation.runId,
        generation,
        assignmentId: 'root-route-decision',
        assignmentHash: hashText(stableStringify(assignment)),
      })
      const dispatch = buildContextFreeBrief({
        role: 'ap-run-owner',
        purpose: 'planning',
        assignment: correctionAttempts > 0
          ? 'Correct the invalid L0 route decision once, using the validator findings and the saved analyst evidence.'
          : 'Make the authoritative L0 DIRECT, LIGHT, or ROADMAP decision from the exact request and saved analyst evidence.',
        successChecklist: ['Return the complete canonical route-decision v2 schema within four minutes.'],
        checks: ['Compare the decision to the saved recommendation and canonical route facts.'],
        requestPointer,
        evidencePointers: analysis && analysis.evidencePointers || [],
        providerCapabilities: runtimeOptions.providerCapabilities,
        route: 'PENDING',
        forkTurns: 'none',
      })
      const audit = auditDispatch(dispatch)
      if (!audit.conformant || dispatch.fork_turns !== 'none') {
        throw new SupervisorIntegrationError('CONTEXT_POLICY_DENIED', 'root L0 dispatch violates the context policy', audit)
      }
      const sessionId = `${activation.runId}:root-route-decision:${reservationId}`
      if (typeof onLaunchPrepared === 'function') {
        onLaunchPrepared({ reservationId, sessionId, continuationId: continuationId || null })
      }
      const result = await codexAdapter.launch({
        logicalRole: 'run-owner',
        physicalRole: roleContract.orchestratorContract.physicalId,
        providerRole: 'ap-run-owner',
        physicalExecutionPolicy: liveRolePolicy.bindRootRunOwner(),
        route: 'PRE_ROUTE',
        entryPrompt: activation.entryPrompt,
        dispatch,
        environment: safetyBoundary.environment,
        safetyAttestation: safetyBoundary.attestation,
        workingDirectory: targetPath,
        assignment,
        profileLimits: { route: null, status: 'ROUTE_PENDING', maxDepth: 1, maxConcurrentThreads: 1 },
        sessionId,
        reservationId,
        continuationId: continuationId || null,
        capabilityVerification: verification,
        onSessionIdentified: (identified, evidence) => {
          if (typeof onSessionIdentified === 'function') {
            onSessionIdentified(identified, { ...evidence, reservationId, sessionId })
          }
        },
        onUsageDelta,
        onTerminalResult: typeof onTerminalResult === 'function'
          ? (terminalResult, evidence) => onTerminalResult(terminalResult, {
              ...evidence,
              controlSessionId: sessionId,
              assignmentHash: hashText(stableStringify(dispatch)),
            })
          : null,
      })
      const {
        candidateHash: _candidateHash,
        completionRequested: _completionRequested,
        contextId: _contextId,
        events: _events,
        evidenceHashes: _evidenceHashes,
        recommendation: _recommendation,
        usage,
        usageStreamed,
        ...decision
      } = result
      return {
        decision: result.decision || decision,
        submittedAtMs: Date.now(),
        usage,
        usageStreamed: usageStreamed === true,
      }
    },
    assignmentResolver: ({ providerRole, logicalRole }) =>
      readPrivateAgentAssignment(activation, providerRole, logicalRole),
    profileUpdater: async ({ route, settings: resolved }) => {
      currentRoute = route
      return deriveProfileLimits({
        route,
        maxSubs: resolved.concurrency.effectiveMaxSubs,
        userLiveCeiling: context.userLiveCeiling,
      })
    },
    planPreparer: async ({ route, decision, record }) => {
      if (route === 'ROADMAP') return null
      const relative = route === 'LIGHT' ? 'plan/light-plan.md' : 'plan/success-card.md'
      record.write(relative, renderPlanArtifact(route, decision))
      return relative
    },
    runtimeTransition: payload => applyProductionRuntimeTransition({
      stateStore, capability: leaseRef, budgetController: runtimeOptions.budgetController,
    }, payload),
    mutationEnforcer: {
      begin: ({ preimages, isolation, workItemId }) => {
        const current = stateStore.load()
        return stateStore.beginAuthorizedMutation({
          capability: leaseRef,
          authority: {
            runId: current.runId,
            activationId: current.activation.id,
            nonce: current.activation.nonce,
            generation: current.activation.generation,
          },
          expectedEpoch: current.workspaceEpoch,
          preimages: preimages.filter(entry => entry.type === 'file').map(({ path: filePath, hash }) => ({ path: filePath, hash })),
          isolation,
          requireIsolation: true,
          cause: `Admit exact owned preimages for ${workItemId}.`,
        })
      },
      commit: ({ permit, postimages, isolation, workItemId }) => stateStore.commitAuthorizedMutation(permit, {
        capability: leaseRef,
        postimages: postimages.filter(entry => entry.type === 'file').map(({ path: filePath, hash }) => ({ path: filePath, hash })),
        deletions: postimages.filter(entry => entry.type === 'missing').map(entry => entry.path),
        isolationBindingHash: isolation && isolation.bindingHash,
        cause: `Commit observed owned postimages for ${workItemId}.`,
      }),
      abort: ({ permit, isolation, workItemId, error }) => stateStore.abortAuthorizedMutation(permit, {
        capability: leaseRef,
        isolationBindingHash: isolation && isolation.bindingHash,
        cause: `Close failed owned mutation permit for ${workItemId}.`,
        failureCode: error && error.code || 'WORKER_FAILED',
      }),
      recoverCommit: ({ postimages, isolation, workItemId, journalPath }) => {
        const journal = readChecksummedJson(journalPath)
        if (!journal || !['COMMITTED', 'FINALIZED'].includes(journal.status) ||
            !isolation || journal.binding.bindingHash !== isolation.bindingHash) {
          throw new SupervisorIntegrationError(
            'DONE_RETRY_RECOVERY_INVALID',
            'physical promotion recovery requires the exact committed worker journal',
          )
        }
        for (const postimage of postimages) {
          const exists = fs.existsSync(postimage.path)
          const actual = exists && postimage.type === 'file'
            ? sha256Bytes(fs.readFileSync(postimage.path)) : null
          if ((postimage.type === 'missing' && exists) ||
              (postimage.type === 'file' && actual !== postimage.hash)) {
            throw new SupervisorIntegrationError(
              'CONCURRENT_MUTATION',
              'journal-committed deferred postimage changed during state recovery',
            )
          }
        }
        return stateStore.record('TRANSIENT_RUNTIME', {
          capability: leaseRef,
          cause: `Recover journal-proven committed mutation state for ${workItemId}.`,
          workHashes: postimages.filter(item => item.type === 'file').map(item => item.hash),
          details: {
            recoveryKind: 'DEFERRED_PROMOTION_COMMIT_RECOVERED',
            workItemId,
            journalPath,
            isolationBindingHash: isolation.bindingHash,
          },
        })
      },
    },
    workerWorkspaceFactory: ({ assignment, workItemId }) => {
      if (!workerWorkspaceManager) {
        workerWorkspaceManager = new WorkerWorkspaceManager({
          targetRoot: targetPath,
          privateRoot: path.join(activation.activationRoot, 'worker-workspaces'),
          environment: gitEnvironment(targetPath),
          runId: activation.runId,
          activationId: activation.runId,
          hardenWorkspace: workspacePath => {
            const repair = childProcess.spawnSync(process.execPath, [
              path.resolve(__dirname, '..', '..', '..', 'scripts', 'local-only-safety.cjs'),
              '--repo', workspacePath,
              '--expected-branch', expectedBranch,
              '--repair',
              '--enforcement-proof', activationRecord.activationBoundary.enforcementProof.path,
              '--json',
            ], {
              env: environment,
              encoding: 'utf8',
              windowsHide: true,
              maxBuffer: 4 * 1024 * 1024,
            })
            let parsed = null
            try { parsed = JSON.parse(String(repair.stdout || '')) } catch {}
            return {
              accepted: [0, 3].includes(repair.status) && parsed &&
                parsed.networkContactAttempted === false && parsed.repositoryOk === true,
            }
          },
        })
      }
      return workerWorkspaceManager.prepare({ assignment, workItemId })
    },
    workerWorkspaceRecoveryFactory: ({ assignment, workItemId, recordPath }) => {
      if (!workerWorkspaceManager) {
        workerWorkspaceManager = new WorkerWorkspaceManager({
          targetRoot: targetPath,
          privateRoot: path.join(activation.activationRoot, 'worker-workspaces'),
          environment: gitEnvironment(targetPath),
          runId: activation.runId,
          activationId: activation.runId,
          hardenWorkspace: workspacePath => {
            const repair = childProcess.spawnSync(process.execPath, [
              path.resolve(__dirname, '..', '..', '..', 'scripts', 'local-only-safety.cjs'),
              '--repo', workspacePath,
              '--expected-branch', expectedBranch,
              '--repair',
              '--enforcement-proof', activationRecord.activationBoundary.enforcementProof.path,
              '--json',
            ], {
              env: environment,
              encoding: 'utf8',
              windowsHide: true,
              maxBuffer: 4 * 1024 * 1024,
            })
            let parsed = null
            try { parsed = JSON.parse(String(repair.stdout || '')) } catch {}
            return {
              accepted: [0, 3].includes(repair.status) && parsed &&
                parsed.networkContactAttempted === false && parsed.repositoryOk === true,
            }
          },
        })
      }
      return workerWorkspaceManager.reopen({ assignment, workItemId, recordPath })
    },
    writeDeferredPromotionState(state) {
      if (!recordRef) {
        throw new SupervisorIntegrationError(
          'RUN_RECORD_FAILURE',
          'deferred promotion state requires the opened run record',
        )
      }
      recordRef.write('work/deferred-promotion.json', `${JSON.stringify(state, null, 2)}\n`)
    },
    readDeferredPromotionState() {
      if (!recordRef) {
        throw new SupervisorIntegrationError(
          'RUN_RECORD_FAILURE',
          'deferred promotion recovery requires the opened run record',
        )
      }
      const absolute = recordRef.resolve('work/deferred-promotion.json')
      if (!fs.existsSync(absolute)) {
        throw new SupervisorIntegrationError(
          'DONE_RETRY_RECOVERY_REQUIRED',
          'durable deferred promotion state is missing',
        )
      }
      return readRegularJson(absolute, 'deferred promotion state').parsed
    },
    async capturePreMutationBaseline({ request, targetPath: baselineTarget, environment: baselineEnvironment }) {
      const status = String(runGit(baselineTarget, [
        'status', '--porcelain=v1', '-z', '--untracked-files=all',
      ], { environment: baselineEnvironment }))
      const dirtyPaths = [...new Set(status.split('\0').filter(Boolean)
        .map(entry => entry.slice(3).split(' -> ').at(-1)).filter(Boolean))].sort()
      const targetStateHash = hashWorkspaceCandidate(baselineTarget, baselineEnvironment)
      const observableChecks = Array.isArray(request && request.checks) && request.checks.length
        ? request.checks.map(String)
        : ['Compare the isolated worker postimage with the immutable target baseline.']
      // request.existingTests and decision.plannedChecks are model-authored
      // descriptions, never execution authority. Only the declarations
      // resolved above from a repository/control-plane trust channel may run.
      const testEnvironment = createMinimalTestEnvironment(environment, {
        isolationRoot: path.join(boundRecord.paths.processControl, 'trusted-test-environment'),
      })
      const runExistingTest = typeof context.existingTestRunner === 'function'
        ? context.existingTestRunner
        : async launch => {
            if (!trustedTestRunner) {
              throw new SupervisorIntegrationError(
                'EXISTING_TEST_BASELINE_INVALID',
                'owned trusted-test runner is unavailable before baseline capture',
              )
            }
            const reservationId = crypto.randomUUID()
            const sessionId = `${activation.runId}:trusted-test:${generation}:${launch.id}`
            const ownedEnvironment = prepareProcessLaunchEnvironment(
              processAdapter,
              reservationId,
              launch.environment,
            )
            return withTimeout(
              () => trustedTestRunner.run({
                executable: launch.executable,
                argv: launch.argv,
                cwd: launch.cwd,
                env: ownedEnvironment,
                stdin: '',
                sessionId,
                reservationId,
              }),
              benchmarkPhaseTimeoutMs(120_000, environment),
              { setTimeout, clearTimeout },
              'EXISTING_TEST_BASELINE_TIMEOUT',
              () => trustedTestRunner.stop({ sessionId, reason: 'trusted existing-test timeout' }),
            )
          }
      const existingTests = await executeExistingTestBaseline(trustedTestDeclarations, {
        runner: runExistingTest,
        environment: testEnvironment,
      })
      const baselineRouteDecisionHash = resolvePreMutationRouteDecisionHash(request, exactFileHash)
      return createProductionPreMutationBaseline({
        capturedBeforeMutation: true,
        targetStateHash,
        environmentHash: hashEnvironment(baselineEnvironment),
        routeDecisionHash: baselineRouteDecisionHash,
        dirtyTarget: {
          status: dirtyPaths.length ? 'DIRTY' : 'CLEAN',
          paths: dirtyPaths,
          snapshotHash: dirtyPaths.length ? targetStateHash : null,
        },
        existingTests,
        fallback: existingTests.length ? null : {
          reason: 'NO_RELEVANT_EXISTING_TESTS',
          evidenceHash: hashText(stableStringify({
            requestEnvelopeHash: runtimeOptions.runtimeInstance &&
              runtimeOptions.runtimeInstance.requestPointer && runtimeOptions.runtimeInstance.requestPointer.hash,
            observableChecks,
            targetStateHash,
          })),
          observableChecks,
        },
      })
    },
    runtimeStateProvider: () => stateStore.load(),
    rolePolicy: liveRolePolicy,
    runId: activation.runId,
    safeEnvFactory,
    settings,
    targetIdentity: activation.supervisorRuntime.targetIdentity,
    targetPath,
  }
  const wallMs = Math.max(1000, Date.parse(activationRecord.capability.expiresAt) - Date.now())
  runtimeOptions.budgetController = new BudgetController({
    requireSessionBindings: true,
    wallTimeUnbounded,
    terminalSessionWriter(terminal) {
      if (!recordRef || typeof recordRef.write !== 'function' || typeof recordRef.resolve !== 'function') {
        throw new SupervisorIntegrationError(
          'SESSION_TERMINAL_PERSIST_FAILED',
          'terminal session persistence requires the opened immutable run record',
        )
      }
      const relative = `work/results/${terminal.recordHash}.json`
      const absolute = recordRef.resolve(relative)
      if (!fs.existsSync(absolute)) recordRef.write(relative, `${JSON.stringify(terminal, null, 2)}\n`)
      const reopened = readRegularJson(absolute, 'terminal session record').parsed
      if (stableStringify(reopened) !== stableStringify(terminal)) {
        throw new SupervisorIntegrationError(
          'SESSION_TERMINAL_PERSIST_FAILED',
          'terminal session record did not reopen with identical immutable bytes',
        )
      }
      return reopened
    },
    limits: {
      wallMs,
      tokens: environment.AUTOPROMPT_BENCHMARK_NO_TOKEN_LIMIT === '1'
        ? Number.MAX_SAFE_INTEGER
        : clampNonNegInt(context.tokenLimit, 1_000_000),
      sessions: clampNonNegInt(context.sessionLimit, 128),
      launches: clampNonNegInt(context.launchLimit, 128),
    },
    finalizationReserveMs: Math.min(30_000, Math.floor(wallMs / 10)),
    phases: productionPhaseBudgets(wallMs),
    phaseBudgetFactory: productionPhaseBudgets,
  })
  runtimeOptions.executeRoute = createDefaultRouteExecutor({
    targetPath,
    gitEnvironment,
    missionHash,
    monotonicNow: typeof context.monotonicNow === 'function'
      ? context.monotonicNow : () => Number(process.hrtime.bigint() / 1000000n),
    verifyL1RequestPointer() {
      const runtime = runtimeOptions.runtimeInstance
      if (!runtime) throw new SupervisorIntegrationError('REQUEST_POINTER_REQUIRED', 'active runtime is unavailable')
      return verifyRequestPointer(runtime.requestPointer)
    },
    recordRoadmapPlanning(durationMs) {
      const runtime = runtimeOptions.runtimeInstance
      if (!runtime || !runtime.scheduler) {
        throw new SupervisorIntegrationError('SCHEDULER_REQUIRED', 'ROADMAP planning admission requires the active scheduler')
      }
      return runtime.scheduler.recordAdmissionComponent('roadmapPlanning', durationMs)
    },
    frameworkAuthorityFactory({ route, requirementHash, missIdentity }) {
      if (!recordRef) {
        throw new SupervisorIntegrationError(
          'RUN_RECORD_FAILURE',
          'framework orchestration requires the opened run record',
        )
      }
      if (!missIdentity || missIdentity.cacheKey !== requirementHash ||
          !/^[a-f0-9]{64}$/.test(missIdentity.routeSchemaDigest || '')) {
        throw new SupervisorIntegrationError(
          'FRAMEWORK_MISS_IDENTITY_INVALID',
          'framework MISS cache requires the route-schema digest and exact composite cache key',
        )
      }
      const relative = `work/framework-orchestration-${requirementHash}.json`
      const sharedCacheRoot = path.join(path.dirname(activation.activationRoot), 'framework-cache')
      const sharedCachePath = path.join(sharedCacheRoot, `${requirementHash}.json`)
      return new FrameworkOrchestrationAuthority({
        binding: {
          runId: activation.runId,
          activationId: activation.runId,
          generation,
          route,
          assignmentId: `framework:${requirementHash.slice(0, 24)}`,
          findingIds: ['AP-LAYER-004'],
          requirementHash,
          routeSchemaDigest: missIdentity.routeSchemaDigest,
          cacheKey: missIdentity.cacheKey,
        },
        readState() {
          const absolute = recordRef.resolve(relative)
          return fs.existsSync(absolute)
            ? readRegularJson(absolute, 'framework orchestration state').parsed
            : null
        },
        writeState(state) {
          recordRef.write(relative, `${JSON.stringify(state, null, 2)}\n`)
        },
        readCache() {
          return fs.existsSync(sharedCachePath)
            ? readRegularJson(sharedCachePath, 'shared framework descriptor').parsed
            : null
        },
        writeCache(descriptor) {
          fs.mkdirSync(sharedCacheRoot, { recursive: true, mode: 0o700 })
          try {
            fs.writeFileSync(sharedCachePath, `${JSON.stringify(descriptor, null, 2)}\n`, {
              encoding: 'utf8', flag: 'wx', mode: 0o600,
            })
          } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error
          }
        },
        generate: deterministicFrameworkGenerator,
        validate: deterministicFrameworkValidator,
        maxAttempts: 3,
      })
    },
    authorizeResidualRisk({ findings, candidateHash }) {
      if (typeof context.residualRiskAuthority !== 'function') {
        throw new SupervisorIntegrationError(
          'RESIDUAL_RISK_AUTHORITY_REQUIRED',
          'post-finding residual-risk authority is unavailable',
        )
      }
      const decision = context.residualRiskAuthority(Object.freeze({
        findings: Object.freeze(findings.map(item => Object.freeze({ id: item.id, severity: item.severity }))),
        candidateHash,
        runId: activation.runId,
        activationId: activation.runId,
        generation,
      }))
      if (decision && typeof decision.then === 'function') {
        throw new SupervisorIntegrationError(
          'RESIDUAL_RISK_AUTHORITY_REQUIRED',
          'post-finding residual-risk authority must decide before result disposition is persisted',
        )
      }
      const receipt = bindResidualRiskAuthorityReceipt({
        findings, decision, candidateHash,
        runId: activation.runId, activationId: activation.runId, generation,
      })
      if (!recordRef) throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'residual-risk authority requires the opened run record')
      const relative = `checks/residual-risk-authority-${candidateHash}.json`
      const absolute = recordRef.resolve(relative)
      if (!fs.existsSync(absolute)) recordRef.write(relative, `${JSON.stringify(receipt, null, 2)}\n`)
      const reopened = readRegularJson(absolute, 'residual-risk authority receipt').parsed
      if (stableStringify(reopened) !== stableStringify(receipt)) {
        throw new SupervisorIntegrationError('RESIDUAL_RISK_AUTHORITY_REQUIRED', 'post-finding authority receipt changed after persistence')
      }
      return reopened
    },
    transition: (eventId, nextState, details) => {
      const runtime = runtimeOptions.runtimeInstance
      return runtime
        ? runtime._runtimeTransition(eventId, nextState, details)
        : runtimeOptions.runtimeTransition({ eventId, nextState, details })
    },
    harnessAttestation(candidateHash, oracle) {
      return {
        repoHash: candidateHash,
        buildHash: hashText(JSON.stringify(activationRecord.contractVersions)),
        oracleHash: hashText(oracle),
      }
    },
    writePlan(route, decision, authorResult, authorWorkItemId = null) {
      if (!recordRef) throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'plan write requires the opened run record')
      const relative = route === 'ROADMAP' ? 'plan/ROADMAP.md'
        : route === 'LIGHT' ? 'plan/light-plan.md' : 'plan/success-card.md'
      const plan = renderPlanArtifact(route, decision, authorResult)
      if (route === 'ROADMAP' && authorResult) {
        writeRoadmapProjectionReceipt(decision, authorResult, plan, authorWorkItemId)
      }
      recordRef.write(relative, plan)
      const runtime = runtimeOptions.runtimeInstance
      if (route === 'ROADMAP' && authorResult && runtime && runtime.scheduler) {
        const roadmap = roadmapAuthorArtifact(authorResult, authorResult.scoutCorrections || [])
        const requestScope = recordRef.loadRequest()
        const missionScopeHash = requestScope && requestScope.digest
        const userAskCount = immutableSemanticUserAskCount(requestScope)
        const planSha256 = hashText(plan)
        const expansionCount = Math.max(0, roadmap.behaviorChanged.length - userAskCount)
        let expansionAdmission = null
        if (expansionCount > 0) {
          const expansionAuthority = typeof context.roadmapExpansionAuthority === 'function'
            ? context.roadmapExpansionAuthority
            : productionRoadmapExpansionAuthority
          const authority = expansionAuthority(Object.freeze({
            admittedAskCount: expansionCount,
            missionScopeHash,
            planSha256,
            requestVersionPointer: requestScope.currentPointer,
            proposedEvidence: roadmap.expansionAdmission || null,
          }))
          if (authority && typeof authority.then === 'function') {
            throw new SupervisorIntegrationError(
              'ROADMAP_EXPANSION_NOT_ADMITTED',
              'roadmap expansion authority must make a synchronous receipt-bound decision before the plan is recorded',
            )
          }
          expansionAdmission = bindRoadmapExpansionAdmission({
            ...authority,
            admittedAskCount: expansionCount,
            missionScopeHash,
            planSha256,
          })
        }
        runtime.scheduler.recordRoadmapAskRatio({
          roadmapAskCount: roadmap.behaviorChanged.length,
          userAskCount,
          missionScopeHash,
          planSha256,
          expansionAdmission,
        })
      }
    },
    planExists(route) {
      if (!recordRef) return false
      const relative = route === 'ROADMAP' ? 'plan/ROADMAP.md'
        : route === 'LIGHT' ? 'plan/light-plan.md' : 'plan/success-card.md'
      return fs.existsSync(recordRef.resolve(relative))
    },
    readResult: readDurableResult,
    writeAllWorkJoinedReceipt(receipt) {
      if (!recordRef || typeof recordRef.writeAllWorkJoinedReceipt !== 'function') {
        throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'ALL_WORK_JOINED receipt writer is unavailable')
      }
      return recordRef.writeAllWorkJoinedReceipt(receipt)
    },
    readAllWorkJoinedReceipt() {
      if (!recordRef || typeof recordRef.readAllWorkJoinedReceipt !== 'function') {
        throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'ALL_WORK_JOINED receipt reader is unavailable')
      }
      return recordRef.readAllWorkJoinedReceipt()
    },
    readPreMutationBaseline() {
      if (!recordRef || typeof recordRef.readPreMutationBaseline !== 'function') return null
      try { return recordRef.readPreMutationBaseline() } catch (error) {
        if (error && ['ENOENT', 'RUN_RECORD_FAILURE'].includes(error.code)) return null
        throw error
      }
    },
    resultPointer(workItemId) {
      if (!recordRef) throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'result pointer requires the opened run record')
      const absolute = recordRef.resolve(`work/results/${hashText(workItemId)}.json`)
      if (!fs.existsSync(absolute)) {
        throw new SupervisorIntegrationError('SCOUT_EVIDENCE_MISSING', `durable result is missing for ${workItemId}`)
      }
      const bytes = fs.readFileSync(absolute)
      return Object.freeze({
        name: workItemId,
        path: absolute,
        hash: sha256Bytes(bytes),
        bytes: bytes.length,
      })
    },
    writeCapturedDomainAdmission(admission) {
      if (!recordRef) throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'captured-domain admission requires the opened run record')
      recordRef.write('work/captured-domain-admission.json', `${JSON.stringify(admission, null, 2)}\n`)
    },
    writeCapturedDomainOutcomes(record) {
      if (!recordRef) throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'captured-domain evidence requires the opened run record')
      recordRef.write('checks/captured-domain-outcomes.json', `${JSON.stringify(record, null, 2)}\n`)
    },
    restoreDeferredPromotion(workItemId) {
      const runtime = runtimeOptions.runtimeInstance
      if (!runtime) {
        throw new SupervisorIntegrationError(
          'DONE_RETRY_RECOVERY_REQUIRED',
          'deferred promotion recovery requires the active supervisor runtime',
        )
      }
      return runtime._restoreDeferredPromotion(workItemId)
    },
    planPointer(route) {
      if (!recordRef) throw new SupervisorIntegrationError('RUN_RECORD_FAILURE', 'plan pointer requires the opened run record')
      const relative = route === 'ROADMAP' ? 'plan/ROADMAP.md'
        : route === 'LIGHT' ? 'plan/light-plan.md' : 'plan/success-card.md'
      const absolute = recordRef.resolve(relative)
      const bytes = fs.readFileSync(absolute)
      return Object.freeze({ path: absolute, sha256: sha256Bytes(bytes), bytes: bytes.length })
    },
  })
  return runtimeOptions
}

function createConcreteSupervisor(args = {}, context = {}) {
  return new CodexSupervisorRuntime(createSupervisorOptions(args, context))
}

function serializeError(error) {
  return {
    code: error && error.code || 'FAILED',
    message: error && error.message || String(error),
    details: error && error.details || {},
  }
}

function supervisorCapabilities() {
  return {
    schemaVersion: 2,
    provider: 'codex',
    routes: ['DIRECT', 'LIGHT', 'ROADMAP'],
    defaultRoute: null,
    routeAnalyst: { count: 1, maxDurationMs: ROUTE_ANALYST_MAX_DURATION_MS },
    l0DecisionMaxDurationMs: L0_DECISION_MAX_DURATION_MS,
    forkTurns: 'none',
    launchAuthority: 'central-scheduler-only',
    concreteRuntime: { supported: false, code: 'PROVIDER_UNSUPPORTED' },
    externalTransport: 'codex exec --json / codex exec resume --json',
  }
}

async function runSupervisorCli(argv) {
  const args = parseFlagPairs(argv)
  if (args.capabilities) {
    process.stdout.write(`${JSON.stringify(supervisorCapabilities())}\n`)
    return 0
  }
  const adapterPath = args.adapter || process.env.AUTOPROMPT_SUPERVISOR_ADAPTER || __filename
  try {
    const resolvedAdapter = path.resolve(adapterPath)
    if (resolvedAdapter !== path.resolve(__filename)) {
      throw new SupervisorIntegrationError(
        'PROVIDER_UNSUPPORTED',
        'the receipt-bound built-in phase-budget adapter is the only supported Codex supervisor adapter',
      )
    }
    const runtime = new CodexSupervisorRuntime(createSupervisorOptions(args, {
      adapterPath,
      exactPathPreflight: productionExactPathPreflight,
    }))
    const outcome = await runtime.start()
    process.stdout.write(`${JSON.stringify(outcome)}\n`)
    return outcome.outcome === 'DONE' ? 0 : 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'FAILED', error: serializeError(error) })}\n`)
    return 2
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  if (argv[0] === '--owned-codex-proxy' && argv.length === 2) {
    try { runOwnedCodexProxy(argv[1]) } catch (error) {
      process.stderr.write(`owned-codex-proxy: ${error.code || 'RUNTIME_FAILURE'}: ${error.message}\n`)
      process.exitCode = 2
    }
  } else if (argv.includes('--verdict')) {
    process.exitCode = runVerdictCli(argv.filter(value => value !== '--verdict'))
  } else if (argv.includes('--supervisor')) {
    runSupervisorCli(argv.filter(value => value !== '--supervisor'))
      .then(code => { process.exitCode = code })
      .catch(error => {
        process.stderr.write(`supervisor: ${error.message}\n`)
        process.exitCode = 2
      })
  } else {
    process.stderr.write('usage: node phase-budget.js --verdict ... | --supervisor [--capabilities|--adapter path]\n')
    process.exitCode = 2
  }
}

module.exports = {
  CodexExecAdapter,
  appendSupervisorRecordedCapturedDomainOutcomes,
  applyBenchmarkEffortPin,
  benchmarkFirstProductSignalDeadlineEnabled,
  benchmarkPhaseTimeoutMs,
  productionRoadmapExpansionAuthority,
  resolvePreMutationRouteDecisionHash,
  runtimeCapabilityExpiryMs,
  CodexSupervisorRuntime,
  CompatibilityRecoveryAuthority,
  FrameworkOrchestrationAuthority,
  OwnedCodexProxyRunner,
  EXIT_CODE,
  FORBIDDEN_RUNTIME_ROLES,
  MAX_FORCED_RESETS,
  PhaseBudgetError,
  RISK_CHECKS,
  RolePolicy,
  RuntimeCapabilityAuthority,
  REQUIRED_SAFETY_CHANNELS,
  ROUTE_CAPABILITY_EFFECTS,
  SCOPE_GRACE_SEC,
  SCOPE_HARD_SEC,
  SCOPE_SOFT_SEC,
  SupervisorIntegrationError,
  SUPERVISOR_ADAPTER_INTERFACE,
  TERMINAL_OUTCOMES,
  WORK_CHECKS,
  admitCodexRoleSelection,
  assertReadOnlyCheckerOperation,
  clampNonNegInt,
  createConcreteSupervisor,
  createCheckerScratchFactory,
  createCheckerSnapshotFactory,
  planCheckerProjection,
  validatePlanCheckerSnapshot,
  canonicalCompletedCheckerId,
  roadmapPlanOracleForWorkItem,
  checkerVerdictPassed,
  durableNextReadyAfter,
  recoveryGroupNextReady,
  adoptedLeaseMatchesStage,
  terminalFinalizationDiagnostics,
  createCodexEntrySemanticTrace,
  runCodexTopLevelEntryAdapter,
  runCodexSupervisorEntryAdapter,
  classifyCodexTopLevelPrompt,
  createDefaultRouteExecutor,
  createReadOnlyFinalResponse,
  activationAttestationPayload,
  activationRuntimeSettings,
  assertDistinctEvidenceConsumption,
  appendCanonicalRouteEvent,
  buildActivationPromptEnvelope,
  createDefaultRuntimeOptions,
  createArtifactCoverageContract,
  applyProductionRuntimeTransition,
  bindResidualRiskAuthorityReceipt,
  createDefaultExternalOperation,
  createResidualRiskDisposition,
  createMinimalTestEnvironment,
  consumeSplitRequired,
  createCodexJsonlAccumulator,
  decodeCodexProviderEnvelope,
  createSupervisorOptions,
  ensureSafeEnvironment,
  executeExistingTestBaseline,
  executionMutableResourceOwnership,
  decisionReadOnlyOwnership,
  resolveTrustedTestDeclarations,
  executePreProductionRuntimeGates,
  emitItemVerifiedTransition,
  loadRoleContract,
  parseFlagPairs,
  parseCodexJsonl,
  persistTerminalSession,
  phaseBudgetVerdict,
  physicalProviderRoleForGeneration,
  productionExactPathPreflight,
  productionPhaseBudgets,
  providerRuntimeIdentityHash,
  readPrivateAgentAssignment,
  readPersistedWorkerAssignment,
  replayRequestFromPersistedAssignment,
  renderRouteDecisionMarkdown,
  renderPlanArtifact,
  runSupervisorCli,
  runOwnedCodexProxy,
  safeEnvironmentFactory,
  selectWorkRecipe,
  serializeError,
  supervisorCapabilities,
  probeCodexExecCapabilities,
  materializeCodexProviderEnvelopeSchema,
  validateActivationInputs,
  validateActivationRoleProjection,
  verifyActivationProviderAttestation,
  verifyRequestPointer,
  validateResumedBudget,
  writeRouteDecisionArtifacts,
  canonicalEvidenceBinding,
  schedulerProgressEvidenceHashes,
  checkerRecoveryNextReady,
  diagnosticDenialDisposition,
  evidenceInvalidationSet,
  canonicalAssignmentResources,
  assertRealTargetUnchanged,
  workspaceFileSnapshot,
  evaluateRegressionDelta,
  planOverlayExecution,
  selectRuntimeGateTriggers,
  validateLiveCheckingPlan,
  validateGeneratedFramework,
  validateDurableResultEvidencePointer,
  validateWorkerRequestedTransition,
  validateCanonicalChildResult,
  launchCodexChildWithCheckerReassessment,
  validateCheckerScratchDirectories,
  requiredCompletionGates,
  reconstructTypedExitZeroResult,
  typedChildOutputReady,
  reconcileExternalOperationTimeout,
  roadmapAuthorArtifact,
  resolveTerminalReceiptCandidateHash,
  resumePlanProjectionAccepted,
  immutableSemanticUserAskCount,
}
