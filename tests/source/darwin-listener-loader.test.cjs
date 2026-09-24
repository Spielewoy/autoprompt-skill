'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const coalition = require('../../agents/codex/workflow/darwin-coalition-loader.js')
const loader = require('../../agents/codex/workflow/darwin-listener-loader.js')

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function machO(cpuType) {
  const bytes = Buffer.alloc(56)
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpuType, 4); bytes.writeUInt32LE(2, 12)
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20); bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36)
  bytes.writeUInt32LE(1, 40); bytes.writeUInt32LE((13 << 16) | (5 << 8), 44)
  return bytes
}
function fixture(t, kind = 'autoprompt-darwin-listener-runtime') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-listener-runtime-')); fs.chmodSync(root, 0o700)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = Buffer.from('/* pinned Darwin listener supervisor source */\n')
  const x64 = machO(loader.ARCHITECTURES.x64.cpuType), arm64 = machO(loader.ARCHITECTURES.arm64.cpuType)
  fs.writeFileSync(path.join(root, 'darwin-launchd-listener-supervisor.c'), source, { mode: 0o500 })
  fs.writeFileSync(path.join(root, 'listener-supervisor-x64'), x64, { mode: 0o500 })
  fs.writeFileSync(path.join(root, 'listener-supervisor-arm64'), arm64, { mode: 0o500 })
  const manifest = {
    schemaVersion: 1, kind, helperCSourceSha256: hash(source), minimumMacOS: '13.5',
    architectures: { x64: { file: 'listener-supervisor-x64', sha256: hash(x64), size: x64.length }, arm64: { file: 'listener-supervisor-arm64', sha256: hash(arm64), size: arm64.length } },
    provenance: { sourceRepository: 'https://example.invalid/autoprompt-skill', sourceCommit: '0123456789abcdef0123456789abcdef01234567', buildWorkflow: 'https://example.invalid/actions/runs/1', artifacts: { x64: { artifactId: 1, sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' }, arm64: { artifactId: 2, sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } } },
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  return { root, source, x64, arm64, manifest }
}

test('Darwin listener loader validates fixed runtime kind, source, architectures, and thin Mach-O payloads', t => {
  const f = fixture(t), sourcePath = path.join(f.root, 'darwin-launchd-listener-supervisor.c')
  assert.deepEqual(loader.validateDarwinListenerRuntime(f.root, 'x64', sourcePath), { path: path.join(f.root, 'listener-supervisor-x64'), sha256: f.manifest.architectures.x64.sha256 })
  assert.deepEqual(loader.validateDarwinListenerRuntime(f.root, 'arm64', sourcePath), { path: path.join(f.root, 'listener-supervisor-arm64'), sha256: f.manifest.architectures.arm64.sha256 })
  if (process.platform !== 'darwin') assert.deepEqual(loader.staticAvailability(), { available: false, code: 'DARWIN_LISTENER_UNAVAILABLE', reason: 'native macOS is required' })
})

test('Darwin listener loader refuses coalition manifests and payload tampering', t => {
  const f = fixture(t, 'autoprompt-darwin-coalition-runtime'), sourcePath = path.join(f.root, 'darwin-launchd-listener-supervisor.c')
  assert.throws(() => loader.validateDarwinListenerRuntime(f.root, 'x64', sourcePath), { code: 'DARWIN_COALITION_UNAVAILABLE' })
  f.manifest.kind = 'autoprompt-darwin-listener-runtime'; fs.writeFileSync(path.join(f.root, 'manifest.json'), JSON.stringify(f.manifest), { mode: 0o600 })
  fs.chmodSync(path.join(f.root, 'listener-supervisor-x64'), 0o600)
  fs.appendFileSync(path.join(f.root, 'listener-supervisor-x64'), 'tamper')
  assert.throws(() => loader.validateDarwinListenerRuntime(f.root, 'x64', sourcePath), { code: 'DARWIN_COALITION_UNAVAILABLE' })
  assert.throws(() => coalition.parseManifest(Buffer.from(JSON.stringify(f.manifest))), { code: 'DARWIN_COALITION_UNAVAILABLE' })
})
