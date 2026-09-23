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

// Diagnostic only: permit TCP over IPv6 to ::1, excluding every IPv4
// loopback alias and mapped-address spelling. No production admission yet.
const profile = (executable, port) => [
  '(version 1)', '(deny default)', '(allow file-read-data (literal "/"))',
  `(allow process-exec (literal ${JSON.stringify(executable)}))`,
  `(allow file-read* (literal ${JSON.stringify(executable)}))`,
  '(allow file-read* (subpath "/System"))', '(allow file-read* (subpath "/usr/lib"))',
  `(allow network-outbound (remote tcp6 ${JSON.stringify(`localhost:${port}`)}))`,
].join('\n')
const xml = ({ label, executable, ready, port }) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${executable}</string><string>--ipv6-only</string><string>autoprompt.v6</string><string>${ready}</string><string>${port}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardErrorPath</key><string>${ready}.stderr</string><key>Sockets</key><dict><key>autoprompt.v6</key><dict><key>SockNodeName</key><string>::1</string><key>SockServiceName</key><string>${port}</string><key>SockFamily</key><string>IPv6</string><key>SockType</key><string>stream</string><key>SockProtocol</key><string>TCP</string></dict></dict></dict></plist>`

test('Darwin IPv6-only TCP admission denies IPv4 aliases and preserves listener ownership after worker death', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-launchd-v6-')))
  const executable = path.join(root, 'socket-owner'), ready = path.join(root, 'ready.json')
  const label = `com.autoprompt.socket6.${process.pid}.${crypto.randomBytes(6).toString('hex')}`, domain = `gui/${process.getuid()}`
  const activeLabels = new Set(), listeners = []
  const bootout = name => {
    let result = command('/bin/launchctl', ['bootout', `${domain}/${name}`])
    if (result.status !== 0) {
      const absent = command('/bin/launchctl', ['print', `${domain}/${name}`])
      assert.ok(absent.status === 113 && /Could not find service/.test(absent.stderr), `launchd cleanup uncertain: ${result.stderr}; ${absent.stderr}`)
    }
    activeLabels.delete(name)
  }
  t.after(async () => {
    const failures = []
    for (const name of [...activeLabels]) { try { bootout(name) } catch (error) { failures.push(error) } }
    for (const server of listeners) { try { await close(server) } catch (error) { failures.push(error) } }
    if (!activeLabels.size) fs.rmSync(root, { recursive: true, force: true })
    if (failures.length) throw new AggregateError(failures, 'IPv6 diagnostic cleanup failed; uncertain launchd state retained')
  })
  const sdk = command('/usr/bin/xcrun', ['--show-sdk-path']); assert.equal(sdk.status, 0, sdk.stderr)
  const build = command('/usr/bin/clang', ['-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5', '-Wall', '-Werror', SOURCE, '-o', executable]); assert.equal(build.status, 0, build.stderr)
  const blocker = await listen('::1'), port = blocker.address().port
  const boot = (name, receipt) => {
    const plist = path.join(root, `${name}.plist`)
    fs.writeFileSync(plist, xml({ label: name, executable, ready: receipt, port }), { mode: 0o600 })
    // Keep exact cleanup authority even if the client times out after submit.
    activeLabels.add(name)
    return command('/bin/launchctl', ['bootstrap', domain, plist])
  }
  try {
    const name = `${label}.conflict`, receipt = path.join(root, 'conflict.json')
    const result = boot(name, receipt); assert.equal(result.status, 0, result.stderr)
    const kick = command('/bin/launchctl', ['kickstart', '-kp', `${domain}/${name}`])
    t.diagnostic(JSON.stringify({ collisionKickstartStatus: kick.status, stderr: kick.stderr.slice(-1024) }))
    await waitFor(() => fs.existsSync(`${receipt}.stderr`) && /ipv6 activation refused: result=[2-7]/.test(fs.readFileSync(`${receipt}.stderr`, 'utf8')), 30000,
      'conflicted worker did not record its socket refusal; missing readiness alone proves nothing')
    assert.equal(fs.existsSync(receipt), false, 'conflicted IPv6 listener issued readiness')
    const control = command(executable, ['connect6', '::1', String(port)]); assert.equal(control.status, 0, control.stderr)
    bootout(name)
  } finally { await close(blocker) }
  const result = boot(label, ready); assert.equal(result.status, 0, result.stderr)
  try { await waitFor(() => fs.existsSync(ready), 30000, 'IPv6 worker did not publish readiness') }
  catch (error) {
    if (fs.existsSync(`${ready}.stderr`)) t.diagnostic(fs.readFileSync(`${ready}.stderr`, 'utf8').slice(-4096))
    throw error
  }
  const receipt = JSON.parse(fs.readFileSync(ready, 'utf8')); assert.equal(receipt.port, port); assert.ok(Number.isInteger(receipt.pid) && receipt.pid > 1)
  const v4 = await listen('127.0.0.1', port); listeners.push(v4)
  const alias = await listen('127.0.0.2', port); listeners.push(alias)
  const other = await listen('::1'); listeners.push(other)
  const plain = (mode, host, target = port) => command(executable, [mode, host, String(target)])
  const confined = (mode, host, target = port) => command('/usr/bin/sandbox-exec', ['-p', profile(executable, port), executable, mode, host, String(target)])
  const cases = [
    ['connect6', '::1', port, 0],
    ['connect4', '127.0.0.1', port, 77], ['connect4', '127.0.0.2', port, 77],
    ['connect6', '::ffff:127.0.0.1', port, 77], ['connect6', '::ffff:127.0.0.2', port, 77],
    ['connect6', '::1', other.address().port, 77], ['bind6', '::1', 0, 77],
  ]
  for (const [mode, host, target, expected] of cases) {
    let probe = plain(mode, host, target); assert.equal(probe.status, 0, `unconfined ${mode} ${host}: ${probe.stderr}`)
    probe = confined(mode, host, target); assert.equal(probe.status, expected, `confined ${mode} ${host}: ${probe.stderr}`)
    probe = plain(mode, host, target); assert.equal(probe.status, 0, `post-check ${mode} ${host}: ${probe.stderr}`)
  }
  const competing = plain('bind6-reuse', '::1'); assert.equal(competing.status, 78, competing.stderr)
  process.kill(receipt.pid, 'SIGKILL')
  await waitFor(() => command('/bin/kill', ['-0', String(receipt.pid)]).status !== 0, 10000, 'IPv6 worker survived SIGKILL')
  const retained = plain('bind6-reuse', '::1'); assert.equal(retained.status, 78, retained.stderr)
  bootout(label)
  const released = plain('bind6', '::1'); assert.equal(released.status, 0, released.stderr)
})

test('IPv6 diagnostic profile selects TCP6 and a single exact loopback socket', () => {
  assert.match(profile('/private/owner', 19777), /remote tcp6 "localhost:19777"/)
  const value = xml({ label: 'com.autoprompt.socket6.test', executable: '/private/owner', ready: '/private/ready', port: 19777 })
  assert.match(value, /<string>::1<\/string>/)
  assert.doesNotMatch(value, /IPv4|0\.0\.0\.0/)
})
