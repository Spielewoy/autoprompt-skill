'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')

test('Windows Job bridge compiles and preserves atomic status publication on native long paths', { timeout: 120000 }, t => {
  const powershell = process.platform === 'win32' ? path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh'
  const available = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 })
  if (available.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell unavailable'); return }
  assert.ifError(available.error)
  assert.equal(available.status, 0, available.stderr)
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'job-bridge-contract-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const moduleSource = fs.readFileSync(path.resolve(__dirname, '../../agents/codex/workflow/process-owner.js'), 'utf8')
  const helper = /const WINDOWS_JOB_HELPER = String.raw`([\s\S]*?)\n`/.exec(moduleSource)?.[1]
  assert.ok(helper)
  const native = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/.exec(helper)?.[1]
  assert.ok(native)
  const sourcePath = path.join(base, 'native.cs'), scriptPath = path.join(base, 'job.ps1')
  fs.writeFileSync(sourcePath, native)
  fs.writeFileSync(scriptPath, helper)
  const deep = path.join(base, ...Array(12).fill('native-durable-status-component'))
  fs.mkdirSync(deep, { recursive: true })
  assert.ok(deep.length > 300)
  const status = path.join(deep, 'status.json'), temporary = status + '.temporary', backup = status + '.previous'
  fs.writeFileSync(temporary, 'FOREIGN_COLLISION')
  const script = `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
[void][System.Management.Automation.Language.Parser]::ParseFile($env:AP_JOB_SCRIPT,[ref]$tokens,[ref]$errors)
if($errors.Count){throw $errors[0]}
Add-Type -Path $env:AP_JOB_NATIVE
$method=[AutopromptOwnedJob].GetMethod('NativePath',[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static)
foreach($value in @('', 'relative', ('C:'+[char]0+'bad'))){
  $refused=$false
  try{[void]$method.Invoke($null,@([string]$value))}catch{if($_.Exception.InnerException -is [ArgumentException]){$refused=$true}else{throw}}
  if(!$refused){throw 'invalid path accepted'}
}
$nativeIO=$env:AP_JOB_NATIVE_IO -eq '1'
if($nativeIO){
  $refused=$false
  try{[AutopromptOwnedJob]::PublishText($env:AP_JOB_STATUS,$env:AP_JOB_TEMP,$env:AP_JOB_BACKUP,'first')}catch{$refused=$true}
  if(!$refused -or [AutopromptOwnedJob]::ReadText($env:AP_JOB_TEMP) -cne 'FOREIGN_COLLISION'){throw 'foreign temporary was removed'}
  [AutopromptOwnedJob]::PublishText($env:AP_JOB_STATUS,($env:AP_JOB_TEMP+'.owned'),$env:AP_JOB_BACKUP,'first')
  if([AutopromptOwnedJob]::ReadText($env:AP_JOB_STATUS) -cne 'first'){throw 'initial status missing'}
  [AutopromptOwnedJob]::PublishText($env:AP_JOB_STATUS,($env:AP_JOB_TEMP+'.owned'),$env:AP_JOB_BACKUP,'second')
  if([AutopromptOwnedJob]::ReadText($env:AP_JOB_STATUS) -cne 'second'){throw 'status replacement missing'}
  if([AutopromptOwnedJob]::FileExists($env:AP_JOB_BACKUP) -or [AutopromptOwnedJob]::FileExists($env:AP_JOB_TEMP+'.owned')){throw 'publication residue'}
}
[ordered]@{compiled=$true;pathRefusals=3;nativeIO=$nativeIO}|ConvertTo-Json -Compress
`
  const environment = process.platform === 'win32' ? require('../../agents/codex/workflow/safe-run-root.js').windowsControllerEnvironment(process.env.SystemRoot) : process.env
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 90000, windowsHide: true, env: { ...environment, AP_JOB_SCRIPT: scriptPath, AP_JOB_NATIVE: sourcePath, AP_JOB_STATUS: status, AP_JOB_TEMP: temporary, AP_JOB_BACKUP: backup, AP_JOB_NATIVE_IO: process.platform === 'win32' ? '1' : '0' } })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { compiled: true, pathRefusals: 3, nativeIO: process.platform === 'win32' })
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'FOREIGN_COLLISION')
  if (process.platform === 'win32') assert.equal(fs.readFileSync(status, 'utf8'), 'second')
})

test('native Windows Job ownership survives deep durable paths and hostile home variables', { skip: process.platform !== 'win32', timeout: 240000 }, t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-job-long-')))
  async function exercise(base, repo) {
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
    const safe = require(path.join(repo, 'agents/codex/workflow/safe-run-root.js'))
    const { ProcessOwner, createWindowsJobAdapter } = require(path.join(repo, 'agents/codex/workflow/process-owner.js'))
    const protectedRoot = path.join(base, ...Array(12).fill('deep-durable-controller-path'))
    fs.mkdirSync(protectedRoot, { recursive: true })
    safe.ensureWindowsPrivateAcl(protectedRoot)
    const controlRoot = path.join(protectedRoot, 'process-control')
    assert.ok(controlRoot.length > 300)
    const adapter = createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: protectedRoot })
    const registryPath = path.join(base, 'processes.json')
    const owner = new ProcessOwner({ adapter, registryPath, pollMs: 25 })
    const marker = path.join(base, 'child.json')
    let launched, cleanupOwner = owner
    try {
      const environment = {
        SystemRoot: process.env.SystemRoot,
        PROCESSOR_ARCHITECTURE: process.arch === 'arm64' ? 'ARM64' : 'AMD64',
        AUTOPROMPT_EXACT_JOB_ENV: 'owned',
      }
      launched = await owner.launch({ executable: process.execPath, argv: ['-e', 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,environment:process.env}));setInterval(()=>{},1000)', marker], cwd: base, env: environment, targetKey: 'deep-durable-job' })
      const deadline = Date.now() + 10000
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      const observed = JSON.parse(fs.readFileSync(marker, 'utf8'))
      assert.equal(observed.pid, launched.rootPid)
      assert.deepEqual(observed.environment, environment)
      const reopenedAdapter = createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: protectedRoot })
      const restarted = new ProcessOwner({ adapter: reopenedAdapter, registryPath, pollMs: 25 })
      cleanupOwner = restarted
      assert.ok((await reopenedAdapter.listOwned(launched.groupIdentity)).includes(launched.rootPid))
      const cancelled = await restarted.cancelGroup(launched.ownershipId, { graceMs: 0, killMs: 10000, reason: 'native deep-path regression' })
      assert.equal(cancelled.status, 'CANCELLED')
      assert.deepEqual(await adapter.listOwned(launched.groupIdentity), [])
      process.stdout.write(JSON.stringify({ deepControl: true, exactChildEnvironment: true, durableRecovery: true, drained: true }) + '\n')
    } finally {
      await cleanupOwner.cancelAll({ graceMs: 0, killMs: 10000, reason: 'native deep-path regression cleanup' })
    }
  }
  const hostile = path.join(base, ...Array(16).fill('caller-home-and-temp'))
  const source = '(' + exercise.toString() + ')(' + JSON.stringify(base) + ',' + JSON.stringify(path.resolve(__dirname, '../..')) + ').catch(error=>{console.error(error);process.exitCode=1})'
  const result = cp.spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 210000, windowsHide: true, env: { ...process.env, USERPROFILE: hostile, HOME: hostile, APPDATA: hostile, LOCALAPPDATA: hostile, TEMP: hostile, TMP: hostile } })
  if (result.error || result.status !== 0) t.diagnostic('Native ownership fixture retained after failure: ' + base)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { deepControl: true, exactChildEnvironment: true, durableRecovery: true, drained: true })
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
