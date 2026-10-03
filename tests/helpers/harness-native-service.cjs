'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

// Only the model HTTP endpoint is deterministic. The executable, its real
// tools, native event encoding, session storage and cancellation remain the SUT.
async function modelService(provider, tool, options = {}) {
  const requests = [], errors = []
  let completed = 0, toolRequested = false, delayConsumed = false, holdConsumed = false, heldFirstMessage = false, releaseHeldFirstMessage = null
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Fixture request exceeds eight MiB')
      }
      const value = JSON.parse(body || '{}')
      requests.push({ method: req.method, path: req.url, body: value,
        ...(options.expectedBearer ? { fixtureCredentialAccepted: req.headers.authorization === `Bearer ${options.expectedBearer}` } : {}) })
      if (requests.length > 20) throw new Error('Unexpected native request loop')
      // This captured native connection handshake is not a model invocation.
      if (provider === 'claude' && req.url === '/api/hello' && Object.keys(value).length === 0) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return
      }
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 100 })); return
      }
      const responses = provider !== 'claude' && options.responses === true && req.url.includes('/responses')
      if (provider === 'claude' && !req.url.includes('/messages') ||
          provider !== 'claude' && !responses && !req.url.includes('/chat/completions')) throw new Error(`Unexpected API path ${req.url}`)
      // A closed native cancellation probe needs a request that is genuinely
      // in flight at the installed CLI, rather than a mocked runner delay.
      // Delay only the first model message so the following fresh session can
      // prove that ProcessOwner drained the cancelled process group.
      if (options.delayMessagesMs && !delayConsumed) {
        delayConsumed = true
        await new Promise(resolve => setTimeout(resolve, options.delayMessagesMs))
      }
      // Hold before assigning a tool response: an aborted first conversation
      // must not consume the command intended for the independent live sibling.
      if (options.holdFirstMessage && !holdConsumed) {
        holdConsumed = true
        await new Promise(resolve => {
          let settled = false
          const release = () => {
            if (settled) return
            settled = true
            heldFirstMessage = false
            releaseHeldFirstMessage = null
            res.off('close', release)
            resolve()
          }
          heldFirstMessage = true
          releaseHeldFirstMessage = release
          res.once('close', release)
        })
        if (res.destroyed) return
      }
      const advertised = (value.tools || []).some(item => (item.name || item.function?.name) === tool.name)
      // Concurrent Claude conversations must each receive their own command.
      // Their returned assistant history, rather than a shared endpoint flag,
      // distinguishes the initial request from its tool-result continuation.
      const requestedInConversation = provider === 'claude' && options.toolPerConversation === true
        ? Array.isArray(value.messages) && value.messages.some(message => message?.role === 'assistant' &&
          Array.isArray(message.content) && message.content.some(block => block?.type === 'tool_use' && block.id === 'fixture-native-read' && block.name === tool.name))
        : toolRequested
      const first = !options.noTool && !requestedInConversation && (advertised || options.forceFirstTool === true)
      if (first) toolRequested = true
      const structuredTool = (value.tools || []).find(item => {
        const name = item.name || item.function?.name
        return provider === 'claude' ? name === 'StructuredOutput' : name === 'autoprompt_structured_output'
      })
      const finalStructured = !first && structuredTool
      const structuredOutput = options.structuredOutput || { ok: true }
      completed++
      const id = `fixture-message-${completed}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (options.firstResponseBodyDelayMs && completed === 1) {
        res.write(': fixture response pending\n\n')
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); res.off('close', finish); resolve() }
          const timer = setTimeout(finish, options.firstResponseBodyDelayMs)
          res.once('close', finish)
        })
        if (res.destroyed) return
      }
      // Capability suites may reuse one deterministic endpoint across
      // sequential native launches. Re-arm only after this fixture tool's
      // completed result comes back, never after an unrelated or concurrent
      // initial request, so commands cannot cross session boundaries.
      const completedFixtureTool = Array.isArray(value.messages) && value.messages.some(message =>
        message?.role === 'tool' && (message.tool_call_id === 'fixture-native-read' || message.tool_use_id === 'fixture-native-read')) ||
        Array.isArray(value.input) && value.input.some(item => item?.type === 'function_call_output' && item.call_id === 'fixture-native-read')
      if (!first && options.resetToolAfterCompletion && completedFixtureTool) toolRequested = false
      if (provider === 'claude') {
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
        send('message_start', { message: { id, type: 'message', role: 'assistant', model: value.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: options.deferredInputUsage ? 0 : 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
        const explicitThinking = first && options.explicitThinkingReplay
        if (explicitThinking) {
          send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
          send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture planning text.' } })
          send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: '' } })
          send('content_block_stop', { index: 0 })
        }
        const contentIndex = explicitThinking ? 1 : 0
        send('content_block_start', { index: contentIndex, content_block: first || finalStructured
          ? { type: 'tool_use', id: finalStructured ? 'fixture-structured-output' : 'fixture-native-read', name: finalStructured ? 'StructuredOutput' : tool.name, input: {} }
          : { type: 'text', text: '' } })
        send('content_block_delta', { index: contentIndex, delta: first || finalStructured
          ? { type: 'input_json_delta', partial_json: JSON.stringify(finalStructured ? structuredOutput : tool.args) }
          : { type: 'text_delta', text: '{"ok":true}' } })
        send('content_block_stop', { index: contentIndex })
        send('message_delta', { delta: { stop_reason: first || finalStructured ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { ...(options.deferredInputUsage ? { input_tokens: 100 } : {}), output_tokens: 10 } })
        send('message_stop', {})
        if (options.terminalDoneSentinel) res.write(`${options.terminalDoneSentinel === 'data' ? 'event: data\n' : ''}data: [DONE]\n\n`)
        res.end()
      } else if (responses) {
        const send = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
        if (first) {
          const item = { type: 'function_call', id: 'fixture-native-read-item', call_id: 'fixture-native-read', name: tool.name, arguments: '' }
          send({ type: 'response.output_item.added', item })
          send({ type: 'response.function_call_arguments.delta', item_id: item.id, delta: JSON.stringify(tool.args) })
          send({ type: 'response.output_item.done', item: { ...item, arguments: JSON.stringify(tool.args) } })
        } else {
          const item = { type: 'message', id: 'fixture-native-text', role: 'assistant', status: 'in_progress', content: [] }
          const part = { type: 'output_text', text: '' }
          send({ type: 'response.output_item.added', output_index: 0, item })
          send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part })
          send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: '{"ok":true}' })
          send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: '{"ok":true}' })
          send({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '{"ok":true}' } })
          send({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: '{"ok":true}' }] } })
        }
        send({ type: 'response.completed', response: { id, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
        res.end()
      } else {
        const delta = first || finalStructured
          ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-native-read', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
          : { role: 'assistant', content: '{"ok":true}' }
        if (finalStructured) {
          delta.tool_calls[0].id = 'fixture-structured-output'
          delta.tool_calls[0].function.name = 'autoprompt_structured_output'
          delta.tool_calls[0].function.arguments = JSON.stringify({ canonicalJson: JSON.stringify(structuredOutput) })
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: value.model,
          choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.end(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: value.model,
          choices: [{ index: 0, delta: {}, finish_reason: first || finalStructured ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
            prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\ndata: [DONE]\n\n`)
      }
    } catch (error) {
      errors.push(error.message)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'fixture_error', message: error.message } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}`, requests, errors, tool,
    get firstMessageHeld() { return heldFirstMessage },
    get completed() { return completed },
    close: () => new Promise(resolve => {
      releaseHeldFirstMessage?.()
      server.closeAllConnections()
      server.close(resolve)
    }) }
}

function runNative(executable, launch, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, launch.argv, { cwd: launch.cwd, env: launch.env,
      shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, truncated = false
    const kill = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, options.timeoutMs || 45000)
    const collect = (stream, isError) => stream.on('data', chunk => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 32 * 1024 * 1024) {
        truncated = true; kill(); return
      }
      if (isError) stderr += chunk.toString('utf8'); else stdout += chunk.toString('utf8')
    })
    collect(child.stdout, false); collect(child.stderr, true)
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { kill(); reject(error) } })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      // Reap a background child retaining neither output pipe, without waiting
      // for an arbitrary native harness shutdown convention.
      if (child.pid && process.platform !== 'win32') kill()
      if (options.evidenceRoot) {
        fs.mkdirSync(options.evidenceRoot, { recursive: true, mode: 0o700 })
        const name = options.evidenceName || 'native'
        fs.writeFileSync(path.join(options.evidenceRoot, `${name}.stdout`), stdout, { mode: 0o600 })
        fs.writeFileSync(path.join(options.evidenceRoot, `${name}.stderr`), stderr, { mode: 0o600 })
      }
      resolve({ status, signal, stdout, stderr, timedOut, truncated })
    })
    child.stdin.end(launch.stdin)
  })
}

module.exports = { modelService, runNative }
