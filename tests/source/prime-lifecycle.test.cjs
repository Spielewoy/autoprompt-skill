#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const INSTALL_ROOT = path.join(ROOT, 'scripts', 'install')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const MANIFEST = require('../../agents/manifests/prime-runtime.json')
const OFFICIAL = require('../fixtures/providers/prime/official-v0.7.2-contract.json')
const lifecycle = require('../../scripts/install/prime-lifecycle.cjs')
const settingsHelper = require('../../scripts/install/prime-settings.cjs')

function sandbox(t, name = 'prime-lifecycle') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-${name}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function context(t, name) {
  const temporary = sandbox(t, name)
  const configRoot = path.join(temporary, 'prime-agent-home')
  fs.mkdirSync(configRoot, { recursive: true })
  return {
    temporary,
    configRoot,
    settingsPath: path.join(configRoot, 'settings.json'),
    options: { repoRoot: ROOT, configRoot },
  }
}

function readSettings(target, packageRoot) {
  return settingsHelper.inspect(fs.readFileSync(target), packageRoot, path.dirname(target))
}

function actualFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return actualFiles(target).map(file => `${entry.name}/${file}`)
    }
    return [entry.name]
  }).sort()
}

function treeSnapshot(directory) {
  if (!fs.existsSync(directory)) return null
  const entries = []
  function visit(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: 'directory' })
        visit(target, relative)
      } else if (entry.isFile()) {
        entries.push({
          path: relative,
          type: 'file',
          bytes: fs.readFileSync(target).toString('base64'),
        })
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: relative, type: 'link', target: fs.readlinkSync(target) })
      }
    }
  }
  visit(directory, '')
  return entries
}

function writeSettings(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.from(text, 'utf8'))
}

function linkDirectory(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function unlinkDirectory(link) {
  if (fs.existsSync(link)) fs.unlinkSync(link)
}

function receipt(configRoot) {
  return JSON.parse(fs.readFileSync(path.join(configRoot, lifecycle.RECEIPT_NAME), 'utf8'))
}

function run(command, arguments_, options = {}) {
  return childProcess.spawnSync(command, arguments_, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  })
}

function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function runPowerShellLifecycle(operation, environment, strict = false) {
  const script = path.join(INSTALL_ROOT, `${operation}.ps1`)
  const strictArgument = strict ? ' -Strict' : ''
  const command = `& ${psLiteral(script)} prime${strictArgument}; exit $LASTEXITCODE`
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env: environment })
}

function toBashPath(value) {
  return value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) =>
    `/${drive.toLowerCase()}`)
}

function findBash() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
        'bash',
      ]
    : ['bash']
  return candidates.find(candidate => run(candidate, ['--version']).status === 0) || null
}

function bashPathEnvironment(bin, configRoot, home) {
  const pathEntries = [toBashPath(bin)]
  for (const executable of ['node', process.platform === 'win32' ? 'python' : 'python3']) {
    const found = process.platform === 'win32'
      ? run('where.exe', [executable]).stdout.split(/\r?\n/).filter(Boolean)
      : [run('which', [executable]).stdout.trim()].filter(Boolean)
    for (const candidate of found) pathEntries.push(toBashPath(path.dirname(candidate)))
  }
  pathEntries.push('/usr/bin', '/bin')
  return {
    ...process.env,
    HOME: toBashPath(home),
    USERPROFILE: home,
    AUTOPROMPT_INSTALL_ROOT: configRoot,
    PATH: pathEntries.join(':'),
  }
}

function writePrimeCliFixture(bin, marker) {
  const relative = path.join('node_modules', '@earendil-works', 'pi-coding-agent',
    'dist', 'bundle', 'cli.cjs')
  const cli = path.join(bin, relative)
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, [
    "'use strict'",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const marker = process.env.AUTOPROMPT_TEST_PRIME_MARKER",
    "const mark = value => fs.appendFileSync(marker, `${value}\\n`)",
    "if (process.argv[2] === '--version') { mark('version'); console.error('0.7.2'); process.exit(0) }",
    "if (process.argv[2] === 'package' && process.argv[3] === 'list') {",
    "  if (process.env.AUTOPROMPT_TEST_SECRET) process.exit(90)",
    "  mark('list-attempt')",
    "  if (process.env.AUTOPROMPT_TEST_PRIME_LIST_FAIL) process.exit(93)",
    "  const root = process.env.PRIME_AGENT_CODING_AGENT_DIR",
    "  const packageRoot = path.join(root, 'autoprompt', 'packages', 'prime')",
    "  const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))",
    "  const sources = (settings.packages || []).map(value => typeof value === 'string' ? value : value.source)",
    "  if (!fs.existsSync(packageRoot) || !sources.includes(packageRoot)) process.exit(91)",
    "  mark('list')",
    "  console.log(packageRoot)",
    "  process.exit(0)",
    "}",
    "process.exit(92)",
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(bin, 'prime-agent.cmd'), [
    '@ECHO off',
    `node "%~dp0${relative.replaceAll(path.sep, '\\')}" %*`,
    '',
  ].join('\r\n'))
  const shellExecutable = path.join(bin, 'prime-agent')
  fs.writeFileSync(shellExecutable, [
    '#!/bin/sh',
    'basedir=$(dirname "$0")',
    `exec node "$basedir/${relative.replaceAll(path.sep, '/')}" "$@"`,
    '',
  ].join('\n'))
  fs.chmodSync(shellExecutable, 0o755)
  return { cli, marker }
}

test('Prime root resolution uses exact custom root, then native override, then default', () => {
  const absoluteA = path.resolve('tmp-prime-root-a')
  const absoluteB = path.resolve('tmp-prime-root-b')
  const home = path.resolve('tmp-prime-home')
  assert.equal(lifecycle.resolveConfigRoot({
    env: {
      HOME: home,
      AUTOPROMPT_INSTALL_ROOT: absoluteA,
      PRIME_AGENT_CODING_AGENT_DIR: absoluteB,
    },
  }), absoluteA)
  assert.equal(lifecycle.resolveConfigRoot({
    env: { HOME: home, PRIME_AGENT_CODING_AGENT_DIR: absoluteB },
  }), absoluteB)
  assert.equal(lifecycle.resolveConfigRoot({ env: { HOME: home } }),
    path.join(home, '.prime', 'agent'))
})

test('Prime rejects relative, traversal, filesystem-root, file, and symlink install roots', (t) => {
  assert.throws(() => lifecycle.resolveConfigRoot({ configRoot: 'relative' }), /invalid-install-root/)
  assert.throws(() => lifecycle.resolveConfigRoot({
    configRoot: `${path.resolve('safe')}${path.sep}..${path.sep}unsafe`,
  }), /invalid-install-root/)
  assert.throws(() => lifecycle.resolveConfigRoot({ configRoot: path.parse(ROOT).root }),
    /invalid-install-root/)

  const temporary = sandbox(t, 'prime-unsafe-root')
  const file = path.join(temporary, 'file')
  fs.writeFileSync(file, 'not a directory')
  assert.throws(() => lifecycle.resolveConfigRoot({ configRoot: file }), /invalid-install-root/)

  const link = path.join(temporary, 'link')
  try {
    fs.symlinkSync(temporary, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => lifecycle.resolveConfigRoot({ configRoot: link }), /invalid-install-root/)
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error
  }
})

test('install persistently copies exactly 48 files and minimally edits JSONC settings', (t) => {
  const current = context(t, 'prime-jsonc')
  const original = Buffer.from([
    '{',
    '  // this comment and every unrelated byte stay intact',
    '  "customSentinel": { "preserve": true },',
    '  "packages": [',
    '    "existing-package",',
    '    { "source": "another-package", "skills": ["*"] },',
    '  ],',
    '  "rlmMaxDepth": 1,',
    '}',
    '',
  ].join('\r\n'), 'utf8')
  fs.writeFileSync(current.settingsPath, original)

  const installed = lifecycle.install(current.options)
  assert.equal(installed.status, 'installed')
  const paths = lifecycle.resolvePaths(current.options)
  assert.deepEqual(actualFiles(paths.packageRoot), MANIFEST.files)
  const settings = readSettings(current.settingsPath, paths.packageRoot)
  assert.equal(settings.depth, 4)
  assert.equal(settings.packageMatches.length, 1)
  assert.equal(settings.packages[0], 'existing-package')
  assert.deepEqual(settings.packages[1], { source: 'another-package', skills: ['*'] })
  const installedText = fs.readFileSync(current.settingsPath, 'utf8')
  assert.match(installedText, /this comment and every unrelated byte stay intact/)
  assert.match(installedText, /"customSentinel": \{ "preserve": true \}/)
  assert.ok(installedText.includes('\r\n'))
  assert.equal(receipt(current.configRoot).targetVersion, '0.7.2')
  assert.equal(fs.readFileSync(path.join(current.configRoot,
    lifecycle.SETTINGS_BACKUP_NAME)).equals(original), true)

  const health = lifecycle.doctor(current.options)
  assert.equal(health.files, 48)
  assert.deepEqual(health.resources, { extensions: 1, skills: 1, prompts: 18, personas: 25 })
  assert.deepEqual(health.python, { depth: 4, personas: 25, frameworks: 18 })

  const receiptBefore = fs.readFileSync(path.join(current.configRoot, lifecycle.RECEIPT_NAME))
  const settingsBefore = fs.readFileSync(current.settingsPath)
  const second = lifecycle.install(current.options)
  assert.equal(second.status, 'noop')
  assert.equal(fs.readFileSync(path.join(current.configRoot,
    lifecycle.RECEIPT_NAME)).equals(receiptBefore), true)
  assert.equal(fs.readFileSync(current.settingsPath).equals(settingsBefore), true)

  const removed = lifecycle.uninstall(current.options)
  assert.equal(removed.status, 'uninstalled')
  assert.equal(removed.settings.packageRemoved, true)
  assert.equal(removed.settings.depthRestored, true)
  assert.equal(fs.readFileSync(current.settingsPath).equals(original), true)
  assert.equal(fs.existsSync(paths.packageRoot), false)
  assert.equal(fs.existsSync(path.join(current.configRoot, lifecycle.RECEIPT_NAME)), false)
  assert.equal(fs.existsSync(path.join(current.configRoot,
    lifecycle.SETTINGS_BACKUP_NAME)), false)
})

test('install creates settings when absent and uninstall removes only the created file', (t) => {
  const current = context(t, 'prime-new-settings')
  const paths = lifecycle.resolvePaths(current.options)
  lifecycle.install(current.options)
  const settings = readSettings(current.settingsPath, paths.packageRoot)
  assert.equal(settings.depth, 4)
  assert.equal(settings.packageMatches.length, 1)
  assert.equal(receipt(current.configRoot).settingsInitiallyExisted, false)
  lifecycle.uninstall(current.options)
  assert.equal(fs.existsSync(current.settingsPath), false)
  assert.equal(fs.existsSync(paths.packageRoot), false)
})

test('doctor detects payload and settings tamper, then repair restores exact runtime state', (t) => {
  const current = context(t, 'prime-repair')
  writeSettings(current.settingsPath, '{\n  "custom": true,\n  "packages": [],\n  "rlmMaxDepth": 2\n}\n')
  lifecycle.install(current.options)
  const paths = lifecycle.resolvePaths(current.options)
  fs.appendFileSync(path.join(paths.packageRoot, 'extensions', 'autoprompt.ts'), '\n// tamper\n')
  let text = fs.readFileSync(current.settingsPath, 'utf8')
  text = text.replace('"rlmMaxDepth": 4', '"rlmMaxDepth": 3')
  fs.writeFileSync(current.settingsPath, text)

  assert.throws(() => lifecycle.doctor(current.options), error =>
    error.reason === 'prime-package-hash-mismatch')
  const repaired = lifecycle.repair(current.options)
  assert.equal(repaired.status, 'repaired')
  const health = lifecycle.doctor(current.options)
  assert.equal(health.status, 'healthy')
  assert.equal(readSettings(current.settingsPath, paths.packageRoot).depth, 4)
  assert.equal(receipt(current.configRoot).fullRestoreSafe, false)
})

test('scoped uninstall preserves unrelated edits and restores prior depth when package state is safe', (t) => {
  const current = context(t, 'prime-scoped-safe')
  writeSettings(current.settingsPath,
    '{\n  "custom": "before",\n  "packages": ["existing"],\n  "rlmMaxDepth": 2\n}\n')
  lifecycle.install(current.options)
  const paths = lifecycle.resolvePaths(current.options)
  const changed = fs.readFileSync(current.settingsPath, 'utf8')
    .replace('"custom": "before"', '"custom": "after"')
  fs.writeFileSync(current.settingsPath, changed)

  const removed = lifecycle.uninstall(current.options)
  assert.equal(removed.settings.packageRemoved, true)
  assert.equal(removed.settings.depthRestored, true)
  assert.equal(removed.settings.depthDrift, false)
  const after = settingsHelper.parseDocument(fs.readFileSync(current.settingsPath)).value
  assert.equal(after.custom, 'after')
  assert.deepEqual(after.packages, ['existing'])
  assert.equal(after.rlmMaxDepth, 2)
  assert.equal(fs.existsSync(paths.packageRoot), false)
})

test('scoped uninstall keeps depth 4 when a later package makes restoration ambiguous', (t) => {
  const current = context(t, 'prime-scoped-drift')
  writeSettings(current.settingsPath,
    '{\n  "packages": ["existing"],\n  "rlmMaxDepth": 1\n}\n')
  lifecycle.install(current.options)
  const paths = lifecycle.resolvePaths(current.options)
  const parsed = settingsHelper.parseDocument(fs.readFileSync(current.settingsPath)).value
  parsed.packages.push('later-package')
  parsed.userEdit = true
  fs.writeFileSync(current.settingsPath, `${JSON.stringify(parsed, null, 2)}\n`)

  const removed = lifecycle.uninstall(current.options)
  assert.equal(removed.settings.packageRemoved, true)
  assert.equal(removed.settings.depthRestored, false)
  assert.equal(removed.settings.depthDrift, true)
  const after = settingsHelper.parseDocument(fs.readFileSync(current.settingsPath)).value
  assert.deepEqual(after.packages, ['existing', 'later-package'])
  assert.equal(after.rlmMaxDepth, 4)
  assert.equal(after.userEdit, true)
  assert.equal(fs.existsSync(paths.packageRoot), false)
})

test('failed install rolls package and settings back to the byte-exact prior state', (t) => {
  const current = context(t, 'prime-install-rollback')
  const original = Buffer.from('{\n  "keep": true,\n  "packages": []\n}\n')
  fs.writeFileSync(current.settingsPath, original)
  assert.throws(() => lifecycle.install({
    ...current.options,
    fault(point) {
      if (point === 'after-settings-write') throw new Error('injected-failure')
    },
  }), /injected-failure/)
  const paths = lifecycle.resolvePaths(current.options)
  assert.equal(fs.readFileSync(current.settingsPath).equals(original), true)
  assert.equal(fs.existsSync(paths.packageRoot), false)
  assert.equal(fs.existsSync(paths.receiptPath), false)
  assert.equal(fs.existsSync(paths.settingsBackupPath), false)
  assert.equal(fs.existsSync(paths.lockPath), false)
})

test('failed first install removes a config root that did not exist before the transaction', (t) => {
  const temporary = sandbox(t, 'prime-absent-root-rollback')
  const configRoot = path.join(temporary, 'prime-agent-home')
  assert.equal(fs.existsSync(configRoot), false)
  assert.throws(() => lifecycle.install({
    repoRoot: ROOT,
    configRoot,
    fault(point) {
      if (point === 'after-package-swap') throw new Error('injected-absent-root-failure')
    },
  }), /injected-absent-root-failure/)
  assert.equal(fs.existsSync(configRoot), false)
})

test('failed first install removes every directory it created in a missing root chain', (t) => {
  const temporary = sandbox(t, 'prime-missing-root-chain')
  const firstCreated = path.join(temporary, 'a')
  const configRoot = path.join(firstCreated, 'b', 'prime')
  fs.writeFileSync(path.join(temporary, 'keep.txt'), 'keep\n')
  assert.equal(fs.existsSync(firstCreated), false)
  assert.throws(() => lifecycle.install({
    repoRoot: ROOT,
    configRoot,
    fault(point) {
      if (point === 'after-package-swap') throw new Error('injected-chain-failure')
    },
  }), /injected-chain-failure/)
  assert.equal(fs.existsSync(firstCreated), false)
  assert.equal(fs.readFileSync(path.join(temporary, 'keep.txt'), 'utf8'), 'keep\n')
})

test('failed repair restores the prior tampered package and receipt', (t) => {
  const current = context(t, 'prime-repair-rollback')
  lifecycle.install(current.options)
  const paths = lifecycle.resolvePaths(current.options)
  const target = path.join(paths.packageRoot, 'package.json')
  fs.appendFileSync(target, '\n')
  const tampered = fs.readFileSync(target)
  const receiptBefore = fs.readFileSync(paths.receiptPath)
  assert.throws(() => lifecycle.repair({
    ...current.options,
    fault(point) {
      if (point === 'after-package-swap') throw new Error('injected-repair-failure')
    },
  }), /injected-repair-failure/)
  assert.equal(fs.readFileSync(target).equals(tampered), true)
  assert.equal(fs.readFileSync(paths.receiptPath).equals(receiptBefore), true)
  assert.equal(fs.existsSync(paths.packageBackupPath), false)
})

test('failed first-install host discovery restores the exact pre-install config tree', (t) => {
  const current = context(t, 'prime-discovery-install-rollback')
  const bin = path.join(current.temporary, 'bin')
  const marker = path.join(current.temporary, 'calls.txt')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(current.configRoot, 'keep.txt'), 'keep exact\r\n')
  const fixture = writePrimeCliFixture(bin, marker)
  const before = treeSnapshot(current.configRoot)
  assert.throws(() => lifecycle.install({
    ...current.options,
    primeCli: fixture.cli,
    env: {
      ...process.env,
      AUTOPROMPT_TEST_PRIME_MARKER: marker,
      AUTOPROMPT_TEST_PRIME_LIST_FAIL: '1',
    },
  }), error => error.reason === 'prime-official-discovery-failed')
  assert.deepEqual(treeSnapshot(current.configRoot), before)
})

test('failed repair host discovery restores exact package, settings, receipt, and tree', (t) => {
  const current = context(t, 'prime-discovery-repair-rollback')
  lifecycle.install(current.options)
  const paths = lifecycle.resolvePaths(current.options)
  fs.appendFileSync(path.join(paths.packageRoot, 'package.json'), '\nuser tamper\n')
  fs.appendFileSync(paths.settingsPath, '\n')
  const bin = path.join(current.temporary, 'bin')
  const marker = path.join(current.temporary, 'calls.txt')
  fs.mkdirSync(bin)
  const fixture = writePrimeCliFixture(bin, marker)
  const before = treeSnapshot(current.configRoot)
  assert.throws(() => lifecycle.repair({
    ...current.options,
    primeCli: fixture.cli,
    env: {
      ...process.env,
      AUTOPROMPT_TEST_PRIME_MARKER: marker,
      AUTOPROMPT_TEST_PRIME_LIST_FAIL: '1',
    },
  }), error => error.reason === 'prime-official-discovery-failed')
  assert.deepEqual(treeSnapshot(current.configRoot), before)
})

test('unowned package and backup collisions fail closed without changing settings', (t) => {
  const packageCollision = context(t, 'prime-package-collision')
  const paths = lifecycle.resolvePaths(packageCollision.options)
  fs.mkdirSync(paths.packageRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.packageRoot, 'owner.txt'), 'someone else')
  const original = Buffer.from('{"custom":true}\n')
  fs.writeFileSync(packageCollision.settingsPath, original)
  assert.throws(() => lifecycle.install(packageCollision.options), error =>
    error.reason === 'prime-package-collision')
  assert.equal(fs.readFileSync(packageCollision.settingsPath).equals(original), true)
  assert.equal(fs.readFileSync(path.join(paths.packageRoot, 'owner.txt'), 'utf8'), 'someone else')

  const backupCollision = context(t, 'prime-backup-collision')
  fs.writeFileSync(backupCollision.settingsPath, original)
  fs.writeFileSync(path.join(backupCollision.configRoot,
    lifecycle.SETTINGS_BACKUP_NAME), 'someone else')
  assert.throws(() => lifecycle.install(backupCollision.options), error =>
    error.reason === 'prime-settings-backup-collision')
  assert.equal(fs.readFileSync(backupCollision.settingsPath).equals(original), true)
})

test('install rejects a nested junction or symlink without writing outside the config root', (t) => {
  const current = context(t, 'prime-nested-link-install')
  const outside = path.join(current.temporary, 'outside-install')
  const link = path.join(current.configRoot, 'autoprompt')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside stays intact\n')
  const before = actualFiles(outside)
  linkDirectory(outside, link)
  try {
    assert.throws(() => lifecycle.install(current.options), error =>
      error.reason === 'prime-path-escape')
    assert.deepEqual(actualFiles(outside), before)
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'),
      'outside stays intact\n')
    assert.equal(fs.existsSync(path.join(outside, 'packages')), false)
  } finally {
    unlinkDirectory(link)
  }
})

test('uninstall rejects an ancestor junction swap before settings or outside data change', (t) => {
  const current = context(t, 'prime-junction-swap-uninstall')
  lifecycle.install(current.options)
  const paths = lifecycle.resolvePaths(current.options)
  const managed = path.join(current.configRoot, 'autoprompt')
  const parked = path.join(current.configRoot, 'autoprompt-owned')
  const outside = path.join(current.temporary, 'outside-uninstall')
  const outsidePackage = path.join(outside, 'packages', 'prime')
  const settingsBefore = fs.readFileSync(paths.settingsPath)
  const receiptBefore = fs.readFileSync(paths.receiptPath)
  fs.renameSync(managed, parked)
  fs.mkdirSync(outsidePackage, { recursive: true })
  fs.writeFileSync(path.join(outsidePackage, 'sentinel.txt'), 'do not delete\n')
  linkDirectory(outside, managed)
  try {
    assert.throws(() => lifecycle.uninstall(current.options), error =>
      error.reason === 'prime-path-escape')
    assert.equal(fs.readFileSync(path.join(outsidePackage, 'sentinel.txt'), 'utf8'),
      'do not delete\n')
    assert.equal(fs.readFileSync(paths.settingsPath).equals(settingsBefore), true)
    assert.equal(fs.readFileSync(paths.receiptPath).equals(receiptBefore), true)
  } finally {
    unlinkDirectory(managed)
    fs.renameSync(parked, managed)
  }
})

test('credential-free environment removes secrets and pins the Prime config directory', (t) => {
  const current = context(t, 'prime-clean-environment')
  const paths = lifecycle.resolvePaths(current.options)
  const clean = lifecycle.credentialFreeEnvironment(paths, {
    PATH: process.env.PATH,
    API_KEY: 'secret',
    AUTH_TOKEN: 'secret',
    SAFE_VALUE: 'kept',
  })
  assert.equal(clean.API_KEY, undefined)
  assert.equal(clean.AUTH_TOKEN, undefined)
  assert.equal(clean.SAFE_VALUE, 'kept')
  assert.equal(clean.PRIME_AGENT_CODING_AGENT_DIR, current.configRoot)
  assert.equal(clean.CI, '1')
})

test('PowerShell and Bash entrypoints install, doctor, repair, and uninstall Prime', {
  skip: process.platform !== 'win32',
}, (t) => {
  const bash = findBash()
  assert.ok(bash, 'Git Bash is required')
  for (const port of ['powershell', 'bash']) {
    const temporary = sandbox(t, `prime-${port}-entrypoint`)
    const configRoot = path.join(temporary, 'prime-home')
    const home = path.join(temporary, 'home')
    const bin = path.join(temporary, 'bin')
    const settingsPath = path.join(configRoot, 'settings.json')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(bin, { recursive: true })
    const marker = path.join(temporary, 'prime-cli-calls.txt')
    const original = Buffer.from('{\n  "keep": true,\n  "packages": [],\n  "rlmMaxDepth": 1\n}\n')
    fs.writeFileSync(settingsPath, original)
    writePrimeCliFixture(bin, marker)
    const environment = port === 'powershell'
      ? {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AUTOPROMPT_INSTALL_ROOT: configRoot,
          AUTOPROMPT_TEST_PRIME_MARKER: marker,
          AUTOPROMPT_TEST_SECRET: 'must-not-reach-package-list',
          PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        }
      : {
          ...bashPathEnvironment(bin, configRoot, home),
          AUTOPROMPT_TEST_PRIME_MARKER: marker,
          AUTOPROMPT_TEST_SECRET: 'must-not-reach-package-list',
        }
    const invoke = (operation, strict = false) => port === 'powershell'
      ? runPowerShellLifecycle(operation, environment, strict)
      : run(bash, [path.join(INSTALL_ROOT, `${operation}.sh`),
          ...(strict ? ['--strict'] : []), 'prime'], { env: environment })

    environment.AUTOPROMPT_TEST_PRIME_LIST_FAIL = '1'
    const rejectedInstall = invoke('install')
    assert.notEqual(rejectedInstall.status, 0,
      `${port} accepted install without package discovery\n${rejectedInstall.stdout}\n${rejectedInstall.stderr}`)
    delete environment.AUTOPROMPT_TEST_PRIME_LIST_FAIL

    const installed = invoke('install')
    assert.equal(installed.status, 0, `${port} install\n${installed.stdout}\n${installed.stderr}`)
    assert.match(installed.stdout, /PASS\s+prime\s+dest=/)
    const callsAfterInstall = fs.readFileSync(marker, 'utf8').trim().split('\n')
    assert.ok(callsAfterInstall.includes('list'), `${port} install skipped package discovery`)
    const paths = lifecycle.resolvePaths({ repoRoot: ROOT, configRoot })
    assert.deepEqual(actualFiles(paths.packageRoot), MANIFEST.files)

    const healthy = invoke('doctor', true)
    assert.equal(healthy.status, 0, `${port} doctor\n${healthy.stdout}\n${healthy.stderr}`)
    assert.match(healthy.stdout,
      /^prime\s+yes\s+yes\s+yes\s+version=0\.7\.2 reason=- extras=complete$/m)
    const callsAfterDoctor = fs.readFileSync(marker, 'utf8').trim().split('\n')
    assert.ok(callsAfterDoctor.filter(call => call === 'list').length >
      callsAfterInstall.filter(call => call === 'list').length,
    `${port} strict doctor skipped package discovery`)

    environment.AUTOPROMPT_TEST_PRIME_LIST_FAIL = '1'
    const rejectedDoctor = invoke('doctor', true)
    assert.notEqual(rejectedDoctor.status, 0,
      `${port} strict doctor accepted failed package discovery`)
    assert.match(rejectedDoctor.stdout, /reason=prime-official-discovery-failed/)
    delete environment.AUTOPROMPT_TEST_PRIME_LIST_FAIL

    fs.appendFileSync(path.join(paths.packageRoot, 'package.json'), '\n')
    const broken = invoke('doctor')
    assert.equal(broken.status, 0)
    assert.match(broken.stdout, /^prime\s+yes\s+yes\s+no\s+/m)
    const repaired = invoke('install')
    assert.equal(repaired.status, 0, `${port} repair\n${repaired.stdout}\n${repaired.stderr}`)
    assert.equal(lifecycle.doctor({ repoRoot: ROOT, configRoot }).status, 'healthy')

    const removed = invoke('uninstall')
    assert.equal(removed.status, 0, `${port} uninstall\n${removed.stdout}\n${removed.stderr}`)
    assert.match(removed.stdout, /OK\s+prime\s+removed=48/)
    assert.equal(fs.readFileSync(settingsPath).equals(original), true)
    assert.equal(fs.existsSync(paths.packageRoot), false)
  }
})

test('pinned Prime 0.7.2 CLI discovers the persistent package without credentials', {
  skip: !process.env.AUTOPROMPT_PRIME_OFFICIAL_CLI,
}, (t) => {
  const current = context(t, 'prime-official-cli')
  writeSettings(current.settingsPath, '{\n  "customSentinel": true,\n  "packages": []\n}\n')
  const installed = lifecycle.install({
    ...current.options,
    primeCli: process.env.AUTOPROMPT_PRIME_OFFICIAL_CLI,
  })
  assert.deepEqual(installed.health.official, { version: '0.7.2', listed: true })
  const after = settingsHelper.parseDocument(fs.readFileSync(current.settingsPath)).value
  assert.equal(after.customSentinel, true)
  assert.equal(after.rlmMaxDepth, 4)
})

test('pinned DefaultPackageManager resolves 1 extension, 1 skill, and 18 prompts', {
  skip: !process.env.AUTOPROMPT_PRIME_OFFICIAL_ROOT,
}, (t) => {
  const officialRoot = path.resolve(process.env.AUTOPROMPT_PRIME_OFFICIAL_ROOT)
  const head = childProcess.spawnSync('git', ['-C', officialRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  })
  assert.equal(head.status, 0, head.stderr)
  assert.equal(head.stdout.trim(), OFFICIAL.commit)
  const tsxManifest = require(path.join(officialRoot, 'node_modules', 'tsx', 'package.json'))
  const tsx = path.join(officialRoot, 'node_modules', 'tsx', tsxManifest.bin)
  const current = context(t, 'prime-official-manager')
  lifecycle.install(current.options)
  const paths = lifecycle.resolvePaths(current.options)
  const fixture = path.join(ROOT, 'tests', 'fixtures', 'providers', 'prime', 'official-discovery.ts')
  const completed = childProcess.spawnSync(process.execPath,
    [tsx, fixture, officialRoot, paths.packageRoot], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: lifecycle.credentialFreeEnvironment(paths),
    })
  assert.equal(completed.status, 0, completed.stderr || completed.stdout)
  assert.deepEqual(JSON.parse(completed.stdout.trim()), {
    extensions: 1,
    skills: 1,
    prompts: 18,
    loadedExtensions: 1,
    beforeAgentStartHandlers: 1,
    rawImpersonationDenied: true,
    sealedPersonaLoaded: true,
  })
})
