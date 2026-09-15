'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseProof } = require('./run.cjs')
const encode = text => Buffer.from(text).toString('base64')
function proof() {
  const result = { schemaVersion: 1, objects: 16, sameProfileOpens: 16, otherProfileDenied: 16, drainedJobs: 3, namespaceCount: 2 }
  for (const [key, side, last] of [['creatorBase64', 'created', 'creator:16:descriptor-and-peer-effects-passed'], ['sameBase64', 'same', 'same-profile:16:passed'], ['otherBase64', 'other', 'other-profile:16:passed']]) {
    const lines = []
    for (let variant = 0; variant < 4; variant++) for (let kind = 0; kind < 4; kind++) lines.push(side === 'created' ? `created:variant=${variant}:kind=${kind}:effective-descriptor=passed` : `open:variant=${variant}:kind=${kind}:status=${side === 'same' ? '00000000' : 'c0000022'}:allowed=${side === 'same' ? 1 : 0}`)
    lines.push(last)
    result[key] = encode(lines.join('\n') + '\n')
  }
  return result
}
test('exact sixteen-object peer proof is accepted', () => assert.deepEqual(parseProof(JSON.stringify(proof())), proof()))
for (const [name, mutate] of [
  ['missing drain', p => { p.drainedJobs = 2 }],
  ['missing object', p => { p.objects = 15 }],
  ['namespace mismatch', p => { p.namespaceCount = 3 }],
  ['extra protocol field', p => { p.extra = true }],
  ['noncanonical base64', p => { p.sameBase64 += '\n' }],
  ['false same-profile success', p => { p.sameBase64 = encode(Buffer.from(p.sameBase64, 'base64').toString().replace('status=00000000', 'status=c0000022')) }],
  ['wrong-profile access allowed', p => { p.otherBase64 = encode(Buffer.from(p.otherBase64, 'base64').toString().replace('status=c0000022:allowed=0', 'status=00000000:allowed=1')) }],
  ['missing effective descriptor check', p => { p.creatorBase64 = encode(Buffer.from(p.creatorBase64, 'base64').toString().split('\n').slice(1).join('\n')) }],
  ['duplicate object check', p => { p.creatorBase64 = encode(Buffer.from(p.creatorBase64, 'base64').toString().replace('variant=0:kind=1', 'variant=0:kind=0')) }],
  ['missing final operation effects', p => { p.creatorBase64 = encode(Buffer.from(p.creatorBase64, 'base64').toString().replace('creator:16:descriptor-and-peer-effects-passed', 'creator:16:passed')) }],
]) test(name + ' refuses', () => { const p = proof(); mutate(p); assert.throws(() => parseProof(JSON.stringify(p))) })
