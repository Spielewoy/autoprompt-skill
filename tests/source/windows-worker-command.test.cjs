'use strict'
// Controller integration tests. Native ACL/Job behavior is covered separately
// on Windows; these fixtures verify selection, ownership and failure routing.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm')
const {createRequire}=require('node:module')
function setup(t,scenario={}){
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'worker-command-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const controlRoot=path.join(root,'controller'),scratch=path.join(root,'scratch');fs.mkdirSync(controlRoot);fs.mkdirSync(scratch)
 const tuple=Object.freeze({}),identity='a'.repeat(64),events=[],canaries=[],materializedRoots=new Set();let materializedRoot
 const evidence={exitCode:0,stdout:Buffer.from('owned'),stderr:Buffer.alloc(0),launcherSessionId:17,timedOut:false,truncated:false,cancelled:false}
 const launcher={verifyDrainEvidence(){},proveNotStarted(){return evidence},async launch(request){events.push('launch');if(scenario.inspectLaunch)scenario.inspectLaunch(request);if(scenario.launchError)throw scenario.launchError;assert.ok([...materializedRoots].some(root=>request.executable===path.join(root,'usr/bin/bash.exe')));assert.equal(request.executableSha256,'b'.repeat(64));assert.equal(request.msysRuntime.dllSha256,'c'.repeat(64));assert.equal(request.environment.find(s=>s.startsWith('PATH=')),`PATH=${path.dirname(request.executable)}`);assert.equal(request.environment.some(s=>s.startsWith('AUTOPROMPT_WINDOWS_BASH=')),false);return evidence}}
 const replacements={
  'node:fs':scenario.filesystem||fs,
  './windows-appcontainer-probe.js':{canaryKey(){return scenario.key||'e'.repeat(64)},async runWindowsAppContainerCanary(execute,worker,key){canaries.push({execute,worker,key});if(scenario.canaryWait)await scenario.canaryWait;if(scenario.canaryError)throw scenario.canaryError;if(scenario.canaryExec)await execute({scratchPath:scratch,readableRoots:[scratch],writableRoots:[scratch]},{command:'fixed-native-canary',cwd:scratch},{controlRoot});return scenario.canaryResult||{supported:true,workerIdentity:identity,runtimeSha256:key,processCleanup:'owned-job-drained'}}},
  './safe-run-root.js':{ensureWindowsPrivateAcl(){}},
  'node:child_process':{spawnSync(){assert.fail('Production must never discover or launch an ambient Bash')}},
  './windows-worker-loader.js':{async captureWorkerTuple(){events.push('capture');if(scenario.captureError)throw scenario.captureError;return tuple},describeTuple(value){assert.equal(value,tuple);return{identity}},revalidateTuple(value){assert.equal(value,tuple);if(scenario.revalidationError)throw scenario.revalidationError;return{identity}},materializeTuple(value,directory){events.push('materialize');assert.equal(value,tuple);materializedRoot=directory;materializedRoots.add(directory);if(scenario.materialize)return scenario.materialize(directory);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'retained'),'owned');if(scenario.materializeError)throw scenario.materializeError;return{identity:scenario.wrongIdentity?'d'.repeat(64):identity,bash:path.join(directory,'usr/bin/bash.exe'),bashSha256:'b'.repeat(64),msysRuntime:{dllPath:path.join(directory,'usr/bin/msys-2.0.dll'),dllSha256:'c'.repeat(64),sharedId:'msys-2.0S5'}}}},
  './windows-helper-deployment.js':{stageWindowsHelperDeployment(){events.push('stage');return{root:path.join(root,'helper'),cleanup(){events.push('helper-cleanup');if(scenario.cleanupError)throw scenario.cleanupError}}}},
  './windows-appcontainer-resources.js':{async prepareWindowsAppContainerResources(options){events.push('lease');assert.equal(options.executableRoots[0].path,materializedRoot);if(scenario.prepare)return scenario.prepare(options,evidence);return{profileName:'owned',profileSid:'owned',environment:{},recovery:{leaseId:'owned'},async release(received){assert.equal(received,evidence);events.push('release');if(scenario.releaseError)throw scenario.releaseError;return scenario.resourceRecovery||{restored:4,newEntries:2,deletedEntries:1}}}},recoverWindowsAppContainerResources(){assert.fail('Unexpected recovery')}},
 }
 const filename=path.resolve(__dirname,'../../agents/codex/workflow/windows-appcontainer-command.js'),localRequire=createRequire(filename),module={exports:{}}
 replacements['./windows-appcontainer.js']={...localRequire('./windows-appcontainer.js'),createWindowsAppContainerLauncher(){events.push('launcher');return scenario.makeLauncher?scenario.makeLauncher(launcher,evidence):launcher}}
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,__dirname:path.dirname(filename),process:{platform:'win32',env:{SystemRoot:'C:\\Windows',AUTOPROMPT_WINDOWS_BASH:'hostile'},execPath:'/must/not/copy/controller'},require:name=>Object.hasOwn(replacements,name)?replacements[name]:localRequire(name)},{filename})
 return{root,events,identity,canaries,api:module.exports,get runtimeRoot(){return materializedRoot},run:()=>module.exports.runWindowsAppContainerCommand({...(scenario.noScratch?{}:{scratchPath:scratch}),readableRoots:[scratch],writableRoots:[scratch]},{command:'printf owned',cwd:scratch},{controlRoot,bashPath:'hostile',env:{AUTOPROMPT_WINDOWS_BASH:'hostile'}})}
}
test('production command uses captured worker tuple, reports identity and releases before removal',async t=>{const x=setup(t),result=await x.run();assert.equal(result.status,'completed');assert.equal(result.workerIdentity,x.identity);assert.equal(result.stdout,'owned');assert.equal(Object.isFrozen(result.resourceRecovery),true);assert.deepEqual({...result.resourceRecovery},{restored:4,newEntries:2,deletedEntries:1});assert.deepEqual(x.events,['capture','stage','launcher','materialize','lease','launch','release','helper-cleanup']);assert.equal(fs.existsSync(x.runtimeRoot),false)})
test('unavailable packaged workers refuse before helper deployment or ambient fallback',async t=>{const failure=Object.assign(Error('bundle-unavailable'),{code:'WINDOWS_WORKER_BUNDLE_INVALID'}),x=setup(t,{captureError:failure});await assert.rejects(x.run(),error=>error===failure);assert.deepEqual(x.events,['capture'])})
test('materialization identity mismatch refuses before resource grants or worker launch',async t=>{const x=setup(t,{wrongIdentity:true});await assert.rejects(x.run(),{code:'WINDOWS_RUNTIME_MISMATCH'});assert.equal(x.events.includes('lease'),false);assert.equal(x.events.includes('launch'),false);assert.equal(fs.existsSync(x.runtimeRoot),false)})
test('unconfirmed materialization cleanup preserves owned runtime and original failure',async t=>{const failure=Object.assign(Error('materialization-failed'),{cleanupConfirmed:false}),x=setup(t,{materializeError:failure});await assert.rejects(x.run(),error=>error===failure);assert.equal(x.events.includes('launch'),false);assert.equal(fs.readFileSync(path.join(x.runtimeRoot,'retained'),'utf8'),'owned')})
test('command cleanup preserves an existing runtime when the loader exclusive mkdir refuses ownership',async t=>{
 const x=setup(t,{materialize(directory){
  // Simulate another allocation winning before the loader's exclusive mkdir.
  fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'foreign-marker'),'another owner')
  fs.mkdirSync(directory)
 }})
 await assert.rejects(x.run(),{code:'EEXIST'})
 assert.equal(fs.readFileSync(path.join(x.runtimeRoot,'foreign-marker'),'utf8'),'another owner')
 assert.equal(x.events.includes('lease'),false);assert.equal(x.events.includes('launch'),false)
})
test('command cleanup preserves a scratch collision before its own mkdir succeeds',async t=>{
 let foreign
 const filesystem={...fs,mkdirSync(directory,options){
  if(path.basename(directory).startsWith('command-scratch-')){foreign=directory;fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'foreign-marker'),'another owner')}
  return fs.mkdirSync(directory,options)
 }}
 const x=setup(t,{noScratch:true,filesystem});await assert.rejects(x.run(),{code:'EEXIST'})
 assert.equal(fs.readFileSync(path.join(foreign,'foreign-marker'),'utf8'),'another owner')
 assert.equal(x.events.includes('materialize'),false);assert.equal(x.events.includes('lease'),false);assert.equal(x.events.includes('launch'),false)
})
test('cancellation stays inside the owned deployment and never unlinks shared controller markers',async t=>{
 let cancellation
 const x=setup(t,{inspectLaunch(request){cancellation=request.cancellationPath},filesystem:{...fs,unlinkSync(){assert.fail('Wrapper must not remove shared controller markers')}}})
 const marker=path.join(x.root,'controller','cancel-other-owner');fs.writeFileSync(marker,'another command')
 await x.run();assert.equal(cancellation,path.join(x.root,'helper','cancel'));assert.equal(fs.readFileSync(marker,'utf8'),'another command')
 assert.equal(x.events.includes('helper-cleanup'),true)
})

test('secondary helper cleanup failure cannot erase an unknown materialization failure',async t=>{const original=Object.assign(Error('materialization-failed'),{cleanupConfirmed:false}),cleanup=Object.assign(Error('helper-cleanup'),{code:'EACCES'}),x=setup(t,{materializeError:original,cleanupError:cleanup});await assert.rejects(x.run(),error=>error===original&&error.cleanupConfirmed===false&&error.cleanupCode==='EACCES');assert.equal(fs.readFileSync(path.join(x.runtimeRoot,'retained'),'utf8'),'owned');assert.equal(original.retainedControlRoot,path.join(x.root,'controller'))})
test('cleanup failure after drained completion refuses success and retains outer-root marker',async t=>{const cleanup=Object.assign(Error('helper-cleanup'),{code:'EACCES'}),x=setup(t,{cleanupError:cleanup});await assert.rejects(x.run(),error=>error===cleanup&&error.cleanupConfirmed===false&&error.retainedControlRoot===path.join(x.root,'controller'));assert.ok(x.events.indexOf('release')<x.events.indexOf('helper-cleanup'))})
test('secondary recovery failure preserves original launch error and unresolved lease',async t=>{const original=Object.assign(Error('launch-refused'),{code:'WINDOWS_LAUNCH_REFUSED'}),recovery=Object.assign(Error('recovery-failed'),{code:'RESTORE_FAILED'}),x=setup(t,{launchError:original,releaseError:recovery});await assert.rejects(x.run(),error=>error===original&&error.cleanupConfirmed===false&&error.recoveryFailureCode==='RESTORE_FAILED'&&error.recovery.leaseId==='owned');assert.equal(fs.readFileSync(path.join(x.runtimeRoot,'retained'),'utf8'),'owned');assert.equal(x.events.includes('helper-cleanup'),false)})

// These are admission-routing seams only; a passing fixture does not claim a
// native canary passed. The real fixture retains all kernel checks separately.
test('simultaneous direct command callers share one canary before arbitrary launch',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve}),x=setup(t,{canaryWait:gate})
 const first=x.run(),second=x.run();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(x.canaries.length,1);assert.equal(x.events.includes('stage'),false);release();await Promise.all([first,second]);assert.equal(x.events.filter(x=>x==='launch').length,2)
 await x.run();assert.equal(x.canaries.length,1)
})
for(const result of [{supported:false,code:'NATIVE_PROBE_FAILED'},{supported:true,workerIdentity:'wrong',runtimeSha256:'e'.repeat(64),processCleanup:'owned-job-drained'},{supported:true,workerIdentity:'a'.repeat(64),runtimeSha256:'wrong',processCleanup:'owned-job-drained'},{supported:true,workerIdentity:'a'.repeat(64),runtimeSha256:'e'.repeat(64),processCleanup:'unconfirmed'}])test('unaccepted canary cannot authorize direct tool-server command: '+JSON.stringify(result),async t=>{
 const x=setup(t,{canaryResult:result});await assert.rejects(x.run(),{code:'COMMAND_SANDBOX_UNSUPPORTED'});assert.equal(x.events.includes('stage'),false);assert.equal(x.events.includes('launch'),false)
})
test('rejected canary blocks arbitrary launch and uncertain cleanup poisons admission',async t=>{
 const failure=Object.assign(Error('unconfirmed native canary'),{cleanupConfirmed:false}),scenario={canaryError:failure},x=setup(t,scenario)
 await assert.rejects(x.run(),error=>error===failure);delete scenario.canaryError
 await assert.rejects(x.run(),error=>error!==failure&&error.cleanupConfirmed===false&&error.admissionFailure?.message===failure.message);assert.equal(x.canaries.length,1);assert.equal(x.events.includes('launch'),false)
})
test('normal probe shares central admission and changed runtime key requires another canary',async t=>{
 const scenario={},x=setup(t,scenario);assert.equal((await x.api.probeWindowsAppContainer()).supported,true);await x.run();assert.equal(x.canaries.length,1)
 scenario.key='f'.repeat(64);await x.run();assert.equal(x.canaries.length,2)
})
test('runtime mutation during canary cannot be admitted',async t=>{
 let release;const scenario={canaryWait:new Promise(resolve=>{release=resolve})},x=setup(t,scenario),pending=x.run();await new Promise(resolve=>setImmediate(resolve));scenario.key='f'.repeat(64);release()
 await assert.rejects(pending,{code:'WINDOWS_RUNTIME_MISMATCH'});assert.equal(x.events.includes('launch'),false)
})

test('tool-server direct boundary entry refuses bash before admission without parent-probe reliance',async t=>{
 const x=setup(t,{canaryResult:{supported:false,code:'NATIVE_PROBE_FAILED'}}),filename=path.resolve(__dirname,'../../scripts/harness-v2-tool-boundary.cjs'),localRequire=createRequire(filename),module={exports:{}}
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,__dirname:path.dirname(filename),process:{...process,platform:'win32'},require:name=>name==='../agents/codex/workflow/windows-appcontainer-command.js'?x.api:localRequire(name)},{filename})
 const target=path.join(x.root,'target'),scratch=path.join(x.root,'scratch');fs.mkdirSync(target)
 const policy={provider:'claude',readOnly:false,targetPath:target,scratchPath:scratch,readableRoots:[target,scratch],writableRoots:[target,scratch],nestedDispatch:false,commandBoundary:true,externalWrites:false}
 await assert.rejects(module.exports.executeTool(policy,'bash',{command:'arbitrary-user-command'},{controlRoot:path.join(x.root,'controller')}),error=>error.code==='COMMAND_SANDBOX_UNSUPPORTED')
 assert.equal(x.canaries.length,1);assert.equal(x.events.includes('stage'),false);assert.equal(x.events.includes('launch'),false)
})
test('unknown arbitrary command cleanup invalidates earlier admission and refuses later commands',async t=>{
 const failure=Object.assign(Error('owned job close unknown'),{cleanupConfirmed:false}),scenario={},x=setup(t,scenario)
 await x.run();scenario.launchError=failure;await assert.rejects(x.run(),error=>error===failure);delete scenario.launchError
 const launches=x.events.filter(x=>x==='launch').length;await assert.rejects(x.run(),error=>error!==failure&&error.cleanupConfirmed===false&&error.admissionFailure?.message===failure.message);assert.equal(x.events.filter(x=>x==='launch').length,launches)
})

for(const recoveryFails of [true,false])test('concurrent poisoned preparation isolates recovery when the unused lease '+(recoveryFails?'cannot restore':'restores'),async t=>{
 let startA,startB,failA,resumeB,launchers=0,prepares=0
 const aStarted=new Promise(resolve=>{startA=resolve}),bPreparing=new Promise(resolve=>{startB=resolve}),aFailure=new Promise((_,reject)=>{failA=reject}),bGate=new Promise(resolve=>{resumeB=resolve})
 const firstFailure=Object.assign(Error('A job closure unconfirmed'),{cleanupConfirmed:false,code:'APPCONTAINER_CLEANUP_UNCONFIRMED'}),released=[]
 const scenario={
  makeLauncher(base,evidence){const id=++launchers;let started=false;return{...base,proveNotStarted(){if(started)throw Error('owned job already started');return evidence},async launch(request){assert.equal(id,1,'No post-poison command may launch');started=true;await base.launch(request);startA();return aFailure}}},
  async prepare(options,evidence){const id=++prepares;if(id===2){startB();await bGate}return{profileName:'profile'+id,profileSid:'sid'+id,environment:{},recovery:{leaseId:'lease'+id,journalPath:'journal'+id},async release(received){assert.equal(received,evidence);released.push(id);assert.equal(id,2);if(recoveryFails)throw Object.assign(Error('B restore failed'),{code:'B_RESTORE_FAILED'})}}},
 }
 const x=setup(t,scenario),a=x.run().catch(error=>error);await aStarted
 const b=x.run().catch(error=>error);await bPreparing
 failA(firstFailure);const ae=await a;assert.equal(ae,firstFailure);assert.equal(ae.recovery.leaseId,'lease1');const firstBinding=ae.recovery
 resumeB();const be=await b
 assert.notEqual(be,ae);assert.equal(ae.recovery,firstBinding);assert.equal(ae.recovery.leaseId,'lease1');assert.equal(ae.recovery.journalPath,'journal1')
 assert.equal(be.cleanupConfirmed,false)
 if(recoveryFails){assert.equal(be.recovery.leaseId,'lease2');assert.equal(be.recovery.journalPath,'journal2');assert.equal(be.recoveryFailureCode,'B_RESTORE_FAILED');assert.equal(fs.existsSync(x.runtimeRoot),true)}
 else{assert.equal(be.recovery,undefined);assert.equal(be.recoveryFailureCode,undefined);assert.equal(fs.existsSync(x.runtimeRoot),false,'A prior failure must not leak a later, proven-unused runtime')}
 assert.equal(be.admissionFailure.recovery.leaseId,'lease1');assert.equal(be.admissionFailure.recovery.journalPath,'journal1');assert.equal(Object.isFrozen(be.admissionFailure),true);assert.equal(Object.isFrozen(be.admissionFailure.recovery),true)
 assert.deepEqual(released,[2]);assert.equal(x.events.filter(value=>value==='launch').length,1)
 await assert.rejects(x.run(),error=>error!==ae&&error!==be&&error.admissionFailure.recovery.leaseId==='lease1')
 assert.equal(launchers,2);assert.equal(x.events.filter(value=>value==='launch').length,1)
})

test('private canary executor launches the bound tuple without recursive public admission',{timeout:5000},async t=>{
 const x=setup(t,{canaryExec:true});await x.run();assert.equal(x.canaries.length,1);assert.equal(x.events.filter(x=>x==='launch').length,2);assert.equal(x.events.filter(x=>x==='release').length,2)
 assert.equal(Object.hasOwn(x.api,'runTupleCommand'),false);assert.equal(Object.hasOwn(x.api,'ensureWorkerAdmission'),false)
})
test('unsupported canary with retained recovery root poisons later admission',async t=>{
 const scenario={canaryResult:{supported:false,code:'APPCONTAINER_CLEANUP_UNCONFIRMED',recoveryRoot:'retained-native-fixture'}},x=setup(t,scenario)
 await assert.rejects(x.run(),error=>error.cleanupConfirmed===false&&error.recoveryRoot==='retained-native-fixture');delete scenario.canaryResult
 await assert.rejects(x.run(),error=>error.cleanupConfirmed===false);assert.equal(x.canaries.length,1);assert.equal(x.events.includes('launch'),false)
})
