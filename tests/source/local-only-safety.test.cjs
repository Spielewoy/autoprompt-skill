#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const CHECKER = path.join(ROOT, 'scripts', 'local-only-safety.cjs')
const {
  EXIT,
  MANAGED_HOOK,
  createSafeChildGitEnvironment,
  discoverRepository,
  inspect,
} = require('../../scripts/local-only-safety.cjs')
const EXPECTED_BRANCH = 'local/autoprompt-redesign'
const REMOTE_TRAP_CHILD_TIMEOUT_MS = 60_000

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    ...options,
  })
}

function git(context, args, options = {}) {
  const result = run('git', ['-C', context.repo, ...args], {
    env: context.env,
    ...options,
  })
  if (!options.allowFailure) {
    assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr || result.stdout}`)
  }
  return result
}

function makeEnvironment(home, inherited = process.env) {
  fs.mkdirSync(home, { recursive: true })
  const configIsolation = path.join(home, 'empty.gitconfig')
  fs.writeFileSync(configIsolation, '', { flag: 'w', mode: 0o600 })
  try { fs.chmodSync(configIsolation, 0o600) } catch {}
  const env = { ...inherited }
  for (const key of Object.keys(env)) {
    if (/^(GIT_|GH_|GITHUB_|GCM_|SSH_)/i.test(key)) delete env[key]
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: configIsolation,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: configIsolation,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
  })
  return { configIsolation, env }
}

function makeRepo(t, branch = EXPECTED_BRANCH) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt local-only safety '))
  const repo = path.join(sandbox, 'repo')
  const home = path.join(sandbox, 'home')
  fs.mkdirSync(repo, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const isolated = makeEnvironment(home)
  const activationRoot = path.join(sandbox, 'activation')
  const configIsolation = path.join(activationRoot, 'git-empty.config')
  const ghConfigDir = path.join(activationRoot, 'gh-config')
  const profilePath = path.join(activationRoot, 'autoprompt.config.toml')
  fs.mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(configIsolation, '', { mode: 0o600 })
  const profile = [
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    '',
    '[sandbox_workspace_write]',
    'network_access = false',
    '',
    '[features]',
    'apps = false',
    'enable_mcp_apps = false',
    'plugins = false',
    'remote_plugin = false',
    'browser_use = false',
    'browser_use_external = false',
    'in_app_browser = false',
    'computer_use = false',
    'image_generation = false',
    '',
  ].join('\n')
  fs.writeFileSync(profilePath, profile, { mode: 0o600 })
  const enforcementProof = {
    schemaVersion: 1,
    provider: 'codex',
    profilePath,
    profileSha256: crypto.createHash('sha256').update(profile).digest('hex'),
    selectedProfile: 'autoprompt',
    strictConfig: true,
  }
  const proofPath = path.join(activationRoot, 'enforcement-proof.json')
  fs.writeFileSync(proofPath, `${JSON.stringify(enforcementProof)}\n`, { mode: 0o600 })
  const context = {
    ...isolated,
    activationRoot,
    configIsolation,
    enforcementProof,
    ghConfigDir,
    profilePath,
    proofPath,
    repo,
    sandbox,
  }
  context.env.GIT_CONFIG_GLOBAL = configIsolation
  context.env.GIT_CONFIG_SYSTEM = configIsolation
  assert.equal(run('git', ['init', '--quiet', repo], { env: context.env }).status, 0)
  git(context, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
  return context
}

function boundaryEnvironment(context) {
  return createSafeChildGitEnvironment(context.repo, context.env, {
    configIsolationPath: context.configIsolation,
    ghConfigDir: context.ghConfigDir,
  })
}

function invoke(context, expectedBranch = EXPECTED_BRANCH, extra = [], options = {}) {
  const environment = options.boundary === false ? context.env : boundaryEnvironment(context)
  const result = run(process.execPath, [
    CHECKER,
    '--repo', context.repo,
    '--expected-branch', expectedBranch,
    ...(options.proof === false ? [] : ['--enforcement-proof', context.proofPath]),
    '--json',
    ...extra,
  ], { env: environment })
  assert.doesNotMatch(result.stderr, /fatal:|warning:/i)
  return { ...result, json: JSON.parse(result.stdout) }
}

function invokeWithTimedOutGitRemote(context, extra = []) {
  const trapPath = path.join(context.sandbox, 'git-remote-timeout-trap.cjs')
  const reportPath = path.join(context.sandbox, 'git-remote-timeout-report.json')
  fs.writeFileSync(trapPath, [
    "'use strict'",
    "const childProcess = require('node:child_process')",
    "const fs = require('node:fs')",
    'const originalSpawnSync = childProcess.spawnSync',
    'let remoteAttempts = 0',
    'childProcess.spawnSync = (command, args, options) => {',
    "  if (command === 'git' && Array.isArray(args) && args[2] === 'remote') {",
    '    remoteAttempts += 1',
    "    const error = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' })",
    "    return { error, status: null, signal: 'SIGTERM', stdout: '', stderr: '' }",
    '  }',
    '  return originalSpawnSync(command, args, options)',
    '}',
    'let exitCode = 70',
    'try {',
    '  exitCode = require(process.env.LOCAL_ONLY_CHECKER).main(process.argv.slice(2))',
    '} finally {',
    '  fs.writeFileSync(process.env.GIT_REMOTE_TRAP_REPORT, JSON.stringify({ remoteAttempts }))',
    '}',
    'process.exitCode = exitCode',
    '',
  ].join('\n'))
  const result = run(process.execPath, [
    trapPath,
    '--repo', context.repo,
    '--expected-branch', EXPECTED_BRANCH,
    '--enforcement-proof', context.proofPath,
    '--json',
    ...extra,
  ], {
    env: {
      ...boundaryEnvironment(context),
      GIT_REMOTE_TRAP_REPORT: reportPath,
      LOCAL_ONLY_CHECKER: CHECKER,
    },
    timeout: REMOTE_TRAP_CHILD_TIMEOUT_MS,
  })
  const stdout = String(result.stdout || '')
  const stderr = String(result.stderr || '')
  const diagnostics = [
    `status=${String(result.status)}`,
    `signal=${String(result.signal)}`,
    `error=${result.error ? `${result.error.code || result.error.name}: ${result.error.message}` : 'none'}`,
    `stdoutBytes=${Buffer.byteLength(stdout, 'utf8')}`,
    `stderr=${stderr ? JSON.stringify(stderr.trim().slice(0, 4_096)) : '(empty)'}`,
    `reportExists=${fs.existsSync(reportPath)}`,
  ].join('; ')
  assert.equal(result.error, undefined, `local-only checker child failed to run: ${diagnostics}`)
  assert.notEqual(result.status, null, `local-only checker child did not exit: ${diagnostics}`)
  assert.notEqual(stdout.trim(), '', `local-only checker child emitted no JSON: ${diagnostics}`)
  assert.doesNotMatch(stderr, /fatal:|warning:/i)

  let json
  try {
    json = JSON.parse(stdout)
  } catch (error) {
    assert.fail(`local-only checker child emitted invalid JSON (${error.message}): ${diagnostics}`)
  }
  assert.equal(fs.existsSync(reportPath), true, `git remote trap emitted no report: ${diagnostics}`)

  let trap
  try {
    trap = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch (error) {
    assert.fail(`git remote trap emitted invalid JSON (${error.message}): ${diagnostics}`)
  }
  return {
    ...result,
    json,
    trap,
  }
}

function repair(context, expectedBranch = EXPECTED_BRANCH) {
  const result = invoke(context, expectedBranch, ['--repair'])
  assert.equal(result.status, EXIT.SAFE, result.stdout)
  assert.equal(result.json.ok, true)
  return result
}

function byId(result, id) {
  return result.json.checks.find(item => item.id === id)
}

function detachHead(context) {
  git(context, ['config', '--local', 'user.name', 'Local Safety Test'])
  git(context, ['config', '--local', 'user.email', 'local-safety@example.invalid'])
  git(context, ['commit', '--quiet', '--allow-empty', '-m', 'detached HEAD fixture'])
  const oid = git(context, ['rev-parse', '--verify', 'HEAD']).stdout.trim()
  git(context, ['checkout', '--quiet', '--detach', oid])
  assert.equal(git(context, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }).status, 1)
  return oid
}

test('repair installs a complete local-only barrier and check mode reports structured passes', t => {
  const context = makeRepo(t)
  git(context, ['remote', 'add', 'origin', 'https://github.com/example/autoprompt.git'])
  git(context, ['config', '--local', `branch.${EXPECTED_BRANCH}.remote`, 'origin'])
  git(context, ['config', '--local', `branch.${EXPECTED_BRANCH}.merge`, 'refs/heads/main'])
  git(context, ['config', '--local', 'push.default', 'simple'])

  const repaired = repair(context)
  assert.equal(repaired.json.schemaVersion, 2)
  assert.equal(repaired.json.tool, 'local-only-safety')
  assert.equal(repaired.json.mode, 'repair')
  assert.equal(repaired.json.exitCode, EXIT.SAFE)
  assert.equal(repaired.json.networkContactAttempted, false)
  assert.equal(repaired.json.repositoryOk, true)
  assert.equal(repaired.json.commandBoundary.enforced, true)
  assert.equal(repaired.json.mechanicallyEnforced, true)
  assert.equal(repaired.json.gitEnforced, true)
  assert.deepEqual(Object.keys(repaired.json.channels), [
    'repositoryGitBarrier',
    'gitCommandNetworkBarrier',
    'githubCliCredentialIsolation',
    'shellOutboundNetworkSandbox',
    'providerConnectorApiWriteToolDenial',
  ])
  for (const item of Object.values(repaired.json.channels)) {
    assert.equal(item.applicable, true)
    assert.equal(item.enforced, true)
    assert.ok(Object.keys(item.evidence).length > 0)
    assert.deepEqual(item.residuals, [])
  }
  assert.deepEqual(repaired.json.checks.map(item => item.status), Array(6).fill('pass'))
  assert.ok(repaired.json.repairs.changes.some(item => item.includes('push.default=nothing')))
  assert.ok(repaired.json.repairs.changes.some(item => item.includes('redirected origin')))
  assert.ok(repaired.json.repairs.changes.some(item => item.includes('pre-push hook')))

  assert.equal(git(context, ['config', '--local', '--get', 'push.default']).stdout.trim(), 'nothing')
  assert.equal(git(context, ['config', '--local', '--get', `branch.${EXPECTED_BRANCH}.remote`], { allowFailure: true }).status, 1)
  assert.equal(git(context, ['config', '--local', '--get', `branch.${EXPECTED_BRANCH}.merge`], { allowFailure: true }).status, 1)

  const gitDir = git(context, ['rev-parse', '--absolute-git-dir']).stdout.trim()
  const rejectTarget = path.join(gitDir, 'NO_REMOTE_PUSH')
  assert.equal(git(context, ['config', '--local', '--get', 'remote.origin.pushurl']).stdout.trim(), rejectTarget)
  assert.equal(fs.existsSync(rejectTarget), false)
  assert.equal(fs.readFileSync(path.join(gitDir, 'hooks', 'pre-push'), 'utf8'), MANAGED_HOOK)

  const checked = invoke(context)
  assert.equal(checked.status, EXIT.SAFE)
  assert.equal(checked.json.mode, 'check')
  assert.equal(checked.json.ok, true)

  git(context, ['config', '--local', 'user.name', 'Local Safety Test'])
  git(context, ['config', '--local', 'user.email', 'local-safety@example.invalid'])
  git(context, ['commit', '--quiet', '--allow-empty', '-m', 'local push rejection probe'])
  const simulatedPush = git(context, ['push', 'origin', 'HEAD'], { allowFailure: true })
  assert.notEqual(simulatedPush.status, 0)
  assert.match(simulatedPush.stderr, /does not appear to be a git repository|Could not read from remote repository/i)

  const hookProbe = git(context, ['hook', 'run', 'pre-push'], { allowFailure: true })
  assert.equal(hookProbe.status, 1)
  assert.match(hookProbe.stderr, /Push disabled/)
})

test('an explicit empty expected branch is an exact detached-HEAD contract', async t => {
  await t.test('detached repair passes without moving HEAD or fabricating a branch', () => {
    const context = makeRepo(t)
    const oid = detachHead(context)
    git(context, ['remote', 'add', 'origin', 'https://github.com/example/autoprompt.git'])
    git(context, ['config', '--local', `branch.${EXPECTED_BRANCH}.remote`, 'origin'])
    git(context, ['config', '--local', `branch.${EXPECTED_BRANCH}.merge`, 'refs/heads/main'])
    const branchesBefore = git(context, [
      'for-each-ref', '--format=%(refname)', 'refs/heads',
    ]).stdout

    const repaired = invoke(context, '', ['--repair'])
    assert.equal(repaired.status, EXIT.SAFE, repaired.stdout)
    assert.equal(repaired.json.expectedBranch, '')
    assert.deepEqual(repaired.json.expectedHead, { branch: null, state: 'detached' })
    assert.deepEqual(repaired.json.actualHead, { branch: null, oid, state: 'detached' })
    assert.equal(byId(repaired, 'expected_branch').status, 'pass')
    assert.match(byId(repaired, 'expected_branch').summary, /detached as explicitly required/)
    assert.equal(git(context, ['rev-parse', '--verify', 'HEAD']).stdout.trim(), oid)
    assert.equal(git(context, ['branch', '--show-current']).stdout.trim(), '')
    assert.equal(git(context, ['for-each-ref', '--format=%(refname)', 'refs/heads']).stdout, branchesBefore)
    assert.equal(
      git(context, ['config', '--local', '--get', `branch.${EXPECTED_BRANCH}.remote`]).stdout.trim(),
      'origin',
    )
    assert.equal(git(context, ['config', '--local', '--get', 'push.default']).stdout.trim(), 'nothing')
    assert.equal(
      git(context, ['config', '--local', '--get', 'remote.origin.pushurl']).stdout.trim(),
      discoverRepository(context.repo).rejectTarget,
    )

    const textResult = run(process.execPath, [
      CHECKER,
      '--repo', context.repo,
      '--expected-branch', '',
      '--enforcement-proof', context.proofPath,
    ], { env: boundaryEnvironment(context) })
    assert.equal(textResult.status, EXIT.SAFE, textResult.stdout)
    assert.match(textResult.stdout, new RegExp(`HEAD: detached HEAD at ${oid} \\(expected detached HEAD\\)`))

    git(context, ['config', '--local', '--replace-all', 'remote.origin.pushurl', 'https://github.com/example/unsafe.git'])
    git(context, ['config', '--local', 'push.default', 'current'])
    const tampered = invoke(context, '')
    assert.equal(tampered.status, EXIT.UNSAFE)
    assert.equal(byId(tampered, 'expected_branch').status, 'pass')
    assert.equal(byId(tampered, 'remote_push_targets').status, 'fail')
    assert.equal(byId(tampered, 'push_default_nothing').status, 'fail')
    assert.equal(tampered.json.networkContactAttempted, false)
  })

  await t.test('an attached branch is a mismatch and repair makes zero changes', () => {
    const context = makeRepo(t)
    const gitDir = git(context, ['rev-parse', '--absolute-git-dir']).stdout.trim()
    const configPath = path.join(gitDir, 'config')
    const configBefore = fs.readFileSync(configPath)

    const result = invoke(context, '', ['--repair'])
    assert.equal(result.status, EXIT.REPAIR_INCOMPLETE)
    assert.equal(byId(result, 'expected_branch').status, 'fail')
    assert.match(byId(result, 'expected_branch').summary, /Expected detached HEAD, found branch/)
    assert.deepEqual(result.json.expectedHead, { branch: null, state: 'detached' })
    assert.equal(result.json.actualHead.state, 'branch')
    assert.equal(result.json.actualHead.branch, EXPECTED_BRANCH)
    assert.deepEqual(result.json.repairs.changes, [])
    assert.match(result.json.repairs.refusals[0], /never repaired automatically/)
    assert.deepEqual(fs.readFileSync(configPath), configBefore)
    assert.equal(git(context, ['branch', '--show-current']).stdout.trim(), EXPECTED_BRANCH)
  })

  await t.test('a named branch remains an exact named-branch contract', () => {
    const context = makeRepo(t)
    const result = invoke(context, EXPECTED_BRANCH, ['--repair'])
    assert.equal(result.status, EXIT.SAFE, result.stdout)
    assert.deepEqual(result.json.expectedHead, { branch: EXPECTED_BRANCH, state: 'branch' })
    assert.equal(result.json.actualHead.branch, EXPECTED_BRANCH)
    assert.equal(byId(result, 'expected_branch').status, 'pass')
  })
})

test('check and repair derive unique remotes from parsed config without invoking git remote', t => {
  const context = makeRepo(t)
  const canonicalRejectTarget = discoverRepository(context.repo).rejectTarget
  git(context, ['config', '--local', '--add', 'remote.origin.url', 'https://github.com/example/origin.git'])
  git(context, ['config', '--local', '--add', 'remote.origin.url', 'https://mirror.invalid/origin.git'])
  git(context, ['config', '--local', '--add', 'remote.backup.url', 'https://github.com/example/backup.git'])
  git(context, ['config', '--local', '--add', 'remote.mirror.pushurl', canonicalRejectTarget])

  const repaired = invokeWithTimedOutGitRemote(context, ['--repair'])
  assert.equal(repaired.trap.remoteAttempts, 0)
  assert.equal(repaired.status, EXIT.SAFE, repaired.stdout)
  assert.equal(repaired.json.networkContactAttempted, false)
  assert.deepEqual(
    byId(repaired, 'remote_push_targets').details.remotes.map(remote => remote.name),
    ['backup', 'mirror', 'origin'],
  )
  const rejectTarget = canonicalRejectTarget
  for (const remote of ['backup', 'mirror', 'origin']) {
    assert.equal(
      git(context, ['config', '--local', '--get-all', `remote.${remote}.pushurl`]).stdout.trim(),
      rejectTarget,
    )
  }
  assert.deepEqual(
    git(context, ['config', '--local', '--get-all', 'remote.origin.url']).stdout.trim().split(/\r?\n/),
    ['https://github.com/example/origin.git', 'https://mirror.invalid/origin.git'],
  )

  const checked = invokeWithTimedOutGitRemote(context)
  assert.equal(checked.trap.remoteAttempts, 0)
  assert.equal(checked.status, EXIT.SAFE, checked.stdout)
  assert.equal(checked.json.networkContactAttempted, false)

  git(context, ['config', '--local', '--replace-all', 'remote.origin.pushurl', 'https://github.com/example/unsafe.git'])
  const unsafe = invokeWithTimedOutGitRemote(context)
  assert.equal(unsafe.trap.remoteAttempts, 0)
  assert.equal(unsafe.status, EXIT.UNSAFE)
  assert.equal(unsafe.json.networkContactAttempted, false)
  assert.equal(byId(unsafe, 'remote_push_targets').status, 'fail')

  const noRemotes = makeRepo(t)
  const emptyRepair = invokeWithTimedOutGitRemote(noRemotes, ['--repair'])
  assert.equal(emptyRepair.trap.remoteAttempts, 0)
  assert.equal(emptyRepair.status, EXIT.SAFE, emptyRepair.stdout)
  assert.deepEqual(byId(emptyRepair, 'remote_push_targets').details.remotes, [])
})

test('check mode aggregates missing upstream, push, target, and hook protections', t => {
  const context = makeRepo(t)
  git(context, ['remote', 'add', 'origin', 'https://github.com/example/autoprompt.git'])
  git(context, ['config', '--local', `branch.${EXPECTED_BRANCH}.remote`, 'origin'])
  git(context, ['config', '--local', `branch.${EXPECTED_BRANCH}.merge`, 'refs/heads/main'])
  git(context, ['config', '--local', 'push.default', 'current'])

  const result = invoke(context)
  assert.equal(result.status, EXIT.UNSAFE)
  assert.equal(result.json.exitCode, EXIT.UNSAFE)
  assert.equal(result.json.ok, false)
  assert.equal(byId(result, 'expected_branch').status, 'pass')
  for (const id of ['no_upstream', 'push_default_nothing', 'remote_push_targets', 'pre_push_hook']) {
    assert.equal(byId(result, id).status, 'fail', id)
  }
})

test('a network push URL is rejected without opening a connection', async t => {
  const context = makeRepo(t)
  const server = net.createServer(socket => socket.destroy())
  let connections = 0
  server.on('connection', () => { connections += 1 })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => server.close())

  const port = server.address().port
  git(context, ['remote', 'add', 'origin', 'https://github.com/example/autoprompt.git'])
  git(context, ['config', '--local', '--add', 'remote.origin.pushurl', `ssh://127.0.0.1:${port}/repo.git`])
  git(context, ['config', '--local', 'push.default', 'nothing'])

  const result = invoke(context)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(result.status, EXIT.UNSAFE)
  assert.equal(byId(result, 'remote_push_targets').status, 'fail')
  assert.equal(result.json.networkContactAttempted, false)
  assert.equal(connections, 0)
})

test('emitted child environment contains --no-verify explicit URL pushes before any socket connection', async t => {
  const context = makeRepo(t)
  repair(context)
  git(context, ['config', '--local', 'user.name', 'Local Safety Test'])
  git(context, ['config', '--local', 'user.email', 'local-safety@example.invalid'])
  git(context, ['commit', '--quiet', '--allow-empty', '-m', 'explicit URL containment probe'])

  const server = net.createServer(socket => socket.destroy())
  let connections = 0
  server.on('connection', () => { connections += 1 })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => server.close())

  const childEnv = boundaryEnvironment(context)
  assert.equal(childEnv.GIT_ALLOW_PROTOCOL, 'file')
  assert.equal(childEnv.GIT_TERMINAL_PROMPT, '0')
  assert.equal(childEnv.GIT_CONFIG_GLOBAL, context.configIsolation)
  const configuredValues = Array.from(
    { length: Number(childEnv.GIT_CONFIG_COUNT) },
    (_, index) => childEnv[`GIT_CONFIG_VALUE_${index}`],
  )
  assert.ok(configuredValues.includes('https://'))
  assert.ok(configuredValues.includes('ssh://'))

  const explicitUrl = `https://127.0.0.1:${server.address().port}/repo.git`
  const result = git(context, [
    'push', '--no-verify', explicitUrl, 'HEAD:refs/heads/probe',
  ], { allowFailure: true, env: childEnv })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not appear to be a git repository|Could not read from remote repository/i)
  assert.equal(connections, 0)
})

test('fake gh cannot discover ambient credentials or open a socket through the isolated GH_CONFIG_DIR', async t => {
  const context = makeRepo(t)
  repair(context)
  const server = net.createServer(socket => socket.destroy())
  let connections = 0
  server.on('connection', () => { connections += 1 })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => server.close())

  const ambientAppData = path.join(context.sandbox, 'ambient appdata')
  const ambientGh = path.join(ambientAppData, 'GitHub CLI')
  fs.mkdirSync(ambientGh, { recursive: true })
  fs.writeFileSync(path.join(ambientGh, 'hosts.yml'), JSON.stringify({
    host: 'github.example.invalid',
    token: 'ambient-secret-never-print',
    endpoint: { host: '127.0.0.1', port: server.address().port },
  }))
  const fakeGh = path.join(context.sandbox, 'fake-gh.cjs')
  fs.writeFileSync(fakeGh, [
    "'use strict'",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    "const path = require('node:path')",
    "const config = process.env.GH_CONFIG_DIR || path.join(process.env.APPDATA, 'GitHub CLI')",
    "const hosts = path.join(config, 'hosts.yml')",
    "if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(91)",
    "if (!fs.existsSync(hosts)) { process.stderr.write('fake-gh:no-credentials\\n'); process.exit(78) }",
    "const credential = JSON.parse(fs.readFileSync(hosts, 'utf8'))",
    "const socket = net.connect(credential.endpoint.port, credential.endpoint.host)",
    "socket.once('connect', () => { socket.destroy(); process.exit(92) })",
    "socket.once('error', () => process.exit(93))",
    '',
  ].join('\n'))

  context.env.APPDATA = ambientAppData
  context.env.GH_TOKEN = 'ambient-env-token'
  context.env.GITHUB_AUTH_HEADER = 'ambient-header'
  context.env.GITHUB_REPOSITORY = 'owner/repository'
  const childEnv = boundaryEnvironment(context)
  assert.equal(childEnv.GH_CONFIG_DIR, context.ghConfigDir)
  assert.equal(childEnv.GH_PROMPT_DISABLED, '1')
  assert.equal(childEnv.GH_TOKEN, undefined)
  assert.equal(childEnv.GITHUB_AUTH_HEADER, undefined)
  assert.equal(childEnv.GITHUB_REPOSITORY, undefined)

  const result = run(process.execPath, [fakeGh, 'api', '/user'], { env: childEnv })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(result.status, 78)
  assert.match(result.stderr, /fake-gh:no-credentials/)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /ambient-secret|ambient-env-token|ambient-header/)
  assert.equal(connections, 0)
  assert.equal(fs.readdirSync(context.ghConfigDir).length, 0)
})

test('effective URL rewrites cannot turn the canonical local target into GitHub', t => {
  const context = makeRepo(t)
  git(context, ['remote', 'add', 'origin', 'https://github.com/example/autoprompt.git'])
  repair(context)
  const rejectTarget = git(context, ['config', '--get', 'remote.origin.pushurl']).stdout.trim()
  git(context, ['config', '--local', '--add', 'url.https://github.com/escape/.insteadOf', rejectTarget])

  const result = invoke(context)
  assert.equal(result.status, EXIT.UNSAFE)
  assert.equal(byId(result, 'remote_push_targets').status, 'fail')
  assert.equal(byId(result, 'repository_write_auth_configuration').status, 'fail')
})

test('generic authorization headers and credential helpers are reported by key without leaking values', t => {
  const context = makeRepo(t)
  repair(context)
  const secret = 'AUTHORIZATION: basic should-never-appear'
  git(context, ['config', '--local', 'http.extraheader', secret])
  git(context, ['config', '--local', 'credential.helper', 'fixture-secret-helper'])
  git(context, ['config', '--local', 'core.askPass', 'fixture-secret-askpass'])
  git(context, ['config', '--local', 'http.sslKey', 'fixture-secret-key.pem'])

  const result = invoke(context)
  assert.equal(result.status, EXIT.UNSAFE)
  assert.equal(byId(result, 'repository_write_auth_configuration').status, 'fail')
  assert.deepEqual(byId(result, 'repository_write_auth_configuration').details.riskyKeys, [
    'core.askpass',
    'credential.helper',
    'http.extraheader',
    'http.sslkey',
  ])
  assert.doesNotMatch(result.stdout, /should-never-appear|fixture-secret-helper|fixture-secret-askpass|fixture-secret-key/)
})

test('repair never switches branches or overwrites an unknown hook', async t => {
  await t.test('branch mismatch makes no changes', () => {
    const context = makeRepo(t, 'some-other-branch')
    const result = invoke(context, EXPECTED_BRANCH, ['--repair'])
    assert.equal(result.status, EXIT.REPAIR_INCOMPLETE)
    assert.equal(byId(result, 'expected_branch').status, 'fail')
    assert.deepEqual(result.json.repairs.changes, [])
    assert.match(result.json.repairs.refusals[0], /never repaired automatically/)
    assert.equal(git(context, ['branch', '--show-current']).stdout.trim(), 'some-other-branch')
  })

  await t.test('unknown hook is preserved', () => {
    const context = makeRepo(t)
    const gitDir = git(context, ['rev-parse', '--absolute-git-dir']).stdout.trim()
    const hook = path.join(gitDir, 'hooks', 'pre-push')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n')

    const result = invoke(context, EXPECTED_BRANCH, ['--repair'])
    assert.equal(result.status, EXIT.REPAIR_INCOMPLETE)
    assert.equal(byId(result, 'pre_push_hook').status, 'fail')
    assert.match(result.json.repairs.refusals.join('\n'), /not overwritten/)
    assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n')
  })

  await t.test('foreign core.hooksPath causes zero mutation and is never deactivated', () => {
    const context = makeRepo(t)
    const gitDir = git(context, ['rev-parse', '--absolute-git-dir']).stdout.trim()
    const foreignHooks = path.join(context.sandbox, 'foreign hooks')
    fs.mkdirSync(foreignHooks)
    fs.writeFileSync(path.join(foreignHooks, 'pre-push'), '#!/bin/sh\nexit 0\n')
    git(context, ['config', '--local', 'core.hooksPath', foreignHooks])
    git(context, ['config', '--local', 'push.default', 'current'])
    const configPath = path.join(gitDir, 'config')
    const configBefore = fs.readFileSync(configPath)

    const result = invoke(context, EXPECTED_BRANCH, ['--repair'])
    assert.equal(result.status, EXIT.REPAIR_INCOMPLETE)
    assert.deepEqual(result.json.repairs.changes, [])
    assert.match(result.json.repairs.refusals.join('\n'), /Foreign core\.hooksPath.*zero changes/)
    assert.deepEqual(fs.readFileSync(configPath), configBefore)
    assert.equal(git(context, ['config', '--local', '--get', 'core.hooksPath']).stdout.trim(), foreignHooks)
    assert.equal(fs.readFileSync(path.join(foreignHooks, 'pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n')
    assert.equal(fs.existsSync(path.join(gitDir, 'hooks', 'pre-push')), false)
  })
})

test('repository PASS is distinct from missing command-boundary enforcement', t => {
  const context = makeRepo(t)
  repair(context)

  const withoutBoundary = invoke(context, EXPECTED_BRANCH, [], { boundary: false })
  assert.equal(withoutBoundary.status, EXIT.UNSAFE)
  assert.equal(withoutBoundary.json.repositoryOk, true)
  assert.equal(withoutBoundary.json.commandBoundary.enforced, false)
  assert.equal(withoutBoundary.json.mechanicallyEnforced, false)
  assert.equal(withoutBoundary.json.ok, false)
  assert.equal(withoutBoundary.json.commandBoundary.check.status, 'fail')

  const withBoundary = invoke(context)
  assert.equal(withBoundary.status, EXIT.SAFE)
  assert.equal(withBoundary.json.repositoryOk, true)
  assert.equal(withBoundary.json.commandBoundary.enforced, true)
  assert.equal(withBoundary.json.mechanicallyEnforced, true)
})

test('enforcement proof accepts generation-qualified Codex role tables and rejects hostile quoted tables', t => {
  const context = makeRepo(t)
  repair(context)
  const base = fs.readFileSync(context.profilePath, 'utf8')
  const qualified = `${base}\n[agents."autoprompt-codex-v2-0-0-0123456789abcdef-ap-worker"]\n` +
    'description = "worker"\nconfig_file = "agents/worker.toml"\nexclude = ["*TOKEN*"]\n' +
    '\n[agents."autoprompt-codex-v2-0-0-0123456789abcdef-ap-route-analyst"]\n' +
    'description = "analyst"\nconfig_file = "agents/analyst.toml"\n'
  fs.writeFileSync(context.profilePath, qualified, { mode: 0o600 })
  fs.writeFileSync(context.proofPath, JSON.stringify({
    ...context.enforcementProof,
    profileSha256: crypto.createHash('sha256').update(qualified).digest('hex'),
  }))
  const accepted = invoke(context)
  assert.equal(accepted.status, EXIT.SAFE, accepted.stdout)
  assert.equal(accepted.json.mechanicallyEnforced, true)

  const hostile = `${base}\n[agents."../../escape"]\nconfig_file = "foreign.toml"\n`
  fs.writeFileSync(context.profilePath, hostile, { mode: 0o600 })
  fs.writeFileSync(context.proofPath, JSON.stringify({
    ...context.enforcementProof,
    profileSha256: crypto.createHash('sha256').update(hostile).digest('hex'),
  }))
  const rejected = invoke(context)
  assert.equal(rejected.status, EXIT.UNSAFE)
  assert.ok(rejected.json.residuals.every(item => item.code === 'ENFORCEMENT_PROOF_INVALID'))
  assert.match(rejected.json.residuals[0].message, /Unsupported enforcement profile section/)
})

test('Git and gh isolation remain insufficient when Codex enforcement proof is missing', t => {
  const context = makeRepo(t)
  repair(context)

  const result = invoke(context, EXPECTED_BRANCH, [], { proof: false })
  assert.equal(result.status, EXIT.UNSAFE)
  assert.equal(result.json.repositoryOk, true)
  assert.equal(result.json.gitEnforced, true)
  assert.equal(result.json.channels.githubCliCredentialIsolation.enforced, true)
  assert.equal(result.json.channels.shellOutboundNetworkSandbox.enforced, false)
  assert.equal(result.json.channels.providerConnectorApiWriteToolDenial.enforced, false)
  assert.equal(result.json.mechanicallyEnforced, false)
  assert.deepEqual(
    result.json.residuals.map(item => item.code),
    ['ENFORCEMENT_PROOF_MISSING', 'ENFORCEMENT_PROOF_MISSING'],
  )
})

test('unknown provider enforcement proof is typed unsupported and fails closed', t => {
  const context = makeRepo(t)
  repair(context)
  fs.writeFileSync(context.proofPath, JSON.stringify({
    ...context.enforcementProof,
    provider: 'unknown-provider',
  }))

  const result = invoke(context)
  assert.equal(result.status, EXIT.UNSAFE)
  assert.equal(result.json.gitEnforced, true)
  assert.equal(result.json.channels.githubCliCredentialIsolation.enforced, true)
  assert.equal(result.json.channels.shellOutboundNetworkSandbox.enforced, false)
  assert.equal(result.json.channels.providerConnectorApiWriteToolDenial.enforced, false)
  assert.ok(result.json.residuals.every(item => item.code === 'ENFORCEMENT_PROOF_UNSUPPORTED'))
  assert.equal(result.json.mechanicallyEnforced, false)
})

test('supervisor-style inspection rejects a poisoned fake GH_CONFIG_DIR despite a valid Git boundary', t => {
  const context = makeRepo(t)
  repair(context)
  const poisonedGh = path.join(context.sandbox, 'poisoned gh config')
  fs.mkdirSync(poisonedGh)
  fs.writeFileSync(path.join(poisonedGh, 'hosts.yml'), 'oauth_token: do-not-print\n')
  const unsafeEnvironment = {
    ...boundaryEnvironment(context),
    GH_CONFIG_DIR: poisonedGh,
    GITHUB_AUTH_HEADER: 'do-not-print-header',
  }

  const inspection = inspect(
    discoverRepository(context.repo),
    EXPECTED_BRANCH,
    unsafeEnvironment,
    { enforcementProof: context.enforcementProof },
  )
  assert.equal(inspection.channels.repositoryGitBarrier.enforced, true)
  assert.equal(inspection.channels.gitCommandNetworkBarrier.enforced, true)
  assert.equal(inspection.channels.githubCliCredentialIsolation.enforced, false)
  assert.equal(inspection.channels.githubCliCredentialIsolation.residuals[0].code, 'GH_CONFIG_DIR_UNSAFE')
  assert.equal(inspection.mechanicallyEnforced, false)
  assert.ok(inspection.residuals.some(item => item.channel === 'githubCliCredentialIsolation'))
  assert.doesNotMatch(JSON.stringify(inspection), /do-not-print/)
})

test('CLI emits the complete child environment contract for non-Node controllers', t => {
  const context = makeRepo(t)
  const result = run(process.execPath, [
    CHECKER,
    '--repo', context.repo,
    '--expected-branch', EXPECTED_BRANCH,
    '--emit-child-env',
    '--config-isolation', context.configIsolation,
    '--gh-config-dir', context.ghConfigDir,
    '--json',
  ], { env: context.env })
  assert.equal(result.status, EXIT.SAFE, result.stdout)
  const emitted = JSON.parse(result.stdout)
  assert.equal(emitted.mode, 'emit-child-env')
  assert.equal(emitted.set.GIT_ALLOW_PROTOCOL, 'file')
  assert.equal(emitted.set.GIT_CONFIG_GLOBAL, context.configIsolation)
  assert.equal(emitted.set.GIT_CONFIG_SYSTEM, context.configIsolation)
  assert.equal(emitted.set.GH_CONFIG_DIR, context.ghConfigDir)
  assert.equal(emitted.set.GH_PROMPT_DISABLED, '1')
  assert.ok(Number(emitted.set.GIT_CONFIG_COUNT) > 8)
  assert.ok(emitted.unset.includes('GIT_DIR'))
  assert.ok(emitted.unset.includes('GIT_ASKPASS'))
  assert.ok(emitted.unset.includes('GITHUB_TOKEN'))
})

test('token-bearing environment fails closed and reports names only', t => {
  const context = makeRepo(t)
  repair(context)
  context.env.GITHUB_TOKEN = 'not-for-output'

  const result = invoke(context, EXPECTED_BRANCH, [], { boundary: false })
  assert.equal(result.status, EXIT.UNSAFE)
  assert.deepEqual(
    result.json.channels.githubCliCredentialIsolation.evidence.unexpectedEnvironmentKeys,
    ['GITHUB_TOKEN'],
  )
  assert.doesNotMatch(result.stdout, /not-for-output/)
})

test('usage and non-repository errors have distinct structured exit codes', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt local-only nonrepo '))
  t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
  const isolated = makeEnvironment(path.join(sandbox, 'home'))
  const usage = run(process.execPath, [CHECKER, '--json'], { env: isolated.env })
  assert.equal(usage.status, EXIT.USAGE)
  const usageJson = JSON.parse(usage.stdout)
  assert.equal(usageJson.exitCode, EXIT.USAGE)
  assert.equal(usageJson.error.type, 'UsageError')
  assert.match(usageJson.error.message, /--expected-branch is required/)

  const operational = run(process.execPath, [
    CHECKER, '--repo', sandbox, '--expected-branch', EXPECTED_BRANCH, '--json',
  ], { env: isolated.env })
  assert.equal(operational.status, EXIT.OPERATIONAL_ERROR)
  assert.equal(JSON.parse(operational.stdout).exitCode, EXIT.OPERATIONAL_ERROR)
})

test('test environments discard inherited config injection, repository selectors, and credential state', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt local-only hermetic '))
  t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
  const poisoned = {
    ...process.env,
    GIT_ASKPASS: 'credential-stealer',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.https://example.invalid/.insteadOf',
    GIT_CONFIG_VALUE_0: 'file:///',
    GIT_DIR: 'foreign-repository',
    GIT_SSH_COMMAND: 'foreign-ssh',
    GITHUB_TOKEN: 'foreign-token',
    SSH_AUTH_SOCK: 'foreign-agent',
  }
  const isolated = makeEnvironment(path.join(sandbox, 'home'), poisoned)

  for (const key of [
    'GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_DIR', 'GIT_SSH_COMMAND', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK',
  ]) assert.equal(isolated.env[key], undefined, key)
  assert.equal(isolated.env.GIT_CONFIG_GLOBAL, isolated.configIsolation)
  assert.equal(isolated.env.GIT_CONFIG_SYSTEM, isolated.configIsolation)
  assert.equal(fs.readFileSync(isolated.configIsolation, 'utf8'), '')
})
