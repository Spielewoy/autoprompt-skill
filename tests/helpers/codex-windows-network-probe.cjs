'use strict'

// Diagnostic only: retain the official elevated tool sandbox, but bind its
// offline identity to a fresh account and a separately owned WFP policy.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { privateDirectory } = require('./native-platform.cjs')
const { runtimeFromPackage, withCodexManagedEnvironment } = require('../../agents/codex/workflow/codex-executable.js')
const { installWindowsSandboxIdentity, nativeCodexHomePath, controlledNetworkProbeAddress } = require('../../scripts/codex-configure.cjs')
const { windowsControllerEnvironment } = require('../../agents/codex/workflow/safe-run-root.js')
const { ProcessOwner, createWindowsJobAdapter } = require('../../agents/codex/workflow/process-owner.js')
const { OwnedCodexProxyRunner } = require('../../agents/codex/workflow/phase-budget.js')
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const ACCOUNT_SCRIPT = `
$ErrorActionPreference='Stop'
[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),'Process')
Add-Type -AssemblyName System.Security
$r=$env:AUTOPROMPT_DIAG_REQUEST|ConvertFrom-Json
$j=Get-Content -LiteralPath $r.journal -Raw|ConvertFrom-Json
if($j.accountName -ne $r.accountName -or $j.activationId -ne $r.activationId){throw 'Account journal binding mismatch'}
function WriteJournal($state){$j.state=$state;$bytes=[Text.Encoding]::UTF8.GetBytes(($j|ConvertTo-Json -Compress));$file=[IO.File]::Open($r.journal,'Create','Write','Read');try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}}
function BoundAccount(){ $a=Get-LocalUser -Name $r.accountName -ErrorAction Stop;if($a.SID.Value -ne $j.sid){throw 'Account SID changed'};return $a }
function TargetReadRule(){return [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($j.sid),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')}
function UpdateTargetRead($remove){
 $item=Get-Item -LiteralPath $r.target -Force
 if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Target must be physical directory'}
 $acl=Get-Acl -LiteralPath $r.target
 $rule=TargetReadRule
 if($remove){$acl.RemoveAccessRuleSpecific($rule)}else{$acl.AddAccessRule($rule)}
 [IO.Directory]::SetAccessControl($r.target,$acl)
}
function ReplaceOffline($password){
 $u=Get-Content -LiteralPath $r.users -Raw|ConvertFrom-Json
 $u.offline.username=$r.accountName
 $blob=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($password),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
 $u.offline.password=[Convert]::ToBase64String($blob)
 $me=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
 $acl=Get-Acl -LiteralPath $r.users
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,'Write','Allow'))
 [IO.File]::SetAccessControl($r.users,$acl)
 [IO.File]::WriteAllText($r.users,($u|ConvertTo-Json -Compress -Depth 5),[Text.UTF8Encoding]::new($false))
 $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($me)
 $rights=[Security.AccessControl.FileSystemRights]([int][Security.AccessControl.FileSystemRights]::Read -bor [int][Security.AccessControl.FileSystemRights]::ChangePermissions)
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,$rights,'Allow'))
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,'Read','Allow'))
 [IO.File]::SetAccessControl($r.users,$acl)
}
switch($r.mode){
 'Create'{
  if(Get-LocalUser -Name $r.accountName -ErrorAction SilentlyContinue){throw 'Fresh account already exists'}
  $bytes=New-Object byte[] 48;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes);$rng.Dispose()
  $password='aA1!'+[Convert]::ToBase64String($bytes)
  $a=New-LocalUser -Name $r.accountName -Password (ConvertTo-SecureString $password -AsPlainText -Force) -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword
  $j.sid=$a.SID.Value;WriteJournal 'CREATED'
  UpdateTargetRead $false;WriteJournal 'TARGET_READ_GRANTED'
  $users=([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')).Translate([Security.Principal.NTAccount]).Value.Split('\\')[-1]
  Add-LocalGroupMember -Group $users -Member $a -ErrorAction SilentlyContinue
  Add-LocalGroupMember -Group 'CodexSandboxUsers' -Member $a
  $groups=@($users,'CodexSandboxUsers');foreach($g in $groups){if(-not(Get-LocalGroupMember -Group $g|Where-Object {$_.SID.Value -eq $j.sid})){throw 'Account group missing'}}
  ReplaceOffline $password;WriteJournal 'SEALED'
 }
 'BadPassword'{ $null=BoundAccount;ReplaceOffline ('wrong-aA1!'+[Guid]::NewGuid().ToString());WriteJournal 'BAD_PASSWORD_SEALED' }
 'Disable'{ $a=BoundAccount;Disable-LocalUser -InputObject $a;WriteJournal 'DISABLED' }
 'Delete'{ $a=BoundAccount;UpdateTargetRead $true;Remove-LocalUser -InputObject $a;if(Get-LocalUser -Name $r.accountName -ErrorAction SilentlyContinue){throw 'Account still present'};WriteJournal 'DELETED' }
 default {throw 'Unknown account operation'}
}
[pscustomobject]@{sid=$j.sid;state=$j.state}|ConvertTo-Json -Compress
`

function innerClient() {
  const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process'), path = require('node:path')
  const identity = cp.spawnSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 5000 })
  const sid = String(identity.stdout).match(/S-1-5-(?:[0-9]+-)*[0-9]+/)?.[0] || null
  const readable = fs.readFileSync(path.join(path.dirname(process.argv[1]), 'source.txt'), 'utf8') === 'source'
  let write = false, error = null
  try { fs.writeFileSync(process.argv[1], 'inner-write'); write = true } catch (failure) { error = failure.code }
  const connect = (address, port = Number(process.argv[2])) => new Promise(resolve => {
    const socket = net.connect(port, address)
    socket.setTimeout(3000, () => { socket.destroy(); resolve('TIMEOUT') })
    socket.once('connect', () => { socket.destroy(); resolve('OPEN') })
    socket.once('error', failure => resolve(failure.code))
  })
  const hold = async () => {
    if (!process.argv[5]) return
    fs.writeFileSync(process.argv[5], JSON.stringify({ pid: process.pid, sid }))
    const deadline = Date.now() + 15000
    while (!fs.existsSync(process.argv[6]) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (!fs.existsSync(process.argv[6])) throw new Error('Host Job membership release missing')
  }
  Promise.all([hold(), connect(process.argv[3]), connect('127.0.0.1'), Number(process.argv[4]) ? connect('::1', Number(process.argv[4])) : Promise.resolve('UNAVAILABLE')]).then(([, nic, loopback, ipv6]) => {
    process.stdout.write(`${JSON.stringify({ sid, identityStatus: identity.status, readable, write, error, nic, loopback, ipv6 })}\n`)
  })
}

async function main() {
  assert.equal(process.platform, 'win32')
  const runtime = runtimeFromPackage(path.resolve(__dirname, '../../.native-provider/node_modules/@openai/codex'))
  assert(runtime); assert.equal(runtime.identity.version, 'codex-cli 0.148.0')
  const sourceHome = process.env.CODEX_HOME
  assert(sourceHome && path.isAbsolute(sourceHome), 'Existing bootstrap CODEX_HOME required')
  const activationId = crypto.randomBytes(16).toString('hex'), accountName = `apcodex_${crypto.randomBytes(6).toString('hex')}`
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-codex-network-')))
  const target = privateDirectory(path.join(root, 'target')), activationRoot = privateDirectory(path.join(root, 'activation'))
  const controlRoot = privateDirectory(path.join(root, 'control')), proxyRoot = privateDirectory(path.join(controlRoot, 'proxy'))
  const nativeHome = nativeCodexHomePath(activationRoot), journal = path.join(controlRoot, 'account.json'), wfpJournal = path.join(controlRoot, 'wfp.json')
  const journalFd = fs.openSync(journal, 'wx', 0o600)
  try { fs.writeFileSync(journalFd, JSON.stringify({ schemaVersion: 1, activationId, accountName, sid: null, state: 'PLANNED' })); fs.fsyncSync(journalFd) } finally { fs.closeSync(journalFd) }
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const environment = { ...windowsControllerEnvironment(process.env.SystemRoot), USERNAME: os.userInfo().username }
  const users = path.join(nativeHome, '.sandbox-secrets', 'sandbox_users.json')
  const invokeAccount = mode => {
    const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACCOUNT_SCRIPT, 'utf16le').toString('base64')], {
      env: { ...environment, AUTOPROMPT_DIAG_REQUEST: JSON.stringify({ mode, journal, users, target, activationId, accountName }) },
      encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    })
    assert.equal(result.status, 0, `Account ${mode} failed: ${String(result.stderr).slice(-2048)}`)
    return JSON.parse(result.stdout)
  }
  const invokeWfp = (mode, sid) => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'codex-windows-wfp-probe.ps1'),
      '-Mode', mode, '-Sid', sid, '-AccountName', accountName, '-ActivationId', activationId, '-JournalPath', wfpJournal]
    if (mode === 'Remove') args.push('-WorkerDrained')
    const result = cp.spawnSync(powershell, args, { env: environment, encoding: 'utf8', timeout: 90000, maxBuffer: 65536 })
    if (result.status !== 0) console.error(String(result.stderr).slice(0, 16384))
    assert.equal(result.status, 0, `WFP ${mode} failed (${result.error?.code || "no-error"}/${result.signal || "no-signal"}): ${String(result.stderr).slice(-2048)} stdout=${String(result.stdout).slice(0, 512)}`)
    return JSON.parse(result.stdout)
  }
  const sourceFiles = ['cap_sid', '.sandbox/setup_marker.json', '.sandbox-secrets/sandbox_users.json'].map(file => path.join(sourceHome, file))
  const sourceHashes = sourceFiles.map(sha)
  let listener, ipv6Listener, owner, runner, sid = null, launched = false, drained = true, primary, accountDeleted = false, wfpRemoved = false, toolOwnershipUnproven = false, accountCreationAttempted = false, wfpInstallAttempted = false, wfpInstalled = false
  const results = []
  try {
    installWindowsSandboxIdentity(sourceHome, activationRoot)
    accountCreationAttempted = true
    sid = invokeAccount('Create').sid
    assert.match(sid, /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/)
    const validUsersHash = sha(users)
    wfpInstallAttempted = true
    const wfp = invokeWfp('Install', sid)
    wfpInstalled = true
    console.log(JSON.stringify({ kind: 'codex-isolated-network-installed', activationId, accountName, sid, wfp, root }))
    fs.writeFileSync(path.join(target, 'source.txt'), 'source')
    const address = controlledNetworkProbeAddress()
    listener = net.createServer(socket => { listener.accepted++; socket.on('error', () => {}); socket.end('live') }); listener.accepted = 0
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '0.0.0.0', resolve) })
    const positive = (host, port = listener.address().port) => new Promise((resolve, reject) => {
      const socket = net.connect(port, host)
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('Positive control timeout')) })
      socket.once('error', reject); socket.resume(); socket.once('end', resolve)
    })
    await positive(address); await positive('127.0.0.1'); assert.equal(listener.accepted, 2); listener.accepted = 0
    ipv6Listener = net.createServer(socket => { ipv6Listener.accepted++; socket.on('error', () => {}); socket.end('live') }); ipv6Listener.accepted = 0
    try {
      await new Promise((resolve, reject) => { ipv6Listener.once('error', reject); ipv6Listener.listen(0, '::1', resolve) })
      await positive('::1', ipv6Listener.address().port); assert.equal(ipv6Listener.accepted, 1); ipv6Listener.accepted = 0
    } catch (error) {
      if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error
      ipv6Listener = null
    }
    const run = async (label, args) => {
      owner = new ProcessOwner({ adapter: createWindowsJobAdapter({ controlRoot: path.join(controlRoot, 'processes'), providerPrivateOwnershipRoot: root, immutableReadFiles: [{ path: users, sha256: sha(users) }] }), registryPath: path.join(controlRoot, 'process-registry.json'), pollMs: 20 })
      runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot, targetKey: `diagnostic:${activationId}`, activationId, pollMs: 20 })
      const sessionId = `${activationId}:${label}`, reservationId = crypto.randomUUID()
      launched = true; drained = false
      const deadline = setTimeout(() => { void runner.stop({ sessionId, reason: 'diagnostic timeout' }).catch(() => {}) }, 60000)
      try {
        const result = await runner.run({ executable: runtime.executable, argv: args, cwd: target,
          env: withCodexManagedEnvironment({ ...environment, CODEX_HOME: nativeHome }, runtime), stdin: '', sessionId, reservationId })
        assert.equal(result.processOwned, true); assert.equal(result.drained, true); drained = true
        return result
      } finally { clearTimeout(deadline) }
    }
    let membershipEvidence = null
    for (const mode of ['read-only', 'workspace-write']) {
      const heldPath = path.join(target, 'held-tool.json'), releasePath = path.join(target, 'held-tool-release')
      const pending = run(mode, ['sandbox', '--permission-profile', mode === 'read-only' ? ':read-only' : ':workspace',
        '--sandbox-state-disable-network', '--cd', target, '-c', 'windows.sandbox="elevated"',
        process.execPath, '-e', `(${innerClient.toString()})()`, path.join(target, `write-${mode}.txt`), String(listener.address().port), address, String(ipv6Listener?.address().port || 0), ...(mode === 'workspace-write' ? [heldPath, releasePath] : [])])
      void pending.catch(() => {}) // Await below after the bounded membership observation.
      if (mode === 'workspace-write') {
        try {
          const deadline = Date.now() + 55000
          while (!fs.existsSync(heldPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
          assert(fs.existsSync(heldPath), 'Held tool PID was not published')
          const held = JSON.parse(fs.readFileSync(heldPath, 'utf8'))
          const identities = owner.ownershipIdentities().filter(item => item.kind === 'windows-job-object')
          const samples = [], observationDeadline = Date.now() + 3000
          let observationCount = 0
          do {
            const members = await Promise.all(identities.map(item => owner.adapter.listOwned(item.id)))
            samples.push(members.some(pids => pids.includes(held.pid))); observationCount++
            if (samples.length > 2) samples.shift()
            if (samples.length === 2 && samples.every(Boolean)) break
            await new Promise(resolve => setTimeout(resolve, 100))
          } while (Date.now() < observationDeadline)
          membershipEvidence = { pid: held.pid, sid: held.sid, identities, samples, observationCount, exactOuterJobMember: held.sid === sid && samples.length === 2 && samples.every(Boolean) }
        } catch (error) { membershipEvidence = { exactOuterJobMember: false, error: error.message } }
        finally { fs.writeFileSync(releasePath, 'release') }
        if (!membershipEvidence.exactOuterJobMember) toolOwnershipUnproven = true
        console.log(JSON.stringify({ kind: 'codex-isolated-network-job-membership', ...membershipEvidence }))
      }
      const result = await pending
      results.push({ mode, result }); console.log(JSON.stringify({ kind: 'codex-isolated-network-mode', mode, result }))
      assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null)
      const inner = JSON.parse(result.stdout.trim())
      assert.equal(inner.sid, sid); assert.equal(inner.identityStatus, 0); assert.equal(inner.readable, true)
      assert.equal(inner.write, mode === 'workspace-write')
      if (mode === 'read-only') assert.ok(['EACCES', 'EPERM'].includes(inner.error)); else assert.equal(inner.error, null)
      assert.ok(['EACCES', 'EPERM'].includes(inner.nic)); assert.ok(['EACCES', 'EPERM'].includes(inner.loopback))
      if (ipv6Listener) assert.ok(['EACCES', 'EPERM'].includes(inner.ipv6)); else assert.equal(inner.ipv6, 'UNAVAILABLE')
      assert.equal(sha(users), validUsersHash)
    }
    assert.equal(listener.accepted, 0)
    if (ipv6Listener) { assert.equal(ipv6Listener.accepted, 0); await positive('::1', ipv6Listener.address().port); assert.equal(ipv6Listener.accepted, 1) }
    await positive(address); await positive('127.0.0.1'); assert.equal(listener.accepted, 2)
    invokeAccount('BadPassword')
    const badUsersHash = sha(users), marker = path.join(target, 'bad-logon-executed.txt')
    const failed = await run('bad-logon', ['sandbox', '--permission-profile', ':workspace', '--sandbox-state-disable-network', '--cd', target,
      '-c', 'windows.sandbox="elevated"', process.execPath, '-e', `require("node:fs").writeFileSync(process.argv[1],"UNSAFE_FALLBACK");(${innerClient.toString()})()`, marker, String(listener.address().port), address, String(ipv6Listener?.address().port || 0)])
    results.push({ mode: 'bad-logon', result: failed }); console.log(JSON.stringify({ kind: 'codex-isolated-network-bad-logon', result: failed, usersBeforeSha256: badUsersHash, usersAfterSha256: fs.existsSync(users) ? sha(users) : null, markerExecuted: fs.existsSync(marker), sharedSourceUnchanged: sourceFiles.every((file, index) => sha(file) === sourceHashes[index]) }))
    if (!membershipEvidence?.exactOuterJobMember) drained = false
    assert.equal(membershipEvidence?.exactOuterJobMember, true, 'Actual tool was not proved in the exact outer Job')
    assert.notEqual(failed.status, 0); assert.equal(fs.existsSync(marker), false); assert.equal(sha(users), badUsersHash)
    assert.deepEqual(sourceFiles.map(sha), sourceHashes, 'Shared sandbox source changed')
  } catch (error) { primary = error; throw error }
  finally {
    if (listener?.listening) await new Promise(resolve => listener.close(resolve))
    if (ipv6Listener?.listening) await new Promise(resolve => ipv6Listener.close(resolve))
    try {
      if (!sid) sid = JSON.parse(fs.readFileSync(journal, 'utf8')).sid
      if (sid && !toolOwnershipUnproven && (!launched || drained)) {
        invokeAccount('Disable')
        invokeAccount('Delete'); accountDeleted = true
        if (fs.existsSync(wfpJournal)) invokeWfp('Remove', sid)
        wfpRemoved = true
      }
    } catch (cleanupError) { primary ||= cleanupError; console.error(JSON.stringify({ kind: 'codex-isolated-network-cleanup-error', code: cleanupError.code, message: cleanupError.message })) }
    const recoveryRequired = accountCreationAttempted && (!accountDeleted || !wfpRemoved)
    console.log(JSON.stringify({ kind: 'codex-isolated-network-cleanup', root, retainedEvidence: true, drained, toolOwnershipUnproven, accountCreationAttempted, accountDeleted, wfpInstallAttempted, wfpInstalled, wfpRemoved, recoveryRequired }))
    if (recoveryRequired) throw primary || new Error('Owned account/WFP cleanup unconfirmed; recovery records retained')
    if (primary) throw primary
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
