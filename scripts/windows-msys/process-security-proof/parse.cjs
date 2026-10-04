'use strict'
const assert = require('node:assert/strict')
const masks = { process: [0x1000, 0x400, 0x410, 1, 0x20, 8, 0x40], thread: [0x800, 0x40, 0x10, 2, 0x20] }
function decode(value, maximum) { assert.equal(typeof value, 'string'); assert.ok(value.length > 0 && value.length <= maximum * 2); const bytes = Buffer.from(value, 'base64'); assert.ok(bytes.length <= maximum); assert.equal(bytes.toString('base64'), value); return bytes }
function parseProof(raw) {
  assert.equal(typeof raw, 'string'); assert.ok(Buffer.byteLength(raw) <= 131072)
  const p = JSON.parse(raw)
  assert.deepEqual(Object.keys(p).sort(), ['schemaVersion', 'packageA', 'packageB', 'pid', 'tid', 'sameProfileOpens', 'otherProfileDenied', 'drainedJobs', 'processSecurityBase64', 'threadSecurityBase64', 'creatorBase64', 'sameBase64', 'otherBase64'].sort())
  assert.equal(p.schemaVersion, 1)
  for (const key of ['packageA', 'packageB']) assert.match(p[key], /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/)
  assert.notEqual(p.packageA, p.packageB)
  for (const key of ['pid', 'tid']) assert.ok(Number.isSafeInteger(p[key]) && p[key] > 0 && p[key] <= 0xffffffff)
  assert.equal(p.sameProfileOpens, 12); assert.equal(p.otherProfileDenied, 12); assert.equal(p.drainedJobs, 3)
  for (const key of ['processSecurityBase64', 'threadSecurityBase64']) { const sd = decode(p[key], 16384); assert.ok(sd.length >= 20 && sd[0] === 1 && (sd.readUInt16LE(2) & 0x8004) === 0x8004) }
  assert.equal(decode(p.creatorBase64, 16384).toString(), `holder:pid=${p.pid}:tid=${p.tid}:released\r\n`)
  for (const allowed of [true, false]) {
    const mode = allowed ? 'same' : 'other'
    const lines = decode(p[mode + 'Base64'], 16384).toString().split(/\r?\n/); assert.equal(lines.pop(), '')
    const expected = Object.entries(masks).flatMap(([kind, values]) => values.map(access => `open:kind=${kind}:access=${access}:allowed=${allowed ? 1 : 0}:error=${allowed ? 0 : 5}`))
    expected.push(`${mode}:12:passed`); assert.deepEqual(lines, expected)
  }
  return p
}
module.exports = { masks, decode, parseProof }
