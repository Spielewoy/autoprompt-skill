'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')

for (const [file, problem] of [['/usr/bin/bwrap', 'missing'], ['/usr/bin/bwrap', 'directory'], ['/usr/bin/bwrap', 'not-executable'], ['/bin/bash', 'missing']]) {
  test(`static command diagnostics reject ${problem} ${file}`, t => {
    const stat = fs.statSync, access = fs.accessSync
    t.mock.method(fs, 'statSync', (candidate, ...args) => {
      if (!['/usr/bin/bwrap', '/bin/bash'].includes(candidate)) return stat(candidate, ...args)
      if (candidate === file && problem === 'missing') throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
      return { isFile: () => !(candidate === file && problem === 'directory') }
    })
    t.mock.method(fs, 'accessSync', (candidate, mode) => {
      if (!['/usr/bin/bwrap', '/bin/bash'].includes(candidate)) return access(candidate, mode)
      assert.equal(mode, fs.constants.X_OK)
      if (candidate === file && problem === 'not-executable') throw Object.assign(new Error('permission fixture'), { code: 'EACCES' })
    })
    assert.throws(() => boundary.assertCommandSandboxPrerequisites({ platform: 'linux' }), error =>
      error.code === 'COMMAND_SANDBOX_UNSUPPORTED' && error.message.includes(file) && error.message.includes('before activation'))
  })
}

function withWindowsAvailability(t, available) {
  // The public bundle API is frozen; substitute its module at the boundary seam.
  const filename = path.resolve(__dirname, '../../scripts/harness-v2-tool-boundary.cjs')
  const localRequire = require('node:module').createRequire(filename), module = { exports: {} }
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, process,
    require: name => name === '../agents/codex/workflow/windows-worker-loader.js' ? { staticAvailability: available } : localRequire(name),
  }, { filename })
  return module.exports
}

test('static Windows diagnostics refuse an unavailable packaged bundle without executing ambient Bash', t => {
  t.mock.method(require('node:child_process'), 'spawnSync', () => assert.fail('Static diagnostics must not execute an ambient runtime'))
  const api = withWindowsAvailability(t, () => ({ available: false, accepted: false, code: 'asset-presence-mismatch' }))
  const env = { SystemRoot: 'C:\\Windows', Path: 'D:\\PortableGit\\cmd', AUTOPROMPT_WINDOWS_BASH: 'E:\\Custom\\usr\\bin\\bash.exe' }
  assert.throws(() => api.assertCommandSandboxPrerequisites({ platform: 'win32', env }), error =>
    error.code === 'COMMAND_SANDBOX_UNSUPPORTED' && error.message.includes('packaged Windows worker bundle') && error.message.includes('asset-presence-mismatch'))
})

test('static Windows diagnostics require the system root and report only bundle presence', t => {
  let calls = 0
  const manifestSha256 = 'a'.repeat(64), scope = 'bounded-declared-presence-only'
  const api = withWindowsAvailability(t, () => { calls++; return { available: true, accepted: false, manifestSha256, scope } })
  assert.throws(() => api.assertCommandSandboxPrerequisites({ platform: 'win32', env: {} }), error => error.code === 'COMMAND_SANDBOX_UNSUPPORTED')
  assert.equal(calls, 0)
  const result = api.assertCommandSandboxPrerequisites({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', Path: 'D:\\Git\\cmd' } })
  assert.equal(JSON.stringify(result), JSON.stringify({ backend: 'windows-appcontainer', manifestSha256, scope }))
  assert.equal(calls, 1)
})

test('static unsupported platform diagnostics retain explicit VM guidance', () => {
  assert.throws(() => boundary.assertCommandSandboxPrerequisites({ platform: 'darwin' }), error =>
    error.code === 'COMMAND_SANDBOX_UNSUPPORTED' && error.message.includes('Linux VM runtime'))
})

for (const provider of ['claude', 'reasonix']) test(`${provider} doctor retains isolated native identity but refuses missing command prerequisites`, t => {
  const pkg = require(`../../scripts/${provider === 'reasonix' ? 'reasonix' : 'harness-v2'}-package.cjs`)
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-command-doctor-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  if (provider === 'reasonix') pkg.install(root)
  else pkg.install(provider, root)
  const native = provider === 'reasonix' ? require('../../agents/reasonix/workflow/native.js') : require('../../scripts/harness-v2-native.cjs')
  const admission = provider === 'reasonix' ? require('../../agents/reasonix/workflow/admission.js') : require('../../scripts/harness-v2-admission.cjs')
  // Native identity and signed admission are diagnostic-routing fixtures only.
  // The prerequisite error must survive both package-specific doctor routes.
  t.mock.method(native, 'probeExecutable', () => ({ version: '2.1.270' }))
  t.mock.method(admission, 'verifyAdmission', () => ({ valid: true }))
  const env = { ...process.env }
  t.mock.method(boundary, 'assertCommandSandboxPrerequisites', options => {
    assert.equal(options.env, env)
    throw new boundary.BoundaryError('COMMAND_SANDBOX_UNSUPPORTED', 'Linux command boundary requires executable /usr/bin/bwrap; install bubblewrap before activation')
  })
  const report = provider === 'reasonix' ? pkg.doctorPrerequisites(root, { env }) : pkg.doctorPrerequisites(provider, root, { env })
  assert.equal(report.payload, 'verified')
  assert.equal(report.detected, true, JSON.stringify(report))
  assert.equal(report.nativeVersion, '2.1.270')
  assert.equal(report.activation, 'unavailable')
  assert.equal(report.reason, 'command-sandbox-unsupported')
  assert.match(report.message, /install bubblewrap before activation/)
  assert.equal(fs.existsSync(path.join(root, '.autoprompt-private', 'activations')), false)
})

for (const provider of ['claude', 'reasonix']) test(`${provider} native diagnostics canonicalize their owned directory beneath an aliased OS temp root`, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-temp-alias-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const physical = path.join(root, 'physical-temp'), alias = path.join(root, 'temp-alias')
  fs.mkdirSync(physical, { mode: 0o700 })
  fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const native = provider === 'reasonix' ? require('../../agents/reasonix/workflow/native.js') : require('../../scripts/harness-v2-native.cjs')
  const stop = Object.assign(new Error('fixture stops after observing isolated native launch'), { code: 'TEMP_PROBE_OBSERVED' })
  let observedRoot
  const inspectLaunch = options => {
    observedRoot = options.cwd
    assert.equal(fs.realpathSync.native(observedRoot), observedRoot)
    assert.equal(path.dirname(observedRoot), physical)
    assert.equal(options.env.HOME, observedRoot)
  }
  let installedRoot
  if (provider === 'reasonix') {
    installedRoot = path.join(root, 'reasonix-install')
    require('../../scripts/reasonix-package.cjs').install(installedRoot)
    t.mock.method(native, 'probeExecutable', options => {
      const output = options.spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME}))'],
        { encoding: 'utf8', env: options.env, shell: false })
      assert.equal(output.status, 0, output.stderr)
      const result = JSON.parse(output.stdout)
      inspectLaunch({ cwd: result.cwd, env: { HOME: result.home } })
      throw stop
    })
  }
  // macOS exposes the system temp directory through /var -> /private/var.
  // Canonicalize only the newly created owned directory; trust paths still
  // reject linked ancestors elsewhere.
  t.mock.method(os, 'tmpdir', () => alias)
  if (provider === 'reasonix') {
    const result = require('../../scripts/reasonix-package.cjs').doctorPrerequisites(installedRoot)
    assert.equal(result.reason, 'temp-probe-observed', result.message)
  } else {
    assert.throws(() => native.probeExecutable({ provider, executable: process.execPath,
      spawnSync(_executable, _argv, options) { inspectLaunch(options); throw stop } }), { code: 'TEMP_PROBE_OBSERVED' })
  }
  assert.ok(observedRoot, 'the native probe must be reached after private temp setup')
  assert.equal(fs.existsSync(observedRoot), false, 'owned probe storage is removed after failure')
  assert.equal(fs.existsSync(alias), true, 'the ambient temp alias must remain untouched')
})
