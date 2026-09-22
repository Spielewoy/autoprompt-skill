'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const relocation=require('./fixture-relocation.cjs')
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
test('fixture relocation is closed to the exact pinned binary',()=>{
  assert.equal(relocation.ORIGINAL_SHA256,'7842eaf72ea9b0f4fb22f7054ba27e458491f1956666a5adfe5464e82e908827')
  assert.equal(relocation.DERIVED_SHA256,'eb8bdecd843f1adc425fd0fd434f7850d7dc471dc91114b93cab3936fa2c4f67')
  assert.equal(relocation.LENGTH,47495)
  assert.throws(()=>relocation.derive('bytes',relocation.ORIGINAL_SHA256),/bytes required/)
  assert.throws(()=>relocation.derive(Buffer.alloc(47495)),/identity required/)
  assert.throws(()=>relocation.derive(Buffer.alloc(47495),relocation.ORIGINAL_SHA256),/differs from authenticated tuple/)
})
test('an authenticated compiler fixture with DYNAMIC_BASE is an exact no-op',()=>{
  const fixture=Buffer.alloc(512),pe=128,optional=pe+24
  fixture.writeUInt16LE(0x5a4d,0);fixture.writeUInt32LE(pe,0x3c);fixture.writeUInt32LE(0x4550,pe)
  fixture.writeUInt16LE(0x8664,pe+4);fixture.writeUInt16LE(0x20b,optional);fixture.writeUInt16LE(0x8040,optional+70)
  const digest=sha(fixture),result=relocation.derive(fixture,digest)
  assert.notEqual(result.bytes,fixture);assert.deepEqual(result.bytes,fixture)
  assert.deepEqual(result.receipt,{schema:1,transformation:'pe-dynamic-base-already-enabled',originalSha256:digest,
    derivedSha256:digest,length:fixture.length,changedOffsets:[]})
  fixture.writeUInt16LE(0x8000,optional+70)
  assert.throws(()=>relocation.derive(fixture,sha(fixture)),/must already enable DYNAMIC_BASE/)
})
