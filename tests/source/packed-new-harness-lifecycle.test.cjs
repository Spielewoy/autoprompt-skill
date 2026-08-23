#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'package.json'),
  'utf8',
)).version
const PROVIDERS = Object.freeze({
  omp: Object.freeze({ command: 'omp', version: 'omp/17.4.0' }),
  deepseek: Object.freeze({ command: 'dsh', version: '0.1.0-rc.7' }),
  reasonix: Object.freeze({ command: 'reasonix', version: 'reasonix v1.30.0' }),
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

function nativeTarget(provider, root) {
  switch (provider) {
    case 'omp': return path.join(root, 'agents', 'ap-fresh-verifier.md')
    case 'deepseek': return path.join(
      root,
      '.agent-presets',
      'autoprompt',
      'agent.cordis.yml',
    )
    case 'reasonix': return path.join(
      root,
      'skills',
      'ap-fresh-verifier',
      'SKILL.md',
    )
    default: throw new Error(`unknown provider: ${provider}`)
  }
}

function foreignTarget(provider, root) {
  switch (provider) {
    case 'omp': return path.join(root, 'agents', 'user-notes.txt')
    case 'deepseek': return path.join(
      root,
      '.agent-presets',
      'autoprompt',
      'user-notes.txt',
    )
    case 'reasonix': return path.join(
      root,
      'skills',
      'ap-fresh-verifier',
      'user-notes.txt',
    )
    default: throw new Error(`unknown provider: ${provider}`)
  }
}

function assertNativeRoleCount(provider, root) {
  if (provider === 'omp') {
    assert.equal(
      fs.readdirSync(path.join(root, 'agents'))
        .filter(file => /^ap-[a-z-]+\.md$/.test(file)).length,
      25,
    )
    return
  }
  if (provider === 'deepseek') {
    const preset = fs.readFileSync(nativeTarget(provider, root), 'utf8')
    assert.equal(
      (preset.match(/name: '@deepseek-ai\/dsh-tool-subagent'/g) || []).length,
      25,
    )
    return
  }
  assert.equal(
    fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^ap-[a-z-]+$/.test(entry.name)).length,
    25,
  )
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
      `@echo off\r\necho ${entry.version}\r\n`,
    )
    return
  }
  const target = path.join(bin, entry.command)
  fs.writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' '${entry.version}'\n`)
  fs.chmodSync(target, 0o755)
}

test('packed 1.0.4 CLI completes lifecycle for OMP, DeepSeek Harness, and Reasonix', {
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
    assert.equal(packedPackage.version, '1.0.4')
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
      const target = nativeTarget(provider, root)
      assert.equal(fs.existsSync(target), true, `${provider}: native role target missing`)
      assertNativeRoleCount(provider, root)
      const skill = fs.readFileSync(path.join(root, 'skills', 'autoprompt', 'SKILL.md'), 'utf8')
      assert.match(skill, /^# Autoprompt/m)

      const doctor = invoke(['doctor', provider, '--strict', '--root', root])
      assert.equal(
        doctor.status,
        0,
        `${provider} packed doctor\n${doctor.stdout}\n${doctor.stderr}`,
      )
      assert.match(doctor.stdout, /extras=complete/)

      fs.appendFileSync(target, '\npacked lifecycle tamper\n')
      const broken = invoke(['doctor', provider, '--strict', '--root', root])
      assert.notEqual(broken.status, 0, `${provider}: packed doctor missed tamper`)
      const repaired = invoke(['install', provider, '--root', root])
      assert.equal(
        repaired.status,
        0,
        `${provider} packed repair\n${repaired.stdout}\n${repaired.stderr}`,
      )
      assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /packed lifecycle tamper/)

      const foreign = foreignTarget(provider, root)
      fs.mkdirSync(path.dirname(foreign), { recursive: true })
      fs.writeFileSync(foreign, 'foreign packed-lifecycle file\n')
      const receipt = JSON.parse(fs.readFileSync(
        path.join(root, '.autoprompt-install-receipt.json'),
        'utf8',
      ))
      const removed = invoke(['uninstall', provider, '--root', root])
      assert.equal(
        removed.status,
        0,
        `${provider} packed uninstall\n${removed.stdout}\n${removed.stderr}`,
      )
      for (const file of receipt.files) assert.equal(fs.existsSync(file), false, file)
      assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign packed-lifecycle file\n')
      assert.equal(
        fs.existsSync(path.join(root, '.autoprompt-install-receipt.json')),
        false,
      )
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
