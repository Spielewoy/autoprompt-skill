'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path')
const repo = path.resolve(__dirname, '../../..')
const { validateFiles, Session } = require('./adapter.cjs')
const record = (name, length) => ({ path: name, length, sha256: '0'.repeat(64) })
test('actual helper C# compiles and executes parser, bounded input, and lease contracts', () => {
  const pwsh = process.env.AUTOPROMPT_CAPTURE_PWSH || (process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'pwsh')
  const result = cp.spawnSync(pwsh, ['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(__dirname, 'contract.ps1')], { encoding:'utf8', timeout: 15000, maxBuffer: 1024 * 1024 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^actual-compiled-helper-contracts:40\r?\n$/)
})
test('capture bounds accept actual node sized files and reject per-file and total overflow', () => {
  assert.equal(validateFiles([record('manifest.json', 1), record('node-x64.br',104267776), record('node-arm64.br',96414208)]).length, 3)
  assert.throws(() => validateFiles([record('manifest.json',1),record('node.br',128 * 1024 * 1024 + 1)]), /proof-file-bound/)
  assert.throws(() => validateFiles([record('manifest.json',1),record('a.br',128 * 1024 * 1024),record('b.br',128 * 1024 * 1024)]), /proof-total-or-manifest-bound/)
})
test('lease state requires two capture audits, finished acknowledgement and actual zero close', () => {
  const child = { exitCode:null }, session = new Session('root', child)
  assert.throws(() => session.audit('root'), /lease-not-held/)
  session.outputLine('bundle-lease-ready-v1')
  session.audit('root'); session.audit('root'); session.finish()
  assert.throws(() => session.accepted(), /native-lease-not-confirmed/)
  session.outputLine('bundle-lease-finished-v1')
  assert.throws(() => session.accepted(), /native-lease-not-confirmed/)
  session.close(0); session.accepted()
})

test('native17 control body stays identical and runs against the compiled helper assembly', () => {
  const actual = fs.readFileSync(path.join(__dirname,'native-controls.ps1'),'utf8')
  const original = fs.readFileSync(path.join(repo,'scripts/windows-runtime/physical-proof/native.ps1'),'utf8')
  assert.equal(actual.slice(actual.indexOf('$base =')), original.slice(original.indexOf('$base =')))
  assert.match(actual, /Reflection.Assembly\]::LoadFrom/)
  assert.equal(actual.includes("Add-Type -Path (Join-Path $PSScriptRoot 'audit.cs')"), false)
})
test('actual builder configuration uses one explicit CodeDOM compiler policy', () => {
  const pwsh = process.env.AUTOPROMPT_CAPTURE_PWSH || (process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'pwsh')
  const script = fs.readFileSync(path.join(__dirname,'build.ps1'),'utf8')
  const start = script.indexOf('$compiler=[CodeDom.Compiler.CompilerParameters]::new()')
  const end = script.indexOf('$providerOptions=')
  assert.ok(start > 0 && end > start)
  const source = "$ErrorActionPreference='Stop'; $exe=[IO.Path]::Combine([IO.Path]::GetTempPath(),'bundle-lease-contract.exe');\n" + script.slice(start,end) + `
if ($compiler.CompilerOptions -cne '/optimize+ /platform:anycpu' -or -not $compiler.GenerateExecutable -or $compiler.GenerateInMemory -or
  $compiler.OutputAssembly -cne $exe -or $compiler.MainClass -cne 'BundleLeaseMain' -or -not $compiler.TreatWarningsAsErrors -or $compiler.WarningLevel -ne 4 -or
  ($compiler.ReferencedAssemblies -join ',') -cne 'System.dll,System.Core.dll') { throw 'compiler-policy' }
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}')),[ref]$null,[ref]$errors)
if($errors.Count){throw 'builder-syntax'}
$commands=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true))
if(@($commands | Where-Object {$_.GetCommandName() -eq 'Add-Type'}).Count){throw 'runtime-conflicting-add-type'}
$providerOptions=[Collections.Generic.Dictionary[string,string]]::new();$providerOptions.Add('CompilerVersion','v4.0')
$provider=[Microsoft.CSharp.CSharpCodeProvider]::new($providerOptions)
try { if(-not @($provider.GetType().GetMethods() | Where-Object {$_.Name -eq 'CompileAssemblyFromFile'}).Count){throw 'compile-api'} } finally {$provider.Dispose()}
[Console]::WriteLine('actual-codedom-policy:passed')
`
  const result = cp.spawnSync(pwsh, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')], { encoding:'utf8', timeout:15000, maxBuffer:64*1024 })
  assert.equal(result.status,0,result.stdout+result.stderr)
  assert.equal(result.stderr,'')
  assert.match(result.stdout,/^actual-codedom-policy:passed\r?\n$/)
})
