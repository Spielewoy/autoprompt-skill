#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '..', '..')
const CLI = path.join(ROOT, 'bin', 'autoprompt.cjs')
const CONFIGURE = path.join(ROOT, 'scripts', 'codex-configure.cjs')
const CASTING = path.join(ROOT, 'agents', 'codex', 'workflow', 'codex-agent-casting.js')
const PROFILE = path.join(ROOT, 'agents', 'codex', 'workflow', 'codex-agent-profile.js')
const { HELP_TEXT, parseArgs } = require('../../bin/autoprompt.cjs')
const codexConfigure = require('../../scripts/codex-configure.cjs')
const { renderManifests } = require('../../scripts/runtime-payload.cjs')
const { pinnedCodexPackageFixture } = require('../helpers/pinned-codex-package.cjs')
const { runOwnedTestProcess, processFailureDetails } = require('../helpers/owned-test-process.cjs')
const TEMP_ROOT = fs.realpathSync.native(os.tmpdir())
const FIXTURE_PREFIXES = new Set([
  'autoprompt codex configure ',
  'autoprompt casting recovery ',
  'autoprompt packed configure ',
])
const createdFixtures = new Set()

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  })
}

function npmCliPath() {
  return [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean).find(file => fs.existsSync(file))
}

function nestedNpmEnvironment(environment) {
  const nested = { ...environment }
  for (const key of Object.keys(nested)) {
    if (key.toLowerCase() === 'npm_config_dry_run') delete nested[key]
  }
  return nested
}

function comparable(file) {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function removeFixture(binding) {
  assert.equal(binding.pendingProcesses.size, 0,
    `fixture retained because owned subprocess cleanup is incomplete: ${JSON.stringify([...binding.pendingProcesses])}`)
  const resolved = path.resolve(binding.path)
  assert.equal(comparable(path.dirname(resolved)), comparable(TEMP_ROOT),
    'fixture cleanup target must remain directly below the temp root')
  assert.equal(path.basename(resolved).startsWith(binding.prefix), true,
    'fixture cleanup target must retain its created prefix')
  assert.match(path.basename(resolved).slice(binding.prefix.length), /^[A-Za-z0-9]{6}$/,
    'fixture cleanup target must retain its mkdtemp suffix')
  let current
  try {
    current = fs.lstatSync(resolved, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  assert.equal(current.isDirectory() && !current.isSymbolicLink(), true,
    'fixture cleanup target must remain a real directory')
  assert.equal(String(current.dev), binding.device,
    'fixture cleanup target device must match the created directory')
  assert.equal(String(current.ino), binding.inode,
    'fixture cleanup target inode must match the created directory')
  fs.rmSync(resolved, { recursive: true, force: true })
  assert.equal(fs.existsSync(resolved), false, 'fixture cleanup must leave no residue')
}

function createFixture(t, prefix) {
  assert.equal(FIXTURE_PREFIXES.has(prefix), true, 'fixture prefix must be registered')
  assert.equal(typeof t?.after, 'function', 'fixture creation requires a test cleanup hook')
  const requested = fs.mkdtempSync(path.join(TEMP_ROOT, prefix))
  const sandbox = fs.realpathSync.native(requested)
  const stat = fs.lstatSync(sandbox, { bigint: true })
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true)
  const binding = {
    device: String(stat.dev),
    inode: String(stat.ino),
    path: sandbox,
    prefix,
    pendingProcesses: new Set(),
  }
  createdFixtures.add(binding)
  t.after(async () => {
    // Node cancellation can start after-hooks while an aborted tree drains.
    await Promise.all([...binding.pendingProcesses].map(owner => owner.settled))
    removeFixture(binding)
  })
  return { binding, sandbox }
}

function makeInstall(t, complete = false) {
  const fixture = createFixture(t, 'autoprompt codex configure ')
  const { sandbox } = fixture
  const root = path.join(sandbox, 'codex root')
  const toolEnv = { ...process.env, HOME: path.join(sandbox, 'home') }
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'manifests', 'codex-runtime.json'), 'utf8',
  ))
  const bundleRoot = path.join(
    root, '.autoprompt-private', 'bundles', manifest.payloadGeneration,
  )
  const skillRoot = path.join(bundleRoot, 'skills', 'autoprompt')
  const agents = path.join(skillRoot, 'agents-runtime')
  const discoverySkill = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const profile = path.join(root, 'autoprompt.config.toml')
  fs.mkdirSync(agents, { recursive: true })
  fs.mkdirSync(path.dirname(discoverySkill), { recursive: true })
  fs.writeFileSync(discoverySkill, [
    '---',
    'name: autoprompt',
    'activation: explicit-only',
    'allow-implicit-invocation: false',
    '---',
    '',
    'Run only through `autoprompt activate codex ... -- <mission>`.',
    '',
  ].join('\n'))
  for (const name of fs.readdirSync(path.join(ROOT, 'agents', 'codex', 'agents'))) {
    if (/^ap-.*\.toml$/.test(name)) {
      fs.copyFileSync(path.join(ROOT, 'agents', 'codex', 'agents', name), path.join(agents, name))
    }
  }
  assert.equal(run(process.execPath, [
    CASTING, '--write-manifest', '--agents-dir', agents, '--selector', 'off',
  ], { env: toolEnv }).status, 0)
  assert.equal(run(process.execPath, [
    PROFILE, '--write', '--agents-dir', agents, '--profile', profile,
  ]).status, 0)

  const managed = [
    discoverySkill,
    ...fs.readdirSync(agents).filter(name => /^ap-.*\.toml$/.test(name)).sort()
      .map(name => path.join(agents, name)),
    path.join(agents, '.autoprompt-casting.json'),
    profile,
  ]
  const hashes = Object.fromEntries(managed.map(file => [file, sha256(file)]))
  const hashManifest = path.join(root, '.autoprompt-install-hashes.json')
  fs.writeFileSync(hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
  const receipt = path.join(root, '.autoprompt-install-receipt.json')
  fs.writeFileSync(receipt, `${JSON.stringify({
    nonce: 'test-receipt',
    backup: 'none',
    files: [...managed, hashManifest],
    createdDirectories: [],
    configEdits: [],
  }, null, 2)}\n`)
  const env = {
    ...process.env,
    AUTOPROMPT_INSTALL_ROOT: root,
    HOME: path.join(sandbox, 'home'),
    USERPROFILE: path.join(sandbox, 'home'),
  }
  const context = {
    agents, bundleRoot, discoverySkill, env, fixture, hashManifest, manifest,
    profile, receipt, root, sandbox, skillRoot,
  }
  if (complete) completeManagedV5Payload(context)
  return context
}

test('Codex checker activation profile is a separate mechanically read-only profile', () => {
  const environment = { HOME: 'C:\\private', USERPROFILE: 'C:\\private' }
  const main = codexConfigure.renderSecurityProfile(environment)
  const checker = codexConfigure.renderSecurityProfile(environment, 'read-only')
  assert.match(main, /^sandbox_mode = "workspace-write"$/m)
  assert.match(main, /^\[sandbox_workspace_write\]$/m)
  assert.match(checker, /^sandbox_mode = "read-only"$/m)
  assert.doesNotMatch(checker, /^\[sandbox_workspace_write\]$/m)
  assert.match(checker, /^web_search = "disabled"$/m)
  for (const feature of ['apps', 'browser_use', 'enable_mcp_apps', 'multi_agent', 'multi_agent_v2']) {
    assert.match(checker, new RegExp(`^${feature} = false$`, 'm'))
  }
})

test('Windows activation prerequisites fail closed without a provider-owned sandbox identity', {
  skip: process.platform !== 'win32',
}, t => {
  const context = makeInstall(t)
  assert.equal(fs.existsSync(path.join(context.root, 'cap_sid')), false)
  const error = captureUnsupported(() => codexConfigure.inspectActivationPrerequisites({
    env: { ...context.env, CODEX_HOME: context.root, PATH: '' },
  }))
  assert.equal(error.reason, 'codex-windows-sandbox-identity-unavailable')
})

test('Codex local-only activation proof accepts an exact detached HEAD', t => {
  const { sandbox } = createFixture(t, 'autoprompt codex configure ')
  const target = path.join(sandbox, 'detached-target')
  const activationRoot = path.join(sandbox, 'activation')
  const configIsolationPath = path.join(activationRoot, 'empty.gitconfig')
  const ghConfigDir = path.join(activationRoot, 'gh-config')
  const profilePath = path.join(activationRoot, 'autoprompt.config.toml')
  const proofPath = path.join(activationRoot, 'enforcement-proof.json')
  fs.mkdirSync(target)
  fs.mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(configIsolationPath, '', { mode: 0o600 })
  const profile = [
    'sandbox_mode = "workspace-write"', 'web_search = "disabled"', '',
    '[sandbox_workspace_write]', 'network_access = false', '', '[features]',
    'apps = false', 'enable_mcp_apps = false', 'plugins = false',
    'remote_plugin = false', 'browser_use = false', 'browser_use_external = false',
    'in_app_browser = false', 'computer_use = false', 'image_generation = false', '',
  ].join('\n')
  fs.writeFileSync(profilePath, profile, { mode: 0o600 })
  const proof = {
    schemaVersion: 1,
    provider: 'codex',
    profilePath,
    profileSha256: crypto.createHash('sha256').update(profile).digest('hex'),
    selectedProfile: 'autoprompt',
    strictConfig: true,
  }
  fs.writeFileSync(proofPath, `${JSON.stringify(proof)}\n`, { mode: 0o600 })
  for (const argv of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Detached Activation Test'],
    ['config', 'user.email', 'detached-activation@example.invalid'],
    ['commit', '--quiet', '--allow-empty', '-m', 'detached activation fixture'],
    ['checkout', '--quiet', '--detach', 'HEAD'],
  ]) {
    const result = run('git', argv, { cwd: target })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }

  const safety = require('../../scripts/local-only-safety.cjs')
  const environment = safety.createSafeChildGitEnvironment(target, process.env, {
    configIsolationPath,
    ghConfigDir,
  })
  const repaired = run(process.execPath, [
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    '--repo', target,
    '--expected-branch', '',
    '--enforcement-proof', proofPath,
    '--repair',
    '--json',
  ], { env: environment })
  assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout)

  const inspection = codexConfigure.proveLocalOnlySafety(target, environment, proof)
  assert.equal(inspection.mechanicallyEnforced, true)
  assert.equal(inspection.actualBranch, null)
  assert.equal(inspection.head.state, 'detached')
  assert.match(inspection.head.oid, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
})

test('historical global-role registry classifies legacy roles without a current install receipt', t => {
  const fixture = createFixture(t, 'autoprompt codex configure ')
  const root = path.join(fixture.sandbox, 'codex root')
  const globalAgents = path.join(root, 'agents')
  fs.mkdirSync(globalAgents, { recursive: true })
  const legacy = path.join(globalAgents, 'ap-reviewer.toml')
  fs.copyFileSync(path.join(ROOT, 'agents', 'codex', 'agents', 'ap-reviewer.toml'), legacy)
  const report = codexConfigure.inventoryIsolation({
    env: { ...process.env, AUTOPROMPT_INSTALL_ROOT: root, HOME: fixture.sandbox, USERPROFILE: fixture.sandbox },
  })
  assert.deepEqual(report.knownLegacy, [legacy])
  assert.equal(report.knownLegacyAssets[0].provenance,
    'historical-global-role-registry@1.0.5')
})

test('Codex resume entry is structurally bound to the exact activation id', () => {
  const activationId = `apv2-${'a'.repeat(32)}`
  const record = {
    activationId,
    capability: {
      recordPath: 'C:\\private\\activation.json', parentSession: 'root',
      parentRole: 'autoprompt-root', legalChildren: ['ap-route-analyst'],
      generation: 2, expiresAt: '2030-01-01T00:00:00.000Z',
    },
    request: {
      sha256: 'b'.repeat(64), bytes: 2, canonicalBase64: 'e30=', argv: ['resume'],
      canonicalJson: '{}',
    },
    target: { realpath: 'C:\\target' },
  }
  assert.equal(codexConfigure.activationEnvelope(record).split('\n')[0], '$autoprompt')
  assert.equal(codexConfigure.activationEnvelope(record, activationId).split('\n')[0],
    `$autoprompt resume ${activationId}`)
})

function completeManagedPayload(context) {
  const manifestPath = path.join(ROOT, 'agents', 'manifests', 'codex-runtime.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const managed = []
  for (const relative of manifest.files) {
    const source = path.join(ROOT, 'agents', 'codex', ...relative.split('/'))
    const destination = path.join(context.skillRoot, ...relative.split('/'))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
    managed.push(destination)
  }
  for (const dependency of manifest.externalDependencies) {
    const source = path.join(ROOT, ...dependency.source.split('/'))
    const destination = path.join(context.bundleRoot, ...dependency.destination.split('/'))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
    managed.push(destination)
  }
  const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
  receipt.files = [...new Set([...receipt.files, ...managed])]
  fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
  const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
  for (const file of managed) hashes[file] = sha256(file)
  fs.writeFileSync(context.hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
  return { manifest, manifestPath }
}

function portableInstallKey(root, file) {
  const relative = path.relative(root, path.resolve(file))
  assert.notEqual(relative, '')
  assert.equal(path.isAbsolute(relative), false)
  assert.notEqual(relative, '..')
  assert.equal(relative.startsWith(`..${path.sep}`), false)
  return relative.split(path.sep).join('/')
}

function completeManagedV5Payload(context) {
  const completed = completeManagedPayload(context)
  const { manifest, manifestPath } = completed
  const markerPath = path.join(
    context.skillRoot, manifest.embeddedReceipt,
  )
  fs.copyFileSync(manifestPath, markerPath)
  const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
  receipt.files = [...new Set([...receipt.files, markerPath])]
  fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
  const absoluteHashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
  absoluteHashes[markerPath] = sha256(markerPath)
  const relativeHashes = Object.fromEntries(Object.entries(absoluteHashes).map(([file, hash]) => [
    portableInstallKey(context.root, file), hash,
  ]))
  fs.writeFileSync(context.hashManifest, `${JSON.stringify(relativeHashes, null, 2)}\n`)
  const phaseBudgetPath = path.join(
    context.skillRoot, 'workflow', 'phase-budget.js',
  )
  return {
    ...completed,
    markerPath,
    markerKey: portableInstallKey(context.root, markerPath),
    phaseBudgetKey: portableInstallKey(context.root, phaseBudgetPath),
    phaseBudgetPath,
  }
}

function rewriteRelativeHash(context, file) {
  const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
  hashes[portableInstallKey(context.root, file)] = sha256(file)
  fs.writeFileSync(context.hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
}

function captureUnsupported(action) {
  let captured = null
  try { action() } catch (error) { captured = error }
  assert.ok(captured, 'the managed payload audit must fail closed')
  assert.equal(captured instanceof codexConfigure.ProviderUnsupportedError, true)
  return captured
}

function makeActivationCopyContext(t) {
  const context = makeInstall(t)
  const completed = completeManagedV5Payload(context)
  const payload = codexConfigure.managedCodexPayload(context.root)
  const activationRoot = path.join(context.sandbox, 'copy-root')
  fs.mkdirSync(activationRoot)
  return {
    ...context,
    completed,
    payload,
    activationRoot,
    env: { ...context.env, CODEX_HOME: context.root },
  }
}

function assertNoActivationPublication(context) {
  assert.equal(fs.existsSync(path.join(context.root, '.a')), false)
  assert.equal(fs.existsSync(path.join(context.activationRoot, 'activation-payload.json')), false)
  assert.deepEqual(
    fs.readdirSync(context.activationRoot, { recursive: true }).filter(file =>
      /activation-payload\.json$|activation\.json$/u.test(file)),
    [],
  )
}

function managedBytesSnapshot(context, manifestPath) {
  const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
  const files = [...new Set([
    ...receipt.files.filter(file => typeof file === 'string' && fs.existsSync(file)),
    context.hashManifest,
    context.receipt,
    manifestPath,
  ])].sort()
  return Object.fromEntries(files.map(file => [file, sha256(file)]))
}

function invoke(context, args, extra = {}) {
  return run(process.execPath, [CLI, ...args], {
    env: { ...context.env, ...(extra.env || {}) },
    ...extra,
  })
}

function snapshot(context) {
  const names = fs.readdirSync(context.agents).sort()
  return new Map([
    ...names.map(name => [path.join(context.agents, name), fs.readFileSync(path.join(context.agents, name))]),
    [context.profile, fs.readFileSync(context.profile)],
    [context.hashManifest, fs.readFileSync(context.hashManifest)],
    [context.receipt, fs.readFileSync(context.receipt)],
  ])
}

function assertSnapshot(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()])
  for (const [file, bytes] of expected) assert.deepEqual(actual.get(file), bytes, file)
}

function temporaryConfigureArtifacts(root) {
  const found = []
  const visit = directory => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.name.includes('.autoprompt-configure-')) found.push(target)
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(target)
    }
  }
  visit(root)
  return found
}

test.after(() => {
  assert.deepEqual(
    [...createdFixtures].filter(binding => fs.existsSync(binding.path)).map(binding => binding.path),
    [],
    'every fixture created by this file must be removed',
  )
})

test('managed Codex role projection rejects stale physical ids and alias fallback', () => {
  const manifest = renderManifests(ROOT).get('agents/manifests/codex-runtime.json')
  const projection = codexConfigure.validateRuntimeRoleProjection(manifest)
  assert.deepEqual(projection.logicalToPhysicalProviderRole, manifest.logicalToPhysicalProviderRole)

  const stale = structuredClone(manifest)
  stale.logicalToPhysicalProviderRole['ap-worker'] = codexConfigure.physicalProviderRole(
    'ap-worker', 'codex-v2.0.0-fedcba9876543210',
  )
  stale.physicalRoles = Object.values(stale.logicalToPhysicalProviderRole).sort()
  assert.throws(
    () => codexConfigure.validateRuntimeRoleProjection(stale),
    /codex-runtime-role-projection-generation-mismatch/,
  )

  const aliasFallback = structuredClone(manifest)
  aliasFallback.logicalToPhysicalProviderRole['ap-worker'] = 'ap-worker'
  aliasFallback.physicalRoles = Object.values(aliasFallback.logicalToPhysicalProviderRole).sort()
  assert.throws(
    () => codexConfigure.validateRuntimeRoleProjection(aliasFallback),
    /codex-runtime-role-projection-generation-mismatch/,
  )
})

test('receipt-bound Codex payload remains byte-identical across side-by-side projections', t => {
  const context = makeInstall(t)
  const { manifest, manifestPath } = completeManagedV5Payload(context)
  const before = managedBytesSnapshot(context, manifestPath)
  const projected = []
  for (const suffix of ['first', 'second']) {
    const activationRoot = path.join(context.sandbox, `private-${suffix}`)
    fs.mkdirSync(activationRoot)
    const payload = codexConfigure.managedCodexPayload(context.root)
    projected.push(codexConfigure.copyActivationPayload(
      context.root,
      activationRoot,
      payload,
      { HOME: context.sandbox, USERPROFILE: context.sandbox },
    ))
    assert.deepEqual(managedBytesSnapshot(context, manifestPath), before)
  }
  assert.deepEqual(projected[0].roleProjection, projected[1].roleProjection)
  assert.deepEqual(
    projected[0].roleProjection.logicalToPhysicalProviderRole,
    manifest.logicalToPhysicalProviderRole,
  )
  for (const [logicalRole, physicalRole] of Object.entries(
    projected[0].roleProjection.logicalToPhysicalProviderRole,
  )) {
    const projectedRole = fs.readFileSync(path.join(
      projected[0].activationSkillRoot, 'agents-runtime', `${physicalRole}.toml`,
    ), 'utf8')
    assert.match(projectedRole, new RegExp(`^name = "${physicalRole}"$`, 'm'))
    assert.doesNotMatch(projectedRole, new RegExp(`^name = "${logicalRole}"$`, 'm'))
  }

  const driftFile = path.join(context.skillRoot, 'SKILL.md')
  const expected = sha256(driftFile)
  fs.appendFileSync(driftFile, '\nreceipt-bound hostile drift\n')
  const actual = sha256(driftFile)
  let driftError
  try {
    codexConfigure.managedCodexPayload(context.root)
  } catch (error) {
    driftError = error
  }
  assert.ok(driftError)
  assert.equal(driftError.reason, 'managed-payload-drift')
  assert.deepEqual(driftError.details, { file: 'SKILL.md', expected, actual })
  assert.match(driftError.message, new RegExp(
    `reason=managed-payload-drift file=SKILL\\.md expected=${expected} actual=${actual}`,
  ))
})

test('managed Codex payload resolves one exact private generation behind an exact-only shim', t => {
  const context = makeInstall(t)
  const completed = completeManagedV5Payload(context)
  const payload = codexConfigure.managedCodexPayload(context.root)
  assert.equal(payload.bundleRoot, context.bundleRoot)
  assert.equal(payload.skillRoot, context.skillRoot)
  assert.equal(payload.discoverySkill, context.discoverySkill)
  assert.equal(payload.payloadGeneration, completed.manifest.payloadGeneration)
  assert.equal(payload.files.some(entry => entry.file === context.discoverySkill), false)
  assert.equal(payload.files.every(entry => entry.file.startsWith(`${context.skillRoot}${path.sep}`)), true)

  const exposed = path.join(context.root, 'skills', 'autoprompt', 'GATES.md')
  fs.writeFileSync(exposed, 'ambient governance must never be receipt-owned\n')
  const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
  receipt.files.push(exposed)
  fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
  const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
  hashes[portableInstallKey(context.root, exposed)] = sha256(exposed)
  fs.writeFileSync(context.hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
  assert.equal(
    captureUnsupported(() => codexConfigure.managedCodexPayload(context.root)).reason,
    'ambient-runtime-payload-exposed',
  )
})

test('managed Codex payload rejects a hash-coherent ambient shim without exact-only policy', t => {
  const context = makeInstall(t)
  completeManagedV5Payload(context)
  fs.writeFileSync(context.discoverySkill, [
    '---', 'name: autoprompt', '---', '',
    'Use this for planning and review.', '',
  ].join('\n'))
  rewriteRelativeHash(context, context.discoverySkill)
  assert.equal(
    captureUnsupported(() => codexConfigure.managedCodexPayload(context.root)).reason,
    'manual-entry-shim-policy-missing',
  )
})

test('managed Codex payload rejects hash-coherent generic ambient trigger wording', t => {
  const context = makeInstall(t)
  completeManagedV5Payload(context)
  fs.writeFileSync(context.discoverySkill, [
    '---', 'name: autoprompt', 'activation: explicit-only',
    'allow-implicit-invocation: false', '---', '',
    'Run only through `autoprompt activate codex ... -- <mission>`.',
    'Automatically use this skill whenever planning or review begins.', '',
  ].join('\n'))
  rewriteRelativeHash(context, context.discoverySkill)
  assert.equal(
    captureUnsupported(() => codexConfigure.managedCodexPayload(context.root)).reason,
    'manual-entry-generic-trigger-forbidden',
  )
})

test('managed Codex v5 relative hash keys resolve from the install root independently of cwd', t => {
  const context = makeInstall(t)
  const completed = completeManagedV5Payload(context)
  const alternateCwd = path.join(context.sandbox, 'unrelated-cwd')
  fs.mkdirSync(alternateCwd)
  const originalCwd = process.cwd()
  const observed = []
  try {
    for (const cwd of [ROOT, alternateCwd]) {
      process.chdir(cwd)
      const payload = codexConfigure.managedCodexPayload(context.root)
      const phaseBudget = payload.files.filter(entry =>
        entry.relative.split(path.sep).join('/') === 'workflow/phase-budget.js')
      assert.equal(phaseBudget.length, 1)
      observed.push({
        file: phaseBudget[0].file,
        payloadGeneration: payload.payloadGeneration,
        sha256: phaseBudget[0].sha256,
      })
    }
  } finally {
    process.chdir(originalCwd)
  }
  assert.deepEqual(observed, [ROOT, alternateCwd].map(() => ({
    file: completed.phaseBudgetPath,
    payloadGeneration: completed.manifest.payloadGeneration,
    sha256: sha256(completed.phaseBudgetPath),
  })))
})

test('managed Codex v5 missing phase-budget relative mapping fails closed before activation copy', t => {
  const context = makeInstall(t)
  const completed = completeManagedV5Payload(context)
  const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
  delete hashes[completed.phaseBudgetKey]
  fs.writeFileSync(context.hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
  const error = captureUnsupported(() => codexConfigure.managedCodexPayload(context.root))
  assert.equal(['managed-payload-drift', 'managed-runtime-closure-incomplete'].includes(error.reason), true)
  assert.equal(error.details?.file, 'workflow/phase-budget.js')
  assert.equal(error.details?.expected === 'missing' || error.details?.actual === 'missing', true)
})

test('managed Codex v5 rejects receipt paths spanning multiple install roots before activation copy', t => {
  const context = makeInstall(t)
  completeManagedV5Payload(context)
  const foreignRoot = path.join(context.sandbox, 'second-install-root')
  const foreignFile = path.join(foreignRoot, 'skills', 'autoprompt', 'workflow', 'phase-budget.js')
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js'), foreignFile)
  const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
  receipt.files.push(foreignFile)
  fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
  const error = captureUnsupported(() => codexConfigure.managedCodexPayload(context.root))
  assert.equal(error.reason, 'managed-payload-receipt-root-mismatch')
})

test('managed Codex v5 rejects a junction that escapes the receipt root before activation copy', {
  skip: process.platform !== 'win32',
}, t => {
  const context = makeInstall(t)
  completeManagedV5Payload(context)
  const workflow = path.join(context.skillRoot, 'workflow')
  const foreignWorkflow = path.join(context.sandbox, 'foreign-workflow')
  fs.cpSync(workflow, foreignWorkflow, { recursive: true })
  fs.rmSync(workflow, { recursive: true, force: true })
  fs.symlinkSync(foreignWorkflow, workflow, 'junction')
  const error = captureUnsupported(() => codexConfigure.managedCodexPayload(context.root))
  assert.equal(error.reason, 'managed-payload-escape')
})

test('managed Codex v5 rejects missing and stale embedded runtime markers before activation copy', t => {
  const missing = makeInstall(t)
  const missingPayload = completeManagedV5Payload(missing)
  fs.unlinkSync(missingPayload.markerPath)
  const missingError = captureUnsupported(() => codexConfigure.managedCodexPayload(missing.root))
  assert.equal([
    'managed-payload-file-missing', 'managed-runtime-generation-marker-missing',
  ].includes(missingError.reason), true)

  const stale = makeInstall(t)
  const stalePayload = completeManagedV5Payload(stale)
  fs.appendFileSync(stalePayload.markerPath, '\n')
  const staleError = captureUnsupported(() => codexConfigure.managedCodexPayload(stale.root))
  assert.equal(staleError.reason, 'managed-payload-drift')
  assert.equal(staleError.details?.file, stalePayload.manifest.embeddedReceipt)
})

test('managed Codex v5 rejects a wrong embedded generation and digest despite coherent receipt hashes', t => {
  const context = makeInstall(t)
  const completed = completeManagedV5Payload(context)
  const installedMarker = JSON.parse(fs.readFileSync(completed.markerPath, 'utf8'))
  installedMarker.payloadGeneration = 'codex-v2.0.0-0000000000000000'
  installedMarker.payloadDigest = '0'.repeat(64)
  fs.writeFileSync(completed.markerPath, `${JSON.stringify(installedMarker, null, 2)}\n`)
  rewriteRelativeHash(context, completed.markerPath)
  const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
  assert.equal(hashes[completed.markerKey], sha256(completed.markerPath),
    'the hostile marker raw bytes must remain internally receipt/hash coherent')
  const error = captureUnsupported(() => codexConfigure.managedCodexPayload(context.root))
  assert.equal(error.reason, 'managed-runtime-generation-mismatch')
})

test('managed Codex copy boundary rejects a source mutation after validation without publication', t => {
  const context = makeActivationCopyContext(t)
  const expected = sha256(context.completed.phaseBudgetPath)
  fs.appendFileSync(context.completed.phaseBudgetPath, '\npost-validation hostile mutation\n')
  let captured = null
  try {
    codexConfigure.copyActivationPayload(context.root, context.activationRoot, context.payload, context.env)
  } catch (error) {
    captured = error
  }
  assert.ok(captured, 'post-validation source mutation must abort the real copy boundary')
  assert.equal(captured instanceof codexConfigure.ProviderUnsupportedError, true)
  assert.equal([
    'managed-payload-source-changed', 'managed-payload-drift',
  ].includes(captured.reason), true)
  assert.notEqual(sha256(context.completed.phaseBudgetPath), expected)
  assert.equal(fs.existsSync(path.join(context.root, '.a')), false,
    'the unit copy boundary must not create an activated run')
  assert.equal(fs.existsSync(path.join(context.activationRoot, 'activation-payload.json')), false)
  assert.deepEqual(
    fs.readdirSync(context.root, { recursive: true }).filter(file =>
      /activation-payload\.json$|activation\.json$|autoprompt\.config\.toml\.tmp|\.tmp-/u.test(file)),
    [],
    'source installation must retain no activation or temporary pointer residue',
  )
})

test('managed Codex copy publishes stable source bytes with the frozen expected hash and no wrapper residue', t => {
  const context = makeInstall(t)
  const completed = completeManagedV5Payload(context)
  const payload = codexConfigure.managedCodexPayload(context.root)
  const expected = sha256(completed.phaseBudgetPath)
  const binding = payload.sourceBindings[process.platform === 'win32'
    ? path.resolve(completed.phaseBudgetPath).toLowerCase()
    : path.resolve(completed.phaseBudgetPath)]
  assert.equal(Object.isFrozen(payload.sourceBindings), true)
  assert.equal(Object.isFrozen(payload.validatedRoot), true)
  assert.equal(Object.isFrozen(binding), true)
  assert.equal(binding.sha256, expected)
  const sourceBefore = fs.readFileSync(completed.phaseBudgetPath)
  const activationRoot = path.join(context.sandbox, 'stable-copy-root')
  fs.mkdirSync(activationRoot)
  codexConfigure.copyActivationPayload(
    context.root, activationRoot, payload,
    { HOME: context.sandbox, USERPROFILE: context.sandbox },
  )
  const destination = path.join(
    activationRoot, 'skills', 'autoprompt', 'workflow', 'phase-budget.js',
  )
  assert.deepEqual(fs.readFileSync(destination), sourceBefore)
  assert.equal(sha256(completed.phaseBudgetPath), expected)
  assert.equal(sha256(destination), expected)
  const manifest = JSON.parse(fs.readFileSync(
    path.join(activationRoot, 'activation-payload.json'), 'utf8',
  ))
  assert.deepEqual(manifest.files.filter(entry =>
    entry.path === 'skills/autoprompt/workflow/phase-budget.js'), [{
    path: 'skills/autoprompt/workflow/phase-budget.js', sha256: expected,
  }])
  assert.deepEqual(fs.readdirSync(activationRoot, { recursive: true }).filter(file =>
    /\.tmp-|\.autoprompt\.tmp|\.wrapper|\.new-hash/u.test(file)), [])
})

test('managed Codex copy rejects captured source file and directory-alias swaps before publication', async t => {
  for (const kind of ['file-swap', 'junction-swap']) {
    await t.test(kind, subtest => {
    const context = makeActivationCopyContext(subtest)
    const aliasType = process.platform === 'win32' ? 'junction' : 'dir'
    if (kind === 'junction-swap') {
      const probeOutside = path.join(context.sandbox, 'junction-capability-target')
      const probeLink = path.join(context.sandbox, 'junction-capability-link')
      fs.mkdirSync(probeOutside)
      try {
        fs.symlinkSync(probeOutside, probeLink, aliasType)
        assert.equal(fs.realpathSync.native(probeLink), fs.realpathSync.native(probeOutside))
        fs.unlinkSync(probeLink)
      } catch (error) {
        if (['EPERM', 'ENOTSUP', 'EINVAL'].includes(error?.code)) {
          subtest.skip(`directory alias unsupported by host: ${error.code}`)
          return
        }
        throw error
      }
    }
    if (kind === 'file-swap') {
      const captured = `${context.completed.phaseBudgetPath}.captured`
      fs.renameSync(context.completed.phaseBudgetPath, captured)
      fs.writeFileSync(context.completed.phaseBudgetPath, 'hostile replacement\n')
    } else {
      const workflow = path.dirname(context.completed.phaseBudgetPath)
      const outside = path.join(context.sandbox, 'hostile-workflow')
      fs.cpSync(workflow, outside, { recursive: true })
      fs.rmSync(workflow, { recursive: true, force: true })
      fs.symlinkSync(outside, workflow, aliasType)
    }
    let captured = null
    try {
      codexConfigure.copyActivationPayload(context.root, context.activationRoot, context.payload, context.env)
    } catch (error) { captured = error }
    assert.equal(captured instanceof codexConfigure.ProviderUnsupportedError, true, kind)
    assert.equal([
      'managed-payload-source-changed', 'managed-payload-drift', 'managed-payload-escape',
    ].includes(captured.reason), true, kind)
    assertNoActivationPublication(context)
    })
  }
})

test('managed Codex copy rejects a destination-parent swap before verified temp publication', t => {
  const context = makeActivationCopyContext(t)
  const hostile = path.join(context.sandbox, 'hostile-destination-parent')
  const originalRename = fs.renameSync
  let swapEvents = 0
  fs.renameSync = function renameWithParentSwap(source, destination) {
    if (swapEvents === 0 && /skills[\\/]autoprompt[\\/]workflow[\\/]phase-budget\.js$/u.test(destination) &&
        /\.tmp-/u.test(source)) {
      swapEvents += 1
      const parent = path.dirname(destination)
      const displaced = `${parent}.captured`
      originalRename.call(this, parent, displaced)
      fs.mkdirSync(hostile)
      fs.symlinkSync(hostile, parent, process.platform === 'win32' ? 'junction' : 'dir')
    }
    return originalRename.call(this, source, destination)
  }
  let captured = null
  try {
    codexConfigure.copyActivationPayload(context.root, context.activationRoot, context.payload, context.env)
  } catch (error) {
    captured = error
  } finally {
    fs.renameSync = originalRename
  }
  assert.ok(captured)
  assert.equal(captured instanceof codexConfigure.ProviderUnsupportedError, true)
  assert.equal([
    'managed-payload-source-changed', 'private-write-parent-raced', 'activation-payload-escape',
  ].includes(captured.reason), true)
  assert.equal(swapEvents, 1)
  assertNoActivationPublication(context)
  assert.deepEqual(fs.readdirSync(hostile), [], 'the raced parent must receive no copied bytes')
  // This is the real copy boundary, not prepareActivation's outer rollback.
  // A displaced owned temporary file may remain inside the isolated fixture;
  // fixture cleanup removes it. No activation manifest may publish that copy.
})

test('configure parser accepts the bounded Codex surface and rejects malformed input', () => {
  assert.match(HELP_TEXT, /configure codex .*\[--root <absolute-path>\]/)
  assert.deepEqual(parseArgs(['configure', 'codex', '--agents', 'off']), {
    command: 'configure', provider: 'codex', selector: 'off', modelMap: '',
  })
  assert.deepEqual(parseArgs([
    'configure', 'codex', '--agents', 'auto', '--model-map', 'C:\\models\\map.json',
  ]), {
    command: 'configure', provider: 'codex', selector: 'auto', modelMap: 'C:\\models\\map.json',
  })
  const root = path.resolve('codex configure root')
  assert.deepEqual(parseArgs([
    'configure', 'codex', '--agents', 'off', '--root', root,
  ]), {
    command: 'configure', provider: 'codex', selector: 'off', modelMap: '', root,
  })
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    assert.deepEqual(parseArgs(['configure', 'codex', '--agents', 'gpt-5.6-sol', '--effort', effort]), {
      command: 'configure', provider: 'codex', selector: 'gpt-5.6-sol', modelMap: '', effort,
    })
  }
  for (const args of [
    ['configure'],
    ['configure', 'claude', '--agents', 'off'],
    ['configure', 'codex'],
    ['configure', 'codex', '--agents'],
    ['configure', 'codex', '--agents', 'off', '--agents', 'auto'],
    ['configure', 'codex', '--agents', 'off', '--root', 'relative'],
    ['configure', 'codex', '--agents', 'off', '--effort', 'xhigh'],
    ['configure', 'codex', '--agents', 'gpt-5.6-sol', '--effort'],
    ['configure', 'codex', '--agents', 'gpt-5.6-sol', '--effort', 'max'],
    ['configure', 'codex', '--agents', 'gpt-5.6-sol', '--effort', 'xhigh', '--effort', 'high'],
    ['configure', 'codex', '--unknown', 'value'],
  ]) {
    assert.throws(() => parseArgs(args), error => error?.code === 'AUTOPROMPT_USAGE', args.join(' '))
  }
})

test('explicit effort configures receipt-bound private assignments and omission restores exact defaults', t => {
  const context = makeInstall(t, true)
  const { readPrivateAgentAssignment, createDefaultRuntimeOptions } = require('../../agents/codex/workflow/phase-budget.js')
  // Exercise the real assignment implementation called by the production
  // resolver, without claiming full activation/capability admission here.
  assert.match(createDefaultRuntimeOptions.toString(), /assignmentResolver:\s*\(\{ providerRole, logicalRole \}\) =>\s*readPrivateAgentAssignment\(activation, providerRole, logicalRole\)/u)
  const args = ['configure', 'codex', '--agents', 'gpt-5.6-sol']
  const initial = invoke(context, args)
  assert.equal(initial.status, 0, initial.stderr)
  const defaults = snapshot(context)
  const configured = invoke(context, [...args, '--effort', 'xhigh'], {
    env: { ...context.env, AUTOPROMPT_BENCHMARK_FORCE_EFFORT: 'low' },
  })
  assert.equal(configured.status, 0, configured.stderr)
  const payload = codexConfigure.managedCodexPayload(context.root)
  assert.equal(payload.modelSelection.effort.status, 'selectable', 'existing per-role casting schema is unchanged')
  for (const name of fs.readdirSync(context.agents).filter(name => /^ap-.*\.toml$/u.test(name))) {
    const source = fs.readFileSync(path.join(context.agents, name), 'utf8')
    assert.match(source, /^model_reasoning_effort = "xhigh"$/m, name)
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      const rendered = codexConfigure.renderAgent(Buffer.from(source), name.slice(0, -5), {
        models: ['gpt-5.6-sol'], effort,
      }).toString('utf8')
      assert.match(rendered, new RegExp(`^model_reasoning_effort = "${effort}"$`, 'm'))
    }
  }
  const activationRoot = path.join(context.sandbox, 'configured-private-activation')
  fs.mkdirSync(activationRoot)
  const copied = codexConfigure.copyActivationPayload(context.root, activationRoot, payload, {
    HOME: context.sandbox, USERPROFILE: context.sandbox,
  })
  const activation = { ...copied, activationRoot }
  for (const [providerRole, logicalRole] of [
    ['ap-worker', 'worker'], ['ap-independent-checker', 'independent-checker'],
  ]) {
    const assignment = readPrivateAgentAssignment(activation, providerRole, logicalRole)
    assert.equal(assignment.model, 'gpt-5.6-sol')
    assert.equal(assignment.effort, 'xhigh')
  }
  const pinned = snapshot(context)
  const repeated = invoke(context, [...args, '--effort', 'xhigh'])
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.match(repeated.stdout, /status=unchanged/u)
  assertSnapshot(snapshot(context), pinned)
  assert.throws(() => codexConfigure.configureCodex({
    selector: 'gpt-5.6-sol', effort: 'low', env: context.env, faultAfterRename: 3,
  }), /injected commit failure/u)
  assertSnapshot(snapshot(context), pinned)
  assert.deepEqual(temporaryConfigureArtifacts(context.root), [])
  const reset = invoke(context, args, { env: { ...context.env, AUTOPROMPT_BENCHMARK_FORCE_EFFORT: 'xhigh' } })
  assert.equal(reset.status, 0, reset.stderr)
  assertSnapshot(snapshot(context), defaults, 'omission restores role defaults, regardless of an unrelated environment variable')
  // New activations see the reset; the already receipt-bound private copy is
  // immutable and retains the configuration with which it was prepared.
  assert.equal(readPrivateAgentAssignment(activation, 'ap-worker', 'worker').effort, 'xhigh')
  fs.appendFileSync(path.join(context.agents, 'ap-worker.toml'), '\n# unreceipted change\n')
  assert.throws(() => codexConfigure.managedCodexPayload(context.root), /managed-payload-drift/u)
})

test('invalid effort and disabled casting fail before changing any managed bytes', t => {
  const context = makeInstall(t, true)
  const before = snapshot(context)
  for (const suffix of [
    ['--effort', ''], ['--effort', 'max'], ['--effort', 'XHIGH'], ['--effort', 'xhigh;true'],
    ['--effort', 'low', '--effort', 'high'],
  ]) {
    const result = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol', ...suffix])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--effort/u)
    assertSnapshot(snapshot(context), before)
  }
  for (const options of [
    { selector: 'off', effort: 'xhigh' }, { selector: 'gpt-5.6-sol', effort: 'none' },
  ]) {
    assert.throws(() => codexConfigure.configureCodex({ ...options, env: context.env }), /--effort/u)
    assertSnapshot(snapshot(context), before)
  }
  assert.deepEqual(temporaryConfigureArtifacts(context.root), [])
})

test('installed Codex cast supports explicit list, idempotence, auto, and off without touching siblings', t => {
  const context = makeInstall(t, true)
  const sibling = path.join(context.agents, 'user-owned.toml')
  const outside = path.join(context.sandbox, 'outside.txt')
  const modelMap = path.join(context.sandbox, 'models.json')
  fs.writeFileSync(sibling, 'user-owned\n')
  fs.writeFileSync(outside, 'outside\n')
  fs.writeFileSync(modelMap, `${JSON.stringify([
    { name: 'Fast', modelString: 'gpt-5.6-terra', effortHint: 'low' },
    { name: 'Strong', modelString: 'gpt-5.6-sol', effortHint: 'max' },
  ])}\n`)
  try {
    const explicit = invoke(context, [
      'configure', 'codex', '--agents', 'gpt-5.6-sol,gpt-5.6-terra',
    ])
    assert.equal(explicit.status, 0, explicit.stderr)
    assert.match(explicit.stdout, /selector=gpt-5\.6-sol,gpt-5\.6-terra/)
    assert.match(fs.readFileSync(path.join(context.agents, 'ap-manager.toml'), 'utf8'), /model = "gpt-5\.6-sol"/)
    assert.match(fs.readFileSync(path.join(context.agents, 'ap-sweeper.toml'), 'utf8'), /model = "gpt-5\.6-terra"/)
    assert.match(fs.readFileSync(path.join(context.agents, 'ap-route-analyst.toml'), 'utf8'),
      /model_reasoning_effort = "low"/)
    assert.match(fs.readFileSync(path.join(context.agents, 'ap-worker.toml'), 'utf8'),
      /model_reasoning_effort = "high"/)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'user-owned\n')
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n')

    const beforeRepeat = snapshot(context)
    const repeated = invoke(context, [
      'configure', 'codex', '--agents', 'gpt-5.6-sol,gpt-5.6-terra',
    ])
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.match(repeated.stdout, /status=unchanged/)
    assertSnapshot(snapshot(context), beforeRepeat)

    const automatic = invoke(context, [
      'configure', 'codex', '--agents', 'auto', '--model-map', modelMap, '--effort', 'medium',
    ])
    assert.equal(automatic.status, 0, automatic.stderr)
    const manifest = JSON.parse(fs.readFileSync(path.join(context.agents, '.autoprompt-casting.json')))
    assert.equal(manifest.selector, 'auto')
    assert.deepEqual(manifest.models, ['gpt-5.6-sol', 'gpt-5.6-terra'])
    for (const role of ['ap-worker', 'ap-independent-checker']) {
      assert.match(fs.readFileSync(path.join(context.agents, `${role}.toml`), 'utf8'),
        /^model_reasoning_effort = "medium"$/m)
    }
    assert.equal(run(process.execPath, [
      CASTING, '--resolve', '--agents-dir', context.agents,
      '--selector', 'auto', '--registry', modelMap,
    ], { env: context.env }).status, 0)

    const off = invoke(context, ['configure', 'codex', '--agents', 'off'])
    assert.equal(off.status, 0, off.stderr)
    assert.doesNotMatch(fs.readFileSync(path.join(context.agents, 'ap-manager.toml'), 'utf8'), /^model\s*=/m)
    assert.equal(run(process.execPath, [
      CASTING, '--resolve', '--agents-dir', context.agents, '--selector', 'off',
    ], { env: context.env }).status, 0)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'user-owned\n')
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('invalid selectors, maps, ownership collisions, and injection text fail before mutation', t => {
  const context = makeInstall(t, true)
  const marker = path.join(context.sandbox, 'must-not-exist')
  try {
    for (const args of [
      ['configure', 'codex', '--agents', 'auto'],
      ['configure', 'codex', '--agents', 'a,,b'],
      ['configure', 'codex', '--agents', 'a,b,c,d,e,f'],
      ['configure', 'codex', '--agents', `gpt-5.6-sol;touch${marker}`],
      ['configure', 'codex', '--agents', 'auto', '--model-map', 'relative.json'],
    ]) {
      const before = snapshot(context)
      const result = invoke(context, args)
      assert.notEqual(result.status, 0, args.join(' '))
      assertSnapshot(snapshot(context), before)
      assert.equal(fs.existsSync(marker), false)
    }

    const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
    const target = path.join(context.agents, 'ap-manager.toml')
    receipt.files = receipt.files.filter(file => path.resolve(file) !== path.resolve(target))
    fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
    const beforeCollision = snapshot(context)
    const collision = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol'])
    assert.notEqual(collision.status, 0)
    assert.match(collision.stderr, /receipt-owned/i)
    assertSnapshot(snapshot(context), beforeCollision)
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('transaction rolls back every file when a commit fails', t => {
  const context = makeInstall(t, true)
  const before = snapshot(context)
  try {
    const script = [
      `const configure = require(${JSON.stringify(CONFIGURE)});`,
      'try { configure.configureCodex({ selector: "gpt-5.6-sol,gpt-5.6-terra", env: process.env, faultAfterRename: 2 }); process.exit(90) }',
      'catch (error) { process.stderr.write(error.message + "\\n") }',
    ].join(' ')
    const failed = run(process.execPath, ['-e', script], { env: context.env })
    assert.equal(failed.status, 0, failed.stderr)
    assert.match(failed.stderr, /injected commit failure/)
    assertSnapshot(snapshot(context), before)
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('physical containment rejects a junctioned agents runtime before outside mutation', {
  skip: process.platform === 'win32' && !process.env.USERPROFILE,
}, t => {
  const context = makeInstall(t, true)
  const outside = path.join(context.sandbox, 'outside agents')
  const manager = path.join(outside, 'ap-manager.toml')
  try {
    fs.renameSync(context.agents, outside)
    fs.symlinkSync(outside, context.agents, process.platform === 'win32' ? 'junction' : 'dir')
    const before = fs.readFileSync(manager)
    const result = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /physical|reparse|symlink|escape/i)
    assert.deepEqual(fs.readFileSync(manager), before)
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('an originals read failure removes the stage directory without changing managed bytes', t => {
  const context = makeInstall(t, true)
  const before = snapshot(context)
  const originalRead = fs.readFileSync
  let injected = false
  try {
    fs.readFileSync = function readWithInjectedEio(file, ...args) {
      const stageExists = fs.readdirSync(context.root)
        .some(name => name.startsWith('.autoprompt-configure-'))
      if (!injected && stageExists && path.basename(String(file)) === 'ap-arbiter.toml') {
        injected = true
        const error = new Error('injected originals read EIO')
        error.code = 'EIO'
        throw error
      }
      return originalRead.call(this, file, ...args)
    }
    const configure = require(CONFIGURE)
    assert.throws(() => configure.configureCodex({
      selector: 'gpt-5.6-sol',
      env: context.env,
    }), /injected originals read EIO/)
  } finally {
    fs.readFileSync = originalRead
  }
  try {
    assert.equal(injected, true)
    assertSnapshot(snapshot(context), before)
    assert.deepEqual(temporaryConfigureArtifacts(context.root), [])
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('first rename failure removes staged siblings without changing managed bytes', t => {
  const context = makeInstall(t, true)
  const before = snapshot(context)
  try {
    const configure = require(CONFIGURE)
    assert.throws(() => configure.configureCodex({
      selector: 'gpt-5.6-sol',
      env: context.env,
      renameHook(event) {
        if (event.phase === 'commit' && event.index === 1) throw new Error('first rename denied')
      },
    }), /first rename denied/)
    assertSnapshot(snapshot(context), before)
    assert.deepEqual(temporaryConfigureArtifacts(context.root), [])
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('rollback collects an early restore error and continues restoring later files', t => {
  const context = makeInstall(t, true)
  const before = snapshot(context)
  const agentFiles = fs.readdirSync(context.agents).filter(name => /^ap-.*\.toml$/.test(name)).sort()
  try {
    const configure = require(CONFIGURE)
    assert.throws(() => configure.configureCodex({
      selector: 'gpt-5.6-sol,gpt-5.6-terra',
      env: context.env,
      faultAfterRename: 3,
      renameHook(event) {
        if (event.phase === 'rollback' && event.index === 1) throw new Error('one restore denied')
      },
    }), /rollback.*one restore denied/i)
    assert.notDeepEqual(fs.readFileSync(path.join(context.agents, agentFiles[2])), before.get(path.join(context.agents, agentFiles[2])))
    for (const name of agentFiles.slice(0, 2)) {
      const file = path.join(context.agents, name)
      assert.deepEqual(fs.readFileSync(file), before.get(file), file)
    }
    assert.deepEqual(temporaryConfigureArtifacts(context.root), [])
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('a root-scoped operation lock denies concurrent configuration and safely reclaims a dead owner', t => {
  const context = makeInstall(t, true)
  const lock = require('../../scripts/install/operation-lock.cjs')
  try {
    const lease = lock.acquire(context.root, 'test-holder')
    try {
      const blocked = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol'])
      assert.notEqual(blocked.status, 0)
      assert.match(blocked.stderr, /operation.*locked|lock.*held/i)
    } finally {
      lock.release(lease)
    }
    const stalePath = path.join(context.root, lock.LOCK_NAME)
    fs.mkdirSync(stalePath)
    fs.writeFileSync(path.join(stalePath, 'owner.json'), `${JSON.stringify({
      schemaVersion: 1,
      hostname: os.hostname(),
      pid: 2147483647,
      token: 'a'.repeat(32),
      operation: 'stale-test',
      startedAt: new Date(0).toISOString(),
    })}\n`)
    const reclaimed = lock.acquire(context.root, 'reclaim-test')
    lock.release(reclaimed)
    assert.equal(fs.existsSync(stalePath), false)
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('packaged casting recovery names supported install and configure commands', t => {
  const fixture = createFixture(t, 'autoprompt casting recovery ')
  const { sandbox } = fixture
  const agents = path.join(sandbox, 'agents')
  const registry = path.join(sandbox, 'models.json')
  fs.mkdirSync(agents)
  fs.writeFileSync(registry, '[{"name":"Strong","modelString":"gpt-5.6-sol"}]\n')
  const env = { ...process.env, HOME: sandbox }
  try {
    const off = run(process.execPath, [
      CASTING, '--resolve', '--agents-dir', agents, '--selector', 'off',
    ], { env })
    assert.equal(off.status, 2)
    assert.match(off.stderr, /autoprompt install codex/)
    assert.doesNotMatch(off.stderr, /export-agents-to-codex/)

    const automatic = run(process.execPath, [
      CASTING, '--resolve', '--agents-dir', agents, '--selector', 'auto', '--registry', registry,
    ], { env })
    assert.equal(automatic.status, 2)
    assert.match(automatic.stderr, /autoprompt configure codex --agents auto --model-map <absolute-json>/)
  } finally {
    removeFixture(fixture.binding)
  }
})

function windowsPathChecks(filesystem = fs) {
  // Exercise the real comparison/admission functions with Node's Windows path
  // implementation. This is not a claim to emulate a Windows filesystem.
  const localRequire = createRequire(CONFIGURE)
  const module = { exports: {} }
  vm.runInNewContext(`${fs.readFileSync(CONFIGURE, 'utf8')}\nmodule.exports = {
    comparable, isWithin, managedHashIdentity, receiptFileUnderRoot,
  }`, {
    Buffer,
    __dirname: path.dirname(CONFIGURE),
    __filename: CONFIGURE,
    module,
    process: { platform: 'win32' },
    require(name) {
      if (name === 'node:path') return path.win32
      if (name === 'node:fs') return filesystem
      return localRequire(name)
    },
  }, { filename: CONFIGURE })
  return module.exports
}

test('Windows drive and UNC alias admission uses one namespace without admitting device or escaping paths', () => {
  const checks = windowsPathChecks()
  const roots = ['C:\\owned\\root', '\\\\server\\share\\owned\\root']
  for (const root of roots) {
    const file = path.win32.join(root, 'payload', 'file.toml')
    for (const rootAlias of [root, path.win32.toNamespacedPath(root)]) {
      for (const fileAlias of [file, path.win32.toNamespacedPath(file)]) {
        assert.equal(checks.isWithin(rootAlias, fileAlias), true)
        assert.equal(checks.managedHashIdentity(rootAlias, fileAlias), checks.comparable(file))
      }
    }
  }
  for (const key of [
    'D:\\owned\\root\\file.toml',
    '\\\\?\\C:\\owned\\root-other\\file.toml',
    '\\\\?\\C:\\owned\\root\\..\\outside.toml',
    '\\\\?\\C:\\owned\\root\\payload\\.\\file.toml',
    '\\\\?\\C:\\owned\\root\\file.toml:stream',
    '\\\\?\\C:\\owned\\root\\payload\\\\file.toml',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\owned\\root\\file.toml',
    '\\\\.\\pipe\\owned',
    '\\??\\C:\\owned\\root\\file.toml',
    '\\\\?\\UNC\\other\\share\\owned\\root\\file.toml',
  ]) {
    assert.throws(() => checks.managedHashIdentity(roots[0], key),
      error => error.reason === 'managed-payload-hash-manifest-invalid', key)
  }
})

test('Windows receipt aliases rebind only to the same physically contained regular file', () => {
  const root = 'C:\\owned\\root'
  const file = path.win32.join(root, 'payload', 'file.toml')
  const alias = path.win32.toNamespacedPath(file)
  let aliasInode = 3n
  let parentLinked = false
  const stat = (directory, inode, linked = false) => ({
    dev: 1n, ino: inode, isDirectory: () => directory,
    isFile: () => !directory, isSymbolicLink: () => linked,
  })
  const checks = windowsPathChecks({
    lstatSync(candidate) {
      if (candidate === path.win32.dirname(file)) return stat(true, 2n, parentLinked)
      if (candidate === file) return stat(false, 3n)
      if (candidate === alias) return stat(false, aliasInode)
      throw new Error(`unexpected filesystem access: ${candidate}`)
    },
    realpathSync: { native: candidate => candidate },
  })
  assert.equal(checks.receiptFileUnderRoot(root, path.win32.toNamespacedPath(root), alias), file)
  aliasInode = 4n
  assert.throws(() => checks.receiptFileUnderRoot(root, root, alias),
    error => error.reason === 'managed-payload-receipt-root-mismatch')
  aliasInode = 3n
  parentLinked = true
  assert.throws(() => checks.receiptFileUnderRoot(root, root, alias),
    error => error.reason === 'managed-payload-escape')
})

function windowsShortPathFixture(root) {
  const native = value => path.win32.normalize(value)
    .replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, '')
  const canonical = value => native(value).replace(/RUNNER~1/gi, 'runneradmin')
  const key = value => canonical(value).replace(/\\$/, '').toLowerCase()
  const spelling = value => native(value).replace(/\\$/, '').toLowerCase()
  const entries = new Map()
  const overrides = new Map()
  const accesses = []
  const file = path.win32.join(root, 'payload', 'file.toml')
  let inode = 9007199254740992n
  for (let current = canonical(file); ; current = path.win32.dirname(current)) {
    entries.set(key(current), { directory: current !== canonical(file), dev: 2n, ino: inode++, linked: false })
    if (path.win32.dirname(current) === current) break
  }
  const filesystem = {
    lstatSync(candidate) {
      accesses.push(candidate)
      const entry = entries.get(key(candidate))
      if (!entry) throw new Error(`missing modeled path: ${candidate}`)
      const value = { ...entry, ...overrides.get(spelling(candidate)) }
      return {
        dev: value.dev, ino: value.ino,
        isDirectory: () => value.directory,
        isFile: () => !value.directory,
        isSymbolicLink: () => value.linked,
      }
    },
    realpathSync: { native(candidate) {
      accesses.push(candidate)
      if (!entries.has(key(candidate))) throw new Error(`missing modeled path: ${candidate}`)
      return canonical(candidate)
    } },
  }
  return { checks: windowsPathChecks(filesystem), root, file, canonical, spelling, overrides, accesses }
}

test('Windows receipt and hash consumers bind short, long, namespaced and MSYS drive spellings to one file', () => {
  for (const root of ['C:\\Users\\RUNNER~1\\owned', '\\\\server\\share\\RUNNER~1\\owned']) {
    const fixture = windowsShortPathFixture(root)
    const realRoot = fixture.canonical(root)
    const realFile = fixture.canonical(fixture.file)
    const variants = [fixture.file, realFile, path.win32.toNamespacedPath(realFile)]
    if (root.startsWith('C:')) variants.push(
      `/c/${realFile.slice(3).replaceAll('\\', '/')}`,
      `/c/${realFile.slice(3).replace('\\', '/')}`,
    )
    for (const declared of variants) {
      assert.equal(fixture.checks.receiptFileUnderRoot(root, realRoot, declared), fixture.file, declared)
      assert.equal(fixture.checks.managedHashIdentity(root, declared), fixture.checks.comparable(realFile), declared)
    }
    assert.equal(fixture.checks.receiptFileUnderRoot(realRoot, realRoot, fixture.file), realFile)
    assert.equal(fixture.checks.managedHashIdentity(root, 'payload/file.toml'), fixture.checks.comparable(realFile))
    if (root.startsWith('C:')) {
      assert.equal(fixture.checks.managedHashIdentity(`/c/${root.slice(3).replaceAll('\\', '/')}`, realFile),
        fixture.checks.comparable(realFile))
    }
    // Normalized identities must remain identical so the caller's existing
    // duplicate-key rejection catches mixed shell/native ownership aliases.
    assert.equal(new Set(variants.map(key => fixture.checks.managedHashIdentity(root, key))).size, 1)
  }
})

test('Windows physical alias admission rejects root/file identity changes and original ancestor junctions', () => {
  for (const root of ['C:\\Users\\RUNNER~1\\owned', '\\\\?\\UNC\\server\\share\\RUNNER~1\\owned']) {
    for (const [target, replacement] of [
      ['root', { ino: 0n }], ['root', { ino: 9007199254740993n }],
      ['root', { dev: 3n }], ['file', { ino: 9007199254740993n }],
      ['declared-parent', { linked: true }], ['root-parent', { linked: true }],
    ]) {
      const fixture = windowsShortPathFixture(root)
      const realFile = fixture.canonical(fixture.file)
      const changed = target === 'root' ? root : target === 'file' ? fixture.file
        : target === 'declared-parent' ? path.win32.dirname(realFile) : path.win32.dirname(root)
      fixture.overrides.set(fixture.spelling(changed), replacement)
      assert.throws(() => fixture.checks.receiptFileUnderRoot(root, fixture.canonical(root), realFile),
        error => /^managed-payload-(?:receipt-root-mismatch|escape)$/.test(error.reason), `${root}: ${target}`)
      assert.throws(() => fixture.checks.managedHashIdentity(root, realFile),
        error => error.reason === 'managed-payload-hash-manifest-invalid')
    }
  }
})

test('Windows receipt aliases reject unsafe raw grammar and foreign volumes before candidate filesystem access', () => {
  const root = 'C:\\Users\\RUNNER~1\\owned'
  for (const declared of [
    'C:\\Users\\runneradmin\\owned\\payload\\..\\file.toml',
    '\\\\?\\C:\\Users\\runneradmin\\owned\\payload\\.\\file.toml',
    'C:\\Users\\runneradmin\\owned\\payload\\\\file.toml',
    'C:\\Users\\runneradmin\\owned\\payload\\file.toml:stream',
    '/c/Users/runneradmin/owned/payload/../file.toml',
    '/c/Users/runneradmin/owned//payload/file.toml',
    '/c/Users/runneradmin/owned/payload/.. /file.toml',
    'C:\\Users\\runneradmin\\owned\\payload\\file.toml.',
    '\\\\?\\C:\\Users\\runneradmin\\owned\\payload\\. \\file.toml',
    'C:\\Users\\runneradmin\\owned\\payload\\NUL.toml',
    '/c/Users/runneradmin/owned/payload/COM1.txt',
    'D:\\Users\\runneradmin\\owned\\payload\\file.toml',
    '\\\\foreign-server\\share\\file.toml',
    '\\\\?\\UNC\\foreign-server\\share\\file.toml',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\file.toml',
    '\\\\.\\pipe\\file.toml', '\\??\\C:\\file.toml', 'C:payload\\file.toml',
  ]) {
    const fixture = windowsShortPathFixture(root)
    assert.throws(() => fixture.checks.receiptFileUnderRoot(root, fixture.canonical(root), declared),
      error => error.reason === 'managed-payload-receipt-root-mismatch', declared)
    assert.deepEqual(fixture.accesses, [], `no filesystem probe for ${declared}`)
  }
  for (const key of ['payload/NUL.toml', 'payload/COM1.txt', 'payload/file.toml.', 'payload/file.toml ', 'payload/.. /file.toml']) {
    const fixture = windowsShortPathFixture(root)
    assert.throws(() => fixture.checks.managedHashIdentity(root, key),
      error => error.reason === 'managed-payload-hash-manifest-invalid', key)
    assert.deepEqual(fixture.accesses, [], `no filesystem probe for relative hash key ${key}`)
  }
})

function installedHashAlias(context, key, expected) {
  // v5 manifest keys are relative to the install root, never the caller cwd.
  const file = path.resolve(context.root, key)
  const relative = path.relative(context.root, file)
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`), 'the fixture alias must stay inside the install root')
  const alias = path.toNamespacedPath(file)
  const original = fs.lstatSync(file, { bigint: true })
  const aliased = fs.lstatSync(alias, { bigint: true })
  assert.equal(original.isFile() && !original.isSymbolicLink(), true)
  assert.equal(aliased.isFile() && !aliased.isSymbolicLink(), true)
  assert.equal(aliased.dev, original.dev, 'alias device matches the installed file')
  assert.equal(aliased.ino, original.ino, 'alias inode matches the installed file')
  assert.equal(sha256(alias), expected, 'alias retains the exact installed bytes')
  return alias
}

test('duplicate physical hash aliases fail closed before configuration changes any managed bytes', t => {
  const context = makeInstall(t, true)
  const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
  const file = Object.keys(hashes)[0]
  assert.equal(path.isAbsolute(file), false, 'the fixture must exercise a v5 install-relative hash key')
  const expected = hashes[file]
  const alias = installedHashAlias(context, file, expected)
  assert.notEqual(alias, file)
  delete hashes[file]
  hashes[alias] = expected
  fs.writeFileSync(context.hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
  assert.doesNotThrow(() => codexConfigure.managedCodexPayload(context.root),
    'the absolute/namespaced key alone must be admitted before testing a duplicate')
  hashes[file] = expected
  fs.writeFileSync(context.hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
  const before = snapshot(context)
  const configured = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol'])
  assert.notEqual(configured.status, 0)
  assert.match(configured.stderr, /reason=managed-payload-hash-manifest-invalid/)
  assert.deepEqual(snapshot(context), before)
})

test('hash aliases resolved against the caller cwd cannot acquire install-root ownership', t => {
  const context = makeInstall(t, true)
  const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
  const key = Object.keys(hashes)[0]
  assert.equal(path.isAbsolute(key), false)
  const expected = hashes[key]
  delete hashes[key]
  const wrongRootAlias = path.toNamespacedPath(path.resolve(ROOT, key))
  assert.notEqual(wrongRootAlias, installedHashAlias(context, key, expected))
  hashes[wrongRootAlias] = expected
  fs.writeFileSync(context.hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
  const before = snapshot(context)
  const configured = invoke(context, ['configure', 'codex', '--agents', 'off'])
  assert.notEqual(configured.status, 0)
  assert.match(configured.stderr, /reason=managed-payload-hash-manifest-invalid/)
  assert.deepEqual(snapshot(context), before)
})

test('physical path aliases remain receipt-owned on every host (namespaced on Windows)', async t => {
  for (const variant of ['receipt', 'hashes', 'both']) {
    await t.test(variant, t => {
      const context = makeInstall(t, true)
      if (variant !== 'hashes') {
        const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
        receipt.files = receipt.files.map(file => path.toNamespacedPath(path.resolve(file)))
        fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
      }
      if (variant !== 'receipt') {
        const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
        const aliased = Object.fromEntries(Object.entries(hashes).map(([file, hash]) => [
          installedHashAlias(context, file, hash), hash,
        ]))
        fs.writeFileSync(context.hashManifest, `${JSON.stringify(aliased, null, 2)}\n`)
      }
      const before = snapshot(context)
      const configured = invoke(context, ['configure', 'codex', '--agents', 'off'])
      assert.equal(configured.status, 0, configured.stderr)
      assert.match(configured.stdout, /status=unchanged/)
      assert.deepEqual(snapshot(context), before)

      if (variant === 'both') {
        const keys = Object.keys(JSON.parse(fs.readFileSync(context.hashManifest, 'utf8')))
        const changed = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol'])
        assert.equal(changed.status, 0, changed.stderr)
        const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
        assert.deepEqual(Object.keys(hashes), keys, 'updates retain the exact admitted hash keys')
        for (const [file, expected] of Object.entries(hashes)) assert.equal(sha256(file), expected, file)
        const file = path.join(context.agents, 'ap-implementer.toml')
        fs.appendFileSync(file, '\n# untrusted drift\n')
        const drifted = snapshot(context)
        const denied = invoke(context, ['configure', 'codex', '--agents', 'off'])
        assert.notEqual(denied.status, 0)
        assert.match(denied.stderr, /managed-payload-drift/)
        assert.deepEqual(snapshot(context), drifted)
      }
    })
  }
})

for (const mode of ['timeout', 'abort', ...(process.platform === 'win32' ? [] : ['exited-parent'])]) {
  test(`packed subprocess ${mode} terminates nested writers before fixture cleanup`, { timeout: 25_000 }, async t => {
    const fixture = createFixture(t, 'autoprompt packed configure ')
    const heartbeat = path.join(fixture.sandbox, 'heartbeat')
    const nestedPid = path.join(fixture.sandbox, 'nested-pid')
    const diagnostics = []
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    t.signal.addEventListener('abort', forwardAbort, { once: true })
    const nestedProgram = `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[2], String(process.pid));
      process.stderr.write('OWNED_PHASE:nested-ready\\n');
      process.stdout.write('nested-ready\\n', () => {
        fs.writeFileSync(process.argv[1], String(Date.now()));
        setInterval(() => fs.writeFileSync(process.argv[1], String(Date.now())), 20);
      });
    `
    const parentProgram = `
      require('node:child_process').spawn(process.execPath,
        ['-e', ${JSON.stringify(nestedProgram)}, ...process.argv.slice(1)], { stdio: 'inherit' });
      ${mode === 'exited-parent' ? 'setTimeout(() => process.exit(0), 250);' : 'setInterval(() => {}, 1000);'}
    `
    const completed = runOwnedTestProcess(process.execPath, ['-e', parentProgram, heartbeat, nestedPid], {
      binding: fixture.binding, phase: `nested-${mode}`, signal: controller.signal,
      cwd: fixture.sandbox, timeout: mode === 'abort' ? 10_000 : process.platform === 'win32' ? 6_000 : 2_000,
      progressPrefix: 'OWNED_PHASE:', diagnostic: message => diagnostics.push(JSON.parse(message)),
    })
    try {
      assert.throws(() => removeFixture(fixture.binding), /owned subprocess cleanup is incomplete/)
      assert.equal(fs.existsSync(fixture.sandbox), true, 'a running tree retains its fixture')
      if (mode === 'abort') {
        const deadline = Date.now() + 5_000
        while (!fs.existsSync(heartbeat) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(fs.existsSync(heartbeat), true, 'nested writer must start before cancellation')
        controller.abort()
      }
      const result = await completed
      assert.equal(result.status, null, processFailureDetails(result))
      assert.equal(result.errorCode, mode === 'abort' ? 'ABORT_ERR' : 'ETIMEDOUT', processFailureDetails(result))
      assert.equal(result.aborted, mode === 'abort')
      assert.equal(result.timedOut, mode !== 'abort')
      assert.equal(result.cleanupConfirmed, true, processFailureDetails(result))
      assert.match(result.stdout, /nested-ready/, 'a real nested process held the output pipe')
      assert.equal(result.stderr, 'OWNED_PHASE:nested-ready\n', 'the last real phase survives timeout or abort')
      assert.deepEqual(diagnostics.filter(item => item.progress).map(item => item.progress), ['nested-ready'])
      assert.ok(Number(fs.readFileSync(nestedPid, 'utf8')) > 0)
      assert.equal(fixture.binding.pendingProcesses.size, 0)
      const stopped = fs.readFileSync(heartbeat, 'utf8')
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(fs.readFileSync(heartbeat, 'utf8'), stopped, 'no descendant writes after runner settlement')
      removeFixture(fixture.binding)
      assert.equal(fs.existsSync(fixture.sandbox), false)
    } finally {
      controller.abort()
      await completed
      t.signal.removeEventListener('abort', forwardAbort)
      removeFixture(fixture.binding)
    }
  })
}

test('packed subprocess progress is bounded across split lines and inert unless requested', async () => {
  const { EventEmitter } = require('node:events')
  const children = []
  const isolated = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'tests/helpers/owned-test-process.cjs'), 'utf8'), {
    module: isolated, performance, process: { platform: 'linux' }, setTimeout, clearTimeout,
    require: name => name === 'node:path' ? path : {
      spawn: () => {
        const child = new EventEmitter()
        child.pid = 12345
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        children.push(child)
        return child
      },
    },
  })
  const binding = { pendingProcesses: new Set() }
  const diagnostics = []
  const options = { binding, phase: 'split-markers', timeout: 5000,
    diagnostic: message => diagnostics.push(JSON.parse(message)) }
  for (const prefix of ['', 'x\ny', 'x'.repeat(129), 1]) {
    assert.throws(() => isolated.exports.runOwnedTestProcess('modeled', [], { ...options, progressPrefix: prefix }),
      /bounded nonempty line prefix/)
  }
  assert.equal(binding.pendingProcesses.size, 0, 'invalid prefix cannot acquire ownership')
  const completed = isolated.exports.runOwnedTestProcess('modeled', [], { ...options, progressPrefix: 'PHASE:' })
  const child = children[0]
  const maxLabel = 'a'.repeat(64)
  const chunks = ['noise\nPHA', 'SE:begin\r', '\n', `PHASE:${maxLabel}\r`, '\n',
    `PHASE:${'b'.repeat(65)}`, '\n', `PHASE:${'z'.repeat(100)}`, 'PHASE:false-resync\n',
    'PHASE:bad label\nPHASE:after-overlong\n',
    ...Array.from({ length: 70 }, (_, index) => `PHASE:step-${index}\n`)]
  for (const chunk of chunks) child.stderr.emit('data', Buffer.from(chunk))
  child.stdout.emit('data', Buffer.from('{"ok":true}\n'))
  assert.equal(binding.pendingProcesses.size, 1, 'progress cannot settle process ownership')
  child.emit('close', 0, null)
  const result = await completed
  assert.equal(result.stderr, chunks.join(''), 'marker parsing preserves the entire captured stderr')
  assert.equal(result.stdout, '{"ok":true}\n')
  assert.equal(result.timeoutMs, 5000)
  const progress = diagnostics.filter(item => item.progress)
  assert.deepEqual(progress.map(item => item.progress), ['begin', maxLabel, 'after-overlong',
    ...Array.from({ length: 61 }, (_, index) => `step-${index}`)])
  assert.ok(progress.every(item => Number.isInteger(item.elapsedMs) && item.elapsedMs >= 0))
  diagnostics.length = 0
  const inert = isolated.exports.runOwnedTestProcess('modeled', [], options)
  children[1].stderr.emit('data', Buffer.from('PHASE:ignored\n'))
  children[1].emit('close', 0, null)
  assert.equal((await inert).stderr, 'PHASE:ignored\n')
  assert.equal(diagnostics.some(item => item.progress), false)
  assert.equal(binding.pendingProcesses.size, 0)
})

test('packed subprocess progress streams through node test before delayed success and without retry', { timeout: 25000 }, async t => {
  const fixture = createFixture(t, 'autoprompt packed configure ')
  const acknowledgement = path.join(fixture.sandbox, 'observed-live')
  const testFile = path.join(fixture.sandbox, 'streaming.test.cjs')
  const worker = `
    const fs = require('node:fs');
    process.stderr.write('PHASE:worker-start\\n');
    const poll = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(acknowledgement)})) {
        clearInterval(poll);
        setTimeout(() => process.stdout.write('{"ok":true}\\n'), 150);
      }
    }, 10);
  `
  fs.writeFileSync(testFile, `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    const { runOwnedTestProcess } = require(${JSON.stringify(path.join(ROOT, 'tests/helpers/owned-test-process.cjs'))});
    test('delayed phase', { timeout: 15000 }, async t => {
      const binding = { pendingProcesses: new Set() };
      let warnings = 0;
      const result = await runOwnedTestProcess(process.execPath, ['-e', ${JSON.stringify(worker)}], {
        binding, phase: 'delayed-success', signal: t.signal, timeout: 10000, warnAfter: 20,
        progressPrefix: 'PHASE:', diagnostic: message => {
          const item = JSON.parse(message);
          if (item.stillRunning) warnings += 1;
          if (item.progress) process.stderr.write('LIVE_PHASE:' + item.progress + '\\n');
        }
      });
      assert.equal(result.status, 0, JSON.stringify(result));
      assert.equal(result.cleanupConfirmed, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.timeoutMs, 10000);
      assert.equal(result.stdout, '{"ok":true}\\n');
      assert.equal(warnings, 1);
      assert.equal(binding.pendingProcesses.size, 0);
    });
  `)
  let starts = 0
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  const completed = runOwnedTestProcess(process.execPath,
    ['--test', '--test-reporter=tap', '--test-reporter-destination=stderr', testFile], {
    binding: fixture.binding, phase: 'live-node-test', signal: t.signal, cwd: fixture.sandbox, env: childEnv,
    timeout: 20000,
    // The TAP reporter forwards child stderr as comments. The inner worker
    // cannot finish until this outer observer sees its live marker.
    progressPrefix: '# LIVE_PHASE:',
    diagnostic: message => {
      const item = JSON.parse(message)
      if (item.progress === 'worker-start') {
        starts += 1
        fs.writeFileSync(acknowledgement, 'observed before worker completion')
      }
    },
  })
  try {
    const result = await completed
    assert.equal(result.status, 0, processFailureDetails(result))
    assert.equal(result.cleanupConfirmed, true)
    assert.equal(starts, 1, `exactly one worker starts; warning never causes a retry: ${processFailureDetails(result)}`)
    assert.match(result.stderr, /# pass 1/)
  } finally {
    await completed
    removeFixture(fixture.binding)
  }
})

test('packed subprocess reports spawn errors, pre-abort, and bounded output without false success', async t => {
  const fixture = createFixture(t, 'autoprompt packed configure ')
  const options = { binding: fixture.binding, phase: 'spawn-failure', cwd: fixture.sandbox, timeout: 5_000 }
  const missing = await runOwnedTestProcess(path.join(fixture.sandbox, 'does-not-exist'), [], options)
  assert.equal(missing.errorCode, 'ENOENT', processFailureDetails(missing))
  assert.notEqual(missing.status, 0)
  assert.equal(missing.cleanupConfirmed, true)
  const controller = new AbortController()
  controller.abort()
  const aborted = await runOwnedTestProcess(process.execPath, ['-e', 'process.exit(0)'], {
    ...options, phase: 'pre-abort', signal: controller.signal,
  })
  assert.equal(aborted.errorCode, 'ABORT_ERR')
  assert.equal(aborted.status, null)
  const overflow = await runOwnedTestProcess(process.execPath,
    ['-e', "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"], {
      ...options, phase: 'output-overflow', maxOutputBytes: 1024,
    })
  assert.equal(overflow.errorCode, 'ENOBUFS', processFailureDetails(overflow))
  assert.equal(overflow.status, null)
  assert.equal(overflow.stdout.length, 1024)
  assert.equal(overflow.cleanupConfirmed, true)
  assert.equal(fixture.binding.pendingProcesses.size, 0)
})

test('packed subprocess cleanup failure remains terminal after late Windows tree events', async () => {
  const { EventEmitter } = require('node:events')
  const child = new EventEmitter()
  child.pid = 12345
  child.unref = () => {}
  for (const stream of ['stdout', 'stderr']) {
    child[stream] = new EventEmitter()
    child[stream].destroy = () => {}
  }
  const timers = []
  let finishKill
  const isolated = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'tests/helpers/owned-test-process.cjs'), 'utf8'), {
    module: isolated, performance,
    process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer },
    clearTimeout: timer => { if (timer) timer.cleared = true },
    require: name => name === 'node:path' ? path.win32 : {
      spawn: () => child,
      execFile: (command, args, options, callback) => {
        assert.equal(command, 'C:\\Windows\\System32\\taskkill.exe')
        assert.deepEqual(Array.from(args), ['/PID', '12345', '/T', '/F'])
        assert.equal(options.timeout, 5_000)
        finishKill = callback
      },
    },
  })
  const binding = { pendingProcesses: new Set() }
  const completed = isolated.exports.runOwnedTestProcess('fixture-only', [], {
    binding, phase: 'late-tree-events', timeout: 100,
  })
  timers.find(timer => timer.delay === 100).callback()
  timers.find(timer => timer.delay === 10_000).callback()
  const result = await completed
  assert.equal(result.cleanupError, 'OWNED_TREE_DRAIN_TIMEOUT')
  assert.equal(result.cleanupConfirmed, false)
  assert.equal(result.status, null)
  assert.equal(binding.pendingProcesses.size, 1, 'uncertain tree ownership must retain the fixture')
  finishKill(null)
  child.emit('close', 0, null)
  child.emit('error', Object.assign(new Error('late spawn event'), { code: 'LATE_ERROR' }))
  assert.equal(result.errorCode, 'ETIMEDOUT')
  assert.equal(result.status, null)
  assert.equal(result.cleanupConfirmed, false)
  assert.equal(binding.pendingProcesses.size, 1)
  // A vanished Windows parent is outside taskkill's safe ownership boundary.
  // Fail closed without targeting its now-stale PID or removing the fixture.
  timers.length = 0
  finishKill = null
  child.exitCode = 0
  const orphanBinding = { pendingProcesses: new Set() }
  const orphaned = isolated.exports.runOwnedTestProcess('fixture-only', [], {
    binding: orphanBinding, phase: 'exited-windows-parent', timeout: 100,
  })
  timers.find(timer => timer.delay === 100).callback()
  assert.equal(finishKill, null, 'taskkill must never target a known exited parent PID')
  timers.find(timer => timer.delay === 10_000).callback()
  const retained = await orphaned
  assert.equal(retained.cleanupError, 'OWNED_PARENT_EXITED_BEFORE_TREE_CLEANUP')
  assert.equal(retained.cleanupConfirmed, false)
  assert.equal(orphanBinding.pendingProcesses.size, 1)
})

// Windows phase maxima total 540s; leave a finite 60s setup/cleanup margin.
test('the packed global package exposes a working Codex configure command', { timeout: 600_000 }, async t => {
  const fixture = createFixture(t, 'autoprompt packed configure ')
  const { sandbox } = fixture
  const root = path.join(sandbox, 'codex root')
  const home = path.join(sandbox, 'home')
  const packDirectory = path.join(sandbox, 'pack')
  const prefix = path.join(sandbox, 'prefix')
  const npmCli = npmCliPath()
  assert.ok(npmCli, 'npm CLI not found')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(home)
  fs.mkdirSync(packDirectory)
  fs.mkdirSync(prefix)
  const pinned = pinnedCodexPackageFixture(path.join(sandbox, 'native-cli'), {
    env: { ...process.env, CODEX_MANAGED_PACKAGE_ROOT: path.join(sandbox, 'foreign-native-package') },
  })
  assert.equal(pinned.env.CODEX_MANAGED_PACKAGE_ROOT, pinned.runtime.packageRoot,
    'a caller-supplied managed-package pointer cannot bypass the copied native fixture')
  assert.equal(fs.realpathSync.native(path.join(pinned.env.CODEX_MANAGED_PACKAGE_ROOT, 'bin', 'codex.js')),
    fs.realpathSync.native(pinned.cliPath), 'the explicit package pointer and PATH fixture select the same entrypoint')
  const env = {
    ...pinned.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: root,
  }
  const npmEnv = nestedNpmEnvironment({
    ...env,
    npm_config_dry_run: 'true',
    NPM_CONFIG_DRY_RUN: 'true',
    npm_config_audit: 'false',
    npm_config_cache: path.join(sandbox, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  })
  const phase = (name, args, options = {}) => runOwnedTestProcess(process.execPath, args, {
    cwd: ROOT, env, timeout: 60_000, ...options,
    binding: fixture.binding, phase: name, signal: t.signal,
    diagnostic: message => t.diagnostic(message),
  })
  try {
    const packed = await phase('npm-pack', [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory], { env: npmEnv })
    assert.equal(packed.status, 0, processFailureDetails(packed))
    const tarball = path.join(packDirectory, JSON.parse(packed.stdout)[0].filename)
    const installed = await phase('npm-global-install', [
      npmCli, 'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball,
    ], { env: npmEnv })
    assert.equal(installed.status, 0, processFailureDetails(installed))
    const packageRoot = [
      path.join(prefix, 'node_modules', 'autoprompt-skill'),
      path.join(prefix, 'lib', 'node_modules', 'autoprompt-skill'),
    ].find(candidate => fs.existsSync(candidate))
    assert.ok(packageRoot, 'installed package root not found')
    assert.equal(fs.existsSync(path.join(packageRoot, 'scripts', 'codex-configure.cjs')), true)
    const cli = path.join(packageRoot, 'bin', 'autoprompt.cjs')
    // Hosted Windows whole-test durations were 97–115s before a null-status
    // install consistent with the old 120s child deadline. Keep a finite limit
    // and log crossing that old deadline; this changes no product budget.
    const lifecycle = await phase('codex-install', [cli, 'install', 'codex', '--root', root], {
      cwd: sandbox, timeout: process.platform === 'win32' ? 240_000 : 120_000, warnAfter: 120_000,
    })
    assert.equal(lifecycle.status, 0, processFailureDetails(lifecycle))
    const configured = await phase('codex-configure', [
      cli, 'configure', 'codex', '--agents', 'gpt-5.6-sol,gpt-5.6-terra', '--effort', 'xhigh', '--root', root,
    ], { env, cwd: sandbox })
    assert.equal(configured.status, 0, processFailureDetails(configured))
    assert.match(configured.stdout, /status=updated/)
    const packedPayload = require(path.join(packageRoot, 'scripts', 'codex-configure.cjs')).managedCodexPayload(root)
    for (const role of ['ap-worker', 'ap-independent-checker']) {
      assert.match(fs.readFileSync(path.join(packedPayload.skillRoot, 'agents-runtime', `${role}.toml`), 'utf8'),
        /^model_reasoning_effort = "xhigh"$/m)
    }
    const doctor = await phase('codex-doctor', [cli, 'doctor', 'codex', '--strict', '--root', root], { cwd: sandbox, timeout: 120_000 })
    if (process.platform === 'win32') {
      // Offline package contracts do not establish a native sandbox identity.
      assert.equal(doctor.status, 1, processFailureDetails(doctor))
      assert.match(doctor.stdout, /reason=codex-windows-sandbox-identity-unavailable/u)
      assert.match(doctor.stdout, /activation=unavailable/u)
      assert.equal(fs.existsSync(path.join(root, 'cap_sid')), false)
    } else {
      assert.equal(doctor.status, 0, processFailureDetails(doctor))
      assert.match(doctor.stdout, /^codex\s+yes\s+yes\s+yes\s+/m)
    }
  } finally {
    removeFixture(fixture.binding)
  }
})
