'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

class GrokRelayError extends Error {
  constructor(code, message) { super(message); this.name = 'GrokRelayError'; this.code = code }
}
const fail = (code, message) => { throw new GrokRelayError(code, message) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const token = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('GROK_RELAY_CONFIG_INVALID', 'Relay tokens must be 32-byte lowercase hex values')
  return value
}
const sameToken = (left, right) => {
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
const WINDOWS_PIPE = /^\\\\\.\\pipe\\autoprompt-grok-[a-f0-9]{64}$/u
function createWindowsRelayPath(randomBytes = crypto.randomBytes) {
  if (typeof randomBytes !== 'function') fail('GROK_RELAY_CONFIG_INVALID', 'Windows relay randomness is unavailable')
  const nonce = randomBytes(32)
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) fail('GROK_RELAY_CONFIG_INVALID', 'Windows relay randomness is invalid')
  return `\\\\.\\pipe\\autoprompt-grok-${nonce.toString('hex')}`
}
function validateRelayAddress(socketPath, platform = process.platform) {
  if (typeof socketPath !== 'string' || socketPath.includes('\0')) fail('GROK_RELAY_CONFIG_INVALID', 'Relay socket path is invalid')
  if (platform === 'win32') {
    if (!WINDOWS_PIPE.test(socketPath)) fail('GROK_RELAY_CONFIG_INVALID', 'Windows relay pipe name is invalid')
  } else if (!socketPath.startsWith('/')) fail('GROK_RELAY_CONFIG_INVALID', 'Unix relay socket path is invalid')
  return socketPath
}
async function boundedResponseText(response, limit = 32 * 1024 * 1024) {
  if (!response.body || typeof response.body.getReader !== 'function') fail('GROK_RELAY_FAILURE', 'Upstream response is not a readable stream')
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limit) { await reader.cancel(); fail('GROK_RELAY_LIMIT', 'Upstream response exceeds relay limit') }; chunks.push(Buffer.from(next.value)) }
  } finally { reader.releaseLock?.() }
  return Buffer.concat(chunks).toString('utf8')
}
function createUnixRelay(options = {}) {
  const relayPlatform = process.platform
  const socketPath = validateRelayAddress(options.socketPath, relayPlatform)
  const relayToken = token(options.relayToken)
  const upstreamUrl = options.upstreamUrl
  const upstreamAuthorization = options.upstreamAuthorization
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const mcpHandler = options.mcpHandler
  const requestTimeoutMs = options.requestTimeoutMs ?? 300000
  if (!['linux', 'darwin', 'win32'].includes(relayPlatform) || typeof upstreamUrl !== 'string' || !upstreamUrl.startsWith('http') ||
      typeof upstreamAuthorization !== 'string' || !upstreamAuthorization || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2147483647) fail('GROK_RELAY_CONFIG_INVALID', 'Unix relay configuration is invalid')
  let closed = false, ownedSocket = false, closePromise = null, directoryFd = null, socketIdentity = null
  let bindPath = socketPath, connectPath = socketPath
  const sockets = new Set(), controllers = new Set()
  const server = net.createServer(socket => {
    if (closed) return socket.destroy()
    sockets.add(socket)
    // The peer may disappear between the writable check and an async write.
    // A broken pipe is a disconnected request, never a controller crash.
    socket.on('error', () => socket.destroy())
    // A model request can legitimately remain quiet while the upstream is
    // reasoning. Its controller deadline below is authoritative; a shorter
    // socket-idle timer would sever that still-bounded request and leave the
    // upstream work running without its client.
    socket.setTimeout(requestTimeoutMs, () => socket.destroy())
    let buffer = '', chain = Promise.resolve()
    const send = value => { if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(value)}\n`) }
    const socketControllers = new Set()
    let disconnectedReject
    const disconnected = new Promise((_, reject) => { disconnectedReject = reject })
    disconnected.catch(() => {})
    socket.once('close', () => {
      sockets.delete(socket)
      for (const controller of socketControllers) controller.abort()
      disconnectedReject(new GrokRelayError('GROK_RELAY_CLOSED', 'Relay connection closed'))
    })
    const handle = async line => {
      // `data` may have queued several complete frames before the peer
      // disconnects.  The serial chain reaches those frames after close;
      // never let them allocate a controller or start upstream work.
      if (closed || socket.destroyed || !socket.writable) return
      const controller = new AbortController()
      controllers.add(controller); socketControllers.add(controller)
      let deadline
      const timedOut = new Promise((_, reject) => {
        deadline = setTimeout(() => {
          controller.abort()
          reject(new GrokRelayError('GROK_RELAY_TIMEOUT', 'Relay request timed out'))
        }, requestTimeoutMs)
        deadline.unref?.()
      })
      const bounded = operation => Promise.race([operation, timedOut, disconnected])
      let modelAdmission = null
      try {
        const message = JSON.parse(line)
        if (!object(message) || !sameToken(String(message.token || ''), relayToken) || !object(message.request)) fail('GROK_RELAY_AUTH_DENIED', 'Relay authentication failed')
        if (message.kind === 'mcp') {
          if (typeof mcpHandler !== 'function') fail('GROK_RELAY_REQUEST_DENIED', 'MCP relay is unavailable')
          const response = await bounded(Promise.resolve().then(() => {
            if (closed || controller.signal.aborted || socket.destroyed || !socket.writable) fail('GROK_RELAY_CLOSED', 'Relay is no longer accepting MCP work')
            return mcpHandler(message.request, { signal: controller.signal })
          }))
          if (!object(response)) fail('GROK_RELAY_FAILURE', 'MCP relay returned an invalid response')
          send({ response }); return
        }
        if (message.kind !== undefined && message.kind !== 'model') fail('GROK_RELAY_REQUEST_DENIED', 'Relay request kind is invalid')
        const request = message.request
        if (request.method !== 'POST' || request.path !== '/v1/chat/completions' || !object(request.headers) || typeof request.body !== 'string' || Buffer.byteLength(request.body) > 8 * 1024 * 1024) fail('GROK_RELAY_REQUEST_DENIED', 'Relay request is outside the fixed model route')
        let admission
        const response = await bounded(Promise.resolve().then(() => {
          // Check the controller's live admission state immediately before
          // starting upstream work, including requests queued before failure.
          // This synchronous gate cannot be bypassed by a native retry.
          if (typeof options.beforeModelRequest === 'function') {
            // The exact serialized request is controller-private relay input.
            // Supplying it here lets an already-accounted turn reserve a
            // bounded follow-up before this host starts another paid fetch.
            // Do not parse or normalize it in the relay: the authenticated
            // caller owns its provider-specific accounting policy.
            const verdict = options.beforeModelRequest(Object.freeze({ request: request.body, headers: Object.freeze({ ...request.headers }) }))
            if (verdict?.then) fail('GROK_RELAY_CONFIG_INVALID', 'Model admission gate must be synchronous')
            admission = verdict || null; modelAdmission = admission
          }
          if (closed || controller.signal.aborted || socket.destroyed || !socket.writable) fail('GROK_RELAY_CLOSED', 'Relay is no longer accepting model work')
          return fetchImpl(upstreamUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: upstreamAuthorization }, body: admission?.rawBody || request.body, signal: controller.signal })
        }))
        const body = await bounded(boundedResponseText(response))
        if (typeof options.onModelResponse === 'function') await bounded(Promise.resolve().then(() => options.onModelResponse({ request: request.body, headers: Object.freeze({ ...request.headers }), admission, status: response.status, contentType: response.headers.get('content-type') || 'application/json', body })))
        send({ status: response.status, contentType: response.headers.get('content-type') || 'application/json', body })
      } catch (error) {
        // Once a request has a durable admission, a close or abort after that
        // point is deliberately treated as unknown spend. The host cannot
        // prove that fetch did not reach the provider, so leaving the
        // envelope pending would permit an uncharged retry.
        if (modelAdmission && typeof options.onModelRequestFailed === 'function') {
          try { await bounded(Promise.resolve().then(() => options.onModelRequestFailed({ admission: modelAdmission, error }))) } catch (settlementError) { error = settlementError }
        }
        send({ error: { code: error.code || 'GROK_RELAY_FAILURE', message: error.message || 'Relay failed' } })
      } finally { clearTimeout(deadline); controllers.delete(controller); socketControllers.delete(controller) }
    }
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return socket.destroy()
      let index
      while ((index = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line) chain = chain.then(() => handle(line)) }
    })
  })
  return {
    server,
    async listen() {
      if (relayPlatform !== 'win32' && fs.existsSync(socketPath)) fail('GROK_RELAY_SOCKET_EXISTS', 'Refusing to replace an existing relay socket')
      if (relayPlatform === 'win32') {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); ownedSocket = true; resolve() }) })
        return socketPath
      }
      // Linux sockaddr_un is limited to 108 bytes. Keep the socket in its
      // private directory and anchor a short address to that open directory.
      if (process.platform === 'linux' || Buffer.byteLength(socketPath) >= 104) {
        if (process.platform !== 'linux') fail('GROK_RELAY_CONFIG_INVALID', 'Relay socket path is too long')
        const directory = path.dirname(socketPath), name = path.basename(socketPath)
        directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
        const stat = fs.fstatSync(directoryFd)
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
          fs.closeSync(directoryFd); directoryFd = null
          fail('GROK_RELAY_CONFIG_INVALID', 'Relay directory must be privately owned')
        }
        bindPath = `/proc/self/fd/${directoryFd}/${name}`
        connectPath = `/proc/${process.pid}/fd/${directoryFd}/${name}`
        if (Buffer.byteLength(connectPath) >= 104) {
          fs.closeSync(directoryFd); directoryFd = null
          fail('GROK_RELAY_CONFIG_INVALID', 'Relay socket filename is too long')
        }
      }
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(bindPath, () => { server.off('error', reject); ownedSocket = true; resolve() }) })
        fs.chmodSync(bindPath, 0o600)
        socketIdentity = fs.lstatSync(bindPath)
        return connectPath
      } catch (error) {
        if (!ownedSocket && directoryFd !== null) { fs.closeSync(directoryFd); directoryFd = null }
        throw error
      }
    },
    async close() {
      if (closePromise) return closePromise
      closed = true
      for (const controller of controllers) controller.abort()
      for (const socket of sockets) socket.destroy()
      // libuv unlinks its bound name synchronously in server.close(). Remove
      // only our own socket, then revoke the directory-FD alias before close
      // so libuv cannot unlink a foreign entry that replaced the socket.
      if (directoryFd !== null) {
        try {
          const current = fs.lstatSync(bindPath)
          if (socketIdentity && current.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) fs.unlinkSync(bindPath)
        } catch {}
        fs.closeSync(directoryFd); directoryFd = null
      }
      closePromise = new Promise(resolve => {
        if (!server.listening) return resolve()
        server.close(resolve)
      }).then(() => {
        // net.Server removes its own pathname on close. Do not unlink a
        // replacement entry that another process may have created afterward.
        if (directoryFd !== null) { fs.closeSync(directoryFd); directoryFd = null }
      })
      return closePromise
    },
    get closed() { return closed },
  }
}
function createPreconnectedRelayClient(options = {}) {
  const relayToken = token(options.relayToken), fd = options.fd
  if (!options.socket && (!Number.isSafeInteger(fd) || fd < 0)) fail('GROK_RELAY_CONFIG_INVALID', 'Preconnected relay fd is invalid')
  const socket = options.socket || new net.Socket({ fd, readable: true, writable: true })
  if (!socket || typeof socket.on !== 'function' || typeof socket.write !== 'function') fail('GROK_RELAY_CONFIG_INVALID', 'Preconnected relay socket is invalid')
  const pending = []
  let buffer = '', terminal = null
  const rejectAll = error => { terminal ||= error; while (pending.length) pending.shift().reject(error) }
  socket.on('error', rejectAll); socket.on('close', () => rejectAll(new GrokRelayError('GROK_RELAY_CLOSED', 'Relay connection closed')))
  socket.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) return socket.destroy(new GrokRelayError('GROK_RELAY_LIMIT', 'Relay response exceeds limit'))
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      const current = pending.shift(); if (!current) return rejectAll(new GrokRelayError('GROK_RELAY_FAILURE', 'Relay response has no pending request'))
      try { current.resolve(JSON.parse(line)) } catch { current.reject(new GrokRelayError('GROK_RELAY_FAILURE', 'Relay response is invalid JSON')) }
    }
  })
  // Requests share one ordered, preconnected FD.  An abort after a frame has
  // been written cannot safely leave that FD available: the host can still
  // answer the old request, and a later request could consume that answer.
  // Close the channel instead so the server's close handler aborts its exact
  // upstream controller and every pending caller receives the same typed
  // terminal failure.
  const request = (value, signal) => new Promise((resolve, reject) => {
    if (terminal) return reject(terminal)
    if (signal?.aborted) return reject(new GrokRelayError('GROK_RELAY_ABORTED', 'Relay request was aborted before it was sent'))
    let settled = false
    const removeAbort = () => signal?.removeEventListener?.('abort', onAbort)
    const finish = (method, result) => {
      if (settled) return
      settled = true; removeAbort(); method(result)
    }
    const onAbort = () => {
      const error = new GrokRelayError('GROK_RELAY_ABORTED', 'Relay request was aborted')
      // `rejectAll` runs before destroy's asynchronous close event so an
      // aborted request cannot race a response frame already queued in libuv.
      rejectAll(error); socket.destroy(error)
    }
    const item = { resolve: result => finish(resolve, result), reject: error => finish(reject, error) }
    pending.push(item)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    socket.write(`${JSON.stringify(value)}\n`, error => { if (error) rejectAll(error) })
  })
  const fetch = async (_url, init = {}) => {
    if (init.method !== 'POST' || typeof init.body !== 'string') fail('GROK_RELAY_REQUEST_DENIED', 'Proxy attempted an invalid relay request')
    const message = await request({ token: relayToken, kind: 'model', request: { method: 'POST', path: '/v1/chat/completions', headers: init.headers || {}, body: init.body } }, init.signal)
    if (!object(message) || message.error || !Number.isSafeInteger(message.status) || typeof message.contentType !== 'string' || typeof message.body !== 'string') fail(message?.error?.code || 'GROK_RELAY_FAILURE', message?.error?.message || 'Relay response is invalid')
    const bytes = Buffer.from(message.body, 'utf8')
    return {
      status: message.status,
      headers: { get: name => name.toLowerCase() === 'content-type' ? message.contentType : null },
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      text: async () => message.body,
    }
  }
  return {
    fetch,
    close() { socket.destroy() },
    async mcp(value) {
      const message = await request({ token: relayToken, kind: 'mcp', request: value })
      if (!object(message) || !object(message.response)) fail('GROK_RELAY_FAILURE', 'MCP relay response is invalid')
      return message.response
    },
  }
}
function createPreconnectedRelayFetch(options = {}) { return createPreconnectedRelayClient(options).fetch }
function createUnixRelayFetch(options = {}) {
  const socketPath = validateRelayAddress(options.socketPath), relayToken = token(options.relayToken)
  const response = message => {
    if (!object(message) || message.error || !Number.isSafeInteger(message.status) || typeof message.contentType !== 'string' || typeof message.body !== 'string') {
      fail(message?.error?.code || 'GROK_RELAY_FAILURE', message?.error?.message || 'Relay response is invalid')
    }
    const bytes = Buffer.from(message.body, 'utf8')
    return {
      status: message.status,
      headers: { get: name => name.toLowerCase() === 'content-type' ? message.contentType : null },
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      text: async () => message.body,
    }
  }
  return async (_url, init = {}) => new Promise((resolve, reject) => {
    if (init.method !== 'POST' || typeof init.body !== 'string') return reject(new GrokRelayError('GROK_RELAY_REQUEST_DENIED', 'Proxy attempted an invalid relay request'))
    const socket = net.createConnection(socketPath); let data = ''
    socket.setTimeout(30000, () => socket.destroy(new GrokRelayError('GROK_RELAY_TIMEOUT', 'Relay request timed out')))
    // Keep the write side open until the relay has answered. The host relay
    // intentionally supports a persistent preconnected FD; ending this side
    // would make Node close the peer before its asynchronous upstream reply.
    socket.once('connect', () => socket.write(`${JSON.stringify({ token: relayToken, request: { method: 'POST', path: '/v1/chat/completions', headers: init.headers || {}, body: init.body } })}\n`))
    socket.on('data', chunk => {
      data += chunk
      if (Buffer.byteLength(data) > 32 * 1024 * 1024) return socket.destroy(new GrokRelayError('GROK_RELAY_LIMIT', 'Relay response exceeds limit'))
      const index = data.indexOf('\n'); if (index < 0) return
      const line = data.slice(0, index); socket.destroy()
      try {
        resolve(response(JSON.parse(line)))
      } catch (error) { reject(error) }
    })
    socket.once('error', reject)
    socket.once('close', () => {
      if (data.includes('\n')) return
      try {
        resolve(response(JSON.parse(data.trim())))
      } catch (error) { reject(error) }
    })
  })
}

module.exports = { GrokRelayError, createWindowsRelayPath, validateRelayAddress, createUnixRelay, createUnixRelayFetch, createPreconnectedRelayClient, createPreconnectedRelayFetch }
