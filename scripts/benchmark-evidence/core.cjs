'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

class BenchmarkEvidenceError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BenchmarkEvidenceError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new BenchmarkEvidenceError(code, message, details)
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('NON_CANONICAL_VALUE', 'non-finite numbers are forbidden')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('NON_CANONICAL_VALUE', 'cycles are forbidden')
    seen.add(value)
    const result = value.map(item => canonicalize(item, seen))
    seen.delete(value)
    return result
  }
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date) {
    fail('NON_CANONICAL_VALUE', 'only JSON values are canonical')
  }
  if (seen.has(value)) fail('NON_CANONICAL_VALUE', 'cycles are forbidden')
  seen.add(value)
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue
    result[key] = canonicalize(value[key], seen)
  }
  seen.delete(value)
  return result
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex')
}

function digestRecord(record, omitted = []) {
  const copy = { ...record }
  for (const key of omitted) delete copy[key]
  return sha256(canonicalStringify(copy))
}

function exactKeys(value, allowed, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `${label} must be an object`)
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length) fail(code, `${label} has unknown fields`, { extras })
}

function nonEmpty(value, code, label) {
  if (typeof value !== 'string' || !value.trim()) fail(code, `${label} must be a non-empty string`)
  return value
}

function isoDate(value, code, label, options = {}) {
  if (options.nullable && value === null) return value
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code, `${label} must be a canonical ISO timestamp`)
  return value
}

function positiveInteger(value, code, label, options = {}) {
  const minimum = options.allowZero ? 0 : 1
  if (!Number.isSafeInteger(value) || value < minimum) fail(code, `${label} must be a safe integer >= ${minimum}`)
  return value
}

function hashPattern(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

let temporaryCounter = 0
function atomicWriteFile(filename, bytes) {
  const directory = path.dirname(filename)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  temporaryCounter += 1
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${temporaryCounter}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filename)
    try {
      const directoryDescriptor = fs.openSync(directory, 'r')
      try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
    } catch (error) {
      if (process.platform !== 'win32') throw error
    }
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function writeChecksummedJson(filename, record) {
  const unsigned = { ...record }
  delete unsigned.checksum
  const signed = canonicalize({ ...unsigned, checksum: digestRecord(unsigned) })
  atomicWriteFile(filename, `${canonicalStringify(signed)}\n`)
  return signed
}

function readChecksummedJson(filename, options = {}) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
    fail(options.code || 'CHECKSUM_RECORD_INVALID', `cannot read checksummed JSON: ${filename}`, { cause: error.message })
  }
  if (!hashPattern(parsed && parsed.checksum) || parsed.checksum !== digestRecord(parsed, ['checksum'])) {
    fail(options.code || 'CHECKSUM_MISMATCH', `checksum mismatch: ${filename}`)
  }
  return parsed
}

module.exports = {
  BenchmarkEvidenceError,
  atomicWriteFile,
  canonicalize,
  canonicalStringify,
  digestRecord,
  exactKeys,
  fail,
  hashPattern,
  isoDate,
  nonEmpty,
  positiveInteger,
  readChecksummedJson,
  sha256,
  writeChecksummedJson,
}
