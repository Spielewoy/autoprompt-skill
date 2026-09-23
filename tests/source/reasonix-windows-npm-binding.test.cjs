'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const cmdShim = require('cmd-shim')
const native = require('../../agents/reasonix/workflow/native.js')
const shared = require('../../scripts/harness-v2-native.cjs')
const { nativeContextRoot, persistNativeContext } = require('../../agents/reasonix/workflow/transport.js')

async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-npm-cmd-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageRoot = path.join(root, 'node_modules', 'reasonix-fixture')
  const binRoot = path.join(root, 'node_modules', '.bin')
  const script = path.join(packageRoot, 'bin', 'reasonix.js')
  const shim = path.join(binRoot, 'reasonix.cmd')
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 })
  fs.mkdirSync(binRoot, { recursive: true, mode: 0o700 })
  fs.writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write("fixture\\n")\n', { mode: 0o700 })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'reasonix-fixture', version: '1.30.0', bin: { reasonix: 'bin/reasonix.js' } }), { mode: 0o600 })
  await cmdShim(script, shim.slice(0, -'.cmd'.length))
  return { root, packageRoot, script, shim }
}

function probeResult(argv) {
  if (argv.at(-1) === '--version') return { status: 0, stdout: 'reasonix v1.30.0\n', stderr: '' }
  return { status: 0, stdout: '--output-format --resume --dir --max-steps --permission-mode --allowed-tools\n', stderr: '' }
}

test('Reasonix binds a generated npm cmd shim to its declared Node bin and invokes it without CMD parsing', async t => {
  const f = await fixture(t)
  const launches = []
  const binding = native.probeExecutable({ executable: f.shim, platform: 'win32', env: { PATH: path.dirname(f.shim) }, spawnSync(file, argv, options) {
    launches.push({ file, argv, options })
    return probeResult(argv)
  } })
  assert.equal(binding.path, f.shim)
  assert.equal(binding.invocation.kind, 'node-script')
  assert.equal(binding.invocation.script.path, f.script)
  assert.equal(binding.invocation.node.path, process.execPath)
  assert.match(binding.invocation.shim.sha256, /^[a-f0-9]{64}$/)
  assert.match(binding.invocation.script.sha256, /^[a-f0-9]{64}$/)
  assert.match(binding.invocation.node.sha256, /^[a-f0-9]{64}$/)
  assert.equal(launches.length, 2)
  for (const launch of launches) {
    assert.equal(launch.file, process.execPath)
    assert.equal(launch.argv[0], f.script)
    assert.equal(launch.options.shell, false)
  }
  assert.deepEqual(shared.executableInvocation(binding, ['run', '--help']), { executable: process.execPath, argv: [f.script, 'run', '--help'] })
  assert.equal(shared.executableRuntimePath(binding), f.script)
})

test('Reasonix rejects npm cmd shims whose package bin declaration is counterfeit or whose entrypoint drifts', async t => {
  const f = await fixture(t)
  fs.writeFileSync(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'reasonix-fixture', version: '1.30.0', bin: { reasonix: 'bin/other.js' } }), { mode: 0o600 })
  assert.throws(() => native.locateExecutable({ PATH: path.dirname(f.shim) }, f.shim, { platform: 'win32' }), { code: 'PROVIDER_IDENTITY_MISMATCH' })

  fs.writeFileSync(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'reasonix-fixture', version: '1.30.0', bin: { reasonix: 'bin/reasonix.js' } }), { mode: 0o600 })
  const binding = native.probeExecutable({ executable: f.shim, platform: 'win32', spawnSync: (_file, argv) => probeResult(argv) })
  fs.appendFileSync(f.script, '// drift\n')
  assert.throws(() => shared.executableInvocation(binding, ['run']), { code: 'PROVIDER_IDENTITY_MISMATCH' })
})

test('Reasonix continuation state binds the npm invocation digest as well as the raw shim', async t => {
  const f = await fixture(t)
  const binding = native.probeExecutable({ executable: f.shim, platform: 'win32', spawnSync: (_file, argv) => probeResult(argv) })
  const record = { sessionId: 'reasonix-session', providerRole: 'ap-worker' }
  const state = nativeContextRoot(f.root, record, f.root)
  persistNativeContext(f.root, state, record, f.root, 'native-session', binding)
  assert.equal(nativeContextRoot(f.root, { ...record, continuationId: 'native-session' }, f.root, binding), state)
  const changed = { ...binding, invocation: { ...binding.invocation, sha256: '0'.repeat(64) } }
  assert.throws(() => nativeContextRoot(f.root, { ...record, continuationId: 'native-session' }, f.root, changed), { code: 'SESSION_ID_MISMATCH' })
})
