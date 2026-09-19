'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), { parse } = require('./parse.cjs')
const line = bytes => 'operation:creator:stdout::stderr:' + Buffer.from(bytes).toString('base64') + '\n'
test('diagnostic records never imply acceptance; unknown cleanup remains unknown', () => {
 const result = parse('TRACE-DRAIN:confirmed\n' + line('AT:00000001:0001:1\nAT:00000002:0028:0\nerror:original\n'))
 assert.equal(result.accepted, false); assert.equal(result.cleanupConfirmed, true)
 assert.deepEqual(result.operations[0].records, [{pid:1,stage:1,localAppDataPresent:true},{pid:2,stage:40,localAppDataPresent:false}])
 assert.equal(parse('TRACE-DRAIN:unknown\n').cleanupConfirmed, false)
 assert.equal(parse('').cleanupConfirmed, false)
})
test('bounded strict diagnostics reject forged structure and retain ordinary errors', () => {
 assert.throws(() => parse('x'.repeat(262145)))
 assert.throws(() => parse('TRACE-DRAIN:confirmed\nTRACE-DRAIN:unknown\n'))
 assert.throws(() => parse(line('AT:00000001:ffff:1\n')))
 assert.throws(() => parse(line('') + line('')))
 const r=parse(line('incomplete AT:00000001:0001:1\nAT:00000001:0001:1'))
 assert.deepEqual(r.operations[0].records, [])
 assert.equal(Buffer.from(r.operations[0].stderrBase64,'base64').toString(), 'incomplete AT:00000001:0001:1\nAT:00000001:0001:1')
})

test('diagnostic entry composes actual exported helpers before native admission', () => {
 assert.equal(typeof require('./run.cjs').main, 'function')
})
