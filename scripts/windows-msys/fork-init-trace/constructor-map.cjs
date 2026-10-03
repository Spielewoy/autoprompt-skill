'use strict'
// Diagnostic COFF-symbol map from the exact captured DLL, never runtime authority.
const assert=require('node:assert/strict'),crypto=require('node:crypto')
function constructorMap(bytes){
 assert.ok(Buffer.isBuffer(bytes)&&bytes.length>=256&&bytes.length<=32*1024*1024)
 const span=(at,size)=>{assert.ok(Number.isSafeInteger(at)&&Number.isSafeInteger(size)&&at>=0&&size>=0&&at+size<=bytes.length,'PE bounds');return at}
 assert.equal(bytes.readUInt16LE(0),0x5a4d)
 const pe=bytes.readUInt32LE(60);span(pe,24);assert.equal(bytes.readUInt32LE(pe),0x4550);assert.equal(bytes.readUInt16LE(pe+4),0x8664)
 const count=bytes.readUInt16LE(pe+6),symbolsAt=bytes.readUInt32LE(pe+12),symbolCount=bytes.readUInt32LE(pe+16),optional=bytes.readUInt16LE(pe+20)
 assert.ok(count>0&&count<=96&&optional>=112&&symbolCount>0&&symbolCount<=200000)
 span(pe+24,optional);assert.equal(bytes.readUInt16LE(pe+24),0x20b);const imageBase=bytes.readBigUInt64LE(pe+48)
 const sectionAt=pe+24+optional;span(sectionAt,count*40);const sections=[]
 for(let i=0;i<count;i++){
  const at=sectionAt+i*40,rva=bytes.readUInt32LE(at+12),size=bytes.readUInt32LE(at+16),offset=bytes.readUInt32LE(at+20),flags=bytes.readUInt32LE(at+36)
  if(size)span(offset,size)
  sections.push({rva,size,offset,executable:Boolean(flags&0x20000000)})
 }
 const stringsAt=symbolsAt+symbolCount*18;span(symbolsAt,symbolCount*18);span(stringsAt,4)
 const stringsLength=bytes.readUInt32LE(stringsAt);assert.ok(stringsLength>=4&&stringsLength<=4*1024*1024);span(stringsAt,stringsLength)
 const functions=new Map(),tables=[]
 for(let i=0;i<symbolCount;){
  const at=symbolsAt+i*18,aux=bytes[at+17];assert.ok(i+aux<symbolCount,'COFF auxiliary bounds')
  let name
  if(bytes.readUInt32LE(at)===0){
   const relative=bytes.readUInt32LE(at+4);assert.ok(relative>=4&&relative<stringsLength)
   const end=bytes.indexOf(0,stringsAt+relative);assert.ok(end>=0&&end<stringsAt+stringsLength&&end-(stringsAt+relative)<=512)
   name=bytes.subarray(stringsAt+relative,end).toString('latin1')
  }else{name=bytes.subarray(at,at+8).toString('latin1').split('\0')[0]}
  const section=bytes.readInt16LE(at+12),value=bytes.readUInt32LE(at+8),type=bytes.readUInt16LE(at+14)
  if(section>0&&section<=sections.length){
   const s=sections[section-1]
   if(name==='__CTOR_LIST__'){assert.ok(s.executable&&value+16<=s.size);tables.push({offset:s.offset+value,remaining:s.size-value})}
   if(type===0x20&&s.executable&&value<s.size&&!name.startsWith('.')){
    assert.match(name,/^[A-Za-z_?][A-Za-z0-9_.$?@]{0,511}$/)
    const rva=s.rva+value;const names=functions.get(rva)||new Set();names.add(name);functions.set(rva,names)
   }
  }
  i+=1+aux
 }
 assert.equal(tables.length,1,'One constructor table required');const table=tables[0]
 assert.equal(bytes.readBigUInt64LE(table.offset),0xffffffffffffffffn)
 const records=[]
 for(let index=1;index<=65;index++){
  assert.ok((index+1)*8<=table.remaining);const address=bytes.readBigUInt64LE(table.offset+index*8)
  if(address===0n){assert.ok(records.length>0);return {schema:1,accepted:false,dllSha256:crypto.createHash('sha256').update(bytes).digest('hex'),callOrder:records.reverse()}}
  assert.ok(index<=64&&address>=imageBase&&address-imageBase<=0xffffffffn,'Constructor count/address bound')
  const rva=Number(address-imageBase),names=functions.get(rva);assert.ok(names&&names.size===1,'Unambiguous constructor symbol required')
  records.push({index,rva:rva.toString(16),symbol:[...names][0],beforeStage:0x100+index,afterStage:0x200+index})
 }
 throw Error('Unterminated constructor table')
}
module.exports={constructorMap}
