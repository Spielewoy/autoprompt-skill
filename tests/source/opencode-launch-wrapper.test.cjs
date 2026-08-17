#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const POSIX_WRAPPER = path.join(ROOT, 'agents', 'opencode', 'workflow', 'launch-opencode.sh')
const POWERSHELL_WRAPPER = path.join(ROOT, 'agents', 'opencode', 'workflow', 'launch-opencode.ps1')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const POLICY_CONTENT = JSON.stringify({
  subagent_depth: 4,
  share: 'disabled',
  permission: { task: { '*': 'deny', 'ap-*': 'allow' } },
})
const TASK_PERMISSION = JSON.stringify({ task: { '*': 'deny', 'ap-*': 'allow' } })
const SAFE_RESOLVED = JSON.stringify({
  subagent_depth: 4,
  share: 'disabled',
  permission: {
    edit: 'ask',
    task: { '*': 'deny', 'ap-*': 'allow' },
  },
}, null, 2)

function findBash() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
        'bash',
      ]
    : ['bash']

  for (const candidate of candidates) {
    const probe = childProcess.spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

function toPosixPath(value) {
  if (process.platform !== 'win32') return value
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-opencode-launch-'))
  const home = path.join(root, 'home')
  const xdg = path.join(root, 'xdg')
  const bin = path.join(root, 'bin')
  const profile = path.join(xdg, 'opencode', 'autoprompt.opencode.json')
  const ordinaryConfig = path.join(xdg, 'opencode', 'opencode.json')
  const credentials = path.join(home, '.local', 'share', 'opencode', 'auth.json')
  const duplicateClaudeSkill = path.join(home, '.claude', 'skills', 'autoprompt', 'SKILL.md')
  const log = path.join(root, 'calls.log')
  fs.mkdirSync(path.dirname(profile), { recursive: true })
  fs.mkdirSync(path.dirname(credentials), { recursive: true })
  fs.mkdirSync(path.dirname(duplicateClaudeSkill), { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(profile, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    subagent_depth: 4,
    share: 'disabled',
    permission: { task: { '*': 'deny', 'ap-*': 'allow' } },
  }, null, 2))
  fs.writeFileSync(ordinaryConfig, '{"share":"auto"}\n')
  fs.writeFileSync(credentials, '{"token":"untouched"}\n')
  fs.writeFileSync(duplicateClaudeSkill, '---\nname: autoprompt\n---\nexternal collision\n')
  return {
    root,
    home,
    xdg,
    bin,
    profile,
    ordinaryConfig,
    credentials,
    duplicateClaudeSkill,
    log,
  }
}

function baseEnvironment(sandbox, resolved = SAFE_RESOLVED) {
  return {
    ...process.env,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    XDG_CONFIG_HOME: sandbox.xdg,
    AUTOPROMPT_FAKE_LOG: sandbox.log,
    AUTOPROMPT_FAKE_RESOLVED: resolved,
    OPENCODE_CONFIG: 'attacker-config.json',
    OPENCODE_CONFIG_CONTENT: '{"share":"auto"}',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '0',
    OPENCODE_PERMISSION: '{"task":"allow"}',
  }
}

function makePosixFake(sandbox) {
  const target = path.join(sandbox.bin, 'opencode')
  fs.writeFileSync(target, `#!/bin/sh
{
  printf 'BEGIN\\n'
  printf 'config=<%s>\\n' "$OPENCODE_CONFIG"
  printf 'content=<%s>\\n' "$OPENCODE_CONFIG_CONTENT"
  printf 'external=<%s>\\n' "$OPENCODE_DISABLE_EXTERNAL_SKILLS"
  printf 'permission=<%s>\\n' "$OPENCODE_PERMISSION"
  for arg do printf 'arg=<%s>\\n' "$arg"; done
  printf 'END\\n'
} >> "$AUTOPROMPT_FAKE_LOG"
if [ "\${1-}" = '--version' ]; then
  printf '1.18.18\\n'
  exit 0
fi
if [ "\${1-}" = 'debug' ] && [ "\${2-}" = 'config' ]; then
  printf '%s\\n' "$AUTOPROMPT_FAKE_RESOLVED"
  exit "\${AUTOPROMPT_FAKE_DEBUG_EXIT:-0}"
fi
printf 'launched\\n'
exit "\${AUTOPROMPT_FAKE_LAUNCH_EXIT:-0}"
`)
  fs.chmodSync(target, 0o755)
}

function makePowerShellFake(sandbox) {
  const target = path.join(sandbox.bin, 'opencode.ps1')
  fs.writeFileSync(target, `$record = [ordered]@{
  args = @($args)
  config = $env:OPENCODE_CONFIG
  content = $env:OPENCODE_CONFIG_CONTENT
  external = $env:OPENCODE_DISABLE_EXTERNAL_SKILLS
  permission = $env:OPENCODE_PERMISSION
} | ConvertTo-Json -Compress
Add-Content -LiteralPath $env:AUTOPROMPT_FAKE_LOG -Value $record -Encoding UTF8
if ($args.Count -eq 1 -and $args[0] -ceq '--version') {
  Write-Output '1.18.18'
  exit 0
}
if ($args.Count -ge 2 -and $args[0] -ceq 'debug' -and $args[1] -ceq 'config') {
  Write-Output $env:AUTOPROMPT_FAKE_RESOLVED
  exit $(if ($env:AUTOPROMPT_FAKE_DEBUG_EXIT) { [int]$env:AUTOPROMPT_FAKE_DEBUG_EXIT } else { 0 })
}
Write-Output 'launched'
exit $(if ($env:AUTOPROMPT_FAKE_LAUNCH_EXIT) { [int]$env:AUTOPROMPT_FAKE_LAUNCH_EXIT } else { 0 })
`)
}

function runPosix(bash, sandbox, args, resolved = SAFE_RESOLVED) {
  const env = baseEnvironment(sandbox, resolved)
  env.HOME = toPosixPath(sandbox.home)
  env.XDG_CONFIG_HOME = toPosixPath(sandbox.xdg)
  env.AUTOPROMPT_FAKE_LOG = toPosixPath(sandbox.log)
  env.PATH = `${toPosixPath(sandbox.bin)}:/usr/bin:/bin`
  return childProcess.spawnSync(
    bash,
    ['--noprofile', '--norc', toPosixPath(POSIX_WRAPPER), ...args],
    { cwd: ROOT, encoding: 'utf8', env },
  )
}

function runPowerShell(sandbox, args, resolved = SAFE_RESOLVED) {
  const env = baseEnvironment(sandbox, resolved)
  env.PATH = `${sandbox.bin}${path.delimiter}${process.env.PATH || ''}`
  return childProcess.spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', POWERSHELL_WRAPPER, ...args],
    { cwd: ROOT, encoding: 'utf8', env },
  )
}

function assertUntouched(sandbox) {
  assert.equal(fs.readFileSync(sandbox.ordinaryConfig, 'utf8'), '{"share":"auto"}\n')
  assert.equal(fs.readFileSync(sandbox.credentials, 'utf8'), '{"token":"untouched"}\n')
  assert.match(fs.readFileSync(sandbox.duplicateClaudeSkill, 'utf8'), /external collision/)
}

test('POSIX wrapper binds the safe environment, verifies, and forwards arguments exactly', () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required to test launch-opencode.sh')
  const sandbox = makeSandbox()
  makePosixFake(sandbox)

  try {
    const checked = runPosix(bash, sandbox, ['--check'])
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`)
    assert.match(checked.stdout, /activation policy: ok/)
    let log = fs.readFileSync(sandbox.log, 'utf8')
    assert.equal((log.match(/^BEGIN$/gm) || []).length, 2)
    assert.match(log, new RegExp(`config=<${toPosixPath(sandbox.profile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`))
    assert.match(log, new RegExp(`content=<${POLICY_CONTENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`))
    assert.match(log, /external=<1>/)
    assert.match(log, new RegExp(`permission=<${TASK_PERMISSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`))
    assert.doesNotMatch(log, /arg=<run>/)

    fs.writeFileSync(sandbox.log, '')
    const launched = runPosix(bash, sandbox, ['run', 'hello world', 'semi;colon', '$literal', 'star*value'])
    assert.equal(launched.status, 0, `${launched.stdout}\n${launched.stderr}`)
    log = fs.readFileSync(sandbox.log, 'utf8')
    assert.equal((log.match(/^BEGIN$/gm) || []).length, 3)
    assert.match(log, /arg=<run>\narg=<hello world>\narg=<semi;colon>\narg=<\$literal>\narg=<star\*value>/)
    assertUntouched(sandbox)
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true })
  }
})

test('POSIX wrapper refuses a resolved task policy with an extra allow rule', () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required to test launch-opencode.sh')
  const sandbox = makeSandbox()
  makePosixFake(sandbox)
  const unsafe = JSON.stringify({
    subagent_depth: 4,
    share: 'disabled',
    permission: { task: { '*': 'deny', 'ap-*': 'allow', rogue: 'allow' } },
  }, null, 2)

  try {
    const completed = runPosix(bash, sandbox, ['run', 'must not launch'], unsafe)
    assert.notEqual(completed.status, 0)
    assert.match(completed.stderr, /resolved activation policy is unsafe/)
    const log = fs.readFileSync(sandbox.log, 'utf8')
    assert.equal((log.match(/^BEGIN$/gm) || []).length, 2)
    assert.doesNotMatch(log, /arg=<run>/)
    assertUntouched(sandbox)
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true })
  }
})

test('PowerShell wrapper binds the safe environment, verifies, and forwards arguments exactly', {
  skip: process.platform !== 'win32',
}, () => {
  const sandbox = makeSandbox()
  makePowerShellFake(sandbox)

  try {
    const checked = runPowerShell(sandbox, ['--check'])
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`)
    assert.match(checked.stdout, /activation policy: ok/)
    let calls = fs.readFileSync(sandbox.log, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(calls.length, 2)
    for (const call of calls) {
      assert.equal(path.normalize(call.config), sandbox.profile)
      assert.equal(call.content, POLICY_CONTENT)
      assert.equal(call.external, '1')
      assert.equal(call.permission, TASK_PERMISSION)
    }

    fs.writeFileSync(sandbox.log, '')
    const args = ['run', 'hello world', 'semi;colon', '$literal', 'star*value']
    const launched = runPowerShell(sandbox, args)
    assert.equal(launched.status, 0, `${launched.stdout}\n${launched.stderr}`)
    calls = fs.readFileSync(sandbox.log, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.at(-1).args, args)
    assertUntouched(sandbox)
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true })
  }
})

test('PowerShell wrapper refuses a resolved task policy with an extra allow rule', {
  skip: process.platform !== 'win32',
}, () => {
  const sandbox = makeSandbox()
  makePowerShellFake(sandbox)
  const unsafe = JSON.stringify({
    subagent_depth: 4,
    share: 'disabled',
    permission: { task: { '*': 'deny', 'ap-*': 'allow', rogue: 'allow' } },
  }, null, 2)

  try {
    const completed = runPowerShell(sandbox, ['run', 'must not launch'], unsafe)
    assert.notEqual(completed.status, 0)
    assert.match(completed.stderr, /resolved activation policy is unsafe/)
    const calls = fs.readFileSync(sandbox.log, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(calls.length, 2)
    assert.equal(calls.some(call => call.args[0] === 'run'), false)
    assertUntouched(sandbox)
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true })
  }
})
