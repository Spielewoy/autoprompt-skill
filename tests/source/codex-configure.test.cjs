#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const CLI = path.join(ROOT, 'bin', 'autoprompt.cjs')
const CONFIGURE = path.join(ROOT, 'scripts', 'codex-configure.cjs')
const CASTING = path.join(ROOT, 'agents', 'codex', 'workflow', 'codex-agent-casting.js')
const PROFILE = path.join(ROOT, 'agents', 'codex', 'workflow', 'codex-agent-profile.js')
const { HELP_TEXT, parseArgs } = require('../../bin/autoprompt.cjs')
const codexConfigure = require('../../scripts/codex-configure.cjs')
const { renderManifests } = require('../../scripts/runtime-payload.cjs')
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
  }
  createdFixtures.add(binding)
  t.after(() => removeFixture(binding))
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

function makeActivationCopyContext(t, branch) {
  const context = makeInstall(t)
  const completed = completeManagedV5Payload(context)
  const target = path.join(context.sandbox, `${branch}-target`)
  fs.mkdirSync(target)
  assert.equal(run('git', ['init', '-b', branch], { cwd: target }).status, 0)
  assert.equal(run('git', ['config', '--local', 'push.default', 'nothing'], { cwd: target }).status, 0)
  fs.writeFileSync(
    path.join(target, '.git', 'hooks', 'pre-push'),
    require('../../scripts/local-only-safety.cjs').MANAGED_HOOK,
    { mode: 0o755 },
  )
  if (process.platform === 'win32') {
    const hostCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    fs.copyFileSync(path.join(hostCodexHome, 'cap_sid'), path.join(context.root, 'cap_sid'))
  }
  return {
    ...context,
    completed,
    env: { ...context.env, CODEX_HOME: context.root },
    target,
  }
}

function assertNoActivationCopyResidue(context) {
  assert.equal(fs.existsSync(path.join(context.root, '.a')), false)
  assert.deepEqual(
    fs.readdirSync(context.root, { recursive: true }).filter(file =>
      /activation-payload\.json$|activation\.json$|autoprompt\.config\.toml\.tmp|\.tmp-/u.test(file)),
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

test('managed Codex activation rejects a source mutation after validation before copy without residue', {
  skip: process.platform !== 'win32',
}, t => {
  const context = makeInstall(t)
  const completed = completeManagedV5Payload(context)
  const target = path.join(context.sandbox, 'mutation-target')
  fs.mkdirSync(target)
  assert.equal(run('git', ['init', '-b', 'source-mutation'], { cwd: target }).status, 0)
  assert.equal(run('git', ['config', '--local', 'push.default', 'nothing'], { cwd: target }).status, 0)
  fs.writeFileSync(
    path.join(target, '.git', 'hooks', 'pre-push'),
    require('../../scripts/local-only-safety.cjs').MANAGED_HOOK,
    { mode: 0o755 },
  )
  const hostCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  fs.copyFileSync(path.join(hostCodexHome, 'cap_sid'), path.join(context.root, 'cap_sid'))
  const expected = sha256(completed.phaseBudgetPath)
  let mutationProbeCalls = 0
  let providerCallsAfterMutation = 0
  const mutationProbe = (command, args) => {
    if (command === 'codex' && args.length === 1 && args[0] === '--help') {
      mutationProbeCalls += 1
      fs.appendFileSync(completed.phaseBudgetPath, '\npost-validation hostile mutation\n')
      return { status: 0, stdout: '--profile --strict-config --cd', stderr: '' }
    }
    providerCallsAfterMutation += 1
    throw new Error(`provider reached after source mutation: ${command} ${JSON.stringify(args)}`)
  }
  let captured = null
  try {
    codexConfigure.prepareActivation({
      env: { ...context.env, CODEX_HOME: context.root },
      missionArgs: ['source mutation must fail closed'],
      spawnSync: mutationProbe,
      target,
      ttlSeconds: 60,
    })
  } catch (error) {
    captured = error
  }
  assert.ok(captured, 'post-validation source mutation must abort activation preparation')
  assert.equal(captured instanceof codexConfigure.ProviderUnsupportedError, true)
  assert.equal([
    'managed-payload-source-changed', 'managed-payload-drift',
  ].includes(captured.reason), true)
  assert.equal(mutationProbeCalls, 1, 'the deterministic mutation seam must execute exactly once')
  assert.equal(providerCallsAfterMutation, 0, 'no provider/probe may run after mutation detection')
  assert.notEqual(sha256(completed.phaseBudgetPath), expected)
  assert.equal(fs.existsSync(path.join(context.root, '.a')), false,
    'the entire activation tree, payload manifest, pointer, and profile must roll back')
  assert.deepEqual(
    fs.readdirSync(context.root, { recursive: true }).filter(file =>
      /activation-payload\.json$|activation\.json$|autoprompt\.config\.toml\.tmp|\.tmp-/u.test(file)),
    [],
    'activation failure must leave zero temporary or pointer residue',
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

test('managed Codex copy rejects captured source file and junction swaps before publication', {
  skip: process.platform !== 'win32',
}, t => {
  for (const kind of ['file-swap', 'junction-swap']) {
    const context = makeActivationCopyContext(t, kind)
    if (kind === 'junction-swap') {
      const probeOutside = path.join(context.sandbox, 'junction-capability-target')
      const probeLink = path.join(context.sandbox, 'junction-capability-link')
      fs.mkdirSync(probeOutside)
      try {
        fs.symlinkSync(probeOutside, probeLink, 'junction')
        assert.equal(fs.realpathSync.native(probeLink), fs.realpathSync.native(probeOutside))
        fs.unlinkSync(probeLink)
      } catch (error) {
        if (['EPERM', 'ENOTSUP', 'EINVAL'].includes(error?.code)) {
          t.diagnostic(`junction swap unsupported by host: ${error.code}`)
          continue
        }
        throw error
      }
    }
    let mutationCalls = 0
    let providerCalls = 0
    const probe = (command, args) => {
      if (command === 'codex' && args.length === 1 && args[0] === '--help') {
        mutationCalls += 1
        if (kind === 'file-swap') {
          const captured = `${context.completed.phaseBudgetPath}.captured`
          fs.renameSync(context.completed.phaseBudgetPath, captured)
          fs.writeFileSync(context.completed.phaseBudgetPath, 'hostile replacement\n')
        } else {
          const workflow = path.dirname(context.completed.phaseBudgetPath)
          const outside = path.join(context.sandbox, 'hostile-workflow')
          fs.cpSync(workflow, outside, { recursive: true })
          fs.rmSync(workflow, { recursive: true, force: true })
          fs.symlinkSync(outside, workflow, 'junction')
        }
        return { status: 0, stdout: '--profile --strict-config --cd', stderr: '' }
      }
      providerCalls += 1
      throw new Error(`provider reached after ${kind}`)
    }
    let captured = null
    try {
      codexConfigure.prepareActivation({
        env: context.env, missionArgs: [`reject ${kind}`], spawnSync: probe,
        target: context.target, ttlSeconds: 60,
      })
    } catch (error) { captured = error }
    assert.equal(captured instanceof codexConfigure.ProviderUnsupportedError, true, kind)
    assert.equal([
      'managed-payload-source-changed', 'managed-payload-drift', 'managed-payload-escape',
    ].includes(captured.reason), true, kind)
    assert.equal(mutationCalls, 1, kind)
    assert.equal(providerCalls, 0, kind)
    assertNoActivationCopyResidue(context)
  }
})

test('managed Codex copy rejects a destination-parent swap before verified temp publication', {
  skip: process.platform !== 'win32',
}, t => {
  const context = makeActivationCopyContext(t, 'destination-parent-swap')
  let helpCalls = 0
  let providerCalls = 0
  const probe = (command, args) => {
    if (command === 'codex' && args.length === 1 && args[0] === '--help') {
      helpCalls += 1
      return { status: 0, stdout: '--profile --strict-config --cd', stderr: '' }
    }
    providerCalls += 1
    throw new Error(`provider reached after destination-parent swap: ${command}`)
  }
  const originalRename = fs.renameSync
  let swapEvents = 0
  fs.renameSync = function renameWithParentSwap(source, destination) {
    if (swapEvents === 0 && /skills[\\/]autoprompt[\\/]workflow[\\/]phase-budget\.js$/u.test(destination) &&
        /\.tmp-/u.test(source)) {
      swapEvents += 1
      const parent = path.dirname(destination)
      const displaced = `${parent}.captured`
      const hostile = path.join(context.sandbox, 'hostile-destination-parent')
      originalRename.call(this, parent, displaced)
      fs.mkdirSync(hostile)
      fs.symlinkSync(hostile, parent, 'junction')
    }
    return originalRename.call(this, source, destination)
  }
  let captured = null
  try {
    codexConfigure.prepareActivation({
      env: context.env, missionArgs: ['reject destination publication swap'],
      spawnSync: probe, target: context.target, ttlSeconds: 60,
    })
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
  assert.equal(helpCalls, 1)
  assert.equal(providerCalls, 0)
  assert.equal(swapEvents, 1)
  assertNoActivationCopyResidue(context)
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
  for (const args of [
    ['configure'],
    ['configure', 'claude', '--agents', 'off'],
    ['configure', 'codex'],
    ['configure', 'codex', '--agents'],
    ['configure', 'codex', '--agents', 'off', '--agents', 'auto'],
    ['configure', 'codex', '--agents', 'off', '--root', 'relative'],
    ['configure', 'codex', '--unknown', 'value'],
  ]) {
    assert.throws(() => parseArgs(args), error => error?.code === 'AUTOPROMPT_USAGE', args.join(' '))
  }
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
      'configure', 'codex', '--agents', 'auto', '--model-map', modelMap,
    ])
    assert.equal(automatic.status, 0, automatic.stderr)
    const manifest = JSON.parse(fs.readFileSync(path.join(context.agents, '.autoprompt-casting.json')))
    assert.equal(manifest.selector, 'auto')
    assert.deepEqual(manifest.models, ['gpt-5.6-sol', 'gpt-5.6-terra'])
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

test('Windows physical path aliases remain receipt-owned', {
  skip: process.platform !== 'win32',
}, t => {
  const context = makeInstall(t, true)
  const extended = file => `\\\\?\\${path.resolve(file)}`
  try {
    const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
    receipt.files = receipt.files.map(extended)
    fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)

    const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
    const aliased = Object.fromEntries(Object.entries(hashes).map(([file, hash]) => [extended(file), hash]))
    fs.writeFileSync(context.hashManifest, `${JSON.stringify(aliased, null, 2)}\n`)

    const configured = invoke(context, ['configure', 'codex', '--agents', 'off'])
    assert.equal(configured.status, 0, configured.stderr)
    assert.match(configured.stdout, /status=unchanged/)
  } finally {
    removeFixture(context.fixture.binding)
  }
})

test('the packed global package exposes a working Codex configure command', { timeout: 120_000 }, t => {
  const fixture = createFixture(t, 'autoprompt packed configure ')
  const { sandbox } = fixture
  const root = path.join(sandbox, 'codex root')
  const home = path.join(sandbox, 'home')
  const fakeBin = path.join(sandbox, 'bin')
  const packDirectory = path.join(sandbox, 'pack')
  const prefix = path.join(sandbox, 'prefix')
  const npmCli = npmCliPath()
  assert.ok(npmCli, 'npm CLI not found')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(home)
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(packDirectory)
  fs.mkdirSync(prefix)
  fs.writeFileSync(path.join(fakeBin, 'codex.cmd'), '@echo off\r\necho codex-cli 0.101.0\r\n')
  const fakePosix = path.join(fakeBin, 'codex')
  fs.writeFileSync(fakePosix, '#!/bin/sh\nprintf "%s\\n" "codex-cli 0.101.0"\n')
  fs.chmodSync(fakePosix, 0o755)
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
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
  try {
    const packed = run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory], { env: npmEnv })
    assert.equal(packed.status, 0, packed.stderr)
    const tarball = path.join(packDirectory, JSON.parse(packed.stdout)[0].filename)
    const installed = run(process.execPath, [
      npmCli, 'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball,
    ], { env: npmEnv })
    assert.equal(installed.status, 0, installed.stderr)
    const packageRoot = [
      path.join(prefix, 'node_modules', 'autoprompt-skill'),
      path.join(prefix, 'lib', 'node_modules', 'autoprompt-skill'),
    ].find(candidate => fs.existsSync(candidate))
    assert.ok(packageRoot, 'installed package root not found')
    assert.equal(fs.existsSync(path.join(packageRoot, 'scripts', 'codex-configure.cjs')), true)
    const cli = path.join(packageRoot, 'bin', 'autoprompt.cjs')
    const lifecycle = run(process.execPath, [cli, 'install', 'codex', '--root', root], { env, cwd: sandbox, timeout: 120_000 })
    assert.equal(lifecycle.status, 0, `${lifecycle.stdout}\n${lifecycle.stderr}`)
    const configured = run(process.execPath, [
      cli, 'configure', 'codex', '--agents', 'gpt-5.6-sol,gpt-5.6-terra', '--root', root,
    ], { env, cwd: sandbox })
    assert.equal(configured.status, 0, configured.stderr)
    assert.match(configured.stdout, /status=updated/)
    const doctor = run(process.execPath, [cli, 'doctor', 'codex', '--strict', '--root', root], { env, cwd: sandbox, timeout: 120_000 })
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`)
    assert.match(doctor.stdout, /^codex\s+yes\s+yes\s+yes\s+/m)
  } finally {
    removeFixture(fixture.binding)
  }
})
