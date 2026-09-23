'use strict'

// Exercise the production adapter, canonical launch binding, real process owner,
// and real native executable. Only the model HTTP endpoint is deterministic.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const controlled = require('../../scripts/harness-v2-controlled-tools.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessExecAdapter } = require('../../scripts/harness-v2-transport.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { modelService } = require('../helpers/harness-native-service.cjs')

const PROVIDERS = ['claude', 'opencode', 'kilo', 'deepseek']
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

function fixture(provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-production-adapter-`))
  const dirs = Object.fromEntries(['target', 'controller'].map(name => [name, path.join(root, name)]))
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { mode: 0o700 })
  const nativeRoot = path.join(dirs.controller, 'native')
  fs.mkdirSync(nativeRoot, { mode: 0o700 })
  const projection = core.createCanonicalMissionProjection('FIRST_CONTEXT_SENTINEL: read the assigned file and report the result.')
  const record = { activationId: 'production-adapter-local-test', generation: 1,
    sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
    workItemId: 'bounded-read', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker',
    canonicalMission: projection.canonicalMission, workingDirectory: dirs.target,
    dispatch: { requestPointer: { hash: native.sha256('production adapter test request') } },
  }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record,
    sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.physicalExecutionPolicy = { logicalRole: record.logicalRole, physicalRole: record.physicalRole,
    providerRole: record.providerRole, sandboxMode: 'read-only', canDispatch: false,
    resourceSets: { read: [], write: [], exclusive: [] } }
  const sessionRoot = path.join(nativeRoot, provider, native.sha256(record.sessionId))
  const scratch = path.join(sessionRoot, native.sha256(record.reservationId), 'scratch')
  const schema = path.join(dirs.controller, 'result.schema.json')
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }))
  return { root, ...dirs, nativeRoot, record, sessionRoot, scratch, schema, projection }
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

test('owned proxy runner rejects a changed controller Node binding before launch', () => {
  const boundNode = { path: fs.realpathSync.native(process.execPath), sha256: native.executableSha256(fs.realpathSync.native(process.execPath)) }
  assert.throws(() => new core.OwnedCodexProxyRunner({ controlRoot: os.tmpdir(), targetKey: 'bound-node-unit',
    processOwner: { launch() { throw new Error('must not launch') }, cancelGroup() {} },
    boundNode: { ...boundNode, sha256: '0'.repeat(64) } }), { code: 'CODEX_PROXY_BINDING_INVALID' })
  assert.doesNotThrow(() => new core.OwnedCodexProxyRunner({ controlRoot: os.tmpdir(), targetKey: 'bound-node-unit',
    processOwner: { launch() { throw new Error('must not launch') }, cancelGroup() {} }, boundNode }))
})

// These filesystem/preflight tests intentionally replace the native launch
// boundary. They prove preparation and rejection behavior, not native execution.
test('adapter prepares an owned private tool directory before constructing the native launch', async t => {
  const f = fixture('claude')
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  t.mock.method(boundary, 'probeCommandSandbox', async () => ({ supported: true, backend: 'unit-only' }))
  let prepared, spawned = false
  t.mock.method(native, 'createLaunch', options => {
    prepared = options.toolBoundary
    throw Object.assign(new Error('Reached native launch construction'), { code: 'TEST_PREPARED' })
  })
  const runner = new core.OwnedCodexProxyRunner({ controlRoot: path.join(f.controller, 'proxy'), targetKey: 'unit-only',
    processOwner: { launch() { spawned = true; throw new Error('Native process must not run') }, cancelGroup() {} } })
  const adapter = new HarnessExecAdapter({ provider: 'claude', runner, nativeRoot: f.nativeRoot,
    executableBinding: { provider: 'claude', path: process.execPath, sha256: native.executableSha256(process.execPath) },
    targetPath: f.target, connection: {}, rolePrompt: () => 'Unit-only prompt', outputSchemaResolver: () => f.schema })
  await assert.rejects(adapter.launch(f.record), { code: 'TEST_PREPARED' })
  const reopened = boundary.loadBoundary(prepared.policyPath, prepared.policySha256)
  assert.equal(reopened.policy.targetPath, f.target)
  assert.deepEqual(reopened.policy.writableRoots, [f.scratch])
  assert.deepEqual(boundary.readReceipts(prepared), [])
  assert.equal(spawned, false)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(prepared.root)).mode & 0o077, 0)
    assert.equal(fs.statSync(prepared.policyPath).mode & 0o077, 0)
  }
})

// npm writes Windows package commands as .cmd shims.  The runtime must bind
// the shim bytes for activation, yet invoke Node and the declared package bin
// directly so the owned runner never interprets shell syntax.
test('adapter forwards a verified Windows npm shim as a shell-free Node script invocation', async t => {
  const f = fixture('claude')
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const packageRoot = path.join(f.root, 'node_modules', 'fixture-claude')
  const binRoot = path.join(f.root, 'node_modules', '.bin')
  const script = path.join(packageRoot, 'bin', 'fixture.js')
  const shim = path.join(binRoot, 'claude.cmd')
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 })
  fs.mkdirSync(binRoot, { recursive: true, mode: 0o700 })
  fs.writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write("fixture\n")\n', { mode: 0o700 })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-claude', version: '1.0.0', bin: { claude: 'bin/fixture.js' } }), { mode: 0o600 })
  const cmdShim = require('cmd-shim')
  await cmdShim(script, shim.slice(0, -'.cmd'.length))
  const binding = native.locateExecutable({ provider: 'claude', executable: shim, platform: 'win32' })
  t.mock.method(boundary, 'probeCommandSandbox', async () => ({ supported: true, backend: 'unit-only' }))
  let launch
  t.mock.method(native, 'createLaunch', options => ({ argv: ['--print'], env: { PATH: process.env.PATH }, stdin: '', cwd: options.cwd, shell: false }))
  const processOwner = { adapter: { kind: 'posix-process-group', childControlEnvironment() { return {} } }, launch() { throw new Error('mock runner owns launch') }, cancelGroup() {} }
  const runner = new core.OwnedCodexProxyRunner({ controlRoot: path.join(f.controller, 'proxy'), targetKey: 'windows-shim-unit', processOwner })
  t.mock.method(runner, 'run', async spec => { launch = spec; throw new native.HarnessError('TEST_SHIM_STOP', 'stop after capturing invocation') })
  t.mock.method(runner, 'stop', async () => ({ drained: true }))
  const adapter = new HarnessExecAdapter({ provider: 'claude', runner, nativeRoot: f.nativeRoot,
    executableBinding: binding, targetPath: f.target, connection: {}, rolePrompt: () => 'Unit-only prompt', outputSchemaResolver: () => f.schema })
  await assert.rejects(adapter.launch(f.record), { code: 'TEST_SHIM_STOP' })
  assert.equal(launch.executable, process.execPath)
  assert.deepEqual(launch.argv, [script, '--print'])
  assert.equal(launch.shell, false)
  assert.equal(binding.path, shim, 'the persisted executable remains the raw npm shim')
})

test('checker preflight rejects absent or malformed write authority with a typed policy error', async t => {
  const f = fixture('claude')
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  t.mock.method(boundary, 'probeCommandSandbox', async () => ({ supported: true, backend: 'unit-only' }))
  const runner = new core.OwnedCodexProxyRunner({ controlRoot: path.join(f.controller, 'proxy'), targetKey: 'unit-only',
    processOwner: { launch() { throw new Error('Native process must not run') }, cancelGroup() {} } })
  const adapter = new HarnessExecAdapter({ provider: 'claude', runner, nativeRoot: f.nativeRoot,
    executableBinding: { provider: 'claude', path: process.execPath, sha256: native.executableSha256(process.execPath) },
    targetPath: f.target, connection: {}, rolePrompt: () => 'Unit-only prompt', outputSchemaResolver: () => f.schema })
  const record = { ...f.record, logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker' }
  for (const resourceSets of [undefined, {}, { write: null, exclusive: [] }, { write: [], exclusive: {} }, { write: ['target'], exclusive: [] }]) {
    record.physicalExecutionPolicy = { logicalRole: record.logicalRole, physicalRole: record.physicalRole,
      providerRole: record.providerRole, sandboxMode: 'read-only', canDispatch: false, resourceSets }
    await assert.rejects(adapter.launch(record), { code: 'CHECKER_READ_ONLY_POLICY_REQUIRED' })
  }
})

test('adapter rejects missing or noncanonical native termination evidence before parsing output', async t => {
  const f = fixture('claude')
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  t.mock.method(boundary, 'probeCommandSandbox', async () => ({ supported: true, backend: 'unit-only' }))
  const runner = new core.OwnedCodexProxyRunner({
    controlRoot: path.join(f.controller, 'proxy'), targetKey: 'invalid-native-termination-unit',
    processOwner: { adapter: createPosixProcessAdapter(), launch() { throw new Error('runner is intercepted') }, cancelGroup() {} },
  })
  const adapter = new HarnessExecAdapter({
    provider: 'claude', runner, nativeRoot: f.nativeRoot,
    executableBinding: { provider: 'claude', path: process.execPath, sha256: native.executableSha256(process.execPath) },
    targetPath: f.target, connection: {}, credentialEnvironment: {},
    rolePrompt: () => 'Unit-only prompt', outputSchemaResolver: () => f.schema,
  })
  for (const [label, completion, expected] of [
    ['missing', { processOwned: true, exactArgv: true, drained: true }, { exitCode: null, signal: null, invalidFields: ['exitCode'] }],
    ['invalid', { processOwned: true, exactArgv: true, drained: true, status: 'one', signal: { name: 'SIGTERM' } }, { exitCode: null, signal: null, invalidFields: ['exitCode', 'signal'] }],
    ['mismatch', { processOwned: true, exactArgv: true, drained: true, exitCode: 0, status: 1, signal: null }, { exitCode: 0, signal: null, invalidFields: ['statusMismatch'] }],
  ]) {
    runner.run = async () => completion
    const record = { ...f.record, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() }
    record.missionBinding = core.bindCanonicalMissionForChild(f.projection, {
      ...record, sourceRequestHash: f.projection.sourceRequestHash,
      requestEnvelopeHash: record.dispatch.requestPointer.hash,
    })
    await assert.rejects(adapter.launch(record), error => {
      assert.equal(error.code, 'CHILD_RUNTIME_RESULT_INVALID', label)
      assert.deepEqual(error.details, expected, label)
      return true
    })
  }
})

test('adapter preserves a primary native exit while relay shutdown records one unknown provider envelope', async t => {
  const f = fixture('vscode')
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  t.mock.method(boundary, 'probeCommandSandbox', async () => ({ supported: true, backend: 'unit-only' }))
  let upstreamStarted = 0, upstreamClosed = 0, stopCalls = 0
  const providerRequests = [], providerErrors = []
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    upstreamStarted++
    await new Promise(resolve => response.once('close', resolve))
    upstreamClosed++
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) })

  const starts = [], settlements = [], unknown = [], usage = []
  const record = {
    ...f.record,
    providerTokenLimit: 1000,
    environment: {},
    onProviderRequestStarted: evidence => starts.push(evidence),
    onProviderRequestSettled: evidence => settlements.push(evidence),
    onUnknownProviderSpend: evidence => unknown.push(evidence),
    onUsageDelta: delta => { usage.push(delta); return { continue: true } },
  }
  const runner = new core.OwnedCodexProxyRunner({
    controlRoot: path.join(f.controller, 'proxy'), targetKey: 'primary-native-exit-unit',
    processOwner: { adapter: createPosixProcessAdapter(), launch() { throw new Error('runner is intercepted') }, cancelGroup() {} },
  })
  let runnerResult = { processOwned: true, exactArgv: true, drained: true, status: 1, signal: null }
  runner.stop = async () => { stopCalls++; return { drained: true } }
  runner.run = async spec => {
    const request = JSON.parse(fs.readFileSync(spec.env.AUTOPROMPT_VSCODE_OWNED_REQUEST, 'utf8'))
    const before = upstreamStarted
    const pending = fetch(`${request.connection.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture', stream: true, max_tokens: 20, messages: [{ role: 'user', content: 'x' }] }),
    }).catch(error => { providerErrors.push(error) })
    providerRequests.push(pending)
    await waitFor(() => upstreamStarted > before, 'owned native request never reached the quota relay upstream')
    return runnerResult
  }
  const adapter = new HarnessExecAdapter({
    provider: 'vscode', runner, nativeRoot: f.nativeRoot,
    executableBinding: { provider: 'vscode', path: process.execPath, sha256: native.executableSha256(process.execPath) },
    targetPath: f.target,
    connection: { model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, maxTokens: 128, maxSteps: 1 },
    credentialEnvironment: { OPENROUTER_API_KEY: 'unit-only' }, rolePrompt: () => 'Unit-only prompt', outputSchemaResolver: () => f.schema,
  })
  await assert.rejects(adapter.launch(record), error => {
    assert.equal(error.code, 'CHILD_RUNTIME_FAILURE')
    assert.deepEqual(error.details, { exitCode: 1, signal: null })
    return true
  })
  await providerRequests[0]
  await waitFor(() => upstreamClosed === 1, 'quota cleanup did not close the admitted upstream request')
  assert.ok(providerErrors[0], 'pending native provider request was not aborted during cleanup')
  assert.equal(starts.length, 1)
  assert.equal(settlements.length, 0)
  assert.equal(unknown.length, 1)
  assert.deepEqual(usage, [])
  assert.equal(stopCalls, 0, 'a drained primary native exit must not be replaced by a relay cleanup stop')

  // The primary-exit exception is intentionally narrow: durable unknown-spend
  // persistence remains more important than the process status that triggered
  // shutdown, and therefore stays terminally visible.
  let unknownPersistenceCalls = 0
  const persistenceError = new DOMException('durable unknown spend failed', 'AbortError')
  const failedRecord = {
    ...record,
    sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
    onUnknownProviderSpend: () => { unknownPersistenceCalls++; throw persistenceError },
  }
  failedRecord.missionBinding = core.bindCanonicalMissionForChild(f.projection, {
    ...failedRecord, sourceRequestHash: f.projection.sourceRequestHash,
    requestEnvelopeHash: failedRecord.dispatch.requestPointer.hash,
  })
  await assert.rejects(adapter.launch(failedRecord), error => error === persistenceError)
  await providerRequests[1]
  await waitFor(() => upstreamClosed === 2, 'unknown-spend persistence failure did not drain its upstream request')
  assert.equal(unknownPersistenceCalls, 1)
  assert.equal(stopCalls, 1, 'a real accounting failure must still stop the owned runner')

  // A nonzero status is never enough on its own: missing descendant drain
  // evidence remains a process-owner failure even when relay cleanup aborts
  // the pending provider request.
  runnerResult = { ...runnerResult, drained: false }
  const undrainedRecord = {
    ...record,
    sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
  }
  undrainedRecord.missionBinding = core.bindCanonicalMissionForChild(f.projection, {
    ...undrainedRecord, sourceRequestHash: f.projection.sourceRequestHash,
    requestEnvelopeHash: undrainedRecord.dispatch.requestPointer.hash,
  })
  await assert.rejects(adapter.launch(undrainedRecord), { code: 'PROCESS_DRAIN_TIMEOUT' })
  await providerRequests[2]
  await waitFor(() => upstreamClosed === 3, 'undrained result cleanup left its admitted upstream request alive')
  assert.equal(unknown.length, 2, 'the undrained request is conservatively unknown-accounted once')
  assert.equal(stopCalls, 1, 'owned completion evidence failure is reported without replacing it with relay teardown')

  // A clean native status cannot conceal a request that never produced exact
  // usage. Its close-origin abort remains PROVIDER_USAGE_UNKNOWN instead of
  // turning a terminal/native parse path into a false success.
  runnerResult = { ...runnerResult, drained: true, exitCode: 0, status: 0 }
  const successRecord = {
    ...record,
    sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
  }
  successRecord.missionBinding = core.bindCanonicalMissionForChild(f.projection, {
    ...successRecord, sourceRequestHash: f.projection.sourceRequestHash,
    requestEnvelopeHash: successRecord.dispatch.requestPointer.hash,
  })
  await assert.rejects(adapter.launch(successRecord), { code: 'PROVIDER_USAGE_UNKNOWN' })
  await providerRequests[3]
  await waitFor(() => upstreamClosed === 4, 'apparently successful native result left its admitted upstream request alive')
  assert.equal(unknown.length, 3, 'a pending request after status zero is still unknown-accounted once')
  assert.equal(stopCalls, 2, 'status zero retains the relay accounting failure as terminal')
})

for (const provider of PROVIDERS) {
  test(`${provider} production adapter: owned tools preserve candidate, private state and exact session continuation`, {
    skip: !process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`] || process.platform === 'win32', timeout: 240000,
  }, async t => {
    const f = fixture(provider)
    let owner, service
    t.after(async () => {
      try { if (owner) await owner.cancelAll({ reason: 'production adapter test cleanup', graceMs: 0, killMs: 2000 }) }
      finally { try { if (service) await service.close() } finally { fs.rmSync(f.root, { recursive: true, force: true }) } }
    })
    const available = await boundary.probeCommandSandbox()
    assert.equal(available.supported, true, JSON.stringify(available))
    const binding = native.probeExecutable({ provider, executable: process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`] })
    const marker = `actual-${provider}-production-adapter`
    const candidate = path.join(f.target, 'candidate.txt'), checked = path.join(f.scratch, 'checked.txt')
    const secret = path.join(f.controller, 'private.txt')
    fs.writeFileSync(candidate, marker)
    fs.writeFileSync(secret, 'PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE')
    fs.writeFileSync(path.join(f.target, 'AGENTS.md'), 'PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD')
    const command = [
      `cat ${quote(candidate)}`,
      `printf checked > ${quote(checked)}`,
      `if printf wrong > ${quote(candidate)} 2>/dev/null; then exit 19; fi`,
      `if cat ${quote(secret)} 2>/dev/null; then exit 20; fi`,
    ].join('; ')
    service = await modelService(provider, { name: controlled.toolName(provider, 'bash'), args: { command } })
    const connection = provider === 'claude'
      ? { model: 'claude-sonnet-4-6', environment: { ANTHROPIC_BASE_URL: service.url } }
      : provider === 'deepseek' ? { model: 'deepseek-chat', environment: { DEEPSEEK_BASE_URL: service.url } }
      : { model: 'fixture/model', providers: { fixture: { npm: '@ai-sdk/openai-compatible',
        options: { baseURL: `${service.url}/v1`, apiKey: '<local-test-only>' },
        models: { model: { name: 'Fixture Model', limit: { context: 32768, output: 2048 } } } } } }
    const processAdapter = createPosixProcessAdapter()
    owner = new ProcessOwner({ adapter: processAdapter, registryPath: path.join(f.controller, 'processes.json'), pollMs: 10 })
    const proxy = path.join(f.controller, 'proxy'); fs.mkdirSync(proxy, { mode: 0o700 })
    const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy,
      targetKey: `${provider}-production-adapter`, pollMs: 10 })
    const adapter = new HarnessExecAdapter({ provider, runner, nativeRoot: f.nativeRoot, executableBinding: binding,
      targetPath: f.target, connection, credentialEnvironment: { ANTHROPIC_API_KEY: '<local-test-only>', DEEPSEEK_API_KEY: '<local-test-only>' },
      outputSchemaResolver: () => f.schema, rolePrompt: () => 'Use only the assigned controller tools and return one JSON object.' })
    const debits = []
    const run = async overrides => {
      const record = { ...f.record, ...overrides }
      record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, { PATH: process.env.PATH })
      record.onUsageDelta = delta => { debits.push(delta); return { continue: true } }
      record.signal = AbortSignal.timeout(90000)
      return adapter.launch(record)
    }
    const first = await run(provider === 'deepseek' ? { assignment: { effort: 'low' } } : {})
    assert.equal(first.ok, true)
    assert.equal(first.toolBoundaryEvidence.receiptHashes.length, 1, JSON.stringify(service.requests.map(request => request.body.tools)))
    assert.match(first.toolBoundaryEvidence.policySha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(first.usage, { noncachedInput: 200, cachedInput: 0, output: 20, reasoning: 0 })
    assert.equal(fs.readFileSync(candidate, 'utf8'), marker)
    assert.equal(fs.readFileSync(checked, 'utf8'), 'checked')
    assert.ok(first.transportEvidence.eventCount > 0)
    const before = service.requests.length
    const resumed = await run({ reservationId: crypto.randomUUID(), continuationId: first.contextId, ...(provider === 'deepseek' ? { assignment: { effort: 'off' } } : {}) })
    assert.equal(resumed.contextId, first.contextId)
    assert.deepEqual(resumed.toolBoundaryEvidence.receiptHashes, [])
    assert.notEqual(resumed.toolBoundaryEvidence.policySha256, first.toolBoundaryEvidence.policySha256)
    assert.deepEqual(resumed.usage, { noncachedInput: 100, cachedInput: 0, output: 10, reasoning: 0 })
    assert.ok(service.requests.slice(before).some(request => Array.isArray(request.body.messages) && JSON.stringify(request.body.messages).includes('FIRST_CONTEXT_SENTINEL')))
    assert.equal(service.completed, 3, 'No auxiliary model work may escape accounting')
    if (provider === 'deepseek') {
      assert.ok(service.requests.slice(0, before).every(request => request.body.reasoning_effort === 'low' && request.body.thinking.type === 'enabled'))
      assert.ok(service.requests.slice(before).every(request => request.body.reasoning_effort === undefined && request.body.thinking.type === 'disabled'))
    }
    assert.deepEqual(service.errors, [])
    assert.equal(debits.reduce((sum, delta) => sum + delta.noncachedInput, 0), 300)
    assert.ok(service.requests.every(request => !JSON.stringify(request.body).includes('PROJECT_INSTRUCTIONS_MUST_NOT_AUTOLOAD')))
    assert.ok(service.requests.every(request => !JSON.stringify(request.body).includes('PRIVATE_CONTROLLER_MUST_NOT_BE_VISIBLE')))
    if (provider === 'deepseek') {
      let peakOwned = 0
      const monitor = setInterval(() => { peakOwned = Math.max(peakOwned, owner.ownershipIdentities().length) }, 5)
      let parallel
      try {
        parallel = await Promise.all(['high', 'max'].map(effort => {
          const identities = { ...f.record, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() }
          return run({ sessionId: identities.sessionId, reservationId: identities.reservationId,
            assignment: { model: effort === 'high' ? 'deepseek-chat' : 'fixture-alternate-model', effort },
            missionBinding: core.bindCanonicalMissionForChild(f.projection, { ...identities,
              sourceRequestHash: f.projection.sourceRequestHash, requestEnvelopeHash: f.record.dispatch.requestPointer.hash }) })
        }))
      } finally { clearInterval(monitor) }
      assert.equal(new Set(parallel.map(result => result.contextId)).size, 2)
      assert.ok(parallel.every(result => result.ok === true && result.contextId !== first.contextId))
      assert.ok(peakOwned >= 2, 'Independent native sessions must overlap under the same process owner')
      assert.deepEqual(owner.ownershipIdentities(), [])
      assert.equal(service.completed, 5)
      assert.deepEqual(service.errors, [])
    }

  })
}
