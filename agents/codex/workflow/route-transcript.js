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
const { scanLikelySecrets } = require('./request-envelope')

const TRANSCRIPT_SCHEMA = 'autoprompt.route-transcript.v2'
const INDEX_SCHEMA = 'autoprompt.route-evidence-index.v2'
const TRANSCRIPT_FILE = 'transcript.jsonl'
const TRANSCRIPT_DIGEST_FILE = 'transcript.sha256'
const TRANSCRIPT_RENDER_FILE = 'transcript.md'
const EVIDENCE_INDEX_FILE = 'evidence-index.json'
const OBJECTS_DIRECTORY = path.join('objects', 'sha256')
const DEFAULT_RAW_OBJECT_THRESHOLD_BYTES = 64 * 1024
const DEFAULT_INDEX_LIMITS = Object.freeze({ maxBytes: 16 * 1024, maxTokens: 4096, maxSummaryBytes: 512 })

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $binary_base64: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(canonicalize)
  const result = {}
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) result[key] = canonicalize(value[key])
  return result
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value))
}

function readRequiredFileNoFollow(filename) {
  const bytes = readFileNoFollow(filename)
  if (bytes === null) {
    const error = new Error(`Missing file: ${filename}`)
    error.code = 'ENOENT'
    throw error
  }
  return bytes
}

function atomicWriteFile(filename, bytes) {
  try {
    const stats = fs.lstatSync(filename)
    if (stats.isSymbolicLink() || !stats.isFile() || Number(stats.nlink) !== 1) throw new RunRecordError('RUN_RECORD_UNSAFE', `Unsafe existing private file: ${filename}`, { nlink: Number(stats.nlink) })
  } catch (error) { if (error.code !== 'ENOENT') throw error }
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
    try {
      const stats = fs.lstatSync(filename)
      if (stats.isSymbolicLink() || !stats.isFile() || Number(stats.nlink) !== 1) throw new RunRecordError('RUN_RECORD_UNSAFE', `Unsafe existing private file: ${filename}`)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    fs.renameSync(temporary, filename)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function appendAndSync(filename, bytes) {
  readRequiredFileNoFollow(filename)
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
  try {
    if (Number(fs.fstatSync(fd).nlink) !== 1) throw new RunRecordError('RUN_RECORD_UNSAFE', `Transcript became hard-linked before append: ${filename}`)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function withTranscriptLock(routeDir, operation, options = {}) {
  const lock = path.join(routeDir, '.transcript.lock')
  return withOwnedLock(lock, operation, { recoveryDirectory: path.join(routeDir, 'recovered-locks'), staleAfterMs: options.staleLockMs, now: options.now })
}

function objectPath(objectsDir, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new RunRecordError('RUN_RECORD_FAILURE', `Invalid route object digest: ${digest}`)
  const filename = path.join(objectsDir, digest)
  if (!pathIsInside(objectsDir, filename)) throw new RunRecordError('RUN_RECORD_UNSAFE', 'Route object escapes its registered store')
  return filename
}

function putRawObject(objectsDir, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const digest = sha256(buffer)
  const filename = objectPath(objectsDir, digest)
  try {
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
    try {
      let offset = 0
      while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = readRequiredFileNoFollow(filename)
    if (existing.length !== buffer.length || sha256(existing) !== digest) {
      throw new RunRecordError('RUN_RECORD_FAILURE', `Route object does not match its content address: ${filename}`)
    }
  }
  return { algorithm: 'sha256', sha256: digest, bytes: buffer.length, path: `objects/sha256/${digest}` }
}

function parseJsonLines(bytes, filename) {
  if (bytes.length === 0) return []
  if (bytes[bytes.length - 1] !== 0x0a) throw new RunRecordError('RUN_RECORD_FAILURE', `Route transcript has an incomplete trailing event: ${filename}`)
  const lines = bytes.toString('utf8').split('\n')
  lines.pop()
  return lines.map((line, index) => {
    try { return JSON.parse(line) } catch { throw new RunRecordError('RUN_RECORD_FAILURE', `Route transcript event ${index + 1} is invalid JSON`) }
  })
}

function rawEventBytes(event, options) {
  if (options.rawBytes !== undefined) return Buffer.from(options.rawBytes)
  if (event && (Buffer.isBuffer(event.raw_bytes) || event.raw_bytes instanceof Uint8Array)) return Buffer.from(event.raw_bytes)
  return Buffer.from(stableStringify(event), 'utf8')
}

function typeOfEvent(event) {
  return String(event.type || event.kind || (event.tool ? 'tool_result' : event.role ? 'message' : 'event'))
}

function summaryText(event) {
  if (typeof event.summary === 'string') return event.summary
  for (const key of ['message', 'text', 'output', 'content', 'result']) {
    if (typeof event[key] === 'string') return event[key]
  }
  const labels = [typeOfEvent(event), event.role, event.tool || event.tool_name, event.command].filter(Boolean)
  return labels.join(' · ') || 'route event'
}

function utf8Prefix(text, maxBytes) {
  const source = Buffer.from(String(text), 'utf8')
  if (source.length <= maxBytes) return { text: source.toString('utf8'), bytes: source.length, originalBytes: source.length, truncated: false }
  let end = maxBytes
  while (end > 0 && (source[end] & 0xc0) === 0x80) end--
  return { text: source.subarray(0, end).toString('utf8'), bytes: end, originalBytes: source.length, truncated: true }
}

function normalizeLimits(options = {}) {
  const limits = options.limits || options
  const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback
  return {
    maxBytes: positive(limits.maxBytes ?? limits.max_bytes, DEFAULT_INDEX_LIMITS.maxBytes),
    maxTokens: positive(limits.maxTokens ?? limits.max_tokens, DEFAULT_INDEX_LIMITS.maxTokens),
    maxSummaryBytes: positive(limits.maxSummaryBytes ?? limits.max_summary_bytes, DEFAULT_INDEX_LIMITS.maxSummaryBytes),
  }
}

function buildEvidenceIndex(records, limits) {
  const entries = []
  let usedBytes = 0
  let usedTokens = 0
  const omittedIds = []
  for (const record of records) {
    const candidate = {
      event_id: record.event_id,
      sequence: record.sequence,
      type: record.event_type,
      record_sha256: record.record_sha256,
      raw_event: record.raw_event,
      summary: record.summary,
      sensitive: record.sensitive,
    }
    const bytes = Buffer.byteLength(stableStringify(candidate), 'utf8')
    const tokens = Math.ceil(Buffer.byteLength(candidate.summary.text, 'utf8') / 4)
    if (usedBytes + bytes > limits.maxBytes || usedTokens + tokens > limits.maxTokens) {
      omittedIds.push(record.event_id)
      continue
    }
    entries.push(candidate)
    usedBytes += bytes
    usedTokens += tokens
  }
  const index = {
    schema: INDEX_SCHEMA,
    authoritative_transcript: TRANSCRIPT_FILE,
    limits: { max_bytes: limits.maxBytes, max_tokens: limits.maxTokens, max_summary_bytes: limits.maxSummaryBytes },
    usage: { bytes: 0, estimated_tokens: usedTokens },
    total_event_count: records.length,
    included_event_count: entries.length,
    entries,
    truncation: {
      truncated: omittedIds.length > 0,
      omitted_event_count: omittedIds.length,
      omitted_event_ids_sha256: sha256(Buffer.from(omittedIds.join('\n'), 'utf8')),
      reason: omittedIds.length ? 'bounded evidence index byte/token limit; fetch named raw events from transcript.jsonl or objects/sha256' : null,
    },
  }
  function setExactSize() {
    let last = -1
    for (let attempt = 0; attempt < 8; attempt++) {
      const size = Buffer.byteLength(`${stableStringify(index)}\n`, 'utf8')
      index.usage.bytes = size
      if (size === last) return size
      last = size
    }
    return Buffer.byteLength(`${stableStringify(index)}\n`, 'utf8')
  }
  let framedBytes = setExactSize()
  while (framedBytes > limits.maxBytes && index.entries.length) {
    const removed = index.entries.pop()
    omittedIds.unshift(removed.event_id)
    index.included_event_count = index.entries.length
    index.truncation = {
      truncated: true,
      omitted_event_count: omittedIds.length,
      omitted_event_ids_sha256: sha256(Buffer.from(omittedIds.join('\n'), 'utf8')),
      reason: 'bounded evidence index byte/token limit; fetch named raw events from transcript.jsonl or objects/sha256',
    }
    index.usage.estimated_tokens = index.entries.reduce((sum, entry) => sum + Math.ceil(Buffer.byteLength(entry.summary.text, 'utf8') / 4), 0)
    framedBytes = setExactSize()
  }
  if (framedBytes > limits.maxBytes) {
    throw new RunRecordError('EVIDENCE_INDEX_LIMIT_TOO_SMALL', `Evidence index framing requires ${framedBytes} bytes but maxBytes is ${limits.maxBytes}`, { requiredBytes: framedBytes, maxBytes: limits.maxBytes })
  }
  return index
}

function renderTranscript(records, index) {
  const lines = [
    '# Route transcript (readable rendering)',
    '',
    '`transcript.jsonl` and its referenced `objects/sha256` bytes are authoritative. This rendering contains bounded summaries only.',
    '',
  ]
  for (const record of records) {
    lines.push(`## ${record.event_id} · ${record.event_type}`, '')
    lines.push(record.summary.text || '(empty event summary)', '')
    if (record.summary.truncated) {
      lines.push(`Summary omitted ${record.summary.original_bytes - record.summary.included_bytes} byte(s). Fetch event ${record.event_id}; raw SHA-256: \`${record.raw_event.sha256}\`.`, '')
    }
    if (record.raw_event.storage === 'object') {
      lines.push(`Raw event is stored at \`${record.raw_event.path}\` (${record.raw_event.bytes} bytes, SHA-256 \`${record.raw_event.sha256}\`); it is not reproduced here.`, '')
    }
    if (record.sensitive) lines.push('This event is marked as potentially sensitive and remains local.', '')
  }
  if (index.truncation.truncated) {
    lines.push('## Evidence-index omissions', '')
    lines.push(`${index.truncation.omitted_event_count} event(s) are absent from the bounded evidence index. The raw transcript still contains pointers for every event; omission is explicit and is not evidence loss.`, '')
  }
  return `${lines.join('\n')}\n`
}

function verifyRecord(record, sequence, previousHash) {
  if (record.schema !== TRANSCRIPT_SCHEMA || record.sequence !== sequence || record.previous_record_sha256 !== previousHash) return false
  const copy = { ...record }
  delete copy.record_sha256
  return record.record_sha256 === sha256(Buffer.from(stableStringify(copy), 'utf8'))
}

function verifyRouteTranscript(routeDir) {
  const absolute = path.resolve(routeDir)
  const transcriptPath = path.join(absolute, TRANSCRIPT_FILE)
  let bytes
  try { bytes = readRequiredFileNoFollow(transcriptPath) } catch (error) { return { valid: false, reason: `cannot read transcript: ${error.code}`, code: error.code, events: 0 } }
  let records
  try { records = parseJsonLines(bytes, transcriptPath) } catch (error) { return { valid: false, reason: error.message, events: 0 } }
  let previous = null
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!verifyRecord(record, index + 1, previous)) return { valid: false, reason: `event ${index + 1} failed its hash chain`, events: records.length }
    let rawForPrivacy
    if (record.raw_event.storage === 'object') {
      try {
        const raw = readRequiredFileNoFollow(objectPath(path.join(absolute, OBJECTS_DIRECTORY), record.raw_event.sha256))
        if (raw.length !== record.raw_event.bytes || sha256(raw) !== record.raw_event.sha256) return { valid: false, reason: `raw event object failed integrity: ${record.event_id}`, events: records.length }
        rawForPrivacy = raw
      } catch (error) { return { valid: false, reason: `cannot verify raw event ${record.event_id}: ${error.code}`, events: records.length } }
    } else {
      const inline = Buffer.from(stableStringify(record.event), 'utf8')
      if (inline.length !== record.raw_event.bytes || sha256(inline) !== record.raw_event.sha256) return { valid: false, reason: `inline raw event failed integrity: ${record.event_id}`, events: records.length }
      rawForPrivacy = inline
    }
    const sensitivity = scanLikelySecrets(rawForPrivacy)
    if (record.sensitive !== sensitivity.sensitive || stableStringify(record.sensitivity_categories || []) !== stableStringify(sensitivity.categories)) {
      return { valid: false, reason: `route-event privacy marker does not match exact raw bytes: ${record.event_id}`, events: records.length }
    }
    previous = record.record_sha256
  }
  const digest = sha256(bytes)
  let saved
  try { saved = readRequiredFileNoFollow(path.join(absolute, TRANSCRIPT_DIGEST_FILE)).toString('utf8').trim() } catch (error) { return { valid: false, reason: `cannot read transcript digest: ${error.code}`, events: records.length } }
  if (digest !== saved) return { valid: false, reason: 'transcript digest does not match authoritative JSONL bytes', digest, savedDigest: saved, events: records.length }
  let index
  try { index = JSON.parse(readRequiredFileNoFollow(path.join(absolute, EVIDENCE_INDEX_FILE)).toString('utf8')) } catch (error) { return { valid: false, reason: `cannot read evidence index: ${error.code}`, events: records.length } }
  if (index.total_event_count !== records.length || index.included_event_count + index.truncation.omitted_event_count !== records.length) {
    return { valid: false, reason: 'evidence index event counts do not reconcile with transcript', events: records.length }
  }
  const expectedIndex = buildEvidenceIndex(records, normalizeLimits(index.limits || {}))
  if (stableStringify(index) !== stableStringify(expectedIndex)) {
    return { valid: false, reason: 'evidence index content does not match the authoritative transcript and declared limits', events: records.length }
  }
  return { valid: true, digest, events: records.length, headRecordSha256: previous, index }
}

function createRouteTranscript(routeDir, options = {}) {
  const absolute = path.resolve(routeDir)
  ensureDirectoryNoFollow(absolute, path.dirname(absolute))
  ensureDirectoryNoFollow(path.join(absolute, OBJECTS_DIRECTORY), absolute)
  const transcriptPath = path.join(absolute, TRANSCRIPT_FILE)
  try {
    const fd = fs.openSync(transcriptPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new RunRecordError('RUN_RECORD_FAILURE', `Route transcript already exists: ${transcriptPath}`)
  }
  const limits = normalizeLimits(options)
  const index = buildEvidenceIndex([], limits)
  atomicWriteFile(path.join(absolute, TRANSCRIPT_DIGEST_FILE), `${sha256(Buffer.alloc(0))}\n`)
  atomicWriteFile(path.join(absolute, EVIDENCE_INDEX_FILE), `${stableStringify(index)}\n`)
  atomicWriteFile(path.join(absolute, TRANSCRIPT_RENDER_FILE), renderTranscript([], index))
  return { routeDir: absolute, transcriptPath, evidenceIndex: index }
}

function appendRouteEvent(routeDir, event, options = {}) {
  const absolute = path.resolve(routeDir)
  const normalizedEvent = canonicalize(event || {})
  return withTranscriptLock(absolute, () => {
    const verification = verifyRouteTranscript(absolute)
    if (!verification.valid) throw new RunRecordError(verification.code || 'RUN_RECORD_FAILURE', `Cannot append to invalid route transcript: ${verification.reason}`)
    const transcriptPath = path.join(absolute, TRANSCRIPT_FILE)
    const existingBytes = readRequiredFileNoFollow(transcriptPath)
    const records = parseJsonLines(existingBytes, transcriptPath)
    const sequence = records.length + 1
    const limits = normalizeLimits(options.limits || verification.index.limits || options)
    const threshold = Number.isSafeInteger(options.rawObjectThresholdBytes) ? options.rawObjectThresholdBytes : DEFAULT_RAW_OBJECT_THRESHOLD_BYTES
    const rawBytes = rawEventBytes(event || {}, options)
    const rawDigest = sha256(rawBytes)
    const hasProviderRawBytes = options.rawBytes !== undefined || (event && (Buffer.isBuffer(event.raw_bytes) || event.raw_bytes instanceof Uint8Array))
    const raw = rawBytes.length > threshold || options.forceObject === true || hasProviderRawBytes
      ? { ...putRawObject(path.join(absolute, OBJECTS_DIRECTORY), rawBytes), storage: 'object', mime_type: options.mimeType || 'application/json' }
      : { algorithm: 'sha256', sha256: rawDigest, bytes: rawBytes.length, storage: 'inline', mime_type: options.mimeType || 'application/json' }
    const summary = utf8Prefix(summaryText(event || {}), limits.maxSummaryBytes)
    const sensitivity = scanLikelySecrets(rawBytes)
    const eventId = event && (event.event_id || event.id) || `route-event-${sequence}`
    if (records.some(record => record.event_id === eventId)) throw new RunRecordError('RUN_RECORD_FAILURE', `Route event id is already present: ${eventId}`)
    const record = {
      schema: TRANSCRIPT_SCHEMA,
      sequence,
      event_id: eventId,
      event_type: typeOfEvent(event || {}),
      raw_event: raw,
      summary: { text: summary.text, included_bytes: summary.bytes, original_bytes: summary.originalBytes, truncated: summary.truncated },
      sensitive: sensitivity.sensitive,
      sensitivity_categories: sensitivity.categories,
      previous_record_sha256: verification.headRecordSha256 || null,
    }
    if (raw.storage === 'inline') record.event = normalizedEvent
    if (event && (event.occurred_at || event.occurredAt)) record.occurred_at = event.occurred_at || event.occurredAt
    record.record_sha256 = sha256(Buffer.from(stableStringify(record), 'utf8'))
    const line = Buffer.from(`${stableStringify(record)}\n`, 'utf8')
    appendAndSync(transcriptPath, line)
    const allRecords = records.concat(record)
    const newBytes = Buffer.concat([existingBytes, line])
    const index = buildEvidenceIndex(allRecords, limits)
    atomicWriteFile(path.join(absolute, TRANSCRIPT_DIGEST_FILE), `${sha256(newBytes)}\n`)
    atomicWriteFile(path.join(absolute, EVIDENCE_INDEX_FILE), `${stableStringify(index)}\n`)
    atomicWriteFile(path.join(absolute, TRANSCRIPT_RENDER_FILE), renderTranscript(allRecords, index))
    return Object.freeze({ record, evidenceIndex: index })
  }, options)
}

function readRawEvent(routeDir, eventId) {
  const transcriptPath = path.join(routeDir, TRANSCRIPT_FILE)
  const records = parseJsonLines(readRequiredFileNoFollow(transcriptPath), transcriptPath)
  const record = records.find(item => item.event_id === eventId)
  if (!record) throw new RunRecordError('RUN_RECORD_FAILURE', `Unknown route event id: ${eventId}`)
  if (record.raw_event.storage === 'object') return readRequiredFileNoFollow(objectPath(path.join(routeDir, OBJECTS_DIRECTORY), record.raw_event.sha256))
  return Buffer.from(stableStringify(record.event), 'utf8')
}

function loadRouteTranscript(routeDir, options = {}) {
  const verification = verifyRouteTranscript(routeDir)
  if (!verification.valid) throw new RunRecordError('RUN_RECORD_FAILURE', `Route transcript verification failed: ${verification.reason}`)
  if (options.access === 'index-only' || options.access === 'bounded') {
    return { access: 'index-only', digest: verification.digest, headRecordSha256: verification.headRecordSha256, evidenceIndex: verification.index }
  }
  const transcriptPath = path.join(routeDir, TRANSCRIPT_FILE)
  const records = parseJsonLines(readRequiredFileNoFollow(transcriptPath), transcriptPath)
  if (options.materializeRaw) {
    for (const record of records) record.raw_bytes = readRawEvent(routeDir, record.event_id)
  }
  return { access: 'full-raw', records, digest: verification.digest, headRecordSha256: verification.headRecordSha256, evidenceIndex: verification.index }
}

function recoverRouteTranscript(routeDir, options = {}) {
  const absolute = path.resolve(routeDir)
  const transcriptPath = path.join(absolute, TRANSCRIPT_FILE)
  let bytes = readRequiredFileNoFollow(transcriptPath)
  if (bytes.length && bytes.at(-1) !== 0x0a) {
    const lastNewline = bytes.lastIndexOf(0x0a)
    const prefix = lastNewline >= 0 ? bytes.subarray(0, lastNewline + 1) : Buffer.alloc(0)
    const tail = bytes.subarray(lastNewline + 1)
    const prefixRecords = parseJsonLines(prefix, transcriptPath)
    let tailRecord
    try { tailRecord = JSON.parse(tail.toString('utf8')) } catch {}
    if (tailRecord && verifyRecord(tailRecord, prefixRecords.length + 1, prefixRecords.at(-1)?.record_sha256 || null)) {
      bytes = Buffer.concat([bytes, Buffer.from('\n')])
      atomicWriteFile(transcriptPath, bytes)
    } else {
      if (options.truncateIncompleteTail !== true) throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', 'Incomplete transcript tail is provably non-JSON; explicit truncateIncompleteTail authority is required', { recoverable: true, tailSha256: sha256(tail) })
      const evidenceDir = path.join(absolute, 'recovery', 'incomplete-transcript-tail')
      ensureDirectoryNoFollow(evidenceDir, absolute)
      atomicWriteFile(path.join(evidenceDir, `${sha256(tail)}.bin`), tail)
      atomicWriteFile(transcriptPath, prefix)
      bytes = prefix
    }
  }
  const records = parseJsonLines(bytes, transcriptPath)
  let previous = null
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!verifyRecord(record, index + 1, previous)) {
      throw new RunRecordError('RUN_RECORD_FAILURE', `Cannot recover route transcript: event ${index + 1} failed its hash chain`)
    }
    let rawForPrivacy
    if (record.raw_event.storage === 'object') {
      const raw = readRequiredFileNoFollow(objectPath(path.join(absolute, OBJECTS_DIRECTORY), record.raw_event.sha256))
      if (raw.length !== record.raw_event.bytes || sha256(raw) !== record.raw_event.sha256) {
        throw new RunRecordError('RUN_RECORD_FAILURE', `Cannot recover route transcript: raw object failed integrity (${record.event_id})`)
      }
      rawForPrivacy = raw
    } else {
      const inline = Buffer.from(stableStringify(record.event), 'utf8')
      if (inline.length !== record.raw_event.bytes || sha256(inline) !== record.raw_event.sha256) {
        throw new RunRecordError('RUN_RECORD_FAILURE', `Cannot recover route transcript: inline event failed integrity (${record.event_id})`)
      }
      rawForPrivacy = inline
    }
    const sensitivity = scanLikelySecrets(rawForPrivacy)
    if (record.sensitive !== sensitivity.sensitive || stableStringify(record.sensitivity_categories || []) !== stableStringify(sensitivity.categories)) {
      throw new RunRecordError('RUN_RECORD_FAILURE', `Cannot recover route transcript: privacy marker mismatch (${record.event_id})`)
    }
    previous = record.record_sha256
  }
  let savedLimits = {}
  try { savedLimits = JSON.parse(readRequiredFileNoFollow(path.join(absolute, EVIDENCE_INDEX_FILE)).toString('utf8')).limits || {} } catch {}
  const limits = normalizeLimits(options.limits || savedLimits)
  const evidenceIndex = buildEvidenceIndex(records, limits)
  atomicWriteFile(path.join(absolute, TRANSCRIPT_DIGEST_FILE), `${sha256(bytes)}\n`)
  atomicWriteFile(path.join(absolute, EVIDENCE_INDEX_FILE), `${stableStringify(evidenceIndex)}\n`)
  atomicWriteFile(path.join(absolute, TRANSCRIPT_RENDER_FILE), renderTranscript(records, evidenceIndex))
  return loadRouteTranscript(absolute)
}

module.exports = {
  TRANSCRIPT_SCHEMA,
  INDEX_SCHEMA,
  TRANSCRIPT_FILE,
  TRANSCRIPT_DIGEST_FILE,
  TRANSCRIPT_RENDER_FILE,
  EVIDENCE_INDEX_FILE,
  OBJECTS_DIRECTORY,
  DEFAULT_RAW_OBJECT_THRESHOLD_BYTES,
  DEFAULT_INDEX_LIMITS,
  createRouteTranscript,
  initializeRouteTranscript: createRouteTranscript,
  appendRouteEvent,
  appendEvent: appendRouteEvent,
  verifyRouteTranscript,
  recoverRouteTranscript,
  loadRouteTranscript,
  loadRouteEvidenceIndex: routeDir => loadRouteTranscript(routeDir, { access: 'index-only' }),
  loadEvidenceIndex: routeDir => JSON.parse(readRequiredFileNoFollow(path.join(routeDir, EVIDENCE_INDEX_FILE)).toString('utf8')),
  readRawEvent,
}
