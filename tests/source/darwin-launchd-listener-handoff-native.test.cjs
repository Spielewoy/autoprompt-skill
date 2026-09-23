'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')
const SOURCE = path.join(ROOT, 'tests/helpers/darwin-launchd-listener-handoff.c')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value)
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const command = (file, args) => cp.spawnSync(file, args, { shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
const waitFor = async (predicate, timeout, message) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)) }; throw new Error(message) }
const reservePort = host => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, host, () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) }) })
const request = (port, text) => new Promise((resolve, reject) => { const socket = net.createConnection(port, '::1'); let value = ''; socket.setEncoding('utf8'); socket.setTimeout(10000, () => socket.destroy(new Error('listener timed out'))); socket.once('connect', () => socket.end(text)); socket.on('data', chunk => { value += chunk }); socket.once('error', reject); socket.once('close', hadError => { if (!hadError) resolve(value) }) })
const trigger = port => new Promise(resolve => { const socket = net.createConnection(port, '::1'); const done = outcome => { socket.destroy(); resolve(outcome) }; socket.setTimeout(2000, () => done('timeout')); socket.once('connect', () => done('connected')); socket.once('error', error => done(error.code || 'error')) })
const bind = (port, expectBusy) => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', error => expectBusy && error.code === 'EADDRINUSE' ? resolve(null) : reject(error))
  server.listen({ host: '::1', port, ipv6Only: true }, () => {
    if (expectBusy) { server.close(); reject(new Error(`listener ${port} was unexpectedly bindable`)); return }
    resolve(server)
  })
})

function plist({ label, wrapper, modelPort, mcpPort, node, script, requestPath, stdout, stderr }) {
  const args = [wrapper, String(modelPort), String(mcpPort), node, script, requestPath]
  const socket = (name, port) => `<key>${name}</key><dict><key>SockNodeName</key><string>::1</string><key>SockServiceName</key><string>${port}</string><key>SockFamily</key><string>IPv6</string><key>SockType</key><string>stream</string><key>SockProtocol</key><string>TCP</string></dict>`
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>LaunchOnlyOnce</key><true/><key>StandardOutPath</key><string>${xml(stdout)}</string><key>StandardErrorPath</key><string>${xml(stderr)}</string><key>Sockets</key><dict>${socket('autoprompt.model', modelPort)}${socket('autoprompt.mcp', mcpPort)}</dict></dict></plist>`
}

test('Darwin launchd wrapper hands two exact IPv6 listeners to fixed descriptors', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join('/private/tmp', 'ap-fd-handoff-')))
  fs.chmodSync(root, 0o700)
  const wrapper = path.join(root, 'listener-handoff'), script = path.join(root, 'job.cjs'), requestPath = path.join(root, 'request.json')
  const ready = path.join(root, 'ready.json'), startupMarker = path.join(root, 'startup-marker.json'), startupAttempts = path.join(root, 'startup-attempts.log')
  const stdout = path.join(root, 'stdout.log'), stderr = path.join(root, 'stderr.log')
  const plistPath = path.join(root, 'job.plist'), domain = `gui/${process.getuid()}`
  const label = `com.autoprompt.listenerhandoff.${process.pid}.${crypto.randomBytes(6).toString('hex')}`
  let submitted = false
  const launchctl = args => command('/bin/launchctl', args)
  t.after(() => {
    if (submitted) launchctl(['bootout', `${domain}/${label}`])
    const absent = launchctl(['print', `${domain}/${label}`])
    assert.ok(absent.status === 113 && /Could not find service/.test(absent.stderr), `launchd listener cleanup is unconfirmed: ${absent.stderr}`)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const sdk = command('/usr/bin/xcrun', ['--show-sdk-path']); assert.equal(sdk.status, 0, sdk.stderr)
  const build = command('/usr/bin/clang', ['-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', SOURCE, '-o', wrapper])
  assert.equal(build.status, 0, build.stderr)
  const node = fs.realpathSync.native(process.execPath)
  if (process.env.AUTOPROMPT_DARWIN_LISTENER_HANDOFF_EVIDENCE) {
    const evidencePath = path.resolve(process.env.AUTOPROMPT_DARWIN_LISTENER_HANDOFF_EVIDENCE)
    const binaryPath = path.join(path.dirname(evidencePath), 'darwin-launchd-listener-handoff')
    fs.copyFileSync(wrapper, binaryPath, fs.constants.COPYFILE_EXCL)
    fs.writeFileSync(evidencePath, `${JSON.stringify({ schemaVersion: 1, platform: process.platform, architecture: process.arch,
      deploymentTarget: '13.5', sourceSha256: sha256(fs.readFileSync(SOURCE)), binarySha256: sha256(fs.readFileSync(binaryPath)),
      node: { path: node, sha256: sha256(fs.readFileSync(node)) }, socketNames: ['autoprompt.model', 'autoprompt.mcp'], inheritedDescriptors: [3, 4] })}\n`, { flag: 'wx', mode: 0o600 })
  }
  const modelPort = await reservePort('::1'), mcpPort = await reservePort('::1')
  assert.notEqual(modelPort, mcpPort)
  const body = { schemaVersion: 1, sockets: { model: { name: 'autoprompt.model', fd: 3, host: '::1', port: modelPort }, mcp: { name: 'autoprompt.mcp', fd: 4, host: '::1', port: mcpPort } }, node: { path: node, sha256: sha256(fs.readFileSync(node)) } }
  body.checksum = sha256(stable(body))
  fs.writeFileSync(requestPath, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(script, String.raw`'use strict'
const crypto=require('node:crypto'),fs=require('node:fs'),net=require('node:net'),path=require('node:path')
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v)
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
if(process.argv.length!==4||process.argv[2]!=='--job')process.exit(64)
const request=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),copy={...request};delete copy.checksum
if(request.checksum!==hash(stable(copy))||request.node.path!==fs.realpathSync.native(process.execPath)||request.node.sha256!==hash(fs.readFileSync(process.execPath)))process.exit(65)
fs.appendFileSync(${JSON.stringify(startupAttempts)},String(process.pid)+'\n',{encoding:'utf8',mode:0o600})
fs.writeFileSync(${JSON.stringify(startupMarker)},JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600})
const servers=[]
for(const key of ['model','mcp']){const item=request.sockets[key];if(item.name!=='autoprompt.'+key||item.fd!==(key==='model'?3:4)||item.host!=='::1')process.exit(66);const server=net.createServer(socket=>socket.end(key+'\n'));server.listen({fd:item.fd,exclusive:true});servers.push([key,item,server])}
Promise.all(servers.map(([key,item,server])=>new Promise((resolve,reject)=>{server.once('error',reject);server.once('listening',()=>{const address=server.address();if(address.address!=='::1'||address.family!=='IPv6'||address.port!==item.port)return reject(new Error('listener mismatch'));resolve()})}))).then(()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,ports:servers.map(([,item])=>item.port)}),{flag:'wx',mode:0o600})).catch(()=>process.exit(67))
`, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(plistPath, plist({ label, wrapper, modelPort, mcpPort, node, script, requestPath, stdout, stderr }), { flag: 'wx', mode: 0o600 })
  submitted = true
  const bootstrap = launchctl(['bootstrap', domain, plistPath]); assert.equal(bootstrap.status, 0, bootstrap.stderr)
  const receipt = await waitFor(() => fs.existsSync(ready) && JSON.parse(fs.readFileSync(ready, 'utf8')), 30000,
    `listener handoff did not become ready: ${fs.existsSync(stderr) ? fs.readFileSync(stderr, 'utf8').slice(-2048) : ''}`)
  assert.deepEqual(receipt.ports, [modelPort, mcpPort])
  assert.equal(await request(modelPort, 'model'), 'model\n')
  assert.equal(await request(mcpPort, 'mcp'), 'mcp\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(startupMarker, 'utf8')), { pid: receipt.pid })
  assert.deepEqual(fs.readFileSync(startupAttempts, 'utf8').trim().split('\n'), [String(receipt.pid)])
  process.kill(receipt.pid, 'SIGKILL')
  await waitFor(() => command('/bin/kill', ['-0', String(receipt.pid)]).status !== 0, 10000, 'launchd listener root survived SIGKILL')
  const retainedService = launchctl(['print', `${domain}/${label}`]); assert.equal(retainedService.status, 0, retainedService.stderr)
  await bind(modelPort, true); await bind(mcpPort, true)
  const triggered = await Promise.all([trigger(modelPort), trigger(mcpPort)])
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.deepEqual(fs.readFileSync(startupAttempts, 'utf8').trim().split('\n'), [String(receipt.pid)],
    `LaunchOnlyOnce admitted another worker after socket activity: ${JSON.stringify(triggered)}`)
  assert.deepEqual(JSON.parse(fs.readFileSync(startupMarker, 'utf8')), { pid: receipt.pid })
  const bootout = launchctl(['bootout', `${domain}/${label}`]); assert.equal(bootout.status, 0, bootout.stderr)
  await waitFor(() => { const absent = launchctl(['print', `${domain}/${label}`]); return absent.status === 113 && /Could not find service/.test(absent.stderr) }, 10000,
    'launchd listener service remained after exact bootout')
  submitted = false
  const released = await Promise.all([bind(modelPort, false), bind(mcpPort, false)])
  for (const server of released) await new Promise(resolve => server.close(resolve))
})

test('Darwin listener handoff source fixes socket keys and publishes only FD3 and FD4', () => {
  const source = fs.readFileSync(SOURCE, 'utf8')
  assert.match(source, /"autoprompt\.model"/)
  assert.match(source, /"autoprompt\.mcp"/)
  assert.match(source, /dup2\(model_copy, 3\)/)
  assert.match(source, /dup2\(mcp_copy, 4\)/)
  assert.match(source, /closefrom\(5\)/)
  assert.match(plist({ label: 'com.autoprompt.test', wrapper: '/private/w', modelPort: 1, mcpPort: 2, node: '/private/n', script: '/private/s', requestPath: '/private/r', stdout: '/private/o', stderr: '/private/e' }), /<key>LaunchOnlyOnce<\/key><true\/>/)
})
