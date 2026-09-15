'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const pkg = require('../../scripts/harness-v2-package.cjs')
const ROOT = path.resolve(__dirname, '../..')
function execute(command, args, options = {}) { return cp.spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options }) }
function ok(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`); return result }function requiresNative(result) {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /activation=(?:unavailable|attestation-required)/)
  assert.match(result.stdout, /extras=complete/)
  return result
}

function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
const POWER_SHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const HAS_POWER_SHELL = execute(POWER_SHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0
function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'].filter(Boolean)
  const found = candidates.find(file => fs.existsSync(file))
  assert.ok(found, 'npm CLI must be available for the packed lifecycle test'); return found
}

function writeVersionProbe(bin, command, version) {
  if (process.platform === 'win32') {
    // Keep both probes safe: PowerShell can discover .cmd applications through
    // Get-Command, while the native JS locator intentionally selects .cmd.
    write(path.join(bin, `${command}.cmd`), [
      '@echo off',
      'if "%~1"=="--version" (echo ' + version + '& exit /b 0)',
      'if "%~1"=="-v" (echo ' + version + '& exit /b 0)',
      'echo VERSION PROBE ONLY 1>&2',
      'exit /b 93',
      '',
    ].join('\r\n'))
    write(path.join(bin, `${command}.ps1`), [
      'param([string]$Flag)',
      `if ($Flag -in @('--version', '-v')) { Write-Output '${version}'; exit 0 }`,
      "[Console]::Error.WriteLine('VERSION PROBE ONLY')",
      'exit 93',
      '',
    ].join('\r\n'))
    return
  }
  const target = path.join(bin, command)
  write(target, `#!/bin/sh\ncase "$1" in --version|-v) printf '%s\\n' '${version}' ;; *) echo 'VERSION PROBE ONLY' >&2; exit 93 ;; esac\n`)
  fs.chmodSync(target, 0o700)
}

function packedEnvironment(directory, bin) {
  const home = path.join(directory, 'home with spaces')
  const xdg = path.join(directory, 'xdg config with spaces')
  const appData = path.join(directory, 'appdata with spaces')
  const localAppData = path.join(directory, 'localappdata with spaces')
  for (const folder of [home, xdg, appData, localAppData, bin, path.join(directory, 'temp with spaces')]) fs.mkdirSync(folder, { recursive: true })
  return {
    ...process.env,
    APPDATA: appData,
    HOME: home,
    LOCALAPPDATA: localAppData,
    PATH: [bin, path.dirname(process.execPath), process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    TEMP: path.join(directory, 'temp with spaces'),
    TMP: path.join(directory, 'temp with spaces'),
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  }
}

test('packed artifact installs and verifies all public providers without the checkout or network', { timeout: 900000 }, async t => {
  // The space in this prefix is deliberate: it exercises npm, Node, and the
  // installer ports with paths that need quoting on every supported host.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt packed v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, 'version probes')
  const env = { ...packedEnvironment(directory, bin), npm_config_cache: path.join(directory, 'npm cache') }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_dry_run') delete env[key]
  delete env.AUTOPROMPT_INSTALL_ROOT
  const packed = ok(execute(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: ROOT, env }))
  const record = JSON.parse(packed.stdout)[0]
  const tarball = path.join(directory, record.filename)
  const installPrefix = path.join(directory, 'installed cli')
  ok(execute(process.execPath, [npmCli(), 'install', '--ignore-scripts', '--offline', '--prefix', installPrefix, tarball], { cwd: directory, env }))
  const source = path.join(installPrefix, 'node_modules', 'autoprompt-skill')
  assert.ok(fs.existsSync(path.join(source, 'package.json')), 'npm install must reopen the packed package')
  // The distributable itself must contain the bundled dependency. Copying it
  // from this checkout would conceal a broken npm artifact.
  assert.ok(fs.existsSync(path.join(source, 'node_modules/@iarna/toml/package.json')), 'npm tarball must bundle the TOML parser')
  for (const name of ['package', 'configure', 'native', 'transport']) assert.ok(fs.existsSync(path.join(source, `scripts/harness-v2-${name}.cjs`)), `missing packaged helper ${name}`)
  assert.ok(fs.existsSync(path.join(source, 'scripts/install/harness-v2-legacy.json')))
  const helper = path.join(source, 'scripts/harness-v2-package.cjs')
  const publicCli = path.join(source, 'bin/autoprompt.cjs')
  const versions = { claude: ['claude', '2.1.141'], opencode: ['opencode', '1.5.7'], kilo: ['kilo', '7.1.0'], vscode: ['code', '1.133.0'], prime: ['prime-agent', '0.7.2'], omp: ['omp', '17.4.0'], deepseek: ['dsh', '0.1.0-rc.7'], hermes: ['hermes', '0.21.1'], grok: ['grok', '1.0.13'] }
  for (const provider of pkg.PROVIDERS) await t.test(provider, () => {
    const root = path.join(directory, 'roots', provider)
    const [command, version] = versions[provider]
    writeVersionProbe(bin, command, version)
    const providerEnv = { ...env, PATH: [bin, env.PATH].join(path.delimiter) }
    const invoke = args => execute(process.execPath, [publicCli, ...args], { cwd: directory, env: providerEnv })
    write(path.join(root, 'config.json'), 'custom config stays byte-for-byte\n')
    write(path.join(root, 'agents/custom.md'), 'custom role\n')
    ok(invoke(['install', provider, '--root', root]))
    const verified = JSON.parse(ok(execute(process.execPath, [helper, 'verify', provider, '--root', root], { cwd: directory, env: providerEnv })).stdout)
    assert.match(verified.payloadGeneration, new RegExp(`^${provider}-v2\\.0\\.0-`))
    const receipt = JSON.parse(fs.readFileSync(path.join(root, pkg.receiptName(provider))))
    assert.ok(receipt.files[`agents/${provider}/VERSION`] || provider === 'prime')
    assert.ok(receipt.files['agents/codex/workflow/phase-budget.js'])
    ok(invoke(['configure', provider, '--agents', 'provider/test-model', '--root', root]))
    const modelFile = path.join(root, `.autoprompt-${provider}-models.json`)
    const modelBytes = fs.readFileSync(modelFile)
    assert.deepEqual(JSON.parse(modelBytes), { mode: 'explicit', selector: 'provider/test-model', models: ['provider/test-model'] })
    requiresNative(invoke(['doctor', provider, '--strict', '--root', root]))
    ok(invoke(['install', provider, '--root', root]))
    assert.deepEqual(fs.readFileSync(modelFile), modelBytes, 'idempotent update preserves selected models')
    ok(invoke(['uninstall', provider, '--root', root]))
    assert.deepEqual(fs.readFileSync(modelFile), modelBytes, 'uninstall preserves provider model configuration')
    assert.equal(fs.existsSync(pkg.launcherPath(provider, root)), false)
    assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), 'custom config stays byte-for-byte\n')
    assert.equal(fs.readFileSync(path.join(root, 'agents/custom.md'), 'utf8'), 'custom role\n')
  })

  // Provider-specific packages must also work through the same installed CLI.
  // Version-only fixtures prove installer dispatch, never native admission.
  for (const [provider, version, model] of [['codex', 'codex-cli 0.148.0', 'gpt-5.6-luna'], ['reasonix', 'reasonix 1.30.0', 'provider/test-model']]) {
    writeVersionProbe(bin, provider, version)
    await t.test(`public CLI ${provider}`, () => {
      const root = path.join(directory, 'provider-specific roots', provider)
      write(path.join(root, 'unrelated.txt'), 'preserve provider-specific user data\n')
      const invoke = args => execute(process.execPath, [publicCli, ...args], { cwd: directory, env })
      ok(invoke(['install', provider, '--root', root]))
      ok(invoke(['configure', provider, '--agents', model, '--root', root]))
      if (provider === 'reasonix') requiresNative(invoke(['doctor', provider, '--strict', '--root', root]))
      else if (process.platform === 'win32') {
        const doctor = requiresNative(invoke(['doctor', provider, '--strict', '--root', root]))
        assert.match(doctor.stdout, /reason=codex-windows-sandbox-identity-unavailable/)
      }
      else ok(invoke(['doctor', provider, '--strict', '--root', root]))
      ok(invoke(['install', provider, '--root', root]))
      ok(invoke(['uninstall', provider, '--root', root]))
      assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'preserve provider-specific user data\n')
    })
  }

  // Exercise the packed PowerShell entrypoints with the same artifact. On
  // Linux this uses the pinned pwsh binary; on Windows it uses powershell.exe.
  // Native macOS execution is covered by the workflow fixture only and is not
  // claimed by this Linux run.
  if (HAS_POWER_SHELL) {
    for (const provider of pkg.PROVIDERS) await t.test(`PowerShell ${provider}`, () => {
      const root = path.join(directory, 'PowerShell roots', provider)
      const providerEnv = { ...env, AUTOPROMPT_INSTALL_ROOT: root, PATH: [bin, env.PATH].join(path.delimiter) }
      write(path.join(root, 'config.json'), 'PowerShell custom config stays byte-for-byte\n')
      write(path.join(root, 'agents/custom.md'), 'PowerShell custom role\n')
      const invoke = (script, args = []) => execute(POWER_SHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(source, 'scripts/install', `${script}.ps1`), provider, ...args,
      ], { cwd: directory, env: providerEnv })
      ok(invoke('install'))
      ok(execute(process.execPath, [helper, 'verify', provider, '--root', root], { cwd: directory, env: providerEnv }))
      requiresNative(invoke('doctor', ['-Strict']))
      ok(invoke('uninstall'))
      assert.equal(fs.existsSync(pkg.launcherPath(provider, root)), false)
      assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), 'PowerShell custom config stays byte-for-byte\n')
      assert.equal(fs.readFileSync(path.join(root, 'agents/custom.md'), 'utf8'), 'PowerShell custom role\n')
    })
  } else {
    t.diagnostic('PowerShell packed lifecycle was not run: no pwsh/powershell.exe on PATH')
  }
})
