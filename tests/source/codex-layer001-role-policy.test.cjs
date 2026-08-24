'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  renderCodexPolicyAgent,
  validateCodexRolePolicy,
} = require('../../scripts/generate-provider-contracts.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const TARGET_READERS = Object.freeze([
  Object.freeze({
    logicalId: 'mission-coordinator',
    physicalId: 'ap-run-coordinator',
    layer: 'L1',
  }),
  Object.freeze({
    logicalId: 'ap-work-group-manager',
    physicalId: 'ap-work-group-manager',
    layer: 'L2',
  }),
])
const EXPECTED_PHYSICAL_READS = Object.freeze([
  'request-envelope.read',
  'plan.roadmap.read',
  'target.named.read',
  'prior-results.read',
])

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

function roleContracts() {
  const roles = readJson('agents/contracts/roles.json')
  const rolePolicy = readJson('agents/codex/agents/role-policy.json')
  validateCodexRolePolicy(rolePolicy, roles)
  return {
    roles,
    rolePolicy,
    plainLanguage: readJson('agents/contracts/plain-language.json'),
  }
}

test('AP-LAYER-001 gives the active L1 coordinator and L2 manager scoped target read/search only', () => {
  const contracts = roleContracts()
  const logicalRoles = new Map(contracts.roles.roles.map(role => [role.id, role]))
  const targetRead = contracts.rolePolicy.resource_set_definitions['target.named.read']

  assert.deepEqual(targetRead, {
    kind: 'assignment-resolved',
    resolved_by: 'supervisor',
    rules: ['explicit-path-list', 'read-only', 'no-follow'],
  })

  for (const { logicalId, physicalId, layer } of TARGET_READERS) {
    const logical = logicalRoles.get(logicalId)
    const physical = contracts.rolePolicy.physical_roles[physicalId]

    assert.ok(logical.permissions.read.includes('assigned-target-resources'), `${logicalId} logical target read`)
    assert.deepEqual(logical.permissions.write, [], `${logicalId} has no logical write`)
    assert.deepEqual(logical.permissions.execute, [], `${logicalId} has no logical command execution`)
    assert.deepEqual(logical.writes, [], `${logicalId} declares no output path`)

    assert.equal(physical.layer, layer)
    assert.equal(physical.sandbox_mode, 'read-only')
    assert.deepEqual(physical.resource_sets.read, EXPECTED_PHYSICAL_READS)
    assert.deepEqual(physical.resource_sets.write, [])
    assert.deepEqual(physical.resource_sets.exclusive, [])

    const prompt = renderCodexPolicyAgent(
      physicalId,
      physical,
      contracts.roles,
      contracts.rolePolicy,
      contracts.plainLanguage,
    )
    assert.match(prompt, /Read resources: [^\n]*`target\.named\.read`/u)
    assert.match(prompt, /^sandbox_mode = "read-only"$/mu)
    assert.doesNotMatch(prompt, /target\.owned\.write|plan\.roadmap\.write/u)
  }
})

test('AP-LAYER-001 target inspection does not widen neighboring roles or cross L1/L2/L3 boundaries', () => {
  const { rolePolicy, roles } = roleContracts()
  const coordinator = rolePolicy.physical_roles['ap-run-coordinator']
  const manager = rolePolicy.physical_roles['ap-work-group-manager']
  const worker = rolePolicy.physical_roles['ap-worker']
  const checker = rolePolicy.physical_roles['ap-independent-checker']

  assert.deepEqual(coordinator.allowed_parents, ['L0'])
  assert.deepEqual(coordinator.allowed_children, ['ap-work-group-manager', 'ap-worker'])
  assert.deepEqual(manager.allowed_parents, ['ap-run-coordinator'])
  assert.deepEqual(manager.allowed_children, ['ap-worker'])
  assert.equal(worker.layer, 'L3')
  assert.equal(worker.can_dispatch, false)
  assert.deepEqual(worker.allowed_children, [])
  assert.equal(checker.layer, 'L4')
  assert.equal(checker.can_dispatch, false)
  assert.deepEqual(checker.allowed_parents, ['L0'])

  for (const alias of roles.compatibilityAliases
    .filter(({ logicalId }) => ['mission-coordinator', 'ap-work-group-manager'].includes(logicalId))) {
    const physical = rolePolicy.physical_roles[alias.legacyId]
    assert.equal(physical.activation_allowed, false, `${alias.legacyId} stays inactive`)
    assert.equal(physical.can_dispatch, false, `${alias.legacyId} stays closed`)
    assert.equal(physical.sandbox_mode, 'read-only', `${alias.legacyId} stays read-only`)
    assert.deepEqual(physical.resource_sets.write, [], `${alias.legacyId} gets no write`)
    assert.deepEqual(physical.resource_sets.exclusive, [], `${alias.legacyId} gets no exclusive resource`)
  }

  const missingTarget = structuredClone(rolePolicy)
  missingTarget.physical_roles['ap-run-coordinator'].resource_sets.read =
    missingTarget.physical_roles['ap-run-coordinator'].resource_sets.read
      .filter(resource => resource !== 'target.named.read')
  assert.throws(
    () => validateCodexRolePolicy(missingTarget, roles),
    /coordinator target read\/search policy/u,
  )

  const unscopedTarget = structuredClone(rolePolicy)
  unscopedTarget.resource_set_definitions['target.named.read'].rules = ['read-only']
  assert.throws(
    () => validateCodexRolePolicy(unscopedTarget, roles),
    /named target read\/search resource is not scoped and read-only/u,
  )

  const missingLogicalTarget = structuredClone(roles)
  const logicalManager = missingLogicalTarget.roles.find(role => role.id === 'ap-work-group-manager')
  logicalManager.permissions.read = logicalManager.permissions.read
    .filter(resource => resource !== 'assigned-target-resources')
  assert.throws(
    () => validateCodexRolePolicy(rolePolicy, missingLogicalTarget),
    /logical coordinator target read\/search policy/u,
  )

  const commandExecution = structuredClone(roles)
  commandExecution.roles.find(role => role.id === 'mission-coordinator')
    .permissions.execute.push('search-command')
  assert.throws(
    () => validateCodexRolePolicy(rolePolicy, commandExecution),
    /logical coordinator target read\/search policy/u,
  )

  const managerWrite = structuredClone(rolePolicy)
  managerWrite.physical_roles['ap-work-group-manager'].resource_sets.write.push('target.owned.write')
  assert.throws(
    () => validateCodexRolePolicy(managerWrite, roles),
    /coordinator target read\/search policy|widens writable resources/u,
  )
})
