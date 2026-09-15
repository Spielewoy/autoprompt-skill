'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const lock = require('./build-lock.json')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

test('Node candidate patch matches its reviewed lock and exact source identity', () => {
  assert.equal(lock.version, '24.20.0')
  assert.equal(lock.source.sha256, '2732fc3f588dd335cd6779c06864f7cd424bb1b5ff9a1743059a66c54f9ca4a1')
  assert.equal(lock.source.commit, '71b8b174857e25106d39b61a9e6f30d927da8b01')
  assert.equal(lock.nasm.sha256, '3ee4782247bcb874378d02f7eab4e294a84d3d15f3f6ee2de2f47a46aa7226e6')
  const patch = fs.readFileSync(path.join(__dirname, lock.patch.file))
  assert.equal(hash(patch), lock.patch.sha256)
  assert.deepEqual(patch.toString().split('\n').filter(line => line.startsWith('--- ') || line.startsWith('+++ ')),
    ['--- a/deps/uv/src/win/pipe.c', '+++ b/deps/uv/src/win/pipe.c'])
})

test('actual compiler process helper drains logs, propagates failures and bounds timeouts', { timeout: 45000 }, t => {
  const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
  const available = cp.spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000 })
  if (available.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(available.error); assert.equal(available.status, 0, available.stderr)
  assert.ok(Number(available.stdout.trim()) >= 7)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-builder-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = cp.spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'process-contract.ps1')], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PROOF_BUILD_SCRIPT: path.join(__dirname, 'build.ps1'), PROOF_WORK: root, PROOF_NODE: process.execPath },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(result.stdout), { processCases: 3, toolchainCases: 6, planCases: 23, peCases: 28, progressRecords: 7, installerCases: 3 })
})

test('private NUL patch lock binds every original, result and newly created header', () => {
  const binding = require('./nul-proof/binding.json')
  assert.equal(binding.sourceCommit, lock.source.commit)
  assert.equal(binding.nodeVersion, lock.version)
  assert.equal(binding.sourceArchive.sha256, lock.source.sha256)
  assert.equal(lock.nulPatch.sha256, binding.patchSha256)
  assert.deepEqual(lock.nulPatch.files, binding.files)
  const patch = fs.readFileSync(path.join(__dirname, lock.nulPatch.file))
  assert.equal(hash(patch), lock.nulPatch.sha256)
  assert.deepEqual(patch.toString().split('\n').filter(line => line.startsWith('--- ') || line.startsWith('+++ ')), [
    '--- a/deps/uv/src/win/internal.h', '+++ b/deps/uv/src/win/internal.h',
    '--- a/deps/uv/src/win/process-stdio.c', '+++ b/deps/uv/src/win/process-stdio.c',
    '--- a/deps/uv/src/win/process.c', '+++ b/deps/uv/src/win/process.c',
    '--- /dev/null', '+++ b/deps/uv/src/win/nul-capability.h',
  ])
  assert.equal(lock.nulPatch.files['deps/uv/src/win/nul-capability.h'].originalSha256, null)
})

test('actual source verifier refuses changed originals, a pre-existing header and changed patched files', { timeout: 30000 }, t => {
  const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
  const available = cp.spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000 })
  if (available.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(available.error); assert.equal(available.status, 0, available.stderr)
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'node-patch-contract-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixture = { files: {}, contents: {} }
  for (const [name, entry] of Object.entries(lock.nulPatch.files)) {
    const original = entry.originalSha256 === null ? null : `original:${name}`
    const candidate = `candidate:${name}`
    fixture.files[name] = { originalSha256: original === null ? null : hash(original), candidateSha256: hash(candidate) }
    fixture.contents[name] = { original, candidate }
  }
  fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(fixture))
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PROOF_BUILD_SCRIPT,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Build script parse failure'}
foreach($name in @('Hash','Physical','AssertNodePatchSources')) {
 $matches=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true))
 if($matches.Count -ne 1){throw 'Expected one actual function'}
 Invoke-Expression $matches[0].Extent.Text
}
$source=Join-Path $env:PROOF_WORK 'source'
[void][IO.Directory]::CreateDirectory($source)
$fixture=Get-Content -LiteralPath (Join-Path $env:PROOF_WORK 'fixture.json') -Raw | ConvertFrom-Json
$encoding=[Text.UTF8Encoding]::new($false)
function Put([string]$Name,[string]$Value) {
 $file=Join-Path $source $Name
 [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
 [IO.File]::WriteAllText($file,$Value,$encoding)
}
function Refuses([bool]$Patched) {
 $refused=$false
 try { AssertNodePatchSources $source $fixture $Patched } catch { $refused=$true }
 if(-not $refused){throw 'Changed fixture incorrectly accepted'}
}
$cases=0
foreach($file in $fixture.contents.PSObject.Properties) {if($null -ne $file.Value.original){Put $file.Name $file.Value.original}}
AssertNodePatchSources $source $fixture $false;$cases++
foreach($file in $fixture.contents.PSObject.Properties) {
 if($null -eq $file.Value.original){continue}
 Put $file.Name 'tampered';Refuses $false;$cases++;Put $file.Name $file.Value.original
}
$header='deps/uv/src/win/nul-capability.h'
Put $header 'unexpected';Refuses $false;$cases++;[IO.File]::Delete((Join-Path $source $header))
foreach($file in $fixture.contents.PSObject.Properties){Put $file.Name $file.Value.candidate}
AssertNodePatchSources $source $fixture $true;$cases++
foreach($file in $fixture.contents.PSObject.Properties){Put $file.Name 'tampered';Refuses $true;$cases++;Put $file.Name $file.Value.candidate}
[IO.File]::Delete((Join-Path $source $header));Refuses $true;$cases++
@{sourceCases=$cases} | ConvertTo-Json -Compress
`
  const scriptPath = path.join(root, 'contract.ps1')
  fs.writeFileSync(scriptPath, script)
  const result = cp.spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PROOF_BUILD_SCRIPT: path.join(__dirname, 'build.ps1'), PROOF_WORK: root },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(result.stdout), { sourceCases: 11 })
})
