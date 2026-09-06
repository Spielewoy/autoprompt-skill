'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  CodexExecAdapter, bindCanonicalMissionForChild, createCanonicalMissionProjection,
  startCodexCumulativeQuotaProxy,
} = require('../../agents/codex/workflow/phase-budget.js')

const ROOT = path.resolve(__dirname, '../..')
const USAGE = {
  input_tokens: 12, input_tokens_details: { cached_tokens: 2 },
  output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 },
}
const ACCOUNTED = { noncachedInput: 10, cachedInput: 2, output: 8, reasoning: 3 }
const POLICY = {
  logicalRole: 'worker', physicalRole: 'autoprompt.v2.worker', providerRole: 'ap-worker',
  sandboxMode: 'workspace-write', policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
}

function terminal(type, usage = USAGE) {
  return { type, response: {
    id: 'response-test', status: type.slice('response.'.length), usage,
    ...(type === 'response.incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    ...(type === 'response.failed' ? { error: { code: 'context_length_exceeded', message: 'Context full' } } : {}),
  } }
}

async function provider(t, frames) {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

async function post(proxy, options = {}) {
  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: [], max_output_tokens: 16, stream: true }),
    signal: options.signal,
  })
  return response.text()
}

test('truncated upstream JSON errors close the child response and retain pending spend', async t => {
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(503, { 'content-type': 'application/json', 'content-length': '10000' })
      response.write('{"error":', () => response.destroy())
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const settled = []
  const proxy = await startCodexCumulativeQuotaProxy({
    upstreamBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, tokenLimit: 48_000,
    onProviderRequestSettled: value => settled.push(value),
  })
  t.after(() => proxy.close())
  await assert.rejects(post(proxy, { signal: AbortSignal.timeout(2000) }), { name: 'TypeError' })
  const snapshot = proxy.snapshot()
  assert.equal(snapshot.lastFailure.code, 'CODEX_QUOTA_PROXY_NON_STREAM_RESPONSE')
  assert.equal(snapshot.hardStopped, true)
  assert.equal(snapshot.providerRequestCount, 1)
  assert.equal(snapshot.requestCount, 0)
  assert.deepEqual(settled, [])
})

for (const type of ['response.incomplete', 'response.failed']) {
  test(`${type} settles exact usage and preserves failure while allowing the next bounded request`, async t => {
    const upstream = await provider(t, [terminal(type)])
    const started = [], settled = [], usage = []
    const proxy = await startCodexCumulativeQuotaProxy({
      upstreamBaseUrl: upstream.baseUrl, tokenLimit: 48_000,
      onProviderRequestStarted: value => started.push(value),
      onProviderRequestSettled: value => settled.push(value),
      onUsage: value => usage.push(value),
    })
    t.after(() => proxy.close())
    const text = await post(proxy)
    const forwarded = JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6))
    assert.equal(forwarded.type, type)
    assert.equal(forwarded.response.status, type.slice('response.'.length))
    assert.equal(forwarded.response.usage.codex_rollout_budget_units, 20)
    assert.deepEqual(usage, [ACCOUNTED])
    assert.equal(settled[0].disposition, 'ACCOUNTED')
    assert.equal(proxy.snapshot().lastFailure, null)
    await post(proxy)
    assert.equal(started.length, 2)
    assert.equal(settled.length, 2)
    assert.deepEqual(proxy.snapshot().usage,
      { noncachedInput: 20, cachedInput: 4, output: 16, reasoning: 6 })
    assert.ok(upstream.requests.every(request => request.max_output_tokens === 16))
  })
}

test('missing terminal usage stays pending, and duplicate terminal events cannot double charge', async t => {
  for (const frames of [
    [terminal('response.incomplete', null)],
    [terminal('response.incomplete'), terminal('response.completed')],
  ]) {
    const upstream = await provider(t, frames)
    const settled = [], usage = []
    const proxy = await startCodexCumulativeQuotaProxy({
      upstreamBaseUrl: upstream.baseUrl, tokenLimit: 48_000,
      onProviderRequestSettled: value => settled.push(value), onUsage: value => usage.push(value),
    })
    t.after(() => proxy.close())
    await assert.rejects(post(proxy))
    assert.equal(proxy.snapshot().lastFailure.code, 'CODEX_USAGE_INVALID')
    assert.equal(proxy.snapshot().providerRequestCount, 1)
    assert.equal(settled.length, frames.length === 1 ? 0 : 1)
    assert.equal(usage.length, settled.length)
  }
})

test('incomplete usage over the explicit output limit is charged exactly and rejected', async t => {
  const upstream = await provider(t, [terminal('response.incomplete', { ...USAGE, output_tokens: 17 })])
  const settled = []
  const proxy = await startCodexCumulativeQuotaProxy({
    upstreamBaseUrl: upstream.baseUrl, tokenLimit: 48_000,
    onProviderRequestSettled: value => settled.push(value),
  })
  t.after(() => proxy.close())
  await assert.rejects(post(proxy))
  assert.equal(proxy.snapshot().lastFailure.code, 'CODEX_CHILD_QUOTA_BOUND_VIOLATED')
  assert.equal(proxy.snapshot().usage.output, 17)
  assert.equal(settled.length, 1)
})

for (const emitError of [true, false]) {
  test(`failed CLI turn with settled incomplete response remains retryable (error event: ${emitError})`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-terminal-recovery-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const upstream = await provider(t, [terminal('response.incomplete')])
    const usage = [], settled = [], unknown = [], results = []
    let proxy
    const adapter = new CodexExecAdapter({
      targetPath: directory, providerSchemaRoot: path.join(directory, 'schemas'),
      profilePath: path.join(ROOT, 'agents/codex/autoprompt.config.toml'),
      outputSchemaResolver: () => path.join(ROOT, 'agents/contracts/schemas/role-report.schema.json'),
      runner: {
        async run(spec) {
          spec.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'response-failure-session' }))
          await post(proxy)
          if (emitError) spec.onStdoutLine(JSON.stringify({ type: 'error', message: 'response incomplete: max_output_tokens' }))
          spec.onStdoutLine(JSON.stringify({ type: 'turn.failed', error: { message: 'max_output_tokens' } }))
          return { status: 1, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true }
        },
        async stop() { return { drained: true } },
      },
      async cumulativeQuotaProxyFactory(options) {
        proxy = await startCodexCumulativeQuotaProxy({ ...options, upstreamBaseUrl: upstream.baseUrl })
        return proxy
      },
    })
    const projection = createCanonicalMissionProjection('Recover the exact unfinished assignment.')
    const binding = {
      sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: 'a'.repeat(64),
      activationId: 'terminal-test', generation: 1, workItemId: 'worker',
    }
    await assert.rejects(adapter.launch({
      ...POLICY, physicalExecutionPolicy: POLICY, ...binding, route: 'DIRECT',
      canonicalMission: projection.canonicalMission,
      missionBinding: bindCanonicalMissionForChild(projection, binding),
      dispatch: { brief: 'Complete the assignment.', requestPointer: { path: 'request', hash: binding.requestEnvelopeHash } },
      environment: {}, sessionId: 'test-session', reservationId: 'test-reservation',
      providerTokenLimit: 48_000, finiteTokenBudget: true,
      onProviderRequestStarted() {},
      onProviderRequestSettled: evidence => settled.push(evidence),
      onUsageDelta: (delta, cumulative) => { usage.push(cumulative); return { continue: true } },
      onUnknownProviderSpend: evidence => unknown.push(evidence),
      onTerminalResult: value => results.push(value),
    }), error => error.code === 'CODEX_CHILD_FAILED' && error.details.usageKnown === true)
    assert.deepEqual(usage, [ACCOUNTED])
    assert.equal(settled.length, 1)
    assert.equal(unknown.length, 0)
    assert.equal(results.length, 0)
  })
}
