#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const packaging = require('./reasonix-package.cjs')
const { ReasonixError, connectionConfig, probeExecutable, readBound, privateDirectory, sha256, writePrivate } = require('../agents/reasonix/workflow/native.js')
const { acquire, release, RootGuard } = require('./install/operation-lock.cjs')
const core = require('../agents/codex/workflow/phase-budget.js')
const { processIdentityForPid } = require('../agents/codex/workflow/mission-lock.js')
const { createRunRecord } = require('../agents/codex/workflow/run-record.js')
const { ReasonixExecAdapter } = require('../agents/reasonix/workflow/transport.js')
const safety = require('./local-only-safety.cjs')
const { verifyAdmission, importedTrustDirectory, runtimeIdentityBody, runtimeIdentity, reviewedLocalPending, awaitingIndependentConformance } = require('../agents/reasonix/workflow/admission.js')
const { selectModelAssignment, validateReceiptBoundRegistry } = require('../agents/codex/workflow/effort-policy.js')

const PROFILE = Object.freeze({
  provider: 'reasonix', contractVersion: '2.0.0', commandSandbox: 'enforce', commandNetwork: false,
  configurationIsolation: 'private-home-and-empty-launch-directory', implicitSkills: false,
  externalTools: false, nestedDispatch: false,
})

function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  writePrivate(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function requestEnvelope(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new ReasonixError('INVALID_INPUT', 'Activation requires exact mission arguments after --')
  }
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, argv }))
  return { argv, bytes: bytes.length, canonicalBase64: bytes.toString('base64'), canonicalJson: bytes.toString('utf8'), encoding: 'utf8-json', sha256: sha256(bytes) }
}

function credentialEnvironment(connection, root, environment) {
  let dotenv = ''
  const file = path.join(root, '.env')
  if (fs.existsSync(file)) dotenv = readBound(file).toString('utf8')
  const values = {}
  for (const provider of connection.providers) {
    const key = provider.api_key_env
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Provider credential environment name is invalid')
    if (typeof environment[key] === 'string' && environment[key]) { values[key] = environment[key]; continue }
    const match = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(dotenv)
    if (match) {
      let value = match[1].trim()
      if (value.startsWith('"')) { try { value = JSON.parse(value) } catch { throw new ReasonixError('PROVIDER_UNSUPPORTED', `Invalid quoted credential: ${key}`) } }
      else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      values[key] = value
    }
  }
  return values
}

function importedAdmission(root) {
  const directory = importedTrustDirectory(root), file = path.join(directory, 'admission.json')
  if (!fs.existsSync(file)) {
    if (fs.existsSync(directory)) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported conformance directory is incomplete')
    return null
  }
  try { new RootGuard(root).assertExisting(directory, 'directory') } catch { throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported conformance directory is not physical and private') }
  let value
  try { value = JSON.parse(readBound(file)) } catch { throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported conformance manifest is unreadable') }
  if (value?.schemaVersion !== 'harness-v2-imported-admission.v1' || value.provider !== 'reasonix' || value.trustDirectory !== directory ||
      !/^[a-f0-9]{64}$/.test(value.conformanceRequestSha256 || '') || !/^[a-f0-9]{64}$/.test(value.requestSha256 || '')) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported conformance manifest is invalid')
  }
  let requestBytes, request
  try { requestBytes = readBound(path.join(directory, 'request.json')); request = JSON.parse(requestBytes) } catch { throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported conformance request is unreadable') }
  if (sha256(requestBytes) !== value.requestSha256 || request?.schemaVersion !== 'harness-v2-admission-request.v1' || request.provider !== 'reasonix' ||
      sha256(JSON.stringify(request)) !== value.conformanceRequestSha256 || !/^[a-f0-9]{64}$/.test(request.runtimeIdentityHash || '') ||
      !request.runtimeIdentityBody || !/^[a-f0-9]{64}$/.test(request.nativeDiagnostic?.sha256 || '') ||
      !/^[a-f0-9]{64}$/.test(request.reviewedLiveConformance?.sha256 || '')) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported conformance request is not bound to its manifest')
  }
  return { trustDirectory: directory, conformanceRequestSha256: value.conformanceRequestSha256 }
}

function reviewedLocalBindingMatches(record, pending) {
  return Boolean(record?.reviewedLocal && pending && record.reviewedLocal.reviewDigest === pending.reviewDigest &&
    record.reviewedLocal.releaseIdentityHash === pending.releaseIdentityHash)
}

function prepareActivation(options = {}) {
  const environment = options.env || process.env
  const root = options.root || packaging.resolveRoot(environment)
  const installed = packaging.verify(root)
  const target = fs.realpathSync.native(options.target || process.cwd())
  if (!fs.statSync(target).isDirectory()) throw new ReasonixError('INVALID_INPUT', 'Mission target must be a directory')
  const request = requestEnvelope(options.missionArgs)
  const executable = probeExecutable({ env: environment, executable: options.executable })
  const localAdmission = importedAdmission(root)
  let admission, reviewedLocal = null
  try { admission = verifyAdmission(installed, executable, localAdmission || {}) }
  catch (error) {
    // An explicit import is authoritative: malformed, expired, or rejected
    // imported evidence must never silently fall back to a bundled record.
    if (localAdmission || !awaitingIndependentConformance(installed)) throw error
    reviewedLocal = reviewedLocalPending(installed, executable, { now: options.now })
    if (!reviewedLocal) throw error
    admission = { runtimeIdentityBody: runtimeIdentityBody(installed, executable), runtimeIdentityHash: runtimeIdentity(installed, executable),
      evidenceSha256: reviewedLocal.reviewDigest, trustSource: { kind: reviewedLocal.mode, reviewDigest: reviewedLocal.reviewDigest } }
  }
  const connection = connectionConfig(path.join(root, 'config.toml'))
  const credentials = credentialEnvironment(connection, root, environment)
  const ttlSeconds = options.ttlSeconds === undefined ? 24 * 60 * 60 : Number(options.ttlSeconds)
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7 * 24 * 60 * 60) {
    throw new ReasonixError('INVALID_INPUT', 'Activation lifetime must be 1 to 604800 seconds')
  }
  const lease = acquire(root, 'activate-reasonix-v2')
  try {
    const activationId = options.resume || options.activationId || `apv2-${crypto.randomBytes(16).toString('hex')}`
    if (!/^apv2-[a-f0-9]{32}$/.test(activationId)) throw new ReasonixError('INVALID_INPUT', 'Invalid activation id')
    const activationRoot = path.join(root, '.autoprompt-private', 'activations', activationId)
    const recordPath = path.join(activationRoot, 'activation.json')
    let record
    if (options.resume) {
      record = JSON.parse(readBound(recordPath))
      if (record.providerId !== 'reasonix' || record.activationId !== activationId || record.target.realpath !== target ||
          record.request.sha256 !== request.sha256 || record.payloadDigest !== installed.payloadDigest ||
          record.executable.sha256 !== executable.sha256 || record.executable.path !== executable.path ||
          JSON.stringify(record.executable.runtimeIdentity) !== JSON.stringify(executable.runtimeIdentity) ||
          JSON.stringify(record.executable.portableRuntimeIdentity) !== JSON.stringify(executable.portableRuntimeIdentity) ||
          (record.status === 'active' && processIdentityForPid(record.ownerPid) !== null) ||
          record.connectionSha256 !== sha256(JSON.stringify(connection)) ||
          Boolean(record.reviewedLocal) !== Boolean(reviewedLocal) ||
          (reviewedLocal && !reviewedLocalBindingMatches(record, reviewedLocal))) {
        throw new ReasonixError('RESUME_MISMATCH', 'Resume must bind the original request, target, payload, model configuration, executable, and reviewed-local release binding after the prior run stops')
      }
      if (Date.parse(record.capability.expiresAt) <= Date.now()) throw new ReasonixError('BUDGET_EXHAUSTED', 'The original run deadline has expired')
      record.capability.generation++
    } else {
      privateDirectory(activationRoot)
      const guard = new RootGuard(root)
      guard.assertExisting(activationRoot, 'directory')
      const profilePath = path.join(activationRoot, 'autoprompt.reasonix.profile.json')
      writePrivate(profilePath, `${JSON.stringify(PROFILE)}\n`)
      const profileSha256 = sha256(readBound(profilePath))
      const proof = { schemaVersion: 1, provider: 'reasonix', nativeExecutable: executable.path, runtimeIdentityBody: admission.runtimeIdentityBody, profilePath, profileSha256, checkerProfilePath: profilePath, checkerProfileSha256: profileSha256, selectedProfile: 'autoprompt', checkerSelectedProfile: 'autoprompt-checker', strictConfig: true, admissionTrust: admission.trustSource }
      const proofPath = path.join(activationRoot, 'enforcement-proof.json')
      writePrivate(proofPath, `${JSON.stringify(proof)}\n`)
      const gitConfig = path.join(activationRoot, 'gitconfig')
      writePrivate(gitConfig, '')
      const ghConfigDir = path.join(activationRoot, 'gh')
      fs.mkdirSync(ghConfigDir, { mode: 0o700 })
      const nonce = crypto.randomBytes(24).toString('hex')
      const run = createRunRecord({
        targetPath: target, providerId: 'reasonix', runId: activationId, readOnly: true, exactTree: true,
        canonicalProviderPrivateRoot: path.join(activationRoot, 'r'), assertStartBoundary: false,
      })
      const darwinRuntimeClosure = process.platform === 'darwin' && fs.existsSync(path.join(root, '.autoprompt-private', 'darwin-runtime', 'darwin-runtime-closure.json'))
        ? require('./darwin-runtime-setup.cjs').bindActivation({ provider: 'reasonix', root, activationRoot }) : null
      const metadataSha256 = sha256(readBound(path.join(run.runPath, 'metadata.json')))
      const modelFile = path.join(root, '.autoprompt-reasonix-models.json')
      const modelSelection = fs.existsSync(modelFile) ? validateSelection(JSON.parse(readBound(modelFile))) : { mode: 'provider-default', selector: 'off', models: [] }
      record = {
        schemaVersion: 2, providerId: 'reasonix', activationId, activationRoot, darwinRuntimeClosure,
        payloadDigest: installed.payloadDigest, payloadGeneration: installed.payloadGeneration,
        createdAt: new Date().toISOString(), request, target: { realpath: target }, executable,
        connectionSha256: sha256(JSON.stringify(connection)), modelSelection,
        contractVersions: { settings: '2.0.0', requestEnvelopeEntry: '2.0.0', outcome: '2.0.0', providerCapabilities: '2.0.0', activationRequest: '1.0.0' },
        capability: { generation: 1, parentSession: `${activationId}:owner`, parentRole: 'deterministic-control-plane', legalChildren: ['run-owner', 'route-analyst'], recordPath, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() },
        providerAttestation: { attestation: { activationNonce: nonce } },
        supervisorRuntime: { runPath: run.runPath, runId: activationId, metadataSha256, targetIdentity: run.targetIdentity, createdAt: new Date().toISOString() },
        supervisorEntry: { promptSha256: sha256(readBound(path.join(installed.bundle, 'agents/reasonix/SKILL.md'))) },
        activationBoundary: { gitConfig, ghConfigDir, payloadManifestSha256: installed.payloadDigest,
          supervisorAdapterSha256: sha256(readBound(path.join(installed.bundle, 'scripts/reasonix-configure.cjs'))),
          enforcementProof: { ...proof, path: proofPath, sha256: sha256(readBound(proofPath)) } },
        ...(reviewedLocal ? { reviewedLocal } : {}),
      }
    }
    record.status = 'active'
    record.ownerPid = process.pid
    record.ownerIdentity = processIdentityForPid(process.pid)
    const attestationBody = { provider: 'reasonix', activationId, generation: record.capability.generation,
      admissionEvidenceSha256: admission.evidenceSha256, executableSha256: executable.sha256, payloadDigest: installed.payloadDigest, requestHash: request.sha256,
      targetIdentity: record.supervisorRuntime.targetIdentity, nonce: record.providerAttestation.attestation.activationNonce,
      ...(record.darwinRuntimeClosure ? { darwinRuntimeClosureSha256: record.darwinRuntimeClosure.sha256 } : {}) }
    record.activationAttestation = { hash: sha256(JSON.stringify(attestationBody)), ...attestationBody }
    atomicJson(recordPath, record)
    return {
      providerId: 'reasonix', verified: true, activationId, runId: activationId, activationRoot, recordPath, record,
      root, installed, connection, executable, requestArgv: request.argv,
      supervisorRuntime: record.supervisorRuntime, modelSelection: record.modelSelection,
      enforcementProof: record.activationBoundary.enforcementProof,
      profilePath: record.activationBoundary.enforcementProof.profilePath,
      checkerProfilePath: record.activationBoundary.enforcementProof.checkerProfilePath,
      activationAttestation: record.activationAttestation, entryPrompt: '$autoprompt',
      credentialEnvironment: credentials,
    }
  } finally { release(lease) }
}

async function runReviewedLocalCanary(activation, options = {}) {
  const pending = activation.record.reviewedLocal
  if (!pending) return null
  // Re-probe immediately before every canary, including a resumed activation.
  // The persisted pending record is only a binding, never permission to reuse
  // a replaced executable or dependency closure.
  const current = probeExecutable({ env: options.env || process.env, executable: activation.executable.path })
  const fresh = reviewedLocalPending(activation.installed, current, { now: options.now })
  if (!fresh || fresh.reviewDigest !== pending.reviewDigest || fresh.releaseIdentityHash !== pending.releaseIdentityHash) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix reviewed-local release binding drifted before canary')
  }
  const canary = await require('./harness-v2-closed-canary.cjs').run({ provider: 'reasonix', activation, pending: fresh,
    executable: current, environment: options.env || process.env, signal: options.signal })
  if (!canary || typeof canary !== 'object' || !/^[A-Za-z0-9_-]{43}$/.test(canary.challenge || '') || !Array.isArray(canary.artifacts)) {
    throw new ReasonixError('LOCAL_CANARY_INVALID', 'Reasonix closed canary result is malformed')
  }
  const verifier = require('./harness-v2-canary.cjs')
  const observations = verifier.verifyObservations(fresh, canary.observations)
  const root = path.join(activation.activationRoot, 'reviewed-local-canary', `generation-${activation.record.capability.generation}`)
  const artifacts = canary.artifacts.map(item => {
    if (!item || typeof item.capability !== 'string' || typeof item.path !== 'string' || !path.resolve(item.path).startsWith(`${root}${path.sep}`) || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) {
      throw new ReasonixError('LOCAL_CANARY_INVALID', 'Reasonix closed canary artifact binding is invalid')
    }
    const bytes = readBound(item.path)
    if (sha256(bytes) !== item.sha256) throw new ReasonixError('LOCAL_CANARY_INVALID', 'Reasonix closed canary artifact drifted')
    let artifact
    try { artifact = JSON.parse(bytes) } catch { throw new ReasonixError('LOCAL_CANARY_INVALID', 'Reasonix closed canary artifact is unreadable') }
    const capability = fresh.capabilityCases[item.capability]
    if (!capability || artifact.schemaVersion !== 'harness-v2-closed-canary-observation.v1' || artifact.capability !== item.capability ||
        artifact.caseSha256 !== capability.sha256 || artifact.testName !== capability.testName || artifact.activationId !== activation.activationId ||
        artifact.generation !== activation.record.capability.generation || artifact.challenge !== canary.challenge ||
        artifact.requestSha256 !== activation.record.request.sha256 || artifact.target !== activation.record.target.realpath ||
        artifact.executableSha256 !== current.sha256 || JSON.stringify(artifact.executableRuntimeIdentity) !== JSON.stringify(current.runtimeIdentity || null) ||
        artifact.connectionSha256 !== activation.record.connectionSha256 || artifact.payloadDigest !== activation.installed.payloadDigest ||
        artifact.enforcementProofSha256 !== activation.enforcementProof.sha256 || artifact.reviewDigest !== fresh.reviewDigest || !/^[a-f0-9]{64}$/.test(artifact.outputSha256 || '')) {
      throw new ReasonixError('LOCAL_CANARY_INVALID', 'Reasonix closed canary artifact does not bind this activation')
    }
    return { capability: item.capability, path: item.path, sha256: item.sha256 }
  })
  if (artifacts.length !== observations.length || new Set(artifacts.map(item => item.capability)).size !== observations.length ||
      observations.some(item => !artifacts.some(artifact => artifact.capability === item.capability))) {
    throw new ReasonixError('LOCAL_CANARY_INVALID', 'Reasonix closed canary artifacts are incomplete')
  }
  activation.record.reviewedLocalCanary = { reviewDigest: fresh.reviewDigest, releaseIdentityHash: fresh.releaseIdentityHash,
    executableSha256: current.sha256, nativeRuntimeIdentity: current.portableRuntimeIdentity,
    observedAt: new Date().toISOString(), challenge: canary.challenge, observations, artifacts }
  atomicJson(activation.recordPath, activation.record)
  return activation.record.reviewedLocalCanary
}

// The activation deadline is an immutable authorization boundary.  Keep the
// timer outside native provider code so a held native response cannot turn an
// expired capability into a still-authorized supervisor.
function armActivationExpiry(activation, cancel, options = {}) {
  const expiresAt = Date.parse(activation?.record?.capability?.expiresAt)
  const timerApi = options.timerApi || { setTimeout, clearTimeout }
  const now = typeof options.wallNowMs === 'function' ? options.wallNowMs : Date.now
  if (!Number.isFinite(expiresAt) || typeof cancel !== 'function' ||
      typeof timerApi.setTimeout !== 'function' || typeof timerApi.clearTimeout !== 'function') {
    throw new ReasonixError('ACTIVATION_INVALID', 'Reasonix activation expiry cancellation binding is invalid')
  }
  const timer = timerApi.setTimeout(() => cancel('activation authorization expired'), Math.max(0, expiresAt - Number(now())))
  return () => timerApi.clearTimeout(timer)
}

async function supervise(options = {}) {
  let activation, runtime, outcome
  let disarmExpiry = () => {}
  const cancellation = new AbortController()
  const cancel = reason => {
    if (cancellation.signal.aborted) return
    cancellation.abort(reason === 'activation authorization expired' ? reason : 'operator signal')
  }
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  try {
    activation = prepareActivation(options)
    disarmExpiry = armActivationExpiry(activation, cancel, options)
    if (cancellation.signal.aborted) throw new ReasonixError('CHILD_CANCELLED', 'Reasonix activation was cancelled during preparation')
    // Pending reviewed-local admission authorizes only this bounded native
    // check. No repository inspection, safety operation, or mission runtime
    // starts until the fresh canary has passed and been persisted.
    await runReviewedLocalCanary(activation, { ...options, signal: cancellation.signal })
    if (cancellation.signal.aborted) throw new ReasonixError('CHILD_CANCELLED', 'Reasonix activation was cancelled during native canary')
    const target = activation.record.target.realpath
    const expectedBranch = childProcess.spawnSync('git', ['-C', target, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const safeOptions = { expectedBranch, configIsolationPath: activation.record.activationBoundary.gitConfig, ghConfigDir: activation.record.activationBoundary.ghConfigDir, enforcementProof: activation.enforcementProof }
    const environment = safety.createSafeChildGitEnvironment(target, options.env || process.env, safeOptions)
    const repair = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'local-only-safety.cjs'), '--repo', target, '--expected-branch', expectedBranch, '--repair', '--enforcement-proof', activation.enforcementProof.path, '--json'], { env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
    if (![0, 3].includes(repair.status)) throw new ReasonixError('LOCAL_BOUNDARY_UNAVAILABLE', 'Could not establish the v2 target boundary', { status: repair.status })
    const nativeRoot = path.join(activation.activationRoot, 'native')
    const context = {
      environment, expectedBranch, ExecutionAdapter: ReasonixExecAdapter,
      executionAdapterOptions: {
        nativeRoot, connection: activation.connection, executableBinding: activation.executable,
        credentialEnvironment: activation.credentialEnvironment,
        rolePrompt: role => {
          if (role === 'ap-run-owner') return readBound(path.join(activation.installed.bundle, 'agents/reasonix/SKILL.md')).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
          if (!/^ap-[a-z0-9-]+$/.test(role)) throw new ReasonixError('ROLE_POLICY_DENIED', 'Invalid Reasonix role')
          return readBound(path.join(activation.installed.bundle, 'agents/reasonix/skills', role, 'SKILL.md')).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
        },
      },
      assignmentResolver: input => resolveAssignment(activation.modelSelection, input),
    }
    const probe = { executable: activation.executable.path, cliVersion: activation.executable.version,
      evidenceHashes: activation.executable.evidenceHashes, eventStreaming: true, toolOutputCapture: true, sameContextContinuation: true }
    const runtimeOptions = core.createDefaultRuntimeOptions({ activation, probe, context })
    runtimeOptions.activationReceipt = activation
    runtime = new core.CodexSupervisorRuntime(runtimeOptions)
    outcome = await core.runAbortOwnedSupervisor(runtime, cancellation.signal)
    return { ...outcome, activationId: activation.activationId, runPath: activation.supervisorRuntime.runPath }
  } finally {
    disarmExpiry()
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
    if (activation) {
      const lease = acquire(activation.root, 'revoke-reasonix-v2')
      try {
        const latest = JSON.parse(readBound(activation.recordPath))
        if (latest.ownerPid !== process.pid || latest.capability?.generation !== activation.record.capability.generation) {
          throw new ReasonixError('RESUME_MISMATCH', 'Reasonix activation ownership changed before revocation')
        }
        latest.status = 'revoked'
        latest.revokedAt = new Date().toISOString()
        latest.outcome = outcome?.outcome || 'FAILED'
        atomicJson(activation.recordPath, latest)
      } finally { release(lease) }
    }
  }
}

function awaitReasonixChild(child, options = {}) {
  const signalSource = options.signalSource || process
  return new Promise((resolve, reject) => {
    let settled = false
    const stop = signal => { if (!settled && child.exitCode === null && child.signalCode === null) { try { child.kill(signal) } catch (error) { if (error.code !== 'ESRCH') rejectOnce(error) } } }
    const cleanup = () => { signalSource.removeListener('SIGINT', onInterrupt); signalSource.removeListener('SIGTERM', onTerminate) }
    const resolveOnce = result => { if (!settled) { settled = true; cleanup(); resolve(result) } }
    const rejectOnce = error => { if (!settled) { settled = true; cleanup(); reject(error) } }
    const onInterrupt = () => stop('SIGINT'), onTerminate = () => stop('SIGTERM')
    signalSource.on('SIGINT', onInterrupt); signalSource.on('SIGTERM', onTerminate)
    child.once('error', rejectOnce)
    child.once('close', (status, signal) => resolveOnce({ status, signal }))
  })
}
function launchActivation(options = {}) {
  const environment = options.env || process.env
  const root = packaging.resolveRoot(environment)
  const installed = packaging.verify(root)
  const activationId = options.resume || `apv2-${crypto.randomBytes(16).toString('hex')}`
  const requestPath = path.join(root, '.autoprompt-private', `launch-${crypto.randomUUID()}.json`)
  writePrivate(requestPath, JSON.stringify({ root, activationId, target: options.target, missionArgs: options.missionArgs, ttlSeconds: options.ttlSeconds, resume: options.resume }))
  const finish = result => {
    const recordPath = path.join(root, '.autoprompt-private', 'activations', activationId, 'activation.json')
    const record = fs.existsSync(recordPath) ? JSON.parse(readBound(recordPath)) : null
    return { status: result.status === null ? 1 : result.status, activationId, revoked: record ? record.status === 'revoked' : true }
  }
  const argv = [path.join(installed.bundle, 'scripts/reasonix-configure.cjs'), '--supervise', requestPath]
  if (options.spawnSync) {
    try {
      const result = options.spawnSync(process.execPath, argv, { env: environment, stdio: options.stdio || 'inherit', shell: false })
      if (result.error) throw result.error
      return finish(result)
    } finally { fs.unlinkSync(requestPath) }
  }
  let child
  try { child = childProcess.spawn(process.execPath, argv, { env: environment, stdio: options.stdio || 'inherit', shell: false }) }
  catch (error) { fs.unlinkSync(requestPath); throw error }
  return awaitReasonixChild(child, { signalSource: options.signalSource }).then(finish).finally(() => fs.unlinkSync(requestPath))
}

function validateSelection(selection) {
  if (!selection || !['provider-default', 'explicit', 'automatic'].includes(selection.mode) ||
      !Array.isArray(selection.models) || selection.models.some(model => !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(model)) ||
      (selection.effort && !['low', 'medium', 'high', 'max'].includes(selection.effort))) throw new ReasonixError('INVALID_INPUT', 'Invalid Reasonix model selection')
  if (selection.mode === 'provider-default' && (selection.models.length || selection.effort)) throw new ReasonixError('INVALID_INPUT', 'Inherited model selection cannot override effort')
  if (selection.mode === 'automatic' || selection.models.length > 1) validateReceiptBoundRegistry(selection.registry)
  return selection
}

function resolveAssignment(selection, input) {
  validateSelection(selection)
  if (selection.mode === 'automatic' || selection.models.length > 1) {
    const entries = validateReceiptBoundRegistry(selection.registry).entries.filter(entry =>
      selection.mode === 'automatic' || selection.models.includes(entry.id || entry.model || entry.name))
    const result = selectModelAssignment({ role: input.logicalRole, difficulty: input.request?.difficulty,
      risk: input.request?.risk, registry: entries, explicitPin: { effort: selection.effort || null },
      requiredCapabilities: input.request?.requiredCapabilities || [], workload: input.request?.workload || {} })
    if (result.effort === 'xhigh') throw new ReasonixError('INVALID_EFFORT', 'Reasonix does not support xhigh; provide a supported explicit effort')
    return result
  }
  return { model: selection.models[0] || null, effort: selection.effort || null,
    source: selection.mode, registryMatched: false, routeIndependent: true }
}

function configure(options = {}) {
  const root = packaging.resolveRoot(options.env)
  packaging.verify(root)
  const selector = options.selector || 'off'
  const models = selector === 'off' || selector === 'auto' ? [] : selector.split(',').map(value => value.trim())
  const registry = options.modelMap ? JSON.parse(readBound(path.resolve(options.modelMap))) : undefined
  if (registry && registry.schemaVersion !== 'reasonix-model-registry.v1') throw new ReasonixError('INVALID_INPUT', 'Expected a Reasonix measured model registry')
  const record = validateSelection({ mode: selector === 'off' ? 'provider-default' : selector === 'auto' ? 'automatic' : 'explicit',
    selector, models, ...(options.effort ? { effort: options.effort } : {}), ...(registry ? { registry } : {}) })
  const lease = acquire(root, 'configure-reasonix-v2')
  try { atomicJson(path.join(root, '.autoprompt-reasonix-models.json'), record) }
  finally { release(lease) }
  return record
}

if (require.main === module) {
  if (process.argv[2] === '--supervise' && process.argv.length === 4) {
    let options
    try { options = JSON.parse(readBound(process.argv[3])) } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2 }
    if (options) supervise({ ...options, env: process.env }).then(result => {
      process.stdout.write(`${JSON.stringify({ outcome: result.outcome, activationId: result.activationId, runPath: result.runPath, finalResponse: result.finalResponse, terminalEnvelope: result.terminalEnvelope })}\n`); process.exitCode = result.outcome === 'DONE' ? 0 : 1
    }).catch(error => { process.stderr.write(`${error.code || 'RUNTIME_FAILURE'}: ${error.message}\n`); process.exitCode = 1 })
  } else { process.stderr.write('Reasonix supervisor requires an explicit activation request.\n'); process.exitCode = 2 }
}

module.exports = { PROFILE, armActivationExpiry, awaitReasonixChild, configure, credentialEnvironment, importedAdmission, launchActivation, prepareActivation, requestEnvelope, resolveAssignment, reviewedLocalBindingMatches, runReviewedLocalCanary, validateSelection, supervise }
