'use strict'

// Focused native startup regression for the zero-tool route analyst. This
// deliberately stops at the controlled authentication refusal: it grants no
// canary capability and exposes no synthetic model or tool result.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const native = require('../../scripts/harness-v2-native.cjs')
const { ROUTE_ADVISORY_WIRE_SCHEMA } = require('../../scripts/harness-v2-transport.cjs')
const { OwnedCodexProxyRunner } = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { authenticationEndpoint, REFUSAL } = require('../helpers/native-activation-endpoint.cjs')
const { privateDirectory, nativeProcessAdapter, requiredNativeCli, nativeEnvironment } = require('../helpers/native-platform.cjs')

const CLI = requiredNativeCli('claude')

function deepDirectory(root, label) {
  let directory = root
  for (let index = 0; index < 7; index += 1) {
    directory = path.join(directory, `${label}-${index}-${'d'.repeat(34)}`)
  }
  return privateDirectory(directory)
}

function boundedResult(result, error, requests, events) {
  const bounded = value => String(value || '').slice(-8192)
  return {
    error: error && { code: error.code, message: String(error.message || error).slice(0, 512) },
    result: result && { status: result.status, signal: result.signal, processOwned: result.processOwned,
      exactArgv: result.exactArgv, drained: result.drained, stdout: bounded(result.stdout), stderr: bounded(result.stderr) },
    requests: requests.slice(-16).map(item => ({ method: item.method, pathname: item.pathname, authenticated: item.authenticated })),
    events: events.slice(-16).map(event => ({ type: event?.type, subtype: event?.subtype,
      tools: Array.isArray(event?.tools) ? event.tools.slice(0, 16) : undefined })),
  }
}

test('actual Claude zero-tool route launch reaches controlled refusal from production-depth paths', {
  skip: !CLI,
  timeout: process.platform === 'win32' ? 175000 : 60000,
}, async t => {
  assert.ok(CLI, 'AUTOPROMPT_CLAUDE_TEST_CLI is required for the native deep-launch regression')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-deep-launch-native-')))
  privateDirectory(root)
  const home = deepDirectory(root, 'home')
  const sessionRoot = deepDirectory(root, 'session')
  const cwd = deepDirectory(root, 'cwd')
  const ownershipRoot = deepDirectory(root, 'ownership')
  const proxyRoot = deepDirectory(root, 'proxy')
  for (const [name, value] of Object.entries({ home, sessionRoot, cwd })) {
    assert.ok(value.length > 300, `${name} must retain the production-depth path`)
    assert.equal(fs.realpathSync.native(value), value, `${name} must be canonical`)
  }

  let endpoint, owner, completed = false, drained = false
  t.after(async () => {
    let failure
    try {
      if (owner) {
        await owner.cancelAll({ reason: 'deep Claude launch cleanup', graceMs: 0, killMs: 2000, waitForPending: true })
        assert.equal(owner.ownershipIdentities().length, 0)
      }
      drained = true
    } catch (error) { failure = error }
    try { if (endpoint) await endpoint.close() } catch (error) { failure ||= error }
    if (completed && drained && !failure) fs.rmSync(root, { recursive: true, force: true })
    else t.diagnostic(`Deep Claude launch fixture retained: ${root}`)
    if (failure) throw failure
  })

  const mission = `Deep native route launch ${crypto.randomUUID()}: classify this bounded request and return the required route advisory.`
  let missionRequests = 0
  const missionBodies = []
  const credential = `fixture-${crypto.randomBytes(16).toString('hex')}`
  endpoint = await authenticationEndpoint({ credential, onMission(_observation, body) {
    missionRequests += 1
    missionBodies.push(body)
  } })

  const environment = nativeEnvironment()
  const binding = native.probeExecutable({ provider: 'claude', executable: CLI, env: environment })
  const registryPath = path.join(ownershipRoot, 'processes.json')
  owner = new ProcessOwner({ adapter: nativeProcessAdapter(registryPath, root), registryPath, pollMs: 10 })
  const runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot,
    targetKey: 'claude-deep-route-launch', activationId: 'claude-deep-route-launch', generationId: 1, pollMs: 10 })
  const sessionId = crypto.randomUUID(), reservationId = crypto.randomUUID()
  const launch = native.createLaunch({
    provider: 'claude', executable: native.executableRuntimePath(binding), home, sessionRoot, cwd, targetPath: cwd,
    readOnly: true, toolFree: true,
    prompt: 'Return exactly one route advisory object matching the supplied JSON schema. This assignment permits no tools.',
    input: mission,
    connection: { model: 'claude-sonnet-4-6', environment: { ANTHROPIC_BASE_URL: endpoint.url } },
    credentials: { ANTHROPIC_API_KEY: credential }, environment,
    model: 'claude-sonnet-4-6', outputSchema: ROUTE_ADVISORY_WIRE_SCHEMA,
  })
  assert.equal(launch.argv[launch.argv.indexOf('--tools') + 1], '')
  assert.equal(launch.argv[launch.argv.indexOf('--allowedTools') + 1], '')
  assert.deepEqual(JSON.parse(launch.argv[launch.argv.indexOf('--json-schema') + 1]), ROUTE_ADVISORY_WIRE_SCHEMA)
  assert.ok(launch.env.HOME.length > 300)
  assert.ok(launch.env.CLAUDE_CONFIG_DIR.length > 300)
  // This regression measures startup and first provider admission. The real
  // CLI still receives and terminates on the controlled 401; retries add no
  // launch coverage and would turn this focused check into a multi-minute run.
  launch.env.CLAUDE_CODE_MAX_RETRIES = '0'

  launch.env = prepareProcessLaunchEnvironment(owner.adapter, reservationId, launch.env)
  const invocation = native.executableInvocation(binding, launch.argv)
  const events = []
  let result, launchError, lifecycleTimedOut = false
  const lifecycleLimitMs = process.platform === 'win32' ? 150000 : 30000
  const lifecycleTimer = setTimeout(() => {
    lifecycleTimedOut = true
    runner.stop({ sessionId, reason: 'deep Claude launch lifecycle bound', terminalStatus: 'FAILED' })
      .then(() => owner.cancelAll({ reason: 'deep Claude launch lifecycle bound', graceMs: 0, killMs: 2000, waitForPending: true }))
      .catch(() => owner.cancelAll({ reason: 'deep Claude launch lifecycle fallback', graceMs: 0, killMs: 2000, waitForPending: true }).catch(() => {}))
  }, lifecycleLimitMs)
  try {
    result = await runner.run({ ...launch, executable: invocation.executable, argv: invocation.argv,
      sessionId, reservationId, onStdoutLine(line) {
        try { events.push(JSON.parse(line)) } catch {}
        if (events.length > 64) events.shift()
      } })
  } catch (error) { launchError = error }
  finally { clearTimeout(lifecycleTimer) }
  if (lifecycleTimedOut && !launchError) {
    launchError = Object.assign(new Error(`Actual Claude deep launch exceeded its ${lifecycleLimitMs}-millisecond lifecycle bound`),
      { code: 'CHILD_TRANSPORT_TIMEOUT' })
  }
  t.diagnostic(`CLAUDE_DEEP_LAUNCH_DIAGNOSTIC:${JSON.stringify(boundedResult(result, launchError, endpoint.requests, events))}`)
  if (launchError) throw launchError

  const init = events.find(event => event?.type === 'system' && event.subtype === 'init')
  assert.ok(init, 'the actual Claude CLI must publish its initialization event')
  assert.ok((init.tools || []).every(name => name === 'StructuredOutput'),
    'the route analyst may expose only the schema response helper')
  assert.ok(missionRequests > 0, 'the exact route mission must reach the controlled model endpoint')
  assert.ok(missionBodies.some(body => JSON.stringify({ system: body.system, messages: body.messages }).includes(mission)))
  assert.equal(endpoint.errors.length, 0)
  assert.equal(result.status, 1, 'the controlled authentication refusal must be the terminal native result')
  assert.equal(result.signal, null)
  assert.equal(result.processOwned, true)
  assert.equal(result.exactArgv, true)
  assert.equal(result.drained, true)
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`401|${REFUSAL}`))
  assert.equal(owner.ownershipIdentities().length, 0, 'the actual Claude process group must drain')
  completed = true
})
