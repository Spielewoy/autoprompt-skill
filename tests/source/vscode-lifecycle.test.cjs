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
const { resolveBash } = require('../helpers/resolve-bash.cjs')
const GIT_BASH = resolveBash()
const ACTIVATION_KEY = 'chat.subagents.allowInvocationsFromSubagents'
const manifest = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'agents', 'manifests', 'vscode-runtime.json'),
  'utf8',
))

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  })
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function powershell(script, env) {
  return run(POWERSHELL, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { env })
}

function scriptCommand(name, target) {
  const file = path.join(ROOT, 'scripts', 'install', `${name}.ps1`)
  return `& ${powershellLiteral(file)} ${powershellLiteral(target)}; exit $LASTEXITCODE`
}

function writeFakeClient(binDir, client, version) {
  fs.mkdirSync(binDir, { recursive: true })
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDir, `${client}.cmd`),
      `@echo off\r\necho ${version}\r\n`,
    )
    const shellTarget = path.join(binDir, client)
    fs.writeFileSync(shellTarget, `#!/bin/sh\nprintf '${version}\\n'\n`)
    fs.chmodSync(shellTarget, 0o755)
    return
  }
  const target = path.join(binDir, client)
  fs.writeFileSync(target, `#!/bin/sh\nprintf '${version}\\n'\n`)
  fs.chmodSync(target, 0o755)
}

function makeEnvironment(sandbox, codeVersion = '1.133.0') {
  const home = path.join(sandbox, 'home')
  const appData = path.join(home, 'AppData', 'Roaming')
  const xdg = path.join(home, '.config')
  const bin = path.join(sandbox, 'bin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(xdg, { recursive: true })
  writeFakeClient(bin, 'code', codeVersion)
  return {
    appData,
    bin,
    home,
    settings: path.join(appData, 'Code', 'User', 'settings.json'),
    env: {
      ...process.env,
      APPDATA: appData,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdg,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
  }
}

function originalSettings() {
  return Buffer.from([
    '// retained user comment',
    '{',
    '  "editor.fontSize": 15, // retained inline comment',
    `  "${ACTIVATION_KEY}": false,`,
    '}',
    '',
  ].join('\r\n'), 'utf8')
}

function installPaths(home) {
  const copilot = path.join(home, '.copilot')
  return {
    copilot,
    receipt: path.join(home, '.autoprompt-install-receipt.json'),
    hashes: path.join(home, '.autoprompt-install-hashes.json'),
    skill: path.join(copilot, 'skills', 'autoprompt'),
    agents: path.join(copilot, 'agents'),
  }
}

function assertVscodePayload(paths) {
  for (const relative of manifest.files) {
    assert.equal(
      fs.existsSync(path.join(paths.skill, ...relative.split('/'))),
      true,
      relative,
    )
  }
  assert.equal(manifest.files.length, 49)
  assert.equal(
    fs.readdirSync(paths.agents)
      .filter(name => /^ap-.*\.agent\.md$/.test(name)).length,
    25,
  )
}

test('VS Code source integration declares the destination and version floor', () => {
  const shell = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh'),
    'utf8',
  )
  const powershellSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1'),
    'utf8',
  )
  const powershellInstaller = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install', 'install.ps1'),
    'utf8',
  )
  const settingsHelper = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install', 'vscode-settings.cjs'),
    'utf8',
  )
  for (const source of [shell, powershellSource]) {
    assert.match(source, /vscode/)
    assert.match(source, /1\.133\.0/)
    assert.match(source, /chat\.subagents\.allowInvocationsFromSubagents/)
  }
  const activation = powershellInstaller.match(
    /function Install-VscodeActivation \{[\s\S]*?\n\}/,
  )?.[0] || ''
  assert.match(activation, /Install-IdemManagedFiles/)
  assert.match(settingsHelper, /function stage\(/)
})

test('PowerShell VS Code lifecycle is complete, idempotent, repairable, and scoped', {
  skip: process.platform !== 'win32',
  timeout: 240000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-'))
  const context = makeEnvironment(sandbox, '1.133.0')
  const paths = installPaths(context.home)
  const peerSkill = path.join(context.home, '.claude', 'skills', 'autoprompt', 'SKILL.md')
  const original = originalSettings()
  fs.mkdirSync(path.dirname(context.settings), { recursive: true })
  fs.mkdirSync(path.dirname(peerSkill), { recursive: true })
  fs.writeFileSync(context.settings, original)
  fs.writeFileSync(peerSkill, 'peer-owned\n')

  try {
    const first = powershell(scriptCommand('install', 'vscode'), context.env)
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
    assertVscodePayload(paths)
    const edited = fs.readFileSync(context.settings, 'utf8')
    assert.match(edited, /retained user comment/)
    assert.match(edited, /retained inline comment/)
    assert.match(edited, new RegExp(`"${ACTIVATION_KEY.replaceAll('.', '\\.')}": true`))
    assert.deepEqual(
      fs.readFileSync(`${context.settings}.autoprompt.bak`),
      original,
    )

    const receipt = JSON.parse(fs.readFileSync(paths.receipt, 'utf8'))
    assert.equal(receipt.configEdits.length, 1)
    assert.equal(receipt.configEdits[0].file, context.settings)
    assert.equal(receipt.configEdits[0].key, ACTIVATION_KEY)

    const doctor = powershell(scriptCommand('doctor', 'vscode'), context.env)
    assert.equal(doctor.status, 0, doctor.stderr)
    assert.match(
      doctor.stdout,
      /^vscode\s+yes\s+yes\s+yes\s+version=1\.133\.0 reason=- extras=complete$/m,
    )

    const watched = [
      context.settings,
      `${context.settings}.autoprompt.bak`,
      paths.receipt,
      path.join(paths.skill, 'SKILL.md'),
      path.join(paths.agents, 'ap-manager.agent.md'),
    ]
    const before = watched.map(file => ({
      bytes: fs.readFileSync(file),
      mtime: fs.statSync(file).mtimeMs,
    }))
    const second = powershell(scriptCommand('install', 'vscode'), context.env)
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`)
    watched.forEach((file, index) => {
      assert.deepEqual(fs.readFileSync(file), before[index].bytes, file)
      assert.equal(fs.statSync(file).mtimeMs, before[index].mtime, file)
    })

    const nativeAgent = path.join(paths.agents, 'ap-manager.agent.md')
    fs.appendFileSync(nativeAgent, '\ncorrupt\n')
    const tampered = powershell(scriptCommand('doctor', 'vscode'), context.env)
    assert.equal(tampered.status, 0, tampered.stderr)
    assert.match(tampered.stdout, /extras=invalid:agent-mismatch/)
    const repaired = powershell(scriptCommand('install', 'vscode'), context.env)
    assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`)
    assert.doesNotMatch(fs.readFileSync(nativeAgent, 'utf8'), /corrupt/)

    const removed = powershell(scriptCommand('uninstall', 'vscode'), context.env)
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
    assert.deepEqual(fs.readFileSync(context.settings), original)
    assert.equal(fs.existsSync(`${context.settings}.autoprompt.bak`), false)
    assert.equal(fs.existsSync(paths.copilot), false)
    assert.equal(fs.readFileSync(peerSkill, 'utf8'), 'peer-owned\n')
    assert.equal(fs.existsSync(paths.receipt), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell VS Code refuses unsafe JSONC and rolls back the payload', {
  skip: process.platform !== 'win32',
  timeout: 120000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-jsonc-'))
  const context = makeEnvironment(sandbox)
  const paths = installPaths(context.home)
  const duplicate = Buffer.from([
    '{',
    `  "${ACTIVATION_KEY}": false,`,
    `  "${ACTIVATION_KEY}": true`,
    '}',
    '',
  ].join('\n'))
  fs.mkdirSync(path.dirname(context.settings), { recursive: true })
  fs.writeFileSync(context.settings, duplicate)

  try {
    const installed = powershell(scriptCommand('install', 'vscode'), context.env)
    assert.notEqual(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    assert.match(`${installed.stdout}\n${installed.stderr}`, /activation-missing|duplicate-key/)
    assert.deepEqual(fs.readFileSync(context.settings), duplicate)
    assert.equal(fs.existsSync(`${context.settings}.autoprompt.bak`), false)
    assert.equal(fs.existsSync(paths.copilot), false)
    assert.equal(fs.existsSync(paths.receipt), false)
    assert.equal(fs.existsSync(paths.hashes), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell VS Code refuses an unowned native agent before settings mutation', {
  skip: process.platform !== 'win32',
  timeout: 120000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-collision-'))
  const context = makeEnvironment(sandbox)
  const paths = installPaths(context.home)
  const original = originalSettings()
  const collision = path.join(paths.agents, 'ap-manager.agent.md')
  fs.mkdirSync(path.dirname(context.settings), { recursive: true })
  fs.writeFileSync(context.settings, original)
  fs.mkdirSync(path.dirname(collision), { recursive: true })
  fs.writeFileSync(collision, 'user-owned\n')

  try {
    const installed = powershell(scriptCommand('install', 'vscode'), context.env)
    assert.notEqual(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    assert.match(`${installed.stdout}\n${installed.stderr}`, /unowned-skill-refused/)
    assert.deepEqual(fs.readFileSync(context.settings), original)
    assert.equal(fs.readFileSync(collision, 'utf8'), 'user-owned\n')
    assert.equal(fs.existsSync(paths.receipt), false)
    assert.equal(fs.existsSync(path.join(paths.skill, 'SKILL.md')), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('VS Code below 1.133.0 fails before writing install state', {
  skip: process.platform !== 'win32',
  timeout: 120000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-version-'))
  const context = makeEnvironment(sandbox, '1.132.9')
  const paths = installPaths(context.home)
  try {
    const installed = powershell(scriptCommand('install', 'vscode'), context.env)
    assert.notEqual(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
    assert.match(`${installed.stdout}\n${installed.stderr}`, /version-below-floor/)
    assert.equal(fs.existsSync(paths.copilot), false)
    assert.equal(fs.existsSync(paths.receipt), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('POSIX VS Code install, doctor, and uninstall use the same lifecycle', {
  skip: process.platform !== 'win32' || !fs.existsSync(GIT_BASH),
  timeout: 240000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-sh-'))
  const context = makeEnvironment(sandbox)
  const paths = installPaths(context.home)
  const original = originalSettings()
  fs.mkdirSync(path.dirname(context.settings), { recursive: true })
  fs.writeFileSync(context.settings, original)
  const toBash = value => value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
  const command = [
    `cd '${toBash(ROOT)}'`,
    `export HOME='${toBash(context.home)}'`,
    `export XDG_CONFIG_HOME='${toBash(path.join(context.home, '.config'))}'`,
    `export APPDATA='${toBash(context.appData)}'`,
    `export PATH='${toBash(context.bin)}':$PATH`,
    `export AUTOPROMPT_VSCODE_SETTINGS_PATH='${toBash(context.settings)}'`,
    '/usr/bin/bash scripts/install/install.sh vscode',
    '/usr/bin/bash scripts/install/doctor.sh vscode',
    '/usr/bin/bash scripts/install/uninstall.sh vscode',
  ].join(' && ')

  try {
    const completed = run(GIT_BASH, ['-lc', command], { timeout: 240000 })
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
    assert.match(completed.stdout, /^vscode\s+yes\s+yes\s+yes\s+version=1\.133\.0 reason=- extras=complete$/m)
    assert.deepEqual(fs.readFileSync(context.settings), original)
    assert.equal(fs.existsSync(paths.copilot), false)
    assert.equal(fs.existsSync(paths.receipt), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
