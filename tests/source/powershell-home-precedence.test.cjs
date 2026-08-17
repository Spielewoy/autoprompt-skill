#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'

function runPowerShell(script, env) {
  return childProcess.spawnSync(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 180000,
  })
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function normalized(value) {
  return path.resolve(value).toLowerCase()
}

function assertSandboxed(sandbox, candidate) {
  const relative = path.relative(sandbox, candidate)
  assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`), false, candidate)
  assert.notEqual(normalized(candidate), normalized(os.homedir()), candidate)
}

function makeFakeKilo(binDirectory) {
  fs.mkdirSync(binDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(binDirectory, 'kilo.cmd'),
    '@echo off\r\necho kilo 7.4.22\r\n',
  )
}

function makeSplitHomeEnvironment(sandbox) {
  const home = path.join(sandbox, 'home')
  const userProfile = path.join(sandbox, 'userprofile')
  const xdg = path.join(sandbox, 'xdg')
  const appData = path.join(sandbox, 'appdata')
  const temporary = path.join(sandbox, 'tmp')
  const bin = path.join(sandbox, 'bin')
  const settings = path.join(appData, 'Code', 'User', 'settings.json')

  for (const directory of [
    home,
    userProfile,
    xdg,
    appData,
    temporary,
    bin,
  ]) {
    assertSandboxed(sandbox, directory)
    fs.mkdirSync(directory, { recursive: true })
  }
  makeFakeKilo(bin)

  return {
    home,
    userProfile,
    xdg,
    env: {
      ...process.env,
      APPDATA: appData,
      AUTOPROMPT_VSCODE_SETTINGS_PATH: settings,
      CODEX_HOME: path.join(home, '.codex'),
      HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      TEMP: temporary,
      TMP: temporary,
      USERPROFILE: userProfile,
      XDG_CONFIG_HOME: xdg,
    },
  }
}

function scriptCommand(name, target) {
  const script = path.join(ROOT, 'scripts', 'install', `${name}.ps1`)
  return `& ${powershellLiteral(script)} ${powershellLiteral(target)}; exit $LASTEXITCODE`
}

function destinationCommand() {
  const lib = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  return [
    `. ${powershellLiteral(lib)}`,
    '$claude = Resolve-Destination -Name claude',
    'if ($claude -ne 0) { exit $claude }',
    '$vscode = Resolve-Destination -Name vscode',
    'if ($vscode -ne 0) { exit $vscode }',
    'exit 0',
  ].join('; ')
}

function destinationFrom(stdout, client) {
  const prefix = `client=${client} dest=`
  const line = stdout.split(/\r?\n/).find(candidate => candidate.startsWith(prefix))
  assert.ok(line, `${client} destination missing from:\n${stdout}`)
  return line.slice(prefix.length, line.lastIndexOf(' format='))
}

function repairCommand(configRoot) {
  const lib = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  const payload = path.join(ROOT, 'agents', 'kilo', 'SKILL.md')
  return [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellLiteral(lib)}`,
    `$text = [IO.File]::ReadAllText(${powershellLiteral(payload)}, [Text.UTF8Encoding]::new($false))`,
    '$norm = $text -replace "`r`n", "`n"',
    '$marker = "---`n"',
    '$parts = $norm -split [regex]::Escape($marker)',
    '$frontmatter = $parts[1]',
    '$frontmatterLines = $frontmatter -split "`n"',
    '$body = $parts[2..($parts.Count - 1)] -join $marker',
    "$name = (($frontmatterLines | Where-Object { $_ -match '^name:\\s*' } | Select-Object -First 1) -replace '^name:\\s*', '').Trim()",
    "$description = (($frontmatterLines | Where-Object { $_ -match '^description:\\s*' } | Select-Object -First 1) -replace '^description:\\s*', '').Trim()",
    'if ($description.StartsWith([char]34) -and $description.EndsWith([char]34)) { $description = $description.Substring(1, $description.Length - 2) }',
    `$code = Repair-Install -ConfigRoot ${powershellLiteral(configRoot)} -Name kilo -SkillName $name -Description $description -Body $body`,
    'exit $code',
  ].join('; ')
}

test('PowerShell destinations prefer HOME when USERPROFILE differs', {
  skip: process.platform !== 'win32',
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-home-resolve-'))
  const context = makeSplitHomeEnvironment(sandbox)

  try {
    const resolved = runPowerShell(destinationCommand(), context.env)
    assert.equal(resolved.status, 0, `${resolved.stdout}\n${resolved.stderr}`)
    assert.equal(
      normalized(destinationFrom(resolved.stdout, 'claude')),
      normalized(path.join(context.home, '.claude', 'skills', 'autoprompt', 'SKILL.md')),
    )
    assert.equal(
      normalized(destinationFrom(resolved.stdout, 'vscode')),
      normalized(path.join(context.home, '.copilot', 'skills', 'autoprompt', 'SKILL.md')),
    )

    const fallbackEnv = { ...context.env }
    delete fallbackEnv.HOME
    const fallback = runPowerShell(destinationCommand(), fallbackEnv)
    assert.equal(fallback.status, 0, `${fallback.stdout}\n${fallback.stderr}`)
    assert.equal(
      normalized(destinationFrom(fallback.stdout, 'claude')),
      normalized(path.join(
        context.userProfile,
        '.claude',
        'skills',
        'autoprompt',
        'SKILL.md',
      )),
    )
    assert.equal(
      normalized(destinationFrom(fallback.stdout, 'vscode')),
      normalized(path.join(
        context.userProfile,
        '.copilot',
        'skills',
        'autoprompt',
        'SKILL.md',
      )),
    )
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell Kilo owns HOME-scoped files through install, repair, and uninstall', {
  skip: process.platform !== 'win32',
  timeout: 180000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-kilo-home-'))
  const context = makeSplitHomeEnvironment(sandbox)
  const skillRoot = path.join(context.home, '.kilo', 'skills', 'autoprompt')
  const skill = path.join(skillRoot, 'SKILL.md')
  const wrongSkill = path.join(
    context.userProfile,
    '.kilo',
    'skills',
    'autoprompt',
    'SKILL.md',
  )
  const receiptPath = path.join(context.xdg, '.autoprompt-install-receipt.json')
  assertSandboxed(sandbox, skill)
  assertSandboxed(sandbox, wrongSkill)
  assertSandboxed(sandbox, receiptPath)

  try {
    const installed = runPowerShell(scriptCommand('install', 'kilo'), context.env)
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    assert.equal(fs.existsSync(skill), true)
    assert.equal(fs.existsSync(wrongSkill), false)

    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    const owned = receipt.files.map(normalized)
    assert.equal(owned.includes(normalized(skill)), true)
    assert.equal(
      owned.some(candidate => candidate.startsWith(`${normalized(context.userProfile)}${path.sep}`)),
      false,
    )

    const original = fs.readFileSync(skill)
    fs.appendFileSync(skill, '\ncorrupt\n')
    const repaired = runPowerShell(repairCommand(context.xdg), context.env)
    assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`)
    assert.deepEqual(fs.readFileSync(skill), original)
    assert.match(repaired.stdout, /client=kilo repair=restored/)

    const removed = runPowerShell(scriptCommand('uninstall', 'kilo'), context.env)
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
    assert.equal(fs.existsSync(skillRoot), false)
    assert.equal(fs.existsSync(path.join(context.home, '.kilo')), false)
    assert.equal(fs.existsSync(path.join(context.xdg, 'kilo')), false)
    assert.equal(fs.existsSync(receiptPath), false)
    assert.equal(fs.existsSync(path.join(context.userProfile, '.kilo')), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
