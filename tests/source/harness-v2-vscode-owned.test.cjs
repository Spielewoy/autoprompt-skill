'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { usageReceipt } = require('../../scripts/harness-v2-bridge/vscode/owned-session.cjs')
const { sanitize } = require('../../scripts/harness-v2-vscode-config.cjs')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
const { descriptor, descriptorValid } = require('../../scripts/harness-v2-bridge/vscode/event-channel.cjs')

test('owned VS Code usage retains exact billed categories and rejects inconsistent receipts', () => {
  const source = { id: 'request-1', model: 'fixture', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } }
  const receipt = usageReceipt(source)
  assert.deepEqual(receipt.usage, { input: 9, cacheRead: 3, cacheWrite: 0, output: 5, reasoning: 2, totalTokens: 17 })
  for (const usage of [{}, { ...source.usage, total_tokens: 18 }, { ...source.usage, prompt_tokens: 1.5 }, { ...source.usage, completion_tokens_details: { reasoning_tokens: 6 } }, { ...source.usage, prompt_tokens_details: { cached_tokens: 13 } }]) {
    assert.throws(() => usageReceipt({ ...source, usage }), { code: 'PROVIDER_USAGE_UNKNOWN' })
  }
  const stream = new HarnessEventStream('vscode')
  stream.push(JSON.stringify({ type: 'owned.session', sessionId: 'vscode-owned-test', contextKind: 'autoprompt-extension' }))
  stream.push(JSON.stringify({ type: 'owned.usage', ...receipt }))
  stream.push(JSON.stringify({ type: 'owned.result', output: { ok: true } }))
  assert.deepEqual(stream.finish().usage, { noncachedInput: 9, cachedInput: 3, output: 5, reasoning: 2 })
})

test('owned VS Code connection cannot silently load executable providers or unsafe endpoints', () => {
  const connection = sanitize({ model: 'test', ignoredExecutable: '/tmp/untrusted', maxTokens: 64 })
  assert.equal(connection.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(connection.ignoredExecutable, undefined)
  assert.equal(connection.supportsStructuredOutput, false)
  assert.equal(sanitize({ model: 'test', supportsStructuredOutput: true }).supportsStructuredOutput, true)
  // A controller may grant a longer session only within the closed six-minute
  // bound. This keeps the public harness from silently falling back to the
  // native two-minute default during a real checker turn.
  assert.equal(sanitize({ model: 'test', timeoutMs: 600000 }).timeoutMs, 600000)
  for (const value of [{ baseUrl: 'http://example.com/v1' }, { baseUrl: 'https://user:secret@example.com/v1' }, { apiKeyEnv: 'PATH' }, { maxSteps: 129 }, { maxTokens: -1 }, { timeoutMs: Infinity }, { reasoningEffort: 'invented' }, { supportsStructuredOutput: 'yes' }]) {
    assert.throws(() => sanitize(value), { code: 'PROFILE_INVALID' })
  }
})

test('owned VS Code launch uses a controller-bounded session timeout without overriding an explicit cap', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-timeout-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), control = path.join(root, 'control')
  for (const directory of [target, scratch, control]) fs.mkdirSync(directory, { mode: 0o700 })
  const toolBoundary = boundary.prepareBoundary({ provider: 'vscode', root: control, policy: {
    activationId: 'test', sessionId: 'session', reservationId: 'reservation', readOnly: false,
    targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [target, scratch],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
  const launch = (connection, outputSchema) => {
    const home = path.join(root, crypto.randomUUID()); fs.mkdirSync(home, { mode: 0o700 })
    return native.createLaunch({ provider: 'vscode', home, sessionRoot: path.join(root, 'session'), cwd: target, targetPath: target,
      prompt: 'controller prompt', input: '{}', readOnly: false, toolBoundary, connection, environment: {}, vscodeEventChannel: descriptor({ endpoint: path.join(root, `${crypto.randomUUID()}.sock`), sessionId: 'session', reservationId: '11111111-1111-4111-8111-111111111111' }), ...(outputSchema ? { outputSchema } : {}) })
  }
  const sessionTimeout = connection => JSON.parse(fs.readFileSync(launch(connection).env.AUTOPROMPT_VSCODE_OWNED_REQUEST, 'utf8')).connection.timeoutMs
  assert.equal(sessionTimeout({ model: 'fixture' }), 600000)
  assert.equal(sessionTimeout({ model: 'fixture', timeoutMs: 180000 }), 180000)
  const structured = launch({ model: 'fixture', supportsStructuredOutput: true, timeoutMs: 180000, environment: {} }, { type: 'object', additionalProperties: false })
  const requestBytes = fs.readFileSync(structured.env.AUTOPROMPT_VSCODE_OWNED_REQUEST)
  const request = JSON.parse(requestBytes)
  assert.deepEqual(request.outputSchema, { type: 'object', additionalProperties: false })
  assert.equal(descriptorValid(request.eventChannel), true)
  assert.equal(structured.env.AUTOPROMPT_VSCODE_OWNED_REQUEST_SHA256, native.sha256(requestBytes))
})

test('production VS Code connection defaults to the bounded checker session budget', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-production-timeout-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configure = value => fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify(value), { mode: 0o600 })
  configure({ model: 'fixture' })
  assert.equal(native.connectionConfig('vscode', root, {}).timeoutMs, 600000)
  configure({ model: 'fixture', timeoutMs: 180000 })
  assert.equal(native.connectionConfig('vscode', root, {}).timeoutMs, 180000)
})

test('VS Code short IPC argv keeps settings in the exact deep private user-data directory', { skip: process.platform === 'win32' }, t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vsi-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'deep'.repeat(40), 'home'), target = path.join(home, 'user-data')
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  const alias = path.join(root, 'u')
  fs.symlinkSync(target, alias, 'dir')
  const options = { home, sessionRoot: root, targetPath: root, prompt: 'fixture', input: '{}',
    connection: { model: 'fixture' }, toolBoundary: { policyPath: '/bound/policy.json', policySha256: 'a'.repeat(64) },
    vscodeUserDataDir: alias, vscodeEventChannel: descriptor({ endpoint: path.join(alias, 't', 'events.sock'), sessionId: 'session', reservationId: '11111111-1111-4111-8111-111111111111' }) }
  const { project } = require('../../scripts/harness-v2-vscode-config.cjs')
  const environment = {}, argv = project(options, environment)
  assert.ok(argv.includes('--disable-extensions'))
  assert.equal(argv[argv.indexOf('--extensionDevelopmentPath') + 1], path.resolve(__dirname, '../../scripts/harness-v2-bridge/vscode'))
  assert.equal(argv[argv.indexOf('--extensionTestsPath') + 1], path.resolve(__dirname, '../../scripts/harness-v2-bridge/vscode/session-driver.cjs'))
  assert.equal(argv[argv.indexOf('--user-data-dir') + 1], alias)
  assert.ok(Buffer.byteLength(path.join(alias, '1.13-main.sock')) < 103)
  assert.ok(Buffer.byteLength(path.join(target, '1.13-main.sock')) > 103)
  assert.deepEqual(fs.readFileSync(path.join(alias, 'User', 'settings.json')),
    fs.readFileSync(path.join(target, 'User', 'settings.json')))
  assert.equal(environment.TMPDIR, path.join(alias, 't'))
  assert.equal(environment.TEMP, environment.TMPDIR)
  assert.equal(environment.TMP, environment.TMPDIR)
  assert.equal(fs.realpathSync.native(environment.TMPDIR), path.join(target, 't'))
  const foreign = path.join(root, 'foreign'); fs.mkdirSync(foreign)
  fs.unlinkSync(alias); fs.symlinkSync(foreign, alias, 'dir')
  assert.throws(() => project(options, {}), { code: 'PROFILE_INVALID' })
  assert.throws(() => project({ ...options, vscodeUserDataDir: target }, {}), { code: 'PROFILE_INVALID' })
})

test('owned VS Code stream never accepts built-in chat identities, foreign tools or duplicate billing', () => {
  assert.throws(() => new HarnessEventStream('vscode').push(JSON.stringify({ type: 'owned.session', sessionId: 'built-in', contextKind: 'vscode-chat' })), { code: 'SESSION_ID_MISMATCH' })
  const stream = new HarnessEventStream('vscode')
  const usage = { type: 'owned.usage', requestId: 'same', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, totalTokens: 2 } }
  stream.push(JSON.stringify(usage))
  assert.throws(() => stream.push(JSON.stringify(usage)), { code: 'PROVIDER_USAGE_UNKNOWN' })
  assert.throws(() => new HarnessEventStream('vscode').push(JSON.stringify({ type: 'owned.tool.start', id: 'agent', name: 'runSubagent', args: {} })), { code: 'ROLE_POLICY_DENIED' })
})

test('owned VS Code reasoning effort uses the explicit provider field without invented aliases', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) assert.equal(native.validateEffort('vscode', effort), effort)
  for (const effort of ['max', 'off', true, 3]) assert.throws(() => native.validateEffort('vscode', effort), { code: 'PROFILE_INVALID' })
})

test('VS Code runtime identity binds application files even when Electron stays unchanged', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = path.join(root, 'resources/app')
  fs.mkdirSync(path.join(app, 'out'), { recursive: true })
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"code"}')
  fs.writeFileSync(path.join(app, 'product.json'), '{"applicationName":"code"}')
  const executable = path.join(root, 'code'); fs.writeFileSync(executable, 'unchanged native executable')
  fs.writeFileSync(path.join(app, 'out/main.js'), 'version one')
  const before = native.runtimeDependencyIdentity(executable)
  fs.writeFileSync(path.join(app, 'out/main.js'), 'version two')
  const after = native.runtimeDependencyIdentity(executable)
  assert.notEqual(before.sha256, after.sha256)
  assert.equal(before.fileCount, 4)
})
