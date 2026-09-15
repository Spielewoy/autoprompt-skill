'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { privateDirectory, requiredNativeCli, nativeEnvironment } = require('../helpers/native-platform.cjs')
const { diagnoseNativeCanary } = require('../helpers/native-canary-diagnostics.cjs')
const CLI = requiredNativeCli('claude')
const ROOT = path.resolve(__dirname, '../..')

function npmCli() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js'].filter(Boolean)
  const found = candidates.find(file => fs.existsSync(file))
  assert.ok(found, 'npm CLI is required to test the packed native activation')
  return found
}

function execute(executable, argv, options = {}) {
  const result = cp.spawnSync(executable, argv, { encoding: 'utf8', timeout: 180000, shell: false, ...options })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout
}

test('packed actual Claude activation requires all local native observations before mission admission', { skip: !CLI, timeout: 1200000 }, async t => {
  const directory = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt native packed ')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const environment = { ...process.env, PATH: [path.dirname(CLI), path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_cache: path.join(directory, 'empty npm cache') }
  delete environment.NODE_TEST_CONTEXT
  for (const key of Object.keys(environment)) if (key.toLowerCase() === 'npm_config_dry_run') delete environment[key]
  const packed = JSON.parse(execute(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: ROOT, env: environment }))[0]
  const prefix = path.join(directory, 'installed package')
  execute(process.execPath, [npmCli(), 'install', '--ignore-scripts', '--offline', '--prefix', prefix, path.join(directory, packed.filename)], { cwd: directory, env: environment })
  const source = path.join(prefix, 'node_modules', 'autoprompt-skill')
  assert.ok(fs.existsSync(path.join(source, 'tests/helpers/native-platform.cjs')), 'Native canary platform helper must ship in the offline package')
  const root = path.join(directory, 'provider configuration'), target = path.join(directory, 'target repository')
  privateDirectory(root); privateDirectory(target)
  execute('git', ['init', '-b', 'fixture', target])
  execute('git', ['-C', target, '-c', 'user.name=Native Test', '-c', 'user.email=native-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'native activation fixture'])
  const installOutput = execute(process.execPath, [path.join(source, 'bin/autoprompt.cjs'), 'install', 'claude', '--root', root], { cwd: directory, env: environment })
  assert.ok(fs.existsSync(path.join(root, '.autoprompt-claude-v2.json')), installOutput)
  const configure = require(path.join(source, 'scripts/harness-v2-configure.cjs'))
  const env = nativeEnvironment()
  const activation = configure.prepareActivation({ provider: 'claude', root, target,
    missionArgs: ['Validate the installed native canary only; do not execute a mission.'], executable: CLI, env, ttlSeconds: 1800 })
  assert.equal(activation.record.reviewedLocal.mode, 'local-canary-pending')
  assert.equal(activation.record.reviewedLocalCanary, undefined)
  const safety = require(path.join(activation.installed.bundle, 'scripts/local-only-safety.cjs'))
  const proof = activation.enforcementProof
  const childEnvironment = safety.createSafeChildGitEnvironment(target, env, { expectedBranch: 'fixture',
    configIsolationPath: activation.record.activationBoundary.gitConfig,
    ghConfigDir: activation.record.activationBoundary.ghConfigDir, enforcementProof: proof })
  const inspect = () => safety.inspect(safety.discoverRepository(target), 'fixture', childEnvironment, { enforcementProof: proof })
    .channels.providerConnectorApiWriteToolDenial
  const pending = inspect()
  assert.equal(pending.enforced, false, JSON.stringify(pending))
  let observed
  try { observed = await configure.runReviewedLocalCanary(activation, { env }) }
  catch (error) {
    diagnoseNativeCanary(activation, message => t.diagnostic(message))
    throw error
  }
  const required = require(path.join(source, 'scripts/harness-v2-canary.cjs')).REQUIRED
  assert.deepEqual(observed.observations.map(item => item.capability).sort(), [...required].sort())
  assert.ok(observed.observations.every(item => item.status === 'passed'))
  assert.equal(observed.artifacts.length, required.length)
  const admitted = inspect()
  assert.equal(admitted.enforced, true, JSON.stringify(admitted))
  // Reopen the genuine proof after withholding one genuine observation. It
  // must stop admission even though every native command already succeeded.
  const bytes = fs.readFileSync(activation.recordPath)
  const incomplete = JSON.parse(bytes)
  incomplete.reviewedLocalCanary.observations.pop()
  fs.writeFileSync(activation.recordPath, JSON.stringify(incomplete))
  try { assert.equal(inspect().enforced, false) }
  finally { fs.writeFileSync(activation.recordPath, bytes) }
  assert.equal(inspect().enforced, true)
  t.diagnostic(`Installed ${activation.executable.version} on ${process.platform}/${process.arch}; ${required.length} genuine native observations admitted`)
})
