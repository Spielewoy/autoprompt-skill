'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')
const { ensureWindowsPrivateAcl, ensureWindowsDefaultTokenOwner, windowsControllerEnvironment } = require('./safe-run-root.js')
function failureDiagnostic(error, phase) {
  const details = error && error.details
  // This probe only runs fixed controller diagnostics. Preserve their bounded
  // failure explanation, never arbitrary error properties or environment maps.
  const diagnostic = { phase, message: String(error && error.message || 'Native probe failed').slice(0, 1024) }
  for (const name of ['stage', 'helperPhase', 'cause', 'signal']) {
    if (typeof details?.[name] === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(details[name])) diagnostic[name] = details[name]
  }
  for (const name of ['status', 'timeoutMs']) if (details?.[name] === null || Number.isSafeInteger(details?.[name])) diagnostic[name] = details[name]
  if (typeof details?.stderr === 'string' && details.stderr) diagnostic.stderr = details.stderr.slice(0, 2048)
  return diagnostic
}
function runtimeKey(workerIdentity) {
  const hash = crypto.createHash('sha256')
  for (const name of ['windows-appcontainer.js', 'windows-appcontainer.ps1', 'windows-appcontainer-native.cs', 'windows-appcontainer-command.js', 'windows-appcontainer-probe.js', 'windows-appcontainer-resources.js', 'windows-appcontainer-resources.ps1', 'windows-appcontainer-resources-native.cs', 'windows-helper-deployment.js', 'windows-filesystem.js', 'windows-filesystem.ps1']) hash.update(name).update(fs.readFileSync(path.join(__dirname, name)))
  hash.update(workerIdentity)
  hash.update(fs.readFileSync(process.execPath))
  return hash.update(JSON.stringify([process.pid, process.env.SystemRoot, process.env.LOCALAPPDATA])).digest('hex')
}
async function listen(host) {
  const state = { accepted: 0 }
  const server = net.createServer(socket => { state.accepted++; socket.end() })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  return { server, state, host, port: server.address().port, family: host === '::1' ? 6 : 4 }
}
async function control(endpoint) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port, family: endpoint.family })
    socket.once('connect', () => { socket.destroy(); resolve() }); socket.once('error', reject)
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('CONTROL_TIMEOUT')) })
  })
  await new Promise(resolve => setImmediate(resolve))
}
async function probeWindowsAppContainer() {
  return require('./windows-appcontainer-command.js').probeWindowsAppContainer()
}
// This fixed fixture cannot grant admission. Only command.js owns that cache and
// supplies the private tuple-bound executor; external calls receive observations.
async function runWindowsAppContainerCanary(runWindowsAppContainerCommand, workerIdentity, key) {
  if (process.platform !== 'win32') return { supported: false, backend: 'windows-appcontainer', code: 'COMMAND_SANDBOX_UNSUPPORTED' }
  if (typeof runWindowsAppContainerCommand !== 'function' || !/^[a-f0-9]{64}$/.test(workerIdentity) || key !== runtimeKey(workerIdentity)) throw new Error('CANARY_IDENTITY_MISMATCH')
  ensureWindowsDefaultTokenOwner()
  const controllerEnvironment = windowsControllerEnvironment(process.env.SystemRoot || process.env.WINDIR)
  let base = fs.mkdtempSync(path.join(controllerEnvironment.TEMP, 'autoprompt-appcontainer-probe-'))
  let preserve = false, launcherSessionId = null, nativeExitCode = null, probeFailure = null, primaryError = null, phase = 'private-root'
  const endpoints = []
  try {
    base = fs.realpathSync.native(base)
    ensureWindowsPrivateAcl(base)
    phase = 'private-fixture'
    const controlRoot = path.join(base, 'controller'), target = path.join(base, 'target'), scratch = path.join(base, 'scratch')
    for (const directory of [controlRoot, target, scratch]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
    fs.mkdirSync(path.join(target, '.git')); fs.writeFileSync(path.join(target, '.git', 'guard'), 'controller git')
    fs.writeFileSync(path.join(target, 'allowed'), 'allowed')
    const deletedOriginal = path.join(target, 'delete-original')
    fs.writeFileSync(deletedOriginal, 'controller original', { flag: 'wx' })
    const sentinel = path.join(controlRoot, 'sentinel'); fs.writeFileSync(sentinel, 'controller only')
    phase = 'loopback-control'
    endpoints.push(await listen('127.0.0.1'))
    endpoints.push(await listen('::1'))
    for (const endpoint of endpoints) { await control(endpoint); if (endpoint.state.accepted !== 1) throw new Error('CONTROL_ACCEPT'); endpoint.state.accepted = 0 }
    const targetStat = fs.lstatSync(target, { bigint: true })
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || targetStat.dev < 0n || targetStat.dev > 0xffffffffn || targetStat.ino < 1n || targetStat.ino > 0xffffffffffffffffn || !['x64', 'arm64'].includes(process.arch)) throw new Error('CANARY_TARGET_IDENTITY_INVALID')
    const targetIdentity = targetStat.dev.toString(16).padStart(8, '0') + ':' + targetStat.ino.toString(16).padStart(16, '0')
    const fixture = { target, scratch, sentinel, targetIdentity, architecture: process.arch, endpoints: endpoints.map(({host,port,family}) => ({host,port,family})) }
    const source = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),path=require('node:path');const f=${JSON.stringify(fixture)};let phase='read';const need=x=>{if(!x)throw Error('PROBE')};const denied=p=>{try{fs.readFileSync(p);return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}};const request=e=>new Promise(ok=>{let done=false;const finish=v=>{if(done)return;done=true;s.destroy();ok(v)};const s=net.connect(e);s.once('connect',()=>finish(false));s.once('error',e=>finish(['EACCES','EPERM','ETIMEDOUT'].includes(e.code)));s.setTimeout(1500,()=>finish(false))});(async()=>{need(fs.readFileSync(path.join(f.target,'allowed'),'utf8')==='allowed');phase='delete-original';need(fs.readFileSync(path.join(f.target,'delete-original'),'utf8')==='controller original');fs.unlinkSync(path.join(f.target,'delete-original'));phase='write-target';fs.writeFileSync(path.join(f.target,'written'),'worker');phase='write-scratch';fs.writeFileSync(path.join(f.scratch,'written'),'scratch');phase='new-entry-delete';for(const root of [f.target,f.scratch]){const directory=path.join(root,'delete-created'),file=path.join(directory,'child');fs.mkdirSync(directory);fs.writeFileSync(file,'worker');fs.unlinkSync(file);fs.rmdirSync(directory)}phase='sentinel';need(denied(f.sentinel));phase='git-write';let gitDenied=false,gitOutcome='WRITE_SUCCEEDED';try{fs.writeFileSync(path.join(f.target,'.git','guard'),'bad')}catch(e){gitOutcome=/^[A-Z][A-Z0-9_]{0,39}$/.test(String(e.code))?e.code:'OTHER_ERRNO';gitDenied=['EACCES','EPERM'].includes(e.code)}if(!gitDenied){const error=Error('PROBE');error.code='GIT_'+gitOutcome;throw error};phase='git-rename-delete';for(const operation of [()=>fs.renameSync(path.join(f.target,'.git'),path.join(f.target,'moved-git')),()=>fs.unlinkSync(path.join(f.target,'.git','guard'))]){let denied=false;try{operation()}catch(e){denied=['EACCES','EPERM'].includes(e.code)}need(denied)}phase='acl-write';const aclResult=path.join(f.scratch,'acl-result.txt'),aclOutput=fs.openSync(aclResult,'wx');let aclExit;try{const acl=cp.spawn(path.join(path.dirname(process.execPath),'acl-probe.exe'),['--acl-probe',process.env.AUTOPROMPT_APP_CONTAINER_SID,f.target,f.targetIdentity],{cwd:f.scratch,stdio:[0,aclOutput,aclOutput]});aclExit=await new Promise((ok,no)=>{acl.once('error',no);acl.once('exit',ok)})}finally{fs.closeSync(aclOutput)};need(fs.statSync(aclResult).size<=256);const aclBytes=fs.readFileSync(aclResult),aclExpected='bundle-acl-denied-v1:'+f.architecture+':'+f.targetIdentity+':5';need(aclExit===0&&aclBytes.length<=256&&(aclBytes.equals(Buffer.from(aclExpected+'\\r\\n'))||aclBytes.equals(Buffer.from(aclExpected+'\\n'))));phase='descendant';const child=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),10000)'],{stdio:'inherit'});need(child.pid>0);let childError=false;child.on('error',()=>{childError=true});await new Promise(r=>setTimeout(r,100));phase='network';for(const e of f.endpoints)need(await request(e));phase='child-kill';const exit=new Promise(r=>child.once('exit',r));need(child.kill());await exit;need(!childError);process.stdout.write('APPCONTAINER_PROBE_PASS')})().catch(error=>{process.stderr.write('APPCONTAINER_PROBE_FAILURE:'+phase+':'+String(error.code||'CHECK'));process.exitCode=1})`
    const encoded = Buffer.from(source).toString('base64')
    // Admission must exercise Bash fork/pipe behavior as well as the Node worker.
    // A final simple command can otherwise pass through Bash's exec optimization.
    const command = `ap_parent=$BASHPID; ap_child=$(printf '%s' "$BASHPID") || { printf '%s' 'APPCONTAINER_PROBE_FAILURE:bash-fork:COMMAND_SUBSTITUTION' >&2; exit 91; }; [[ "$ap_parent" =~ ^[0-9]+$ && "$ap_child" =~ ^[0-9]+$ && "$ap_child" != "$ap_parent" ]] || { printf '%s' 'APPCONTAINER_PROBE_FAILURE:bash-fork:CHILD_IDENTITY' >&2; exit 92; }; set -o pipefail && printf '%s\\n' 'APPCONTAINER_PIPE_PROBE' | (read -r ap_line && [[ "$ap_line" == APPCONTAINER_PIPE_PROBE && "$BASHPID" != "$ap_parent" ]]) || { printf '%s' 'APPCONTAINER_PROBE_FAILURE:bash-pipe:CHECK' >&2; exit 93; }; node -e "eval(Buffer.from('${encoded}','base64').toString())"`
    const policy = { schemaVersion: 1, provider: 'claude', nestedDispatch: false, commandBoundary: true, externalWrites: false, targetPath: target, scratchPath: scratch,
      readableRoots: [target, scratch], writableRoots: [target, scratch], readOnly: false }
    phase = 'command-launch'
    const result = await runWindowsAppContainerCommand(policy, { command, cwd: target, timeoutMs: 15000 }, { controlRoot })
    phase = 'command-result'
    launcherSessionId = result.launcherSessionId; nativeExitCode = result.exitCode; probeFailure = {
      stdout: result.stdout.slice(0, 1024), stderr: result.stderr.slice(0, 1024),
      timedOut: result.timedOut === true, cancelled: result.cancelled === true, truncated: result.truncated === true,
      durationMs: Number.isSafeInteger(result.durationMs) ? result.durationMs : null,
    }
    try { probeFailure.gitGuard = fs.readFileSync(path.join(target, '.git', 'guard'), 'utf8') === 'controller git' ? 'UNCHANGED' : 'CHANGED' } catch { probeFailure.gitGuard = 'UNREADABLE' }
    if (result.workerIdentity !== workerIdentity) throw new Error('WORKER_TUPLE_CHANGED')
    if (result.status !== 'completed' || result.stdout !== 'APPCONTAINER_PROBE_PASS' || result.stderr || fs.readFileSync(path.join(target, '.git', 'guard'), 'utf8') !== 'controller git') throw new Error('NATIVE_PROBE_FAILED')
    phase = 'original-recovery'
    // runTupleCommand returns only after owned drain and validated ACL recovery.
    // This exercises the private TEMP fixture's volume, not arbitrary projects.
    if (result.resourceRecovery?.deletedEntries !== 1) throw new Error('ORIGINAL_RECOVERY_UNPROVEN')
    let originalAbsent = false
    try { fs.lstatSync(deletedOriginal) } catch (error) { if (error.code === 'ENOENT') originalAbsent = true; else throw error }
    if (!originalAbsent) throw new Error('ORIGINAL_DELETE_UNPROVEN')
    for (const root of [target, scratch]) {
      let createdAbsent = false
      try { fs.lstatSync(path.join(root, 'delete-created')) } catch (error) { if (error.code === 'ENOENT') createdAbsent = true; else throw error }
      if (!createdAbsent) throw new Error('CREATED_DELETE_UNPROVEN')
    }
    phase = 'loopback-denial'
    for (const endpoint of endpoints) { if (endpoint.state.accepted !== 0) throw new Error('SANDBOX_CONNECTED'); await control(endpoint); if (endpoint.state.accepted !== 1) throw new Error('CONTROL_ACCEPT') }
    const supported = Object.freeze({ supported: true, backend: 'windows-appcontainer', runtimeSha256: key, workerIdentity, launcherSessionId: result.launcherSessionId,
      resourceRecovery: Object.freeze({ ...result.resourceRecovery }), resourceRecoveryScope: 'pre-existing original deleted and recovered on private TEMP fixture volume',
      networkProof: 'zero sandbox accepts between successful same-listener IPv4/IPv6 controller checks; bounded explicit socket denial', processCleanup: 'owned-job-drained' })
    return supported
  } catch (error) {
    primaryError = error
    preserve = error.cleanupConfirmed === false || error.code === 'APPCONTAINER_CLEANUP_UNCONFIRMED' || Boolean(error.recovery && !error.recoveryResolved)
    return { supported: false, backend: 'windows-appcontainer', code: error.code || 'COMMAND_SANDBOX_UNSUPPORTED', diagnostic: failureDiagnostic(error, phase), launcherSessionId, nativeExitCode, probeFailure, ...(preserve ? { recoveryRoot: base, ...(typeof error.retainedStagingRoot === 'string' ? { retainedStagingRoot: error.retainedStagingRoot } : {}) } : {}) }
  } finally {
    let cleanupFailure
    for (const endpoint of endpoints) { try { endpoint.server.close() } catch (error) { cleanupFailure ||= error } }
    if (!preserve && !cleanupFailure) { try { fs.rmSync(base, { recursive: true, force: true }) } catch (error) { cleanupFailure ||= error } }
    if (cleanupFailure) {
      const error = primaryError || cleanupFailure
      error.cleanupConfirmed = false
      error.recoveryRoot = base
      error.cleanupCode = String(cleanupFailure.code || 'cleanup-failed').slice(0, 64)
      throw error
    }
  }
}
module.exports = { probeWindowsAppContainer, failureDiagnostic, canaryKey: runtimeKey, runWindowsAppContainerCanary }
