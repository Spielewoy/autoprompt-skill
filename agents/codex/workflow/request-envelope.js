'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  FILE_MODE,
  RunRecordError,
  ensureDirectoryNoFollow,
  inspectPathNoFollow,
  readFileNoFollow,
  pathIsInside,
  withOwnedLock,
} = require('./safe-run-root')

const SCHEMA_VERSION = '2.0.0'
const ENVELOPE_SCHEMA = SCHEMA_VERSION
const DEFAULT_OBJECT_THRESHOLD_BYTES = 64 * 1024
const ENVELOPE_FILE = 'envelope.jsonl'
const DIGEST_FILE = 'envelope.sha256'
const PRIVACY_FILE = 'privacy.json'
const OBJECTS_DIRECTORY = path.join('objects', 'sha256')
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const SECRET_SCAN_CHUNK_BYTES = 64 * 1024
const SECRET_SCAN_OVERLAP_BYTES = 512
const SECRET_PATTERNS = Object.freeze([
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gi],
  ['authorization', /(?:^|[^A-Za-z0-9_]|\\[nrt])authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?[A-Za-z0-9._~+\/-]{8,}/gi],
  ['credential-field', /(?:^|[^A-Za-z0-9_]|\\[nrt])(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{6,}/gi],
  ['provider-token', /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/gi],
])

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $binary_base64: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(canonicalize)
  const output = {}
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) output[key] = canonicalize(value[key])
  return output
}

function stableStringify(value) { return JSON.stringify(canonicalize(value)) }

function scanLikelySecrets(input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const chunkBytes = Number.isSafeInteger(options.chunkBytes) && options.chunkBytes > 0 ? options.chunkBytes : SECRET_SCAN_CHUNK_BYTES
  const overlapBytes = Number.isSafeInteger(options.overlapBytes) && options.overlapBytes >= 64 ? options.overlapBytes : SECRET_SCAN_OVERLAP_BYTES
  const categories = new Set()
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const start = Math.max(0, offset - overlapBytes)
    const end = Math.min(bytes.length, offset + chunkBytes + overlapBytes)
    const window = bytes.subarray(start, end).toString('latin1')
    for (const [category, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(window)) categories.add(category)
    }
  }
  return Object.freeze({ sensitive: categories.size > 0, categories: Object.freeze([...categories].sort()), scannedBytes: bytes.length })
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || Buffer.isBuffer(value) || value instanceof Uint8Array) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function readRequired(filename) {
  const bytes = readFileNoFollow(filename)
  if (bytes === null) {
    const error = new Error(`Missing file: ${filename}`)
    error.code = 'ENOENT'
    throw error
  }
  return bytes
}

function assertDestinationNotHardLinked(filename) {
  try {
    const stats = fs.lstatSync(filename)
    if (stats.isSymbolicLink() || !stats.isFile() || Number(stats.nlink) !== 1) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Unsafe existing private file: ${filename}`, { nlink: Number(stats.nlink) })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function atomicWriteFile(filename, bytes) {
  assertDestinationNotHardLinked(filename)
  const parent = path.dirname(filename)
  inspectPathNoFollow(parent)
  const temporary = path.join(parent, `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let fd
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    assertDestinationNotHardLinked(filename)
    fs.renameSync(temporary, filename)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function appendAndSync(filename, bytes) {
  readRequired(filename) // no-follow and nlink=1 precondition before opening for append
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
  try {
    if (Number(fs.fstatSync(fd).nlink) !== 1) throw new RunRecordError('RUN_RECORD_UNSAFE', `Envelope became hard-linked before append: ${filename}`)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function withEnvelopeLock(requestDir, operation, options = {}) {
  return withOwnedLock(path.join(requestDir, '.envelope.lock'), operation, {
    recoveryDirectory: path.join(requestDir, 'recovered-locks'),
    staleAfterMs: options.staleLockMs,
    now: options.now,
  })
}

function objectFilename(objectsDir, digest) {
  if (!HASH_PATTERN.test(digest)) throw new RunRecordError('RUN_RECORD_FAILURE', `Invalid object digest: ${digest}`)
  const filename = path.join(objectsDir, digest)
  if (!pathIsInside(objectsDir, filename)) throw new RunRecordError('RUN_RECORD_UNSAFE', 'Request object escapes its store')
  return filename
}

function putContentObject(objectsDir, bytes, metadata = {}) {
  ensureDirectoryNoFollow(objectsDir, path.dirname(path.dirname(objectsDir)))
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const digest = sha256(buffer)
  const filename = objectFilename(objectsDir, digest)
  try {
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
    try {
      let offset = 0
      while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
      fs.fsyncSync(fd)
      if (Number(fs.fstatSync(fd).nlink) !== 1) throw new RunRecordError('RUN_RECORD_UNSAFE', `Request object became hard-linked: ${filename}`)
    } finally { fs.closeSync(fd) }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = readRequired(filename)
    if (existing.length !== buffer.length || sha256(existing) !== digest) throw new RunRecordError('RUN_RECORD_FAILURE', `Request object does not match its content address: ${filename}`)
  }
  const object = {
    objectId: metadata.objectId || `sha256:${digest}`,
    sha256: digest,
    byteLength: buffer.length,
    mediaType: metadata.mediaType || 'application/octet-stream',
    storagePath: `request/objects/sha256/${digest}`,
  }
  if (metadata.purpose !== undefined) object.purpose = String(metadata.purpose)
  if (metadata.derivedFromSha256 !== undefined) object.derivedFromSha256 = metadata.derivedFromSha256
  if (metadata.bindingRef !== undefined) object.bindingRef = String(metadata.bindingRef)
  if (metadata.derivation !== undefined) object.derivation = canonicalize(metadata.derivation)
  if (metadata.displayName !== undefined) object.displayName = String(metadata.displayName)
  if (metadata.sourceApplication !== undefined) object.sourceApplication = String(metadata.sourceApplication)
  if (metadata.sourceReference !== undefined) object.sourceReference = String(metadata.sourceReference)
  return deepFreeze(object)
}

function entryHash(entry) {
  const unsigned = { ...entry }
  delete unsigned.entryHash
  return sha256(Buffer.from(stableStringify(unsigned), 'utf8'))
}

function signEntry(entry) { return { ...entry, entryHash: entryHash(entry) } }

function rawBlockBytes(raw) {
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8')
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return Buffer.from(raw)
  if (raw && raw.exactBytes !== undefined) return Buffer.from(raw.exactBytes)
  if (raw && raw.exactBytesBase64 !== undefined) return Buffer.from(raw.exactBytesBase64, 'base64')
  // Structured blocks are persisted as the complete canonical block object. This
  // retains every field and metadata value instead of projecting an allowlist.
  return Buffer.from(stableStringify(raw === undefined ? null : raw), 'utf8')
}

function blockKind(raw) {
  const type = raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? String(raw.kind || raw.type || '') : ''
  if (type === 'application_reference' || type === 'app_reference' || type === 'application-reference') return 'application-reference'
  if (['attachment', 'file', 'image', 'audio', 'video', 'binary'].includes(type) || Buffer.isBuffer(raw)) return 'attachment'
  if (typeof raw === 'string' || type === 'text') return 'text'
  return 'structured'
}

function normalizeBlocks(turn, sequence, requestDir, options = {}) {
  let input = turn.blocks !== undefined ? turn.blocks : turn.content
  if (!Array.isArray(input)) input = [input]
  if (!input.length || input[0] === undefined) throw new RunRecordError('RUN_RECORD_FAILURE', 'A request message requires at least one exact content block')
  const threshold = Number.isSafeInteger(options.objectThresholdBytes) && options.objectThresholdBytes >= 0
    ? options.objectThresholdBytes : DEFAULT_OBJECT_THRESHOLD_BYTES
  return input.map((raw, index) => {
    const source = raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? raw : {}
    const kind = blockKind(raw)
    const bytes = rawBlockBytes(raw)
    const mediaType = String(source.mediaType || source.mime_type || source.mimeType || (kind === 'text' ? 'text/plain; charset=utf-8' : 'application/json'))
    const block = {
      blockId: String(source.blockId || source.block_id || source.id || `entry-${sequence}-block-${index + 1}`),
      kind,
      mediaType,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      exactBytesBase64: bytes.toString('base64'),
    }
    const readable = typeof raw === 'string' ? raw : typeof source.text === 'string' ? source.text : null
    if (readable !== null) block.readableText = readable
    if (kind === 'attachment' || bytes.length > threshold) {
      block.objectRef = putContentObject(path.join(requestDir, OBJECTS_DIRECTORY), bytes, {
        mediaType,
        purpose: kind === 'attachment' ? 'attachment' : 'message-content',
        derivedFromSha256: null,
        displayName: source.displayName || source.filename || source.name,
        sourceApplication: source.sourceApplication || source.application,
        sourceReference: source.sourceReference || source.uri || source.reference_id,
      })
    }
    return block
  })
}

function parseCompleteLines(bytes, filename) {
  if (bytes.length === 0) return []
  if (bytes.at(-1) !== 0x0a) throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', `Request envelope has an incomplete trailing record: ${filename}`, { recoverable: true })
  const lines = bytes.toString('utf8').split('\n'); lines.pop()
  return lines.map((line, index) => {
    try { return JSON.parse(line) } catch { throw new RunRecordError('RUN_RECORD_FAILURE', `Request envelope entry ${index} is not JSON`) }
  })
}

function validateObjectRef(ref) {
  const keys = ['objectId', 'sha256', 'byteLength', 'mediaType', 'storagePath', 'purpose', 'derivedFromSha256', 'bindingRef', 'derivation', 'displayName', 'sourceApplication', 'sourceReference']
  return ref && typeof ref === 'object' && Object.keys(ref).every(key => keys.includes(key)) && typeof ref.objectId === 'string' &&
    HASH_PATTERN.test(ref.sha256 || '') && Number.isSafeInteger(ref.byteLength) && ref.byteLength >= 0 && typeof ref.mediaType === 'string' &&
    ref.storagePath === `request/objects/sha256/${ref.sha256}` &&
    (ref.purpose === undefined || ['exact-invocation', 'parsed-controls', 'canonical-request', 'message-content', 'attachment'].includes(ref.purpose)) &&
    (ref.derivedFromSha256 === undefined || ref.derivedFromSha256 === null || HASH_PATTERN.test(ref.derivedFromSha256)) &&
    (ref.bindingRef === undefined || /^(?:exact-invocation|parsed-controls|canonical-request):[a-f0-9]{64}$/.test(ref.bindingRef)) &&
    (ref.derivation === undefined || (ref.derivation && typeof ref.derivation === 'object' &&
      Object.keys(ref.derivation).every(key => ['method', 'sourceRole', 'sourceSha256'].includes(key)) &&
      ['captured-exact-bytes', 'parse-controls-v2', 'canonicalize-request-v2'].includes(ref.derivation.method) &&
      (ref.derivation.sourceRole === null || ref.derivation.sourceRole === 'exact-invocation') &&
      (ref.derivation.sourceSha256 === null || HASH_PATTERN.test(ref.derivation.sourceSha256 || ''))))
}

function validateHeaderObjectRefs(entry) {
  const exact = entry.exactInvocationObject
  const parsed = entry.parsedControlsObject
  const canonical = entry.canonicalRequestObject
  if (![exact, parsed, canonical].every(validateObjectRef)) return false
  if (exact.objectId !== `exact-invocation:${exact.sha256}` || exact.bindingRef !== `exact-invocation:${exact.sha256}` ||
      exact.purpose !== 'exact-invocation' || exact.derivedFromSha256 !== null ||
      stableStringify(exact.derivation) !== stableStringify({ method: 'captured-exact-bytes', sourceRole: null, sourceSha256: null }) ||
      parsed.objectId !== `parsed-controls:${parsed.sha256}` || parsed.bindingRef !== `parsed-controls:${parsed.sha256}` ||
      parsed.purpose !== 'parsed-controls' || parsed.derivedFromSha256 !== exact.sha256 ||
      stableStringify(parsed.derivation) !== stableStringify({ method: 'parse-controls-v2', sourceRole: 'exact-invocation', sourceSha256: exact.sha256 }) ||
      canonical.objectId !== `canonical-request:${canonical.sha256}` || canonical.bindingRef !== `canonical-request:${canonical.sha256}` ||
      canonical.purpose !== 'canonical-request' || canonical.derivedFromSha256 !== exact.sha256 ||
      stableStringify(canonical.derivation) !== stableStringify({ method: 'canonicalize-request-v2', sourceRole: 'exact-invocation', sourceSha256: exact.sha256 })) return false
  return new Set([exact.objectId, parsed.objectId, canonical.objectId]).size === 3 &&
    new Set([exact.purpose, parsed.purpose, canonical.purpose]).size === 3
}

function validateEntryShape(entry, index, runId, previous) {
  const baseKeys = ['schemaVersion', 'entryType', 'runId', 'sequence', 'previousEntryHash', 'entryHash', 'recordedAt']
  if (entry.schemaVersion !== SCHEMA_VERSION || entry.runId !== runId || entry.sequence !== index || entry.previousEntryHash !== previous ||
      entry.entryHash !== entryHash(entry) || Number.isNaN(Date.parse(entry.recordedAt))) return false
  let allowed
  if (entry.entryType === 'envelope-header') {
    allowed = [...baseKeys, 'envelopeId', 'exactInvocationObject', 'parsedControlsObject', 'canonicalRequestObject']
    if (index !== 0 || !validateHeaderObjectRefs(entry)) return false
  } else if (entry.entryType === 'user-message') {
    allowed = [...baseKeys, 'messageId', 'orderedContentBlocks']
    if (typeof entry.messageId !== 'string') return false
  } else if (entry.entryType === 'steering-edge') {
    allowed = [...baseKeys, 'steeringId', 'operation', 'targetMessageIds', 'orderedContentBlocks']
    if (typeof entry.steeringId !== 'string' || !['ADD', 'REPLACE'].includes(entry.operation) || !Array.isArray(entry.targetMessageIds) || new Set(entry.targetMessageIds).size !== entry.targetMessageIds.length) return false
  } else if (entry.entryType === 'object-registration') {
    allowed = [...baseKeys, 'object']
    return Object.keys(entry).every(key => allowed.includes(key)) && validateObjectRef(entry.object)
  } else return false
  if (!Object.keys(entry).every(key => allowed.includes(key))) return false
  if (entry.entryType !== 'envelope-header') {
    if (!Array.isArray(entry.orderedContentBlocks) || !entry.orderedContentBlocks.length) return false
    const blockKeys = ['blockId', 'kind', 'mediaType', 'byteLength', 'sha256', 'exactBytesBase64', 'objectRef', 'readableText']
    for (const block of entry.orderedContentBlocks) {
      if (!block || !Object.keys(block).every(key => blockKeys.includes(key)) || !['text', 'structured', 'attachment', 'application-reference'].includes(block.kind)) return false
      const raw = Buffer.from(block.exactBytesBase64, 'base64')
      if (raw.toString('base64') !== block.exactBytesBase64 || raw.length !== block.byteLength || sha256(raw) !== block.sha256 || (block.objectRef && !validateObjectRef(block.objectRef))) return false
    }
  }
  return true
}

function blockSetHash(entries) {
  const blocks = entries.flatMap(entry => (entry.orderedContentBlocks || []).map(block => ({ blockId: block.blockId, sha256: block.sha256 })))
  return sha256(Buffer.from(stableStringify(blocks), 'utf8'))
}

function buildPrivacyRecord(requestDir, entries, envelopeHash) {
  const findings = []
  let scannedBytes = 0
  const addFinding = (sequence, id, bytes) => {
    const scan = scanLikelySecrets(bytes)
    scannedBytes += scan.scannedBytes
    if (scan.sensitive) findings.push({ sequence, id, categories: scan.categories })
  }
  const header = entries[0]
  if (header && header.entryType === 'envelope-header') {
    for (const [id, ref] of [
      ['header:exact-invocation', header.exactInvocationObject],
      ['header:parsed-controls', header.parsedControlsObject],
      ['header:canonical-request', header.canonicalRequestObject],
    ]) addFinding(0, id, readRequired(objectFilename(path.join(requestDir, OBJECTS_DIRECTORY), ref.sha256)))
  }
  for (const entry of entries) {
    for (const [index, block] of (entry.orderedContentBlocks || []).entries()) {
      // Caller-controlled message/block/attachment identifiers may themselves
      // contain credentials. Privacy metadata uses only an envelope ordinal.
      addFinding(entry.sequence, `entry-${entry.sequence}-block-${index + 1}`, Buffer.from(block.exactBytesBase64, 'base64'))
    }
  }
  return {
    schemaVersion: '2.0.0',
    envelopeHash,
    headEntryHash: entries.at(-1)?.entryHash || null,
    sensitive: findings.length > 0,
    scannedBytes,
    findings,
  }
}

function writePrivacyRecord(requestDir, entries, envelopeHash) {
  const privacy = buildPrivacyRecord(requestDir, entries, envelopeHash)
  atomicWriteFile(path.join(requestDir, PRIVACY_FILE), `${stableStringify(privacy)}\n`)
  return privacy
}

function versionPointers(bytes, entries) {
  const lines = bytes.toString('utf8').split('\n').filter(Boolean)
  let prefix = ''
  return entries.map((entry, index) => {
    prefix += `${lines[index]}\n`
    return {
      schemaVersion: SCHEMA_VERSION,
      envelopeHash: sha256(Buffer.from(prefix, 'utf8')),
      headEntryHash: entry.entryHash,
      blockSetHash: blockSetHash(entries.slice(0, index + 1)),
      sequence: entry.sequence,
      entryCount: index + 1,
    }
  })
}

function verifyEntries(requestDir, bytes) {
  const entries = parseCompleteLines(bytes, path.join(requestDir, ENVELOPE_FILE))
  if (!entries.length || entries[0].entryType !== 'envelope-header' || !RUN_ID_PATTERN.test(entries[0].runId || '')) return { valid: false, reason: 'schema requires one valid envelope header at sequence 0' }
  let previous = null
  const ids = new Set()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!validateEntryShape(entry, index, entries[0].runId, previous)) return { valid: false, reason: `entry ${index} violates request-envelope-entry.schema.json or its hash chain` }
    previous = entry.entryHash
    const id = entry.messageId || entry.steeringId
    if (id && ids.has(id)) return { valid: false, reason: `duplicate request identity: ${id}` }
    if (id) ids.add(id)
    for (const block of entry.orderedContentBlocks || []) {
      if (ids.has(block.blockId)) return { valid: false, reason: `duplicate request identity: ${block.blockId}` }
      ids.add(block.blockId)
      if (block.objectRef) {
        const object = readRequired(objectFilename(path.join(requestDir, OBJECTS_DIRECTORY), block.objectRef.sha256))
        if (object.length !== block.objectRef.byteLength || sha256(object) !== block.objectRef.sha256) return { valid: false, reason: `request object failed integrity: ${block.objectRef.sha256}` }
      }
    }
    if (entry.entryType === 'envelope-header') {
      for (const ref of [entry.exactInvocationObject, entry.parsedControlsObject, entry.canonicalRequestObject]) {
        const object = readRequired(objectFilename(path.join(requestDir, OBJECTS_DIRECTORY), ref.sha256))
        if (object.length !== ref.byteLength || sha256(object) !== ref.sha256) return { valid: false, reason: `header object failed integrity: ${ref.sha256}` }
      }
    }
  }
  return { valid: true, entries, headEntryHash: previous, pointers: versionPointers(bytes, entries) }
}

function verifyRequestEnvelope(requestDir) {
  const absolute = path.resolve(requestDir)
  let bytes
  try { bytes = readRequired(path.join(absolute, ENVELOPE_FILE)) } catch (error) { return { valid: false, reason: error.message, code: error.code } }
  let verified
  try { verified = verifyEntries(absolute, bytes) } catch (error) { return { valid: false, reason: error.message, code: error.code } }
  if (!verified.valid) return verified
  const digest = sha256(bytes)
  let saved
  try { saved = readRequired(path.join(absolute, DIGEST_FILE)).toString('utf8').trim() } catch (error) { return { valid: false, reason: error.message, code: error.code } }
  if (saved !== digest) return { valid: false, reason: 'envelope digest does not match authoritative JSONL bytes', digest, savedDigest: saved }
  let privacy
  try {
    privacy = JSON.parse(readRequired(path.join(absolute, PRIVACY_FILE)).toString('utf8'))
    const expectedPrivacy = buildPrivacyRecord(absolute, verified.entries, digest)
    if (stableStringify(privacy) !== stableStringify(expectedPrivacy)) return { valid: false, reason: 'request privacy marker does not match the exact envelope bytes' }
  } catch (error) {
    return { valid: false, reason: `cannot validate request privacy marker: ${error.code || error.message}`, code: error.code }
  }
  return { ...verified, digest, privacy, records: verified.entries.length, currentPointer: verified.pointers.at(-1) }
}

function nowIso(options) { return String(options.recordedAt || (options.clock ? options.clock() : new Date().toISOString())) }

function createRequestEnvelope(requestDir, turns = [], options = {}) {
  const absolute = path.resolve(requestDir)
  ensureDirectoryNoFollow(absolute, path.dirname(absolute)); ensureDirectoryNoFollow(path.join(absolute, OBJECTS_DIRECTORY), absolute)
  const runId = options.runId || `run-${crypto.randomBytes(8).toString('hex')}`
  if (!RUN_ID_PATTERN.test(runId)) throw new RunRecordError('RUN_RECORD_FAILURE', `Request envelope runId violates schema: ${runId}`)
  const exactInvocation = Buffer.from(stableStringify(options.exactInvocation === undefined ? turns : options.exactInvocation), 'utf8')
  const controls = Buffer.from(stableStringify(options.parsedControls || {}), 'utf8')
  const canonicalRequest = Buffer.from(stableStringify(options.canonicalRequest === undefined ? turns : options.canonicalRequest), 'utf8')
  const exactInvocationSha256 = sha256(exactInvocation)
  const controlsSha256 = sha256(controls)
  const canonicalRequestSha256 = sha256(canonicalRequest)
  const header = signEntry({
    schemaVersion: SCHEMA_VERSION, entryType: 'envelope-header', runId, sequence: 0, previousEntryHash: null,
    recordedAt: nowIso(options), envelopeId: options.envelopeId || `envelope-${crypto.randomBytes(8).toString('hex')}`,
    exactInvocationObject: putContentObject(path.join(absolute, OBJECTS_DIRECTORY), exactInvocation, {
      mediaType: 'application/json', objectId: `exact-invocation:${exactInvocationSha256}`,
      purpose: 'exact-invocation', derivedFromSha256: null,
      bindingRef: `exact-invocation:${exactInvocationSha256}`,
      derivation: { method: 'captured-exact-bytes', sourceRole: null, sourceSha256: null },
    }),
    parsedControlsObject: putContentObject(path.join(absolute, OBJECTS_DIRECTORY), controls, {
      mediaType: 'application/json', objectId: `parsed-controls:${controlsSha256}`,
      purpose: 'parsed-controls', derivedFromSha256: exactInvocationSha256,
      bindingRef: `parsed-controls:${controlsSha256}`,
      derivation: { method: 'parse-controls-v2', sourceRole: 'exact-invocation', sourceSha256: exactInvocationSha256 },
    }),
    canonicalRequestObject: putContentObject(path.join(absolute, OBJECTS_DIRECTORY), canonicalRequest, {
      mediaType: 'application/json', objectId: `canonical-request:${canonicalRequestSha256}`,
      purpose: 'canonical-request', derivedFromSha256: exactInvocationSha256,
      bindingRef: `canonical-request:${canonicalRequestSha256}`,
      derivation: { method: 'canonicalize-request-v2', sourceRole: 'exact-invocation', sourceSha256: exactInvocationSha256 },
    }),
  })
  const envelopePath = path.join(absolute, ENVELOPE_FILE)
  try {
    const fd = fs.openSync(envelopePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
    try { fs.writeSync(fd, `${stableStringify(header)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch (error) {
    if (error.code === 'EEXIST') throw new RunRecordError('RUN_RECORD_FAILURE', `Request envelope already exists: ${envelopePath}`)
    throw error
  }
  atomicWriteFile(path.join(absolute, DIGEST_FILE), `${sha256(readRequired(envelopePath))}\n`)
  writePrivacyRecord(absolute, [header], sha256(readRequired(envelopePath)))
  const list = Array.isArray(turns) ? turns : [turns]
  for (let index = 0; index < list.length; index++) appendRequestTurn(absolute, list[index], { ...options, initialMessage: true })
  return loadRequestEnvelope(absolute)
}

function appendRequestTurn(requestDir, turn, options = {}) {
  const absolute = path.resolve(requestDir)
  if (!turn || typeof turn !== 'object' || Buffer.isBuffer(turn)) turn = { content: turn }
  return withEnvelopeLock(absolute, () => {
    const checked = verifyRequestEnvelope(absolute)
    if (!checked.valid) throw new RunRecordError(checked.code || 'RUN_RECORD_FAILURE', `Cannot append to request envelope: ${checked.reason}`)
    const entries = checked.entries
    const sequence = entries.length
    const existingIds = new Set(entries.flatMap(entry => [entry.messageId, entry.steeringId, ...(entry.orderedContentBlocks || []).map(block => block.blockId)].filter(Boolean)))
    const explicitOperation = turn.operation || turn.relation
    const isInitial = options.initialMessage === true && !explicitOperation
    const operation = String(explicitOperation || 'ADD').toUpperCase()
    if (!['ADD', 'REPLACE'].includes(operation)) throw new RunRecordError('RUN_RECORD_FAILURE', `Invalid steering operation: ${operation}`)
    const targets = turn.targetMessageIds || turn.replaces || []
    const targetMessageIds = Array.isArray(targets) ? targets.map(String) : [String(targets)]
    if (operation === 'REPLACE' && (!targetMessageIds.length || targetMessageIds.some(id => !entries.some(entry => entry.messageId === id || entry.steeringId === id)))) {
      throw new RunRecordError('RUN_RECORD_FAILURE', 'REPLACE steering must name existing message identities')
    }
    const blocks = normalizeBlocks(turn, sequence, absolute, options)
    const id = String(turn.messageId || turn.steeringId || turn.turn_id || turn.id || `${isInitial ? 'message' : 'steering'}-${sequence}`)
    if (existingIds.has(id) || blocks.some(block => existingIds.has(block.blockId)) || new Set(blocks.map(block => block.blockId)).size !== blocks.length) {
      throw new RunRecordError('RUN_RECORD_FAILURE', 'Message, steering, and block identities must be unique across the envelope')
    }
    const base = {
      schemaVersion: SCHEMA_VERSION, runId: entries[0].runId, sequence, previousEntryHash: entries.at(-1).entryHash,
      recordedAt: nowIso(options), orderedContentBlocks: blocks,
    }
    const entry = signEntry(isInitial
      ? { ...base, entryType: 'user-message', messageId: id }
      : { ...base, entryType: 'steering-edge', steeringId: id, operation, targetMessageIds })
    const line = Buffer.from(`${stableStringify(entry)}\n`, 'utf8')
    appendAndSync(path.join(absolute, ENVELOPE_FILE), line)
    const bytes = readRequired(path.join(absolute, ENVELOPE_FILE))
    const digest = sha256(bytes)
    atomicWriteFile(path.join(absolute, DIGEST_FILE), `${digest}\n`)
    writePrivacyRecord(absolute, entries.concat(entry), digest)
    return deepFreeze(entry)
  }, options)
}

function loadRequestEnvelope(requestDir, options = {}) {
  const absolute = path.resolve(requestDir)
  const checked = verifyRequestEnvelope(absolute)
  if (!checked.valid) throw new RunRecordError(checked.code || 'RUN_RECORD_FAILURE', `Request envelope verification failed: ${checked.reason}`)
  const expected = options.expectedPointer || {}
  const expectedHash = options.expectedHash || expected.envelopeHash
  const expectedHead = options.expectedHeadHash || expected.headEntryHash
  const expectedBlocks = options.expectedBlockSetHash || expected.blockSetHash
  const expectedVersion = options.expectedVersion ?? expected.sequence
  let pointer = checked.currentPointer
  if (expectedHash || expectedHead || expectedBlocks || expectedVersion !== undefined) {
    pointer = checked.pointers.find(item => (!expectedHash || item.envelopeHash === expectedHash) && (!expectedHead || item.headEntryHash === expectedHead) &&
      (!expectedBlocks || item.blockSetHash === expectedBlocks) && (expectedVersion === undefined || item.sequence === Number(expectedVersion)))
    if (!pointer) throw new RunRecordError('REQUEST_VERSION_MISMATCH', 'Expected request envelope hash/head/block-set/version does not identify a verified historical prefix')
  }
  const entries = checked.entries.slice(0, pointer.entryCount)
  const selectedPrivacy = buildPrivacyRecord(absolute, entries, pointer.envelopeHash)
  if (options.access === 'index-only' || options.access === 'bounded') {
    return deepFreeze({ schemaVersion: SCHEMA_VERSION, access: 'index-only', versionPointer: pointer, historicalVersions: checked.pointers, privacy: selectedPrivacy, entries: entries.map(entry => ({
      sequence: entry.sequence, entryType: entry.entryType, entryHash: entry.entryHash,
      id: entry.messageId || entry.steeringId || entry.envelopeId,
      blockPointers: (entry.orderedContentBlocks || []).map(block => ({ blockId: block.blockId, sha256: block.sha256, byteLength: block.byteLength, objectRef: block.objectRef || null })),
    })) })
  }
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION, access: 'full-raw', path: path.join(absolute, ENVELOPE_FILE), digestPath: path.join(absolute, DIGEST_FILE),
    digest: pointer.envelopeHash, headEntryHash: pointer.headEntryHash, headRecordSha256: pointer.headEntryHash,
    blockSetHash: pointer.blockSetHash, versionPointer: pointer, historicalVersions: checked.pointers, entries,
    records: entries.filter(entry => entry.entryType === 'user-message' || entry.entryType === 'steering-edge'), privacy: selectedPrivacy,
  })
}

function renderOriginalRequest(requestDir) {
  const loaded = loadRequestEnvelope(requestDir)
  const blocks = loaded.records.flatMap(entry => entry.orderedContentBlocks)
  if (blocks.length !== 1 || blocks[0].kind !== 'text') return null
  const raw = Buffer.from(blocks[0].exactBytesBase64, 'base64')
  if (raw.toString('utf8') !== blocks[0].readableText) return null
  atomicWriteFile(path.join(requestDir, 'original-request.txt'), raw)
  return raw.toString('utf8')
}

function recoverRequestEnvelope(requestDir, options = {}) {
  const absolute = path.resolve(requestDir)
  const envelopePath = path.join(absolute, ENVELOPE_FILE)
  let bytes = readRequired(envelopePath)
  if (bytes.length && bytes.at(-1) !== 0x0a) {
    const lastNewline = bytes.lastIndexOf(0x0a)
    const prefix = lastNewline >= 0 ? bytes.subarray(0, lastNewline + 1) : Buffer.alloc(0)
    const tail = bytes.subarray(lastNewline + 1)
    const prefixEntries = parseCompleteLines(prefix, envelopePath)
    let parsedTail
    try { parsedTail = JSON.parse(tail.toString('utf8')) } catch {}
    if (parsedTail && validateEntryShape(parsedTail, prefixEntries.length, prefixEntries[0]?.runId || parsedTail.runId, prefixEntries.at(-1)?.entryHash || null)) {
      bytes = Buffer.concat([bytes, Buffer.from('\n')])
      atomicWriteFile(envelopePath, bytes)
    } else {
      if (options.truncateIncompleteTail !== true) throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', 'Incomplete request tail is provably non-JSON; explicit truncateIncompleteTail authority is required', { recoverable: true, tailSha256: sha256(tail) })
      const evidenceDir = path.join(absolute, 'recovery', 'incomplete-envelope-tail')
      ensureDirectoryNoFollow(evidenceDir, absolute)
      atomicWriteFile(path.join(evidenceDir, `${sha256(tail)}.bin`), tail)
      atomicWriteFile(envelopePath, prefix)
      bytes = prefix
    }
  }
  const verified = verifyEntries(absolute, bytes)
  if (!verified.valid) throw new RunRecordError('RUN_RECORD_FAILURE', `Cannot recover request envelope: ${verified.reason}`)
  const digest = sha256(bytes)
  atomicWriteFile(path.join(absolute, DIGEST_FILE), `${digest}\n`)
  writePrivacyRecord(absolute, verified.entries, digest)
  return loadRequestEnvelope(absolute)
}

module.exports = {
  SCHEMA_VERSION, ENVELOPE_SCHEMA, ENVELOPE_FILE, DIGEST_FILE, PRIVACY_FILE, OBJECTS_DIRECTORY, DEFAULT_OBJECT_THRESHOLD_BYTES,
  SECRET_SCAN_CHUNK_BYTES, SECRET_SCAN_OVERLAP_BYTES, scanLikelySecrets,
  stableStringify, putContentObject, createRequestEnvelope, initializeRequestEnvelope: createRequestEnvelope,
  appendRequestTurn, appendTurn: appendRequestTurn, loadRequestEnvelope, verifyRequestEnvelope, recoverRequestEnvelope, renderOriginalRequest,
}
