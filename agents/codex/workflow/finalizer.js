#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  atomicCreateJson,
  atomicWriteJson,
  fsyncDirectory,
  readChecksummedJson,
  sha256,
  stableStringify,
} = require('./event-log.js')
const { FINAL_OUTCOMES, hashFileStrict, isLegalTransition, normalizeManifest } = require('./runtime-state.js')

const CLEANUP_SCHEMA_VERSION = 3

class FinalizerError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'FinalizerError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new FinalizerError(code, message, details)
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

class CleanupRegistry {
  constructor(options) {
    if (!options || typeof options.registryPath !== 'string' || !Array.isArray(options.allowedRoots) ||
        !options.allowedRoots.length) {
      fail('CLEANUP_CONFIG_INVALID', 'cleanup registry requires registryPath and allowedRoots')
    }
    this.registryPath = path.resolve(options.registryPath)
    const controlBinding = options.controlBinding || {
      activationId: `standalone:${sha256(this.registryPath)}`,
      generationId: 1,
    }
    if (typeof controlBinding.activationId !== 'string' || !controlBinding.activationId ||
        !Number.isSafeInteger(controlBinding.generationId) || controlBinding.generationId < 1 ||
        (controlBinding.predecessorGenerationId !== undefined &&
          (!Number.isSafeInteger(controlBinding.predecessorGenerationId) || controlBinding.predecessorGenerationId < 1 ||
            controlBinding.predecessorGenerationId >= controlBinding.generationId))) {
      fail('CLEANUP_CONFIG_INVALID', 'cleanup registry control binding is invalid')
    }
    this.controlBinding = Object.freeze({
      activationId: controlBinding.activationId,
      generationId: controlBinding.generationId,
      predecessorGenerationId: controlBinding.predecessorGenerationId ?? null,
    })
    this.allowedRoots = options.allowedRoots.map((root) => path.resolve(root))
    this.fs = options.fsImpl || fs
    this.clock = options.clock || (() => new Date().toISOString())
    this.cleanup = options.cleanup || ((entry) => this.fs.rmSync(entry.path, { recursive: true, force: false }))
    this.randomId = options.randomId || (() => crypto.randomUUID())
  }

  register(entry) {
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) {
      fail('CLEANUP_ENTRY_INVALID', 'scratch registration requires an absolute path')
    }
    const target = path.resolve(entry.path)
    if (!this.allowedRoots.some((root) => isWithin(root, target))) {
      fail('CLEANUP_ENTRY_UNSAFE', `scratch path is outside registered cleanup roots: ${target}`)
    }
    const registry = this.load()
    if (registry.entries.some((item) => item.path === target && item.status !== 'CLEANED')) {
      fail('CLEANUP_ENTRY_DUPLICATE', `scratch path is already registered: ${target}`)
    }
    registry.entries.push({
      id: entry.id || this.randomId(),
      path: target,
      kind: entry.kind || 'scratch',
      owner: entry.owner || null,
      registeredAt: String(this.clock()),
      status: 'REGISTERED',
      cleanedAt: null,
    })
    this._write(registry)
    return registry.entries.at(-1)
  }

  load() {
    if (!this.fs.existsSync(this.registryPath)) {
      return {
        schemaVersion: CLEANUP_SCHEMA_VERSION,
        activationId: this.controlBinding.activationId,
        generationId: this.controlBinding.generationId,
        sequence: 0,
        entries: [],
      }
    }
    let registry
    try { registry = readChecksummedJson(this.registryPath, { fsImpl: this.fs }) } catch (error) {
      fail('CLEANUP_REGISTRY_FAILURE', 'cleanup registry cannot be validated', { cause: error.message })
    }
    if (registry.schemaVersion !== CLEANUP_SCHEMA_VERSION || !Array.isArray(registry.entries) ||
        typeof registry.activationId !== 'string' || !registry.activationId ||
        !Number.isSafeInteger(registry.generationId) || registry.generationId < 1 ||
        !Number.isSafeInteger(registry.sequence) || registry.sequence < 1) {
      fail('CLEANUP_REGISTRY_FAILURE', 'cleanup registry schema is invalid')
    }
    const currentBinding = registry.activationId === this.controlBinding.activationId &&
      registry.generationId === this.controlBinding.generationId
    const authorizedPredecessor = registry.activationId === this.controlBinding.activationId &&
      registry.generationId === this.controlBinding.predecessorGenerationId
    if (!currentBinding && !authorizedPredecessor) {
      fail('CLEANUP_CONTROL_BINDING_MISMATCH', 'cleanup registry belongs to a foreign activation generation')
    }
    return registry
  }

  run() {
    const registry = this.load()
    const pending = registry.entries
      .filter((entry) => entry.status === 'REGISTERED')
      .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
    for (const entry of pending) {
      const target = path.resolve(entry.path)
      if (!this.allowedRoots.some((root) => isWithin(root, target))) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup path is no longer safe: ${target}`)
      }
      if (this.fs.existsSync(target)) this.cleanup(entry)
      entry.status = 'CLEANED'
      entry.cleanedAt = String(this.clock())
      this._write(registry)
    }
    return pending.map((entry) => ({ ...entry }))
  }

  _write(registry) {
    const unsigned = {
      ...registry,
      schemaVersion: CLEANUP_SCHEMA_VERSION,
      activationId: this.controlBinding.activationId,
      generationId: this.controlBinding.generationId,
      sequence: registry.sequence + 1,
    }
    delete unsigned.checksum
    atomicWriteJson(this.registryPath, unsigned, { fsImpl: this.fs })
    registry.schemaVersion = unsigned.schemaVersion
    registry.activationId = unsigned.activationId
    registry.generationId = unsigned.generationId
    registry.sequence = unsigned.sequence
  }
}

class Finalizer {
  constructor(options) {
    if (!options || !options.stateStore || !options.processOwner || !options.missionLock || !options.capability ||
        !options.cleanupRegistry) {
      fail('FINALIZER_CONFIG_INVALID', 'finalizer requires state, process, lease, terminal, and cleanup dependencies')
    }
    this.stateStore = options.stateStore
    this.processOwner = options.processOwner
    this.missionLock = options.missionLock
    this.capability = options.capability
    const registered = this.stateStore.registeredPaths
    this.terminalPath = registered.terminalPath
    if (options.terminalPath && path.resolve(options.terminalPath) !== this.terminalPath) {
      fail('TERMINAL_PATH_UNREGISTERED', 'finalizer terminalPath is not the registered run-record terminal')
    }
    const relative = path.relative(registered.runRecordRoot, this.terminalPath)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      fail('TERMINAL_PATH_UNSAFE', 'registered terminal must be inside the run record')
    }
    const rootItem = (options.fsImpl || fs).lstatSync(registered.runRecordRoot)
    if (!rootItem.isDirectory() || rootItem.isSymbolicLink()) fail('TERMINAL_PATH_UNSAFE', 'run record root is not physical')
    const rootReal = (options.fsImpl || fs).realpathSync(registered.runRecordRoot)
    const parentReal = (options.fsImpl || fs).realpathSync(path.dirname(this.terminalPath))
    const physicalRelative = path.relative(rootReal, parentReal)
    if (path.isAbsolute(physicalRelative) || physicalRelative === '..' || physicalRelative.startsWith(`..${path.sep}`)) {
      fail('TERMINAL_PATH_UNSAFE', 'registered terminal parent escapes the physical run record')
    }
    this.cleanupRegistry = options.cleanupRegistry
    this.fs = options.fsImpl || fs
    this.clock = options.clock || (() => new Date().toISOString())
    this.beforeBoundary = options.beforeBoundary || (() => {})
    this.completionBoundary = typeof options.completionBoundary === 'function'
      ? options.completionBoundary : null
  }

  async finalize(options) {
    if (!options || !FINAL_OUTCOMES.includes(options.outcome)) {
      fail('OUTCOME_INVALID', 'finalizer requires a deterministic terminal outcome')
    }
    let state = this.stateStore.load()
    const manifest = normalizeManifest(options.deliverables || [])
    const checkHashes = Array.isArray(options.checkHashes) ? options.checkHashes : []
    this._assertDoneReadiness(options.outcome, manifest, checkHashes)
    let ownedIdentityEvidence = []
    const initialLease = this.missionLock.describe(this.capability)
    if (FINAL_OUTCOMES.includes(state.state) && initialLease.status === 'RELEASED') {
      const validation = this.validateTerminalRecord()
      if (!validation.valid) fail('TERMINAL_INVALID', `released finalization is inconsistent: ${validation.reason}`)
      this.missionLock.assertReleased(this.capability)
      return { state, terminal: readChecksummedJson(this.terminalPath, { fsImpl: this.fs }) }
    }
    if (initialLease.status === 'ACTIVE') this.missionLock.assertOwned(this.capability)
    else if (state.state !== 'RELEASING_LOCK') fail('FINALIZATION_DISAGREEMENT', 'released lease has no canonical pending terminal transition')
    if (options.expectedEpoch !== undefined && state.workspaceEpoch !== options.expectedEpoch) {
      fail('CONCURRENT_MUTATION', 'workspace epoch changed before finalization', {
        expected: options.expectedEpoch,
        actual: state.workspaceEpoch,
      })
    }

    if (initialLease.status === 'ACTIVE') {
      this.missionLock.updateOwnedProcesses(this.capability, this.processOwner.ownershipIdentities())
      this.beforeBoundary('drain-processes')
      await this.processOwner.cancelAll({
        reason: options.reason || 'deterministic finalization',
        graceMs: options.graceMs,
        killMs: options.killMs,
        terminalStatus: options.outcome,
      })
    }
    const leaseDescription = this.missionLock.describe(this.capability)
    await this.processOwner.assertTargetDrained(leaseDescription.owner.targetKey)
    if (initialLease.status === 'ACTIVE') {
      const history = Array.isArray(leaseDescription.owner.ownedProcessHistory)
        ? leaseDescription.owner.ownedProcessHistory
        : (leaseDescription.owner.ownedProcessIdentities || [])
      if (history.length && typeof this.processOwner.verifyDrainedIdentities !== 'function') {
        fail('PROCESS_DRAIN_UNVERIFIED', 'finalizer cannot prove every persisted owned identity drained')
      }
      ownedIdentityEvidence = history.length
        ? await this.processOwner.verifyDrainedIdentities(history)
        : []
      this.missionLock.updateOwnedProcesses(this.capability, [])
      this.missionLock.assertOwned(this.capability)
    }

    const protectedPaths = new Set(Object.values(this.stateStore.registeredPaths).map((entry) => path.resolve(entry)))
    for (const entry of manifest) {
      if (protectedPaths.has(path.resolve(entry.path))) {
        fail('TERMINAL_PATH_CONFLICT', `deliverable overlaps registered runtime authority: ${entry.path}`)
      }
    }
    this._verifyManifest(manifest)
    this.beforeBoundary('cleanup')
    this.cleanupRegistry.run()
    this._verifyManifest(manifest)
    if (this.completionBoundary) await this.completionBoundary()

    state = this.stateStore.load()
    if ((state.state === 'RELEASING_LOCK' || FINAL_OUTCOMES.includes(state.state)) && state.terminal) {
      const validation = this.stateStore.validateTerminal(state)
      if (!validation.valid || state.terminal.outcome !== options.outcome) {
        fail('TERMINAL_INVALID', `release recovery terminal is invalid: ${validation.reason || 'outcome mismatch'}`)
      }
    } else if (state.state === options.outcome && state.terminal) {
      const validation = this.stateStore.validateTerminal(state)
      if (!validation.valid) fail('TERMINAL_INVALID', `saved terminal result is invalid: ${validation.reason}`)
    } else if (state.state === 'RELEASING_LOCK') {
      this.beforeBoundary('release-intent-bind')
      state = this.stateStore.bindTerminal(options.outcome, {
        capability: this.capability,
        cause: options.reason || 'canonical release intent projected to its deterministic terminal outcome',
        deliverables: manifest,
        checkHashes: options.checkHashes || [],
        terminalEnvelope: options.terminalEnvelope || null,
        unblockPath: options.unblockPath || null,
      })
    } else if (state.state !== 'FINALIZING') {
      if (!isLegalTransition(state.state, 'FINALIZING', 'VERIFIED')) {
        fail('ILLEGAL_FINALIZATION_STATE', `cannot enter FINALIZING from ${state.state}`)
      }
      state = this.stateStore.transition('FINALIZING', {
        capability: this.capability,
        cause: options.reason || 'checks complete; drain and bind terminal result',
        eventId: 'VERIFIED',
      })
    }
    if (state.state === 'FINALIZING') {
      this.beforeBoundary('release-intent')
      state = this.stateStore.bindTerminal(options.outcome, {
        capability: this.capability,
        cause: options.reason || 'terminal result verified',
        deliverables: manifest,
        checkHashes: options.checkHashes || [],
        terminalEnvelope: options.terminalEnvelope || null,
      })
    }
    this._verifyManifest(manifest)
    const terminal = state.terminal
    const terminalEvent = terminal.releaseIntent
      ? this.stateStore.eventLog.readAll()[terminal.releaseIntent.eventSequence - 1]
      : this.stateStore.eventLog.readAll().findLast((event) => (
        event.type === 'FINAL_RECORD_READY' && event.details && event.details.terminal &&
        event.details.terminal.deliverableManifestHash === terminal.deliverableManifestHash
      ))
    if (!terminalEvent) fail('TERMINAL_EVENT_MISSING', 'hash-bound terminal event is missing from the event log')
    const terminalRecord = {
      schemaVersion: 2,
      ...terminal,
      terminalEventSequence: terminalEvent.sequence,
      terminalEventHash: terminalEvent.hash,
      terminalEventType: terminalEvent.type,
      writtenAt: String(this.clock()),
    }
    this.beforeBoundary('terminal-record')
    const record = this._createOrVerifyTerminal(terminalRecord)

    if (this.missionLock.describe(this.capability).status === 'ACTIVE') {
      this.beforeBoundary('lease-release')
      const releaseEvidence = this.stateStore.prepareReleaseReconciliation()
      this.missionLock.release(this.capability, { releaseEvidence, ownedIdentityEvidence })
    }
    this.missionLock.assertReleased(this.capability)
    if (state.state === 'RELEASING_LOCK') {
      this.beforeBoundary('released-state')
      state = this.stateStore.completeReleasedTerminal(options.outcome, {
        capability: this.capability,
        cause: 'owned resources were released after the final record became durable',
        checkHashes: options.checkHashes || [],
      })
    }
    state = this.stateStore.load()
    const finalAgreement = this.validateTerminalRecord()
    if (state.state !== options.outcome || !finalAgreement.valid) {
      fail('FINALIZATION_DISAGREEMENT', `release completed without full terminal agreement: ${finalAgreement.reason || state.state}`)
    }
    return { state, terminal: record }
  }

  validateTerminalRecord() {
    const state = this.stateStore.load()
    const validation = this.stateStore.validateTerminal(state)
    if (!validation.valid) return validation
    let record
    try { record = readChecksummedJson(this.terminalPath, { fsImpl: this.fs }) } catch (error) {
      return { valid: false, reason: 'TERMINAL_RECORD_INVALID', cause: error.message }
    }
    const expected = state.terminal
    if (state.activation && expected.activationId !== state.activation.id) {
      return { valid: false, reason: 'TERMINAL_ACTIVATION_STALE' }
    }
    for (const field of [
      'outcome', 'runId', 'activationId', 'generation', 'sequence', 'missionHash', 'requestEnvelopeHash',
      'workspaceEpoch', 'deliverableManifestHash',
    ]) {
      if (record[field] !== expected[field]) return { valid: false, reason: 'TERMINAL_RECORD_FOREIGN', field }
    }
    if (stableStringify(record.deliverableManifest || []) !== stableStringify(expected.deliverableManifest || [])) {
      return { valid: false, reason: 'TERMINAL_RECORD_FOREIGN', field: 'deliverableManifest' }
    }
    if (stableStringify(record.producedEvidenceHashes || []) !== stableStringify(expected.producedEvidenceHashes || [])) {
      return { valid: false, reason: 'TERMINAL_RECORD_FOREIGN', field: 'producedEvidenceHashes' }
    }
    try {
      this._verifyManifest(normalizeManifest(expected.deliverableManifest || []))
    } catch (error) {
      return {
        valid: false,
        reason: error && error.code === 'CONCURRENT_MUTATION'
          ? 'DELIVERABLE_HASH_CHANGED' : 'DELIVERABLE_MISSING_OR_UNSAFE',
        cause: error && error.message,
      }
    }
    const terminalEvent = this.stateStore.eventLog.readAll()[record.terminalEventSequence - 1]
    const expectedEventType = expected.releaseIntent ? expected.releaseIntent.eventId : 'FINAL_RECORD_READY'
    if (!terminalEvent || terminalEvent.type !== expectedEventType || terminalEvent.hash !== record.terminalEventHash) {
      return {
        valid: false,
        reason: 'TERMINAL_EVENT_MISMATCH',
        expectedType: expectedEventType,
        actualType: terminalEvent && terminalEvent.type,
        expectedHash: record.terminalEventHash,
        actualHash: terminalEvent && terminalEvent.hash,
      }
    }
    return { valid: true, terminal: expected }
  }

  _assertDoneReadiness(outcome, manifest, checkHashes) {
    if (outcome !== 'DONE') return
    if (manifest.length === 0) {
      fail('USER_USABLE_BUILD_REQUIRED', 'DONE requires at least one current user-usable deliverable')
    }
    if (checkHashes.length === 0 || checkHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
      fail('BUILD_ACCEPTANCE_REQUIRED', 'DONE requires completed hash-bound build acceptance')
    }
  }

  _verifyManifest(manifest) {
    for (const entry of manifest) {
      let actual
      try { actual = hashFileStrict(entry.path, this.fs) } catch (error) {
        fail('DELIVERABLE_UNSAFE', `cannot verify deliverable: ${entry.path}`, { cause: error.message })
      }
      if (actual !== entry.hash) {
        fail('CONCURRENT_MUTATION', `deliverable changed before terminal bind: ${entry.path}`, {
          expected: entry.hash,
          actual,
        })
      }
    }
    const manifestHash = sha256(stableStringify(manifest))
    return manifestHash
  }

  _createOrVerifyTerminal(record) {
    if (this.fs.existsSync(this.terminalPath)) {
      let existing
      try { existing = readChecksummedJson(this.terminalPath, { fsImpl: this.fs }) } catch (error) {
        fail('TERMINAL_RECORD_INVALID', 'registered terminal exists but is not valid', { cause: error.message })
      }
      for (const field of [
        'schemaVersion', 'outcome', 'runId', 'activationId', 'generation', 'sequence', 'missionHash',
        'requestEnvelopeHash', 'workspaceEpoch', 'deliverableManifestHash',
        'terminalEventSequence', 'terminalEventHash',
        'terminalEventType',
      ]) {
        if (existing[field] !== record[field]) fail('TERMINAL_RECORD_CONFLICT', `registered terminal conflicts on ${field}`)
      }
      for (const field of ['deliverableManifest', 'producedEvidenceHashes', 'terminalEnvelope', 'releaseIntent']) {
        if (stableStringify(existing[field] === undefined ? null : existing[field]) !==
            stableStringify(record[field] === undefined ? null : record[field])) {
          fail('TERMINAL_RECORD_CONFLICT', `registered terminal conflicts on ${field}`)
        }
      }
      fsyncDirectory(path.dirname(this.terminalPath), this.fs)
      return existing
    }
    try { return atomicCreateJson(this.terminalPath, record, { fsImpl: this.fs }) } catch (error) {
      if (error && error.code === 'EEXIST') return this._createOrVerifyTerminal(record)
      fail('TERMINAL_RECORD_FAILURE', 'registered terminal could not be created atomically', { cause: error.message })
    }
  }
}

module.exports = {
  CLEANUP_SCHEMA_VERSION,
  CleanupRegistry,
  Finalizer,
  FinalizerError,
}
