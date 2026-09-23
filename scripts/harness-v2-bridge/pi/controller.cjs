'use strict'

// Trusted extension code only: never load a module, command backend, or policy
// from model arguments. Native startup must also disable automatic extensions.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const boundary = require('../../harness-v2-tool-boundary.cjs')
const NAMES = Object.freeze(boundary.TOOLS.map(tool => `autoprompt_owned_${tool.name}`))
const fail = (code, message) => { throw new boundary.BoundaryError(code, message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function failureCode(error, aborted = false) {
  if (aborted) return 'TOOL_CANCELLED'
  const code = error?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'TOOL_FAILED'
}
function sourceOwnedFailureDiagnostic(error) {
  const root = path.resolve(__dirname, '../../..')
  const relativeFrame = line => {
    const match = /(?:\(|\s)([^()\r\n]+):(\d+):(\d+)\)?$/u.exec(line)
    if (!match) return null
    const file = path.resolve(match[1]), relative = path.relative(root, file)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        !/^(?:scripts|agents[\\/]codex[\\/]workflow)[\\/]/u.test(relative)) return null
    return `${relative.split(path.sep).join('/')}:${match[2]}:${match[3]}`.slice(0, 256)
  }
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name) ? error.name : 'Error'
  const originalCode = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(error.code) ? error.code : null
  const sourceFrames = typeof error?.stack === 'string'
    ? error.stack.split(/\r?\n/u).map(relativeFrame).filter(Boolean).slice(0, 8) : []
  return Object.freeze({ name, originalCode, sourceFrames })
}

function openDiagnostic(root, nonce) {
  const file = path.join(root, `pi-handler-${nonce}.jsonl`)
  const fd = fs.openSync(file, 'wx', 0o600)
  let closed = false, written = 0
  return Object.freeze({ file,
    write(event, phase, details = {}) {
      if (closed) return
      const record = { schemaVersion: 1, timestamp: new Date().toISOString(), event, phase, ...details }
      const bytes = Buffer.from(`${boundary.canonicalJson(record)}\n`)
      if (written + bytes.length > 1024 * 1024) return
      try { written += fs.writeSync(fd, bytes) } catch { /* Diagnostics never alter controller authority. */ }
    },
    close() { if (!closed) { closed = true; try { fs.closeSync(fd) } catch {} } },
  })
}

function privateState(state, paths = []) {
  for (const file of [state.root, ...paths.filter(Boolean)]) {
    const real = boundary.physical(file, { missingLeaf: true })
    if (state.policy.readableRoots.some(root => boundary.within(root, real) || boundary.within(real, root))) {
      fail('TOOL_POLICY_INVALID', 'Native controller state must be disjoint from task roots')
    }
  }
}

function openController(provider, environment = process.env) {
  const policyPath = environment.AUTOPROMPT_TOOL_POLICY
  const digest = environment.AUTOPROMPT_TOOL_POLICY_SHA256
  if (!policyPath || !path.isAbsolute(policyPath)) fail('TOOL_POLICY_INVALID', 'Private tool policy path is required')
  const state = boundary.loadBoundary(policyPath, digest)
  if (state.policy.provider !== provider) fail('TOOL_POLICY_INVALID', 'Tool policy provider mismatch')
  privateState(state)
  const lockPath = path.join(state.root, 'server.lock')
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const lockBytes = JSON.stringify({ pid: process.pid, nonce, policySha256: digest })
  const fd = fs.openSync(lockPath, 'wx', 0o600)
  try { fs.writeFileSync(fd, lockBytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  let diagnostic
  try { diagnostic = openDiagnostic(state.root, nonce) } catch (error) {
    try {
      boundary.physical(lockPath)
      if (fs.readFileSync(lockPath, 'utf8') === lockBytes) fs.unlinkSync(lockPath)
    } catch {}
    throw error
  }
  let chain = Promise.resolve(), closing = false, closePromise
  const pending = new Set()
  function check() {
    const current = boundary.loadBoundary(policyPath, digest)
    privateState(current)
    boundary.physical(lockPath)
    if (fs.readFileSync(lockPath, 'utf8') !== lockBytes) fail('TOOL_POLICY_INVALID', 'Controller ownership changed')
    boundary.readReceipts(current)
    return current
  }
  function close() {
    if (closePromise) return closePromise
    closing = true
    for (const item of pending) item.abort()
    closePromise = chain.then(() => {
      try {
        boundary.physical(lockPath)
        if (fs.readFileSync(lockPath, 'utf8') === lockBytes) fs.unlinkSync(lockPath)
      } catch { /* Preserve changed or stale ownership for controller inspection. */ }
      diagnostic.close()
    })
    return closePromise
  }
  function execute(name, input, signal) {
    if (closing) return Promise.reject(new boundary.BoundaryError('TOOL_CLOSED', 'Controller is closing'))
    if (!NAMES.includes(name)) return Promise.reject(new boundary.BoundaryError('TOOL_DENIED', 'Only controller tools are available'))
    if (pending.size >= 64) return Promise.reject(new boundary.BoundaryError('TOOL_QUEUE_LIMIT', 'Controller tool queue is full'))
    // Snapshot before enqueue: later native middleware cannot mutate a queued call.
    let args
    try { args = JSON.parse(boundary.canonicalJson(input)) } catch { return Promise.reject(new boundary.BoundaryError('TOOL_ARGUMENTS_INVALID', 'Tool arguments must be JSON')) }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    pending.add(controller)
    const job = chain.then(async () => {
      const startedAt = new Date().toISOString(), tool = name.slice('autoprompt_owned_'.length)
      let actualResult
      try {
        const current = check()
        actualResult = await boundary.executeTool(current.policy, tool, args, { signal: controller.signal, controlRoot: current.root })
      } catch (error) {
        // Do not echo host paths/stack traces from filesystem errors into context.
        // Keep a bounded machine code from trusted runtime boundaries. This is
        // also enough to distinguish a host cancellation from a launcher or
        // resource failure without exposing the exception text.
        const code = failureCode(error, controller.signal.aborted)
        diagnostic.write('tool_execute', 'failed', { code, aborted: controller.signal.aborted, failure: sourceOwnedFailureDiagnostic(error) })
        const output = `${code}: ${error instanceof boundary.BoundaryError ? error.message : 'Controller tool execution failed'}`
        actualResult = { tool, status: 'failed', exitCode: null, output, outputSha256: boundary.sha256(output), code }
      }
      try {
        check()
        const receipt = boundary.appendReceipt(state, tool, args, actualResult, startedAt)
        return { content: [{ type: 'text', text: JSON.stringify(actualResult) }],
          details: { actualResult, receiptSha256: receipt.hash, policySha256: digest },
          isError: actualResult.status !== 'completed' }
      } catch {
        closing = true
        for (const item of pending) item.abort()
        fail('TOOL_RECEIPT_INVALID', 'Controller execution evidence could not be committed')
      }
    }).finally(() => { pending.delete(controller); signal?.removeEventListener('abort', cancel) })
    // A failed call never poisons cleanup, nor allows a queued mutation to run.
    chain = job.catch(() => {})
    return job
  }
  return { execute, close, check, state, diagnostic, get closing() { return closing } }
}

// Translate only the controller's fixed schemas using each host's native schema
// builder. Prime supplies TypeBox; OMP supplies its injected compatibility API.
function parameters(Type, schema) {
  const properties = {}
  for (const [key, spec] of Object.entries(schema.properties)) {
    let value
    if (spec.type === 'string') value = Type.String()
    else if (spec.type === 'boolean') value = Type.Boolean()
    else if (spec.type === 'integer') value = Type.Integer({ minimum: spec.minimum, ...(spec.maximum ? { maximum: spec.maximum } : {}) })
    else fail('TOOL_POLICY_INVALID', 'Unsupported controller schema')
    properties[key] = schema.required.includes(key) ? value : Type.Optional(value)
  }
  return Type.Object(properties, { additionalProperties: false })
}

function openAIResponseFormat(state, environment = process.env) {
  const schemaPath = environment.AUTOPROMPT_PI_OUTPUT_SCHEMA
  const expectedHash = environment.AUTOPROMPT_PI_OUTPUT_SCHEMA_SHA256
  if (schemaPath === undefined && expectedHash === undefined) return null
  if (typeof schemaPath !== 'string' || !path.isAbsolute(schemaPath) ||
      typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
    fail('PROFILE_INVALID', 'Pi output schema binding is invalid')
  }
  const real = boundary.physical(schemaPath)
  privateState(state, [real])
  const bytes = fs.readFileSync(real)
  if (bytes.length > 256 * 1024 || crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    fail('PROFILE_INVALID', 'Pi output schema binding changed')
  }
  let schema
  try { schema = JSON.parse(bytes.toString('utf8')) } catch { fail('PROFILE_INVALID', 'Pi output schema is invalid JSON') }
  if (!object(schema)) fail('PROFILE_INVALID', 'Pi output schema must be an object')
  return Object.freeze({ type: 'json_schema', json_schema: { name: 'autoprompt_result', strict: true, schema } })
}

function openAIOutputCap(environment = process.env) {
  const field = environment.AUTOPROMPT_PI_OUTPUT_CAP_FIELD
  const rawValue = environment.AUTOPROMPT_PI_OUTPUT_CAP_VALUE
  if (field === undefined && rawValue === undefined) return null
  if (field !== undefined && !['max_tokens', 'max_completion_tokens'].includes(field) || typeof rawValue !== 'string' ||
      !/^[1-9][0-9]{0,15}$/u.test(rawValue)) fail('PROFILE_INVALID', 'Pi output cap binding is invalid')
  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value <= 0) fail('PROFILE_INVALID', 'Pi output cap binding is invalid')
  return Object.freeze({ field: field || null, value })
}

function bindOpenAIResponseFormat(payload, responseFormat, outputCap = null) {
  if (!object(responseFormat) && !outputCap) return payload
  // Prime and OMP are reviewed only for their OpenAI Chat Completions request
  // dialect.  The relay independently refuses any other wire shape when this
  // controller binding is required; native extension exceptions are logged by
  // both CLIs and cannot be treated as a request denial.
  if (!object(payload) || !Array.isArray(payload.messages) || Object.hasOwn(payload, 'input')) {
    fail('PROVIDER_UNSUPPORTED', 'Pi structured output supports only OpenAI Chat Completions payloads')
  }
  const existingCaps = ['max_tokens', 'max_completion_tokens'].filter(field => Object.hasOwn(payload, field))
  let cap = null
  if (outputCap) {
    if (existingCaps.length > 1) fail('PROVIDER_UNSUPPORTED', 'Pi native request has ambiguous output caps')
    if (existingCaps.length === 1) {
      const field = existingCaps[0], value = payload[field]
      if (!Number.isSafeInteger(value) || value <= 0) fail('PROVIDER_UNSUPPORTED', 'Pi native output cap is invalid')
      cap = { field, value: Math.min(value, outputCap.value) }
    } else {
      if (!outputCap.field) fail('PROVIDER_UNSUPPORTED', 'Pi native request omitted its output cap and the selected model has no bound wire field')
      cap = outputCap
    }
  }
  return { ...payload, ...(object(responseFormat) ? { response_format: structuredClone(responseFormat) } : {}),
    ...(cap ? { [cap.field]: cap.value } : {}) }
}

function install(pi, provider, Type, environment = process.env) {
  let controller, ready = false, context, activation, stopped = false
  const close = async () => {
    stopped = true
    ready = false
    if (controller) await controller.close()
  }
  const stop = async ctx => {
    ready = false
    try { await pi.setActiveTools([]) } catch {}
    await close()
    // abort may wait for the very tool that invoked stop; never await that cycle.
    try { ctx?.abort()?.catch?.(() => {}) } catch {}
    try { ctx?.shutdown() } catch {}
  }
  const allowedTools = () => controller?.state.policy.toolFree === true ? [] : NAMES
  const exactTools = () => {
    const active = pi.getActiveTools()
    const allowed = allowedTools()
    return active.length === allowed.length && active.every(name => allowed.includes(name))
  }
  const trace = (event, handler, initialize = false) => (...args) => {
    let pending = false
    if (initialize && !controller) controller = openController(provider, environment)
    controller?.diagnostic.write(event, 'started')
    const timer = setTimeout(() => { pending = true; controller?.diagnostic.write(event, 'pending') }, 25000)
    timer.unref?.()
    return Promise.resolve().then(() => handler(...args)).then(result => {
      clearTimeout(timer)
      controller?.diagnostic.write(event, 'completed', { exceededWarningThreshold: pending })
      return result
    }, error => {
      clearTimeout(timer)
      controller?.diagnostic.write(event, 'failed', { code: failureCode(error) })
      throw error
    })
  }
  const activate = (_event, ctx) => {
    context = ctx
    if (activation) return activation
    activation = (async () => {
      try {
        if (stopped) fail('TOOL_CLOSED', 'Controller is closed')
        // Native turn notifications can overlap streaming tool dispatch. Do not
        // transiently disable a healthy surface on every notification.
        if (ready && controller && !controller.closing && exactTools()) {
          privateState(controller.check(), [ctx.cwd, ctx.sessionManager?.getSessionFile?.(), environment.HOME])
          return
        }
        if (!controller) controller = openController(provider, environment)
        ready = false
        await pi.setActiveTools([])
        if (stopped) fail('TOOL_CLOSED', 'Controller is closed')
        if (controller.closing) fail('TOOL_CLOSED', 'Controller is closed')
        privateState(controller.check(), [ctx.cwd, ctx.sessionManager?.getSessionFile?.(), environment.HOME])
        await pi.setActiveTools([...allowedTools()])
        if (stopped || controller.closing) fail('TOOL_CLOSED', 'Controller closed during native activation')
        if (!exactTools()) fail('TOOL_DENIED', 'Native tool activation did not honor the fixed surface')
        ready = true
      } catch (error) { await stop(ctx); throw error }
    })()
    const pending = activation
    pending.finally(() => { if (activation === pending) activation = undefined }).catch(() => {})
    return pending
  }
  pi.on('tool_call', trace('tool_call', async event => {
    try { if (activation) await activation } catch { /* A failed activation stays closed. */ }
    if (!ready || controller?.closing || !allowedTools().includes(event.toolName)) {
      return { block: true, reason: 'TOOL_DENIED: Only the assigned controller tools are available' }
    }
  }))
  pi.on('tool_result', trace('tool_result', async (event, ctx) => {
    if (!NAMES.includes(event.toolName) || !event.details?.actualResult) return
    const { actualResult, receiptSha256 } = event.details
    try {
      const receipts = boundary.readReceipts(controller.state)
      const receipt = receipts.find(item => item.hash === receiptSha256)
      if (!receipt || receipt.tool !== event.toolName.slice('autoprompt_owned_'.length) ||
          receipt.resultSha256 !== boundary.sha256(boundary.canonicalJson(actualResult))) {
        fail('TOOL_RECEIPT_INVALID', 'Native tool result does not match committed evidence')
      }
    } catch {
      await stop(ctx)
      fail('TOOL_RECEIPT_INVALID', 'Native tool result does not match committed evidence')
    }
    // Prime ignores isError returned by execute. The native result hook carries
    // the error flag while preserving the committed JSON, including denials.
    return { content: [{ type: 'text', text: JSON.stringify(actualResult) }],
      details: event.details, isError: actualResult.status !== 'completed' }
  }))
  pi.on('before_provider_request', event => {
    if (!controller) fail('TOOL_DENIED', 'Pi controller is not active')
    return bindOpenAIResponseFormat(event?.payload, openAIResponseFormat(controller.state, environment), openAIOutputCap(environment))
  })
  for (const tool of boundary.TOOLS) pi.registerTool({
    name: `autoprompt_owned_${tool.name}`, label: `Controller ${tool.name}`,
    description: tool.description, parameters: parameters(Type, tool.inputSchema),
    // OMP keeps these tools immediate and visible; Prime ignores extra metadata.
    hidden: false, defaultInactive: false, deferrable: false, loadMode: 'essential',
    async execute(_id, args, signal) {
      if (activation) await activation
      if (!ready || !controller) fail('TOOL_DENIED', 'Controller session is not ready')
      try { return await controller.execute(`autoprompt_owned_${tool.name}`, args, signal) }
      catch (error) {
        if (controller.closing) await stop(context)
        throw error
      }
    },
  })
  pi.on('session_start', trace('session_start', activate, true))
  pi.on('before_agent_start', trace('before_agent_start', activate, true))
  pi.on('turn_start', trace('turn_start', activate, true))
  // A reservation owns exactly one native history. Resume uses another process.
  for (const event of ['session_before_switch', 'session_before_branch', 'session_before_tree']) {
    pi.on(event, async () => ({ cancel: true }))
  }
  pi.on('session_shutdown', close)
  const denied = async () => ({ result: { output: 'TOOL_DENIED: Native execution is disabled', exitCode: 1, cancelled: false, truncated: false } })
  pi.on('user_bash', denied)
  if (provider === 'omp') pi.on('user_python', denied)
  // Native hosts own process termination; we synchronously cancel outstanding
  // work on signals and keep the lock until the serialized journal has drained.
  const signals = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => {
    process.exitCode = signal === 'SIGTERM' ? 143 : 130
    void stop(context)
  }]))
  for (const [signal, handler] of signals) process.on(signal, handler)
  pi.on('session_shutdown', async () => {
    await close()
    for (const [signal, handler] of signals) process.removeListener(signal, handler)
  })
  return { close, get controller() { return controller } }
}
module.exports = { NAMES, privateState, openController, parameters, openAIResponseFormat, openAIOutputCap, bindOpenAIResponseFormat, failureCode, sourceOwnedFailureDiagnostic, install }
