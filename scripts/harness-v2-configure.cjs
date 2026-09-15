#!/usr/bin/env node
'use strict'

// This controller reuses the reviewed v2 state machine, not the Codex CLI.
// Native transport and independent admission remain provider-specific boundaries.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const packaging = require('./harness-v2-package.cjs')
const native = require('./harness-v2-native.cjs')
const { verifyAdmission, importedTrustDirectory } = require('./harness-v2-admission.cjs')
const localCanary = require('./harness-v2-canary.cjs')
const { acquire, release, RootGuard } = require('./install/operation-lock.cjs')
const { EFFORTS, selectEffort, selectModelAssignment, validateReceiptBoundRegistry } = require('../agents/codex/workflow/effort-policy.js')
const { fail, readBound, sha256, privateDirectory, writePrivate } = native
const ID = /^apv2-[a-f0-9]{32}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
// This applies only to the controller's implicit canonical policy choice. An
// explicit user effort remains a literal native request and is rejected if the
// provider cannot represent it.
const POLICY_NATIVE_EFFORT = Object.freeze({
  deepseek: Object.freeze({ low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' }),
})

function profileFor(provider) {
  native.descriptor(provider)
  return Object.freeze({ provider, contractVersion: '2.0.0', commandSandbox: 'enforce', commandNetwork: false,
    configurationIsolation: 'private-home-and-empty-launch-directory', implicitSkills: false,
    externalTools: false, nestedDispatch: false })
}
function rootFor(options) {
  return packaging.resolveRoot(options.provider, options.root === undefined ? options.env :
    { ...(options.env || process.env), AUTOPROMPT_INSTALL_ROOT: options.root })
}
function atomicJson(root, file, value) {
  const guard = new RootGuard(root)
  privateDirectory(path.dirname(file))
  guard.assertParent(file)
  if (fs.existsSync(file)) guard.assertExisting(file)
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    writePrivate(temporary, `${JSON.stringify(value, null, 2)}\n`)
    guard.assertParent(file)
    fs.renameSync(temporary, file)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(guard.assertExisting(temporary)) }
}
function requestEnvelope(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      !argv.some(arg => arg.trim())) fail('INVALID_INPUT', 'Activation requires exact nonempty request arguments after --')
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, argv }))
  if (bytes.length > 1024 * 1024) fail('INVALID_INPUT', 'Request envelope exceeds one MiB')
  return { argv: [...argv], bytes: bytes.length, canonicalBase64: bytes.toString('base64'),
    canonicalJson: bytes.toString('utf8'), encoding: 'utf8-json', sha256: sha256(bytes) }
}
function validateSelection(selection, provider) {
  native.descriptor(provider)
  if (!selection || !['provider-default', 'explicit', 'automatic'].includes(selection.mode) ||
      !Array.isArray(selection.models) || selection.models.some(model => typeof model !== 'string' || !MODEL.test(model)) ||
      new Set(selection.models).size !== selection.models.length) fail('INVALID_INPUT', 'Invalid native model selection')
  if ((selection.mode === 'provider-default' && (selection.selector !== 'off' || selection.models.length || selection.registry)) ||
      (selection.mode === 'automatic' && (selection.selector !== 'auto' || selection.models.length)) ||
      (selection.mode === 'explicit' && (!selection.models.length || selection.selector !== selection.models.join(',')))) {
    fail('INVALID_INPUT', 'Model selector does not match its mode and exact model list')
  }
  validateAssignmentEffort(provider, selection.effort)
  if (selection.mode === 'automatic' || selection.models.length > 1) validateReceiptBoundRegistry(selection.registry)
  else if (selection.registry) fail('INVALID_INPUT', 'A measured registry is only used by automatic or multi-model selection')
  return selection
}
function validateAssignmentEffort(provider, effort) {
  try { return native.validateEffort(provider, effort) ?? null }
  catch (error) { fail('INVALID_EFFORT', error.message) }
}
function nativePolicyEffort(provider, policyEffort) {
  const effort = POLICY_NATIVE_EFFORT[provider]?.[policyEffort] || policyEffort
  return validateAssignmentEffort(provider, effort)
}
function resolveAssignment(selection, input, provider) {
  validateSelection(selection, provider)
  if (selection.mode === 'automatic' || selection.models.length > 1) {
    const receipt = validateReceiptBoundRegistry(selection.registry)
    const entries = receipt.entries.filter(entry =>
      selection.mode === 'automatic' || selection.models.includes(entry.id || entry.model || entry.name))
    // Model-registry effort evidence uses the canonical policy vocabulary.
    // Native-only values such as DeepSeek's `off` remain valid for a pinned
    // model, but cannot be claimed as an evidence-backed routing constraint.
    const policyEffort = selection.effort === undefined
      ? selectEffort({ role: input.logicalRole, difficulty: input.request?.difficulty, risk: input.request?.risk }).effort
      : selection.effort
    if (!EFFORTS.includes(policyEffort)) {
      fail('INVALID_EFFORT', `Multi-model selection has no receipt-bound effort mapping for ${policyEffort}`)
    }
    // An explicit effort has already passed validateSelection literally. Only
    // an implicit canonical policy value may use the finite mapping below.
    // Route against the native effort, never apply it after selecting a model
    // that only advertised another capability.
    const effort = selection.effort === undefined
      ? nativePolicyEffort(provider, policyEffort)
      : validateAssignmentEffort(provider, policyEffort)
    const result = selectModelAssignment({ role: input.logicalRole, difficulty: input.request?.difficulty,
      risk: input.request?.risk, registry: entries, requiredCapabilities: input.request?.requiredCapabilities || [],
      workload: input.request?.workload || {}, effortPin: effort })
    if (result.effort !== effort) fail('INVALID_EFFORT', 'Model assignment changed the configured native effort')
    // Filtering routing candidates does not create a new economic receipt.
    return { ...result, effort, policyEffort, nativeEffort: effort, registryReceiptSha256: receipt.receiptSha256 }
  }
  return { model: selection.models[0] || null, effort: validateAssignmentEffort(provider, selection.effort), source: selection.mode,
    registryMatched: false, routeIndependent: true }
}
function configure(options = {}) {
  const provider = options.provider, root = rootFor(options)
  packaging.verify(provider, root)
  const raw = options.selector === undefined ? 'off' : options.selector
  if (typeof raw !== 'string' || !raw) fail('INVALID_INPUT', 'Model selector must be nonempty')
  const models = raw === 'off' || raw === 'auto' ? [] : raw.split(',').map(value => value.trim())
  const selector = models.length ? models.join(',') : raw
  const registry = options.modelMap ? JSON.parse(readBound(path.resolve(options.modelMap))) : undefined
  const record = validateSelection({ mode: selector === 'off' ? 'provider-default' : selector === 'auto' ? 'automatic' : 'explicit',
    selector, models, ...(options.effort !== undefined ? { effort: options.effort } : {}), ...(registry ? { registry } : {}) }, provider)
  const lease = acquire(root, `configure-${provider}-v2`)
  try {
    packaging.assertNoResumableActivation(provider, root)
    atomicJson(root, path.join(root, `.autoprompt-${provider}-models.json`), record)
  } finally { release(lease) }
  return record
}
function validateOptions(options) {
  native.descriptor(options.provider)
  const request = requestEnvelope(options.missionArgs)
  const ttlSeconds = options.ttlSeconds === undefined ? 86400 : options.ttlSeconds
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 604800) fail('INVALID_INPUT', 'Activation lifetime must be 1 to 604800 integer seconds')
  for (const id of [options.resume, options.activationId]) if (id !== undefined && id !== '' && !ID.test(id)) fail('INVALID_INPUT', 'Invalid activation id')
  if (options.resume && options.activationId && options.resume !== options.activationId) fail('INVALID_INPUT', 'Conflicting activation and resume ids')
  const requested = options.target === undefined ? process.cwd() : options.target
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) fail('INVALID_INPUT', 'Target must be an absolute directory')
  const target = fs.realpathSync.native(requested)
  if (!fs.statSync(target).isDirectory()) fail('INVALID_INPUT', 'Target must be a directory')
  return { request, ttlSeconds, target }
}
function requireStoppedOwner(record) {
  if (record.status !== 'active') return
  if (!Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1) fail('RESUME_MISMATCH', 'Prior controller ownership is unknown')
  try { process.kill(record.ownerPid, 0) }
  catch (error) { if (error.code === 'ESRCH') return; fail('RESUME_MISMATCH', 'Cannot prove that the prior controller has stopped') }
  fail('RESUME_MISMATCH', 'Prior controller PID is still live or has been reused')
}
function rolePrompt(installed, role) {
  const provider = installed.provider
  const prefix = path.join(installed.bundle, 'agents', provider)
  if (role === 'ap-run-owner') return readBound(path.join(prefix, provider === 'prime' ? 'skills/autoprompt/SKILL.md' : 'SKILL.md')).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
  const projection = JSON.parse(readBound(path.join(prefix, 'native-projection.json')))
  const selected = Object.hasOwn(projection.roles, role) && projection.roles[role]
  if (!selected || selected.activationAllowed !== true || path.isAbsolute(selected.path) ||
      selected.path.includes('\\') || selected.path.split('/').includes('..')) fail('ROLE_POLICY_DENIED', 'Native role is not an activatable v2 profile')
  return readBound(path.join(prefix, selected.path)).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
}
function importedAdmission(root, provider) {
  const directory = importedTrustDirectory(root, provider)
  const manifest = path.join(directory, 'admission.json')
  if (!fs.existsSync(manifest)) {
    // A partially written or removed explicit import is an invalid trust
    // attempt, never a reason to fall back to a bundled pending record.
    if (fs.existsSync(directory)) fail('PROVIDER_UNSUPPORTED', 'Imported conformance directory is incomplete')
    return null
  }
  try { new RootGuard(root).assertExisting(directory, 'directory') } catch { fail('PROVIDER_UNSUPPORTED', 'Imported conformance admission directory is not physical and private') }
  let record
  try { record = JSON.parse(readBound(manifest)) } catch { fail('PROVIDER_UNSUPPORTED', 'Imported conformance admission manifest is unreadable') }
  if (record?.schemaVersion !== 'harness-v2-imported-admission.v1' || record.provider !== provider ||
      record.trustDirectory !== directory || !/^[a-f0-9]{64}$/.test(record.conformanceRequestSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(record.requestSha256 || '')) {
    fail('PROVIDER_UNSUPPORTED', 'Imported conformance admission manifest is invalid')
  }
  const requestPath = path.join(directory, 'request.json')
  let requestBytes, request
  try { requestBytes = readBound(requestPath); request = JSON.parse(requestBytes) } catch { fail('PROVIDER_UNSUPPORTED', 'Imported conformance admission request is unreadable') }
  if (sha256(requestBytes) !== record.requestSha256 || request?.schemaVersion !== 'harness-v2-admission-request.v1' ||
      request.provider !== provider || sha256(JSON.stringify(request)) !== record.conformanceRequestSha256 ||
      !/^[a-f0-9]{64}$/.test(request.runtimeIdentityHash || '') || !request.runtimeIdentityBody ||
      !/^[a-f0-9]{64}$/.test(request.nativeDiagnostic?.sha256 || '') ||
      !/^[a-f0-9]{64}$/.test(request.reviewedLiveConformance?.sha256 || '')) {
    fail('PROVIDER_UNSUPPORTED', 'Imported conformance admission request is not bound to its manifest')
  }
  return { trustDirectory: directory, conformanceRequestSha256: record.conformanceRequestSha256,
    requestSha256: record.requestSha256, manifestSha256: sha256(readBound(manifest)) }
}
function prepareActivation(options = {}) {
  const { request, ttlSeconds, target } = validateOptions(options)
  const provider = options.provider, environment = options.env || process.env, root = rootFor(options)
  const installed = packaging.verify(provider, root)
  const executable = native.probeExecutable({ provider, env: environment, executable: options.executable })
  const blocked = native.descriptor(provider).blockers
  if (blocked.length) fail('PROVIDER_UNSUPPORTED', `${provider} has unresolved native capabilities`, { blockers: [...blocked] })
  const localAdmission = importedAdmission(root, provider)
  let admission, reviewedLocal = null
  try { admission = verifyAdmission(provider, installed, executable, localAdmission || {}) }
  catch (error) {
    // Invalid explicit imports never fall back. Only an absent import may use a
    // release-reviewed pending mode, and that mode still requires a fresh
    // closed canary before any mission work.
    if (localAdmission) throw error
    const shipped = JSON.parse(readBound(path.join(installed.bundle, 'scripts/harness-v2-trust/evidence.json')))
    const ring = JSON.parse(readBound(path.join(installed.bundle, 'scripts/harness-v2-trust/trusted-public-keys.json')))
    if (ring.schemaVersion !== 'harness-v2-trusted-keys.v1' || !Array.isArray(ring.keys) || shipped.schemaVersion !== 'harness-v2-live-conformance.v1' || !Array.isArray(shipped.records) ||
        shipped.records.some(record => record?.provider === provider)) throw error
    reviewedLocal = require('./harness-v2-admission.cjs').reviewedLocalPending(provider, installed, executable, { now: options.now })
    if (!reviewedLocal) throw error
    admission = { runtimeIdentityBody: require('./harness-v2-admission.cjs').runtimeIdentityBody(provider, installed, executable),
      runtimeIdentityHash: require('./harness-v2-admission.cjs').runtimeIdentity(provider, installed, executable), evidenceSha256: reviewedLocal.reviewDigest,
      trustSource: { kind: reviewedLocal.mode, reviewDigest: reviewedLocal.reviewDigest } }
  }
  const connection = native.connectionConfig(provider, root, environment)
  const credentials = native.credentialEnvironment(provider, connection, root, environment)
  const modelFile = path.join(root, `.autoprompt-${provider}-models.json`)
  const modelSelection = fs.existsSync(modelFile) ? validateSelection(JSON.parse(readBound(modelFile)), provider) :
    { mode: 'provider-default', selector: 'off', models: [] }
  const lease = acquire(root, `activate-${provider}-v2`)
  try {
    const activationId = options.resume || options.activationId || `apv2-${crypto.randomBytes(16).toString('hex')}`
    const activationRoot = path.join(root, '.autoprompt-private', 'activations', activationId)
    const recordPath = path.join(activationRoot, 'activation.json')
    const identityPath = path.join(activationRoot, 'identity.json')
    let immutable = { providerId: provider, activationId, target, requestSha256: request.sha256,
      payloadDigest: installed.payloadDigest, executableSha256: executable.sha256, executablePath: executable.path,
      ...(executable.invocation ? { executableLaunchInvocationSha256: executable.invocation.sha256 } : {}),
      nativeRuntimeIdentitySha256: sha256(JSON.stringify(executable.runtimeIdentity)),
      connectionSha256: sha256(JSON.stringify(connection)), modelSelectionSha256: sha256(JSON.stringify(modelSelection)) }
    let record
    if (options.resume) {
      const guard = new RootGuard(root)
      record = JSON.parse(readBound(guard.assertExisting(recordPath)))
      const saved = JSON.parse(readBound(guard.assertExisting(identityPath)))
      if (JSON.stringify(saved.binding) !== JSON.stringify(immutable) || record.identitySha256 !== sha256(JSON.stringify(saved)) ||
          record.providerId !== provider || record.activationId !== activationId || record.request.sha256 !== request.sha256 ||
          record.target.realpath !== target || record.payloadDigest !== installed.payloadDigest ||
          record.connectionSha256 !== immutable.connectionSha256 ||
          record.executable?.path !== executable.path ||
          JSON.stringify(record.executable?.runtimeIdentity) !== JSON.stringify(executable.runtimeIdentity) ||
          JSON.stringify(record.modelSelection) !== JSON.stringify(modelSelection) ||
          !Number.isSafeInteger(record.capability?.generation) || record.capability.generation < 1 ||
          record.capability.generation >= Number.MAX_SAFE_INTEGER || record.capability.expiresAt !== saved.expiresAt ||
          record.outcome === 'DONE' || !['active', 'revoked'].includes(record.status)) fail('RESUME_MISMATCH', 'Resume differs from immutable request, target, runtime, model, or deadline bindings')
      requireStoppedOwner(record)
      if (!(Date.parse(saved.expiresAt) > Date.now())) fail('BUDGET_EXHAUSTED', 'The original activation deadline has expired')
      record.capability.generation++
    } else {
      privateDirectory(path.dirname(activationRoot))
      fs.mkdirSync(activationRoot, { mode: 0o700 })
      const darwinRuntimeClosure = process.platform === 'darwin' && fs.existsSync(path.join(root, '.autoprompt-private', 'darwin-runtime', 'darwin-runtime-closure.json'))
        ? require('./darwin-runtime-setup.cjs').bindActivation({ provider, root, activationRoot }) : null
      if (darwinRuntimeClosure) immutable = { ...immutable, darwinRuntimeClosureSha256: darwinRuntimeClosure.sha256 }
      const createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
      const saved = { binding: immutable, createdAt, expiresAt }
      writePrivate(identityPath, JSON.stringify(saved))
      const profilePath = path.join(activationRoot, `autoprompt.${provider}.profile.json`)
      writePrivate(profilePath, JSON.stringify(profileFor(provider)))
      const profileSha256 = sha256(readBound(profilePath))
      const proof = { schemaVersion: 1, provider, nativeExecutable: executable.path,
        runtimeIdentityBody: admission.runtimeIdentityBody, profilePath, profileSha256,
        checkerProfilePath: profilePath, checkerProfileSha256: profileSha256,
        selectedProfile: 'autoprompt', checkerSelectedProfile: 'autoprompt-checker', strictConfig: true,
        admissionTrust: admission.trustSource }
      const proofPath = path.join(activationRoot, 'enforcement-proof.json')
      writePrivate(proofPath, JSON.stringify(proof))
      const gitConfig = path.join(activationRoot, 'gitconfig'); writePrivate(gitConfig, '')
      const ghConfigDir = path.join(activationRoot, 'gh'); fs.mkdirSync(ghConfigDir, { mode: 0o700 })
      const { createRunRecord } = require('../agents/codex/workflow/run-record.js')
      const run = createRunRecord({ targetPath: target, providerId: provider, runId: activationId, readOnly: true,
        exactTree: true, canonicalProviderPrivateRoot: path.join(activationRoot, 'r'), assertStartBoundary: false })
      record = { schemaVersion: 2, providerId: provider, activationId, activationRoot, identitySha256: sha256(JSON.stringify(saved)), darwinRuntimeClosure,
        payloadDigest: installed.payloadDigest, payloadGeneration: installed.payloadGeneration, createdAt, request,
        target: { realpath: target }, executable, connectionSha256: immutable.connectionSha256, modelSelection,
        contractVersions: { settings: '2.0.0', requestEnvelopeEntry: '2.0.0', outcome: '2.0.0', providerCapabilities: '2.0.0', activationRequest: '1.0.0' },
        capability: { generation: 1, parentSession: `${activationId}:owner`, parentRole: 'deterministic-control-plane',
          legalChildren: ['run-owner', 'route-analyst'], recordPath, expiresAt },
        providerAttestation: { attestation: { activationNonce: crypto.randomBytes(24).toString('hex') } },
        supervisorRuntime: { runPath: run.runPath, runId: activationId,
          metadataSha256: sha256(readBound(path.join(run.runPath, 'metadata.json'))), targetIdentity: run.targetIdentity, createdAt },
        supervisorEntry: { promptSha256: sha256(rolePrompt(installed, 'ap-run-owner')) },
        activationBoundary: { gitConfig, ghConfigDir, payloadManifestSha256: installed.payloadDigest,
          supervisorAdapterSha256: sha256(readBound(path.join(installed.bundle, 'scripts/harness-v2-configure.cjs'))),
          enforcementProof: { ...proof, path: proofPath, sha256: sha256(readBound(proofPath)) } },
        ...(reviewedLocal ? { reviewedLocal } : {}) }
    }
    record.status = 'active'; record.ownerPid = process.pid
    record.ownerIdentity = require('../agents/codex/workflow/mission-lock.js').processIdentityForPid(process.pid)
    const body = { provider, activationId, generation: record.capability.generation,
      admissionEvidenceSha256: admission.evidenceSha256, executableSha256: executable.sha256,
      payloadDigest: installed.payloadDigest, requestHash: request.sha256, targetIdentity: record.supervisorRuntime.targetIdentity,
      nonce: record.providerAttestation.attestation.activationNonce,
      ...(record.darwinRuntimeClosure ? { darwinRuntimeClosureSha256: record.darwinRuntimeClosure.sha256 } : {}) }
    record.activationAttestation = { hash: sha256(JSON.stringify(body)), ...body }
    atomicJson(root, recordPath, record)
    return { providerId: provider, verified: true, activationId, runId: activationId, activationRoot, recordPath, record,
      root, installed, connection, executable, requestArgv: request.argv, supervisorRuntime: record.supervisorRuntime,
      modelSelection, enforcementProof: record.activationBoundary.enforcementProof,
      profilePath: record.activationBoundary.enforcementProof.profilePath,
      checkerProfilePath: record.activationBoundary.enforcementProof.checkerProfilePath,
      activationAttestation: record.activationAttestation, entryPrompt: '$autoprompt', credentialEnvironment: credentials }
  } finally { release(lease) }
}
async function runReviewedLocalCanary(activation, options = {}) {
  const pending = activation.record.reviewedLocal
  if (!pending) return null
  // Re-probe immediately before the closed canary. A replacement binary or
  // dependency tree cannot reuse a preparation-time pending decision.
  const current = native.probeExecutable({ provider: activation.providerId, executable: activation.executable.path,
    env: options.env || process.env })
  const admissionApi = require('./harness-v2-admission.cjs')
  const fresh = admissionApi.reviewedLocalPending(activation.providerId, activation.installed, current, { now: options.now })
  if (!fresh || fresh.reviewDigest !== pending.reviewDigest || fresh.releaseIdentityHash !== pending.releaseIdentityHash) {
    fail('PROVIDER_UNSUPPORTED', 'Reviewed-local release binding drifted before canary')
  }
  const canaryResult = await require('./harness-v2-closed-canary.cjs').run({ provider: activation.providerId, activation, pending: fresh, executable: current,
    environment: options.env || process.env, signal: options.signal })
  if (!canaryResult || typeof canaryResult !== 'object' || !/^[A-Za-z0-9_-]{43}$/.test(canaryResult.challenge || '') || !Array.isArray(canaryResult.artifacts)) {
    fail('LOCAL_CANARY_INVALID', 'Closed canary result is malformed')
  }
  const verified = localCanary.verifyObservations(fresh, canaryResult.observations)
  const expectedCanaryRoot = path.join(activation.activationRoot, 'reviewed-local-canary', `generation-${activation.record.capability.generation}`)
  const artifacts = canaryResult.artifacts.map(item => {
    if (!item || typeof item.path !== 'string' || !path.resolve(item.path).startsWith(`${expectedCanaryRoot}${path.sep}`) || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) fail('LOCAL_CANARY_INVALID', 'Closed canary artifact binding is invalid')
    const bytes = readBound(item.path); if (sha256(bytes) !== item.sha256) fail('LOCAL_CANARY_INVALID', 'Closed canary artifact drifted')
    return { capability:item.capability, path:item.path, sha256:item.sha256 }
  })
  activation.record.reviewedLocalCanary = { reviewDigest: fresh.reviewDigest, releaseIdentityHash: fresh.releaseIdentityHash,
    executableSha256: current.sha256, nativeRuntimeIdentity: current.portableRuntimeIdentity || null,
    observedAt: new Date().toISOString(), challenge: canaryResult.challenge, observations: verified, artifacts }
  atomicJson(activation.root, activation.recordPath, activation.record)
  return activation.record.reviewedLocalCanary
}
function armActivationExpiry(activation, cancel, options = {}) {
  const expiresAt = Date.parse(activation?.record?.capability?.expiresAt)
  const timerApi = options.timerApi || { setTimeout, clearTimeout }
  const now = typeof options.wallNowMs === 'function' ? options.wallNowMs : Date.now
  if (!Number.isFinite(expiresAt) || typeof cancel !== 'function' ||
      typeof timerApi.setTimeout !== 'function' || typeof timerApi.clearTimeout !== 'function') {
    fail('ACTIVATION_INVALID', 'Activation expiry cancellation binding is invalid')
  }
  const timer = timerApi.setTimeout(
    () => cancel('activation authorization expired'),
    Math.max(0, expiresAt - Number(now())),
  )
  return () => timerApi.clearTimeout(timer)
}
async function supervise(options = {}) {
  let activation, runtime, outcome
  let disarmExpiry = () => {}
  const cancellation = new AbortController()
  const cancel = reason => {
    if (cancellation.signal.aborted) return
    cancellation.abort(reason === 'activation authorization expired'
      ? reason : 'operator signal')
  }
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  try {
    activation = prepareActivation(options)
    disarmExpiry = armActivationExpiry(activation, cancel, options)
    if (cancellation.signal.aborted) fail('CHILD_CANCELLED', 'Activation was cancelled during preparation')
    const core = require('../agents/codex/workflow/phase-budget.js')
    const safety = require('./local-only-safety.cjs')
    const target = activation.record.target.realpath
    const branch = cp.spawnSync('git', ['-C', target, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', timeout: 15000 })
    if (branch.error || branch.status !== 0) fail('LOCAL_BOUNDARY_UNAVAILABLE', 'Native v2 execution requires a checked-out branch')
    const expectedBranch = branch.stdout.trim()
    const boundary = activation.record.activationBoundary
    const environment = safety.createSafeChildGitEnvironment(target, options.env || process.env, {
      expectedBranch, configIsolationPath: boundary.gitConfig, ghConfigDir: boundary.ghConfigDir, enforcementProof: activation.enforcementProof })
    // Pending reviewed-local admission is allowed only to execute its private,
    // bounded native canary. It must complete before the mission's
    // admission-dependent safety inspection; no supervisor exists yet.
    await runReviewedLocalCanary(activation, { ...options, signal: cancellation.signal })
    if (cancellation.signal.aborted) fail('CHILD_CANCELLED', 'Activation was cancelled during native canary')
    // Declaration, file integrity and a process lease alone do not enforce a
    // native command sandbox. The safety inspector admits only post-canary
    // mission execution, never the isolated canary workspace.
    const repository = safety.discoverRepository(target)
    let inspected = safety.inspect(repository, expectedBranch, environment, { enforcementProof: activation.enforcementProof })
    if (!inspected.channels?.repositoryGitBarrier?.enforced) {
      safety.repair(repository, expectedBranch, inspected)
      inspected = safety.inspect(repository, expectedBranch, environment, { enforcementProof: activation.enforcementProof })
    }
    if (!inspected.mechanicallyEnforced) fail('NATIVE_EXECUTION_BOUNDARY_UNAVAILABLE',
      'Native filesystem, network and child-execution enforcement is not available for this installed runtime')
    const { HarnessExecAdapter } = require('./harness-v2-transport.cjs')
    const context = { environment, expectedBranch, ExecutionAdapter: HarnessExecAdapter,
      executionAdapterOptions: { provider: options.provider, nativeRoot: path.join(activation.activationRoot, 'native'),
        connection: activation.connection, executableBinding: activation.executable,
        credentialEnvironment: activation.credentialEnvironment, rolePrompt: role => rolePrompt(activation.installed, role) },
      assignmentResolver: input => resolveAssignment(activation.modelSelection, input, options.provider) }
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
      const lease = acquire(activation.root, `revoke-${options.provider}-v2`)
      try {
        const record = JSON.parse(readBound(activation.recordPath))
        if (record.ownerPid !== process.pid || record.capability.generation !== activation.record.capability.generation) fail('RESUME_MISMATCH', 'Activation ownership changed before revocation')
        record.status = 'revoked'; record.revokedAt = new Date().toISOString(); record.outcome = outcome?.outcome || 'FAILED'
        atomicJson(activation.root, activation.recordPath, record)
      } finally { release(lease) }
    }
  }
}
function awaitOwnedSupervisor(child, options = {}) {
  const signalSource = options.signalSource || process
  return new Promise((resolve, reject) => {
    let settled = false
    const stop = signal => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return
      try { child.kill(signal) } catch (error) { if (error.code !== 'ESRCH') rejectOnce(error) }
    }
    const cleanup = () => {
      signalSource.removeListener('SIGINT', onInterrupt)
      signalSource.removeListener('SIGTERM', onTerminate)
    }
    const resolveOnce = result => { if (settled) return; settled = true; cleanup(); resolve(result) }
    const rejectOnce = error => { if (settled) return; settled = true; cleanup(); reject(error) }
    const onInterrupt = () => stop('SIGINT')
    const onTerminate = () => stop('SIGTERM')
    signalSource.on('SIGINT', onInterrupt)
    signalSource.on('SIGTERM', onTerminate)
    child.once('error', rejectOnce)
    child.once('close', (status, signal) => resolveOnce({ status, signal }))
  })
}
function activationResult(root, activationId, result) {
  const recordPath = path.join(root, '.autoprompt-private', 'activations', activationId, 'activation.json')
  const record = fs.existsSync(recordPath) ? JSON.parse(readBound(recordPath)) : null
  return { status: result.status === null || result.signal ? 1 : result.status, activationId, revoked: !record || record.status === 'revoked' }
}
function launchActivation(options = {}) {
  const { request, target, ttlSeconds } = validateOptions(options)
  const provider = options.provider, root = rootFor(options)
  const installed = packaging.verify(provider, root)
  const activationId = options.resume || `apv2-${crypto.randomBytes(16).toString('hex')}`
  const requestPath = path.join(root, '.autoprompt-private', `launch-${crypto.randomUUID()}.json`)
  writePrivate(requestPath, JSON.stringify({ provider, root, activationId, target, missionArgs: request.argv, ttlSeconds, resume: options.resume }))
  try {
    const environment = { ...(options.env || process.env) }
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV']) delete environment[key]
    const argv = [path.join(installed.bundle, 'scripts/harness-v2-configure.cjs'), '--supervise', requestPath]
    if (options.spawnSync) {
      const result = options.spawnSync(process.execPath, argv, { env: environment, stdio: options.stdio || 'inherit', shell: false })
      if (result.error) throw result.error
      return activationResult(root, activationId, result)
    }
    let child
    try { child = cp.spawn(process.execPath, argv, { env: environment, stdio: options.stdio || 'inherit', shell: false }) }
    catch (error) { fs.unlinkSync(new RootGuard(root).assertExisting(requestPath)); throw error }
    return awaitOwnedSupervisor(child, { signalSource: options.signalSource, graceMs: options.terminationGraceMs })
      .then(result => activationResult(root, activationId, result))
      .finally(() => fs.unlinkSync(new RootGuard(root).assertExisting(requestPath)))
  } finally {
    if (options.spawnSync) fs.unlinkSync(new RootGuard(root).assertExisting(requestPath))
  }
}

module.exports = { configure, launchActivation, awaitOwnedSupervisor, supervise, prepareActivation, runReviewedLocalCanary, armActivationExpiry, profileFor, requestEnvelope, importedAdmission,
  validateSelection, validateAssignmentEffort, nativePolicyEffort, resolveAssignment, validateOptions, requireStoppedOwner, rolePrompt }
if (require.main === module) {
  if (process.argv[2] !== '--supervise' || process.argv.length !== 4) {
    process.stderr.write('Native v2 supervisor requires an explicit activation request.\n'); process.exitCode = 2
  } else {
    Promise.resolve().then(() => supervise({ ...JSON.parse(readBound(process.argv[3])), env: process.env })).then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.outcome === 'DONE' ? 0 : 1
    }).catch(error => { process.stderr.write(`${error.code || 'RUNTIME_FAILURE'}: ${error.message}\n`); process.exitCode = 1 })
  }
}
