'use strict'
const assert=require('node:assert/strict'),test=require('node:test'),{parseRecords,collisionIsCorrelated}=require('./run.cjs')
const policy='policy pid=17 flags=0x4 error=0\n'
const record='span pid=17 event=3 load=0x100400000 eventFile=12345678:0000000100000002 base=0x800000000 allocation=0x800000000 size=0x300000 state=0x2000 type=0x20000 protect=0x1\n'
test('bounded fork-memory records parse without paths or arbitrary text',()=>{const parsed=parseRecords(Buffer.from(record).toString('base64'));assert.equal(parsed.records.length,1);assert.equal(parsed.records[0].pid,'17');assert.equal(parsed.records[0].event,'3')})
test('mitigation policy observations parse as bounded metadata',()=>{const parsed=parseRecords(Buffer.from(record+policy).toString('base64'));assert.equal(parsed.policies.length,1);assert.equal(parsed.policies[0].flags,'0x4')})
test('malformed, oversized, and excess records refuse',()=>{for(const value of ['%%%=',Buffer.from('path=C:\\secret\n').toString('base64'),Buffer.alloc(1024*1024+1).toString('base64'),Buffer.from(record.repeat(4097)).toString('base64')])assert.throws(()=>parseRecords(value))})

test('collision correlation refuses reused or unobserved child identities and incomplete scans', () => {
 const memory={queryError:0,overflow:false}, records=[{pid:'17',event:'3'}]
 assert.equal(collisionIsCorrelated(memory,records,{17:1},[17]),true)
 for(const counts of [{},{17:2}])assert.equal(collisionIsCorrelated(memory,records,counts,[17]),false)
 assert.equal(collisionIsCorrelated(memory,[{pid:'17',event:'6'}],{17:1},[17]),false)
 assert.equal(collisionIsCorrelated(memory,records,{17:1},[]),false)
 assert.equal(collisionIsCorrelated({...memory,overflow:true},records,{17:1},[17]),false)
 assert.equal(collisionIsCorrelated({...memory,queryError:5},records,{17:1},[17]),false)
})
test('policy parser records legitimate PID reuse and bounds observations', () => {
 const parsed=parseRecords(Buffer.from(policy+policy).toString('base64'))
 assert.equal(parsed.policyPidCounts[17],2)
 for(const raw of [policy.repeat(2049),'policy pid=17 flags=secret error=0\n'])assert.throws(()=>parseRecords(Buffer.from(raw).toString('base64')))
})
