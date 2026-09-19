'use strict'
// Explicit diagnostic controller. No export, SDK replacement, or acceptance path.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { readBounded: bound, closureRecords, stagedDigest } = require('../probe-built-runtime.cjs')
const { physical } = require('../descriptor-proof/run.cjs')
const { bindBashRuntime } = require('../diagnostic-smoke/command.cjs')
const { parse } = require('./parse.cjs')
const { constructorMap } = require('./constructor-map.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const PURPOSE = 'fork-initialization-diagnostic-only'
for (const helper of [physical, bound, closureRecords, stagedDigest, bindBashRuntime, parse, constructorMap]) assert.equal(typeof helper, 'function', 'Diagnostic entry dependency missing')
function main(args) {
 assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
 assert.equal(args.length, 5, 'Usage: node run.cjs REPO CONTEXT EXPECTED_CONTEXT_SHA256 NEW_OUTPUT SYSTEM_ROOT')
 const [repoArg, contextPath, contextSha, outputArg, systemArg] = args
 const repo = physical(path.resolve(repoArg), true), system = physical(path.resolve(systemArg), true)
 assert.match(contextSha, /^[a-f0-9]{64}$/)
 const contextBytes = bound(contextPath, 65536); assert.equal(sha(contextBytes), contextSha)
 const c = JSON.parse(contextBytes)
 assert.deepEqual(Object.keys(c).sort(), ['schema','workRoot','traceDll','traceDllSha256','traceManifest','traceManifestSha256','normalManifest','normalManifestSha256','python','pythonSha256'].sort())
 assert.equal(c.schema, 1)
 for (const key of ['traceDllSha256','traceManifestSha256','normalManifestSha256','pythonSha256']) assert.match(c[key], /^[a-f0-9]{64}$/)
 const captured = new Map()
 function capture(file, expected, limit = 32 * 1048576) {
  const canonical = physical(path.resolve(file)), bytes = bound(canonical, limit), digest = sha(bytes)
  if (expected) assert.equal(digest, expected, 'Bound input changed: ' + canonical)
  captured.set(canonical, digest); return bytes
 }
 const work = physical(path.resolve(c.workRoot), true), sdk = path.join(work, 'sdk'), payload = path.join(sdk, 'issue27-build')
 const python = physical(path.resolve(c.python)); capture(python, c.pythonSha256)
 const traceBytes = capture(c.traceDll, c.traceDllSha256)
 const constructors=constructorMap(traceBytes),constructorBytes=Buffer.from(JSON.stringify(constructors,null,2)+'\n')
 const traceManifest = JSON.parse(capture(c.traceManifest, c.traceManifestSha256, 65536))
 assert.equal(traceManifest.purpose, PURPOSE); assert.equal(traceManifest.accepted, false)
 assert.equal(traceManifest.sourceCommit, '270ba2980700e6e2a0813944d506eecea0f86402')
 assert.equal(traceManifest.sourceArchiveSha256, '0571ad83f965bf7682a446a874830a560c8b12431e7d54e55f414a3851ba1146')
 for (const key of ['traceHeaderSha256','generatorSha256','sourcePinsSha256','recipeSha256','tracePatchSha256']) assert.match(traceManifest[key], /^[a-f0-9]{64}$/)
 capture(path.join(__dirname, 'trace.h'), traceManifest.traceHeaderSha256)
 capture(path.join(__dirname, 'generate.py'), traceManifest.generatorSha256)
 capture(path.join(__dirname, 'source-pins.json'), traceManifest.sourcePinsSha256)
 capture(path.join(__dirname, 'build-trace.sh'), traceManifest.recipeSha256)
 capture(path.join(__dirname, 'parse.cjs')); capture(path.join(__dirname, 'constructor-map.cjs')); capture(__filename)
 const patchHash = sha(capture(path.join(repo, 'scripts/windows-msys/pipe-security.patch')))
 assert.equal(traceManifest.basePatchSha256, patchHash)
 capture(path.join(path.dirname(c.traceManifest), 'trace.patch'), traceManifest.tracePatchSha256)
 const normal = JSON.parse(capture(c.normalManifest, c.normalManifestSha256, 1048576))
 assert.equal(normal.patchSha256, patchHash); assert.equal(normal.fixture.architecture, 'x64'); assert.equal(normal.fixture.hostProof, 'host-check:passed')
 const fixture = physical(normal.fixture.executable)
 assert.equal(path.dirname(fixture).toLowerCase(), path.dirname(physical(c.normalManifest)).toLowerCase())
 const fixtureBytes = capture(fixture, normal.fixture.executableSha256)
 assert.equal(normal.fixture.sourceSha256, sha(capture(path.join(repo, 'scripts/windows-msys/process-security-proof/process-security.cc'))))
 const smokeBytes = capture(path.join(payload, 'built-runtime-manifest.json'), normal.runtimeManifestSha256, 1048576), smoke = JSON.parse(smokeBytes)
 assert.equal(path.dirname(smoke.runtimeDirectory).toLowerCase(), payload.toLowerCase())
 assert.match(path.basename(smoke.runtimeDirectory), /^proof-runtime-[a-f0-9-]+$/)
 const source = bindBashRuntime(smoke.runtimeDirectory, system)
 assert.deepEqual(closureRecords(source), smoke.copied); assert.deepEqual(closureRecords(source), normal.runtimeClosure)
 for (const file of source) capture(file.path, file.sha256)
 const candidateSha = stagedDigest(capture(path.join(payload, 'stage.sha256')))
 assert.equal(candidateSha, smoke.stageSha256)
 capture(path.join(payload, 'stage/usr/bin/msys-2.0.dll'), candidateSha)
 assert.notEqual(candidateSha, c.traceDllSha256, 'Trace DLL must be distinct from candidate')
 // Preserve current verified SDK bytes independently of the diagnostic closure.
 for (const [receipt, names] of [['bootstrap-runtime.sha256',['msys-2.0.dll']],['toolchain-outputs.sha256',['gcc.exe','ld.exe']]]) {
  const lines = capture(path.join(payload, receipt)).toString('utf8').trimEnd().split('\n'); assert.equal(lines.length, names.length)
  for (let i=0;i<names.length;i++) {
   const match = /^([a-f0-9]{64}) [ *]\/usr\/bin\/([a-z0-9.-]+)$/.exec(lines[i]); assert.ok(match); assert.equal(match[2], names[i])
   capture(path.join(sdk, 'usr/bin', names[i]), match[1])
  }
 }
 const nativeBytes = capture(path.join(repo, 'agents/codex/workflow/windows-appcontainer-native.cs'), normal.nativeSha256)
 const controllerBytes = capture(path.join(repo, 'scripts/windows-msys/process-security-proof/controller.cs'), normal.controllerSha256)
 const deriver = path.join(__dirname, 'derive-native.py'); capture(deriver)
 const output = path.resolve(outputArg); assert.equal(fs.existsSync(output), false); physical(path.dirname(output), true)
 const privateAcl = require(path.join(repo, 'agents/codex/workflow/safe-run-root.js')).ensureWindowsPrivateAcl
 const mkdir = directory => { fs.mkdirSync(directory); privateAcl(directory); return directory }
 mkdir(output)
 const manifest = { schema:1, purpose:PURPOSE, accepted:false, status:'pending', cleanupConfirmed:false, contextSha256:contextSha,
  originalCandidateSha256:candidateSha, traceDllSha256:c.traceDllSha256, traceManifestSha256:c.traceManifestSha256, normalManifestSha256:c.normalManifestSha256,
  constructorMapSha256:sha(constructorBytes), constructorMap:constructors, runnerSha256:sha(bound(__filename)), retainedRoot:output, commands:[], inputs:[...captured].map(([file,sha256])=>({file,sha256})) }
 const save=()=>fs.writeFileSync(path.join(output,'diagnostic-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
 save()
 const control=mkdir(path.join(output,'control')), runtime=mkdir(path.join(output,'runtime')); mkdir(path.join(runtime,'usr'))
 const bin=mkdir(path.join(runtime,'usr/bin')), etc=mkdir(path.join(runtime,'etc')), cwdA=mkdir(path.join(output,'cwd-A')), cwdB=mkdir(path.join(output,'cwd-B'))
 const write=(file,bytes)=>fs.writeFileSync(file,bytes,{flag:'wx'})
 write(path.join(output,'context.json'),contextBytes)
 write(path.join(output,'constructor-map.json'),constructorBytes)
 for (const file of source) write(path.join(bin,file.name),file.name==='msys-2.0.dll'?traceBytes:file.bytes)
 write(path.join(bin,'process-security.exe'),fixtureBytes); write(path.join(etc,'fstab'),'none /tmp usertemp binary,posix=0,noacl 0 0\n')
 const diagnostic = bindBashRuntime(bin,system)
 manifest.traceClosure=closureRecords(diagnostic)
 assert.deepEqual(manifest.traceClosure,closureRecords(source).map(file=>file.name==='msys-2.0.dll'?{...file,sha256:c.traceDllSha256,bytes:traceBytes.length}:file))
 const nativeInput=path.join(control,'native-input.cs'),controllerInput=path.join(control,'controller-input.cs')
 write(nativeInput,nativeBytes);write(controllerInput,controllerBytes)
 const env={SystemRoot:system,WINDIR:system,SystemDrive:system.slice(0,2),PATH:path.join(system,'System32'),TEMP:control,TMP:control}
 const run=(label,file,argv,environment,timeout)=>{
  const result=cp.spawnSync(file,argv,{env:environment,cwd:control,encoding:'utf8',timeout,maxBuffer:256*1024,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']})
  write(path.join(output,label+'.stdout.txt'),result.stdout||'');write(path.join(output,label+'.stderr.txt'),result.stderr||'')
  manifest.commands.push({label,status:result.status,signal:result.signal,error:result.error?.code||null});save();return result
 }
 let failure
 try {
  const derived=path.join(control,'derived')
  const result=run('derive',python,['-I',deriver,nativeInput,normal.nativeSha256,derived,'--controller',controllerInput,'--controller-sha',normal.controllerSha256],env,30000)
  assert.ifError(result.error);assert.equal(result.status,0);assert.equal(result.stderr,'');privateAcl(derived)
  const native=path.join(derived,'native-trace.cs'),controllerSource=path.join(derived,'controller-trace.cs'),executable=path.join(control,'controller.exe')
  manifest.derivedNativeSha256=sha(bound(native));manifest.derivedControllerSha256=sha(bound(controllerSource));save()
  const compile=run('compile-controller',path.join(system,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command','[Environment]::SetEnvironmentVariable("PSModulePath",[IO.Path]::Combine($PSHOME,"Modules"),[EnvironmentVariableTarget]::Process);$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";Add-Type -Path @($env:AP_NATIVE,$env:AP_SOURCE) -OutputAssembly $env:AP_OUTPUT -OutputType ConsoleApplication'],{...env,AP_NATIVE:native,AP_SOURCE:controllerSource,AP_OUTPUT:executable},60000)
  assert.ifError(compile.error);assert.equal(compile.status,0);assert.equal(compile.stderr,'')
  manifest.controllerExecutableSha256=sha(bound(executable));save()
  const sharedId=require(path.join(repo,'agents/codex/workflow/windows-appcontainer.js')).parseMsysSharedId(traceBytes)
  const observation=run('native-controller',executable,[path.join(bin,'process-security.exe'),normal.fixture.executableSha256,path.join(bin,'bash.exe'),source.find(f=>f.name==='bash.exe').sha256,path.join(bin,'msys-2.0.dll'),c.traceDllSha256,sharedId,control,cwdA,cwdB],env,80000)
  manifest.observation=parse(observation.stderr||'');
  const constructorStages=new Set(constructors.callOrder.flatMap(item=>[item.beforeStage,item.afterStage]))
  for(const operation of manifest.observation.operations)for(const record of operation.records)if(record.stage>=0x100)assert.ok(constructorStages.has(record.stage),'Trace constructor index absent from exact DLL')
  manifest.cleanupConfirmed=!observation.error&&manifest.observation.cleanupConfirmed
  manifest.status=observation.error?'controller-incomplete':'diagnostic-collected'
  assert.equal(sha(bound(native)),manifest.derivedNativeSha256);assert.equal(sha(bound(controllerSource)),manifest.derivedControllerSha256);assert.equal(sha(bound(executable)),manifest.controllerExecutableSha256)
 } catch(error) { failure=error;manifest.status='diagnostic-failed';manifest.error=String(error.message).slice(0,2048) }
 finally {
  try { for(const [file,digest] of captured) assert.equal(sha(bound(file)),digest,'Original input changed: '+file);manifest.originalInputsUnchanged=true }
  catch(error){manifest.originalInputsUnchanged=false;manifest.status='diagnostic-failed';failure ||= error;manifest.error=String(error.message).slice(0,2048)}
  // Retain even confirmed closures for raw evidence. Unknown drain never permits deletion.
  save()
 }
 if(failure)throw failure
 process.stdout.write(JSON.stringify({accepted:false,status:manifest.status,cleanupConfirmed:manifest.cleanupConfirmed,manifest:path.join(output,'diagnostic-manifest.json')})+'\n')
}
module.exports={main}
if(require.main===module){try{main(process.argv.slice(2))}catch(error){process.stderr.write((error.stack||error)+'\n');process.exitCode=1}}
