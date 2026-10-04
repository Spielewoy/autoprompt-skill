'use strict'

// Import connection data, never extension paths, shell-based credentials, hooks,
// project configuration, or a user's executable provider modules.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { canonicalJsonWireProjection } = require('./harness-v2-canonical-json-wire.cjs')
const YAML = require('yaml')
const { readBound, privateDirectory, writePrivate } = require('../agents/reasonix/workflow/native.js')

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const reserved = new Set(['__proto__', 'constructor', 'prototype'])
// OMP's built-in `openrouter` provider applies its own compatibility pass
// after extension request hooks and removes response_format.  Keep the exact
// user-selected model and credential declaration, but project that one
// controller-owned native config entry under a private custom-provider name
// so the reviewed before_provider_request hook remains authoritative.
const OMP_OPENROUTER_PRIVATE_PROVIDER = 'autoprompt_openrouter'
function fail(message) { const error = new Error(message); error.code = 'PROFILE_INVALID'; throw error }
function text(value, field) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\0\r\n]/.test(value) || value.trimStart().startsWith('!')) {
    fail(`Invalid or executable Pi connection field: ${field}`)
  }
  return value
}
function url(value, field) {
  const result = text(value, field)
  let parsed
  try { parsed = new URL(result) } catch { fail(`Invalid Pi connection URL: ${field}`) }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(`Invalid Pi connection URL: ${field}`)
  return result
}
function compatibility(value) {
  if (!object(value)) fail('Pi compatibility settings must be an object')
  const result = {}
  for (const field of ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
    'supportsStrictMode', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText', 'requiresMistralToolIds']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') fail(`Invalid Pi compatibility flag: ${field}`)
      result[field] = value[field]
    }
  }
  if (value.maxTokensField !== undefined) {
    if (!['max_tokens', 'max_completion_tokens'].includes(value.maxTokensField)) fail('Invalid Pi max-token field')
    result.maxTokensField = value.maxTokensField
  }
  return result
}
function sanitize(provider, source = {}) {
  if (!['prime', 'omp'].includes(provider) || !object(source)) fail('Invalid Pi connection object')
  const result = { provider, environment: {} }
  for (const field of ['model', 'modelProvider']) if (source[field] !== undefined) result[field] = text(source[field], field)
  if (source.providers === undefined) return result
  if (!object(source.providers) || Object.keys(source.providers).length > 128) fail('Pi providers must be a bounded object')
  result.providers = {}
  for (const [id, sourceProvider] of Object.entries(source.providers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || reserved.has(id) || !object(sourceProvider)) fail('Invalid Pi provider definition')
    const item = {}
    if (sourceProvider.baseUrl !== undefined) item.baseUrl = url(sourceProvider.baseUrl, 'baseUrl')
    for (const field of ['api', 'apiKey']) if (sourceProvider[field] !== undefined) item[field] = text(sourceProvider[field], field)
    if (sourceProvider.auth !== undefined) {
      if (sourceProvider.auth !== 'none') fail('Only the native keyless auth marker is imported')
      item.auth = 'none'
    }
    if (sourceProvider.authHeader !== undefined) {
      if (typeof sourceProvider.authHeader !== 'boolean') fail('Invalid Pi authHeader')
      item.authHeader = sourceProvider.authHeader
    }
    if (sourceProvider.headers !== undefined) {
      if (!object(sourceProvider.headers)) fail('Invalid Pi static headers')
      item.headers = {}
      for (const [name, value] of Object.entries(sourceProvider.headers)) {
        if (!/^[A-Za-z0-9-]+$/.test(name) || reserved.has(name)) fail('Invalid Pi header name')
        item.headers[name] = text(value, name)
      }
    }
    if (sourceProvider.compat !== undefined) item.compat = compatibility(sourceProvider.compat)
    if (sourceProvider.models !== undefined) {
      if (!Array.isArray(sourceProvider.models) || !sourceProvider.models.length || sourceProvider.models.length > 512) fail('Pi models must be a nonempty bounded array')
      const ids = new Set()
      item.models = sourceProvider.models.map(sourceModel => {
        if (!object(sourceModel)) fail('Invalid Pi model definition')
        const model = { id: text(sourceModel.id, 'model id') }
        if (ids.has(model.id)) fail('Duplicate Pi model id')
        ids.add(model.id)
        for (const field of ['name', 'api']) if (sourceModel[field] !== undefined) model[field] = text(sourceModel[field], field)
        if (sourceModel.baseUrl !== undefined) model.baseUrl = url(sourceModel.baseUrl, 'model baseUrl')
        if (sourceModel.reasoning !== undefined) {
          if (typeof sourceModel.reasoning !== 'boolean') fail('Invalid Pi model reasoning flag')
          model.reasoning = sourceModel.reasoning
        }
        if (sourceModel.input !== undefined) {
          if (!Array.isArray(sourceModel.input) || !sourceModel.input.length || sourceModel.input.some(kind => !['text', 'image'].includes(kind))) fail('Invalid Pi model input types')
          model.input = [...new Set(sourceModel.input)]
        }
        for (const field of ['contextWindow', 'maxTokens']) if (sourceModel[field] !== undefined) {
          if (!Number.isSafeInteger(sourceModel[field]) || sourceModel[field] < 1) fail(`Invalid Pi model limit: ${field}`)
          model[field] = sourceModel[field]
        }
        if (sourceModel.cost !== undefined) {
          if (!object(sourceModel.cost)) fail('Invalid Pi model cost data')
          model.cost = {}
          for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) if (sourceModel.cost[field] !== undefined) {
            if (!Number.isFinite(sourceModel.cost[field]) || sourceModel.cost[field] < 0) fail('Invalid Pi model cost')
            model.cost[field] = sourceModel.cost[field]
          }
        }
        if (sourceModel.compat !== undefined) model.compat = compatibility(sourceModel.compat)
        return model
      })
    }
    result.providers[id] = item
  }
  return result
}

function readConnection(provider, root) {
  const names = provider === 'omp' ? ['models.yml', 'models.yaml', 'models.json'] : ['models.json']
  for (const name of names) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    const bytes = readBound(file)
    if (bytes.length > 1024 * 1024) fail('Pi model registry exceeds one MiB')
    try {
      const document = YAML.parseDocument(bytes.toString('utf8'), { uniqueKeys: true, version: '1.2', customTags: [] })
      if (document.errors.length || document.warnings.length) fail('Pi model registry contains invalid YAML, duplicate keys, or unsupported tags')
      return sanitize(provider, document.toJS({ maxAliasCount: 32 }))
    } catch (error) {
      if (error.code === 'PROFILE_INVALID') throw error
      fail(`Cannot parse Pi connection data: ${name}`)
    }
  }
  return sanitize(provider)
}
function credentialNames(connection = {}) {
  return Object.values(connection.providers || {}).flatMap(provider =>
    typeof provider.apiKey === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(provider.apiKey) ? [provider.apiKey] : [])
}
function requiredResponseFormat(outputSchema) {
  if (outputSchema === undefined) return null
  if (!object(outputSchema)) fail('Pi output schema must be an object')
  let serialized
  try { serialized = JSON.stringify(outputSchema) } catch { fail('Pi output schema must be JSON') }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 256 * 1024) fail('Pi output schema exceeds its private projection bound')
  return Object.freeze({ type: 'json_schema', json_schema: { name: 'autoprompt_result', strict: true, schema: JSON.parse(serialized) } })
}
// OpenAI Structured Outputs intentionally accepts a smaller schema language
// than the controller's canonical contracts.  Keep the native-facing schema
// in that supported subset while retaining the complete canonical value as an
// exact JSON string.  The adapter validates this closed envelope first, then
// parses and validates the decoded value against the original controller
// schema.  This is a transport projection only: it never supplies defaults or
// removes canonical fields.
function canonicalWireProjection(canonicalSchema) {
  try { return canonicalJsonWireProjection(canonicalSchema, { provider: 'pi', label: 'Pi', version: 'pi-canonical-envelope-v1' }) }
  catch (error) { fail(error.message) }
}
function outputCap(connection, model, maxTokens) {
  if (maxTokens === undefined) return null
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) fail('Invalid Pi controller output cap')
  const selected = connection.providers?.[connection.modelProvider]?.models?.find(value => value.id === model)
  if (!selected) fail('Pi quota execution requires the exact selected model definition')
  const field = selected?.compat?.maxTokensField
  // A current native SDK may already select its own known output-cap spelling.
  // In that case the hook preserves that spelling and only lowers its value.
  // The field below is needed solely when the native payload omits both caps.
  return Object.freeze({ field: ['max_tokens', 'max_completion_tokens'].includes(field) ? field : null,
    value: Math.min(maxTokens, Number.isSafeInteger(selected.maxTokens) && selected.maxTokens > 0 ? selected.maxTokens : maxTokens) })
}
function nativeConnectionProjection(provider, connection) {
  if (provider !== 'omp' || connection.modelProvider !== 'openrouter') return connection
  const upstream = connection.providers?.openrouter
  if (!object(upstream)) fail('OMP OpenRouter projection requires its exact provider declaration')
  return Object.freeze({ ...connection, modelProvider: OMP_OPENROUTER_PRIVATE_PROVIDER,
    providers: { ...connection.providers, [OMP_OPENROUTER_PRIVATE_PROVIDER]: upstream } })
}
function project({ provider, home, sessionRoot, connection, toolBoundary, prompt, continuationId, effort, outputSchema, model, maxTokens }, env) {
  if (!toolBoundary) fail('Pi execution requires controller-owned tools')
  const config = path.join(home, 'agent'), sessions = path.join(sessionRoot, 'sessions')
  const nativeConnection = nativeConnectionProjection(provider, connection)
  privateDirectory(config); privateDirectory(sessions)
  writePrivate(path.join(config, provider === 'omp' ? 'models.yml' : 'models.json'), JSON.stringify({ providers: nativeConnection.providers || {} }))
  const privateSettings = {
    compaction: { enabled: false }, retry: { enabled: false }, extensions: [], packages: [],
    // OMP bounds extension tool_call handlers globally. Native Windows startup
    // can exceed its 30s default; keep this controller-owned and out of any
    // ambient user configuration. Prime has no corresponding setting.
    ...(provider === 'omp' ? { extensionHandlers: { toolCallTimeoutMs: 180000 } } : {}),
  }
  writePrivate(path.join(config, provider === 'omp' ? 'config.yml' : 'settings.json'), JSON.stringify(privateSettings))
  env[provider === 'omp' ? 'PI_CODING_AGENT_DIR' : 'PRIME_AGENT_CODING_AGENT_DIR'] = config
  if (provider === 'prime') {
    // Prime 0.7.x routes print/json through its long-lived daemon by default.
    // A headless client owns that daemon session only until client disposal, so
    // an immediate fresh-process --resume can race the daemon's asynchronous
    // closingSessions drain. Prime's owned-worker frontend instead runs the
    // official session runtime in a child that is joined/reaped before the CLI
    // exits, releasing the session lease before a continuation can relaunch.
    // This also avoids leaving a controller-invisible daemon behind the owned
    // provider process.
    env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND = '1'
  }
  env.AUTOPROMPT_TOOL_POLICY = toolBoundary.policyPath
  env.AUTOPROMPT_TOOL_POLICY_SHA256 = toolBoundary.policySha256
  const responseFormat = requiredResponseFormat(outputSchema)
  if (responseFormat) {
    const schemaPath = path.join(config, 'controller-output-schema.json')
    const schemaBytes = Buffer.from(JSON.stringify(responseFormat.json_schema.schema), 'utf8')
    writePrivate(schemaPath, schemaBytes)
    env.AUTOPROMPT_PI_OUTPUT_SCHEMA = schemaPath
    env.AUTOPROMPT_PI_OUTPUT_SCHEMA_SHA256 = crypto.createHash('sha256').update(schemaBytes).digest('hex')
  }
  const cap = outputCap(connection, model || connection.model, maxTokens)
  if (cap) {
    if (cap.field) env.AUTOPROMPT_PI_OUTPUT_CAP_FIELD = cap.field
    env.AUTOPROMPT_PI_OUTPUT_CAP_VALUE = String(cap.value)
  }
  env.NO_COLOR = '1'; env.CI = '1'
  const argv = ['--print', '--mode', 'json', '--no-extensions', '--no-skills',
    '--extension', path.join(__dirname, 'harness-v2-bridge', 'pi', `${provider}.ts`),
    '--session-dir', sessions, '--thinking', effort || 'off', '--system-prompt', prompt]
  if (provider === 'omp') argv.push('--no-tools', '--no-rules', '--no-lsp', '--no-pty', '--no-title', '--no-prewalk', '--auto-approve')
  else argv.push('--no-builtin-tools', '--no-context-files', '--no-prompt-templates', '--offline')
  if (continuationId) argv.push('--resume', continuationId)
  if (nativeConnection.modelProvider) argv.push('--provider', nativeConnection.modelProvider)
  return { argv, requiredResponseFormat: responseFormat, requiredOutputCap: cap }
}

module.exports = { sanitize, readConnection, credentialNames, requiredResponseFormat, canonicalWireProjection, outputCap, nativeConnectionProjection, project }
