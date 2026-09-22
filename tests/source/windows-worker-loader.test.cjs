'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),zlib=require('node:zlib')
const decoder=require('../../agents/codex/workflow/windows-worker-decoder.js'),crypto=require('node:crypto')
// Windows capture/architecture/ACL are simulated here; decoder children and filesystem operations are real.
const WORKFLOW=path.resolve(__dirname,'../../agents/codex/workflow')
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
const PIPELINE=['windows-worker-capture.js','windows-worker-decoder.js','windows-worker-loader.js','windows-worker-pe.js','safe-run-root.js']
function binary(arch,dll,imports,shared){
 const b=Buffer.alloc(2048);b.writeUInt16LE(0x5a4d);b.writeUInt32LE(64,60);b.writeUInt32LE(0x4550,64);b.writeUInt16LE(arch==='arm64'?0xaa64:0x8664,68);b.writeUInt16LE(1,70);b.writeUInt16LE(240,84);b.writeUInt16LE(2|(dll?0x2000:0),86);b.writeUInt16LE(0x20b,88);b.writeUInt32LE(2,196);b.writeUInt32LE(0x1000,208);b.writeUInt32LE((imports.length+1)*20,212);b.writeUInt32LE(0x1000,340);b.writeUInt32LE(1536,344);b.writeUInt32LE(512,348);for(let i=0;i<imports.length;i++){b.writeUInt32LE(0x1200+i*64,512+i*20+12);b.write(imports[i]+'\0',1024+i*64,'ascii')}
 if(shared)b.write('BEGIN_CYGWIN_VERSION_INFO\n%%% MSYS shared id: msys-2.0S5\n%%% MSYS shared data: 5\nEND_CYGWIN_VERSION_INFO',1500)
 return b
}
function setup(t,options={}){
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'worker-loader-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}))
 const bundle=path.join(base,'windows-worker','bundle');fs.mkdirSync(path.join(bundle,'assets'),{recursive:true});fs.mkdirSync(path.join(base,'windows-worker','bootstrap'))
 const spec=[['bash','x64',false,['kernel32.dll','msys-2.0.dll']],['msys','x64',true,['kernel32.dll','ntdll.dll']],['node-arm64','arm64',false,['kernel32.dll']],['node-x64','x64',false,['kernel32.dll']]],files=[],imports={},raw={}
 for(const[role,arch,dll,deps]of spec){const bytes=binary(arch,dll,deps,role==='msys');if(options.rawChange)options.rawChange(role,bytes);const packed=zlib.brotliCompressSync(bytes),input='assets/'+role+'.br',output='usr/bin/'+(role==='msys'?'msys-2.0.dll':role+'.exe');files.push({path:input,output,encoding:'br',length:packed.length,sha256:sha(packed),rawLength:bytes.length,rawSha256:sha(bytes)});imports[input]=deps;raw[input]=bytes;fs.writeFileSync(path.join(bundle,input),packed)}
 const bytes=Buffer.from(decoder.canonical({schema:1,files})+'\n');fs.writeFileSync(path.join(bundle,'manifest.json'),bytes)
 const pipeline={};for(const name of PIPELINE){const b=fs.readFileSync(path.join(WORKFLOW,name));fs.writeFileSync(path.join(base,name),b);pipeline[name]=sha(b)}
 const bootstraps={};for(const arch of ['x64','arm64']){const exe=Buffer.from('test-helper-'+arch),config=Buffer.from('test-config-'+arch);fs.writeFileSync(path.join(base,'windows-worker','bootstrap','capture-'+arch+'.exe'),exe);fs.writeFileSync(path.join(base,'windows-worker','bootstrap','capture-'+arch+'.exe.config'),config);bootstraps[arch]={length:exe.length,sha256:sha(exe),configLength:config.length,configSha256:sha(config)}}
 const policy={schema:1,state:'candidate-unaccepted',manifest:{length:bytes.length,sha256:sha(bytes)},files,bootstraps,pipeline,imports,sharedId:'msys-2.0S5',sourceIdentity:'1'.repeat(64)}
 if(options.policyChange)options.policyChange(policy)
 const execPath=path.join(base,'controller.exe');fs.writeFileSync(execPath,'trusted test controller identity')
 const processFixture={platform:'win32',arch:options.arch||'x64',versions:{node:options.node||'24.20.0'},execPath,env:{SystemRoot:'C:\\Windows',AUTOPROMPT_WINDOWS_BASH:'C:\\malicious\\bash.exe',PROCESSOR_ARCHITECTURE:'wrong'}}
 const observation={captureCalls:0,privateCalls:0,authority:null}
 const capture=async(root,inventory,authority)=>{observation.captureCalls++;observation.authority=authority;if(options.captureFailure)throw options.captureFailure;const bootstrap={executableBytes:fs.readFileSync(authority.executable),configBytes:fs.readFileSync(authority.executable+'.config')};if(options.bootstrapChange)options.bootstrapChange(bootstrap);return{architecture:options.observedArch||processFixture.arch,records:inventory.map(file=>({path:file.path,bytes:fs.readFileSync(path.join(root,file.path))})),bootstrap}}
 const dependencies={'./windows-worker-policy.js':policy,'./windows-worker-decoder.js':options.decoder||decoder,'./windows-worker-capture.js':{captureWindowsFiles:capture},'./safe-run-root.js':{ensureWindowsPrivateAcl(){observation.privateCalls++;options.privacyHook?.({base,execPath});if(options.privacyFailure)throw options.privacyFailure}},'./windows-worker-pe.js':require('../../agents/codex/workflow/windows-worker-pe.js')}
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(WORKFLOW,'windows-worker-loader.js'),'utf8'),{require:name=>Object.hasOwn(dependencies,name)?dependencies[name]:require(name),module,exports:module.exports,__dirname:base,process:processFixture,Buffer,console},{filename:'actual-windows-worker-loader.js'})
 return{api:module.exports,base,bundle,policy,raw,observation,processFixture}
}
test('public production API has no caller authority, hooks, paths or factory selection',()=>{
 const api=require('../../agents/codex/workflow/windows-worker-loader.js');assert.deepEqual(Object.keys(api),['staticAvailability','captureWorkerTuple','describeTuple','revalidateTuple','materializeTuple']);assert.equal(api.staticAvailability().accepted,false)
 assert.throws(()=>api.staticAvailability({}),/arguments-refused/);assert.throws(()=>api.captureWorkerTuple({}),/arguments-refused/)
})
test('an unconfigured source policy refuses both presence and capture before helper execution',async t=>{
 const x=setup(t,{policyChange:policy=>{for(const key of Object.keys(policy))delete policy[key];Object.assign(policy,{schema:1,state:'not-configured'})}})
 assert.equal(x.api.staticAvailability().available,false);await assert.rejects(x.api.captureWorkerTuple(),/bundle-not-configured/);assert.equal(x.observation.captureCalls,0)
})
for(const arch of ['x64','arm64'])test('actual composition captures once and decodes/materializes exact '+arch+' tuple',async t=>{
 const x=setup(t,{arch});assert.equal(x.api.staticAvailability().available,true);assert.equal(x.api.staticAvailability().accepted,false)
 const a=x.api.captureWorkerTuple(),b=x.api.captureWorkerTuple();const tuple=await a;assert.equal(await b,tuple);assert.equal(await x.api.captureWorkerTuple(),tuple);assert.equal(x.observation.captureCalls,1)
 assert.ok(x.observation.authority.executable.endsWith('capture-'+arch+'.exe'));const desc=x.api.describeTuple(tuple);assert.equal(desc.accepted,false);assert.equal(desc.architecture,arch);assert.equal(desc.sharedId,'msys-2.0S5')
 const target=path.join(x.base,'materialized');const result=x.api.materializeTuple(tuple,target);assert.equal(result.identity,desc.identity);assert.equal(fs.readFileSync(path.join(target,'etc','fstab'),'utf8'),'none /tmp usertemp binary,posix=0,noacl 0 0\n')
 for(const file of desc.files){const bytes=fs.readFileSync(path.join(target,file.path));assert.equal(sha(bytes),file.sha256)}
 fs.chmodSync(result.node,0o700);fs.writeFileSync(result.node,'mutated materialization');const second=x.api.materializeTuple(tuple,path.join(x.base,'second'));assert.equal(sha(fs.readFileSync(second.node)),sha(x.raw['assets/node-'+arch+'.br']))
 assert.equal(x.observation.privateCalls,2);assert.equal(desc.controllerSha256,sha(fs.readFileSync(x.processFixture.execPath)))
})
for(const arch of ['x64','arm64'])test('only the selected '+arch+' Node asset receives the bounded contention deadline',async t=>{
 const calls=[],wrapped={...decoder,async decode(capability,file,options){calls.push({file,options});return decoder.decode(capability,file,options)}}
 const x=setup(t,{arch,decoder:wrapped});await x.api.captureWorkerTuple()
 assert.deepEqual(calls.map(call=>call.file),['assets/bash.br','assets/msys.br',`assets/node-${arch}.br`])
 assert.equal(calls[0].options,undefined);assert.equal(calls[1].options,undefined)
 assert.deepEqual(Object.keys(calls[2].options),['deadlineMs']);assert.equal(calls[2].options.deadlineMs,60000)
})
test('helper observed native architecture must match controller-selected bootstrap',async t=>{
 const x=setup(t,{observedArch:'arm64'});await assert.rejects(x.api.captureWorkerTuple(),/native-controller-architecture-mismatch/)
})
for(const name of ['executableBytes','configBytes'])test('captured canary helper '+name+' must retain exact source authority',async t=>{
 const x=setup(t,{bootstrapChange:bootstrap=>{bootstrap[name]=Buffer.from('changed')}});await assert.rejects(x.api.captureWorkerTuple(),/captured-bootstrap-identity/)
})
test('unknown capture cleanup poisons the process cache without another launch',async t=>{
 const failure=Object.assign(Error('unknown drain'),{cleanupConfirmed:false});const x=setup(t,{captureFailure:failure});await assert.rejects(x.api.captureWorkerTuple(),e=>e===failure);await assert.rejects(x.api.captureWorkerTuple(),e=>e!==failure&&e.message===failure.message&&e.cleanupConfirmed===false&&Object.isFrozen(e.workerFailure));assert.equal(x.observation.captureCalls,1)
})
test('unknown decoder cleanup likewise poisons the process cache',async t=>{
 const failure=Object.assign(Error('unknown decoder'),{cleanupConfirmed:false});const x=setup(t,{decoder:{...decoder,decode:async()=>{throw failure}}});await assert.rejects(x.api.captureWorkerTuple(),e=>e===failure);await assert.rejects(x.api.captureWorkerTuple(),e=>e!==failure&&e.message===failure.message&&e.cleanupConfirmed===false&&Object.isFrozen(e.workerFailure));assert.equal(x.observation.captureCalls,1)
})
test('known-close failure permits only an explicit same-policy retry',async t=>{
 const x=setup(t,{captureFailure:Object.assign(Error('closed failure'),{cleanupConfirmed:true})});await assert.rejects(x.api.captureWorkerTuple());await assert.rejects(x.api.captureWorkerTuple());assert.equal(x.observation.captureCalls,2)
})
for(const[title,change]of [
 ['extra policy authority',p=>p.accepted=true],['passed-marker admission',p=>p.state='passed'],['unknown pipeline',p=>p.pipeline.extra='0'.repeat(64)],
 ['changed fixed input role',p=>p.files[0].output='usr/bin/evil.exe'],['wrong bootstrap hash',p=>p.bootstraps.x64.sha256='0'.repeat(64)],
 ['wrong source identity',p=>p.sourceIdentity='invalid'],['invalid shared id',p=>p.sharedId='global'],['duplicate import',p=>p.imports['assets/bash.br'].push('kernel32.dll')]
])test('static availability refuses '+title,t=>{const x=setup(t,{policyChange:change});assert.equal(x.api.staticAvailability().available,false)})
for(const[title,change]of [
 ['Node executable DLL flag',(role,b)=>{if(role==='node-x64')b.writeUInt16LE(0x2002,86)}],
 ['MSYS missing DLL flag',(role,b)=>{if(role==='msys')b.writeUInt16LE(2,86)}],
 ['wrong Node architecture',(role,b)=>{if(role==='node-x64')b.writeUInt16LE(0xaa64,68)}],
 ['missing shared info',(role,b)=>{if(role==='msys')b.fill(0,1500)}]
])test('actual raw PE validation refuses '+title,async t=>{const x=setup(t,{rawChange:change});await assert.rejects(x.api.captureWorkerTuple())})
test('static availability is presence-only; corrupted same-length compressed bytes fail capture decoding',async t=>{
 const x=setup(t),file=path.join(x.bundle,'assets/bash.br'),bytes=fs.readFileSync(file);bytes[0]^=255;fs.writeFileSync(file,bytes)
 assert.equal(x.api.staticAvailability().available,true);await assert.rejects(x.api.captureWorkerTuple(),/content-mismatch|hash|digest/)
})
test('pipeline byte changes refuse availability and capture',async t=>{const x=setup(t);fs.appendFileSync(path.join(x.base,'windows-worker-capture.js'),'changed');assert.equal(x.api.staticAvailability().available,false);await assert.rejects(x.api.captureWorkerTuple())})
for(const subject of ['controller',...PIPELINE])test('cached tuple refuses '+subject+' changes and poisons later reuse',async t=>{
 const x=setup(t),tuple=await x.api.captureWorkerTuple()
 const file=subject==='controller'?x.processFixture.execPath:path.join(x.base,subject),original=fs.readFileSync(file)
 fs.appendFileSync(file,'changed')
 const destination=path.join(x.base,'must-not-materialize')
 assert.throws(()=>x.api.revalidateTuple(tuple),/pipeline-changed|controller-node-changed/)
 assert.throws(()=>x.api.materializeTuple(tuple,destination),/pipeline-changed|controller-node-changed/)
 assert.equal(fs.existsSync(destination),false)
 fs.writeFileSync(file,original)
 await assert.rejects(x.api.captureWorkerTuple(),/pipeline-changed|controller-node-changed/)
 assert.equal(x.observation.captureCalls,1)
})
test('capture cache itself rechecks current controller bytes before returning its capability',async t=>{
 const x=setup(t);await x.api.captureWorkerTuple();fs.appendFileSync(x.processFixture.execPath,'changed')
 await assert.rejects(x.api.captureWorkerTuple(),/controller-node-changed/);assert.equal(x.observation.captureCalls,1)
})
test('materialization itself rechecks current pipeline before creating a runtime',async t=>{
 const x=setup(t),tuple=await x.api.captureWorkerTuple(),destination=path.join(x.base,'must-not-exist')
 fs.appendFileSync(path.join(x.base,'windows-worker-loader.js'),'changed')
 assert.throws(()=>x.api.materializeTuple(tuple,destination),/pipeline-changed/);assert.equal(fs.existsSync(destination),false)
})
test('trust input mutation during materialization refuses its result and removes confirmed private files',async t=>{
 const x=setup(t,{privacyHook:({execPath})=>fs.appendFileSync(execPath,'changed')}),tuple=await x.api.captureWorkerTuple(),destination=path.join(x.base,'never-returned')
 assert.throws(()=>x.api.materializeTuple(tuple,destination),e=>/controller-node-changed/.test(e.message)&&e.cleanupConfirmed===true)
 assert.equal(fs.existsSync(destination),false)
 await assert.rejects(x.api.captureWorkerTuple(),/controller-node-changed/)
})
for(const key of ['arch','node'])test('cached tuple remains bound to the complete controller '+key,async t=>{
 const x=setup(t);await x.api.captureWorkerTuple()
 if(key==='arch')x.processFixture.arch='arm64';else x.processFixture.versions.node='24.20.1'
 await assert.rejects(x.api.captureWorkerTuple(),/controller-identity-changed/)
})
test('materialization refuses existing paths and linked parents without deleting them',async t=>{
 const x=setup(t),tuple=await x.api.captureWorkerTuple(),existing=path.join(x.base,'existing');fs.mkdirSync(existing);fs.writeFileSync(path.join(existing,'keep'),'owned')
 assert.throws(()=>x.api.materializeTuple(tuple,existing));assert.equal(fs.readFileSync(path.join(existing,'keep'),'utf8'),'owned')
 const link=path.join(x.base,'alias');fs.symlinkSync(existing,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>x.api.materializeTuple(tuple,path.join(link,'child')));assert.equal(fs.existsSync(path.join(existing,'child')),false)
})
test('forged or serialized tuples cannot describe or materialize',async t=>{const x=setup(t);assert.throws(()=>x.api.describeTuple({}));assert.throws(()=>x.api.materializeTuple({},path.join(x.base,'forged')));const tuple=await x.api.captureWorkerTuple();assert.throws(()=>x.api.describeTuple(JSON.parse(JSON.stringify(tuple))))})
for(const node of ['18.20.0','19.9.0','invalid'])test('untested controller Node'+node+' refuses before capture',async t=>{const x=setup(t,{node});await assert.rejects(x.api.captureWorkerTuple(),/untested-controller/);assert.equal(x.observation.captureCalls,0)})

test('uncertain materialization privacy setup retains the new root and poisons reuse',async t=>{
 const failure=Error('privacy setup failed'),x=setup(t,{privacyFailure:failure}),tuple=await x.api.captureWorkerTuple(),root=path.join(x.base,'retained')
 assert.throws(()=>x.api.materializeTuple(tuple,root),error=>error===failure&&error.cleanupConfirmed===false&&error.retainedRuntimeRoot===root)
 assert.equal(fs.existsSync(root),true);await assert.rejects(x.api.captureWorkerTuple(),error=>error!==failure&&error.cleanupConfirmed===false&&error.retainedRuntimeRoot===root)
 assert.throws(()=>x.api.materializeTuple(tuple,path.join(x.base,'retry')),error=>error!==failure&&error.cleanupConfirmed===false&&error.retainedRuntimeRoot===root)
})

for(const node of ['20.20.2','22.20.0','24.20.0','26.0.0'])test('package engine controller '+node+' can attempt fresh candidate validation',async t=>{
 const x=setup(t,{node}),tuple=await x.api.captureWorkerTuple();assert.equal(x.api.describeTuple(tuple).accepted,false);assert.equal(x.observation.captureCalls,1)
})

test('loader poison snapshots original authority and creates independent errors for later operations',async t=>{
 const recovery={leaseId:'original-lease',journalPath:'original-journal'},failure=Object.assign(Error('original failure'),{code:'ORIGINAL',cleanupConfirmed:false,recovery,retainedHelperRoot:'original-root'})
 const x=setup(t,{captureFailure:failure});await assert.rejects(x.api.captureWorkerTuple(),error=>error===failure)
 failure.message='caller mutated';failure.cleanupConfirmed=true;failure.retainedHelperRoot='wrong-root';recovery.leaseId='wrong-lease'
 let first,second
 await assert.rejects(x.api.captureWorkerTuple(),error=>{first=error;return true})
 first.recovery={leaseId:'operation-one'};first.cleanupConfirmed=true
 await assert.rejects(x.api.captureWorkerTuple(),error=>{second=error;return true})
 assert.notEqual(first,second);assert.equal(second.code,'ORIGINAL');assert.equal(second.message,'original failure');assert.equal(second.cleanupConfirmed,false);assert.equal(second.retainedHelperRoot,'original-root')
 assert.equal(second.recovery,undefined);assert.equal(second.workerFailure.recovery.leaseId,'original-lease');assert.ok(Object.isFrozen(second.workerFailure.recovery));assert.equal(x.observation.captureCalls,1)
})
test('runtime mutation poison creates separate errors for concurrent command recovery',async t=>{
 const x=setup(t),tuple=await x.api.captureWorkerTuple();fs.appendFileSync(x.processFixture.execPath,'changed')
 let first,second
 try{x.api.revalidateTuple(tuple)}catch(error){first=error}
 first.recovery={leaseId:'first'}
 try{x.api.revalidateTuple(tuple)}catch(error){second=error}
 second.recovery={leaseId:'second'}
 assert.notEqual(first,second);assert.equal(first.recovery.leaseId,'first');assert.equal(second.workerFailure.message,'controller-node-changed');assert.equal(second.workerFailure.recovery,undefined)
})
