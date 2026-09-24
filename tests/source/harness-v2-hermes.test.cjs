'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const hermes = require('../../scripts/harness-v2-hermes.cjs')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')

test('Hermes retains bounded controller startup diagnostics and closes failed initialization', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-startup-failure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const server = path.join(root, 'server.cjs')
  fs.writeFileSync(server, `process.stdin.once('data', () => {
    process.stderr.write('EXACT_CONTROLLER_STARTUP_DIAGNOSTIC\\n');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32603,data:{code:'TOOL_LEASE_UNAVAILABLE'}}})+'\\n');
    setInterval(() => {},1000);
  });`)
  const program = ['import runpy,sys', 'plugin=runpy.run_path(sys.argv[1])',
    'try: plugin["Controller"]()', 'except RuntimeError as error: print(str(error))',
    'else: raise AssertionError("initialization unexpectedly succeeded")'].join('\n')
  const result = cp.spawnSync(process.env.AUTOPROMPT_TEST_PYTHON || 'python3', ['-I', '-B', '-c', program,
    path.resolve(__dirname, '../../scripts/harness-v2-bridge/hermes/plugin.py')], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, AUTOPROMPT_NODE: process.execPath,
      AUTOPROMPT_TOOL_SERVER: server, AUTOPROMPT_TOOL_POLICY: 'unused', AUTOPROMPT_TOOL_POLICY_SHA256: 'unused' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /EXACT_CONTROLLER_STARTUP_DIAGNOSTIC/)
  assert.match(result.stderr, /AUTOPROMPT_HERMES_CONTROLLER_FAILURE:TOOL_LEASE_UNAVAILABLE/)
  assert.match(result.stdout, /Controller tool request failed: TOOL_LEASE_UNAVAILABLE/)
})

for (const toolFree of [false, true]) {
  test(`Hermes Python plugin registers the actual controller inventory (toolFree=${toolFree})`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-inventory-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), control = path.join(root, 'control')
    for (const directory of [target, scratch, control]) fs.mkdirSync(directory, { mode: 0o700 })
    const prepared = boundary.prepareBoundary({ provider: 'hermes', root: control, policy: {
      readOnly: true, toolFree, targetPath: target, scratchPath: scratch,
      readableRoots: [target, scratch], writableRoots: [scratch],
      nestedDispatch: false, commandBoundary: true, externalWrites: false,
    } })
    const program = [
      'import runpy,sys,json',
      'plugin=runpy.run_path(sys.argv[1])',
      'class Context:',
      ' def __init__(self): self.names=[]',
      ' def register_tool(self, **kwargs): self.names.append(kwargs["name"])',
      'ctx=Context()',
      'plugin["register"](ctx)',
      'print(json.dumps(ctx.names))',
    ].join('\n')
    const result = cp.spawnSync(process.env.AUTOPROMPT_TEST_PYTHON || 'python3', ['-I', '-B', '-c', program,
      path.resolve(__dirname, '../../scripts/harness-v2-bridge/hermes/plugin.py')], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env,
        AUTOPROMPT_NODE: process.execPath,
        AUTOPROMPT_TOOL_SERVER: path.resolve(__dirname, '../../scripts/harness-v2-tool-server.cjs'),
        AUTOPROMPT_TOOL_POLICY: prepared.policyPath, AUTOPROMPT_TOOL_POLICY_SHA256: prepared.policySha256,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), toolFree ? [] : boundary.TOOLS.map(tool => `autoprompt_owned_${tool.name}`))
    assert.equal(fs.existsSync(path.join(control, 'server.lock')), false)
  })
}

test('Hermes accepts only its verified native reasoning levels and direct custom endpoint', () => {
  assert.deepEqual(hermes.EFFORTS, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.deepEqual(hermes.sanitizeConnection({ model: 'openrouter/nous/hermes-3', modelProvider: 'custom', maxTokens: 731, environment: { HERMES_BASE_URL: 'https://openrouter.ai/api/v1' } }),
    { model: 'openrouter/nous/hermes-3', modelProvider: 'custom', maxTokens: 731, environment: { HERMES_BASE_URL: 'https://openrouter.ai/api/v1' } })
  assert.throws(() => hermes.sanitizeConnection({ environment: { HERMES_BASE_URL: 'file:///tmp/model' } }))
  assert.throws(() => hermes.sanitizeConnection({ maxTokens: 0 }))
  assert.throws(() => hermes.sanitizeConnection({ hooks: ['foreign'] }))
  assert.equal(hermes.selectApiKey('https://openrouter.ai/api/v1', { HERMES_API_KEY: 'hermes', OPENROUTER_API_KEY: 'router', OPENAI_API_KEY: 'openai' }), 'router')
  assert.equal(hermes.selectApiKey('https://api.openai.com/v1', { HERMES_API_KEY: 'hermes', OPENROUTER_API_KEY: 'router', OPENAI_API_KEY: 'openai' }), 'openai')
  assert.equal(hermes.selectApiKey('https://localhost:9000/v1', { HERMES_API_KEY: 'hermes', OPENROUTER_API_KEY: 'router' }), 'hermes')
})

test('Hermes binds relay reasoning only for the verified OpenRouter upstream', () => {
  assert.deepEqual(hermes.requiredReasoning('https://openrouter.ai/api/v1', 'low'), { enabled: true, effort: 'low' })
  assert.deepEqual(hermes.requiredReasoning('https://api.openrouter.ai/api/v1', 'none'), { enabled: false, effort: 'none' })
  assert.deepEqual(hermes.requiredReasoning('https://api.openrouter.ai/api/v1', 'ultra'), { enabled: true, effort: 'max' })
  assert.equal(hermes.requiredReasoning('https://openrouter.ai/api/v1', undefined), undefined)
  assert.equal(hermes.requiredReasoning('http://127.0.0.1:1/v1', 'low'), undefined)
  assert.throws(() => hermes.requiredReasoning('https://openrouter.ai/api/v1', 'wrong'), { code: 'PROFILE_INVALID' })
})

test('Hermes bridge contains a direct fixed-tool plugin and an owned SQLite wrapper', () => {
  const root = path.join(__dirname, '../../scripts/harness-v2-bridge/hermes')
  const plugin = fs.readFileSync(path.join(root, 'plugin.py'), 'utf8')
  const wrapper = fs.readFileSync(path.join(root, 'owned-wrapper.cjs'), 'utf8')
  assert.match(plugin, /ctx\.register_tool/)
  assert.match(plugin, /tools\/call/)
  assert.doesNotMatch(plugin, /ctx\.register_hook|ctx\.register_skill|_subagent/i)
  assert.match(wrapper, /mode=ro/)
  assert.match(wrapper, /messages where session_id/)
  assert.match(wrapper, /JSON\.stringify\(\{ type: 'hermes', event: 'intermediate'/)
  assert.match(wrapper, /JSON\.stringify\(\{ type: 'hermes', event: 'usage'/)
  assert.match(wrapper, /messages where session_id=.*role in/)
  assert.match(wrapper, /setInterval\(poll, 300\)/)
  assert.match(wrapper, /JSON\.stringify\(\{ type: 'hermes', event: 'final'/)
  assert.match(wrapper, /detached: false/)
  assert.match(wrapper, /usage\.length !== 11/)
  assert.match(wrapper, /Number\.isSafeInteger/)
  assert.match(wrapper, /child\.on\('error'/)
  assert.match(wrapper, /before\.sessionIds\.includes/)
})

test('Hermes wrapper preserves structural SQLite subprocess diagnostics', { skip: !process.env.AUTOPROMPT_TEST_PYTHON && process.platform === 'win32' || !process.env.AUTOPROMPT_TEST_PYTHON && !fs.existsSync('/usr/bin/python3') }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-snapshot-diagnostic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 })
  fs.writeFileSync(path.join(home, 'state.db'), 'fixture', { mode: 0o600 })
  const projection = path.join(root, 'projection.jsonl'); fs.writeFileSync(projection, '', { mode: 0o600 })
  const python = process.env.AUTOPROMPT_TEST_PYTHON || '/usr/bin/python3'
  const spec = path.join(root, 'spec.json')
  fs.writeFileSync(spec, JSON.stringify({
    hermesExecutable: python, pythonExecutable: python, home, sessionRoot: root,
    toolProjectionPath: projection, receiptPath: path.join(root, 'receipts.jsonl'), argv: [], continuationId: null,
  }), { mode: 0o600 })
  const wrapper = path.resolve(__dirname, '../../scripts/harness-v2-bridge/hermes/owned-wrapper.cjs')
  const result = cp.spawnSync(process.execPath, [wrapper, '--spec', spec], { encoding: 'utf8', timeout: 10000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Hermes SQLite journal snapshot failed/)
  assert.match(result.stderr, /"status":17/)
  assert.match(result.stderr, /"sqlite":\{"class":"DatabaseError","code":26\}/)
  assert.doesNotMatch(result.stderr, /fixture/)
})

test('Hermes journals known live usage through a held terminal and only observes terminal receipts once', () => {
  const usage = { input: 13, cachedInput: 2, cachedWrite: 0, output: 5, reasoning: 1, apiCalls: 1, toolCalls: 1 }
  const debits = [], observedTools = []
  const held = new HarnessEventStream('hermes', {
    priorToolCallCount: 7,
    onUsageDelta: (delta, total) => { debits.push({ delta, total }); return { continue: true } },
    onToolCallObserved: event => observedTools.push(event),
  })
  held.push(JSON.stringify({ type: 'hermes', event: 'usage', sessionId: 'hermes-held-session', usage }))
  assert.deepEqual(debits, [{ delta: { noncachedInput: 13, cachedInput: 2, output: 5, reasoning: 1 }, total: { noncachedInput: 13, cachedInput: 2, output: 5, reasoning: 1 } }])
  assert.equal(observedTools.length, 0, 'a held terminal has no verified receipt observation')
  assert.throws(() => held.finish(), { code: 'CHILD_RESULT_MISSING' })

  const completeDebits = [], completeTools = []
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-live-receipt-'))
  const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), controller = path.join(root, 'controller')
  for (const directory of [target, scratch, controller]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const toolBoundary = boundary.prepareBoundary({ provider: 'hermes', root: controller, policy: {
    sessionId: 'hermes-paid-session', reservationId: 'hermes-paid-reservation', readOnly: true,
    targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
  const executions = ['one', 'two', 'three'].map(value => {
    const args = { path: `/fixture-${value}` }
    const result = { tool: 'read', status: 'completed', exitCode: 0, output: value, outputSha256: native.sha256(value) }
    return { args, result, receipt: boundary.appendReceipt(toolBoundary, 'read', args, result, new Date().toISOString()) }
  })
  const receipts = executions.map(entry => entry.receipt)
  const projections = []
  for (const [index, entry] of executions.entries()) {
    const body = { sequence: index + 1, previous: projections.at(-1)?.hash || null, receiptHash: entry.receipt.hash,
      name: 'read', args: entry.args, output: JSON.stringify(entry.result) }
    projections.push({ ...body, hash: native.sha256(boundary.canonicalJson(body)) })
  }
  const complete = new HarnessEventStream('hermes', {
    priorToolCallCount: 7,
    toolBoundary,
    onUsageDelta: delta => { completeDebits.push(delta); return { continue: true } },
    onToolCallObserved: event => completeTools.push(event),
  })
  try {
    const completeUsage = { ...usage, toolCalls: receipts.length }
    complete.push(JSON.stringify({ type: 'hermes', event: 'usage', sessionId: 'hermes-paid-session', usage: completeUsage }))
    for (const [index, receipt] of receipts.entries()) {
      complete.push(JSON.stringify({ type: 'hermes', event: 'tool_projection', sessionId: 'hermes-paid-session', projection: projections[index] }))
      complete.push(JSON.stringify({ type: 'hermes', event: 'tool_receipts', sessionId: 'hermes-paid-session', receiptStart: index, toolReceiptHashes: [receipt.hash] }))
    }
    complete.push(JSON.stringify({ type: 'hermes', event: 'final', status: 0, signal: null, sessionId: 'hermes-paid-session', answer: JSON.stringify({ ok: true }), receiptStart: 0, toolReceiptHashes: receipts.map(receipt => receipt.hash), usage: completeUsage }))
    assert.equal(completeDebits.length, 1, 'the terminal snapshot must not double-charge live usage')
    assert.deepEqual(completeTools, receipts.map((receipt, index) => ({ attemptedCount: 8 + index, continuationId: 'hermes-paid-session', itemIdHash: native.sha256(`hermes-projection-${projections[index].hash}`), itemType: 'autoprompt_owned_read', observedPhase: 'completed' })))
    assert.deepEqual(complete.finish().output, { ok: true })
    const replay = new HarnessEventStream('hermes', { toolBoundary, onUsageDelta: () => ({ continue: true }) })
    replay.push(JSON.stringify({ type: 'hermes', event: 'usage', sessionId: 'hermes-paid-session', usage: completeUsage }))
    replay.push(JSON.stringify({ type: 'hermes', event: 'tool_projection', sessionId: 'hermes-paid-session', projection: projections[0] }))
    assert.throws(() => replay.push(JSON.stringify({ type: 'hermes', event: 'tool_projection', sessionId: 'hermes-paid-session', projection: projections[0] })), { code: 'TOOL_RECEIPT_INVALID' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Hermes wrapper reads special SQLite paths while waiting for a receipt/projection common prefix', { skip: !process.env.AUTOPROMPT_TEST_PYTHON && process.platform === 'win32' || !process.env.AUTOPROMPT_TEST_PYTHON && !fs.existsSync('/usr/bin/python3'), timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-hermes projection # %${process.platform === 'win32' ? '' : ' ?'}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), controller = path.join(root, 'controller'), home = path.join(root, 'home')
  for (const directory of [target, scratch, controller, home]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const toolBoundary = boundary.prepareBoundary({ provider: 'hermes', root: controller, policy: {
    sessionId: 'hermes-race-session', reservationId: 'hermes-race-reservation', readOnly: true,
    targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
  const projectionPath = path.join(toolBoundary.root, 'hermes-projections.jsonl')
  fs.writeFileSync(projectionPath, '', { mode: 0o600 })
  const childScript = path.join(root, 'fake-hermes.py')
  fs.writeFileSync(childScript, `import sqlite3,sys,time\ndb=sys.argv[1]\nc=sqlite3.connect(db)\nc.execute('create table sessions (id text, started_at integer, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer, api_call_count integer, tool_call_count integer, estimated_cost_usd real, actual_cost_usd real, cost_status text, cost_source text)')\nc.execute('create table messages (id integer, session_id text, role text, active integer, content text)')\nc.execute(\"insert into sessions values ('hermes-race-session',1,3,2,0,0,0,1,1,null,null,null,null)\")\nc.execute(\"insert into messages values (1,'hermes-race-session','assistant',1,'{\\\"ok\\\":true}')\")\nc.commit()\ntime.sleep(2)\n`, { mode: 0o700 })
  const specPath = path.join(root, 'spec.json')
  const python = process.env.AUTOPROMPT_TEST_PYTHON || '/usr/bin/python3'
  fs.writeFileSync(specPath, JSON.stringify({ hermesExecutable: python, pythonExecutable: python, home, sessionRoot: root,
    receiptPath: toolBoundary.receiptPath, toolProjectionPath: projectionPath, continuationId: null, argv: [childScript, path.join(home, 'state.db')] }), { mode: 0o600 })
  const wrapper = path.join(__dirname, '../../scripts/harness-v2-bridge/hermes/owned-wrapper.cjs')
  const child = cp.spawn(process.execPath, [wrapper, '--spec', specPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  await new Promise(resolve => setTimeout(resolve, 450))
  const args = { path: path.join(target, 'fixture') }, result = { tool: 'read', status: 'completed', exitCode: 0, output: 'value', outputSha256: native.sha256('value') }
  const receipt = boundary.appendReceipt(toolBoundary, 'read', args, result, new Date().toISOString())
  await new Promise(resolve => setTimeout(resolve, 450))
  const body = { sequence: 1, previous: null, receiptHash: receipt.hash, name: 'read', args, output: JSON.stringify(result) }
  const projection = { ...body, hash: native.sha256(boundary.canonicalJson(body)) }
  const encoded = `${JSON.stringify(projection)}\n`
  fs.appendFileSync(projectionPath, encoded.slice(0, Math.floor(encoded.length / 2)))
  await new Promise(resolve => setTimeout(resolve, 450))
  fs.appendFileSync(projectionPath, encoded.slice(Math.floor(encoded.length / 2)))
  const ended = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  assert.deepEqual(ended, { code: 0, signal: null }, stderr)
  const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const projectionIndex = events.findIndex(event => event.event === 'tool_projection')
  const receiptIndex = events.findIndex(event => event.event === 'tool_receipts')
  assert.ok(projectionIndex >= 0 && receiptIndex > projectionIndex, 'only the fully published matching projection may precede its receipt event')
  assert.equal(events.filter(event => event.event === 'tool_projection').length, 1)
  assert.equal(events.filter(event => event.event === 'tool_receipts').length, 1)
})

test('Hermes keeps its persistent state bound to the context across fresh reservations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-state-'))
  const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), controller = path.join(root, 'controller')
  const stateHome = path.join(root, 'state'), sessionRoot = path.join(root, 'session')
  for (const directory of [target, scratch, controller, stateHome, sessionRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const toolBoundary = boundary.prepareBoundary({ provider: 'hermes', root: controller, policy: {
    sessionId: 'hermes-state', reservationId: 'hermes-reservation-1', readOnly: true,
    targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
  const make = (reservation, continuationId) => {
    const home = path.join(root, reservation)
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const promptFile = path.join(home, 'prompt.json')
    fs.writeFileSync(promptFile, '{}', { mode: 0o600 })
    return hermes.prepare({ home, stateHome, sessionRoot, toolBoundary, model: 'fixture/model', maxTokens: 317,
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'local-test-key', promptFile,
      hermesExecutable: '/tmp/hermes', pythonExecutable: '/usr/bin/python3', continuationId })
  }
  try {
    const first = make('reservation-1', undefined)
    const second = make('reservation-2', 'session_1')
    assert.equal(first.env.HERMES_HOME, stateHome)
    assert.equal(second.env.HERMES_HOME, stateHome)
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateHome, 'config.yaml'), 'utf8')).model.default, 'fixture/model')
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateHome, 'config.yaml'), 'utf8')).providers['autoprompt-owned'].extra_body.max_tokens, 317)
    assert.equal(JSON.parse(fs.readFileSync(first.specFile, 'utf8')).home, stateHome)
    assert.equal(JSON.parse(fs.readFileSync(second.specFile, 'utf8')).home, stateHome)
    assert.notEqual(first.specFile, second.specFile)
    fs.linkSync(path.join(stateHome, 'config.yaml'), path.join(stateHome, 'config-hardlink'))
    assert.throws(() => make('reservation-3', 'session_1'), /persistent file changed/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Hermes query projection retains role instructions, result schema, and mission input', { skip: !fs.existsSync('/tmp/autoprompt-hermes-v2-venv/bin/hermes') }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-query-'))
  const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), controller = path.join(root, 'controller')
  for (const directory of [target, scratch, controller]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const toolBoundary = boundary.prepareBoundary({ provider: 'hermes', root: controller, policy: {
    sessionId: 'hermes-query', reservationId: 'hermes-query-reservation', readOnly: true,
    targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
  const home = path.join(root, 'home'), sessionRoot = path.join(root, 'session')
  const launch = native.createLaunch({ provider: 'hermes', executable: '/tmp/autoprompt-hermes-v2-venv/bin/hermes',
    home, sessionRoot, cwd: target, targetPath: target, readOnly: true, commandBoundary: true, toolBoundary,
    prompt: 'ROLE_INSTRUCTION_SENTINEL\nRESULT_SCHEMA_SENTINEL', input: 'BOUND_MISSION_INPUT_SENTINEL', model: 'fixture/model', effort: 'low',
    connection: { modelProvider: 'custom', model: 'fixture/model', environment: { HERMES_BASE_URL: 'http://127.0.0.1:1/v1' } },
    credentials: { OPENROUTER_API_KEY: 'local-test-only' }, environment: { PATH: '/usr/bin:/bin' } })
  try {
    const query = fs.readFileSync(path.join(home, 'prompt.json'), 'utf8')
    assert.match(query, /ROLE_INSTRUCTION_SENTINEL/)
    assert.match(query, /RESULT_SCHEMA_SENTINEL/)
    assert.match(query, /BOUND_MISSION_INPUT_SENTINEL/)
    assert.equal(launch.env.PYTHONPYCACHEPREFIX, path.join(home, 'python-cache'))
    assert.ok(launch.argv.includes('--spec'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
