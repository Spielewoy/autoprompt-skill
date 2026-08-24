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

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const candidate = candidates.find(file => fs.existsSync(file))
  assert.ok(candidate, `could not locate npm CLI; checked ${candidates.join(', ')}`)
  return candidate
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
    ...options,
  })
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function writeHashManifest(file, entries) {
  const rows = Object.entries(entries).map(([key, hash], index, all) =>
    `    ${JSON.stringify(key)}: ${JSON.stringify(hash)}${index + 1 < all.length ? ',' : ''}`)
  fs.writeFileSync(file, `{\n${rows.join('\n')}\n}\n`)
}

function addPriorOnly(root, name, drift) {
  const target = path.join(root, 'skills', 'autoprompt', name)
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  const receiptPath = path.join(root, '.autoprompt-install-receipt.json')
  const installed = Buffer.from(`retired generation: ${name}\n`)
  fs.writeFileSync(target, installed)
  const hashes = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  hashes[target] = sha256(installed)
  writeHashManifest(manifestPath, hashes)
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  const manifestIndex = receipt.files.findIndex(file => path.resolve(file) === path.resolve(manifestPath))
  receipt.files.splice(manifestIndex < 0 ? receipt.files.length : manifestIndex, 0, target)
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  if (drift) fs.appendFileSync(target, 'user drift survives packed update\n')
  return target
}

function packedEnvironment(sandbox) {
  const home = path.join(sandbox, 'home')
  const bin = path.join(sandbox, 'bin')
  for (const directory of [home, bin]) fs.mkdirSync(directory, { recursive: true })
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\necho codex-cli 0.101.0\r\n')
  } else {
    const executable = path.join(bin, 'codex')
    fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "codex-cli 0.101.0"\n')
    fs.chmodSync(executable, 0o755)
  }
  const environment = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    USERPROFILE: home,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
  delete environment.CODEX_HOME
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'npm_config_dry_run') delete environment[key]
  }
  return environment
}

test('packed Codex payload binds generation through install, repair, side-by-side roots, and drift-safe uninstall', {
  timeout: 180000,
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-packed-codex-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const packDirectory = path.join(sandbox, 'pack')
  const extractedDirectory = path.join(sandbox, 'extracted')
  fs.mkdirSync(packDirectory)
  fs.mkdirSync(extractedDirectory)
  const environment = {
    ...process.env,
    HOME: path.join(sandbox, 'home'),
    USERPROFILE: path.join(sandbox, 'home'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
  fs.mkdirSync(environment.HOME)
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'npm_config_dry_run') delete environment[key]
  }

  const packed = run(process.execPath, [
    npmCliPath(), 'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory,
  ], { cwd: ROOT, env: environment })
  assert.equal(packed.status, 0, `npm pack\n${packed.stdout}\n${packed.stderr}`)
  const [{ filename }] = JSON.parse(packed.stdout)
  const extracted = run('tar', [
    '-xf', path.join(packDirectory, filename), '-C', extractedDirectory,
  ])
  assert.equal(extracted.status, 0, extracted.stderr)

  const packageRoot = path.join(extractedDirectory, 'package')
  const runtime = require(path.join(packageRoot, 'scripts', 'runtime-payload.cjs'))
  const manifest = runtime.loadManifest('codex', packageRoot)
  const roots = [
    path.join(sandbox, 'activation-a'),
    path.join(sandbox, 'activation-b'),
  ]
  const destinations = roots.map(root => path.join(root, 'skills', 'autoprompt'))

  for (const destination of destinations) {
    const plan = runtime.installationPlan('codex', destination, packageRoot)
    assert.equal(runtime.installPayload('codex', destination, packageRoot).length, plan.files.length)
    assert.deepEqual(runtime.verifyPayload('codex', destination, packageRoot), {
      files: plan.files.length,
      provider: 'codex',
    })
    assert.equal(plan.payloadGeneration, manifest.payloadGeneration)
    assert.equal(plan.payloadDigest, manifest.payloadDigest)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(plan.skillRoot, runtime.CODEX_EMBEDDED_MANIFEST), 'utf8')),
      manifest,
    )
  }
  const plans = destinations.map(destination => runtime.installationPlan('codex', destination, packageRoot))
  assert.notEqual(fs.realpathSync(plans[0].bundleRoot), fs.realpathSync(plans[1].bundleRoot))

  const sharedRootMarker = path.join(plans[0].skillRoot, runtime.CODEX_EMBEDDED_MANIFEST)
  const wrongGeneration = {
    ...manifest,
    payloadGeneration: `codex-v1.0.4-${'0'.repeat(16)}`,
    payloadDigest: '0'.repeat(64),
  }
  fs.writeFileSync(sharedRootMarker, `${JSON.stringify(wrongGeneration, null, 2)}\n`)
  assert.throws(
    () => runtime.verifyPayload('codex', destinations[0], packageRoot),
    error => /installed Codex payload generation mismatch/.test(error.message) &&
      error.message.includes(manifest.payloadGeneration) &&
      error.message.includes(wrongGeneration.payloadGeneration),
    'a shared root must fail closed instead of selecting a stale generation',
  )
  assert.throws(
    () => runtime.installPayload('codex', destinations[0], packageRoot),
    /immutable Codex bundle drift/,
  )
  fs.unlinkSync(sharedRootMarker)
  runtime.installPayload('codex', destinations[0], packageRoot)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(sharedRootMarker, 'utf8')),
    manifest,
    'explicit repair must restore the one current generation receipt',
  )

  const router = path.join(plans[0].skillRoot, 'workflow', 'router.js')
  fs.appendFileSync(router, '\npacked repair drift\n')
  assert.throws(
    () => runtime.verifyPayload('codex', destinations[0], packageRoot),
    /installed hash mismatch: .*skills\/autoprompt\/workflow\/router\.js/,
  )
  assert.throws(
    () => runtime.installPayload('codex', destinations[0], packageRoot),
    /immutable Codex bundle drift/,
  )
  fs.unlinkSync(router)
  runtime.installPayload('codex', destinations[0], packageRoot)
  assert.doesNotMatch(fs.readFileSync(router, 'utf8'), /packed repair drift/)
  runtime.verifyPayload('codex', destinations[0], packageRoot)

  const skill = path.join(destinations[0], 'SKILL.md')
  const marker = path.join(plans[0].skillRoot, runtime.CODEX_EMBEDDED_MANIFEST)
  const foreign = path.join(destinations[0], 'user-owned.txt')
  fs.appendFileSync(skill, '\nuser-owned uninstall drift\n')
  fs.writeFileSync(foreign, 'foreign file survives\n')
  const driftedUninstall = runtime.uninstallPayload('codex', destinations[0], packageRoot)
  assert.deepEqual(driftedUninstall.retained, [{
    path: 'skills/autoprompt/SKILL.md',
    reason: 'hash-drift',
  }])
  assert.match(fs.readFileSync(skill, 'utf8'), /user-owned uninstall drift/)
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign file survives\n')
  assert.equal(fs.existsSync(marker), false)

  const secondPlan = runtime.installationPlan('codex', destinations[1], packageRoot)
  const cleanUninstall = runtime.uninstallPayload('codex', destinations[1], packageRoot)
  assert.deepEqual(cleanUninstall.retained, [])
  assert.equal(cleanUninstall.removed.length, secondPlan.files.length)
})

test('packed Codex CLI update prunes clean prior-only bytes and preserves drift in one replay', {
  timeout: 300000,
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-packed-codex-update-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const packDirectory = path.join(sandbox, 'pack')
  const extractedDirectory = path.join(sandbox, 'extracted')
  const root = path.join(sandbox, 'codex-root')
  for (const directory of [packDirectory, extractedDirectory, root]) fs.mkdirSync(directory)
  const environment = packedEnvironment(sandbox)
  const packStarted = Date.now()
  const packed = run(process.execPath, [
    npmCliPath(), 'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory,
  ], { cwd: ROOT, env: environment })
  t.diagnostic(`stage=pack elapsedMs=${Date.now() - packStarted}`)
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`)
  const [{ filename }] = JSON.parse(packed.stdout)
  const unpacked = run('tar', [
    '-xf', path.join(packDirectory, filename), '-C', extractedDirectory,
  ])
  assert.equal(unpacked.status, 0, unpacked.stderr)
  const packageRoot = path.join(extractedDirectory, 'package')
  const runtime = require(path.join(packageRoot, 'scripts', 'runtime-payload.cjs'))
  const generation = runtime.loadManifest('codex', packageRoot).payloadGeneration
  assert.match(generation, /^codex-v2\.0\.0-[a-f0-9]{16}$/)
  t.diagnostic(`payloadGeneration=${generation}`)
  const cli = path.join(packageRoot, 'bin', 'autoprompt.cjs')
  const invoke = label => {
    const started = Date.now()
    const result = run(process.execPath, [cli, 'install', 'codex', '--root', root], {
      cwd: sandbox, env: environment,
    })
    t.diagnostic(`stage=${label} elapsedMs=${Date.now() - started} status=${result.status}`)
    return result
  }
  const initial = invoke('initial-install')
  assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`)
  const retiredClean = addPriorOnly(root, 'retired-clean.txt', false)
  const retiredDrift = addPriorOnly(root, 'retired-drift.txt', true)
  const replay = invoke('update-replay')
  assert.equal(replay.status, 0, `${replay.stdout}\n${replay.stderr}`)
  assert.match(`${replay.stdout}\n${replay.stderr}`, /update-pruned=.*retired-clean\.txt reason=prior-only/)
  assert.match(`${replay.stdout}\n${replay.stderr}`,
    /update-retained=.*retired-drift\.txt reason=hash-drift ownership=relinquished/)
  assert.equal(fs.existsSync(retiredClean), false)
  assert.match(fs.readFileSync(retiredDrift, 'utf8'), /user drift survives packed update/)
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.autoprompt-install-receipt.json'), 'utf8'))
  assert.equal(receipt.files.some(file => path.resolve(file) === path.resolve(retiredDrift)), false)
  const hashes = JSON.parse(fs.readFileSync(path.join(root, '.autoprompt-install-hashes.json'), 'utf8'))
  assert.equal(Object.keys(hashes).some(file => path.resolve(file) === path.resolve(retiredDrift)), false)
})
