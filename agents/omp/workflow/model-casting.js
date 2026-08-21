#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// omp (oh-my-pi) model casting. Contributes the resolved per-tier model
// selectors for a run; the supervisor hands the serialized result to the child
// session via AUTOPROMPT_CASTING, and the conductor applies it as run-scoped
// task.agentModelOverrides project settings. With agents=off no selectors are
// emitted and every worker inherits the parent's active model.

const TIER_BY_ALIAS = Object.freeze({
  R1: 'R1',
  R2: 'R2',
  R3: 'R3',
  R4: 'R4',
  R5: 'R5',
})

const TIER_ROLES = Object.freeze({
  R1: 'coordinator',
  R2: 'planning',
  R3: 'implementation',
  R4: 'review',
  R5: 'mechanical',
})

const EFFORT_BY_TIER = Object.freeze({
  R1: 'xhigh',
  R2: 'xhigh',
  R3: 'high',
  R4: 'medium',
  R5: 'low',
})

const MAXIMUM_EFFORT_PERSONAS = new Set([
  'ap-scope-coordinator',
  'ap-manager',
  'ap-reviewer',
  'ap-fresh-verifier',
  'ap-verifier',
  'ap-juror',
  'ap-goal-checker',
  'ap-depth-prober',
  'ap-arbiter',
  'ap-framework-validator',
  'ap-re-anchor',
  'ap-planner',
  'ap-researcher',
  'ap-scoper',
  'ap-synthesizer',
])

const EFFORT_STATUSES = new Set([
  'selectable',
  'inherited-only',
  'unsupported',
  'unknown',
])

const UNKNOWN_EFFORT = Object.freeze({
  status: 'unknown',
  acceptedValues: [],
  maximum: null,
  source: 'unverified-provider-capability',
})

const INHERITED_EFFORT = Object.freeze({
  status: 'inherited-only',
  acceptedValues: [],
  maximum: null,
  source: 'session-inheritance',
})

const PERSONAS_BY_TIER = Object.freeze({
  R1: [
    'ap-scope-coordinator',
    'ap-feature-coordinator',
    'ap-sweep-coordinator',
  ],
  R2: [
    'ap-manager',
    'ap-scoper',
    'ap-synthesizer',
    'ap-planner',
    'ap-execharness-resolver',
    'ap-framework-generator',
  ],
  R3: [
    'ap-implementer',
    'ap-researcher',
    'ap-intake',
    'ap-preflight-probe',
  ],
  R4: [
    'ap-reviewer',
    'ap-verifier',
    'ap-sweeper',
    'ap-fresh-verifier',
    'ap-framework-validator',
    'ap-juror',
  ],
  R5: [
    'ap-goal-checker',
    'ap-arbiter',
    'ap-re-anchor',
    'ap-scribe',
    'ap-janitor',
    'ap-depth-prober',
  ],
})

const EFFORT_WEIGHT = Object.freeze({ max: 0, high: 1, medium: 2, low: 3 })
const REGISTRY_FIELDS = new Set(['name', 'provider', 'modelString', 'baseUrl', 'apiKeyEnv', 'effortHint'])
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseAgentsSelector(value) {
  if (value == null || value === '') return { mode: 'off' }
  if (value === 'off') return { mode: 'off' }
  if (value === 'auto' || value.startsWith('auto:')) {
    const models = value === 'auto' ? [] : value.slice(5).split(',').map((model) => model.trim()).filter(Boolean)
    return { mode: 'auto-list', models }
  }
  const models = value.split(',').map((model) => model.trim()).filter(Boolean)
  if (models.length === 0) return { mode: 'off' }
  return { mode: 'list', models }
}

function parseModelList(value) {
  if (value == null || value === '') return []
  return value.split(',').map((model) => model.trim()).filter(Boolean)
}

function rankRegistry(registry) {
  return registry
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftWeight = EFFORT_WEIGHT[left.entry.effortHint] ?? EFFORT_WEIGHT.medium
      const rightWeight = EFFORT_WEIGHT[right.entry.effortHint] ?? EFFORT_WEIGHT.medium
      return leftWeight - rightWeight || left.index - right.index
    })
    .map(({ entry }) => entry)
}

// Map one to five model selectors onto the R1..R5 tiers. One selector fills
// every tier (all workers use it); more selectors map strongest->R1 down to
// weakest->R5. omp has no fixed alias pool, so selectors are used verbatim as
// task.agentModelOverrides / modelRoles values.
function mapModelsToTierSelectors(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('omp model casting requires at least one model')
  }
  if (models.length > 5) {
    throw new Error('omp supports at most five tier selectors (R1..R5)')
  }
  if (new Set(models).size !== models.length) {
    throw new Error('omp model casting requires unique provider model strings')
  }

  const tiers = Object.keys(TIER_BY_ALIAS)
  const selectors = {}
  for (let index = 0; index < tiers.length; index += 1) {
    selectors[tiers[index]] = models[Math.min(index, models.length - 1)]
  }
  return selectors
}

function resolveOmpCasting(options = {}) {
  const parsed = parseAgentsSelector(options.selector)
  if (parsed.mode === 'off') return disabledCasting()

  const providerCapability = options.providerCapabilityPath
    ? readProviderCapability(options.providerCapabilityPath)
    : options.providerCapability
  const registryPath = resolveRegistryPath(options.registryPath, parsed.mode)
  const registry = registryPath ? readRegistry(registryPath) : null
  const selected = selectRegistryEntries(parsed, registry)
  const ordered = parsed.mode === 'auto' || parsed.mode === 'auto-list'
    ? rankRegistry(selected)
    : selected
  const names = ordered.map((entry) => entry.name)
  const models = ordered.map((entry) => entry.modelString)

  return {
    enabled: true,
    mode: parsed.mode,
    names,
    models,
    selectors: mapModelsToTierSelectors(models),
    tierRoles: { ...TIER_ROLES },
    endpoint: resolveEndpoint(ordered),
    effort: resolveProviderEffort(
      providerCapability,
      models,
    ),
  }
}

function readProviderCapability(configuredPath) {
  const capabilityPath = expandHome(configuredPath)
  let providerCapability

  try {
    providerCapability = JSON.parse(
      fs.readFileSync(capabilityPath, 'utf8'),
    )
  } catch (error) {
    throw new Error(
      `Provider capability is not valid JSON: ` +
      `${capabilityPath}: ${error.message}`,
    )
  }

  return providerCapability
}

function resolveProviderEffort(providerCapability, models) {
  if (providerCapability == null) return { ...INHERITED_EFFORT }
  return validateProviderCapability(providerCapability, models)
}

function validateProviderCapability(providerCapability, models) {
  if (typeof providerCapability !== 'object' || Array.isArray(providerCapability)) {
    throw new Error('Provider capability must be an object')
  }
  const { effort, models: capabilityModels } = providerCapability
  const validated = validateEffortCapability(effort)
  if (models != null && capabilityModels != null) {
    if (!Array.isArray(capabilityModels)) {
      throw new Error('Provider capability models must be an array')
    }
    if (!sameStringArray(models, capabilityModels)) {
      throw new Error('Provider capability models do not match the selected models')
    }
  }
  return validated
}

function validateEffortCapability(effort) {
  if (effort == null) return { ...INHERITED_EFFORT }
  if (typeof effort !== 'object' || Array.isArray(effort)) {
    throw new Error('Effort capability must be an object')
  }
  if (effort.status === 'inherited-only') return { ...INHERITED_EFFORT }
  if (effort.status === 'unsupported') {
    return { status: 'unsupported', acceptedValues: [], maximum: null, source: 'provider-capability' }
  }
  if (effort.status === 'unknown') return { ...UNKNOWN_EFFORT }
  if (effort.status !== 'selectable') {
    throw new Error(`Effort capability status must be selectable, inherited-only, unsupported, or unknown: ${effort.status}`)
  }
  const acceptedValues = [...(effort.acceptedValues ?? [])]
  acceptedValues.forEach((value) => {
    if (EFFORT_WEIGHT[value] == null) {
      throw new Error(`Effort capability accepted value is not a valid effort: ${value}`)
    }
  })
  const maximum = effort.maximum
  if (EFFORT_WEIGHT[maximum] == null) {
    throw new Error(`Effort capability maximum is not a valid effort: ${maximum}`)
  }
  return {
    status: 'selectable',
    acceptedValues,
    maximum,
    source: 'provider-capability',
  }
}

function sameStringArray(actual, expected) {
  if (actual.length !== expected.length) return false
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) return false
  }
  return true
}

function copyEffort(effort) {
  return { ...effort }
}

function disabledCasting() {
  return {
    enabled: false,
    mode: 'off',
    names: [],
    models: [],
    selectors: {},
    tierRoles: {},
    endpoint: {},
    effort: { ...INHERITED_EFFORT },
  }
}

// Default registry lives next to the omp agent config dir so the supervisor can
// resolve `auto` without extra flags. PI_CODING_AGENT_DIR relocates that base.
function ompAgentDir() {
  const override = process.env.PI_CODING_AGENT_DIR || process.env.OMP_CODING_AGENT_DIR
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.omp', 'agent')
}

function resolveRegistryPath(configuredPath, mode) {
  if (configuredPath) return expandHome(configuredPath)
  if (mode !== 'auto' && mode !== 'auto-list') return null
  return path.join(ompAgentDir(), 'autoprompt-models.json')
}

function expandHome(filePath) {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2))
  }
  return path.resolve(filePath)
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Autoprompt model registry file does not exist: ${registryPath}`)
  }

  let registry
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  } catch (error) {
    throw new Error(`Autoprompt model registry is not valid JSON: ${registryPath}: ${error.message}`)
  }
  validateRegistry(registry)
  return registry
}

function validateRegistry(registry) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error('Autoprompt model registry must be a non-empty JSON array')
  }

  const names = new Set()
  registry.forEach((entry, index) => {
    validateRegistryEntry(entry, index)
    if (names.has(entry.name)) throw new Error(`Autoprompt model registry has duplicate registry name: ${entry.name}`)
    names.add(entry.name)
  })
}

function validateRegistryEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Autoprompt model registry entry ${index} must be an object`)
  }
  for (const field of Object.keys(entry)) {
    if (!REGISTRY_FIELDS.has(field)) throw new Error(`Autoprompt model registry entry ${index} has unknown field: ${field}`)
  }
  for (const field of ['name', 'provider', 'modelString']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      throw new Error(`Autoprompt model registry entry ${index} ${field} must be a non-empty string`)
    }
  }
  for (const field of ['baseUrl', 'apiKeyEnv', 'effortHint']) {
    if (entry[field] != null && (typeof entry[field] !== 'string' || entry[field].trim() === '')) {
      throw new Error(`Autoprompt model registry entry ${index} ${field} must be a non-empty string when provided`)
    }
  }
  if (entry.baseUrl != null) validateBaseUrl(entry.baseUrl, index)
  if (entry.apiKeyEnv != null && !ENVIRONMENT_VARIABLE_NAME.test(entry.apiKeyEnv)) {
    throw new Error(`Autoprompt model registry entry ${index} apiKeyEnv must be an environment variable name`)
  }
  if (entry.effortHint != null && !Object.hasOwn(EFFORT_WEIGHT, entry.effortHint)) {
    throw new Error(`Autoprompt model registry entry ${index} effortHint must be max, high, medium, or low`)
  }
}

function validateBaseUrl(baseUrl, index) {
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`Autoprompt model registry entry ${index} baseUrl must be an absolute HTTP URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Autoprompt model registry entry ${index} baseUrl must be an absolute HTTP URL`)
  }
}

function selectRegistryEntries(parsed, registry) {
  if (!registry) {
    return parsed.models.map((model) => ({ name: model, provider: 'inherited', modelString: model }))
  }
  if (parsed.mode === 'auto' || parsed.mode === 'auto-list') {
    if (parsed.models.length === 0) return [...registry]
    const byName = new Map(registry.map((entry) => [entry.name, entry]))
    return parsed.models.map((name) => {
      const entry = byName.get(name)
      if (!entry) throw new Error(`Model ${name} is not present in the registry`)
      return entry
    })
  }

  const byName = new Map(registry.map((entry) => [entry.name, entry]))
  return parsed.models.map((name) => {
    const entry = byName.get(name)
    if (!entry) throw new Error(`Model ${name} is not present in the registry`)
    return entry
  })
}

function resolveEndpoint(entries) {
  const baseUrls = new Set(entries.map((entry) => entry.baseUrl ?? null))
  const apiKeyEnvironments = new Set(entries.map((entry) => entry.apiKeyEnv ?? null))
  if (baseUrls.size > 1 || apiKeyEnvironments.size > 1) {
    throw new Error('omp custom models must form one endpoint-compatible pool with one credential source')
  }

  const endpoint = {}
  const [baseUrl] = baseUrls
  const [apiKeyEnv] = apiKeyEnvironments
  if (baseUrl) endpoint.baseUrl = baseUrl
  if (apiKeyEnv) endpoint.apiKeyEnv = apiKeyEnv
  return endpoint
}

function resolvePersonaCasting(persona, casting) {
  if (!casting || !casting.enabled) return null
  const tier = Object.keys(PERSONAS_BY_TIER)
    .find(candidate => PERSONAS_BY_TIER[candidate].includes(persona))
  if (!tier) {
    throw new Error(`Persona ${persona} has no model-casting tier`)
  }

  const resolved = { tier, model: casting.selectors[tier] ?? null }
  if (casting.effort.status !== 'selectable') return resolved

  const requestedEffort = MAXIMUM_EFFORT_PERSONAS.has(persona)
    ? casting.effort.maximum
    : EFFORT_BY_TIER[tier]
  resolved.effort = resolveAcceptedEffort(
    requestedEffort,
    casting.effort,
  )
  return resolved
}

function resolveAcceptedEffort(requestedEffort, capability) {
  if (capability.acceptedValues.includes(requestedEffort)) {
    return requestedEffort
  }
  return capability.acceptedValues.reduce((closest, candidate) => {
    const closestDistance = Math.abs(
      effortRank(closest) - effortRank(requestedEffort),
    )
    const candidateDistance = Math.abs(
      effortRank(candidate) - effortRank(requestedEffort),
    )
    return candidateDistance < closestDistance
      ? candidate
      : closest
  }, capability.maximum)
}

function effortRank(effort) {
  return ['low', 'medium', 'high', 'xhigh'].indexOf(effort)
}

function serializeLaunchCasting(casting) {
  return JSON.stringify(casting)
}

function runCli(argv) {
  const options = parseCliArguments(argv)
  const casting = resolveOmpCasting(options)
  process.stdout.write(`${serializeLaunchCasting(casting)}\n`)
}

function parseCliArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--selector') {
      options.selector = requireCliValue(argv, ++index, argument)
    } else if (argument === '--registry') {
      options.registryPath = requireCliValue(argv, ++index, argument)
    } else if (argument === '--provider-capability') {
      options.providerCapabilityPath = requireCliValue(
        argv,
        ++index,
        argument,
      )
    } else {
      throw new Error(`Unknown model-casting argument: ${argument}`)
    }
  }
  return options
}

function requireCliValue(argv, index, argument) {
  const value = argv[index]
  if (value == null || value === '') throw new Error(`${argument} requires a value`)
  return value
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`model-casting: ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  TIER_BY_ALIAS,
  TIER_ROLES,
  EFFORT_BY_TIER,
  MAXIMUM_EFFORT_PERSONAS,
  PERSONAS_BY_TIER,
  mapModelsToTierSelectors,
  parseAgentsSelector,
  parseCliArguments,
  rankRegistry,
  resolveOmpCasting,
  resolvePersonaCasting,
  runCli,
  serializeLaunchCasting,
}