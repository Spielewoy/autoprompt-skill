'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), cp = require('node:child_process'), path = require('node:path')
const { parseProof, masks } = require('./parse.cjs')
const encode = text => Buffer.from(text).toString('base64')
function fixture() {
  // Synthetic binary header only: parser regression, never native evidence.
  const sd = Buffer.alloc(20); sd[0] = 1; sd.writeUInt16LE(0x8004, 2)
  const record = { schemaVersion: 1, packageA: 'S-1-15-2-1-2-3-4-5-6-7', packageB: 'S-1-15-2-1-2-3-4-5-6-8', pid: 11, tid: 12, sameProfileOpens: 12, otherProfileDenied: 12, drainedJobs: 3, processSecurityBase64: sd.toString('base64'), threadSecurityBase64: sd.toString('base64'), creatorBase64: encode('holder:pid=11:tid=12:released\r\n') }
  for (const allowed of [true, false]) { const mode = allowed ? 'same' : 'other'; record[mode + 'Base64'] = encode(Object.entries(masks).flatMap(([kind, list]) => list.map(access => `open:kind=${kind}:access=${access}:allowed=${allowed ? 1 : 0}:error=${allowed ? 0 : 5}`)).concat(`${mode}:12:passed`, '').join('\r\n')) }
  return record
}
test('complete ordered synthetic parser fixture retains exact identities and access outcomes', () => { const p = fixture(); assert.deepEqual(parseProof(JSON.stringify(p)), p) })
for (const [name, change] of [
  ['missing drain', p => { p.drainedJobs = 2 }], ['same profile labels', p => { p.packageB = p.packageA }],
  ['wrong holder identity', p => { p.pid = 13 }], ['extra field', p => { p.extra = true }],
  ['missing access', p => { p.sameBase64 = encode(Buffer.from(p.sameBase64, 'base64').toString().split('\r\n').slice(1).join('\r\n')) }],
  ['other profile success', p => { p.otherBase64 = encode(Buffer.from(p.otherBase64, 'base64').toString().replace('allowed=0:error=5', 'allowed=1:error=0')) }],
  ['wrong denial status', p => { p.otherBase64 = encode(Buffer.from(p.otherBase64, 'base64').toString().replace('error=5', 'error=6')) }],
  ['missing release', p => { p.creatorBase64 = encode('holder:pid=11:tid=12:ready\r\n') }],
  ['noncanonical bytes', p => { p.processSecurityBase64 += '\n' }], ['short descriptor', p => { p.threadSecurityBase64 = encode('short') }],
]) test('parser refuses ' + name, () => { const p = fixture(); change(p); assert.throws(() => parseProof(JSON.stringify(p))) })
test('exact native fixture ID parser and access loop exercise real control flow with API seams', { skip: process.platform === 'win32' ? 'Linux g++ source contract; Windows separately compiles and executes the actual native fixture with MSVC' : false }, () => { const result = cp.spawnSync('python3', [path.join(__dirname, 'contract.py')], { encoding: 'utf8', timeout: 45000 }); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stdout, 'source-contract:15:passed\n') })
