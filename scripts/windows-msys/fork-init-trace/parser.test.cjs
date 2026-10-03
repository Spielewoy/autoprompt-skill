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

test('constructor markers have a closed index bound and remain observations',()=>{
 const r=parse(line('AT:00000001:005a:1\nAT:00000001:0101:1\nAT:00000001:0140:1\nAT:00000001:0201:1\nAT:00000001:0240:1\n'))
 assert.equal(r.accepted,false);assert.deepEqual(r.operations[0].records.map(x=>x.stage),[90,0x101,0x140,0x201,0x240])
 for(const stage of ['0100','0141','0200','0241'])assert.throws(()=>parse(line('AT:00000001:'+stage+':1\n')))
})

test('capability pointer and allocator markers remain a closed diagnostic set',()=>{
 const stages=[110,111,112,113,114]
 const r=parse(line(stages.map(stage=>'AT:00000001:'+stage.toString(16).padStart(4,'0')+':1\n').join('')))
 assert.equal(r.accepted,false);assert.deepEqual(r.operations[0].records.map(x=>x.stage),stages)
 for(const stage of [109,115])assert.throws(()=>parse(line('AT:00000001:'+stage.toString(16).padStart(4,'0')+':1\n')))
})

const {constructorMap}=require('./constructor-map.cjs')
function dll(){
 const b=Buffer.alloc(0x500),pe=0x80,base=0x180000000n,section=pe+24+112,symbols=0x400
 b.writeUInt16LE(0x5a4d);b.writeUInt32LE(pe,60);b.writeUInt32LE(0x4550,pe);b.writeUInt16LE(0x8664,pe+4);b.writeUInt16LE(1,pe+6)
 b.writeUInt32LE(symbols,pe+12);b.writeUInt32LE(3,pe+16);b.writeUInt16LE(112,pe+20);b.writeUInt16LE(0x20b,pe+24);b.writeBigUInt64LE(base,pe+48)
 b.write('.text',section);b.writeUInt32LE(0x1000,section+12);b.writeUInt32LE(0x200,section+16);b.writeUInt32LE(0x200,section+20);b.writeUInt32LE(0x60000020,section+36)
 b.writeBigUInt64LE(0xffffffffffffffffn,0x200);b.writeBigUInt64LE(base+0x1040n,0x208);b.writeBigUInt64LE(base+0x1060n,0x210)
 const strings=symbols+54;b.writeUInt32LE(18,strings);b.write('__CTOR_LIST__\0',strings+4)
 b.writeUInt32LE(4,symbols+4);b.writeInt16LE(1,symbols+12)
 for(const [i,name,value] of [[1,'first',0x40],[2,'second',0x60]]){const at=symbols+i*18;b.write(name,at);b.writeUInt32LE(value,at+8);b.writeInt16LE(1,at+12);b.writeUInt16LE(0x20,at+14)}
 return b
}
test('exact DLL constructor table maps reverse execution order and rejects malformed mappings',()=>{
 const b=dll(),m=constructorMap(b);assert.equal(m.accepted,false)
 assert.deepEqual(m.callOrder.map(({index,symbol,beforeStage,afterStage})=>({index,symbol,beforeStage,afterStage})),[{index:2,symbol:'second',beforeStage:0x102,afterStage:0x202},{index:1,symbol:'first',beforeStage:0x101,afterStage:0x201}])
 assert.equal(m.dllSha256,require('node:crypto').createHash('sha256').update(b).digest('hex'))
 const mutations=[x=>x.writeUInt32LE(0xffffffff,0x8c),x=>x.writeUInt32LE(200001,0x90),x=>x.writeUInt16LE(0xaa64,0x84),x=>x.writeBigUInt64LE(0n,0x200),x=>x.writeBigUInt64LE(0x18000ffffn,0x208),x=>x.writeUInt16LE(0,0x400+18+14),x=>x.writeUInt8(255,0x400+17),x=>x.writeUInt32LE(0xffffffff,0x400+54)]
 for(const mutate of mutations){const invalid=Buffer.from(b);mutate(invalid);assert.throws(()=>constructorMap(invalid))}
 for(const length of [0,63,255,0x410])assert.throws(()=>constructorMap(b.subarray(0,length)))
})
