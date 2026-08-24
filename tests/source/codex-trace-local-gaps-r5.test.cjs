#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const { atomicWriteJson } = require(path.join(WORKFLOW, 'event-log.js'))
const { Finalizer } = require(path.join(WORKFLOW, 'finalizer.js'))
const { CentralScheduler } = require(path.join(WORKFLOW, 'scheduler.js'))
const { BudgetController } = require(path.join(WORKFLOW, 'budget-controller.js'))
const { terminalProducedEvidenceHashes } = require(path.join(WORKFLOW, 'runtime-state.js'))
const {
  assertRealTargetUnchanged,
  canonicalAssignmentResources,
  diagnosticDenialDisposition,
  workspaceFileSnapshot,
} = require(path.join(WORKFLOW, 'phase-budget.js'))

const H = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trace-r5-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('TRACE-003 production mutation baseline precedes the authorized permit', () => {
  const source = fs.readFileSync(path.join(WORKFLOW, 'phase-budget.js'), 'utf8')
  const write = source.indexOf('this.record.writePreMutationBaseline(baselineInput)')
  const read = source.indexOf('this.record.readPreMutationBaseline()', write)
  const begin = source.indexOf('this.options.mutationEnforcer.begin({', read)
  assert.ok(write > 0 && read > write && begin > read)
})

test('TRACE-004 finalizer rehashes deliverables and rejects stale activation', t => {
  const directory = temporary(t)
  const deliverable = path.join(directory, 'artifact.txt')
  const terminalPath = path.join(directory, 'terminal.json')
  fs.writeFileSync(deliverable, 'mutated')
  const terminal = {
    outcome: 'DONE', runId: 'run-trace', activationId: 'activation-old', missionHash: H('mission'),
    requestEnvelopeHash: H('request'), workspaceEpoch: 1,
    deliverableManifest: [{ path: deliverable, hash: H('original') }],
    deliverableManifestHash: H('manifest'), producedEvidenceHashes: [H('original')],
  }
  atomicWriteJson(terminalPath, { schemaVersion: 2, ...terminal, terminalEventSequence: 1,
    terminalEventHash: H('event'), terminalEventType: 'FINAL_RECORD_READY' })
  const finalizer = Object.create(Finalizer.prototype)
  Object.assign(finalizer, {
    fs,
    terminalPath,
    stateStore: {
      load: () => ({ activation: { id: 'activation-old' }, terminal }),
      validateTerminal: () => ({ valid: true }),
      eventLog: { readAll: () => [{ type: 'FINAL_RECORD_READY', hash: H('event') }] },
    },
  })
  assert.equal(finalizer.validateTerminalRecord().reason, 'DELIVERABLE_HASH_CHANGED')
  finalizer.stateStore.load = () => ({ activation: { id: 'activation-new' }, terminal })
  assert.equal(finalizer.validateTerminalRecord().reason, 'TERMINAL_ACTIVATION_STALE')
})

test('TRACE-006 and TRACE-007 retain product-signal timing and separate topology counts', () => {
  const scheduler = new CentralScheduler({ route: 'DIRECT', runIdentity: { runId: 'run-trace', generation: 1 } })
  const signal = scheduler.recordFirstProductSignal({ kind: 'RED', elapsedMs: 359999, evidenceHash: H('red') })
  assert.equal(signal.withinCeiling, true)
  assert.deepEqual(scheduler.recordTopologyCounts({
    frozenSnapshot: { sessions: 18, attempts: 21 }, livePartial: { sessions: 23, attempts: 29 },
  }), { frozenSnapshot: { sessions: 18, attempts: 21 }, livePartial: { sessions: 23, attempts: 29 } })
  assert.throws(() => scheduler.recordTopologyCounts({
    frozenSnapshot: { sessions: 19, attempts: 21 }, livePartial: { sessions: 23, attempts: 29 },
  }), error => error.code === 'TOPOLOGY_FROZEN_SNAPSHOT_CHANGED')
  const metrics = scheduler.getMetrics().economics
  assert.equal(metrics.firstProductSignal.kind, 'RED')
  assert.equal(metrics.topologyCounts.frozenSnapshot.sessions, 18)
  assert.equal(metrics.topologyCounts.livePartial.sessions, 23)
})

test('TRACE-010 DONE requires a usable deliverable and build acceptance', () => {
  const finalizer = Object.create(Finalizer.prototype)
  assert.throws(() => finalizer._assertDoneReadiness('DONE', [], [H('check')]),
    error => error.code === 'USER_USABLE_BUILD_REQUIRED')
  assert.throws(() => finalizer._assertDoneReadiness('DONE', [{ path: 'artifact', hash: H('artifact') }], []),
    error => error.code === 'BUILD_ACCEPTANCE_REQUIRED')
  assert.doesNotThrow(() => finalizer._assertDoneReadiness(
    'DONE', [{ path: 'artifact', hash: H('artifact') }], [H('check')],
  ))
})

test('TRACE-011 denies an external write at the absolute hard deadline', () => {
  let wall = Date.parse('2026-08-23T12:00:00.000Z')
  const budget = new BudgetController({
    limits: { wallMs: 1000, tokens: 10, sessions: 2, launches: 2 }, phases: {},
    monotonicMs: () => 0, wallNowMs: () => wall, wallClock: () => new Date(wall).toISOString(), bootId: null,
  })
  budget.bindDeadline({
    wallMs: 1000, verificationReserveMs: 250, finalizationReserveMs: 100, admittedAtMs: wall,
    deadline: { absoluteDeadline: new Date(wall + 1000).toISOString(), source: 'task-host',
      verificationReservePercent: 25, recoveryAndFinalizationReservePercent: 10 },
  })
  assert.equal(budget.assertExternalWriteAllowed({ operationId: 'write-1' }).allowed, true)
  wall += 1000
  assert.throws(() => budget.assertExternalWriteAllowed({ operationId: 'write-2', reconciledPartialStateHash: H('partial') }),
    error => error.code === 'EXTERNAL_WRITE_DEADLINE_EXPIRED' && error.details.reconciledPartialStateHash === H('partial'))
})

test('TRACE-013 diagnostic denial is BLOCKED with at most one worker', () => {
  assert.deepEqual(diagnosticDenialDisposition(1), { outcome: 'BLOCKED', workerCount: 1, startWorkers: false })
  assert.throws(() => diagnosticDenialDisposition(2), error => error.code === 'DIAGNOSTIC_WORKER_LIMIT')
})

test('TRACE-014 read-only resources carry positive current preimage hashes', t => {
  const directory = temporary(t)
  fs.writeFileSync(path.join(directory, 'input.txt'), 'current')
  const resources = canonicalAssignmentResources({
    request: { workItemId: 'check-1', ownership: ['input.txt'], manifests: [] },
    targetPath: directory, logicalRole: 'independent-checker', readOnly: true,
    enforcePreimages: false, additionalResources: [],
  })
  assert.equal(resources[0].access, 'read')
  assert.match(resources[0].expectedPreimageHash, /^[a-f0-9]{64}$/)
})

test('TRACE-021 terminal evidence is deduplicated, retained, and immutable', () => {
  const produced = terminalProducedEvidenceHashes([{ hash: H('artifact') }], [H('check'), H('artifact')])
  assert.deepEqual(produced, [H('artifact'), H('check')].sort())
  assert.equal(Object.isFrozen(produced), true)
  assert.throws(() => produced.push(H('later')), TypeError)
})

test('LAYER-025 proves a real-target write is denied before promotion', t => {
  const directory = temporary(t)
  childProcess.execFileSync('git', ['init', '--quiet'], { cwd: directory })
  fs.writeFileSync(path.join(directory, 'owned.txt'), 'before')
  childProcess.execFileSync('git', ['add', '--', 'owned.txt'], { cwd: directory })
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  const before = workspaceFileSnapshot(directory, environment)
  fs.writeFileSync(path.join(directory, 'owned.txt'), 'unauthorized')
  assert.throws(() => assertRealTargetUnchanged(before, directory, environment),
    error => error.code === 'REAL_TARGET_WRITE_DENIED' && error.details.changed.includes('owned.txt'))
})
