'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process'),path=require('node:path')
const shell=()=>process.env.AUTOPROMPT_CAPTURE_PWSH||(process.platform==='win32'?path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'):'pwsh')
test('actual fixed ACL helper compiles and rejects malformed authority without Win32 calls',()=>{
 const result=cp.spawnSync(shell(),['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(__dirname,'acl-contract.ps1')],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024})
 assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.stderr,'');assert.match(result.stdout,/^actual-compiled-acl-parser-contracts:33\r?\n$/)
})
const fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto')
const repo=path.resolve(__dirname,'../../..'),workflow=path.join(repo,'agents/codex/workflow')
const sources=[path.join(workflow,'windows-appcontainer-native.cs'),path.join(workflow,'windows-appcontainer-resources-native.cs'),path.join(__dirname,'acl-native.cs')]
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
test('actual native ACL controller compiles with complete production resource and launcher sources',{timeout:90000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'acl-helper-compile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const stub=path.join(root,'serializer.cs');fs.writeFileSync(stub,'namespace System.Web.Script.Serialization { public class JavaScriptSerializer { public int MaxJsonLength{get;set;} public object DeserializeObject(string value){throw new System.NotSupportedException();} public T Deserialize<T>(string value){throw new System.NotSupportedException();} public string Serialize(object value){throw new System.NotSupportedException();} } }')
 const script='$ErrorActionPreference="Stop";$files=[string[]]@($env:AP_NATIVE,$env:AP_RESOURCES,$env:AP_FIXTURE);if($env:AP_STUB){Add-Type -Path ($files+@($env:AP_STUB))}else{Add-Type -Path $files -ReferencedAssemblies @("System.dll","System.Core.dll","System.Security.dll","System.Web.Extensions.dll")};[Console]::Write("compiled")'
 const r=cp.spawnSync(shell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:60000,env:{...process.env,AP_NATIVE:sources[0],AP_RESOURCES:sources[1],AP_FIXTURE:sources[2],AP_STUB:process.platform==='win32'?'':stub}})
 assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(r.stderr,'');assert.equal(r.stdout,'compiled')
})
test('native fixed ACL helper proves exact AppContainer denial and refuses host, grant, SID and identity controls',{skip:process.platform!=='win32',timeout:600000},t=>{
 const build=process.env.AUTOPROMPT_CAPTURE_BUILD;assert.ok(build,'Explicit current-source compiled helper build required')
 const record=JSON.parse(fs.readFileSync(path.join(build,'build.json'),'utf8'))
 assert.equal(record.status,'compiled-native-identity-only');assert.deepEqual(record.source.map(v=>v.path),['../physical-proof/audit.cs','lease-main.cs','build.ps1'])
 for(const file of record.source)assert.equal(sha(fs.readFileSync(path.join(__dirname,file.path))),file.sha256)
 assert.deepEqual(record.files.map(v=>v.path),['bundle-lease.exe','bundle-lease.exe.config'])
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(build,'acl-helper-native-'))),privateAcl=require(path.join(workflow,'safe-run-root.js')).ensureWindowsPrivateAcl
 privateAcl(root);let clean=false;t.after(()=>{if(clean)fs.rmSync(root,{recursive:true,force:true});else t.diagnostic('Retained ACL helper proof: '+root)})
 const roots={};for(const name of ['target','scratch','runtime','control']){roots[name]=path.join(root,name);fs.mkdirSync(roots[name]);privateAcl(roots[name])}
 for(const file of record.files){const bytes=fs.readFileSync(path.join(build,file.path));assert.equal(bytes.length,file.length);assert.equal(sha(bytes),file.sha256);fs.writeFileSync(path.join(roots.runtime,file.path),bytes,{flag:'wx'})}
 const helper=path.join(roots.runtime,'bundle-lease.exe'),st=fs.lstatSync(roots.target,{bigint:true})
 assert.ok(st.isDirectory()&&st.dev>=0n&&st.dev<=0xffffffffn&&st.ino>=0n&&st.ino<=0xffffffffffffffffn)
 const identity=st.dev.toString(16).padStart(8,'0')+':'+st.ino.toString(16).padStart(16,'0'),system=process.env.SystemRoot
 const env={SystemRoot:system,WINDIR:system,SystemDrive:system.slice(0,2),PATH:path.join(system,'System32'),TEMP:roots.control,TMP:roots.control}
 const host=cp.spawnSync(helper,['--acl-probe','S-1-15-2-1-2-3-4-5-6-7',roots.target,identity],{encoding:'utf8',timeout:15000,maxBuffer:4096,env})
 assert.ifError(host.error);assert.equal(host.status,1);assert.equal(host.stdout,'');assert.equal(host.stderr,'bundle-acl-probe-refused:acl-AppContainer-required\r\n')
 const controller=path.join(roots.control,'controller.exe')
 const script='$ErrorActionPreference="Stop";$p=[CodeDom.Compiler.CompilerParameters]::new();$p.GenerateExecutable=$true;$p.OutputAssembly=$env:AP_OUTPUT;$p.CompilerOptions="/platform:anycpu";$p.MainClass="BundleAclNativeControls";$p.TreatWarningsAsErrors=$true;foreach($a in @("System.dll","System.Core.dll","System.Security.dll","System.Web.Extensions.dll")){[void]$p.ReferencedAssemblies.Add($a)};$options=[Collections.Generic.Dictionary[string,string]]::new();$options.Add("CompilerVersion","v4.0");$provider=[Microsoft.CSharp.CSharpCodeProvider]::new($options);try{$r=$provider.CompileAssemblyFromFile($p,[string[]]@($env:AP_NATIVE,$env:AP_RESOURCES,$env:AP_FIXTURE));if($r.NativeCompilerReturnValue -ne 0 -or $r.Errors.HasErrors -or $r.Errors.HasWarnings){foreach($e in @($r.Errors|Select-Object -First 12)){[Console]::Error.WriteLine($e.ToString())};exit 1}}finally{$provider.Dispose()}'
 const compiled=cp.spawnSync(shell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:90000,maxBuffer:65536,env:{...env,AP_NATIVE:sources[0],AP_RESOURCES:sources[1],AP_FIXTURE:sources[2],AP_OUTPUT:controller}})
 assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);assert.equal(compiled.stderr,'')
 fs.writeFileSync(controller+'.config','<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>')
 const result=cp.spawnSync(controller,[roots.target,roots.scratch,helper,roots.control,identity,process.arch],{encoding:'utf8',timeout:240000,maxBuffer:65536,env})
 for(const stream of ['stdout','stderr']){fs.writeFileSync(path.join(roots.control,stream+'.txt'),result[stream]||'');for(const line of String(result[stream]||'').slice(0,32768).split(/\r?\n/))if(line)t.diagnostic(stream+': '+line.slice(0,1024))}
 assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.stderr,'')
 assert.deepEqual(result.stdout.trim().split(/\r?\n/),['actual-AppContainer-denial','wrong-profile-SID','wrong-directory-identity','missing-target','actual-WRITE_DAC-grant-refused'].map(v=>'native-acl-control:'+v))
 assert.equal(fs.readFileSync(path.join(roots.control,'cleanup-confirmed'),'utf8'),'owned-drain-and-resource-restore');clean=true
})
