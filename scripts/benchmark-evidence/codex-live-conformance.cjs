#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ProcessOwner,
  createPosixProcessAdapter,
  createWindowsJobAdapter,
  prepareProcessLaunchEnvironment,
} = require('../../agents/codex/workflow/process-owner.js')
const { relativeConfigPath } = require('../../agents/codex/workflow/codex-agent-profile.js')

const {
  codexProviderAdmissionProjection,
  codexProviderAdmissionSha256,
  deriveCodexRuntimeIdentity,
  providerContractCoreSha256,
  stableJsonV1,
} = require('../codex-runtime-identity.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const EVIDENCE_SCHEMA = 'codex-live-conformance-evidence.v1'
const OBSERVATION_SCHEMA = 'codex-live-conformance-observation.v1'
const DRY_RUN_SCHEMA = 'codex-live-conformance-plan.v1'
const DEFAULT_TIMEOUT_MS = 240_000
const MAX_TIMEOUT_MS = 300_000
// The provider proof intentionally exercises four bounded model turns (root, worker, same-child
// resume, independent checker). This is an external conformance ceiling, not an Autoprompt task
// budget; current Codex accounting charges the repeated tool-turn context to each turn.
const MAX_TOTAL_TOKENS = 500_000
const SUPPORTED_PROVIDER_SESSION_VERSIONS = new Set(['0.149.0', '0.149.1'])
const EXTERNAL_HELPER_TIMEOUT_MS = 10_000
const CHILD_KILL_VERIFY_MS = 250
const CHILD_SETTLEMENT_TIMEOUT_MS = 5_000
const HASH_PATTERN = /^[a-f0-9]{64}$/
const FROZEN_PROVIDER_ADMISSION_SHA256 = '70921cc6f09b742f31766a915d8a9ea30aaa267576e276b6e6081e6db74dd222'
const FROZEN_PROVIDER_CONTRACT_CORE_SHA256 = '5750d35c00d98503e6dbb11459ab4c1baba22ccf5dd56da41e3cdda14fca3745'
const CHECKER_HASH_COMMAND = 'node conformance-sha256.cjs conformance-result.txt'
const DISCOVERY_COMMAND = 'node conformance-discovery-probe.cjs isolated-during'
const DISCOVERY_RED_COMMAND = `${DISCOVERY_COMMAND} && node conformance-check.cjs`
const WORKER_ABSENCE_PROBE_COMMAND = 'xxd -g 1 conformance-result.txt 2>/dev/null || true'
const WORKER_MISSING_PROBE_COMMAND = 'if [ -e conformance-result.txt ]; then ' +
  'wc -c conformance-result.txt; else echo MISSING; fi'
const SOURCE_ROOTS = Object.freeze([
  'agents',
  'assets',
  'packages/codex',
  'scripts',
  'package.json',
])
const COPY_EXCLUSIONS = new Set([
  '.git', '.autoprompt-private', 'evidence', 'node_modules', 'dist',
])
const REGISTRY_ENVIRONMENT_KEYS = Object.freeze([
  'AUTOPROMPT_CODEX_PACKAGE_REGISTRY',
  'AUTOPROMPT_MODEL_REGISTRY',
  'AUTOPROMPT_PACKAGE_REGISTRY',
])
const CAPABILITY_REQUIRED_LOGICAL_ROLES = Object.freeze({
  cancellation: Object.freeze(['ap-diagnostic-probe']),
  isolatedChecking: Object.freeze(['ap-independent-checker']),
  privateSkillRoot: Object.freeze(['ap-independent-checker', 'ap-worker']),
  sameContextContinuation: Object.freeze(['ap-worker']),
  stableChildIdentity: Object.freeze(['ap-worker']),
})

class LiveConformanceError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LiveConformanceError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new LiveConformanceError(code, message, details)
}

function deriveMissionRequirements(capabilities = {}) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    fail('PROVIDER_CAPABILITIES_INVALID', 'Codex provider capabilities are unavailable')
  }
  const claimedCapabilities = Object.entries(capabilities)
    .filter(([, status]) => status === 'supported').map(([name]) => name).sort()
  const requiredLogicalRoles = [...new Set([
    'ap-independent-checker',
    'ap-worker',
    ...claimedCapabilities.flatMap(capability =>
      CAPABILITY_REQUIRED_LOGICAL_ROLES[capability] || []),
  ])].sort()
  return Object.freeze({
    cancellationRequired: claimedCapabilities.includes('cancellation'),
    claimedCapabilities: Object.freeze(claimedCapabilities),
    requiredLogicalRoles: Object.freeze(requiredLogicalRoles),
  })
}

function resolveRequiredProviderRoles(manifest, requirements) {
  const requiredLogicalRoles = requirements?.requiredLogicalRoles
  if (!Array.isArray(requiredLogicalRoles) ||
      requiredLogicalRoles.some(role => typeof role !== 'string' || !role)) {
    fail('MISSION_REQUIREMENTS_INVALID', 'required Codex mission roles are unavailable')
  }
  const logicalInventory = Array.isArray(manifest?.logicalRoles) ? manifest.logicalRoles : []
  const physicalInventory = Array.isArray(manifest?.physicalRoles) ? manifest.physicalRoles : []
  const mapping = manifest?.logicalToPhysicalProviderRole
  const resolved = {}
  for (const logicalRole of requiredLogicalRoles) {
    const physicalRole = mapping && typeof mapping === 'object' && !Array.isArray(mapping)
      ? mapping[logicalRole] : null
    if (!logicalInventory.includes(logicalRole) || typeof physicalRole !== 'string' ||
        !physicalRole.trim() || !physicalInventory.includes(physicalRole)) {
      fail('REQUIRED_PROVIDER_ROLE_MISSING',
        `required Codex mission role ${logicalRole} is absent from the canonical manifest`, {
          logicalRole,
        })
    }
    if (Object.values(resolved).includes(physicalRole)) {
      fail('REQUIRED_PROVIDER_ROLE_INVALID',
        `required Codex mission role ${logicalRole} does not have a unique provider role`, {
          logicalRole,
        })
    }
    resolved[logicalRole] = physicalRole
  }
  return Object.freeze(resolved)
}

function scoreCapabilityProofs(details = {}) {
  const residualPids = Array.isArray(details.residualPids) ? details.residualPids : []
  const cancellationClaimed = details.providerCapabilities?.cancellation === 'supported'
  return Object.freeze({
    cancellation: cancellationClaimed
      ? details.cancellationObserved === true && residualPids.length === 0 &&
        details.timedOut !== true ? 'PASS' : 'FAIL'
      : 'NO_RESULT',
    isolation: details.isolationResult === 'PASS' ? 'PASS' : 'FAIL',
    privateSkillRoot: details.privateSkillRootResult,
    topologyEnforcement: details.topologyEnforcementResult,
    processOwnership: details.ownershipResult === 'PASS' && residualPids.length === 0 &&
      details.timedOut !== true ? 'PASS' : 'FAIL',
  })
}

function sha256(value) {
  return crypto.createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'))
    .digest('hex')
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)) }

function base64urlSha256(value) {
  return crypto.createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'))
    .digest('base64url')
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`))
}

function assertWithin(root, candidate, label) {
  if (!isWithin(root, candidate)) fail('TEMP_PATH_ESCAPE', `${label} escapes the isolated run root`)
  return path.resolve(candidate)
}

function safePathReceipt(relative, category = destinationCategory(relative)) {
  const normalized = String(relative).replaceAll('\\', '/')
  return Object.freeze({
    category,
    pathLength: normalized.length,
    pathSha256: sha256(normalized),
  })
}

function filesystemFailure(code, message, receipt, error = null) {
  fail(code, message, {
    causeCode: typeof error?.code === 'string' ? error.code : null,
    pathReceipt: receipt,
  })
}

function assertRegularUnlinked(file, label, options = {}) {
  const fsImpl = options.fsImpl || fs
  const receipt = options.pathReceipt || safePathReceipt(label)
  let stats
  try { stats = fsImpl.lstatSync(file) } catch (error) {
    filesystemFailure('CONFORMANCE_INPUT_MISSING', `${label} is unavailable`, receipt, error)
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    fail('CONFORMANCE_INPUT_UNSAFE', `${label} is linked or not a regular file`, {
      pathReceipt: receipt,
    })
  }
  try {
    const realpath = fsImpl.realpathSync?.native || fsImpl.realpathSync
    return realpath(file)
  } catch (error) {
    filesystemFailure('CONFORMANCE_INPUT_UNAVAILABLE', `${label} cannot be resolved safely`,
      receipt, error)
  }
}

function parseArguments(argv) {
  const options = { mode: 'dry-run', fakeCli: null, auth: null, timeoutMs: DEFAULT_TIMEOUT_MS }
  let selectedMode = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (/registry/i.test(argument)) {
      fail('REGISTRY_OVERRIDE_FORBIDDEN', 'registry overrides are forbidden in live conformance')
    }
    if (argument === '--dry-run' || argument === '--live') {
      if (selectedMode) fail('CONFORMANCE_ARGUMENT_INVALID', 'choose exactly one conformance mode')
      options.mode = argument.slice(2)
      selectedMode = true
      continue
    }
    if (argument === '--fake-cli') {
      if (selectedMode) fail('CONFORMANCE_ARGUMENT_INVALID', 'choose exactly one conformance mode')
      const value = argv[++index]
      if (!value) fail('CONFORMANCE_ARGUMENT_INVALID', '--fake-cli requires a path')
      options.mode = 'fake-cli'
      options.fakeCli = path.resolve(value)
      selectedMode = true
      continue
    }
    if (argument === '--auth' || argument === '--timeout-ms') {
      const value = argv[++index]
      if (!value) fail('CONFORMANCE_ARGUMENT_INVALID', `${argument} requires a value`)
      if (argument === '--auth') options.auth = path.resolve(value)
      else options.timeoutMs = Number(value)
      continue
    }
    fail('CONFORMANCE_ARGUMENT_INVALID', `unknown argument: ${argument}`)
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 ||
      options.timeoutMs > MAX_TIMEOUT_MS) {
    fail('CONFORMANCE_ARGUMENT_INVALID', `timeout must be 1000..${MAX_TIMEOUT_MS} ms`)
  }
  if (options.mode !== 'live' && options.auth) {
    fail('CONFORMANCE_ARGUMENT_INVALID', '--auth is accepted only for a live run')
  }
  return Object.freeze(options)
}

function rejectRegistryOverrides(environment = process.env) {
  const present = REGISTRY_ENVIRONMENT_KEYS.filter(key =>
    typeof environment[key] === 'string' && environment[key].trim() !== '')
  if (present.length) {
    fail('REGISTRY_OVERRIDE_FORBIDDEN', 'registry overrides are forbidden in live conformance', {
      names: present,
    })
  }
}

function isolatedLayout(base = os.tmpdir()) {
  const runRoot = fs.mkdtempSync(path.join(path.resolve(base), 'autoprompt-codex-conformance-'))
  const layout = {
    runRoot,
    source: path.join(runRoot, 'source'),
    artifact: path.join(runRoot, 'artifact'),
    codexHome: path.join(runRoot, 'codex-home'),
    activationHome: path.join(runRoot, 'activation-home'),
    target: path.join(runRoot, 'target'),
    evidence: path.join(runRoot, 'evidence'),
  }
  for (const [label, directory] of Object.entries(layout)) {
    if (label === 'runRoot') continue
    assertWithin(runRoot, directory, label)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  return Object.freeze(layout)
}

function copyTree(source, destination, relative = '') {
  const stats = fs.lstatSync(source)
  if (stats.isSymbolicLink()) fail('SOURCE_TREE_UNSAFE', `source tree contains a link: ${relative}`)
  if (stats.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    return
  }
  if (!stats.isDirectory()) fail('SOURCE_TREE_UNSAFE', `source tree contains a special file: ${relative}`)
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name
    if (COPY_EXCLUSIONS.has(entry.name) || entry.name.startsWith('.tmp-')) continue
    copyTree(path.join(source, entry.name), path.join(destination, entry.name), childRelative)
  }
}

function copyFrozenSource(sourceRoot, destination) {
  const root = path.resolve(sourceRoot)
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const relative of SOURCE_ROOTS) {
    const source = path.join(root, ...relative.split('/'))
    if (!fs.existsSync(source)) fail('SOURCE_TREE_INCOMPLETE', `source input is missing: ${relative}`)
    copyTree(source, path.join(destination, ...relative.split('/')), relative)
  }
  return destination
}

function commandSummary(result) {
  return Object.freeze({
    argv: result.argv,
    durationMs: result.durationMs,
    descendantPidsObserved: result.descendantPidsObserved || [],
    exitCode: result.exitCode,
    policyTerminated: result.policyTerminated === true,
    signal: result.signal,
    stderrBytes: result.stderr.length,
    stderrSha256: sha256(result.stderr),
    stdoutBytes: result.stdout.length,
    stdoutSha256: sha256(result.stdout),
    timedOut: result.timedOut,
  })
}

function helperFailureDetails(result, timeoutMs) {
  return Object.freeze({
    causeCode: typeof result?.error?.code === 'string' ? result.error.code : null,
    signal: result?.signal || null,
    status: Number.isInteger(result?.status) ? result.status : null,
    timedOut: result?.error?.code === 'ETIMEDOUT',
    timeoutMs,
  })
}

function externalHelperTimeout(options = {}) {
  const timeoutMs = options.helperTimeoutMs ?? EXTERNAL_HELPER_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail('EXTERNAL_HELPER_TIMEOUT_INVALID', 'external helper timeout must be a positive integer')
  }
  return timeoutMs
}

function killProcessTree(child, options = {}) {
  if (!child || !Number.isInteger(child.pid)) return false
  const platform = options.platform || process.platform
  const timeoutMs = externalHelperTimeout(options)
  if (platform === 'win32') {
    const spawnSyncImpl = options.spawnSyncImpl || childProcess.spawnSync
    let result
    try {
      result = spawnSyncImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', shell: false, timeout: timeoutMs,
      })
    } catch (error) { result = { error, signal: null, status: null } }
    if (!result || result.error || result.signal || result.status !== 0) {
      fail('PROCESS_TREE_KILL_FAILED', 'bounded taskkill failed to terminate the child tree', {
        pid: child.pid,
        ...helperFailureDetails(result, timeoutMs),
      })
    }
  } else {
    const killImpl = options.killImpl || process.kill.bind(process)
    try { killImpl(-child.pid, 'SIGKILL') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  return true
}

function pidExists(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const killImpl = options.killImpl || process.kill.bind(process)
  try { killImpl(pid, 0); return true } catch { return false }
}

function processTable(options = {}) {
  let result
  const platform = options.platform || process.platform
  const spawnSyncImpl = options.spawnSyncImpl || childProcess.spawnSync
  const timeoutMs = externalHelperTimeout(options)
  if (platform === 'win32') {
    try {
      result = spawnSyncImpl('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
      ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs })
    } catch (error) { result = { error, signal: null, status: null } }
    if (!result || result.error || result.signal || result.status !== 0) {
      fail('PROCESS_AUDIT_UNAVAILABLE', 'Windows descendant process enumeration failed',
        helperFailureDetails(result, timeoutMs))
    }
    try {
      const parsed = JSON.parse(result.stdout || '[]')
      return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
        pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId),
      }))
    } catch {
      fail('PROCESS_AUDIT_UNAVAILABLE', 'Windows descendant process enumeration was not valid JSON')
    }
  }
  try {
    result = spawnSyncImpl('ps', ['-e', '-o', 'pid=,ppid='], {
      encoding: 'utf8', shell: false, timeout: timeoutMs,
    })
  } catch (error) { result = { error, signal: null, status: null } }
  if (!result || result.error || result.signal || result.status !== 0) {
    fail('PROCESS_AUDIT_UNAVAILABLE', 'descendant process enumeration failed',
      helperFailureDetails(result, timeoutMs))
  }
  const rows = String(result.stdout || '').split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parentPid]) => Number.isInteger(pid) && Number.isInteger(parentPid))
    .map(([pid, parentPid]) => ({ pid, parentPid }))
  if (rows.length === 0) fail('PROCESS_AUDIT_UNAVAILABLE', 'descendant process enumeration was empty')
  return rows
}

function descendantPids(rootPid, options = {}) {
  const table = processTable(options)
  const descendants = new Set()
  let frontier = [rootPid]
  while (frontier.length) {
    const parents = new Set(frontier)
    frontier = table.filter(row => parents.has(row.parentPid) && !descendants.has(row.pid))
      .map(row => { descendants.add(row.pid); return row.pid })
  }
  return [...descendants].sort((left, right) => left - right)
}

function runBoundedCommand(command, options = {}) {
  if (!Array.isArray(command) || command.length === 0 ||
      command.some(value => typeof value !== 'string' || value.length === 0)) {
    fail('CONFORMANCE_COMMAND_INVALID', 'command must be a non-empty argv array')
  }
  const started = Date.now()
  return new Promise((resolve, reject) => {
    let child
    try {
      const spawnImpl = options.spawnImpl || childProcess.spawn
      child = spawnImpl(command[0], command.slice(1), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    const stdout = []
    const stderr = []
    let timedOut = false
    let killAttempted = false
    let policyTerminated = false
    let lineBuffer = ''
    const observedDescendants = new Set()
    let processAuditError = null
    let policyAuditError = null
    let primaryKillError = null
    let escalationAttempted = false
    let verificationCompleted = false
    let settlementStarted = false
    let settled = false
    let descendantTimer = null
    let deadlineTimer = null
    let verificationTimer = null
    let settlementTimer = null
    const helperOptions = {
      helperTimeoutMs: options.helperTimeoutMs,
      killImpl: options.killImpl,
      platform: options.platform,
      spawnSyncImpl: options.spawnSyncImpl,
    }
    const pidExistsImpl = options.pidExistsImpl || (pid => pidExists(pid, helperOptions))
    const descendantPidsImpl = options.descendantPidsImpl ||
      (pid => descendantPids(pid, helperOptions))
    const killTreeImpl = options.killProcessTreeImpl ||
      (target => killProcessTree(target, helperOptions))
    const killPidImpl = options.killPidImpl || ((pid, signal) => process.kill(pid, signal))
    const knownPids = () => [...new Set([child.pid, ...observedDescendants])]
      .filter(pid => Number.isInteger(pid) && pid > 0)
      .sort((left, right) => left - right)
    const activePids = () => knownPids().filter(pid => {
      try { return pidExistsImpl(pid) } catch (error) {
        processAuditError ||= error
        return true
      }
    })
    const stopRuntimeTimers = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      if (descendantTimer) clearInterval(descendantTimer)
      deadlineTimer = null
      descendantTimer = null
    }
    const cleanupTimers = () => {
      stopRuntimeTimers()
      if (verificationTimer) clearTimeout(verificationTimer)
      if (settlementTimer) clearTimeout(settlementTimer)
      verificationTimer = null
      settlementTimer = null
    }
    const finishReject = error => {
      if (settled) return
      settled = true
      cleanupTimers()
      reject(error)
    }
    const attemptDirectHardKill = pids => {
      escalationAttempted = true
      for (const pid of [...new Set(pids)].sort((left, right) => left - right)) {
        try { killPidImpl(pid, 'SIGKILL') } catch (error) {
          if (error?.code !== 'ESRCH') primaryKillError ||= error
        }
      }
    }
    const verifyAndEscalate = () => {
      if (verificationCompleted || settled) return activePids()
      verificationCompleted = true
      const residualPids = activePids()
      if (residualPids.length) attemptDirectHardKill(residualPids)
      return activePids()
    }
    const beginTermination = reason => {
      if (settlementStarted || settled) return
      settlementStarted = true
      killAttempted = true
      stopRuntimeTimers()
      try { killTreeImpl(child) } catch (error) { primaryKillError = error }
      if (settled) return
      verificationTimer = setTimeout(() => {
        try { verifyAndEscalate() } catch (error) { processAuditError ||= error }
      }, options.killVerifyMs ?? CHILD_KILL_VERIFY_MS)
      settlementTimer = setTimeout(() => {
        let residualPids = knownPids()
        try {
          if (!verificationCompleted) verifyAndEscalate()
          if (settled) return
          residualPids = activePids()
        } catch (error) { processAuditError ||= error }
        finishReject(new LiveConformanceError('COMMAND_SETTLEMENT_TIMEOUT',
          'child did not emit close within the bounded cleanup window', {
            childPid: child.pid,
            escalationAttempted,
            primaryKillError: primaryKillError ? {
              code: primaryKillError.code || null,
              details: primaryKillError.details || null,
              message: primaryKillError.message,
            } : null,
            residualPids,
            terminationReason: reason,
          }))
      }, options.settlementTimeoutMs ?? CHILD_SETTLEMENT_TIMEOUT_MS)
    }
    const enforcePolledPolicy = () => {
      if (settlementStarted || settled || policyTerminated ||
          typeof options.policyPollGuard !== 'function') return
      try {
        if (options.policyPollGuard() !== false) return
        policyTerminated = true
        beginTermination('policy-ceiling')
      } catch (error) {
        policyAuditError = error
        beginTermination('policy-audit-error')
      }
    }
    const sampleDescendants = ({ terminateOnError = true, enforcePolicy = true } = {}) => {
      if (settled || processAuditError) return
      try {
        for (const pid of descendantPidsImpl(child.pid)) observedDescendants.add(pid)
      } catch (error) {
        processAuditError = error
        if (terminateOnError) beginTermination('process-audit-error')
      }
      if (enforcePolicy) enforcePolledPolicy()
    }
    sampleDescendants()
    if (!settlementStarted && !settled) {
      descendantTimer = setInterval(sampleDescendants, options.processPollMs || 250)
    }
    child.stdout.on('data', chunk => {
      const bytes = Buffer.from(chunk)
      stdout.push(bytes)
      if (typeof options.stdoutLineGuard !== 'function' || policyTerminated) return
      lineBuffer += bytes.toString('utf8')
      const lines = lineBuffer.split(/\r?\n/)
      lineBuffer = lines.pop()
      for (const line of lines) {
        if (!line || options.stdoutLineGuard(line) !== false) continue
        policyTerminated = true
        beginTermination('stdout-policy-ceiling')
        break
      }
    })
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    if (!settlementStarted && !settled) {
      deadlineTimer = setTimeout(() => {
        timedOut = true
        beginTermination('deadline')
      }, options.timeoutMs || DEFAULT_TIMEOUT_MS)
    }
    child.once('error', error => {
      finishReject(error)
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      cleanupTimers()
      sampleDescendants({ terminateOnError: false, enforcePolicy: false })
      for (const pid of observedDescendants) {
        let active = true
        try { active = pidExistsImpl(pid) } catch (error) { processAuditError ||= error }
        if (!active) continue
        try { killPidImpl(pid, 'SIGKILL') } catch (error) {
          if (error?.code !== 'ESRCH') primaryKillError ||= error
        }
      }
      const residualPids = activePids()
      if (processAuditError || policyAuditError) {
        finishReject(processAuditError || policyAuditError)
        return
      }
      const result = {
        argv: [...command],
        childPid: child.pid,
        durationMs: Date.now() - started,
        exitCode,
        killAttempted,
        policyTerminated,
        descendantPidsObserved: [...observedDescendants].sort((left, right) => left - right),
        residualPids,
        signal,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
        timedOut,
        termination: Object.freeze({
          escalationAttempted,
          primaryKillFailed: primaryKillError !== null,
        }),
      }
      settled = true
      resolve(result)
    })
  })
}

async function runWindowsJobCommand(command, options = {}) {
  if (process.platform !== 'win32') {
    fail('PROCESS_OWNERSHIP_UNAVAILABLE', 'live Codex conformance requires a Windows Job Object')
  }
  const started = Date.now()
  const privateRoot = path.join(options.layout.activationHome, '.autoprompt-private')
  fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
  ensureWindowsPrivateAcl(privateRoot)
  const controlRoot = path.join(privateRoot, 'conformance-process-control')
  const registryPath = path.join(privateRoot, 'conformance-process-registry.json')
  const launcherPath = path.join(options.layout.evidence, 'owned-codex-launcher.cjs')
  const requestPath = path.join(options.layout.evidence, 'owned-codex-request.json')
  const stdoutPath = path.join(options.layout.evidence, 'owned-codex.stdout')
  const stderrPath = path.join(options.layout.evidence, 'owned-codex.stderr')
  const terminalPath = path.join(options.layout.evidence, 'owned-codex-terminal.json')
  writePrivateFile(launcherPath, [
    "'use strict'",
    "const cp=require('node:child_process'),fs=require('node:fs')",
    'const request=JSON.parse(fs.readFileSync(process.argv[2],\'utf8\'))',
    "const stdout=fs.openSync(request.stdoutPath,'wx',0o600),stderr=fs.openSync(request.stderrPath,'wx',0o600)",
    "const child=cp.spawn(request.executable,request.argv,{cwd:request.cwd,env:process.env,shell:false,windowsHide:true,stdio:['ignore',stdout,stderr]})",
    "child.once('error',error=>{fs.closeSync(stdout);fs.closeSync(stderr);fs.writeFileSync(request.terminalPath,JSON.stringify({childPid:child.pid||null,exitCode:null,signal:null,error:error.message}))})",
    "child.once('close',(exitCode,signal)=>{fs.closeSync(stdout);fs.closeSync(stderr);fs.writeFileSync(request.terminalPath,JSON.stringify({childPid:child.pid,exitCode,signal,error:null}))})",
    '',
  ].join('\n'), 0o700)
  writePrivateFile(requestPath, stableJsonV1({
    executable: command[0], argv: command.slice(1), cwd: options.cwd,
    stdoutPath, stderrPath, terminalPath,
  }))
  const adapter = createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: privateRoot })
  const reservationId = `codex-live-${crypto.randomUUID()}`
  const environment = prepareProcessLaunchEnvironment(adapter, reservationId, options.env || {})
  const owner = new ProcessOwner({
    adapter, registryPath, pollMs: 20,
    controlBinding: { activationId: `live-conformance:${sha256(options.layout.runRoot)}`, generationId: 1 },
  })
  const launched = await owner.launch({
    executable: process.execPath,
    argv: [launcherPath, requestPath],
    env: environment,
    reservationId,
    targetKey: `live-conformance:${sha256(options.layout.target)}`,
  })
  if (typeof options.onLaunchedPid === 'function') options.onLaunchedPid(launched.rootPid)
  let drained = false
  try {
  const membershipSamples = []
  const observedOwnedPids = new Set()
  const sampleOwnedMembership = async () => {
    const members = [...await adapter.listOwned(launched.groupIdentity)].sort((left, right) => left - right)
    members.forEach(pid => observedOwnedPids.add(pid))
    if (!membershipSamples.length ||
        stableJsonV1(membershipSamples.at(-1).members) !== stableJsonV1(members)) {
      membershipSamples.push(Object.freeze({ offsetMs: Date.now() - started, members }))
    }
    return members
  }
  const initialMembership = await sampleOwnedMembership()
  let policyTerminated = false
  let killAttempted = false
  let outputOffset = 0
  let lineBuffer = ''
  let timedOut = false
  const deadline = started + (options.timeoutMs || DEFAULT_TIMEOUT_MS)
  let terminal = null
  while (Date.now() <= deadline) {
    await sampleOwnedMembership()
    if (fs.existsSync(stdoutPath)) {
      const current = fs.readFileSync(stdoutPath)
      const fresh = current.subarray(outputOffset)
      outputOffset = current.length
      lineBuffer += fresh.toString('utf8')
      const lines = lineBuffer.split(/\r?\n/)
      lineBuffer = lines.pop()
      for (const line of lines) {
        if (!line || typeof options.stdoutLineGuard !== 'function' || options.stdoutLineGuard(line) !== false) continue
        policyTerminated = true
      }
    }
    if (!policyTerminated && typeof options.policyPollGuard === 'function' &&
        options.policyPollGuard() === false) policyTerminated = true
    if (policyTerminated) {
      killAttempted = true
      await owner.cancelGroup(launched.ownershipId, {
        reason: 'live conformance policy ceiling', graceMs: 0, killMs: 5_000,
      })
      break
    }
    if (fs.existsSync(terminalPath)) {
      terminal = JSON.parse(fs.readFileSync(terminalPath, 'utf8'))
      if (Number.isSafeInteger(terminal.childPid) && typeof options.onLaunchedPid === 'function') {
        options.onLaunchedPid(terminal.childPid)
      }
      break
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (!terminal && !policyTerminated) {
    timedOut = true
    killAttempted = true
    await owner.cancelGroup(launched.ownershipId, {
      reason: 'live conformance deadline', graceMs: 0, killMs: 5_000,
    })
  } else if (terminal && !policyTerminated) {
    while (pidExists(launched.rootPid) && Date.now() <= deadline + 5_000) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await owner.observeRootExit(launched.ownershipId, {
      code: terminal.exitCode, signal: terminal.signal, killMs: 5_000,
    })
  }
  await owner.assertDrained()
  drained = true
  const membership = await adapter.listOwned(launched.groupIdentity)
  const statusFiles = listFiles(controlRoot).filter(file => file.endsWith('/status.json') || file === 'status.json')
  if (statusFiles.length !== 1) {
    fail('PROCESS_OWNERSHIP_EVIDENCE_INVALID', 'Windows Job produced no unique terminal status record')
  }
  const statusBytes = fs.readFileSync(path.join(controlRoot, ...statusFiles[0].split('/')))
  const status = JSON.parse(statusBytes.toString('utf8'))
  const helperExitDeadline = Date.now() + 5_000
  while (Number.isSafeInteger(status.helperPid) && pidExists(status.helperPid) &&
      Date.now() <= helperExitDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const helperResidualPids = Number.isSafeInteger(status.helperPid) && pidExists(status.helperPid)
    ? [status.helperPid] : []
  const ownershipPassed = status.assigned === true && status.ready === true &&
    status.status === 'EXITED' && Array.isArray(status.pids) && status.pids.length === 0 &&
    membership.length === 0 && initialMembership.includes(launched.rootPid) &&
    Number.isSafeInteger(terminal?.childPid) && observedOwnedPids.has(terminal.childPid) &&
    helperResidualPids.length === 0
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath) : Buffer.alloc(0)
  const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath) : Buffer.alloc(0)
  return {
    argv: [...command],
    childPid: terminal?.childPid || launched.rootPid,
    durationMs: Date.now() - started,
    exitCode: terminal?.exitCode ?? null,
    killAttempted,
    policyTerminated,
    descendantPidsObserved: status.observedPids || [],
    residualPids: [...membership, ...helperResidualPids],
    signal: terminal?.signal || null,
    stderr,
    stdout,
    timedOut,
    ownership: Object.freeze({
      result: ownershipPassed ? 'PASS' : 'FAIL',
      adapterKind: 'windows-job-object',
      assignedBeforeResume: status.assigned === true && status.ready === true,
      groupIdentity: launched.groupIdentity,
      helperPid: status.helperPid || null,
      helperExited: helperResidualPids.length === 0,
      helperResidualPids,
      jobStatusBase64: statusBytes.toString('base64'),
      jobStatusSha256: sha256(statusBytes),
      observedPids: status.observedPids || [],
      observedOwnedPids: [...observedOwnedPids].sort((left, right) => left - right),
      membershipSamples,
      paidCodexPid: terminal?.childPid || null,
      paidCodexObservedAsJobMember: Number.isSafeInteger(terminal?.childPid) &&
        observedOwnedPids.has(terminal.childPid),
      processOwnerSourceSha256: sha256(fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'agents', 'codex', 'workflow', 'process-owner.js'),
      )),
      terminalMembership: membership,
      zeroMembershipDrained: membership.length === 0 && status.pids.length === 0,
    }),
  }
  } finally {
    if (!drained) {
      try {
        await owner.cancelGroup(launched.ownershipId, {
          reason: 'live conformance exceptional cleanup', graceMs: 0, killMs: 5_000,
        })
      } finally {
        await owner.assertDrained()
      }
    }
  }
}

async function runPosixGroupCommand(command, options = {}) {
  if (process.platform === 'win32') {
    fail('PROCESS_OWNERSHIP_UNAVAILABLE', 'POSIX process groups are unavailable on Windows')
  }
  const started = Date.now()
  const privateRoot = path.join(options.layout.activationHome, '.autoprompt-private')
  fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
  const registryPath = path.join(privateRoot, 'conformance-process-registry.json')
  let child = null
  const adapter = createPosixProcessAdapter({
    spawn(executable, argv, spawnOptions) {
      child = childProcess.spawn(executable, argv, spawnOptions)
      return child
    },
  })
  const reservationId = `codex-live-${crypto.randomUUID()}`
  const environment = prepareProcessLaunchEnvironment(adapter, reservationId, options.env || {})
  const owner = new ProcessOwner({
    adapter,
    registryPath,
    pollMs: 20,
    controlBinding: {
      activationId: `live-conformance:${sha256(options.layout.runRoot)}`,
      generationId: 1,
    },
  })
  const launched = await owner.launch({
    executable: command[0],
    argv: command.slice(1),
    cwd: options.cwd,
    env: environment,
    reservationId,
    targetKey: `live-conformance:${sha256(options.layout.target)}`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (!child || !child.stdout || !child.stderr) {
    fail('PROCESS_OWNERSHIP_EVIDENCE_INVALID', 'POSIX owned launch did not expose captured streams')
  }
  if (typeof options.onLaunchedPid === 'function') options.onLaunchedPid(launched.rootPid)
  const stdout = []
  const stderr = []
  let lineBuffer = ''
  let policyTerminated = false
  let timedOut = false
  let killAttempted = false
  let terminal = null
  const observedOwnedPids = new Set()
  const membershipSamples = []
  const sampleOwnedMembership = async () => {
    const members = [...await adapter.listOwned(launched.groupIdentity)]
      .sort((left, right) => left - right)
    members.forEach(pid => observedOwnedPids.add(pid))
    if (!membershipSamples.length ||
        stableJsonV1(membershipSamples.at(-1).members) !== stableJsonV1(members)) {
      membershipSamples.push(Object.freeze({ offsetMs: Date.now() - started, members }))
    }
    return members
  }
  child.stdout.on('data', chunk => {
    const bytes = Buffer.from(chunk)
    stdout.push(bytes)
    if (typeof options.stdoutLineGuard !== 'function' || policyTerminated) return
    lineBuffer += bytes.toString('utf8')
    const lines = lineBuffer.split(/\r?\n/)
    lineBuffer = lines.pop()
    for (const line of lines) {
      if (!line || options.stdoutLineGuard(line) !== false) continue
      policyTerminated = true
      break
    }
  })
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  const closePromise = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      terminal = { exitCode, signal }
      resolve(terminal)
    })
  })
  let drained = false
  try {
    const initialMembership = await sampleOwnedMembership()
    const deadline = started + (options.timeoutMs || DEFAULT_TIMEOUT_MS)
    while (!terminal && Date.now() <= deadline) {
      await sampleOwnedMembership()
      if (!policyTerminated && typeof options.policyPollGuard === 'function' &&
          options.policyPollGuard() === false) policyTerminated = true
      if (policyTerminated) break
      await Promise.race([
        closePromise,
        new Promise(resolve => setTimeout(resolve, options.processPollMs || 25)),
      ])
    }
    if (!terminal) {
      timedOut = !policyTerminated
      killAttempted = true
      await owner.cancelGroup(launched.ownershipId, {
        reason: policyTerminated
          ? 'live conformance policy ceiling'
          : 'live conformance deadline',
        graceMs: 0,
        killMs: 5_000,
      })
      await Promise.race([
        closePromise,
        new Promise((_, reject) => setTimeout(() => reject(new LiveConformanceError(
          'COMMAND_SETTLEMENT_TIMEOUT',
          'POSIX owned child did not close after group cancellation',
        )), CHILD_SETTLEMENT_TIMEOUT_MS)),
      ])
    } else {
      await owner.observeRootExit(launched.ownershipId, {
        code: terminal.exitCode,
        signal: terminal.signal,
        killMs: 5_000,
      })
    }
    await owner.assertDrained()
    drained = true
    const membership = await adapter.listOwned(launched.groupIdentity)
    const ownershipPassed = initialMembership.includes(launched.rootPid) &&
      observedOwnedPids.has(launched.rootPid) && membership.length === 0
    const registryBytes = fs.readFileSync(registryPath)
    return {
      argv: [...command],
      childPid: launched.rootPid,
      durationMs: Date.now() - started,
      exitCode: terminal?.exitCode ?? null,
      killAttempted,
      policyTerminated,
      descendantPidsObserved: [...observedOwnedPids]
        .filter(pid => pid !== launched.rootPid).sort((left, right) => left - right),
      residualPids: membership,
      signal: terminal?.signal || null,
      stderr: Buffer.concat(stderr),
      stdout: Buffer.concat(stdout),
      timedOut,
      ownership: Object.freeze({
        result: ownershipPassed ? 'PASS' : 'FAIL',
        adapterKind: 'posix-process-group',
        assignedBeforeResume: initialMembership.includes(launched.rootPid),
        groupIdentity: launched.groupIdentity,
        membershipSamples,
        observedOwnedPids: [...observedOwnedPids].sort((left, right) => left - right),
        paidCodexPid: launched.rootPid,
        paidCodexObservedAsGroupMember: observedOwnedPids.has(launched.rootPid),
        processOwnerSourceSha256: sha256(fs.readFileSync(
          path.resolve(__dirname, '..', '..', 'agents', 'codex', 'workflow', 'process-owner.js'),
        )),
        registrySha256: sha256(registryBytes),
        terminalMembership: membership,
        zeroMembershipDrained: membership.length === 0,
      }),
    }
  } finally {
    if (!drained) {
      try {
        await owner.cancelGroup(launched.ownershipId, {
          reason: 'live conformance exceptional cleanup', graceMs: 0, killMs: 5_000,
        })
      } finally {
        await owner.assertDrained()
      }
    }
  }
}

function runSynchronous(command, options = {}) {
  const started = Date.now()
  const result = childProcess.spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    encoding: null,
    timeout: options.timeoutMs || 120_000,
    windowsHide: true,
    shell: false,
  })
  const record = {
    argv: [...command],
    durationMs: Date.now() - started,
    exitCode: result.status,
    signal: result.signal,
    stderr: Buffer.from(result.stderr || ''),
    stdout: Buffer.from(result.stdout || ''),
    timedOut: result.error?.code === 'ETIMEDOUT',
  }
  if (record.exitCode !== 0 || record.signal || record.timedOut) {
    fail('TEMP_CANDIDATE_REFRESH_FAILED', `temporary candidate command failed: ${command.join(' ')}`, {
      ...commandSummary(record),
      stderr: record.stderr.toString('utf8').slice(0, 2_000),
    })
  }
  return record
}

function nextPatchVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail('TEMP_RELEASE_INVALID', 'release version is invalid')
  const [major, minor, patch] = version.split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

function releaseRecordDigest(record) {
  return sha256(JSON.stringify({
    version: record.version,
    payloadGeneration: record.payloadGeneration,
    payloadDigest: record.payloadDigest,
    previousRecordDigest: record.previousRecordDigest,
  }))
}

function prepareTemporaryReleaseVersion(sourceRoot) {
  const packagePath = path.join(sourceRoot, 'packages', 'codex', 'package.json')
  const historyPath = path.join(sourceRoot, 'packages', 'codex', 'release-history.json')
  const packageRecord = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
  const previous = history.releases.at(-1)
  const version = nextPatchVersion(previous.version)
  packageRecord.version = version
  fs.writeFileSync(packagePath, `${JSON.stringify(packageRecord, null, 2)}\n`)
  fs.writeFileSync(path.join(sourceRoot, 'agents', 'codex', 'VERSION'), `${version}\n`)
  return Object.freeze({ version, previousRecordDigest: previous.recordDigest })
}

function refreshTemporaryReleaseBinding(sourceRoot, prepared) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'agents', 'manifests', 'codex-runtime.json'), 'utf8'))
  const packagePath = path.join(sourceRoot, 'packages', 'codex', 'package.json')
  const releasePath = path.join(sourceRoot, 'packages', 'codex', 'release.json')
  const historyPath = path.join(sourceRoot, 'packages', 'codex', 'release-history.json')
  const packageRecord = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
  const previous = history.releases.at(-1)
  const version = prepared?.version
  if (version !== packageRecord.version ||
      fs.readFileSync(path.join(sourceRoot, 'agents', 'codex', 'VERSION'), 'utf8') !== `${version}\n` ||
      previous.recordDigest !== prepared?.previousRecordDigest) {
    fail('TEMP_RELEASE_INVALID', 'prepared release version changed during candidate generation')
  }
  const appended = {
    version,
    payloadGeneration: manifest.payloadGeneration,
    payloadDigest: manifest.payloadDigest,
    previousRecordDigest: previous.recordDigest,
  }
  appended.recordDigest = releaseRecordDigest(appended)
  history.releases.push(appended)
  fs.writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`)
  fs.writeFileSync(releasePath, `${JSON.stringify({
    schemaVersion: 2,
    name: packageRecord.name,
    version,
    payloadGeneration: manifest.payloadGeneration,
    payloadDigest: manifest.payloadDigest,
    historyPath: 'release-history.json',
    historyHeadDigest: appended.recordDigest,
  }, null, 2)}\n`)
  return Object.freeze({ version, historyHeadDigest: appended.recordDigest })
}

function stageTemporaryCandidate(sourceRoot, layout, environment = process.env) {
  copyFrozenSource(sourceRoot, layout.source)
  const commands = []
  const preparedRelease = prepareTemporaryReleaseVersion(layout.source)
  commands.push(runSynchronous([
    process.execPath, 'scripts/generate-provider-contracts.cjs', '--codex-only',
  ], { cwd: layout.source, env: environment }))
  commands.push(runSynchronous([
    process.execPath, 'scripts/runtime-payload.cjs', '--generate', 'codex',
  ], { cwd: layout.source, env: environment }))
  const release = refreshTemporaryReleaseBinding(layout.source, preparedRelease)
  commands.push(runSynchronous([
    process.execPath, 'scripts/codex-artifact.cjs', '--stage', layout.artifact,
    '--conformance-only',
  ], { cwd: layout.source, env: environment }))
  return { commands, release }
}

function writePrivateFile(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, bytes, { flag: 'wx', mode })
  try { fs.chmodSync(file, mode) } catch {}
}

function writePrivateFileAtomic(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  try {
    writePrivateFile(temporary, bytes, mode)
    fs.renameSync(temporary, file)
    try { fs.chmodSync(file, mode) } catch {}
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function createSecureAuditJournal(auditRoot) {
  const root = path.resolve(auditRoot)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.chmodSync(root, 0o700)
  if (process.platform === 'win32') ensureWindowsPrivateAcl(root)
  const journalRoot = path.join(root, 'journal')
  fs.mkdirSync(journalRoot, { recursive: true, mode: 0o700 })
  fs.chmodSync(journalRoot, 0o700)
  if (process.platform === 'win32') ensureWindowsPrivateAcl(journalRoot)
  let sequence = 0
  return Object.freeze({
    root,
    append(kind, payload) {
      if (!/^[a-z0-9-]+$/.test(kind)) fail('AUDIT_JOURNAL_INVALID', 'audit journal kind is invalid')
      sequence += 1
      const record = Object.freeze({
        schemaVersion: 'codex-live-audit-journal-entry.v1',
        sequence,
        kind,
        payload: cloneJson(payload),
      })
      const bytes = Buffer.from(stableJsonV1(record), 'utf8')
      const file = path.join(journalRoot, `${String(sequence).padStart(6, '0')}-${kind}.json`)
      writePrivateFileAtomic(file, bytes)
      return Object.freeze({ file, bytes: bytes.length, sha256: sha256(bytes), record })
    },
  })
}

function enforceOwnerOnlyWindowsAcl(file, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || childProcess.spawnSync
  const timeoutMs = externalHelperTimeout(options)
  let sidResult
  try {
    sidResult = spawnSyncImpl('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs })
  } catch (error) { sidResult = { error, signal: null, status: null, stdout: '' } }
  const sid = String(sidResult?.stdout || '').trim()
  if (!sidResult || sidResult.error || sidResult.signal || sidResult.status !== 0 ||
      !/^S-\d(?:-\d+)+$/.test(sid)) {
    fail('AUTH_ACL_FAILED', 'cannot resolve the current Windows owner SID', {
      ...helperFailureDetails(sidResult, timeoutMs), step: 'owner-sid',
    })
  }
  let acl
  try {
    acl = spawnSyncImpl('icacls.exe', [
      file, '/inheritance:r', '/grant:r', `*${sid}:(F)`,
    ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs })
  } catch (error) { acl = { error, signal: null, status: null } }
  if (!acl || acl.error || acl.signal || acl.status !== 0) {
    fail('AUTH_ACL_FAILED', 'cannot apply an owner-only authentication ACL', {
      ...helperFailureDetails(acl, timeoutMs), step: 'owner-acl',
    })
  }
  return true
}

function copyAuthentication(source, codexHome) {
  const realSource = assertRegularUnlinked(source, 'Codex authentication input')
  const destination = path.join(codexHome, 'auth.json')
  if (!isWithin(codexHome, destination)) fail('AUTH_PATH_ESCAPE', 'authentication destination escapes CODEX_HOME')
  fs.copyFileSync(realSource, destination, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(destination, 0o600)
  if (process.platform === 'win32') enforceOwnerOnlyWindowsAcl(destination)
  return Object.freeze({ destination, copied: true, ownerOnly: true })
}

function tomlString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function privateAgentConfigPath(profilePath, agentsRoot, agentFile) {
  const relative = relativeConfigPath(profilePath, agentsRoot, agentFile)
  const resolved = path.resolve(path.dirname(profilePath), ...relative.split('/'))
  const expected = path.resolve(agentsRoot, agentFile)
  if (resolved !== expected || !isWithin(agentsRoot, resolved)) {
    fail('PRIVATE_AGENT_PATH_ESCAPE', 'private agent configuration escapes the private agents root')
  }
  assertRegularUnlinked(resolved, 'private agent configuration', {
    pathReceipt: safePathReceipt(relative, 'PRIVATE_AGENT_CONFIG'),
  })
  return relative
}

function renderIsolatedProfile(profilePath, agentsRoot, manifest) {
  const roleBindings = resolveRequiredProviderRoles(manifest, {
    requiredLogicalRoles: manifest?.logicalRoles,
  })
  const profileLines = [
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    '',
    '[sandbox_workspace_write]',
    'network_access = false',
    '',
    '[agents]',
    'max_depth = 2',
    'max_concurrent_threads_per_session = 2',
  ]
  for (const logicalRole of manifest.logicalRoles) {
    const physicalRole = roleBindings[logicalRole]
    const agentFile = `${physicalRole}.toml`
    const configFile = privateAgentConfigPath(profilePath, agentsRoot, agentFile)
    profileLines.push(
      '',
      `[agents.${tomlString(physicalRole)}]`,
      `description = ${tomlString(`Autoprompt isolated conformance role ${logicalRole}`)}`,
      `config_file = ${tomlString(configFile)}`,
    )
  }
  return `${profileLines.join('\n')}\n`
}

function installIsolatedPayload(layout) {
  const destination = path.join(layout.activationHome, 'skills', 'autoprompt')
  runSynchronous([
    process.execPath, 'scripts/runtime-payload.cjs', '--install', 'codex', '--destination', destination,
  ], { cwd: layout.artifact, env: { ...process.env, CODEX_HOME: layout.activationHome } })
  const manifestPath = path.join(layout.artifact, 'agents', 'manifests', 'codex-runtime.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const bundledRoot = path.join(
    layout.activationHome, '.autoprompt-private', 'bundles', manifest.payloadGeneration,
  )
  const bundledSkillRoot = path.join(bundledRoot, 'skills', 'autoprompt')
  // Production activation gives Codex a fresh, owner-only CODEX_HOME and
  // projects the private payload into that home's normal discovery root. The
  // package installer leaves the ordinary launcher shim there, so replace the
  // shim with the already-verified private bundle to exercise the same shape.
  fs.unlinkSync(path.join(destination, 'SKILL.md'))
  copyTree(bundledSkillRoot, destination)
  const externalDestinations = new Set()
  for (const dependency of manifest.externalDependencies || []) {
    const relative = String(dependency?.destination || '').replaceAll('\\', '/')
    if (!relative || path.isAbsolute(relative) || relative.split('/').some(part => part === '..') ||
        externalDestinations.has(relative) || !HASH_PATTERN.test(dependency?.sha256 || '')) {
      fail('PRIVATE_PAYLOAD_INVALID', 'private payload has an invalid external dependency')
    }
    externalDestinations.add(relative)
    const source = path.join(bundledRoot, ...relative.split('/'))
    const target = path.join(layout.activationHome, ...relative.split('/'))
    assertWithin(bundledRoot, source, 'bundled external dependency')
    assertWithin(layout.activationHome, target, 'activation external dependency')
    assertRegularUnlinked(source, 'bundled external dependency')
    if (sha256(fs.readFileSync(source)) !== dependency.sha256) {
      fail('PRIVATE_PAYLOAD_INVALID', 'private payload external dependency changed')
    }
    copyTree(source, target, relative)
  }
  const skillRoot = destination
  const agentsRoot = path.join(skillRoot, 'agents-runtime')
  const profilePath = path.join(layout.activationHome, 'autoprompt.config.toml')
  fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 })
  const roleBindings = resolveRequiredProviderRoles(manifest, {
    requiredLogicalRoles: manifest.logicalRoles,
  })
  const { projectPhysicalAgentRoleConfig } = require(path.join(
    layout.artifact, 'scripts', 'codex-configure.cjs',
  ))
  for (const logicalRole of manifest.logicalRoles) {
    const physicalRole = roleBindings[logicalRole]
    const source = path.join(skillRoot, 'agents', `${logicalRole}.toml`)
    const target = path.join(agentsRoot, `${physicalRole}.toml`)
    writePrivateFile(target, projectPhysicalAgentRoleConfig(
      fs.readFileSync(source), logicalRole, physicalRole,
    ))
  }
  writePrivateFile(profilePath, renderIsolatedProfile(profilePath, agentsRoot, manifest))
  const configPath = path.join(layout.activationHome, 'config.toml')
  writePrivateFile(configPath, [
    '# Isolated verifier-only Codex configuration.',
    '[[skills.config]]',
    `path = ${tomlString(path.join(skillRoot, 'SKILL.md'))}`,
    'enabled = true',
    '',
  ].join('\n'))
  const expectedSkillFiles = Object.freeze(listFiles(skillRoot))
  const expectedTopLevelSkillFiles = Object.freeze(
    expectedSkillFiles.filter(file => !file.includes('/')),
  )
  return Object.freeze({
    agentsRoot, configPath, expectedSkillFiles, expectedTopLevelSkillFiles,
    manifest, manifestPath, profilePath, skillRoot,
  })
}

function installOrdinaryDiscoveryShim(layout) {
  const source = path.join(layout.artifact, 'scripts', 'install', 'codex-discovery-shim.md')
  assertRegularUnlinked(source, 'staged Codex discovery shim')
  const destination = path.join(layout.codexHome, 'skills', 'autoprompt', 'SKILL.md')
  writePrivateFile(destination, fs.readFileSync(source))
  return destination
}

function listFiles(root, relative = '', options = {}) {
  const fsImpl = options.fsImpl || fs
  const category = options.category || 'RUN_TREE_FILE'
  const directoryReceipt = safePathReceipt(relative, category)
  let exists
  try { exists = fsImpl.existsSync(root) } catch (error) {
    filesystemFailure('FILESYSTEM_ENUMERATION_FAILED', 'cannot inspect an audit directory',
      directoryReceipt, error)
  }
  if (!exists) return []
  const output = []
  let entries
  try { entries = fsImpl.readdirSync(root, { withFileTypes: true }) } catch (error) {
    filesystemFailure('FILESYSTEM_ENUMERATION_FAILED', 'cannot enumerate an audit directory',
      directoryReceipt, error)
  }
  for (const entry of entries) {
    const item = relative ? `${relative}/${entry.name}` : entry.name
    const itemReceipt = safePathReceipt(item, category)
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) fail('DISCOVERY_LINK_FORBIDDEN',
      'filesystem inventory contains a symbolic link', { pathReceipt: itemReceipt })
    if (entry.isDirectory()) output.push(...listFiles(absolute, item, options))
    else if (entry.isFile()) output.push(item)
    else fail('DISCOVERY_SPECIAL_FILE_FORBIDDEN',
      'filesystem inventory contains a special file', { pathReceipt: itemReceipt })
  }
  return output.sort()
}

function discoverySnapshot(layout, installed, phase = 'isolated') {
  const home = phase === 'ordinary' ? layout.codexHome : layout.activationHome
  const ambientRoot = path.join(home, 'skills', 'autoprompt')
  const ambientFiles = listFiles(ambientRoot)
  const expectedAmbientFiles = phase === 'ordinary'
    ? ['SKILL.md']
    : installed.expectedSkillFiles
  const privateAgentFiles = phase === 'ordinary'
    ? []
    : listFiles(installed.agentsRoot).filter(file => file.endsWith('.toml'))
  const expectedPhysical = [...installed.manifest.physicalRoles].sort()
  const actualPhysical = privateAgentFiles.map(file => path.basename(file, '.toml')).sort()
  return Object.freeze({
    ambientFiles,
    ambientSurfaceExact: stableJsonV1(ambientFiles) === stableJsonV1(expectedAmbientFiles),
    forbiddenAmbientPrivateRoleCount: phase === 'ordinary'
      ? installed.manifest.physicalRoles.filter(role =>
          fs.existsSync(path.join(ambientRoot, 'agents-runtime', `${role}.toml`))).length
      : 0,
    privateAgentCount: actualPhysical.length,
    privateRoleInventoryExact: phase === 'ordinary'
      ? actualPhysical.length === 0
      : stableJsonV1(actualPhysical) === stableJsonV1(expectedPhysical),
    privateSkillRootSha256: phase === 'ordinary'
      ? null
      : sha256(fs.readFileSync(path.join(installed.skillRoot, 'SKILL.md'))),
    profileSha256: phase === 'ordinary' ? null : sha256(fs.readFileSync(installed.profilePath)),
  })
}

function safeChildEnvironment(layout, base = process.env, selectedHome = layout.codexHome) {
  const allowed = [
    'ComSpec', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'Path', 'PATHEXT',
    'PROCESSOR_ARCHITECTURE', 'SystemDrive', 'SystemRoot', 'WINDIR',
  ]
  const environment = {}
  for (const key of allowed) if (typeof base[key] === 'string') environment[key] = base[key]
  Object.assign(environment, {
    APPDATA: path.join(selectedHome, 'appdata'),
    CODEX_HOME: selectedHome,
    HOME: selectedHome,
    LOCALAPPDATA: path.join(selectedHome, 'local-appdata'),
    TEMP: path.join(layout.runRoot, 'temp'),
    TMP: path.join(layout.runRoot, 'temp'),
    USERPROFILE: selectedHome,
    XDG_CONFIG_HOME: path.join(selectedHome, 'xdg-config'),
  })
  for (const directory of [
    environment.APPDATA, environment.LOCALAPPDATA, environment.TEMP,
    environment.XDG_CONFIG_HOME,
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  return environment
}

function resolveCli(options, environment) {
  if (options.mode === 'fake-cli') {
    const script = assertRegularUnlinked(options.fakeCli, 'fake Codex CLI')
    return Object.freeze({
      commandPrefix: [process.execPath, script],
      launcherScriptSha256: sha256(fs.readFileSync(script)),
      resolvedPath: fs.realpathSync.native(process.execPath),
      source: 'fixture-cli',
    })
  }
  const resolver = require(path.join(options.runtimeSourceRoot || ROOT,
    'agents', 'codex', 'workflow', 'codex-executable.js'))
  const resolved = resolver.resolveCodexExecutable(options.codexExecutable || 'codex', {
    environment,
  })
  return Object.freeze({
    commandPrefix: [resolved.executable],
    launcherScriptSha256: null,
    resolvedPath: fs.realpathSync.native(resolved.executable),
    source: resolved.source,
  })
}

function deriveArtifactRuntimeIdentity(layout, cli, version) {
  const artifact = layout.artifact
  const read = relative => fs.readFileSync(path.join(artifact, ...relative.split('/')))
  return deriveCodexRuntimeIdentity({
    runtimeManifestBytes: read('agents/manifests/codex-runtime.json'),
    providerRegistryBytes: read('agents/contracts/providers.json'),
    trustedKeyRingBytes: read('agents/contracts/codex-trusted-public-keys.json'),
    evidenceBytes: read('agents/contracts/codex-live-conformance-evidence.json'),
    codexConfigureBytes: read('scripts/codex-configure.cjs'),
    codexExecutable: {
      realpath: cli.resolvedPath,
      platform: process.platform,
      arch: process.arch,
      basename: path.basename(cli.resolvedPath),
      sha256: sha256(fs.readFileSync(cli.resolvedPath)),
      version,
    },
  })
}

function parseJsonl(bytes) {
  const rows = []
  for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    try { rows.push(JSON.parse(line)) } catch {
      fail('TRANSCRIPT_JSONL_INVALID', 'Codex transcript contains a non-JSONL row')
    }
  }
  return rows
}

function valuesForKey(value, keyPattern, output = []) {
  if (Array.isArray(value)) {
    value.forEach(item => valuesForKey(item, keyPattern, output))
    return output
  }
  if (!value || typeof value !== 'object') return output
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key) && typeof child === 'string' && child) output.push(child)
    valuesForKey(child, keyPattern, output)
  }
  return output
}

function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== 'object' ||
      !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 ||
      !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) {
    fail('PROVIDER_ACCOUNTING_INCOMPLETE', 'provider token accounting is incomplete')
  }
  const derivedTotal = usage.input_tokens + usage.output_tokens
  if (!Number.isSafeInteger(derivedTotal) || derivedTotal <= 0) {
    fail('PROVIDER_ACCOUNTING_INVALID', 'provider token accounting total is invalid')
  }
  if (usage.total_tokens !== undefined &&
      (!Number.isSafeInteger(usage.total_tokens) || usage.total_tokens !== derivedTotal)) {
    fail('PROVIDER_ACCOUNTING_INVALID', 'provider token accounting total is inconsistent')
  }
  return Object.freeze({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: derivedTotal,
  })
}

function parsedTokenUsage(usage) {
  try { return normalizeTokenUsage(usage) } catch { return null }
}

function transcriptUsage(rows, providerSession = null) {
  const turnEvents = rows.filter(row => eventType(row) === 'turn.completed')
  const rootUsage = turnEvents.map(row => parsedTokenUsage(row.usage))
  const sessionRootIds = providerSession?.rootSessionIds || []
  const providerSessionIds = providerSession?.sessionIds || []
  const childUsage = providerSession?.usageRecords || []
  const childUsageComplete = providerSession?.childUsageComplete === true
  const rootTotals = rootUsage.length === 1 && rootUsage[0] ? rootUsage[0] : null
  const sessionRootUsage = providerSession?.rootSessions?.[0]?.sessionUsage || null
  const rootUsageMatchesSession = Boolean(rootTotals && sessionRootUsage &&
    rootTotals.inputTokens === sessionRootUsage.inputTokens &&
    rootTotals.outputTokens === sessionRootUsage.outputTokens &&
    rootTotals.totalTokens === sessionRootUsage.totalTokens)
  const accountingComplete = sessionRootIds.length === 1 && rootUsageMatchesSession &&
    childUsageComplete && providerSession?.sessionUsageComplete === true &&
    providerSession?.schemaCompatible === true
  const threadIds = [...new Set(providerSessionIds)]
  return Object.freeze({
    accountingComplete,
    inputTokens: accountingComplete
      ? rootTotals.inputTokens + childUsage.reduce((total, row) => total + row.inputTokens, 0) : null,
    outputTokens: accountingComplete
      ? rootTotals.outputTokens + childUsage.reduce((total, row) => total + row.outputTokens, 0) : null,
    providerLaunchCount: sessionRootIds.length === 1 ? providerSessionIds.length : null,
    providerTurnCount: accountingComplete ? turnEvents.length + childUsage.length : null,
    threadIds,
    totalTokens: accountingComplete
      ? rootTotals.totalTokens + childUsage.reduce((total, row) => total + row.totalTokens, 0) : null,
  })
}

function createTranscriptPolicyGuard(options = {}) {
  const rows = []
  const maximumLaunches = options.maximumLaunches || 6
  const maximumTurns = options.maximumTurns || 6
  const maximumTokens = options.maximumTokens || MAX_TOTAL_TOKENS
  return Object.freeze({
    rows,
    accept(line) {
      let row
      try { row = JSON.parse(line) } catch { return false }
      rows.push(row)
      const launchIds = new Set(rows.flatMap(item => {
        if (eventType(item) !== 'item.started' || item?.item?.type !== 'mcp_tool_call') return []
        const toolName = item.item.name || item.item.tool_name || item.item.toolName
        if (!/(?:^|\.)spawn_agent$/.test(String(toolName || ''))) return []
        const id = item.item.id || item.item.call_id || item.item.callId
        return typeof id === 'string' ? [id] : []
      }))
      if (1 + launchIds.size > maximumLaunches) return false
      const completedTurns = rows.filter(item => eventType(item) === 'turn.completed')
      if (completedTurns.length > maximumTurns) return false
      if (completedTurns.length > 1) return false
      const normalized = completedTurns.map(item => parsedTokenUsage(item.usage))
      if (normalized.some(usage => !usage)) return false
      const totalTokens = normalized.reduce((total, usage) => total + usage.totalTokens, 0)
      return totalTokens <= maximumTokens
    },
  })
}

function liveProviderLimits(rows, providerSession, limits) {
  const rootTurns = rows.filter(row => eventType(row) === 'turn.completed')
  const rootUsage = rootTurns.map(row => parsedTokenUsage(row.usage))
  const rootAccountingValid = rootUsage.every(Boolean)
  const rootTokens = rootUsage.reduce((total, usage) => total + (usage?.totalTokens || 0), 0)
  const sessionTokens = (providerSession.sessionUsageTotals || [])
    .reduce((total, usage) => total + usage.totalTokens, 0)
  const sessionTurns = providerSession.startedTurnCount || 0
  const launches = Math.max(1, providerSession.observedFileCount || providerSession.sessionIds.length)
  const turns = Math.max(rootTurns.length, sessionTurns)
  const tokens = Math.max(rootTokens,
    sessionTokens + (providerSession.provisionalTokenUpperBound || 0))
  return Object.freeze({
    launches,
    turns,
    tokens,
    within: rootAccountingValid && providerSession.tokenSchemaValid !== false &&
      launches <= limits.maximumLaunches && turns <= limits.maximumTurns &&
      tokens <= limits.maximumTokens,
  })
}

function eventType(row) { return String(row?.type || row?.event || '') }

function parsedCodexCliVersion(versionText) {
  const match = /^codex-cli (\d+\.\d+\.\d+)$/.exec(String(versionText).trim())
  return match ? match[1] : null
}

function timestampMs(row) {
  for (const key of ['occurred_at_ms', 'started_at_ms', 'completed_at_ms']) {
    const value = row?.payload?.[key]
    if (Number.isSafeInteger(value) && value >= 0) return value
  }
  const parsed = Date.parse(String(row?.timestamp || ''))
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeAgentStatus(value) {
  if (['pending_init', 'running', 'interrupted', 'errored', 'shutdown', 'not_found'].includes(value)) {
    return value
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      stableJsonV1(Object.keys(value)) !== stableJsonV1(['completed']) ||
      !(value.completed === null || typeof value.completed === 'string')) return null
  return 'completed'
}

function windowsShellIdentities(environment = process.env) {
  if (process.platform !== 'win32') return []
  const candidates = new Set()
  if (typeof environment.ComSpec === 'string') candidates.add(environment.ComSpec)
  if (typeof environment.SystemRoot === 'string') {
    candidates.add(path.join(environment.SystemRoot, 'System32', 'cmd.exe'))
    candidates.add(path.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0',
      'powershell.exe'))
  }
  const extensions = String(environment.PATHEXT || '.EXE').split(';').filter(Boolean)
  for (const directory of String(environment.PATH || environment.Path || '').split(path.delimiter)) {
    if (!directory) continue
    for (const name of ['pwsh', 'powershell']) {
      for (const extension of extensions) candidates.add(path.join(directory, `${name}${extension}`))
    }
  }
  const identities = []
  for (const candidate of candidates) {
    try {
      const realpath = fs.realpathSync.native(candidate)
      const stats = fs.lstatSync(realpath)
      if (!stats.isFile() || stats.isSymbolicLink()) continue
      const basename = path.basename(realpath).toLowerCase()
      if (!['cmd.exe', 'powershell.exe', 'pwsh.exe'].includes(basename)) continue
      identities.push({ realpath, basename, sha256: sha256(fs.readFileSync(realpath)) })
    } catch {}
  }
  return [...new Map(identities.map(identity => [identity.realpath.toLowerCase(), identity])).values()]
}

function validateCheckerCommand(command, environment = process.env) {
  if (!Array.isArray(command)) return null
  const shell = windowsShellIdentities(environment).find(identity =>
    typeof command[0] === 'string' && identity.realpath.toLowerCase() ===
      (() => { try { return fs.realpathSync.native(command[0]).toLowerCase() } catch { return '' } })())
  if (!shell) return null
  const expected = shell.basename === 'cmd.exe'
    ? [shell.realpath, '/c', CHECKER_HASH_COMMAND]
    : [shell.realpath, '-NoProfile', '-Command', CHECKER_HASH_COMMAND]
  let normalized
  try { normalized = [fs.realpathSync.native(command[0]), ...command.slice(1)] } catch { return null }
  if (stableJsonV1(normalized) !== stableJsonV1(expected)) return null
  return Object.freeze(shell)
}

function pairTurnEvents(turn, beginType, endType) {
  if (!turn) return []
  return turn.toolEvents.flatMap(begin => {
    if (begin.type !== beginType || typeof begin.callId !== 'string' || !begin.callId) return []
    const ends = turn.toolEvents.filter(end => end.type === endType && end.callId === begin.callId &&
      end.turnId === begin.turnId && Number.isSafeInteger(begin.timestampMs) &&
      Number.isSafeInteger(end.timestampMs) && end.timestampMs >= begin.timestampMs)
    return ends.length === 1 ? [{ begin, end: ends[0] }] : []
  })
}

function exactObjectKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    stableJsonV1(Object.keys(value).sort()) === stableJsonV1([...expected].sort()))
}

function parseJsonText(value) {
  if (typeof value !== 'string') return Object.freeze({ valid: false, value: null })
  try { return Object.freeze({ valid: true, value: JSON.parse(value) }) } catch {
    return Object.freeze({ valid: false, value: null })
  }
}

// Codex 0.149.1 records MCP tool calls as response_item/custom_tool_call rows. The input is
// JavaScript source, so it must never be evaluated. This deliberately small parser accepts only
// the flat primitive object literal emitted by the conformance call wrapper.
function parseFlatToolObject(source) {
  let cursor = 0
  const result = {}
  const skip = () => { while (/\s/.test(source[cursor] || '')) cursor += 1 }
  const readJsonString = () => {
    const start = cursor
    if (source[cursor] !== '"') return null
    cursor += 1
    let escaped = false
    while (cursor < source.length) {
      const character = source[cursor]
      cursor += 1
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') {
        try { return JSON.parse(source.slice(start, cursor)) } catch { return null }
      }
    }
    return null
  }
  skip()
  if (source[cursor] !== '{') return null
  cursor += 1
  while (cursor < source.length) {
    skip()
    if (source[cursor] === '}') { cursor += 1; skip(); return cursor === source.length ? result : null }
    let key = null
    if (source[cursor] === '"') key = readJsonString()
    else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(cursor))
      if (!match) return null
      key = match[0]
      cursor += key.length
    }
    if (typeof key !== 'string' || Object.prototype.hasOwnProperty.call(result, key)) return null
    skip()
    if (source[cursor] !== ':') return null
    cursor += 1
    skip()
    let value = null
    if (source[cursor] === '"') value = readJsonString()
    else {
      const match = /^(?:0|[1-9][0-9]*|true|false|null)/.exec(source.slice(cursor))
      if (!match) return null
      cursor += match[0].length
      value = match[0] === 'true' ? true : match[0] === 'false' ? false
        : match[0] === 'null' ? null : Number(match[0])
    }
    if (value === null && source.slice(cursor - 4, cursor) !== 'null') return null
    result[key] = value
    skip()
    if (source[cursor] === ',') { cursor += 1; continue }
    if (source[cursor] !== '}') return null
  }
  return null
}

function customToolOutput(payloadOutput) {
  const decoded = payloadOutput && typeof payloadOutput === 'object'
    ? Object.freeze({ valid: true, value: payloadOutput }) : parseJsonText(payloadOutput)
  if (!decoded.valid || !decoded.value || typeof decoded.value !== 'object') {
    return Object.freeze({ state: 'INVALID', result: null })
  }
  const keys = Object.keys(decoded.value)
  if (!Array.isArray(decoded.value) &&
      stableJsonV1(keys) !== stableJsonV1(keys.map((_, index) => String(index)))) {
    return Object.freeze({ state: 'INVALID', result: null })
  }
  const blocks = Array.isArray(decoded.value) ? decoded.value : keys.map(key => decoded.value[key])
  if (blocks.length === 0 || blocks.some(block => !exactObjectKeys(block, ['type', 'text']) ||
      block.type !== 'input_text' || typeof block.text !== 'string')) {
    return Object.freeze({ state: 'INVALID', result: null })
  }
  const texts = blocks.map(block => block.text)
  const completed = texts.some(text => /^Script completed(?:\r?\n|$)/.test(text))
  const failed = texts.some(text => /^Script (?:failed|error)(?:\r?\n|:|$)/i.test(text))
  const parsed = texts.map(parseJsonText).filter(item => item.valid)
  if ((completed && failed) || (!completed && !failed) || (completed && parsed.length > 1)) {
    return Object.freeze({ state: 'INVALID', result: null })
  }
  return Object.freeze({
    state: completed ? 'COMPLETED' : 'FAILED', result: parsed[0]?.value ?? null,
    texts: Object.freeze(texts),
  })
}

function customStdoutProjectionBound(evidence) {
  return Boolean(evidence?.request?.outputProjection === 'stdout' &&
    evidence.output?.texts?.length === 2 && evidence.output.texts[1] === evidence.item?.stdout)
}

function customOutputExitProjectionBound(evidence) {
  const result = evidence?.output?.result
  return Boolean(evidence?.request?.outputProjection === 'output-exit' &&
    evidence.output?.texts?.length === 2 &&
    evidence.output.texts[1] === JSON.stringify({
      output: evidence.item?.stdout, exit_code: evidence.item?.exit_code,
    }) &&
    exactObjectKeys(result, ['output', 'exit_code']) &&
    result.output === evidence.item?.stdout && result.exit_code === evidence.item?.exit_code)
}

function parseCustomExecInput(input) {
  if (typeof input !== 'string') return null
  const match = /^\s*const r = await tools\.exec_command\(([\s\S]+)\);\s*text\((JSON\.stringify\(r\)|r\.output|JSON\.stringify\(\{output:r\.output,exit_code:r\.exit_code\}\))\);\s*$/.exec(input)
  if (!match) return null
  const request = parseFlatToolObject(match[1])
  if (!exactObjectKeys(request, ['cmd', 'workdir', 'yield_time_ms', 'max_output_tokens']) ||
      typeof request.cmd !== 'string' || !request.cmd || typeof request.workdir !== 'string' ||
      !path.isAbsolute(request.workdir) || !Number.isSafeInteger(request.yield_time_ms) ||
      request.yield_time_ms <= 0 || !Number.isSafeInteger(request.max_output_tokens) ||
      request.max_output_tokens <= 0) return null
  const outputProjection = match[2] === 'JSON.stringify(r)' ? 'json'
    : match[2] === 'r.output' ? 'stdout' : 'output-exit'
  return Object.freeze({ ...request, outputProjection })
}

function parseCustomApplyPatchInput(input) {
  if (typeof input !== 'string') return null
  const legacy = /^\s*const ([A-Za-z_$][A-Za-z0-9_$]*) = ("(?:\\.|[^"\\])*");\s*const r = await tools\.apply_patch\(([A-Za-z_$][A-Za-z0-9_$]*)\);\s*text\(r\);\s*$/.exec(input)
  const inline = /^\s*const ([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*("(?:\\.|[^"\\])*");\s*text\(await tools\.apply_patch\(([A-Za-z_$][A-Za-z0-9_$]*)\)\);\s*$/.exec(input)
  const match = legacy || inline
  if (!match || match[1] !== match[3]) return null
  let patchText
  try { patchText = JSON.parse(match[2]) } catch { return null }
  const lines = patchText.split('\n')
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return null
  const operations = []
  for (let index = 1; index < lines.length - 1; index += 1) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[index])
    if (!header) continue
    operations.push({ type: header[1], path: header[2], index })
  }
  if (operations.length === 0 || operations.some(operation => {
    const normalized = operation.path.replaceAll('\\', '/')
    const parts = normalized.split('/')
    return !normalized || normalized.includes('\0') ||
      parts.some(part => part === '.' || part === '..') ||
      (!path.isAbsolute(operation.path) && parts.some(part => !part))
  })) return null
  let addedContent = null
  if (operations.length === 1 && operations[0].type === 'Add') {
    const contentLines = lines.slice(operations[0].index + 1, -1)
    if (contentLines.length === 0 || contentLines.some(line => !line.startsWith('+'))) return null
    addedContent = `${contentLines.map(line => line.slice(1)).join('\n')}\n`
  }
  return Object.freeze({
    addedContent,
    operations: Object.freeze(operations.map(operation => Object.freeze({
      type: operation.type, path: operation.path,
    }))),
    patchText,
  })
}

function commandExecutionItem(item, request, expectedStatus = 'completed', expectedRead = null) {
  const parsedCommandBound = expectedRead
    ? Array.isArray(item?.parsed_cmd) && item.parsed_cmd.length === 1 &&
      exactObjectKeys(item.parsed_cmd[0], ['type', 'cmd', 'name', 'path']) &&
      item.parsed_cmd[0].type === 'read' && item.parsed_cmd[0].cmd === request.cmd &&
      item.parsed_cmd[0].name === path.basename(expectedRead) &&
      item.parsed_cmd[0].path === expectedRead
    : Array.isArray(item?.parsed_cmd) && item.parsed_cmd.length === 1 &&
      exactObjectKeys(item.parsed_cmd[0], ['type', 'cmd']) &&
      item.parsed_cmd[0].type === 'unknown' && item.parsed_cmd[0].cmd === request.cmd
  if (!exactObjectKeys(item, [
    'type', 'id', 'process_id', 'command', 'cwd', 'parsed_cmd', 'source', 'status',
    'stdout', 'stderr', 'aggregated_output', 'exit_code', 'duration', 'formatted_output',
  ]) || item.type !== 'CommandExecution' || typeof item.id !== 'string' || !item.id ||
      typeof item.process_id !== 'string' || !item.process_id || !Array.isArray(item.command) ||
      item.command.length !== 3 || !path.isAbsolute(item.command[0]) || item.command[1] !== '-lc' ||
      item.command[2] !== request.cmd || item.cwd !== `file://${request.workdir}` ||
      !parsedCommandBound ||
      item.source !== 'unified_exec_startup' || item.status !== expectedStatus ||
      typeof item.stdout !== 'string' || typeof item.stderr !== 'string' ||
      item.aggregated_output !== item.stdout || !Number.isSafeInteger(item.exit_code) ||
      !exactObjectKeys(item.duration, ['secs', 'nanos']) ||
      !Number.isSafeInteger(item.duration.secs) || item.duration.secs < 0 ||
      !Number.isSafeInteger(item.duration.nanos) || item.duration.nanos < 0 ||
      item.formatted_output !== item.stdout) return null
  return Object.freeze(item)
}

function fileChangeItem(item) {
  if (!exactObjectKeys(item, ['type', 'id', 'changes', 'status', 'stdout', 'stderr']) ||
      item.type !== 'FileChange' || typeof item.id !== 'string' || !item.id ||
      !item.changes || typeof item.changes !== 'object' || Array.isArray(item.changes) ||
      item.status !== 'completed' || typeof item.stdout !== 'string' || item.stderr !== '') return null
  return Object.freeze(item)
}

function workerResultReadStdout(command, content, resultSha256) {
  const bytes = Buffer.from(content, 'utf8')
  const odLines = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    odLines.push(` ${[...bytes.subarray(offset, offset + 16)]
      .map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`)
  }
  const xxdLines = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16)
    const byteHex = [...chunk].map(byte => byte.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk].map(byte => byte >= 0x20 && byte <= 0x7e
      ? String.fromCharCode(byte) : '.').join('')
    xxdLines.push(`${offset.toString(16).padStart(8, '0')}: ${byteHex.padEnd(47, ' ')}  ${ascii}`)
  }
  const primitives = Object.freeze({
    'sha256sum conformance-result.txt': Object.freeze({ kind: 'hash',
      output: `${resultSha256}  conformance-result.txt\n` }),
    'wc -c conformance-result.txt': Object.freeze({ kind: 'size',
      output: `${bytes.length} conformance-result.txt\n` }),
    'wc -c < conformance-result.txt': Object.freeze({ kind: 'size', output: `${bytes.length}\n` }),
    'od -An -tx1 -v conformance-result.txt': Object.freeze({ kind: 'dump',
      output: odLines.length ? `${odLines.join('\n')}\n` : '' }),
    'xxd -g 1 conformance-result.txt': Object.freeze({ kind: 'dump',
      output: xxdLines.length ? `${xxdLines.join('\n')}\n` : '' }),
  })
  const commands = typeof command === 'string' ? command.split(' && ') : []
  if (commands.length === 0 || commands.length > 3) return null
  const selected = commands.map(item => primitives[item])
  if (selected.some(item => !item) || !selected.some(item => item.kind === 'hash') ||
      new Set(selected.map(item => item.kind)).size !== selected.length) return null
  return selected.map(item => item.output).join('')
}

function v1491CustomToolEvidence(call) {
  if (!call || call.name !== 'exec' || typeof call.input !== 'string') return null
  const output = customToolOutput(call.rawOutput)
  if (output.state === 'INVALID') return null
  const applyPatch = parseCustomApplyPatchInput(call.input)
  if (applyPatch) {
    const item = fileChangeItem(call.itemCompleted)
    if ((output.state === 'COMPLETED' && !item) ||
        (output.state === 'FAILED' && call.itemCompleted !== null)) return null
    return Object.freeze({ kind: 'apply_patch', item, output, ...applyPatch })
  }
  const request = parseCustomExecInput(call.input)
  if (request) {
    const item = commandExecutionItem(call.itemCompleted, request)
    if (output.state !== 'COMPLETED' || !item) return null
    return Object.freeze({ item, kind: 'exec_command', output, request })
  }
  return null
}

function terminalReportBound(message, phase, resultFile, resultSha256, resultBytes) {
  if (typeof message !== 'string') return false
  const resource = path.basename(resultFile)
  if (phase === 'checker') {
    const expected = {
      schemaVersion: 'codex-conformance-checker-report.v1', result: 'PASS', path: resource,
      sha256: resultSha256, bytes: resultBytes, readOnly: true, command: CHECKER_HASH_COMMAND,
    }
    if (message === JSON.stringify(expected)) return true
    return [
      `PASS — read-only verification of \`${resource}\`, bound to stdout SHA-256:\n\n` +
        `\`${resultSha256}\``,
      `PASS — read-only check stdout SHA-256: \`${resultSha256}\``,
      `result.checker.v2: read-only PASS\n\nstdout SHA-256: \`${resultSha256}\``,
    ].includes(message)
  }
  const readOnly = phase === 'resumed'
  const expected = {
    schemaVersion: 'codex-conformance-worker-report.v1', phase, result: 'PASS', path: resource,
    sha256: resultSha256, bytes: resultBytes, readOnly,
  }
  if (message === JSON.stringify(expected)) return true
  const contentBytes = resultBytes - 1
  const compatible = phase === 'initial' ? [
    `Completed: \`${resource}\` → SHA-256 \`${resultSha256}\`.`,
    `result.worker.v2: COMPLETED\n\n\`${resource}\` is compliant: exactly ${resultBytes} bytes ` +
      `containing the required ASCII text followed by one LF byte.\n\nSHA-256: \`${resultSha256}\``,
    `PASS — \`${resource}\` contains the required bytes and has SHA-256 \`${resultSha256}\`.`,
  ] : [
    `Confirmed read-only: \`${resource}\` contains exactly the required ${contentBytes}-byte ` +
      `string plus one LF byte. SHA-256: \`${resultSha256}\`.`,
    `result.worker.v2: COMPLETED\n\nFinal read-only verification: \`${resource}\` remains ` +
      `compliant—exactly ${resultBytes} bytes containing the required ASCII token followed by one ` +
      `LF byte and nothing else.\n\nSHA-256: \`${resultSha256}\``,
    `Final handoff: \`${resource}\` is complete and bound to SHA-256 \`${resultSha256}\`.`,
  ]
  return compatible.includes(message)
}

function v1491CollaborationEvidence(rows, root, workerRole, checkerRole, resultFile, resultSha256,
    resultBytes, resultAbsentBefore) {
  if (!root || root.cliVersion !== '0.149.1' || root.turns.length !== 1 ||
      root.turns[0].terminalType !== 'task_complete') return null
  const rootTurn = root.turns[0]
  const calls = root.toolCalls || []
  const validCallInterval = call => call.outputExists && Number.isSafeInteger(call.timestampMs) &&
    Number.isSafeInteger(call.resultTimestampMs) && call.resultTimestampMs >= call.timestampMs &&
    call.itemCompleted && Number.isSafeInteger(call.itemStartedTimestampMs) &&
    Number.isSafeInteger(call.itemCompletedTimestampMs) &&
    call.itemStartedTimestampMs >= call.timestampMs &&
    call.itemCompletedTimestampMs >= call.itemStartedTimestampMs &&
    call.itemCompletedTimestampMs <= call.resultTimestampMs &&
    call.timestampMs >= rootTurn.startedTimestampMs && call.resultTimestampMs <= rootTurn.terminalTimestampMs
  if (!calls.every(validCallInterval)) return null
  const subAgentItem = (call, kind, child) => exactObjectKeys(call.itemCompleted,
    ['type', 'id', 'kind', 'agent_thread_id', 'agent_path']) &&
    call.itemCompleted.type === 'SubAgentActivity' && call.itemCompleted.id === call.callId &&
    call.itemCompleted.kind === kind && call.itemCompleted.agent_thread_id === child.id &&
    call.itemCompleted.agent_path === child.agentPath
  const waitItem = call => exactObjectKeys(call.itemCompleted, [
    'type', 'id', 'tool', 'status', 'sender_thread_id', 'receiver_thread_ids',
    'receiver_agents', 'agents_states',
  ]) && call.itemCompleted.type === 'CollabAgentToolCall' &&
    call.itemCompleted.id === call.callId && call.itemCompleted.tool === 'wait' &&
    call.itemCompleted.status === 'completed' && call.itemCompleted.sender_thread_id === root.id &&
    Array.isArray(call.itemCompleted.receiver_thread_ids) &&
    call.itemCompleted.receiver_thread_ids.length === 0 &&
    Array.isArray(call.itemCompleted.receiver_agents) &&
    call.itemCompleted.receiver_agents.length === 0 &&
    exactObjectKeys(call.itemCompleted.agents_states, [])
  const spawnCalls = calls.filter(call => call.name === 'spawn_agent')
  const bindSpawn = role => {
    const matches = spawnCalls.filter(call => exactObjectKeys(call.arguments,
      ['agent_type', 'fork_turns', 'message', 'task_name']) &&
      call.arguments.agent_type === role && call.arguments.fork_turns === 'all' &&
      typeof call.arguments.message === 'string' && call.arguments.message.length > 0 &&
      /^[a-z][a-z0-9_]*$/.test(call.arguments.task_name || '') &&
      exactObjectKeys(call.result, ['task_name']) && typeof call.result.task_name === 'string')
    if (matches.length !== 1) return null
    const call = matches[0]
    const childMatches = rows.sessions.filter(session => session.parentThreadId === root.id &&
      session.agentRole === role && session.agentPath === call.result.task_name &&
      path.posix.basename(session.agentPath) === call.arguments.task_name &&
      session.sourceSpawn?.parent_thread_id === root.id &&
      session.sourceSpawn?.agent_path === session.agentPath &&
      session.sourceSpawn?.agent_role === role && session.turns.length > 0 &&
      session.turns[0].startedTimestampMs >= call.itemCompletedTimestampMs)
    return childMatches.length === 1 && subAgentItem(call, 'started', childMatches[0])
      ? { call, child: childMatches[0] } : null
  }
  const worker = bindSpawn(workerRole)
  const checker = bindSpawn(checkerRole)
  if (!worker || !checker || worker.child.id === checker.child.id || worker.child.turns.length !== 2 ||
      checker.child.turns.length !== 1) return null
  const [firstWorkerTurn, secondWorkerTurn] = worker.child.turns
  const checkerTurn = checker.child.turns[0]
  if ([firstWorkerTurn, secondWorkerTurn, checkerTurn].some(turn =>
    turn.terminalType !== 'task_complete') ||
      !terminalReportBound(firstWorkerTurn.lastAgentMessage, 'initial', resultFile,
        resultSha256, resultBytes) ||
      !terminalReportBound(secondWorkerTurn.lastAgentMessage, 'resumed', resultFile,
        resultSha256, resultBytes) ||
      !terminalReportBound(checkerTurn.lastAgentMessage, 'checker', resultFile,
        resultSha256, resultBytes)) return null
  const waitCalls = calls.filter(call => call.name === 'wait_agent' &&
    exactObjectKeys(call.arguments, ['timeout_ms']) && Number.isSafeInteger(call.arguments.timeout_ms) &&
    call.arguments.timeout_ms > 0 && exactObjectKeys(call.result, ['message', 'timed_out']) &&
    call.result.message === 'Wait completed.' && call.result.timed_out === false && waitItem(call))
  const bindWait = (turn, afterTimestampMs) => waitCalls.filter(call =>
    call.timestampMs >= afterTimestampMs && call.timestampMs <= turn.terminalTimestampMs &&
    call.resultTimestampMs >= turn.terminalTimestampMs)
  const firstWaits = bindWait(firstWorkerTurn, worker.call.resultTimestampMs)
  const firstWait = firstWaits.length === 1 ? firstWaits[0] : null
  const followups = calls.filter(call => firstWait && call.name === 'followup_task' &&
    exactObjectKeys(call.arguments, ['message', 'target']) &&
    typeof call.arguments.message === 'string' && call.arguments.message.length > 0 &&
    call.arguments.target === worker.child.agentPath && call.rawOutput === '' &&
    subAgentItem(call, 'interacted', worker.child) &&
    call.timestampMs >= firstWait.resultTimestampMs &&
    call.timestampMs <= secondWorkerTurn.startedTimestampMs &&
    call.resultTimestampMs >= secondWorkerTurn.startedTimestampMs &&
    call.resultTimestampMs <= secondWorkerTurn.terminalTimestampMs)
  const followup = followups.length === 1 ? followups[0] : null
  const secondWaits = followup ? bindWait(secondWorkerTurn, followup.resultTimestampMs) : []
  const secondWait = secondWaits.length === 1 ? secondWaits[0] : null
  const checkerOrdered = Boolean(secondWait && checker.call.timestampMs >= secondWait.resultTimestampMs)
  const checkerWaits = checkerOrdered ? bindWait(checkerTurn, checker.call.resultTimestampMs) : []
  const checkerWait = checkerWaits.length === 1 ? checkerWaits[0] : null
  const consumed = new Set([
    worker.call.callId, firstWait?.callId, followup?.callId, secondWait?.callId,
    checker.call.callId, checkerWait?.callId,
  ].filter(Boolean))
  if (!firstWait || !followup || !secondWait || !checkerWait ||
      firstWorkerTurn.startedTimestampMs > firstWait.resultTimestampMs ||
      checkerTurn.startedTimestampMs > checkerWait.resultTimestampMs ||
      calls.some(call => !consumed.has(call.callId))) return null

  const firstWorkerCalls = firstWorkerTurn.responseToolCalls || []
  const secondWorkerCalls = secondWorkerTurn.responseToolCalls || []
  const parsedWorkerCalls = firstWorkerCalls.map(call => ({ call, evidence: v1491CustomToolEvidence(call) }))
  const hasAbsenceProbe = parsedWorkerCalls[0]?.evidence?.kind === 'exec_command' &&
    [WORKER_ABSENCE_PROBE_COMMAND, WORKER_MISSING_PROBE_COMMAND]
      .includes(parsedWorkerCalls[0].evidence.request.cmd)
  const patchIndex = hasAbsenceProbe ? 1 : 0
  const patchCalls = parsedWorkerCalls.filter(({ evidence }) => evidence?.kind === 'apply_patch')
  const patchPathsExact = patchCalls.length > 0 && patchCalls.every(({ evidence }) =>
    evidence.operations.every(operation => path.resolve(path.dirname(resultFile), operation.path) ===
      path.resolve(resultFile)))
  const successfulPatches = patchCalls.filter(({ evidence }) => evidence.output.state === 'COMPLETED' &&
    exactObjectKeys(evidence.output.result, []) && evidence.operations.length === 1 &&
    evidence.operations[0].type === 'Add' && typeof evidence.addedContent === 'string' &&
    exactObjectKeys(evidence.item.changes, [path.resolve(resultFile)]) &&
    exactObjectKeys(evidence.item.changes[path.resolve(resultFile)], ['type', 'content']) &&
    evidence.item.changes[path.resolve(resultFile)].type === 'add' &&
    evidence.item.changes[path.resolve(resultFile)].content === evidence.addedContent)
  const successfulPatch = successfulPatches.length === 1 ? successfulPatches[0] : null
  const absenceProbe = hasAbsenceProbe ? parsedWorkerCalls[0]?.evidence : null
  const expectedAbsenceOutput = absenceProbe?.request.cmd === WORKER_MISSING_PROBE_COMMAND
    ? 'MISSING\n' : ''
  const absenceProbeBound = !hasAbsenceProbe || Boolean(absenceProbe?.request.workdir ===
    path.dirname(path.resolve(resultFile)) && absenceProbe.request.outputProjection === 'stdout' &&
    absenceProbe.output.state === 'COMPLETED' && absenceProbe.item.exit_code === 0 &&
    absenceProbe.item.stdout === expectedAbsenceOutput && absenceProbe.item.stderr === '' &&
    customStdoutProjectionBound(absenceProbe))
  const workerRead = parsedWorkerCalls[patchIndex + 1]?.evidence
  const expectedWorkerReadStdout = successfulPatch && workerRead?.kind === 'exec_command'
    ? workerResultReadStdout(workerRead.request.cmd,
      successfulPatch.evidence.addedContent, resultSha256)
    : null
  const workerReadBound = Boolean(workerRead?.kind === 'exec_command' &&
    workerRead.request.workdir === path.dirname(path.resolve(resultFile)) &&
    workerRead.request.outputProjection === 'stdout' && workerRead.output.state === 'COMPLETED' &&
    expectedWorkerReadStdout !== null && workerRead.item.exit_code === 0 &&
    workerRead.item.stderr === '' && workerRead.item.stdout === expectedWorkerReadStdout &&
    customStdoutProjectionBound(workerRead))
  const resumeRead = secondWorkerCalls.length === 1
    ? v1491CustomToolEvidence(secondWorkerCalls[0]) : null
  const expectedResumeReadStdout = successfulPatch && resumeRead?.kind === 'exec_command'
    ? workerResultReadStdout(resumeRead.request.cmd,
      successfulPatch.evidence.addedContent, resultSha256)
    : null
  const resumeReadBound = Boolean(
    resumeRead?.kind === 'exec_command' &&
    resumeRead.output.state === 'COMPLETED' && resumeRead.item.exit_code === 0 &&
    resumeRead.item.stderr === '' && expectedResumeReadStdout !== null &&
    resumeRead.item.stdout === expectedResumeReadStdout &&
    resumeRead.request.workdir === path.dirname(path.resolve(resultFile)) &&
    resumeRead.request.outputProjection === 'stdout' && customStdoutProjectionBound(resumeRead))
  const workerBound = Boolean(resultAbsentBefore === true &&
    parsedWorkerCalls.length === patchIndex + 2 &&
    parsedWorkerCalls.every(({ evidence }) => Boolean(evidence)) &&
    parsedWorkerCalls[patchIndex] === successfulPatch && patchCalls.length === 1 && patchPathsExact &&
    absenceProbeBound && workerReadBound && secondWorkerCalls.length === 1 && resumeReadBound &&
    successfulPatch &&
    sha256(Buffer.from(successfulPatch.evidence.addedContent, 'utf8')) === resultSha256)

  const checkerCalls = checkerTurn.responseToolCalls || []
  const checkerEvidence = checkerCalls.length === 1 ? v1491CustomToolEvidence(checkerCalls[0]) : null
  const checkerResult = checkerEvidence?.output?.result
  const checkerBound = Boolean(checkerEvidence?.kind === 'exec_command' &&
    checkerEvidence.output.state === 'COMPLETED' &&
    checkerEvidence.request.cmd === CHECKER_HASH_COMMAND &&
    checkerEvidence.request.outputProjection === 'json' &&
    path.resolve(checkerEvidence.request.workdir) === path.dirname(path.resolve(resultFile)) &&
    exactObjectKeys(checkerResult,
      ['chunk_id', 'wall_time_seconds', 'exit_code', 'original_token_count', 'output']) &&
    typeof checkerResult.chunk_id === 'string' && checkerResult.chunk_id &&
    typeof checkerResult.wall_time_seconds === 'number' && checkerResult.wall_time_seconds >= 0 &&
    checkerResult.exit_code === 0 && Number.isSafeInteger(checkerResult.original_token_count) &&
    checkerResult.original_token_count >= 0 && checkerResult.output === `${resultSha256}\n` &&
    checkerEvidence.item.exit_code === checkerResult.exit_code &&
    checkerEvidence.item.stdout === checkerResult.output && checkerEvidence.item.stderr === '')
  return Object.freeze({
    checker, checkerBound, checkerShell: checkerBound ? Object.freeze({
      command: CHECKER_HASH_COMMAND, transport: 'response_item.custom_tool_call',
    }) : null,
    followup, patchContent: successfulPatch?.evidence?.addedContent || null,
    resumeBound: Boolean(followup && secondWait), worker, workerBound,
  })
}

function typedSessionEvidence(rows, workerRole, checkerRole, diagnosticRole, resultFile, resultSha256,
    resultBytes, resultAbsentBefore, requirements) {
  const root = rows.rootSessions?.length === 1 ? rows.rootSessions[0] : null
  const collabEvents = root?.collabEvents || []
  const responseItemEvidence = collabEvents.length === 0 &&
    rows.sessions?.every(session => session.cliVersion === '0.149.1')
    ? v1491CollaborationEvidence(rows, root, workerRole, checkerRole, resultFile, resultSha256,
      resultBytes, resultAbsentBefore)
    : null
  if (responseItemEvidence) {
    const valid = responseItemEvidence.workerBound && responseItemEvidence.resumeBound &&
      responseItemEvidence.checkerBound
    return Object.freeze({
      cancellationObserved: false,
      cancellationResult: 'NO_RESULT',
      checkerChildId: responseItemEvidence.checker.child.id,
      checkerIndependent: responseItemEvidence.checker.child.id !== responseItemEvidence.worker.child.id,
      checkerRole,
      childIds: [responseItemEvidence.worker.child.id, responseItemEvidence.checker.child.id],
      diagnosticCancellationObserved: false,
      diagnosticNoPaidTurn: false,
      editCausallyBoundToWorker: responseItemEvidence.workerBound,
      checkerReadCausallyBound: responseItemEvidence.checkerBound,
      checkerShellIdentity: responseItemEvidence.checkerShell,
      interruptCallId: null,
      patchContentSha256: typeof responseItemEvidence.patchContent === 'string'
        ? sha256(Buffer.from(responseItemEvidence.patchContent, 'utf8')) : null,
      result: valid && rows.schemaCompatible && requirements?.cancellationRequired !== true
        ? 'PASS' : 'NO_RESULT',
      rootThreadId: root.id,
      sameContextResume: responseItemEvidence.resumeBound,
      workerChildId: responseItemEvidence.worker.child.id,
      workerRole,
    })
  }
  const pair = (beginType, endType) => collabEvents.flatMap(begin => {
    if (begin.type !== beginType || typeof begin.callId !== 'string') return []
    const ends = collabEvents.filter(end => end.type === endType && end.callId === begin.callId &&
      end.timestampMs >= begin.timestampMs)
    return ends.length === 1 ? [{ begin, end: ends[0] }] : []
  })
  const spawnPairs = pair('collab_agent_spawn_begin', 'collab_agent_spawn_end')
  const resumePairs = pair('collab_resume_begin', 'collab_resume_end')
  const waitingPairs = pair('collab_waiting_begin', 'collab_waiting_end')
  const bindSpawn = (spawn, role, requireChild = true) => {
    const end = spawn?.end
    if (!end || end.senderThreadId !== root?.id || end.newAgentRole !== role ||
        typeof end.newThreadId !== 'string' || !end.newThreadId ||
        !end.status || typeof end.model !== 'string' || !end.model ||
        typeof end.reasoningEffort !== 'string' || !end.reasoningEffort) return null
    const activity = rows.subAgentActivities.find(item => item.kind === 'started' &&
      item.agentThreadId === end.newThreadId && item.timestampMs >= spawn.begin.timestampMs)
    if (!activity || typeof activity.agentPath !== 'string') return null
    const childMatches = rows.sessions.filter(session => session.id === end.newThreadId &&
      session.agentPath === activity.agentPath && session.agentRole === role &&
      session.parentThreadId === root?.id && session.sourceSpawn?.agent_path === activity.agentPath &&
      session.sourceSpawn?.agent_role === role && session.sourceSpawn?.parent_thread_id === root?.id)
    if (requireChild && childMatches.length !== 1) return null
    return { spawn, activity, threadId: end.newThreadId, agentPath: activity.agentPath, child: childMatches[0] || null }
  }
  const worker = bindSpawn(spawnPairs.find(spawn => spawn.end.newAgentRole === workerRole), workerRole)
  const workerTurns = worker?.child?.turns.filter(turn => turn.terminalType === 'task_complete') || []
  const firstWorkerTurn = workerTurns[0] || null
  const secondWorkerTurn = workerTurns[1] || null
  const firstWorkerReport = parseMaybeJson(firstWorkerTurn?.lastAgentMessage)
  const secondWorkerReport = parseMaybeJson(secondWorkerTurn?.lastAgentMessage)
  const workerPatchPairs = pairTurnEvents(firstWorkerTurn, 'patch_apply_begin', 'patch_apply_end')
  const workerPatch = workerPatchPairs.length === 1 ? workerPatchPairs[0] : null
  const patchChanges = workerPatch?.end?.changes
  const patchPaths = patchChanges && typeof patchChanges === 'object' && !Array.isArray(patchChanges)
    ? Object.keys(patchChanges) : []
  const patchChange = patchPaths.length === 1 ? patchChanges[patchPaths[0]] : null
  const patchContent = patchChange?.type === 'add' ? patchChange.content : null
  const workerBound = Boolean(workerPatch && resultAbsentBefore === true &&
    workerPatch.begin.turnId === firstWorkerTurn.turnId &&
    workerPatch.end.turnId === firstWorkerTurn.turnId && workerPatch.end.success === true &&
    workerPatch.end.status === 'completed' && patchPaths.length === 1 &&
    path.resolve(patchPaths[0]) === path.resolve(resultFile) && typeof patchContent === 'string' &&
    sha256(Buffer.from(patchContent, 'utf8')) === resultSha256 &&
    firstWorkerReport?.schemaVersion === 'codex-conformance-worker.v1' &&
    firstWorkerReport.phase === 'initial' && firstWorkerReport.resultSha256 === resultSha256 &&
    stableJsonV1(firstWorkerReport.changedPaths) === stableJsonV1(['conformance-result.txt']))
  const firstWorkerWait = waitingPairs.find(wait => worker &&
    wait.begin.senderThreadId === root?.id && wait.begin.receiverThreadIds.includes(worker.threadId) &&
    wait.end.statuses?.[worker.threadId] === 'completed' &&
    wait.end.timestampMs >= (firstWorkerTurn?.terminalTimestampMs ?? Number.MAX_SAFE_INTEGER))
  const resume = resumePairs.find(item => worker && item.begin.senderThreadId === root?.id &&
    item.begin.receiverThreadId === worker.threadId && item.end.senderThreadId === root.id &&
    item.end.receiverThreadId === worker.threadId && item.end.receiverAgentRole === workerRole &&
    item.end.status &&
    item.begin.timestampMs >= (firstWorkerWait?.end?.timestampMs ?? Number.MAX_SAFE_INTEGER) &&
    item.end.timestampMs <= (secondWorkerTurn?.startedTimestampMs ?? -1))
  const secondWorkerWait = waitingPairs.find(wait => worker &&
    wait.begin.senderThreadId === root?.id && wait.begin.receiverThreadIds.includes(worker.threadId) &&
    wait.end.statuses?.[worker.threadId] === 'completed' &&
    wait.end.timestampMs >= (secondWorkerTurn?.terminalTimestampMs ?? Number.MAX_SAFE_INTEGER))
  const resumeBound = Boolean(resume && firstWorkerWait && secondWorkerWait && workerTurns.length >= 2 &&
    secondWorkerReport?.schemaVersion === 'codex-conformance-worker.v1' &&
    secondWorkerReport.phase === 'resumed' && secondWorkerReport.sameContext === true &&
    secondWorkerReport.resultSha256 === resultSha256 &&
    firstWorkerTurn.turnId !== secondWorkerTurn.turnId)
  const checkerSpawn = spawnPairs.find(spawn => spawn.end.newAgentRole === checkerRole &&
    spawn.begin.timestampMs >= (secondWorkerWait?.end?.timestampMs ?? Number.MAX_SAFE_INTEGER))
  const checker = bindSpawn(checkerSpawn, checkerRole)
  const checkerTurns = checker?.child?.turns.filter(turn => turn.terminalType === 'task_complete') || []
  const checkerTurn = checkerTurns.length === 1 ? checkerTurns[0] : null
  const checkerReport = parseMaybeJson(checkerTurn?.lastAgentMessage)
  const checkerReadOnly = checker?.child?.turnContexts.length > 0 &&
    checker.child.turnContexts.every(context => context.sandboxPolicyType === 'read-only')
  const checkerExecPairs = pairTurnEvents(checkerTurn, 'exec_command_begin', 'exec_command_end')
  const checkerExec = checkerExecPairs.length === 1 ? checkerExecPairs[0] : null
  const checkerShell = checkerExec ? validateCheckerCommand(checkerExec.begin.command) : null
  const checkerBound = Boolean(checkerTurn && checkerReadOnly && checkerExec && checkerShell &&
    path.resolve(checkerExec.begin.cwd || '') === path.dirname(path.resolve(resultFile)) &&
    stableJsonV1(checkerExec.end.command) === stableJsonV1(checkerExec.begin.command) &&
    checkerExec.end.cwd === checkerExec.begin.cwd && checkerExec.end.exitCode === 0 &&
    checkerExec.end.status === 'completed' && checkerExec.end.stderr === '' &&
    checkerExec.end.stdout === `${resultSha256}\n` &&
    checkerExec.end.aggregatedOutput === `${resultSha256}\n` &&
    checkerReport?.schemaVersion === 'codex-conformance-checker.v1' &&
    checkerReport.verdict === 'PASS' && checkerReport.checkedSha256 === resultSha256 &&
    checkerReport.readOnly === true)
  const checkerWait = waitingPairs.find(wait => checker &&
    wait.begin.senderThreadId === root?.id && wait.begin.receiverThreadIds.includes(checker.threadId) &&
    wait.end.statuses?.[checker.threadId] === 'completed' &&
    wait.end.timestampMs >= (checkerTurn?.terminalTimestampMs ?? Number.MAX_SAFE_INTEGER))
  const cancellationRequired = requirements?.cancellationRequired === true
  const diagnosticSpawn = cancellationRequired
    ? spawnPairs.find(spawn => spawn.end.newAgentRole === diagnosticRole &&
      spawn.begin.timestampMs >= (checkerWait?.end?.timestampMs ?? Number.MAX_SAFE_INTEGER))
    : null
  const diagnostic = cancellationRequired ? bindSpawn(diagnosticSpawn, diagnosticRole, false) : null
  const started = diagnostic?.activity || null
  const interruptCalls = root?.toolCalls?.filter(call => call.name === 'interrupt_agent' &&
    call.arguments?.target === diagnostic?.threadId && call.outputExists &&
    call.result?.previous_status === 'running' && Number.isSafeInteger(call.timestampMs) &&
    Number.isSafeInteger(call.resultTimestampMs) && call.resultTimestampMs >= call.timestampMs &&
    call.timestampMs >= (started?.timestampMs ?? Number.MAX_SAFE_INTEGER)) || []
  const interrupt = interruptCalls.length === 1 ? interruptCalls[0] : null
  const interrupted = rows.subAgentActivities.find(activity => started &&
    activity.agentPath === started.agentPath && activity.agentThreadId === started.agentThreadId &&
    activity.kind === 'interrupted' && interrupt && activity.timestampMs >= interrupt.resultTimestampMs)
  const diagnosticWait = waitingPairs.find(wait => diagnostic && interrupted &&
    wait.begin.senderThreadId === root?.id && wait.begin.receiverThreadIds.includes(diagnostic.threadId) &&
    wait.end.statuses?.[diagnostic.threadId] === 'interrupted' &&
    wait.end.timestampMs >= interrupted.timestampMs)
  const laterDiagnosticActivity = rows.subAgentActivities.some(activity => interrupted &&
    activity.agentPath === interrupted.agentPath && activity.agentThreadId === interrupted.agentThreadId &&
    activity.timestampMs > interrupted.timestampMs)
  const diagnosticSessions = rows.sessions.filter(session => started &&
    (session.id === started.agentThreadId || session.agentPath === started.agentPath))
  const diagnosticNoPaidTurn = Boolean(started && interrupted &&
    diagnosticSessions.every(session => session.turns.length === 0 && session.tokenEventCount === 0))
  const cancellationBound = Boolean(interrupt && diagnosticNoPaidTurn && !laterDiagnosticActivity &&
    diagnosticWait && diagnosticWait.end.timestampMs >= interrupted.timestampMs)
  const childIds = [worker?.child?.id, checker?.child?.id].filter(Boolean)
  const valid = typeof root?.id === 'string' && childIds.length === 2 &&
    new Set([root.id, ...childIds]).size === 3 && workerBound && resumeBound &&
    checkerBound && (!cancellationRequired || cancellationBound)
  return Object.freeze({
    cancellationObserved: cancellationBound,
    cancellationResult: cancellationRequired ? (cancellationBound ? 'PASS' : 'NO_RESULT') : 'NO_RESULT',
    checkerChildId: checker?.child?.id || null,
    checkerIndependent: Boolean(checker?.child?.id && checker.child.id !== worker?.child?.id),
    checkerRole,
    childIds,
    diagnosticCancellationObserved: cancellationBound,
    diagnosticNoPaidTurn,
    editCausallyBoundToWorker: workerBound,
    checkerReadCausallyBound: checkerBound,
    checkerShellIdentity: checkerShell,
    interruptCallId: interrupt?.callId || null,
    patchContentSha256: typeof patchContent === 'string' ? sha256(Buffer.from(patchContent, 'utf8')) : null,
    result: valid && rows.schemaCompatible ? 'PASS' : 'NO_RESULT',
    rootThreadId: root?.id || null,
    sameContextResume: Boolean(resume && resumeBound),
    workerChildId: worker?.child?.id || null,
    workerRole,
  })
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try { return JSON.parse(value) } catch { return null }
}

function responseItemCallPairs(records, callType, outputType) {
  const outputs = new Map()
  let valid = true
  records.forEach((row, index) => {
    const payload = row?.payload || {}
    if (row?.type !== 'response_item' || payload.type !== outputType) return
    const outputShapeValid = outputType === 'custom_tool_call_output'
      ? ((payload.output && typeof payload.output === 'object') || typeof payload.output === 'string')
      : typeof payload.output === 'string'
    if (typeof payload.call_id !== 'string' || !payload.call_id || !outputShapeValid ||
        outputs.has(payload.call_id) ||
        !Number.isSafeInteger(timestampMs(row))) {
      valid = false
      return
    }
    outputs.set(payload.call_id, Object.freeze({
      index, raw: payload.output, timestampMs: timestampMs(row),
    }))
  })
  const calls = []
  const callIds = new Set()
  records.forEach((row, index) => {
    const payload = row?.payload || {}
    if (row?.type !== 'response_item' || payload.type !== callType) return
    const output = outputs.get(payload.call_id)
    const argumentsJson = callType === 'function_call' ? parseJsonText(payload.arguments) : null
    if (typeof payload.call_id !== 'string' || !payload.call_id || callIds.has(payload.call_id) ||
        typeof payload.name !== 'string' || !payload.name || !output || output.index <= index ||
        !Number.isSafeInteger(timestampMs(row)) || output.timestampMs < timestampMs(row) ||
        (callType === 'custom_tool_call' && typeof payload.input !== 'string') ||
        (callType === 'function_call' && (!argumentsJson.valid ||
          !argumentsJson.value || typeof argumentsJson.value !== 'object' ||
          Array.isArray(argumentsJson.value)))) {
      valid = false
      return
    }
    callIds.add(payload.call_id)
    const outputJson = output.raw && typeof output.raw === 'object'
      ? { valid: true, value: output.raw } : parseJsonText(output.raw)
    const interstitial = records.slice(index + 1, output.index)
    const itemRows = interstitial.filter(candidate => candidate?.type === 'event_msg' &&
      candidate?.payload?.type === 'item_completed' && exactObjectKeys(candidate.payload,
        ['type', 'thread_id', 'turn_id', 'item', 'started_at_ms', 'completed_at_ms']))
    const itemRow = interstitial.length === 1 && itemRows.length === 1 ? itemRows[0] : null
    const itemStartedTimestampMs = itemRow?.payload?.started_at_ms
    const itemCompletedTimestampMs = itemRow?.payload?.completed_at_ms
    const itemIntervalValid = itemRow === null || (
      Number.isSafeInteger(itemStartedTimestampMs) && itemStartedTimestampMs >= 0 &&
      Number.isSafeInteger(itemCompletedTimestampMs) &&
      itemCompletedTimestampMs >= itemStartedTimestampMs &&
      itemStartedTimestampMs >= timestampMs(row) &&
      itemCompletedTimestampMs <= output.timestampMs)
    if (!itemIntervalValid) valid = false
    calls.push(Object.freeze({
      arguments: callType === 'function_call' ? argumentsJson.value : null,
      callId: payload.call_id,
      index,
      input: callType === 'custom_tool_call' ? payload.input : null,
      itemCompleted: itemRow ? cloneJson(itemRow.payload.item) : null,
      itemStartedTimestampMs: itemRow ? itemStartedTimestampMs : null,
      itemCompletedTimestampMs: itemRow ? itemCompletedTimestampMs : null,
      itemCompletedThreadId: itemRow ? itemRow.payload.thread_id : null,
      itemCompletedTurnId: itemRow ? itemRow.payload.turn_id : null,
      name: payload.name,
      namespace: payload.namespace,
      outputExists: true,
      outputParsed: outputJson.valid,
      rawOutput: output.raw,
      result: outputJson.valid ? outputJson.value : null,
      resultIndex: output.index,
      resultTimestampMs: output.timestampMs,
      timestampMs: timestampMs(row),
    }))
  })
  if (outputs.size !== calls.length) valid = false
  return Object.freeze({ calls: Object.freeze(calls), valid })
}

function providerSessionPathReceipt(relative) {
  return safePathReceipt(relative, 'PROVIDER_SESSION')
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino))
}

function readProviderSessionInputs(codexHome, options = {}) {
  const sessionRoot = path.join(codexHome, 'sessions')
  const fsImpl = options.fsImpl || fs
  const files = listFiles(sessionRoot, '', {
    category: 'PROVIDER_SESSION', fsImpl,
  }).filter(file => file.endsWith('.jsonl'))
  const maximumFileBytes = Number.isSafeInteger(options.maximumFileBytes) &&
    options.maximumFileBytes > 0 ? options.maximumFileBytes : 32 * 1024 * 1024
  const inputs = []
  for (const relative of files) {
    const absolute = path.join(sessionRoot, ...relative.split('/'))
    const pathReceipt = providerSessionPathReceipt(relative)
    let initial
    try { initial = fsImpl.lstatSync(absolute) } catch (error) {
      filesystemFailure('PROVIDER_SESSION_UNAVAILABLE', 'provider session cannot be read safely',
        pathReceipt, error)
    }
    if (!initial.isFile() || initial.isSymbolicLink() || Number(initial.nlink) !== 1) {
      fail('PROVIDER_SESSION_UNSAFE', 'provider session is linked or not a regular file', {
        providerSessionPath: pathReceipt,
      })
    }
    let initialRealpath
    try {
      const realpath = fsImpl.realpathSync?.native || fsImpl.realpathSync
      initialRealpath = realpath(absolute)
    } catch (error) {
      filesystemFailure('PROVIDER_SESSION_UNAVAILABLE', 'provider session cannot be resolved safely',
        pathReceipt, error)
    }
    let descriptor
    try {
      descriptor = fsImpl.openSync(absolute,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    } catch (error) {
      filesystemFailure('PROVIDER_SESSION_UNAVAILABLE', 'provider session cannot be opened safely',
        pathReceipt, error)
    }
    let opened
    let bytes
    try {
      opened = fsImpl.fstatSync(descriptor)
      if (!opened.isFile() || Number(opened.nlink) !== 1 ||
          !sameFileIdentity(initial, opened)) {
        fail('PROVIDER_SESSION_UNSAFE', 'provider session changed before it was opened', {
          providerSessionPath: pathReceipt,
        })
      }
      if (!Number.isSafeInteger(Number(opened.size)) || Number(opened.size) < 0 ||
          Number(opened.size) > maximumFileBytes) {
        fail('PROVIDER_SESSION_TOO_LARGE', 'provider session exceeds the configured byte ceiling', {
          providerSessionPath: pathReceipt,
        })
      }
      bytes = Buffer.alloc(Number(opened.size))
      let offset = 0
      while (offset < bytes.length) {
        const count = fsImpl.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
        if (!Number.isSafeInteger(count) || count <= 0) {
          fail('PROVIDER_SESSION_UNAVAILABLE', 'provider session changed while it was read', {
            providerSessionPath: pathReceipt,
          })
        }
        offset += count
      }
      const reboundDescriptor = fsImpl.fstatSync(descriptor)
      if (!sameFileIdentity(opened, reboundDescriptor) ||
          !reboundDescriptor.isFile() || Number(reboundDescriptor.nlink) !== 1 ||
          Number(reboundDescriptor.size) < bytes.length) {
        fail('PROVIDER_SESSION_UNSAFE', 'provider session changed while it was read', {
          providerSessionPath: pathReceipt,
        })
      }
    } catch (error) {
      if (error instanceof LiveConformanceError) throw error
      filesystemFailure('PROVIDER_SESSION_UNAVAILABLE', 'provider session cannot be read safely',
        pathReceipt, error)
    } finally {
      try { fsImpl.closeSync(descriptor) } catch {}
    }
    let rebound
    let reboundRealpath
    try {
      rebound = fsImpl.lstatSync(absolute)
      const realpath = fsImpl.realpathSync?.native || fsImpl.realpathSync
      reboundRealpath = realpath(absolute)
    } catch (error) {
      filesystemFailure('PROVIDER_SESSION_UNAVAILABLE', 'provider session cannot be rebound safely',
        pathReceipt, error)
    }
    if (!rebound.isFile() || rebound.isSymbolicLink() || Number(rebound.nlink) !== 1 ||
        !sameFileIdentity(opened, rebound) || initialRealpath !== reboundRealpath) {
      fail('PROVIDER_SESSION_UNSAFE', 'provider session path changed while it was read', {
        providerSessionPath: pathReceipt,
      })
    }
    inputs.push(Object.freeze({ bytes, pathReceipt, relative }))
  }
  return Object.freeze(inputs)
}

function providerSessionRawFiles(inputs) {
  return inputs.map(({ bytes, relative }) => Object.freeze({
    path: `sessions/${relative}`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    base64: bytes.toString('base64'),
  }))
}

function forkHistoryProjection(fileRecords) {
  if (fileRecords.length < 2 || fileRecords[0]?.type !== 'session_meta' ||
      fileRecords[1]?.type !== 'session_meta') return Object.freeze({ state: 'INVALID' })
  const child = fileRecords[0]?.payload || {}
  const parent = fileRecords[1]?.payload || {}
  const sourceParent = child?.source?.subagent?.thread_spawn?.parent_thread_id
  const boundary = child.subagent_history_start_ordinal
  const headerValid = child.cli_version === '0.149.1' &&
    typeof child.id === 'string' && child.id &&
    typeof child.parent_thread_id === 'string' && child.parent_thread_id &&
    child.session_id === child.parent_thread_id && child.forked_from_id === child.parent_thread_id &&
    sourceParent === child.parent_thread_id && Number.isSafeInteger(boundary) && boundary >= 2 &&
    parent.id === child.parent_thread_id && parent.session_id === parent.id &&
    parent.cli_version === child.cli_version && parent.source === 'exec' &&
    fileRecords.slice(2).every(row => row?.type !== 'session_meta')
  if (!headerValid) return Object.freeze({ state: 'INVALID' })
  if (fileRecords.length <= boundary) {
    return Object.freeze({ state: 'INCOMPLETE', child, boundary })
  }
  const boundaryRow = fileRecords[boundary]
  if (boundaryRow?.type !== 'event_msg' ||
      boundaryRow?.payload?.type !== 'thread_settings_applied') {
    return Object.freeze({ state: 'INVALID' })
  }
  return Object.freeze({
    state: 'COMPLETE', child, boundary,
    records: Object.freeze([fileRecords[0], ...fileRecords.slice(boundary)]),
  })
}

function provisionalProviderAccounting(fileRecords) {
  const startedTurnIds = []
  let currentTurnId = null
  let currentMaximum = 0
  let tokenUpperBound = 0
  let valid = true
  const settle = () => {
    tokenUpperBound += currentMaximum
    currentMaximum = 0
    currentTurnId = null
  }
  for (const row of fileRecords) {
    const payload = row?.payload || {}
    if (row?.type !== 'event_msg') continue
    if (payload.type === 'task_started') {
      if (currentTurnId || typeof payload.turn_id !== 'string' || !payload.turn_id) valid = false
      else {
        currentTurnId = payload.turn_id
        startedTurnIds.push(payload.turn_id)
      }
    } else if (payload.type === 'token_count') {
      const usage = parsedTokenUsage(payload?.info?.total_token_usage)
      if (!currentTurnId || !usage) valid = false
      else currentMaximum = Math.max(currentMaximum, usage.totalTokens)
    } else if (['task_complete', 'turn_aborted'].includes(payload.type)) {
      if (!currentTurnId || payload.turn_id !== currentTurnId) valid = false
      else settle()
    }
  }
  if (currentTurnId) settle()
  return Object.freeze({ startedTurnIds, tokenUpperBound, valid })
}

function readProviderSessionBundle(codexHome, options = {}) {
  const inputs = readProviderSessionInputs(codexHome, options)
  const records = []
  const rawFiles = providerSessionRawFiles(inputs)
  const sessions = []
  const provisionalStartedTurnIds = []
  let provisionalTokenUpperBound = 0
  let provisionalTokenSchemaValid = true
  for (const { bytes, pathReceipt, relative } of inputs) {
    const text = bytes.toString('utf8')
    const split = text.split(/\r?\n/)
    if (options.allowIncompleteLastLine && split.at(-1) !== '') split.pop()
    const lines = split.filter(Boolean)
    if (options.allowIncompleteLastLine && lines.length === 0) continue
    const fileRecords = []
    for (let index = 0; index < lines.length; index += 1) {
      let record
      try { record = JSON.parse(lines[index]) } catch {
        fail('PROVIDER_SESSION_INVALID', `provider session has invalid JSONL at line ${index + 1}`, {
          providerSessionPath: pathReceipt,
        })
      }
      fileRecords.push(record)
    }
    const metaRows = fileRecords.filter(row => row?.type === 'session_meta')
    let sessionRecords = fileRecords
    // During child creation Codex may expose either no header yet or the child's own header
    // followed by inherited parent history (including the parent header). Keep that transient
    // file visible to policy accounting, but never admit it as final evidence.
    if (metaRows.length > 1) {
      const forkProjection = forkHistoryProjection(fileRecords)
      if (forkProjection.state === 'COMPLETE') sessionRecords = forkProjection.records
      else if (options.allowIncompleteLastLine) {
        const provisional = provisionalProviderAccounting(fileRecords)
        provisionalStartedTurnIds.push(...provisional.startedTurnIds)
        provisionalTokenUpperBound += provisional.tokenUpperBound
        provisionalTokenSchemaValid &&= forkProjection.state === 'INCOMPLETE' && provisional.valid
        continue
      }
    } else if (options.allowIncompleteLastLine && metaRows.length === 0) {
      const provisional = provisionalProviderAccounting(fileRecords)
      provisionalStartedTurnIds.push(...provisional.startedTurnIds)
      provisionalTokenUpperBound += provisional.tokenUpperBound
      provisionalTokenSchemaValid &&= provisional.valid
      continue
    }
    const sessionMetaRows = sessionRecords.filter(row => row?.type === 'session_meta')
    if (sessionMetaRows.length !== 1 || typeof sessionMetaRows[0]?.payload?.id !== 'string') {
      fail('PROVIDER_SESSION_INVALID', 'provider session metadata is not unique', {
        providerSessionPath: pathReceipt,
      })
    }
    records.push(...sessionRecords)
    const meta = sessionMetaRows[0].payload
    const sourceSpawn = meta?.source?.subagent?.thread_spawn || null
    const parentFieldPresent = Object.prototype.hasOwnProperty.call(meta, 'parent_thread_id')
    const parentThreadId = typeof meta.parent_thread_id === 'string' ? meta.parent_thread_id : null
    const rootAncestryShape = !sourceSpawn && meta.source === 'exec' &&
      (!parentFieldPresent || meta.parent_thread_id === null)
    const childAncestryShape = Boolean(sourceSpawn) && typeof meta.parent_thread_id === 'string' &&
      sourceSpawn.parent_thread_id === meta.parent_thread_id
    const sessionIdShape = childAncestryShape && meta.cli_version === '0.149.1'
      ? meta.session_id === meta.parent_thread_id
      : meta.session_id === undefined || meta.session_id === meta.id
    const functionCallPairs = responseItemCallPairs(sessionRecords,
      'function_call', 'function_call_output')
    const customToolCallPairs = responseItemCallPairs(sessionRecords,
      'custom_tool_call', 'custom_tool_call_output')
    let sessionSchemaValid = sessionRecords.every(row => Number.isSafeInteger(timestampMs(row))) &&
      functionCallPairs.valid && customToolCallPairs.valid &&
      sessionIdShape &&
      (rootAncestryShape || childAncestryShape)
    const turnContexts = sessionRecords.filter(row => row?.type === 'turn_context').map(row => ({
      turnId: typeof row?.payload?.turn_id === 'string' ? row.payload.turn_id : null,
      sandboxPolicyType: typeof row?.payload?.sandbox_policy?.type === 'string'
        ? row.payload.sandbox_policy.type : null,
    }))
    const turns = []
    let currentTurn = null
    let previousCumulative = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let lastObservedCumulative = null
    let tokenSchemaValid = true
    let tokenEventCount = 0
    const sessionTurnIds = new Set()
    for (let index = 0; index < sessionRecords.length; index += 1) {
      const row = sessionRecords[index]
      const payload = row?.payload || {}
      if (row?.type === 'event_msg' && payload.type === 'task_started') {
        if (currentTurn || typeof payload.turn_id !== 'string' || !payload.turn_id ||
            sessionTurnIds.has(payload.turn_id)) {
          fail('PROVIDER_SESSION_INVALID', `provider turn start is malformed at line ${index + 1}`, {
            providerSessionPath: pathReceipt,
          })
        }
        sessionTurnIds.add(payload.turn_id)
        currentTurn = {
          turnId: payload.turn_id,
          startedTimestampMs: timestampMs(row),
          startedIndex: index,
          cumulative: null,
          toolEvents: [],
        }
      } else if (row?.type === 'event_msg' && payload.type === 'token_count') {
        tokenEventCount += 1
        if (!currentTurn || !payload.info || !payload.info.total_token_usage) {
          tokenSchemaValid = false
          lastObservedCumulative = null
          if (currentTurn) currentTurn.invalidUsage = true
          continue
        }
        const usage = parsedTokenUsage(payload.info.total_token_usage)
        if (!usage) {
          currentTurn.invalidUsage = true
          tokenSchemaValid = false
          lastObservedCumulative = null
          continue
        }
        if (lastObservedCumulative && (
          usage.inputTokens < lastObservedCumulative.inputTokens ||
          usage.outputTokens < lastObservedCumulative.outputTokens ||
          usage.totalTokens < lastObservedCumulative.totalTokens)) {
          currentTurn.invalidUsage = true
          tokenSchemaValid = false
          lastObservedCumulative = null
          continue
        }
        lastObservedCumulative = usage
        currentTurn.cumulative = usage
      } else if (row?.type === 'event_msg' && [
        'patch_apply_begin', 'patch_apply_end', 'exec_command_begin', 'exec_command_end',
      ].includes(payload.type) && currentTurn) {
        currentTurn.toolEvents.push({
          type: payload.type,
          callId: payload.call_id,
          turnId: payload.turn_id,
          timestampMs: timestampMs(row),
          changes: payload.changes,
          command: payload.command,
          cwd: payload.cwd,
          success: payload.success,
          status: payload.status,
          stdout: payload.stdout,
          stderr: payload.stderr,
          aggregatedOutput: payload.aggregated_output,
          exitCode: payload.exit_code,
        })
      } else if (row?.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(payload.type)) {
        if (!currentTurn || payload.turn_id !== currentTurn.turnId) {
          fail('PROVIDER_SESSION_INVALID', `provider turn terminal is unmatched at line ${index + 1}`, {
            providerSessionPath: pathReceipt,
          })
        }
        const cumulative = currentTurn.cumulative
        const delta = cumulative && !currentTurn.invalidUsage ? {
          inputTokens: cumulative.inputTokens - previousCumulative.inputTokens,
          outputTokens: cumulative.outputTokens - previousCumulative.outputTokens,
          totalTokens: cumulative.totalTokens - previousCumulative.totalTokens,
        } : null
        const usageValid = delta && delta.inputTokens >= 0 && delta.outputTokens >= 0 &&
          delta.totalTokens > 0 && delta.totalTokens === delta.inputTokens + delta.outputTokens
        turns.push(Object.freeze({
          turnId: currentTurn.turnId,
          startedTimestampMs: currentTurn.startedTimestampMs,
          terminalTimestampMs: timestampMs(row),
          terminalType: payload.type,
          lastAgentMessage: typeof payload.last_agent_message === 'string'
            ? payload.last_agent_message : null,
          toolEvents: currentTurn.toolEvents,
          responseToolCalls: customToolCallPairs.calls.filter(call =>
            call.index > currentTurn.startedIndex && call.resultIndex < index),
          usage: usageValid ? delta : null,
        }))
        if (cumulative && usageValid) previousCumulative = cumulative
        currentTurn = null
      }
    }
    if (currentTurn || turns.some(turn => !Number.isSafeInteger(turn.startedTimestampMs) ||
        !Number.isSafeInteger(turn.terminalTimestampMs) ||
        turn.terminalTimestampMs < turn.startedTimestampMs)) sessionSchemaValid = false
    const responseCalls = [...functionCallPairs.calls, ...customToolCallPairs.calls]
    if (responseCalls.some(call => !turns.some(turn => call.timestampMs >= turn.startedTimestampMs &&
        call.resultTimestampMs <= turn.terminalTimestampMs))) sessionSchemaValid = false
    if (responseCalls.some(call => call.itemCompleted && !turns.some(turn =>
      call.timestampMs >= turn.startedTimestampMs && call.resultTimestampMs <= turn.terminalTimestampMs &&
      call.itemCompletedTurnId === turn.turnId && call.itemCompletedThreadId === meta.id))) {
      sessionSchemaValid = false
    }
    sessions.push({
      id: meta.id,
      cliVersion: typeof meta.cli_version === 'string' ? meta.cli_version : null,
      parentThreadId,
      agentPath: typeof meta.agent_path === 'string' ? meta.agent_path : null,
      agentRole: typeof meta.agent_role === 'string' ? meta.agent_role : null,
      selectedCapabilityRoots: Array.isArray(meta.selected_capability_roots)
        ? cloneJson(meta.selected_capability_roots) : [],
      sourceSpawn,
      file: relative,
      records: sessionRecords,
      functionCalls: functionCallPairs.calls,
      customToolCalls: customToolCallPairs.calls,
      turnContexts,
      turns,
      tokenEventCount,
      tokenSchemaValid,
      sessionUsage: tokenSchemaValid ? lastObservedCumulative : null,
      currentTurnId: currentTurn?.turnId || null,
      incompleteTurn: Boolean(currentTurn),
      schemaValid: sessionSchemaValid && tokenSchemaValid,
    })
  }
  const rootSessions = sessions.filter(session => !session.parentThreadId && !session.sourceSpawn)
  const rootSessionIds = rootSessions.map(session => session.id)
  for (const session of sessions) {
    session.collabEvents = session.records.flatMap(row => {
      const payload = row?.payload || {}
      if (row?.type !== 'event_msg' || ![
        'collab_agent_spawn_begin', 'collab_agent_spawn_end',
        'collab_agent_interaction_begin', 'collab_agent_interaction_end',
        'collab_waiting_begin', 'collab_waiting_end',
        'collab_resume_begin', 'collab_resume_end',
      ].includes(payload.type)) return []
      const status = payload.status === undefined ? null : normalizeAgentStatus(payload.status)
      const statuses = payload.statuses && typeof payload.statuses === 'object' &&
        !Array.isArray(payload.statuses)
        ? Object.fromEntries(Object.entries(payload.statuses).map(([id, value]) =>
          [id, normalizeAgentStatus(value)])) : {}
      return [{
        type: payload.type,
        callId: payload.call_id,
        timestampMs: timestampMs(row),
        senderThreadId: payload.sender_thread_id,
        receiverThreadId: payload.receiver_thread_id,
        receiverThreadIds: Array.isArray(payload.receiver_thread_ids)
          ? payload.receiver_thread_ids : [],
        receiverAgentRole: payload.receiver_agent_role,
        newThreadId: payload.new_thread_id,
        newAgentRole: payload.new_agent_role,
        newAgentNickname: payload.new_agent_nickname,
        model: payload.model,
        reasoningEffort: payload.reasoning_effort,
        status,
        statuses,
        agentStatuses: Array.isArray(payload.agent_statuses) ? payload.agent_statuses : [],
      }]
    })
    if (session.collabEvents.some(event => !Number.isSafeInteger(event.timestampMs) ||
        typeof event.callId !== 'string' || !event.callId ||
        typeof event.senderThreadId !== 'string' || !event.senderThreadId ||
        (event.type.endsWith('_end') && event.status === null &&
          !['collab_waiting_end'].includes(event.type)) ||
        (event.type === 'collab_waiting_end' &&
          Object.values(event.statuses).some(status => status === null)))) session.schemaValid = false
    session.toolCalls = session.functionCalls.filter(call => call.namespace === 'collaboration')
    if (session.functionCalls.some(call => call.namespace !== 'collaboration')) session.schemaValid = false
    session.skillInputs = session.records.flatMap(row => {
      const payload = row?.payload || {}
      if (row?.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') {
        return []
      }
      return (payload.content || []).flatMap(item => item?.type === 'input_text' &&
        typeof item.text === 'string' && item.text.includes('<skill>')
        ? [{ text: item.text, sha256: sha256(Buffer.from(item.text, 'utf8')) }] : [])
    })
    session.skillCatalogInputs = session.records.flatMap(row => {
      const payload = row?.payload || {}
      if (row?.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'developer') {
        return []
      }
      return (payload.content || []).flatMap(item => item?.type === 'input_text' &&
        typeof item.text === 'string' && item.text.includes('<skills_instructions>')
        ? [{ text: item.text, sha256: sha256(Buffer.from(item.text, 'utf8')) }] : [])
    })
  }
  const usageRecords = sessions.filter(session => session.parentThreadId).flatMap(session =>
    session.turns.map(turn => turn.usage && ({ sessionId: session.id, turnId: turn.turnId, ...turn.usage }))
      .filter(Boolean))
  const childUsageComplete = sessions.filter(session => session.parentThreadId).every(session =>
    !session.incompleteTurn && session.turns.every(turn => turn.usage && turn.terminalType === 'task_complete'))
  const sessionUsageTotals = sessions.flatMap(session => session.sessionUsage
    ? [{ sessionId: session.id, ...session.sessionUsage }] : [])
  const tokenSchemaValid = sessions.every(session => session.tokenSchemaValid)
  const sessionUsageComplete = tokenSchemaValid && sessions.every(session =>
    !session.incompleteTurn && (session.turns.length === 0 ||
      (session.sessionUsage && session.turns.every(turn => turn.usage))))
  const startedTurnIds = new Set()
  let stableStartedTurnCount = 0
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (startedTurnIds.has(turn.turnId)) {
        fail('PROVIDER_SESSION_INVALID', 'provider turn identity is duplicated across sessions')
      }
      startedTurnIds.add(turn.turnId)
      stableStartedTurnCount += 1
    }
    if (session.incompleteTurn && session.currentTurnId) {
      if (startedTurnIds.has(session.currentTurnId)) {
        fail('PROVIDER_SESSION_INVALID', 'provider turn identity is duplicated across sessions')
      }
      startedTurnIds.add(session.currentTurnId)
      stableStartedTurnCount += 1
    }
  }
  for (const turnId of provisionalStartedTurnIds) startedTurnIds.add(turnId)
  const startedTurnCount = stableStartedTurnCount + provisionalStartedTurnIds.length
  const subAgentActivities = rootSessions.flatMap(session => session.records.flatMap(row => {
    const payload = row?.payload || {}
    if (row?.type !== 'event_msg' || payload.type !== 'sub_agent_activity') return []
    return [{
      agentThreadId: payload.agent_thread_id,
      agentPath: payload.agent_path,
      kind: payload.kind,
      timestampMs: timestampMs(row),
    }]
  }))
  if (subAgentActivities.some(activity => !Number.isSafeInteger(activity.timestampMs) ||
      typeof activity.agentThreadId !== 'string' || !activity.agentThreadId ||
      typeof activity.agentPath !== 'string' || !activity.agentPath ||
      !['started', 'interacted', 'interrupted'].includes(activity.kind))) {
    for (const session of rootSessions) session.schemaValid = false
  }
  const cliVersions = new Set(sessions.map(session => session.cliVersion))
  const cliVersionCompatible = cliVersions.size === 1 &&
    sessions.every(session => SUPPORTED_PROVIDER_SESSION_VERSIONS.has(session.cliVersion)) &&
    (!options.expectedCliVersion || cliVersions.has(options.expectedCliVersion))
  const hierarchyCompatible = rootSessions.length === 1 && new Set(sessions.map(session => session.id)).size ===
    sessions.length && sessions.every(session => session.schemaValid && (session === rootSessions[0]
    ? session.parentThreadId === null && !session.sourceSpawn
    : typeof session.parentThreadId === 'string' && session.parentThreadId === rootSessions[0].id &&
      session.sourceSpawn && session.sourceSpawn.parent_thread_id === session.parentThreadId))
  return Object.freeze({
    childUsageComplete, files: rawFiles, records, rootSessionIds, rootSessions, sessions,
    observedFileCount: inputs.length,
    provisionalFileCount: inputs.length - sessions.length,
    provisionalTokenUpperBound,
    schemaCompatible: hierarchyCompatible && sessions.length > 0 && inputs.length === sessions.length &&
      cliVersionCompatible,
    sessionIds: sessions.map(session => session.id), sessionUsageComplete, sessionUsageTotals,
    startedTurnCount, startedTurnIds: [...startedTurnIds], subAgentActivities,
    tokenSchemaValid: tokenSchemaValid && provisionalTokenSchemaValid, usageRecords,
  })
}

function parseSkillEntries(text) {
  const entries = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('- ') || !line.endsWith(')')) continue
    const delimiter = line.indexOf(': ')
    const locator = line.lastIndexOf('(file: ')
    if (delimiter < 3 || locator <= delimiter) continue
    entries.push({ id: line.slice(2, delimiter), path: line.slice(locator + 7, -1) })
  }
  return entries
}

function parseExplicitSkillFragment(text) {
  const value = String(text)
  const namePrefix = '<skill>\n<name>'
  const nameSuffix = '</name>\n<path>'
  const pathSuffix = '</path>\n'
  const end = '\n</skill>'
  if (!value.startsWith(namePrefix) || !value.endsWith(end)) return null
  const nameEnd = value.indexOf(nameSuffix, namePrefix.length)
  if (nameEnd < 0) return null
  const pathStart = nameEnd + nameSuffix.length
  const pathEnd = value.indexOf(pathSuffix, pathStart)
  if (pathEnd < pathStart) return null
  const contentStart = pathEnd + pathSuffix.length
  const contentEnd = value.length - end.length
  const name = value.slice(namePrefix.length, nameEnd)
  const file = value.slice(pathStart, pathEnd)
  if (!name || !file || contentEnd < contentStart || /[<>\r\n]/.test(name) || /[<>\r\n]/.test(file)) {
    return null
  }
  return Object.freeze({ name, path: file, contents: value.slice(contentStart, contentEnd) })
}

function providerPrivateSkillEvidence(providerSession, installed, profileSha256) {
  const expectedFile = fs.realpathSync(path.join(installed.skillRoot, 'SKILL.md'))
  const expectedBytes = fs.readFileSync(expectedFile)
  const expectedContents = expectedBytes.toString('utf8')
  const expectedSha256 = sha256(expectedBytes)
  const workerRole = installed.manifest.logicalToPhysicalProviderRole['ap-worker']
  const checkerRole = installed.manifest.logicalToPhysicalProviderRole['ap-independent-checker']
  const requiredSessions = [
    { label: 'root', matches: providerSession.rootSessions, role: null },
    { label: 'worker', matches: providerSession.sessions.filter(session => session.agentRole === workerRole), role: workerRole },
    { label: 'checker', matches: providerSession.sessions.filter(session => session.agentRole === checkerRole), role: checkerRole },
  ]
  const normalizedSelections = providerSession.sessions.flatMap(session =>
    session.skillInputs.map(input => {
      const parsed = parseExplicitSkillFragment(input.text)
      let realpath = null
      if (parsed?.path) {
        try { realpath = fs.realpathSync(parsed.path) } catch {}
      }
      const exact = parsed?.name === 'autoprompt' && realpath === expectedFile &&
        parsed.contents === expectedContents
      return Object.freeze({
        sessionId: session.id, inputSha256: input.sha256,
        name: parsed?.name || null, realpath, exact,
      })
    }))
  const root = providerSession.rootSessions.length === 1 ? providerSession.rootSessions[0] : null
  const rootSelections = root
    ? normalizedSelections.filter(selection => selection.sessionId === root.id) : []
  const catalogEntries = providerSession.sessions.flatMap(session =>
    session.skillCatalogInputs.flatMap(input => parseSkillEntries(input.text).map(entry => ({
      sessionId: session.id, id: entry.id, path: entry.path,
    }))))
  const visibleAutopromptEntries = catalogEntries.filter(entry => entry.id === 'autoprompt' ||
    (() => { try { return fs.realpathSync(entry.path) === expectedFile } catch { return false } })())
  const perSession = requiredSessions.map(({ label, matches, role }) => {
    const session = matches.length === 1 ? matches[0] : null
    const selections = session
      ? normalizedSelections.filter(selection => selection.sessionId === session.id) : []
    const exactSelections = selections.filter(selection => selection.exact)
    const rootBinding = label === 'root'
      ? selections.length === 1 && exactSelections.length === 1
      : selections.every(selection => selection.exact)
    return {
      label,
      sessionId: session?.id || null,
      agentRole: session?.agentRole || null,
      inputSha256: selections.map(selection => selection.inputSha256).sort(),
      expectedCount: exactSelections.length,
      unexpectedCount: selections.length - exactSelections.length,
      inheritedFromRoot: label === 'root' ? false : true,
      valid: Boolean(session && rootBinding && (label === 'root' || session.agentRole === role)),
    }
  })
  const unexpectedSelections = normalizedSelections.filter(selection => !selection.exact)
  const inputHashes = [...new Set(normalizedSelections.map(selection => selection.inputSha256))].sort()
  const roleBindings = providerSession.sessions.filter(session => session.parentThreadId)
    .map(session => session.agentRole).filter(Boolean)
  const expectedRoleBindings = [checkerRole, workerRole].sort()
  const roleBindingsExact = stableJsonV1([...roleBindings].sort()) ===
    stableJsonV1(expectedRoleBindings)
  const capabilityRootHashes = providerSession.sessions
    .filter(session => session.selectedCapabilityRoots.length > 0)
    .map(session => sha256(Buffer.from(stableJsonV1(session.selectedCapabilityRoots), 'utf8')))
  const capabilityRootsExact = capabilityRootHashes.length === 0 ||
    new Set(capabilityRootHashes).size === 1
  const valid = rootSelections.length === 1 && rootSelections[0].exact &&
    perSession.every(session => session.valid) && unexpectedSelections.length === 0 &&
    visibleAutopromptEntries.length === 0 && roleBindingsExact && capabilityRootsExact &&
    providerSession.schemaCompatible &&
    HASH_PATTERN.test(profileSha256 || '')
  return Object.freeze({
    providerInputBlockCount: inputHashes.length,
    providerInputSha256: inputHashes,
    effectivePrivateSkillIds: valid ? ['autoprompt'] : [],
    effectivePrivateSkillPaths: valid ? ['SKILL.md'] : [],
    privateSkillFileSha256: expectedSha256,
    hiddenFromDeveloperCatalog: visibleAutopromptEntries.length === 0,
    unexpectedPrivateEntryCount: unexpectedSelections.length + visibleAutopromptEntries.length,
    payloadGeneration: installed.manifest.payloadGeneration,
    profileSha256: profileSha256 || null,
    sessionBindings: perSession,
    roleBindings: [...new Set(roleBindings)].sort(),
    selectedCapabilityRootCount: providerSession.sessions[0]?.selectedCapabilityRoots.length || 0,
    selectedCapabilityRootsSha256: capabilityRootHashes[0] || null,
    result: valid ? 'PASS' : 'NO_RESULT',
  })
}

function writeTopologyProbe(layout, installed) {
  const file = path.join(layout.target, 'conformance-topology-probe.cjs')
  writePrivateFile(file, [
    "'use strict'",
    `const runtime=require(${JSON.stringify(path.join(installed.skillRoot, 'workflow', 'phase-budget.js'))})`,
    "let record={schemaVersion:'autoprompt-topology-probe.v1',parent:'worker',child:'independent-checker',route:'DIRECT',code:null,childId:null,leaseCreated:false,threadCreated:false}",
    "try{new runtime.RolePolicy().validate({parent:record.parent,child:record.child,route:record.route});record.code='UNEXPECTED_ALLOWED'}catch(error){record.code=error&&error.code||null}",
    "process.stdout.write('AUTOPROMPT_TOPOLOGY_REJECTION '+JSON.stringify(record)+'\\n')",
    "process.exitCode=record.code==='ROLE_POLICY_DENIED'?0:1",
    '',
  ].join('\n'), 0o700)
  return file
}

function providerTopologyEvidence(rows) {
  const records = []
  for (const row of rows) {
    if (eventType(row) !== 'item.completed' || row?.item?.type !== 'command_execution' ||
        row.item.exit_code !== 0 || typeof row.item.aggregated_output !== 'string') continue
    const marker = row.item.aggregated_output.split(/\r?\n/)
      .find(line => line.startsWith('AUTOPROMPT_TOPOLOGY_REJECTION '))
    if (!marker) continue
    let record
    try { record = JSON.parse(marker.slice('AUTOPROMPT_TOPOLOGY_REJECTION '.length)) } catch {
      fail('TOPOLOGY_OBSERVATION_INVALID', 'topology observation is invalid JSON')
    }
    records.push(record)
  }
  const record = records.length === 1 ? records[0] : null
  const valid = record?.schemaVersion === 'autoprompt-topology-probe.v1' &&
    record.parent === 'worker' && record.child === 'independent-checker' &&
    record.route === 'DIRECT' && record.code === 'ROLE_POLICY_DENIED' &&
    record.childId === null && record.leaseCreated === false && record.threadCreated === false
  return Object.freeze({ ...(record || {}), result: valid ? 'PASS' : 'FAIL' })
}

function fileSnapshot(root) {
  const snapshot = {}
  for (const relative of listFiles(root)) {
    const file = path.join(root, ...relative.split('/'))
    snapshot[relative] = { bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }
  }
  return snapshot
}

function writeDiscoveryProbe(layout, installed) {
  const file = path.join(layout.target, 'conformance-discovery-probe.cjs')
  const source = [
    "'use strict'",
    "const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path')",
    `const ordinaryHome=${JSON.stringify(layout.codexHome)}`,
    `const activationHome=${JSON.stringify(layout.activationHome)}`,
    `const agentsRoot=${JSON.stringify(installed.agentsRoot)}`,
    `const profilePath=${JSON.stringify(installed.profilePath)}`,
    "const phase=process.argv[2],isolated=phase==='isolated-during'",
    "if(!isolated)process.exit(2)",
    "const home=activationHome,ambient=path.join(home,'skills','autoprompt')",
    "const list=root=>fs.existsSync(root)?fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isFile()?[e.name]:[]):[]",
    "const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')",
    "const record={schemaVersion:'codex-discovery-observation.v1',phase,ambientFiles:list(ambient).sort(),privateAgentFiles:isolated?list(agentsRoot).filter(x=>x.endsWith('.toml')).sort():[],profileSha256:isolated?hash(profilePath):null,activationPrivateRootExists:fs.existsSync(agentsRoot),activationProfileExists:fs.existsSync(profilePath)}",
    "process.stdout.write('AUTOPROMPT_DISCOVERY_OBSERVATION '+JSON.stringify(record)+'\\n')",
    '',
  ].join('\n')
  writePrivateFile(file, source, 0o700)
  return file
}

function transcriptCommandPayload(command) {
  if (typeof command === 'string' && [DISCOVERY_COMMAND, DISCOVERY_RED_COMMAND].includes(command)) {
    return command
  }
  if (Array.isArray(command) && command.length === 3 && path.isAbsolute(command[0]) &&
      ['bash', 'sh'].includes(path.basename(command[0])) && command[1] === '-lc' &&
      typeof command[2] === 'string') return command[2]
  if (typeof command !== 'string') return null
  const match = /^(\S+) -lc (['"])([^\r\n]*)\2$/.exec(command)
  if (!match || !path.isAbsolute(match[1]) ||
      !['bash', 'sh'].includes(path.basename(match[1]))) return null
  return match[3]
}

function privateSkillDiscoveryPrefix(installed) {
  const expectedFile = assertRegularUnlinked(
    path.join(installed.skillRoot, 'SKILL.md'), 'installed private skill',
  )
  if (!/^\/[A-Za-z0-9._/-]+$/.test(expectedFile)) return null
  const expectedContents = fs.readFileSync(expectedFile, 'utf8')
  const lineCount = expectedContents.split('\n').length - (expectedContents.endsWith('\n') ? 1 : 0)
  if (lineCount > 240) return null
  return Object.freeze({
    command: `sed -n '1,240p' ${expectedFile} && ${DISCOVERY_RED_COMMAND}`,
    readCommand: `sed -n '1,240p' ${expectedFile}`,
    readOutput: expectedContents,
    readPath: expectedFile,
    output: expectedContents,
  })
}

function providerDiscoveryEvidence(rows, expectedPhysicalRoles, expectedTopLevelSkillFiles,
    privateSkillPrefix, expectedProfileSha256) {
  const observations = {}
  for (const row of rows) {
    if (eventType(row) !== 'item.completed' || row?.item?.type !== 'command_execution') continue
    const command = transcriptCommandPayload(row.item.command)
    const direct = command === DISCOVERY_COMMAND && row.item.exit_code === 0 &&
      row.item.status === 'completed'
    const expectedRedCommand = command === DISCOVERY_RED_COMMAND ||
      command === privateSkillPrefix?.command
    const expectedRed = expectedRedCommand && row.item.exit_code === 1 &&
      row.item.status === 'failed'
    if (!direct && !expectedRed) continue
    const output = typeof row.item.aggregated_output === 'string'
      ? row.item.aggregated_output : ''
    const markerOutput = command === privateSkillPrefix?.command &&
      output.startsWith(privateSkillPrefix.output)
      ? output.slice(privateSkillPrefix.output.length)
      : command === privateSkillPrefix?.command ? null : output
    const marker = /^AUTOPROMPT_DISCOVERY_OBSERVATION ([^\r\n]+)\r?\n$/
      .exec(markerOutput || '')
    if (!marker) {
      fail('DISCOVERY_OBSERVATION_INVALID', 'bound provider discovery output is malformed')
    }
    let observation
    try { observation = JSON.parse(marker[1]) } catch {
      fail('DISCOVERY_OBSERVATION_INVALID', 'provider discovery observation is invalid JSON')
    }
    if (!exactObjectKeys(observation, [
      'schemaVersion', 'phase', 'ambientFiles', 'privateAgentFiles', 'profileSha256',
      'activationPrivateRootExists', 'activationProfileExists',
    ]) || observation.schemaVersion !== 'codex-discovery-observation.v1' ||
        observation.phase !== 'isolated-during' ||
        !Array.isArray(observation.ambientFiles) ||
        observation.ambientFiles.some(file => typeof file !== 'string') ||
        !Array.isArray(observation.privateAgentFiles) ||
        observation.privateAgentFiles.some(file => typeof file !== 'string') ||
        observations[observation.phase]) {
      fail('DISCOVERY_OBSERVATION_INVALID', 'provider discovery observation is malformed or duplicated')
    }
    observations[observation.phase] = observation
  }
  const during = observations['isolated-during']
  const isolatedExpected = [...expectedTopLevelSkillFiles].sort()
  const privateExpected = [...expectedPhysicalRoles].map(role => `${role}.toml`).sort()
  const result = during &&
    stableJsonV1(during.ambientFiles) === stableJsonV1(isolatedExpected) &&
    stableJsonV1(during.privateAgentFiles) === stableJsonV1(privateExpected) &&
    HASH_PATTERN.test(expectedProfileSha256 || '') &&
    during.profileSha256 === expectedProfileSha256 &&
    during.activationPrivateRootExists === true && during.activationProfileExists === true
  return Object.freeze({
    isolatedDuring: during || null,
    result: result ? 'PASS' : 'FAIL',
  })
}

function snapshotDiff(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return names.filter(name => stableJsonV1(before[name] || null) !== stableJsonV1(after[name] || null))
}

const CODEX_CREDENTIAL_PATHS = Object.freeze(new Map([
  ['$.OPENAI_API_KEY', 'API_KEY'],
  ['$.api_key', 'API_KEY'],
  ['$.access_token', 'ACCESS_TOKEN'],
  ['$.refresh_token', 'REFRESH_TOKEN'],
  ['$.id_token', 'IDENTITY_TOKEN'],
  ['$.account_id', 'ACCOUNT_ID'],
  ['$.tokens.access_token', 'ACCESS_TOKEN'],
  ['$.tokens.refresh_token', 'REFRESH_TOKEN'],
  ['$.tokens.id_token', 'IDENTITY_TOKEN'],
  ['$.tokens.account_id', 'ACCOUNT_ID'],
]))

function credentialMatchers(authBytes) {
  let parsed
  try { parsed = JSON.parse(authBytes.toString('utf8')) } catch {
    fail('AUTH_INPUT_INVALID', 'Codex authentication input is not JSON')
  }
  const matchers = []
  const seen = new Set()
  function collect(value, schemaPath = '$') {
    const credentialClass = CODEX_CREDENTIAL_PATHS.get(schemaPath)
    if (credentialClass) {
      if (value === null && schemaPath === '$.OPENAI_API_KEY') return
      if (typeof value !== 'string' || value.length < 8) {
        fail('AUTH_INPUT_SCHEMA_INVALID', `credential leaf ${schemaPath} is not a usable string`)
      }
      const encodings = [
        ['raw', value],
        ['base64', Buffer.from(value, 'utf8').toString('base64')],
        ['base64url', Buffer.from(value, 'utf8').toString('base64url')],
        ['hex', Buffer.from(value, 'utf8').toString('hex')],
      ]
      for (const [encoding, needle] of encodings) {
        const identity = `${credentialClass}\0${needle}`
        if (seen.has(identity)) continue
        seen.add(identity)
        matchers.push(Object.freeze({
          credentialClass,
          encoding,
          needle,
          schemaPath,
          sourceLength: value.length,
          sourceSha256: sha256(value),
          encodedLength: needle.length,
          encodedSha256: sha256(needle),
        }))
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => collect(item, `${schemaPath}[${index}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        collect(child, `${schemaPath}.${key}`)
      }
      return
    }
    const leaf = schemaPath.split('.').at(-1).toLowerCase().replaceAll('-', '_')
    if ((schemaPath.startsWith('$.tokens.') || /(?:^|_)(?:token|secret|password|api_key)$/.test(leaf)) &&
        value !== null) {
      fail('AUTH_INPUT_SCHEMA_UNSUPPORTED', `unrecognized credential-bearing leaf ${schemaPath}`)
    }
  }
  collect(parsed)
  return Object.freeze(matchers)
}

function destinationCategory(relative) {
  const normalized = String(relative).replaceAll('\\', '/')
  if (normalized.startsWith('activation-home/cache/remote_plugin_catalog/')) {
    return 'REMOTE_PLUGIN_CATALOG'
  }
  if (normalized.startsWith('activation-home/sessions/')) return 'PROVIDER_SESSION'
  if (normalized.startsWith('activation-home/')) return 'ACTIVATION_HOME'
  if (normalized.startsWith('target/')) return 'TARGET_WORKSPACE'
  return 'RUN_TREE_FILE'
}

function sanitizedCredentialMatch(matcher, destinationRelativePath, matchLocation = 'CONTENT') {
  const normalized = String(destinationRelativePath).replaceAll('\\', '/')
  return Object.freeze({
    credentialClass: matcher.credentialClass,
    destinationCategory: destinationCategory(normalized),
    destinationPathLength: normalized.length,
    destinationPathSha256: sha256(normalized),
    encodedLength: matcher.encodedLength,
    encodedSha256: matcher.encodedSha256,
    encoding: matcher.encoding,
    matchLocation,
    sourceLength: matcher.sourceLength,
    sourceSha256: matcher.sourceSha256,
  })
}

function firstCredentialMatch(matchers, bytes, destinationRelativePath, matchLocation = 'CONTENT') {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)
  const matcher = matchers.find(candidate => text.includes(candidate.needle))
  return matcher
    ? sanitizedCredentialMatch(matcher, destinationRelativePath, matchLocation)
    : null
}

function assertNoCredentialLeak(authBytes, buffers) {
  if (!authBytes) return true
  const matchers = credentialMatchers(authBytes)
  for (const [index, value] of buffers.entries()) {
    const bytes = value && Buffer.isBuffer(value.bytes) ? value.bytes : value
    const relative = value && typeof value.relative === 'string'
      ? value.relative : `selected-buffer-${index}`
    const pathMatch = firstCredentialMatch(matchers, relative, relative, 'PATH')
    if (pathMatch) {
      fail('AUTH_EVIDENCE_LEAK', 'credential material appeared in an audit input path', {
        credentialMatches: [pathMatch],
      })
    }
    const match = firstCredentialMatch(matchers, bytes, relative)
    if (match) {
      fail('AUTH_EVIDENCE_LEAK', 'credential material appeared in conformance output', {
        credentialMatches: [match],
      })
    }
  }
  return true
}

function auditRunTree(runRoot, authBytes, allowedCredentialFiles = [], options = {}) {
  const fsImpl = options.fsImpl || fs
  const allowed = new Set(allowedCredentialFiles.filter(Boolean).map(file => path.resolve(file)))
  const matchers = authBytes ? credentialMatchers(authBytes) : []
  const inventory = []
  let credentialMaterialCount = 0
  for (const relative of listFiles(runRoot, '', { category: 'RUN_TREE_FILE', fsImpl })) {
    const pathMatch = firstCredentialMatch(matchers, relative, relative, 'PATH')
    if (pathMatch) fail('AUTH_EVIDENCE_LEAK',
      'credential material appeared in a temporary run-tree path',
      { credentialMatches: [pathMatch] })
    const absolute = path.join(runRoot, ...relative.split('/'))
    const pathReceipt = safePathReceipt(relative, 'RUN_TREE_FILE')
    assertRegularUnlinked(absolute, 'temporary run file', { fsImpl, pathReceipt })
    let bytes
    try { bytes = fsImpl.readFileSync(absolute) } catch (error) {
      filesystemFailure('RUN_TREE_FILE_UNAVAILABLE', 'temporary run file cannot be read safely',
        pathReceipt, error)
    }
    const credentialMaterial = allowed.has(path.resolve(absolute))
    if (credentialMaterial) {
      credentialMaterialCount += 1
      continue
    }
    if (!credentialMaterial) {
      const match = firstCredentialMatch(matchers, bytes, relative)
      if (match) fail('AUTH_EVIDENCE_LEAK',
        'credential material appeared outside the allowlisted auth file',
        { credentialMatches: [match] })
    }
    inventory.push(Object.freeze({
      path: relative.replaceAll('\\', '/'),
      bytes: bytes.length,
      sha256: sha256(bytes),
      scanResult: 'NO_SECRET_MATCH',
    }))
  }
  if (allowed.size && credentialMaterialCount !== allowed.size) {
    fail('AUTH_AUDIT_INCOMPLETE', 'an allowlisted credential file was absent from the run-tree audit')
  }
  return Object.freeze({
    fileCount: inventory.length,
    files: inventory,
    allowedCredentialClass: credentialMaterialCount ? 'CODEX_AUTH_INPUT' : 'NONE',
    allowedCredentialCount: credentialMaterialCount,
    result: 'PASS',
  })
}

function unsignedAuditInputs(runs, providerSession, checkLog, resultFile) {
  const inputs = []
  const addRun = (prefix, run) => {
    if (!run) return
    inputs.push([`${prefix}.stdout`, Buffer.from(run.stdout || '')])
    inputs.push([`${prefix}.stderr`, Buffer.from(run.stderr || '')])
  }
  addRun('probes/version', runs.version)
  addRun('probes/help', runs.help)
  if (runs.mission) {
    inputs.push(['mission/root.stdout.jsonl', Buffer.from(runs.mission.stdout || '')])
    inputs.push(['mission/root.stderr', Buffer.from(runs.mission.stderr || '')])
  }
  if (checkLog) inputs.push(['mission/check.log',
    fs.existsSync(checkLog) ? fs.readFileSync(checkLog) : Buffer.alloc(0)])
  if (resultFile) inputs.push(['mission/result.txt',
    fs.existsSync(resultFile) ? fs.readFileSync(resultFile) : Buffer.alloc(0)])
  for (const file of providerSession?.files || []) {
    const bytes = Buffer.from(file.base64, 'base64')
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      fail('PROVIDER_SESSION_INVALID', 'provider session audit bytes changed', {
        providerSessionPath: providerSessionPathReceipt(file.path),
      })
    }
    inputs.push([`provider/${file.path}`, bytes])
  }
  return inputs.map(([relative, bytes]) => Object.freeze({
    relative: relative.replaceAll('\\', '/'),
    bytes: Buffer.from(bytes),
    length: bytes.length,
    sha256: sha256(bytes),
  }))
}

function unsignedUsageSummary(usage, missionRun, unavailableReason = null,
    modelProcessInvocations = missionRun ? 1 : 0) {
  const launched = modelProcessInvocations === 1
  const integerOrNull = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  const accountingComplete = usage?.accountingComplete === true
  return Object.freeze({
    accountingComplete,
    modelProcessInvocations: Number.isSafeInteger(modelProcessInvocations)
      ? modelProcessInvocations : null,
    providerLaunchCount: integerOrNull(usage?.providerLaunchCount),
    providerTurnCount: integerOrNull(usage?.providerTurnCount),
    totalTokens: integerOrNull(usage?.totalTokens),
    reason: accountingComplete ? null : (unavailableReason ||
      (launched ? 'PROVIDER_ACCOUNTING_INCOMPLETE' :
        modelProcessInvocations === null
          ? 'PAID_MODEL_LAUNCH_OUTCOME_UNKNOWN'
          : 'PAID_MODEL_NOT_LAUNCHED')),
  })
}

function writeUnsignedAccounting(auditRoot, details, journal = null) {
  const usage = unsignedUsageSummary(details.usage, details.missionRun, details.unavailableReason,
    details.modelProcessInvocations)
  const record = Object.freeze({
    schemaVersion: 'codex-live-unsigned-accounting.v1',
    state: 'PRE_CREDENTIAL_AUDIT',
    modelProcessInvocations: usage.modelProcessInvocations,
    explicitDeadlineMs: details.deadlineMs,
    mission: details.missionRun ? {
      durationMs: details.missionRun.durationMs,
      exitCode: details.missionRun.exitCode,
      policyTerminated: details.missionRun.policyTerminated === true,
      timedOut: details.missionRun.timedOut === true,
      residualPids: [...(details.missionRun.residualPids || [])],
      ownershipResult: details.missionRun.ownership?.result || null,
      stdoutBytes: details.missionRun.stdout.length,
      stdoutSha256: sha256(details.missionRun.stdout),
      stderrBytes: details.missionRun.stderr.length,
      stderrSha256: sha256(details.missionRun.stderr),
    } : null,
    usage,
    rawFiles: (details.inputs || []).map(({ relative, length, sha256: digest }) => ({
      sourceCategory: destinationCategory(relative),
      sourcePathLength: relative.length,
      sourcePathSha256: sha256(relative),
      bytes: length,
      sha256: digest,
    })),
  })
  const bytes = Buffer.from(stableJsonV1(record), 'utf8')
  const file = path.join(auditRoot, 'unsigned-accounting.json')
  writePrivateFileAtomic(file, bytes)
  const result = Object.freeze({ file, record, bytes: bytes.length, sha256: sha256(bytes) })
  if (journal) journal.append('accounting', { bytes: result.bytes, sha256: result.sha256, usage })
  return result
}

function preserveUnsignedRawAudit(auditRoot, inputs, journal = null) {
  const files = []
  for (const [index, input] of inputs.entries()) {
    const sourcePathSha256 = sha256(input.relative)
    const storagePath = `raw/${String(index).padStart(4, '0')}-${sourcePathSha256}.bin`
    const target = path.join(auditRoot, ...storagePath.split('/'))
    assertWithin(auditRoot, target, 'unsigned audit raw file')
    writePrivateFileAtomic(target, input.bytes)
    files.push(Object.freeze({
      sourceCategory: destinationCategory(input.relative),
      sourcePathLength: input.relative.length,
      sourcePathSha256,
      storagePath,
      bytes: input.length,
      sha256: input.sha256,
    }))
  }
  const manifestBytes = Buffer.from(stableJsonV1({
    schemaVersion: 'codex-live-raw-audit.v1', files,
  }), 'utf8')
  const manifestFile = path.join(auditRoot, 'raw-manifest.json')
  writePrivateFileAtomic(manifestFile, manifestBytes)
  const result = Object.freeze({
    fileCount: files.length,
    files: Object.freeze(files),
    manifestSha256: sha256(manifestBytes),
  })
  if (journal) journal.append('raw-audit', {
    fileCount: result.fileCount, manifestSha256: result.manifestSha256,
  })
  return result
}

function sanitizedFailure(error) {
  const matches = Array.isArray(error?.details?.credentialMatches)
    ? error.details.credentialMatches.map(match => ({
      credentialClass: match.credentialClass,
      destinationCategory: match.destinationCategory,
      destinationPathLength: match.destinationPathLength,
      destinationPathSha256: match.destinationPathSha256,
      encodedLength: match.encodedLength,
      encodedSha256: match.encodedSha256,
      encoding: match.encoding,
      matchLocation: match.matchLocation,
      sourceLength: match.sourceLength,
      sourceSha256: match.sourceSha256,
    }))
    : []
  return Object.freeze({
    code: typeof error?.code === 'string' ? error.code : 'CONFORMANCE_ERROR',
    credentialMatches: matches,
    messageSha256: sha256(typeof error?.message === 'string' ? error.message : 'unknown failure'),
  })
}

function writeSecureAuditCleanup(auditRoot, cleanup, journal = null) {
  const record = Object.freeze({
    schemaVersion: 'codex-live-cleanup.v1',
    runRootRemoved: cleanup.runRootRemoved === true,
    launchedPidCount: cleanup.launchedPids.length,
    launchedPids: [...cleanup.launchedPids],
    pidStates: cleanup.launchedPids.map(pid => ({ pid, alive: cleanup.residualPids.includes(pid) })),
    residualPids: [...cleanup.residualPids],
    persistenceErrors: [...(cleanup.persistenceErrors || [])],
  })
  const bytes = Buffer.from(stableJsonV1(record), 'utf8')
  const file = path.join(auditRoot, 'cleanup.json')
  writePrivateFileAtomic(file, bytes)
  const result = Object.freeze({ file, record, bytes: bytes.length, sha256: sha256(bytes) })
  if (journal) journal.append('cleanup', {
    runRootRemoved: record.runRootRemoved,
    launchedPidCount: record.launchedPidCount,
    residualPids: record.residualPids,
    sha256: result.sha256,
  })
  return result
}

function buildUnsignedNoResult(details) {
  const accounting = details.accounting?.record?.usage ||
    unsignedUsageSummary(details.usage, details.missionRun, details.accountingReason,
      details.modelProcessInvocations)
  const envelope = Object.freeze({
    schemaVersion: 'codex-live-conformance-unsigned-no-result.v1',
    result: 'NO_RESULT',
    signed: false,
    signature: null,
    fixtureOnly: false,
    runtimeIdentityHash: HASH_PATTERN.test(details.runtimeIdentityHash || '')
      ? details.runtimeIdentityHash : null,
    startedAt: details.startedAt || null,
    endedAt: details.endedAt || null,
    failure: sanitizedFailure(details.error),
    accounting,
    audit: {
      accountingSha256: details.accounting?.sha256 || null,
      rawAuditManifestSha256: details.raw?.manifestSha256 || null,
    },
    cleanup: details.cleanup ? {
      runRootRemoved: details.cleanup.runRootRemoved === true,
      launchedPidCount: details.cleanup.launchedPids.length,
      residualPids: [...details.cleanup.residualPids],
      cleanupSha256: details.cleanupRecord?.sha256 || null,
      persistenceErrors: [...(details.cleanup.persistenceErrors || [])],
    } : {
      runRootRemoved: false,
      launchedPidCount: 0,
      residualPids: [],
      cleanupSha256: null,
      persistenceErrors: ['CLEANUP_NOT_RECORDED'],
    },
  })
  const canonicalJson = stableJsonV1(envelope)
  return Object.freeze({
    envelope,
    canonicalJson,
    bytes: Buffer.byteLength(canonicalJson),
    sha256: sha256(canonicalJson),
  })
}

function persistUnsignedNoResult(auditRoot, details, journal = null) {
  const result = buildUnsignedNoResult(details)
  const file = path.join(auditRoot, 'unsigned-no-result.json')
  writePrivateFileAtomic(file, Buffer.from(result.canonicalJson, 'utf8'))
  if (journal) journal.append('no-result', {
    failureCode: result.envelope.failure.code,
    sha256: result.sha256,
  })
  return Object.freeze({ ...result, file })
}

function persistBootstrapFailureReceipt(auditRoot, details) {
  const result = buildUnsignedNoResult(details)
  const file = path.join(auditRoot, 'unsigned-no-result.json')
  writePrivateFileAtomic(file, Buffer.from(result.canonicalJson, 'utf8'))
  if (process.platform === 'win32') enforceOwnerOnlyWindowsAcl(file)
  return Object.freeze({ ...result, file })
}

function missionText(token, roles, requirements) {
  const requiredRoles = resolveRequiredProviderRoles({
    logicalRoles: requirements?.requiredLogicalRoles,
    logicalToPhysicalProviderRole: roles,
    physicalRoles: Object.values(roles || {}),
  }, requirements)
  const workerRole = requiredRoles['ap-worker']
  const checkerRole = requiredRoles['ap-independent-checker']
  const lines = [
    '$autoprompt',
    'path=direct',
    'This is a bounded, local, verifier-only conformance run.',
    'The isolated Codex profile and private roles are already installed for this provider canary; do not invoke or search for an Autoprompt launcher.',
    'Use at most six total provider launches or turns and stop immediately if that limit would be exceeded.',
    'Use no network and modify only conformance-result.txt.',
    'Run node conformance-discovery-probe.cjs isolated-during by itself and preserve its exact output.',
    'Then run node conformance-check.cjs exactly once and observe exactly one initial RED result.',
    `Delegate the edit to the exact private role ${workerRole}.`,
    `The file must contain exactly ${token} followed by one LF byte and no other bytes.`,
    `Wait for ${workerRole} to finish and require a report binding conformance-result.txt and its SHA-256.`,
    'Its initial final message must be exactly one JSON object with only these keys and values: ' +
      '{"schemaVersion":"codex-conformance-worker-report.v1","phase":"initial",' +
      '"result":"PASS","path":"conformance-result.txt","sha256":"<observed lowercase SHA-256>",' +
      '"bytes":48,"readOnly":false}.',
    `Use followup_task to resume that exact completed child context, then wait for its second completed turn.`,
    'Its resumed final message must be exactly one JSON object with only these keys and values: ' +
      '{"schemaVersion":"codex-conformance-worker-report.v1","phase":"resumed",' +
      '"result":"PASS","path":"conformance-result.txt","sha256":"<same observed lowercase SHA-256>",' +
      '"bytes":48,"readOnly":true}.',
    `The worker gets exactly those two turns; never message, resume, or relaunch it after the second turn.`,
    'Run node conformance-topology-probe.cjs and preserve its production role-policy rejection.',
    `Then use exact private role ${checkerRole} for an independent read-only check.`,
    `Require ${checkerRole} to run exactly ${CHECKER_HASH_COMMAND} and return a read-only PASS verdict bound to its stdout SHA-256.`,
    'Its final message must be exactly one JSON object with only these keys and values: ' +
      '{"schemaVersion":"codex-conformance-checker-report.v1","result":"PASS",' +
      '"path":"conformance-result.txt","sha256":"<stdout lowercase SHA-256>","bytes":48,' +
      '"readOnly":true,"command":"node conformance-sha256.cjs conformance-result.txt"}.',
    `The checker gets exactly one turn; never message, resume, relaunch, repair, or recheck after its verdict. If either child reports a noncompliant result, finish with failure instead of retrying.`,
    'Run node conformance-check.cjs again and observe GREEN.',
  ]
  if (requirements.cancellationRequired) {
    lines.push(`Spawn exact private role ${requiredRoles['ap-diagnostic-probe']} and interrupt that exact child before it begins a model turn.`)
  }
  lines.push('Finish immediately after reporting RED_TO_GREEN_PASS.')
  return lines.join(' ')
}

function checkCommandResultBound(evidence, expectedExitCode) {
  const result = evidence?.output?.result
  const fullResult = evidence?.request.outputProjection === 'json' &&
    exactObjectKeys(result,
      ['chunk_id', 'wall_time_seconds', 'exit_code', 'original_token_count', 'output']) &&
    typeof result.chunk_id === 'string' && result.chunk_id &&
    typeof result.wall_time_seconds === 'number' && result.wall_time_seconds >= 0 &&
    result.exit_code === expectedExitCode &&
    Number.isSafeInteger(result.original_token_count) && result.original_token_count >= 0 &&
    result.output === ''
  const outputExit = customOutputExitProjectionBound(evidence) && result.output === '' &&
    result.exit_code === expectedExitCode
  return Boolean((fullResult || outputExit) && evidence.item.exit_code === expectedExitCode &&
    evidence.item.stdout === '' && evidence.item.stderr === '')
}

function transcriptExecutionBound(rows, call, command) {
  const matches = (rows || []).filter(row => eventType(row) === 'item.completed' &&
    row?.item?.type === 'command_execution' && transcriptCommandPayload(row.item.command) === command)
  if (matches.length !== 1) return false
  const item = matches[0].item
  return item.exit_code === call.itemCompleted.exit_code &&
    item.status === call.itemCompleted.status &&
    item.aggregated_output === call.itemCompleted.stdout
}

function providerCheckSequenceBound(providerSession, sessions, workerRole, checkerRole, target,
    log, privateSkillPrefix, transcriptRows) {
  const root = providerSession?.rootSessions?.length === 1
    ? providerSession.rootSessions[0] : null
  const rootTurn = root?.turns?.length === 1 ? root.turns[0] : null
  if (!root || !rootTurn || sessions?.result !== 'PASS' ||
      typeof privateSkillPrefix?.command !== 'string' ||
      typeof privateSkillPrefix?.readCommand !== 'string' ||
      typeof privateSkillPrefix?.readOutput !== 'string' ||
      typeof privateSkillPrefix?.readPath !== 'string') {
    return false
  }
  const workerSpawns = root.toolCalls.filter(call => call.name === 'spawn_agent' &&
    call.arguments?.agent_type === workerRole)
  const checkerSpawns = root.toolCalls.filter(call => call.name === 'spawn_agent' &&
    call.arguments?.agent_type === checkerRole)
  if (workerSpawns.length !== 1 || checkerSpawns.length !== 1) return false
  const workerSpawn = workerSpawns[0]
  const checkerSpawn = checkerSpawns[0]
  const checkerWaits = root.toolCalls.filter(call => call.name === 'wait_agent' &&
    exactObjectKeys(call.arguments, ['timeout_ms']) && Number.isSafeInteger(call.arguments.timeout_ms) &&
    call.arguments.timeout_ms > 0 && exactObjectKeys(call.result, ['message', 'timed_out']) &&
    call.result.message === 'Wait completed.' && call.result.timed_out === false &&
    call.timestampMs >= checkerSpawn.resultTimestampMs)
  if (checkerWaits.length !== 1) return false
  const combinedCommands = new Set([privateSkillPrefix.command, DISCOVERY_RED_COMMAND])
  const rootResponseCalls = rootTurn.responseToolCalls || []
  const relevantCalls = rootResponseCalls.filter(call =>
    typeof call.input === 'string' && call.input.includes('conformance-check.cjs'))
  const supportCalls = rootResponseCalls.filter(call => !relevantCalls.includes(call)).map(call => {
    const request = parseCustomExecInput(call.input)
    if (!request || request.workdir !== path.resolve(target)) return null
    const output = customToolOutput(call.rawOutput)
    const skillRead = request.cmd === privateSkillPrefix.readCommand
    const item = commandExecutionItem(call.itemCompleted, request, 'completed',
      skillRead ? privateSkillPrefix.readPath : null)
    if (!item || output.state !== 'COMPLETED' || item.exit_code !== 0 || item.stderr !== '') return null
    const evidence = Object.freeze({ item, output, request })
    if (skillRead &&
        customStdoutProjectionBound(evidence) && item.stdout === privateSkillPrefix.readOutput) {
      return Object.freeze({ call, item, kind: 'skill-read', request })
    }
    if (request.cmd === DISCOVERY_COMMAND &&
        (customStdoutProjectionBound(evidence) || customOutputExitProjectionBound(evidence))) {
      return Object.freeze({ call, item, kind: 'discovery', request })
    }
    if (request.cmd !== 'node conformance-topology-probe.cjs') return null
    const result = output.result
    const fullResult = request.outputProjection === 'json' && exactObjectKeys(result,
      ['chunk_id', 'wall_time_seconds', 'exit_code', 'original_token_count', 'output']) &&
      typeof result.chunk_id === 'string' && result.chunk_id &&
      typeof result.wall_time_seconds === 'number' && result.wall_time_seconds >= 0 &&
      result.exit_code === 0 && Number.isSafeInteger(result.original_token_count) &&
      result.original_token_count >= 0 && result.output === item.stdout
    const outputExit = customOutputExitProjectionBound(evidence) && result.exit_code === 0
    return fullResult || outputExit
      ? Object.freeze({ call, item, kind: 'topology', request }) : null
  })
  if (supportCalls.some(item => !item)) return false
  const classified = relevantCalls.map(call => {
    const request = parseCustomExecInput(call.input)
    if (!request || request.workdir !== path.resolve(target)) return null
    const expectedStatus = combinedCommands.has(request.cmd) ||
      (request.cmd === 'node conformance-check.cjs' && call.itemCompleted?.exit_code === 1)
      ? 'failed' : 'completed'
    const output = customToolOutput(call.rawOutput)
    const item = commandExecutionItem(call.itemCompleted, request, expectedStatus)
    if (!item || output.state !== 'COMPLETED') return null
    const evidence = Object.freeze({ item, output, request })
    if (combinedCommands.has(request.cmd) && customStdoutProjectionBound(evidence) &&
        item.exit_code === 1 && item.stderr === '' && output.result === null) {
      return Object.freeze({ call, item, kind: 'combined-red', request })
    }
    if (request.cmd !== 'node conformance-check.cjs') return null
    if (checkCommandResultBound(evidence, 1)) {
      return Object.freeze({ call, item, kind: 'red', request })
    }
    if (checkCommandResultBound(evidence, 0)) {
      return Object.freeze({ call, item, kind: 'green', request })
    }
    return null
  })
  if (classified.some(item => !item) || classified.length !== log.length) return false
  const discoveryCalls = [
    ...supportCalls.filter(item => item.kind === 'discovery'),
    ...classified.filter(item => item.kind === 'combined-red'),
  ]
  const topologyCalls = supportCalls.filter(item => item.kind === 'topology')
  const skillReads = supportCalls.filter(item => item.kind === 'skill-read')
  if (discoveryCalls.length !== 1 || topologyCalls.length !== 1 ||
      skillReads.length > 1 ||
      !transcriptExecutionBound(transcriptRows, discoveryCalls[0].call,
        discoveryCalls[0].request.cmd) ||
      !transcriptExecutionBound(transcriptRows, topologyCalls[0].call,
        topologyCalls[0].request.cmd) ||
      (skillReads.length === 1 &&
        (!transcriptExecutionBound(transcriptRows, skillReads[0].call,
          skillReads[0].request.cmd) ||
          discoveryCalls[0].kind !== 'discovery' ||
          skillReads[0].call.resultTimestampMs > discoveryCalls[0].call.timestampMs)) ||
      (discoveryCalls[0].kind === 'combined-red' && skillReads.length !== 0)) return false
  const kinds = classified.map(item => item.kind)
  const acceptedKinds = stableJsonV1(kinds) === stableJsonV1(['combined-red', 'green']) ||
    stableJsonV1(kinds) === stableJsonV1(['red', 'green']) ||
    stableJsonV1(kinds) === stableJsonV1(['combined-red', 'red', 'green'])
  if (!acceptedKinds || (log.length === 2 && stableJsonV1(log) !== stableJsonV1(['RED', 'GREEN'])) ||
      (log.length === 3 && stableJsonV1(log) !== stableJsonV1(['RED', 'RED', 'GREEN']))) return false
  const initial = classified.slice(0, -1)
  const green = classified.at(-1)
  const workerWaits = root.toolCalls.filter(call => call.name === 'wait_agent' &&
    call.resultTimestampMs <= checkerSpawn.timestampMs).sort((left, right) =>
    left.resultTimestampMs - right.resultTimestampMs)
  if (workerWaits.length !== 2) return false
  const discovery = discoveryCalls[0]
  const topology = topologyCalls[0]
  const standaloneInitial = initial.find(item => item.kind === 'red')
  return discovery.call.resultTimestampMs <= workerSpawn.timestampMs &&
    (!standaloneInitial || discovery.call.resultTimestampMs <= standaloneInitial.call.timestampMs) &&
    initial.every(item => item.call.resultTimestampMs <= workerSpawn.timestampMs) &&
    workerWaits[1].resultTimestampMs <= topology.call.timestampMs &&
    topology.call.resultTimestampMs <= checkerSpawn.timestampMs &&
    green.call.timestampMs >= checkerWaits[0].resultTimestampMs
}

function inspectMission(providerSession, transcriptText, roles, requirements, token, checkLog, target,
    targetBefore, privateSkillPrefix, transcriptRows) {
  const workerRole = roles['ap-worker']
  const checkerRole = roles['ap-independent-checker']
  const diagnosticRole = roles['ap-diagnostic-probe'] || null
  const resultFile = path.join(target, 'conformance-result.txt')
  const resultText = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : ''
  const resultBytes = Buffer.byteLength(resultText, 'utf8')
  const resultSha256 = sha256(Buffer.from(resultText, 'utf8'))
  const resultAbsentBefore = !Object.prototype.hasOwnProperty.call(targetBefore || {},
    'conformance-result.txt')
  const sessions = typedSessionEvidence(
    providerSession, workerRole, checkerRole, diagnosticRole, resultFile, resultSha256,
    resultBytes, resultAbsentBefore, requirements,
  )
  const log = fs.existsSync(checkLog) ? fs.readFileSync(checkLog, 'utf8').split(/\r?\n/).filter(Boolean) : []
  const checkSequenceBound = providerCheckSequenceBound(providerSession, sessions, workerRole,
    checkerRole, target, log, privateSkillPrefix, transcriptRows)
  return Object.freeze({
    delegation: sessions,
    edit: {
      checkLogSha256: sha256(Buffer.from(log.join('\n'), 'utf8')),
      checkSequence: log,
      result: resultText === `${token}\n` && checkSequenceBound
        ? 'PASS' : 'FAIL',
      resultFileSha256: sha256(Buffer.from(resultText, 'utf8')),
      resultFileBeforeSha256: null,
      workerPatchContentSha256: sessions.patchContentSha256,
      checkerReadCausallyBound: sessions.checkerReadCausallyBound,
    },
  })
}

function evidenceEnvelope(evidence, runtimeIdentityHash, fixtureOnly) {
  if (!HASH_PATTERN.test(runtimeIdentityHash || '')) {
    fail('RUNTIME_IDENTITY_INVALID', 'runtime identity hash must be SHA-256')
  }
  const result = evidence.result === 'PASS' ? 'PASS' : 'FAIL'
  const envelope = {
    schemaVersion: EVIDENCE_SCHEMA,
    result,
    fixtureOnly: fixtureOnly === true,
    runtimeIdentityHash,
    evidence,
  }
  const canonicalJson = stableJsonV1(envelope)
  const fileSha256 = sha256(Buffer.from(canonicalJson, 'utf8'))
  return Object.freeze({
    envelope: Object.freeze(envelope),
    canonicalJson,
    fileSha256,
    activationNonce: base64urlSha256(Buffer.from(canonicalJson, 'utf8')),
  })
}

function writeCanonicalEvidence(file, result) {
  if (!result || typeof result.canonicalJson !== 'string' || !result.canonicalJson) {
    fail('EVIDENCE_CANONICAL_INVALID', 'canonical conformance evidence is unavailable')
  }
  const bytes = Buffer.from(result.canonicalJson, 'utf8')
  writePrivateFile(file, bytes, 0o600)
  if (!fs.readFileSync(file).equals(bytes)) {
    fail('EVIDENCE_CANONICAL_INVALID', 'canonical conformance evidence bytes changed while writing')
  }
  return Object.freeze({
    bytes: bytes.length,
    sha256: sha256(bytes),
    activationNonce: base64urlSha256(bytes),
  })
}

function verifyCanonicalEvidenceFile(file, result) {
  const actual = fs.readFileSync(assertRegularUnlinked(file, 'canonical conformance evidence'))
  const expected = Buffer.from(result.canonicalJson, 'utf8')
  if (!actual.equals(expected)) {
    fail('EVIDENCE_CANONICAL_INVALID', 'canonical conformance evidence file is not exact stable-json-v1')
  }
  return true
}

function dryRunPlan(options = {}) {
  rejectRegistryOverrides(options.environment || process.env)
  return Object.freeze({
    schemaVersion: DRY_RUN_SCHEMA,
    result: 'NOT_RUN',
    fixtureOnly: true,
    maxRealModelProcessInvocations: 1,
    sourceMutation: false,
    productionPrepareCalled: false,
    productionLaunchCalled: false,
    temporaryPaths: ['source', 'artifact', 'codex-home', 'target', 'evidence'],
  })
}

async function runConformance(options = {}) {
  const mode = options.mode || 'dry-run'
  if (mode === 'dry-run') return { plan: dryRunPlan(options) }
  if (!['fake-cli', 'live'].includes(mode)) fail('CONFORMANCE_MODE_INVALID', `unknown mode: ${mode}`)
  const startedAt = (options.now ? options.now() : new Date()).toISOString()
  let layout = null
  let secureAuditRoot = null
  let pendingAuditRoot = null
  let auditOwnerReady = false
  let auditJournal = null
  const launchedPids = []
  let auth = null
  let evidenceResult
  let runtimeIdentityHash = null
  let fixtureOnly = true
  let materialized = null
  let cleanup = { runRootRemoved: false, residualPids: [] }
  let credentialAudit = null
  let secureAudit = null
  let thrownError = null
  let versionRun = null
  let helpRun = null
  let missionRun = null
  let providerSession = null
  let usage = null
  let checkLog = null
  let resultFile = null
  let authBytes = null
  let unsignedInputs = null
  let accountingUnavailableReason = null
  let paidModelLaunchRequested = false
  try {
    if (mode === 'live') {
      const auditBase = path.resolve(options.auditRoot || options.tempRoot || os.tmpdir())
      fs.mkdirSync(auditBase, { recursive: true, mode: 0o700 })
      pendingAuditRoot = fs.mkdtempSync(path.join(auditBase, 'codex-live-secure-audit-'))
      fs.chmodSync(pendingAuditRoot, 0o700)
      if (process.platform === 'win32') ensureWindowsPrivateAcl(pendingAuditRoot)
      secureAuditRoot = pendingAuditRoot
      auditOwnerReady = true
      if (typeof options.auditInitializationHook === 'function') {
        options.auditInitializationHook('AFTER_OWNER_ACL')
      }
      auditJournal = createSecureAuditJournal(secureAuditRoot)
    }
    rejectRegistryOverrides(options.environment || process.env)
    layout = isolatedLayout(options.tempRoot || os.tmpdir())
    if (secureAuditRoot) {
      if (isWithin(layout.runRoot, secureAuditRoot)) {
        fail('TEMP_PATH_ESCAPE', 'secure audit root must remain outside the disposable run root')
      }
      auditJournal.append('initialized', {
        runRootSha256: sha256(path.resolve(layout.runRoot)),
        state: 'PRE_LAUNCH',
      })
    }
    if (typeof options.materializeCandidate === 'function') {
      materialized = await options.materializeCandidate(layout)
    } else {
      await stageTemporaryCandidate(options.sourceRoot || ROOT, layout, options.environment || process.env)
    }
    const manifestPath = path.join(layout.artifact, 'agents', 'manifests', 'codex-runtime.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const providerRegistry = JSON.parse(fs.readFileSync(
      path.join(layout.artifact, 'agents', 'contracts', 'providers.json'), 'utf8',
    ))
    const codexProvider = providerRegistry.providers?.find(provider => provider?.id === 'codex')
    if (!codexProvider) fail('CODEX_PROVIDER_MISSING', 'canonical Codex provider contract is unavailable')
    const missionRequirements = deriveMissionRequirements(codexProvider.capabilities)
    const requiredProviderRoles = resolveRequiredProviderRoles(manifest, missionRequirements)
    const installed = options.installedCandidate || materialized?.installed || installIsolatedPayload(layout)
    const installedProviderRoles = resolveRequiredProviderRoles(installed.manifest, missionRequirements)
    if (stableJsonV1(installedProviderRoles) !== stableJsonV1(requiredProviderRoles)) {
      fail('REQUIRED_PROVIDER_ROLE_INVALID',
        'installed Codex mission roles do not match the canonical manifest')
    }
    if (!fs.existsSync(path.join(layout.codexHome, 'skills', 'autoprompt', 'SKILL.md'))) {
      installOrdinaryDiscoveryShim(layout)
    }
    const ordinaryEnvironment = safeChildEnvironment(
      layout, options.environment || process.env, layout.codexHome,
    )
    const activationEnvironment = safeChildEnvironment(
      layout, options.environment || process.env, layout.activationHome,
    )
    if (mode === 'live') {
      const authPath = options.auth || path.join(
        process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json',
      )
      auth = copyAuthentication(authPath, layout.activationHome)
    }
    const cli = resolveCli({ ...options, mode }, ordinaryEnvironment)
    const cliBytes = fs.readFileSync(cli.resolvedPath)
    versionRun = await runBoundedCommand([...cli.commandPrefix, '--version'], {
      cwd: layout.target, env: ordinaryEnvironment, timeoutMs: 15_000,
    })
    helpRun = await runBoundedCommand([...cli.commandPrefix, '--help'], {
      cwd: layout.target, env: ordinaryEnvironment, timeoutMs: 15_000,
    })
    launchedPids.push(versionRun.childPid, helpRun.childPid)
    const versionText = versionRun.stdout.toString('utf8').trim()
    const expectedCliVersion = parsedCodexCliVersion(versionText)
    if (!expectedCliVersion) {
      fail('PROVIDER_SESSION_INVALID', 'Codex CLI version output is not schema-bindable')
    }
    const before = discoverySnapshot(layout, installed, 'ordinary')
    const duringLocal = discoverySnapshot(layout, installed, 'isolated')
    const discoveryPrivateSkill = privateSkillDiscoveryPrefix(installed)
    const token = `AUTOPROMPT_CONFORMANCE_${crypto.randomBytes(12).toString('hex')}`
    checkLog = path.join(layout.target, 'conformance-check.log')
    writePrivateFile(path.join(layout.target, 'conformance-check.cjs'), [
      "'use strict'",
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      `const expected = ${JSON.stringify(`${token}\n`)}`,
      "const result = path.join(__dirname, 'conformance-result.txt')",
      "const pass = fs.existsSync(result) && fs.readFileSync(result, 'utf8') === expected",
      "fs.appendFileSync(path.join(__dirname, 'conformance-check.log'), pass ? 'GREEN\\n' : 'RED\\n')",
      "process.exitCode = pass ? 0 : 1",
      '',
    ].join('\n'), 0o700)
    writePrivateFile(path.join(layout.target, 'conformance-sha256.cjs'), [
      "'use strict'",
      "const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path')",
      "const file=path.resolve(process.cwd(),process.argv[2])",
      "process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'\\n')",
      '',
    ].join('\n'), 0o700)
    writeDiscoveryProbe(layout, installed)
    writeTopologyProbe(layout, installed)
    const targetBefore = fileSnapshot(layout.target)
    const transcriptGuard = createTranscriptPolicyGuard({
      maximumLaunches: 6, maximumTurns: 6, maximumTokens: MAX_TOTAL_TOKENS,
    })
    const missionCommand = [
      ...cli.commandPrefix, 'exec', '--json', '--strict-config', '--profile', 'autoprompt',
      '--cd', layout.target, '--skip-git-repo-check',
      missionText(token, requiredProviderRoles, missionRequirements),
    ]
    const missionOptions = {
      cwd: layout.target,
      env: activationEnvironment,
      layout,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      stdoutLineGuard: line => transcriptGuard.accept(line),
      policyPollGuard: () => liveProviderLimits(
        transcriptGuard.rows,
        readProviderSessionBundle(layout.activationHome, {
          allowIncompleteLastLine: true, expectedCliVersion,
        }),
        { maximumLaunches: 6, maximumTurns: 6, maximumTokens: MAX_TOTAL_TOKENS },
      ).within,
      onLaunchedPid: pid => launchedPids.push(pid),
    }
    paidModelLaunchRequested = true
    missionRun = mode === 'live'
      ? await (process.platform === 'win32'
          ? runWindowsJobCommand(missionCommand, missionOptions)
          : runPosixGroupCommand(missionCommand, missionOptions))
      : await runBoundedCommand(missionCommand, missionOptions)
    if (!launchedPids.includes(missionRun.childPid)) launchedPids.push(missionRun.childPid)
    const transcriptRows = parseJsonl(missionRun.stdout)
    if (mode === 'live' && missionRun.policyTerminated) {
      const observedProviderSession = readProviderSessionBundle(layout.activationHome, {
        allowIncompleteLastLine: true, expectedCliVersion,
      })
      fail('PROVIDER_POLICY_LIMIT', 'live conformance reached its explicit provider ceiling', {
        observed: liveProviderLimits(transcriptGuard.rows, observedProviderSession, {
          maximumLaunches: 6, maximumTurns: 6, maximumTokens: MAX_TOTAL_TOKENS,
        }),
      })
    }
    const transcriptText = `${missionRun.stdout.toString('utf8')}\n${missionRun.stderr.toString('utf8')}`
    providerSession = readProviderSessionBundle(layout.activationHome, { expectedCliVersion })
    usage = transcriptUsage(transcriptRows, providerSession)
    const mission = inspectMission(providerSession, transcriptText, requiredProviderRoles,
      missionRequirements, token, checkLog, layout.target, targetBefore,
      discoveryPrivateSkill, transcriptRows)
    const providerDiscovery = providerDiscoveryEvidence(
      transcriptRows, manifest.physicalRoles, installed.expectedTopLevelSkillFiles,
      discoveryPrivateSkill, duringLocal.profileSha256,
    )
    const topology = providerTopologyEvidence(transcriptRows)
    const privateSkill = providerPrivateSkillEvidence(
      providerSession, installed, providerDiscovery.result === 'PASS'
        ? providerDiscovery.isolatedDuring?.profileSha256 : null,
    )
    const targetAfter = fileSnapshot(layout.target)
    const changedPaths = snapshotDiff(targetBefore, targetAfter)
    const changedPathsAllowed = stableJsonV1(changedPaths) ===
      stableJsonV1(['conformance-check.log', 'conformance-result.txt'])
    authBytes = auth ? fs.readFileSync(auth.destination) : null
    resultFile = path.join(layout.target, 'conformance-result.txt')
    unsignedInputs = unsignedAuditInputs({
      version: versionRun, help: helpRun, mission: missionRun,
    }, providerSession, checkLog, resultFile)
    let unsignedInputAuditError = null
    try { assertNoCredentialLeak(authBytes, unsignedInputs) } catch (error) {
      unsignedInputAuditError = error
    }
    if (secureAuditRoot) {
      const accounting = writeUnsignedAccounting(secureAuditRoot, {
        deadlineMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        missionRun, usage, inputs: unsignedInputs, modelProcessInvocations: 1,
      }, auditJournal)
      secureAudit = { accounting, raw: null }
    }
    if (unsignedInputAuditError) throw unsignedInputAuditError
    if (secureAuditRoot) {
      secureAudit.raw = preserveUnsignedRawAudit(secureAuditRoot, unsignedInputs, auditJournal)
    }
    credentialAudit = auditRunTree(layout.runRoot, authBytes, [auth?.destination])
    if (auth?.destination) { fs.unlinkSync(auth.destination); auth = { ...auth, destination: null } }
    fs.rmSync(layout.activationHome, { recursive: true, force: true })
    const after = discoverySnapshot(layout, installed, 'ordinary')
    const identity = options.identityProvider
      ? options.identityProvider()
      : deriveArtifactRuntimeIdentity(layout, cli, versionText)
    if (!identity || !HASH_PATTERN.test(identity.runtimeIdentityHash || '')) {
      fail('RUNTIME_IDENTITY_INVALID', 'canonical Codex runtime identity is unavailable')
    }
    const sourceIdentity = options.sourceIdentityProvider
      ? options.sourceIdentityProvider()
      : options.identityProvider
        ? identity
        : deriveCodexRuntimeIdentity({
          runtimeManifestBytes: fs.readFileSync(path.join(layout.source, 'agents', 'manifests', 'codex-runtime.json')),
          providerRegistryBytes: fs.readFileSync(path.join(layout.source, 'agents', 'contracts', 'providers.json')),
          trustedKeyRingBytes: fs.readFileSync(path.join(layout.source, 'agents', 'contracts', 'codex-trusted-public-keys.json')),
          evidenceBytes: fs.readFileSync(path.join(layout.source, 'agents', 'contracts', 'codex-live-conformance-evidence.json')),
          codexConfigureBytes: fs.readFileSync(path.join(layout.source, 'scripts', 'codex-configure.cjs')),
          codexExecutable: {
            realpath: cli.resolvedPath, platform: process.platform, arch: process.arch,
            basename: path.basename(cli.resolvedPath), sha256: sha256(cliBytes), version: versionText,
          },
        })
    const identityExact = sourceIdentity.runtimeIdentityHash === identity.runtimeIdentityHash &&
      sourceIdentity.canonicalJson === identity.canonicalJson
    const providerAdmission = codexProviderAdmissionProjection(codexProvider)
    const providerAdmissionSha256 = codexProviderAdmissionSha256(codexProvider)
    const providerContractCore = providerContractCoreSha256(providerRegistry)
    const registrySupportedCapabilities = Object.entries(codexProvider.capabilities || {})
      .filter(([, status]) => status === 'supported').map(([name]) => name).sort()
    const providerPolicyExact = codexProvider?.implementationStatus === 'verified' &&
      codexProvider?.currentIsolationClass === 'strict' &&
      codexProvider?.defaultAdmission === 'allow-verified-required-capabilities' &&
      codexProvider?.attestationRequired === true && codexProvider?.verificationAttestation === null
    const providerAdmissionExact = providerPolicyExact &&
      providerAdmissionSha256 === FROZEN_PROVIDER_ADMISSION_SHA256 &&
      providerContractCore === FROZEN_PROVIDER_CONTRACT_CORE_SHA256 &&
      identity.identity.providerAdmissionSha256 === providerAdmissionSha256 &&
      identity.identity.providerContractCoreSha256 === providerContractCore
    const allCommands = [versionRun, helpRun, missionRun]
    const residualPids = [...new Set(allCommands.flatMap(result => result.residualPids))]
    const capabilityProofs = scoreCapabilityProofs({
      providerCapabilities: codexProvider.capabilities,
      isolationResult: providerDiscovery.result === 'PASS' && !fs.existsSync(layout.activationHome)
        ? 'PASS' : 'FAIL',
      privateSkillRootResult: privateSkill.result,
      topologyEnforcementResult: topology.result,
      ownershipResult: missionRun.ownership?.result,
      residualPids,
      timedOut: missionRun.timedOut,
      cancellationObserved: mission.delegation.cancellationObserved,
    })
    const provenCapabilities = Object.entries(capabilityProofs)
      .filter(([, result]) => result === 'PASS').map(([name]) => name)
      .filter(name => codexProvider.capabilities?.[name] === 'supported').sort()
    const verifiedCapabilitiesExact = stableJsonV1(provenCapabilities) ===
      stableJsonV1(registrySupportedCapabilities)
    const strictPassed = missionRun.exitCode === 0 && !missionRun.policyTerminated &&
      missionRun.argv.includes('--strict-config') && missionRun.argv.includes('--profile')
    const passed = versionRun.exitCode === 0 && helpRun.exitCode === 0 && strictPassed &&
      missionRun.exitCode === 0 && !missionRun.timedOut && residualPids.length === 0 &&
      usage.accountingComplete && usage.providerLaunchCount <= 6 &&
      usage.providerTurnCount <= 6 && usage.totalTokens <= MAX_TOTAL_TOKENS &&
      before.ambientSurfaceExact && before.privateRoleInventoryExact &&
      duringLocal.ambientSurfaceExact && after.ambientSurfaceExact &&
      stableJsonV1(before) === stableJsonV1(after) && mission.edit.result === 'PASS' &&
      mission.delegation.result === 'PASS' && mission.delegation.sameContextResume &&
      providerDiscovery.result === 'PASS' && topology.result === 'PASS' && changedPathsAllowed && identityExact &&
      providerAdmissionExact && verifiedCapabilitiesExact && provenCapabilities.length > 0 &&
      (mode !== 'live' || auth?.copied === true)
    const endedAt = (options.now ? options.now() : new Date()).toISOString()
    runtimeIdentityHash = identity.runtimeIdentityHash
    fixtureOnly = mode !== 'live'
    evidenceResult = {
      schemaVersion: OBSERVATION_SCHEMA,
      result: passed ? 'PASS' : 'FAIL',
      startedAt,
      endedAt,
      providerId: 'codex',
      canarySchema: 'codex-live-canary.v1',
      canaryResult: passed ? 'PASS' : 'FAIL',
      sourceCandidate: {
        codexConfigureSha256: identity.identity.codexConfigureSha256,
        manifestSha256: sha256(fs.readFileSync(manifestPath)),
        payloadDigest: manifest.payloadDigest,
        payloadGeneration: manifest.payloadGeneration,
        scriptSha256: sha256(fs.readFileSync(__filename)),
        sourceArtifactIdentityExact: identityExact,
      },
      providerAdmission: {
        projection: providerAdmission,
        providerAdmissionSha256,
        providerContractCoreSha256: providerContractCore,
        frozenProviderAdmissionSha256: FROZEN_PROVIDER_ADMISSION_SHA256,
        frozenProviderContractCoreSha256: FROZEN_PROVIDER_CONTRACT_CORE_SHA256,
        preCanaryPolicyExact: providerPolicyExact,
        capabilityProofs,
        registrySupportedCapabilities,
        verifiedCapabilities: provenCapabilities,
        verifiedCapabilitiesExact,
        identityBindingExact: providerAdmissionExact,
      },
      codexExecutable: {
        realpath: cli.resolvedPath,
        platform: process.platform,
        arch: process.arch,
        basename: path.basename(cli.resolvedPath),
        sha256: sha256(cliBytes),
        source: cli.source,
        launcherScriptSha256: cli.launcherScriptSha256,
        version: versionText,
        versionProbe: commandSummary(versionRun),
        helpProbe: commandSummary(helpRun),
      },
      strictProfile: {
        result: strictPassed ? 'PASS' : 'FAIL',
        probe: commandSummary(missionRun),
        profileSha256: providerDiscovery.isolatedDuring?.profileSha256 || null,
      },
      discovery: {
        ...providerDiscovery,
        providerEffectivePrivateSkill: privateSkill,
        localCrossCheck: {
          ordinaryBefore: before,
          isolatedDuring: duringLocal,
          ordinaryAfter: after,
        },
        activationRevoked: !fs.existsSync(layout.activationHome),
      },
      delegation: mission.delegation,
      topology,
      edit: mission.edit,
      changedPathAudit: {
        allowed: ['conformance-check.log', 'conformance-result.txt'],
        before: targetBefore,
        after: targetAfter,
        changed: changedPaths,
        result: changedPathsAllowed ? 'PASS' : 'FAIL',
      },
      transcript: {
        jsonlEventCount: transcriptRows.length,
        stderrBytes: missionRun.stderr.length,
        stderrSha256: sha256(missionRun.stderr),
        stdoutBytes: missionRun.stdout.length,
        stdoutSha256: sha256(missionRun.stdout),
        providerSessionFiles: providerSession.files.map(({ path: sessionPath, bytes, sha256: digest }) => ({
          path: sessionPath, bytes, sha256: digest,
        })),
        unsignedAudit: secureAudit ? {
          accountingSha256: secureAudit.accounting.sha256,
          rawAuditManifestSha256: secureAudit.raw.manifestSha256,
          rawFileCount: secureAudit.raw.fileCount,
        } : null,
      },
      execution: {
        directPathOnly: true,
        explicitDeadlineMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxModelProcessInvocations: 1,
        maxProviderLaunchesOrTurns: 6,
        maxTotalTokens: MAX_TOTAL_TOKENS,
        modelProcessInvocations: 1,
        nonModelProbeInvocations: 2,
        nativeCliInvocations: [
          { classification: 'NON_MODEL_VERSION', argv: versionRun.argv },
          { classification: 'NON_MODEL_HELP', argv: helpRun.argv },
          { classification: 'PAID_MODEL_ROOT', argv: missionRun.argv },
        ],
        mission: commandSummary(missionRun),
        launchedPids,
        usage,
        processOwnership: missionRun.ownership || { result: 'NOT_EXERCISED_IN_FIXTURE' },
      },
      authentication: {
        copiedToTemporaryCodexHome: auth?.copied === true,
        excludedFromEvidence: true,
        leakDetected: false,
        ownerOnly: auth?.ownerOnly === true,
        runTreeAudit: credentialAudit,
      },
      termination: {
        result: !missionRun.timedOut && !missionRun.policyTerminated &&
          residualPids.length === 0 && (!missionRequirements.cancellationRequired ||
            mission.delegation.cancellationObserved) ? 'PASS' : 'FAIL',
        timedOut: missionRun.timedOut,
        treeKillAttempted: missionRun.killAttempted,
        residualPids,
      },
    }
  } catch (error) {
    thrownError = error
  } finally {
    if (secureAuditRoot && !secureAudit?.accounting) {
      try {
        if (!providerSession && paidModelLaunchRequested && layout) {
          try {
            const finalVersionText = versionRun?.stdout?.toString('utf8').trim()
            providerSession = readProviderSessionBundle(layout.activationHome, {
              expectedCliVersion: parsedCodexCliVersion(finalVersionText),
            })
          } catch (error) {
            accountingUnavailableReason = `PROVIDER_SESSION_${error.code || 'INVALID'}`
            try {
              providerSession = {
                files: providerSessionRawFiles(readProviderSessionInputs(layout.activationHome)),
              }
            } catch (rawError) {
              accountingUnavailableReason += `_RAW_${rawError.code || 'UNAVAILABLE'}`
            }
          }
        }
        if (!usage && missionRun && providerSession) {
          try {
            usage = transcriptUsage(parseJsonl(missionRun.stdout), providerSession)
          } catch (error) {
            accountingUnavailableReason = `PROVIDER_ACCOUNTING_${error.code || 'INVALID'}`
          }
        }
        if (!unsignedInputs) unsignedInputs = unsignedAuditInputs({
          version: versionRun, help: helpRun, mission: missionRun,
        }, providerSession, checkLog, resultFile)
        if (!authBytes && auth?.destination && fs.existsSync(auth.destination)) {
          authBytes = fs.readFileSync(auth.destination)
        }
        let unsignedInputAuditError = null
        try { assertNoCredentialLeak(authBytes, unsignedInputs) } catch (error) {
          unsignedInputAuditError = error
        }
        const accounting = writeUnsignedAccounting(secureAuditRoot, {
          deadlineMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          missionRun,
          usage,
          inputs: unsignedInputs,
          unavailableReason: accountingUnavailableReason,
          modelProcessInvocations: missionRun ? 1 : paidModelLaunchRequested ? null : 0,
        }, auditJournal)
        secureAudit = { accounting, raw: null }
        if (unsignedInputAuditError) throw unsignedInputAuditError
        secureAudit.raw = preserveUnsignedRawAudit(secureAuditRoot, unsignedInputs, auditJournal)
      } catch (auditError) {
        if (!thrownError) thrownError = auditError
        thrownError.details = {
          ...(thrownError.details || {}),
          auditPreparationFailure: sanitizedFailure(auditError),
        }
        try {
          auditJournal.append('audit-preparation-failed', sanitizedFailure(auditError))
        } catch {}
      }
    }
    if (auth?.destination) {
      try { fs.unlinkSync(auth.destination) } catch {}
    }
    const cleanupPersistenceErrors = []
    if (layout) {
      try { fs.rmSync(layout.runRoot, { recursive: true, force: true }) } catch (error) {
        cleanupPersistenceErrors.push(`RUN_ROOT_REMOVE_${error.code || 'FAILED'}`)
      }
    }
    const uniqueLaunchedPids = [...new Set(launchedPids.filter(Number.isSafeInteger))]
    cleanup = {
      runRootRemoved: !layout || !fs.existsSync(layout.runRoot),
      launchedPids: uniqueLaunchedPids,
      residualPids: uniqueLaunchedPids.filter(pidExists),
      persistenceErrors: cleanupPersistenceErrors,
    }
    let cleanupRecord = null
    if (secureAuditRoot) {
      try {
        cleanupRecord = writeSecureAuditCleanup(secureAuditRoot, cleanup, auditJournal)
      } catch (cleanupError) {
        cleanup.persistenceErrors.push(`CLEANUP_RECORD_${cleanupError.code || 'FAILED'}`)
        if (thrownError) thrownError.details = {
          ...(thrownError.details || {}), cleanupPersistenceError: cleanupError.message,
        }
        else thrownError = cleanupError
      }
    }
    if (!cleanup.runRootRemoved || cleanup.residualPids.length) {
      // A returned PASS record never survives a failed final cleanup audit.
      if (evidenceResult) evidenceResult.result = 'FAIL'
      if (mode === 'live' && !thrownError) {
        thrownError = new LiveConformanceError('CONFORMANCE_CLEANUP_FAILED',
          'live conformance cleanup did not remove the run root and every launched process')
      }
    }
    if (secureAuditRoot && thrownError) {
      try {
        const noResult = persistUnsignedNoResult(secureAuditRoot, {
          startedAt,
          endedAt: (options.now ? options.now() : new Date()).toISOString(),
          runtimeIdentityHash,
          error: thrownError,
          accounting: secureAudit?.accounting || null,
          raw: secureAudit?.raw || null,
          missionRun,
          usage,
          accountingReason: accountingUnavailableReason,
          modelProcessInvocations: missionRun ? 1 : paidModelLaunchRequested ? null : 0,
          cleanup,
          cleanupRecord,
        }, auditJournal)
        thrownError.details = {
          ...(thrownError.details || {}),
          secureAuditRoot,
          unsignedAccountingSha256: secureAudit?.accounting?.sha256 || null,
          rawAuditManifestSha256: secureAudit?.raw?.manifestSha256 || null,
          cleanupSha256: cleanupRecord?.sha256 || null,
          unsignedNoResultSha256: noResult.sha256,
        }
      } catch (noResultError) {
        thrownError.details = {
          ...(thrownError.details || {}),
          secureAuditRoot,
          unsignedNoResultPersistenceError: noResultError.message,
        }
      }
    }
    if (pendingAuditRoot && !secureAuditRoot && thrownError) {
      try {
        const bootstrapReceipt = persistBootstrapFailureReceipt(pendingAuditRoot, {
          startedAt,
          endedAt: (options.now ? options.now() : new Date()).toISOString(),
          runtimeIdentityHash: null,
          error: thrownError,
          missionRun: null,
          usage: null,
          accountingReason: 'PAID_MODEL_NOT_LAUNCHED',
          modelProcessInvocations: 0,
          cleanup,
          cleanupRecord: null,
        })
        thrownError.details = {
          ...(thrownError.details || {}),
          secureAuditRoot: pendingAuditRoot,
          bootstrapNoResultSha256: bootstrapReceipt.sha256,
        }
      } catch (receiptError) {
        try { fs.rmSync(pendingAuditRoot, { recursive: true, force: true }) } catch {}
        thrownError.details = {
          ...(thrownError.details || {}),
          bootstrapReceiptPersistenceError: receiptError.message,
        }
      }
    }
  }
  if (thrownError) throw thrownError
  evidenceResult.cleanup = cleanup
  if (!cleanup.runRootRemoved || cleanup.residualPids.length) evidenceResult.result = 'FAIL'
  return evidenceEnvelope(evidenceResult, runtimeIdentityHash, fixtureOnly)
}

async function main(argv = process.argv.slice(2), io = process) {
  try {
    const parsed = parseArguments(argv)
    if (parsed.mode === 'dry-run') {
      io.stdout.write(`${stableJsonV1(dryRunPlan({ environment: process.env }))}\n`)
      return 0
    }
    const result = await runConformance({ ...parsed, sourceRoot: ROOT })
    io.stdout.write(`${result.canonicalJson}\n`)
    return result.envelope.result === 'PASS' ? 0 : 1
  } catch (error) {
    io.stderr.write(cliFailureLine(error))
    return 1
  }
}

function cliFailureLine(error) {
  return `codex-live-conformance: ${error?.code || 'ERROR'} ${error?.message || 'unknown failure'}\n`
}

if (require.main === module) main().then(code => { process.exitCode = code })

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DRY_RUN_SCHEMA,
  EVIDENCE_SCHEMA,
  LiveConformanceError,
  base64urlSha256,
  assertNoCredentialLeak,
  auditRunTree,
  buildUnsignedNoResult,
  cliFailureLine,
  copyAuthentication,
  copyFrozenSource,
  createSecureAuditJournal,
  createTranscriptPolicyGuard,
  deriveMissionRequirements,
  discoverySnapshot,
  dryRunPlan,
  enforceOwnerOnlyWindowsAcl,
  evidenceEnvelope,
  installIsolatedPayload,
  inspectMission,
  isWithin,
  isolatedLayout,
  killProcessTree,
  listFiles,
  liveProviderLimits,
  main,
  missionText,
  normalizeTokenUsage,
  parseArguments,
  persistUnsignedNoResult,
  processTable,
  rejectRegistryOverrides,
  readProviderSessionBundle,
  resolveRequiredProviderRoles,
  privateAgentConfigPath,
  privateSkillDiscoveryPrefix,
  renderIsolatedProfile,
  runBoundedCommand,
  runPosixGroupCommand,
  runConformance,
  runWindowsJobCommand,
  scoreCapabilityProofs,
  sha256,
  stageTemporaryCandidate,
  transcriptUsage,
  verifyCanonicalEvidenceFile,
  writeCanonicalEvidence,
  writeSecureAuditCleanup,
  writeUnsignedAccounting,
  preserveUnsignedRawAudit,
  unsignedAuditInputs,
}
