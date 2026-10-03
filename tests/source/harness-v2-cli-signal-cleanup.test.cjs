'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const configure = require('../../scripts/harness-v2-configure.cjs')
const closedCanary = require('../../scripts/harness-v2-closed-canary.cjs')
const { ProcessOwner, createPosixProcessAdapter } = require('../../agents/codex/workflow/process-owner.js')
const { runAbortOwnedSupervisor } = require('../../agents/codex/workflow/phase-budget.js')
const { run } = require('../../bin/autoprompt.cjs')

async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for child readiness')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('tracked native supervisor forwards CLI termination and waits for its owned child to close', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-signal-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const marker = path.join(root, 'marker')
  const child = cp.spawn(process.execPath, ['-e', [
    "const fs=require('node:fs'), marker=process.argv[1]",
    "fs.writeFileSync(marker, 'ready')",
    "process.once('SIGTERM', () => { fs.appendFileSync(marker, ':term'); process.exit(0) })",
    'setInterval(() => {}, 1000)',
  ].join(';'), marker], { stdio: 'ignore' })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'ready')
  const signalSource = new EventEmitter()
  const settled = configure.awaitOwnedSupervisor(child, { signalSource })
  signalSource.emit('SIGTERM')
  signalSource.emit('SIGTERM')
  assert.deepEqual(await settled, { status: 0, signal: null })
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ready:term')
  assert.equal(signalSource.listenerCount('SIGTERM'), 0)
  assert.equal(signalSource.listenerCount('SIGINT'), 0)
})

test('CLI activation awaits a tracked asynchronous supervisor result', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-async-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const scripts = path.join(root, 'scripts')
  fs.mkdirSync(scripts, { recursive: true })
  fs.writeFileSync(path.join(scripts, 'harness-v2-configure.cjs'), "module.exports={launchActivation:()=>Promise.resolve({activationId:'activation-test',status:0,revoked:true})}\n")
  let stdout = '', stderr = ''
  const result = run(['activate', 'hermes', '--target', root, '--', 'bounded request'], {
    cwd: root, env: process.env, nodeVersion: '22.0.0', packageRoot: root,
    stderr: { write: value => { stderr += value } }, stdout: { write: value => { stdout += value } },
  })
  assert.equal(await result, 0)
  assert.equal(stderr, '')
  assert.match(stdout, /activation-test: status=0 revoked=true/)
})

test('closed native canary cancellation drains its owned test before supervisor revocation', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-canary-cancel-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(root, 'processes.json'), pollMs: 20 })
  const controller = new AbortController()
  const pending = closedCanary.ownedTest(owner, root, { PATH: process.env.PATH }, [process.execPath, '-e', 'setTimeout(() => {}, 30000)'], 30000, controller.signal)
  setTimeout(() => controller.abort(), 100).unref()
  await assert.rejects(pending, error => error.code === 'CHILD_CANCELLED')
  assert.deepEqual(owner.ownershipIdentities(), [])
})

test('immutable activation expiry owns a hung runtime cancellation independently of mission convergence', async () => {
  const timers = new Map()
  let nextTimer = 1
  const timerApi = {
    setTimeout(callback, milliseconds) {
      const id = nextTimer++
      timers.set(id, { callback, milliseconds })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
  }
  const controller = new AbortController()
  const disarm = configure.armActivationExpiry({
    record: { capability: { expiresAt: new Date(1500).toISOString() } },
  }, reason => controller.abort(reason), { timerApi, wallNowMs: () => 1000 })
  assert.equal(timers.size, 1)
  const [timer] = timers.values()
  assert.equal(timer.milliseconds, 500)
  const runtime = {
    start: () => new Promise(() => {}),
    cancel: async reason => ({ outcome: 'CANCELLED', reason, authorizationExpired: true }),
  }
  const settled = runAbortOwnedSupervisor(runtime, controller.signal)
  timer.callback()
  assert.deepEqual(await settled, {
    outcome: 'CANCELLED',
    reason: 'activation authorization expired',
    authorizationExpired: true,
  })
  disarm()
  assert.equal(timers.size, 0)
})
