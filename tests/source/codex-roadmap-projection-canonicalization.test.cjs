'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const PHASE_BUDGET = path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js')
const source = fs.readFileSync(PHASE_BUDGET, 'utf8')
const local = new Module(PHASE_BUDGET, module)
local.filename = PHASE_BUDGET
local.paths = Module._nodeModulePaths(path.dirname(PHASE_BUDGET))
local._compile(`${source}\nmodule.exports.__projectionPrivate = { rebuildRoadmapProjectionAuthorResult, roadmapProjectionScoutRoster, scoutCorrection, renderPlanArtifact }\n`, PHASE_BUDGET)
const {
  rebuildRoadmapProjectionAuthorResult,
  roadmapProjectionScoutRoster,
  scoutCorrection,
  renderPlanArtifact,
} = local.exports.__projectionPrivate

const durableRepairResult = Object.freeze({
  schemaVersion: '2.0.0',
  reportType: 'result',
  reportId: 'result:roadmap-author-plan-repair',
  runId: 'apv2-a306d2edd7c88c49c4f4dc8da64c2878',
  assignmentId: 'roadmap-author-plan-repair',
  logicalRoleId: 'roadmap-author',
  physicalRoleId: 'autoprompt.v2.roadmap-author',
  requestEnvelopeHash: '6'.repeat(64),
  allAssignedItemsPass: true,
  behaviorChanged: Object.freeze([
    'Define the exact production deliverable and its dependency boundary.',
    'Implement and independently verify the production deliverable.',
  ]),
  commands: Object.freeze([]),
  successItems: Object.freeze([]),
  remainingConcerns: Object.freeze([]),
  findingIds: Object.freeze(['AP-PRODUCTION-PLANNING']),
})

const capturedTranscriptEvidence = Object.freeze([
  Object.freeze({
    sequence: 1,
    path: '/tmp/codex-home/.a/run/work/results/transcripts/context/events/00000001-event.json',
    hash: 'a'.repeat(64),
    previousHash: null,
    payloadHash: 'b'.repeat(64),
    bytes: 381,
    blobs: Object.freeze([]),
  }),
  Object.freeze({
    sequence: 2,
    path: '/tmp/codex-home/.a/run/work/results/transcripts/context/events/00000002-event.json',
    hash: 'c'.repeat(64),
    previousHash: 'a'.repeat(64),
    payloadHash: 'd'.repeat(64),
    bytes: 3027,
    blobs: Object.freeze([Object.freeze({
      kind: 'content-addressed-output',
      path: '/tmp/codex-home/.a/run/work/results/transcripts/context/blobs/output.blob',
      hash: 'e'.repeat(64),
      bytes: 20258,
      encoding: 'utf8',
      eventField: 'event.item.aggregated_output',
    })]),
  }),
])

test('captured runtime transcript evidence cannot enter ROADMAP plan or projection semantics', () => {
  const runtimeReturnedRepair = {
    ...durableRepairResult,
    behaviorChanged: [...durableRepairResult.behaviorChanged],
    scoutCorrections: [],
    transcriptEvidence: capturedTranscriptEvidence,
  }
  const canonical = rebuildRoadmapProjectionAuthorResult(
    runtimeReturnedRepair,
    durableRepairResult,
    [],
  )

  assert.equal(Object.hasOwn(canonical, 'transcriptEvidence'), false)
  assert.deepEqual(canonical.behaviorChanged, durableRepairResult.behaviorChanged)
  assert.deepEqual(canonical.scoutCorrections, [])

  const changedRuntimeTranscript = rebuildRoadmapProjectionAuthorResult(
    {
      ...runtimeReturnedRepair,
      transcriptEvidence: [{ ...capturedTranscriptEvidence[0], path: '/different/runtime/path' }],
    },
    durableRepairResult,
    [],
  )
  assert.deepEqual(changedRuntimeTranscript, canonical)
})

test('ROADMAP projection canonicalization rejects every non-transcript runtime/durable mismatch', () => {
  const runtimeReturnedRepair = {
    ...durableRepairResult,
    behaviorChanged: [...durableRepairResult.behaviorChanged],
    scoutCorrections: [],
    transcriptEvidence: capturedTranscriptEvidence,
    runtimeOnlyAuthority: 'must-not-be-ignored',
  }

  assert.throws(
    () => rebuildRoadmapProjectionAuthorResult(runtimeReturnedRepair, durableRepairResult, []),
    error => error.code === 'ROADMAP_RESULT_MISSING' && /exact durable author result/.test(error.message),
  )
})

test('ROADMAP projection derives exact scout identities and labels from the route decision', () => {
  const decision = {
    route: 'ROADMAP',
    topology: {
      coordination: {
        scouts: {
          count: 1,
          namedUnknowns: ['Which durable service owns the migration?'],
        },
      },
    },
  }
  const roster = roadmapProjectionScoutRoster(decision, 'roadmap-author-plan-repair')
  assert.deepEqual(roster, [{
    workItemId: 'roadmap-scout-1',
    namedUnknown: 'Which durable service owns the migration?',
  }])

  const scoutResult = { behaviorChanged: [durableRepairResult.behaviorChanged[0]] }
  const correction = scoutCorrection(
    scoutResult,
    roster[0].namedUnknown,
    roster[0].workItemId,
    { hash: 'f'.repeat(64) },
  )
  const supplied = {
    ...durableRepairResult,
    behaviorChanged: [...durableRepairResult.behaviorChanged],
    scoutCorrections: [correction],
    transcriptEvidence: capturedTranscriptEvidence,
  }
  assert.deepEqual(
    rebuildRoadmapProjectionAuthorResult(supplied, durableRepairResult, [correction]).scoutCorrections,
    [correction],
  )

  for (const forged of [
    { ...correction, namedUnknown: 'FORGED crash-replay label' },
    { ...correction, workItemId: 'roadmap-scout-999' },
  ]) {
    assert.throws(
      () => rebuildRoadmapProjectionAuthorResult(
        { ...supplied, scoutCorrections: [forged] },
        durableRepairResult,
        [correction],
      ),
      error => error.code === 'ROADMAP_RESULT_MISSING' && /exact durable author result/.test(error.message),
    )
  }
  assert.deepEqual(roadmapProjectionScoutRoster(decision, 'roadmap-author'), [])
})

test('live ROADMAP writer and verifier consume the canonical durable projection object', () => {
  assert.match(source,
    /const projectionAuthorResult = route === 'ROADMAP' && authorResult\s+\? loadCanonicalRoadmapProjectionAuthorResult\(decision, authorResult, authorWorkItemId\)/u)
  assert.match(source, /renderPlanArtifact\(route, decision, projectionAuthorResult\)/u)
  assert.match(source,
    /writeRoadmapProjectionReceipt\(\s*decision,\s*projectionAuthorResult,\s*plan,\s*authorWorkItemId,?\s*\)/u)
  assert.doesNotMatch(source,
    /writeRoadmapProjectionReceipt\(decision, authorResult, plan, authorWorkItemId\)/u)
  assert.match(source,
    /const durableCorrections = roadmapProjectionScoutRoster\(decision, authorWorkItemId\)\.map\(expected =>/u)
  assert.match(source,
    /corrections = roadmapProjectionScoutRoster\(decision, receipt\.authorWorkItemId\)\.map\(expected =>/u)
  assert.match(source,
    /rebuildRoadmapProjectionAuthorResult\(receipt\.authorResult, sourceResult, corrections\)/u)
})

test('ROADMAP recovery checkpoints bind expansion generation and exact append-only plan lineage', () => {
  assert.match(source, /causeId: `roadmap-ratio:\$\{generation\}:\$\{authorWorkItemId\}:\$\{planSha256\}`/u)
  assert.match(source, /causeId: `plan-lineage:\$\{lineage\.lineageReceiptHash\}`/u)
  assert.match(source, /previousCheckpointEntryHash: priorRecord\.entryHash/u)
  assert.match(source, /projectionReceiptHash: projectionReceipt\.receiptHash/u)
  assert.match(source, /artifactReceiptHash: artifactReceipt\.receiptHash/u)
  assert.doesNotMatch(source, /causeId: `roadmap-ratio:\$\{activation\.generation\}/u)
})

test('ROADMAP projection renders the same canonical owner used for product execution', () => {
  const plan = renderPlanArtifact('ROADMAP', {
    route: 'ROADMAP',
    requestedResult: 'Build the requested production result.',
    usefulWorkerCount: 1,
    successChecklist: ['The product result passes.'],
    plannedChecks: ['Run the product acceptance check.'],
    verificationObligations: [],
    mutableResourceOwnership: [{
      kind: 'directory', identity: 'outputs', owner: 'planning-specialist',
      ownershipMode: 'single-owner',
    }],
    risks: [], missingInformation: [],
    independentCheckingPlan: {
      checkerCount: 1, responsibilities: ['Check the product result independently.'],
      nonOverlapReason: 'One independent product oracle is sufficient.',
    },
  }, durableRepairResult)

  assert.match(plan, /- worker-1: directory:outputs \(single-owner\)/u)
  assert.doesNotMatch(plan, /planning-specialist/u)
})
