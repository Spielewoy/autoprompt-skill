'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  atomicWriteFile,
  canonicalStringify,
  digestRecord,
  exactKeys,
  fail,
  hashPattern,
  isoDate,
  nonEmpty,
  sha256,
} = require('./core.cjs')
const { normalizeEvidencePath } = require('./files.cjs')

const CHECKSUM_FILE = 'SHA256SUMS'
const SNAPSHOT_MANIFEST = 'snapshot-manifest.json'

function normalizeRelative(relative) {
  try { return normalizeEvidencePath(relative) } catch (error) { fail('SNAPSHOT_PATH_INVALID', `unsafe snapshot path: ${relative}`, { cause: error.code }) }
}

function walkFiles(root, options = {}) {
  const absolute = path.resolve(root)
  const files = []
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const stats = fs.lstatSync(filename)
      if (stats.isSymbolicLink()) fail('SNAPSHOT_PATH_INVALID', `snapshot source contains a link: ${relative}`)
      if (entry.isDirectory()) visit(filename, relative)
      else if (entry.isFile()) {
        if (!options.exclude || !options.exclude.has(relative)) files.push({ relative: normalizeRelative(relative), filename, bytes: stats.size, sha256: sha256(fs.readFileSync(filename)) })
      } else fail('SNAPSHOT_PATH_INVALID', `snapshot source contains a non-regular entry: ${relative}`)
    }
  }
  visit(absolute, '')
  return files
}

function writeChecksums(directory) {
  const files = walkFiles(directory, { exclude: new Set([CHECKSUM_FILE]) })
  const lines = files.map(file => `${file.sha256}  ${file.relative}`).join('\n')
  atomicWriteFile(path.join(directory, CHECKSUM_FILE), `${lines}${lines ? '\n' : ''}`)
  return files
}

function parseChecksums(directory) {
  const filename = path.join(directory, CHECKSUM_FILE)
  let source
  try { source = fs.readFileSync(filename, 'utf8') } catch (error) { fail('SNAPSHOT_CHECKSUM_MISSING', `missing ${CHECKSUM_FILE}`, { cause: error.code }) }
  if (source && !source.endsWith('\n')) fail('SNAPSHOT_CHECKSUM_INVALID', `${CHECKSUM_FILE} has an incomplete trailing line`)
  const entries = []
  const paths = new Set()
  for (const [index, line] of source.split('\n').entries()) {
    if (!line) continue
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match) fail('SNAPSHOT_CHECKSUM_INVALID', `invalid checksum line ${index + 1}`)
    const relative = normalizeRelative(match[2])
    if (relative === CHECKSUM_FILE || paths.has(relative)) fail('SNAPSHOT_CHECKSUM_INVALID', `duplicate or recursive checksum path: ${relative}`)
    paths.add(relative)
    entries.push({ sha256: match[1], relative })
  }
  return entries
}

function verifyChecksums(directory) {
  const declared = parseChecksums(directory)
  const actual = walkFiles(directory, { exclude: new Set([CHECKSUM_FILE]) })
  const byPath = new Map(actual.map(item => [item.relative, item]))
  if (declared.length !== actual.length) fail('SNAPSHOT_CHECKSUM_COVERAGE', 'checksum file does not cover every source byte', { declared: declared.length, actual: actual.length })
  for (const entry of declared) {
    const file = byPath.get(entry.relative)
    if (!file || file.sha256 !== entry.sha256) fail('SNAPSHOT_CHECKSUM_MISMATCH', `checksum mismatch: ${entry.relative}`)
  }
  return { valid: true, files: actual }
}

function treeFingerprint(files) {
  return sha256(canonicalStringify(files.map(file => ({ relative: file.relative, sha256: file.sha256, bytes: file.bytes }))))
}

function copyFresh(source, destination) {
  fs.mkdirSync(destination, { mode: 0o700 })
  for (const file of walkFiles(source)) {
    const output = path.join(destination, ...file.relative.split('/'))
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
    fs.copyFileSync(file.filename, output, fs.constants.COPYFILE_EXCL)
    try { fs.chmodSync(output, 0o600) } catch {}
  }
}

function writeSnapshotManifest(stage, metadata) {
  const files = walkFiles(stage, { exclude: new Set([SNAPSHOT_MANIFEST]) }).map(file => ({ path: file.relative, sha256: file.sha256, bytes: file.bytes }))
  const unsigned = { schemaVersion: 'benchmark-snapshot.v2', ...metadata, files }
  const record = { ...unsigned, digest: digestRecord(unsigned) }
  atomicWriteFile(path.join(stage, SNAPSHOT_MANIFEST), `${canonicalStringify(record)}\n`)
  return record
}

function verifySnapshot(snapshotPath) {
  const filename = path.join(snapshotPath, SNAPSHOT_MANIFEST)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) { fail('SNAPSHOT_MANIFEST_INVALID', 'cannot read snapshot manifest', { cause: error.message }) }
  exactKeys(manifest, ['schemaVersion', 'snapshotId', 'manifestDigest', 'observedAt', 'sourceState', 'sourcePreHash', 'sourcePostHash', 'provenance', 'files', 'digest'], 'SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest')
  if (manifest.schemaVersion !== 'benchmark-snapshot.v2' || !hashPattern(manifest.digest) || manifest.digest !== digestRecord(manifest, ['digest'])) fail('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest digest is invalid')
  nonEmpty(manifest.snapshotId, 'SNAPSHOT_MANIFEST_INVALID', 'snapshotId')
  isoDate(manifest.observedAt, 'SNAPSHOT_MANIFEST_INVALID', 'observedAt')
  if (!hashPattern(manifest.manifestDigest) || !hashPattern(manifest.sourcePreHash) || manifest.sourcePreHash !== manifest.sourcePostHash || manifest.provenance !== 'immutable-snapshot' || !['TERMINAL', 'PAUSED'].includes(manifest.sourceState)) fail('SNAPSHOT_MANIFEST_INVALID', 'snapshot provenance or stable hashes are invalid')
  if (!Array.isArray(manifest.files) || !manifest.files.length) fail('SNAPSHOT_MANIFEST_INVALID', 'snapshot file manifest is required')
  const paths = new Set()
  for (const file of manifest.files) {
    exactKeys(file, ['path', 'sha256', 'bytes'], 'SNAPSHOT_MANIFEST_INVALID', 'snapshot file')
    const relative = normalizeRelative(file.path)
    if (paths.has(relative) || !hashPattern(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('SNAPSHOT_MANIFEST_INVALID', `invalid snapshot file: ${file.path}`)
    paths.add(relative)
  }
  const actual = walkFiles(snapshotPath, { exclude: new Set([SNAPSHOT_MANIFEST]) }).map(file => ({ path: file.relative, sha256: file.sha256, bytes: file.bytes }))
  if (canonicalStringify(actual) !== canonicalStringify(manifest.files)) fail('SNAPSHOT_CHECKSUM_MISMATCH', 'immutable snapshot bytes differ from its manifest')
  return { valid: true, manifest }
}

function promoteSnapshot(options) {
  if (!options || !['TERMINAL', 'PAUSED'].includes(options.sourceState)) fail('SNAPSHOT_SOURCE_NOT_STABLE', 'snapshot source must be terminal or explicitly paused')
  if (typeof options.snapshotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(options.snapshotId)) fail('SNAPSHOT_ID_INVALID', 'snapshotId is invalid')
  if (!hashPattern(options.manifestDigest)) fail('SNAPSHOT_MANIFEST_INVALID', 'manifestDigest is required')
  isoDate(options.observedAt, 'SNAPSHOT_MANIFEST_INVALID', 'observedAt')
  const source = path.resolve(options.sourceDir)
  const store = path.resolve(options.storeDir)
  verifyChecksums(source)
  const preFiles = walkFiles(source)
  const preHash = treeFingerprint(preFiles)
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })
  const snapshots = path.join(store, 'snapshots')
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 })
  const destination = path.join(snapshots, options.snapshotId)
  if (fs.existsSync(destination)) fail('SNAPSHOT_EXISTS', `snapshot already exists: ${options.snapshotId}`)
  const stage = path.join(snapshots, `.${options.snapshotId}.${crypto.randomBytes(8).toString('hex')}.staging`)
  try {
    copyFresh(source, stage)
    if (typeof options.afterCopy === 'function') options.afterCopy()
    const postFiles = walkFiles(source)
    const postHash = treeFingerprint(postFiles)
    if (preHash !== postHash || canonicalStringify(preFiles.map(item => ({ relative: item.relative, sha256: item.sha256, bytes: item.bytes }))) !== canonicalStringify(postFiles.map(item => ({ relative: item.relative, sha256: item.sha256, bytes: item.bytes })))) {
      fail('SNAPSHOT_SOURCE_CHANGED', 'snapshot source changed between pre/post stable hashes', { preHash, postHash })
    }
    verifyChecksums(stage)
    const snapshotManifest = writeSnapshotManifest(stage, {
      snapshotId: options.snapshotId,
      manifestDigest: options.manifestDigest,
      observedAt: options.observedAt,
      sourceState: options.sourceState,
      sourcePreHash: preHash,
      sourcePostHash: postHash,
      provenance: 'immutable-snapshot',
    })
    verifySnapshot(stage)
    fs.renameSync(stage, destination)
    const pointer = { schemaVersion: 'benchmark-snapshot-pointer.v2', snapshotId: options.snapshotId, snapshotDigest: snapshotManifest.digest, observedAt: options.observedAt }
    atomicWriteFile(path.join(store, 'current.json'), `${canonicalStringify(pointer)}\n`)
    return { snapshotPath: destination, snapshotManifest, pointer, promotion: { from: stage, to: destination, currentPointer: path.join(store, 'current.json') } }
  } catch (error) {
    try { fs.rmSync(stage, { recursive: true, force: true }) } catch {}
    throw error
  }
}

module.exports = {
  CHECKSUM_FILE,
  SNAPSHOT_MANIFEST,
  promoteSnapshot,
  verifyChecksums,
  verifySnapshot,
  walkFiles,
  writeChecksums,
}
