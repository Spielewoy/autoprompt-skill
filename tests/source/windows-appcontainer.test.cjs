'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { validateLaunch, parseResult, createWindowsAppContainerLauncher } = require('../../agents/codex/workflow/windows-appcontainer.js')
const launch = () => ({ profileName: 'Autoprompt_' + 'a'.repeat(32), profileSid: 'S-1-15-2-1-2-3-4-5-6-7', executable: 'C:\\runtime\\node.exe', executableSha256: 'b'.repeat(64),
  arguments: ['--preserve-symlinks', '--preserve-symlinks-main', 'C:\\runtime\\entry.cjs'], cwd: 'C:\\task', environment: ['SystemRoot=C:\\Windows'], timeoutMs: 1000, outputLimit: 1024, cancellationPath: 'C:\\controller\\cancel' })
const result = () => ({ schemaVersion: 1, status: 'COMPLETED', result: { RootPid: 12, ExitCode: 0, ObservedJobMembers: 2, LauncherSessionId: 1, AppContainerSid: launch().profileSid,
  StdoutBase64: Buffer.from('done').toString('base64'), StderrBase64: '', RootImageMatches: true, Drained: true, TimedOut: false, OutputLimit: false, Cancelled: false } })
test('AppContainer launch requires bounded controller identity and explicit executable binding', () => {
  assert.equal(validateLaunch(launch()).schemaVersion, 1)
  for (const value of [{ ...launch(), profileName: 'arbitrary' }, { ...launch(), executableSha256: '' }, { ...launch(), timeoutMs: 300001 }, { ...launch(), outputLimit: 1048577 }, { ...launch(), arguments: ['x\0y'] }, { ...launch(), callerHandles: [] }]) assert.throws(() => validateLaunch(value), { code: 'WINDOWS_LAUNCH_INVALID' })
})
test('AppContainer result cannot claim completion without exact SID, image and process drain', () => {
  const parsed = parseResult(JSON.stringify(result()), launch())
  assert.equal(parsed.drained, true); assert.equal(parsed.stdout.toString(), 'done')
  for (const changes of [{ Drained: false }, { RootImageMatches: false }, { AppContainerSid: 'S-1-15-2-7-6-5-4-3-2-1' }, { RootPid: 0 }, { ObservedJobMembers: 1025 }, { ExitCode: -1 }]) {
    const wire = result(); Object.assign(wire.result, changes)
    assert.throws(() => parseResult(JSON.stringify(wire), launch()), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  }
})
test('AppContainer output remains canonical and bounded after native execution', () => {
  for (const output of ['ZA', '!invalid!', Buffer.alloc(1025).toString('base64')]) {
    const wire = result(); wire.result.StdoutBase64 = output
    assert.throws(() => parseResult(JSON.stringify(wire), launch()), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  }
  assert.throws(() => parseResult(JSON.stringify({ schemaVersion: 1, status: 'REFUSED', code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' }), launch()), { code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' })
})
test('AppContainer runtime is never advertised on other operating systems', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => createWindowsAppContainerLauncher(), { code: 'COMMAND_SANDBOX_UNSUPPORTED' })
})

function windowsModule(file, replacements = {}) {
  const filename = path.resolve(__dirname, '../../agents/codex/workflow', file)
  const localRequire = createRequire(filename), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer,
    process: { platform: 'win32', pid: process.pid, execPath: process.execPath,
      env: { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--require must-not-inherit', OPENAI_API_KEY: 'must-not-inherit' } },
    require: name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name),
  }, { filename })
  return module.exports
}

test('Windows ownership setup keeps a bounded cold-start allowance and never caches a failed privacy proof', () => {
  const attempts = []
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(file, argv, options) {
    attempts.push({ file, argv, options })
    return attempts.length === 1
      ? { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stderr: 'bounded native diagnostic' }
      : { status: 0, signal: null, stderr: '' }
  } } })
  assert.throws(() => safe.ensureWindowsDefaultTokenOwner(), error => {
    assert.equal(error.code, 'PRIVACY_UNSUPPORTED')
    assert.equal(error.details.stage, 'windows-default-token-owner')
    assert.equal(error.details.cause, 'ETIMEDOUT')
    assert.equal(error.details.signal, 'SIGTERM')
    return true
  })
  assert.equal(safe.ensureWindowsDefaultTokenOwner().supported, true)
  assert.equal(safe.ensureWindowsDefaultTokenOwner().supported, true)
  assert.equal(attempts.length, 2, 'a failure must remain retryable, while only the successful ownership proof is cached')
  for (const { file, options } of attempts) {
    assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.ok(options.timeout > 15000 && options.timeout <= 60000)
    assert.equal(options.shell, false)
    assert.equal(options.env.NODE_OPTIONS, undefined)
    assert.equal(options.env.OPENAI_API_KEY, undefined)
    assert.equal(fs.existsSync(options.env.TEMP), false, 'temporary compiler files must be removed after success and failure')
  }
})

test('Windows AppContainer probe reports bounded native privacy causes before launch without exposing arbitrary details', async () => {
  const probe = windowsModule('windows-appcontainer-probe.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl() {
      throw Object.assign(new Error('Cannot establish default token owner'), { code: 'PRIVACY_UNSUPPORTED', details: {
        stage: 'windows-default-token-owner', status: null, cause: 'ETIMEDOUT', signal: 'SIGTERM', timeoutMs: 60000,
        stderr: 'native failure '.repeat(500), environment: { OPENAI_API_KEY: 'must-not-disclose' }, arbitrary: 'must-not-disclose',
      } })
    } },
    './windows-appcontainer-command.js': { runWindowsAppContainerCommand() { assert.fail('Privacy failure must prevent launch') } },
  })
  const result = await probe.probeWindowsAppContainer()
  assert.equal(result.supported, false)
  assert.equal(result.code, 'PRIVACY_UNSUPPORTED')
  assert.equal(result.launcherSessionId, null)
  assert.equal(result.diagnostic.phase, 'private-root')
  assert.equal(result.diagnostic.message, 'Cannot establish default token owner')
  assert.equal(result.diagnostic.cause, 'ETIMEDOUT')
  assert.equal(result.diagnostic.stderr.length, 2048)
  assert.equal(JSON.stringify(result).includes('must-not-disclose'), false)
})
