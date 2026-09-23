'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const sandbox = require('../../scripts/darwin-command-sandbox.cjs')

const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function writeNativeEvidence(body) {
  const directory = process.env.AUTOPROMPT_DARWIN_COMMAND_EVIDENCE_DIR
  if (!directory) return
  const name = process.env.AUTOPROMPT_DARWIN_COMMAND_EVIDENCE_NAME || 'darwin-command-sandbox-evidence.json'
  if (!path.isAbsolute(directory) || path.basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/.test(name)) {
    throw new Error('invalid Darwin command evidence destination')
  }
  const root = fs.realpathSync.native(directory)
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Darwin command evidence directory is invalid')
  fs.writeFileSync(path.join(root, name), `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function ownPidDiagnostics(records, startedAt, ownedPid) {
  const status = records.find(record => /(?:^|\/)status\.json$/.test(record.name))
  let pid = ownedPid
  if (!Number.isSafeInteger(pid)) { try { pid = JSON.parse(status?.text || '').codexPid } catch {} }
  if (!Number.isSafeInteger(pid) || pid < 1) return []
  const values = []
  const log = cp.spawnSync('/usr/bin/log', ['show', '--style', 'compact', '--last', '2m', '--predicate', `eventMessage CONTAINS[c] "[${pid}]" OR eventMessage CONTAINS[c] "(${pid})"`], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, shell: false })
  if (log.status === 0 && log.stdout) values.push({ source: 'unified-log', pid, text: log.stdout.slice(-8192) })
  const reports = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports')
  let entries = []
  try { entries = fs.readdirSync(reports, { withFileTypes: true }) } catch { return values }
  for (const entry of entries) {
    if (!entry.isFile() || values.length >= 3) continue
    const file = path.join(reports, entry.name)
    let stat
    try { stat = fs.lstatSync(file) } catch { continue }
    if (stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || stat.mtimeMs < startedAt - 60000) continue
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    if (text.includes(`[${pid}]`)) values.push({ source: 'crash-report', pid, name: entry.name, text: text.slice(-8192) })
  }
  return values
}

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-command-sandbox-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), secret = path.join(root, 'secret'), control = path.join(root, 'control'), temp = path.join(control, 'tmp')
  for (const directory of [target, scratch, secret, control, temp]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(target, 'candidate.txt'), 'candidate bytes', { mode: 0o600 })
  fs.writeFileSync(path.join(secret, 'private.txt'), 'controller secret', { mode: 0o600 })
  const helper = path.join(root, 'helper')
  const seatbelt = path.join(root, 'sandbox-exec')
  fs.writeFileSync(helper, 'helper', { mode: 0o700 }); fs.writeFileSync(seatbelt, 'sandbox', { mode: 0o700 })
  return { startedAt: Date.now(), root, target, scratch, secret, control, temp, helper: { path: helper, sha256: hashFile(helper) }, seatbelt: { path: seatbelt, sha256: hashFile(seatbelt) },
    policy: { readOnly: true, targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch] } }
}

test('Darwin Seatbelt profile is default-deny and grants only exact roots, fixed runtimes, and no network or launchd authority', t => {
  const f = fixture(t)
  const profile = sandbox.renderSeatbeltProfile(f.policy, { nodePath: process.execPath, tempRoot: f.temp })
  assert.match(profile, /^\(version 1\)\n\(deny default\)/)
  assert.match(profile, new RegExp(`\\(subpath ${JSON.stringify(f.target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
  assert.match(profile, new RegExp(`\\(subpath ${JSON.stringify(f.scratch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
  assert.match(profile, /\(allow process-exec \(literal "\/bin\/sh"\)\)/)
  assert.match(profile, /\(allow process-info\* \(target same-sandbox\)\)/)
  assert.match(profile, /\(allow mach-priv-task-port \(target same-sandbox\)\)/)
  for (const name of sandbox.NODE_STARTUP_SYSCTLS) assert.match(profile, new RegExp(`\(sysctl-name ${JSON.stringify(name)}\)`))
  for (const name of sandbox.NODE_STARTUP_MACH_SERVICES) assert.match(profile, new RegExp(`\(global-name ${JSON.stringify(name)}\)`))
  assert.equal(profile.includes('network-outbound'), false)
  assert.equal(profile.includes('network-inbound'), false)
  assert.equal(profile.includes('ipc-posix-shm'), false)
  assert.equal(profile.includes('ipc-posix-sem'), false)
  assert.equal(profile.includes('system-socket'), false)
  assert.equal(profile.includes('mach-register'), false)
  assert.equal(profile.includes('launchctl'), false)
  assert.equal(profile.includes('system-write-bootstrap'), false)
})

test('Darwin command backend binds fixed Seatbelt argv, returns raw output hashes, and refuses an undrained success', async t => {
  const f = fixture(t)
  let launch, stopCalls = 0
  const runner = {
    async run(spec) { launch = spec; return { status: 0, signal: null, stdout: 'candidate bytes', stderr: '', stdoutBase64: Buffer.from('candidate bytes').toString('base64'), stderrBase64: '', stderrSha256: crypto.createHash('sha256').update('').digest('hex'), stdoutByteCount: 15, stderrByteCount: 0, stdoutTruncated: false, stderrTruncated: false, stdoutSha256: crypto.createHash('sha256').update('candidate bytes').digest('hex'), processOwned: true, exactArgv: true, drained: true } },
    async stop() { stopCalls++; return { drained: true } },
  }
  const backend = sandbox.createDarwinCommandSandbox({ platform: 'darwin', controlRoot: f.control, tempRoot: f.temp, helper: f.helper, sandboxExecutable: f.seatbelt, processOwner: { adapter: { childControlEnvironment: id => ({ AUTOPROMPT_OWNERSHIP_RESERVATION: id }) } }, runner })
  const result = await backend.command(f.policy, { command: 'node -e "process.stdout.write(\\\"candidate bytes\\\")"', cwd: f.scratch, timeoutMs: 1000 })
  assert.equal(launch.executable, f.seatbelt.path)
  assert.deepEqual(launch.argv.slice(0, 2), ['-p', launch.argv[1]])
  assert.equal(launch.argv[2], process.execPath)
  assert.equal(launch.argv[3], '-e')
  assert.equal(launch.shell, false)
  assert.equal(launch.env.HOME, f.temp)
  assert.equal(launch.env.PATH, path.dirname(process.execPath))
  assert.equal(launch.env.AUTOPROMPT_OWNERSHIP_RESERVATION, launch.reservationId)
  assert.equal(result.status, 'completed')
  assert.equal(result.outputSha256, crypto.createHash('sha256').update('candidate bytes').digest('hex'))
  assert.equal(stopCalls, 0)

  runner.run = async () => ({ status: 0, signal: null, stdout: '', stderr: '', stdoutBase64: '', stderrBase64: '', stderrSha256: crypto.createHash('sha256').update('').digest('hex'), stdoutByteCount: 0, stderrByteCount: 0, stdoutSha256: crypto.createHash('sha256').update('').digest('hex'), processOwned: true, exactArgv: true, drained: false })
  await assert.rejects(backend.command(f.policy, { command: 'node -e "0"', cwd: f.scratch }), { code: 'PROCESS_DRAIN_TIMEOUT' })

  let settle
  runner.run = () => new Promise(resolve => { settle = resolve })
  let stopAttempts = 0
  runner.stop = async () => { stopCalls++; stopAttempts++; if (stopAttempts === 1) return { drained: true, alreadyTerminal: true }; settle({ status: 0, signal: 'OWNED_STOP', stdout: '', stderr: '', stdoutBase64: '', stderrBase64: '', stderrSha256: crypto.createHash('sha256').update('').digest('hex'), stdoutByteCount: 0, stderrByteCount: 0, stdoutTruncated: false, stderrTruncated: false, stdoutSha256: crypto.createHash('sha256').update('').digest('hex'), processOwned: true, exactArgv: true, drained: true }); return { drained: true } }
  const abort = new AbortController()
  const pending = backend.command(f.policy, { command: 'node -e "setInterval(()=>{},1000)"', cwd: f.scratch }, { signal: abort.signal })
  await new Promise(resolve => setImmediate(resolve)); abort.abort()
  const cancelled = await pending
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.status, 'failed'); assert.equal(stopCalls, 2)
  let launchedAfterAbort = false
  runner.run = async () => { launchedAfterAbort = true; throw new Error('must not launch') }
  const alreadyAborted = new AbortController(); alreadyAborted.abort()
  await assert.rejects(backend.command(f.policy, { command: 'node -e "0"', cwd: f.scratch }, { signal: alreadyAborted.signal }), { code: 'TOOL_CANCELLED' })
  assert.equal(launchedAfterAbort, false)
})

test('Darwin native command sandbox isolates candidate, scratch, controller, network, launchd, and cancellation', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const f = fixture(t)
  const helperPath = path.join(f.root, 'coalition-helper')
  const source = path.resolve(__dirname, '../../agents/codex/workflow/darwin-coalition-helper.c')
  const sdk = cp.spawnSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8', timeout: 30000, shell: false })
  assert.equal(sdk.status, 0, sdk.stderr)
  const sdkPath = sdk.stdout.trim()
  assert.ok(path.isAbsolute(sdkPath), sdk.stdout)
  const compile = cp.spawnSync('/usr/bin/cc', ['-O2', '-isysroot', sdkPath, '-mmacosx-version-min=13.5', source, '-o', helperPath], { encoding: 'utf8', timeout: 30000, shell: false })
  assert.equal(compile.status, 0, compile.stderr)
  const backend = sandbox.createDarwinCommandSandbox({ controlRoot: f.control, tempRoot: f.temp, helper: { path: helperPath, sha256: hashFile(helperPath) }, targetKey: 'darwin-command-native-test' })
  let ownedCodexPid = null
  const originalRun = backend.runner.run.bind(backend.runner)
  backend.runner.run = async spec => {
    const result = await originalRun(spec)
    if (Number.isSafeInteger(result?.codexPid) && result.codexPid > 0) ownedCodexPid = result.codexPid
    return result
  }
  const captureFailure = (error, result) => {
    const records = []
    for (const name of fs.readdirSync(f.control, { recursive: true })) {
      if (!/(?:stderr|status|exit)(?:\.log|\.json|\.txt)?$/.test(name)) continue
      const file = path.join(f.control, name), stat = fs.lstatSync(file)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536) records.push({ name, text: fs.readFileSync(file, 'utf8').slice(-8192) })
      if (records.length >= 8) break
    }
    const boundedResult = result && { status: result.status, signal: result.signal, stdout: typeof result.stdout === 'string' ? result.stdout.slice(-8192) : null, stderr: typeof result.stderr === 'string' ? result.stderr.slice(-8192) : null, outputSha256: result.outputSha256 || null, durationMs: result.durationMs }
    console.error(JSON.stringify({ fixtureFailure: error?.code || error?.message || 'command returned failed status', result: boundedResult, records, ownPidDiagnostics: ownPidDiagnostics(records, f.startedAt, ownedCodexPid) }))
  }
  const runCommand = async (...args) => {
    try {
      const result = await backend.command(...args)
      if (result.status === 'failed' && !result.cancelled && !result.timedOut) captureFailure(null, result)
      return result
    } catch (error) {
      captureFailure(error)
      throw error
    }
  }
  const code = value => `node -e ${JSON.stringify(value)}`
  const net = require('node:net'); let accepted = 0
  const listener = net.createServer(socket => { accepted++; socket.destroy() })
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => listener.close(resolve)))
  const port = listener.address().port
  await new Promise((resolve, reject) => { const proof = net.connect(port, '127.0.0.1'); proof.once('close', resolve); proof.once('error', reject) })
  assert.equal(accepted, 1, 'controller listener did not accept its control connection'); accepted = 0
  const readWrite = await runCommand(f.policy, { cwd: f.scratch, command: code(`const fs=require('fs');process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(f.target, 'candidate.txt'))},'utf8'));fs.writeFileSync(${JSON.stringify(path.join(f.scratch, 'proof.txt'))},'scratch')`) })
  assert.equal(readWrite.status, 'completed'); assert.equal(fs.readFileSync(path.join(f.scratch, 'proof.txt'), 'utf8'), 'scratch')
  const denied = await runCommand(f.policy, { cwd: f.scratch, command: code(`const fs=require('fs'),cp=require('child_process'),net=require('net');let failures=0;for(const f of [()=>fs.readFileSync(${JSON.stringify(path.join(f.secret, 'private.txt'))}),()=>fs.writeFileSync(${JSON.stringify(path.join(f.target, 'candidate.txt'))},'bad'),()=>cp.spawnSync('/bin/launchctl',['print','system'])]){try{const r=f();if(r&&r.error) failures++}catch{failures++}}const s=net.connect(${port},'127.0.0.1');s.on('error',()=>{if(++failures===4)process.exit(0)});s.on('connect',()=>process.exit(19));setTimeout(()=>process.exit(failures===4?0:20),500)`) })
  assert.equal(denied.status, 'completed'); assert.equal(fs.readFileSync(path.join(f.target, 'candidate.txt'), 'utf8'), 'candidate bytes'); assert.equal(accepted, 0, 'sandboxed child connected to the controller listener')
  const abort = new AbortController(); const held = runCommand(f.policy, { cwd: f.scratch, command: code('setInterval(()=>{},1000)') }, { signal: abort.signal, timeoutMs: 30000 })
  await new Promise(resolve => setTimeout(resolve, 250)); abort.abort()
  const cancelled = await held
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.status, 'failed')
  writeNativeEvidence({ schemaVersion: 1, backend: backend.backend, platform: process.platform, architecture: process.arch,
    node: process.version, coalitionHelperSha256: hashFile(helperPath), sandboxExecutable: backend.sandboxBinding,
    checks: { readCandidate: true, writeScratch: true, deniedPrivateRead: true, deniedCandidateOverwrite: true, deniedNetwork: true, deniedLaunchctl: true, cancellationDrained: cancelled.cancelled && cancelled.status === 'failed' } })
})
