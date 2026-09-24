'use strict'
// Offline research prototype. Hash-bound decoding does not admit a runtime.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process')
const MiB = 1024 * 1024
const DEFAULTS = Object.freeze({ manifestBytes: MiB, files: 128, compressedFileBytes: 128 * MiB, rawFileBytes: 128 * MiB, compressedTotalBytes: 256 * MiB, rawTotalBytes: 512 * MiB })
const CEILINGS = Object.freeze({ manifestBytes: 2 * MiB, files: 256, compressedFileBytes: 256 * MiB, rawFileBytes: 256 * MiB, compressedTotalBytes: 512 * MiB, rawTotalBytes: 1024 * MiB })
const captures = new WeakMap()
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const NODE_MAX_BYTES = 512 * MiB
function need(ok, code) { if (!ok) throw Error(code) }
function keys(value, expected, code) { need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected.split(',').sort().join(','), code) }
function limitsFor(options = {}) {
  need(options && typeof options === 'object' && !Array.isArray(options), 'limits-required')
  need(Object.keys(options).every(key => Object.hasOwn(DEFAULTS, key)), 'unknown-limit')
  const limits = { ...DEFAULTS, ...options }
  for (const key of Object.keys(limits)) need(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= CEILINGS[key], 'limit-bound:' + key)
  return Object.freeze(limits)
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function relative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.split('/').every(part =>
    part.length <= 96 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:$|\.)/.test(part))
}
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function disjoint(paths, code) {
  const values = new Set(paths); need(values.size === paths.length, code)
  for (const value of paths) { const parts = value.split('/'); for (let index = 1; index < parts.length; index++) need(!values.has(parts.slice(0, index).join('/')), code) }
}
function parseManifest(input, expectedSha, limitOptions) {
  const limits = limitsFor(limitOptions)
  need(Buffer.isBuffer(input) && input.length > 0 && input.length <= limits.manifestBytes, 'manifest-bound')
  input = Buffer.from(input)
  need(hash(expectedSha) && sha(input) === expectedSha, 'manifest-authority-mismatch')
  const manifest = JSON.parse(input.toString('utf8'))
  keys(manifest, 'schema,files', 'manifest-shape')
  need(manifest.schema === 1 && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= limits.files, 'manifest-file-bound')
  need(input.equals(Buffer.from(canonical(manifest) + '\n')), 'manifest-not-canonical')
  let compressedTotal = 0, rawTotal = 0, previous = ''
  for (const file of manifest.files) {
    keys(file, 'path,output,encoding,length,sha256,rawLength,rawSha256', 'file-shape')
    need(relative(file.path) && relative(file.output) && file.path !== 'manifest.json' && file.path > previous, 'file-path-order')
    previous = file.path
    need(['br', 'identity'].includes(file.encoding), 'encoding-refused')
    need(Number.isSafeInteger(file.length) && file.length >= (file.encoding === 'br' ? 1 : 0) && file.length <= limits.compressedFileBytes, 'compressed-file-bound')
    need(Number.isSafeInteger(file.rawLength) && file.rawLength >= 0 && file.rawLength <= limits.rawFileBytes, 'raw-file-bound')
    need(hash(file.sha256) && hash(file.rawSha256), 'file-hash-required')
    if (file.encoding === 'identity') need(file.length === file.rawLength && file.sha256 === file.rawSha256, 'identity-record-mismatch')
    compressedTotal += file.length; rawTotal += file.rawLength
    need(compressedTotal <= limits.compressedTotalBytes && rawTotal <= limits.rawTotalBytes, 'bundle-total-bound')
    Object.freeze(file)
  }
  disjoint(['manifest.json', ...manifest.files.map(file => file.path)], 'input-path-collision')
  disjoint(manifest.files.map(file => file.output), 'output-path-collision')
  Object.freeze(manifest.files); Object.freeze(manifest)
  return { manifest, limits }
}
// Consumes already captured bytes. A production caller must establish the
// physical lease separately; no callback can manufacture native lease evidence.
function decoderNode(value) {
  keys(value, 'path,sha256', 'decoder-node-shape')
  need(typeof value.path === 'string' && path.isAbsolute(value.path) && !value.path.includes('\0') && hash(value.sha256), 'decoder-node-shape')
  return Object.freeze({ path: value.path, sha256: value.sha256 })
}
function boundNodeBytes(binding) {
  const node = decoderNode(binding)
  const bytes = readFile(node.path, NODE_MAX_BYTES)
  need(sha(bytes) === node.sha256, 'decoder-node-changed')
  return node
}
function defaultNodeBinding() {
  need(process.release?.name === 'node' && !process.versions?.bun && !process.versions?.electron, 'decoder-node-required')
  const bytes = readFile(process.execPath, NODE_MAX_BYTES)
  return Object.freeze({ path: process.execPath, sha256: sha(bytes) })
}
function captureBytes(manifestBytes, records, expectedSha, limitOptions, nodeBinding) {
  need(Buffer.isBuffer(manifestBytes), 'manifest-bytes-required')
  need(manifestBytes.length <= limitsFor(limitOptions).manifestBytes, 'manifest-bound')
  const ownedManifest = Buffer.from(manifestBytes)
  const { manifest, limits } = parseManifest(ownedManifest, expectedSha, limitOptions)
  need(Array.isArray(records) && records.length === manifest.files.length, 'closed-inventory')
  const captured = new Map()
  for (let index = 0; index < records.length; index++) {
    const record = records[index], file = manifest.files[index]
    keys(record, 'path,bytes', 'capture-record-shape')
    const inputPath = record.path, inputBytes = record.bytes
    need(inputPath === file.path && Buffer.isBuffer(inputBytes) && inputBytes.length === file.length, 'capture-file-bound')
    const bytes = Buffer.from(inputBytes)
    need(sha(bytes) === file.sha256, 'capture-file-digest')
    captured.set(file.path, bytes)
  }
  const capability = Object.freeze(Object.create(null))
  const decoderNodeBinding = nodeBinding === undefined ? defaultNodeBinding() : boundNodeBytes(nodeBinding)
  captures.set(capability, { manifest, manifestBytes: ownedManifest, expectedSha, limits, captured, decoderNode: decoderNodeBinding, busy: false })
  return capability
}
function physical(file, kind) {
  const stat = fs.lstatSync(file, { bigint: true })
  need(!stat.isSymbolicLink() && (kind === 'file' ? stat.isFile() && stat.nlink === 1n : stat.isDirectory()), 'physical-' + kind + '-required')
  return stat
}
function snapshotEqual(a, b) { return ['dev', 'ino', 'size', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]) }
function readFile(file, bound) {
  const before = physical(file, 'file'); need(before.size <= BigInt(bound), 'capture-read-bound')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    need(snapshotEqual(before, fs.fstatSync(fd, { bigint: true })), 'capture-open-race')
    const bytes = Buffer.alloc(Number(before.size)); let at = 0
    while (at < bytes.length) { const count = fs.readSync(fd, bytes, at, bytes.length - at, at); need(count > 0, 'capture-truncated'); at += count }
    need(fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) === 0, 'capture-grew')
    need(snapshotEqual(before, fs.fstatSync(fd, { bigint: true })) && snapshotEqual(before, physical(file, 'file')), 'capture-file-race')
    return bytes
  } finally { fs.closeSync(fd) }
}
function inventory(root, files, limits) {
  const required = new Set(['manifest.json', ...files.map(file => file.path)]), directories = new Set([''])
  for (const file of required) { const parts = file.split('/'); for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/')) }
  const seen = new Set(), seenDirectories = new Set(); let entries = 0
  function walk(relativePath) {
    const directory = path.join(root, relativePath); physical(directory, 'directory'); seenDirectories.add(relativePath)
    for (const name of fs.readdirSync(directory)) {
      need(++entries <= (limits.files + 1) * 128, 'inventory-entry-bound')
      const relativeName = relativePath ? relativePath + '/' + name : name
      need(relative(relativeName), 'inventory-path-refused')
      const stat = fs.lstatSync(path.join(root, relativeName))
      if (stat.isDirectory() && !stat.isSymbolicLink()) { need(directories.has(relativeName), 'extra-directory'); walk(relativeName) }
      else { physical(path.join(root, relativeName), 'file'); need(required.has(relativeName), 'extra-file'); seen.add(relativeName) }
    }
  }
  walk(''); need(seen.size === required.size && seenDirectories.size === directories.size, 'incomplete-inventory')
}
function captureDirectory(rootArgument, expectedSha, limitOptions) {
  need(process.platform !== 'win32', 'windows-native-held-capture-required')
  const limits = limitsFor(limitOptions), root = path.resolve(rootArgument)
  for (let cursor = root;; cursor = path.dirname(cursor)) { physical(cursor, 'directory'); if (cursor === path.parse(cursor).root) break }
  need(fs.realpathSync.native(root) === root, 'canonical-root-required')
  const rootBefore = physical(root, 'directory'), manifestBytes = readFile(path.join(root, 'manifest.json'), limits.manifestBytes)
  const { manifest } = parseManifest(manifestBytes, expectedSha, limits)
  inventory(root, manifest.files, limits)
  const records = manifest.files.map(file => ({ path: file.path, bytes: readFile(path.join(root, file.path), file.length) }))
  inventory(root, manifest.files, limits)
  need(snapshotEqual(rootBefore, physical(root, 'directory')), 'capture-root-race')
  return captureBytes(manifestBytes, records, expectedSha, limits)
}
function describe(capability) {
  const state = captures.get(capability); need(state, 'capture-capability-required')
  return JSON.parse(JSON.stringify({ manifestSha256: state.expectedSha, manifest: state.manifest, accepted: false }))
}
const CHILD = String.raw`
'use strict';
const zlib = require('node:zlib');
const compressed = Number(process.argv[1]), raw = Number(process.argv[2]);
let input = 0, output = 0, failed = false;
function fail() { if (failed) return; failed = true; process.exitCode = 1; process.stdin.destroy(); decoder.destroy(); process.stdout.destroy(); }
const decoder = zlib.createBrotliDecompress({ chunkSize: 16384, params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 0 } });
process.stdin.on('data', bytes => { input += bytes.length; if (input > compressed) fail(); });
process.stdin.on('error', fail); decoder.on('error', fail); process.stdout.on('error', fail);
decoder.on('data', bytes => { output += bytes.length; if (output > raw) { fail(); return; } if (!process.stdout.write(bytes)) decoder.pause(); });
process.stdout.on('drain', () => decoder.resume());
decoder.on('end', () => { if (input !== compressed || decoder.bytesWritten !== compressed || output !== raw) fail(); else process.stdout.end(); });
process.stdin.pipe(decoder);
`
async function decode(capability, filePath, options = {}) {
  need(options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every(key => ['deadlineMs', 'closeMs'].includes(key)), 'decode-options-refused')
  const deadlineMs = options.deadlineMs === undefined ? 15000 : options.deadlineMs, closeMs = options.closeMs === undefined ? 5000 : options.closeMs
  need(Number.isSafeInteger(deadlineMs) && deadlineMs >= 1 && deadlineMs <= 60000 && Number.isSafeInteger(closeMs) && closeMs >= 1 && closeMs <= 5000, 'decode-deadline-bound')
  const state = captures.get(capability); need(state && !state.busy, 'capture-busy-or-invalid')
  const file = state.manifest.files.find(file => file.path === filePath); need(file, 'file-not-captured')
  if (file.encoding === 'identity') return Buffer.from(state.captured.get(filePath))
  state.busy = true
  let child, timer, killTimer, settled = false, closed = false, problem = null, length = 0, stderrLength = 0
  const chunks = [], stderr = []; const digest = crypto.createHash('sha256')
  try {
    return await new Promise((resolve, reject) => {
      function finish(error, bytes) {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer)
        if (closed) state.busy = false
        if (error) { error.cleanupConfirmed = closed; error.stderrBase64 = Buffer.concat(stderr).toString('base64'); reject(error) }
        else resolve(bytes)
      }
      function stop(error) {
        if (settled) return
        if (!problem) problem = error
        if (!child) { closed = true; finish(problem); return }
        try { child.kill('SIGKILL') } catch {}
        if (!killTimer) killTimer = setTimeout(() => {
          child.unref(); for (const stream of [child.stdin, child.stdout, child.stderr]) if (stream.unref) stream.unref()
          finish(problem || Error('decoder-close-unconfirmed'))
        }, closeMs)
      }
      const environment = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot } : { LANG: 'C', LC_ALL: 'C' }
      const node = boundNodeBytes(state.decoderNode)
      child = cp.spawn(node.path, ['--max-old-space-size=64', '-e', CHILD, String(file.length), String(file.rawLength)], { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
      timer = setTimeout(() => stop(Error('decoder-deadline')), deadlineMs)
      child.on('error', stop); child.stdin.on('error', stop)
      child.stdout.on('data', bytes => {
        if (problem) return
        length += bytes.length
        if (length > file.rawLength) { stop(Error('decoder-output-bound')); return }
        digest.update(bytes); chunks.push(bytes)
      })
      child.stderr.on('data', bytes => {
        const keep = Math.max(0, 1024 - stderrLength); if (keep) stderr.push(Buffer.from(bytes.subarray(0, keep)))
        stderrLength += bytes.length; stop(Error('decoder-stderr-refused'))
      })
      child.on('close', (code, signal) => {
        closed = true
        if (problem) { finish(problem); return }
        try {
          need(code === 0 && signal === null && stderrLength === 0, 'decoder-exit-refused')
          need(length === file.rawLength && digest.digest('hex') === file.rawSha256, 'decoded-content-mismatch')
          finish(null, Buffer.concat(chunks, length))
        } catch (error) { finish(error) }
      })
      child.stdin.end(state.captured.get(filePath))
    })
  } catch (error) { if (!child) state.busy = false; throw error }
}
module.exports = { DEFAULTS, canonical, sha, parseManifest, captureBytes, captureDirectory, describe, decode }
