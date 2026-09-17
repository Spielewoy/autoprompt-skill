'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Session, validateFiles, helperEnvironment, captureForProof } = require('./adapter.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const windows = process.platform === 'win32'
const powershell = windows ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : process.env.PWSH || 'pwsh'
const available = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 15000, stdio: 'ignore' }).status === 0
function script(name, timeout = 60000) {
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, name)], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 })
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || '') + String(result.error || ''))
  return result.stdout
}
function ready() {
  const session = new Session('C:\\owned', { exitCode: null })
  session.outputLine('bundle-lease-ready-v1')
  return session
}
test('physical lease actual C# validates path, type and held snapshot contracts', { skip: !available }, () => {
  assert.match(script('contract.ps1'), /actual-csharp-contracts:34/)
})
test('physical lease actual reader expires independently of blocked Console.In', { skip: !available }, () => {
  assert.match(script('reader-contract.ps1', 15000), /actual-driver-reader-contracts:4/)
})
test('physical lease two audits, final native acknowledgement and zero exit are all required', () => {
  const session = ready()
  assert.equal(session.audit(session.root), true)
  assert.equal(session.audit(session.root), true)
  session.finish()
  session.outputLine('bundle-lease-finished-v1')
  assert.throws(() => session.accepted())
  session.close(0)
  session.accepted()
})
for (const [name, mutation] of [
  ['before ready', session => { session.phase = 'starting' }],
  ['after close', session => session.close(0)],
  ['child exited', session => { session.child.exitCode = 0 }],
  ['different root', session => { session.root = 'C:\\other' }],
  ['third call', session => { session.calls = 2 }],
  ['already finishing', session => { session.phase = 'finishing' }]
]) test('physical lease audit refuses ' + name, () => {
  const session = ready(); mutation(session)
  assert.throws(() => session.audit('C:\\owned'))
})
test('physical lease missing second audit cannot finish', () => {
  const session = ready(); session.audit(session.root)
  assert.throws(() => session.finish())
})
for (const line of ['true', 'bundle-lease-finished-v1', 'bundle-lease-ready-v1']) {
  test('physical lease unexpected native message refuses ' + line, () => assert.throws(() => ready().outputLine(line)))
}
test('physical lease nonzero exit or absent final acknowledgement cannot authorize', () => {
  for (const acknowledge of [true, false]) {
    const session = ready(); session.audit(session.root); session.audit(session.root); session.finish()
    if (acknowledge) session.outputLine('bundle-lease-finished-v1')
    session.close(acknowledge ? 1 : 0)
    assert.throws(() => session.accepted())
  }
})
test('physical proof closed inventory refuses aliases, duplicates and oversized records', () => {
  const record = { path: 'manifest.json', length: 2, sha256: sha(Buffer.from('{}')) }
  assert.equal(validateFiles([record]).length, 1)
  assert.deepEqual(helperEnvironment('C:\\Windows', 'C:\\owned-helper'), {
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SystemDrive: 'C:', PATH: 'C:\\Windows\\System32',
    PSModulePath: '', TEMP: 'C:\\owned-helper', TMP: 'C:\\owned-helper'
  })
  for (const files of [[record, record], [{ ...record, path: '../manifest.json' }], [{ ...record, path: 'NUL' }], [{ ...record, length: 17000000 }], [{ ...record, extra: true }], [{ ...record, sha256: '00' }], []]) {
    assert.throws(() => validateFiles(files))
  }
  if (windows) {
    // Exercise the actual EncodedCommand transport and the driver's exact
    // preference prefix. Progress must disappear at its source; ordinary
    // PowerShell errors and direct stderr must remain observable.
    const prefix = fs.readFileSync(path.join(__dirname, 'driver.ps1'), 'utf8').split('$env:PSModulePath')[0]
    function encoded(source) {
      const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 })
      assert.ifError(result.error)
      return result
    }
    const progress = "Write-Progress -Activity 'bundle-lease-progress-control' -Status 'running' -PercentComplete 1; [Console]::Out.WriteLine('transport-ok')"
    const baseline = encoded(prefix.replace("$ProgressPreference = 'SilentlyContinue'", "$ProgressPreference = 'Continue'") + progress)
    assert.equal(baseline.status, 0)
    assert.equal(baseline.stdout, 'transport-ok\r\n')
    assert.match(baseline.stderr, /#< CLIXML/)
    assert.match(baseline.stderr, /S="progress"/)
    const quiet = encoded(prefix + progress)
    assert.equal(quiet.status, 0)
    assert.equal(quiet.stdout, baseline.stdout)
    assert.equal(quiet.stderr, '')
    const rawError = encoded(prefix + "[Console]::Error.WriteLine('native-error-control')")
    assert.equal(rawError.status, 0)
    assert.equal(rawError.stderr, 'native-error-control\r\n')
    const error = encoded(prefix + "Write-Error 'powershell-error-control'")
    assert.notEqual(error.status, 0)
    assert.match(error.stderr, /powershell-error-control/)
  }
})

test('native Windows physical lease rejects hardlinks, junctions, writers, mappings and tree mutations', { skip: !windows, timeout: 90000 }, t => {
  const output = script('native.ps1', 85000)
  for (const line of output.trim().split(/\r?\n/)) t.diagnostic(line)
  const names = output.split(/\r?\n/).filter(line => line.startsWith('native-physical-control:')).map(line => line.slice('native-physical-control:'.length))
  const fixed = ['valid-closed-tree', 'hardlinked-file', 'junction-root', 'junction-intermediate', 'junction-at-file-position', 'preexisting-writer', 'writer-release-positive-control', 'preexisting-writable-mapping', 'mapping-release-positive-control', 'held-write', 'held-delete', 'held-file-rename', 'held-root-rename', 'held-release-positive-control', 'extra-file', 'missing-file']
  assert.deepEqual(names.slice(0, -1), fixed)
  assert.ok(['held-extra-final-refusal', 'held-extra-creation-refused'].includes(names.at(-1)))
  assert.equal(new Set(names).size, 17)
  assert.match(output, /native-physical-count:17/)
})

function authority() {
  // These are repository-controlled diagnostic helper bytes. Production must
  // obtain the expected hashes from independent payload/release authority.
  return { sourceSha256: sha(fs.readFileSync(path.join(__dirname, 'audit.cs'))), driverSha256: sha(fs.readFileSync(path.join(__dirname, 'driver.ps1'))), systemRoot: process.env.SystemRoot }
}
async function fixture(body) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-capture-')))
  const manifest = Buffer.from('{}'), asset = Buffer.from('captured-owned-proof')
  fs.writeFileSync(path.join(root, 'manifest.json'), manifest)
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'assets', 'proof.br'), asset)
  const files = [{ path: 'manifest.json', length: manifest.length, sha256: sha(manifest) }, { path: 'assets/proof.br', length: asset.length, sha256: sha(asset) }]
  let cleanupConfirmed = false
  try {
    await body(root, files)
    cleanupConfirmed = true
  } catch (error) {
    cleanupConfirmed = error.cleanupConfirmed === true
    throw error
  } finally {
    if (cleanupConfirmed) fs.rmSync(root, { recursive: true, force: true })
    // Unknown helper exit leaves its owned fixture intact for diagnosis.
  }
}
const nativeOptions = { skip: !windows, timeout: 80000 }
test('native Windows physical capture requires a held lease and returns exact owned bytes', nativeOptions, () => fixture(async (root, files) => {
  let helperRoot
  const result = await captureForProof(root, files, authority(), { atReady: control => {
    helperRoot = control.helperRoot
    assert.equal(fs.statSync(helperRoot).isDirectory(), true)
    const relative = path.relative(root, helperRoot)
    assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
  } })
  assert.equal(fs.existsSync(helperRoot), false, 'Confirmed helper exit releases its separate private compiler temp')
  assert.equal(result.length, 2)
  for (let index = 0; index < result.length; index++) assert.equal(sha(result[index].bytes), files[index].sha256)
  fs.writeFileSync(path.join(root, 'assets', 'proof.br'), 'after-release')
  assert.equal(result[1].bytes.toString(), 'captured-owned-proof')
}))
for (const phase of ['atReady', 'afterCapture']) {
  test('native Windows physical capture refuses helper termination ' + phase, nativeOptions, () => fixture(async (root, files) => {
    await assert.rejects(captureForProof(root, files, authority(), { [phase]: async control => { assert.equal(control.terminate(), true); await control.closed } }), error => error.cleanupConfirmed === true)
  }))
}
for (const line of ['invalid', 'finish\nextra']) {
  test('native Windows physical capture refuses ' + (line === 'invalid' ? 'invalid finish' : 'trailing finish input'), nativeOptions, () => fixture(async (root, files) => {
    await assert.rejects(captureForProof(root, files, authority(), { finishLine: line }), error => error.cleanupConfirmed === true)
  }))
}
test('native Windows physical capture rejects changed content and confirms helper cleanup', nativeOptions, () => fixture(async (root, files) => {
  const changed = files.map(file => ({ ...file }))
  changed[1].sha256 = '0'.repeat(64)
  await assert.rejects(captureForProof(root, changed, authority()), error => error.message === 'capture-digest-mismatch' && error.cleanupConfirmed === true)
}))
