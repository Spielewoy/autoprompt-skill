'use strict'

// Strict offline reader for uv's Windows script trampoline. The trampoline
// chooses its interpreter from UV_PYTHON_PATH, not from __main__.py's shebang.
const crypto = require('node:crypto')

class HermesLauncherBindingError extends Error {
  constructor(message) { super(message); this.code = 'PROVIDER_IDENTITY_MISMATCH' }
}
function fail(message) { throw new HermesLauncherBindingError(message) }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function range(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length) fail(`Malformed uv launcher ${label}`)
  return bytes.subarray(offset, offset + length)
}
function u16(bytes, offset, label) { return range(bytes, offset, 2, label).readUInt16LE(0) }
function u32(bytes, offset, label) { return range(bytes, offset, 4, label).readUInt32LE(0) }
function parsePe(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > 64 * 1024 * 1024 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') fail('Hermes launcher is not a bounded PE executable')
  const pe = u32(bytes, 0x3c, 'PE offset')
  if (range(bytes, pe, 24, 'PE header').subarray(0, 4).toString('ascii') !== 'PE\0\0') fail('Hermes launcher has no PE signature')
  const machine = u16(bytes, pe + 4, 'machine')
  const sectionCount = u16(bytes, pe + 6, 'section count')
  const characteristics = u16(bytes, pe + 22, 'characteristics')
  const optionalSize = u16(bytes, pe + 20, 'optional header size')
  if (machine !== 0x8664 && machine !== 0xaa64) fail('Hermes launcher uses an unsupported PE architecture')
  if (!(characteristics & 0x0002) || sectionCount < 1 || sectionCount > 96 || optionalSize < 136) fail('Hermes launcher PE headers are invalid')
  const optional = pe + 24
  if (u16(bytes, optional, 'optional header magic') !== 0x20b) fail('Hermes launcher is not PE32+')
  const directoryCount = u32(bytes, optional + 108, 'data directory count')
  if (directoryCount < 3) fail('Hermes launcher has no resource directory')
  const resourceRva = u32(bytes, optional + 112 + 16, 'resource RVA')
  const resourceSize = u32(bytes, optional + 112 + 20, 'resource size')
  if (!resourceRva || !resourceSize || resourceSize > 16 * 1024 * 1024) fail('Hermes launcher resource directory is invalid')
  const sections = []
  const sectionStart = optional + optionalSize
  for (let index = 0; index < sectionCount; index++) {
    const offset = sectionStart + index * 40
    range(bytes, offset, 40, 'section table')
    const virtualSize = u32(bytes, offset + 8, 'section virtual size')
    const virtualAddress = u32(bytes, offset + 12, 'section virtual address')
    const rawSize = u32(bytes, offset + 16, 'section raw size')
    const rawOffset = u32(bytes, offset + 20, 'section raw offset')
    if (!rawSize || rawOffset > bytes.length - rawSize || !virtualAddress || !Math.max(virtualSize, rawSize)) fail('Hermes launcher has an invalid physical section')
    sections.push({ virtualAddress, size: Math.max(virtualSize, rawSize), rawOffset, rawSize })
  }
  for (let left = 0; left < sections.length; left++) for (let right = left + 1; right < sections.length; right++) {
    const a = sections[left], b = sections[right]
    if (a.rawOffset < b.rawOffset + b.rawSize && b.rawOffset < a.rawOffset + a.rawSize ||
        a.virtualAddress < b.virtualAddress + b.size && b.virtualAddress < a.virtualAddress + a.size) fail('Hermes launcher PE sections overlap')
  }
  const rvaOffset = (rva, length, label) => {
    const matches = sections.filter(section => rva >= section.virtualAddress && rva <= section.virtualAddress + section.size - length && rva - section.virtualAddress <= section.rawSize - length)
    if (matches.length !== 1) fail(`Hermes launcher ${label} is outside a unique physical PE section`)
    return matches[0].rawOffset + rva - matches[0].virtualAddress
  }
  const resourceBase = rvaOffset(resourceRva, resourceSize, 'resource directory')
  const resourceEnd = resourceBase + resourceSize
  const resourceOffset = (relative, length, label) => {
    if (!Number.isSafeInteger(relative) || relative < 0 || relative > resourceSize - length) fail(`Malformed uv launcher ${label}`)
    return resourceBase + relative
  }
  return { machine, rvaOffset, resourceBase, resourceSize, resourceOffset, resourceEnd }
}
function resourceEntries(bytes, pe, relative, label) {
  const offset = pe.resourceOffset(relative, 16, label)
  const named = u16(bytes, offset + 12, `${label} named count`)
  const ids = u16(bytes, offset + 14, `${label} id count`)
  const total = named + ids
  if (total < 1 || total > 128) fail(`Malformed uv launcher ${label}`)
  pe.resourceOffset(relative + 16, total * 8, `${label} entries`)
  return Array.from({ length: total }, (_, index) => {
    const entry = offset + 16 + index * 8
    const name = u32(bytes, entry, `${label} name`)
    const child = u32(bytes, entry + 4, `${label} child`)
    return { name, child }
  })
}
function resourceName(bytes, pe, relative) {
  const offset = pe.resourceOffset(relative, 2, 'resource name')
  const length = u16(bytes, offset, 'resource name length')
  const value = range(bytes, pe.resourceOffset(relative + 2, length * 2, 'resource name'), length * 2, 'resource name')
  const text = value.toString('utf16le')
  if (!text || text.includes('\0') || /[\r\n]/.test(text)) fail('Malformed uv launcher resource name')
  return text
}
function resourceData(bytes, pe, name) {
  const root = resourceEntries(bytes, pe, 0, 'resource root')
  const types = root.filter(entry => entry.name === 10 && (entry.child & 0x80000000) !== 0)
  if (types.length !== 1) fail('Hermes launcher has no unique RCDATA resource tree')
  const names = resourceEntries(bytes, pe, types[0].child & 0x7fffffff, 'RCDATA names')
  const matching = names.filter(entry => (entry.name & 0x80000000) !== 0 && resourceName(bytes, pe, entry.name & 0x7fffffff) === name && (entry.child & 0x80000000) !== 0)
  if (matching.length !== 1) fail(`Hermes launcher lacks unique ${name} metadata`)
  const languages = resourceEntries(bytes, pe, matching[0].child & 0x7fffffff, `${name} languages`)
  if (languages.length !== 1 || (languages[0].child & 0x80000000) !== 0) fail(`Hermes launcher ${name} metadata is locale-ambiguous`)
  const dataOffset = pe.resourceOffset(languages[0].child, 16, `${name} data entry`)
  const rva = u32(bytes, dataOffset, `${name} data RVA`)
  const size = u32(bytes, dataOffset + 4, `${name} data size`)
  if (size < 1 || size > 4 * 1024 * 1024) fail(`Hermes launcher ${name} data size is invalid`)
  const offset = pe.rvaOffset(rva, size, `${name} data`)
  return { bytes: range(bytes, offset, size, `${name} data`), offset }
}
function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
function parseScriptZip(bytes) {
  if (bytes.length < 22 || bytes.subarray(bytes.length - 22, bytes.length - 18).toString('binary') !== 'PK\x05\x06') fail('Hermes trampoline script resource lacks an exact ZIP end record')
  const end = bytes.length - 22
  if (u16(bytes, end + 4, 'ZIP disk') !== 0 || u16(bytes, end + 6, 'ZIP central disk') !== 0 || u16(bytes, end + 8, 'ZIP disk entry count') !== 1 || u16(bytes, end + 10, 'ZIP entry count') !== 1 || u16(bytes, end + 20, 'ZIP comment size') !== 0) fail('Hermes trampoline script ZIP is not a single local archive')
  const centralSize = u32(bytes, end + 12, 'ZIP central size'), central = u32(bytes, end + 16, 'ZIP central offset')
  if (central + centralSize !== end || centralSize < 46 || bytes.subarray(central, central + 4).toString('binary') !== 'PK\x01\x02') fail('Hermes trampoline script ZIP central directory is invalid')
  const flags = u16(bytes, central + 8, 'ZIP flags'), method = u16(bytes, central + 10, 'ZIP method')
  const crc = u32(bytes, central + 16, 'ZIP CRC'), compressed = u32(bytes, central + 20, 'ZIP compressed size'), uncompressed = u32(bytes, central + 24, 'ZIP uncompressed size')
  const filenameLength = u16(bytes, central + 28, 'ZIP filename size'), extraLength = u16(bytes, central + 30, 'ZIP central extra size'), commentLength = u16(bytes, central + 32, 'ZIP file comment size'), local = u32(bytes, central + 42, 'ZIP local offset')
  if (flags !== 0x0800 || method !== 0 || compressed !== uncompressed || central + 46 + filenameLength + extraLength + commentLength !== end) fail('Hermes trampoline script ZIP uses an unbound encoding')
  const filename = range(bytes, central + 46, filenameLength, 'ZIP filename').toString('utf8')
  if (filename !== '__main__.py' || bytes.subarray(local, local + 4).toString('binary') !== 'PK\x03\x04') fail('Hermes trampoline script ZIP has an unexpected entrypoint')
  const localFlags = u16(bytes, local + 6, 'ZIP local flags'), localMethod = u16(bytes, local + 8, 'ZIP local method'), localCrc = u32(bytes, local + 14, 'ZIP local CRC'), localCompressed = u32(bytes, local + 18, 'ZIP local compressed size'), localUncompressed = u32(bytes, local + 22, 'ZIP local uncompressed size'), localNameLength = u16(bytes, local + 26, 'ZIP local filename size'), localExtraLength = u16(bytes, local + 28, 'ZIP local extra size')
  if (localFlags !== flags || localMethod !== method || localCrc !== crc || localCompressed !== compressed || localUncompressed !== uncompressed || range(bytes, local + 30, localNameLength, 'ZIP local filename').toString('utf8') !== filename) fail('Hermes trampoline script ZIP local entry disagrees with central directory')
  const script = range(bytes, local + 30 + localNameLength + localExtraLength, compressed, 'ZIP script')
  if (local !== 0 || local + 30 + localNameLength + localExtraLength + compressed !== central || crc32(script) !== crc) fail('Hermes trampoline script ZIP payload is invalid')
  const text = script.toString('utf8')
  if (!text.startsWith('#!') || !text.includes('from hermes_cli.main import main') || !text.includes('sys.exit(main())')) fail('Hermes trampoline script lacks the expected Hermes entrypoint markers')
  return { bytes: Buffer.from(script), sha256: sha256(script) }
}
function windowsAbsolute(value) { return /^[A-Za-z]:\\(?:[^\\/:*?"<>|]+\\)*[^\\/:*?"<>|]+$/u.test(value) }
function parseHermesUvLauncher(bytes) {
  const pe = parsePe(bytes)
  const kind = resourceData(bytes, pe, 'UV_TRAMPOLINE_KIND').bytes
  if (kind.length !== 1 || kind[0] !== 1) fail('Hermes launcher is not a uv script trampoline')
  const pythonBytes = resourceData(bytes, pe, 'UV_PYTHON_PATH').bytes
  const pythonPath = pythonBytes.toString('utf8')
  if (!Buffer.from(pythonPath, 'utf8').equals(pythonBytes) || pythonPath.includes('\0') || /[\r\n]/.test(pythonPath) || !windowsAbsolute(pythonPath)) fail('Hermes launcher Python resource is not an exact absolute Windows path')
  const scriptResource = resourceData(bytes, pe, 'UV_SCRIPT_DATA')
  const starts = [], ends = []
  for (let offset = 0; offset < bytes.length; offset++) {
    if (bytes.subarray(offset, offset + 4).toString('binary') === 'PK\x03\x04') starts.push(offset)
    if (bytes.subarray(offset, offset + 4).toString('binary') === 'PK\x05\x06') ends.push(offset)
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] !== scriptResource.offset || ends[0] !== scriptResource.offset + scriptResource.bytes.length - 22) fail('Hermes launcher ZIP overlay does not exactly match UV_SCRIPT_DATA')
  const script = parseScriptZip(scriptResource.bytes)
  return Object.freeze({ schemaVersion: 1, kind: 'uv-script-trampoline', architecture: pe.machine === 0x8664 ? 'x64' : 'arm64', pythonPath, pythonPathSha256: sha256(pythonBytes), scriptSha256: script.sha256, scriptBytes: script.bytes.length, launcherSha256: sha256(bytes) })
}
module.exports = { HermesLauncherBindingError, parseHermesUvLauncher, crc32 }
