'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto')
const workflow=path.resolve(__dirname,'../../agents/codex/workflow'),fixture=path.resolve(__dirname,'../fixtures/windows-appcontainer/resource-scale-proof.cs')
const sources=[path.join(workflow,'windows-appcontainer-native.cs'),path.join(workflow,'windows-appcontainer-resources-native.cs'),fixture]
const shell=()=>process.platform==='win32'?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):(process.env.AUTOPROMPT_TEST_PWSH||'pwsh')
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const nativeName='native Windows resource scale restores large trees after AppContainer mutation and refuses admission overflow'

test('complete native resource scale fixture compiles against actual launcher and resource sources',{timeout:90000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'resource-scale-compile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const stub=path.join(root,'serializer.cs');fs.writeFileSync(stub,'namespace System.Web.Script.Serialization { public class JavaScriptSerializer { public int MaxJsonLength {get;set;} public object DeserializeObject(string x){throw new System.NotSupportedException();} public T Deserialize<T>(string x){throw new System.NotSupportedException();} public string Serialize(object x){throw new System.NotSupportedException();} } }')
 const command='$ErrorActionPreference="Stop";$files=[string[]]@($env:AP_SCALE_NATIVE,$env:AP_SCALE_RESOURCES,$env:AP_SCALE_FIXTURE);if($env:AP_SCALE_STUB){Add-Type -Path ($files+@($env:AP_SCALE_STUB))}else{Add-Type -Path $files -ReferencedAssemblies @("System.dll","System.Core.dll","System.Security.dll","System.Web.Extensions.dll")};if(-not [ResourceScaleProof]::LimitsMatch()){throw "actual resource limits mismatch"};[Console]::Write("compiled")'
 const result=cp.spawnSync(shell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:60000,windowsHide:true,env:{...process.env,AP_SCALE_NATIVE:sources[0],AP_SCALE_RESOURCES:sources[1],AP_SCALE_FIXTURE:sources[2],AP_SCALE_STUB:process.platform==='win32'?'':stub}})
 if(result.error?.code==='ENOENT'&&process.platform!=='win32'){t.skip('PowerShell compiler unavailable; actual Windows scale proof remains required');return}
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(result.stderr,'');assert.equal(result.stdout,'compiled')
})

test(nativeName,{skip:process.platform!=='win32',timeout:1800000},async t=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'resource-scale-native-')))
 let cleanupConfirmed=false
 t.after(()=>{if(cleanupConfirmed)fs.rmSync(base,{recursive:true,force:true});else t.diagnostic('Retained native resource scale evidence and plans: '+base)})
 const {ensureWindowsPrivateAcl}=require('../../agents/codex/workflow/safe-run-root.js');ensureWindowsPrivateAcl(base)
 const roots={};for(const name of ['control','runtime','trees']){const file=path.join(base,name);fs.mkdirSync(file);ensureWindowsPrivateAcl(file);roots[name]=file}
 const copied=sources.map((source,index)=>{const destination=path.join(roots.control,['native.cs','resources.cs','proof.cs'][index]);fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL);return destination})
 const sourceBindings=sources.map((source,index)=>{const bytes=fs.readFileSync(copied[index]);assert.equal(sha(bytes),sha(fs.readFileSync(source)));return {source:path.relative(path.resolve(__dirname,'../..'),source).split(path.sep).join('/'),bytes:bytes.length,sha256:sha(bytes)}})
 fs.writeFileSync(path.join(roots.control,'source-bindings.json'),JSON.stringify(sourceBindings,null,2)+'\n')
 const controller=path.join(roots.control,'controller.exe'),worker=path.join(roots.runtime,'worker.exe'),system=process.env.SystemRoot
 const env={SystemRoot:system,WINDIR:system,SystemDrive:system.slice(0,2),PATH:path.join(system,'System32'),TEMP:roots.control,TMP:roots.control}
 const build='$ErrorActionPreference="Stop";$p=New-Object System.CodeDom.Compiler.CompilerParameters;$p.GenerateExecutable=$true;$p.GenerateInMemory=$false;$p.OutputAssembly=$env:AP_SCALE_OUTPUT;$p.CompilerOptions="/platform:anycpu";$p.MainClass="ResourceScaleProof";$p.TreatWarningsAsErrors=$true;foreach($a in @("System.dll","System.Core.dll","System.Security.dll","System.Web.Extensions.dll")){[void]$p.ReferencedAssemblies.Add($a)};$options=[Collections.Generic.Dictionary[string,string]]::new();$options.Add("CompilerVersion","v4.0");$provider=[Microsoft.CSharp.CSharpCodeProvider]::new($options);try{$r=$provider.CompileAssemblyFromFile($p,[string[]]@($env:AP_SCALE_NATIVE,$env:AP_SCALE_RESOURCES,$env:AP_SCALE_FIXTURE));if($r.NativeCompilerReturnValue -ne 0 -or $r.Errors.HasErrors -or $r.Errors.HasWarnings){foreach($e in @($r.Errors|Select-Object -First 12)){[Console]::Error.WriteLine($e.ToString())};exit 1};if(![IO.File]::Exists($p.OutputAssembly)){throw "compiler output missing"}}finally{$provider.Dispose()}'
 const compiled=cp.spawnSync(shell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',build],{encoding:'utf8',timeout:120000,windowsHide:true,env:{...env,AP_SCALE_NATIVE:copied[0],AP_SCALE_RESOURCES:copied[1],AP_SCALE_FIXTURE:copied[2],AP_SCALE_OUTPUT:controller}})
 assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr||compiled.stdout);assert.equal(compiled.stderr,'')
 fs.copyFileSync(controller,worker,fs.constants.COPYFILE_EXCL)
 t.diagnostic('WINDOWS_RESOURCE_SCALE_INPUTS:'+JSON.stringify({sources:sourceBindings,worker:{bytes:fs.statSync(worker).size,sha256:sha(fs.readFileSync(worker))}}))
 const result=cp.spawnSync(controller,[roots.trees,worker,roots.control],{encoding:'utf8',timeout:1050000,maxBuffer:256*1024,windowsHide:true,cwd:roots.control,env,stdio:['ignore','pipe','pipe']})
 for(const stream of ['stdout','stderr']){const value=String(result[stream]||'');fs.writeFileSync(path.join(roots.control,stream+'.txt'),value);for(const line of value.slice(0,32768).split(/\r?\n/))for(let at=0;at<line.length;at+=480)t.diagnostic(stream+': '+line.slice(at,at+480))}
 assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(result.stderr,'')
 const proof=JSON.parse(result.stdout);assert.equal(proof.schema,1);assert.equal(proof.nativeWindows,true);assert.equal(proof.architecture,process.arch);assert.equal(proof.cleanupConfirmed,true);assert.equal(proof.accepted,false)
 assert.deepEqual(proof.cases.map(x=>x.scenario),['flat5000','nested8192'])
 for(const item of proof.cases){
  assert.ok(item.targetObjects>5000&&item.planEntries>4096&&item.planEntries<=16384);assert.ok(item.planBytes>0&&item.planBytes<=8*1024*1024-4096)
  assert.equal(item.architecture,process.arch);assert.deepEqual(item.denials,['git-overwrite:5','git-create:5'])
  for(const key of ['drained','appContainer','exactRestoration','repeatedRecovery','profileRemoved'])assert.equal(item[key],true)
  assert.equal(item.accepted,false);assert.equal(item.restore.deletedEntries,1);assert.equal(item.restore.restored,item.planEntries-1);assert.equal(item.restore.newEntries,item.createdFiles+2)
  assert.equal(item.handleSamplingScope,'apply-launch-restore');assert.ok(item.sampledPeakHandles>0&&item.sampledPeakWorkingSet>0);assert.equal(Object.keys(item.phaseMilliseconds).length,4);for(const value of Object.values(item.phaseMilliseconds))assert.ok(Number.isSafeInteger(value)&&value>=0&&value<=120000)
  const plan=path.join(roots.control,item.scenario+'-plan.json');assert.equal(fs.statSync(plan).size,item.planBytes)
 }
 assert.equal(proof.cases[1].targetObjects,8192);assert.equal(proof.cases[1].createdFiles,9000);assert.ok(proof.cases[1].liveRecoveryObjects>16384&&proof.cases[1].liveRecoveryObjects<=32768)
 const boundary=proof.boundary;assert.equal(boundary.objects,16385);assert.equal(boundary.refused,true);assert.equal(boundary.code,'WINDOWS_RESOURCE_LIMIT');assert.equal(boundary.securityUnchanged,true);assert.equal(boundary.profileNotCreated,true);assert.match(boundary.beforeSha256,/^[a-f0-9]{64}$/);assert.equal(boundary.beforeSha256,boundary.afterSha256);assert.ok(boundary.elapsedMs<=120000)
 // Component stopwatches above cover direct C# operations. This separate
 // no-start lease exercises the actual public JS/PowerShell transport, active
 // per-call120s deadline, bounded journal publication and recovery receipt.
 const flat=path.join(roots.trees,'flat5000'),targetPath=path.join(flat,'target'),scratchPath=path.join(flat,'scratch')
 const resourceControl=path.join(roots.control,'actual-resource-backend');fs.mkdirSync(resourceControl);ensureWindowsPrivateAcl(resourceControl)
 const snapshot=()=>{const r=cp.spawnSync(controller,['snapshot',targetPath,scratchPath,roots.runtime],{encoding:'utf8',timeout:120000,maxBuffer:4096,windowsHide:true,env});assert.ifError(r.error);assert.equal(r.status,0,r.stderr||r.stdout);assert.equal(r.stderr,'');const value=JSON.parse(r.stdout);assert.equal(value.schema,1);assert.equal(value.architecture,process.arch);assert.ok(value.objects>4096);assert.match(value.securitySha256,/^[a-f0-9]{64}$/);return value}
 const before=snapshot(),deployment=require('../../agents/codex/workflow/windows-helper-deployment.js').stageWindowsHelperDeployment(resourceControl)
 const deployedBindings=['windows-appcontainer.ps1','windows-appcontainer-native.cs','windows-appcontainer-resources.ps1','windows-appcontainer-resources-native.cs'].map(name=>{const bytes=fs.readFileSync(path.join(deployment.root,name));assert.equal(sha(bytes),sha(fs.readFileSync(path.join(workflow,name))));return {name,bytes:bytes.length,sha256:sha(bytes)}})
 t.diagnostic('WINDOWS_RESOURCE_SCALE_BACKEND_INPUTS:'+JSON.stringify(deployedBindings))
 const launcher=require('../../agents/codex/workflow/windows-appcontainer.js').createWindowsAppContainerLauncher({deploymentRoot:deployment.root})
 const resources=require('../../agents/codex/workflow/windows-appcontainer-resources.js')
 const policy={readOnly:false,targetPath,scratchPath,readableRoots:[targetPath,scratchPath],writableRoots:[targetPath,scratchPath]}
 const started=Date.now(),lease=await resources.prepareWindowsAppContainerResources({policy,controlRoot:resourceControl,deploymentRoot:deployment.root,executableRoots:[{path:roots.runtime,kind:'directory'}],verifyDrainEvidence:launcher.verifyDrainEvidence})
 const journalBytes=fs.readFileSync(lease.recovery.journalPath),journal=JSON.parse(journalBytes);assert.ok(journalBytes.length<=8*1024*1024);assert.equal(journal.plan.entries.length,before.objects)
 assert.equal(journal.sha256,sha(Buffer.from(JSON.stringify({schemaVersion:journal.schemaVersion,leaseId:journal.leaseId,plan:journal.plan}))))
 const noStart=launcher.proveNotStarted({profileSid:lease.profileSid,leaseId:lease.recovery.leaseId});assert.equal(noStart.notStarted,true)
 const restored=await lease.release(noStart);assert.deepEqual(restored,{restored:before.objects,newEntries:0,deletedEntries:0})
 const recovered=await resources.recoverWindowsAppContainerResources({controlRoot:resourceControl,deploymentRoot:deployment.root,journalPath:lease.recovery.journalPath,verifyDrainEvidence:launcher.verifyDrainEvidence,evidence:noStart});assert.deepEqual(recovered,restored)
 const receipt=JSON.parse(fs.readFileSync(lease.recovery.journalPath+'.restored'));assert.equal(receipt.leaseId,lease.recovery.leaseId);assert.equal(receipt.profileSid,lease.profileSid);assert.deepEqual(receipt.result,restored)
 const after=snapshot();assert.deepEqual(after,before)
 t.diagnostic('WINDOWS_RESOURCE_SCALE_TRANSPORT:'+JSON.stringify({scope:'actual-production-resource-backend-no-worker-started',entries:before.objects,journalBytes:journalBytes.length,journalSha256:sha(journalBytes),securitySha256:before.securitySha256,elapsedMs:Date.now()-started,restored,recovered,notStarted:true,accepted:false}))
 deployment.cleanup()
 t.diagnostic('WINDOWS_RESOURCE_SCALE_PROOF:'+JSON.stringify(proof));cleanupConfirmed=true
})
