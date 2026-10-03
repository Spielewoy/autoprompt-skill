'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib')
const { DEFAULTS, canonical, sha, parseManifest, captureBytes, captureDirectory, describe, decode } = require('../../agents/codex/workflow/windows-worker-decoder.js')
function fixture(raw = Buffer.from('real worker bytes\0\u2603'), encoding = 'br') {
  const bytes = encoding === 'br' ? zlib.brotliCompressSync(raw) : Buffer.from(raw)
  const file = { path: 'assets/worker.br', output: 'bin/worker.exe', encoding, length: bytes.length, sha256: sha(bytes), rawLength: raw.length, rawSha256: sha(raw) }
  const manifest = { schema: 1, files: [file] }
  const make = () => Buffer.from(canonical(manifest) + '\n')
  return { raw, bytes, file, manifest, make, capture() { const data = make(); return captureBytes(data, [{ path: file.path, bytes }], sha(data)) } }
}
function parseEdited(edit, limits) {
  const value = fixture(); edit(value.manifest, value.file)
  const bytes = value.make(); return parseManifest(bytes, sha(bytes), limits)
}
function physicalTemp(prefix) { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))) }
test('real Brotli decode uses copied bytes and returns no acceptance claim', async () => {
  const value = fixture(), expected = Buffer.from(value.raw), cap = value.capture()
  value.bytes.fill(0); value.raw.fill(0); value.file.rawSha256 = '0'.repeat(64)
  const view = describe(cap); view.manifest.files[0].rawSha256 = 'f'.repeat(64)
  assert.equal(describe(cap).accepted, false)
  const first = await decode(cap, 'assets/worker.br'); assert.deepEqual(first, expected)
  first.fill(0); assert.deepEqual(await decode(cap, 'assets/worker.br'), expected)
})
test('a sealed decoder Node distinct from the host is revalidated before Brotli spawn', async t => {
  const root = physicalTemp('decoder-node-'), node = path.join(root, process.platform === 'win32' ? 'bound-node.exe' : 'bound-node')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.copyFileSync(process.execPath, node); fs.chmodSync(node, 0o700)
  const nodeSha = sha(fs.readFileSync(node)), value = fixture(), bytes = value.make()
  const cap = captureBytes(bytes, [{ path: value.file.path, bytes: value.bytes }], sha(bytes), undefined, { path: node, sha256: nodeSha })
  assert.deepEqual(await decode(cap, value.file.path), value.raw)
  fs.appendFileSync(node, 'replaced')
  await assert.rejects(decode(cap, value.file.path), /decoder-node-changed/)
})
test('identity support bytes and empty Brotli payload remain exact', async () => {
  for (const encoding of ['br', 'identity']) {
    const value = fixture(Buffer.alloc(0), encoding); assert.deepEqual(await decode(value.capture(), value.file.path), Buffer.alloc(0))
  }
})
test('defaults admit actual Node-sized artifacts with configurable bounded 128MiB+ raw limits', () => {
  assert.equal(DEFAULTS.rawFileBytes, 128 * 1024 * 1024)
  for (const size of [96, 104, 128]) assert.equal(parseEdited((manifest, file) => { file.rawLength = size * 1024 * 1024 }).manifest.files[0].rawLength, size * 1024 * 1024)
  assert.throws(() => parseEdited((manifest, file) => { file.rawLength = 129 * 1024 * 1024 }), /raw-file-bound/)
  assert.equal(parseEdited((manifest, file) => { file.rawLength = 129 * 1024 * 1024 }, { rawFileBytes: 192 * 1024 * 1024 }).manifest.files[0].rawLength, 129 * 1024 * 1024)
  assert.throws(() => parseEdited(() => {}, { rawFileBytes: 257 * 1024 * 1024 }), /limit-bound/)
})
for (const [name, edit] of [
  ['unknown manifest field', manifest => { manifest.accepted = true }],
  ['unknown file field', (manifest, file) => { file.trusted = true }],
  ['uppercase path', (manifest, file) => { file.path = 'Assets/worker.br' }],
  ['parent path', (manifest, file) => { file.path = '../worker.br' }],
  ['backslash path', (manifest, file) => { file.path = 'assets\\worker.br' }],
  ['absolute path', (manifest, file) => { file.path = '/worker.br' }],
  ['device name', (manifest, file) => { file.path = 'assets/nul.br' }],
  ['output path alias', (manifest, file) => { file.output = 'bin/Worker.exe' }],
  ['reserved manifest input', (manifest, file) => { file.path = 'manifest.json' }],
  ['duplicate file', (manifest, file) => { manifest.files.push({ ...file }) }],
  ['duplicate output', (manifest, file) => { manifest.files.push({ ...file, path: 'assets/z.br' }) }],
  ['fractional length', (manifest, file) => { file.length = 1.5 }],
  ['negative raw length', (manifest, file) => { file.rawLength = -1 }],
  ['unknown codec', (manifest, file) => { file.encoding = 'gzip' }],
  ['missing digest', (manifest, file) => { delete file.sha256 }],
  ['invalid digest', (manifest, file) => { file.sha256 = 'a'.repeat(63) }],
  ['identity mismatch', (manifest, file) => { file.encoding = 'identity' }],
  ['nonadjacent prefix collision', (manifest, file) => { manifest.files = ['a', 'a-b', 'a/c'].map((name, index) => ({ ...file, path: name, output: 'out' + index })) }],
]) test('closed manifest rejects ' + name, () => assert.throws(() => parseEdited(edit)))
test('manifest authenticity, duplicate JSON keys and canonical encoding are required', () => {
  const value = fixture(), bytes = value.make()
  assert.throws(() => parseManifest(bytes, '0'.repeat(64)), /authority-mismatch/)
  for (const text of [bytes.toString().replace('"schema":1', '"schema":1,"schema":1'), bytes.toString().replace('"schema":1', '"schema": 1'), bytes.toString() + '\n']) {
    const changed = Buffer.from(text); assert.throws(() => parseManifest(changed, sha(changed)), /canonical/)
  }
})
test('total byte limits and inventory bounds are mandatory', () => {
  assert.throws(() => parseEdited(() => {}, { compressedTotalBytes: 1 }), /total-bound/)
  assert.throws(() => parseEdited(() => {}, { rawTotalBytes: 1 }), /total-bound/)
  assert.throws(() => parseEdited(manifest => { manifest.files = [] }), /manifest-file-bound/)
  assert.throws(() => parseEdited(() => {}, { unknown: 5 }), /unknown-limit/)
  const value = fixture(), bytes = value.make()
  assert.throws(() => captureBytes(bytes, [], sha(bytes)), /closed-inventory/)
  assert.throws(() => captureBytes(bytes, [{ path: value.file.path, bytes: Buffer.alloc(value.bytes.length) }], sha(bytes)), /capture-file-digest/)
})
for (const [name, change] of [
  ['corrupt', value => { value.bytes = Buffer.alloc(value.bytes.length, 0xff) }],
  ['truncated', value => { value.bytes = value.bytes.subarray(0, value.bytes.length - 1) }],
  ['trailing garbage', value => { value.bytes = Buffer.concat([value.bytes, Buffer.from('ignored?')]) }],
  ['concatenated stream', value => { value.bytes = Buffer.concat([value.bytes, value.bytes]) }],
  ['overrun', value => { value.file.rawLength-- }],
  ['underrun', value => { value.file.rawLength++ }],
  ['wrong raw hash', value => { value.file.rawSha256 = '0'.repeat(64) }],
]) test('actual decoder refuses ' + name + ' with confirmed child close', async () => {
  const value = fixture(); change(value); value.file.length = value.bytes.length; value.file.sha256 = sha(value.bytes)
  const manifest = value.make(), cap = captureBytes(manifest, [{ path: value.file.path, bytes: value.bytes }], sha(manifest))
  await assert.rejects(decode(cap, value.file.path), error => error.cleanupConfirmed === true)
})
test('real child deadline refuses and drains before the capability can be reused', async () => {
  const value = fixture(Buffer.alloc(4 * 1024 * 1024, 7)), cap = value.capture()
  await assert.rejects(decode(cap, value.file.path, { deadlineMs: 1 }), error => error.message === 'decoder-deadline' && error.cleanupConfirmed === true)
  assert.deepEqual(await decode(cap, value.file.path), value.raw)
})
test('parallel decoding, forged capability and unknown member are refused', async () => {
  const value = fixture(), cap = value.capture(), started = decode(cap, value.file.path)
  await assert.rejects(decode(cap, value.file.path), /capture-busy-or-invalid/)
  await started
  await assert.rejects(decode(Object.freeze({}), value.file.path), /capture-busy-or-invalid/)
  await assert.rejects(decode(cap, 'assets/unknown.br'), /file-not-captured/)
})
test('filesystem capture requires native held capture on Windows and never reopens captured inputs elsewhere', async () => {
  if (process.platform === 'win32') { assert.throws(() => captureDirectory('unused', '0'.repeat(64)), /windows-native-held-capture-required/); return }
  const root = physicalTemp('decoder-owned-')
  try {
    const value = fixture(), manifest = value.make(); fs.mkdirSync(path.join(root, 'assets'))
    fs.writeFileSync(path.join(root, 'manifest.json'), manifest); fs.writeFileSync(path.join(root, value.file.path), value.bytes)
    fs.writeFileSync(path.join(root, 'unexpected'), 'extra')
    assert.throws(() => captureDirectory(root, sha(manifest)), /extra-file/); fs.unlinkSync(path.join(root, 'unexpected'))
    const cap = captureDirectory(root, sha(manifest)); fs.rmSync(root, { recursive: true })
    assert.deepEqual(await decode(cap, value.file.path), value.raw)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('filesystem capture rejects non-native Windows capture and linked paths elsewhere', () => {
  if (process.platform === 'win32') { assert.throws(() => captureDirectory('unused', '0'.repeat(64)), /windows-native-held-capture-required/); return }
  const root = physicalTemp('decoder-links-')
  try {
    const value = fixture(), manifest = value.make(); fs.mkdirSync(path.join(root, 'assets'))
    fs.writeFileSync(path.join(root, 'manifest.json'), manifest); fs.writeFileSync(path.join(root, 'original'), value.bytes)
    fs.linkSync(path.join(root, 'original'), path.join(root, value.file.path)); fs.unlinkSync(path.join(root, 'original'))
    fs.linkSync(path.join(root, value.file.path), path.join(root, 'other'))
    assert.throws(() => captureDirectory(root, sha(manifest)), /physical-file-required/)
    fs.unlinkSync(path.join(root, 'other')); fs.unlinkSync(path.join(root, value.file.path)); fs.symlinkSync('../manifest.json', path.join(root, value.file.path))
    assert.throws(() => captureDirectory(root, sha(manifest)), /physical-file-required/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('filesystem fixture canonicalizes a symlinked temporary root before capture', () => {
  if (process.platform === 'win32') return
  const realParent = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-tmp-real-')), alias = realParent + '-alias'
  fs.symlinkSync(realParent, alias, 'dir')
  const previous = process.env.TMPDIR
  process.env.TMPDIR = alias
  try {
    const root = physicalTemp('decoder-symlinked-tmp-')
    assert.equal(root, fs.realpathSync.native(root)); assert.equal(root.startsWith(alias + path.sep), false)
    const value = fixture(), manifest = value.make(); fs.mkdirSync(path.join(root, 'assets'))
    fs.writeFileSync(path.join(root, 'manifest.json'), manifest); fs.writeFileSync(path.join(root, value.file.path), value.bytes)
    assert.doesNotThrow(() => captureDirectory(root, sha(manifest)))
    fs.rmSync(root, { recursive: true })
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous
    fs.rmSync(alias, { force: true })
    fs.rmSync(realParent, { recursive: true, force: true })
  }
})
test('capture evaluates each supplied byte source once before making its private copy', async () => {
  const value = fixture(Buffer.from('identity support'), 'identity'), manifest = value.make(); let reads = 0
  const record = { path: value.file.path, get bytes() { reads++; return reads === 1 ? value.bytes : Buffer.alloc(1) } }
  const cap = captureBytes(manifest, [record], sha(manifest))
  assert.equal(reads, 1); assert.deepEqual(await decode(cap, value.file.path), value.raw)
})
