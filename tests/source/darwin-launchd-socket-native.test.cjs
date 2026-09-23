'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const net = require('node:net')

const ROOT = path.resolve(__dirname, '../..')
const SOURCE = path.join(ROOT, 'tests/helpers/darwin-launchd-socket-owner.c')
const waitFor = async (predicate, ms, text) => { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }; throw new Error(text) }
const command = (file, args) => cp.spawnSync(file, args, { encoding: 'utf8', timeout: 30000 })
const listen = host => new Promise((resolve, reject) => {
  const server = net.createServer(socket => socket.destroy())
  server.once('error', reject)
  server.listen(0, host, () => resolve(server))
})
const close = server => new Promise(resolve => server.close(resolve))
const seatbeltProfile = (executable, port) => [
  '(version 1)', '(deny default)',
  '(allow file-read-data (literal "/"))',
  `(allow process-exec (literal ${JSON.stringify(executable)}))`,
  `(allow file-read* (literal ${JSON.stringify(executable)}))`,
  '(allow file-read* (subpath "/System"))', '(allow file-read* (subpath "/usr/lib"))',
  `(allow network-outbound (remote ip ${JSON.stringify(`127.0.0.1:${port}`)}))`,
].join('\n')

test('Darwin launchd socket activation retains an exact loopback listener through worker death until owned bootout', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-launchd-socket-')))
  const executable = path.join(root, 'socket-owner'), ready = path.join(root, 'ready.json')
  const uid = process.getuid(), label = `com.autoprompt.socket.${process.pid}.${crypto.randomBytes(6).toString('hex')}`, domain = `gui/${uid}`
  const plist = path.join(root, 'job.plist')
  const bootout = () => command('/bin/launchctl', ['bootout', `${domain}/${label}`])
  let bootstrapped = false
  t.after(() => {
    if (bootstrapped) {
      let down = bootout()
      // A timed-out launchctl client must never cause us to delete the private
      // control directory while its launchd service remains registered.
      if (down.status !== 0) down = bootout()
      assert.equal(down.status, 0, `launchd cleanup did not boot out ${domain}/${label}: ${down.stderr}`)
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const sdk = command('/usr/bin/xcrun', ['--show-sdk-path']); assert.equal(sdk.status, 0, sdk.stderr)
  const build = command('/usr/bin/clang', ['-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5', '-Wall', '-Werror', SOURCE, '-o', executable]); assert.equal(build.status, 0, build.stderr)
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${executable}</string><string>autoprompt.listener</string><string>${ready}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>Sockets</key><dict><key>autoprompt.listener</key><dict><key>SockNodeName</key><string>127.0.0.1</string><key>SockServiceName</key><string>0</string><key>SockFamily</key><string>IPv4</string><key>SockType</key><string>stream</string></dict></dict></dict></plist>`
  fs.writeFileSync(plist, xml, { mode: 0o600 })
  const boot = command('/bin/launchctl', ['bootstrap', domain, plist]); assert.equal(boot.status, 0, boot.stderr); bootstrapped = true
  await waitFor(() => fs.existsSync(ready), 30000, 'launchd socket worker did not publish readiness')
  const value = JSON.parse(fs.readFileSync(ready, 'utf8')); assert.ok(Number.isInteger(value.pid) && value.pid > 0); assert.ok(Number.isInteger(value.port) && value.port > 0)
  const other = await listen('127.0.0.1'), ipv6 = await listen('::1')
  t.after(async () => { await close(other); await close(ipv6) })
  const profile = seatbeltProfile(executable, value.port)
  const probe = (mode, host, port) => command('/usr/bin/sandbox-exec', ['-p', profile, executable, mode, host, String(port)])
  const unsandboxed = (mode, host, port) => command(executable, [mode, host, String(port)])
  for (const [mode, host, port] of [
    ['connect4', '127.0.0.1', value.port], ['connect4', '127.0.0.1', other.address().port],
    ['connect6', '::1', ipv6.address().port], ['bind4', '127.0.0.1', 0],
  ]) assert.equal(unsandboxed(mode, host, port).status, 0, `unsandboxed ${mode} could not exercise ${host}:${port}`)
  const permitted = probe('connect4', '127.0.0.1', value.port)
  assert.equal(permitted.status, 0, permitted.stderr)
  const wrongPort = probe('connect4', '127.0.0.1', other.address().port)
  assert.equal(wrongPort.status, 77, `Seatbelt did not deny the non-authenticated IPv4 port: ${wrongPort.stderr}`)
  const ipv6Denied = probe('connect6', '::1', ipv6.address().port)
  assert.equal(ipv6Denied.status, 77, `Seatbelt did not deny the IPv6 endpoint: ${ipv6Denied.stderr}`)
  const bindDenied = probe('bind4', '127.0.0.1', 0)
  assert.equal(bindDenied.status, 77, `Seatbelt did not deny listener creation: ${bindDenied.stderr}`)
  for (const [mode, host, port] of [
    ['connect4', '127.0.0.1', value.port], ['connect4', '127.0.0.1', other.address().port],
    ['connect6', '::1', ipv6.address().port], ['bind4', '127.0.0.1', 0],
  ]) assert.equal(unsandboxed(mode, host, port).status, 0, `post-probe unsandboxed ${mode} could not exercise ${host}:${port}`)
  process.kill(value.pid, 'SIGKILL')
  await waitFor(() => command('/bin/kill', ['-0', String(value.pid)]).status !== 0, 10000, 'socket worker survived SIGKILL')
  const bind = command(process.execPath, ['-e', `require('node:net').createServer().once('error',e=>process.exit(e.code==='EADDRINUSE'?0:2)).listen(${value.port},'127.0.0.1')`]); assert.equal(bind.status, 0, bind.stderr)
  const down = bootout(); assert.equal(down.status, 0, down.stderr); bootstrapped = false
  const rebound = command(process.execPath, ['-e', `const s=require('node:net').createServer();s.listen(${value.port},'127.0.0.1',()=>s.close(()=>process.exit(0)));s.once('error',()=>process.exit(2))`]); assert.equal(rebound.status, 0, rebound.stderr)
})
