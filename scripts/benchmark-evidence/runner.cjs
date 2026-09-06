'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const {
  atomicWriteFile,
  canonicalStringify,
  exactKeys,
  fail,
  isoDate,
  sha256,
} = require('./core.cjs')
const { describeEvidenceFile, readVerifiedJson, resolveContained, verifyEvidenceFile } = require('./files.cjs')
const { buildCanaryAttempts, validateRunManifest, validateTaskCatalog } = require('./manifest.cjs')
const { deriveTerminalState, sealAttempt, validateAttemptShape } = require('./aggregate.cjs')
const { deriveCanaryResult, signCanaryControllerRecord } = require('./canary.cjs')
const { validateVerifierAttestation } = require('./authority.cjs')
const { validateResultBundle } = require('./result-bundle.cjs')
const { appendExecutionLedger, loadExecutionLedger } = require('./execution-ledger.cjs')
const { assertRunLease } = require('./run-lease.cjs')
const { loadTrustRegistry, trustedRole } = require('./trust-registry.cjs')
const { parseSessionJsonl } = require('./sessions.cjs')
const { promoteSnapshot, verifySnapshot, walkFiles, writeChecksums } = require('./snapshot.cjs')

const VERIFIER_HOST_ENV_KEYS = Object.freeze(['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'LANG', 'LC_ALL', 'TZ'])
const VERIFIER_INPUT_ENV_KEYS = Object.freeze(['AUTOPROMPT_VERIFIER_KEY_HANDLE', 'AUTOPROMPT_VERIFIER_ISSUER', 'AUTOPROMPT_VERIFIER_KEY_ID'])

function loadTaskCatalog(filename, trustRegistry) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
    fail('TASK_CATALOG_INVALID', `cannot read task catalog: ${filename}`, { cause: error.message })
  }
  validateTaskCatalog(parsed, trustRegistry)
  return parsed
}

function assertManifestResources(manifest, resources) {
  if (canonicalStringify(resources) !== canonicalStringify(manifest.resources)) fail('EVIDENCE_RESOURCE_MISMATCH', 'runner resources differ from the signed manifest')
  return resources
}

function assertAttemptChronology(manifest, attemptId, completed) {
  const completedAttemptIds = Array.isArray(completed) ? completed.map(item => typeof item === 'string' ? item : item.attemptId) : null
  if (!completedAttemptIds || new Set(completedAttemptIds).size !== completedAttemptIds.length) fail('RUNNER_CHRONOLOGY_INVALID', 'durable completed ledger entries must be a unique ordered array')
  const index = manifest.executionOrder.indexOf(attemptId)
  if (index < 0 || canonicalStringify(completedAttemptIds) !== canonicalStringify(manifest.executionOrder.slice(0, index))) {
    fail('RUNNER_CHRONOLOGY_INVALID', 'attempt is not the next member of the signed execution order')
  }
  return index
}

function assertCanaryLaunchReady(manifest, planned, completed) {
  if (!planned || planned.attemptClass !== 'scored') return { ready: true, required: 0 }
  const completedById = new Map(completed.map(entry => [entry.attemptId, entry]))
  const scoredIndex = manifest.executionOrder.indexOf(planned.attemptId)
  const required = buildCanaryAttempts(manifest).filter(canary =>
    manifest.executionOrder.indexOf(canary.attemptId) < scoredIndex)
  const blocked = required.filter(canary => {
    const entry = completedById.get(canary.attemptId)
    return !entry || entry.terminalState !== 'PASS'
  }).map(canary => ({
    attemptId: canary.attemptId,
    terminalState: completedById.get(canary.attemptId)?.terminalState || 'MISSING',
  }))
  if (blocked.length) fail('CANARY_LAUNCH_BLOCKED', 'scored execution requires every preceding canary process and observation to pass', { blocked })
  return { ready: true, required: required.length }
}

function executionDescriptors(planned) {
  return planned.attemptClass === 'canary'
    ? [planned.execution.input, planned.execution.fixture, planned.execution.environment, planned.execution.toolchain, ...(planned.execution.faultInjector ? [planned.execution.faultInjector.artifact] : [])]
    : [planned.execution.input, planned.execution.environment, planned.execution.toolchain]
}

function verifyExecutionAssets(evidenceRoot, planned) {
  for (const descriptor of executionDescriptors(planned)) verifyEvidenceFile(evidenceRoot, descriptor, 'EVIDENCE_EXECUTION_INVALID')
  const environment = readVerifiedJson(evidenceRoot, planned.execution.environment, 'EVIDENCE_EXECUTION_INVALID')
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.values(environment).some(value => typeof value !== 'string')) fail('EVIDENCE_EXECUTION_INVALID', 'signed execution environment must be a JSON object of strings')
  if (Object.keys(environment).some(key => key.startsWith('AUTOPROMPT_BENCHMARK_') || key.includes('\u0000'))) fail('EVIDENCE_EXECUTION_INVALID', 'signed execution environment cannot override controller bindings')
  return environment
}

function safeAttemptSegment(attemptId) {
  return Buffer.from(attemptId, 'utf8').toString('base64url')
}

function descriptorAtSnapshot(evidenceRoot, snapshotId, insideSnapshot) {
  return describeEvidenceFile(evidenceRoot, `snapshots/${snapshotId}/${insideSnapshot}`)
}

function requireRawHarbor(raw) {
  exactKeys(raw, ['status', 'result', 'reward', 'grader'], 'EVIDENCE_HARBOR_INVALID', 'raw Harbor result')
  if (['status', 'result', 'reward', 'grader'].some(field => !Object.hasOwn(raw, field))) fail('EVIDENCE_HARBOR_INVALID', 'raw Harbor result has missing fields')
  return raw
}

function readRawJson(filename, code, label) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
    fail(code, `${label} is missing or invalid`, { cause: error.message })
  }
}

function collectAttemptEvidence(options) {
  const { manifest, catalog, trustRegistry, evidenceRoot, sourceDir, planned } = options
  validateRunManifest(manifest, { trustRegistry, catalog })
  assertManifestResources(manifest, options.resources)
  const source = path.resolve(sourceDir)
  const root = path.resolve(evidenceRoot)
  let sourceReal
  let rootReal
  try { sourceReal = fs.realpathSync.native(source); rootReal = fs.realpathSync.native(root) } catch (error) {
    fail('EVIDENCE_PATH_INVALID', 'collector source or evidence root is unavailable', { cause: error.code })
  }
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`
  if (!sourceReal.startsWith(rootPrefix) || sourceReal === rootReal) fail('EVIDENCE_PATH_INVALID', 'collector source must be a physically contained per-attempt directory')
  if (!fs.statSync(sourceReal).isDirectory()) fail('EVIDENCE_PATH_INVALID', 'collector source is not a directory')
  const rawResources = readRawJson(path.join(sourceReal, 'resources.json'), 'EVIDENCE_RESOURCE_MISMATCH', 'resource consumption evidence')
  assertManifestResources(manifest, rawResources)
  const systemCore = options.system
  exactKeys(systemCore, ['containerState', 'exitCode', 'signal', 'hostKillTriggered', 'cancelled', 'hostKill'], 'EVIDENCE_SYSTEM_INVALID', 'runner system result')
  exactKeys(systemCore.hostKill, ['enforcer', 'deadlineAt', 'triggeredAt'], 'EVIDENCE_HOST_KILL_INVALID', 'runner host kill result')
  atomicWriteFile(path.join(sourceReal, 'system.json'), `${canonicalStringify(systemCore)}\n`)
  atomicWriteFile(path.join(sourceReal, 'host-kill.json'), `${canonicalStringify(systemCore.hostKill)}\n`)
  const harborPath = path.join(sourceReal, 'harbor.json')
  if (!fs.existsSync(harborPath)) fail('EVIDENCE_HARBOR_INVALID', 'attempt did not produce harbor.json')
  const rawHarbor = requireRawHarbor(readRawJson(harborPath, 'EVIDENCE_HARBOR_INVALID', 'Harbor evidence'))
  const sessionsPath = path.join(sourceReal, 'sessions.jsonl')
  const sessions = parseSessionJsonl(fs.readFileSync(sessionsPath), { attemptId: planned.attemptId })
  let rawCanary = null
  if (planned.attemptClass === 'canary') {
    rawCanary = readRawJson(path.join(sourceReal, 'canary.json'), 'CANARY_RESULT_INVALID', 'canary evidence')
    deriveCanaryResult(planned, rawCanary)
  }
  const artifactsPath = path.join(sourceReal, 'artifacts')
  if (!fs.existsSync(artifactsPath)) fs.mkdirSync(artifactsPath, { mode: 0o700 })
  if (!walkFiles(artifactsPath).length) atomicWriteFile(path.join(artifactsPath, 'runner-output.txt'), 'No stdout or stderr was emitted.\n')
  writeChecksums(sourceReal)
  const snapshotId = options.snapshotId
  const observedAt = options.observedAt || new Date().toISOString()
  isoDate(observedAt, 'EVIDENCE_PROVENANCE_INVALID', 'observedAt')
  const promoted = promoteSnapshot({
    sourceDir: sourceReal,
    storeDir: root,
    snapshotId,
    sourceState: 'TERMINAL',
    manifestDigest: manifest.manifestDigest,
    observedAt,
  })
  const snapshot = verifySnapshot(promoted.snapshotPath).manifest
  const systemEvidence = descriptorAtSnapshot(root, snapshotId, 'system.json')
  const hostKillEvidence = descriptorAtSnapshot(root, snapshotId, 'host-kill.json')
  const harborEvidence = descriptorAtSnapshot(root, snapshotId, 'harbor.json')
  const sessionLog = descriptorAtSnapshot(root, snapshotId, 'sessions.jsonl')
  const resourceEvidence = descriptorAtSnapshot(root, snapshotId, 'resources.json')
  const grader = rawHarbor.grader === null ? null : {
    verdict: rawHarbor.grader.verdict,
    score: rawHarbor.grader.score,
    details: descriptorAtSnapshot(root, snapshotId, options.graderDetailsPath || 'grader-details.json'),
  }
  const result = rawHarbor.status === 'completed' && planned.attemptClass === 'scored'
    ? descriptorAtSnapshot(root, snapshotId, options.resultPath || 'result.json')
    : null
  const authority = result ? descriptorAtSnapshot(root, snapshotId, options.authorityPath || 'verifier-attestation.json') : null
  const artifactFiles = walkFiles(path.join(promoted.snapshotPath, 'artifacts'))
  const artifacts = artifactFiles.map(file => descriptorAtSnapshot(root, snapshotId, `artifacts/${file.relative}`))
  const record = sealAttempt({
    schemaVersion: 'benchmark-attempt-evidence.v2',
    manifestDigest: manifest.manifestDigest,
    attempt: { ...planned },
    resources: { ...manifest.resources, evidence: resourceEvidence },
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    system: { ...systemCore, hostKill: { ...systemCore.hostKill, evidence: hostKillEvidence }, evidence: systemEvidence },
    harbor: { ...rawHarbor, grader, evidence: harborEvidence },
    result, authority,
    artifacts,
    sessions,
    sessionLog,
    costs: options.costs,
    provenance: {
      kind: 'immutable-snapshot', snapshotId, snapshotDigest: snapshot.digest,
      snapshotRelativePath: `snapshots/${snapshotId}`, observedAt,
    },
    canary: planned.attemptClass === 'canary' ? {
      ...deriveCanaryResult(planned, rawCanary),
      evidence: descriptorAtSnapshot(root, snapshotId, 'canary.json'),
      controllerEvidence: descriptorAtSnapshot(root, snapshotId, 'canary-controller.json'),
    } : null,
  })
  validateAttemptShape(record, manifest, { evidenceRoot: root, trustRegistry })
  return Object.freeze({ record, snapshotPath: promoted.snapshotPath, pointer: promoted.pointer })
}

function killProcessTree(child) {
  if (!child || !Number.isInteger(child.pid)) return
  if (process.platform === 'win32') {
    childProcess.spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

function runChild(command, options) {
  return new Promise((resolve, reject) => {
    const stdout = fs.openSync(options.stdoutPath, 'wx', 0o600)
    let stderr
    try { stderr = fs.openSync(options.stderrPath, 'wx', 0o600) } catch (error) { fs.closeSync(stdout); throw error }
    let child
    try {
      child = childProcess.spawn(command[0], command.slice(1), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) { fs.closeSync(stdout); fs.closeSync(stderr); throw error }
    child.stdout.on('data', chunk => fs.writeSync(stdout, chunk))
    child.stderr.on('data', chunk => fs.writeSync(stderr, chunk))
    let hostKillTriggered = false
    const timer = setTimeout(() => { hostKillTriggered = true; killProcessTree(child) }, options.hostKillMs)
    child.once('error', error => { clearTimeout(timer); try { fs.closeSync(stdout); fs.closeSync(stderr) } catch {}; reject(error) })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      fs.fsyncSync(stdout); fs.fsyncSync(stderr); fs.closeSync(stdout); fs.closeSync(stderr)
      resolve({ exitCode, signal, hostKillTriggered })
    })
  })
}

function copyEvaluatedOutputs(source, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const file of walkFiles(source)) {
    const output = path.join(destination, ...file.relative.split('/'))
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
    fs.copyFileSync(file.filename, output, fs.constants.COPYFILE_EXCL)
  }
}

function buildVerifierEnvironment(options) {
  const supplied = options.verifierEnv || {}
  exactKeys(supplied, VERIFIER_INPUT_ENV_KEYS, 'VERIFIER_ENV_INVALID', 'verifier environment')
  for (const key of VERIFIER_INPUT_ENV_KEYS) if (Object.hasOwn(supplied, key) && (typeof supplied[key] !== 'string' || !supplied[key] || /-----BEGIN [^-]*PRIVATE KEY-----/.test(supplied[key]))) fail('VERIFIER_ENV_INVALID', 'verifier environment may contain only non-secret public identity or key-handle values')
  const host = options.hostEnvironment || process.env
  const environment = {}
  for (const key of VERIFIER_HOST_ENV_KEYS) if (typeof host[key] === 'string') environment[key] = host[key]
  return environment
}

function assertVerifierAdmission(options) {
  if (!Array.isArray(options.verifierCommand) || !options.verifierCommand.length || options.verifierCommand.some(value => typeof value !== 'string' || !value)) {
    fail('VERIFIER_SIGNER_REQUIRED', 'a separate verifier process with a trusted signer is required')
  }
  buildVerifierEnvironment(options)
  const supplied = options.verifierEnv || {}
  if (VERIFIER_INPUT_ENV_KEYS.some(key => !Object.hasOwn(supplied, key))) {
    fail('VERIFIER_SIGNER_REQUIRED', 'the verifier process requires a complete signer identity and key handle')
  }
  const trusted = trustedRole(options.trustRegistry, 'verifier')
  if (supplied.AUTOPROMPT_VERIFIER_ISSUER !== trusted.issuer || supplied.AUTOPROMPT_VERIFIER_KEY_ID !== trusted.keyId) {
    fail('VERIFIER_SIGNER_UNTRUSTED', 'the configured verifier signer identity does not match trusted verifier policy')
  }
  return Object.freeze({ issuer: trusted.issuer, keyId: trusted.keyId })
}

async function collectVerifierAuthority(options) {
  assertVerifierAdmission(options)
  const authorityDir = options.authorityDir
  fs.mkdirSync(authorityDir, { recursive: true, mode: 0o700 })
  const result = await runChild(options.verifierCommand, {
    cwd: options.verifierCwd || process.cwd(),
    env: {
      ...buildVerifierEnvironment(options), ...options.verifierEnv,
      AUTOPROMPT_EVALUATED_OUTPUT_DIR: options.childOutputDir,
      AUTOPROMPT_VERIFIER_OUTPUT_DIR: authorityDir,
      AUTOPROMPT_BENCHMARK_MANIFEST_DIGEST: options.manifest.manifestDigest,
      AUTOPROMPT_BENCHMARK_ATTEMPT_ID: options.planned.attemptId,
      AUTOPROMPT_BENCHMARK_TASK_ID: options.planned.taskId,
      AUTOPROMPT_BENCHMARK_RESOURCE_EVIDENCE_PATH: path.join(options.sourceDir, 'resources.json'),
      AUTOPROMPT_BENCHMARK_PRODUCER_NAME: options.manifest.arms.find(arm => arm.armId === options.planned.armId).producer.name,
      AUTOPROMPT_BENCHMARK_PRODUCER_VERSION: options.manifest.arms.find(arm => arm.armId === options.planned.armId).producer.version,
      AUTOPROMPT_BENCHMARK_PRODUCER_BUILD_DIGEST: options.manifest.arms.find(arm => arm.armId === options.planned.armId).producer.buildDigest,
    },
    stdoutPath: path.join(authorityDir, 'verifier-stdout.log'), stderrPath: path.join(authorityDir, 'verifier-stderr.log'),
    hostKillMs: options.manifest.budgets.verifierTimeoutMs,
  })
  if (result.hostKillTriggered || result.exitCode !== 0 || result.signal) fail('VERIFIER_PROCESS_FAILED', 'external verifier process failed or timed out', result)
  const harborPath = path.join(authorityDir, 'harbor.json')
  const detailsPath = path.join(authorityDir, 'grader-details.json')
  const attestationPath = path.join(authorityDir, 'verifier-attestation.json')
  const rawHarborBytes = fs.readFileSync(harborPath)
  const verifierBytes = fs.readFileSync(detailsPath)
  const rawHarbor = requireRawHarbor(readRawJson(harborPath, 'EVIDENCE_HARBOR_INVALID', 'verifier Harbor evidence'))
  if (rawHarbor.status !== 'completed' || !rawHarbor.grader) fail('VERIFIER_ATTESTATION_INVALID', 'external verifier must emit a terminal Harbor result')
  const resourceBytes = fs.readFileSync(path.join(options.sourceDir, 'resources.json'))
  const producer = options.manifest.arms.find(arm => arm.armId === options.planned.armId).producer
  const attestationBytes = fs.readFileSync(attestationPath)
  const attestation = readRawJson(attestationPath, 'VERIFIER_ATTESTATION_INVALID', 'verifier attestation')
  const verified = validateVerifierAttestation(attestation, options.trustRegistry, {
    manifestDigest: options.manifest.manifestDigest, taskId: options.planned.taskId, attemptId: options.planned.attemptId,
    verdict: rawHarbor.result, reward: rawHarbor.reward,
    grader: { verdict: rawHarbor.grader.verdict, score: rawHarbor.grader.score }, producer,
    rawHarborSha256: sha256(rawHarborBytes), verifierSha256: sha256(verifierBytes), resourceEvidenceSha256: sha256(resourceBytes),
  })
  for (const name of ['harbor.json', 'grader-details.json', 'verifier-attestation.json']) fs.copyFileSync(path.join(authorityDir, name), path.join(options.sourceDir, name), fs.constants.COPYFILE_EXCL)
  const bundle = {
    schemaVersion: 'benchmark-result-bundle.v2', manifestDigest: options.manifest.manifestDigest,
    taskId: options.planned.taskId, attemptId: options.planned.attemptId, verdict: rawHarbor.result, reward: rawHarbor.reward,
    grader: { verdict: rawHarbor.grader.verdict, score: rawHarbor.grader.score }, producer,
    rawHarborSha256: sha256(rawHarborBytes), verifierSha256: sha256(verifierBytes), resourceEvidenceSha256: sha256(resourceBytes),
    authorityAttestationSha256: sha256(attestationBytes), authoritySignatureSha256: verified.signatureDigest,
  }
  validateResultBundle(bundle)
  atomicWriteFile(path.join(options.sourceDir, 'result.json'), `${canonicalStringify(bundle)}\n`)
  return rawHarbor
}

async function runLocalAttempt(options) {
  if (!options || !Array.isArray(options.command) || !options.command.length || options.command.some(value => typeof value !== 'string' || !value)) fail('RUNNER_COMMAND_INVALID', 'runner command must be a non-empty argv array')
  validateRunManifest(options.manifest, { trustRegistry: options.trustRegistry, catalog: options.catalog })
  if (!options.leaseRegistryPath || !options.runLease) fail('RUN_LEASE_REQUIRED', 'runner requires a previously consumed single-use run lease')
  assertRunLease(options.leaseRegistryPath, options.runLease, options.manifest)
  assertManifestResources(options.manifest, options.resources)
  const plans = [...options.manifest.plannedAttempts, ...buildCanaryAttempts(options.manifest)]
  const planned = plans.find(item => item.attemptId === options.attemptId)
  if (!planned) fail('EVIDENCE_UNKNOWN', `runner attempt is not preregistered: ${options.attemptId}`)
  if (planned.attemptClass === 'scored') assertVerifierAdmission(options)
  if (!options.executionLedgerPath) fail('EXECUTION_LEDGER_INVALID', 'runner requires a durable execution ledger path')
  const completed = loadExecutionLedger(options.executionLedgerPath, { manifest: options.manifest, trustRegistry: options.trustRegistry, requireComplete: false })
  assertAttemptChronology(options.manifest, planned.attemptId, completed)
  assertCanaryLaunchReady(options.manifest, planned, completed)
  if (canonicalStringify(options.command) !== canonicalStringify(planned.execution.argv)) fail(planned.attemptClass === 'canary' ? 'CANARY_EXECUTION_MISMATCH' : 'SCORED_EXECUTION_MISMATCH', 'evaluated command differs from its signed argv')
  const root = path.resolve(options.evidenceRoot)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const signedEnvironment = verifyExecutionAssets(root, planned)
  const workingRoot = path.join(root, 'working')
  fs.mkdirSync(workingRoot, { recursive: true, mode: 0o700 })
  const sourceDir = path.join(workingRoot, `${safeAttemptSegment(planned.attemptId)}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(sourceDir, { mode: 0o700 })
  const childOutputDir = path.join(root, 'evaluated-output', `${safeAttemptSegment(planned.attemptId)}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(childOutputDir, { recursive: true, mode: 0o700 })
  const childArtifactsDir = path.join(childOutputDir, 'artifacts')
  fs.mkdirSync(childArtifactsDir, { mode: 0o700 })
  const artifactsDir = path.join(sourceDir, 'artifacts')
  fs.mkdirSync(artifactsDir, { mode: 0o700 })
  atomicWriteFile(path.join(sourceDir, 'resources.json'), `${canonicalStringify(options.manifest.resources)}\n`)
  const previousEnd = completed.length ? Date.parse(completed.at(-1).endedAt) : -Infinity
  const nominalStart = Date.parse(options.startedAt || new Date().toISOString())
  const startedAt = new Date(Math.max(nominalStart, previousEnd + 1)).toISOString()
  const deadlineAt = new Date(Date.parse(startedAt) + options.manifest.budgets.hostKillMs).toISOString()
  const env = {
    ...signedEnvironment,
    AUTOPROMPT_EVALUATED_OUTPUT_DIR: childOutputDir,
    AUTOPROMPT_BENCHMARK_ATTEMPT_ID: planned.attemptId,
    AUTOPROMPT_BENCHMARK_TASK_ID: planned.taskId || '',
    AUTOPROMPT_BENCHMARK_MANIFEST_DIGEST: options.manifest.manifestDigest,
    AUTOPROMPT_BENCHMARK_HOST_KILL_DEADLINE: deadlineAt,
    AUTOPROMPT_BENCHMARK_AGENT_TIMEOUT_MS: String(options.manifest.budgets.agentTimeoutMs),
    AUTOPROMPT_BENCHMARK_VERIFIER_TIMEOUT_MS: String(options.manifest.budgets.verifierTimeoutMs),
    AUTOPROMPT_BENCHMARK_MAX_TOKENS: String(options.manifest.budgets.maxTokens),
    AUTOPROMPT_BENCHMARK_INSTANCE_ID: options.manifest.resources.instanceId,
    AUTOPROMPT_BENCHMARK_BUCKET: options.manifest.resources.bucket,
    AUTOPROMPT_BENCHMARK_RUN_ROOT: options.manifest.resources.runRoot,
    AUTOPROMPT_BENCHMARK_CONTAINER_NAMESPACE: options.manifest.resources.containerNamespace,
    AUTOPROMPT_BENCHMARK_TRIAL_PREFIX: options.manifest.resources.trialPrefix,
    AUTOPROMPT_BENCHMARK_INPUT_PATH: verifyEvidenceFile(root, planned.execution.input, 'EVIDENCE_EXECUTION_INVALID').resolved,
    ...(planned.attemptClass === 'canary' ? { AUTOPROMPT_BENCHMARK_FIXTURE_PATH: verifyEvidenceFile(root, planned.execution.fixture, 'EVIDENCE_EXECUTION_INVALID').resolved } : {}),
    AUTOPROMPT_BENCHMARK_PRODUCER_NAME: options.manifest.arms.find(arm => arm.armId === planned.armId).producer.name,
    AUTOPROMPT_BENCHMARK_PRODUCER_VERSION: options.manifest.arms.find(arm => arm.armId === planned.armId).producer.version,
    AUTOPROMPT_BENCHMARK_PRODUCER_BUILD_DIGEST: options.manifest.arms.find(arm => arm.armId === planned.armId).producer.buildDigest,
  }
  if (planned.attemptClass === 'canary' && planned.execution.faultInjector) {
    if (canonicalStringify(options.faultInjectorCommand) !== canonicalStringify(planned.execution.faultInjector.argv)) fail('CANARY_FAULT_INJECTOR_MISMATCH', 'controller fault injector command differs from the signed argv')
    const faultResult = await runChild(options.faultInjectorCommand, {
      cwd: options.controllerCwd || process.cwd(),
      env: { ...process.env, ...options.controllerEnv, AUTOPROMPT_CANARY_FAULT_NAME: planned.execution.faultInjector.name },
      stdoutPath: path.join(artifactsDir, 'fault-injector-stdout.log'), stderrPath: path.join(artifactsDir, 'fault-injector-stderr.log'),
      hostKillMs: options.manifest.budgets.verifierTimeoutMs,
    })
    if (faultResult.hostKillTriggered || faultResult.exitCode !== 0 || faultResult.signal) fail('CANARY_FAULT_INJECTOR_FAILED', 'controller fault injector failed')
  }
  const child = await runChild(options.command, {
    cwd: options.cwd || process.cwd(), env,
    stdoutPath: path.join(childArtifactsDir, 'stdout.log'), stderrPath: path.join(childArtifactsDir, 'stderr.log'),
    hostKillMs: options.manifest.budgets.hostKillMs,
  })
  const nominalEnd = Date.parse(options.endedAt || new Date().toISOString())
  const endedAt = new Date(Math.max(nominalEnd, Date.parse(startedAt) + 1)).toISOString()
  const triggeredAt = child.hostKillTriggered ? deadlineAt : null
  const sessionsPath = path.join(childOutputDir, 'sessions.jsonl')
  if (!fs.existsSync(sessionsPath)) fail('SESSION_LOG_INVALID', 'evaluated child did not emit sessions.jsonl')
  fs.copyFileSync(sessionsPath, path.join(sourceDir, 'sessions.jsonl'), fs.constants.COPYFILE_EXCL)
  copyEvaluatedOutputs(childOutputDir, path.join(artifactsDir, 'evaluated'))
  if (child.hostKillTriggered) {
    atomicWriteFile(path.join(sourceDir, 'harbor.json'), `${canonicalStringify({ status: 'absent', result: null, reward: null, grader: null })}\n`)
  } else if (planned.attemptClass === 'canary') {
    const canaryPath = path.join(childOutputDir, 'canary.json')
    const rawCanaryBytes = fs.readFileSync(canaryPath)
    const rawCanary = readRawJson(canaryPath, 'CANARY_RESULT_INVALID', 'evaluated canary observations')
    deriveCanaryResult(planned, rawCanary)
    atomicWriteFile(path.join(sourceDir, 'canary.json'), rawCanaryBytes)
    const controllerRecord = signCanaryControllerRecord(options.manifest.manifestDigest, planned, { sha256: sha256(rawCanaryBytes) }, endedAt, options.controllerSigner)
    atomicWriteFile(path.join(sourceDir, 'canary-controller.json'), `${canonicalStringify(controllerRecord)}\n`)
    const grader = { verdict: 'pass', score: 1 }
    atomicWriteFile(path.join(sourceDir, 'grader-details.json'), `${canonicalStringify({ controllerCanary: true })}\n`)
    atomicWriteFile(path.join(sourceDir, 'harbor.json'), `${canonicalStringify({ status: 'completed', result: 'pass', reward: 1, grader })}\n`)
  } else {
    const authorityDir = path.join(root, 'controller-authority', `${safeAttemptSegment(planned.attemptId)}-${process.pid}-${Date.now()}`)
    await collectVerifierAuthority({ ...options, planned, sourceDir, childOutputDir, authorityDir })
    copyEvaluatedOutputs(authorityDir, path.join(artifactsDir, 'controller-verifier'))
  }
  const system = {
    containerState: 'exited', exitCode: child.exitCode, signal: child.signal,
    hostKillTriggered: child.hostKillTriggered, cancelled: false,
    hostKill: { enforcer: 'external-process', deadlineAt, triggeredAt },
  }
  const collected = collectAttemptEvidence({
    ...options, planned, sourceDir, startedAt, endedAt, system,
    snapshotId: options.snapshotId || `snapshot-${safeAttemptSegment(planned.attemptId)}-${Date.now()}`,
    observedAt: options.observedAt || endedAt,
  })
  const terminalState = deriveTerminalState(collected.record)
  appendExecutionLedger(options.executionLedgerPath, {
    manifest: options.manifest, trustRegistry: options.trustRegistry, signer: options.controllerSigner,
    attemptId: planned.attemptId, startedAt, endedAt, terminalState, evidenceChecksum: collected.record.checksum,
  })
  return collected
}

async function main(argv) {
  if (argv.length !== 1) fail('RUNNER_CONFIG_INVALID', 'usage: node runner.cjs CONFIG.json')
  const configPath = path.resolve(argv[0])
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (Object.hasOwn(config, 'trustRegistryPath')) fail('RUNNER_CONFIG_INVALID', 'trust registry authority cannot be supplied by the run request')
  const trustRegistryPath = process.env.AUTOPROMPT_BENCHMARK_TRUST_REGISTRY_PATH
  if (!trustRegistryPath || !config.runLeasePath) fail('RUNNER_CONFIG_INVALID', 'host trust registry and runLeasePath are required')
  const trustRegistry = loadTrustRegistry(path.resolve(trustRegistryPath))
  const manifest = JSON.parse(fs.readFileSync(path.resolve(config.manifestPath), 'utf8'))
  const catalog = loadTaskCatalog(path.resolve(config.catalogPath), trustRegistry)
  const runLease = JSON.parse(fs.readFileSync(path.resolve(config.runLeasePath), 'utf8'))
  const controllerPrivateKey = process.env.AUTOPROMPT_BENCHMARK_CONTROLLER_PRIVATE_KEY
  const controllerIssuer = process.env.AUTOPROMPT_BENCHMARK_CONTROLLER_ISSUER
  const controllerKeyId = process.env.AUTOPROMPT_BENCHMARK_CONTROLLER_KEY_ID
  if (!controllerPrivateKey || !controllerIssuer || !controllerKeyId) fail('SIGNATURE_REQUIRED', 'controller signer is required through the controller process environment')
  const result = await runLocalAttempt({ ...config, manifest, catalog, trustRegistry, runLease, controllerSigner: { privateKey: controllerPrivateKey, issuer: controllerIssuer, keyId: controllerKeyId } })
  process.stdout.write(`${canonicalStringify(result.record)}\n`)
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.code || 'RUNNER_FAILED'}: ${error.message}\n`)
  process.exitCode = 1
})

module.exports = {
  assertCanaryLaunchReady,
  assertManifestResources,
  assertAttemptChronology,
  assertVerifierAdmission,
  buildVerifierEnvironment,
  collectAttemptEvidence,
  killProcessTree,
  loadTaskCatalog,
  runLocalAttempt,
}
