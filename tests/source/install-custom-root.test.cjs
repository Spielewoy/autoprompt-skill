#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { managedCodexPayload } = require('../../scripts/codex-configure.cjs')
const { runOwnedTestProcess, processFailureDetails } = require('../helpers/owned-test-process.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const CODEX_VERSION = fs.readFileSync(path.join(ROOT, 'agents/codex/VERSION'), 'utf8').trim()
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const HAS_POWERSHELL = childProcess.spawnSync(POWERSHELL, [
  '-NoProfile', '-NonInteractive', '-Command', 'exit 0'
], { stdio: 'ignore', timeout: 10000 }).status === 0
const GIT_BASH = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash'
const HAS_BASH = process.platform === 'win32'
  ? fs.existsSync(GIT_BASH)
  : childProcess.spawnSync(GIT_BASH, ['--version'], { stdio: 'ignore' }).status === 0
const PUBLIC_CLIENTS = [
  'claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime',
  'omp', 'deepseek', 'reasonix',
]
const SHARED_LIFECYCLE_CLIENTS = PUBLIC_CLIENTS.filter(client => client !== 'prime')
const CLIENT_COMMANDS = {
  claude: ['claude', 'Claude Code 2.1.232'],
  codex: ['codex', 'codex-cli 0.148.0'],
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
    optionalDirectories: ['workflow/closed-loop'],
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
    writeRoot (root, includeOptional = true) {
      const skill = path.join(root, 'skills', 'autoprompt')
      for (const [relative, content] of files) {
        const target = path.join(skill, ...relative.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content)
      }
      if (includeOptional) fs.mkdirSync(path.join(skill, 'workflow', 'closed-loop'))
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

function powershellInstallerFunctions (packageRoot = ROOT) {
  // Define the real installer functions without executing its lifecycle entrypoint.
  // Their filesystem operations, library journal, and metadata reader stay real.
  return [
    "$ErrorActionPreference = 'Stop'",
    `. ${psLiteral(path.join(packageRoot, 'scripts', 'install', 'lib', 'install-lib.ps1'))}`,
    `$RepoRoot = ${psLiteral(packageRoot)}`,
    `$ScriptDir = ${psLiteral(path.join(packageRoot, 'scripts', 'install'))}`,
    "$LegacyCodexRecoveryName = '.autoprompt-legacy-codex-recovery.clixml'",
    '$tokens = $null; $parseErrors = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(path.join(packageRoot, 'scripts', 'install', 'install.ps1'))}, [ref]$tokens, [ref]$parseErrors)`,
    "if ($parseErrors.Count -ne 0) { throw 'installer parse failure' }",
    '$definitions = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] })',
    'foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }'
  ]
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
  const runtimeRoot = client === 'codex'
    ? path.join(customRoot, '.autoprompt-private', 'bundles', MANIFESTS.codex.payloadGeneration, 'skills', 'autoprompt')
    : path.join(customRoot, 'skills', 'autoprompt')
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
    case 'codex': {
      // Validate the receipt, every manifest hash, external dependency, private
      // profile and cast, rather than mistaking the discovery shim for runtime.
      let payload
      try {
        payload = managedCodexPayload(customRoot)
      } catch (error) {
        // Keep bounded, fixture-only path evidence before cleanup. This does not
        // expose environment values or weaken the original verification error.
        const diagnostics = { requestedRoot: customRoot, physicalRoot: physicalPath(customRoot) }
        try {
          const receipt = JSON.parse(fs.readFileSync(path.join(customRoot, '.autoprompt-install-receipt.json'), 'utf8'))
          diagnostics.receiptPaths = Array.isArray(receipt.files) ? receipt.files.slice(0, 3) : []
          const hashes = JSON.parse(fs.readFileSync(path.join(customRoot, '.autoprompt-install-hashes.json'), 'utf8'))
          diagnostics.hashKeys = Object.keys(hashes).slice(0, 3)
        } catch {}
        error.message += `\nFixture path evidence: ${JSON.stringify(diagnostics).slice(0, 4096)}`
        throw error
      }
      assert.equal(payload.payloadGeneration, MANIFESTS.codex.payloadGeneration)
      assert.deepEqual(fs.readdirSync(skill), ['SKILL.md'])
      const policy = JSON.parse(fs.readFileSync(path.join(payload.skillRoot, 'agents', 'role-policy.json'), 'utf8'))
      assert.deepEqual(
        matchingFiles(path.join(payload.skillRoot, 'agents-runtime'), /^ap-.*\.toml$/),
        Object.keys(policy.physical_roles).map(role => `${role}.toml`).sort()
      )
      assert.equal(fs.readFileSync(path.join(payload.skillRoot, 'VERSION'), 'utf8').trim(), CODEX_VERSION)
      return payload
    }
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

function assertCustomDoctor (client, completed) {
  const output = `${completed.stdout}\n${completed.stderr}`
  if (client === 'codex' && process.platform === 'win32') {
    assert.equal(completed.status, 1, output)
    assert.match(completed.stdout, /^codex\s+yes\s+yes\s+no\s+.*reason=codex-windows-sandbox-identity-unavailable extras=complete.*activation=unavailable/m)
  } else {
    assert.equal(completed.status, 0, output)
    assert.match(completed.stdout, new RegExp(`^${client}\\s+yes\\s+yes\\s+yes\\s+`, 'm'))
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
    // The Bash installer preserves MSYS drive spelling in its receipt. Resolve
    // that spelling before the independent physical-root containment check;
    // a different drive/root still fails, and other providers are unchanged.
    const candidate = client === 'codex' && process.platform === 'win32'
      ? receiptPath.replace(/^\/([A-Za-z])(?=\/)/, '$1:')
      : receiptPath
    if (isSameOrWithin(customRoot, candidate)) continue
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
    case 'codex': return path.join(customRoot, '.autoprompt-private', 'bundles',
      MANIFESTS.codex.payloadGeneration, 'skills', 'autoprompt', 'agents', 'ap-manager.toml')
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
      assertCustomDoctor(client, healthy)

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
      if (client === 'codex') {
        assert.match(broken.stdout, /extras=invalid:installed-hash-mismatch:/)
      }

      const repaired = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry('install', client)
      ], { env: context.env })
      assert.equal(
        repaired.status,
        0,
        `${client} repair:\n${repaired.stdout}\n${repaired.stderr}`
      )
      if (client === 'codex') assertCustomLayout(client, context.customRoot)
      const repairedDoctor = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', powershellEntry('doctor', client, true)
      ], { env: context.env })
      assertCustomDoctor(client, repairedDoctor)

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

test('PowerShell receiptless legacy cleanup prunes only empty owned parents and restores them on rollback', {
  skip: process.platform !== 'win32' && !HAS_POWERSHELL,
  timeout: 30000
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-legacy-prune-ps-'))
  const root = path.join(sandbox, 'root')
  const skill = path.join(root, 'skills', 'autoprompt')
  const outside = path.join(sandbox, 'outside')
  const owned = new Map([
    ['SKILL.md', 'old skill\n'],
    ['frameworks/nested/old.md', 'old framework\n'],
    ['workflow/old.ps1', 'old workflow\n'],
    ['with-user/old.md', 'old beside user\n'],
    ['with-hidden/old.md', 'old beside hidden\n'],
    ['with-link/old.md', 'old beside link\n']
  ].map(([relative, bytes]) => [path.join(skill, ...relative.split('/')), bytes]))
  const kept = new Map([
    [path.join(skill, 'with-user', 'user.txt'), 'keep visible\n'],
    [path.join(skill, 'with-hidden', '.user-data'), 'keep hidden\n'],
    [path.join(outside, 'sentinel.txt'), 'keep linked target\n']
  ])
  try {
    for (const [file, bytes] of [...owned, ...kept]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
    }
    fs.mkdirSync(path.join(skill, 'unlisted-empty'))
    const linked = path.join(skill, 'with-link', 'user-link')
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const script = [
      ...powershellInstallerFunctions(),
      `$root = ${psLiteral(root)}; $skill = ${psLiteral(skill)}`,
      `$script:AutopromptReceiptFiles = @(${[...owned.keys()].map(psLiteral).join(', ')})`,
      ...(process.platform === 'win32' ? [
        `[System.IO.File]::SetAttributes(${psLiteral(path.join(skill, 'with-hidden', '.user-data'))}, [System.IO.FileAttributes]::Hidden)`
      ] : []),
      '$code = Remove-LegacyCodexSkillPayload -Root $root',
      '$after = @([System.IO.Directory]::GetFileSystemEntries($skill) | ForEach-Object { [System.IO.Path]::GetFileName($_) } | Sort-Object)',
      `$ownedRemaining = @(@(${[...owned.keys()].map(psLiteral).join(', ')}) | Where-Object { Test-Path -LiteralPath $_ })`,
      '$recoveries = @($script:AutopromptManagedUndoJournal | ForEach-Object { $_.RecoveryPath })',
      '$undo = Undo-IdemManagedChanges',
      '$remainingRecovery = @($recoveries | Where-Object { Test-Path -LiteralPath $_ })',
      `$script:AutopromptReceiptFiles = @(${psLiteral(path.join(linked, 'sentinel.txt'))})`,
      '$linkedCode = Remove-LegacyCodexSkillPayload -Root $root',
      '[ordered]@{ code = $code; after = $after; ownedRemaining = $ownedRemaining; rollback = $undo; linkedCode = $linkedCode; journalCount = $script:AutopromptManagedUndoJournal.Count; remainingRecovery = $remainingRecovery } | ConvertTo-Json -Compress -Depth 4'
    ].join('; ')
    const completed = run(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ])
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
    const observed = JSON.parse(completed.stdout)
    assert.equal(observed.code, 0)
    assert.deepEqual(observed.ownedRemaining, [])
    assert.deepEqual(observed.after, ['unlisted-empty', 'with-hidden', 'with-link', 'with-user'])
    assert.equal(observed.rollback, true)
    assert.equal(observed.linkedCode, 93, 'a listed path through a linked parent is refused before deletion')
    assert.equal(observed.journalCount, 0)
    assert.deepEqual(observed.remainingRecovery, [])
    for (const [file, bytes] of [...owned, ...kept]) assert.equal(fs.readFileSync(file, 'utf8'), bytes, file)
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'the user link must not be removed or replaced')
    assert.equal(fs.realpathSync.native(linked), fs.realpathSync.native(outside))
    assert.equal(fs.statSync(path.join(skill, 'frameworks', 'nested')).isDirectory(), true)
    assert.equal(fs.statSync(path.join(skill, 'workflow')).isDirectory(), true)
    assert.equal(fs.statSync(path.join(skill, 'unlisted-empty')).isDirectory(), true)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell receiptless legacy optional directories are snapshot-bound across rollback and interrupted recovery', {
  skip: process.platform !== 'win32' && !HAS_POWERSHELL,
  // Overall bound for four real transaction probes and ownership matching;
  // t.signal aborts the current owned process if their combined work exceeds it.
  timeout: 600000
}, async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-legacy-optional-ps-'))
  const binding = { pendingProcesses: new Set() }
  // t.diagnostic buffers until completion; these bounded JSON lines must stream.
  const diagnostic = message => process.stderr.write(`AUTOPROMPT_OPTIONAL_PROGRESS:${message}\n`)
  try {
    const legacy = makeSyntheticLegacyPackage(sandbox)
    for (const present of [true, false]) {
      for (const mode of ['rollback', 'interrupted']) {
        const root = path.join(sandbox, `root-${present}-${mode}`)
        const skill = path.join(root, 'skills', 'autoprompt')
        const optional = path.join(skill, 'workflow', 'closed-loop')
        // Exercise the real caller boundary on every host, including where
        // os.tmpdir() has no Windows short-name alias of its own.
        const requestedRoot = present && mode === 'rollback' ? `${root}${path.sep}.` : root
        legacy.writeRoot(root, present)
        const before = new Map(['SKILL.md', 'frameworks/README.md', 'workflow/supervisor.sh'].map(relative => {
          const file = path.join(skill, ...relative.split('/'))
          return [file, fs.readFileSync(file)]
        }))
        const progressPrefix = 'AUTOPROMPT_TEST_PHASE:'
        const expectedProgress = []
        const mark = phase => {
          expectedProgress.push(phase)
          return `[Console]::Error.WriteLine(${psLiteral(progressPrefix + phase)})`
        }
        const script = [
          mark('functions-import-start'),
          ...powershellInstallerFunctions(legacy.packageRoot),
          mark('functions-import-done'),
          `$requestedRoot = ${psLiteral(requestedRoot)}`,
          '$env:AUTOPROMPT_INSTALL_ROOT = $requestedRoot',
          "if (-not (Test-AutopromptInstallRootContract -Target 'codex')) { throw 'fixture root rejected' }",
          // Match Install-Batch before invoking internal transaction functions.
          "$root = Get-IdemNormalizedPath -Path (Get-ConfigRoot -Client 'codex')",
          "$skill = Join-Path $root 'skills/autoprompt'; $optional = Join-Path $skill 'workflow/closed-loop'",
          mark('ownership-start'),
          '$receipt = Get-LegacyCodexOwnershipState -Root $root',
          "if ($null -eq $receipt -or -not $receipt.Legacy) { throw 'real legacy metadata match failed' }",
          '$state = Set-RootReceiptAccumulators -Receipt $receipt',
          mark('ownership-done'),
          mark('plan-start'),
          "$targets = @(Get-ClientInstallTargetPlan -Client 'codex')",
          "if ($targets.Count -eq 0) { throw 'real target plan missing' }",
          mark('plan-done'),
          ...(present && mode === 'rollback' ? [
            mark('failed-write-start'),
            '$beforeFailureBytes = @{}; foreach ($file in $receipt.Files) { $beforeFailureBytes[$file] = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($file)) }',
            '$script:RealRecoveryWriter = (Get-Command Write-IdemManagedRecovery).ScriptBlock',
            '$script:FailedWritePaths = @()',
            'function Write-IdemManagedRecovery { param([hashtable]$Snapshot, [string]$RecoveryPath) $script:FailedWritePaths += $RecoveryPath; if ($RecoveryPath -eq (Join-Path $root $LegacyCodexRecoveryName)) { return $false }; return (& $script:RealRecoveryWriter -Snapshot $Snapshot -RecoveryPath $RecoveryPath) }',
            '$writeFailed = $false',
            'try { Start-RootTransaction -Root $root -State $state -Targets $targets } catch { $writeFailed = $true }',
            '$failedWriteClean = $script:AutopromptManagedUndoJournal.Count -eq 0 -and @($script:FailedWritePaths | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0',
            '$failedWriteFilesRemain = @($receipt.Files | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) -or [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($_)) -cne $beforeFailureBytes[$_] }).Count -eq 0',
            'Set-Item Function:Write-IdemManagedRecovery -Value $script:RealRecoveryWriter',
            mark('failed-write-done')
          ] : []),
          mark('transaction-start'),
          'Start-RootTransaction -Root $root -State $state -Targets $targets',
          mark('transaction-done'),
          '$snapshot = $script:AutopromptManagedUndoJournal[0]',
          mark('snapshot-import-start'),
          '$durable = Import-Clixml -LiteralPath $snapshot.RecoveryPath',
          mark('snapshot-import-done'),
          mark('validator-current-start'),
          '$valid = Test-LegacyCodexRecoverySnapshot -Snapshot $durable -Root $root',
          mark('validator-current-done'),
          '$validationDetails = $null',
          'if (-not $valid) { $validationDetails = [ordered]@{ requestedRoot = $requestedRoot; transactionRoot = $root; snapshotRoot = [string]$durable.ConfigRoot; fileCount = @($durable.Files).Count; uniqueFileCount = @(Get-UniqueReceiptPaths -Paths @($durable.Files | ForEach-Object { $_.Path })).Count; targetCount = $targets.Count; directoryCount = $durable.Directories.Count; firstReceiptPaths = @($durable.ReceiptFiles | Select-Object -First 3); firstSnapshotPaths = @($durable.Files | Select-Object -First 3 | ForEach-Object { $_.Path }); firstTargets = @($targets | Select-Object -First 3) } }',
          '$optionalRecorded = $durable.Directories.ContainsKey($optional)',
          '$optionalExisted = $durable.Directories[$optional]',
          ...(present && mode === 'rollback' ? [
            '[void]$durable.Directories.Remove($optional)',
            mark('validator-old-start'),
            '$oldAccepted = Test-LegacyCodexRecoverySnapshot -Snapshot $durable -Root $root',
            mark('validator-old-done'),
            '$durable.Directories[$optional] = $optionalExisted',
            "$foreign = Join-Path $root 'foreign-unowned-directory'",
            '$durable.Directories[$foreign] = $true',
            mark('validator-foreign-start'),
            '$foreignRejected = -not (Test-LegacyCodexRecoverySnapshot -Snapshot $durable -Root $root)',
            mark('validator-foreign-done'),
            '[void]$durable.Directories.Remove($foreign)',
            "$required = Join-Path $skill 'frameworks'",
            '$requiredExisted = $durable.Directories[$required]; [void]$durable.Directories.Remove($required)',
            mark('validator-required-start'),
            '$requiredRejected = -not (Test-LegacyCodexRecoverySnapshot -Snapshot $durable -Root $root)',
            mark('validator-required-done'),
            '$durable.Directories[$required] = $requiredExisted',
            "$durable.Directories[$optional] = 'false'",
            mark('validator-boolean-start'),
            '$nonBooleanRejected = -not (Test-LegacyCodexRecoverySnapshot -Snapshot $durable -Root $root)',
            mark('validator-boolean-done'),
            '$durable.Directories[$optional] = $optionalExisted'
          ] : []),
          mark('mutation-start'),
          '$code = Remove-LegacyCodexSkillPayload -Root $root',
          mark('mutation-done'),
          '$after = @([System.IO.Directory]::GetFileSystemEntries($skill))',
          '$recoveries = @($script:AutopromptManagedUndoJournal | ForEach-Object { $_.RecoveryPath })',
          mark('restore-start'),
          mode === 'rollback'
            ? '$restored = Undo-IdemManagedChanges'
            : '$restored = Restore-InterruptedLegacyCodexMigration -Root $root',
          mark('restore-done'),
          // Interrupted recovery deliberately uses only the durable root snapshot.
          // Dispose separately created test-operation journals after restoration.
          mark('cleanup-start'),
          'foreach ($recovery in $recoveries) { if (-not (Remove-IdemRecoveryPath -Path $recovery)) { throw "fixture recovery cleanup failed" } }',
          '$remainingRecovery = @($recoveries | Where-Object { Test-Path -LiteralPath $_ })',
          mark('cleanup-done'),
          '[ordered]@{ valid = $valid; validationDetails = $validationDetails; transactionRoot = $root; optionalPath = $optional; optionalRecorded = $optionalRecorded; optionalExisted = $optionalExisted; oldAccepted = $oldAccepted; foreignRejected = $foreignRejected; requiredRejected = $requiredRejected; nonBooleanRejected = $nonBooleanRejected; writeFailed = $writeFailed; failedWriteClean = $failedWriteClean; failedWriteFilesRemain = $failedWriteFilesRemain; code = $code; after = $after; restored = $restored; remainingRecovery = $remainingRecovery } | ConvertTo-Json -Compress -Depth 4'
        ].join('; ')
        const completed = await runOwnedTestProcess(POWERSHELL, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
        ], {
          binding, phase: `optional-${present}-${mode}`, signal: t.signal, cwd: ROOT,
          timeout: process.platform === 'win32' ? 120000 : 30000,
          warnAfter: process.platform === 'win32' ? 60000 : undefined,
          progressPrefix, diagnostic,
        })
        assert.equal(completed.status, 0, processFailureDetails(completed))
        assert.equal(completed.cleanupConfirmed, true, processFailureDetails(completed))
        assert.deepEqual(completed.stderr.split(/\r?\n/u).filter(line => line.startsWith(progressPrefix))
          .map(line => line.slice(progressPrefix.length)), expectedProgress, 'every real phase must complete exactly once')
        const observed = JSON.parse(completed.stdout)
        assert.equal(observed.valid, true,
          `${present}/${mode}: real durable recovery validator ${JSON.stringify(observed.validationDetails).slice(0, 4096)}`)
        assert.equal(physicalPath(observed.transactionRoot), physicalPath(root), 'caller normalization preserves the physical fixture root')
        assert.equal(physicalPath(observed.optionalPath), physicalPath(optional), 'optional-directory identity remains bound to that root')
        if (present && mode === 'rollback') assert.notEqual(observed.transactionRoot, requestedRoot,
          'the deliberate lexical alias must cross the real caller normalization boundary')
        assert.equal(observed.optionalRecorded, true, `${present}/${mode}: optional path must be explicitly snapshot-bound`)
        assert.equal(observed.optionalExisted, present)
        if (present && mode === 'rollback') {
          assert.equal(observed.oldAccepted, true, 'older snapshots without optional keys remain valid')
          assert.equal(observed.foreignRejected, true, 'foreign directory keys remain forbidden')
          assert.equal(observed.requiredRejected, true, 'required directory keys cannot be omitted')
          assert.equal(observed.nonBooleanRejected, true, 'optional presence must be a boolean')
          assert.equal(observed.writeFailed, true, 'durable snapshot write failure must throw before migration')
          assert.equal(observed.failedWriteClean, true, 'failed snapshot publication leaves no journal or recovery residue')
          assert.equal(observed.failedWriteFilesRemain, true, 'failed snapshot publication leaves owned files intact')
        }
        assert.equal(observed.code, 0)
        assert.deepEqual(observed.after, [])
        assert.equal(observed.restored, true)
        assert.deepEqual(observed.remainingRecovery, [])
        for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, file)
        assert.equal(fs.existsSync(optional), present, `${present}/${mode}: restore exact optional-directory presence`)
        if (present) assert.deepEqual(fs.readdirSync(optional), [])
        const matched = await runOwnedTestProcess(process.execPath, [
          path.join(legacy.packageRoot, 'scripts', 'install', 'legacy-compat.cjs'), 'match', 'codex', root
        ], { binding, phase: `ownership-match-${present}-${mode}`, signal: t.signal, cwd: ROOT,
          timeout: 180000, diagnostic })
        assert.equal(matched.status, 0, processFailureDetails(matched))
      }
    }
  } finally {
    await Promise.all([...binding.pendingProcesses].map(owner => owner.settled))
    assert.equal(binding.pendingProcesses.size, 0,
      `optional fixture retained because owned cleanup is unconfirmed: ${sandbox}`)
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
  const invoke = (command, root, strict = false) => run(process.execPath, [
    cli, command, 'codex', ...(strict ? ['--strict'] : []), '--root', root
  ], { cwd: context.home, env: context.env })
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

    const before = invoke('doctor', context.customRoot, true)
    assert.notEqual(before.status, 0, `${before.stdout}\n${before.stderr}`)
    assert.match(before.stdout, /reason=older-install extras=older-install/)

    const installed = invoke('install', context.customRoot)
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    const payload = assertCustomLayout('codex', context.customRoot)
    assertReceiptScoped('codex', context.customRoot, context.settings)
    for (const [name, bytes] of legacyGlobalCast) {
      assert.deepEqual(
        fs.readFileSync(path.join(context.home, '.codex', 'agents', name)),
        bytes,
        name
      )
    }
    assert.equal(fs.readFileSync(rootSentinel, 'utf8'), 'keep root\n')
    assert.equal(fs.readFileSync(peerFile, 'utf8'), 'keep peer\n')
    const healthy = invoke('doctor', context.customRoot, true)
    assertCustomDoctor('codex', healthy)
    assert.equal(fs.existsSync(path.join(context.customRoot, 'cap_sid')), false)
    const gates = path.join(payload.skillRoot, 'GATES.md')
    const gatesBytes = fs.readFileSync(gates)
    fs.appendFileSync(gates, '\nprivate runtime drift\n')
    assert.throws(() => managedCodexPayload(context.customRoot), /managed-payload-drift/)
    fs.writeFileSync(gates, gatesBytes)
    assertCustomLayout('codex', context.customRoot)

    const driftRoot = path.join(sandbox, 'codex-drift-root')
    legacy.writeRoot(driftRoot)
    const driftFile = path.join(driftRoot, 'skills', 'autoprompt', 'SKILL.md')
    fs.appendFileSync(driftFile, 'local edit\n')
    const refused = invoke('install', driftRoot)
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
    const failed = invoke('install', rollbackRoot)
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

test('Bash upgrades and rolls back a synthetic receiptless legacy Codex install', {
  skip: !HAS_BASH,
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
    const payload = assertCustomLayout('codex', context.customRoot)
    const { receipt } = assertReceiptScoped('codex', context.customRoot, context.settings)
    assert.ok(receipt.files.every(file => path.isAbsolute(file)), 'receipt file paths are absolute; v5 hash keys may be relative')
    const gates = path.join(payload.skillRoot, 'GATES.md')
    const gatesBytes = fs.readFileSync(gates)
    fs.appendFileSync(gates, '\nprivate runtime drift\n')
    assert.throws(() => managedCodexPayload(context.customRoot), /managed-payload-drift/)
    fs.writeFileSync(gates, gatesBytes)
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
