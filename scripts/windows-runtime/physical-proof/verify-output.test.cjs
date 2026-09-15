'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { NATIVE_CASES, verify } = require('./verify-output.cjs')
function complete() {
  const names = [...Array.from({ length: 15 }, (_, index) => 'portable contract ' + index), ...NATIVE_CASES]
  return 'TAP version 13\n' + names.map((name, index) => 'ok ' + (index + 1) + ' - ' + name + '\n').join('') +
    '1..22\n# tests 22\n# suites 0\n# pass 22\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
}
test('complete unskipped native physical proof is accepted', () => {
  assert.deepEqual(verify(complete()), { cases: 22, nativeCases: 7, skipped: 0 })
  assert.equal(verify('\uFEFF' + complete().replace(/\n/g, '\r\n')).nativeCases, 7)
})
for (const [name, mutate] of [
  ['missing native case', value => value.replace('ok 16 - ' + NATIVE_CASES[0] + '\n', '')],
  ['native case replaced by lookalike', value => value.replace(NATIVE_CASES[0], NATIVE_CASES[0] + ' parser only')],
  ['native SKIP', value => value.replace(NATIVE_CASES[0], NATIVE_CASES[0] + ' # SKIP no Windows')],
  ['native TODO', value => value.replace(NATIVE_CASES[0], NATIVE_CASES[0] + ' # TODO later')],
  ['native failure', value => value.replace('ok 16 -', 'not ok 16 -')],
  ['portable failure', value => value.replace('ok 1 -', 'not ok 1 -')],
  ['duplicate native name', value => value.replace(NATIVE_CASES[1], NATIVE_CASES[0])],
  ['duplicate case result', value => value.replace('1..22', 'ok 16 - ' + NATIVE_CASES[0] + '\n1..22')],
  ['duplicate case id', value => value.replace('ok 17 -', 'ok 16 -')],
  ['wrong pass total', value => value.replace('# pass 22', '# pass 21')],
  ['wrong skipped total', value => value.replace('# skipped 0', '# skipped 1')],
  ['wrong cancelled total', value => value.replace('# cancelled 0', '# cancelled 1')],
  ['duplicate zero fail total', value => value.replace('# fail 0', '# fail 0\n# fail 0')],
  ['missing total', value => value.replace('# todo 0\n', '')],
  ['wrong plan', value => value.replace('1..22', '1..21')],
  ['second plan', value => value + '1..22\n'],
  ['bailout', value => value + 'Bail out!\n']
]) test('physical proof TAP refuses ' + name, () => assert.throws(() => verify(mutate(complete()))))
