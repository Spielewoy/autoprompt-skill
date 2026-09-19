'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),binding=require('./binding.cjs')
const ROOT=path.resolve(__dirname,'../../..')
const context=()=>({schema:1,purpose:'compiler-output-smoke-not-runtime-acceptance',node:{architecture:process.arch,sha256:'a'.repeat(64),kind:'compiler-controller'},bash:{path:path.join(ROOT,'fixture/bash.exe'),files:[{name:'bash.exe',sha256:'b'.repeat(64),bytes:10},{name:'msys-2.0.dll',sha256:'c'.repeat(64),bytes:20}]}})
test('diagnostic authority requires exact caller pins and has no runtime acceptance state',()=>{
 const c=context();assert.deepEqual(binding.validate(c),c)
 for(const change of [v=>v.extra=true,v=>v.purpose='accepted',v=>v.node.sha256='wrong',v=>v.node.kind='ambient',v=>v.bash.path='relative',v=>v.bash.files.reverse(),v=>v.bash.files.push(v.bash.files[0]),v=>v.bash.files[0].name='../bash.exe',v=>v.node.extra='override']){const v=structuredClone(c);change(v);assert.throws(()=>binding.validate(v))}
})
test('exact diagnostic selection refuses changed Node or Bash and never tries a fallback',()=>{
 const c=context(),visited=[]
 const helpers={bindRuntimeFile(file){visited.push(file);return {path:file,sha256:file===process.execPath?c.node.sha256:c.bash.files[0].sha256}},bindBashRuntime(directory){assert.equal(directory,path.dirname(c.bash.path));return c.bash.files.map(x=>({...x,bytes:Buffer.alloc(x.bytes)}))}}
 assert.equal(binding.select(c,helpers).bash.path,c.bash.path);assert.deepEqual(visited,[process.execPath,c.bash.path])
 assert.throws(()=>binding.select({...c,node:{...c.node,sha256:'d'.repeat(64)}},helpers),/Node differs/)
 assert.throws(()=>binding.select({...c,bash:{...c.bash,files:[{...c.bash.files[0],sha256:'e'.repeat(64)},c.bash.files[1]]}},helpers),/closure differs/)
 const unavailable={...helpers,bindRuntimeFile(file){assert.equal(file,process.execPath);throw Error('selected missing')}};assert.throws(()=>binding.select(c,unavailable),/selected missing/)
})
test('derived copies exactly reconstruct reviewed originals and controlled changes',()=>{
 const lineage=JSON.parse(fs.readFileSync(path.join(__dirname,'lineage.json')))
 for(const [name,sha]of Object.entries(lineage.originalSha256))assert.equal(binding.hash(fs.readFileSync(path.join(__dirname,'original',name+'.js.txt'))),sha)
 const result=cp.spawnSync(process.platform==='win32'?'python':'python3',[path.join(__dirname,'derive.py'),'--check'],{encoding:'utf8',timeout:15000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.ifError(result.error);assert.equal(result.status,0,result.stderr)
 const command=fs.readFileSync(path.join(__dirname,'command.cjs'),'utf8'),probe=fs.readFileSync(path.join(__dirname,'probe.cjs'),'utf8')
 assert.ok(!command.includes('windowsBashCandidates')&&!command.includes('AUTOPROMPT_WINDOWS_BASH'));assert.ok(probe.includes("gitDenied=['EACCES','EPERM'].includes(e.code)"));assert.ok(probe.includes("error.code='GIT_'+gitOutcome"));assert.ok(probe.includes("probeFailure.gitGuard"));assert.ok(!probe.includes('cached'))
})
test('shared native body preserves every original assertion and production selects production modules',()=>{
 const original=fs.readFileSync(path.join(__dirname,'original/smoke-test.js.txt'),'utf8'),marker="test('native Windows Bash copied closure permits scratch writes and denies candidate writes and controller reads', { skip: process.platform !== 'win32', timeout: 600000 }, async t => {\n"
 let body=original.slice(original.indexOf(marker)+marker.length,-3)
 for(const line of ["  const { probeWindowsAppContainer } = require('../../agents/codex/workflow/windows-appcontainer-probe.js')\n","  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')\n","  const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')\n"])body=body.replace(line,'')
 body=body.replace('boundary.executeTool(','executeTool(')
 body=body.replace("  t.after(() => fs.rmSync(root, { recursive: true, force: true }))", "  let preserve = false\n  t.after(() => { if (!preserve) fs.rmSync(root, { recursive: true, force: true }) })")
 body=body.replace("  const result = await executeTool(policy, 'bash', { command, timeoutMs: 30000 }, { controlRoot })", "  let result\n  try { result = await executeTool(policy, 'bash', { command, timeoutMs: 30000 }, { controlRoot }) } catch (error) {\n    preserve = error.cleanupConfirmed === false || error.code === 'APPCONTAINER_CLEANUP_UNCONFIRMED' || Boolean(error.recovery && !error.recoveryResolved)\n    if (preserve) t.diagnostic('Unconfirmed native cleanup; retained diagnostic root: ' + root)\n    throw error\n  }")
 const helper=fs.readFileSync(path.join(ROOT,'tests/helpers/windows-bash-native-smoke.cjs'),'utf8');assert.ok(helper.includes(body))
 const production=fs.readFileSync(path.join(ROOT,'tests/source/windows-bash-runtime.test.cjs'),'utf8');assert.ok(production.includes("require('../../agents/codex/workflow/windows-appcontainer-probe.js').probeWindowsAppContainer"));assert.ok(production.includes("require('../../scripts/harness-v2-tool-boundary.cjs').executeTool"));assert.ok(!production.includes('diagnostic-smoke'))
 for(const file of ['windows-appcontainer-command.js','windows-appcontainer-probe.js'])assert.ok(!fs.readFileSync(path.join(ROOT,'agents/codex/workflow',file),'utf8').includes('diagnostic-smoke'))
})
test('Git-write observation separates an actual write from other errors without accepting new errno',()=>{
 const text=fs.readFileSync(path.join(__dirname,'probe.cjs'),'utf8'),start=text.indexOf("let gitDenied=false,gitOutcome="),end=text.indexOf("phase='git-rename-delete'",start),body=text.slice(start,end)
 for(const [outcome,accepted]of [['WRITE_SUCCEEDED',false],['EACCES',true],['EPERM',true],['ENOENT',false],['bad error text',false]]){
  const run=new Function('fs','path','f',body),fake={writeFileSync(){if(outcome!=='WRITE_SUCCEEDED')throw {code:outcome}}}
  if(accepted)assert.doesNotThrow(()=>run(fake,path,{target:'/fixture'}));else assert.throws(()=>run(fake,path,{target:'/fixture'}),{code:'GIT_'+(outcome==='bad error text'?'OTHER_ERRNO':outcome)})
 }
})
test('actual Node diagnostic entry emits TAP while preserving context arguments',t=>{
 const os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-tap-entry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const entry=path.join(root,'entry.cjs'),{TEST_NAME,selectedTestPassed}=require('../probe-built-runtime.cjs')
 fs.writeFileSync(entry,`require('node:assert/strict').deepEqual(process.argv.slice(2),['context-path','${'a'.repeat(64)}']);require('node:test')(${JSON.stringify(TEST_NAME)},()=>{});`)
 const result=cp.spawnSync(process.execPath,['--test-reporter=tap',entry,'context-path','a'.repeat(64)],{encoding:'utf8',timeout:15000,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!['NODE_TEST_CONTEXT','NODE_OPTIONS','NODE_PATH'].includes(key.toUpperCase())))})
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/^TAP version 13\n/);selectedTestPassed(result.stdout)
})
test('shared smoke retains unresolved native roots and removes confirmed-failure fixtures',async()=>{
 const {runNativeWindowsBashSmoke}=require('../../../tests/helpers/windows-bash-native-smoke.cjs')
 for(const unconfirmed of [true,false]){
  const callbacks=[],notes=[];let root
  const error=Object.assign(new Error('controlled simulated launch failure'),unconfirmed?{cleanupConfirmed:false}:{})
  try{
   await assert.rejects(runNativeWindowsBashSmoke({after:fn=>callbacks.push(fn),diagnostic:note=>notes.push(note)},{probeWindowsAppContainer:async()=>({supported:true}),executeTool:async(policy,name,args,options)=>{root=path.dirname(options.controlRoot);throw error}}),error)
   for(const callback of callbacks)callback()
   assert.equal(fs.existsSync(root),unconfirmed);assert.equal(notes.length,unconfirmed?1:0)
  }finally{if(root)fs.rmSync(root,{recursive:true,force:true})}
 }
})

// Execute the actual derived command with simulated native interfaces. These
// exercise controller cleanup routing, not Windows ACL or Job enforcement.
function lifecycleFixture(t,scenario){
 const os=require('node:os'),vm=require('node:vm'),{createRequire}=require('node:module')
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-cleanup-')))
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const controlRoot=path.join(root,'controller'),scratch=path.join(root,'scratch'),node=path.join(root,'controller-node')
 fs.mkdirSync(controlRoot);fs.mkdirSync(scratch);fs.writeFileSync(node,'simulated-controller-image')
 const files=['bash.exe','msys-2.0.dll'].map(name=>{const bytes=Buffer.from(name);return{name,bytes,sha256:binding.hash(bytes),sharedId:'msys-2.0S5'}})
 const events=[],evidence={exitCode:0,stdout:Buffer.from('owned'),stderr:Buffer.alloc(0),launcherSessionId:19};let runtimeRoot
 const launcher={verifyDrainEvidence(){},proveNotStarted(){return evidence},async launch(){events.push('launch');if(scenario.launchError)throw scenario.launchError;return evidence}}
 const workflow='../../../agents/codex/workflow/'
 const replacements={
  './binding.cjs':{select(){return{bash:files[0],files}}},
  [workflow+'safe-run-root.js']:{ensureWindowsPrivateAcl(){}},
  [workflow+'windows-appcontainer.js']:{createWindowsAppContainerLauncher(){return launcher},WindowsAppContainerError:Error},
  [workflow+'windows-helper-deployment.js']:{stageWindowsHelperDeployment(){return{root:path.join(root,'helper'),cleanup(){events.push('helper-cleanup');if(scenario.cleanupError)throw scenario.cleanupError}}}},
  [workflow+'windows-appcontainer-resources.js']:{async prepareWindowsAppContainerResources(options){runtimeRoot=options.executableRoots[0].path;events.push('lease');if(scenario.prepareError)throw scenario.prepareError;return{profileName:'owned',profileSid:'owned',environment:{},recovery:{leaseId:'owned',journalPath:path.join(controlRoot,'journal')},async release(){events.push('release');if(scenario.releaseError)throw scenario.releaseError}}},async recoverWindowsAppContainerResources(){assert.fail('Unexpected recovery')}},
 }
 const filename=path.join(__dirname,'command.cjs'),localRequire=createRequire(filename),module={exports:{}}
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,__dirname,process:{platform:'win32',execPath:node,env:{SystemRoot:'C:\\Windows'}},require:name=>Object.hasOwn(replacements,name)?replacements[name]:localRequire(name)},{filename})
 return{events,controlRoot,get runtimeRoot(){return runtimeRoot},run:()=>module.exports.runWindowsAppContainerCommand({scratchPath:scratch,readableRoots:[scratch],writableRoots:[scratch]},{command:'printf owned',cwd:scratch},{controlRoot,diagnosticTuple:{node:{sha256:binding.hash(fs.readFileSync(node))}}})}
}
test('diagnostic command retains primary unknown cleanup when helper cleanup also fails',async t=>{
 const original=Object.assign(Error('unknown cleanup'),{cleanupConfirmed:false}),cleanup=Object.assign(Error('helper removal'),{code:'EACCES'}),x=lifecycleFixture(t,{prepareError:original,cleanupError:cleanup})
 await assert.rejects(x.run(),error=>error===original&&error.cleanupConfirmed===false&&error.cleanupCode==='EACCES'&&error.retainedControlRoot===x.controlRoot)
 assert.equal(fs.readFileSync(path.join(x.runtimeRoot,'usr/bin/bash.exe'),'utf8'),'bash.exe');assert.ok(!x.events.includes('launch'))
})
test('diagnostic command refuses success when cleanup fails after confirmed drain',async t=>{
 const cleanup=Object.assign(Error('helper removal'),{code:'EACCES'}),x=lifecycleFixture(t,{cleanupError:cleanup})
 await assert.rejects(x.run(),error=>error===cleanup&&error.cleanupConfirmed===false&&error.retainedControlRoot===x.controlRoot)
 assert.ok(x.events.indexOf('release')<x.events.indexOf('helper-cleanup'))
})
test('diagnostic command preserves the launch failure and journal when recovery also fails',async t=>{
 const original=Object.assign(Error('launch refused'),{code:'LAUNCH_REFUSED'}),recovery=Object.assign(Error('restore refused'),{code:'RESTORE_FAILED'}),x=lifecycleFixture(t,{launchError:original,releaseError:recovery})
 await assert.rejects(x.run(),error=>error===original&&error.cleanupConfirmed===false&&error.recoveryFailureCode==='RESTORE_FAILED'&&error.recovery.journalPath===path.join(x.controlRoot,'journal'))
 assert.ok(fs.existsSync(path.join(x.runtimeRoot,'usr/bin/bash.exe')));assert.ok(!x.events.includes('helper-cleanup'))
})
