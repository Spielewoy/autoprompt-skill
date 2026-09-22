'use strict'
const assert=require('node:assert/strict'),test=require('node:test'),{parseRecords}=require('./run.cjs')
const record='span pid=17 event=3 load=0x100400000 eventFile=12345678:0000000100000002 base=0x800000000 allocation=0x800000000 size=0x300000 state=0x2000 type=0x20000 protect=0x1\n'
test('bounded fork-memory records parse without paths or arbitrary text',()=>{const parsed=parseRecords(Buffer.from(record).toString('base64'));assert.equal(parsed.records.length,1);assert.equal(parsed.records[0].pid,'17');assert.equal(parsed.records[0].event,'3')})
test('malformed, oversized, and excess records refuse',()=>{for(const value of ['%%%=',Buffer.from('path=C:\\secret\n').toString('base64'),Buffer.alloc(1024*1024+1).toString('base64'),Buffer.from(record.repeat(4097)).toString('base64')])assert.throws(()=>parseRecords(value))})
