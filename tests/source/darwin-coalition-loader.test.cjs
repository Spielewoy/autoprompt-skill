'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const loader = require('../../agents/codex/workflow/darwin-coalition-loader.js')

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function machO(cpuType, minimum = [13, 5, 0], options = {}) {
  const bytes = Buffer.alloc(56)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(cpuType, 4)
  bytes.writeUInt32LE(3, 8)
  bytes.writeUInt32LE(options.fileType ?? 2, 12)
  bytes.writeUInt32LE(1, 16)
  bytes.writeUInt32LE(24, 20)
  bytes.writeUInt32LE(0, 24)
  bytes.writeUInt32LE(0, 28)
  bytes.writeUInt32LE(0x32, 32)
  bytes.writeUInt32LE(24, 36)
  bytes.writeUInt32LE(options.platform ?? 1, 40)
  bytes.writeUInt32LE((minimum[0] << 16) | (minimum[1] << 8) | minimum[2], 44)
  bytes.writeUInt32LE(0, 48)
  bytes.writeUInt32LE(0, 52)
  return bytes
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-coalition-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.chmodSync(root, 0o700)
  const source = Buffer.from('/* pinned Darwin helper source */\n', 'utf8')
  const x64 = machO(loader.ARCHITECTURES.x64.cpuType), arm64 = machO(loader.ARCHITECTURES.arm64.cpuType)
  fs.writeFileSync(path.join(root, 'darwin-coalition-helper.c'), source, { mode: 0o500 })
  fs.writeFileSync(path.join(root, 'coalition-helper-x64'), x64, { mode: 0o500 })
  fs.writeFileSync(path.join(root, 'coalition-helper-arm64'), arm64, { mode: 0o500 })
  const manifest = {
    schemaVersion: 1,
    kind: 'autoprompt-darwin-coalition-runtime',
    helperCSourceSha256: hash(source),
    minimumMacOS: '13.5',
    architectures: {
      x64: { file: 'coalition-helper-x64', sha256: hash(x64), size: x64.length },
      arm64: { file: 'coalition-helper-arm64', sha256: hash(arm64), size: arm64.length },
    },
    provenance: { sourceRepository: 'https://example.invalid/autoprompt-skill', sourceCommit: '0123456789abcdef0123456789abcdef01234567', buildWorkflow: 'https://example.invalid/actions/runs/1', artifacts: { x64: { artifactId: 1, sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' }, arm64: { artifactId: 2, sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } } },
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  return { root, source, x64, arm64, manifest }
}

test('Darwin coalition loader binds a fixed manifest, source, architecture, and thin Mach-O helper', t => {
  const f = fixture(t)
  const sourcePath = path.join(f.root, 'darwin-coalition-helper.c')
  const x64 = loader.validateDarwinCoalitionRuntime(f.root, 'x64', sourcePath)
  const arm64 = loader.validateDarwinCoalitionRuntime(f.root, 'arm64', sourcePath)
  assert.deepEqual(x64, { path: path.join(f.root, 'coalition-helper-x64'), sha256: f.manifest.architectures.x64.sha256 })
  assert.deepEqual(arm64, { path: path.join(f.root, 'coalition-helper-arm64'), sha256: f.manifest.architectures.arm64.sha256 })
  assert.equal(loader.parseMachO(f.x64).cpuType, loader.ARCHITECTURES.x64.cpuType)
  assert.deepEqual(loader.parseMachO(f.arm64).minimumMacOS, [13, 5, 0])
})

test('Darwin coalition loader rejects binary tampering, architecture drift, source drift, and unsupported build minimums', t => {
  const f = fixture(t)
  const x64Path = path.join(f.root, 'coalition-helper-x64'), armPath = path.join(f.root, 'coalition-helper-arm64'), sourcePath = path.join(f.root, 'darwin-coalition-helper.c')
  for (const file of [x64Path, armPath, path.join(f.root, 'darwin-coalition-helper.c')]) fs.chmodSync(file, 0o600)
  fs.appendFileSync(x64Path, 'tamper')
  assert.throws(() => loader.validateDarwinCoalitionRuntime(f.root, 'x64', sourcePath), { code: 'DARWIN_COALITION_UNAVAILABLE' })
  fs.writeFileSync(x64Path, f.x64, { mode: 0o500 })
  fs.writeFileSync(armPath, f.x64, { mode: 0o500 })
  f.manifest.architectures.arm64 = { file: 'coalition-helper-arm64', sha256: hash(f.x64), size: f.x64.length }
  fs.writeFileSync(path.join(f.root, 'manifest.json'), JSON.stringify(f.manifest), { mode: 0o600 })
  assert.throws(() => loader.validateDarwinCoalitionRuntime(f.root, 'arm64', sourcePath), { code: 'DARWIN_COALITION_UNAVAILABLE' })
  fs.writeFileSync(armPath, f.arm64, { mode: 0o500 })
  f.manifest.architectures.arm64 = { file: 'coalition-helper-arm64', sha256: hash(f.arm64), size: f.arm64.length }
  fs.appendFileSync(path.join(f.root, 'darwin-coalition-helper.c'), 'source drift')
  fs.writeFileSync(path.join(f.root, 'manifest.json'), JSON.stringify(f.manifest), { mode: 0o600 })
  assert.throws(() => loader.validateDarwinCoalitionRuntime(f.root, 'x64', sourcePath), { code: 'DARWIN_COALITION_UNAVAILABLE' })
  fs.writeFileSync(path.join(f.root, 'darwin-coalition-helper.c'), f.source, { mode: 0o500 })
  const tooNew = machO(loader.ARCHITECTURES.x64.cpuType, [14, 0, 0])
  fs.writeFileSync(x64Path, tooNew, { mode: 0o500 })
  f.manifest.architectures.x64 = { file: 'coalition-helper-x64', sha256: hash(tooNew), size: tooNew.length }
  fs.writeFileSync(path.join(f.root, 'manifest.json'), JSON.stringify(f.manifest), { mode: 0o600 })
  assert.throws(() => loader.validateDarwinCoalitionRuntime(f.root, 'x64', sourcePath), { code: 'DARWIN_COALITION_UNAVAILABLE' })
})

test('Darwin coalition loader parser rejects non-Mach-O and static availability fails closed without packaged native artifacts', () => {
  assert.throws(() => loader.parseMachO(Buffer.from('not-a-mach-o')), { code: 'DARWIN_COALITION_UNAVAILABLE' })
  const availability = loader.staticAvailability()
  assert.equal(typeof availability.available, 'boolean')
  if (process.platform !== 'darwin') assert.deepEqual(availability, { available: false, code: 'DARWIN_COALITION_UNAVAILABLE', reason: 'native macOS is required' })
})


test('Darwin coalition loader rejects nonexecutable and iOS Mach-O plus duplicate build minimum records', () => {
  assert.throws(() => loader.parseMachO(machO(loader.ARCHITECTURES.x64.cpuType, [13, 5, 0], { fileType: 1 })), { code: 'DARWIN_COALITION_UNAVAILABLE' })
  assert.throws(() => loader.parseMachO(machO(loader.ARCHITECTURES.x64.cpuType, [13, 5, 0], { platform: 2 })), { code: 'DARWIN_COALITION_UNAVAILABLE' })
  const first = machO(loader.ARCHITECTURES.x64.cpuType), bytes = Buffer.alloc(80)
  first.copy(bytes, 0)
  bytes.writeUInt32LE(2, 16); bytes.writeUInt32LE(48, 20)
  first.subarray(32, 56).copy(bytes, 56)
  assert.throws(() => loader.parseMachO(bytes), { code: 'DARWIN_COALITION_UNAVAILABLE' })
})
