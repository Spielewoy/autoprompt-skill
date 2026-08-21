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
const PACKAGE_VERSION = require('../../package.json').version
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const GIT_BASH = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash'
const PUBLIC_CLIENTS = [
  'claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime',
  'omp', 'deepseek', 'reasonix',
]
const SHARED_LIFECYCLE_CLIENTS = PUBLIC_CLIENTS.filter(client => client !== 'prime')
const CLIENT_COMMANDS = {
  claude: ['claude', 'Claude Code 2.1.232'],
  codex: ['codex', 'codex-cli 0.101.0'],
  opencode: ['opencode', 'opencode 1.18.18'],
  kilo: ['kilo', 'kilo 7.4.22'],
  vscode: ['code', '1.133.0'],
  omp: ['omp', 'omp/17.4.0'],
  deepseek: ['dsh', '0.1.0-rc.7'],
  reasonix: ['reasonix', 'reasonix v1.30.0']
}
const MANIFESTS = Object.fromEntries(SHARED_LIFECYCLE_CLIENTS.map(client => [
  client,
  JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'manifests', `${client}-runtime.json`),
    'utf8'
  ))
]))

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function makeSyntheticLegacyPackage (sandbox) {
  const packageRoot = path.join(sandbox, 'package')
  for (const directory of ['agents', 'bin', 'scripts']) {
    fs.cpSync(path.join(ROOT, directory), path.join(packageRoot, directory), {
      recursive: true
    })
  }
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(packageRoot, 'package.json'))

  const files = new Map([
    ['SKILL.md', Buffer.from('older Codex skill\n')],
    ['frameworks/README.md', Buffer.from('older framework\n')],
    ['workflow/supervisor.sh', Buffer.from('#!/bin/sh\nexit 0\n')]
  ])
  const names = [...files.keys()].sort()
  const metadata = {
    schemaVersion: 1,
    provider: 'codex',
    directories: ['frameworks', 'workflow'],
    optionalDirectories: [],
    files: names,
    sizes: Object.fromEntries(names.map(name => [name, files.get(name).length])),
    sha256: Object.fromEntries(names.map(name => [name, sha256(files.get(name))]))
  }
  fs.writeFileSync(
    path.join(packageRoot, 'scripts', 'install', 'legacy-codex-compat.json'),
    `${JSON.stringify(metadata, null, 2)}\n`
  )

  return {
    packageRoot,
    writeRoot (root) {
      const skill = path.join(root, 'skills', 'autoprompt')
      for (const [relative, content] of files) {
        const target = path.join(skill, ...relative.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content)
      }
    }
  }
}

function run (command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    ...options
  })
}

function psLiteral (value) {
  return `'${value.replaceAll("'", "''")}'`
}

function bashPath (value) {
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`
  )
}

function shellLiteral (value) {
  return `'${value.replaceAll("'", '\'"\'"\'')}'`
}

function cleanEnvironment (extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.CODEX_HOME
  delete env.AUTOPROMPT_VSCODE_SETTINGS_PATH
  return env
}

function powershellEntry (name, target, strict = false) {
  const entry = path.join(ROOT, 'scripts', 'install', `${name}.ps1`)
  const argument = target === null ? '' : ` ${psLiteral(target)}`
  const strictArgument = strict ? ' -Strict' : ''
  return `& ${psLiteral(entry)}${argument}${strictArgument}; exit $LASTEXITCODE`
}

function assertRejected (completed, reason) {
  assert.notEqual(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(`${completed.stdout}\n${completed.stderr}`, /invalid-install-root/)
  if (reason) assert.match(`${completed.stdout}\n${completed.stderr}`, reason)
}

function writeFakeClients (binDirectory) {
  fs.mkdirSync(binDirectory, { recursive: true })
  for (const [command, version] of Object.values(CLIENT_COMMANDS)) {
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(binDirectory, `${command}.cmd`),
        `@echo off\r\necho ${version}\r\n`
      )
    }
    const shellTarget = path.join(binDirectory, command)
    fs.writeFileSync(shellTarget, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
    fs.chmodSync(shellTarget, 0o755)
  }
}

function makeLifecycleContext (sandbox, client) {
  const home = path.join(sandbox, 'home')
  const xdg = path.join(sandbox, 'xdg')
  const appData = path.join(sandbox, 'appdata')
  const bin = path.join(sandbox, 'bin')
  const customRoot = path.join(sandbox, `${client}-root`)
  const settings = path.join(appData, 'Code', 'User', 'settings.json')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(xdg, { recursive: true })
  fs.mkdirSync(customRoot, { recursive: true })
  writeFakeClients(bin)
  return {
    appData,
    bin,
    customRoot,
    home,
    settings,
    xdg,
    env: cleanEnvironment({
      APPDATA: appData,
      AUTOPROMPT_INSTALL_ROOT: customRoot,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdg,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`
    })
  }
}

function assertManifestInstalled (client, customRoot) {
  const runtimeRoot = path.join(customRoot, 'skills', 'autoprompt')
  for (const relative of MANIFESTS[client].files) {
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, ...relative.split('/'))),
      true,
      `${client}: ${relative}`
    )
  }
}

function matchingFiles (directory, expression) {
  return fs.readdirSync(directory).filter(name => expression.test(name)).sort()
}

function writeLegacyGlobalCodexCast (packageRoot, home) {
  const source = path.join(packageRoot, 'agents', 'codex', 'agents')
  const destination = path.join(home, '.codex', 'agents')
  fs.mkdirSync(destination, { recursive: true })
  for (const name of matchingFiles(source, /^ap-.*\.toml$/)) {
    fs.copyFileSync(path.join(source, name), path.join(destination, name))
  }
  const casting = path.join(
    packageRoot,
    'agents',
    'codex',
    'workflow',
    'codex-agent-casting.js'
  )
  const generated = run(process.execPath, [
    casting,
    '--write-manifest',
    '--agents-dir', destination,
    '--selector', 'off'
  ], {
    env: { ...process.env, CODEX_AGENTS_DIR: destination }
  })
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`)
  return new Map(fs.readdirSync(destination).sort().map(name => [
    name,
    fs.readFileSync(path.join(destination, name))
  ]))
}

function physicalPath (filePath) {
  let cursor = path.resolve(filePath)
  const suffix = []
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  try {
    cursor = fs.realpathSync.native(cursor)
  } catch {}
  return path.join(cursor, ...suffix)
}

function assertCustomLayout (client, customRoot) {
  const skill = path.join(customRoot, 'skills', 'autoprompt')
  assert.equal(fs.existsSync(path.join(skill, 'SKILL.md')), true)
  assertManifestInstalled(client, customRoot)
  switch (client) {
    case 'claude':
      assert.equal(matchingFiles(path.join(customRoot, 'agents'), /^ap-.*\.md$/).length, 25)
      break
    case 'codex':
      assert.equal(
        matchingFiles(path.join(skill, 'agents-runtime'), /^ap-.*\.toml$/).length,
        25
      )
      assert.equal(fs.existsSync(path.join(customRoot, 'autoprompt.config.toml')), true)
      break
    case 'opencode':
      assert.equal(matchingFiles(path.join(customRoot, 'agents'), /^ap-.*\.md$/).length, 25)
      assert.equal(fs.existsSync(path.join(customRoot, 'autoprompt.opencode.json')), true)
      assert.equal(fs.existsSync(path.join(skill, 'workflow', 'launch-opencode.sh')), true)
      assert.equal(fs.existsSync(path.join(skill, 'workflow', 'launch-opencode.ps1')), true)
      break
    case 'kilo':
      assert.equal(matchingFiles(path.join(customRoot, 'agents'), /^ap-.*\.md$/).length, 25)
      assert.equal(fs.existsSync(path.join(customRoot, 'autoprompt.kilo.json')), true)
      break
    case 'vscode':
      assert.equal(
        matchingFiles(path.join(customRoot, 'agents'), /^ap-.*\.agent\.md$/).length,
        25
      )
      break
    case 'omp':
      assert.equal(matchingFiles(path.join(customRoot, 'agents'), /^ap-.*\.md$/).length, 25)
      break
    case 'deepseek':
      assert.equal(fs.existsSync(path.join(
        customRoot,
        '.agent-presets',
        'autoprompt',
        'agent.cordis.yml'
      )), true)
      assert.equal(fs.existsSync(path.join(
        customRoot,
        '.agent-presets',
        'autoprompt',
        'preset.yml'
      )), true)
      break
    case 'reasonix':
      assert.equal(matchingFiles(path.join(customRoot, 'skills'), /^ap-.*$/).length, 25)
      for (const name of matchingFiles(path.join(customRoot, 'skills'), /^ap-.*$/)) {
        assert.equal(fs.existsSync(path.join(customRoot, 'skills', name, 'SKILL.md')), true)
      }
      break
  }
}

function isSameOrWithin (root, candidate) {
  const relative = path.relative(physicalPath(root), physicalPath(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative))
}

function assertReceiptScoped (client, customRoot, settings) {
  const receiptFile = path.join(customRoot, '.autoprompt-install-receipt.json')
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  const receiptPaths = [
    ...(receipt.files || []),
    ...(receipt.createdDirectories || []),
    ...(receipt.configEdits || []).map(edit => edit.file)
  ]
  if (receipt.backup && receipt.backup !== 'none') receiptPaths.push(receipt.backup)
  for (const receiptPath of receiptPaths) {
    if (isSameOrWithin(customRoot, receiptPath)) continue
    assert.equal(client, 'vscode', receiptPath)
    assert.ok(
      path.resolve(receiptPath) === path.resolve(settings) ||
      path.resolve(receiptPath) === path.resolve(`${settings}.autoprompt.bak`),
      receiptPath
    )
  }
  return { receipt, receiptFile }
}

function defaultProviderPaths (context, client) {
  switch (client) {
    case 'claude': return [path.join(context.home, '.claude')]
    case 'codex': return [path.join(context.home, '.codex')]
    case 'opencode': return [path.join(context.xdg, 'opencode')]
    case 'kilo': return [path.join(context.home, '.kilo'), path.join(context.xdg, 'kilo')]
    case 'vscode': return [path.join(context.home, '.copilot')]
    case 'omp': return [path.join(context.home, '.omp', 'agent')]
    case 'deepseek': return [path.join(context.home, '.dsh')]
    case 'reasonix': return [path.join(context.appData, 'reasonix')]
    default: return []
  }
}

function customTamperTarget (client, customRoot) {
  const skill = path.join(customRoot, 'skills', 'autoprompt')
  switch (client) {
    case 'claude': return path.join(customRoot, 'agents', 'ap-manager.md')
    case 'codex': return path.join(skill, 'agents', 'ap-manager.toml')
    case 'opencode': return path.join(customRoot, 'agents', 'ap-manager.md')
    case 'kilo': return path.join(customRoot, 'agents', 'ap-manager.md')
    case 'vscode': return path.join(customRoot, 'agents', 'ap-manager.agent.md')
    case 'omp': return path.join(customRoot, 'agents', 'ap-manager.md')
    case 'deepseek': return path.join(
      customRoot,
      '.agent-presets',
      'autoprompt',
      'agent.cordis.yml'
    )
    case 'reasonix': return path.join(customRoot, 'skills', 'ap-manager', 'SKILL.md')
    default: throw new Error(`unknown client: ${client}`)
  }
}

test('PowerShell resolver treats AUTOPROMPT_INSTALL_ROOT as the exact provider root', {
  skip: process.platform !== 'win32'
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-resolve-ps-'))
  const customRoot = path.join(sandbox, 'provider-root')
  const library = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  const script = [
    `. ${psLiteral(library)}`,
    ...PUBLIC_CLIENTS.map(client =>
      `if (-not (Test-AutopromptInstallRootContract -Target '${client}')) { exit 90 }`),
    ...SHARED_LIFECYCLE_CLIENTS.map(client => [
      `$resolveCode = Resolve-Destination -Name '${client}'`,
      'if ([int]$resolveCode -ne 0) { exit ([int]$resolveCode) }'
    ].join('; '))
  ].join('; ')
  try {
    const completed = run(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], {
      env: cleanEnvironment({
        HOME: path.join(sandbox, 'home'),
        USERPROFILE: path.join(sandbox, 'profile'),
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg'),
        AUTOPROMPT_INSTALL_ROOT: customRoot
      })
    })
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
    const destinations = completed.stdout.match(/dest=([^\r\n]+?) format=/g) || []
    assert.equal(destinations.length, SHARED_LIFECYCLE_CLIENTS.length, completed.stdout)
    const physicalRoot = physicalPath(customRoot)
    for (const record of destinations) {
      assert.match(record, new RegExp(
        `dest=${physicalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
        '[\\\\/]skills[\\\\/]autoprompt[\\\\/]SKILL\\.md format=',
        'i'
      ))
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Git Bash resolver uses the same exact-root contract', {
  skip: !fs.existsSync(GIT_BASH)
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-resolve-sh-'))
  const customRoot = path.join(sandbox, 'provider-root')
  const shellRoot = bashPath(customRoot)
  const probe = [
    'set -u',
    '. scripts/install/lib/install-lib.sh',
    ...PUBLIC_CLIENTS.map(client => `test_autoprompt_install_root_contract '${client}'`),
    ...SHARED_LIFECYCLE_CLIENTS.map(client => [
      `resolve_destination '${client}'`
    ].join('\n'))
  ].join('\n')
  try {
    const completed = run(GIT_BASH, ['-lc', probe], {
      env: cleanEnvironment({
        HOME: bashPath(path.join(sandbox, 'home')),
        USERPROFILE: path.join(sandbox, 'profile'),
        XDG_CONFIG_HOME: bashPath(path.join(sandbox, 'xdg')),
        AUTOPROMPT_INSTALL_ROOT: shellRoot
      })
    })
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
    const lines = completed.stdout.trim().split(/\r?\n/)
    assert.equal(lines.length, SHARED_LIFECYCLE_CLIENTS.length, completed.stdout)
    for (const line of lines) {
      assert.match(line, new RegExp(
        `dest=${shellRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
        '/skills/autoprompt/SKILL\\.md format='
      ))
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell lifecycle entrypoints fail closed for invalid root contracts', {
  skip: process.platform !== 'win32'
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-reject-ps-'))
  const safeRoot = path.join(sandbox, 'provider-root')
  const home = path.join(sandbox, 'home')
  const bin = path.join(sandbox, 'bin')
  writeFakeClients(bin)
  const baseEnv = cleanEnvironment({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(sandbox, 'xdg'),
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`
  })
  const cases = [
    ['install', 'all', safeRoot, /explicit-client-required/],
    ['doctor', null, safeRoot, /explicit-client-required/],
    ['uninstall', 'all', safeRoot, /explicit-client-required/],
    ['install', 'cursor', safeRoot, /client-not-installable/],
    // Windows cannot preserve a zero-length process environment value: it is
    // exposed to the child as unset. Whitespace is the representable empty
    // contract value and exercises the same validation branch.
    ['install', 'claude', ' ', /reason=empty/],
    ['install', 'claude', 'relative/provider-root', /not-absolute/],
    ['install', 'claude', `${sandbox}${path.sep}safe${path.sep}..${path.sep}escape`, /traversal/],
    ['install', 'claude', path.parse(sandbox).root, /filesystem-root-refused/]
  ]
  const sibling = path.join(sandbox, 'keep.txt')
  fs.writeFileSync(sibling, 'keep\n')
  try {
    for (const [entry, target, root, reason] of cases) {
      const completed = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry(entry, target)
      ], { env: { ...baseEnv, AUTOPROMPT_INSTALL_ROOT: root } })
      assertRejected(completed, reason)
      assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep\n')
    }

    const fileRoot = path.join(sandbox, 'not-a-directory')
    fs.writeFileSync(fileRoot, 'user-owned\n')
    const fileRejected = run(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', powershellEntry('install', 'claude')
    ], { env: { ...baseEnv, AUTOPROMPT_INSTALL_ROOT: fileRoot } })
    assertRejected(fileRejected, /not-directory/)
    assert.equal(fs.readFileSync(fileRoot, 'utf8'), 'user-owned\n')

    const junctionTarget = path.join(sandbox, 'junction-target')
    const junctionRoot = path.join(sandbox, 'junction-root')
    fs.mkdirSync(junctionTarget)
    fs.symlinkSync(junctionTarget, junctionRoot, 'junction')
    const junctionRejected = run(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', powershellEntry('install', 'claude')
    ], { env: { ...baseEnv, AUTOPROMPT_INSTALL_ROOT: junctionRoot } })
    assertRejected(junctionRejected, /reparse-root-refused/)

    fs.mkdirSync(safeRoot, { recursive: true })
    const escapedSkills = path.join(sandbox, 'escaped-skills')
    fs.mkdirSync(escapedSkills)
    fs.symlinkSync(escapedSkills, path.join(safeRoot, 'skills'), 'junction')
    const nestedJunctionRejected = run(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', powershellEntry('install', 'claude')
    ], { env: { ...baseEnv, AUTOPROMPT_INSTALL_ROOT: safeRoot } })
    assert.notEqual(
      nestedJunctionRejected.status,
      0,
      `${nestedJunctionRejected.stdout}\n${nestedJunctionRejected.stderr}`
    )
    assert.match(
      `${nestedJunctionRejected.stdout}\n${nestedJunctionRejected.stderr}`,
      /target preflight failed|stage=target-preflight/
    )
    assert.equal(fs.existsSync(path.join(escapedSkills, 'autoprompt')), false)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep\n')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Git Bash lifecycle entrypoints reject all, blocked, empty, relative, and root paths', {
  skip: !fs.existsSync(GIT_BASH)
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-reject-sh-'))
  const safeRoot = bashPath(path.join(sandbox, 'provider-root'))
  const bin = path.join(sandbox, 'bin')
  writeFakeClients(bin)
  const baseEnv = cleanEnvironment({
    HOME: bashPath(path.join(sandbox, 'home')),
    XDG_CONFIG_HOME: bashPath(path.join(sandbox, 'xdg')),
    PATH: `${bashPath(bin)}:/usr/bin:${process.env.PATH || ''}`
  })
  const cases = [
    ['scripts/install/install.sh all', safeRoot, /explicit-client-required/],
    ['scripts/install/doctor.sh', safeRoot, /explicit-client-required/],
    ['scripts/install/uninstall.sh all', safeRoot, /explicit-client-required/],
    ['scripts/install/install.sh cursor', safeRoot, /client-not-installable/],
    ['scripts/install/install.sh claude', '', /reason=empty/],
    ['scripts/install/install.sh claude', 'relative/provider-root', /not-absolute/],
    ['scripts/install/install.sh claude', `${safeRoot}/../escape`, /traversal/],
    ['scripts/install/install.sh claude', '/', /filesystem-root-refused/]
  ]
  try {
    for (const [command, root, reason] of cases) {
      const completed = run(GIT_BASH, ['-lc', `/usr/bin/bash ${command}`], {
        env: { ...baseEnv, AUTOPROMPT_INSTALL_ROOT: root }
      })
      assertRejected(completed, reason)
    }

    const fileRoot = path.join(sandbox, 'not-a-directory')
    fs.writeFileSync(fileRoot, 'user-owned\n')
    const fileRejected = run(GIT_BASH, [
      '-lc', '/usr/bin/bash scripts/install/install.sh claude'
    ], {
      env: {
        ...baseEnv,
        AUTOPROMPT_INSTALL_ROOT: bashPath(fileRoot)
      }
    })
    assertRejected(fileRejected, /not-directory/)
    assert.equal(fs.readFileSync(fileRoot, 'utf8'), 'user-owned\n')

    const junctionTarget = path.join(sandbox, 'junction-target')
    const junctionRoot = path.join(sandbox, 'junction-root')
    fs.mkdirSync(junctionTarget)
    fs.symlinkSync(
      junctionTarget,
      junctionRoot,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const junctionRejected = run(GIT_BASH, [
      '-lc', '/usr/bin/bash scripts/install/install.sh claude'
    ], {
      env: {
        ...baseEnv,
        AUTOPROMPT_INSTALL_ROOT: bashPath(junctionRoot)
      }
    })
    assertRejected(junctionRejected, /symlink-root-refused/)

    const nativeSafeRoot = path.join(sandbox, 'nested-provider-root')
    const escapedSkills = path.join(sandbox, 'escaped-skills')
    fs.mkdirSync(nativeSafeRoot)
    fs.mkdirSync(escapedSkills)
    fs.symlinkSync(
      escapedSkills,
      path.join(nativeSafeRoot, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const nestedJunctionRejected = run(GIT_BASH, [
      '-lc', '/usr/bin/bash scripts/install/install.sh claude'
    ], {
      env: {
        ...baseEnv,
        AUTOPROMPT_INSTALL_ROOT: bashPath(nativeSafeRoot)
      }
    })
    assert.notEqual(
      nestedJunctionRejected.status,
      0,
      `${nestedJunctionRejected.stdout}\n${nestedJunctionRejected.stderr}`
    )
    assert.match(
      `${nestedJunctionRejected.stdout}\n${nestedJunctionRejected.stderr}`,
      /target preflight failed|stage=preflight/
    )
    assert.equal(fs.existsSync(path.join(escapedSkills, 'autoprompt')), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell custom roots complete install, doctor, repair, and uninstall for every provider', {
  skip: process.platform !== 'win32',
  timeout: 600000
}, () => {
  const clients = process.env.AUTOPROMPT_TEST_CUSTOM_ROOT_CLIENT
    ? [process.env.AUTOPROMPT_TEST_CUSTOM_ROOT_CLIENT]
    : SHARED_LIFECYCLE_CLIENTS
  for (const client of clients) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-root-${client}-ps-`))
    const context = makeLifecycleContext(sandbox, client)
    const rootSentinel = path.join(context.customRoot, 'keep-user.txt')
    const siblingSentinel = path.join(sandbox, 'keep-sibling.txt')
    const originalSettings = Buffer.from(
      '{\n  "editor.fontSize": 15,\n' +
      '  "chat.subagents.allowInvocationsFromSubagents": false\n}\n'
    )
    fs.writeFileSync(rootSentinel, 'keep root\n')
    fs.writeFileSync(siblingSentinel, 'keep sibling\n')
    if (client === 'vscode') {
      fs.mkdirSync(path.dirname(context.settings), { recursive: true })
      fs.writeFileSync(context.settings, originalSettings)
    }

    try {
      const installed = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry('install', client)
      ], { env: context.env })
      assert.equal(
        installed.status,
        0,
        `${client} install:\n${installed.stdout}\n${installed.stderr}`
      )
      assertCustomLayout(client, context.customRoot)
      const { receipt, receiptFile } = assertReceiptScoped(
        client,
        context.customRoot,
        context.settings
      )
      assert.equal(fs.existsSync(path.join(
        context.customRoot,
        '.autoprompt-install-hashes.json'
      )), true)
      for (const defaultPath of defaultProviderPaths(context, client)) {
        assert.equal(fs.existsSync(defaultPath), false, `${client}: ${defaultPath}`)
      }

      if (client === 'vscode') {
        assert.match(
          fs.readFileSync(context.settings, 'utf8'),
          /"chat\.subagents\.allowInvocationsFromSubagents": true/
        )
        assert.deepEqual(
          fs.readFileSync(`${context.settings}.autoprompt.bak`),
          originalSettings
        )
      }

      const healthy = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry('doctor', client, true)
      ], { env: context.env })
      assert.equal(
        healthy.status,
        0,
        `${client} doctor:\n${healthy.stdout}\n${healthy.stderr}`
      )
      assert.match(healthy.stdout, new RegExp(`^${client}\\s+yes\\s+yes\\s+yes\\s+`, 'm'))

      const tamperTarget = customTamperTarget(client, context.customRoot)
      fs.appendFileSync(tamperTarget, '\ncustom-root-tamper\n')
      const broken = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry('doctor', client, true)
      ], { env: context.env })
      assert.notEqual(
        broken.status,
        0,
        `${client} tamper doctor:\n${broken.stdout}\n${broken.stderr}`
      )

      const repaired = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry('install', client)
      ], { env: context.env })
      assert.equal(
        repaired.status,
        0,
        `${client} repair:\n${repaired.stdout}\n${repaired.stderr}`
      )
      const repairedDoctor = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry('doctor', client, true)
      ], { env: context.env })
      assert.equal(
        repairedDoctor.status,
        0,
        `${client} repaired doctor:\n${repairedDoctor.stdout}\n${repairedDoctor.stderr}`
      )

      const removed = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry('uninstall', client)
      ], { env: context.env })
      assert.equal(
        removed.status,
        0,
        `${client} uninstall:\n${removed.stdout}\n${removed.stderr}`
      )
      for (const managedFile of receipt.files || []) {
        if (client === 'vscode' && path.resolve(managedFile) === path.resolve(context.settings)) {
          continue
        }
        assert.equal(fs.existsSync(managedFile), false, `${client}: ${managedFile}`)
      }
      assert.equal(fs.existsSync(receiptFile), false)
      assert.equal(fs.existsSync(path.join(
        context.customRoot,
        '.autoprompt-install-hashes.json'
      )), false)
      assert.equal(fs.readFileSync(rootSentinel, 'utf8'), 'keep root\n')
      assert.equal(fs.readFileSync(siblingSentinel, 'utf8'), 'keep sibling\n')
      if (client === 'vscode') {
        assert.deepEqual(fs.readFileSync(context.settings), originalSettings)
        assert.equal(fs.existsSync(`${context.settings}.autoprompt.bak`), false)
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }
})

test('PowerShell leaves an earlier managed snapshot untouched when rollback has no new entries', {
  skip: process.platform !== 'win32'
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-empty-rollback-'))
  const root = path.join(sandbox, 'root')
  const recovery = path.join(sandbox, 'recovery.clixml')
  const library = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  fs.mkdirSync(root, { recursive: true })
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `. ${psLiteral(library)}`,
    `$root = ${psLiteral(root)}`,
    `$recovery = ${psLiteral(recovery)}`,
    "$snapshot = @{ ConfigRoot = $root; ConfigRootExisted = $true; Files = @(); Directories = @{}; ReceiptFiles = @(); ReceiptCreatedDirectories = @(); ReceiptEdits = @(); ConfigEditLastBackup = 'none' }",
    '$snapshot | Export-Clixml -LiteralPath $recovery -Depth 12',
    '$snapshot.RecoveryPath = $recovery',
    '$script:AutopromptManagedUndoJournal = @($snapshot)',
    '$from = $script:AutopromptManagedUndoJournal.Count',
    '$ok = Undo-IdemManagedChanges -FromIndex $from',
    'if (-not $ok -or $script:AutopromptManagedUndoJournal.Count -ne 1 -or -not (Test-Path -LiteralPath $recovery -PathType Leaf)) { exit 1 }'
  ].join('; ')
  try {
    const completed = run(POWERSHELL, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ])
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell upgrades a synthetic receiptless legacy Codex install end to end', {
  skip: process.platform !== 'win32',
  timeout: 360000
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-codex-legacy-ps-'))
  const context = makeLifecycleContext(sandbox, 'codex')
  const legacy = makeSyntheticLegacyPackage(sandbox)
  const cli = path.join(legacy.packageRoot, 'bin', 'autoprompt.cjs')
  const legacyGlobalCast = writeLegacyGlobalCodexCast(
    legacy.packageRoot,
    context.home
  )
  const rootSentinel = path.join(context.customRoot, 'keep-user.txt')
  const peerFile = path.join(context.customRoot, 'agents', 'a.md')
  try {
    legacy.writeRoot(context.customRoot)
    fs.mkdirSync(path.dirname(peerFile), { recursive: true })
    fs.writeFileSync(rootSentinel, 'keep root\n')
    fs.writeFileSync(peerFile, 'keep peer\n')

    const before = run(process.execPath, [
      cli, 'doctor', 'codex', '--strict', '--root', context.customRoot
    ], { env: context.env })
    assert.notEqual(before.status, 0, `${before.stdout}\n${before.stderr}`)
    assert.match(before.stdout, /reason=older-install extras=older-install/)

    const installed = run(process.execPath, [
      cli, 'install', 'codex', '--root', context.customRoot
    ], { cwd: context.home, env: context.env })
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    assertCustomLayout('codex', context.customRoot)
    for (const [name, bytes] of legacyGlobalCast) {
      assert.deepEqual(
        fs.readFileSync(path.join(context.home, '.codex', 'agents', name)),
        bytes,
        name
      )
    }
    assert.equal(fs.readFileSync(rootSentinel, 'utf8'), 'keep root\n')
    assert.equal(fs.readFileSync(peerFile, 'utf8'), 'keep peer\n')
    assert.equal(
      fs.readFileSync(path.join(
        context.customRoot,
        'skills',
        'autoprompt',
        'VERSION'
      ), 'utf8').trim(),
      PACKAGE_VERSION
    )

    const healthy = run(process.execPath, [
      cli, 'doctor', 'codex', '--strict', '--root', context.customRoot
    ], { env: context.env })
    assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`)
    assert.match(healthy.stdout, /^codex\s+yes\s+yes\s+yes\s+/m)

    const driftRoot = path.join(sandbox, 'codex-drift-root')
    legacy.writeRoot(driftRoot)
    const driftFile = path.join(driftRoot, 'skills', 'autoprompt', 'SKILL.md')
    fs.appendFileSync(driftFile, 'local edit\n')
    const refused = run(process.execPath, [
      cli, 'install', 'codex', '--root', driftRoot
    ], { env: context.env })
    assert.notEqual(refused.status, 0, `${refused.stdout}\n${refused.stderr}`)
    assert.match(`${refused.stdout}\n${refused.stderr}`, /unowned-skill-refused/)
    assert.match(fs.readFileSync(driftFile, 'utf8'), /local edit/)
    assert.equal(
      fs.existsSync(path.join(driftRoot, '.autoprompt-install-receipt.json')),
      false
    )

    const rollbackRoot = path.join(sandbox, 'codex-rollback-root')
    const rollbackSkill = path.join(
      rollbackRoot,
      'skills',
      'autoprompt',
      'SKILL.md'
    )
    legacy.writeRoot(rollbackRoot)
    const original = fs.readFileSync(rollbackSkill)
    fs.writeFileSync(path.join(context.bin, 'node.cmd'), [
      '@echo off',
      'echo %~1 | findstr /i /c:"codex-agent-profile.js" >nul',
      'if not errorlevel 1 exit /b 91',
      `"${process.execPath}" %*`,
      ''
    ].join('\r\n'))
    const failed = run(process.execPath, [
      cli, 'install', 'codex', '--root', rollbackRoot
    ], { cwd: context.home, env: context.env })
    assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`)
    assert.match(`${failed.stdout}\n${failed.stderr}`, /stage=agents/)
    assert.doesNotMatch(
      `${failed.stdout}\n${failed.stderr}`,
      /managed-rollback-retained|rollback incomplete/
    )
    assert.deepEqual(fs.readFileSync(rollbackSkill), original)
    assert.equal(
      fs.existsSync(path.join(
        rollbackRoot,
        '.autoprompt-legacy-codex-recovery.clixml'
      )),
      false
    )
    const matched = run(process.execPath, [
      path.join(legacy.packageRoot, 'scripts', 'install', 'legacy-compat.cjs'),
      'match',
      'codex',
      rollbackRoot
    ])
    assert.equal(matched.status, 0, `${matched.stdout}\n${matched.stderr}`)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Git Bash upgrades and rolls back a synthetic receiptless legacy Codex install', {
  skip: !fs.existsSync(GIT_BASH),
  timeout: 480000
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-codex-legacy-sh-'))
  const context = makeLifecycleContext(sandbox, 'codex')
  const legacy = makeSyntheticLegacyPackage(sandbox)
  const install = bashPath(path.join(legacy.packageRoot, 'scripts', 'install', 'install.sh'))
  const shellEntry = shellRoot => [
    `export AUTOPROMPT_INSTALL_ROOT=${shellLiteral(shellRoot)};`,
    `export PATH=${shellLiteral(bashPath(context.bin))}:"$PATH";`,
    '/usr/bin/bash',
    shellLiteral(install),
    'codex'
  ].join(' ')
  const env = cleanEnvironment({
    HOME: bashPath(context.home),
    USERPROFILE: context.home,
    XDG_CONFIG_HOME: bashPath(context.xdg),
    PATH: `${bashPath(context.bin)}:/usr/bin:${process.env.PATH || ''}`
  })
  try {
    legacy.writeRoot(context.customRoot)
    const installed = run(GIT_BASH, [
      '-lc', shellEntry(bashPath(context.customRoot))
    ], { env })
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    assertCustomLayout('codex', context.customRoot)

    const rollbackRoot = path.join(sandbox, 'codex-rollback-root')
    const rollbackSkill = path.join(rollbackRoot, 'skills', 'autoprompt', 'SKILL.md')
    legacy.writeRoot(rollbackRoot)
    const original = fs.readFileSync(rollbackSkill)
    const fakeNode = path.join(context.bin, 'node')
    fs.writeFileSync(fakeNode, [
      '#!/bin/sh',
      'case "$1" in',
      '  *codex-agent-casting.js|*codex-agent-profile.js) exit 91 ;;',
      'esac',
      `exec ${shellLiteral(bashPath(process.execPath))} "$@"`,
      ''
    ].join('\n'))
    fs.chmodSync(fakeNode, 0o755)

    const failed = run(GIT_BASH, [
      '-lc', shellEntry(bashPath(rollbackRoot))
    ], { env })
    assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`)
    assert.match(
      `${failed.stdout}\n${failed.stderr}`,
      /custom-agent profile export failed|stage=agents/
    )
    assert.deepEqual(fs.readFileSync(rollbackSkill), original)
    assert.equal(
      fs.existsSync(path.join(rollbackRoot, '.autoprompt-install-receipt.json')),
      false
    )

    const matched = run(process.execPath, [
      path.join(legacy.packageRoot, 'scripts', 'install', 'legacy-compat.cjs'),
      'match',
      'codex',
      rollbackRoot
    ])
    assert.equal(matched.status, 0, `${matched.stdout}\n${matched.stderr}`)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Git Bash custom Kilo root completes install, doctor, repair, and uninstall', {
  skip: !fs.existsSync(GIT_BASH),
  timeout: 720000
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-kilo-sh-'))
  const context = makeLifecycleContext(sandbox, 'kilo')
  const shellRoot = bashPath(context.customRoot)
  const rootSentinel = path.join(context.customRoot, 'keep-user.txt')
  const siblingSentinel = path.join(sandbox, 'keep-sibling.txt')
  fs.writeFileSync(rootSentinel, 'keep root\n')
  fs.writeFileSync(siblingSentinel, 'keep sibling\n')
  const env = cleanEnvironment({
    AUTOPROMPT_INSTALL_ROOT: shellRoot,
    HOME: bashPath(context.home),
    USERPROFILE: context.home,
    XDG_CONFIG_HOME: bashPath(context.xdg),
    PATH: `${bashPath(context.bin)}:/usr/bin:${process.env.PATH || ''}`
  })
  const shellEntry = (name, strict = false) => [
    `export PATH=${shellLiteral(bashPath(context.bin))}:"$PATH";`,
    '/usr/bin/bash',
    shellLiteral(`scripts/install/${name}.sh`),
    strict ? '--strict' : '',
    'kilo'
  ].filter(Boolean).join(' ')

  try {
    const installed = run(GIT_BASH, ['-lc', shellEntry('install')], { env })
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    assertCustomLayout('kilo', context.customRoot)
    assert.equal(fs.existsSync(path.join(context.home, '.kilo')), false)
    assert.equal(fs.existsSync(path.join(context.xdg, 'kilo')), false)

    const healthy = run(GIT_BASH, ['-lc', shellEntry('doctor', true)], { env })
    assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`)
    assert.match(healthy.stdout, /^kilo\s+yes\s+yes\s+yes\s+/m)

    const mainSkill = path.join(context.customRoot, 'skills', 'autoprompt', 'SKILL.md')
    fs.appendFileSync(
      customTamperTarget('kilo', context.customRoot),
      '\nshell-custom-root-tamper\n'
    )
    const broken = run(GIT_BASH, ['-lc', shellEntry('doctor', true)], { env })
    assert.notEqual(broken.status, 0, `${broken.stdout}\n${broken.stderr}`)

    const repaired = run(GIT_BASH, ['-lc', shellEntry('install')], {
      env,
      timeout: 360000
    })
    assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`)
    const repairedDoctor = run(GIT_BASH, ['-lc', shellEntry('doctor', true)], { env })
    assert.equal(
      repairedDoctor.status,
      0,
      `${repairedDoctor.stdout}\n${repairedDoctor.stderr}`
    )

    const removed = run(GIT_BASH, ['-lc', shellEntry('uninstall')], { env })
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
    assert.equal(fs.existsSync(mainSkill), false)
    assert.equal(fs.existsSync(path.join(context.customRoot, 'agents')), false)
    assert.equal(fs.existsSync(path.join(context.customRoot, 'autoprompt.kilo.json')), false)
    assert.equal(fs.existsSync(path.join(
      context.customRoot,
      '.autoprompt-install-receipt.json'
    )), false)
    assert.equal(fs.readFileSync(rootSentinel, 'utf8'), 'keep root\n')
    assert.equal(fs.readFileSync(siblingSentinel, 'utf8'), 'keep sibling\n')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
