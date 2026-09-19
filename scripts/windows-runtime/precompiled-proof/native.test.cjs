'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto')
const native = process.platform === 'win32'
const skip = native ? false : 'requires native Windows NTFS and a compiled CLR4 helper'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
let capture, authority, root, files
if (native) {
  const repo = path.resolve(__dirname, '../../..'), build = process.env.AUTOPROMPT_CAPTURE_BUILD
  assert.ok(repo && build, 'explicit fixture repository and helper build directories required')
  const record = JSON.parse(fs.readFileSync(path.join(build, 'build.json'), 'utf8'))
  assert.equal(record.status, 'compiled-native-identity-only')
  assert.deepEqual(record.source.map(file => file.path), ['../physical-proof/audit.cs','lease-main.cs','build.ps1'])
  for (const file of record.source) assert.equal(sha(fs.readFileSync(path.join(__dirname, file.path))), file.sha256, 'compiled source identity')
  const helper = path.join(build, 'bundle-lease.exe')
  const hashes = new Map(record.files.map(file => [file.path, file.sha256]))
  authority = { executable: helper, executableSha256: hashes.get('bundle-lease.exe'), configSha256: hashes.get('bundle-lease.exe.config'), systemRoot: process.env.SystemRoot }
  capture = require('./adapter.cjs').capturePrecompiledForProof
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-helper-fixture-')))
  require(path.join(repo, 'agents/codex/workflow/safe-run-root.js')).ensureWindowsPrivateAcl(root)
  fs.mkdirSync(path.join(root, 'assets'))
  // Exercises a file over the diagnostic adapter's former 16 MiB cap.
  const payload = crypto.randomBytes(17 * 1024 * 1024)
  const manifest = Buffer.from('{"fixture":true}\n')
  files = [{ path: 'manifest.json', length: manifest.length, sha256: sha(manifest) }, { path: 'assets/payload.br', length: payload.length, sha256: sha(payload) }]
  fs.writeFileSync(path.join(root, 'manifest.json'), manifest)
  fs.writeFileSync(path.join(root, 'assets/payload.br'), payload)
  test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
}
test('native fixed executable holds the physical lease and captures above 16 MiB', { skip }, async () => {
  let held = false
  const records = await capture(root, files, authority, { atReady() {
    assert.throws(() => fs.writeFileSync(path.join(root, 'manifest.json'), 'changed'))
    assert.throws(() => fs.renameSync(path.join(root, 'assets/payload.br'), path.join(root, 'assets/replaced.br')))
    held = true
  } })
  assert.ok(held)
  assert.deepEqual(records.map(record => ({ path: record.path, length: record.bytes.length, sha256: sha(record.bytes) })), files)
})
test('native fixed executable refuses an incorrect finish handshake with confirmed close', { skip }, async () => {
  await assert.rejects(capture(root, files, authority, { finishLine: 'wrong' }), error => error.cleanupConfirmed === true)
})
test('native fixed executable refuses trailing input with confirmed close', { skip }, async () => {
  await assert.rejects(capture(root, files, authority, { finishLine: 'finish\nextra' }), error => error.cleanupConfirmed === true)
})
test('native helper termination cannot authorize captured bytes', { skip }, async () => {
  await assert.rejects(capture(root, files, authority, { async atReady(control) { control.terminate(); await control.closed } }), error => error.cleanupConfirmed === true)
})
test('native post-capture helper termination cannot authorize captured bytes', { skip }, async () => {
  await assert.rejects(capture(root, files, authority, { async afterCapture(control) { control.terminate(); await control.closed } }), error => error.cleanupConfirmed === true)
})
test('native helper bytes require external matching identity', { skip }, async () => {
  await assert.rejects(capture(root, files, { ...authority, executableSha256: '0'.repeat(64) }), /helper-authority-mismatch/)
})
test('compiled helper assembly passes all17 native physical lease controls', { skip, timeout: 90000 }, t => {
  const cp = require('node:child_process')
  const powershell = path.join(authority.systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = cp.spawnSync(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(__dirname,'native-controls.ps1'), '-Executable',authority.executable,'-ExpectedSha256',authority.executableSha256],
  { encoding:'utf8', timeout:85000, maxBuffer:64 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stderr, '')
  const lines = result.stdout.trim().split(/\r?\n/)
  const fixed = ['valid-closed-tree','hardlinked-file','junction-root','junction-intermediate','junction-at-file-position',
    'preexisting-writer','writer-release-positive-control','preexisting-writable-mapping','mapping-release-positive-control',
    'held-write','held-delete','held-file-rename','held-root-rename','held-release-positive-control','extra-file','missing-file']
  assert.deepEqual(lines.slice(0,16), fixed.map(name => 'native-physical-control:' + name))
  assert.ok(['native-physical-control:held-extra-final-refusal','native-physical-control:held-extra-creation-refused'].includes(lines[16]))
  assert.equal(lines[17], 'native-physical-count:17')
  assert.equal(lines.length, 18)
  for(const line of lines) t.diagnostic(line)
})
