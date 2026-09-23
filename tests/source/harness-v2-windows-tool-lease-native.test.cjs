'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const test = require('node:test')
const { ProcessOwner, createWindowsJobAdapter } = require('../../agents/codex/workflow/process-owner.js')
const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
const { POWERSHELL_SOURCE } = require('../../scripts/harness-v2-windows-tool-lease.cjs')

test('PowerShell FileStream delete-on-close probe records host semantics for normal EOF and forced holder death', { timeout: 30000 }, async t => {
  const powershell = process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : process.env.AUTOPROMPT_TEST_PWSH || 'pwsh'
  const available = childProcess.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 5000 })
  if (available.status !== 0) return t.skip('PowerShell is unavailable')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-lease-pwsh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const deleted = []
  for (const forced of [false, true]) {
    const lockPath = path.join(root, forced ? 'forced.lock' : 'normal.lock'), readyPath = `${lockPath}.ready`
    const lockBytes = Buffer.from(forced ? 'forced-exact' : 'normal-exact'), readyBytes = Buffer.from('ready-exact')
    const environment = { ...process.env,
      AUTOPROMPT_TOOL_LEASE_PATH_B64: Buffer.from(lockPath).toString('base64'), AUTOPROMPT_TOOL_LEASE_BYTES_B64: lockBytes.toString('base64'),
      AUTOPROMPT_TOOL_LEASE_READY_PATH_B64: Buffer.from(readyPath).toString('base64'), AUTOPROMPT_TOOL_LEASE_READY_BYTES_B64: readyBytes.toString('base64') }
    const child = childProcess.spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(POWERSHELL_SOURCE, 'utf16le').toString('base64')],
      { env: environment, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
    const deadline = Date.now() + 10000
    while ((!fs.existsSync(lockPath) || !fs.existsSync(readyPath)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(fs.readFileSync(lockPath), lockBytes, stderr)
    assert.deepEqual(fs.readFileSync(readyPath), readyBytes, stderr)
    fs.unlinkSync(readyPath)
    const closed = new Promise(resolve => child.once('close', resolve))
    if (forced) child.kill('SIGKILL'); else child.stdin.end('\n')
    await closed
    deleted.push(!fs.existsSync(lockPath))
    fs.rmSync(lockPath, { force: true })
  }
  if (process.platform === 'win32') assert.deepEqual(deleted, [true, true])
  else t.diagnostic(`Non-Windows PowerShell DeleteOnClose observations (normal, forced): ${JSON.stringify(deleted)}; Windows admission is established only by the native Job test`)
})

test('native Windows forced process-tree termination releases the kernel-owned tool lease', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-lease-native-')))
  ensureWindowsPrivateAcl(root)
  const lockPath = path.join(root, 'server.lock'), lockBytes = Buffer.from(JSON.stringify({ nonce: 'native-delete-on-close' }))
  const readyPath = path.join(root, 'lease.ready'), childLogPath = path.join(root, 'lease-child.log')
  const registryPath = path.join(root, 'processes.json'), controlRoot = path.join(root, 'process-control')
  const owner = new ProcessOwner({ adapter: createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: root }), registryPath, pollMs: 20 })
  const startedAt = Date.now()
  const stage = (name, details = {}) => {
    t.diagnostic(JSON.stringify({ leaseStage: name, elapsedMs: Date.now() - startedAt, ...details }))
  }
  const snapshot = (name) => {
    let registry = null
    try { registry = fs.readFileSync(registryPath, 'utf8').slice(-8000) } catch (error) { registry = `unreadable:${error.code || error.message}` }
    let records = []
    try {
      records = [...owner.groups.values()].map(record => ({ ownershipId: record.ownershipId, status: record.status,
        rootPid: record.rootPid || null, groupIdentity: record.groupIdentity || null, reservationId: record.reservationId || null }))
    } catch (error) { records = [`unreadable:${error.code || error.message}`] }
    let childLog = null
    try { childLog = fs.readFileSync(childLogPath, 'utf8').slice(-4000) } catch (error) { childLog = `unreadable:${error.code || error.message}` }
    let ownershipIdentities = null
    try { ownershipIdentities = owner.ownershipIdentities() } catch (error) { ownershipIdentities = `unreadable:${error.code || error.message}` }
    stage(name, { records, ownershipIdentities, registry, childLog,
      lockExists: fs.existsSync(lockPath), readyExists: fs.existsSync(readyPath) })
  }
  let launched
  let cleanupSucceeded = false
  t.after(async () => {
    stage('cleanup:begin')
    snapshot('cleanup:before-cancelAll')
    try {
      stage('cleanup:before-cancelAll-await')
      await owner.cancelAll({ graceMs: 0, killMs: 15000, reason: 'native lease fixture cleanup', waitForPending: true })
      stage('cleanup:after-cancelAll')
      snapshot('cleanup:after-cancelAll')
      stage('cleanup:before-assertDrained-await')
      await owner.assertDrained()
      stage('cleanup:after-assertDrained')
      cleanupSucceeded = true
    } catch (error) {
      stage('cleanup:error', { code: error.code || 'ERROR', message: error.message, details: error.details || null })
      snapshot('cleanup:failure')
      throw error
    } finally {
      if (cleanupSucceeded) {
        stage('cleanup:before-delete')
        fs.rmSync(root, { recursive: true, force: true })
      } else {
        stage('cleanup:retained-root')
      }
    }
  })
  const modulePath = path.join(__dirname, '../../scripts/harness-v2-windows-tool-lease.cjs')
  const source = `const fs=require('node:fs');try{const lease=require(${JSON.stringify(modulePath)}).createWindowsToolLease({lockPath:process.argv[1],lockBytes:Buffer.from(process.argv[2],'base64')});lease.assertHeld();fs.writeFileSync(process.argv[3],'ready',{flag:'wx'});setInterval(()=>{},1000)}catch(error){try{fs.appendFileSync(process.argv[4],JSON.stringify({name:error.name,code:error.code,message:error.message,stack:error.stack})+'\\n')}catch{};throw error}`
  stage('before-owner-launch')
  try {
    launched = await owner.launch({ executable: process.execPath, argv: ['-e', source, lockPath, lockBytes.toString('base64'), readyPath, childLogPath], cwd: root,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR || process.env.SystemRoot }, targetKey: 'windows-tool-lease-native' })
    stage('after-owner-launch', { ownershipId: launched.ownershipId, rootPid: launched.rootPid, groupIdentity: launched.groupIdentity })
  } catch (error) {
    stage('owner-launch:error', { code: error.code || 'ERROR', message: error.message, details: error.details || null })
    snapshot('owner-launch:failure')
    throw error
  }
  const readyDeadline = Date.now() + 15000
  stage('before-child-ready-poll')
  while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  stage('after-child-ready-poll')
  snapshot('child-ready-result')
  assert.equal(fs.readFileSync(readyPath, 'utf8'), 'ready')
  assert.deepEqual(fs.readFileSync(lockPath), lockBytes)
  stage('before-assertHeld')
  // The receipt is written only after createWindowsToolLease().assertHeld().
  const leaseExists = fs.existsSync(lockPath)
  assert.equal(leaseExists, true)
  stage('after-assertHeld')
  stage('before-cancelGroup-await', { ownershipId: launched.ownershipId })
  let terminal
  try {
    terminal = await owner.cancelGroup(launched.ownershipId, { graceMs: 0, killMs: 15000, reason: 'force native lease owner drain' })
  } catch (error) {
    stage('cancelGroup:error', { code: error.code || 'ERROR', message: error.message, details: error.details || null })
    snapshot('cancelGroup:failure')
    throw error
  }
  stage('after-cancelGroup', { terminalStatus: terminal && terminal.status })
  assert.equal(terminal.status, 'CANCELLED')
  launched = null
  const deadline = Date.now() + 5000
  stage('before-lock-release-poll')
  while (fs.existsSync(lockPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  stage('after-lock-release-poll')
  assert.equal(fs.existsSync(lockPath), false, 'Windows must delete the lease when forced termination closes its kernel handle')
})
