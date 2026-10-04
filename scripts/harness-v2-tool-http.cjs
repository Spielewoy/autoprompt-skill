'use strict'

// OpenCode's embedded Bun runtime can stall its local MCP stdio writer on
// Windows after inventory succeeds. This controller-owned, authenticated
// Streamable HTTP endpoint feeds the unchanged tool server handler without
// granting the provider a general host service or a second tool authority.
const crypto = require('node:crypto')
const http = require('node:http')
const { PassThrough, Writable } = require('node:stream')
const toolServer = require('./harness-v2-tool-server.cjs')

function fail(message) { const error = new Error(message); error.code = 'TOOL_POLICY_INVALID'; throw error }
function key(id) { return `${typeof id}:${String(id)}` }
function validId(id) { return typeof id === 'string' ? id.length <= 256 : Number.isSafeInteger(id) }

function createAuthenticatedToolHttp(options = {}) {
  if (!options.boundary || typeof options.boundary !== 'object') fail('OpenCode HTTP tools require an exact boundary')
  if (options.onFailure !== undefined && typeof options.onFailure !== 'function') fail('OpenCode HTTP failure observer is invalid')
  let failureReported = false
  const reportFailure = error => {
    if (closing || failureReported) return
    failureReported = true
    try { options.onFailure?.(error instanceof Error ? error : new Error(String(error))) } catch {}
  }
  const token = crypto.randomBytes(32).toString('base64url')
  const authorization = `Bearer ${token}`
  const input = new PassThrough()
  const pending = new Map(), seenIds = new Set()
  let outputBuffer = '', listening = false, closing = false, closePromise = null
  const output = new Writable({ write(chunk, encoding, callback) {
    try {
      outputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (Buffer.byteLength(outputBuffer) > toolServer.MAX_LINE) throw new Error('tool response exceeds its byte limit')
      let newline
      while ((newline = outputBuffer.indexOf('\n')) !== -1) {
        const line = outputBuffer.slice(0, newline); outputBuffer = outputBuffer.slice(newline + 1)
        if (!line) continue
        const value = JSON.parse(line)
        const waiter = value && Object.hasOwn(value, 'id') ? pending.get(key(value.id)) : null
        if (!waiter) continue
        pending.delete(key(value.id)); waiter.resolve(value)
      }
      callback()
    } catch (error) {
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear(); reportFailure(error); callback(error)
    }
  } })
  const handler = toolServer.start({ boundary: options.boundary, input, output, projectionPath: undefined, platform: options.platform || process.platform,
    ...(options.windowsLeaseFactory ? { windowsLeaseFactory: options.windowsLeaseFactory } : {}) })
  const sockets = new Set()
  let activeRequests = 0, initializedNotification = false
  const writeLine = line => new Promise((resolve, reject) => {
    if (closing || input.destroyed || input.writableEnded) { reject(new Error('OpenCode tool endpoint is closed')); return }
    input.write(line, error => error ? reject(error) : resolve())
  })
  const server = http.createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    const supplied = typeof request.headers.authorization === 'string' ? request.headers.authorization : ''
    const expectedBytes = Buffer.from(authorization), suppliedBytes = Buffer.from(supplied)
    if (suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
      response.writeHead(401, { 'content-type': 'application/json' }); response.end(); return
    }
    if (request.method !== 'POST' || request.url !== '/mcp' || !/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
      response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }); response.end(); return
    }
    if (activeRequests >= 32) { response.writeHead(429, { 'content-type': 'application/json' }); response.end(); return }
    activeRequests += 1
    try {
      const chunks = []; let bytes = 0, excessive = false
      try {
        for await (const chunk of request) {
          bytes += chunk.length
          if (bytes > toolServer.MAX_LINE) { excessive = true; break }
          chunks.push(chunk)
        }
      } catch { response.destroy(); return }
      if (excessive) { response.writeHead(413, { 'content-type': 'application/json' }); response.end(); return }
      let message
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(); return
      }
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(); return
      }
      const line = `${JSON.stringify(message)}\n`
      if (!Object.hasOwn(message, 'id')) {
        if (message.method === 'notifications/initialized' && !initializedNotification) {
          initializedNotification = true
          await writeLine(line)
        } else if (message.method === 'notifications/cancelled' && validId(message.params?.requestId)) {
          const identity = key(message.params.requestId)
          const waiter = pending.get(identity)
          if (waiter) {
            pending.delete(identity)
            const error = Object.assign(new Error('OpenCode tool request was cancelled'), { code: 'TOOL_REQUEST_CANCELLED' })
            waiter.reject(error)
            await writeLine(line)
          }
        }
        response.writeHead(202); response.end(); return
      }
      if (!validId(message.id)) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(); return }
      const identity = key(message.id)
      if (seenIds.has(identity)) { response.writeHead(409, { 'content-type': 'application/json' }); response.end(); return }
      if (seenIds.size >= 100000) { response.writeHead(429, { 'content-type': 'application/json' }); response.end(); return }
      seenIds.add(identity)
      let resolve, reject
      const result = new Promise((yes, no) => { resolve = yes; reject = no })
      result.catch(() => {})
      pending.set(identity, { resolve, reject })
      const cancelled = () => {
        const waiter = pending.get(identity)
        if (!waiter) return
        pending.delete(identity)
        waiter.reject(Object.assign(new Error('OpenCode tool request was cancelled'), { code: 'TOOL_REQUEST_CANCELLED' }))
        writeLine(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: message.id } })}\n`).catch(reportFailure)
      }
      request.once('aborted', cancelled); response.once('close', () => { if (!response.writableEnded) cancelled() })
      try {
        await writeLine(line)
        const body = await result
        if (response.destroyed) return
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body))
      } catch (error) {
        pending.delete(identity)
        if (!response.destroyed) response.destroy()
        if (!closing && error?.code !== 'TOOL_REQUEST_CANCELLED') reportFailure(error)
      }
    } catch (error) {
      if (!response.destroyed) response.destroy()
      if (!closing) reportFailure(error)
    } finally { activeRequests -= 1 }
  })
  server.maxConnections = 64
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('error', reportFailure)
  handler.closed.then(() => { if (!closing) reportFailure(new Error('OpenCode tool handler closed before its owned launch drained')) })

  const listen = async () => {
    try {
      return await new Promise((resolve, reject) => {
        if (listening || closing) { reject(Object.assign(new Error('OpenCode tool endpoint lifecycle is invalid'), { code: 'TOOL_POLICY_INVALID' })); return }
        const onError = error => { server.removeListener('listening', onListening); reject(error) }
        const onListening = () => {
          server.removeListener('error', onError); listening = true
          const address = server.address()
          if (!address || typeof address === 'string' || address.address !== '127.0.0.1') { reject(new Error('OpenCode tool endpoint address is invalid')); return }
          resolve(Object.freeze({ url: `http://127.0.0.1:${address.port}/mcp`, authorization }))
        }
        server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1')
      })
    } catch (error) {
      await close()
      throw error
    }
  }
  const close = () => {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      // Abort boundary commands synchronously before waiting for the HTTP
      // listener to drain. handler.close() resolves only after the boundary's
      // command chain and its owned-process cleanup have completed.
      const handlerClose = handler.close()
      for (const waiter of pending.values()) waiter.reject(new Error('OpenCode tool endpoint closed'))
      pending.clear()
      input.end()
      for (const socket of sockets) socket.destroy()
      if (listening) await new Promise(resolve => server.close(resolve))
      else { try { server.close() } catch {} }
      await handlerClose
    })()
    return closePromise
  }
  return Object.freeze({ listen, close, closed: handler.closed })
}

module.exports = { createServer: createAuthenticatedToolHttp, createAuthenticatedToolHttp }
