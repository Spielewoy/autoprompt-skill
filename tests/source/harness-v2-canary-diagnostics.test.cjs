'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { diagnoseNativeCanary, MAX_STATUS_BYTES, MAX_OUTPUT_CHARS, MAX_STATUSES, MAX_STREAM_BYTES } = require('../helpers/native-canary-diagnostics.cjs')

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-diagnostic-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'reviewed-local-canary', 'generation-1')
  fs.mkdirSync(directory, { recursive: true })
  return { root, directory, activation: { activationRoot: root, record: { capability: { generation: 1 } } } }
}

test('native canary failure diagnostics preserve child TAP and stderr without reading request environment', t => {
  const f = fixture(t), id = crypto.randomUUID(), messages = []
  fs.writeFileSync(path.join(f.directory, `outer-${id}.status.json`), JSON.stringify({ code: 1, signal: null,
    stdout: 'not ok 3 - isolated checker\n  error: candidate changed\n', stderr: 'native failure context' }))
  fs.writeFileSync(path.join(f.directory, `outer-${id}.json`), JSON.stringify({ env: { PRIVATE: 'must-not-be-printed' } }))
  diagnoseNativeCanary(f.activation, value => messages.push(value))
  assert.match(messages.join('\n'), /not ok 3 - isolated checker/)
  assert.match(messages.join('\n'), /native failure context/)
  assert.doesNotMatch(messages.join('\n'), /must-not-be-printed/)
})

test('native canary diagnostics bound statuses and output and tolerate oversized or malformed evidence', t => {
  const f = fixture(t), messages = []
  for (let index = 0; index < MAX_STATUSES + 1; index += 1) {
    fs.writeFileSync(path.join(f.directory, `outer-${String(index).padStart(36, '0')}.status.json`), JSON.stringify({ code: 1,
      stdout: `HEAD${'x'.repeat(MAX_OUTPUT_CHARS + 100)}TAIL` }))
  }
  diagnoseNativeCanary(f.activation, value => messages.push(value))
  assert.equal(messages.filter(value => value.includes(' stdout:')).length, MAX_STATUSES)
  assert.match(messages.join('\n'), /HEAD.*\[child output truncated\].*TAIL/s)
  assert.ok(messages.every(value => value.length < MAX_OUTPUT_CHARS + 300))
  for (const file of fs.readdirSync(f.directory)) fs.unlinkSync(path.join(f.directory, file))
  fs.writeFileSync(path.join(f.directory, `outer-${crypto.randomUUID()}.status.json`), Buffer.alloc(MAX_STATUS_BYTES + 1))
  fs.writeFileSync(path.join(f.directory, `outer-${crypto.randomUUID()}.status.json`), '{broken')
  messages.length = 0
  assert.doesNotThrow(() => diagnoseNativeCanary(f.activation, value => messages.push(value)))
  assert.match(messages.join('\n'), /oversized status/)
  assert.match(messages.join('\n'), /unreadable \(SyntaxError\)/)
})

test('native canary diagnostics refuse redirected generation roots', t => {
  const f = fixture(t), messages = [], outside = path.join(f.root, 'outside')
  fs.mkdirSync(outside)
  fs.rmSync(f.directory, { recursive: true })
  fs.symlinkSync(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir')
  fs.writeFileSync(path.join(outside, `outer-${crypto.randomUUID()}.status.json`), JSON.stringify({ stdout: 'outside-private-data' }))
  diagnoseNativeCanary(f.activation, value => messages.push(value))
  assert.match(messages.join('\n'), /linked canary diagnostic directory/)
  assert.doesNotMatch(messages.join('\n'), /outside-private-data/)
})

test('native canary timeout diagnostics preserve bounded partial streams without terminal status', t => {
  const f = fixture(t), stem = `outer-${crypto.randomUUID()}`, messages = []
  fs.writeFileSync(path.join(f.directory, `${stem}.stdout.log`), `TAP version 13\n${'x'.repeat(MAX_OUTPUT_CHARS)}\nnot ok 2 - active case`)
  fs.writeFileSync(path.join(f.directory, `${stem}.stderr.log`), 'NATIVE_CANARY_PHASE:{"case":"active case","phase":"launch-start"}')
  fs.writeFileSync(path.join(f.directory, `${stem}.json`), JSON.stringify({ env: { PRIVATE: 'never-print-request' } }))
  diagnoseNativeCanary(f.activation, value => messages.push(value))
  assert.match(messages.join('\n'), /no owned outer status/)
  assert.match(messages.join('\n'), /TAP version 13.*\[child output truncated\].*not ok 2 - active case/s)
  assert.match(messages.join('\n'), /NATIVE_CANARY_PHASE/)
  assert.doesNotMatch(messages.join('\n'), /never-print-request/)
  assert.ok(messages.every(value => value.length < MAX_OUTPUT_CHARS + 300))
})

test('native canary partial diagnostics reject linked and oversized streams', t => {
  const f = fixture(t), messages = [], secret = path.join(f.root, 'secret')
  fs.writeFileSync(secret, 'outside-private-data')
  fs.linkSync(secret, path.join(f.directory, `outer-${crypto.randomUUID()}.stdout.log`))
  fs.writeFileSync(path.join(f.directory, `outer-${crypto.randomUUID()}.stderr.log`), Buffer.alloc(MAX_STREAM_BYTES + 1))
  diagnoseNativeCanary(f.activation, value => messages.push(value))
  assert.equal(messages.filter(value => /partial.*unreadable/.test(value)).length, 2)
  assert.doesNotMatch(messages.join('\n'), /outside-private-data/)
})
