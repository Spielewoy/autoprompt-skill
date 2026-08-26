#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MAX_L3_BRIEF_BYTES = 2 * 1024
const DEFAULT_LARGE_OUTPUT_BYTES = 8 * 1024
const PROVIDER_CAPABILITY_FIELDS = Object.freeze([
  'eventStreaming',
  'toolOutputCapture',
  'stableChildIdentity',
  'sameContextContinuation',
  'isolatedChecking',
  'cancellation',
])
const DISPATCH_REQUIRED_CAPABILITIES = Object.freeze([
  'eventStreaming',
  'toolOutputCapture',
  'stableChildIdentity',
  'sameContextContinuation',
  'cancellation',
])
const NORMAL_AUTOPROMPT_ROLE = /^ap-(?!arbiter$|re-anchor$)/
const RECOVERY_AUTOPROMPT_ROLE = /^ap-(?:re-anchor|recovery(?:-|$))/
const PURPOSE_RECOVERY_ROLES = new Set(['ap-worker'])
const CHECKER_REASSESSMENT_ROLES = new Set([
  'ap-independent-checker', 'ap-reviewer', 'ap-verifier', 'ap-fresh-verifier',
])
const CHECKER_REASSESSMENT_CODES = new Set([
  'CHECK_INCONCLUSIVE', 'RUNTIME_FAILURE', 'INDEPENDENT_CHECK_RUNTIME_RETRY',
  'CHECK_REPORT_INVALID', 'EVIDENCE_CONSUMPTION_INVALID', 'REFERENCE_METHOD_INVALID',
  'TEST_OUTCOMES_INVALID', 'DUPLICATE_UNDERLYING_EVIDENCE',
  'DUPLICATE_REFERENCE_METHOD', 'DUPLICATE_REFERENCE_METHOD_CLASS',
])
const PLAN_CHECKER_RECOVERY_CODES = new Set([
  'PLAN_CHECK_RUNTIME_RETRY', 'PLAN_RECHECK_RUNTIME_RETRY',
])
const L4_EXACT_REQUEST_ROLES = new Set([
  'ap-arbiter', 'ap-framework-validator', 'ap-fresh-verifier', 'ap-goal-checker',
  'ap-independent-checker', 'ap-intake', 'ap-juror', 'ap-preflight-probe',
  'ap-re-anchor', 'ap-reviewer', 'ap-sweeper', 'ap-verifier',
])
const REQUIRED_EXACT_REQUEST_ROLES = new Set(['ap-independent-checker'])
const CONTEXT_ROUTE_CAPS = Object.freeze({
  PENDING: Object.freeze({ briefBytes: 2048, roadmapSliceBytes: 2048, manifestBytes: 2048, fetchedEvidenceBytes: 4096, totalEnvelopeBytes: 8192 }),
  DIRECT: Object.freeze({ briefBytes: 2048, roadmapSliceBytes: 4096, manifestBytes: 4096, fetchedEvidenceBytes: 16384, totalEnvelopeBytes: 24576 }),
  LIGHT: Object.freeze({ briefBytes: 2048, roadmapSliceBytes: 8192, manifestBytes: 8192, fetchedEvidenceBytes: 16384, totalEnvelopeBytes: 32768 }),
  ROADMAP: Object.freeze({ briefBytes: 2048, roadmapSliceBytes: 16384, manifestBytes: 16384, fetchedEvidenceBytes: 32768, totalEnvelopeBytes: 65536 }),
})
const FORBIDDEN_BRIEF_KEYS = new Set([
  'conversation',
  'conversationhistory',
  'fullhistory',
  'history',
  'rawtranscript',
  'transcript',
  'roadmap',
  'priorverdicts',
  'foreignfrontier',
  'otherworkitems',
])

class ContextEnvelopeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ContextEnvelopeError'
    this.code = code
    this.details = details
  }
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function validateProviderCapabilities(capabilities, required = DISPATCH_REQUIRED_CAPABILITIES) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new ContextEnvelopeError('PROVIDER_CAPABILITIES_UNKNOWN', 'dispatch requires a provider capability contract')
  }
  const unknown = PROVIDER_CAPABILITY_FIELDS.filter((field) => typeof capabilities[field] !== 'boolean')
  if (unknown.length > 0) {
    throw new ContextEnvelopeError('PROVIDER_CAPABILITIES_UNKNOWN', 'provider capability contract is incomplete', { unknown })
  }
  const unsupported = required.filter((field) => capabilities[field] !== true)
  if (unsupported.length > 0) {
    throw new ContextEnvelopeError('PROVIDER_UNSUPPORTED', 'provider cannot satisfy required dispatch guarantees', { unsupported })
  }
  return Object.freeze(Object.fromEntries(PROVIDER_CAPABILITY_FIELDS.map((field) => [field, capabilities[field]])))
}

function toRequestBuffer(request) {
  if (Buffer.isBuffer(request)) return Buffer.from(request)
  if (typeof request === 'string') return Buffer.from(request, 'utf8')
  throw new ContextEnvelopeError('INVALID_REQUEST_ENVELOPE', 'the complete request must be a string or Buffer')
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700)
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file)
    if (!existing.equals(bytes)) {
      throw new ContextEnvelopeError('CONTENT_ADDRESS_COLLISION', `existing content does not match its digest: ${file}`)
    }
    return false
  }
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
  try {
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch {}
    if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) return false
    throw error
  }
  return true
}

/**
 * Persist the byte-identical user request under its digest.  The pointer is the
 * only request material a normal worker inherits; L0/L4 explicitly load it.
 */
function writeRequestEnvelope(rootDirectory, request, metadata = {}) {
  if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
    throw new ContextEnvelopeError('INVALID_ENVELOPE_ROOT', 'an envelope root directory is required')
  }
  const bytes = toRequestBuffer(request)
  const hash = sha256Bytes(bytes)
  const requestsDirectory = path.resolve(rootDirectory, 'requests')
  const requestPath = path.join(requestsDirectory, `${hash}.request`)
  atomicWrite(requestPath, bytes)
  const manifest = {
    schemaVersion: 1,
    algorithm: 'sha256',
    hash,
    bytes: bytes.length,
    encoding: Buffer.isBuffer(request) ? 'binary' : 'utf8',
    requestPath,
    metadata: sanitizeMetadata(metadata),
  }
  const manifestPath = path.join(requestsDirectory, `${hash}.json`)
  atomicWrite(manifestPath, Buffer.from(`${stableStringify(manifest)}\n`, 'utf8'))
  return Object.freeze({
    kind: 'request-envelope',
    path: requestPath,
    manifestPath,
    hash,
    bytes: bytes.length,
    encoding: manifest.encoding,
  })
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const out = {}
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    }
  }
  return out
}

function normalizePointer(pointer) {
  if (!pointer || typeof pointer !== 'object') {
    throw new ContextEnvelopeError('INVALID_REQUEST_POINTER', 'a named request-envelope pointer is required')
  }
  if (pointer.kind && pointer.kind !== 'request-envelope') {
    throw new ContextEnvelopeError('INVALID_REQUEST_POINTER', 'pointer kind must be request-envelope')
  }
  if (typeof pointer.path !== 'string' || typeof pointer.hash !== 'string') {
    throw new ContextEnvelopeError('INVALID_REQUEST_POINTER', 'request pointer requires path and hash')
  }
  return {
    kind: 'request-envelope',
    path: path.resolve(pointer.path),
    manifestPath: pointer.manifestPath ? path.resolve(pointer.manifestPath) : null,
    hash: pointer.hash.toLowerCase(),
    bytes: Number(pointer.bytes),
    encoding: pointer.encoding || 'utf8',
  }
}

function loadRequestEnvelope(pointer, options = {}) {
  const normalized = normalizePointer(pointer)
  const bytes = fs.readFileSync(normalized.path)
  const actualHash = sha256Bytes(bytes)
  if (actualHash !== normalized.hash) {
    throw new ContextEnvelopeError('REQUEST_HASH_MISMATCH', 'request envelope no longer matches its pointer', {
      expected: normalized.hash,
      actual: actualHash,
    })
  }
  if (Number.isFinite(normalized.bytes) && normalized.bytes !== bytes.length) {
    throw new ContextEnvelopeError('REQUEST_SIZE_MISMATCH', 'request envelope size no longer matches its pointer')
  }
  if (options.expectedHash && String(options.expectedHash).toLowerCase() !== actualHash) {
    throw new ContextEnvelopeError('REQUEST_VERSION_MISMATCH', 'checker requested a different request version')
  }
  return options.asBuffer || normalized.encoding === 'binary' ? bytes : bytes.toString('utf8')
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value), null, 2)
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key])
  return out
}

function assertNoInheritedContext(value, trail = []) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_BRIEF_KEYS.has(normalizeContextKey(key))) {
      throw new ContextEnvelopeError(
        'INHERITED_CONTEXT_FORBIDDEN',
        `normal dispatch must use a pointer instead of ${[...trail, key].join('.')}`,
      )
    }
    assertNoInheritedContext(child, [...trail, key])
  }
}

function normalizeContextKey(key) {
  return String(key).normalize('NFKC').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

function normalizedObjectFields(value) {
  const fields = new Map()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) fields.set(normalizeContextKey(key), child)
  }
  return fields
}

function firstContextField(fields, names) {
  for (const name of names) {
    const key = normalizeContextKey(name)
    if (fields.has(key)) return fields.get(key)
  }
  return undefined
}

function typedRecoveryAuthority(role, purpose, recoveryContext) {
  // Recovery may be executed by the settled physical ap-worker role.  Its
  // bounded history authority therefore comes from an explicit purpose and
  // typed context, not solely from the provider role name. Checker
  // reassessment retains its verification accounting purpose, so admit only
  // canonical checker roles and controller-issued reassessment codes there.
  const typed = recoveryContext && typeof recoveryContext === 'object' && !Array.isArray(recoveryContext) &&
    recoveryContext.type === 'bounded-recovery' && nonEmpty(recoveryContext.code)
  const declaredRecovery = RECOVERY_AUTOPROMPT_ROLE.test(role) ||
    String(purpose || '').toLowerCase() === 'recovery' && PURPOSE_RECOVERY_ROLES.has(role)
  const normalizedPurpose = String(purpose || '').toLowerCase()
  const checkerReassessment = typed && normalizedPurpose === 'verification' &&
    CHECKER_REASSESSMENT_ROLES.has(role) && CHECKER_REASSESSMENT_CODES.has(recoveryContext.code)
  const planCheckerRecovery = typed && normalizedPurpose === 'recovery' &&
    role === 'ap-independent-checker' && PLAN_CHECKER_RECOVERY_CODES.has(recoveryContext.code)
  return { typed, recovery: declaredRecovery || checkerReassessment || planCheckerRecovery }
}

function typedRecoveryFork(role, purpose, forkTurns, recoveryContext) {
  const authority = typedRecoveryAuthority(role, purpose, recoveryContext)
  const { typed, recovery } = authority
  if (!recovery) return { valid: forkTurns === 'none', forkTurns: 'none', recovery: false }
  const count = Number(forkTurns)
  return {
    valid: Number.isInteger(count) && count >= 1 && count <= 3 && typed,
    forkTurns: Number.isInteger(count) ? String(count) : forkTurns,
    recovery: true,
  }
}

function contextValueBytes(value) {
  if (value === undefined || value === null) return 0
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.byteLength(value)
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  return Buffer.byteLength(stableStringify(value), 'utf8')
}

function normalizeContextRoute(route) {
  const normalized = String(route || 'DIRECT').toUpperCase()
  if (!Object.hasOwn(CONTEXT_ROUTE_CAPS, normalized)) {
    throw new ContextEnvelopeError('INVALID_CONTEXT_ROUTE', `unknown context route: ${route}`)
  }
  return normalized
}

function assertContextComponent(name, value, limit) {
  const bytes = contextValueBytes(value)
  if (bytes > limit) {
    throw new ContextEnvelopeError('CONTEXT_COMPONENT_TOO_LARGE', `${name} exceeds the route context ceiling`, {
      component: name, bytes, limit,
    })
  }
  return bytes
}

function compactLines(label, value) {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) {
    if (value.length === 0) return []
    return [`${label}:`, ...value.map((item) => `- ${String(item)}`)]
  }
  if (typeof value === 'object') return [`${label}: ${JSON.stringify(sortJson(value))}`]
  return [`${label}: ${String(value)}`]
}

function losslessAuxiliaryBriefSlice(item) {
  const fields = {}
  const add = (key, label, value) => {
    if (compactLines(label, value).length > 0) fields[key] = value
  }
  add('assignment', 'Assignment', item.assignment)
  if (item.successChecklist !== undefined) {
    add('successChecklist', 'Success', item.successChecklist)
  } else {
    add('success', 'Success', item.success)
  }
  add('ownership', 'Ownership', item.ownership)
  add('checks', 'Checks', item.checks)
  add('dependencies', 'Dependencies', item.dependencies)
  add('returnShape', 'Return', item.returnShape)
  return Object.freeze({
    schemaVersion: 1,
    kind: 'context-brief-slice',
    fields: Object.freeze(fields),
  })
}

function mergeFetchedEvidenceWithBriefSlice(fetchedEvidence, briefSlice) {
  if (fetchedEvidence === undefined || fetchedEvidence === null) return { briefSlice }
  if (
    typeof fetchedEvidence === 'object' &&
    !Array.isArray(fetchedEvidence) &&
    !Buffer.isBuffer(fetchedEvidence) &&
    !Object.hasOwn(fetchedEvidence, 'briefSlice')
  ) {
    return { ...fetchedEvidence, briefSlice }
  }
  return { provided: fetchedEvidence, briefSlice }
}

/**
 * Build a normal L3 bootstrap.  The byte ceiling applies to `brief`; the named
 * request/evidence pointers are deliberately separate, matching the P7 rule.
 * Brief fields that cross the ceiling are moved losslessly into the
 * route-bounded fetched-evidence component. No field is silently truncated.
 */
function buildContextFreeBrief(input, options = {}) {
  const item = input || {}
  assertNoInheritedContext(item)
  if (!nonEmpty(item.role)) throw new ContextEnvelopeError('INVALID_BRIEF', 'role is required')
  if (!nonEmpty(item.assignment)) throw new ContextEnvelopeError('INVALID_BRIEF', 'assignment is required')
  const providerCapabilities = validateProviderCapabilities(
    item.providerCapabilities || options.providerCapabilities,
  )
  const requestPointer = normalizePointer(item.requestPointer)
  const inputFields = normalizedObjectFields(item)
  const route = normalizeContextRoute(firstContextField(inputFields, ['route']) || options.route)
  const purpose = firstContextField(inputFields, ['purpose', 'workPurpose'])
  const requestedForkTurns = firstContextField(inputFields, ['forkTurns'])
  const recoveryContext = firstContextField(inputFields, ['recoveryContext'])
  const recoveryDispatch = typedRecoveryAuthority(
    item.role.trim(), purpose, recoveryContext,
  ).recovery
  const forkPolicy = typedRecoveryFork(
    item.role.trim(), purpose,
    requestedForkTurns === undefined ? (recoveryDispatch ? null : 'none') : requestedForkTurns,
    recoveryContext,
  )
  if (!forkPolicy.valid) {
    throw new ContextEnvelopeError(
      recoveryDispatch ? 'RECOVERY_FORK_BOUNDS_REQUIRED' : 'INHERITED_CONTEXT_FORBIDDEN',
      recoveryDispatch
        ? 'recovery dispatch requires typed recoveryContext and fork_turns between 1 and 3'
        : 'non-recovery dispatch must set fork_turns=none',
    )
  }
  const caps = CONTEXT_ROUTE_CAPS[route]
  const maxBytes = Math.min(positiveByteLimit(options.maxBytes, caps.briefBytes), caps.briefBytes)
  const lines = [
    `Role: ${item.role.trim()}`,
    `Assignment: ${item.assignment.trim()}`,
    ...compactLines('Success', item.successChecklist || item.success),
    ...compactLines('Ownership', item.ownership),
    ...compactLines('Checks', item.checks),
    ...compactLines('Dependencies', item.dependencies),
    ...compactLines('Return', item.returnShape),
  ]
  let brief = `${lines.join('\n')}\n`
  let bytes = Buffer.byteLength(brief, 'utf8')
  let fetchedEvidence = firstContextField(inputFields, ['fetchedEvidence']) ?? null
  if (bytes > maxBytes) {
    const unslicedBytes = bytes
    const briefSlice = losslessAuxiliaryBriefSlice(item)
    brief = [
      `Role: ${item.role.trim()}`,
      'Assignment: Read fetchedEvidence.briefSlice.fields.assignment for the exact assignment.',
      'Details: Read fetchedEvidence.briefSlice for the exact Success, Ownership, Checks, Dependencies, and Return fields.',
      '',
    ].join('\n')
    bytes = Buffer.byteLength(brief, 'utf8')
    if (bytes > maxBytes) {
      throw new ContextEnvelopeError('BRIEF_TOO_LARGE', 'core assignment exceeds the dispatch brief ceiling', {
        bytes,
        maxBytes,
        overflowBytes: bytes - maxBytes,
        unslicedBytes,
      })
    }
    fetchedEvidence = mergeFetchedEvidenceWithBriefSlice(fetchedEvidence, briefSlice)
  }
  const evidencePointers = normalizeEvidencePointers(item.evidencePointers || [])
  const roadmapSlice = firstContextField(inputFields, ['roadmapSlice']) ?? null
  const manifests = firstContextField(inputFields, ['manifests', 'manifestPointers']) ?? null
  const componentBytes = {
    brief: bytes,
    roadmapSlice: assertContextComponent('roadmapSlice', roadmapSlice, caps.roadmapSliceBytes),
    manifests: assertContextComponent('manifests', manifests, caps.manifestBytes),
    fetchedEvidence: assertContextComponent('fetchedEvidence', fetchedEvidence, caps.fetchedEvidenceBytes),
  }
  const dispatch = {
    schemaVersion: 1,
    activation: 'context-free',
    fork_turns: forkPolicy.forkTurns,
    route,
    role: item.role.trim(),
    brief,
    briefBytes: bytes,
    requestPointer,
    evidencePointers,
    providerCapabilities,
  }
  if (purpose !== undefined && purpose !== null) dispatch.purpose = String(purpose)
  if (roadmapSlice !== null) dispatch.roadmapSlice = roadmapSlice
  if (manifests !== null) dispatch.manifests = manifests
  if (fetchedEvidence !== null) dispatch.fetchedEvidence = fetchedEvidence
  if (recoveryDispatch) dispatch.recoveryContext = recoveryContext
  let contextBudget = { route, caps, componentBytes, totalEnvelopeBytes: 0 }
  dispatch.contextBudget = contextBudget
  for (let attempt = 0; attempt < 4; attempt++) {
    const totalEnvelopeBytes = Buffer.byteLength(stableStringify(dispatch), 'utf8')
    contextBudget = { ...contextBudget, totalEnvelopeBytes }
    dispatch.contextBudget = contextBudget
  }
  if (contextBudget.totalEnvelopeBytes > caps.totalEnvelopeBytes) {
    throw new ContextEnvelopeError('CONTEXT_ENVELOPE_TOO_LARGE', 'dispatch exceeds the route total context ceiling', {
      route, bytes: contextBudget.totalEnvelopeBytes, limit: caps.totalEnvelopeBytes, componentBytes,
    })
  }
  return Object.freeze(dispatch)
}

function buildCheckerContext(input, options = {}) {
  const item = input || {}
  const role = item.role || 'ap-independent-checker'
  if (!L4_EXACT_REQUEST_ROLES.has(role)) {
    throw new ContextEnvelopeError('INVALID_CHECKER_ROLE', 'only a canonical L4 role may receive the exact request')
  }
  const dispatch = buildContextFreeBrief({
    ...item,
    role,
    assignment: item.assignment || 'Independently review and test the exact version.',
  }, options)
  const exactRequest = loadRequestEnvelope(dispatch.requestPointer, {
    expectedHash: item.expectedRequestHash || dispatch.requestPointer.hash,
    asBuffer: Boolean(options.asBuffer),
  })
  return Object.freeze({
    ...dispatch,
    exactRequest,
    exactRequestHash: dispatch.requestPointer.hash,
    candidateHash: item.candidateHash || null,
    checkResultsPointer: item.checkResultsPointer || null,
  })
}

function positiveByteLimit(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function normalizeEvidencePointers(pointers) {
  if (!Array.isArray(pointers)) {
    throw new ContextEnvelopeError('INVALID_EVIDENCE_POINTERS', 'evidencePointers must be an array')
  }
  return pointers.map((pointer) => {
    if (!pointer || !nonEmpty(pointer.name) || !nonEmpty(pointer.path)) {
      throw new ContextEnvelopeError('INVALID_EVIDENCE_POINTER', 'each evidence pointer requires name and path')
    }
    return Object.freeze({
      name: pointer.name.trim(),
      path: path.resolve(pointer.path),
      hash: pointer.hash || null,
      bytes: Number.isFinite(Number(pointer.bytes)) ? Number(pointer.bytes) : null,
    })
  })
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Persist a raw route/transcript event.  Large string/Buffer tool outputs are
 * content-addressed and replaced by an explicit pointer in the bounded index;
 * nothing is silently clipped.
 */
class TranscriptStore {
  constructor(rootDirectory, options = {}) {
    if (!nonEmpty(rootDirectory)) throw new ContextEnvelopeError('INVALID_TRANSCRIPT_ROOT', 'root directory is required')
    this.root = path.resolve(rootDirectory)
    this.eventsDirectory = path.join(this.root, 'events')
    this.blobsDirectory = path.join(this.root, 'blobs')
    this.largeOutputBytes = positiveByteLimit(options.largeOutputBytes, DEFAULT_LARGE_OUTPUT_BYTES)
    this._sequence = 0
    this._headHash = null
    for (const directory of [path.dirname(this.root), this.root, this.eventsDirectory, this.blobsDirectory]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') fs.chmodSync(directory, 0o700)
    }
    const events = this._loadAndValidate()
    if (events.length > 0) {
      this._sequence = events.at(-1).sequence
      this._headHash = events.at(-1).hash
    }
  }

  append(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new ContextEnvelopeError('INVALID_TRANSCRIPT_EVENT', 'event must be an object')
    }
    return this._withAppendLock(() => {
      const current = this._loadAndValidate()
      this._sequence = current.length === 0 ? 0 : current.at(-1).sequence
      this._headHash = current.length === 0 ? null : current.at(-1).hash
      const sequence = this._sequence + 1
      const stored = this._externalize(event)
      const payloadHash = sha256Bytes(Buffer.from(stableStringify(stored.value), 'utf8'))
      const envelope = {
        schemaVersion: 1,
        sequence,
        previousHash: this._headHash,
        payloadHash,
        payload: stored.value,
      }
      const serialized = Buffer.from(`${stableStringify(envelope)}\n`, 'utf8')
      const eventHash = sha256Bytes(serialized)
      const eventPath = path.join(this.eventsDirectory, `${String(sequence).padStart(8, '0')}-${eventHash}.json`)
      atomicWrite(eventPath, serialized)
      this._sequence = sequence
      this._headHash = eventHash
      return Object.freeze({
        sequence,
        path: eventPath,
        hash: eventHash,
        previousHash: envelope.previousHash,
        payloadHash,
        bytes: serialized.length,
        blobs: stored.blobs,
      })
    })
  }

  evidenceIndex(entries, options = {}) {
    if (!Array.isArray(entries)) throw new ContextEnvelopeError('INVALID_EVIDENCE_INDEX', 'entries must be an array')
    if (entries.length === 0) throw new ContextEnvelopeError('EMPTY_EVIDENCE_INDEX', 'empty transcript evidence must be explicit')
    const valid = new Map(this._loadAndValidate().map((entry) => [entry.sequence, entry]))
    for (const entry of entries) {
      const actual = valid.get(Number(entry.sequence))
      if (!actual || actual.hash !== entry.hash || path.resolve(entry.path) !== actual.path) {
        throw new ContextEnvelopeError('EVIDENCE_ENTRY_INVALID', 'evidence entry is not part of the validated transcript', {
          sequence: entry.sequence,
        })
      }
    }
    const maxBytes = positiveByteLimit(options.maxBytes, MAX_L3_BRIEF_BYTES)
    const value = {
      schemaVersion: 1,
      entries: entries.map((entry) => ({
        sequence: entry.sequence,
        path: entry.path,
        hash: entry.hash,
        bytes: entry.bytes,
        blobs: entry.blobs || [],
      })),
    }
    const serialized = `${stableStringify(value)}\n`
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > maxBytes) {
      throw new ContextEnvelopeError('EVIDENCE_INDEX_TOO_LARGE', 'evidence index must be sliced before dispatch', {
        bytes, maxBytes,
      })
    }
    return { value, serialized, bytes }
  }

  read(sequence) {
    const wanted = Number(sequence)
    if (!Number.isInteger(wanted) || wanted < 1) {
      throw new ContextEnvelopeError('INVALID_TRANSCRIPT_SEQUENCE', 'sequence must be a positive integer')
    }
    const entry = this._loadAndValidate().find((item) => item.sequence === wanted)
    if (!entry) throw new ContextEnvelopeError('TRANSCRIPT_GAP', `transcript sequence is absent: ${wanted}`)
    return entry
  }

  readAll(options = {}) {
    const maxEvents = positiveByteLimit(options.maxEvents, 100)
    const maxBytes = positiveByteLimit(options.maxBytes, MAX_L3_BRIEF_BYTES)
    const events = this._loadAndValidate()
    if (events.length === 0) {
      return { status: 'EMPTY_TRANSCRIPT', events: [], bytes: 0, headHash: null }
    }
    if (events.length > maxEvents) {
      throw new ContextEnvelopeError('TRANSCRIPT_READ_BOUND', 'transcript exceeds the explicit event bound', {
        events: events.length, maxEvents,
      })
    }
    const bytes = events.reduce((sum, event) => sum + event.bytes, 0)
    if (bytes > maxBytes) {
      throw new ContextEnvelopeError('TRANSCRIPT_READ_BOUND', 'transcript exceeds the explicit byte bound', {
        bytes, maxBytes,
      })
    }
    return { status: 'COMPLETE', events, bytes, headHash: events.at(-1).hash }
  }

  resume() {
    const events = this._loadAndValidate()
    return {
      status: events.length === 0 ? 'EMPTY_TRANSCRIPT' : 'COMPLETE',
      eventCount: events.length,
      nextSequence: events.length + 1,
      headHash: events.length === 0 ? null : events.at(-1).hash,
    }
  }

  integrity() {
    const events = this._loadAndValidate()
    return {
      valid: true,
      status: events.length === 0 ? 'EMPTY_TRANSCRIPT' : 'COMPLETE',
      eventCount: events.length,
      headHash: events.length === 0 ? null : events.at(-1).hash,
    }
  }

  _withAppendLock(work) {
    const lockPath = path.join(this.root, 'transcript.append.lock')
    let handle
    try {
      handle = fs.openSync(lockPath, 'wx')
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        throw new ContextEnvelopeError('TRANSCRIPT_APPEND_BUSY', 'another writer owns the transcript append lock')
      }
      throw error
    }
    try {
      return work()
    } finally {
      fs.closeSync(handle)
      fs.rmSync(lockPath, { force: true })
    }
  }

  _loadAndValidate() {
    const names = fs.readdirSync(this.eventsDirectory)
    const parsed = names.map((name) => {
      const match = /^(\d{8})-([a-f0-9]{64})\.json$/.exec(name)
      if (!match) {
        throw new ContextEnvelopeError('TRANSCRIPT_UNRECOGNIZED_EVENT', `unexpected event file: ${name}`)
      }
      return { name, sequence: Number(match[1]), hash: match[2] }
    }).sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))
    let previousHash = null
    const entries = []
    for (let index = 0; index < parsed.length; index++) {
      const file = parsed[index]
      const expectedSequence = index + 1
      if (file.sequence !== expectedSequence) {
        throw new ContextEnvelopeError('TRANSCRIPT_GAP', 'transcript has a duplicate or missing sequence', {
          expected: expectedSequence, actual: file.sequence,
        })
      }
      const eventPath = path.join(this.eventsDirectory, file.name)
      const bytes = fs.readFileSync(eventPath)
      let envelope
      try {
        envelope = JSON.parse(bytes.toString('utf8'))
      } catch {
        throw new ContextEnvelopeError('TRANSCRIPT_TRUNCATED', 'event JSON is truncated or invalid', {
          sequence: file.sequence,
        })
      }
      const actualHash = sha256Bytes(bytes)
      if (actualHash !== file.hash) {
        throw new ContextEnvelopeError('TRANSCRIPT_HASH_MISMATCH', 'event content does not match its filename hash', {
          sequence: file.sequence,
        })
      }
      const canonical = Buffer.from(`${stableStringify(envelope)}\n`, 'utf8')
      if (!canonical.equals(bytes)) {
        throw new ContextEnvelopeError('TRANSCRIPT_CONTENT_INVALID', 'event is not in canonical complete form', {
          sequence: file.sequence,
        })
      }
      if (envelope.schemaVersion !== 1 || envelope.sequence !== file.sequence || envelope.previousHash !== previousHash) {
        throw new ContextEnvelopeError('TRANSCRIPT_CHAIN_INVALID', 'event sequence/hash chain is invalid', {
          sequence: file.sequence, expectedPreviousHash: previousHash,
        })
      }
      const payloadHash = sha256Bytes(Buffer.from(stableStringify(envelope.payload), 'utf8'))
      if (payloadHash !== envelope.payloadHash) {
        throw new ContextEnvelopeError('TRANSCRIPT_PAYLOAD_INVALID', 'event payload hash does not match')
      }
      const blobs = []
      this._validatePointers(envelope.payload, blobs)
      entries.push(Object.freeze({
        sequence: file.sequence,
        path: path.resolve(eventPath),
        hash: file.hash,
        previousHash,
        payloadHash,
        payload: envelope.payload,
        bytes: bytes.length,
        blobs,
      }))
      previousHash = file.hash
    }
    return entries
  }

  _validatePointers(value, found) {
    if (Array.isArray(value)) {
      for (const child of value) this._validatePointers(child, found)
      return
    }
    if (!value || typeof value !== 'object') return
    if (value.$pointer) {
      const pointer = value.$pointer
      if (pointer.kind !== 'content-addressed-output' || !nonEmpty(pointer.path) || !nonEmpty(pointer.hash)) {
        throw new ContextEnvelopeError('TRANSCRIPT_POINTER_INVALID', 'content pointer is malformed')
      }
      const resolved = path.resolve(pointer.path)
      const relative = path.relative(this.blobsDirectory, resolved)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ContextEnvelopeError('TRANSCRIPT_POINTER_ESCAPE', 'content pointer leaves the transcript blob directory')
      }
      let bytes
      try { bytes = fs.readFileSync(resolved) } catch {
        throw new ContextEnvelopeError('TRANSCRIPT_BLOB_MISSING', `content-addressed output is missing: ${pointer.hash}`)
      }
      if (bytes.length !== Number(pointer.bytes) || sha256Bytes(bytes) !== pointer.hash) {
        throw new ContextEnvelopeError('TRANSCRIPT_BLOB_INVALID', `content-addressed output failed validation: ${pointer.hash}`)
      }
      found.push(pointer)
      return
    }
    for (const child of Object.values(value)) this._validatePointers(child, found)
  }

  _externalize(value, trail = []) {
    if (Buffer.isBuffer(value)) return this._externalizeBytes(value, 'binary', trail)
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > this.largeOutputBytes) {
      return this._externalizeBytes(Buffer.from(value, 'utf8'), 'utf8', trail)
    }
    if (Array.isArray(value)) {
      const blobs = []
      const output = value.map((child, index) => {
        const stored = this._externalize(child, [...trail, index])
        blobs.push(...stored.blobs)
        return stored.value
      })
      return { value: output, blobs }
    }
    if (value && typeof value === 'object') {
      const blobs = []
      const output = {}
      for (const key of Object.keys(value).sort()) {
        const stored = this._externalize(value[key], [...trail, key])
        blobs.push(...stored.blobs)
        output[key] = stored.value
      }
      return { value: output, blobs }
    }
    return { value, blobs: [] }
  }

  _externalizeBytes(bytes, encoding, trail) {
    const hash = sha256Bytes(bytes)
    const blobPath = path.join(this.blobsDirectory, `${hash}.blob`)
    atomicWrite(blobPath, bytes)
    const pointer = {
      kind: 'content-addressed-output',
      path: blobPath,
      hash,
      bytes: bytes.length,
      encoding,
      eventField: trail.join('.'),
    }
    return { value: { $pointer: pointer }, blobs: [pointer] }
  }
}

function auditDispatch(dispatch, options = {}) {
  const role = String((dispatch || {}).role || options.role || '')
  const normal = options.normal !== undefined ? Boolean(options.normal) : NORMAL_AUTOPROMPT_ROLE.test(role)
  const forkTurns = dispatch && (dispatch.fork_turns ?? dispatch.forkTurns)
  const violations = []
  const purpose = dispatch && (dispatch.purpose ?? dispatch.workPurpose ?? dispatch.work_purpose) || options.purpose
  const recoveryContext = dispatch && (dispatch.recoveryContext ?? dispatch.recovery_context)
  const forkPolicy = typedRecoveryFork(role, purpose, forkTurns, recoveryContext)
  if (!forkPolicy.valid) {
    violations.push(forkPolicy.recovery
      ? 'recovery role requires typed recoveryContext and fork_turns between 1 and 3'
      : 'non-recovery role must set fork_turns=none explicitly')
  }
  if (dispatch && dispatch.activation && dispatch.activation !== 'context-free') {
    violations.push('normal role must use context-free activation')
  }
  try { assertNoInheritedContext(dispatch || {}) } catch (error) { violations.push(error.message) }
  try {
    const route = normalizeContextRoute(dispatch && dispatch.route || options.route)
    const caps = CONTEXT_ROUTE_CAPS[route]
    assertContextComponent('brief', dispatch && dispatch.brief || '', caps.briefBytes)
    assertContextComponent('roadmapSlice', dispatch && (dispatch.roadmapSlice ?? dispatch.roadmap_slice), caps.roadmapSliceBytes)
    assertContextComponent('manifests', dispatch && (dispatch.manifests ?? dispatch.manifestPointers ?? dispatch.manifest_pointers), caps.manifestBytes)
    assertContextComponent('fetchedEvidence', dispatch && (dispatch.fetchedEvidence ?? dispatch.fetched_evidence), caps.fetchedEvidenceBytes)
    const boundedDispatch = { ...(dispatch || {}) }
    const exactRequestRole = L4_EXACT_REQUEST_ROLES.has(role)
    const exactRequestRequired = REQUIRED_EXACT_REQUEST_ROLES.has(role)
    const carriesExactRequest = Object.hasOwn(boundedDispatch, 'exactRequest')
    if (exactRequestRequired && !carriesExactRequest) {
      violations.push('L4 checker dispatch is missing its exact immutable request')
    } else if (!exactRequestRole && carriesExactRequest) {
      violations.push('non-L4 dispatch cannot carry the exact request')
    }
    if (exactRequestRole && carriesExactRequest) {
      const exactRequestBytes = toRequestBuffer(boundedDispatch.exactRequest)
      const exactRequestHash = sha256Bytes(exactRequestBytes)
      const pointer = normalizePointer(boundedDispatch.requestPointer)
      let pointerBytes = null
      try {
        pointerBytes = loadRequestEnvelope(pointer, { expectedHash: exactRequestHash, asBuffer: true })
      } catch {}
      if (boundedDispatch.exactRequestHash !== exactRequestHash || pointer.hash !== exactRequestHash ||
          !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 0 ||
          pointer.bytes !== exactRequestBytes.length || !pointerBytes || !pointerBytes.equals(exactRequestBytes)) {
        violations.push('checker exact request does not match its immutable request pointer')
      }
      // L4 receives the byte-identical canonical request. The request is
      // already independently size- and hash-bound by requestPointer, so it
      // is not inherited context and must not be charged a second time as
      // auxiliary dispatch data.
      delete boundedDispatch.exactRequest
    }
    if (Buffer.byteLength(stableStringify(boundedDispatch), 'utf8') > caps.totalEnvelopeBytes) {
      violations.push('dispatch exceeds the route total context ceiling')
    }
  } catch (error) { violations.push(error.message) }
  return { conformant: violations.length === 0, role, forkTurns: forkTurns ?? null, violations }
}

module.exports = {
  MAX_L3_BRIEF_BYTES,
  CONTEXT_ROUTE_CAPS,
  DEFAULT_LARGE_OUTPUT_BYTES,
  PROVIDER_CAPABILITY_FIELDS,
  DISPATCH_REQUIRED_CAPABILITIES,
  FORBIDDEN_BRIEF_KEYS,
  ContextEnvelopeError,
  TranscriptStore,
  sha256Bytes,
  validateProviderCapabilities,
  writeRequestEnvelope,
  createRequestEnvelope: writeRequestEnvelope,
  loadRequestEnvelope,
  readRequestEnvelope: loadRequestEnvelope,
  buildContextFreeBrief,
  buildWorkerBrief: buildContextFreeBrief,
  createWorkerDispatch: buildContextFreeBrief,
  buildCheckerContext,
  auditDispatch,
  normalizeContextKey,
  stableStringify,
}
