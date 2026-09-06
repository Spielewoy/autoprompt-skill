#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const CODEX_PACKAGE_REGISTRY = 'scripts/install/codex-package-registry.json'

function read(relativePath, root = ROOT) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function writeAtomic(relativePath, content, root = ROOT) {
  const target = path.join(root, relativePath)
  const temporary = `${target}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, target)
}

function readCodexPackageVersion(root = ROOT) {
  const relativePath = 'scripts/release/codex/package.json'
  if (!fs.existsSync(path.join(root, relativePath))) {
    throw new Error(`Codex package metadata is missing: ${relativePath}`)
  }
  const version = readJson(relativePath, root).version
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`${relativePath} must declare a valid semantic version`)
  }
  return version
}

function loadCodexPackageRegistry(root = ROOT) {
  const registry = readJson(CODEX_PACKAGE_REGISTRY, root)
  requireCondition(registry.schemaVersion === 1 && registry.provider === 'codex', 'Codex package registry identity is invalid')
  const inputs = registry.canonicalInputs || {}
  const outputs = registry.generatedOutputs || {}
  for (const key of ['conductor', 'gates', 'playbooks', 'frameworks', 'rolePolicy', 'personas']) {
    requireCondition(
      typeof inputs[key] === 'string' && (
        inputs[key].startsWith('agents/contracts/') ||
        key === 'rolePolicy' && inputs[key] === 'agents/codex/agents/role-policy.json'
      ),
    `Codex package registry canonical input ${key} is invalid`)
  }
  requireCondition(Array.isArray(inputs.modes) && inputs.modes.length > 0, 'Codex package registry mode inputs are invalid')
  for (const key of CODEX_DOCTRINE_FILES) {
    requireCondition(outputs[key] === `agents/codex/${key}`, `Codex package registry output ${key} is invalid`)
  }
  requireCondition(outputs.frameworks === 'agents/codex/frameworks', 'Codex package registry framework output is invalid')
  requireCondition(outputs.agents === 'agents/codex/agents', 'Codex package registry agent output is invalid')
  requireCondition(outputs.version === 'agents/codex/VERSION', 'Codex package registry version output is invalid')
  const frameworkRoutes = registry.frameworkRoutes || {}
  requireCondition(Object.keys(frameworkRoutes).length > 0, 'Codex package registry framework route map is missing')
  for (const [file, routes] of Object.entries(frameworkRoutes)) {
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9-]*\.md$/u.test(file), `Codex framework route file is invalid: ${file}`)
    requireCondition(Array.isArray(routes) && routes.length > 0 &&
      new Set(routes).size === routes.length && routes.every(route => ALL_CODEX_ROUTES.includes(route)),
    `Codex framework route mapping is invalid: ${file}`)
  }
  requireCondition(ALL_CODEX_ROUTES.every(route =>
    Object.values(frameworkRoutes).some(routes => routes.includes(route))),
  'Codex framework route map does not cover every route')

  const requiredRoleCapabilities = registry.requiredRoleCapabilities || []
  requireCondition(requiredRoleCapabilities.length > 0, 'Codex required role capabilities are missing')
  const capabilityIds = new Set()
  for (const requirement of requiredRoleCapabilities) {
    requireCondition(requirement && /^[a-z][a-z0-9-]*$/u.test(requirement.id) &&
      /^[a-z][a-z0-9-]*$/u.test(requirement.logicalRole) &&
      Array.isArray(requirement.requiredModes) && requirement.requiredModes.length > 0 &&
      new Set(requirement.requiredModes).size === requirement.requiredModes.length &&
      requirement.requiredModes.every(mode => typeof mode === 'string' && mode.length > 0),
    `Codex required role capability is invalid: ${requirement?.id || 'unknown'}`)
    requireCondition(!capabilityIds.has(requirement.id), `Codex required role capability repeats ${requirement.id}`)
    capabilityIds.add(requirement.id)
  }

  const migrationSources = new Set(registry.migrationSources || [])
  const requiredMigrations = registry.requiredMigrations || []
  requireCondition(requiredMigrations.length > 0, 'Codex required migrations are missing')
  const migrationIds = new Set()
  for (const migration of requiredMigrations) {
    requireCondition(migration && /^[a-z][a-z0-9-]*$/u.test(migration.id) &&
      typeof migration.source === 'string' && migration.source.length > 0,
    `Codex required migration is invalid: ${migration?.id || 'unknown'}`)
    requireCondition(!migrationIds.has(migration.id), `Codex required migration repeats ${migration.id}`)
    requireCondition(migrationSources.has(migration.source), `Codex required migration ${migration.id} is missing`)
    migrationIds.add(migration.id)
  }
  for (const [physicalId, requirements] of Object.entries(registry.promptRequirements || {})) {
    requireCondition(/^ap-[a-z0-9-]+$/u.test(physicalId) && Array.isArray(requirements) &&
      requirements.length > 0 && requirements.every(value => typeof value === 'string' && value.trim()),
    `Codex package registry prompt requirements for ${physicalId} are invalid`)
  }
  const exceptionPaths = new Set()
  for (const exception of registry.plainLanguageAuditedExceptions || []) {
    requireCondition(exception && typeof exception.path === 'string' &&
      (/^agents\/codex\/workflow\/[^/]+\.(?:js|sh|ps1)$/u.test(exception.path) ||
        /^assets\/(?:[^/]+\/)*[^/]+\.svg$/u.test(exception.path)) &&
      /^[a-f0-9]{64}$/u.test(exception.sha256) && Array.isArray(exception.terms) &&
      exception.terms.length > 0 && exception.terms.every(term => typeof term === 'string') &&
      typeof exception.reason === 'string' && exception.reason.trim().length > 20,
    `Codex plain-language audited exception is invalid: ${exception?.path || 'unknown'}`)
    requireCondition(!exceptionPaths.has(exception.path), `Codex plain-language audited exception repeats ${exception.path}`)
    exceptionPaths.add(exception.path)
  }
  return Object.freeze(registry)
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '')
}

function yamlDoubleQuoted(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function asciiDashes(value) {
  return value.replace(/[\u2013\u2014]/g, '-')
}

function tomlBasicString(value) {
  return JSON.stringify(value)
}

function tomlStringArray(values) {
  return `[${values.map(tomlBasicString).join(', ')}]`
}

function codexSandbox(capabilities) {
  return capabilities.some(capability => ['Write', 'Edit', 'Bash'].includes(capability))
    ? 'workspace-write'
    : 'read-only'
}

function renderCodexAgent(persona, source) {
  const body = stripFrontmatter(source).replace(/\n+$/, '')
  if (body.includes('"""')) {
    throw new Error(`Codex persona ${persona.id} contains an unsupported TOML multiline delimiter`)
  }
  return [
    `sandbox_mode = ${tomlBasicString(codexSandbox(persona.capabilities))}`,
    `name = ${tomlBasicString(persona.id)}`,
    `description = ${tomlBasicString(persona.description)}`,
    '',
    'developer_instructions = """',
    body,
    '"""',
    '',
  ].join('\n')
}

const CODEX_V2_INPUTS = Object.freeze([
  'agents/contracts/product.json',
  'agents/contracts/routes.json',
  'agents/contracts/state-machine.json',
  'agents/contracts/roles.json',
  'agents/contracts/gates.json',
  'agents/contracts/providers.json',
  'agents/contracts/plain-language.json',
])

const CODEX_ALIAS_TARGET_BY_LOGICAL_ROLE = Object.freeze({
  'mission-coordinator': 'ap-run-coordinator',
  'ap-work-group-manager': 'ap-work-group-manager',
  'roadmap-author': 'ap-roadmap-author',
  scout: 'ap-roadmap-scout',
  worker: 'ap-worker',
  'independent-checker': 'ap-independent-checker',
  'independent-reviewer': 'ap-independent-checker',
  'independent-tester': 'ap-independent-checker',
  'plan-checker': 'ap-independent-checker',
  'technical-decision-reviewer': 'ap-independent-checker',
  'diagnostic-probe': 'C0',
  'legacy-intake': 'C0',
  'deterministic-control-plane': 'C0',
})

const CODEX_DOCTRINE_FILES = Object.freeze([
  'GATES.md',
  'MODES.md',
  'PLAYBOOKS.md',
  'SKILL.md',
])

const CODEX_ACTIVATION_SYNTAX = Object.freeze({
  externalCommand: 'autoprompt activate codex ... -- <mission>',
  internalSkillEnvelope: '$autoprompt',
  unsupportedSlashCommand: '/autoprompt',
  unsupportedCode: 'INVALID_INPUT',
})

const CODEX_ALIAS_TELEMETRY_INSTRUCTION = 'When this compatibility id is used, deterministic control code records the alias use in the registered compatibility telemetry log. This read-only role must not write that log.'

const ALL_CODEX_ROUTES = Object.freeze(['DIRECT', 'LIGHT', 'ROADMAP'])

function codexFrameworkRoutes(root = ROOT) {
  const configured = loadCodexPackageRegistry(root).frameworkRoutes
  return Object.freeze(Object.fromEntries(Object.entries(configured)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, routes]) => [file, Object.freeze([...routes])])))
}

function codexFrameworkFiles(root = ROOT) {
  return Object.freeze(Object.keys(codexFrameworkRoutes(root)))
}

const COMPILED_GATES_BEGIN = '<!-- AUTOPROMPT-COMPILED-GATES:BEGIN v2'
const COMPILED_GATES_END = '<!-- AUTOPROMPT-COMPILED-GATES:END -->'
const FRAMEWORK_GATES_BEGIN = '<!-- AUTOPROMPT-FRAMEWORK-GATES:BEGIN v2'
const FRAMEWORK_GATES_END = '<!-- AUTOPROMPT-FRAMEWORK-GATES:END -->'
const ROUTE_EXAMPLES_BEGIN = '<!-- AUTOPROMPT-COMPILED-ROUTE-EXAMPLES:BEGIN v2'
const ROUTE_EXAMPLES_END = '<!-- AUTOPROMPT-COMPILED-ROUTE-EXAMPLES:END -->'

const PUBLIC_PROVIDER_IDS = Object.freeze([
  'claude',
  'codex',
  'deepseek',
  'kilo',
  'omp',
  'opencode',
  'prime',
  'reasonix',
  'vscode',
])

const PROVIDER_CAPABILITY_FIELDS = Object.freeze([
  'isolation',
  'topologyEnforcement',
  'privateSkillRoot',
  'eventStreaming',
  'toolOutputCapture',
  'stableChildIdentity',
  'sameContextContinuation',
  'cancellation',
  'isolatedChecking',
  'processOwnership',
  'modelRouting',
])

const SAFE_WRITE_SETS = Object.freeze({
  'route-analyst': Object.freeze([]),
  'mission-coordinator': Object.freeze([]),
  'ap-work-group-manager': Object.freeze([]),
  'roadmap-author': Object.freeze(['plan.roadmap.write']),
  scout: Object.freeze([]),
  worker: Object.freeze(['target.owned.write', 'report.owned.write', 'harness.owned.write']),
  'independent-checker': Object.freeze(['isolated-check.write']),
  'independent-reviewer': Object.freeze([]),
  'independent-tester': Object.freeze([]),
  'plan-checker': Object.freeze([]),
  'technical-decision-reviewer': Object.freeze([]),
  'diagnostic-probe': Object.freeze([]),
  'legacy-intake': Object.freeze([]),
  'deterministic-control-plane': Object.freeze([]),
})

const SAFE_EXCLUSIVE_SETS = Object.freeze({
  'route-analyst': Object.freeze([]),
  'mission-coordinator': Object.freeze([]),
  'ap-work-group-manager': Object.freeze([]),
  'roadmap-author': Object.freeze(['plan.roadmap.write']),
  scout: Object.freeze([]),
  worker: Object.freeze(['target.owned.write', 'report.owned.write', 'harness.owned.write']),
  'independent-checker': Object.freeze(['check-resources.exclusive']),
  'independent-reviewer': Object.freeze([]),
  'independent-tester': Object.freeze([]),
  'plan-checker': Object.freeze([]),
  'technical-decision-reviewer': Object.freeze([]),
  'diagnostic-probe': Object.freeze([]),
  'legacy-intake': Object.freeze([]),
  'deterministic-control-plane': Object.freeze([]),
})

const COORDINATOR_TARGET_READ_POLICIES = Object.freeze({
  'ap-run-coordinator': Object.freeze({
    logicalRole: 'mission-coordinator',
    logicalReads: Object.freeze([
      'request-envelope',
      'accepted-roadmap',
      'assigned-target-resources',
      'run-state',
      'ownership-record',
      'worker-results',
    ]),
  }),
  'ap-work-group-manager': Object.freeze({
    logicalRole: 'ap-work-group-manager',
    logicalReads: Object.freeze([
      'assigned-work-group',
      'assigned-target-resources',
      'ownership-record',
      'worker-results',
    ]),
  }),
})

const COORDINATOR_TARGET_READ_RESOURCES = Object.freeze([
  'request-envelope.read',
  'plan.roadmap.read',
  'target.named.read',
  'prior-results.read',
])

function readJson(relativePath, root = ROOT) {
  let value
  try {
    value = JSON.parse(read(relativePath, root))
  } catch (error) {
    throw new Error(`invalid JSON ${relativePath}: ${error.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${relativePath} must contain an object`)
  }
  return value
}

function sameMembers(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Codex v2 generation denied: ${message}`)
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

function replaceCompiledSection(source, begin, end, rendered) {
  const escapedBegin = escapeRegExp(begin)
  const escapedEnd = escapeRegExp(end)
  const section = new RegExp(`\\n?${escapedBegin}[^\\n]*\\n[\\s\\S]*?${escapedEnd}\\n?`, 'g')
  return `${String(source).replace(section, '\n').replace(/\s+$/, '')}\n\n${rendered}\n`
}

function sortedGateEdges(edges) {
  return [...edges].sort((left, right) =>
    left.before.localeCompare(right.before) || left.after.localeCompare(right.after))
}

function gateGraphProjection(graph, route) {
  requireCondition(graph && typeof graph === 'object' && !Array.isArray(graph), `${route} check graph is missing`)
  const leaves = graph.leaves || []
  const edges = graph.edges || []
  const order = graph.order || []
  requireCondition(leaves.length > 0 && new Set(leaves).size === leaves.length, `${route} check leaves are empty or repeated`)
  requireCondition(JSON.stringify(leaves) === JSON.stringify([...leaves].sort()), `${route} check leaves are not sorted`)
  requireCondition(JSON.stringify(edges) === JSON.stringify(sortedGateEdges(edges)), `${route} check edges are not sorted`)
  requireCondition(order.length === leaves.length && sameMembers(order, leaves), `${route} check order does not cover its leaves`)
  const position = new Map(order.map((leaf, index) => [leaf, index]))
  const required = Object.fromEntries(order.map(leaf => [leaf, []]))
  for (const edge of edges) {
    requireCondition(position.has(edge.before) && position.has(edge.after), `${route} check edge names an unknown leaf`)
    requireCondition(position.get(edge.before) < position.get(edge.after), `${route} check edge contradicts its order`)
    required[edge.after].push(edge.before)
  }
  for (const dependencies of Object.values(required)) dependencies.sort()
  const expectedRequired = Object.fromEntries(order.map(leaf => [leaf, [...(graph.required && graph.required[leaf] || [])].sort()]))
  requireCondition(JSON.stringify(required) === JSON.stringify(expectedRequired), `${route} required adjacency disagrees with its edges`)
  requireCondition(graph.terminal === order.at(-1), `${route} terminal is not the final ordered leaf`)
  requireCondition(Number.isInteger(graph.maxTransitions) && graph.maxTransitions > 0, `${route} maximum transitions are invalid`)
  return Object.freeze({
    required,
    terminal: graph.terminal,
    leaves: Object.freeze([...leaves]),
    edges: Object.freeze(edges.map(edge => Object.freeze({ before: edge.before, after: edge.after }))),
    order: Object.freeze([...order]),
    maxTransitions: graph.maxTransitions,
  })
}

function compiledGateGraphs(gates, routeNames = ALL_CODEX_ROUTES) {
  return Object.freeze(Object.fromEntries(routeNames.map(route => [
    route,
    gateGraphProjection(gates.routeGraphs && gates.routeGraphs[route], route),
  ])))
}

function gateDefinitionProjection(definition, checkId) {
  requireCondition(definition && typeof definition === 'object', `check ${checkId} is missing`)
  const execution = definition.execution || {}
  const command = execution.command || {}
  const oracle = execution.oracle || {}
  const retry = definition.retryPolicy || {}
  requireCondition(typeof definition.owner === 'string' && definition.owner, `check ${checkId} owner is missing`)
  requireCondition(typeof command.name === 'string' && Array.isArray(command.argv), `check ${checkId} command is incomplete`)
  requireCondition(Array.isArray(command.requiredCapabilities) && command.availability, `check ${checkId} command capability proof is incomplete`)
  requireCondition(Array.isArray(oracle.requiredCapabilities) && oracle.availability, `check ${checkId} oracle capability proof is incomplete`)
  requireCondition(Array.isArray(execution.negativePaths) && execution.negativePaths.length > 0, `check ${checkId} negative paths are missing`)
  requireCondition(Number.isInteger(retry.maxAttempts) && retry.maxAttempts > 0, `check ${checkId} retry maximum is invalid`)
  requireCondition(Number.isInteger(retry.maxUnchangedFailures) && retry.maxUnchangedFailures >= 0, `check ${checkId} unchanged-failure maximum is invalid`)
  requireCondition(retry.onExhaustion && retry.onExhaustion.state && retry.onExhaustion.outcomeCode, `check ${checkId} exhaustion result is incomplete`)
  return Object.freeze({
    owner: definition.owner,
    execution: Object.freeze({
      command: Object.freeze({
        kind: command.kind,
        name: command.name,
        argv: Object.freeze([...command.argv]),
        workingDirectory: command.workingDirectory,
        timeoutSeconds: command.timeoutSeconds,
        availability: command.availability,
        requiredCapabilities: Object.freeze([...command.requiredCapabilities]),
      }),
      oracle: Object.freeze({
        kind: oracle.kind,
        availability: oracle.availability,
        requiredCapabilities: Object.freeze([...oracle.requiredCapabilities]),
        successCondition: oracle.successCondition,
      }),
      negativePaths: Object.freeze(execution.negativePaths.map(pathRecord => Object.freeze(JSON.parse(JSON.stringify(pathRecord))))),
    }),
    retryPolicy: Object.freeze({
      kind: retry.kind,
      maxAttempts: retry.maxAttempts,
      retryableFailures: Object.freeze([...retry.retryableFailures]),
      requiresProgressAfterFailure: retry.requiresProgressAfterFailure,
      progressFingerprintFields: Object.freeze([...retry.progressFingerprintFields]),
      maxUnchangedFailures: retry.maxUnchangedFailures,
      onExhaustion: Object.freeze({
        state: retry.onExhaustion.state,
        outcomeCode: retry.onExhaustion.outcomeCode,
      }),
    }),
  })
}

function compiledGateDefinitions(gates) {
  return Object.freeze(Object.fromEntries(Object.keys(gates.definitions || {}).sort().map(checkId => [
    checkId,
    gateDefinitionProjection(gates.definitions[checkId], checkId),
  ])))
}

function inlineJson(value) {
  return JSON.stringify(value).replace(/`/g, '\\u0060')
}

function renderFullCompiledGates(gates, gatesSha256) {
  requireCondition(/^[a-f0-9]{64}$/.test(gatesSha256), 'compiled check registry hash is invalid')
  const graphs = compiledGateGraphs(gates)
  const definitions = compiledGateDefinitions(gates)
  const lines = [
    `${COMPILED_GATES_BEGIN} sha256=${gatesSha256} -->`,
    '## Compiled required-check registry',
    '',
    'This section is generated from the versioned check registry. Edit the registry, not this projection.',
    'Technical identifiers keep their exact contract spelling: `oracle-rejected` means the observable check rejected a result, `mission-coordinator` means the run coordinator, and `candidateVersionHash` or names containing `-candidate-` refer to the exact version being checked.',
  ]
  for (const route of ALL_CODEX_ROUTES) {
    const graph = graphs[route]
    lines.push('', `### Route \`${route}\``)
    for (const leaf of graph.leaves) lines.push(`- Leaf: \`${leaf}\``)
    for (const edge of graph.edges) lines.push(`- Edge: \`${edge.before}\` -> \`${edge.after}\``)
    lines.push('', '#### Order')
    graph.order.forEach((leaf, index) => lines.push(`${index + 1}. \`${leaf}\``))
    lines.push(`- Maximum transitions: ${graph.maxTransitions}`)
  }
  for (const [checkId, definition] of Object.entries(definitions)) {
    const command = definition.execution.command
    const oracle = definition.execution.oracle
    const retry = definition.retryPolicy
    lines.push(
      '',
      `### Check \`${checkId}\``,
      `- Owner: \`${inlineJson(definition.owner)}\``,
      `- Command kind: \`${inlineJson(command.kind)}\``,
      `- Operation: \`${inlineJson(command.name)}\``,
      `- Arguments: \`${inlineJson(command.argv)}\``,
      `- Working directory: \`${inlineJson(command.workingDirectory)}\``,
      `- Command timeout seconds: \`${inlineJson(command.timeoutSeconds)}\``,
      `- Command availability: \`${inlineJson(command.availability)}\``,
      `- Command required capabilities: \`${inlineJson(command.requiredCapabilities)}\``,
      `- Observable check kind: \`${inlineJson(oracle.kind)}\``,
      `- Observable check availability: \`${inlineJson(oracle.availability)}\``,
      `- Observable check required capabilities: \`${inlineJson(oracle.requiredCapabilities)}\``,
      `- Observable check success condition: \`${inlineJson(oracle.successCondition)}\``,
    )
    for (const negativePath of definition.execution.negativePaths) {
      lines.push(`- Negative path: \`${inlineJson(negativePath)}\``)
    }
    lines.push(
      `- Retry kind: \`${inlineJson(retry.kind)}\``,
      `- Maximum attempts: \`${inlineJson(retry.maxAttempts)}\``,
      `- Retryable failures: \`${inlineJson(retry.retryableFailures)}\``,
      `- Requires progress after failure: \`${inlineJson(retry.requiresProgressAfterFailure)}\``,
      `- Progress fingerprint fields: \`${inlineJson(retry.progressFingerprintFields)}\``,
      `- Maximum unchanged failures: \`${inlineJson(retry.maxUnchangedFailures)}\``,
      `- Exhaustion state: \`${inlineJson(retry.onExhaustion.state)}\``,
      `- Exhaustion outcome code: \`${inlineJson(retry.onExhaustion.outcomeCode)}\``,
    )
  }
  lines.push('', COMPILED_GATES_END)
  return lines.join('\n')
}

function parseJsonBullet(line, label) {
  const match = line.match(new RegExp('^- ' + escapeRegExp(label) + ': `([\\s\\S]*)`$'))
  if (!match) return undefined
  try {
    return JSON.parse(match[1])
  } catch (error) {
    throw new Error(`Codex v2 generation denied: compiled check ${label} is not valid JSON: ${error.message}`)
  }
}

function parseFullCompiledGates(markdown) {
  const pattern = /<!-- AUTOPROMPT-COMPILED-GATES:BEGIN v2 sha256=([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- AUTOPROMPT-COMPILED-GATES:END -->/g
  const matches = [...String(markdown).matchAll(pattern)]
  requireCondition(matches.length === 1, 'compiled check registry projection must occur exactly once')
  const routeParts = Object.fromEntries(ALL_CODEX_ROUTES.map(route => [route, { leaves: [], edges: [], order: [], maxTransitions: null }]))
  const definitions = {}
  let currentRoute = null
  let currentCheck = null
  let readingOrder = false
  for (const line of matches[0][2].split('\n')) {
    const routeHeading = line.match(/^### Route `([^`]+)`$/)
    if (routeHeading) {
      requireCondition(ALL_CODEX_ROUTES.includes(routeHeading[1]), `compiled projection names unknown route ${routeHeading[1]}`)
      currentRoute = routeHeading[1]
      currentCheck = null
      readingOrder = false
      continue
    }
    const checkHeading = line.match(/^### Check `([^`]+)`$/)
    if (checkHeading) {
      requireCondition(!definitions[checkHeading[1]], `compiled projection repeats check ${checkHeading[1]}`)
      currentRoute = null
      currentCheck = checkHeading[1]
      readingOrder = false
      definitions[currentCheck] = { execution: { command: {}, oracle: {}, negativePaths: [] }, retryPolicy: { onExhaustion: {} } }
      continue
    }
    if (currentRoute) {
      if (line === '#### Order') {
        readingOrder = true
        continue
      }
      const leaf = line.match(/^- Leaf: `([^`]+)`$/)
      if (leaf) routeParts[currentRoute].leaves.push(leaf[1])
      const edge = line.match(/^- Edge: `([^`]+)` -> `([^`]+)`$/)
      if (edge) routeParts[currentRoute].edges.push({ before: edge[1], after: edge[2] })
      const ordered = readingOrder && line.match(/^(\d+)\. `([^`]+)`$/)
      if (ordered) {
        requireCondition(Number(ordered[1]) === routeParts[currentRoute].order.length + 1, `${currentRoute} compiled check order numbering is not canonical`)
        routeParts[currentRoute].order.push(ordered[2])
      }
      const transitions = line.match(/^- Maximum transitions: (\d+)$/)
      if (transitions) routeParts[currentRoute].maxTransitions = Number(transitions[1])
      continue
    }
    if (!currentCheck || !line.startsWith('- ')) continue
    const target = definitions[currentCheck]
    const labels = [
      ['Owner', target, 'owner'],
      ['Command kind', target.execution.command, 'kind'],
      ['Operation', target.execution.command, 'name'],
      ['Arguments', target.execution.command, 'argv'],
      ['Working directory', target.execution.command, 'workingDirectory'],
      ['Command timeout seconds', target.execution.command, 'timeoutSeconds'],
      ['Command availability', target.execution.command, 'availability'],
      ['Command required capabilities', target.execution.command, 'requiredCapabilities'],
      ['Observable check kind', target.execution.oracle, 'kind'],
      ['Observable check availability', target.execution.oracle, 'availability'],
      ['Observable check required capabilities', target.execution.oracle, 'requiredCapabilities'],
      ['Observable check success condition', target.execution.oracle, 'successCondition'],
      ['Retry kind', target.retryPolicy, 'kind'],
      ['Maximum attempts', target.retryPolicy, 'maxAttempts'],
      ['Retryable failures', target.retryPolicy, 'retryableFailures'],
      ['Requires progress after failure', target.retryPolicy, 'requiresProgressAfterFailure'],
      ['Progress fingerprint fields', target.retryPolicy, 'progressFingerprintFields'],
      ['Maximum unchanged failures', target.retryPolicy, 'maxUnchangedFailures'],
      ['Exhaustion state', target.retryPolicy.onExhaustion, 'state'],
      ['Exhaustion outcome code', target.retryPolicy.onExhaustion, 'outcomeCode'],
    ]
    let recognized = false
    for (const [label, object, field] of labels) {
      const value = parseJsonBullet(line, label)
      if (value === undefined) continue
      requireCondition(!Object.hasOwn(object, field), `compiled projection repeats ${currentCheck} ${label}`)
      object[field] = value
      recognized = true
      break
    }
    if (!recognized) {
      const negativePath = parseJsonBullet(line, 'Negative path')
      if (negativePath !== undefined) target.execution.negativePaths.push(negativePath)
    }
  }
  const routeGraphs = Object.fromEntries(ALL_CODEX_ROUTES.map(route => {
    const part = routeParts[route]
    const required = Object.fromEntries(part.order.map(leaf => [leaf, []]))
    for (const edge of part.edges) {
      if (required[edge.after]) required[edge.after].push(edge.before)
    }
    for (const dependencies of Object.values(required)) dependencies.sort()
    return [route, {
      required,
      terminal: part.order.at(-1),
      leaves: part.leaves,
      edges: part.edges,
      order: part.order,
      maxTransitions: part.maxTransitions,
    }]
  }))
  return Object.freeze({ sha256: matches[0][1], routeGraphs, definitions })
}

function validateFullCompiledGates(markdown, gates, gatesSha256) {
  const parsed = parseFullCompiledGates(markdown)
  const parsedGraphs = Object.freeze(Object.fromEntries(ALL_CODEX_ROUTES.map(route => [
    route,
    gateGraphProjection(parsed.routeGraphs[route], route),
  ])))
  const parsedDefinitions = Object.freeze(Object.fromEntries(Object.keys(parsed.definitions).sort().map(checkId => [
    checkId,
    gateDefinitionProjection(parsed.definitions[checkId], checkId),
  ])))
  requireCondition(parsed.sha256 === gatesSha256, 'compiled check registry hash is stale')
  requireCondition(JSON.stringify(parsedGraphs) === JSON.stringify(compiledGateGraphs(gates)), 'compiled route graph projection is not canonical')
  requireCondition(JSON.stringify(parsedDefinitions) === JSON.stringify(compiledGateDefinitions(gates)), 'compiled check execution/retry projection is not canonical')
  return true
}

function renderFrameworkCompiledGates(gates, gatesSha256, routes) {
  requireCondition(Array.isArray(routes) && routes.length > 0, 'framework check projection has no applicable route')
  requireCondition(routes.every(route => ALL_CODEX_ROUTES.includes(route)), 'framework check projection names an unknown route')
  const graphs = compiledGateGraphs(gates, routes)
  const lines = [
    `${FRAMEWORK_GATES_BEGIN} sha256=${gatesSha256} -->`,
    '## Generated route checks',
    '',
    'This compact section is generated from the versioned check registry.',
  ]
  for (const route of routes) {
    const graph = graphs[route]
    lines.push(
      '',
      `### Applicable route \`${route}\``,
      `- Leaves: \`${inlineJson(graph.leaves)}\``,
      `- Edges: \`${inlineJson(graph.edges)}\``,
      `- Order: \`${inlineJson(graph.order)}\``,
      `- Maximum transitions: \`${inlineJson(graph.maxTransitions)}\``,
    )
  }
  lines.push('', FRAMEWORK_GATES_END)
  return lines.join('\n')
}

function parseFrameworkCompiledGates(markdown) {
  const pattern = /<!-- AUTOPROMPT-FRAMEWORK-GATES:BEGIN v2 sha256=([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- AUTOPROMPT-FRAMEWORK-GATES:END -->/g
  const matches = [...String(markdown).matchAll(pattern)]
  requireCondition(matches.length === 1, 'framework check projection must occur exactly once')
  const routeParts = {}
  let currentRoute = null
  for (const line of matches[0][2].split('\n')) {
    const heading = line.match(/^### Applicable route `([^`]+)`$/)
    if (heading) {
      requireCondition(ALL_CODEX_ROUTES.includes(heading[1]), `framework projection names unknown route ${heading[1]}`)
      requireCondition(!routeParts[heading[1]], `framework projection repeats route ${heading[1]}`)
      currentRoute = heading[1]
      routeParts[currentRoute] = {}
      continue
    }
    if (!currentRoute || !line.startsWith('- ')) continue
    const fields = [
      ['Leaves', 'leaves'],
      ['Edges', 'edges'],
      ['Order', 'order'],
      ['Maximum transitions', 'maxTransitions'],
    ]
    for (const [label, field] of fields) {
      const value = parseJsonBullet(line, label)
      if (value === undefined) continue
      requireCondition(!Object.hasOwn(routeParts[currentRoute], field), `framework projection repeats ${currentRoute} ${label}`)
      routeParts[currentRoute][field] = value
      break
    }
  }
  const routeGraphs = Object.fromEntries(Object.entries(routeParts).map(([route, part]) => {
    const required = Object.fromEntries((part.order || []).map(leaf => [leaf, []]))
    for (const edge of part.edges || []) {
      if (required[edge.after]) required[edge.after].push(edge.before)
    }
    for (const dependencies of Object.values(required)) dependencies.sort()
    return [route, {
      required,
      terminal: part.order && part.order.at(-1),
      leaves: part.leaves,
      edges: part.edges,
      order: part.order,
      maxTransitions: part.maxTransitions,
    }]
  }))
  return Object.freeze({ sha256: matches[0][1], routeGraphs })
}

function validateFrameworkGateProjections(
  outputs,
  gates,
  gatesSha256,
  frameworkRoutes = codexFrameworkRoutes(ROOT),
) {
  const coverage = Object.fromEntries(ALL_CODEX_ROUTES.map(route => [route, {
    leaves: new Set(),
    edges: new Set(),
    order: new Set(),
  }]))
  for (const file of Object.keys(frameworkRoutes)) {
    const relativePath = `agents/codex/frameworks/${file}`
    const parsed = parseFrameworkCompiledGates(outputs.get(relativePath))
    const routes = frameworkRoutes[file]
    const parsedGraphs = Object.freeze(Object.fromEntries(routes.map(route => [
      route,
      gateGraphProjection(parsed.routeGraphs[route], route),
    ])))
    requireCondition(parsed.sha256 === gatesSha256, `${relativePath} check registry hash is stale`)
    requireCondition(
      JSON.stringify(parsedGraphs) === JSON.stringify(compiledGateGraphs(gates, routes)),
      `${relativePath} check graph projection is not canonical`,
    )
    for (const [route, graph] of Object.entries(parsedGraphs)) {
      graph.leaves.forEach(leaf => coverage[route].leaves.add(leaf))
      graph.edges.forEach(edge => coverage[route].edges.add(`${edge.before}\u0000${edge.after}`))
      graph.order.forEach((leaf, index) => coverage[route].order.add(`${index}\u0000${leaf}`))
    }
  }
  for (const [route, graph] of Object.entries(compiledGateGraphs(gates))) {
    requireCondition(sameMembers(coverage[route].leaves, graph.leaves), `${route} framework projections do not cover every check leaf`)
    requireCondition(
      sameMembers(coverage[route].edges, graph.edges.map(edge => `${edge.before}\u0000${edge.after}`)),
      `${route} framework projections do not cover every check edge`,
    )
    requireCondition(
      sameMembers(coverage[route].order, graph.order.map((leaf, index) => `${index}\u0000${leaf}`)),
      `${route} framework projections do not cover the complete check order`,
    )
  }
  return true
}

function renderCompiledRouteExamples(routes, routesSha256) {
  requireCondition(/^[a-f0-9]{64}$/.test(routesSha256), 'compiled route example hash is invalid')
  requireCondition(Array.isArray(routes.examples) && routes.examples.length > 0, 'canonical route examples are missing')
  const lines = [
    `${ROUTE_EXAMPLES_BEGIN} sha256=${routesSha256} -->`,
    '## Canonical route examples',
    '',
    'Classify these examples exactly as recorded before handling paraphrases or nearby cases.',
    ...routes.examples.map(example => `- Example: \`${inlineJson(example)}\``),
    '',
    ROUTE_EXAMPLES_END,
  ]
  return lines.join('\n')
}

function parseCompiledRouteExamples(markdown) {
  const pattern = /<!-- AUTOPROMPT-COMPILED-ROUTE-EXAMPLES:BEGIN v2 sha256=([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- AUTOPROMPT-COMPILED-ROUTE-EXAMPLES:END -->/g
  const matches = [...String(markdown).matchAll(pattern)]
  requireCondition(matches.length === 1, 'compiled route examples must occur exactly once')
  const examples = []
  for (const line of matches[0][2].split('\n')) {
    const example = parseJsonBullet(line, 'Example')
    if (example !== undefined) examples.push(example)
  }
  return Object.freeze({ sha256: matches[0][1], examples: Object.freeze(examples) })
}

function validateCompiledRouteExamples(markdown, routes, routesSha256, label) {
  const parsed = parseCompiledRouteExamples(markdown)
  requireCondition(parsed.sha256 === routesSha256, `${label} route example hash is stale`)
  requireCondition(JSON.stringify(parsed.examples) === JSON.stringify(routes.examples), `${label} route examples are not canonical`)
  return true
}

function providerProjectionPlan(contracts, openedProviders = ['codex']) {
  const records = contracts.providers.providers || []
  requireCondition(sameMembers(records.map(provider => provider.id), PUBLIC_PROVIDER_IDS), 'provider projection consumer mismatch')
  const opened = new Set(openedProviders)
  const decisions = records.map(provider => {
    requireCondition(provider.capabilities && typeof provider.capabilities === 'object', `${provider.id} capability record is missing`)
    requireCondition(
      PROVIDER_CAPABILITY_FIELDS.every(field => typeof provider.capabilities[field] === 'string'),
      `${provider.id} capability record is incomplete`,
    )
    const capabilityValues = PROVIDER_CAPABILITY_FIELDS.map(field => provider.capabilities[field])
    const codexCapabilityState = {
      isolation: 'supported',
      topologyEnforcement: 'degraded',
      privateSkillRoot: 'supported',
      eventStreaming: 'unknown',
      toolOutputCapture: 'unknown',
      stableChildIdentity: 'unknown',
      sameContextContinuation: 'unknown',
      cancellation: 'unknown',
      isolatedChecking: 'unknown',
      processOwnership: 'supported',
      modelRouting: 'unknown',
    }
    const codexSupportedCapabilities = Object.entries(codexCapabilityState)
      .filter(([, value]) => value === 'supported')
      .map(([capability]) => capability)
      .sort()
    const codexAdmissionCore = provider.id === 'codex' &&
      provider.implementationStatus === 'verified' &&
      provider.currentIsolationClass === 'strict' &&
      provider.defaultAdmission === 'allow-verified-required-capabilities' &&
      provider.attestationRequired === true &&
      PROVIDER_CAPABILITY_FIELDS.every(field =>
        provider.capabilities[field] === codexCapabilityState[field])
    const attestedCapabilities = Array.isArray(provider.verificationAttestation?.verifiedCapabilities)
      ? [...provider.verificationAttestation.verifiedCapabilities].sort()
      : []
    const codexAttestationCoversPolicy = Boolean(provider.verificationAttestation) &&
      JSON.stringify(attestedCapabilities) === JSON.stringify(codexSupportedCapabilities) &&
      /^[a-f0-9]{64}$/.test(provider.verificationAttestation.providerAdmissionSha256 || '') &&
      provider.verificationAttestation.verificationMethod === 'live-conformance-suite' &&
      provider.verificationAttestation.result === 'supported'
    const codexPendingAttestation = codexAdmissionCore && !provider.verificationAttestation
    const verified = provider.id === 'codex'
      ? codexAdmissionCore && codexAttestationCoversPolicy
      : provider.implementationStatus === 'verified' && provider.verificationAttestation &&
        capabilityValues.every(value => value === 'supported' || value === 'verified')
    requireCondition(
      provider.id === 'codex' || !Object.hasOwn(provider, 'attestationRequired'),
      `${provider.id} cannot declare the Codex pre-canary attestation policy`,
    )
    requireCondition(
      !capabilityValues.some(value => value === 'supported' || value === 'verified') ||
        provider.verificationAttestation || codexPendingAttestation,
      `${provider.id} claims verified capability without an attestation`,
    )
    const portOpen = opened.has(provider.id)
    return Object.freeze({
      provider: provider.id,
      portOpen,
      runtimeAdmitted: Boolean(verified),
      projectionMode: portOpen ? (verified ? 'VERIFIED' : 'SAFE_DEGRADED') : 'PORT_CLOSED',
      claimsRealBehavior: Boolean(verified),
      reason: portOpen
        ? (verified
            ? 'verified-provider-capability-contract'
            : (codexPendingAttestation
                ? 'attestation-required-before-runtime-admission'
                : provider.defaultAdmission))
        : 'provider-port-phase-not-open',
    })
  }).sort((left, right) => left.provider.localeCompare(right.provider))
  return Object.freeze(decisions)
}

function validateCompatibilityAliasContract(rolesContract) {
  const telemetry = rolesContract.aliasTelemetrySchema || {}
  requireCondition(telemetry.format === 'jsonl', 'compatibility alias telemetry format is unknown')
  requireCondition(telemetry.appendPath === 'compatibility/alias-telemetry.jsonl', 'compatibility alias telemetry path is not canonical')
  requireCondition(telemetry.enforcer === 'deterministic-control-plane', 'compatibility alias telemetry has the wrong writer')
  requireCondition(telemetry.counterField === 'aliasUseCount', 'compatibility alias telemetry counter is not canonical')
  requireCondition(telemetry.legacyReadVersion === '1' && telemetry.canonicalWriteVersion === '2.0.0', 'compatibility alias telemetry version mismatch')
  const hashChain = telemetry.hashChain || {}
  requireCondition(
    hashChain.algorithm === 'sha256' && hashChain.canonicalization === 'stable-json-v1' &&
      hashChain.scope === 'append-file' && hashChain.genesisPreviousHash === null &&
      Array.isArray(hashChain.entryHashInputFields) && hashChain.entryHashInputFields.includes('previousHash') &&
      typeof hashChain.crashTailPolicy === 'string' && hashChain.crashTailPolicy.length > 0,
    'compatibility alias telemetry hash chain is incomplete',
  )
  const schema = telemetry.recordSchema || {}
  const required = [
    'runId', 'activationId', 'generation', 'legacyId', 'logicalId', 'physicalId', 'legacyReadVersion',
    'canonicalWriteVersion', 'aliasUseCount', 'occurredAt', 'previousHash', 'entryHash',
  ]
  requireCondition(schema.type === 'object' && schema.additionalProperties === false, 'compatibility alias telemetry schema is open')
  requireCondition(sameMembers(schema.required || [], required), 'compatibility alias telemetry fields mismatch')
  requireCondition(required.every(field => schema.properties && schema.properties[field]), 'compatibility alias telemetry property is missing')
  return telemetry
}

function plainLanguageViolations(text, plainLanguage, label = 'generated text') {
  const avoid = plainLanguage.avoid || {}
  const scrubbed = String(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\r\n]*`/g, '')
    .replace(/^\s*Legacy\b.*$/gmi, '')
    .replace(/\bap-[a-z0-9-]+\b/gi, '')
    .replace(/\b(?:https?:\/\/|[A-Za-z]:\\)\S+/g, '')
  const violations = []
  for (const [term, replacement] of Object.entries(avoid)) {
    const pattern = new RegExp(`\\b${escapeRegExp(term).replace(/\\ /g, '\\s+')}\\b`, 'gi')
    for (const match of scrubbed.matchAll(pattern)) {
      const before = scrubbed.slice(0, match.index)
      violations.push(Object.freeze({
        label,
        line: before.split(/\r?\n/).length,
        term,
        replacement,
      }))
    }
  }
  return Object.freeze(violations)
}

function validateGeneratedPlainLanguage(outputs, plainLanguage) {
  const violations = []
  for (const [relativePath, content] of outputs) {
    if (!/\.(?:md|toml|ya?ml)$/i.test(relativePath)) continue
    violations.push(...plainLanguageViolations(content, plainLanguage, relativePath))
  }
  requireCondition(
    violations.length === 0,
    violations.length
      ? `${violations[0].label}:${violations[0].line} uses forbidden prompt term ${violations[0].term}; use ${violations[0].replacement}`
      : 'generated plain-language validation failed',
  )
  return true
}

function plainReplacement(term, configuredReplacement) {
  const concise = {
    artifact: 'deliverable',
    oracle: 'observable check',
    candidate: 'exact version',
    assurance: 'independent checking',
    lane: 'work item',
    fleet: 'group of workers',
    frontier: 'next ready work',
    gate: 'required check',
    sweep: 'final review',
    convergence: 'reaching a passing result',
    handoff: 'assignment',
    juror: 'independent reviewer',
    arbiter: 'technical decision reviewer',
    'fresh eyes': 'independent reviewer',
  }
  return concise[term] || configuredReplacement
}

function matchCase(replacement, matched) {
  if (matched === matched.toUpperCase()) return replacement.toUpperCase()
  if (matched[0] === matched[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1)
  return replacement
}

function normalizePlainLanguageMarkdown(text, plainLanguage) {
  let fenced = false
  return String(text).split('\n').map(line => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      return line
    }
    if (fenced || /^\s*Legacy\b/i.test(line)) return line
    return line.split(/(`[^`\r\n]*`)/g).map((part, index) => {
      if (index % 2 === 1) return part
      let normalized = part
      for (const [term, configuredReplacement] of Object.entries(plainLanguage.avoid || {})) {
        const pattern = new RegExp(`\\b${escapeRegExp(term).replace(/\\ /g, '\\s+')}\\b`, 'gi')
        const replacement = plainReplacement(term, configuredReplacement)
        normalized = normalized.replace(pattern, matched => matchCase(replacement, matched))
      }
      return normalized
    }).join('')
  }).join('\n')
}

function markdownAnchorIds(text) {
  return new Set(String(text).split('\n').flatMap(line => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!heading) return []
    const id = heading[1].toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
    return id ? [id] : []
  }))
}

function validateFrameworkReferences(outputs, root = ROOT, frameworkFiles = codexFrameworkFiles(root)) {
  const staleCapacity = /\b(?:200[- ]agents?|exactly\s+\d+\s+(?:agents?|workers?|scouts?|reviewers?))\b/iu
  for (const [relativePath, content] of outputs) {
    requireCondition(!staleCapacity.test(content), `${relativePath} contains a stale numeric capacity claim`)
    requireCondition(!/\bGATES\.md\s+(?:§|ESCALATION|TIER\s+CONTRACTS)/iu.test(content), `${relativePath} cites a dead GATES.md section`)
    const references = [
      ...content.matchAll(/`([^`\r\n]+\.md(?:#[a-z0-9_-]+)?)`/giu),
      ...content.matchAll(/\[[^\]\r\n]*\]\(([^)\s]+\.md(?:#[a-z0-9_-]+)?)\)/giu),
    ].map(match => match[1])
    for (const reference of references) {
      const [filePart, anchor] = reference.split('#', 2)
      const frameworkReference = frameworkFiles.includes(filePart) ||
        filePart.startsWith('agents/contracts/frameworks/') ||
        filePart.startsWith('frameworks/') && !filePart.includes('<')
      if (!frameworkReference) continue
      const target = filePart.startsWith('agents/')
        ? path.join(root, filePart)
        : path.resolve(root, path.dirname(relativePath), filePart)
      requireCondition(fs.existsSync(target) && fs.statSync(target).isFile(), `${relativePath} has dead reference ${reference}`)
      if (anchor) {
        requireCondition(markdownAnchorIds(fs.readFileSync(target, 'utf8')).has(anchor), `${relativePath} has dead anchor ${reference}`)
      }
    }
  }
  return true
}

function renderSharedFrameworkOutputs(root = ROOT, plainLanguage = readJson('agents/contracts/plain-language.json', root)) {
  const directory = path.join(root, 'agents', 'contracts', 'frameworks')
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => entry.name)
    .sort()
  const frameworkFiles = codexFrameworkFiles(root)
  requireCondition(sameMembers(files, frameworkFiles), 'shared framework consumer mismatch')
  const outputs = new Map(files.map(file => {
    const relativePath = `agents/contracts/frameworks/${file}`
    const normalized = normalizePlainLanguageMarkdown(read(relativePath, root), plainLanguage)
    return [relativePath, normalized.endsWith('\n') ? normalized : `${normalized}\n`]
  }))
  validateFrameworkReferences(outputs, root, frameworkFiles)
  validateGeneratedPlainLanguage(outputs, plainLanguage)
  return outputs
}

function validateCanonicalAndSharedPlainLanguage(contracts, root = ROOT) {
  const violations = []
  const humanFields = new Set(contracts.plainLanguage.humanFacingFields || [])
  function inspectHumanFields(value, label, key = '') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspectHumanFields(item, `${label}[${index}]`, key))
      return
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        inspectHumanFields(child, `${label}.${childKey}`, childKey)
      }
      return
    }
    // Stable identifiers, schema fields, source paths, hashes, and provider terms
    // are single tokens. Every sentence-like canonical string is prose and must
    // therefore satisfy the plain-language contract, even when its field was not
    // anticipated by the original human-facing-field list.
    if (typeof value === 'string' && (humanFields.has(key) || /\s/u.test(value))) {
      violations.push(...plainLanguageViolations(value, contracts.plainLanguage, label))
    }
  }
  for (const [name, document] of Object.entries(contracts)) {
    if (!CODEX_V2_INPUTS.some(input => input.endsWith(`/${name === 'stateMachine' ? 'state-machine' : name}.json`))) continue
    inspectHumanFields(document, `agents/contracts/${name}`)
  }
  for (const [index, example] of (contracts.routes.examples || []).entries()) {
    violations.push(...plainLanguageViolations(example.facts, contracts.plainLanguage, `agents/contracts/routes.json.examples[${index}].facts`))
  }
  for (const [index, code] of (contracts.plainLanguage.userVisibleCodes || []).entries()) {
    violations.push(...plainLanguageViolations(code.description, contracts.plainLanguage, `agents/contracts/plain-language.json.userVisibleCodes[${index}].description`))
  }
  for (const [index, state] of (contracts.stateMachine.stateRecords || []).entries()) {
    if (typeof state.description === 'string') {
      violations.push(...plainLanguageViolations(state.description, contracts.plainLanguage, `agents/contracts/state-machine.json.stateRecords[${index}].description`))
    }
  }
  const sharedSources = [...new Set([
    ...(contracts.product.generationPolicy.authoritativePromptSources || []),
    ...codexFrameworkFiles(root).map(file => `agents/contracts/frameworks/${file}`),
  ])]
  requireCondition(sharedSources.length > 0, 'authoritative shared prompt sources are missing')
  for (const relativePath of sharedSources) {
    requireCondition(relativePath.startsWith('agents/contracts/') && /\.md$/.test(relativePath), `shared prompt source is outside the canonical contract tree: ${relativePath}`)
    violations.push(...plainLanguageViolations(read(relativePath, root), contracts.plainLanguage, relativePath))
  }
  requireCondition(
    violations.length === 0,
    violations.length
      ? `${violations[0].label}:${violations[0].line} uses forbidden prompt term ${violations[0].term}; use ${violations[0].replacement}`
      : 'canonical/shared plain-language validation failed',
  )
  return true
}

function runtimeMessageLiterals(source) {
  const messages = []
  for (const line of String(source).split('\n')) {
    for (const pattern of [/"((?:\\.|[^"\\])*)"/gu, /'((?:\\.|[^'\\])*)'/gu, /`((?:\\.|[^`\\])*)`/gu]) {
      for (const match of line.matchAll(pattern)) {
        const value = match[1].replace(/\\([\\'"`])/g, '$1')
        // Conservatively treat every prose-like runtime literal as potentially
        // user-visible. This covers logging and status/report fields as well as
        // errors, instead of relying on a brittle allowlist of output functions.
        if (/\s/u.test(value)) messages.push(value)
      }
    }
  }
  return messages
}

function diagramVisibleText(source) {
  return [...String(source).matchAll(/<(?:title|desc|text)\b[^>]*>([\s\S]*?)<\/(?:title|desc|text)>/giu)]
    .map(match => match[1].replace(/<[^>]+>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(target) : [target]
  })
}

function codexUserFacingLanguageViolations(plainLanguage, root = ROOT, overrides = new Map()) {
  const violations = []
  const runtimeFiles = filesUnder(path.join(root, 'agents', 'codex', 'workflow'))
    .filter(file => /\.(?:js|sh|ps1)$/iu.test(file))
    .map(file => path.relative(root, file).replace(/\\/g, '/'))
  for (const relativePath of runtimeFiles) {
    const source = overrides.has(relativePath) ? overrides.get(relativePath) : read(relativePath, root)
    for (const [index, message] of runtimeMessageLiterals(source).entries()) {
      violations.push(...plainLanguageViolations(message, plainLanguage, `${relativePath}:message[${index}]`))
    }
  }

  const diagramFiles = filesUnder(path.join(root, 'assets'))
    .filter(file => file.toLowerCase().endsWith('.svg'))
    .map(file => path.relative(root, file).replace(/\\/g, '/'))
  for (const relativePath of diagramFiles) {
    const source = overrides.has(relativePath) ? overrides.get(relativePath) : read(relativePath, root)
    for (const [index, message] of diagramVisibleText(source).entries()) {
      violations.push(...plainLanguageViolations(message, plainLanguage, `${relativePath}:text[${index}]`))
    }
  }
  return Object.freeze(violations)
}

function validateCodexUserFacingLanguage(plainLanguage, root = ROOT, overrides = new Map(), auditedExceptions = []) {
  const violations = codexUserFacingLanguageViolations(plainLanguage, root, overrides)
  const exceptionByPath = new Map(auditedExceptions.map(exception => [exception.path, exception]))
  const usedExceptions = new Set()
  const unapproved = violations.filter(violation => {
    const relativePath = violation.label.replace(/:(?:message|text)\[\d+\]$/u, '')
    const exception = exceptionByPath.get(relativePath)
    if (!exception || !exception.terms.includes(violation.term)) return true
    const source = overrides.has(relativePath) ? overrides.get(relativePath) : read(relativePath, root)
    if (sha256Text(source) !== exception.sha256) return true
    usedExceptions.add(relativePath)
    return false
  })
  requireCondition(
    unapproved.length === 0,
    unapproved.length
      ? `${unapproved[0].label}:${unapproved[0].line} uses forbidden prompt term ${unapproved[0].term}; use ${unapproved[0].replacement}`
      : 'Codex runtime/diagram plain-language validation failed',
  )
  for (const exception of auditedExceptions) {
    requireCondition(usedExceptions.has(exception.path), `Codex plain-language audited exception is stale or unused: ${exception.path}`)
    for (const term of exception.terms) {
      requireCondition(violations.some(violation =>
        violation.term === term && violation.label.startsWith(`${exception.path}:`)),
      `Codex plain-language audited term is stale or unused: ${exception.path}:${term}`)
    }
  }
  return true
}

function loadCodexV2Contracts(root = ROOT) {
  const documents = {
    product: readJson(CODEX_V2_INPUTS[0], root),
    routes: readJson(CODEX_V2_INPUTS[1], root),
    stateMachine: readJson(CODEX_V2_INPUTS[2], root),
    roles: readJson(CODEX_V2_INPUTS[3], root),
    gates: readJson(CODEX_V2_INPUTS[4], root),
    providers: readJson(CODEX_V2_INPUTS[5], root),
    plainLanguage: readJson(CODEX_V2_INPUTS[6], root),
  }
  const expectedKinds = {
    product: 'autoprompt-product-contract',
    routes: 'autoprompt-route-contract',
    stateMachine: 'autoprompt-state-machine',
    roles: 'autoprompt-role-contract',
    gates: 'autoprompt-check-registry',
    providers: 'autoprompt-provider-capability-contract',
    plainLanguage: 'autoprompt-plain-language-contract',
  }
  for (const [name, document] of Object.entries(documents)) {
    requireCondition(document.kind === expectedKinds[name], `${name} has an unknown kind`)
    requireCondition(document.contractVersion === '2.0.0', `${name} has a stale contract version`)
    const schemaName = name === 'stateMachine'
      ? 'state-machine'
      : name === 'plainLanguage'
        ? 'plain-language'
        : name
    const expectedSchemaReference = `./schemas/${schemaName}.schema.json`
    requireCondition(document.$schema === expectedSchemaReference, `${name} has an unknown schema id`)
    const schemaPath = path.join('agents', 'contracts', document.$schema.slice(2))
    const schema = readJson(schemaPath, root)
    requireCondition(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', `${name} schema has an unsupported dialect`)
    requireCondition(
      schema.$id === `https://autoprompt.local/schemas/v2/${schemaName}.schema.json`,
      `${name} schema has a stale or mismatched id`,
    )
    for (const required of schema.required || []) {
      requireCondition(Object.hasOwn(document, required), `${name} is missing schema field ${required}`)
    }
  }

  const authoritative = documents.product.generationPolicy.authoritativeInputs
  requireCondition(sameMembers(authoritative, CODEX_V2_INPUTS), 'product authoritative inputs do not match the seven v2 contracts')
  requireCondition(documents.product.generationPolicy.legacyInputAllowedForProviderGeneration === false, 'legacy provider input is still authoritative')
  requireCondition(documents.product.compatibility.legacySourceIsAuthoritative === false, 'legacy contract is still authoritative')
  requireCondition(documents.product.product.defaultRoute === null && documents.routes.defaultRoute === null, 'a default route was introduced')

  const routeNames = documents.product.product.routeNames
  requireCondition(sameMembers(Object.keys(documents.routes.routes), routeNames), 'route consumer mismatch')
  requireCondition(sameMembers(Object.keys(documents.gates.routeGraphs), routeNames), 'check graph consumer mismatch')
  requireCondition(documents.stateMachine.states.includes(documents.stateMachine.initialState), 'initial state is unknown')
  requireCondition(documents.stateMachine.terminalStates.every(state => documents.stateMachine.states.includes(state)), 'terminal state is unknown')
  requireCondition(documents.providers.providers.some(provider => provider.id === 'codex'), 'Codex provider capability record is missing')
  requireCondition(Array.isArray(documents.plainLanguage.instructionRules), 'plain-language instruction rules are missing')
  validateCompatibilityAliasContract(documents.roles)

  const rolePolicy = readJson('agents/codex/agents/role-policy.json', root)
  const rolePolicySchema = readJson('agents/codex/agents/role-policy.schema.json', root)
  for (const required of rolePolicySchema.required || []) {
    requireCondition(Object.hasOwn(rolePolicy, required), `role policy is missing schema field ${required}`)
  }
  const packageRegistry = loadCodexPackageRegistry(root)
  validateCodexRolePolicy(rolePolicy, documents.roles, packageRegistry, root)
  const contracts = { ...documents, rolePolicy, rolePolicySchema }
  validateCanonicalAndSharedPlainLanguage(contracts, root)
  validateCodexUserFacingLanguage(
    contracts.plainLanguage,
    root,
    new Map(),
    packageRegistry.plainLanguageAuditedExceptions || [],
  )
  const projectionPlan = providerProjectionPlan(contracts)
  return Object.freeze({ ...contracts, projectionPlan })
}

function validateCodexRolePolicy(policy, rolesContract, packageRegistry = null, root = ROOT) {
  requireCondition(policy.$schema === './role-policy.schema.json', 'role policy schema id is stale or unknown')
  requireCondition(policy.policy_id === 'autoprompt.codex.role-policy', 'role policy id is unknown')
  requireCondition(policy.policy_version === rolesContract.contractVersion, 'role policy version does not match roles contract')
  requireCondition(policy.enforcement && policy.enforcement.required === true, 'role policy enforcement is optional')
  requireCondition((policy.enforcement.enforcers || []).includes('provider-generator'), 'provider generator is not a policy enforcer')

  const physical = policy.physical_roles || {}
  const compatibilityAliases = rolesContract.compatibilityAliases || []
  const legacyIds = compatibilityAliases.map(alias => alias.legacyId)
  const canonicalProjection = rolesContract.codexPhysicalRoleProjection || []
  const canonicalIds = canonicalProjection.map(role => role.physicalId)
  const expectedPhysical = [...canonicalIds, ...legacyIds]
  requireCondition(legacyIds.length > 0 && new Set(legacyIds).size === legacyIds.length, 'roles contract compatibility ids must be non-empty and unique')
  requireCondition(
    canonicalProjection.length > 0 && new Set(canonicalIds).size === canonicalProjection.length,
    'roles contract Codex physical projection must be non-empty and unique',
  )
  requireCondition(new Set(expectedPhysical).size === expectedPhysical.length, 'canonical and compatibility physical roles overlap')
  requireCondition(sameMembers(Object.keys(physical), expectedPhysical), 'physical role consumer mismatch')

  if (packageRegistry) {
    for (const requirement of packageRegistry.requiredRoleCapabilities || []) {
      const matches = canonicalProjection.filter(projection =>
        projection.logicalId === requirement.logicalRole &&
        requirement.requiredModes.every(mode => projection.modes.includes(mode)))
      requireCondition(matches.length > 0,
        `required Codex role capability ${requirement.id} is missing`)
      requireCondition(matches.some(projection => {
        const role = physical[projection.physicalId]
        return role && role.compatibility_alias && role.compatibility_alias.enabled === false
      }), `required Codex role capability ${requirement.id} has no active physical role`)
    }
    const migrationSources = new Set(packageRegistry.migrationSources || [])
    for (const migration of packageRegistry.requiredMigrations || []) {
      requireCondition(migrationSources.has(migration.source),
        `required Codex migration ${migration.id} is missing`)
      const [relativePath, fragment] = migration.source.split('#', 2)
      if (fragment) {
        const document = relativePath === 'agents/contracts/roles.json'
          ? rolesContract
          : readJson(relativePath, root)
        requireCondition(Array.isArray(document[fragment]) && document[fragment].length > 0,
          `required Codex migration ${migration.id} has no entries`)
      } else {
        requireCondition(fs.existsSync(path.join(root, relativePath)),
          `required Codex migration ${migration.id} source is missing`)
      }
    }
  }

  const aliasPolicy = rolesContract.compatibilityAliasPolicy || {}
  requireCondition(
    aliasPolicy.status === 'closed-read-only' && aliasPolicy.activationAllowed === false &&
      aliasPolicy.writeAllowed === false && aliasPolicy.telemetryRequired === true &&
      sameMembers(aliasPolicy.legacyPhysicalIds || [], legacyIds),
    'roles contract compatibility policy is not closed, read-only, and telemetry-bound',
  )

  const logicalRoles = policy.logical_roles || {}
  const resources = policy.resource_set_definitions || {}
  const groups = policy.mutual_exclusion_groups || {}
  const schemas = policy.schemas || {}
  const namedTargetRead = resources['target.named.read'] || {}
  requireCondition(
    namedTargetRead.kind === 'assignment-resolved' && namedTargetRead.resolved_by === 'supervisor' &&
      sameMembers(namedTargetRead.rules || [], ['explicit-path-list', 'read-only', 'no-follow']),
    'named target read/search resource is not scoped and read-only',
  )
  for (const coordinatorPolicy of Object.values(COORDINATOR_TARGET_READ_POLICIES)) {
    const logicalContract = (rolesContract.roles || [])
      .find(role => role.id === coordinatorPolicy.logicalRole)
    requireCondition(
      logicalContract && sameMembers(logicalContract.permissions?.read || [], coordinatorPolicy.logicalReads) &&
        (logicalContract.permissions?.write || []).length === 0 &&
        (logicalContract.permissions?.execute || []).length === 0 &&
        (logicalContract.writes || []).length === 0,
      `${coordinatorPolicy.logicalRole} logical coordinator target read/search policy is not least privilege`,
    )
  }
  for (const [schemaId, schema] of Object.entries(schemas)) {
    requireCondition(schema.$id === `ap://schemas/${schemaId}`, `schema ${schemaId} has a stale or mismatched id`)
    requireCondition(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', `schema ${schemaId} has an unsupported dialect`)
  }

  for (const [physicalId, role] of Object.entries(physical)) {
    requireCondition(/^ap-[a-z0-9-]+$/.test(physicalId), `invalid physical id ${physicalId}`)
    const logical = logicalRoles[role.logical_role]
    requireCondition(Boolean(logical), `${physicalId} maps to unknown logical role ${role.logical_role}`)
    requireCondition(role.logical_version === logical.version, `${physicalId} logical version mismatch`)
    requireCondition(role.layer === logical.layer, `${physicalId} logical layer mismatch`)
    requireCondition(Array.isArray(role.supported_modes) && role.supported_modes.length > 0, `${physicalId} has no supported modes`)
    requireCondition(new Set(role.supported_modes).size === role.supported_modes.length, `${physicalId} repeats a supported mode`)
    requireCondition(role.supported_modes.includes(role.mode), `${physicalId} primary mode is not supported`)
    requireCondition(typeof role.activation_allowed === 'boolean', `${physicalId} has no activation policy`)
    requireCondition(typeof role.telemetry_required === 'boolean', `${physicalId} has no telemetry policy`)
    requireCondition(['read-only', 'workspace-write'].includes(role.sandbox_mode), `${physicalId} has an unsafe sandbox mode`)
    requireCondition(Array.isArray(role.allowed_parents) && role.allowed_parents.length > 0, `${physicalId} has no legal parent`)
    requireCondition(Array.isArray(role.allowed_children), `${physicalId} has no child policy`)
    requireCondition(new Set(role.allowed_parents).size === role.allowed_parents.length, `${physicalId} repeats a parent`)
    requireCondition(new Set(role.allowed_children).size === role.allowed_children.length, `${physicalId} repeats a child`)
    requireCondition(role.can_dispatch === (role.allowed_children.length > 0), `${physicalId} dispatch flag and children disagree`)
    requireCondition(role.mutual_exclusion_group in groups, `${physicalId} has an unknown seat`)
    requireCondition(role.input_schema_id in schemas, `${physicalId} has unknown input schema ${role.input_schema_id}`)
    requireCondition(role.output_schema_id in schemas, `${physicalId} has unknown output schema ${role.output_schema_id}`)

    for (const access of ['read', 'write', 'exclusive']) {
      const values = role.resource_sets && role.resource_sets[access]
      requireCondition(Array.isArray(values), `${physicalId} has malformed ${access} resources`)
      requireCondition(new Set(values).size === values.length, `${physicalId} repeats a ${access} resource`)
      for (const resource of values) requireCondition(resource in resources, `${physicalId} uses unknown ${access} resource ${resource}`)
    }

    const exactResourceSet = (actual, expected) =>
      actual.length === expected.length && expected.every(resource => actual.includes(resource))
    const exactReadOnlyChecker = physicalId === 'ap-independent-checker' &&
      role.logical_role === 'independent-checker' && role.sandbox_mode === 'read-only' &&
      role.activation_allowed === true && role.can_dispatch === false &&
      role.allowed_parents.length === 1 && role.allowed_parents[0] === 'L0' &&
      role.compatibility_alias && role.compatibility_alias.enabled === false &&
      exactResourceSet(role.resource_sets.read, [
        'request-envelope.read', 'target.named.read', 'prior-results.read',
      ]) &&
      exactResourceSet(role.resource_sets.write, []) &&
      exactResourceSet(role.resource_sets.exclusive, [])
    const coordinatorTargetPolicy = COORDINATOR_TARGET_READ_POLICIES[physicalId]
    if (coordinatorTargetPolicy) {
      requireCondition(
        role.logical_role === coordinatorTargetPolicy.logicalRole && role.sandbox_mode === 'read-only' &&
          exactResourceSet(role.resource_sets.read, COORDINATOR_TARGET_READ_RESOURCES) &&
          exactResourceSet(role.resource_sets.write, []) &&
          exactResourceSet(role.resource_sets.exclusive, []),
        `${physicalId} coordinator target read/search policy is not least privilege`,
      )
    }

    const allowedWrites = new Set(SAFE_WRITE_SETS[role.logical_role] || [])
    const allowedExclusive = new Set(SAFE_EXCLUSIVE_SETS[role.logical_role] || [])
    requireCondition(role.resource_sets.write.every(resource => allowedWrites.has(resource)), `${physicalId} widens writable resources`)
    requireCondition(role.resource_sets.exclusive.every(resource => allowedExclusive.has(resource)), `${physicalId} widens exclusive resources`)
    if (role.sandbox_mode === 'workspace-write') {
      requireCondition(
        role.resource_sets.write.length > 0 && role.logical_role !== 'independent-checker',
        `${physicalId} has broad workspace-write authority`,
      )
    }

    if (!role.can_dispatch) requireCondition(role.allowed_children.length === 0, `${physicalId} is not closed`)
    for (const childId of role.allowed_children) {
      const child = physical[childId]
      requireCondition(Boolean(child), `${physicalId} has unknown child ${childId}`)
      requireCondition(child.allowed_parents.includes(physicalId), `${physicalId} -> ${childId} is not reciprocal`)
    }
    for (const parentId of role.allowed_parents) {
      if (parentId === 'L0') continue
      const parent = physical[parentId]
      requireCondition(Boolean(parent), `${physicalId} has unknown parent ${parentId}`)
      requireCondition(parent.allowed_children.includes(physicalId), `${parentId} -> ${physicalId} consumer mismatch`)
    }

    const alias = role.compatibility_alias || {}
    if (alias.enabled) {
      requireCondition(alias.alias_of === 'C0' || alias.alias_of in physical, `${physicalId} has an unknown compatibility target`)
      requireCondition(Boolean(alias.remove_after), `${physicalId} has no compatibility retirement version`)
      requireCondition(
        role.activation_allowed === false && role.telemetry_required === true && role.sandbox_mode === 'read-only' &&
          !role.can_dispatch && role.allowed_children.length === 0 && role.resource_sets.write.length === 0 &&
          role.resource_sets.exclusive.length === 0,
        `${physicalId} compatibility id is not inactive, telemetry-bound, read-only, and closed`,
      )
    }

    if (role.logical_role === 'independent-checker') {
      requireCondition(role.allowed_parents.length === 1 && role.allowed_parents[0] === 'L0', `${physicalId} checker assignment is not L0-owned`)
      requireCondition(exactReadOnlyChecker, `${physicalId} checker lacks the exact read-only policy`)
      requireCondition(!role.resource_sets.write.includes('target.owned.write') && !role.resource_sets.write.includes('plan.roadmap.write'), `${physicalId} checker can write the checked result`)
    }
  }

  for (const id of canonicalIds) {
    requireCondition(
      physical[id].compatibility_alias.enabled === false && physical[id].activation_allowed === true &&
        physical[id].telemetry_required === false,
      `${id} is incorrectly marked as a compatibility id`,
    )
  }
  for (const projection of canonicalProjection) {
    const role = physical[projection.physicalId]
    requireCondition(role.logical_role === projection.logicalId, `${projection.physicalId} canonical logical id mismatch`)
    requireCondition(role.layer === projection.layer, `${projection.physicalId} canonical layer mismatch`)
    requireCondition(
      JSON.stringify(role.supported_modes) === JSON.stringify(projection.modes),
      `${projection.physicalId} canonical mode projection mismatch`,
    )
  }
  for (const compatibility of compatibilityAliases) {
    const role = physical[compatibility.legacyId]
    requireCondition(role.logical_role === compatibility.logicalId, `${compatibility.legacyId} compatibility logical id mismatch`)
    requireCondition(
      role.mode === compatibility.mode && JSON.stringify(role.supported_modes) === JSON.stringify([compatibility.mode]),
      `${compatibility.legacyId} compatibility mode mismatch`,
    )
    requireCondition(
      role.compatibility_alias.alias_of === CODEX_ALIAS_TARGET_BY_LOGICAL_ROLE[compatibility.logicalId],
      `${compatibility.legacyId} compatibility target mismatch`,
    )
  }
  const retired = physical['ap-framework-generator']
  requireCondition(
    retired.mode === 'compatibility-compiler' && retired.compatibility_alias.enabled === true &&
      retired.activation_allowed === false && retired.sandbox_mode === 'read-only' && !retired.can_dispatch &&
      retired.resource_sets.write.length === 0,
    'runtime framework generation was restored',
  )

  const managerAdmission = policy.manager_admission || {}
  const manager = physical['ap-work-group-manager']
  const rootChildren = canonicalIds.filter(id => id !== 'ap-work-group-manager')
  requireCondition(
    policy.control_plane && policy.control_plane.logical_role === 'run-owner' &&
      sameMembers(policy.control_plane.allowed_children || [], rootChildren) &&
      !Object.hasOwn(physical, 'ap-run-owner'),
    'L0 run owner is not bound to the exact provider-root child set',
  )
  requireCondition(
    managerAdmission.selected_role === 'ap-work-group-manager' && managerAdmission.route === 'ROADMAP' &&
      managerAdmission.plan_path === 'plan/ROADMAP.md' && managerAdmission.parent_role === 'ap-run-coordinator' &&
      managerAdmission.predicate && managerAdmission.predicate.minimum_useful_workers === 2 &&
      managerAdmission.predicate.require_pairwise_disjoint_resources === true &&
      managerAdmission.predicate.reject_single_worker === true &&
      manager.allowed_parents.length === 1 && manager.allowed_parents[0] === 'ap-run-coordinator' &&
      manager.allowed_children.length === 1 && manager.allowed_children[0] === 'ap-worker' && manager.can_dispatch === true,
    'work-group manager admission or topology mismatch',
  )

  const selection = policy.checker_selection || {}
  requireCondition(selection.selected_by === 'L0' && selection.unique_mode_per_version === true, 'checker selection is unsafe')
  requireCondition(selection.combined_mode === 'combined' && Array.isArray(selection.combined_conflicts_with), 'checker combined mode is incomplete')
  requireCondition(selection.selection_schema_id in schemas, 'checker selection schema is unknown')
  requireCondition(sameMembers(selection.bound_to || [], ['run_id', 'version_hash']), 'checker selection is not version-bound')
  requireCondition(sameMembers(selection.combined_conflicts_with, selection.split_modes || []), 'checker split modes and conflicts disagree')
  requireCondition(sameMembers(selection.split_modes || [], ['review', 'behavior-test']), 'checker split modes are not canonical')
  requireCondition(
    sameMembers(selection.separate_named_modes || [], ['technical-decision', 'named-distinct-risk']),
    'checker named modes are not canonical',
  )
  const checker = physical['ap-independent-checker']
  const modeContracts = selection.mode_contracts || {}
  requireCondition(sameMembers(Object.keys(modeContracts), checker.supported_modes), 'checker mode contracts do not cover the canonical physical role')
  const checkerRights = new Set()
  for (const [mode, contract] of Object.entries(modeContracts)) {
    requireCondition(Array.isArray(contract.decision_authority) && contract.decision_authority.length > 0, `checker ${mode} has no decision authority`)
    requireCondition(contract.mutual_exclusion_group in groups, `checker ${mode} has an unknown seat`)
    for (const right of contract.decision_authority) {
      requireCondition(!checkerRights.has(right), `checker ${mode} repeats decision authority ${right}`)
      checkerRights.add(right)
    }
  }
  requireCondition(sameMembers(checker.decision_rights, checkerRights), 'checker physical role decision rights do not match its modes')
  const checkerAssignment = schemas['assignment.checker.v2'] || {}
  requireCondition(
    checkerAssignment.properties && checkerAssignment.properties.role_id &&
      checkerAssignment.properties.role_id.const === 'ap-independent-checker' &&
      sameMembers(checkerAssignment.properties.mode.enum || [], checker.supported_modes) &&
      (checkerAssignment.oneOf || []).every(branch => branch.properties &&
        branch.properties.role_id && branch.properties.role_id.const === 'ap-independent-checker'),
    'checker assignment schema restores a compatibility physical id',
  )
  const checkerSelection = schemas['assignment.checker-selection.v2'] || {}
  const checkerItems = checkerSelection.properties && checkerSelection.properties.assignments &&
    checkerSelection.properties.assignments.items
  requireCondition(
    checkerItems && checkerItems.properties && checkerItems.properties.role_id &&
      checkerItems.properties.role_id.const === 'ap-independent-checker' &&
      (checkerItems.oneOf || []).every(branch => branch.properties &&
        branch.properties.role_id && branch.properties.role_id.const === 'ap-independent-checker'),
    'checker selection schema restores a compatibility physical id',
  )
  const managerAssignment = schemas['assignment.manager.v2'] || {}
  requireCondition(
    managerAssignment.properties && managerAssignment.properties.role_id &&
      managerAssignment.properties.role_id.const === 'ap-work-group-manager' &&
      managerAssignment.properties.logical_role && managerAssignment.properties.logical_role.const === 'ap-work-group-manager',
    'manager assignment schema restores the legacy manager id',
  )
  return policy
}

function renderCodexPolicyAgent(physicalId, role, rolesContract, policy, plainLanguage, overlays = {}) {
  const logical = (rolesContract.roles || []).find(entry => entry.id === role.logical_role)
  const compatibility = (rolesContract.compatibilityAliases || []).find(entry => entry.legacyId === physicalId)
  requireCondition(Boolean(logical || compatibility), `${physicalId} has no canonical logical role source`)
  const guard = policy.instruction_guards.untrusted_input.required_prompt_text
  const isCompatibilityAlias = role.compatibility_alias?.enabled === true
  const description = normalizePlainLanguageMarkdown(
    isCompatibilityAlias
      ? `Report the compatibility redirect to \`${role.compatibility_alias.alias_of}\`; this retired role cannot perform new work.`
      : logical.humanDescription,
    plainLanguage,
  ).trim()
  const readResources = role.resource_sets.read.length ? role.resource_sets.read.map(value => `\`${value}\``).join(', ') : 'none'
  const writeResources = role.resource_sets.write.length ? role.resource_sets.write.map(value => `\`${value}\``).join(', ') : 'none'
  const exclusiveResources = role.resource_sets.exclusive.length ? role.resource_sets.exclusive.map(value => `\`${value}\``).join(', ') : 'none'
  const instructions = [
    '# Codex role instructions',
    '',
    description,
    '',
    guard,
    '',
    `Policy layer: \`${role.layer}\`. Allowed parents: ${role.allowed_parents.map(value => `\`${value}\``).join(', ')}.`,
    `Decision rights: ${role.decision_rights.map(value => `\`${value}\``).join(', ')}.`,
    `Accept only a validated \`${role.input_schema_id}\` assignment from an allowed parent. Return the exact \`${role.output_schema_id}\` result.`,
    `Read resources: ${readResources}. Write resources: ${writeResources}. Exclusive resources: ${exclusiveResources}. Do not use any unlisted resource.`,
  ]
  if (role.can_dispatch) {
    instructions.push(`You may start only these registered child roles: ${role.allowed_children.map(value => `\`${value}\``).join(', ')}.`)
  } else if (role.compatibility_alias && role.compatibility_alias.enabled) {
    instructions.push('You cannot start another agent or write files. Do not edit or change the requested result.')
  } else {
    instructions.push('Do not start another agent. Stay within the assignment-owned resources above.')
  }
  if (role.compatibility_alias && role.compatibility_alias.enabled) {
    instructions.push('This compatibility identifier is read-only and cannot be activated as a new version 2 role.')
  } else {
    for (const [field, heading] of [
      ['whatToRead', 'What to read'],
      ['whatToDo', 'What to do'],
      ['whatNotToChange', 'What not to change'],
      ['howToCheck', 'How to check'],
      ['whatToReturn', 'What to return'],
    ]) {
      const instruction = logical.instructions?.[field]
      requireCondition(typeof instruction === 'string' && instruction.trim().length > 0,
        `${physicalId} is missing canonical role instruction ${field}`)
      instructions.push('', `## ${heading}`, '', normalizePlainLanguageMarkdown(instruction, plainLanguage).trim())
    }
  }
  if (overlays.routeExamples) instructions.push('', overlays.routeExamples)
  for (const requirement of overlays.promptRequirements || []) {
    instructions.push('', normalizePlainLanguageMarkdown(requirement, plainLanguage).trim())
  }
  let developerInstructions = instructions.join('\n').replace(/\n+$/, '')
  if (role.compatibility_alias && role.compatibility_alias.enabled &&
      !developerInstructions.includes(CODEX_ALIAS_TELEMETRY_INSTRUCTION)) {
    developerInstructions = `${developerInstructions.replace(/\n+$/, '')}\n\n${CODEX_ALIAS_TELEMETRY_INSTRUCTION}`
  }
  if (!role.compatibility_alias.enabled) {
    const modeInstruction = `Canonical policy modes: ${role.supported_modes.map(mode => `\`${mode}\``).join(', ')}.`
    if (!developerInstructions.includes(modeInstruction)) {
      developerInstructions = `${developerInstructions.replace(/\n+$/, '')}\n\n${modeInstruction}`
    }
  }

  return [
    `sandbox_mode = ${tomlBasicString(role.sandbox_mode)}`,
    `name = ${tomlBasicString(physicalId)}`,
    `description = ${tomlBasicString(description)}`,
    '',
    'developer_instructions = """',
    developerInstructions,
    '"""',
    '',
  ].join('\n')
}

function appendCompiledSection(source, rendered) {
  return `${source.replace(/\n+$/, '')}\n\n${rendered.replace(/\n+$/, '')}\n`
}

function renderCodexSkill(contracts, canonical, routeExamples) {
  const sharedBody = normalizePlainLanguageMarkdown(canonical, contracts.plainLanguage).trim()
  const body = sharedBody.replace(
    'at most 120 seconds. The run owner records the final decision within 240 seconds.',
    'at most 60 seconds. The run owner records the final decision within 240 seconds.',
  )
  requireCondition(body !== sharedBody,
    'Codex conductor source is missing the route-analysis ceiling projection')
  return [
    '---',
    'name: autoprompt',
    "description: 'Run explicitly requested Autoprompt work with task routing, owned assignments, independent checks, and bounded recovery.'",
    'activation: explicit-only',
    'allow-implicit-invocation: false',
    '---',
    '',
    '# Autoprompt for Codex',
    '',
    `Start only through \`${CODEX_ACTIVATION_SYNTAX.externalCommand}\` or the exact internal skill envelope \`${CODEX_ACTIVATION_SYNTAX.internalSkillEnvelope}\`.`,
    `\`${CODEX_ACTIVATION_SYNTAX.unsupportedSlashCommand}\` is not a supported Codex command. Return \`${CODEX_ACTIVATION_SYNTAX.unsupportedCode}\`. Do not treat the slash form as activation.`,
    'There is no default route.',
    '',
    body,
    '',
    routeExamples.replace(/\n+$/, ''),
    '',
  ].join('\n')
}

function renderCodexModes(contracts, registry) {
  const lines = [
    '# Codex work structures',
    '',
    `Generated from ${registry.canonicalInputs.modes.map(value => `\`${value}\``).join(', ')}. There is no default route.`,
  ]
  for (const route of contracts.product.product.routeNames) {
    const definition = contracts.routes.routes[route]
    lines.push(
      '',
      `## ${route}`,
      '',
      `- Planning record: \`${definition.planningFile}\`.`,
      `- Coordinator allowed: \`${Boolean(definition.coordinatorAllowed)}\`.`,
      `- Manager allowed: \`${Boolean(definition.managerAllowed || definition.managerAdmission)}\`.`,
      `- Independent checker minimum: \`${definition.checkerRange.min}\`.`,
    )
  }
  return `${lines.join('\n')}\n`
}

function validateCodexViews(contracts, root = ROOT) {
  const registry = loadCodexPackageRegistry(root)
  const sources = [
    registry.canonicalInputs.conductor,
    registry.canonicalInputs.gates,
    registry.canonicalInputs.playbooks,
    registry.canonicalInputs.rolePolicy,
    registry.canonicalInputs.personas,
    ...registry.canonicalInputs.modes,
  ]
  for (const relativePath of sources) {
    requireCondition(fs.existsSync(path.join(root, relativePath)), `Codex canonical source is missing: ${relativePath}`)
  }
  requireCondition(registry.canonicalInputs.conductor === 'agents/contracts/generic.md', 'Codex conductor source is not canonical')
  requireCondition(registry.canonicalInputs.frameworks === 'agents/contracts/frameworks', 'Codex framework source is not canonical')
  requireCondition(registry.canonicalInputs.personas === 'agents/contracts/personas', 'Codex role source is not canonical')
  const frameworkDirectory = path.join(root, registry.canonicalInputs.frameworks)
  const frameworks = fs.readdirSync(frameworkDirectory)
    .filter(name => name.endsWith('.md'))
    .sort()
  const frameworkRoutes = codexFrameworkRoutes(root)
  requireCondition(sameMembers(frameworks, Object.keys(frameworkRoutes)), 'Codex canonical framework source mismatch')
  return Object.freeze({ registry, frameworks, frameworkRoutes })
}

function renderCodexReadme(contracts, frameworkCount) {
  const physicalRoleCount = Object.keys(contracts.rolePolicy.physical_roles).length
  return [
    '# Codex package',
    '',
    '- [`SKILL.md`](SKILL.md): L0 coordinator prompt',
    `- [\`agents\`](agents/): ${physicalRoleCount} physical Codex TOML roles`,
    `- [\`frameworks\`](frameworks/): ${frameworkCount} task and check workflows`,
    '- [`workflow`](workflow/): role casting, profile binding, budgeting, and supervisors',
    '- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts',
    '',
    'The committed TOMLs inherit the session model. Installation can recast the same roles with the selected model and effort configuration.',
    '',
    'Internal roles remain inside one immutable generation-qualified private bundle. Ordinary review and merge requests do not load Autoprompt or any companion review skill. Start work only through exact explicit activation:',
    '',
    '```bash',
    'autoprompt activate codex --target <absolute-project-path> -- <request>',
    '```',
    '',
    'The launcher verifies the exact installed payload, request envelope, role projection, workspace-write profile, and separate read-only checker profile before starting the supervisor.',
    '',
  ].join('\n')
}

function renderCodexOutputs(root = ROOT) {
  const contracts = loadCodexV2Contracts(root)
  const views = validateCodexViews(contracts, root)
  const registry = views.registry
  const outputs = new Map()
  const gatesSha256 = sha256Text(read(registry.canonicalInputs.gates, root))
  const routesSha256 = sha256Text(read('agents/contracts/routes.json', root))
  const routeExamples = renderCompiledRouteExamples(contracts.routes, routesSha256)
  const physicalIds = Object.keys(contracts.rolePolicy.physical_roles).sort()
  for (const physicalId of physicalIds) {
    const relativePath = `${registry.generatedOutputs.agents}/${physicalId}.toml`
    outputs.set(relativePath, renderCodexPolicyAgent(
      physicalId,
      contracts.rolePolicy.physical_roles[physicalId],
      contracts.roles,
      contracts.rolePolicy,
      contracts.plainLanguage,
      {
        ...(physicalId === 'ap-route-analyst' ? { routeExamples } : {}),
        promptRequirements: registry.promptRequirements?.[physicalId] || [],
      },
    ))
  }
  outputs.set(registry.generatedOutputs['SKILL.md'], renderCodexSkill(
    contracts,
    read(registry.canonicalInputs.conductor, root),
    routeExamples,
  ))
  outputs.set(registry.generatedOutputs['GATES.md'], [
    '# Canonical checks for Codex',
    '',
    `Generated from \`${registry.canonicalInputs.gates}\`.`,
    '',
    renderFullCompiledGates(contracts.gates, gatesSha256).replace(/\n+$/, ''),
    '',
  ].join('\n'))
  outputs.set(registry.generatedOutputs['MODES.md'], renderCodexModes(contracts, registry))
  outputs.set(registry.generatedOutputs['PLAYBOOKS.md'], normalizePlainLanguageMarkdown(
    read(registry.canonicalInputs.playbooks, root),
    contracts.plainLanguage,
  ))
  outputs.set(registry.generatedOutputs['README.md'], normalizePlainLanguageMarkdown(
    renderCodexReadme(contracts, views.frameworks.length), contracts.plainLanguage,
  ))
  const sharedFrameworks = renderSharedFrameworkOutputs(root, contracts.plainLanguage)
  for (const file of views.frameworks) {
    const relativePath = `${registry.generatedOutputs.frameworks}/${file}`
    outputs.set(relativePath, appendCompiledSection(
      sharedFrameworks.get(`${registry.canonicalInputs.frameworks}/${file}`),
      renderFrameworkCompiledGates(contracts.gates, gatesSha256, views.frameworkRoutes[file]),
    ))
  }
  const packageVersion = readCodexPackageVersion(root)
  outputs.set(registry.generatedOutputs.version, `${packageVersion}\n`)
  validateFullCompiledGates(outputs.get(registry.generatedOutputs['GATES.md']), contracts.gates, gatesSha256)
  validateFrameworkGateProjections(outputs, contracts.gates, gatesSha256, views.frameworkRoutes)
  validateCompiledRouteExamples(outputs.get(registry.generatedOutputs['SKILL.md']), contracts.routes, routesSha256, 'Codex L0 prompt')
  validateCompiledRouteExamples(outputs.get(`${registry.generatedOutputs.agents}/ap-route-analyst.toml`), contracts.routes, routesSha256, 'Codex route analyst prompt')
  validateGeneratedPlainLanguage(outputs, contracts.plainLanguage)
  return outputs
}

function opencodePermissionLines(capabilities) {
  const lines = [
    `  read: ${capabilities.includes('Read') ? 'allow' : 'deny'}`,
    `  edit: ${capabilities.some(capability => capability === 'Write' || capability === 'Edit') ? 'allow' : 'deny'}`,
    `  glob: ${capabilities.includes('Glob') ? 'allow' : 'deny'}`,
    `  grep: ${capabilities.includes('Grep') ? 'allow' : 'deny'}`,
    `  bash: ${capabilities.includes('Bash') ? 'allow' : 'deny'}`,
  ]
  if (capabilities.includes('Agent')) {
    lines.push('  task:', '    "*": deny', '    "ap-*": allow')
  } else {
    lines.push('  task: deny')
  }
  lines.push(
    `  webfetch: ${capabilities.includes('WebFetch') ? 'allow' : 'deny'}`,
    `  websearch: ${capabilities.includes('WebSearch') ? 'allow' : 'deny'}`,
    '  skill: deny',
  )
  return lines
}

function renderOpencodeAgent(persona, source) {
  return [
    '---',
    `description: ${yamlDoubleQuoted(persona.description)}`,
    'mode: subagent',
    'permission:',
    ...opencodePermissionLines(persona.capabilities),
    '---',
    stripFrontmatter(source),
  ].join('\n')
}

const VSCODE_TOOL_ALIASES = [
  ['execute', ['Bash']],
  ['read', ['Read']],
  ['edit', ['Write', 'Edit']],
  ['search', ['Glob', 'Grep']],
  ['agent', ['Agent']],
  ['web', ['WebSearch', 'WebFetch']],
]

function vscodeTools(capabilities) {
  return VSCODE_TOOL_ALIASES
    .filter(([, sources]) => sources.some(source => capabilities.includes(source)))
    .map(([alias]) => alias)
}

function validateVsCodePersona(persona, personaIds) {
  if (!Array.isArray(persona.allowedChildren)) {
    throw new Error(`VS Code persona ${persona.id} must define allowedChildren`)
  }
  if (new Set(persona.allowedChildren).size !== persona.allowedChildren.length) {
    throw new Error(`VS Code persona ${persona.id} repeats an allowed child`)
  }
  for (const child of persona.allowedChildren) {
    if (!personaIds.has(child)) throw new Error(`VS Code persona ${persona.id} has unknown child ${child}`)
  }
  if (persona.capabilities.includes('Agent') !== (persona.allowedChildren.length > 0)) {
    throw new Error(`VS Code persona ${persona.id} has inconsistent Agent capability`)
  }
}

function renderVsCodeAgent(persona, source, personaIds) {
  validateVsCodePersona(persona, personaIds)
  return asciiDashes([
    '---',
    `name: ${yamlDoubleQuoted(persona.id)}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    `tools: ${JSON.stringify(vscodeTools(persona.capabilities))}`,
    `agents: ${JSON.stringify(persona.allowedChildren)}`,
    'user-invocable: false',
    'disable-model-invocation: false',
    '---',
    stripFrontmatter(source),
  ].join('\n'))
}

function replaceSection(source, start, end, replacement) {
  const pattern = new RegExp(`${start}\\n[\\s\\S]*?\\n(?=${end})`)
  if (!pattern.test(source)) throw new Error(`VS Code provider source is missing section ${start}`)
  return source.replace(pattern, `${replacement}\n\n`)
}

function renderVsCodeSettingsDisclosure(provider) {
  const prerequisites = Object.entries(provider.runtimePrerequisites || {})
  const lifecycle = provider.settingsLifecycle || {}
  const supportedLifecycle = lifecycle.edit === 'transactional' &&
    lifecycle.backup === 'byte-exact' &&
    JSON.stringify(lifecycle.restore) === JSON.stringify(['rollback', 'uninstall']) &&
    lifecycle.unsafeJsonc === 'refuse' &&
    lifecycle.conflicts === 'refuse'
  if (prerequisites.length !== 1 || prerequisites[0][1] !== true || !supportedLifecycle) {
    throw new Error('VS Code provider contract has an unsupported settings lifecycle')
  }
  const setting = `${prerequisites[0][0]}=${prerequisites[0][1]}`
  return `The installer transactionally sets \`${setting}\` in the VS Code user \`settings.json\`. When it changes an existing file, it stores a byte-exact backup and restores the prior bytes on rollback or uninstall. It refuses unsafe JSONC and conflicting state instead of overwriting user configuration.`
}

function renderVsCodeSkill(source, provider) {
  const settingsDisclosure = renderVsCodeSettingsDisclosure(provider)
  let output = asciiDashes(source).replaceAll('OpenCode', 'VS Code')
  output = replaceSection(output, '## 8\\. VS Code model and effort', '## 9\\.', [
    '## 8. VS Code model and effort',
    '',
    'VS Code `ap-*` subagents are native `.agent.md` definitions with no `model` field. Every role inherits the currently selected model, so casting and effort are `inherited-only`.',
    '',
    'The definitions map canonical capabilities to the pinned built-in aliases `execute`, `read`, `edit`, `search`, `agent`, and `web`. Dispatcher roles alone receive `agent` and an explicit canonical child allowlist. Non-dispatch roles omit `agent` and carry `agents: []`. Every internal role sets `user-invocable: false` and `disable-model-invocation: false`.',
    '',
    settingsDisclosure,
  ].join('\n'))
  return replaceSection(output, '## 11\\. Run', '$', [
    '## 11. Run',
    '',
    'Use VS Code 1.133 or later, install the skill and `.agent.md` definitions in their supported locations, and explicitly invoke:',
    '',
    '```text',
    '/autoprompt <mission>',
    '```',
    '',
    'A successful VS Code install leaves the recursive-subagent setting enabled, and doctor verifies it before recursive subagent use.',
  ].join('\n')).replace(/\n+$/, '\n')
}

function renderVsCodeModes(source, provider) {
  const output = asciiDashes(source).replaceAll('OpenCode', 'VS Code')
  return replaceSection(output, '### VS Code agent selection and effort', '## Steering', [
    '### VS Code agent selection and effort',
    '',
    'VS Code casting is `inherited-only`: installed `ap-*` custom agents omit `model` and inherit the currently selected model. Agent selection does not change gates or concurrency.',
    '',
    '- `agents=off` or omitted: the routable mode; every role inherits the selected model.',
    '- any explicit model selector: not routable through these `.agent.md` definitions; record `inherited-only` and do not claim that a selection applied.',
    '',
    'The recursion brakes are native. Canonical capabilities map to VS Code built-in tool aliases. Dispatcher roles include `agent` plus an explicit `agents` allowlist; non-dispatch roles omit `agent` and use `agents: []`. Internal roles are hidden from users and remain callable by an allowed parent.',
    '',
    renderVsCodeSettingsDisclosure(provider),
  ].join('\n'))
}

function renderVsCodeGates(source, provider) {
  let output = asciiDashes(source).replaceAll('OpenCode', 'VS Code')
  output = output.replace(
    /VS Code agent selection is `inherited-only`:[\s\S]*?Model and effort never change gates or concurrency\./,
    'VS Code agent selection is `inherited-only`: installed `ap-*` `.agent.md` definitions omit `model` and inherit the currently selected model. Model and effort never change gates or concurrency.',
  )
  output = output.replace(
    /The activation profile pins `subagent_depth = 4`[\s\S]*?These are ceilings, never spawn targets\./,
    `Each dispatcher uses the \`agent\` tool alias and an explicit canonical child allowlist. ${renderVsCodeSettingsDisclosure(provider)} Runtime nesting limits are ceilings, never spawn targets.`,
  )
  return output
}

function renderVsCodeProviderText(file, source, provider) {
  if (file === 'SKILL.md') return renderVsCodeSkill(source, provider)
  if (file === 'MODES.md') return renderVsCodeModes(source, provider)
  if (file === 'GATES.md') return renderVsCodeGates(source, provider)
  return asciiDashes(source)
}

function renderVsCodeReadme(provider, inventory) {
  return [
    '# VS Code package',
    '',
    'This deterministic adapter targets VS Code 1.133 custom agents with the bundled GitHub Copilot 0.61 contract.',
    '',
    '- [`SKILL.md`](SKILL.md): L0 conductor prompt',
    `- [\`agents\`](agents/): ${inventory.personaCount} native \`.agent.md\` internal roles`,
    `- [\`frameworks\`](frameworks/): ${inventory.frameworkCount} task and gate workflows`,
    '- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts',
    '',
    renderVsCodeSettingsDisclosure(provider),
    '',
    'The agent files omit `model`, so every role inherits the currently selected model. All roles are internal, hidden from direct user invocation, and restricted by explicit canonical child allowlists.',
    '',
  ].join('\n')
}

function renderKiloProviderText(source) {
  return source
    .replaceAll('OPENCODE_CONFIG', 'KILO_CONFIG')
    .replaceAll('OpenCode', 'Kilo')
    .replaceAll('opencode', 'kilo')
    .replaceAll('1.18.7', '7.4.22')
}

function renderKiloProfile() {
  return `${JSON.stringify({
    $schema: 'https://app.kilo.ai/config.json',
    subagent_depth: 4,
    share: 'disabled',
    permission: { task: { '*': 'deny', 'ap-*': 'allow' } },
  }, null, 2)}\n`
}

const OMP_TOOL_ALIASES = [
  ['read', ['Read']],
  ['write', ['Write']],
  ['edit', ['Edit']],
  ['glob', ['Glob']],
  ['grep', ['Grep']],
  ['bash', ['Bash']],
  ['task', ['Agent']],
  ['web_search', ['WebSearch']],
  ['browser', ['WebFetch']],
]

function ompTools(capabilities) {
  return OMP_TOOL_ALIASES
    .filter(([, sources]) => sources.some(source => capabilities.includes(source)))
    .map(([name]) => name)
}

function renderOmpAgent(persona, source) {
  const lines = [
    '---',
    `name: ${persona.id}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    'tools:',
    ...ompTools(persona.capabilities).map(tool => `  - ${tool}`),
  ]
  if (persona.allowedChildren.length > 0) {
    lines.push('spawns:', ...persona.allowedChildren.map(child => `  - ${child}`))
  }
  lines.push('---', stripFrontmatter(source))
  return asciiDashes(lines.join('\n'))
}

function renderDeepSeekAgent(persona, source) {
  return asciiDashes([
    '---',
    `name: ${persona.id}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    '---',
    stripFrontmatter(source),
  ].join('\n'))
}

function renderReasonixAgent(persona, source) {
  return asciiDashes([
    '---',
    `name: ${persona.id}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    'invocation: manual',
    'runAs: subagent',
    '---',
    stripFrontmatter(source),
  ].join('\n'))
}

function indentBlock(value, spaces) {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map(line => line ? `${prefix}${line}` : '').join('\n')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function deepSeekRoleTool(persona, source) {
  const toolName = persona.id.replaceAll('-', '_')
  const allowed = new Set(persona.allowedChildren.map(child => child.replaceAll('-', '_')))
  const allRoleNames = deepSeekRoleTool.personaIds
  const deniedRoles = allRoleNames.filter(candidate => !allowed.has(candidate))
  const lines = [
    `- id: autoprompt-${persona.id}`,
    "  name: '@deepseek-ai/dsh-tool-subagent'",
    '  config:',
    '    provider: spawn',
    `    toolName: ${toolName}`,
    '    backgroundMode: continuable',
    '    maxDepth: 4',
    '    persona: |-',
    indentBlock(stripFrontmatter(source).trimEnd(), 6),
    '    toolFilter:',
    '      deny:',
    '        - subagent',
    '        - subagent_fork',
    ...deniedRoles.map(role => `        - ${role}`),
  ]
  return lines.join('\n')
}
deepSeekRoleTool.personaIds = []

function renderDeepSeekPreset(personas, sources) {
  deepSeekRoleTool.personaIds = personas.map(persona => persona.id.replaceAll('-', '_'))
  const base = [
    '# Autoprompt agent preset for DeepSeek Harness 0.1.0-rc.7.',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: >-',
    '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
    '- id: agent-instructions',
    "  name: '@deepseek-ai/dsh-agent-instructions'",
    '  config:',
    '    maxBytes: 65536',
    '- id: tool-bash',
    "  name: '@deepseek-ai/dsh-tool-bash'",
    "  disabled: !!js process.platform === 'win32'",
    '- id: tool-pwsh',
    "  name: '@deepseek-ai/dsh-tool-pwsh'",
    "  disabled: !!js process.platform !== 'win32'",
    '- id: tool-fs',
    "  name: '@deepseek-ai/dsh-tool-fs'",
    '- id: tool-fs-search',
    "  name: '@deepseek-ai/dsh-tool-fs-search'",
    '  config:',
    '    sampleOverCapGlobResults: false',
    '- id: tool-jobs',
    "  name: '@deepseek-ai/dsh-tool-jobs'",
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '- id: tool-skill',
    "  name: '@deepseek-ai/dsh-tool-skill'",
    '- id: tool-goal',
    "  name: '@deepseek-ai/dsh-tool-goal'",
    '- id: tool-subagent-control',
    "  name: '@deepseek-ai/dsh-tool-subagent-control'",
    '- id: tool-subagent-list-agents',
    "  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
    '- id: tool-ask-user',
    "  name: '@deepseek-ai/dsh-tool-ask-user'",
    '- id: tool-todo',
    "  name: '@deepseek-ai/dsh-tool-todo'",
    '  config:',
    '    allowParallelInProgress: true',
    '- id: tool-web',
    "  name: '@deepseek-ai/dsh-tool-web'",
    '  config:',
    '    fetch: false',
    '    searchTimeoutMs: 60000',
  ]
  for (let index = 0; index < personas.length; index += 1) {
    base.push(deepSeekRoleTool(personas[index], sources[index]))
  }
  return `${base.join('\n')}\n`
}

function renderDeepSeekHeadlessPatch(personas, sources) {
  deepSeekRoleTool.personaIds = personas.map(persona => persona.id.replaceAll('-', '_'))
  const entries = personas.map((persona, index) => (
    indentBlock(deepSeekRoleTool(persona, sources[index]), 2)
  ))
  return `# Load with: dsh --profile headless --patch <this-file> <task>\n- insert:\n${entries.join('\n')}\n`
}

const INHERITED_PROVIDER_TEXT = Object.freeze({
  omp: Object.freeze({
    display: 'OMP',
    invocation: '/skill:autoprompt <mission>',
    version: '17.4.0',
    mechanism: 'native markdown subagents with explicit `spawns` allowlists',
    activation: 'OMP discovers the installed skill and `ap-*` agent files from its agent directory. The native `spawns` lists enforce canonical child edges and OMP enforces the recursion ceiling.',
    frontmatter: ['user-invocable: true', 'disable-model-invocation: true'],
  }),
  deepseek: Object.freeze({
    display: 'DeepSeek Harness',
    invocation: '/autoprompt <mission>',
    version: '0.1.0-rc.7',
    mechanism: 'fixed-persona `dsh-tool-subagent` instances in the Autoprompt agent preset',
    activation: 'Select the Autoprompt agent preset for Web sessions. For headless runs, pass the installed `headless.patch.yml` with `--patch`. Each role tool denies non-allowlisted role tools and uses a depth ceiling of four.',
    frontmatter: ['user-invocable: true', 'disable-model-invocation: true'],
  }),
  reasonix: Object.freeze({
    display: 'Reasonix',
    invocation: '/autoprompt <mission>',
    version: '1.30.0',
    mechanism: 'native manual `runAs: subagent` skill profiles',
    activation: 'Reasonix discovers the installed top-level skill and `ap-*` subagent profiles from its skill directory. Canonical role prompts define the recursive child edges.',
    frontmatter: ['invocation: manual'],
  }),
})

function inheritedProviderFrontmatter(source, provider) {
  const settings = INHERITED_PROVIDER_TEXT[provider]
  return source.replace(
    /^(---\nname: autoprompt\ndescription: [^\n]+)\n---/,
    `$1\n${settings.frontmatter.join('\n')}\n---`,
  )
}

function renderInheritedProviderText(file, source, provider) {
  const settings = INHERITED_PROVIDER_TEXT[provider]
  let output = asciiDashes(source)
    .replaceAll('OpenCode', settings.display)
    .replaceAll('opencode', provider)
    .replaceAll('OPENCODE_CONFIG', `${provider.toUpperCase()}_CONFIG`)
  if (file === 'SKILL.md') {
    output = inheritedProviderFrontmatter(output, provider)
    output = output.replace(
      'Invoke /autoprompt to turn a mission',
      `Invoke ${settings.invocation.split(' ')[0]} to turn a mission`,
    )
    output = replaceSection(output, `## 8\\. ${escapeRegExp(settings.display)} model and effort`, '## 9\\.', [
      `## 8. ${settings.display} model and effort`,
      '',
      `${settings.display} uses ${settings.mechanism}. Generated roles omit a model override and inherit the selected parent model. Casting and effort are therefore \`inherited-only\`; \`agents=auto\` and explicit model lists are not routable through this adapter.`,
      '',
      settings.activation,
    ].join('\n'))
    output = replaceSection(output, '## 11\\. Run', '$', [
      '## 11. Run',
      '',
      `Use ${settings.display} ${settings.version} or later and explicitly invoke:`,
      '',
      '```text',
      settings.invocation,
      '```',
      '',
      settings.activation,
    ].join('\n'))
  } else if (file === 'MODES.md') {
    output = replaceSection(output, `### ${escapeRegExp(settings.display)} agent selection and effort`, '## Steering', [
      `### ${settings.display} agent selection and effort`,
      '',
      `${settings.display} casting is \`inherited-only\`: ${settings.mechanism} omit model overrides and inherit the selected parent model.`,
      '',
      '- `agents=off` or omitted: the only routable mode; every role inherits the selected model.',
      '- `agents=auto`, `agents=<comma-list>`, and `agents=auto:<comma-list>`: not routable; record `inherited-only` and never claim a selection applied.',
      '',
      'Record effort as exactly `inherited-only`: omit any effort field and never claim a requested or maximum effort was applied.',
      '',
      settings.activation,
    ].join('\n'))
  } else if (file === 'GATES.md') {
    output = output.replace(
      new RegExp(`${escapeRegExp(settings.display)} agent selection is \`inherited-only\`:[\\s\\S]*?Model and effort never change gates or concurrency\\.`),
      `${settings.display} agent selection is \`inherited-only\`: generated roles omit model overrides and inherit the selected parent model. Model and effort never change gates or concurrency.`,
    )
    output = output.replace(
      /The activation profile pins `subagent_depth = 4`[\s\S]*?These are ceilings, never spawn targets\./,
      `${settings.activation} Runtime nesting limits are ceilings, never spawn targets.`,
    )
  }
  return output.replace(/\n+$/, '\n')
}

function renderInheritedProviderReadme(provider, inventory) {
  const settings = INHERITED_PROVIDER_TEXT[provider]
  return [
    `# ${settings.display} package`,
    '',
    `This package targets ${settings.display} ${settings.version}.`,
    '',
    '- [`SKILL.md`](SKILL.md): L0 conductor prompt',
    provider === 'reasonix'
      ? `- [\`skills\`](skills/): ${inventory.personaCount} native subagent profiles`
      : `- [\`agents\`](agents/): ${inventory.personaCount} generated role definitions`,
    `- [\`frameworks\`](frameworks/): ${inventory.frameworkCount} task and gate workflows`,
    '- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts',
    '',
    settings.activation,
    '',
    'Every role inherits the selected parent model. Custom `agents=` model routing is not available.',
    '',
  ].join('\n')
}

const PRIME_ROOT_ALLOWED_CHILDREN = [
  'ap-scope-coordinator',
  'ap-feature-coordinator',
  'ap-sweep-coordinator',
  'ap-preflight-probe',
  'ap-intake',
]

function renderPrimePackage(provider, version) {
  return `${JSON.stringify({
    name: 'autoprompt-prime-agent-adapter',
    version,
    description: 'Native Autoprompt package for Prime Agent.',
    type: 'module',
    keywords: ['pi-package', 'prime-agent', 'autoprompt'],
    peerDependencies: {
      '@earendil-works/pi-coding-agent': provider.packagePeerRange,
    },
    pi: {
      extensions: ['./extensions/autoprompt.ts'],
      skills: ['./skills/autoprompt'],
      prompts: ['./prompts/frameworks'],
    },
  }, null, 2)}\n`
}

function renderPrimeExtension(personas, frameworks) {
  const ids = JSON.stringify(personas.map(persona => persona.id), null, 2)
  const frameworkIds = JSON.stringify(frameworks.map(framework => framework.id), null, 2)
  return [
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { dirname, isAbsolute, join, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    '',
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    '',
    `export const PERSONA_IDS = Object.freeze(${ids}) as readonly string[];`,
    `export const FRAMEWORK_IDS = Object.freeze(${frameworkIds}) as readonly string[];`,
    '',
    'const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;',
    'const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;',
    'const SHA256_PATTERN = /^[0-9a-f]{64}$/;',
    'const ENVELOPE_HEADER = "# SEALED AUTOPROMPT DISPATCH ENVELOPE";',
    'const FRAMEWORK_START = "## BEGIN SEALED FRAMEWORK";',
    'const FRAMEWORK_END = "## END SEALED FRAMEWORK";',
    'const TASK_END = "## END BOUNDED TASK";',
    'const PERSONA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "personas");',
    'const FRAMEWORK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "frameworks");',
    'const PERSONA_PROMPTS = new Map(',
    '  PERSONA_IDS.map((id) => [id, readFileSync(join(PERSONA_ROOT, `${id}.md`), "utf8").replace(/\\r\\n/g, "\\n")]),',
    ');',
    'const FRAMEWORK_PROMPTS = new Map(',
    '  FRAMEWORK_IDS.map((id) => [id, readFileSync(join(FRAMEWORK_ROOT, `${id}.md`), "utf8").replace(/\\r\\n/g, "\\n").trim()]),',
    ');',
    '',
    'interface MissionBinding {',
    '  path: string;',
    '  sha256: string;',
    '  bytes: number;',
    '  nonce: string;',
    '}',
    '',
    'interface DispatchEnvelope {',
    '  persona: string;',
    '  framework: string | null;',
    '  binding: MissionBinding;',
    '}',
    '',
    'export function resolvePersonaId(sessionName: string | undefined): string | undefined {',
    '  if (!sessionName) return undefined;',
    '  for (const persona of PERSONA_IDS) {',
    '    if (sessionName === persona) return persona;',
    '    const prefix = `${persona}--`;',
    '    if (sessionName.startsWith(prefix) && INSTANCE_PATTERN.test(sessionName.slice(prefix.length))) {',
    '      return persona;',
    '    }',
    '  }',
    '  return undefined;',
    '}',
    '',
    'function missionBindingIsCurrent(binding: MissionBinding): boolean {',
    '  if (!isAbsolute(binding.path) || resolve(binding.path) !== binding.path) return false;',
    '  if (!SHA256_PATTERN.test(binding.sha256)) return false;',
    '  if (!Number.isSafeInteger(binding.bytes) || binding.bytes <= 0) return false;',
    '  if (!NONCE_PATTERN.test(binding.nonce)) return false;',
    '  try {',
    '    const payload = readFileSync(binding.path);',
    '    new TextDecoder("utf-8", { fatal: true }).decode(payload);',
    '    return (',
    '      payload.length === binding.bytes',
    '      && createHash("sha256").update(payload).digest("hex") === binding.sha256',
    '    );',
    '  } catch {',
    '    return false;',
    '  }',
    '}',
    '',
    'function parseMissionBinding(value: string): MissionBinding | undefined {',
    '  try {',
    '    const parsed = JSON.parse(value) as Record<string, unknown>;',
    '    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;',
    '    if (Object.keys(parsed).sort().join(",") !== "bytes,nonce,path,sha256") return undefined;',
    '    if (typeof parsed.path !== "string") return undefined;',
    '    if (typeof parsed.sha256 !== "string") return undefined;',
    '    if (typeof parsed.bytes !== "number") return undefined;',
    '    if (typeof parsed.nonce !== "string") return undefined;',
    '    const binding: MissionBinding = {',
    '      path: parsed.path,',
    '      sha256: parsed.sha256,',
    '      bytes: parsed.bytes,',
    '      nonce: parsed.nonce,',
    '    };',
    '    if (JSON.stringify(binding) !== value || !missionBindingIsCurrent(binding)) return undefined;',
    '    return binding;',
    '  } catch {',
    '    return undefined;',
    '  }',
    '}',
    '',
    'export function validateDispatchEnvelope(',
    '  prompt: string,',
    '  expectedPersona: string,',
    '): DispatchEnvelope | undefined {',
    '  if (typeof prompt !== "string" || !PERSONA_IDS.includes(expectedPersona)) return undefined;',
    '  const lines = prompt.split("\\n");',
    '  if (lines[0] !== ENVELOPE_HEADER) return undefined;',
    '  if (lines[3] !== "MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.") return undefined;',
    '  if (lines[6] !== `AUTOPROMPT_PERSONA: ${expectedPersona}`) return undefined;',
    '  if (lines[9] !== "The extension binds the canonical persona prompt by this allowlisted session name.") return undefined;',
    '  if (lines[10] !== "" || lines[11] !== FRAMEWORK_START) return undefined;',
    '',
    '  const bindingPrefix = "AUTOPROMPT_MISSION_BINDING: ";',
    '  if (!lines[4]?.startsWith(bindingPrefix)) return undefined;',
    '  const binding = parseMissionBinding(lines[4].slice(bindingPrefix.length));',
    '  if (!binding) return undefined;',
    '  if (lines[1] !== `AUTOPROMPT-RUN-MARKER: runtime=prime-agent-adapter-v1 nonce=${binding.nonce} prompt=sha256:${binding.sha256}`) return undefined;',
    '  if (lines[2] !== `RUN-NONCE: ${binding.nonce}`) return undefined;',
    '  if (lines[5] !== `AUTOPROMPT_BINDING_CALL: autoprompt.bind(${JSON.stringify(binding.path)}, nonce=${JSON.stringify(binding.nonce)})`) return undefined;',
    '',
    '  const frameworkPrefix = "AUTOPROMPT_FRAMEWORK: ";',
    '  if (!lines[7]?.startsWith(frameworkPrefix)) return undefined;',
    '  const frameworkValue = lines[7].slice(frameworkPrefix.length);',
    '  const framework = frameworkValue === "none" ? null : frameworkValue;',
    '  if (framework !== null && !FRAMEWORK_IDS.includes(framework)) return undefined;',
    '',
    '  const depth = /^AUTOPROMPT_RUNTIME_DEPTH: parent=([0-3]) child=([1-4])$/.exec(lines[8] ?? "");',
    '  if (!depth || Number(depth[2]) !== Number(depth[1]) + 1) return undefined;',
    '',
    '  const frameworkEnd = lines.indexOf(FRAMEWORK_END, 12);',
    '  if (frameworkEnd < 12 || lines[frameworkEnd + 1] !== "") return undefined;',
    '  const expectedFrameworkText = framework === null ? "" : FRAMEWORK_PROMPTS.get(framework);',
    '  if (expectedFrameworkText === undefined) return undefined;',
    '  if (lines.slice(12, frameworkEnd).join("\\n") !== expectedFrameworkText) return undefined;',
    '',
    '  const taskHeader = /^## BEGIN BOUNDED TASK \\(utf8-bytes=([1-9][0-9]*)\\)$/.exec(lines[frameworkEnd + 2] ?? "");',
    '  if (!taskHeader || lines.at(-1) !== TASK_END) return undefined;',
    '  const task = lines.slice(frameworkEnd + 3, -1).join("\\n");',
    '  if (Buffer.byteLength(task, "utf8") !== Number(taskHeader[1])) return undefined;',
    '  return { persona: expectedPersona, framework, binding };',
    '}',
    '',
    'function sameAdmission(left: DispatchEnvelope, right: DispatchEnvelope): boolean {',
    '  return (',
    '    left.persona === right.persona',
    '    && left.framework === right.framework',
    '    && JSON.stringify(left.binding) === JSON.stringify(right.binding)',
    '  );',
    '}',
    '',
    'function deniedSystemPrompt(base: string, sessionName: string): string {',
    '  return [',
    '    base,',
    '    "",',
    '    "# AUTOPROMPT PERSONA ACTIVATION DENIED",',
    '    `Session ${JSON.stringify(sessionName)} has an ap-* name but no valid sealed Autoprompt dispatch envelope.`,',
    '    "No canonical Autoprompt persona was loaded. Treat this as an unmanaged Prime Agent session.",',
    '  ].join("\\n");',
    '}',
    '',
    'export default function autopromptExtension(pi: ExtensionAPI) {',
    '  const admissions = new Map<string, DispatchEnvelope>();',
    '  pi.on("before_agent_start", async (event, ctx) => {',
    '    const sessionName = ctx.sessionManager.getSessionName();',
    '    const persona = resolvePersonaId(sessionName);',
    '    if (!persona) return undefined;',
    '    const sessionId = ctx.sessionManager.getSessionId();',
    '    const candidate = validateDispatchEnvelope(event.prompt, persona);',
    '    const previous = admissions.get(sessionId);',
    '    const resemblesEnvelope = event.prompt.startsWith(`${ENVELOPE_HEADER}\\n`)',
    '      || event.prompt.includes("AUTOPROMPT-RUN-MARKER:");',
    '    let admission: DispatchEnvelope | undefined;',
    '    if (candidate) {',
    '      if (previous && !sameAdmission(previous, candidate)) admissions.delete(sessionId);',
    '      admissions.set(sessionId, candidate);',
    '      admission = candidate;',
    '    } else if (previous && !resemblesEnvelope && missionBindingIsCurrent(previous.binding)) {',
    '      admission = previous;',
    '    }',
    '    if (!admission || admission.persona !== persona) {',
    '      admissions.delete(sessionId);',
    '      return { systemPrompt: deniedSystemPrompt(event.systemPrompt, sessionName ?? persona) };',
    '    }',
    '    const canonicalPrompt = PERSONA_PROMPTS.get(persona);',
    '    if (!canonicalPrompt) return undefined;',
    '    return {',
    '      systemPrompt: [',
    '        event.systemPrompt,',
    '        "",',
    '        "# SEALED AUTOPROMPT PERSONA",',
    '        `AUTOPROMPT_PERSONA: ${persona}`,',
    '        `AUTOPROMPT_ADMISSION: nonce=${admission.binding.nonce} prompt=sha256:${admission.binding.sha256} framework=${admission.framework ?? "none"}`,',
    '        "This session is an Autoprompt role. Dispatch only through await autoprompt.dispatch(...); the Python adapter derives daemon identity and enforces the canonical child topology.",',
    '        "Never call rlm or rlm.run directly. Omitting a model in the adapter is deliberate: Prime Agent inherits the selected parent model.",',
    '        "",',
    '        canonicalPrompt.trim(),',
    '      ].join("\\n"),',
    '    };',
    '  });',
    '  pi.on("session_shutdown", (_event, ctx) => {',
    '    admissions.delete(ctx.sessionManager.getSessionId());',
    '  });',
    '}',
    '',
  ].join('\n')
}

function renderPrimeSkill(frameworks, canonicalProtocol) {
  const frameworkLinks = frameworks.map(framework =>
    `- \`${framework.id}\`: [${framework.id}.md](../../prompts/frameworks/${framework.id}.md)`,
  )
  return [
    '---',
    'name: autoprompt',
    'description: Run the Autoprompt orchestration loop on Prime Agent through a topology-enforcing native RLM dispatcher. Use only when the user explicitly invokes Autoprompt or asks to run the loop.',
    '---',
    '',
    '# Autoprompt for Prime Agent',
    '',
    'This package targets Prime Agent 0.7.2. Before recursive use, set `rlmMaxDepth` to `4` in Prime Agent settings and start a fresh session so this Python-backed skill and its extension are loaded.',
    '',
    'Start only for an explicit `/autoprompt <mission>` request. A bare invocation reports the recorded frontier and stops; resume requires an explicit `resume` request.',
    '',
    'Before spawning, resolve only undefined operator knobs:',
    '',
    '- **Concurrency:** `tokensaver` (width-only compatibility preset, at most 6), `wide`, or `custom max_subs=N`.',
    '- **Agent selection:** `off`/inherit only. Confirm that every child inherits the already-selected parent model; no per-child model routing selector is available.',
    '',
    'Resolve settings in this order: explicit invocation, active run, then saved settings. In an attended session, ask once for any required value still missing. In an unattended run, or when the attended answer is still incomplete, return `CONFIG_REQUIRED` before repository or tool work. Do not silently choose a concurrency, model, or effort value.',
    '',
    'After the chooser, use the native dispatcher to start `ap-scope-coordinator`.',
    '',
    '## Native dispatcher',
    '',
    'Import the installed Python skill in the IPython kernel and route every child through it:',
    '',
    '```python',
    'import autoprompt',
    'binding = autoprompt.bind("PROMPTS.txt", nonce="<RUN-NONCE>")',
    'child = await autoprompt.dispatch(',
    '    "ap-scope-coordinator",',
    '    "Produce the bounded scope and roadmap for the mission.",',
    '    binding=binding,',
    '    framework="plan-scope",',
    ')',
    '```',
    '',
    '`dispatch()` reads `agent_message.list_agents` through Prime Agent\'s host bridge, validates the daemon-derived current identity and parent edge, applies the exact canonical child allowlist, rejects terminal roles, and calls Prime Agent\'s real `rlm()` with `name` only. It never passes `model`, so the child inherits the selected parent model.',
    '',
    '`bind()` reads the exact prompt ledger, requires a valid run nonce, and records its resolved path, SHA-256, and UTF-8 byte length. Every dispatch revalidates those bytes and seals the exact `AUTOPROMPT-RUN-MARKER`, `RUN-NONCE`, mission pointer, and binding recreation call into the child brief. Descendants must recreate the same binding with `autoprompt.bind(...)` before dispatching.',
    '',
    'Use the optional `instance` argument (lowercase letters, digits, and hyphens) when multiple siblings need the same persona. The sealed session name is `<persona>--<instance>`.',
    '',
    'At depth 0, routine dispatch is limited to `ap-scope-coordinator`, `ap-feature-coordinator`, and `ap-sweep-coordinator`. `ap-preflight-probe` and `ap-intake` are diagnostic or legacy-resume exceptions, not routine launches. Every deeper call is checked against the current persona\'s canonical child list. Roles with an empty child list are code-level terminals.',
    '',
    'Prime Agent returns an admission handle from native RLM dispatch. Use its native subagent registry and the bundled `agent_message` skill to observe work and exchange results; do not treat admission as completion.',
    '',
    '## Framework prompt templates',
    '',
    'Pass only one of these allowlisted IDs as `framework`. The dispatcher reads the installed immutable package path and seals the selected text into the child envelope:',
    '',
    ...frameworkLinks,
    '',
    'Preserve the framework gates, strict behavioral RED before implementation, independent review, real verification, >=95% changed-line coverage, negative-verdict repair loops, goal checking, and zero open findings before DONE.',
    '',
    '## Canonical Autoprompt protocol',
    '',
    canonicalProtocol.trim(),
    '',
  ].join('\n')
}

function renderPrimePyproject(version = '1.0.0') {
  return [
    '[project]',
    'name = "autoprompt-prime-dispatch"',
    `version = ${tomlBasicString(version)}`,
    'description = "Topology-enforcing Autoprompt dispatcher for Prime Agent"',
    'requires-python = ">=3.10"',
    'dependencies = []',
    '',
    '[build-system]',
    'requires = ["hatchling"]',
    'build-backend = "hatchling.build"',
    '',
    '[tool.hatch.build.targets.wheel]',
    'packages = ["src/autoprompt"]',
    '',
  ].join('\n')
}

function renderPrimeDispatcher(personas, frameworks) {
  const personaData = JSON.stringify(Object.fromEntries(
    personas.map(persona => [persona.id, persona.allowedChildren]),
  ), null, 2)
  const frameworkData = JSON.stringify(Object.fromEntries(
    frameworks.map(framework => [framework.id, `prompts/frameworks/${framework.id}.md`]),
  ), null, 2)
  const rootChildren = JSON.stringify(PRIME_ROOT_ALLOWED_CHILDREN, null, 2)
  return `"""Native, fail-closed Autoprompt dispatcher for Prime Agent 0.7.2."""

from __future__ import annotations

import re
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any


MAX_DEPTH = 4
_INSTANCE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
_NONCE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
_PACKAGE_ROOT = Path(__file__).resolve().parents[4]
_PERSONA_DATA = ${personaData}
_FRAMEWORK_DATA = ${frameworkData}
PERSONAS = MappingProxyType({key: tuple(value) for key, value in _PERSONA_DATA.items()})
FRAMEWORKS = MappingProxyType(dict(_FRAMEWORK_DATA))
ROOT_ALLOWED_CHILDREN = tuple(${rootChildren})


class DispatchError(RuntimeError):
    """Base error for a rejected Autoprompt dispatch."""


class DispatchDenied(DispatchError):
    """The daemon-derived caller is not allowed to create the requested child."""


class UnknownPersona(DispatchError):
    """The requested persona is outside the sealed canonical registry."""


class UnknownFramework(DispatchError):
    """The requested framework is outside the sealed canonical registry."""


@dataclass(frozen=True, slots=True)
class RunBinding:
    """Verified binding to one exact Autoprompt prompt ledger."""

    path: str
    sha256: str
    bytes: int
    nonce: str


def bind(mission_path: str | Path, *, nonce: str) -> RunBinding:
    """Bind a run nonce to the exact current bytes of its prompt ledger."""
    if not isinstance(nonce, str) or not _NONCE_PATTERN.fullmatch(nonce):
        raise ValueError("nonce must be 8-128 safe characters")
    try:
        target = Path(mission_path).expanduser().resolve(strict=True)
        payload = target.read_bytes()
        payload.decode("utf-8")
    except (OSError, UnicodeError, TypeError) as error:
        raise DispatchDenied("mission binding path must be a readable UTF-8 file") from error
    if not payload:
        raise DispatchDenied("mission binding file must not be empty")
    return RunBinding(
        path=str(target),
        sha256=hashlib.sha256(payload).hexdigest(),
        bytes=len(payload),
        nonce=nonce,
    )


def _validated_binding(binding: Any) -> RunBinding:
    if not isinstance(binding, RunBinding):
        raise DispatchDenied("mission binding must come from autoprompt.bind()")
    if not _NONCE_PATTERN.fullmatch(binding.nonce):
        raise DispatchDenied("mission binding contains an invalid nonce")
    try:
        target = Path(binding.path)
        resolved = target.resolve(strict=True)
        if not target.is_absolute() or resolved != target:
            raise DispatchDenied("mission binding path is not canonical")
        payload = resolved.read_bytes()
        payload.decode("utf-8")
    except DispatchDenied:
        raise
    except (OSError, UnicodeError, TypeError) as error:
        raise DispatchDenied("mission binding path must remain a readable UTF-8 file") from error
    digest = hashlib.sha256(payload).hexdigest()
    if not payload or len(payload) != binding.bytes or digest != binding.sha256:
        raise DispatchDenied("mission binding no longer matches the exact prompt ledger")
    return binding


def _canonical_role(session_name: Any) -> str:
    if not isinstance(session_name, str):
        raise DispatchDenied("daemon identity has no valid session name")
    if session_name in PERSONAS:
        return session_name
    for persona in PERSONAS:
        prefix = f"{persona}--"
        if session_name.startswith(prefix) and _INSTANCE_PATTERN.fullmatch(session_name[len(prefix):]):
            return persona
    raise DispatchDenied(f"daemon identity is not an allowlisted Autoprompt persona: {session_name!r}")


def _validated_identity(roster: Any) -> tuple[str | None, int]:
    if not isinstance(roster, dict):
        raise DispatchDenied("daemon roster is unavailable or malformed")
    current = roster.get("current")
    entries = roster.get("entries")
    if not isinstance(current, dict) or not isinstance(entries, list):
        raise DispatchDenied("daemon roster is unavailable or malformed")
    depth = current.get("depth")
    if isinstance(depth, bool) or not isinstance(depth, int) or depth < 0 or depth > MAX_DEPTH:
        raise DispatchDenied("daemon roster reports an invalid depth")
    if not isinstance(current.get("id"), str) or not current["id"]:
        raise DispatchDenied("daemon roster reports an invalid current id")

    parents = [entry for entry in entries if isinstance(entry, dict) and entry.get("relationship") == "parent"]
    if depth == 0:
        if parents:
            raise DispatchDenied("daemon root unexpectedly reports a parent edge")
        root_name = current.get("name")
        if isinstance(root_name, str) and root_name.startswith("ap-"):
            root_role = _canonical_role(root_name)
            if not PERSONAS[root_role]:
                raise DispatchDenied(f"terminal role {root_role} cannot dispatch children from root depth")
            raise DispatchDenied(f"Autoprompt persona {root_role} cannot occupy daemon root depth")
        return None, depth

    current_role = _canonical_role(current.get("name"))
    if len(parents) != 1:
        raise DispatchDenied("daemon roster must contain exactly one parent edge")
    parent = parents[0]
    if parent.get("depth") != depth - 1 or not isinstance(parent.get("id"), str) or not parent["id"]:
        raise DispatchDenied("daemon roster contains an invalid parent edge")

    if depth == 1:
        if current_role not in ROOT_ALLOWED_CHILDREN:
            raise DispatchDenied(f"parent edge from root to {current_role} is not allowlisted")
    else:
        parent_role = _canonical_role(parent.get("name"))
        if current_role not in PERSONAS[parent_role]:
            raise DispatchDenied(f"parent edge {parent_role} -> {current_role} is not allowlisted")
    return current_role, depth


def _child_name(persona: str, instance: str | None) -> str:
    if instance is None:
        return persona
    if not isinstance(instance, str) or not _INSTANCE_PATTERN.fullmatch(instance):
        raise ValueError("instance must match ^[a-z0-9][a-z0-9-]{0,23}$")
    name = f"{persona}--{instance}"
    if len(name) > 64:
        raise ValueError("Prime Agent child session name must be at most 64 characters")
    return name


def _framework_text(framework: str | None) -> str:
    if framework is None:
        return ""
    relative_path = FRAMEWORKS.get(framework)
    if relative_path is None:
        raise UnknownFramework(f"unknown Autoprompt framework: {framework!r}")
    target = _PACKAGE_ROOT.joinpath(*relative_path.split("/"))
    try:
        return target.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise DispatchError(f"installed framework is unavailable: {framework}") from error


def _sealed_prompt(
    persona: str,
    task: str,
    framework: str | None,
    parent_depth: int,
    binding: RunBinding,
) -> str:
    framework_text = _framework_text(framework)
    framework_id = framework if framework is not None else "none"
    binding_json = json.dumps(
        {
            "path": binding.path,
            "sha256": binding.sha256,
            "bytes": binding.bytes,
            "nonce": binding.nonce,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "\\n".join(
        [
            "# SEALED AUTOPROMPT DISPATCH ENVELOPE",
            f"AUTOPROMPT-RUN-MARKER: runtime=prime-agent-adapter-v1 nonce={binding.nonce} prompt=sha256:{binding.sha256}",
            f"RUN-NONCE: {binding.nonce}",
            "MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.",
            f"AUTOPROMPT_MISSION_BINDING: {binding_json}",
            f"AUTOPROMPT_BINDING_CALL: autoprompt.bind({json.dumps(binding.path, ensure_ascii=False)}, nonce={json.dumps(binding.nonce)})",
            f"AUTOPROMPT_PERSONA: {persona}",
            f"AUTOPROMPT_FRAMEWORK: {framework_id}",
            f"AUTOPROMPT_RUNTIME_DEPTH: parent={parent_depth} child={parent_depth + 1}",
            "The extension binds the canonical persona prompt by this allowlisted session name.",
            "",
            "## BEGIN SEALED FRAMEWORK",
            framework_text,
            "## END SEALED FRAMEWORK",
            "",
            f"## BEGIN BOUNDED TASK (utf8-bytes={len(task.encode('utf-8'))})",
            task,
            "## END BOUNDED TASK",
        ]
    )


async def _list_roster() -> dict[str, Any]:
    from rlm import host_request

    return await host_request("agent_message.list_agents")


async def _spawn_child(prompt: str, name: str) -> Any:
    from rlm import rlm as prime_rlm

    # Deliberately omit model: Prime Agent 0.7.2 inherits the selected parent model.
    return await prime_rlm(prompt, name=name)


async def dispatch(
    persona: str,
    task: str,
    *,
    binding: RunBinding,
    framework: str | None = None,
    instance: str | None = None,
) -> Any:
    """Validate topology and spawn one native Prime Agent RLM child."""
    if persona not in PERSONAS:
        raise UnknownPersona(f"unknown Autoprompt persona: {persona!r}")
    if not isinstance(task, str) or not task.strip():
        raise ValueError("task must be a non-empty string")
    if framework is not None and framework not in FRAMEWORKS:
        raise UnknownFramework(f"unknown Autoprompt framework: {framework!r}")
    binding = _validated_binding(binding)
    name = _child_name(persona, instance)
    current_role, depth = _validated_identity(await _list_roster())
    if depth >= MAX_DEPTH:
        raise DispatchDenied(f"Autoprompt depth limit reached at depth {depth}")

    if current_role is None:
        allowed = ROOT_ALLOWED_CHILDREN
    else:
        allowed = PERSONAS[current_role]
        if not allowed:
            raise DispatchDenied(f"terminal role {current_role} cannot dispatch children")
    if persona not in allowed:
        caller = "root" if current_role is None else current_role
        raise DispatchDenied(f"child edge {caller} -> {persona} is not allowlisted")

    prompt = _sealed_prompt(persona, task, framework, depth, binding)
    return await _spawn_child(prompt, name)


async def run(
    persona: str,
    task: str,
    *,
    binding: RunBinding,
    framework: str | None = None,
    instance: str | None = None,
) -> Any:
    """Callable-skill alias for :func:\`dispatch\`."""
    return await dispatch(persona, task, binding=binding, framework=framework, instance=instance)
`
}

function renderLegacyOutputs(root = ROOT) {
  const contract = JSON.parse(read('agents/contracts/autoprompt.contract.json', root))
  const inventory = Object.freeze({
    frameworkCount: contract.frameworks.length,
    personaCount: contract.personas.length,
  })
  const outputs = new Map()
  const personaIds = new Set(contract.personas.map(persona => persona.id))
  const personaSources = contract.personas.map(persona => read(persona.source, root))

  for (let index = 0; index < contract.personas.length; index += 1) {
    const persona = contract.personas[index]
    const source = personaSources[index]
    outputs.set(`agents/claude/agents/${persona.id}.md`, source)
    outputs.set(`agents/codex/agents/${persona.id}.toml`, renderCodexAgent(persona, source))
    outputs.set(`agents/opencode/agents/${persona.id}.md`, renderOpencodeAgent(persona, source))
    outputs.set(`agents/kilo/agents/${persona.id}.md`, renderOpencodeAgent(persona, source))
    outputs.set(
      `agents/vscode/agents/${persona.id}.agent.md`,
      renderVsCodeAgent(persona, source, personaIds),
    )
    outputs.set(`agents/prime/personas/${persona.id}.md`, stripFrontmatter(source))
    outputs.set(`agents/omp/agents/${persona.id}.md`, renderOmpAgent(persona, source))
    outputs.set(`agents/deepseek/agents/${persona.id}.md`, renderDeepSeekAgent(persona, source))
    outputs.set(
      `agents/reasonix/skills/${persona.id}/SKILL.md`,
      renderReasonixAgent(persona, source),
    )
  }
  for (const framework of contract.frameworks) {
    const body = read(framework.source, root).replace(/^RUN-NONCE:.*\n+/, '')
    outputs.set(`agents/claude/frameworks/${framework.id}.md`, body)
    outputs.set(`agents/codex/frameworks/${framework.id}.md`, body)
    outputs.set(`agents/opencode/frameworks/${framework.id}.md`, body)
    outputs.set(`agents/kilo/frameworks/${framework.id}.md`, body)
    outputs.set(`agents/vscode/frameworks/${framework.id}.md`, asciiDashes(body))
    outputs.set(`agents/prime/prompts/frameworks/${framework.id}.md`, [
      '---',
      `description: ${yamlDoubleQuoted(`Autoprompt ${framework.id} framework`)}`,
      '---',
      body,
    ].join('\n'))
    outputs.set(`agents/omp/frameworks/${framework.id}.md`, asciiDashes(body))
    outputs.set(`agents/deepseek/frameworks/${framework.id}.md`, asciiDashes(body))
    outputs.set(`agents/reasonix/frameworks/${framework.id}.md`, asciiDashes(body))
  }

  for (const file of ['SKILL.md', 'GATES.md', 'MODES.md', 'PLAYBOOKS.md']) {
    outputs.set(
      `agents/kilo/${file}`,
      renderKiloProviderText(read(`agents/opencode/${file}`, root)),
    )
  }
  outputs.set('agents/kilo/autoprompt.kilo.json', renderKiloProfile())

  for (const file of ['SKILL.md', 'GATES.md', 'MODES.md', 'PLAYBOOKS.md']) {
    outputs.set(
      `agents/vscode/${file}`,
      renderVsCodeProviderText(file, read(`agents/opencode/${file}`, root), contract.providers.vscode),
    )
  }
  outputs.set('agents/vscode/README.md', renderVsCodeReadme(contract.providers.vscode, inventory))

  for (const provider of ['omp', 'deepseek', 'reasonix']) {
    for (const file of ['SKILL.md', 'GATES.md', 'MODES.md', 'PLAYBOOKS.md']) {
      outputs.set(
        `agents/${provider}/${file}`,
        renderInheritedProviderText(file, read(`agents/opencode/${file}`, root), provider),
      )
    }
    outputs.set(`agents/${provider}/README.md`, renderInheritedProviderReadme(provider, inventory))
  }
  outputs.set(
    'agents/deepseek/agent-preset/agent.cordis.yml',
    renderDeepSeekPreset(contract.personas, personaSources),
  )
  outputs.set('agents/deepseek/agent-preset/preset.yml', [
    'name: Autoprompt',
    `description: Useful-first orchestration with ${inventory.personaCount} fixed-persona subagent tools.`,
    '',
  ].join('\n'))
  outputs.set(
    'agents/deepseek/headless.patch.yml',
    renderDeepSeekHeadlessPatch(contract.personas, personaSources),
  )

  const packageVersion = JSON.parse(read('package.json', root)).version
  for (const provider of [
    'claude', 'codex', 'opencode', 'kilo', 'vscode', 'omp', 'deepseek', 'reasonix',
  ]) {
    outputs.set(`agents/${provider}/VERSION`, `${packageVersion}\n`)
  }
  outputs.set('agents/prime/package.json', renderPrimePackage(contract.providers.prime, packageVersion))
  outputs.set('agents/prime/extensions/autoprompt.ts', renderPrimeExtension(contract.personas, contract.frameworks))
  outputs.set(
    'agents/prime/skills/autoprompt/SKILL.md',
    renderPrimeSkill(contract.frameworks, read('agents/contracts/generic.md', root)),
  )
  outputs.set('agents/prime/skills/autoprompt/pyproject.toml', renderPrimePyproject(packageVersion))
  outputs.set(
    'agents/prime/skills/autoprompt/src/autoprompt/__init__.py',
    renderPrimeDispatcher(contract.personas, contract.frameworks),
  )

  return outputs
}

function renderOutputs(root = ROOT) {
  const outputs = renderLegacyOutputs(root)
  for (const relativePath of [...outputs.keys()]) {
    if (relativePath.startsWith('agents/codex/')) outputs.delete(relativePath)
  }
  for (const [relativePath, content] of renderCodexOutputs(root)) outputs.set(relativePath, content)
  return outputs
}

function differingOutputs(outputs, root = ROOT) {
  const differing = []
  for (const [relativePath, expected] of outputs) {
    const target = path.join(root, relativePath)
    const actual = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
      : null
    if (actual !== expected) differing.push(relativePath)
  }
  return differing
}

function run(argv, root = ROOT, io = process) {
  const check = argv.includes('--check')
  const codexOnly = argv.includes('--codex-only')
  if (argv.some(argument => !['--check', '--codex-only'].includes(argument))) {
    io.stderr.write('generate-provider-contracts: only --check and --codex-only are supported\n')
    return 2
  }
  // Codex-first v2 phase: only the validated Codex projection is active. The
  // legacy renderer remains an API for the eight unchanged provider trees.
  const outputs = renderCodexOutputs(root)
  if (!codexOnly) {
    for (const [relativePath, content] of renderSharedFrameworkOutputs(root)) outputs.set(relativePath, content)
  }
  const differing = differingOutputs(outputs, root)
  if (check) {
    if (differing.length) {
      io.stderr.write(`generate-provider-contracts: stale outputs: ${differing.join(', ')}\n`)
      return 1
    }
    io.stdout.write('provider contracts are current\n')
    return 0
  }
  for (const [relativePath, content] of outputs) writeAtomic(relativePath, content, root)
  io.stdout.write(`generated ${outputs.size} provider contract files\n`)
  return 0
}

if (require.main === module) process.exitCode = run(process.argv.slice(2))

module.exports = {
  CODEX_ACTIVATION_SYNTAX,
  codexFrameworkRoutes,
  codexUserFacingLanguageViolations,
  compiledGateDefinitions,
  compiledGateGraphs,
  differingOutputs,
  loadCodexPackageRegistry,
  loadCodexV2Contracts,
  plainLanguageViolations,
  parseCompiledRouteExamples,
  parseFrameworkCompiledGates,
  parseFullCompiledGates,
  providerProjectionPlan,
  renderCodexAgent,
  renderCodexOutputs,
  renderCodexPolicyAgent,
  renderCompiledRouteExamples,
  renderFrameworkCompiledGates,
  renderFullCompiledGates,
  renderKiloProfile,
  renderKiloProviderText,
  renderDeepSeekAgent,
  renderDeepSeekHeadlessPatch,
  renderDeepSeekPreset,
  renderInheritedProviderReadme,
  renderInheritedProviderText,
  renderOmpAgent,
  renderOpencodeAgent,
  renderOutputs,
  renderLegacyOutputs,
  renderPrimeDispatcher,
  renderPrimeExtension,
  renderPrimePackage,
  renderPrimePyproject,
  renderPrimeSkill,
  renderReasonixAgent,
  renderSharedFrameworkOutputs,
  renderVsCodeAgent,
  renderVsCodeProviderText,
  renderVsCodeReadme,
  run,
  validateCodexRolePolicy,
  validateCodexUserFacingLanguage,
  validateCodexViews,
  validateFrameworkReferences,
  validateCanonicalAndSharedPlainLanguage,
  validateCompatibilityAliasContract,
  validateCompiledRouteExamples,
  validateFrameworkGateProjections,
  validateFullCompiledGates,
  validateGeneratedPlainLanguage,
  normalizePlainLanguageMarkdown,
  writeAtomic,
}
