'use strict'

const fs = require('node:fs')
const { atomicWriteFile, canonicalStringify, exactKeys, fail, isoDate, nonEmpty, positiveInteger } = require('./core.cjs')

const SESSION_KEYS = Object.freeze([
  'schemaVersion', 'sessionId', 'parentSessionId', 'rootSessionId', 'attemptId', 'role', 'model',
  'startedAt', 'endedAt', 'usage', 'spans',
])
const SPAN_KINDS = Object.freeze(['planning', 'execution', 'review', 'repair', 'unknown'])

function validateSession(record, options = {}) {
  exactKeys(record, SESSION_KEYS, 'SESSION_SCHEMA_INVALID', 'session')
  if (record.schemaVersion !== 'benchmark-session.v2') fail('SESSION_SCHEMA_INVALID', 'unrecognized session schema')
  for (const field of ['sessionId', 'rootSessionId', 'attemptId', 'role']) nonEmpty(record[field], 'SESSION_SCHEMA_INVALID', field)
  if (record.parentSessionId !== null && (typeof record.parentSessionId !== 'string' || !record.parentSessionId)) fail('SESSION_SCHEMA_INVALID', 'parentSessionId must be null or non-empty')
  if (options.attemptId && record.attemptId !== options.attemptId) fail('SESSION_ATTEMPT_MISMATCH', 'session belongs to another attempt')
  isoDate(record.startedAt, 'SESSION_SCHEMA_INVALID', 'startedAt')
  isoDate(record.endedAt, 'SESSION_SCHEMA_INVALID', 'endedAt')
  if (Date.parse(record.endedAt) < Date.parse(record.startedAt)) fail('SESSION_SCHEMA_INVALID', 'session ends before it starts')
  exactKeys(record.model, ['provider', 'name', 'version'], 'SESSION_SCHEMA_INVALID', 'model')
  for (const field of ['provider', 'name', 'version']) nonEmpty(record.model[field], 'SESSION_SCHEMA_INVALID', `model.${field}`)
  if (!record.usage) fail('SESSION_USAGE_MISSING', 'session usage is required')
  exactKeys(record.usage, ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'], 'SESSION_USAGE_INVALID', 'usage')
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens']) positiveInteger(record.usage[field], 'SESSION_USAGE_INVALID', field, { allowZero: true })
  if (record.usage.cachedInputTokens > record.usage.inputTokens) fail('SESSION_USAGE_INVALID', 'cached input cannot exceed total input')
  if (!Array.isArray(record.spans) || !record.spans.length) fail('SESSION_SPAN_INVALID', 'structured spans are required')
  const spanIds = new Set()
  let cursor = record.startedAt
  for (const span of record.spans) {
    exactKeys(span, ['spanId', 'kind', 'startedAt', 'endedAt'], 'SESSION_SPAN_INVALID', 'span')
    nonEmpty(span.spanId, 'SESSION_SPAN_INVALID', 'spanId')
    if (spanIds.has(span.spanId)) fail('SESSION_SPAN_INVALID', `duplicate span: ${span.spanId}`)
    spanIds.add(span.spanId)
    if (!SPAN_KINDS.includes(span.kind)) fail('SESSION_SPAN_INVALID', `unknown structured span kind: ${span.kind}`)
    isoDate(span.startedAt, 'SESSION_SPAN_INVALID', 'span.startedAt')
    isoDate(span.endedAt, 'SESSION_SPAN_INVALID', 'span.endedAt')
    if (span.startedAt !== cursor || Date.parse(span.endedAt) <= Date.parse(span.startedAt) || Date.parse(span.startedAt) < Date.parse(record.startedAt) || Date.parse(span.endedAt) > Date.parse(record.endedAt)) {
      fail('SESSION_SPAN_INVALID', `spans must be ordered, non-overlapping, and exactly partition the session: ${span.spanId}`)
    }
    cursor = span.endedAt
  }
  if (cursor !== record.endedAt) fail('SESSION_SPAN_INVALID', 'spans must cover the full session; uncovered time must be an explicit unknown span')
  return record
}

function parseSessionJsonl(source, options = {}) {
  let text
  try { text = Buffer.isBuffer(source) ? new TextDecoder('utf-8', { fatal: true }).decode(source) : String(source || '') } catch (error) {
    fail('SESSION_JSONL_INVALID', 'session JSONL is not valid UTF-8', { cause: error.message })
  }
  if (!text || !text.endsWith('\n')) fail('SESSION_JSONL_INCOMPLETE', 'session JSONL must end with a newline')
  const lines = text.split('\n')
  lines.pop()
  if (!lines.length || lines.some(line => !line)) fail('SESSION_SCHEMA_INVALID', 'session JSONL must contain only complete non-empty records')
  const sessions = lines.map((line, index) => {
    let parsed
    try { parsed = JSON.parse(line) } catch (error) { fail('SESSION_JSONL_INVALID', `session line ${index + 1} is invalid JSON`, { cause: error.message }) }
    return validateSession(parsed, options)
  })
  return validateSessionSet(sessions, options)
}

function validateSessionSet(sessions, options = {}) {
  if (!Array.isArray(sessions) || !sessions.length) fail('SESSION_SCHEMA_INVALID', 'at least one session is required')
  const validated = sessions.map(record => validateSession(record, options))
  const ids = new Set()
  const byId = new Map()
  for (const record of validated) {
    if (ids.has(record.sessionId)) fail('SESSION_DUPLICATE', `duplicate session id: ${record.sessionId}`)
    ids.add(record.sessionId)
    byId.set(record.sessionId, record)
  }
  for (const record of validated) {
    if (record.parentSessionId === null && record.rootSessionId !== record.sessionId) fail('SESSION_ROOT_INVALID', `root session identity mismatch: ${record.sessionId}`)
    if (record.parentSessionId !== null && !ids.has(record.parentSessionId)) fail('SESSION_PARENT_MISSING', `session parent is absent: ${record.parentSessionId}`)
    if (!ids.has(record.rootSessionId)) fail('SESSION_ROOT_INVALID', `session root is absent: ${record.rootSessionId}`)
    if (byId.get(record.rootSessionId).parentSessionId !== null) fail('SESSION_ROOT_INVALID', `declared root is not a root session: ${record.rootSessionId}`)
    const ancestry = new Set([record.sessionId])
    let cursor = record
    while (cursor.parentSessionId !== null) {
      if (ancestry.has(cursor.parentSessionId)) fail('SESSION_PARENT_CYCLE', `session ancestry contains a cycle: ${record.sessionId}`)
      ancestry.add(cursor.parentSessionId)
      cursor = byId.get(cursor.parentSessionId)
    }
    if (cursor.sessionId !== record.rootSessionId) fail('SESSION_ROOT_INVALID', `session ancestry does not reach declared root: ${record.sessionId}`)
  }
  return validated
}

function writeSessionJsonl(filename, sessions, options = {}) {
  const validated = validateSessionSet(sessions, options)
  atomicWriteFile(filename, `${validated.map(record => canonicalStringify(record)).join('\n')}\n`)
  return parseSessionJsonl(fs.readFileSync(filename), options)
}

module.exports = { SESSION_KEYS, SPAN_KINDS, parseSessionJsonl, validateSession, validateSessionSet, writeSessionJsonl }
