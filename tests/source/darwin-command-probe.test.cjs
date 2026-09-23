'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createInFlightProbe } = require('../../scripts/darwin-command-probe.cjs')

test('Darwin command admission shares only one in-flight proof and revalidates sequential calls', async () => {
  let calls = 0, release
  const probe = createInFlightProbe(async () => {
    calls++
    await new Promise(resolve => { release = resolve })
    return { supported: true, generation: calls }
  })
  const first = probe(), concurrent = probe()
  assert.strictEqual(concurrent, first)
  assert.equal(calls, 0, 'probe begins on the next microtask')
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await Promise.all([first, concurrent]), [{ supported: true, generation: 1 }, { supported: true, generation: 1 }])

  const sequential = probe()
  await Promise.resolve()
  assert.equal(calls, 2, 'a settled proof must never become an admission cache')
  release()
  assert.deepEqual(await sequential, { supported: true, generation: 2 })
})

test('Darwin command admission clears a rejected in-flight proof before retry', async () => {
  let calls = 0
  const probe = createInFlightProbe(async () => {
    calls++
    if (calls === 1) throw Object.assign(new Error('injected native refusal'), { code: 'COMMAND_SANDBOX_UNSUPPORTED' })
    return { supported: true }
  })
  const first = probe(), concurrent = probe()
  assert.strictEqual(concurrent, first)
  await assert.rejects(first, { code: 'COMMAND_SANDBOX_UNSUPPORTED' })
  assert.deepEqual(await probe(), { supported: true })
  assert.equal(calls, 2)
})
