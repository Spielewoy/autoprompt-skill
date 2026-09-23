'use strict'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const decoder=require('./windows-worker-decoder.js'),{captureWindowsFiles}=require('./windows-worker-capture.js')
const {ensureWindowsPrivateAcl}=require('./safe-run-root.js')
const {importedDlls}=require('./windows-worker-pe.js')
const rawPolicy=require('./windows-worker-policy.js')
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const need=(ok,code)=>{if(!ok){const e=Error(code);e.code='WINDOWS_WORKER_BUNDLE_INVALID';throw e}}
const keys=(object,names,code)=>need(object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).sort().join(',')===names.split(',').sort().join(','),code)
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const PIPELINE=Object.freeze(['windows-worker-capture.js','windows-worker-decoder.js','windows-worker-loader.js','windows-worker-pe.js','safe-run-root.js'])
const INPUTS=Object.freeze(['assets/bash.br','assets/msys.br','assets/node-arm64.br','assets/node-x64.br'])
const OUTPUTS=Object.freeze(['usr/bin/bash.exe','usr/bin/msys-2.0.dll','usr/bin/node-arm64.exe','usr/bin/node-x64.exe'])
const ROOT=path.join(__dirname,'windows-worker'),BUNDLE=path.join(ROOT,'bundle')
// Electron hosts its Node extension runtime in the signed Code.exe image. Keep
// that controller identity bounded separately from decoded worker payloads.
const CONTROLLER_HOST_MAX_BYTES=512*1024*1024
const tuples=new WeakMap()
let active=null,poison=null,poisonOrigin=null
function freezeDeep(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freezeDeep(item);Object.freeze(value)}return value}
function recordPoison(error){
  if(poison&&poisonOrigin!==error)return
  poisonOrigin=error
  poison=Object.freeze({code:error.code,message:error.message,cleanupConfirmed:error.cleanupConfirmed,
    retainedHelperRoot:error.retainedHelperRoot,retainedRuntimeRoot:error.retainedRuntimeRoot,
    recoveryRoot:error.recoveryRoot,...(error.recovery?{recovery:Object.freeze({...error.recovery})}:{})})
}
function poisonRefusal(){
  // Never share a mutable error across commands with independent recovery leases.
  const error=Error(poison.message);error.code=poison.code;error.workerFailure=poison
  if(typeof poison.cleanupConfirmed==='boolean')error.cleanupConfirmed=poison.cleanupConfirmed
  for(const key of ['retainedHelperRoot','retainedRuntimeRoot','recoveryRoot'])if(poison[key])error[key]=poison[key]
  return error
}
function validatePolicy(value){
  keys(value,'schema,state,manifest,files,bootstraps,pipeline,imports,sharedId,sourceIdentity','policy-shape')
  need(value.schema===1&&value.state==='candidate-unaccepted','policy-state')
  keys(value.manifest,'length,sha256','manifest-policy')
  need(Number.isSafeInteger(value.manifest.length)&&value.manifest.length>0&&value.manifest.length<=1048576&&isHash(value.manifest.sha256),'manifest-policy')
  need(Array.isArray(value.files)&&value.files.length===4,'fixed-worker-inventory')
  const manifestBytes=Buffer.from(decoder.canonical({schema:1,files:value.files})+'\n')
  need(manifestBytes.length===value.manifest.length&&sha(manifestBytes)===value.manifest.sha256,'policy-manifest-binding')
  decoder.parseManifest(manifestBytes,value.manifest.sha256)
  for(let i=0;i<4;i++)need(value.files[i].path===INPUTS[i]&&value.files[i].output===OUTPUTS[i]&&value.files[i].encoding==='br'&&value.files[i].rawLength>0,'fixed-worker-role')
  need(value.manifest.length+value.files.reduce((total,file)=>total+file.length,0)<=256*1024*1024,'physical-capture-total-bound')
  keys(value.bootstraps,'x64,arm64','bootstrap-architectures')
  for(const arch of ['x64','arm64']){
    const record=value.bootstraps[arch];keys(record,'length,sha256,configLength,configSha256','bootstrap-policy')
    need(Number.isSafeInteger(record.length)&&record.length>0&&record.length<=1048576&&isHash(record.sha256)&&Number.isSafeInteger(record.configLength)&&record.configLength>0&&record.configLength<=1024&&isHash(record.configSha256),'bootstrap-policy')
  }
  keys(value.pipeline,PIPELINE.join(','),'pipeline-closure')
  for(const name of PIPELINE)need(isHash(value.pipeline[name]),'pipeline-digest')
  keys(value.imports,INPUTS.join(','),'import-closure')
  for(const names of Object.values(value.imports))need(Array.isArray(names)&&names.length<=128&&names.every((name,index)=>typeof name==='string'&&/^[a-z0-9_+.-]+\.dll$/.test(name)&&!name.includes('..')&&(index===0||name>names[index-1])),'import-policy')
  need(/^msys-2\.0S[1-9][0-9]{0,8}$/.test(value.sharedId)&&isHash(value.sourceIdentity),'source-policy')
  return freezeDeep(JSON.parse(JSON.stringify(value)))
}
let policy=null,configurationError=null
try{if(rawPolicy?.state==='not-configured'){keys(rawPolicy,'schema,state','disabled-policy');need(rawPolicy.schema===1,'policy-schema')}else policy=validatePolicy(rawPolicy)}catch(error){configurationError=error}
function sameStat(a,b){return ['dev','ino','nlink','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key])}
function physical(file,directory=false){
  need(typeof file==='string'&&path.isAbsolute(file)&&!file.includes('\0'),'absolute-path-required')
  const canonical=fs.realpathSync.native(file)
  need((process.platform==='win32'?canonical.toLowerCase()===path.resolve(file).toLowerCase():canonical===path.resolve(file)),'canonical-path-required')
  for(let cursor=file;;cursor=path.dirname(cursor)){
    const st=fs.lstatSync(cursor)
    need(!st.isSymbolicLink()&&(cursor===file?(directory?st.isDirectory():st.isFile()):st.isDirectory()),'physical-path-required')
    if(path.dirname(cursor)===cursor)break
  }
  return canonical
}
function boundedFileLabel(file){return path.basename(file).replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,96)||'unnamed'}
function boundedStatValue(value){
  const type=typeof value
  if(type==='bigint'||type==='number'||type==='string')return `${type}:${String(value).slice(0,32)}`
  return type
}
function fileByteBoundFailure(reason,file,before,max,expectedLength){
  const expected=expectedLength===undefined?'none':String(expectedLength)
  const error=Error(`file-byte-bound:${reason}:path=${boundedFileLabel(file)}:nlink=${boundedStatValue(before.nlink)}:size=${boundedStatValue(before.size)}:max=${max}:expected=${expected}`)
  error.code='WINDOWS_WORKER_BUNDLE_INVALID'
  throw error
}
function boundedFile(file,max,expectedLength){
  physical(file);const before=fs.lstatSync(file,{bigint:true})
  // Do not coerce stat values: numeric values from a patched runtime are refused.
  if(before.nlink!==1n)fileByteBoundFailure('link-count',file,before,max,expectedLength)
  if(typeof before.size!=='bigint'||before.size<0n||before.size>BigInt(max))fileByteBoundFailure('max-size',file,before,max,expectedLength)
  if(expectedLength!==undefined&&before.size!==BigInt(expectedLength))fileByteBoundFailure('expected-length',file,before,max,expectedLength)
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0))
  try{
    need(sameStat(before,fs.fstatSync(fd,{bigint:true})),'file-open-changed')
    const bytes=Buffer.alloc(Number(before.size));let at=0
    while(at<bytes.length){const count=fs.readSync(fd,bytes,at,bytes.length-at,at);need(count>0,'file-truncated');at+=count}
    need(fs.readSync(fd,Buffer.alloc(1),0,1,bytes.length)===0&&sameStat(before,fs.fstatSync(fd,{bigint:true}))&&sameStat(before,fs.lstatSync(file,{bigint:true})),'file-read-changed')
    return bytes
  }finally{fs.closeSync(fd)}
}
function helperPaths(arch){const exe=path.join(ROOT,'bootstrap','capture-'+arch+'.exe');return{exe,config:exe+'.config'}}
function verifyPipeline(){for(const name of PIPELINE)need(sha(boundedFile(path.join(__dirname,name),4*1024*1024))===policy.pipeline[name],'pipeline-changed:'+name)}
function staticAvailability(){
  need(arguments.length===0,'availability-arguments-refused')
  if(configurationError)return Object.freeze({available:false,accepted:false,code:configurationError.message})
  if(!policy)return Object.freeze({available:false,accepted:false,code:'bundle-not-configured'})
  try{
    verifyPipeline()
    need(sha(boundedFile(path.join(BUNDLE,'manifest.json'),1048576,policy.manifest.length))===policy.manifest.sha256,'manifest-static-mismatch')
    for(const file of policy.files){physical(path.join(BUNDLE,file.path));const st=fs.lstatSync(path.join(BUNDLE,file.path));need(st.nlink===1&&st.size===file.length,'asset-presence-mismatch')}
    for(const arch of ['x64','arm64']){const file=helperPaths(arch),pin=policy.bootstraps[arch];need(sha(boundedFile(file.exe,1048576,pin.length))===pin.sha256&&sha(boundedFile(file.config,1024,pin.configLength))===pin.configSha256,'bootstrap-static-mismatch')}
    return Object.freeze({available:true,accepted:false,state:policy.state,manifestSha256:policy.manifest.sha256,scope:'bounded-declared-presence-only'})
  }catch(error){return Object.freeze({available:false,accepted:false,code:error.message})}
}
function parseSharedId(bytes){
  const invalid=()=>need(false,'msys-version-block')
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>32*1024*1024)invalid()
  const begin=Buffer.from('BEGIN_CYGWIN_VERSION_INFO\n'),end=Buffer.from('END_CYGWIN_VERSION_INFO'),first=bytes.indexOf(begin),last=bytes.indexOf(end)
  if(first<0||last<first+begin.length||last-first>8192||bytes.indexOf(begin,first+1)!==-1||bytes.indexOf(end,last+1)!==-1)invalid()
  const block=bytes.subarray(first+begin.length,last)
  if(block.some(byte=>byte!==10&&(byte<32||byte>126)))invalid()
  const lines=block.toString('ascii').split('\n')
  if(lines.pop()!==''||lines.some(line=>!line.startsWith('%%% MSYS ')))invalid()
  const shared=lines.filter(line=>line.startsWith('%%% MSYS shared id: ')),data=lines.filter(line=>line.startsWith('%%% MSYS shared data: '))
  if(shared.length!==1||data.length!==1)invalid()
  const match=/^%%% MSYS shared id: (msys-2\.0S([1-9][0-9]{0,8}))$/.exec(shared[0])
  if(!match||data[0]!==`%%% MSYS shared data: ${match[2]}`)invalid()
  return match[1]
}
function verifyPe(bytes,architecture,dll,imports){
  need(bytes.length>=64&&bytes.readUInt16LE(0)===0x5a4d,'pe-header')
  const pe=bytes.readUInt32LE(60)
  need(pe>=64&&pe+24<=bytes.length&&bytes.readUInt32LE(pe)===0x4550,'pe-header')
  need(bytes.readUInt16LE(pe+4)===(architecture==='x64'?0x8664:0xaa64),'pe-machine')
  need(pe+26<=bytes.length&&bytes.readUInt16LE(pe+24)===0x20b,'pe64-required')
  const characteristics=bytes.readUInt16LE(pe+22)
  need((characteristics&2)!==0&&Boolean(characteristics&0x2000)===dll,'pe-executable-role')
  need(JSON.stringify(importedDlls(bytes))===JSON.stringify(imports),'pe-import-closure')
}
async function captureUncached(){
  need(process.platform==='win32'&&['x64','arm64'].includes(process.arch)&&/^(?:0|[1-9][0-9]*)\./.test(process.versions.node)&&Number.isSafeInteger(Number(process.versions.node.split('.')[0]))&&Number(process.versions.node.split('.')[0])>=20,'untested-controller-platform')
  need(policy&&!configurationError,'bundle-not-configured')
  const available=staticAvailability();need(available.available,'bundle-static-unavailable:'+available.code)
  const arch=process.arch,pin=policy.bootstraps[arch],helper=helperPaths(arch),systemRoot=process.env.SystemRoot
  need(typeof systemRoot==='string'&&/^[a-z]:\\windows$/i.test(systemRoot),'system-root-required')
  const controllerHash=sha(boundedFile(process.execPath,CONTROLLER_HOST_MAX_BYTES))
  const inventory=[{path:'manifest.json',length:policy.manifest.length,sha256:policy.manifest.sha256},...policy.files.map(file=>({path:file.path,length:file.length,sha256:file.sha256}))]
  const captured=await captureWindowsFiles(BUNDLE,inventory,{executable:helper.exe,executableSha256:pin.sha256,configSha256:pin.configSha256,systemRoot})
  need(captured.architecture===arch,'native-controller-architecture-mismatch')
  need(Array.isArray(captured.records)&&captured.records.length===5&&captured.records[0].path==='manifest.json','native-capture-inventory')
  keys(captured.bootstrap,'executableBytes,configBytes','captured-bootstrap-shape')
  const bootstrap=[['usr/bin/acl-probe.exe',captured.bootstrap.executableBytes,pin.length,pin.sha256],['usr/bin/acl-probe.exe.config',captured.bootstrap.configBytes,pin.configLength,pin.configSha256]]
  for(const item of bootstrap){const [,bytes,length,digest]=item;need(Buffer.isBuffer(bytes)&&bytes.length===length&&sha(bytes)===digest,'captured-bootstrap-identity');item[1]=Buffer.from(bytes)}
  const capability=decoder.captureBytes(captured.records[0].bytes,captured.records.slice(1),policy.manifest.sha256)
  const selected=policy.files.filter(file=>!file.path.includes('node-')||file.path===`assets/node-${arch}.br`),files=[]
  for(const item of selected){
    // Node expands to roughly 100 MiB. Concurrent isolated commands can contend
    // for CPU without weakening the smaller worker assets' 15 second bound.
    const bytes=await decoder.decode(capability,item.path,item.path===`assets/node-${arch}.br`?{deadlineMs:60000}:undefined)
    verifyPe(bytes,item.path.includes('node-')?arch:'x64',item.path==='assets/msys.br',policy.imports[item.path])
    if(item.path==='assets/msys.br')need(parseSharedId(bytes)===policy.sharedId,'msys-shared-id-mismatch')
    files.push({path:item.path.includes('node-')?'usr/bin/node.exe':item.output,sha256:item.rawSha256,bytes})
  }
  for(const [path,bytes,,sha256] of bootstrap)files.push({path,sha256,bytes:Buffer.from(bytes)})
  verifyPipeline()
  need(sha(boundedFile(process.execPath,CONTROLLER_HOST_MAX_BYTES))===controllerHash,'controller-node-changed')
  const identity=sha(Buffer.from(decoder.canonical({schema:1,policy,architecture:arch,controller:{architecture:process.arch,node:process.versions.node,sha256:controllerHash},files:files.map(({path,sha256})=>({path,sha256}))})))
  const tuple=Object.freeze({});tuples.set(tuple,{files,identity,architecture:arch,sharedId:policy.sharedId,controllerHash,controllerVersion:process.versions.node});return tuple
}
function captureWorkerTuple(){
  need(arguments.length===0,'capture-arguments-refused')
  if(poison)return Promise.reject(poisonRefusal())
  if(!active){active=captureUncached().catch(error=>{if(error.cleanupConfirmed===false)recordPoison(error);active=null;throw error})}
  return active.then(tuple=>{revalidateTuple(tuple);return tuple})
}
function describeTuple(tuple){
  const value=tuples.get(tuple);need(value,'tuple-capability-required')
  return freezeDeep({identity:value.identity,architecture:value.architecture,sharedId:value.sharedId,controllerSha256:value.controllerHash,
    accepted:false,state:'candidate-unaccepted',manifestSha256:policy.manifest.sha256,files:value.files.map(file=>({path:file.path,length:file.bytes.length,sha256:file.sha256}))})
}
function revalidateTuple(tuple){
  const value=tuples.get(tuple);need(value,'tuple-capability-required')
  if(poison)throw poisonRefusal()
  try{
    verifyPipeline()
    need(process.platform==='win32'&&process.arch===value.architecture&&process.versions.node===value.controllerVersion,'controller-identity-changed')
    need(sha(boundedFile(process.execPath,CONTROLLER_HOST_MAX_BYTES))===value.controllerHash,'controller-node-changed')
    return describeTuple(tuple)
  }catch(error){recordPoison(error);throw error}
}
function materializeTuple(tuple,root){
  const value=tuples.get(tuple);need(value,'tuple-capability-required')
  revalidateTuple(tuple)
  need(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root&&!root.includes('\0'),'materialization-root-required')
  physical(path.dirname(root),true)
  fs.mkdirSync(root,{mode:0o700});let privacyEstablished=false
  try{
    ensureWindowsPrivateAcl(root);privacyEstablished=true;physical(root,true)
    fs.mkdirSync(path.join(root,'usr'),{mode:0o700});fs.mkdirSync(path.join(root,'usr','bin'),{mode:0o700});fs.mkdirSync(path.join(root,'etc'),{mode:0o700})
    fs.writeFileSync(path.join(root,'etc','fstab'),'none /tmp usertemp binary,posix=0,noacl 0 0\n',{flag:'wx',mode:0o400})
    for(const file of value.files){const destination=path.join(root,file.path);fs.writeFileSync(destination,file.bytes,{flag:'wx',mode:0o500});need(sha(boundedFile(destination,128*1024*1024,file.bytes.length))===file.sha256,'materialized-worker-mismatch')}
    revalidateTuple(tuple)
    return freezeDeep({identity:value.identity,root,node:path.join(root,'usr','bin','node.exe'),bash:path.join(root,'usr','bin','bash.exe'),
      bashSha256:value.files.find(file=>file.path==='usr/bin/bash.exe').sha256,
      msysRuntime:{dllPath:path.join(root,'usr','bin','msys-2.0.dll'),dllSha256:value.files.find(file=>file.path==='usr/bin/msys-2.0.dll').sha256,sharedId:value.sharedId}})
  }catch(error){
    if(!privacyEstablished||error.cleanupConfirmed===false){error.cleanupConfirmed=false;error.retainedRuntimeRoot=root}
    else{try{fs.rmSync(root,{recursive:true,force:true});error.cleanupConfirmed=true}catch(cleanup){error.cleanupConfirmed=false;error.retainedRuntimeRoot=root;error.cleanupCode=String(cleanup.code||'cleanup-failed').slice(0,64)}}
    if(error.cleanupConfirmed===false||poisonOrigin===error)recordPoison(error)
    throw error
  }
}
module.exports=Object.freeze({staticAvailability,captureWorkerTuple,describeTuple,revalidateTuple,materializeTuple})
