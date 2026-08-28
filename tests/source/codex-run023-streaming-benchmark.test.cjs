#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const { createCodexJsonlAccumulator } = require(path.join(
  ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js',
))

test('AP-RUN-023 production JSONL parsing keeps polling and retained memory bounded past 2 GiB', {
  timeout: 120_000,
}, t => {
  const accumulator = createCodexJsonlAccumulator()
  const payload = 'x'.repeat(128 * 1024)
  const line = JSON.stringify({ type: 'item.started', payload })
  const serializedEventBytes = Buffer.byteLength(line)
  const retainedEventByteLimit = 8 * 1024 * 1024
  const retainedEventCountLimit = 256
  const expectedRetainedEvents = Math.min(
    retainedEventCountLimit,
    Math.floor(retainedEventByteLimit / serializedEventBytes),
  )
  const iterations = Math.ceil((2 * 1024 * 1024 * 1024) / Buffer.byteLength(line))
  const logicalBytes = iterations * Buffer.byteLength(line)
  const heapStart = process.memoryUsage().heapUsed
  let heapPeak = heapStart
  let pollNanoseconds = 0n
  const started = process.hrtime.bigint()

  for (let index = 0; index < iterations; index += 1) {
    accumulator.push(line, index + 1)
    const pollStarted = process.hrtime.bigint()
    const watermark = accumulator.watermark()
    pollNanoseconds += process.hrtime.bigint() - pollStarted
    assert.equal(watermark.eventCount, index + 1)
    assert.equal(Object.hasOwn(watermark, 'events'), false)
    if ((index & 255) === 0) heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const averagePollMicroseconds = Number(pollNanoseconds) / iterations / 1e3
  const snapshot = accumulator.snapshot()
  heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
  const retainedHeapBytes = heapPeak - heapStart

  assert.ok(logicalBytes >= 2 * 1024 * 1024 * 1024, `logicalBytes=${logicalBytes}`)
  assert.equal(snapshot.eventCount, iterations)
  assert.equal(snapshot.events.length, expectedRetainedEvents)
  assert.equal(snapshot.retainedEventCount, expectedRetainedEvents)
  assert.equal(snapshot.retainedEventBytes, expectedRetainedEvents * serializedEventBytes)
  assert.ok(snapshot.retainedEventBytes <= retainedEventByteLimit)

  const countBounded = createCodexJsonlAccumulator()
  for (let index = 0; index < retainedEventCountLimit + 32; index += 1) {
    countBounded.push(JSON.stringify({ type: 'item.started', index }), index + 1)
  }
  const countSnapshot = countBounded.snapshot()
  assert.equal(countSnapshot.eventCount, retainedEventCountLimit + 32)
  assert.equal(countSnapshot.events.length, retainedEventCountLimit)
  assert.equal(countSnapshot.retainedEventCount, retainedEventCountLimit)
  assert.ok(countSnapshot.retainedEventBytes <= retainedEventByteLimit)
  assert.ok(retainedHeapBytes < 256 * 1024 * 1024, `retainedHeapBytes=${retainedHeapBytes}`)
  assert.ok(averagePollMicroseconds < 1000, `averagePollMicroseconds=${averagePollMicroseconds}`)
  t.diagnostic(JSON.stringify({
    logicalBytes, iterations, retainedEvents: snapshot.events.length,
    retainedHeapBytes, averagePollMicroseconds, elapsedMs,
  }))
})
