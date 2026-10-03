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
const listen = (host, port = 0) => new Promise((resolve, reject) => {
  const server = net.createServer(socket => socket.destroy())
  server.once('error', reject)
  server.listen(port, host, () => resolve(server))
})
const close = server => new Promise(resolve => server.close(resolve))
const selectDualstackPort = async () => {
  for (let attempt = 0; attempt < 32; attempt++) {
    const v4 = await listen('0.0.0.0')
    const port = v4.address().port
    try {
      const v6 = await listen('::1', port)
      await close(v6); await close(v4)
      return port
    } catch (error) { await close(v4); if (attempt === 31) throw error }
  }
  throw new Error('could not select a dual-stack loopback port')
}
const seatbeltProfile = (executable, port) => [
  '(version 1)', '(deny default)',
  '(allow file-read-data (literal "/"))',
  `(allow process-exec (literal ${JSON.stringify(executable)}))`,
  `(allow file-read* (literal ${JSON.stringify(executable)}))`,
  '(allow file-read* (subpath "/System"))', '(allow file-read* (subpath "/usr/lib"))',
  `(allow network-outbound (remote ip ${JSON.stringify(`localhost:${port}`)}))`,
].join('\n')
const socketXml = ({ label, executable, ready, port }) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${executable}</string><string>autoprompt.v4</string><string>autoprompt.v6</string><string>${ready}</string><string>${port}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>Sockets</key><dict><key>autoprompt.v4</key><dict><key>SockNodeName</key><string>0.0.0.0</string><key>SockServiceName</key><string>${port}</string><key>SockFamily</key><string>IPv4</string><key>SockType</key><string>stream</string><key>SockProtocol</key><string>TCP</string></dict><key>autoprompt.v6</key><dict><key>SockNodeName</key><string>::1</string><key>SockServiceName</key><string>${port}</string><key>SockFamily</key><string>IPv6</string><key>SockType</key><string>stream</string><key>SockProtocol</key><string>TCP</string></dict></dict></dict></plist>`
const assertAddressInUse = (host, port) => {
  const script = `require('node:net').createServer().once('error',e=>process.exit(e.code==='EADDRINUSE'?0:2)).listen(${port},${JSON.stringify(host)})`
  const result = command(process.execPath, ['-e', script]); assert.equal(result.status, 0, result.stderr)
}
const assertRebinds = (host, port) => {
  const script = `const s=require('node:net').createServer();s.listen(${port},${JSON.stringify(host)},()=>s.close(()=>process.exit(0)));s.once('error',()=>process.exit(2))`
  const result = command(process.execPath, ['-e', script]); assert.equal(result.status, 0, result.stderr)
}

test('Darwin launchd socket activation retains an exact loopback listener through worker death until owned bootout', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-launchd-socket-')))
  const executable = path.join(root, 'socket-owner'), ready = path.join(root, 'ready.json')
  const uid = process.getuid(), label = `com.autoprompt.socket.${process.pid}.${crypto.randomBytes(6).toString('hex')}`, domain = `gui/${uid}`
  const plist = path.join(root, 'job.plist')
  const port = await selectDualstackPort()
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
  // A collision after temporary selection is fail-closed: launchd gives the
  // worker neither descriptor and it cannot publish the capability receipt.
  const conflictLabel = `${label}.conflict`, conflictReady = path.join(root, 'conflict-ready.json'), conflictPlist = path.join(root, 'conflict.plist')
  fs.writeFileSync(conflictPlist, socketXml({ label: conflictLabel, executable, ready: conflictReady, port }), { mode: 0o600 })
  const blocker = await listen('127.0.0.1', port)
  try {
    // launchctl can accept the job and then fail its socket setup. Receipt
    // absence, rather than bootstrap's exit status, is the capability gate.
    command('/bin/launchctl', ['bootstrap', domain, conflictPlist])
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(fs.existsSync(conflictReady), false, 'conflicted launchd job issued a socket capability receipt')
  } finally {
    command('/bin/launchctl', ['bootout', `${domain}/${conflictLabel}`])
    await close(blocker)
  }
  fs.writeFileSync(plist, socketXml({ label, executable, ready, port }), { mode: 0o600 })
  const boot = command('/bin/launchctl', ['bootstrap', domain, plist]); assert.equal(boot.status, 0, boot.stderr); bootstrapped = true
  await waitFor(() => fs.existsSync(ready), 30000, 'launchd socket worker did not publish readiness')
  const value = JSON.parse(fs.readFileSync(ready, 'utf8')); assert.ok(Number.isInteger(value.pid) && value.pid > 0); assert.equal(value.port, port)
  const listeners = []
  t.after(async () => { for (const listener of listeners) await close(listener) })
  const other = await listen('127.0.0.1'); listeners.push(other)
  const ipv6Other = await listen('::1'); listeners.push(ipv6Other)
  // Seatbelt localhost covers the IPv4 loopback range. A wildcard listener
  // must own this port on every IPv4 address, including configured aliases.
  assertAddressInUse('127.0.0.2', port)
  const profile = seatbeltProfile(executable, port)
  const probe = (mode, host, port) => command('/usr/bin/sandbox-exec', ['-p', profile, executable, mode, host, String(port)])
  const unsandboxed = (mode, host, port) => command(executable, [mode, host, String(port)])
  const contested = unsandboxed('bind4-reuse', '127.0.0.2', port)
  assert.equal(contested.status, 78, `wildcard listener permits a competing reusable alias socket: ${contested.stderr}`)
  for (const [mode, host, probePort] of [
    ['connect4', '127.0.0.1', port], ['connect6', '::1', port], ['connect4', '127.0.0.2', port],
    ['connect4', '127.0.0.1', other.address().port], ['connect6', '::1', ipv6Other.address().port], ['bind4', '127.0.0.1', 0],
  ]) assert.equal(unsandboxed(mode, host, probePort).status, 0, `unsandboxed ${mode} could not exercise ${host}:${probePort}`)
  const permitted4 = probe('connect4', '127.0.0.1', port); assert.equal(permitted4.status, 0, permitted4.stderr)
  const permitted6 = probe('connect6', '::1', port); assert.equal(permitted6.status, 0, permitted6.stderr)
  const permittedAlias = probe('connect4', '127.0.0.2', port)
  assert.equal(permittedAlias.status, 0, permittedAlias.stderr)
  const wrongPort = probe('connect4', '127.0.0.1', other.address().port)
  assert.equal(wrongPort.status, 77, `Seatbelt did not deny the non-authenticated IPv4 port: ${wrongPort.stderr}`)
  const ipv6Denied = probe('connect6', '::1', ipv6Other.address().port)
  assert.equal(ipv6Denied.status, 77, `Seatbelt did not deny the IPv6 endpoint: ${ipv6Denied.stderr}`)
  const bindDenied = probe('bind4', '127.0.0.1', 0)
  assert.equal(bindDenied.status, 77, `Seatbelt did not deny listener creation: ${bindDenied.stderr}`)
  for (const [mode, host, probePort] of [
    ['connect4', '127.0.0.1', port], ['connect6', '::1', port], ['connect4', '127.0.0.2', port],
    ['connect4', '127.0.0.1', other.address().port], ['connect6', '::1', ipv6Other.address().port], ['bind4', '127.0.0.1', 0],
  ]) assert.equal(unsandboxed(mode, host, probePort).status, 0, `post-probe unsandboxed ${mode} could not exercise ${host}:${probePort}`)
  process.kill(value.pid, 'SIGKILL')
  await waitFor(() => command('/bin/kill', ['-0', String(value.pid)]).status !== 0, 10000, 'socket worker survived SIGKILL')
  assertAddressInUse('127.0.0.1', port); assertAddressInUse('127.0.0.2', port); assertAddressInUse('::1', port)
  const retained = unsandboxed('bind4-reuse', '127.0.0.2', port)
  assert.equal(retained.status, 78, `worker death released the alias endpoint: ${retained.stderr}`)
  const down = bootout(); assert.equal(down.status, 0, down.stderr); bootstrapped = false
  assertRebinds('127.0.0.1', port); assertRebinds('127.0.0.2', port); assertRebinds('::1', port)
})

test('Darwin launchd socket diagnostic renders one exact dual-stack listener contract', async () => {
  const port = await selectDualstackPort()
  const profile = seatbeltProfile('/private/test/socket-owner', port)
  const xml = socketXml({ label: 'com.autoprompt.socket.test', executable: '/private/test/socket-owner', ready: '/private/test/ready.json', port })
  assert.match(profile, new RegExp(`localhost:${port}`))
  assert.match(xml, new RegExp(`<string>0\\.0\\.0\\.0</string><key>SockServiceName</key><string>${port}</string><key>SockFamily</key><string>IPv4</string>`))
  assert.match(xml, new RegExp(`<string>::1</string><key>SockServiceName</key><string>${port}</string><key>SockFamily</key><string>IPv6</string>`))
})
