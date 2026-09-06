#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SUT_ROOT = path.resolve(process.env.AUTOPROMPT_CONFORMANCE_SUT_ROOT || path.join(__dirname, '..', '..', '..'))
const workflow = name => require(path.join(SUT_ROOT, 'agents', 'codex', 'workflow', name))
const router = workflow('router.js')
const { buildRouteTopology } = workflow('route-decision.js')
const { CentralScheduler } = workflow('scheduler.js')
const { selectEffort } = workflow('effort-policy.js')
const { buildContextFreeBrief, writeRequestEnvelope } = workflow('context-envelope.js')
const boundaryChild = path.join(__dirname, 'runtime-boundary-child.cjs')

const PROVIDER_CAPABILITIES = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})

function merge(base, overrides) {
  const result = structuredClone(base)
  for (const [key, value] of Object.entries(overrides || {})) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key]
      ? merge(result[key], value)
      : structuredClone(value)
  }
  return result
}

function facts(overrides) {
  return merge({
    schemaVersion: '2.0.0', requestedEffect: 'report', successCriteria: 'ready',
    dependency: { shape: 'bounded', dependentWorkGroupCount: 1, integrationOwnerRequired: false, separateDependentBodies: 1 },
    uncertainty: 'none', reversibility: 'fully-reversible', mutableResources: [], sideEffects: [], externality: 'local-only', confidentiality: 'internal', thirdPartyImpact: 'none',
    targetAuthorization: { targetIdentities: [], authorizedTargetIdentities: [], authorizationEvidenceHash: null },
    costAuthority: { mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0, approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null },
    riskAndIndependentCheckFloor: { level: 'ordinary', minimumCheckerCount: 1, namedDistinctResponsibilities: [] },
    checkAndBaseline: { checkQuality: 'authoritative', availableCheckKinds: ['observable-result'], baselineStatus: 'not-applicable', hiddenExternalCheck: false },
    deadlineBudget: { remainingSeconds: 4000, admissionSeconds: 240, executionReserveSeconds: 600, verificationReserveSeconds: 300, recoveryAndFinalizationReserveSeconds: 180 },
    operatorMinimumRoute: null, transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true }, candidateFreeze: { required: true, available: true, environmentCanBeBound: true },
    missingUserInput: [], architectureImpact: 'local', fitsLightPlan: true, approachNeedsShortPlanning: false, shortOrderUnclear: false,
  }, overrides)
}

const cases = {
  'direct-bounded-fix': {
    overrides: {},
    topology: { workerCount: 1 },
    effort: { role: 'worker', difficulty: 'ordinary', risk: 'ordinary' },
  },
  'light-security-fix': {
    overrides: {
      requestedEffect: 'mutate', uncertainty: 'reversible-technical', approachNeedsShortPlanning: true,
      mutableResources: [{ kind: 'file', identity: 'src/render.js', shared: false, ownershipMode: 'single-owner' }],
      sideEffects: ['deliverable-write'],
      riskAndIndependentCheckFloor: { level: 'elevated', minimumCheckerCount: 2, namedDistinctResponsibilities: ['output encoding review', 'browser behavior test'] },
    },
    topology: { workerCount: 1 },
    effort: { role: 'worker', difficulty: 'high', risk: 'high' },
  },
  'roadmap-soc-build': {
    overrides: {
      requestedEffect: 'external-operation', reversibility: 'staged-rollback-required', externality: 'external-write', thirdPartyImpact: 'material',
      targetAuthorization: { targetIdentities: ['database:customer-primary'], authorizedTargetIdentities: ['database:customer-primary'], authorizationEvidenceHash: 'a'.repeat(64) },
      mutableResources: [{ kind: 'database', identity: 'customer-primary', shared: true, ownershipMode: 'exclusive-lease' }],
      sideEffects: ['database-write', 'external-write'],
      riskAndIndependentCheckFloor: { level: 'staged-high-impact', minimumCheckerCount: 2, namedDistinctResponsibilities: ['migration safety', 'data reconciliation'] },
    },
    topology: { workerCount: 1 },
    effort: { role: 'worker', difficulty: 'exceptional', risk: 'critical' },
  },
}

function expandPhysicalRoles(counts) {
  // The shared topology retains ROADMAP's logical planning structure for
  // cross-provider compatibility. Codex executes that structure as a
  // deterministic controller projection, so only the analyst, useful product
  // workers, and fresh final checker seats cross a model boundary.
  const definitions = [
    ['routeAnalysts', 'ap-route-analyst', 'planning'],
    ['workers', 'ap-worker', 'work'],
    ['finalCheckers', 'ap-independent-checker', 'verification'],
  ]
  return definitions.flatMap(([field, role, purpose]) =>
    Array.from({ length: counts[field] }, (_, index) => ({ role, purpose, ordinal: index + 1 })))
}

function childUsage(dispatch, workItemId, role) {
  const result = childProcess.spawnSync(process.execPath, [boundaryChild, '--mode', 'usage'], {
    encoding: 'utf8', shell: false, windowsHide: true,
    input: JSON.stringify({ ...dispatch, workItemId, role }),
  })
  if (result.error || result.status !== 0) {
    throw new Error(`model boundary failed for ${workItemId}: ${result.error?.code || result.status} ${result.stderr || ''}`)
  }
  const record = JSON.parse(result.stdout.trim())
  if (record.schemaVersion !== 1 || record.kind !== 'model-boundary-record' || record.output.workItemId !== workItemId) {
    throw new Error(`model boundary returned an invalid record for ${workItemId}`)
  }
  return record.usage
}

async function main() {
  const id = process.argv[process.argv.indexOf('--case') + 1]
  const entry = cases[id]
  if (!entry) throw new Error(`unknown simulation: ${id}`)

  const routeFacts = facts(entry.overrides)
  const decision = router.classifyRoute(routeFacts)
  if (decision.status !== 'DECIDED') throw new Error(`route not decided: ${decision.status}`)
  const mutableResourceOwnership = decision.normalized_facts.mutableResources.map(resource => ({
    kind: resource.kind,
    identity: resource.identity,
    ownershipMode: resource.ownershipMode,
    owner: 'ap-worker-1',
  }))
  const topology = buildRouteTopology(decision.route, {
    facts: routeFacts, mutableResourceOwnership, ...entry.topology,
  })
  if (!topology.valid) throw new Error(`route topology invalid: ${topology.errors.join('; ')}`)

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-economic-${id}-`))
  try {
    const requestPointer = writeRequestEnvelope(temporary, `Execute ${id} with production scheduler accounting.\n`, { route: decision.route })
    const scheduler = new CentralScheduler({ route: decision.route, runIdentity: { runId: `economic-${id}`, generation: 1 } })
    let contextBytes = 0
    let sequence = 0
    for (const item of expandPhysicalRoles(topology.counts)) {
      sequence += 1
      const workItemId = `${item.role}-${item.ordinal}`
      const dispatch = buildContextFreeBrief({
        route: decision.route,
        role: item.role,
        purpose: item.purpose,
        assignment: `Execute the bounded ${workItemId} responsibility for ${id}.`,
        successChecklist: ['Return a typed result bound to this work item.'],
        checks: ['Emit complete model usage accounting.'],
        requestPointer,
        providerCapabilities: PROVIDER_CAPABILITIES,
        forkTurns: 'none',
      })
      contextBytes += dispatch.contextBudget.totalEnvelopeBytes
      const authority = scheduler.issueLaunchAuthority({
        callerRole: 'autoprompt.v2.run-owner', sessionId: `economic-session-${sequence}`,
        runId: `economic-${id}`, generation: 1, parentLease: null,
        providerCapabilities: PROVIDER_CAPABILITIES,
      })
      const lease = await scheduler.acquireWithAuthority(authority, {
        workItemId, equivalenceKey: workItemId, role: item.role, logicalRole: item.role,
        purpose: item.purpose, lane: 'main', missionEssential: true,
      })
      lease.complete(childUsage(dispatch, workItemId, item.role))
    }

    const metrics = scheduler.getMetrics()
    const effort = selectEffort(entry.effort).effort
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'codex-route-simulation.v1', id, route: decision.route,
      childLaunches: metrics.counters.totalLaunches,
      contextBytes,
      usage: {
        inputTokens: metrics.usageTotals.noncachedInput + metrics.usageTotals.cachedInput,
        cachedInputTokens: metrics.usageTotals.cachedInput,
        outputTokens: metrics.usageTotals.output,
      },
      effort,
      productionModules: { router: true, effortPolicy: true, scheduler: true, contextEnvelope: true },
    })}\n`)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
