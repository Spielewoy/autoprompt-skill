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
const manifest = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'agents', 'manifests', 'claude-runtime.json'),
  'utf8',
))
const EXPECTED_AGENTS = manifest.files
  .filter(relativePath => /^agents\/ap-.*\.md$/.test(relativePath))
  .map(relativePath => path.basename(relativePath))
  .sort()

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  })
}

function findBash() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
        'bash',
      ]
    : ['bash']
  for (const candidate of candidates) {
    const result = run(candidate, ['--version'])
    if (result.status === 0) return candidate
  }
  return null
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function powershell(script, env) {
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { env })
}

function powershellCommand(name, target, strict = false) {
  const script = path.join(ROOT, 'scripts', 'install', `${name}.ps1`)
  const strictArgument = strict ? ' -Strict' : ''
  return `& ${powershellLiteral(script)} ${powershellLiteral(target)}${strictArgument}; exit $LASTEXITCODE`
}

function writeFakeClaude(binDirectory, version) {
  fs.mkdirSync(binDirectory, { recursive: true })
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDirectory, 'claude.cmd'),
      `@echo off\r\necho Claude Code ${version}\r\n`,
    )
  }
  const shellTarget = path.join(binDirectory, 'claude')
  fs.writeFileSync(shellTarget, `#!/bin/sh\nprintf 'Claude Code ${version}\\n'\n`)
  fs.chmodSync(shellTarget, 0o755)
}

function lifecycleEnvironment(sandbox, version) {
  const home = path.join(sandbox, 'home')
  const bin = path.join(sandbox, 'bin')
  fs.mkdirSync(home, { recursive: true })
  writeFakeClaude(bin, version)
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
  }
}

function installPaths(home) {
  return {
    receipt: path.join(home, '.autoprompt-install-receipt.json'),
    hashes: path.join(home, '.autoprompt-install-hashes.json'),
    skill: path.join(home, '.claude', 'skills', 'autoprompt'),
    native: path.join(home, '.claude', 'agents'),
  }
}

function nativeAgentNames(directory) {
  return fs.readdirSync(directory)
    .filter(name => /^ap-.*\.md$/.test(name))
    .sort()
}

function normalized(filePath) {
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
  return path.join(cursor, ...suffix).toLowerCase()
}

test('Claude lifecycle ports pin the safe 2.1.219 floor', () => {
  const shell = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh'),
    'utf8',
  )
  const powershellSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1'),
    'utf8',
  )
  assert.match(shell, /\[claude\]=2\.1\.219/)
  assert.doesNotMatch(shell, /\[claude\]=2\.1\.172/)
  assert.match(powershellSource, /claude\s*=\s*'2\.1\.219'/)
  assert.doesNotMatch(powershellSource, /claude\s*=\s*'2\.1\.172'/)
})

test('POSIX Claude floor, agent schema, and shell syntax checks are explicit', () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required for the POSIX lifecycle checks')
  const scripts = [
    'scripts/install/install.sh',
    'scripts/install/doctor.sh',
    'scripts/install/uninstall.sh',
    'scripts/install/lib/install-lib.sh',
  ]
  const syntax = run(bash, ['-n', ...scripts])
  assert.equal(syntax.status, 0, syntax.stderr)

  const probe = [
    'set -u',
    '. scripts/install/lib/install-lib.sh',
    '[ "${AUTOPROMPT_VERSION_FLOOR[claude]}" = 2.1.219 ]',
    '! _precheck_version_ge 2.1.218 "${AUTOPROMPT_VERSION_FLOOR[claude]}"',
    '_precheck_version_ge 2.1.219 "${AUTOPROMPT_VERSION_FLOOR[claude]}"',
    'node agents/claude/workflow/agent-definitions-cli.js agents/claude/agents',
  ].join('\n')
  const completed = run(bash, ['-c', probe])
  assert.equal(completed.status, 0, completed.stderr)
  const definitions = JSON.parse(completed.stdout)
  assert.deepEqual(Object.keys(definitions).sort(), EXPECTED_AGENTS.map(name => name.slice(0, -3)))
})

test('PowerShell Claude rejects 2.1.218 before writing and accepts 2.1.219', {
  skip: process.platform !== 'win32',
  timeout: 120000,
}, () => {
  for (const [version, accepted] of [['2.1.218', false], ['2.1.219', true]]) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-claude-${version}-`))
    const context = lifecycleEnvironment(sandbox, version)
    const paths = installPaths(context.home)
    try {
      const installed = powershell(powershellCommand('install', 'claude'), context.env)
      assert.equal(installed.status === 0, accepted, `${installed.stdout}\n${installed.stderr}`)
      if (accepted) {
        assert.deepEqual(nativeAgentNames(paths.native), EXPECTED_AGENTS)
        const removed = powershell(powershellCommand('uninstall', 'claude'), context.env)
        assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
      } else {
        assert.match(`${installed.stdout}\n${installed.stderr}`, /version-below-floor/)
        assert.equal(fs.existsSync(paths.skill), false)
        assert.equal(fs.existsSync(paths.receipt), false)
        assert.equal(fs.existsSync(paths.hashes), false)
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }
})

test('PowerShell Claude install, doctor, repair, idempotence, and uninstall are isolated', {
  skip: process.platform !== 'win32',
  timeout: 180000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-claude-lifecycle-'))
  const context = lifecycleEnvironment(sandbox, '2.1.232')
  const paths = installPaths(context.home)
  const sibling = path.join(paths.native, 'user-agent.md')
  fs.mkdirSync(paths.native, { recursive: true })
  fs.writeFileSync(sibling, 'user-owned\n')

  try {
    const first = powershell(powershellCommand('install', 'claude'), context.env)
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
    assert.deepEqual(nativeAgentNames(paths.native), EXPECTED_AGENTS)

    const receipt = JSON.parse(fs.readFileSync(paths.receipt, 'utf8'))
    const nativeRoot = `${normalized(paths.native)}${path.sep}`
    const ownedNative = receipt.files
      .filter(file => normalized(file).startsWith(nativeRoot))
      .map(file => path.basename(file))
      .sort()
    assert.deepEqual(ownedNative, EXPECTED_AGENTS)
    assert.equal(receipt.files.map(normalized).includes(normalized(sibling)), false)

    const healthy = powershell(powershellCommand('doctor', 'claude', true), context.env)
    assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`)
    assert.match(
      healthy.stdout,
      /^claude\s+yes\s+yes\s+yes\s+version=2\.1\.232 reason=- extras=complete$/m,
    )

    const watched = [
      paths.receipt,
      path.join(paths.skill, 'SKILL.md'),
      path.join(paths.native, 'ap-manager.md'),
    ]
    const before = watched.map(file => ({
      bytes: fs.readFileSync(file),
      mtime: fs.statSync(file).mtimeMs,
    }))
    const second = powershell(powershellCommand('install', 'claude'), context.env)
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`)
    watched.forEach((file, index) => {
      assert.deepEqual(fs.readFileSync(file), before[index].bytes, file)
      assert.equal(fs.statSync(file).mtimeMs, before[index].mtime, file)
    })

    const deletedAgent = path.join(paths.native, 'ap-manager.md')
    fs.rmSync(deletedAgent)
    const deleted = powershell(powershellCommand('doctor', 'claude', true), context.env)
    assert.notEqual(deleted.status, 0, `${deleted.stdout}\n${deleted.stderr}`)
    assert.match(deleted.stdout, /extras=invalid:claude-native-count/)
    fs.copyFileSync(path.join(paths.skill, 'agents', 'ap-manager.md'), deletedAgent)

    const tamperedAgent = path.join(paths.native, 'ap-reviewer.md')
    fs.appendFileSync(tamperedAgent, '\ntampered\n')
    const tampered = powershell(powershellCommand('doctor', 'claude', true), context.env)
    assert.notEqual(tampered.status, 0, `${tampered.stdout}\n${tampered.stderr}`)
    assert.match(tampered.stdout, /extras=invalid:claude-native-hash/)
    fs.copyFileSync(path.join(paths.skill, 'agents', 'ap-reviewer.md'), tamperedAgent)

    const originalAgent = fs.readFileSync(tamperedAgent, 'utf8')
    fs.writeFileSync(tamperedAgent, originalAgent.replace(
      /^name: ap-reviewer$/m,
      'name: ap-planner',
    ))
    const invalidFrontmatter = powershell(
      powershellCommand('doctor', 'claude', true),
      context.env,
    )
    assert.notEqual(
      invalidFrontmatter.status,
      0,
      `${invalidFrontmatter.stdout}\n${invalidFrontmatter.stderr}`,
    )
    assert.match(
      invalidFrontmatter.stdout,
      /extras=invalid:claude-native-frontmatter/,
    )
    fs.rmSync(deletedAgent)

    const repaired = powershell(powershellCommand('install', 'claude'), context.env)
    assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`)
    assert.equal(fs.existsSync(deletedAgent), true)
    assert.doesNotMatch(fs.readFileSync(tamperedAgent, 'utf8'), /tampered/)
    assert.match(fs.readFileSync(tamperedAgent, 'utf8'), /^name: ap-reviewer$/m)

    const removed = powershell(powershellCommand('uninstall', 'claude'), context.env)
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
    assert.equal(fs.existsSync(paths.skill), false)
    assert.deepEqual(fs.readFileSync(sibling, 'utf8'), 'user-owned\n')
    assert.equal(fs.existsSync(paths.receipt), false)
    assert.equal(fs.existsSync(paths.hashes), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
