'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pinnedCodexCli } = require('../helpers/pinned-codex-cli.cjs')
const { pinnedCodexPackageFixture } = require('../helpers/pinned-codex-package.cjs')

test('actual pinned native adapter supports both authentication modes and independent red/repair/green', {
  timeout: 120000,
  skip: process.platform !== 'linux' && 'this native network-isolation fixture requires Linux',
}, async t => {
  const installedCli = pinnedCodexCli()
  if (!installedCli) {
    t.skip('install the exact pinned Codex CLI to execute native authenticated lifecycle coverage')
    return
  }
  const environment = { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8' }
  // The helper is PID 1 in a private namespace. Killing its owning unshare
  // process kills the helper and every native/tool descendant, even if a tool
  // creates another process group. No detached grandchild survives a timeout.
  const processBoundary = ['--pid', '--fork', '--kill-child=SIGKILL', '--mount-proc']
  const candidates = [
    { command: 'unshare', args: ['--net', ...processBoundary] },
    { command: 'unshare', args: ['--user', '--map-root-user', '--net', ...processBoundary] },
    { command: 'sudo', args: ['-n', 'unshare', '--net', ...processBoundary], dropPrivileges: true },
  ]
  const namespace = candidates.find(candidate => childProcess.spawnSync(candidate.command, [...candidate.args, 'true'], {
    env: environment, encoding: 'utf8', timeout: 5000,
  }).status === 0)
  assert.ok(namespace, 'native authenticated tests require an isolated network namespace')
  // A root caller can read a CLI below somebody else's private home using
  // capabilities that Codex's tool sandbox correctly drops. Stage identical
  // pinned package bytes in this caller's own private fixture instead.
  const packageDirectory = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-native-package-'))
  t.after(() => fs.rmSync(packageDirectory, { recursive: true, force: true }))
  const fixture = pinnedCodexPackageFixture(packageDirectory, {
    env: { ...environment, AUTOPROMPT_PINNED_CODEX: installedCli.cliPath },
  })
  const fixtureRoot = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-native-auth-lifecycle-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  const cli = { command: process.execPath, args: [fixture.cliPath], cliPath: fixture.cliPath, fixtureRoot }
  const helper = path.resolve(__dirname, '../helpers/codex-authenticated-lifecycle.cjs')
  const result = await new Promise((resolve, reject) => {
    const child = childProcess.spawn(namespace.command, [
      ...namespace.args, process.execPath, helper, JSON.stringify(cli),
      JSON.stringify(namespace.dropPrivileges ? { uid: process.getuid(), gid: process.getgid() } : null),
    ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    let forceTimer
    const timer = setTimeout(() => {
      // sudo's monitor, when used, first forwards termination to its command;
      // unshare's parent-death binding performs the descendant kill.
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
    }, 100000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); clearTimeout(forceTimer); reject(error) })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      resolve({ status, signal, stdout, stderr })
    })
  })
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  const evidence = JSON.parse(result.stdout.trim())
  assert.equal(evidence.networkIsolation, 'private-loopback-only')
  assert.deepEqual(evidence.summary.map(item => item.mode), ['apikey', 'chatgpt'])
  assert.ok(evidence.summary.every(item => item.independentRed === 1 && item.independentGreen === 0))
  for (const item of evidence.summary) {
    for (const launch of [item.original, item.repaired]) {
      assert.equal(launch.providerRequests, 3)
      assert.equal(launch.toolCalls, 2)
      assert.deepEqual(launch.usage, { noncachedInput: 6, cachedInput: 0, output: 3, reasoning: 0 })
    }
  }
})
