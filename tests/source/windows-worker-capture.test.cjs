'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events'),crypto=require('node:crypto')
// Windows capture/architecture/ACL are simulated here; decoder children and filesystem operations are real.
const WORKFLOW=path.resolve(__dirname,'../../agents/codex/workflow')
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
function fixture(t,mode='ok',cleanupFailure=false){
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'capture-composition-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}))
 const root=path.join(base,'bundle');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'manifest.json'),'{}');fs.writeFileSync(path.join(root,'asset.br'),'captured bytes')
 const helper=path.join(base,'helper.exe');fs.writeFileSync(helper,'fixed helper fixture');fs.writeFileSync(helper+'.config','fixed config fixture')
 const files=['manifest.json','asset.br'].map(name=>{const bytes=fs.readFileSync(path.join(root,name));return{path:name,length:bytes.length,sha256:sha(bytes)}})
 const authority={executable:helper,executableSha256:sha(fs.readFileSync(helper)),configSha256:sha(fs.readFileSync(helper+'.config')),systemRoot:'C:\\Windows'}
 const spawned=[],cleanupCalls=[];let allocatedRoot
 const canonical=Object.assign(function(...args){return fs.realpathSync(...args)},{native(value){if(mode==='canonicalization-failure'&&path.basename(value).startsWith('bundle-lease-control-')){allocatedRoot=value;throw Object.assign(Error('canonicalization-failed'),{code:'EIO'})}return fs.realpathSync.native(value)}})
 function spawn(exe,args,options){
  if(mode==='spawn-throw'&&args.length===0)throw Object.assign(Error('spawn-sync-failed'),{code:'EINVAL'})
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.exitCode=null;child.unref=()=>{};child.stdout.unref=child.stderr.unref=child.stdin.unref=()=>{}
  const identity=args[0]==='--identity';spawned.push({exe,args,options,child})
  let closed=false;const close=code=>{if(closed)return;closed=true;child.exitCode=code;child.emit('close',code,null)}
  child.kill=()=>{if(mode==='identity-unconfirmed'&&identity)return false;queueMicrotask(()=>close(null));return true}
  child.stdin.write=text=>{assert.equal(identity,false);const request=JSON.parse(text.trim());assert.equal(request.root,root);queueMicrotask(()=>{
   if(mode==='bad-ready'){child.stdout.emit('data',Buffer.from('unexpected\n'));return}
   child.stdout.emit('data',Buffer.from('bundle-lease-ready-v1\n'))
  });return true}
  child.stdin.end=text=>{assert.equal(text,'finish\n');queueMicrotask(()=>{
   if(mode==='capture-stderr')child.stderr.emit('data',Buffer.from('unexpected error'))
   if(mode==='missing-finish'){close(0);return}
   child.stdout.emit('data',Buffer.from('bundle-lease-finished-v1\n'+(mode==='trailing-output'?'extra\n':'')));close(mode==='nonzero'?1:0)
  })}
  if(identity)queueMicrotask(()=>{
   if(mode==='identity-unconfirmed')return
   if(mode==='identity-stderr')child.stderr.emit('data',Buffer.from('runtime unavailable'))
   child.stdout.emit('data',Buffer.from(mode==='identity-spoof'?'bundle-lease-helper-v1:x64\nextra\n':'bundle-lease-helper-v1:x64\r\n'));close(0)
  })
  return child
 }
 const module={exports:{}};const fastTimer=(fn,ms)=>setTimeout(fn,mode==='identity-unconfirmed'?10:ms)
 vm.runInNewContext(fs.readFileSync(path.join(WORKFLOW,'windows-worker-capture.js'),'utf8'),{module,exports:module.exports,__dirname:WORKFLOW,process:{platform:'win32'},Buffer,setTimeout:fastTimer,clearTimeout,require:name=>name==='node:fs'?{...fs,realpathSync:canonical,rmSync(root,options){cleanupCalls.push({root,options});if(cleanupFailure)throw Object.assign(Error('injected helper directory sharing refusal'),{code:'EACCES'});return fs.rmSync(root,options)}}:name==='node:child_process'?{spawn}:name==='./safe-run-root.js'?{ensureWindowsPrivateAcl(){}}:require(name)},{filename:'actual-windows-worker-capture.js'})
 return{capture:module.exports.captureWindowsFiles,root,files,authority,spawned,cleanupCalls,get allocatedRoot(){return allocatedRoot}}
}
test('actual capture composition queries only staged fixed helper and preserves exact lease handshake',async t=>{
 const x=fixture(t),result=await x.capture(x.root,x.files,x.authority);assert.equal(result.architecture,'x64');assert.equal(result.records.length,2)
 assert.equal(x.spawned.length,2);assert.deepEqual([...x.spawned[0].args],['--identity']);assert.deepEqual([...x.spawned[1].args],[]);assert.equal(x.spawned[0].exe,x.spawned[1].exe)
 for(const file of result.records)assert.equal(sha(file.bytes),x.files.find(value=>value.path===file.path).sha256)
 assert.equal(sha(result.bootstrap.executableBytes),x.authority.executableSha256);assert.equal(sha(result.bootstrap.configBytes),x.authority.configSha256)
 assert.equal(fs.existsSync(path.dirname(x.spawned[0].exe)),false)
})
for(const mode of ['identity-stderr','identity-spoof','bad-ready','capture-stderr','missing-finish','trailing-output','nonzero'])test('actual capture protocol rejects '+mode+' with confirmed close',async t=>{
 const x=fixture(t,mode);await assert.rejects(x.capture(x.root,x.files,x.authority),error=>error.cleanupConfirmed===true);assert.equal(fs.existsSync(path.dirname(x.spawned[0].exe)),false)
})
test('unconfirmed architecture helper close retains directory and reports poisonable cleanup',async t=>{
 const x=fixture(t,'identity-unconfirmed');let retained
 await assert.rejects(x.capture(x.root,x.files,x.authority),error=>{retained=error.retainedHelperRoot;return error.cleanupConfirmed===false&&typeof retained==='string'})
 assert.equal(x.spawned.length,1);assert.equal(fs.existsSync(retained),true);fs.rmSync(retained,{recursive:true,force:true})
})
test('actual capture rejects helper digest mismatch before any execution',async t=>{const x=fixture(t);await assert.rejects(x.capture(x.root,x.files,{...x.authority,executableSha256:'0'.repeat(64)}),/helper-authority/);assert.equal(x.spawned.length,0)})

for(const [mode,message] of [['ok','lease-helper-directory-cleanup-unconfirmed'],['identity-stderr','identity-stderr-refused'],['spawn-throw','spawn-sync-failed'],['missing-finish','native-lease-not-confirmed']])test('owned directory cleanup failure preserves accounting after '+mode,async t=>{
 const x=fixture(t,mode,true);let retained
 await assert.rejects(x.capture(x.root,x.files,x.authority),error=>{
  retained=error.retainedHelperRoot
  return error.message.includes(message)&&error.cleanupConfirmed===false&&error.directoryCleanupCode==='EACCES'&&typeof retained==='string'
 })
 assert.equal(fs.existsSync(retained),true);assert.equal(x.cleanupCalls.length,1)
 assert.equal(x.cleanupCalls[0].options.maxRetries,10);assert.equal(x.cleanupCalls[0].options.retryDelay,100)
 fs.rmSync(retained,{recursive:true,force:true})
})

for(const cleanupFailure of [false,true])test('capture accounts for an owned root when canonicalization fails and cleanup '+(cleanupFailure?'fails':'succeeds'),async t=>{
 const x=fixture(t,'canonicalization-failure',cleanupFailure)
 await assert.rejects(x.capture(x.root,x.files,x.authority),error=>error.message==='canonicalization-failed'&&error.cleanupConfirmed===!cleanupFailure&&(!cleanupFailure||error.retainedHelperRoot===x.allocatedRoot))
 assert.equal(x.spawned.length,0);assert.equal(x.cleanupCalls.length,1);assert.equal(fs.existsSync(x.allocatedRoot),cleanupFailure)
 if(cleanupFailure)fs.rmSync(x.allocatedRoot,{recursive:true,force:true})
})
