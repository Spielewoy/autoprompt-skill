#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const {
  CodexExecAdapter,
  FORBIDDEN_RUNTIME_ROLES,
  RolePolicy,
  admitCodexRoleSelection,
  assertReadOnlyCheckerOperation,
  classifyCodexTopLevelPrompt,
  createCodexEntrySemanticTrace,
  loadRoleContract,
} = require(path.join(WORKFLOW, 'phase-budget.js'))

test('ISO-017/025 denies every illegal edge and root-from-child before creating a child session', () => {
  const policy = new RolePolicy()
  let sessions = 0
  for (const child of [...FORBIDDEN_RUNTIME_ROLES, 'problem-finder', 'unknown-internal-role']) {
    assert.throws(() => admitCodexRoleSelection({
      rolePolicy: policy,
      selection: { parent: 'run-owner', child, route: 'ROADMAP' },
      createChildSession() { sessions += 1 },
    }), error => error.code === 'ROLE_POLICY_DENIED')
  }
  assert.equal(sessions, 0)

  const contract = loadRoleContract()
  const parents = ['deterministic-control-plane', 'run-owner', ...contract.roles.map(role => role.id)]
  const children = ['run-owner', ...contract.roles.map(role => role.id)]
  const routes = ['PRE_ROUTE', 'DIRECT', 'LIGHT', 'ROADMAP']
  let forbidden = 0
  let allowed = 0
  for (const route of routes) for (const parent of parents) for (const child of children) {
    let admitted = false
    try { policy.validate({ parent, child, route }); admitted = true } catch (error) {
      assert.equal(error.code, 'ROLE_POLICY_DENIED')
    }
    if (admitted) allowed += 1
    else forbidden += 1
    if (child === 'run-owner' && parent !== 'deterministic-control-plane') assert.equal(admitted, false)
  }
  assert.ok(allowed > 0)
  assert.ok(forbidden > allowed * 10, { allowed, forbidden })
})

test('ISO-022 both Codex entries have an identical admission/route/capability/resume trace', () => {
  const semantic = {
    admission: {
      activationId: 'activation-entry-parity', runId: 'run-entry-parity',
      requestHash: 'a'.repeat(64), targetIdentity: 'target:repo',
    },
    route: { route: 'LIGHT', decisionHash: 'b'.repeat(64) },
    capability: { receiptHash: 'c'.repeat(64), generation: 2, status: 'active' },
    resume: { generation: 2, stateEventSequence: 17, stateHash: 'd'.repeat(64) },
  }
  const topLevel = createCodexEntrySemanticTrace({ entry: 'top-level', ...semantic })
  const supervisor = createCodexEntrySemanticTrace({ entry: 'supervisor', ...semantic })
  assert.deepEqual(topLevel, supervisor)
  for (const field of ['admission', 'route', 'capability', 'resume']) assert.deepEqual(topLevel[field], supervisor[field])
})

test('ISO-005 ordinary review/merge prompts load neither Autoprompt nor problem-finder', () => {
  for (const prompt of ['Review this pull request.', 'Merge the ready branch.', "What\'s broken in this change?"]) {
    const admission = classifyCodexTopLevelPrompt(prompt)
    assert.equal(admission.loadAutoprompt, false)
    assert.equal(admission.loadInternalRoles, false)
    assert.deepEqual(admission.loadedCompanionSkills, [])
  }
  const explicit = classifyCodexTopLevelPrompt('$autoprompt Review this repository.')
  assert.equal(explicit.loadAutoprompt, true)
  assert.deepEqual(explicit.loadedCompanionSkills, [])
})

test('ISO-006 checker is mechanically read-only and edit/create/spawn/mutating command requests are denied', async () => {
  const rolePolicy = new RolePolicy()
  const edge = rolePolicy.validate({ parent: 'run-owner', child: 'independent-reviewer', route: 'DIRECT' })
  const execution = rolePolicy.bindPhysicalChild({
    logicalRole: edge.child, physicalRole: edge.definition.physicalId,
    providerRole: 'ap-independent-checker',
  })
  assert.equal(execution.sandboxMode, 'read-only')
  assert.equal(execution.canDispatch, false)
  assert.deepEqual(execution.resourceSets.write, [])
  assert.deepEqual(execution.resourceSets.exclusive, [])
  for (const operation of [
    { kind: 'edit' }, { kind: 'create' }, { kind: 'spawn' },
    { kind: 'command', command: 'git commit', mutates: true },
  ]) assert.throws(() => assertReadOnlyCheckerOperation(execution, operation),
    error => error.code === 'CHECKER_OPERATION_DENIED')
  assert.equal(assertReadOnlyCheckerOperation(execution, { kind: 'read' }).allowed, true)

  let runnerCalls = 0
  const adapter = new CodexExecAdapter({
    runner: { async run() { runnerCalls += 1 } }, targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json'),
  })
  await assert.rejects(adapter.launch({
    logicalRole: 'independent-reviewer', physicalRole: execution.physicalRole,
    providerRole: execution.providerRole, physicalExecutionPolicy: { ...execution, sandboxMode: 'workspace-write' },
    entryPrompt: '$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=bound',
    dispatch: { brief: 'Review.', requestPointer: { hash: 'e'.repeat(64) } },
    environment: {}, sessionId: 'checker-denied',
  }), error => error.code === 'CHECKER_READ_ONLY_POLICY_REQUIRED')
  assert.equal(runnerCalls, 0)
})
