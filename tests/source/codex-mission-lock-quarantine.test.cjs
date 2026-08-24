#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { sha256, stableStringify } = require('../../agents/codex/workflow/event-log.js')
const { MissionLock } = require('../../agents/codex/workflow/mission-lock.js')

const QUARANTINE_RETRY_LIMIT = 32

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-mission-quarantine-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function fixture(t) {
  const directory = temporary(t)
  const targetPath = path.join(directory, 'target')
  const ledgerPath = path.join(targetPath, '.autoprompt')
  const leaseRoot = path.join(directory, 'leases')
  fs.mkdirSync(targetPath)
  const input = {
    targetPath,
    ledgerPath,
    runId: 'run-prior',
    activationId: 'activation-prior',
    missionHash: sha256('mission prior'),
    nonce: 'nonce_prior_1234567',
    generation: 1,
    pid: 101,
    processIdentity: 'process-prior',
    token: 'a'.repeat(48),
  }
  const prior = new MissionLock({
    leaseRoot,
    processIdentityObserver: (pid, identity) => identity,
    identityProbe: () => ({ alive: true, verified: true, ownedIdentityEvidence: [] }),
    randomId: () => 'lease-prior',
  })
  const lease = prior.acquire(input)
  const description = prior.describe(lease)
  return {
    directory,
    targetPath,
    ledgerPath,
    leaseRoot,
    input,
    description,
    ownerBytes: fs.readFileSync(description.ownerPath),
  }
}

function replacement(fixture, fsImpl = fs) {
  return new MissionLock({
    leaseRoot: fixture.leaseRoot,
    fsImpl,
    processIdentityObserver: (pid, identity) => pid === 202 ? identity : null,
    identityProbe: () => ({ alive: false, verified: true, ownedIdentityEvidence: [] }),
    randomId: () => 'lease-replacement',
  })
}

function replacementInput(fixture) {
  return {
    ...fixture.input,
    runId: 'run-replacement',
    activationId: 'activation-replacement',
    missionHash: sha256('mission replacement'),
    pid: 202,
    processIdentity: 'process-replacement',
    token: 'b'.repeat(48),
  }
}

function expectedQuarantineName(description, counter) {
  const owner = description.owner
  const bindingHash = sha256(stableStringify({
    schemaVersion: 1,
    targetKey: owner.targetKey,
    leaseId: owner.leaseId,
    priorOwnerChecksum: owner.checksum,
    activationId: owner.activationId,
    nonce: owner.nonce,
    generation: owner.generation,
  }))
  return `${path.basename(description.leasePath)}.stale.${owner.leaseId}.${bindingHash}.${String(counter).padStart(2, '0')}`
}

test('stale quarantine atomically retries attacker-precreated names without overwriting evidence', (t) => {
  const context = fixture(t)
  const attempted = []
  const destinations = []
  const injectedFs = Object.create(fs)
  injectedFs.existsSync = candidate => {
    if (String(candidate).includes('.stale.')) throw new Error('quarantine allocation must not use existsSync')
    return fs.existsSync(candidate)
  }
  injectedFs.mkdirSync = (candidate, options) => {
    if (!String(candidate).includes('.stale.')) return fs.mkdirSync(candidate, options)
    attempted.push(String(candidate))
    if (attempted.length <= 2) {
      fs.mkdirSync(candidate, options)
      fs.writeFileSync(path.join(candidate, 'attacker.txt'), `attacker-${attempted.length}`)
    }
    return fs.mkdirSync(candidate, options)
  }
  injectedFs.renameSync = (source, destination) => {
    if (String(destination).includes('.stale.')) {
      destinations.push({ source: String(source), destination: String(destination) })
    }
    return fs.renameSync(source, destination)
  }

  const lock = replacement(context, injectedFs)
  const capability = lock.acquire(replacementInput(context))
  const takeover = lock.describe(capability).owner.takeover

  assert.deepEqual(attempted.map(candidate => path.basename(candidate)), [0, 1, 2].map(counter =>
    expectedQuarantineName(context.description, counter)))
  assert.equal(fs.readFileSync(path.join(attempted[0], 'attacker.txt'), 'utf8'), 'attacker-1')
  assert.equal(fs.readFileSync(path.join(attempted[1], 'attacker.txt'), 'utf8'), 'attacker-2')
  assert.deepEqual(destinations, [{
    source: context.description.leasePath,
    destination: path.join(attempted[2], 'lease'),
  }])
  assert.equal(takeover.quarantineName, path.basename(attempted[2]))
  assert.deepEqual(fs.readFileSync(path.join(attempted[2], 'lease', 'owner.json')), context.ownerBytes)
})

test('stale quarantine collision retries are bounded and preserve the exact source', (t) => {
  const context = fixture(t)
  const attempted = []
  let renameCalls = 0
  const injectedFs = Object.create(fs)
  injectedFs.mkdirSync = (candidate, options) => {
    if (!String(candidate).includes('.stale.')) return fs.mkdirSync(candidate, options)
    attempted.push(String(candidate))
    fs.mkdirSync(candidate, options)
    fs.writeFileSync(path.join(candidate, 'attacker.txt'), path.basename(candidate))
    return fs.mkdirSync(candidate, options)
  }
  injectedFs.renameSync = (...args) => {
    renameCalls += 1
    return fs.renameSync(...args)
  }

  assert.throws(
    () => replacement(context, injectedFs).acquire(replacementInput(context)),
    error => error.code === 'LEASE_QUARANTINE_COLLISION' &&
      error.details.attempts === QUARANTINE_RETRY_LIMIT,
  )
  assert.equal(attempted.length, QUARANTINE_RETRY_LIMIT)
  assert.deepEqual(attempted.map(candidate => path.basename(candidate)),
    Array.from({ length: QUARANTINE_RETRY_LIMIT }, (_, counter) =>
      expectedQuarantineName(context.description, counter)))
  assert.equal(renameCalls, 0)
  assert.deepEqual(fs.readFileSync(context.description.ownerPath), context.ownerBytes)
  for (const candidate of attempted) {
    assert.equal(fs.readFileSync(path.join(candidate, 'attacker.txt'), 'utf8'), path.basename(candidate))
  }
})

test('stale quarantine rejects a source-directory swap and retains recoverable evidence', (t) => {
  const context = fixture(t)
  const parkedPrior = `${context.description.leasePath}.parked-prior`
  let quarantineLeasePath = null
  const injectedFs = Object.create(fs)
  injectedFs.renameSync = (source, destination) => {
    if (path.resolve(source) === path.resolve(context.description.leasePath) &&
        path.basename(destination) === 'lease') {
      quarantineLeasePath = String(destination)
      fs.renameSync(source, parkedPrior)
      fs.mkdirSync(source)
      fs.writeFileSync(path.join(source, 'owner.json'), context.ownerBytes)
      fs.writeFileSync(path.join(source, 'attacker-source.txt'), 'different physical directory')
    }
    return fs.renameSync(source, destination)
  }

  assert.throws(
    () => replacement(context, injectedFs).acquire(replacementInput(context)),
    error => error.code === 'LEASE_QUARANTINE_SOURCE_CHANGED' &&
      error.details.quarantineName === path.basename(path.dirname(quarantineLeasePath)),
  )
  assert.deepEqual(fs.readFileSync(path.join(parkedPrior, 'owner.json')), context.ownerBytes)
  assert.deepEqual(fs.readFileSync(path.join(quarantineLeasePath, 'owner.json')), context.ownerBytes)
  assert.equal(fs.readFileSync(path.join(quarantineLeasePath, 'attacker-source.txt'), 'utf8'),
    'different physical directory')
  assert.equal(fs.existsSync(context.description.leasePath), false)
})
