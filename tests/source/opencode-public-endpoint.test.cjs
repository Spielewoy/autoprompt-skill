'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { opencodePublicEndpoint } = require('../helpers/opencode-public-endpoint.cjs')

test('public OpenCode fixture refuses authentication only after verifying the mission request', async t => {
  let observed = 0
  const endpoint = await opencodePublicEndpoint({ onMission(body) {
    assert.deepEqual(body.messages, [{ role: 'user', content: 'exact public mission' }]); observed++
  } })
  t.after(() => endpoint.close())
  const response = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'exact public mission' }] }),
    signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 401); await response.text()
  assert.equal(observed, 1); assert.deepEqual(endpoint.errors, [])
})

test('an invalid activation proof cannot masquerade as the expected authentication refusal', async t => {
  const endpoint = await opencodePublicEndpoint({ onMission() { throw new Error('activation proof invalid') } })
  t.after(() => endpoint.close())
  const response = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 500); await response.text()
  assert.equal(endpoint.errors.length, 1)
  assert.equal(endpoint.errors[0].message, 'activation proof invalid')
})
