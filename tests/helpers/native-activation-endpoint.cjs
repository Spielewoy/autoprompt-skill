'use strict'

const http = require('node:http')

// Admission-only fixture: no model response or activation proof is synthesized.
// The real CLI reaches this endpoint only after the public supervisor's canary.
const REFUSAL = 'AUTOPROMPT_NATIVE_ADMISSION_FIXTURE_AUTH_REFUSED'
async function authenticationEndpoint({ credential, onMission, maxRequests = 32, maxBytes = 8 * 1024 * 1024 }) {
  if (typeof credential !== 'string' || !credential || typeof onMission !== 'function') throw new Error('Invalid admission fixture configuration')
  const requests = [], errors = []
  const server = http.createServer(async (req, res) => {
    try {
      if (requests.length >= maxRequests) throw new Error('Admission fixture request limit exceeded')
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      const observation = { method: req.method, pathname, authenticated: req.headers['x-api-key'] === credential || req.headers.authorization === `Bearer ${credential}` }
      requests.push(observation)
      let bytes = 0, body = ''
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > maxBytes) throw new Error('Admission fixture body limit exceeded')
        body += chunk.toString('utf8')
      }
      const value = JSON.parse(body || '{}')
      if (pathname === '/api/hello' && ['HEAD', 'GET', 'POST'].includes(req.method) && Object.keys(value).length === 0) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return
      }
      if (req.method !== 'POST') throw new Error('Unexpected admission fixture method')
      if (!observation.authenticated) throw new Error('Admission fixture credential mismatch')
      if (pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return
      }
      if (pathname !== '/v1/messages' || !Array.isArray(value.messages) || value.messages.length === 0) throw new Error('Unexpected admission fixture request')
      await onMission(observation, value)
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: REFUSAL } }))
    } catch (error) {
      errors.push(error)
      if (!res.headersSent && !res.destroyed) res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"type":"error","error":{"type":"fixture_error","message":"Admission fixture rejected request"}}')
    }
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.maxRequestsPerSocket = maxRequests
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}`, requests, errors,
    close: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Admission fixture close was not confirmed')), 2000)
      server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve() })
      server.closeAllConnections()
    }) }
}

module.exports = { authenticationEndpoint, REFUSAL }
