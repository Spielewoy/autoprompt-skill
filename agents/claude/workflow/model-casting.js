#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ALIAS_BY_TIER = Object.freeze({
  R1: 'opus',
  R2: 'sonnet',
  R3: 'sonnet',
  R4: 'haiku',
  R5: 'haiku',
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
  R1: ['ap-scope-coordinator', 'ap-feature-coordinator', 'ap-sweep-coordinator', 'ap-manager'],
  R2: [
    'ap-reviewer',
    'ap-fresh-verifier',
    'ap-verifier',
    'ap-juror',
    'ap-goal-checker',
    'ap-depth-prober',
    'ap-arbiter',
    'ap-framework-validator',
    'ap-re-anchor',
  ],
  R3: [
    'ap-implementer',
    'ap-planner',
    'ap-researcher',
    'ap-scoper',
    'ap-synthesizer',
    'ap-execharness-resolver',
    'ap-framework-generator',
  ],
  R4: ['ap-preflight-probe', 'ap-intake', 'ap-scribe'],
  R5: ['ap-sweeper', 'ap-janitor'],
})

const EFFORT_WEIGHT = Object.freeze({ max: 0, high: 1, medium: 2, low: 3 })
const REGISTRY_FIELDS = new Set(['name', 'provider', 'modelString', 'baseUrl', 'apiKeyEnv', 'effortHint'])
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseAgentsSelector(value) {
  const selector = value == null ? 'off' : String(value).trim()
  const control = selector.toLowerCase()

  if (selector === '' || control === 'off') return { mode: 'off', models: [] }
  if (control === 'auto') return { mode: 'auto', models: [] }
  if (control.startsWith('auto:')) {
    const pool = selector.slice(selector.indexOf(':') + 1)
    if (pool.trim() === '') return { mode: 'auto', models: [] }
    return { mode: 'auto-list', models: parseModelList(pool) }
  }

  return { mode: 'list', models: parseModelList(selector) }
}

function parseModelList(value) {
  const models = value.split(',').map((model) => model.trim())
  if (models.some((model) => model === '')) {
    throw new Error('agents selector contains an empty model identifier')
  }

  const seen = new Set()
  for (const model of models) {
    if (seen.has(model)) throw new Error(`agents selector contains duplicate model identifier: ${model}`)
    seen.add(model)
  }
  return models
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

function mapModelsToClaudeAliases(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Claude Code model casting requires at least one model')
  }
  if (models.length > 3) {
    throw new Error('Claude Code supports three remappable aliases; select at most three custom models')
  }
  if (new Set(models).size !== models.length) {
    throw new Error('Claude Code model casting requires unique provider model strings')
  }

  if (models.length === 1) {
    return { opus: models[0], sonnet: models[0], haiku: models[0] }
  }
  if (models.length === 2) {
    return { opus: models[0], sonnet: models[0], haiku: models[1] }
  }
  return { opus: models[0], sonnet: models[1], haiku: models[2] }
}

function resolveClaudeAliasCasting(options = {}) {
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
    aliases: mapModelsToClaudeAliases(models),
    tierAliases: { ...ALIAS_BY_TIER },
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
  if (providerCapability === undefined) {
    return copyEffort(UNKNOWN_EFFORT)
  }
  validateProviderCapability(providerCapability, models)
  return copyEffort(providerCapability.effort)
}

function validateProviderCapability(providerCapability, models) {
  if (
    !providerCapability ||
    typeof providerCapability !== 'object' ||
    Array.isArray(providerCapability)
  ) {
    throw new Error('provider capability must be an object')
  }

  if (
    typeof providerCapability.provider !== 'string' ||
    providerCapability.provider.trim() === ''
  ) {
    throw new Error('provider capability provider must be a non-empty string')
  }

  if (!sameStringArray(providerCapability.models, models)) {
    throw new Error(
      'provider capability models do not match the selected provider models',
    )
  }

  const effort = providerCapability.effort
  validateEffortCapability(effort)

  if (
    effort.status === 'selectable' &&
    providerCapability.verified !== true
  ) {
    throw new Error(
      'selectable effort capability must be verified',
    )
  }
}

function validateEffortCapability(effort) {
  if (
    !effort ||
    typeof effort !== 'object' ||
    Array.isArray(effort) ||
    !EFFORT_STATUSES.has(effort.status)
  ) {
    throw new Error(
      'provider capability effort status must be selectable, ' +
      'inherited-only, unsupported, or unknown',
    )
  }

  if (
    !Array.isArray(effort.acceptedValues) ||
    effort.acceptedValues.some(value =>
      typeof value !== 'string' || value.trim() === '',
    ) ||
    new Set(effort.acceptedValues).size !==
      effort.acceptedValues.length
  ) {
    throw new Error(
      'provider capability effort acceptedValues must be ' +
      'a unique string array',
    )
  }

  if (
    typeof effort.source !== 'string' ||
    effort.source.trim() === ''
  ) {
    throw new Error(
      'provider capability effort source must be a non-empty string',
    )
  }

  if (effort.status === 'selectable') {
    if (
      typeof effort.maximum !== 'string' ||
      !effort.acceptedValues.includes(effort.maximum)
    ) {
      throw new Error(
        'provider capability effort maximum must be one of ' +
        'acceptedValues',
      )
    }
    return
  }

  if (effort.acceptedValues.length !== 0) {
    throw new Error(
      'provider capability non-selectable effort ' +
      'acceptedValues must be empty',
    )
  }
  if (effort.maximum !== null) {
    throw new Error(
      'provider capability non-selectable effort maximum ' +
      'must be null',
    )
  }
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
}

function copyEffort(effort) {
  return {
    ...effort,
    acceptedValues: [...effort.acceptedValues],
  }
}

function disabledCasting() {
  return {
    enabled: false,
    mode: 'off',
    names: [],
    models: [],
    aliases: {},
    tierAliases: {},
    endpoint: {},
    effort: { ...INHERITED_EFFORT, acceptedValues: [] },
  }
}

function resolveRegistryPath(configuredPath, mode) {
  if (configuredPath) return expandHome(configuredPath)
  if (mode !== 'auto' && mode !== 'auto-list') return null
  return path.join(os.homedir(), '.claude', 'autoprompt-models.json')
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
  if (parsed.mode === 'auto') return [...registry]

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
    throw new Error('Claude Code custom models must form one endpoint-compatible pool with one credential source')
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

  const resolved = { tier, model: ALIAS_BY_TIER[tier] }
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
  const casting = resolveClaudeAliasCasting(options)
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
  ALIAS_BY_TIER,
  EFFORT_BY_TIER,
  MAXIMUM_EFFORT_PERSONAS,
  PERSONAS_BY_TIER,
  mapModelsToClaudeAliases,
  parseAgentsSelector,
  parseCliArguments,
  rankRegistry,
  resolveClaudeAliasCasting,
  resolvePersonaCasting,
  runCli,
  serializeLaunchCasting,
}
