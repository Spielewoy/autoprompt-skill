#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { readChecksummedJson } = require('./event-log.js')

const CHECKSUMMED_CONTROLS = Object.freeze([
  Object.freeze({
    relative: 'runtime/state.json',
    binding: record => ({
      activationId: record && record.activation && record.activation.id,
      generation: record && record.activation && record.activation.generation,
      sequence: record && record.sequence,
    }),
  }),
  Object.freeze({
    relative: 'runtime/state.json.transaction',
    binding: record => ({
      activationId: record && record.next && record.next.activation && record.next.activation.id,
      generation: record && record.next && record.next.activation && record.next.activation.generation,
      sequence: record && record.expectedSequence,
    }),
  }),
  Object.freeze({
    relative: 'runtime/processes.json',
    binding: record => ({
      activationId: record && record.activationId,
      generation: record && record.generationId,
      sequence: record && record.sequence,
    }),
  }),
  Object.freeze({
    relative: 'cleanup/registry.json',
    binding: record => ({
      activationId: record && record.activationId,
      generation: record && record.generationId,
      sequence: record && record.sequence,
    }),
  }),
  Object.freeze({
    relative: 'terminal.json',
    binding: record => ({
      activationId: record && record.activationId,
      generation: record && record.generation,
      sequence: record && record.sequence,
    }),
  }),
])

const JSON_CONTROLS = Object.freeze([
  Object.freeze({
    relative: 'runtime/budget.json',
    binding: record => ({
      activationId: record && record.activationId,
      generation: record && record.generation,
      sequence: record && record.lastAccountingSequence,
    }),
  }),
  Object.freeze({
    relative: 'runtime/recovery-checkpoint.json',
    binding: record => ({
      activationId: record && record.authority && record.authority.activationId,
      generation: record && record.authority && record.authority.generation,
      sequence: record && record.lastCheckpointSequence,
    }),
  }),
])

const JSONL_CONTROLS = Object.freeze([
  Object.freeze({
    relative: 'runtime/events.jsonl',
    binding: record => ({
      // The Codex runtime intentionally uses the run id as its activation id.
      // EventLog already binds every row to that exact immutable run id.
      activationId: record && record.runId,
      generation: record && record.generation,
      sequence: record && record.sequence,
    }),
  }),
  Object.freeze({
    relative: 'runtime/accounting.jsonl',
    binding: record => ({
      activationId: record && record.activationId,
      generation: record && record.generation,
      sequence: record && record.sequence,
    }),
  }),
  Object.freeze({
    relative: 'runtime/recovery-checkpoints.jsonl',
    binding: record => ({
      activationId: record && record.authority && record.authority.activationId,
      generation: record && record.authority && record.authority.generation,
      sequence: record && record.sequence,
    }),
  }),
])

const LEGACY_CONTROL_PATTERN = /^(?:RUN-ENDED|\.scope-(?:phase-start|.*request.*|.*reset.*|.*snapshot.*))$/i

class GenerationControlError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'GenerationControlError'
    this.code = code
    this.details = details
  }
}

function deny(record, reason, details = {}) {
  throw new GenerationControlError(
    'GENERATION_CONTROL_DENIED',
    `durable control ${record} is not authorized for this activation generation: ${reason}`,
    { record, reason, ...details },
  )
}

function relativeName(runPath, filename) {
  return path.relative(runPath, filename).replace(/\\/g, '/')
}

function readPhysical(runPath, filename) {
  const relative = relativeName(runPath, filename)
  let item
  try { item = fs.lstatSync(filename) } catch (error) {
    deny(relative, 'malformed', { cause: error.code || error.message })
  }
  if (!item.isFile() || item.isSymbolicLink() || Number(item.nlink) !== 1) {
    deny(relative, 'malformed', { cause: 'control is not one physical regular file' })
  }
  try { return fs.readFileSync(filename, 'utf8') } catch (error) {
    deny(relative, 'malformed', { cause: error.code || error.message })
  }
}

function readJson(runPath, filename, checksummed) {
  const relative = relativeName(runPath, filename)
  try {
    if (checksummed) {
      // Validate the directory entry without following links before the
      // shared checksum reader opens it.
      readPhysical(runPath, filename)
      return readChecksummedJson(filename)
    }
    return JSON.parse(readPhysical(runPath, filename))
  } catch (error) {
    if (error instanceof GenerationControlError) throw error
    deny(relative, 'malformed', { cause: error.code || error.message })
  }
}

function validateCurrentBinding(binding, descriptor, authority) {
  const { relative } = descriptor
  if (!binding || binding.activationId !== authority.activationId) {
    deny(relative, 'foreign', { expectedActivationId: authority.activationId, actualActivationId: binding && binding.activationId })
  }
  if (!Number.isSafeInteger(binding.sequence) || binding.sequence < 0) {
    deny(relative, 'unsequenced', { actualSequence: binding && binding.sequence })
  }
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    deny(relative, 'cross-generation', { actualGeneration: binding && binding.generation })
  }
  if (binding.generation < authority.minimumGeneration) {
    deny(relative, 'stale', { minimumGeneration: authority.minimumGeneration, actualGeneration: binding.generation })
  }
  if (binding.generation > authority.generation) {
    deny(relative, 'future', { expectedGeneration: authority.generation, actualGeneration: binding.generation })
  }
  return Object.freeze({ record: relative, ...binding })
}

function validateLog(runPath, descriptor, authority) {
  const filename = path.join(runPath, ...descriptor.relative.split('/'))
  if (!fs.existsSync(filename)) return []
  const source = readPhysical(runPath, filename)
  if (!source || !source.endsWith('\n')) deny(descriptor.relative, 'malformed', { cause: 'JSONL control has an incomplete tail' })
  const records = []
  let priorGeneration = null
  for (const [index, line] of source.split('\n').entries()) {
    if (!line) continue
    let parsed
    try { parsed = JSON.parse(line) } catch (error) {
      deny(descriptor.relative, 'malformed', { line: index + 1, cause: error.message })
    }
    const binding = descriptor.binding(parsed)
    if (!binding || binding.activationId !== authority.activationId) {
      deny(descriptor.relative, 'foreign', {
        line: index + 1,
        expectedActivationId: authority.activationId,
        actualActivationId: binding && binding.activationId,
      })
    }
    if (!Number.isSafeInteger(binding.sequence) || binding.sequence !== records.length + 1) {
      deny(descriptor.relative, 'unsequenced', { line: index + 1, actualSequence: binding && binding.sequence })
    }
    if (!Number.isSafeInteger(binding.generation) || binding.generation < 1 || binding.generation > authority.generation) {
      deny(descriptor.relative, binding && binding.generation > authority.generation ? 'future' : 'cross-generation', {
        line: index + 1,
        expectedGeneration: authority.generation,
        actualGeneration: binding && binding.generation,
      })
    }
    // Append-only histories retain older authorized generations as evidence,
    // but authority can only stay put or advance once. A rollback or skipped
    // generation means two generations wrote one control stream.
    if (priorGeneration !== null &&
        (binding.generation < priorGeneration || binding.generation > priorGeneration + 1)) {
      deny(descriptor.relative, 'cross-generation', {
        line: index + 1, priorGeneration, actualGeneration: binding.generation,
      })
    }
    records.push(Object.freeze({ record: descriptor.relative, line: index + 1, ...binding }))
    priorGeneration = binding.generation
  }
  if (!records.length) deny(descriptor.relative, 'malformed', { cause: 'JSONL control is empty' })
  if (records.at(-1).generation < authority.minimumGeneration) {
    deny(descriptor.relative, 'stale', {
      minimumGeneration: authority.minimumGeneration,
      actualGeneration: records.at(-1).generation,
    })
  }
  return records
}

function assertNoLegacyControls(runPath) {
  let entries
  try { entries = fs.readdirSync(runPath, { withFileTypes: true }) } catch (error) {
    throw new GenerationControlError(
      'GENERATION_CONTROL_CONFIG_INVALID',
      'generation authority cannot read the opened run record',
      { runPath, cause: error.code || error.message },
    )
  }
  for (const entry of entries) {
    if (LEGACY_CONTROL_PATTERN.test(entry.name)) deny(entry.name, 'unbound-legacy-control')
  }
}

function assertCrossRecordConsistency(records) {
  const latest = new Map(records.map(record => [record.record, record]))
  const state = latest.get('runtime/state.json')
  const transaction = latest.get('runtime/state.json.transaction')
  const event = latest.get('runtime/events.jsonl')
  const terminal = latest.get('terminal.json')
  if (state && event) {
    const pendingSequence = transaction ? state.sequence + 1 : state.sequence
    if (event.sequence !== state.sequence && event.sequence !== pendingSequence) {
      deny('runtime/events.jsonl', 'cross-generation', {
        cause: 'state/event control sequences diverge', stateSequence: state.sequence,
        eventSequence: event.sequence, transaction: Boolean(transaction),
      })
    }
  }
  if (state && terminal && (terminal.generation !== state.generation || terminal.sequence > state.sequence)) {
    deny('terminal.json', 'cross-generation', {
      cause: 'terminal authority is ahead of or outside runtime state',
      stateGeneration: state.generation, terminalGeneration: terminal.generation,
      stateSequence: state.sequence, terminalSequence: terminal.sequence,
    })
  }
}

function assertGenerationControlAuthority(options = {}) {
  if (typeof options.runPath !== 'string' || !path.isAbsolute(options.runPath) ||
      typeof options.activationId !== 'string' || !options.activationId ||
      !Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new GenerationControlError(
      'GENERATION_CONTROL_CONFIG_INVALID',
      'generation authority requires an absolute run path, activation id, and positive generation',
    )
  }
  const runPath = path.resolve(options.runPath)
  const item = fs.lstatSync(runPath)
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new GenerationControlError('GENERATION_CONTROL_CONFIG_INVALID', 'opened run record is not one physical directory')
  }
  const authority = Object.freeze({
    activationId: options.activationId,
    generation: options.generation,
    minimumGeneration: Math.max(1, options.generation - 1),
  })
  assertNoLegacyControls(runPath)
  const records = []
  for (const descriptor of CHECKSUMMED_CONTROLS) {
    const filename = path.join(runPath, ...descriptor.relative.split('/'))
    if (!fs.existsSync(filename)) continue
    records.push(validateCurrentBinding(descriptor.binding(readJson(runPath, filename, true)), descriptor, authority))
  }
  for (const descriptor of JSON_CONTROLS) {
    const filename = path.join(runPath, ...descriptor.relative.split('/'))
    if (!fs.existsSync(filename)) continue
    records.push(validateCurrentBinding(descriptor.binding(readJson(runPath, filename, false)), descriptor, authority))
  }
  for (const descriptor of JSONL_CONTROLS) records.push(...validateLog(runPath, descriptor, authority))
  assertCrossRecordConsistency(records)
  return Object.freeze({
    authorized: true,
    activationId: authority.activationId,
    generation: authority.generation,
    records: Object.freeze(records),
  })
}

module.exports = {
  GenerationControlError,
  assertGenerationControlAuthority,
}
