'use strict'

// Resolve the exact selected native connection before substituting a private
// quota endpoint. Never infer an SDK protocol from a provider's display name.
const native = require('./harness-v2-native.cjs')
const fail = message => { throw Object.assign(new Error(message), { code: 'PROFILE_INVALID' }) }

function quotaConnection(provider, source, selectedModel) {
  const connection = native.sanitizeConnection(provider, source)
  const model = selectedModel || connection.model
  if (typeof model !== 'string' || !model || model.length > 1024) fail('Owned quota execution requires one exact selected model')
  let wireModel = model
  let upstreamBaseUrl, protocol, replace
  const environmentKey = { claude: 'ANTHROPIC_BASE_URL', deepseek: 'DEEPSEEK_BASE_URL', hermes: 'HERMES_BASE_URL' }[provider]
  if (environmentKey) {
    if (provider === 'deepseek' && connection.modelProvider !== undefined && connection.modelProvider !== 'deepseek-official') fail('DeepSeek owned quota requires its reviewed deepseek-official native provider')
    upstreamBaseUrl = connection.environment?.[environmentKey]
    protocol = provider === 'claude' ? 'anthropic-messages' : 'chat-completions'
    replace = baseUrl => { connection.environment = { ...connection.environment, [environmentKey]: baseUrl } }
  } else if (provider === 'vscode') {
    upstreamBaseUrl = connection.baseUrl
    protocol = 'chat-completions'
    replace = baseUrl => { connection.baseUrl = baseUrl }
  } else if (['opencode', 'kilo'].includes(provider)) {
    const slash = typeof model === 'string' ? model.indexOf('/') : -1
    if (slash < 1) fail('Owned quota execution requires an explicit provider/model selection')
    const providerId = model.slice(0, slash), modelId = model.slice(slash + 1)
    const selected = Object.hasOwn(connection.providers || {}, providerId) ? connection.providers[providerId] : undefined
    if (!selected || selected.models !== undefined && !Object.hasOwn(selected.models, modelId)) {
      fail('Owned quota execution requires the exact selected provider/model connection')
    }
    upstreamBaseUrl = selected.options?.baseURL
    protocol = { '@ai-sdk/openai-compatible': 'chat-completions', '@ai-sdk/openai': 'responses', '@ai-sdk/anthropic': 'anthropic-messages' }[selected.npm]
    // No alternative provider remains available to native fallback selection.
    connection.providers = { [providerId]: selected }
    // OpenCode/Kilo's reviewed declarative selector is `provider/model`, while
    // the selected SDK sends the exact configured model suffix on the wire.
    // This is an adapter-specific projection, not prefix stripping for other
    // native providers or arbitrary model aliases.
    // The pinned native SDK uses a selected declaration's explicit `id` as
    // the provider request model when present.  Otherwise its selector key is
    // the exact wire value. Both values are already copied through the closed
    // native connection sanitizer; no provider or vendor alias is inferred.
    wireModel = selected.models?.[modelId]?.id || modelId
    if (!wireModel) fail('Owned quota execution requires an explicit provider/model selection')
    replace = baseUrl => { selected.options.baseURL = baseUrl }
  } else if (['prime', 'omp'].includes(provider)) {
    const { selectedModelDefinition } = require('./harness-v2-pi-config.cjs')
    const selection = selectedModelDefinition(connection, model)
    const providerId = selection.providerId, selected = connection.providers?.[providerId]
    const definition = selection.definition
    if (!selected || !definition) fail('Owned quota execution requires an explicit Pi model definition')
    wireModel = definition.id
    upstreamBaseUrl = definition.baseUrl || selected.baseUrl
    protocol = { 'openai-completions': 'chat-completions', 'openai-responses': 'responses', 'anthropic-messages': 'anthropic-messages' }[definition.api || selected.api]
    connection.providers = { [providerId]: { ...selected, models: [definition] } }
    replace = baseUrl => {
      connection.providers[providerId].baseUrl = baseUrl
      definition.baseUrl = baseUrl
    }
  } else fail('Provider has no reviewed owned quota connection projection')
  if (!protocol || !upstreamBaseUrl) fail('Owned quota execution requires an explicit supported wire protocol and upstream URL')
  const parsed = new URL(upstreamBaseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail('Owned quota upstream must be an explicit HTTP base URL')
  return Object.freeze({ upstreamBaseUrl, protocol, wireModel, project(baseUrl) { replace(baseUrl); return connection } })
}

module.exports = { quotaConnection }
