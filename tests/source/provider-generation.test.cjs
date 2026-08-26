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
const CONTRACT_PATH = path.join(ROOT, 'agents', 'contracts', 'autoprompt.contract.json')
const VSCODE_SCHEMA_PATH = path.join(
  ROOT,
  'tests',
  'fixtures',
  'providers',
  'vscode',
  'custom-agent-frontmatter.schema.json',
)
const {
  CODEX_ACTIVATION_SYNTAX,
  codexFrameworkRoutes,
  compiledGateDefinitions,
  compiledGateGraphs,
  loadCodexPackageRegistry,
  loadCodexV2Contracts,
  parseCompiledRouteExamples,
  parseFrameworkCompiledGates,
  parseFullCompiledGates,
  plainLanguageViolations,
  providerProjectionPlan,
  normalizePlainLanguageMarkdown,
  renderCodexOutputs,
  renderCodexPolicyAgent,
  renderSharedFrameworkOutputs,
  validateCodexRolePolicy,
  validateCodexUserFacingLanguage,
  validateCanonicalAndSharedPlainLanguage,
  validateCompiledRouteExamples,
  validateFrameworkGateProjections,
  validateFullCompiledGates,
  validateGeneratedPlainLanguage,
  validateFrameworkReferences,
  validateCompatibilityAliasContract,
} = require('../../scripts/generate-provider-contracts.cjs')

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(target) : [target]
  })
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '')
}

function asciiDashes(text) {
  return text.replace(/[\u2013\u2014]/g, '-')
}

function vscodeTools(capabilities) {
  const aliases = [
    ['execute', ['Bash']],
    ['read', ['Read']],
    ['edit', ['Write', 'Edit']],
    ['search', ['Glob', 'Grep']],
    ['agent', ['Agent']],
    ['web', ['WebSearch', 'WebFetch']],
  ]
  return aliases
    .filter(([, sources]) => sources.some(source => capabilities.includes(source)))
    .map(([alias]) => alias)
}

function parseFrontmatter(source, label) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source)
  assert.ok(match, `${label} must contain YAML frontmatter and a body`)
  const header = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    assert.notEqual(separator, -1, `${label} has an invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator)
    const rawValue = line.slice(separator + 1).trim()
    assert.equal(Object.hasOwn(header, key), false, `${label} repeats ${key}`)
    if (rawValue === 'true' || rawValue === 'false') {
      header[key] = rawValue === 'true'
    } else {
      header[key] = JSON.parse(rawValue)
    }
  }
  return { body: match[2], header }
}

function assertVsCodeSchema(header, label) {
  const schema = JSON.parse(fs.readFileSync(VSCODE_SCHEMA_PATH, 'utf8'))
  const accepted = new Set(Object.keys(schema.properties))
  for (const key of schema.required) assert.ok(Object.hasOwn(header, key), `${label} requires ${key}`)
  for (const key of Object.keys(header)) assert.ok(accepted.has(key), `${label} rejects ${key}`)
  assert.equal(typeof header.name, 'string', `${label} name`)
  assert.ok(header.name.length > 0, `${label} name must not be empty`)
  assert.equal(typeof header.description, 'string', `${label} description`)
  assert.ok(header.description.length > 0, `${label} description must not be empty`)
  assert.ok(Array.isArray(header.tools), `${label} tools`)
  assert.ok(Array.isArray(header.agents), `${label} agents`)
  assert.equal(new Set(header.tools).size, header.tools.length, `${label} tools must be unique`)
  assert.equal(new Set(header.agents).size, header.agents.length, `${label} agents must be unique`)
  assert.ok(header.tools.every(value => typeof value === 'string' && value), `${label} tools entries`)
  assert.ok(header.agents.every(value => typeof value === 'string' && value), `${label} agents entries`)
  assert.equal(typeof header['user-invocable'], 'boolean', `${label} user-invocable`)
  assert.equal(typeof header['disable-model-invocation'], 'boolean', `${label} disable-model-invocation`)
}

test('the shared contract exposes all personas, levels, and frameworks', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  const personaIds = new Set(contract.personas.map(persona => persona.id))
  const frameworkIds = new Set(contract.frameworks.map(framework => framework.id))
  for (const required of ['ap-intake', 'ap-implementer', 'ap-verifier', 'ap-scribe']) {
    assert.equal(personaIds.has(required), true, `missing required capability role ${required}`)
  }
  for (const required of ['apply', 'backend-build', 'frontend-review', 'generation']) {
    assert.equal(frameworkIds.has(required), true, `missing required framework ${required}`)
  }
  assert.deepEqual([...new Set(contract.personas.map(persona => persona.tier))].sort(), [
    'R1', 'R2', 'R3', 'R4', 'R5',
  ])

  for (const persona of contract.personas) {
    assert.equal(fs.existsSync(path.join(ROOT, persona.source)), true, persona.source)
    assert.ok(Array.isArray(persona.allowedChildren), `${persona.id} allowedChildren`)
    assert.equal(new Set(persona.allowedChildren).size, persona.allowedChildren.length, `${persona.id} children`)
    assert.deepEqual([...persona.allowedChildren].sort(), persona.allowedChildren, `${persona.id} child order`)
    assert.ok(
      persona.allowedChildren.every(child => contract.personas.some(candidate => candidate.id === child)),
      `${persona.id} children must be canonical personas`,
    )
    assert.equal(persona.allowedChildren.length > 0, persona.capabilities.includes('Agent'), persona.id)
  }
  for (const framework of contract.frameworks) {
    assert.equal(fs.existsSync(path.join(ROOT, framework.source)), true, framework.source)
  }
})

test('Codex v2 prompts are deterministic policy-backed generated views', () => {
  const completed = childProcess.spawnSync(
    process.execPath,
    ['scripts/generate-provider-contracts.cjs', '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  )

  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stdout, /provider contracts are current/)

  const contracts = loadCodexV2Contracts(ROOT)
  const packageRegistry = loadCodexPackageRegistry(ROOT)
  const outputs = renderCodexOutputs(ROOT)
  const generatedTopLevelCount = Object.keys(packageRegistry.generatedOutputs)
    .filter(key => !['agents', 'frameworks'].includes(key)).length
  assert.equal(outputs.size,
    Object.keys(contracts.rolePolicy.physical_roles).length +
      renderSharedFrameworkOutputs(ROOT, contracts.plainLanguage).size + generatedTopLevelCount)
  assert.ok([...outputs.keys()].every(file => file.startsWith('agents/codex/')))
  assert.deepEqual(
    [...outputs.keys()]
      .filter(file => /^agents\/codex\/agents\/ap-.*\.toml$/.test(file))
      .map(file => path.basename(file, '.toml'))
      .sort(),
    Object.keys(contracts.rolePolicy.physical_roles).sort(),
  )
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'codex', 'package.json'), 'utf8')).version
  assert.equal(outputs.get('agents/codex/VERSION'), `${version}\n`)
  const skill = outputs.get('agents/codex/SKILL.md')
  assert.match(skill, /autoprompt activate codex \.\.\. -- <mission>/)
  assert.match(skill, /exact internal skill envelope `\$autoprompt`/)
  assert.match(skill, /`\/autoprompt` is not a supported Codex command[\s\S]*`INVALID_INPUT`/)
  assert.doesNotMatch(skill, /(?:invoke|invokes|invoked|invoking)\s+`?\/autoprompt\b/i)
  assert.deepEqual(CODEX_ACTIVATION_SYNTAX, {
    externalCommand: 'autoprompt activate codex ... -- <mission>',
    internalSkillEnvelope: '$autoprompt',
    unsupportedSlashCommand: '/autoprompt',
    unsupportedCode: 'INVALID_INPUT',
  })
})

test('legacy provider views remain present while Codex roles come from v2 policy', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  const { rolePolicy, roles } = loadCodexV2Contracts(ROOT)

  for (const persona of contract.personas) {
    for (const relativePath of [
      `agents/claude/agents/${persona.id}.md`,
      `agents/opencode/agents/${persona.id}.md`,
      `agents/kilo/agents/${persona.id}.md`,
      `agents/vscode/agents/${persona.id}.agent.md`,
      `agents/prime/personas/${persona.id}.md`,
      `agents/omp/agents/${persona.id}.md`,
      `agents/deepseek/agents/${persona.id}.md`,
      `agents/reasonix/skills/${persona.id}/SKILL.md`,
    ]) assert.equal(fs.existsSync(path.join(ROOT, relativePath)), true, relativePath)
  }

  assert.equal(Object.keys(rolePolicy.physical_roles).length,
    roles.codexPhysicalRoleProjection.length + roles.compatibilityAliases.length)
  const canonicalProjection = new Map(roles.codexPhysicalRoleProjection.map(role => [role.physicalId, role]))
  const compatibilityAliases = new Map(roles.compatibilityAliases.map(alias => [alias.legacyId, alias]))
  assert.equal(canonicalProjection.size,
    Object.values(rolePolicy.physical_roles).filter(role => !role.compatibility_alias.enabled).length)
  assert.equal(compatibilityAliases.size,
    Object.values(rolePolicy.physical_roles).filter(role => role.compatibility_alias.enabled).length)
  for (const [physicalId, role] of Object.entries(rolePolicy.physical_roles)) {
    const codex = read(`agents/codex/agents/${physicalId}.toml`)
    assert.match(codex, new RegExp(`^name = "${physicalId}"$`, 'm'))
    assert.match(codex, new RegExp(`^sandbox_mode = "${role.sandbox_mode}"$`, 'm'))
    assert.match(codex, /^developer_instructions = """$/m)
    assert.ok(
      codex.includes(rolePolicy.instruction_guards.untrusted_input.required_prompt_text),
      `${physicalId} untrusted-input guard`,
    )
    if (role.compatibility_alias.enabled) {
      assert.ok(compatibilityAliases.has(physicalId), physicalId)
      assert.equal(role.sandbox_mode, 'read-only', physicalId)
      assert.equal(role.activation_allowed, false, physicalId)
      assert.equal(role.telemetry_required, true, physicalId)
      assert.equal(role.can_dispatch, false, physicalId)
      assert.deepEqual(role.allowed_children, [], physicalId)
      assert.deepEqual(role.resource_sets.write, [], physicalId)
      assert.doesNotMatch(codex, /^sandbox_mode = "workspace-write"$/m, physicalId)
      assert.doesNotMatch(codex, /(?:you may|permission to) (?:start|dispatch) (?:child )?agents?/i, physicalId)
      assert.match(codex, /deterministic control code records the alias use in the registered compatibility telemetry log/i, physicalId)
    } else {
      const projection = canonicalProjection.get(physicalId)
      assert.ok(projection, physicalId)
      assert.equal(role.logical_role, projection.logicalId, physicalId)
      assert.equal(role.layer, projection.layer, physicalId)
      assert.deepEqual(role.supported_modes, projection.modes, physicalId)
      assert.equal(role.activation_allowed, true, physicalId)
      assert.equal(role.telemetry_required, false, physicalId)
      if (physicalId === 'ap-independent-checker') {
        assert.equal(role.sandbox_mode, 'read-only')
        assert.equal(role.can_dispatch, false)
        assert.deepEqual(role.allowed_children, [])
        assert.deepEqual(role.resource_sets.read,
          ['request-envelope.read', 'target.named.read', 'prior-results.read'])
        assert.deepEqual(role.resource_sets.write, [])
        assert.deepEqual(role.resource_sets.exclusive, [])
        assert.match(codex, /^sandbox_mode = "read-only"$/m)
        assert.doesNotMatch(codex, /target\.owned\.write|plan\.roadmap\.write/)
      }
    }
  }
})

test('Codex generation rejects policy widening, mismatches, and unsafe checker assignment', () => {
  const { rolePolicy, roles } = loadCodexV2Contracts(ROOT)
  validateCodexRolePolicy(rolePolicy, roles)

  const widened = structuredClone(rolePolicy)
  widened.physical_roles['ap-scribe'].resource_sets.write = ['target.owned.write']
  assert.throws(() => validateCodexRolePolicy(widened, roles), /widens writable resources/)

  const unknownSchema = structuredClone(rolePolicy)
  unknownSchema.physical_roles['ap-worker'].input_schema_id = 'unknown-input-v9'
  assert.throws(() => validateCodexRolePolicy(unknownSchema, roles), /unknown input schema/)

  const logicalMismatch = structuredClone(rolePolicy)
  logicalMismatch.physical_roles['ap-run-coordinator'].logical_role = 'route-analyst'
  assert.throws(() => validateCodexRolePolicy(logicalMismatch, roles), /logical (?:version|layer) mismatch/)

  const unsafeChecker = structuredClone(rolePolicy)
  unsafeChecker.physical_roles['ap-independent-checker'].allowed_parents = ['ap-run-coordinator']
  assert.throws(() => validateCodexRolePolicy(unsafeChecker, roles),
    /consumer mismatch|checker assignment|read-only policy/)

  const broaderCheckerRead = structuredClone(rolePolicy)
  broaderCheckerRead.physical_roles['ap-independent-checker'].resource_sets.read.push('legacy-input.read')
  assert.throws(
    () => validateCodexRolePolicy(broaderCheckerRead, roles),
    /exact read-only policy|broad workspace-write authority/,
  )

  const productionCheckerWrite = structuredClone(rolePolicy)
  productionCheckerWrite.physical_roles['ap-independent-checker'].resource_sets.write.push('target.owned.write')
  assert.throws(
    () => validateCodexRolePolicy(productionCheckerWrite, roles),
    /widens writable resources|exact read-only policy/,
  )

  const unknownCheckerResource = structuredClone(rolePolicy)
  unknownCheckerResource.physical_roles['ap-independent-checker'].resource_sets.exclusive.push('unknown-check-resource')
  assert.throws(
    () => validateCodexRolePolicy(unknownCheckerResource, roles),
    /unknown exclusive resource/,
  )

  const unknownCheckerEffect = structuredClone(rolePolicy)
  unknownCheckerEffect.physical_roles['ap-independent-checker'].sandbox_mode = 'danger-full-access'
  assert.throws(
    () => validateCodexRolePolicy(unknownCheckerEffect, roles),
    /unsafe sandbox mode/,
  )

  for (const { legacyId } of roles.compatibilityAliases) {
    const reopenedWrite = structuredClone(rolePolicy)
    reopenedWrite.physical_roles[legacyId].resource_sets.write = ['target.owned.write']
    assert.throws(
      () => validateCodexRolePolicy(reopenedWrite, roles),
      /widens writable resources|compatibility id is not inactive/,
      `${legacyId} write reopening`,
    )
    const reopenedDispatch = structuredClone(rolePolicy)
    reopenedDispatch.physical_roles[legacyId].allowed_children = ['ap-worker']
    reopenedDispatch.physical_roles[legacyId].can_dispatch = true
    assert.throws(
      () => validateCodexRolePolicy(reopenedDispatch, roles),
      /consumer mismatch|not reciprocal|compatibility id is not inactive/,
      `${legacyId} dispatch reopening`,
    )
  }

  const duplicatePhysicalSynonym = structuredClone(rolePolicy)
  duplicatePhysicalSynonym.physical_roles['ap-mission-coordinator'] = structuredClone(rolePolicy.physical_roles['ap-run-coordinator'])
  assert.throws(
    () => validateCodexRolePolicy(duplicatePhysicalSynonym, roles),
    /physical role consumer mismatch/,
  )

  const managerForLight = structuredClone(rolePolicy)
  managerForLight.manager_admission.route = 'LIGHT'
  assert.throws(() => validateCodexRolePolicy(managerForLight, roles), /manager admission or topology mismatch/)

  const missingWorkerSource = structuredClone(roles)
  missingWorkerSource.roles = missingWorkerSource.roles.filter(role => role.id !== 'worker')
  assert.throws(
    () => renderCodexPolicyAgent(
      'ap-worker',
      rolePolicy.physical_roles['ap-worker'],
      missingWorkerSource,
      rolePolicy,
      loadCodexV2Contracts(ROOT).plainLanguage,
    ),
    /no canonical logical role source/,
  )
  const arbiter = renderCodexPolicyAgent(
    'ap-arbiter',
    rolePolicy.physical_roles['ap-arbiter'],
    roles,
    rolePolicy,
    loadCodexV2Contracts(ROOT).plainLanguage,
  )
  assert.match(arbiter, /Choose only between reversible technical alternatives/i)
  assert.match(arbiter, /cannot start another agent or write files/i)

  const unsafeTelemetry = structuredClone(roles)
  unsafeTelemetry.aliasTelemetrySchema.appendPath = '../alias-telemetry.jsonl'
  assert.throws(
    () => validateCompatibilityAliasContract(unsafeTelemetry),
    /telemetry path is not canonical/,
  )
})

test('Codex registry requirements admit optional roles and frameworks but reject missing capabilities and migrations', t => {
  const roles = JSON.parse(read('agents/contracts/roles.json'))
  const rolePolicy = JSON.parse(read('agents/codex/agents/role-policy.json'))
  const registry = loadCodexPackageRegistry(ROOT)
  assert.doesNotThrow(() => validateCodexRolePolicy(rolePolicy, roles, registry, ROOT))

  const expandedRoles = structuredClone(roles)
  const expandedPolicy = structuredClone(rolePolicy)
  expandedRoles.codexPhysicalRoleProjection.push({
    physicalId: 'ap-optional-route-observer',
    logicalId: 'route-analyst',
    layer: 'L3',
    modes: ['route-analysis'],
  })
  expandedPolicy.physical_roles['ap-optional-route-observer'] = structuredClone(
    expandedPolicy.physical_roles['ap-route-analyst'],
  )
  expandedPolicy.control_plane.allowed_children.push('ap-optional-route-observer')
  assert.doesNotThrow(() => validateCodexRolePolicy(expandedPolicy, expandedRoles, registry, ROOT))

  const missingCapabilityRoles = structuredClone(roles)
  const missingCapabilityPolicy = structuredClone(rolePolicy)
  missingCapabilityRoles.codexPhysicalRoleProjection =
    missingCapabilityRoles.codexPhysicalRoleProjection.filter(role => role.logicalId !== 'route-analyst')
  delete missingCapabilityPolicy.physical_roles['ap-route-analyst']
  missingCapabilityPolicy.control_plane.allowed_children =
    missingCapabilityPolicy.control_plane.allowed_children.filter(role => role !== 'ap-route-analyst')
  assert.throws(
    () => validateCodexRolePolicy(missingCapabilityPolicy, missingCapabilityRoles, registry, ROOT),
    /required Codex role capability route-analysis is missing/,
  )

  const missingMigration = structuredClone(registry)
  missingMigration.migrationSources = missingMigration.migrationSources.slice(0, -1)
  assert.throws(
    () => validateCodexRolePolicy(rolePolicy, roles, missingMigration, ROOT),
    /required Codex migration .* is missing/,
  )

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-framework-registry-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  fs.mkdirSync(path.join(sandbox, 'agents', 'contracts'), { recursive: true })
  fs.cpSync(
    path.join(ROOT, 'agents', 'contracts', 'frameworks'),
    path.join(sandbox, 'agents', 'contracts', 'frameworks'),
    { recursive: true },
  )
  fs.mkdirSync(path.join(sandbox, 'scripts', 'install'), { recursive: true })
  const expandedRegistry = structuredClone(registry)
  expandedRegistry.frameworkRoutes['optional-observer.md'] = ['DIRECT']
  fs.writeFileSync(
    path.join(sandbox, 'scripts', 'install', 'codex-package-registry.json'),
    `${JSON.stringify(expandedRegistry, null, 2)}\n`,
  )
  fs.writeFileSync(
    path.join(sandbox, 'agents', 'contracts', 'frameworks', 'optional-observer.md'),
    '# Optional observer\n\nInspect the named result and report what you find.\n',
  )
  assert.deepEqual(codexFrameworkRoutes(sandbox)['optional-observer.md'], ['DIRECT'])
  assert.equal(renderSharedFrameworkOutputs(sandbox, JSON.parse(read('agents/contracts/plain-language.json'))).has(
    'agents/contracts/frameworks/optional-observer.md',
  ), true)
})

test('Codex gate and route-example prose parses back to exact canonical projections', () => {
  const contracts = loadCodexV2Contracts(ROOT)
  const outputs = renderCodexOutputs(ROOT)
  const gatesSha256 = crypto.createHash('sha256').update(read('agents/contracts/gates.json')).digest('hex')
  const routesSha256 = crypto.createHash('sha256').update(read('agents/contracts/routes.json')).digest('hex')

  const fullText = outputs.get('agents/codex/GATES.md')
  const parsedFull = parseFullCompiledGates(fullText)
  assert.equal(parsedFull.sha256, gatesSha256)
  assert.deepEqual(parsedFull.routeGraphs, compiledGateGraphs(contracts.gates))
  assert.deepEqual(parsedFull.definitions, compiledGateDefinitions(contracts.gates))
  assert.equal(validateFullCompiledGates(fullText, contracts.gates, gatesSha256), true)

  const frameworkRoutes = codexFrameworkRoutes(ROOT)
  for (const [file, routes] of Object.entries(frameworkRoutes)) {
    const parsed = parseFrameworkCompiledGates(outputs.get(`agents/codex/frameworks/${file}`))
    assert.equal(parsed.sha256, gatesSha256, file)
    assert.deepEqual(parsed.routeGraphs, compiledGateGraphs(contracts.gates, routes), file)
  }
  assert.equal(validateFrameworkGateProjections(outputs, contracts.gates, gatesSha256, frameworkRoutes), true)

  for (const relativePath of ['agents/codex/SKILL.md', 'agents/codex/agents/ap-route-analyst.toml']) {
    const parsed = parseCompiledRouteExamples(outputs.get(relativePath))
    assert.equal(parsed.sha256, routesSha256, relativePath)
    assert.deepEqual(parsed.examples, contracts.routes.examples, relativePath)
    assert.equal(validateCompiledRouteExamples(outputs.get(relativePath), contracts.routes, routesSha256, relativePath), true)
    const projected = new Map(parsed.examples.map(example => [example.id, example.route]))
    assert.equal(projected.get('twenty-file-rename'), 'DIRECT', `${relativePath} must not route by file count`)
    assert.equal(projected.get('three-file-cross-service-rollout'), 'ROADMAP', `${relativePath} must preserve dependency routing`)
  }

  assert.throws(
    () => validateFullCompiledGates(fullText.replace('- Leaf: `final-record`\n', ''), contracts.gates, gatesSha256),
    /leaves|projection is not canonical/,
  )
  assert.throws(
    () => validateFullCompiledGates(fullText.replace('- Maximum attempts: `2`', '- Maximum attempts: `99`'), contracts.gates, gatesSha256),
    /execution\/retry projection is not canonical/,
  )
  const mutatedFrameworks = new Map(outputs)
  const applyPath = 'agents/codex/frameworks/apply.md'
  mutatedFrameworks.set(applyPath, outputs.get(applyPath).replace('"final-record",', ''))
  assert.throws(
    () => validateFrameworkGateProjections(mutatedFrameworks, contracts.gates, gatesSha256, frameworkRoutes),
    /leaves|graph projection is not canonical/,
  )
  assert.throws(
    () => validateCompiledRouteExamples(
      outputs.get('agents/codex/SKILL.md').replace('"route":"DIRECT"', '"route":"ROADMAP"'),
      contracts.routes,
      routesSha256,
      'Codex L0 prompt',
    ),
    /route examples are not canonical/,
  )
})

test('canonical framework doctrine composes evidence without circular or conflicting prose', () => {
  const canonical = renderSharedFrameworkOutputs(ROOT)
  const generated = renderCodexOutputs(ROOT)
  const readCanonical = file => canonical.get(`agents/contracts/frameworks/${file}`)

  assert.match(readCanonical('README.md'), /Select the route before creating any roadmap/u)
  assert.match(readCanonical('README.md'), /unit fake[\s\S]*paired contract fixture[\s\S]*separate real integration/u)
  assert.match(readCanonical('README.md'), /performance[\s\S]*SLO[\s\S]*rollback criteria/iu)
  assert.match(readCanonical('README.md'), /schema-validated `events\.jsonl`[\s\S]*migration[\s\S]*digest/u)
  assert.doesNotMatch(readCanonical('README.md'), /approved executable `ROADMAP\.md`/u)
  assert.match(
    readCanonical('plan-scope.md'),
    /original-request acceptance as the scope ceiling[\s\S]*necessary for an accepted ask[\s\S]*marginal-value check[\s\S]*count of its concrete behavior-change asks[\s\S]*original-request success-checklist asks[\s\S]*frozen `ROADMAP\.md` SHA-256[\s\S]*preserve that measurement across scheduler restart/u,
  )
  assert.doesNotMatch(readCanonical('plan-scope.md'), /intent, not literal minimum|WHOLE deliverable at 100%|thin\/MVP-stub scope/u)

  const review = readCanonical('frontend-review.md')
  assert.match(review, /read-only/u)
  assert.match(review, /review never performs or dispatches those changes/u)
  assert.doesNotMatch(review, /falls? to `frontend-(?:fix|implement)`/u)

  assert.match(readCanonical('apply.md'), /after bounded diagnosis[\s\S]*Terminate honestly/iu)
  assert.doesNotMatch(readCanonical('apply.md'), /NEVER yielding|loop that verdict/u)

  const generation = readCanonical('generation.md')
  for (const field of ['acceptanceOverlays', 'oracle', 'evidenceSchema', 'owner', 'retryPolicy']) {
    assert.match(generation, new RegExp(`\\b${field}\\b`), field)
  }
  assert.match(generation, /Compound acceptance is an array, never a scalar/u)
  assert.match(generation, /Do not add surrounding prose that restates, reorders, or omits checks/u)

  const composition = readCanonical('composition.md')
  assert.match(composition, /ordered ownership transfer[\s\S]*resulting hash[\s\S]*translates ownership/u)
  assert.match(composition, /implementation may own `ui\/card\.css`[\s\S]*polish may accept that exact hash/u)

  const docs = readCanonical('docs.md')
  for (const predicate of ['audienceUnresolved', 'informationArchitectureUnresolved', 'sourceAuthorityUnresolved']) {
    assert.match(docs, new RegExp(`\\b${predicate}\\b`), predicate)
  }
  assert.match(docs, /Planning depends on ambiguity, never tier/u)

  for (const file of Object.keys(codexFrameworkRoutes(ROOT))) {
    const rendered = generated.get(`agents/codex/frameworks/${file}`)
    assert.equal((rendered.match(/AUTOPROMPT-FRAMEWORK-GATES:BEGIN/g) || []).length, 1, file)
    assert.doesNotMatch(rendered, /REQUIRED CHECK PATH|NEVER yielding|loop that verdict/u, file)
  }

  const coordinator = generated.get('agents/codex/agents/ap-run-coordinator.toml')
  assert.match(coordinator, /Before the first child assignment and after every steering input/u)
  assert.match(coordinator, /resolve the active request pointer[\s\S]*compute SHA-256[\s\S]*bound request-envelope hash/u)
  assert.match(coordinator, /REQUEST_BINDING_INVALID/u)

  const deadAnchor = new Map(canonical)
  deadAnchor.set('agents/contracts/frameworks/composition.md',
    `${composition}\n[missing](README.md#missing-anchor)\n`)
  assert.throws(() => validateFrameworkReferences(deadAnchor, ROOT), /dead anchor/)

  const staleCapacity = new Map(canonical)
  staleCapacity.set('agents/contracts/frameworks/composition.md', `${composition}\nUse a 200-agent base.\n`)
  assert.throws(() => validateFrameworkReferences(staleCapacity, ROOT), /stale numeric capacity/)
})

test('Codex generation ignores the legacy contract and fails closed on a stale v2 input', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-generator-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  fs.mkdirSync(path.join(sandbox, 'agents'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'agents', 'contracts'), path.join(sandbox, 'agents', 'contracts'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'agents', 'codex'), path.join(sandbox, 'agents', 'codex'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'assets'), path.join(sandbox, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(sandbox, 'scripts', 'install'), { recursive: true })
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'install', 'codex-package-registry.json'),
    path.join(sandbox, 'scripts', 'install', 'codex-package-registry.json'),
  )
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'install', 'legacy-codex-compat.json'),
    path.join(sandbox, 'scripts', 'install', 'legacy-codex-compat.json'),
  )
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(sandbox, 'package.json'))
  fs.mkdirSync(path.join(sandbox, 'packages', 'codex'), { recursive: true })
  const codexPackagePath = path.join(sandbox, 'packages', 'codex', 'package.json')
  fs.copyFileSync(path.join(ROOT, 'packages', 'codex', 'package.json'), codexPackagePath)

  fs.rmSync(codexPackagePath)
  assert.throws(() => renderCodexOutputs(sandbox), /Codex package metadata is missing/)
  fs.writeFileSync(codexPackagePath, '{"version":"not-semver"}\n')
  assert.throws(() => renderCodexOutputs(sandbox), /must declare a valid semantic version/)
  fs.copyFileSync(path.join(ROOT, 'packages', 'codex', 'package.json'), codexPackagePath)

  fs.writeFileSync(path.join(sandbox, 'agents', 'contracts', 'autoprompt.contract.json'), '{ invalid legacy JSON\n')
  const sandboxContracts = loadCodexV2Contracts(sandbox)
  const sandboxRegistry = loadCodexPackageRegistry(sandbox)
  const sandboxTopLevelCount = Object.keys(sandboxRegistry.generatedOutputs)
    .filter(key => !['agents', 'frameworks'].includes(key)).length
  assert.equal(renderCodexOutputs(sandbox).size,
    Object.keys(sandboxContracts.rolePolicy.physical_roles).length +
      renderSharedFrameworkOutputs(sandbox, sandboxContracts.plainLanguage).size + sandboxTopLevelCount)

  for (const file of ['SKILL.md', 'GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'VERSION']) {
    fs.rmSync(path.join(sandbox, 'agents', 'codex', file), { force: true })
  }
  fs.rmSync(path.join(sandbox, 'agents', 'codex', 'frameworks'), { recursive: true, force: true })
  for (const file of fs.readdirSync(path.join(sandbox, 'agents', 'codex', 'agents'))) {
    if (/^ap-[a-z0-9-]+\.toml$/u.test(file)) {
      fs.rmSync(path.join(sandbox, 'agents', 'codex', 'agents', file))
    }
  }
  const sourceIndependent = renderCodexOutputs(sandbox)
  assert.equal(sourceIndependent.size,
    Object.keys(sandboxContracts.rolePolicy.physical_roles).length +
      renderSharedFrameworkOutputs(sandbox, sandboxContracts.plainLanguage).size + sandboxTopLevelCount)
  assert.match(sourceIndependent.get('agents/codex/agents/ap-arbiter.toml'), /reversible technical alternatives/i)

  const sharedFrameworkPath = path.join(sandbox, 'agents', 'contracts', 'frameworks', 'apply.md')
  const sharedFramework = fs.readFileSync(sharedFrameworkPath, 'utf8')
  fs.writeFileSync(sharedFrameworkPath, `${sharedFramework}\nStart a worker fleet.\n`)
  assert.throws(() => renderCodexOutputs(sandbox), /forbidden prompt term fleet/)
  fs.writeFileSync(sharedFrameworkPath, sharedFramework)

  const productPath = path.join(sandbox, 'agents', 'contracts', 'product.json')
  const product = JSON.parse(fs.readFileSync(productPath, 'utf8'))
  product.contractVersion = '1.0.0'
  fs.writeFileSync(productPath, `${JSON.stringify(product, null, 2)}\n`)
  assert.throws(() => renderCodexOutputs(sandbox), /product has a stale contract version/)
})

test('provider projection stays Codex-first, capability-gated, and plain-language checked', () => {
  const contracts = loadCodexV2Contracts(ROOT)
  const packageRegistry = loadCodexPackageRegistry(ROOT)
  assert.equal(contracts.projectionPlan.length, 9)
  const codex = contracts.projectionPlan.find(decision => decision.provider === 'codex')
  assert.deepEqual(codex, {
    provider: 'codex',
    portOpen: true,
    runtimeAdmitted: false,
    projectionMode: 'SAFE_DEGRADED',
    claimsRealBehavior: false,
    reason: 'attestation-required-before-runtime-admission',
  })
  assert.ok(contracts.projectionPlan
    .filter(decision => decision.provider !== 'codex')
    .every(decision => decision.projectionMode === 'PORT_CLOSED' && decision.claimsRealBehavior === false))

  const unsafe = structuredClone(contracts)
  const claude = unsafe.providers.providers.find(provider => provider.id === 'claude')
  claude.capabilities.processOwnership = 'supported'
  claude.verificationAttestation = null
  assert.throws(() => providerProjectionPlan(unsafe), /claims verified capability without an attestation/)

  assert.deepEqual(
    plainLanguageViolations('Coordinate the mission fleet.', contracts.plainLanguage, 'fixture')
      .map(({ term }) => term),
    ['mission', 'fleet'],
  )
  assert.throws(
    () => validateGeneratedPlainLanguage(
      new Map([['agents/codex/fixture.md', 'Start a worker fleet.']]),
      contracts.plainLanguage,
    ),
    /forbidden prompt term fleet/,
  )
  const shared = renderSharedFrameworkOutputs(ROOT, contracts.plainLanguage)
  assert.equal(shared.size,
    fs.readdirSync(path.join(ROOT, 'agents', 'contracts', 'frameworks'))
      .filter(name => name.endsWith('.md')).length)
  for (const [relativePath, content] of shared) {
    assert.equal(plainLanguageViolations(content, contracts.plainLanguage, relativePath).length, 0, relativePath)
  }
  const normalized = normalizePlainLanguageMarkdown(
    'Coordinate the mission fleet through one gate. Keep `mission` as quoted technical evidence.\n',
    contracts.plainLanguage,
  )
  assert.equal(
    normalized,
    'Coordinate the original request group of workers through one required check. Keep `mission` as quoted technical evidence.\n',
  )

  assert.equal(validateCodexUserFacingLanguage(
    contracts.plainLanguage,
    ROOT,
    new Map(),
    packageRegistry.plainLanguageAuditedExceptions,
  ), true)

  const hiddenCanonicalProse = structuredClone(contracts)
  hiddenCanonicalProse.gates.definitions['behavior-test'].execution.negativePaths[1].condition =
    'The command returns but the oracle rejects the result.'
  assert.throws(
    () => validateCanonicalAndSharedPlainLanguage(hiddenCanonicalProse, ROOT),
    /agents\/contracts\/gates[^:]*:.*forbidden prompt term oracle/,
  )

  const generatedChecks = renderCodexOutputs(ROOT).get('agents/codex/GATES.md')
  assert.match(
    generatedChecks,
    /`oracle-rejected`.*observable check.*`mission-coordinator`.*run coordinator.*`candidateVersionHash`.*exact version being checked/is,
  )
  const runtimePath = 'agents/codex/workflow/captured-domain.js'
  assert.throws(() => validateCodexUserFacingLanguage(
    contracts.plainLanguage,
    ROOT,
    new Map([[runtimePath, `${read(runtimePath)}\nconsole.log('Start the mission fleet.')\n`]]),
    packageRegistry.plainLanguageAuditedExceptions,
  ), /forbidden prompt term (?:mission|fleet)/)
  const diagramPath = 'assets/anatomy.svg'
  assert.throws(() => validateCodexUserFacingLanguage(
    contracts.plainLanguage,
    ROOT,
    new Map([[diagramPath, `${read(diagramPath)}\n<text>Mission fleet</text>\n`]]),
    packageRegistry.plainLanguageAuditedExceptions,
  ), /forbidden prompt term (?:mission|fleet)/)
})

test('all providers expose the same framework set', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  const expected = contract.frameworks.map(framework => `${framework.id}.md`).sort()

  for (const provider of [
    'claude', 'codex', 'opencode', 'kilo', 'vscode', 'omp', 'deepseek', 'reasonix',
  ]) {
    const actual = fs.readdirSync(path.join(ROOT, 'agents', provider, 'frameworks'))
      .filter(name => name.endsWith('.md'))
      .sort()
    assert.deepEqual(actual, expected, provider)
  }
  const prime = fs.readdirSync(path.join(ROOT, 'agents', 'prime', 'prompts', 'frameworks'))
    .filter(name => name.endsWith('.md'))
    .sort()
  assert.deepEqual(prime, expected, 'prime')
})

test('new harness adapters encode their audited native contracts', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))

  assert.equal(contract.providers.omp.target, '17.4.0')
  assert.equal(contract.providers.omp.profile.agents, 'native-markdown')
  assert.equal(contract.providers.omp.profile.model, 'inherit')

  assert.equal(contract.providers.deepseek.target, '0.1.0-rc.7')
  assert.equal(contract.providers.deepseek.profile.dispatch, 'fixed-persona-subagent-tools')
  assert.equal(contract.providers.deepseek.profile.model, 'inherit')
  const preset = read('agents/deepseek/agent-preset/agent.cordis.yml')
  const personaCount = contract.personas.length
  assert.equal((preset.match(/name: '@deepseek-ai\/dsh-tool-subagent'/g) ?? []).length, personaCount)
  assert.equal((preset.match(/^\s+toolName: ap_[a-z0-9_]+$/gm) ?? []).length, personaCount)
  assert.doesNotMatch(preset, /^\s+toolName: subagent(?:_fork)?$/m)
  assert.equal((preset.match(/^\s+persona: \|-$/gm) ?? []).length, personaCount)
  assert.equal((preset.match(/^        - subagent$/gm) ?? []).length, personaCount)
  assert.equal((preset.match(/^        - subagent_fork$/gm) ?? []).length, personaCount)
  const headlessPatch = read('agents/deepseek/headless.patch.yml')
  assert.doesNotMatch(preset, /[ \t]+$/m)
  assert.doesNotMatch(headlessPatch, /[ \t]+$/m)

  assert.equal(contract.providers.reasonix.target, '1.30.0')
  assert.equal(contract.providers.reasonix.profile.agents, 'native-subagent-skills')
  assert.equal(contract.providers.reasonix.profile.model, 'inherit')
})

test('the VS Code package records its proven runtime contract and has valid links', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  assert.deepEqual(contract.providers.vscode, {
    frontmatter: {
      required: [
        'name',
        'description',
        'tools',
        'agents',
        'user-invocable',
        'disable-model-invocation',
      ],
      model: 'omit',
    },
    capabilities: [
      'native-markdown-subagents',
      'recursive-subagents',
      'selected-model-inheritance',
    ],
    runtimePrerequisites: {
      'chat.subagents.allowInvocationsFromSubagents': true,
    },
    settingsLifecycle: {
      edit: 'transactional',
      backup: 'byte-exact',
      restore: ['rollback', 'uninstall'],
      unsafeJsonc: 'refuse',
      conflicts: 'refuse',
    },
    allowedDeltas: [
      'skill-frontmatter',
      'markdown-agent-export',
      'agent-tool-alias',
      'explicit-agent-allowlists',
      'selected-model-inheritance',
    ],
  })
  assert.equal(contract.generated.vscodeAgents, 'agents/vscode/agents')
  assert.equal(contract.generated.vscodeFrameworks, 'agents/vscode/frameworks')

  const files = [
    'SKILL.md',
    'GATES.md',
    'MODES.md',
    'PLAYBOOKS.md',
    'README.md',
  ]
  for (const file of files) {
    const source = read(`agents/vscode/${file}`)
    assert.doesNotMatch(source, /[\u2013\u2014]/, `${file} must use ASCII punctuation`)
    assert.doesNotMatch(source, /OpenCode|opencode|OPENCODE|subagent_depth/, `${file} provider language`)
  }

  const packageRoot = path.join(ROOT, 'agents', 'vscode')
  const packageFiles = filesBelow(packageRoot)
  const agents = packageFiles
    .filter(file => file.endsWith('.agent.md'))
    .map(file => path.basename(file))
    .sort()
  assert.deepEqual(
    agents,
    contract.personas.map(persona => `${persona.id}.agent.md`).sort(),
  )
  for (const absolutePath of packageFiles) {
    const source = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n')
    const label = path.relative(packageRoot, absolutePath).split(path.sep).join('/')
    assert.doesNotMatch(source, /[\u2013\u2014]/, `${label} must use ASCII punctuation`)
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (/^(?:[a-z]+:|#)/i.test(target)) continue
      const relative = target.split('#', 1)[0]
      assert.equal(
        fs.existsSync(path.resolve(path.dirname(absolutePath), relative)),
        true,
        `${label} link ${target}`,
      )
    }
  }

  const readme = read('agents/vscode/README.md')
  assert.match(readme, /VS Code 1\.133/)
  assert.match(readme, /GitHub Copilot 0\.61/)

  for (const file of ['README.md', 'SKILL.md', 'GATES.md', 'MODES.md']) {
    const source = read(`agents/vscode/${file}`)
    assert.match(
      source,
      /installer transactionally sets `chat\.subagents\.allowInvocationsFromSubagents=true`/i,
      `${file} transactional settings edit`,
    )
    assert.match(source, /byte-exact backup/i, `${file} settings backup`)
    assert.match(
      source,
      /restores the prior bytes on rollback or uninstall/i,
      `${file} settings restore`,
    )
    assert.match(
      source,
      /refuses unsafe JSONC and conflicting state/i,
      `${file} unsafe settings refusal`,
    )
    assert.doesNotMatch(
      source,
      /(?:does not|never) (?:edit|mutate) (?:VS Code settings|that setting)|user must enable/i,
      `${file} stale settings claim`,
    )
  }
})
