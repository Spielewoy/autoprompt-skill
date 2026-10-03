'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { auditPrivatePermissions } = require('../../../agents/codex/workflow/safe-run-root.js')

const PINNED_VERSION = '1.0.13'
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_WRAPPER_BYTES = 128 * 1024
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024
const MACHINES = Object.freeze({ x64: 0x8664, arm64: 0xaa64 })

class GrokWindowsRuntimeError extends Error {
  constructor(code, message) { super(message); this.name = 'GrokWindowsRuntimeError'; this.code = code }
}
const fail = (code, message) => { throw new GrokWindowsRuntimeError(code, message) }
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function physicalDirectory(directory, label) {
  if (!absolute(directory)) fail('GROK_WINDOWS_RUNTIME_INVALID', `${label} is invalid`)
  let item, real
  try { item = fs.lstatSync(directory); real = fs.realpathSync.native(directory) } catch { fail('GROK_WINDOWS_RUNTIME_INVALID', `${label} is unavailable`) }
  if (!item.isDirectory() || item.isSymbolicLink() || !samePath(real, path.resolve(directory))) fail('GROK_WINDOWS_RUNTIME_INVALID', `${label} is not a canonical physical directory`)
  return real
}

function readBoundFile(file, maximumBytes, label) {
  if (!absolute(file)) fail('GROK_WINDOWS_RUNTIME_INVALID', `${label} path is invalid`)
  let descriptor
  try {
    const before = fs.lstatSync(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) fail('GROK_WINDOWS_RUNTIME_INVALID', `${label} is not a physical file`)
    const real = fs.realpathSync.native(file)
    if (!samePath(real, path.resolve(file))) fail('GROK_WINDOWS_RUNTIME_INVALID', `${label} path is not canonical`)
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size < 1n || opened.size > BigInt(maximumBytes)) fail('GROK_WINDOWS_RUNTIME_INVALID', `${label} is outside its file bound`)
    const bytes = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const namedAfter = fs.lstatSync(file, { bigint: true })
    const realAfter = fs.realpathSync.native(file)
    if (bytes.length !== Number(opened.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => opened[key] !== after[key]) ||
        !namedAfter.isFile() || namedAfter.isSymbolicLink() || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino ||
        namedAfter.size !== opened.size || !samePath(realAfter, real)) fail('GROK_WINDOWS_RUNTIME_CHANGED', `${label} changed while it was captured`)
    return Object.freeze({ path: real, bytes, size: bytes.length, sha256: sha256(bytes), identity: Object.freeze({ dev: String(opened.dev), ino: String(opened.ino) }) })
  } catch (error) {
    if (error instanceof GrokWindowsRuntimeError) throw error
    fail('GROK_WINDOWS_RUNTIME_INVALID', `${label} could not be captured`)
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}

function manifest(binding, expectedName, architecture, platform) {
  let value
  try { value = JSON.parse(binding.bytes.toString('utf8')) } catch { fail('GROK_WINDOWS_RUNTIME_INVALID', 'Official Grok package manifest is invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== expectedName || value.version !== PINNED_VERSION) fail('GROK_WINDOWS_RUNTIME_INVALID', 'Official Grok package identity is not pinned')
  if (!platform) {
    if (!value.bin || value.bin.grok !== 'bin/grok' || value.optionalDependencies?.[`@xai-official/grok-win32-${architecture}`] !== PINNED_VERSION) fail('GROK_WINDOWS_RUNTIME_INVALID', 'Official Grok wrapper manifest is incompatible')
  } else if (!Array.isArray(value.os) || !value.os.includes('win32') || !Array.isArray(value.cpu) || !value.cpu.includes(architecture)) {
    fail('GROK_WINDOWS_RUNTIME_INVALID', 'Official Grok platform manifest does not match the requested Windows architecture')
  }
  return value
}

function parsePeArchitecture(bytes, expectedArchitecture) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > MAX_EXECUTABLE_BYTES || bytes.subarray(0, 2).toString('ascii') !== 'MZ') fail('GROK_WINDOWS_RUNTIME_INVALID', 'Grok payload is not a bounded PE executable')
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset < 0x40 || peOffset > bytes.length - 26 || bytes.subarray(peOffset, peOffset + 4).toString('binary') !== 'PE\0\0') fail('GROK_WINDOWS_RUNTIME_INVALID', 'Grok payload has no valid PE signature')
  const machine = bytes.readUInt16LE(peOffset + 4), sections = bytes.readUInt16LE(peOffset + 6)
  const optionalSize = bytes.readUInt16LE(peOffset + 20), characteristics = bytes.readUInt16LE(peOffset + 22)
  if (machine !== MACHINES[expectedArchitecture] || sections < 1 || sections > 96 || optionalSize < 112 || peOffset + 24 + optionalSize > bytes.length || !(characteristics & 0x0002) || bytes.readUInt16LE(peOffset + 24) !== 0x20b) fail('GROK_WINDOWS_RUNTIME_INVALID', 'Grok PE architecture or executable headers are invalid')
  return expectedArchitecture
}

function descriptorBody(source, output) {
  return {
    schemaVersion: 1, kind: 'grok-official-windows-runtime', packageVersion: PINNED_VERSION,
    architecture: source.architecture, wrapperManifest: source.wrapperManifest, wrapperEntrypoint: source.wrapperEntrypoint,
    platformManifest: source.platformManifest, compressedPayload: source.compressedPayload,
    executable: output,
  }
}

function bindProjection(binding) { return { path: binding.path, size: binding.size, sha256: binding.sha256, identity: binding.identity } }

function publishExclusive(file, bytes, mode) {
  const temporary = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined
    fs.linkSync(temporary, file)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function removeExactPublished(file, identity) {
  try {
    const item = fs.lstatSync(file, { bigint: true })
    if (!item.isFile() || item.isSymbolicLink() || String(item.dev) !== identity.dev || String(item.ino) !== identity.ino) return false
    fs.unlinkSync(file)
    return true
  } catch { return false }
}

function readDescriptor(file) {
  const bound = readBoundFile(file, 256 * 1024, 'Grok runtime descriptor')
  let value
  try { value = JSON.parse(bound.bytes.toString('utf8')) } catch { fail('GROK_WINDOWS_RUNTIME_REUSE_INVALID', 'Existing Grok runtime descriptor is invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !/^[a-f0-9]{64}$/.test(value.closureSha256 || '')) fail('GROK_WINDOWS_RUNTIME_REUSE_INVALID', 'Existing Grok runtime descriptor is invalid')
  const { closureSha256, ...body } = value
  if (sha256(Buffer.from(JSON.stringify(body))) !== closureSha256) fail('GROK_WINDOWS_RUNTIME_REUSE_INVALID', 'Existing Grok runtime descriptor checksum is invalid')
  return value
}

function materializeWindowsGrokRuntime(options = {}) {
  const architecture = options.architecture || process.arch
  if (!Object.hasOwn(MACHINES, architecture)) fail('GROK_WINDOWS_RUNTIME_INVALID', 'Grok Windows architecture is unsupported')
  const packageRoot = physicalDirectory(options.packageRoot, 'Official Grok wrapper package')
  const outputRoot = physicalDirectory(options.outputRoot, 'Grok runtime output root')
  try { auditPrivatePermissions(outputRoot, { recurse: true }) } catch { fail('GROK_WINDOWS_RUNTIME_INVALID', 'Grok runtime output root is not controller-private') }
  const relativeOutput = path.relative(packageRoot, outputRoot), relativePackage = path.relative(outputRoot, packageRoot)
  if (!relativeOutput || relativeOutput === '' || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput)) || (!relativePackage.startsWith(`..${path.sep}`) && relativePackage !== '..' && !path.isAbsolute(relativePackage))) fail('GROK_WINDOWS_RUNTIME_INVALID', 'Grok runtime output overlaps its package source')
  const wrapperManifest = readBoundFile(path.join(packageRoot, 'package.json'), MAX_MANIFEST_BYTES, 'Official Grok wrapper manifest')
  manifest(wrapperManifest, '@xai-official/grok', architecture, false)
  const wrapperEntrypoint = readBoundFile(path.join(packageRoot, 'bin', 'grok'), MAX_WRAPPER_BYTES, 'Official Grok wrapper entrypoint')
  if (!wrapperEntrypoint.bytes.subarray(0, 20).toString('utf8').startsWith('#!/usr/bin/env node')) fail('GROK_WINDOWS_RUNTIME_INVALID', 'Official Grok wrapper entrypoint is invalid')
  const scope = physicalDirectory(path.dirname(packageRoot), 'Official Grok package scope')
  const platformName = `grok-win32-${architecture}`
  const platformRoot = physicalDirectory(path.join(scope, platformName), 'Official Grok Windows platform package')
  const platformManifest = readBoundFile(path.join(platformRoot, 'package.json'), MAX_MANIFEST_BYTES, 'Official Grok platform manifest')
  manifest(platformManifest, `@xai-official/${platformName}`, architecture, true)
  const compressedPayload = readBoundFile(path.join(platformRoot, 'bin', 'grok.exe.br'), MAX_COMPRESSED_BYTES, 'Official Grok compressed payload')
  let executableBytes
  try { executableBytes = zlib.brotliDecompressSync(compressedPayload.bytes, { maxOutputLength: MAX_EXECUTABLE_BYTES }) } catch { fail('GROK_WINDOWS_RUNTIME_INVALID', 'Official Grok payload could not be decompressed within its bound') }
  parsePeArchitecture(executableBytes, architecture)
  const executablePath = path.join(outputRoot, `grok-${PINNED_VERSION}-${architecture}.exe`)
  const descriptorPath = path.join(outputRoot, `grok-${PINNED_VERSION}-${architecture}.runtime.json`)
  const source = { architecture, wrapperManifest: bindProjection(wrapperManifest), wrapperEntrypoint: bindProjection(wrapperEntrypoint), platformManifest: bindProjection(platformManifest), compressedPayload: bindProjection(compressedPayload) }
  if (!fs.existsSync(executablePath) && !fs.existsSync(descriptorPath)) {
    let publishedExecutable = null
    try {
      publishExclusive(executablePath, executableBytes, 0o700)
      const capturedOutput = readBoundFile(executablePath, MAX_EXECUTABLE_BYTES, 'Materialized Grok executable')
      publishedExecutable = capturedOutput.identity
      const output = bindProjection(capturedOutput)
      const body = descriptorBody(source, output)
      publishExclusive(descriptorPath, Buffer.from(`${JSON.stringify({ ...body, closureSha256: sha256(Buffer.from(JSON.stringify(body))) })}\n`), 0o600)
    } catch (error) {
      // Exact known output may be removed only before a descriptor has been
      // published; ambiguous or concurrent state is retained for inspection.
      if (publishedExecutable && !fs.existsSync(descriptorPath)) removeExactPublished(executablePath, publishedExecutable)
      throw error
    }
  }
  if (!fs.existsSync(executablePath) || !fs.existsSync(descriptorPath)) fail('GROK_WINDOWS_RUNTIME_REUSE_INVALID', 'Grok runtime publication is incomplete')
  const executable = readBoundFile(executablePath, MAX_EXECUTABLE_BYTES, 'Materialized Grok executable')
  parsePeArchitecture(executable.bytes, architecture)
  const expectedBody = descriptorBody(source, bindProjection(executable))
  const recorded = readDescriptor(descriptorPath)
  const expected = { ...expectedBody, closureSha256: sha256(Buffer.from(JSON.stringify(expectedBody))) }
  if (JSON.stringify(recorded) !== JSON.stringify(expected) || executable.sha256 !== sha256(executableBytes)) fail('GROK_WINDOWS_RUNTIME_REUSE_INVALID', 'Existing Grok runtime differs from its official source closure')
  return deepFreeze({ ...expected, descriptorPath })
}

module.exports = { GrokWindowsRuntimeError, PINNED_VERSION, MACHINES, MAX_EXECUTABLE_BYTES, parsePeArchitecture, materializeWindowsGrokRuntime }
