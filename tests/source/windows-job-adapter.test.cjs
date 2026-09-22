'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createWindowsJobAdapter } = require('../../agents/codex/workflow/process-owner.js')

function temporary(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function asWindows(callback) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const priorSystemRoot = process.env.SystemRoot
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
  process.env.SystemRoot = 'C:\\Windows'
  try { return callback() } finally {
    Object.defineProperty(process, 'platform', descriptor)
    if (priorSystemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = priorSystemRoot
  }
}

function helperProcess(pid, end) {
  const helper = new EventEmitter()
  helper.pid = pid
  helper.stdin = new EventEmitter()
  helper.stdin.end = end
  helper.unref = () => {}
  return helper
}

function launchRecord(adapter, reservationId) {
  const input = {
    reservationId,
    reservationIdentity: adapter.reservationIdentity(reservationId),
    startupDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
    targetKey: `target-${reservationId}`,
  }
  return {
    ...input,
    reservationBinding: adapter.prepareReservation(input),
    ownershipId: `ownership-${reservationId}`,
    executable: 'C:\\runtime\\node.exe',
    argv: ['child.cjs'],
    cwd: 'C:\\work',
    env: { SystemRoot: 'C:\\Windows' },
  }
}

test('Windows Job adapter streams its fixed bootstrap and restores the controller TEMP after compilation', async t => {
  const root = temporary(t, 'windows-job-adapter-')
  const controlRoot = path.join(root, 'control')
  const runtimeTemp = path.join(root, 'profile-temp')
  fs.mkdirSync(runtimeTemp)
  const compilerRoot = path.join(root, 'compiler')
  let invocation
  const fsImpl = new Proxy(fs, {})
  const adapter = asWindows(() => createWindowsJobAdapter({
    controlRoot,
    fsImpl,
    createWindowsCompilerDirectory(prefix) {
      assert.equal(prefix, 'autoprompt-job-')
      fs.mkdirSync(compilerRoot)
      return compilerRoot
    },
    windowsControllerEnvironment(systemRoot) {
      assert.equal(systemRoot, 'C:\\Windows')
      return { SystemRoot: systemRoot, TEMP: runtimeTemp, TMP: runtimeTemp, Path: 'C:\\Windows\\System32' }
    },
    spawn(file, argv, options) {
      invocation = { file, argv, options }
      return helperProcess(41001, (source, encoding, callback) => {
        assert.equal(encoding, 'utf8')
        assert.match(source, /Add-Type -TypeDefinition/)
        fs.rmSync(compilerRoot, { recursive: true })
        const reservationDirectory = fs.readdirSync(controlRoot, { withFileTypes: true })
          .find(entry => entry.isDirectory()).name
        fs.writeFileSync(path.join(controlRoot, reservationDirectory, 'status.json'), JSON.stringify({
          ready: true, assigned: true, rootPid: 41002, helperPid: 41001,
        }))
        callback()
      })
    },
  }))

  const result = await adapter.spawnOwned(launchRecord(adapter, 'bootstrap-success'))
  assert.deepEqual(result, {
    rootPid: 41002,
    groupIdentity: adapter.reservationIdentity('bootstrap-success'),
    helperPid: 41001,
  })
  assert.match(invocation.file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/)
  assert.deepEqual(invocation.argv.slice(-2), [
    '-Command',
    "$ErrorActionPreference='Stop';$source=[Console]::In.ReadToEnd();& ([ScriptBlock]::Create($source))",
  ])
  assert.deepEqual(invocation.options.stdio.slice(0, 2), ['pipe', 'ignore'])
  assert.equal(invocation.options.env.TEMP, compilerRoot)
  assert.equal(invocation.options.env.TMP, compilerRoot)
  assert.equal(invocation.options.env.AUTOPROMPT_JOB_COMPILER_DIRECTORY, compilerRoot)
  assert.equal(invocation.options.env.AUTOPROMPT_JOB_RUNTIME_TEMP, runtimeTemp)
  assert.notEqual(invocation.options.env.AUTOPROMPT_JOB_RUNTIME_TEMP, compilerRoot)
  assert.equal(fs.existsSync(compilerRoot), false)
  assert.equal(fs.existsSync(runtimeTemp), true)
})

test('Windows Job adapter cleans only compiler roots whose helper is absent or observed exited', async t => {
  const root = temporary(t, 'windows-job-adapter-failure-')
  const runtimeTemp = path.join(root, 'profile-temp')
  fs.mkdirSync(runtimeTemp)

  async function exercise(name, mode) {
    const controlRoot = path.join(root, name, 'control')
    const compilerRoot = path.join(root, name, 'compiler')
    const removals = []
    const fsImpl = new Proxy(fs, {
      get(target, property) {
        if (property !== 'rmSync') return Reflect.get(target, property)
        return (value, options) => { removals.push({ value, options }); return fs.rmSync(value, options) }
      },
    })
    const adapter = asWindows(() => createWindowsJobAdapter({
      controlRoot,
      fsImpl,
      createWindowsCompilerDirectory() { fs.mkdirSync(compilerRoot); return compilerRoot },
      windowsControllerEnvironment: systemRoot => ({ SystemRoot: systemRoot, TEMP: runtimeTemp, TMP: runtimeTemp }),
      spawn() {
        if (mode === 'spawn-error') throw Object.assign(new Error('spawn refused'), { code: 'ENOENT' })
        let helper
        helper = helperProcess(42001, (_source, _encoding, callback) => {
          callback(new Error('source pipe failed'))
          if (mode === 'observed-exit') helper.emit('exit', 126, null)
        })
        return helper
      },
    }))
    let failure
    try { await adapter.spawnOwned(launchRecord(adapter, name)) } catch (error) { failure = error }
    assert.ok(failure, `${name} must fail`)
    return { compilerRoot, failure, removals }
  }

  const absent = await exercise('spawn-error', 'spawn-error')
  assert.equal(fs.existsSync(absent.compilerRoot), false)
  assert.deepEqual(absent.removals.at(-1), {
    value: absent.compilerRoot,
    options: { recursive: true, force: true, maxRetries: 10, retryDelay: 100 },
  })

  const alive = await exercise('stdin-alive', 'stdin-alive')
  assert.equal(fs.existsSync(alive.compilerRoot), true)
  assert.equal(alive.failure.cleanupConfirmed, false)
  assert.equal(alive.failure.retainedCompilerRoot, alive.compilerRoot)
  assert.equal(alive.removals.some(item => item.value === alive.compilerRoot), false)

  const exited = await exercise('stdin-exited', 'observed-exit')
  assert.equal(fs.existsSync(exited.compilerRoot), false)
  assert.equal(exited.failure.retainedCompilerRoot, undefined)
  assert.deepEqual(exited.removals.at(-1), {
    value: exited.compilerRoot,
    options: { recursive: true, force: true, maxRetries: 10, retryDelay: 100 },
  })
})
