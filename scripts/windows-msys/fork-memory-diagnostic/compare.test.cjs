'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { observeAll, VARIANTS, assertComparable } = require('./compare.cjs')

test('fork policy comparison preserves failures and still executes each fixed arm once', () => {
  const calls = []
  const arms = observeAll(variant => {
    calls.push(variant)
    if (variant === 'baseline') throw new Error('watchdog expired')
    return { completed: variant === 'heva-off', exitCode: variant === 'heva-off' ? 0 : 1 }
  })
  assert.deepEqual(calls, VARIANTS)
  assert.deepEqual(arms, [
    { variant: 'baseline', completed: false, error: 'watchdog expired' },
    { variant: 'heva-off', completed: true, exitCode: 0 },
    { variant: 'bottom-up-off', completed: false, exitCode: 1 },
  ])
})

test('policy comparison refuses runtime or source changes between completed arms', () => {
  const observation = { tuple: { identity: 'a'.repeat(64) }, runtime: { bashSha256: 'b'.repeat(64), dllSha256: 'c'.repeat(64), sharedId: 'msys-test' }, sourceHashes: { native: 'd'.repeat(64) } }
  const arm = { completed: true, observation }
  assert.deepEqual(assertComparable([arm, structuredClone(arm)]), observation)
  for (const field of ['tuple', 'runtime', 'sourceHashes']) {
    const changed = structuredClone(arm)
    changed.observation[field].foreign = true
    assert.throws(() => assertComparable([arm, changed]), /different runtime or source inputs/)
  }
  assert.throws(() => assertComparable([{ completed: true, observation: null }]), /no observation/)
})
