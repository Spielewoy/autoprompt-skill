'use strict'

// Runs only in the parent's private network namespace. All provider responses
// and credentials are fabricated. No benchmark fixture or host auth is read.
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  CodexExecAdapter,
  bindCanonicalMissionForChild,
  canonicalRoleAssignment,
  createCanonicalMissionProjection,
  startCodexCumulativeQuotaProxy,
} = require(path.join(ROOT, 'agents/codex/workflow/phase-budget.js'))

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const close = server => new Promise(resolve => {
  server.closeAllConnections()
  server.close(resolve)
})
const WORKER_POLICY = Object.freeze({
  logicalRole: 'worker', physicalRole: 'autoprompt.v2.worker', providerRole: 'ap-worker',
  sandboxMode: 'workspace-write', policyId: 'autoprompt.codex.role-policy', policyVersion: '2.0.0',
})
const MISSION = [
  'Create interval.cjs exporting overlaps(a, b), where each interval has numeric start and end.',
  'Intervals are half-open: a point at end is excluded. Adjacent intervals do not overlap.',
  'Empty intervals never overlap. Distinct disjoint intervals do not overlap.',
  'Return true only when the two intervals share at least one included point.',
  'Do not change the independent acceptance program. Keep the implementation local and dependency-free.',
  'The parent will run an independently authored acceptance program after each worker finishes.',
].join('\n')
const BAD_SOURCE = 'module.exports = (a, b) => a.start <= b.end && b.start <= a.end\n'
const INITIAL_SOURCE = 'module.exports = () => false\n'
const GOOD_SOURCE = 'module.exports = (a, b) => a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end\n'
const ACCEPTANCE = [
  "'use strict'",
  "const assert = require('node:assert/strict')",
  "const overlaps = require(require('node:path').join(process.argv[2], 'interval.cjs'))",
  'const cases = [',
  "  ['interior', {start: 0, end: 2}, {start: 1, end: 3}, true],",
  "  ['adjacent', {start: 0, end: 1}, {start: 1, end: 2}, false],",
  "  ['empty', {start: 1, end: 1}, {start: 0, end: 2}, false],",
  "  ['disjoint', {start: 0, end: 1}, {start: 3, end: 4}, false],",
  ']',
  'for (const [name, a, b, expected] of cases) {',
  '  assert.equal(overlaps(a, b), expected, name)',
  '  assert.equal(overlaps(b, a), expected, `${name}: symmetric`)',
  '}',
  "process.stdout.write('INDEPENDENT_ACCEPTANCE_PASS\\n')",
  '',
].join('\n')

function isolatedEnvironment(home) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home, USERPROFILE: home, CODEX_HOME: home,
    TMPDIR: path.join(home, 'tmp'), LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  }
}

function writeFakeAuthentication(home, mode) {
  let auth
  if (mode === 'apikey') {
    auth = { auth_mode: 'apikey', OPENAI_API_KEY: 'offline-fabricated-api-key' }
  } else {
    const now = Math.floor(Date.now() / 1000)
    const parts = [
      { alg: 'RS256', typ: 'JWT' },
      {
        sub: 'offline-authenticated-test', email: 'offline@example.invalid',
        iat: now, exp: now + 86400,
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'offline-account', chatgpt_plan_type: 'plus',
        },
      },
    ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url'))
    const token = [...parts, Buffer.from('fabricated-signature').toString('base64url')].join('.')
    auth = {
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: {
        id_token: token, access_token: token,
        refresh_token: 'offline-fabricated-refresh', account_id: 'offline-account',
      },
      last_refresh: new Date().toISOString(),
    }
  }
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
}

function workerResult(assignmentId) {
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: `${assignmentId}-result`,
    runId: 'native-authenticated-lifecycle', assignmentId, logicalRoleId: 'worker',
    physicalRoleId: WORKER_POLICY.physicalRole, requestEnvelopeHash: hash(MISSION),
    findingIds: ['AP-RUN-027'],
    startedAt: '2026-09-05T00:00:00.000Z', endedAt: '2026-09-05T00:00:01.000Z',
    filesChanged: ['interval.cjs'], resourcesChanged: [],
    behaviorChanged: ['Implemented half-open interval intersection.'],
    commands: [{ command: 'interior smoke witness', exitCode: 0, result: 'passed' }],
    successItems: [{ id: 'overlap', status: 'pass', evidenceIds: ['interior-smoke'] }],
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: {
      event: 'WORK_ITEM_VERIFIED', reason: 'Worker claims its assignment is complete.',
      invalidateEvidenceIds: [],
    },
  }
}

function createNativeRunner(cli, observations) {
  let active = null
  return {
    async run(spec) {
      assert.equal(active, null)
      assert.equal(spec.executable, cli.command)
      assert.deepEqual(spec.argv.slice(0, cli.args.length), cli.args)
      assert.equal(spec.shell, false)
      assert.match(spec.stdin, /AUTOPROMPT_CANONICAL_MISSION_V1/)
      assert.match(spec.stdin, /Canonical assignment:/)
      assert.ok(Buffer.byteLength(spec.stdin) > 4000, 'exercise a complete assignment, not an OK prompt')
      assert.ok(spec.argv.includes('enable_request_compression'), 'adapter owns the wire policy')
      const compressionIndex = spec.argv.indexOf('enable_request_compression')
      assert.equal(spec.argv[compressionIndex - 1], '--disable')
      const provider = spec.argv.find(value => value.startsWith('model_providers.autoprompt-openai='))
      assert.match(provider, /requires_openai_auth=true/)
      assert.match(provider, /base_url="http:\/\/127\.0\.0\.1:/)
      observations.stdin = spec.stdin
      observations.argv = [...spec.argv]
      return new Promise((resolve, reject) => {
        const child = childProcess.spawn(spec.executable, spec.argv, {
          cwd: spec.cwd, env: spec.env, detached: true, shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = '', stderr = '', partial = '', callbackError = null
        let stopped = false
        let finishDrain
        const drained = new Promise(resolveDrain => { finishDrain = resolveDrain })
        active = { child, drained, stop: () => { stopped = true } }
        const timer = setTimeout(() => {
          callbackError = new Error(`native authenticated fixture timed out: ${stderr.slice(-2000)}\n${observations.lines.slice(-4).join('\n')}`)
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
        }, 25000)
        child.on('error', error => { clearTimeout(timer); active = null; finishDrain(); reject(error) })
        child.stdout.on('data', chunk => {
          const text = chunk.toString('utf8')
          stdout += text
          partial += text
          const lines = partial.split(/\r?\n/u)
          partial = lines.pop()
          for (const line of lines.filter(Boolean)) {
            observations.lines.push(line)
            try { spec.onStdoutLine(line) } catch (error) {
              callbackError = error
              try { process.kill(-child.pid, 'SIGKILL') } catch {}
            }
          }
        })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.stdin.on('error', error => {
          if (error.code !== 'EPIPE') callbackError = error
        })
        child.on('close', (status, signal) => {
          clearTimeout(timer)
          active = null
          observations.stderr = stderr
          finishDrain()
          if (callbackError) reject(callbackError)
          else resolve({
            status: stopped ? 0 : status, signal, stdout, stderr,
            processOwned: true, exactArgv: true, drained: true,
          })
        })
        child.stdin.end(spec.stdin)
      })
    },
    async stop() {
      if (!active) return { drained: true }
      const owned = active
      owned.stop()
      try { process.kill(-owned.child.pid, 'SIGTERM') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      await owned.drained
      return { drained: true }
    },
  }
}

function sendResponse(response, step, item) {
  const events = [
    { type: 'response.created', response: { id: `response-${step}` } },
    { type: 'response.output_item.done', item },
    {
      type: 'response.completed', response: {
        id: `response-${step}`,
        usage: {
          input_tokens: step, input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: step + 1,
        },
      },
    },
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}

async function nativeWorker(context, repair) {
  const { mode, directory, workdir, home, cli } = context
  const assignmentId = repair ? 'repair-interval' : 'implement-interval'
  const observations = {
    lines: [], requests: [], events: [], tools: [], usage: [], started: [], settled: [], unknown: [],
  }
  const canonical = workerResult(assignmentId)
  let providerError = null
  const upstream = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      try {
        assert.equal(request.url, mode === 'chatgpt' ? '/backend-api/codex/responses' : '/v1/responses')
        assert.equal(request.headers['content-encoding'], undefined)
        assert.equal(Boolean(request.headers['chatgpt-account-id']), mode === 'chatgpt')
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        assert.equal(Array.isArray(body.input), true)
        if (mode === 'chatgpt' && Object.hasOwn(body, 'max_output_tokens')) {
          providerError = new Error('Unsupported parameter: max_output_tokens')
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: {
            type: 'invalid_request_error', code: 'unsupported_parameter',
            param: 'max_output_tokens', message: providerError.message,
          } }))
          return
        }
        if (mode === 'apikey') assert.ok(Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0)
        observations.requests.push(body)
        const step = observations.requests.length
        assert.ok(step <= 3, 'the fake provider must not hide an unexpected extra request')
        if (step === 1) {
          const toolNames = body.input.filter(item => item.type === 'additional_tools')
            .flatMap(item => item.tools)
            .flatMap(tool => tool.type === 'namespace' ? tool.tools : [tool])
            .map(tool => tool.name)
          observations.shellTool = mode === 'chatgpt' && toolNames.includes('exec_command')
            ? 'exec_command' : 'shell_command'
          assert.ok(toolNames.includes(observations.shellTool),
            `native advertised tools=${JSON.stringify(toolNames)}; request fields=${JSON.stringify(Object.keys(body))}`)
        }
        const shellTool = observations.shellTool
        const smokeCommand = `${JSON.stringify(process.execPath)} -e "if(require('./interval.cjs')({start:0,end:2},{start:1,end:3})!==true)process.exit(1);process.stdout.write('INTERIOR_SMOKE_PASS')"`
        const item = step === 1
          ? {
              type: 'custom_tool_call', id: `patch-${assignmentId}`, call_id: `patch-${assignmentId}`,
              name: 'apply_patch',
              input: repair
                ? `*** Begin Patch\n*** Update File: interval.cjs\n@@\n-${BAD_SOURCE.trimEnd()}\n+${GOOD_SOURCE.trimEnd()}\n*** End Patch\n`
                : `*** Begin Patch\n*** Update File: interval.cjs\n@@\n-${INITIAL_SOURCE.trimEnd()}\n+${BAD_SOURCE.trimEnd()}\n*** End Patch\n`,
            }
          : step === 2
            ? {
                type: 'function_call', id: `shell-${assignmentId}`, call_id: `shell-${assignmentId}`,
                name: shellTool, arguments: JSON.stringify(shellTool === 'exec_command'
                  ? { cmd: smokeCommand, workdir, login: false, yield_time_ms: 1000 }
                  : { command: smokeCommand, workdir, login: false }),
              }
            : {
                type: 'message', role: 'assistant', id: `final-${assignmentId}`,
                content: [{ type: 'output_text', text: JSON.stringify({ canonicalJson: JSON.stringify(canonical) }) }],
              }
        sendResponse(response, step, item)
      } catch (error) {
        providerError = error
        response.writeHead(500)
        response.end('invalid offline fixture request')
      }
    })
  })
  await listen(upstream)
  let relay
  const adapter = new CodexExecAdapter({
    runner: createNativeRunner(cli, observations), executable: cli.command, executableArgs: cli.args,
    targetPath: workdir, profilePath: path.join(home, 'autoprompt.config.toml'),
    providerSchemaRoot: path.join(directory, `transport-${assignmentId}`),
    outputSchemaResolver: () => path.join(ROOT, 'agents/contracts/schemas/role-report.schema.json'),
    cumulativeQuotaProxyFactory: async options => {
      relay = await startCodexCumulativeQuotaProxy({
        ...options, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}${mode === 'chatgpt' ? '/backend-api/codex' : '/v1'}`,
      })
      return relay
    },
  })
  try {
    const mission = createCanonicalMissionProjection(MISSION)
    const requestEnvelopeHash = hash(MISSION)
    const canonicalAssignment = canonicalRoleAssignment({
      request: {
        workItemId: assignmentId,
        ...(repair ? { repairOf: 'implement-interval', executorKey: 'interval-worker' } : {}),
        assignment: repair
          ? 'Repair the adjacent and empty interval counterexamples rejected by the independent parent verifier.'
          : 'Implement overlaps exactly according to the original half-open interval requirements.',
        ownership: ['interval.cjs'],
        success: ['Interior intersections are true.', 'Adjacent, empty, and disjoint intersections are false.'],
        checks: ['The parent independently checks interior, adjacent, empty, disjoint, and symmetric cases.'],
        findingIds: ['AP-RUN-027'],
      },
      route: 'DIRECT', runId: canonical.runId, logicalRole: 'worker',
      physicalRole: WORKER_POLICY.physicalRole, readOnly: false,
      requestEnvelopeHash, targetPath: workdir, enforcePreimages: false,
      additionalResources: [], mission: MISSION, now: () => 0,
    })
    const result = await adapter.launch({
      ...WORKER_POLICY, physicalExecutionPolicy: WORKER_POLICY,
      runId: canonical.runId,
      activationId: 'native-authenticated-activation', generation: 1,
      workItemId: assignmentId, canonicalAssignment,
      canonicalMission: mission.canonicalMission,
      missionBinding: bindCanonicalMissionForChild(mission, {
        sourceRequestHash: mission.sourceRequestHash, requestEnvelopeHash,
        activationId: 'native-authenticated-activation', generation: 1, workItemId: assignmentId,
      }),
      dispatch: {
        brief: canonicalAssignment.requestedResult,
        requestPointer: { path: 'request-envelope.json', hash: requestEnvelopeHash },
      },
      assignment: { model: 'gpt-5.6-sol', effort: 'low' },
      // ChatGPT exercises the real accounting-only default. Its backend cannot
      // enforce a caller's smaller response ceiling through max_output_tokens.
      finiteTokenBudget: mode === 'apikey',
      acceptedTokenLimit: mode === 'apikey' ? 50000 : Number.MAX_SAFE_INTEGER,
      providerTokenLimit: mode === 'apikey' ? 50000 : Number.MAX_SAFE_INTEGER,
      providerToolCallLimit: mode === 'apikey' ? 2 : Number.MAX_SAFE_INTEGER, workingDirectory: workdir,
      environment: isolatedEnvironment(home), sessionId: `${mode}:${assignmentId}`,
      reservationId: `${mode}:${assignmentId}:reservation`,
      onEvent: event => observations.events.push(event),
      onToolCallObserved: evidence => observations.tools.push(evidence),
      onUsageDelta: (delta, cumulative) => { observations.usage.push({ delta, cumulative }); return { continue: true } },
      onProviderRequestStarted: evidence => observations.started.push(evidence),
      onProviderRequestSettled: evidence => observations.settled.push(evidence),
      onUnknownProviderSpend: evidence => observations.unknown.push(evidence),
      onTerminalResult: (output, evidence) => { observations.terminal = { output, evidence } },
    })
    if (providerError) throw providerError
    assert.equal(result.reportType, 'result')
    assert.equal(result.assignmentId, assignmentId)
    assert.equal(result.allAssignedItemsPass, true, 'a worker claim does not decide independent acceptance')
    assert.equal(observations.requests.length, 3)
    assert.equal(observations.started.length, 3)
    assert.equal(observations.settled.length, 3)
    assert.deepEqual(observations.unknown, [])
    assert.deepEqual(relay.snapshot().usage, { noncachedInput: 6, cachedInput: 0, output: 3, reasoning: 0 })
    assert.equal(relay.snapshot().providerRequestCount, 3)
    assert.equal(relay.snapshot().lastFailure, null)
    assert.deepEqual(result.usage, relay.snapshot().usage)
    const events = observations.lines.map(line => JSON.parse(line))
    if (mode === 'apikey') {
      assert.ok(events.some(event => event.type === 'item.completed' && event.item?.type === 'error'),
        'the actual native rollout-budget warning must pass through the adapter')
    } else {
      assert.equal(observations.argv.some(value => value.startsWith('features.rollout_budget=')), false,
        'default ChatGPT work has no fabricated activation token ceiling')
      assert.equal(observations.argv.includes('view_image'), false,
        'default ChatGPT work has no hard-tool-counter image override')
      assert.equal(relay.snapshot().tokenLimit, Number.MAX_SAFE_INTEGER)
      assert.ok(observations.started.every(item => item.maximumUnaccountedTokens >= 128000 &&
        item.maximumUnaccountedTokens < Number.MAX_SAFE_INTEGER),
      'each ChatGPT request reserves its full bounded response, not the activation sentinel')
    }
    assert.ok(events.some(event => event.type === 'turn.completed'))
    assert.deepEqual(observations.tools.map(item => item.attemptedCount), [1, 2],
      `the diagnostic warning is not a third tool call: ${JSON.stringify(events.map(event => ({
        type: event.type, itemType: event.item?.type, exitCode: event.item?.exit_code,
      })))}`)
    const commands = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution')
    assert.equal(commands.length, 1)
    assert.equal(commands[0].item.exit_code, 0)
    assert.match(commands[0].item.aggregated_output, /INTERIOR_SMOKE_PASS/)
    assert.ok(observations.terminal)
    assert.equal(fs.readFileSync(path.join(workdir, 'interval.cjs'), 'utf8'), repair ? GOOD_SOURCE : BAD_SOURCE)
    return { assignmentId, toolCalls: observations.tools.length, providerRequests: observations.started.length, usage: result.usage }
  } catch (error) {
    // Surface this fixture's precise wire-contract refusal rather than hiding
    // it behind the adapter's correct generic incomplete-usage disposition.
    throw providerError || error
  } finally {
    if (relay) await relay.close()
    await close(upstream)
  }
}

async function assertNetworkNamespace() {
  assert.equal(process.pid, 1, 'the fixture owns PID 1 so namespace shutdown drains every descendant')
  const interfaces = Object.keys(os.networkInterfaces())
  assert.deepEqual(interfaces, ['lo'], 'only the private loopback interface may exist')
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '192.0.2.1', port: 443 })
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('external routing was not rejected immediately')) })
    socket.once('connect', () => { socket.destroy(); reject(new Error('external network escaped the namespace')) })
    socket.once('error', error => {
      if (['ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)) resolve()
      else reject(error)
    })
  })
}

async function runAuthenticatedLifecycle(cli) {
  await assertNetworkNamespace()
  // Codex intentionally refuses executable helper aliases below /tmp. This is
  // a fresh owned fixture directory, never the host's real Codex home/auth.
  const root = cli.fixtureRoot || fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-native-auth-lifecycle-'))
  assert.ok(path.isAbsolute(root) && path.basename(root).startsWith('.autoprompt-native-auth-lifecycle-'))
  assert.equal(fs.lstatSync(root).isDirectory(), true)
  const summary = []
  try {
    for (const mode of ['apikey', 'chatgpt']) {
      const directory = path.join(root, mode)
      const workdir = path.join(directory, 'candidate')
      const home = path.join(directory, 'private-home')
      fs.mkdirSync(workdir, { recursive: true, mode: 0o700 })
      fs.mkdirSync(path.join(home, 'tmp'), { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(workdir, 'interval.cjs'), INITIAL_SOURCE)
      const environment = isolatedEnvironment(home)
      const git = childProcess.spawnSync('git', ['init', '-q', workdir], { env: environment, encoding: 'utf8' })
      assert.equal(git.status, 0, git.stderr)
      writeFakeAuthentication(home, mode)
      const profile = [
        'approval_policy = "never"', 'sandbox_mode = "workspace-write"', 'web_search = "disabled"',
        'cli_auth_credentials_store = "file"', '[sandbox_workspace_write]',
        'network_access = false', 'exclude_slash_tmp = true', 'exclude_tmpdir_env_var = true',
        'writable_roots = []', '[features]', 'apps = false', 'enable_mcp_apps = false',
        'enable_request_compression = true', '',
      ].join('\n')
      fs.writeFileSync(path.join(home, 'autoprompt.config.toml'), profile, { mode: 0o600 })
      const verifier = path.join(directory, 'independent-acceptance.cjs')
      fs.writeFileSync(verifier, ACCEPTANCE, { mode: 0o400 })
      const verifierHash = hash(fs.readFileSync(verifier))
      const context = { mode, directory, workdir, home, cli }
      const original = await nativeWorker(context, false)
      const red = childProcess.spawnSync(process.execPath, [verifier, workdir], { env: environment, encoding: 'utf8' })
      assert.equal(red.status, 1, 'independent acceptance rejects the worker\'s false completion claim')
      assert.match(red.stderr, /adjacent/)
      assert.equal(hash(fs.readFileSync(verifier)), verifierHash)
      const repaired = await nativeWorker(context, true)
      const green = childProcess.spawnSync(process.execPath, [verifier, workdir], { env: environment, encoding: 'utf8' })
      assert.equal(green.status, 0, green.stderr)
      assert.equal(green.stdout, 'INDEPENDENT_ACCEPTANCE_PASS\n')
      assert.equal(hash(fs.readFileSync(verifier)), verifierHash)
      summary.push({ mode, original, repaired, independentRed: red.status, independentGreen: green.status })
    }
    return { networkIsolation: 'private-loopback-only', scope: 'native-adapter-relay-and-independent-repair', summary }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

module.exports = {
  runAuthenticatedLifecycle, nativeWorker, isolatedEnvironment, writeFakeAuthentication,
  createNativeRunner, sendResponse, assertNetworkNamespace,
}

if (require.main === module) {
  const cli = JSON.parse(process.argv[2])
  const dropPrivileges = JSON.parse(process.argv[3] || 'null')
  const loopback = childProcess.spawnSync('ip', ['link', 'set', 'lo', 'up'], { encoding: 'utf8' })
  assert.equal(loopback.status, 0, loopback.stderr)
  if (dropPrivileges) {
    assert.ok(Number.isSafeInteger(dropPrivileges.uid) && dropPrivileges.uid >= 0)
    assert.ok(Number.isSafeInteger(dropPrivileges.gid) && dropPrivileges.gid >= 0)
    process.setgroups([])
    process.setgid(dropPrivileges.gid)
    process.setuid(dropPrivileges.uid)
    delete process.env.HOME
    delete process.env.USERPROFILE
  }
  runAuthenticatedLifecycle(cli).then(
    result => process.stdout.write(`${JSON.stringify(result)}\n`),
    error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 },
  )
}
