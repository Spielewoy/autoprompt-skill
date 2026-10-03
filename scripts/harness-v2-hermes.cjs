'use strict'

// Hermes owns model calls, history, and tool-loop scheduling. This module only
// creates its private projection and hands a sealed launch specification to the
// owned wrapper. It deliberately does not translate a model API into a second
// agent loop.
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const YAML = require('yaml')
const { privateDirectory, readBound, writePrivate } = require('../agents/reasonix/workflow/native.js')
const boundary = require('./harness-v2-tool-boundary.cjs')

const TOOLSET = 'autoprompt_owned'
const DIAGNOSTIC_FILE_LIMIT = 1024 * 1024
const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fileType = stat => stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other'
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
function stableFileDiagnostic(file, expected, stat) {
  const expectedBytes = Buffer.from(expected, 'utf8')
  const details = {
    type: fileType(stat),
    nlink: stat.nlink,
    expectedBytes: expectedBytes.length,
    actualBytes: Number.isSafeInteger(stat.size) ? stat.size : null,
    expectedSha256: sha256(expectedBytes),
    actualSha256: null,
    changedTopLevelKeys: [],
    addedTopLevelKeyCount: null,
    parseStatus: 'not-attempted',
    readStatus: 'not-readable'
  }
  if (!stat.isFile() || stat.nlink !== 1) return { details, matches: false }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > DIAGNOSTIC_FILE_LIMIT) return { details: { ...details, readStatus: 'size-out-of-range' }, matches: false }
  let actual
  try {
    actual = readBound(file)
    details.actualSha256 = sha256(actual)
    details.readStatus = 'stable'
    const expectedDocument = YAML.parseDocument(expectedBytes.toString('utf8'), { maxAliasCount: 0, uniqueKeys: true })
    const actualDocument = YAML.parseDocument(actual.toString('utf8'), { maxAliasCount: 0, uniqueKeys: true })
    if (expectedDocument.errors.length || actualDocument.errors.length) throw new Error('invalid document')
    const expectedValue = expectedDocument.toJS({ maxAliasCount: 0 })
    const actualValue = actualDocument.toJS({ maxAliasCount: 0 })
    if (expectedValue && actualValue && typeof expectedValue === 'object' && typeof actualValue === 'object' && !Array.isArray(expectedValue) && !Array.isArray(actualValue)) {
      const expectedKeys = Object.keys(expectedValue)
      details.changedTopLevelKeys = expectedKeys.filter(key => !Object.hasOwn(actualValue, key) || JSON.stringify(canonical(expectedValue[key])) !== JSON.stringify(canonical(actualValue[key]))).sort()
      details.addedTopLevelKeyCount = Object.keys(actualValue).filter(key => !Object.hasOwn(expectedValue, key)).length
      if (Number.isSafeInteger(actualValue._config_version) && actualValue._config_version >= 0 && actualValue._config_version <= 1000000) details.actualConfigVersion = actualValue._config_version
      details.parseStatus = 'valid-object'
    } else details.parseStatus = 'valid-nonobject'
  } catch { if (details.readStatus === 'stable') details.parseStatus = 'invalid'; else details.readStatus = 'read-failed' }
  return { details, matches: !!actual && actual.equals(expectedBytes) }
}
const safe = (value, name) => {
  if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n]/.test(value)) throw new Error(`Invalid Hermes ${name}`)
  return value
}
const url = (value, name) => {
  safe(value, name)
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`Invalid Hermes ${name}`)
  return value
}
function sanitizeConnection(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Hermes connection must be an object')
  if (Object.keys(source).some(key => !['model', 'modelProvider', 'maxTokens', 'environment'].includes(key))) throw new Error('Hermes connection contains an unsupported capability')
  const result = {}
  for (const key of ['model', 'modelProvider']) if (source[key] !== undefined) result[key] = safe(source[key], key)
  if (source.maxTokens !== undefined) {
    if (!Number.isSafeInteger(source.maxTokens) || source.maxTokens <= 0) throw new Error('Invalid Hermes maxTokens')
    result.maxTokens = source.maxTokens
  }
  if (source.environment !== undefined) {
    if (!source.environment || typeof source.environment !== 'object' || Array.isArray(source.environment)) throw new Error('Hermes environment must be an object')
    if (Object.keys(source.environment).some(key => key !== 'HERMES_BASE_URL')) throw new Error('Hermes environment contains an unsupported capability')
    result.environment = {}
    if (source.environment.HERMES_BASE_URL !== undefined) result.environment.HERMES_BASE_URL = url(source.environment.HERMES_BASE_URL, 'base URL')
  }
  return result
}
function selectApiKey(baseUrl, credentials = {}) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Hermes credentials must be an object')
  let preferred = ['HERMES_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) preferred = ['OPENROUTER_API_KEY', 'HERMES_API_KEY', 'OPENAI_API_KEY']
    else if (host === 'api.openai.com' || host.endsWith('.openai.com')) preferred = ['OPENAI_API_KEY', 'HERMES_API_KEY', 'OPENROUTER_API_KEY']
  } catch {}
  for (const name of preferred) if (typeof credentials[name] === 'string' && credentials[name]) return credentials[name]
  return null
}
function requiredReasoning(baseUrl, effort) {
  if (effort === undefined) return undefined
  if (!EFFORTS.includes(effort)) throw Object.assign(new Error('Invalid Hermes reasoning effort'), { code: 'PROFILE_INVALID' })
  let host
  try { host = new URL(baseUrl).hostname.toLowerCase() } catch { throw Object.assign(new Error('Hermes reasoning requires an OpenRouter upstream URL'), { code: 'PROVIDER_UNSUPPORTED' }) }
  // Hermes 0.21.1 correctly withholds its OpenRouter-only reasoning body for
  // the reservation-private loopback relay.  The relay may restore this exact
  // controller binding only when the original upstream is OpenRouter.
  if (!(host === 'openrouter.ai' || host.endsWith('.openrouter.ai'))) return undefined
  // Hermes itself clamps its internal-only `ultra` level to the OpenAI
  // compatible wire maximum before it calls OpenRouter. The relay must bind
  // that same wire value rather than leak the internal spelling upstream.
  const wireEffort = effort === 'ultra' ? 'max' : effort
  return Object.freeze({ enabled: wireEffort !== 'none', effort: wireEffort })
}
function pluginFiles() {
  const root = path.join(__dirname, 'harness-v2-bridge', 'hermes')
  return { manifest: fs.readFileSync(path.join(root, 'plugin.yaml'), 'utf8'), source: fs.readFileSync(path.join(root, 'plugin.py'), 'utf8') }
}
function prepare(options) {
  const { home, sessionRoot, stateHome, toolBoundary, model, effort, continuationId, promptFile, hermesExecutable, pythonExecutable, apiKey, maxTokens } = options || {}
  for (const [name, value] of Object.entries({ home, sessionRoot, promptFile, hermesExecutable, pythonExecutable })) if (!path.isAbsolute(value || '')) throw new Error(`Hermes ${name} must be absolute`)
  if (stateHome !== undefined && !path.isAbsolute(stateHome || '')) throw new Error('Hermes stateHome must be absolute')
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error('Invalid Hermes reasoning effort')
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new Error('Invalid Hermes maxTokens')
  if (continuationId !== undefined && !/^[A-Za-z0-9_.:-]{1,256}$/.test(continuationId)) throw new Error('Invalid bound Hermes session identity')
  const current = boundary.loadBoundary(toolBoundary.policyPath, toolBoundary.policySha256)
  if (current.policy.provider !== 'hermes') throw new Error('Hermes tool policy provider mismatch')
  privateDirectory(home); privateDirectory(sessionRoot)
  // This file lives beside the receipt ledger, outside Hermes' writable
  // state.  The controller tool server appends exact args/result projections
  // only after committing each execution receipt.
  const toolProjectionPath = path.join(current.root, 'hermes-projections.jsonl')
  if (fs.existsSync(toolProjectionPath)) {
    if (readBound(toolProjectionPath).length !== 0) throw new Error('Hermes tool projection journal is not fresh')
  } else writePrivate(toolProjectionPath, '')
  const persistentHome = stateHome || home
  privateDirectory(persistentHome)
  const bundled = path.join(home, 'empty-bundled')
  const persistentPlugins = path.join(persistentHome, 'plugins', TOOLSET)
  privateDirectory(bundled); privateDirectory(persistentPlugins)
  const files = pluginFiles()
  const stablePrivate = (file, content) => {
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file)
      const inspected = stableFileDiagnostic(file, content, stat)
      if (!inspected.matches) {
        const error = new Error(`Hermes persistent file changed: ${path.basename(file)}`)
        error.details = inspected.details
        throw error
      }
      return
    }
    writePrivate(file, content)
  }
  stablePrivate(path.join(persistentPlugins, 'plugin.yaml'), files.manifest)
  stablePrivate(path.join(persistentPlugins, '__init__.py'), files.source)
  // JSON is valid YAML and avoids a YAML serializer injecting host-controlled
  // tags. The narrow toolset is direct: tool_search would reintroduce Hermes'
  // bridge tools and cannot be allowed here.
  const providerName = 'autoprompt-owned'
  // Hermes 0.21.1 deliberately ignores legacy global output-cap settings. Its
  // documented named custom-provider projection applies `extra_body` to every
  // OpenAI-compatible request, which is the narrow native route for a sealed
  // controller cap. No other request override is projected.
  const relayBaseUrl = url(options.baseUrl, 'base URL')
  const relayApiKey = safe(apiKey, 'API key')
  // A continuation keeps one HERMES_HOME/state.db while each physical launch
  // receives a fresh controller quota relay. Hermes expands these fixed config
  // references from the owned child's environment, so the persistent config
  // remains byte-identical and no live sibling observes a shared-file rewrite.
  const relayBaseUrlReference = '${env:AUTOPROMPT_HERMES_RELAY_BASE_URL}'
  const relayApiKeyReference = '${env:AUTOPROMPT_HERMES_RELAY_API_KEY}'
  // Hermes 0.21.1 uses schema 41. An unversioned config is eligible for
  // startup migration, which rewrites the session-bound persistent file.
  // Long tools trigger a one-time Hermes progress tip after 30 seconds. Mark
  // it seen in this owned noninteractive home so the tip cannot rewrite config.
  const config = { _config_version: 41, plugins: { enabled: [TOOLSET] }, model: { default: safe(model, 'model'), provider: providerName, base_url: relayBaseUrlReference, api_key: relayApiKeyReference }, providers: { [providerName]: { base_url: relayBaseUrlReference, api_key: relayApiKeyReference, model: safe(model, 'model'), ...(maxTokens === undefined ? {} : { extra_body: { max_tokens: maxTokens } }) } }, toolsets: [], tools: { tool_search: { enabled: false } }, auxiliary: { title_generation: { enabled: false } }, compression: { enabled: false }, telemetry: { shared_metrics: { enabled: false, send: false } }, agent: { max_turns: Number.isSafeInteger(options.maxTurns) ? options.maxTurns : 32, disabled_toolsets: [] }, onboarding: { seen: { tool_progress_prompt: true } } }
  stablePrivate(path.join(persistentHome, 'config.yaml'), JSON.stringify(config))
  const spec = { hermesExecutable, pythonExecutable, home: persistentHome, sessionRoot, promptFile, model, effort, continuationId: continuationId || null, receiptPath: current.receiptPath, toolProjectionPath,
    argv: ['chat', '--query-file', promptFile, '--oneshot', '--model', model, '--provider', providerName, '--toolsets', TOOLSET, '--ignore-rules', ...(effort ? ['--reasoning', effort] : []), ...(continuationId ? ['--resume', continuationId] : [])] }
  const specFile = path.join(home, 'autoprompt-hermes-launch.json')
  writePrivate(specFile, JSON.stringify(spec))
  return { specFile, env: { HERMES_HOME: persistentHome, HERMES_BUNDLED_PLUGINS: bundled, HERMES_ENABLE_PROJECT_PLUGINS: '0', HERMES_IGNORE_RULES: '1', AUTOPROMPT_HERMES_RELAY_BASE_URL: relayBaseUrl, AUTOPROMPT_HERMES_RELAY_API_KEY: relayApiKey, AUTOPROMPT_TOOL_POLICY: current.policyPath, AUTOPROMPT_TOOL_POLICY_SHA256: current.policySha256, AUTOPROMPT_HERMES_TOOL_PROJECTIONS: toolProjectionPath, AUTOPROMPT_NODE: process.execPath, AUTOPROMPT_TOOL_SERVER: require.resolve('./harness-v2-tool-server.cjs') }, argv: [require.resolve('./harness-v2-bridge/hermes/owned-wrapper.cjs'), '--spec', specFile] }
}
module.exports = { TOOLSET, EFFORTS, sanitizeConnection, selectApiKey, requiredReasoning, prepare }
