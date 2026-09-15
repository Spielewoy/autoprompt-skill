'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')

// Observational only: existing mandatory native filesystem tests still require
// successful operations. These variants must not change production helpers.
test('native Windows PowerShell startup diagnostic compares isolated module discovery variants', { skip: process.platform !== 'win32', timeout: 600000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'powershell-startup-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const systemRoot = process.env.SystemRoot
  assert.ok(typeof systemRoot === 'string' && path.win32.isAbsolute(systemRoot))
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  assert.ok(fs.statSync(powershell).isFile(), 'The diagnostic requires actual Windows PowerShell')
  const source = fs.readFileSync(path.resolve(__dirname, '../../agents/codex/workflow/windows-filesystem.ps1'), 'utf8')
  const allocationChanges = [
    ['New-Object System.Text.UTF8Encoding($false, $true)', '[System.Text.UTF8Encoding]::new($false, $true)'],
    ['New-Object System.Text.StringBuilder', '[System.Text.StringBuilder]::new()'],
    ['New-Object char[] 1024', '[char[]]::new(1024)'],
  ]
  for (const [before] of allocationChanges) assert.equal(source.split(before).length, 2, 'The diagnostic must target the exact current allocation statements')
  const quote = value => `'${value.replace(/'/g, "''")}'`
  const variants = [
    { name: 'baseline' },
    { name: 'cache-disabled', cache: true },
    { name: 'inbox-module-path', inbox: true },
    { name: 'static-allocations', static: true },
    { name: 'inbox-module-path-cache-disabled', inbox: true, cache: true },
  ]
  const phases = ['input', 'input-encoding-created', 'input-encoding-set', 'input-initialized', 'input-reading', 'input-eof', 'compile', 'compiled', 'dispatch', 'completed']
  const metadataKeys = new Set(['version', 'pshome', 'effective-path', 'first-utility', 'final-effective-path',
    ...['New-Object', 'Add-Type'].flatMap(name => [`${name}-module`, `${name}-path`, `${name}-assembly`])])
  const outcomes = []
  for (const variant of variants) {
    const directory = path.join(root, variant.name)
    fs.mkdirSync(directory)
    let helperSource = source
    if (variant.static) for (const [before, after] of allocationChanges) helperSource = helperSource.replace(before, after)
    const helper = path.join(directory, 'windows-filesystem.ps1')
    fs.writeFileSync(helper, helperSource, { flag: 'wx' })
    // Match the production child's explicit environment. Only the designated
    // cache variant adds a variable; no user profile or ambient modules leak in.
    const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
      PATH: path.join(systemRoot, 'System32'), PSModulePath: '', TEMP: directory, TMP: directory,
      AUTOPROMPT_CAPTURE_PHASES: '1' }
    if (variant.cache) environment.PSModuleAnalysisCachePath = 'NUL'
    const script = `$ErrorActionPreference='Stop'
function Emit-StartupMetadata([string]$name,[string]$value) {
  if ($value.Length -gt 8192) { throw 'startup metadata exceeds bound' }
  [Console]::Error.WriteLine('AUTOPROMPT_PS_STARTUP:'+$name+':'+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($value)))
}
${variant.inbox ? "[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)" : ''}
Emit-StartupMetadata 'version' $PSVersionTable.PSVersion.ToString()
Emit-StartupMetadata 'pshome' $PSHOME
Emit-StartupMetadata 'effective-path' ([Environment]::GetEnvironmentVariable('PSModulePath'))
Emit-StartupMetadata 'first-utility' ${quote(variant.static ? 'Add-Type' : 'New-Object')}
& ${quote(helper)} -Request
if (-not $?) { exit 1 }
# Resolve origins only after the real helper finishes. Looking up Utility
# commands beforehand would itself alter the discovery being measured.
foreach ($name in @('New-Object','Add-Type')) {
  $command=Get-Command -Name $name -CommandType Cmdlet -ErrorAction Stop
  $modulePath=if ($null -ne $command.Module) { [string]$command.Module.Path } else { '' }
  Emit-StartupMetadata ($name+'-module') ([string]$command.ModuleName)
  Emit-StartupMetadata ($name+'-path') $modulePath
  Emit-StartupMetadata ($name+'-assembly') ([string]$command.ImplementingType.Assembly.Location)
}
Emit-StartupMetadata 'final-effective-path' ([Environment]::GetEnvironmentVariable('PSModulePath'))
`
    const start = process.hrtime.bigint()
    const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      input: '{"schemaVersion":1}', encoding: 'utf8', env: environment, cwd: path.dirname(powershell),
      timeout: 30000, maxBuffer: 262144, windowsHide: true,
    })
    const elapsedMs = Number((process.hrtime.bigint() - start) / 1000000n)
    const metadata = {}, observedPhases = [], unexpected = []
    for (const line of (result.stderr || '').split(/\r?\n/).filter(Boolean)) {
      const meta = /^AUTOPROMPT_PS_STARTUP:([A-Za-z-]+):([A-Za-z0-9+/]*={0,2})$/.exec(line)
      const phase = /^AUTOPROMPT_CAPTURE_PHASE:([a-z-]+):(0|[1-9][0-9]{0,5})$/.exec(line)
      if (meta && metadataKeys.has(meta[1]) && !Object.hasOwn(metadata, meta[1])) {
        const value = Buffer.from(meta[2], 'base64').toString('utf16le')
        if (value.length <= 8192 && Buffer.from(value, 'utf16le').toString('base64') === meta[2]) metadata[meta[1]] = value
        else unexpected.push(line)
      } else if (phase) observedPhases.push({ name: phase[1], elapsedMs: Number(phase[2]) })
      else unexpected.push(line)
    }
    const outcome = { variant: variant.name, elapsedMs, status: result.status, signal: result.signal,
      error: result.error ? result.error.code : null, metadata, phases: observedPhases,
      stdout: (result.stdout || '').slice(0, 4096), unexpectedStderr: unexpected.join('\n').slice(0, 8192) }
    outcomes.push(outcome)
    // Emit all variant evidence before assertions, including timeout/error cases.
    t.diagnostic('PowerShell startup observation:')
    for (const line of JSON.stringify(outcome, null, 2).split('\n')) {
      // GitHub's live log view truncates long individual lines. Keep the full
      // observation visible even when a module path or error field is long.
      for (let offset = 0; offset < line.length; offset += 480) t.diagnostic(line.slice(offset, offset + 480))
    }
  }
  assert.equal(outcomes.length, variants.length)
  for (const outcome of outcomes) {
    assert.equal(outcome.unexpectedStderr, '', `${outcome.variant}: unexpected stderr`)
    assert.match(outcome.metadata.version || '', /^5\.1\./, `${outcome.variant}: actual Windows PowerShell 5.1 required`)
    assert.equal(outcome.metadata['first-utility'], outcome.variant === 'static-allocations' ? 'Add-Type' : 'New-Object')
    let lastIndex = -1, lastElapsed = -1
    for (const phase of outcome.phases) {
      const index = phases.indexOf(phase.name)
      assert.ok(index === lastIndex + 1 && phase.elapsedMs >= lastElapsed && phase.elapsedMs <= 300000, `${outcome.variant}: invalid phase sequence`)
      assert.notEqual(phase.name, 'dispatch', 'The closed invalid request must not operate on the filesystem')
      lastIndex = index; lastElapsed = phase.elapsedMs
    }
    if (outcome.error) {
      assert.equal(outcome.error, 'ETIMEDOUT', `${outcome.variant}: unexpected spawn error`)
      assert.equal(outcome.status, null)
    } else {
      assert.equal(outcome.status, 0, `${outcome.variant}: helper failed`)
      assert.ok(outcome.phases.some(phase => phase.name === 'compiled'), `${outcome.variant}: actual C# compilation required`)
      assert.deepEqual(JSON.parse(outcome.stdout), { schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_REQUEST_INVALID' })
      for (const command of ['New-Object', 'Add-Type']) {
        assert.equal(outcome.metadata[`${command}-module`], 'Microsoft.PowerShell.Utility')
        assert.ok(path.win32.isAbsolute(outcome.metadata[`${command}-assembly`] || ''), `${outcome.variant}: missing actual command assembly origin`)
      }
    }
  }
})
