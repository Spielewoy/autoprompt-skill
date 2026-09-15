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

test('AppContainer refusal preserves bounded native diagnostics and rejects unclosed diagnostic fields', () => {
  const wire = { schemaVersion: 1, status: 'REFUSED', code: 'WINDOWS_LAUNCH_REFUSED', diagnostic: 'Win32Exception:Check:5:CreateProcessAsUser' }
  assert.throws(() => parseResult(JSON.stringify(wire), launch()), error => error.code === wire.code && error.message.includes(wire.diagnostic))
  for (const invalid of [{ ...wire, diagnostic: 'x'.repeat(257) }, { ...wire, diagnostic: 'secret\\path' }, { ...wire, environment: {} }]) {
    assert.throws(() => parseResult(JSON.stringify(invalid), launch()), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  }
})

function windowsModule(file, replacements = {}, directory) {
  const filename = path.resolve(__dirname, '../../agents/codex/workflow', file)
  const localRequire = createRequire(filename), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: directory || path.dirname(filename), Buffer,
    process: { platform: 'win32', pid: process.pid, execPath: process.execPath,
      env: { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--require must-not-inherit', OPENAI_API_KEY: 'must-not-inherit' } },
    require: name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name),
  }, { filename })
  return module.exports
}

test('Windows helper staging copies only bound native files into verified private controller storage', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-stage-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const calls = [], original = path.resolve(__dirname, '../../agents/codex/workflow')
  const modes = fs.statSync(original).mode
  const deployment = windowsModule('windows-helper-deployment.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl(directory) { calls.push(['private', directory]) } },
    './windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent(file) { calls.push(['verify', path.dirname(file)]) } } } },
  }).stageWindowsHelperDeployment(root)
  assert.equal(calls[0][0], 'verify')
  assert.equal(calls[0][1], root)
  assert.equal(calls[1][0], 'private')
  assert.equal(calls[1][1], deployment.root)
  assert.deepEqual(calls[2], ['verify', deployment.root])
  assert.equal(path.dirname(deployment.root), root)
  const names = fs.readdirSync(deployment.root).sort()
  assert.deepEqual(names, ['windows-appcontainer-native.cs', 'windows-appcontainer-resources-native.cs', 'windows-appcontainer-resources.ps1', 'windows-appcontainer.ps1'])
  for (const name of names) assert.deepEqual(fs.readFileSync(path.join(deployment.root, name)), fs.readFileSync(path.join(original, name)))
  assert.equal(fs.statSync(original).mode, modes, 'the shared installed/source runtime is never relabeled')
  deployment.cleanup()
  assert.deepEqual(fs.readdirSync(root), [])
})

test('Windows helper staging refuses unverified parents and linked helper inputs without residue', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-stage-refuse-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const denied = windowsModule('windows-helper-deployment.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl() { assert.fail('Unverified parent must prevent staging') } },
    './windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent() { throw Object.assign(new Error('private parent refused'), { code: 'PREIMAGE_UNSAFE' }) } } } },
  })
  assert.throws(() => denied.stageWindowsHelperDeployment(root), { code: 'PREIMAGE_UNSAFE' })
  assert.deepEqual(fs.readdirSync(root), [])
  const source = path.join(root, 'source'), control = path.join(root, 'control')
  fs.mkdirSync(source); fs.mkdirSync(control)
  const real = path.join(root, 'linked-source.ps1')
  fs.writeFileSync(real, 'bounded helper fixture')
  fs.linkSync(real, path.join(source, 'windows-appcontainer.ps1'))
  const unsafe = windowsModule('windows-helper-deployment.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl() {} },
    './windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent() {} } } },
  }, source)
  assert.throws(() => unsafe.stageWindowsHelperDeployment(control), { code: 'WINDOWS_RUNTIME_MISMATCH' })
  assert.deepEqual(fs.readdirSync(control), [])
})

test('Windows ownership setup keeps a bounded cold-start allowance and never caches a failed privacy proof', () => {
  const attempts = []
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(file, argv, options) {
    attempts.push({ file, argv, options })
    return attempts.length === 1
      ? { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: 'TOKEN_OWNER_COMPILING\n', stderr: 'bounded native diagnostic' }
      : { status: 0, signal: null, stderr: '' }
  } } })
  assert.throws(() => safe.ensureWindowsDefaultTokenOwner(), error => {
    assert.equal(error.code, 'PRIVACY_UNSUPPORTED')
    assert.equal(error.details.stage, 'windows-default-token-owner')
    assert.equal(error.details.cause, 'ETIMEDOUT')
    assert.equal(error.details.signal, 'SIGTERM')
    assert.equal(error.details.helperPhase, 'compiling')
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

test('Windows private ACL grants usable file rights, directory inheritance, and refuses linked targets', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-acl-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'connection.json'), link = path.join(root, 'linked')
  fs.writeFileSync(file, 'fixture')
  fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  const calls = []
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(executable, argv, options) {
    calls.push({ executable, argv, options })
    return { status: 0, signal: null, stderr: '', stdout: executable === 'whoami.exe' ? '"runner","S-1-5-21-123-456-789-1001"\n' : '' }
  } } })
  safe.ensureWindowsPrivateAcl(file)
  safe.ensureWindowsPrivateAcl(root)
  const grants = calls.filter(call => call.argv.includes('/grant:r'))
  assert.equal(grants.length, 2)
  assert.ok(grants[0].argv.includes('*S-1-5-21-123-456-789-1001:F'))
  assert.ok(grants[0].argv.includes('*S-1-5-18:F'))
  assert.ok(grants[1].argv.includes('*S-1-5-21-123-456-789-1001:(OI)(CI)F'))
  assert.ok(calls.filter(call => call.executable === 'icacls.exe').every(call => call.options.timeout === 30000))
  const before = calls.filter(call => call.executable === 'icacls.exe').length
  assert.throws(() => safe.ensureWindowsPrivateAcl(link), { code: 'PRIVACY_UNSUPPORTED' })
  assert.equal(calls.filter(call => call.executable === 'icacls.exe').length, before)
})

test('Windows boundary establishes privacy on its fresh child before policy writes and audits loaded state', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-boundary-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of ['parent', 'target', 'scratch']) fs.mkdirSync(path.join(root, name))
  const native = require('../../agents/reasonix/workflow/native.js'), privateRoots = new Set()
  let audited = false
  const boundary = windowsModule('../../../scripts/harness-v2-tool-boundary.cjs', {
    '../agents/reasonix/workflow/native.js': { ...native,
      writePrivate(file, bytes) { assert.ok(privateRoots.has(path.dirname(file))); native.writePrivate(file, bytes) },
      readBound(file) { assert.equal(audited, true); return native.readBound(file) },
    },
    '../agents/codex/workflow/safe-run-root.js': { ensureWindowsPrivateAcl(directory) {
      assert.equal(path.dirname(directory), path.join(root, 'parent'))
      assert.deepEqual(fs.readdirSync(directory), [])
      privateRoots.add(directory)
    } },
    '../agents/codex/workflow/windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent(file) {
      assert.ok(privateRoots.has(path.dirname(file))); audited = true
    } } } },
    '../agents/codex/workflow/windows-appcontainer-command.js': { resolveWindowsBash() { return { bash: { path: 'C:\\Git\\usr\\bin\\bash.exe' } } } },
  })
  const policy = { readOnly: true, targetPath: path.join(root, 'target'), scratchPath: path.join(root, 'scratch'),
    readableRoots: [path.join(root, 'target'), path.join(root, 'scratch')], writableRoots: [path.join(root, 'scratch')],
    nestedDispatch: false, commandBoundary: true, externalWrites: false }
  const prepared = boundary.prepareBoundary({ provider: 'claude', root: path.join(root, 'parent'), policy })
  assert.equal(privateRoots.size, 1)
  boundary.loadBoundary(prepared.policyPath, prepared.policySha256)
  assert.equal(audited, true)
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
