'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { StderrCapture } = require('./adapter.cjs')

test('physical capture admits only entirely quiet stderr and complete stdout', () => {
  new StderrCapture().assertQuiet('')
  assert.throws(() => new StderrCapture().assertQuiet('unfinished'), /lease-output-refused/)
  for (const bytes of [Buffer.from('#< CLIXML\r\n<Objs><Obj S="progress" /></Objs>'),
    Buffer.from('warning'), Buffer.from('native error'), Buffer.from([0])]) {
    const output = new StderrCapture()
    output.append(bytes)
    assert.throws(() => output.assertQuiet(''), /lease-output-refused/)
    assert.deepEqual(Buffer.from(output.diagnostic({ phase: 'finished', closed: true, code: 0 }, '').stderrBase64, 'base64'), bytes)
  }
})

test('physical capture diagnostics retain a bounded exact prefix across chunks', () => {
  const output = new StderrCapture()
  output.append(Buffer.alloc(1000, 1))
  assert.throws(() => output.append(Buffer.alloc(100000, 2)), /lease-stderr-bound/)
  const record = output.diagnostic({ phase: 'starting', closed: false, code: null }, 'x'.repeat(10000))
  assert.equal(record.stderrBytes, 101000)
  assert.deepEqual(Buffer.from(record.stderrBase64, 'base64'), Buffer.concat([Buffer.alloc(1000, 1), Buffer.alloc(24, 2)]))
  assert.equal(Buffer.from(record.pendingStdoutBase64, 'base64').length, 256)
  assert.equal(record.phase, 'starting')
  assert.equal(record.closed, false)
  assert.equal(record.exitCode, null)
  assert.equal(Object.isFrozen(record), true)
  assert.throws(() => output.assertQuiet(''), /lease-output-refused/)
})

test('physical capture rejects one extra stderr byte after the exact bound', () => {
  const output = new StderrCapture()
  output.append(Buffer.alloc(1024, 3))
  assert.throws(() => output.append(Buffer.from([4])), /lease-stderr-bound/)
  assert.equal(output.bytes.length, 1024)
  assert.equal(output.length, 1025)
})
