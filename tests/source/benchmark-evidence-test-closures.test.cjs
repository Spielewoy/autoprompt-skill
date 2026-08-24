'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const evidence = require('../../scripts/benchmark-evidence')

function temporary(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('AP-TEST-010 current snapshot replacement cannot retain a removed source file', t => {
  const directory = temporary(t, 'snapshot-replacement')
  const source = path.join(directory, 'source')
  const store = path.join(directory, 'store')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'retained.txt'), 'version A\n')
  fs.writeFileSync(path.join(source, 'removed-after-A.txt'), 'only in A\n')
  evidence.writeChecksums(source)

  const first = evidence.promoteSnapshot({
    sourceDir: source,
    storeDir: store,
    snapshotId: 'snapshot-a',
    sourceState: 'TERMINAL',
    manifestDigest: 'a'.repeat(64),
    observedAt: '2026-08-24T00:00:00.000Z',
  })

  fs.rmSync(path.join(source, 'removed-after-A.txt'))
  fs.writeFileSync(path.join(source, 'retained.txt'), 'version B\n')
  evidence.writeChecksums(source)
  const second = evidence.promoteSnapshot({
    sourceDir: source,
    storeDir: store,
    snapshotId: 'snapshot-b',
    sourceState: 'TERMINAL',
    manifestDigest: 'b'.repeat(64),
    observedAt: '2026-08-24T00:01:00.000Z',
  })

  const current = JSON.parse(fs.readFileSync(path.join(store, 'current.json'), 'utf8'))
  const currentSnapshot = path.join(store, 'snapshots', current.snapshotId)
  assert.equal(current.snapshotId, 'snapshot-b')
  assert.equal(evidence.verifySnapshot(currentSnapshot).valid, true)
  assert.equal(fs.readFileSync(path.join(currentSnapshot, 'retained.txt'), 'utf8'), 'version B\n')
  assert.equal(fs.existsSync(path.join(currentSnapshot, 'removed-after-A.txt')), false)
  assert.equal(fs.existsSync(path.join(first.snapshotPath, 'removed-after-A.txt')), true)
  assert.equal(second.snapshotManifest.files.some(file => file.path === 'removed-after-A.txt'), false)
})

test('AP-TEST-020 terminal state is derived from raw system and Harbor evidence, never task identity', () => {
  const normalSystem = { containerState: 'exited', exitCode: 0, signal: null, hostKillTriggered: false, cancelled: false }
  const cases = [
    ['PASS', { taskId: 'previously-hard-coded-name', system: normalSystem, harbor: { status: 'completed', result: 'pass' } }],
    ['FAIL', { taskId: 'previously-hard-coded-name', system: normalSystem, harbor: { status: 'completed', result: 'fail' } }],
    ['CANCELLED', { taskId: 'arbitrary-task', system: { ...normalSystem, cancelled: true }, harbor: { status: 'running' } }],
    ['CENSORED', { taskId: 'arbitrary-task', system: { ...normalSystem, hostKillTriggered: true }, harbor: { status: 'absent' } }],
    ['CRASH', { taskId: 'arbitrary-task', system: { ...normalSystem, exitCode: 7 }, harbor: { status: 'absent' } }],
    ['LIVE', { taskId: 'arbitrary-task', system: { ...normalSystem, containerState: 'running', exitCode: null }, harbor: { status: 'running' } }],
    ['ABSENT', { taskId: 'arbitrary-task', system: { ...normalSystem, containerState: 'absent', exitCode: null }, harbor: { status: 'absent' } }],
    ['UNKNOWN', { taskId: 'arbitrary-task', system: { ...normalSystem, containerState: 'exited', exitCode: null }, harbor: { status: 'completed', result: null } }],
  ]

  assert.deepEqual(cases.map(([, input]) => evidence.deriveTerminalState(input)), cases.map(([expected]) => expected))
  assert.equal(evidence.deriveTerminalState({ ...cases[0][1], taskId: 'a-different-name' }), 'PASS')
})

test('AP-TEST-022 every runtime resource identity must exactly match the run manifest', () => {
  const resources = {
    instanceId: 'instance-a',
    bucket: 'bucket-a',
    runRoot: '/runs/a',
    containerNamespace: 'containers-a',
    trialPrefix: 'trial-a',
  }
  const manifest = { resources }
  assert.deepEqual(evidence.assertManifestResources(manifest, { ...resources }), resources)

  for (const field of Object.keys(resources)) {
    assert.throws(
      () => evidence.assertManifestResources(manifest, { ...resources, [field]: `${resources[field]}-wrong` }),
      error => error.code === 'EVIDENCE_RESOURCE_MISMATCH',
      field,
    )
  }
  const missing = { ...resources }
  delete missing.trialPrefix
  assert.throws(() => evidence.assertManifestResources(manifest, missing), error => error.code === 'EVIDENCE_RESOURCE_MISMATCH')
  assert.throws(() => evidence.assertManifestResources(manifest, { ...resources, unregistered: 'forbidden' }), error => error.code === 'EVIDENCE_RESOURCE_MISMATCH')
})
