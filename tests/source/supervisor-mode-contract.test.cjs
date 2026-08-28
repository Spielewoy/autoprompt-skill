#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { runOwnedHarnessScenario } = require('../fixtures/codex-supervisor-contract-dry-run.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const PUBLIC_PROVIDERS = [
  'claude',
  'codex',
  'opencode',
  'kilo',
  'vscode',
  'prime',
  'omp',
  'deepseek',
  'reasonix',
]
const EXTERNAL_SUPERVISOR_PROVIDERS = new Set(['claude', 'codex'])
const SUPERVISORS = [
  ['claude Bash', path.join(ROOT, 'agents', 'claude', 'workflow', 'supervisor.sh'), 'bash'],
  ['claude PowerShell', path.join(ROOT, 'agents', 'claude', 'workflow', 'supervisor.ps1'), 'powershell'],
  ['codex Bash', path.join(ROOT, 'agents', 'codex', 'workflow', 'supervisor.sh'), 'bash'],
  ['codex PowerShell', path.join(ROOT, 'agents', 'codex', 'workflow', 'supervisor.ps1'), 'powershell'],
]

test('all nine providers have an explicit external-supervisor scope-budget boundary', () => {
  assert.equal(PUBLIC_PROVIDERS.length, 9)
  for (const provider of PUBLIC_PROVIDERS) {
    const workflow = path.join(ROOT, 'agents', provider, 'workflow')
    const manifest = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'agents', 'manifests', `${provider}-runtime.json`),
      'utf8',
    ))
    const ports = ['supervisor.sh', 'supervisor.ps1'].filter((file) => (
      fs.existsSync(path.join(workflow, file))
    ))
    const budgetRuntime = manifest.files.filter((file) => (
      /^workflow\/(?:phase-budget\.js|supervisor\.(?:ps1|sh))$/.test(file)
    ))
    if (EXTERNAL_SUPERVISOR_PROVIDERS.has(provider)) {
      assert.deepEqual(ports, ['supervisor.sh', 'supervisor.ps1'], provider)
      assert.deepEqual(budgetRuntime, [
        'workflow/phase-budget.js',
        'workflow/supervisor.ps1',
        'workflow/supervisor.sh',
      ], provider)
      for (const port of ports) {
        const source = fs.readFileSync(path.join(workflow, port), 'utf8')
        assert.doesNotMatch(source, /SCOPE_BUDGET_TERMINAL|ScopeTerminal|(?:return|exit) 124/)
      }
    } else {
      assert.deepEqual(ports, [], `${provider} must not inherit the external scope-budget supervisor`)
      assert.deepEqual(budgetRuntime, [], `${provider} must not package the external scope-budget runtime`)
      for (const file of manifest.files) {
        const source = fs.readFileSync(path.join(ROOT, manifest.sourceRoot, file), 'utf8')
        assert.doesNotMatch(
          source,
          /AUTOPROMPT_SCOPE_(?:SOFT|HARD|GRACE)|SCOPE-(?:BUDGET-BREACH|CONVERGE-REQUEST)|MAX_SCOPE_RESETS/,
          `${provider}:${file}`,
        )
      }
    }
  }
})

test('affected provider skills define scope markers as post-relaunch durable hints', () => {
  for (const provider of EXTERNAL_SUPERVISOR_PROVIDERS) {
    const skill = fs.readFileSync(path.join(ROOT, 'agents', provider, 'SKILL.md'), 'utf8')
    assert.match(skill, /SCOPE-BUDGET-BREACH/)
    assert.match(skill, /SCOPE-CONVERGE-REQUEST/)
    assert.match(skill, /durable disk hints, not live steering/)
    assert.match(skill, /AUTOPROMPT_RESUME=1/)
  }

  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'manifests', 'codex-runtime.json'), 'utf8',
  ))
  assert.equal(manifest.files.some(file => /contract-dry-run|tests\/fixtures/.test(file)), false,
    'the source-only driver has no production manifest export')

  const copiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-copied-supervisor-'))
  try {
    const fakeRuntime = path.join(copiedRoot, 'phase-budget.js')
    fs.writeFileSync(fakeRuntime,
      "process.stdout.write('STRICT_RUNTIME_REACHED\\n'); process.exitCode = 77\n")
    for (const [label, source, port] of SUPERVISORS.filter(([name]) => name.startsWith('codex '))) {
      const copy = path.join(copiedRoot, path.basename(source))
      fs.copyFileSync(source, copy)
      const env = {
        ...process.env,
        AUTOPROMPT_MODE: 'tokensaver',
        AUTOPROMPT_RUNTIME: fakeRuntime,
        AUTOPROMPT_TEST_SOURCE_ROOT: port === 'bash' ? bashPath(ROOT) : ROOT,
        AUTOPROMPT_TEST_CONTRACT_DRIVER: port === 'bash'
          ? bashPath(path.join(ROOT, 'tests', 'fixtures', 'codex-supervisor-contract-dry-run.cjs'))
          : path.join(ROOT, 'tests', 'fixtures', 'codex-supervisor-contract-dry-run.cjs'),
        AUTOPROMPT_TEST_CONTRACT_FILE: port === 'bash' ? bashPath(__filename) : __filename,
      }
      const completed = port === 'bash'
        ? childProcess.spawnSync(GIT_BASH, [bashPath(copy), '--dry-run', 'copied boundary'],
            { cwd: ROOT, encoding: 'utf8', env, timeout: 10000 })
        : childProcess.spawnSync(POWERSHELL, [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copy,
            '--dry-run', 'copied boundary',
          ], { cwd: ROOT, encoding: 'utf8', env, timeout: 10000 })
      assert.equal(completed.status, 77, `${label}: ${completed.stdout}\n${completed.stderr}`)
      assert.match(completed.stdout, /STRICT_RUNTIME_REACHED/, label)
    }
  } finally {
    fs.rmSync(copiedRoot, { recursive: true, force: true })
  }
})

test('AP-RUN-012 modern Codex shell adapters ignore unrelated legacy SENTINEL variables', () => {
  const copiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-sentinel-override-'))
  try {
    const fakeRuntime = path.join(copiedRoot, 'phase-budget.js')
    fs.writeFileSync(fakeRuntime, "process.stdout.write('STRICT_RUNTIME_REACHED\\n'); process.exitCode = 77\n")
    for (const [label, source, port] of SUPERVISORS.filter(([name]) => name.startsWith('codex '))) {
      const copy = path.join(copiedRoot, path.basename(source))
      fs.copyFileSync(source, copy)
      const env = { ...process.env, AUTOPROMPT_RUNTIME: fakeRuntime, SENTINEL: 'custom-stop-file' }
      const completed = port === 'bash'
        ? childProcess.spawnSync(GIT_BASH, [bashPath(copy), 'sentinel rejection'],
            { cwd: ROOT, encoding: 'utf8', env, timeout: 10000 })
        : childProcess.spawnSync(POWERSHELL, [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copy,
            'sentinel rejection',
          ], { cwd: ROOT, encoding: 'utf8', env, timeout: 10000 })
      assert.equal(completed.status, 77, `${label}: ${completed.stdout}\n${completed.stderr}`)
      assert.match(completed.stdout, /STRICT_RUNTIME_REACHED/, label)
      assert.doesNotMatch(completed.stderr, /LEGACY_SENTINEL_UNSUPPORTED/, label)
    }
  } finally {
    fs.rmSync(copiedRoot, { recursive: true, force: true })
  }
})

function bashPath(value) {
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
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
    AUTOPROMPT_TEST_SOURCE_ROOT: port === 'bash' ? bashPath(ROOT) : ROOT,
    AUTOPROMPT_TEST_CONTRACT_DRIVER: port === 'bash'
      ? bashPath(path.join(ROOT, 'tests', 'fixtures', 'codex-supervisor-contract-dry-run.cjs'))
      : path.join(ROOT, 'tests', 'fixtures', 'codex-supervisor-contract-dry-run.cjs'),
    AUTOPROMPT_TEST_CONTRACT_FILE: port === 'bash'
      ? bashPath(__filename) : __filename,
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

test('AP-RUN-037/038 scope resume and reset-cap escalation are event-driven with fresh budgets', {
  timeout: 10_000,
}, async () => {
  const success = await runOwnedHarnessScenario('success')
  assert.equal(success.outcome, 'DONE', success.stderr)
  assert.equal(success.trigger, 'terminal-event')
  assert.equal(success.watchdogFired, false)
  assert.deepEqual(success.residue, [], `owned process residue: ${success.residue.join(', ')}`)

  const launches = success.events.filter(event => event.type === 'generation.started')
  assert.deepEqual(launches.map(event => [event.generation, event.resume]), [[1, false], [2, true]])
  assert.notEqual(launches[1].budgetWindow.id, launches[0].budgetWindow.id)
  assert.equal(launches[1].budgetWindow.previousWindowId, launches[0].budgetWindow.id)
  assert.equal(launches[1].budgetWindow.openedBy, 'resume-launch')
  assert.equal(launches[1].budgetWindow.consumedUnits, 0)
  assert.equal(launches[1].budgetWindow.remainingUnits, launches[1].budgetWindow.initialBudgetUnits)

  const escalation = await runOwnedHarnessScenario('escalation')
  assert.equal(escalation.outcome, 'BLOCKED', escalation.stderr)
  assert.equal(escalation.trigger, 'terminal-event')
  assert.equal(escalation.watchdogFired, false)
  assert.deepEqual(escalation.residue, [], `owned process residue: ${escalation.residue.join(', ')}`)
  const cap = escalation.events.find(event => event.type === 'reset-cap-escalated')
  assert.deepEqual(cap, {
    type: 'reset-cap-escalated', generation: 2, maxScopeResets: 1,
    residual: ['repository', 'tests'], outcome: 'BLOCKED',
  })
})

test('AP-RUN-037 scope timeout is outer-watchdog bounded and drains every registered process group', {
  timeout: 10_000,
}, async () => {
  const result = await runOwnedHarnessScenario('timeout', { watchdogMs: 500 })
  assert.equal(result.outcome, 'HARNESS_WATCHDOG_TIMEOUT', result.stderr)
  assert.equal(result.trigger, 'outer-watchdog')
  assert.equal(result.watchdogFired, true)
  assert.ok(result.ownedGroups.length >= 2, 'fixture must register its helper process group')
  assert.equal(result.events.some(event => event.type === 'scenario.completed'), false)
  assert.deepEqual(result.residue, [], `owned process residue: ${result.residue.join(', ')}`)
})

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
