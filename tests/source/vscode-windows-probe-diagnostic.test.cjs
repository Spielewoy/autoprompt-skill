'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { superviseOwnedRun } = require('../helpers/vscode-windows-probe-diagnostic.cjs')

test('VS Code diagnostic starts its runtime deadline only after late owned registration', async () => {
  let clock = 0, registered = false, stopCalls = 0, resolveRun
  const runPromise = new Promise(resolve => { resolveRun = resolve })
  const wait = async milliseconds => {
    clock += milliseconds
    if (clock >= 60 && !registered) registered = true
    if (registered && clock >= 70) resolveRun({ drained: true, status: 0 })
  }
  const result = await superviseOwnedRun({ runPromise, isRegistered: () => registered, registrationTimeoutMs: 100,
    executionTimeoutMs: 20, settlementTimeoutMs: 20, wait, now: () => clock, stop: async () => { stopCalls++; return { drained: true } }, forceStop: async () => assert.fail('late registration must not use forced cleanup') })
  assert.equal(result.timedOut, false)
  assert.equal(result.execution.status, 0)
  assert.equal(stopCalls, 0)
})

test('VS Code diagnostic registration timeout uses one bounded owner drain and never retries runner stop', async () => {
  let clock = 0, forceCalls = 0, stopCalls = 0, rejectRun
  const runPromise = new Promise((resolve, reject) => { rejectRun = reject })
  const resultPromise = superviseOwnedRun({ runPromise, isRegistered: () => false, registrationTimeoutMs: 40,
    executionTimeoutMs: 20, settlementTimeoutMs: 20, wait: async milliseconds => { clock += milliseconds }, now: () => clock,
    stop: async () => { stopCalls++; return { alreadyTerminal: true } },
    forceStop: async () => { forceCalls++; rejectRun(Object.assign(new Error('owned reservation cancelled'), { code: 'CHILD_CANCELLED' })); return { drained: true, forced: true } },
  })
  const result = await resultPromise
  assert.equal(result.timedOut, true)
  assert.equal(result.error.code, 'CHILD_CANCELLED')
  assert.equal(forceCalls, 1)
  assert.equal(stopCalls, 0)
  assert.equal(result.stopResult.drained, true)
})

test('VS Code diagnostic execution timeout accepts only stop settlement or a forced owner drain', async () => {
  let resolveRun, forceCalls = 0
  const runPromise = new Promise(resolve => { resolveRun = resolve })
  const result = await superviseOwnedRun({ runPromise, isRegistered: () => true, registrationTimeoutMs: 100,
    executionTimeoutMs: 1, settlementTimeoutMs: 20, wait: async () => {},
    stop: async () => ({ alreadyTerminal: true }),
    forceStop: async () => { forceCalls++; resolveRun({ drained: true, status: 0 }); return { drained: true, forced: true } },
  })
  assert.equal(result.timedOut, true)
  assert.equal(forceCalls, 1)
  assert.equal(result.stopResult.forced, true)
})

test('VS Code diagnostic retains an unknown run that never settles after a successful force-drain snapshot', async () => {
  const result = await superviseOwnedRun({ runPromise: new Promise(() => {}), isRegistered: () => false,
    registrationTimeoutMs: 1, executionTimeoutMs: 1, settlementTimeoutMs: 1, wait: async () => {},
    now: (() => { let tick = 0; return () => tick++ })(), stop: async () => assert.fail('unregistered run must not use runner stop'),
    forceStop: async () => ({ drained: true, forced: true }) })
  assert.equal(result.timedOut, true)
  assert.equal(result.unsettled, true)
  assert.equal(result.stopResult.drained, true)
})

test('VS Code diagnostic bounds settlement after a rejected force-drain and preserves the failure', async () => {
  const failure = Object.assign(new Error('unknown native ownership'), { code: 'PROCESS_DRAIN_TIMEOUT' })
  const result = await superviseOwnedRun({ runPromise: new Promise(() => {}), isRegistered: () => false,
    registrationTimeoutMs: 1, executionTimeoutMs: 1, settlementTimeoutMs: 1, wait: async () => {},
    now: (() => { let tick = 0; return () => tick++ })(), stop: async () => assert.fail('unregistered run must not use runner stop'),
    forceStop: async () => { throw failure } })
  assert.equal(result.timedOut, true)
  assert.equal(result.unsettled, true)
  assert.strictEqual(result.error, failure)
})
