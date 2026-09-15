'use strict'

// Pure reviewed-local admission verifier. It deliberately does not execute a
// model or issue a capability claim: execution belongs to the closed canary
// runner and must supply one structured observation for every capability.
const crypto = require('node:crypto')
const REQUIRED = Object.freeze(['isolation','topologyEnforcement','privateSkillRoot','eventStreaming','toolOutputCapture','stableChildIdentity','sameContextContinuation','cancellation','isolatedChecking','processOwnership','modelRouting'])
const HASH = /^[a-f0-9]{64}$/
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])); return value }
const canonical = value => JSON.stringify(stable(value))
const fail = message => { const error = new Error(message); error.code = 'REVIEWED_LOCAL_REJECTED'; throw error }
const TRUST_EXCLUSIONS = new Set(['scripts/harness-v2-trust/evidence.json', 'scripts/harness-v2-trust/trusted-public-keys.json'])
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()) }
function reviewedRuntimeFiles(installed) {
  if (!installed?.files || Array.isArray(installed.files)) fail('installed receipt is invalid')
  const files = Object.entries(installed.files).filter(([name]) => !TRUST_EXCLUSIONS.has(name)).sort(([a], [b]) => a.localeCompare(b))
  if (!files.length || files.some(([name, digest]) => !/^[A-Za-z0-9@._/-]+$/.test(name) || !HASH.test(digest) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..'))) fail('installed receipt has invalid reviewed runtime files')
  return Object.fromEntries(files)
}
function portableIdentity(provider, installed, executable) {
  const native = executable?.portableRuntimeIdentity
  if (!native || !HASH.test(native.sha256 || '') || !Number.isSafeInteger(native.fileCount) || native.fileCount < 1 ||
      !Number.isSafeInteger(native.packageCount) || native.packageCount < 0 || !HASH.test(installed?.payloadDigest || '') ||
      !HASH.test(executable?.sha256 || '') || typeof executable?.version !== 'string') fail('portable native dependency identity is unavailable')
  if (!exact(native, ['schemaVersion','provider','platform','architecture','files','sha256','fileCount','packageCount']) || native.schemaVersion !== 1 ||
      native.provider !== provider || native.platform !== process.platform || native.architecture !== process.arch || !Array.isArray(native.files) ||
      native.files.length !== native.fileCount || native.files.some(item => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !item[0].length || item[0].startsWith('/') || /[\\:\0-\x1f\x7f]/.test(item[0]) || item[0].split('/').some(part => !part || part === '.' || part === '..') || !HASH.test(item[1])) ||
      new Set(native.files.map(item => item[0])).size !== native.files.length || JSON.stringify(native.files) !== JSON.stringify([...native.files].sort((a,b) => a[0].localeCompare(b[0]))) ||
      native.sha256 !== sha256(JSON.stringify({ schemaVersion:native.schemaVersion, provider:native.provider, platform:native.platform, architecture:native.architecture, files:native.files }))) fail('portable native dependency identity is invalid')
  const launchers = provider === 'hermes' ? native.files.filter(item => /^hermes\/launcher\/[^/]+$/.test(item[0])) : []
  if (provider === 'hermes' && launchers.length !== 1) fail('portable Hermes launcher identity is unavailable')
  const executableReviewSha256 = provider === 'hermes' ? launchers[0][1] : executable.sha256
  const files = reviewedRuntimeFiles(installed)
  return { provider, reviewedRuntimeDigest: sha256(canonical(files)), platform: process.platform, architecture: process.arch,
    executableReviewSha256, executableVersion: executable.version,
    nativeRuntime: { sha256: native.sha256, fileCount: native.fileCount, packageCount: native.packageCount } }
}
function releaseIdentity(provider, installed, executable) { return sha256(canonical(portableIdentity(provider, installed, executable))) }
// A release can carry reviews for several platforms, architectures and native
// versions. Select only the exact portable runtime; verification still checks
// the entire selected record, and duplicate records for that scope fail closed.
function selectReview(records, provider, installed, executable) {
  if (!Array.isArray(records)) fail('reviewed-local release records are invalid')
  const candidates = records.filter(record => record?.provider === provider)
  if (!candidates.length) return null
  const identity = releaseIdentity(provider, installed, executable)
  const matches = candidates.filter(record => record.releaseIdentityHash === identity)
  if (matches.length !== 1) fail('reviewed-local release review for this runtime is missing or ambiguous')
  return matches[0]
}
// A shipped test policy authorizes running the closed native tests, never the
// mission itself. Unlike historical release reviews it makes no assertion about
// a particular provider version or operating system having passed those tests.
// The pending decision binds this installation and native runtime; all eleven
// observations must be established again before each activation can do work.
function selectPolicy(evidence, provider) {
  if (evidence?.localCanaryPolicies === undefined) return null
  if (!Array.isArray(evidence.localCanaryPolicies)) fail('local canary policies are invalid')
  const policies = evidence.localCanaryPolicies.filter(item => item?.provider === provider)
  if (policies.length > 1) fail('local canary policy is ambiguous')
  return policies[0] || null
}
function verifyPolicy(policy, provider, installed, executable) {
  if (!exact(policy, ['schemaVersion', 'provider', 'platforms', 'architectures', 'protocol', 'canaryImplementation', 'capabilityCases']) ||
      policy.schemaVersion !== 'harness-v2-local-canary-policy.v1' || policy.provider !== provider ||
      !Array.isArray(policy.platforms) || !policy.platforms.length || policy.platforms.some(p => !['linux', 'win32', 'darwin'].includes(p)) ||
      !Array.isArray(policy.architectures) || !policy.architectures.length || policy.architectures.some(a => !['x64', 'arm64'].includes(a)) ||
      !policy.capabilityCases || !exact(policy.capabilityCases, REQUIRED)) fail('local canary policy shape is invalid')
  if (!policy.platforms.includes(process.platform) || !policy.architectures.includes(process.arch)) {
    fail(`native ${provider} canary is unavailable on ${process.platform}/${process.arch}; supported test platforms: ${policy.platforms.join(', ')}`)
  }
  const asset = source => {
    if (typeof source !== 'string' || !/^[A-Za-z0-9@._/-]+$/.test(source) || source.startsWith('/') ||
        source.split('/').some(p => !p || p === '.' || p === '..') || !HASH.test(installed?.files?.[source] || '')) fail('local canary asset is not bound to the installed receipt')
    return { source, sha256: installed.files[source] }
  }
  const protocol = asset(policy.protocol), implementation = asset(policy.canaryImplementation)
  const cases = Object.fromEntries(REQUIRED.map(capability => {
    const item = policy.capabilityCases[capability]
    if (!exact(item, ['source', 'testName']) || typeof item.testName !== 'string' || item.testName.length < 12 || /[\r\n\0]/.test(item.testName)) fail('local canary case is invalid')
    return [capability, Object.freeze({ ...asset(item.source), testName: item.testName })]
  }))
  if (new Set(Object.values(cases).map(item => `${item.source}\0${item.testName}`)).size !== REQUIRED.length) fail('local canary cases must be distinct')
  const scope = portableIdentity(provider, installed, executable)
  const dependencies = executable.runtimeIdentity
  if (!dependencies || !HASH.test(dependencies.sha256 || '') || !Number.isSafeInteger(dependencies.fileCount) || dependencies.fileCount < 1 ||
      !Number.isSafeInteger(dependencies.packageCount) || dependencies.packageCount < 0 ||
      (executable.invocation && !HASH.test(executable.invocation.sha256 || ''))) fail('local canary exact native identity is unavailable')
  const binding = { policy, scope, payloadDigest: installed.payloadDigest, nativeRuntimeIdentity: dependencies,
    ...(executable.invocation ? { executableLaunchInvocationSha256: executable.invocation.sha256 } : {}) }
  return Object.freeze({ mode: 'local-canary-pending', provider,
    releaseIdentityHash: sha256(canonical(binding)), reviewDigest: sha256(canonical(binding)),
    // Only the activation's finite deadline grants execution time. A test policy
    // is software, not a time-limited attestation issued by a reviewer.
    expiresAt: '9999-12-31T23:59:59.000Z', capabilityCases: Object.freeze(cases),
    canaryImplementationSha256: implementation.sha256, protocolSha256: protocol.sha256 })
}
function pendingFromEvidence(evidence, provider, installed, executable, now) {
  const policy = selectPolicy(evidence, provider)
  if (policy) return verifyPolicy(policy, provider, installed, executable)
  const review = selectReview(evidence?.reviewedLocalRecords || [], provider, installed, executable)
  return review ? verifyReview(review, provider, installed, executable, now) : null
}
function verifyReview(record, provider, installed, executable, now = Date.now()) {
  if (!exact(record, ['schemaVersion','policy','provider','status','releaseScope','releaseIdentityHash','protocol','canaryImplementation','capabilityCases','liveEvidence','reviewer','issuedAt','expiresAt','reviewDigest']) || record.schemaVersion !== 'harness-v2-reviewed-local-canary.v1' || record.policy !== 'reviewed-local-release-v1' ||
      record.provider !== provider || record.status !== 'reviewed' || !record.reviewer || typeof record.reviewer.issuer !== 'string' ||
      !exact(record.reviewer, ['issuer','reviewId']) || record.reviewer.issuer.length < 3 || typeof record.reviewer.reviewId !== 'string' || record.reviewer.reviewId.length < 8 ||
      !Number.isFinite(Date.parse(record.issuedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.parse(record.issuedAt) || Date.parse(record.expiresAt) <= now ||
      Date.parse(record.issuedAt) > now || !record.releaseScope || typeof record.releaseScope !== 'object' || Array.isArray(record.releaseScope) || !HASH.test(record.releaseIdentityHash || '') ||
      !exact(record.protocol, ['source','sha256']) || !exact(record.canaryImplementation, ['source','sha256']) || !HASH.test(record.protocol.sha256 || '') || !HASH.test(record.canaryImplementation.sha256 || '') || !Array.isArray(record.liveEvidence) || !record.liveEvidence.length ||
      record.liveEvidence.some(item => !exact(item, ['id','sha256']) || typeof item.id !== 'string' || !HASH.test(item.sha256 || '')) || new Set(record.liveEvidence.map(item => item.id)).size !== record.liveEvidence.length ||
      !record.capabilityCases || typeof record.capabilityCases !== 'object' || Array.isArray(record.capabilityCases) ||
      JSON.stringify(Object.keys(record.capabilityCases).sort()) !== JSON.stringify([...REQUIRED].sort()) ||
      Object.values(record.capabilityCases).some(value => !exact(value, ['source','sha256','testName']) || !HASH.test(value.sha256 || '') || typeof value.testName !== 'string' || value.testName.length < 12) || new Set(Object.values(record.capabilityCases).map(value => `${value.source}\0${value.testName}`)).size !== REQUIRED.length || !HASH.test(record.reviewDigest || '')) fail('reviewed-local record shape is invalid')
  const unsigned = { ...record }; delete unsigned.reviewDigest
  if (record.reviewDigest !== sha256(canonical(unsigned))) fail('reviewed-local review digest is invalid')
  const scope = portableIdentity(provider, installed, executable), identity = sha256(canonical(scope))
  if (canonical(record.releaseScope) !== canonical(scope) || record.releaseIdentityHash !== identity) fail('reviewed-local record does not bind this portable runtime')
  for (const item of [record.protocol, record.canaryImplementation, ...Object.values(record.capabilityCases)]) {
    if (!Object.hasOwn(installed.files, item.source) || installed.files[item.source] !== item.sha256) fail('reviewed-local implementation is not bound to this receipt')
  }
  return Object.freeze({ mode: 'reviewed-local-pending', provider, releaseIdentityHash: identity, reviewDigest: record.reviewDigest,
    expiresAt: record.expiresAt, capabilityCases: Object.freeze(Object.fromEntries(Object.entries(record.capabilityCases).map(([key, value]) => [key, Object.freeze({ ...value })]))), canaryImplementationSha256: record.canaryImplementation.sha256,
    protocolSha256: record.protocol.sha256, reviewer: Object.freeze({ ...record.reviewer }) })
}
function verifyObservations(pending, observations) {
  if (!Array.isArray(observations) || observations.length !== REQUIRED.length || new Set(observations.map(item => item?.capability)).size !== REQUIRED.length) fail('local canary observations are incomplete')
  const mapped = Object.fromEntries(observations.map(item => [item?.capability, item]))
  for (const capability of REQUIRED) {
    const item = mapped[capability]
    if (!item || item.status !== 'passed' || !HASH.test(item.caseSha256 || '') || item.caseSha256 !== pending.capabilityCases[capability].sha256 ||
        !HASH.test(item.observationSha256 || '')) fail(`local canary observation is invalid: ${capability}`)
  }
  return Object.freeze(observations.map(item => Object.freeze({ ...item })))
}
// Verify persisted local observations against their entire activation context.
// Callers supply bytes reopened through their private-file boundary. This pure
// function never executes a harness or reads ambient credentials.
function verifyActivationProof({ provider, installed, record, proof, proofSha256, review, policy, artifacts, now = Date.now() }) {
  const pending = policy ? verifyPolicy(policy, provider, installed, record?.executable) : verifyReview(review, provider, installed, record?.executable, now)
  if (record?.providerId !== provider || record?.schemaVersion !== 2 ||
      record.payloadDigest !== installed.payloadDigest || !Number.isSafeInteger(record.capability?.generation) ||
      record.capability.generation < 1 || !Number.isFinite(Date.parse(record.capability.expiresAt)) ||
      Date.parse(record.capability.expiresAt) <= now || !Number.isFinite(Date.parse(record.createdAt)) ||
      !HASH.test(record.request?.sha256 || '') || !HASH.test(record.connectionSha256 || '') ||
      proof?.nativeExecutable !== record.executable?.path ||
      proof.admissionTrust?.kind !== pending.mode ||
      proof.admissionTrust.reviewDigest !== pending.reviewDigest ||
      record.activationBoundary?.enforcementProof?.sha256 !== proofSha256) fail('local canary activation binding is invalid')
  const local = record.reviewedLocalCanary
  if (!local || local.reviewDigest !== pending.reviewDigest || local.releaseIdentityHash !== pending.releaseIdentityHash ||
      local.executableSha256 !== record.executable.sha256 ||
      canonical(local.nativeRuntimeIdentity) !== canonical(record.executable.portableRuntimeIdentity) ||
      !/^[A-Za-z0-9_-]{43}$/.test(local.challenge || '') || !Number.isFinite(Date.parse(local.observedAt)) ||
      Date.parse(local.observedAt) > now || Date.parse(local.observedAt) < Date.parse(record.createdAt) ||
      !Array.isArray(artifacts) || artifacts.length !== REQUIRED.length ||
      new Set(artifacts.map(item => item?.capability)).size !== REQUIRED.length) fail('local canary completion binding is invalid')
  const observations = verifyObservations(pending, local.observations)
  for (const capability of REQUIRED) {
    const artifact = artifacts.find(item => item?.capability === capability)
    const observation = observations.find(item => item.capability === capability)
    const item = pending.capabilityCases[capability]
    if (!artifact || artifact.sha256 !== observation.observationSha256 ||
        sha256(artifact.bytes) !== artifact.sha256) fail('local canary artifact bytes changed')
    let value
    try { value = JSON.parse(artifact.bytes) } catch { fail('local canary artifact is invalid JSON') }
    const expected = { schemaVersion:'harness-v2-closed-canary-observation.v1', capability,
      caseSha256:item.sha256, testName:item.testName, activationId:record.activationId,
      generation:record.capability.generation, challenge:local.challenge, requestSha256:record.request.sha256,
      target:record.target?.realpath, executableSha256:record.executable.sha256,
      executableRuntimeIdentity:record.executable.runtimeIdentity,
      connectionSha256:record.connectionSha256, payloadDigest:installed.payloadDigest,
      enforcementProofSha256:proofSha256, reviewDigest:pending.reviewDigest, outputSha256:value.outputSha256 }
    if (!HASH.test(value.outputSha256 || '') || canonical(value) !== canonical(expected)) fail('local canary artifact context changed')
  }
  return pending
}
module.exports = { REQUIRED, canonical, portableIdentity, releaseIdentity, selectReview, verifyReview, selectPolicy, verifyPolicy, pendingFromEvidence, verifyObservations, verifyActivationProof }
