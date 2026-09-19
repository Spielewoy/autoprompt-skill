'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { NATIVE_CASES, verify } = require('./verify-output.cjs')
const good = ['TAP version 13', ...NATIVE_CASES.map((name,index) => `ok ${index+1} - ${name}`), '1..7',
  '# tests 7','# suites 0','# pass 7','# fail 0','# cancelled 0','# skipped 0','# todo 0',''].join('\n')
test('precompiled native output requires every exact native case and complete zero-skip totals', () => {
  assert.deepEqual(verify(good), { cases:7, nativeCases:7, skipped:0 })
  assert.deepEqual(verify('\uFEFF'+good.replace(/\n/g,'\r\n')), { cases:7, nativeCases:7, skipped:0 })
})
for(const [name,change] of [
  ['missing case', text => text.replace(/^ok 2 - .*\n/m,'')],
  ['skip', text => text.replace(/^ok 2 - (.*)$/m,'ok 2 - $1 # SKIP')],
  ['todo', text => text.replace(/^ok 2 - (.*)$/m,'ok 2 - $1 # TODO')],
  ['failure', text => text.replace('ok 2 -','not ok 2 -')],
  ['wrong name', text => text.replace(NATIVE_CASES[1], 'unrelated test')],
  ['duplicate id', text => text.replace('ok 2 -','ok 1 -')],
  ['duplicate plan', text => text+'1..7\n'],
  ['wrong pass total', text => text.replace('# pass 7','# pass 6')],
  ['missing totals', text => text.replace('# skipped 0\n','')],
  ['duplicate totals', text => text+'# skipped 0\n'],
  ['bailout', text => text+'Bail out! stopped\n'],
  ['nul', text => text+'\0'],
  ['output limit', text => text+'x'.repeat(2*1024*1024)]
]) test('precompiled native output refuses '+name, () => assert.throws(() => verify(change(good))))
