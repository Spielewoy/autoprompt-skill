'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const controlled = require('../../scripts/harness-v2-controlled-tools.cjs')
const { validateJsonSchema } = require('../../agents/codex/workflow/json-schema-validator.js')
const { HarnessEventStream, exactUsage, contextRoot, persistContext, ROUTE_ADVISORY_WIRE_SCHEMA, routeAdvisoryProjection, materializeRouteAdvisory, compactRouteAdvisoryContract } = require('../../scripts/harness-v2-transport.cjs')
const { ReasonixEventStream } = require('../../agents/reasonix/workflow/transport.js')
const PROVIDERS = ['claude', 'opencode', 'kilo', 'prime', 'omp']
const expected = { noncachedInput: 13, cachedInput: 2, output: 4, reasoning: 1 }
function usage(provider) {
  if (provider === 'claude') return { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 1 }
  if (['opencode', 'kilo'].includes(provider)) return { input: 10, cache: { read: 2, write: 3 }, output: 3, reasoning: 1 }
  return { input: 10, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 1, totalTokens: 19 }
}
// Wire fixtures test the adapter, not a provider binary or live-model conformance.
function events(provider, text = '{"ok":true}') {
  const session = 'session-fixture-1'
  if (provider === 'claude') return [
    { type: 'system', subtype: 'init', session_id: session },
    { type: 'stream_event', session_id: session, event: { type: 'message_start', message: {
      role: 'assistant', id: 'request-1', usage: { ...usage(provider), output_tokens: 0, reasoning_output_tokens: 0 },
    } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', session_id: session, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 4, reasoning_output_tokens: 1 } } },
    { type: 'stream_event', session_id: session, event: { type: 'message_stop' } },
    { type: 'assistant', session_id: session, message: { role: 'assistant', id: 'request-1', usage: usage(provider), content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: session, usage: usage(provider), result: text },
  ]
  if (['opencode', 'kilo'].includes(provider)) {
    const base = { sessionID: session, messageID: 'request-1' }
    return [
      { type: 'step_start', sessionID: session, part: { ...base, id: 'start-1', type: 'step-start' } },
      { type: 'text', sessionID: session, part: { ...base, id: 'text-1', type: 'text', text, time: { end: 2 } } },
      { type: 'step_finish', sessionID: session, part: { ...base, id: 'finish-1', type: 'step-finish', reason: 'stop', tokens: usage(provider) } },
    ]
  }
  const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: usage(provider),
    ...(provider === 'prime' ? { responseId: 'prime-response-fixture-1' } : {}) }
  return [{ type: 'session', id: session }, { type: 'agent_start' }, { type: 'turn_start' },
    { type: 'message_end', message }, { type: 'turn_end', message }, { type: 'agent_end', messages: [message] }]
}
function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-native-unit-'))
  t.after(() => fs.rmSync(value, { recursive: true, force: true }))
  return value
}
function pushAll(stream, records) { for (const event of records) stream.push(JSON.stringify(event)); return stream.finish() }

function deepseekStructuredEvents({ value = { canonicalJson: '{"ok":true}' }, acknowledgement = { recorded: true }, after = [] } = {}) {
  const sessionId = 'deepseek-structured-session'
  const usage = { inputTokens: 13, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 1, totalTokens: 19 }
  const event = (seq, type, data) => ({ type: 'deepseek', method: 'session.event', params: { sessionId, event: { seq, type, data } } })
  let seq = 0
  const records = [
    { type: 'deepseek', method: 'session.status', params: { sessionId, status: 'running' } },
    event(seq++, 'turn/start', { turn: 1 }),
    event(seq++, 'step/start', { turn: 1, step: 1 }),
    event(seq++, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage } }),
    event(seq++, 'assistant/message', { turn: 1, step: 1, interrupted: false, message: { role: 'assistant', content: [] }, usage }),
  ]
  const callId = 'deepseek-structured-call'
  records.push(event(seq++, 'tool/call', { turn: 1, step: 1, callId, name: 'autoprompt_structured_output', arguments: JSON.stringify(value) }))
  records.push(event(seq++, 'tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(acknowledgement) }] }] } }))
  for (const item of after) records.push(event(seq++, item.type, { turn: 1, step: 1, ...item.data }))
  records.push(event(seq++, 'step/end', { turn: 1, step: 1 }))
  records.push(event(seq++, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  records.push({ type: 'deepseek', method: 'session.status', params: { sessionId, status: 'idle' } })
  return records
}

function claudeStructuredEvents({ value = { ok: true }, terminal = value, duplicate = false } = {}) {
  const session = 'claude-structured-session'
  const request = 'claude-structured-request'
  const call = 'claude-structured-call'
  const total = usage('claude')
  const content = [{ type: 'tool_use', id: call, name: 'StructuredOutput', input: value }]
  if (duplicate) content.push({ type: 'tool_use', id: 'duplicate-structured-call', name: 'StructuredOutput', input: value })
  return [
    { type: 'system', subtype: 'init', session_id: session },
    { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { role: 'assistant', id: request, usage: { ...total, output_tokens: 0, reasoning_output_tokens: 0 } } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: call, name: 'StructuredOutput', input: {} } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(value) } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', session_id: session, event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4, reasoning_output_tokens: 1 } } },
    { type: 'stream_event', session_id: session, event: { type: 'message_stop' } },
    { type: 'assistant', session_id: session, message: { role: 'assistant', id: request, usage: total, content } },
    { type: 'user', session_id: session, message: { content: content.map(block => ({ type: 'tool_result', tool_use_id: block.id, is_error: false, content: [{ type: 'text', text: 'Structured output recorded.' }] })) } },
    { type: 'result', subtype: 'success', is_error: false, session_id: session, usage: total, structured_output: terminal, result: JSON.stringify(terminal) },
  ]
}

function routeAdvisory(route) {
  return {
    preWorkResult: 'CONTINUE', recommendedRoute: route, confidence: 'medium',
    whatTheUserWants: ['Complete the requested local change.'], likelyAreas: ['The named workspace files.'],
    howSuccessCanBeChecked: ['Run the focused local verification.'], unknowns: ['Inspect the current implementation first.'], risks: ['Preserve unrelated behavior.'],
    independentWorkItems: route === 'ROADMAP' ? ['Update surface A.', 'Integrate surface B.'] : [],
    dependencies: route === 'ROADMAP' ? ['Integrate B after A.'] : [],
    reasonsForDirect: ['One worker is sufficient only when the target remains bounded.'],
    reasonsForLight: ['Short planning is useful when reversible implementation uncertainty remains.'],
    reasonsForRoadmap: ['Coordination is useful when dependent groups cross the integration boundary.'],
    userInputNeeded: [],
    routeSignals: {
      requestedEffect: 'mutate', dependencyShape: route === 'ROADMAP' ? 'dependent-groups' : route === 'LIGHT' ? 'connected' : 'bounded',
      dependentWorkGroupCount: route === 'ROADMAP' ? 2 : 0, integrationOwnerRequired: route === 'ROADMAP',
      uncertainty: route === 'ROADMAP' ? 'architecture' : route === 'LIGHT' ? 'reversible-technical' : 'none',
      reversibility: 'locally-reversible', riskLevel: route === 'ROADMAP' ? 'elevated' : 'ordinary',
      architectureImpact: route === 'ROADMAP' ? 'multi-system' : route === 'LIGHT' ? 'single-system' : 'local',
      fitsLightPlan: route !== 'ROADMAP', approachNeedsShortPlanning: route !== 'DIRECT', shortOrderUnclear: route !== 'DIRECT',
    },
  }
}

test('route advisory wire preserves every route selector while rebuilding and validating the canonical recommendation', () => {
  const schema = require('../../agents/contracts/schemas/route-recommendation.schema.json')
  assert.ok(routeAdvisoryProjection({ logicalRole: 'route-analyst' }, schema, 'kilo'))
  assert.equal(routeAdvisoryProjection({ logicalRole: 'route-analyst' }, schema, 'prime'), null, 'providers without a proven zero-tool launch retain canonical wire')
  for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) {
    const advisory = routeAdvisory(route)
    assert.equal(validateJsonSchema(ROUTE_ADVISORY_WIRE_SCHEMA, advisory).valid, true)
    const canonical = materializeRouteAdvisory(advisory)
    assert.equal(canonical.recommendedRoute, route)
    assert.equal(canonical.routeFactProposal.dependencyShape, advisory.routeSignals.dependencyShape)
    assert.deepEqual(canonical.independentWorkItems, advisory.independentWorkItems)
    assert.equal(validateJsonSchema(schema, canonical).valid, true)
    const decision = require('../../agents/codex/workflow/route-decision.js').compileAutomaticRouteDecision({
      recommendation: canonical, requestedResult: 'Complete the requested change.', requestEnvelopeHash: 'a'.repeat(64),
      providerCapabilities: { sameContextContinuation: true, isolatedChecking: true, stableChildIdentity: true },
      budget: { remaining: { wallMs: 3600000 } }, nowMs: 1,
    })
    assert.equal(decision.route, route, 'semantic signals determine the compiled route, not a fabricated direct fallback')
  }
})

test('compact route prompt has bounded overhead and accepts a complete response inside the 8k envelope', () => {
  const schema = require('../../agents/contracts/schemas/route-recommendation.schema.json')
  const prompt = compactRouteAdvisoryContract(routeAdvisoryProjection({ logicalRole: 'route-analyst' }, schema, 'kilo'))
  assert.ok(Buffer.byteLength(prompt) < 3000)
  for (const field of Object.keys(ROUTE_ADVISORY_WIRE_SCHEMA.properties)) assert.ok(prompt.includes(field))
  for (const field of Object.keys(ROUTE_ADVISORY_WIRE_SCHEMA.properties.routeSignals.properties)) assert.ok(prompt.includes(field))
  // A conservative byte envelope covers the serialized native fixed overhead,
  // two messages and the provider's response, before any tokenizer assumption.
  const body = { model: 'fixture', messages: [{ role: 'system', content: 'x'.repeat(2400) + prompt }, { role: 'user', content: 'x'.repeat(1400) }], max_tokens: 2048 }
  const quota = require('../../scripts/harness-v2-request-quota.cjs').createRequestQuota({
    record: { providerTokenLimit: 8000, onProviderRequestStarted() {}, onProviderRequestSettled() {}, onUnknownProviderSpend() {}, onUsageDelta() { return { continue: true } } },
    protocol: 'chat-completions', maxOutputField: 'max_tokens', expectedModel: 'fixture',
  })
  const admitted = quota.admit({ body, rawBody: JSON.stringify(body), cumulative: {} })
  assert.ok(admitted.snapshot.cappedOutput >= 1500)
  const response = routeAdvisory('ROADMAP')
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= admitted.snapshot.cappedOutput)
  assert.equal(validateJsonSchema(schema, materializeRouteAdvisory(response)).valid, true)
})

test('route advisory wire rejects malformed routing fields and parser denies every tool dispatch', () => {
  const malformed = routeAdvisory('LIGHT')
  malformed.routeSignals.dependencyShape = 'unbounded'
  assert.equal(validateJsonSchema(ROUTE_ADVISORY_WIRE_SCHEMA, malformed).valid, false)
  assert.throws(() => materializeRouteAdvisory(malformed), { code: 'CHILD_RESULT_INVALID' })
  for (const mutate of [
    value => { value.routeSignals.extra = true },
    value => { value.unknowns = ['é'.repeat(257)] },
    value => { value.likelyAreas = ['a', 'b', 'c'] },
    value => { value.preWorkResult = 'NEEDS_USER' },
    value => { value.recommendedRoute = null },
  ]) {
    const invalid = routeAdvisory('DIRECT'); mutate(invalid)
    assert.throws(() => materializeRouteAdvisory(invalid), { code: 'CHILD_RESULT_INVALID' })
  }
  const needsUser = routeAdvisory('DIRECT')
  Object.assign(needsUser, { preWorkResult: 'NEEDS_USER', recommendedRoute: null, userInputNeeded: ['Which target is authorized?'] })
  assert.equal(materializeRouteAdvisory(needsUser).preWorkResult, 'NEEDS_USER')
  const stream = new HarnessEventStream('kilo', { toolFree: true })
  assert.throws(() => stream.startTool('route-tool-1', 'read', {}), { code: 'ROLE_POLICY_DENIED' })
})

test('DeepSeek schema terminal accepts one acknowledged value and refuses malformed output', () => {
  const schema = { type: 'object', properties: { canonicalJson: { type: 'string' } }, required: ['canonicalJson'], additionalProperties: false }
  const parsed = pushAll(new HarnessEventStream('deepseek', { deepseekStructuredOutputSchema: schema }), deepseekStructuredEvents())
  assert.deepEqual(parsed.output, { canonicalJson: '{"ok":true}' })
  assert.throws(() => pushAll(new HarnessEventStream('deepseek', { deepseekStructuredOutputSchema: schema }),
    deepseekStructuredEvents({ value: { wrong: true } })), { code: 'CHILD_RESULT_INVALID' })
  assert.throws(() => pushAll(new HarnessEventStream('deepseek', { deepseekStructuredOutputSchema: schema }),
    deepseekStructuredEvents({ acknowledgement: { recorded: false } })), { code: 'CHILD_RESULT_INVALID' })
  for (const data of [
    { callId: 'duplicate-terminal', name: 'autoprompt_structured_output', arguments: JSON.stringify({ canonicalJson: '{"ok":true}' }) },
    { callId: 'late-read', name: 'read', arguments: '{}' },
  ]) {
    assert.throws(() => pushAll(new HarnessEventStream('deepseek', { deepseekStructuredOutputSchema: schema }),
      deepseekStructuredEvents({ after: [{ type: 'tool/call', data }] })), { code: 'TRANSPORT_INVALID' })
  }
  let sequence = 0
  const missing = deepseekStructuredEvents().filter(frame => !['tool/call', 'tool/result'].includes(frame.params?.event?.type)).map(frame => {
    if (!frame.params?.event) return frame
    return { ...frame, params: { ...frame.params, event: { ...frame.params.event, seq: sequence++ } } }
  })
  assert.throws(() => pushAll(new HarnessEventStream('deepseek', { deepseekStructuredOutputSchema: schema }), missing), { code: 'CHILD_RESULT_MISSING' })
})

test('Claude schema terminal accepts one acknowledged value and refuses malformed or late output', () => {
  const schema = { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }
  const parsed = pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), claudeStructuredEvents())
  assert.deepEqual(parsed.output, { ok: true })
  const enforced = claudeStructuredEvents()
  const acknowledgement = enforced.findIndex(event => event.type === 'user')
  enforced.splice(acknowledgement, 0, {
    type: 'user', session_id: 'claude-structured-session', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.' }] },
  })
  assert.deepEqual(pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), enforced).output, { ok: true })
  const alteredEnforcement = structuredClone(enforced)
  alteredEnforcement[acknowledgement].message.content[0].text = '[structured-output-enforce] altered'
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), alteredEnforcement), { code: 'TRANSPORT_INVALID' })
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }),
    claudeStructuredEvents({ value: { ok: false } })), { code: 'CHILD_RESULT_INVALID' })
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }),
    claudeStructuredEvents({ duplicate: true })), { code: 'TRANSPORT_INVALID' })

  const lateTool = claudeStructuredEvents()
  lateTool.find(event => event.type === 'assistant').message.content.push({
    type: 'tool_use', id: 'late-read', name: 'Read', input: { file_path: '/fixture' },
  })
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), lateTool), { code: 'TRANSPORT_INVALID' })

  const mismatchedTerminal = claudeStructuredEvents({ terminal: { ok: false } })
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), mismatchedTerminal), { code: 'CHILD_RESULT_MISSING' })
  const missingTerminal = claudeStructuredEvents()
  delete missingTerminal.at(-1).structured_output
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), missingTerminal), { code: 'CHILD_RESULT_MISSING' })
})

test('Claude retries native-rejected structured output with bounded identities and complete usage', () => {
  const schema = { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }
  const sequence = (rejections, reuseId = false) => {
    const result = []
    for (let index = 0; index <= rejections; index++) {
      const attempt = JSON.parse(JSON.stringify(claudeStructuredEvents({ value: index < rejections ? { result: { ok: true } } : { ok: true } }))
        .replaceAll('claude-structured-request', `request-${index}`)
        .replaceAll('claude-structured-call', `call-${reuseId ? 0 : index}`))
      if (index > 0) attempt.shift()
      if (index < rejections) {
        const receipt = attempt.find(event => event.type === 'user').message.content[0]
        receipt.is_error = true
        receipt.content = 'Output does not match required schema: root: must have required property ok'
        attempt.pop()
      } else {
        attempt.at(-1).usage = Object.fromEntries(Object.entries(usage('claude')).map(([key, value]) => [key, value * (rejections + 1)]))
      }
      result.push(...attempt)
    }
    return result
  }
  for (const rejections of [1, 2, 3]) {
    const parsed = pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), sequence(rejections))
    assert.deepEqual(parsed.output, { ok: true })
    assert.deepEqual(parsed.usage, Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value * (rejections + 1)])))
  }
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), sequence(1, true)), { code: 'TRANSPORT_INVALID' })
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), sequence(4)), { code: 'CHILD_RESULT_INVALID' })
  const missingCorrection = sequence(1)
  const firstReceipt = missingCorrection.findIndex(event => event.type === 'user')
  missingCorrection.splice(firstReceipt + 1, missingCorrection.length, { ...claudeStructuredEvents().at(-1), structured_output: { result: { ok: true } } })
  assert.throws(() => pushAll(new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema }), missingCorrection), { code: 'CHILD_RESULT_MISSING' })
})

test('OpenCode and Kilo decode one unambiguous labelled JSON terminal envelope', () => {
  for (const provider of ['opencode', 'kilo']) {
    const parsed = pushAll(new HarnessEventStream(provider), events(provider, '\n```json\n{"ok":true}\n```\n'))
    assert.deepEqual(parsed.output, { ok: true })
    assert.deepEqual(parsed.usage, expected)
    for (const text of [
      'Summary.\n```json\n{"ok":true}\n```',
      'All tests pass. `report.test.cjs` is unchanged. Here is the final result:\n\n```json\n{"ok":true}\n```',
      '```json\n{"ok":true}\n```\nFinal report above.',
    ]) {
      const introduced = pushAll(new HarnessEventStream(provider), events(provider, text))
      assert.deepEqual(introduced.output, { ok: true })
      assert.deepEqual(introduced.usage, expected)
    }
    for (const text of [
      '{"ok":false}\n```json\n{"ok":true}\n```',
      '```json\n{"ok":true}\n```\n[false]',
      '```text\nother block\n```\n```json\n{"ok":true}\n```',
      '```json\n{"ok":true}\n```\n```json\n{"ok":false}\n```',
      '```\n{"ok":true}\n```',
      '```json\n[1,2]\n```',
      '```json\n{"ok":true} {"ok":false}\n```',
    ]) assert.throws(() => pushAll(new HarnessEventStream(provider), events(provider, text)), { code: 'CHILD_RESULT_INVALID' })
    // Decoding the presentation never makes a malformed canonical value pass.
    const wrong = pushAll(new HarnessEventStream(provider), events(provider, 'Success: ok is true.\n```json\n{"ok":false}\n```'))
    assert.equal(validateJsonSchema({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }, wrong.output).valid, false)
  }
})

test('OMP completion-time decoration does not hide changed message content or usage', () => {
  const decorated = events('omp').map(event => structuredClone(event))
  decorated[3] = { ...decorated[3], message: { ...decorated[3].message, completedAt: 1788816247866 } }
  assert.deepEqual(pushAll(new HarnessEventStream('omp'), decorated).output, { ok: true })
  for (const change of [
    message => { message.content[0].text = '{"ok":false}' },
    message => { message.usage.input++ },
    message => { message.stopReason = 'toolUse' },
    message => { message.provider = 'different-provider' },
  ]) {
    const changed = structuredClone(decorated)
    change(changed[4].message)
    assert.throws(() => pushAll(new HarnessEventStream('omp'), changed), { code: 'TRANSPORT_INVALID' })
  }
  decorated[3].message.completedAt = 'not-a-timestamp'
  assert.throws(() => pushAll(new HarnessEventStream('omp'), decorated), { code: 'TRANSPORT_INVALID' })
})

for (const provider of PROVIDERS) {
  test(`${provider}: complete native wire retains exact usage, session, output and hashes`, () => {
    const debits = [], observed = []
    const stream = new HarnessEventStream(provider, { onUsageDelta: delta => { debits.push(delta); return { continue: true } }, onEvent: e => observed.push(e) })
    const parsed = pushAll(stream, events(provider))
    assert.deepEqual(parsed.output, { ok: true })
    assert.deepEqual(parsed.usage, expected)
    assert.equal(parsed.sessionId, 'session-fixture-1')
    assert.equal(parsed.activeWorkSettled, true)
    assert.deepEqual(debits, [expected])
    assert.equal(observed.length, events(provider).length)
    assert.match(parsed.rawOutputHash, /^[a-f0-9]{64}$/)
    assert.match(parsed.eventStreamHash, /^[a-f0-9]{64}$/)
    assert.throws(() => stream.push(JSON.stringify(events(provider)[0])), { code: 'TRANSPORT_INVALID' })
  })
  test(`${provider}: a denied or missing budget verdict stops with already-observed usage`, () => {
    for (const verdict of [{ continue: false }, undefined, false, { continue: 1 }]) {
      const stream = new HarnessEventStream(provider, { onUsageDelta: () => verdict })
      assert.throws(() => pushAll(stream, events(provider)), error => {
        assert.equal(error.code, 'BUDGET_EXHAUSTED')
        assert.deepEqual(error.usage, expected)
        return true
      })
      assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
    }
  })
  test(`${provider}: a result cannot conceal unfinished tools or a different continuation`, () => {
    const incomplete = new HarnessEventStream(provider)
    incomplete.startTool('read-1', 'Read', { file_path: '/fixture' })
    assert.throws(() => pushAll(incomplete, events(provider)))
    const mismatch = new HarnessEventStream(provider, { continuationId: 'different-session' })
    assert.throws(() => mismatch.push(JSON.stringify(events(provider)[0])), { code: 'SESSION_ID_MISMATCH' })
    for (const text of ['not JSON', '[]', 'true', '{} trailing text']) {
      assert.throws(() => pushAll(new HarnessEventStream(provider), events(provider, text)), { code: 'CHILD_RESULT_INVALID' })
    }
  })
  test(`${provider}: tool authority and complete command output are enforced separately from prose`, () => {
    const readonly = new HarnessEventStream(provider, { readOnly: true })
    for (const name of ['Write', 'Edit', 'Agent', 'Task', 'Skill', 'subagent', 'bash']) {
      assert.throws(() => readonly.startTool('denied', name, { command: 'echo not-run' }), { code: 'ROLE_POLICY_DENIED' })
    }
    const command = new HarnessEventStream(provider, { commandBoundary: true })
    command.startTool('command-1', 'bash', { command: 'printf fixture' })
    assert.throws(() => command.finishTool('command-1', 'fixture'), { code: 'TOOL_OUTPUT_INCOMPLETE' })
    assert.throws(() => command.finishTool('command-1', 'fixture', { exitCode: 0, truncated: true }), { code: 'TOOL_OUTPUT_INCOMPLETE' })
    command.finishTool('command-1', 'fixture', { exitCode: 0 })
    assert.throws(() => command.startTool('command-1', 'Read', {}), { code: 'TRANSPORT_INVALID' })
    assert.deepEqual(pushAll(command, events(provider)).output, { ok: true })
  })
  test(`${provider}: missing, estimated, negative and inconsistent native billing are refused`, () => {
    assert.deepEqual(exactUsage(provider, usage(provider)), expected)
    for (const value of [null, {}, { ...usage(provider), estimated: true }, { ...usage(provider), isEstimated: true }, { ...usage(provider), source: 'estimated' }]) {
      assert.throws(() => exactUsage(provider, value), { code: 'PROVIDER_USAGE_UNKNOWN' })
    }
    const invalid = usage(provider)
    invalid[provider === 'claude' ? 'output_tokens' : 'output'] = -1
    assert.throws(() => exactUsage(provider, invalid), { code: 'PROVIDER_USAGE_UNKNOWN' })
  })
}

test('Claude charges a complete message-stop receipt before terminal success', () => {
  let debits = 0
  const stream = new HarnessEventStream('claude', { onUsageDelta: () => ({ continue: ++debits > 1 }) })
  assert.throws(() => pushAll(stream, events('claude')), error => {
    assert.equal(error.code, 'BUDGET_EXHAUSTED'); assert.deepEqual(error.usage, expected); return true
  })
  assert.equal(debits, 1)
  assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
})

test('Claude retains a complete message-stop receipt when its terminal fails or is cancelled', () => {
  for (const subtype of ['error', 'cancelled']) {
    const transcript = events('claude').filter(event => event.type !== 'result')
    transcript.push({ type: 'result', subtype, is_error: true, session_id: 'session-fixture-1', usage: usage('claude') })
    const debits = []
    const stream = new HarnessEventStream('claude', { onUsageDelta: delta => { debits.push(delta); return { continue: true } } })
    assert.throws(() => pushAll(stream, transcript), { code: 'CHILD_RUNTIME_FAILURE' })
    assert.deepEqual(debits, [expected])
    assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
  }
  for (const stopReason of ['max_tokens', 'refusal']) {
    const transcript = events('claude').filter(event => event.type !== 'result')
    transcript.find(event => event.event?.type === 'message_delta').event.delta.stop_reason = stopReason
    const debits = []
    const stream = new HarnessEventStream('claude', { onUsageDelta: delta => { debits.push(delta); return { continue: true } } })
    assert.throws(() => pushAll(stream, transcript), { code: 'CHILD_RUNTIME_FAILURE' })
    assert.deepEqual(debits, [expected])
    assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
  }
})

test('Pi retains exact assistant usage before rejecting failed or aborted completion', () => {
  for (const stopReason of ['aborted', 'error']) {
    const transcript = events('omp')
    transcript.find(event => event.type === 'message_end').message.stopReason = stopReason
    const debits = []
    const stream = new HarnessEventStream('omp', { onUsageDelta: delta => { debits.push(delta); return { continue: true } } })
    assert.throws(() => pushAll(stream, transcript), { code: 'CHILD_RUNTIME_FAILURE' })
    assert.deepEqual(debits, [expected])
    assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
  }
})

test('Claude thinking progress neither changes billing nor permits native delegation', () => {
  const transcript = events('claude')
  transcript.splice(1, 0, { type: 'system', subtype: 'thinking_tokens', thinking_tokens: 9000 })
  assert.deepEqual(pushAll(new HarnessEventStream('claude'), transcript).usage, expected)
  const stream = new HarnessEventStream('claude')
  assert.throws(() => stream.push(JSON.stringify({ type: 'system', subtype: 'thinking_tokens',
    parent_tool_use_id: 'native-child' })), { code: 'ROLE_POLICY_DENIED' })
})

test('Claude accepts only the exact controller heartbeat for an active MCP call', t => {
  const base = root(t), target = path.join(base, 'target'), scratch = path.join(base, 'scratch'), controller = path.join(base, 'controller')
  for (const directory of [target, scratch, controller]) fs.mkdirSync(directory, { mode: 0o700 })
  const prepared = boundary.prepareBoundary({ provider: 'claude', root: controller,
    policy: { provider: 'claude', readOnly: true, targetPath: target, scratchPath: scratch,
      readableRoots: [target, scratch], writableRoots: [scratch], nestedDispatch: false,
      commandBoundary: true, externalWrites: false } })
  const parent = 'fixture-native-read', session = 'heartbeat-session', toolName = controlled.toolName('claude', 'bash')
  const make = () => {
    const stream = new HarnessEventStream('claude', { commandBoundary: true, toolBoundary: prepared })
    stream.session(session, {}, '{}')
    stream.startTool(parent, toolName, { command: 'printf ok' })
    return stream
  }
  const event = overrides => ({ type: 'tool_progress', tool_use_id: `${parent}-heartbeat-0`,
    tool_name: toolName, parent_tool_use_id: parent, elapsed_time_seconds: 30, heartbeat: true,
    session_id: session, uuid: '636eea00-8b93-4929-88d7-5f0bcf05f05f', ...overrides })
  const stream = make()
  const emitted = []
  stream.emit = value => emitted.push(value)
  const state = value => structuredClone({ active: [...value.activeTools], completed: [...value.completedTools],
    usage: { ...value.usage }, requests: [...value.usageByRequest], count: value.toolCount,
    terminal: value.terminal, session: value.sessionId })
  const before = state(stream)
  stream.push(JSON.stringify(event()))
  stream.push(JSON.stringify(event({ tool_use_id: `${parent}-heartbeat-1`, elapsed_time_seconds: 31 })))
  assert.deepEqual(state(stream), before)
  assert.deepEqual(emitted, [])
  assert.equal(stream.claudeHeartbeatCounters.get(parent), 1)
  for (const hostile of [
    event({ tool_use_id: `${parent}-heartbeat-2` }),
    event({ tool_use_id: `${parent}-heartbeat-01` }),
    event({ tool_use_id: `${parent}-heartbeat-100` }),
    event({ tool_use_id: `${parent}-heartbeat-` }),
    event({ elapsed_time_seconds: 30.5 }),
    event({ elapsed_time_seconds: -1 }),
    event({ elapsed_time_seconds: 3601 }),
    event({ elapsed_time_seconds: '30' }),
    event({ elapsed_time_seconds: null }),
    event({ uuid: undefined }),
    event({ uuid: 'malformed' }),
    event({ parent_tool_use_id: 'foreign-call' }),
    event({ tool_name: 'Agent' }),
    event({ session_id: 'foreign-session' }),
    event({ heartbeat: false }),
    event({ type: 'assistant' }),
    event({ subagent_type: 'Task' }),
  ]) {
    const fresh = make(), prior = state(fresh)
    assert.throws(() => fresh.push(JSON.stringify(hostile)), { code: 'ROLE_POLICY_DENIED' })
    assert.deepEqual(state(fresh), prior)
    assert.equal(fresh.claudeHeartbeatCounters.size, 0)
  }
  for (const counter of [0, 2, 100]) {
    const fresh = make()
    fresh.push(JSON.stringify(event()))
    assert.throws(() => fresh.push(JSON.stringify(event({ tool_use_id: `${parent}-heartbeat-${counter}` }))), { code: 'ROLE_POLICY_DENIED' })
    assert.equal(fresh.claudeHeartbeatCounters.get(parent), 0)
  }
  const nonowned = new HarnessEventStream('claude', { commandBoundary: true })
  nonowned.session(session, {}, '{}')
  nonowned.startTool(parent, 'bash', { command: 'printf ok' })
  assert.throws(() => nonowned.push(JSON.stringify(event({ tool_name: 'bash' }))), { code: 'ROLE_POLICY_DENIED' })
  const completed = make()
  const result = { tool: 'bash', status: 'completed', command: 'printf ok', exitCode: 0, background: false, output: 'ok', outputSha256: native.sha256('ok') }
  boundary.appendReceipt(prepared, 'bash', { command: 'printf ok' }, result, new Date().toISOString())
  completed.finishTool(parent, JSON.stringify(result))
  assert.equal(completed.completedTools.has(parent), true)
  assert.throws(() => completed.push(JSON.stringify(event())), { code: 'ROLE_POLICY_DENIED' })
})

test('Claude refuses unstreamed assistant accounting and unfinished streamed content', () => {
  const missing = events('claude').filter(event => event.type !== 'stream_event')
  assert.throws(() => pushAll(new HarnessEventStream('claude'), missing), { code: 'PROVIDER_USAGE_UNKNOWN' })
  const unfinished = events('claude').filter(event => event.event?.type !== 'content_block_stop')
  assert.throws(() => pushAll(new HarnessEventStream('claude'), unfinished), { code: 'CHILD_RUNTIME_FAILURE' })
  const lied = events('claude')
  lied.find(event => event.type === 'assistant').message.usage.input_tokens++
  assert.throws(() => pushAll(new HarnessEventStream('claude'), lied), { code: 'PROVIDER_USAGE_UNKNOWN' })
})

test('Claude accepts provisional streamed usage but requires a complete final receipt', () => {
  const partial = events('claude')
  const start = partial.find(event => event.event?.type === 'message_start').event.message.usage
  delete start.cache_creation_input_tokens
  partial.find(event => event.type === 'assistant').message.usage = { ...start }
  const parsed = pushAll(new HarnessEventStream('claude'), partial)
  assert.deepEqual(parsed.usage, expected)
  const missingFinal = events('claude')
  delete missingFinal.find(event => event.type === 'result').usage.cache_creation_input_tokens
  assert.throws(() => pushAll(new HarnessEventStream('claude'), missingFinal), { code: 'PROVIDER_USAGE_UNKNOWN' })
  const contradictory = events('claude')
  contradictory.find(event => event.type === 'result').usage.input_tokens++
  assert.throws(() => pushAll(new HarnessEventStream('claude'), contradictory), { code: 'PROVIDER_USAGE_UNKNOWN' })
  const noReceipt = events('claude').filter(event => event.type !== 'result')
  assert.throws(() => pushAll(new HarnessEventStream('claude'), noReceipt), { code: 'CHILD_RESULT_MISSING' })
})

test('Reasonix also obeys the scheduler token stop and retains the consumed usage', () => {
  for (const verdict of [{ continue: false }, undefined]) {
    const stream = new ReasonixEventStream({ onUsageDelta: () => verdict })
    assert.throws(() => stream.push(JSON.stringify({ kind: 'usage', usage: { promptTokens: 10, cacheHitTokens: 2, completionTokens: 4, reasoningTokens: 1 } })), error => {
      assert.equal(error.code, 'BUDGET_EXHAUSTED')
      assert.deepEqual(error.usage, { noncachedInput: 8, cachedInput: 2, output: 4, reasoning: 1 }); return true
    })
    assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
  }
})

test('provider lookup rejects inherited object properties and non-provider transports', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'codex', '', null, {}]) assert.throws(() => native.descriptor(id), { code: 'PROVIDER_UNSUPPORTED' })
  const owned = new HarnessEventStream('vscode')
  assert.equal(owned.protocol, 'vscode-owned-json')
  assert.throws(() => owned.finish(), { code: 'CHILD_RESULT_MISSING' })
  assert.deepEqual(native.descriptor('vscode').blockers, [])
})

test('Prime native ownership path is pinned to the exact release that exposes the verified owned worker', () => {
  const descriptor = native.descriptor('prime')
  assert.deepEqual(descriptor.versions, ['0.7.2'])
  const help = descriptor.flags.join(' ')
  const spawnSync = (_file, argv) => argv[0] === '--version'
    ? { status: 0, signal: null, stdout: 'prime-agent 0.7.3\n', stderr: '' }
    : { status: 0, signal: null, stdout: help, stderr: '' }
  assert.throws(() => native.probeExecutable({ provider: 'prime', executable: process.execPath, spawnSync }), error => {
    assert.equal(error.code, 'PROVIDER_UNSUPPORTED')
    assert.deepEqual(error.details.supportedVersions, ['0.7.2'])
    return true
  })
})

test('native connection extraction excludes executable plugins and prototype-bearing records', () => {
  const connection = native.sanitizeConnection('opencode', { model: 'local/fixture', hooks: ['foreign'], plugin: ['foreign'],
    providers: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, models: { fixture: { name: 'Fixture' } } } } })
  assert.equal(connection.model, 'local/fixture'); assert.equal(connection.hooks, undefined); assert.equal(connection.plugin, undefined)
  for (const source of [null, [], { providers: [] }, { providers: { local: { npm: 'untrusted-executable-provider' } } },
    JSON.parse('{"providers":{"__proto__":{"polluted":true}}}'), { providers: { local: { models: { fixture: null } } } },
    { providers: { local: { models: JSON.parse('{"constructor":{}}') } } }]) {
    assert.throws(() => native.sanitizeConnection('opencode', source), { code: 'PROFILE_INVALID' })
  }
  assert.equal({}.polluted, undefined)
})

test('OpenCode and Kilo use only declared reasoning variants for custom provider models', t => {
  const directory = root(t)
  for (const provider of ['opencode', 'kilo']) {
    const connection = { model: 'local/fixture', providers: { local: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: '<local-test-only>' }, models: { fixture: {
        name: 'Fixture', variants: { high: { reasoningEffort: 'high' } },
      } } } } }
    const launch = native.createLaunch({ provider, home: path.join(directory, provider), sessionRoot: path.join(directory, 'session'),
      targetPath: directory, cwd: directory, prompt: 'fixture', input: 'fixture', connection, effort: 'high', environment: { PATH: process.env.PATH } })
    assert.ok(launch.argv.includes('--variant'))
    assert.equal(launch.argv[launch.argv.indexOf('--variant') + 1], 'high')
    assert.deepEqual(native.sanitizeConnection(provider, connection).providers.local.models.fixture.variants,
      { high: { reasoningEffort: 'high' } })
    assert.throws(() => native.createLaunch({ provider, home: path.join(directory, `${provider}-missing`), sessionRoot: path.join(directory, 'session'),
      targetPath: directory, cwd: directory, prompt: 'fixture', input: 'fixture', connection: { ...connection, providers: { local: { ...connection.providers.local,
        models: { fixture: { name: 'Fixture' } } } } }, effort: 'high', environment: { PATH: process.env.PATH } }), { code: 'PROFILE_INVALID' })
  }
})

test('private child environment strips code injection, foreign config and unrelated credentials', t => {
  const home = root(t)
  const result = native.isolatedEnvironment(home, { PATH: process.env.PATH, NODE_OPTIONS: '--require foreign.js', LD_PRELOAD: '/foreign',
    OPENCODE_CONFIG: '/foreign', ANTHROPIC_API_KEY: 'unrelated', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'push.default', GIT_CONFIG_VALUE_0: 'nothing' })
  for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'OPENCODE_CONFIG', 'ANTHROPIC_API_KEY']) assert.equal(result[key], undefined)
  assert.equal(result.HOME, home); assert.equal(result.GIT_CONFIG_VALUE_0, 'nothing')
  assert.equal(fs.readFileSync(result.GIT_CONFIG_GLOBAL, 'utf8'), '')
})

test('native continuation is exact across new launch identities and refuses role/workspace/provider changes', t => {
  const directory = root(t), target = path.join(directory, 'target')
  const first = { sessionId: 'launch-1', providerRole: 'ap-worker' }
  const saved = contextRoot(directory, 'claude', first, target)
  persistContext(directory, saved, 'claude', first, target, 'native-1')
  const resumed = { ...first, sessionId: 'launch-2', continuationId: 'native-1' }
  assert.equal(contextRoot(directory, 'claude', resumed, target), saved)
  for (const [provider, record, workspace] of [['kilo', resumed, target], ['claude', { ...resumed, providerRole: 'ap-independent-checker' }, target], ['claude', resumed, `${target}-other`]]) {
    assert.throws(() => contextRoot(directory, provider, record, workspace), { code: 'SESSION_ID_MISMATCH' })
  }
})

test('native executable hashing supports hard-linked distributions and detects byte changes', t => {
  const directory = root(t), first = path.join(directory, 'native'), linked = path.join(directory, 'native-link')
  fs.writeFileSync(first, 'fixture executable bytes'); fs.linkSync(first, linked)
  const hash = native.executableSha256(first)
  assert.equal(native.executableSha256(linked), hash)
  fs.writeFileSync(linked, 'changed fixture executable bytes')
  assert.notEqual(native.executableSha256(first), hash)
  assert.throws(() => native.readBound(first), { code: 'PAYLOAD_INVALID' })
})

test('runtime identity binds resolved dependencies and backing files without unrelated packages', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const main = path.join(root, 'node_modules', 'native-harness')
  const dependency = path.join(root, 'node_modules', 'engine')
  const unrelated = path.join(root, 'node_modules', 'unrelated')
  for (const directory of [main, dependency, unrelated]) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'native-harness', dependencies: { engine: '1' } }))
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'engine' }))
  const executable = path.join(main, 'cli.js'), backing = path.join(dependency, 'runtime.js')
  fs.writeFileSync(executable, '#!/usr/bin/env node\nrequire("engine")\n')
  fs.writeFileSync(backing, 'module.exports = 1')
  const first = native.runtimeDependencyIdentity(executable)
  assert.equal(first.packageCount, 2)
  fs.writeFileSync(path.join(unrelated, 'anything.js'), 'unrelated mutable install')
  assert.deepEqual(native.runtimeDependencyIdentity(executable), first)
  fs.writeFileSync(backing, 'module.exports = 2')
  assert.notEqual(native.runtimeDependencyIdentity(executable).sha256, first.sha256)
  fs.rmSync(dependency, { recursive: true })
  assert.throws(() => native.runtimeDependencyIdentity(executable), { code: 'PROVIDER_IDENTITY_MISMATCH' })
})

test('OpenCode and Kilo native visible output is disjoint from reasoning and reconciles to total', () => {
  // Captured native OpenCode OpenRouter step, corroborated by getUsage in the
  // official v1.18.29 session/session.ts source: outputTokens - reasoningTokens.
  for (const provider of ['opencode', 'kilo']) {
    const actual = { total: 2895, input: 311, output: 7, reasoning: 17, cache: { read: 2560, write: 0 } }
    assert.deepEqual(exactUsage(provider, actual), { noncachedInput: 311, cachedInput: 2560, output: 24, reasoning: 17 })
    assert.throws(() => exactUsage(provider, { ...actual, total: 2878 }), { code: 'PROVIDER_USAGE_UNKNOWN' })
    assert.throws(() => exactUsage(provider, { ...actual, output: -1 }), { code: 'PROVIDER_USAGE_UNKNOWN' })
    assert.throws(() => exactUsage(provider, { ...actual, reasoning: undefined }), { code: 'PROVIDER_USAGE_UNKNOWN' })
  }
})

function claudeThinkingTruncation(index = 0) {
  const session_id = 'claude-structured-session', id = `claude-truncated-${index}`
  const initial = { ...usage('claude'), output_tokens: 0, reasoning_output_tokens: 0 }
  const stream = event => ({ type: 'stream_event', session_id, event })
  return [
    stream({ type: 'message_start', message: { role: 'assistant', id, usage: initial } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'unfinished reasoning' } }),
    { type: 'assistant', session_id, message: { role: 'assistant', id, usage: initial, content: [{ type: 'thinking', thinking: 'unfinished reasoning', signature: '' }] } },
    stream({ type: 'content_block_stop', index: 0 }),
    stream({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4, reasoning_output_tokens: 1 } }),
    stream({ type: 'message_stop' }),
  ]
}

test('Claude permits two thinking-only continuations without treating truncation as output', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  for (const count of [1, 2]) {
    const complete = claudeStructuredEvents()
    complete.at(-1).usage = Object.fromEntries(Object.entries(usage('claude')).map(([key, value]) => [key, value * (count + 1)]))
    const debits = [], stream = new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema,
      onUsageDelta: delta => { debits.push(delta); return { continue: true } } })
    stream.push(JSON.stringify(complete[0]))
    for (let i = 0; i < count; i++) for (const event of claudeThinkingTruncation(i)) stream.push(JSON.stringify(event))
    assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
    assert.deepEqual(pushAll(stream, complete.slice(1)).output, { ok: true })
    assert.equal(debits.length, count + 1)
    assert.deepEqual(debits, Array.from({ length: count + 1 }, () => expected))
  }
})

test('Claude thinking continuation retains its closed content, attempt and terminal boundaries', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  const make = () => new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema })
  for (const mutate of [
    sequence => sequence.splice(3, 1),
    sequence => { sequence[3].message.content[0].signature = 'opaque' },
    sequence => { sequence[1].event.content_block.signature = 'opaque' },
    sequence => { sequence[2].event.delta.thinking = ''; sequence[3].message.content[0].thinking = '' },
    sequence => { sequence[1].event.content_block.type = 'text'; sequence[2].event.delta = { type: 'text_delta', text: 'partial result' } },
    sequence => { sequence[5].event.delta.stop_reason = 'refusal' },
  ]) {
    const sequence = claudeThinkingTruncation(); mutate(sequence)
    assert.throws(() => pushAll(make(), sequence), { code: 'CHILD_RUNTIME_FAILURE' })
  }
  const limited = make()
  for (const i of [0, 1]) for (const event of claudeThinkingTruncation(i)) limited.push(JSON.stringify(event))
  assert.throws(() => pushAll(limited, claudeThinkingTruncation(2)), { code: 'CHILD_RUNTIME_FAILURE' })
  const late = make(); for (const event of claudeThinkingTruncation()) late.push(JSON.stringify(event))
  const injected = claudeThinkingTruncation()[3]
  injected.message.content = [{ type: 'tool_use', id: 'injected', name: 'StructuredOutput', input: { ok: true } }]
  assert.throws(() => late.push(JSON.stringify(injected)), { code: 'CHILD_RUNTIME_FAILURE' })
  const terminal = make(); for (const event of claudeThinkingTruncation()) terminal.push(JSON.stringify(event))
  assert.throws(() => terminal.push(JSON.stringify({ ...claudeStructuredEvents().at(-1), usage: usage('claude') })), { code: 'CHILD_RUNTIME_FAILURE' })
  const noSchema = new HarnessEventStream('claude')
  assert.throws(() => pushAll(noSchema, claudeThinkingTruncation()), { code: 'CHILD_RUNTIME_FAILURE' })
  let debits = 0
  const exhausted = new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema, onUsageDelta: () => ({ continue: ++debits > 1 }) })
  assert.throws(() => pushAll(exhausted, claudeThinkingTruncation()), { code: 'BUDGET_EXHAUSTED' })
  assert.equal(debits, 1)
})

test('Claude thinking recovery refuses malformed deltas, unfinished authority and altered usage', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  const make = () => new HarnessEventStream('claude', { claudeStructuredOutputSchema: schema })
  const malformed = claudeThinkingTruncation()
  malformed.splice(3, 0, { ...malformed[2], event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } })
  assert.throws(() => pushAll(make(), malformed), { code: 'TRANSPORT_INVALID' })
  const wrongJson = claudeStructuredEvents()
  wrongJson[3].event.delta.partial_json = null
  assert.throws(() => pushAll(make(), wrongJson), { code: 'TRANSPORT_INVALID' })
  const unfinished = claudeThinkingTruncation(); unfinished.splice(4, 1)
  assert.throws(() => pushAll(make(), unfinished), { code: 'CHILD_RUNTIME_FAILURE' })
  const mixed = claudeThinkingTruncation()
  mixed.splice(5, 0,
    { type: 'stream_event', session_id: 'claude-structured-session', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'partial' } } },
    { type: 'stream_event', session_id: 'claude-structured-session', event: { type: 'content_block_stop', index: 1 } })
  assert.throws(() => pushAll(make(), mixed), { code: 'CHILD_RUNTIME_FAILURE' })
  for (const state of ['active', 'pending', 'accepted']) {
    const prefix = claudeStructuredEvents().slice(0, state === 'accepted' ? 9 : 8)
    if (state === 'active') {
      prefix[2].event.content_block.name = 'Read'
      prefix[3].event.delta.partial_json = JSON.stringify({ file_path: '/tmp/source' })
      prefix[7].message.content[0] = { type: 'tool_use', id: 'claude-structured-call', name: 'Read', input: { file_path: '/tmp/source' } }
    }
    const stream = make(); for (const event of prefix) stream.push(JSON.stringify(event))
    assert.throws(() => pushAll(stream, claudeThinkingTruncation()), { code: 'CHILD_RUNTIME_FAILURE' })
  }
  const regressed = make(); for (const event of claudeThinkingTruncation()) regressed.push(JSON.stringify(event))
  assert.throws(() => pushAll(regressed, claudeStructuredEvents().slice(1)), { code: 'PROVIDER_USAGE_UNKNOWN' })
})
