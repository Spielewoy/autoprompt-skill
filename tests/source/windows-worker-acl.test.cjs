'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events')
// These execute the actual generated worker protocol. Kernel/token behavior is
// exercised separately by the native fixed-helper tests on Windows.
function worker(){
 const fixture={target:'C:\\private\\target',scratch:'C:\\private\\scratch',sentinel:'C:\\private\\controller\\secret',targetIdentity:'01234567:fedcba9876543210',architecture:'arm64',endpoints:[]}
 const file=path.resolve(__dirname,'../../agents/codex/workflow/windows-appcontainer-probe.js'),text=fs.readFileSync(file,'utf8'),start=text.indexOf('    const source = '),end=text.indexOf('\n    const encoded',start)
 const source=vm.runInNewContext(text.slice(start,end).replace('    const source = ',''),{fixture});new vm.Script(source)
 const first=source.indexOf("phase='acl-write';"),last=source.indexOf("phase='descendant';",first)
 const run=new (Object.getPrototypeOf(async function(){}).constructor)('cp','fs','path','f','process','Buffer','let phase;const need=x=>{if(!x)throw Error("PROBE")};'+source.slice(first,last))
 return{fixture,run}
}
async function exercise({output,status=0,scenario='exit',size}={}){
 const {fixture,run}=worker(),expected='bundle-acl-denied-v1:arm64:'+fixture.targetIdentity+':5',bytes=output??Buffer.from(expected+'\r\n'),events=[]
 const processFixture={execPath:'C:\\private runtime\\usr\\bin\\node.exe',env:{AUTOPROMPT_APP_CONTAINER_SID:'S-1-15-2-1-2-3-4-5-6-7',PATH:'C:\\private runtime\\usr\\bin'}}
 const failure=Object.assign(Error('controlled native helper failure'),{code:'EACCES'})
 const filesystem={
  openSync(file,flags){assert.equal(file,path.win32.join(fixture.scratch,'acl-result.txt'));assert.equal(flags,'wx');events.push('open');if(scenario==='open-error')throw failure;return 47},
  closeSync(fd){assert.equal(fd,47);events.push('close')},
  statSync(){return{size:size??bytes.length}},
  readFileSync(){events.push('read');return bytes},
 }
 const child={spawn(file,args,options){
  assert.equal(file,'C:\\private runtime\\usr\\bin\\acl-probe.exe');assert.deepEqual(args,['--acl-probe',processFixture.env.AUTOPROMPT_APP_CONTAINER_SID,fixture.target,fixture.targetIdentity])
  assert.deepEqual(options,{cwd:fixture.scratch,stdio:[0,47,47]});events.push('spawn');if(scenario==='spawn-throw')throw failure
  const emitter=new EventEmitter();queueMicrotask(()=>{events.push(scenario==='spawn-error'?'error':'exit');emitter.emit(scenario==='spawn-error'?'error':'exit',scenario==='spawn-error'?failure:status)});return emitter
 }}
 let error;try{await run(child,filesystem,path.win32,fixture,processFixture,Buffer)}catch(caught){error=caught}
 assert.equal(events.filter(e=>e==='close').length,scenario==='open-error'?0:1)
 assert.equal(processFixture.env.PATH,'C:\\private runtime\\usr\\bin')
 return{error,events,failure}
}
for(const ending of ['\n','\r\n'])test('fixed ACL worker accepts only the bound native denial record '+JSON.stringify(ending),async()=>{
 const result=await exercise({output:Buffer.from('bundle-acl-denied-v1:arm64:01234567:fedcba9876543210:5'+ending)});assert.ifError(result.error)
 assert.deepEqual(result.events,['open','spawn','exit','close','read'])
})
for(const [name,options] of [
 ['empty output',{output:Buffer.alloc(0)}],['localized text',{output:Buffer.from('Access is denied.\r\n')}],
 ['wrong architecture',{output:Buffer.from('bundle-acl-denied-v1:x64:01234567:fedcba9876543210:5\n')}],
 ['wrong target',{output:Buffer.from('bundle-acl-denied-v1:arm64:01234567:fedcba9876543211:5\n')}],
 ['wrong native result',{output:Buffer.from('bundle-acl-denied-v1:arm64:01234567:fedcba9876543210:2\n')}],
 ['trailing output',{output:Buffer.from('bundle-acl-denied-v1:arm64:01234567:fedcba9876543210:5\nextra')}],
 ['non-ASCII byte',{output:Buffer.concat([Buffer.from([0xe2]),Buffer.from('undle-acl-denied-v1:arm64:01234567:fedcba9876543210:5\n')])}],
 ['failed helper',{status:1}],['terminated helper',{status:null}],['oversized output',{size:257}],
 ])test('fixed ACL worker refuses '+name,async()=>{const result=await exercise(options);assert.ok(result.error);if(options.size)assert.equal(result.events.includes('read'),false)})
for(const scenario of ['spawn-error','spawn-throw','open-error'])test('fixed ACL worker preserves '+scenario+' and closes owned descriptors',async()=>{
 const result=await exercise({scenario});assert.equal(result.error,result.failure);assert.equal(result.events.includes('read'),false)
})
