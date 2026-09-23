'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  CONTROLLED_CAPABILITIES, CONTROLLED_NATIVE_TOOLS, CONTROLLED_PROXY, CONTROLLED_SERVER, CONTROLLED_TOOLS, ReasonixError, inside, nativeUsage, parseTerminal, privateDirectory, readBound, renderConfig, renderCredentials, sha256, validateNativeTodoWrite, writePrivate,
} = require('./native.js')
const core = require('../../codex/workflow/phase-budget.js')
const { validateJsonSchema } = require('../../codex/workflow/json-schema-validator.js')
const { nativeOutcomeDescriptionProjection } = require('../../../scripts/harness-v2-native-wire-projection.cjs')
const { createQuotaRelay } = require('../../../scripts/harness-v2-quota-relay.cjs')
const { TOOLS, canonicalJson } = require('../../../scripts/harness-v2-tool-boundary.cjs')

function controlledInvocation(name, args) {
  const index = CONTROLLED_CAPABILITIES.indexOf(args.capability_id)
  if (name !== CONTROLLED_PROXY || args.action !== 'call' || index === -1 ||
      Object.keys(args).some(key => !['action', 'capability_id', 'arguments', 'reason'].includes(key)) ||
      (Object.hasOwn(args, 'reason') && typeof args.reason !== 'string') ||
      !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) {
    throw new ReasonixError('ROLE_POLICY_DENIED', 'Only exact calls to the six controller-owned MCP capabilities are permitted')
  }
  // Native v1.30 advertises optional reason metadata. Its call action forwards
  // only arguments; preserve that distinction rather than treating metadata
  // as an executable input or admitting other native capability actions.
  return { name: CONTROLLED_TOOLS[index], args: args.arguments }
}

function missingCapabilityAction(name, args) {
  return name === CONTROLLED_PROXY && !Object.hasOwn(args, 'action') &&
    CONTROLLED_CAPABILITIES.includes(args.capability_id) &&
    Object.keys(args).every(key => ['capability_id', 'arguments', 'reason'].includes(key)) &&
    (!Object.hasOwn(args, 'reason') || typeof args.reason === 'string') &&
    args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
}
const MISSING_ACTION_ERROR = 'unknown action ""; use list, inspect, call, or decline'

// A malformed spelling of one of our six IDs is rejected by native v1.30
// before resolution. Preserve that exact error for a bounded model correction;
// never rewrite the identifier or execute its intended target.
function nativeArgumentRejectionError(name, args) {
  if (missingCapabilityAction(name, args)) return MISSING_ACTION_ERROR
  if (name === CONTROLLED_PROXY && args.action === 'call' &&
      CONTROLLED_CAPABILITIES.some(id => id.replace('/', ':') === args.capability_id) &&
      Object.keys(args).every(key => ['action', 'capability_id', 'arguments', 'reason'].includes(key)) &&
      (!Object.hasOwn(args, 'reason') || typeof args.reason === 'string') &&
      args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)) {
    return `invalid mcp-tool id ${JSON.stringify(args.capability_id)}; want mcp-tool:<server>/<tool>`
  }
  return null
}

// Reasonix v1.30 presents MCP tools through one generic use_capability
// function. Its provider-visible schema permits discovery and does not require
// this controller's call-envelope fields. Project the narrower contract in a
// JSON-tool-calling form; controlledInvocation remains the execution boundary.
function controlledToolProtocolProjection(targetPath, scratchPath) {
  const variants = TOOLS.map(tool => ({
    type: 'object', additionalProperties: false,
    required: ['action', 'capability_id', 'arguments'],
    properties: {
      action: { const: 'call' },
      capability_id: { const: `mcp-tool:${CONTROLLED_SERVER}/${tool.name}` },
      arguments: tool.inputSchema,
      reason: { type: 'string' },
    },
  }))
  const examples = {
    read: { action: 'call', capability_id: `mcp-tool:${CONTROLLED_SERVER}/read`, arguments: { path: targetPath, startLine: 1, lineCount: 200 } },
    list: { action: 'call', capability_id: `mcp-tool:${CONTROLLED_SERVER}/list`, arguments: { path: targetPath } },
    search: { action: 'call', capability_id: `mcp-tool:${CONTROLLED_SERVER}/search`, arguments: { path: targetPath, text: 'needle', maxResults: 20 } },
    write: { action: 'call', capability_id: `mcp-tool:${CONTROLLED_SERVER}/write`, arguments: { path: path.join(scratchPath, 'note.txt'), content: 'note' } },
    edit: { action: 'call', capability_id: `mcp-tool:${CONTROLLED_SERVER}/edit`, arguments: { path: path.join(scratchPath, 'note.txt'), oldText: 'old', newText: 'new', replaceAll: false } },
    bash: { action: 'call', capability_id: `mcp-tool:${CONTROLLED_SERVER}/bash`, arguments: { command: 'pwd', cwd: targetPath, timeoutMs: 300000 } },
  }
  return [
    'REQUIRED use_capability WIRE CONTRACT: every use_capability call must be one complete JSON value accepted by this closed schema. action, capability_id, and arguments are all required. action must literally be "call". Never omit action; never use action "list", "inspect", or "decline"; never invent a catalog capability_id.',
    JSON.stringify({ oneOf: variants }),
    'Canonical valid call shapes (choose the matching operation and replace only its allowed arguments):',
    JSON.stringify(examples),
  ]
}

function controlledOutput(tool) {
  if (!tool.err) return tool.output
  // Native v1.30 wraps an MCP isError result twice. Accept only its exact
  // envelope, then verify the unchanged inner result against the private
  // journal. Never search for a JSON-looking substring or discard suffixes.
  const prefix = 'plugin tool reported error: '
  if (typeof tool.err !== 'string' || !tool.err.startsWith(prefix)) {
    throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native failure has no complete controller result')
  }
  const output = tool.err.slice(prefix.length)
  if (tool.output !== `error: ${tool.err}\n${output}`) {
    throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native failure changed the controller result envelope')
  }
  return output
}
function nativeTodoAcknowledgement(args, tool) {
  if (tool.readOnly !== true) throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix native todo_write must remain read-only')
  const output = typeof tool.output === 'string' ? tool.output : ''
  if (Buffer.byteLength(output) > 4096) throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Reasonix native todo_write acknowledgement is oversized')
  if (tool.err) return { output, failed: true }
  const match = /^Todos updated: (\d+) total — (\d+) completed, (\d+) in progress, (\d+) pending\.$/.exec(output)
  if (!match) throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Reasonix native todo_write acknowledgement is invalid')
  const expected = [args.todos.length, args.todos.filter(todo => todo.status === 'completed').length, args.todos.filter(todo => todo.status === 'in_progress').length, args.todos.filter(todo => todo.status === 'pending').length]
  if (match.slice(1).some((value, index) => Number(value) !== expected[index])) throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Reasonix native todo_write acknowledgement differs from dispatched todos')
  return { output, failed: false }
}

// Reasonix's reviewed OpenAI provider route is exactly base_url followed by
// /chat/completions.  A reservation-private connection may not retain a
// request/chat override or a second provider that could evade the relay.
function reasonixQuotaConnection(connection, record) {
  const requested = record.assignment?.model || connection.default_model
  if (typeof requested !== 'string' || !requested || !Array.isArray(connection.providers)) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix quota execution requires one explicit selected provider model')
  }
  const modelNames = provider => [provider.model, ...(Array.isArray(provider.models) ? provider.models : [])]
    .filter(value => typeof value === 'string')
  const providers = connection.providers.filter(provider => provider && typeof provider === 'object' && typeof provider.name === 'string')
  // Mirror v1.30 Config.ResolveModel: first a provider/model reference, then
  // a provider name, then the complete requested string as a model. Model
  // IDs such as z-ai/glm-5.3-flash therefore remain valid under a provider
  // named openrouter; a slash alone is not evidence of a provider prefix.
  const slash = requested.indexOf('/')
  const providerModel = slash > 0
    ? providers.filter(provider => provider.name === requested.slice(0, slash) && modelNames(provider).includes(requested.slice(slash + 1)))
    : []
  const namedProvider = providerModel.length ? [] : providers.filter(provider => provider.name === requested)
  const bareModel = providerModel.length || namedProvider.length ? [] : providers.filter(provider => modelNames(provider).includes(requested))
  const selected = providerModel.length ? providerModel : namedProvider.length ? namedProvider : bareModel
  if (selected.length !== 1) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix quota execution could not resolve one configured provider')
  }
  const provider = selected[0]
  if (provider.kind !== 'openai' || typeof provider.base_url !== 'string' || !provider.base_url ||
      Object.hasOwn(provider, 'chat_url') || Object.hasOwn(provider, 'request_url')) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix quota execution requires an OpenAI base_url without route overrides')
  }
  let upstream
  try { upstream = new URL(provider.base_url) } catch { throw new ReasonixError('PROFILE_INVALID', 'Reasonix quota upstream URL is invalid') }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new ReasonixError('PROFILE_INVALID', 'Reasonix quota upstream must be one explicit HTTP base URL')
  }
  const extraBody = provider.extra_body
  if (extraBody !== undefined && (!extraBody || typeof extraBody !== 'object' || Array.isArray(extraBody) ||
      Object.hasOwn(extraBody, 'max_tokens') || Object.hasOwn(extraBody, 'max_completion_tokens') ||
      Object.hasOwn(extraBody, 'max_output_tokens'))) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix quota execution cannot accept an alternate native output-cap field')
  }
  const configuredOutputCap = provider.max_output_tokens
  const initialOutputCap = Math.min(record.providerTokenLimit,
    Number.isSafeInteger(configuredOutputCap) && configuredOutputCap > 0 ? configuredOutputCap : 4096)
  return Object.freeze({
    upstreamBaseUrl: provider.base_url,
    protocol: 'chat-completions',
    project(baseUrl) {
      // v1.30 only emits a Chat Completions output cap when its provider
      // provider's top-level max_output_tokens.  Supply the host allowance as
      // that initial cap; the loopback relay lowers it before admission and
      // forwarding based on this exact request's bounded input.
      return {
        default_model: requested,
        providers: [{ ...provider, base_url: baseUrl, max_output_tokens: initialOutputCap, ...(extraBody ? { extra_body: extraBody } : {}) }],
      }
    },
  })
}

function verifyControlledReceipt(verifier, ...args) {
  // The real server may append the next completed call while the native
  // observer reads the journal. Retry only a refused unstable snapshot; every
  // attempt still runs the unchanged policy, chain, argument and result checks.
  // Truncated, mismatched, replayed or persistently changing data still fails.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return verifier.verify(...args) } catch (error) {
      if (attempt === 2 || error.code !== 'PAYLOAD_INVALID' || error.message !== 'File changed while reading') throw error
    }
  }
}

// Normalize the native wire protocol at the provider boundary. The reviewed
// controller continues to own result schemas, checks, accounting, and recovery.
class ReasonixEventStream {
  constructor(record = {}) {
    this.record = record
    // This accumulator sees only normalized, receipt-verified transport
    // events. The core uses this private context bit to reject lookalike raw
    // native fields that try to erase command evidence.
    this.accumulator = core.createCodexJsonlAccumulator({ ...record, controllerAuthenticatedNativeProjection: true })
    this.hash = require('node:crypto').createHash('sha256')
    this.usage = { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 }
    this.activeTools = new Set()
    this.toolDispatches = new Map()
    this.completedTools = new Set()
    this.receiptVerifier = record.toolBoundary
      ? new (require('../../../scripts/harness-v2-controlled-tools.cjs').ReceiptVerifier)('reasonix', record.toolBoundary) : null
    this.result = null
    this.sawUsage = false
    this.pendingToolObservations = []
    this.toolCount = record.priorToolCallCount || 0
    this.nativeArgumentRejections = 0
  }

  emit(event) { this.accumulator.push(JSON.stringify(event)) }

  push(line) {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new ReasonixError('TRANSPORT_LIMIT_EXCEEDED', 'Reasonix event exceeds the capture limit')
    let event
    try { event = JSON.parse(line) } catch { throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix emitted invalid JSON') }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix event must be an object')
    this.hash.update(`${line}\n`)
    this.record.onTransportActivity?.()
    this.record.onEvent?.(event, line)
    if (this.result) throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix emitted data after its terminal result')
    if (event.kind === 'usage') {
      const delta = nativeUsage(event.usage || {})
      for (const key of Object.keys(this.usage)) {
        this.usage[key] += delta[key]
        if (!Number.isSafeInteger(this.usage[key])) throw new ReasonixError('PROVIDER_USAGE_UNKNOWN', 'Native token total exceeds exact integer accounting')
      }
      this.sawUsage = true
      if (typeof this.record.onUsageDelta === 'function') {
        const verdict = this.record.onUsageDelta(delta, { ...this.usage })
        if (!verdict || verdict.continue !== true) {
          const error = new ReasonixError('BUDGET_EXHAUSTED', 'Scheduler denied continued Reasonix token usage')
          error.usage = { ...this.usage }
          throw error
        }
      }
    }
    if (event.kind === 'tool_dispatch' || event.kind === 'tool_result') {
      if (this.record.providerToolCallLimit === 0) throw new ReasonixError('ROLE_POLICY_DENIED', 'The assigned role does not permit tool calls')
      const tool = event.tool || {}
      if (typeof tool.id !== 'string' || !tool.id) throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix tool event has no identity')
      if (tool.name === 'todo_write' && (tool.readOnly !== true || tool.resolvedName !== undefined || tool.capabilityId !== undefined)) throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix native todo_write identity is invalid')
      if (event.kind === 'tool_dispatch' && tool.partial === true) {
        if (this.receiptVerifier && tool.name !== CONTROLLED_PROXY && tool.name !== 'todo_write') throw new ReasonixError('ROLE_POLICY_DENIED', 'Native builtins and direct tool dispatch are disabled')
        return event
      }
      const refreshed = event.kind === 'tool_dispatch' && tool.refreshed === true
      if (refreshed && !this.receiptVerifier) return event
      const start = event.kind === 'tool_dispatch' && !refreshed
      let args
      try { args = JSON.parse(tool.args || '{}') } catch { throw new ReasonixError('TRANSPORT_INVALID', 'Native tool arguments are invalid') }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ReasonixError('TRANSPORT_INVALID', 'Native tool arguments must be an object')
      if (start) {
        if (this.activeTools.has(tool.id) || this.completedTools.has(tool.id)) throw new ReasonixError('TRANSPORT_INVALID', 'Duplicate native tool dispatch')
        const nativeTodo = tool.name === 'todo_write'
        if (nativeTodo) validateNativeTodoWrite(args)
        const argumentRejection = this.receiptVerifier && nativeArgumentRejectionError(tool.name, args)
        // A native assistant can issue a parallel batch before receiving any
        // argument feedback. Allow that batch and a correction batch, while
        // retaining a finite call limit and exact non-execution acknowledgments.
        if (argumentRejection && ++this.nativeArgumentRejections > 8) throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix exhausted its native argument corrections')
        const invocation = nativeTodo ? { kind: 'nativeTodo', name: tool.name, args }
          : argumentRejection ? { kind: 'nativeArgumentRejection', name: tool.name, args, expectedError: argumentRejection }
            : this.receiptVerifier ? controlledInvocation(tool.name, args) : { name: tool.name, args }
        this.activeTools.add(tool.id)
        this.toolDispatches.set(tool.id, { name: tool.name, args, invocation })
        const attemptedCount = ++this.toolCount
        if (!Number.isSafeInteger(attemptedCount) || attemptedCount < 1) throw new ReasonixError('TRANSPORT_LIMIT_EXCEEDED', 'Reasonix tool count overflowed')
        const evidence = { attemptedCount, continuationId: this.record.continuationId || null, itemIdHash: sha256(tool.id), itemType: tool.name, observedPhase: 'started' }
        if (evidence.continuationId) this.record.onToolCallObserved?.(evidence)
        else this.pendingToolObservations.push(evidence)
        if (attemptedCount > core.codexChildToolCallLimit(this.record)) throw new ReasonixError('CHILD_TOOL_CALL_LIMIT_EXHAUSTED', 'Reasonix child exceeded its transport-enforced tool-call limit')
      } else if (!this.activeTools.has(tool.id)) {
        throw new ReasonixError('TRANSPORT_INVALID', 'Native tool result has no matching dispatch')
      }
      const dispatched = this.toolDispatches.get(tool.id)
      if (!start && (dispatched.name !== tool.name ||
          canonicalJson(dispatched.args) !== canonicalJson(args))) {
        throw new ReasonixError('TRANSPORT_INVALID', 'Native tool result changed the dispatched identity or arguments')
      }
      const invocation = dispatched.invocation
      const nativeTodo = invocation.kind === 'nativeTodo'
      const nativeArgumentRejection = invocation.kind === 'nativeArgumentRejection'
      // v1.30 rejects these exact malformed arguments before any target or
      // execution exists. Observe only that exact failed native attempt so the
      // model can supply the required argument; never infer or execute "call".
      if (nativeArgumentRejection && (tool.readOnly !== true ||
          tool.resolvedName !== undefined || tool.capabilityId !== undefined || tool.execution !== undefined)) {
        throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix argument rejection unexpectedly resolved an executable target')
      }
      if (this.receiptVerifier && !nativeTodo && !nativeArgumentRejection &&
          (tool.resolvedName !== undefined && tool.resolvedName !== invocation.name ||
           tool.capabilityId !== undefined && tool.capabilityId !== dispatched.args.capability_id)) {
        throw new ReasonixError('TRANSPORT_INVALID', 'Native capability resolution changed the controller-owned target')
      }
      if (refreshed) return event
      const name = nativeTodo || nativeArgumentRejection ? invocation.name : this.receiptVerifier ? invocation.name.slice(`mcp__${CONTROLLED_SERVER}__`.length) : invocation.name
      const shell = name === 'bash'
      let output = tool.output || '', exitCode = tool.execution?.exitCode, failed = Boolean(tool.err)
      let preExecutionDenied = false
      if (!start) {
        if (tool.truncated === true || tool.background === true) throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native tool output was truncated or detached')
        if (nativeArgumentRejection) {
          if (tool.err !== invocation.expectedError || output !== `error: ${invocation.expectedError}`) {
            throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Reasonix malformed-argument attempt lacks its exact native rejection')
          }
        } else if (nativeTodo) {
          const acknowledged = nativeTodoAcknowledgement(invocation.args, tool)
          output = acknowledged.output; failed = acknowledged.failed
        } else if (this.receiptVerifier) {
          const verified = verifyControlledReceipt(this.receiptVerifier, invocation.name, invocation.args, controlledOutput(tool), failed)
          if (shell && verified.command !== invocation.args.command) throw new ReasonixError('TOOL_RECEIPT_INVALID', 'Controlled command changed after dispatch')
          output = verified.output; exitCode = verified.exitCode; failed = verified.status === 'failed'
          preExecutionDenied = verified.executionState === 'NOT_STARTED'
        }
        if (shell && !preExecutionDenied && (!failed || this.receiptVerifier) && !Number.isSafeInteger(exitCode)) throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native command must finish in the foreground with complete captured output')
        if (preExecutionDenied && (!shell || !failed || exitCode !== null)) throw new ReasonixError('TOOL_RECEIPT_INVALID', 'Reasonix no-spawn command disposition is inconsistent')
        this.completedTools.add(tool.id)
        this.activeTools.delete(tool.id)
        this.toolDispatches.delete(tool.id)
      }
      const write = nativeTodo || nativeArgumentRejection ? false : this.receiptVerifier ? ['write', 'edit'].includes(name) : !tool.readOnly
      const item = {
        id: tool.id, type: shell ? 'command_execution' : write ? 'file_change' : 'mcp_tool_call',
        status: start ? 'in_progress' : failed ? 'failed' : 'completed',
        ...(shell ? {
          command: invocation.args.command || '',
          ...(preExecutionDenied ? { exit_code: null, controllerReceiptDisposition: 'NOT_STARTED', preExecutionDenied: true }
            : Number.isSafeInteger(exitCode) ? { exit_code: exitCode } : {}),
          aggregated_output: output,
        } : {}),
      }
      this.emit({ type: start ? 'item.started' : preExecutionDenied ? 'item.failed' : 'item.completed', item })
      if (!start && write && !failed && !this.record.readOnly) this.record.onFirstProductSignal?.({ kind: 'PRODUCT_EDIT', evidenceHash: sha256(line) })
    }
    if (event.type === 'result') {
      if (this.activeTools.size || !this.sawUsage || event.is_error || event.subtype !== 'success') {
        throw new ReasonixError('CHILD_RUNTIME_FAILURE', 'Reasonix did not finish with settled tools, exact usage, and a successful terminal result', { subtype: event.subtype, activeTools: this.activeTools.size })
      }
      if (typeof event.session_id !== 'string' || !event.session_id) throw new ReasonixError('SESSION_ID_MISSING', 'Reasonix terminal result has no session identity')
      if (this.record.continuationId && this.record.continuationId !== event.session_id) throw new ReasonixError('SESSION_ID_MISMATCH', 'Reasonix resumed a different session')
      const finalUsage = event.usage
      if (!finalUsage || finalUsage.input_tokens !== this.usage.noncachedInput + this.usage.cachedInput || finalUsage.output_tokens !== this.usage.output || finalUsage.cache_read_input_tokens !== this.usage.cachedInput) throw new ReasonixError('PROVIDER_USAGE_UNKNOWN', 'Native final usage differs from the observed request ledger')
      const output = parseTerminal(event.result)
      this.emit({ type: 'thread.started', thread_id: event.session_id })
      this.record.onSessionIdentified?.(event.session_id, { event, raw: line, occurredAt: new Date().toISOString() })
      for (const evidence of this.pendingToolObservations.splice(0)) this.record.onToolCallObserved?.({ ...evidence, continuationId: event.session_id })
      this.emit({ type: 'item.completed', item: { id: 'reasonix-terminal', type: 'agent_message', text: JSON.stringify(output) } })
      this.emit({ type: 'turn.completed', usage: {
        input_tokens: this.usage.noncachedInput + this.usage.cachedInput,
        cached_input_tokens: this.usage.cachedInput,
        output_tokens: this.usage.output, reasoning_output_tokens: this.usage.reasoning,
      } })
      this.result = output
    }
    return event
  }

  finish() {
    if (!this.result) throw new ReasonixError('CHILD_RESULT_MISSING', 'Reasonix exited without its structured terminal result')
    return { ...this.accumulator.snapshot(), rawOutputHash: this.hash.digest('hex'),
      ...(this.receiptVerifier ? { toolReceiptHashes: this.receiptVerifier.finish() } : {}) }
  }
}

function executableBindingIdentity(binding) {
  if (!binding || typeof binding.path !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256 || '')) {
    throw new ReasonixError('PROVIDER_IDENTITY_MISMATCH', 'Reasonix context requires an exact executable binding')
  }
  return { path: binding.path, sha256: binding.sha256, invocationSha256: binding.invocation?.sha256 || null }
}

function nativeContextRoot(nativeRoot, record, targetPath, executableBinding) {
  if (!record.continuationId) return path.join(nativeRoot, sha256(record.sessionId))
  const saved = JSON.parse(readBound(path.join(nativeRoot, 'contexts', `${sha256(record.continuationId)}.json`)))
  if (saved.sessionId !== record.continuationId || saved.providerRole !== record.providerRole ||
      saved.targetPath !== targetPath || !/^[a-f0-9]{64}$/.test(saved.rootKey || '') ||
      (executableBinding && JSON.stringify(saved.executableBinding) !== JSON.stringify(executableBindingIdentity(executableBinding)))) {
    throw new ReasonixError('SESSION_ID_MISMATCH', 'Continuation differs from its original native role or workspace')
  }
  return path.join(nativeRoot, saved.rootKey)
}

function persistNativeContext(nativeRoot, sessionRoot, record, targetPath, sessionId, executableBinding) {
  const file = path.join(nativeRoot, 'contexts', `${sha256(sessionId)}.json`)
  const saved = { sessionId, providerRole: record.providerRole, targetPath, rootKey: path.basename(sessionRoot),
    ...(executableBinding ? { executableBinding: executableBindingIdentity(executableBinding) } : {}) }
  if (fs.existsSync(file)) {
    if (JSON.stringify(JSON.parse(readBound(file))) !== JSON.stringify(saved)) throw new ReasonixError('SESSION_ID_MISMATCH', 'Native session identity was already bound to another assignment')
  } else writePrivate(file, JSON.stringify(saved))
}

function prepareReasonixBoundary({ nativeRoot, launchRoot, record, targetPath, scratchPath, readOnly, checkerScratch }) {
  const boundary = require('../../../scripts/harness-v2-tool-boundary.cjs')
  const candidate = checkerScratch ? path.resolve(checkerScratch.frozenCandidateRoot) : targetPath
  // Controller state must not be available even through read-only file tools.
  const privateRoot = boundary.physical(nativeRoot)
  for (const root of [candidate, scratchPath]) {
    const physicalRoot = boundary.physical(root)
    if (inside(physicalRoot, privateRoot) || (inside(privateRoot, physicalRoot) && root !== scratchPath)) {
      throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix task roots overlap protected controller state')
    }
  }
  const toolRoot = path.join(launchRoot, 'tools')
  privateDirectory(toolRoot)
  return boundary.prepareBoundary({ provider: 'reasonix', root: toolRoot, policy: {
    schemaVersion: 1, activationId: record.activationId, sessionId: record.sessionId, reservationId: record.reservationId,
    readOnly, toolFree: record.providerToolCallLimit === 0, targetPath: candidate, scratchPath,
    readableRoots: [candidate, scratchPath], writableRoots: readOnly ? [scratchPath] : [candidate, scratchPath],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
}

class ReasonixExecAdapter {
  constructor(options = {}) {
    if (!options.runner?.run || !options.runner?.stop || !options.nativeRoot || !options.connection || !options.executableBinding) {
      throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix transport requires an owned runner, native root, connection, and bound executable')
    }
    Object.assign(this, options)
  }

  async launch(record) {
    const mission = core.validateCanonicalMissionLaunch(record)
    // Native continuation keeps its context, while each physical process has
    // a reservation-scoped identity in the controller's ownership registry.
    const processSessionId = `native-reasonix-${sha256(JSON.stringify([record.sessionId, record.reservationId]))}`
    const binding = this.executableBinding
    const sharedNative = require('../../../scripts/harness-v2-native.cjs')
    // This checks the raw shim, declared package bin and (for Node shims) the
    // interpreter before any continuation state or provider process is used.
    sharedNative.executableInvocation(binding)
    const actualRuntime = sharedNative.runtimeDependencyIdentity(sharedNative.executableRuntimePath(binding), record.environment || process.env, binding.invocation)
    if (!binding.runtimeIdentity || JSON.stringify(actualRuntime) !== JSON.stringify(binding.runtimeIdentity)) {
      throw new ReasonixError('PROVIDER_IDENTITY_MISMATCH', 'Reasonix native dependencies changed after activation')
    }
    const execution = record.physicalExecutionPolicy
    if (!execution || execution.logicalRole !== record.logicalRole || execution.providerRole !== record.providerRole || execution.physicalRole !== record.physicalRole || !['read-only', 'workspace-write'].includes(execution.sandboxMode)) {
      throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix dispatch has no exact physical role policy')
    }
    const targetPath = path.resolve(record.workingDirectory || record.cwd || this.targetPath)
    const readOnly = execution.sandboxMode === 'read-only'
    const sessionRoot = nativeContextRoot(this.nativeRoot, record, targetPath, binding)
    const launchRoot = path.join(sessionRoot, sha256(record.reservationId))
    const checkerScratch = record.checkerScratchBoundary ? this.checkerScratchVerifier?.(record) : null
    if (record.checkerScratchBoundary && !checkerScratch) throw new ReasonixError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'Missing authenticated checker scratch boundary')
    const scratchPath = checkerScratch ? targetPath : path.join(launchRoot, 'scratch')
    if (record.externalLocalBoundary || record.externalOperation) throw new ReasonixError('EXTERNAL_WRITE_BOUNDARY_UNAVAILABLE', 'Reasonix controlled tools support only the assigned candidate and checker scratch')
    const cwd = path.join(sessionRoot, 'cwd')
    privateDirectory(scratchPath)
    privateDirectory(cwd)
    const toolBoundary = prepareReasonixBoundary({ nativeRoot: this.nativeRoot, launchRoot, record, targetPath, scratchPath, readOnly, checkerScratch })
    const schema = core.codexProviderCanonicalOutputSchema(record, JSON.parse(readBound(this.outputSchemaResolver(record)).toString('utf8')))
    const outcomeProjection = nativeOutcomeDescriptionProjection(record, schema)
    const wireSchema = outcomeProjection ? outcomeProjection.wireSchema : schema
    const prompt = this.rolePrompt(record.providerRole)
    const toolFree = toolBoundary.policy.toolFree === true
    const systemPrompt = [prompt, '',
      ...(toolFree ? ['This assignment permits no tool calls, including todo_write. Use only the supplied assignment context.'] : [
      'The external controller owns all dispatch and finalization. Do not start another agent or load skills. Run commands in the foreground and wait for their exit status; do not background commands.',
      `Use ${CONTROLLED_PROXY} with action="call", one exact capability_id below, and the tool input in arguments for all work. Every individual call in a parallel batch must explicitly include action="call"; omitting it is not a shortcut. The only native-tool exception is direct todo_write for a read-only checklist that mirrors the assigned work; it grants no authority and does not replace controller dispatch, checks, or acceptance. Do not call direct MCP names, other native tools, ask, discovery actions, or other capabilities.`,
      'Before changing any files, first call direct todo_write with a concrete checklist of the controller-assigned work. Keep its progress truthful: at most one item may be in_progress; leave later work pending and mark finished items completed. Reasonix requires this native bookkeeping for multi-file changes; the checklist never authorizes dispatch, certifies tests, or overrides the controller assignment.',
      ...controlledToolProtocolProjection(targetPath, scratchPath),
      JSON.stringify(TOOLS.map(tool => ({ capability_id: `mcp-tool:${CONTROLLED_SERVER}/${tool.name}`, description: tool.description, arguments_schema: tool.inputSchema }))),
      ]),
      `The exact workspace for this assignment is ${JSON.stringify(targetPath)}. Use absolute paths or explicitly change the command working directory to this workspace.`,
      `Private temporary check files belong only in ${JSON.stringify(scratchPath)}.`,
      'For every controller bash call, omit cwd unless it is exactly the controller-provided workspace or private scratch absolute path. Never use the native runtime current directory, HOME, configuration, session, or tool-control path as cwd; those are private controller state and are denied.',
      ...core.codexPrivateWorkspaceProjection(record, record.canonicalTargetPath || this.targetPath, targetPath),
      ...core.codexExplicitExternalLocalProjection(record, record.canonicalTargetPath || this.targetPath),
      ...core.codexCheckerScratchProjection(record, record.canonicalTargetPath || this.targetPath, targetPath, checkerScratch),
      'FINAL RESPONSE WIRE FORMAT: your final assistant message must be exactly one JSON object. Its first byte must be "{" and its last byte must be "}". Emit no prose, explanation, label, Markdown fence, or characters before or after that object. The decoded object must satisfy the complete canonical schema below.',
      core.nativeCompactCanonicalOutputContract(record, schema, { omitControllerOwnedDescription: Boolean(outcomeProjection) }),
      outcomeProjection ? 'For this controller-owned outcome schema, omit the top-level description. The controller derives its exact literal from code only after validating every other wire field. If payload.evidenceIds is supplied, use unique nonempty strings identifying evidence you actually consumed (identifiers or actual hashes), never objects or invented evidence.' : '',
      'Return that one JSON object conforming to this result schema:',
      JSON.stringify(wireSchema),
    ].join('\n')
    const home = path.join(launchRoot, 'home')
    const quotaEnabled = record.providerTokenLimit !== undefined
    if (quotaEnabled && (!Number.isSafeInteger(record.providerTokenLimit) || record.providerTokenLimit <= 0)) {
      throw new ReasonixError('BUDGET_CONFIG_INVALID', 'Reasonix quota requires a positive safe token allowance')
    }
    const argv = ['run', '--permission-mode', 'dontAsk', ...(toolFree ? [] : ['--allowed-tools', [...CONTROLLED_TOOLS, ...CONTROLLED_NATIVE_TOOLS].join(',')]), '--output-format', 'stream-json', '--dir', cwd, '--max-steps', '100']
    if (record.assignment?.model) argv.push('--model', record.assignment.model)
    if (record.assignment?.effort) argv.push('--effort', record.assignment.effort)
    if (record.continuationId) argv.push('--resume', record.continuationId)
    const stream = new ReasonixEventStream({ ...record, ...(quotaEnabled ? { onUsageDelta: undefined } : {}), toolBoundary, readOnly, onSessionIdentified: (sessionId, evidence) => {
      persistNativeContext(this.nativeRoot, sessionRoot, record, targetPath, sessionId, binding)
      record.onSessionIdentified?.(sessionId, evidence)
    } })
    let streamError
    let stopPromise
    const stop = error => {
      if (streamError) return
      streamError = error
      stopPromise = Promise.resolve().then(() => this.runner.stop({ sessionId: processSessionId, reason: error.code || 'CHILD_RUNTIME_FAILURE', terminalStatus: 'FAILED' }))
      stopPromise.catch(() => {})
    }
    const input = JSON.stringify({
      mission, missionBinding: record.missionBinding,
      dispatch: core.modelVisibleDispatch(record.dispatch, { canonicalAssignment: Boolean(record.canonicalAssignment), canonicalMission: mission, missionBinding: record.missionBinding }),
      assignment: record.canonicalAssignment,
    })
    const environment = { ...record.environment, ...this.credentialEnvironment,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
      XDG_STATE_HOME: path.join(sessionRoot, 'xdg-state'), XDG_CACHE_HOME: path.join(sessionRoot, 'xdg-cache'),
      REASONIX_HOME: home, REASONIX_STATE_HOME: path.join(sessionRoot, 'state'), REASONIX_CACHE_HOME: path.join(sessionRoot, 'cache') }
    const signal = record.signal || record.abortSignal
    const abort = () => stop(new ReasonixError('CHILD_CANCELLED', 'Reasonix execution was aborted'))
    if (signal?.aborted) throw new ReasonixError('CHILD_CANCELLED', 'Reasonix execution was aborted before launch')
    signal?.addEventListener('abort', abort, { once: true })
    let result, quotaRelay, runnerStarted = false
    try {
      let projectedConnection = this.connection
      if (quotaEnabled) {
        const projection = reasonixQuotaConnection(this.connection, record)
        quotaRelay = await (this.quotaRelayFactory || createQuotaRelay)({ record, upstreamBaseUrl: projection.upstreamBaseUrl, protocol: projection.protocol, onFailure: stop })
        projectedConnection = projection.project(quotaRelay.baseUrl)
      }
      if (signal?.aborted || streamError) throw streamError || new ReasonixError('CHILD_CANCELLED', 'Reasonix execution was aborted during quota preparation')
      writePrivate(path.join(home, 'config.toml'), renderConfig({ connection: projectedConnection, systemPrompt, targetPath, scratchPath, readOnly, checkerScratch: Boolean(checkerScratch), toolBoundary }))
      writePrivate(path.join(home, '.env'), renderCredentials(projectedConnection, environment))
      runnerStarted = true
      const invocation = sharedNative.executableInvocation(binding, argv)
      result = await this.runner.run({
        executable: invocation.executable, argv: invocation.argv, cwd, env: environment, stdin: input, shell: false,
        sessionId: processSessionId, reservationId: record.reservationId,
        onTransportActivity: record.onTransportActivity,
        onStdoutLine: line => {
          // Already-admitted native responses can deliver exact usage while the
          // owned process drains. Preserve the first cancellation/error while
          // still validating those native receipts; terminal success stays
          // forbidden by the streamError check after the runner settles.
          try { stream.push(line) } catch (error) { stop(error) }
        },
      })
    } catch (error) {
      if (runnerStarted) stop(error)
      else streamError ||= error
    } finally {
      signal?.removeEventListener('abort', abort)
      if (quotaRelay) {
        try { await quotaRelay.close() } catch (error) { stop(error) }
      }
    }
    if (stopPromise) {
      let stopped
      try { stopped = await stopPromise } catch (error) {
        if (error && typeof error === 'object' && !error.cause) error.cause = streamError
        throw error
      }
      if (stopped?.drained !== true) throw new ReasonixError('PROCESS_DRAIN_TIMEOUT', 'Reasonix cancellation did not drain its owned process group')
    }
    if (streamError) throw streamError
    if (result?.processOwned !== true || result.exactArgv !== true || result.drained !== true) {
      throw new ReasonixError('PROCESS_DRAIN_TIMEOUT', 'Reasonix child did not prove owned process completion and descendant drain')
    }
    if (result.status !== 0 || result.signal) {
      throw new ReasonixError('CHILD_RUNTIME_FAILURE', 'Reasonix process failed or was cancelled after producing output', { status: result.status, signal: result.signal || null })
    }
    require('../../../scripts/harness-v2-controlled-tools.cjs').assertStopped(toolBoundary)
    const parsed = stream.finish()
    if (quotaRelay) {
      const authoritative = quotaRelay.snapshot().cumulative
      if (Object.keys(authoritative).some(key => parsed.usage[key] !== authoritative[key])) {
        throw new ReasonixError('PROVIDER_USAGE_UNKNOWN', 'Reasonix native terminal usage differs from the owned provider receipt')
      }
      parsed.usage = authoritative
    }
    let canonicalOutput = parsed.output
    if (outcomeProjection) {
      try { canonicalOutput = outcomeProjection.toCanonical(parsed.output) } catch (error) {
        if (error?.code === 'NATIVE_WIRE_PROJECTION_INVALID') {
          throw new ReasonixError('CHILD_RESULT_INVALID', error.message, error.details)
        }
        throw error
      }
    }
    const validation = validateJsonSchema(schema, canonicalOutput)
    if (!validation.valid) throw new ReasonixError('CHILD_RESULT_INVALID', 'Reasonix result does not match its canonical schema', { errors: validation.errors })
    const output = core.checkerResultBoundToCommandExecutionEvidence(canonicalOutput, parsed, record)
    const transportEvidence = outcomeProjection
      ? { ...core.codexTransportEvidence(parsed), nativeWireProjection: outcomeProjection.metadata }
      : core.codexTransportEvidence(parsed)
    const assembled = {
      ...output, candidateHash: record.candidateHash || output.candidateHash || null,
      contextId: parsed.sessionId, transportEvidence,
      toolReceiptHashes: parsed.toolReceiptHashes,
      usage: parsed.usage, usageStreamed: typeof record.onUsageDelta === 'function',
      evidenceHashes: output.evidenceHashes || [],
      recommendation: output.recommendation || (record.logicalRole === 'route-analyst' ? output : null), completionRequested: true,
    }
    const final = record.normalizeTerminalResult ? record.normalizeTerminalResult(assembled) : assembled
    record.onTerminalResult?.(final, { rawOutputHash: parsed.rawOutputHash, eventStreamHash: parsed.eventStreamHash, sessionId: parsed.sessionId, ...(outcomeProjection ? { nativeWireProjection: outcomeProjection.metadata } : {}) })
    return final
  }
}

module.exports = { ReasonixEventStream, ReasonixExecAdapter, controlledToolProtocolProjection, nativeContextRoot, persistNativeContext, prepareReasonixBoundary, reasonixQuotaConnection }
