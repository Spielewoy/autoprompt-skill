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
        assert.match(source, /Write-JobPhase 'compile-start'/)
        assert.match(source, /Write-JobPhase 'job-assigned-resumed'/)
        const request = JSON.parse(fs.readFileSync(invocation.options.env.AUTOPROMPT_JOB_REQUEST, 'utf8'))
        assert.equal(request.startupDeadlineAt, launch.startupDeadlineAt)
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

  const launch = launchRecord(adapter, 'bootstrap-success')
  const result = await adapter.spawnOwned(launch)
  assert.equal(adapter.startupTimeoutMs, 120000)
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

function claudeTempDescriptor(cwd, relativePath = `temp-${'a'.repeat(32)}`) {
  const body = { schemaVersion: 1, path: path.join(cwd, relativePath), relativePath }
  return { ...body, sha256: require('node:crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

function claudeTempFixture(t) {
  const root = temporary(t, 'owned-claude-temp-')
  const cwd = path.join(root, 'canonical'), alias = path.join(root, 'short')
  fs.mkdirSync(cwd)
  fs.symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const descriptor = claudeTempDescriptor(cwd)
  fs.mkdirSync(descriptor.path)
  const environment = { TEMP: descriptor.path, TMP: descriptor.path, TMPDIR: descriptor.path,
    HOME: path.join(cwd, 'home'), PATH: descriptor.path, FIXTURE_CREDENTIAL: descriptor.path }
  const project = overrides => require('../../agents/codex/workflow/phase-budget.js')
    .projectWindowsClaudeTempEnvironment({ descriptor, requestedCwd: cwd, effectiveCwd: alias,
      environment, ...overrides })
  return { root, cwd, alias, descriptor, environment, project }
}

test('owned Claude temp projection preserves backing storage and unrelated environment', t => {
  const f = claudeTempFixture(t), before = { ...f.environment }
  const projected = f.project()
  const physicalSpelling = path.join(f.alias, f.descriptor.relativePath)
  assert.notEqual(projected, f.environment)
  assert.deepEqual(f.environment, before)
  assert.deepEqual(projected, { ...before, TEMP: physicalSpelling, TMP: physicalSpelling, TMPDIR: physicalSpelling })
  fs.writeFileSync(path.join(projected.TEMP, 'actual-child-bytes'), 'private-temp-content')
  assert.equal(fs.readFileSync(path.join(f.descriptor.path, 'actual-child-bytes'), 'utf8'), 'private-temp-content')
  fs.unlinkSync(f.alias)
  assert.equal(fs.readFileSync(path.join(f.descriptor.path, 'actual-child-bytes'), 'utf8'), 'private-temp-content')
})

test('owned Claude temp projection refuses forged bindings and foreign environment', t => {
  const f = claudeTempFixture(t)
  const foreign = path.join(f.root, 'foreign')
  fs.mkdirSync(foreign)
  const badDescriptors = [
    { ...f.descriptor, sha256: '0'.repeat(64) },
    { ...f.descriptor, extra: true },
    claudeTempDescriptor(foreign),
    claudeTempDescriptor(f.cwd, '..'),
    { ...f.descriptor, relativePath: `temp-${'b'.repeat(32)}` },
  ]
  for (const descriptor of badDescriptors) assert.throws(() => f.project({ descriptor }), { code: 'CODEX_PROXY_REQUEST_INVALID' })
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    assert.throws(() => f.project({ environment: { ...f.environment, [key]: foreign } }), { code: 'CODEX_PROXY_REQUEST_INVALID' })
    const missing = { ...f.environment }; delete missing[key]
    assert.throws(() => f.project({ environment: missing }), { code: 'CODEX_PROXY_REQUEST_INVALID' })
  }
  assert.throws(() => f.project({ environment: { ...f.environment, temp: foreign } }), { code: 'CODEX_PROXY_REQUEST_INVALID' })
  assert.equal(fs.readdirSync(foreign).length, 0)
})

test('owned Claude temp projection rejects redirected canonical storage and foreign cwd aliases', t => {
  const f = claudeTempFixture(t)
  const foreign = path.join(f.root, 'foreign')
  fs.mkdirSync(foreign)
  fs.mkdirSync(path.join(foreign, f.descriptor.relativePath))
  assert.throws(() => f.project({ effectiveCwd: foreign }), { code: 'CODEX_PROXY_REQUEST_INVALID' })
  fs.rmdirSync(f.descriptor.path)
  fs.symlinkSync(foreign, f.descriptor.path, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => f.project(), { code: 'RUN_RECORD_UNSAFE' })
  fs.unlinkSync(f.descriptor.path)
  fs.writeFileSync(f.descriptor.path, 'not-a-directory')
  assert.throws(() => f.project(), { code: 'RUN_RECORD_UNSAFE' })
})

test('owned Claude temp projection rejects aliases that still exceed the Windows path bound', t => {
  const f = claudeTempFixture(t)
  const parent = path.join(f.root, 'x'.repeat(100), 'y'.repeat(100))
  fs.mkdirSync(parent, { recursive: true })
  const longAlias = path.join(parent, 'alias-still-too-long')
  fs.symlinkSync(f.cwd, longAlias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(path.join(longAlias, f.descriptor.relativePath).length >= 248)
  assert.throws(() => f.project({ effectiveCwd: longAlias }), { code: 'CODEX_PROXY_REQUEST_INVALID' })
})

test('Claude temp allocation stays per-launch without relocating home or continuation state', t => {
  const native = require('../../scripts/harness-v2-native.cjs')
  const root = temporary(t, 'claude-temp-allocation-'), cwd = path.join(root, 'cwd')
  const sessionRoot = path.join(root, 'session')
  fs.mkdirSync(cwd)
  const launches = [1, 2].map(number => {
    const home = path.join(root, `launch-${number}`)
    const launch = native.createLaunch({ provider: 'claude', home, sessionRoot, cwd, targetPath: root,
      prompt: 'Return one object.', input: 'fixture', toolFree: true,
      connection: { model: 'claude-sonnet-4-6' }, environment: { PATH: process.env.PATH } })
    assert.equal(launch.cwd, cwd)
    assert.equal(launch.env.HOME, home)
    assert.equal(launch.env.USERPROFILE, home)
    assert.equal(launch.env.CLAUDE_CONFIG_DIR, path.join(sessionRoot, 'claude'))
    assert.equal(launch.argv[launch.argv.indexOf('--settings') + 1], path.join(home, 'settings.json'))
    assert.equal(launch.env.TEMP, launch.env.TMP)
    assert.equal(launch.env.TEMP, launch.env.TMPDIR)
    assert.ok(fs.statSync(launch.env.TEMP).isDirectory())
    if (process.platform === 'win32') {
      assert.match(launch.windowsTempDirectory.relativePath, /^temp-[a-f0-9]{32}$/)
      assert.deepEqual(launch.windowsTempDirectory, claudeTempDescriptor(cwd, launch.windowsTempDirectory.relativePath))
      assert.equal(launch.env.TEMP, launch.windowsTempDirectory.path)
      assert.equal(path.dirname(launch.env.TEMP), cwd)
    } else {
      assert.equal(launch.windowsTempDirectory, undefined)
      assert.equal(launch.env.TEMP, path.join(home, 'tmp'))
    }
    return launch
  })
  assert.notEqual(launches[0].env.TEMP, launches[1].env.TEMP)
  const home = path.join(root, 'other-provider')
  const other = native.createLaunch({ provider: 'opencode', home, sessionRoot, cwd, targetPath: root,
    prompt: 'Return one object.', input: 'fixture', toolFree: true,
    connection: {}, environment: { PATH: process.env.PATH } })
  assert.equal(other.windowsTempDirectory, undefined)
  assert.equal(other.env.TEMP, path.join(home, 'tmp'))
})
