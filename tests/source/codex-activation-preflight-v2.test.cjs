'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const crypto = require('node:crypto')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const activation = require('../../scripts/codex-configure.cjs')
const rolePolicy = require('../../agents/codex/agents/role-policy.json')
const runtime = require('../../agents/codex/workflow/phase-budget.js')

function sealedProfileFixture(root) {
  const profilePath = path.join(root, 'autoprompt.config.toml')
  const source = [
    'sandbox_mode = "workspace-write"', 'web_search = "disabled"',
    '[shell_environment_policy]', 'inherit = "core"',
    'ignore_default_excludes = false', 'exclude = ["*KEY*", "*TOKEN*"]',
    'set = { GIT_ALLOW_PROTOCOL = "file" }', '',
  ].join('\n')
  fs.writeFileSync(profilePath, source, { mode: 0o600 })
  return { profilePath, profileSha256: crypto.createHash('sha256').update(source).digest('hex') }
}

function sandboxProbeSpawn(mode) {
  return (command, args, options) => {
    if (command === process.execPath && args[0] === '-e') {
      return childProcess.spawnSync(command, args, options)
    }
    assert.equal(args[0], 'sandbox')
    assert.ok(args.includes('--sandbox-state-disable-network'))
    const nodeIndex = args.indexOf(process.execPath)
    assert.ok(nodeIndex > 0)
    const address = args[nodeIndex + 4]
    assert.doesNotMatch(address, /^(?:127\.|0\.0\.0\.0$)/)
    if (mode === 'denied') {
      fs.writeFileSync(args[nodeIndex + 6], 'DENIED', { flag: 'wx', mode: 0o600 })
      return { status: 0, stdout: 'AUTOPROMPT_NETWORK_DENIED', stderr: '' }
    }
    return childProcess.spawnSync(process.execPath, args.slice(nodeIndex + 1), options)
  }
}

function activationWithDelayedReadyPublication() {
  const sourcePath = require.resolve('../../scripts/codex-configure.cjs')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const original = "    '  fs.writeFileSync(ready,JSON.stringify({address,port:server.address().port}),{flag:\"wx\",mode:0o600})',"
  const replacement = [
    "    '  const readyDescriptor=fs.openSync(ready,\"wx\",0o600)',",
    "    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250)',",
    "    '  fs.writeFileSync(readyDescriptor,JSON.stringify({address,port:server.address().port}))',",
    "    '  fs.closeSync(readyDescriptor)',",
  ].join('\n')
  assert.ok(source.includes(original), 'test transform must bind the listener ready write')
  const local = new Module(`${sourcePath}:delayed-ready-publication`, module)
  local.filename = sourcePath
  local.paths = Module._nodeModulePaths(path.dirname(sourcePath))
  local._compile(source.replace(original, replacement), sourcePath)
  return local.exports
}

test('Codex dynamic preflight distinguishes permitted loopback from denied non-loopback access', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-network-preflight-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const codexHome = path.join(root, 'codex-home')
  const target = path.join(root, 'target')
  fs.mkdirSync(codexHome, { mode: 0o700 })
  fs.mkdirSync(target, { mode: 0o700 })
  const address = activation.controlledNetworkProbeAddress()
  assert.doesNotMatch(address, /^(?:127\.|0\.0\.0\.0$)/)
  const options = {
    ...sealedProfileFixture(root),
    env: { ...process.env, CODEX_HOME: codexHome },
    // The real network controls write receipts in the target. The checkout
    // need not be writable by the caller running this isolated fixture.
    target,
  }
  assert.match(
    activation.probeCodexCommandNetwork(options, sandboxProbeSpawn('denied')),
    /^[a-f0-9]{64}$/,
  )
  assert.throws(
    () => activation.probeCodexCommandNetwork(options, sandboxProbeSpawn('open')),
    /PROVIDER_UNSUPPORTED provider=codex reason=codex-command-sandbox-network-open/,
  )
  assert.deepEqual(fs.readdirSync(codexHome), [], 'preflight must remove every listener artifact')
  assert.deepEqual(fs.readdirSync(target), [], 'preflight must remove every network receipt')
})

test('Codex network probe publishes its endpoint only after the ready bytes are complete', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-network-publication-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const codexHome = path.join(root, 'codex-home')
  const target = path.join(root, 'target')
  fs.mkdirSync(codexHome, { mode: 0o700 })
  fs.mkdirSync(target, { mode: 0o700 })
  const delayed = activationWithDelayedReadyPublication()
  assert.match(
    delayed.probeCodexCommandNetwork({
      ...sealedProfileFixture(root),
      env: { ...process.env, CODEX_HOME: codexHome },
      target,
    }, sandboxProbeSpawn('denied')),
    /^[a-f0-9]{64}$/,
  )
  assert.deepEqual(fs.readdirSync(codexHome), [], 'preflight must remove ready and publication artifacts')
  assert.deepEqual(fs.readdirSync(target), [], 'preflight must remove every network receipt')
})

test('activation signer and supervisor bind the exact Windows sandbox identity', () => {
  const record = {
    activationId: 'apv2-11111111111111111111111111111111',
    capability: { generation: 1 },
    request: { sha256: '1'.repeat(64) },
    target: { realpath: 'C:\\target', device: '1', inode: '2' },
    activationBoundary: {
      configSha256: '2'.repeat(64),
      payloadManifestSha256: '3'.repeat(64),
      enforcementProof: { profileSha256: '4'.repeat(64) },
      privatePermissions: { mechanism: 'windows-dacl', auditedPaths: 1 },
      sandboxIdentity: {
        kind: 'windows-cap-sid-v1', path: 'C:\\activation\\n\\cap_sid',
        sha256: '5'.repeat(64), sourceSha256: '6'.repeat(64),
      },
      supervisorAdapterSha256: '7'.repeat(64),
    },
    modelSelection: { mode: 'provider-default' },
    roleProjection: { payloadGeneration: 'codex-v2.0.0-0123456789abcdef' },
    providerProbe: { schemaVersion: 1 },
    providerCapabilities: { provider: 'codex' },
    safety: { mechanicallyEnforced: true },
  }
  const signed = activation.providerRuntimeIdentity(record)
  assert.equal(runtime.providerRuntimeIdentityHash(record), signed)
  const changed = structuredClone(record)
  changed.activationBoundary.sandboxIdentity.sha256 = '8'.repeat(64)
  assert.notEqual(runtime.providerRuntimeIdentityHash(changed), signed)
})

test('Windows sandbox identity rejects legacy cap_sid-only state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-windows-cap-sid-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const activationRoot = path.join(root, 'activation')
  fs.mkdirSync(activationRoot, { mode: 0o700 })
  const sourceIdentity = {
    readonly: 'S-1-5-21-100',
    workspace: 'S-1-5-21-101',
    workspace_by_cwd: { 'C:\\workspace': 'S-1-5-21-102' },
    writable_root_by_path: { 'C:\\workspace': 'S-1-5-21-103' },
  }
  fs.writeFileSync(path.join(root, 'cap_sid'), `${JSON.stringify(sourceIdentity)}\n`, { mode: 0o600 })
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  try {
    // A legacy restricted-token SID file is not the elevated sandbox setup.
    // The real native preflight covers installation and reopening of genuine
    // Windows setup state; this fixture must fail before any ACL mutation.
    assert.throws(() => activation.installWindowsSandboxIdentity(root, activationRoot),
      /codex-windows-sandbox-marker-parent-missing/)
    assert.equal(fs.existsSync(path.join(activationRoot, 'n', '.sandbox', 'setup_marker.json')), false)
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

test('manifest generation qualifies every physical provider role and rejects a wrong generation', t => {
  const generation = 'codex-v2.0.0-0123456789abcdef'
  const otherGeneration = 'codex-v2.0.0-fedcba9876543210'
  const roles = Object.keys(rolePolicy.physical_roles)
  const aliases = Object.fromEntries(roles.map(role => [
    role, activation.physicalProviderRole(role, generation),
  ]))
  assert.equal(new Set(Object.values(aliases)).size, roles.length)
  assert.notEqual(
    activation.physicalProviderRole('ap-worker', generation),
    activation.physicalProviderRole('ap-worker', otherGeneration),
  )

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-role-projection-'))
  const profilePath = path.join(root, 'autoprompt.config.toml')
  const agentsDirectory = path.join(root, 'agents-runtime')
  fs.mkdirSync(agentsDirectory)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const profile = ['[agents]', 'max_depth = 4', 'max_concurrent_threads_per_session = 5']
  for (const role of roles) {
    const physical = aliases[role]
    profile.push('', `[agents."${physical}"]`, `config_file = "agents-runtime/${physical}.toml"`)
    fs.writeFileSync(path.join(agentsDirectory, `${physical}.toml`), [
      `name = "${physical}"`,
      'model = "test-model"',
      'model_reasoning_effort = "low"',
      '',
    ].join('\n'), 'utf8')
  }
  fs.writeFileSync(profilePath, `${profile.join('\n')}\n`, 'utf8')
  const projection = {
    schemaVersion: 1,
    payloadGeneration: generation,
    logicalToPhysicalProviderRole: aliases,
  }
  assert.equal(activation.verifyRoleProjection(projection, profilePath), projection)
  const runtimeProjection = runtime.validateActivationRoleProjection({ roleProjection: projection }, profilePath, root)
  assert.deepEqual(runtime.readPrivateAgentAssignment({
    activationRoot: root,
    modelRegistry: null,
    modelSelection: {
      mode: 'explicit', models: ['test-model'], effort: 'low',
    },
    profilePath,
    roleProjection: runtimeProjection,
  }, 'ap-worker', 'worker'), {
    model: 'test-model', effort: 'low', source: 'explicit', registryMatched: false,
  })

  const workerPhysical = aliases['ap-worker']
  const workerFile = path.join(agentsDirectory, `${workerPhysical}.toml`)
  const originalWorker = fs.readFileSync(workerFile, 'utf8')
  for (const [label, mutated] of [
    ['logical', originalWorker.replace(`name = "${workerPhysical}"`, 'name = "ap-worker"')],
    ['missing', originalWorker.replace(`name = "${workerPhysical}"\n`, '')],
    ['duplicate', `${originalWorker}name = "${workerPhysical}"\n`],
  ]) {
    fs.writeFileSync(workerFile, mutated)
    assert.throws(
      () => activation.verifyRoleProjection(projection, profilePath),
      /private-role-projection-name-mismatch/,
      label,
    )
    assert.throws(
      () => runtime.validateActivationRoleProjection({ roleProjection: projection }, profilePath, root),
      /physical role name mismatch/,
      label,
    )
  }
  fs.writeFileSync(workerFile, originalWorker)

  const wrongGeneration = structuredClone(projection)
  wrongGeneration.payloadGeneration = otherGeneration
  assert.throws(
    () => activation.verifyRoleProjection(wrongGeneration, profilePath),
    /private-role-projection-generation-mismatch/,
  )
  assert.throws(
    () => runtime.validateActivationRoleProjection({ roleProjection: wrongGeneration }, profilePath, root),
    /physical role generation mismatch/,
  )
})
