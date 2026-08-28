'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  FILE_MODE,
  RunRecordError,
  pathIsInside,
  inspectPathNoFollow,
  readFileNoFollow,
  ensureDirectoryNoFollow,
  assertDirectoryBinding,
  verifyRootOwnership,
  auditPrivatePermissions,
  selectSafeRunRoot,
  allocateRunDirectory,
  assertRunRecordBoundary,
  withOwnedLock,
} = require('./safe-run-root')
const requestApi = require('./request-envelope')
const routeApi = require('./route-transcript')
const routeDecisionApi = require('./route-decision')
const { stableStringify } = require('./event-log.js')
const ROLE_CONTRACT = require('../../contracts/roles.json')

const RUN_RECORD_SCHEMA = 'autoprompt.run-record.v2'
const PRE_MUTATION_BASELINE_PATH = 'checks/pre-mutation-baseline.json'
const ALL_WORK_JOINED_PATH = 'checks/all-work-joined.json'
const ROUTE_RECOMMENDATION_STATE_PATH = 'route/recommendation-state.json'
const CODEX_PHYSICAL_EXECUTION_PATH = 'route/codex-physical-execution.json'
const PLAN_PATHS = Object.freeze({ DIRECT: 'plan/success-card.md', LIGHT: 'plan/light-plan.md', ROADMAP: 'plan/ROADMAP.md' })
const RUNTIME_PATHS = Object.freeze({
  metadata: 'metadata.json',
  metadataDigest: 'metadata.sha256',
  state: 'runtime/state.json',
  transaction: 'runtime/state.json.transaction',
  events: 'runtime/events.jsonl',
  blobs: 'runtime/blobs',
  terminal: 'terminal.json',
  cleanupRegistry: 'cleanup/registry.json',
  processRegistry: 'runtime/processes.json',
  processControl: 'runtime/process-control',
  accounting: 'runtime/accounting.jsonl',
  budget: 'runtime/budget.json',
  recoveryCheckpoints: 'runtime/recovery-checkpoints.jsonl',
  recoveryCheckpoint: 'runtime/recovery-checkpoint.json',
  aliasTelemetry: ROLE_CONTRACT.aliasTelemetrySchema.appendPath,
})

const RUN_DIRECTORIES = Object.freeze([
  'request', 'request/objects', 'request/objects/sha256',
  'route', 'route/objects', 'route/objects/sha256',
  'plan', 'plan/projections', 'work', 'work/assignments', 'work/results',
  'checks', 'checks/review-results', 'checks/test-results',
  'runtime', 'runtime/blobs', 'runtime/process-control', 'runtime/recovered-locks',
  'runtime/recovery', 'runtime/recovery/incomplete-accounting-tail',
  'runtime/recovery/incomplete-recovery-checkpoint-tail', 'cleanup',
  'compatibility', 'compatibility/recovered-locks',
  'compatibility/recovery', 'compatibility/recovery/incomplete-alias-tail',
])

const EXACT_REGISTERED_PATHS = new Set([
  'request/envelope.jsonl', 'request/envelope.sha256', 'request/privacy.json', 'request/original-request.txt',
  'settings.json',
  'route/transcript.jsonl', 'route/transcript.sha256', 'route/transcript.md', 'route/evidence-index.json',
  'route/recommendation.json', ROUTE_RECOMMENDATION_STATE_PATH,
  'route/decision.json', 'route/decision.md', CODEX_PHYSICAL_EXECUTION_PATH,
  ...Object.values(PLAN_PATHS),
  'work/ownership.json', 'work/captured-domain-admission.json', 'work/deferred-promotion.json',
  'checks/commands.jsonl', PRE_MUTATION_BASELINE_PATH, ALL_WORK_JOINED_PATH, 'checks/captured-domain-outcomes.json',
  RUNTIME_PATHS.metadata, RUNTIME_PATHS.metadataDigest, RUNTIME_PATHS.state, RUNTIME_PATHS.transaction, RUNTIME_PATHS.events, RUNTIME_PATHS.terminal, RUNTIME_PATHS.cleanupRegistry, RUNTIME_PATHS.processRegistry,
  RUNTIME_PATHS.aliasTelemetry,
  RUNTIME_PATHS.accounting, RUNTIME_PATHS.budget,
  RUNTIME_PATHS.recoveryCheckpoints, RUNTIME_PATHS.recoveryCheckpoint,
  'final-summary.md',
])
const REGISTERED_PREFIXES = Object.freeze([
  'request/objects/sha256/', 'request/recovered-locks/', 'request/recovery/incomplete-envelope-tail/',
  'route/objects/sha256/', 'route/recovered-locks/', 'route/recovery/incomplete-transcript-tail/',
  'plan/projections/',
  'work/assignments/', 'work/results/', 'checks/review-results/', 'checks/test-results/', 'runtime/blobs/', 'runtime/process-control/',
  'compatibility/recovered-locks/',
  'compatibility/recovery/incomplete-alias-tail/',
  'runtime/recovered-locks/',
  'runtime/recovery/incomplete-accounting-tail/',
  'runtime/recovery/incomplete-recovery-checkpoint-tail/',
])
const OPTIONAL_DIRECTORIES = Object.freeze([
  ...RUN_DIRECTORIES,
  'request/recovered-locks', 'request/recovery', 'request/recovery/incomplete-envelope-tail',
  'route/recovered-locks', 'route/recovery', 'route/recovery/incomplete-transcript-tail',
  'compatibility/recovered-locks', 'compatibility/recovery', 'compatibility/recovery/incomplete-alias-tail',
])
const IMMUTABLE_PATHS = new Set([
  RUNTIME_PATHS.metadata, RUNTIME_PATHS.metadataDigest,
  PRE_MUTATION_BASELINE_PATH, ALL_WORK_JOINED_PATH, ROUTE_RECOMMENDATION_STATE_PATH,
])
const APPEND_ONLY_PATHS = new Set([RUNTIME_PATHS.aliasTelemetry, RUNTIME_PATHS.recoveryCheckpoints])
const ALIAS_TELEMETRY_KEYS = Object.freeze([
  'runId', 'activationId', 'generation', 'legacyId', 'logicalId', 'physicalId',
  'legacyReadVersion', 'canonicalWriteVersion', 'aliasUseCount', 'occurredAt',
  'previousHash', 'entryHash',
])
const ROLE_PHYSICAL_IDS = new Map([
  [ROLE_CONTRACT.orchestratorContract.id, ROLE_CONTRACT.orchestratorContract.physicalId],
  ...ROLE_CONTRACT.roles.map((role) => [role.id, role.physicalId]),
])
const COMPATIBILITY_ALIASES = new Map(ROLE_CONTRACT.compatibilityAliases.map((alias) => [alias.legacyId, alias]))

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record path must be non-empty and relative: ${relativePath}`)
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'))
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('/../')) throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record path escapes its run: ${relativePath}`)
  if (normalized.toLowerCase() === 'plan/roadmap.md' && normalized !== PLAN_PATHS.ROADMAP) throw new RunRecordError('RUN_RECORD_UNSAFE', `The only ROADMAP planning path is ${PLAN_PATHS.ROADMAP}; case aliases are rejected`)
  return normalized
}

function contentAddressedPathValid(relative) {
  const basename = path.posix.basename(relative)
  if (relative.startsWith('request/objects/sha256/') || relative.startsWith('route/objects/sha256/') || relative.startsWith('runtime/blobs/')) return /^[a-f0-9]{64}$/.test(basename)
  if (relative.startsWith('plan/projections/')) return /^plan\/projections\/[a-f0-9]{64}\.json$/.test(relative)
  if (relative.includes('/recovered-locks/')) return /^[a-f0-9]{64}\.json$/.test(basename)
  if (relative.includes('/incomplete-envelope-tail/') || relative.includes('/incomplete-transcript-tail/')) return /^[a-f0-9]{64}\.bin$/.test(basename)
  if (relative.includes('/incomplete-alias-tail/')) return /^[a-f0-9]{64}\.bin$/.test(basename)
  if (relative.includes('/incomplete-accounting-tail/')) return /^[a-f0-9]{64}\.bin$/.test(basename)
  if (relative.includes('/incomplete-recovery-checkpoint-tail/')) return /^[a-f0-9]{64}\.bin$/.test(basename)
  return true
}

function isRegisteredRunPath(relativePath) {
  let normalized
  try { normalized = normalizeRelativePath(relativePath) } catch { return false }
  if (EXACT_REGISTERED_PATHS.has(normalized)) return true
  return REGISTERED_PREFIXES.some(prefix => normalized.startsWith(prefix) && normalized.length > prefix.length) && contentAddressedPathValid(normalized)
}

function resolveRegisteredPath(runPath, relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  if (!isRegisteredRunPath(normalized)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Path is not registered in the run-record schema: ${normalized}`)
  const resolved = path.resolve(runPath, ...normalized.split('/'))
  if (!pathIsInside(runPath, resolved)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Registered path escapes run directory: ${normalized}`)
  return resolved
}

function canonicalPlanPath(runPath, route) {
  const relative = PLAN_PATHS[String(route || '').toUpperCase()]
  if (!relative) throw new RunRecordError('RUN_RECORD_FAILURE', `Unknown route for planning path: ${route}`)
  return resolveRegisteredPath(runPath, relative)
}

function assertExistingDestinationSafe(destination) {
  try {
    const stats = fs.lstatSync(destination)
    if (stats.isSymbolicLink() || !stats.isFile() || Number(stats.nlink) !== 1) throw new RunRecordError('RUN_RECORD_UNSAFE', `Unsafe registered destination: ${destination}`, { nlink: Number(stats.nlink) })
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function atomicWriteRegistered(record, relativePath, bytes, options = {}) {
  assertRunRecordBinding(record)
  const normalized = normalizeRelativePath(relativePath)
  if (IMMUTABLE_PATHS.has(normalized) && options.initializeImmutable !== true) throw new RunRecordError('RUN_RECORD_UNSAFE', `Immutable run metadata cannot be replaced: ${normalized}`)
  if (APPEND_ONLY_PATHS.has(normalized)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Append-only run authority cannot be replaced: ${normalized}`)
  const destination = resolveRegisteredPath(record.runPath, normalized)
  assertExistingDestinationSafe(destination)
  const parent = path.dirname(destination)
  if (!inspectPathNoFollow(parent).exists) throw new RunRecordError('RUN_RECORD_UNSAFE', `Registered parent is missing: ${parent}`)
  const temporary = path.join(parent, `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let fd
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
    assertRunRecordBinding(record); assertExistingDestinationSafe(destination)
    fs.renameSync(temporary, destination); assertRunRecordBinding(record)
    return destination
  } catch (error) {
    if (error instanceof RunRecordError) throw error
    throw new RunRecordError('RUN_RECORD_FAILURE', `Atomic run-record write failed: ${normalized}`, { cause: error.code || error.message })
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function validateAliasTelemetryRecord(record, expectedRunId) {
  const schema = ROLE_CONTRACT.aliasTelemetrySchema
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== ALIAS_TELEMETRY_KEYS.length ||
      Object.keys(record).some((key) => !ALIAS_TELEMETRY_KEYS.includes(key)) ||
      ALIAS_TELEMETRY_KEYS.some((key) => !Object.hasOwn(record, key)) ||
      typeof record.runId !== 'string' || record.runId.length < 8 ||
      (expectedRunId !== undefined && record.runId !== expectedRunId) ||
      typeof record.activationId !== 'string' || !record.activationId ||
      !Number.isSafeInteger(record.generation) || record.generation < 1 ||
      !/^ap-[a-z0-9-]+$/.test(record.legacyId || '') ||
      typeof record.logicalId !== 'string' || !record.logicalId ||
      !/^autoprompt\.v2\.[a-z][a-z0-9-]+$/.test(record.physicalId || '') ||
      record.legacyReadVersion !== schema.legacyReadVersion ||
      record.canonicalWriteVersion !== schema.canonicalWriteVersion ||
      !Number.isSafeInteger(record.aliasUseCount) || record.aliasUseCount < 1 ||
      typeof record.occurredAt !== 'string' || Number.isNaN(Date.parse(record.occurredAt)) ||
      !(record.previousHash === null || /^[a-f0-9]{64}$/.test(record.previousHash || '')) ||
      !/^[a-f0-9]{64}$/.test(record.entryHash || '')) return false
  const alias = COMPATIBILITY_ALIASES.get(record.legacyId)
  return Boolean(alias && alias.logicalId === record.logicalId &&
    ROLE_PHYSICAL_IDS.get(record.logicalId) === record.physicalId)
}

function aliasCounterKey(record) {
  return [record.runId, record.activationId, record.generation, record.legacyId, record.logicalId, record.physicalId].join('\u0000')
}

function aliasEntryHash(record) {
  const input = {}
  for (const key of ROLE_CONTRACT.aliasTelemetrySchema.hashChain.entryHashInputFields) input[key] = record[key]
  return crypto.createHash('sha256').update(stableStringify(input), 'utf8').digest('hex')
}

function readAliasTelemetry(record) {
  assertRunRecordBinding(record)
  const filename = resolveRegisteredPath(record.runPath, RUNTIME_PATHS.aliasTelemetry)
  const bytes = readFileNoFollow(filename)
  if (bytes === null || bytes.length === 0) return []
  if (bytes.at(-1) !== 0x0a) throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', 'Alias telemetry has an incomplete JSONL tail')
  const rows = []
  const counts = new Map()
  let previousHash = null
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch (error) {
      throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry contains invalid JSON', { cause: error.message })
    }
    if (!validateAliasTelemetryRecord(row, record.runId)) {
      throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry row violates the canonical roles contract')
    }
    if (row.previousHash !== previousHash || row.entryHash !== aliasEntryHash(row)) {
      throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry hash chain is invalid', {
        expectedPreviousHash: previousHash,
        actualPreviousHash: row.previousHash,
      })
    }
    const key = aliasCounterKey(row)
    const expected = (counts.get(key) || 0) + 1
    if (row.aliasUseCount !== expected) {
      throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry counter is not monotonic for its activation generation', {
        expected,
        actual: row.aliasUseCount,
      })
    }
    counts.set(key, expected)
    previousHash = row.entryHash
    rows.push(Object.freeze(row))
  }
  return Object.freeze(rows)
}


function preserveAliasCrashTail(record, tail) {
  const digest = crypto.createHash('sha256').update(tail).digest('hex')
  const relative = `compatibility/recovery/incomplete-alias-tail/${digest}.bin`
  const destination = resolveRegisteredPath(record.runPath, relative)
  if (fs.existsSync(destination)) {
    const retained = readFileNoFollow(destination)
    if (!retained || !retained.equals(tail)) throw new RunRecordError('RUN_RECORD_UNSAFE', 'Alias crash-tail evidence hash collision')
    return destination
  }
  let fd
  try {
    fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
    let offset = 0
    while (offset < tail.length) offset += fs.writeSync(fd, tail, offset, tail.length - offset)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  return destination
}

function recoverAliasTelemetry(record, options = {}) {
  assertRunRecordBinding(record)
  const filename = resolveRegisteredPath(record.runPath, RUNTIME_PATHS.aliasTelemetry)
  const lockPath = path.join(path.dirname(filename), '.alias-telemetry.lock')
  const recoveryDirectory = path.join(path.dirname(filename), 'recovered-locks')
  return withOwnedLock(lockPath, () => {
    const bytes = readFileNoFollow(filename)
    if (bytes === null || bytes.length === 0 || bytes.at(-1) === 0x0a) return readAliasTelemetry(record)
    const lastNewline = bytes.lastIndexOf(0x0a)
    const complete = lastNewline < 0 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline + 1)
    const tail = bytes.subarray(lastNewline + 1)
    const evidencePath = preserveAliasCrashTail(record, tail)
    if (options.truncateIncompleteTail !== true) {
      throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', 'Alias telemetry has one preserved incomplete JSONL tail', {
        evidencePath,
        incompleteBytes: tail.length,
      })
    }
    const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      fs.ftruncateSync(descriptor, complete.length)
      fs.fsyncSync(descriptor)
    } finally { fs.closeSync(descriptor) }
    return readAliasTelemetry(record)
  }, { recoveryDirectory })
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function appendAliasTelemetry(record, input, options = {}) {
  assertRunRecordBinding(record)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry input is required')
  }
  const inputKeys = new Set(['runId', 'activationId', 'generation', 'legacyId', 'logicalId', 'physicalId', 'occurredAt'])
  if (Object.keys(input).some((key) => !inputKeys.has(key))) {
    throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry counters and versions are deterministic and cannot be caller supplied')
  }
  if (input.runId !== undefined && input.runId !== record.runId) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', 'Alias telemetry runId does not match the opened run record')
  }
  const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs
  const pollMs = options.pollMs === undefined ? 10 : options.pollMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry timeoutMs and pollMs must be positive finite numbers')
  }
  const filename = resolveRegisteredPath(record.runPath, RUNTIME_PATHS.aliasTelemetry)
  const lockPath = path.join(path.dirname(filename), '.alias-telemetry.lock')
  const recoveryDirectory = path.join(path.dirname(filename), 'recovered-locks')
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      return withOwnedLock(lockPath, () => {
        const existing = readAliasTelemetry(record)
        const alias = COMPATIBILITY_ALIASES.get(input.legacyId)
        const occurredAt = input.occurredAt === undefined
          ? new Date(options.clock ? options.clock() : Date.now()).toISOString()
          : input.occurredAt
        const provisional = {
          runId: record.runId,
          activationId: input.activationId,
          generation: input.generation,
          legacyId: input.legacyId,
          logicalId: input.logicalId,
          physicalId: input.physicalId,
          legacyReadVersion: ROLE_CONTRACT.aliasTelemetrySchema.legacyReadVersion,
          canonicalWriteVersion: ROLE_CONTRACT.aliasTelemetrySchema.canonicalWriteVersion,
          aliasUseCount: 1,
          occurredAt,
          previousHash: existing.at(-1) ? existing.at(-1).entryHash : null,
          entryHash: '0'.repeat(64),
        }
        if (!alias || !validateAliasTelemetryRecord(provisional, record.runId)) {
          throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry does not bind one canonical legacy/logical/physical role mapping')
        }
        const key = aliasCounterKey(provisional)
        provisional.aliasUseCount = existing.filter((row) => aliasCounterKey(row) === key).length + 1
        provisional.entryHash = aliasEntryHash(provisional)
        if (!validateAliasTelemetryRecord(provisional, record.runId)) {
          throw new RunRecordError('RUN_RECORD_FAILURE', 'Alias telemetry producer emitted a noncanonical row')
        }
        assertExistingDestinationSafe(filename)
        let fd
        try {
          fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), FILE_MODE)
          const opened = fs.fstatSync(fd)
          const bound = fs.lstatSync(filename)
          if (!opened.isFile() || bound.isSymbolicLink() || !bound.isFile() || Number(opened.nlink) !== 1 || Number(bound.nlink) !== 1 ||
              (Number.isFinite(opened.dev) && Number.isFinite(bound.dev) && (String(opened.dev) !== String(bound.dev) || String(opened.ino) !== String(bound.ino)))) {
            throw new RunRecordError('RUN_RECORD_UNSAFE', 'Alias telemetry append destination changed identity')
          }
          const bytes = Buffer.from(`${JSON.stringify(provisional)}\n`, 'utf8')
          let offset = 0
          while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
          fs.fsyncSync(fd)
        } finally {
          if (fd !== undefined) fs.closeSync(fd)
        }
        assertRunRecordBinding(record)
        const saved = readAliasTelemetry(record).at(-1)
        if (!saved || aliasCounterKey(saved) !== key || saved.aliasUseCount !== provisional.aliasUseCount) {
          throw new RunRecordError('RUN_RECORD_FAILURE', 'Durable alias telemetry append could not be reconciled')
        }
        return Object.freeze(saved)
      }, { recoveryDirectory })
    } catch (error) {
      if (error.code !== 'RUN_RECORD_BUSY' || Date.now() >= deadline) throw error
      sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }
}

function assertRunRecordBinding(record) {
  assertDirectoryBinding(record.rootBinding); assertDirectoryBinding(record.runBinding)
  if (!pathIsInside(record.rootPath, record.runPath)) throw new RunRecordError('RUN_RECORD_UNSAFE', 'Run directory escaped its selected root')
  return true
}

function runtimeIntegrationPaths(runPath) {
  const statePath = path.join(runPath, RUNTIME_PATHS.state)
  const eventPath = path.join(runPath, RUNTIME_PATHS.events)
  const terminalPath = path.join(runPath, RUNTIME_PATHS.terminal)
  return Object.freeze({
    metadataPath: path.join(runPath, RUNTIME_PATHS.metadata),
    metadataDigestPath: path.join(runPath, RUNTIME_PATHS.metadataDigest),
    eventLog: Object.freeze({ logPath: eventPath, blobDirectory: path.join(runPath, RUNTIME_PATHS.blobs) }),
    stateStore: Object.freeze({ paths: Object.freeze({
      runRecordRoot: runPath, statePath, eventPath, terminalPath,
      transactionPath: path.join(runPath, RUNTIME_PATHS.transaction),
    }) }),
    terminalPath,
    cleanupRegistry: Object.freeze({ registryPath: path.join(runPath, RUNTIME_PATHS.cleanupRegistry) }),
    processRegistry: path.join(runPath, RUNTIME_PATHS.processRegistry),
    processControl: path.join(runPath, RUNTIME_PATHS.processControl),
    accounting: Object.freeze({
      runRecordRoot: runPath,
      logPath: path.join(runPath, RUNTIME_PATHS.accounting),
      snapshotPath: path.join(runPath, RUNTIME_PATHS.budget),
    }),
    recoveryCheckpoints: Object.freeze({
      runRecordRoot: runPath,
      logPath: path.join(runPath, RUNTIME_PATHS.recoveryCheckpoints),
      snapshotPath: path.join(runPath, RUNTIME_PATHS.recoveryCheckpoint),
    }),
    aliasTelemetry: path.join(runPath, RUNTIME_PATHS.aliasTelemetry),
  })
}

function baselineRecordHash(record) {
  const unsigned = { ...record }
  delete unsigned.recordHash
  return crypto.createHash('sha256').update(stableStringify(unsigned), 'utf8').digest('hex')
}

function createPreMutationBaseline(input = {}) {
  const existingTests = Array.isArray(input.existingTests) ? input.existingTests.map(entry => ({
    id: entry.id,
    command: entry.command,
    exitCode: entry.exitCode,
    status: entry.status,
    outputHash: entry.outputHash,
  })) : []
  const dirty = input.dirtyTarget || {}
  const record = {
    schemaVersion: 1,
    capturedBeforeMutation: input.capturedBeforeMutation === true,
    targetStateHash: input.targetStateHash,
    environmentHash: input.environmentHash,
    dirtyTarget: {
      status: dirty.status,
      paths: Array.isArray(dirty.paths) ? [...new Set(dirty.paths)].sort() : [],
      snapshotHash: dirty.snapshotHash ?? null,
    },
    existingTests,
    decisionBaseline: input.decisionBaseline ?? null,
    fallback: input.fallback ?? null,
    capturedAt: input.capturedAt ?? new Date(input.nowMs ?? Date.now()).toISOString(),
    recordHash: '0'.repeat(64),
  }
  record.recordHash = baselineRecordHash(record)
  const validation = validatePreMutationBaseline(record)
  if (!validation.valid) throw new RunRecordError('BASELINE_INVALID', validation.errors.join('; '))
  return Object.freeze(record)
}

function validatePreMutationBaseline(record) {
  const errors = []
  const hash = value => /^[a-f0-9]{64}$/u.test(value || '')
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1 ||
      record.capturedBeforeMutation !== true) return { valid: false, errors: ['baseline must be captured before production mutation'] }
  if (!hash(record.targetStateHash) || !hash(record.environmentHash)) {
    errors.push('baseline targetStateHash and environmentHash must be SHA-256')
  }
  const dirty = record.dirtyTarget
  if (!dirty || !['CLEAN', 'DIRTY'].includes(dirty.status) || !Array.isArray(dirty.paths) ||
      new Set(dirty.paths).size !== dirty.paths.length || dirty.paths.some(item => typeof item !== 'string' || !item)) {
    errors.push('dirtyTarget must record CLEAN or DIRTY and unique affected paths')
  } else if (dirty.status === 'DIRTY' && (dirty.paths.length === 0 || !hash(dirty.snapshotHash))) {
    errors.push('DIRTY target baseline requires affected paths and a snapshot hash')
  } else if (dirty.status === 'CLEAN' && (dirty.paths.length !== 0 || dirty.snapshotHash !== null)) {
    errors.push('CLEAN target baseline cannot invent dirty paths or a snapshot hash')
  }
  if (!Array.isArray(record.existingTests)) errors.push('existingTests must be an array')
  else for (const entry of record.existingTests) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.command !== 'string' || !entry.command ||
        !Number.isSafeInteger(entry.exitCode) || !['PASS', 'FAIL'].includes(entry.status) ||
        (entry.exitCode === 0) !== (entry.status === 'PASS') || !hash(entry.outputHash)) {
      errors.push('each existing test baseline requires id, command, exact exit/status, and output hash')
    }
  }
  if (Array.isArray(record.existingTests) && record.existingTests.length === 0) {
    const fallback = record.fallback
    if (!fallback || fallback.reason !== 'NO_RELEVANT_EXISTING_TESTS' || !hash(fallback.evidenceHash) ||
        !Array.isArray(fallback.observableChecks) || fallback.observableChecks.length === 0 ||
        fallback.observableChecks.some(item => typeof item !== 'string' || !item)) {
      errors.push('no existing tests requires an evidence-bound observable fallback')
    }
  } else if (record.fallback !== null) errors.push('fallback must be null when existing tests were recorded')
  if (record.decisionBaseline !== null) {
    const decision = record.decisionBaseline
    const selectedIds = Array.isArray(decision?.selectedTestIds) ? decision.selectedTestIds : []
    if (!decision || !hash(decision.routeDecisionHash) || !hash(decision.evidenceHash) ||
        !['EXISTING_TESTS', 'OBSERVABLE_FALLBACK'].includes(decision.selection) ||
        new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => typeof id !== 'string' || !id) ||
        (decision.selection === 'EXISTING_TESTS' && (selectedIds.length === 0 ||
          record.existingTests.some(test => !selectedIds.includes(test.id)))) ||
        (decision.selection === 'OBSERVABLE_FALLBACK' && (selectedIds.length !== 0 || record.existingTests.length !== 0))) {
      errors.push('decisionBaseline must bind the route decision to the exact existing-test or observable-fallback selection')
    }
  }
  if (Number.isNaN(Date.parse(record.capturedAt))) errors.push('capturedAt must be a date-time')
  if (!hash(record.recordHash) || record.recordHash !== baselineRecordHash(record)) {
    errors.push('recordHash must bind the exact pre-mutation baseline')
  }
  return { valid: errors.length === 0, errors }
}

function createProductionPreMutationBaseline(input = {}) {
  const routeDecisionHash = input.routeDecisionHash ||
    (input.routeDecision && crypto.createHash('sha256').update(stableStringify(input.routeDecision)).digest('hex'))
  const existingTests = Array.isArray(input.existingTests) ? input.existingTests : []
  const selection = existingTests.length ? 'EXISTING_TESTS' : 'OBSERVABLE_FALLBACK'
  const selectedTestIds = existingTests.map(test => test && test.id).filter(Boolean)
  const decisionBody = { routeDecisionHash, selection, selectedTestIds }
  const decisionBaseline = {
    ...decisionBody,
    evidenceHash: input.decisionEvidenceHash || crypto.createHash('sha256').update(stableStringify({
      ...decisionBody,
      commands: existingTests.map(test => test.command),
      fallback: input.fallback || null,
    })).digest('hex'),
  }
  if (!/^[a-f0-9]{64}$/u.test(routeDecisionHash || '')) {
    throw new RunRecordError('BASELINE_DECISION_REQUIRED', 'production baseline requires the exact route-decision hash')
  }
  return createPreMutationBaseline({ ...input, existingTests, decisionBaseline })
}

function joinedReceiptHash(record) {
  const unsigned = { ...record }
  delete unsigned.receiptHash
  return crypto.createHash('sha256').update(stableStringify(unsigned)).digest('hex')
}

function validateAllWorkJoinedReceipt(record) {
  const errors = []
  const hash = value => /^[a-f0-9]{64}$/u.test(value || '')
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1 ||
      record.eventId !== 'ALL_WORK_JOINED') return { valid: false, errors: ['ALL_WORK_JOINED receipt is required'] }
  const bindings = record.graphBindings
  const bindingFields = ['missionHash', 'planHash', 'candidateHash', 'environmentHash', 'oracleHash', 'assumptionsHash']
  if (!bindings || bindingFields.some(field => !hash(bindings[field]))) {
    errors.push('ALL_WORK_JOINED must preserve every invalidation-graph binding')
  }
  const expectedVerdictKinds = record.checkerCount === 1
    ? ['independent-review'] : record.checkerCount === 2
      ? ['independent-review', 'independent-verification'] : []
  if (expectedVerdictKinds.length === 0 || !Array.isArray(record.verdicts) ||
      record.verdicts.length !== record.checkerCount ||
      new Set(record.verdicts.map(verdict => verdict && verdict.kind)).size !== record.checkerCount ||
      !expectedVerdictKinds.every(kind => record.verdicts.some(verdict => verdict?.kind === kind)) ||
      record.verdicts.some(verdict => !hash(verdict.verdictHash) || !['PASS', 'FAIL'].includes(verdict.status) ||
        !Array.isArray(verdict.evidenceIds) || verdict.evidenceIds.length === 0)) {
    errors.push('ALL_WORK_JOINED must preserve every verdict required by its exact checker count')
  }
  if (!hash(record.receiptHash) || record.receiptHash !== joinedReceiptHash(record)) {
    errors.push('receiptHash must bind the exact join graph, checker count, and verdicts')
  }
  return { valid: errors.length === 0, errors }
}

function createAllWorkJoinedReceipt(input = {}) {
  const record = {
    schemaVersion: 1,
    eventId: 'ALL_WORK_JOINED',
    checkerCount: input.checkerCount ?? (Array.isArray(input.verdicts) ? input.verdicts.length : null),
    graphBindings: input.graphBindings ? { ...input.graphBindings } : null,
    verdicts: Array.isArray(input.verdicts) ? input.verdicts.map(verdict => ({
      kind: verdict.kind,
      status: verdict.status,
      verdictHash: verdict.verdictHash,
      evidenceIds: Array.isArray(verdict.evidenceIds) ? [...verdict.evidenceIds] : verdict.evidenceIds,
    })) : input.verdicts,
    joinedAt: input.joinedAt ?? new Date(input.nowMs ?? Date.now()).toISOString(),
    receiptHash: '0'.repeat(64),
  }
  record.receiptHash = joinedReceiptHash(record)
  const validation = validateAllWorkJoinedReceipt(record)
  if (!validation.valid) throw new RunRecordError('ALL_WORK_JOINED_INVALID', validation.errors.join('; '))
  return Object.freeze(record)
}

function writeAllWorkJoinedReceipt(record, input) {
  const receipt = input && input.receiptHash ? input : createAllWorkJoinedReceipt(input)
  const validation = validateAllWorkJoinedReceipt(receipt)
  if (!validation.valid) throw new RunRecordError('ALL_WORK_JOINED_INVALID', validation.errors.join('; '))
  const destination = resolveRegisteredPath(record.runPath, ALL_WORK_JOINED_PATH)
  if (fs.existsSync(destination)) throw new RunRecordError('ALL_WORK_JOINED_IMMUTABLE', 'ALL_WORK_JOINED receipt is already frozen')
  atomicWriteRegistered(record, ALL_WORK_JOINED_PATH, `${JSON.stringify(receipt, null, 2)}\n`, { initializeImmutable: true })
  return receipt
}

function readAllWorkJoinedReceipt(record) {
  assertRunRecordBinding(record)
  const bytes = readFileNoFollow(resolveRegisteredPath(record.runPath, ALL_WORK_JOINED_PATH))
  if (bytes === null) throw new RunRecordError('ALL_WORK_JOINED_REQUIRED', 'ALL_WORK_JOINED receipt is missing')
  let receipt
  try { receipt = JSON.parse(bytes.toString('utf8')) } catch (error) {
    throw new RunRecordError('ALL_WORK_JOINED_INVALID', 'ALL_WORK_JOINED receipt is not JSON', { cause: error.message })
  }
  const validation = validateAllWorkJoinedReceipt(receipt)
  if (!validation.valid) throw new RunRecordError('ALL_WORK_JOINED_INVALID', validation.errors.join('; '))
  return Object.freeze(receipt)
}

function writePreMutationBaseline(record, input) {
  const baseline = input && input.recordHash ? input : createPreMutationBaseline(input)
  const validation = validatePreMutationBaseline(baseline)
  if (!validation.valid) throw new RunRecordError('BASELINE_INVALID', validation.errors.join('; '))
  const destination = resolveRegisteredPath(record.runPath, PRE_MUTATION_BASELINE_PATH)
  if (fs.existsSync(destination)) throw new RunRecordError('BASELINE_IMMUTABLE', 'pre-mutation baseline is already frozen')
  atomicWriteRegistered(record, PRE_MUTATION_BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, { initializeImmutable: true })
  return baseline
}

function readPreMutationBaseline(record) {
  assertRunRecordBinding(record)
  const bytes = readFileNoFollow(resolveRegisteredPath(record.runPath, PRE_MUTATION_BASELINE_PATH))
  if (bytes === null) throw new RunRecordError('BASELINE_REQUIRED', 'pre-mutation baseline is missing')
  let baseline
  try { baseline = JSON.parse(bytes.toString('utf8')) } catch (error) {
    throw new RunRecordError('BASELINE_INVALID', 'pre-mutation baseline is not JSON', { cause: error.message })
  }
  const validation = validatePreMutationBaseline(baseline)
  if (!validation.valid) throw new RunRecordError('BASELINE_INVALID', validation.errors.join('; '))
  return Object.freeze(baseline)
}

function writeRouteAnalystFallbackState(record, state) {
  const validation = routeDecisionApi.validateRouteAnalystFallbackState(state)
  if (!validation.valid) throw new RunRecordError('ROUTE_ANALYST_FALLBACK_INVALID', validation.errors.join('; '))
  const destination = resolveRegisteredPath(record.runPath, ROUTE_RECOMMENDATION_STATE_PATH)
  if (fs.existsSync(destination)) throw new RunRecordError('ROUTE_ANALYST_FALLBACK_IMMUTABLE', 'route analyst fallback is already frozen')
  atomicWriteRegistered(record, ROUTE_RECOMMENDATION_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { initializeImmutable: true })
  return state
}

function readRouteAnalystFallbackState(record) {
  assertRunRecordBinding(record)
  const bytes = readFileNoFollow(resolveRegisteredPath(record.runPath, ROUTE_RECOMMENDATION_STATE_PATH))
  if (bytes === null) throw new RunRecordError('ROUTE_ANALYST_FALLBACK_REQUIRED', 'route analyst fallback state is missing')
  let state
  try { state = JSON.parse(bytes.toString('utf8')) } catch (error) {
    throw new RunRecordError('ROUTE_ANALYST_FALLBACK_INVALID', 'route analyst fallback is not JSON', { cause: error.message })
  }
  const validation = routeDecisionApi.validateRouteAnalystFallbackState(state)
  if (!validation.valid) throw new RunRecordError('ROUTE_ANALYST_FALLBACK_INVALID', validation.errors.join('; '))
  return Object.freeze(state)
}

function metadataFor(record, options = {}) {
  return {
    schema: RUN_RECORD_SCHEMA, run_id: record.runId, root_kind: record.rootKind, provider_id: record.providerId,
    local_only: true, automatic_export_allowed: false,
    target_path: record.targetPath, target_identity: record.targetIdentity, target_identity_sha256: record.targetIdentitySha256,
    root_path: record.rootPath, run_path: record.runPath, root_binding: record.rootBinding, run_binding: record.runBinding,
    project_rejection: record.projectRejection, retention: options.retention || { mode: 'explicit-local-policy', automatic_delete: false },
    canonical_plan_paths: PLAN_PATHS, request_envelope: 'request/envelope.jsonl', route_transcript: 'route/transcript.jsonl',
    runtime_authority: {
      state: RUNTIME_PATHS.state, transaction: RUNTIME_PATHS.transaction, events: RUNTIME_PATHS.events,
      blobs: RUNTIME_PATHS.blobs, terminal: RUNTIME_PATHS.terminal, cleanup_registry: RUNTIME_PATHS.cleanupRegistry,
      process_registry: RUNTIME_PATHS.processRegistry, process_control: RUNTIME_PATHS.processControl,
      alias_telemetry: RUNTIME_PATHS.aliasTelemetry,
      accounting: RUNTIME_PATHS.accounting, budget: RUNTIME_PATHS.budget,
      recovery_checkpoints: RUNTIME_PATHS.recoveryCheckpoints,
      recovery_checkpoint: RUNTIME_PATHS.recoveryCheckpoint,
    },
    integration_dependencies: {
      'AP-ROUTE-016': 'RuntimeStateStore/EventLog must bind accepted evidence to request, plan, exact version being checked, environment, checks, and assumptions and invalidate transitive dependents.',
      'AP-ROUTE-018': 'RuntimeStateStore must emit the exact-version freeze event/digest and invalidate review plus verification after any authorized mutation.',
    },
  }
}

function auditRunRecordTree(record, options = {}) {
  assertRunRecordBinding(record)
  const seenDirectories = new Set([''])
  function walk(directory, relativeDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const filename = path.join(directory, entry.name)
      const stats = fs.lstatSync(filename)
      if (stats.isSymbolicLink()) throw new RunRecordError('RUN_RECORD_UNSAFE', `Linked entry in run record: ${relative}`)
      if (entry.isDirectory()) {
        if (!OPTIONAL_DIRECTORIES.includes(relative) && !REGISTERED_PREFIXES.some(prefix => prefix.startsWith(`${relative}/`) || relative.startsWith(prefix))) {
          throw new RunRecordError('RUN_RECORD_UNSAFE', `Unregistered run-record directory: ${relative}`)
        }
        seenDirectories.add(relative); walk(filename, relative); continue
      }
      if (!entry.isFile() || Number(stats.nlink) !== 1) throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record entry is not one private regular file: ${relative}`, { nlink: Number(stats.nlink) })
      if (/^\..+\.tmp$/i.test(entry.name) || /\.lock$/i.test(entry.name)) throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', `Unsafe temporary or lock residue requires bounded recovery: ${relative}`, { recoverable: true })
      if (!isRegisteredRunPath(relative)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Unregistered run-record file: ${relative}`)
    }
  }
  walk(record.runPath, '')
  if (options.requireInitialized) {
    for (const required of [RUNTIME_PATHS.metadata, 'request/envelope.jsonl', 'request/envelope.sha256']) {
      if (!fs.existsSync(path.join(record.runPath, ...required.split('/')))) throw new RunRecordError('RUN_RECORD_FAILURE', `Required run-record file is missing: ${required}`)
    }
  }
  if (options.permissions !== false) {
    auditPrivatePermissions(record.runPath, { additionalPaths: [record.rootPath, path.join(record.rootPath, '.autoprompt-owner.json')] })
  }
  return { valid: true, directories: [...seenDirectories].sort() }
}

function facade(data) {
  const record = {
    schema: RUN_RECORD_SCHEMA, runId: data.runId, rootKind: data.rootKind, providerId: data.providerId,
    rootPath: data.rootPath, runPath: data.runPath, targetPath: data.targetPath, targetIdentity: data.targetIdentity,
    targetIdentitySha256: data.targetIdentitySha256, rootBinding: data.rootBinding, runBinding: data.runBinding,
    projectRejection: data.projectRejection || null,
  }
  const requestDir = path.join(record.runPath, 'request'); const routeDir = path.join(record.runPath, 'route')
  Object.defineProperties(record, {
    paths: { enumerable: true, value: Object.freeze({ request: requestDir, route: routeDir, plan: path.join(record.runPath, 'plan'), roadmap: canonicalPlanPath(record.runPath, 'ROADMAP'), ...runtimeIntegrationPaths(record.runPath) }) },
    assertSafe: { value: () => assertRunRecordBinding(record) },
    auditTree: { value: options => auditRunRecordTree(record, options) },
    assertBoundary: { value: options => assertRunRecordBoundary({ kind: record.rootKind, rootPath: record.rootPath, binding: record.rootBinding, targetPath: record.targetPath }, options) },
    resolve: { value: relative => resolveRegisteredPath(record.runPath, relative) },
    write: { value: (relative, bytes) => atomicWriteRegistered(record, relative, bytes) },
    initializeRequest: { value: (turns, options = {}) => requestApi.createRequestEnvelope(requestDir, turns, { ...options, runId: record.runId }) },
    appendRequest: { value: (turn, options) => requestApi.appendRequestTurn(requestDir, turn, options) },
    loadRequest: { value: options => requestApi.loadRequestEnvelope(requestDir, options) },
    loadRequestFor: { value: (role, options = {}) => {
      if (!['L0', 'L1', 'L4'].includes(role)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Unknown request consumer role: ${role}`)
      return requestApi.loadRequestEnvelope(requestDir, { ...options, access: options.access || 'full-raw' })
    } },
    initializeRouteTranscript: { value: options => routeApi.createRouteTranscript(routeDir, options) },
    appendRouteEvent: { value: (event, options) => routeApi.appendRouteEvent(routeDir, event, options) },
    loadRouteTranscript: { value: options => routeApi.loadRouteTranscript(routeDir, options) },
    loadRouteFor: { value: (role, options = {}) => {
      if (!['L0', 'L1', 'L4'].includes(role)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Unknown route consumer role: ${role}`)
      const access = options.access || (role === 'L0' ? 'index-only' : 'full-raw')
      return routeApi.loadRouteTranscript(routeDir, { ...options, access })
    } },
    appendAliasTelemetry: { value: (entry, options) => appendAliasTelemetry(record, entry, options) },
    readAliasTelemetry: { value: () => readAliasTelemetry(record) },
    recoverAliasTelemetry: { value: options => recoverAliasTelemetry(record, options) },
    writePreMutationBaseline: { value: input => writePreMutationBaseline(record, input) },
    readPreMutationBaseline: { value: () => readPreMutationBaseline(record) },
    writeAllWorkJoinedReceipt: { value: input => writeAllWorkJoinedReceipt(record, input) },
    readAllWorkJoinedReceipt: { value: () => readAllWorkJoinedReceipt(record) },
    writeRouteAnalystFallbackState: { value: state => writeRouteAnalystFallbackState(record, state) },
    readRouteAnalystFallbackState: { value: () => readRouteAnalystFallbackState(record) },
  })
  return Object.freeze(record)
}

function createRunRecord(options = {}) {
  const selection = selectSafeRunRoot(options)
  const allocation = allocateRunDirectory(selection, { runId: options.runId, now: options.now })
  for (const relative of RUN_DIRECTORIES) ensureDirectoryNoFollow(path.join(allocation.runPath, ...relative.split('/')), allocation.runPath)
  const record = facade({
    runId: allocation.runId, rootKind: selection.kind, providerId: selection.providerId, rootPath: selection.rootPath,
    runPath: allocation.runPath, targetPath: selection.targetPath, targetIdentity: selection.targetIdentity,
    targetIdentitySha256: selection.targetIdentitySha256, rootBinding: selection.binding, runBinding: allocation.binding,
    projectRejection: selection.projectRejection,
  })
  const metadataBytes = Buffer.from(`${JSON.stringify(metadataFor(record, options), null, 2)}\n`, 'utf8')
  atomicWriteRegistered(record, RUNTIME_PATHS.metadata, metadataBytes, { initializeImmutable: true })
  atomicWriteRegistered(record, RUNTIME_PATHS.metadataDigest, `${crypto.createHash('sha256').update(metadataBytes).digest('hex')}\n`, { initializeImmutable: true })
  if (options.settings !== undefined) atomicWriteRegistered(record, 'settings.json', `${JSON.stringify(options.settings, null, 2)}\n`)
  if (options.requestTurns !== undefined || options.request !== undefined) {
    const turns = options.requestTurns !== undefined ? options.requestTurns : options.request
    record.initializeRequest(Array.isArray(turns) ? turns : [turns], options.requestOptions || {})
  }
  if (options.initializeTranscript === true) record.initializeRouteTranscript(options.transcriptOptions || {})
  auditRunRecordTree(record, { permissions: false })
  if (options.assertStartBoundary !== false) record.assertBoundary({ phase: 'start', runNpmPack: options.runNpmPackBoundary !== false })
  return record
}

function openRunRecord(runPath, options = {}) {
  const absolute = path.resolve(runPath)
  // Permission/ACL validation precedes reading immutable metadata so a widened
  // record is never treated as reopened runtime authority.
  auditPrivatePermissions(absolute)
  const prospectiveRoot = path.dirname(path.dirname(absolute))
  auditPrivatePermissions(prospectiveRoot, { recurse: false, additionalPaths: [path.join(prospectiveRoot, '.autoprompt-owner.json')] })
  const metadataPath = path.join(absolute, RUNTIME_PATHS.metadata)
  let metadata
  try {
    const bytes = readFileNoFollow(metadataPath)
    if (bytes === null) throw Object.assign(new Error('metadata missing'), { code: 'ENOENT' })
    const savedDigestBytes = readFileNoFollow(path.join(absolute, RUNTIME_PATHS.metadataDigest))
    if (savedDigestBytes === null || savedDigestBytes.toString('utf8').trim() !== crypto.createHash('sha256').update(bytes).digest('hex')) {
      throw Object.assign(new Error('metadata digest mismatch'), { code: 'RUN_RECORD_FAILURE' })
    }
    metadata = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error instanceof RunRecordError) throw error
    throw new RunRecordError('RUN_RECORD_FAILURE', `Cannot load immutable run metadata: ${metadataPath}`, { cause: error.code || error.message })
  }
  if (metadata.schema !== RUN_RECORD_SCHEMA) throw new RunRecordError('CONTRACT_UPGRADE_REQUIRED', `Unsupported run-record schema: ${metadata.schema}`)
  if (path.resolve(metadata.run_path) !== absolute || path.resolve(metadata.root_path) !== prospectiveRoot || !pathIsInside(metadata.root_path, absolute)) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', 'Saved paths do not match opened run directory')
  }
  verifyRootOwnership(metadata.root_path, metadata.root_kind, metadata.provider_id, metadata.target_identity)
  const record = facade({
    runId: metadata.run_id, rootKind: metadata.root_kind, providerId: metadata.provider_id, rootPath: metadata.root_path,
    runPath: metadata.run_path, targetPath: metadata.target_path, targetIdentity: metadata.target_identity,
    targetIdentitySha256: metadata.target_identity_sha256, rootBinding: metadata.root_binding, runBinding: metadata.run_binding,
    projectRejection: metadata.project_rejection,
  })
  auditRunRecordTree(record, { ...options, permissions: false })
  return record
}

module.exports = {
  RUN_RECORD_SCHEMA, PLAN_PATHS, RUNTIME_PATHS, RUN_DIRECTORIES, EXACT_REGISTERED_PATHS, REGISTERED_PREFIXES,
  PRE_MUTATION_BASELINE_PATH, ALL_WORK_JOINED_PATH, ROUTE_RECOMMENDATION_STATE_PATH,
  CODEX_PHYSICAL_EXECUTION_PATH,
  normalizeRelativePath, isRegisteredRunPath, resolveRegisteredPath, canonicalPlanPath, runtimeIntegrationPaths,
  createRunRecord, allocateRunRecord: createRunRecord, openRunRecord, assertRunRecordBinding,
  auditRunRecordTree, atomicWriteRegistered,
  aliasEntryHash, appendAliasTelemetry, readAliasTelemetry, recoverAliasTelemetry, validateAliasTelemetryRecord,
  createPreMutationBaseline, createProductionPreMutationBaseline,
  validatePreMutationBaseline, writePreMutationBaseline, readPreMutationBaseline,
  createAllWorkJoinedReceipt, validateAllWorkJoinedReceipt,
  writeAllWorkJoinedReceipt, readAllWorkJoinedReceipt,
  writeRouteAnalystFallbackState, readRouteAnalystFallbackState,
  assertRunRecordLocalOnly: (record, options = {}) => record.assertBoundary({ ...options, phase: options.phase || 'completion' }),
}
