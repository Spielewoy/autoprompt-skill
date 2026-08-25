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
const HOST_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const activation = require('../../scripts/codex-configure.cjs')
const cli = require('../../bin/autoprompt.cjs')
const localSafety = require('../../scripts/local-only-safety.cjs')
const codexRuntimeManifest = require('../../agents/manifests/codex-runtime.json')
const {
  resolveCodexExecutable,
  withCodexManagedEnvironment,
} = require('../../agents/codex/workflow/codex-executable.js')
const TEST_CODEX = resolveCodexExecutable('codex')

const CASE_TIMEOUT_MS = 60_000
// A clean Windows Codex payload install has a measured 409s lifecycle on the
// release runner. Keep both the child and its outer hook bounded, with a small
// cleanup margin between them, so slow-but-completing setup is not classified
// as a hang and a genuine hang still terminates deterministically.
const TEMPLATE_INSTALL_TIMEOUT_MS = 480_000
const SUITE_SETUP_TIMEOUT_MS = 510_000
const FIXED_NOW = new Date('2026-08-23T12:00:00.000Z')
const DOCTOR_FIXTURE_ONLY = process.env.AUTOPROMPT_ISO019_DOCTOR_FIXTURE_ONLY === '1'
const EXPECTED_CANONICAL_TRUST_REFUSAL = Object.freeze([
  'canonical-live-evidence-invalid',
  'external-attestation-missing',
  'external-attestation-verification-method-invalid',
  'supported-capability-unattested-isolation',
  'supported-capability-unattested-privateSkillRoot',
  'supported-capability-unattested-processOwnership',
])
const CODEX_LOGICAL_ROLES = new Set(codexRuntimeManifest.logicalRoles)
const trackedPids = new Set()
let installedTemplate = null
let installedTemplateSandbox = null
let installedTemplateError = null

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killBoundedProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return
  try {
    if (process.platform === 'win32') {
      childProcess.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8', shell: false, timeout: 5_000, windowsHide: true,
      })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {}
}

function boundedSpawn(command, args, options = {}) {
  const timeout = options.timeout || 20_000
  const result = childProcess.spawnSync(command, args, {
    ...options,
    shell: false,
    timeout,
    windowsHide: true,
  })
  if (Number.isSafeInteger(result.pid)) trackedPids.add(result.pid)
  if (result.error?.code === 'ETIMEDOUT') {
    killBoundedProcessTree(result.pid)
    trackedPids.delete(result.pid)
    assert.fail(`bounded child timed out after ${timeout}ms: ${command} ${args.join(' ')}`)
  }
  if (Number.isSafeInteger(result.pid) && pidAlive(result.pid)) {
    killBoundedProcessTree(result.pid)
    trackedPids.delete(result.pid)
    assert.fail(`bounded child left a live pid after exit: pid=${result.pid} command=${command}`)
  }
  trackedPids.delete(result.pid)
  return result
}

function captureStreams() {
  let stdout = ''
  let stderr = ''
  return {
    stdout: { write(value) { stdout += String(value) } },
    stderr: { write(value) { stderr += String(value) } },
    values: () => ({ stderr, stdout }),
  }
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : fs.readFileSync(value)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function installTemplate() {
  if (installedTemplateError) throw installedTemplateError
  if (installedTemplate) return installedTemplate
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-r10-template-'))
  const root = path.join(sandbox, 'codex-home')
  const home = path.join(sandbox, 'user-home')
  fs.mkdirSync(root)
  fs.mkdirSync(home)
  const streams = captureStreams()
  let status
  try {
    status = cli.run(['install', 'codex', '--root', root], {
      cwd: ROOT,
      env: { ...process.env, CODEX_HOME: root, HOME: home, USERPROFILE: home },
      interactive: false,
      spawnSync: (command, args, options) => boundedSpawn(command, args, {
        ...options,
        timeout: TEMPLATE_INSTALL_TIMEOUT_MS,
      }),
      stderr: streams.stderr,
      stdout: streams.stdout,
    })
    assert.equal(status, 0, `${streams.values().stdout}\n${streams.values().stderr}`)
    assert.equal(fs.existsSync(path.join(root, 'agents')), false,
      'a clean Codex install must not publish provider-global roles')
    installedTemplate = root
    installedTemplateSandbox = sandbox
    return installedTemplate
  } catch (error) {
    fs.rmSync(sandbox, { recursive: true, force: true })
    installedTemplateError = error
    throw error
  }
}

function relocateReceipt(template, root) {
  const receiptPath = path.join(root, '.autoprompt-install-receipt.json')
  const hashesPath = path.join(root, '.autoprompt-install-hashes.json')
  const relocate = value => {
    if (!path.isAbsolute(value)) return value
    const relative = path.relative(template, value)
    assert.equal(path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`), false,
      `template receipt path escaped its root: ${value}`)
    return path.join(root, relative)
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.files = receipt.files.map(relocate)
  receipt.createdDirectories = (receipt.createdDirectories || []).map(relocate)
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'))
  fs.writeFileSync(hashesPath, `${JSON.stringify(Object.fromEntries(
    Object.entries(hashes).map(([file, digest]) => [relocate(file), digest]),
  ), null, 2)}\n`)
}

function makeCase(t, options = {}) {
  const template = installTemplate()
  // Keep the provider home outside the OS temp directory. Current Windows Codex
  // intentionally refuses some sandbox-helper paths rooted below TEMP.
  const sandbox = fs.mkdtempSync(path.join(os.homedir(), '.ap-r10-'))
  const root = path.join(sandbox, 'c')
  const home = path.join(sandbox, 'h')
  const target = path.join(sandbox, 't')
  fs.mkdirSync(home)
  fs.mkdirSync(target)
  fs.cpSync(template, root, { recursive: true, force: true })
  relocateReceipt(template, root)
  if (process.platform === 'win32') {
    const sourceIdentity = path.join(HOST_CODEX_HOME, 'cap_sid')
    assert.equal(fs.lstatSync(sourceIdentity).isFile(), true,
      'the host Codex sandbox identity must be a regular file')
    fs.copyFileSync(sourceIdentity, path.join(root, 'cap_sid'))
  }
  const appData = path.join(home, 'appdata')
  const localAppData = path.join(home, 'localappdata')
  const xdgConfig = path.join(home, 'xdg')
  fs.mkdirSync(appData)
  fs.mkdirSync(localAppData)
  fs.mkdirSync(xdgConfig)
  fs.writeFileSync(path.join(root, 'auth.json'), '{"test":"synthetic-only"}\n')
  const initialized = boundedSpawn('git', ['init', '-b', 'activation-r10'], {
    cwd: target, encoding: 'utf8', timeout: 8_000,
  })
  assert.equal(initialized.status, 0, initialized.stderr)
  const configured = boundedSpawn('git', ['config', '--local', 'push.default', 'nothing'], {
    cwd: target, encoding: 'utf8', timeout: 8_000,
  })
  assert.equal(configured.status, 0, configured.stderr)
  fs.writeFileSync(path.join(target, '.git', 'hooks', 'pre-push'), localSafety.MANAGED_HOOK, {
    mode: 0o755,
  })
  const noisySkill = path.join(target, '.agents', 'skills', 'ambient-noise', 'SKILL.md')
  fs.mkdirSync(path.dirname(noisySkill), { recursive: true })
  fs.writeFileSync(noisySkill, '---\nname: ambient-noise\n---\nmust stay dormant\n')
  let foreignCompanion = null
  if (options.foreignCompanion !== false) {
    foreignCompanion = path.join(root, 'skills', 'problem-finder', 'SKILL.md')
    fs.mkdirSync(path.dirname(foreignCompanion), { recursive: true })
    fs.writeFileSync(foreignCompanion,
      '---\nname: problem-finder\nsource: foreign\n---\nforeign companion bytes\n')
  }
  const env = {
    ...process.env,
    APPDATA: appData,
    AUTOPROMPT_BENCHMARK_UNATTESTED_BETA: 'acknowledged-local-beta-override',
    AUTOPROMPT_INSTALL_ROOT: root,
    CODEX_HOME: root,
    HOME: home,
    LOCALAPPDATA: localAppData,
    OPENAI_API_KEY: 'synthetic-no-model-call',
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
  }
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  return { env, foreignCompanion, home, noisySkill, root, sandbox, target }
}

function activationProbeSpawn(supervisor) {
  return (command, args, options = {}) => {
    const codexProbe = path.isAbsolute(String(command)) &&
      path.resolve(String(command)) === path.resolve(TEST_CODEX.executable)
    if (command === process.execPath && args[0] === '-e' &&
        String(args[1]).includes('AUTOPROMPT_NETWORK_OPEN')) {
      return boundedSpawn(command, args, { ...options, timeout: 8_000 })
    }
    if (command === 'git' && args.includes('symbolic-ref')) {
      return { status: 0, stdout: 'activation-r10\n', stderr: '' }
    }
    if (codexProbe && args.length === 1 && args[0] === '--version') {
      return { status: 0, stdout: `${TEST_CODEX.identity.version}\n`, stderr: '' }
    }
    if (codexProbe && args.length === 1 && args[0] === '--help') {
      return { status: 0, stdout: '--profile --strict-config --cd', stderr: '' }
    }
    if (codexProbe && args[0] === 'exec') {
      assert.ok(args.includes('--output-schema'))
      return { status: 1, stdout: '', stderr: 'Failed to read output schema file: missing\n' }
    }
    if (codexProbe && args[0] === 'sandbox') {
      if (args.some(argument => String(argument).includes('AUTOPROMPT_NETWORK_DENIED'))) {
        fs.writeFileSync(String(args.at(-1)), 'DENIED', { mode: 0o600, flag: 'wx' })
        return { status: 0, stdout: 'AUTOPROMPT_NETWORK_DENIED', stderr: '' }
      }
      const nodeIndex = args.indexOf(process.execPath)
      assert.ok(nodeIndex >= 0, 'sandbox file probe must contain the admitted Node executable')
      return boundedSpawn(process.execPath, args.slice(nodeIndex + 1), {
        ...options, timeout: 8_000,
      })
    }
    if (typeof supervisor === 'function') return supervisor(command, args, options)
    assert.fail(`unexpected activation child: ${command} ${JSON.stringify(args)}`)
  }
}

function prepare(context, missionArgs, options = {}) {
  return activation.prepareActivation({
    env: context.env,
    missionArgs,
    now: options.now || FIXED_NOW,
    resume: options.resume,
    spawnSync: activationProbeSpawn(),
    target: context.target,
    ttlSeconds: options.ttlSeconds || 60,
  })
}

function capabilityContext(prepared, overrides = {}) {
  const capability = prepared.record.capability
  return {
    caller: capability.caller,
    generation: capability.generation,
    legalChild: capability.legalChildren[0],
    parentRole: capability.parentRole,
    parentSession: capability.parentSession,
    requestSha256: prepared.record.request.sha256,
    runId: prepared.activationId,
    targetRealpath: prepared.target.realpath,
    ...overrides,
  }
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, output))
  else if (value && typeof value === 'object') Object.values(value)
    .forEach(item => collectStrings(item, output))
  return output
}

function promptInputSnapshot(context, options = {}) {
  const executable = resolveCodexExecutable('codex')
  const args = []
  if (options.profile) args.push('--profile', options.profile)
  args.push('--cd', context.target, 'debug', 'prompt-input', options.prompt || 'Review one file.')
  const priorUmask = process.platform === 'win32' ? null : process.umask(0o077)
  let result
  try {
    result = boundedSpawn(executable.executable, args, {
      cwd: context.target,
      encoding: 'utf8',
      env: withCodexManagedEnvironment(options.env || context.env, executable),
      timeout: 15_000,
    })
  } finally {
    if (priorUmask !== null) process.umask(priorUmask)
  }
  assert.equal(result.status, 0,
    `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`)
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout) })
  const visible = collectStrings(parsed).join('\n')
  return {
    activationVisible: /AUTOPROMPT_(?:ACTIVATION|PROFILE|RUN_ID)|activation_id=/.test(visible),
    ambientNoiseVisible: visible.includes('ambient-noise') || visible.includes('must stay dormant'),
    explicitInvocationVisible: visible.includes('$autoprompt'),
    governanceVisible: /skills[\\/]autoprompt[\\/](?:GATES|MODES|PLAYBOOKS)\.md/i.test(visible),
    logicalRoles: [...new Set(visible.match(/\bap-[a-z0-9-]+\b/g) || [])]
      .filter(role => CODEX_LOGICAL_ROLES.has(role)).sort(),
    physicalRoles: [...new Set(
      visible.match(/\bautoprompt-codex-v[0-9-]+-[a-f0-9]{16}-ap-[a-z0-9-]+\b/g) || [],
    )].sort(),
    problemFinderVisible: visible.includes('problem-finder') || visible.includes('foreign companion bytes'),
    requestEnvelopeVisible: visible.includes('AUTOPROMPT_REQUEST_ENVELOPE_V2'),
  }
}

function emptyOrdinarySnapshot() {
  return {
    activationVisible: false,
    ambientNoiseVisible: false,
    explicitInvocationVisible: false,
    governanceVisible: false,
    logicalRoles: [],
    physicalRoles: [],
    problemFinderVisible: false,
    requestEnvelopeVisible: false,
  }
}

function makeBareEnvironment(context) {
  const root = path.join(context.sandbox, 'b')
  fs.mkdirSync(root)
  if (process.platform === 'win32') {
    fs.copyFileSync(path.join(HOST_CODEX_HOME, 'cap_sid'), path.join(root, 'cap_sid'))
  }
  return {
    ...context.env,
    AUTOPROMPT_INSTALL_ROOT: root,
    CODEX_HOME: root,
  }
}

function privateRoleSnapshot(prepared) {
  const profile = fs.readFileSync(path.join(prepared.activationRoot, 'autoprompt.config.toml'), 'utf8')
  const runtimeDirectory = path.join(
    prepared.activationRoot, 'skills', 'autoprompt', 'agents-runtime',
  )
  return {
    logical: Object.keys(prepared.record.roleProjection.logicalToPhysicalProviderRole).sort(),
    mapped: Object.values(prepared.record.roleProjection.logicalToPhysicalProviderRole).sort(),
    physicalFiles: fs.readdirSync(runtimeDirectory).filter(file => file.endsWith('.toml')).sort(),
    profile,
  }
}

function doctorReport(context) {
  const streams = captureStreams()
  const status = activation.runMaintenance(['--doctor-isolation'], {
    env: context.env,
    stderr: streams.stderr,
    stdout: streams.stdout,
  })
  const output = streams.values()
  let report
  assert.doesNotThrow(() => { report = JSON.parse(output.stdout) }, output.stdout)
  return { ...output, report, status }
}

test.before(() => {
  if (!DOCTOR_FIXTURE_ONLY) installTemplate()
}, { timeout: SUITE_SETUP_TIMEOUT_MS })

test.after(() => {
  for (const pid of trackedPids) {
    if (pidAlive(pid)) killBoundedProcessTree(pid)
  }
  assert.deepEqual([...trackedPids].filter(pidAlive), [], 'r10 child PID cleanup must be exact')
  if (installedTemplateSandbox) {
    fs.rmSync(installedTemplateSandbox, { recursive: true, force: true })
  }
})

test('AP-ISO-002 canonical CLI activation reaches the private versioned role bundle from a clean home', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t, { foreignCompanion: false })
  assert.equal(fs.existsSync(path.join(context.root, 'agents')), false)
  assert.deepEqual(cli.parseArgs([
    'activate', 'codex', '--root', context.root, '--target', context.target,
    '--ttl', '60', '--', 'exact', '', 'mission',
  ]).missionArgs, ['exact', '', 'mission'])
  let launched = null
  const streams = captureStreams()
  const status = cli.run([
    'activate', 'codex', '--root', context.root, '--target', context.target,
    '--ttl', '60', '--', 'exact', '', 'mission',
  ], {
    cwd: context.target,
    env: context.env,
    now: FIXED_NOW,
    spawnSync: activationProbeSpawn((command, args, options) => {
      const record = JSON.parse(fs.readFileSync(options.env.AUTOPROMPT_ACTIVATION_RECORD, 'utf8'))
      launched = { args, command, options, record }
      return { status: 0, stdout: '', stderr: '' }
    }),
    stderr: streams.stderr,
    stdout: streams.stdout,
  })
  assert.equal(status, 0, `${streams.values().stdout}\n${streams.values().stderr}`)
  assert.ok(launched)
  assert.equal(launched.command, process.execPath)
  assert.match(launched.record.supervisorEntry.prompt,
    /^\$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\n/)
  assert.deepEqual(launched.record.request.argv, ['exact', '', 'mission'])
  assert.equal(launched.record.roleProjection.payloadGeneration,
    codexRuntimeManifest.payloadGeneration)
  assert.equal(fs.existsSync(path.join(context.root, 'agents')), false)
  const saved = JSON.parse(fs.readFileSync(
    path.join(launched.options.env.CODEX_HOME, 'activation.json'), 'utf8',
  ))
  assert.equal(saved.status, 'revoked')
  assert.equal(saved.capability.status, 'revoked')
  assert.match(streams.values().stdout, /status=0 revoked=true/)
})

test('AP-ISO-004 clean-home private model input excludes every ambient skill', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t)
  const prepared = prepare(context, ['clean home model input'])
  const snapshot = promptInputSnapshot(context, {
    env: prepared.probeEnvironment,
    profile: 'autoprompt',
    prompt: prepared.record.supervisorEntry.prompt,
  })
  assert.equal(snapshot.activationVisible, true)
  assert.equal(snapshot.explicitInvocationVisible, true)
  assert.equal(snapshot.requestEnvelopeVisible, true)
  assert.equal(snapshot.ambientNoiseVisible, false)
  assert.equal(snapshot.problemFinderVisible, false)
  assert.deepEqual(snapshot.logicalRoles, ['ap-route-analyst'])
  assert.deepEqual(snapshot.physicalRoles, [])
  const namespaces = fs.readdirSync(path.join(prepared.activationRoot, 'skills')).sort()
  assert.deepEqual(namespaces.filter(name => !['.system', 'autoprompt', 'contracts'].includes(name)), [])
  assert.equal(fs.existsSync(path.join(prepared.activationRoot, 'skills', 'problem-finder')), false)
  assert.equal(fs.existsSync(path.join(prepared.activationRoot, 'skills', 'ambient-noise')), false)
  activation.revokeAllActivations({ env: context.env, reason: 'AP-ISO-004-complete' })
})

test('AP-ISO-007 ordinary discovery is byte-equivalent before, during, and after private activation', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t)
  const bareEnvironment = makeBareEnvironment(context)
  const beforeInstall = promptInputSnapshot(context, { env: bareEnvironment, prompt: 'Review one file.' })
  const afterInstall = promptInputSnapshot(context, { env: context.env, prompt: 'Review one file.' })
  assert.deepEqual(beforeInstall, emptyOrdinarySnapshot())
  assert.deepEqual(afterInstall, beforeInstall)
  const prepared = prepare(context, ['discovery lifecycle'])
  const during = promptInputSnapshot(context, { env: context.env, prompt: 'Review one file.' })
  assert.deepEqual(during, beforeInstall)
  const privateRoles = privateRoleSnapshot(prepared)
  assert.equal(privateRoles.logical.length, privateRoles.mapped.length)
  assert.deepEqual(privateRoles.physicalFiles, privateRoles.mapped.map(role => `${role}.toml`).sort())
  assert.equal(privateRoles.physicalFiles.some(file => /^ap-/.test(file)), false)
  activation.revokeAllActivations({ env: context.env, reason: 'AP-ISO-007-complete' })
  assert.equal(fs.existsSync(prepared.activationRoot), true)
  const after = promptInputSnapshot(context, { env: context.env, prompt: 'Review one file.' })
  assert.deepEqual(after, beforeInstall)
  assert.deepEqual(activation.inventoryIsolation({ env: context.env }).activeActivations, [])
})

test('AP-ISO-010 malformed activation residue makes uninstall fail closed and preserves receipts', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t, { foreignCompanion: false })
  const prepared = prepare(context, ['malformed uninstall record'])
  fs.writeFileSync(prepared.recordPath, '{malformed\n')
  const inventory = activation.inventoryIsolation({ env: context.env })
  assert.equal(inventory.malformedActivations.length, 1)
  const streams = captureStreams()
  const status = cli.run(['uninstall', 'codex', '--root', context.root], {
    cwd: ROOT,
    env: context.env,
    interactive: false,
    spawnSync: (command, args, options) => {
      const result = boundedSpawn(command, args, {
        ...options, encoding: 'utf8', stdio: 'pipe',
      })
      streams.stdout.write(result.stdout || '')
      streams.stderr.write(result.stderr || '')
      return result
    },
    stderr: streams.stderr,
    stdout: streams.stdout,
  })
  assert.notEqual(status, 0, `${streams.values().stdout}\n${streams.values().stderr}`)
  assert.equal(fs.existsSync(path.join(context.root, '.autoprompt-install-receipt.json')), true)
  assert.equal(fs.existsSync(prepared.recordPath), true)
  assert.match(`${streams.values().stdout}\n${streams.values().stderr}`,
    /malformed|residue|revoke/i)
})

test('AP-ISO-011 foreign companion provenance is preserved and excluded from activation input', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t)
  const before = fs.readFileSync(context.foreignCompanion)
  const prepared = prepare(context, ['foreign companion exclusion'])
  assert.equal(fs.existsSync(path.join(prepared.activationRoot, 'skills', 'problem-finder')), false)
  assert.deepEqual(fs.readFileSync(context.foreignCompanion), before)
  const receipt = JSON.parse(fs.readFileSync(
    path.join(context.root, '.autoprompt-install-receipt.json'), 'utf8',
  ))
  assert.equal(receipt.files.map(file => path.resolve(file)).includes(
    path.resolve(context.foreignCompanion)), false)
  const migrated = activation.quarantineKnownLegacy({ env: context.env })
  assert.equal(migrated.moved.length, 0)
  assert.deepEqual(fs.readFileSync(context.foreignCompanion), before)
  assert.equal(activation.inventoryIsolation({ env: context.env }).knownLegacySkill, false)
  activation.revokeAllActivations({ env: context.env, reason: 'AP-ISO-011-complete' })
})

test('AP-ISO-012 physical generation aliases never collide with a user-owned ap-manager', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t, { foreignCompanion: false })
  const globalAgents = path.join(context.root, 'agents')
  fs.mkdirSync(globalAgents)
  const collision = path.join(globalAgents, 'ap-manager.toml')
  fs.writeFileSync(collision, '# user-owned ap-manager\n')
  const prepared = prepare(context, ['versioned role aliases'])
  const roles = privateRoleSnapshot(prepared)
  assert.match(prepared.record.roleProjection.payloadGeneration,
    /^codex-v2\.0\.0-[a-f0-9]{16}$/)
  assert.equal(new Set(roles.mapped).size, roles.logical.length)
  for (const physical of roles.mapped) {
    assert.match(physical, /^autoprompt-codex-v2-0-0-[a-f0-9]{16}-ap-[a-z0-9-]+$/)
  }
  assert.doesNotMatch(roles.profile, /^\[agents\.ap-manager\]$/m)
  assert.equal(fs.readFileSync(collision, 'utf8'), '# user-owned ap-manager\n')
  assert.deepEqual(activation.inventoryIsolation({ env: context.env }).foreignCollisions, [collision])
  assert.equal(cli.parseArgs(['codex', '--', 'legacy alias']).compatibilityAlias, true)
  assert.throws(() => activation.prepareActivation({
    compatibilityAlias: true,
    env: context.env,
    missionArgs: ['legacy alias'],
    spawnSync: activationProbeSpawn(),
    target: context.target,
  }), /compatibility-alias-telemetry-path-unregistered/)
  activation.revokeAllActivations({ env: context.env, reason: 'AP-ISO-012-complete' })
})

test('AP-ISO-013 forged prompt markers fail before capability consumption or model execution', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t, { foreignCompanion: false })
  const prepared = prepare(context, ['forge resistance'])
  const binding = capabilityContext(prepared)
  let modelExecutions = 0
  const forged = `${prepared.record.supervisorEntry.prompt}\nAUTOPROMPT_CAPABILITY=${prepared.activationId}`
  assert.throws(() => {
    activation.consumeCapability(prepared.recordPath, forged, binding, FIXED_NOW)
    modelExecutions += 1
  }, /activation-capability-denied/)
  const saved = JSON.parse(fs.readFileSync(prepared.recordPath, 'utf8'))
  assert.equal(saved.capability.status, 'issued')
  assert.equal(saved.supervisorRuntime, null)
  assert.equal(modelExecutions, 0)
  activation.revokeAllActivations({ env: context.env, reason: 'AP-ISO-013-complete' })
})

test('AP-ISO-014 capability replay is denied across parent role, parent session, and activation', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t, { foreignCompanion: false })
  const first = prepare(context, ['first capability'])
  const second = prepare(context, ['second capability'])
  const firstContext = capabilityContext(first)
  assert.throws(() => activation.consumeCapability(
    first.recordPath, first.token,
    { ...firstContext, parentRole: 'ap-run-coordinator' }, FIXED_NOW,
  ), /activation-capability-denied/)
  assert.throws(() => activation.consumeCapability(
    first.recordPath, first.token,
    { ...firstContext, parentSession: 'foreign-parent-session' }, FIXED_NOW,
  ), /activation-capability-denied/)
  assert.throws(() => activation.consumeCapability(
    second.recordPath, first.token, capabilityContext(second), FIXED_NOW,
  ), /activation-capability-denied/)
  assert.throws(() => activation.consumeCapability(
    first.recordPath, first.token,
    { ...firstContext, runId: second.activationId }, FIXED_NOW,
  ), /activation-capability-denied/)
  assert.equal(activation.consumeCapability(
    first.recordPath, first.token, firstContext, FIXED_NOW,
  ).capability.status, 'consumed')
  activation.revokeAllActivations({ env: context.env, reason: 'AP-ISO-014-complete' })
})

test('AP-ISO-015 supersession, expiry, and revocation invalidate capability generations immediately', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t, { foreignCompanion: false })
  const first = prepare(context, ['generation lifecycle'], { ttlSeconds: 60 })
  const firstContext = capabilityContext(first)
  assert.equal(
    activation.revokeAllActivations({ env: context.env, reason: 'generation-superseded' }).revoked,
    1,
  )
  const second = prepare(context, ['generation lifecycle'], {
    now: new Date(FIXED_NOW.getTime() + 1_000),
    resume: first.activationId,
    ttlSeconds: 60,
  })
  assert.equal(second.activationId, first.activationId)
  assert.equal(second.record.capability.generation, first.record.capability.generation + 1)
  assert.throws(() => activation.consumeCapability(
    second.recordPath, first.token, firstContext,
    new Date(FIXED_NOW.getTime() + 1_000),
  ), /activation-capability-denied/)
  const expiring = prepare(context, ['expiry lifecycle'], { ttlSeconds: 60 })
  assert.throws(() => activation.consumeCapability(
    expiring.recordPath, expiring.token, capabilityContext(expiring),
    new Date(FIXED_NOW.getTime() + 60_001),
  ), /activation-capability-denied/)
  const revoked = activation.revokeAllActivations({ env: context.env, reason: 'run-stopped' })
  assert.equal(revoked.revoked, 2)
  assert.throws(() => activation.consumeCapability(
    second.recordPath, second.token, capabilityContext(second),
    new Date(FIXED_NOW.getTime() + 2_000),
  ), /activation-capability-denied/)
  const saved = JSON.parse(fs.readFileSync(second.recordPath, 'utf8'))
  assert.equal(saved.status, 'revoked')
  assert.equal(saved.capability.status, 'revoked')
  assert.equal(saved.capability.tokenSha256, null)
})

test('AP-RUN-010 resume preserves the exact durable activation nonce across generations', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const context = makeCase(t, { foreignCompanion: false })
  const first = prepare(context, ['durable activation nonce'], { ttlSeconds: 60 })
  const firstNonce = first.record.providerAttestation.attestation.activationNonce
  activation.revokeAllActivations({ env: context.env, reason: 'simulate-supervisor-exit' })

  const resumed = prepare(context, ['durable activation nonce'], {
    now: new Date(FIXED_NOW.getTime() + 1_000),
    resume: first.activationId,
    ttlSeconds: 60,
  })

  assert.equal(resumed.activationId, first.activationId)
  assert.equal(resumed.record.capability.generation, first.record.capability.generation + 1)
  assert.equal(resumed.record.providerAttestation.attestation.activationNonce, firstNonce)
  assert.notEqual(
    resumed.record.providerAttestation.attestation.signature.value,
    first.record.providerAttestation.attestation.signature.value,
  )
  activation.revokeAllActivations({ env: context.env, reason: 'AP-RUN-010-complete' })
})

test('AP-ISO-019 isolation doctor inventories and migrates clean, legacy, foreign, and mixed homes', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const cases = {}
  for (const name of ['clean', 'legacy', 'foreign', 'mixed']) {
    const context = makeCase(t, { foreignCompanion: name === 'foreign' || name === 'mixed' })
    const globalAgents = path.join(context.root, 'agents')
    if (name !== 'clean') fs.mkdirSync(globalAgents)
    if (name === 'legacy' || name === 'mixed') {
      fs.copyFileSync(
        path.join(ROOT, 'agents', 'codex', 'agents', 'ap-reviewer.toml'),
        path.join(globalAgents, 'ap-reviewer.toml'),
      )
    }
    if (name === 'foreign' || name === 'mixed') {
      fs.writeFileSync(path.join(globalAgents, 'ap-manager.toml'), '# foreign collision\n')
    }
    cases[name] = context
  }

  const clean = doctorReport(cases.clean)
  assert.equal(clean.status, 1)
  assert.equal(clean.report.isolationReady, false)
  assert.deepEqual(clean.report.knownLegacy, [])
  assert.deepEqual(clean.report.foreignCollisions, [])
  assert.deepEqual(clean.report.capabilityConflicts, EXPECTED_CANONICAL_TRUST_REFUSAL)
  assert.equal(clean.report.capabilities.privateSkillRoot, true)

  const legacy = doctorReport(cases.legacy)
  assert.equal(legacy.status, 1)
  assert.equal(legacy.report.knownLegacy.length, 1)
  assert.ok(legacy.report.recommendations.includes('quarantine-known-legacy'))

  const foreign = doctorReport(cases.foreign)
  assert.equal(foreign.report.foreignCollisions.length, 1)
  assert.deepEqual(foreign.report.knownLegacy, [])
  assert.ok(foreign.report.recommendations.includes('preserve-and-exclude-foreign-collisions'))

  const mixed = doctorReport(cases.mixed)
  assert.equal(mixed.report.knownLegacy.length, 1)
  assert.equal(mixed.report.foreignCollisions.length, 1)
  const foreignCollision = mixed.report.foreignCollisions[0]
  const migrated = activation.quarantineKnownLegacy({ env: cases.mixed.env })
  assert.equal(migrated.moved.length, 1)
  assert.equal(fs.existsSync(foreignCollision), true)
  assert.equal(fs.readFileSync(foreignCollision, 'utf8'), '# foreign collision\n')
  const after = doctorReport(cases.mixed)
  assert.deepEqual(after.report.knownLegacy, [])
  assert.equal(after.report.foreignCollisions.length, 1)
  assert.ok(after.report.recommendations.includes('preserve-and-exclude-foreign-collisions'))
})

test('AP-ISO-019 deterministic doctor trust refusal fixture', {
  timeout: CASE_TIMEOUT_MS,
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-iso019-doctor-fixture-'))
  const root = path.join(sandbox, 'codex-home')
  const home = path.join(sandbox, 'user-home')
  fs.mkdirSync(root)
  fs.mkdirSync(home)
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))

  const clean = doctorReport({
    env: {
      ...process.env,
      AUTOPROMPT_INSTALL_ROOT: root,
      CODEX_HOME: root,
      HOME: home,
      USERPROFILE: home,
    },
  })

  assert.equal(clean.status, 1)
  assert.equal(clean.report.isolationReady, false)
  assert.equal(clean.report.capabilityTrust.ready, false)
  assert.deepEqual(clean.report.capabilityConflicts, EXPECTED_CANONICAL_TRUST_REFUSAL)
  assert.deepEqual(clean.report.capabilityTrust.verifiedCapabilities, [])
  assert.equal(clean.report.registryCapability.verificationAttestation, null)
})
