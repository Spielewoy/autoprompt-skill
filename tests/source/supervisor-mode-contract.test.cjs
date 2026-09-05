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
const BASH = process.platform === 'win32' ? GIT_BASH : 'bash'
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const HAS_BASH = process.platform === 'win32'
  ? fs.existsSync(GIT_BASH)
  : childProcess.spawnSync(BASH, ['--version'], { stdio: 'ignore' }).status === 0
const HAS_POWERSHELL = process.platform === 'win32' || childProcess.spawnSync(
  POWERSHELL,
  ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
  { stdio: 'ignore', windowsHide: true },
).status === 0
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
const EVENT_DRIVEN_SCOPE_PROVIDERS = new Set(['codex'])
const SUPERVISORS = [
  ['claude Bash', path.join(ROOT, 'agents', 'claude', 'workflow', 'supervisor.sh'), 'bash'],
  ['claude PowerShell', path.join(ROOT, 'agents', 'claude', 'workflow', 'supervisor.ps1'), 'powershell'],
  ['codex Bash', path.join(ROOT, 'agents', 'codex', 'workflow', 'supervisor.sh'), 'bash'],
  ['codex PowerShell', path.join(ROOT, 'agents', 'codex', 'workflow', 'supervisor.ps1'), 'powershell'],
]

function supervisorPortAvailable(port) {
  return port === 'bash' ? HAS_BASH : HAS_POWERSHELL
}

test('external supervisors are packaged and Codex v2 scope budgets are event-driven', () => {
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
      for (const port of EVENT_DRIVEN_SCOPE_PROVIDERS.has(provider) ? ports : []) {
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

test('Codex v2 skill defines scope markers as post-relaunch durable hints', () => {
  for (const provider of EVENT_DRIVEN_SCOPE_PROVIDERS) {
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
    fs.writeFileSync(fakeRuntime, [
      "if (process.argv.slice(2).join(' ') === '--supervisor --capabilities') {",
      "  process.stdout.write(JSON.stringify({ schemaVersion: 2, provider: 'codex' }))",
      '} else {',
      "  process.stdout.write('STRICT_RUNTIME_REACHED\\n')",
      '  process.exitCode = 77',
      '}',
      '',
    ].join('\n'))
    const available = SUPERVISORS.filter(([name, , port]) =>
      name.startsWith('codex ') && supervisorPortAvailable(port))
    assert.ok(available.length > 0, 'at least one Codex supervisor port must be runnable')
    for (const [label, source, port] of available) {
      const copy = path.join(copiedRoot, path.basename(source))
      fs.copyFileSync(source, copy)
      const env = {
        ...process.env,
        AUTOPROMPT_MODE: 'tokensaver',
        // Let each shell select its adjacent controller in its own path dialect.
        AUTOPROMPT_RUNTIME: '',
        AUTOPROMPT_TEST_SOURCE_ROOT: port === 'bash' ? bashPath(ROOT) : ROOT,
        AUTOPROMPT_TEST_CONTRACT_DRIVER: port === 'bash'
          ? bashPath(path.join(ROOT, 'tests', 'fixtures', 'codex-supervisor-contract-dry-run.cjs'))
          : path.join(ROOT, 'tests', 'fixtures', 'codex-supervisor-contract-dry-run.cjs'),
        AUTOPROMPT_TEST_CONTRACT_FILE: port === 'bash' ? bashPath(__filename) : __filename,
      }
      const completed = port === 'bash'
        ? childProcess.spawnSync(BASH, [bashPath(copy), '--dry-run', 'copied boundary'],
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
    fs.writeFileSync(fakeRuntime, [
      "if (process.argv.slice(2).join(' ') === '--supervisor --capabilities') {",
      "  process.stdout.write(JSON.stringify({ schemaVersion: 2, provider: 'codex' }))",
      '} else {',
      "  process.stdout.write('STRICT_RUNTIME_REACHED\\n')",
      '  process.exitCode = 77',
      '}',
      '',
    ].join('\n'))
    const available = SUPERVISORS.filter(([name, , port]) =>
      name.startsWith('codex ') && supervisorPortAvailable(port))
    assert.ok(available.length > 0, 'at least one Codex supervisor port must be runnable')
    for (const [label, source, port] of available) {
      const copy = path.join(copiedRoot, path.basename(source))
      fs.copyFileSync(source, copy)
      const env = { ...process.env, AUTOPROMPT_RUNTIME: '', SENTINEL: 'custom-stop-file' }
      const completed = port === 'bash'
        ? childProcess.spawnSync(BASH, [bashPath(copy), 'sentinel rejection'],
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

test('Codex Bash accepts its exact canonical runtime and rejects a foreign controller before execution', {
  skip: !HAS_BASH,
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt bash runtime binding '))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const script = path.join(directory, 'supervisor.sh')
  const trace = path.join(directory, 'runtime-trace.jsonl')
  fs.copyFileSync(path.join(ROOT, 'agents/codex/workflow/supervisor.sh'), script)
  const runtimeSource = [
    "const args = process.argv.slice(2)",
    `require('node:fs').appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args)+'\\n')`,
    "if (JSON.stringify(args) === JSON.stringify(['--supervisor','--capabilities'])) {",
    "  process.stdout.write(JSON.stringify({schemaVersion:2,provider:'codex'}))",
    "} else process.exitCode = 77", '',
  ].join('\n')
  fs.writeFileSync(path.join(directory, 'phase-budget.js'), runtimeSource)
  const foreignRuntime = path.join(directory, 'foreign-runtime.js')
  fs.writeFileSync(foreignRuntime, runtimeSource)
  const env = { ...process.env, AUTOPROMPT_MODE: 'tokensaver', AUTOPROMPT_RUNTIME: '' }
  // Obtain the same physical Bash spelling as the adapter, including Windows
  // short-name expansion. A Windows-to-POSIX slash rewrite alone is not enough.
  const canonical = childProcess.spawnSync(BASH, ['-c', [
    'set -eu',
    'fixture_script=$1',
    'fixture_parent=$(CDPATH= cd -- "$(dirname -- "$fixture_script")" && pwd -P)',
    'AUTOPROMPT_RUNTIME="$fixture_parent/phase-budget.js"',
    'export AUTOPROMPT_RUNTIME',
    'exec "$BASH" "$fixture_script" "explicit binding"',
  ].join('\n'), 'runtime-binding-fixture', bashPath(script)], {
    cwd: ROOT, encoding: 'utf8', env, timeout: 10000,
  })
  assert.equal(canonical.status, 77, `${canonical.stdout}\n${canonical.stderr}`)
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse), [
    ['--supervisor', '--capabilities'], ['--supervisor', 'explicit binding'],
  ])
  fs.unlinkSync(trace)
  const rejected = childProcess.spawnSync(BASH, [bashPath(script), 'foreign binding'], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000,
    env: { ...env, AUTOPROMPT_RUNTIME: bashPath(foreignRuntime) },
  })
  assert.equal(rejected.status, 2, `${rejected.stdout}\n${rejected.stderr}`)
  assert.match(rejected.stderr, /ALTERNATE_RUNTIME_UNSUPPORTED/)
  assert.equal(fs.existsSync(trace), false, 'neither controller may execute for an alternate override')
})

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function codexPowerShellNodeFixture(t) {
  const discovery = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-Command',
    '@{ executable = (Get-Process -Id $PID).Path; major = $PSVersionTable.PSVersion.Major } | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', timeout: 10000 })
  assert.equal(discovery.status, 0, discovery.stderr)
  const powershell = JSON.parse(discovery.stdout)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt node resolution '))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const nodePaths = ['first node', 'second node'].map(name => {
    const bin = path.join(directory, name)
    fs.mkdirSync(bin)
    const executable = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node')
    fs.copyFileSync(process.execPath, executable)
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o700)
    return executable
  })
  const script = path.join(directory, 'supervisor.ps1')
  fs.copyFileSync(path.join(ROOT, 'agents/codex/workflow/supervisor.ps1'), script)
  const runtime = path.join(directory, 'phase-budget.js')
  const trace = path.join(directory, 'node-trace.jsonl')
  fs.writeFileSync(runtime, [
    "const fs = require('node:fs')",
    "const args = process.argv.slice(2)",
    "fs.appendFileSync(process.env.AUTOPROMPT_TEST_NODE_TRACE, JSON.stringify({node:process.execPath,args})+'\\n')",
    "if (JSON.stringify(args) === JSON.stringify(['--supervisor','--capabilities'])) {",
    "  process.stdout.write(JSON.stringify({schemaVersion:2,provider:'codex'}))",
    "} else process.exitCode = 77", '',
  ].join('\n'))
  const environment = {
    ...process.env,
    PATH: [...nodePaths.map(value => path.dirname(value)), process.env.PATH || ''].join(path.delimiter),
    AUTOPROMPT_MODE: 'tokensaver', AUTOPROMPT_RUNTIME: runtime,
    AUTOPROMPT_TEST_NODE_TRACE: trace,
  }
  return { directory, environment, nodePaths, powershell, runtime, script, trace }
}

test('Codex PowerShell resolves one PATH application and preserves native arguments despite command shadows', {
  skip: !HAS_POWERSHELL,
}, async t => {
  const fixture = codexPowerShellNodeFixture(t)
  for (const shadow of [false, true]) await t.test(shadow ? 'alias and function shadows' : 'multiple PATH applications', () => {
    if (fs.existsSync(fixture.trace)) fs.unlinkSync(fixture.trace)
    const args = ['two words', '--leading-option', 'Unicode-ä-雪', 'trailing\\', 'semi;colon', 'dollar$sign']
    if (fixture.powershell.major >= 7) args.push('', 'embedded"quote')
    const program = [
      "$ErrorActionPreference = 'Stop'",
      'if (@(Get-Command node -CommandType Application).Count -lt 2) { throw "fixture requires two node applications" }',
      ...(shadow ? [
        'function global:node { throw "node function must not execute" }',
        'Set-Alias -Name node -Value Write-Error -Scope Global',
      ] : []),
      `$values = @(${args.map(powershellLiteral).join(', ')})`,
      `& ${powershellLiteral(fixture.script)} @values`,
      'exit $LASTEXITCODE',
    ].join('; ')
    const completed = childProcess.spawnSync(fixture.powershell.executable, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program,
    ], { encoding: 'utf8', env: fixture.environment, timeout: 20000 })
    assert.equal(completed.status, 77, `${completed.stdout}\n${completed.stderr}`)
    const calls = fs.readFileSync(fixture.trace, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(calls.length, 2, 'one controller probe and one actual runtime invocation')
    assert.ok(calls.every(call => fs.realpathSync(call.node) === fs.realpathSync(fixture.nodePaths[0])),
      'the first Application result in PATH order is the sole executable')
    assert.deepEqual(calls.map(call => call.args), [
      ['--supervisor', '--capabilities'], ['--supervisor', ...args],
    ])
  })
})

test('Codex PowerShell rejects a node command shadow when no PATH application exists', {
  skip: !HAS_POWERSHELL,
}, t => {
  const fixture = codexPowerShellNodeFixture(t)
  const emptyPath = path.join(fixture.directory, 'empty path')
  fs.mkdirSync(emptyPath)
  const program = [
    'function global:node { throw "node function must not execute" }',
    'Set-Alias -Name node -Value Write-Error -Scope Global',
    `& ${powershellLiteral(fixture.script)} 'ordinary request'`,
    'exit $LASTEXITCODE',
  ].join('; ')
  const completed = childProcess.spawnSync(fixture.powershell.executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program,
  ], { encoding: 'utf8', env: { ...fixture.environment, PATH: emptyPath }, timeout: 10000 })
  assert.equal(completed.status, 2, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stderr, /node is required for the canonical Codex runtime/u)
  assert.equal(fs.existsSync(fixture.trace), false)
})

test('Codex legacy PowerShell doctor invokes only the first node application', {
  skip: !HAS_POWERSHELL,
}, t => {
  const fixture = codexPowerShellNodeFixture(t)
  const helperDirectory = path.join(fixture.directory, 'scripts/install')
  fs.mkdirSync(helperDirectory, { recursive: true })
  const helper = path.join(helperDirectory, 'legacy-compat.cjs')
  fs.writeFileSync(helper, [
    "require('node:fs').appendFileSync(process.env.AUTOPROMPT_TEST_NODE_TRACE, JSON.stringify({node:process.execPath,args:process.argv.slice(2)})+'\\n')",
    '',
  ].join('\n'))
  const doctor = path.join(ROOT, 'scripts/install/doctor.ps1')
  const program = [
    "$ErrorActionPreference = 'Stop'",
    '$tokens = $null; $errors = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${powershellLiteral(doctor)}, [ref]$tokens, [ref]$errors)`,
    '$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq "Test-ClientLegacyCodexInstalled" }, $true)',
    'if ($null -eq $definition -or $errors.Count -ne 0) { throw "Codex doctor function must parse" }',
    'Invoke-Expression $definition.Extent.Text',
    `function Get-ConfigRoot { param($Client) ${powershellLiteral(fixture.directory)} }`,
    'function Test-IdemPathEqual { param($Left, $Right) $Left -ceq $Right }',
    `$RepoRoot = ${powershellLiteral(fixture.directory)}`,
    `if (-not (Test-ClientLegacyCodexInstalled -Root ${powershellLiteral(fixture.directory)})) { exit 42 }`,
  ].join('; ')
  const completed = childProcess.spawnSync(fixture.powershell.executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program,
  ], { encoding: 'utf8', env: fixture.environment, timeout: 10000 })
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  const calls = fs.readFileSync(fixture.trace, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(calls, [{ node: fixture.nodePaths[0], args: ['match', 'codex', fixture.directory] }])
})

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
        BASH,
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
    skip: !supervisorPortAvailable(port),
    timeout: 30000,
  }, () => {
    const custom = runSupervisor(script, port, 'custom', '4.9')
    assert.equal(custom.status, 1, `${custom.stdout}\n${custom.stderr}`)
    assert.match(custom.stdout, /mode=custom; per-L3 fan-out=up to 4 live per wave \(AUTOPROMPT_MAX_CONCURRENT\)/)
  })

  test(`${name} rejects custom mode without a positive numeric ceiling`, {
    skip: !supervisorPortAvailable(port),
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
