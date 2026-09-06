'use strict'

const fs = require('node:fs')
const { canonicalStringify, digestRecord, exactKeys, fail, hashPattern, isoDate, nonEmpty } = require('./core.cjs')
const { requireRoleDigest, signRoleDigest } = require('./trust-registry.cjs')

const GENESIS = '0'.repeat(64)
const ENTRY_FIELDS = Object.freeze(['schemaVersion', 'manifestDigest', 'index', 'attemptId', 'predecessor', 'startedAt', 'endedAt', 'terminalState', 'evidenceChecksum', 'entryDigest', 'signature'])

function unsignedEntry(entry) {
  const value = { ...entry }
  delete value.entryDigest
  delete value.signature
  return value
}

function validateLedgerEntry(entry, context) {
  exactKeys(entry, ENTRY_FIELDS, 'EXECUTION_LEDGER_INVALID', 'execution ledger entry')
  if (ENTRY_FIELDS.some(field => !Object.hasOwn(entry, field)) || entry.schemaVersion !== 'benchmark-execution-ledger-entry.v2') fail('EXECUTION_LEDGER_INVALID', 'execution ledger entry is incomplete')
  if (!hashPattern(entry.manifestDigest) || entry.manifestDigest !== context.manifest.manifestDigest || !Number.isSafeInteger(entry.index) || entry.index < 0) fail('EXECUTION_LEDGER_INVALID', 'execution ledger identity or index is invalid')
  nonEmpty(entry.attemptId, 'EXECUTION_LEDGER_INVALID', 'ledger attemptId')
  if (entry.attemptId !== context.manifest.executionOrder[entry.index]) fail('EXECUTION_LEDGER_ORDER_INVALID', 'ledger attempt differs from the signed total order')
  if (!hashPattern(entry.predecessor) || entry.predecessor !== context.predecessor) fail('EXECUTION_LEDGER_CHAIN_INVALID', 'ledger predecessor does not match the preceding entry')
  isoDate(entry.startedAt, 'EXECUTION_LEDGER_INVALID', 'ledger startedAt')
  isoDate(entry.endedAt, 'EXECUTION_LEDGER_INVALID', 'ledger endedAt')
  if (Date.parse(entry.startedAt) >= Date.parse(entry.endedAt)) fail('EXECUTION_LEDGER_TIME_INVALID', 'ledger attempt interval must have positive duration')
  if (context.previousEnd && Date.parse(context.previousEnd) >= Date.parse(entry.startedAt)) fail('EXECUTION_LEDGER_TIME_INVALID', 'ledger intervals require strict chronological separation')
  if (!['PASS', 'FAIL', 'CANCELLED', 'CENSORED', 'CRASH'].includes(entry.terminalState) || !hashPattern(entry.evidenceChecksum)) fail('EXECUTION_LEDGER_INVALID', 'ledger terminal state or evidence checksum is invalid')
  const digest = digestRecord(unsignedEntry(entry))
  if (!hashPattern(entry.entryDigest) || entry.entryDigest !== digest) fail('EXECUTION_LEDGER_CHAIN_INVALID', 'ledger entry digest is invalid')
  requireRoleDigest(context.trustRegistry, 'controller', digest, entry.endedAt, entry.signature, 'EXECUTION_LEDGER_SIGNATURE_INVALID')
  return entry
}

function parseExecutionLedger(bytes, options) {
  if (!options || !options.manifest || !options.trustRegistry) fail('EXECUTION_LEDGER_INVALID', 'manifest and trust registry are required')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) } catch (error) { fail('EXECUTION_LEDGER_INVALID', 'ledger is not valid UTF-8', { cause: error.message }) }
  if (text && !text.endsWith('\n')) fail('EXECUTION_LEDGER_TRUNCATED', 'execution ledger has an incomplete final line')
  const entries = []
  let predecessor = GENESIS
  let previousEnd = null
  for (const [lineIndex, line] of text.split('\n').entries()) {
    if (!line) continue
    let entry
    try { entry = JSON.parse(line) } catch (error) { fail('EXECUTION_LEDGER_INVALID', `execution ledger line ${lineIndex + 1} is invalid JSON`, { cause: error.message }) }
    if (line !== canonicalStringify(entry)) fail('EXECUTION_LEDGER_INVALID', `execution ledger line ${lineIndex + 1} is not canonical JSON`)
    if (entry.index !== entries.length) fail('EXECUTION_LEDGER_ORDER_INVALID', 'execution ledger indexes must be contiguous from zero')
    validateLedgerEntry(entry, { manifest: options.manifest, trustRegistry: options.trustRegistry, predecessor, previousEnd })
    entries.push(entry); predecessor = entry.entryDigest; previousEnd = entry.endedAt
  }
  if (options.requireComplete && entries.length !== options.manifest.executionOrder.length) fail('EXECUTION_LEDGER_INCOMPLETE', 'execution ledger does not cover the complete signed order')
  if (entries.length > options.manifest.executionOrder.length) fail('EXECUTION_LEDGER_ORDER_INVALID', 'execution ledger exceeds the signed order')
  return entries
}

function loadExecutionLedger(filename, options) {
  let bytes
  try { bytes = fs.readFileSync(filename) } catch (error) {
    if (error.code === 'ENOENT' && !options.requireComplete) bytes = Buffer.alloc(0)
    else fail('EXECUTION_LEDGER_INVALID', `cannot read execution ledger: ${filename}`, { cause: error.code })
  }
  return parseExecutionLedger(bytes, options)
}

function withLedgerLock(filename, operation) {
  const lock = `${filename}.lock`
  let descriptor
  try {
    try { descriptor = fs.openSync(lock, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') fail('EXECUTION_LEDGER_BUSY', 'execution ledger is owned by another process')
      throw error
    }
    fs.writeFileSync(descriptor, `${process.pid}\n`); fs.fsyncSync(descriptor)
    return operation()
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
    if (descriptor !== undefined) try { fs.unlinkSync(lock) } catch {}
  }
}

function appendExecutionLedger(filename, input) {
  if (!input || !input.manifest || !input.trustRegistry || !input.signer) fail('EXECUTION_LEDGER_INVALID', 'ledger append requires manifest, trust, and controller signer')
  fs.mkdirSync(require('node:path').dirname(filename), { recursive: true, mode: 0o700 })
  return withLedgerLock(filename, () => {
    const entries = loadExecutionLedger(filename, { manifest: input.manifest, trustRegistry: input.trustRegistry, requireComplete: false })
    const index = entries.length
    if (index >= input.manifest.executionOrder.length || input.attemptId !== input.manifest.executionOrder[index]) fail('EXECUTION_LEDGER_ORDER_INVALID', 'attempt is not next in the signed execution order')
    const unsigned = {
      schemaVersion: 'benchmark-execution-ledger-entry.v2', manifestDigest: input.manifest.manifestDigest,
      index, attemptId: input.attemptId, predecessor: entries.length ? entries.at(-1).entryDigest : GENESIS,
      startedAt: input.startedAt, endedAt: input.endedAt, terminalState: input.terminalState, evidenceChecksum: input.evidenceChecksum,
    }
    const entryDigest = digestRecord(unsigned)
    const entry = { ...unsigned, entryDigest, signature: signRoleDigest('controller', entryDigest, input.endedAt, input.signer) }
    validateLedgerEntry(entry, { manifest: input.manifest, trustRegistry: input.trustRegistry, predecessor: unsigned.predecessor, previousEnd: entries.length ? entries.at(-1).endedAt : null })
    const descriptor = fs.openSync(filename, 'a', 0o600)
    try { fs.writeSync(descriptor, `${canonicalStringify(entry)}\n`); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    return Object.freeze(entry)
  })
}

module.exports = { GENESIS, appendExecutionLedger, loadExecutionLedger, parseExecutionLedger, validateLedgerEntry }
