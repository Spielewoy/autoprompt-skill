'use strict'

// Packaged-only loader for the Darwin coalition helper. This module never
// compiles, downloads, or discovers a helper from PATH or environment.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const HASH = /^[a-f0-9]{64}$/
const RUNTIME_ROOT = path.join(__dirname, 'darwin-coalition-runtime')
const MANIFEST = 'manifest.json'
const SOURCE_PATH = path.join(__dirname, 'darwin-coalition-helper.c')
const ARCHITECTURES = Object.freeze({ x64: Object.freeze({ file: 'coalition-helper-x64', cpuType: 0x01000007 }), arm64: Object.freeze({ file: 'coalition-helper-arm64', cpuType: 0x0100000c }) })
const MINIMUM_MACOS = Object.freeze([13, 5, 0])

function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function equalKeys(value, names) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...names].sort().join('\0') }
function versionFromPacked(value) { return [(value >>> 16) & 0xffff, (value >>> 8) & 0xff, value & 0xff] }
function compareVersion(left, right) { for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index]; return 0 }
function versionText(value) { return value.join('.') }

function readPhysical(file, label, maximum = 32 * 1024 * 1024) {
  let initial
  try { if (fs.realpathSync.native(file) !== file) fail('DARWIN_COALITION_UNAVAILABLE', `${label} has a symlinked ancestor`); initial = fs.lstatSync(file) } catch (error) { if (error?.code === 'DARWIN_COALITION_UNAVAILABLE') throw error; fail('DARWIN_COALITION_UNAVAILABLE', `${label} is missing`) }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || (process.platform !== 'win32' && (initial.mode & 0o022)) || initial.size < 1 || initial.size > maximum) fail('DARWIN_COALITION_UNAVAILABLE', `${label} is not one private physical file`)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size) fail('DARWIN_COALITION_UNAVAILABLE', `${label} changed while opening`)
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd), named = fs.lstatSync(file)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size || named.isSymbolicLink()) fail('DARWIN_COALITION_UNAVAILABLE', `${label} changed while reading`)
    return bytes
  } finally { fs.closeSync(fd) }
}
function physicalDirectory(directory, label) {
  let item
  try { item = fs.lstatSync(directory) } catch { fail('DARWIN_COALITION_UNAVAILABLE', `${label} is missing`) }
  if (!item.isDirectory() || item.isSymbolicLink() || item.nlink < 1 || (process.platform !== 'win32' && (item.mode & 0o022))) fail('DARWIN_COALITION_UNAVAILABLE', `${label} is not a private physical directory`)
  const resolved = fs.realpathSync.native(directory)
  if (resolved !== directory) fail('DARWIN_COALITION_UNAVAILABLE', `${label} has a symlinked ancestor`)
  return resolved
}
function child(root, name, label) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) fail('DARWIN_COALITION_UNAVAILABLE', `${label} has an unsafe payload name`)
  const value = path.join(root, name)
  if (path.dirname(value) !== root) fail('DARWIN_COALITION_UNAVAILABLE', `${label} escapes the packaged runtime`)
  return value
}
function parseMachO(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper is not a complete Mach-O executable')
  const magic = bytes.readUInt32LE(0)
  let read, little
  if (magic === 0xfeedfacf) { read = Buffer.prototype.readUInt32LE; little = true } else if (magic === 0xcffaedfe) { read = Buffer.prototype.readUInt32BE; little = false } else fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper is not a thin 64-bit Mach-O executable')
  const value = offset => read.call(bytes, offset)
  const cpuType = value(4), fileType = value(12), commands = value(16), commandsSize = value(20)
  if (fileType !== 2) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper Mach-O is not an executable')
  if (commands > 4096 || commandsSize > bytes.length - 32 || 32 + commandsSize > bytes.length) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper Mach-O load commands are invalid')
  let cursor = 32, minimum = null, minimumRecords = 0
  for (let index = 0; index < commands; index++) {
    if (cursor + 8 > 32 + commandsSize) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper Mach-O command is truncated')
    const command = value(cursor), size = value(cursor + 4)
    if (size < 8 || cursor + size > 32 + commandsSize) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper Mach-O command size is invalid')
    if (command === 0x32) {
      const tools = value(cursor + 20)
      if (size !== 24 + tools * 8 || cursor + 24 + tools * 8 > 32 + commandsSize || value(cursor + 8) !== 1) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper Mach-O build version is invalid')
      minimum = versionFromPacked(value(cursor + 12)); minimumRecords++
    }
    if (command === 0x24) {
      if (size !== 16) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper Mach-O legacy build version is invalid')
      minimum = versionFromPacked(value(cursor + 8)); minimumRecords++
    }
    cursor += size
  }
  if (cursor !== 32 + commandsSize || minimumRecords !== 1 || !minimum) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin helper Mach-O has no unique macOS build minimum')
  return Object.freeze({ cpuType, minimumMacOS: Object.freeze(minimum), littleEndian: little })
}
function parseManifest(bytes) {
  if (bytes.length > 65536) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition manifest exceeds its bound')
  let value
  try { value = JSON.parse(bytes) } catch { fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition manifest is not JSON') }
  if (!equalKeys(value, ['schemaVersion', 'kind', 'helperCSourceSha256', 'minimumMacOS', 'architectures', 'provenance']) || value.schemaVersion !== 1 || value.kind !== 'autoprompt-darwin-coalition-runtime' || !HASH.test(value.helperCSourceSha256 || '') || value.minimumMacOS !== '13.5') fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition manifest schema is invalid')
  if (!equalKeys(value.architectures, ['x64', 'arm64']) || !value.provenance || typeof value.provenance !== 'object' || Array.isArray(value.provenance) || !equalKeys(value.provenance, ['sourceRepository', 'sourceCommit', 'buildWorkflow', 'artifacts']) || typeof value.provenance.sourceRepository !== 'string' || !value.provenance.sourceRepository || Buffer.byteLength(value.provenance.sourceRepository) > 2048 || /[\r\n\0]/.test(value.provenance.sourceRepository) || !/^[a-f0-9]{40}$/.test(value.provenance.sourceCommit || '') || typeof value.provenance.buildWorkflow !== 'string' || !value.provenance.buildWorkflow || Buffer.byteLength(value.provenance.buildWorkflow) > 2048 || /[\r\n\0]/.test(value.provenance.buildWorkflow) || !equalKeys(value.provenance.artifacts, ['x64', 'arm64'])) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition manifest provenance is invalid')
  for (const arch of Object.keys(ARCHITECTURES)) {
    const artifact = value.provenance.artifacts[arch]
    if (!equalKeys(artifact, ['artifactId', 'sha256']) || !Number.isSafeInteger(artifact.artifactId) || artifact.artifactId < 1 || !HASH.test(artifact.sha256 || '')) fail('DARWIN_COALITION_UNAVAILABLE', `Darwin coalition manifest ${arch} build provenance is invalid`)
  }
  for (const [arch, expected] of Object.entries(ARCHITECTURES)) {
    const entry = value.architectures[arch]
    if (!equalKeys(entry, ['file', 'sha256', 'size']) || entry.file !== expected.file || !HASH.test(entry.sha256 || '') || !Number.isSafeInteger(entry.size) || entry.size < 32 || entry.size > 32 * 1024 * 1024) fail('DARWIN_COALITION_UNAVAILABLE', `Darwin coalition manifest ${arch} binary binding is invalid`)
  }
  return Object.freeze(value)
}
function validateDarwinCoalitionRuntime(runtimeRoot, architecture, sourcePath = SOURCE_PATH) {
  const root = physicalDirectory(runtimeRoot, 'Darwin coalition runtime')
  const manifestBytes = readPhysical(child(root, MANIFEST, 'manifest'), 'Darwin coalition manifest', 65536)
  const manifest = parseManifest(manifestBytes)
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition helper source path is invalid')
  const source = readPhysical(sourcePath, 'Darwin coalition helper source', 4 * 1024 * 1024)
  if (sha256(source) !== manifest.helperCSourceSha256) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition helper source binding drifted')
  const expected = ARCHITECTURES[architecture]
  if (!expected) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition helper has no supported architecture')
  let selected
  for (const [arch, expectedArch] of Object.entries(ARCHITECTURES)) {
    const entry = manifest.architectures[arch], helperPath = child(root, entry.file, 'helper')
    const helperBytes = readPhysical(helperPath, `Darwin coalition ${arch} helper`)
    if (helperBytes.length !== entry.size || sha256(helperBytes) !== entry.sha256) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition helper binding drifted')
    const mach = parseMachO(helperBytes)
    if (mach.cpuType !== expectedArch.cpuType) fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition helper Mach-O architecture differs from its payload path')
    if (compareVersion(mach.minimumMacOS, MINIMUM_MACOS) !== 0) fail('DARWIN_COALITION_UNAVAILABLE', `Darwin coalition helper build minimum must be macOS ${versionText(MINIMUM_MACOS)}`)
    if (arch === architecture) selected = Object.freeze({ path: helperPath, sha256: entry.sha256 })
  }
  return selected
}
function loadDarwinCoalitionHelper() {
  if (process.platform !== 'darwin') fail('DARWIN_COALITION_UNAVAILABLE', 'Darwin coalition helper requires native macOS')
  return validateDarwinCoalitionRuntime(RUNTIME_ROOT, process.arch)
}
function staticAvailability() {
  try {
    if (process.platform !== 'darwin') return Object.freeze({ available: false, code: 'DARWIN_COALITION_UNAVAILABLE', reason: 'native macOS is required' })
    return Object.freeze({ available: true, helper: loadDarwinCoalitionHelper() })
  } catch (error) { return Object.freeze({ available: false, code: error.code || 'DARWIN_COALITION_UNAVAILABLE', reason: error.message }) }
}

module.exports = { RUNTIME_ROOT, ARCHITECTURES, MINIMUM_MACOS, parseMachO, parseManifest, validateDarwinCoalitionRuntime, loadDarwinCoalitionHelper, staticAvailability }
