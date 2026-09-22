'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {checkedConsumerHead}=require('./run.cjs')
const head='a'.repeat(40),exec=()=>head+'\n'
test('consumer head is independent from producer identity and bound to checkout plus workflow SHA',()=>{
  assert.equal(checkedConsumerHead(head,'C:\\repo',{GITHUB_SHA:head},exec),head)
  assert.throws(()=>checkedConsumerHead('latest','C:\\repo',{GITHUB_SHA:head},exec))
  assert.throws(()=>checkedConsumerHead(head,'C:\\repo',{GITHUB_SHA:'b'.repeat(40)},exec),/Workflow SHA/)
  assert.throws(()=>checkedConsumerHead(head,'C:\\repo',{GITHUB_SHA:head},()=> 'b'.repeat(40)+'\n'),/checkout/)
})
