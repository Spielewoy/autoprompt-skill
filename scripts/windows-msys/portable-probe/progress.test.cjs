'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createProgress, boundedError, createBoundedJsonl } = require('./progress.cjs')
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-progress-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
test('fresh progress binds one immutable tuple digest to all subsequent native stages', t => {
  const root = directory(t), output = []
  const reporter = createProgress(root, bytes => output.push(Buffer.from(bytes)))
  reporter.record('capturing')
  assert.throws(() => reporter.record('captured'), /Captured tuple required/)
  const tuple = { accepted: false, manifestSha256: 'a'.repeat(64) }
  const digest = reporter.bindTuple(tuple)
  tuple.manifestSha256 = 'b'.repeat(64)
  assert.throws(() => reporter.bindTuple(tuple), /bound only once/)
  for (const phase of ['captured', 'bash-smoke-started', 'bash-smoke-passed', 'posix-started', 'completed']) reporter.record(phase)
  const records = output.map(bytes => JSON.parse(bytes))
  assert.equal(records[0].tupleSha256, null)
  assert.ok(records.slice(1).every(record => record.tupleSha256 === digest))
  assert.deepEqual(records.map(record => record.sequence), [1, 2, 3, 4, 5, 6])
  assert.ok(Buffer.concat(output).equals(fs.readFileSync(path.join(root, 'progress.jsonl'))))
  assert.throws(() => reporter.record('failed'), /finished progress/)
  assert.throws(() => createProgress(root), /EEXIST/)
})
test('progress refuses skipped stages, reused authority and oversized diagnostics before writing', t => {
  const root = directory(t), reporter = createProgress(root, () => {})
  assert.throws(() => reporter.record('completed'), /phase order/)
  assert.throws(() => reporter.bindTuple({ accepted: true }), /accepted tuple/)
  assert.throws(() => reporter.record('capturing', { value: 'x'.repeat(20 * 1024) }), /byte bound/)
  assert.equal(fs.statSync(path.join(root, 'progress.jsonl')).size, 0)
  reporter.record('failed', boundedError(new Error('x'.repeat(100000))))
  assert.ok(fs.statSync(path.join(root, 'progress.jsonl')).size < 3000)
})
test('error diagnostics preserve unknown cleanup without unbounded strings', () => {
  const error = new Error('x'.repeat(100000))
  error.cleanupConfirmed = false
  error.retainedHelperRoot = 'C:\\' + 'a'.repeat(100000)
  const record = boundedError(error)
  assert.equal(record.cleanupConfirmed, false)
  assert.equal(record.message.length, 2048)
  assert.equal(record.retainedHelperRoot.length, 2048)
  assert.equal(boundedError(Error('other')).cleanupConfirmed, null)
})
test('native JSONL refuses oversized records and total output without erasing prior evidence', t => {
  const root = directory(t), file = path.join(root, 'native.jsonl')
  const emit = createBoundedJsonl(file, () => {})
  emit({ status: 'bound' })
  const previous = fs.readFileSync(file)
  assert.throws(() => emit({ value: 'x'.repeat(256 * 1024) }), /log bound/)
  assert.deepEqual(fs.readFileSync(file), previous)
  for (let i = 0; i < 10; i++) emit({ value: 'x'.repeat(190 * 1024) })
  const size = fs.statSync(file).size
  assert.throws(() => emit({ value: 'x'.repeat(190 * 1024) }), /log bound/)
  assert.equal(fs.statSync(file).size, size)
})
