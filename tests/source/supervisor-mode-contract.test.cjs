#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const SUPERVISORS = [
  ['claude Bash', path.join(ROOT, 'agents', 'claude', 'workflow', 'supervisor.sh'), 'bash'],
  ['claude PowerShell', path.join(ROOT, 'agents', 'claude', 'workflow', 'supervisor.ps1'), 'powershell'],
  ['codex Bash', path.join(ROOT, 'agents', 'codex', 'workflow', 'supervisor.sh'), 'bash'],
  ['codex PowerShell', path.join(ROOT, 'agents', 'codex', 'workflow', 'supervisor.ps1'), 'powershell'],
]

function bashPath(value) {
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
}

function runSupervisor(script, port, mode, maxConcurrent) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-supervisor-mode-'))
  const ledger = path.join(sandbox, 'ledger')
  const env = {
    ...process.env,
    AUTOPROMPT_MODE: mode,
    FAKE_EXITS: '1',
    FAKE_POISON: '1',
    MAX_RESTARTS: '1',
    RETRY_BASE: '0',
  }
  if (maxConcurrent !== undefined) {
    env.AUTOPROMPT_MAX_CONCURRENT = maxConcurrent
  } else {
    delete env.AUTOPROMPT_MAX_CONCURRENT
  }

  try {
    if (port === 'bash') {
      return childProcess.spawnSync(
        GIT_BASH,
        [bashPath(script), '--dry-run', '--ledger-dir', bashPath(ledger), 'contract probe'],
        { cwd: ROOT, encoding: 'utf8', env, timeout: 30000 },
      )
    }
    return childProcess.spawnSync(
      POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '--dry-run',
        '--ledger-dir',
        ledger,
        'contract probe',
      ],
      { cwd: ROOT, encoding: 'utf8', env, timeout: 30000 },
    )
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

for (const [name, script, port] of SUPERVISORS) {
  test(`${name} declares all four public mode contracts`, () => {
    const source = fs.readFileSync(script, 'utf8')
    if (port === 'bash') {
      assert.match(source, /\n\s*tokensaver\)/)
      assert.match(source, /\n\s*wide\|billionaire\) FANOUT="wide up to the runtime ceiling"/)
      assert.match(source, /\n\s*custom\)/)
      assert.match(source, /AUTOPROMPT_MAX_CONCURRENT="\$CUSTOM_MAX"\s+export AUTOPROMPT_MAX_CONCURRENT/)
    } else {
      assert.match(source, /'tokensaver'\s+\{/)
      assert.match(source, /'wide'\s+\{ \$fanout = 'wide up to the runtime ceiling'/)
      assert.match(source, /'billionaire'\s+\{ \$fanout = 'wide up to the runtime ceiling'/)
      assert.match(source, /'custom'\s+\{/)
      assert.match(source, /\$env:AUTOPROMPT_MAX_CONCURRENT = \[string\]\$customMax/)
    }
    assert.match(source, /AUTOPROMPT_MAX_CONCURRENT/)
    assert.match(source, /custom mode requires a positive numeric AUTOPROMPT_MAX_CONCURRENT/)
  })

  test(`${name} preserves and reports a bounded custom mode`, {
    skip: port === 'bash' && (process.platform !== 'win32' || !fs.existsSync(GIT_BASH)),
    timeout: 30000,
  }, () => {
    const custom = runSupervisor(script, port, 'custom', '4.9')
    assert.equal(custom.status, 1, `${custom.stdout}\n${custom.stderr}`)
    assert.match(custom.stdout, /mode=custom; per-L3 fan-out=up to 4 live per wave \(AUTOPROMPT_MAX_CONCURRENT\)/)
  })

  test(`${name} rejects custom mode without a positive numeric ceiling`, {
    skip: port === 'bash' && (process.platform !== 'win32' || !fs.existsSync(GIT_BASH)),
    timeout: 30000,
  }, () => {
    for (const value of [undefined, '0', '-1', 'not-a-number']) {
      const completed = runSupervisor(script, port, 'custom', value)
      assert.equal(completed.status, 2, `${completed.stdout}\n${completed.stderr}`)
      assert.match(completed.stderr, /custom mode requires a positive numeric AUTOPROMPT_MAX_CONCURRENT/)
      assert.doesNotMatch(completed.stdout, /starting:/)
    }
  })
}
