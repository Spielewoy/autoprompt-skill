'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pinnedCodexCli } = require('../helpers/pinned-codex-cli.cjs')
const { pinnedCodexPackageFixture } = require('../helpers/pinned-codex-package.cjs')

const root = path.resolve(__dirname, '..', '..')
const workflow = path.join(root, 'agents', 'codex', 'workflow')
const { CentralScheduler, bindRoadmapExpansionAdmission } = require(path.join(workflow, 'scheduler.js'))
const { BudgetController } = require(path.join(workflow, 'budget-controller.js'))
const {
  sealReceiptBoundRegistry,
  selectModelAssignment,
  validateReceiptBoundRegistry,
} = require(path.join(workflow, 'effort-policy.js'))
const {
  appendCanonicalRouteEvent,
  assignmentLocalFindingId,
  CodexSupervisorRuntime,
  emitItemVerifiedTransition,
  explicitFindingIds,
  materializeCodexControlledTransport,
  readPrivateAgentAssignment,
  readPersistedWorkerAssignment,
  replayRequestFromPersistedAssignment,
  renderRouteDecisionMarkdown,
  startCodexCumulativeQuotaProxy,
  unresolvedCodexProviderEnvelopes,
  codexToolCallHighWater,
  verifyRequestPointer,
  writeRouteDecisionArtifacts,
} = require(path.join(workflow, 'phase-budget.js'))
const { Finalizer } = require(path.join(workflow, 'finalizer.js'))

const RUN = Object.freeze({ runId: 'cost-local-gaps', generation: 1 })
const ZERO = Object.freeze({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
const CAPABILITIES = Object.freeze({
  eventStreaming: true,
  toolOutputCapture: true,
  stableChildIdentity: true,
  sameContextContinuation: true,
  isolatedChecking: true,
  cancellation: true,
})
let sequence = 0

function runPinnedCodex(cli, argv, options) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(cli.command, [...cli.args, ...argv], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('pinned Codex direct-tool probe timed out'))
    }, 20_000)
    child.on('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr })
    })
    child.stdin.end('Return {"ok":true} and use no tools.\n')
  })
}

function postJson(url, body) {
  return new Promise(resolve => {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8')
    const request = http.request(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer probe',
        'content-type': 'application/json',
        'content-length': String(bytes.length),
      },
    })
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      resolve(result)
    }
    request.on('response', response => {
      let responseBody = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { responseBody += chunk })
      response.on('end', () => finish({ status: response.statusCode, body: responseBody, aborted: false }))
      response.on('aborted', () => finish({ status: response.statusCode, body: responseBody, aborted: true }))
      response.on('error', error => finish({ status: response.statusCode, body: responseBody, aborted: true, error }))
    })
    request.on('error', error => finish({ status: null, body: '', aborted: true, error }))
    request.end(bytes)
  })
}

function accountingRecord(sequenceNumber, causeId, tokens = 0) {
  return {
    sequence: sequenceNumber,
    cause: { causeId },
    delta: {
      tokenUsage: {
        noncachedInput: tokens,
        cachedInput: 0,
        output: 0,
        reasoning: 0,
      },
    },
  }
}

test('pinned Codex 0.148 advertises only individually visible direct tools for every controlled model', async t => {
  const cli = pinnedCodexCli()
  if (!cli) {
    t.skip('the exact pinned Codex 0.148 CLI is not installed on this host')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-direct-tool-probe-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const codexHome = path.join(directory, 'codex-home')
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  const schemaPath = path.join(directory, 'output.schema.json')
  fs.writeFileSync(schemaPath, `${JSON.stringify({
    type: 'object', required: ['ok'], properties: { ok: { const: true } }, additionalProperties: false,
  })}\n`, { mode: 0o600 })
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(body) })
      const responseId = `resp-${requests.length}`
      const messageId = `msg-${requests.length}`
      const events = [
        { type: 'response.created', response: { id: responseId } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message', role: 'assistant', id: messageId,
            content: [{ type: 'output_text', text: '{"ok":true}' }],
          },
        },
        {
          type: 'response.completed',
          response: {
            id: responseId,
            usage: {
              input_tokens: 1, input_tokens_details: null,
              output_tokens: 1, output_tokens_details: null, total_tokens: 2,
            },
          },
        },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const controlledModels = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
  for (const model of controlledModels) {
    const transport = materializeCodexControlledTransport(
      path.join(directory, `transport-${model}`),
      { logicalRole: 'worker', assignment: { model } },
    )
    const provider = 'model_providers.autoprompt-probe=' +
      `{name="probe",base_url="http://127.0.0.1:${port}/v1",env_key="OPENAI_API_KEY",` +
      'wire_api="responses",requires_openai_auth=false,supports_websockets=false,' +
      'supports_standalone_web_search=false,request_max_retries=0,stream_max_retries=0}'
    const result = await runPinnedCodex(cli, [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--output-schema', schemaPath, '--strict-config',
      '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
      '--disable', 'code_mode', '--disable', 'code_mode_only',
      '--disable', 'goals', '--disable', 'memories', '--disable', 'token_budget',
      '--disable', 'current_time_reminder', '--disable', 'deferred_executor',
      '--disable', 'unbounded_connection_retries', '--disable', 'unified_exec',
      '--disable', 'view_image',
      '-c', `model_catalog_json=${JSON.stringify(transport.modelCatalogPath)}`,
      '-c', `model_instructions_file=${JSON.stringify(transport.instructionsPath)}`,
      '-c', 'model_provider="autoprompt-probe"', '-c', provider,
      '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
      '-c', 'tools.experimental_request_user_input.enabled=false',
      '-c', 'tools.update_plan.enabled=false',
      '-c', 'include_permissions_instructions=false',
      '-c', 'include_apps_instructions=false',
      '-c', 'include_collaboration_mode_instructions=false',
      '-c', 'include_environment_context=false',
      '-c', 'skills.include_instructions=false',
      '-c', 'project_doc_max_bytes=0', '-c', 'plugins={}', '-c', 'marketplaces={}',
      '-m', model,
      '--sandbox', 'workspace-write', '-C', directory, '-',
    ], {
      cwd: directory,
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'probe' },
    })
    assert.equal(result.status, 0, `${model}: ${result.stderr}\n${result.stdout}`)
    assert.match(result.stdout, /"type":"turn\.completed"/u)
  }
  const control = materializeCodexControlledTransport(
    path.join(directory, 'transport-control'),
    { logicalRole: 'route-analyst', route: 'PRE_ROUTE', assignment: { model: 'gpt-5.6-sol' } },
  )
  const controlProvider = 'model_providers.autoprompt-probe=' +
    `{name="probe",base_url="http://127.0.0.1:${port}/v1",env_key="OPENAI_API_KEY",` +
    'wire_api="responses",requires_openai_auth=false,supports_websockets=false,' +
    'supports_standalone_web_search=false,request_max_retries=0,stream_max_retries=0}'
  const controlResult = await runPinnedCodex(cli, [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--output-schema', schemaPath, '--strict-config',
    '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--disable', 'code_mode', '--disable', 'code_mode_only',
    '--disable', 'goals', '--disable', 'memories', '--disable', 'token_budget',
    '--disable', 'current_time_reminder', '--disable', 'deferred_executor',
    '--disable', 'unbounded_connection_retries', '--disable', 'shell_tool',
    '--disable', 'unified_exec', '--disable', 'view_image',
    '-c', `model_catalog_json=${JSON.stringify(control.modelCatalogPath)}`,
    '-c', `model_instructions_file=${JSON.stringify(control.instructionsPath)}`,
    '-c', 'model_provider="autoprompt-probe"', '-c', controlProvider,
    '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
    '-c', 'tools.experimental_request_user_input.enabled=false',
    '-c', 'tools.update_plan.enabled=false',
    '-c', 'include_permissions_instructions=false',
    '-c', 'include_apps_instructions=false',
    '-c', 'include_collaboration_mode_instructions=false',
    '-c', 'include_environment_context=false',
    '-c', 'skills.include_instructions=false',
    '-c', 'project_doc_max_bytes=0', '-c', 'plugins={}', '-c', 'marketplaces={}',
    '-m', 'gpt-5.6-sol', '--sandbox', 'read-only', '-C', directory, '-',
  ], {
    cwd: directory,
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'probe' },
  })
  assert.equal(controlResult.status, 0, `${controlResult.stderr}\n${controlResult.stdout}`)

  assert.equal(requests.length, controlledModels.length + 1)
  assert.ok(requests.every(request =>
    Buffer.byteLength(JSON.stringify(request.body), 'utf8') < 8 * 1024),
  'the controlled base transport stays compact before its exact assignment is appended')
  for (const [index, request] of requests.slice(0, controlledModels.length).entries()) {
    assert.equal(request.url, '/v1/responses')
    assert.equal(request.body.model, controlledModels[index])
    assert.equal(request.body.tools, undefined)
    const additions = request.body.input.filter(item => item.type === 'additional_tools')
    assert.equal(additions.length, 1)
    assert.equal(additions[0].tools.length, 1)
    assert.equal(additions[0].tools[0].type, 'namespace')
    assert.equal(additions[0].tools[0].name, 'functions')
    assert.deepEqual(additions[0].tools[0].tools.map(tool => `${tool.type}:${tool.name}`).sort(), [
      'custom:apply_patch', 'function:shell_command',
    ])
    assert.equal(request.body.tool_choice, 'auto')
    assert.equal(request.body.parallel_tool_calls, false)
  }

  const controlRequest = requests.at(-1)
  assert.equal(controlRequest.url, '/v1/responses')
  assert.equal(controlRequest.body.model, 'gpt-5.6-sol')
  assert.equal(controlRequest.body.tools, undefined)
  const controlAdditions = controlRequest.body.input.filter(item => item.type === 'additional_tools')
  assert.ok(controlAdditions.length <= 1)
  assert.deepEqual(controlAdditions.flatMap(item => item.tools)
    .flatMap(tool => tool.type === 'namespace' ? tool.tools : [tool]), [])
  assert.equal(controlRequest.body.parallel_tool_calls, false)

  const controlCatalog = JSON.parse(fs.readFileSync(control.modelCatalogPath, 'utf8'))
  assert.ok(controlCatalog.models.every(model =>
    model.tool_mode === 'direct' && model.shell_type === 'disabled' &&
    model.apply_patch_tool_type === null && model.multi_agent_version === null))
  assert.throws(() => materializeCodexControlledTransport(
    path.join(directory, 'transport-unattested'),
    { logicalRole: 'worker', assignment: { model: 'gpt-5.6' } },
  ), error => error && error.code === 'PROVIDER_UNSUPPORTED')
})

test('pinned Codex 0.148 emits one countable lifecycle for each direct patch and shell call', async t => {
  const installedCli = pinnedCodexCli()
  if (!installedCli) {
    t.skip('the exact pinned Codex 0.148 CLI is not installed on this host')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-direct-lifecycle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const codexHome = path.join(directory, 'codex-home')
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  const environment = {
    PATH: [path.dirname(process.execPath), ...(process.platform === 'win32'
      ? [path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')]
      : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter),
    HOME: codexHome, USERPROFILE: codexHome, CODEX_HOME: codexHome,
    OPENAI_API_KEY: 'probe',
    ...(process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT }
      : {}),
  }
  // Root's ambient capabilities can hide an inaccessible native executable
  // below another user's home. The real tool sandbox correctly drops them.
  // Stage byte-identical pinned package contents in this caller-owned fixture.
  const pinned = pinnedCodexPackageFixture(path.join(directory, 'pinned-cli'), {
    env: { ...environment, AUTOPROMPT_PINNED_CODEX: installedCli.cliPath },
  })
  const cli = { command: process.execPath, args: [pinned.cliPath] }
  const schemaPath = path.join(directory, 'output.schema.json')
  fs.writeFileSync(schemaPath, `${JSON.stringify({
    type: 'object', required: ['ok'], properties: { ok: { const: true } }, additionalProperties: false,
  })}\n`, { mode: 0o600 })
  const transport = materializeCodexControlledTransport(
    path.join(directory, 'transport'),
    { logicalRole: 'worker', assignment: { model: 'gpt-5.6-sol' } },
  )
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      const step = requests.length
      const outputItem = step === 1
        ? {
            type: 'custom_tool_call', id: 'ctc-1', call_id: 'call-patch',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** Add File: probe.txt\n+ok\n*** End Patch\n',
          }
        : step === 2
          ? {
              type: 'function_call', id: 'fc-1', call_id: 'call-shell',
              name: 'shell_command',
              arguments: JSON.stringify({
                command: 'node -e "process.stdout.write(\'x\'.repeat(12000))"',
                workdir: directory,
              }),
            }
          : {
              type: 'message', role: 'assistant', id: 'msg-final',
              content: [{ type: 'output_text', text: '{"ok":true}' }],
            }
      const usage = {
        input_tokens: step, input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: step + 1,
      }
      const events = [
        { type: 'response.created', response: { id: `resp-${step}` } },
        { type: 'response.output_item.done', item: outputItem },
        { type: 'response.completed', response: { id: `resp-${step}`, usage } },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const usageSnapshots = []
  const quotaProxy = await startCodexCumulativeQuotaProxy({
    tokenLimit: 24_000,
    upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
    onUsage: usage => usageSnapshots.push(usage),
  })
  t.after(() => quotaProxy.close())
  const provider = 'model_providers.autoprompt-probe=' +
    `{name="probe",base_url=${JSON.stringify(quotaProxy.baseUrl)},env_key="OPENAI_API_KEY",` +
    'wire_api="responses",requires_openai_auth=false,supports_websockets=false,' +
    'supports_standalone_web_search=false,request_max_retries=0,stream_max_retries=0}'
  const result = await runPinnedCodex(cli, [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--output-schema', schemaPath, '--strict-config',
    '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--disable', 'code_mode', '--disable', 'code_mode_only',
    '--disable', 'goals', '--disable', 'memories', '--disable', 'token_budget',
    '--disable', 'current_time_reminder', '--disable', 'deferred_executor',
    '--disable', 'unbounded_connection_retries', '--disable', 'unified_exec',
    '--disable', 'view_image',
    '-c', `model_catalog_json=${JSON.stringify(transport.modelCatalogPath)}`,
    '-c', `model_instructions_file=${JSON.stringify(transport.instructionsPath)}`,
    '-c', 'model_provider="autoprompt-probe"', '-c', provider,
    '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
    '-c', 'tools.experimental_request_user_input.enabled=false',
    '-c', 'tools.update_plan.enabled=false',
    '-c', 'include_permissions_instructions=false',
    '-c', 'include_apps_instructions=false',
    '-c', 'include_collaboration_mode_instructions=false',
    '-c', 'include_environment_context=false',
    '-c', 'skills.include_instructions=false',
    '-c', 'project_doc_max_bytes=0', '-c', 'plugins={}', '-c', 'marketplaces={}',
    '-c', 'tool_output_token_limit=1000', '-c', 'model_auto_compact_token_limit=32768',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-m', 'gpt-5.6-sol', '--sandbox', 'workspace-write', '-C', directory, '-',
  ], {
    cwd: directory,
    env: environment,
  })
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.equal(requests.length, 3)
  assert.ok(requests.every(request => Number.isSafeInteger(request.max_output_tokens) &&
    request.max_output_tokens > 0 && request.max_output_tokens < 24_000))
  assert.deepEqual(quotaProxy.snapshot(), {
    tokenLimit: 24_000,
    requestCount: 3,
    providerRequestCount: 3,
    deniedCount: 0,
    hardStopped: false,
    usage: { noncachedInput: 6, cachedInput: 0, output: 3, reasoning: 0 },
    latestInputBound: quotaProxy.snapshot().latestInputBound,
    latestMaximumUnaccountedTokens: quotaProxy.snapshot().latestMaximumUnaccountedTokens,
    lastFailure: null,
  })
  assert.deepEqual(usageSnapshots.at(-1), {
    noncachedInput: 6, cachedInput: 0, output: 3, reasoning: 0,
  })
  assert.equal(fs.readFileSync(path.join(directory, 'probe.txt'), 'utf8'), 'ok\n')
  const events = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
  const toolEvents = events.filter(event => /^item\.(?:started|completed)$/u.test(event.type) &&
    ['file_change', 'command_execution'].includes(event.item && event.item.type))
  assert.equal(toolEvents.length, 4)
  for (const itemType of ['file_change', 'command_execution']) {
    const lifecycle = toolEvents.filter(event => event.item.type === itemType)
    assert.deepEqual(lifecycle.map(event => event.type), ['item.started', 'item.completed'])
    assert.equal(lifecycle[0].item.id, lifecycle[1].item.id)
  }
  const ids = new Set(toolEvents.map(event => event.item.id))
  assert.equal(ids.size, 2)
  const shellCompleted = toolEvents.find(event =>
    event.type === 'item.completed' && event.item.type === 'command_execution')
  assert.equal(shellCompleted.item.exit_code, 0)
  // The model sees the configured bounded preview while the controller still
  // retains the complete authenticated command output for verification.
  assert.equal(shellCompleted.item.aggregated_output, 'x'.repeat(12_000))
  const shellFeedback = requests[2].input.filter(item => item.type === 'function_call_output')
  assert.equal(shellFeedback.length, 1)
  const preview = JSON.stringify(shellFeedback[0])
  assert.match(preview, /truncated/u)
  assert.ok(Buffer.byteLength(preview) < 5_000)
  const terminal = events.find(event => event.type === 'turn.completed')
  assert.deepEqual(terminal.usage, {
    input_tokens: 6, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 3, reasoning_output_tokens: 0,
  })
})

test('cumulative quota relay bills cached input, injects a hard output cap, and denies a non-fitting replay', async t => {
  const upstreamBodies = []
  const upstream = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      upstreamBodies.push({ url: request.url, body: JSON.parse(body) })
      const event = {
        type: 'response.completed',
        response: {
          id: 'cached-response',
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 8 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 12,
          },
        },
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`)
    })
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const usageSnapshots = []
  const providerStarts = []
  const providerSettlements = []
  const quotaProxy = await startCodexCumulativeQuotaProxy({
    tokenLimit: 512,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    onUsage: usage => usageSnapshots.push(usage),
    onProviderRequestStarted: evidence => providerStarts.push(evidence),
    onProviderRequestSettled: evidence => providerSettlements.push(evidence),
  })
  t.after(() => quotaProxy.close())
  const endpoint = `${quotaProxy.baseUrl}/responses`

  const unknownRoute = await postJson(`${quotaProxy.baseUrl}/models`, {
    model: 'gpt-5.6-sol', input: [], stream: true,
  })
  assert.equal(unknownRoute.status, 404)
  assert.equal(upstreamBodies.length, 0)

  const accepted = await postJson(endpoint, {
    model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'bounded' }], stream: true,
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.aborted, false)
  const completedLine = accepted.body.split(/\r?\n/u).find(line => line.startsWith('data:'))
  const completed = JSON.parse(completedLine.slice(5).trim())
  assert.equal(completed.response.usage.codex_rollout_budget_units, 12)
  assert.equal(upstreamBodies.length, 1)
  assert.equal(upstreamBodies[0].url, '/v1/responses')
  assert.ok(Number.isSafeInteger(upstreamBodies[0].body.max_output_tokens))
  assert.ok(upstreamBodies[0].body.max_output_tokens > 0)
  assert.ok(upstreamBodies[0].body.max_output_tokens < 512)
  assert.deepEqual(usageSnapshots, [{
    noncachedInput: 2, cachedInput: 8, output: 2, reasoning: 1,
  }])
  assert.equal(providerStarts.length, 1)
  assert.equal(providerStarts[0].requestOrdinal, 1)
  assert.equal(providerStarts[0].maximumUnaccountedTokens, 512)
  assert.equal(providerSettlements.length, 1)
  assert.equal(providerSettlements[0].requestOrdinal, 1)
  assert.equal(providerSettlements[0].disposition, 'ACCOUNTED')

  const denied = await postJson(endpoint, {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: 'x'.repeat(1_024) }],
    stream: true,
  })
  assert.equal(denied.status, 429)
  assert.equal(upstreamBodies.length, 1)
  assert.deepEqual(quotaProxy.snapshot().usage, {
    noncachedInput: 2, cachedInput: 8, output: 2, reasoning: 1,
  })
  assert.equal(quotaProxy.snapshot().requestCount, 1)
  assert.equal(quotaProxy.snapshot().providerRequestCount, 1)
  assert.equal(quotaProxy.snapshot().deniedCount, 1)
  assert.equal(quotaProxy.snapshot().hardStopped, true)
  assert.equal(quotaProxy.snapshot().lastFailure.code, 'CODEX_CHILD_QUOTA_PREFLIGHT_DENIED')
})

test('accounting-only quota relay persists one finite model-context response bound', async t => {
  const upstreamBodies = []
  const upstream = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      upstreamBodies.push(JSON.parse(body))
      const event = {
        type: 'response.completed',
        response: {
          id: 'accounting-only-response',
          usage: {
            input_tokens: 1, input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        },
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`)
    })
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const starts = []
  const quotaProxy = await startCodexCumulativeQuotaProxy({
    tokenLimit: Number.MAX_SAFE_INTEGER,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    onProviderRequestStarted: evidence => starts.push(evidence),
  })
  t.after(() => quotaProxy.close())

  const accepted = await postJson(`${quotaProxy.baseUrl}/responses`, {
    model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'bounded context' }], stream: true,
  })
  assert.equal(accepted.status, 200)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].tokenLimit, Number.MAX_SAFE_INTEGER)
  const inputBound = quotaProxy.snapshot().latestInputBound.maximumInputTokens
  assert.equal(starts[0].maximumUnaccountedTokens, inputBound + 128_000)
  assert.equal(quotaProxy.snapshot().latestMaximumUnaccountedTokens, inputBound + 128_000)
  assert.equal(upstreamBodies.length, 1)
  assert.equal(
    upstreamBodies[0].max_output_tokens,
    128_000,
  )
})

test('cumulative quota relay fails closed when completed SSE omits usage', async t => {
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      upstreamCalls += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"missing"}}\n\n')
    })
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const quotaProxy = await startCodexCumulativeQuotaProxy({
    tokenLimit: 1_024,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
  })
  t.after(() => quotaProxy.close())
  const endpoint = `${quotaProxy.baseUrl}/responses`
  const failed = await postJson(endpoint, {
    model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'x' }], stream: true,
  })
  assert.equal(failed.aborted, true)
  assert.equal(upstreamCalls, 1)
  assert.equal(quotaProxy.snapshot().requestCount, 0)
  assert.equal(quotaProxy.snapshot().providerRequestCount, 1)
  assert.equal(quotaProxy.snapshot().hardStopped, true)
  assert.equal(quotaProxy.snapshot().lastFailure.code, 'CODEX_USAGE_INVALID')
  const retry = await postJson(endpoint, {
    model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'retry' }], stream: true,
  })
  assert.equal(retry.status, 429)
  assert.equal(upstreamCalls, 1)
})

test('cumulative quota relay fails closed on truncated streams and provider bound violations', async t => {
  const cases = [
    {
      id: 'truncated',
      expectedCode: 'CODEX_USAGE_INCOMPLETE',
      tokenLimit: 1_024,
      events: [{ type: 'response.created', response: { id: 'truncated' } }],
    },
    {
      id: 'input-over-bound',
      expectedCode: 'CODEX_CHILD_QUOTA_BOUND_VIOLATED',
      tokenLimit: 20_000,
      exactUsage: {
        noncachedInput: 1_000, cachedInput: 9_000, output: 1, reasoning: 0,
      },
      events: [{
        type: 'response.completed',
        response: {
          id: 'over-bound',
          usage: {
            input_tokens: 10_000,
            input_tokens_details: { cached_tokens: 9_000 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 10_001,
          },
        },
      }],
    },
    {
      id: 'aggregate-over-bound',
      expectedCode: 'CODEX_CHILD_QUOTA_BOUND_VIOLATED',
      tokenLimit: 1_024,
      exactUsage: {
        noncachedInput: 400, cachedInput: 500, output: 200, reasoning: 0,
      },
      events: [{
        type: 'response.completed',
        response: {
          id: 'aggregate-over-bound',
          usage: {
            input_tokens: 900,
            input_tokens_details: { cached_tokens: 500 },
            output_tokens: 200,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 1_100,
          },
        },
      }],
    },
  ]
  for (const scenario of cases) {
    await t.test(scenario.id, async child => {
      let upstreamCalls = 0
      const upstream = http.createServer((request, response) => {
        request.resume()
        request.on('end', () => {
          upstreamCalls += 1
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(scenario.events.map(event =>
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        })
      })
      await new Promise((resolve, reject) => {
        upstream.once('error', reject)
        upstream.listen(0, '127.0.0.1', resolve)
      })
      child.after(() => new Promise(resolve => upstream.close(resolve)))
      const providerStarts = []
      const providerSettlements = []
      const exactUsage = []
      const quotaProxy = await startCodexCumulativeQuotaProxy({
        tokenLimit: scenario.tokenLimit,
        upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        onProviderRequestStarted: evidence => providerStarts.push(evidence),
        onProviderRequestSettled: evidence => providerSettlements.push(evidence),
        onUsage: usage => exactUsage.push(usage),
      })
      child.after(() => quotaProxy.close())
      const endpoint = `${quotaProxy.baseUrl}/responses`
      const failed = await postJson(endpoint, {
        model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'x' }], stream: true,
      })
      assert.equal(failed.aborted, true)
      assert.equal(upstreamCalls, 1)
      assert.equal(quotaProxy.snapshot().requestCount, scenario.exactUsage ? 1 : 0)
      assert.equal(quotaProxy.snapshot().providerRequestCount, 1)
      assert.equal(quotaProxy.snapshot().hardStopped, true)
      assert.equal(quotaProxy.snapshot().lastFailure.code, scenario.expectedCode)
      assert.equal(providerStarts.length, 1)
      assert.equal(providerSettlements.length, scenario.exactUsage ? 1 : 0)
      assert.equal(exactUsage.length, scenario.exactUsage ? 1 : 0)
      if (scenario.exactUsage) {
        assert.deepEqual(exactUsage[0], scenario.exactUsage)
        assert.deepEqual(quotaProxy.snapshot().usage, scenario.exactUsage)
      }
      const retry = await postJson(endpoint, {
        model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'retry' }], stream: true,
      })
      assert.equal(retry.status, 429)
      assert.equal(upstreamCalls, 1)
    })
  }
})

test('cumulative quota relay does not acknowledge usage when durable accounting throws', async t => {
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const event = {
        type: 'response.completed',
        response: {
          id: 'accounting-callback-failure',
          usage: {
            input_tokens: 2,
            input_tokens_details: { cached_tokens: 1 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 3,
          },
        },
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`)
    })
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const starts = []
  const settlements = []
  const quotaProxy = await startCodexCumulativeQuotaProxy({
    tokenLimit: 1_024,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    onProviderRequestStarted: evidence => starts.push(evidence),
    onProviderRequestSettled: evidence => settlements.push(evidence),
    onUsage() {
      throw Object.assign(new Error('durable usage writer unavailable'), {
        code: 'ACCOUNTING_WRITE_UNAVAILABLE',
      })
    },
  })
  t.after(() => quotaProxy.close())
  const failed = await postJson(`${quotaProxy.baseUrl}/responses`, {
    model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'x' }], stream: true,
  })
  assert.equal(failed.aborted, true)
  assert.equal(starts.length, 1)
  assert.equal(settlements.length, 0)
  assert.equal(quotaProxy.snapshot().requestCount, 0)
  assert.equal(quotaProxy.snapshot().providerRequestCount, 1)
  assert.equal(quotaProxy.snapshot().hardStopped, true)
  assert.equal(quotaProxy.snapshot().lastFailure.code, 'ACCOUNTING_WRITE_UNAVAILABLE')
})

test('durable provider allowance replay distinguishes exact usage from unknown spend', () => {
  const sessionHash = crypto.createHash('sha256').update('provider-session').digest('hex')
  const pendingCause = `codex-provider-pending:${sessionHash}:1:16000:16000:0`
  const usageCause = `codex-provider-usage:${sessionHash}:1:1`
  const pendingOnly = unresolvedCodexProviderEnvelopes([
    accountingRecord(1, pendingCause),
  ])
  assert.equal(pendingOnly.length, 1)
  assert.equal(pendingOnly[0].maximumUnaccountedTokens, 16_000)
  assert.equal(pendingOnly[0].exactUsageRecorded, false)

  const exactButUnsettled = unresolvedCodexProviderEnvelopes([
    accountingRecord(1, pendingCause),
    accountingRecord(2, usageCause, 4_000),
  ])
  assert.equal(exactButUnsettled.length, 1)
  assert.equal(exactButUnsettled[0].exactUsageRecorded, true)
  assert.equal(exactButUnsettled[0].exactUsageTokens, 4_000)
  assert.deepEqual(unresolvedCodexProviderEnvelopes([
    accountingRecord(1, pendingCause),
    accountingRecord(2, usageCause, 4_000),
    accountingRecord(3, `codex-provider-settled:${sessionHash}:1:ACCOUNTED`),
  ]), [])

  const exactOverage = unresolvedCodexProviderEnvelopes([
    accountingRecord(1, pendingCause),
    accountingRecord(2, usageCause, 20_000),
  ])
  assert.equal(exactOverage.length, 1)
  assert.equal(exactOverage[0].maximumUnaccountedTokens, 16_000)
  assert.equal(exactOverage[0].exactUsageTokens, 20_000)
  assert.deepEqual(unresolvedCodexProviderEnvelopes([
    accountingRecord(1, pendingCause),
    accountingRecord(2, usageCause, 20_000),
    accountingRecord(3, `codex-provider-settled:${sessionHash}:1:ACCOUNTED`),
  ]), [])

  assert.deepEqual(unresolvedCodexProviderEnvelopes([
    accountingRecord(1, pendingCause),
    accountingRecord(2, `codex-provider-charge:${sessionHash}:1:LIVE`, 16_000),
    accountingRecord(3, `codex-provider-settled:${sessionHash}:1:UPPER_BOUND_CHARGED`),
  ]), [])
})

test('crash recovery burns an unresolved 16k route envelope before later reservations', () => {
  const sessionHash = crypto.createHash('sha256').update('crashed-route-session').digest('hex')
  const records = [accountingRecord(
    1,
    `codex-provider-pending:${sessionHash}:1:16000:16000:0`,
  )]
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.activation = { generation: 2 }
  runtime.options = { accountingAuthority: { replay: () => ({ records }) } }
  runtime.budget = new BudgetController({
    limits: { wallMs: 60_000, tokens: 48_000, sessions: 10, launches: 10 },
    phases: {},
  })
  runtime.childTokenReservations = new Map()
  runtime.pendingProviderEnvelopes = new Map()
  runtime.recoveredProviderEnvelopeHighWater = new Map()
  const checkpoints = []
  runtime._checkpointAccounting = (cause, delta) => checkpoints.push({ cause, delta })

  const recovered = runtime._recoverUnresolvedProviderEnvelopes()
  assert.deepEqual(recovered, [{
    key: `${sessionHash}:1`,
    disposition: 'RECOVERY_UPPER_BOUND_CHARGED',
    chargedTokens: 16_000,
    leaseHighWater: 16_000,
  }])
  assert.equal(runtime.budget.snapshot().tokensUsed, 16_000)
  assert.equal(runtime.recoveredProviderEnvelopeHighWater.get(sessionHash), 16_000)
  assert.match(checkpoints[0].cause.causeId,
    new RegExp(`^codex-provider-charge:${sessionHash}:1:RECOVERY_2$`, 'u'))
  assert.equal(checkpoints[1].cause.causeId,
    `codex-provider-settled:${sessionHash}:1:RECOVERY_UPPER_BOUND_CHARGED`)

  assert.equal(runtime._reserveChildTokenEnvelope('worker-after-crash', {
    logicalRole: 'worker', route: 'DIRECT', priorLeaseModelTokens: 0,
  }).limit, 32_000)
  assert.throws(() => runtime._reserveChildTokenEnvelope('remainder-after-crash', {
    logicalRole: 'independent-reviewer', route: 'DIRECT', priorLeaseModelTokens: 0,
  }), error => error.code === 'BUDGET_EXHAUSTED')
})

test('crash recovery does not double-charge exact request-bound usage', () => {
  const sessionHash = crypto.createHash('sha256').update('exact-crashed-session').digest('hex')
  const records = [
    accountingRecord(1, `codex-provider-pending:${sessionHash}:1:16000:16000:0`),
    accountingRecord(2, `codex-provider-usage:${sessionHash}:1:1`, 4_000),
  ]
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.activation = { generation: 2 }
  runtime.options = { accountingAuthority: { replay: () => ({ records }) } }
  runtime.budget = new BudgetController({
    limits: { wallMs: 60_000, tokens: 48_000, sessions: 10, launches: 10 },
    phases: {},
  })
  runtime.budget.consumeTokens(4_000)
  runtime.recoveredProviderEnvelopeHighWater = new Map()
  runtime._checkpointAccounting = () => null
  const recovered = runtime._recoverUnresolvedProviderEnvelopes()
  assert.equal(recovered[0].disposition, 'RECOVERY_ACCOUNTED')
  assert.equal(recovered[0].chargedTokens, 0)
  assert.equal(recovered[0].leaseHighWater, 4_000)
  assert.equal(runtime.budget.snapshot().tokensUsed, 4_000)
})

test('accounting-only unknown spend and crash recovery charge one response, not the sentinel', () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.budget = new BudgetController({
    limits: {
      wallMs: 60_000, tokens: Number.MAX_SAFE_INTEGER,
      sessions: 10, launches: 10,
    },
    phases: {},
  })
  runtime.childTokenReservations = new Map()
  const worker = runtime._reserveChildTokenEnvelope('default-worker', {
    logicalRole: 'worker', route: 'DIRECT', priorLeaseModelTokens: 0,
  })
  assert.equal(worker.finiteTokenBudget, false)
  assert.deepEqual(runtime._chargeUnknownChildTokenUpperBound('default-worker', 272_000), {
    charged: 272_000,
    limit: Number.MAX_SAFE_INTEGER,
    consumed: 272_000,
    remaining: Number.MAX_SAFE_INTEGER - 272_000,
  })
  runtime._releaseChildTokenEnvelope('default-worker')
  const checker = runtime._reserveChildTokenEnvelope('default-checker', {
    logicalRole: 'independent-reviewer', route: 'DIRECT', priorLeaseModelTokens: 0,
  })
  assert.equal(checker.finiteTokenBudget, false)
  assert.equal(checker.limit, Number.MAX_SAFE_INTEGER - 272_000)

  const sessionHash = crypto.createHash('sha256')
    .update('accounting-only-crash-session').digest('hex')
  const recovered = Object.create(CodexSupervisorRuntime.prototype)
  recovered.activation = { generation: 2 }
  recovered.options = { accountingAuthority: { replay: () => ({ records: [
    accountingRecord(
      1,
      `codex-provider-pending:${sessionHash}:1:${Number.MAX_SAFE_INTEGER}:272000:0:0`,
    ),
  ] }) } }
  recovered.budget = new BudgetController({
    limits: {
      wallMs: 60_000, tokens: Number.MAX_SAFE_INTEGER,
      sessions: 10, launches: 10,
    },
    phases: {},
  })
  recovered.childTokenReservations = new Map()
  recovered.pendingProviderEnvelopes = new Map()
  recovered.recoveredProviderEnvelopeHighWater = new Map()
  recovered._checkpointAccounting = () => null
  assert.deepEqual(recovered._recoverUnresolvedProviderEnvelopes(), [{
    key: `${sessionHash}:1`,
    disposition: 'RECOVERY_UPPER_BOUND_CHARGED',
    chargedTokens: 272_000,
    leaseHighWater: 272_000,
  }])
  assert.equal(recovered.budget.snapshot().tokensUsed, 272_000)
  const recoveredChecker = recovered._reserveChildTokenEnvelope('recovered-checker', {
    logicalRole: 'independent-reviewer', route: 'DIRECT', priorLeaseModelTokens: 0,
  })
  assert.equal(recoveredChecker.finiteTokenBudget, false)
  assert.equal(recoveredChecker.limit, Number.MAX_SAFE_INTEGER - 272_000)
})

test('durable tool-call high-water rejects gaps and restores exact ordinals', () => {
  const continuationHash = crypto.createHash('sha256').update('continuation').digest('hex')
  assert.equal(codexToolCallHighWater([], continuationHash), 0)
  assert.equal(codexToolCallHighWater([
    accountingRecord(1, `codex-tool-call:${continuationHash}:1`),
    accountingRecord(2, `codex-tool-call:${continuationHash}:2`),
  ], continuationHash), 2)
  assert.throws(() => codexToolCallHighWater([
    accountingRecord(1, `codex-tool-call:${continuationHash}:2`),
  ], continuationHash), error => error.code === 'CODEX_USAGE_INVALID')
})

test('activation quota reservations prevent concurrent child envelopes from multiplying the 48k ceiling', () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.budget = new BudgetController({
    limits: { wallMs: 60_000, tokens: 48_000, sessions: 10, launches: 10 },
    phases: {},
  })
  runtime.childTokenReservations = new Map()

  const worker = runtime._reserveChildTokenEnvelope('worker', {
    logicalRole: 'worker', route: 'ROADMAP',
  })
  assert.equal(worker.limit, 48_000)
  assert.throws(() => runtime._reserveChildTokenEnvelope('checker', {
    logicalRole: 'independent-reviewer', route: 'ROADMAP',
  }), error => error.code === 'BUDGET_EXHAUSTED' &&
    error.details.tokensUsed === 0 && error.details.tokensReserved === 48_000)

  assert.deepEqual(runtime._consumeChildTokenReservation('worker', 8_000), {
    limit: 48_000, consumed: 8_000, remaining: 40_000,
  })
  assert.equal(runtime.budget.snapshot().tokensUsed, 8_000)
  assert.deepEqual(runtime._releaseChildTokenEnvelope('worker'), {
    limit: 48_000, consumed: 8_000, released: 40_000,
  })
  const route = runtime._reserveChildTokenEnvelope('route', {
    logicalRole: 'route-analyst', route: 'PRE_ROUTE',
  })
  assert.equal(route.limit, 8_000)
  const remainder = runtime._reserveChildTokenEnvelope('activation-remainder', {
    logicalRole: 'worker', route: 'ROADMAP',
  })
  assert.equal(remainder.limit, 32_000)
  assert.throws(() => runtime._reserveChildTokenEnvelope('still-overflow', {
    logicalRole: 'worker', route: 'ROADMAP',
  }), error => error.code === 'BUDGET_EXHAUSTED')

  runtime._consumeChildTokenReservation('route', 8_000)
  runtime._releaseChildTokenEnvelope('route')
  runtime._consumeChildTokenReservation('activation-remainder', 32_000)
  runtime._releaseChildTokenEnvelope('activation-remainder')
  assert.equal(runtime.budget.snapshot().tokensUsed, 48_000)
  assert.equal(runtime.childTokenReservations.size, 0)
  assert.throws(() => runtime._reserveChildTokenEnvelope('after-ceiling', {
    logicalRole: 'worker', route: 'ROADMAP',
  }), error => error.code === 'BUDGET_EXHAUSTED')
})

test('unknown billed route usage burns its 8k reservation before deterministic fallback', () => {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.budget = new BudgetController({
    limits: { wallMs: 60_000, tokens: 48_000, sessions: 10, launches: 10 },
    phases: {},
  })
  runtime.childTokenReservations = new Map()

  const route = runtime._reserveChildTokenEnvelope('unknown-route', {
    logicalRole: 'route-analyst', route: 'PRE_ROUTE',
  })
  assert.equal(route.limit, 8_000)
  assert.deepEqual(runtime._chargeUnknownChildTokenUpperBound('unknown-route', 8_000), {
    charged: 8_000, limit: 8_000, consumed: 8_000, remaining: 0,
  })
  assert.equal(runtime.budget.snapshot().tokensUsed, 8_000)
  assert.deepEqual(runtime._releaseChildTokenEnvelope('unknown-route'), {
    limit: 8_000, consumed: 8_000, released: 0,
  })

  const worker = runtime._reserveChildTokenEnvelope('post-route-worker', {
    logicalRole: 'worker', route: 'DIRECT',
  })
  assert.equal(worker.limit, 40_000)
  assert.throws(() => runtime._reserveChildTokenEnvelope('post-route-remainder', {
    logicalRole: 'independent-reviewer', route: 'DIRECT',
  }), error => error.code === 'BUDGET_EXHAUSTED' &&
    error.details.tokensUsed === 8_000 && error.details.tokensReserved === 40_000)
})

function authority(scheduler, parentLease = null) {
  sequence += 1
  return scheduler.issueLaunchAuthority({
    callerRole: parentLease ? 'ap-parent' : 'ap-root',
    sessionId: `cost-session-${sequence}`,
    ...RUN,
    parentLease,
    providerCapabilities: CAPABILITIES,
  })
}

function admit(scheduler, request, parentLease = null) {
  return scheduler.acquireWithAuthority(authority(scheduler, parentLease), {
    role: 'ap-worker',
    ...request,
  })
}

function finish(lease) {
  lease.complete(ZERO)
}

function valueCase(boundary) {
  return {
    failureMode: 'a separate optional check misses a production defect',
    disjointBoundary: boundary,
    estimatedTokens: 1,
    estimatedMs: 1,
    defectProbability: 1,
    severityWeight: 10,
    avoidedRework: 100,
  }
}

test('AP-COST-005 four nested levels share one live-cap semaphore', async () => {
  const scheduler = new CentralScheduler({
    route: 'ROADMAP',
    liveCeiling: 5,
    runIdentity: RUN,
  })
  const level1 = await admit(scheduler, { workItemId: 'level-1' })
  const level2 = await admit(scheduler, { workItemId: 'level-2' }, level1)
  const level3 = await admit(scheduler, { workItemId: 'level-3' }, level2)
  const level4 = await admit(scheduler, { workItemId: 'level-4' }, level3)
  let overflowStarted = false
  const overflowPromise = admit(scheduler, { workItemId: 'queued-overflow' })
    .then(lease => { overflowStarted = true; return lease })
  await Promise.resolve()
  assert.equal(overflowStarted, false)
  assert.equal(scheduler.getMetrics().counters.currentLiveIncludingRoot, 5)
  assert.equal(scheduler.getMetrics().counters.peakLiveIncludingRoot, 5)
  assert.equal(scheduler.getMetrics().counters.maxDepthObserved, 4)

  finish(level4)
  const overflow = await overflowPromise
  assert.equal(overflowStarted, true)
  assert.equal(scheduler.getMetrics().counters.peakLiveIncludingRoot, 5)
  finish(overflow)
  finish(level3)
  finish(level2)
  finish(level1)
})

test('AP-COST-009 records and restores roadmap/user-ask ratio with the plan hash', () => {
  const scheduler = new CentralScheduler({ route: 'ROADMAP', runIdentity: RUN })
  const expansionAdmission = bindRoadmapExpansionAdmission({
    accepted: true,
    authorityId: 'independent-scope-review',
    authorityReceiptHash: 'd'.repeat(64),
    admittedAskCount: 3,
    missionScopeHash: 'e'.repeat(64),
    planSha256: 'a'.repeat(64),
    necessityEvidenceHash: 'b'.repeat(64),
    marginalValueEvidenceHash: 'c'.repeat(64),
  })
  const measurement = scheduler.recordRoadmapAskRatio({
    roadmapAskCount: 6,
    userAskCount: 3,
    missionScopeHash: 'e'.repeat(64),
    planSha256: 'a'.repeat(64),
    expansionAdmission,
  })
  assert.deepEqual(measurement, {
    roadmapAskCount: 6,
    userAskCount: 3,
    roadmapAskToUserAskRatio: 2,
    missionScopeHash: 'e'.repeat(64),
    planSha256: 'a'.repeat(64),
    askCeiling: 6,
    expansionAdmission,
  })
  assert.deepEqual(scheduler.getMetrics().economics.roadmapAskMeasurement, measurement)
  const restored = new CentralScheduler({ runIdentity: RUN, state: scheduler.exportState() })
  assert.deepEqual(restored.getMetrics().economics.roadmapAskMeasurement, measurement)
  assert.throws(() => scheduler.recordRoadmapAskRatio({
    roadmapAskCount: 6,
    userAskCount: 3,
    missionScopeHash: 'f'.repeat(64),
    planSha256: 'a'.repeat(64),
    expansionAdmission,
  }), error => error.code === 'ROADMAP_EXPANSION_NOT_ADMITTED')
})

test('AP-COST-011 agents=off applies role effort instead of inheriting root xhigh', () => {
  const activation = { modelSelection: { mode: 'provider-default' } }
  assert.deepEqual(readPrivateAgentAssignment(activation, 'ap-finalizer', 'finalizer'), {
    model: null,
    effort: 'low',
    source: 'role-effort-policy',
    registryMatched: false,
    routeIndependent: true,
  })
  assert.equal(readPrivateAgentAssignment(activation, 'ap-worker', 'worker').effort, 'medium')
  assert.equal(readPrivateAgentAssignment(
    activation, 'ap-route-analyst', 'route-analyst',
  ).effort, 'low')
})

test('AP-COST-012 accepts only a fresh evidence-bound economic registry envelope', () => {
  const nowMs = Date.parse('2026-08-23T12:00:00.000Z')
  const registry = sealReceiptBoundRegistry({
    schemaVersion: 'codex-model-registry.v1',
    issuer: 'independent-model-benchmark',
    observedAt: '2026-08-23T10:00:00.000Z',
    expiresAt: '2026-08-24T10:00:00.000Z',
    evidenceSha256: 'b'.repeat(64),
    entries: [{
      id: 'measured-cheapest', verified: true, efforts: ['medium'], capabilities: { tools: true },
      price: { perTokens: 1000000, noncachedInput: 1, cachedInput: 0.5, output: 2 },
      latency: { p50Ms: 20, sampleSize: 30 }, yield: { successRate: 0.9, sampleSize: 30 },
    }],
  })
  assert.equal(validateReceiptBoundRegistry(registry, { nowMs }).entries.length, 1)
  const selected = selectModelAssignment({
    role: 'worker', registry, nowMs, requiredCapabilities: ['tools'],
    workload: { noncachedInput: 1000, cachedInput: 1000, output: 100 },
  })
  assert.equal(selected.model, 'measured-cheapest')
  assert.equal(selected.registryReceiptSha256, registry.bindingSha256)
  assert.throws(
    () => validateReceiptBoundRegistry({ ...registry, issuer: 'tampered' }, { nowMs }),
    error => error.code === 'MODEL_REGISTRY_RECEIPT_INVALID',
  )
})

test('AP-COST-016/021 preserve optional aliases and reject duplicate sweep boundaries', async () => {
  const scheduler = new CentralScheduler({ route: 'ROADMAP', runIdentity: RUN })
  await assert.rejects(admit(scheduler, {
    workItemId: 'alias-without-value',
    role: 'autoprompt.v2.ap-juror@generation-1',
  }), error => error.code === 'MARGINAL_VALUE_REQUIRED')

  const sweep = await admit(scheduler, {
    workItemId: 'sweep-auth',
    role: 'autoprompt.v2.ap-sweeper@generation-1',
    valueCase: valueCase('authorization boundary'),
  })
  await assert.rejects(admit(scheduler, {
    workItemId: 'juror-same-boundary',
    role: 'autoprompt.v2.ap-juror@generation-1',
    valueCase: valueCase('AUTHORIZATION BOUNDARY'),
  }), error => error.code === 'OPTIONAL_BOUNDARY_DUPLICATE')
  assert.equal(scheduler.getMetrics().economics.optionalBoundaryCount, 1)
  finish(sweep)
})

test('AP-COST-020 resumes a deadline-bound activation with its persisted reserves', () => {
  let monotonicNow = 100
  const admittedAtMs = Date.parse('2026-08-23T12:00:00.000Z')
  const options = {
    limits: { wallMs: 1000, tokens: 1000, sessions: 10, launches: 10 },
    finalizationReserveMs: 1,
    monotonicClockId: 'cost-monotonic-clock',
    monotonicMs: () => monotonicNow,
    wallNowMs: () => admittedAtMs,
    wallClock: () => '2026-08-23T12:00:00.000Z',
  }
  const initial = new BudgetController(options)
  initial.bindDeadline({
    deadline: {
      absoluteDeadline: '2026-08-23T12:00:01.000Z',
      source: 'product-maximum',
      verificationReservePercent: 25,
      recoveryAndFinalizationReservePercent: 10,
    },
    wallMs: 1000,
    verificationReserveMs: 250,
    finalizationReserveMs: 100,
    admittedAtMs,
  })
  monotonicNow = 101
  const snapshot = initial.snapshot()
  const restored = new BudgetController({ ...options, snapshot }).snapshot()
  assert.equal(restored.verificationReserveMs, 250)
  assert.equal(restored.finalizationReserveMs, 100)

  assert.throws(
    () => new BudgetController({
      ...options,
      snapshot: { ...snapshot, verificationReserveMs: 249 },
    }),
    error => error.code === 'BUDGET_SNAPSHOT_INVALID',
  )
})

test('AP-DESIGN-003 writes a readable decision markdown derived from canonical JSON', () => {
  const decision = {
    route: 'LIGHT', routeSource: 'automatic', decidedAt: '2026-08-23T12:00:00.000Z',
    requestedResult: 'Close the local routing gap.',
    successChecklist: ['The saved choice can be audited.'],
    plannedChecks: ['Run the focused route artifact test.'],
    likelyAreas: ['agents/codex/workflow/phase-budget.js'],
    risks: ['Markdown must remain derived from the canonical object.'],
    missingInformation: [],
    usefulWorkerCount: 1,
    workerOwnershipReason: 'One writer owns the narrow persistence seam.',
    independentCheckingPlan: {
      checkerCount: 1,
      responsibilities: ['Check both persisted formats for the same reasoning.'],
      nonOverlapReason: 'One independent responsibility is sufficient.',
    },
    chosenRouteReason: 'A short design pass is useful before the bounded change.',
    rejectedRouteReasons: {
      DIRECT: 'The persistence format needs a small design choice.',
      ROADMAP: 'There is no cross-system dependency.',
    },
    analystDisagreement: null,
    routeChangeTrigger: {
      event: 'MULTI_SURFACE_DISCOVERED',
      factRequired: 'Evidence of a second dependent writable output.',
    },
  }
  const writes = new Map()
  writeRouteDecisionArtifacts({ write: (relative, content) => writes.set(relative, content) }, decision)
  assert.deepEqual(JSON.parse(writes.get('route/decision.json')), decision)
  assert.equal(writes.get('route/decision.md'), renderRouteDecisionMarkdown(decision))
  for (let section = 1; section <= 12; section += 1) {
    assert.match(writes.get('route/decision.md'), new RegExp(`^## ${section}\\. `, 'm'))
  }
  assert.match(writes.get('route/decision.md'), /Why Other Routes Were Rejected/)
  assert.match(writes.get('route/decision.md'), /Evidence of a second dependent writable output\./)
})

test('AP-DESIGN-002 appends each route event at the streaming boundary', () => {
  const appended = []
  const event = { id: 'stream-1', type: 'message', text: 'evidence arrived' }
  appendCanonicalRouteEvent({ appendRouteEvent: (...args) => appended.push(args) }, event, '{"id":"stream-1"}\n')
  assert.equal(appended.length, 1)
  assert.equal(appended[0][0], event)
  assert.equal(appended[0][1].rawBytes.toString('utf8'), '{"id":"stream-1"}\n')
})

test('AP-DESIGN-005 completion boundary blocks terminal binding', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cost-finalizer-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const terminalPath = path.join(directory, 'terminal.json')
  const deliverablePath = path.join(directory, 'user-usable-build.txt')
  fs.writeFileSync(deliverablePath, 'verified user-usable build\n')
  const deliverableHash = crypto.createHash('sha256').update(fs.readFileSync(deliverablePath)).digest('hex')
  let bindCalls = 0
  const state = { state: 'FINALIZING', workspaceEpoch: 0 }
  const finalizer = new Finalizer({
    stateStore: {
      registeredPaths: { runRecordRoot: directory, terminalPath },
      load: () => state,
      bindTerminal: () => { bindCalls += 1 },
    },
    processOwner: {
      ownershipIdentities: () => [], cancelAll: async () => [], assertTargetDrained: async () => true,
    },
    missionLock: {
      describe: () => ({ status: 'ACTIVE', owner: { targetKey: 'target', ownedProcessHistory: [] } }),
      assertOwned: () => true, updateOwnedProcesses: () => true,
    },
    capability: {},
    cleanupRegistry: { run: () => true },
    completionBoundary: () => { const error = new Error('tracked run record'); error.code = 'RUN_RECORD_UNSAFE'; throw error },
  })
  await assert.rejects(finalizer.finalize({
    outcome: 'DONE',
    expectedEpoch: 0,
    deliverables: [{ path: deliverablePath, hash: deliverableHash }],
    checkHashes: ['a'.repeat(64)],
  }),
    error => error.code === 'RUN_RECORD_UNSAFE')
  assert.equal(bindCalls, 0)
})

test('AP-DESIGN-023 fresh replay is derived only from the persisted assignment', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cost-assignment-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workItemId = 'work-1'
  const relative = `work/assignments/${require('node:crypto').createHash('sha256').update(workItemId).digest('hex')}.json`
  const absolute = path.join(directory, ...relative.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const assignment = {
    schemaVersion: '2.0.0', reportType: 'assignment', assignmentId: workItemId,
    runId: 'persisted-run', requestEnvelopeHash: 'f'.repeat(64), logicalRoleId: 'worker',
    findingIds: ['AP-DESIGN-023'], requestedResult: 'Replay this exact bounded assignment.',
    resources: [
      {
        kind: 'file', identity: 'src/owned.js', owner: 'worker-1',
        ownershipMode: 'single-owner', access: 'write',
      },
      {
        kind: 'file', identity: 'request/input.json', owner: 'worker-1',
        ownershipMode: 'single-owner', access: 'read',
      },
    ],
    successChecklist: [{ id: 'success-1', description: 'Owned behavior passes.' }],
    checks: ['node --test focused.test.cjs'], forbiddenChanges: ['Do not touch other files.'],
    resultLocation: 'work/results/result.json',
  }
  fs.writeFileSync(absolute, `${JSON.stringify(assignment)}\n`)
  const record = { resolve: candidate => path.join(directory, ...candidate.split('/')) }
  const opened = readPersistedWorkerAssignment(record, workItemId, {
    runId: 'persisted-run', requestEnvelopeHash: 'f'.repeat(64), logicalRoleId: 'worker',
  })
  assert.deepEqual(replayRequestFromPersistedAssignment(opened), {
    assignment: assignment.requestedResult,
    successChecklist: ['Owned behavior passes.'], success: ['Owned behavior passes.'],
    checks: assignment.checks,
    findingIds: assignment.findingIds,
    ownership: [{
      kind: 'file', identity: 'src/owned.js', owner: 'worker-1', ownershipMode: 'single-owner',
    }],
    manifests: [{
      kind: 'file', identity: 'src/owned.js', owner: 'worker-1', ownershipMode: 'single-owner',
    }],
    snapshotProjection: null,
    replayedAssignmentPath: relative,
  })
})

test('assignment findings consume only explicit fields and use a stable local fallback', () => {
  const request = {
    workItemId: 'work-unrelated', logicalRole: 'worker', parent: 'run-owner',
    assignment: 'Write the ordinary response; the quoted history mentions AP-DESIGN-023.',
    successChecklist: ['Do not infer AP-TRACE-013 from this prose.'],
    checks: ['Confirm output without treating AP-RUN-026 as a finding.'],
  }
  assert.deepEqual(explicitFindingIds(
    request,
    request.assignment,
    'mission text mentions AP-RUN-027',
  ), [])
  const binding = { requestEnvelopeHash: 'a'.repeat(64) }
  const freshId = assignmentLocalFindingId(request, binding)
  const resumedId = assignmentLocalFindingId(structuredClone(request), structuredClone(binding))
  assert.match(freshId, /^AP-WORK-[0-9]{78}$/u)
  assert.equal(resumedId, freshId)
  assert.doesNotMatch(freshId, /AP-(?:DESIGN|TRACE|RUN)-/u)
  assert.deepEqual(explicitFindingIds({
    ...request,
    findingIds: ['customer-finding-7'],
  }), ['customer-finding-7'])
})

test('W3/C2 assignment-local finding ids are unique and resume-stable across corrections and repair', () => {
  const requests = [
    { workItemId: 'route-analyst', logicalRole: 'route-analyst' },
    ...[1, 2, 3].map(ordinal => ({
      workItemId: `work-${ordinal}`, logicalRole: 'worker',
    })),
    ...[1, 2, 3].map(ordinal => ({
      workItemId: `work-${ordinal}-transport-retry-1`, logicalRole: 'worker',
    })),
    { workItemId: 'work-1-repair-1', logicalRole: 'worker' },
    ...[1, 2].flatMap(seat => {
      const logicalRole = seat === 1 ? 'independent-reviewer' : 'independent-tester'
      return [
        { workItemId: `independent-check-${seat}`, logicalRole },
        { workItemId: `independent-check-${seat}-runtime-retry-1`, logicalRole },
        { workItemId: `independent-check-${seat}-repair-1`, logicalRole },
        { workItemId: `independent-check-${seat}-repair-1-runtime-retry-1`, logicalRole },
      ]
    }),
  ].map(request => ({
    ...request,
    parent: request.logicalRole === 'route-analyst' ? 'deterministic-control-plane' : 'run-owner',
    assignment: `Exact assignment for ${request.workItemId}`,
    checks: [`Verify ${request.workItemId}`],
  }))
  const binding = { requestEnvelopeHash: 'b'.repeat(64) }
  const freshRegistry = new Map()
  const freshIds = requests.map(request =>
    assignmentLocalFindingId(request, binding, freshRegistry))
  assert.deepEqual(freshIds, [
    'AP-WORK-001',
    'AP-WORK-101', 'AP-WORK-102', 'AP-WORK-103',
    'AP-WORK-201', 'AP-WORK-202', 'AP-WORK-203',
    'AP-WORK-301',
    'AP-WORK-401', 'AP-WORK-421', 'AP-WORK-441', 'AP-WORK-461',
    'AP-WORK-402', 'AP-WORK-422', 'AP-WORK-442', 'AP-WORK-462',
  ])
  assert.equal(new Set(freshIds).size, requests.length)
  const resumedRegistry = new Map()
  const resumedIds = structuredClone(requests).map(request =>
    assignmentLocalFindingId(request, structuredClone(binding), resumedRegistry))
  assert.deepEqual(resumedIds, freshIds)

  const dynamicRequests = Array.from({ length: 512 }, (_, ordinal) => ordinal % 2 === 0
    ? {
        workItemId: `work-${100 + ordinal}-repair-${10 + ordinal}`,
        logicalRole: 'worker',
        assignment: `Dynamic repair assignment ${ordinal}`,
      }
    : {
        workItemId: `independent-check-${10 + ordinal}-repair-${3 + ordinal}`,
        logicalRole: 'independent-tester',
        assignment: `Dynamic checker assignment ${ordinal}`,
      })
  const dynamicRegistry = new Map()
  const dynamicIds = dynamicRequests.map(request =>
    assignmentLocalFindingId(request, binding, dynamicRegistry))
  assert.equal(new Set(dynamicIds).size, dynamicRequests.length)
  assert.ok(dynamicIds.every(id => /^AP-WORK-[0-9]{78}$/u.test(id)))
  const resumedDynamicRegistry = new Map()
  const resumedDynamicIds = structuredClone(dynamicRequests).map(request =>
    assignmentLocalFindingId(request, structuredClone(binding), resumedDynamicRegistry))
  assert.deepEqual(resumedDynamicIds, dynamicIds)
})

test('AP-ROUTE-025 emits item verification before more work continues', async () => {
  const transitions = []
  await emitItemVerifiedTransition(async (...args) => transitions.push(args), {
    workItemId: 'work-1', resultHash: '1'.repeat(64), candidateHash: '2'.repeat(64),
    nextReadyWorkIds: ['work-2'],
  })
  assert.deepEqual(transitions.map(item => item.slice(0, 2)), [
    ['WORK_ITEM_VERIFIED', 'ITEM_VERIFIED'], ['MORE_WORK_READY', 'RUN_WORK'],
  ])
})

test('AP-ROUTE-028/DESIGN-042 stop resumably without finalizer terminalization', async () => {
  let released = 0
  let finalized = 0
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  Object.assign(runtime, {
    finished: false, scheduler: null, route: null, lease: {},
    processOwner: { cancelAll: async () => {}, assertDrained: async () => true },
    missionLock: { release: () => { released += 1 } },
    finalizer: { finalize: async () => { finalized += 1 } },
    budget: { snapshot: () => ({ generation: 1 }) },
  })
  assert.equal(runtime._budgetPauseFrontier(), null)
  const result = await runtime._suspendResumable('WAITING_USER', {
    terminalEnvelope: { status: 'WAITING_USER', route: null },
  })
  assert.equal(result.outcome, 'WAITING_USER')
  assert.equal(result.resumable, true)
  assert.equal(released, 1)
  assert.equal(finalized, 0)
})

test('AP-DESIGN-035 ROADMAP admission includes planning with p95 and hard bounds', () => {
  const within = new CentralScheduler({ route: 'ROADMAP', runIdentity: RUN })
  const atCeiling = within.recordAdmissionComponent('roadmapPlanning', 15 * 60 * 1000)
  assert.equal(atCeiling.withinCeiling, true)
  assert.equal(atCeiling.p95TargetMs, 18 * 60 * 1000)
  assert.equal(atCeiling.combinedHardMs, 22 * 60 * 1000)
  assert.equal(atCeiling.components.roadmapPlanning, 15 * 60 * 1000)

  const exceeded = new CentralScheduler({ route: 'ROADMAP', runIdentity: RUN })
    .recordAdmissionComponent('roadmapPlanning', (15 * 60 * 1000) + 1)
  assert.equal(exceeded.withinCeiling, false)
  assert.equal(exceeded.withinTarget, false)
  assert.equal(exceeded.convergenceRequired, true)
  assert.equal(exceeded.completionCanContinue, true)
  assert.deepEqual(exceeded.breaches, ['roadmapPlanning'])
  assert.equal(exceeded.convergencePolicy.kind, 'essential-sequential-collapse')
})

test('AP-DESIGN-045 L1 request pointer is hash-checked before reuse', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-request-pointer-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const absolute = path.join(directory, 'request.jsonl')
  const original = Buffer.from('{"request":"frozen"}\n')
  fs.writeFileSync(absolute, original)
  const pointer = {
    kind: 'request-envelope', path: absolute, bytes: original.length,
    hash: crypto.createHash('sha256').update(original).digest('hex'), encoding: 'utf8',
  }
  assert.equal(verifyRequestPointer(pointer), pointer)
  fs.writeFileSync(absolute, '{"request":"steered"}\n')
  assert.throws(() => verifyRequestPointer(pointer), error => error.code === 'REQUEST_POINTER_CHANGED')
})

test('AP-DESIGN-016/ROUTE-019 production calls freeze fallback and baseline before mutation', () => {
  const source = fs.readFileSync(path.join(workflow, 'phase-budget.js'), 'utf8')
  assert.match(source, /writeRouteAnalystFallbackState\(evaluated\.recommendation_state\)/)
  const baselineCall = source.indexOf('this.record.writePreMutationBaseline(baselineInput)')
  const mutationBegin = source.indexOf('this.options.mutationEnforcer.begin({', baselineCall)
  assert.ok(baselineCall > 0)
  assert.ok(mutationBegin > baselineCall)
  assert.match(source.slice(baselineCall, mutationBegin), /readPreMutationBaseline\(\)/)
})
