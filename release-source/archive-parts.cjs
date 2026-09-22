'use strict'
// Unpublished transport prototype. No extraction, runtime admission or source-license claim.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const PART=32*1024*1024,CHUNK=1024*1024,MAX_ARCHIVE=256*1024*1024
const NAMES=['bash-msys-source-notices.tar.gz','node-source-notices.tar.gz']
const sha=x=>crypto.createHash('sha256').update(x).digest('hex')
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)+'\n'
function need(x,code){if(!x)throw Error(code)}
function keys(x,wanted){need(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===wanted.split(',').sort().join(','),'closed-shape')}
function physical(file,directory=false){
 const absolute=path.resolve(file);for(let p=absolute;;p=path.dirname(p)){const st=fs.lstatSync(p,{bigint:true});need(!st.isSymbolicLink()&&(p===absolute?(directory?st.isDirectory():st.isFile()&&st.nlink===1n):st.isDirectory()),'physical-object-required');if(p===path.dirname(p))break}
 return absolute
}
function snapshot(st){return [st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].map(String).join(':')}
function opened(file,length){physical(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const st=fs.fstatSync(fd,{bigint:true});need(st.isFile()&&st.nlink===1n&&st.size===BigInt(length),'input-size-or-type');need(snapshot(st)===snapshot(fs.lstatSync(file,{bigint:true})),'input-replaced');return{fd,initial:snapshot(st)}}catch(e){fs.closeSync(fd);throw e}}
function stable(input){need(snapshot(fs.fstatSync(input.fd,{bigint:true}))===input.initial,'input-changed')}
function outputRoot(root){physical(path.dirname(path.resolve(root)),true);fs.mkdirSync(root,{mode:0o700});physical(root,true)}
function write(fd,buffer,length){let at=0;while(at<length){const n=fs.writeSync(fd,buffer,at,length-at);need(n>0,'output-short-write');at+=n}}
function pinRecord(pins){need(Array.isArray(pins)&&pins.length===2,'two-archive-pins');pins.forEach((p,i)=>{keys(p,'name,length,sha256');need(p.name===NAMES[i]&&Number.isSafeInteger(p.length)&&p.length>0&&p.length<=MAX_ARCHIVE&&/^[a-f0-9]{64}$/.test(p.sha256),'archive-pin')})}
function partName(name,i){return name+'.part-'+String(i+1).padStart(4,'0')}
function split(paths,pins,output){
 pinRecord(pins);need(Array.isArray(paths)&&paths.length===2,'two-inputs');outputRoot(output)
 const index={schema:1,partSize:PART,archives:[]},buffer=Buffer.alloc(CHUNK)
 for(let a=0;a<2;a++){
  const pin=pins[a],input=opened(paths[a],pin.length),full=crypto.createHash('sha256'),parts=[];let consumed=0
  try{while(consumed<pin.length){const length=Math.min(PART,pin.length-consumed),name=partName(pin.name,parts.length),fd=fs.openSync(path.join(output,name),'wx',0o600),hash=crypto.createHash('sha256');let part=0
   try{while(part<length){const n=fs.readSync(input.fd,buffer,0,Math.min(buffer.length,length-part),null);need(n>0,'input-short-read');write(fd,buffer,n);hash.update(buffer.subarray(0,n));full.update(buffer.subarray(0,n));part+=n;consumed+=n}fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
   parts.push({name,length,sha256:hash.digest('hex')})
  }need(fs.readSync(input.fd,buffer,0,1,null)===0,'input-grown');stable(input);need(full.digest('hex')===pin.sha256,'archive-pin-mismatch');index.archives.push({...pin,parts})}finally{fs.closeSync(input.fd)}
 }
 const bytes=Buffer.from(canonical(index));fs.writeFileSync(path.join(output,'index.json'),bytes,{flag:'wx',mode:0o600});return{indexSha256:sha(bytes),index}
}
function readIndex(root,expectedSha,pins){
 pinRecord(pins);physical(root,true);need(/^[a-f0-9]{64}$/.test(expectedSha),'index-pin');const file=path.join(root,'index.json');physical(file);const size=fs.lstatSync(file).size;need(size>0&&size<=65536,'index-size');const input=opened(file,size);let bytes
 try{bytes=Buffer.alloc(size);let at=0;while(at<size){const n=fs.readSync(input.fd,bytes,at,size-at,null);need(n>0,'index-short-read');at+=n}stable(input)}finally{fs.closeSync(input.fd)}
 need(sha(bytes)===expectedSha,'index-pin-mismatch');need(Buffer.from(bytes.toString('utf8')).equals(bytes),'index-utf8');const index=JSON.parse(bytes);need(canonical(index)===bytes.toString('utf8'),'canonical-index');keys(index,'schema,partSize,archives');need(index.schema===1&&index.partSize===PART&&Array.isArray(index.archives)&&index.archives.length===2,'closed-index')
 const inventory=['index.json']
 index.archives.forEach((a,i)=>{keys(a,'name,length,sha256,parts');const pin=pins[i];need(a.name===pin.name&&a.length===pin.length&&a.sha256===pin.sha256,'archive-authority-mismatch');need(Array.isArray(a.parts)&&a.parts.length===Math.ceil(a.length/PART),'part-count');let total=0
  a.parts.forEach((p,j)=>{keys(p,'name,length,sha256');need(p.name===partName(a.name,j)&&p.length===Math.min(PART,a.length-total)&&/^[a-f0-9]{64}$/.test(p.sha256),'part-order-path-or-size');total+=p.length;inventory.push(p.name);physical(path.join(root,p.name));need(fs.lstatSync(path.join(root,p.name)).size===p.length,'part-size')});need(total===a.length,'part-total')
 });need(fs.readdirSync(root).sort().join('\n')===inventory.sort().join('\n'),'closed-part-inventory');return index
}
function reassemble(root,expectedSha,pins,output){
 const index=readIndex(root,expectedSha,pins);outputRoot(output);const buffer=Buffer.alloc(CHUNK)
 for(const a of index.archives){const temp=path.join(output,a.name+'.partial'),fd=fs.openSync(temp,'wx',0o600),full=crypto.createHash('sha256');let total=0
  try{for(const p of a.parts){const input=opened(path.join(root,p.name),p.length),hash=crypto.createHash('sha256');let count=0
   try{while(count<p.length){const n=fs.readSync(input.fd,buffer,0,Math.min(buffer.length,p.length-count),null);need(n>0,'part-short-read');write(fd,buffer,n);hash.update(buffer.subarray(0,n));full.update(buffer.subarray(0,n));count+=n;total+=n}need(fs.readSync(input.fd,buffer,0,1,null)===0,'part-grown');stable(input);need(hash.digest('hex')===p.sha256,'part-hash-mismatch')}finally{fs.closeSync(input.fd)}
  }need(total===a.length&&full.digest('hex')===a.sha256,'archive-hash-mismatch');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  // Fresh owned directory: link refuses any unexpected preexisting destination.
  fs.linkSync(temp,path.join(output,a.name));fs.unlinkSync(temp)
 }
 need(fs.readdirSync(output).sort().join(',')===NAMES.slice().sort().join(','),'closed-output-inventory');return{archives:pins,totalBytes:pins.reduce((n,p)=>n+p.length,0),accepted:false}
}
module.exports={split,reassemble,readIndex,canonical,sha,PART}
if(require.main===module){
 const args=process.argv.slice(2),mode=args[0];need((mode==='split'&&args.length===4)||(mode==='reassemble'&&args.length===5),'usage: split PINS INPUT_ROOT NEW_PARTS_ROOT | reassemble PINS PARTS_ROOT INDEX_SHA NEW_OUTPUT_ROOT')
 physical(args[1]);need(fs.statSync(args[1]).size<=4096,'pins-size');const pins=JSON.parse(fs.readFileSync(args[1],'utf8'));pinRecord(pins)
 const result=mode==='split'?split(pins.map(p=>path.join(args[2],p.name)),pins,args[3]):reassemble(args[2],args[3],pins,args[4]);process.stdout.write(JSON.stringify(result)+'\n')
}
