'use strict'

const net = require('node:net')
const { StringDecoder } = require('node:string_decoder')

class GrokMcpRelayError extends Error { constructor(code, message) { super(message); this.name = 'GrokMcpRelayError'; this.code = code } }
const fail = (code, message) => { throw new GrokMcpRelayError(code, message) }
function inheritedListener(value, expectedPort) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.fd) || value.fd < 0 || value.host !== '::1' || value.port !== expectedPort) fail('GROK_MCP_RELAY_CONFIG_INVALID', 'Invalid inherited IPv6 MCP listener')
  return Object.freeze({ fd: value.fd, host: value.host, port: value.port })
}

function createMcpLoopbackServer(options = {}) {
  const port = options.port
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || typeof options.forward !== 'function') fail('GROK_MCP_RELAY_CONFIG_INVALID', 'MCP loopback configuration is invalid')
  const inherited = options.inheritedListener == null ? null : inheritedListener(options.inheritedListener, port)
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    const decoder = new StringDecoder('utf8'); let buffer = '', chain = Promise.resolve()
    socket.on('data', bytes => {
      buffer += decoder.write(bytes)
      if (Buffer.byteLength(buffer) > 5 * 1024 * 1024) return socket.destroy()
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line) continue
        chain = chain.then(async () => {
          const result = await options.forward(line)
          if (!result || typeof result.line !== 'string' || Buffer.byteLength(result.line) > 5 * 1024 * 1024) fail('GROK_MCP_RELAY_INVALID', 'Host MCP response is invalid')
          socket.write(`${result.line}\n`)
        }).catch(() => socket.destroy())
      }
    })
  })
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        const done = () => {
          server.off('error', reject)
          const address = server.address()
          if (!address || typeof address === 'string' || inherited && (address.address !== '::1' || address.family !== 'IPv6' || address.port !== port)) {
            try { server.close() } catch {}
            reject(new GrokMcpRelayError('GROK_MCP_RELAY_CONFIG_INVALID', 'Inherited MCP listener is not the authenticated IPv6 endpoint'))
            return
          }
          resolve()
        }
        if (inherited) server.listen({ fd: inherited.fd, exclusive: true }, done)
        else server.listen(port, '127.0.0.1', done)
      })
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
function parsePort(argv) {
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== '--port' || !/^\d+$/u.test(argv[1]) || argv.length === 4 && (argv[2] !== '--host' || argv[3] !== '::1')) fail('GROK_MCP_RELAY_CONFIG_INVALID', 'Use --port <loopback-port> [--host ::1]')
  return { port: Number(argv[1]), host: argv.length === 4 ? '::1' : '127.0.0.1' }
}
if (require.main === module) {
  const endpoint = parsePort(process.argv.slice(2))
  const socket = net.createConnection(endpoint.port, endpoint.host)
  socket.pipe(process.stdout); process.stdin.pipe(socket)
  socket.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
module.exports = { GrokMcpRelayError, createMcpLoopbackServer, parsePort }
