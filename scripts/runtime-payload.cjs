#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  EVIDENCE_SOURCE,
  KEY_RING_SOURCE,
  PROVIDERS_SOURCE,
  codexPayloadClosureDigest,
  deriveCodexDeployCore,
  providerContractCoreSha256,
} = require('./codex-runtime-identity.cjs')

const ROOT = path.resolve(__dirname, '..')
const HASH_PATTERN = /^[a-f0-9]{64}$/
const CODEX_GENERATION_PATTERN = /^codex-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$/
const CODEX_LOGICAL_ROLE_PATTERN = /^ap-[a-z0-9-]+$/
const CODEX_PACKAGE_REGISTRY_PATH = 'scripts/install/codex-package-registry.json'
const PROVIDERS = {
  claude: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'VERSION', 'autoprompt-models.schema.md'],
    agents: 'personas',
    workflow: [
      'agent-definitions-cli.js',
      'autoprompt-gate.js',
      'autoprompt-ledger-check.js',
      'model-casting.js',
      'phase-budget.js',
      'supervisor.ps1',
      'supervisor.sh',
    ],
  },
  codex: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'SKILL.md', 'VERSION'],
    agents: 'codex-v2-policy',
    workflow: 'codex-v2-runtime',
  },
  opencode: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'VERSION', 'autoprompt.opencode.json'],
    agents: 'personas',
    workflow: ['launch-opencode.ps1', 'launch-opencode.sh'],
  },
  prime: {
    topLevel: [
      'extensions/autoprompt.ts',
      'package.json',
      'skills/autoprompt/SKILL.md',
      'skills/autoprompt/pyproject.toml',
      'skills/autoprompt/src/autoprompt/__init__.py',
    ],
    agents: 'prime-personas',
    agentRoot: 'personas',
    frameworkRoot: 'prompts/frameworks',
    workflow: [],
  },
  kilo: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'VERSION', 'autoprompt.kilo.json'],
    agents: 'personas',
    workflow: [],
  },
  vscode: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'README.md', 'SKILL.md', 'VERSION'],
    agents: 'vscode-personas',
    workflow: [],
  },
  omp: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'README.md', 'VERSION'],
    agents: 'personas',
    workflow: [],
  },
  deepseek: {
    topLevel: [
      'GATES.md',
      'MODES.md',
      'PLAYBOOKS.md',
      'README.md',
      'VERSION',
      'agent-preset/agent.cordis.yml',
      'agent-preset/preset.yml',
      'headless.patch.yml',
    ],
    agents: 'personas',
    workflow: [],
  },
  reasonix: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'README.md', 'VERSION'],
    agents: 'reasonix-personas',
    agentRoot: 'skills',
    workflow: [],
  },
}

const CODEX_RUNTIME_EXTENSIONS = new Set(['.js', '.ps1', '.sh'])
const CODEX_RUNTIME_ENTRYPOINTS = Object.freeze([
  'workflow/phase-budget.js',
  'workflow/supervisor.ps1',
  'workflow/supervisor.sh',
])
const CODEX_RUNTIME_DYNAMIC_REQUIRES = Object.freeze([
  Object.freeze({
    requiredFrom: 'workflow/phase-budget.js',
    expression: 'safetyPath',
    source: 'scripts/local-only-safety.cjs',
    kind: 'declared-external-runtime-module',
  }),
])
function loadCodexPackageRegistry(root = ROOT) {
  let registry
  try {
    registry = JSON.parse(fs.readFileSync(path.join(root, ...CODEX_PACKAGE_REGISTRY_PATH.split('/')), 'utf8'))
  } catch (error) {
    throw new Error(`Codex package registry is unreadable: ${error.message}`)
  }
  const install = registry.installation || {}
  if (registry.schemaVersion !== 1 || registry.provider !== 'codex' ||
      !/^\d+\.\d+\.\d+$/.test(registry.compatibility?.cliMinimum || '') ||
      registry.compatibility?.runtimeContract !== '2.0.0' ||
      install.discoveryShimSource !== 'scripts/install/codex-discovery-shim.md' ||
      install.discoveryShimReceipt !== 'skills/autoprompt/SKILL.md' ||
      install.privateBundlesRoot !== '.autoprompt-private/bundles' ||
      install.generatedAgentsRelative !== 'agents-runtime' ||
      install.embeddedManifest !== '.autoprompt-runtime-manifest.json' ||
      !Array.isArray(install.trustArtifacts) ||
      JSON.stringify(install.trustArtifacts) !== JSON.stringify([
        { source: PROVIDERS_SOURCE, destination: 'skills/contracts/providers.json' },
        { source: KEY_RING_SOURCE, destination: 'skills/contracts/codex-trusted-public-keys.json' },
        { source: EVIDENCE_SOURCE, destination: 'skills/contracts/codex-live-conformance-evidence.json' },
      ]) ||
      install.defaultMode !== 'standalone' ||
      JSON.stringify(install.supportedModes) !== JSON.stringify(['standalone']) ||
      !Array.isArray(install.sourceExclusions) || !install.sourceExclusions.length ||
      new Set(install.sourceExclusions).size !== install.sourceExclusions.length ||
      install.sourceExclusions.some(file => typeof file !== 'string' || !file ||
        path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..'))) {
    throw new Error('Codex package registry is invalid')
  }
  return Object.freeze(registry)
}

const CODEX_PACKAGE_REGISTRY = loadCodexPackageRegistry(ROOT)
const CODEX_EMBEDDED_MANIFEST = CODEX_PACKAGE_REGISTRY.installation.embeddedManifest
const CODEX_DISCOVERY_SHIM = CODEX_PACKAGE_REGISTRY.installation.discoveryShimSource
const CODEX_PRIVATE_BUNDLES = CODEX_PACKAGE_REGISTRY.installation.privateBundlesRoot

function physicalProviderRole(logicalRole, payloadGeneration) {
  if (!CODEX_LOGICAL_ROLE_PATTERN.test(logicalRole || '') ||
      !CODEX_GENERATION_PATTERN.test(payloadGeneration || '')) {
    throw new Error('codex-runtime-role-projection-invalid')
  }
  return `autoprompt-${payloadGeneration.replace(/[^a-z0-9]+/g, '-')}-${logicalRole}`
}

function codexRoleProjection(logicalRoles, payloadGeneration) {
  const sortedLogicalRoles = Array.isArray(logicalRoles) ? [...logicalRoles].sort() : []
  if (!CODEX_GENERATION_PATTERN.test(payloadGeneration || '') ||
      sortedLogicalRoles.length === 0 ||
      new Set(sortedLogicalRoles).size !== sortedLogicalRoles.length ||
      sortedLogicalRoles.some((role, index) =>
        !CODEX_LOGICAL_ROLE_PATTERN.test(role) || role !== logicalRoles[index])) {
    throw new Error('codex-runtime-role-projection-invalid')
  }
  const logicalToPhysicalProviderRole = Object.fromEntries(sortedLogicalRoles.map(role => [
    role, physicalProviderRole(role, payloadGeneration),
  ]))
  return {
    schemaVersion: 1,
    payloadGeneration,
    logicalRoles: sortedLogicalRoles,
    logicalToPhysicalProviderRole,
    physicalRoles: Object.values(logicalToPhysicalProviderRole).sort(),
  }
}

function validateCodexRoleProjection(manifest, expectedLogicalRoles = null) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      !CODEX_GENERATION_PATTERN.test(manifest.payloadGeneration || '')) {
    throw new Error('codex-runtime-role-projection-invalid')
  }
  const logicalRoles = manifest.logicalRoles
  if (!Array.isArray(logicalRoles) || logicalRoles.length === 0 ||
      new Set(logicalRoles).size !== logicalRoles.length ||
      logicalRoles.some((role, index) =>
        !CODEX_LOGICAL_ROLE_PATTERN.test(role) ||
        role !== [...logicalRoles].sort()[index])) {
    throw new Error('codex-runtime-logical-role-inventory-invalid')
  }
  if (expectedLogicalRoles &&
      JSON.stringify(logicalRoles) !== JSON.stringify([...expectedLogicalRoles].sort())) {
    throw new Error('codex-runtime-logical-role-inventory-mismatch')
  }
  const mapping = manifest.logicalToPhysicalProviderRole
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
      JSON.stringify(Object.keys(mapping)) !== JSON.stringify(logicalRoles)) {
    throw new Error('codex-runtime-role-alias-map-invalid')
  }
  for (const logicalRole of logicalRoles) {
    if (mapping[logicalRole] !== physicalProviderRole(logicalRole, manifest.payloadGeneration)) {
      throw new Error('codex-runtime-role-projection-generation-mismatch')
    }
  }
  const physicalRoles = Object.values(mapping).sort()
  if (!Array.isArray(manifest.physicalRoles) ||
      JSON.stringify(manifest.physicalRoles) !== JSON.stringify(physicalRoles) ||
      new Set(physicalRoles).size !== physicalRoles.length) {
    throw new Error('codex-runtime-physical-role-inventory-mismatch')
  }
  return {
    schemaVersion: 1,
    payloadGeneration: manifest.payloadGeneration,
    logicalRoles: [...logicalRoles],
    logicalToPhysicalProviderRole: { ...mapping },
    physicalRoles,
  }
}

function discoverCodexExternalRuntimeDependencies(root = ROOT) {
  const sourceRoot = path.join(root, 'agents', 'codex')
  const workflowDirectory = path.join(sourceRoot, 'workflow')
  const bySource = new Map()
  function addDependency(source, destination, site) {
    if (!source.startsWith('agents/contracts/') || !destination.startsWith('skills/contracts/')) {
      throw new Error(`Codex runtime contract dependency escapes the contract roots: ${source} -> ${destination}`)
    }
    const existing = bySource.get(source)
    if (existing && existing.destination !== destination) {
      throw new Error(`Codex runtime contract has conflicting destinations: ${source}`)
    }
    const record = existing || { source, destination, requiredBy: [] }
    const siteKey = JSON.stringify(site)
    if (!record.requiredBy.some(candidate => JSON.stringify(candidate) === siteKey)) record.requiredBy.push(site)
    bySource.set(source, record)
  }
  const trustSources = new Set(CODEX_PACKAGE_REGISTRY.installation.trustArtifacts
    .map(artifact => artifact.source))
  for (const artifact of CODEX_PACKAGE_REGISTRY.installation.trustArtifacts) {
    addDependency(artifact.source, artifact.destination, {
      kind: 'trust-material',
      requiredFrom: CODEX_PACKAGE_REGISTRY_PATH,
      runtimeRequest: artifact.source,
    })
  }
  const workflowFiles = fs.readdirSync(workflowDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => `workflow/${entry.name}`)
    .sort()
  for (const requiredFrom of workflowFiles) {
    const sourcePath = path.join(sourceRoot, ...requiredFrom.split('/'))
    const runtimeSource = fs.readFileSync(sourcePath, 'utf8')
    for (const argument of runtimeRequireArguments(runtimeSource)) {
      const literal = /^(['"])([^'"]+)\1$/.exec(argument)
      if (!literal || !literal[2].startsWith('.')) continue
      const runtimeRequest = literal[2]
      const dependency = resolveLocalRequire(sourcePath, runtimeRequest)
      const source = path.relative(root, dependency).split(path.sep).join('/')
      if (!source.startsWith('agents/contracts/')) continue
      if (!source.endsWith('.json') || !fs.existsSync(dependency) || !fs.statSync(dependency).isFile()) {
        throw new Error(`Codex runtime contract dependency is not a package JSON file: ${requiredFrom} -> ${source}`)
      }
      const destination = path.posix.normalize(path.posix.join(
        'skills/autoprompt',
        path.posix.dirname(requiredFrom),
        runtimeRequest,
      ))
      if (!destination.startsWith('skills/contracts/')) {
        throw new Error(`Codex runtime contract destination is outside skills/contracts: ${requiredFrom} -> ${destination}`)
      }
      addDependency(source, destination, { kind: 'runtime-require', requiredFrom, runtimeRequest })
    }
    const resolvedPathPattern = /\bpath\.resolve\(\s*__dirname((?:\s*,\s*(['"])[^'"]+\2)+)\s*\)/g
    for (const match of runtimeSource.matchAll(resolvedPathPattern)) {
      const segments = [...match[1].matchAll(/(['"])([^'"]+)\1/g)].map(segment => segment[2])
      const dependency = path.resolve(path.dirname(sourcePath), ...segments)
      const source = path.relative(root, dependency).split(path.sep).join('/')
      if (!source.startsWith('agents/contracts/')) continue
      if (!source.endsWith('.json') || !fs.existsSync(dependency) || !fs.statSync(dependency).isFile()) {
        throw new Error(`Codex runtime resolved contract dependency is not a package JSON file: ${requiredFrom} -> ${source}`)
      }
      const destination = source.replace(/^agents\//, 'skills/')
      const requiringDestination = path.posix.join('skills/autoprompt', requiredFrom)
      const runtimeRequest = path.posix.relative(path.posix.dirname(requiringDestination), destination)
      addDependency(source, destination, { kind: 'runtime-path-resolution', requiredFrom, runtimeRequest })
    }
  }
  const scanned = new Set()
  for (const source of bySource.keys()) {
    if (scanned.has(source)) continue
    scanned.add(source)
    let document
    const sourceFile = path.join(root, ...source.split('/'))
    if (!fs.existsSync(sourceFile) && trustSources.has(source)) continue
    try {
      document = JSON.parse(fs.readFileSync(sourceFile, 'utf8'))
    } catch (error) {
      throw new Error(`Codex runtime contract dependency is invalid JSON: ${source}: ${error.message}`)
    }
    const references = []
    function collectReferences(value) {
      if (Array.isArray(value)) {
        value.forEach(collectReferences)
        return
      }
      if (value && typeof value === 'object') {
        Object.values(value).forEach(collectReferences)
        return
      }
      if (typeof value !== 'string') return
      const withoutFragment = value.split('#')[0]
      if (!withoutFragment.endsWith('.json')) return
      let referencedSource
      if (withoutFragment.startsWith('agents/contracts/')) {
        referencedSource = path.posix.normalize(withoutFragment)
      } else if (withoutFragment.startsWith('.')) {
        referencedSource = path.posix.normalize(path.posix.join(path.posix.dirname(source), withoutFragment))
      }
      if ((withoutFragment.startsWith('agents/') || withoutFragment.startsWith('.')) &&
          (!referencedSource || !referencedSource.startsWith('agents/contracts/'))) {
        throw new Error(`Codex runtime contract reference escapes agents/contracts: ${source} -> ${value}`)
      }
      if (referencedSource && referencedSource.startsWith('agents/contracts/')) {
        references.push({ referencedSource, runtimeRequest: value })
      }
    }
    collectReferences(document)
    for (const reference of references) {
      const referencedPath = path.join(root, ...reference.referencedSource.split('/'))
      if (!fs.existsSync(referencedPath) || !fs.statSync(referencedPath).isFile()) {
        throw new Error(`Codex runtime contract reference is missing: ${source} -> ${reference.referencedSource}`)
      }
      addDependency(
        reference.referencedSource,
        reference.referencedSource.replace(/^agents\//, 'skills/'),
        {
          kind: 'contract-reference',
          requiredFrom: source,
          runtimeRequest: reference.runtimeRequest,
        },
      )
    }
  }
  const dependencies = [...bySource.values()].map(dependency => {
    dependency.requiredBy.sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.requiredFrom.localeCompare(right.requiredFrom) ||
        left.runtimeRequest.localeCompare(right.runtimeRequest))
    const runtimeSite = dependency.requiredBy.find(site =>
      site.kind === 'runtime-require' || site.kind === 'runtime-path-resolution')
    const primary = runtimeSite || dependency.requiredBy[0]
    return Object.freeze({
      source: dependency.source,
      destination: dependency.destination,
      requiredFrom: primary.requiredFrom,
      runtimeRequest: primary.runtimeRequest,
      requiredBy: Object.freeze(dependency.requiredBy.map(site => Object.freeze({ ...site }))),
      kind: runtimeSite
        ? (runtimeSite.kind === 'runtime-require' ? 'static-require' : 'runtime-path-resolution')
        : 'contract-reference',
    })
  })
  dependencies.push(Object.freeze({
    source: 'scripts/local-only-safety.cjs',
    destination: 'scripts/local-only-safety.cjs',
    requiredFrom: 'workflow/phase-budget.js',
    runtimeRequest: '../../../scripts/local-only-safety.cjs',
    requiredBy: Object.freeze([Object.freeze({
      kind: 'dynamic-runtime-require',
      requiredFrom: 'workflow/phase-budget.js',
      runtimeRequest: '../../../scripts/local-only-safety.cjs',
    })]),
    kind: 'dynamic-safety-module',
  }))
  dependencies.sort((left, right) => left.source.localeCompare(right.source))
  return Object.freeze(dependencies)
}

const CODEX_EXTERNAL_RUNTIME_DEPENDENCIES = discoverCodexExternalRuntimeDependencies(ROOT)

function canonicalBytes(filePath) {
  const bytes = fs.readFileSync(filePath)
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(canonicalBytes(filePath)).digest('hex')
}

function exactBytes(filePath) {
  return fs.readFileSync(filePath)
}

function exactSha256(filePath) {
  return crypto.createHash('sha256').update(exactBytes(filePath)).digest('hex')
}

function payloadBytes(provider, filePath) {
  return provider === 'codex' ? exactBytes(filePath) : canonicalBytes(filePath)
}

function payloadSha256(provider, filePath) {
  return provider === 'codex' ? exactSha256(filePath) : sha256(filePath)
}

function runtimeFiles(provider, root = ROOT) {
  const definition = PROVIDERS[provider]
  if (provider === 'codex') return codexRuntimeFiles(root)
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'contracts', 'autoprompt.contract.json'), 'utf8'))
  const files = [...definition.topLevel]
  const frameworkRoot = definition.frameworkRoot || 'frameworks'
  files.push(...contract.frameworks.map(framework => `${frameworkRoot}/${framework.id}.md`))
  const agents = definition.agents === 'personas'
    ? contract.personas.map(persona => `${persona.id}.md`)
    : definition.agents === 'codex-personas'
      ? ['openai.yaml', ...contract.personas.map(persona => `${persona.id}.toml`)]
      : definition.agents === 'vscode-personas'
        ? contract.personas.map(persona => `${persona.id}.agent.md`)
        : definition.agents === 'prime-personas'
          ? contract.personas.map(persona => `${persona.id}.md`)
          : definition.agents === 'reasonix-personas'
            ? contract.personas.map(persona => `${persona.id}/SKILL.md`)
            : definition.agents
  const agentRoot = definition.agentRoot || 'agents'
  files.push(...agents.map(agent => `${agentRoot}/${agent}`))
  files.push(...definition.workflow.map(file => `workflow/${file}`))
  return files.sort()
}

function assertCodexSourceClosure(root, runtimeFiles) {
  const sourceRoot = path.join(root, 'agents', 'codex')
  const allSourceFiles = allFilesBelow(sourceRoot)
    .map(file => file.replace(/^\/+/, '').replaceAll('\\', '/')).sort()
  const expectedSourceFiles = [...new Set([
    ...runtimeFiles,
    ...CODEX_PACKAGE_REGISTRY.installation.sourceExclusions,
  ])].sort()
  if (JSON.stringify(allSourceFiles) !== JSON.stringify(expectedSourceFiles)) {
    const unexpected = allSourceFiles.filter(file => !expectedSourceFiles.includes(file))
    const missing = expectedSourceFiles.filter(file => !allSourceFiles.includes(file))
    throw new Error(`Codex source closure mismatch: unexpected=${unexpected.join(',') || 'none'} missing=${missing.join(',') || 'none'}`)
  }
  return true
}

function codexRuntimeFiles(root = ROOT) {
  const { loadCodexV2Contracts } = require('./generate-provider-contracts.cjs')
  const contracts = loadCodexV2Contracts(root)
  const definition = PROVIDERS.codex
  const files = [...definition.topLevel]

  const frameworkDirectory = path.join(root, 'agents', 'codex', 'frameworks')
  const frameworks = fs.readdirSync(frameworkDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => `frameworks/${entry.name}`)
  files.push(...frameworks)

  files.push('agents/openai.yaml', 'agents/role-policy.json', 'agents/role-policy.schema.json')
  files.push(...Object.keys(contracts.rolePolicy.physical_roles).map(role => `agents/${role}.toml`))

  const workflowDirectory = path.join(root, 'agents', 'codex', 'workflow')
  const workflow = fs.readdirSync(workflowDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && CODEX_RUNTIME_EXTENSIONS.has(path.extname(entry.name)))
    .map(entry => `workflow/${entry.name}`)
  files.push(...workflow)

  const sorted = [...new Set(files)].sort()
  assertCodexSourceClosure(root, sorted)
  validateDeclaredRuntimeRequires(
    sorted,
    root,
    discoverCodexExternalRuntimeDependencies(root),
    CODEX_RUNTIME_DYNAMIC_REQUIRES,
  )
  return sorted
}

function resolveLocalRequire(sourcePath, request) {
  const requested = path.resolve(path.dirname(sourcePath), request)
  for (const candidate of [requested, `${requested}.js`, path.join(requested, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return requested
}

function runtimeRequireArguments(source) {
  const calls = []
  const pattern = /\brequire\s*\(/g
  for (const match of source.matchAll(pattern)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1
    if (source.slice(lineStart, match.index).trimStart().startsWith('//')) continue
    const open = source.indexOf('(', match.index)
    let depth = 1
    let quote = null
    let escaped = false
    let cursor = open + 1
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor]
      if (quote) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === quote) quote = null
        continue
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character
        continue
      }
      if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (depth !== 0) throw new Error('unterminated require() in Codex runtime source')
    calls.push(source.slice(open + 1, cursor).trim())
  }
  return calls
}

function validateDeclaredRuntimeRequires(
  files,
  root = ROOT,
  externalDependencies = null,
  dynamicRequires = CODEX_RUNTIME_DYNAMIC_REQUIRES,
) {
  if (externalDependencies === null) externalDependencies = discoverCodexExternalRuntimeDependencies(root)
  const sourceRoot = path.join(root, 'agents', 'codex')
  const declared = new Set(files)
  const declaredExternal = new Set(externalDependencies.map(dependency => dependency.source))
  const discoveredExternal = discoverCodexExternalRuntimeDependencies(root)
  for (const dependency of discoveredExternal) {
    const declaration = externalDependencies.find(candidate => candidate.source === dependency.source)
    if (!declaration) {
      throw new Error(`undeclared external Codex runtime dependency: ${dependency.source}`)
    }
    for (const field of ['destination', 'requiredFrom', 'runtimeRequest', 'kind']) {
      if (declaration[field] !== dependency[field]) {
        throw new Error(`external Codex runtime dependency ${field} mismatch: ${dependency.source}`)
      }
    }
    if (JSON.stringify(declaration.requiredBy) !== JSON.stringify(dependency.requiredBy)) {
      throw new Error(`external Codex runtime dependency require-site mismatch: ${dependency.source}`)
    }
  }
  for (const dependency of externalDependencies) {
    if (!discoveredExternal.some(candidate => candidate.source === dependency.source)) {
      throw new Error(`stale external Codex runtime dependency: ${dependency.source}`)
    }
  }
  const declaredDynamic = new Map(dynamicRequires.map(dependency => [
    `${dependency.requiredFrom}\0${dependency.expression}`,
    dependency,
  ]))
  const observedDynamic = new Set()
  for (const relativePath of files.filter(file => file.startsWith('workflow/') && file.endsWith('.js'))) {
    const sourcePath = path.join(sourceRoot, ...relativePath.split('/'))
    const source = fs.readFileSync(sourcePath, 'utf8')
    for (const argument of runtimeRequireArguments(source)) {
      const literal = /^(['"])([^'"]+)\1$/.exec(argument)
      if (!literal) {
        const key = `${relativePath}\0${argument.replace(/\s+/g, '')}`
        const declaration = declaredDynamic.get(key)
        if (!declaration) {
          throw new Error(`undeclared dynamic Codex runtime require: ${relativePath} -> ${argument || '<empty>'}`)
        }
        if (declaration.kind === 'declared-external-runtime-module' &&
            !declaredExternal.has(declaration.source)) {
          throw new Error(`dynamic Codex runtime require lacks external dependency: ${relativePath} -> ${declaration.source}`)
        }
        observedDynamic.add(key)
        continue
      }
      const request = literal[2]
      if (request.startsWith('node:')) continue
      if (!request.startsWith('.')) {
        throw new Error(`undeclared package Codex runtime require: ${relativePath} -> ${request}`)
      }
      const dependency = resolveLocalRequire(sourcePath, request)
      const relativeDependency = path.relative(sourceRoot, dependency).split(path.sep).join('/')
      if (relativeDependency.startsWith('../') || path.isAbsolute(relativeDependency)) {
        const repositoryRelative = path.relative(root, dependency).split(path.sep).join('/')
        if (!declaredExternal.has(repositoryRelative)) {
          throw new Error(`undeclared external Codex runtime require: ${relativePath} -> ${repositoryRelative}`)
        }
        continue
      }
      if (!declared.has(relativeDependency)) {
        throw new Error(`undeclared Codex runtime require: ${relativePath} -> ${relativeDependency}`)
      }
    }
  }
  for (const key of declaredDynamic.keys()) {
    if (!observedDynamic.has(key)) {
      const declaration = declaredDynamic.get(key)
      throw new Error(`stale dynamic Codex runtime declaration: ${declaration.requiredFrom} -> ${declaration.expression}`)
    }
  }
  return true
}

function renderManifest(provider, root = ROOT) {
  const files = runtimeFiles(provider, root)
  const hashes = {}
  for (const relativePath of files) {
    hashes[relativePath] = payloadSha256(provider, path.join(root, 'agents', provider, relativePath))
  }
  const manifest = {
    schemaVersion: 1,
    provider,
    sourceRoot: `agents/${provider}`,
    files,
    sha256: hashes,
  }
  if (provider === 'codex') {
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'codex', 'agents', 'role-policy.json'), 'utf8'))
    manifest.contractVersion = policy.policy_version
    manifest.rolePolicy = 'agents/role-policy.json'
    manifest.logicalRoles = Object.keys(policy.physical_roles).sort()
    manifest.entrypoints = CODEX_RUNTIME_ENTRYPOINTS
    manifest.externalDependencies = discoverCodexExternalRuntimeDependencies(root).map(dependency => ({
      ...dependency,
      sha256: exactSha256(path.join(root, ...dependency.source.split('/'))),
    }))
    manifest.dynamicRequires = CODEX_RUNTIME_DYNAMIC_REQUIRES
    manifest.localRequireClosure = 'complete-declared-local-external-and-dynamic-requires'
    const providerRegistry = JSON.parse(fs.readFileSync(
      path.join(root, ...PROVIDERS_SOURCE.split('/')), 'utf8',
    ))
    manifest.providerContractCoreSha256 = providerContractCoreSha256(providerRegistry)
    const deployCore = deriveCodexDeployCore(manifest, { providerRegistry })
    manifest.payloadDigest = deployCore.payloadDigest
    manifest.payloadGeneration = deployCore.payloadGeneration
    const roleProjection = codexRoleProjection(manifest.logicalRoles, manifest.payloadGeneration)
    manifest.logicalToPhysicalProviderRole = roleProjection.logicalToPhysicalProviderRole
    manifest.physicalRoles = roleProjection.physicalRoles
    manifest.embeddedReceipt = CODEX_EMBEDDED_MANIFEST
    manifest.payloadClosureDigest = codexPayloadClosureDigest(manifest)
  }
  return manifest
}

function codexPayloadDigest(manifest) {
  return deriveCodexDeployCore(manifest).payloadDigest
}

function renderManifests(root = ROOT) {
  return new Map(Object.keys(PROVIDERS).map(provider => [
    `agents/manifests/${provider}-runtime.json`,
    renderManifest(provider, root),
  ]))
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function writeAtomic(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, filePath)
}

function validateRelativePath(relativePath) {
  const hasControlCharacter = typeof relativePath === 'string' &&
    [...relativePath].some(character => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  if (typeof relativePath !== 'string' || !relativePath ||
      relativePath.includes('\\') || hasControlCharacter) {
    throw new Error(`invalid runtime path: ${relativePath}`)
  }
  const normalized = path.posix.normalize(relativePath)
  if (normalized !== relativePath || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`unsafe runtime path: ${relativePath}`)
  }
}

function isContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function assertWindowsDirectoryAncestorsUnlinked(directory) {
  // path.parse/dirname treat \\?\UNC\ as a root, but it is not a filesystem
  // directory. Start extended UNC walks at the actual server/share instead.
  const extendedUnc = /^(\\\\\?\\UNC\\[^\\]+\\[^\\]+)(?:\\|$)/i.exec(directory)
  const filesystemRoot = extendedUnc ? `${extendedUnc[1]}\\` : path.parse(directory).root
  const ancestors = [filesystemRoot]
  let current = filesystemRoot
  for (const segment of directory.slice(filesystemRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    ancestors.push(current)
  }
  // Check existing prefixes before recursive creation; a missing child does not
  // make an existing ancestor junction safe to traverse.
  for (const ancestor of ancestors) {
    const stats = fs.lstatSync(ancestor, { throwIfNoEntry: false })
    if (!stats) break
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`activation root resolves through a link or unsafe ancestor: ${ancestor}`)
    }
  }
}

function sameUnlinkedWindowsDirectory(root, resolvedRoot, rootStats) {
  const ordinaryFilesystemPath = value => {
    const ordinary = path.normalize(value)
      .replace(/^\\\\\?\\UNC\\/i, '\\\\')
      .replace(/^\\\\\?\\(?=[a-z]:\\)/i, '')
    return /^[a-z]:\\/i.test(ordinary) || /^\\\\(?![?.]\\)[^\\]+\\[^\\]+(?:\\|$)/.test(ordinary)
  }
  if (!ordinaryFilesystemPath(root) || !ordinaryFilesystemPath(resolvedRoot)) return false
  const resolvedStats = fs.lstatSync(resolvedRoot, { bigint: true })
  const currentStats = fs.lstatSync(root, { bigint: true })
  return [rootStats, resolvedStats, currentStats].every(stats =>
    stats.isDirectory() && !stats.isSymbolicLink() &&
    typeof stats.dev === 'bigint' && typeof stats.ino === 'bigint' && stats.ino > 0n &&
    stats.dev === rootStats.dev && stats.ino === rootStats.ino)
}

function assertDirectoryChainUnlinked(root, targetDirectory, create = false) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = path.resolve(targetDirectory)
  if (!isContained(absoluteRoot, absoluteTarget)) {
    throw new Error(`runtime destination escapes activation root: ${absoluteTarget}`)
  }
  if (process.platform === 'win32') assertWindowsDirectoryAncestorsUnlinked(absoluteRoot)
  if (!fs.existsSync(absoluteRoot)) {
    if (!create) throw new Error(`activation root is missing: ${absoluteRoot}`)
    fs.mkdirSync(absoluteRoot, { recursive: true })
  }
  const rootStats = fs.lstatSync(absoluteRoot, { bigint: true })
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`activation root is linked or not a directory: ${absoluteRoot}`)
  }
  const resolvedRoot = fs.realpathSync.native(absoluteRoot)
  if (!sameFilesystemPath(resolvedRoot, absoluteRoot) &&
      (process.platform !== 'win32' || !sameUnlinkedWindowsDirectory(absoluteRoot, resolvedRoot, rootStats))) {
    throw new Error(`activation root resolves through a link: ${absoluteRoot}`)
  }
  const relative = path.relative(absoluteRoot, absoluteTarget)
  let current = absoluteRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) {
      if (!create) throw new Error(`runtime destination directory is missing: ${current}`)
      fs.mkdirSync(current)
    }
    const stats = fs.lstatSync(current)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`runtime destination directory is linked or unsafe: ${current}`)
    }
  }
}

function assertRegularUnlinked(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`)
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`${label} is linked or not a regular file: ${filePath}`)
  }
}

function codexActivationLayout(destination, payloadGeneration) {
  const discoverySkillRoot = path.resolve(destination)
  const skillsRoot = path.dirname(discoverySkillRoot)
  if (path.basename(discoverySkillRoot).toLowerCase() !== 'autoprompt' ||
      path.basename(skillsRoot).toLowerCase() !== 'skills') {
    throw new Error('Codex runtime destination must be <codex-root>/skills/autoprompt')
  }
  const activationRoot = path.dirname(skillsRoot)
  if (!isContained(activationRoot, discoverySkillRoot) || activationRoot === discoverySkillRoot ||
      !CODEX_GENERATION_PATTERN.test(payloadGeneration || '')) {
    throw new Error('Codex runtime destination has an unsafe activation layout')
  }
  const bundleRoot = path.join(
    activationRoot,
    ...CODEX_PRIVATE_BUNDLES.split('/'),
    payloadGeneration,
  )
  const skillRoot = path.join(bundleRoot, 'skills', 'autoprompt')
  if (!isContained(activationRoot, bundleRoot) || !isContained(bundleRoot, skillRoot)) {
    throw new Error('Codex runtime private bundle escapes the activation root')
  }
  return Object.freeze({ activationRoot, bundleRoot, discoverySkillRoot, skillRoot })
}

function installationPlan(provider, destination, root = ROOT) {
  const manifest = loadManifest(provider, root)
  const codexRegistry = provider === 'codex' ? loadCodexPackageRegistry(root) : null
  verifySource(manifest, root)
  const sourceRoot = path.join(root, manifest.sourceRoot)
  const layout = provider === 'codex'
    ? codexActivationLayout(destination, manifest.payloadGeneration)
    : { activationRoot: path.resolve(destination), skillRoot: path.resolve(destination) }
  const plan = manifest.files.map(relativePath => ({
    kind: 'provider-runtime',
    source: path.join(sourceRoot, ...relativePath.split('/')),
    target: path.join(layout.skillRoot, ...relativePath.split('/')),
    receiptPath: path.relative(layout.activationRoot, path.join(layout.skillRoot, ...relativePath.split('/'))).split(path.sep).join('/'),
    sha256: manifest.sha256[relativePath],
  }))
  for (const dependency of manifest.externalDependencies || []) {
    validateRelativePath(dependency.source)
    validateRelativePath(dependency.destination)
    const source = path.join(root, ...dependency.source.split('/'))
    const dependencyRoot = provider === 'codex' ? layout.bundleRoot : layout.activationRoot
    const target = path.join(dependencyRoot, ...dependency.destination.split('/'))
    if (!isContained(root, source)) throw new Error(`external runtime source escapes package root: ${dependency.source}`)
    if (!isContained(dependencyRoot, target) || target === dependencyRoot) {
      throw new Error(`external runtime destination escapes activation root: ${dependency.destination}`)
    }
    const requiredBy = dependency.requiredBy || [{
      requiredFrom: dependency.requiredFrom,
      runtimeRequest: dependency.runtimeRequest,
    }]
    if (!Array.isArray(requiredBy) || requiredBy.length === 0) {
      throw new Error(`external runtime dependency has no require sites: ${dependency.source}`)
    }
    for (const site of requiredBy) {
      validateRelativePath(site.requiredFrom)
      if (site.kind === 'runtime-require' || site.kind === 'runtime-path-resolution' ||
          site.kind === 'dynamic-runtime-require' || !site.kind) {
        const requiringFile = path.join(layout.skillRoot, ...site.requiredFrom.split('/'))
        const resolvedRequest = path.resolve(path.dirname(requiringFile), site.runtimeRequest)
        if (!sameFilesystemPath(resolvedRequest, target)) {
          throw new Error(`external runtime destination does not satisfy ${site.requiredFrom}: ${dependency.destination}`)
        }
        continue
      }
      if (site.kind === 'trust-material') {
        if (site.requiredFrom !== CODEX_PACKAGE_REGISTRY_PATH ||
            site.runtimeRequest !== dependency.source ||
            dependency.destination !== dependency.source.replace(/^agents\//, 'skills/')) {
          throw new Error(`external Codex trust material does not satisfy ${site.requiredFrom}: ${dependency.destination}`)
        }
        continue
      }
      if (site.kind !== 'contract-reference') {
        throw new Error(`external runtime dependency has an unknown require-site kind: ${site.kind}`)
      }
      const reference = site.runtimeRequest.split('#')[0]
      const referencedSource = reference.startsWith('agents/contracts/')
        ? path.posix.normalize(reference)
        : path.posix.normalize(path.posix.join(path.posix.dirname(site.requiredFrom), reference))
      if (referencedSource !== dependency.source ||
          dependency.destination !== dependency.source.replace(/^agents\//, 'skills/')) {
        throw new Error(`external runtime contract reference does not satisfy ${site.requiredFrom}: ${dependency.destination}`)
      }
    }
    plan.push({
      kind: 'external-runtime',
      source,
      target,
      receiptPath: provider === 'codex'
        ? path.relative(layout.activationRoot, target).split(path.sep).join('/')
        : dependency.destination,
      sha256: dependency.sha256,
    })
  }
  if (provider === 'codex') {
    const manifestSource = path.join(root, 'agents', 'manifests', 'codex-runtime.json')
    plan.push({
      kind: 'runtime-manifest',
      source: manifestSource,
      target: path.join(layout.skillRoot, CODEX_EMBEDDED_MANIFEST),
      receiptPath: path.relative(
        layout.activationRoot,
        path.join(layout.skillRoot, CODEX_EMBEDDED_MANIFEST),
      ).split(path.sep).join('/'),
      sha256: exactSha256(manifestSource),
    })
    const discoverySource = path.join(root, ...codexRegistry.installation.discoveryShimSource.split('/'))
    plan.push({
      kind: 'discovery-shim',
      source: discoverySource,
      target: path.join(layout.discoverySkillRoot, 'SKILL.md'),
      receiptPath: codexRegistry.installation.discoveryShimReceipt,
      sha256: exactSha256(discoverySource),
    })
  }
  const receiptPaths = plan.map(item => item.receiptPath)
  if (new Set(receiptPaths).size !== receiptPaths.length) {
    throw new Error(`runtime installation plan has duplicate receipt paths for ${provider}`)
  }
  return Object.freeze({
    activationRoot: layout.activationRoot,
    bundleRoot: layout.bundleRoot || null,
    discoverySkillRoot: layout.discoverySkillRoot || null,
    skillRoot: layout.skillRoot,
    files: Object.freeze(plan.sort((left, right) => left.receiptPath.localeCompare(right.receiptPath))),
    payloadDigest: manifest.payloadDigest || null,
    payloadGeneration: manifest.payloadGeneration || null,
    provider,
  })
}

function loadManifest(provider, root = ROOT) {
  if (!PROVIDERS[provider]) throw new Error(`unknown runtime provider: ${provider}`)
  const manifestPath = path.join(root, 'agents', 'manifests', `${provider}-runtime.json`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.provider !== provider || manifest.sourceRoot !== `agents/${provider}`) {
    throw new Error(`invalid runtime manifest metadata: ${manifestPath}`)
  }
  if (!Array.isArray(manifest.files) || !manifest.sha256 || Array.isArray(manifest.sha256)) {
    throw new Error(`invalid runtime manifest inventory: ${manifestPath}`)
  }
  const sorted = [...manifest.files].sort()
  if (new Set(sorted).size !== sorted.length || sorted.some((file, index) => file !== manifest.files[index])) {
    throw new Error(`runtime manifest files must be unique and sorted: ${manifestPath}`)
  }
  for (const relativePath of manifest.files) validateRelativePath(relativePath)
  if (JSON.stringify(Object.keys(manifest.sha256)) !== JSON.stringify(manifest.files)) {
    throw new Error(`runtime manifest hashes must exactly match files: ${manifestPath}`)
  }
  for (const hash of Object.values(manifest.sha256)) {
    if (!HASH_PATTERN.test(hash)) throw new Error(`invalid runtime SHA-256 in ${manifestPath}`)
  }
  if (provider === 'codex') {
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'codex', 'agents', 'role-policy.json'), 'utf8'))
    const expectedRoles = Object.keys(policy.physical_roles).sort()
    if (manifest.contractVersion !== policy.policy_version || manifest.rolePolicy !== 'agents/role-policy.json' ||
        JSON.stringify(manifest.logicalRoles) !== JSON.stringify(expectedRoles)) {
      throw new Error(`Codex runtime manifest role-policy mismatch: ${manifestPath}`)
    }
    try {
      validateCodexRoleProjection(manifest, expectedRoles)
    } catch (error) {
      throw new Error(`Codex runtime manifest ${error.message}: ${manifestPath}`)
    }
    if (JSON.stringify(manifest.entrypoints) !== JSON.stringify(CODEX_RUNTIME_ENTRYPOINTS) ||
        !manifest.entrypoints.every(entrypoint => manifest.files.includes(entrypoint))) {
      throw new Error(`Codex runtime manifest entrypoint mismatch: ${manifestPath}`)
    }
    const expectedExternal = discoverCodexExternalRuntimeDependencies(root).map(dependency => ({
      ...dependency,
      sha256: exactSha256(path.join(root, ...dependency.source.split('/'))),
    }))
    if (JSON.stringify(manifest.externalDependencies) !== JSON.stringify(expectedExternal)) {
      throw new Error(`Codex runtime manifest external dependency mismatch: ${manifestPath}`)
    }
    if (JSON.stringify(manifest.dynamicRequires) !== JSON.stringify(CODEX_RUNTIME_DYNAMIC_REQUIRES)) {
      throw new Error(`Codex runtime manifest dynamic require mismatch: ${manifestPath}`)
    }
    if (manifest.localRequireClosure !== 'complete-declared-local-external-and-dynamic-requires') {
      throw new Error(`Codex runtime manifest has no require-closure proof: ${manifestPath}`)
    }
    const providerRegistry = JSON.parse(fs.readFileSync(
      path.join(root, ...PROVIDERS_SOURCE.split('/')), 'utf8',
    ))
    const deployCore = deriveCodexDeployCore(manifest, { providerRegistry })
    if (manifest.providerContractCoreSha256 !== deployCore.providerContractCoreSha256 ||
        manifest.payloadGeneration !== deployCore.payloadGeneration ||
        !HASH_PATTERN.test(manifest.payloadDigest || '') ||
        manifest.payloadDigest !== deployCore.payloadDigest ||
        !HASH_PATTERN.test(manifest.payloadClosureDigest || '') ||
        manifest.payloadClosureDigest !== codexPayloadClosureDigest(manifest) ||
        manifest.embeddedReceipt !== CODEX_EMBEDDED_MANIFEST) {
      throw new Error(`Codex runtime manifest generation mismatch: ${manifestPath}`)
    }
    validateDeclaredRuntimeRequires(
      manifest.files,
      root,
      manifest.externalDependencies,
      manifest.dynamicRequires,
    )
  }
  return manifest
}

function verifySource(manifest, root = ROOT) {
  const sourceRoot = path.join(root, manifest.sourceRoot)
  for (const relativePath of manifest.files) {
    const source = path.join(sourceRoot, ...relativePath.split('/'))
    assertDirectoryChainUnlinked(root, path.dirname(source))
    assertRegularUnlinked(source, `runtime source ${relativePath}`)
    if (payloadSha256(manifest.provider, source) !== manifest.sha256[relativePath]) {
      throw new Error(`source hash mismatch: ${relativePath}`)
    }
  }
  for (const dependency of manifest.externalDependencies || []) {
    const source = path.join(root, ...dependency.source.split('/'))
    assertDirectoryChainUnlinked(root, path.dirname(source))
    assertRegularUnlinked(source, `external runtime source ${dependency.source}`)
    if (payloadSha256(manifest.provider, source) !== dependency.sha256) {
      throw new Error(`external source hash mismatch: ${dependency.source}`)
    }
  }
}

function listFiles(directory, prefix) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}/${entry.name}`
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(absolutePath, relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files.sort()
}

function managedFiles(manifest, destination) {
  const topLevel = new Set(manifest.files.map(file => file.split('/')[0]))
  const files = []
  for (const entry of topLevel) {
    const target = path.join(destination, entry)
    if (!fs.existsSync(target)) continue
    const stats = fs.statSync(target)
    if (stats.isFile()) files.push(entry)
    if (stats.isDirectory()) files.push(...listFiles(target, entry))
  }
  return files.sort()
}

function allFilesBelow(directory) {
  if (!fs.existsSync(directory)) return []
  const stats = fs.lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`runtime inventory root is linked or not a directory: ${directory}`)
  }
  return listFiles(directory, '')
    .map(relativePath => relativePath.replace(/^\//, ''))
    .sort()
}

function removeEmptyDirectories(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name))
  }
  if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
}

function prunePayload(provider, destination, root = ROOT) {
  if (provider === 'codex') {
    // Codex bundles are immutable and generation-qualified. Installer receipt
    // reconciliation owns retirement of prior generations and preserves drift.
    installationPlan(provider, destination, root)
    return []
  }
  const manifest = loadManifest(provider, root)
  const expected = new Set(manifest.files)
  const removed = []
  for (const relativePath of managedFiles(manifest, destination)) {
    if (expected.has(relativePath)) continue
    fs.unlinkSync(path.join(destination, ...relativePath.split('/')))
    removed.push(relativePath)
  }
  for (const entry of new Set(manifest.files.map(file => file.split('/')[0]))) {
    const target = path.join(destination, entry)
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) removeEmptyDirectories(target)
  }
  return removed
}

function installPayload(provider, destination, root = ROOT) {
  const manifest = loadManifest(provider, root)
  verifySource(manifest, root)
  const plan = installationPlan(provider, destination, root)
  assertDirectoryChainUnlinked(plan.activationRoot, plan.skillRoot, true)
  if (provider !== 'codex') prunePayload(provider, destination, root)
  for (const item of plan.files) {
    assertRegularUnlinked(item.source, `${item.kind} source`)
    assertDirectoryChainUnlinked(plan.activationRoot, path.dirname(item.target), true)
    if (fs.existsSync(item.target)) {
      const targetStats = fs.lstatSync(item.target)
      if (!targetStats.isFile() || targetStats.isSymbolicLink() || targetStats.nlink !== 1) {
        throw new Error(`runtime target is linked or not a regular file: ${item.receiptPath}`)
      }
      if (provider === 'codex' && item.kind !== 'discovery-shim') {
        if (payloadSha256(provider, item.target) !== item.sha256) {
          throw new Error(`immutable Codex bundle drift: ${item.receiptPath}`)
        }
        continue
      }
    }
    const temporary = `${item.target}.tmp-${process.pid}`
    fs.writeFileSync(temporary, payloadBytes(provider, item.source), { flag: 'wx' })
    try {
      fs.renameSync(temporary, item.target)
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      throw error
    }
    if (payloadSha256(provider, item.target) !== item.sha256) {
      throw new Error(`installed hash mismatch after copy: ${item.receiptPath}`)
    }
  }
  for (const entry of new Set(manifest.files.map(file => file.split('/')[0]))) {
    const target = path.join(destination, entry)
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) removeEmptyDirectories(target)
  }
  verifyPayload(provider, destination, root)
  return plan.files.map(item => item.target)
}

function verifyPayload(provider, destination, root = ROOT) {
  const manifest = loadManifest(provider, root)
  verifySource(manifest, root)
  const plan = installationPlan(provider, destination, root)
  assertDirectoryChainUnlinked(plan.activationRoot, plan.skillRoot)
  if (provider === 'codex') {
    const marker = plan.files.find(item => item.kind === 'runtime-manifest')
    let installed
    try {
      assertRegularUnlinked(marker.target, 'installed Codex runtime generation receipt')
      installed = JSON.parse(fs.readFileSync(marker.target, 'utf8'))
    } catch (error) {
      throw new Error(`installed Codex payload generation is unreadable: ${error.message}`)
    }
    if (installed.provider !== 'codex' ||
        installed.payloadGeneration !== manifest.payloadGeneration ||
        installed.payloadDigest !== manifest.payloadDigest) {
      throw new Error(
        `installed Codex payload generation mismatch: expected ${manifest.payloadGeneration} ` +
        `(${manifest.payloadDigest}), received ${installed.payloadGeneration || 'unknown'} ` +
        `(${installed.payloadDigest || 'unknown'})`,
      )
    }
  }
  const expected = new Set(manifest.files)
  for (const item of plan.files) {
    assertDirectoryChainUnlinked(plan.activationRoot, path.dirname(item.target))
    if (!fs.existsSync(item.target)) {
      throw new Error(`missing runtime file: ${item.receiptPath}`)
    }
    const targetStats = fs.lstatSync(item.target)
    if (!targetStats.isFile() || targetStats.isSymbolicLink() || targetStats.nlink !== 1) {
      throw new Error(`installed runtime file is linked or unsafe: ${item.receiptPath}`)
    }
    if (payloadSha256(provider, item.target) !== item.sha256) {
      throw new Error(`installed hash mismatch: ${item.receiptPath}`)
    }
  }
  if (provider === 'codex') {
    const expectedBundleFiles = new Set(plan.files
      .filter(item => item.kind !== 'discovery-shim')
      .map(item => path.relative(plan.bundleRoot, item.target).split(path.sep).join('/')))
    const installedBundleFiles = allFilesBelow(plan.bundleRoot)
    const installedBundleSet = new Set(installedBundleFiles)
    const generatedAgentFiles = [
      ...manifest.logicalRoles.map(role => `skills/autoprompt/agents-runtime/${role}.toml`),
      'skills/autoprompt/agents-runtime/.autoprompt-casting.json',
    ]
    if (installedBundleFiles.some(relativePath =>
      relativePath.startsWith('skills/autoprompt/agents-runtime/'))) {
      for (const relativePath of generatedAgentFiles) {
        if (!installedBundleSet.has(relativePath)) {
          throw new Error(`missing generated Codex bundle file: ${relativePath}`)
        }
        expectedBundleFiles.add(relativePath)
      }
    }
    for (const relativePath of installedBundleFiles) {
      if (!expectedBundleFiles.has(relativePath)) {
        throw new Error(`unexpected immutable Codex bundle file: ${relativePath}`)
      }
    }
    const ambientFiles = allFilesBelow(plan.discoverySkillRoot)
    if (JSON.stringify(ambientFiles) !== JSON.stringify(['SKILL.md'])) {
      throw new Error(`unexpected ambient Codex discovery file: ${ambientFiles.find(file => file !== 'SKILL.md') || '<missing-shim>'}`)
    }
  } else {
    for (const relativePath of managedFiles(manifest, destination)) {
      if (!expected.has(relativePath)) throw new Error(`unexpected runtime file: ${relativePath}`)
    }
  }
  return { files: plan.files.length, provider }
}

function removeEmptyAncestors(start, stop) {
  let current = path.resolve(start)
  const boundary = path.resolve(stop)
  while (current !== boundary && isContained(boundary, current)) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current)
      continue
    }
    const stats = fs.lstatSync(current)
    if (!stats.isDirectory() || stats.isSymbolicLink() || fs.readdirSync(current).length > 0) return
    fs.rmdirSync(current)
    current = path.dirname(current)
  }
}

function uninstallPayload(provider, destination, root = ROOT) {
  const plan = installationPlan(provider, destination, root)
  assertDirectoryChainUnlinked(plan.activationRoot, plan.activationRoot)
  const removed = []
  const retained = []
  for (const item of [...plan.files].reverse()) {
    if (!fs.existsSync(item.target)) continue
    assertDirectoryChainUnlinked(plan.activationRoot, path.dirname(item.target))
    const stats = fs.lstatSync(item.target)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      retained.push({ path: item.receiptPath, reason: 'linked-or-unsafe' })
      continue
    }
    if (payloadSha256(provider, item.target) !== item.sha256) {
      retained.push({ path: item.receiptPath, reason: 'hash-drift' })
      continue
    }
    fs.unlinkSync(item.target)
    removed.push(item.receiptPath)
    removeEmptyAncestors(path.dirname(item.target), plan.activationRoot)
  }
  return Object.freeze({ provider, removed: removed.sort(), retained: retained.sort((a, b) => a.path.localeCompare(b.path)) })
}

function parseCommand(argv) {
  if (argv.length === 4 && argv[0] === '--capability' && argv[2] === '--mode') {
    return { action: 'capability', provider: argv[1], mode: argv[3] }
  }
  if (argv.length === 1 && ['--check', '--generate'].includes(argv[0])) {
    return { action: argv[0].slice(2) }
  }
  if (argv.length === 2 && ['--check', '--generate'].includes(argv[0])) {
    return { action: argv[0].slice(2), provider: argv[1] }
  }
  if (argv.length === 2 && ['--inventory', '--list'].includes(argv[0])) {
    return { action: argv[0].slice(2), provider: argv[1] }
  }
  if (argv.length === 4 && argv[0] === '--plan' && argv[2] === '--destination') {
    return { action: 'plan', provider: argv[1], destination: path.resolve(argv[3]) }
  }
  if (argv.length === 4 && ['--install', '--verify', '--prune'].includes(argv[0]) && argv[2] === '--destination') {
    return { action: argv[0].slice(2), provider: argv[1], destination: path.resolve(argv[3]) }
  }
  return null
}

function run(argv, root = ROOT, io = process) {
  const command = parseCommand(argv)
  if (!command) {
    io.stderr.write('runtime-payload: usage: --check|--generate [provider] | --capability <provider> --mode <mode> | --inventory <provider> | --list <provider> | --plan|--install|--verify|--prune <provider> --destination <path>\n')
    return 2
  }
  try {
    if (command.action === 'capability') {
      if (command.provider !== 'codex') throw new Error(`unsupported capability provider: ${command.provider}`)
      const supported = CODEX_PACKAGE_REGISTRY.installation.supportedModes
      if (!supported.includes(command.mode)) {
        throw new Error(`unsupported Codex install mode: ${command.mode || 'missing'}`)
      }
      io.stdout.write(`provider=codex mode=${command.mode} capability=supported\n`)
      return 0
    }
    if (command.action === 'check' || command.action === 'generate') {
      if (command.provider && !PROVIDERS[command.provider]) {
        throw new Error(`unknown runtime provider: ${command.provider}`)
      }
      const outputs = new Map([...renderManifests(root)].filter(([relativePath]) =>
        !command.provider || relativePath === `agents/manifests/${command.provider}-runtime.json`,
      ))
      const stale = []
      for (const [relativePath, manifest] of outputs) {
        const expected = serializeManifest(manifest)
        const target = path.join(root, relativePath)
        const actual = fs.existsSync(target)
          ? (relativePath === 'agents/manifests/codex-runtime.json'
              ? fs.readFileSync(target, 'utf8')
              : fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'))
          : null
        if (actual !== expected) stale.push(relativePath)
        if (command.action === 'generate') writeAtomic(target, expected)
      }
      if (command.action === 'check' && stale.length) {
        io.stderr.write(`runtime-payload: stale manifests: ${stale.join(', ')}\n`)
        return 1
      }
      io.stdout.write(command.action === 'check'
        ? 'runtime manifests are current\n'
        : `generated ${outputs.size} runtime manifests\n`)
      return 0
    }
    if (command.action === 'inventory' || command.action === 'list') {
      const manifest = loadManifest(command.provider, root)
      if (command.action === 'list') verifySource(manifest, root)
      io.stdout.write(`${manifest.files.join('\n')}\n`)
      return 0
    }
    if (command.action === 'plan') {
      const plan = installationPlan(command.provider, command.destination, root)
      io.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        provider: plan.provider,
        activationRoot: plan.activationRoot,
        bundleRoot: plan.bundleRoot,
        discoverySkillRoot: plan.discoverySkillRoot,
        skillRoot: plan.skillRoot,
        payloadGeneration: plan.payloadGeneration,
        payloadDigest: plan.payloadDigest,
        files: plan.files,
      })}\n`)
      return 0
    }
    if (command.action === 'prune') {
      const removed = prunePayload(command.provider, command.destination, root)
      io.stdout.write(`pruned provider=${command.provider} files=${removed.length}\n`)
      return 0
    }
    if (command.action === 'install') {
      const files = installPayload(command.provider, command.destination, root)
      io.stdout.write(`installed provider=${command.provider} files=${files.length}\n`)
      return 0
    }
    const verified = verifyPayload(command.provider, command.destination, root)
    io.stdout.write(`verified provider=${verified.provider} files=${verified.files}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`runtime-payload: ${error.message}\n`)
    return 1
  }
}

if (require.main === module) process.exitCode = run(process.argv.slice(2))

module.exports = {
  CODEX_PACKAGE_REGISTRY,
  CODEX_PACKAGE_REGISTRY_PATH,
  CODEX_DISCOVERY_SHIM,
  CODEX_EMBEDDED_MANIFEST,
  CODEX_PRIVATE_BUNDLES,
  CODEX_EXTERNAL_RUNTIME_DEPENDENCIES,
  CODEX_RUNTIME_DYNAMIC_REQUIRES,
  assertCodexSourceClosure,
  codexRoleProjection,
  codexRuntimeFiles,
  codexPayloadDigest,
  codexPayloadClosureDigest,
  deriveCodexDeployCore,
  discoverCodexExternalRuntimeDependencies,
  installationPlan,
  installPayload,
  loadCodexPackageRegistry,
  loadManifest,
  physicalProviderRole,
  payloadSha256,
  prunePayload,
  renderManifests,
  run,
  runtimeFiles,
  uninstallPayload,
  validateCodexRoleProjection,
  validateDeclaredRuntimeRequires,
  verifyPayload,
}
