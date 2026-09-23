'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { runWindowsAppContainerCommand } = require('../../agents/codex/workflow/windows-appcontainer-command.js')
const { privateDirectory, nodeCommand } = require('../helpers/native-platform.cjs')

const options = { skip: process.platform !== 'win32' ? 'Windows AppContainer loopback proof requires Windows' : false, timeout: 180000 }

test('zero-capability AppContainer permits same-container loopback but denies controller loopback', options, async t => {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'appcontainer-loopback-proof-')))
  const target = privateDirectory(path.join(root, 'target'))
  const scratch = privateDirectory(path.join(root, 'scratch'))
  const controlRoot = privateDirectory(path.join(root, 'control'))
  const host = net.createServer(socket => { host.accepted++; socket.destroy() })
  host.accepted = 0
  await new Promise((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { await new Promise(resolve => host.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) })
  const baseline = () => new Promise((resolve, reject) => {
    const socket = net.connect(host.address().port, '127.0.0.1')
    socket.once('error', reject)
    socket.once('close', resolve)
    socket.resume()
  })
  await baseline()
  assert.equal(host.accepted, 1, 'controller baseline could not reach its loopback listener')
  host.accepted = 0

  const hostPort = host.address().port
  const source = `const net=require('node:net'),cp=require('node:child_process');const hostPort=${hostPort};const result={inner:false,outerDenied:false,errors:[]};const fail=e=>{result.errors.push(String(e&&e.code||e&&e.message||e).slice(0,128));process.stdout.write(JSON.stringify(result));process.exit(23)};const inner=net.createServer(s=>s.end('inner'));inner.once('error',fail);inner.listen(0,'127.0.0.1',()=>{const port=inner.address().port;const child=cp.spawn(process.execPath,['-e',\"const net=require('node:net');const s=net.connect(Number(process.argv[1]),'127.0.0.1');s.resume();s.once('connect',()=>{process.stdout.write('INNER_OK');s.end()});s.once('error',e=>process.exit(e.code==='EACCES'||e.code==='EPERM'?21:22))\",String(port)],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>{out+=b});child.stderr.on('data',b=>{err+=b});child.once('error',fail);child.once('close',code=>{result.inner=code===0&&out==='INNER_OK';if(!result.inner){result.errors.push(('child:'+err).slice(-128));return fail(new Error('INNER_LOOPBACK_FAILED'))}inner.close(()=>{const s=net.connect(hostPort,'127.0.0.1');s.once('connect',()=>{result.outerDenied=false;s.destroy();fail(new Error('OUTER_LOOPBACK_REACHED'))});s.once('error',e=>{if(e.code!=='EACCES'&&e.code!=='EPERM')return fail(e);result.outerDenied=true;process.stdout.write(JSON.stringify(result));process.exit(0)})})})});`
  const command = nodeCommand(source)
  const policy = { provider: 'claude', schemaVersion: 1, readOnly: false, targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [target, scratch] }
  const result = await runWindowsAppContainerCommand(policy, { command, cwd: target, timeoutMs: 60000 }, { controlRoot })
  const text = result.stdout.trim()
  let proof
  try { proof = JSON.parse(text) } catch { proof = null }
  const evidence = { platform: process.platform, architecture: process.arch, node: process.version, backend: 'windows-appcontainer', workerIdentity: result.workerIdentity || null, launcherSessionId: result.launcherSessionId || null, innerLoopback: proof?.inner === true, outerDenied: proof?.outerDenied === true, hostAccepted: host.accepted, exitCode: result.exitCode, stdout: text.slice(-2048), stderr: result.stderr.slice(-2048) }
  console.error(JSON.stringify({ loopbackEvidence: evidence }))
  const sandboxAccepts = host.accepted
  await baseline()
  assert.equal(host.accepted, sandboxAccepts + 1, 'controller listener stopped accepting after the sandbox probe')
  assert.equal(result.status, 'completed', JSON.stringify(evidence))
  assert.deepEqual(proof, { inner: true, outerDenied: true, errors: [] }, JSON.stringify(evidence))
  assert.equal(sandboxAccepts, 0, JSON.stringify(evidence))
})
