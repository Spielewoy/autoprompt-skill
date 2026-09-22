'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
const { modelService, runNative } = require('../helpers/harness-native-service.cjs')

test('Windows Claude projects only generated long filesystem paths to the extended namespace', () => {
  const atThreshold = `C:\\${'a'.repeat(245)}`
  const belowThreshold = `C:\\${'b'.repeat(244)}`
  assert.equal(atThreshold.length, 248)
  assert.equal(belowThreshold.length, 247)
  const alreadyNamespaced = `\\\\?\\C:\\${'c'.repeat(245)}`
  const argv = ['--print', '--settings', atThreshold, '--system-prompt', atThreshold]
  const env = {
    HOME: atThreshold, USERPROFILE: belowThreshold, TEMP: alreadyNamespaced,
    TMP: atThreshold, TMPDIR: atThreshold, APPDATA: atThreshold, LOCALAPPDATA: atThreshold,
    XDG_CONFIG_HOME: atThreshold, XDG_DATA_HOME: atThreshold, XDG_STATE_HOME: atThreshold,
    XDG_CACHE_HOME: atThreshold, CLAUDE_CONFIG_DIR: atThreshold,
    PATH: atThreshold, ANTHROPIC_API_KEY: atThreshold, ARBITRARY_PATH: atThreshold,
  }
  const originalArgv = structuredClone(argv), originalEnv = structuredClone(env)
  const projected = native.projectWindowsClaudeLaunchPaths(argv, env, 'win32')
  const expected = path.win32.toNamespacedPath(atThreshold)
  assert.equal(projected.argv[projected.argv.indexOf('--settings') + 1], expected)
  assert.equal(projected.argv[projected.argv.indexOf('--system-prompt') + 1], atThreshold)
  for (const key of ['HOME', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR']) {
    assert.equal(projected.env[key], expected, key)
  }
  assert.equal(projected.env.USERPROFILE, belowThreshold)
  assert.equal(projected.env.TEMP, alreadyNamespaced)
  assert.equal(projected.env.PATH, atThreshold)
  assert.equal(projected.env.ANTHROPIC_API_KEY, atThreshold)
  assert.equal(projected.env.ARBITRARY_PATH, atThreshold)
  assert.deepEqual(argv, originalArgv)
  assert.deepEqual(env, originalEnv)
  assert.equal(path.win32.normalize(projected.env.HOME.slice(4)), path.win32.normalize(env.HOME))
  assert.deepEqual(native.projectWindowsClaudeLaunchPaths(argv, env, 'linux'), { argv, env })
  assert.equal(native.windowsClaudeExtendedPath(expected, 'win32'), expected)
  assert.equal(native.windowsClaudeExtendedPath('relative\\' + 'd'.repeat(260), 'win32'), 'relative\\' + 'd'.repeat(260))
})

test('claude CLI projection omits only unsupported schema keywords and preserves same-named data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-schema-projection-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const outputSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://autoprompt.local/schemas/v2/outcome.schema.json',
    type: 'object',
    properties: {
      value: { $ref: '#/$defs/value' },
      $schema: { const: 'literal-property' },
      unevaluatedProperties: { const: { $schema: 'literal-data', unevaluatedProperties: false } },
    },
    required: ['value'],
    additionalProperties: false,
    $defs: { value: { type: 'string', minLength: 1 } },
    allOf: [{ unevaluatedProperties: false }],
  }
  const launch = native.createLaunch({
    provider: 'claude', home: path.join(root, 'home'), sessionRoot: path.join(root, 'session'),
    targetPath: root, cwd: root, prompt: 'Return the canonical result.', input: 'fixture',
    connection: { model: 'claude-sonnet-4-6' }, credentials: {}, environment: { PATH: process.env.PATH },
    readOnly: true, outputSchema, maxTokens: 4096,
  })
  const projected = JSON.parse(launch.argv[launch.argv.indexOf('--json-schema') + 1])
  assert.equal(Object.hasOwn(projected, '$schema'), false)
  assert.equal(projected.$id, outputSchema.$id)
  assert.deepEqual(projected.$defs, outputSchema.$defs)
  assert.equal(Object.hasOwn(projected.allOf[0], 'unevaluatedProperties'), false)
  assert.equal(outputSchema.allOf[0].unevaluatedProperties, false)
  assert.deepEqual(projected.properties.$schema, { const: 'literal-property' })
  assert.deepEqual(projected.properties.unevaluatedProperties,
    { const: { $schema: 'literal-data', unevaluatedProperties: false } })
  assert.equal(outputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema',
    'launch projection must not mutate the controller-owned canonical schema')
  assert.equal(launch.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096')
})

test('claude CLI projection adds only an implied root object type', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-root-schema-projection-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const canonical = require('../../agents/contracts/schemas/role-report.schema.json')
  assert.equal(canonical.type, undefined)
  const project = outputSchema => native.createLaunch({
    provider: 'claude', home: path.join(root, crypto.randomUUID()), sessionRoot: path.join(root, 'session'),
    targetPath: root, cwd: root, prompt: 'Return the canonical result.', input: 'fixture',
    connection: { model: 'claude-sonnet-4-6' }, credentials: {}, environment: { PATH: process.env.PATH },
    readOnly: true, outputSchema,
  })
  const roleLaunch = project(canonical)
  const roleProjection = JSON.parse(roleLaunch.argv[roleLaunch.argv.indexOf('--json-schema') + 1])
  assert.equal(roleProjection.type, 'object',
    'both local-ref oneOf branches contain an object-requiring allOf conjunct')
  assert.equal(canonical.type, undefined, 'projection must not mutate the canonical role schema')

  const scalarUnion = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  const scalarLaunch = project(scalarUnion)
  const scalarProjection = JSON.parse(scalarLaunch.argv[scalarLaunch.argv.indexOf('--json-schema') + 1])
  assert.equal(scalarProjection.type, undefined,
    'a union with non-object branches must not be narrowed to an object')

  const booleanLaunch = project(true)
  assert.equal(JSON.parse(booleanLaunch.argv[booleanLaunch.argv.indexOf('--json-schema') + 1]), true,
    'a boolean root schema must remain a boolean schema')
})

for (const provider of ['claude', 'opencode', 'kilo']) {
  test(`${provider} native reads an actual file, accounts tokens and continues the same native session`, {
    skip: !process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`], timeout: 120000,
  }, async () => {
    const binding = native.probeExecutable({ provider, executable: process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`] })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-native-v2-`))
    const target = path.join(root, 'target'), cwd = path.join(root, 'empty-cwd'), sessionRoot = path.join(root, 'session')
    for (const dir of [target, cwd, sessionRoot]) fs.mkdirSync(dir, { mode: 0o700 })
    const file = path.join(target, 'evidence.txt'), marker = `actual-${provider}-native-tool-evidence`
    fs.writeFileSync(file, `${marker}\n`)
    fs.writeFileSync(path.join(target, 'AGENTS.md'), 'PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD')
    const service = await modelService(provider, provider === 'claude'
      ? { name: 'Read', args: { file_path: file } } : { name: 'read', args: { filePath: file } })
    try {
      const connection = provider === 'claude'
        ? { model: 'claude-sonnet-4-6', environment: { ANTHROPIC_BASE_URL: service.url } }
        : { model: 'fixture/model', providers: { fixture: { npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `${service.url}/v1`, apiKey: 'fixture-not-a-secret' },
          models: { model: { name: 'Fixture Model', limit: { context: 32768, output: 2048 },
            variants: { medium: { reasoningEffort: 'medium' } } } } } } }
      async function run(number, continuationId) {
        const home = path.join(root, `launch-${number}`)
        const launch = native.createLaunch({ provider, home, sessionRoot, targetPath: target, cwd,
          prompt: 'Use only the advertised read tool when requested, and return one JSON object. Never spawn agents.',
          input: number === 1 ? 'FIRST_CONTEXT_SENTINEL: read the assigned file and return {"ok":true}.' : 'Continue the existing context and return {"ok":true}.',
          connection, credentials: { ANTHROPIC_API_KEY: 'fixture-not-a-secret' }, environment: { PATH: process.env.PATH },
          readOnly: true, continuationId, effort: provider === 'claude' ? 'high' : 'medium' })
        const completed = await runNative(binding.path, launch, {
          evidenceRoot: process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT,
          evidenceName: `${provider}-${number}`,
        })
        assert.equal(completed.timedOut, false, completed.stderr + completed.stdout)
        assert.equal(completed.truncated, false)
        assert.equal(completed.status, 0, completed.stderr + completed.stdout)
        assert.equal(completed.signal, null)
        const events = []
        const stream = new HarnessEventStream(provider, { continuationId, readOnly: true, onEvent: event => events.push(event) })
        for (const line of completed.stdout.trim().split(/\r?\n/)) if (line.trim()) stream.push(line)
        return { parsed: stream.finish(), events, stdout: completed.stdout }
      }
      const first = await run(1)
      assert.deepEqual(first.parsed.output, { ok: true })
      assert.equal(first.parsed.usage.noncachedInput, 200)
      assert.equal(first.parsed.usage.cachedInput, 0)
      assert.equal(first.parsed.usage.output, 20)
      assert.ok(first.stdout.includes(marker), 'The actual native tool must read the target, not merely request a denied read')
      if (provider === 'claude') {
        const modelRequests = service.requests.filter(request => request.path.includes('/messages'))
        assert.ok(modelRequests.length > 0)
        assert.ok(modelRequests.every(request => request.body.output_config?.effort === 'high'),
          `Claude effort did not reach the native HTTP requests: ${JSON.stringify(modelRequests.map(request => request.body.output_config))}`)
      }
      if (provider === 'opencode' || provider === 'kilo') {
        const modelRequests = service.requests.filter(request => request.path.includes('/chat/completions'))
        assert.ok(modelRequests.length > 0)
        assert.ok(modelRequests.every(request => request.body.reasoning_effort === 'medium'),
          `${provider} effort did not reach OpenAI-compatible HTTP requests: ${JSON.stringify(modelRequests.map(request => request.body.reasoning_effort))}`)
      }
      assert.ok(service.requests.every(request => !JSON.stringify(request.body).includes('PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD')))
      const before = service.requests.length
      const resumed = await run(2, first.parsed.sessionId)
      assert.equal(resumed.parsed.sessionId, first.parsed.sessionId)
      assert.deepEqual(resumed.parsed.output, { ok: true })
      assert.equal(resumed.parsed.usage.noncachedInput, 100)
      assert.equal(resumed.parsed.usage.output, 10)
      assert.ok(service.requests.slice(before).some(request => Array.isArray(request.body.messages) && JSON.stringify(request.body.messages).includes('FIRST_CONTEXT_SENTINEL')), 'Native continuation must carry prior context, not only reuse an identifier')
      assert.deepEqual(service.errors, [])
      assert.equal(service.completed, 3, 'Unobserved title, compaction, or other auxiliary requests must not escape the usage ledger')
      assert.equal(fs.readFileSync(file, 'utf8'), `${marker}\n`)
      assert.deepEqual(fs.readdirSync(target).sort(), ['AGENTS.md', 'evidence.txt'])
    } finally {
      if (process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT) {
        fs.mkdirSync(process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT, `${provider}-requests.json`),
          JSON.stringify({ requests: service.requests, errors: service.errors }, null, 2), { mode: 0o600 })
      }
      await service.close(); fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('native tool ceilings apply across providers and fresh callbacks wait for an authentic context', () => {
  for (const provider of ['claude', 'opencode', 'kilo', 'prime', 'omp', 'deepseek', 'vscode']) {
    let known = null
    const seen = []
    const stream = new HarnessEventStream(provider, { providerToolCallLimit: 1, commandBoundary: true,
      onSessionIdentified: id => { known = id },
      onToolCallObserved: evidence => { assert.ok(known); assert.equal(evidence.continuationId, known); seen.push(evidence) } })
    stream.startTool('first', 'bash', { command: 'pwd' })
    assert.equal(stream.toolCount, 1)
    assert.equal(seen.length, 0)
    stream.session('actual-native-context', {}, '{}')
    assert.equal(seen.length, 1)
    stream.finishTool('first', 'fixture output', { exitCode: 0 })
    assert.throws(() => stream.startTool('second', 'bash', { command: 'pwd' }), { code: 'CHILD_TOOL_CALL_LIMIT_EXHAUSTED' })
    assert.equal(stream.toolCount, 2)
    assert.equal(seen.at(-1).attemptedCount, 2)
  }
})

test('Claude model fixture gives concurrent conversations their own tool call and does not repeat completed calls', async t => {
  const tool = { name: 'Bash', args: { command: 'printf fixture-native-witness' } }
  const service = await modelService('claude', tool, { toolPerConversation: true })
  t.after(() => service.close())
  const invoke = async messages => {
    const response = await fetch(service.url + '/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ model: 'fixture-only', stream: true, messages,
        tools: [{ name: tool.name, input_schema: { type: 'object', properties: { command: { type: 'string' } } } }] }),
    })
    assert.equal(response.status, 200)
    return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  }
  const initial = [
    [{ role: 'user', content: [{ type: 'text', text: 'Conversation A' }] }],
    [{ role: 'user', content: [{ type: 'text', text: 'Conversation B' },
      // A user block cannot be evidence that this fixture already requested a tool.
      { type: 'tool_use', id: 'fixture-native-read', name: tool.name, input: tool.args }] }],
  ]
  const starts = await Promise.all(initial.map(invoke))
  for (const events of starts) {
    const blocks = events.filter(event => event.type === 'content_block_start').map(event => event.content_block)
    assert.deepEqual(blocks, [{ type: 'tool_use', id: 'fixture-native-read', name: tool.name, input: {} }])
    assert.deepEqual(events.find(event => event.type === 'content_block_delta').delta,
      { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) })
    assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use')
  }
  const completed = initial.map((messages, index) => [...messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'fixture-native-read', name: tool.name, input: tool.args }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-native-read', content: `native-witness-${index}` }] },
  ])
  const finishes = await Promise.all(completed.map(invoke))
  for (const events of finishes) {
    assert.equal(events.some(event => event.content_block?.type === 'tool_use'), false)
    assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'end_turn')
    assert.deepEqual(events.find(event => event.type === 'content_block_delta').delta,
      { type: 'text_delta', text: '{"ok":true}' })
  }
  assert.equal(service.requests.length, 4)
  assert.deepEqual(service.errors, [])
})
