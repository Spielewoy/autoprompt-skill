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
  CodexSupervisorRuntime,
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
  preserveExplicitExternalLocalCandidate,
  externalLocalTransportQuarantinePointer,
  seedExplicitExternalLocalBoundaryFromQuarantine,
  workspaceFileSnapshot,
} = require('../../agents/codex/workflow/phase-budget.js')
const { createRouteDecision } = require('../../agents/codex/workflow/route-decision.js')
const { stableStringify } = require('../../agents/codex/workflow/event-log.js')

function samePhysicalPath(left, right) {
  if (left === right) return true
  try { return fs.realpathSync.native(left) === fs.realpathSync.native(right) } catch (_) {
    return false
  }
}

function physicalParentIncludes(candidate, fragment) {
  if (String(candidate).includes(fragment)) return true
  try { return fs.realpathSync.native(path.dirname(candidate)).includes(fragment) } catch (_) {
    return false
  }
}

function sameLogicalLeaf(left, right) {
  if (samePhysicalPath(left, right)) return true
  if (path.basename(String(left)) !== path.basename(String(right))) return false
  try {
    return fs.realpathSync.native(path.dirname(left)) ===
      fs.realpathSync.native(path.dirname(right))
  } catch (_) {
    return false
  }
}

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

function externalTransactionIdentity({ runId, activationId, workItemId, leaseId, permit, isolation }) {
  const body = {
    schemaVersion: 1,
    kind: 'external-local-transaction-identity',
    runId,
    activationId,
    workItemId,
    schedulerLeaseId: leaseId,
    permitHash: sha256(stableStringify(permit)),
    isolationBindingHash: isolation.bindingHash,
  }
  return Object.freeze({ ...body, bindingHash: sha256(stableStringify(body)) })
}

function writeChecksummedRecord(recordPath, body) {
  const record = { ...body, checksum: sha256(stableStringify(body)) }
  fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`)
  return record
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
  const mission = `Create a reproducible patch script at \`${script}\` and use it to write \`${output}\`.`
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
  const mission = `Create a reproducible patch script at \`${script}\` and use it to write \`${output}\`.`
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
  const mission = `Create the exact directory output \`${tree}\`.`
  const resources = candidateExternalLocalResources(ownership, target, mission)
  const before = hashWorkspaceCandidate(target, process.env, resources)
  fs.chmodSync(nested, 0o711)
  const after = hashWorkspaceCandidate(target, process.env, resources)
  assert.notEqual(after, before,
    'chmod on a nested directory must change the frozen external candidate identity')
})

test('external mission authority never binds a shorter whitespace-delimited path prefix', t => {
  const { target, external } = temporaryFixture(t)
  const shorter = path.join(external, 'input')
  const requested = path.join(external, 'input image.png')
  fs.writeFileSync(shorter, 'shorter existing file\n')
  fs.writeFileSync(requested, 'requested file with spaces\n')
  const ownership = [{
    kind: 'file', identity: shorter, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  assert.throws(
    () => candidateExternalLocalResources(
      ownership, target, `Modify ${requested} and leave the input intact.`,
    ),
    error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED',
  )
  assert.equal(candidateExternalLocalResources(
    ownership, target, `Modify \`${shorter}\`.`,
  )[0].identity, shorter)

  const spacedPrefix = path.join(external, 'input image')
  const longerSpacedPath = path.join(external, 'input image final.png')
  fs.writeFileSync(spacedPrefix, 'spaced prefix file\n')
  fs.writeFileSync(longerSpacedPath, 'longer spaced file\n')
  const spacedOwnership = [{
    kind: 'file', identity: spacedPrefix, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  assert.throws(
    () => candidateExternalLocalResources(
      spacedOwnership, target, `Modify ${longerSpacedPath} only.`,
    ),
    error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED',
  )
  assert.equal(candidateExternalLocalResources(
    spacedOwnership, target, `Modify \`${spacedPrefix}\` only.`,
  )[0].identity, spacedPrefix)

  const absentLongerPath = path.join(external, 'input final')
  assert.equal(fs.existsSync(absentLongerPath), false)
  assert.throws(
    () => candidateExternalLocalResources(
      ownership, target, `Create ${absentLongerPath} now.`,
    ),
    error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED',
  )
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
  const mission = `Use cache roots \`${existingCache}\` and \`${missingCache}\`; preserve or update the directory output \`${existingOutputDirectory}\`; create the directory output \`${missingOutputDirectory}\`; and create \`${missingGenericOutput}\`.`
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
  assert.throws(() => workerAssignment(target, `Create \`${requested}\`.`, [
    { kind: 'file', identity: unmentioned, owner: 'worker-1', ownershipMode: 'single-owner' },
  ]), error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED')
})

test('external path admission reads exact decoded canonical-request values', t => {
  const { target, external } = temporaryFixture(t)
  const requested = path.join(external, 'requested-output')
  const sibling = `${requested}-shadow`
  const ownership = [{
    kind: 'directory', identity: requested, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const canonicalRequest = JSON.stringify({
    argv: ['--path', 'ROADMAP', `Create the exact output at ${requested}\nThen verify it.`],
    controls: { path: 'ROADMAP' },
  })

  assert.equal(candidateExternalLocalResources(
    ownership,
    target,
    canonicalRequest,
  )[0].identity, requested)
  assert.equal(candidateExternalLocalResources(
    ownership,
    target,
    JSON.parse(canonicalRequest),
  )[0].identity, requested)
  assert.throws(() => candidateExternalLocalResources([{
    ...ownership[0], identity: sibling,
  }], target, canonicalRequest), error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED')
  assert.throws(() => candidateExternalLocalResources(ownership, target, JSON.stringify({
    [requested]: 'structural metadata is not user authorization',
  })), error => error.code === 'OWNERSHIP_AUTHORIZATION_DENIED')
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
  assert.throws(() => workerAssignment(target, `Create \`${escaped}\`.`, ownership),
    error => error.code === 'MISSION_PATH_INVALID')

  const exact = path.join(external, 'exact.txt')
  const exactOwnership = [{ kind: 'file', identity: exact, owner: 'worker-1', ownershipMode: 'single-owner' }]
  const assignment = workerAssignment(target, `Create \`${exact}\`.`, exactOwnership)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target)
  fs.writeFileSync(exact, 'exact output\n')
  assert.throws(() => inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [exact, path.join(external, 'sibling.txt')],
  }), error => error.code === 'OWNERSHIP_SCOPE_VIOLATION')
  const cleanupAdmission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    allAssignedItemsPass: false, filesChanged: [exact],
  })
  rollbackExplicitExternalLocalBoundary(boundary, target, cleanupAdmission)
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
  const mission = `Create \`${firstPlaceholder}\` and \`${missingParentOutput}\`.`
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

test('failed Codex launch cleanup removes untouched slots but preserves changed exact external bytes', async t => {
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
  const mission = `Create \`${unchanged}\` and \`${changed}\`.`
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
  assert.equal(fs.readFileSync(changed, 'utf8'),
    'worker-authored bytes survive launch failure\n',
    'physical work is retained when no admission receipt authorizes destructive rollback')
  assert.equal(fs.existsSync(externalLocalBoundary.transaction.root), true,
    'the authenticated preimage transaction remains available for later reconciliation')
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
    `Create \`${missing}\`, update \`${existing}\`, and update \`${directory}\`.`,
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

  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    allAssignedItemsPass: false, filesChanged: [missing, existing, directory],
  })
  rollbackExplicitExternalLocalBoundary(boundary, target, admission)
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
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
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

  rollbackExplicitExternalLocalBoundary(boundary, target, admission)
  assert.equal(fs.readFileSync(output, 'utf8'), 'original external bytes\n')
  assert.equal(fs.statSync(output).mode & 0o777, 0o640)
  assert.equal(fs.existsSync(transactionRoot), false)
})

test('external commit rejects a same-path link swap and retains rollback authority', t => {
  if (process.platform !== 'linux') return
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'commit-swap.bin')
  const displaced = path.join(external, 'commit-swap-displaced.bin')
  const victim = path.join(external, 'foreign-same-bytes.bin')
  fs.writeFileSync(output, 'baseline\n', { mode: 0o640 })
  fs.writeFileSync(victim, 'admitted bytes\n', { mode: 0o600 })
  fs.chmodSync(victim, 0o600)
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'commit-swap-attempt')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  fs.writeFileSync(output, 'admitted bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })

  const originalOpen = fs.openSync
  let swapped = false
  fs.openSync = (filename, flags, mode) => {
    if (!swapped && sameLogicalLeaf(filename, output) && typeof flags === 'number') {
      swapped = true
      fs.renameSync(output, displaced)
      fs.symlinkSync(victim, output)
    }
    return originalOpen(filename, flags, mode)
  }
  try {
    assert.throws(
      () => commitExplicitExternalLocalBoundary(
        boundary,
        admission,
        { mutationStateCommitted: true },
      ),
      error => ['PREIMAGE_UNSAFE', 'EXTERNAL_LOCAL_TRANSACTION_UNSAFE'].includes(error.code),
    )
  } finally {
    fs.openSync = originalOpen
  }
  assert.equal(swapped, true)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'admitted bytes\n')
  assert.equal(fs.existsSync(transactionRoot), true)
})

test('external commit rejects a linked parent swap even when it resolves to the same inode', t => {
  if (process.platform !== 'linux') return
  const { root, target, external } = temporaryFixture(t)
  const ownedParent = path.join(external, 'commit-parent')
  const displacedParent = path.join(external, 'commit-parent-displaced')
  fs.mkdirSync(ownedParent)
  const output = path.join(ownedParent, 'result.bin')
  fs.writeFileSync(output, 'baseline\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'commit-parent-swap')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  fs.writeFileSync(output, 'admitted bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })

  const originalOpen = fs.openSync
  let swapped = false
  fs.openSync = (filename, flags, mode) => {
    if (!swapped && sameLogicalLeaf(filename, output) && typeof flags === 'number') {
      swapped = true
      fs.renameSync(ownedParent, displacedParent)
      fs.symlinkSync(displacedParent, ownedParent, 'dir')
    }
    return originalOpen(filename, flags, mode)
  }
  try {
    assert.throws(
      () => commitExplicitExternalLocalBoundary(
        boundary,
        admission,
        { mutationStateCommitted: true },
      ),
      error => error.code === 'MISSION_PATH_INVALID',
    )
  } finally {
    fs.openSync = originalOpen
  }
  assert.equal(swapped, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'admitted bytes\n')
  assert.equal(fs.lstatSync(ownedParent).isSymbolicLink(), true)
  assert.equal(fs.existsSync(transactionRoot), true)
})

test('admission-bound rollback preserves a later external writer as a CAS conflict', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'cas-output.bin')
  fs.writeFileSync(output, 'baseline\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'cas-attempt'),
  })
  fs.writeFileSync(output, 'admitted worker bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })

  fs.writeFileSync(output, 'later-legitimate-winner\n', { mode: 0o644 })
  fs.chmodSync(output, 0o644)
  assert.throws(
    () => rollbackExplicitExternalLocalBoundary(boundary, target, admission),
    error => error.code === 'EXTERNAL_LOCAL_ROLLBACK_STALE',
  )
  assert.equal(fs.readFileSync(output, 'utf8'), 'later-legitimate-winner\n')
  assert.equal(fs.statSync(output).mode & 0o777, 0o644)
  assert.equal(fs.existsSync(boundary.transaction.root), true,
    'the controller retains its preimage record instead of overwriting the later winner')
})

test('directory rollback never follows a leaf swapped to a foreign directory link', t => {
  if (process.platform === 'win32') return
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'owned-directory')
  const displaced = path.join(external, 'owned-directory-displaced')
  const victim = path.join(external, 'victim-directory')
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(output, 'owned.txt'), 'owned baseline\n')
  fs.mkdirSync(victim)
  const victimFile = path.join(victim, 'foreign.txt')
  fs.writeFileSync(victimFile, 'foreign bytes must survive\n')
  const ownership = [{
    kind: 'directory', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'directory-swap-attempt'),
  })
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [],
  })
  const originalRename = fs.renameSync
  let swapped = false
  fs.renameSync = (source, destination) => {
    if (!swapped && samePhysicalPath(source, output)) {
      swapped = true
      originalRename(output, displaced)
      fs.symlinkSync(victim, output, 'dir')
    }
    return originalRename(source, destination)
  }
  try {
    assert.throws(
      () => rollbackExplicitExternalLocalBoundary(boundary, target, admission),
      error => ['PREIMAGE_UNSAFE', 'EXTERNAL_LOCAL_TRANSACTION_UNSAFE',
        'EXTERNAL_LOCAL_ROLLBACK_STALE'].includes(error.code),
    )
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(fs.readFileSync(victimFile, 'utf8'), 'foreign bytes must survive\n')
})

test('directory no-replace publication never chmods or writes through a swapped public link', t => {
  if (process.platform !== 'linux') return
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'published-directory')
  const displaced = path.join(external, 'controller-created-directory')
  const victim = path.join(external, 'foreign-directory')
  fs.mkdirSync(output, { mode: 0o750 })
  fs.chmodSync(output, 0o750)
  fs.writeFileSync(path.join(output, 'baseline.txt'), 'baseline tree\n', { mode: 0o600 })
  fs.mkdirSync(victim, { mode: 0o711 })
  fs.chmodSync(victim, 0o711)
  const victimFile = path.join(victim, 'foreign.txt')
  fs.writeFileSync(victimFile, 'foreign tree must survive\n', { mode: 0o640 })
  const ownership = [{
    kind: 'directory', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'directory-publication-race')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  fs.rmSync(output, { recursive: true })
  fs.mkdirSync(output, { mode: 0o700 })
  fs.writeFileSync(path.join(output, 'worker.txt'), 'worker tree\n')
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })

  const originalMkdir = fs.mkdirSync
  let swapped = false
  fs.mkdirSync = (directory, options) => {
    const result = originalMkdir(directory, options)
    if (!swapped && sameLogicalLeaf(directory, output)) {
      swapped = true
      fs.renameSync(output, displaced)
      fs.symlinkSync(victim, output, 'dir')
    }
    return result
  }
  try {
    assert.throws(
      () => rollbackExplicitExternalLocalBoundary(boundary, target, admission),
      error => error.code === 'EXTERNAL_LOCAL_ROLLBACK_STALE',
    )
  } finally {
    fs.mkdirSync = originalMkdir
  }
  assert.equal(swapped, true)
  assert.equal(fs.readFileSync(victimFile, 'utf8'), 'foreign tree must survive\n')
  assert.equal(fs.statSync(victim).mode & 0o777, 0o711)
  assert.deepEqual(fs.readdirSync(victim), ['foreign.txt'])
  assert.equal(fs.existsSync(transactionRoot), true,
    'publication ambiguity retains exact preimage and captured postimage authority')
})

test('execution-limit survival freezes changed external bytes and ignores untouched placeholders', t => {
  const { root, target, external } = temporaryFixture(t)
  const existing = path.join(external, 'existing-output.bin')
  const untouched = path.join(external, 'untouched-output.bin')
  fs.writeFileSync(existing, 'original external bytes\n', { mode: 0o640 })
  const ownership = [
    { kind: 'output', identity: existing, owner: 'worker-1', ownershipMode: 'single-owner' },
    { kind: 'output', identity: untouched, owner: 'worker-1', ownershipMode: 'single-owner' },
  ]
  const assignment = workerAssignment(
    target,
    `Update \`${existing}\` and create \`${untouched}\`.`,
    ownership,
  )
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'limit-attempt'),
    quarantineRoot: path.join(root, 'controller', 'transport-quarantines'),
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(existing, 'partial but exact external candidate\n', { mode: 0o600 })
  fs.chmodSync(existing, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    allAssignedItemsPass: false,
    filesChanged: [],
  })
  assert.deepEqual(admission.actualFilesChanged, [existing])
  assert.equal(fs.existsSync(untouched), false,
    'an untouched missing-output placeholder is not evidence of product work')
  const pointer = preserveExplicitExternalLocalCandidate(boundary, admission, {
    workItemId: 'work-1',
    reasonCode: 'CHILD_ROLLOUT_BUDGET_EXHAUSTED',
    candidateHash: 'c'.repeat(64),
  })
  assert.equal(pointer.disposition, 'PRESERVED_WITHOUT_DONE_AUTHORITY')
  assert.equal(pointer.changedPathCount, 1)
  const manifest = JSON.parse(fs.readFileSync(pointer.manifestPath, 'utf8'))
  assert.equal(manifest.resources[0].identity, existing)
  assert.equal(fs.readFileSync(manifest.resources[0].snapshotPath, 'utf8'),
    'partial but exact external candidate\n')
  assert.equal(fs.statSync(manifest.resources[0].snapshotPath).mode & 0o777, 0o600)

  rollbackExplicitExternalLocalBoundary(boundary, target, admission)
  assert.equal(fs.readFileSync(existing, 'utf8'), 'original external bytes\n')
  assert.equal(fs.statSync(existing).mode & 0o777, 0o640)
  assert.equal(fs.existsSync(untouched), false)
  assert.equal(fs.readFileSync(manifest.resources[0].snapshotPath, 'utf8'),
    'partial but exact external candidate\n')
})

test('execution-limit survival rejects a precreated linked record before writing foreign bytes', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'linked-record-output.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const quarantineRoot = path.join(root, 'controller', 'transport-quarantines')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'linked-record-attempt'),
    quarantineRoot,
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(output, 'partial candidate\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    allAssignedItemsPass: false, filesChanged: [],
  })
  const candidateHash = 'd'.repeat(64)
  const changed = [{
    identity: output, kind: 'output', type: 'file',
    hash: sha256(fs.readFileSync(output)), mode: 0o600, changed: true,
  }]
  const survivalId = sha256(stableStringify({
    sourceBoundaryHash: boundary.boundaryHash,
    workItemId: 'work-1',
    reasonCode: 'CHILD_TOKEN_LIMIT_EXHAUSTED',
    candidateHash,
    resources: changed,
  }))
  const survivalBase = path.join(
    path.dirname(path.resolve(quarantineRoot)),
    'external-local-candidate-survivals',
  )
  fs.mkdirSync(survivalBase, { mode: 0o700 })
  const foreign = path.join(root, 'foreign-survival-write-target')
  fs.mkdirSync(foreign, { mode: 0o700 })
  fs.symlinkSync(foreign, path.join(survivalBase, survivalId), 'dir')

  assert.throws(
    () => preserveExplicitExternalLocalCandidate(boundary, admission, {
      workItemId: 'work-1',
      reasonCode: 'CHILD_TOKEN_LIMIT_EXHAUSTED',
      candidateHash,
    }),
    error => ['MISSION_PATH_INVALID', 'EXTERNAL_LOCAL_SURVIVAL_INVALID'].includes(error.code),
  )
  assert.deepEqual(fs.readdirSync(foreign), [])
  rollbackExplicitExternalLocalBoundary(boundary, target, admission)
  assert.equal(fs.readFileSync(output, 'utf8'), 'original bytes\n')
})

test('execution-limit survival rejects a checksummed foreign manifest projection', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'manifest-bound-output.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'manifest-bound-attempt'),
    quarantineRoot: path.join(root, 'controller', 'transport-quarantines'),
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(output, 'partial candidate\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    allAssignedItemsPass: false, filesChanged: [],
  })
  const options = {
    workItemId: 'work-1', reasonCode: 'CHILD_TOKEN_LIMIT_EXHAUSTED',
    candidateHash: 'e'.repeat(64),
  }
  const pointer = preserveExplicitExternalLocalCandidate(boundary, admission, options)
  const manifest = JSON.parse(fs.readFileSync(pointer.manifestPath, 'utf8'))
  const foreign = path.join(root, 'foreign-postimage.bin')
  fs.copyFileSync(manifest.resources[0].snapshotPath, foreign)
  fs.chmodSync(foreign, manifest.resources[0].mode)
  manifest.resources[0].identity = path.join(external, 'not-admitted.bin')
  manifest.resources[0].snapshotPath = foreign
  const { bindingHash: _discardedBinding, ...body } = manifest
  manifest.bindingHash = sha256(stableStringify(body))
  fs.chmodSync(pointer.manifestPath, 0o600)
  fs.writeFileSync(pointer.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

  assert.throws(
    () => preserveExplicitExternalLocalCandidate(boundary, admission, options),
    error => error.code === 'EXTERNAL_LOCAL_SURVIVAL_INVALID',
  )
  rollbackExplicitExternalLocalBoundary(boundary, target, admission)
  assert.equal(fs.readFileSync(output, 'utf8'), 'original bytes\n')
})

test('execution-limit survival resumes after snapshots exist but manifest persistence failed', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'survival-retry.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'survival-retry-source'),
  })
  fs.writeFileSync(output, 'candidate bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    allAssignedItemsPass: false,
    filesChanged: [output],
  })
  const options = {
    workItemId: 'work-1',
    reasonCode: 'CHILD_ROLLOUT_BUDGET_EXHAUSTED',
    candidateHash: '7'.repeat(64),
  }
  const originalOpen = fs.openSync
  let interrupted = false
  fs.openSync = (filename, flags, mode) => {
    if (!interrupted && path.basename(String(filename)) === 'manifest.json' && flags === 'wx') {
      interrupted = true
      throw Object.assign(new Error('injected manifest persistence failure'), { code: 'EIO' })
    }
    return originalOpen(filename, flags, mode)
  }
  try {
    assert.throws(
      () => preserveExplicitExternalLocalCandidate(boundary, admission, options),
      error => error.code === 'EIO',
    )
  } finally {
    fs.openSync = originalOpen
  }
  assert.equal(interrupted, true)
  const pointer = preserveExplicitExternalLocalCandidate(boundary, admission, options)
  assert.equal(pointer.candidateHash, options.candidateHash)
  const manifest = JSON.parse(fs.readFileSync(pointer.manifestPath, 'utf8'))
  assert.equal(manifest.resources.length, 1)
  assert.equal(fs.readFileSync(manifest.resources[0].snapshotPath, 'utf8'), 'candidate bytes\n')
})

test('execution-limit survival replaces a genuinely partial pending snapshot on retry', t => {
  if (process.platform !== 'linux') return
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'survival-partial-retry.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'survival-partial-source'),
  })
  fs.writeFileSync(output, 'complete candidate bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    allAssignedItemsPass: false,
    filesChanged: [output],
  })
  const options = {
    workItemId: 'work-1',
    reasonCode: 'CHILD_ROLLOUT_BUDGET_EXHAUSTED',
    candidateHash: '6'.repeat(64),
  }
  const originalWrite = fs.writeFileSync
  let interrupted = false
  fs.writeFileSync = (destination, bytes, writeOptions) => {
    let targetPath = null
    if (Number.isInteger(destination)) {
      try { targetPath = fs.readlinkSync(`/proc/self/fd/${destination}`) } catch (_) {}
    }
    if (!interrupted && targetPath && targetPath.includes('.pending-')) {
      interrupted = true
      originalWrite(destination, Buffer.from('partial'))
      throw Object.assign(new Error('injected partial snapshot failure'), { code: 'EIO' })
    }
    return originalWrite(destination, bytes, writeOptions)
  }
  try {
    assert.throws(
      () => preserveExplicitExternalLocalCandidate(boundary, admission, options),
      error => error.code === 'EIO',
    )
  } finally {
    fs.writeFileSync = originalWrite
  }
  assert.equal(interrupted, true)

  const pointer = preserveExplicitExternalLocalCandidate(boundary, admission, options)
  const manifest = JSON.parse(fs.readFileSync(pointer.manifestPath, 'utf8'))
  assert.equal(fs.readFileSync(manifest.resources[0].snapshotPath, 'utf8'),
    'complete candidate bytes\n')
  assert.equal(fs.readdirSync(path.dirname(pointer.manifestPath))
    .some(name => name.includes('.pending-')), false)
})

test('interrupted external transaction preserves unbound public bytes instead of guessing cleanup ownership', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'restart-output')
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Create \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'stable-attempt')
  materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  fs.writeFileSync(output, 'bytes left by a dead process\n')

  assert.throws(
    () => materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot }),
    error => error.code === 'EXTERNAL_LOCAL_ROLLBACK_STALE',
  )
  assert.equal(fs.readFileSync(output, 'utf8'), 'bytes left by a dead process\n')
  assert.equal(fs.existsSync(transactionRoot), true,
    'ambiguous unbound bytes and their immutable preimage transaction remain for explicit recovery')
})

test('deterministic transaction setup survives a root-mkdir crash and retries idempotently', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'setup-mkdir-output.bin')
  const assignment = workerAssignment(target, `Create \`${output}\`.`, [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }])
  const transactionRoot = path.join(root, 'controller', 'setup-mkdir-attempt')
  const originalMkdir = fs.mkdirSync
  let injected = false
  fs.mkdirSync = (directory, options) => {
    if (!injected && sameLogicalLeaf(directory, transactionRoot)) {
      injected = true
      throw Object.assign(new Error('injected crash before deterministic root mkdir'), { code: 'EIO' })
    }
    return originalMkdir(directory, options)
  }
  try {
    assert.throws(
      () => materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot }),
      error => error.code === 'EIO',
    )
  } finally {
    fs.mkdirSync = originalMkdir
  }
  assert.equal(injected, true)
  assert.equal(fs.existsSync(transactionRoot), false)
  assert.equal(fs.existsSync(`${transactionRoot}.setup.json`), true,
    'the exact setup identity is durable before root creation')

  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  assert.equal(fs.existsSync(output), true)
  rollbackExplicitExternalLocalBoundary(boundary, target)
})

test('partial deterministic preimage snapshot is restart-idempotent', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'partial-preimage.bin')
  fs.writeFileSync(output, 'exact original preimage\n')
  const assignment = workerAssignment(target, `Update \`${output}\`.`, [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }])
  const transactionRoot = path.join(root, 'controller', 'partial-preimage-attempt')
  const originalWrite = fs.writeFileSync
  let injected = false
  fs.writeFileSync = (destination, bytes, options) => {
    let physical = ''
    if (Number.isInteger(destination)) {
      try { physical = fs.readlinkSync(`/proc/self/fd/${destination}`) } catch (_) {}
    }
    if (!injected && physical.includes('preimage-0.pending-')) {
      injected = true
      originalWrite(destination, Buffer.from('partial'), options)
      throw Object.assign(new Error('injected partial preimage snapshot'), { code: 'EIO' })
    }
    return originalWrite(destination, bytes, options)
  }
  try {
    assert.throws(
      () => materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot }),
      error => error.code === 'EIO',
    )
  } finally {
    fs.writeFileSync = originalWrite
  }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'exact original preimage\n')

  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  assert.equal(fs.readFileSync(boundary.resources[0].backupPath, 'utf8'), 'exact original preimage\n')
  rollbackExplicitExternalLocalBoundary(boundary, target)
})

test('foreign deterministic root without its exact setup journal fails closed', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'foreign-root-output.bin')
  const assignment = workerAssignment(target, `Create \`${output}\`.`, [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }])
  const transactionRoot = path.join(root, 'controller', 'foreign-root-attempt')
  fs.mkdirSync(transactionRoot, { recursive: true })
  const sentinel = path.join(transactionRoot, 'foreign.txt')
  fs.writeFileSync(sentinel, 'must remain untouched\n')
  assert.throws(
    () => materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot }),
    error => error.code === 'EXTERNAL_LOCAL_TRANSACTION_TAMPERED',
  )
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain untouched\n')
  assert.equal(fs.existsSync(output), false)
})

test('exact adopted permit reopens changed transaction while a foreign permit leaves it untouched', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'permit-reopen-output.bin')
  const assignment = workerAssignment(target, `Create \`${output}\`.`, [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }])
  const transactionRoot = path.join(root, 'controller', 'permit-reopen-attempt')
  const isolation = { bindingHash: 'a'.repeat(64) }
  const permit = { id: 'exact-permit', isolationBindingHash: isolation.bindingHash }
  const identity = externalTransactionIdentity({
    runId: 'run-reopen', activationId: 'activation-reopen', workItemId: 'work-1',
    leaseId: 'lease-reopen', permit, isolation,
  })
  const options = {
    transactionRoot, transactionIdentity: identity, mutationPermit: permit, isolation,
  }
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, options)
  fs.writeFileSync(output, 'changed worker bytes survive adoption\n')
  const reopened = materializeExplicitExternalLocalBoundary(assignment, target, options)
  assert.equal(reopened.boundaryHash, boundary.boundaryHash)
  assert.equal(fs.readFileSync(output, 'utf8'), 'changed worker bytes survive adoption\n')

  const foreignPermit = { id: 'foreign-permit', isolationBindingHash: isolation.bindingHash }
  assert.throws(
    () => materializeExplicitExternalLocalBoundary(assignment, target, {
      ...options, mutationPermit: foreignPermit,
    }),
    error => error.code === 'CRASH_ADOPTION_CONFLICT',
  )
  assert.equal(fs.readFileSync(output, 'utf8'), 'changed worker bytes survive adoption\n')
  assert.equal(fs.existsSync(transactionRoot), true)
})

test('post-commit external cleanup outage preserves the candidate and controller-only retry converges', async t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'post-commit-cleanup-output.bin')
  const assignment = workerAssignment(target, `Create \`${output}\`.`, [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }])
  const isolation = { bindingHash: 'b'.repeat(64) }
  const permit = { id: 'post-commit-permit', isolationBindingHash: isolation.bindingHash }
  const identity = externalTransactionIdentity({
    runId: 'run-post-commit', activationId: 'activation-post-commit', workItemId: 'work-1',
    leaseId: 'lease-post-commit', permit, isolation,
  })
  const transactionRoot = path.join(root, 'controller', 'post-commit-cleanup')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot, transactionIdentity: identity, mutationPermit: permit, isolation,
  })
  fs.writeFileSync(output, 'durably committed external candidate\n')
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })
  const workerRecordPath = path.join(root, 'worker-record.json')
  const workerBody = {
    schemaVersion: 1, status: 'COMMITTED',
    binding: { bindingHash: isolation.bindingHash },
  }
  writeChecksummedRecord(workerRecordPath, workerBody)
  let finalizeCalls = 0
  const workerWorkspace = {
    workspaceId: 'post-commit-workspace', recordPath: workerRecordPath, binding: isolation,
    manager: {
      finalize() {
        finalizeCalls += 1
        writeChecksummedRecord(workerRecordPath, { ...workerBody, status: 'FINALIZED' })
      },
      recover() {
        finalizeCalls += 1
        writeChecksummedRecord(workerRecordPath, { ...workerBody, status: 'FINALIZED' })
      },
    },
  }
  let commitCalls = 0
  let durableStatus = 'ACTIVE'
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.localPersistenceLimitations = []
  runtime.options = {
    mutationEnforcer: {
      async commit() { commitCalls += 1; durableStatus = 'COMMITTED' },
      async resolve() { return { status: durableStatus } },
    },
  }
  const originalRm = fs.rmSync
  fs.rmSync = (directory, options) => {
    if (sameLogicalLeaf(directory, transactionRoot)) {
      throw Object.assign(new Error('injected persistent cleanup outage'), { code: 'EIO' })
    }
    return originalRm(directory, options)
  }
  let first
  try {
    first = await runtime._commitPromotedMutation({
      assignment, permit, isolation, workItemId: 'work-1', workerWorkspace,
      postimages: admission.postimages, externalLocalBoundary: boundary,
      externalLocalAdmission: admission,
    })
  } finally {
    fs.rmSync = originalRm
  }
  assert.equal(first.committed, true)
  assert.equal(first.cleanupPending, true)
  assert.equal(commitCalls, 1)
  assert.equal(finalizeCalls, 1)
  assert.equal(fs.readFileSync(output, 'utf8'), 'durably committed external candidate\n')
  assert.equal(fs.existsSync(transactionRoot), true)
  assert.equal(fs.existsSync(boundary.transaction.commitRecordPath), true)

  const originalRead = fs.readFileSync
  let pathnameCommitRecordReads = 0
  fs.readFileSync = (source, options) => {
    if (typeof source === 'string' && sameLogicalLeaf(source, boundary.transaction.commitRecordPath)) {
      pathnameCommitRecordReads += 1
    }
    return originalRead(source, options)
  }
  let retried
  try {
    retried = await runtime._commitPromotedMutation({
      assignment, permit, isolation, workItemId: 'work-1', workerWorkspace,
      postimages: admission.postimages, externalLocalBoundary: boundary,
      externalLocalAdmission: admission, resolveBeforeCommit: true,
    })
  } finally {
    fs.readFileSync = originalRead
  }
  assert.equal(retried.committed, true)
  assert.equal(retried.cleanupPending, false)
  assert.equal(commitCalls, 1, 'controller cleanup retry never replays the durable state commit')
  assert.equal(finalizeCalls, 1, 'already-finalized worker cleanup is idempotent')
  assert.equal(pathnameCommitRecordReads, 0,
    'commit recovery consumes one no-follow descriptor snapshot, never a path-raced second read')
  assert.equal(fs.readFileSync(output, 'utf8'), 'durably committed external candidate\n')
  assert.equal(fs.existsSync(transactionRoot), false)
  assert.equal(fs.existsSync(boundary.transaction.commitRecordPath), false)
})

test('adopted committed terminal result completes cleanup without a launcher or state replay', async t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'adopted-committed-output.bin')
  fs.writeFileSync(output, 'already committed candidate\n')
  const assignment = workerAssignment(target, `Create \`${output}\`.`, [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }])
  const assignmentDirectory = path.join(root, 'run-record', 'work', 'assignments')
  fs.mkdirSync(assignmentDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(assignmentDirectory, `${sha256('work-1')}.json`),
    `${JSON.stringify(assignment)}\n`,
  )
  const isolation = { bindingHash: 'c'.repeat(64) }
  const permit = { id: 'adopted-committed-permit', isolationBindingHash: isolation.bindingHash }
  const identity = externalTransactionIdentity({
    runId: 'run-adopted-committed', activationId: 'activation-adopted-committed',
    workItemId: 'work-1', leaseId: 'lease-adopted-committed', permit, isolation,
  })
  const transactionRoot = path.join(root, 'controller', identity.bindingHash)
  const workerRecordPath = path.join(root, 'adopted-worker-record.json')
  const workerBody = {
    schemaVersion: 1, status: 'COMMITTED', binding: { bindingHash: isolation.bindingHash },
  }
  writeChecksummedRecord(workerRecordPath, workerBody)
  const mutationBody = {
    schemaVersion: 1,
    kind: 'external-local-terminal-mutation-binding',
    boundaryHash: 'd'.repeat(64),
    transactionRoot,
    journalPath: path.join(transactionRoot, 'boundary.json'),
    setupJournalPath: `${transactionRoot}.setup.json`,
    commitRecordPath: `${transactionRoot}.commit.json`,
    transactionIdentity: identity,
    permit,
    isolationBindingHash: isolation.bindingHash,
    workerRecordPath,
    workerWorkspaceId: 'adopted-committed-workspace',
  }
  const externalLocalMutation = {
    ...mutationBody, bindingHash: sha256(stableStringify(mutationBody)),
  }
  let launcherCalls = 0
  let commitCalls = 0
  let finalizeCalls = 0
  const workerWorkspace = {
    workspaceId: mutationBody.workerWorkspaceId,
    recordPath: workerRecordPath,
    binding: isolation,
    manager: {
      finalize() {
        finalizeCalls += 1
        writeChecksummedRecord(workerRecordPath, { ...workerBody, status: 'FINALIZED' })
      },
      recover() { assert.fail('COMMITTED record should finalize directly') },
    },
  }
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.activation = { id: 'activation-adopted-committed' }
  runtime.localPersistenceLimitations = []
  runtime.record = { resolve: relative => path.join(root, 'run-record', ...relative.split('/')) }
  runtime.options = {
    runId: 'run-adopted-committed', targetPath: target,
    launcher: async () => { launcherCalls += 1 },
    workerWorkspaceRecoveryFactory: async () => workerWorkspace,
    mutationEnforcer: {
      async resolve() { return { status: 'COMMITTED' } },
      async commit() { commitCalls += 1 },
    },
  }
  const result = await runtime._reconcileAdoptedTerminalMutation(
    { id: 'lease-adopted-committed', workItemId: 'work-1' },
    { externalLocalMutation },
  )
  assert.deepEqual(result, { status: 'COMMITTED', cleanupOnly: true })
  assert.equal(launcherCalls, 0)
  assert.equal(commitCalls, 0)
  assert.equal(finalizeCalls, 1)
  assert.equal(fs.readFileSync(output, 'utf8'), 'already committed candidate\n')
})

test('missing-output materialization never adopts or deletes a concurrent writer', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'placeholder-race.bin')
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Create \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'placeholder-race')
  const originalOpen = fs.openSync
  let injected = false
  fs.openSync = (filename, flags, mode) => {
    if (!injected && sameLogicalLeaf(filename, output) && flags === 'wx') {
      injected = true
      const descriptor = originalOpen(output, 'wx', 0o640)
      fs.writeSync(descriptor, Buffer.from('concurrent writer\n'))
      fs.closeSync(descriptor)
    }
    return originalOpen(filename, flags, mode)
  }
  try {
    assert.throws(
      () => materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot }),
      error => error.code === 'EEXIST' && error.externalLocalRollbackFailure &&
        error.externalLocalRollbackFailure.code === 'EXTERNAL_LOCAL_ROLLBACK_STALE',
    )
  } finally {
    fs.openSync = originalOpen
  }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'concurrent writer\n')
  assert.equal(fs.existsSync(transactionRoot), true)
})

test('inspection never deletes a writer swapped into an unreported placeholder slot', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'inspection-placeholder-race.bin')
  const displaced = path.join(external, 'inspection-placeholder-displaced.bin')
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Create \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'inspection-placeholder-race')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })

  const originalRename = fs.renameSync
  const originalUnlink = fs.unlinkSync
  let injected = false
  const injectWriter = () => {
    if (injected) return
    injected = true
    originalRename(output, displaced)
    fs.writeFileSync(output, 'later writer must survive\n', { mode: 0o640 })
  }
  fs.renameSync = (source, destination) => {
    if (samePhysicalPath(source, output) && destination.includes('inspection-placeholder')) {
      injectWriter()
    }
    return originalRename(source, destination)
  }
  fs.unlinkSync = filename => {
    if (sameLogicalLeaf(filename, output)) injectWriter()
    return originalUnlink(filename)
  }
  try {
    assert.throws(
      () => inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
        allAssignedItemsPass: false,
        filesChanged: [],
      }),
      error => error.code === 'EXTERNAL_LOCAL_ROLLBACK_STALE',
    )
  } finally {
    fs.renameSync = originalRename
    fs.unlinkSync = originalUnlink
  }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'later writer must survive\n')
  assert.equal(fs.existsSync(transactionRoot), true)
})

test('rollback publishes a preimage with no-replace semantics when a writer races restoration', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'restore-race.bin')
  fs.writeFileSync(output, 'baseline bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'restore-race')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  fs.writeFileSync(output, 'admitted worker bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })
  const originalOpen = fs.openSync
  let injected = false
  fs.openSync = (filename, flags, mode) => {
    if (!injected && sameLogicalLeaf(filename, output) && flags === 'wx') {
      injected = true
      fs.writeFileSync(output, 'concurrent restore winner\n', { mode: 0o644 })
    }
    return originalOpen(filename, flags, mode)
  }
  try {
    assert.throws(
      () => rollbackExplicitExternalLocalBoundary(boundary, target, admission),
      error => error.code === 'EXTERNAL_LOCAL_ROLLBACK_STALE',
    )
  } finally {
    fs.openSync = originalOpen
  }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'concurrent restore winner\n')
  assert.equal(fs.statSync(output).mode & 0o777, 0o644)
  assert.equal(fs.existsSync(transactionRoot), true)
})

test('rollback restart converges when the exact preimage and captured postimage both survive', t => {
  if (process.platform !== 'linux') return
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'rollback-restart.bin')
  fs.writeFileSync(output, 'baseline bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'rollback-restart')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  fs.writeFileSync(output, 'worker bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })
  const originalFsync = fs.fsyncSync
  let interrupted = false
  fs.fsyncSync = descriptor => {
    let targetPath = null
    try { targetPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`) } catch (_) {}
    if (!interrupted && targetPath && samePhysicalPath(targetPath, output)) {
      interrupted = true
      throw Object.assign(new Error('injected post-publication crash'), { code: 'EIO' })
    }
    return originalFsync(descriptor)
  }
  try {
    assert.throws(
      () => rollbackExplicitExternalLocalBoundary(boundary, target, admission),
      error => error.code === 'EXTERNAL_LOCAL_ROLLBACK_STALE',
    )
  } finally {
    fs.fsyncSync = originalFsync
  }
  assert.equal(interrupted, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'baseline bytes\n')
  assert.equal(fs.existsSync(transactionRoot), true)
  let recoveredPreimageSynced = false
  fs.fsyncSync = descriptor => {
    let targetPath = null
    try { targetPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`) } catch (_) {}
    if (targetPath && samePhysicalPath(targetPath, output)) recoveredPreimageSynced = true
    return originalFsync(descriptor)
  }
  try {
    rollbackExplicitExternalLocalBoundary(boundary, target, admission)
  } finally {
    fs.fsyncSync = originalFsync
  }
  assert.equal(recoveredPreimageSynced, true,
    'restart makes an already-restored preimage durable before deleting rollback authority')
  assert.equal(fs.readFileSync(output, 'utf8'), 'baseline bytes\n')
  assert.equal(fs.existsSync(transactionRoot), false)
})

test('unexpected cross-device capture is typed and retains public bytes plus rollback authority', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'unexpected-exdev.bin')
  fs.writeFileSync(output, 'baseline bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'unexpected-exdev')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot })
  fs.writeFileSync(output, 'candidate bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const admission = inspectExplicitExternalLocalBoundary(boundary, assignment, target, {
    filesChanged: [output],
  })
  const originalRename = fs.renameSync
  let injected = false
  fs.renameSync = (source, destination) => {
    if (!injected && samePhysicalPath(source, output) &&
        physicalParentIncludes(destination, 'rollback-discard')) {
      injected = true
      throw Object.assign(new Error('injected cross-device rename'), { code: 'EXDEV' })
    }
    return originalRename(source, destination)
  }
  try {
    assert.throws(
      () => rollbackExplicitExternalLocalBoundary(boundary, target, admission),
      error => error.code === 'EXTERNAL_LOCAL_CROSS_DEVICE_UNSUPPORTED' &&
        error.details && error.details.cause === 'EXDEV',
    )
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'candidate bytes\n')
  assert.equal(fs.existsSync(transactionRoot), true)
})

test('explicit cross-device transaction root is rejected before output mutation', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'preflight-exdev.bin')
  fs.writeFileSync(output, 'baseline bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const controller = path.join(root, 'controller-on-other-device')
  fs.mkdirSync(controller)
  const transactionRoot = path.join(controller, 'preflight-exdev')
  const originalStat = fs.statSync
  fs.statSync = (filename, options) => {
    const stat = originalStat(filename, options)
    if (!samePhysicalPath(filename, controller)) return stat
    return new Proxy(stat, {
      get(targetStat, property, receiver) {
        if (property === 'dev') return Number(targetStat.dev) + 1
        return Reflect.get(targetStat, property, receiver)
      },
    })
  }
  try {
    assert.throws(
      () => materializeExplicitExternalLocalBoundary(assignment, target, { transactionRoot }),
      error => error.code === 'EXTERNAL_LOCAL_CROSS_DEVICE_UNSUPPORTED',
    )
  } finally {
    fs.statSync = originalStat
  }
  assert.equal(fs.readFileSync(output, 'utf8'), 'baseline bytes\n')
  assert.equal(fs.existsSync(transactionRoot), false)
})

test('receipt-bound external quarantine seeds one immediate retry and commits exact postimages', t => {
  const { root, target, external } = temporaryFixture(t)
  const script = path.join(external, 'patch.py')
  const output = path.join(external, 'patched.bin')
  fs.writeFileSync(output, 'original binary\n', { mode: 0o700 })
  const ownership = externalOwnership(script, output)
  const mission = `Create \`${script}\` and update \`${output}\`.`
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
  let retryBoundary = materializeExplicitExternalLocalBoundary(retryAssignment, target, {
    transactionRoot: path.join(root, 'controller', 'retry-attempt'),
  })
  retryBoundary = seedExplicitExternalLocalBoundaryFromQuarantine(
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

test('quarantine seed resumes from durable intent, captured materialization, and live postimage', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'seed-restart.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const receiptHash = '8'.repeat(64)
  const sourceBoundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'seed-restart-source'),
    quarantineRoot: path.join(root, 'controller', 'seed-restart-quarantines'),
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(output, 'candidate bytes\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const pointer = quarantineExplicitExternalLocalBoundary(sourceBoundary, target, {
    sourceWorkItemId: 'work-1',
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: receiptHash,
  })
  const retryBoundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'seed-restart-retry'),
  })
  const record = JSON.parse(fs.readFileSync(pointer.recordPath, 'utf8'))
  const postimage = record.resources[0]
  const resource = retryBoundary.resources[0]
  const discardRoot = path.join(retryBoundary.transaction.root, 'quarantine-seed-discard')
  fs.mkdirSync(discardRoot, { mode: 0o700 })
  const identityHash = crypto.createHash('sha256').update(output).digest('hex')
  const discardPath = path.join(discardRoot, `0-${identityHash.slice(0, 24)}`)
  fs.renameSync(output, discardPath)
  fs.copyFileSync(postimage.snapshotPath, output, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(output, postimage.mode)
  const expected = {
    hash: resource.materializedHash,
    type: resource.materializedType,
    mode: resource.materializedMode,
  }
  const intentBody = {
    schemaVersion: 1,
    kind: 'external-local-quarantine-seed-intent',
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: receiptHash,
    resourceIdentity: output,
    expected,
    postimage: { hash: postimage.hash, type: postimage.type, mode: postimage.mode },
  }
  const intent = {
    ...intentBody,
    bindingHash: crypto.createHash('sha256')
      .update(stableStringify(intentBody)).digest('hex'),
  }
  fs.writeFileSync(path.join(discardRoot, 'seed-intent-0.json'),
    `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 })

  const seededBoundary = seedExplicitExternalLocalBoundaryFromQuarantine(
    retryBoundary,
    assignment,
    target,
    pointer,
    { retryWorkItemId: 'work-1-transport-retry-1', transportReceiptHash: receiptHash },
  )
  assert.equal(fs.readFileSync(output, 'utf8'), 'candidate bytes\n')
  assert.equal(seededBoundary.resources[0].materializedHash, postimage.hash)
  const admission = inspectExplicitExternalLocalBoundary(seededBoundary, assignment, target, {
    filesChanged: [output],
  })
  commitExplicitExternalLocalBoundary(
    seededBoundary,
    admission,
    { mutationStateCommitted: true },
  )
  assert.equal(fs.readFileSync(output, 'utf8'), 'candidate bytes\n')
})

test('external quarantine fsyncs its immutable journal before destructive rollback', t => {
  if (process.platform !== 'linux') return
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'durable-quarantine.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const quarantineRoot = path.join(root, 'controller', 'durable-quarantines')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'durable-source'),
    quarantineRoot,
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(output, 'candidate bytes\n', { mode: 0o600 })

  const syncEvents = []
  const originalFsync = fs.fsyncSync
  const originalRename = fs.renameSync
  let rollbackObserved = false
  fs.fsyncSync = descriptor => {
    try {
      syncEvents.push(fs.readlinkSync(`/proc/self/fd/${descriptor}`))
    } catch (_) {}
    return originalFsync(descriptor)
  }
  fs.renameSync = (source, destination) => {
    if (!rollbackObserved && samePhysicalPath(source, output) &&
        physicalParentIncludes(destination, 'rollback-discard')) {
      rollbackObserved = true
      const journalIndex = syncEvents.findIndex(event =>
        event.endsWith(`${path.sep}quarantine.json`))
      assert.ok(journalIndex >= 0, 'the quarantine journal file is durable before rollback')
      const recordRoot = path.dirname(syncEvents[journalIndex])
      assert.ok(syncEvents.slice(journalIndex + 1).includes(recordRoot),
        'the journal directory entry is durable before rollback')
    }
    return originalRename(source, destination)
  }
  let pointer
  try {
    pointer = quarantineExplicitExternalLocalBoundary(boundary, target, {
      sourceWorkItemId: 'work-1',
      retryWorkItemId: 'work-1-transport-retry-1',
      transportReceiptHash: 'd'.repeat(64),
    })
  } finally {
    fs.fsyncSync = originalFsync
    fs.renameSync = originalRename
  }
  assert.equal(rollbackObserved, true)
  assert.equal(fs.existsSync(pointer.recordPath), true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'original bytes\n')
  const record = JSON.parse(fs.readFileSync(pointer.recordPath, 'utf8'))
  assert.equal(fs.readFileSync(record.resources[0].snapshotPath, 'utf8'), 'candidate bytes\n')
})

test('quarantine restart never adopts a later writer as rollback authority', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'quarantine-restart-race.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const transactionRoot = path.join(root, 'controller', 'quarantine-restart-source')
  const boundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot,
    quarantineRoot: path.join(root, 'controller', 'quarantine-restart-records'),
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(output, 'first candidate\n', { mode: 0o600 })
  fs.chmodSync(output, 0o600)
  const quarantineOptions = {
    sourceWorkItemId: 'work-1',
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: 'e'.repeat(64),
  }
  const originalRename = fs.renameSync
  let interrupted = false
  fs.renameSync = (source, destination) => {
    if (!interrupted && samePhysicalPath(source, output) &&
        physicalParentIncludes(destination, 'rollback-discard')) {
      interrupted = true
      const error = Object.assign(new Error('injected rollback interruption'), { code: 'EBUSY' })
      throw error
    }
    return originalRename(source, destination)
  }
  try {
    assert.throws(
      () => quarantineExplicitExternalLocalBoundary(boundary, target, quarantineOptions),
      error => error.code === 'EBUSY',
    )
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(interrupted, true)
  fs.writeFileSync(output, 'later writer\n', { mode: 0o644 })
  fs.chmodSync(output, 0o644)
  assert.throws(
    () => quarantineExplicitExternalLocalBoundary(boundary, target, quarantineOptions),
    error => error.code === 'EXTERNAL_LOCAL_QUARANTINE_STALE',
  )
  assert.equal(fs.readFileSync(output, 'utf8'), 'later writer\n')
  assert.equal(fs.statSync(output).mode & 0o777, 0o644)
  assert.equal(fs.existsSync(transactionRoot), true)
})

test('quarantine seed consumes the same no-follow journal snapshot it validates', t => {
  if (process.platform !== 'linux') return
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'single-read-seed.bin')
  const foreignSnapshot = path.join(external, 'foreign-seed.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  fs.writeFileSync(foreignSnapshot, 'foreign bytes\n', { mode: 0o600 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const assignment = workerAssignment(target, `Update \`${output}\`.`, ownership)
  const sourceBoundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'single-read-source'),
    quarantineRoot: path.join(root, 'controller', 'single-read-records'),
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(output, 'candidate bytes\n', { mode: 0o600 })
  const receiptHash = 'f'.repeat(64)
  const pointer = quarantineExplicitExternalLocalBoundary(sourceBoundary, target, {
    sourceWorkItemId: 'work-1',
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: receiptHash,
  })
  const retryBoundary = materializeExplicitExternalLocalBoundary(assignment, target, {
    transactionRoot: path.join(root, 'controller', 'single-read-retry'),
  })
  const originalRecord = JSON.parse(fs.readFileSync(pointer.recordPath, 'utf8'))
  const { bindingHash: _bindingHash, ...originalBody } = originalRecord
  const foreignBytes = fs.readFileSync(foreignSnapshot)
  const forgedBody = {
    ...originalBody,
    resources: [{
      ...originalBody.resources[0],
      snapshotPath: foreignSnapshot,
      hash: crypto.createHash('sha256').update(foreignBytes).digest('hex'),
      mode: fs.statSync(foreignSnapshot).mode & 0o777,
    }],
  }
  const forgedRecord = {
    ...forgedBody,
    bindingHash: crypto.createHash('sha256')
      .update(stableStringify(forgedBody)).digest('hex'),
  }
  const displacedRecord = path.join(root, 'displaced-quarantine.json')
  const originalRead = fs.readFileSync
  let swapped = false
  fs.readFileSync = (filename, ...args) => {
    let readsRecord = filename === pointer.recordPath
    if (typeof filename === 'number') {
      try { readsRecord = fs.readlinkSync(`/proc/self/fd/${filename}`) === pointer.recordPath } catch (_) {}
    }
    const bytes = originalRead(filename, ...args)
    if (!swapped && readsRecord) {
      swapped = true
      fs.renameSync(pointer.recordPath, displacedRecord)
      fs.writeFileSync(pointer.recordPath, `${JSON.stringify(forgedRecord, null, 2)}\n`, {
        mode: 0o600,
      })
    }
    return bytes
  }
  try {
    assert.throws(() => seedExplicitExternalLocalBoundaryFromQuarantine(
      retryBoundary,
      assignment,
      target,
      pointer,
      { retryWorkItemId: 'work-1-transport-retry-1', transportReceiptHash: receiptHash },
    ), error => ['EXTERNAL_LOCAL_QUARANTINE_NOT_FOUND',
      'EXTERNAL_LOCAL_QUARANTINE_INVALID'].includes(error.code))
  } finally {
    fs.readFileSync = originalRead
  }
  assert.equal(swapped, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'original bytes\n')
  assert.equal(fs.readFileSync(foreignSnapshot, 'utf8'), 'foreign bytes\n')
  assert.equal(fs.existsSync(retryBoundary.transaction.root), true)
})

test('quarantine seeding never overwrites a writer that wins after materialization capture', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'seed-race.bin')
  fs.writeFileSync(output, 'original bytes\n', { mode: 0o640 })
  const ownership = [{
    kind: 'output', identity: output, owner: 'work-1', ownershipMode: 'single-owner',
  }]
  const mission = `Update \`${output}\`.`
  const sourceAssignment = workerAssignment(target, mission, ownership)
  const quarantineRoot = path.join(root, 'controller', 'seed-race-quarantines')
  const sourceBoundary = materializeExplicitExternalLocalBoundary(sourceAssignment, target, {
    transactionRoot: path.join(root, 'controller', 'seed-race-source'),
    quarantineRoot,
    sourceWorkItemId: 'work-1',
  })
  fs.writeFileSync(output, 'quarantined partial\n', { mode: 0o600 })
  const receiptHash = 'c'.repeat(64)
  const pointer = quarantineExplicitExternalLocalBoundary(sourceBoundary, target, {
    sourceWorkItemId: 'work-1',
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: receiptHash,
  })
  const retryAssignment = workerAssignment(target, mission, ownership)
  const transactionRoot = path.join(root, 'controller', 'seed-race-retry')
  const retryBoundary = materializeExplicitExternalLocalBoundary(retryAssignment, target, {
    transactionRoot,
  })
  const originalOpen = fs.openSync
  let injected = false
  fs.openSync = (filename, flags, mode) => {
    if (!injected && sameLogicalLeaf(filename, output) && flags === 'wx') {
      injected = true
      fs.writeFileSync(output, 'concurrent seed winner\n', { mode: 0o644 })
    }
    return originalOpen(filename, flags, mode)
  }
  try {
    assert.throws(() => seedExplicitExternalLocalBoundaryFromQuarantine(
      retryBoundary,
      retryAssignment,
      target,
      pointer,
      { retryWorkItemId: 'work-1-transport-retry-1', transportReceiptHash: receiptHash },
    ), error => error.code === 'EXTERNAL_LOCAL_ROLLBACK_STALE')
  } finally {
    fs.openSync = originalOpen
  }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(output, 'utf8'), 'concurrent seed winner\n')
  assert.equal(fs.statSync(output).mode & 0o777, 0o644)
  assert.equal(fs.existsSync(transactionRoot), true,
    'the exact preimage transaction remains available after a publication race')
  const quarantine = JSON.parse(fs.readFileSync(pointer.recordPath, 'utf8'))
  assert.equal(fs.readFileSync(quarantine.resources[0].snapshotPath, 'utf8'),
    'quarantined partial\n')
})

test('tampered quarantine and linked prefixes fail closed without deleting outside authority', t => {
  const { root, target, external } = temporaryFixture(t)
  const output = path.join(external, 'output.bin')
  const ownership = [{
    kind: 'file', identity: output, owner: 'worker-1', ownershipMode: 'single-owner',
  }]
  const mission = `Create \`${output}\`.`
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
  const linkedAssignment = workerAssignment(target, `Create \`${linkedOutput}\`.`, [{
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

test('candidate identity binds only the declared ignored in-repository output', t => {
  const { target } = temporaryFixture(t)
  fs.writeFileSync(path.join(target, '.gitignore'), 'dist/\n.cache/\n')
  const addIgnore = childProcess.spawnSync('git', ['add', '--', '.gitignore'], {
    cwd: target, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(addIgnore.status, 0, addIgnore.stderr || addIgnore.stdout)
  const commitIgnore = childProcess.spawnSync('git', ['commit', '-m', 'ignore generated fixture'], {
    cwd: target, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(commitIgnore.status, 0, commitIgnore.stderr || commitIgnore.stdout)
  fs.mkdirSync(path.join(target, 'dist'))
  fs.mkdirSync(path.join(target, '.cache'))
  fs.writeFileSync(path.join(target, 'dist', 'owned.bin'), 'owned-v1\n')
  fs.writeFileSync(path.join(target, '.cache', 'noise.bin'), 'noise-v1\n')
  const resources = [{
    kind: 'output', identity: path.join(target, 'dist', 'owned.bin'), access: 'write',
  }]
  const baseline = hashWorkspaceCandidate(target, process.env, [], resources, target)
  fs.writeFileSync(path.join(target, '.cache', 'noise.bin'), 'noise-v2\n')
  assert.equal(hashWorkspaceCandidate(target, process.env, [], resources, target), baseline,
    'unowned ignored cache noise is outside the candidate identity')
  fs.writeFileSync(path.join(target, 'dist', 'owned.bin'), 'owned-v2\n')
  assert.notEqual(hashWorkspaceCandidate(target, process.env, [], resources, target), baseline,
    'the declared ignored output is part of the candidate identity')
})

test('tracked deletion and a dangling link can never share an exact-version hash or snapshot', t => {
  if (process.platform === 'win32') return
  const { target } = temporaryFixture(t)
  const tracked = path.join(target, 'subject.txt')
  fs.unlinkSync(tracked)
  const deletedHash = hashWorkspaceCandidate(target, process.env)
  const deletedSnapshot = workspaceFileSnapshot(target, process.env)
  assert.equal(deletedSnapshot.get('subject.txt'), null)

  fs.symlinkSync(path.join(target, 'missing-link-target'), tracked)
  assert.throws(
    () => hashWorkspaceCandidate(target, process.env),
    error => error.code === 'CANDIDATE_UNSAFE',
  )
  assert.throws(
    () => workspaceFileSnapshot(target, process.env),
    error => error.code === 'MUTATION_SCOPE_INVALID',
  )
  assert.match(deletedHash, /^[a-f0-9]{64}$/u)
})
