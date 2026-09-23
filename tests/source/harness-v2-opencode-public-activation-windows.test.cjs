'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const crypto = require('node:crypto')
const { privateDirectory, nativeEnvironment, nativeProcessAdapter, requiredNativeCli } = require('../helpers/native-platform.cjs')
const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')
const { ownedTest } = require('../../scripts/harness-v2-closed-canary.cjs')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const { opencodePublicEndpoint } = require('../helpers/opencode-public-endpoint.cjs')
const ROOT = path.resolve(__dirname, '../..')
const CLI = process.platform === 'win32' ? requiredNativeCli('opencode') : null
const PS = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null

function npmCli() {
  return [process.env.npm_execpath, path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'].filter(Boolean).find(file => fs.existsSync(file))
}
function run(executable, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, argv, { shell: false, ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out running ${executable}`)) }, options.timeout || 3600000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }) })
  })
}
function quote(value) { return `'${String(value).replaceAll("'", "''")}'` }
function activationFailureLogs(root) {
  const logs = []
  const capture = file => {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return
      const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(Math.min(stat.size, 16384))
      // Shared capability cases repeat the first failure at the end of TAP.
      // Preserve its initial native diagnostic as well as the terminal tail.
      const first = Buffer.alloc(Math.min(stat.size, 65536))
      try {
        fs.readSync(fd, first, 0, first.length, 0)
        fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length))
      } finally { fs.closeSync(fd) }
      logs.push({ path: path.relative(root, file), head: first.toString('utf8'), tail: bytes.toString('utf8') })
    } catch {}
  }
  const parent = path.join(root, '.autoprompt-private', 'activations')
  for (const id of fs.existsSync(parent) ? fs.readdirSync(parent).filter(name => /^apv2-[a-f0-9]{32}$/.test(name)).slice(0, 2) : []) {
    capture(path.join(parent, id, 'activation.json'))
    const canaries = path.join(parent, id, 'reviewed-local-canary')
    for (const generation of fs.existsSync(canaries) ? fs.readdirSync(canaries).filter(name => /^generation-[1-9][0-9]*$/.test(name)).slice(0, 2) : []) {
      const directory = path.join(canaries, generation)
      for (const name of fs.readdirSync(directory).filter(name => /^outer-[a-f0-9-]{36}\.(?:status\.json|failure\.json|stdout\.log|stderr\.log)$/.test(name)).slice(0, 8)) capture(path.join(directory, name))
    }
  }
  return logs
}

test('Windows public OpenCode activation preserves cmd and PowerShell separators after native canary', { skip: process.platform !== 'win32' || !CLI, timeout: 7200000 }, async t => {
  if (process.env.AUTOPROMPT_CI_EXPECTED_ARCH) assert.equal(process.arch, process.env.AUTOPROMPT_CI_EXPECTED_ARCH)
  assert.ok(PS && fs.existsSync(PS), 'Windows PowerShell is required')
  const npm = npmCli(); assert.ok(npm, 'npm CLI is required')
  assert.match(CLI, /\.cmd$/iu, 'the actual installed OpenCode command shim is required')
  let onMission = null
  const endpoint = await opencodePublicEndpoint({ onMission: body => { assert.ok(onMission, 'mission endpoint is not armed'); onMission(body) } })
  const directory = privateDirectory(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt issue28 public '))))
  let completed = false, owner = null, lastActivation = null
  t.after(async () => {
    if (!completed && lastActivation) {
      const result = lastActivation.result
      console.error(JSON.stringify({ publicActivationFailure: lastActivation.form, endpointErrors: endpoint.errors.slice(0, 4),
        result: result ? { code: result.code, signal: result.signal, error: result.error, errorCode: result.errorCode,
          stdout: String(result.stdout || '').slice(-16384), stderr: String(result.stderr || '').slice(-16384) } : null,
        logs: activationFailureLogs(lastActivation.root) }))
    }
    let failure
    try { if (owner) { await owner.cancelAll({ reason: 'public OpenCode fixture cleanup', graceMs: 500, killMs: 2000, waitForPending: true }); await owner.assertDrained(); assert.equal(owner.ownershipIdentities().length, 0) } } catch (error) { failure = error }
    try { await endpoint.close() } catch (error) { failure ||= error }
    if (completed && !failure) fs.rmSync(directory, { recursive: true, force: true })
    else t.diagnostic(`Public issue-28 fixture retained: ${directory}`)
    if (failure) throw failure
  })
  const home = privateDirectory(path.join(directory, 'home')), tmp = privateDirectory(path.join(directory, 'tmp'))
  const environment = { ...nativeEnvironment(), HOME: home, USERPROFILE: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1', PATH: [path.dirname(CLI), path.dirname(process.execPath), process.env.PATH].join(path.delimiter), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_cache: path.join(directory, 'empty npm cache'), AUTOPROMPT_OPENCODE_CLI: CLI, OPENAI_API_KEY: 'issue28-local-only' }
  let result = await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: ROOT, env: environment }); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const packed = JSON.parse(result.stdout)[0]
  const prefix = path.join(directory, 'installed package')
  result = await run(process.execPath, [npm, 'install', '--ignore-scripts', '--offline', '--prefix', prefix, path.join(directory, packed.filename)], { cwd: directory, env: environment })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const source = path.join(prefix, 'node_modules', 'autoprompt-skill'), publicCli = path.join(source, 'bin', 'autoprompt.cjs')
  const target = path.join(directory, 'target'); fs.mkdirSync(target, { recursive: true })
  result = await run('git', ['init', '-b', 'fixture', target], { env: environment }); assert.equal(result.status, 0, result.stderr)
  result = await run('git', ['-C', target, '-c', 'user.name=Issue 28', '-c', 'user.email=issue28@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { env: environment }); assert.equal(result.status, 0, result.stderr)
  for (const form of ['cmd', 'ps1']) {
    const root = privateDirectory(path.join(directory, `config-${form}`))
    lastActivation = { form, root }
    result = await run(process.execPath, [publicCli, 'install', 'opencode', '--root', root], { cwd: directory, env: environment }); assert.equal(result.status, 0, `${form}: ${result.stdout}\n${result.stderr}`)
    fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({ model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${endpoint.url}/v1`, apiKey: 'issue28-local-only' }, models: { model: { name: 'Issue 28 fixture', limit: { context: 32768, output: 2048 } } } } } }), { mode: 0o600 })
    const shim = path.join(prefix, 'node_modules', '.bin', `autoprompt.${form}`); assert.ok(fs.existsSync(shim), `${form} npm shim missing`)
    const mission = `Issue 28 public ${form} separator fixture`
    const installed = require(path.join(source, 'scripts/harness-v2-package.cjs')).verify('opencode', root)
    const canary = require(path.join(installed.bundle, 'scripts/harness-v2-canary.cjs'))
    const policy = canary.selectPolicy(JSON.parse(fs.readFileSync(path.join(installed.bundle, 'scripts/harness-v2-trust/evidence.json'))), 'opencode')
    let activationId, missionRequests = 0
    const inspect = status => {
      const parent = path.join(root, '.autoprompt-private', 'activations')
      const ids = fs.readdirSync(parent).filter(name => /^apv2-[a-f0-9]{32}$/u.test(name)); assert.equal(ids.length, 1)
      activationId ||= ids[0]; assert.equal(ids[0], activationId)
      const activationRoot = path.join(parent, activationId)
      const record = JSON.parse(fs.readFileSync(path.join(activationRoot, 'activation.json'), 'utf8'))
      assert.equal(record.status, status); assert.deepEqual(record.request.argv, [mission])
      assert.equal(record.reviewedLocal.mode, 'local-canary-pending')
      assert.equal(record.executable.path, fs.realpathSync.native(CLI), 'public activation must bind the reported npm command shim')
      assert.equal(record.executable.invocation.kind, 'native-exe')
      const local = record.reviewedLocalCanary
      assert.deepEqual(local.observations.map(item => item.capability).sort(), [...canary.REQUIRED].sort())
      const canaryRoot = path.join(activationRoot, 'reviewed-local-canary', `generation-${record.capability.generation}`)
      const artifacts = local.artifacts.map(item => {
        assert.equal(path.dirname(item.path), canaryRoot)
        const bytes = fs.readFileSync(item.path); assert.equal(sha256(bytes), item.sha256)
        return { ...item, bytes }
      })
      const proofBytes = fs.readFileSync(path.join(activationRoot, 'enforcement-proof.json'))
      canary.verifyActivationProof({ provider: 'opencode', installed, record, proof: JSON.parse(proofBytes), proofSha256: sha256(proofBytes), policy, artifacts })
      const statuses = fs.readdirSync(canaryRoot).filter(name => /^outer-[a-f0-9-]{36}\.status\.json$/.test(name))
      assert.equal(statuses.length, 1)
      const nativeStatus = JSON.parse(fs.readFileSync(path.join(canaryRoot, statuses[0])))
      assert.equal(nativeStatus.code, 0); assert.equal(nativeStatus.signal, null); assert.equal(nativeStatus.error, null); assert.equal(nativeStatus.errorCode, null)
      const output = `${nativeStatus.stdout || ''}\n${nativeStatus.stderr || ''}`
      for (const artifact of artifacts) assert.equal(JSON.parse(artifact.bytes).outputSha256, sha256(output))
      return record
    }
    onMission = body => {
      assert.ok(JSON.stringify(body.messages).includes(mission), 'model request must carry this exact public mission')
      inspect('active'); missionRequests++
    }
    const command = `& ${quote(shim)} activate opencode --root ${quote(root)} --target ${quote(target)} --ttl 3600 -- ${quote(mission)}`
    const executionRoot = privateDirectory(path.join(directory, `process-${form}`)), registryPath = path.join(executionRoot, 'processes.json')
    owner = new ProcessOwner({ adapter: nativeProcessAdapter(registryPath, directory), registryPath, pollMs: 20 })
    // The trusted Node trampoline remains in the same native Job as PowerShell
    // and its npm launcher descendants, so deadline cleanup drains the tree.
    const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
    const launch = `const child=require('node:child_process').spawn(${JSON.stringify(PS)},${JSON.stringify(argv)},{stdio:'inherit',shell:false});child.once('error',e=>{console.error(e);process.exitCode=1});child.once('close',(code,signal)=>{process.exitCode=signal?1:code})`
    result = await ownedTest(owner, executionRoot, environment, ['-e', launch], 3660000)
    lastActivation.result = result
    fs.writeFileSync(path.join(directory, `public-${form}-result.json`), JSON.stringify(result), { mode: 0o600 })
    assert.equal(result.error, null); assert.equal(result.errorCode, null); assert.equal(result.signal, null)
    assert.equal(result.code, 1, `${form}: ${result.stdout}\n${result.stderr}`)
    assert.ok(missionRequests > 0, `${form}: no authenticated public mission reached the private endpoint`)
    assert.match(result.stdout, new RegExp(`Autoprompt activation ${activationId}: status=1 revoked=true`))
    const record = inspect('revoked')
    const { readChecksummedJson } = require(path.join(installed.bundle, 'agents/codex/workflow/event-log.js'))
    const terminal = readChecksummedJson(path.join(record.supervisorRuntime.runPath, 'terminal.json'))
    assert.equal(terminal.activationId, activationId); assert.equal(terminal.runId, activationId)
    assert.equal(terminal.generation, record.capability.generation); assert.equal(terminal.missionHash, sha256(record.request.canonicalJson))
    assert.equal(terminal.outcome, 'FAILED')
    const providerTerminal = terminal.terminalEnvelope.payload.providerTerminal
    assert.equal(providerTerminal.status, 'PROVIDER_USAGE_UNKNOWN')
    assert.equal(providerTerminal.error.details.protocol, 'chat-completions')
    assert.equal(providerTerminal.error.details.upstreamStatus, 401)
    await owner.cancelAll({ reason: 'public OpenCode proof complete', graceMs: 500, killMs: 2000, waitForPending: true })
    await owner.assertDrained(); assert.equal(owner.ownershipIdentities().length, 0)
    owner = null; onMission = null

  }
  assert.ok(endpoint.requests.length > 0, 'real public activation never reached the local model endpoint')
  assert.ok(endpoint.requests.every(item => item.path.includes('/chat/completions')), JSON.stringify(endpoint.requests.map(item => item.path)))
  assert.deepEqual(endpoint.errors, [])
  completed = true
})
