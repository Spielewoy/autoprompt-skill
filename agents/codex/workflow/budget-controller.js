#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  atomicWriteFile,
  canonicalize,
  readChecksummedJson,
  sha256,
  stableStringify,
} = require('./event-log.js')
const { FILE_MODE, RunRecordError, pathIsInside, readFileNoFollow, withOwnedLock } = require('./safe-run-root.js')

const ACCOUNTING_RECORD_SCHEMA = require('../../contracts/schemas/accounting-record.schema.json')
const ACCOUNTING_SNAPSHOT_SCHEMA = require('../../contracts/schemas/accounting-snapshot.schema.json')

const BUDGET_SCHEMA_VERSION = 2
const LIMIT_FIELDS = Object.freeze(['wallMs', 'tokens', 'sessions', 'launches'])
const TOKEN_FIELDS = Object.freeze(['noncachedInput', 'cachedInput', 'output', 'reasoning'])
const BILLABLE_TOKEN_FIELDS = Object.freeze(['noncachedInput', 'cachedInput', 'output'])
const ACCOUNTING_VALUE_FIELDS = Object.freeze(['launches', 'retries', 'sessions', 'elapsedMilliseconds', 'costMicrounits', 'tokenUsage'])
const ACCOUNTING_CAUSES = Object.freeze([...ACCOUNTING_RECORD_SCHEMA.properties.cause.properties.kind.enum])
const HASH_PATTERN = /^[a-f0-9]{64}$/

class BudgetError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BudgetError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new BudgetError(code, message, details)
}

function positiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('BUDGET_CONFIG_INVALID', `${label} must be a positive safe integer`)
  return value
}

function resolveCeilings(sources) {
  if (!sources || !sources.product) fail('BUDGET_CONFIG_INVALID', 'product safety ceilings are required')
  const result = {}
  for (const field of LIMIT_FIELDS) {
    const candidates = []
    for (const sourceName of ['product', 'task', 'host', 'user', 'environment']) {
      const source = sources[sourceName]
      if (source && source[field] !== undefined && source[field] !== null) {
        candidates.push(positiveLimit(source[field], `${sourceName}.${field}`))
      }
    }
    if (!candidates.length) fail('BUDGET_CONFIG_INVALID', `no safety ceiling exists for ${field}`)
    result[field] = Math.min(...candidates)
  }
  return Object.freeze(result)
}

function validatePhases(phases) {
  const result = {}
  for (const [name, limits] of Object.entries(phases || {})) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) fail('BUDGET_CONFIG_INVALID', `invalid phase name: ${name}`)
    const softMs = positiveLimit(limits.softMs, `${name}.softMs`)
    const hardMs = positiveLimit(limits.hardMs, `${name}.hardMs`)
    if (softMs >= hardMs) fail('BUDGET_CONFIG_INVALID', `${name} requires 0 < softMs < hardMs`)
    result[name] = { softMs, hardMs }
  }
  return result
}

function defaultMonotonicMs() {
  return Number(process.hrtime.bigint() / 1000000n)
}

function detectBootId(fsImpl = fs) {
  if (process.platform !== 'linux') return null
  try {
    const value = fsImpl.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return /^[a-f0-9-]{16,64}$/i.test(value) ? `linux-boot:${value.toLowerCase()}` : null
  } catch {
    return null
  }
}

class BudgetController {
  constructor(options) {
    if (!options) fail('BUDGET_CONFIG_INVALID', 'budget options are required')
    this.monotonicMs = options.monotonicMs || defaultMonotonicMs
    this.wallClock = options.wallClock || (() => new Date().toISOString())
    this.terminalSessionWriter = typeof options.terminalSessionWriter === 'function'
      ? options.terminalSessionWriter : null
    this.requireSessionBindings = options.requireSessionBindings === true
    this.wallTimeUnbounded = options.wallTimeUnbounded === true
    this.wallNowMs = options.wallNowMs || Date.now
    this.bootId = options.bootId === undefined ? detectBootId(options.fsImpl) : options.bootId
    this.monotonicClockId = options.monotonicClockId === undefined ? null : options.monotonicClockId
    this.externalWriteClockUncertain = false
    if (this.monotonicClockId !== null &&
        (typeof this.monotonicClockId !== 'string' || !this.monotonicClockId.trim())) {
      fail('BUDGET_CONFIG_INVALID', 'monotonicClockId must be a non-empty string when provided')
    }
    const requestedLimits = options.limits || resolveCeilings(options.ceilingSources)
    for (const field of LIMIT_FIELDS) positiveLimit(requestedLimits[field], `limits.${field}`)
    this.phaseBudgetFactory = options.phaseBudgetFactory === undefined ? null : options.phaseBudgetFactory
    if (this.phaseBudgetFactory !== null && typeof this.phaseBudgetFactory !== 'function') {
      fail('BUDGET_CONFIG_INVALID', 'phaseBudgetFactory must be a function when provided')
    }
    this.phases = validatePhases(options.phases)
    this.finalizationReserveSpecified = options.finalizationReserveMs !== undefined
    this.verificationReserveSpecified = options.verificationReserveMs !== undefined
    this.finalizationReserveMs = options.finalizationReserveMs || 0
    this.verificationReserveMs = options.verificationReserveMs || 0
    if (!Number.isSafeInteger(this.finalizationReserveMs) || this.finalizationReserveMs < 0 ||
        !Number.isSafeInteger(this.verificationReserveMs) || this.verificationReserveMs < 0 ||
        this.finalizationReserveMs + this.verificationReserveMs >= requestedLimits.wallMs) {
      fail('BUDGET_CONFIG_INVALID', 'finalization reserve must be non-negative and below wallMs')
    }
    const now = this.monotonicMs()
    const wallNow = this.wallNowMs()
    if (!Number.isFinite(now)) fail('BUDGET_CLOCK_INVALID', 'monotonic clock did not return a finite value')
    if (!Number.isFinite(wallNow)) fail('BUDGET_CLOCK_INVALID', 'wall persistence clock did not return a finite value')
    this.lastMonotonicMs = now
    if (options.snapshot) {
      this._restore(options.snapshot, requestedLimits, now, wallNow)
    } else {
      this.state = {
        schemaVersion: BUDGET_SCHEMA_VERSION,
        limits: { ...requestedLimits },
        finalizationReserveMs: this.finalizationReserveMs,
        ...(this.verificationReserveMs > 0 ? { verificationReserveMs: this.verificationReserveMs } : {}),
        consumedWallMs: 0,
        anchorMonotonicMs: now,
        checkpointMonotonicMs: now,
        ...(this.monotonicClockId ? { monotonicClockId: this.monotonicClockId } : {}),
        bootId: this.bootId,
        activationStartedWallMs: wallNow,
        lastObservedWallMs: wallNow,
        externalWriteClockUncertain: false,
        activationStartedAt: String(this.wallClock()),
        checkpointAt: String(this.wallClock()),
        tokensUsed: 0,
        sessionsStarted: 0,
        launches: 0,
        generation: 1,
        generationStartedAtElapsedMs: 0,
        phaseStartedAtElapsedMs: {},
        pendingConvergence: {},
        breachEvidence: [],
        crashState: { lastFingerprint: null, equivalentCount: 0, totalCrashes: 0, backoffExponent: 0, acceptedProgressSequence: 0 },
        sessions: {},
      }
    }
  }

  _observeWallNow(observed = this.wallNowMs()) {
    const wallNow = Number(observed)
    if (!Number.isFinite(wallNow)) fail('BUDGET_CLOCK_INVALID', 'wall persistence clock did not return a finite value')
    if (this.state && wallNow < this.state.lastObservedWallMs) {
      this.externalWriteClockUncertain = true
      this.state.externalWriteClockUncertain = true
    }
    if (this.state) {
      this.state.lastObservedWallMs = Math.max(this.state.lastObservedWallMs, wallNow)
      this.state.externalWriteClockUncertain = this.externalWriteClockUncertain === true ||
        this.state.externalWriteClockUncertain === true
    }
    return wallNow
  }

  elapsedMs() {
    const now = this.monotonicMs()
    if (!Number.isFinite(now)) fail('BUDGET_CLOCK_INVALID', 'monotonic clock did not return a finite value')
    this.lastMonotonicMs = Math.max(this.lastMonotonicMs, now)
    const delta = Math.max(0, this.lastMonotonicMs - this.state.anchorMonotonicMs)
    return this.state.consumedWallMs + delta
  }

  status(options = {}) {
    const elapsedMs = this.elapsedMs()
    const wallLimit = options.forExecution
      ? this.state.limits.wallMs - this.state.finalizationReserveMs - (this.state.verificationReserveMs || 0)
      : options.forWork
        ? this.state.limits.wallMs - this.state.finalizationReserveMs
        : this.state.limits.wallMs
    const remaining = {
      wallMs: this.wallTimeUnbounded ? Number.MAX_SAFE_INTEGER : Math.max(0, wallLimit - elapsedMs),
      tokens: Math.max(0, this.state.limits.tokens - this.state.tokensUsed),
      sessions: Math.max(0, this.state.limits.sessions - this.state.sessionsStarted),
      launches: Math.max(0, this.state.limits.launches - this.state.launches),
    }
    const exhausted = []
    if (!this.wallTimeUnbounded && elapsedMs >= wallLimit) {
      exhausted.push(options.forExecution ? 'EXECUTION_WALL' : options.forWork ? 'WORK_WALL' : 'WALL')
    }
    if (this.state.tokensUsed >= this.state.limits.tokens) exhausted.push('TOKENS')
    if (this.state.sessionsStarted >= this.state.limits.sessions) exhausted.push('SESSIONS')
    if (this.state.launches >= this.state.limits.launches) exhausted.push('LAUNCHES')
    return {
      ok: exhausted.length === 0,
      exhausted,
      elapsedMs,
      remaining,
      limits: { ...this.state.limits },
      generation: this.state.generation,
      reserveMs: this.state.finalizationReserveMs,
      verificationReserveMs: this.state.verificationReserveMs || 0,
      wallTimeUnbounded: this.wallTimeUnbounded,
    }
  }

  assertAvailable(options = {}) {
    const status = this.status(options)
    const blocking = options.requiredCompletion === true
      ? status.exhausted.filter(dimension => ![
          'WALL', 'WORK_WALL', 'EXECUTION_WALL', 'TOKENS', 'SESSIONS', 'LAUNCHES',
        ].includes(dimension))
      : status.exhausted
    if (blocking.length > 0) {
      if (options.forExecution && blocking.includes('EXECUTION_WALL')) {
        fail('FINAL_VERIFICATION_RESERVE_REQUIRED', 'execution cannot consume the protected final-verification reserve', status)
      }
      fail('BUDGET_EXHAUSTED', `runtime budget exhausted: ${blocking.join(', ')}`, status)
    }
    return options.requiredCompletion === true && status.exhausted.length > 0
      ? { ...status, ok: true, completionTargetOverrun: [...status.exhausted] }
      : status
  }

  assertExternalWriteAllowed(details = {}) {
    const deadline = this.state.deadline && Date.parse(this.state.deadline.absoluteDeadline)
    const nowMs = this._observeWallNow()
    if (this.externalWriteClockUncertain) {
      fail('EXTERNAL_WRITE_CLOCK_UNCERTAIN',
        'external write denied because wall-clock continuity cannot be established', {
          lastObservedWallMs: this.state.lastObservedWallMs,
          observedAtMs: nowMs,
          operationId: details.operationId || null,
        })
    }
    if (!Number.isFinite(deadline)) {
      fail('EXTERNAL_WRITE_DEADLINE_REQUIRED', 'external writes require a bound absolute task deadline')
    }
    if (!this.wallTimeUnbounded && nowMs >= deadline) {
      fail('EXTERNAL_WRITE_DEADLINE_EXPIRED', 'external write denied at or after the hard task deadline', {
        deadline: this.state.deadline.absoluteDeadline,
        observedAt: new Date(nowMs).toISOString(),
        operationId: details.operationId || null,
        reconciledPartialStateHash: /^[a-f0-9]{64}$/.test(details.reconciledPartialStateHash || '')
          ? details.reconciledPartialStateHash : null,
      })
    }
    return Object.freeze({
      allowed: true,
      deadline: this.state.deadline.absoluteDeadline,
      observedAtMs: nowMs,
      wallTimeUnbounded: this.wallTimeUnbounded,
    })
  }

  bindDeadline(input = {}) {
    const wallMs = input.wallMs
    const verificationReserveMs = input.verificationReserveMs
    const finalizationReserveMs = input.finalizationReserveMs
    const admittedAtMs = input.admittedAtMs
    if (!input.deadline || !Number.isSafeInteger(wallMs) || wallMs <= 0 ||
        !Number.isSafeInteger(verificationReserveMs) || verificationReserveMs < 0 ||
        !Number.isSafeInteger(finalizationReserveMs) || finalizationReserveMs < 0 ||
        verificationReserveMs + finalizationReserveMs >= wallMs ||
        !Number.isFinite(admittedAtMs) || this.state.generation !== 1 || this.state.tokensUsed !== 0 ||
        this.state.sessionsStarted !== 0 || this.state.launches !== 0 || this.state.deadline !== undefined) {
      fail('BUDGET_CONFIG_INVALID', 'deadline binding requires one unused first-generation budget and viable reserves')
    }
    const monotonic = this.monotonicMs()
    const admittedAt = new Date(admittedAtMs).toISOString()
    if (this.phaseBudgetFactory) {
      if (Object.keys(this.state.phaseStartedAtElapsedMs).length > 0) {
        fail('BUDGET_CONFIG_INVALID', 'deadline binding cannot replace phase ceilings after a phase has started')
      }
      this.phases = validatePhases(this.phaseBudgetFactory(wallMs))
    }
    this.finalizationReserveMs = finalizationReserveMs
    this.verificationReserveMs = verificationReserveMs
    this.state = canonicalize({
      ...this.state,
      limits: { ...this.state.limits, wallMs },
      deadline: input.deadline,
      verificationReserveMs,
      finalizationReserveMs,
      consumedWallMs: 0,
      anchorMonotonicMs: monotonic,
      checkpointMonotonicMs: monotonic,
      activationStartedWallMs: admittedAtMs,
      lastObservedWallMs: Math.max(this.state.lastObservedWallMs, admittedAtMs),
      externalWriteClockUncertain: this.externalWriteClockUncertain === true ||
        this.state.externalWriteClockUncertain === true,
      activationStartedAt: admittedAt,
      checkpointAt: admittedAt,
    })
    this.lastMonotonicMs = monotonic
    return this.snapshot()
  }

  consumeTokens(count, options = {}) {
    if (!Number.isSafeInteger(count) || count < 0) fail('BUDGET_USAGE_INVALID', 'token count must be a non-negative safe integer')
    if (!Number.isSafeInteger(this.state.tokensUsed + count)) {
      fail('BUDGET_USAGE_INVALID', 'cumulative token count exceeds safe integer accounting')
    }
    if (options.requiredCompletion !== true && this.state.tokensUsed + count > this.state.limits.tokens) {
      fail('BUDGET_EXHAUSTED', 'token budget would be exceeded', this.status())
    }
    this.state.tokensUsed += count
    return this.state.tokensUsed
  }

  recordLaunch(details = {}) {
    this.assertAvailable({
      forWork: details.forWork !== false,
      forExecution: details.forExecution === true,
      requiredCompletion: details.requiredCompletion === true,
    })
    if (details.requiredCompletion !== true && this.state.launches >= this.state.limits.launches) {
      fail('BUDGET_EXHAUSTED', 'launch budget is exhausted')
    }
    this.state.launches += 1
    return this.state.launches
  }

  startSession(sessionId, details = {}) {
    if (typeof sessionId !== 'string' || !sessionId || this.state.sessions[sessionId]) {
      fail('SESSION_RECORD_INVALID', 'session id is missing or already recorded')
    }
    if (this.requireSessionBindings &&
        (typeof details.activationId !== 'string' || !details.activationId ||
        typeof details.parentSessionId !== 'string' || !details.parentSessionId)) {
      fail('SESSION_RECORD_INVALID', 'session requires activation and parent session bindings')
    }
    this.assertAvailable({
      forWork: details.forWork !== false,
      forExecution: details.forExecution === true,
      requiredCompletion: details.requiredCompletion === true,
    })
    if (details.requiredCompletion !== true && this.state.sessionsStarted >= this.state.limits.sessions) {
      fail('BUDGET_EXHAUSTED', 'session budget is exhausted')
    }
    if (!Number.isSafeInteger(this.state.sessionsStarted + 1)) {
      fail('BUDGET_USAGE_INVALID', 'cumulative session count exceeds safe integer accounting')
    }
    this.state.sessionsStarted += 1
    this.state.sessions[sessionId] = {
      sessionId,
      activationId: details.activationId || `legacy-activation:generation-${this.state.generation}`,
      generation: this.state.generation,
      parentSessionId: details.parentSessionId || 'legacy-parent:root',
      startedAt: String(this.wallClock()),
      startedAtElapsedMs: this.elapsedMs(),
      status: 'RUNNING',
      endedAt: null,
      evidenceHashes: [],
    }
    return canonicalize(this.state.sessions[sessionId])
  }

  endSession(sessionId, details = {}) {
    const session = this.state.sessions[sessionId]
    if (!session || session.status !== 'RUNNING') fail('SESSION_RECORD_INVALID', 'session is missing or already terminal')
    const terminalStatuses = ['DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED', 'LOST']
    if (!terminalStatuses.includes(details.status)) fail('SESSION_RECORD_INVALID', 'session terminal status is invalid')
    const hashes = details.evidenceHashes || []
    if (!Array.isArray(hashes) || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
      fail('SESSION_RECORD_INVALID', 'session evidence hashes are invalid')
    }
    const endedAt = String(this.wallClock())
    const terminal = {
      ...session,
      status: details.status,
      endedAt,
      endedAtElapsedMs: this.elapsedMs(),
      lastToolAt: details.lastToolAt ? String(details.lastToolAt) : endedAt,
      evidenceHashes: Object.freeze([...new Set(hashes)].sort()),
    }
    terminal.recordHash = sha256(stableStringify(terminal))
    if (this.terminalSessionWriter) {
      const persisted = this.terminalSessionWriter(canonicalize(terminal))
      if (!persisted || persisted.recordHash !== terminal.recordHash ||
          stableStringify(persisted) !== stableStringify(terminal)) {
        fail('SESSION_TERMINAL_PERSIST_FAILED', 'terminal session was not atomically persisted with its immutable record hash')
      }
    }
    this.state.sessions[sessionId] = Object.freeze(terminal)
    return canonicalize(terminal)
  }

  startPhase(name) {
    if (!this.phases[name]) fail('PHASE_UNKNOWN', `unknown budget phase: ${name}`)
    // Phase entry is one-shot within a generation. Repeated state-machine
    // edges and retries must observe the original elapsed time rather than
    // silently buying a fresh soft/hard window.
    if (this.state.phaseStartedAtElapsedMs[name] !== undefined) return this.phaseStatus(name)
    this.state.phaseStartedAtElapsedMs[name] = this.elapsedMs()
    delete this.state.pendingConvergence[name]
    return this.phaseStatus(name)
  }

  phaseStatus(name) {
    const limits = this.phases[name]
    if (!limits) fail('PHASE_UNKNOWN', `unknown budget phase: ${name}`)
    const start = this.state.phaseStartedAtElapsedMs[name]
    if (start === undefined) fail('PHASE_NOT_STARTED', `budget phase has not started: ${name}`)
    const elapsedMs = Math.max(0, this.elapsedMs() - start)
    let level = 'OK'
    if (elapsedMs >= limits.hardMs) level = 'HARD'
    else if (elapsedMs >= limits.softMs) level = 'SOFT'
    return {
      name,
      level,
      elapsedMs,
      softMs: limits.softMs,
      hardMs: limits.hardMs,
      generation: this.state.generation,
      pendingConvergence: this.state.pendingConvergence[name] || null,
    }
  }

  requestConvergence(name, evidence = {}) {
    const phase = this.phaseStatus(name)
    if (phase.level === 'OK') fail('PHASE_NOT_BREACHED', `phase ${name} has not reached its soft limit`)
    const request = {
      generation: this.state.generation,
      requestedAtElapsedMs: this.elapsedMs(),
      level: phase.level,
      evidence: canonicalize(evidence),
    }
    this.state.pendingConvergence[name] = request
    this.state.breachEvidence.push({ phase: name, ...request })
    return canonicalize(request)
  }

  supervisorDecision(name, options = {}) {
    const global = this.status({
      forWork: options.forWork !== false,
      forExecution: options.forExecution === true,
    })
    if (!global.ok) {
      return { action: 'STOP_ACTIVATION', reason: global.exhausted[0], global, phase: null }
    }
    const phase = this.phaseStatus(name)
    if (phase.level === 'HARD') return { action: 'STOP_PHASE', reason: 'PHASE_HARD_DEADLINE', global, phase }
    if (phase.level === 'SOFT' && !phase.pendingConvergence) {
      return { action: 'REQUEST_CONVERGENCE', reason: 'PHASE_SOFT_DEADLINE', global, phase }
    }
    if (phase.level === 'SOFT') return { action: 'WAIT_FOR_CONVERGENCE', reason: 'PHASE_SOFT_PENDING', global, phase }
    return { action: 'CONTINUE', reason: null, global, phase }
  }

  beginGeneration(options = {}) {
    this.state.generation += 1
    const elapsed = this.elapsedMs()
    this.state.generationStartedAtElapsedMs = elapsed
    this.state.phaseStartedAtElapsedMs = {}
    this.state.pendingConvergence = {}
    return {
      generation: this.state.generation,
      startedAtElapsedMs: elapsed,
      reason: options.reason || 'resume',
      retainedBreaches: this.state.breachEvidence.length,
      remaining: this.status().remaining,
    }
  }

  recordCrash(fingerprint, options = {}) {
    if (typeof fingerprint !== 'string' || !fingerprint) fail('CRASH_RECORD_INVALID', 'crash fingerprint is required')
    const crash = this.state.crashState
    if (!Number.isSafeInteger(crash.backoffExponent)) crash.backoffExponent = 0
    if (!Number.isSafeInteger(crash.acceptedProgressSequence)) crash.acceptedProgressSequence = 0
    const evidence = options.progressEvidence
    const changedAcceptedArtifact = evidence && ['deliverable', 'oracle'].includes(evidence.kind) &&
      evidence.accepted === true && evidence.action === 'accepted-change' &&
      HASH_PATTERN.test(evidence.beforeHash || '') && HASH_PATTERN.test(evidence.afterHash || '') &&
      evidence.beforeHash !== evidence.afterHash
    const acceptedProgress = Boolean(evidence && typeof evidence === 'object' &&
      ['transition', 'deliverable', 'oracle'].includes(evidence.kind) &&
      evidence.generation === this.state.generation &&
      typeof options.activationId === 'string' && options.activationId &&
      evidence.activationId === options.activationId &&
      Number.isSafeInteger(evidence.sequence) && evidence.sequence > crash.acceptedProgressSequence &&
      /^[a-f0-9]{64}$/.test(evidence.evidenceHash || '') &&
      (evidence.kind === 'transition' ? evidence.accepted === true : changedAcceptedArtifact))
    crash.totalCrashes += 1
    if (acceptedProgress) {
      crash.lastFingerprint = fingerprint
      crash.equivalentCount = 1
      crash.backoffExponent = 0
      crash.acceptedProgressSequence = evidence.sequence
    } else if (crash.lastFingerprint === fingerprint) {
      crash.equivalentCount += 1
      crash.backoffExponent += 1
    } else {
      crash.lastFingerprint = fingerprint
      // A different exception string is not evidence that the activation made
      // progress.  Keep consuming the same crash-loop allowance until a
      // caller presents an accepted transition/deliverable/oracle receipt.
      crash.equivalentCount += 1
      crash.backoffExponent = Math.max(crash.backoffExponent, crash.equivalentCount - 1)
    }
    return canonicalize(crash)
  }

  crashRetryVerdict(options = {}) {
    const maximum = Number.isSafeInteger(options.maximumEquivalentCrashes)
      ? options.maximumEquivalentCrashes : 3
    const crash = this.state.crashState
    const exhausted = crash.equivalentCount >= maximum || crash.backoffExponent >= maximum - 1
    return Object.freeze({
      exhausted,
      code: exhausted ? 'CRASH_RETRY_EXHAUSTED' : 'CRASH_RETRY_AVAILABLE',
      equivalentCount: crash.equivalentCount,
      backoffExponent: crash.backoffExponent,
      maximumEquivalentCrashes: maximum,
    })
  }

  snapshot() {
    const elapsed = this.elapsedMs()
    const wallNow = this._observeWallNow()
    const snapshot = canonicalize({
      ...this.state,
      consumedWallMs: elapsed,
      anchorMonotonicMs: this.lastMonotonicMs,
      checkpointMonotonicMs: this.lastMonotonicMs,
      bootId: this.bootId,
      lastObservedWallMs: Math.max(this.state.lastObservedWallMs, wallNow),
      externalWriteClockUncertain: this.externalWriteClockUncertain === true ||
        this.state.externalWriteClockUncertain === true,
      checkpointAt: String(this.wallClock()),
    })
    return snapshot
  }

  accountingCeilings(additional = {}) {
    const retries = positiveLimit(additional.retries, 'accountingCeilings.retries')
    const costMicrounits = positiveLimit(additional.costMicrounits, 'accountingCeilings.costMicrounits')
    return Object.freeze({
      wallMilliseconds: this.wallTimeUnbounded ? Number.MAX_SAFE_INTEGER : this.state.limits.wallMs,
      totalTokens: this.state.limits.tokens,
      sessions: this.state.limits.sessions,
      launches: this.state.limits.launches,
      retries,
      costMicrounits,
      verificationReserveMilliseconds: this.state.verificationReserveMs || 0,
      finalizationReserveMilliseconds: this.state.finalizationReserveMs,
    })
  }

  _restore(snapshot, requestedLimits, now, wallNow) {
    if (!snapshot || snapshot.schemaVersion !== BUDGET_SCHEMA_VERSION) {
      fail('CONTRACT_UPGRADE_REQUIRED', 'budget snapshot schema is unsupported')
    }
    if (Object.hasOwn(snapshot, 'externalWriteClockUncertain') &&
        typeof snapshot.externalWriteClockUncertain !== 'boolean') {
      fail('BUDGET_SNAPSHOT_INVALID', 'budget snapshot external-write clock uncertainty is invalid')
    }
    // Legacy v2 snapshots predate the durable latch.  They remain valid for
    // local recovery, but absence cannot be interpreted as trusted clock
    // continuity for an external side effect.
    this.externalWriteClockUncertain = snapshot.externalWriteClockUncertain !== false
    for (const field of LIMIT_FIELDS) {
      positiveLimit(snapshot.limits && snapshot.limits[field], `snapshot.limits.${field}`)
    }
    const snapshotVerificationReserveMs = snapshot.verificationReserveMs === undefined
      ? 0
      : snapshot.verificationReserveMs
    if (!Number.isSafeInteger(snapshot.finalizationReserveMs) || snapshot.finalizationReserveMs < 0 ||
        !Number.isSafeInteger(snapshotVerificationReserveMs) || snapshotVerificationReserveMs < 0 ||
        (snapshot.monotonicClockId !== undefined &&
          (typeof snapshot.monotonicClockId !== 'string' || !snapshot.monotonicClockId.trim()))) {
      fail('BUDGET_SNAPSHOT_INVALID', 'budget snapshot reserves or monotonic clock identity are invalid')
    }
    if (snapshot.deadline !== undefined) {
      const expectedVerificationReserveMs = Math.floor(
        snapshot.limits.wallMs * snapshot.deadline.verificationReservePercent / 100,
      )
      const expectedFinalizationReserveMs = Math.floor(
        snapshot.limits.wallMs * snapshot.deadline.recoveryAndFinalizationReservePercent / 100,
      )
      if (snapshotVerificationReserveMs !== expectedVerificationReserveMs ||
          snapshot.finalizationReserveMs !== expectedFinalizationReserveMs) {
        fail('BUDGET_SNAPSHOT_INVALID', 'persisted protected reserves do not match the bound deadline')
      }
    } else if ((this.finalizationReserveSpecified && this.finalizationReserveMs !== snapshot.finalizationReserveMs) ||
        (this.verificationReserveSpecified && this.verificationReserveMs !== snapshotVerificationReserveMs)) {
      fail('BUDGET_SNAPSHOT_INVALID', 'resume cannot replace either persisted protected reserve')
    }
    if (snapshot.deadline !== undefined && requestedLimits.wallMs < snapshot.limits.wallMs) {
      fail('BUDGET_SNAPSHOT_INVALID', 'resume cannot shorten or replace a persisted deadline wall budget')
    }
    const numericFields = ['consumedWallMs', 'tokensUsed', 'sessionsStarted', 'launches', 'generation']
    for (const field of numericFields) {
      if (!Number.isSafeInteger(snapshot[field]) || snapshot[field] < (field === 'generation' ? 1 : 0)) {
        fail('BUDGET_SNAPSHOT_INVALID', `budget snapshot ${field} is invalid`)
      }
    }
    const limits = {}
    for (const field of LIMIT_FIELDS) limits[field] = Math.min(snapshot.limits[field], requestedLimits[field])
    if (!Number.isFinite(snapshot.checkpointMonotonicMs) ||
        !Number.isFinite(snapshot.activationStartedWallMs) ||
        !Number.isFinite(snapshot.lastObservedWallMs)) {
      fail('BUDGET_SNAPSHOT_INVALID', 'budget clock evidence is incomplete')
    }
    let offlineElapsedMs
    const sameInjectedMonotonicClock = this.monotonicClockId && snapshot.monotonicClockId &&
      this.monotonicClockId === snapshot.monotonicClockId
    if (wallNow < snapshot.lastObservedWallMs) this.externalWriteClockUncertain = true
    if (sameInjectedMonotonicClock || (this.bootId && snapshot.bootId && this.bootId === snapshot.bootId)) {
      if (now < snapshot.checkpointMonotonicMs) {
        fail('BUDGET_CLOCK_RESET', 'same-boot monotonic clock moved backward; resume is fail-closed')
      }
      offlineElapsedMs = now - snapshot.checkpointMonotonicMs
    } else {
      if (wallNow < snapshot.lastObservedWallMs) {
        // The authenticated snapshot and accounting hash chains remain the
        // rollback authorities. A wall-clock correction alone cannot prove
        // elapsed offline time, so retain the persisted high-water accounting
        // and deny external effects for this resumed controller.
        offlineElapsedMs = 0
        this.externalWriteClockUncertain = true
      } else {
        offlineElapsedMs = wallNow - snapshot.lastObservedWallMs
      }
    }
    const conservativeConsumed = Math.max(
      snapshot.consumedWallMs + offlineElapsedMs,
      wallNow - snapshot.activationStartedWallMs,
    )
    this.state = canonicalize({
      ...snapshot,
      consumedWallMs: conservativeConsumed,
      anchorMonotonicMs: now,
      limits,
      finalizationReserveMs: snapshot.finalizationReserveMs,
      verificationReserveMs: snapshotVerificationReserveMs,
      checkpointAt: String(this.wallClock()),
      checkpointMonotonicMs: now,
      ...(this.monotonicClockId ? { monotonicClockId: this.monotonicClockId } : {}),
      bootId: this.bootId,
      lastObservedWallMs: Math.max(snapshot.lastObservedWallMs, wallNow),
      externalWriteClockUncertain: this.externalWriteClockUncertain,
    })
    this.finalizationReserveMs = snapshot.finalizationReserveMs
    this.verificationReserveMs = snapshotVerificationReserveMs
    this.lastMonotonicMs = now
    if (!Number.isSafeInteger(this.state.verificationReserveMs || 0) ||
        this.state.verificationReserveMs < 0 ||
        this.state.finalizationReserveMs + (this.state.verificationReserveMs || 0) >= this.state.limits.wallMs) {
      fail('BUDGET_SNAPSHOT_INVALID', 'restored finalization reserve consumes the wall budget')
    }
  }
}

function zeroAccountingValues() {
  return {
    launches: 0,
    retries: 0,
    sessions: 0,
    elapsedMilliseconds: 0,
    costMicrounits: 0,
    tokenUsage: { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 },
  }
}

function validateAccountingValues(values, label) {
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
      Object.keys(values).length !== ACCOUNTING_VALUE_FIELDS.length ||
      ACCOUNTING_VALUE_FIELDS.some((field) => !Object.hasOwn(values, field)) ||
      ['launches', 'retries', 'sessions', 'elapsedMilliseconds', 'costMicrounits'].some((field) =>
        !Number.isSafeInteger(values[field]) || values[field] < 0) ||
      !values.tokenUsage || typeof values.tokenUsage !== 'object' || Array.isArray(values.tokenUsage) ||
      Object.keys(values.tokenUsage).length !== TOKEN_FIELDS.length ||
      TOKEN_FIELDS.some((field) => !Number.isSafeInteger(values.tokenUsage[field]) || values.tokenUsage[field] < 0)) {
    fail('ACCOUNTING_VALUES_INVALID', `${label} must contain every non-negative cumulative accounting value`)
  }
  return canonicalize(values)
}

function addAccountingValues(left, right) {
  return canonicalize({
    launches: left.launches + right.launches,
    retries: left.retries + right.retries,
    sessions: left.sessions + right.sessions,
    elapsedMilliseconds: left.elapsedMilliseconds + right.elapsedMilliseconds,
    costMicrounits: left.costMicrounits + right.costMicrounits,
    tokenUsage: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, left.tokenUsage[field] + right.tokenUsage[field]])),
  })
}

function accountingRecordHash(record) {
  const unsigned = { ...record }
  delete unsigned.entryHash
  return sha256(stableStringify(unsigned))
}

function accountingSnapshotHash(snapshot) {
  const unsigned = { ...snapshot }
  delete unsigned.snapshotHash
  return sha256(stableStringify(unsigned))
}

function validateCeilings(ceilings) {
  const positiveFields = ['wallMilliseconds', 'totalTokens', 'sessions', 'launches', 'retries', 'costMicrounits']
  const reserveFields = ['verificationReserveMilliseconds', 'finalizationReserveMilliseconds']
  const required = [...positiveFields, ...reserveFields]
  if (!ceilings || typeof ceilings !== 'object' || Array.isArray(ceilings) ||
      Object.keys(ceilings).length !== required.length || required.some((field) => !Object.hasOwn(ceilings, field)) ||
      positiveFields.some((field) => !Number.isSafeInteger(ceilings[field]) || ceilings[field] < 1) ||
      reserveFields.some((field) => !Number.isSafeInteger(ceilings[field]) || ceilings[field] < 0) ||
      ceilings.verificationReserveMilliseconds + ceilings.finalizationReserveMilliseconds >= ceilings.wallMilliseconds) {
    fail('ACCOUNTING_CEILINGS_INVALID', 'accounting requires complete positive immutable ceilings')
  }
  return canonicalize(ceilings)
}

function assertUnderCeilings(cumulative, ceilings, options = {}) {
  const totalTokens = BILLABLE_TOKEN_FIELDS.reduce(
    (total, field) => total + cumulative.tokenUsage[field], 0,
  )
  const checks = [
    ['wallMilliseconds', cumulative.elapsedMilliseconds],
    ['totalTokens', totalTokens],
    ['sessions', cumulative.sessions],
    ['launches', cumulative.launches],
    ['retries', cumulative.retries],
    ['costMicrounits', cumulative.costMicrounits],
  ]
  for (const [field, used] of checks) {
    if (options.allowCompletionTargetOverrun === true &&
        ['wallMilliseconds', 'totalTokens', 'sessions', 'costMicrounits'].includes(field)) continue
    if (options.allowCompletionTargetOverrun === true &&
        ['launches', 'retries'].includes(field) && used > ceilings[field]) {
      const previousUsed = Number(options.previousCumulative && options.previousCumulative[field] || 0)
      // A later zero-delta checkpoint may preserve an already authenticated
      // completion overrun.  Any further launch/retry increase still needs a
      // fresh required-completion binding on that exact accounting record.
      if (used === previousUsed || options.requiredCompletion === true) continue
    }
    if (used > ceilings[field]) fail('BUDGET_EXHAUSTED', `accounting cumulative ${field} exceeds its immutable ceiling`, { field, used, ceiling: ceilings[field] })
  }
}

function validateAccountingClock(clock) {
  return Boolean(clock && typeof clock === 'object' && !Array.isArray(clock) &&
    clock.source === 'process-monotonic-clock' &&
    (clock.bootId === null || (typeof clock.bootId === 'string' && clock.bootId.length >= 1 && clock.bootId.length <= 255)) &&
    (clock.previousObservedMilliseconds === null || (Number.isSafeInteger(clock.previousObservedMilliseconds) && clock.previousObservedMilliseconds >= 0)) &&
    Number.isSafeInteger(clock.observedMilliseconds) && clock.observedMilliseconds >= 0)
}

class AccountingAuthority {
  constructor(options = {}) {
    if (!options.paths || typeof options.paths.runRecordRoot !== 'string' ||
        typeof options.paths.logPath !== 'string' || typeof options.paths.snapshotPath !== 'string' ||
        typeof options.capabilityVerifier !== 'function' || typeof options.stateProvider !== 'function' ||
        !options.eventLog || typeof options.eventLog.readAll !== 'function') {
      fail('ACCOUNTING_CONFIG_INVALID', 'accounting requires registered paths, capability verifier, state provider, and canonical event log')
    }
    this.runRecordRoot = path.resolve(options.paths.runRecordRoot)
    this.logPath = path.resolve(options.paths.logPath)
    this.snapshotPath = path.resolve(options.paths.snapshotPath)
    for (const candidate of [this.logPath, this.snapshotPath]) {
      if (!pathIsInside(this.runRecordRoot, candidate)) fail('ACCOUNTING_CONFIG_INVALID', 'accounting path escapes its run record')
    }
    if (this.logPath === this.snapshotPath) fail('ACCOUNTING_CONFIG_INVALID', 'accounting log and snapshot paths must be distinct')
    this.capabilityVerifier = options.capabilityVerifier
    this.stateProvider = options.stateProvider
    this.eventLog = options.eventLog
    this.fs = options.fsImpl || fs
    this.monotonicMs = options.monotonicMs || defaultMonotonicMs
    this.wallNowMs = options.wallNowMs || Date.now
    this.clock = options.clock || (() => new Date().toISOString())
    this.bootId = options.bootId === undefined ? detectBootId(this.fs) : options.bootId
    this.allowCompletionTargetOverrun = options.allowCompletionTargetOverrun === true
    this.ceilings = validateCeilings(options.ceilings || (options.budgetController &&
      options.budgetController.accountingCeilings(options.additionalCeilings)))
    this.ceilingContractHash = sha256(stableStringify(this.ceilings))
    this.lockTimeoutMs = options.lockTimeoutMs === undefined ? 5000 : options.lockTimeoutMs
    this.lockPollMs = options.lockPollMs === undefined ? 10 : options.lockPollMs
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs <= 0 ||
        !Number.isFinite(this.lockPollMs) || this.lockPollMs <= 0) {
      fail('ACCOUNTING_CONFIG_INVALID', 'accounting lock bounds must be positive finite numbers')
    }
  }

  replay() {
    const records = this._readRecords()
    const savedSnapshot = this._readSnapshot(records)
    const recoveryRequired = Boolean(records.length && !savedSnapshot)
    const snapshot = savedSnapshot || (records.length ? this._snapshotFor(records.at(-1)) : null)
    return Object.freeze({
      records,
      snapshot,
      recoveryRequired,
      cumulative: records.length ? records.at(-1).cumulative : zeroAccountingValues(),
    })
  }

  resumeCheckpoint() {
    const replayed = this.replay()
    if (replayed.recoveryRequired || !replayed.snapshot || !replayed.records.length) {
      fail('ACCOUNTING_RECOVERY_REQUIRED', 'crash adoption requires one fully persisted accounting log and snapshot checkpoint')
    }
    const snapshot = replayed.snapshot
    return Object.freeze(canonicalize({
      schemaVersion: '2.0.0',
      runId: snapshot.runId,
      activationId: snapshot.activationId,
      activationNonce: snapshot.activationNonce,
      generation: snapshot.generation,
      stateEventSequence: snapshot.stateEventSequence,
      stateEventHash: snapshot.stateEventHash,
      lastAccountingSequence: snapshot.lastAccountingSequence,
      lastAccountingHash: snapshot.lastAccountingHash,
      snapshotHash: snapshot.snapshotHash,
      cumulativeHash: sha256(stableStringify(snapshot.cumulative)),
      ceilingContractHash: snapshot.ceilingContractHash,
    }))
  }

  verifyResumeCheckpoint(checkpoint) {
    const expected = this.resumeCheckpoint()
    if (!checkpoint || stableStringify(checkpoint) !== stableStringify(expected)) {
      fail('ACCOUNTING_CHECKPOINT_INVALID', 'resume accounting evidence does not match the persisted hash chain and snapshot')
    }
    return expected
  }

  checkpoint(input = {}) {
    const state = this.stateProvider()
    const binding = this._authorize(input.capability, state)
    if (!Number.isSafeInteger(state.sequence) || state.sequence < 1 || !HASH_PATTERN.test(state.lastEventHash || '')) {
      fail('ACCOUNTING_STATE_UNBOUND', 'accounting requires one persisted canonical state event')
    }
    const cause = input.cause
    if (!cause || !ACCOUNTING_CAUSES.includes(cause.kind) ||
        typeof cause.causeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(cause.causeId) ||
        typeof cause.humanDescription !== 'string' || !cause.humanDescription || cause.humanDescription.length > 500 ||
        (cause.requiredCompletion !== undefined && cause.requiredCompletion !== true)) {
      fail('ACCOUNTING_CAUSE_INVALID', 'accounting checkpoint requires one canonical typed cause')
    }
    const requiredCompletion = input.requiredCompletion === true
    if (requiredCompletion && !['LAUNCH', 'RETRY', 'RECOVERY'].includes(cause.kind)) {
      fail('ACCOUNTING_CAUSE_INVALID', 'required completion authority is valid only for an admitted launch, retry, or recovery continuation')
    }
    if ((cause.requiredCompletion === true) !== requiredCompletion) {
      fail('ACCOUNTING_CAUSE_INVALID', 'required completion authority must be explicit in both the checkpoint and its durable cause')
    }
    const requestedDelta = validateAccountingValues(input.delta || zeroAccountingValues(), 'accounting delta')
    const lockPath = path.join(path.dirname(this.logPath), '.accounting.lock')
    const recoveryDirectory = path.join(path.dirname(this.logPath), 'recovered-locks')
    const deadline = Date.now() + this.lockTimeoutMs
    while (true) {
      try {
        return withOwnedLock(lockPath, () => {
          const records = this._readRecords()
          this._readSnapshot(records)
          const previous = records.at(-1) || null
          let occurredAt = String(this.clock())
          if (Number.isNaN(Date.parse(occurredAt))) fail('ACCOUNTING_CLOCK_INVALID', 'accounting wall clock is not a date-time')
          const observed = Math.floor(this.monotonicMs())
          if (!Number.isSafeInteger(observed) || observed < 0) fail('ACCOUNTING_CLOCK_INVALID', 'accounting monotonic clock is invalid')
          const sameBoot = previous && previous.monotonicClock.bootId && this.bootId && previous.monotonicClock.bootId === this.bootId
          let conservativeElapsed = requestedDelta.elapsedMilliseconds
          let previousObserved = null
          if (previous) {
            if (sameBoot) {
              if (observed < previous.monotonicClock.observedMilliseconds) fail('BUDGET_CLOCK_RESET', 'same-boot accounting monotonic clock moved backward')
              previousObserved = previous.monotonicClock.observedMilliseconds
              conservativeElapsed = Math.max(conservativeElapsed, observed - previousObserved)
            } else {
              const wallDelta = Date.parse(occurredAt) - Date.parse(previous.occurredAt)
              if (!Number.isFinite(wallDelta)) fail('ACCOUNTING_CLOCK_INVALID', 'accounting wall-clock continuity is invalid')
              if (wallDelta >= 0) conservativeElapsed = Math.max(conservativeElapsed, wallDelta)
            }
            // Preserve a monotonic persisted timestamp even when the host wall
            // clock is corrected backwards. Existing record/hash rollback is
            // still rejected by _validateRecord; this only canonicalizes a new
            // authenticated checkpoint at the prior wall-clock high-water.
            if (Date.parse(occurredAt) < Date.parse(previous.occurredAt)) {
              occurredAt = previous.occurredAt
            }
          }
          const delta = canonicalize({ ...requestedDelta, elapsedMilliseconds: conservativeElapsed })
          const cumulative = addAccountingValues(previous ? previous.cumulative : zeroAccountingValues(), delta)
          assertUnderCeilings(cumulative, this.ceilings, {
            allowCompletionTargetOverrun: this.allowCompletionTargetOverrun,
            previousCumulative: previous ? previous.cumulative : zeroAccountingValues(),
            requiredCompletion,
          })
          const record = canonicalize({
            schemaVersion: '2.0.0',
            runId: binding.runId,
            activationId: binding.activationId,
            activationNonce: binding.nonce,
            generation: binding.generation,
            stateEventSequence: state.sequence,
            stateEventHash: state.lastEventHash,
            monotonicClock: {
              source: 'process-monotonic-clock',
              bootId: this.bootId,
              previousObservedMilliseconds: previousObserved,
              observedMilliseconds: observed,
            },
            cumulative,
            delta,
            cause,
            sequence: previous ? previous.sequence + 1 : 1,
            previousHash: previous ? previous.entryHash : null,
            entryHash: '0'.repeat(64),
            occurredAt,
          })
          record.entryHash = accountingRecordHash(record)
          this._validateRecord(record, previous)
          this._appendRecord(record)
          const snapshot = this._snapshotFor(record)
          atomicWriteFile(this.snapshotPath, `${stableStringify(snapshot)}\n`, { fsImpl: this.fs, mode: FILE_MODE })
          return Object.freeze({ record: Object.freeze(record), snapshot: Object.freeze(snapshot) })
        }, { recoveryDirectory })
      } catch (error) {
        if (error.code !== 'RUN_RECORD_BUSY' || Date.now() >= deadline) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(this.lockPollMs, Math.max(1, deadline - Date.now())))
      }
    }
  }

  recoverCrashTail(input = {}) {
    const state = this.stateProvider()
    this._authorize(input.capability, state)
    const lockPath = path.join(path.dirname(this.logPath), '.accounting.lock')
    const recoveryDirectory = path.join(path.dirname(this.logPath), 'recovered-locks')
    return withOwnedLock(lockPath, () => {
      const bytes = readFileNoFollow(this.logPath)
      if (bytes === null || bytes.length === 0 || bytes.at(-1) === 0x0a) {
        return Object.freeze({ recovered: false, records: this._readRecords() })
      }
      const lastNewline = bytes.lastIndexOf(0x0a)
      const completeLength = lastNewline < 0 ? 0 : lastNewline + 1
      const tail = bytes.subarray(completeLength)
      const digest = sha256(tail)
      const evidenceDirectory = path.join(this.runRecordRoot, 'runtime', 'recovery', 'incomplete-accounting-tail')
      this.fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
      const evidencePath = path.join(evidenceDirectory, `${digest}.bin`)
      if (this.fs.existsSync(evidencePath)) {
        const retained = readFileNoFollow(evidencePath)
        if (!retained || !retained.equals(tail)) fail('ACCOUNTING_LOG_UNSAFE', 'accounting crash-tail evidence hash collision')
      } else {
        let evidenceDescriptor
        try {
          evidenceDescriptor = this.fs.openSync(evidencePath, this.fs.constants.O_WRONLY | this.fs.constants.O_CREAT |
            this.fs.constants.O_EXCL | (this.fs.constants.O_NOFOLLOW || 0), FILE_MODE)
          let offset = 0
          while (offset < tail.length) offset += this.fs.writeSync(evidenceDescriptor, tail, offset, tail.length - offset)
          this.fs.fsyncSync(evidenceDescriptor)
        } finally { if (evidenceDescriptor !== undefined) this.fs.closeSync(evidenceDescriptor) }
      }
      if (input.truncateIncompleteTail !== true) {
        fail('ACCOUNTING_RECOVERY_REQUIRED', 'accounting crash tail was preserved but requires explicit truncation', {
          evidencePath,
          incompleteBytes: tail.length,
        })
      }
      let descriptor
      try {
        descriptor = this.fs.openSync(this.logPath, this.fs.constants.O_WRONLY | (this.fs.constants.O_NOFOLLOW || 0))
        this.fs.ftruncateSync(descriptor, completeLength)
        this.fs.fsyncSync(descriptor)
      } finally { if (descriptor !== undefined) this.fs.closeSync(descriptor) }
      return Object.freeze({ recovered: true, evidencePath, incompleteBytes: tail.length, records: this._readRecords() })
    }, { recoveryDirectory })
  }

  _authorize(capability, state) {
    let binding
    try { binding = this.capabilityVerifier(capability) } catch (error) {
      fail('LEASE_CAPABILITY_REQUIRED', 'accounting checkpoint requires the opaque live lease capability', { cause: error.message })
    }
    if (!binding || binding.runId !== state.runId || binding.activationId !== state.activation.id ||
        binding.nonce !== state.activation.nonce || binding.generation !== state.activation.generation ||
        binding.missionHash !== state.activation.missionHash || binding.targetIdentity !== state.targetIdentity) {
      fail('LEASE_CAPABILITY_REQUIRED', 'accounting capability does not bind the exact runtime activation')
    }
    return binding
  }

  _readRecords() {
    const bytes = readFileNoFollow(this.logPath)
    if (bytes === null || bytes.length === 0) return Object.freeze([])
    if (bytes.at(-1) !== 0x0a) fail('ACCOUNTING_RECOVERY_REQUIRED', 'accounting log has an incomplete crash tail')
    const records = []
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line) continue
      let record
      try { record = JSON.parse(line) } catch (error) { fail('ACCOUNTING_LOG_INVALID', 'accounting log contains malformed complete JSON', { cause: error.message }) }
      this._validateRecord(record, records.at(-1) || null)
      records.push(Object.freeze(record))
    }
    return Object.freeze(records)
  }

  _validateRecord(record, previous) {
    const required = ACCOUNTING_RECORD_SCHEMA.required
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        Object.keys(record).length !== required.length || required.some((field) => !Object.hasOwn(record, field)) ||
        record.schemaVersion !== '2.0.0' || typeof record.runId !== 'string' || record.runId.length < 8 ||
        typeof record.activationId !== 'string' || !record.activationId || !/^[A-Za-z0-9_-]{16,128}$/.test(record.activationNonce || '') ||
        !Number.isSafeInteger(record.generation) || record.generation < 1 || !Number.isSafeInteger(record.stateEventSequence) || record.stateEventSequence < 1 ||
        !HASH_PATTERN.test(record.stateEventHash || '') || !validateAccountingClock(record.monotonicClock) ||
        !Number.isSafeInteger(record.sequence) || record.sequence !== (previous ? previous.sequence + 1 : 1) ||
        record.previousHash !== (previous ? previous.entryHash : null) || !HASH_PATTERN.test(record.entryHash || '') ||
        record.entryHash !== accountingRecordHash(record) || Number.isNaN(Date.parse(record.occurredAt)) ||
        !record.cause || typeof record.cause !== 'object' || Array.isArray(record.cause) ||
        ![3, 4].includes(Object.keys(record.cause).length) ||
        !['kind', 'causeId', 'humanDescription'].every((field) => Object.hasOwn(record.cause, field)) ||
        (Object.hasOwn(record.cause, 'requiredCompletion') && record.cause.requiredCompletion !== true) ||
        !ACCOUNTING_CAUSES.includes(record.cause.kind) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(record.cause.causeId || '') ||
        typeof record.cause.humanDescription !== 'string' || !record.cause.humanDescription || record.cause.humanDescription.length > 500) {
      fail('ACCOUNTING_LOG_INVALID', 'accounting record violates its canonical schema, sequence, or hash chain')
    }
    const delta = validateAccountingValues(record.delta, 'accounting record delta')
    const cumulative = validateAccountingValues(record.cumulative, 'accounting record cumulative')
    const expected = addAccountingValues(previous ? previous.cumulative : zeroAccountingValues(), delta)
    if (stableStringify(cumulative) !== stableStringify(expected)) fail('ACCOUNTING_ROLLBACK', 'accounting cumulative values decreased, jumped, or do not equal prior plus delta')
    if (previous && record.generation < previous.generation) fail('ACCOUNTING_ROLLBACK', 'accounting generation decreased')
    if (previous && record.stateEventSequence < previous.stateEventSequence) fail('ACCOUNTING_ROLLBACK', 'accounting state event sequence decreased')
    if (previous && Date.parse(record.occurredAt) < Date.parse(previous.occurredAt)) fail('ACCOUNTING_ROLLBACK', 'accounting wall time decreased')
    if (previous && previous.monotonicClock.bootId && record.monotonicClock.bootId === previous.monotonicClock.bootId &&
        (record.monotonicClock.previousObservedMilliseconds !== previous.monotonicClock.observedMilliseconds ||
          record.monotonicClock.observedMilliseconds < previous.monotonicClock.observedMilliseconds)) {
      fail('ACCOUNTING_CLOCK_INVALID', 'same-boot accounting monotonic evidence has a gap or rollback')
    }
    const events = this.eventLog.readAll()
    const event = events[record.stateEventSequence - 1]
    const currentState = this.stateProvider()
    if (!event || event.hash !== record.stateEventHash || !event.details || !event.details.stateEvent ||
        event.details.stateEvent.sequence !== record.stateEventSequence || event.details.stateEvent.runId !== record.runId ||
        event.details.stateEvent.activationNonce !== record.activationNonce || event.generation !== record.generation ||
        currentState.runId !== record.runId || currentState.activation.id !== record.activationId ||
        currentState.activation.nonce !== record.activationNonce || record.generation > currentState.activation.generation) {
      fail('ACCOUNTING_STATE_UNBOUND', 'accounting record does not bind a persisted canonical state event')
    }
    assertUnderCeilings(cumulative, this.ceilings, {
      allowCompletionTargetOverrun: this.allowCompletionTargetOverrun,
      previousCumulative: previous ? previous.cumulative : zeroAccountingValues(),
      requiredCompletion: record.cause.requiredCompletion === true,
    })
    return true
  }

  _readSnapshot(records) {
    const snapshotBytes = readFileNoFollow(this.snapshotPath)
    if (snapshotBytes === null) {
      if (records.length) return null
      return null
    }
    let snapshot
    try { snapshot = JSON.parse(snapshotBytes.toString('utf8')) } catch (error) {
      fail('ACCOUNTING_SNAPSHOT_INVALID', 'budget snapshot is malformed', { cause: error.message })
    }
    const required = ACCOUNTING_SNAPSHOT_SCHEMA.required
    const last = records.at(-1)
    const boundRecord = snapshot && Number.isSafeInteger(snapshot.lastAccountingSequence)
      ? records[snapshot.lastAccountingSequence - 1]
      : null
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
        Object.keys(snapshot).length !== required.length || required.some((field) => !Object.hasOwn(snapshot, field)) ||
        snapshot.schemaVersion !== '2.0.0' || snapshot.snapshotHash !== accountingSnapshotHash(snapshot) ||
        snapshot.ceilingContractHash !== this.ceilingContractHash || stableStringify(snapshot.ceilings) !== stableStringify(this.ceilings) ||
        !last || !boundRecord || snapshot.lastAccountingSequence > last.sequence ||
        snapshot.lastAccountingHash !== boundRecord.entryHash || snapshot.runId !== boundRecord.runId ||
        snapshot.activationId !== boundRecord.activationId || snapshot.activationNonce !== boundRecord.activationNonce ||
        snapshot.generation !== boundRecord.generation || snapshot.stateEventSequence !== boundRecord.stateEventSequence ||
        snapshot.stateEventHash !== boundRecord.stateEventHash ||
        stableStringify(snapshot.cumulative) !== stableStringify(boundRecord.cumulative) ||
        stableStringify(snapshot.monotonicClock) !== stableStringify(boundRecord.monotonicClock) ||
        snapshot.recordedAt !== boundRecord.occurredAt) {
      fail('ACCOUNTING_SNAPSHOT_INVALID', 'budget snapshot is foreign, corrupt, ahead of its log, or changes immutable ceilings')
    }
    if (snapshot.lastAccountingSequence < last.sequence) return null
    return Object.freeze(snapshot)
  }

  _snapshotFor(record) {
    const snapshot = canonicalize({
      schemaVersion: '2.0.0',
      runId: record.runId,
      activationId: record.activationId,
      activationNonce: record.activationNonce,
      generation: record.generation,
      lastAccountingSequence: record.sequence,
      lastAccountingHash: record.entryHash,
      stateEventSequence: record.stateEventSequence,
      stateEventHash: record.stateEventHash,
      monotonicClock: record.monotonicClock,
      cumulative: record.cumulative,
      ceilings: this.ceilings,
      ceilingContractHash: this.ceilingContractHash,
      snapshotHash: '0'.repeat(64),
      recordedAt: record.occurredAt,
    })
    snapshot.snapshotHash = accountingSnapshotHash(snapshot)
    return snapshot
  }

  _appendRecord(record) {
    this.fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 })
    let descriptor
    try {
      descriptor = this.fs.openSync(this.logPath, this.fs.constants.O_WRONLY | this.fs.constants.O_CREAT |
        this.fs.constants.O_APPEND | (this.fs.constants.O_NOFOLLOW || 0), FILE_MODE)
      const opened = this.fs.fstatSync(descriptor)
      const bound = this.fs.lstatSync(this.logPath)
      if (!opened.isFile() || bound.isSymbolicLink() || !bound.isFile() ||
          Number(opened.nlink) !== 1 || Number(bound.nlink) !== 1 ||
          String(opened.dev) !== String(bound.dev) || String(opened.ino) !== String(bound.ino)) {
        fail('ACCOUNTING_LOG_UNSAFE', 'accounting log is not one bound regular physical file')
      }
      const bytes = Buffer.from(`${stableStringify(record)}\n`, 'utf8')
      let offset = 0
      while (offset < bytes.length) offset += this.fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
      this.fs.fsyncSync(descriptor)
    } finally { if (descriptor !== undefined) this.fs.closeSync(descriptor) }
  }
}

module.exports = {
  BUDGET_SCHEMA_VERSION,
  ACCOUNTING_CAUSES,
  ACCOUNTING_VALUE_FIELDS,
  AccountingAuthority,
  BudgetController,
  BudgetError,
  LIMIT_FIELDS,
  TOKEN_FIELDS,
  accountingRecordHash,
  accountingSnapshotHash,
  resolveCeilings,
  detectBootId,
  validatePhases,
}
