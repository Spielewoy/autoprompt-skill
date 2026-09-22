'use strict'
const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')
const { authenticationEndpoint, REFUSAL } = require('../helpers/native-activation-endpoint.cjs')
const { assertNamedCase } = require('../helpers/native-platform-ci.cjs')

function request(endpoint, pathname, body, credential = 'fixture-only', method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${endpoint.url}${pathname}`, { method, headers: {
      'content-type': 'application/json', 'x-api-key': credential } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text }))
    })
    req.on('error', reject)
    req.end(['HEAD', 'GET'].includes(method) ? undefined : JSON.stringify(body))
  })
}

test('admission endpoint requires real request authentication and observation before its fixed refusal', async t => {
  let observed = 0
  const endpoint = await authenticationEndpoint({ credential: 'fixture-only', onMission(_observation, value) {
    assert.equal(value.messages[0].content, 'private fixture'); observed++
  } })
  t.after(() => endpoint.close())
  assert.equal((await request(endpoint, '/api/hello', {})).status, 200)
  assert.equal((await request(endpoint, '/api/hello', {}, 'fixture-only', 'GET')).status, 200)
  assert.equal((await request(endpoint, '/api/hello', {}, 'fixture-only', 'HEAD')).status, 200)
  assert.equal((await request(endpoint, '/v1/messages/count_tokens', {})).status, 200)
  assert.equal(observed, 0)
  const result = await request(endpoint, '/v1/messages?beta=true', { messages: [{ role: 'user', content: 'private fixture' }] })
  assert.equal(result.status, 401)
  assert.equal(JSON.parse(result.body).error.message, REFUSAL)
  assert.equal(observed, 1)
  assert.deepEqual(endpoint.errors, [])
  assert.equal(endpoint.requests.every(item => item.authenticated), true)
})

test('admission endpoint never emits the expected refusal after a failed proof check', async t => {
  const failure = new Error('No genuine proof')
  const endpoint = await authenticationEndpoint({ credential: 'fixture-only', onMission() { throw failure } })
  t.after(() => endpoint.close())
  const result = await request(endpoint, '/v1/messages', { messages: ['fixture'] })
  assert.equal(result.status, 500)
  assert.doesNotMatch(result.body, new RegExp(REFUSAL))
  assert.equal(endpoint.errors[0], failure)
})

test('admission endpoint refuses wrong credentials, paths and oversized bodies before observation', async t => {
  let observed = 0
  const endpoint = await authenticationEndpoint({ credential: 'fixture-only', maxBytes: 128, onMission() { observed++ } })
  t.after(() => endpoint.close())
  assert.equal((await request(endpoint, '/v1/messages', { messages: ['fixture'] }, 'wrong')).status, 500)
  assert.equal((await request(endpoint, '/external', {})).status, 500)
  // A complete bounded HTTP body is rejected without closing its response pipe.
  assert.equal((await request(endpoint, '/v1/messages', { messages: ['x'.repeat(130)] })).status, 500)
  assert.equal(observed, 0)
  assert.equal(endpoint.errors.length, 3)
})

test('admission endpoint closes idle clients and bounds repeated requests', async () => {
  const endpoint = await authenticationEndpoint({ credential: 'fixture-only', maxRequests: 1, onMission() {} })
  await request(endpoint, '/api/hello', {})
  assert.equal((await request(endpoint, '/api/hello', {})).status, 500)
  assert.equal(endpoint.requests.length, 1)
  await endpoint.close()
  await assert.rejects(request(endpoint, '/api/hello', {}))
})

test('public activation certification requires the exact real native test without skips or duplicates', () => {
  const name = 'packed public Claude activate admits a fresh native canary before controlled endpoint refusal and revokes'
  assertNamedCase(`ok 1 - ${name}\n`, name)
  for (const output of ['', `ok 1 - ${name} # SKIP unavailable`, `not ok 1 - ${name}`,
    `ok 1 - ${name}\nok 2 - ${name}`, `ok 1 - simulated ${name}`]) assert.throws(() => assertNamedCase(output, name))
})
