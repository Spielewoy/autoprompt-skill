'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const bytes = Buffer.from('runtime')
const digest = crypto.createHash('sha256').update(bytes).digest('hex')
const deepControl = 'C:\\owned\\' + Array(8).fill('deep-controller-component').join('\\')
const sid = 'S-1-15-2-1-2-3-4-5-6-7'

function harness(file, behavior, cleanupFailure = false) {
  const created = [], removed = [], calls = []
  const temporary = 'C:\\Users\\runner\\AppData\\Local\\compiler-private'
  const stat = { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false,
    dev: 1n, ino: 2n, nlink: 1n, size: BigInt(bytes.length), mtimeNs: 3n, ctimeNs: 4n }
  const fakeFs = { realpathSync: { native: value => value }, lstatSync: () => stat,
    openSync: value => value, fstatSync: () => stat, readFileSync: () => bytes,
    closeSync() {}, existsSync: () => false, rmSync(value, options) {
      assert.equal(options.maxRetries, 10); assert.equal(options.retryDelay, 100)
      removed.push(value)
      if (cleanupFailure) throw Object.assign(new Error('persistent compiler cleanup failure'), { code: 'ENOTEMPTY' })
    } }
  const check = (executable, argv, options) => {
    calls.push({ executable, argv, options })
    assert.equal(options.env.TEMP, temporary)
    assert.equal(options.env.TMP, temporary)
    assert.ok(options.env.TEMP.length < deepControl.length)
    assert.equal(removed.length, 0, 'compiler storage must survive until helper completion')
    return behavior(executable, argv, options)
  }
  const replacements = {
    'node:fs': fakeFs, 'node:path': path.win32,
    'node:child_process': { spawn: check, spawnSync: check },
    './windows-filesystem.js': { createWindowsFilesystemCapture: () => ({ assertRecordParent() {} }) },
    './safe-run-root.js': { createWindowsCompilerDirectory(prefix) { created.push(prefix); return temporary } },
  }
  const filename = path.resolve(__dirname, '../../agents/codex/workflow', file)
  const localRequire = createRequire(filename), module = { exports: {} }
  // Exercise the real resource invocation wrapper, independently of its ACL
  // protocol parser. Native tests separately exercise the actual PowerShell.
  const expose = file === 'windows-appcontainer-resources.js' ? '\nmodule.exports.nativeBackend = nativeBackend\n' : ''
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + expose, {
    module, exports: module.exports, __dirname: 'C:\\deployment', Buffer, setTimeout, clearTimeout,
    process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    require: name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name),
  }, { filename })
  return { api: module.exports, created, removed, calls, temporary }
}

for (const outcome of ['success', 'refusal', 'spawn-error', 'cleanup-error']) {
  test(`Windows resource compiler staging is shallow and cleaned after ${outcome}`, () => {
    const h = harness('windows-appcontainer-resources.js', () => {
      if (outcome === 'spawn-error') throw new Error('spawn failed')
      return { status: outcome === 'refusal' ? 1 : 0, stderr: '', stdout: JSON.stringify({ schemaVersion: 1, status: 'PLANNED', plan: { exact: true } }) }
    }, outcome === 'cleanup-error')
    const backend = h.api.nativeBackend(deepControl, 'C:\\deployment')
    if (outcome === 'success') assert.equal(backend.invoke({ operation: 'plan' }).exact, true)
    else assert.throws(() => backend.invoke({ operation: 'plan' }), outcome === 'refusal' ? { code: 'WINDOWS_RESOURCE_HELPER_FAILED' } : outcome === 'cleanup-error' ? { code: 'ENOTEMPTY' } : /spawn failed/)
    assert.deepEqual(h.created, ['autoprompt-resources-'])
    assert.deepEqual(h.removed, [h.temporary])
  })
}

for (const outcome of ['success', 'refusal', 'spawn-error', 'error-event', 'cleanup-error']) {
  test(`Windows launcher retains compiler staging until ${outcome} settles`, async () => {
    const h = harness('windows-appcontainer.js', () => {
      if (outcome === 'spawn-error') throw new Error('spawn failed')
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter()
      child.kill = () => true
      child.stdin.end = () => queueMicrotask(() => {
        assert.equal(h.removed.length, 0)
        if (outcome === 'error-event') { child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })); return }
        child.stdout.emit('data', Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'COMPLETED', result: {
          RootPid: 12, ExitCode: 0, ObservedJobMembers: 1, LauncherSessionId: 1, AppContainerSid: sid,
          StdoutBase64: '', StderrBase64: '', RootImageMatches: true, Drained: true, TimedOut: false, OutputLimit: false, Cancelled: false,
        } })))
        child.emit('close', outcome === 'refusal' ? 1 : 0, null)
      })
      return child
    }, outcome === 'cleanup-error')
    const launcher = h.api.createWindowsAppContainerLauncher({ deploymentRoot: 'C:\\deployment' })
    const result = launcher.launch({ profileName: 'Autoprompt_' + 'a'.repeat(32), profileSid: sid,
      executable: 'C:\\runtime\\node.exe', executableSha256: digest, arguments: [], cwd: 'C:\\task',
      environment: ['SystemRoot=C:\\Windows'], timeoutMs: 1000, outputLimit: 1024,
      cancellationPath: deepControl + '\\cancel' }, { leaseId: 'owned' })
    if (outcome === 'success') assert.equal((await result).drained, true)
    else await assert.rejects(result, outcome === 'refusal' ? { code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' }
      : outcome === 'error-event' ? { code: 'WINDOWS_LAUNCH_UNAVAILABLE' } : outcome === 'cleanup-error' ? { code: 'ENOTEMPTY' } : /spawn failed/)
    assert.deepEqual(h.created, ['autoprompt-launch-'])
    assert.deepEqual(h.removed, [h.temporary])
  })
}
