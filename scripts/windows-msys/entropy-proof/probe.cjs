'use strict'
// Differential diagnostics only; observed crypto failures are never admission.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const repo = path.resolve(__dirname, '../../..')
const api = name => require(path.join(repo, 'agents/codex/workflow', name))
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const nodeSource = "const crypto=require('node:crypto');const a=crypto.randomBytes(32),b=crypto.randomBytes(32);if(a.equals(b))throw Error('repeated-entropy');process.stdout.write('node-entropy-ok\\n')"
function scenarios(runtime, systemRoot) {
  const node = path.join(runtime, 'node.exe'), diagnostic = path.join(runtime, 'entropy-proof.exe'), bash = path.join(runtime, 'bash.exe')
  const shell = (executable, args) => ['--noprofile', '--norc', '-c', [executable.replaceAll('\\', '/'), ...args].map(quote).join(' ')]
  const cases = [
    { name: 'minimal-direct-entropy', executable: diagnostic, args: [], systemPath: false, minimal: true },
    { name: 'minimal-direct-node', executable: node, args: ['-e', nodeSource], systemPath: false, minimal: true },
    { name: 'direct-entropy', executable: diagnostic, args: [], systemPath: false },
    { name: 'bash-entropy', executable: bash, args: shell(diagnostic, []), systemPath: false },
    { name: 'direct-node', executable: node, args: ['-e', nodeSource], systemPath: false },
    { name: 'bash-node', executable: bash, args: shell(node, ['-e', nodeSource]), systemPath: false },
    { name: 'direct-node-system-path', executable: node, args: ['-e', nodeSource], systemPath: true },
    { name: 'bash-node-system-path', executable: bash, args: shell(node, ['-e', nodeSource]), systemPath: true },
  ]
  return cases.map(value => ({ ...value, path: runtime + (value.systemPath ? ';' + path.join(systemRoot, 'System32') : '') }))
}
function observation(item, evidence, profileSid) {
  assert.ok(evidence && Buffer.isBuffer(evidence.stdout) && Buffer.isBuffer(evidence.stderr))
  assert.ok(!evidence.timedOut && !evidence.truncated && !evidence.cancelled, 'Diagnostic observation must complete within its native limits')
  assert.ok(Number.isSafeInteger(evidence.exitCode) && evidence.exitCode >= 0)
  assert.ok(evidence.stdout.length + evidence.stderr.length <= 131072)
  if (item.name.includes('node') && evidence.exitCode === 0) {
    assert.equal(evidence.stdout.toString('utf8'), 'node-entropy-ok\n')
    assert.equal(evidence.stderr.length, 0)
  }
  return { schemaVersion: 1, status: 'observed-not-accepted', name: item.name, profileSid,
    launcherSessionId: evidence.launcherSessionId, exitCode: evidence.exitCode,
    stdoutBase64: evidence.stdout.toString('base64'), stderrBase64: evidence.stderr.toString('base64') }
}
async function main(workArgument, diagnosticArgument) {
  assert.equal(process.platform, 'win32')
  const { readBounded, stagedDigest, closureRecords } = require('../probe-built-runtime.cjs')
  const { bindBashRuntime } = api('windows-appcontainer-command.js')
  const { ensureWindowsPrivateAcl } = api('safe-run-root.js')
  const { createWindowsAppContainerLauncher } = api('windows-appcontainer.js')
  const { stageWindowsHelperDeployment } = api('windows-helper-deployment.js')
  const { prepareWindowsAppContainerResources, recoverWindowsAppContainerResources } = api('windows-appcontainer-resources.js')
  const work = fs.realpathSync.native(path.resolve(workArgument))
  const payload = path.join(work, 'sdk', 'issue27-build')
  const smoke = JSON.parse(readBounded(path.join(payload, 'built-runtime-manifest.json')))
  assert.equal(path.dirname(smoke.runtimeDirectory).toLowerCase(), payload.toLowerCase())
  assert.match(path.basename(smoke.runtimeDirectory), /^proof-runtime-[a-f0-9-]+$/)
  const source = bindBashRuntime(smoke.runtimeDirectory, process.env.SystemRoot)
  assert.deepEqual(closureRecords(source), smoke.copied)
  assert.equal(stagedDigest(readBounded(path.join(payload, 'stage.sha256'))), smoke.stageSha256)
  const msys = source.find(file => file.name === 'msys-2.0.dll')
  assert.equal(msys.sha256, smoke.stageSha256)
  const diagnosticRoot = fs.realpathSync.native(path.resolve(diagnosticArgument))
  const diagnostic = readBounded(path.join(diagnosticRoot, 'entropy-proof.exe'))
  const diagnosticManifest = JSON.parse(readBounded(path.join(diagnosticRoot, 'manifest.json')))
  assert.equal(diagnosticManifest.executableSha256, sha(diagnostic))
  assert.equal(diagnosticManifest.sourceSha256, sha(readBounded(path.join(__dirname, 'entropy-proof.cc'))))
  assert.equal(diagnosticManifest.buildScriptSha256, sha(readBounded(path.join(__dirname, 'build.cjs'))))
  assert.equal(diagnosticManifest.toolchainSha256, sha(readBounded(path.join(diagnosticRoot, 'toolchain.json'))))
  assert.equal(diagnosticManifest.architecture, process.arch)
  const node = readBounded(fs.realpathSync.native(process.execPath), 128 * 1024 * 1024)
  const root = path.join(payload, 'entropy-runtime-' + crypto.randomUUID())
  fs.mkdirSync(root); ensureWindowsPrivateAcl(root)
  const mkdir = name => { const directory = path.join(root, name); fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory); return directory }
  const controlRoot = mkdir('control'), scratch = mkdir('scratch'), target = mkdir('target'), runtimeRoot = mkdir('runtime')
  const runtime = path.join(runtimeRoot, 'usr', 'bin')
  fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(path.join(runtimeRoot, 'etc'))
  fs.writeFileSync(path.join(runtimeRoot, 'etc', 'fstab'), 'none /tmp usertemp binary,posix=0,noacl 0 0\n', { flag: 'wx' })
  const bindings = [...source, { name: 'node.exe', bytes: node, sha256: sha(node) }, { name: 'entropy-proof.exe', bytes: diagnostic, sha256: sha(diagnostic) }]
  for (const file of bindings) {
    fs.writeFileSync(path.join(runtime, file.name), file.bytes, { flag: 'wx', mode: 0o500 })
    assert.equal(sha(readBounded(path.join(runtime, file.name), 128 * 1024 * 1024)), file.sha256)
  }
  const output = path.join(payload, 'entropy-proof.jsonl')
  fs.writeFileSync(output, '', { flag: 'wx' })
  const note = value => { const line = JSON.stringify(value) + '\n'; fs.appendFileSync(output, line); process.stdout.write(line) }
  const deployment = stageWindowsHelperDeployment(controlRoot)
  const launcher = createWindowsAppContainerLauncher({ deploymentRoot: deployment.root })
  let lease, latestEvidence, released = false, recoveryPending = false
  try {
    lease = await prepareWindowsAppContainerResources({
      policy: { readOnly: true, targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch] },
      controlRoot, deploymentRoot: deployment.root, executableRoots: [{ path: runtimeRoot, kind: 'directory' }], verifyDrainEvidence: launcher.verifyDrainEvidence,
    })
    note({ status: 'bound', profileSid: lease.profileSid, nodeSha256: sha(node), nodeVersion: process.version,
      bashSha256: source.find(file => file.name === 'bash.exe').sha256, msysSha256: msys.sha256,
      diagnosticSha256: sha(diagnostic), nativeHelperSha256: sha(readBounded(path.join(deployment.root, 'windows-appcontainer-native.cs'))) })
    const systemRoot = process.env.SystemRoot
    for (const item of scenarios(runtime, systemRoot)) {
      // Clear the previous observation before starting another job. A failure
      // may never use stale drain evidence to release this shared profile.
      latestEvidence = null
      const environment = {
        SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), LOCALAPPDATA: process.env.LOCALAPPDATA || '',
        PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: item.path, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1',
        NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main', AUTOPROMPT_APP_CONTAINER_SID: lease.profileSid,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
        GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'push.default', GIT_CONFIG_VALUE_0: 'nothing',
        GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'core.sshCommand', GIT_CONFIG_VALUE_2: 'cmd /d /c exit 1',
        ...lease.environment,
      }
      const selectedEnvironment = item.minimal ? { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), LOCALAPPDATA: process.env.LOCALAPPDATA || '', PATH: item.path, ...lease.environment } : environment
      latestEvidence = await launcher.launch({ profileName: lease.profileName, profileSid: lease.profileSid,
        executable: item.executable, executableSha256: bindings.find(file => file.name === path.basename(item.executable)).sha256,
        ...(item.name.startsWith('bash-') ? { msysRuntime: { dllPath: path.join(runtime, 'msys-2.0.dll'), dllSha256: msys.sha256, sharedId: msys.sharedId } } : {}),
        arguments: item.args, cwd: target, environment: Object.entries(selectedEnvironment).map(([key, value]) => key + '=' + value),
        timeoutMs: 15000, outputLimit: 131072, cancellationPath: path.join(controlRoot, 'cancel-' + item.name),
      }, { leaseId: lease.recovery.leaseId })
      assert.equal(launcher.verifyDrainEvidence(latestEvidence, { profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }), true)
      const record = observation(item, latestEvidence, lease.profileSid)
      if (item.name.endsWith('entropy')) {
        assert.equal(latestEvidence.exitCode, 0)
        assert.equal(latestEvidence.stderr.length, 0)
        try { record.entropy = require('./parse.cjs').parseDiagnostic(latestEvidence.stdout.toString('utf8'), lease.profileSid) }
        catch (error) { note({ ...record, drained: true, parseError: String(error.message).slice(0, 512) }); throw error }
      }
      note({ ...record, drained: true })
    }
    await lease.release(latestEvidence); released = true
    note({ status: 'diagnostics-complete-not-accepted', launches: 8, drainedJobs: 8 })
  } catch (error) {
    if (!lease && error.recovery) {
      recoveryPending = true
      const evidence = launcher.proveNotStarted({ profileSid: error.recovery.profileSid, leaseId: error.recovery.leaseId })
      await recoverWindowsAppContainerResources({ controlRoot, deploymentRoot: deployment.root, journalPath: error.recovery.journalPath, verifyDrainEvidence: launcher.verifyDrainEvidence, evidence })
      recoveryPending = false; released = true
    }
    if (lease && latestEvidence) { await lease.release(latestEvidence); released = true }
    if (lease && !released) error.recovery = lease.recovery
    throw error
  } finally {
    if ((!lease && !recoveryPending) || released) { deployment.cleanup(); fs.rmSync(root, { recursive: true, force: true }) }
  }
}
if (require.main === module) main(...process.argv.slice(2)).catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1 })
module.exports = { scenarios, observation, quote }
