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
const SOURCE = path.join(ROOT, 'tests/helpers/darwin-launchd-exclusive-fd.c')
const command = (file, args) => cp.spawnSync(file, args, { encoding: 'utf8', timeout: 30000 })
const waitFor = async (predicate, limit, message) => { const deadline = Date.now() + limit; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error(message) }
const listen = (host, port = 0) => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(port, host, () => resolve(server)) })
const close = server => new Promise(resolve => server.close(resolve))
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

test('diagnostic: legacy SubmitJob can transfer exclusive caller sockets to launchd', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-launchd-exclusive-')))
  const executable = path.join(root, 'exclusive-owner'), ready = path.join(root, 'ready.json')
  const uid = process.getuid(), domains = [`gui/${uid}`, `user/${uid}`], labels = new Set()
  const printed = (domain, label) => command('/bin/launchctl', ['print', `${domain}/${label}`])
  const absent = (domain, label) => {
    const result = printed(domain, label)
    assert.notEqual(result.status, 0, `unexpected live service ${domain}/${label}: ${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`Could not find service.*${escapeRegExp(label)}`, 'u'), `unexpected launchctl receipt for ${domain}/${label}: ${result.stdout}${result.stderr}`)
  }
  const exactDomain = label => {
    const matches = domains.filter(domain => printed(domain, label).status === 0)
    assert.ok(matches.length <= 1, `legacy SubmitJob exposed ${label} in multiple domains: ${matches.join(', ')}`)
    return matches[0] || null
  }
  const remove = label => {
    const domain = exactDomain(label)
    if (!domain) { for (const candidate of domains) absent(candidate, label); return }
    const result = command('/bin/launchctl', ['bootout', `${domain}/${label}`])
    if (result.status !== 0) throw new Error(`launchd did not remove ${domain}/${label}: ${result.stdout}${result.stderr}`)
    for (const candidate of domains) absent(candidate, label)
  }
  t.after(() => { for (const label of labels) remove(label); fs.rmSync(root, { recursive: true, force: true }) })
  const sdk = command('/usr/bin/xcrun', ['--show-sdk-path']); assert.equal(sdk.status, 0, sdk.stderr)
  const build = command('/usr/bin/clang', ['-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5', '-Wall', '-Werror', '-Wno-deprecated-declarations', SOURCE, '-o', executable])
  assert.equal(build.status, 0, `legacy launch APIs unavailable or helper did not compile: ${build.stderr}`)
  const label = suffix => `com.autoprompt.exclusivefd.${process.pid}.${suffix}.${crypto.randomBytes(4).toString('hex')}`
  for (const host of ['0.0.0.0', '127.0.0.1', '127.0.0.2', '::1']) {
    const blocker = await listen(host)
    const blockerPort = blocker.address().port
    const blockedLabel = label('blocked'), blockedReady = path.join(root, `${host.replace(/[^a-z0-9]/giu, '_')}.json`); labels.add(blockedLabel)
    try {
      const blocked = command(executable, ['--submit', executable, blockedReady, blockedLabel, String(blockerPort)])
      assert.notEqual(blocked.status, 0, `legacy submit accepted a preexisting ${host} listener: ${blocked.stdout}${blocked.stderr}`)
      assert.equal(fs.existsSync(blockedReady), false, 'failed listener submission published a readiness receipt')
    } finally {
      remove(blockedLabel)
      labels.delete(blockedLabel); await close(blocker)
    }
  }
  const active = label('active'); labels.add(active)
  const submit = command(executable, ['--submit', executable, ready, active]); assert.equal(submit.status, 0, `${submit.stdout}${submit.stderr}`)
  assert.ok(exactDomain(active), 'legacy SubmitJob succeeded without exposing the exact label in gui or user launchd domains')
  try { await waitFor(() => fs.existsSync(ready), 30000, 'legacy SubmitJob worker did not check in with transferred FDs') } catch (error) {
    const tail = file => { try { return fs.readFileSync(file, 'utf8').slice(-4096) } catch { return '<missing>' } }
    const launchd = domains.map(domain => ({ domain, output: command('/bin/launchctl', ['print', `${domain}/${active}`]) }))
    console.error(JSON.stringify({ exclusiveFdFailure: error.message, ready, stdoutTail: tail(`${ready}.stdout`), stderrTail: tail(`${ready}.stderr`), launchd: launchd.map(item => ({ domain: item.domain, status: item.output.status, stdout: String(item.output.stdout || '').slice(-4096), stderr: String(item.output.stderr || '').slice(-4096) })) }))
    throw error
  }
  const receipt = JSON.parse(fs.readFileSync(ready, 'utf8')); assert.equal(receipt.label, active); assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0); assert.ok(Number.isSafeInteger(receipt.port) && receipt.port > 0)
  const check = (mode, host, expected) => { const result = command(executable, [mode, host, String(receipt.port)]); assert.equal(result.status, expected, `${mode} ${host}: ${result.stderr}`) }
  for (const mode of ['--bind4', '--bind4-reuse']) for (const host of ['0.0.0.0', '127.0.0.1', '127.0.0.2']) check(mode, host, 78)
  for (const mode of ['--bind6', '--bind6-reuse']) check(mode, '::1', 78)
  process.kill(receipt.pid, 'SIGKILL')
  await waitFor(() => command('/bin/kill', ['-0', String(receipt.pid)]).status !== 0, 10000, 'checked-in worker survived SIGKILL')
  for (const mode of ['--bind4', '--bind4-reuse']) for (const host of ['0.0.0.0', '127.0.0.1', '127.0.0.2']) check(mode, host, 78)
  for (const mode of ['--bind6', '--bind6-reuse']) check(mode, '::1', 78)
  remove(active); labels.delete(active)
  for (const mode of ['--bind4', '--bind4-reuse']) for (const host of ['0.0.0.0', '127.0.0.1', '127.0.0.2']) check(mode, host, 0)
  for (const mode of ['--bind6', '--bind6-reuse']) check(mode, '::1', 0)
})

test('diagnostic source stays isolated from production launch paths', () => {
  const source = fs.readFileSync(SOURCE, 'utf8')
  assert.match(source, /Diagnostic only/u)
  assert.match(source, /launch_data_new_fd/u)
  assert.match(source, /LAUNCH_KEY_SUBMITJOB/u)
  assert.match(source, /LAUNCH_KEY_CHECKIN/u)
})
