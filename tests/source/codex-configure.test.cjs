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
const CLI = path.join(ROOT, 'bin', 'autoprompt.cjs')
const CONFIGURE = path.join(ROOT, 'scripts', 'codex-configure.cjs')
const CASTING = path.join(ROOT, 'agents', 'codex', 'workflow', 'codex-agent-casting.js')
const PROFILE = path.join(ROOT, 'agents', 'codex', 'workflow', 'codex-agent-profile.js')
const { HELP_TEXT, parseArgs } = require('../../bin/autoprompt.cjs')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  })
}

function npmCliPath() {
  return [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean).find(file => fs.existsSync(file))
}

function nestedNpmEnvironment(environment) {
  const nested = { ...environment }
  for (const key of Object.keys(nested)) {
    if (key.toLowerCase() === 'npm_config_dry_run') delete nested[key]
  }
  return nested
}

function makeInstall() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt codex configure '))
  const root = path.join(sandbox, 'codex root')
  const toolEnv = { ...process.env, HOME: path.join(sandbox, 'home') }
  const agents = path.join(root, 'skills', 'autoprompt', 'agents-runtime')
  const profile = path.join(root, 'autoprompt.config.toml')
  fs.mkdirSync(agents, { recursive: true })
  for (const name of fs.readdirSync(path.join(ROOT, 'agents', 'codex', 'agents'))) {
    if (/^ap-.*\.toml$/.test(name)) {
      fs.copyFileSync(path.join(ROOT, 'agents', 'codex', 'agents', name), path.join(agents, name))
    }
  }
  assert.equal(run(process.execPath, [
    CASTING, '--write-manifest', '--agents-dir', agents, '--selector', 'off',
  ], { env: toolEnv }).status, 0)
  assert.equal(run(process.execPath, [
    PROFILE, '--write', '--agents-dir', agents, '--profile', profile,
  ]).status, 0)

  const managed = [
    ...fs.readdirSync(agents).filter(name => /^ap-.*\.toml$/.test(name)).sort()
      .map(name => path.join(agents, name)),
    path.join(agents, '.autoprompt-casting.json'),
    profile,
  ]
  const hashes = Object.fromEntries(managed.map(file => [file, sha256(file)]))
  const hashManifest = path.join(root, '.autoprompt-install-hashes.json')
  fs.writeFileSync(hashManifest, `${JSON.stringify(hashes, null, 2)}\n`)
  const receipt = path.join(root, '.autoprompt-install-receipt.json')
  fs.writeFileSync(receipt, `${JSON.stringify({
    nonce: 'test-receipt',
    backup: 'none',
    files: [...managed, hashManifest],
    createdDirectories: [],
    configEdits: [],
  }, null, 2)}\n`)
  const env = {
    ...process.env,
    AUTOPROMPT_INSTALL_ROOT: root,
    HOME: path.join(sandbox, 'home'),
    USERPROFILE: path.join(sandbox, 'home'),
  }
  return { agents, env, hashManifest, profile, receipt, root, sandbox }
}

function invoke(context, args, extra = {}) {
  return run(process.execPath, [CLI, ...args], {
    env: { ...context.env, ...(extra.env || {}) },
    ...extra,
  })
}

function snapshot(context) {
  const names = fs.readdirSync(context.agents).sort()
  return new Map([
    ...names.map(name => [path.join(context.agents, name), fs.readFileSync(path.join(context.agents, name))]),
    [context.profile, fs.readFileSync(context.profile)],
    [context.hashManifest, fs.readFileSync(context.hashManifest)],
    [context.receipt, fs.readFileSync(context.receipt)],
  ])
}

function assertSnapshot(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()])
  for (const [file, bytes] of expected) assert.deepEqual(actual.get(file), bytes, file)
}

function temporaryConfigureArtifacts(root) {
  const found = []
  const visit = directory => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.name.includes('.autoprompt-configure-')) found.push(target)
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(target)
    }
  }
  visit(root)
  return found
}

test('configure parser accepts the bounded Codex surface and rejects malformed input', () => {
  assert.match(HELP_TEXT, /configure codex .*\[--root <absolute-path>\]/)
  assert.deepEqual(parseArgs(['configure', 'codex', '--agents', 'off']), {
    command: 'configure', provider: 'codex', selector: 'off', modelMap: '',
  })
  assert.deepEqual(parseArgs([
    'configure', 'codex', '--agents', 'auto', '--model-map', 'C:\\models\\map.json',
  ]), {
    command: 'configure', provider: 'codex', selector: 'auto', modelMap: 'C:\\models\\map.json',
  })
  const root = path.resolve('codex configure root')
  assert.deepEqual(parseArgs([
    'configure', 'codex', '--agents', 'off', '--root', root,
  ]), {
    command: 'configure', provider: 'codex', selector: 'off', modelMap: '', root,
  })
  for (const args of [
    ['configure'],
    ['configure', 'claude', '--agents', 'off'],
    ['configure', 'codex'],
    ['configure', 'codex', '--agents'],
    ['configure', 'codex', '--agents', 'off', '--agents', 'auto'],
    ['configure', 'codex', '--agents', 'off', '--root', 'relative'],
    ['configure', 'codex', '--unknown', 'value'],
  ]) {
    assert.throws(() => parseArgs(args), error => error?.code === 'AUTOPROMPT_USAGE', args.join(' '))
  }
})

test('installed Codex cast supports explicit list, idempotence, auto, and off without touching siblings', () => {
  const context = makeInstall()
  const sibling = path.join(context.agents, 'user-owned.toml')
  const outside = path.join(context.sandbox, 'outside.txt')
  const modelMap = path.join(context.sandbox, 'models.json')
  fs.writeFileSync(sibling, 'user-owned\n')
  fs.writeFileSync(outside, 'outside\n')
  fs.writeFileSync(modelMap, `${JSON.stringify([
    { name: 'Fast', modelString: 'gpt-5.6-terra', effortHint: 'low' },
    { name: 'Strong', modelString: 'gpt-5.6-sol', effortHint: 'max' },
  ])}\n`)
  try {
    const explicit = invoke(context, [
      'configure', 'codex', '--agents', 'gpt-5.6-sol,gpt-5.6-terra',
    ])
    assert.equal(explicit.status, 0, explicit.stderr)
    assert.match(explicit.stdout, /selector=gpt-5\.6-sol,gpt-5\.6-terra/)
    assert.match(fs.readFileSync(path.join(context.agents, 'ap-manager.toml'), 'utf8'), /model = "gpt-5\.6-sol"/)
    assert.match(fs.readFileSync(path.join(context.agents, 'ap-sweeper.toml'), 'utf8'), /model = "gpt-5\.6-terra"/)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'user-owned\n')
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n')

    const beforeRepeat = snapshot(context)
    const repeated = invoke(context, [
      'configure', 'codex', '--agents', 'gpt-5.6-sol,gpt-5.6-terra',
    ])
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.match(repeated.stdout, /status=unchanged/)
    assertSnapshot(snapshot(context), beforeRepeat)

    const automatic = invoke(context, [
      'configure', 'codex', '--agents', 'auto', '--model-map', modelMap,
    ])
    assert.equal(automatic.status, 0, automatic.stderr)
    const manifest = JSON.parse(fs.readFileSync(path.join(context.agents, '.autoprompt-casting.json')))
    assert.equal(manifest.selector, 'auto')
    assert.deepEqual(manifest.models, ['gpt-5.6-sol', 'gpt-5.6-terra'])
    assert.equal(run(process.execPath, [
      CASTING, '--resolve', '--agents-dir', context.agents,
      '--selector', 'auto', '--registry', modelMap,
    ], { env: context.env }).status, 0)

    const off = invoke(context, ['configure', 'codex', '--agents', 'off'])
    assert.equal(off.status, 0, off.stderr)
    assert.doesNotMatch(fs.readFileSync(path.join(context.agents, 'ap-manager.toml'), 'utf8'), /^model\s*=/m)
    assert.equal(run(process.execPath, [
      CASTING, '--resolve', '--agents-dir', context.agents, '--selector', 'off',
    ], { env: context.env }).status, 0)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'user-owned\n')
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('invalid selectors, maps, ownership collisions, and injection text fail before mutation', () => {
  const context = makeInstall()
  const marker = path.join(context.sandbox, 'must-not-exist')
  try {
    for (const args of [
      ['configure', 'codex', '--agents', 'auto'],
      ['configure', 'codex', '--agents', 'a,,b'],
      ['configure', 'codex', '--agents', 'a,b,c,d,e,f'],
      ['configure', 'codex', '--agents', `gpt-5.6-sol;touch${marker}`],
      ['configure', 'codex', '--agents', 'auto', '--model-map', 'relative.json'],
    ]) {
      const before = snapshot(context)
      const result = invoke(context, args)
      assert.notEqual(result.status, 0, args.join(' '))
      assertSnapshot(snapshot(context), before)
      assert.equal(fs.existsSync(marker), false)
    }

    const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
    const target = path.join(context.agents, 'ap-manager.toml')
    receipt.files = receipt.files.filter(file => path.resolve(file) !== path.resolve(target))
    fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
    const beforeCollision = snapshot(context)
    const collision = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol'])
    assert.notEqual(collision.status, 0)
    assert.match(collision.stderr, /receipt-owned/i)
    assertSnapshot(snapshot(context), beforeCollision)
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('transaction rolls back every file when a commit fails', () => {
  const context = makeInstall()
  const before = snapshot(context)
  try {
    const script = [
      `const configure = require(${JSON.stringify(CONFIGURE)});`,
      'try { configure.configureCodex({ selector: "gpt-5.6-sol,gpt-5.6-terra", env: process.env, faultAfterRename: 2 }); process.exit(90) }',
      'catch (error) { process.stderr.write(error.message + "\\n") }',
    ].join(' ')
    const failed = run(process.execPath, ['-e', script], { env: context.env })
    assert.equal(failed.status, 0, failed.stderr)
    assert.match(failed.stderr, /injected commit failure/)
    assertSnapshot(snapshot(context), before)
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('physical containment rejects a junctioned agents runtime before outside mutation', {
  skip: process.platform === 'win32' && !process.env.USERPROFILE,
}, () => {
  const context = makeInstall()
  const outside = path.join(context.sandbox, 'outside agents')
  const manager = path.join(outside, 'ap-manager.toml')
  try {
    fs.renameSync(context.agents, outside)
    fs.symlinkSync(outside, context.agents, process.platform === 'win32' ? 'junction' : 'dir')
    const before = fs.readFileSync(manager)
    const result = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /physical|reparse|symlink|escape/i)
    assert.deepEqual(fs.readFileSync(manager), before)
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('an originals read failure removes the stage directory without changing managed bytes', () => {
  const context = makeInstall()
  const before = snapshot(context)
  const originalRead = fs.readFileSync
  let injected = false
  try {
    fs.readFileSync = function readWithInjectedEio(file, ...args) {
      const stageExists = fs.readdirSync(context.root)
        .some(name => name.startsWith('.autoprompt-configure-'))
      if (!injected && stageExists && path.basename(String(file)) === 'ap-arbiter.toml') {
        injected = true
        const error = new Error('injected originals read EIO')
        error.code = 'EIO'
        throw error
      }
      return originalRead.call(this, file, ...args)
    }
    const configure = require(CONFIGURE)
    assert.throws(() => configure.configureCodex({
      selector: 'gpt-5.6-sol',
      env: context.env,
    }), /injected originals read EIO/)
  } finally {
    fs.readFileSync = originalRead
  }
  try {
    assert.equal(injected, true)
    assertSnapshot(snapshot(context), before)
    assert.deepEqual(temporaryConfigureArtifacts(context.root), [])
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('first rename failure removes staged siblings without changing managed bytes', () => {
  const context = makeInstall()
  const before = snapshot(context)
  try {
    const configure = require(CONFIGURE)
    assert.throws(() => configure.configureCodex({
      selector: 'gpt-5.6-sol',
      env: context.env,
      renameHook(event) {
        if (event.phase === 'commit' && event.index === 1) throw new Error('first rename denied')
      },
    }), /first rename denied/)
    assertSnapshot(snapshot(context), before)
    assert.deepEqual(temporaryConfigureArtifacts(context.root), [])
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('rollback collects an early restore error and continues restoring later files', () => {
  const context = makeInstall()
  const before = snapshot(context)
  const agentFiles = fs.readdirSync(context.agents).filter(name => /^ap-.*\.toml$/.test(name)).sort()
  try {
    const configure = require(CONFIGURE)
    assert.throws(() => configure.configureCodex({
      selector: 'gpt-5.6-sol,gpt-5.6-terra',
      env: context.env,
      faultAfterRename: 3,
      renameHook(event) {
        if (event.phase === 'rollback' && event.index === 1) throw new Error('one restore denied')
      },
    }), /rollback.*one restore denied/i)
    assert.notDeepEqual(fs.readFileSync(path.join(context.agents, agentFiles[2])), before.get(path.join(context.agents, agentFiles[2])))
    for (const name of agentFiles.slice(0, 2)) {
      const file = path.join(context.agents, name)
      assert.deepEqual(fs.readFileSync(file), before.get(file), file)
    }
    assert.deepEqual(temporaryConfigureArtifacts(context.root), [])
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('a root-scoped operation lock denies concurrent configuration and safely reclaims a dead owner', () => {
  const context = makeInstall()
  const lock = require('../../scripts/install/operation-lock.cjs')
  try {
    const lease = lock.acquire(context.root, 'test-holder')
    try {
      const blocked = invoke(context, ['configure', 'codex', '--agents', 'gpt-5.6-sol'])
      assert.notEqual(blocked.status, 0)
      assert.match(blocked.stderr, /operation.*locked|lock.*held/i)
    } finally {
      lock.release(lease)
    }
    const stalePath = path.join(context.root, lock.LOCK_NAME)
    fs.mkdirSync(stalePath)
    fs.writeFileSync(path.join(stalePath, 'owner.json'), `${JSON.stringify({
      schemaVersion: 1,
      hostname: os.hostname(),
      pid: 2147483647,
      token: 'a'.repeat(32),
      operation: 'stale-test',
      startedAt: new Date(0).toISOString(),
    })}\n`)
    const reclaimed = lock.acquire(context.root, 'reclaim-test')
    lock.release(reclaimed)
    assert.equal(fs.existsSync(stalePath), false)
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('packaged casting recovery names supported install and configure commands', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt casting recovery '))
  const agents = path.join(sandbox, 'agents')
  const registry = path.join(sandbox, 'models.json')
  fs.mkdirSync(agents)
  fs.writeFileSync(registry, '[{"name":"Strong","modelString":"gpt-5.6-sol"}]\n')
  const env = { ...process.env, HOME: sandbox }
  try {
    const off = run(process.execPath, [
      CASTING, '--resolve', '--agents-dir', agents, '--selector', 'off',
    ], { env })
    assert.equal(off.status, 2)
    assert.match(off.stderr, /autoprompt install codex/)
    assert.doesNotMatch(off.stderr, /export-agents-to-codex/)

    const automatic = run(process.execPath, [
      CASTING, '--resolve', '--agents-dir', agents, '--selector', 'auto', '--registry', registry,
    ], { env })
    assert.equal(automatic.status, 2)
    assert.match(automatic.stderr, /autoprompt configure codex --agents auto --model-map <absolute-json>/)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Windows physical path aliases remain receipt-owned', {
  skip: process.platform !== 'win32',
}, () => {
  const context = makeInstall()
  const extended = file => `\\\\?\\${path.resolve(file)}`
  try {
    const receipt = JSON.parse(fs.readFileSync(context.receipt, 'utf8'))
    receipt.files = receipt.files.map(extended)
    fs.writeFileSync(context.receipt, `${JSON.stringify(receipt, null, 2)}\n`)

    const hashes = JSON.parse(fs.readFileSync(context.hashManifest, 'utf8'))
    const aliased = Object.fromEntries(Object.entries(hashes).map(([file, hash]) => [extended(file), hash]))
    fs.writeFileSync(context.hashManifest, `${JSON.stringify(aliased, null, 2)}\n`)

    const configured = invoke(context, ['configure', 'codex', '--agents', 'off'])
    assert.equal(configured.status, 0, configured.stderr)
    assert.match(configured.stdout, /status=unchanged/)
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('the packed global package exposes a working Codex configure command', { timeout: 120_000 }, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt packed configure '))
  const root = path.join(sandbox, 'codex root')
  const home = path.join(sandbox, 'home')
  const fakeBin = path.join(sandbox, 'bin')
  const packDirectory = path.join(sandbox, 'pack')
  const prefix = path.join(sandbox, 'prefix')
  const npmCli = npmCliPath()
  assert.ok(npmCli, 'npm CLI not found')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(home)
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(packDirectory)
  fs.mkdirSync(prefix)
  fs.writeFileSync(path.join(fakeBin, 'codex.cmd'), '@echo off\r\necho codex-cli 0.101.0\r\n')
  const fakePosix = path.join(fakeBin, 'codex')
  fs.writeFileSync(fakePosix, '#!/bin/sh\nprintf "%s\\n" "codex-cli 0.101.0"\n')
  fs.chmodSync(fakePosix, 0o755)
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  }
  const npmEnv = nestedNpmEnvironment({
    ...env,
    npm_config_dry_run: 'true',
    NPM_CONFIG_DRY_RUN: 'true',
    npm_config_audit: 'false',
    npm_config_cache: path.join(sandbox, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  })
  try {
    const packed = run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory], { env: npmEnv })
    assert.equal(packed.status, 0, packed.stderr)
    const tarball = path.join(packDirectory, JSON.parse(packed.stdout)[0].filename)
    const installed = run(process.execPath, [
      npmCli, 'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball,
    ], { env: npmEnv })
    assert.equal(installed.status, 0, installed.stderr)
    const packageRoot = [
      path.join(prefix, 'node_modules', 'autoprompt-skill'),
      path.join(prefix, 'lib', 'node_modules', 'autoprompt-skill'),
    ].find(candidate => fs.existsSync(candidate))
    assert.ok(packageRoot, 'installed package root not found')
    assert.equal(fs.existsSync(path.join(packageRoot, 'scripts', 'codex-configure.cjs')), true)
    const cli = path.join(packageRoot, 'bin', 'autoprompt.cjs')
    const lifecycle = run(process.execPath, [cli, 'install', 'codex', '--root', root], { env, cwd: sandbox, timeout: 120_000 })
    assert.equal(lifecycle.status, 0, `${lifecycle.stdout}\n${lifecycle.stderr}`)
    const configured = run(process.execPath, [
      cli, 'configure', 'codex', '--agents', 'gpt-5.6-sol,gpt-5.6-terra', '--root', root,
    ], { env, cwd: sandbox })
    assert.equal(configured.status, 0, configured.stderr)
    assert.match(configured.stdout, /status=updated/)
    const doctor = run(process.execPath, [cli, 'doctor', 'codex', '--strict', '--root', root], { env, cwd: sandbox, timeout: 120_000 })
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`)
    assert.match(doctor.stdout, /^codex\s+yes\s+yes\s+yes\s+/m)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
