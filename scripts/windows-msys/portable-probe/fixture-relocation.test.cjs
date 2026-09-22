'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const relocation=require('./fixture-relocation.cjs')
test('fixture relocation is closed to the exact pinned binary',()=>{
  assert.equal(relocation.ORIGINAL_SHA256,'7842eaf72ea9b0f4fb22f7054ba27e458491f1956666a5adfe5464e82e908827')
  assert.equal(relocation.DERIVED_SHA256,'eb8bdecd843f1adc425fd0fd434f7850d7dc471dc91114b93cab3936fa2c4f67')
  assert.equal(relocation.LENGTH,47495)
  assert.throws(()=>relocation.derive('bytes'),/bytes required/)
  assert.throws(()=>relocation.derive(Buffer.alloc(47494)),/length/)
  assert.throws(()=>relocation.derive(Buffer.alloc(47495)),/Pinned POSIX fixture required/)
})
