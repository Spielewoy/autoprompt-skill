'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const host = require('../../scripts/lima-runtime.cjs')
const guest = require('../../scripts/lima-runtime-guest.cjs')
const lifecycle = require('../../scripts/lima-runtime-guest-lifecycle.cjs')
const cli = require('../../bin/autoprompt.cjs')
const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')

test('Lima guest rejects transport control, arbitrary executables, host paths, and self-admission', () => {
  const request = value => guest.parseRequest(Buffer.from(JSON.stringify(value)))
  const configuredCodex = { provider: 'codex', endpoint: 'http://127.0.0.1:8080/v1', target: '/work', credentialSha256: 'a'.repeat(64) }
  const configuredHermes = { provider: 'hermes', endpoint: 'https://gateway.example.invalid/v1', target: '/work', credentialSha256: 'b'.repeat(64) }
  assert.throws(() => request({ schemaVersion: 1, action: 'exec', argv: [], env: { PATH: '/evil' } }), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => request({ schemaVersion: 1, action: 'status', archiveSha256: 'a'.repeat(64) }), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => request({ schemaVersion: 1, action: 'exec', argv: ['version'] }), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => request({ schemaVersion: 1, action: 'exec', requestId: 'A'.repeat(32), argv: ['version'] }), { code: 'LIMA_REQUEST_INVALID' })
  assert.deepEqual(request({ schemaVersion: 1, action: 'cancel', requestId: 'a'.repeat(32) }), { schemaVersion: 1, action: 'cancel', requestId: 'a'.repeat(32) })
  assert.throws(() => request({ schemaVersion: 1, action: 'exec', argv: ['version\0bad'] }), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => guest.parseRequest(Buffer.alloc(guest.MAX_REQUEST + 1)), { code: 'LIMA_REQUEST_INVALID' })
  assert.deepEqual(guest.commandArgv(['activate', 'codex', '--', '$(touch /host/pwned)'], cli, configuredCodex), ['activate', 'codex', '--root', '/home/autoprompt/runtime/providers/codex', '--target', '/work', '--', '$(touch /host/pwned)'])
  assert.throws(() => guest.commandArgv(['activate', 'codex', '--vm-root', '/another-controller', '--', 'work'], cli, configuredCodex), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => guest.commandArgv(['activate', 'codex', '--wsl-root', '/another-controller', '--', 'work'], cli, configuredCodex), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => guest.commandArgv(['activate', 'claude', '--', 'work'], cli, configuredCodex), { code: 'LIMA_PROVIDER_CONFIG_INVALID' })
  assert.deepEqual(guest.commandArgv(['activate', 'hermes', '--', 'work'], cli, configuredHermes), ['activate', 'hermes', '--root', '/home/autoprompt/runtime/providers/hermes', '--target', '/work', '--', 'work'])
  assert.throws(() => guest.commandArgv(['activate', 'hermes', '--root', '/host/provider', '--', 'work'], cli, configuredHermes), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => guest.commandArgv(['activate', 'hermes', '--target', '/host/target', '--', 'work'], cli, configuredHermes), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => guest.commandArgv(['install', 'codex', '--root', '/host/control'], cli, configuredCodex), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => guest.commandArgv(['configure', 'codex', '--agents', 'auto', '--model-map', '/host/secrets'], cli, configuredCodex), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => guest.commandArgv(['conformance', '--native-tests'], cli, configuredCodex), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => guest.commandArgv(['update'], cli, configuredCodex), { code: 'LIMA_COMMAND_UNSUPPORTED' })
  assert.deepEqual(guest.commandArgv(['install', 'codex'], cli, configuredCodex), ['install', 'codex', '--root', '/home/autoprompt/runtime/providers/codex'])
  assert.deepEqual(guest.commandArgv(['uninstall', 'codex'], cli, configuredCodex), ['uninstall', 'codex', '--root', '/home/autoprompt/runtime/providers/codex'])
  assert.throws(() => guest.commandArgv(['uninstall'], cli, configuredCodex), { code: 'LIMA_PROVIDER_CONFIG_INVALID' })
  assert.throws(() => guest.commandArgv(['uninstall', 'all'], cli, configuredCodex), { code: 'LIMA_PROVIDER_CONFIG_INVALID' })
  assert.throws(() => guest.commandArgv(['uninstall', 'claude'], cli, configuredCodex), { code: 'LIMA_PROVIDER_CONFIG_INVALID' })
  assert.throws(() => guest.commandArgv(['uninstall', 'codex', '--root', '/host/control'], cli, configuredCodex), { code: 'LIMA_REQUEST_INVALID' })
})

test('Lima transport sends a request line but preserves stdin until the guest terminal receipt', async t => {
  const original = childProcess.spawn
  t.after(() => { childProcess.spawn = original })
  let input = '', ended = false
  childProcess.spawn = () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => {}
    child.stdin.on('data', chunk => { input += chunk })
    child.stdin.on('end', () => { ended = true })
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('{"schemaVersion":1,"status":"SUCCEEDED"}\n'))
      child.emit('close', 0)
    })
    return child
  }
  const result = await host.transport({ limactl: { path: '/tool/limactl' }, instance: 'apvm-0123456789abcdef', arch: 'x86_64', qemuRoot: null }, '/private', { schemaVersion: 1, action: 'exec', requestId: 'a'.repeat(32), argv: ['version'] })
  assert.deepEqual(result, { schemaVersion: 1, status: 'SUCCEEDED' })
  assert.equal(input, '{"schemaVersion":1,"action":"exec","requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","argv":["version"]}\n')
  assert.equal(ended, false)
  assert.throws(() => host.requestId(''), { code: 'LIMA_REQUEST_INVALID' })
})

test('Lima setup uses the same complete request-line framing as lifecycle transport', () => {
  const request = { schemaVersion: 1, action: 'setup', archiveSha256: 'a'.repeat(64) }
  assert.equal(host.requestLine(request), `${JSON.stringify(request)}\n`)
})

test('Lima lifecycle frames bind exact request IDs and accept only bridge cancellation', () => {
  assert.deepEqual(lifecycle.parseFrame(JSON.stringify({ op: 'cancel', requestId: 'b'.repeat(32), reason: 'BRIDGE_EOF' })), { op: 'cancel', requestId: 'b'.repeat(32), reason: 'BRIDGE_EOF' })
  assert.throws(() => lifecycle.parseFrame(JSON.stringify({ op: 'cancel', requestId: 'b'.repeat(32), argv: [] })), { code: 'LIMA_REQUEST_INVALID' })
  assert.throws(() => lifecycle.parseFrame(JSON.stringify({ op: 'start', requestId: 'B'.repeat(32), argv: ['version'] })), { code: 'LIMA_REQUEST_INVALID' })
  assert.deepEqual(lifecycle.activationBinding(['activate', 'codex', '--resume', `apv2-${'a'.repeat(32)}`, '--', 'work']), {
    missionSha256: require('node:crypto').createHash('sha256').update(JSON.stringify({ schemaVersion: 1, argv: ['work'] })).digest('hex'),
    resumeActivationId: `apv2-${'a'.repeat(32)}`,
  })
})

test('Lima terminal receipt accepts a schema-real cancelled terminal and rejects a foreign envelope', () => {
  const fixture = path.join(__dirname, '..', 'fixtures', 'lima-runtime')
  const { readChecksummedJson } = require('../../agents/codex/workflow/event-log.js')
  const runtimeState = require('../../agents/codex/workflow/runtime-state.js')
  const state = readChecksummedJson(path.join(fixture, 'cancelled-state.json'))
  const terminal = readChecksummedJson(path.join(fixture, 'cancelled-terminal.json'))
  assert.equal(lifecycle.validateTerminalAgreement(state, terminal, runtimeState), 'CANCELLED')
  assert.throws(() => lifecycle.validateTerminalAgreement(state, { ...terminal, sequence: terminal.sequence + 1 }, runtimeState), { code: 'LIMA_ACTIVATION_TERMINAL_UNPROVEN' })
})

test('Lima preserves a nonzero activation CLI failure before any activation receipt exists', () => {
  const initial = { schemaVersion: 1, requestId: '0'.repeat(32), status: 'RUNNING' }
  const output = { path: 'requests/0.output.log', bytes: 12, truncated: false, sha256: 'a'.repeat(64) }
  const configuration = { provider: 'codex' }
  const failed = lifecycle.cliFailureBeforeActivationReceipt(initial, 1, output, configuration, () => false)
  assert.equal(failed.status, 'FAILED')
  assert.equal(failed.errorCode, 'LIMA_ACTIVATION_CLI_FAILED')
  assert.equal(failed.output, output)
  assert.equal(lifecycle.cliFailureBeforeActivationReceipt(initial, 0, output, configuration, () => false), null)
  assert.equal(lifecycle.cliFailureBeforeActivationReceipt(initial, 1, output, configuration, () => true), null)
})

test('Lima non-Codex receipt binds the provider-normalized connection identity, not a Codex endpoint field', () => {
  const record = {
    target: { realpath: '/guest/project' },
    connectionSha256: 'b'.repeat(64),
    activationBoundary: {},
  }
  const configuration = { provider: 'omp', endpoint: 'https://gateway.example.invalid/v1', connectionIdentitySha256: record.connectionSha256 }
  assert.equal(record.activationBoundary.providerApiBaseUrl, undefined)
  assert.doesNotThrow(() => lifecycle.validateActivationBinding(record, configuration, record.target.realpath))
  assert.throws(() => lifecycle.validateActivationBinding(record, { ...configuration, connectionIdentitySha256: 'a'.repeat(64) }, record.target.realpath), { code: 'LIMA_ACTIVATION_RECEIPT_INVALID' })
})

test('Lima accepts Reasonix record-level revocation only when it binds the exact terminal outcome', () => {
  const reasonix = { status: 'revoked', revokedAt: '2026-09-09T00:00:00.000Z', outcome: 'CANCELLED', capability: { generation: 1 } }
  assert.equal(lifecycle.activationFinalized(reasonix, 'reasonix', 'CANCELLED'), true)
  assert.equal(lifecycle.activationFinalized({ ...reasonix, outcome: 'DONE' }, 'reasonix', 'CANCELLED'), false)
  assert.equal(lifecycle.activationFinalized({ status: 'revoked', capability: { status: 'revoked' } }, 'codex', 'DONE'), true)
})

test('Lima public VM parsing requires an explicit provider connection binding and preserves activation resume identity', () => {
  const setup = cli.parseArgs(['runtime', 'vm', 'setup', '--root', '/private/vm', '--target', '/work', '--provider', 'grok', '--endpoint', 'https://gateway.example.invalid/v1', '--connection', '/private/grok-native.json', '--credential', '/private/grok-connection.json', '--model-selection', '/private/grok-selection.json', '--toolchain', '/tools/node-v22.23.2-linux-x64', '--native', '/tools/grok-native', '--lima', '/tools/limactl', '--archive', '/private/autoprompt.tgz', '--vm-type', 'vz'])
  assert.equal(setup.provider, 'grok')
  assert.equal(setup.endpoint, 'https://gateway.example.invalid/v1')
  assert.equal(setup.credential, '/private/grok-connection.json')
  assert.equal(setup.connection, '/private/grok-native.json')
  assert.equal(setup.modelSelection, '/private/grok-selection.json')
  assert.throws(() => cli.parseArgs(['runtime', 'vm', 'setup', '--root', '/private/vm', '--target', '/work', '--provider', 'codex', '--endpoint', 'https://gateway.example.invalid', '--lima', '/tools/limactl', '--archive', '/private/autoprompt.tgz', '--vm-type', 'vz']), { code: 'AUTOPROMPT_USAGE' })
  const activation = cli.parseArgs(['activate', 'grok', '--vm-root', '/private/vm', '--resume', `apv2-${'a'.repeat(32)}`, '--', 'work'])
  assert.equal(activation.vmRoot, path.resolve('/private/vm'))
  assert.equal(activation.resume, `apv2-${'a'.repeat(32)}`)
  assert.throws(() => cli.parseArgs(['activate', 'grok', '--vm-root', '/private/vm', '--target', '/work', '--', 'work']), { code: 'AUTOPROMPT_USAGE' })
  assert.deepEqual(cli.parseArgs(['runtime', 'vm', 'cancel', '--root', '/private/vm', '--request-id', 'a'.repeat(32)]), { command: 'runtime-vm', action: 'cancel', root: path.resolve('/private/vm'), requestId: 'a'.repeat(32) })
})

test('Lima provider binding validates every public provider through its concrete native connection projection', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lima-provider-')))
  ensureWindowsPrivateAcl(root)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const endpoint = 'https://gateway.example.invalid/v1'
  const connections = {
    claude: {}, codex: { schemaVersion: 1, provider: 'codex' },
    opencode: { providers: { gateway: { npm: '@ai-sdk/openai-compatible', options: { baseURL: endpoint } } } },
    kilo: { providers: { gateway: { npm: '@ai-sdk/openai-compatible', options: { baseURL: endpoint } } } },
    vscode: { model: 'gateway/model', baseUrl: endpoint, apiKeyEnv: 'OPENROUTER_API_KEY' },
    prime: { modelProvider: 'gateway', providers: { gateway: { baseUrl: endpoint, apiKey: 'OPENROUTER_API_KEY', models: [{ id: 'model' }] } } },
    omp: { modelProvider: 'gateway', providers: { gateway: { baseUrl: endpoint, apiKey: 'OPENROUTER_API_KEY', models: [{ id: 'model' }] } } },
    deepseek: {}, hermes: {}, grok: {},
    reasonix: '[[providers]]\nname = "gateway"\nbase_url = "https://gateway.example.invalid/v1"\napi_key_env = "REASONIX_GATEWAY_KEY"\nmodel = "model"\n',
  }
  const credentials = {
    claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', opencode: 'OPENAI_API_KEY', kilo: 'KILO_API_KEY', vscode: 'OPENROUTER_API_KEY', prime: 'OPENROUTER_API_KEY', omp: 'OPENROUTER_API_KEY', deepseek: 'DEEPSEEK_API_KEY', hermes: 'HERMES_API_KEY', grok: 'GROK_API_KEY', reasonix: 'REASONIX_GATEWAY_KEY',
  }
  for (const provider of Object.keys(connections)) {
    const connection = path.join(root, `${provider}.connection`)
    fs.writeFileSync(connection, typeof connections[provider] === 'string' ? connections[provider] : JSON.stringify(connections[provider]), { mode: 0o600 })
    ensureWindowsPrivateAcl(connection)
    const native = host.connectionBinding(connection, provider, endpoint)
    const credential = path.join(root, `${provider}.credentials.json`)
    fs.writeFileSync(credential, JSON.stringify({ schemaVersion: 1, provider, environment: { [credentials[provider]]: 'fixture-only' } }), { mode: 0o600 })
    ensureWindowsPrivateAcl(credential)
    const bound = host.credentialBinding(credential, provider, native)
    assert.match(bound.sha256, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify({ native, bound }), /fixture-only/)
  }
  assert.equal(host.providerEndpoint('https://gateway.example.invalid/v1/'), 'https://gateway.example.invalid/v1')
  const badCredential = path.join(root, 'bad.json')
  fs.writeFileSync(badCredential, JSON.stringify({ schemaVersion: 1, provider: 'hermes', environment: { BASH_ENV: 'fixture-only' } }), { mode: 0o600 })
  const hermesConnection = path.join(root, 'hermes-valid.json'); fs.writeFileSync(hermesConnection, '{}', { mode: 0o600 })
  ensureWindowsPrivateAcl(badCredential)
  ensureWindowsPrivateAcl(hermesConnection)
  assert.throws(() => host.credentialBinding(badCredential, 'hermes', host.connectionBinding(hermesConnection, 'hermes', endpoint)), { code: 'LIMA_PROVIDER_CONFIG_INVALID' })
  // The second rejection must prove privacy enforcement with otherwise valid content.
  fs.writeFileSync(badCredential, JSON.stringify({ schemaVersion: 1, provider: 'hermes', environment: { HERMES_API_KEY: 'fixture-only' } }))
  if (process.platform === 'win32') {
    const changed = childProcess.spawnSync('icacls.exe', [badCredential, '/grant', '*S-1-1-0:R'], { encoding: 'utf8', windowsHide: true })
    assert.equal(changed.status, 0, changed.stderr || changed.stdout)
  } else fs.chmodSync(badCredential, 0o644)
  assert.throws(() => host.credentialBinding(badCredential, 'hermes', host.connectionBinding(hermesConnection, 'hermes', endpoint)), { code: 'LIMA_PROVIDER_CONFIG_INVALID' })
  const alias = path.join(root, 'connection-alias.json'); fs.symlinkSync(hermesConnection, alias)
  assert.throws(() => host.connectionBinding(alias, 'hermes', endpoint), { code: 'LIMA_PATH_UNSAFE' })
})

// The Linux guest owns a POSIX process group; Windows hosts use the WSL guest.
test('guest worker terminates itself when its lifecycle IPC owner disconnects', { skip: process.platform === 'win32' }, async t => {
  const worker = childProcess.fork(path.join(__dirname, '..', '..', 'scripts', 'lima-runtime-guest-worker.cjs'), [], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  t.after(() => { try { process.kill(-worker.pid, 'SIGKILL') } catch { /* worker already exited */ } })
  const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })))
  worker.disconnect()
  assert.deepEqual(await exited, { code: null, signal: 'SIGTERM' })
})

test('guest worker exits after reporting a terminal result instead of retaining its IPC channel', async t => {
  const worker = childProcess.fork(path.join(__dirname, '..', '..', 'scripts', 'lima-runtime-guest-worker.cjs'), [], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  t.after(() => { try { process.kill(-worker.pid, 'SIGKILL') } catch { /* worker already exited */ } })
  const reported = new Promise(resolve => worker.once('message', resolve))
  const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })))
  worker.send({ schemaVersion: 1, action: 'exec', requestId: 'c'.repeat(32), argv: ['version'] })
  assert.equal((await reported).type, 'error')
  assert.deepEqual(await exited, { code: 2, signal: null })
})

test('Lima extends only an unaccelerated QEMU boot readiness deadline', () => {
  assert.equal(host.qemuFallbackStartTimeout('qemu', false), '30m')
  assert.equal(host.qemuFallbackStartTimeout('qemu', true), null)
  assert.equal(host.qemuFallbackStartTimeout('qemu', undefined), null)
  assert.equal(host.qemuFallbackStartTimeout('vz', false), null)
})

test('Lima config exports only selected target and has no SSHFS, automatic sync, sockets, or agent forwarding', t => {
  // Model the macOS host UID for this pure configuration test on Windows.
  // Actual Lima setup remains macOS-only and must observe its real caller UID.
  if (typeof process.getuid !== 'function') {
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 4242 })
    t.after(() => { delete process.getuid })
  }
  const target = path.resolve('/Users/test/project')
  for (const vmType of ['qemu', 'vz']) {
    const config = host.makeConfig({ target, arch: 'x86_64', vmType, provider: 'codex' })
    assert.equal(config.user.uid, process.getuid())
    assert.equal(config.mounts.length, 1)
    assert.equal(config.mounts[0].location, target)
    assert.equal(config.mounts[0].mountPoint, target)
    assert.equal(config.mountType, vmType === 'qemu' ? '9p' : 'virtiofs')
    assert.doesNotMatch(config.provision[0].script, /(?:Xvfb|xvfb|libgtk-3-0|libasound2)/, 'Codex setup must not install VS Code GUI dependencies')
    if (vmType === 'qemu') assert.deepEqual(config.mounts[0]['9p'], { securityModel: 'none', cache: 'none' })
    assert.equal(config.ssh.forwardAgent, false)
    assert.deepEqual(config.portForwards, [{ guestPortRange: [1, 65535], ignore: true }])
    assert.match(config.images[0].digest, /^sha256:[a-f0-9]{64}$/)
  }
  const vscode = host.makeConfig({ target, arch: 'x86_64', vmType: 'qemu', provider: 'vscode' })
  assert.match(vscode.provision[0].script, /resolve_candidate\(\).*libgtk-3-0t64 libgtk-3-0/s, 'Fresh VS Code guests must resolve the release-specific GTK runtime package')
  assert.match(vscode.provision[0].script, /resolve_candidate libasound2t64 libasound2/, 'Fresh VS Code guests must resolve the release-specific ALSA runtime package')
  assert.match(vscode.provision[0].script, /apt-get install -y xvfb xauth .*"\$gtk_package" .*libnss3 .*"\$asound_package" .*libx11-xcb1/, 'Fresh VS Code guests must install the owned display prerequisites')
  assert.throws(() => host.makeConfig({ target: path.resolve('/Users/test,readonly=off'), arch: 'x86_64', vmType: 'qemu' }), { code: 'LIMA_PATH_INVALID' })
  assert.throws(() => host.makeConfig({ target, arch: 'arm64', vmType: 'qemu', provider: 'codex' }), { code: 'LIMA_CONFIG_INVALID' })
  assert.throws(() => host.makeConfig({ target, arch: 'x86_64', vmType: 'qemu' }), { code: 'LIMA_CONFIG_INVALID' })
  assert.throws(() => host.shellArgs('default;evil'), { code: 'LIMA_DESCRIPTOR_INVALID' })
  for (const [arch, node] of [['x86_64', '/home/autoprompt/runtime/pinned/toolchain/node-v22.23.2-linux-x64/bin/node'], ['aarch64', '/home/autoprompt/runtime/pinned/toolchain/node-v22.23.2-linux-arm64/bin/node']]) {
    assert.deepEqual(host.shellArgs('apvm-0123456789abcdef', arch), ['--tty=false', 'shell', '--workdir=/home/autoprompt/runtime', 'apvm-0123456789abcdef', node, '/home/autoprompt/runtime/lima-runtime-guest.cjs'])
  }
  assert.throws(() => host.guestNodePath('arm64'), { code: 'LIMA_CONFIG_INVALID' })
})

test('Lima tool binding rejects symlink ancestors and tracks equal-size replacement', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lima-binding-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tool = path.join(root, 'tool'); fs.writeFileSync(tool, 'original')
  const before = host.binding(tool)
  const next = path.join(root, 'next'); fs.writeFileSync(next, 'replaced'); fs.renameSync(next, tool)
  assert.notDeepEqual(host.binding(tool), before)
  const alias = path.join(root, 'alias'); fs.symlinkSync(root, alias)
  assert.throws(() => host.binding(path.join(alias, 'tool')), { code: 'LIMA_PATH_UNSAFE' })
})

// Native Lima setup is macOS-only; these imported trees carry POSIX modes/links.
// Windows uses WSL and does not import native Lima runtime closures.
test('Lima toolchain identity detects dependency changes and refuses escaping library links', { skip: process.platform === 'win32' }, t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lima-toolchain-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'tools'); fs.mkdirSync(root, { mode: 0o755 }); fs.chmodSync(root, 0o755)
  fs.writeFileSync(path.join(root, 'lib.dylib'), 'old', { mode: 0o644 }); fs.chmodSync(path.join(root, 'lib.dylib'), 0o644)
  fs.writeFileSync(path.join(root, 'QEMU,cgthree.bin'), 'firmware', { mode: 0o644 }); fs.chmodSync(path.join(root, 'QEMU,cgthree.bin'), 0o644)
  const before = host.treeBinding(root)
  fs.writeFileSync(path.join(root, 'lib.dylib'), 'new')
  assert.notEqual(host.treeBinding(root).sha256, before.sha256)
  const outside = path.join(base, 'foreign'); fs.writeFileSync(outside, 'foreign', { mode: 0o644 }); fs.chmodSync(outside, 0o644)
  fs.symlinkSync(outside, path.join(root, 'redirect.dylib'))
  assert.throws(() => host.treeBinding(root), { code: 'LIMA_PATH_UNSAFE' })
})

// Native Lima setup is macOS-only; these imported trees carry POSIX modes/links.
// Windows uses WSL and does not import native Lima runtime closures.
test('Lima host and guest portable closure digests agree for a Node-style internal executable link', { skip: process.platform === 'win32' }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lima-portable-closure-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageBin = path.join(root, 'node_modules', 'fixture', 'bin')
  const npmBin = path.join(root, 'node_modules', '.bin')
  fs.mkdirSync(packageBin, { recursive: true, mode: 0o755 }); fs.mkdirSync(npmBin, { recursive: true, mode: 0o755 })
  const executable = path.join(packageBin, 'fixture')
  fs.writeFileSync(executable, '#!/bin/sh\necho fixture\n', { mode: 0o755 }); fs.chmodSync(executable, 0o755)
  // npm creates .bin entries as relative links.  This is the shape imported
  // by the real native closures, including when link modes differ by host.
  fs.symlinkSync('../fixture/bin/fixture', path.join(npmBin, 'fixture'))
  assert.equal(host.treeBinding(root).portableSha256, guest.portableTreeDigest(root))
})

// Native Lima setup is macOS-only; these imported trees carry POSIX modes/links.
// Windows uses WSL and does not import native Lima runtime closures.
test('Lima loads a completed setup descriptor with its enriched native connection binding', { skip: process.platform === 'win32' }, t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lima-load-descriptor-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'private'), target = path.join(base, 'target')
  fs.mkdirSync(root, { mode: 0o700 }); fs.chmodSync(root, 0o700)
  fs.mkdirSync(target, { mode: 0o700 }); fs.chmodSync(target, 0o700)
  const write = (name, bytes = name, mode = 0o600) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); return file
  }
  const archive = write('package.tgz'), providerConfig = write('provider-config.json', '{}')
  const connectionPath = write('connection.json', JSON.stringify({ schemaVersion: 1, provider: 'codex' }))
  const credential = write('credentials.json', JSON.stringify({ schemaVersion: 1, provider: 'codex', environment: { OPENAI_API_KEY: 'fixture-only' } }))
  const bridge = write('bridge.cjs'), lifecycle = write('lifecycle.cjs'), worker = write('worker.cjs'), config = write('lima.yaml')
  const limaRoot = path.join(root, 'lima-runtime'), limactlPath = path.join(limaRoot, 'bin', 'limactl')
  fs.mkdirSync(path.dirname(limactlPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(limactlPath, '#!/bin/sh\n', { mode: 0o700 }); fs.chmodSync(limactlPath, 0o700)
  const toolchainPath = path.join(root, 'node-v22.23.2-linux-x64'), nativePath = path.join(root, 'native-codex')
  for (const item of [toolchainPath, nativePath]) { fs.mkdirSync(item, { mode: 0o700 }); fs.chmodSync(item, 0o700); fs.writeFileSync(path.join(item, 'runtime'), 'fixture', { mode: 0o700 }); fs.chmodSync(path.join(item, 'runtime'), 0o700) }
  const instance = 'apvm-0123456789abcdef', instanceConfigPath = path.join(root, 'lima', instance, 'lima.yaml')
  fs.mkdirSync(path.dirname(instanceConfigPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(instanceConfigPath, '{}', { mode: 0o600 }); fs.chmodSync(instanceConfigPath, 0o600)
  const connection = host.connectionBinding(connectionPath, 'codex', 'https://gateway.example.invalid/v1')
  const descriptor = {
    schemaVersion: 2, kind: 'lima-linux-controller-v1', status: 'CONFIGURED', instance, privateRoot: host.binding(root, true), target: host.binding(target, true),
    provider: 'codex', endpoint: 'https://gateway.example.invalid/v1', connection, credential: host.binding(credential), toolchain: host.treeBinding(toolchainPath), native: host.treeBinding(nativePath), providerConfig: host.binding(providerConfig),
    limactl: host.binding(limactlPath), limaRoot: host.treeBinding(limaRoot), qemuRoot: null, archive: host.binding(archive), bridge: host.binding(bridge), lifecycle: host.binding(lifecycle), worker: host.binding(worker), config: host.binding(config), image: {}, vmType: 'qemu', arch: 'x86_64',
  }
  const prepared = { schemaVersion: 1, instanceConfig: host.binding(instanceConfigPath), providerConfig: host.binding(providerConfig), connection: host.binding(connectionPath), credential: host.binding(credential), toolchain: host.treeBinding(toolchainPath), native: host.treeBinding(nativePath) }
  write('prepared.json', JSON.stringify(prepared) + '\n')
  write('backend.json', JSON.stringify(descriptor) + '\n')
  assert.deepEqual(host.load(root), descriptor)
  descriptor.connection.connectionIdentitySha256 = 'a'.repeat(64)
  fs.writeFileSync(path.join(root, 'backend.json'), JSON.stringify(descriptor) + '\n', { mode: 0o600 })
  assert.throws(() => host.load(root), { code: 'LIMA_BINDING_CHANGED' })
})

test('guest runtime binding detects installed dependency drift', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lima-guest-runtime-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'node_modules'))
  const dependency = path.join(root, 'node_modules', 'dependency.cjs')
  fs.writeFileSync(dependency, 'module.exports=1')
  const before = guest.packageDigest(root)
  fs.writeFileSync(dependency, 'module.exports=2')
  assert.notEqual(guest.packageDigest(root), before)
})

// Exercise the Linux guest's actual flock critical section, including takeover.
test('guest lifecycle lock distinguishes a genuine owner from a reused PID and never releases a replacement lock', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-lifecycle-lock-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const lockPath = path.join(root, 'lifecycle.lock')
  const boot = '11111111-2222-4333-8444-555555555555'
  const owner = { schemaVersion: 1, pid: 77, startTime: '101', bootId: boot, nonce: 'a'.repeat(32) }
  const candidate = { schemaVersion: 1, pid: 88, startTime: '202', bootId: boot, nonce: 'b'.repeat(32) }
  const write = value => fs.writeFileSync(lockPath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  const options = start => ({ lockPath, guardPath: `${lockPath}.guard`, identity: () => candidate, bootId: () => boot, processStartTime: pid => {
    if (pid === 77) return start
    if (pid === 88) return '202'
    throw Object.assign(new Error('missing process'), { code: 'ESRCH' })
  } })

  write(owner)
  assert.equal(await lifecycle.acquireLock(options('101')), null, 'an exact live controller remains the sole lock owner')
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), owner)

  const zombie = await lifecycle.acquireLock({ lockPath, guardPath: `${lockPath}.guard`, identity: () => candidate, bootId: () => boot,
    processIdentity: pid => pid === 77 ? { startTime: '101', state: 'Z' } : { startTime: '202', state: 'R' } })
  assert.equal(typeof zombie, 'function', 'a matching zombie PID is not a live lifecycle owner')
  await zombie()
  write(owner)

  const release = await lifecycle.acquireLock(options('303'))
  assert.equal(typeof release, 'function', 'a reused numeric PID is stale and admits recovery')
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), candidate)

  const replacement = { ...candidate, nonce: 'c'.repeat(32) }
  write(replacement)
  await release()
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), replacement, 'an old owner release cannot unlink a replacement lock')

  write(owner)
  const contenders = await Promise.all([lifecycle.acquireLock(options('303')), lifecycle.acquireLock(options('303'))])
  assert.equal(contenders.filter(Boolean).length, 1, 'flock admits exactly one reclaimer under concurrent stale takeover')
  await Promise.all(contenders.filter(Boolean).map(item => item()))

  // A controller can crash after O_EXCL creates an empty lock, and a prior
  // reclaimer can leave its flock guard pathname behind. Neither file proves
  // ownership once the advisory lock is free.
  fs.writeFileSync(lockPath, '', { mode: 0o600 })
  fs.writeFileSync(`${lockPath}.guard`, '', { mode: 0o600 })
  const recovered = await lifecycle.acquireLock(options('303'))
  assert.equal(typeof recovered, 'function', 'an empty partial lock and an idle crashed-reclaimer guard recover under flock')
  await recovered()
})
