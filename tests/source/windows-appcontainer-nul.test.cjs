'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { names, accesses, parseCells, parseController } = require('../helpers/windows-nul-proof.cjs')
const fixtures = path.resolve(__dirname, '../fixtures/windows-appcontainer')
const nativeSource = path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs')
const packageSid = 'S-1-15-2-1-2-3-4-5-6-7'
function syntheticRecords(host = false) {
  const records = [{ kind: 'identity', appContainer: host ? 0 : 1, userSid: 'S-1-5-21-1-2-3-1000', packageSid: host ? '' : packageSid, osBuild: 26100, pointerBits: 64 }]
  for (let n = 0; n < names.length; n++) {
    records.push({ kind: 'name', index: n, value: names[n] })
    for (let a = 0; a < accesses.length; a++) {
      const cell = { kind: 'open', nameIndex: n, accessIndex: a, access: accesses[a], error: 5 }
      if (host && n === 0 && a < 2) Object.assign(cell, { error: 0, handleFlags: 1, flagsError: 0, objectStatus: '00000000', objectName: '\\Device\\Null', fileType: 2, ioError: 0, ioBytes: a === 0 ? 0 : 1 })
      records.push(cell)
      if (cell.error === 0) records.push({ kind: 'security', nameIndex: n, accessIndex: a, status: 5, convertError: 0, sddlBase64: '' })
    }
  }
  records.push({ kind: 'completed', cells: 20 })
  return records
}
const encodeRecords = records => records.map(value => JSON.stringify(value)).join('\n') + '\n'
function envelope(records = syntheticRecords()) {
  return { schemaVersion: 1, packageSid, drained: true, rootImageMatches: true, exitCode: 0, timedOut: false, cancelled: false, outputLimit: false, observedJobMembers: 1, stdoutBase64: Buffer.from(encodeRecords(records)).toString('base64'), stderrBase64: '' }
}
test('NUL diagnostic parser requires twenty ordered cells, host controls and exact token identity', () => {
  assert.equal(parseCells(encodeRecords(syntheticRecords()), packageSid).cells.length, 20)
  assert.equal(parseCells(encodeRecords(syntheticRecords(true))).cells.length, 20)
  const mutations = [
    records => records.splice(3, 1),
    records => records.splice(3, 0, structuredClone(records[2])),
    records => { records[2].access = 1 },
    records => { records[0].appContainer = 0 },
    records => { records[0].packageSid = 'S-1-15-2-9-2-3-4-5-6-7' },
    records => { records.at(-1).cells = 19 },
    records => { records[2].unexpected = true },
  ]
  for (const mutate of mutations) {
    const records = syntheticRecords(); mutate(records)
    assert.throws(() => parseCells(encodeRecords(records), packageSid))
  }
  const host = syntheticRecords(true)
  host[2] = { kind: 'open', nameIndex: 0, accessIndex: 0, access: accesses[0], error: 5 }
  host.splice(3, 1)
  assert.throws(() => parseCells(encodeRecords(host)), /Host NUL control/)
})
test('NUL controller parser refuses missing drain, altered output and incomplete native observations', () => {
  assert.equal(parseController(JSON.stringify(envelope())).child.cells.length, 20)
  for (const mutation of [
    proof => { proof.drained = false },
    proof => { proof.rootImageMatches = false },
    proof => { proof.timedOut = true },
    proof => { proof.cancelled = true },
    proof => { proof.outputLimit = true },
    proof => { proof.exitCode = 1 },
    proof => { proof.observedJobMembers = 0 },
    proof => { proof.stdoutBase64 += '=' },
    proof => { proof.stdoutBase64 = Buffer.from(encodeRecords(syntheticRecords().slice(0, -1))).toString('base64') },
  ]) {
    const proof = envelope(); mutation(proof)
    assert.throws(() => parseController(JSON.stringify(proof)))
  }
})
test('NUL native fixture and controller compile with the current production launcher', { skip: process.platform === 'win32', timeout: 30000 }, t => {
  // Native Windows case below compiles executable assemblies itself. This
  // optional local check catches syntax/signature drift without claiming APIs ran.
  const result = cp.spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -Path @($env:NUL_PROBE_SOURCE,$env:NUL_CONTROLLER_SOURCE,$env:NUL_NATIVE_SOURCE)'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, NUL_PROBE_SOURCE: path.join(fixtures, 'nul-proof.cs'), NUL_CONTROLLER_SOURCE: path.join(fixtures, 'nul-controller.cs'), NUL_NATIVE_SOURCE: nativeSource },
  })
  if (result.error?.code === 'ENOENT') { t.skip('PowerShell is unavailable for local compilation'); return }
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout)
})
function diagnostics(t, label, result) {
  for (const stream of ['stdout', 'stderr']) {
    for (const line of String(result[stream] || '').slice(0, 400000).split(/\r?\n/)) {
      for (let at = 0; at < line.length; at += 480) t.diagnostic(label + ' ' + stream + ': ' + line.slice(at, at + 480))
    }
  }
}
test('native Windows NUL diagnostic records exact device access under an AppContainer token', { skip: process.platform !== 'win32', timeout: 600000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-nul-')))
  let cleanupSafe = true
  t.after(() => { if (cleanupSafe) fs.rmSync(root, { recursive: true, force: true }); else t.diagnostic('Retained NUL fixture after unconfirmed controller outcome: ' + root) })
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  ensureWindowsPrivateAcl(root)
  const control = path.join(root, 'control'), child = path.join(root, 'child')
  for (const directory of [control, child]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
  const probeSource = path.join(control, 'nul-proof.cs'), controllerSource = path.join(control, 'nul-controller.cs'), productionSource = path.join(control, 'native.cs')
  for (const [source, target] of [[path.join(fixtures, 'nul-proof.cs'), probeSource], [path.join(fixtures, 'nul-controller.cs'), controllerSource], [nativeSource, productionSource]]) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  const probe = path.join(child, 'nul-proof.exe'), controller = path.join(control, 'nul-controller.exe')
  const systemRoot = process.env.SystemRoot, powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control }
  const compiled = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Environment]::SetEnvironmentVariable("PSModulePath",[IO.Path]::Combine($PSHOME,"Modules"),[EnvironmentVariableTarget]::Process);$ErrorActionPreference="Stop";Add-Type -Path $env:NUL_PROBE_SOURCE -OutputAssembly $env:NUL_PROBE_EXE -OutputType ConsoleApplication;Add-Type -Path @($env:NUL_CONTROLLER_SOURCE,$env:NUL_NATIVE_SOURCE) -OutputAssembly $env:NUL_CONTROLLER_EXE -OutputType ConsoleApplication'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...environment, NUL_PROBE_SOURCE: probeSource, NUL_CONTROLLER_SOURCE: controllerSource, NUL_NATIVE_SOURCE: productionSource, NUL_PROBE_EXE: probe, NUL_CONTROLLER_EXE: controller },
  })
  assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const probeHash = hash(probe)
  const host = cp.spawnSync(probe, ['--host'], { encoding: 'utf8', timeout: 10000, maxBuffer: 400000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: control, env: environment })
  diagnostics(t, 'host', host)
  assert.ifError(host.error); assert.equal(host.status, 0, host.stderr || host.stdout); assert.equal(host.stderr, '')
  const baseline = parseCells(host.stdout)
  cleanupSafe = false
  const result = cp.spawnSync(controller, [probe, probeHash], { encoding: 'utf8', timeout: 30000, maxBuffer: 400000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: control, env: environment })
  // Decode successful child output for readable live CI records, while always
  // keeping raw stderr. Invalid output is still printed and then rejected.
  let displayed = result
  try { const proof = JSON.parse(result.stdout); displayed = { ...result, stdout: Buffer.from(proof.stdoutBase64, 'base64').toString('utf8') } } catch {}
  diagnostics(t, 'child', displayed)
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '')
  const observed = parseController(result.stdout)
  cleanupSafe = true
  assert.equal(observed.child.identity.userSid, baseline.identity.userSid)
  assert.equal(observed.child.identity.osBuild, baseline.identity.osBuild)
  assert.equal(observed.child.identity.pointerBits, baseline.identity.pointerBits)
  assert.equal(hash(probe), probeHash)
  t.diagnostic('Native NUL observation completed: host 20 cells, AppContainer 20 cells, owned job positively drained; no device ACL changes')
})
