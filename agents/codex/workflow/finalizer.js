#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  atomicWriteJson,
  canonicalize,
  checksumRecord,
  fsyncDirectory,
  readChecksummedJson,
  sha256,
  stableStringify,
} = require('./event-log.js')
const {
  FINAL_OUTCOMES,
  directoryDescriptorAnchor,
  hashManifestEntryStrict,
  isLegalTransition,
  normalizeManifest,
  readFileStrict,
  withStrictAnchoredManifestPath,
} = require('./runtime-state.js')
const {
  createTerminalFinalizationIntentAuthority,
  recoverTerminalPublicationResiduesAnchored,
} = require('./run-record.js')

const CLEANUP_SCHEMA_VERSION = 4

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

function cleanupTargetIdentity(item, target) {
  const type = item && item.isDirectory()
    ? 'directory'
    : item && item.isFile() ? 'file' : null
  if (!type || item.isSymbolicLink()) {
    fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup target is linked or not a regular filesystem entry: ${target}`)
  }
  return Object.freeze({ type, dev: String(item.dev), ino: String(item.ino) })
}

function sameCleanupTargetIdentity(expected, actual) {
  return Boolean(expected && actual && expected.type === actual.type &&
    expected.dev === actual.dev && expected.ino === actual.ino)
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
    if (options.cleanup !== undefined && typeof options.cleanup !== 'function') {
      fail('CLEANUP_CONFIG_INVALID', 'cleanup override must be a function')
    }
    this.cleanup = options.cleanup || null
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
    const identities = this._withCleanupTarget(target, (anchoredTarget, _verify, parentIdentity) => ({
      parentIdentity,
      targetIdentity: cleanupTargetIdentity(this.fs.lstatSync(anchoredTarget), target),
    }))
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
      parentIdentity: identities.parentIdentity,
      targetIdentity: identities.targetIdentity,
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
    if (registry.entries.some((entry) => !entry || typeof entry !== 'object' ||
        typeof entry.id !== 'string' || !entry.id || typeof entry.path !== 'string' ||
        !path.isAbsolute(entry.path) || path.resolve(entry.path) !== entry.path ||
        !['REGISTERED', 'CLEANED'].includes(entry.status) ||
        !entry.parentIdentity || typeof entry.parentIdentity.dev !== 'string' || !entry.parentIdentity.dev ||
        typeof entry.parentIdentity.ino !== 'string' || !entry.parentIdentity.ino ||
        !entry.targetIdentity || !['directory', 'file'].includes(entry.targetIdentity.type) ||
        typeof entry.targetIdentity.dev !== 'string' || !entry.targetIdentity.dev ||
        typeof entry.targetIdentity.ino !== 'string' || !entry.targetIdentity.ino)) {
      fail('CLEANUP_REGISTRY_FAILURE', 'cleanup registry entries are invalid')
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
      this._withCleanupTarget(target, (anchoredTarget, _verify, parentIdentity) => {
        if (parentIdentity.dev !== entry.parentIdentity.dev || parentIdentity.ino !== entry.parentIdentity.ino) {
          fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup parent changed physical identity: ${target}`)
        }
        let item
        try { item = this.fs.lstatSync(anchoredTarget) } catch (error) {
          if (error && error.code === 'ENOENT') return
          throw error
        }
        const liveIdentity = cleanupTargetIdentity(item, target)
        if (!sameCleanupTargetIdentity(entry.targetIdentity, liveIdentity)) {
          fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup target changed physical identity: ${target}`)
        }
        if (this.cleanup) {
          this.cleanup(Object.freeze({ ...entry, path: anchoredTarget, registeredPath: target }))
        } else {
          this._removeOwnedTarget(anchoredTarget, target, entry.targetIdentity)
        }
        try {
          this.fs.lstatSync(anchoredTarget)
          fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup target still exists after cleanup: ${target}`)
        } catch (error) {
          if (error instanceof FinalizerError) throw error
          if (!error || error.code !== 'ENOENT') throw error
        }
        fsyncDirectory(path.dirname(anchoredTarget), this.fs)
      })
      entry.status = 'CLEANED'
      entry.cleanedAt = String(this.clock())
      this._write(registry)
    }
    return pending.map((entry) => ({ ...entry }))
  }

  _withCleanupTarget(target, operation) {
    try {
      return withStrictAnchoredManifestPath(target, this.fs, operation)
    } catch (error) {
      if (error instanceof FinalizerError) throw error
      fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup target cannot be used through a stable physical parent: ${target}`, {
        cause: error && (error.code || error.message),
      })
    }
  }

  _removeOwnedTarget(anchoredTarget, registeredPath, expectedIdentity) {
    if (expectedIdentity.type === 'file') {
      this._removeOwnedFile(anchoredTarget, registeredPath, expectedIdentity)
      return
    }
    this._removeOwnedDirectory(anchoredTarget, registeredPath, expectedIdentity)
  }

  _removeOwnedFile(anchoredFile, registeredPath, expectedIdentity) {
    let descriptor
    try {
      const initial = this.fs.lstatSync(anchoredFile)
      const initialIdentity = cleanupTargetIdentity(initial, registeredPath)
      if (initialIdentity.type !== 'file' || !sameCleanupTargetIdentity(expectedIdentity, initialIdentity)) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup file changed physical identity: ${registeredPath}`)
      }
      descriptor = this.fs.openSync(
        anchoredFile,
        fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0),
      )
      const openedIdentity = cleanupTargetIdentity(this.fs.fstatSync(descriptor), registeredPath)
      if (!sameCleanupTargetIdentity(expectedIdentity, openedIdentity)) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup file changed while it was opened: ${registeredPath}`)
      }
      this.fs.closeSync(descriptor)
      descriptor = undefined
      const liveIdentity = cleanupTargetIdentity(this.fs.lstatSync(anchoredFile), registeredPath)
      if (!sameCleanupTargetIdentity(expectedIdentity, liveIdentity)) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup file changed before removal: ${registeredPath}`)
      }
      // This is deliberately non-recursive.  A last-instruction replacement
      // can at worst make unlink fail or unlink one leaf; it cannot redirect a
      // recursive remover into a foreign directory tree.
      this.fs.unlinkSync(anchoredFile)
    } finally {
      if (descriptor !== undefined) this.fs.closeSync(descriptor)
    }
  }

  _removeOwnedDirectory(anchoredDirectory, registeredPath, expectedIdentity) {
    let descriptor
    try {
      const initial = this.fs.lstatSync(anchoredDirectory)
      const initialIdentity = cleanupTargetIdentity(initial, registeredPath)
      if (initialIdentity.type !== 'directory' ||
          !sameCleanupTargetIdentity(expectedIdentity, initialIdentity)) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup directory changed physical identity: ${registeredPath}`)
      }
      descriptor = this.fs.openSync(
        anchoredDirectory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      )
      const openedIdentity = cleanupTargetIdentity(this.fs.fstatSync(descriptor), registeredPath)
      if (!sameCleanupTargetIdentity(expectedIdentity, openedIdentity)) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup directory changed while it was opened: ${registeredPath}`)
      }
      this._removeOwnedDirectoryContents(descriptor, registeredPath)
      const afterIdentity = cleanupTargetIdentity(this.fs.fstatSync(descriptor), registeredPath)
      if (!sameCleanupTargetIdentity(expectedIdentity, afterIdentity)) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup directory changed during removal: ${registeredPath}`)
      }
      const liveIdentity = cleanupTargetIdentity(this.fs.lstatSync(anchoredDirectory), registeredPath)
      if (!sameCleanupTargetIdentity(expectedIdentity, liveIdentity)) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup directory changed before removal: ${registeredPath}`)
      }
      // Never delegate an attacker-mutable basename to a recursive remover.
      // All recursion above is descriptor-relative; this final named operation
      // is non-recursive and cannot consume a replacement directory's bytes.
      this.fs.rmdirSync(anchoredDirectory)
    } finally {
      if (descriptor !== undefined) this.fs.closeSync(descriptor)
    }
  }

  _removeOwnedDirectoryContents(descriptor, registeredPath) {
    const anchor = directoryDescriptorAnchor(descriptor, this.fs)
    const names = this.fs.readdirSync(anchor).sort((left, right) => left.localeCompare(right))
    for (const name of names) {
      if (typeof name !== 'string' || !name || name === '.' || name === '..' || path.basename(name) !== name) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup directory returned an unsafe child name: ${registeredPath}`)
      }
      const anchoredChild = path.join(anchor, name)
      const displayedChild = path.join(registeredPath, name)
      const initial = this.fs.lstatSync(anchoredChild)
      if (initial.isSymbolicLink()) {
        fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup directory contains a linked child: ${displayedChild}`)
      }
      const identity = cleanupTargetIdentity(initial, displayedChild)
      if (identity.type === 'directory') {
        this._removeOwnedDirectory(anchoredChild, displayedChild, identity)
      } else {
        this._removeOwnedFile(anchoredChild, displayedChild, identity)
      }
    }
    if (this.fs.readdirSync(anchor).length !== 0) {
      fail('CLEANUP_ENTRY_UNSAFE', `registered cleanup directory changed while it was emptied: ${registeredPath}`)
    }
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
    if (options.runRecord) {
      if (typeof options.runRecord.runPath !== 'string' ||
          path.resolve(options.runRecord.runPath) !== registered.runRecordRoot ||
          typeof options.runRecord.createOrVerifyTerminalFinalizationIntent !== 'function' ||
          typeof options.runRecord.readTerminalFinalizationIntent !== 'function') {
        fail('FINALIZATION_INTENT_AUTHORITY_INVALID', 'finalizer runRecord is not the opened registered intent authority')
      }
      this.finalizationIntentAuthority = Object.freeze({
        createOrVerify: input => options.runRecord.createOrVerifyTerminalFinalizationIntent(input),
        read: () => options.runRecord.readTerminalFinalizationIntent(),
      })
    } else if (registered.terminalFinalizationIntentPath) {
      this.finalizationIntentAuthority = createTerminalFinalizationIntentAuthority(
        registered.runRecordRoot,
        { fsImpl: this.fs },
      )
    } else this.finalizationIntentAuthority = null
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
    const finalizationReason = options.reason || 'deterministic finalization'
    this._assertDoneReadiness(options.outcome, manifest, checkHashes)
    const finalResponseValidation = this._validateFinalResponse(
      options.finalResponse === undefined ? null : options.finalResponse,
      manifest,
    )
    if (!finalResponseValidation.valid) {
      fail('FINAL_RESPONSE_INVALID', `structured final response is not authentic: ${finalResponseValidation.reason}`, {
        ...finalResponseValidation,
      })
    }
    const finalizationIntent = this._createOrVerifyFinalizationIntent(state, options, manifest, checkHashes)
    this.beforeBoundary('terminal-finalization-intent-durable')
    let ownedIdentityEvidence = []
    const initialLease = this.missionLock.describe(this.capability)
    if (FINAL_OUTCOMES.includes(state.state) && initialLease.status === 'RELEASED') {
      const validation = this.validateTerminalRecord()
      if (!validation.valid) fail('TERMINAL_INVALID', `released finalization is inconsistent: ${validation.reason}`)
      this.missionLock.assertReleased(this.capability)
      return { state, terminal: this._readTerminalRecord(), finalizationIntent }
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
        reason: finalizationReason,
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
        cause: finalizationReason,
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
        cause: finalizationReason,
        eventId: 'VERIFIED',
      })
    }
    if (state.state === 'FINALIZING') {
      this.beforeBoundary('release-intent')
      state = this.stateStore.bindTerminal(options.outcome, {
        capability: this.capability,
        cause: finalizationReason,
        deliverables: manifest,
        checkHashes: options.checkHashes || [],
        terminalEnvelope: options.terminalEnvelope || null,
        unblockPath: options.unblockPath || null,
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
    return { state, terminal: record, finalizationIntent }
  }

  validateTerminalRecord() {
    const state = this.stateStore.load()
    const validation = this.stateStore.validateTerminal(state)
    if (!validation.valid) return validation
    let record
    try { record = this._readTerminalRecord() } catch (error) {
      return { valid: false, reason: 'TERMINAL_RECORD_INVALID', cause: error.message }
    }
    const expected = state.terminal
    if (this.finalizationIntentAuthority) {
      let intent
      try { intent = this.finalizationIntentAuthority.read() } catch (error) {
        return { valid: false, reason: 'TERMINAL_FINALIZATION_INTENT_INVALID', cause: error.message }
      }
      if (intent.runId !== state.runId || intent.activationId !== state.activation.id ||
          !Number.isSafeInteger(intent.generation) || intent.generation < 1 ||
          intent.generation > expected.generation || intent.missionHash !== expected.missionHash ||
          intent.requestEnvelopeHash !== expected.requestEnvelopeHash ||
          intent.workspaceEpoch !== expected.workspaceEpoch || intent.outcome !== expected.outcome ||
          stableStringify(intent.deliverableManifest) !== stableStringify(expected.deliverableManifest) ||
          stableStringify(intent.terminalEnvelope) !==
            stableStringify(expected.terminalEnvelope.payload.providerTerminal) ||
          intent.reason !== expected.terminalEnvelope.cause.reason ||
          intent.unblockPath !== expected.terminalEnvelope.cause.unblockPath) {
        return { valid: false, reason: 'TERMINAL_FINALIZATION_INTENT_MISMATCH' }
      }
      const intentEvidenceHashes = [...new Set([
        ...intent.deliverableManifest.map(entry => entry.hash),
        ...intent.checkHashes,
      ])].sort()
      if (stableStringify(intentEvidenceHashes) !== stableStringify(expected.producedEvidenceHashes)) {
        return { valid: false, reason: 'TERMINAL_FINALIZATION_EVIDENCE_MISMATCH' }
      }
      const finalResponseValidation = this._validateFinalResponse(
        intent.finalResponse,
        normalizeManifest(expected.deliverableManifest || []),
      )
      if (!finalResponseValidation.valid) {
        return {
          valid: false,
          reason: 'TERMINAL_FINAL_RESPONSE_INVALID',
          cause: finalResponseValidation.reason,
        }
      }
    }
    if (state.activation && expected.activationId !== state.activation.id) {
      return { valid: false, reason: 'TERMINAL_ACTIVATION_STALE' }
    }
    for (const field of [
      'outcome', 'runId', 'activationId', 'generation', 'sequence', 'missionHash', 'requestEnvelopeHash',
      'workspaceEpoch', 'deliverableManifestHash', 'completedAt',
    ]) {
      if (record[field] !== expected[field]) return { valid: false, reason: 'TERMINAL_RECORD_FOREIGN', field }
    }
    if (stableStringify(record.deliverableManifest || []) !== stableStringify(expected.deliverableManifest || [])) {
      return { valid: false, reason: 'TERMINAL_RECORD_FOREIGN', field: 'deliverableManifest' }
    }
    if (stableStringify(record.producedEvidenceHashes || []) !== stableStringify(expected.producedEvidenceHashes || [])) {
      return { valid: false, reason: 'TERMINAL_RECORD_FOREIGN', field: 'producedEvidenceHashes' }
    }
    for (const field of ['terminalEnvelope', 'releaseIntent']) {
      if (stableStringify(record[field] ?? null) !== stableStringify(expected[field] ?? null)) {
        return { valid: false, reason: 'TERMINAL_RECORD_FOREIGN', field }
      }
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
    if (!terminalEvent || record.terminalEventType !== expectedEventType ||
        terminalEvent.type !== expectedEventType || terminalEvent.hash !== record.terminalEventHash ||
        (expected.releaseIntent && (record.terminalEventSequence !== expected.releaseIntent.eventSequence ||
          record.terminalEventHash !== expected.releaseIntent.eventHash))) {
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

  _createOrVerifyFinalizationIntent(state, options, manifest, checkHashes) {
    if (!this.finalizationIntentAuthority) return null
    const reason = options.reason || 'deterministic finalization'
    const requested = {
      runId: state.runId,
      activationId: state.activation.id,
      generation: state.activation.generation,
      missionHash: state.activation.missionHash,
      requestEnvelopeHash: state.requestEnvelopeHash,
      workspaceEpoch: state.workspaceEpoch,
      outcome: options.outcome,
      route: options.route === undefined ? null : options.route,
      reason,
      deliverableManifest: manifest,
      checkHashes,
      terminalEnvelope: options.terminalEnvelope === undefined ? null : options.terminalEnvelope,
      finalResponse: options.finalResponse === undefined ? null : options.finalResponse,
      unblockPath: options.unblockPath || null,
    }
    try {
      let existing = null
      try { existing = this.finalizationIntentAuthority.read() } catch (error) {
        if (!error || error.code !== 'TERMINAL_FINALIZATION_INTENT_REQUIRED') throw error
      }
      if (existing) {
        const existingSelection = { ...existing }
        delete existingSelection.schema
        delete existingSelection.schemaVersion
        delete existingSelection.intentHash
        const selectedGeneration = existingSelection.generation
        delete existingSelection.generation
        const requestedSelection = { ...requested }
        delete requestedSelection.generation
        if (!Number.isSafeInteger(selectedGeneration) || selectedGeneration < 1 ||
            selectedGeneration > requested.generation ||
            stableStringify(existingSelection) !== stableStringify(requestedSelection)) {
          fail('FINALIZATION_INTENT_CONFLICT', 'finalization conflicts with the durable immutable terminal intent')
        }
        return existing
      }
      return this.finalizationIntentAuthority.createOrVerify(requested)
    } catch (error) {
      if (error instanceof FinalizerError) throw error
      if (error && error.code === 'TERMINAL_FINALIZATION_INTENT_CONFLICT') {
        fail('FINALIZATION_INTENT_CONFLICT', 'finalization conflicts with the durable immutable terminal intent', {
          cause: error.message,
        })
      }
      fail('FINALIZATION_INTENT_INVALID', 'terminal finalization intent could not be created or verified', {
        cause: error && error.message,
      })
    }
  }

  _validateFinalResponse(finalResponse, manifest) {
    if (finalResponse === null) return { valid: true }
    try {
      if (!finalResponse || typeof finalResponse !== 'object' || Array.isArray(finalResponse)) {
        return { valid: false, reason: 'FINAL_RESPONSE_NOT_OBJECT' }
      }
      const pointer = finalResponse.evidencePointer
      if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer) ||
          pointer.name !== 'structured-final-response' ||
          typeof pointer.path !== 'string' || !path.isAbsolute(pointer.path) ||
          path.resolve(pointer.path) !== pointer.path ||
          !/^[a-f0-9]{64}$/.test(pointer.hash || '') ||
          !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 1) {
        return { valid: false, reason: 'FINAL_RESPONSE_POINTER_INVALID' }
      }
      const manifestEntry = manifest.find(entry => entry.path === pointer.path)
      if (!manifestEntry || manifestEntry.type === 'directory' || manifestEntry.hash !== pointer.hash) {
        return { valid: false, reason: 'FINAL_RESPONSE_POINTER_NOT_IN_MANIFEST' }
      }
      const strictHash = hashManifestEntryStrict(manifestEntry, this.fs)
      if (strictHash !== pointer.hash) {
        return { valid: false, reason: 'FINAL_RESPONSE_POINTER_HASH_CHANGED' }
      }
      const bytes = readFileStrict(pointer.path, this.fs)
      if (bytes.length !== pointer.bytes || sha256(bytes) !== pointer.hash) {
        return { valid: false, reason: 'FINAL_RESPONSE_POINTER_BYTES_CHANGED' }
      }
      let persisted
      try { persisted = JSON.parse(bytes.toString('utf8')) } catch {
        return { valid: false, reason: 'FINAL_RESPONSE_EVIDENCE_NOT_JSON' }
      }
      const { responseHash, evidencePointer: _discardedPointer, ...body } = finalResponse
      if (!/^[a-f0-9]{64}$/.test(responseHash || '') ||
          responseHash !== sha256(stableStringify(body))) {
        return { valid: false, reason: 'FINAL_RESPONSE_HASH_INVALID' }
      }
      if (stableStringify(persisted) !== stableStringify({ ...body, responseHash })) {
        return { valid: false, reason: 'FINAL_RESPONSE_EVIDENCE_MISMATCH' }
      }
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        reason: error && error.code === 'PREIMAGE_UNSAFE'
          ? 'FINAL_RESPONSE_POINTER_UNSAFE' : 'FINAL_RESPONSE_AUTHENTICATION_FAILED',
        cause: error && error.message,
      }
    }
  }

  _verifyManifest(manifest) {
    for (const entry of manifest) {
      let actual
      try { actual = hashManifestEntryStrict(entry, this.fs) } catch (error) {
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

  _withTerminalRecordAuthority(operation) {
    try {
      return withStrictAnchoredManifestPath(
        this.terminalPath,
        this.fs,
        (anchoredTerminalPath, verifyLineage) => operation(anchoredTerminalPath, verifyLineage),
      )
    } catch (error) {
      if (error instanceof FinalizerError) throw error
      fail('TERMINAL_PATH_UNSAFE', 'registered terminal has a linked or unstable directory lineage', {
        cause: error && (error.code || error.message),
      })
    }
  }

  _readTerminalRecordAt(terminalPath, verifyLineage) {
    let descriptor
    let bytes
    try {
      const initial = this.fs.lstatSync(terminalPath)
      if (!initial.isFile() || initial.isSymbolicLink() || Number(initial.nlink) !== 1) {
        fail('TERMINAL_RECORD_INVALID', 'registered terminal is not one immutable regular file')
      }
      descriptor = this.fs.openSync(
        terminalPath,
        fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0),
      )
      const opened = this.fs.fstatSync(descriptor)
      if (!opened.isFile() || Number(opened.nlink) !== 1 ||
          opened.dev !== initial.dev || opened.ino !== initial.ino) {
        fail('TERMINAL_RECORD_INVALID', 'registered terminal changed while it was opened')
      }
      verifyLineage()
      bytes = this.fs.readFileSync(descriptor)
      const after = this.fs.fstatSync(descriptor)
      const live = this.fs.lstatSync(terminalPath)
      if (after.dev !== opened.dev || after.ino !== opened.ino ||
          live.dev !== after.dev || live.ino !== after.ino || bytes.length !== after.size) {
        fail('TERMINAL_RECORD_INVALID', 'registered terminal changed while it was read')
      }
    } catch (error) {
      if (error instanceof FinalizerError || (error && error.code === 'PREIMAGE_UNSAFE')) throw error
      fail('TERMINAL_RECORD_INVALID', 'registered terminal cannot be read safely', {
        cause: error && (error.code || error.message),
      })
    } finally {
      if (descriptor !== undefined) this.fs.closeSync(descriptor)
    }
    let parsed
    try { parsed = JSON.parse(bytes.toString('utf8')) } catch (error) {
      fail('TERMINAL_RECORD_INVALID', 'registered terminal is not JSON', { cause: error.message })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !/^[a-f0-9]{64}$/.test(parsed.checksum || '') || checksumRecord(parsed) !== parsed.checksum) {
      fail('TERMINAL_RECORD_INVALID', 'registered terminal checksum is invalid')
    }
    return parsed
  }

  _readTerminalRecord() {
    return this._withTerminalRecordAuthority((terminalPath, verifyLineage) =>
      this._readTerminalRecordAt(terminalPath, verifyLineage))
  }

  _createOrVerifyTerminalAt(record, terminalPath, verifyLineage) {
    if (this.fs.existsSync(terminalPath)) {
      let existing
      try { existing = this._readTerminalRecordAt(terminalPath, verifyLineage) } catch (error) {
        if (error && error.code === 'PREIMAGE_UNSAFE') throw error
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
      fsyncDirectory(path.dirname(terminalPath), this.fs)
      return existing
    }
    const signed = { ...canonicalize(record) }
    signed.checksum = checksumRecord(signed)
    const directory = path.dirname(terminalPath)
    const temporary = path.join(
      directory,
      `.${path.basename(terminalPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.create`,
    )
    let descriptor
    try {
      descriptor = this.fs.openSync(temporary, 'wx', 0o600)
      verifyLineage()
      const bytes = Buffer.from(`${stableStringify(signed)}\n`, 'utf8')
      let offset = 0
      while (offset < bytes.length) {
        offset += this.fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
      }
      this.fs.fsyncSync(descriptor)
      this.fs.closeSync(descriptor)
      descriptor = undefined
      verifyLineage()
      this.fs.linkSync(temporary, terminalPath)
      verifyLineage()
      fsyncDirectory(directory, this.fs)
      this.fs.unlinkSync(temporary)
      fsyncDirectory(directory, this.fs)
      return signed
    } catch (error) {
      if (descriptor !== undefined) {
        try { this.fs.closeSync(descriptor) } catch {}
      }
      try { this.fs.unlinkSync(temporary) } catch {}
      if (error && error.code === 'EEXIST') {
        return this._createOrVerifyTerminalAt(record, terminalPath, verifyLineage)
      }
      if (error && error.code === 'PREIMAGE_UNSAFE') throw error
      fail('TERMINAL_RECORD_FAILURE', 'registered terminal could not be created atomically', { cause: error.message })
    }
  }

  _createOrVerifyTerminal(record) {
    return this._withTerminalRecordAuthority((terminalPath, verifyLineage) => {
      recoverTerminalPublicationResiduesAnchored(terminalPath, verifyLineage, { fsImpl: this.fs })
      return this._createOrVerifyTerminalAt(record, terminalPath, verifyLineage)
    })
  }
}

module.exports = {
  CLEANUP_SCHEMA_VERSION,
  CleanupRegistry,
  Finalizer,
  FinalizerError,
}
