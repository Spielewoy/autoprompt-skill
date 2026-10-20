'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { quotaConnection } = require('../../scripts/harness-v2-quota-connection.cjs')
const upstream = 'https://example.com/api/v1', relay = 'http://127.0.0.1:1234/private'

test('quota connection rewrites explicit native URLs without mutating the original', () => {
  for (const [provider, key, protocol] of [['claude', 'ANTHROPIC_BASE_URL', 'anthropic-messages'], ['deepseek', 'DEEPSEEK_BASE_URL', 'chat-completions'], ['hermes', 'HERMES_BASE_URL', 'chat-completions']]) {
    const source = { model: 'model', environment: { [key]: upstream } }
    const projection = quotaConnection(provider, source)
    assert.equal(projection.protocol, protocol)
    assert.equal(projection.wireModel, 'model')
    assert.equal(projection.upstreamBaseUrl, upstream)
    assert.equal(projection.project(relay).environment[key], relay)
    assert.equal(source.environment[key], upstream)
  }
  const projection = quotaConnection('vscode', { model: 'model', baseUrl: upstream })
  assert.equal(projection.wireModel, 'model')
  assert.equal(projection.project(relay).baseUrl, relay)
})

test('quota connection admits only the selected declarative OpenCode SDK provider', () => {
  for (const provider of ['opencode', 'kilo']) {
    for (const [npm, protocol] of [['@ai-sdk/openai-compatible', 'chat-completions'], ['@ai-sdk/openai', 'responses'], ['@ai-sdk/anthropic', 'anthropic-messages']]) {
      const source = { model: 'owned/model', providers: { owned: { npm, options: { baseURL: upstream }, models: { model: { limit: { output: 4096 } } } }, other: { npm, options: { baseURL: 'https://other.invalid' } } } }
      const projection = quotaConnection(provider, source)
      assert.equal(projection.protocol, protocol)
      assert.equal(projection.wireModel, 'model')
      const result = projection.project(relay)
      assert.deepEqual(Object.keys(result.providers), ['owned'])
      assert.equal(result.providers.owned.options.baseURL, relay)
      assert.equal(source.providers.owned.options.baseURL, upstream)
    }
  }
})

test('quota Pi projection rewrites model overrides and excludes other model routes', () => {
  for (const provider of ['prime', 'omp']) {
    const source = { model: 'chosen', modelProvider: 'owned', providers: { owned: { baseUrl: 'https://unused.invalid', api: 'openai-completions', models: [{ id: 'chosen', baseUrl: upstream, api: 'openai-responses' }, { id: 'other', baseUrl: 'https://other.invalid' }] } } }
    const projection = quotaConnection(provider, source)
    assert.equal(projection.protocol, 'responses')
    assert.equal(projection.upstreamBaseUrl, upstream)
    assert.equal(projection.wireModel, 'chosen')
    const result = projection.project(relay)
    assert.equal(result.providers.owned.baseUrl, relay)
    assert.deepEqual(result.providers.owned.models.map(item => item.id), ['chosen'])
    assert.equal(result.providers.owned.models[0].baseUrl, relay)
    assert.equal(source.providers.owned.models[0].baseUrl, upstream)
  }
})

test('quota connection maps only an exact configured OpenCode/Kilo selector to its wire model', () => {
  const source = { model: 'openrouter/openai/gpt-5.6-luna', providers: { openrouter: {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: upstream }, models: { 'openai/gpt-5.6-luna': { limit: { output: 4096 } } },
  } } }
  for (const provider of ['opencode', 'kilo']) {
    const projection = quotaConnection(provider, source)
    assert.equal(projection.wireModel, 'openai/gpt-5.6-luna')
  }
  const declared = structuredClone(source)
  declared.model = 'openrouter/selector'
  declared.providers.openrouter.models = { selector: { id: 'openai/gpt-5.6-luna', limit: { output: 4096 } } }
  assert.equal(quotaConnection('kilo', declared).wireModel, 'openai/gpt-5.6-luna')
  const invalidId = structuredClone(declared); invalidId.providers.openrouter.models.selector.id = ''
  assert.throws(() => quotaConnection('kilo', invalidId), { code: 'PROFILE_INVALID' })
  const missing = structuredClone(source)
  assert.throws(() => quotaConnection('kilo', missing, 'openrouter/different-provider/different-model'), { code: 'PROFILE_INVALID' })
  assert.throws(() => quotaConnection('kilo', missing, 'other/openai/gpt-5.6-luna'), { code: 'PROFILE_INVALID' })
})

test('quota connection refuses unspecified upstreams and unreviewed protocols', () => {
  assert.throws(() => quotaConnection('deepseek', { modelProvider: 'other', environment: { DEEPSEEK_BASE_URL: upstream } }), { code: 'PROFILE_INVALID' })
  for (const provider of ['claude', 'deepseek', 'hermes', 'prime', 'omp', 'opencode', 'kilo']) assert.throws(() => quotaConnection(provider, {}), { code: 'PROFILE_INVALID' })
  assert.throws(() => quotaConnection('prime', { model: 'm', modelProvider: 'p', providers: { p: { baseUrl: upstream, api: 'google-generative-ai', models: [{ id: 'm' }] } } }), { code: 'PROFILE_INVALID' })
  assert.throws(() => quotaConnection('opencode', { model: 'p/m', providers: { p: { options: { baseURL: upstream } } } }), { code: 'PROFILE_INVALID' })
})

test('quota OMP projection resolves a prefixed selection against a single-provider registry', () => {
  const source = { providers: { owned: { baseUrl: 'https://unused.invalid', api: 'openai-completions',
    models: [{ id: 'chosen', baseUrl: upstream, api: 'openai-responses' }] } } }
  const projection = quotaConnection('omp', source, 'owned/chosen')
  assert.equal(projection.protocol, 'responses')
  assert.equal(projection.wireModel, 'chosen')
  assert.equal(projection.upstreamBaseUrl, upstream)
  const result = projection.project(relay)
  assert.deepEqual(Object.keys(result.providers), ['owned'])
  assert.equal(result.providers.owned.models.length, 1)
  assert.equal(result.providers.owned.models[0].baseUrl, relay)
  assert.equal(source.providers.owned.models[0].baseUrl, upstream)
})
