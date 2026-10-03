'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { assertNamedCase } = require('../../../tests/helpers/native-platform-ci.cjs')

const NATIVE_CASES = Object.freeze(['actual fixed ACL helper compiles and rejects malformed authority without Win32 calls', 'actual native ACL controller compiles with complete production resource and launcher sources', 'native fixed ACL helper proves exact AppContainer denial and refuses host, grant, SID and identity controls'])
function verify(stdout) {
  assert.equal(typeof stdout, 'string', 'TAP text required')
  assert.ok(Buffer.byteLength(stdout, 'utf8') <= 2 * 1024 * 1024, 'TAP bound exceeded')
  const output = stdout.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  assert.equal(/[\0\r]/.test(output), false, 'Noncanonical TAP control character')
  assert.equal((output.match(/^TAP version 13$/gm) || []).length, 1, 'Exactly one TAP header required')
  assert.equal((output.match(/^1\.\.3$/gm) || []).length, 1, 'Exactly one complete3-case plan required')
  assert.equal((output.match(/^\d+\.\.\d+.*$/gm) || []).length, 1, 'Unexpected TAP plan')
  const cases = [...output.matchAll(/^(ok|not ok) (\d+) - (.+)$/gm)]
  assert.equal(cases.length, 3, 'All3 top-level results required')
  const names = new Set()
  for (let index = 0; index < cases.length; index++) {
    const [, status, number, name] = cases[index]
    assert.equal(Number(number), index + 1, 'Ordered unique top-level case ids required')
    assert.equal(status, 'ok', 'Failed ACL proof: ' + name)
    assert.equal(/#\s*(?:SKIP|TODO)\b/i.test(name), false, 'ACL proof cannot skip or defer')
    assert.equal(names.has(name), false, 'Duplicate ACL proof name')
    assert.equal(name, NATIVE_CASES[index], 'Exact native test order and names required')
    names.add(name)
  }
  for (const name of NATIVE_CASES) assertNamedCase(output, name)
  for (const [key, expected] of Object.entries({ tests: 3, suites: 0, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const totals = [...output.matchAll(new RegExp('^# ' + key + ' (\\d+)$', 'gm'))]
    assert.equal(totals.length, 1, 'Exactly one total required: ' + key)
    assert.equal(Number(totals[0][1]), expected, 'Incorrect total: ' + key)
  }
  assert.equal(/^Bail out!/m.test(output), false, 'TAP bailout refused')
  return Object.freeze({ cases: 3, nativeCases: 1, skipped: 0 })
}
if (require.main === module) {
  assert.equal(process.argv.length, 3, 'Usage: node verify-acl-output.cjs TAP_LOG')
  const fd = fs.openSync(process.argv[2], 'r')
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1)
    let at = 0, count
    while (at < bytes.length && (count = fs.readSync(fd, bytes, at, bytes.length - at, null)) > 0) at += count
    assert.ok(at <= 2 * 1024 * 1024, 'TAP bound exceeded')
    const output = bytes.subarray(0, at).toString('utf8')
    assert.ok(Buffer.from(output).equals(bytes.subarray(0, at)), 'TAP must be UTF-8')
    process.stdout.write(JSON.stringify(verify(output)) + '\n')
  } finally { fs.closeSync(fd) }
}
module.exports = { NATIVE_CASES, verify }
