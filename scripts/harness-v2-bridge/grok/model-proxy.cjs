'use strict'

const http = require('node:http')
const crypto = require('node:crypto')

class GrokProxyError extends Error {
  constructor(code, message) { super(message); this.name = 'GrokProxyError'; this.code = code }
}

const fail = (code, message) => { throw new GrokProxyError(code, message) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const boundedText = (value, label) => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 65536) fail('GROK_PROXY_INVALID', `Invalid ${label}`)
  return value
}
function inheritedListener(value, label, expectedPort) {
  if (!object(value) || !Number.isSafeInteger(value.fd) || value.fd < 0 ||
      !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      value.host !== '::1' || value.port !== expectedPort) fail('GROK_PROXY_CONFIG_INVALID', `Invalid inherited ${label} listener`)
  return Object.freeze({ fd: value.fd, host: value.host, port: value.port })
}

const FIXED_META_TOOLS = Object.freeze([
  Object.freeze({ type: 'function', function: Object.freeze({ name: 'search_tool', description: 'Discover controller-owned MCP tools and their exact input schemas. This only searches the tool catalog; it does not search workspace files.', parameters: Object.freeze({ type: 'object', required: ['query'], properties: Object.freeze({ query: Object.freeze({ type: 'string', description: 'Keywords for the controller-owned tool catalog.' }), limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 32, description: 'Maximum catalog results.' }) }), additionalProperties: false }) }) }),
  Object.freeze({ type: 'function', function: Object.freeze({ name: 'use_tool', description: 'Call exactly one controller-owned MCP tool returned by search_tool. tool_input must match that discovered tool\'s exact schema; do not reuse search_tool query or limit as a tool input.', parameters: Object.freeze({ type: 'object', required: ['tool_name', 'tool_input'], properties: Object.freeze({ tool_name: Object.freeze({ type: 'string', description: 'Exact qualified name returned by search_tool.' }), tool_input: Object.freeze({ type: 'object', description: 'Arguments matching the discovered tool schema.' }) }), additionalProperties: false }) }) }),
])

function cloneFixedMetaTools() { return JSON.parse(JSON.stringify(FIXED_META_TOOLS)) }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
// Grok 1.0.13 constructs this identifier in generate_session_compact, outside
// the foreground sampler ledger. The stock automatic compaction prompt is
// pinned byte-for-byte from helpers/session_compact.rs (no user-context slot).
const COMPACTION_PROMPT_SHA256 = 'd1cf7e949d58623c3f76f433b962cfcb8278e3812e50d05c8ec7be8391ade936'
const COMPACTION_FIELDS = Object.freeze(['model', 'messages', 'temperature', 'max_tokens', 'tools', 'tool_choice', 'stream', 'stream_options'])
const NATIVE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
function nativeRequestIdentity(headers, body) {
  const requestId = headers?.['x-grok-req-id'], sessionId = headers?.['x-grok-session-id']
  if (!NATIVE_UUID.test(sessionId || '') || headers?.['x-grok-conv-id'] !== sessionId || typeof requestId !== 'string') fail('GROK_PROXY_REQUEST_ID_INVALID', 'Native request lacks its exact session headers')
  const compaction = requestId.startsWith('xai-compact-')
  if (!NATIVE_UUID.test(compaction ? requestId.slice('xai-compact-'.length) : requestId)) fail('GROK_PROXY_REQUEST_ID_INVALID', 'Native request identifier is outside the pinned request families')
  if (compaction) {
    const last = body?.messages?.at(-1)
    if (!object(body) || Object.keys(body).length !== COMPACTION_FIELDS.length || Object.keys(body).some(key => !COMPACTION_FIELDS.includes(key)) ||
        body.stream !== true || body.temperature !== 1 || typeof body.model !== 'string' || !body.model || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 ||
        !Array.isArray(body.tools) || !body.tools.length || !['auto', 'none'].includes(body.tool_choice) ||
        !object(body.stream_options) || Object.keys(body.stream_options).length !== 1 || body.stream_options.include_usage !== true ||
        !object(last) || Object.keys(last).length !== 2 || last.role !== 'user' || typeof last.content !== 'string' ||
        crypto.createHash('sha256').update(last.content).digest('hex') !== COMPACTION_PROMPT_SHA256) fail('GROK_PROXY_REQUEST_ID_INVALID', 'Native compaction request differs from its pinned text-only contract')
  }
  return Object.freeze({ kind: compaction ? 'compaction' : 'foreground', requestId, sessionId })
}
function strictSse(body) {
  if (typeof body !== 'string') fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE is not text')
  if (body.includes('\r')) {
    if (body.replaceAll('\r\n', '').includes('\r')) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE uses invalid line endings')
    body = body.replaceAll('\r\n', '\n')
  }
  if (!body.endsWith('\n\n')) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE has no terminal event boundary')
  const events = []; let done = false
  for (const frame of body.slice(0, -2).split('\n\n')) {
    if (!frame) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE contains an empty event')
    if (done) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE emitted data after [DONE]')
    const data = []
    for (const line of frame.split('\n')) {
      // OpenRouter emits informational SSE comments before a normal data
      // frame. Comments carry no event payload and cannot affect a tool call;
      // preserve the strict single-line data grammar for every real event.
      if (line.startsWith(':')) continue
      if (!line.startsWith('data:')) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE contains a non-data field')
      data.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5))
    }
    if (!data.length) continue
    const raw = data.join('\n')
    if (raw === '[DONE]') { if (data.length !== 1) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE has malformed [DONE]'); done = true; continue }
    let event
    try { event = JSON.parse(raw) } catch { fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream emitted invalid SSE JSON') }
    if (!object(event) || !Array.isArray(event.choices)) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE event has no choices array')
    events.push(event)
  }
  if (!done) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream SSE omitted [DONE]')
  return events
}
function sseCalls(body) {
  const partial = new Map()
  const append = call => {
    if (!object(call) || !Number.isSafeInteger(call.index) || call.index < 0 || !object(call.function)) fail('GROK_PROXY_UPSTREAM_INVALID', 'Malformed streamed tool call')
    const item = partial.get(call.index) || { id: call.id, name: '', arguments: '' }
    if (item.id && call.id && item.id !== call.id) fail('GROK_PROXY_UPSTREAM_INVALID', 'Tool call identity changed mid-stream')
    item.id ||= call.id
    if (call.function.name !== undefined) item.name += boundedText(call.function.name, 'tool name')
    if (call.function.arguments !== undefined) item.arguments += String(call.function.arguments)
    partial.set(call.index, item)
  }
  const events = strictSse(body)
  for (const event of events) {
    for (const choice of event.choices) {
      if (!object(choice)) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream choice is invalid')
      const calls = choice?.delta?.tool_calls || choice?.message?.tool_calls || []
      if (!Array.isArray(calls)) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream tool call list is invalid')
      for (const call of calls) append(call)
      if (choice?.delta?.function_call || choice?.message?.function_call || choice?.tool_calls || choice?.function_call) fail('GROK_PROXY_TOOL_DENIED', 'Noncanonical function calls are not admitted')
    }
  }
  return { calls: [...partial.values()], canonicalBody: `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n` }
}
function toolName(entry) { return entry?.function?.name }
function validateToolCall(call, allowedMcpTools) {
  boundedText(call.id, 'tool call id')
  if (call.name === 'search_tool') {
    let args
    try { args = JSON.parse(call.arguments) } catch { fail('GROK_PROXY_INVALID', 'search_tool arguments are not JSON') }
    if (!object(args) || Object.keys(args).some(key => !['query', 'limit'].includes(key))) fail('GROK_PROXY_INVALID', 'search_tool arguments are not fixed-schema')
    boundedText(args.query, 'search query')
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 32)) fail('GROK_PROXY_INVALID', 'search_tool limit is invalid')
    return { name: call.name, id: call.id, arguments: canonicalJson(args) }
  }
  if (call.name !== 'use_tool') fail('GROK_PROXY_TOOL_DENIED', `Native tool ${call.name || '<empty>'} is forbidden`)
  let args
  try { args = JSON.parse(call.arguments) } catch { fail('GROK_PROXY_INVALID', 'use_tool arguments are not JSON') }
  if (!object(args) || Object.keys(args).some(key => !['tool_name', 'tool_input'].includes(key))) fail('GROK_PROXY_INVALID', 'use_tool arguments are not fixed-schema')
  const target = boundedText(args.tool_name, 'owned MCP target')
  if (!object(args.tool_input) || !Object.hasOwn(allowedMcpTools, target)) fail('GROK_PROXY_TOOL_DENIED', `MCP target ${target} is forbidden`)
  const verifier = allowedMcpTools[target]
  if (typeof verifier !== 'function') fail('GROK_PROXY_POLICY_INVALID', `MCP target ${target} has no input verifier`)
  try { verifier(args.tool_input) } catch (error) { fail('GROK_PROXY_INVALID', `Owned MCP input rejected: ${error.message || 'invalid'}`) }
  return { name: call.name, id: call.id, target, arguments: canonicalJson(args) }
}
function validateHistory(messages, issued) {
  if (!Array.isArray(messages)) fail('GROK_PROXY_INVALID', 'Model request has no message array')
  for (const message of messages) {
    if (!object(message)) fail('GROK_PROXY_INVALID', 'Model history has a non-object message')
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) fail('GROK_PROXY_INVALID', 'Assistant tool history is invalid')
      for (const call of message.tool_calls) {
        const id = boundedText(call?.id, 'historical tool call id')
        const issuedCall = issued.get(id)
        if (!issuedCall || call?.function?.name !== issuedCall.name || typeof call?.function?.arguments !== 'string') fail('GROK_PROXY_TOOL_DENIED', 'Model history contains an unissued tool call')
        let argumentsValue
        try { argumentsValue = canonicalJson(JSON.parse(call.function.arguments)) } catch { fail('GROK_PROXY_INVALID', 'Historical tool arguments are invalid JSON') }
        if (argumentsValue !== issuedCall.arguments) fail('GROK_PROXY_TOOL_DENIED', 'Model history altered an issued tool call')
      }
    }
    if (message.role === 'tool' && !issued.has(boundedText(message.tool_call_id, 'tool result id'))) fail('GROK_PROXY_TOOL_DENIED', 'Model history contains an unissued tool result')
  }
}
async function readRequest(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail('GROK_PROXY_LIMIT', 'Request exceeds controller limit'); chunks.push(chunk) }
  return Buffer.concat(chunks).toString('utf8')
}
async function boundedResponseText(response, limit) {
  if (!response.body || typeof response.body.getReader !== 'function') fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream response is not a readable stream')
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limit) { await reader.cancel(); fail('GROK_PROXY_LIMIT', 'Upstream response exceeds controller limit') }; chunks.push(Buffer.from(next.value)) }
  } finally { reader.releaseLock?.() }
  return Buffer.concat(chunks).toString('utf8')
}
async function upstreamFetch(fetchImpl, upstreamUrl, request, signal) {
  const response = await fetchImpl(upstreamUrl, { method: 'POST', headers: request.headers, body: request.body, signal })
  const body = await boundedResponseText(response, 32 * 1024 * 1024)
  return { status: response.status, contentType: response.headers.get('content-type') || 'application/json', body }
}
function createModelProxy(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') fail('GROK_PROXY_CONFIG_INVALID', 'A fetch implementation is required')
  const upstreamUrl = boundedText(options.upstreamUrl, 'upstream URL')
  const childToken = boundedText(options.childToken, 'child proxy credential')
  const upstreamAuthorization = boundedText(options.upstreamAuthorization, 'upstream authorization')
  const allowedMcpTools = options.allowedMcpTools
  if (!object(allowedMcpTools) || !Object.keys(allowedMcpTools).length) fail('GROK_PROXY_POLICY_INVALID', 'At least one owned MCP tool is required')
  const expectedModel = options.model === undefined ? null : boundedText(options.model, 'model')
  const upstreamTimeoutMs = options.upstreamTimeoutMs === undefined ? 60000 : options.upstreamTimeoutMs
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1000 || upstreamTimeoutMs > 300000) fail('GROK_PROXY_CONFIG_INVALID', 'Upstream timeout is invalid')
  const inherited = options.inheritedListener == null ? null : inheritedListener(options.inheritedListener, 'model', options.inheritedListener.port)
  if (options.issuedCalls !== undefined && !Array.isArray(options.issuedCalls)) fail('GROK_PROXY_POLICY_INVALID', 'Issued call history is invalid')
  // The controller restores only records it previously captured from this
  // proxy's validated incoming events. A resumed Grok process never gets to
  // invent historical tool-call identities.
  const issued = new Map(), inflight = new Set(), audit = [], tokenHash = crypto.createHash('sha256').update(childToken).digest('hex')
  for (const entry of options.issuedCalls || []) {
    if (!object(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.arguments !== 'string') fail('GROK_PROXY_POLICY_INVALID', 'Issued call history is invalid')
    const call = validateToolCall(entry, allowedMcpTools)
    if (issued.has(call.id)) fail('GROK_PROXY_POLICY_INVALID', 'Issued call history contains a duplicate identity')
    issued.set(call.id, call)
  }
  const record = entry => { audit.push(entry); options.onAudit?.(entry) }
  let closed = false
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController(); inflight.add(controller)
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs); timeout.unref?.()
    const disconnect = () => { if (!res.writableEnded) controller.abort() }; res.once('close', disconnect)
    const reject = (code, message, status = 403) => {
      record({ type: 'blocked', code, message })
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: { type: 'policy_error', code, message } }))
    }
    try {
      if (closed) return reject('GROK_PROXY_CLOSED', 'Controller proxy is closed', 503)
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return reject('GROK_PROXY_ROUTE_DENIED', 'Only chat completions are admitted', 404)
      if (req.headers.authorization !== `Bearer ${childToken}`) return reject('GROK_PROXY_AUTH_DENIED', 'Child proxy credential is invalid', 401)
      let body
      try { body = JSON.parse(await readRequest(req)) } catch (error) { if (error instanceof GrokProxyError) throw error; fail('GROK_PROXY_INVALID', 'Request body is invalid JSON') }
      if (!object(body) || body.stream !== true) fail('GROK_PROXY_INVALID', 'Only streaming chat-completion requests are admitted')
      if (expectedModel && body.model !== expectedModel) fail('GROK_PROXY_MODEL_DENIED', 'Child selected an unbound model')
      const nativeIdentity = options.requireNativeRequestIdentity ? nativeRequestIdentity(req.headers, body) : null
      validateHistory(body.messages, issued)
      const original = Array.isArray(body.tools) ? body.tools.map(toolName) : []
      if (!original.includes('search_tool') || !original.includes('use_tool')) fail('GROK_PROXY_INVALID', 'Grok MCP meta-tool schemas are missing')
      body.tools = cloneFixedMetaTools(); body.tool_choice = nativeIdentity?.kind === 'compaction' ? 'none' : 'auto'
      record({ type: 'outbound', original, forwarded: ['search_tool', 'use_tool'], childTokenHash: tokenHash })
      const upstream = await upstreamFetch(fetchImpl, upstreamUrl, { headers: { 'content-type': 'application/json', authorization: upstreamAuthorization,
        ...(nativeIdentity ? { 'x-grok-req-id': nativeIdentity.requestId, 'x-grok-session-id': nativeIdentity.sessionId, 'x-grok-conv-id': nativeIdentity.sessionId } : {}) }, body: JSON.stringify(body) }, controller.signal)
      if (upstream.status < 200 || upstream.status >= 300) fail('GROK_PROXY_UPSTREAM_FAILURE', `Upstream returned HTTP ${upstream.status}`)
      if (!upstream.contentType.includes('text/event-stream')) fail('GROK_PROXY_UPSTREAM_INVALID', 'Upstream did not return streaming SSE')
      const parsed = sseCalls(upstream.body), calls = parsed.calls.map(call => validateToolCall(call, allowedMcpTools))
      if (nativeIdentity?.kind === 'compaction' && calls.length) fail('GROK_PROXY_TOOL_DENIED', 'Compaction cannot issue executable tools')
      for (const call of calls) issued.set(call.id, call)
      record({ type: 'incoming', calls })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.end(parsed.canonicalBody)
    } catch (error) {
      const code = error instanceof GrokProxyError ? error.code : 'GROK_PROXY_FAILURE'
      reject(code, error.message || 'Controller proxy failed', code === 'GROK_PROXY_UPSTREAM_FAILURE' ? 502 : 403)
    } finally { clearTimeout(timeout); res.off('close', disconnect); inflight.delete(controller) }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  return {
    server,
    audit,
    issuedCalls() { return [...issued.values()].map(call => ({ ...call })) },
    async listen(port = 0, host = '127.0.0.1') {
      if (inherited && (port !== inherited.port || host !== inherited.host)) fail('GROK_PROXY_CONFIG_INVALID', 'Inherited model listener address differs from its authenticated binding')
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        const done = () => {
          server.off('error', reject)
          const address = server.address()
          if (!address || typeof address === 'string' || inherited && (address.address !== '::1' || address.family !== 'IPv6' || address.port !== inherited.port)) {
            try { server.close() } catch {}
            reject(new GrokProxyError('GROK_PROXY_CONFIG_INVALID', 'Inherited model listener is not the authenticated IPv6 endpoint'))
            return
          }
          resolve()
        }
        if (inherited) server.listen({ fd: inherited.fd, exclusive: true }, done)
        else server.listen(port, host, done)
      })
      return server.address()
    },
    async close() { closed = true; for (const controller of inflight) controller.abort(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(() => resolve())) },
  }
}

module.exports = { FIXED_META_TOOLS, GrokProxyError, createModelProxy, sseCalls, strictSse, validateToolCall, nativeRequestIdentity, COMPACTION_PROMPT_SHA256 }
