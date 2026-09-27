'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')

const cmdShim = require('cmd-shim')
const npm10NodeShim = target => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
].join('\r\n')
const npm10NativeShim = target => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  `"%dp0%\\${target}"   %*`, '',
].join('\r\n')

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-windows-npm-shim-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageRoot = path.join(root, 'node_modules', 'fixture-cli')
  const bin = path.join(root, 'node_modules', '.bin')
  const script = path.join(packageRoot, 'bin', 'fixture.js')
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 })
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(script, '#!/usr/bin/env node\nconsole.log("fixture")\n', { mode: 0o700 })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-cli', version: '1.0.0', bin: { grok: options.bin || 'bin/fixture.js' } }), { mode: 0o600 })
  const shim = path.join(bin, 'grok.cmd')
  fs.writeFileSync(shim, options.source || npm10NodeShim('..\\fixture-cli\\bin\\fixture.js'), { mode: 0o700 })
  return { root, packageRoot, bin, shim, script }
}

async function nativeFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-windows-native-npm-shim-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageRoot = path.join(root, 'node_modules', 'fixture-cli')
  const bin = path.join(root, 'node_modules', '.bin')
  const executable = path.join(packageRoot, 'bin', 'fixture.exe')
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(executable, 'MZ fixture native executable\n', { mode: 0o700 })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-cli', version: '1.0.0', bin: { grok: options.bin || 'bin/fixture.exe' } }), { mode: 0o600 })
  const shim = path.join(bin, 'grok.cmd')
  await cmdShim(executable, shim.slice(0, -'.cmd'.length))
  if (options.source) fs.writeFileSync(shim, options.source, { mode: 0o700 })
  return { root, packageRoot, bin, shim, executable }
}

async function currentNpmFixture(t) {
  const f = fixture(t)
  await cmdShim(f.script, f.shim.slice(0, -'.cmd'.length))
  return f
}

test('Windows npm10 cmd-shim resolves to exact Node plus declared package bin without cmd.exe', async t => {
  const f = await currentNpmFixture(t)
  const binding = native.locateExecutable({ provider: 'grok', executable: f.shim, platform: 'win32' })
  assert.equal(binding.path, f.shim)
  assert.equal(binding.sha256, native.executableSha256(f.shim), 'the raw shim remains the executable identity')
  assert.equal(binding.invocation.kind, 'node-script')
  assert.equal(binding.invocation.script.path, f.script)
  assert.equal(binding.invocation.script.sha256, native.executableSha256(f.script))
  const launch = native.executableInvocation(binding, ['--version'])
  assert.equal(launch.executable, process.execPath)
  assert.deepEqual(launch.argv, [f.script, '--version'])

  const calls = []
  const probe = native.probeExecutable({ provider: 'grok', executable: f.shim, platform: 'win32', env: { PATH: process.env.PATH }, spawnSync: (executable, argv, options) => {
    calls.push({ executable, argv, options })
    return { status: 0, stdout: argv.includes('--version') ? 'grok 1.0.13\n' : '-p --output-format --resume --model --tools --verbatim --system-prompt-override --no-subagents\n', stderr: '' }
  } })
  assert.equal(probe.path, f.shim)
  assert.equal(probe.invocation.sha256, binding.invocation.sha256)
  assert.equal(native.executableRuntimePath(probe), f.script)
  assert.ok(probe.portableRuntimeIdentity.files.some(([label]) => /^interpreter\/node(?:\.exe)?$/iu.test(label)),
    'the portable closure binds the verified Node interpreter, not /usr/bin/env')
  assert.ok(!probe.portableRuntimeIdentity.files.some(([label]) => label === 'interpreter/env'),
    'the env selector is never part of a shell-free shim launch')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.executable === process.execPath && call.argv[0] === f.script && call.options.shell === false),
    'the probe must never dispatch the .cmd through a command shell')
})

test('Windows npm cmd-shim resolves a declared native package bin without cmd.exe', async t => {
  const f = await nativeFixture(t)
  const binding = native.locateExecutable({ provider: 'grok', executable: f.shim, platform: 'win32' })
  assert.equal(binding.path, f.shim)
  assert.equal(binding.sha256, native.executableSha256(f.shim), 'the raw shim remains the executable identity')
  assert.equal(binding.invocation.kind, 'native-executable')
  assert.equal(binding.invocation.executable.path, f.executable)
  assert.equal(binding.invocation.executable.sha256, native.executableSha256(f.executable))
  const launch = native.executableInvocation(binding, ['--version'])
  assert.equal(launch.executable, f.executable)
  assert.deepEqual(launch.argv, ['--version'])

  const calls = []
  const probe = native.probeExecutable({ provider: 'grok', executable: f.shim, platform: 'win32', env: { PATH: process.env.PATH }, spawnSync: (executable, argv, options) => {
    calls.push({ executable, argv, options })
    return { status: 0, stdout: argv.includes('--version') ? 'grok 1.0.13\n' : '-p --output-format --resume --model --tools --verbatim --system-prompt-override --no-subagents\n', stderr: '' }
  } })
  assert.equal(probe.path, f.shim)
  assert.equal(probe.invocation.sha256, binding.invocation.sha256)
  assert.equal(native.executableRuntimePath(probe), f.executable)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.executable === f.executable && !call.argv.includes(f.shim) && call.options.shell === false),
    'the probe must invoke the native package bin directly and never dispatch the .cmd through a command shell')

  const tampered = { ...binding, invocation: { ...binding.invocation, executable: { ...binding.invocation.executable, path: 7 } } }
  assert.throws(() => native.executableInvocation(tampered, ['--help']), { code: 'PROVIDER_IDENTITY_MISMATCH' })
  fs.appendFileSync(f.executable, 'changed\n')
  assert.throws(() => native.executableInvocation(binding, ['--help']), { code: 'PROVIDER_IDENTITY_MISMATCH' })
})

test('Windows npm native cmd-shim resolution rejects flags, escaping paths, and manifest mismatches', async t => {
  const flags = await nativeFixture(t, { source: npm10NativeShim('..\\fixture-cli\\bin\\fixture.exe').replace('   %*', ' --flag %*') })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: flags.shim, platform: 'win32' }), { code: 'PROVIDER_UNSUPPORTED' })

  const mismatched = await nativeFixture(t, { bin: 'bin/other.exe' })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: mismatched.shim, platform: 'win32' }), { code: 'PROVIDER_IDENTITY_MISMATCH' })

  const escaping = await nativeFixture(t, { bin: '../escape.exe', source: npm10NativeShim('..\\escape.exe') })
  fs.writeFileSync(path.join(escaping.root, 'node_modules', 'escape.exe'), 'MZ escape\n', { mode: 0o700 })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: escaping.shim, platform: 'win32' }), { code: 'PROVIDER_UNSUPPORTED' })
})

test('Windows npm shim resolution rejects ambiguous, escaping, and manifest-mismatched scripts', t => {
  const ambiguous = fixture(t, { source: npm10NodeShim('..\\fixture-cli\\bin\\fixture.js" "%dp0%\\..\\fixture-cli\\bin\\other.js') })
  fs.writeFileSync(path.join(ambiguous.packageRoot, 'bin', 'other.js'), 'x\n', { mode: 0o700 })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: ambiguous.shim, platform: 'win32' }), { code: 'PROVIDER_UNSUPPORTED' })

  const mismatched = fixture(t, { bin: 'bin/other.js' })
  fs.writeFileSync(path.join(mismatched.packageRoot, 'bin', 'other.js'), 'x\n', { mode: 0o700 })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: mismatched.shim, platform: 'win32' }), { code: 'PROVIDER_IDENTITY_MISMATCH' })

  const escaping = fixture(t, { bin: '../escape.js', source: npm10NodeShim('..\\escape.js') })
  fs.writeFileSync(path.join(escaping.root, 'node_modules', 'escape.js'), 'x\n', { mode: 0o700 })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: escaping.shim, platform: 'win32' }), { code: 'PROVIDER_UNSUPPORTED' })
})

test('Windows npm shim resolution refuses Bun, interpreter flags, and non-Node entrypoints', t => {
  const bun = fixture(t, { source: npm10NodeShim('..\\fixture-cli\\bin\\fixture.js').replace('SET "_prog=node"', 'SET "_prog=bun"') })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: bun.shim, platform: 'win32' }), { code: 'PROVIDER_UNSUPPORTED' })

  const flags = fixture(t, { source: npm10NodeShim('..\\fixture-cli\\bin\\fixture.js').replace('"%_prog%"  ', '"%_prog%" --require preload ') })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: flags.shim, platform: 'win32' }), { code: 'PROVIDER_UNSUPPORTED' })

  const shebang = fixture(t)
  fs.writeFileSync(shebang.script, '#!/usr/bin/env bun\nconsole.log("fixture")\n', { mode: 0o700 })
  assert.throws(() => native.locateExecutable({ provider: 'grok', executable: shebang.shim, platform: 'win32' }), { code: 'PROVIDER_UNSUPPORTED' })
})

test('Windows npm shim launch binding refuses script drift before shell:false execution', t => {
  const f = fixture(t)
  const binding = native.locateExecutable({ provider: 'grok', executable: f.shim, platform: 'win32' })
  fs.appendFileSync(f.script, '// changed\n')
  assert.throws(() => native.executableInvocation(binding, ['--help']), { code: 'PROVIDER_IDENTITY_MISMATCH' })
})

test('Windows npm shim launch binding rejects malformed persisted invocation metadata', t => {
  const f = fixture(t)
  const binding = native.locateExecutable({ provider: 'grok', executable: f.shim, platform: 'win32' })
  const tampered = { ...binding, invocation: { ...binding.invocation, node: { ...binding.invocation.node, path: 7 } } }
  assert.throws(() => native.executableInvocation(tampered, ['--help']), { code: 'PROVIDER_IDENTITY_MISMATCH' })
})
