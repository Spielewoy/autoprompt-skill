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
 // Correct the original assumption that usertemp equals controller scratch.
 body=body.replace('  const source = `', "  // usertemp maps /tmp to this worker's package TEMP, independently of controller scratch.\n  const source = `")
 body=body.replace("path=require('node:path');assert.equal(fs.readFileSync(path.join(${JSON.stringify(scratchPath)},'shell-witness-tmp')", "path=require('node:path'),os=require('node:os');const privateTemp=os.tmpdir();assert.ok(path.isAbsolute(privateTemp));assert.equal(fs.readFileSync(path.join(privateTemp,'shell-witness-tmp')")
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
test('ACL observation distinguishes successful mutation from an unconfirmed denial',()=>{
 const text=fs.readFileSync(path.join(__dirname,'probe.cjs'),'utf8'),start=text.indexOf('const aclText='),end=text.indexOf("phase='descendant'",start),body=text.slice(start,end)
 const run=new Function('aclExit','fs','path','f','process',body)
 for(const [exit,output,code]of [[5,'Access is denied.',null],[1,'Access is denied.',null],[0,'Successfully processed 1 files','ACL_WRITE_SUCCEEDED'],[0,'Access is denied.','ACL_WRITE_SUCCEEDED'],[1,'Invalid parameter','ACL_DENIAL_NOT_CONFIRMED'],[null,'Access is denied.','ACL_DENIAL_NOT_CONFIRMED'],[-1,'Access is denied.','ACL_DENIAL_NOT_CONFIRMED'],[5,'x'.repeat(2048),'ACL_DENIAL_NOT_CONFIRMED']]){
  let stderr='';const invoke=()=>run(exit,{readFileSync(){return output}},path,{scratch:'/fixture'},{stderr:{write(value){stderr+=value}}})
  if(code){assert.throws(invoke,{code});assert.ok(stderr.startsWith('APPCONTAINER_ACL_OBSERVATION:'));const observation=JSON.parse(stderr.slice('APPCONTAINER_ACL_OBSERVATION:'.length,-1));assert.deepEqual(observation,{exit,text:output.slice(0,1024)})}
  else{assert.doesNotThrow(invoke);assert.equal(stderr,'')}
 }
})
test('actual ACL worker uses the absolute system executable and closes its output handle',async()=>{
 const vm=require('node:vm'),{EventEmitter}=require('node:events'),win=path.win32
 const fixture={target:'C:\\private\\target',scratch:'C:\\private\\scratch',sentinel:'C:\\private\\controller\\secret',endpoints:[]}
 const text=fs.readFileSync(path.join(__dirname,'probe.cjs'),'utf8'),sourceStart=text.indexOf('    const source = '),sourceEnd=text.indexOf('\n    const encoded',sourceStart)
 const source=vm.runInNewContext(text.slice(sourceStart,sourceEnd).replace('    const source = ',''),{fixture})
 new vm.Script(source)
 const start=source.indexOf("phase='acl-write';"),end=source.indexOf('const aclText=',start)
 const run=new (Object.getPrototypeOf(async function(){}).constructor)('cp','fs','path','f','process','let phase;'+source.slice(start,end)+'return aclExit')
 for(const scenario of ['exit','spawn-error','spawn-throw','open-error']){
  const events=[],error=Object.assign(Error('controlled failure'),{code:'EACCES'})
  const environment={SystemRoot:'C:\\Windows folder',AUTOPROMPT_APP_CONTAINER_SID:'S-1-15-2-123',PATH:'C:\\private\\runtime'}
  const filesystem={openSync(file,flags){assert.equal(file,win.join(fixture.scratch,'acl-result.txt'));assert.equal(flags,'wx');events.push('open');if(scenario==='open-error')throw error;return 47},closeSync(fd){assert.equal(fd,47);events.push('close')}}
  const child={spawn(file,args,options){
   assert.equal(file,'C:\\Windows folder\\System32\\icacls.exe');assert.deepEqual(args,[fixture.target,'/grant','*S-1-15-2-123:F','/q'])
   assert.deepEqual(options,{cwd:fixture.scratch,stdio:[0,47,47]});events.push('spawn')
   if(scenario==='spawn-throw')throw error
   const emitter=new EventEmitter();queueMicrotask(()=>{events.push(scenario==='spawn-error'?'error':'exit');emitter.emit(scenario==='spawn-error'?'error':'exit',scenario==='spawn-error'?error:5)});return emitter
  }}
  const result=run(child,filesystem,win,fixture,{env:environment})
  if(scenario==='exit'){assert.equal(await result,5);assert.deepEqual(events,['open','spawn','exit','close'])}
  else{await assert.rejects(result,e=>e===error);assert.equal(events.at(-1),scenario==='open-error'?'open':'close')}
  assert.equal(environment.PATH,'C:\\private\\runtime')
 }
})
test('diagnostic closes its real IPv4 listener when the IPv6 listener cannot start',async t=>{
 const vm=require('node:vm'),net=require('node:net'),{createRequire}=require('node:module'),servers=[],closed=[]
 t.after(()=>{for(const server of servers)server.close()})
 const network={...net,createServer(...args){
  const server=net.createServer(...args);servers.push(server)
  closed.push(new Promise(resolve=>server.once('close',resolve)))
  if(servers.length===2)server.listen=function(){setImmediate(()=>this.emit('error',Object.assign(Error('IPv6 unavailable'),{code:'EAFNOSUPPORT'})));return this}
  return server
 }}
 const filename=path.join(__dirname,'probe.cjs'),localRequire=createRequire(filename),module={exports:{}}
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,__dirname,__filename:filename,setImmediate,
  process:{platform:'win32',execPath:process.execPath,pid:process.pid,env:process.env},
  require:name=>name==='node:net'?network:name.endsWith('/safe-run-root.js')?{ensureWindowsPrivateAcl(){}}:localRequire(name)},{filename})
 const result=await module.exports.probeWindowsAppContainer(async()=>assert.fail('No sandbox command before both listener controls'),'a'.repeat(64))
 assert.equal(result.supported,false);assert.equal(result.code,'EAFNOSUPPORT');assert.equal(servers.length,2)
 assert.equal(servers[0].listening,false)
 await closed[0]
})
test('diagnostic root cleanup failure preserves the original error and retained root',async t=>{
 const vm=require('node:vm'),{createRequire}=require('node:module')
 const original=Object.assign(Error('private fixture failed'),{code:'PRIVACY_VIOLATION'}),cleanup=Object.assign(Error('root removal failed'),{code:'EACCES'})
 let retained
 t.after(()=>{if(retained)fs.rmSync(retained,{recursive:true,force:true})})
 const filesystem={...fs,mkdtempSync(...args){retained=fs.mkdtempSync(...args);return retained},rmSync(file,...args){if(file===retained)throw cleanup;return fs.rmSync(file,...args)}}
 const filename=path.join(__dirname,'probe.cjs'),localRequire=createRequire(filename),module={exports:{}}
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,__dirname,__filename:filename,setImmediate,
  process:{platform:'win32',execPath:process.execPath,pid:process.pid,env:process.env},
  require:name=>name==='node:fs'?filesystem:name.endsWith('/safe-run-root.js')?{ensureWindowsPrivateAcl(){throw original}}:localRequire(name)},{filename})
 await assert.rejects(module.exports.probeWindowsAppContainer(async()=>assert.fail('No command before fixture setup'),'a'.repeat(64)),error=>error===original&&error.cleanupConfirmed===false&&error.cleanupCode==='EACCES'&&error.recoveryRoot===retained)
 assert.equal(fs.existsSync(retained),true)
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

// Generated worker assertions exercised with explicit synthetic filesystem seams.
{
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path').posix
const vm = require('node:vm')
const realPath = path
const helperPath = require('node:path').join(ROOT, 'tests/helpers/windows-bash-native-smoke.cjs')

function generatedSource(values) {
  const helper = fs.readFileSync(helperPath, 'utf8')
  const start = helper.indexOf('const source = `') + 'const source = `'.length
  const end = helper.indexOf('`\n  const shellQuote', start)
  assert.ok(start > 15 && end > start, 'generated source template must remain discoverable')
  let source = helper.slice(start, end)
  const replacements = {
    '${JSON.stringify(shellWitness)}': JSON.stringify(values.shellWitness),
    "${JSON.stringify(path.join(scratchPath, 'witness'))}": JSON.stringify(values.scratchWitness),
    '${JSON.stringify(candidate)}': JSON.stringify(values.candidate),
    '${JSON.stringify(secret)}': JSON.stringify(values.secret),
  }
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to)
  source = source.replaceAll('\\\\n', '\\n')
  assert.ok(!source.includes('${JSON.stringify('), 'all generated path seams must be resolved')
  return source
}

function executeGenerated({ tempPath, shellWitness = '/scratch/shell-witness', fstab = 'none /tmp usertemp binary,posix=0,noacl 0 0\n', appendDenied = true, tempWitness = true, wrongTemp = false }) {
  const fstabPath = path.resolve(path.dirname('/runtime/usr/bin/node.exe'), '../../etc/fstab')
  const scratchWitness = '/scratch/witness'
  const calls = []
  const fakeFs = {
    realpathSync: { native() { throw Object.assign(new Error('realpath must not be used for AppContainer TEMP'), { code: 'EPERM' }) } },
    readFileSync(file) {
      calls.push(['read', file])
      if (file === path.join(tempPath, 'shell-witness-tmp')) {
        if (!tempWitness || wrongTemp) throw Object.assign(new Error('missing witness'), { code: 'ENOENT' })
        return 'private-temp\n'
      }
      if (file === fstabPath) return fstab
      if (file === shellWitness) return 'shell-write\n'
      if (file === '/controller/secret') throw Object.assign(new Error('denied'), { code: 'EACCES' })
      throw new Error(`unexpected read ${file}`)
    },
    appendFileSync(file) {
      calls.push(['append', file])
      if (appendDenied) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    },
    writeFileSync(file, value) {
      calls.push(['write', file, value])
      if (file === '/target/candidate') throw Object.assign(new Error('denied'), { code: 'EPERM' })
      assert.equal(file, scratchWitness)
      assert.equal(value, 'native-node')
    },
  }
  const fakeRequire = name => ({
    'node:fs': fakeFs,
    'node:assert/strict': assert,
    'node:path': realPath,
    'node:os': { tmpdir: () => tempPath },
  }[name] || (() => { throw new Error(`unexpected require ${name}`) })())
  const output = []
  vm.runInNewContext(generatedSource({ shellWitness, scratchWitness, candidate: '/target/candidate', secret: '/controller/secret' }), {
    require: fakeRequire,
    process: { execPath: '/runtime/usr/bin/node.exe', stdout: { write(value) { output.push(value) } } },
  }, { filename: 'generated-native-smoke.cjs' })
  return { calls, output: output.join('') }
}

test('generated Node body uses private TEMP while retaining scratch and denial assertions', () => {
  const result = executeGenerated({ tempPath: '/private/package-temp' })
  assert.equal(result.output, 'node-ok')
  assert.deepEqual(result.calls.filter(([kind]) => kind === 'write'), [['write', '/scratch/witness', 'native-node'], ['write', '/target/candidate', 'forbidden']])
  assert.ok(result.calls.some(([kind, file]) => kind === 'read' && file === '/private/package-temp/shell-witness-tmp'))
  assert.ok(!result.calls.some(([kind, file]) => kind === 'read' && file === '/scratch/shell-witness-tmp'))
})

test('generated Node body rejects missing or wrong private TEMP witness', () => {
  assert.throws(() => executeGenerated({ tempPath: '/private/missing', tempWitness: false }), /missing witness/)
  assert.throws(() => executeGenerated({ tempPath: '/private/wrong', wrongTemp: true }), /missing witness/)
})

test('generated Node body uses TEMP directly and rejects a relative TEMP', () => {
  assert.doesNotThrow(() => executeGenerated({ tempPath: '/private/package-temp' }))
  assert.throws(() => executeGenerated({ tempPath: 'relative-temp' }), error => error?.name === 'AssertionError')
})

test('generated Node body rejects mutable or malformed fstab', () => {
  assert.throws(() => executeGenerated({ tempPath: '/private/package-temp', appendDenied: false }), /Missing expected exception/)
  assert.throws(() => executeGenerated({ tempPath: '/private/package-temp', fstab: 'none /tmp scratch 0 0\n' }), /Expected values to be strictly equal/)
})

}
