'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pinnedCodexCli } = require('../helpers/pinned-codex-cli.cjs')
const { BudgetController } = require('../../agents/codex/workflow/budget-controller.js')
const {
  CodexSupervisorRuntime,
  startCodexCumulativeQuotaProxy,
} = require('../../agents/codex/workflow/phase-budget.js')

const WORKER = Object.freeze({ logicalRole: 'worker', route: 'ROADMAP' })

function runtime(tokens = 48_000) {
  const result = Object.create(CodexSupervisorRuntime.prototype)
  result.budget = new BudgetController({
    limits: { wallMs: 60_000, tokens, sessions: 10, launches: 10 }, phases: {},
  })
  result.childTokenReservations = new Map()
  return result
}

test('finite user budget queues siblings until exact settlement without splitting their allowance', async () => {
  const subject = runtime()
  const first = await subject._acquireChildTokenEnvelope('first', WORKER)
  assert.equal(first.limit, 48_000)
  const second = subject._acquireChildTokenEnvelope('second', WORKER)
  const third = subject._acquireChildTokenEnvelope('third', WORKER)
  assert.equal(subject.childTokenReservationWaiters.size, 2)
  assert.equal(subject.budget.snapshot().tokensUsed, 0)
  subject._consumeChildTokenReservation('first', 8_000)
  subject._releaseChildTokenEnvelope('first')
  assert.equal((await second).limit, 40_000)
  assert.equal(subject.childTokenReservations.size, 1)
  assert.equal(subject.childTokenReservationWaiters.size, 1)
  subject._consumeChildTokenReservation('second', 5_000)
  subject._releaseChildTokenEnvelope('second')
  assert.equal((await third).limit, 35_000)
  subject._releaseChildTokenEnvelope('third')
  assert.equal(subject.budget.snapshot().tokensUsed, 13_000)
  assert.equal(subject.childTokenReservationWaiters.size, 0)
})

test('settlement at the actual finite ceiling rejects queued siblings without launching them', async () => {
  const subject = runtime()
  await subject._acquireChildTokenEnvelope('first', WORKER)
  const queued = subject._acquireChildTokenEnvelope('second', WORKER)
  const rejected = assert.rejects(queued, error => error.code === 'BUDGET_EXHAUSTED' &&
    error.details.tokensUsed === 48_000 && error.details.tokensReserved === 0)
  subject._consumeChildTokenReservation('first', 48_000)
  subject._releaseChildTokenEnvelope('first')
  await rejected
  assert.equal(subject.childTokenReservations.size, 0)
  assert.equal(subject.childTokenReservationWaiters.size, 0)
})

test('abort before admission and during reservation wait leaves no queued or owned residue', async () => {
  const subject = runtime()
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(subject._acquireChildTokenEnvelope('before', WORKER, alreadyAborted.signal),
    error => error.code === 'ADMISSION_CANCELLED')
  assert.equal(subject.childTokenReservations.size, 0)
  await subject._acquireChildTokenEnvelope('first', WORKER)
  const controller = new AbortController()
  const queued = subject._acquireChildTokenEnvelope('second', WORKER, controller.signal)
  const rejected = assert.rejects(queued, error => error.code === 'ADMISSION_CANCELLED')
  controller.abort()
  await rejected
  assert.equal(subject.childTokenReservationWaiters.size, 0)
  subject._releaseChildTokenEnvelope('first')
  assert.equal(subject.childTokenReservations.size, 0)
})

test('runtime cancellation rejects all reservation waiters and prevents later admission', async () => {
  const subject = runtime()
  // Isolate the actual synchronous cancel boundary from unrelated finalizers.
  subject._resumableSuspensionIsDurablySelected = () => false
  subject._beginSettlement = () => Promise.resolve({ outcome: 'CANCELLED' })
  await subject._acquireChildTokenEnvelope('first', WORKER)
  const second = assert.rejects(subject._acquireChildTokenEnvelope('second', WORKER),
    error => error.code === 'ADMISSION_CANCELLED')
  const third = assert.rejects(subject._acquireChildTokenEnvelope('third', WORKER),
    error => error.code === 'ADMISSION_CANCELLED')
  await subject.cancel('stop this run')
  await Promise.all([second, third])
  assert.equal(subject.childTokenReservationWaiters.size, 0)
  subject._releaseChildTokenEnvelope('first')
  await assert.rejects(subject._acquireChildTokenEnvelope('after', WORKER),
    error => error.code === 'ADMISSION_CANCELLED')
})

test('accounting failure rejects waiting admissions while preserving the unresolved reservation', async () => {
  const subject = runtime()
  await subject._acquireChildTokenEnvelope('first', WORKER)
  const failure = Object.assign(new Error('usage settlement failed'), { code: 'INCOMPLETE_USAGE_ACCOUNTING' })
  const rejected = assert.rejects(subject._acquireChildTokenEnvelope('second', WORKER), failure)
  subject._closeChildTokenAdmissions(failure)
  await rejected
  assert.equal(subject.childTokenReservations.get('first').remaining, 48_000)
  assert.equal(subject.childTokenReservationWaiters.size, 0)
})

test('accounting-only defaults admit concurrent required work without a token semaphore', async () => {
  const subject = runtime(Number.MAX_SAFE_INTEGER)
  const envelopes = await Promise.all(['a', 'b', 'c'].map(id => subject._acquireChildTokenEnvelope(id, WORKER)))
  assert.equal(subject.childTokenReservations.size, 3)
  assert.ok(envelopes.every(envelope => !envelope.finiteTokenBudget && envelope.limit === Number.MAX_SAFE_INTEGER))
})

test('relay respects the provider output maximum on every model without creating a cumulative token limit', async t => {
  const requests = []
  const provider = http.createServer((request, response) => {
    let bytes = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { bytes += chunk })
    request.on('end', () => {
      const body = JSON.parse(bytes)
      requests.push(body)
      if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens > 128_000) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"error":"model maximum output is 128000"}')
        return
      }
      const event = {
        type: 'response.completed',
        response: { id: `response-${requests.length}`, usage: {
          input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
          output_tokens: Math.min(body.max_output_tokens, 80_000),
          output_tokens_details: { reasoning_tokens: 0 },
        } },
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`)
    })
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => provider.close(resolve)))
  const proxy = await startCodexCumulativeQuotaProxy({
    tokenLimit: Number.MAX_SAFE_INTEGER,
    upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
  })
  t.after(() => proxy.close())
  const post = body => new Promise((resolve, reject) => {
    const request = http.request(`${proxy.baseUrl}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, response => {
      response.resume()
      response.once('error', reject)
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.end(JSON.stringify(body))
  })
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    for (let turn = 0; turn < 2; turn += 1) {
      assert.equal(await post({ model, input: [{ role: 'user', content: `turn ${turn}` }], stream: true }), 200)
      assert.equal(requests.at(-1).max_output_tokens, 128_000)
    }
  }
  // The six admitted responses have already consumed over 480k model tokens;
  // later turns remain admissible because 128k bounds one response only.
  assert.equal(await post({ model: 'gpt-5.6-sol', input: [], max_output_tokens: 1024, stream: true }), 200)
  assert.equal(requests.at(-1).max_output_tokens, 1024)
  assert.equal(await post({
    model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'x'.repeat(200_000) }], stream: true,
  }), 200)
  assert.ok(requests.at(-1).max_output_tokens < 72_000)
  assert.equal(requests.at(-1).max_output_tokens + proxy.snapshot().latestInputBound.maximumInputTokens, 272_000)
})

async function chatgptRelayFixture(t, tokenLimit, { outputTokens = 80_000, incomplete = false } = {}) {
  const requests = [], started = [], settled = [], usages = []
  const provider = http.createServer((request, response) => {
    let bytes = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { bytes += chunk })
    request.on('end', () => {
      const body = JSON.parse(bytes)
      requests.push(body)
      assert.equal(request.url, '/backend-api/codex/responses')
      assert.equal(request.headers['chatgpt-account-id'], 'offline-account')
      if (Object.hasOwn(body, 'max_output_tokens')) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"Unsupported parameter: max_output_tokens"}}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = incomplete ? { type: 'response.created', response: { id: 'incomplete' } } : {
        type: 'response.completed', response: { id: `response-${requests.length}`, usage: {
          input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
          output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: 0 },
        } },
      }
      response.end(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    })
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const proxy = await startCodexCumulativeQuotaProxy({
    tokenLimit, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/backend-api/codex`,
    onProviderRequestStarted: item => started.push(item),
    onProviderRequestSettled: item => settled.push(item),
    onUsage: item => usages.push(item),
  })
  t.after(async () => { await proxy.close(); await new Promise(resolve => provider.close(resolve)) })
  const post = (body = { model: 'gpt-5.6-sol', input: [], stream: true }) => new Promise(resolve => {
    const request = http.request(`${proxy.baseUrl}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'chatgpt-account-id': 'offline-account' },
    }, response => {
      let bytes = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { bytes += chunk })
      response.once('end', () => resolve({ status: response.statusCode, body: bytes, aborted: false }))
      response.once('error', () => resolve({ status: response.statusCode, body: bytes, aborted: true }))
    })
    request.once('error', () => resolve({ status: null, body: '', aborted: true }))
    request.end(JSON.stringify(body))
  })
  return { proxy, requests, started, settled, usages, post }
}

test('ChatGPT omits the unsupported API field while reserving the full response maximum on every turn', async t => {
  const fixture = await chatgptRelayFixture(t, Number.MAX_SAFE_INTEGER)
  for (let turn = 0; turn < 6; turn += 1) {
    const response = await fixture.post({
      model: 'gpt-5.6-sol', input: [{ role: 'user', content: `turn ${turn}` }], stream: true,
    })
    assert.equal(response.status, 200, response.body)
    assert.equal(response.aborted, false)
    assert.equal(Object.hasOwn(fixture.requests.at(-1), 'max_output_tokens'), false)
    assert.equal(fixture.started.at(-1).maximumUnaccountedTokens,
      fixture.proxy.snapshot().latestInputBound.maximumInputTokens + 128_000)
  }
  assert.equal(fixture.proxy.snapshot().usage.output, 480_000, '128k is not a cumulative activation cap')
  const response = await fixture.post({
    model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'x'.repeat(200_000) }],
    max_output_tokens: 1024, stream: true,
  })
  assert.equal(response.status, 200, response.body)
  assert.equal(response.aborted, false, 'the backend may exceed the caller-controlled context remainder')
  assert.equal(Object.hasOwn(fixture.requests.at(-1), 'max_output_tokens'), false)
  assert.ok(fixture.started.at(-1).maximumUnaccountedTokens > 328_000,
    'neither an unsupported requested ceiling nor context packing can shrink unknown-spend reservation')
  assert.equal(fixture.started.at(-1).maximumUnaccountedTokens,
    fixture.proxy.snapshot().latestInputBound.maximumInputTokens + 128_000)
  assert.equal(fixture.settled.length, 7)
})

test('finite ChatGPT admission denies unsupported small ceilings before bytes and preserves remaining budget', async t => {
  const small = await chatgptRelayFixture(t, 8000)
  assert.equal((await small.post()).status, 429)
  assert.equal(small.proxy.snapshot().lastFailure.code, 'CODEX_CHILD_QUOTA_PREFLIGHT_DENIED')
  assert.equal(small.proxy.snapshot().providerRequestCount, 0)
  assert.equal(small.requests.length, 0)
  assert.deepEqual(small.started, [])
  assert.deepEqual(small.usages, [])
  const finite = await chatgptRelayFixture(t, 200_000)
  assert.equal((await finite.post()).status, 200)
  assert.equal(finite.proxy.snapshot().usage.output, 80_000)
  assert.equal((await finite.post()).status, 429,
    'remaining allowance below input plus 128k cannot enforce a smaller ChatGPT response')
  assert.equal(finite.requests.length, 1)
  assert.equal(finite.started.length, 1)
  assert.equal(finite.settled.length, 1)
  assert.equal(finite.proxy.snapshot().usage.noncachedInput + finite.proxy.snapshot().usage.output, 80_010)
})

test('ChatGPT unknown spend retains full admission while provider-bound violations retain exact billed usage', async t => {
  const unknown = await chatgptRelayFixture(t, Number.MAX_SAFE_INTEGER, { incomplete: true })
  await unknown.post()
  assert.equal(unknown.requests.length, 1)
  assert.equal(unknown.started.length, 1)
  assert.equal(unknown.started[0].maximumUnaccountedTokens,
    unknown.proxy.snapshot().latestInputBound.maximumInputTokens + 128_000)
  assert.equal(unknown.proxy.snapshot().latestMaximumUnaccountedTokens, unknown.started[0].maximumUnaccountedTokens)
  assert.deepEqual(unknown.settled, [])
  assert.deepEqual(unknown.usages, [])
  assert.equal(unknown.proxy.snapshot().hardStopped, true)
  const exceeded = await chatgptRelayFixture(t, Number.MAX_SAFE_INTEGER, { outputTokens: 128_001 })
  assert.equal((await exceeded.post()).aborted, true)
  assert.equal(exceeded.proxy.snapshot().lastFailure.code, 'CODEX_CHILD_QUOTA_BOUND_VIOLATED')
  assert.equal(exceeded.usages[0].output, 128_001)
  assert.equal(exceeded.settled[0].accountedUsage.output, 128_001)
  assert.equal(exceeded.settled[0].disposition, 'ACCOUNTED')
})

test('native Codex probe discovery supports installed package paths and rejects broken explicit pins', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-pin-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'checkout with spaces')
  const cli = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, 'process.stdout.write("codex-cli 0.148.0\\n")\n')
  const env = { ...process.env, PATH: '', Path: '', AUTOPROMPT_PINNED_CODEX: '', AUTOPROMPT_REQUIRE_PINNED_CODEX: '' }
  assert.equal(pinnedCodexCli({ root, env }).cliPath, cli)
  assert.equal(pinnedCodexCli({ root, env: { ...env, AUTOPROMPT_PINNED_CODEX: cli } }).cliPath, cli)
  assert.throws(() => pinnedCodexCli({ root, env: { ...env, AUTOPROMPT_PINNED_CODEX: path.join(root, 'missing') } }),
    /Codex 0\.148\.0 is required/u)
  fs.writeFileSync(cli, 'process.stdout.write("codex-cli 0.148.01\\n")\n')
  assert.throws(() => pinnedCodexCli({ root, env: { ...env, AUTOPROMPT_REQUIRE_PINNED_CODEX: '1' } }),
    /Codex 0\.148\.0 is required/u)
  assert.equal(pinnedCodexCli({ root, env }), null)
})

test('Bash 4.3 legacy migration preserves NUL-delimited paths without mapfile -d', {
  skip: process.platform === 'win32',
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-legacy-portability-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'root with spaces')
  const recovery = path.join(root, '.autoprompt-legacy-codex-recovery')
  const skill = path.join(recovery, 'skills', 'autoprompt')
  const nested = path.join(skill, 'nested\nwith newline')
  const file = path.join(nested, 'legacy payload.txt')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(file, 'legacy data')
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/install/install.sh'), 'utf8')
  const definitions = ['legacy_codex_ownership_state', 'remove_exact_legacy_codex_recovery'].map(name => {
    const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'mu'))
    assert.ok(match, `${name} definition exists`)
    return match[0]
  }).join('\n')
  const result = childProcess.spawnSync('bash', ['--noprofile', '--norc', '-c', `${definitions}
set -e
mapfile() { printf 'mapfile is unavailable in this compatibility probe\\n' >&2; return 2; }
node() {
  case "$2" in
    files0) printf '%s\\0' "$TEST_LEGACY_FILE" ;;
    directories0) printf '%s\\0' "$TEST_LEGACY_DIRECTORY" ;;
    match) return 0 ;;
    *) return 2 ;;
  esac
}
config_root() { printf '%s' "$TEST_LEGACY_ROOT"; }
_idem_paths_equal() { [ "$1" = "$2" ]; }
_idem_path_under_root() { case "$1" in "$2"/*) return 0 ;; *) return 1 ;; esac; }
_uninstall_receipt_path_under_root() { _idem_path_under_root "$2" "$1"; }
REPO_ROOT=unused
LEGACY_CODEX_RECOVERY_NAME=.autoprompt-legacy-codex-recovery
legacy_codex_ownership_state "$TEST_LEGACY_ROOT" received
[ "\${#received[@]}" -eq 1 ]
[ "\${received[0]}" = "$TEST_LEGACY_FILE" ]
remove_exact_legacy_codex_recovery "$TEST_LEGACY_ROOT"
`], {
    env: { ...process.env, TEST_LEGACY_ROOT: root, TEST_LEGACY_FILE: file, TEST_LEGACY_DIRECTORY: nested },
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(fs.existsSync(recovery), false)
  assert.equal(fs.existsSync(root), true)
})
