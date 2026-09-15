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

test('static Windows diagnostics refuse missing physical Git Bash using the supplied environment', t => {
  const attempted = []
  const realpath = fs.realpathSync.native
  t.mock.method(fs.realpathSync, 'native', (file, ...args) => {
    if (typeof file !== 'string' || !/bash\.exe$/i.test(file)) return realpath(file, ...args)
    attempted.push(file)
    throw Object.assign(new Error('missing Git Bash fixture'), { code: 'ENOENT' })
  })
  const env = { SystemRoot: 'C:\\Windows', Path: 'D:\\PortableGit\\cmd', AUTOPROMPT_WINDOWS_BASH: 'E:\\Custom\\usr\\bin\\bash.exe' }
  assert.throws(() => boundary.assertCommandSandboxPrerequisites({ platform: 'win32', env }), error =>
    error.code === 'COMMAND_SANDBOX_UNSUPPORTED' && error.message.includes('Git Bash 4.3 or newer'))
  assert.equal(attempted[0], env.AUTOPROMPT_WINDOWS_BASH)
  assert.ok(attempted.includes('D:\\PortableGit\\usr\\bin\\bash.exe'))
})

test('static Windows diagnostics require the system root and delegate the complete Bash closure', t => {
  const windows = require('../../agents/codex/workflow/windows-appcontainer-command.js')
  const bashPath = 'D:\\Git\\usr\\bin\\bash.exe'
  let calls = 0
  t.mock.method(windows, 'resolveWindowsBash', options => {
    calls += 1
    assert.equal(options.env.SystemRoot, 'C:\\Windows')
    assert.equal(options.env.PATH, 'D:\\Git\\cmd')
    return { bash: { path: bashPath } }
  })
  assert.throws(() => boundary.assertCommandSandboxPrerequisites({ platform: 'win32', env: {} }), { code: 'COMMAND_SANDBOX_UNSUPPORTED' })
  assert.equal(calls, 0)
  assert.deepEqual(boundary.assertCommandSandboxPrerequisites({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', Path: 'D:\\Git\\cmd' } }),
    { backend: 'windows-appcontainer', bashPath })
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
  assert.equal(report.detected, true)
  assert.equal(report.nativeVersion, '2.1.270')
  assert.equal(report.activation, 'unavailable')
  assert.equal(report.reason, 'command-sandbox-unsupported')
  assert.match(report.message, /install bubblewrap before activation/)
  assert.equal(fs.existsSync(path.join(root, '.autoprompt-private', 'activations')), false)
})
