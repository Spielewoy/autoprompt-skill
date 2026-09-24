'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const boundary = require('../../harness-v2-tool-boundary.cjs')
const controlled = require('../../harness-v2-controlled-tools.cjs')
const { readBound, writePrivate, privateDirectory, sha256 } = require('../../../agents/reasonix/workflow/native.js')
const { sanitize } = require('../../harness-v2-vscode-config.cjs')
const { descriptorValid } = require('./event-channel.cjs')
const MIME = 'application/vnd.autoprompt.billed-usage+json'
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error }
const integer = value => Number.isSafeInteger(value) && value >= 0
function usageReceipt(body) {
  const u = body.usage
  if (!u || typeof body.id !== 'string' || !body.id || typeof body.model !== 'string' || !body.model || ![u.prompt_tokens, u.completion_tokens, u.total_tokens].every(integer) || u.total_tokens !== u.prompt_tokens + u.completion_tokens) fail('PROVIDER_USAGE_UNKNOWN', 'Owned BYOK response lacks exact usage and a request identity')
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0
  if (!integer(cached) || cached > u.prompt_tokens || !integer(reasoning) || reasoning > u.completion_tokens) fail('PROVIDER_USAGE_UNKNOWN', 'Owned BYOK usage categories disagree')
  return { requestId: body.id, model: body.model, usage: { input: u.prompt_tokens - cached, cacheRead: cached, cacheWrite: 0, output: u.completion_tokens, reasoning, totalTokens: u.total_tokens }, ...(typeof u.cost === 'number' ? { cost: u.cost } : {}) }
}
function wireMessages(vscode, messages) {
  return messages.flatMap(message => {
    const text = [], calls = [], results = []
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) text.push(part.value)
      else if (part instanceof vscode.LanguageModelToolCallPart) calls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } })
      else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (part.content.some(item => !(item instanceof vscode.LanguageModelTextPart))) fail('TRANSPORT_INVALID', 'Owned tool result must remain text')
        results.push({ role: 'tool', tool_call_id: part.callId, content: part.content.map(item => item.value).join('') })
      } else fail('TRANSPORT_INVALID', 'Owned provider received an unsupported message part')
    }
    if (results.length) { if (text.length || calls.length) fail('TRANSPORT_INVALID', 'Mixed tool result and message content'); return results }
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user'
    return [{ role, content: text.join(''), ...(calls.length ? { tool_calls: calls } : {}) }]
  })
}
function registerProvider(context, vscode, connection, outputSchema) {
  const receipts = new Map()
  const listeners = new Map()
  const provider = {
    provideLanguageModelChatInformation() {
      return [{ id: connection.model, name: `Autoprompt ${connection.model}`, family: connection.model, version: '1', maxInputTokens: 131072, maxOutputTokens: connection.maxTokens, capabilities: { toolCalling: true } }]
    },
    async provideTokenCount() { fail('PROVIDER_USAGE_UNKNOWN', 'Tokenizer estimates are not billed usage; this owned runtime does not request estimates') },
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      const nonce = options.modelOptions?.autopromptRequest
      if (typeof nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(nonce) || receipts.has(nonce) || model.id !== connection.model) fail('PROFILE_INVALID', 'Owned model request has no unique controller identity')
      const abort = new AbortController()
      const cancel = token.onCancellationRequested(() => abort.abort())
      if (token.isCancellationRequested) abort.abort()
      const timer = setTimeout(() => abort.abort(), connection.timeoutMs)
      try {
        const tools = (options.tools || []).map(tool => {
          if (!controlled.decodeToolName('vscode', tool.name)) fail('ROLE_POLICY_DENIED', 'Only private owned tools can be offered')
          return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }
        })
        const key = process.env[connection.apiKeyEnv]
        if (!key) fail('PROFILE_INVALID', 'Owned BYOK provider credential is missing')
        const response = await fetch(`${connection.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, signal: abort.signal,
          body: JSON.stringify({ model: connection.model, messages: wireMessages(vscode, messages), stream: false, max_tokens: connection.maxTokens,
            ...(tools.length ? { tools, tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' } : {}),
            ...(connection.reasoningEffort ? { reasoning: { effort: connection.reasoningEffort } } : {}),
            ...(outputSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'autoprompt_result', strict: true, schema: outputSchema } } } : {}) }),
        })
        if (!response.ok) fail('CHILD_RUNTIME_FAILURE', `Owned BYOK provider returned HTTP ${response.status}`)
        const chunks = []; let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 8 * 1024 * 1024) { abort.abort(); fail('TRANSPORT_LIMIT_EXCEEDED', 'Owned model response exceeds capture limit') }
          chunks.push(Buffer.from(chunk))
        }
        const bytes = Buffer.concat(chunks)
        const body = JSON.parse(bytes)
        const receipt = usageReceipt(body)
        receipts.set(nonce, receipt)
        // The host can reject sendRequest or its returned stream after the
        // provider has already obtained a complete billed response. Deliver
        // that validated receipt directly to the owned session first; progress
        // remains only the normal-path presentation channel.
        listeners.get(nonce)?.(receipt)
        const choice = body.choices?.[0]
        if (!choice || body.choices.length !== 1 || !['stop', 'tool_calls'].includes(choice.finish_reason)) fail('CHILD_RUNTIME_FAILURE', 'Owned model did not finish a complete response')
        progress.report(vscode.LanguageModelDataPart.json(receipt, MIME))
        if (choice.message.content) progress.report(new vscode.LanguageModelTextPart(choice.message.content))
        for (const call of choice.message.tool_calls || []) {
          if (call.type !== 'function' || !controlled.decodeToolName('vscode', call.function?.name)) fail('ROLE_POLICY_DENIED', 'Model requested a foreign tool')
          const args = JSON.parse(call.function.arguments)
          if (!args || typeof args !== 'object' || Array.isArray(args)) fail('TRANSPORT_INVALID', 'Model tool arguments must be an object')
          progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, args))
        }
      } finally { clearTimeout(timer); cancel.dispose() }
    },
  }
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('autoprompt-owned', provider))
  return { receipts, subscribe(nonce, listener) {
    if (typeof listener !== 'function' || listeners.has(nonce)) fail('PROFILE_INVALID', 'Owned receipt listener is invalid')
    listeners.set(nonce, listener)
    return () => listeners.delete(nonce)
  } }
}
function deserialize(vscode, message) {
  const content = message.parts.map(part => {
    if (part.type === 'text') return new vscode.LanguageModelTextPart(part.text)
    if (part.type === 'call') return new vscode.LanguageModelToolCallPart(part.id, part.name, part.args)
    if (part.type === 'result') return new vscode.LanguageModelToolResultPart(part.id, [new vscode.LanguageModelTextPart(part.text)])
    fail('TRANSPORT_INVALID', 'Saved conversation has an invalid part')
  })
  return message.role === 'assistant' ? vscode.LanguageModelChatMessage.Assistant(content) : vscode.LanguageModelChatMessage.User(content)
}
function activateOwned(context, vscode) {
  if (typeof vscode.lm?.registerLanguageModelChatProvider !== 'function' || typeof vscode.LanguageModelDataPart?.json !== 'function') fail('PROVIDER_UNSUPPORTED', 'This VS Code host lacks the stable owned-provider receipt API')
  const file = process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST
  const bytes = readBound(file)
  if (sha256(bytes) !== process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST_SHA256) fail('PROFILE_INVALID', 'Owned VS Code request changed before launch')
  const request = JSON.parse(bytes)
  const connection = sanitize(request.connection)
  if (request.version !== 1 || !connection.model || !path.isAbsolute(request.sessionRoot || '') || !path.isAbsolute(request.targetPath || '') || !descriptorValid(request.eventChannel) || request.outputSchema !== undefined && (!connection.supportsStructuredOutput || !request.outputSchema || typeof request.outputSchema !== 'object' || Array.isArray(request.outputSchema))) fail('PROFILE_INVALID', 'Owned VS Code request is incomplete')
  // Fixed non-protocol markers locate synchronous activation work in extension-host logs.
  // They deliberately contain no request-derived values.
  console.log('AUTOPROMPT_OWNED_SESSION_BEFORE_BOUNDARY_LOAD')
  const prepared = boundary.loadBoundary(request.policyPath, request.policySha256)
  console.log('AUTOPROMPT_OWNED_SESSION_AFTER_BOUNDARY_LOAD')
  console.log('AUTOPROMPT_OWNED_SESSION_BEFORE_CONTROLLED_LOAD')
  controlled.load(prepared, 'vscode')
  console.log('AUTOPROMPT_OWNED_SESSION_AFTER_CONTROLLED_LOAD')
  console.log('AUTOPROMPT_OWNED_SESSION_BEFORE_PROVIDER_REGISTER')
  const receipts = registerProvider(context, vscode, connection, request.outputSchema)
  console.log('AUTOPROMPT_OWNED_SESSION_AFTER_PROVIDER_REGISTER')
  return { eventChannel: request.eventChannel, runOwnedSession: emit => runSession(vscode, request, connection, prepared, receipts, emit) }
}
async function runSession(vscode, request, connection, prepared, receipts, emit) {
  if (typeof emit !== 'function') fail('PROFILE_INVALID', 'Owned VS Code event sink is invalid')
  const sessionId = request.continuationId || `vscode-owned-${crypto.randomUUID()}`
  if (!/^vscode-owned-[a-f0-9-]{36}$/.test(sessionId)) fail('SESSION_ID_MISMATCH', 'Invalid owned continuation')
  const root = path.join(request.sessionRoot, 'owned-sessions', sessionId)
  privateDirectory(root)
  const lock = path.join(root, 'active.lock')
  let lockFd
  try { lockFd = fs.openSync(lock, 'wx', 0o600) } catch { fail('SESSION_BUSY', 'Owned conversation has an active or interrupted reservation') }
  const stateFile = path.join(root, 'conversation.json')
  const binding = { targetPath: request.targetPath, model: connection.model, baseUrl: request.connectionIdentityBaseUrl || connection.baseUrl }
  const persist = state => { const temp = path.join(root, `${crypto.randomUUID()}.tmp`); writePrivate(temp, JSON.stringify(state)); fs.renameSync(temp, stateFile) }
  const cancellation = new vscode.CancellationTokenSource()
  const abort = new AbortController()
  const terminate = () => { cancellation.cancel(); abort.abort() }
  process.once('SIGTERM', terminate); process.once('SIGINT', terminate)
  const deadline = setTimeout(terminate, connection.timeoutMs)
  let eventDelivery = Promise.resolve()
  const report = event => {
    const delivery = eventDelivery = eventDelivery.then(() => emit(event))
    // Usage receipts arrive through a synchronous VS Code callback. Retain
    // the rejection for the explicit await below, while marking it handled
    // immediately so a failed channel cannot become an unrelated unhandled
    // rejection before the model stream yields its next part.
    delivery.catch(() => {})
    return delivery
  }
  try {
    let state
    if (request.continuationId) {
      state = JSON.parse(readBound(stateFile))
      if (state.sessionId !== sessionId || JSON.stringify(state.binding) !== JSON.stringify(binding) || state.status !== 'complete') fail('SESSION_ID_MISMATCH', 'Owned continuation differs from its completed context')
    } else state = { version: 1, sessionId, binding, messages: [], status: 'new' }
    if (!Array.isArray(state.messages) || state.messages.length > 1024) fail('TRANSPORT_LIMIT_EXCEEDED', 'Owned conversation exceeds its bounded context')
    state.status = 'running'
    if (!state.messages.length) state.messages.push({ role: 'user', parts: [{ type: 'text', text: request.prompt }] })
    else state.messages[0] = { role: 'user', parts: [{ type: 'text', text: request.prompt }] }
    state.messages.push({ role: 'user', parts: [{ type: 'text', text: request.input }] })
    persist(state)
    await report({ type: 'owned.session', sessionId, contextKind: 'autoprompt-extension', extensionHostVersion: vscode.version })
    const models = await vscode.lm.selectChatModels({ vendor: 'autoprompt-owned', id: connection.model })
    if (models.length !== 1) fail('PROVIDER_UNSUPPORTED', 'Owned LM provider was not registered in the actual extension host')
    const tools = (prepared.policy.toolFree === true ? [] : boundary.TOOLS).map(tool => ({ name: controlled.toolName('vscode', tool.name), description: tool.description, inputSchema: tool.inputSchema }))
    for (let step = 0; step < connection.maxSteps; step++) {
      if (abort.signal.aborted) fail('CHILD_CANCELLED', 'Owned conversation cancelled')
      const nonce = crypto.randomUUID()
      const parts = []; let receipt
      const acceptReceipt = candidate => {
        if (receipt && JSON.stringify(receipt) !== JSON.stringify(candidate)) fail('PROVIDER_USAGE_UNKNOWN', 'Duplicate owned usage receipt')
        if (!receipt) { receipt = candidate; report({ type: 'owned.usage', ...receipt }) }
      }
      const unsubscribe = receipts.subscribe(nonce, acceptReceipt)
      try {
        const response = await models[0].sendRequest(state.messages.map(message => deserialize(vscode, message)), { tools, modelOptions: { autopromptRequest: nonce } }, cancellation.token)
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelDataPart && part.mimeType === MIME) {
            const streamed = JSON.parse(Buffer.from(part.data).toString('utf8'))
            if (JSON.stringify(streamed) !== JSON.stringify(receipts.receipts.get(nonce))) fail('PROVIDER_USAGE_UNKNOWN', 'LM receipt differs from the actual provider response')
            acceptReceipt(streamed)
          } else if (part instanceof vscode.LanguageModelTextPart) parts.push({ type: 'text', text: part.value })
          else if (part instanceof vscode.LanguageModelToolCallPart) parts.push({ type: 'call', id: part.callId, name: part.name, args: part.input })
          else fail('TRANSPORT_INVALID', 'Owned LM returned an unsupported stream part')
        }
        await eventDelivery
        if (!receipt) fail('PROVIDER_USAGE_UNKNOWN', 'LM API omitted the exact owned usage receipt')
      } finally { unsubscribe(); receipts.receipts.delete(nonce) }
      state.messages.push({ role: 'assistant', parts }); persist(state)
      const calls = parts.filter(part => part.type === 'call')
      if (!calls.length) {
        const text = parts.filter(part => part.type === 'text').map(part => part.text).join('')
        let output
        try { output = JSON.parse(text) } catch { fail('CHILD_RESULT_INVALID', 'Owned terminal must be exactly one JSON object') }
        if (!output || typeof output !== 'object' || Array.isArray(output)) fail('CHILD_RESULT_INVALID', 'Owned terminal must be one JSON object')
        state.status = 'complete'; persist(state)
        await report({ type: 'owned.result', output })
        return
      }
      for (const call of calls) {
        if (abort.signal.aborted) fail('CHILD_CANCELLED', 'Owned tool dispatch cancelled')
        const name = controlled.decodeToolName('vscode', call.name)
        if (!name) fail('ROLE_POLICY_DENIED', 'Only controller-owned tools can execute')
        await report({ type: 'owned.tool.start', id: call.id, name: call.name, args: call.args })
        const started = new Date().toISOString()
        let result
        try { const current = boundary.loadBoundary(prepared.policyPath, prepared.policySha256); result = await boundary.executeTool(current.policy, name, call.args, { signal: abort.signal, controlRoot: current.root }) }
        catch (error) { const output = `${error.code || 'TOOL_FAILED'}: ${error.message}`; result = { tool: name, status: 'failed', exitCode: null, output, outputSha256: sha256(output), code: error.code || 'TOOL_FAILED' } }
        boundary.appendReceipt(prepared, name, call.args, result, started)
        const text = JSON.stringify(result)
        await report({ type: 'owned.tool.end', id: call.id, output: text, error: result.status !== 'completed' })
        state.messages.push({ role: 'user', parts: [{ type: 'result', id: call.id, text }] }); persist(state)
      }
    }
    fail('CHILD_RESULT_MISSING', 'Owned conversation reached its bounded step limit')
  } catch (error) {
    try { await report({ type: 'owned.error', code: error.code || 'CHILD_RUNTIME_FAILURE', message: error.message }) } catch {}
    throw error
  }
  finally {
    clearTimeout(deadline); process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate)
    cancellation.dispose(); fs.closeSync(lockFd); fs.unlinkSync(lock)
  }
}
module.exports = { activateOwned, usageReceipt, wireMessages }
