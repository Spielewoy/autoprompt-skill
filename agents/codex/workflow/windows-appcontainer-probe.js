'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const net = require('node:net')
const { ensureWindowsPrivateAcl } = require('./safe-run-root.js')
const { runWindowsAppContainerCommand } = require('./windows-appcontainer-command.js')
let cached
function failureDiagnostic(error, phase) {
  const details = error && error.details
  // This probe only runs fixed controller diagnostics. Preserve their bounded
  // failure explanation, never arbitrary error properties or environment maps.
  const diagnostic = { phase, message: String(error && error.message || 'Native probe failed').slice(0, 1024) }
  for (const name of ['stage', 'cause', 'signal']) {
    if (typeof details?.[name] === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(details[name])) diagnostic[name] = details[name]
  }
  for (const name of ['status', 'timeoutMs']) if (details?.[name] === null || Number.isSafeInteger(details?.[name])) diagnostic[name] = details[name]
  if (typeof details?.stderr === 'string' && details.stderr) diagnostic.stderr = details.stderr.slice(0, 2048)
  return diagnostic
}
function runtimeKey() {
  const hash = crypto.createHash('sha256')
  for (const name of ['windows-appcontainer.js', 'windows-appcontainer.ps1', 'windows-appcontainer-native.cs', 'windows-appcontainer-command.js', 'windows-appcontainer-probe.js', 'windows-appcontainer-resources.js', 'windows-appcontainer-resources.ps1', 'windows-appcontainer-resources-native.cs', 'windows-filesystem.js', 'windows-filesystem.ps1']) hash.update(name).update(fs.readFileSync(path.join(__dirname, name)))
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
  if (process.platform !== 'win32') return { supported: false, backend: 'windows-appcontainer', code: 'COMMAND_SANDBOX_UNSUPPORTED' }
  let key
  try { key = runtimeKey() } catch (error) { return { supported: false, backend: 'windows-appcontainer', code: 'WINDOWS_RUNTIME_UNAVAILABLE', diagnostic: failureDiagnostic(error, 'runtime-identity') } }
  if (cached?.key === key) return cached.result
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-appcontainer-probe-')))
  let preserve = false, launcherSessionId = null, nativeExitCode = null, probeFailure = null, phase = 'private-root'
  const endpoints = []
  try {
    ensureWindowsPrivateAcl(base)
    phase = 'private-fixture'
    const controlRoot = path.join(base, 'controller'), target = path.join(base, 'target'), scratch = path.join(base, 'scratch')
    for (const directory of [controlRoot, target, scratch]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
    fs.mkdirSync(path.join(target, '.git')); fs.writeFileSync(path.join(target, '.git', 'guard'), 'controller git')
    fs.writeFileSync(path.join(target, 'allowed'), 'allowed')
    const sentinel = path.join(controlRoot, 'sentinel'); fs.writeFileSync(sentinel, 'controller only')
    phase = 'loopback-control'
    endpoints.push(await listen('127.0.0.1'), await listen('::1'))
    for (const endpoint of endpoints) { await control(endpoint); if (endpoint.state.accepted !== 1) throw new Error('CONTROL_ACCEPT'); endpoint.state.accepted = 0 }
    const fixture = { target, scratch, sentinel, endpoints: endpoints.map(({host,port,family}) => ({host,port,family})) }
    const source = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),path=require('node:path');const f=${JSON.stringify(fixture)};let phase='read';const need=x=>{if(!x)throw Error('PROBE')};const denied=p=>{try{fs.readFileSync(p);return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}};const request=e=>new Promise(ok=>{let done=false;const finish=v=>{if(done)return;done=true;s.destroy();ok(v)};const s=net.connect(e);s.once('connect',()=>finish(false));s.once('error',e=>finish(['EACCES','EPERM','ETIMEDOUT'].includes(e.code)));s.setTimeout(1500,()=>finish(false))});(async()=>{need(fs.readFileSync(path.join(f.target,'allowed'),'utf8')==='allowed');phase='write-target';fs.writeFileSync(path.join(f.target,'written'),'worker');phase='write-scratch';fs.writeFileSync(path.join(f.scratch,'written'),'scratch');phase='sentinel';need(denied(f.sentinel));phase='git-write';let gitDenied=false;try{fs.writeFileSync(path.join(f.target,'.git','guard'),'bad')}catch(e){gitDenied=['EACCES','EPERM'].includes(e.code)}need(gitDenied);phase='git-rename-delete';for(const operation of [()=>fs.renameSync(path.join(f.target,'.git'),path.join(f.target,'moved-git')),()=>fs.unlinkSync(path.join(f.target,'.git','guard'))]){let denied=false;try{operation()}catch(e){denied=['EACCES','EPERM'].includes(e.code)}need(denied)}phase='acl-write';const acl=cp.spawn(process.env.ComSpec,['/d','/q','/c','icacls ..\\\\target /grant *'+process.env.AUTOPROMPT_APP_CONTAINER_SID+':F /q > acl-result.txt 2>&1'],{cwd:f.scratch,stdio:'inherit'});const aclExit=await new Promise((ok,no)=>{acl.once('error',no);acl.once('exit',ok)});need(aclExit!==0);need(/Access is denied/i.test(fs.readFileSync(path.join(f.scratch,'acl-result.txt'),'utf8')));phase='descendant';const child=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),10000)'],{stdio:'inherit'});need(child.pid>0);let childError=false;child.on('error',()=>{childError=true});await new Promise(r=>setTimeout(r,100));phase='network';for(const e of f.endpoints)need(await request(e));phase='child-kill';const exit=new Promise(r=>child.once('exit',r));need(child.kill());await exit;need(!childError);process.stdout.write('APPCONTAINER_PROBE_PASS')})().catch(error=>{process.stderr.write('APPCONTAINER_PROBE_FAILURE:'+phase+':'+String(error.code||'CHECK'));process.exitCode=1})`
    const encoded = Buffer.from(source).toString('base64')
    const command = `node -e "eval(Buffer.from('${encoded}','base64').toString())"`
    const policy = { schemaVersion: 1, provider: 'claude', nestedDispatch: false, commandBoundary: true, externalWrites: false, targetPath: target, scratchPath: scratch,
      readableRoots: [target, scratch], writableRoots: [target, scratch], readOnly: false }
    phase = 'command-launch'
    const result = await runWindowsAppContainerCommand(policy, { command, cwd: target, timeoutMs: 15000 }, { controlRoot })
    phase = 'command-result'
    launcherSessionId = result.launcherSessionId; nativeExitCode = result.exitCode; probeFailure = { stdout: result.stdout.slice(0, 1024), stderr: result.stderr.slice(0, 1024) }
    if (result.status !== 'completed' || result.stdout !== 'APPCONTAINER_PROBE_PASS' || result.stderr || fs.readFileSync(path.join(target, '.git', 'guard'), 'utf8') !== 'controller git') throw new Error('NATIVE_PROBE_FAILED')
    phase = 'loopback-denial'
    for (const endpoint of endpoints) { if (endpoint.state.accepted !== 0) throw new Error('SANDBOX_CONNECTED'); await control(endpoint); if (endpoint.state.accepted !== 1) throw new Error('CONTROL_ACCEPT') }
    const supported = Object.freeze({ supported: true, backend: 'windows-appcontainer', runtimeSha256: key, launcherSessionId: result.launcherSessionId,
      networkProof: 'zero sandbox accepts between successful same-listener IPv4/IPv6 controller checks; bounded explicit socket denial', processCleanup: 'owned-job-drained' })
    cached = { key, result: supported }
    return supported
  } catch (error) {
    preserve = error.code === 'APPCONTAINER_CLEANUP_UNCONFIRMED' || Boolean(error.recovery && !error.recoveryResolved)
    return { supported: false, backend: 'windows-appcontainer', code: error.code || 'COMMAND_SANDBOX_UNSUPPORTED', diagnostic: failureDiagnostic(error, phase), launcherSessionId, nativeExitCode, probeFailure, ...(preserve ? { recoveryRoot: base } : {}) }
  } finally {
    for (const endpoint of endpoints) endpoint.server.close()
    if (!preserve) fs.rmSync(base, { recursive: true, force: true })
  }
}
module.exports = { probeWindowsAppContainer }
