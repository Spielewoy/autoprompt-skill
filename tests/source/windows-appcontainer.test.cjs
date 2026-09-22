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
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: directory || path.dirname(filename), Buffer, ...globals,
    process: { platform: 'win32', arch: process.arch, pid: process.pid, execPath: process.execPath,
      env: { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--require must-not-inherit', OPENAI_API_KEY: 'must-not-inherit' } },
    require: name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name),
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

test('Windows helper staging preserves its primary refusal and accounts for an unremoved owned deployment', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'windows-stage-cleanup-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const primary = Object.assign(Error('controlled staging privacy refusal'), { code: 'PRIVACY_UNSUPPORTED' })
  let owned, removed
  const helpers = windowsModule('windows-helper-deployment.js', {
    'node:fs': { ...fs, rmSync(directory, options) { removed = directory; assert.equal(options.maxRetries, 10); assert.equal(options.retryDelay, 100); throw Object.assign(Error('controlled removal refusal'), { code: 'EACCES' }) } },
    './safe-run-root.js': { ensureWindowsPrivateAcl(directory) { owned = directory; throw primary } },
    './windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent() {} } } },
  })
  assert.throws(() => helpers.stageWindowsHelperDeployment(root), error => error === primary && error.code === 'PRIVACY_UNSUPPORTED' && error.cleanupConfirmed === false && error.retainedHelperRoot === owned && error.cleanupCode === 'EACCES')
  assert.equal(removed, owned); assert.equal(path.dirname(owned), root); assert.equal(fs.statSync(owned).isDirectory(), true)
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
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe'])
    assert.equal(options.env.NODE_OPTIONS, undefined)
    assert.equal(options.env.OPENAI_API_KEY, undefined)
    assert.equal(fs.existsSync(options.env.TEMP), false, 'temporary compiler files must be removed after success and failure')
  }
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
  const safe = windowsModule('safe-run-root.js', { 'node:child_process': { spawnSync(executable, argv, options) {
    calls.push({ executable, argv, options })
    if (!options.env.AUTOPROMPT_PRIVATE_ACL_PATH) return { status: 0, signal: null, stderr: '', stdout: '' }
    const snapshot = { currentName: 'runner', currentSid, items: [{ path: options.env.AUTOPROMPT_PRIVATE_ACL_PATH,
      owner: currentSid, ownerSid: currentSid, protected: true, rules: [currentSid, 'S-1-5-18'].map(sid => ({
        identity: sid, sid, type: 'Allow', inherited: false, rights: 2032127,
        inheritanceFlags: options.env.AUTOPROMPT_PRIVATE_ACL_DIRECTORY === '1' ? 3 : 0, propagationFlags: 0,
      })) }] }
    return { status: 0, signal: null, stderr: '', stdout: JSON.stringify(mutate(snapshot)) }
  } } })
  assert.equal(safe.ensureWindowsPrivateAcl(file).supported, true)
  assert.equal(safe.ensureWindowsPrivateAcl(root).supported, true)
  const grants = calls.filter(call => call.options.env.AUTOPROMPT_PRIVATE_ACL_PATH)
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
    assert.equal(options.env.PSModulePath, undefined)
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-deletion-test-'))
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
    mkdtempSync() { base = fs.mkdtempSync(path.join(directory, 'private-')); return base },
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
        assert.equal(file, original)
        if (mode !== 'surviving-original') fs.unlinkSync(file)
        deleted = mode !== 'surviving-original'
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
    if (mode === 'unknown-recovery') throw Object.assign(Error('resource recovery unresolved'), { code: 'WINDOWS_ACL_IDENTITY_UNAVAILABLE', recovery: { leaseId: 'fixed-lease' }, cleanupConfirmed: false })
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
test('deletion canary retains its original recovery evidence when resource cleanup is unknown', async t => {
  const { result, base } = await deletionCanary(t, 'unknown-recovery')
  assert.equal(result.supported, false); assert.equal(result.code, 'WINDOWS_ACL_IDENTITY_UNAVAILABLE')
  assert.equal(result.recoveryRoot, base); assert.equal(fs.existsSync(base), true)
})
