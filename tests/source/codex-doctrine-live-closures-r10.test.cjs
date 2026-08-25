#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const requestEnvelope = require(path.join(WORKFLOW, 'request-envelope.js'))
const { CentralScheduler, bindRoadmapExpansionAdmission } = require(path.join(WORKFLOW, 'scheduler.js'))
const {
  CodexSupervisorRuntime, canonicalAssignmentResources, executePreProductionRuntimeGates,
  immutableSemanticUserAskCount, selectWorkRecipe, validateLiveCheckingPlan,
} = require(path.join(WORKFLOW, 'phase-budget.js'))
const { evaluateRouteEvent } = require(path.join(WORKFLOW, 'route-decision.js'))

const H = value => crypto.createHash('sha256').update(String(value)).digest('hex')

test('AP-GATE-002 null top-level selection returns typed UNSUPPORTED_SHAPE', () => {
  const result = selectWorkRecipe(null)
  assert.equal(result.status, 'UNSUPPORTED_SHAPE')
  assert.equal(result.reason.code, 'INVALID_GATE_SELECTION')
  assert.ok(result.reason.violations.length > 0)
})

test('AP-GATE-010 live checker plan executes its exact distinct seat count', () => {
  assert.deepEqual(validateLiveCheckingPlan({ independentCheckingPlan: {
    checkerCount: 1, responsibilities: ['single ordinary acceptance risk'],
  } }), {
    checkerCount: 1, responsibilities: ['single ordinary acceptance risk'], nonOverlapReason: null,
  })
  const two = validateLiveCheckingPlan({ independentCheckingPlan: {
    checkerCount: 2, responsibilities: ['security boundary', 'behavior regression'],
    nonOverlapReason: 'different named risks',
  } })
  assert.equal(two.checkerCount, 2)
  assert.throws(() => validateLiveCheckingPlan({ independentCheckingPlan: {
    checkerCount: 2, responsibilities: ['same oracle', 'same oracle'],
  } }), error => error.code === 'INDEPENDENT_CHECKING_PLAN_INVALID')
})

test('AP-GATE-024 a triggered depth gate launches and requires the production specialist result', async () => {
  const launches = []
  const recipe = { runtimeGatePlan: { triggers: { depthProber: {
    required: true, reasons: ['wrong-layer-evidence'],
  } } } }
  const passed = await executePreProductionRuntimeGates({
    recipe, likelyAreas: ['src/runtime.js'],
    launch: async request => { launches.push(request); return { code: 'PASS' } },
  })
  assert.deepEqual(passed, { depthProbe: 'PASS', workItemId: 'conditional-depth-prober' })
  assert.equal(launches[0].logicalRole, 'diagnostic-probe')
  assert.equal(launches[0].purpose, 'diagnostic')
  await assert.rejects(() => executePreProductionRuntimeGates({
    recipe, launch: async () => ({ code: 'FAIL' }),
  }), error => error.code === 'DEPTH_PROBE_REQUIRED')
})

test('AP-TRACE-014 every path named in brief prose must exist inside the target', t => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-r10-path-'))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))
  assert.throws(() => canonicalAssignmentResources({
    targetPath: target, logicalRole: 'worker', readOnly: false, enforcePreimages: false,
    request: {
      workItemId: 'work-1', assignment: 'Inspect src/does-not-exist.js before editing.',
      ownership: ['workspace'], manifests: [],
    },
  }), error => error.code === 'MISSION_PATH_INVALID')
  fs.mkdirSync(path.join(target, 'src'))
  fs.writeFileSync(path.join(target, 'src', 'exists.js'), 'ok\n')
  assert.equal(canonicalAssignmentResources({
    targetPath: target, logicalRole: 'worker', readOnly: false, enforcePreimages: false,
    request: {
      workItemId: 'work-1', assignment: 'Inspect src/exists.js before editing.',
      ownership: ['workspace'], manifests: [],
    },
  }).some(resource => resource.identity === 'workspace'), true)

  const creation = canonicalAssignmentResources({
    targetPath: target, logicalRole: 'worker', readOnly: false, enforcePreimages: true,
    request: {
      workItemId: 'work-1', assignment: 'Create `output/new-file.txt`.',
      ownership: [{ kind: 'file', identity: 'output/new-file.txt', owner: 'work-1' }], manifests: [],
    },
  })
  assert.equal(creation[0].identity, 'output/new-file.txt')
  assert.match(creation[0].expectedPreimageHash, /^[a-f0-9]{64}$/)
})

test('AP-COST-009 production admission rejects unproved expansion and persists exact marginal value', () => {
  const scheduler = new CentralScheduler({
    route: 'ROADMAP', runIdentity: { runId: 'doctrine-r10', generation: 1 },
  })
  assert.throws(() => scheduler.recordRoadmapAskRatio({
    roadmapAskCount: 3, userAskCount: 1, missionScopeHash: H('request'), planSha256: H('plan'),
  }), error => error.code === 'ROADMAP_EXPANSION_NOT_ADMITTED')
  const expansionAdmission = bindRoadmapExpansionAdmission({
    accepted: true, authorityId: 'independent-scope-review',
    authorityReceiptHash: H('authority-receipt'), admittedAskCount: 2,
    missionScopeHash: H('request'), planSha256: H('plan'),
    necessityEvidenceHash: H('necessary'), marginalValueEvidenceHash: H('marginal'),
  })
  const admitted = scheduler.recordRoadmapAskRatio({
    roadmapAskCount: 3, userAskCount: 1, missionScopeHash: H('request'), planSha256: H('plan'),
    expansionAdmission,
  })
  assert.equal(admitted.askCeiling, 3)
  assert.equal(admitted.expansionAdmission.admittedAskCount, 2)
  assert.throws(() => scheduler.recordRoadmapAskRatio({
    roadmapAskCount: 3, userAskCount: 1, missionScopeHash: H('request'), planSha256: H('changed-plan'),
    expansionAdmission,
  }), error => error.code === 'ROADMAP_EXPANSION_NOT_ADMITTED')
})

test('AP-COST-009 real request steering replays immutable semantic asks for ROADMAP admission', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-r10-roadmap-asks-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const requestDir = path.join(directory, 'request')
  requestEnvelope.createRequestEnvelope(requestDir, [{ id: 'original', content: 'original ask' }], {
    runId: 'runtime-doctrine-r10',
  })
  requestEnvelope.appendRequestTurn(requestDir, {
    id: 'additional', operation: 'ADD', content: 'additional accepted ask',
  })
  const requestScope = requestEnvelope.loadRequestEnvelope(requestDir)
  const userAskCount = immutableSemanticUserAskCount(requestScope)
  assert.equal(userAskCount, 2)
  const scheduler = new CentralScheduler({
    route: 'ROADMAP', runIdentity: { runId: 'runtime-doctrine-r10', generation: 1 },
  })
  assert.equal(scheduler.recordRoadmapAskRatio({
    roadmapAskCount: 2,
    userAskCount,
    missionScopeHash: requestScope.digest,
    planSha256: H('real-roadmap-plan'),
  }).roadmapAskToUserAskRatio, 1)
})

test('AP-DESIGN-045 steering invalidates and redispatches a retained L1 on the rebound pointer', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-r10-steer-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const requestDir = path.join(directory, 'request')
  requestEnvelope.createRequestEnvelope(requestDir, [{ id: 'original', content: 'original' }], {
    runId: 'runtime-doctrine-r10',
  })
  const record = {
    appendRequest: (turn, options) => requestEnvelope.appendRequestTurn(requestDir, turn, options),
    loadRequest: () => requestEnvelope.loadRequestEnvelope(requestDir),
  }
  const pointerFactory = async () => {
    const loaded = record.loadRequest()
    const envelopePath = path.join(requestDir, 'envelope.jsonl')
    return Object.freeze({
      kind: 'request-envelope', path: envelopePath, hash: loaded.digest,
      bytes: fs.statSync(envelopePath).size, encoding: 'utf8',
    })
  }
  const transitions = []
  const launched = []
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(runtime, {
    record, requestPointer: await pointerFactory(), route: 'ROADMAP', scheduler: {},
    activation: { id: 'activation-r10', generation: 1 },
    options: { requestPointerFactory: pointerFactory, runtimeTransition: async transition => {
      transitions.push(transition); return null
    } },
    rootCallers: { runOwner: { sessionId: 'root' } },
    workerContexts: new Map([['mission-coordination', {
      executorKey: 'mission-coordination', contextId: 'ctx-l1', logicalRole: 'mission-coordinator',
    }]]),
    retainedL1Leases: new Map([['mission-coordination', { completed: false, schedulerLease: {} }]]),
  })
  runtime.completeRetainedLease = retained => { retained.completed = true; return true }
  runtime._launchThroughScheduler = async (_scheduler, request) => {
    launched.push(request)
    return { code: 'PASS', retainedLease: { completed: false, schedulerLease: {} } }
  }
  const result = await runtime.applyUserSteering({ id: 'steer-r10', operation: 'ADD', content: 'new condition' })
  assert.deepEqual(transitions.map(item => item.eventId), [
    'USER_UPDATE', 'REQUEST_STEERING_APPENDED', 'AFFECTED_RESULTS_INVALIDATED',
  ])
  assert.equal(launched.length, 1)
  assert.equal(launched[0].repairOf, 'mission-coordination')
  assert.equal(launched[0].logicalRole, 'mission-coordinator')
  assert.deepEqual(result.redispatchedRetainedL1Ids, [launched[0].workItemId])
})

test('CAPABILITY_LOST without degraded transport returns typed refusal instead of clone(undefined)', () => {
  const result = evaluateRouteEvent({
    event: 'CAPABILITY_LOST', current_route: 'DIRECT',
    evidence: [
      { kind: 'required-capability', value: 'recursive transport', evidence_ref: 'runtime#required' },
      { kind: 'previous-verification', value: 'recursive transport admitted', evidence_ref: 'runtime#previous' },
      { kind: 'current-failure', value: 'recursive transport unavailable', evidence_ref: 'runtime#failure' },
    ],
  })
  assert.equal(result.status, 'PROVIDER_UNSUPPORTED')
})
