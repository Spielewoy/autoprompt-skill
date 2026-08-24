#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const childProcess = require('node:child_process')
const net = require('node:net')

const ROOT = path.resolve(__dirname, '..', '..')
const CLI = path.join(ROOT, 'bin', 'autoprompt.cjs')
const HOST_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const CODEX_RUNTIME = require('../../agents/manifests/codex-runtime.json')
const activation = require('../../scripts/codex-configure.cjs')
const localSafety = require('../../scripts/local-only-safety.cjs')
const { parseArgs } = require('../../bin/autoprompt.cjs')
const safeRunRoot = require('../../agents/codex/workflow/safe-run-root.js')
const {
  resolveCodexExecutable,
  runtimeFromPackage,
  withCodexManagedEnvironment,
} = require('../../agents/codex/workflow/codex-executable.js')

const REAL_CODEX = resolveCodexExecutable('codex')
const REAL_CODEX_COMMAND = REAL_CODEX.executable
const realCodexEnvironment = base => withCodexManagedEnvironment(base, REAL_CODEX)

function realCodexSpawnSync(command, args, options = {}) {
  if (command !== 'codex') return childProcess.spawnSync(command, args, options)
  return childProcess.spawnSync(REAL_CODEX_COMMAND, args, {
    ...options,
    env: realCodexEnvironment(options.env || process.env),
  })
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

let installedTemplate = ''
let installedTemplateSandbox = ''

function ensureInstalledTemplate() {
  if (installedTemplate) return installedTemplate
  installedTemplateSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt real codex install '))
  installedTemplate = path.join(installedTemplateSandbox, 'codex home')
  const home = path.join(installedTemplateSandbox, 'user home')
  fs.mkdirSync(installedTemplate)
  fs.mkdirSync(home)
  const install = childProcess.spawnSync(process.execPath, [
    CLI, 'install', 'codex', '--root', installedTemplate,
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
  assert.equal(install.status, 0, `${install.stdout || ''}\n${install.stderr || ''}`)
  const roles = fs.readdirSync(path.join(
    installedTemplate, '.autoprompt-private', 'bundles', CODEX_RUNTIME.payloadGeneration,
    'skills', 'autoprompt', 'agents-runtime',
  ))
    .filter(name => /^ap-[a-z0-9-]+\.toml$/.test(name))
  assert.equal(roles.length, CODEX_RUNTIME.logicalRoles.length,
    'the real installer must stage all policy-registered Codex roles')
  for (const canonical of [
    'ap-route-analyst.toml', 'ap-run-coordinator.toml', 'ap-work-group-manager.toml',
    'ap-roadmap-author.toml', 'ap-roadmap-scout.toml', 'ap-worker.toml',
    'ap-independent-checker.toml',
  ]) {
    assert.ok(roles.includes(canonical), `the real installer must stage canonical role ${canonical}`)
  }
  return installedTemplate
}

test.after(() => {
  if (installedTemplateSandbox) {
    fs.rmSync(installedTemplateSandbox, { recursive: true, force: true })
  }
})

function makeCleanInstall() {
  // Current Codex deliberately refuses to create its Windows sandbox helpers when
  // CODEX_HOME is below the operating-system temp directory. Use an isolated,
  // disposable clean home beneath the real home so this exercises the supported
  // provider boundary instead of testing Codex's temporary-directory refusal.
  const sandbox = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-activation-v2-'))
  const root = path.join(sandbox, 'ambient codex home')
  const home = path.join(sandbox, 'ambient user home')
  const target = path.join(sandbox, 'mission target')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(target, { recursive: true })
  const ambientAppData = path.join(home, 'AppData', 'Roaming')
  const ambientLocalAppData = path.join(home, 'AppData', 'Local')
  const ambientXdgConfig = path.join(home, '.config')
  const ambientGhConfig = path.join(ambientAppData, 'GitHub CLI')
  fs.mkdirSync(ambientGhConfig, { recursive: true })
  fs.mkdirSync(ambientLocalAppData, { recursive: true })
  fs.mkdirSync(ambientXdgConfig, { recursive: true })
  fs.writeFileSync(path.join(ambientGhConfig, 'hosts.yml'), 'github.com:\n  oauth_token: foreign\n')
  const initialized = childProcess.spawnSync('git', ['init', '-b', 'activation-test'], {
    cwd: target, encoding: 'utf8', shell: false,
  })
  assert.equal(initialized.status, 0, initialized.stderr)
  const configured = childProcess.spawnSync('git', ['config', '--local', 'push.default', 'nothing'], {
    cwd: target, encoding: 'utf8', shell: false,
  })
  assert.equal(configured.status, 0, configured.stderr)
  const hook = path.join(target, '.git', 'hooks', 'pre-push')
  fs.writeFileSync(hook, localSafety.MANAGED_HOOK, { mode: 0o755 })
  const template = ensureInstalledTemplate()
  fs.cpSync(template, root, { recursive: true, force: true })
  if (process.platform === 'win32') {
    const sandboxIdentity = path.join(HOST_CODEX_HOME, 'cap_sid')
    const sandboxIdentityStat = fs.lstatSync(sandboxIdentity)
    assert.equal(sandboxIdentityStat.isFile() && !sandboxIdentityStat.isSymbolicLink(), true,
      'real Windows Codex sandbox identity must be a regular host provider file')
    fs.copyFileSync(sandboxIdentity, path.join(root, 'cap_sid'))
  }
  const receiptPath = path.join(root, '.autoprompt-install-receipt.json')
  const hashesPath = path.join(root, '.autoprompt-install-hashes.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.files = receipt.files.map(file => path.join(root, path.relative(template, file)))
  receipt.createdDirectories = receipt.createdDirectories.map(
    directory => path.join(root, path.relative(template, directory)),
  )
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'))
  fs.writeFileSync(hashesPath, `${JSON.stringify(Object.fromEntries(
    Object.entries(hashes).map(([file, digest]) => [
      path.isAbsolute(file) ? path.join(root, path.relative(template, file)) : file,
      digest,
    ]),
  ), null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'auth.json'), '{"test":"credential"}\n')

  const noisySkill = path.join(target, '.agents', 'skills', 'ambient-noise', 'SKILL.md')
  fs.mkdirSync(path.dirname(noisySkill), { recursive: true })
  fs.writeFileSync(noisySkill, '---\nname: ambient-noise\ndescription: must stay dormant\n---\nnoise\n')
  const ambientSkill = path.join(root, 'skills', 'problem-finder', 'SKILL.md')
  fs.mkdirSync(path.dirname(ambientSkill), { recursive: true })
  fs.writeFileSync(ambientSkill, '---\nname: problem-finder\nsource: foreign\n---\nforeign bytes\n')
  return {
    ambientSkill,
    env: {
      ...process.env,
      APPDATA: ambientAppData,
      AUTOPROMPT_INSTALL_ROOT: root,
      CODEX_HOME: root,
      GITHUB_TOKEN: 'synthetic-token-must-not-reach-child',
      GH_ENTERPRISE_TOKEN: 'synthetic-enterprise-token-must-not-reach-child',
      HOME: home,
      LOCALAPPDATA: ambientLocalAppData,
      OPENAI_API_KEY: 'synthetic-model-transport-key',
      USERPROFILE: home,
      XDG_CONFIG_HOME: ambientXdgConfig,
    },
    home,
    noisySkill,
    root,
    sandbox,
    target,
  }
}

function runAsync(command, args, options) {
  return new Promise(resolve => {
    const child = childProcess.spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes })
    child.stderr.on('data', bytes => { stderr += bytes })
    child.on('close', (status, signal) => resolve({ signal, status, stderr, stdout }))
  })
}

const PRIVATE_DISCOVERY_INSTRUCTION = 'Explicit-only Codex work routing.'

function codexPromptInputSnapshot(options) {
  const args = []
  if (options.profile) args.push('--profile', options.profile)
  args.push('--cd', options.target, 'debug', 'prompt-input', options.prompt)
  const result = childProcess.spawnSync(REAL_CODEX_COMMAND, args, {
    cwd: options.target,
    encoding: 'utf8',
    env: realCodexEnvironment(options.env),
    shell: false,
    timeout: 15_000,
  })
  assert.equal(result.status, 0,
    `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.stack || ''}`)
  let promptInput
  assert.doesNotThrow(() => { promptInput = JSON.parse(result.stdout) })
  const strings = []
  const collectStrings = value => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(collectStrings)
    else if (value && typeof value === 'object') Object.values(value).forEach(collectStrings)
  }
  collectStrings(promptInput)
  const visible = strings.join('\n')
  return {
    activationPointerVisible: /AUTOPROMPT_(?:ACTIVATION|PROFILE|RUN_ID)|activation_id=/.test(visible),
    explicitInvocationVisible: visible.includes('$autoprompt'),
    governancePathVisible: /skills[\\/]autoprompt[\\/](?:GATES|MODES|PLAYBOOKS)\.md/i.test(visible),
    instructionLoaded: visible.includes(PRIVATE_DISCOVERY_INSTRUCTION),
    logicalRoleIds: [...new Set(visible.match(/\bap-[a-z0-9-]+\b/g) || [])].sort(),
    physicalRoleIds: [...new Set(
      visible.match(/\bautoprompt\.v2\.ap-[a-z0-9-]+(?:\.v[0-9_]+)?\b/g) || [],
    )].sort(),
    privateSkillPathVisible: /skills[\\/]autoprompt[\\/]SKILL\.md/i.test(visible),
    requestEnvelopeVisible: visible.includes('AUTOPROMPT_REQUEST_ENVELOPE_V2'),
  }
}

function privateActivationDiscoverySnapshot(activationRoot) {
  const profile = fs.readFileSync(path.join(activationRoot, 'autoprompt.config.toml'), 'utf8')
  const record = JSON.parse(fs.readFileSync(path.join(activationRoot, 'activation.json'), 'utf8'))
  const privateSkillRoot = path.join(activationRoot, 'skills')
  return {
    logicalRoleIds: Object.keys(record.roleProjection.logicalToPhysicalProviderRole).sort(),
    physicalProviderRoleIds: [...new Set(
      [...profile.matchAll(/^\[agents\."([a-z0-9-]+)"\]\s*$/gm)].map(match => match[1]),
    )].sort(),
    mappedPhysicalRoleFiles: [...new Set(
      [...profile.matchAll(/^config_file\s*=\s*"skills\/autoprompt\/agents-runtime\/([^"]+)"\s*$/gm)]
        .map(match => match[1]),
    )].sort(),
    physicalRoleFiles: fs.readdirSync(path.join(privateSkillRoot, 'autoprompt', 'agents-runtime'))
      .filter(name => name.endsWith('.toml'))
      .sort(),
    namespaceDirectories: fs.readdirSync(privateSkillRoot).sort(),
  }
}

function probeOnlySpawn(command, args, options) {
  if (command === process.execPath && args[0] === '-e' &&
      String(args[1]).includes('AUTOPROMPT_NETWORK_OPEN')) {
    return childProcess.spawnSync(command, args, options)
  }
  if (command === 'git' && args.includes('symbolic-ref')) {
    return { status: 0, stdout: 'activation-test\n', stderr: '' }
  }
  if (command === 'codex' && args.length === 1 && args[0] === '--help') {
    return { status: 0, stdout: '--profile --strict-config --cd', stderr: '' }
  }
  if (command === 'codex' && args[0] === 'exec') {
    assert.ok(args.includes('--output-schema'))
    return { status: 1, stdout: '', stderr: 'Failed to read output schema file: missing\n' }
  }
  if (command === 'codex' && args[0] === 'sandbox') {
    if (args.some(argument => String(argument).includes('AUTOPROMPT_NETWORK_DENIED'))) {
      return { status: 0, stdout: 'AUTOPROMPT_NETWORK_DENIED', stderr: '' }
    }
    return { status: 0, stdout: 'AUTOPROMPT_SANDBOX_OK', stderr: '' }
  }
  assert.fail(`unexpected activation probe: ${command} ${JSON.stringify(args)} cwd=${options?.cwd}`)
}

function allocateSupervisorRuntime(prepared, createdAt) {
  const runRecord = require(path.join(
    prepared.activationRoot, 'skills', 'autoprompt', 'workflow', 'run-record.js',
  ))
  const runtime = runRecord.createRunRecord({
    targetPath: prepared.target.realpath,
    canonicalProviderPrivateRoot: path.join(prepared.activationRoot, 'r'),
    providerId: 'codex',
    readOnly: true,
    exactTree: true,
    runId: prepared.activationId,
    now: createdAt,
    assertStartBoundary: false,
  })
  return {
    runPath: runtime.runPath,
    runId: runtime.runId,
    metadataSha256: sha256(path.join(runtime.runPath, 'metadata.json')),
    targetIdentity: runtime.targetIdentity,
    createdAt: createdAt.toISOString(),
  }
}

test('parser exposes canonical activation plus the explicit Codex compatibility alias', () => {
  const target = path.resolve('activation target')
  assert.deepEqual(parseArgs(['activate', 'codex', '--target', target, '--', 'fix', 'it']), {
    command: 'activate',
    provider: 'codex',
    missionArgs: ['fix', 'it'],
    target,
    compatibilityAlias: false,
  })
  assert.equal(parseArgs(['codex', '--', 'fix it']).compatibilityAlias, true)
  assert.throws(() => activation.prepareActivation({
    compatibilityAlias: true,
    mission: 'stale alias must not run without registered telemetry',
  }), /PROVIDER_UNSUPPORTED.*compatibility-alias-telemetry-path-unregistered/)
  const staleAlias = childProcess.spawnSync(process.execPath, [CLI, 'codex', '--', 'fix it'], {
    cwd: ROOT, encoding: 'utf8', shell: false,
  })
  assert.equal(staleAlias.status, 1)
  assert.match(staleAlias.stderr, /PROVIDER_UNSUPPORTED.*compatibility-alias-telemetry-path-unregistered/)
  assert.throws(() => parseArgs(['activate', 'codex', 'fix it']), /requires `--`/)
  assert.deepEqual(
    parseArgs(['activate', 'codex', '--', '  leading ', '', 'trailing  ']).missionArgs,
    ['  leading ', '', 'trailing  '],
  )
  assert.throws(() => parseArgs(['activate', 'codex', '--']), /at least one mission argv/i)
})

test('Windows ACL audit ignores a foreign host PSModulePath', {
  skip: process.platform !== 'win32',
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-acl-module-path-'))
  const previous = process.env.PSModulePath
  t.after(() => {
    if (previous === undefined) delete process.env.PSModulePath
    else process.env.PSModulePath = previous
    fs.rmSync(directory, { recursive: true, force: true })
  })
  process.env.PSModulePath = path.join(directory, 'not-a-windows-powershell-module-root')
  safeRunRoot.ensureWindowsPrivateAcl(directory)
  assert.deepEqual(safeRunRoot.auditPrivatePermissions(directory, { recurse: false }), {
    valid: true,
    mechanism: 'windows-dacl',
    paths: 1,
  })
})

test('Windows Codex launcher resolves to the official native executable', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(path.extname(REAL_CODEX.executable).toLowerCase(), '.exe')
  assert.equal(fs.lstatSync(REAL_CODEX.executable).isFile(), true)
  assert.equal(REAL_CODEX.environmentOverlay.CODEX_MANAGED_BY_NPM, '1')
  assert.equal(fs.existsSync(REAL_CODEX.environmentOverlay.CODEX_MANAGED_PACKAGE_ROOT), true)
  const version = childProcess.spawnSync(REAL_CODEX.executable, ['--version'], {
    encoding: 'utf8',
    env: realCodexEnvironment(process.env),
    shell: false,
    timeout: 5_000,
  })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /^codex-cli /)
  assert.equal(runtimeFromPackage(path.join(os.tmpdir(), 'autoprompt-missing-codex-package')), null)
  const normalizedEnvironment = withCodexManagedEnvironment({
    codex_managed_by_npm: 'foreign',
    CODEX_MANAGED_PACKAGE_ROOT: 'foreign',
    KEEP_ME: 'yes',
  }, REAL_CODEX)
  assert.equal(Object.hasOwn(normalizedEnvironment, 'codex_managed_by_npm'), false)
  assert.equal(normalizedEnvironment.CODEX_MANAGED_BY_NPM, '1')
  assert.equal(normalizedEnvironment.CODEX_MANAGED_PACKAGE_ROOT,
    REAL_CODEX.environmentOverlay.CODEX_MANAGED_PACKAGE_ROOT)
  assert.equal(normalizedEnvironment.KEEP_ME, 'yes')
})

test('Codex doctor prerequisites reject a missing Windows sandbox identity', {
  skip: process.platform !== 'win32',
}, t => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-doctor-prerequisite-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.copyFileSync(path.join(HOST_CODEX_HOME, 'cap_sid'), path.join(root, 'cap_sid'))
  const env = {
    ...process.env,
    AUTOPROMPT_INSTALL_ROOT: root,
    CODEX_HOME: root,
  }
  assert.deepEqual(activation.inspectActivationPrerequisites({ env }), {
    schemaVersion: 1,
    provider: 'codex',
    activationPrerequisitesReady: true,
    dynamicSandboxPreflight: 'required-at-activation',
    sandboxIdentity: 'available',
    runtimeSource: 'official-package-runtime',
  })

  fs.unlinkSync(path.join(root, 'cap_sid'))
  assert.throws(() => activation.inspectActivationPrerequisites({ env }),
    /PROVIDER_UNSUPPORTED provider=codex reason=codex-windows-sandbox-identity-unavailable/)
  let stderr = ''
  assert.equal(activation.runMaintenance(['--doctor-activation-prerequisites'], {
    env,
    stdout: { write() {} },
    stderr: { write(value) { stderr += value } },
  }), 1)
  assert.match(stderr,
    /PROVIDER_UNSUPPORTED provider=codex reason=codex-windows-sandbox-identity-unavailable/)
})

test('ordinary Codex discovery is identical before, during, and after private activation', t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const ordinaryPrompts = [
    'Build a small parser helper and add focused checks.',
    'Plan how to update one module without changing it.',
    'Review the target and report concrete defects.',
  ]
  const ordinarySnapshot = (env, prompt) => codexPromptInputSnapshot({
    env, prompt, target: context.target,
  })
  const bareRoot = path.join(context.sandbox, 'bare codex home')
  fs.mkdirSync(bareRoot)
  if (process.platform === 'win32') {
    fs.copyFileSync(path.join(HOST_CODEX_HOME, 'cap_sid'), path.join(bareRoot, 'cap_sid'))
  }
  const bareEnvironment = {
    ...context.env,
    AUTOPROMPT_INSTALL_ROOT: bareRoot,
    CODEX_HOME: bareRoot,
  }
  const emptyPrivateProjection = {
    activationPointerVisible: false,
    explicitInvocationVisible: false,
    governancePathVisible: false,
    instructionLoaded: false,
    logicalRoleIds: [],
    physicalRoleIds: [],
    privateSkillPathVisible: false,
    requestEnvelopeVisible: false,
  }

  const beforeInstall = ordinarySnapshot(bareEnvironment, ordinaryPrompts.at(-1))
  const beforeActivation = ordinaryPrompts.map(prompt => ordinarySnapshot(context.env, prompt))
  assert.deepEqual(beforeInstall, emptyPrivateProjection)
  assert.deepEqual(beforeActivation, ordinaryPrompts.map(() => emptyPrivateProjection),
    'build, plan, and review prompts must not load private instructions or roles after install')
  assert.equal(fs.existsSync(path.join(context.root, '.a')), false,
    'ordinary discovery must not create an activation')

  const prepared = activation.prepareActivation({
    env: context.env,
    missionArgs: ['private discovery boundary proof'],
    now: new Date('2026-08-21T12:00:00.000Z'),
    spawnSync: probeOnlySpawn,
    target: context.target,
  })
  const activeBeforeOrdinaryProbe = activation.inventoryIsolation({ env: context.env })
    .activeActivations
  assert.deepEqual(activeBeforeOrdinaryProbe, [prepared.activationId])

  const duringOrdinary = ordinarySnapshot(context.env, ordinaryPrompts.at(-1))
  assert.deepEqual(duringOrdinary, beforeInstall,
    'a concurrently active private root must remain absent from ordinary model input')
  assert.deepEqual(activation.inventoryIsolation({ env: context.env }).activeActivations,
    activeBeforeOrdinaryProbe, 'ordinary discovery must not consume or create activation state')

  const duringPrivate = codexPromptInputSnapshot({
    env: prepared.probeEnvironment,
    profile: 'autoprompt',
    prompt: prepared.record.supervisorEntry.prompt,
    target: context.target,
  })
  assert.equal(duringPrivate.activationPointerVisible, true)
  assert.equal(duringPrivate.explicitInvocationVisible, true)
  assert.equal(duringPrivate.requestEnvelopeVisible, true)
  assert.deepEqual(duringPrivate.logicalRoleIds, ['ap-route-analyst'])
  assert.deepEqual(duringPrivate.physicalRoleIds, [],
    'the root model input must not receive the entire private physical role namespace')
  const expectedLogicalRoles = fs.readdirSync(path.join(
    context.root, '.autoprompt-private', 'bundles', CODEX_RUNTIME.payloadGeneration,
    'skills', 'autoprompt', 'agents-runtime',
  )).filter(name => /^ap-[a-z0-9-]+\.toml$/.test(name))
    .map(name => path.basename(name, '.toml'))
    .sort()
  const duringPrivateDiscovery = privateActivationDiscoverySnapshot(prepared.activationRoot)
  assert.equal(expectedLogicalRoles.length, CODEX_RUNTIME.logicalRoles.length)
  assert.deepEqual(duringPrivateDiscovery.logicalRoleIds, expectedLogicalRoles)
  assert.equal(duringPrivateDiscovery.physicalRoleFiles.length, expectedLogicalRoles.length)
  assert.deepEqual(duringPrivateDiscovery.physicalProviderRoleIds,
    expectedLogicalRoles.map(role => prepared.record.roleProjection.logicalToPhysicalProviderRole[role]).sort())
  assert.deepEqual(duringPrivateDiscovery.mappedPhysicalRoleFiles,
    duringPrivateDiscovery.physicalRoleFiles)
  assert.ok(duringPrivateDiscovery.namespaceDirectories.includes('autoprompt'))
  assert.ok(duringPrivateDiscovery.namespaceDirectories.includes('contracts'))
  assert.deepEqual(duringPrivateDiscovery.namespaceDirectories.filter(
    name => !['.system', 'autoprompt', 'contracts'].includes(name),
  ), [], 'activation discovery contains only Codex system essentials, private contracts, and Autoprompt')
  for (const role of expectedLogicalRoles) {
    assert.ok(duringPrivateDiscovery.physicalRoleFiles.includes(
      `${prepared.record.roleProjection.logicalToPhysicalProviderRole[role]}.toml`,
    ))
  }

  const revoked = activation.revokeAllActivations({
    env: context.env,
    reason: 'ordinary-session-isolation-proof-complete',
  })
  assert.equal(revoked.revoked, 1)
  assert.deepEqual(activation.inventoryIsolation({ env: context.env }).activeActivations, [])
  assert.equal(fs.existsSync(prepared.activationRoot), true,
    'the after-state must prove a retained revoked root is still undiscoverable')
  assert.deepEqual(privateActivationDiscoverySnapshot(prepared.activationRoot),
    duringPrivateDiscovery, 'revocation retains the private evidence bytes without ambient discovery')

  const afterRevocation = ordinarySnapshot(context.env, ordinaryPrompts.at(-1))
  assert.deepEqual(afterRevocation, beforeInstall)
})

test('clean-home activation isolates skills, versions physical roles, binds one capability, and revokes it', async t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  let launchObservation
  const spawnSync = (command, args, options) => {
    if (command === process.execPath && args[0] === '-e' &&
        String(args[1]).includes('AUTOPROMPT_NETWORK_OPEN')) {
      return childProcess.spawnSync(command, args, options)
    }
    if (command === 'git' && args.includes('symbolic-ref')) {
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG']) {
        assert.equal(Object.hasOwn(options.env, key), false)
      }
      return { status: 0, stdout: 'activation-test\n', stderr: '' }
    }
    if (args.length === 1 && args[0] === '--help') {
      assert.equal(options.env.GIT_ALLOW_PROTOCOL, 'file')
      assert.equal(options.env.GIT_PROTOCOL_FROM_USER, '0')
      assert.equal(Object.hasOwn(options.env, 'GITHUB_TOKEN'), false)
      assert.equal(options.env.GH_PROMPT_DISABLED, '1')
      return { status: 0, stdout: '--profile --strict-config --cd', stderr: '' }
    }
    if (args[0] === 'exec') {
      assert.deepEqual(args.slice(0, 4), ['exec', '--strict-config', '--profile', 'autoprompt'])
      assert.ok(args.includes('--output-schema'))
      return { status: 1, stdout: '', stderr: 'Failed to read output schema file: missing\n' }
    }
    if (args[0] === 'sandbox') {
      assert.deepEqual(args.slice(0, 6), [
        'sandbox', '--permission-profile', ':workspace',
        '--sandbox-state-disable-network', '--profile', 'autoprompt',
      ])
      if (args.some(argument => String(argument).includes('AUTOPROMPT_NETWORK_DENIED'))) {
        return { status: 0, stdout: 'AUTOPROMPT_NETWORK_DENIED', stderr: '' }
      }
      return { status: 0, stdout: 'AUTOPROMPT_SANDBOX_OK', stderr: '' }
    }
    const activationRoot = options.env.CODEX_HOME
    const recordPath = options.env.AUTOPROMPT_ACTIVATION_RECORD
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    const profile = fs.readFileSync(path.join(activationRoot, 'autoprompt.config.toml'), 'utf8')
    const supervisorSh = fs.readFileSync(
      path.join(activationRoot, 'skills', 'autoprompt', 'workflow', 'supervisor.sh'), 'utf8',
    )
    const supervisorPs = fs.readFileSync(
      path.join(activationRoot, 'skills', 'autoprompt', 'workflow', 'supervisor.ps1'), 'utf8',
    )
    launchObservation = { activationRoot, args, options, record, profile }
    assert.equal(command, process.execPath)
    assert.notEqual(activationRoot, context.root)
    assert.equal(options.env.HOME, activationRoot)
    assert.equal(options.env.USERPROFILE, activationRoot)
    assert.equal(options.env.GIT_ALLOW_PROTOCOL, 'file')
    assert.equal(options.env.GIT_PROTOCOL_FROM_USER, '0')
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(Object.hasOwn(options.env, 'GITHUB_TOKEN'), false)
    assert.equal(Object.hasOwn(options.env, 'GH_ENTERPRISE_TOKEN'), false)
    assert.equal(Object.hasOwn(options.env, 'AUTOPROMPT_CAPABILITY'), false)
    assert.equal(options.env.OPENAI_API_KEY, 'synthetic-model-transport-key')
    assert.equal(options.env.GH_PROMPT_DISABLED, '1')
    assert.equal(options.env.GH_CONFIG_DIR, path.join(activationRoot, 'gh-config'))
    assert.deepEqual(fs.readdirSync(options.env.GH_CONFIG_DIR), [])
    assert.equal(options.env.APPDATA, path.join(activationRoot, 'appdata'))
    assert.equal(options.env.LOCALAPPDATA, path.join(activationRoot, 'local-appdata'))
    assert.equal(options.env.XDG_CONFIG_HOME, path.join(activationRoot, 'xdg-config'))
    assert.equal(options.env.AUTOPROMPT_SUPERVISOR_ADAPTER, path.join(
      activationRoot, 'skills', 'autoprompt', 'workflow', 'phase-budget.js',
    ))
    assert.equal(options.cwd, fs.realpathSync.native(context.target))
    const supervisorAdapter = path.join(
      activationRoot, 'skills', 'autoprompt', 'workflow', 'phase-budget.js',
    )
    assert.deepEqual(args, [
      supervisorAdapter,
      '--supervisor',
      '--adapter', supervisorAdapter,
      '--activation-record', recordPath,
      '--enforcement-proof', path.join(activationRoot, 'enforcement-proof.json'),
      '--profile-path', path.join(activationRoot, 'autoprompt.config.toml'),
      '--run-id', record.activationId,
    ])
    const structuralPrompt = activation.activationEnvelope(record)
    assert.equal(record.supervisorEntry.prompt, structuralPrompt)
    assert.equal(record.supervisorEntry.structuralInvocation, '$autoprompt')
    assert.match(structuralPrompt, /^\$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\n/)
    assert.match(structuralPrompt, /legal_child=ap-route-analyst/)
    assert.match(structuralPrompt, /request_argv_json=\["  repair ","","widget  "\]/)
    assert.match(structuralPrompt,
      /REQUEST_ARGV_BEGIN\n\{"schemaVersion":1,"argv":\["  repair ","","widget  "\]\}\nREQUEST_ARGV_END$/)
    assert.equal(record.status, 'active')
    assert.equal(record.capability.status, 'consumed')
    assert.equal(record.capability.tokenSha256, null)
    assert.equal(record.capability.singleUse, true)
    assert.equal(record.capability.generation, 1)
    assert.deepEqual(record.capability.legalChildren, ['ap-route-analyst'])
    assert.equal(record.providerCapabilities.isolation, 'strict')
    assert.equal(record.providerCapabilities.topologyEnforcement, 'prompt-guarded')
    assert.ok(['posix-mode', 'windows-dacl'].includes(
      record.activationBoundary.privatePermissions.mechanism,
    ))
    assert.ok(record.activationBoundary.privatePermissions.auditedPaths > 0)
    assert.equal(record.providerCapabilities.privateSkillRoot, true)
    assert.equal(record.providerCapabilities.eventStreaming, false)
    assert.equal(record.providerCapabilities.processOwnership, false)
    assert.deepEqual(record.contractVersions, {
      settings: '2.0.0',
      requestEnvelopeEntry: '2.0.0',
      outcome: '2.0.0',
      providerCapabilities: '2.0.0',
      activationRequest: '1.0.0',
    })
    assert.deepEqual(record.aliasTelemetry, {
      schemaVersion: '2.0.0',
      appendPath: 'compatibility/alias-telemetry.jsonl',
      registeredRunRecordPath: false,
    })
    assert.equal(record.modelSelection.mode, 'provider-default')
    assert.equal(record.modelSelection.selector, 'off')
    assert.equal(record.modelSelection.probeAcceptance.strictConfig, true)
    assert.equal(record.modelSelection.probeAcceptance.explicitModelAndEffortAssignments, false)
    assert.equal(record.providerAttestation.attestation.result, 'supported')
    assert.deepEqual(record.providerAttestation.attestation.verifiedCapabilities,
      ['isolation', 'privateSkillRoot'])
    assert.doesNotMatch(JSON.stringify(record.providerAttestation), /privateKey|BEGIN PRIVATE KEY/)
    assert.equal(activation.verifyProviderAttestation(record, {
      requireFresh: true,
      now: new Date('2026-08-21T12:00:00.000Z'),
    }), record.providerAttestation)
    assert.equal(options.env.AUTOPROMPT_ACTIVATION_ATTESTATION_SHA256,
      record.providerAttestation.attestationSha256)
    assert.ok(record.supervisorRuntime)
    assert.ok(record.supervisorRuntimeReceipt)
    assert.equal(record.supervisorRuntime.runId, record.activationId)
    assert.equal(record.supervisorRuntime.targetIdentity,
      `filesystem:${process.platform === 'win32'
        ? fs.realpathSync.native(context.target).toLowerCase()
        : fs.realpathSync.native(context.target)}`)
    assert.equal(record.supervisorRuntime.metadataSha256,
      sha256(path.join(record.supervisorRuntime.runPath, 'metadata.json')))
    assert.equal(path.relative(activationRoot, record.supervisorRuntime.runPath).startsWith('..'), false)
    assert.equal(path.relative(context.target, record.supervisorRuntime.runPath).startsWith('..'), true)
    assert.equal(options.env.AUTOPROMPT_SUPERVISOR_RUN_PATH, record.supervisorRuntime.runPath)
    assert.equal(options.env.AUTOPROMPT_SUPERVISOR_RUN_METADATA_SHA256,
      record.supervisorRuntime.metadataSha256)
    const canonicalRequest = JSON.stringify({ schemaVersion: 1, argv: ['  repair ', '', 'widget  '] })
    assert.deepEqual(record.request.argv, ['  repair ', '', 'widget  '])
    assert.equal(record.request.sha256, crypto.createHash('sha256').update(canonicalRequest).digest('hex'))
    assert.equal(record.target.realpath, fs.realpathSync.native(context.target))
    assert.equal(record.safety.mechanicallyEnforced, true)
    assert.equal(record.safety.gitNetworkDenial, 'enforced')
    assert.equal(record.safety.githubCliCredentialIsolation.enforced, true)
    assert.equal(record.safety.githubCliCredentialIsolationStatus, 'enforced')
    assert.equal(record.safety.shellNetworkDenial, 'enforced')
    assert.equal(record.safety.providerApiWriteTools, 'denied-by-strict-profile')
    if (process.platform === 'win32') {
      assert.equal(record.activationBoundary.sandboxIdentity.kind, 'windows-cap-sid-v1')
      assert.equal(record.activationBoundary.sandboxIdentity.path,
        path.join(launchObservation.activationRoot, 'cap_sid'))
      assert.equal(record.activationBoundary.sandboxIdentity.sha256,
        sha256(record.activationBoundary.sandboxIdentity.path))
      assert.match(record.activationBoundary.sandboxIdentity.sourceSha256, /^[a-f0-9]{64}$/)
    } else {
      assert.equal(record.activationBoundary.sandboxIdentity, null)
    }
    assert.match(profile, /^# Mechanically verified local-only Codex activation boundary\./)
    assert.match(profile, /^sandbox_mode = "workspace-write"$/m)
    assert.match(profile, /^web_search = "disabled"$/m)
    assert.match(profile, /^\[sandbox_workspace_write\]\nnetwork_access = false$/m)
    assert.match(profile, /^\[shell_environment_policy\]$/m)
    for (const feature of [
      'apps', 'plugins', 'remote_plugin', 'browser_use', 'in_app_browser',
      'multi_agent', 'multi_agent_v2', 'standalone_web_search', 'enable_mcp_apps',
      'skill_mcp_dependency_install', 'tool_call_mcp_elicitation', 'auth_elicitation',
    ]) {
      assert.match(profile, new RegExp(`^${feature} = false$`, 'm'))
    }
    assert.match(record.roleProjection.payloadGeneration,
      /^codex-v2\.0\.0-[a-f0-9]{16}$/)
    for (const canonical of [
      'ap-route-analyst', 'ap-run-coordinator', 'ap-work-group-manager',
      'ap-roadmap-author', 'ap-roadmap-scout', 'ap-worker', 'ap-independent-checker',
    ]) {
      const physical = record.roleProjection.logicalToPhysicalProviderRole[canonical]
      assert.equal(typeof physical, 'string')
      assert.match(profile, new RegExp(`^\\[agents\\."${physical}"\\]$`, 'm'))
      assert.doesNotMatch(profile, new RegExp(`^\\[agents\\.${canonical}\\]$`, 'm'))
    }
    const physicalRoles = fs.readdirSync(path.join(activationRoot, 'skills', 'autoprompt', 'agents-runtime'))
      .filter(name => name.endsWith('.toml'))
    assert.equal(physicalRoles.length, CODEX_RUNTIME.logicalRoles.length)
    assert.equal(physicalRoles.some(name => /^ap-.*\.toml$/.test(name)), false)
    assert.deepEqual(physicalRoles.sort(), Object.values(
      record.roleProjection.logicalToPhysicalProviderRole,
    ).map(role => `${role}.toml`).sort())
    assert.match(fs.readFileSync(path.join(
      activationRoot, 'skills', 'autoprompt', 'agents', 'openai.yaml',
    ), 'utf8'), /allow_implicit_invocation:\s*false/)
    assert.equal(fs.existsSync(path.join(activationRoot, 'skills', 'ambient-noise')), false)
    assert.equal(fs.existsSync(path.join(activationRoot, 'skills', 'problem-finder')), false)
    assert.equal(fs.readFileSync(context.ambientSkill, 'utf8'),
      '---\nname: problem-finder\nsource: foreign\n---\nforeign bytes\n')
    assert.match(fs.readFileSync(path.join(activationRoot, 'config.toml'), 'utf8'),
      new RegExp(`path = .*${path.basename(context.noisySkill).replace('.', '\\.')}.*\\nenabled = false`))
    assert.match(supervisorSh, /AUTOPROMPT_ENTRY_PROMPT="\\\$autoprompt/)
    assert.match(supervisorPs, /'\$autoprompt resume '/)
    assert.match(supervisorSh, /exec node "\$RUNTIME" --supervisor "\$@"/)
    assert.match(supervisorPs, /@\(\$runtime, '--supervisor'\)/)
    assert.equal(fs.existsSync(path.join(activationRoot, '.capability')), false)
    assert.equal(fs.existsSync(path.join(activationRoot, 'auth.json')), true)
    return { status: 0 }
  }

  const result = activation.launchActivation({
    env: context.env,
    missionArgs: ['  repair ', '', 'widget  '],
    now: new Date('2026-08-21T12:00:00.000Z'),
    spawnSync,
    target: context.target,
  })
  assert.equal(result.status, 0)
  assert.ok(launchObservation)
  const finalRecord = JSON.parse(fs.readFileSync(
    path.join(launchObservation.activationRoot, 'activation.json'), 'utf8',
  ))
  assert.equal(finalRecord.status, 'revoked')
  assert.equal(finalRecord.capability.status, 'revoked')
  assert.deepEqual(finalRecord.supervisorRuntime, launchObservation.record.supervisorRuntime)
  assert.equal(fs.existsSync(path.join(launchObservation.activationRoot, '.capability')), false)
  assert.equal(fs.existsSync(path.join(launchObservation.activationRoot, 'auth.json')), false)

  const strictConfig = childProcess.spawnSync(REAL_CODEX_COMMAND, [
    'exec', '--strict-config', '--profile', 'autoprompt', '--cd', context.target,
    '--skip-git-repo-check', '--output-schema',
    path.join(context.target, 'config-probe-must-not-exist.schema.json'),
    'CONFIG_PROBE_MUST_NOT_RUN',
  ], {
    cwd: context.target,
    encoding: 'utf8',
    env: realCodexEnvironment(launchObservation.options.env),
    shell: false,
    timeout: 15_000,
  })
  const strictOutput = `${strictConfig.stdout || ''}\n${strictConfig.stderr || ''}`
  assert.equal(strictConfig.status, 1, strictOutput)
  assert.match(strictOutput, /Failed to read output schema file/i)
  assert.doesNotMatch(strictOutput, /Error loading config|unknown configuration field/i)

  const discovery = childProcess.spawnSync(REAL_CODEX_COMMAND, [
    '--profile', 'autoprompt', '--cd', context.target,
    'debug', 'prompt-input', '$autoprompt',
  ], {
    cwd: context.target,
    encoding: 'utf8',
    env: realCodexEnvironment(launchObservation.options.env),
    shell: false,
    timeout: 15_000,
  })
  assert.equal(discovery.status, 0, discovery.stderr)
  const modelVisible = JSON.stringify(JSON.parse(discovery.stdout))
  assert.match(modelVisible, /autoprompt/i)
  assert.doesNotMatch(modelVisible, /ambient-noise/)
  assert.doesNotMatch(modelVisible, /problem-finder/)

  const sandboxEnvironment = childProcess.spawnSync(REAL_CODEX_COMMAND, [
    'sandbox',
    '--permission-profile', ':workspace',
    '--sandbox-state-disable-network',
    '--profile', 'autoprompt',
    '--cd', context.target,
    process.execPath, '-e', [
      'process.stdout.write(JSON.stringify({',
      'git:process.env.GIT_ALLOW_PROTOCOL,',
      'gh:process.env.GH_CONFIG_DIR,',
      'token:Object.hasOwn(process.env,"GITHUB_TOKEN"),',
      'modelKey:Object.hasOwn(process.env,"OPENAI_API_KEY")',
      '}))',
    ].join(''),
  ], {
    cwd: context.target,
    encoding: 'utf8',
    env: realCodexEnvironment(launchObservation.options.env),
    shell: false,
    timeout: 15_000,
  })
  assert.equal(sandboxEnvironment.status, 0,
    `${sandboxEnvironment.stderr || ''}\n${sandboxEnvironment.error?.stack || ''}`)
  const sandboxObserved = JSON.parse(sandboxEnvironment.stdout)
  assert.equal(sandboxObserved.git, 'file')
  assert.equal(sandboxObserved.gh, path.join(launchObservation.activationRoot, 'gh-config'))
  assert.equal(sandboxObserved.token, false)
  assert.equal(sandboxObserved.modelKey, false, 'model transport auth must not enter command shells')

  const copiedRuntime = require(path.join(
    launchObservation.activationRoot, 'skills', 'autoprompt', 'workflow', 'phase-budget.js',
  ))
  const proof = JSON.parse(fs.readFileSync(
    path.join(launchObservation.activationRoot, 'enforcement-proof.json'), 'utf8',
  ))
  const supervisorBoundary = copiedRuntime.safeEnvironmentFactory()(
    context.target,
    launchObservation.options.env,
    {
      configIsolationPath: path.join(launchObservation.activationRoot, 'git-empty.config'),
      enforcementProof: proof,
      expectedBranch: 'activation-test',
      ghConfigDir: path.join(launchObservation.activationRoot, 'gh-config'),
    },
  )
  assert.equal(supervisorBoundary.attestation.mechanicallyEnforced, true)
  assert.equal(supervisorBoundary.environment.GIT_ALLOW_PROTOCOL, 'file')
  assert.equal(Object.hasOwn(supervisorBoundary.environment, 'GITHUB_TOKEN'), false)
  const descendant = childProcess.spawnSync(process.execPath, ['-e', [
    'process.stdout.write(JSON.stringify({',
    'git:process.env.GIT_ALLOW_PROTOCOL,',
    'gh:process.env.GH_CONFIG_DIR,',
    'token:Object.hasOwn(process.env,"GITHUB_TOKEN")',
    '}))',
  ].join('')], {
    cwd: context.target,
    encoding: 'utf8',
    env: supervisorBoundary.environment,
    shell: false,
  })
  assert.equal(descendant.status, 0, descendant.stderr)
  assert.deepEqual(JSON.parse(descendant.stdout), {
    gh: path.join(launchObservation.activationRoot, 'gh-config'),
    git: 'file',
    token: false,
  })

  const fakeGh = path.join(context.sandbox, 'fake-gh.cjs')
  fs.writeFileSync(fakeGh, [
    "'use strict'",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    "const path = require('node:path')",
    'const candidates = [',
    "  process.env.GH_CONFIG_DIR && path.join(process.env.GH_CONFIG_DIR, 'hosts.yml'),",
    "  process.env.APPDATA && path.join(process.env.APPDATA, 'GitHub CLI', 'hosts.yml'),",
    "  process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'gh', 'hosts.yml'),",
    '].filter(Boolean)',
    "const token = Object.keys(process.env).some(key => /^(GH|GITHUB)_.*(?:TOKEN|AUTH)/i.test(key))",
    'const authenticated = token || candidates.some(file => fs.existsSync(file))',
    "if (process.argv[2] === 'auth' && process.argv[3] === 'status') process.exit(authenticated ? 0 : 1)",
    "if (process.argv[2] === 'api') {",
    "  if (!authenticated) process.exit(4)",
    "  const socket = net.connect(Number(process.env.FAKE_GH_PORT), '127.0.0.1')",
    "  socket.on('connect', () => { socket.end(); process.exit(0) })",
    "  socket.on('error', () => process.exit(5))",
    '}',
    'process.exit(2)',
    '',
  ].join('\n'))
  let connections = 0
  const server = net.createServer(socket => {
    connections += 1
    socket.destroy()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const fakeGhEnvironment = {
      ...launchObservation.options.env,
      FAKE_GH_PORT: String(server.address().port),
    }
    const sandboxNetwork = await runAsync(REAL_CODEX_COMMAND, [
      'sandbox',
      '--permission-profile', ':workspace',
      '--sandbox-state-disable-network',
      '--profile', 'autoprompt',
      '--cd', context.target,
      process.execPath, '-e', [
        "const net=require('node:net')",
        'const socket=net.connect(Number(process.argv[1]),"127.0.0.1")',
        'socket.on("connect",()=>{socket.destroy();process.exit(9)})',
        'socket.on("error",()=>process.exit(0))',
        'setTimeout(()=>process.exit(0),2000)',
      ].join(';'), String(server.address().port),
    ], {
      cwd: context.target, encoding: 'utf8', env: realCodexEnvironment(fakeGhEnvironment), shell: false,
    })
    if (sandboxNetwork.status === 9) {
      assert.ok(connections > 0, 'an open command network must have loopback evidence')
      assert.throws(() => activation.prepareActivation({
        env: context.env,
        missionArgs: ['real host network capability probe'],
        spawnSync: realCodexSpawnSync,
        target: context.target,
      }), /PROVIDER_UNSUPPORTED provider=codex reason=codex-command-sandbox-network-open/)
    } else {
      assert.equal(sandboxNetwork.status, 0,
        `${sandboxNetwork.stdout}\n${sandboxNetwork.stderr}`)
      assert.equal(connections, 0, 'Codex command sandbox must deny loopback shell connections')
    }
    const connectionsAfterSandboxProbe = connections
    const authStatus = childProcess.spawnSync(process.execPath, [fakeGh, 'auth', 'status'], {
      cwd: context.target, encoding: 'utf8', env: fakeGhEnvironment, shell: false,
    })
    assert.equal(authStatus.status, 1, `${authStatus.stdout || ''}\n${authStatus.stderr || ''}`)
    const api = await runAsync(process.execPath, [fakeGh, 'api', '/user'], {
      cwd: context.target, encoding: 'utf8', env: fakeGhEnvironment, shell: false,
    })
    assert.equal(api.status, 4, `${api.stdout}\n${api.stderr}`)
    assert.equal(connections, connectionsAfterSandboxProbe,
      'unauthenticated fake gh must fail before loopback API contact')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('real Codex dynamic preflight accepts the isolated qualified activation without a model call', {
  skip: process.env.AUTOPROMPT_REAL_CODEX_PREFLIGHT !== '1',
}, t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const prepared = activation.prepareActivation({
    env: context.env,
    missionArgs: ['real Codex dynamic preflight only'],
    target: context.target,
  })
  const projection = prepared.record.roleProjection
  assert.match(projection.payloadGeneration, /^codex-v2\.0\.0-[a-f0-9]{16}$/)
  assert.equal(Object.keys(projection.logicalToPhysicalProviderRole).length,
    CODEX_RUNTIME.logicalRoles.length)
  assert.equal(new Set(Object.values(projection.logicalToPhysicalProviderRole)).size,
    CODEX_RUNTIME.logicalRoles.length)
  for (const physical of Object.values(projection.logicalToPhysicalProviderRole)) {
    assert.match(physical, /^autoprompt-codex-v2-0-0-[a-f0-9]{16}-ap-[a-z0-9-]+$/)
  }
  assert.match(prepared.record.providerProbe.networkProbeOutputSha256, /^[a-f0-9]{64}$/)
  assert.equal(prepared.record.safety.mechanicallyEnforced, true)
  const revoked = activation.revokeAllActivations({
    env: context.env,
    reason: 'real-dynamic-preflight-complete',
  })
  assert.equal(revoked.revoked, 1)
  assert.deepEqual(activation.inventoryIsolation({ env: context.env }).activeActivations, [])
  t.diagnostic(JSON.stringify({
    modelCallCount: 0,
    payloadGeneration: projection.payloadGeneration,
    physicalProviderRoleCount: Object.keys(projection.logicalToPhysicalProviderRole).length,
    providerProbe: prepared.record.providerProbe,
    safetyMechanicallyEnforced: prepared.record.safety.mechanicallyEnforced,
  }))
})

test('receipt-bound migration quarantines only hash-known global roles and preserves foreign collisions', t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const clean = activation.inventoryIsolation({ env: context.env })
  assert.deepEqual(clean.knownLegacy, [])
  assert.deepEqual(clean.foreignCollisions, [])
  const globalAgents = path.join(context.root, 'agents')
  fs.mkdirSync(globalAgents)
  const legacy = path.join(globalAgents, 'ap-reviewer.toml')
  fs.copyFileSync(
    path.join(ROOT, 'agents', 'codex', 'agents', 'ap-reviewer.toml'),
    legacy,
  )
  const legacyOnly = activation.inventoryIsolation({ env: context.env })
  assert.deepEqual(legacyOnly.knownLegacy, [legacy])
  assert.deepEqual(legacyOnly.foreignCollisions, [])
  fs.unlinkSync(legacy)
  const foreign = path.join(globalAgents, 'ap-manager.toml')
  fs.writeFileSync(foreign, '# user-owned same-name role\n')
  const foreignOnly = activation.inventoryIsolation({ env: context.env })
  assert.deepEqual(foreignOnly.knownLegacy, [])
  assert.deepEqual(foreignOnly.foreignCollisions, [foreign])
  fs.copyFileSync(
    path.join(ROOT, 'agents', 'codex', 'agents', 'ap-reviewer.toml'),
    legacy,
  )

  const before = activation.inventoryIsolation({ env: context.env })
  assert.equal(before.knownLegacy.length, 1)
  assert.deepEqual(before.foreignCollisions, [foreign])
  const migrated = activation.quarantineKnownLegacy({ env: context.env })
  assert.equal(migrated.moved.length, 1)
  assert.equal(fs.existsSync(path.join(globalAgents, 'ap-reviewer.toml')), false)
  assert.equal(fs.readFileSync(foreign, 'utf8'), '# user-owned same-name role\n')
  const after = activation.inventoryIsolation({ env: context.env })
  assert.deepEqual(after.knownLegacy, [])
  assert.deepEqual(after.foreignCollisions, [foreign])
})

test('activation refuses a redirected private-state root before launching Codex', t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const redirected = path.join(context.sandbox, 'redirected private state')
  fs.mkdirSync(redirected)
  try {
    fs.symlinkSync(
      redirected,
      path.join(context.root, '.a'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  } catch (error) {
    t.skip(`directory links are unavailable: ${error.code || error.message}`)
    return
  }
  let launches = 0
  const spawnSync = (_command, args) => {
    if (args.length === 1 && args[0] === '--help') {
      return { status: 0, stdout: '--profile --strict-config --cd', stderr: '' }
    }
    launches += 1
    return { status: 0 }
  }
  assert.throws(() => activation.launchActivation({
    env: context.env,
    mission: 'must not escape',
    spawnSync,
    target: context.target,
  }), /PROVIDER_UNSUPPORTED provider=codex reason=private-state-directory-unsafe/)
  assert.equal(launches, 0)
  assert.deepEqual(fs.readdirSync(redirected), [])
})

test('activation emits typed provider refusal when Codex cannot establish the required profile', t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  assert.throws(() => activation.launchActivation({
    env: context.env,
    mission: 'unsupported host must not launch',
    spawnSync: () => ({ status: 0, stdout: '--profile --cd', stderr: '' }),
    target: context.target,
  }), /PROVIDER_UNSUPPORTED provider=codex reason=codex-cli-missing-strict-config/)
  assert.equal(fs.existsSync(path.join(context.root, '.a')), false)
  if (process.platform === 'win32') {
    const sandboxIdentity = path.join(context.root, 'cap_sid')
    fs.unlinkSync(sandboxIdentity)
    assert.throws(() => activation.prepareActivation({
      env: context.env,
      missionArgs: ['missing sandbox identity'],
      spawnSync: probeOnlySpawn,
      target: context.target,
    }), /PROVIDER_UNSUPPORTED provider=codex reason=codex-windows-sandbox-identity-unavailable/)
    assert.equal(fs.existsSync(path.join(context.root, '.a')), false)

    fs.writeFileSync(sandboxIdentity, '{malformed\n')
    assert.throws(() => activation.prepareActivation({
      env: context.env,
      missionArgs: ['malformed sandbox identity'],
      spawnSync: probeOnlySpawn,
      target: context.target,
    }), /PROVIDER_UNSUPPORTED provider=codex reason=codex-windows-sandbox-identity-invalid/)
    assert.equal(fs.existsSync(path.join(context.root, '.a')), false)

    fs.unlinkSync(sandboxIdentity)
    try {
      fs.symlinkSync(path.join(HOST_CODEX_HOME, 'cap_sid'), sandboxIdentity, 'file')
      assert.throws(() => activation.prepareActivation({
        env: context.env,
        missionArgs: ['linked sandbox identity'],
        spawnSync: probeOnlySpawn,
        target: context.target,
      }), /PROVIDER_UNSUPPORTED provider=codex reason=codex-windows-sandbox-identity-invalid/)
      assert.equal(fs.existsSync(path.join(context.root, '.a')), false)
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error
    }
  }
})

test('dispatcher capability consume is file-bound, context-bound, expiring, revocable, and single-use', t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const now = new Date('2026-08-21T12:00:00.000Z')
  const prepared = activation.prepareActivation({
    env: context.env,
    missionArgs: ['preserve', '', 'exact argv'],
    now,
    spawnSync: probeOnlySpawn,
    target: context.target,
    ttlSeconds: 60,
  })
  assert.equal(Object.values(prepared.probeEnvironment).includes(prepared.token), false)
  assert.equal(fs.existsSync(path.join(prepared.activationRoot, '.capability')), false)
  const capabilityContext = {
    caller: 'autoprompt-dispatcher',
    generation: prepared.record.capability.generation,
    legalChild: 'ap-route-analyst',
    parentRole: prepared.record.capability.parentRole,
    parentSession: prepared.record.capability.parentSession,
    requestSha256: prepared.record.request.sha256,
    runId: prepared.activationId,
    targetRealpath: prepared.target.realpath,
  }
  assert.throws(() => activation.consumeCapability(
    prepared.recordPath, prepared.token, { ...capabilityContext, generation: 2 }, now,
  ), /activation-capability-denied/)
  assert.throws(() => activation.consumeCapability(
    prepared.recordPath, prepared.token, { ...capabilityContext, legalChild: 'ap-worker' }, now,
  ), /activation-capability-denied/)
  assert.throws(() => activation.consumeCapability(
    prepared.recordPath, prepared.token,
    { ...capabilityContext, parentRole: 'ap-run-coordinator' }, now,
  ), /activation-capability-denied/, 'a different parent role cannot replay the root capability')
  assert.throws(() => activation.consumeCapability(
    prepared.recordPath, prepared.token,
    { ...capabilityContext, parentSession: 'foreign-parent-session' }, now,
  ), /activation-capability-denied/, 'a different parent session cannot replay the root capability')
  const consumed = activation.consumeCapability(
    prepared.recordPath, prepared.token, capabilityContext, now,
  )
  assert.equal(consumed.capability.status, 'consumed')
  assert.throws(() => activation.consumeCapability(
    prepared.recordPath, prepared.token, capabilityContext, now,
  ), /activation-capability-denied/)
  const runtimeBinding = allocateSupervisorRuntime(prepared, now)
  const registered = activation.registerSupervisorRuntime(
    prepared.recordPath, runtimeBinding, capabilityContext,
  )
  assert.deepEqual(registered.supervisorRuntime, runtimeBinding)
  assert.equal(registered.supervisorRuntimeReceipt.capabilityGeneration, 1)
  assert.deepEqual(
    activation.registerSupervisorRuntime(prepared.recordPath, runtimeBinding, capabilityContext)
      .supervisorRuntime,
    runtimeBinding,
    'exact double registration must be idempotent',
  )
  assert.throws(() => activation.registerSupervisorRuntime(
    prepared.recordPath,
    { ...runtimeBinding, createdAt: new Date(now.getTime() + 1_000).toISOString() },
    capabilityContext,
  ), /supervisor-runtime-already-bound/)
  assert.throws(() => activation.registerSupervisorRuntime(
    prepared.recordPath, runtimeBinding,
    { ...capabilityContext, targetRealpath: path.join(context.sandbox, 'foreign target') },
  ), /supervisor-runtime-capability-denied/)
  const crashWindow = JSON.parse(fs.readFileSync(prepared.recordPath, 'utf8'))
  crashWindow.supervisorRuntime = null
  crashWindow.supervisorRuntimeReceipt = null
  fs.writeFileSync(prepared.recordPath, `${JSON.stringify(crashWindow, null, 2)}\n`)
  assert.deepEqual(
    activation.registerSupervisorRuntime(prepared.recordPath, runtimeBinding, capabilityContext)
      .supervisorRuntime,
    runtimeBinding,
    'receipt-first crash recovery must restore the exact authoritative pointer',
  )

  const expiring = activation.prepareActivation({
    env: context.env,
    missionArgs: ['expires'],
    now,
    spawnSync: probeOnlySpawn,
    target: context.target,
    ttlSeconds: 60,
  })
  const expiredContext = {
    caller: 'autoprompt-dispatcher',
    generation: expiring.record.capability.generation,
    legalChild: 'ap-route-analyst',
    parentRole: expiring.record.capability.parentRole,
    parentSession: expiring.record.capability.parentSession,
    requestSha256: expiring.record.request.sha256,
    runId: expiring.activationId,
    targetRealpath: expiring.target.realpath,
  }
  assert.throws(() => activation.consumeCapability(
    expiring.recordPath,
    expiring.token,
    expiredContext,
    new Date('2026-08-21T12:01:01.000Z'),
  ), /activation-capability-denied/)
  assert.throws(() => activation.verifyProviderAttestation(expiring.record, {
    requireFresh: true,
    now: new Date('2026-08-21T12:01:01.000Z'),
  }), /provider-attestation-not-fresh/)
  activation.revokeAllActivations({ env: context.env, reason: 'test-cleanup' })
  assert.throws(() => activation.consumeCapability(
    expiring.recordPath, expiring.token, expiredContext, now,
  ), /activation-capability-denied/)
})

test('a pre-spawn failure revokes capability state and removes activation auth material', t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const missionArgs = ['pre-spawn', '', 'cleanup']
  const prepared = activation.prepareActivation({
    env: context.env,
    missionArgs,
    now: new Date('2026-08-21T12:00:00.000Z'),
    spawnSync: probeOnlySpawn,
    target: context.target,
    ttlSeconds: 60,
  })
  const privateAuth = path.join(prepared.activationRoot, 'auth.json')
  fs.writeFileSync(privateAuth, '{"stale":true}\n')
  let supervisorLaunches = 0
  const probesOnly = (command, args, options) => {
    if (command === 'git' || command === 'codex') return probeOnlySpawn(command, args, options)
    supervisorLaunches += 1
    return { status: 0 }
  }
  assert.throws(() => activation.launchActivation({
    env: context.env,
    missionArgs,
    now: new Date('2026-08-21T12:01:01.000Z'),
    resume: prepared.activationId,
    spawnSync: probesOnly,
    target: context.target,
    ttlSeconds: 60,
  }))
  assert.equal(supervisorLaunches, 0)
  assert.equal(fs.existsSync(privateAuth), false)
  const record = JSON.parse(fs.readFileSync(prepared.recordPath, 'utf8'))
  assert.equal(record.status, 'revoked')
  assert.equal(record.capability.status, 'revoked')
  assert.equal(record.capability.tokenSha256, null)
})

test('resume reuses one immutable supervisor run and rejects request, target, and metadata drift', t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const launches = []
  const spawnSync = (command, args, options) => {
    if (command === 'git' || command === 'codex') return probeOnlySpawn(command, args, options)
    const record = JSON.parse(fs.readFileSync(options.env.AUTOPROMPT_ACTIVATION_RECORD, 'utf8'))
    launches.push(record)
    return { status: 0 }
  }
  const missionArgs = ['same', '', 'request']
  const first = activation.launchActivation({
    env: context.env,
    missionArgs,
    now: new Date('2026-08-21T12:00:00.000Z'),
    spawnSync,
    target: context.target,
  })
  const firstBinding = launches[0].supervisorRuntime
  const second = activation.launchActivation({
    env: context.env,
    missionArgs,
    now: new Date('2026-08-21T12:01:00.000Z'),
    resume: first.activationId,
    spawnSync,
    target: context.target,
  })
  assert.equal(second.status, 0)
  assert.equal(launches.length, 2)
  assert.deepEqual(launches[1].supervisorRuntime, firstBinding)
  assert.equal(launches[1].capability.generation, 2)
  assert.equal(launches[1].supervisorRuntimeReceipt.capabilityGeneration, 1)
  assert.throws(() => activation.prepareActivation({
    env: context.env,
    missionArgs: ['different request'],
    now: new Date('2026-08-21T12:02:00.000Z'),
    resume: first.activationId,
    spawnSync: probeOnlySpawn,
    target: context.target,
  }), /authoritative activation request/)
  const otherTarget = path.join(context.sandbox, 'other target')
  fs.mkdirSync(otherTarget)
  assert.throws(() => activation.prepareActivation({
    env: context.env,
    missionArgs,
    now: new Date('2026-08-21T12:02:00.000Z'),
    resume: first.activationId,
    spawnSync: probeOnlySpawn,
    target: otherTarget,
  }), /resume target does not match/)
  const activationPath = path.join(first.activationRoot, 'activation.json')
  const untamperedActivation = fs.readFileSync(activationPath)
  const attestationTamper = JSON.parse(untamperedActivation.toString('utf8'))
  const signature = attestationTamper.providerAttestation.attestation.signature.value
  attestationTamper.providerAttestation.attestation.signature.value =
    `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
  fs.writeFileSync(activationPath, `${JSON.stringify(attestationTamper, null, 2)}\n`)
  assert.equal(activation.inventoryIsolation({ env: context.env }).malformedActivations
    .some(item => item.activationId === first.activationId && /attestation/i.test(item.error)), true)
  fs.writeFileSync(activationPath, untamperedActivation)
  const metadataPath = path.join(firstBinding.runPath, 'metadata.json')
  fs.appendFileSync(metadataPath, ' ')
  const report = activation.inventoryIsolation({ env: context.env })
  assert.equal(report.malformedActivations.some(item => item.activationId === first.activationId), true)
})

test('concurrent exact supervisor-runtime registration has one authoritative result', async t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const now = new Date('2026-08-21T12:00:00.000Z')
  const prepared = activation.prepareActivation({
    env: context.env,
    missionArgs: ['concurrent binding'],
    now,
    spawnSync: probeOnlySpawn,
    target: context.target,
  })
  const capabilityContext = {
    caller: 'autoprompt-dispatcher',
    generation: prepared.record.capability.generation,
    legalChild: 'ap-route-analyst',
    parentRole: prepared.record.capability.parentRole,
    parentSession: prepared.record.capability.parentSession,
    requestSha256: prepared.record.request.sha256,
    runId: prepared.activationId,
    targetRealpath: prepared.target.realpath,
  }
  activation.consumeCapability(
    prepared.recordPath, prepared.token, capabilityContext, now,
  )
  const runtimeBinding = allocateSupervisorRuntime(prepared, now)
  const childScript = [
    "const activation=require(process.argv[1])",
    "const binding=JSON.parse(Buffer.from(process.argv[3],'base64url'))",
    "const context=JSON.parse(Buffer.from(process.argv[4],'base64url'))",
    "try{activation.registerSupervisorRuntime(process.argv[2],binding,context);process.stdout.write('ok')}catch(e){process.stderr.write(String(e.message));process.exit(1)}",
  ].join(';')
  const args = [
    '-e', childScript,
    path.join(ROOT, 'scripts', 'codex-configure.cjs'),
    prepared.recordPath,
    Buffer.from(JSON.stringify(runtimeBinding)).toString('base64url'),
    Buffer.from(JSON.stringify(capabilityContext)).toString('base64url'),
  ]
  const results = await Promise.all([
    runAsync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: context.env }),
    runAsync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: context.env }),
  ])
  assert.equal(results.some(result => result.status === 0), true, JSON.stringify(results))
  for (const result of results.filter(item => item.status !== 0)) {
    assert.match(result.stderr, /operation lock is held/)
  }
  const saved = JSON.parse(fs.readFileSync(prepared.recordPath, 'utf8'))
  assert.deepEqual(saved.supervisorRuntime, runtimeBinding)
  assert.equal(saved.supervisorRuntimeReceipt.sha256,
    sha256(path.join(prepared.activationRoot, 'supervisor-runtime-binding.json')))
})

test('malformed activation records fail doctor, residue, and revoke maintenance closed', t => {
  const context = makeCleanInstall()
  t.after(() => fs.rmSync(context.sandbox, { recursive: true, force: true }))
  const prepared = activation.prepareActivation({
    env: context.env,
    mission: 'malformed-record audit',
    spawnSync: probeOnlySpawn,
    target: context.target,
  })
  fs.writeFileSync(prepared.recordPath, '{malformed\n')
  const report = activation.inventoryIsolation({ env: context.env })
  assert.equal(report.malformedActivations.length, 1)
  assert.equal(report.isolationReady, false)
  const outputs = () => {
    let stdout = ''
    let stderr = ''
    return {
      streams: {
        stdout: { write(value) { stdout += value } },
        stderr: { write(value) { stderr += value } },
      },
      values: () => ({ stderr, stdout }),
    }
  }
  const doctor = outputs()
  assert.equal(activation.runMaintenance(['--doctor-isolation'], {
    env: context.env, ...doctor.streams,
  }), 1)
  assert.match(doctor.values().stdout, /malformedActivations/)
  const residue = outputs()
  assert.equal(activation.runMaintenance(['--has-known-residue'], {
    env: context.env, ...residue.streams,
  }), 3)
  const residueReport = JSON.parse(residue.values().stdout)
  assert.deepEqual(Object.keys(residueReport), [
    'managedResidue', 'knownLegacy', 'knownLegacySkill', 'unresolvedCollisions',
    'activeActivations', 'malformedActivations',
  ])
  assert.equal(residueReport.managedResidue.payloadState, 'verified')
  assert.deepEqual(residueReport.unresolvedCollisions, [])
  assert.equal(residueReport.malformedActivations.length, 1)
  const revoke = outputs()
  assert.equal(activation.runMaintenance(['--revoke-all'], {
    env: context.env, ...revoke.streams,
  }), 1)
  assert.match(revoke.values().stderr, /malformed activation records/i)
  const doctorCli = childProcess.spawnSync(process.execPath, [
    CLI, 'doctor', 'isolation', '--root', context.root,
  ], {
    cwd: ROOT, encoding: 'utf8', env: context.env, shell: false,
  })
  assert.equal(doctorCli.status, 1, `${doctorCli.stdout}\n${doctorCli.stderr}`)
  assert.match(`${doctorCli.stdout}\n${doctorCli.stderr}`, /malformedActivations/)
  const uninstallCli = childProcess.spawnSync(process.execPath, [
    CLI, 'uninstall', 'codex', '--root', context.root,
  ], {
    cwd: ROOT, encoding: 'utf8', env: context.env, shell: false,
  })
  assert.equal(uninstallCli.status, 1, `${uninstallCli.stdout}\n${uninstallCli.stderr}`)
  assert.equal(fs.existsSync(path.join(context.root, '.autoprompt-install-receipt.json')), true)
  for (const relative of ['scripts/install/uninstall.sh', 'scripts/install/uninstall.ps1']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /categories=managed,known-legacy,unresolved-collision/, relative)
    assert.match(source, /--has-known-residue/, relative)
  }
})
