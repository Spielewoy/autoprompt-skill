'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')
const { atomicWriteJson, readChecksummedJson } = require('../../agents/codex/workflow/event-log.js')

const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64)
const expected = (hash = HASH_A) => ({ reservationId: 'reservation-1', sessionId: 'session-1', targetKey: 'target-1', launchBindingHash: hash })

class BoundAdapter {
  constructor() {
    this.kind = 'test'
    this.capabilities = { groupAtCreation: true, descendantEnumeration: true, groupSignal: true, stableIdentity: true, persistentIdentity: true, reservationRecovery: true }
    this.groups = new Map(); this.reservations = new Map(); this.probes = new Map(); this.spawnFailure = null; this.spawnDeferred = null
    this.signalGate = null; this.signalStarted = 0; this.nextPid = 700
  }
  async admit() { return { supported: true } }
  async spawnOwned(spec) {
    if (this.spawnDeferred) return this.spawnDeferred.promise
    if (this.spawnFailure) throw this.spawnFailure
    const rootPid = this.nextPid++, groupIdentity = `group-${rootPid}`
    this.groups.set(groupIdentity, [rootPid]); this.reservations.set(spec.reservationId, { rootPid, groupIdentity })
    return { rootPid, groupIdentity }
  }
  async recoverReservation(id) {
    const value = this.reservations.get(id)
    return value && (this.groups.get(value.groupIdentity) || []).length ? { ...value } : null
  }
  async probeReservation(record) {
    if (this.probes.has(record.reservationId)) return this.probes.get(record.reservationId)
    const ownership = await this.recoverReservation(record.reservationId)
    return ownership ? { state: 'LIVE', ownership } : { state: 'DEAD', evidence: { source: 'test' } }
  }
  async listOwned(id) { return [...(this.groups.get(id) || [])] }
  async signalOwned(id) {
    this.signalStarted += 1
    if (this.signalGate) await this.signalGate.promise
    this.groups.set(id, [])
  }
  async verifyOwnership() { return true }
  async listTargetOwned() { return [...this.groups.values()].flat() }
  async probeOwnedIdentity(identity) {
    if (identity.kind === 'test') return this.listOwned(identity.id)
    if (identity.kind === 'test-reservation') {
      const ownership = await this.recoverReservation(identity.id)
      return ownership ? [ownership] : []
    }
    throw Object.assign(new Error('foreign identity'), { code: 'PROCESS_IDENTITY_INVALID' })
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for focused ownership state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function fixture(t, adapter = new BoundAdapter(), name = 'processes.json') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bound-drain-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const registryPath = path.join(directory, name)
  const owner = new ProcessOwner({ adapter, registryPath, allowTestAdapter: true, pollMs: 0, startupTimeoutMs: 20, adapterCallTimeoutMs: 50 })
  return { directory, registryPath, adapter, owner }
}

async function launch(owner, hash = HASH_A) {
  return owner.launch({ executable: 'fixture', argv: [], reservationId: 'reservation-1', sessionId: 'session-1', targetKey: 'target-1', launchBindingHash: hash })
}

test('optional launch binding persists while legacy records reopen without one', async t => {
  const legacy = fixture(t)
  const old = await legacy.owner.launch({ executable: 'fixture', argv: [], reservationId: 'legacy-r', sessionId: 'legacy-s', targetKey: 'legacy-t' })
  await legacy.owner.cancelGroup(old.ownershipId, { graceMs: 0, killMs: 1 })
  const reopenedLegacy = new ProcessOwner({ adapter: legacy.adapter, registryPath: legacy.registryPath, allowTestAdapter: true })
  assert.equal(reopenedLegacy.listRecords()[0].launchBindingHash, null)
  await assert.rejects(reopenedLegacy.issueBoundDrainReceipt({
    reservationId: 'legacy-r', sessionId: 'legacy-s', targetKey: 'legacy-t', launchBindingHash: HASH_A,
  }), { code: 'PROCESS_IDENTITY_INVALID' })

  const bound = fixture(t)
  const running = await launch(bound.owner)
  assert.equal(bound.owner.listRecords()[0].launchBindingHash, HASH_A)
  await bound.owner.cancelGroup(running.ownershipId, { graceMs: 0, killMs: 1 })
  const reopened = new ProcessOwner({ adapter: bound.adapter, registryPath: bound.registryPath, allowTestAdapter: true })
  assert.equal(reopened.listRecords()[0].launchBindingHash, HASH_A)
  await assert.rejects(reopened.issueBoundDrainReceipt(expected(HASH_B)), { code: 'PROCESS_IDENTITY_INVALID' })
})

test('persisted malformed launch binding is rejected on restore', async t => {
  const invalid = fixture(t, new BoundAdapter(), 'invalid-launch.json')
  await assert.rejects(invalid.owner.launch({
    executable: 'fixture', argv: [], reservationId: 'bad-r', sessionId: 'bad-s', targetKey: 'bad-t',
    launchBindingHash: { toString: () => HASH_A },
  }), { code: 'LAUNCH_SPEC_INVALID' })
  const f = fixture(t), running = await launch(f.owner)
  await f.owner.cancelGroup(running.ownershipId, { graceMs: 0, killMs: 1 })
  const registry = readChecksummedJson(f.registryPath)
  registry.records[0].launchBindingHash = 'A'.repeat(64)
  const { checksum: _checksum, ...body } = registry
  atomicWriteJson(f.registryPath, body)
  assert.throws(() => new ProcessOwner({ adapter: f.adapter, registryPath: f.registryPath, allowTestAdapter: true }), { code: 'PROCESS_REGISTRY_FAILURE' })
})

test('bound receipts reject running groups unless explicitly drained and reject forged or foreign-owner values', async t => {
  const f = fixture(t), running = await launch(f.owner)
  const recoveredOwner = new ProcessOwner({
    adapter: f.adapter,
    registryPath: f.registryPath,
    allowTestAdapter: true,
    pollMs: 0,
    startupTimeoutMs: 20,
    adapterCallTimeoutMs: 50,
  })
  await assert.rejects(recoveredOwner.issueBoundDrainReceipt(expected()), { code: 'PROCESS_DRAIN_TIMEOUT' })
  const receipt = await recoveredOwner.issueBoundDrainReceipt(expected(), { drainRunning: true })
  assert.equal(recoveredOwner.verifyBoundDrainReceipt(receipt, expected()), true)
  assert.throws(() => recoveredOwner.verifyBoundDrainReceipt({ ...receipt }, expected()), { code: 'PROCESS_IDENTITY_INVALID' })
  assert.throws(() => recoveredOwner.verifyBoundDrainReceipt(receipt, expected(HASH_B)), { code: 'PROCESS_IDENTITY_INVALID' })
  assert.throws(() => f.owner.verifyBoundDrainReceipt(receipt, expected()), { code: 'PROCESS_IDENTITY_INVALID' })
  const foreign = fixture(t, new BoundAdapter(), 'foreign.json')
  assert.throws(() => foreign.owner.verifyBoundDrainReceipt(receipt, expected()), { code: 'PROCESS_IDENTITY_INVALID' })
  assert.equal(recoveredOwner.listRecords().find(record => record.ownershipId === running.ownershipId).status, 'LOST')
})

test('reserved pending, unknown, and invalid states retain authority while conclusively dead recovery can issue', async t => {
  for (const state of ['PENDING', 'UNKNOWN', 'INVALID']) {
    const f = fixture(t, new BoundAdapter(), `${state}.json`)
    f.adapter.spawnFailure = Object.assign(new Error('physical launch unresolved'), { code: 'START_FAILED' })
    await assert.rejects(launch(f.owner), { code: 'START_FAILED' })
    f.adapter.probes.set('reservation-1', state === 'INVALID' ? { state: 'BOGUS' } : { state, evidence: { exact: state } })
    await assert.rejects(f.owner.issueBoundDrainReceipt(expected(), { drainRunning: true }),
      { code: state === 'PENDING' ? 'OWNERSHIP_RECOVERY_PENDING' : 'OWNERSHIP_RECOVERY_FATAL' })
    assert.equal(f.owner.listRecords()[0].status, 'RESERVED')
  }
  const dead = fixture(t, new BoundAdapter(), 'dead.json')
  dead.adapter.spawnFailure = Object.assign(new Error('did not start'), { code: 'START_FAILED' })
  await assert.rejects(launch(dead.owner), { code: 'START_FAILED' })
  dead.adapter.probes.set('reservation-1', { state: 'DEAD', evidence: { exact: 'dead' } })
  const recoveredOwner = new ProcessOwner({ adapter: dead.adapter, registryPath: dead.registryPath, allowTestAdapter: true })
  const receipt = await recoveredOwner.issueBoundDrainReceipt(expected())
  assert.equal(recoveredOwner.verifyBoundDrainReceipt(receipt, expected()), true)
  assert.equal(recoveredOwner.listRecords()[0].status, 'FAILED')
})

test('fresh owner recovers an exact live reservation before explicitly draining it', async t => {
  const f = fixture(t, new BoundAdapter(), 'live-recovery.json')
  f.adapter.spawnDeferred = deferred()
  await assert.rejects(launch(f.owner), { code: 'PROCESS_DRAIN_TIMEOUT' })

  const ownership = { rootPid: 812, groupIdentity: 'group-812' }
  f.adapter.groups.set(ownership.groupIdentity, [ownership.rootPid])
  f.adapter.reservations.set('reservation-1', ownership)
  f.adapter.probes.delete('reservation-1')
  const recoveredOwner = new ProcessOwner({ adapter: f.adapter, registryPath: f.registryPath, allowTestAdapter: true })
  await assert.rejects(recoveredOwner.issueBoundDrainReceipt(expected()), { code: 'PROCESS_DRAIN_TIMEOUT' })
  assert.equal(recoveredOwner.listRecords()[0].status, 'RUNNING')
  const receipt = await recoveredOwner.issueBoundDrainReceipt(expected(), { drainRunning: true })
  assert.equal(recoveredOwner.verifyBoundDrainReceipt(receipt, expected()), true)
})

test('late physical spawn fence cannot issue a receipt before the exact late group drains', async t => {
  const f = fixture(t, new BoundAdapter(), 'late-spawn.json')
  const spawn = deferred(), signal = deferred()
  f.adapter.spawnDeferred = spawn
  f.adapter.signalGate = signal
  await assert.rejects(launch(f.owner), { code: 'PROCESS_DRAIN_TIMEOUT' })
  await assert.rejects(f.owner.issueBoundDrainReceipt(expected(), { drainRunning: true }), error =>
    ['OWNERSHIP_RECOVERY_PENDING', 'OWNERSHIP_RECOVERY_FATAL'].includes(error.code))

  const ownership = { rootPid: 913, groupIdentity: 'group-913' }
  f.adapter.groups.set(ownership.groupIdentity, [ownership.rootPid])
  f.adapter.reservations.set('reservation-1', ownership)
  spawn.resolve(ownership)
  await waitFor(() => f.adapter.signalStarted > 0)
  await assert.rejects(f.owner.issueBoundDrainReceipt(expected()), { code: 'PROCESS_DRAIN_TIMEOUT' })
  assert.deepEqual(f.adapter.groups.get(ownership.groupIdentity), [ownership.rootPid])
  signal.resolve()
  await waitFor(() => f.owner.listRecords()[0].status === 'FAILED')
  const receipt = await f.owner.issueBoundDrainReceipt(expected())
  assert.equal(f.owner.verifyBoundDrainReceipt(receipt, expected()), true)
})

test('terminal records are freshly re-probed and live reservation or group identities refuse receipts', async t => {
  const f = fixture(t), running = await launch(f.owner)
  await f.owner.cancelGroup(running.ownershipId, { graceMs: 0, killMs: 1 })
  f.adapter.groups.set(running.groupIdentity, [running.rootPid])
  await assert.rejects(f.owner.issueBoundDrainReceipt(expected()), { code: 'PROCESS_DRAIN_TIMEOUT' })
  f.adapter.groups.set(running.groupIdentity, [])
  f.adapter.reservations.set('reservation-1', { rootPid: 999, groupIdentity: 'foreign-live' })
  f.adapter.groups.set('foreign-live', [999])
  await assert.rejects(f.owner.issueBoundDrainReceipt(expected()), { code: 'PROCESS_DRAIN_TIMEOUT' })
  f.adapter.groups.set('foreign-live', [])
  const receipt = await f.owner.issueBoundDrainReceipt(expected())
  assert.equal(f.owner.verifyBoundDrainReceipt(receipt, expected()), true)
})
