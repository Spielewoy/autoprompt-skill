'use strict'
const assert = require('node:assert/strict')
const STAGES = new Set([1,2,3,4,5,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,40,41,42,43,44,45,46,47,48,60,61,62,63,64,65,80,81,82,83,84,90,91,92,93,94,95,96,100,101,102,103,110,111,112,113,114,...Array.from({length:64},(_,i)=>0x101+i),...Array.from({length:64},(_,i)=>0x201+i)])
function parse(raw) {
  assert.equal(typeof raw, 'string'); assert.ok(Buffer.byteLength(raw) <= 256 * 1024)
  const drains = [...raw.matchAll(/^TRACE-DRAIN:(confirmed|unknown)\r?$/gm)]
  assert.ok(drains.length <= 1, 'Ambiguous controller drain markers')
  const operations = [], names = new Set()
  for (const match of raw.matchAll(/^operation:(creator|same|other):stdout:([A-Za-z0-9+/=]*):stderr:([A-Za-z0-9+/=]*)\r?$/gm)) {
    assert.equal(names.has(match[1]), false, 'Duplicate operation'); names.add(match[1])
    const bytes = Buffer.from(match[3], 'base64'); assert.ok(bytes.length <= 16384); assert.equal(bytes.toString('base64'), match[3])
    const out = Buffer.from(match[2], 'base64'); assert.ok(out.length <= 16384); assert.equal(out.toString('base64'), match[2])
    const records = []
    // Preserve arbitrary original bytes separately; only complete fixed records are observations.
    for (const record of bytes.toString('latin1').matchAll(/^AT:([0-9a-f]{8}):([0-9a-f]{4}):([01])\n/gm)) {
      const pid = Number.parseInt(record[1], 16), stage = Number.parseInt(record[2], 16)
      assert.ok(pid > 0 && STAGES.has(stage), 'Unknown trace record')
      records.push({ pid, stage, localAppDataPresent: record[3] === '1' }); assert.ok(records.length <= 512)
    }
    operations.push({ name: match[1], stdoutBase64: match[2], stderrBase64: match[3], records })
  }
  return { accepted: false, cleanupConfirmed: drains.length === 1 && drains[0][1] === 'confirmed', operations }
}
module.exports = { parse, STAGES }
