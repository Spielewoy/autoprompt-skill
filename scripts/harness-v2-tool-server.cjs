#!/usr/bin/env node
'use strict'

// MCP stdio: newline-delimited UTF-8 JSON-RPC, with a fixed controller-owned
// tool surface. No provider credentials or arbitrary server modules are loaded.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { StringDecoder } = require('node:string_decoder')
const boundary = require('./harness-v2-tool-boundary.cjs')
const PROTOCOLS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
const MAX_LINE = 5 * 1024 * 1024
const HERMES_PHASE_JOURNAL = 'hermes-tool-phases.jsonl'
const MAX_PHASE_RECORDS = 256
const PHASE_STAGES = new Set([
  'tool-server-start', 'tool-server-close',
  'tool-lease-start', 'tool-lease-ready', 'tool-lease-failed',
  'tool-call-start', 'tool-call-result', 'tool-receipt-committed',
  'worker-admission-start', 'worker-admission-cache-hit', 'worker-admission-wait',
  'worker-canary-start', 'worker-canary-finished', 'worker-canary-failed',
  'worker-admission-ready', 'worker-admission-failed',
  'worker-command-start', 'worker-command-finished', 'worker-command-failed',
])
const validId = id => (typeof id === 'string' && id.length <= 256) || Number.isSafeInteger(id)

function createPrivatePhaseJournal(root, provider, dependencies = {}) {
  if (provider !== 'hermes') return null
  const io = dependencies.fs || fs
  const journalPath = path.join(root, HERMES_PHASE_JOURNAL)
  let fd, identity, size = 0
  try {
    fd = io.openSync(journalPath, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL |
      (io.constants.O_NOFOLLOW || 0), 0o600)
    const stat = io.fstatSync(fd)
    if (!stat.isFile() || stat.isSymbolicLink?.() || stat.nlink !== 1) throw new Error('phase journal is not a private file')
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error('phase journal permissions changed')
    identity = { dev: String(stat.dev), ino: String(stat.ino) }
  } catch {
    if (fd !== undefined) { try { io.closeSync(fd) } catch {} }
    return null
  }
  try { io.closeSync(fd) } catch { return null }
  let sequence = 0, closed = false
  const close = () => { closed = true }
  const record = value => {
    if (closed || sequence >= MAX_PHASE_RECORDS || !value || !PHASE_STAGES.has(value.stage)) return false
    const code = value.code === undefined ? undefined
      : (/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : 'INTERNAL_ERROR')
    const entry = { schemaVersion: 1, sequence: sequence + 1, stage: value.stage, ...(code ? { code } : {}) }
    let appendFd
    try {
      const before = io.lstatSync(journalPath)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || String(before.dev) !== identity.dev ||
          String(before.ino) !== identity.ino || before.size !== size) return false
      appendFd = io.openSync(journalPath, io.constants.O_WRONLY | io.constants.O_APPEND | (io.constants.O_NOFOLLOW || 0))
      const opened = io.fstatSync(appendFd)
      if (!opened.isFile() || opened.nlink !== 1 || String(opened.dev) !== identity.dev || String(opened.ino) !== identity.ino || opened.size !== size) return false
      const bytes = Buffer.from(`${JSON.stringify(entry)}\n`)
      if (io.writeSync(appendFd, bytes) !== bytes.length) { close(); return false }
      io.fsyncSync(appendFd)
      size += bytes.length
      sequence++
      return true
    } catch { close(); return false }
    finally { if (appendFd !== undefined) { try { io.closeSync(appendFd) } catch {} } }
  }
  return Object.freeze({ path: journalPath, record, close })
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--policy' || argv[2] !== '--sha256' || !path.isAbsolute(argv[1])) {
    throw new boundary.BoundaryError('TOOL_POLICY_INVALID', 'Use --policy <absolute-file> --sha256 <digest>')
  }
  return boundary.loadBoundary(argv[1], argv[3])
}

function start(options) {
  const state = boundary.loadBoundary(options.boundary.policyPath, options.boundary.policySha256)
  let phases = null
  // Hermes does not expose structured native tool lifecycle records.  Its
  // fixed plugin invokes this controller directly, so commit a second, sealed
  // projection record here, at the same authority boundary as the execution
  // receipt.  The wrapper may relay it, but transport still matches every
  // field to this receipt before it becomes a command/file observation.
  const projectionPath = process.env.AUTOPROMPT_HERMES_TOOL_PROJECTIONS
  let projection = null
  if (projectionPath !== undefined) {
    const expected = path.join(state.root, 'hermes-projections.jsonl')
    if (state.policy.provider !== 'hermes' || projectionPath !== expected) {
      throw new boundary.BoundaryError('TOOL_POLICY_INVALID', 'Hermes tool projection path is not controller-owned')
    }
    const stat = fs.lstatSync(projectionPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 2 * 1024 * 1024) {
      throw new boundary.BoundaryError('TOOL_POLICY_INVALID', 'Hermes tool projection journal is invalid')
    }
    const lines = fs.readFileSync(projectionPath, 'utf8').split('\n').filter(Boolean)
    let previous = null
    for (const [index, line] of lines.entries()) {
      let record
      try { record = JSON.parse(line) } catch { throw new boundary.BoundaryError('TOOL_POLICY_INVALID', 'Hermes tool projection journal is invalid') }
      const { hash, ...body } = record || {}
      if (!record || Object.keys(record).length !== 7 || body.sequence !== index + 1 || body.previous !== previous ||
          !/^[a-f0-9]{64}$/.test(body.receiptHash || '') || typeof body.name !== 'string' ||
          !body.args || typeof body.args !== 'object' || Array.isArray(body.args) || typeof body.output !== 'string' ||
          hash !== boundary.sha256(boundary.canonicalJson(body))) {
        throw new boundary.BoundaryError('TOOL_POLICY_INVALID', 'Hermes tool projection journal is invalid')
      }
      previous = hash
    }
    projection = { path: projectionPath, sequence: lines.length, previous }
  }
  const appendProjection = (receipt, name, args, result) => {
    if (!projection) return
    const body = { sequence: projection.sequence + 1, previous: projection.previous,
      receiptHash: receipt.hash, name, args, output: JSON.stringify(result) }
    const record = { ...body, hash: boundary.sha256(boundary.canonicalJson(body)) }
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
    const fd = fs.openSync(projection.path, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0))
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1) throw new boundary.BoundaryError('TOOL_RECEIPT_INVALID', 'Hermes tool projection journal changed')
      fs.writeSync(fd, bytes); fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    projection.sequence = body.sequence; projection.previous = record.hash
  }
  const input = options.input || process.stdin, output = options.output || process.stdout
  const lockPath = path.join(state.root, 'server.lock')
  const lockBytes = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), policySha256: state.policySha256 })
  const platform = options.platform || process.platform
  let windowsLease = null
  let leasePromise = null
  if (platform === 'win32') {
    const createLease = options.windowsLeaseFactory || require('./harness-v2-windows-tool-lease.cjs').createWindowsToolLeaseAsync
    // Do not block the provider's short MCP initialization window on Windows
    // lease setup. Capability requests await and assert this exact lease.
    leasePromise = new Promise((resolve, reject) => setImmediate(async () => {
      phases?.record({ stage: 'tool-lease-start' })
      try {
        windowsLease = await createLease({ lockPath, lockBytes: Buffer.from(lockBytes) })
        phases?.record({ stage: 'tool-lease-ready' })
        resolve(windowsLease)
      } catch (error) {
        phases?.record({ stage: 'tool-lease-failed', code: error?.code || 'INTERNAL_ERROR' })
        reject(error)
      }
    }))
    // A provider may terminate before sending any protocol request. Attach a
    // rejection observer immediately; request handling and close() still
    // receive the original failure when they are present.
    leasePromise.catch(() => { setImmediate(() => { void close() }) })
  } else fs.writeFileSync(lockPath, lockBytes, { flag: 'wx', mode: 0o600 })
  // Start diagnostics only after every synchronous authority and lock check
  // above has succeeded. A rejected server startup leaves no phase artifact.
  phases = createPrivatePhaseJournal(state.root, state.policy.provider)
  phases?.record({ stage: 'tool-server-start' })
  const pending = new Map(), ids = new Set()
  const decoder = new StringDecoder('utf8')
  let buffer = '', chain = Promise.resolve(), initialized = false, ready = false, closing = false
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })
  const send = value => { if (!output.destroyed && output.writable !== false) output.write(`${JSON.stringify(value)}\n`) }
  const error = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
  const requireLease = async () => {
    if (platform !== 'win32') return null
    try {
      const lease = await leasePromise
      lease.assertHeld()
      return lease
    } catch (error) {
      // Do not leave a provider waiting on a dead MCP child after a failed
      // lease admission. Defer close until the current protocol promise has
      // unwound so cleanup cannot race its own chain.
      setImmediate(() => { void close() })
      throw error
    }
  }
  const release = async () => {
    input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onError)
    output.removeListener('error', onError)
    try {
      if (platform === 'win32') {
        try { windowsLease ||= await leasePromise } catch { return }
        await windowsLease?.release()
      } else {
        boundary.physical(lockPath)
        if (fs.readFileSync(lockPath, 'utf8') === lockBytes) fs.unlinkSync(lockPath)
      }
    } catch { /* A changed lock remains for explicit inspection. */ }
    finally {
      phases?.record({ stage: 'tool-server-close' })
      phases?.close()
      resolveClosed()
    }
  }
  function close() {
    if (closing) return closed
    closing = true
    for (const controller of pending.values()) controller.abort()
    chain.finally(release).catch(() => {})
    return closed
  }
  async function handle(request, controller) {
    if (windowsLease) windowsLease.assertHeld()
    const id = request.id
    if (controller.signal.aborted) { error(id, -32800, 'Request cancelled'); return }
    if (request.method === 'initialize') {
      if (initialized || !request.params || typeof request.params.protocolVersion !== 'string') {
        error(id, -32602, 'Invalid or repeated initialization'); return
      }
      initialized = true
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOLS.includes(request.params.protocolVersion) ? request.params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'autoprompt-owned-tools', version: '2.0.0' },
        instructions: 'Use only assigned paths. Commands run without network access or host credentials. Native child dispatch is not available.',
      } })
      return
    }
    await requireLease()
    if (controller.signal.aborted || closing) { error(id, -32800, 'Request cancelled'); return }
    if (!initialized || !ready) { error(id, -32002, 'The tool server is not initialized'); return }
    if (request.method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return }
    if (request.method === 'tools/list') {
      if (request.params?.cursor !== undefined) { error(id, -32602, 'This bounded tool inventory has no pagination'); return }
      send({ jsonrpc: '2.0', id, result: { tools: (state.policy.toolFree === true ? [] : boundary.TOOLS).map(tool => ({ ...tool,
        annotations: { readOnlyHint: ['read', 'list', 'search'].includes(tool.name), openWorldHint: false },
      })) } }); return
    }
    if (request.method !== 'tools/call') { error(id, -32601, 'Method not found'); return }
    if (!request.params || typeof request.params.name !== 'string' ||
        Object.keys(request.params).some(key => !['name', 'arguments', '_meta'].includes(key))) {
      error(id, -32602, 'Invalid tool call'); return
    }
    const name = request.params.name, args = request.params.arguments || {}
    const startedAt = new Date().toISOString()
    let result
    phases?.record({ stage: 'tool-call-start' })
    try {
      const current = boundary.loadBoundary(state.policyPath, state.policySha256)
      result = await boundary.executeTool(current.policy, name, args, {
        signal: controller.signal,
        controlRoot: current.root,
        onPhase: value => { phases?.record(value) },
      })
    } catch (failure) {
      const text = `${failure.code || 'TOOL_FAILED'}: ${failure.message}`
      result = { tool: name, status: 'failed', exitCode: null, output: text,
        outputSha256: boundary.sha256(text), code: failure.code || 'TOOL_FAILED' }
    }
    phases?.record({ stage: 'tool-call-result', ...(result.status === 'completed' ? {} : { code: result.code || 'TOOL_FAILED' }) })
    // The private journal is committed before the native harness sees success.
    // A failed append cannot be converted into a successful tool response.
    try {
      const receipt = boundary.appendReceipt(state, name, args, result, startedAt)
      appendProjection(receipt, name, args, result)
      phases?.record({ stage: 'tool-receipt-committed' })
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result, isError: result.status !== 'completed',
        _meta: { 'autoprompt/receipt': receipt.hash, 'autoprompt/policy': state.policySha256 } } })
    } catch (failure) { error(id, -32603, 'Tool execution evidence could not be committed', { code: failure.code || 'TOOL_RECEIPT_INVALID' }); close() }
  }
  function accept(line) {
    if (closing || !line.trim()) return
    let request
    try { request = JSON.parse(line) } catch { error(null, -32700, 'Invalid JSON'); return }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      error(null, -32600, 'Invalid JSON-RPC request'); return
    }
    if (!Object.hasOwn(request, 'id')) {
      if (request.method === 'notifications/cancelled') pending.get(request.params?.requestId)?.abort()
      else if (request.method === 'notifications/initialized') {
        // Initialization and its notification may arrive in the same stream
        // chunk. Preserve their ordering without delaying cancellation.
        chain = chain.then(() => { if (initialized) ready = true })
      }
      return
    }
    if (!validId(request.id) || ids.has(request.id) || ids.size >= 100000 || pending.size >= 64) {
      error(validId(request.id) ? request.id : null, -32600, 'Invalid, repeated, or excessive request identity'); return
    }
    ids.add(request.id)
    const controller = new AbortController(); pending.set(request.id, controller)
    chain = chain.then(() => handle(request, controller)).catch(failure => {
      error(request.id, -32603, 'Tool server failed closed', { code: failure.code || 'INTERNAL_ERROR' })
    }).finally(() => pending.delete(request.id))
  }
  function onData(bytes) {
    buffer += decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_LINE) { error(null, -32600, 'Request exceeds the byte limit'); close(); return }
      accept(line)
    }
    if (Buffer.byteLength(buffer) > MAX_LINE) { error(null, -32600, 'Request exceeds the byte limit'); close() }
  }
  function onEnd() { if (buffer.trim()) error(null, -32700, 'Incomplete JSON-RPC frame'); close() }
  function onError() { close() }
  input.on('data', onData); input.once('end', onEnd); input.once('error', onError); output.once('error', onError)
  return { close, closed, boundary: state }
}

if (require.main === module) {
  let server
  try {
    server = start({ boundary: parseArguments(process.argv.slice(2)) })
    server.closed.then(() => { process.stdin.destroy() })
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      process.exitCode = signal === 'SIGTERM' ? 143 : 130
      server.close().then(() => { process.stdin.destroy() })
    })
  } catch (error) { process.stderr.write(`${error.code || 'TOOL_SERVER_FAILED'}: ${error.message}\n`); process.exitCode = 1 }
}
module.exports = { PROTOCOLS, MAX_LINE, HERMES_PHASE_JOURNAL, PHASE_STAGES, createPrivatePhaseJournal, parseArguments, start }
