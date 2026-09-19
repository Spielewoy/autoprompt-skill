'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process'),path=require('node:path')
const {manifest,validName}=require('./native-writer.cjs')
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const good=()=>({schema:1,files:[{path:'packet/runtime/bash.exe',bytes:3,sha256:hash('abc')}]})
const bytes=x=>Buffer.from(JSON.stringify(x)+'\n')
test('writer framing binds exact names sizes and hashes without native execution',()=>assert.deepEqual(manifest(bytes(good())),good()))
test('writer refuses path aliases special devices and noncanonical frames',()=>{
 for(const name of ['../bad','/bad','C:/ads','x:y','a\\b','a//b','a/CON.exe','a/name.','a/name ','a/é'])assert.throws(()=>validName(name))
 for(const change of [x=>x.extra=true,x=>x.schema=2,x=>x.files[0].bytes=-1,x=>x.files[0].bytes=129*1024*1024,x=>x.files[0].sha256='bad',x=>x.files.push({...x.files[0],path:x.files[0].path.toUpperCase()}),x=>x.files.push({path:'packet',bytes:0,sha256:hash('')})]){const v=good();change(v);assert.throws(()=>manifest(bytes(v)))}
 assert.throws(()=>manifest(Buffer.from(JSON.stringify(good()))))
})
test('native writer refuses this non-Windows host instead of claiming private Windows materialization',{skip:process.platform==='win32'},()=>{
 const r=cp.spawnSync(process.execPath,[path.join(__dirname,'native-writer.cjs')],{encoding:'utf8',timeout:5000,env:{}})
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'Native candidate writer refused\n')
})
