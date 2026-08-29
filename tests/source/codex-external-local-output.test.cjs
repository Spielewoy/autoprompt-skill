#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  CodexExecAdapter,
  bindCanonicalMissionForChild,
  candidateExternalLocalResources,
  canonicalAssignmentResources,
  createCanonicalMissionProjection,
  createDefaultRouteExecutor,
  explicitExternalLocalResources,
  hashWorkspaceCandidate,
  inspectExplicitExternalLocalBoundary,
  materializeExplicitExternalLocalBoundary,
  removeUnchangedExternalLocalPlaceholders,
  rollbackExplicitExternalLocalBoundary,
  commitExplicitExternalLocalBoundary,
  quarantineExplicitExternalLocalBoundary,
  externalLocalTransportQuarantinePointer,
  seedExplicitExternalLocalBoundaryFromQuarantine,
} = require('../../agents/codex/workflow/phase-budget.js')
const { createRouteDecision } = require('../../agents/codex/workflow/route-decision.js')

function temporaryFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-external-local-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'app')
  const external = path.join(root, 'external')
  fs.mkdirSync(target)
  fs.mkdirSync(external)
  const git = args => {
    const result = childProcess.spawnSync('git', args, {
      cwd: target, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  git(['init', '--initial-branch=main'])
  git(['config', 'user.email', 'external-local@example.invalid'])
  git(['config', 'user.name', 'External Local Test'])
  fs.writeFileSync(path.join(target, 'subject.txt'), 'canonical target\n')
  git(['add', 'subject.txt'])
  git(['commit', '-m', 'fixture'])
  return { root, target, external }
}

function externalOwnership(file, output) {
  return [
    { kind: 'file', identity: file, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'ordered-transfer' },
  ]
}

function workerAssignment(target, mission, ownership) {
  return {
    schemaVersion: '2.0.0',
    reportType: 'assignment',
    resources: canonicalAssignmentResources({
      request: {
        workItemId: 'work-1',
        assignment: 'Create both exact external local outputs.',
        ownership,
        manifests: ownership,
      },
      targetPath: target,
      canonicalTargetPath: target,
      logicalRole: 'worker',
      readOnly: false,
      enforcePreimages: true,
      mission,
    }),
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function checkerPass(request) {
  return {
    code: 'PASS',
    payload: {
      evidenceIds: [`evidence:${request.workItemId}`],
      referenceMethod: {
        methodClass: 'black-box-boundary',
        source: `${request.workItemId} independent external-output oracle`,
        procedure: 'Execute and inspect the exact frozen external outputs independently.',
        expectedOutputDerivedFromSubjectCode: false,
        subjectLogicReimplemented: false,
        positiveInvariants: ['The exact outputs remain independently executable and readable.'],
        negativeInvariants: ['Foreign external paths are never treated as admitted deliverables.'],
        boundaryInvariants: ['The checker observes the same exact output identities as the worker.'],
      },
      testOutcomes: (request.checks || []).map(command => ({
        command,
        status: 'PASS',
        fingerprint: sha256(`${request.workItemId}:${command}`),
      })),
    },
  }
}

function externalRouteDecision(ownership) {
  return createRouteDecision({
    route: 'DIRECT',
    routeFacts: {
      schemaVersion: '2.0.0',
      requestedEffect: 'mutate',
      successCriteria: 'ready',
      dependency: {
        shape: 'bounded', dependentWorkGroupCount: 0,
        integrationOwnerRequired: false, separateDependentBodies: 0,
      },
      uncertainty: 'none',
      reversibility: 'fully-reversible',
      mutableResources: ownership.map(resource => ({
        kind: resource.kind, identity: resource.identity, shared: false,
        ownershipMode: resource.ownershipMode,
      })),
      sideEffects: ['deliverable-write'],
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
        level: 'ordinary', minimumCheckerCount: 1,
        namedDistinctResponsibilities: ['external artifact behavior'],
      },
      checkAndBaseline: {
        checkQuality: 'authoritative', availableCheckKinds: ['focused-test'],
        baselineStatus: 'recorded', hiddenExternalCheck: false,
      },
      deadlineBudget: {
        remainingSeconds: 600, admissionSeconds: 240, executionReserveSeconds: 180,
        verificationReserveSeconds: 120, recoveryAndFinalizationReserveSeconds: 60,
      },
      operatorMinimumRoute: null,
      transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true },
      candidateFreeze: { required: true, available: true, environmentCanBeBound: true },
      missingUserInput: [],
      architectureImpact: 'local',
      fitsLightPlan: true,
      approachNeedsShortPlanning: false,
      shortOrderUnclear: false,
    },
    mutableResourceOwnership: ownership,
    requestedResult: ['Create the exact external patch script and patched binary.'],
    successChecklist: ['Both exact external outputs pass independent verification.'],
    checks: ['verify exact external outputs'],
    likelyAreas: ownership.map(resource => resource.identity),
    risksAndMissingInformation: [],
    workers: {
      count: 1,
      responsibilities: ['Own both exact external outputs.'],
      non_overlap_reason: 'One worker owns the bounded output pair.',
    },
    independentChecks: {
      checker_count: 1,
      responsibilities: ['Independently execute and inspect both outputs.'],
      separate_second_checker_reason: null,
    },
    chosenRouteReasons: ['The exact output identities and verification method are bounded.'],
    rejectedRouteReasons: {
      LIGHT: ['No reversible design uncertainty requires a plan.'],
      ROADMAP: ['No dependent work groups require integration.'],
    },
    analystComparison: {
      recommended_route: null,
      agrees: false,
      reason: 'The deterministic test decision treats analyst advice as unavailable.',
      analyst_facts_fingerprint: 'b'.repeat(64),
      analyst_classifier_fingerprint: 'c'.repeat(64),
    },
    routeChangeTrigger: {
      event: 'SPEC_MISUNDERSTOOD', new_fact_required: true,
      matching_rule: 'DIRECT_TO_LIGHT',
    },
    gateSelection: {
      baseWorkType: 'implement-build', resultFormat: 'new-build',
      artifactOverlays: ['executable-code'],
      acceptanceOverlays: ['failing-to-passing-behavior'],
      riskOverlays: [], riskEvidence: {},
    },
    requestEnvelopeHash: 'd'.repeat(64),
    recommendationHash: 'e'.repeat(64),
  })
}

test('mission-bound typed external outputs are writable, candidate-bound, and checker-readable', t => {
  const { target, external } = temporaryFixture(t)
  const script = path.join(external, 'build_asset.py')
  const output = path.join(external, 'compiled_asset.bin')
  const mission = `Create a reproducible patch script at ${script} and use it to write ${output}.`
  const ownership = externalOwnership(script, output)
  const assignment = workerAssignment(target, mission, ownership)
  assert.deepEqual(assignment.resources.map(resource => resource.identity).sort(), [output, script].sort())

  const candidateResources = candidateExternalLocalResources(ownership, target, mission)
  const workspaceOnlyHash = hashWorkspaceCandidate(target, process.env)
  const beforeHash = hashWorkspaceCandidate(target, process.env, candidateResources)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target)
  assert.deepEqual(boundary.writableRoots, [output, script].sort())

  fs.writeFileSync(script, 'print("patched")\n')
  fs.writeFileSync(output, 'asset bytes\n')
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [script, output],
  })
  commitExplicitExternalLocalBoundary(boundary, admission, { mutationStateCommitted: true })
  assert.deepEqual(admission.actualFilesChanged, [output, script].sort())
  const afterHash = hashWorkspaceCandidate(target, process.env, candidateResources)
  assert.notEqual(afterHash, beforeHash)
  assert.equal(hashWorkspaceCandidate(target, process.env), workspaceOnlyHash,
    'normal activation-target versioning remains unchanged without explicit external resources')

  const repairAssignment = workerAssignment(target, mission, ownership)
  const repairBoundary = materializeExplicitExternalLocalBoundary(repairAssignment, target)
  fs.writeFileSync(output, 'repaired asset bytes\n')
  const repairAdmission = inspectExplicitExternalLocalBoundary(
    repairBoundary,
    repairAssignment,
    target,
    { filesChanged: [output] },
  )
  commitExplicitExternalLocalBoundary(repairBoundary, repairAdmission, {
    mutationStateCommitted: true,
  })
  assert.deepEqual(repairAdmission.actualFilesChanged, [output])
  const repairedHash = hashWorkspaceCandidate(target, process.env, candidateResources)
  assert.notEqual(repairedHash, afterHash,
    'an external-only repair creates a distinct exact candidate version')
  fs.chmodSync(output, 0o700)
  const executableHash = hashWorkspaceCandidate(target, process.env, candidateResources)
  assert.notEqual(executableHash, repairedHash,
    'exact external candidate state includes executable mode, not only file bytes')
  assert.equal(hashWorkspaceCandidate(target, process.env), workspaceOnlyHash)

  const checkerResources = canonicalAssignmentResources({
    request: {
      workItemId: 'independent-check-1',
      assignment: 'Verify the exact candidate and its required outputs.',
      ownership: ['workspace'],
      manifests: ownership,
    },
    targetPath: target,
    canonicalTargetPath: target,
    logicalRole: 'independent-reviewer',
    readOnly: true,
    enforcePreimages: false,
    mission,
  })
  const checkerExternal = explicitExternalLocalResources({ resources: checkerResources }, target)
  assert.deepEqual(checkerExternal.map(resource => [resource.identity, resource.access]), [
    [output, 'read'], [script, 'read'],
  ].sort((left, right) => left[0].localeCompare(right[0])))
  assert.equal(hashWorkspaceCandidate(target, process.env, checkerExternal), executableHash)
})

test('external-output CHECK_WORK crash recovery retains both admitted deliverables and rejects foreign evidence', async t => {
  const { target, external } = temporaryFixture(t)
  const script = path.join(external, 'build_asset.py')
  const output = path.join(external, 'compiled_asset.bin')
  const foreign = path.join(external, 'foreign-durable-output')
  const mission = `Create a reproducible patch script at ${script} and use it to write ${output}.`
  const ownership = externalOwnership(script, output)
  fs.writeFileSync(script, '#!/usr/bin/env python3\nprint("built asset")\n', { mode: 0o700 })
  fs.writeFileSync(output, Buffer.from('ASSET\0compiled-binary\n'))
  fs.chmodSync(output, 0o700)
  fs.writeFileSync(foreign, 'foreign mutation\n')

  const candidateResources = candidateExternalLocalResources(ownership, target, mission)
  const candidateHash = hashWorkspaceCandidate(target, process.env, candidateResources)
  const admission = {
    schemaVersion: 1,
    files: [script, output].map(identity => ({
      relative: identity,
      hash: sha256(fs.readFileSync(identity)),
    })),
  }
  const launches = []
  const readAdmissions = []
  const execute = createDefaultRouteExecutor({
    targetPath: target,
    mission,
    gitEnvironment: () => process.env,
    transition: async () => {},
    readMutationAdmission(workItemId) {
      readAdmissions.push(workItemId)
      return workItemId === 'work-1' ? admission : null
    },
    harnessAttestation: (exactHash, oracle) => ({
      repoHash: exactHash,
      buildHash: 'a'.repeat(64),
      oracleHash: sha256(oracle),
    }),
  })
  const resumeState = {
    resumeState: 'CHECK_WORK',
    candidateHash,
    completedWorkIds: ['work-1'],
    completedCheckIds: [],
    acceptedResultIds: [],
    nextReadyWorkIds: ['independent-check-1'],
    retryState: {},
  }
  const outcome = await execute({
    route: 'DIRECT',
    decision: externalRouteDecision(ownership),
    launch: async request => {
      launches.push(request.workItemId)
      assert.equal(request.candidateHash, candidateHash)
      assert.deepEqual(request.manifests.map(item => item.identity).sort(), [output, script].sort())
      return checkerPass(request)
    },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState,
  })
  assert.equal(outcome.outcome, 'DONE', JSON.stringify(outcome))
  assert.deepEqual(launches, ['independent-check-1'])
  assert.deepEqual(readAdmissions, ['work-1'])
  assert.deepEqual(outcome.deliverables.filter(item => [script, output].includes(item.path)), [
    { path: output, hash: sha256(fs.readFileSync(output)), type: 'file' },
    { path: script, hash: sha256(fs.readFileSync(script)), type: 'file' },
  ].sort((left, right) => left.path.localeCompare(right.path)))

  let foreignLaunches = 0
  const rejectForeign = createDefaultRouteExecutor({
    targetPath: target,
    mission,
    gitEnvironment: () => process.env,
    transition: async () => {},
    readMutationAdmission(workItemId) {
      assert.equal(workItemId, 'work-1')
      return {
        schemaVersion: 1,
        files: [...admission.files, {
          relative: foreign,
          hash: sha256(fs.readFileSync(foreign)),
        }],
      }
    },
  })
  await assert.rejects(rejectForeign({
    route: 'DIRECT',
    decision: externalRouteDecision(ownership),
    launch: async () => { foreignLaunches += 1; return checkerPass({ checks: [] }) },
    completeRetainedLease: () => {},
    resumeAdoptedLaunches: async () => ({}),
    resumeState,
  }), error => error.code === 'CRASH_ADOPTION_CONFLICT')
  assert.equal(foreignLaunches, 0)
})

test('nested directory mode is part of the exact external candidate hash', t => {
  const { target, external } = temporaryFixture(t)
  const tree = path.join(external, 'output-tree')
  const nested = path.join(tree, 'nested')
  fs.mkdirSync(nested, { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(nested, 'result.bin'), 'same bytes\n')
  const ownership = [{
    kind: 'directory', identity: tree, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const mission = `Create the exact directory output ${tree}.`
  const resources = candidateExternalLocalResources(ownership, target, mission)
  const before = hashWorkspaceCandidate(target, process.env, resources)
  fs.chmodSync(nested, 0o711)
  const after = hashWorkspaceCandidate(target, process.env, resources)
  assert.notEqual(after, before,
    'chmod on a nested directory must change the frozen external candidate identity')
})

test('cache and existing or missing directory-valued outputs materialize with safe physical types', t => {
  const { target, external } = temporaryFixture(t)
  const existingCache = path.join(external, 'existing-cache')
  const missingCache = path.join(external, 'missing-cache')
  const existingOutputDirectory = path.join(external, 'existing-output-directory')
  const missingOutputDirectory = path.join(external, 'missing-output-directory')
  const missingGenericOutput = path.join(external, 'missing-generic-output')
  fs.mkdirSync(existingCache)
  fs.writeFileSync(path.join(existingCache, 'cache-entry'), 'keep cache\n')
  fs.mkdirSync(existingOutputDirectory)
  fs.writeFileSync(path.join(existingOutputDirectory, 'artifact'), 'keep output\n')
  const ownership = [
    { kind: 'cache', identity: existingCache, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'cache', identity: missingCache, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'output', identity: existingOutputDirectory, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'directory', identity: missingOutputDirectory, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'output', identity: missingGenericOutput, owner: 'worker-1', ownershipMode: 'single-owner' },
  ]
  const mission = `Use cache roots ${existingCache} and ${missingCache}; preserve or update the directory output ${existingOutputDirectory}; create the directory output ${missingOutputDirectory}; and create ${missingGenericOutput}.`
  const assignment = workerAssignment(target, mission, ownership)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target)
  const types = Object.fromEntries(boundary.resources.map(resource => [
    resource.identity, resource.materializedType,
  ]))
  assert.equal(types[existingCache], 'directory')
  assert.equal(types[missingCache], 'directory')
  assert.equal(types[existingOutputDirectory], 'directory')
  assert.equal(types[missingOutputDirectory], 'directory')
  assert.equal(types[missingGenericOutput], 'file')
  assert.equal(fs.readFileSync(path.join(existingCache, 'cache-entry'), 'utf8'), 'keep cache\n')
  assert.equal(fs.readFileSync(path.join(existingOutputDirectory, 'artifact'), 'utf8'), 'keep output\n')

  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [],
  })
  commitExplicitExternalLocalBoundary(boundary, admission, { mutationStateCommitted: true })
  assert.deepEqual(admission.actualFilesChanged, [])
  assert.equal(fs.existsSync(missingCache), false)
  assert.equal(fs.existsSync(missingOutputDirectory), false)
  assert.equal(fs.existsSync(missingGenericOutput), false)
  assert.equal(fs.existsSync(existingCache), true)
  assert.equal(fs.existsSync(existingOutputDirectory), true)
})

test('outside paths require both immutable-mission text and typed ownership', t => {
  const { target, external } = temporaryFixture(t)
  const requested = path.join(external, 'requested.txt')
  const unmentioned = path.join(external, 'unmentioned.txt')
  const typed = [{ kind: 'file', identity: requested, owner: 'worker-1', ownershipMode: 'single-owner' }]
  assert.throws(() => workerAssignment(target, 'Create a bounded result.', typed),
    error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED')
  assert.throws(() => workerAssignment(target, `Create ${requested}.`, [
    { kind: 'file', identity: unmentioned, owner: 'worker-1', ownershipMode: 'single-owner' },
  ]), error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED')
})

test('external output authority rejects a linked path prefix and an unauthorized report', t => {
  const { target, external } = temporaryFixture(t)
  const real = path.join(external, 'real')
  const linked = path.join(external, 'linked')
  fs.mkdirSync(real)
  try { fs.symlinkSync(real, linked, 'dir') } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return
    throw error
  }
  const escaped = path.join(linked, 'result.txt')
  const ownership = [{ kind: 'file', identity: escaped, owner: 'worker-1', ownershipMode: 'single-owner' }]
  assert.throws(() => workerAssignment(target, `Create ${escaped}.`, ownership),
    error => error.code === 'MISSION_PATH_INVALID')

  const exact = path.join(external, 'exact.txt')
  const exactOwnership = [{ kind: 'file', identity: exact, owner: 'worker-1', ownershipMode: 'single-owner' }]
  const assignment = workerAssignment(target, `Create ${exact}.`, exactOwnership)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target)
  fs.writeFileSync(exact, 'exact output\n')
  assert.throws(() => inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [exact, path.join(external, 'sibling.txt')],
  }), error => error.code === 'OWNERSHIP_SCOPE_VIOLATION')
  rollbackExplicitExternalLocalBoundary(boundary, target)
})

test('mid-materialization failure rolls back only unchanged tool-created placeholders', t => {
  const { target, external } = temporaryFixture(t)
  const firstPlaceholder = path.join(external, 'a-placeholder.txt')
  const missingParentOutput = path.join(external, 'z-missing-parent', 'artifact.txt')
  const preexistingSibling = path.join(external, 'preexisting.txt')
  fs.writeFileSync(preexistingSibling, 'must survive rollback\n')
  const ownership = [
    { kind: 'file', identity: firstPlaceholder, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'file', identity: missingParentOutput, owner: 'worker-1', ownershipMode: 'single-owner' },
  ]
  const mission = `Create ${firstPlaceholder} and ${missingParentOutput}.`
  const assignment = workerAssignment(target, mission, ownership)
  assert.throws(
    () => materializeExplicitExternalLocalBoundary(assignment, target),
    error => error.code === 'EXTERNAL_LOCAL_RESOURCE_INVALID',
  )
  assert.equal(fs.existsSync(firstPlaceholder), false,
    'the earlier unchanged placeholder is removed when a later resource cannot materialize')
  assert.equal(fs.existsSync(missingParentOutput), false)
  assert.equal(fs.readFileSync(preexistingSibling, 'utf8'), 'must survive rollback\n')
})

test('failed Codex launch cleanup rolls back every unadmitted exact external postimage', async t => {
  const { root, target, external } = temporaryFixture(t)
  const privateWorkspace = path.join(root, 'private-worker')
  const clone = childProcess.spawnSync('git', ['clone', '--quiet', target, privateWorkspace], {
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(clone.status, 0, clone.stderr || clone.stdout)
  const unchanged = path.join(external, 'artifact-unchanged.txt')
  const changed = path.join(external, 'artifact-changed.txt')
  const preexistingSibling = path.join(external, 'sibling.txt')
  fs.writeFileSync(preexistingSibling, 'preexisting sibling\n')
  const mission = `Create ${unchanged} and ${changed}.`
  const ownership = [
    { kind: 'file', identity: unchanged, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'file', identity: changed, owner: 'worker-1', ownershipMode: 'single-owner' },
  ]
  const canonicalAssignment = workerAssignment(target, mission, ownership)
  const externalLocalBoundary = materializeExplicitExternalLocalBoundary(canonicalAssignment, target)
  const projection = createCanonicalMissionProjection(mission)
  const requestEnvelopeHash = 'a'.repeat(64)
  let launched
  const adapter = new CodexExecAdapter({
    runner: {
      async run(spec) {
        launched = spec
        fs.writeFileSync(changed, 'worker-authored bytes survive launch failure\n')
        throw Object.assign(new Error('captured exact launch'), { code: 'TEST_CAPTURED' })
      },
    },
    targetPath: target,
    profilePath: target,
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  await assert.rejects((async () => {
    try {
      return await adapter.launch({
        activationId: 'external-local-activation', generation: 1, workItemId: 'work-1',
        canonicalMission: projection.canonicalMission,
        missionBinding: bindCanonicalMissionForChild(projection, {
          sourceRequestHash: projection.sourceRequestHash,
          requestEnvelopeHash,
          activationId: 'external-local-activation',
          generation: 1,
          workItemId: 'work-1',
        }),
        logicalRole: 'worker', physicalRole: 'autoprompt.v2.worker', providerRole: 'ap-worker',
        physicalExecutionPolicy: {
          logicalRole: 'worker', physicalRole: 'autoprompt.v2.worker', providerRole: 'ap-worker',
          sandboxMode: 'workspace-write', policyId: 'external-local-policy', policyVersion: 1,
          canDispatch: false, resourceSets: { read: [], write: ['workspace'], exclusive: [] },
        },
        dispatch: { brief: 'bounded external local work', requestPointer: { hash: requestEnvelopeHash } },
        canonicalAssignment,
        canonicalTargetPath: target,
        workingDirectory: privateWorkspace,
        workerWorkspace: { workspaceId: 'private-worker', binding: { bindingHash: 'b'.repeat(64) } },
        externalLocalBoundary,
        sessionId: 'external-local-session', reservationId: 'external-local-reservation', environment: {},
      })
    } catch (error) {
      removeUnchangedExternalLocalPlaceholders(externalLocalBoundary, target)
      throw error
    }
  })(), error => error.code === 'TEST_CAPTURED')
  const writableRoots = [changed, unchanged].sort()
  const configIndex = launched.argv.indexOf(
    `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`,
  )
  assert.ok(configIndex > 0)
  assert.equal(launched.argv[configIndex - 1], '-c')
  assert.match(launched.stdin, /AUTOPROMPT_EXPLICIT_EXTERNAL_LOCAL_V1/u)
  for (const identity of writableRoots) {
    assert.match(launched.stdin, new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
  }
  assert.doesNotMatch(launched.stdin, /sibling\.txt/u)
  assert.equal(fs.existsSync(unchanged), false,
    'an unchanged tool-created placeholder is removed after launch failure')
  assert.equal(fs.existsSync(changed), false,
    'worker bytes without mutation admission or a transport receipt are rolled back')
  assert.equal(fs.readFileSync(preexistingSibling, 'utf8'), 'preexisting sibling\n')
  const privateProjectionLine = launched.stdin.split('\n')
    .find(line => line.startsWith('Private workspace projection: '))
  assert.ok(privateProjectionLine)
  const privateProjection = JSON.parse(privateProjectionLine.slice('Private workspace projection: '.length))
  assert.deepEqual(privateProjection.resources, [],
    'exact external resources stay out of activation-target private-clone projection and CAS')
})

test('external pre-admission transaction restores missing, preexisting, and directory outputs', t => {
  const { root, target, external } = temporaryFixture(t)
  const missing = path.join(external, 'missing.txt')
  const existing = path.join(external, 'existing.bin')
  const directory = path.join(external, 'output-directory')
  fs.writeFileSync(existing, 'original bytes\n', { mode: 0o640 })
  fs.mkdirSync(directory, { mode: 0o750 })
  fs.writeFileSync(path.join(directory, 'original.txt'), 'original tree\n', { mode: 0o600 })
  const ownership = [
    { kind: 'file', identity: missing, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'output', identity: existing, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'directory', identity: directory, owner: 'worker-1', ownershipMode: 'single-owner' },
  ]
  const assignment = workerAssignment(
    target,
    `Create ${missing}, update ${existing}, and update ${directory}.`,
    ownership,
  )
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'attempt-1'),
  })
  fs.writeFileSync(missing, 'partial missing output\n')
  fs.writeFileSync(existing, 'partial overwrite\n')
  fs.rmSync(directory, { recursive: true })
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'partial.txt'), 'partial tree\n')

  rollbackExplicitExternalLocalBoundary(boundary, target)
  assert.equal(fs.existsSync(missing), false)
  assert.equal(fs.readFileSync(existing, 'utf8'), 'original bytes\n')
  assert.equal(fs.statSync(existing).mode & 0o777, 0o640)
  assert.deepEqual(fs.readdirSync(directory), ['original.txt'])
  assert.equal(fs.readFileSync(path.join(directory, 'original.txt'), 'utf8'), 'original tree\n')
  assert.equal(fs.statSync(directory).mode & 0o777, 0o750)
})

test('post-external pre-local failure keeps rollback authority until mutation state commits', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'atomic-output.bin')
  fs.writeFileSync(output, 'original external bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update ${output}.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'atomic-attempt')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot,
  })
  fs.writeFileSync(output, 'admitted external postimage\n', { mode: 0o600 })
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })

  assert.throws(
    () => commitExplicitExternalLocalBoundary(boundary, admission),
    error => error.code === 'EXTERNAL_LOCAL_COMMIT_PREMATURE',
  )
  assert.equal(fs.existsSync(transactionRoot), true,
    'a local CAS/state failure must still have its exact external preimage transaction')

  rollbackExplicitExternalLocalBoundary(boundary, target)
  assert.equal(fs.readFileSync(output, 'utf8'), 'original external bytes\n')
  assert.equal(fs.statSync(output).mode & 0o777, 0o640)
  assert.equal(fs.existsSync(transactionRoot), false)
})

test('interrupted external transaction deterministically rolls back before restart materialization', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'restart-output')
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Create ${output}.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'stable-attempt')
  materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  fs.writeFileSync(output, 'bytes left by a dead process\n')

  const restarted = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  assert.equal(fs.readFileSync(output, 'utf8'), '',
    'restart restores the canonical missing preimage before creating its new placeholder')
  rollbackExplicitExternalLocalBoundary(restarted, target)
  assert.equal(fs.existsSync(output), false)
})

test('receipt-bound external quarantine seeds one immediate retry and commits exact postimages', t => {
  const { root, target, external } = temporaryFixture(t)
  const script = path.join(external, 'patch.py')
  const output = path.join(external, 'patched.bin')
  fs.writeFileSync(output, 'original binary\n', { mode: 0o700 })
  const ownership = externalOwnership(script, output)
  const mission = `Create ${script} and update ${output}.`
  const sourceAssignment = workerAssignment(target, mission, ownership)
  const quarantineRoot = path.join(root, 'controller', 'quarantines')
  const sourceBoundary = materializeExplicitExternalLocalBoundary(sourceAssignment, target, {
    transactionRoot: path.join(root, 'controller', 'source-attempt'),
    quarantineRoot,
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(script, '# partial script\n')
  fs.writeFileSync(output, 'partial binary\n')
  const receiptHash = 'a'.repeat(64)
  const pointer = quarantineExplicitExternalLocalBoundary(sourceBoundary, target, {
    sourceWorkItemId: 'work-1',
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: receiptHash,
  })
  assert.equal(fs.existsSync(script), false)
  assert.equal(fs.readFileSync(output, 'utf8'), 'original binary\n')
  assert.deepEqual(externalLocalTransportQuarantinePointer({ recordPath: pointer.recordPath }), pointer,
    'restart reopens the same receipt-bound pointer')

  const retryAssignment = workerAssignment(target, mission, ownership)
  const retryBoundary = materializeExplicitExternalLocalBoundary(retryAssignment, target, {
    transactionRoot: path.join(root, 'controller', 'retry-attempt'),
  })
  seedExplicitExternalLocalBoundaryFromQuarantine(
    retryBoundary,
    retryAssignment,
    target,
    pointer,
    { retryWorkItemId: 'work-1-transport-retry-1', transportReceiptHash: receiptHash },
  )
  assert.equal(fs.readFileSync(script, 'utf8'), '# partial script\n')
  assert.equal(fs.readFileSync(output, 'utf8'), 'partial binary\n')
  fs.appendFileSync(script, '# completed\n')
  const admission = inspectExplicitExternalLocalBoundary(retryBoundary, retryAssignment, target, {
    filesChanged: [script, output],
  })
  commitExplicitExternalLocalBoundary(retryBoundary, admission, { mutationStateCommitted: true })
  assert.equal(fs.readFileSync(script, 'utf8'), '# partial script\n# completed\n')
  assert.equal(fs.readFileSync(output, 'utf8'), 'partial binary\n')
})

test('tampered quarantine and linked prefixes fail closed without deleting outside authority', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'output.bin')
  const ownership = [{
    kind: 'file', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const mission = `Create ${output}.`
  const sourceAssignment = workerAssignment(target, mission, ownership)
  const sourceBoundary = materializeExplicitExternalLocalBoundary(sourceAssignment, target, {
    transactionRoot: path.join(root, 'controller', 'tamper-source'),
  })
  fs.writeFileSync(output, 'partial bytes\n')
  const pointer = quarantineExplicitExternalLocalBoundary(sourceBoundary, target, {
    sourceWorkItemId: 'work-1',
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: 'b'.repeat(64),
  })
  const record = JSON.parse(fs.readFileSync(pointer.recordPath, 'utf8'))
  fs.writeFileSync(record.resources[0].snapshotPath, 'tampered bytes\n')
  const retryAssignment = workerAssignment(target, mission, ownership)
  const retryBoundary = materializeExplicitExternalLocalBoundary(retryAssignment, target, {
    transactionRoot: path.join(root, 'controller', 'tamper-retry'),
  })
  assert.throws(() => seedExplicitExternalLocalBoundaryFromQuarantine(
    retryBoundary,
    retryAssignment,
    target,
    pointer,
    { retryWorkItemId: 'work-1-transport-retry-1', transportReceiptHash: 'b'.repeat(64) },
  ), error => error.code === 'EXTERNAL_LOCAL_QUARANTINE_TAMPERED')
  rollbackExplicitExternalLocalBoundary(retryBoundary, target)
  assert.equal(fs.existsSync(output), false)

  const parent = path.join(external, 'owned-parent')
  const displacedParent = path.join(external, 'owned-parent-displaced')
  const foreign = path.join(external, 'foreign-parent')
  fs.mkdirSync(parent)
  fs.mkdirSync(foreign)
  const foreignFile = path.join(foreign, 'linked-output')
  fs.writeFileSync(foreignFile, 'must survive\n')
  const linkedOutput = path.join(parent, 'linked-output')
  const linkedAssignment = workerAssignment(target, `Create ${linkedOutput}.`, [{
    kind: 'file', identity: linkedOutput, owner: 'worker-1', ownershipMode: 'single-owner',
  }])
  const linkedBoundary = materializeExplicitExternalLocalBoundary(linkedAssignment, target, {
    transactionRoot: path.join(root, 'controller', 'linked-attempt'),
  })
  fs.renameSync(parent, displacedParent)
  fs.symlinkSync(foreign, parent, 'dir')
  assert.throws(() => rollbackExplicitExternalLocalBoundary(linkedBoundary, target),
    error => error.code === 'MISSION_PATH_INVALID')
  assert.equal(fs.readFileSync(foreignFile, 'utf8'), 'must survive\n')
  fs.unlinkSync(parent)
  fs.renameSync(displacedParent, parent)
  rollbackExplicitExternalLocalBoundary(linkedBoundary, target)
})
