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
const INSTALL_DIR = path.join(ROOT, 'scripts', 'install')
const PS_LIB = path.join(INSTALL_DIR, 'lib', 'install-lib.ps1')
const SH_LIB = path.join(INSTALL_DIR, 'lib', 'install-lib.sh')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const PROBE_PREFIX = 'autoprompt-codex-probe-'

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    ...options,
  })
}

function commandAvailable(command) {
  return run(command, ['--version'], { timeout: 5000 }).status === 0
}

function powershellAvailable() {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    timeout: 5000,
  }).status === 0
}

function findBash() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
        'bash',
      ]
    : ['bash']
  return candidates.find(commandAvailable) || null
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function quoteShell(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function toShellPath(value) {
  if (process.platform !== 'win32') return value
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
}

function fromShellPath(value) {
  if (process.platform !== 'win32') return value
  return value.replace(/^\/([A-Za-z])(?=\/)/, (_, drive) => `${drive}:`).replaceAll('/', '\\')
}

function digestTree(root) {
  const rows = []
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`)
        visit(absolute)
      } else {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
        rows.push(`f:${relative}:${hash}`)
      }
    }
  }
  visit(root)
  return rows.sort()
}

function probeDirectories(tempRoot) {
  return fs.readdirSync(tempRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(PROBE_PREFIX))
    .map(entry => entry.name)
}

function physicalPath(filePath) {
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

function makeSandbox(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt codex isolation '))
  const home = path.join(root, 'caller home')
  const codexHome = path.join(home, 'codex config')
  const temp = path.join(root, 'isolated os temp')
  const bin = path.join(root, 'fake bin with spaces')
  const observation = path.join(root, 'observed codex home.txt')
  const postTimeout = path.join(root, 'timeout child survived.txt')
  for (const directory of [codexHome, temp, bin]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"sentinel":"secret"}\n')
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sentinel = "config"\n')

  fs.writeFileSync(path.join(bin, 'codex.cmd'), [
    '@echo off',
    'setlocal',
    '> "%AUTOPROMPT_OBSERVATION%" echo %CODEX_HOME%',
    'if not exist "%CODEX_HOME%\\tmp" mkdir "%CODEX_HOME%\\tmp"',
    '> "%CODEX_HOME%\\tmp\\fake-helper.txt" echo touched',
    'if /I "%AUTOPROMPT_FAKE_MODE%"=="failure" exit /b 19',
    'if /I not "%AUTOPROMPT_FAKE_MODE%"=="timeout" goto success',
    ':timeout_loop',
    'if not exist "%CODEX_HOME%\\tmp" mkdir "%CODEX_HOME%\\tmp"',
    '> "%CODEX_HOME%\\tmp\\fake-helper.txt" echo touched',
    '> "%AUTOPROMPT_POST_TIMEOUT%" echo survived',
    'ping 127.0.0.1 -n 2 >nul',
    'goto timeout_loop',
    ':success',
    'echo codex-cli 0.147.0',
    'exit /b 0',
    '',
  ].join('\r\n'))

  const shellCodex = path.join(bin, 'codex')
  fs.writeFileSync(shellCodex, [
    '#!/bin/sh',
    'printf "%s\\n" "$CODEX_HOME" > "$AUTOPROMPT_OBSERVATION"',
    'mkdir -p "$CODEX_HOME/tmp"',
    'printf "touched\\n" > "$CODEX_HOME/tmp/fake-helper.txt"',
    'case "$AUTOPROMPT_FAKE_MODE" in',
    '  failure) exit 19 ;;',
    '  timeout)',
    '    while :; do',
    '      mkdir -p "$CODEX_HOME/tmp"',
    '      printf "touched\\n" > "$CODEX_HOME/tmp/fake-helper.txt"',
    '      printf "survived\\n" > "$AUTOPROMPT_POST_TIMEOUT"',
    '      sleep 1',
    '    done',
    '    ;;',
    'esac',
    'printf "codex-cli 0.147.0\\n"',
    '',
  ].join('\n'))
  fs.chmodSync(shellCodex, 0o755)

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return {
    root,
    home,
    codexHome,
    temp,
    bin,
    observation,
    postTimeout,
    mode,
    psEnv: {
      ...process.env,
      AUTOPROMPT_FAKE_MODE: mode,
      AUTOPROMPT_OBSERVATION: observation,
      AUTOPROMPT_POST_TIMEOUT: postTimeout,
      CODEX_HOME: codexHome,
      HOME: home,
      PATH: [
        bin,
        path.join(systemRoot, 'System32'),
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      ].join(path.delimiter),
      TEMP: temp,
      TMP: temp,
      USERPROFILE: home,
    },
    shEnv: {
      ...process.env,
      AUTOPROMPT_FAKE_MODE: mode,
      AUTOPROMPT_OBSERVATION: toShellPath(observation),
      AUTOPROMPT_POST_TIMEOUT: toShellPath(postTimeout),
      CODEX_HOME: toShellPath(codexHome),
      HOME: toShellPath(home),
      PATH: `${toShellPath(bin)}:/usr/bin:/bin`,
      TEMP: toShellPath(temp),
      TMP: toShellPath(temp),
      TMPDIR: toShellPath(temp),
    },
  }
}

function runPowerShellDetector(context, timeoutSeconds = 3, commandTimeout = 30000) {
  const command = [
    `. ${quotePowerShell(PS_LIB)}`,
    `$AutopromptProbeTimeout = ${timeoutSeconds}`,
    '$writer = [IO.StringWriter]::new()',
    '$prior = [Console]::Out',
    'try { [Console]::SetOut($writer); $code = Detect-Client -Name codex } finally { [Console]::SetOut($prior) }',
    '[Console]::Out.WriteLine("RESULT_CODE=$code")',
    '[Console]::Out.WriteLine("RESULT_RECORD=$($writer.ToString().Trim())")',
    'exit 0',
  ].join('; ')
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env: context.psEnv, timeout: commandTimeout })
}

function runShellDetector(bash, context, timeoutSeconds = 3, commandTimeout = 30000) {
  const command = [
    `source ${quoteShell(toShellPath(SH_LIB))}`,
    `AUTOPROMPT_PROBE_TIMEOUT=${timeoutSeconds}`,
    'record=$(detect_client codex)',
    'code=$?',
    'printf "RESULT_CODE=%s\\nRESULT_RECORD=%s\\n" "$code" "$record"',
    'exit 0',
  ].join('\n')
  return run(bash, ['--noprofile', '--norc', '-c', command], {
    env: context.shEnv,
    timeout: commandTimeout,
  })
}

function runPowerShellDoctor(context) {
  const doctor = path.join(INSTALL_DIR, 'doctor.ps1')
  const command = `& ${quotePowerShell(doctor)} codex; exit $LASTEXITCODE`
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env: context.psEnv })
}

function runShellDoctor(bash, context) {
  const doctor = toShellPath(path.join(INSTALL_DIR, 'doctor.sh'))
  return run(bash, ['--noprofile', '--norc', doctor, 'codex'], { env: context.shEnv })
}

function assertIsolatedProbe(context, flavor, before) {
  assert.equal(fs.existsSync(context.observation), true, `${flavor}: fake Codex was not invoked`)
  const observed = fs.readFileSync(context.observation, 'utf8').trim()
  const observedNative = flavor === 'PowerShell' ? observed : fromShellPath(observed)
  const canonicalObserved = physicalPath(observedNative)
  const expectedTemp = physicalPath(context.temp)
  const expectedCaller = physicalPath(context.codexHome)
  assert.notEqual(
    canonicalObserved.toLowerCase(),
    expectedCaller.toLowerCase(),
    `${flavor}: caller CODEX_HOME used`,
  )
  assert.equal(
    canonicalObserved.toLowerCase().startsWith(
      `${expectedTemp.toLowerCase()}${path.sep}${PROBE_PREFIX}`,
    ),
    true,
    `${flavor}: probe was not under isolated OS temp: ${observed}`,
  )
  assert.deepEqual(digestTree(context.codexHome), before, `${flavor}: caller CODEX_HOME changed`)
  assert.deepEqual(probeDirectories(context.temp), [], `${flavor}: disposable CODEX_HOME leaked`)
}

test('Codex detector isolates and cleans its version probe on success and failure in both ports', {
  skip: !powershellAvailable() || !findBash(),
  timeout: 30000,
}, () => {
  const bash = findBash()
  for (const mode of ['success', 'failure']) {
    for (const flavor of ['PowerShell', 'POSIX']) {
      const context = makeSandbox(mode)
      try {
        const before = digestTree(context.codexHome)
        const result = flavor === 'PowerShell'
          ? runPowerShellDetector(context)
          : runShellDetector(bash, context)
        assert.equal(result.status, 0, `${flavor} ${mode}\n${result.stdout}\n${result.stderr}`)
        assert.match(result.stdout, /RESULT_CODE=0/)
        assert.match(
          result.stdout,
          mode === 'success'
            ? /RESULT_RECORD=client=codex present=true version=0\.147\.0/
            : /RESULT_RECORD=client=codex present=true version=unknown/,
        )
        assertIsolatedProbe(context, flavor, before)
      } finally {
        fs.rmSync(context.root, { recursive: true, force: true })
      }
    }
  }
})

test('Codex detector terminates timed out probes and leaves no disposable home in both ports', {
  skip: !powershellAvailable() || !findBash(),
  timeout: 90000,
}, async () => {
  const bash = findBash()
  for (const flavor of ['PowerShell', 'POSIX']) {
    const context = makeSandbox('timeout')
    try {
      const before = digestTree(context.codexHome)
      const result = flavor === 'PowerShell'
        ? runPowerShellDetector(context, 5, 45000)
        : runShellDetector(bash, context, 2, 45000)
      assert.equal(result.status, 0, `${flavor} timeout\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /RESULT_CODE=0/)
      assert.match(result.stdout, /RESULT_RECORD=client=codex present=true version=unknown/)
      assertIsolatedProbe(context, flavor, before)
      fs.rmSync(context.postTimeout, { force: true })
      await new Promise(resolve => setTimeout(resolve, 1500))
      assert.equal(fs.existsSync(context.postTimeout), false, `${flavor}: timed out child survived`)
      assert.deepEqual(probeDirectories(context.temp), [], `${flavor}: timed out home reappeared`)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }
})

test('Codex doctor reports the version without changing caller CODEX_HOME in both ports', {
  skip: !powershellAvailable() || !findBash(),
  timeout: 30000,
}, () => {
  const bash = findBash()
  for (const flavor of ['PowerShell', 'POSIX']) {
    const context = makeSandbox('success')
    try {
      const before = digestTree(context.codexHome)
      const result = flavor === 'PowerShell'
        ? runPowerShellDoctor(context)
        : runShellDoctor(bash, context)
      assert.equal(result.status, 0, `${flavor} doctor\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /^codex\s+yes\s+no\s+no\s+version=0\.147\.0\b/m)
      assertIsolatedProbe(context, flavor, before)
    } finally {
      fs.rmSync(context.root, { recursive: true, force: true })
    }
  }
})
