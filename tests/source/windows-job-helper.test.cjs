'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const { selectWindowsLiveStatusPids } = require('../../agents/codex/workflow/process-owner.js')

test('Windows Job cwd bridge cleanup remains owned until its terminal publication', () => {
  const cleaning = {
    status: 'CLEANING', ready: true, assigned: true, helperPid: 61001,
    rootPid: 61002, pids: [], observedPids: [61002],
    cwdBridgeRequired: true, cwdBridgeCleaned: false,
  }
  assert.deepEqual(selectWindowsLiveStatusPids(cleaning, pid => pid === 61001), [61001])
  assert.throws(() => selectWindowsLiveStatusPids(cleaning, () => false), /retained an unowned cwd bridge/)
  assert.throws(() => selectWindowsLiveStatusPids({ ...cleaning, pids: [61002] }, () => true),
    /does not prove zero assigned membership/)
  assert.deepEqual(selectWindowsLiveStatusPids({ ...cleaning, status: 'EXITED', cwdBridgeCleaned: true }, () => false), [])
})

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
  assert.match(helper, /\$drainConfirmed = -not \[bool\]\$script:owned/)
  assert.match(helper, /if \(\$drainConfirmed\) \{\s+try \{ Remove-JobCwdBridge \}/)
  assert.match(helper, /Write-JobStatus 'CLEANING' \$true \$true @\(\) \$null\s+\}\s+Remove-JobCwdBridge/)
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
  $launchEnvironment=New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
  $launchEnvironment['SystemRoot']=$env:SystemRoot
  $nativeFailure=$null
  try{[void][AutopromptOwnedJob]::Start((Join-Path $env:SystemRoot 'missing-autoprompt-owned.exe'),@(),$env:SystemRoot,$launchEnvironment,[DateTime]::UtcNow.AddSeconds(10))}catch{
    $nativeFailure=$_.Exception
    while($nativeFailure.InnerException){$nativeFailure=$nativeFailure.InnerException}
  }
  if(-not ($nativeFailure -is [ComponentModel.Win32Exception]) -or $nativeFailure.NativeErrorCode -ne 2 -or
      $nativeFailure.Message -notmatch 'nativeError=2' -or $nativeFailure.Message -notmatch 'applicationLength=' -or
      $nativeFailure.Message -notmatch 'commandLength=' -or $nativeFailure.Message -notmatch 'cwdLength=' -or
      $nativeFailure.Message -notmatch 'environmentLength='){throw 'bounded CreateProcess native error diagnostics missing'}
}
[ordered]@{compiled=$true;pathRefusals=3;nativeIO=$nativeIO;nativeErrorDiagnostics=$nativeIO}|ConvertTo-Json -Compress
`
  const environment = process.platform === 'win32' ? require('../../agents/codex/workflow/safe-run-root.js').windowsControllerEnvironment(process.env.SystemRoot) : process.env
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 90000, windowsHide: true, env: { ...environment, AP_JOB_SCRIPT: scriptPath, AP_JOB_NATIVE: sourcePath, AP_JOB_STATUS: status, AP_JOB_TEMP: temporary, AP_JOB_BACKUP: backup, AP_JOB_NATIVE_IO: process.platform === 'win32' ? '1' : '0' } })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { compiled: true, pathRefusals: 3, nativeIO: process.platform === 'win32', nativeErrorDiagnostics: process.platform === 'win32' })
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
    const deepCwd = path.join(protectedRoot, 'semantic-working-directory')
    fs.mkdirSync(deepCwd)
    fs.writeFileSync(path.join(deepCwd, 'relative-input.txt'), 'semantic-cwd')
    assert.ok(deepCwd.length > 300)
    let launched, cleanupOwner = owner
    try {
      const environment = {
        SystemRoot: process.env.SystemRoot,
        PROCESSOR_ARCHITECTURE: process.arch === 'arm64' ? 'ARM64' : 'AMD64',
        AUTOPROMPT_EXACT_JOB_ENV: 'owned',
      }
      launched = await owner.launch({ executable: process.execPath, argv: ['-e', 'const fs=require("node:fs");fs.writeFileSync("relative-output.txt","owned-relative-write");fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,environment:process.env,cwd:process.cwd(),realCwd:fs.realpathSync.native(process.cwd()),relativeInput:fs.readFileSync("relative-input.txt","utf8")}));setInterval(()=>{},1000)', marker], cwd: deepCwd, env: environment, targetKey: 'deep-durable-job' })
      const deadline = Date.now() + 10000
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      const observed = JSON.parse(fs.readFileSync(marker, 'utf8'))
      assert.equal(observed.pid, launched.rootPid)
      assert.deepEqual(observed.environment, environment)
      assert.equal(observed.relativeInput, 'semantic-cwd')
      assert.equal(observed.realCwd.toLowerCase(), fs.realpathSync.native(deepCwd).toLowerCase())
      assert.equal(fs.readFileSync(path.join(deepCwd, 'relative-output.txt'), 'utf8'), 'owned-relative-write')
      const reservation = fs.readdirSync(controlRoot, { withFileTypes: true }).find(entry => entry.isDirectory())
      const launcher = JSON.parse(fs.readFileSync(path.join(controlRoot, reservation.name, 'launcher.json'), 'utf8'))
      assert.equal(launcher.requestedCwd.toLowerCase(), path.resolve(deepCwd).toLowerCase())
      assert.ok(launcher.physicalCwd.length < 260)
      assert.equal(fs.realpathSync.native(launcher.physicalCwd).toLowerCase(), fs.realpathSync.native(deepCwd).toLowerCase())
      assert.equal(fs.existsSync(launcher.cwdBridgeRoot), true)
      const reopenedAdapter = createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: protectedRoot })
      const restarted = new ProcessOwner({ adapter: reopenedAdapter, registryPath, pollMs: 25 })
      cleanupOwner = restarted
      assert.ok((await reopenedAdapter.listOwned(launched.groupIdentity)).includes(launched.rootPid))
      const cancelled = await restarted.cancelGroup(launched.ownershipId, { graceMs: 0, killMs: 10000, reason: 'native deep-path regression' })
      assert.equal(cancelled.status, 'CANCELLED')
      assert.deepEqual(await adapter.listOwned(launched.groupIdentity), [])
      assert.equal(fs.existsSync(launcher.cwdBridgeRoot), false, 'owned helper must remove its shallow cwd bridge after drain')
      const terminal = JSON.parse(fs.readFileSync(path.join(controlRoot, reservation.name, 'status.json'), 'utf8'))
      assert.equal(terminal.cwdBridgeCleaned, true)
      process.stdout.write(JSON.stringify({ deepControl: true, deepCwd: true, exactChildEnvironment: true, durableRecovery: true, drained: true }) + '\n')
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
  assert.deepEqual(JSON.parse(result.stdout), { deepControl: true, deepCwd: true, exactChildEnvironment: true, durableRecovery: true, drained: true })
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('native Windows owned proxy preserves deep semantic cwd through the nested child launch', { skip: process.platform !== 'win32', timeout: 240000 }, async t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-proxy-long-cwd-')))
  async function exercise(base, repo) {
    const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path')
    const safe = require(path.join(repo, 'agents/codex/workflow/safe-run-root.js'))
    const { OwnedCodexProxyRunner } = require(path.join(repo, 'agents/codex/workflow/phase-budget.js'))
    const { ProcessOwner, createWindowsJobAdapter, prepareProcessLaunchEnvironment } = require(path.join(repo, 'agents/codex/workflow/process-owner.js'))
    safe.ensureWindowsPrivateAcl(base)
    const protectedRoot = path.join(base, ...Array(12).fill('deep-owned-proxy-controller'))
    fs.mkdirSync(protectedRoot, { recursive: true })
    safe.ensureWindowsPrivateAcl(protectedRoot)
    const processControlRoot = path.join(protectedRoot, 'process-control')
    const proxyControlRoot = path.join(protectedRoot, 'proxy-control')
    fs.mkdirSync(proxyControlRoot)
    const deepCwd = path.join(protectedRoot, 'semantic-working-directory')
    fs.mkdirSync(deepCwd)
    fs.writeFileSync(path.join(deepCwd, 'relative-input.txt'), 'nested-semantic-cwd')
    assert.ok(deepCwd.length > 300)
    const childPath = path.join(base, 'nested-child.cjs')
    fs.writeFileSync(childPath, [
      "'use strict'",
      "const fs = require('node:fs')",
      "const result = { cwd: process.cwd(), realCwd: fs.realpathSync.native(process.cwd()), input: fs.readFileSync('relative-input.txt', 'utf8') }",
      "fs.writeFileSync('relative-output.json', JSON.stringify(result))",
      "process.stdout.write(`${JSON.stringify(result)}\\n`)",
      '',
    ].join('\n'))
    const mismatchRoot = path.join(base, 'mismatched-inherited-cwd')
    fs.mkdirSync(mismatchRoot)
    const mismatchMarker = path.join(base, 'mismatch-child-ran')
    const mismatchArgv = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(mismatchMarker)},'ran')`]
    const mismatchRequest = {
      schemaVersion: 2, activationId: 'mismatched-inherited-cwd', generationId: 1, sequence: 1,
      executable: process.execPath, argv: mismatchArgv,
      argvHash: crypto.createHash('sha256').update(JSON.stringify({ executable: process.execPath, argv: mismatchArgv })).digest('hex'),
      cwd: deepCwd, stdin: '', stdoutPath: path.join(mismatchRoot, 'stdout.jsonl'),
      stderrPath: path.join(mismatchRoot, 'stderr.log'), statusPath: path.join(mismatchRoot, 'status.json'),
    }
    const mismatchRequestPath = path.join(mismatchRoot, 'request.json')
    fs.writeFileSync(mismatchRequestPath, `${JSON.stringify(mismatchRequest)}\n`)
    const mismatch = require('node:child_process').spawnSync(process.execPath,
      [path.join(repo, 'agents/codex/workflow/phase-budget.js'), '--owned-codex-proxy', mismatchRequestPath],
      { cwd: base, encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.ifError(mismatch.error)
    assert.equal(mismatch.status, 2)
    const mismatchStatus = JSON.parse(fs.readFileSync(mismatchRequest.statusPath, 'utf8'))
    assert.equal(mismatchStatus.code, 1)
    assert.equal(mismatchStatus.error.code, 'CODEX_PROXY_REQUEST_INVALID')
    assert.equal(fs.existsSync(mismatchMarker), false)
    const adapter = createWindowsJobAdapter({ controlRoot: processControlRoot, providerPrivateOwnershipRoot: protectedRoot })
    const owner = new ProcessOwner({ adapter, registryPath: path.join(base, 'processes.json'), pollMs: 25 })
    const runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyControlRoot,
      targetKey: 'deep-owned-proxy-cwd', pollMs: 25 })
    const reservationId = crypto.randomUUID(), sessionId = 'deep-owned-proxy-session'
    let request = null
    const launch = owner.launch.bind(owner)
    owner.launch = async spec => { request = JSON.parse(fs.readFileSync(spec.argv.at(-1), 'utf8')); return launch(spec) }
    try {
      const lines = []
      const execution = await runner.run({ executable: process.execPath, argv: [childPath], cwd: deepCwd,
        env: prepareProcessLaunchEnvironment(adapter, reservationId, {
          SystemRoot: process.env.SystemRoot,
          PROCESSOR_ARCHITECTURE: process.arch === 'arm64' ? 'ARM64' : 'AMD64',
        }), stdin: '', sessionId, reservationId, onStdoutLine: line => lines.push(line) })
      assert.equal(execution.status, 0)
      assert.equal(execution.drained, true)
      assert.equal(request.cwd.toLowerCase(), deepCwd.toLowerCase())
      const observed = JSON.parse(fs.readFileSync(path.join(deepCwd, 'relative-output.json'), 'utf8'))
      assert.equal(observed.input, 'nested-semantic-cwd')
      assert.ok(observed.cwd.length < 260)
      assert.equal(observed.realCwd.toLowerCase(), fs.realpathSync.native(deepCwd).toLowerCase())
      assert.deepEqual(lines.map(line => JSON.parse(line)), [observed])
      await owner.assertTargetDrained('deep-owned-proxy-cwd')
      await owner.assertDrained()
      process.stdout.write(`${JSON.stringify({ nestedLaunch: true, semanticCwd: true, relativeIO: true, drained: true })}\n`)
    } finally {
      try { await runner.stop({ sessionId, reason: 'native nested proxy cleanup' }) } catch {}
      try { await owner.cancelAll({ reason: 'native nested proxy cleanup', graceMs: 0, killMs: 10000 }) } catch {}
    }
  }
  const hostile = path.join(base, ...Array(16).fill('caller-home-and-temp'))
  const source = '(' + exercise.toString() + ')(' + JSON.stringify(base) + ',' + JSON.stringify(path.resolve(__dirname, '../..')) + ').catch(error=>{console.error(error);process.exitCode=1})'
  const safe = require('../../agents/codex/workflow/safe-run-root.js')
  const { ProcessOwner, createWindowsJobAdapter } = require('../../agents/codex/workflow/process-owner.js')
  const { ownedTest } = require('../../scripts/harness-v2-closed-canary.cjs')
  safe.ensureWindowsPrivateAcl(base)
  const outerPrivate = path.join(base, 'outer-private')
  fs.mkdirSync(outerPrivate)
  safe.ensureWindowsPrivateAcl(outerPrivate)
  const outerRoot = path.join(outerPrivate, ...Array(12).fill('deep-closed-owned-test'))
  fs.mkdirSync(outerRoot, { recursive: true })
  safe.ensureWindowsPrivateAcl(outerRoot)
  assert.ok(outerRoot.length > 300)
  const nestedOwnershipRoot = path.join(outerRoot, 'nested-owners')
  fs.mkdirSync(nestedOwnershipRoot)
  safe.ensureWindowsPrivateAcl(nestedOwnershipRoot)
  const adapter = createWindowsJobAdapter({ controlRoot: path.join(outerPrivate, 'outer-control'),
    providerPrivateOwnershipRoot: outerPrivate })
  const owner = new ProcessOwner({ adapter, registryPath: path.join(outerPrivate, 'outer-processes.json'), pollMs: 25 })
  let result
  try {
    result = await ownedTest(owner, outerRoot, {
      SystemRoot: process.env.SystemRoot,
      PROCESSOR_ARCHITECTURE: process.arch === 'arm64' ? 'ARM64' : 'AMD64',
      USERPROFILE: hostile, HOME: hostile, APPDATA: hostile, LOCALAPPDATA: hostile, TEMP: hostile, TMP: hostile,
      AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT: nestedOwnershipRoot,
      AUTOPROMPT_CLOSED_CANARY_PROVIDER: 'claude',
      AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID: 'native-deep-cwd',
      AUTOPROMPT_CLOSED_CANARY_GENERATION: '1',
      AUTOPROMPT_CLOSED_CANARY_CHALLENGE: crypto.randomBytes(32).toString('base64url'),
    }, ['-e', source], 210000, undefined, { platform: 'win32', providerPrivateOwnershipRoot: outerPrivate,
      trustedOwnershipRoots: [outerPrivate] })
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.equal(result.signal, null)
    assert.equal(result.error, null)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { nestedLaunch: true, semanticCwd: true, relativeIO: true, drained: true })
    await owner.assertDrained()
  } catch (error) {
    t.diagnostic('Native nested proxy fixture retained after failure: ' + base)
    for (const name of fs.readdirSync(outerRoot).filter(name => /^outer-[0-9a-f-]{36}\.(?:stdout|stderr)\.log$/.test(name)).sort()) {
      const detail = fs.readFileSync(path.join(outerRoot, name), 'utf8').slice(0, 4096)
      if (detail) t.diagnostic(`${name}: ${detail}`)
    }
    throw error
  } finally {
    try { await owner.cancelAll({ reason: 'native closed-owned nested proxy cleanup', graceMs: 0, killMs: 10000, waitForPending: true }) } catch {}
  }
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('native Windows owned proxy projects canonical Claude temp through a forced short cwd bridge', { skip: process.platform !== 'win32', timeout: 240000 }, async t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-proxy-temp-')))
  const source = path.join(base, 'temp-child.cjs')
  const marker = path.join(base, 'temp-marker.json')
  const controlRoot = path.join(base, 'process-control')
  const proxyRoot = path.join(base, 'proxy-control')
  fs.mkdirSync(controlRoot); fs.mkdirSync(proxyRoot)
  const safe = require('../../agents/codex/workflow/safe-run-root.js')
  safe.ensureWindowsPrivateAcl(base)
  safe.ensureWindowsPrivateAcl(controlRoot)
  safe.ensureWindowsPrivateAcl(proxyRoot)
  const anchorParts = []
  let anchor = base
  while (anchor.length < 238) {
    const part = `short-anchor-${anchorParts.length.toString(16).padStart(2, '0')}`
    anchorParts.push(part); anchor = path.join(anchor, part)
  }
  fs.mkdirSync(anchor, { recursive: true, mode: 0o700 })
  const relativePath = `temp-${'a'.repeat(32)}`
  const canonicalTemp = path.join(anchor, relativePath)
  fs.mkdirSync(canonicalTemp, { recursive: true, mode: 0o700 })
  assert.ok(anchor.length < 260)
  assert.ok(canonicalTemp.length >= 260)
  const descriptorBody = { schemaVersion: 1, path: canonicalTemp, relativePath }
  const descriptor = { ...descriptorBody, sha256: crypto.createHash('sha256').update(JSON.stringify(descriptorBody)).digest('hex') }
  fs.writeFileSync(source, [
    "'use strict'",
    "const fs=require('node:fs'),path=require('node:path')",
    "const values={temp:process.env.TEMP,tmp:process.env.TMP,tmpdir:process.env.TMPDIR,cwd:process.cwd(),unrelated:process.env.AP_TEMP_UNRELATED,argv:process.argv.slice(2)} ",
    "fs.writeFileSync(path.join(process.env.TEMP,'canonical-witness.txt'),'exact-canonical-temp')",
    `fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(values))`,
    "process.stdout.write(JSON.stringify(values)+'\\n')",
  ].join('\n'))
  const { ProcessOwner, createWindowsJobAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
  const { OwnedCodexProxyRunner } = require('../../agents/codex/workflow/phase-budget.js')
  const adapter = createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: base })
  const owner = new ProcessOwner({ adapter, registryPath: path.join(base, 'processes.json'), pollMs: 25 })
  const runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot, targetKey: 'canonical-temp-projection', pollMs: 25 })
  const reservationId = crypto.randomUUID(), sessionId = crypto.randomUUID()
  const env = prepareProcessLaunchEnvironment(adapter, reservationId, {
    SystemRoot: process.env.SystemRoot,
    PROCESSOR_ARCHITECTURE: process.arch === 'arm64' ? 'ARM64' : 'AMD64',
    TEMP: canonicalTemp, TMP: canonicalTemp, TMPDIR: canonicalTemp,
    AP_TEMP_UNRELATED: 'preserve-this-value',
  })
  try {
    const childArgs = ['--temp-argv-witness', 'unchanged-argument']
    const execution = await runner.run({ executable: process.execPath, argv: [source, ...childArgs], cwd: anchor, env, stdin: '', sessionId, reservationId,
      windowsTempDirectory: descriptor, onStdoutLine: () => {} })
    assert.equal(execution.status, 0, execution.stderr)
    assert.equal(execution.drained, true)
    const observed = JSON.parse(fs.readFileSync(marker, 'utf8'))
    assert.equal(observed.temp, observed.tmp)
    assert.equal(observed.temp, observed.tmpdir)
    assert.ok(observed.temp.length < 248)
    assert.notEqual(observed.temp.toLowerCase(), canonicalTemp.toLowerCase())
    assert.equal(observed.unrelated, 'preserve-this-value')
    assert.deepEqual(observed.argv, childArgs)
    assert.equal(fs.readFileSync(path.join(canonicalTemp, 'canonical-witness.txt'), 'utf8'), 'exact-canonical-temp')
    assert.equal(fs.existsSync(canonicalTemp), true)
    const reservation = fs.readdirSync(controlRoot, { withFileTypes: true }).find(entry => entry.isDirectory())
    assert.ok(reservation)
    const { readChecksummedJson } = require('../../agents/codex/workflow/event-log.js')
    const launcher = readChecksummedJson(path.join(controlRoot, reservation.name, 'launcher.json'))
    assert.equal(launcher.requestedCwd.toLowerCase(), anchor.toLowerCase())
    assert.ok(launcher.physicalCwd.length < 260)
    assert.equal(fs.existsSync(launcher.cwdBridgeRoot), false)
    await owner.assertDrained()

    fs.unlinkSync(marker)
    const badBody = { schemaVersion: 1, path: path.join(base, 'outside-temp'), relativePath }
    const badDescriptor = { ...badBody, sha256: crypto.createHash('sha256').update(JSON.stringify(badBody)).digest('hex') }
    const badReservationId = crypto.randomUUID()
    const badEnv = prepareProcessLaunchEnvironment(adapter, badReservationId, {
      SystemRoot: process.env.SystemRoot,
      PROCESSOR_ARCHITECTURE: process.arch === 'arm64' ? 'ARM64' : 'AMD64',
      TEMP: canonicalTemp, TMP: canonicalTemp, TMPDIR: canonicalTemp,
      AP_TEMP_UNRELATED: 'preserve-this-value',
    })
    const rejected = await runner.run({ executable: process.execPath, argv: [source, ...childArgs], cwd: anchor, env: badEnv, stdin: '',
      sessionId: crypto.randomUUID(), reservationId: badReservationId, windowsTempDirectory: badDescriptor, onStdoutLine: () => {} })
    assert.notEqual(rejected.status, 0)
    assert.equal(rejected.drained, true)
    assert.match(String(rejected.stderr || ''), /CODEX_PROXY_REQUEST_INVALID/)
    assert.equal(fs.existsSync(marker), false)
    assert.equal(fs.existsSync(path.join(base, 'outside-temp', 'canonical-witness.txt')), false)
  } finally {
    try { await runner.stop({ sessionId, reason: 'canonical temp projection cleanup' }) } catch {}
    try {
      await owner.cancelAll({ reason: 'canonical temp projection cleanup', graceMs: 0, killMs: 10000, waitForPending: true })
    } finally {
      await owner.assertDrained()
    }
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
