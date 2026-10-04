#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const pkg = require('../../scripts/harness-v2-package.cjs')
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'package.json'),
  'utf8',
)).version
// Reasonix v2 lifecycle coverage lives in reasonix-v2.test.cjs.
const PROVIDERS = Object.freeze({
  omp: Object.freeze({ command: 'omp', version: 'omp/17.4.0' }),
  deepseek: Object.freeze({ command: 'dsh', version: '0.1.0-rc.7' }),
})

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
  ].filter(Boolean)
  const npmCli = candidates.find(candidate => fs.existsSync(candidate))
  assert.ok(npmCli, `could not locate npm CLI; checked ${candidates.join(', ')}`)
  return npmCli
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 240000,
    ...options,
  })
}

function runNpm(args, options = {}) {
  const env = { ...(options.env ?? process.env) }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_dry_run') delete env[key]
  }
  return run(process.execPath, [npmCliPath(), ...args], { ...options, env })
}

function makeEnvironment(sandbox, bin) {
  const home = path.join(sandbox, 'home')
  const xdg = path.join(sandbox, 'xdg')
  const appData = path.join(sandbox, 'appdata')
  const localAppData = path.join(sandbox, 'localappdata')
  const temp = path.join(sandbox, 'tmp')
  for (const directory of [home, xdg, appData, localAppData, temp, bin]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  return {
    ...process.env,
    APPDATA: appData,
    HOME: home,
    LOCALAPPDATA: localAppData,
    PATH: [bin, process.env.PATH || ''].join(path.delimiter),
    TEMP: temp,
    TMP: temp,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
}

function writeFakeHarness(bin, provider) {
  const entry = PROVIDERS[provider]
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(bin, `${entry.command}.cmd`),
      `@echo off\r\nif "%~1"=="--version" (echo ${entry.version}& exit /b 0)\r\nif "%~1"=="-v" (echo ${entry.version}& exit /b 0)\r\necho VERSION PROBE ONLY 1>&2\r\nexit /b 93\r\n`,
    )
    return
  }
  const target = path.join(bin, entry.command)
  fs.writeFileSync(target, `#!/bin/sh\ncase "$1" in --version|-v) printf '%s\\n' '${entry.version}' ;; *) echo 'VERSION PROBE ONLY' >&2; exit 93 ;; esac\n`)
  fs.chmodSync(target, 0o755)
}

test('packed current CLI completes the private v2 lifecycle for OMP and DeepSeek Harness', {
  timeout: 900000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-packed-harnesses-'))
  try {
    const packDirectory = path.join(sandbox, 'pack')
    const installPrefix = path.join(sandbox, 'installed-cli')
    const npmCache = path.join(sandbox, 'npm-cache')
    fs.mkdirSync(packDirectory, { recursive: true })
    fs.mkdirSync(npmCache, { recursive: true })
    const npmEnv = {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_cache: npmCache,
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    }

    const packed = runNpm([
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory,
    ], { cwd: ROOT, env: npmEnv })
    assert.equal(packed.status, 0, `npm pack\n${packed.stdout}\n${packed.stderr}`)
    const [{ filename }] = JSON.parse(packed.stdout)
    const tarball = path.join(packDirectory, path.basename(filename))
    assert.equal(fs.existsSync(tarball), true, tarball)

    const installed = runNpm([
      'install',
      '--ignore-scripts',
      '--prefix',
      installPrefix,
      tarball,
    ], { cwd: sandbox, env: npmEnv })
    assert.equal(
      installed.status,
      0,
      `npm install packed tarball\n${installed.stdout}\n${installed.stderr}`,
    )

    const packageRoot = path.join(
      installPrefix,
      'node_modules',
      'autoprompt-skill',
    )
    const packedPackage = JSON.parse(fs.readFileSync(
      path.join(packageRoot, 'package.json'),
      'utf8',
    ))
    assert.equal(packedPackage.version, PACKAGE_VERSION)
    const cli = path.join(packageRoot, 'bin', 'autoprompt.cjs')

    for (const provider of Object.keys(PROVIDERS)) {
      const providerSandbox = path.join(sandbox, provider)
      const bin = path.join(providerSandbox, 'bin')
      const root = path.join(providerSandbox, 'provider-root')
      const env = makeEnvironment(providerSandbox, bin)
      writeFakeHarness(bin, provider)
      const invoke = args => run(process.execPath, [cli, ...args], {
        cwd: providerSandbox,
        env,
      })

      const installResult = invoke(['install', provider, '--root', root])
      assert.equal(
        installResult.status,
        0,
        `${provider} packed install\n${installResult.stdout}\n${installResult.stderr}`,
      )
      const receiptFile = path.join(root, pkg.receiptName(provider))
      const receiptBytes = fs.readFileSync(receiptFile)
      const receipt = JSON.parse(receiptBytes)
      const bundle = pkg.bundlePath(root, receipt)
      const target = path.join(bundle, `agents/${provider}/VERSION`)
      assert.equal(fs.existsSync(target), true, `${provider}: private payload missing`)
      assert.equal(Object.keys(receipt.files).filter(file =>
        file.startsWith('agents/codex/agents/') && file.endsWith('.toml')).length, 32)
      const publicFiles = pkg.walk(root).filter(file => !file.startsWith('.autoprompt-private/'))
      assert.deepEqual(publicFiles.sort(), [pkg.receiptName(provider), pkg.launcherRelative(provider)].sort())
      const skill = fs.readFileSync(pkg.launcherPath(provider, root), 'utf8')
      assert.equal(skill, pkg.launcher(provider, root))
      assert.match(skill, new RegExp(`autoprompt activate ${provider} --target`))
      assert.match(skill, /Loading this launcher never starts or resumes work/)
      const originalTarget = fs.readFileSync(target)

      const doctor = invoke(['doctor', provider, '--strict', '--root', root])
      assert.equal(
        doctor.status,
        1,
        `${provider} packed doctor\n${doctor.stdout}\n${doctor.stderr}`,
      )
      // A version-only fixture verifies installation, not native activation readiness.
      assert.match(doctor.stdout, /payload=verified activation=unavailable/)
      assert.match(doctor.stdout, /extras=complete/)

      fs.appendFileSync(target, '\npacked lifecycle tamper\n')
      const broken = invoke(['doctor', provider, '--strict', '--root', root])
      assert.notEqual(broken.status, 0, `${provider}: packed doctor missed tamper`)
      for (const action of ['install', 'uninstall']) {
        const refused = invoke([action, provider, '--root', root])
        assert.notEqual(refused.status, 0, `${provider}: ${action} accepted changed payload`)
        assert.match(`${refused.stdout}\n${refused.stderr}`, /Payload changed/)
        assert.match(fs.readFileSync(target, 'utf8'), /packed lifecycle tamper/)
        assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes)
      }
      fs.writeFileSync(target, originalTarget)
      const reinstalled = invoke(['install', provider, '--root', root])
      assert.equal(reinstalled.status, 0, `${reinstalled.stdout}\n${reinstalled.stderr}`)
      assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes)
      const foreign = path.join(root, 'agents', 'user-notes.txt')
      fs.mkdirSync(path.dirname(foreign), { recursive: true })
      fs.writeFileSync(foreign, 'foreign packed-lifecycle file\n')
      const removed = invoke(['uninstall', provider, '--root', root])
      assert.equal(
        removed.status,
        0,
        `${provider} packed uninstall\n${removed.stdout}\n${removed.stderr}`,
      )
      for (const file of Object.keys(receipt.files)) assert.equal(fs.existsSync(path.join(bundle, file)), false, file)
      assert.equal(fs.existsSync(bundle), false)
      assert.equal(fs.existsSync(pkg.launcherPath(provider, root)), false)
      assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign packed-lifecycle file\n')
      assert.equal(
        fs.existsSync(receiptFile),
        false,
      )
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
