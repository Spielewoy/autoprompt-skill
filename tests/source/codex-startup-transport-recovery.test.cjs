'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  CodexExecAdapter,
  bindCanonicalMissionForChild,
  createCanonicalMissionProjection,
  startCodexCumulativeQuotaProxy,
} = require('../../agents/codex/workflow/phase-budget.js')

const ROOT = path.resolve(__dirname, '../..')
const PRIVATE_BODY = 'private-prompt-must-not-appear-in-diagnostics'
const PRIVATE_HEADER = 'private-header-must-not-appear-in-diagnostics'
const POLICY = {
  logicalRole: 'worker', physicalRole: 'autoprompt.v2.worker',
  providerRole: 'ap-worker', sandboxMode: 'workspace-write',
  policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
}

async function provider(t, handler = null) {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push({ headers: request.headers, body: JSON.parse(body) })
      if (handler) return handler(response)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } },
      })}\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

async function post(baseUrl, body, headers = {}) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  })
  return { status: response.status, text: await response.text() }
}

async function relay(t, options = {}) {
  const upstream = await provider(t, options.handler)
  const started = []
  const usage = []
  const proxy = await startCodexCumulativeQuotaProxy({
    tokenLimit: options.tokenLimit || 48_000,
    upstreamBaseUrl: upstream.baseUrl,
    onProviderRequestStarted: evidence => started.push(evidence),
    onUsage: evidence => usage.push(evidence),
  })
  t.after(() => proxy.close())
  return { proxy, upstream, started, usage }
}

test('local relay reports specific encoding failures without reflecting private bytes', async t => {
  for (const encoding of ['zstd', 'gzip', PRIVATE_HEADER]) {
    const fixture = await relay(t)
    const result = await post(fixture.proxy.baseUrl, PRIVATE_BODY, { 'content-encoding': encoding })
    const error = JSON.parse(result.text).error
    assert.equal(result.status, 415)
    assert.equal(error.code, 'CODEX_QUOTA_PROXY_ENCODING_UNSUPPORTED')
    assert.equal(error.details.contentEncoding, encoding === PRIVATE_HEADER ? 'other' : encoding)
    assert.equal(error.details.stage, 'request-encoding')
    assert.equal(error.details.requestBytes, Buffer.byteLength(PRIVATE_BODY))
    assert.equal(error.details.providerRequestStarted, false)
    assert.equal(error.details.upstreamProviderRequests, 0)
    assert.doesNotMatch(result.text, new RegExp(`${PRIVATE_BODY}|${PRIVATE_HEADER}`))
    assert.equal(fixture.upstream.requests.length, 0)
    assert.equal(fixture.started.length, 0)
    assert.equal(fixture.usage.length, 0)
    assert.equal(fixture.proxy.snapshot().deniedCount, 1)
    const repeated = await post(fixture.proxy.baseUrl, JSON.stringify({ input: [] }))
    assert.equal(JSON.parse(repeated.text).error.code, 'CODEX_QUOTA_PROXY_NOT_ACCEPTING')
    assert.equal(fixture.upstream.requests.length, 0)
  }
})

test('malformed JSON, invalid shapes, input arrays, and quota rejection remain distinguishable', async t => {
  for (const [body, code, stage] of [
    [PRIVATE_BODY, 'CODEX_QUOTA_PROXY_REQUEST_INVALID', 'request-json'],
    ['[]', 'CODEX_QUOTA_PROXY_REQUEST_INVALID', 'request-shape'],
    [JSON.stringify({ input: [], max_output_tokens: null }), 'CODEX_QUOTA_PROXY_REQUEST_INVALID', 'request-shape'],
    [JSON.stringify({ input: PRIVATE_BODY }), 'CODEX_QUOTA_PROXY_INPUT_INVALID', 'request-input'],
  ]) {
    const fixture = await relay(t)
    const result = await post(fixture.proxy.baseUrl, body)
    const error = JSON.parse(result.text).error
    assert.equal(result.status, 400)
    assert.equal(error.code, code)
    assert.equal(error.details.stage, stage)
    assert.doesNotMatch(result.text, new RegExp(PRIVATE_BODY))
    assert.equal(fixture.upstream.requests.length, 0)
  }
  const fixture = await relay(t, { tokenLimit: 1 })
  const denied = await post(fixture.proxy.baseUrl, JSON.stringify({ input: [] }))
  assert.equal(denied.status, 429)
  assert.equal(JSON.parse(denied.text).error.code, 'CODEX_CHILD_QUOTA_PREFLIGHT_DENIED')
  const missing = await fetch(`${fixture.proxy.baseUrl}/not-responses`)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'CODEX_QUOTA_PROXY_ROUTE_INVALID')
  const oversized = await relay(t)
  const large = await post(oversized.proxy.baseUrl, 'x'.repeat(512 * 1024 + 1))
  assert.equal(large.status, 413)
  assert.equal(JSON.parse(large.text).error.code, 'CODEX_QUOTA_PROXY_REQUEST_TOO_LARGE')
  assert.equal(oversized.started.length, 0)
  assert.equal(oversized.upstream.requests.length, 0)
})

test('uncompressed identity requests forward normalized headers and actual usage only', async t => {
  const fixture = await relay(t)
  const result = await post(fixture.proxy.baseUrl, JSON.stringify({ input: [] }), {
    'content-encoding': 'identity',
  })
  assert.equal(result.status, 200)
  assert.equal(fixture.upstream.requests.length, 1)
  assert.equal(fixture.upstream.requests[0].headers['content-encoding'], undefined)
  assert.equal(fixture.started.length, 1)
  assert.deepEqual(fixture.usage, [{ noncachedInput: 1, cachedInput: 0, output: 1, reasoning: 0 }])
  assert.equal(fixture.proxy.snapshot().requestCount, 1)
  assert.equal(fixture.proxy.snapshot().providerRequestCount, 1)
})

async function failedAdapter(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-startup-transport-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const upstream = await provider(t, options.handler)
  const started = [], settled = [], usage = [], unknown = [], stops = []
  let proxy, argv
  const runner = {
    async run(spec) {
      argv = spec.argv
      spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'transport-startup-session' }))
      spec.onStdoutLine(JSON.stringify({ type: 'turn.started' }))
      if (options.settleFirst) {
        const first = await post(proxy.baseUrl, JSON.stringify({ input: [] }))
        assert.equal(first.status, 200)
      }
      const result = await post(proxy.baseUrl, options.body ?? PRIVATE_BODY, options.headers)
      assert.ok(result.status >= 400)
      spec.onStdoutLine(JSON.stringify({ type: 'error', message: result.text }))
      spec.onStdoutLine(JSON.stringify({ type: 'turn.failed', error: { message: result.text } }))
      return { status: 1, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
    },
    async stop(spec) { stops.push(spec.reason); return { drained: true } },
  }
  const adapter = new CodexExecAdapter({
    runner, targetPath: directory, providerSchemaRoot: path.join(directory, 'schemas'),
    profilePath: path.join(ROOT, 'agents/codex/autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(ROOT, 'agents/contracts/schemas/role-report.schema.json'),
    async cumulativeQuotaProxyFactory(settings) {
      proxy = await startCodexCumulativeQuotaProxy({ ...settings, upstreamBaseUrl: upstream.baseUrl })
      return proxy
    },
  })
  const projection = createCanonicalMissionProjection('Exercise an isolated transport failure.')
  const binding = {
    sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: 'a'.repeat(64),
    activationId: 'transport-test', generation: 1, workItemId: 'worker',
  }
  let error
  try {
    await adapter.launch({
      ...POLICY, physicalExecutionPolicy: POLICY, ...binding, route: 'DIRECT',
      canonicalMission: projection.canonicalMission,
      missionBinding: bindCanonicalMissionForChild(projection, binding),
      dispatch: { brief: 'Exercise startup.', requestPointer: { path: 'request', hash: binding.requestEnvelopeHash } },
      environment: {}, sessionId: 'transport-test-session', reservationId: 'transport-test-reservation',
      providerTokenLimit: 48_000,
      onProviderRequestStarted: evidence => started.push(evidence),
      onProviderRequestSettled: evidence => settled.push(evidence),
      onUsageDelta: (...values) => { usage.push(values); return { continue: true } },
      onUnknownProviderSpend: evidence => unknown.push(evidence),
    })
  } catch (caught) { error = caught }
  assert.ok(error)
  assert.equal(argv[argv.indexOf('enable_request_compression') - 1], '--disable')
  return { error, proxy, upstream, started, settled, usage, unknown, stops }
}

test('adapter preserves proven pre-provider rejection without inventing usage or pending spend', async t => {
  for (const scenario of [
    { body: PRIVATE_BODY, code: 'CODEX_QUOTA_PROXY_REQUEST_INVALID' },
    { body: PRIVATE_BODY, headers: { 'content-encoding': 'zstd' }, code: 'CODEX_QUOTA_PROXY_ENCODING_UNSUPPORTED' },
  ]) {
    const fixture = await failedAdapter(t, scenario)
    assert.equal(fixture.error.code, scenario.code)
    assert.equal(fixture.error.details.accountingDisposition, 'NO_PROVIDER_REQUEST_STARTED')
    assert.equal(fixture.error.details.providerRequestStarted, false)
    assert.equal(fixture.error.details.upstreamProviderRequests, 0)
    assert.equal(fixture.error.details.completedProviderRequests, 0)
    assert.equal(fixture.upstream.requests.length, 0)
    assert.equal(fixture.started.length, 0)
    assert.equal(fixture.settled.length, 0)
    assert.equal(fixture.usage.length, 0)
    assert.equal(fixture.unknown.length, 0)
    assert.doesNotMatch(JSON.stringify(fixture.error.details), new RegExp(PRIVATE_BODY))
  }
})

test('local rejection after an accounted request preserves prior spend instead of claiming zero', async t => {
  const fixture = await failedAdapter(t, { settleFirst: true })
  assert.equal(fixture.error.code, 'CODEX_QUOTA_PROXY_REQUEST_INVALID', fixture.error.stack)
  assert.equal(fixture.error.details.accountingDisposition, 'PRIOR_PROVIDER_REQUESTS_ACCOUNTED')
  assert.equal(fixture.error.details.upstreamProviderRequests, 1)
  assert.equal(fixture.error.details.completedProviderRequests, 1)
  assert.equal(fixture.started.length, 1)
  assert.equal(fixture.settled.length, 1)
  assert.equal(fixture.usage.length, 1)
  assert.equal(fixture.unknown.length, 0)
  assert.deepEqual(fixture.proxy.snapshot().usage,
    { noncachedInput: 1, cachedInput: 0, output: 1, reasoning: 0 })
})

test('upstream errors cannot impersonate local proof or suppress unknown-spend accounting', async t => {
  const fixture = await failedAdapter(t, {
    body: JSON.stringify({ input: [] }),
    handler(response) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: {
        code: 'CODEX_QUOTA_PROXY_REQUEST_INVALID', message: 'pretend local rejection',
        details: { providerRequestStarted: false, upstreamProviderRequests: 0 },
      } }))
    },
  })
  assert.equal(fixture.error.code, 'CODEX_USAGE_UNKNOWN_AFTER_START')
  assert.equal(fixture.error.details.accountingDisposition, undefined)
  assert.equal(fixture.started.length, 1)
  assert.equal(fixture.settled.length, 0)
  assert.equal(fixture.usage.length, 0)
  assert.equal(fixture.unknown.length, 1)
  assert.equal(fixture.unknown[0].providerRequestCount, 1)
  assert.equal(fixture.unknown[0].completedRequestCount, 0)
  assert.ok(fixture.unknown[0].maximumUnaccountedTokens > 0)
})
