#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const EVENT_SCHEMA_VERSION = '2.0.0'
const HASH_PATTERN = /^[a-f0-9]{64}$/

class EventLogError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'EventLogError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new EventLogError(code, message, details)
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('NON_CANONICAL_VALUE', 'events cannot contain non-finite numbers')
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen))
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) {
    fail('NON_CANONICAL_VALUE', 'events must contain only JSON values')
  }
  if (seen.has(value)) fail('NON_CANONICAL_VALUE', 'events cannot contain cycles')
  seen.add(value)
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('NON_CANONICAL_VALUE', `event field ${key} is undefined`)
    result[key] = canonicalize(value[key], seen)
  }
  seen.delete(value)
  return result
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function checksumRecord(record, checksumField = 'checksum') {
  const unsigned = { ...record }
  delete unsigned[checksumField]
  return sha256(stableStringify(unsigned))
}

let temporaryCounter = 0
function fsyncDirectory(directory, fsImpl = fs) {
  try {
    const directoryHandle = fsImpl.openSync(directory, 'r')
    try { fsImpl.fsyncSync(directoryHandle) } finally { fsImpl.closeSync(directoryHandle) }
    return true
  } catch (error) {
    if (!error || !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code)) throw error
    return false
  }
}

function atomicWriteFile(filePath, bytes, options = {}) {
  const fsImpl = options.fsImpl || fs
  const directory = path.dirname(filePath)
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 })
  temporaryCounter += 1
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${temporaryCounter}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  )
  let descriptor
  try {
    descriptor = fsImpl.openSync(temporary, 'wx', options.mode || 0o600)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
    let offset = 0
    while (offset < buffer.length) offset += fsImpl.writeSync(descriptor, buffer, offset, buffer.length - offset)
    fsImpl.fsyncSync(descriptor)
    fsImpl.closeSync(descriptor)
    descriptor = undefined
    if (typeof options.beforeCommit === 'function') options.beforeCommit({ filePath, temporary })
    fsImpl.renameSync(temporary, filePath)
    fsyncDirectory(directory, fsImpl)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor) } catch {}
    }
    try { fsImpl.unlinkSync(temporary) } catch {}
    throw error
  }
}

function atomicWriteJson(filePath, record, options = {}) {
  const signed = { ...canonicalize(record) }
  signed.checksum = checksumRecord(signed)
  atomicWriteFile(filePath, `${stableStringify(signed)}\n`, options)
  return signed
}

function atomicCreateJson(filePath, record, options = {}) {
  const fsImpl = options.fsImpl || fs
  if (typeof fsImpl.linkSync !== 'function') fail('ATOMIC_CREATE_UNSUPPORTED', 'filesystem lacks atomic hard-link creation')
  const signed = { ...canonicalize(record) }
  signed.checksum = checksumRecord(signed)
  const directory = path.dirname(filePath)
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.create`)
  let descriptor
  try {
    descriptor = fsImpl.openSync(temporary, 'wx', options.mode || 0o600)
    const bytes = Buffer.from(`${stableStringify(signed)}\n`, 'utf8')
    let offset = 0
    while (offset < bytes.length) offset += fsImpl.writeSync(descriptor, bytes, offset, bytes.length - offset)
    fsImpl.fsyncSync(descriptor)
    fsImpl.closeSync(descriptor)
    descriptor = undefined
    fsImpl.linkSync(temporary, filePath)
    fsyncDirectory(directory, fsImpl)
    fsImpl.unlinkSync(temporary)
    fsyncDirectory(directory, fsImpl)
    return signed
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor) } catch {}
    }
    try { fsImpl.unlinkSync(temporary) } catch {}
    throw error
  }
}

function readChecksummedJson(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs
  let parsed
  try {
    parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail('CHECKSUMMED_RECORD_INVALID', `invalid JSON record: ${filePath}`, { cause: error.message })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !HASH_PATTERN.test(parsed.checksum || '')) {
    fail('CHECKSUMMED_RECORD_INVALID', `invalid checksummed record: ${filePath}`)
  }
  const actual = checksumRecord(parsed)
  if (actual !== parsed.checksum) {
    fail('CHECKSUM_MISMATCH', `record checksum mismatch: ${filePath}`, {
      expected: parsed.checksum,
      actual,
    })
  }
  return parsed
}

function validateBinding(binding) {
  const requiredStrings = ['runId', 'requestEnvelopeHash', 'targetIdentity', 'openedDirectoryIdentity']
  for (const field of requiredStrings) {
    if (typeof binding[field] !== 'string' || !binding[field]) {
      fail('EVENT_BINDING_INVALID', `event binding requires ${field}`)
    }
  }
  if (!binding.digests || typeof binding.digests !== 'object') {
    fail('EVENT_BINDING_INVALID', 'event binding requires digests')
  }
  for (const field of ['contract', 'prompt', 'provider', 'tool']) {
    if (typeof binding.digests[field] !== 'string' || !binding.digests[field]) {
      fail('EVENT_BINDING_INVALID', `event binding requires digests.${field}`)
    }
  }
}

class EventLog {
  constructor(options) {
    if (!options || typeof options.logPath !== 'string') {
      fail('EVENT_LOG_CONFIG_INVALID', 'event log requires logPath')
    }
    validateBinding(options.binding || {})
    this.logPath = path.resolve(options.logPath)
    this.blobDirectory = path.resolve(options.blobDirectory || path.join(path.dirname(this.logPath), 'blobs'))
    this.binding = canonicalize(options.binding)
    this.fs = options.fsImpl || fs
    this.clock = options.clock || (() => new Date().toISOString())
    this.maxInlineBytes = options.maxInlineBytes === undefined ? 16 * 1024 : options.maxInlineBytes
    this.lockPath = path.resolve(options.lockPath || `${this.logPath}.append-lock`)
    this.lockTimeoutMs = options.lockTimeoutMs === undefined ? 2000 : options.lockTimeoutMs
    this.lockPollMs = options.lockPollMs === undefined ? 10 : options.lockPollMs
    this.monotonicMs = options.monotonicMs || (() => Number(process.hrtime.bigint() / 1000000n))
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs <= 0 || this.lockTimeoutMs > 60000 ||
        !Number.isSafeInteger(this.lockPollMs) || this.lockPollMs <= 0 || this.lockPollMs > this.lockTimeoutMs) {
      fail('EVENT_LOG_CONFIG_INVALID', 'event lock requires 0 < pollMs <= timeoutMs <= 60000')
    }
    if (options.locking !== undefined && options.locking !== 'exclusive-directory') {
      fail('EVENT_LOCK_UNSUPPORTED', `unsupported event locking strategy: ${options.locking}`)
    }
    for (const method of ['mkdirSync', 'openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync']) {
      if (typeof this.fs[method] !== 'function') fail('EVENT_LOCK_UNSUPPORTED', `filesystem lacks ${method}`)
    }
    if (!Number.isSafeInteger(this.maxInlineBytes) || this.maxInlineBytes < 0) {
      fail('EVENT_LOG_CONFIG_INVALID', 'maxInlineBytes must be a non-negative safe integer')
    }
  }

  readAll() {
    if (!this.fs.existsSync(this.logPath)) return []
    const source = this.fs.readFileSync(this.logPath, 'utf8')
    if (source && !source.endsWith('\n')) fail('EVENT_LOG_TRUNCATED', `event log has an incomplete trailing record: ${this.logPath}`)
    const events = []
    let previousHash = null
    for (const [index, line] of source.split('\n').entries()) {
      if (!line) continue
      let event
      try { event = JSON.parse(line) } catch (error) {
        fail('EVENT_LOG_CORRUPT', `event ${index + 1} is not JSON`, { cause: error.message })
      }
      const unsigned = { ...event }
      delete unsigned.hash
      const actualHash = sha256(stableStringify(unsigned))
      if (!HASH_PATTERN.test(event.hash || '') || event.hash !== actualHash) {
        fail('EVENT_HASH_MISMATCH', `event ${index + 1} hash mismatch`)
      }
      if (event.schemaVersion !== EVENT_SCHEMA_VERSION || event.sequence !== events.length + 1) {
        fail('EVENT_SEQUENCE_INVALID', `event ${index + 1} sequence or schema is invalid`)
      }
      if (event.previousHash !== previousHash) fail('EVENT_CHAIN_INVALID', `event ${index + 1} breaks the hash chain`)
      for (const field of ['runId', 'requestEnvelopeHash', 'targetIdentity', 'openedDirectoryIdentity']) {
        if (event[field] !== this.binding[field]) fail('EVENT_FOREIGN_BINDING', `event ${index + 1} has foreign ${field}`)
      }
      if (stableStringify(event.digests) !== stableStringify(this.binding.digests)) {
        fail('EVENT_FOREIGN_BINDING', `event ${index + 1} has foreign interpretation digests`)
      }
      events.push(event)
      previousHash = event.hash
    }
    return events
  }

  append(input) {
    if (!input || typeof input.type !== 'string' || !input.type || typeof input.cause !== 'string' || !input.cause) {
      fail('EVENT_INVALID', 'event requires non-empty type and cause')
    }
    return this._withAppendLock(() => this._appendLocked(input))
  }

  _appendLocked(input) {
    const events = this.readAll()
    const event = canonicalize({
      schemaVersion: EVENT_SCHEMA_VERSION,
      ...this.binding,
      sequence: events.length + 1,
      previousHash: events.length ? events.at(-1).hash : null,
      timestamp: String(this.clock()),
      type: input.type,
      cause: input.cause,
      stateBefore: input.stateBefore === undefined ? null : input.stateBefore,
      stateAfter: input.stateAfter === undefined ? null : input.stateAfter,
      generation: input.generation === undefined ? null : input.generation,
      workspaceEpoch: input.workspaceEpoch === undefined ? null : input.workspaceEpoch,
      workHashes: input.workHashes || [],
      checkHashes: input.checkHashes || [],
      retryState: input.retryState || {},
      resourceState: input.resourceState || {},
      details: input.details || {},
    })
    event.hash = sha256(stableStringify(event))
    this.fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 })
    const previous = this.fs.existsSync(this.logPath) ? this.fs.readFileSync(this.logPath) : Buffer.alloc(0)
    const line = Buffer.from(`${stableStringify(event)}\n`, 'utf8')
    atomicWriteFile(this.logPath, Buffer.concat([previous, line]), { fsImpl: this.fs })
    return event
  }

  _withAppendLock(operation) {
    const token = crypto.randomBytes(16).toString('hex')
    const started = this.monotonicMs()
    const maximumPolls = Math.ceil(this.lockTimeoutMs / Math.max(1, this.lockPollMs)) + 1
    let polls = 0
    this.fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 })
    while (true) {
      try {
        this.fs.mkdirSync(this.lockPath, { mode: 0o700 })
        const ownerPath = path.join(this.lockPath, 'owner.json')
        this.fs.writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
          encoding: 'utf8', flag: 'wx', mode: 0o600,
        })
        try { return operation() } finally {
          let owner
          try { owner = JSON.parse(this.fs.readFileSync(ownerPath, 'utf8')) } catch {
            fail('EVENT_LOCK_LOST', 'event append lock owner became unreadable')
          }
          if (owner.token !== token || owner.pid !== process.pid) fail('EVENT_LOCK_LOST', 'event append lock ownership changed')
          this.fs.unlinkSync(ownerPath)
          this.fs.rmdirSync(this.lockPath)
        }
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
        if (Math.max(0, this.monotonicMs() - started) >= this.lockTimeoutMs || polls >= maximumPolls) {
          fail('EVENT_LOG_BUSY', 'event append lock could not be acquired without unsafe concurrency')
        }
        let lockItem
        try { lockItem = this.fs.lstatSync(this.lockPath) } catch (lockError) {
          if (lockError && lockError.code === 'ENOENT') continue
          throw lockError
        }
        if (!lockItem.isDirectory() || lockItem.isSymbolicLink()) {
          fail('EVENT_LOCK_UNSUPPORTED', 'event append lock path is not a physical directory')
        }
        const ownerPath = path.join(this.lockPath, 'owner.json')
        try {
          const owner = JSON.parse(this.fs.readFileSync(ownerPath, 'utf8'))
          let alive = true
          try { process.kill(owner.pid, 0) } catch (probeError) {
            if (probeError && probeError.code === 'ESRCH') alive = false
          }
          if (!alive) {
            const entries = this.fs.readdirSync(this.lockPath)
            if (entries.length !== 1 || entries[0] !== 'owner.json') fail('EVENT_LOCK_UNSUPPORTED', 'stale event lock has foreign entries')
            this.fs.unlinkSync(ownerPath)
            this.fs.rmdirSync(this.lockPath)
            continue
          }
        } catch (ownerError) {
          if (ownerError instanceof EventLogError) throw ownerError
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.lockPollMs)
        polls += 1
      }
    }
  }

  capture(type, content, metadata = {}) {
    const serialized = Buffer.isBuffer(content)
      ? content
      : Buffer.from(typeof content === 'string' ? content : stableStringify(content), 'utf8')
    let evidence
    if (serialized.length <= this.maxInlineBytes) {
      evidence = { inline: serialized.toString('utf8'), bytes: serialized.length }
    } else {
      const digest = sha256(serialized)
      const blobPath = path.join(this.blobDirectory, digest)
      if (!this.fs.existsSync(blobPath)) atomicWriteFile(blobPath, serialized, { fsImpl: this.fs })
      evidence = { contentRef: { algorithm: 'sha256', digest, bytes: serialized.length } }
    }
    return this.append({
      type,
      cause: metadata.cause || 'captured provider event',
      stateBefore: metadata.stateBefore,
      stateAfter: metadata.stateAfter,
      generation: metadata.generation,
      workspaceEpoch: metadata.workspaceEpoch,
      workHashes: metadata.workHashes,
      checkHashes: metadata.checkHashes,
      retryState: metadata.retryState,
      resourceState: metadata.resourceState,
      details: { ...(metadata.details || {}), evidence },
    })
  }

  readContent(contentRef) {
    if (!contentRef || contentRef.algorithm !== 'sha256' || !HASH_PATTERN.test(contentRef.digest || '')) {
      fail('CONTENT_REF_INVALID', 'content reference is invalid')
    }
    const bytes = this.fs.readFileSync(path.join(this.blobDirectory, contentRef.digest))
    if (bytes.length !== contentRef.bytes || sha256(bytes) !== contentRef.digest) {
      fail('CONTENT_REF_MISMATCH', 'content-addressed evidence does not match its reference')
    }
    return bytes
  }
}

module.exports = {
  EVENT_SCHEMA_VERSION,
  EventLog,
  EventLogError,
  atomicCreateJson,
  atomicWriteFile,
  atomicWriteJson,
  canonicalize,
  checksumRecord,
  fsyncDirectory,
  readChecksummedJson,
  sha256,
  stableStringify,
}
