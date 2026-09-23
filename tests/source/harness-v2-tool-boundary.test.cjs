'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const cp = require('node:child_process')
const { PassThrough } = require('node:stream')
const test = require('node:test')
const tools = require('../../scripts/harness-v2-tool-boundary.cjs')
const serverFile = path.resolve(__dirname, '../../scripts/harness-v2-tool-server.cjs')
const toolServer = require('../../scripts/harness-v2-tool-server.cjs')

function fixture(t, readOnly = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-tools-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = { root }
  for (const name of ['target', 'scratch', 'controller', 'foreign']) {
    result[name] = path.join(root, name); fs.mkdirSync(result[name], { mode: 0o700 })
  }
  fs.writeFileSync(path.join(result.target, 'input.txt'), 'first\nsecond\nthird\n')
  fs.writeFileSync(path.join(result.foreign, 'credential.txt'), 'not-visible-to-tool-commands')
  result.policy = { provider: 'claude', readOnly, targetPath: result.target, scratchPath: result.scratch,
    readableRoots: [result.target, result.scratch], writableRoots: readOnly ? [result.scratch] : [result.target, result.scratch],
    nestedDispatch: false, commandBoundary: true, externalWrites: false }
  return result
}
async function requireSandbox(t) {
  const probe = await tools.probeCommandSandbox()
  if (probe.supported) return true
  if (process.env.AUTOPROMPT_REQUIRE_COMMAND_SANDBOX === '1') assert.fail(JSON.stringify(probe))
  t.skip(`Actual command sandbox unavailable: ${probe.reason || probe.code}`)
  return false
}
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'` }

function injectedServer(t, leaseFactory) {
  const f = fixture(t), bound = tools.prepareBoundary({ provider: 'reasonix', root: f.controller, policy: { ...f.policy, provider: 'reasonix' } })
  const input = new PassThrough(), output = new PassThrough(), messages = []
  let pending = '', notify
  output.on('data', bytes => {
    pending += bytes.toString()
    let index
    while ((index = pending.indexOf('\n')) !== -1) { messages.push(JSON.parse(pending.slice(0, index))); pending = pending.slice(index + 1); notify?.() }
  })
  const server = toolServer.start({ boundary: bound, input, output, platform: 'win32', windowsLeaseFactory: leaseFactory })
  const waitMessage = async () => {
    if (messages.length) return messages.shift()
    await new Promise(resolve => { notify = resolve })
    notify = null
    return messages.shift()
  }
  t.after(async () => { input.end(); await server.closed })
  return { f, input, server, waitMessage, messages }
}

test('Windows MCP initialization is prompt while capability requests await the exact lease', async t => {
  let factoryCalled = false, asserted = 0, released = 0
  const s = injectedServer(t, async () => { factoryCalled = true; await new Promise(resolve => setTimeout(resolve, 50)); return { assertHeld() { asserted++ }, async release() { released++ } } })
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`)
  const initialized = await s.waitMessage()
  assert.equal(initialized.result.protocolVersion, '2025-11-25')
  assert.equal(factoryCalled, false, 'initialization must not wait for Windows lease creation')
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  const listed = await s.waitMessage()
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['read', 'list', 'search', 'write', 'edit', 'bash'])
  assert.equal(factoryCalled, true); assert.equal(asserted, 1)
  s.input.end(); await s.server.closed
  assert.equal(released, 1)
})

test('Windows MCP lease rejection fails closed before tools are exposed', async t => {
  const s = injectedServer(t, () => { const error = new Error('lease unavailable'); error.code = 'TOOL_LEASE_UNAVAILABLE'; throw error })
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`)
  assert.equal((await s.waitMessage()).result.protocolVersion, '2025-11-25')
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  const failed = await s.waitMessage()
  assert.equal(failed.error.code, -32603)
  await s.server.closed
  assert.equal(s.messages.length, 0)
})

test('Windows MCP parent close during lease admission cancels queued tools and releases the late lease', async t => {
  let releaseLease, released = 0
  const pending = new Promise(resolve => { releaseLease = resolve })
  const s = injectedServer(t, () => pending)
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`)
  await s.waitMessage()
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  s.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  await new Promise(resolve => setImmediate(resolve))
  s.input.end()
  await new Promise(resolve => setImmediate(resolve))
  releaseLease({ assertHeld() {}, async release() { released++ } })
  await s.server.closed
  assert.equal(released, 1)
  assert.equal(s.messages.some(message => message.result?.tools), false)
  assert.equal(s.messages[0].error.code, -32800)
})

test('Windows MCP closes after lease failure even when no protocol request arrives', async t => {
  const s = injectedServer(t, async () => { throw new Error('lease startup failed') })
  await s.server.closed
  assert.equal(s.messages.length, 0)
})

test('physical tools read and search without allowing authority expansion or candidate writes', async t => {
  const f = fixture(t)
  assert.equal((await tools.executeTool(f.policy, 'read', { path: 'input.txt', startLine: 2, lineCount: 1 })).output, 'second')
  assert.deepEqual(JSON.parse((await tools.executeTool(f.policy, 'search', { path: f.target, text: 'second' })).output), [
    { path: path.join(f.target, 'input.txt'), line: 2, text: 'second' },
  ])
  await assert.rejects(tools.executeTool(f.policy, 'write', { path: 'input.txt', content: 'forbidden' }), { code: 'TOOL_PATH_DENIED' })
  await assert.rejects(tools.executeTool(f.policy, 'read', { path: path.join(f.foreign, 'credential.txt') }), { code: 'TOOL_PATH_DENIED' })
  await assert.rejects(tools.executeTool(f.policy, 'bash', { command: 'true', network: true }), { code: 'TOOL_ARGUMENTS_INVALID' })
  await assert.rejects(tools.executeTool(f.policy, 'task', {}), { code: 'TOOL_DENIED' })
  assert.throws(() => tools.validatePolicy({ ...f.policy, writableRoots: [f.target] }), { code: 'TOOL_POLICY_INVALID' })
  assert.throws(() => tools.validatePolicy({ ...f.policy, readableRoots: [f.foreign] }), { code: 'TOOL_POLICY_INVALID' })
  assert.throws(() => tools.validatePolicy({ ...f.policy, nestedDispatch: true }), { code: 'TOOL_POLICY_INVALID' })
  assert.throws(() => tools.prepareBoundary({ provider: 'claude', root: f.target, policy: f.policy }), { code: 'TOOL_POLICY_INVALID' })
})

test('links cannot escape tools, and legitimate scratch edits preserve exact bytes', async t => {
  const f = fixture(t)
  fs.symlinkSync(f.foreign, path.join(f.target, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  fs.linkSync(path.join(f.foreign, 'credential.txt'), path.join(f.target, 'linked'))
  for (const file of ['escape/credential.txt', 'linked']) {
    await assert.rejects(tools.executeTool(f.policy, 'read', { path: file }), { code: 'TOOL_PATH_DENIED' })
  }
  const output = path.join(f.scratch, 'result.txt')
  await tools.executeTool(f.policy, 'write', { path: output, content: 'same same' })
  await assert.rejects(tools.executeTool(f.policy, 'edit', { path: output, oldText: 'same', newText: 'new' }), { code: 'TOOL_EDIT_AMBIGUOUS' })
  await tools.executeTool(f.policy, 'edit', { path: output, oldText: 'same', newText: 'new', replaceAll: true })
  assert.equal(fs.readFileSync(output, 'utf8'), 'new new')
  assert.equal(fs.readFileSync(path.join(f.target, 'input.txt'), 'utf8'), 'first\nsecond\nthird\n')
  assert.deepEqual(fs.readdirSync(f.scratch), ['result.txt'])
})

test('actual sandbox reads the frozen source, writes scratch, and rejects candidate writes', async t => {
  if (!await requireSandbox(t)) return
  const f = fixture(t)
  const command = `cat ${quote(path.join(f.target, 'input.txt'))}; printf scratch-ok > ${quote(path.join(f.scratch, 'result'))}; printf stderr-evidence >&2`
  const result = await tools.executeTool(f.policy, 'bash', { command })
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'first\nsecond\nthird\n')
  assert.equal(result.stderr, 'stderr-evidence')
  assert.equal(tools.sha256(Buffer.from(result.outputBase64, 'base64')), result.outputSha256)
  assert.equal(result.command, command)
  assert.equal(fs.readFileSync(path.join(f.scratch, 'result'), 'utf8'), 'scratch-ok')
  const denied = await tools.executeTool(f.policy, 'bash', { command: `printf forbidden > ${quote(path.join(f.target, 'input.txt'))}` })
  assert.equal(denied.status, 'failed')
  assert.notEqual(denied.exitCode, 0)
  assert.equal(fs.readFileSync(path.join(f.target, 'input.txt'), 'utf8'), 'first\nsecond\nthird\n')
})

test('actual sandbox hides foreign credentials and cannot reach a listening host network socket', async t => {
  if (!await requireSandbox(t)) return
  const f = fixture(t)
  let contacted = false
  const server = net.createServer(socket => { contacted = true; socket.destroy() })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    const code = `const n=require('node:net');const s=n.connect(${server.address().port},'127.0.0.1');s.on('connect',()=>process.exit(19));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),1000)`
    const result = await tools.executeTool(f.policy, 'bash', { command: `${quote(process.execPath)} -e ${quote(code)}` })
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(contacted, false)
    const hidden = await tools.executeTool(f.policy, 'bash', { command: `cat ${quote(path.join(f.foreign, 'credential.txt'))}` })
    assert.equal(hidden.status, 'failed')
    assert.equal(hidden.output.includes('not-visible-to-tool-commands'), false)
    const environment = await tools.executeTool(f.policy, 'bash', { command: 'env' })
    assert.equal(environment.status, 'completed', environment.output)
    assert.equal(/API_KEY|AUTH_TOKEN|NODE_OPTIONS|LD_PRELOAD/.test(environment.output), false)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('actual command cancellation and output caps do not report successful completion', async t => {
  if (!await requireSandbox(t)) return
  const f = fixture(t), controller = new AbortController()
  const execution = tools.executeTool(f.policy, 'bash', { command: 'sleep 30', timeoutMs: 10000 }, { signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 100)
  const cancelled = await execution; clearTimeout(timer)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.status, 'failed')
  const overflow = await tools.executeTool(f.policy, 'bash', { command: 'yes bounded-output', timeoutMs: 5000 })
  assert.equal(overflow.truncated, true)
  assert.equal(overflow.status, 'failed')
  assert.ok(Buffer.byteLength(overflow.output) <= tools.OUTPUT_LIMIT)
  const timedOut = await tools.executeTool(f.policy, 'bash', { command: 'sleep 30', timeoutMs: 50 })
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.status, 'failed')
})

test('private policy and receipt hashes reject changes rather than trusting tool prose', async t => {
  const f = fixture(t)
  const bound = tools.prepareBoundary({ provider: 'claude', root: f.controller, policy: f.policy })
  const args = { path: 'input.txt' }, result = await tools.executeTool(f.policy, 'read', args)
  tools.appendReceipt(bound, 'read', args, result, new Date().toISOString())
  const receipts = tools.readReceipts(bound)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].argsSha256, tools.sha256(tools.canonicalJson(args)))
  assert.equal(receipts[0].resultSha256, tools.sha256(tools.canonicalJson(result)))
  fs.appendFileSync(bound.receiptPath, '{"partial":true}')
  assert.throws(() => tools.readReceipts(bound), { code: 'TOOL_RECEIPT_INVALID' })
  fs.writeFileSync(bound.policyPath, '{}')
  assert.throws(() => tools.loadBoundary(bound.policyPath, bound.policySha256), { code: 'TOOL_POLICY_INVALID' })
})

for (const toolFree of [false, true]) test(`actual MCP subprocess binds tool availability and execution (toolFree=${toolFree})`, { timeout: 20000 }, async t => {
  const f = fixture(t), bound = tools.prepareBoundary({ provider: 'claude', root: f.controller, policy: { ...f.policy, toolFree } })
  const child = cp.spawn(process.execPath, [serverFile, '--policy', bound.policyPath, '--sha256', bound.policySha256], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false })
  let output = '', stderr = '', next = 1
  const pending = new Map()
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    output += chunk
    let index
    while ((index = output.indexOf('\n')) !== -1) {
      const message = JSON.parse(output.slice(0, index)); output = output.slice(index + 1)
      const promise = pending.get(message.id); if (promise) { pending.delete(message.id); promise.resolve(message) }
    }
  })
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = next++, timer = setTimeout(() => reject(new Error(`MCP response timeout: ${method}; ${stderr}`)), 10000)
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result) } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
  })
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'actual-subprocess-test', version: '1' } })
    assert.equal(initialized.result.protocolVersion, '2025-11-25')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const listed = await rpc('tools/list')
    assert.deepEqual(listed.result.tools.map(tool => tool.name), toolFree ? [] : ['read', 'list', 'search', 'write', 'edit', 'bash'])
    const read = await rpc('tools/call', { name: 'read', arguments: { path: 'input.txt' } })
    assert.equal(read.result.isError, toolFree)
    if (toolFree) assert.equal(read.result.structuredContent.code, 'TOOL_DENIED')
    else assert.equal(read.result.structuredContent.output, 'first\nsecond\nthird\n')
    const denied = await rpc('tools/call', { name: 'write', arguments: { path: 'input.txt', content: 'forbidden' } })
    assert.equal(denied.result.isError, true)
    assert.equal(denied.result.structuredContent.code, toolFree ? 'TOOL_DENIED' : 'TOOL_PATH_DENIED')
    assert.deepEqual(tools.readReceipts(bound).map(item => item.status), toolFree ? ['failed', 'failed'] : ['completed', 'failed'])
    const unknown = await rpc('tools/execute-any-command', {})
    assert.equal(unknown.error.code, -32601)
  } finally { child.stdin.end(); const terminal = await completion; assert.equal(terminal.code, 0, stderr) }
  assert.equal(fs.existsSync(path.join(bound.root, 'server.lock')), false)
})


test('zero-tool controller authority denies reads, writes and commands before effects', async t => {
  const f = fixture(t)
  const policy = { ...f.policy, toolFree: true }
  const destination = path.join(f.scratch, 'forbidden.txt')
  for (const [tool, args] of [
    ['read', { path: path.join(f.target, 'input.txt') }],
    ['write', { path: destination, content: 'forbidden' }],
    ['bash', { command: `printf forbidden > ${quote(destination)}` }],
  ]) await assert.rejects(tools.executeTool(policy, tool, args), { code: 'TOOL_DENIED' })
  assert.equal(fs.existsSync(destination), false)
  assert.throws(() => tools.validatePolicy({ ...f.policy, toolFree: 'true' }), { code: 'TOOL_POLICY_INVALID' })
  const controlRoot = path.join(f.root, 'zero-tool-control')
  fs.mkdirSync(controlRoot, { mode: 0o700 })
  const persisted = tools.prepareBoundary({ provider: f.policy.provider, root: controlRoot, policy })
  const reopened = tools.loadBoundary(persisted.policyPath, persisted.policySha256)
  assert.equal(reopened.policy.toolFree, true)
  await assert.rejects(tools.executeTool(reopened.policy, 'read', { path: 'input.txt' }), { code: 'TOOL_DENIED' })
})
