'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { validateLaunch, parseResult, createStreamingResultParser, createWindowsAppContainerLauncher } = require('../../agents/codex/workflow/windows-appcontainer.js')
const launch = () => ({ profileName: 'Autoprompt_' + 'a'.repeat(32), profileSid: 'S-1-15-2-1-2-3-4-5-6-7', executable: 'C:\\runtime\\node.exe', executableSha256: 'b'.repeat(64),
  arguments: ['--preserve-symlinks', '--preserve-symlinks-main', 'C:\\runtime\\entry.cjs'], cwd: 'C:\\task', environment: ['SystemRoot=C:\\Windows'], timeoutMs: 1000, outputLimit: 1024, cancellationPath: 'C:\\controller\\cancel' })
const result = () => ({ schemaVersion: 1, status: 'COMPLETED', result: { RootPid: 12, ExitCode: 0, ObservedJobMembers: 2, LauncherSessionId: 1, AppContainerSid: launch().profileSid,
  StdoutBase64: Buffer.from('done').toString('base64'), StderrBase64: '', RootImageMatches: true, Drained: true, TimedOut: false, OutputLimit: false, Cancelled: false } })
test('AppContainer launch requires bounded controller identity and explicit executable binding', () => {
  assert.equal(validateLaunch(launch()).schemaVersion, 1)
  for (const value of [{ ...launch(), profileName: 'arbitrary' }, { ...launch(), executableSha256: '' }, { ...launch(), timeoutMs: 300001 }, { ...launch(), outputLimit: 1048577 }, { ...launch(), arguments: ['x\0y'] }, { ...launch(), callerHandles: [] }]) assert.throws(() => validateLaunch(value), { code: 'WINDOWS_LAUNCH_INVALID' })
})
test('AppContainer MSYS request binds only its colocated production DLL and rejects caller namespace names', () => {
  const msysRuntime = { dllPath: 'C:\\runtime\\msys-2.0.dll', dllSha256: 'c'.repeat(64), sharedId: 'msys-2.0S5' }
  const input = { ...launch(), executable: 'C:\\runtime\\bash.exe', msysRuntime }
  assert.deepEqual(validateLaunch(input).msysRuntime, msysRuntime)
  for (const runtime of [null, {}, { ...msysRuntime, namespace: '\\BaseNamedObjects\\arbitrary' },
    { ...msysRuntime, dllPath: 'C:\\elsewhere\\msys-2.0.dll' }, { ...msysRuntime, dllPath: 'C:\\runtime\\other.dll' },
    { ...msysRuntime, dllPath: 'msys-2.0.dll' }, { ...msysRuntime, dllSha256: '' },
    { ...msysRuntime, sharedId: 'msys-2.0S5-debug' }, { ...msysRuntime, sharedId: '../outside' },
  ]) assert.throws(() => validateLaunch({ ...input, msysRuntime: runtime }), { code: 'WINDOWS_LAUNCH_INVALID' })
  assert.throws(() => validateLaunch({ ...launch(), msysRuntime }), { code: 'WINDOWS_LAUNCH_INVALID' })
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
function streamedFinal(stdout, stderr = Buffer.alloc(0)) {
  return { schemaVersion: 2, status: 'COMPLETED', result: { ...result().result,
    StdoutBase64: stdout.toString('base64'), StderrBase64: stderr.toString('base64'),
    StdoutBytes: stdout.length, StderrBytes: stderr.length, StdoutChunks: stdout.length ? 1 : 0, StderrChunks: stderr.length ? 1 : 0,
    StdoutSha256: crypto.createHash('sha256').update(stdout).digest('hex'), StderrSha256: crypto.createHash('sha256').update(stderr).digest('hex') } }
}
const frame = (sequence, stream, bytes) => JSON.stringify({ schemaVersion: 2, status: 'STREAM', stream, sequence, dataBase64: bytes.toString('base64') }) + '\n'
test('AppContainer streaming validates ordered live bytes against its drained terminal receipt', () => {
  const expected = { ...launch(), streamOutput: true }, observed = []
  const parser = createStreamingResultParser(expected, { onStdout(bytes, metadata) { observed.push([metadata.sequence, bytes.toString()]) } })
  const stdout = Buffer.from('FIRST\n'), stderr = Buffer.from('note\n')
  const wire = Buffer.from(frame(1, 'stdout', stdout) + frame(2, 'stderr', stderr) + JSON.stringify(streamedFinal(stdout, stderr)) + '\n')
  parser.push(wire.subarray(0, 17)); parser.push(wire.subarray(17))
  const parsed = parser.finish()
  assert.deepEqual(observed, [[1, 'FIRST\n']]); assert.deepEqual(parsed.stdout, stdout); assert.deepEqual(parsed.stderr, stderr); assert.equal(parsed.drained, true)
})
test('AppContainer streaming rejects sequence, base64, receipt and post-terminal drift', () => {
  const expected = { ...launch(), streamOutput: true }, stdout = Buffer.from('FIRST\n')
  const attempt = lines => { const parser = createStreamingResultParser(expected); for (const line of lines) parser.push(Buffer.from(line)); return parser }
  assert.throws(() => attempt([frame(2, 'stdout', stdout)]), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  assert.throws(() => attempt([JSON.stringify({ schemaVersion: 2, status: 'STREAM', stream: 'stdout', sequence: 1, dataBase64: 'ZA' }) + '\n']), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  const wrong = streamedFinal(stdout); wrong.result.StdoutSha256 = '0'.repeat(64)
  assert.throws(() => attempt([frame(1, 'stdout', stdout), JSON.stringify(wrong) + '\n']).finish(), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  const complete = JSON.stringify(streamedFinal(Buffer.alloc(0))) + '\n'
  assert.throws(() => attempt([complete, frame(1, 'stdout', stdout)]), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  assert.throws(() => { const parser = createStreamingResultParser(expected, { onStdout() { return Promise.resolve() } }); parser.push(Buffer.from(frame(1, 'stdout', stdout))) }, { code: 'WINDOWS_LAUNCH_INVALID' })
})
test('AppContainer streaming enforces the combined output limit before live delivery', () => {
  const delivered = []
  const parser = createStreamingResultParser({ ...launch(), outputLimit: 5, streamOutput: true }, {
    onStdout(bytes) { delivered.push(bytes.toString()) }, onStderr(bytes) { delivered.push(bytes.toString()) },
  })
  parser.push(Buffer.from(frame(1, 'stdout', Buffer.from('four'))))
  assert.throws(() => parser.push(Buffer.from(frame(2, 'stderr', Buffer.from('no')))), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  assert.deepEqual(delivered, ['four'])
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

function windowsModule(file, replacements = {}, directory, globals = {}) {
  const filename = path.resolve(__dirname, '../../agents/codex/workflow', file)
  const localRequire = createRequire(filename), module = { exports: {} }
  // Model a Windows Z: volume with the actual POSIX filesystem as its backing
  // store. Production always receives drive-root paths, even on Linux CI.
  const mapVolume = process.platform !== 'win32' && path.isAbsolute(globals.userInfoHome || '')
  const logical = value => mapVolume && typeof value === 'string' && value.startsWith('/') ? 'Z:' + value.replaceAll('/', '\\') : value
  const physical = value => mapVolume && typeof value === 'string' && /^Z:\\/iu.test(value) ? value.slice(2).replaceAll('\\', '/') : value
  const mappedFs = mapVolume ? { ...fs,
    lstatSync: (value, ...args) => fs.lstatSync(physical(value), ...args),
    realpathSync: { native: value => logical(fs.realpathSync.native(physical(value))) },
    mkdtempSync: (value, ...args) => logical(fs.mkdtempSync(physical(value), ...args)),
    rmSync: (value, ...args) => fs.rmSync(physical(value), ...args),
  } : null
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: directory || path.dirname(filename), Buffer, ...globals,
    process: { platform: 'win32', arch: process.arch, pid: process.pid, execPath: process.execPath, release: globals.release || process.release, versions: globals.versions || process.versions,
      env: { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--require must-not-inherit', OPENAI_API_KEY: 'must-not-inherit', ...(globals.env || {}) } },
    require: name => Object.hasOwn(replacements, name) ? (name === './safe-run-root.js' ? { ensureWindowsDefaultTokenOwner() {}, windowsControllerEnvironment: () => ({ TEMP: require('node:os').tmpdir() }), ...replacements[name] } : replacements[name])
      : name === 'node:fs' && mappedFs ? mappedFs
      : name === 'node:path' && mappedFs ? { ...path.win32, resolve: (...values) => path.win32.resolve(...values.map(logical)) }
      : name === 'node:os' && globals.userInfoHome ? { ...require('node:os'), userInfo: () => ({ homedir: logical(globals.userInfoHome) }) }
      : localRequire(name),
  }, { filename })
  return module.exports
}

test('Windows helper watchdog allows bounded cold setup without changing the native worker deadline', () => {
  const timers = new Map(); let tick = 0, next = 0, cancelled = false, killed = false
  const module = windowsModule('windows-appcontainer.js', {}, undefined, {
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, deadline: tick + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  const request = module.validateLaunch({ ...launch(), timeoutMs: 1000 })
  const finish = module.startHelperWatchdog(request.timeoutMs, () => { cancelled = true }, () => { killed = true })
  const advance = now => { tick = now; for (const [id, timer] of [...timers]) if (timer.deadline <= tick) { timers.delete(id); timer.fn() } }
  advance(30000)
  assert.equal(cancelled, false, 'cold compiler setup must not pre-cancel a suspended worker')
  assert.equal(request.timeoutMs, 1000, 'the native request retains its exact worker deadline')
  advance(121000); assert.equal(cancelled, true); assert.equal(killed, false)
  advance(136000); assert.equal(killed, true, 'helper cleanup must retain a finite outer bound')
  finish(); assert.equal(timers.size, 0)
})

test('Windows helper staging copies only bound native files into verified private controller storage', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-stage-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const calls = [], original = path.resolve(__dirname, '../../agents/codex/workflow')
  const modes = fs.statSync(original).mode
  const deployment = windowsModule('windows-helper-deployment.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl(directory) { calls.push(['private', directory]) }, auditPrivatePermissions() {},
      inspectPathNoFollow(directory) { const stat = fs.lstatSync(directory); return { exists: true, realpath: fs.realpathSync.native(directory), identity: { dev: String(stat.dev), ino: String(stat.ino) } } } },
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
  assert.deepEqual(Object.keys(deployment.cleanupBinding).sort(), ['identity', 'root'])
  deployment.cleanup()
  deployment.cleanup()
  assert.deepEqual(fs.readdirSync(root), [])
})

test('Windows helper staging uses the authenticated short compiler root for a deep controller deployment', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-stage-short-')))
  const control = path.join(base, ...Array.from({ length: 10 }, (_, index) => `deep-${index}-${'x'.repeat(24)}`))
  const localAppData = path.join(base, 'local')
  fs.mkdirSync(control, { recursive: true }); fs.mkdirSync(localAppData)
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const calls = []
  const helper = windowsModule('windows-helper-deployment.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl(directory) { calls.push(['private', directory]) }, auditPrivatePermissions(directory) { calls.push(['audit', directory]) },
      createWindowsCompilerDirectory(prefix) { return fs.mkdtempSync(path.join(localAppData, prefix)) },
      windowsControllerEnvironment() { return { LOCALAPPDATA: localAppData } },
      inspectPathNoFollow(directory) { const stat = fs.lstatSync(directory); return { exists: true, realpath: fs.realpathSync.native(directory), identity: { dev: String(stat.dev), ino: String(stat.ino) } } } },
    './windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent(file) { calls.push(['verify', path.dirname(file)]) } } } },
  })
  const deployment = helper.stageWindowsHelperDeployment(control, { shortPrivateRoot: true })
  assert.equal(path.dirname(deployment.root), localAppData)
  assert.notEqual(path.dirname(deployment.root), control)
  assert.match(path.basename(deployment.root), /^native-helpers-[A-Za-z0-9]{6}$/)
  assert.ok(calls.some(([kind, directory]) => kind === 'audit' && directory === deployment.root), 'external helper root receives a protected-DACL audit')
  const moved = deployment.root + '-moved'
  fs.renameSync(deployment.root, moved); fs.mkdirSync(deployment.root)
  assert.throws(() => deployment.cleanup(), { code: 'WINDOWS_RUNTIME_MISMATCH' })
  assert.equal(fs.existsSync(deployment.root), true, 'cleanup never deletes a replacement at the staged name')
  assert.throws(() => helper.assertTrustedWindowsHelperDeployment(control, path.join(base, 'untrusted', 'native-helpers-ABC123')), { code: 'WINDOWS_RUNTIME_MISMATCH' })
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
    './safe-run-root.js': { ensureWindowsPrivateAcl() {}, inspectPathNoFollow(directory) { const stat = fs.lstatSync(directory); return { exists: true, realpath: fs.realpathSync.native(directory), identity: { dev: String(stat.dev), ino: String(stat.ino) } } } },
    './windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent() {} } } },
  }, source)
  assert.throws(() => unsafe.stageWindowsHelperDeployment(control), { code: 'WINDOWS_RUNTIME_MISMATCH' })
  assert.deepEqual(fs.readdirSync(control), [])
})

test('Windows helper staging preserves its primary refusal and accounts for an unremoved owned deployment', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-stage-cleanup-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const primary = Object.assign(Error('controlled staging privacy refusal'), { code: 'PRIVACY_UNSUPPORTED' })
  let owned, removed
  const helpers = windowsModule('windows-helper-deployment.js', {
    'node:fs': { ...fs, rmSync(directory, options) { removed = directory; assert.equal(options.maxRetries, 10); assert.equal(options.retryDelay, 100); throw Object.assign(Error('controlled removal refusal'), { code: 'EACCES' }) } },
    './safe-run-root.js': { ensureWindowsPrivateAcl(directory) { owned = directory; throw primary }, inspectPathNoFollow(directory) { const stat = fs.lstatSync(directory); return { exists: true, realpath: fs.realpathSync.native(directory), identity: { dev: String(stat.dev), ino: String(stat.ino) } } } },
    './windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent() {} } } },
  })
  assert.throws(() => helpers.stageWindowsHelperDeployment(root), error => error === primary && error.code === 'PRIVACY_UNSUPPORTED' && error.cleanupConfirmed === false && error.retainedHelperRoot === owned && error.cleanupCode === 'EACCES')
  assert.equal(removed, owned); assert.equal(path.dirname(owned), root); assert.equal(fs.statSync(owned).isDirectory(), true)
})

const windowsFixturePath = value => process.platform === 'win32' ? value : 'Z:' + value.replaceAll('/', '\\')
const physicalFixturePath = value => process.platform === 'win32' ? value : value.slice(2).replaceAll('\\', '/')

test('native Windows token profile bootstrap needs no inherited profile or compiler temp', { skip: process.platform !== 'win32', timeout: 45000 }, t => {
  const os = require('node:os')
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'token-profile-isolated-'))
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }))
  let queryCount = 0
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { ...cp, spawnSync(file, argv, options) {
    queryCount++
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) assert.equal(options.env[name], undefined)
    return cp.spawnSync(file, argv, options)
  } } }, undefined, { versions: { ...process.versions, bun: 'native-profile-probe' },
    env: { SystemRoot: process.env.SystemRoot, HOME: isolated, USERPROFILE: isolated, APPDATA: isolated, LOCALAPPDATA: isolated, TEMP: path.join(isolated, 'absent'), TMP: path.join(isolated, 'absent') } })
  const environment = safe.windowsControllerEnvironment(process.env.SystemRoot)
  assert.equal(queryCount, 1)
  assert.equal(environment.USERPROFILE.toLowerCase(), fs.realpathSync.native(os.userInfo().homedir).toLowerCase())
  assert.notEqual(environment.USERPROFILE.toLowerCase(), isolated.toLowerCase())
  assert.equal(environment.TEMP.toLowerCase(), fs.realpathSync.native(path.join(os.userInfo().homedir, 'AppData', 'Local', 'Temp')).toLowerCase())
})

test('Windows ownership setup keeps a bounded cold-start allowance and never caches a failed privacy proof', t => {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'compiler-profile-')))
  fs.mkdirSync(path.join(profile, 'AppData', 'Local', 'Temp'), { recursive: true }); fs.mkdirSync(path.join(profile, 'AppData', 'Roaming'), { recursive: true })
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  const attempts = [], aclAttempts = []
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(file, argv, options) {
    if (options.env.AUTOPROMPT_PRIVATE_ACL_PATH) {
      aclAttempts.push({ file, argv, options })
      const item = { path: options.env.AUTOPROMPT_PRIVATE_ACL_PATH, owner: 'S-1-5-21-1', ownerSid: 'S-1-5-21-1', protected: true,
        rules: [{ identity: 'S-1-5-21-1', sid: 'S-1-5-21-1', type: 'Allow', inherited: false, rights: 2032127, inheritanceFlags: 3, propagationFlags: 0 },
          { identity: 'S-1-5-18', sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 2032127, inheritanceFlags: 3, propagationFlags: 0 }] }
      return { status: 0, signal: null, stderr: '', stdout: JSON.stringify({ currentName: 'TEST\\user', currentSid: 'S-1-5-21-1', items: [item] }) }
    }
    attempts.push({ file, argv, options })
    return attempts.length === 1
      ? { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: 'TOKEN_OWNER_COMPILING\n', stderr: 'bounded native diagnostic' }
      : { status: 0, signal: null, stderr: '' }
  } } }, undefined, { userInfoHome: profile })
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
  assert.equal(aclAttempts.length, 2)
  for (const { file, options } of attempts) {
    assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.ok(options.timeout > 15000 && options.timeout <= 60000)
    assert.equal(options.shell, false)
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe'])
    assert.equal(options.env.NODE_OPTIONS, undefined)
    assert.equal(options.env.OPENAI_API_KEY, undefined)
    assert.equal(options.env.USERPROFILE, windowsFixturePath(fs.realpathSync.native(profile)))
    assert.equal(options.env.HOME, windowsFixturePath(fs.realpathSync.native(profile)))
    assert.equal(options.env.APPDATA, windowsFixturePath(fs.realpathSync.native(path.join(profile, 'AppData', 'Roaming'))))
    assert.equal(options.env.LOCALAPPDATA, windowsFixturePath(fs.realpathSync.native(path.join(profile, 'AppData', 'Local'))))
    assert.equal(options.env.HOMEDRIVE, windowsFixturePath(profile).slice(0,2))
    assert.equal(options.env.HOMEPATH, windowsFixturePath(fs.realpathSync.native(profile)).slice(2))
    const expectedCompilerParent = windowsFixturePath(fs.realpathSync.native(path.join(profile, 'AppData', 'Local')))
    assert.equal(path.win32.dirname(options.env.TEMP), expectedCompilerParent)
    assert.match(path.win32.basename(options.env.TEMP), /^autoprompt-token-owner-[A-Za-z0-9]{6}$/)
    assert.equal(fs.existsSync(physicalFixturePath(options.env.TEMP)), false, 'temporary compiler files must be removed after success and failure')
  }
})

test('Windows ownership setup preserves a Unicode known folder and ignores hostile ambient local-app-data variables', t => {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'compiler-Å-用户-')))
  const knownFolder = path.join(profile, 'AppData', 'Local')
  fs.mkdirSync(path.join(knownFolder, 'Temp'), { recursive: true }); fs.mkdirSync(path.join(profile, 'AppData', 'Roaming'), { recursive: true })
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  const acl = []
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(file, argv, options) {
    if (options.env.AUTOPROMPT_PRIVATE_ACL_PATH) {
      acl.push(options)
      const sid = 'S-1-5-21-1', directory = options.env.AUTOPROMPT_PRIVATE_ACL_DIRECTORY === '1'
      const rule = value => ({ identity: value, sid: value, type: 'Allow', inherited: false, rights: 2032127, inheritanceFlags: directory ? 3 : 0, propagationFlags: 0 })
      return { status: 0, signal: null, stderr: '', stdout: JSON.stringify({ currentName: 'TEST\\user', currentSid: sid, items: [{ path: options.env.AUTOPROMPT_PRIVATE_ACL_PATH, owner: sid, ownerSid: sid, protected: true, rules: [rule(sid), rule('S-1-5-18')] }] }) }
    }
    return { status: 0, signal: null, stderr: '', stdout: '' }
  } } }, undefined, { env: { LOCALAPPDATA: 'C:\\attacker-controlled-root' }, userInfoHome: profile })
  assert.equal(safe.ensureWindowsDefaultTokenOwner().supported, true)
  assert.equal(acl.length, 1)
  assert.equal(path.win32.dirname(acl[0].env.AUTOPROMPT_PRIVATE_ACL_PATH), windowsFixturePath(knownFolder))
})

test('bundled Bun resolves Windows token folders without trusting isolated profile variables', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bun-known-folders-')))
  const profile = path.join(base, 'token-profile'), hostile = path.join(base, 'isolated-home')
  for (const directory of [path.join(profile, 'AppData', 'Local', 'Temp'), path.join(profile, 'AppData', 'Roaming'), hostile]) fs.mkdirSync(directory, { recursive: true })
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  let query
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(file, argv, options) {
    query = { file, argv, options }
    return { status: 0, signal: null, stderr: '', stdout: JSON.stringify({
      profile: windowsFixturePath(profile), local: windowsFixturePath(path.join(profile, 'AppData', 'Local')),
      roaming: windowsFixturePath(path.join(profile, 'AppData', 'Roaming')),
    }) }
  } } }, undefined, { userInfoHome: hostile, versions: { ...process.versions, bun: '1.3.14' },
    env: { HOME: windowsFixturePath(hostile), USERPROFILE: windowsFixturePath(hostile), APPDATA: windowsFixturePath(hostile), LOCALAPPDATA: windowsFixturePath(hostile) } })
  const environment = safe.windowsControllerEnvironment('C:\\Windows')
  assert.equal(query.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.match(query.argv.at(-1), /DefinePInvokeMethod\('GetUserProfileDirectory','userenv\.dll'/)
  assert.match(query.argv.at(-1), /WindowsIdentity\]::GetCurrent\(\)/)
  assert.doesNotMatch(query.argv.at(-1), /GetFolderPath|Add-Type/)
  assert.deepEqual({ ...query.options.env }, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SystemDrive: 'C:', PATH: 'C:\\Windows\\System32' })
  assert.equal(environment.USERPROFILE, windowsFixturePath(profile))
  assert.equal(environment.HOME, windowsFixturePath(profile))
  assert.equal(environment.LOCALAPPDATA, windowsFixturePath(path.join(profile, 'AppData', 'Local')))
  assert.equal(environment.APPDATA, windowsFixturePath(path.join(profile, 'AppData', 'Roaming')))
  assert.equal(environment.TEMP, windowsFixturePath(path.join(profile, 'AppData', 'Local', 'Temp')))
})

test('Windows ownership setup refuses an invalid authoritative local-app-data result', () => {
  const safe = windowsModule('safe-run-root.js', {}, undefined, { userInfoHome: 'relative-profile' })
  assert.throws(() => safe.ensureWindowsDefaultTokenOwner(), { code: 'PRIVACY_UNSUPPORTED' })
})

test('Windows controller environment replaces hostile inherited profile fields and preserves private temp', t => {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'controller-env-')))
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  for (const name of ['AppData/Local/Temp', 'AppData/Roaming', 'private-temp']) fs.mkdirSync(path.join(profile, name), { recursive: true })
  const privateTemp = windowsFixturePath(path.join(profile, 'private-temp'))
  const hostile = Object.fromEntries(['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemDrive', 'NODE_OPTIONS', 'SECRET'].map(key => [key, 'must-not-inherit']))
  const safe = windowsModule('safe-run-root.js', {}, undefined, { userInfoHome: profile, env: hostile })
  const environment = safe.windowsControllerEnvironment('D:\\Windows', privateTemp)
  const home = windowsFixturePath(profile)
  assert.deepEqual({ ...environment }, { SystemRoot: 'D:\\Windows', WINDIR: 'D:\\Windows', SystemDrive: 'D:', PATH: 'D:\\Windows\\System32', PSModulePath: '', USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0,2), HOMEPATH: home.slice(2), APPDATA: path.win32.join(home,'AppData','Roaming'), LOCALAPPDATA: path.win32.join(home,'AppData','Local'), TEMP: privateTemp, TMP: privateTemp })
  assert.equal(safe.windowsControllerEnvironment('D:\\Windows').TEMP, path.win32.join(home,'AppData','Local','Temp'))
  assert.throws(() => safe.windowsControllerEnvironment('D:\\Windows', path.win32.join(home,'missing')), { code: 'PRIVACY_UNSUPPORTED' })
  assert.throws(() => safe.windowsControllerEnvironment('relative'), { code: 'PRIVACY_UNSUPPORTED' })
  for (const homedir of ['relative', '\\\\server\\share\\profile']) {
    const invalid = windowsModule('safe-run-root.js', { 'node:os': { userInfo: () => ({ homedir }) } })
    assert.throws(() => invalid.windowsControllerEnvironment('D:\\Windows'), { code: 'PRIVACY_UNSUPPORTED' })
  }
})

test('Windows ACL audit resolves inbox PowerShell independently of the restricted controller PATH', t => {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'audit-env-')))
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  for (const name of ['AppData/Local/Temp', 'AppData/Roaming']) fs.mkdirSync(path.join(profile,name), { recursive: true })
  let called = false
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(executable, argv, options) {
    called = true
    assert.equal(executable, path.win32.join('C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    assert.equal(options.env.PATH, path.win32.join('C:', 'Windows', 'System32'))
    assert.equal(options.env.USERPROFILE, windowsFixturePath(profile))
    assert.equal(options.env.NODE_OPTIONS, undefined)
    const script = argv.at(-1)
    assert.ok(script.indexOf("SetEnvironmentVariable('PSModulePath'") < script.indexOf('ConvertFrom-Json'))
    assert.doesNotMatch(script, /Select-Object/)
    for (const phase of ['parsed', 'enumerated', 'identity', 'dedupe']) assert.match(script, new RegExp(`AUTOPROMPT_ACL_AUDIT_PHASE=${phase}`))
    const sid = 'S-1-5-21-123', targets = JSON.parse(options.env.AUTOPROMPT_ACL_AUDIT_PATHS)
    return { status: 0, stdout: JSON.stringify({ currentName: 'user', currentSid: sid, items: targets.map(target => ({ path: target, owner: sid, ownerSid: sid, protected: true, rules: [{ identity: sid, sid, type: 'Allow' }] })) }), stderr: 'AUTOPROMPT_ACL_AUDIT_PHASE=targets\nAUTOPROMPT_ACL_AUDIT_PHASE=emit\n' }
  } } }, undefined, { userInfoHome: profile })
  assert.equal(safe.auditPrivatePermissions(profile, { recurse: false }).valid, true)
  assert.equal(called, true)
})

test('Windows ACL audit exposes only a fixed phase marker on bounded PowerShell failure', t => {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'audit-phase-')))
  const target = path.join(profile, 'private'); fs.mkdirSync(target)
  fs.mkdirSync(path.join(profile, 'AppData', 'Local', 'Temp'), { recursive: true })
  fs.mkdirSync(path.join(profile, 'AppData', 'Roaming'), { recursive: true })
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync() {
    return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: 'AUTOPROMPT_ACL_AUDIT_PHASE=targets\nAUTOPROMPT_ACL_AUDIT_PHASE=get-acl\nGet-Acl: C:\\private\\secret' }
  } } }, undefined, { userInfoHome: profile })
  assert.throws(() => safe.auditPrivatePermissions(windowsFixturePath(target), { recurse: false }), error => {
    assert.equal(error.code, 'PRIVACY_UNSUPPORTED')
    assert.equal(error.details.phase, 'get-acl')
    assert.equal(error.details.cause, 'ETIMEDOUT')
    assert.equal(error.details.stderr, 'Get-Acl: C:\\private\\secret')
    assert.match(error.message, /phase=get-acl, status=none, cause=ETIMEDOUT/)
    return true
  })
})

test('Windows ACL audit rejects a caller-selected path replaced during the PowerShell query', t => {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'audit-identity-')))
  const target = path.join(profile, 'private'), held = path.join(profile, 'held')
  fs.mkdirSync(target)
  fs.mkdirSync(path.join(profile, 'AppData', 'Local', 'Temp'), { recursive: true })
  fs.mkdirSync(path.join(profile, 'AppData', 'Roaming'), { recursive: true })
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(executable, argv, options) {
    fs.renameSync(target, held)
    fs.mkdirSync(target)
    const sid = 'S-1-5-21-123', audited = JSON.parse(options.env.AUTOPROMPT_ACL_AUDIT_PATHS)[0]
    return { status: 0, stdout: JSON.stringify({ currentName: 'user', currentSid: sid, items: [{ path: audited, owner: sid, ownerSid: sid, protected: true, rules: [{ identity: sid, sid, type: 'Allow' }] }] }), stderr: '' }
  } } }, undefined, { userInfoHome: profile })
  assert.throws(() => safe.auditPrivatePermissions(windowsFixturePath(target), { recurse: false }), {
    code: 'PRIVACY_VIOLATION',
  })
})

test('Windows ACL audit batches independently protected physical roots without weakening either DACL', t => {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'audit-batch-')))
  const root = path.join(profile, 'root'), sibling = path.join(profile, 'sibling')
  fs.mkdirSync(root); fs.mkdirSync(sibling)
  fs.mkdirSync(path.join(profile, 'AppData', 'Local', 'Temp'), { recursive: true })
  fs.mkdirSync(path.join(profile, 'AppData', 'Roaming'), { recursive: true })
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  let protectSibling = true, omitSibling = false, duplicateRoot = false, calls = 0
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(executable, argv, options) {
    calls++
    const sid = 'S-1-5-21-123', selected = JSON.parse(options.env.AUTOPROMPT_ACL_AUDIT_PATHS)
    const items = selected.map((selectedPath, index) => ({ path: selectedPath, owner: sid, ownerSid: sid,
      protected: index === 0 || protectSibling, rules: [{ identity: sid, sid, type: 'Allow' }] }))
    if (omitSibling) items.pop()
    if (duplicateRoot) items.push({ ...items[0] })
    return { status: 0, stdout: JSON.stringify({ currentName: 'user', currentSid: sid, items }), stderr: '' }
  } } }, undefined, { userInfoHome: profile })
  const rootPath = windowsFixturePath(root), siblingPath = windowsFixturePath(sibling)
  const options = { recurse: false, additionalPaths: [siblingPath], requiredProtectedPaths: [rootPath, siblingPath] }
  const accepted = safe.auditPrivatePermissions(rootPath, options)
  assert.equal(accepted.valid, true); assert.equal(accepted.mechanism, 'windows-dacl'); assert.equal(accepted.paths, 2)
  protectSibling = false
  assert.throws(() => safe.auditPrivatePermissions(rootPath, options), { code: 'PRIVACY_VIOLATION' })
  protectSibling = true; omitSibling = true
  assert.throws(() => safe.auditPrivatePermissions(rootPath, options), { code: 'PRIVACY_UNSUPPORTED' })
  omitSibling = false; duplicateRoot = true
  assert.throws(() => safe.auditPrivatePermissions(rootPath, options), { code: 'PRIVACY_UNSUPPORTED' })
  const before = calls
  assert.throws(() => safe.auditPrivatePermissions(rootPath, { ...options, requiredProtectedPaths: [rootPath, rootPath] }), { code: 'PRIVACY_UNSUPPORTED' })
  assert.throws(() => safe.auditPrivatePermissions(rootPath, { ...options, requiredProtectedPaths: [rootPath, windowsFixturePath(profile)] }), { code: 'PRIVACY_UNSUPPORTED' })
  assert.equal(calls, before, 'invalid batch authority must refuse before PowerShell starts')
})

test('native Windows compiler staging ignores deep home and temp overrides', { skip: process.platform !== 'win32' }, () => {
  const helper = path.resolve(__dirname, '../../agents/codex/workflow/safe-run-root.js')
  const child = `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process')
    const safe = require(${JSON.stringify(helper)})
    const directory = safe.createWindowsCompilerDirectory('autoprompt-native-')
    try {
      const expected = fs.realpathSync.native(path.join(os.userInfo().homedir, 'AppData', 'Local'))
      if (fs.realpathSync.native(path.dirname(directory)) !== expected) throw new Error('compiler directory escaped the token profile local data root')
      const environment = safe.windowsControllerEnvironment(process.env.SystemRoot, directory)
      const home = fs.realpathSync.native(os.userInfo().homedir)
      const expectedEnvironment = { USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0,2), HOMEPATH: home.slice(2), APPDATA: fs.realpathSync.native(path.join(home,'AppData','Roaming')), LOCALAPPDATA: expected, TEMP: directory, TMP: directory, SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemRoot.slice(0,2) }
      for (const [key,value] of Object.entries(expectedEnvironment)) if (environment[key] !== value) throw new Error('native controller environment mismatch: ' + key)
      const powershell = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const nativeSource = ${JSON.stringify(path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs'))}
      const reflection = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -Path '" + nativeSource.replace(/'/g, "''") + "';$m=[WindowsAppContainerNative].GetMethod('PrepareControllerProfileEnvironment',[Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::NonPublic);$r=$m.Invoke($null,(,[string[]]@(('SystemRoot='+$env:SystemRoot),'TEMP=owned','LOCALAPPDATA=caller')));[Console]::Out.WriteLine(($r|Where-Object {$_ -like 'LOCALAPPDATA=*'}))"
      const prepared = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', reflection], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 64 * 1024, env: environment })
      if (prepared.error || prepared.signal || prepared.status !== 0 || prepared.stderr || prepared.stdout.trim() !== 'LOCALAPPDATA=' + expected) throw new Error('native profile environment probe failed: ' + (prepared.stderr || prepared.stdout || prepared.error?.message || prepared.status))
      const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';Add-Type -TypeDefinition 'public sealed class AutopromptNativeCompilerProbe { public static int Value { get { return 1; } } }';if([AutopromptNativeCompilerProbe]::Value -ne 1){throw 'compiler probe failed'}"], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 64 * 1024, env: environment })
      if (result.error || result.signal || result.status !== 0 || result.stderr) throw new Error('real Add-Type compiler probe failed: ' + (result.stderr || result.error?.message || result.status))
    } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    if (fs.existsSync(directory)) throw new Error('compiler scratch survived cleanup')
  `
  const deep = 'C:\\autoprompt native packed\\' + 'reviewed-local-canary\\generation-1\\'.repeat(9) + 'outer-tmp'
  const result = cp.spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, env: { ...process.env, USERPROFILE: deep, HOME: deep, LOCALAPPDATA: deep, TEMP: deep, TMP: deep } })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.signal, null)
})

test('Windows private ACL replaces foreign grants with exact file or directory rights and refuses linked targets', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-acl-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'connection.json'), link = path.join(root, 'linked')
  fs.writeFileSync(file, 'fixture')
  fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  const calls = []
  let mutate = value => value
  const currentSid = 'S-1-5-21-123-456-789-1001'
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'compiler-acl-profile-')))
  fs.mkdirSync(path.join(profile, 'AppData', 'Local', 'Temp'), { recursive: true }); fs.mkdirSync(path.join(profile, 'AppData', 'Roaming'), { recursive: true })
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(executable, argv, options) {
    calls.push({ executable, argv, options })
    if (!options.env.AUTOPROMPT_PRIVATE_ACL_PATH) return { status: 0, signal: null, stderr: '', stdout: '' }
    const snapshot = { currentName: 'runner', currentSid, items: [{ path: options.env.AUTOPROMPT_PRIVATE_ACL_PATH,
      owner: currentSid, ownerSid: currentSid, protected: true, rules: [currentSid, 'S-1-5-18'].map(sid => ({
        identity: sid, sid, type: 'Allow', inherited: false, rights: 2032127,
        inheritanceFlags: options.env.AUTOPROMPT_PRIVATE_ACL_DIRECTORY === '1' ? 3 : 0, propagationFlags: 0,
      })) }] }
    return { status: 0, signal: null, stderr: '', stdout: JSON.stringify(mutate(snapshot)) }
  } } }, undefined, { userInfoHome: profile })
  assert.equal(safe.ensureWindowsPrivateAcl(file).supported, true)
  assert.equal(safe.ensureWindowsPrivateAcl(root).supported, true)
  const grants = calls.filter(call => [file, root].map(windowsFixturePath).includes(call.options.env.AUTOPROMPT_PRIVATE_ACL_PATH))
  assert.equal(grants.length, 2)
  assert.equal(grants[0].options.env.AUTOPROMPT_PRIVATE_ACL_DIRECTORY, '0')
  assert.equal(grants[1].options.env.AUTOPROMPT_PRIVATE_ACL_DIRECTORY, '1')
  for (const { executable, argv, options } of grants) {
    assert.equal(executable, path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    assert.equal(options.timeout, 60000)
    assert.equal(options.shell, false)
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe'])
    assert.equal(options.env.NODE_OPTIONS, undefined)
    assert.equal(options.env.OPENAI_API_KEY, undefined)
    assert.equal(options.env.PSModulePath, '')
    assert.match(argv.at(-1), /DirectorySecurity\]::new\(\)/)
    assert.match(argv.at(-1), /FileSecurity\]::new\(\)/)
    assert.match(argv.at(-1), /SetAccessRuleProtection\(\$true,\$false\)/)
    assert.doesNotMatch(argv.at(-1), /Get-Acl|icacls/)
  }
  const before = calls.length
  assert.throws(() => safe.ensureWindowsPrivateAcl(link), { code: 'PRIVACY_UNSUPPORTED' })
  assert.equal(calls.length, before, 'linked targets must not invoke the ACL helper')
  const mutations = [
    snapshot => { snapshot.items[0].rules.push({ ...snapshot.items[0].rules[0], identity: 'S-1-1-0', sid: 'S-1-1-0' }) },
    snapshot => { snapshot.items[0].rules.pop() },
    snapshot => { snapshot.items[0].rules[1] = { ...snapshot.items[0].rules[0] } },
    snapshot => { snapshot.items[0].rules[0].rights = 131209 },
    snapshot => { snapshot.items[0].rules[0].inheritanceFlags = 3 },
    snapshot => { snapshot.items[0].rules[0].propagationFlags = 1 },
    snapshot => { snapshot.items[0].rules[0].inherited = true },
    snapshot => { snapshot.items[0].rules[0].type = 'Deny' },
    snapshot => { snapshot.items[0].protected = false },
    snapshot => { snapshot.items[0].ownerSid = 'S-1-5-18'; snapshot.items[0].owner = 'S-1-5-18' },
    snapshot => { snapshot.items[0].path = root },
    snapshot => { snapshot.items = [] },
  ]
  for (const change of mutations) {
    mutate = snapshot => { change(snapshot); return snapshot }
    assert.throws(() => safe.ensureWindowsPrivateAcl(file), { code: 'PRIVACY_VIOLATION' })
  }
  mutate = () => null
  assert.throws(() => safe.ensureWindowsPrivateAcl(file), { code: 'PRIVACY_UNSUPPORTED' })
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
    './windows-worker-loader.js': { async captureWorkerTuple() { return {} }, describeTuple() { return { identity: 'a'.repeat(64) } } },
  })
  const identity='a'.repeat(64)
  const result = await probe.runWindowsAppContainerCanary(() => assert.fail('Privacy failure must prevent launch'), identity, probe.canaryKey(identity))
  assert.equal(result.supported, false)
  assert.equal(result.code, 'PRIVACY_UNSUPPORTED')
  assert.equal(result.launcherSessionId, null)
  assert.equal(result.diagnostic.phase, 'private-root')
  assert.equal(result.diagnostic.message, 'Cannot establish default token owner')
  assert.equal(result.diagnostic.cause, 'ETIMEDOUT')
  assert.equal(result.diagnostic.stderr.length, 2048)
  assert.equal(JSON.stringify(result).includes('must-not-disclose'), false)
})


test('canary closes the actual first listener when the second listener fails', { timeout: 10000 }, async t => {
  const net = require('node:net'), servers = [], closed = []
  const probe = windowsModule('windows-appcontainer-probe.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl() {} },
    'node:net': { ...net, createServer(handler) {
      const server = net.createServer(handler), listen = server.listen
      servers.push(server); closed.push(new Promise(resolve => server.once('close', resolve)))
      if (servers.length === 2) server.listen = function () { return listen.call(this, servers[0].address().port, '127.0.0.1') }
      return server
    } },
  })
  t.after(() => { for (const server of servers) if (server.listening) server.close() })
  const identity = 'a'.repeat(64)
  const result = await probe.runWindowsAppContainerCanary(() => assert.fail('Listener setup failure must prevent launch'), identity, probe.canaryKey(identity))
  assert.equal(result.supported, false); assert.equal(result.code, 'EADDRINUSE'); assert.equal(result.diagnostic.phase, 'loopback-control')
  assert.equal(servers.length, 2); await closed[0]; assert.equal(servers[0].listening, false)
})

test('canary cleanup failure preserves primary error and retained root for admission poisoning', async t => {
  const primary = Object.assign(Error('fixed privacy failure'), { code: 'PRIVACY_UNSUPPORTED' }); let retained
  const probe = windowsModule('windows-appcontainer-probe.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl() { throw primary } },
    'node:fs': { ...fs, rmSync(root) { retained = root; throw Object.assign(Error('fixed removal failure'), { code: 'EACCES' }) } },
  })
  t.after(() => { if (retained) fs.rmSync(retained, { recursive: true, force: true }) })
  const identity = 'a'.repeat(64)
  await assert.rejects(probe.runWindowsAppContainerCanary(() => assert.fail('Privacy failure must prevent launch'), identity, probe.canaryKey(identity)), error => error === primary && error.cleanupConfirmed === false && error.recoveryRoot === retained && error.cleanupCode === 'EACCES')
  assert.equal(fs.existsSync(retained), true)
})


test('failed listener close retains the canary fixture until controller recovery', { timeout: 10000 }, async t => {
  const net = require('node:net'), servers = []; let base, originalClose
  const probe = windowsModule('windows-appcontainer-probe.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl(root) { base ||= root } },
    'node:net': { ...net, createServer(handler) {
      const server = net.createServer(handler), listen = server.listen
      servers.push(server)
      if (servers.length === 1) { originalClose = server.close.bind(server); server.close = () => { throw Object.assign(Error('fixed listener close failure'), { code: 'ECLOSE' }) } }
      else server.listen = function () { return listen.call(this, servers[0].address().port, '127.0.0.1') }
      return server
    } },
  })
  t.after(() => { if (servers[0]?.listening) originalClose(); if (base) fs.rmSync(base, { recursive: true, force: true }) })
  const identity = 'a'.repeat(64)
  await assert.rejects(probe.runWindowsAppContainerCanary(() => assert.fail('Listener failure must prevent launch'), identity, probe.canaryKey(identity)), error => error.code === 'EADDRINUSE' && error.cleanupConfirmed === false && error.recoveryRoot === base && error.cleanupCode === 'ECLOSE')
  assert.equal(fs.existsSync(base), true); assert.equal(servers[0].listening, true)
})

for (const cleanupFails of [false, true]) test('canary accounts for root canonicalization failure when removal ' + (cleanupFails ? 'fails' : 'succeeds'), async t => {
  let owned
  const primary = Object.assign(Error('fixed canonicalization failure'), { code: 'EIO' })
  const canonical = Object.assign(function (...args) { return fs.realpathSync(...args) }, { native(root) { owned = root; throw primary } })
  const probe = windowsModule('windows-appcontainer-probe.js', {
    './safe-run-root.js': { ensureWindowsPrivateAcl() { assert.fail('Canonicalization failure precedes privacy setup') } },
    'node:fs': { ...fs, realpathSync: canonical, rmSync(root, options) {
      assert.equal(root, owned)
      if (cleanupFails) throw Object.assign(Error('fixed removal failure'), { code: 'EACCES' })
      return fs.rmSync(root, options)
    } },
  })
  t.after(() => { if (owned) fs.rmSync(owned, { recursive: true, force: true }) })
  const identity = 'a'.repeat(64), run = () => probe.runWindowsAppContainerCanary(() => assert.fail('Canonicalization failure must prevent launch'), identity, probe.canaryKey(identity))
  if (cleanupFails) await assert.rejects(run(), error => error === primary && error.cleanupConfirmed === false && error.recoveryRoot === owned && error.cleanupCode === 'EACCES')
  else { const result = await run(); assert.equal(result.supported, false); assert.equal(result.code, 'EIO'); assert.equal(result.recoveryRoot, undefined) }
  assert.equal(fs.existsSync(owned), cleanupFails)
})

// Run the actual generated Node worker against real private fixture files.
// Network, ACL helper and descendant events are controlled here; this is a
// controller/worker behavior test, not native AppContainer acceptance.
async function deletionCanary(t, mode = 'success') {
  const { EventEmitter } = require('node:events'), os = require('node:os')
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-deletion-test-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const servers = new Map(); let nextPort = 20000, original, completed = false, base
  const net = {
    createServer(callback) {
      const server = new EventEmitter(); server.listen = (port, host, ready) => { server.port = nextPort++; servers.set(server.port, { callback, server }); queueMicrotask(ready) }
      server.address = () => ({ port: server.port }); server.close = () => { servers.delete(server.port) }; return server
    },
    connect(endpoint) {
      const socket = new EventEmitter(); socket.destroy = () => {}; socket.setTimeout = () => {}
      queueMicrotask(() => { servers.get(endpoint.port).callback({ end() {} }); socket.emit('connect') }); return socket
    },
  }
  const controllerFs = { ...fs,
    mkdtempSync() { base = fs.realpathSync.native(fs.mkdtempSync(path.join(directory, 'private-'))); return base },
    lstatSync(file, options) {
      if (mode === 'absence-error' && completed && file === original) throw Object.assign(Error('bounded absence query denied'), { code: 'EACCES' })
      return fs.lstatSync(file, options)
    },
  }
  const probe = windowsModule('windows-appcontainer-probe.js', { 'node:fs': controllerFs, 'node:net': net, './safe-run-root.js': { ensureWindowsPrivateAcl() {} } }, undefined, { setImmediate })
  const identity = 'a'.repeat(64)
  const result = await probe.runWindowsAppContainerCanary(async (policy, args) => {
    original = path.join(policy.targetPath, 'delete-original')
    assert.equal(fs.readFileSync(original, 'utf8'), 'controller original')
    assert.equal(fs.lstatSync(original).nlink, 1)
    const encoded = /eval\(Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(args.command)
    assert.ok(encoded, 'execute the actual worker embedded in the Bash command')
    const workerSource = Buffer.from(encoded[1], 'base64').toString('utf8')
    let stdout = '', stderr = '', deleted = false
    const workerFs = { ...fs,
      readFileSync(file, ...options) {
        if (path.basename(file) === 'sentinel') throw Object.assign(Error('controller denied'), { code: 'EACCES' })
        return fs.readFileSync(file, ...options)
      },
      writeFileSync(file, ...options) {
        if (path.basename(file) === 'guard') throw Object.assign(Error('git denied'), { code: 'EACCES' })
        return fs.writeFileSync(file, ...options)
      },
      renameSync() { throw Object.assign(Error('git denied'), { code: 'EACCES' }) },
      unlinkSync(file) {
        if (path.basename(file) === 'guard' || mode === 'worker-delete-denied') throw Object.assign(Error('delete denied'), { code: 'EACCES' })
        if (path.basename(file) === 'child') {
          if (mode === 'new-file-delete-denied') throw Object.assign(Error('new file delete denied'), { code: 'EACCES' })
          return fs.unlinkSync(file)
        }
        assert.equal(file, original)
        if (mode !== 'surviving-original') fs.unlinkSync(file)
        deleted = mode !== 'surviving-original'
      },
      rmdirSync(directory) {
        assert.equal(path.basename(directory), 'delete-created')
        if (mode === 'new-directory-delete-denied') throw Object.assign(Error('new directory delete denied'), { code: 'EACCES' })
        if (mode !== 'surviving-created') fs.rmdirSync(directory)
      },
    }
    const workerNet = { connect() { const socket = new EventEmitter(); socket.destroy = () => {}; socket.setTimeout = () => {}; queueMicrotask(() => socket.emit('error', { code: 'EACCES' })); return socket } }
    const workerProcess = { execPath: path.join(directory, 'node.exe'), env: { AUTOPROMPT_APP_CONTAINER_SID: 'fixed-test-sid' }, stdout: { write: text => { stdout += text } }, stderr: { write: text => { stderr += text } }, exitCode: 0 }
    const workerCp = { spawn(executable, argv, options) {
      const child = new EventEmitter(); child.pid = 123
      if (path.basename(executable) === 'acl-probe.exe') {
        assert.equal(argv[0], '--acl-probe'); assert.equal(argv[2], policy.targetPath)
        fs.writeSync(options.stdio[1], 'bundle-acl-denied-v1:' + process.arch + ':' + argv[3] + ':5\n')
        queueMicrotask(() => child.emit('exit', 0))
      } else { assert.equal(executable, workerProcess.execPath); child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true } }
      return child
    } }
    await vm.runInNewContext(workerSource, { Buffer, process: workerProcess, setTimeout, require(name) { return { 'node:fs': workerFs, 'node:path': path, 'node:net': workerNet, 'node:child_process': workerCp }[name] } })
    completed = true
    if (mode === 'unknown-recovery') throw Object.assign(Error('resource recovery unresolved'), { code: 'WINDOWS_ACL_IDENTITY_UNAVAILABLE', recovery: { leaseId: 'fixed-lease' }, cleanupConfirmed: false, retainedStagingRoot: 'separately-owned-command-staging' })
    if (!['surviving-original', 'worker-delete-denied'].includes(mode)) assert.equal(deleted, true)
    return { workerIdentity: identity, status: workerProcess.exitCode === 0 ? 'completed' : 'failed', exitCode: workerProcess.exitCode, stdout, stderr, launcherSessionId: 1,
      ...(mode === 'missing-recovery' ? {} : { resourceRecovery: Object.freeze({ restored: 4, newEntries: 3, deletedEntries: mode === 'zero-recovery' ? 0 : 1 }) }) }
  }, identity, probe.canaryKey(identity))
  assert.equal(servers.size, 0)
  return { result, base, original }
}
test('generated canary deletes the host original and requires recovered deletion before admission', async t => {
  const { result, base } = await deletionCanary(t)
  assert.equal(result.supported, true)
  assert.equal(result.resourceRecovery.deletedEntries, 1); assert.equal(Object.isFrozen(result.resourceRecovery), true)
  assert.match(result.resourceRecoveryScope, /private TEMP fixture volume/)
  assert.equal(fs.existsSync(base), false)
})
for (const mode of ['surviving-original', 'absence-error', 'missing-recovery', 'zero-recovery', 'worker-delete-denied']) test('deletion canary refuses ' + mode, async t => {
  const { result, base } = await deletionCanary(t, mode)
  assert.equal(result.supported, false); assert.equal(fs.existsSync(base), false)
  if (mode === 'worker-delete-denied') assert.equal(result.probeFailure.stderr, 'APPCONTAINER_PROBE_FAILURE:delete-original:EACCES')
  else assert.equal(result.diagnostic.phase, 'original-recovery')
})
for (const mode of ['new-file-delete-denied', 'new-directory-delete-denied', 'surviving-created']) test('deletion canary refuses ' + mode, async t => {
  const { result, base } = await deletionCanary(t, mode)
  assert.equal(result.supported, false); assert.equal(fs.existsSync(base), false)
  if (mode === 'surviving-created') assert.equal(result.diagnostic.phase, 'original-recovery')
  else assert.equal(result.probeFailure.stderr, 'APPCONTAINER_PROBE_FAILURE:new-entry-delete:EACCES')
})
test('deletion canary retains its original recovery evidence when resource cleanup is unknown', async t => {
  const { result, base } = await deletionCanary(t, 'unknown-recovery')
  assert.equal(result.supported, false); assert.equal(result.code, 'WINDOWS_ACL_IDENTITY_UNAVAILABLE')
  assert.equal(result.recoveryRoot, base); assert.equal(fs.existsSync(base), true)
  assert.equal(result.retainedStagingRoot, 'separately-owned-command-staging')
})
