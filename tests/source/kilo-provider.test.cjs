#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const CONTRACT = path.join(ROOT, 'agents', 'contracts', 'autoprompt.contract.json')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '')
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    ...options,
  })
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function makeFakeKilo(binDir, version = '7.4.22') {
  fs.mkdirSync(binDir, { recursive: true })
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'kilo.cmd'), `@echo off\r\necho kilo ${version}\r\n`)
  } else {
    const target = path.join(binDir, 'kilo')
    fs.writeFileSync(target, `#!/bin/sh\nprintf 'kilo ${version}\\n'\n`)
    fs.chmodSync(target, 0o755)
  }
}

function powershell(script, env) {
  return run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env,
    timeout: 180000,
  })
}

function lifecycleEnvironment(root) {
  const home = path.join(root, 'home')
  const xdg = path.join(root, 'xdg')
  const bin = path.join(root, 'bin')
  assert.equal(path.relative(root, home).startsWith('..'), false, home)
  assert.notEqual(path.resolve(home).toLowerCase(), path.resolve(os.homedir()).toLowerCase())
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(xdg, { recursive: true })
  makeFakeKilo(bin)
  return {
    home,
    xdg,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdg,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
  }
}

function managedBatchProbeCommand(configRoot, sourceDir, targetDir, outsideTarget) {
  const lib = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  const mappings = ['one.txt', 'two.txt', 'three.txt'].map(name =>
    `@{ Source = ${powershellLiteral(path.join(sourceDir, name))}; Target = ${powershellLiteral(path.join(targetDir, name))} }`
  ).join(', ')
  return [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellLiteral(lib)}`,
    '$script:AutopromptReceiptFiles = @()',
    '$script:AutopromptReceiptCreatedDirectories = @()',
    '$script:AutopromptReceiptEdits = @()',
    '$script:AutopromptManagedUndoJournal = @()',
    `$outsideCode = Install-IdemManagedFiles -ConfigRoot ${powershellLiteral(configRoot)} -Mappings @(@{ Source = ${powershellLiteral(path.join(sourceDir, 'one.txt'))}; Target = ${powershellLiteral(outsideTarget)} }) -RefuseUnownedTarget`,
    "if ($outsideCode -ne 44 -or (Test-Path -LiteralPath " + powershellLiteral(outsideTarget) + ") -or $script:AutopromptManagedUndoJournal.Count -ne 0) { exit 91 }",
    `$code = Install-IdemManagedFiles -ConfigRoot ${powershellLiteral(configRoot)} -Mappings @(${mappings}) -RefuseUnownedTarget`,
    'if ($code -ne 0) { exit $code }',
    '[Console]::Out.WriteLine("journal=$($script:AutopromptManagedUndoJournal.Count) files=$($script:AutopromptReceiptFiles.Count)")',
    'if (-not (Complete-IdemManagedChanges)) { exit 92 }',
    'exit 0',
  ].join('; ')
}

function installCommand(target) {
  const script = path.join(ROOT, 'scripts', 'install', 'install.ps1').replaceAll("'", "''")
  return `& '${script}' '${target}'; exit $LASTEXITCODE`
}

function doctorCommand(client) {
  const script = path.join(ROOT, 'scripts', 'install', 'doctor.ps1').replaceAll("'", "''")
  return `& '${script}' '${client}'; exit 0`
}

function uninstallCommand(target) {
  const script = path.join(ROOT, 'scripts', 'install', 'uninstall.ps1').replaceAll("'", "''")
  return `& '${script}' '${target}'; exit $LASTEXITCODE`
}

test('Kilo is a generated native provider with 25 canonical personas', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'))
  assert.deepEqual(contract.providers.kilo.capabilities, [
    'activation-profile',
    'native-markdown-subagents',
    'recursive-subagents',
  ])
  assert.equal(contract.generated.kiloAgents, 'agents/kilo/agents')
  assert.equal(contract.generated.kiloFrameworks, 'agents/kilo/frameworks')

  const completed = run(process.execPath, ['scripts/generate-provider-contracts.cjs', '--check'])
  assert.equal(completed.status, 0, completed.stderr)

  const agents = fs.readdirSync(path.join(ROOT, 'agents', 'kilo', 'agents'))
    .filter(name => name.startsWith('ap-') && name.endsWith('.md'))
    .sort()
  assert.equal(agents.length, 25)
  assert.deepEqual(agents, contract.personas.map(persona => `${persona.id}.md`).sort())

  for (const persona of contract.personas) {
    const rendered = read(`agents/kilo/agents/${persona.id}.md`)
    assert.match(rendered, /^mode: subagent$/m)
    assert.equal(rendered.includes(stripFrontmatter(read(persona.source)).trim()), true)
  }
})

test('Kilo package has the guarded activation policy and Kilo native skill text', () => {
  const profile = JSON.parse(read('agents/kilo/autoprompt.kilo.json'))
  assert.deepEqual(profile, {
    $schema: 'https://app.kilo.ai/config.json',
    subagent_depth: 4,
    share: 'disabled',
    permission: { task: { '*': 'deny', 'ap-*': 'allow' } },
  })

  const skill = read('agents/kilo/SKILL.md')
  assert.match(skill, /Kilo `ap-\*` subagents are native markdown agent definitions/)
  assert.match(skill, /KILO_CONFIG=~\/\.config\/kilo\/autoprompt\.kilo\.json kilo/)
  assert.match(skill, /Kilo >= 7\.4\.22/)
  assert.doesNotMatch(skill, /OPENCODE_CONFIG|OpenCode >=/)
})

test('Kilo runtime manifest is current and includes the profile and exactly 25 agents', () => {
  const completed = run(process.execPath, ['scripts/runtime-payload.cjs', '--check'])
  assert.equal(completed.status, 0, completed.stderr)
  const manifest = JSON.parse(read('agents/manifests/kilo-runtime.json'))
  assert.equal(manifest.provider, 'kilo')
  assert.equal(manifest.files.includes('autoprompt.kilo.json'), true)
  assert.equal(manifest.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, 25)
})

test('POSIX Kilo path, version floor, schema, and activation hooks are explicit', {
  skip: process.platform !== 'win32' || !fs.existsSync(GIT_BASH),
}, () => {
  const script = [
    `cd '${ROOT.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`,
    "export HOME=/tmp/autoprompt-kilo-home XDG_CONFIG_HOME=/tmp/autoprompt-kilo-xdg",
    'source scripts/install/lib/install-lib.sh',
    'resolve_destination kilo',
    "printf 'floor=%s\\n' \"${AUTOPROMPT_VERSION_FLOOR[kilo]}\"",
    'validate_kilo_profile agents/kilo/autoprompt.kilo.json',
    "printf 'profile=%s\\n' \"$?\"",
    'printf \'config=%s\\n\' "$(kilo_config_dir)"',
    'printf \'agents=%s\\n\' "$(kilo_agents_dir)"',
    'printf \'profile_path=%s\\n\' "$(kilo_profile_file)"',
  ].join('; ')
  const completed = run(GIT_BASH, ['-lc', script])
  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stdout, /dest=\/tmp\/autoprompt-kilo-home\/\.kilo\/skills\/autoprompt\/SKILL\.md/)
  assert.match(completed.stdout, /floor=7\.4\.22/)
  assert.match(completed.stdout, /profile=0/)
  assert.match(completed.stdout, /config=\/tmp\/autoprompt-kilo-xdg\/kilo/)
  assert.match(completed.stdout, /agents=\/tmp\/autoprompt-kilo-xdg\/kilo\/agents/)
  assert.match(completed.stdout, /profile_path=\/tmp\/autoprompt-kilo-xdg\/kilo\/autoprompt\.kilo\.json/)
})

test('PowerShell Kilo install, doctor, repair, idempotence, and uninstall are isolated', {
  skip: process.platform !== 'win32',
  timeout: 600000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-kilo-test-'))
  const { home, xdg, env } = lifecycleEnvironment(sandbox)
  const skill = path.join(home, '.kilo', 'skills', 'autoprompt', 'SKILL.md')
  const kiloRoot = path.join(xdg, 'kilo')
  const agents = path.join(kiloRoot, 'agents')
  const profile = path.join(kiloRoot, 'autoprompt.kilo.json')
  const receipt = path.join(xdg, '.autoprompt-install-receipt.json')

  try {
    const batchSources = path.join(sandbox, 'batch-sources')
    const batchTargets = path.join(xdg, 'batch-targets')
    const outsideTarget = path.join(sandbox, 'outside-target.txt')
    fs.mkdirSync(batchSources, { recursive: true })
    for (const name of ['one.txt', 'two.txt', 'three.txt']) {
      fs.writeFileSync(path.join(batchSources, name), `${name}\n`)
    }
    const batch = powershell(
      managedBatchProbeCommand(xdg, batchSources, batchTargets, outsideTarget),
      env,
    )
    assert.equal(batch.status, 0, `${batch.stdout}\n${batch.stderr}`)
    assert.match(batch.stdout, /journal=1 files=4/)

    const first = powershell(installCommand('kilo'), env)
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
    assert.equal(fs.existsSync(skill), true)
    assert.equal(fs.existsSync(profile), true)
    assert.equal(fs.readdirSync(agents).filter(name => /^ap-.*\.md$/.test(name)).length, 25)
    assert.equal(fs.existsSync(receipt), true)

    const doctor = powershell(doctorCommand('kilo'), env)
    assert.equal(doctor.status, 0, doctor.stderr)
    assert.match(doctor.stdout, /^kilo\s+yes\s+yes\s+yes\s+version=7\.4\.22 reason=- extras=complete$/m)
    const opencode = powershell(doctorCommand('opencode'), env)
    assert.equal(opencode.status, 0, opencode.stderr)
    assert.match(opencode.stdout, /^opencode\s+\S+\s+no\s+no\s+/m)

    const agent = path.join(agents, 'ap-manager.md')
    fs.appendFileSync(agent, '\ncorrupt\n')
    const corrupted = powershell(doctorCommand('kilo'), env)
    assert.equal(corrupted.status, 0, corrupted.stderr)
    assert.match(corrupted.stdout, /^kilo\s+yes\s+yes\s+yes\s+.*extras=invalid:agent-mismatch$/m)

    const repair = powershell(installCommand('kilo'), env)
    assert.equal(repair.status, 0, `${repair.stdout}\n${repair.stderr}`)
    assert.doesNotMatch(fs.readFileSync(agent, 'utf8'), /corrupt/)

    const watched = [skill, profile, agent, receipt]
    const before = watched.map(file => ({ bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }))
    const second = powershell(installCommand('kilo'), env)
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`)
    watched.forEach((file, index) => {
      assert.deepEqual(fs.readFileSync(file), before[index].bytes, file)
      assert.equal(fs.statSync(file).mtimeMs, before[index].mtime, file)
    })

    const removed = powershell(uninstallCommand('kilo'), env)
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
    assert.equal(fs.existsSync(skill), false)
    assert.equal(fs.existsSync(profile), false)
    assert.equal(fs.existsSync(agents), false)
    assert.equal(fs.existsSync(receipt), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
