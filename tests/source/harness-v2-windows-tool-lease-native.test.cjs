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
  const registryPath = path.join(root, 'processes.json'), controlRoot = path.join(root, 'process-control')
  const owner = new ProcessOwner({ adapter: createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: root }), registryPath, pollMs: 20 })
  let launched
  t.after(async () => {
    await owner.cancelAll({ graceMs: 0, killMs: 15000, reason: 'native lease fixture cleanup', waitForPending: true })
    await owner.assertDrained()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const modulePath = path.join(__dirname, '../../scripts/harness-v2-windows-tool-lease.cjs')
  const source = `require(${JSON.stringify(modulePath)}).createWindowsToolLease({lockPath:process.argv[1],lockBytes:Buffer.from(process.argv[2],'base64')});setInterval(()=>{},1000)`
  launched = await owner.launch({ executable: process.execPath, argv: ['-e', source, lockPath, lockBytes.toString('base64')], cwd: root,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR || process.env.SystemRoot }, targetKey: 'windows-tool-lease-native' })
  const readyDeadline = Date.now() + 15000
  while (!fs.existsSync(lockPath) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(fs.readFileSync(lockPath), lockBytes)
  const terminal = await owner.cancelGroup(launched.ownershipId, { graceMs: 0, killMs: 15000, reason: 'force native lease owner drain' })
  assert.equal(terminal.status, 'CANCELLED')
  launched = null
  const deadline = Date.now() + 5000
  while (fs.existsSync(lockPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(fs.existsSync(lockPath), false, 'Windows must delete the lease when forced termination closes its kernel handle')
})
