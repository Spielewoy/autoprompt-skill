'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fixtures = path.resolve(__dirname, '../fixtures/windows-appcontainer')
const workerSource = path.join(fixtures, 'node-pipe-worker.cjs')
const { bindWorker, identify, unchanged, hostEnvironment } = require('../helpers/windows-node-pipe-worker.cjs')
const modes = ['inherit', 'pipe', 'ipc', 'ignore']
const passed = mode => ({ stage: 'passed', mode, children: 1, childExitCode: mode === 'ignore' ? 17 : 0, ...(mode === 'pipe' || mode === 'ignore' ? { grandchildren: 2, grandchildIgnoredExitCode: 23, emptyEnvironment: true } : {}) })

test('Node pipe worker selection binds an explicit physical file and rejects incomplete or changed bindings', t => {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'node-pipe-binding-')))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'worker-fixture.bin')
  fs.writeFileSync(file, 'first-bound-bytes')
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const environment = { AUTOPROMPT_NODE_PIPE_WORKER: file, AUTOPROMPT_NODE_PIPE_WORKER_SHA256: sha256, AUTOPROMPT_NODE_PIPE_REQUIRE_SUPPORT: '1' }
  const selected = bindWorker(environment)
  assert.equal(selected.file, file)
  assert.equal(selected.sha256, sha256)
  assert.equal(selected.requiredSupport, true)
  assert.throws(() => bindWorker({ AUTOPROMPT_NODE_PIPE_WORKER: file }), /together/)
  assert.throws(() => bindWorker({ AUTOPROMPT_NODE_PIPE_WORKER_SHA256: sha256 }), /together/)
  assert.throws(() => bindWorker({ ...environment, AUTOPROMPT_NODE_PIPE_REQUIRE_SUPPORT: 'true' }), /exactly 1/)
  assert.throws(() => bindWorker({ ...environment, AUTOPROMPT_NODE_PIPE_WORKER_SHA256: '0'.repeat(64) }), /mismatch/)
  assert.throws(() => bindWorker({ ...environment, AUTOPROMPT_NODE_PIPE_WORKER: 'relative.exe' }), /absolute/)
  assert.throws(() => bindWorker({ ...environment, AUTOPROMPT_NODE_PIPE_WORKER: folder }), /regular file/)
  const alias = path.join(folder, 'hardlink.bin')
  fs.linkSync(file, alias)
  assert.throws(() => bindWorker(environment), /singly linked/)
  fs.unlinkSync(alias)
  fs.writeFileSync(file, 'different-bound-bytes')
  assert.throws(() => unchanged(selected), /changed/)
})

function lines(stdout, mode, identity) {
  const records = stdout.trimEnd().split(/\r?\n/)
  assert.deepEqual(JSON.parse(records.shift()), { stage: 'before-spawn', mode, node: identity.node, uv: identity.uv })
  if (mode === 'inherit') assert.equal(records.shift(), 'inherit-child')
  return records
}

test('Node pipe diagnostic fixture proves exact host stdio and fork IPC roundtrips', t => {
  const selected = bindWorker(), identity = identify(selected)
  for (const mode of modes) {
    const result = cp.spawnSync(selected.file, [workerSource, mode], { encoding: 'utf8', timeout: 5000, env: hostEnvironment() })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
    assert.equal(result.stderr, '')
    assert.deepEqual(lines(result.stdout, mode, identity).map(value => JSON.parse(value)), [passed(mode)])
  }
  unchanged(selected)
})

test('native-only Node requirement refuses a missing locator instead of relaxing the proof', () => {
  const selected = bindWorker(), identity = identify(selected), env = hostEnvironment()
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'AUTOPROMPT_PRIVATE_NUL_HANDLE') delete env[key]
  const result = cp.spawnSync(selected.file, [workerSource, 'pipe', '--require-private-null'], { encoding: 'utf8', timeout: 5000, env })
  assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stderr, '')
  assert.deepEqual(lines(result.stdout, 'pipe', identity).map(value => JSON.parse(value)), [{ stage: 'failed', mode: 'pipe', phase: 'spawn', code: 'ERR_ASSERTION' }])
  unchanged(selected)
})

test('nested Node worker refuses a locator that does not propagate through an empty child environment', () => {
  const selected = bindWorker()
  // A host-only fake locator is never opened: ordinary Node leaves it out of
  // env={}, so the grandchild must fail its required-propagation assertion.
  const result = cp.spawnSync(selected.file, [workerSource, 'nested-child', 'ignore', '1'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...hostEnvironment(), AUTOPROMPT_PRIVATE_NUL_HANDLE: '0000000000001234' },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /AssertionError/)
  unchanged(selected)
})

test('native Windows Node pipe diagnostic records stdio and fork IPC support with owned job drain', { skip: process.platform !== 'win32', timeout: 600000 }, t => {
  const selected = bindWorker(), identity = identify(selected)
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'node-pipe-native-')))
  let cleanupSafe = true
  t.after(async () => {
    if (!cleanupSafe) { t.diagnostic(`Retained owned fixture after unconfirmed controller outcome: ${directory}`); return }
    // The controller has exited and every started job has positive drain evidence.
    // Windows may still briefly retain executable/image or scanner handles. Retry
    // only cleanup with a finite retry count; never reinterpret a failed
    // launch/drain or swallow persistent deletion failures.
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  ensureWindowsPrivateAcl(directory)
  const control = path.join(directory, 'control'), runtime = path.join(directory, 'runtime')
  for (const folder of [control, runtime]) { fs.mkdirSync(folder); ensureWindowsPrivateAcl(folder) }
  const native = path.join(control, 'native.cs'), fixture = path.join(control, 'node-pipe-proof.cs')
  fs.copyFileSync(path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs'), native, fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(path.join(fixtures, 'node-pipe-proof.cs'), fixture, fs.constants.COPYFILE_EXCL)
  const node = path.join(runtime, 'node.exe'), worker = path.join(runtime, 'worker.cjs'), controller = path.join(control, 'controller.exe')
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const originalNodeHash = selected.sha256
  fs.writeFileSync(node, selected.bytes, { flag: 'wx', mode: 0o700 })
  fs.copyFileSync(workerSource, worker, fs.constants.COPYFILE_EXCL)
  assert.equal(hash(node), originalNodeHash)
  const systemRoot = process.env.SystemRoot
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control }
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const compiled = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";Add-Type -Path @($env:AUTOPROMPT_NODE_NATIVE,$env:AUTOPROMPT_NODE_FIXTURE) -OutputAssembly $env:AUTOPROMPT_NODE_CONTROLLER -OutputType ConsoleApplication'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...environment, AUTOPROMPT_NODE_NATIVE: native, AUTOPROMPT_NODE_FIXTURE: fixture, AUTOPROMPT_NODE_CONTROLLER: controller },
  })
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  cleanupSafe = false
  const result = cp.spawnSync(controller, [node, worker], { encoding: 'utf8', timeout: 60000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], cwd: control, env: environment,
  })
  for (const stream of ['stdout', 'stderr']) for (const line of String(result[stream] || '').slice(0, 65536).split(/\r?\n/)) {
    for (let offset = 0; offset < line.length; offset += 480) t.diagnostic(`${stream}: ${line.slice(offset, offset + 480)}`)
  }
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  const observations = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(observations.length, modes.length)
  assert.ok(observations.every(observation => observation.drained === true), 'Every started job must have positive drain evidence before fixture cleanup')
  cleanupSafe = true
  for (const [index, observation] of observations.entries()) {
    assert.deepEqual(Object.keys(observation).sort(), ['drained', 'exitCode', 'mode', 'observedJobMembers', 'stderrBase64', 'stdoutBase64', 'timedOut'])
    const mode = modes[index]
    assert.equal(observation.mode, mode)
    assert.equal(observation.drained, true)
    assert.ok(Number.isSafeInteger(observation.exitCode) && observation.exitCode >= 0 && observation.exitCode <= 0xffffffff)
    // Aggregate job membership is independent of explicit child count; passed records
    // independently prove the explicit child plus two nested grandchildren for
    // pipe/ignore, their exact effects, empty environments and expected exits.
    assert.ok(Number.isSafeInteger(observation.observedJobMembers) && observation.observedJobMembers >= 1 && observation.observedJobMembers <= 1024)
    assert.equal(typeof observation.timedOut, 'boolean')
    const decode = value => { assert.equal(typeof value, 'string'); assert.ok(value.length <= 21848); const bytes = Buffer.from(value, 'base64'); assert.equal(bytes.toString('base64'), value); return bytes.toString('utf8') }
    const stdout = decode(observation.stdoutBase64), stderr = decode(observation.stderrBase64)
    assert.equal(stderr, '')
    const output = lines(stdout, mode, identity)
    if (mode === 'inherit' || selected.requiredSupport) { assert.equal(observation.timedOut, false); assert.equal(observation.exitCode, 0) }
    if (observation.timedOut) {
      assert.notEqual(mode, 'inherit')
      assert.deepEqual(output, [], 'A timed-out spawn must preserve its ready marker without fabricated completion')
      t.diagnostic(`Node ${identity.node} libuv ${identity.uv} ${mode}: unsupported-timeout; owned job drained`)
    } else if (observation.exitCode !== 0) {
      assert.notEqual(mode, 'inherit')
      assert.equal(observation.exitCode, 1)
      assert.equal(output.length, 1)
      const failure = JSON.parse(output[0])
      assert.deepEqual(Object.keys(failure).sort(), ['code', 'mode', 'phase', 'stage'])
      assert.deepEqual({ stage: failure.stage, mode: failure.mode, phase: failure.phase }, { stage: 'failed', mode, phase: 'spawn' })
      assert.ok(['EACCES', 'EPERM', 'ENOSYS', 'ETIMEDOUT'].includes(failure.code), 'Unexpected fixture errors are failures, not unsupported observations')
      t.diagnostic(`Node ${identity.node} libuv ${identity.uv} ${mode}: unsupported-${failure.code}; owned job drained`)
    } else {
      assert.deepEqual(output.map(value => JSON.parse(value)), [passed(mode)])
      t.diagnostic(`Node ${identity.node} libuv ${identity.uv} ${mode}: exact roundtrip passed; owned job drained`)
    }
  }
  assert.equal(hash(node), originalNodeHash)
  unchanged(selected)
})
