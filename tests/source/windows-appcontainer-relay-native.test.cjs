'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')

test('native AppContainer inherited relay stdin is duplex and leaves host networking denied', { skip: process.platform !== 'win32', timeout: 300000 }, async t => {
  const admission = await require('../../agents/codex/workflow/windows-appcontainer-probe.js').probeWindowsAppContainer()
  assert.equal(admission.supported, true, JSON.stringify(admission))
  const safe = require('../../agents/codex/workflow/safe-run-root.js')
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-relay-native-')))
  safe.ensureWindowsPrivateAcl(base)
  let released = false, client, peer, server, host
  t.after(async () => {
    client?.destroy(); peer?.destroy()
    for (const listener of [server, host]) if (listener?.listening) await new Promise(resolve => listener.close(resolve))
    if (released) fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    else t.diagnostic(`Retained native relay evidence at ${base}`)
  })
  const directory = name => { const result = path.join(base, name); fs.mkdirSync(result); safe.ensureWindowsPrivateAcl(result); return result }
  const control = directory('control'), runtime = directory('runtime'), target = directory('target'), scratch = directory('scratch')
  let accepted = 0
  host = net.createServer(socket => { accepted++; socket.end() })
  await new Promise((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve) })
  const baseline = () => new Promise((resolve, reject) => { const socket = net.connect(host.address().port, '127.0.0.1'); socket.resume(); socket.once('error', reject); socket.once('close', resolve) })
  await baseline(); assert.equal(accepted, 1); accepted = 0
  const worker = path.join(runtime, 'relay-worker.cjs'), node = path.join(runtime, 'node.exe')
  fs.copyFileSync(process.execPath, node)
  const nonce = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(worker, `const net=require('node:net'),assert=require('node:assert/strict');
    const channel=new net.Socket({fd:0,readable:true,writable:true});let text='',phase=0;
    channel.on('error',e=>{process.stderr.write(String(e.stack));process.exitCode=5});
    channel.on('data',b=>{text+=b;for(;;){const n=text.indexOf('\\n');if(n<0)break;const line=text.slice(0,n);text=text.slice(n+1);
      if(phase===0){assert.equal(line,${JSON.stringify(nonce)});phase=1;channel.write('ACK:'+line+'\\n')}
      else{assert.equal(phase,1);assert.equal(line,'CONFIRMED');phase=2;const s=net.connect(${host.address().port},'127.0.0.1');
        s.once('connect',()=>{s.destroy();process.exit(3)});s.once('error',e=>{assert.ok(['EACCES','EPERM','ETIMEDOUT'].includes(e.code),e.code);channel.end('DONE\\n');process.stdout.write('RELAY_PASS')})}
    }});`, { flag: 'wx', mode: 0o600 })
  const deployment = require('../../agents/codex/workflow/windows-helper-deployment.js').stageWindowsHelperDeployment(control)
  const launcher = require('../../agents/codex/workflow/windows-appcontainer.js').createWindowsAppContainerLauncher({ deploymentRoot: deployment.root })
  const resources = require('../../agents/codex/workflow/windows-appcontainer-resources.js')
  const policy = { readOnly: false, targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [target, scratch] }
  const lease = await resources.prepareWindowsAppContainerResources({ policy, controlRoot: control, deploymentRoot: deployment.root,
    executableRoots: [{ path: runtime, kind: 'directory' }], verifyDrainEvidence: launcher.verifyDrainEvidence })
  const pipeName = `\\\\.\\pipe\\autoprompt-relay-${crypto.randomBytes(16).toString('hex')}`
  server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipeName, resolve) })
  await new Promise((resolve, reject) => { server.once('connection', socket => { peer = socket; resolve() }); client = net.createConnection(pipeName); client.once('error', reject) })
  let transcript = ''
  peer.on('data', bytes => {
    transcript += bytes
    if (transcript === `ACK:${nonce}\n`) peer.write('CONFIRMED\n')
    if (transcript === `ACK:${nonce}\nDONE\n`) peer.end()
  })
  const resultPromise = launcher.launch({ profileName: lease.profileName, profileSid: lease.profileSid,
    executable: node, executableSha256: crypto.createHash('sha256').update(fs.readFileSync(node)).digest('hex'),
    arguments: [worker], cwd: target, environment: Object.entries({ ...safe.windowsControllerEnvironment(process.env.SystemRoot), ...lease.environment, PATH: runtime }).map(([key, value]) => `${key}=${value}`),
    timeoutMs: 60000, outputLimit: 65536, cancellationPath: path.join(deployment.root, 'cancel'), relayStdin: true },
  { relayStdin: client, leaseId: lease.recovery.leaseId })
  // Only the peer writes. The inherited endpoint remains unread by the parent.
  peer.write(`${nonce}\n`)
  const result = await resultPromise
  await lease.release(result); released = true
  assert.equal(result.exitCode, 0, result.stderr.toString()); assert.equal(result.drained, true)
  assert.equal(result.profileSid, lease.profileSid)
  assert.equal(result.stdout.toString(), 'RELAY_PASS')
  assert.equal(transcript, `ACK:${nonce}\nDONE\n`)
  assert.equal(accepted, 0); await baseline(); assert.equal(accepted, 1)
  t.diagnostic(JSON.stringify({ architecture: process.arch, duplexRelay: true, hostNetworkDenied: true, drained: result.drained, profileSid: result.profileSid }))
  deployment.cleanup()
})
