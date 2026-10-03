'use strict'
// Diagnostic observations only. This emitter never grants execution authority.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { canonical } = require('../portable-runtime/portable.cjs')
const MAX_LINE = 16 * 1024
const MAX_TOTAL = 256 * 1024
const PHASES = ['capturing', 'captured', 'bash-smoke-started', 'bash-smoke-passed', 'posix-started', 'completed', 'failed']
function createProgress(output, emit = bytes => process.stdout.write(bytes)) {
  const file = path.join(output, 'progress.jsonl')
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
  let sequence = 0, total = 0, tupleSha256 = null, finished = false
  return Object.freeze({
    bindTuple(tuple) {
      assert.equal(tupleSha256, null, 'Progress tuple may be bound only once')
      assert.equal(tuple.accepted, false, 'Progress never carries an accepted tuple')
      tupleSha256 = crypto.createHash('sha256').update(canonical(tuple)).digest('hex')
      return tupleSha256
    },
    record(phase, details = {}) {
      assert.ok(PHASES.includes(phase) && !finished, 'Invalid or finished progress phase')
      assert.ok(phase === 'failed' || phase === PHASES[sequence], 'Progress phase order')
      assert.ok(phase === 'capturing' || phase === 'failed' || tupleSha256 !== null,
        'Captured tuple required for native progress')
      assert.ok(sequence < 16, 'Progress record bound')
      assert.ok(details && typeof details === 'object' && !Array.isArray(details))
      const bytes = canonical({ schema: 1, sequence: sequence + 1, phase, tupleSha256,
        status: 'diagnostic-observation-not-runtime-acceptance', details })
      assert.ok(bytes.length <= MAX_LINE && total + bytes.length <= MAX_TOTAL, 'Progress byte bound')
      fs.appendFileSync(file, bytes)
      emit(bytes)
      sequence++; total += bytes.length
      if (phase === 'completed' || phase === 'failed') finished = true
    },
  })
}
function boundedError(error) {
  return Object.freeze({ name: String(error?.name || 'Error').slice(0, 128),
    message: String(error?.message || error).slice(0, 2048),
    cleanupConfirmed: error?.cleanupConfirmed === true ? true : error?.cleanupConfirmed === false ? false : null,
    retainedHelperRoot: typeof error?.retainedHelperRoot === 'string' ? error.retainedHelperRoot.slice(0, 2048) : null })
}
function createBoundedJsonl(file, emit = bytes => process.stdout.write(bytes)) {
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
  let count = 0, total = 0
  return record => {
    const bytes = canonical(record)
    assert.ok(count < 64 && bytes.length <= 256 * 1024 && total + bytes.length <= 2 * 1024 * 1024,
      'Native diagnostic log bound')
    fs.appendFileSync(file, bytes)
    emit(bytes)
    count++; total += bytes.length
  }
}
module.exports = { createProgress, boundedError, createBoundedJsonl, MAX_LINE, MAX_TOTAL }
