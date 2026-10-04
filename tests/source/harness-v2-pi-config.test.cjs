'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { bindOpenAIResponseFormat } = require('../../scripts/harness-v2-bridge/pi/controller.cjs')
const { canonicalWireProjection, outputCap, nativeConnectionProjection } = require('../../scripts/harness-v2-pi-config.cjs')
const { nativeOutcomeDescriptionProjection } = require('../../scripts/harness-v2-native-wire-projection.cjs')
const { decodeNativeWireOutput } = require('../../scripts/harness-v2-transport.cjs')
const { validateJsonSchema } = require('../../agents/codex/workflow/json-schema-validator.js')

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pi-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function connection() {
  return { modelProvider: 'gateway', model: 'local-model', providers: { gateway: {
    baseUrl: 'http://127.0.0.1:12345/v1', api: 'openai-completions', apiKey: 'COMPANY_GATEWAY_KEY',
    models: [{ id: 'local-model', name: 'Local model', reasoning: false, input: ['text'],
      contextWindow: 32768, maxTokens: 2048, compat: { supportsUsageInStreaming: true } }],
  } } }
}
for (const provider of ['prime', 'omp']) {
  test(`${provider} imports native array-shaped model data without executable configuration`, () => {
    const source = { ...connection(), extensions: ['untrusted.ts'], hooks: { beforeAgent: 'untrusted' } }
    source.providers.gateway.command = 'never execute'
    source.providers.gateway.npm = 'untrusted-plugin'
    const actual = native.sanitizeConnection(provider, source)
    assert.deepEqual(actual, { provider, environment: {}, ...connection() })
    assert.deepEqual(native.credentialEnvironment(provider, actual, null, {
      COMPANY_GATEWAY_KEY: 'private-fixture-key', NODE_OPTIONS: '--import=untrusted', OTHER_SECRET: 'must-not-pass',
    }), { COMPANY_GATEWAY_KEY: 'private-fixture-key' })
  })
  test(`${provider} rejects command credentials and malformed model registry data`, () => {
    for (const change of [
      source => { source.providers.gateway.apiKey = '!printf stolen' },
      source => { source.providers.gateway.headers = { Authorization: '!read-secret' } },
      source => { source.providers.gateway.baseUrl = 'https://name:secret@example.test/v1' },
      source => { source.providers.gateway.models = { 'local-model': {} } },
      source => { source.providers.gateway.models.push(source.providers.gateway.models[0]) },
      source => { source.providers.gateway.models[0].maxTokens = 0 },
      source => { source.providers.gateway.models[0].compat.supportsUsageInStreaming = 'yes' },
    ]) {
      const source = connection(); change(source)
      assert.throws(() => native.sanitizeConnection(provider, source), { code: 'PROFILE_INVALID' })
    }
    assert.throws(() => native.sanitizeConnection(provider, JSON.parse('{"providers":{"__proto__":{}}}')), { code: 'PROFILE_INVALID' })
  })
}

test('Pi quota cap preserves a native cap spelling, lowers it to the controller ceiling, and only inserts an explicit model mapping', () => {
  const mapped = connection()
  mapped.providers.gateway.models[0].compat.maxTokensField = 'max_completion_tokens'
  assert.deepEqual(outputCap(mapped, 'local-model', 4096), { field: 'max_completion_tokens', value: 2048 })
  const responseFormat = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: { type: 'object' } } }
  assert.deepEqual(bindOpenAIResponseFormat({ model: 'fixture', messages: [], max_tokens: 1000 }, responseFormat,
    { field: 'max_completion_tokens', value: 2048 }), { model: 'fixture', messages: [], max_tokens: 1000, response_format: responseFormat })
  assert.deepEqual(bindOpenAIResponseFormat({ model: 'fixture', messages: [] }, responseFormat,
    { field: 'max_completion_tokens', value: 2048 }), { model: 'fixture', messages: [], response_format: responseFormat, max_completion_tokens: 2048 })
  assert.throws(() => bindOpenAIResponseFormat({ model: 'fixture', messages: [], max_tokens: 1, max_completion_tokens: 1 }, responseFormat,
    { field: 'max_completion_tokens', value: 2048 }), { code: 'PROVIDER_UNSUPPORTED' })
  assert.throws(() => bindOpenAIResponseFormat({ model: 'fixture', messages: [], max_tokens: 0 }, responseFormat,
    { field: 'max_completion_tokens', value: 2048 }), { code: 'PROVIDER_UNSUPPORTED' })
  const unmapped = connection()
  assert.deepEqual(outputCap(unmapped, 'local-model', 4096), { field: null, value: 2048 })
  assert.throws(() => bindOpenAIResponseFormat({ model: 'fixture', messages: [] }, responseFormat,
    { field: null, value: 2048 }), { code: 'PROVIDER_UNSUPPORTED' })
})

test('OMP imports its actual YAML registry while rejecting duplicate keys, custom tags and alias expansion', t => {
  const dir = root(t), file = path.join(dir, 'models.yml')
  fs.writeFileSync(file, 'providers:\n  gateway:\n    baseUrl: http://127.0.0.1:12345/v1\n    api: openai-completions\n    apiKey: COMPANY_GATEWAY_KEY\n    models:\n      - id: local-model\n        contextWindow: 32768\n')
  assert.equal(native.connectionConfig('omp', dir).providers.gateway.models[0].contextWindow, 32768)
  for (const invalid of [
    'providers: {}\nproviders: {}\n',
    'providers: !external/command {}\n',
    'a: &a [1, 2]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a]\nproviders: [*b, *b, *b, *b, *b, *b, *b, *b]\n',
  ]) {
    fs.writeFileSync(file, invalid)
    assert.throws(() => native.connectionConfig('omp', dir), { code: 'PROFILE_INVALID' })
  }
})

test('OMP production launch projects only its verified extension and bounded native registry', t => {
  const dir = root(t), target = path.join(dir, 'target'), scratch = path.join(dir, 'scratch'), control = path.join(dir, 'control')
  for (const location of [target, scratch, control]) fs.mkdirSync(location, { mode: 0o700 })
  const hostileConnection = { ...connection(), extensionHandlers: { toolCallTimeoutMs: 1 } }
  const prepared = boundary.prepareBoundary({ provider: 'omp', root: control, policy: {
    sessionId: 'test-session', reservationId: 'test-reservation', targetPath: target, scratchPath: scratch,
    readableRoots: [target, scratch], writableRoots: [scratch], readOnly: true,
    commandBoundary: true, nestedDispatch: false, externalWrites: false,
  } })
  const spec = native.createLaunch({ provider: 'omp', home: path.join(dir, 'home'), sessionRoot: path.join(dir, 'session'),
    targetPath: target, cwd: path.join(dir, 'cwd'), prompt: 'Bounded assignment', input: 'Read only', connection: hostileConnection,
    toolBoundary: prepared, readOnly: true, commandBoundary: true, credentials: { COMPANY_GATEWAY_KEY: 'fixture-key' },
    environment: { PATH: process.env.PATH, NODE_OPTIONS: '--import=untrusted' } })
  for (const flag of ['--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-title', '--no-prewalk']) assert.ok(spec.argv.includes(flag), flag)
  assert.equal(spec.argv[spec.argv.indexOf('--extension') + 1], path.resolve(__dirname, '../../scripts/harness-v2-bridge/pi/omp.ts'))
  assert.equal(spec.argv[spec.argv.indexOf('--provider') + 1], 'gateway')
  assert.equal(spec.env.COMPANY_GATEWAY_KEY, 'fixture-key')
  assert.equal(spec.env.NODE_OPTIONS, undefined)
  assert.equal(spec.env.AUTOPROMPT_TOOL_POLICY_SHA256, prepared.policySha256)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spec.env.PI_CODING_AGENT_DIR, 'models.yml'))), { providers: connection().providers })
  const ompConfig = JSON.parse(fs.readFileSync(path.join(spec.env.PI_CODING_AGENT_DIR, 'config.yml')))
  assert.deepEqual(ompConfig.extensionHandlers, { toolCallTimeoutMs: 180000 })
  assert.equal(ompConfig.extensionHandlers.toolCallTimeoutMs, 180000)
})

test('OMP privately aliases only its built-in OpenRouter provider while preserving the configured model binding', () => {
  const selected = { modelProvider: 'openrouter', model: 'openai/gpt-5.6-luna', providers: { openrouter: {
    baseUrl: 'http://127.0.0.1:12345/v1', api: 'openai-completions', apiKey: 'OPENROUTER_API_KEY', models: [{
      id: 'openai/gpt-5.6-luna', name: 'openai/gpt-5.6-luna', reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 4096,
    }],
  } } }
  const projected = nativeConnectionProjection('omp', selected)
  assert.equal(projected.modelProvider, 'autoprompt_openrouter')
  assert.equal(projected.model, selected.model)
  assert.strictEqual(projected.providers.openrouter, selected.providers.openrouter)
  assert.strictEqual(projected.providers.autoprompt_openrouter, selected.providers.openrouter)
  assert.equal(selected.modelProvider, 'openrouter')
  assert.strictEqual(nativeConnectionProjection('prime', selected), selected)
})

test('Prime production launch uses its owned worker with only the explicit controller extension', t => {
  const dir = root(t), target = path.join(dir, 'target'), scratch = path.join(dir, 'scratch'), control = path.join(dir, 'control')
  for (const location of [target, scratch, control]) fs.mkdirSync(location, { mode: 0o700 })
  const prepared = boundary.prepareBoundary({ provider: 'prime', root: control, policy: {
    sessionId: 'test-session', reservationId: 'test-reservation', targetPath: target, scratchPath: scratch,
    readableRoots: [target, scratch], writableRoots: [scratch], readOnly: true,
    commandBoundary: true, nestedDispatch: false, externalWrites: false,
  } })
  const spec = native.createLaunch({ provider: 'prime', home: path.join(dir, 'home'), sessionRoot: path.join(dir, 'session'),
    targetPath: target, cwd: path.join(dir, 'cwd'), prompt: 'Bounded assignment', input: 'Read only', connection: connection(),
    toolBoundary: prepared, readOnly: true, commandBoundary: true, credentials: { COMPANY_GATEWAY_KEY: 'fixture-key' },
    environment: { PATH: process.env.PATH, NODE_OPTIONS: '--import=untrusted' } })
  for (const flag of ['--no-builtin-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--offline']) {
    assert.ok(spec.argv.includes(flag), flag)
  }
  assert.equal(spec.argv.includes('--no-tools'), false)
  assert.equal(spec.env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND, '1')
  assert.equal(spec.argv[spec.argv.indexOf('--extension') + 1], path.resolve(__dirname, '../../scripts/harness-v2-bridge/pi/prime.ts'))
  assert.equal(spec.argv[spec.argv.indexOf('--provider') + 1], 'gateway')
  assert.equal(spec.env.COMPANY_GATEWAY_KEY, 'fixture-key')
  assert.equal(spec.env.NODE_OPTIONS, undefined)
  assert.equal(spec.env.AUTOPROMPT_TOOL_POLICY_SHA256, prepared.policySha256)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spec.env.PRIME_AGENT_CODING_AGENT_DIR, 'models.json'))), { providers: connection().providers })
  const primeSettings = JSON.parse(fs.readFileSync(path.join(spec.env.PRIME_AGENT_CODING_AGENT_DIR, 'settings.json')))
  assert.equal(Object.hasOwn(primeSettings, 'extensionHandlers'), false)
})

for (const provider of ['prime', 'omp']) {
  test(`${provider} binds a private canonical result schema through its OpenAI request hook`, t => {
    const dir = root(t), target = path.join(dir, 'target'), scratch = path.join(dir, 'scratch'), control = path.join(dir, 'control')
    for (const location of [target, scratch, control]) fs.mkdirSync(location, { mode: 0o700 })
    const toolBoundary = boundary.prepareBoundary({ provider, root: control, policy: { sessionId: 'schema-session', reservationId: 'schema-reservation', targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch], readOnly: true, commandBoundary: true, nestedDispatch: false, externalWrites: false } })
    const outputSchema = { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }
    const spec = native.createLaunch({ provider, home: path.join(dir, 'home'), sessionRoot: path.join(dir, 'session'), targetPath: target, cwd: target, prompt: 'Return one result.', input: '{}', connection: connection(), toolBoundary, readOnly: true, commandBoundary: true, credentials: { COMPANY_GATEWAY_KEY: 'fixture-key' }, environment: { PATH: process.env.PATH }, outputSchema })
    const expected = { type: 'json_schema', json_schema: { name: 'autoprompt_result', strict: true, schema: outputSchema } }
    assert.deepEqual(spec.requiredResponseFormat, expected)
    const schemaPath = spec.env.AUTOPROMPT_PI_OUTPUT_SCHEMA
    assert.ok(path.isAbsolute(schemaPath)); assert.match(spec.env.AUTOPROMPT_PI_OUTPUT_SCHEMA_SHA256, /^[a-f0-9]{64}$/)
    assert.deepEqual(JSON.parse(fs.readFileSync(schemaPath, 'utf8')), outputSchema)
    assert.deepEqual(bindOpenAIResponseFormat({ model: 'fixture', messages: [] }, expected), { model: 'fixture', messages: [], response_format: expected })
    assert.throws(() => bindOpenAIResponseFormat({ model: 'fixture', input: [] }, expected), { code: 'PROVIDER_UNSUPPORTED' })
  })
}

test('Pi canonical wire envelope is closed, lossless, and rejects invalid or prose-shaped values', () => {
  const canonical = { type: 'object', allOf: [{ $ref: '#/$defs/base' }], $defs: { base: { type: 'object' } } }
  const wire = canonicalWireProjection(canonical)
  assert.deepEqual(wire.wireSchema, {
    type: 'object', properties: { canonicalJson: { type: 'string' } }, required: ['canonicalJson'], additionalProperties: false,
  })
  const value = { nested: { contradiction: ['kept', false] }, branch: 'exact' }
  assert.deepEqual(wire.toCanonical({ canonicalJson: JSON.stringify(value) }), value)
  for (const invalid of [
    {}, { canonicalJson: '{}' , extra: true }, { canonicalJson: 'not json' }, { canonicalJson: '[]' }, { canonicalJson: 1 },
  ]) assert.throws(() => wire.toCanonical(invalid), { code: 'NATIVE_WIRE_PROJECTION_INVALID' })
  assert.match(wire.metadata.canonicalSchemaSha256, /^[a-f0-9]{64}$/)
  assert.match(wire.metadata.wireSchemaSha256, /^[a-f0-9]{64}$/)
})

test('Pi envelope composes with the checker description projection after inner decode', () => {
  const outcomeSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/contracts/schemas/outcome.schema.json'), 'utf8'))
  const record = { logicalRole: 'independent-checker', providerRole: 'ap-independent-checker' }
  const outcome = nativeOutcomeDescriptionProjection(record, outcomeSchema)
  assert.ok(outcome)
  const envelope = canonicalWireProjection(outcome.wireSchema)
  const hash = 'a'.repeat(64)
  const inner = { schemaVersion: '2.0.0', code: 'PASS', stateClass: 'terminal', runId: 'check-run-1',
    requestEnvelopeHash: hash, currentVersionHash: hash, completedResults: [], nextReadyWork: [],
    cause: { event: 'CHECK_COMPLETE', reason: 'The assigned check completed.', unblockPath: null },
    payloadSchemaId: 'autoprompt.independent-check.v2', payload: {}, recordedAt: '2026-09-08T00:00:00.000Z' }
  const outer = { canonicalJson: JSON.stringify(inner) }
  const canonical = decodeNativeWireOutput(outer, envelope, outcome)
  assert.equal(canonical.description, outcome.descriptionByCode.PASS)
  assert.equal(validateJsonSchema(outcomeSchema, canonical).valid, true)
  const conflicting = { ...inner, description: 'model-selected contradiction' }
  assert.throws(() => decodeNativeWireOutput({ canonicalJson: JSON.stringify(conflicting) }, envelope, outcome), { code: 'CHILD_RESULT_INVALID' })
})
