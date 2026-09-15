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
const modes = ['inherit', 'pipe', 'ipc']
function lines(stdout, mode) {
  const records = stdout.trimEnd().split(/\r?\n/)
  assert.deepEqual(JSON.parse(records.shift()), { stage: 'before-spawn', mode, node: process.version, uv: process.versions.uv })
  if (mode === 'inherit') assert.equal(records.shift(), 'inherit-child')
  return records
}

test('Node pipe diagnostic fixture proves exact host stdio and fork IPC roundtrips', t => {
  for (const mode of modes) {
    const result = cp.spawnSync(process.execPath, [workerSource, mode], { encoding: 'utf8', timeout: 5000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
    assert.equal(result.stderr, '')
    assert.deepEqual(lines(result.stdout, mode).map(value => JSON.parse(value)), [{ stage: 'passed', mode }])
  }
})

test('native Windows Node pipe diagnostic records stdio and fork IPC support with owned job drain', { skip: process.platform !== 'win32', timeout: 600000 }, t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'node-pipe-native-')))
  let cleanupSafe = true
  t.after(() => { if (cleanupSafe) fs.rmSync(directory, { recursive: true, force: true }); else t.diagnostic(`Retained owned fixture after unconfirmed controller outcome: ${directory}`) })
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  ensureWindowsPrivateAcl(directory)
  const control = path.join(directory, 'control'), runtime = path.join(directory, 'runtime')
  for (const folder of [control, runtime]) { fs.mkdirSync(folder); ensureWindowsPrivateAcl(folder) }
  const native = path.join(control, 'native.cs'), fixture = path.join(control, 'node-pipe-proof.cs')
  fs.copyFileSync(path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs'), native, fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(path.join(fixtures, 'node-pipe-proof.cs'), fixture, fs.constants.COPYFILE_EXCL)
  const node = path.join(runtime, 'node.exe'), worker = path.join(runtime, 'worker.cjs'), controller = path.join(control, 'controller.exe')
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const originalNodeHash = hash(process.execPath)
  fs.copyFileSync(process.execPath, node, fs.constants.COPYFILE_EXCL)
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
    assert.ok(Number.isSafeInteger(observation.observedJobMembers) && observation.observedJobMembers >= 1 && observation.observedJobMembers <= 2)
    assert.equal(typeof observation.timedOut, 'boolean')
    const decode = value => { assert.equal(typeof value, 'string'); assert.ok(value.length <= 21848); const bytes = Buffer.from(value, 'base64'); assert.equal(bytes.toString('base64'), value); return bytes.toString('utf8') }
    const stdout = decode(observation.stdoutBase64), stderr = decode(observation.stderrBase64)
    assert.equal(stderr, '')
    const output = lines(stdout, mode)
    if (mode === 'inherit') { assert.equal(observation.timedOut, false); assert.equal(observation.exitCode, 0) }
    if (observation.timedOut) {
      assert.notEqual(mode, 'inherit')
      assert.deepEqual(output, [], 'A timed-out spawn must preserve its ready marker without fabricated completion')
      t.diagnostic(`Node ${process.version} libuv ${process.versions.uv} ${mode}: unsupported-timeout; owned job drained`)
    } else if (observation.exitCode !== 0) {
      assert.notEqual(mode, 'inherit')
      assert.equal(observation.exitCode, 1)
      assert.equal(output.length, 1)
      const failure = JSON.parse(output[0])
      assert.deepEqual(Object.keys(failure).sort(), ['code', 'mode', 'phase', 'stage'])
      assert.deepEqual({ stage: failure.stage, mode: failure.mode, phase: failure.phase }, { stage: 'failed', mode, phase: 'spawn' })
      assert.ok(['EACCES', 'EPERM', 'ENOSYS', 'ETIMEDOUT'].includes(failure.code), 'Unexpected fixture errors are failures, not unsupported observations')
      t.diagnostic(`Node ${process.version} libuv ${process.versions.uv} ${mode}: unsupported-${failure.code}; owned job drained`)
    } else {
      assert.deepEqual(output.map(value => JSON.parse(value)), [{ stage: 'passed', mode }])
      t.diagnostic(`Node ${process.version} libuv ${process.versions.uv} ${mode}: exact roundtrip passed; owned job drained`)
    }
  }
  assert.equal(hash(node), originalNodeHash)
})
