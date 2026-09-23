'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

async function endpoint(host) {
  const state = { accepted: 0 }
  const server = net.createServer(socket => { state.accepted++; socket.end() })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  return { server, state, host, port: server.address().port }
}
async function control(item) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: item.host, port: item.port })
    socket.once('error', reject); socket.once('close', resolve)
    socket.setTimeout(2000, () => socket.destroy(new Error('CONTROL_TIMEOUT')))
  })
}
async function probeDarwinCommandSandbox() {
  if (process.platform !== 'darwin') return { supported: false, backend: 'darwin-seatbelt-coalition', code: 'COMMAND_SANDBOX_UNSUPPORTED' }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-darwin-probe-')))
  fs.chmodSync(root, 0o700)
  const directories = Object.fromEntries(['control', 'target', 'scratch', 'private'].map(name => {
    const directory = path.join(root, name); fs.mkdirSync(directory, { mode: 0o700 }); return [name, directory]
  }))
  const listeners = []
  let backend, result, cleanupFailure
  const challenge = crypto.randomBytes(24).toString('hex')
  try {
    for (const host of ['127.0.0.1', '::1']) listeners.push(await endpoint(host))
    for (const item of listeners) { await control(item); assert.equal(item.state.accepted, 1); item.state.accepted = 0 }
    const candidate = path.join(directories.target, 'candidate'), secret = path.join(directories.private, 'secret')
    fs.writeFileSync(candidate, challenge); fs.writeFileSync(secret, challenge)
    const git = path.join(directories.target, '.git'); fs.mkdirSync(git, { mode: 0o700 })
    const guard = path.join(git, 'guard'); fs.writeFileSync(guard, challenge)
    const policy = { provider: 'claude', readOnly: true, targetPath: directories.target, scratchPath: directories.scratch,
      readableRoots: [directories.target, directories.scratch], writableRoots: [directories.scratch],
      nestedDispatch: false, commandBoundary: true, externalWrites: false }
    backend = require('./darwin-command-sandbox.cjs').createDarwinCommandSandbox({ controlRoot: directories.control })
    const source = `const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net');
      (async()=>{assert.equal(fs.readFileSync(${JSON.stringify(candidate)},'utf8'),${JSON.stringify(challenge)});
      fs.writeFileSync(${JSON.stringify(path.join(directories.scratch, 'result'))},${JSON.stringify(challenge)});
      for(const f of [()=>fs.readFileSync(${JSON.stringify(secret)}),()=>fs.writeFileSync(${JSON.stringify(candidate)},'changed')]) assert.throws(f,e=>['EACCES','EPERM'].includes(e.code));
      for(const target of ${JSON.stringify(listeners.map(({ host, port }) => ({ host, port })))}) await new Promise((resolve,reject)=>{
        const s=net.connect(target);s.once('connect',()=>{s.destroy();reject(new Error('NETWORK_ALLOWED'))});
        s.once('error',e=>['EACCES','EPERM'].includes(e.code)?resolve():reject(e));
        s.setTimeout(2000,()=>s.destroy(new Error('NETWORK_DENIAL_UNPROVEN')));
      });process.stdout.write(${JSON.stringify(challenge)});})().catch(e=>{process.stderr.write(String(e.stack));process.exitCode=1})`
    const command = text => `node -e "eval(Buffer.from('${Buffer.from(text).toString('base64')}','base64').toString('utf8'))"`
    const execution = await backend.command(policy, { command: command(source), cwd: directories.scratch, timeoutMs: 15000 })
    assert.equal(execution.status, 'completed', execution.stderr); assert.equal(execution.stdout, challenge); assert.equal(execution.stderr, '')
    assert.equal(fs.readFileSync(candidate, 'utf8'), challenge)
    assert.equal(fs.readFileSync(path.join(directories.scratch, 'result'), 'utf8'), challenge)
    const writable = { ...policy, readOnly: false, writableRoots: [directories.target, directories.scratch] }
    const gitResult = await backend.command(writable, { command: command(`const fs=require('node:fs'),assert=require('node:assert/strict');assert.throws(()=>fs.writeFileSync(${JSON.stringify(guard)},'changed'),e=>['EACCES','EPERM'].includes(e.code))`), cwd: directories.target, timeoutMs: 10000 })
    assert.equal(gitResult.status, 'completed', gitResult.stderr); assert.equal(fs.readFileSync(guard, 'utf8'), challenge)
    for (const item of listeners) { assert.equal(item.state.accepted, 0); await control(item); assert.equal(item.state.accepted, 1) }
    await backend.processOwner.assertDrained()
    result = { supported: true, backend: backend.backend, helperSha256: backend.helper.sha256,
      sandboxSha256: backend.sandboxBinding.sha256, processCleanup: 'kernel-coalition-drained',
      networkProof: 'explicit IPv4/IPv6 socket denial between live same-listener controls', gitGuard: 'UNCHANGED' }
  } catch (error) {
    result = { supported: false, backend: 'darwin-seatbelt-coalition', code: error.code || 'COMMAND_SANDBOX_UNSUPPORTED', reason: String(error.message).slice(0, 2048) }
  } finally {
    if (backend) {
      try { await backend.processOwner.cancelAll({ reason: 'Darwin admission probe cleanup', graceMs: 100, killMs: 2000, waitForPending: true }); await backend.processOwner.assertDrained() }
      catch (error) { cleanupFailure = error }
    }
    for (const item of listeners) await new Promise(resolve => item.server.close(resolve))
    if (!cleanupFailure) fs.rmSync(root, { recursive: true, force: true })
  }
  if (cleanupFailure) return { supported: false, backend: 'darwin-seatbelt-coalition', code: 'PROCESS_DRAIN_TIMEOUT', recoveryRoot: root }
  return result
}

module.exports = { probeDarwinCommandSandbox }
