'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { testPlan, verifyResult } = require('../helpers/provider-platform-ci.cjs')
const plan = testPlan('opencode')
function transcript(lines, { pass = 11, skipped = 0, fail = 0, cancelled = 0 } = {}) {
  return `${lines.join('\n')}\n# tests ${pass + skipped + fail + cancelled}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo 0\n`
}
const passed = plan.cases.map((name, index) => `ok ${index + 1} - ${name}`)

test('provider CI requires every exact capability and permits only unselected test skips', () => {
  const result = verifyResult(plan, { code: 0, signal: null }, transcript([...passed, 'ok 12 - another provider # SKIP'], { skipped: 1 }))
  assert.equal(result.cases.length, 11)
  assert.ok(result.cases.every(item => item.status === 'passed'))
  assert.throws(() => verifyResult(plan, { code: 0 }, transcript(passed.slice(1))))
  assert.throws(() => verifyResult(plan, { code: 0 }, transcript([...passed.slice(1), `${passed[0]} # SKIP`], { pass: 10, skipped: 1 })))
  assert.throws(() => verifyResult(plan, { code: 0 }, transcript([...passed, passed[0]], { pass: 12 })))
  assert.throws(() => verifyResult(plan, { code: 1 }, transcript(passed)))
  assert.throws(() => verifyResult(plan, { code: 0, signal: 'SIGTERM' }, transcript(passed)))
})

test('provider CI never replaces a missing registered suite with a generic passing test', () => {
  assert.throws(() => testPlan('codex'), /No complete native capability suite/)
  assert.throws(() => testPlan('unknown'), /No complete native capability suite/)
  const pattern = new RegExp(plan.argv[plan.argv.indexOf('--test-name-pattern') + 1])
  assert.ok(plan.cases.every(name => pattern.test(name)))
  assert.equal(pattern.test('kilo closed native capability: isolation'), false)
})

test('provider CI can select one registered capability while preserving all-capability evidence semantics', () => {
  assert.deepEqual(testPlan('prime', 'all'), testPlan('prime'))
  assert.deepEqual(testPlan('prime', ''), testPlan('prime'))
  const selected = testPlan('prime', 'isolatedChecking')
  assert.equal(selected.capability, 'isolatedChecking')
  assert.equal(selected.cases.length, 1)
  assert.equal(selected.allCases.length, 11)
  const result = verifyResult(selected, { code: 0, signal: null }, transcript(selected.cases.map(name => `ok 1 - ${name}`), { pass: 1 }))
  assert.equal(result.cases.length, 1)
  assert.throws(() => testPlan('prime', 'not-a-capability'), /Unknown native capability/)
})
