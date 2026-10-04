'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const configure = require('../../scripts/harness-v2-configure.cjs')
const admission = require('../../scripts/harness-v2-admission.cjs')
const native = require('../../scripts/harness-v2-native.cjs')
const { sealReceiptBoundRegistry } = require('../../agents/codex/workflow/effort-policy.js')
const { attestationSignedPayload } = require('../../agents/codex/workflow/router.js')
const PROVIDERS = ['claude', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'hermes', 'grok']

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-admission-unit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('exact request bytes preserve argv boundaries, Unicode, whitespace and shell metacharacters', () => {
  const argv = ['spaces  preserved\n', '雪', '$(touch never-run)', '--root', 'a b']
  const result = configure.requestEnvelope(argv)
  assert.deepEqual(JSON.parse(Buffer.from(result.canonicalBase64, 'base64')).argv, argv)
  assert.equal(result.bytes, Buffer.byteLength(result.canonicalJson))
  assert.equal(result.sha256, native.sha256(result.canonicalJson))
  assert.notEqual(result.sha256, configure.requestEnvelope([argv.join(' ')]).sha256)
  argv.push('subsequent caller mutation')
  assert.equal(result.argv.length, 5)
})

test('empty, invalid, NUL-bearing or unbounded requests fail before any provider action', () => {
  for (const argv of [undefined, [], [''], ['\n\t'], [null], [3], ['x\0y'], ['x'.repeat(1024 * 1024 + 1)]]) {
    assert.throws(() => configure.requestEnvelope(argv), { code: 'INVALID_INPUT' })
  }
})

test('activation option validation rejects deadline coercion, traversal and conflicting resume ids', t => {
  const root = fixture(t)
  const base = { provider: 'claude', missionArgs: ['repair'], target: root }
  assert.equal(configure.validateOptions(base).target, fs.realpathSync(root))
  assert.equal(configure.validateOptions(base).ttlSeconds, 86400)
  for (const ttlSeconds of ['30', 0, -1, 1.5, 604801, NaN, Infinity, null]) {
    assert.throws(() => configure.validateOptions({ ...base, ttlSeconds }), { code: 'INVALID_INPUT' })
  }
  for (const target of ['relative/path', '', null]) assert.throws(() => configure.validateOptions({ ...base, target }), { code: 'INVALID_INPUT' })
  for (const resume of ['../activation', 'apv2-not-hex', 'a'.repeat(80)]) assert.throws(() => configure.validateOptions({ ...base, resume }), { code: 'INVALID_INPUT' })
  assert.throws(() => configure.validateOptions({ ...base, resume: `apv2-${'a'.repeat(32)}`, activationId: `apv2-${'b'.repeat(32)}` }), { code: 'INVALID_INPUT' })
})

test('resume never adopts a live controller or an unprovable prior owner', () => {
  assert.throws(() => configure.requireStoppedOwner({ status: 'active', ownerPid: process.pid }), { code: 'RESUME_MISMATCH' })
  for (const ownerPid of [undefined, 0, -1, '42', 3.1]) assert.throws(() => configure.requireStoppedOwner({ status: 'active', ownerPid }), { code: 'RESUME_MISMATCH' })
  assert.doesNotThrow(() => configure.requireStoppedOwner({ status: 'revoked', ownerPid: process.pid }))
})

for (const provider of PROVIDERS) {
  test(`${provider}: model inheritance and explicit pins cannot silently change topology or effort`, () => {
    const inherited = { mode: 'provider-default', selector: 'off', models: [] }
    assert.deepEqual(configure.resolveAssignment(inherited, { logicalRole: 'worker' }, provider),
      { model: null, effort: null, source: 'provider-default', registryMatched: false, routeIndependent: true })
    const pinned = { mode: 'explicit', selector: 'provider/model', models: ['provider/model'] }
    assert.deepEqual(configure.resolveAssignment(pinned, { logicalRole: 'worker' }, provider),
      configure.resolveAssignment(pinned, { logicalRole: 'independent-checker' }, provider))
    if (['claude', 'opencode', 'kilo', 'deepseek', 'vscode', 'prime', 'omp', 'hermes', 'grok'].includes(provider)) {
      const efforts = provider === 'hermes' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        : provider === 'grok' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        : provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max']
        : ['opencode', 'kilo'].includes(provider) ? ['low', 'medium', 'high', 'xhigh', 'max']
        : provider === 'deepseek' ? ['off', 'low', 'high', 'max']
          : provider === 'vscode' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
            : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      for (const effort of efforts) {
        const selection = { ...pinned, effort }
        assert.equal(configure.resolveAssignment(selection, { logicalRole: 'worker' }, provider).effort, effort)
        assert.deepEqual(configure.resolveAssignment(selection, { logicalRole: 'worker' }, provider),
          configure.resolveAssignment(selection, { logicalRole: 'independent-checker' }, provider))
      }
      const unsupported = provider === 'hermes' ? ['off']
        : provider === 'grok' ? ['off', 'ultra']
        : provider === 'claude' ? ['off', 'minimal']
        : ['opencode', 'kilo'].includes(provider) ? ['off', 'minimal']
        : provider === 'deepseek' ? ['medium', 'xhigh']
          : provider === 'vscode' ? ['off', 'max'] : []
      for (const effort of [...unsupported, true, 3, '']) {
        assert.throws(() => configure.validateSelection({ ...pinned, effort }, provider), { code: 'INVALID_EFFORT' })
      }
    } else assert.throws(() => configure.validateSelection({ ...pinned, effort: 'high' }, provider), { code: 'INVALID_EFFORT' })
    assert.throws(() => configure.validateSelection({ mode: 'automatic', selector: 'auto', models: [] }, provider), { code: 'MODEL_REGISTRY_RECEIPT_INVALID' })
    for (const invalid of [{ ...inherited, selector: 'auto' }, { ...inherited, models: ['x'] },
      { ...pinned, models: [] }, { ...pinned, models: ['x', 'x'] }, { ...pinned, models: ['x; touch no'] }]) {
      assert.throws(() => configure.validateSelection(invalid, provider), { code: 'INVALID_INPUT' })
    }
  })
}

function measuredRegistry() {
  return sealReceiptBoundRegistry({ schemaVersion: 'codex-model-registry.v1', issuer: 'unit-test-measurement',
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    evidenceSha256: 'e'.repeat(64), entries: [
      { id: 'fixture/low-only', verified: true, efforts: ['low'], capabilities: { toolUse: true },
        price: { perTokens: 1000, noncachedInput: 1, cachedInput: 1, output: 1 }, latency: { p50Ms: 20, sampleSize: 10 }, yield: { successRate: 0.9, sampleSize: 10 } },
      { id: 'fixture/high-only', verified: true, efforts: ['high'], capabilities: { toolUse: true },
        price: { perTokens: 1000, noncachedInput: 2, cachedInput: 2, output: 2 }, latency: { p50Ms: 30, sampleSize: 10 }, yield: { successRate: 0.9, sampleSize: 10 } },
    ] })
}

test('multi-model selection filters against configured effort and retains the original registry receipt', () => {
  const registry = measuredRegistry()
  const selection = { mode: 'automatic', selector: 'auto', models: [], effort: 'high', registry }
  const assignment = configure.resolveAssignment(selection, { logicalRole: 'worker', request: { requiredCapabilities: ['toolUse'] } }, 'claude')
  assert.equal(assignment.model, 'fixture/high-only')
  assert.equal(assignment.effort, 'high')
  assert.equal(assignment.registryReceiptSha256, registry.bindingSha256)
  assert.deepEqual(assignment.consideredModels, ['fixture/high-only'])
})

test('multi-model routing refuses native-only or explicit unsupported effort', () => {
  const registry = measuredRegistry()
  assert.throws(() => configure.resolveAssignment(
    { mode: 'automatic', selector: 'auto', models: [], effort: 'off', registry },
    { logicalRole: 'worker' }, 'omp'), { code: 'INVALID_EFFORT' })
  assert.throws(() => configure.resolveAssignment(
    { mode: 'automatic', selector: 'auto', models: [], effort: 'medium', registry },
    { logicalRole: 'worker' }, 'deepseek'), { code: 'INVALID_EFFORT' })
})

test('DeepSeek records its implicit canonical policy mapping and ranks against the actual native effort', () => {
  const registry = measuredRegistry()
  const assignment = configure.resolveAssignment(
    { mode: 'automatic', selector: 'auto', models: [], registry },
    { logicalRole: 'worker', request: { requiredCapabilities: ['toolUse'] } }, 'deepseek')
  assert.equal(assignment.policyEffort, 'medium')
  assert.equal(assignment.nativeEffort, 'high')
  assert.equal(assignment.effort, 'high')
  assert.equal(assignment.model, 'fixture/high-only')
  assert.deepEqual(assignment.consideredModels, ['fixture/high-only'])
})

// Ephemeral keys in a temporary fixture test the cryptographic verifier only.
// No fixture authority, attestation or capability is written to release trust.
function signedFixture(t) {
  const bundle = fixture(t)
  const provider = 'claude'
  const executable = { provider, path: path.join(bundle, 'native-fixture'), sha256: 'a'.repeat(64), version: '2.1.263',
    runtimeIdentity: { sha256: 'c'.repeat(64), fileCount: 1, packageCount: 0 } }
  const installed = { provider, bundle, files: { 'runtime.js': native.sha256('fixture runtime'),
    [admission.EVIDENCE]: '0'.repeat(64), [admission.KEY_RING]: '0'.repeat(64) } }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const key = { keyId: 'unit-fixture-authority', independent: true, providers: [provider], issuer: 'ephemeral-unit-test-authority',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) }
  const attestation = { schemaVersion: '2.0.0', attestationId: 'unit-test:runtime:fixture', providerId: provider,
    issuer: key.issuer, issuedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    signature: { algorithm: 'ed25519', keyId: key.keyId, value: 'A'.repeat(86) },
    runtimeIdentityHash: admission.runtimeIdentity(provider, installed, executable), activationNonce: 'unit_fixture_nonce_123456',
    verificationMethod: 'live-conformance-suite', verifiedCapabilities: [...admission.REQUIRED], result: 'supported' }
  const record = { provider, status: 'passed', activationNonce: attestation.activationNonce, attestation }
  const evidence = { schemaVersion: 'harness-v2-live-conformance.v1', records: [record] }
  const ring = { schemaVersion: 'harness-v2-trusted-keys.v1', keys: [key] }
  const write = () => {
    for (const [name, value] of [[admission.EVIDENCE, evidence], [admission.KEY_RING, ring]]) {
      const file = path.join(bundle, name); fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(value)); installed.files[name] = native.sha256(fs.readFileSync(file))
    }
  }
  const sign = () => { attestation.signature.value = crypto.sign(null, attestationSignedPayload(attestation), privateKey).toString('base64url'); write() }
  sign()
  return { provider, installed, executable, key, attestation, record, evidence, ring, sign, write,
    verify: () => admission.verifyAdmission(provider, installed, executable) }
}

test('admission verifies a signed provider-scoped runtime fixture and binds non-trust inventory', t => {
  const f = signedFixture(t)
  assert.equal(f.verify().valid, true)
  const initial = admission.runtimeIdentity(f.provider, f.installed, f.executable)
  f.installed.files['nested/evidence.json'] = 'b'.repeat(64)
  assert.notEqual(admission.runtimeIdentity(f.provider, f.installed, f.executable), initial)
  assert.throws(f.verify, { code: 'PROVIDER_UNSUPPORTED' })
})

function activationPrivacyFixture(t) {
  const f = signedFixture(t), root = fixture(t)
  const packaging = require('../../scripts/harness-v2-package.cjs')
  t.mock.method(packaging, 'verify', () => f.installed)
  t.mock.method(native, 'probeExecutable', () => f.executable)
  t.mock.method(native, 'connectionConfig', () => ({}))
  t.mock.method(native, 'credentialEnvironment', () => ({}))
  const activationId = `apv2-${'c'.repeat(32)}`
  const parent = path.join(root, '.autoprompt-private', 'activations')
  const activationRoot = path.join(parent, activationId)
  return { parent, activationRoot, run: () => configure.prepareActivation({
    provider: f.provider, root, target: root, activationId, missionArgs: ['private creation boundary'],
  }) }
}

for (const boundary of ['parent', 'activationRoot']) test(`activation publishes no private data when ${boundary} ACL establishment fails`, t => {
  const f = activationPrivacyFixture(t)
  const privacy = require('../../agents/codex/workflow/safe-run-root.js')
  const original = privacy.ensureWindowsPrivateAcl, calls = [], failure = new Error('private ACL establishment failed')
  t.mock.method(privacy, 'ensureWindowsPrivateAcl', directory => {
    calls.push(directory)
    if (directory === f[boundary]) throw failure
    return original(directory)
  })
  assert.throws(f.run, error => error === failure)
  assert.deepEqual(calls, boundary === 'parent' ? [f.parent] : [f.parent, f.activationRoot])
  assert.deepEqual(fs.readdirSync(f[boundary]), [])
  if (boundary === 'parent') assert.equal(fs.existsSync(f.activationRoot), false)
})

test('activation collision cannot relabel or overwrite an existing owned root', t => {
  const f = activationPrivacyFixture(t)
  const privacy = require('../../agents/codex/workflow/safe-run-root.js')
  fs.mkdirSync(f.activationRoot, { recursive: true, mode: 0o700 })
  privacy.ensureWindowsPrivateAcl(f.parent)
  const sentinel = path.join(f.activationRoot, 'sentinel')
  fs.writeFileSync(sentinel, 'existing private state', { mode: 0o600 })
  t.mock.method(privacy, 'ensureWindowsPrivateAcl', () => { throw new Error('existing storage must not be relabeled') })
  assert.throws(f.run, { code: 'EEXIST' })
  assert.deepEqual(fs.readdirSync(f.activationRoot), ['sentinel'])
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing private state')
})

test('explicit private import requires a reviewer-signed request digest and never mutates shipped trust', t => {
  const f = signedFixture(t)
  const requestSha256 = 'd'.repeat(64)
  f.attestation.providerAdmissionSha256 = requestSha256
  f.sign()
  const imported = path.join(f.installed.bundle, '..', 'private-import')
  fs.mkdirSync(imported, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(imported, 'evidence.json'), JSON.stringify(f.evidence), { mode: 0o600 })
  fs.writeFileSync(path.join(imported, 'trusted-public-keys.json'), JSON.stringify(f.ring), { mode: 0o600 })
  const verified = admission.verifyAdmission(f.provider, f.installed, f.executable,
    { trustDirectory: imported, conformanceRequestSha256: requestSha256 })
  assert.equal(verified.valid, true)
  assert.equal(verified.trustSource.kind, 'explicit-private-import')
  assert.equal(verified.trustSource.conformanceRequestSha256, requestSha256)
  assert.throws(() => admission.verifyAdmission(f.provider, f.installed, f.executable,
    { trustDirectory: imported, conformanceRequestSha256: 'e'.repeat(64) }), { code: 'PROVIDER_UNSUPPORTED' })
  assert.deepEqual(require('../../scripts/harness-v2-trust/evidence.json').records, [])
})

test('local request survives pretty printing and later signed import with its original timestamp', t => {
  // Ephemeral fixture authority only: this exercises the handoff, not admission
  // of a real binary or a claim that fixture evidence is live conformance.
  const f = signedFixture(t)
  const packaging = require('../../scripts/harness-v2-package.cjs')
  Object.assign(f.installed, { payloadDigest: 'f'.repeat(64), payloadGeneration: 'unit-test-generation' })
  const local = require('../../scripts/harness-v2-local-admission.cjs')
  t.mock.method(packaging, 'verify', () => f.installed)
  t.mock.method(native, 'probeExecutable', () => f.executable)
  const root = fixture(t)
  const report = path.join(root, 'report.json'), liveReport = path.join(root, 'live.json')
  const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  write(report, { schemaVersion: 'harness-v2-local-diagnostic.v1', evidenceKind: 'local-executable-diagnostic',
    evidenceDirectory: root, providers: [{ provider: f.provider, executable: { ...f.executable, status: 'supported' },
      adapterProbe: { nativeRuntimeIdentity: f.executable.runtimeIdentity },
      nativeTests: { status: 'supported', scope: 'native-binary-local-model-service', suite: 'unit-only',
        cases: [{ name: 'unit-only', status: 'passed' }] } }] })
  write(liveReport, { schemaVersion: 'harness-v2-reviewed-live-conformance.v1', provider: f.provider,
    runtimeIdentityHash: admission.runtimeIdentity(f.provider, f.installed, f.executable),
    nativeDiagnosticSha256: native.sha256(fs.readFileSync(report)), status: 'passed',
    reviewedAt: new Date().toISOString(), reviewer: { issuer: 'ephemeral-unit-test-authority', reviewId: 'unit-test-review' },
    verifiedCapabilities: [...admission.REQUIRED], evidence: [{ id: 'unit-only', kind: 'unit-fixture', sha256: 'b'.repeat(64) }] })
  const options = { provider: f.provider, root, executable: f.executable.path, report, liveReport,
    createdAt: '2026-01-01T00:00:00.000Z' }
  const prepared = local.createRequest(options)
  const request = path.join(root, 'request.json'), evidence = path.join(root, 'certificate.json'), keys = path.join(root, 'keys.json')
  write(request, prepared.request)
  f.attestation.providerAdmissionSha256 = prepared.requestSha256; f.sign()
  write(evidence, f.evidence); write(keys, f.ring)
  const imported = local.importAdmission({ ...options, createdAt: undefined, request, evidence, keys })
  assert.equal(imported.status, 'imported')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(imported.trustDirectory, 'request.json'))), prepared.request)
  assert.equal(configure.importedAdmission(root, f.provider).conformanceRequestSha256, prepared.requestSha256)
  write(path.join(imported.trustDirectory, 'request.json'), { ...prepared.request, runtimeIdentityHash: '0'.repeat(64) })
  assert.throws(() => configure.importedAdmission(root, f.provider), { code: 'PROVIDER_UNSUPPORTED' })
  assert.throws(() => local.importAdmission({ ...options, request, evidence, keys }), /already exists/)
  write(liveReport, { changed: true })
  assert.throws(() => local.importAdmission({ ...options, request, evidence, keys }), /incomplete|not passed/)
})

test('Reasonix imported admission reopens its request bytes and canonical request digest', t => {
  const root = fixture(t)
  const reasonix = require('../../scripts/reasonix-configure.cjs')
  const reasonixAdmission = require('../../agents/reasonix/workflow/admission.js')
  const directory = reasonixAdmission.importedTrustDirectory(root)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const request = { schemaVersion: 'harness-v2-admission-request.v1', provider: 'reasonix', runtimeIdentityHash: 'a'.repeat(64),
    runtimeIdentityBody: { provider: 'reasonix' }, nativeDiagnostic: { sha256: 'b'.repeat(64) },
    reviewedLiveConformance: { sha256: 'c'.repeat(64) } }
  const requestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`)
  fs.writeFileSync(path.join(directory, 'request.json'), requestBytes, { mode: 0o600 })
  fs.writeFileSync(path.join(directory, 'admission.json'), JSON.stringify({ schemaVersion: 'harness-v2-imported-admission.v1',
    provider: 'reasonix', trustDirectory: directory, conformanceRequestSha256: native.sha256(JSON.stringify(request)),
    requestSha256: native.sha256(requestBytes) }), { mode: 0o600 })
  assert.equal(reasonix.importedAdmission(root).conformanceRequestSha256, native.sha256(JSON.stringify(request)))
  fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ ...request, provider: 'claude' }), { mode: 0o600 })
  assert.throws(() => reasonix.importedAdmission(root), { code: 'PROVIDER_UNSUPPORTED' })
})

test('Reasonix verifies an external reviewer certificate bound to its local request', t => {
  const root = fixture(t), reasonix = require('../../agents/reasonix/workflow/admission.js')
  const installed = { provider: 'reasonix', bundle: path.join(root, 'bundle'), files: { 'runtime.js': native.sha256('reasonix fixture') } }
  fs.mkdirSync(installed.bundle)
  const executable = { provider: 'reasonix', path: path.join(root, 'reasonix'), sha256: 'a'.repeat(64), version: '1.30.0', runtimeIdentity: { sha256: 'b'.repeat(64), fileCount: 1, packageCount: 0 } }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const requestSha256 = 'd'.repeat(64)
  const key = { keyId: 'reasonix-unit-reviewer', independent: true, providers: ['reasonix'], issuer: 'reasonix-unit-reviewer',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) }
  const attestation = { schemaVersion: '2.0.0', attestationId: 'reasonix:unit:fixture', providerId: 'reasonix', issuer: key.issuer,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    signature: { algorithm: 'ed25519', keyId: key.keyId, value: 'A'.repeat(86) }, runtimeIdentityHash: reasonix.runtimeIdentity(installed, executable),
    activationNonce: 'reasonix_unit_nonce_123456', providerAdmissionSha256: requestSha256, verificationMethod: 'live-conformance-suite',
    verifiedCapabilities: [...reasonix.REQUIRED], result: 'supported' }
  attestation.signature.value = crypto.sign(null, attestationSignedPayload(attestation), privateKey).toString('base64url')
  const trust = path.join(root, 'reviewed-trust'); fs.mkdirSync(trust, { mode: 0o700 })
  fs.writeFileSync(path.join(trust, 'evidence.json'), JSON.stringify({ status: 'passed', activationNonce: attestation.activationNonce, attestation }), { mode: 0o600 })
  fs.writeFileSync(path.join(trust, 'trusted-public-keys.json'), JSON.stringify({ keys: [key] }), { mode: 0o600 })
  assert.equal(reasonix.verifyAdmission(installed, executable, { trustDirectory: trust, conformanceRequestSha256: requestSha256 }).valid, true)
  assert.throws(() => reasonix.verifyAdmission(installed, executable, { trustDirectory: trust, conformanceRequestSha256: 'e'.repeat(64) }), { code: 'PROVIDER_UNSUPPORTED' })
})

test('imported admission refuses a private trust path reached through a symlink', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t), outside = fixture(t)
  const directory = path.join(outside, 'conformance', 'v2', 'claude')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const request = { schemaVersion: 'harness-v2-admission-request.v1', provider: 'claude', runtimeIdentityHash: 'a'.repeat(64),
    runtimeIdentityBody: { provider: 'claude' }, nativeDiagnostic: { sha256: 'b'.repeat(64) }, reviewedLiveConformance: { sha256: 'c'.repeat(64) } }
  const bytes = Buffer.from(JSON.stringify(request))
  fs.writeFileSync(path.join(directory, 'request.json'), bytes, { mode: 0o600 })
  fs.writeFileSync(path.join(directory, 'admission.json'), JSON.stringify({ schemaVersion: 'harness-v2-imported-admission.v1', provider: 'claude',
    trustDirectory: path.join(root, '.autoprompt-private', 'conformance', 'v2', 'claude'), conformanceRequestSha256: native.sha256(JSON.stringify(request)), requestSha256: native.sha256(bytes) }), { mode: 0o600 })
  fs.symlinkSync(outside, path.join(root, '.autoprompt-private'))
  assert.throws(() => configure.importedAdmission(root, 'claude'), { code: 'PROVIDER_UNSUPPORTED' })
})

test('public admission parser preserves required paths, rejects duplicates, and refuses Codex dispatch', () => {
  const cli = require('../../bin/autoprompt.cjs')
  const args = ['admission', 'request', 'claude', '--root', '/tmp/root', '--executable', '/tmp/exe', '--report', '/tmp/report', '--live-report', '/tmp/live', '--output', '/tmp/request']
  const parsed = cli.parseArgs(args)
  assert.equal(parsed.liveReport, '/tmp/live')
  assert.throws(() => cli.parseArgs([...args, '--live-report', '/tmp/other']), { code: 'AUTOPROMPT_USAGE' })
  const codex = cli.parseArgs(args.map(value => value === 'claude' ? 'codex' : value))
  const output = [], errors = []
  assert.equal(cli.run(args.map(value => value === 'claude' ? 'codex' : value), { stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) }, env: process.env, cwd: process.cwd(), interactive: false }), 1)
  assert.equal(codex.provider, 'codex')
  assert.match(errors.join(''), /not implemented for codex/i)
})

for (const [name, mutate, resign = true] of [
  ['expired signature', f => { f.attestation.expiresAt = new Date(Date.now() - 1000).toISOString() }],
  ['future issuance', f => { f.attestation.issuedAt = new Date(Date.now() + 60000).toISOString() }],
  ['wrong provider', f => { f.attestation.providerId = 'kilo' }],
  ['missing capability', f => { f.attestation.verifiedCapabilities.pop() }],
  ['missing nonce binding', f => { delete f.record.activationNonce }],
  ['mismatched nonce', f => { f.record.activationNonce = 'other_fixture_nonce_1234' }],
  ['untrusted issuer', f => { f.key.issuer = 'different-fixture-authority' }],
  ['non-independent issuer', f => { f.key.independent = false }],
  ['wrong key provider scope', f => { f.key.providers = ['opencode'] }],
  ['duplicate trust key', f => { f.ring.keys.push({ ...f.key }) }],
  ['duplicate verification record', f => { f.evidence.records.push({ ...f.record }) }],
  ['self-issued activation record', f => { f.key.issuer = f.attestation.issuer = 'autoprompt-claude-activation-v2' }],
  ['help-only evidence', f => { f.attestation.verificationMethod = 'provider-signed-capability-probe' }],
  ['changed signature bytes', f => { f.attestation.signature.value = 'A'.repeat(86) }, false],
  ['changed executable hash', f => { f.executable.sha256 = 'b'.repeat(64) }],
  ['changed executable path', f => { f.executable.path += '-other' }],
  ['changed native dependency bytes', f => { f.executable.runtimeIdentity.sha256 = 'd'.repeat(64) }],
  ['changed native dependency inventory', f => { f.executable.runtimeIdentity.fileCount++ }],
]) {
  test(`admission refuses ${name}`, t => {
    const f = signedFixture(t); mutate(f); if (resign) f.sign(); else f.write()
    assert.throws(f.verify, { code: 'PROVIDER_UNSUPPORTED' })
  })
}

test('release trust remains empty; production admission is never issued by this test suite', () => {
  assert.deepEqual(require('../../scripts/harness-v2-trust/evidence.json').records, [])
  assert.deepEqual(require('../../scripts/harness-v2-trust/trusted-public-keys.json').keys, [])
})
