#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const { atomicWriteJson } = require(path.join(WORKFLOW, 'event-log.js'))
const {
  GenerationControlError,
  assertGenerationControlAuthority,
} = require(path.join(WORKFLOW, 'generation-control.js'))

const ACTIVATION = 'activation-run-032-r10'

function temporaryRun(t) {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-run-032-r10-'))
  for (const relative of ['runtime', 'runtime/process-control', 'cleanup']) {
    fs.mkdirSync(path.join(runPath, ...relative.split('/')), { recursive: true })
  }
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }))
  return runPath
}

function writeJson(runPath, relative, value, checksummed = false) {
  const destination = path.join(runPath, ...relative.split('/'))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (checksummed) atomicWriteJson(destination, value)
  else fs.writeFileSync(destination, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' })
  return destination
}

function seedGenerationFour(runPath) {
  writeJson(runPath, 'runtime/state.json', {
    schemaVersion: '2.0.0', activation: { id: ACTIVATION, generation: 4 }, sequence: 11,
  }, true)
  writeJson(runPath, 'runtime/processes.json', {
    schemaVersion: 3, activationId: ACTIVATION, generationId: 4, sequence: 8, records: [],
  }, true)
  writeJson(runPath, 'cleanup/registry.json', {
    schemaVersion: 3, activationId: ACTIVATION, generationId: 4, sequence: 3, entries: [],
  }, true)
  writeJson(runPath, 'runtime/budget.json', {
    schemaVersion: '2.0.0', activationId: ACTIVATION, generation: 4, lastAccountingSequence: 6,
  })
  writeJson(runPath, 'runtime/recovery-checkpoint.json', {
    schemaVersion: '2.0.0', authority: { activationId: ACTIVATION, generation: 4 },
    lastCheckpointSequence: 5,
  })
  writeJson(runPath, 'terminal.json', {
    schemaVersion: 2, activationId: ACTIVATION, generation: 4, sequence: 11,
  }, true)
}

test('AP-RUN-032 r10 accepts only one exact current/predecessor activation lineage', t => {
  const runPath = temporaryRun(t)
  seedGenerationFour(runPath)
  const verdict = assertGenerationControlAuthority({
    runPath, activationId: ACTIVATION, generation: 5,
  })
  assert.equal(verdict.authorized, true)
  assert.equal(verdict.activationId, ACTIVATION)
  assert.equal(verdict.generation, 5)
  assert.equal(verdict.records.length, 6)
  assert.ok(verdict.records.every(record => record.generation === 4 && record.sequence >= 0))
})

test('AP-RUN-032 r10 denies stale, foreign, future, and unsequenced controls fail-closed', t => {
  const cases = [
    ['stale', record => { record.generationId = 3 }],
    ['foreign', record => { record.activationId = 'foreign-activation-r10' }],
    ['future', record => { record.generationId = 6 }],
    ['unsequenced', record => { delete record.sequence }],
  ]
  for (const [name, mutate] of cases) {
    const runPath = temporaryRun(t)
    const record = {
      schemaVersion: 3, activationId: ACTIVATION, generationId: 4, sequence: 1, records: [],
    }
    mutate(record)
    writeJson(runPath, 'runtime/processes.json', record, true)
    assert.throws(
      () => assertGenerationControlAuthority({ runPath, activationId: ACTIVATION, generation: 5 }),
      error => error instanceof GenerationControlError && error.code === 'GENERATION_CONTROL_DENIED' &&
        error.details.record === 'runtime/processes.json' && error.details.reason === name,
      name,
    )
  }
})

test('AP-RUN-032 r10 denies cross-generation log rows and unbound legacy controls', t => {
  const runPath = temporaryRun(t)
  fs.writeFileSync(path.join(runPath, 'runtime', 'accounting.jsonl'), [
    JSON.stringify({ activationId: ACTIVATION, generation: 4, sequence: 1 }),
    JSON.stringify({ activationId: ACTIVATION, generation: 5, sequence: 2 }),
    JSON.stringify({ activationId: ACTIVATION, generation: 4, sequence: 3 }),
    '',
  ].join('\n'))
  assert.throws(
    () => assertGenerationControlAuthority({ runPath, activationId: ACTIVATION, generation: 5 }),
    error => error.code === 'GENERATION_CONTROL_DENIED' && error.details.reason === 'cross-generation',
  )

  fs.rmSync(path.join(runPath, 'runtime', 'accounting.jsonl'))
  fs.writeFileSync(path.join(runPath, 'RUN-ENDED'), 'old shared marker\n')
  assert.throws(
    () => assertGenerationControlAuthority({ runPath, activationId: ACTIVATION, generation: 5 }),
    error => error.code === 'GENERATION_CONTROL_DENIED' && error.details.reason === 'unbound-legacy-control',
  )
})

test('AP-RUN-032 r10 is unconditionally wired before production control adapters', () => {
  const source = fs.readFileSync(path.join(WORKFLOW, 'phase-budget.js'), 'utf8')
  const functionStart = source.indexOf('function createDefaultRuntimeOptions(input)')
  const gateCall = source.indexOf('assertGenerationControlAuthority({', functionStart)
  const windowsAdapter = source.indexOf('createWindowsJobAdapter({', functionStart)
  const processOwner = source.indexOf('new ProcessOwner({', functionStart)
  assert.ok(functionStart >= 0 && gateCall > functionStart, 'default runtime must call the generation authority')
  assert.ok(gateCall < windowsAdapter && gateCall < processOwner,
    'generation authority must deny before adapters or process ownership can create side effects')
  const prefix = source.slice(functionStart, gateCall)
  assert.doesNotMatch(prefix, /generationControl(?:Enabled|Preflight)|AP_RUN_032/,
    'the production generation gate must not depend on an opt-in flag')
})

test('AP-RUN-032 r10 terminal control emission carries generation and sequence', () => {
  const stateSource = fs.readFileSync(path.join(WORKFLOW, 'runtime-state.js'), 'utf8')
  const finalizerSource = fs.readFileSync(path.join(WORKFLOW, 'finalizer.js'), 'utf8')
  assert.match(stateSource,
    /activationId: current\.activation\.id,\s+generation: current\.activation\.generation,\s+sequence: current\.sequence \+ 1,/)
  assert.match(stateSource,
    /activationId: current\.activation\.id,\s+generation: current\.activation\.generation,\s+sequence: sourceEvent\.sequence,/)
  assert.match(finalizerSource,
    /'runId', 'activationId', 'generation', 'sequence', 'missionHash'/,
    'terminal replay/validation must compare the emitted control authority')
})
