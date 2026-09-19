'use strict'
// Explicit diagnostic authority only. Never loaded by an installed runtime.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
function canonical(value){const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;return Buffer.from(JSON.stringify(sort(value))+'\n')}
function exact(value,keys){assert.ok(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),keys.sort())}
function validate(context){
 exact(context,['schema','purpose','node','bash']);assert.equal(context.schema,1);assert.equal(context.purpose,'compiler-output-smoke-not-runtime-acceptance')
 exact(context.node,['architecture','sha256','kind']);assert.ok(['x64','arm64'].includes(context.node.architecture));assert.ok(['compiler-controller','adapted-worker'].includes(context.node.kind));assert.match(context.node.sha256,/^[a-f0-9]{64}$/)
 exact(context.bash,['path','files']);assert.ok(typeof context.bash.path==='string'&&path.isAbsolute(context.bash.path)&&!context.bash.path.includes('\0'));assert.ok(Array.isArray(context.bash.files)&&context.bash.files.length>=2&&context.bash.files.length<=96)
 const names=[];for(const file of context.bash.files){exact(file,['name','sha256','bytes']);assert.match(file.name,/^[a-z0-9_+.-]+\.(?:exe|dll)$/);assert.ok(!file.name.includes('..'));assert.match(file.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(file.bytes)&&file.bytes>0&&file.bytes<=32*1024*1024);names.push(file.name)}
 assert.deepEqual(names,[...new Set(names)].sort());assert.ok(names.includes('bash.exe')&&names.includes('msys-2.0.dll'))
 return JSON.parse(canonical(context))
}
function select(raw,helpers){
 const context=validate(raw);assert.equal(process.arch,context.node.architecture,'Diagnostic Node architecture differs')
 const node=helpers.bindRuntimeFile(process.execPath,128*1024*1024);assert.equal(node.sha256,context.node.sha256,'Diagnostic Node differs from caller pin')
 const bash=helpers.bindRuntimeFile(context.bash.path,16*1024*1024)
 const files=helpers.bindBashRuntime(path.dirname(bash.path),process.env.SystemRoot)
 const records=files.map(file=>({name:file.name,sha256:file.sha256,bytes:file.bytes.length})).sort((a,b)=>a.name.localeCompare(b.name))
 assert.deepEqual(records,context.bash.files,'Exact diagnostic Bash closure differs; fallback forbidden')
 assert.equal(path.resolve(bash.path).toLowerCase(),path.resolve(context.bash.path).toLowerCase())
 return Object.freeze({bash,files})
}
function createExecutor(raw){
 assert.equal(process.platform,'win32','Actual Windows diagnostic required')
 const context=validate(raw),identity=hash(canonical(context)),command=require('./command.cjs'),boundary=require('../../harness-v2-tool-boundary.cjs')
 const execute=async(policy,args,options={})=>{
  policy=boundary.validatePolicy(policy);assert.notEqual(policy.toolFree,true);boundary.validateArguments('bash',args)
  assert.ok(typeof args.command==='string'&&args.command.trim()&&Buffer.byteLength(args.command)<=65536)
  assert.ok(!options.signal?.aborted,'Diagnostic cancelled before launch')
  const cwd=boundary.authorize(policy,args.cwd||(policy.readOnly&&policy.scratchPath?policy.scratchPath:policy.targetPath));assert.ok(fs.statSync(cwd).isDirectory())
  return command.runWindowsAppContainerCommand(policy,{...args,cwd},{...options,diagnosticTuple:context})
 }
 return Object.freeze({identity,probe:()=>require('./probe.cjs').probeWindowsAppContainer(execute,identity),executeTool:(policy,name,args,options)=>{assert.equal(name,'bash');return execute(policy,args,options)}})
}
module.exports={canonical,hash,validate,select,createExecutor}
