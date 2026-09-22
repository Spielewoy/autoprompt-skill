'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { privateDirectory, requiredNativeCli, nativeEnvironment, nativeProcessAdapter } = require('../helpers/native-platform.cjs')
const { authenticationEndpoint } = require('../helpers/native-activation-endpoint.cjs')
const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')
const safeRunRoot = require('../../agents/codex/workflow/safe-run-root.js')
const { ownedTest } = require('../../scripts/harness-v2-closed-canary.cjs')
const { diagnoseNativeCanary } = require('../helpers/native-canary-diagnostics.cjs')
const CLI = requiredNativeCli('claude')
const ROOT = path.resolve(__dirname, '../..')
const PUBLIC_CASE = 'packed public Claude activate admits a fresh native canary before controlled endpoint refusal and revokes'
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

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
  let completed = false
  t.after(() => {
    if (completed) fs.rmSync(directory, { recursive: true, force: true })
    else t.diagnostic(`Packed native canary fixture retained after failure: ${directory}`)
  })
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
  if (process.platform === 'win32') {
    assert.doesNotThrow(() => safeRunRoot.auditPrivatePermissions(path.dirname(activation.activationRoot), { recurse: false }))
    assert.doesNotThrow(() => safeRunRoot.auditPrivatePermissions(activation.activationRoot, { recurse: false }))
  }
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
  completed = true
  t.diagnostic(`Installed ${activation.executable.version} on ${process.platform}/${process.arch}; ${required.length} genuine native observations admitted`)
})

test(PUBLIC_CASE, { skip: !CLI, timeout: 1800000 }, async t => {
  const directory = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt public native ')))
  let owner, endpoint, result, drained = false, completed = false
  t.after(async () => {
    let failure
    try {
      if (owner) {
        await owner.cancelAll({ reason: 'public activation fixture finished', graceMs: 500, killMs: 2000, waitForPending: true })
        assert.equal(owner.ownershipIdentities().length, 0, 'public CLI descendants must drain')
      }
      drained = true
    } catch (error) { failure = error }
    try { if (endpoint) await endpoint.close() } catch (error) { failure ||= error }
    if (completed && drained && !failure) fs.rmSync(directory, { recursive: true, force: true })
    else t.diagnostic(`Public native activation fixture retained: ${directory}`)
    if (failure) throw failure
  })
  const home = privateDirectory(path.join(directory, 'home')), tmp = privateDirectory(path.join(directory, 'tmp'))
  const environment = { ...nativeEnvironment(), HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    PATH: [path.dirname(CLI), path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_offline: 'true', npm_config_update_notifier: 'false',
    npm_config_cache: path.join(directory, 'empty npm cache'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' }
  const packed = JSON.parse(execute(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: ROOT, env: environment }))[0]
  const prefix = path.join(directory, 'installed package')
  execute(process.execPath, [npmCli(), 'install', '--ignore-scripts', '--offline', '--prefix', prefix, path.join(directory, packed.filename)], { cwd: directory, env: environment })
  const source = path.join(prefix, 'node_modules', 'autoprompt-skill'), publicCli = path.join(source, 'bin/autoprompt.cjs')
  const root = privateDirectory(path.join(directory, 'configuration')), target = privateDirectory(path.join(directory, 'target repository'))
  execute('git', ['init', '-b', 'fixture', target], { env: environment })
  execute('git', ['-C', target, '-c', 'user.name=Native Test', '-c', 'user.email=native-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'public native activation fixture'], { env: environment })
  execute(process.execPath, [publicCli, 'install', 'claude', '--root', root], { cwd: directory, env: environment })
  const installed = require(path.join(source, 'scripts/harness-v2-package.cjs')).verify('claude', root)
  const canary = require(path.join(installed.bundle, 'scripts/harness-v2-canary.cjs'))
  const policy = canary.selectPolicy(JSON.parse(fs.readFileSync(path.join(installed.bundle, 'scripts/harness-v2-trust/evidence.json'))), 'claude')
  let expectedWorker = null
  if (process.platform === 'win32') {
    const loader = require(path.join(installed.bundle, 'agents/codex/workflow/windows-worker-loader.js'))
    const tuple = loader.describeTuple(await loader.captureWorkerTuple())
    expectedWorker = { identity: tuple.identity, architecture: tuple.architecture, manifestSha256: tuple.manifestSha256,
      sharedId: tuple.sharedId, files: tuple.files }
    const hostile = privateDirectory(path.join(directory, 'hostile ambient Bash'))
    // A real executable with the wrong protocol makes accidental ambient use
    // fail. Neither this path nor its bytes equal the selected packaged Bash.
    fs.copyFileSync(process.execPath, path.join(hostile, 'bash.exe'))
    environment.AUTOPROMPT_WINDOWS_BASH = path.join(hostile, 'bash.exe')
    environment.PATH = [hostile, environment.PATH].join(path.delimiter)
  }
  const mission = 'Public native activation fixture: admit this local request; the private model endpoint intentionally refuses authentication. Do not contact external services.'
  let activationId, missionRequests = 0
  const inspectProof = expectedStatus => {
    const activationParent = path.join(root, '.autoprompt-private', 'activations')
    const ids = fs.readdirSync(activationParent).filter(name => /^apv2-[a-f0-9]{32}$/.test(name))
    assert.equal(ids.length, 1, 'this public invocation must create exactly one activation')
    activationId ||= ids[0]
    assert.equal(ids[0], activationId)
    const activationRoot = path.join(activationParent, activationId)
    const record = JSON.parse(fs.readFileSync(path.join(activationRoot, 'activation.json')))
    assert.equal(record.status, expectedStatus)
    assert.equal(record.reviewedLocal.mode, 'local-canary-pending')
    assert.deepEqual(record.request.argv, [mission])
    assert.equal(record.target.realpath, target)
    assert.equal(record.executable.path, fs.realpathSync.native(CLI))
    const local = record.reviewedLocalCanary
    assert.deepEqual(local.observations.map(item => item.capability).sort(), [...canary.REQUIRED].sort())
    const canaryRoot = path.join(activationRoot, 'reviewed-local-canary', `generation-${record.capability.generation}`)
    const artifacts = local.artifacts.map(item => {
      assert.equal(path.dirname(item.path), canaryRoot)
      const bytes = fs.readFileSync(item.path)
      assert.equal(sha256(bytes), item.sha256)
      return { ...item, bytes }
    })
    const proofBytes = fs.readFileSync(path.join(activationRoot, 'enforcement-proof.json'))
    canary.verifyActivationProof({ provider: 'claude', installed, record, proof: JSON.parse(proofBytes),
      proofSha256: sha256(proofBytes), policy, artifacts })
    const statuses = fs.readdirSync(canaryRoot).filter(name => /^outer-[a-f0-9-]{36}\.status\.json$/.test(name))
    assert.equal(statuses.length, 1, 'all eleven Claude observations must come from the exact owned native batch')
    const status = JSON.parse(fs.readFileSync(path.join(canaryRoot, statuses[0])))
    assert.equal(status.code, 0); assert.equal(status.signal, null); assert.equal(status.error, undefined)
    const output = `${status.stdout || ''}\n${status.stderr || ''}`
    for (const artifact of artifacts) assert.equal(JSON.parse(artifact.bytes).outputSha256, sha256(output))
    if (expectedWorker) {
      const observations = [...output.matchAll(/^# PACKAGED_WINDOWS_WORKER:(.+)$/gm)]
      assert.ok(observations.length >= 11, 'every native case must report the actual packaged worker tuple')
      for (const [, json] of observations) assert.deepEqual(JSON.parse(json), expectedWorker)
    }
    return record
  }
  const credential = `fixture-${crypto.randomBytes(16).toString('hex')}`
  endpoint = await authenticationEndpoint({ credential, onMission(_observation, value) {
    assert.ok(JSON.stringify({ messages: value.messages, system: value.system }).includes(mission),
      'a warmup or unrelated request cannot stand in for the exact public mission')
    inspectProof('active'); missionRequests++
  } })
  Object.assign(environment, { ANTHROPIC_BASE_URL: endpoint.url, ANTHROPIC_API_KEY: credential, AUTOPROMPT_CLAUDE_CLI: CLI })
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ model: 'claude-sonnet-4-6' }), { mode: 0o600 })
  const executionRoot = privateDirectory(path.join(directory, 'public process'))
  const registryPath = path.join(executionRoot, 'processes.json')
  owner = new ProcessOwner({ adapter: nativeProcessAdapter(registryPath, directory), registryPath, pollMs: 20 })
  try {
    result = await ownedTest(owner, executionRoot, environment, [publicCli, 'activate', 'claude', '--root', root,
      '--target', target, '--ttl', '1080', '--', mission], 1140000)
    fs.writeFileSync(path.join(directory, 'public-result.json'), JSON.stringify(result), { mode: 0o600 })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.code, 1, 'only the deliberate model endpoint refusal is expected')
    assert.deepEqual(endpoint.errors, [])
    assert.ok(missionRequests > 0, 'the real public supervisor must reach the controlled model endpoint after admission')
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /PROVIDER_UNSUPPORTED|review for this runtime is missing or ambiguous/)
    const finalRecord = inspectProof('revoked')
    // The quota relay suppresses provider error bodies without exact usage.
    // Its checksummed terminal preserves the structural upstream HTTP status;
    // the native CLI receives only the controller's sanitized refusal.
    const { readChecksummedJson } = require(path.join(installed.bundle, 'agents/codex/workflow/event-log.js'))
    const terminal = readChecksummedJson(path.join(finalRecord.supervisorRuntime.runPath, 'terminal.json'))
    assert.equal(terminal.activationId, activationId)
    assert.equal(terminal.runId, activationId)
    assert.equal(terminal.generation, finalRecord.capability.generation)
    assert.equal(terminal.missionHash, sha256(finalRecord.request.canonicalJson))
    assert.equal(terminal.outcome, 'FAILED')
    const providerTerminal = terminal.terminalEnvelope.payload.providerTerminal
    assert.equal(providerTerminal.status, 'PROVIDER_USAGE_UNKNOWN')
    assert.equal(providerTerminal.error.code, 'PROVIDER_USAGE_UNKNOWN')
    assert.equal(providerTerminal.error.details.protocol, 'anthropic-messages')
    assert.equal(providerTerminal.error.details.upstreamStatus, 401)
    const controls = path.join(finalRecord.supervisorRuntime.runPath, 'runtime', 'process-control')
    const sessions = fs.readdirSync(controls).filter(name => /^[a-f0-9]{32}$/.test(name))
    assert.ok(sessions.length > 0 && sessions.length <= 32)
    let nativeRefusalObserved = false
    for (const name of sessions) {
      const session = path.join(controls, name)
      const request = JSON.parse(fs.readFileSync(path.join(session, 'request.json')))
      assert.equal(request.activationId, activationId)
      assert.equal(request.generationId, finalRecord.capability.generation)
      for (const basename of ['stdout.jsonl', 'stderr.log']) {
        const file = path.join(session, basename)
        if (!fs.existsSync(file)) continue
        const stat = fs.lstatSync(file)
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024)
        if (fs.readFileSync(file, 'utf8').includes('Controller quota boundary refused this request')) nativeRefusalObserved = true
      }
    }
    assert.equal(nativeRefusalObserved, true, 'the exact owned native mission must receive the accounted controller refusal')
    assert.notEqual(finalRecord.outcome, 'DONE', 'an admission-only test cannot claim mission success')
    assert.match(result.stdout, new RegExp(`Autoprompt activation ${activationId}: status=1 revoked=true`))
    await owner.cancelAll({ reason: 'public activation proof complete', graceMs: 500, killMs: 2000, waitForPending: true })
    assert.equal(owner.ownershipIdentities().length, 0)
    drained = true; completed = true
    t.diagnostic(`Public installed activation admitted ${canary.REQUIRED.length} genuine observations on ${process.platform}/${process.arch}; controlled endpoint refusal, revocation and owned drain confirmed`)
  } catch (error) {
    if (result) t.diagnostic(`Public activation output: ${JSON.stringify({ code: result.code, signal: result.signal,
      stdout: String(result.stdout || '').slice(-8192), stderr: String(result.stderr || '').slice(-8192) })}`)
    throw error
  }
})
