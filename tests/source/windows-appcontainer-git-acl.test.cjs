'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process')
const workflow=path.resolve(__dirname,'../../agents/codex/workflow'),fixture=path.resolve(__dirname,'../fixtures/windows-appcontainer/git-acl-proof.cs')
const sources=[path.join(workflow,'windows-appcontainer-native.cs'),path.join(workflow,'windows-appcontainer-resources-native.cs'),fixture]
const shell=()=>process.platform==='win32'?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):(process.env.AUTOPROMPT_TEST_PWSH||'pwsh')
const denials=['overwrite','append','rename-file','delete-file','rename-git','new-git-file','nested-write','nested-create','protected-write','git-file-WRITE_DAC','git-directory-WRITE_DAC','target-WRITE_DAC','target-DELETE_CHILD','git-DELETE_CHILD']

test('complete resource and launcher sources compile with the native Git ACL regression', {timeout:90000},t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'git-acl-compile-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  // .NET on Linux lacks System.Web; the compile-only serializer stub is never
  // executed and cannot supply evidence about Windows ACLs or plan decoding.
  const stub=path.join(directory,'serializer.cs')
  fs.writeFileSync(stub,'namespace System.Web.Script.Serialization { public class JavaScriptSerializer { public int MaxJsonLength {get;set;} public object DeserializeObject(string value){throw new System.NotSupportedException();} public T Deserialize<T>(string value){throw new System.NotSupportedException();} public string Serialize(object value){throw new System.NotSupportedException();} } }')
  const script='$ErrorActionPreference="Stop";$files=[string[]]@($env:AP_GIT_ACL_NATIVE,$env:AP_GIT_ACL_RESOURCES,$env:AP_GIT_ACL_FIXTURE,$env:AP_GIT_ACL_CONTRACT);if($env:AP_GIT_ACL_STUB){Add-Type -Path ($files+@($env:AP_GIT_ACL_STUB))}else{Add-Type -Path $files -ReferencedAssemblies @("System.dll","System.Core.dll","System.Security.dll","System.Web.Extensions.dll")};$failure=[GitAclProof]::FailureDetails([System.ComponentModel.Win32Exception]::new(740,"controlled"));if($failure["nativeErrorCode"] -ne 740 -or $failure["fixturePhase"] -ne "startup" -or $failure["launcherStage"] -ne "initial"){throw "numeric native failure diagnostics mismatch"};$ordinary=[GitAclProof]::FailureDetails([InvalidOperationException]::new("controlled"));if($null -ne $ordinary["nativeErrorCode"]){throw "ordinary error fabricated native code"};if([InheritanceProvenanceContract]::Run() -ne 23){throw "provenance contracts incomplete"};[Console]::Write("compiled")'
  const result=cp.spawnSync(shell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:60000,windowsHide:true,env:{...process.env,AP_GIT_ACL_NATIVE:sources[0],AP_GIT_ACL_RESOURCES:sources[1],AP_GIT_ACL_FIXTURE:sources[2],AP_GIT_ACL_CONTRACT:path.resolve(__dirname,'../fixtures/windows-appcontainer/inheritance-provenance-contract.cs'),AP_GIT_ACL_STUB:process.platform==='win32'?'':stub}})
  if(result.error?.code==='ENOENT'&&process.platform!=='win32'){t.skip('PowerShell compiler unavailable; native Windows proof remains required');return}
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(result.stderr,'');assert.equal(result.stdout,'compiled')
})

test('native Windows .git grants deny mutation and restore inheritance after owned drain', {skip:process.platform!=='win32',timeout:600000},t=>{
  const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'git-acl-native-')))
  let cleanupConfirmed=false
  t.after(()=>{if(cleanupConfirmed)fs.rmSync(base,{recursive:true,force:true});else t.diagnostic('Retained native resource fixture and journal: '+base)})
  const {ensureWindowsPrivateAcl}=require('../../agents/codex/workflow/safe-run-root.js')
  ensureWindowsPrivateAcl(base)
  const roots={};for(const name of ['control','runtime','target','scratch']){const file=path.join(base,name);fs.mkdirSync(file);ensureWindowsPrivateAcl(file);roots[name]=file}
  const copied=sources.map((source,index)=>{const destination=path.join(roots.control,['native.cs','resources.cs','proof.cs'][index]);fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL);return destination})
  const controller=path.join(roots.control,'controller.exe'),worker=path.join(roots.runtime,'worker.exe'),system=process.env.SystemRoot
  const env={SystemRoot:system,WINDIR:system,SystemDrive:system.slice(0,2),PATH:path.join(system,'System32'),TEMP:roots.control,TMP:roots.control}
  const build='$ErrorActionPreference="Stop";$p=New-Object System.CodeDom.Compiler.CompilerParameters;$p.GenerateExecutable=$true;$p.GenerateInMemory=$false;$p.OutputAssembly=$env:AP_GIT_ACL_OUTPUT;$p.CompilerOptions="/platform:anycpu";$p.MainClass="GitAclProof";$p.TreatWarningsAsErrors=$true;foreach($a in @("System.dll","System.Core.dll","System.Security.dll","System.Web.Extensions.dll")){[void]$p.ReferencedAssemblies.Add($a)};$options=[Collections.Generic.Dictionary[string,string]]::new();$options.Add("CompilerVersion","v4.0");$provider=[Microsoft.CSharp.CSharpCodeProvider]::new($options);try{$result=$provider.CompileAssemblyFromFile($p,[string[]]@($env:AP_GIT_ACL_NATIVE,$env:AP_GIT_ACL_RESOURCES,$env:AP_GIT_ACL_FIXTURE));if($result.NativeCompilerReturnValue -ne 0 -or $result.Errors.HasErrors -or $result.Errors.HasWarnings){foreach($error in @($result.Errors|Select-Object -First 12)){[Console]::Error.WriteLine($error.ToString())};exit 1};if(![IO.File]::Exists($p.OutputAssembly)){throw "compiler output missing"}}finally{$provider.Dispose()}'
  const compiled=cp.spawnSync(shell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',build],{encoding:'utf8',timeout:120000,windowsHide:true,env:{...env,AP_GIT_ACL_NATIVE:copied[0],AP_GIT_ACL_RESOURCES:copied[1],AP_GIT_ACL_FIXTURE:copied[2],AP_GIT_ACL_OUTPUT:controller}})
  assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr||compiled.stdout);assert.equal(compiled.stderr,'')
  fs.copyFileSync(controller,worker,fs.constants.COPYFILE_EXCL)
  const result=cp.spawnSync(controller,[roots.target,roots.scratch,worker,roots.control],{encoding:'utf8',timeout:180000,maxBuffer:128*1024,windowsHide:true,cwd:roots.control,env,stdio:['ignore','pipe','pipe']})
  for(const stream of ['stdout','stderr']){const text=String(result[stream]||'');fs.writeFileSync(path.join(roots.control,stream+'.txt'),text);for(const line of text.slice(0,32768).split(/\r?\n/))for(let at=0;at<line.length;at+=480)t.diagnostic(stream+': '+line.slice(at,at+480))}
  const childRecord=path.join(roots.control,'child-proof.json')
  if(fs.existsSync(childRecord)){
    assert.ok(fs.statSync(childRecord).size<=4096,'Bounded child proof required')
    const child=JSON.parse(fs.readFileSync(childRecord,'utf8'))
    assert.deepEqual(child,{schema:1,architecture:process.arch,appContainer:true,drained:true,rootImageMatched:true,denials:denials.map(name=>name+':5'),positiveOperations:8,accepted:false})
    t.diagnostic('GIT_ACL_CHILD_PROOF:'+JSON.stringify(child))
  }
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(result.stderr,'')
  assert.equal(fs.existsSync(childRecord),true,'Pre-restoration child proof required')
  const proof=JSON.parse(result.stdout)
  assert.equal(proof.schema,1);assert.equal(proof.nativeWindows,true);assert.equal(proof.architecture,process.arch);assert.equal(proof.appContainer,true);assert.equal(proof.drained,true);assert.equal(proof.accepted,false)
  assert.deepEqual(proof.denials,denials);assert.equal(proof.positiveOperations,8);assert.ok(proof.originalObjects>=9)
  for(const key of ['restoredProtection','partialApplyRestored','foreignProtectionRefused','unrelatedAcePreserved','newGitLabelPreserved','packageGrantsRemoved','ownedAceDriftRefused','repeatedRestoreStable'])assert.equal(proof[key],true)
  assert.match(proof.gitOwner,/^S-1-/);assert.equal(proof.gitLabelBefore,proof.gitLabelApplied)
  cleanupConfirmed=true
})
