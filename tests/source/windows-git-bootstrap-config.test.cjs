'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const bootstrap = require('../../scripts/windows-git-bootstrap-config.cjs')

const POLICY = Object.freeze([
  ['protocol.allow', 'never'],
  ['protocol.file.allow', 'always'],
  ['credential.helper', ''],
  ['credential.username', ''],
  ['core.askPass', ''],
  ['core.longpaths', 'true'],
  ['http.extraHeader', ''],
  ['http.cookieFile', ''],
  ['http.sslCert', ''],
  ['http.sslKey', ''],
  ['url.file:///autoprompt-reject/.pushInsteadOf', 'https://example.invalid/'],
  ['url.file:///autoprompt-reject/.pushInsteadOf', 'ssh://example.invalid/'],
])

test('Windows NUL Git bootstrap binds the complete injected policy', () => {
  const descriptor = bootstrap.createWindowsNulBootstrap(POLICY)
  const environment = bootstrap.projectWindowsNulBootstrap(descriptor, POLICY)
  assert.equal(descriptor.kind, 'windows-nul-device-v1')
  assert.equal(environment.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(environment.GIT_CONFIG_SYSTEM, '/dev/null')
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(environment.GIT_CONFIG_COUNT, String(POLICY.length))
  assert.equal(environment.GIT_CONFIG_KEY_10, POLICY[10][0])
  assert.equal(environment.GIT_CONFIG_VALUE_10, POLICY[10][1])
  assert.equal(environment.GIT_CONFIG_KEY_11, POLICY[11][0])
  assert.equal(environment.GIT_CONFIG_VALUE_11, POLICY[11][1])
  assert.equal(bootstrap.validateWindowsNulBootstrapEnvironment(environment, descriptor, POLICY), true)
  assert.throws(() => bootstrap.validateWindowsNulBootstrapEnvironment(
    { ...environment, GIT_CONFIG_VALUE_5: 'false' }, descriptor, POLICY),
  { code: 'WINDOWS_GIT_BOOTSTRAP_INVALID' })
  assert.throws(() => bootstrap.validateWindowsNulBootstrapEnvironment(
    { ...environment, GIT_CONFIG_KEY_99: 'core.editor', GIT_CONFIG_VALUE_99: 'foreign' }, descriptor, POLICY),
  { code: 'WINDOWS_GIT_BOOTSTRAP_INVALID' })
  assert.throws(() => bootstrap.validateWindowsNulBootstrapEnvironment(
    { ...environment, GIT_CONFIG_KEY_00: 'core.editor' }, descriptor, POLICY),
  { code: 'WINDOWS_GIT_BOOTSTRAP_INVALID' })
  assert.throws(() => bootstrap.validateWindowsNulBootstrapEnvironment(
    { ...environment, git_config_key_0: 'core.editor' }, descriptor, POLICY),
  { code: 'WINDOWS_GIT_BOOTSTRAP_INVALID' })
  assert.throws(() => bootstrap.validateWindowsNulBootstrapEnvironment(
    { ...environment, git_config_global: 'foreign' }, descriptor, POLICY),
  { code: 'WINDOWS_GIT_BOOTSTRAP_INVALID' })
  assert.throws(() => bootstrap.validateWindowsNulBootstrapEnvironment(
    { ...environment, GIT_CONFIG_PARAMETERS: "'core.editor=foreign'" }, descriptor, POLICY),
  { code: 'WINDOWS_GIT_BOOTSTRAP_INVALID' })
})

test('native Windows Git reads injected policy without opening a >300-character config path', {
  skip: process.platform !== 'win32', timeout: 120000,
}, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-git-nul-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repository = path.join(root, 'repo')
  fs.mkdirSync(repository)
  let deep = root
  for (let index = 0; index < 7; index += 1) deep = path.join(deep, `${index}-${'deep-git-bootstrap-'.repeat(3)}`)
  fs.mkdirSync(deep, { recursive: true })
  const unreachableConfig = path.join(deep, 'git-empty.config')
  assert.ok(unreachableConfig.length > 300, `fixture config path was only ${unreachableConfig.length} characters`)
  fs.writeFileSync(unreachableConfig, '[core]\nlongpaths = false\n')
  const descriptor = bootstrap.createWindowsNulBootstrap(POLICY)
  const environment = {
    ...process.env,
    HOME: deep,
    USERPROFILE: deep,
    ...bootstrap.projectWindowsNulBootstrap(descriptor, POLICY),
  }
  bootstrap.validateWindowsNulBootstrapEnvironment(environment, descriptor, POLICY)
  const init = cp.spawnSync('git', ['-C', repository, 'init', '-b', 'fixture'], {
    env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.ifError(init.error)
  assert.equal(init.status, 0, init.stderr || init.stdout)
  const configured = cp.spawnSync('git', ['-C', repository, 'config', '--get', 'core.longpaths'], {
    env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.ifError(configured.error)
  assert.equal(configured.status, 0, configured.stderr || configured.stdout)
  assert.equal(configured.stdout.trim(), 'true')
  fs.writeFileSync(unreachableConfig, '')
  const ghConfigDir = path.join(deep, 'gh')
  fs.mkdirSync(ghConfigDir)
  require('../../agents/codex/workflow/safe-run-root.js').ensureWindowsPrivateAcl(deep)
  const committed = cp.spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'],
  { env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(committed.status, 0, committed.stderr)
  const safety = require('../../scripts/local-only-safety.cjs')
  const production = safety.createSafeChildGitEnvironment(repository, environment, {
    expectedBranch: 'fixture', configIsolationPath: unreachableConfig, ghConfigDir,
  })
  assert.equal(production.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(production.GIT_CONFIG_SYSTEM, '/dev/null')
  const actual = cp.spawnSync('git', ['-C', repository, 'config', '--get', 'protocol.allow'],
    { env: production, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(actual.status, 0, actual.stderr)
  assert.equal(actual.stdout.trim(), 'never')
  const nativeEnvironment = require('../../scripts/harness-v2-native.cjs').isolatedEnvironment(
    path.join(deep, 'provider-home'), production,
  )
  assert.equal(nativeEnvironment.GIT_CONFIG_GLOBAL, '/dev/null')
  const providerGit = cp.spawnSync('git', ['-C', repository, 'config', '--get', 'core.longpaths'],
    { env: nativeEnvironment, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(providerGit.status, 0, providerGit.stderr)
  assert.equal(providerGit.stdout.trim(), 'true')
})
