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
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const INSTALL_DIR = path.join(ROOT, 'scripts', 'install')
const PUBLIC = [
  'claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime',
  'omp', 'deepseek', 'reasonix',
]
const LEGACY = ['vibe', 'cursor', 'dcode', 'roo', 'gemini', 'cline', 'goose']
const BINARIES = Object.freeze({
  cursor: 'cursor-agent',
  dcode: 'dcode',
  roo: 'roo',
  gemini: 'gemini',
  cline: 'cline',
  goose: 'goose',
})

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  })
}

const { resolveBash } = require('../helpers/resolve-bash.cjs')
function findBash() {
  // resolveBash probes Program Files (including D:) and returns a real Git Bash
  // path on Windows; it never returns the WSL stub 'C:\Windows\system32\bash.exe'.
  const resolved = resolveBash()
  return resolved === 'bash' && process.platform === 'win32'
    ? null
    : resolved
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function toBash(value) {
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-compatibility-'))
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  fs.writeFileSync(path.join(home, 'sentinel.txt'), 'unchanged\n')
  for (const binary of Object.values(BINARIES)) {
    fs.writeFileSync(
      path.join(bin, `${binary}.cmd`),
      '@echo off\r\necho 9.9.9\r\n',
    )
    const shell = path.join(bin, binary)
    fs.writeFileSync(shell, "#!/bin/sh\nprintf '9.9.9\\n'\n")
    fs.chmodSync(shell, 0o755)
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const safeWindowsPath = [
    bin,
    path.join(systemRoot, 'System32'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter)
  return {
    root,
    home,
    bin,
    psEnv: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      PATH: safeWindowsPath,
    },
  }
}

function treeDigest(root) {
  const rows = []
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`)
        visit(absolute)
      } else {
        const digest = crypto.createHash('sha256')
          .update(fs.readFileSync(absolute)).digest('hex')
        rows.push(`f:${relative}:${digest}`)
      }
    }
  }
  visit(root)
  return rows.sort()
}

function runPowerShellScript(name, target, env) {
  const script = path.join(INSTALL_DIR, `${name}.ps1`)
  const command = `& ${powershellLiteral(script)} ${powershellLiteral(target)}; exit $LASTEXITCODE`
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env })
}

function runShellScript(bash, name, target, context) {
  const script = toBash(path.join(INSTALL_DIR, `${name}.sh`))
  const command = [
    `export HOME='${toBash(context.home)}'`,
    `export XDG_CONFIG_HOME='${toBash(path.join(context.home, '.config'))}'`,
    `export PATH='${toBash(context.bin)}:/usr/bin:/bin'`,
    `/usr/bin/bash '${script}' '${target}'`,
  ].join('; ')
  return run(bash, ['--noprofile', '--norc', '-c', command])
}

function combined(result) {
  return `${result.stdout}\n${result.stderr}`
}

function writeLegacySharedReceipt(home, flavor) {
  const claude = path.join(home, '.claude', 'skills', 'autoprompt', 'SKILL.md')
  const cursor = path.join(home, '.cursor', 'skills', 'autoprompt', 'SKILL.md')
  fs.mkdirSync(path.dirname(claude), { recursive: true })
  fs.mkdirSync(path.dirname(cursor), { recursive: true })
  fs.writeFileSync(claude, 'claude-owned\n')
  fs.writeFileSync(cursor, 'legacy-cursor-owned\n')
  const receiptPath = path.join(home, '.autoprompt-install-receipt.json')
  const receipt = {
    nonce: 'compatibility-test',
    backup: null,
    files: flavor === 'shell'
      ? [toBash(claude), toBash(cursor)]
      : [claude, cursor],
    createdDirectories: [],
    configEdits: [],
  }
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  return { claude, cursor, receiptPath }
}

test('both ports declare exactly nine public install providers and no generic payload fallback', () => {
  const shellLib = fs.readFileSync(path.join(INSTALL_DIR, 'lib', 'install-lib.sh'), 'utf8')
  const psLib = fs.readFileSync(path.join(INSTALL_DIR, 'lib', 'install-lib.ps1'), 'utf8')
  const shellInstall = fs.readFileSync(path.join(INSTALL_DIR, 'install.sh'), 'utf8')
  const psInstall = fs.readFileSync(path.join(INSTALL_DIR, 'install.ps1'), 'utf8')
  const shellRegistry = shellLib.match(/declare -A AUTOPROMPT_PROVIDER_STATUS=\([\s\S]*?^\)/m)?.[0] ?? ''
  const psRegistry = psLib.match(/\$AutopromptProviderStatus = @\{[\s\S]*?^\}/m)?.[0] ?? ''
  for (const provider of PUBLIC) {
    assert.match(shellRegistry, new RegExp(`\\[${provider}\\]=supported`), provider)
    assert.match(psRegistry, new RegExp(`\\b${provider}\\s*=\\s*'supported'`), provider)
  }
  for (const provider of LEGACY) {
    assert.doesNotMatch(shellRegistry, new RegExp(`\\b${provider}\\b`), provider)
    assert.doesNotMatch(psRegistry, new RegExp(`\\b${provider}\\b`), provider)
  }
  for (const source of [shellInstall, psInstall]) {
    assert.doesNotMatch(source, /\b(?:claw|crab)\b/i)
  }
  const shellPayload = shellInstall.match(/payload_file\(\) \{[\s\S]*?^\}/m)?.[0] || ''
  const psPayload = psInstall.match(/function Get-PayloadFile \{[\s\S]*?^\}/m)?.[0] || ''
  for (const provider of PUBLIC.filter(provider => provider !== 'prime')) {
    assert.match(shellPayload, new RegExp(`\\b${provider}\\b`))
    assert.match(psPayload, new RegExp(`'${provider}'`))
  }
  assert.match(shellPayload, /\*\)\s+return 1/)
  assert.doesNotMatch(shellPayload, /else[\s\S]*agents\/claude\/SKILL\.md/)
  assert.match(psPayload, /default\s+\{\s*return \$null\s*\}/)
  assert.doesNotMatch(psPayload, /return \(Join-Path \$RepoRoot 'agents\/claude\/SKILL\.md'\)\s*$/m)
})

test('DeepSeek prerelease detection and its rc.7 floor agree in both installer ports', {
  skip: process.platform !== 'win32',
}, () => {
  const bash = findBash()
  assert.ok(bash, 'Git Bash is required for lifecycle port parity')
  const context = makeSandbox()
  const version = '0.1.0-rc.6+local.1'
  fs.writeFileSync(
    path.join(context.bin, 'dsh.cmd'),
    `@echo off\r\necho DeepSeek Harness ${version}\r\n`,
  )
  const shellBinary = path.join(context.bin, 'dsh')
  fs.writeFileSync(shellBinary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
  fs.chmodSync(shellBinary, 0o755)
  try {
    const shellLibrary = toBash(path.join(INSTALL_DIR, 'lib', 'install-lib.sh'))
    const shell = run(bash, ['--noprofile', '--norc', '-c', [
      `export PATH='${toBash(context.bin)}:/usr/bin:/bin'`,
      `. '${shellLibrary}'`,
      `test "$(detect_client deepseek)" = 'client=deepseek present=true version=${version}'`,
      `test "${'${AUTOPROMPT_VERSION_FLOOR[deepseek]}'}" = '0.1.0-rc.7'`,
      `! _precheck_version_ge '${version}' "${'${AUTOPROMPT_VERSION_FLOOR[deepseek]}'}"`,
      `_precheck_version_ge '0.1.0-rc.7' "${'${AUTOPROMPT_VERSION_FLOOR[deepseek]}'}"`,
      `_precheck_version_ge '0.1.0-rc.8' "${'${AUTOPROMPT_VERSION_FLOOR[deepseek]}'}"`,
      `_precheck_version_ge '0.1.0' "${'${AUTOPROMPT_VERSION_FLOOR[deepseek]}'}"`,
      `! _precheck_version_ge '0.1.0-alpha' "${'${AUTOPROMPT_VERSION_FLOOR[deepseek]}'}"`,
    ].join('; ')])
    assert.equal(shell.status, 0, combined(shell))

    const psLibrary = path.join(INSTALL_DIR, 'lib', 'install-lib.ps1')
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      `. ${powershellLiteral(psLibrary)}`,
      '$writer = [IO.StringWriter]::new()',
      '$prior = [Console]::Out',
      'try { [Console]::SetOut($writer); $code = Detect-Client -Name deepseek } finally { [Console]::SetOut($prior) }',
      'if ($code -ne 0) { exit 10 }',
      `if ($writer.ToString().Trim() -cne 'client=deepseek present=true version=${version}') { exit 11 }`,
      "if ($AutopromptVersionFloor.deepseek -cne '0.1.0-rc.7') { exit 12 }",
      `if (Test-PrecheckVersionGe -Found '${version}' -Floor $AutopromptVersionFloor.deepseek) { exit 13 }`,
      "if (-not (Test-PrecheckVersionGe -Found '0.1.0-rc.7' -Floor $AutopromptVersionFloor.deepseek)) { exit 14 }",
      "if (-not (Test-PrecheckVersionGe -Found '0.1.0-rc.8' -Floor $AutopromptVersionFloor.deepseek)) { exit 15 }",
      "if (-not (Test-PrecheckVersionGe -Found '0.1.0' -Floor $AutopromptVersionFloor.deepseek)) { exit 16 }",
      "if (Test-PrecheckVersionGe -Found '0.1.0-alpha' -Floor $AutopromptVersionFloor.deepseek) { exit 17 }",
      'exit 0',
    ].join('; ')
    const powershell = run(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript,
    ], { env: context.psEnv })
    assert.equal(powershell.status, 0, combined(powershell))
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('PowerShell Reasonix roots follow Windows and Unix host contracts', (t) => {
  const probe = run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0',
  ])
  if (probe.error?.code === 'ENOENT') {
    t.skip(`${POWERSHELL} is not available on this runner`)
    return
  }
  assert.equal(probe.status, 0, combined(probe))

  const context = makeSandbox()
  const appData = path.join(context.root, 'roaming')
  fs.mkdirSync(appData, { recursive: true })
  const env = { ...context.psEnv, APPDATA: appData }
  if (process.platform !== 'win32') env.PATH = process.env.PATH
  delete env.AUTOPROMPT_INSTALL_ROOT
  delete env.REASONIX_HOME
  try {
    const psLibrary = path.join(INSTALL_DIR, 'lib', 'install-lib.ps1')
    const expectedUnix = path.join(context.home, '.reasonix')
    const expectedWindows = path.join(appData, 'reasonix')
    const script = [
      `. ${powershellLiteral(psLibrary)}`,
      'function Test-AutopromptWindowsHost { return $false }',
      '$unix = Get-AutopromptConfigRoot -Name reasonix',
      `if ($unix -cne ${powershellLiteral(expectedUnix)}) { exit 20 }`,
      'function Test-AutopromptWindowsHost { return $true }',
      '$windows = Get-AutopromptConfigRoot -Name reasonix',
      `if ($windows -cne ${powershellLiteral(expectedWindows)}) { exit 21 }`,
      'exit 0',
    ].join('; ')
    const result = run(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { env })
    assert.equal(result.status, 0, combined(result))
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('legacy providers fail as unknown before install writes in both ports', {
  skip: process.platform !== 'win32',
}, () => {
  const bash = findBash()
  assert.ok(bash, 'Git Bash is required for lifecycle port parity')
  for (const port of ['powershell', 'shell']) {
    const context = makeSandbox()
    try {
      const before = treeDigest(context.home)
      for (const provider of LEGACY) {
        const result = port === 'powershell'
          ? runPowerShellScript('install', provider, context.psEnv)
          : runShellScript(bash, 'install', provider, context)
        assert.notEqual(result.status, 0, `${port} ${provider}\n${combined(result)}`)
        assert.match(combined(result), new RegExp(`unknown client ${provider}`))
        assert.deepEqual(treeDigest(context.home), before, `${port} ${provider} mutated HOME`)
      }
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }
})

test('install all reports only the nine public providers in both ports', {
  skip: process.platform !== 'win32',
}, () => {
  const bash = findBash()
  assert.ok(bash, 'Git Bash is required for lifecycle port parity')
  for (const port of ['powershell', 'shell']) {
    const context = makeSandbox()
    try {
      const before = treeDigest(context.home)
      const result = port === 'powershell'
        ? runPowerShellScript('install', 'all', context.psEnv)
        : runShellScript(bash, 'install', 'all', context)
      assert.equal(result.status, 0, `${port}\n${combined(result)}`)
      for (const provider of PUBLIC) assert.match(combined(result), new RegExp(`SKIP\\s+${provider}\\s+reason=not-detected`))
      assert.doesNotMatch(combined(result), new RegExp(LEGACY.join('|'), 'i'))
      assert.deepEqual(treeDigest(context.home), before, `${port} all mutated HOME`)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }
})

test('default doctor reports only the nine public providers', {
  skip: process.platform !== 'win32',
}, () => {
  const bash = findBash()
  assert.ok(bash, 'Git Bash is required for lifecycle port parity')
  for (const port of ['powershell', 'shell']) {
    const context = makeSandbox()
    try {
      const before = treeDigest(context.home)
      const result = port === 'powershell'
        ? runPowerShellScript('doctor', '', context.psEnv)
        : runShellScript(bash, 'doctor', '', context)
      assert.equal(result.status, 0, `${port}\n${combined(result)}`)
      for (const provider of PUBLIC) {
        assert.match(result.stdout, new RegExp(`^${provider}\\s+`, 'm'), `${port} ${provider}`)
      }
      assert.doesNotMatch(result.stdout, new RegExp(LEGACY.join('|'), 'i'))
      assert.deepEqual(treeDigest(context.home), before)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }
})

test('blocked Cursor uninstall cleans only its legacy receipt-owned file in both ports', {
  skip: process.platform !== 'win32',
}, () => {
  const bash = findBash()
  assert.ok(bash, 'Git Bash is required for lifecycle port parity')
  for (const port of ['powershell', 'shell']) {
    const context = makeSandbox()
    try {
      const paths = writeLegacySharedReceipt(context.home, port)
      const result = port === 'powershell'
        ? runPowerShellScript('uninstall', 'cursor', context.psEnv)
        : runShellScript(bash, 'uninstall', 'cursor', context)
      assert.equal(result.status, 0, `${port}\n${combined(result)}`)
      assert.equal(fs.existsSync(paths.cursor), false)
      assert.equal(fs.readFileSync(paths.claude, 'utf8'), 'claude-owned\n')
      assert.equal(fs.existsSync(paths.receiptPath), true)
      const receipt = JSON.parse(fs.readFileSync(paths.receiptPath, 'utf8'))
      assert.equal(receipt.files.length, 1)
      assert.match(receipt.files[0].replaceAll('\\', '/'), /\.claude\/skills\/autoprompt\/SKILL\.md$/)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }
})
