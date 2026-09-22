'use strict'
// Research controller only: no production selection, SDK mutation or global grants.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const assert = require('node:assert/strict')
// Prove active-I/O cancellation before the network-backed AF_LOCAL operation;
// its compatibility failure must not prevent the cancellation test from running.
const MODES = ['pipe-fork', 'fifo', 'locks', 'blocked-fifo', 'null', 'af-local']
// A noninteractive asynchronous Bash command receives /dev/null as stdin.
// Require its read to observe EOF before the syscall fixture starts.
const BASH_WRAPPER = 'output=$1; shift; if [ "$2" = null ]; then ( IFS= read -r line; [ $? -eq 1 ] ) & child=$!; wait "$child" || exit; fi; exec "$@" > "$output"'
const SOURCE_SHA = '4e225db6364d28e7dd2b7b9458e9ac2506e9eb31358251784be4fcbf2eb0856b'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const slash = value => value.replaceAll('\\', '/')
function readyRecord(bytes) {
  assert.ok(bytes.length <= 4096, 'Readiness record exceeds limit')
  if (!bytes.length || bytes[bytes.length - 1] !== 10) return null
  const value = JSON.parse(bytes.toString('utf8'))
  assert.deepEqual(Object.keys(value).sort(), ['childPid', 'mode', 'observationMs', 'phase', 'status'])
  assert.equal(value.status, 'ready'); assert.equal(value.mode, 'blocked-fifo')
  assert.equal(value.phase, 'reader-open-no-completion'); assert.equal(value.observationMs, 100)
  assert.ok(Number.isSafeInteger(value.childPid) && value.childPid > 0 && value.childPid <= 0xffffffff)
  assert.equal(bytes.toString('utf8'), JSON.stringify(value) + '\n')
  return value
}
function fixtureDigest(bytes) {
  const text = bytes.toString('ascii')
  assert.ok(Buffer.from(text, 'ascii').equals(bytes), 'Fixture receipt must be ASCII')
  const lines = text.split('\n')
  assert.equal(lines.length, 3); assert.equal(lines[2], '')
  assert.match(lines[0], new RegExp('^' + SOURCE_SHA + ' [ *]posix-proof\\.c$'))
  const match = /^([a-f0-9]{64}) [ *]posix-proof\.exe$/.exec(lines[1]); assert.ok(match)
  return match[1]
}
async function runPosix(capability, smokeCapability, outputArgument) {
  assert.equal(process.platform, 'win32', 'Native Windows required')
  const { repo, tuple, original, fixture, fixtureSource } = require('./harness.cjs').inputsAfterSmoke(capability, smokeCapability)
  assert.equal(tuple.nativeArchitecture, process.arch)
  const api = name => require(path.join(repo, 'agents/codex/workflow', name))
  const { readBounded, closureRecords } = require(path.join(repo, 'scripts/windows-msys/probe-built-runtime.cjs'))
  const { bindBashRuntime, importedDlls } = api('windows-appcontainer-command.js')
  const { ensureWindowsPrivateAcl } = api('safe-run-root.js')
  const { createWindowsAppContainerLauncher } = api('windows-appcontainer.js')
  const { stageWindowsHelperDeployment } = api('windows-helper-deployment.js')
  const { prepareWindowsAppContainerResources, recoverWindowsAppContainerResources } = api('windows-appcontainer-resources.js')
  assert.equal(sha(fixtureSource), SOURCE_SHA)
  const fixtureSha = sha(fixture)
  assert.equal(fixtureSha, tuple.fixtureSha256)
  const fixtureRelocation = require('./fixture-relocation.cjs').derive(fixture, tuple.fixtureSha256)
  const fixtureRelocationRecipeSha256 = sha(fs.readFileSync(path.join(repo, 'scripts/windows-msys/portable-probe/fixture-relocation.cjs')))
  const runtimeRecords = closureRecords(original)
  const dependencies = importedDlls(fixture)
  const pe = fixture.readUInt32LE(60); assert.equal(fixture.readUInt16LE(pe + 4), 0x8664, 'Fixture must be x64 MSYS')
  assert.ok(dependencies.includes('msys-2.0.dll'))
  const names = new Set(original.map(file => file.name))
  for (const name of dependencies) {
    if (names.has(name)) continue
    if (/^(?:api-ms-win-|ext-ms-win-)[a-z0-9.-]+\.dll$/.test(name)) continue
    // No SDK/PATH search or extra DLL admission. Existing physical OS modules only.
    const file = path.join(process.env.SystemRoot, 'System32', name)
    assert.equal(fs.realpathSync.native(file).toLowerCase(), path.resolve(file).toLowerCase())
    for (let cursor = file; ; cursor = path.dirname(cursor)) {
      const stat = fs.lstatSync(cursor)
      assert.equal(stat.isSymbolicLink(), false)
      assert.ok(cursor === file ? stat.isFile() && stat.size > 0 && stat.size <= 64 * 1024 * 1024 : stat.isDirectory())
      if (cursor === path.parse(cursor).root) break
    }
    // Windows-serviced System32 modules can have legitimate multiple hardlinks.
    // They are OS imports, never copied fixture inputs or writable resources.
  }
  const root = path.resolve(outputArgument)
  assert.equal(fs.existsSync(root), false, 'Fresh portable POSIX output required')
  assert.equal(fs.realpathSync.native(path.dirname(root)), path.dirname(root))
  const mkdir = name => { const dir = path.join(root, name); fs.mkdirSync(dir); ensureWindowsPrivateAcl(dir); return dir }
  fs.mkdirSync(root); ensureWindowsPrivateAcl(root)
  const runtimeRoot = mkdir('runtime')
  const runtime = path.join(runtimeRoot, 'usr', 'bin')
  fs.mkdirSync(runtime, { recursive: true })
  fs.mkdirSync(path.join(runtimeRoot, 'etc'))
  fs.writeFileSync(path.join(runtimeRoot, 'etc', 'fstab'), 'none /tmp usertemp binary,posix=0,noacl 0 0\n', { flag: 'wx', mode: 0o400 })
  for (const file of original) fs.writeFileSync(path.join(runtime, file.name), file.bytes, { flag: 'wx', mode: 0o500 })
  fs.writeFileSync(path.join(runtime, 'posix-proof.exe'), fixtureRelocation.bytes, { flag: 'wx', mode: 0o500 })
  const copied = bindBashRuntime(runtime, process.env.SystemRoot)
  assert.deepEqual(closureRecords(copied), runtimeRecords)
  const bash = copied.find(file => file.name === 'bash.exe'), msys = copied.find(file => file.name === 'msys-2.0.dll')
  const logPath = path.join(root, 'results.jsonl')
  const note = require('./progress.cjs').createBoundedJsonl(logPath)
  note({ status: 'bound', tuple, accepted: false, root, sourceSha256: SOURCE_SHA, fixtureSha256: fixtureSha, fixtureTransformation: fixtureRelocation.receipt, fixtureTransformationRecipeSha256: fixtureRelocationRecipeSha256, runtime: closureRecords(copied), mqueue: 'not-run: isolated /dev/mqueue backing required' })
  for (const mode of MODES) {
    const controlRoot = mkdir(mode + '-control'), scratch = mkdir(mode + '-scratch'), target = mkdir(mode + '-target')
    const stdoutPath = path.join(scratch, 'fixture-output.jsonl'), cancellationPath = path.join(controlRoot, 'cancel')
    const deployment = stageWindowsHelperDeployment(controlRoot)
    let launcher, lease, evidence, released = false, recoveryPending = false, monitor, monitorError, ready = null
    const stop = new AbortController()
    try {
      launcher = createWindowsAppContainerLauncher({ deploymentRoot: deployment.root })
      lease = await prepareWindowsAppContainerResources({
        policy: { readOnly: true, targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch] },
        controlRoot, deploymentRoot: deployment.root, executableRoots: [{ path: runtimeRoot, kind: 'directory' }], verifyDrainEvidence: launcher.verifyDrainEvidence,
      })
      const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, SystemDrive: process.env.SystemRoot.slice(0, 2),
        PATH: runtime, MSYSTEM: 'MSYS', CHERE_INVOKING: '1', ...lease.environment }
      let settled = false
      const launch = launcher.launch({ profileName: lease.profileName, profileSid: lease.profileSid,
        executable: bash.path, executableSha256: bash.sha256,
        msysRuntime: { dllPath: msys.path, dllSha256: msys.sha256, sharedId: msys.sharedId },
        arguments: ['--noprofile', '--norc', '-c', BASH_WRAPPER, '--', slash(stdoutPath), slash(path.join(runtime, 'posix-proof.exe')), mode, slash(scratch)],
        cwd: scratch, environment: Object.entries(env).map(([key, value]) => key + '=' + value),
        timeoutMs: 25000, outputLimit: 65536, cancellationPath,
      }, { signal: stop.signal, leaseId: lease.recovery.leaseId })
      // Rejection handled immediately; monitor cannot leave an unhandled promise.
      const completion = launch.then(value => { settled = true; return value }, error => { settled = true; throw error })
      completion.catch(() => {})
      monitor = mode === 'blocked-fifo' ? (async () => {
        const deadline = Date.now() + 140000
        try {
          while (!settled && Date.now() < deadline) {
            try {
              const stat = fs.lstatSync(stdoutPath)
              assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4096)
              if (stat.size) ready = readyRecord(readBounded(stdoutPath, 4096))
            } catch (error) { if (error.code !== 'ENOENT') throw error }
            if (ready) { stop.abort(); return }
            await delay(50)
          }
          assert.ok(ready, 'Owned blocked FIFO never reached its exact ready marker')
        } catch (error) { monitorError = error; stop.abort() }
      })() : Promise.resolve()
      evidence = await completion
      await monitor
      // Release happens even for a syscall failure, but only with the authentic
      // launcher-owned evidence of whole-job drain. Errors never authorize cleanup.
      await lease.release(evidence); released = true
      const stdout = fs.existsSync(stdoutPath) && fs.lstatSync(stdoutPath).size ? readBounded(stdoutPath, 65536).toString('utf8') : ''
      note({ mode, status: 'observed', exitCode: evidence.exitCode, cancelled: evidence.cancelled, timedOut: evidence.timedOut,
        truncated: evidence.truncated, drained: evidence.drained, observedJobMembers: evidence.observedJobMembers,
        stdout, stderr: evidence.stderr.toString('utf8'), ready, restored: true })
      assert.equal(evidence.drained, true); assert.equal(evidence.truncated, false)
      assert.equal(evidence.stdout.length, 0); assert.equal(evidence.stderr.length, 0)
      assert.ifError(monitorError)
      if (mode === 'blocked-fifo') {
        assert.ok(ready); assert.equal(evidence.cancelled, true); assert.equal(evidence.timedOut, false)
        assert.deepEqual(readyRecord(Buffer.from(stdout)), ready)
        const before = fs.readdirSync(scratch).sort()
        await delay(200)
        assert.deepEqual(fs.readdirSync(scratch).sort(), before)
        assert.equal(readBounded(stdoutPath, 4096).toString('utf8'), stdout)
      } else {
        assert.equal(evidence.exitCode, 0); assert.equal(evidence.cancelled, false); assert.equal(evidence.timedOut, false)
        const expected = { status: 'passed', mode, supported: true }
        if (mode === 'null') expected.capabilityRefusals = 3
        assert.equal(stdout, JSON.stringify(expected) + '\n')
        assert.deepEqual(fs.readdirSync(scratch), ['fixture-output.jsonl'])
      }
      assert.deepEqual(closureRecords(bindBashRuntime(runtime, process.env.SystemRoot)), runtimeRecords)
      assert.equal(sha(readBounded(path.join(runtime, 'posix-proof.exe'))), fixtureRelocation.receipt.derivedSha256)
      note({ mode, status: 'passed' })
    } catch (error) {
      stop.abort(); if (monitor) await monitor
      if (!lease && error.recovery) {
        recoveryPending = true
        const unused = launcher.proveNotStarted({ profileSid: error.recovery.profileSid, leaseId: error.recovery.leaseId })
        await recoverWindowsAppContainerResources({ controlRoot, deploymentRoot: deployment.root,
          journalPath: error.recovery.journalPath, verifyDrainEvidence: launcher.verifyDrainEvidence, evidence: unused })
        recoveryPending = false; released = true
      }
      if (lease && !evidence) {
        let unused
        try { unused = launcher.proveNotStarted({ profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }) } catch {}
        if (unused) { await lease.release(unused); released = true }
      }
      note({ mode, status: 'failed', error: error.message, recovery: lease && !released ? { ...lease.recovery, profileSid: lease.profileSid } : null,
        retainedRoot: root, cleanupConfirmed: released })
      throw error
    } finally {
      if ((!lease && !recoveryPending) || released) deployment.cleanup()
      // Keep all proof artifacts, even after restoration, for review. If drain
      // is uncertain retain the deployment, resource journal, cancel and runtime.
    }
  }
  assert.deepEqual(closureRecords(bindBashRuntime(runtime, process.env.SystemRoot)), runtimeRecords)
  assert.equal(sha(readBounded(path.join(runtime, 'posix-proof.exe'))), fixtureRelocation.receipt.derivedSha256)
  const receipt = { status: 'consumer-native-posix-passed-not-accepted', modes: MODES, tuple,
    fixtureTransformation: fixtureRelocation.receipt, fixtureTransformationRecipeSha256: fixtureRelocationRecipeSha256,
    mqueue: 'not-run: isolated /dev/mqueue backing required', root, accepted: false }
  note(receipt)
  return Object.freeze(receipt)
}
module.exports = { runPosix, readyRecord, fixtureDigest, MODES, SOURCE_SHA, BASH_WRAPPER }
