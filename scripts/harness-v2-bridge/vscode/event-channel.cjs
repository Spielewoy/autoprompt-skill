'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

// HarnessEventStream admits one raw event of up to 8 MiB.  The authenticated
// channel adds a fixed JSON envelope, so retain a small finite allowance for
// that envelope without increasing the admitted event payload ceiling.
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const MAX_FRAME_BYTES = MAX_EVENT_BYTES + 16 * 1024
const MAX_EVENTS = 1024
const HANDSHAKE_TIMEOUT_MS = 5000
const CLOSE_TIMEOUT_MS = 2000
const TOKEN = /^[A-Za-z0-9_-]{43}$/u

class VscodeEventChannelError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VscodeEventChannelError'
    this.code = code
  }
}
function fail(code, message) { throw new VscodeEventChannelError(code, message) }
// Admit an existing scratch directory only when it is the authenticated
// physical private directory. Never follow an existing symlink here.
function ensurePrivateDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error
  }
  let item
  try {
    item = fs.lstatSync(directory)
  } catch { fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event scratch directory is unavailable') }
  // The authenticated VS Code alias intentionally contributes a symlinked
  // ancestor; only the scratch component itself must be physical.
  if (!item.isDirectory() || item.isSymbolicLink() ||
      (typeof process.getuid === 'function' && item.uid !== process.getuid()) || (item.mode & 0o077)) {
    fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event scratch directory is not an owned private directory')
  }
  return directory
}
function exact(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === fields.slice().sort().join('\0')
}
function endpointValid(endpoint, platform = process.platform) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.includes('\0')) return false
  return platform === 'win32'
    ? /^\\\\\.\\pipe\\autoprompt-vscode-[a-f0-9]{64}$/u.test(endpoint)
    : path.isAbsolute(endpoint) && path.resolve(endpoint) === endpoint
}
function descriptorValid(value, platform = process.platform) {
  return exact(value, ['version', 'endpoint', 'token', 'sessionId', 'reservationId']) &&
    value.version === 1 && endpointValid(value.endpoint, platform) && TOKEN.test(value.token) &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 256 && !value.sessionId.includes('\0') &&
    typeof value.reservationId === 'string' && /^[a-f0-9-]{36}$/u.test(value.reservationId)
}
function descriptor(options = {}) {
  const value = {
    version: 1,
    endpoint: options.endpoint,
    token: crypto.randomBytes(32).toString('base64url'),
    sessionId: options.sessionId,
    reservationId: options.reservationId,
  }
  if (!descriptorValid(value)) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel descriptor is invalid')
  return Object.freeze(value)
}
function privateSocketParent(endpoint, allowAliasParent = false) {
  const parent = path.dirname(endpoint)
  let item, real
  try { item = fs.lstatSync(parent); real = fs.realpathSync.native(parent) } catch { fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel parent is unavailable') }
  if (!item.isDirectory() || item.isSymbolicLink() || (!allowAliasParent && real !== parent) || (process.getuid && item.uid !== process.getuid()) || (item.mode & 0o077)) {
    fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel parent is not an owned private directory')
  }
}
function socketIdentity(endpoint) {
  let item
  try { item = fs.lstatSync(endpoint) } catch { fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel endpoint disappeared') }
  if (!item.isSocket() || item.isSymbolicLink()) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel endpoint is not its owned socket')
  return Object.freeze({ dev: item.dev, ino: item.ino })
}
function verifyOwnedSocket(endpoint, identity) {
  if (process.platform === 'win32') return
  const current = socketIdentity(endpoint)
  if (current.dev !== identity.dev || current.ino !== identity.ino) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel endpoint identity changed before cleanup')
}
function verifySocketRemoved(endpoint) {
  if (process.platform === 'win32') return
  try { fs.lstatSync(endpoint) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel endpoint was retained after server close')
}
function parseFrame(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event frame exceeds its bound')
  try { return JSON.parse(text) } catch { fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event frame is not JSON') }
}
function writeFrame(socket, value) {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event frame exceeds its bound')
  return new Promise((resolve, reject) => socket.write(`${text}\n`, error => error ? reject(error) : resolve()))
}
function closeServer(server, peer) {
  try { peer?.destroy() } catch {}
  return new Promise(resolve => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    const timer = setTimeout(finish, CLOSE_TIMEOUT_MS)
    server.close(() => { clearTimeout(timer); finish() })
  })
}
function createServer(options = {}) {
  const value = options.descriptor
  if (!descriptorValid(value)) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel descriptor is invalid')
  if (typeof options.onEvent !== 'function') fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel requires an event consumer')
  if (process.platform !== 'win32') privateSocketParent(value.endpoint, options.allowAliasParent === true)
  let failure = null, completed = false, connected = false, closed = false, peer = null, endpointIdentity = null
  const failOnce = error => {
    if (failure) return
    failure = error instanceof VscodeEventChannelError ? error : new VscodeEventChannelError('VSCODE_EVENT_CHANNEL_FAILED', 'VS Code event channel failed')
    try { options.onFailure?.(failure) } catch {}
    try { peer?.destroy() } catch {}
  }
  const server = net.createServer(connection => {
    if (connected || closed || failure) { connection.destroy(); return }
    connected = true; peer = connection
    let buffer = '', ready = false, expected = 0
    const handshakeTimer = setTimeout(() => failOnce(new VscodeEventChannelError('VSCODE_EVENT_CHANNEL_INCOMPLETE', 'VS Code event channel did not authenticate promptly')), HANDSHAKE_TIMEOUT_MS)
    connection.setEncoding('utf8')
    connection.on('error', () => failOnce(new VscodeEventChannelError('VSCODE_EVENT_CHANNEL_FAILED', 'VS Code event channel socket failed')))
    connection.on('close', () => { clearTimeout(handshakeTimer); if (!completed) failOnce(new VscodeEventChannelError('VSCODE_EVENT_CHANNEL_INCOMPLETE', 'VS Code event channel closed before completion')) })
    connection.on('data', chunk => {
      if (failure) return
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) { failOnce(new VscodeEventChannelError('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel frame exceeds its bound')); return }
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        try {
          if (completed) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel received a frame after completion')
          const frame = parseFrame(line)
          if (!ready) {
            if (!exact(frame, ['type', 'token', 'sessionId', 'reservationId']) || frame.type !== 'hello' ||
                frame.sessionId !== value.sessionId || frame.reservationId !== value.reservationId ||
                typeof frame.token !== 'string' || frame.token.length !== value.token.length || !crypto.timingSafeEqual(Buffer.from(frame.token), Buffer.from(value.token))) {
              fail('VSCODE_EVENT_CHANNEL_AUTH_FAILED', 'VS Code event channel handshake is invalid')
            }
            ready = true; clearTimeout(handshakeTimer); void writeFrame(connection, { type: 'ready' }).catch(failOnce); continue
          }
          if (exact(frame, ['type', 'sequence', 'event']) && frame.type === 'event' && Number.isSafeInteger(frame.sequence) && frame.sequence === expected + 1 && expected < MAX_EVENTS &&
              frame.event && typeof frame.event === 'object' && !Array.isArray(frame.event)) {
            const rawEvent = JSON.stringify(frame.event)
            if (Buffer.byteLength(rawEvent, 'utf8') > MAX_EVENT_BYTES) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event exceeds the HarnessEventStream bound')
            options.onEvent(rawEvent); expected = frame.sequence
            void writeFrame(connection, { type: 'ack', sequence: expected }).catch(failOnce); continue
          }
          if (exact(frame, ['type', 'sequence']) && frame.type === 'complete' && Number.isSafeInteger(frame.sequence) && frame.sequence === expected + 1) {
            expected = frame.sequence; completed = true
            void writeFrame(connection, { type: 'complete', sequence: expected }).then(() => connection.end()).catch(failOnce); continue
          }
          fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel frame violates its sequence')
        } catch (error) { failOnce(error) }
      }
    })
  })
  // Keep an error consumer after listen succeeds: a late server error must
  // fail the authenticated channel rather than becoming an unhandled EventEmitter error.
  server.on('error', failOnce)
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(value.endpoint, () => {
      server.removeListener('error', reject)
      try { if (process.platform !== 'win32') endpointIdentity = socketIdentity(value.endpoint); resolve() } catch (error) { reject(error) }
    })
  }).catch(error => { failOnce(error); throw failure })
  return Object.freeze({
    descriptor: Object.freeze({ ...value }),
    async ready() { await listening },
    assertComplete() {
      if (failure) throw failure
      if (!completed) fail('VSCODE_EVENT_CHANNEL_INCOMPLETE', 'VS Code event channel did not complete')
    },
    retain() {
      // An undrained owner remains authoritative, but its listener must not
      // keep an otherwise-complete controller process alive. The endpoint and
      // listener remain available until explicit process teardown/recovery.
      try { server.unref(); peer?.unref?.() } catch {}
    },
    async close() {
      closed = true
      await listening.catch(() => {})
      try { if (endpointIdentity) verifyOwnedSocket(value.endpoint, endpointIdentity) } catch (error) {
        // Node's Unix Server.close() unlinks the configured pathname. Once
        // identity changed, closing it would delete a foreign replacement;
        // leave the unlinked listener for process teardown instead.
        try { peer?.destroy(); server.unref() } catch {}
        throw error
      }
      await closeServer(server, peer)
      if (endpointIdentity) verifySocketRemoved(value.endpoint)
    },
  })
}
function connect(value) {
  if (!descriptorValid(value)) fail('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel descriptor is invalid')
  let socket, buffer = '', sequence = 0, terminal = false, failure = null, sendTail = Promise.resolve()
  const waiters = []
  const channelError = (code, message) => new VscodeEventChannelError(code, message)
  const rejectAll = error => { while (waiters.length) waiters.shift().reject(error) }
  const failClient = error => {
    if (!failure) failure = error instanceof VscodeEventChannelError ? error : channelError('VSCODE_EVENT_CHANNEL_FAILED', 'VS Code event channel failed')
    rejectAll(failure)
    try { socket?.destroy() } catch {}
    return failure
  }
  const take = predicate => new Promise((resolve, reject) => waiters.push({ predicate, resolve, reject }))
  const receive = chunk => {
    try {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) throw channelError('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel response exceeds its bound')
      for (;;) {
        const index = buffer.indexOf('\n'); if (index < 0) break
        const frame = parseFrame(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        const waiter = waiters.shift()
        if (!waiter || !waiter.predicate(frame)) {
          const error = channelError('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event channel acknowledgement is invalid')
          waiter?.reject(error); throw error
        }
        waiter.resolve(frame)
      }
    } catch (error) { failClient(error) }
  }
  const open = new Promise((resolve, reject) => {
    socket = net.createConnection(value.endpoint)
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.once('connect', async () => {
      try {
        socket.on('data', receive)
        socket.on('error', error => failClient(error))
        socket.on('close', () => { if (!terminal) failClient(channelError('VSCODE_EVENT_CHANNEL_INCOMPLETE', 'VS Code event channel closed before completion')) })
        const ready = take(frame => exact(frame, ['type']) && frame.type === 'ready')
        // `writeFrame` can fail before the socket close rejects `ready`; mark
        // it handled now while still awaiting it as the authoritative result.
        ready.catch(() => {})
        await writeFrame(socket, { type: 'hello', token: value.token, sessionId: value.sessionId, reservationId: value.reservationId })
        await ready; resolve()
      } catch (error) { failClient(error); reject(error) }
    })
  })
  const dispatch = async (type, event) => {
    await open
    if (failure) throw failure
    if (terminal) fail('VSCODE_EVENT_CHANNEL_INCOMPLETE', 'VS Code event channel already completed')
    if (type === 'event') {
      try {
        if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
          throw channelError('VSCODE_EVENT_CHANNEL_INVALID', 'VS Code event exceeds the HarnessEventStream bound')
        }
      } catch (error) { throw failClient(error) }
    }
    const next = sequence + 1
    const response = take(frame => type === 'event'
      ? exact(frame, ['type', 'sequence']) && frame.type === 'ack' && frame.sequence === next
      : exact(frame, ['type', 'sequence']) && frame.type === 'complete' && frame.sequence === next)
    // See the handshake equivalent above. The response remains awaited below.
    response.catch(() => {})
    try {
      await writeFrame(socket, type === 'event' ? { type, sequence: next, event } : { type, sequence: next })
      await response
    } catch (error) { throw failClient(error) }
    sequence = next
    if (type === 'complete') terminal = true
  }
  const send = (type, event) => {
    const action = sendTail.then(() => dispatch(type, event))
    // Keep the serial tail live after a rejected caller while preserving that
    // rejection for the caller that caused it.
    sendTail = action.catch(() => {})
    return action
  }
  return Object.freeze({ emit: event => send('event', event), complete: () => send('complete') })
}

module.exports = { VscodeEventChannelError, createServer, connect, descriptor, descriptorValid, endpointValid, ensurePrivateDirectory }
