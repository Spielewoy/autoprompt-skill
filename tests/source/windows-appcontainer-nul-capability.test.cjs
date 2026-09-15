'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { parseController } = require('../helpers/windows-nul-capability-proof.cjs')
const fixtures = path.resolve(__dirname, '../fixtures/windows-appcontainer')
const nativeSource = path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs')
const sid = index => `S-1-15-2-${index}-2-3-4-5-6-7`
function child(index) { return { schemaVersion: 1, packageSid: sid(index), objectType: 'File', objectName: '\\Device\\Null', grantedAccess: 0x12019f, originalFlags: 1, duplicateFlags: 0, distinctStdin: true, readError: 0, readBytes: 0, writtenBytes: 1, strayEventInherited: false, startedMs: 10000 + index, finishedMs: 13000 + index } }
function envelope(children = [child(1), child(2)]) { return { schemaVersion: 1, hostEventInheritable: true, results: children.map(value => ({ packageSid: value.packageSid, drained: true, rootImageMatches: true, exitCode: 0, observedJobMembers: 1, stdoutBase64: Buffer.from(JSON.stringify(value)).toString('base64'), stderrBase64: '' })) } }
test('Null capability proof requires held object authority, exact rights and unrelated handle isolation', () => {
  assert.equal(parseController(JSON.stringify(envelope())).children.length, 2)
  for (const mutate of [c => { c.objectName = '\\Device\\NamedPipe\\other' }, c => { c.objectType = 'Event' }, c => { c.grantedAccess |= 0x40000 }, c => { c.originalFlags = 0 }, c => { c.duplicateFlags = 1 }, c => { c.distinctStdin = false }, c => { c.readError = 5 }, c => { c.readBytes = 1 }, c => { c.writtenBytes = 0 }, c => { c.strayEventInherited = true }, c => { c.extra = true }]) {
    const children = [child(1), child(2)]; mutate(children[0]); assert.throws(() => parseController(JSON.stringify(envelope(children))))
  }
  const eof = [child(1), child(2)]; eof[0].readError = 38; assert.equal(parseController(JSON.stringify(envelope(eof))).children[0].readError, 38)
})
test('Null capability proof requires two distinct concurrent profiles and both positive job drains', () => {
  for (const mutate of [p => { p.results[0].drained = false }, p => { p.results[1].rootImageMatches = false }, p => { p.results[0].exitCode = 1 }, p => { p.hostEventInheritable = false }, p => { p.results.pop() }, p => { p.results[0].stdoutBase64 += '=' }, p => { p.results[0].observedJobMembers = 0 }]) { const p = envelope(); mutate(p); assert.throws(() => parseController(JSON.stringify(p))) }
  assert.throws(() => parseController(JSON.stringify(envelope([child(1), child(1)]))))
  const separate = child(2); separate.startedMs = 20000; separate.finishedMs = 23000
  assert.throws(() => parseController(JSON.stringify(envelope([child(1), separate]))), /must overlap/)
})
test('Null capability native fixture compiles and rejects malformed handle locators before native calls', { skip: process.platform === 'win32', timeout: 30000 }, t => {
  const result = cp.spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop";Add-Type -Path @($env:PROBE_SOURCE,$env:CONTROLLER_SOURCE,$env:NATIVE_SOURCE);$method=[NulCapabilityProof].GetMethod("Handle",[Reflection.BindingFlags]"NonPublic,Static");foreach($bad in @("","1","0000000000000000","ffffffffffffffff","fffffffffffffffe","8000000000000000","00000000000000AF"," 0000000000000001","0000000000000001x")){$refused=$false;try{$method.Invoke($null,@($bad))|Out-Null}catch{$refused=$true};if(!$refused){throw "Malformed locator accepted"}};if($method.Invoke($null,@("0000000000000001")).ToInt64() -ne 1){throw "Valid locator refused"}'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PROBE_SOURCE: path.join(fixtures, 'nul-capability-proof.cs'), CONTROLLER_SOURCE: path.join(fixtures, 'nul-capability-controller.cs'), NATIVE_SOURCE: nativeSource } })
  if (result.error?.code === 'ENOENT') { t.skip('PowerShell unavailable for local C# compilation'); return }
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout)
})
test('native Windows Null capability stays distinct from stdin and excludes stray handles across concurrent profiles', { skip: process.platform !== 'win32', timeout: 600000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-nul-capability-')))
  let safe = true
  t.after(() => { if (safe) fs.rmSync(root, { recursive: true, force: true }); else t.diagnostic('Retained unconfirmed Null capability fixture: ' + root) })
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  ensureWindowsPrivateAcl(root)
  const control = path.join(root, 'control'), childDir = path.join(root, 'child')
  for (const directory of [control, childDir]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
  const probeSource = path.join(control, 'probe.cs'), controllerSource = path.join(control, 'controller.cs'), productionSource = path.join(control, 'native.cs')
  for (const [source, destination] of [[path.join(fixtures, 'nul-capability-proof.cs'), probeSource], [path.join(fixtures, 'nul-capability-controller.cs'), controllerSource], [nativeSource, productionSource]]) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  const probe = path.join(childDir, 'probe.exe'), controller = path.join(control, 'controller.exe')
  const systemRoot = process.env.SystemRoot, powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control }
  const compiled = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Environment]::SetEnvironmentVariable("PSModulePath",[IO.Path]::Combine($PSHOME,"Modules"),[EnvironmentVariableTarget]::Process);$ErrorActionPreference="Stop";Add-Type -Path $env:PROBE_SOURCE -OutputAssembly $env:PROBE_EXE -OutputType ConsoleApplication;Add-Type -Path @($env:CONTROLLER_SOURCE,$env:NATIVE_SOURCE) -OutputAssembly $env:CONTROLLER_EXE -OutputType ConsoleApplication'], { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PROBE_SOURCE: probeSource, CONTROLLER_SOURCE: controllerSource, NATIVE_SOURCE: productionSource, PROBE_EXE: probe, CONTROLLER_EXE: controller } })
  assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected = hash(probe)
  safe = false
  const result = cp.spawnSync(controller, [probe, expected], { encoding: 'utf8', timeout: 140000, maxBuffer: 200000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: control, env })
  for (const name of ['stdout', 'stderr']) for (const line of String(result[name] || '').slice(0, 200000).split(/\r?\n/)) for (let i = 0; i < line.length; i += 480) t.diagnostic(name + ': ' + line.slice(i, i + 480))
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '')
  const observed = parseController(result.stdout); safe = true
  assert.equal(hash(probe), expected)
  for (const value of observed.children) t.diagnostic('Null capability: ' + JSON.stringify(value))
})
