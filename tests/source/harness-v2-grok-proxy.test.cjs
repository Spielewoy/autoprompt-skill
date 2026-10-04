'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const test = require('node:test')
const { createModelProxy } = require('../../scripts/harness-v2-bridge/grok/model-proxy.cjs')

function toolSse(name, args, id = 'call-1') {
  const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }
  const done = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`
}
async function start(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }
}
async function close(server) { await new Promise(resolve => server.close(resolve)) }
function grokTools() { return ['run_terminal_command', 'read_file', 'search_tool', 'use_tool'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })) }
async function post(url, token, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.text() }
}

test('Grok proxy hides native schemas and rejects a native model tool call before forwarding it to Grok', async () => {
  let forwarded
  const upstream = await start(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; forwarded = JSON.parse(raw); res.writeHead(200, { 'content-type': 'text/event-stream' }).end(toolSse('run_terminal_command', { command: 'touch forbidden', description: 'forbidden' })) })
  const proxy = createModelProxy({ upstreamUrl: upstream.url, childToken: 'child', upstreamAuthorization: 'Bearer controller-only', model: 'local', allowedMcpTools: { autoprompt_owned__bash: input => assert.equal(typeof input.command, 'string') } })
  const address = await proxy.listen(); const reply = await post(`http://127.0.0.1:${address.port}/v1/chat/completions`, 'child', { model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: grokTools() })
  assert.equal(reply.status, 403); assert.match(reply.body, /GROK_PROXY_TOOL_DENIED/)
  assert.deepEqual(forwarded.tools.map(item => item.function.name), ['search_tool', 'use_tool'])
  assert.deepEqual(proxy.audit.at(-1), { type: 'blocked', code: 'GROK_PROXY_TOOL_DENIED', message: 'Native tool run_terminal_command is forbidden' })
  await proxy.close(); await close(upstream.server)
})

test('Grok proxy permits only an exact owned MCP target and validates its input', async () => {
  const upstream = await start((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(toolSse('use_tool', { tool_name: 'autoprompt_owned__bash', tool_input: { command: 'pwd' } })))
  const proxy = createModelProxy({ upstreamUrl: upstream.url, childToken: 'child', upstreamAuthorization: 'Bearer controller-only', allowedMcpTools: { autoprompt_owned__bash: input => { if (Object.keys(input).length !== 1 || typeof input.command !== 'string') throw new Error('bad fixed schema') } } })
  const address = await proxy.listen(); const reply = await post(`http://127.0.0.1:${address.port}/v1/chat/completions`, 'child', { model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: grokTools() })
  assert.equal(reply.status, 200); assert.match(reply.body, /autoprompt_owned__bash/)
  assert.equal(proxy.audit.at(-1).calls[0].target, 'autoprompt_owned__bash')
  await proxy.close(); await close(upstream.server)
})

test('Grok proxy rejects a foreign owned-MCP target and wrong child credentials', async () => {
  const upstream = await start((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(toolSse('use_tool', { tool_name: 'foreign__bash', tool_input: { command: 'pwd' } })))
  const proxy = createModelProxy({ upstreamUrl: upstream.url, childToken: 'child', upstreamAuthorization: 'Bearer controller-only', allowedMcpTools: { autoprompt_owned__bash: () => {} } })
  const address = await proxy.listen(), url = `http://127.0.0.1:${address.port}/v1/chat/completions`
  const foreign = await post(url, 'child', { model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: grokTools() })
  const unauthenticated = await post(url, 'wrong', { model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: grokTools() })
  assert.equal(foreign.status, 403); assert.match(foreign.body, /foreign__bash/)
  assert.equal(unauthenticated.status, 401)
  await proxy.close(); await close(upstream.server)
})

test('Grok proxy rejects native calls encoded with optional SSE spacing, multiline data, or non-data fields', async () => {
  const native = toolSse('run_terminal_command', { command: 'touch forbidden', description: 'forbidden' })
  const compact = native.replace('data: {', 'data:{')
  const source = native.match(/^data: (.*)\n\ndata: /m)[1], cut = source.indexOf(',"choices"')
  const multiline = `data: ${source.slice(0, cut)}\r\ndata:${source.slice(cut)}\r\n\r\ndata: [DONE]\r\n\r\n`
  const bodies = [compact, multiline, `event: ignored\n${native}`]
  for (const body of bodies) {
    const upstream = await start((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(body))
    const proxy = createModelProxy({ upstreamUrl: upstream.url, childToken: 'child', upstreamAuthorization: 'Bearer controller-only', allowedMcpTools: { autoprompt_owned__bash: () => {} } })
    const address = await proxy.listen(), reply = await post(`http://127.0.0.1:${address.port}/v1/chat/completions`, 'child', { model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: grokTools() })
    assert.equal(reply.status, 403)
    await proxy.close(); await close(upstream.server)
  }
})

test('Grok proxy accepts comment-only OpenRouter SSE frames without relaxing event parsing', async () => {
  const upstream = await start((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`: OPENROUTER PROCESSING\n\n${toolSse('use_tool', { tool_name: 'autoprompt_owned__bash', tool_input: { command: 'pwd' } })}`))
  const proxy = createModelProxy({ upstreamUrl: upstream.url, childToken: 'child', upstreamAuthorization: 'Bearer controller-only', allowedMcpTools: { autoprompt_owned__bash: () => {} } })
  const address = await proxy.listen(), reply = await post(`http://127.0.0.1:${address.port}/v1/chat/completions`, 'child', { model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: grokTools() })
  assert.equal(reply.status, 200); assert.match(reply.body, /autoprompt_owned__bash/)
  await proxy.close(); await close(upstream.server)
})

test('Grok proxy binds historical tool calls to the exact issued name and arguments', async () => {
  const upstream = await start((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(toolSse('use_tool', { tool_name: 'autoprompt_owned__bash', tool_input: { command: 'pwd' } }, 'issued-call')))
  const proxy = createModelProxy({ upstreamUrl: upstream.url, childToken: 'child', upstreamAuthorization: 'Bearer controller-only', allowedMcpTools: { autoprompt_owned__bash: () => {} } })
  const address = await proxy.listen(), url = `http://127.0.0.1:${address.port}/v1/chat/completions`
  const initial = { model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: grokTools() }
  assert.equal((await post(url, 'child', initial)).status, 200)
  const altered = { ...initial, messages: [...initial.messages, { role: 'assistant', tool_calls: [{ id: 'issued-call', type: 'function', function: { name: 'use_tool', arguments: JSON.stringify({ tool_name: 'foreign__bash', tool_input: { command: 'pwd' } }) } }] }] }
  const reply = await post(url, 'child', altered)
  assert.equal(reply.status, 403); assert.match(reply.body, /altered/)
  await proxy.close(); await close(upstream.server)
})

test('Grok proxy restores only controller-captured issued calls for a resumed process', async () => {
  const upstream = await start((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(toolSse('use_tool', { tool_name: 'autoprompt_owned__bash', tool_input: { command: 'pwd' } }, 'resume-call')))
  const options = { upstreamUrl: upstream.url, childToken: 'child', upstreamAuthorization: 'Bearer controller-only', allowedMcpTools: { autoprompt_owned__bash: () => {} } }
  const first = createModelProxy(options), a1 = await first.listen(), url1 = `http://127.0.0.1:${a1.port}/v1/chat/completions`
  const initial = { model: 'local', stream: true, messages: [{ role: 'user', content: 'x' }], tools: grokTools() }
  assert.equal((await post(url1, 'child', initial)).status, 200)
  const snapshot = first.issuedCalls(); await first.close()
  const resumed = createModelProxy({ ...options, issuedCalls: snapshot }), a2 = await resumed.listen(), url2 = `http://127.0.0.1:${a2.port}/v1/chat/completions`
  const history = { ...initial, messages: [...initial.messages, { role: 'assistant', tool_calls: [{ id: 'resume-call', type: 'function', function: { name: 'use_tool', arguments: snapshot[0].arguments } }] }, { role: 'tool', tool_call_id: 'resume-call', content: 'owned result' }] }
  assert.equal((await post(url2, 'child', history)).status, 200)
  await resumed.close(); await close(upstream.server)
})

test('Grok proxy refuses inherited listeners outside the authenticated IPv6 binding', async () => {
  const upstream = await start(() => {})
  const base = { upstreamUrl: upstream.url, childToken: 'child', upstreamAuthorization: 'Bearer controller-only', model: 'local', allowedMcpTools: { autoprompt_owned__bash: () => {} } }
  assert.throws(() => createModelProxy({ ...base, inheritedListener: { fd: 3, host: '127.0.0.1', port: 19777 } }), { code: 'GROK_PROXY_CONFIG_INVALID' })
  assert.throws(() => createModelProxy({ ...base, inheritedListener: { fd: 3, host: '::1', port: 80 } }), { code: 'GROK_PROXY_CONFIG_INVALID' })
  const proxy = createModelProxy({ ...base, inheritedListener: { fd: 3, host: '::1', port: 19777 } })
  await assert.rejects(proxy.listen(19778, '::1'), { code: 'GROK_PROXY_CONFIG_INVALID' })
  await proxy.close(); await close(upstream.server)
})

function waitForChildOutput(child, current, match, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error = null) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      child.stdout.off('data', onData); child.off('error', onError); child.off('exit', onExit)
      error ? reject(error) : resolve()
    }
    const onData = () => { if (match(current())) finish() }
    const onError = error => finish(error)
    const onExit = (code, signal) => finish(new Error(`${label} exited ${code}/${signal}: ${current()}`))
    const timer = setTimeout(() => finish(new Error(`${label} timed out: ${current()}`)), timeoutMs)
    child.stdout.on('data', onData); child.once('error', onError); child.once('exit', onExit)
    onData()
  })
}
async function stopChild(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; reject(new Error(`${label} did not exit after SIGTERM`)) }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

test('Grok proxy adopts an inherited IPv6 listener without rebinding and serves its child-only 401', { skip: process.platform === 'win32' }, async t => {
  const inherited = net.createServer()
  await new Promise((resolve, reject) => { inherited.once('error', reject); inherited.listen(0, '::1', resolve) })
  const port = inherited.address().port
  const sourceFd = inherited._handle.fd
  const script = `const http=require('node:http');const {createModelProxy}=require('./scripts/harness-v2-bridge/grok/model-proxy.cjs');const p=createModelProxy({upstreamUrl:'http://127.0.0.1:1',childToken:'child',upstreamAuthorization:'Bearer controller',allowedMcpTools:{autoprompt_owned__bash:()=>{}},inheritedListener:{fd:3,host:'::1',port:${port}}});(async()=>{await p.listen(${port},'::1');console.log('READY');const q=http.request({host:'::1',port:${port},path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer wrong','content-type':'application/json'}},r=>{r.resume();r.once('end',async()=>{console.log('HTTP:'+r.statusCode);await p.close()})});q.once('error',e=>{throw e});q.end('{}')})().catch(error=>{console.error(error.stack||error);process.exitCode=2})`
  const child = cp.spawn(process.execPath, ['-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', sourceFd] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk.toString() })
  let error = ''; child.stderr.on('data', chunk => { error += chunk.toString() })
  try {
    // Once this closes, only the duplicated FD in the child can answer.
    await new Promise((resolve, reject) => inherited.close(error => error ? reject(error) : resolve()))
    await waitForChildOutput(child, () => `${output}\n${error}`, value => value.includes('READY'), 5000, 'inherited proxy child')
    await waitForChildOutput(child, () => `${output}\n${error}`, value => value.includes('HTTP:401'), 5000, 'inherited proxy HTTP response')
    await new Promise((resolve, reject) => child.once('exit', (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error(`inherited proxy child exited ${code}/${signal}: ${error}`))))
  } finally { await stopChild(child, 'inherited proxy child') }
})

test('Grok proxy rejects an adopted FD whose actual IPv6 host or port differs from its binding', { skip: process.platform === 'win32' }, async t => {
  for (const [label, bindHost, descriptor] of [
    ['host', '127.0.0.1', address => ({ host: '::1', port: address.port, listenPort: address.port })],
    ['port', '::1', address => ({ host: '::1', port: address.port === 65535 ? address.port - 1 : address.port + 1, listenPort: address.port === 65535 ? address.port - 1 : address.port + 1 })],
  ]) {
    await t.test(label, async () => {
      const parent = net.createServer()
      await new Promise((resolve, reject) => parent.listen(0, bindHost, error => error ? reject(error) : resolve()))
      const actual = parent.address(), claimed = descriptor(actual), sourceFd = parent._handle.fd
      const script = `const {createModelProxy}=require('./scripts/harness-v2-bridge/grok/model-proxy.cjs');const p=createModelProxy({upstreamUrl:'http://127.0.0.1:1',childToken:'child',upstreamAuthorization:'Bearer controller',allowedMcpTools:{autoprompt_owned__bash:()=>{}},inheritedListener:{fd:3,host:'::1',port:${claimed.port}}});p.listen(${claimed.listenPort},'::1').then(()=>{console.log('UNEXPECTED')}).catch(error=>{console.log('RESULT:'+error.code)})`
      const child = cp.spawn(process.execPath, ['-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', sourceFd] })
      let output = ''; child.stdout.on('data', chunk => { output += chunk.toString() })
      try {
        await new Promise((resolve, reject) => parent.close(error => error ? reject(error) : resolve()))
        await waitForChildOutput(child, () => output, value => value.includes('RESULT:GROK_PROXY_CONFIG_INVALID'), 5000, `wrong-${label} proxy child`)
        assert.doesNotMatch(output, /UNEXPECTED/)
      } finally { await stopChild(child, `wrong-${label} proxy child`) }
    })
  }
})
