'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')

const powershell = process.env.AUTOPROMPT_TEST_POWERSHELL || 'pwsh'
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

test('PowerShell emits Bash-readable LF checksums and scripts while preserving hash-bound patches', t => {
  // Select actual Git Bash on Windows, never the System32 WSL compatibility shim.
  const bash = process.platform === 'win32'
    ? require('../../agents/codex/workflow/windows-appcontainer-command.js').resolveWindowsBash().bash.path
    : 'bash'
  const bashEnv = { ...process.env, LC_ALL: 'C' }
  if (process.platform === 'win32') bashEnv.PATH = path.dirname(bash) + ';' + (process.env.PATH || process.env.Path || '')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msys-build-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'archives'))
  const filenames = ['cocom-0.996-6-x86_64.pkg.tar.zst', 'libzstd-devel-1.5.7-1-x86_64.pkg.tar.zst', 'zlib-devel-1.3.2-1-x86_64.pkg.tar.zst']
  const records = filenames.map((name, index) => {
    const bytes = Buffer.from(`actual payload ${index}\r\n\0`, 'utf8')
    fs.writeFileSync(path.join(root, 'archives', name), bytes)
    return `${digest(bytes)}  archives/${name}`
  })
  // Reproduce WriteAllLines on Windows, including the exact trailing-CR bug.
  fs.writeFileSync(path.join(root, 'windows.sha256'), records.join('\r\n') + '\r\n')
  const broken = cp.spawnSync(bash, ['-c', 'sha256sum -c windows.sha256'], { cwd: root, env: bashEnv, encoding: 'utf8', timeout: 10000 })
  assert.ifError(broken.error)
  assert.ok([0, 1].includes(broken.status), broken.stderr || broken.stdout)
  if (broken.status === 1) assert.match(broken.stderr, /No such file or directory/)
  t.diagnostic(`This checksum reader ${broken.status === 0 ? 'accepts' : 'rejects'} Windows CRLF; emitted manifests must use LF regardless`)
  const patch = Buffer.from('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n')
  fs.writeFileSync(path.join(root, 'adaptation.patch'), patch)
  fs.writeFileSync(path.join(root, 'crlf.patch'), patch.toString().replaceAll('\n', '\r\n'))
  fs.writeFileSync(path.join(root, 'bom.patch'), Buffer.concat([Buffer.from([239, 187, 191]), patch]))
  fs.writeFileSync(path.join(root, 'source.sh'), '\ufeff#!/usr/bin/env bash\r\nset -eu\r\nprintf "boundary-ok\\n"\r\n')
  fs.writeFileSync(path.join(root, 'input.json'), JSON.stringify({ records, patchHash: digest(patch) }))
  // Load only the production writer definitions; never run downloads or builds.
  const script = String.raw`
$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:BOUNDARY_BUILD,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
foreach($name in @('Write-Utf8Lf','Write-BuildChecksums','Assert-LfPatch')) {
  $definition=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if($definition.Count -ne 1){throw 'Missing or duplicate production writer'}
  . ([scriptblock]::Create($definition[0].Extent.Text))
}
Set-Location -LiteralPath $env:BOUNDARY_ROOT
$inputData=Get-Content -LiteralPath input.json -Raw | ConvertFrom-Json
$records=New-Object 'System.Collections.Generic.List[string]'
foreach($record in $inputData.records){$records.Add($record)}
Write-BuildChecksums (Join-Path $env:BOUNDARY_ROOT 'archives.sha256') $records.ToArray()
Write-BuildChecksums (Join-Path $env:BOUNDARY_ROOT 'adaptation.sha256') @($inputData.patchHash+'  adaptation.patch')
Write-Utf8Lf (Join-Path $env:BOUNDARY_ROOT 'repaired.sha256') ([IO.File]::ReadAllText((Join-Path $env:BOUNDARY_ROOT 'windows.sha256')))
Write-Utf8Lf (Join-Path $env:BOUNDARY_ROOT 'run.sh') ([IO.File]::ReadAllText((Join-Path $env:BOUNDARY_ROOT 'source.sh')))
Assert-LfPatch (Join-Path $env:BOUNDARY_ROOT 'adaptation.patch')
foreach($invalid in @('crlf.patch','bom.patch')) {
  $refused=$false
  try{Assert-LfPatch (Join-Path $env:BOUNDARY_ROOT $invalid)}catch{$refused=$true}
  if(!$refused){throw 'Invalid patch accepted'}
}
$refused=$false
try{Write-Utf8Lf (Join-Path $env:BOUNDARY_ROOT 'invalid.sh') ('first'+[char]13+'second')}catch{$refused=$true}
if(!$refused){throw 'Bare CR accepted'}
`
  const scriptPath = path.join(root, 'verify.ps1')
  fs.writeFileSync(scriptPath, script)
  const generated = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], {
    env: { ...process.env, BOUNDARY_BUILD: path.join(__dirname, 'build.ps1'), BOUNDARY_ROOT: root },
    encoding: 'utf8', timeout: 30000,
  })
  assert.ifError(generated.error)
  assert.equal(generated.status, 0, generated.stderr || generated.stdout)
  for (const file of ['archives.sha256', 'adaptation.sha256', 'repaired.sha256', 'run.sh']) {
    const bytes = fs.readFileSync(path.join(root, file))
    assert.equal(bytes.includes(13), false, `${file} must not contain CR`)
    assert.notDeepEqual([...bytes.subarray(0, 3)], [239, 187, 191], `${file} must not contain a BOM`)
    assert.equal(bytes.at(-1), 10, `${file} must end in LF`)
  }
  assert.deepEqual(fs.readFileSync(path.join(root, 'adaptation.patch')), patch, 'Validating a pinned patch must not rewrite it')
  assert.equal(fs.readFileSync(path.join(root, 'archives.sha256'), 'utf8'), records.join('\n') + '\n')
  const checked = cp.spawnSync(bash, ['-c', 'sha256sum -c archives.sha256 && sha256sum -c adaptation.sha256 && sha256sum -c repaired.sha256 && bash run.sh'], { cwd: root, env: bashEnv, encoding: 'utf8', timeout: 10000 })
  assert.ifError(checked.error)
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)
  assert.match(checked.stdout, /boundary-ok\n$/)
})
