'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')
const runtime = require('../../scripts/harness-v2-bridge/grok/windows-runtime.cjs')
const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')

function pe(architecture = 'x64') {
  const bytes = Buffer.alloc(512), offset = 0x80
  bytes.write('MZ'); bytes.writeUInt32LE(offset, 0x3c); bytes.write('PE\0\0', offset, 'binary')
  bytes.writeUInt16LE(runtime.MACHINES[architecture], offset + 4); bytes.writeUInt16LE(1, offset + 6)
  bytes.writeUInt16LE(112, offset + 20); bytes.writeUInt16LE(0x0002, offset + 22); bytes.writeUInt16LE(0x20b, offset + 24)
  return bytes
}
function fixture(architecture = 'x64') {
  // macOS commonly exposes /var through /private/var; use the physical spelling
  // because production rejects aliases. Windows modes do not establish privacy,
  // so the fresh test-owned output needs the same native ACL helper as callers.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-win-runtime-')))
  const scope = path.join(root, 'node_modules', '@xai-official'), packageRoot = path.join(scope, 'grok')
  const platformRoot = path.join(scope, `grok-win32-${architecture}`), outputRoot = path.join(root, 'runtime')
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true }); fs.mkdirSync(path.join(platformRoot, 'bin'), { recursive: true }); fs.mkdirSync(outputRoot, { mode: 0o700 })
  if (process.platform === 'win32') ensureWindowsPrivateAcl(outputRoot)
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@xai-official/grok', version: runtime.PINNED_VERSION, bin: { grok: 'bin/grok' }, optionalDependencies: { [`@xai-official/grok-win32-${architecture}`]: runtime.PINNED_VERSION } }))
  fs.writeFileSync(path.join(packageRoot, 'bin', 'grok'), '#!/usr/bin/env node\n// official fixture\n')
  fs.writeFileSync(path.join(platformRoot, 'package.json'), JSON.stringify({ name: `@xai-official/grok-win32-${architecture}`, version: runtime.PINNED_VERSION, os: ['win32'], cpu: [architecture] }))
  fs.writeFileSync(path.join(platformRoot, 'bin', 'grok.exe.br'), zlib.brotliCompressSync(pe(architecture)))
  return { root, packageRoot, outputRoot, architecture }
}

test('materializes and reuses one exact pinned official Grok Windows payload closure', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const first = runtime.materializeWindowsGrokRuntime(f), second = runtime.materializeWindowsGrokRuntime(f)
  assert.deepEqual(second, first); assert.equal(first.kind, 'grok-official-windows-runtime'); assert.equal(first.architecture, 'x64')
  assert.equal(first.executable.sha256, require('node:crypto').createHash('sha256').update(pe()).digest('hex'))
  assert.equal(fs.readFileSync(first.executable.path).subarray(0, 2).toString(), 'MZ')
  assert.match(first.closureSha256, /^[a-f0-9]{64}$/); assert.equal(fs.statSync(first.executable.path).nlink, 1)
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.executable), true)
  assert.equal(Object.isFrozen(first.executable.identity), true); assert.equal(Object.isFrozen(first.compressedPayload.identity), true)
  assert.throws(() => { first.executable.identity.dev = 'changed' }, TypeError)
})

test('refuses package, compressed payload, architecture and reused output mutations', t => {
  for (const mutation of ['version', 'compressed', 'architecture', 'output', 'descriptor']) {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
    const first = mutation === 'version' || mutation === 'architecture' ? null : runtime.materializeWindowsGrokRuntime(f)
    if (mutation === 'version') {
      const file = path.join(f.packageRoot, 'package.json'), value = JSON.parse(fs.readFileSync(file)); value.version = '1.0.14'; fs.writeFileSync(file, JSON.stringify(value))
    } else if (mutation === 'compressed') fs.appendFileSync(path.join(path.dirname(f.packageRoot), 'grok-win32-x64', 'bin', 'grok.exe.br'), 'foreign')
    else if (mutation === 'architecture') fs.writeFileSync(path.join(path.dirname(f.packageRoot), 'grok-win32-x64', 'bin', 'grok.exe.br'), zlib.brotliCompressSync(pe('arm64')))
    else if (mutation === 'output') fs.appendFileSync(first.executable.path, 'foreign')
    else fs.appendFileSync(first.descriptorPath, 'foreign')
    assert.throws(() => runtime.materializeWindowsGrokRuntime(f), error => /^GROK_WINDOWS_RUNTIME_(?:INVALID|REUSE_INVALID)$/.test(error.code))
  }
})

test('refuses symlinked source files and incomplete prior publication', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const compressed = path.join(path.dirname(f.packageRoot), 'grok-win32-x64', 'bin', 'grok.exe.br'), moved = `${compressed}.physical`
  fs.renameSync(compressed, moved); fs.symlinkSync(moved, compressed)
  assert.throws(() => runtime.materializeWindowsGrokRuntime(f), { code: 'GROK_WINDOWS_RUNTIME_INVALID' })
  fs.unlinkSync(compressed); fs.renameSync(moved, compressed)
  fs.writeFileSync(path.join(f.outputRoot, `grok-${runtime.PINNED_VERSION}-x64.exe`), pe(), { mode: 0o700 })
  assert.throws(() => runtime.materializeWindowsGrokRuntime(f), { code: 'GROK_WINDOWS_RUNTIME_REUSE_INVALID' })
})

test('refuses a non-private output root without changing its permissions', { skip: process.platform === 'win32' }, t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  fs.chmodSync(f.outputRoot, 0o755)
  assert.throws(() => runtime.materializeWindowsGrokRuntime(f), { code: 'GROK_WINDOWS_RUNTIME_INVALID' })
  assert.equal(fs.statSync(f.outputRoot).mode & 0o777, 0o755)
  assert.deepEqual(fs.readdirSync(f.outputRoot), [])
})

test('detects pathname replacement after descriptor read and retains a replacement during rollback', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const manifest = path.join(f.packageRoot, 'package.json'), manifestBytes = fs.readFileSync(manifest)
  const originalRead = fs.readFileSync
  let replaced = false
  fs.readFileSync = function (file, ...args) {
    const bytes = originalRead.call(this, file, ...args)
    if (!replaced && typeof file === 'number') {
      replaced = true; fs.unlinkSync(manifest); fs.writeFileSync(manifest, manifestBytes)
    }
    return bytes
  }
  try { assert.throws(() => runtime.materializeWindowsGrokRuntime(f), { code: 'GROK_WINDOWS_RUNTIME_CHANGED' }) }
  finally { fs.readFileSync = originalRead }

  const second = fixture(); t.after(() => fs.rmSync(second.root, { recursive: true, force: true }))
  const originalLink = fs.linkSync
  let links = 0, replacementPath
  fs.linkSync = function (source, destination) {
    links += 1
    if (links === 1) { originalLink.call(this, source, destination); replacementPath = destination; return }
    const bytes = fs.readFileSync(replacementPath)
    fs.renameSync(replacementPath, `${replacementPath}.original`); fs.writeFileSync(replacementPath, bytes, { mode: 0o700 })
    throw Object.assign(new Error('descriptor publication failed'), { code: 'EIO' })
  }
  try { assert.throws(() => runtime.materializeWindowsGrokRuntime(second), { code: 'EIO' }) }
  finally { fs.linkSync = originalLink }
  assert.equal(fs.existsSync(replacementPath), true, 'rollback deleted a same-byte replacement inode')
})
