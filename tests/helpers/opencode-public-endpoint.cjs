'use strict'

const http = require('node:http')

async function opencodePublicEndpoint(options = {}) {
  const requests = [], errors = []
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('fixture request exceeds eight MiB')
      }
      requests.push({ method: req.method, path: req.url, body: JSON.parse(body || '{}') })
      if (req.method !== 'POST' || !req.url.includes('/chat/completions')) throw new Error(`unexpected OpenCode request ${req.method} ${req.url}`)
      options.onMission?.(requests[requests.length - 1].body)
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'issue-28 deliberate local authentication refusal', type: 'authentication_error' } }))
    } catch (error) {
      errors.push(error)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fixture rejected request' } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}`, requests, errors,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

module.exports = { opencodePublicEndpoint }
