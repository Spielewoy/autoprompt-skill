'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const SCHEMAS = path.join(ROOT, 'agents', 'contracts', 'schemas')
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'benchmark-evidence-v2')
const evidence = require(path.join(ROOT, 'scripts', 'benchmark-evidence'))
const ROUTE_HOLDOUT_PROVENANCE = require(path.join(ROOT, 'tests', 'fixtures', 'codex-route-holdout-v2.provenance.json'))

function roleSigner(role) {
  const pair = crypto.generateKeyPairSync('ed25519')
  const issuer = `fixture-${role}-issuer`
  const keyId = `fixture-${role}-key`
  return {
    signer: { privateKey: pair.privateKey, issuer, keyId },
    trust: {
      issuer, keyId, algorithm: 'ed25519', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', fixtureOnly: true,
    },
  }
}

const ROLE_KEYS = Object.fromEntries(['manifest', 'aggregate', 'provider-receipt', 'verifier', 'controller'].map(role => [role, roleSigner(role)]))
const TRUST_REGISTRY_INPUT = {
  schemaVersion: 'benchmark-trust-registry.v2',
  roles: Object.fromEntries(Object.entries(ROLE_KEYS).map(([role, pair]) => [role, pair.trust])),
  catalogs: { 'terminal-bench-3.0-cpu-fixture-2026-08-22': evidence.FIXTURE_CATALOG_TRUST },
}
const TRUST_REGISTRY = evidence.createTrustRegistry(TRUST_REGISTRY_INPUT)

const CONTROL_BYTES = Object.freeze({
  'control/task-input.json': '{"task":"alpha"}\n',
  'control/environment.json': '{}\n',
  'control/toolchain.json': '{"node":"fixture"}\n',
  'control/canary-input.json': '{"canary":"input"}\n',
  'control/canary-fixture.json': '{"canary":"fixture"}\n',
  'control/fault-wrong-model.json': '{"fault":"wrong-model"}\n',
  'control/fault-missing-subagent.json': '{"fault":"missing-subagent-trace"}\n',
  'control/fault-broken-verifier.json': '{"fault":"broken-verifier"}\n',
  'control/fault-upload-denied.json': '{"fault":"upload-denied"}\n',
})

function controlBlob(relativePath) {
  const bytes = Buffer.from(CONTROL_BYTES[relativePath])
  return { relativePath, sha256: evidence.sha256(bytes), bytes: bytes.length }
}

function materializeControls(root) {
  for (const [relative, bytes] of Object.entries(CONTROL_BYTES)) write(path.join(root, ...relative.split('/')), bytes)
}

function receiptInput(uploadedAt) {
  return { provider: 'fixture', objectVersion: 'v1', uploadedAt, signer: ROLE_KEYS['provider-receipt'].signer }
}

function temporary(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-benchmark-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function write(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filename, value, { mode: 0o600 })
}

function catalogFixture() { return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'tb3-catalog-attested.json'), 'utf8')) }

function pricingFixture() {
  const identity = { provider: 'openai', model: 'fixture-model', version: '2026-08-22' }
  return evidence.sealPricing({
    schemaVersion: 'benchmark-pricing.v2', pricingId: 'pricing-2026-08-22',
    effectiveAt: '2026-08-22T00:00:00.000Z', currency: 'USD',
    models: { [evidence.modelPriceKey(identity)]: { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8, reasoningPerMillion: 8 } },
    host: { perSecond: 0.01 }, storage: { perByteMonth: 0.000001 }, setup: { perUnit: 0.25 },
  })
}

function mechanismSchemaFixture() {
  const processResult = { exitCode: 0, signal: null, errorCode: null, stdoutObserved: true, stderrObserved: false }
  const focusedCheck = { argv: ['{node}', '--test', 'test.cjs'], ...processResult }
  const record = {
    schemaVersion: 'codex-mechanism-evidence.v1', generatedAt: '2026-08-22T00:00:00.000Z', evidenceClass: 'harness-mechanics-only', provider: 'codex',
    qualityClaimEligible: false, comparisonClaimEligible: false, reason: 'fixture mechanics only',
    source: { baselineSha: 'a'.repeat(40), candidateSha: 'b'.repeat(40) },
    task: { taskId: 'normalize-tags-direct', route: 'DIRECT', repetitions: 1, fixture: { sha256: 'c'.repeat(64), files: 2 }, baselineFocusedCheck: { ...focusedCheck, exitCode: 1 } },
    attempts: [
      ['base', 'single-agent-base', 'a'.repeat(40)],
      ['current', 'frozen-current-autoprompt', 'a'.repeat(40)],
      ['redesign', 'codex-redesign', 'b'.repeat(40)],
    ].map(([armId, role, sourceSha]) => ({ armId, role, sourceSha, sourceBinding: 'declared-existing-commit-not-executed', executionKind: 'deterministic-fixture-runner', terminalState: 'PASS', producer: processResult, focusedCheck, outputTree: { sha256: 'd'.repeat(64), files: 2 } })),
    mechanismVerified: true,
    realCodex: { status: 'BLOCKED', phase: 'pre-route', code: 'PROVIDER_UNSUPPORTED', reason: 'codex-command-sandbox-network-open', evidencePath: 'docs/benchmarks/codex-canary.md', evidenceSha256: 'e'.repeat(64), observationKind: 'carried-forward-not-rerun' },
  }
  return { ...record, checksum: evidence.digestRecord(record) }
}

function unsignedManifest(catalog, pricing, budgetOverrides = {}, executionOverrides = {}) {
  const catalogTrust = evidence.validateTaskCatalog(catalog, TRUST_REGISTRY, { checkedAt: '2026-08-22T00:00:00.000Z' }).trust
  const defaultCommand = [process.execPath, '-e', 'process.exit(0)']
  const armExecution = role => ({ argv: executionOverrides[role] || defaultCommand, environment: controlBlob('control/environment.json'), toolchain: controlBlob('control/toolchain.json') })
  const execution = (fault = null) => ({
    argv: executionOverrides.canary || defaultCommand,
    input: controlBlob('control/canary-input.json'), fixture: controlBlob('control/canary-fixture.json'),
    environment: controlBlob('control/environment.json'), toolchain: controlBlob('control/toolchain.json'), faultInjector: fault,
  })
  const fault = name => ({ name, argv: executionOverrides.faultInjector || defaultCommand, artifact: controlBlob(`control/fault-${name === 'missing-subagent-trace' ? 'missing-subagent' : name}.json`) })
  const manifest = {
    schemaVersion: 'benchmark-run-manifest.v2', manifestId: 'manifest-2026-08-22-a', benchmarkId: catalog.benchmarkId,
    createdAt: '2026-08-22T00:00:00.000Z',
    arms: [
      { armId: 'base', role: 'base', producer: { name: 'fixture-base', version: '2026-08-22', buildDigest: '1'.repeat(64) }, execution: armExecution('base') },
      { armId: 'current', role: 'current', producer: { name: 'fixture-current', version: '2026-08-22', buildDigest: '2'.repeat(64) }, execution: armExecution('current') },
      { armId: 'redesign', role: 'redesign', producer: { name: 'fixture-redesign', version: '2026-08-22', buildDigest: '3'.repeat(64) }, execution: armExecution('redesign') },
    ],
    repetitions: 3,
    tasks: [
      { taskId: 'task-alpha', included: true, pairedOrder: ['base', 'current', 'redesign'], input: controlBlob('control/task-input.json') },
      { taskId: 'task-excluded', included: false, exclusionReason: 'requires an unavailable accelerator' },
    ],
    budgets: { agentTimeoutMs: 600000, verifierTimeoutMs: 120000, hostKillMs: 750000, maxTokens: 200000, ...budgetOverrides },
    resources: { instanceId: 'fixture-instance', bucket: 'fixture-bucket', runRoot: '/var/lib/benchmark/run-a', containerNamespace: 'tb3-a', trialPrefix: 'trial-a' },
    pricingRef: { pricingId: pricing.pricingId, digest: pricing.digest },
    taskCatalogRef: { catalogId: catalog.catalogId, digest: catalog.digest, taskCount: catalog.tasks.length, issuer: catalogTrust.issuer, keyId: catalogTrust.keyId, attestationDigest: catalogTrust.attestationDigest, fixtureOnly: catalogTrust.fixtureOnly },
    runLease: { nonce: 'fixture-run-nonce-a', issuer: 'fixture-run-lease-authority', validFrom: '2026-08-22T00:00:00.000Z', validUntil: '2026-08-23T00:00:00.000Z' },
    canaries: {
      stages: ['pre', 'mid', 'post'],
      midAfterScoredAttempts: 4,
      definitions: [
        { canaryId: 'environment-positive', polarity: 'positive', checks: ['model-version', 'auth', 'tools', 'verifier', 'subagents', 'transcript', 'upload'], execution: execution() },
        { canaryId: 'wrong-model-negative', polarity: 'negative', checks: ['model-version'], expectedDiagnosis: 'WRONG_MODEL', execution: execution(fault('wrong-model')) },
        { canaryId: 'missing-subagent-negative', polarity: 'negative', checks: ['subagents'], expectedDiagnosis: 'MISSING_SUBAGENT_TRACE', execution: execution(fault('missing-subagent-trace')) },
        { canaryId: 'broken-verifier-negative', polarity: 'negative', checks: ['verifier'], expectedDiagnosis: 'BROKEN_VERIFIER', execution: execution(fault('broken-verifier')) },
        { canaryId: 'upload-denied-negative', polarity: 'negative', checks: ['upload'], expectedDiagnosis: 'UPLOAD_DENIED', execution: execution(fault('upload-denied')) },
      ],
    },
  }
  manifest.plannedAttempts = evidence.buildPlannedAttempts(manifest, { catalog, trustRegistry: TRUST_REGISTRY })
  manifest.executionOrder = evidence.buildExecutionOrder(manifest)
  return manifest
}

function signedFixture(budgetOverrides, executionOverrides) {
  const catalog = catalogFixture()
  const pricing = pricingFixture()
  const raw = unsignedManifest(catalog, pricing, budgetOverrides, executionOverrides)
  const manifest = evidence.signManifest(raw, { signer: ROLE_KEYS.manifest.signer, trustRegistry: TRUST_REGISTRY, catalog })
  return { catalog, pricing, manifest }
}

function sessionFixture(attemptId, sessionId = `${attemptId}:root`, parentSessionId = null, rootSessionId = sessionId, timing = {}) {
  const startedAt = timing.startedAt || '2026-08-22T00:00:01.000Z'
  const endedAt = timing.endedAt || '2026-08-22T00:00:03.000Z'
  const midpoint = new Date((Date.parse(startedAt) + Date.parse(endedAt)) / 2).toISOString()
  return {
    schemaVersion: 'benchmark-session.v2', sessionId, parentSessionId, rootSessionId, attemptId, role: 'worker',
    model: { provider: 'openai', name: 'fixture-model', version: '2026-08-22' },
    startedAt, endedAt,
    usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300, reasoningTokens: 50 },
    spans: [
      { spanId: `${attemptId}:execution`, kind: 'execution', startedAt, endedAt: midpoint },
      { spanId: `${attemptId}:unknown`, kind: 'unknown', startedAt: midpoint, endedAt },
    ],
  }
}

function buildEvidenceFixture(t, name = 'aggregate') {
  const { catalog, pricing, manifest } = signedFixture()
  const directory = temporary(t, name)
  const evidenceRoot = path.join(directory, 'evidence')
  fs.mkdirSync(evidenceRoot, { recursive: true })
  materializeControls(evidenceRoot)
  const reconstructionValues = { manifest, catalog, pricing, trustRegistry: TRUST_REGISTRY_INPUT }
  for (const [name, value] of Object.entries(reconstructionValues)) write(path.join(evidenceRoot, 'inputs', `${name}.json`), `${evidence.canonicalStringify(value)}\n`)
  const inputEvidence = Object.fromEntries(Object.keys(reconstructionValues).map(name => [name, evidence.describeEvidenceFile(evidenceRoot, `inputs/${name}.json`)]))
  const source = path.join(directory, 'source')
  fs.mkdirSync(source, { recursive: true })
  const harborCore = { status: 'completed', result: 'pass', reward: 1, grader: { verdict: 'pass', score: 1 } }
  write(path.join(source, 'harbor.json'), `${evidence.canonicalStringify(harborCore)}\n`)
  write(path.join(source, 'grader-details.json'), '{"verifier":"fixture","accepted":true}\n')
  write(path.join(source, 'resources.json'), `${evidence.canonicalStringify(manifest.resources)}\n`)
  write(path.join(source, 'artifacts', 'output.txt'), 'fixture artifact\n')
  const allPlans = [...manifest.plannedAttempts, ...evidence.buildCanaryAttempts(manifest)]
  const byPlanId = new Map(allPlans.map(plan => [plan.attemptId, plan]))
  const executionPlans = manifest.executionOrder.map(id => byPlanId.get(id))
  const timings = new Map()
  const harborSha256 = evidence.sha256(fs.readFileSync(path.join(source, 'harbor.json')))
  const verifierSha256 = evidence.sha256(fs.readFileSync(path.join(source, 'grader-details.json')))
  const resourceEvidenceSha256 = evidence.sha256(fs.readFileSync(path.join(source, 'resources.json')))
  for (const [index, plan] of executionPlans.entries()) {
    const safe = Buffer.from(plan.attemptId).toString('base64url')
    const startedAt = new Date(Date.parse('2026-08-22T00:00:00.000Z') + index * 20000).toISOString()
    const endedAt = new Date(Date.parse(startedAt) + 10000).toISOString()
    const deadlineAt = new Date(Date.parse(startedAt) + manifest.budgets.hostKillMs).toISOString()
    const sessionTiming = { startedAt: new Date(Date.parse(startedAt) + 1000).toISOString(), endedAt: new Date(Date.parse(startedAt) + 3000).toISOString() }
    const systemCore = { containerState: 'exited', exitCode: 0, signal: null, hostKillTriggered: false, cancelled: false, hostKill: { enforcer: 'external-process', deadlineAt, triggeredAt: null } }
    timings.set(plan.attemptId, { startedAt, endedAt, systemCore, sessionTiming })
    write(path.join(source, 'systems', `${safe}.json`), `${evidence.canonicalStringify(systemCore)}\n`)
    write(path.join(source, 'host-kills', `${safe}.json`), `${evidence.canonicalStringify(systemCore.hostKill)}\n`)
    const normal = sessionFixture(plan.attemptId, `${plan.attemptId}:root`, null, `${plan.attemptId}:root`, sessionTiming)
    write(path.join(source, 'sessions', `${safe}.jsonl`), `${evidence.canonicalStringify(normal)}\n`)
    const duplicate = sessionFixture(plan.attemptId, 'globally-reused', null, 'globally-reused', sessionTiming)
    write(path.join(source, 'adversarial', 'duplicate', `${safe}.jsonl`), `${evidence.canonicalStringify(duplicate)}\n`)
    const orphan = sessionFixture(plan.attemptId, `${plan.attemptId}:orphan`, 'missing-parent', 'missing-root', sessionTiming)
    write(path.join(source, 'adversarial', 'orphan', `${safe}.jsonl`), `${evidence.canonicalStringify(orphan)}\n`)
    if (plan.attemptClass === 'canary') {
      const checks = Object.fromEntries(plan.checks.map(check => [check, plan.polarity === 'negative' ? 'fail' : 'pass']))
      const canaryBytes = `${evidence.canonicalStringify({ checks })}\n`
      write(path.join(source, 'canaries', `${safe}.json`), canaryBytes)
      const controller = evidence.signCanaryControllerRecord(manifest.manifestDigest, plan, { sha256: evidence.sha256(canaryBytes) }, endedAt, ROLE_KEYS.controller.signer)
      write(path.join(source, 'canary-controllers', `${safe}.json`), `${evidence.canonicalStringify(controller)}\n`)
    } else {
      const producer = manifest.arms.find(arm => arm.armId === plan.armId).producer
      const authority = evidence.signVerifierAttestation({
        manifestDigest: manifest.manifestDigest, taskId: plan.taskId, attemptId: plan.attemptId, issuedAt: endedAt,
        verdict: harborCore.result, reward: harborCore.reward, grader: { verdict: harborCore.grader.verdict, score: harborCore.grader.score }, producer,
        rawHarborSha256: harborSha256, verifierSha256, resourceEvidenceSha256,
      }, ROLE_KEYS.verifier.signer)
      const authorityBytes = `${evidence.canonicalStringify(authority)}\n`
      write(path.join(source, 'authorities', `${safe}.json`), authorityBytes)
      const resultBundle = {
        schemaVersion: 'benchmark-result-bundle.v2', manifestDigest: manifest.manifestDigest,
        taskId: plan.taskId, attemptId: plan.attemptId, verdict: harborCore.result, reward: harborCore.reward,
        grader: { verdict: harborCore.grader.verdict, score: harborCore.grader.score }, producer,
        rawHarborSha256: harborSha256, verifierSha256, resourceEvidenceSha256,
        authorityAttestationSha256: evidence.sha256(authorityBytes), authoritySignatureSha256: evidence.sha256(evidence.canonicalStringify(authority.signature)),
      }
      write(path.join(source, 'results', `${safe}.json`), `${evidence.canonicalStringify(resultBundle)}\n`)
    }
  }
  evidence.writeChecksums(source)
  const promoted = evidence.promoteSnapshot({ sourceDir: source, storeDir: evidenceRoot, snapshotId: 'snapshot-fixture', sourceState: 'TERMINAL', manifestDigest: manifest.manifestDigest, observedAt: '2026-08-22T01:00:00.000Z' })
  const prefix = 'snapshots/snapshot-fixture'
  const describe = relative => evidence.describeEvidenceFile(evidenceRoot, `${prefix}/${relative}`)
  const harbor = { ...harborCore, grader: { ...harborCore.grader, details: describe('grader-details.json') }, evidence: describe('harbor.json') }
  function makeRecord(plan) {
    const safe = Buffer.from(plan.attemptId).toString('base64url')
    const timing = timings.get(plan.attemptId)
    const sessions = [sessionFixture(plan.attemptId, `${plan.attemptId}:root`, null, `${plan.attemptId}:root`, timing.sessionTiming)]
    const system = { ...timing.systemCore, hostKill: { ...timing.systemCore.hostKill, evidence: describe(`host-kills/${safe}.json`) }, evidence: describe(`systems/${safe}.json`) }
    const rawCanary = plan.attemptClass === 'canary' ? JSON.parse(fs.readFileSync(path.join(promoted.snapshotPath, 'canaries', `${safe}.json`), 'utf8')) : null
    const canary = rawCanary ? evidence.deriveCanaryResult(plan, rawCanary) : null
    return evidence.sealAttempt({
      schemaVersion: 'benchmark-attempt-evidence.v2', manifestDigest: manifest.manifestDigest, attempt: { ...plan }, resources: { ...manifest.resources, evidence: describe('resources.json') },
      startedAt: timing.startedAt, endedAt: timing.endedAt, system, harbor,
      result: plan.attemptClass === 'scored' ? describe(`results/${safe}.json`) : null,
      authority: plan.attemptClass === 'scored' ? describe(`authorities/${safe}.json`) : null,
      artifacts: [describe('artifacts/output.txt')], sessions, sessionLog: describe(`sessions/${safe}.jsonl`),
      costs: { hostSeconds: 10, storageByteMonths: 100, setupUnits: 1 },
      provenance: { kind: 'immutable-snapshot', snapshotId: 'snapshot-fixture', snapshotDigest: promoted.snapshotManifest.digest, snapshotRelativePath: prefix, observedAt: '2026-08-22T01:00:00.000Z' },
      canary: canary ? { ...canary, evidence: describe(`canaries/${safe}.json`), controllerEvidence: describe(`canary-controllers/${safe}.json`) } : null,
    })
  }
  const attempts = allPlans.map(makeRecord)
  const ledgerPath = path.join(evidenceRoot, 'ledger', 'execution.jsonl')
  const recordsById = new Map(attempts.map(record => [record.attempt.attemptId, record]))
  for (const attemptId of manifest.executionOrder) {
    const record = recordsById.get(attemptId)
    evidence.appendExecutionLedger(ledgerPath, {
      manifest, trustRegistry: TRUST_REGISTRY, signer: ROLE_KEYS.controller.signer,
      attemptId, startedAt: record.startedAt, endedAt: record.endedAt,
      terminalState: evidence.deriveTerminalState(record), evidenceChecksum: record.checksum,
    })
  }
  const executionLedger = evidence.describeEvidenceFile(evidenceRoot, 'ledger/execution.jsonl')
  const firstTiming = timings.get(allPlans[0].attemptId)
  return { catalog, pricing, manifest, directory, evidenceRoot, promoted, plans: allPlans, attempts, makeRecord, describe, executionLedger, inputEvidence, systemCore: firstTiming.systemCore, harborCore, startedAt: firstTiming.startedAt, endedAt: firstTiming.endedAt }
}

function aggregate(fixture, attempts = fixture.attempts, extra = {}) {
  return evidence.aggregateEvidence({
    catalog: fixture.catalog, manifest: fixture.manifest, pricing: fixture.pricing,
    evidenceRoot: fixture.evidenceRoot, attempts, trustRegistry: TRUST_REGISTRY,
    executionLedger: fixture.executionLedger, inputEvidence: fixture.inputEvidence, reportSigner: ROLE_KEYS.aggregate.signer,
    generatedAt: '2026-08-22T02:00:00.000Z', ...extra,
  })
}

function pythonSchemaErrors(instances) {
  const schemas = fs.readdirSync(SCHEMAS).filter(name => name.startsWith('benchmark-') && name.endsWith('.schema.json')).map(name => JSON.parse(fs.readFileSync(path.join(SCHEMAS, name), 'utf8')))
  const program = [
    'import json,sys',
    'from jsonschema import Draft202012Validator, FormatChecker',
    'from referencing import Registry, Resource',
    "payload=json.load(sys.stdin)",
    "registry=Registry().with_resources((item['$id'],Resource.from_contents(item)) for item in payload['schemas'])",
    "by_id={item['$id']:item for item in payload['schemas']}",
    "out=[]",
    "for item in payload['instances']:",
    " schema=by_id[item['schemaId']]",
    " validator=Draft202012Validator(schema,registry=registry,format_checker=FormatChecker())",
    " out.append([{'path':'/'.join(map(str,e.absolute_path)),'message':e.message} for e in validator.iter_errors(item['instance'])])",
    'json.dump(out,sys.stdout)',
  ].join('\n')
  const result = childProcess.spawnSync('python', ['-c', program], { input: JSON.stringify({ schemas, instances }), encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('authoritative catalog, paired three-arm manifest, required failure canaries, and signature are fail-closed', t => {
  const { catalog, pricing, manifest } = signedFixture()
  assert.equal(evidence.validateTaskCatalog(catalog, TRUST_REGISTRY, { checkedAt: '2026-08-22T00:00:00.000Z' }).trust.fixtureOnly, true)
  assert.throws(() => evidence.validateTaskCatalog(catalog), error => error.code === 'TRUST_REGISTRY_REQUIRED')
  assert.throws(() => evidence.requireProductionCatalog(TRUST_REGISTRY, catalog.catalogId), error => error.code === 'PRODUCTION_CATALOG_TRUST_REQUIRED')
  assert.throws(() => evidence.createTrustRegistry({
    schemaVersion: 'benchmark-trust-registry.v2',
    roles: { manifest: ROLE_KEYS.manifest.trust, aggregate: ROLE_KEYS.manifest.trust },
    catalogs: {},
  }), error => error.code === 'TRUST_ROLE_COLLISION')
  assert.throws(() => evidence.createTrustRegistry({
    schemaVersion: 'benchmark-trust-registry.v2',
    roles: {
      manifest: ROLE_KEYS.manifest.trust,
      aggregate: { ...ROLE_KEYS.manifest.trust, issuer: 'separate-aggregate-issuer', keyId: 'separate-aggregate-key' },
    },
    catalogs: {},
  }), error => error.code === 'TRUST_ROLE_COLLISION' && /public key/.test(error.message))
  const runMinted = evidence.sealTaskCatalog({ schemaVersion: catalog.schemaVersion, catalogId: catalog.catalogId, benchmarkId: catalog.benchmarkId, fixtureOnly: true, tasks: catalog.tasks })
  assert.throws(() => evidence.validateTaskCatalog(runMinted, TRUST_REGISTRY), error => ['TASK_CATALOG_INVALID', 'TASK_CATALOG_ATTESTATION_INVALID'].includes(error.code))
  const alteredCatalog = structuredClone(catalog); alteredCatalog.tasks[0].taskId = 'post-hoc-task'
  assert.throws(() => evidence.validateTaskCatalog(alteredCatalog, TRUST_REGISTRY), error => ['TASK_CATALOG_INVALID', 'TASK_CATALOG_PIN_MISMATCH'].includes(error.code))
  assert.equal(evidence.validateRunManifest(manifest, { trustRegistry: TRUST_REGISTRY, catalog }).plannedAttempts, 9)
  const canaryPlans = evidence.buildCanaryAttempts(manifest)
  for (const canaryId of new Set(canaryPlans.map(item => item.canaryId))) for (const stage of ['pre', 'mid', 'post']) {
    const executions = canaryPlans.filter(item => item.canaryId === canaryId && item.stage === stage).map(item => item.execution)
    assert.ok(executions.every(item => evidence.canonicalStringify(item) === evidence.canonicalStringify(executions[0])))
  }
  assert.ok(manifest.executionOrder.indexOf(manifest.plannedAttempts[0].attemptId) > manifest.executionOrder.findLastIndex(id => id.startsWith('canary::pre::')))
  assert.ok(manifest.executionOrder.indexOf('canary::mid::c1::base') > manifest.executionOrder.indexOf(manifest.plannedAttempts[3].attemptId))
  const directory = temporary(t, 'manifest')
  const trustFilename = path.join(directory, 'host-trust.json')
  write(trustFilename, `${evidence.canonicalStringify(TRUST_REGISTRY_INPUT)}\n`)
  assert.equal(evidence.validateTaskCatalog(catalog, evidence.loadTrustRegistry(trustFilename), { checkedAt: manifest.createdAt }).catalog.digest, catalog.digest)
  const filename = path.join(directory, 'manifest.json')
  const written = evidence.writeSignedManifest(filename, unsignedManifest(catalog, pricing), { signer: ROLE_KEYS.manifest.signer, trustRegistry: TRUST_REGISTRY, catalog })
  assert.equal(evidence.loadSignedManifest(filename, TRUST_REGISTRY, catalog).manifestDigest, written.manifestDigest)
  assert.throws(() => evidence.writeSignedManifest(filename, unsignedManifest(catalog, pricing), { signer: ROLE_KEYS.manifest.signer, trustRegistry: TRUST_REGISTRY, catalog }), error => error.code === 'MANIFEST_EXISTS')
  const partial = unsignedManifest(catalog, pricing)
  partial.tasks = partial.tasks.slice(0, 1)
  partial.plannedAttempts = evidence.buildPlannedAttempts(partial)
  assert.throws(() => evidence.signManifest(partial, { signer: ROLE_KEYS.manifest.signer, trustRegistry: TRUST_REGISTRY, catalog }), error => error.code === 'MANIFEST_TASK_CATALOG_MISMATCH')
  const missingFailure = unsignedManifest(catalog, pricing)
  missingFailure.canaries.definitions = missingFailure.canaries.definitions.filter(item => item.expectedDiagnosis !== 'BROKEN_VERIFIER')
  assert.throws(() => evidence.signManifest(missingFailure, { signer: ROLE_KEYS.manifest.signer, trustRegistry: TRUST_REGISTRY, catalog }), error => error.code === 'MANIFEST_CANARIES_INVALID')
  assert.equal(evidence.verifyManifestSignature({ ...manifest, repetitions: 4 }, TRUST_REGISTRY), false)
  const attacker = roleSigner('attacker')
  const selfSigned = { ...manifest, signature: evidence.signRoleDigest('manifest', manifest.manifestDigest, manifest.createdAt, attacker.signer) }
  assert.equal(evidence.verifyManifestSignature(selfSigned, TRUST_REGISTRY), false)
  assert.equal(evidence.verifyManifestSignature({ ...manifest, signature: { ...manifest.signature, keyId: 'altered-key-id' } }, TRUST_REGISTRY), false)
})

test('run lease locking never reaps a live owner by age, recovers a proven-dead owner, and serializes contenders', async t => {
  const { manifest } = signedFixture()
  const directory = temporary(t, 'run-lease-locking')
  const makeRegistry = name => {
    const filename = path.join(directory, `${name}.json`)
    evidence.createRunLeaseRegistry(filename, { registryId: name, issuer: manifest.runLease.issuer })
    return filename
  }
  const writeLock = (filename, ownerPid, acquiredAt) => {
    const core = { schemaVersion: 'benchmark-run-lease-lock.v2', ownerPid, ownerToken: 'a'.repeat(32), acquiredAt }
    write(`${filename}.lock`, `${evidence.canonicalStringify({ ...core, checksum: evidence.digestRecord(core) })}\n`)
  }

  const liveRegistry = makeRegistry('live-owner')
  writeLock(liveRegistry, process.pid, '2020-01-01T00:00:00.000Z')
  fs.utimesSync(`${liveRegistry}.lock`, new Date(0), new Date(0))
  assert.throws(() => evidence.consumeRunLease(liveRegistry, manifest, { now: '2026-08-22T00:00:00.001Z' }), error => error.code === 'RUN_LEASE_REGISTRY_BUSY')
  fs.unlinkSync(`${liveRegistry}.lock`)

  const dead = childProcess.spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true })
  const deadPid = dead.pid
  await new Promise((resolve, reject) => { dead.once('error', reject); dead.once('close', resolve) })
  const deadRegistry = makeRegistry('dead-owner')
  writeLock(deadRegistry, deadPid, '2020-01-01T00:00:00.000Z')
  const recovered = evidence.consumeRunLease(deadRegistry, manifest, { now: '2026-08-22T00:00:00.001Z', consumptionId: 'dead-owner-recovered' })
  assert.equal(recovered.consumptionId, 'dead-owner-recovered')
  assert.equal(fs.existsSync(`${deadRegistry}.lock`), false)

  const raceRegistry = makeRegistry('race-owner')
  const manifestPath = path.join(directory, 'manifest.json')
  write(manifestPath, `${evidence.canonicalStringify(manifest)}\n`)
  const indexPath = path.join(ROOT, 'scripts', 'benchmark-evidence')
  const consumer = [
    `const fs=require('fs'),e=require(${JSON.stringify(indexPath)})`,
    "const [registry,manifestFile,id]=process.argv.slice(1),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'))",
    "try{e.consumeRunLease(registry,manifest,{now:'2026-08-22T00:00:00.001Z',consumptionId:id});process.stdout.write('ok')}catch(error){process.stderr.write(error.code||error.message);process.exit(2)}",
  ].join(';')
  const runConsumer = id => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ['-e', consumer, raceRegistry, manifestPath, id], { windowsHide: true })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
  const contenders = await Promise.all([runConsumer('race-a'), runConsumer('race-b')])
  assert.equal(contenders.filter(item => item.status === 0).length, 1)
  assert.equal(contenders.filter(item => item.status === 2 && /RUN_LEASE_(?:REGISTRY_BUSY|REPLAY)/.test(item.stderr)).length, 1)
  assert.equal(evidence.loadRunLeaseRegistry(raceRegistry).entries.length, 1)
  assert.throws(() => evidence.consumeRunLease(raceRegistry, manifest, { now: '2026-08-22T00:00:00.002Z' }), error => error.code === 'RUN_LEASE_REPLAY')
})

test('real Draft 2020-12 validation accepts every canonical record and rejects nested extra fields', t => {
  const fixture = buildEvidenceFixture(t, 'schemas')
  const spoolPath = path.join(fixture.directory, 'spool.json')
  const spool = evidence.createUploadSpool(spoolPath, { spoolId: 'schema-spool', manifestDigest: fixture.manifest.manifestDigest, objects: [{ digest: 'a'.repeat(64), relativePath: 'report.json' }], maxAttempts: 2, baseBackoffMs: 1000, maxBackoffMs: 8000, now: '2026-08-22T00:00:00.000Z' })
  const resultBundle = evidence.readVerifiedJson(fixture.evidenceRoot, fixture.attempts[0].result)
  const report = aggregate(fixture)
  const instances = [
    ['benchmark-run-manifest.v2.json', fixture.manifest],
    ['benchmark-attempt-evidence.v2.json', fixture.attempts[0]],
    ['benchmark-result-bundle.v2.json', resultBundle],
    ['benchmark-session.v2.json', fixture.attempts[0].sessions[0]],
    ['benchmark-pricing.v2.json', fixture.pricing],
    ['benchmark-snapshot.v2.json', fixture.promoted.snapshotManifest],
    ['benchmark-upload-spool.v2.json', spool],
    ['benchmark-aggregate-report.v2.json', report],
    ['benchmark-route-holdout.v1.json', ROUTE_HOLDOUT_PROVENANCE],
    ['benchmark-mechanism-evidence.v1.json', mechanismSchemaFixture()],
  ].map(([name, instance]) => ({ schemaId: `https://autoprompt.dev/schemas/${name}`, instance }))
  assert.deepEqual(pythonSchemaErrors(instances), instances.map(() => []))
  const malformed = structuredClone(fixture.attempts[0]); malformed.system.unknown_field = true
  assert.ok(pythonSchemaErrors([{ schemaId: 'https://autoprompt.dev/schemas/benchmark-attempt-evidence.v2.json', instance: malformed }])[0].length > 0)

  const unsafePaths = ['/absolute.json', 'C:/drive.json', 'D:relative.json', '../escape.json', 'a/../escape.json', 'a\\escape.json', 'a//escape.json', './escape.json', `nul\u0000escape.json`, 'name:stream', 'CON', 'aux.txt', 'dir/LPT1.log', 'trailing.', 'trailing ', `control\u001f.json`, `delete\u007f.json`]
  const unsafeSpools = unsafePaths.map((relativePath, index) => {
    const changed = structuredClone(spool)
    changed.objects = [{ digest: index.toString(16).padStart(64, '0'), relativePath }]
    changed.checksum = evidence.digestRecord(changed, ['checksum'])
    assert.throws(() => evidence.validateSpool(changed), error => error.code === 'UPLOAD_SPOOL_INVALID')
    return { schemaId: 'https://autoprompt.dev/schemas/benchmark-upload-spool.v2.json', instance: changed }
  })
  assert.ok(pythonSchemaErrors(unsafeSpools).every(errors => errors.length > 0))
  assert.equal(evidence.normalizeEvidencePath('safe..name/report.json'), 'safe..name/report.json')

  let randomState = 0x6d2b79f5
  const next = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0 }
  const runtimeCases = [
    { schemaId: 'https://autoprompt.dev/schemas/benchmark-run-manifest.v2.json', instance: fixture.manifest, validate: value => {
      const unsigned = structuredClone(value); delete unsigned.manifestDigest; delete unsigned.signature
      return evidence.signManifest(unsigned, { signer: ROLE_KEYS.manifest.signer, trustRegistry: TRUST_REGISTRY, catalog: fixture.catalog })
    } },
    { schemaId: 'https://autoprompt.dev/schemas/benchmark-attempt-evidence.v2.json', instance: fixture.attempts[0], validate: value => evidence.validateAttemptShape(value, fixture.manifest, { evidenceRoot: fixture.evidenceRoot, trustRegistry: TRUST_REGISTRY }) },
    { schemaId: 'https://autoprompt.dev/schemas/benchmark-session.v2.json', instance: fixture.attempts[0].sessions[0], validate: value => evidence.validateSession(value) },
    { schemaId: 'https://autoprompt.dev/schemas/benchmark-result-bundle.v2.json', instance: resultBundle, validate: value => evidence.validateResultBundle(value) },
    { schemaId: 'https://autoprompt.dev/schemas/benchmark-pricing.v2.json', instance: fixture.pricing, validate: value => evidence.validatePricing(value) },
    { schemaId: 'https://autoprompt.dev/schemas/benchmark-upload-spool.v2.json', instance: spool, validate: value => evidence.validateSpool(value) },
    { schemaId: 'https://autoprompt.dev/schemas/benchmark-aggregate-report.v2.json', instance: report, validate: value => {
      const unsigned = structuredClone(value); delete unsigned.reportDigest; delete unsigned.signature
      return evidence.signAggregateReport(unsigned, { signer: ROLE_KEYS.aggregate.signer, trustRegistry: TRUST_REGISTRY })
    } },
  ]
  function objectPaths(value, prefix = []) {
    if (!value || typeof value !== 'object') return []
    const here = Array.isArray(value) ? [] : [prefix]
    return [...here, ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...prefix, key]))]
  }
  const mutations = Array.from({ length: 64 }, (_, index) => {
    const target = runtimeCases[next() % runtimeCases.length]
    const changed = structuredClone(target.instance)
    const candidates = objectPaths(changed).filter(parts => !parts.includes('costsByArm') && !parts.includes('terminalStates') && !parts.includes('signature'))
    const selected = candidates[next() % candidates.length]
    let cursor = changed
    for (const part of selected) cursor = cursor[part]
    cursor[`unexpected_${index}_${next().toString(16)}`] = true
    if (Object.hasOwn(changed, 'checksum')) changed.checksum = evidence.digestRecord(changed, ['checksum'])
    assert.throws(() => target.validate(changed))
    return { schemaId: target.schemaId, instance: changed }
  })
  assert.ok(pythonSchemaErrors(mutations).every(errors => errors.length > 0))

  const conditionals = []
  const positiveDiagnosis = structuredClone(fixture.manifest); positiveDiagnosis.canaries.definitions[0].expectedDiagnosis = 'WRONG_MODEL'
  const negativeWithoutDiagnosis = structuredClone(fixture.manifest); delete negativeWithoutDiagnosis.canaries.definitions[1].expectedDiagnosis
  for (const changed of [positiveDiagnosis, negativeWithoutDiagnosis]) {
    const unsigned = structuredClone(changed); delete unsigned.manifestDigest; delete unsigned.signature
    assert.throws(() => evidence.signManifest(unsigned, { signer: ROLE_KEYS.manifest.signer, trustRegistry: TRUST_REGISTRY, catalog: fixture.catalog }), error => error.code === 'MANIFEST_CANARIES_INVALID')
    conditionals.push({ schemaId: 'https://autoprompt.dev/schemas/benchmark-run-manifest.v2.json', instance: changed })
  }
  const resultWithoutAuthority = structuredClone(resultBundle); delete resultWithoutAuthority.authoritySignatureSha256
  assert.throws(() => evidence.validateResultBundle(resultWithoutAuthority), error => error.code === 'RESULT_BUNDLE_INVALID')
  conditionals.push({ schemaId: 'https://autoprompt.dev/schemas/benchmark-result-bundle.v2.json', instance: resultWithoutAuthority })
  const sessionWithoutPartition = structuredClone(fixture.attempts[0].sessions[0]); sessionWithoutPartition.spans.pop()
  assert.throws(() => evidence.validateSession(sessionWithoutPartition), error => error.code === 'SESSION_SPAN_INVALID')
  const sessionMissingSpans = structuredClone(fixture.attempts[0].sessions[0]); delete sessionMissingSpans.spans
  assert.throws(() => evidence.validateSession(sessionMissingSpans))
  conditionals.push({ schemaId: 'https://autoprompt.dev/schemas/benchmark-session.v2.json', instance: sessionMissingSpans })
  const incompleteHumanHoldout = structuredClone(ROUTE_HOLDOUT_PROVENANCE)
  incompleteHumanHoldout.labels = { sourceKind: 'independent-human', independentlyHumanLabeled: true, raterCount: 1, agreement: { metric: null, value: null, evidenceSha256: null }, adjudicationEvidenceSha256: null }
  conditionals.push({ schemaId: 'https://autoprompt.dev/schemas/benchmark-route-holdout.v1.json', instance: incompleteHumanHoldout })
  const price = Object.values(fixture.pricing.models)[0]
  const legacyDuplicatePricing = structuredClone(fixture.pricing)
  legacyDuplicatePricing.models = [
    { provider: 'openai', model: 'fixture-model', version: '2026-08-22', ...price },
    { provider: 'openai', model: 'fixture-model', version: '2026-08-22', ...price },
  ]
  legacyDuplicatePricing.digest = evidence.digestRecord(legacyDuplicatePricing, ['digest'])
  assert.throws(() => evidence.validatePricing(legacyDuplicatePricing), error => error.code === 'PRICING_SCHEMA_INVALID')
  conditionals.push({ schemaId: 'https://autoprompt.dev/schemas/benchmark-pricing.v2.json', instance: legacyDuplicatePricing })
  const conditionalErrors = pythonSchemaErrors(conditionals)
  assert.ok(conditionalErrors.every(errors => errors.length > 0), JSON.stringify(conditionalErrors))
})

test('aggregation opens every byte, requires all canaries, signs the report, and preserves exact provenance', t => {
  const fixture = buildEvidenceFixture(t)
  const report = aggregate(fixture)
  assert.equal(report.controlledEffectEligible, false)
  assert.equal(report.analysisClass, 'descriptive-only')
  assert.equal(report.attempts.scored, 9)
  assert.equal(report.attempts.canaries, 45)
  assert.equal(report.canarySummary.ready, true)
  assert.equal(report.claimProvenance.immutable.length, 9)
  assert.equal(report.claimProvenance.livePartial.length, 0)
  assert.ok(report.evidenceObjects.some(object => object.relativePath.endsWith('/snapshot-manifest.json')))
  assert.ok(report.evidenceObjects.some(object => object.relativePath.endsWith('/SHA256SUMS')))
  for (const [name, descriptor] of Object.entries(fixture.inputEvidence)) {
    assert.deepEqual(report.reconstructionInputs[name], descriptor)
    assert.ok(report.evidenceObjects.some(object => object.relativePath === descriptor.relativePath && object.digest === descriptor.sha256))
  }
  assert.equal(evidence.readVerifiedJson(fixture.evidenceRoot, report.reconstructionInputs.trustRegistry).schemaVersion, 'benchmark-trust-registry.v2')
  assert.equal(report.executionLedger.complete, true)
  assert.equal(evidence.verifyAggregateReport(report, TRUST_REGISTRY), true)
  assert.equal(evidence.verifyAggregateReport({ ...report, signature: { ...report.signature, keyId: 'artifact-self-key' } }, TRUST_REGISTRY), false)
  assert.equal(evidence.verifyAggregateReport({ ...report, attempts: { ...report.attempts, total: 1 } }, TRUST_REGISTRY), false)
  assert.throws(() => aggregate(fixture, fixture.attempts.filter(item => item.attempt.attemptClass !== 'canary')), error => error.code === 'CANARY_MISSING')
  const missingScored = fixture.attempts.filter(item => item.attempt.attemptId !== fixture.manifest.plannedAttempts[0].attemptId)
  assert.throws(() => aggregate(fixture, missingScored), error => error.code === 'EVIDENCE_MISSING')
  const mid = fixture.attempts.find(item => item.attempt.attemptClass === 'canary' && item.attempt.stage === 'mid')
  const pre = fixture.attempts.find(item => item.attempt.attemptClass === 'canary' && item.attempt.stage === 'pre')
  const earlyMid = evidence.sealAttempt({ ...mid, checksum: undefined, startedAt: pre.startedAt, endedAt: pre.endedAt, system: pre.system })
  assert.throws(() => aggregate(fixture, fixture.attempts.map(item => item.attempt.attemptId === mid.attempt.attemptId ? earlyMid : item)), error => ['EVIDENCE_CHRONOLOGY_INVALID', 'EXECUTION_LEDGER_EVIDENCE_MISMATCH'].includes(error.code))
  fs.appendFileSync(path.join(fixture.evidenceRoot, fixture.inputEvidence.catalog.relativePath), 'tampered\n')
  assert.throws(() => aggregate(fixture), error => error.code === 'RECONSTRUCTION_INPUT_INVALID')
})

test('invented hashes, tampered bytes, malformed telemetry, late non-kill completion, and unclassified states fail', t => {
  const fixture = buildEvidenceFixture(t, 'adversarial-bytes')
  const first = fixture.attempts[0]
  const forged = evidence.sealAttempt({ ...first, checksum: undefined, result: { ...first.result, sha256: 'f'.repeat(64) } })
  assert.throws(() => aggregate(fixture, [forged, ...fixture.attempts.slice(1)]), error => error.code === 'EVIDENCE_RESULT_MISSING')
  const malformed = evidence.sealAttempt({ ...first, checksum: undefined, system: { ...first.system, unknown_field: true } })
  assert.throws(() => aggregate(fixture, [malformed, ...fixture.attempts.slice(1)]), error => error.code === 'EVIDENCE_SYSTEM_INVALID')
  const late = evidence.sealAttempt({ ...first, checksum: undefined, endedAt: new Date(Date.parse(first.startedAt) + fixture.manifest.budgets.hostKillMs + 1).toISOString() })
  assert.throws(() => aggregate(fixture, [late, ...fixture.attempts.slice(1)]), error => error.code === 'EVIDENCE_TIMEOUT_EXCEEDED')
  const unknownSystem = { ...fixture.systemCore, containerState: 'absent', exitCode: null }
  const unknown = evidence.sealAttempt({ ...first, checksum: undefined, system: { ...first.system, ...unknownSystem } })
  assert.throws(() => aggregate(fixture, [unknown, ...fixture.attempts.slice(1)]), error => ['EVIDENCE_SYSTEM_INVALID', 'EVIDENCE_HOST_KILL_INVALID', 'EVIDENCE_TERMINAL_INVALID'].includes(error.code))
  const unrelatedResult = evidence.sealAttempt({ ...first, checksum: undefined, result: first.harbor.grader.details })
  assert.throws(() => aggregate(fixture, [unrelatedResult, ...fixture.attempts.slice(1)]), error => ['EVIDENCE_RESULT_MISSING', 'RESULT_BUNDLE_INVALID'].includes(error.code))
  const otherScored = fixture.attempts.find(item => item.attempt.attemptClass === 'scored' && item.attempt.attemptId !== first.attempt.attemptId)
  const reboundResult = evidence.sealAttempt({ ...first, checksum: undefined, result: otherScored.result })
  assert.throws(() => aggregate(fixture, [reboundResult, ...fixture.attempts.slice(1)]), error => error.code === 'RESULT_BUNDLE_MISMATCH')
  fs.writeFileSync(path.join(fixture.promoted.snapshotPath, 'result.json'), 'tampered\n')
  assert.throws(() => aggregate(fixture), error => ['EVIDENCE_RESULT_MISSING', 'SNAPSHOT_CHECKSUM_MISMATCH'].includes(error.code))
})

test('session JSONL and embedded sessions have exact ancestry, content, and run-global uniqueness', t => {
  const fixture = buildEvidenceFixture(t, 'sessions')
  const first = fixture.attempts[0]
  assert.throws(() => evidence.parseSessionJsonl(JSON.stringify(first.sessions[0]), { attemptId: first.attempt.attemptId }), error => error.code === 'SESSION_JSONL_INCOMPLETE')
  const unrelated = fs.readFileSync(path.join(FIXTURES, 'unrelated-events.jsonl'))
  assert.throws(() => evidence.parseSessionJsonl(unrelated, { attemptId: first.attempt.attemptId }), error => error.code === 'SESSION_SCHEMA_INVALID')
  const gap = structuredClone(first.sessions[0]); gap.spans[1].startedAt = new Date(Date.parse(gap.spans[1].startedAt) + 1).toISOString()
  assert.throws(() => evidence.validateSession(gap), error => error.code === 'SESSION_SPAN_INVALID')
  const overlap = structuredClone(first.sessions[0]); overlap.spans[1].startedAt = new Date(Date.parse(overlap.spans[1].startedAt) - 1).toISOString()
  assert.throws(() => evidence.validateSession(overlap), error => error.code === 'SESSION_SPAN_INVALID')
  const missingUnknown = structuredClone(first.sessions[0]); missingUnknown.spans.pop()
  assert.throws(() => evidence.validateSession(missingUnknown), error => error.code === 'SESSION_SPAN_INVALID')
  const safeFirst = Buffer.from(first.attempt.attemptId).toString('base64url')
  const orphanSession = sessionFixture(first.attempt.attemptId, `${first.attempt.attemptId}:orphan`, 'missing-parent', 'missing-root')
  const orphan = evidence.sealAttempt({ ...first, checksum: undefined, sessions: [orphanSession], sessionLog: fixture.describe(`adversarial/orphan/${safeFirst}.jsonl`) })
  assert.throws(() => aggregate(fixture, [orphan, ...fixture.attempts.slice(1)]), error => error.code === 'SESSION_PARENT_MISSING')
  const scored = fixture.attempts.filter(item => item.attempt.attemptClass === 'scored')
  const second = scored[1]
  const duplicateFirstSession = sessionFixture(first.attempt.attemptId, 'globally-reused', null, 'globally-reused', { startedAt: first.sessions[0].startedAt, endedAt: first.sessions[0].endedAt })
  const duplicateSecondSession = sessionFixture(second.attempt.attemptId, 'globally-reused', null, 'globally-reused', { startedAt: second.sessions[0].startedAt, endedAt: second.sessions[0].endedAt })
  const safeSecond = Buffer.from(second.attempt.attemptId).toString('base64url')
  const changed = new Map([
    [first.attempt.attemptId, evidence.sealAttempt({ ...first, checksum: undefined, sessions: [duplicateFirstSession], sessionLog: fixture.describe(`adversarial/duplicate/${safeFirst}.jsonl`) })],
    [second.attempt.attemptId, evidence.sealAttempt({ ...second, checksum: undefined, sessions: [duplicateSecondSession], sessionLog: fixture.describe(`adversarial/duplicate/${safeSecond}.jsonl`) })],
  ])
  assert.throws(() => aggregate(fixture, fixture.attempts.map(item => changed.get(item.attempt.attemptId) || item)), error => error.code === 'SESSION_DUPLICATE')
})

test('execution ledger is durable, signed, contiguous, strictly chronological, and tamper evident', t => {
  const fixture = buildEvidenceFixture(t, 'ledger-adversarial')
  const bytes = fs.readFileSync(path.join(fixture.evidenceRoot, fixture.executionLedger.relativePath))
  const entries = evidence.parseExecutionLedger(bytes, { manifest: fixture.manifest, trustRegistry: TRUST_REGISTRY, requireComplete: true })
  assert.equal(entries.length, fixture.manifest.executionOrder.length)
  assert.throws(() => evidence.parseExecutionLedger(bytes.subarray(0, bytes.length - 1), { manifest: fixture.manifest, trustRegistry: TRUST_REGISTRY }), error => error.code === 'EXECUTION_LEDGER_TRUNCATED')

  const lines = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  const changed = structuredClone(lines[1])
  changed.predecessor = 'f'.repeat(64)
  const unsigned = { ...changed }; delete unsigned.entryDigest; delete unsigned.signature
  changed.entryDigest = evidence.digestRecord(unsigned)
  changed.signature = evidence.signRoleDigest('controller', changed.entryDigest, changed.endedAt, ROLE_KEYS.controller.signer)
  const rebound = [lines[0], changed, ...lines.slice(2)].map(evidence.canonicalStringify).join('\n') + '\n'
  assert.throws(() => evidence.parseExecutionLedger(rebound, { manifest: fixture.manifest, trustRegistry: TRUST_REGISTRY }), error => error.code === 'EXECUTION_LEDGER_CHAIN_INVALID')
  const untrusted = structuredClone(lines); untrusted[0].signature.keyId = 'artifact-key'
  assert.throws(() => evidence.parseExecutionLedger(untrusted.map(evidence.canonicalStringify).join('\n') + '\n', { manifest: fixture.manifest, trustRegistry: TRUST_REGISTRY }), error => error.code === 'EXECUTION_LEDGER_SIGNATURE_INVALID')

  const ledgerPath = path.join(fixture.directory, 'strict-time.jsonl')
  evidence.appendExecutionLedger(ledgerPath, {
    manifest: fixture.manifest, trustRegistry: TRUST_REGISTRY, signer: ROLE_KEYS.controller.signer,
    attemptId: fixture.manifest.executionOrder[0], startedAt: '2026-08-22T00:00:00.000Z', endedAt: '2026-08-22T00:00:00.010Z', terminalState: 'PASS', evidenceChecksum: '1'.repeat(64),
  })
  assert.throws(() => evidence.appendExecutionLedger(ledgerPath, {
    manifest: fixture.manifest, trustRegistry: TRUST_REGISTRY, signer: ROLE_KEYS.controller.signer,
    attemptId: fixture.manifest.executionOrder[1], startedAt: '2026-08-22T00:00:00.010Z', endedAt: '2026-08-22T00:00:00.020Z', terminalState: 'PASS', evidenceChecksum: '2'.repeat(64),
  }), error => error.code === 'EXECUTION_LEDGER_TIME_INVALID')
})

test('repair evidence must exactly bind the original planned task, arm, and repetition', t => {
  const fixture = buildEvidenceFixture(t, 'repair')
  const original = fixture.attempts[0]
  const repair = evidence.sealAttempt({
    ...original, checksum: undefined,
    attempt: { attemptId: 'repair-forged', attemptClass: 'repair', repairOfAttemptId: original.attempt.attemptId, taskId: 'wrong-task', armId: original.attempt.armId, repetition: original.attempt.repetition },
    result: null,
  })
  assert.throws(() => aggregate(fixture, [...fixture.attempts, repair]), error => error.code === 'EVIDENCE_UNKNOWN')
})

test('live partial evidence is descriptive and frozen/live provenance remains separate', t => {
  const fixture = buildEvidenceFixture(t, 'partial')
  const first = fixture.attempts[0]
  const deadlineAt = first.system.hostKill.deadlineAt
  const liveDir = path.join(fixture.evidenceRoot, 'live', 'live-source-a')
  fs.mkdirSync(liveDir, { recursive: true })
  const systemCore = { containerState: 'running', exitCode: null, signal: null, hostKillTriggered: false, cancelled: false, hostKill: { enforcer: 'external-process', deadlineAt, triggeredAt: null } }
  const harborCore = { status: 'running', result: null, reward: null, grader: null }
  write(path.join(liveDir, 'system.json'), `${evidence.canonicalStringify(systemCore)}\n`)
  write(path.join(liveDir, 'host-kill.json'), `${evidence.canonicalStringify(systemCore.hostKill)}\n`)
  write(path.join(liveDir, 'harbor.json'), `${evidence.canonicalStringify(harborCore)}\n`)
  write(path.join(liveDir, 'resources.json'), `${evidence.canonicalStringify(fixture.manifest.resources)}\n`)
  write(path.join(liveDir, 'sessions.jsonl'), `${evidence.canonicalStringify(first.sessions[0])}\n`)
  write(path.join(liveDir, 'artifacts', 'output.txt'), 'live partial artifact\n')
  const live = evidence.sealAttempt({
    ...first, checksum: undefined, endedAt: null, result: null, authority: null,
    resources: { ...fixture.manifest.resources, evidence: evidence.describeEvidenceFile(fixture.evidenceRoot, 'live/live-source-a/resources.json') },
    system: { ...systemCore, hostKill: { ...systemCore.hostKill, evidence: evidence.describeEvidenceFile(fixture.evidenceRoot, 'live/live-source-a/host-kill.json') }, evidence: evidence.describeEvidenceFile(fixture.evidenceRoot, 'live/live-source-a/system.json') },
    harbor: { ...harborCore, evidence: evidence.describeEvidenceFile(fixture.evidenceRoot, 'live/live-source-a/harbor.json') },
    artifacts: [evidence.describeEvidenceFile(fixture.evidenceRoot, 'live/live-source-a/artifacts/output.txt')],
    sessionLog: evidence.describeEvidenceFile(fixture.evidenceRoot, 'live/live-source-a/sessions.jsonl'),
    provenance: { kind: 'live-partial', sourceRunId: 'live-source-a', sourceRelativePath: 'live/live-source-a', observedAt: '2026-08-22T01:30:00.000Z' },
  })
  const attempts = [live, ...fixture.attempts.slice(1)]
  assert.throws(() => aggregate(fixture, attempts), error => ['NONTERMINAL_SCORED_ATTEMPT', 'EXECUTION_LEDGER_EVIDENCE_MISMATCH'].includes(error.code))
  const partialLedgerPath = path.join(fixture.evidenceRoot, 'ledger', 'partial.jsonl')
  const byId = new Map(fixture.attempts.map(record => [record.attempt.attemptId, record]))
  for (const attemptId of fixture.manifest.executionOrder.slice(0, fixture.manifest.executionOrder.indexOf(first.attempt.attemptId))) {
    const record = byId.get(attemptId)
    evidence.appendExecutionLedger(partialLedgerPath, { manifest: fixture.manifest, trustRegistry: TRUST_REGISTRY, signer: ROLE_KEYS.controller.signer, attemptId, startedAt: record.startedAt, endedAt: record.endedAt, terminalState: evidence.deriveTerminalState(record), evidenceChecksum: record.checksum })
  }
  const partialLedger = evidence.describeEvidenceFile(fixture.evidenceRoot, 'ledger/partial.jsonl')
  const report = aggregate(fixture, attempts, { allowLivePartial: true, executionLedger: partialLedger })
  assert.equal(report.controlledEffectEligible, false)
  assert.equal(report.analysisClass, 'descriptive-only')
  assert.equal(report.claimProvenance.livePartial[0].sourceRunId, 'live-source-a')
  assert.equal(report.claimProvenance.immutable.length, 8)
})

test('pricing reconstructs all four token categories and every fixed cost class', t => {
  const fixture = buildEvidenceFixture(t, 'pricing')
  const report = aggregate(fixture)
  const arm = report.costsByArm.base
  for (const field of ['model', 'host', 'storage', 'setup', 'canary', 'repair', 'scoredRun', 'total']) assert.equal(typeof arm[field], 'number')
  assert.ok(arm.model > 0 && arm.host > 0 && arm.storage > 0 && arm.setup > 0 && arm.canary > 0 && arm.scoredRun > 0)
  assert.deepEqual(report.tokensByArm.base, { noncachedInput: 14400, cachedInput: 3600, output: 5400, reasoning: 900 })
  assert.equal(report.costPerAcceptedSolve.base, arm.total / 3)
  assert.deepEqual(pythonSchemaErrors([{ schemaId: 'https://autoprompt.dev/schemas/benchmark-aggregate-report.v2.json', instance: report }]), [[]])
  const price = Object.values(fixture.pricing.models)[0]
  const wrong = { ...fixture.pricing, models: { [evidence.modelPriceKey({ provider: 'openai', model: 'fixture-model', version: 'wrong' })]: { ...price } } }
  wrong.digest = evidence.digestRecord(wrong, ['digest'])
  assert.throws(() => evidence.aggregateEvidence({ catalog: fixture.catalog, manifest: fixture.manifest, pricing: wrong, evidenceRoot: fixture.evidenceRoot, attempts: fixture.attempts, trustRegistry: TRUST_REGISTRY, executionLedger: fixture.executionLedger, inputEvidence: fixture.inputEvidence, reportSigner: ROLE_KEYS.aggregate.signer, generatedAt: '2026-08-22T02:00:00.000Z' }), error => error.code === 'RECONSTRUCTION_INPUT_MISMATCH')
})

test('spool claims are exclusive, backoff and stale recovery are bounded, and receipts are authenticated', t => {
  const directory = temporary(t, 'spool')
  const filename = path.join(directory, 'spool.json')
  evidence.createUploadSpool(filename, { spoolId: 'spool-a', manifestDigest: 'a'.repeat(64), objects: [{ digest: 'b'.repeat(64), relativePath: 'report.json' }], maxAttempts: 2, baseBackoffMs: 1000, maxBackoffMs: 4000, now: '2026-08-22T00:00:00.000Z' })
  let claimed = evidence.claimUpload(filename, { claimId: 'claim-a', ownerPid: 100, now: '2026-08-22T00:00:00.000Z' })
  assert.equal(claimed.state, 'UPLOADING')
  assert.throws(() => evidence.claimUpload(filename, { claimId: 'claim-b' }), error => error.code === 'UPLOAD_STATE_INVALID')
  assert.throws(() => evidence.recordUploadFailure(filename, { claimId: 'wrong', code: 'DENIED' }), error => error.code === 'UPLOAD_CLAIM_INVALID')
  let retry = evidence.recordUploadFailure(filename, { claimId: 'claim-a', code: 'DENIED', now: '2026-08-22T00:00:01.000Z' })
  assert.equal(retry.nextAttemptAt, '2026-08-22T00:00:02.000Z')
  assert.throws(() => evidence.requeueUpload(filename, { now: '2026-08-22T00:00:01.999Z' }), error => error.code === 'UPLOAD_BACKOFF_ACTIVE')
  evidence.requeueUpload(filename, { now: '2026-08-22T00:00:02.000Z' })
  claimed = evidence.claimUpload(filename, { claimId: 'claim-b', ownerPid: 101, now: '2026-08-22T00:00:02.000Z' })
  const terminal = evidence.recordUploadFailure(filename, { claimId: 'claim-b', code: 'DENIED', now: '2026-08-22T00:00:03.000Z' })
  assert.equal(terminal.state, 'EVIDENCE_INCOMPLETE')
  assert.equal(evidence.uploadHealth(terminal).healthy, false)

  const success = path.join(directory, 'success.json')
  evidence.createUploadSpool(success, { spoolId: 'spool-success', manifestDigest: 'a'.repeat(64), objects: [{ digest: 'c'.repeat(64), relativePath: 'report.json' }], maxAttempts: 2, baseBackoffMs: 1000, maxBackoffMs: 4000, now: '2026-08-22T00:00:00.000Z' })
  evidence.claimUpload(success, { claimId: 'claim-success', now: '2026-08-22T00:00:00.000Z' })
  const uploaded = evidence.recordUploadSuccess(success, { claimId: 'claim-success', receipt: receiptInput('2026-08-22T00:00:01.000Z') })
  assert.equal(evidence.loadUploadSpool(success, { trustRegistry: TRUST_REGISTRY }).state, 'UPLOADED')
  assert.throws(() => evidence.loadUploadSpool(success), error => error.code === 'UPLOAD_RECEIPT_INVALID')
  assert.equal(evidence.verifyUploadReceipt(uploaded, TRUST_REGISTRY), true)

  const stalePath = path.join(directory, 'stale.json')
  evidence.createUploadSpool(stalePath, { spoolId: 'spool-stale', manifestDigest: 'a'.repeat(64), objects: [{ digest: 'd'.repeat(64), relativePath: 'report.json' }], maxAttempts: 2, baseBackoffMs: 1000, maxBackoffMs: 4000, now: '2026-08-22T00:00:00.000Z' })
  const staleClaim = evidence.claimUpload(stalePath, { claimId: 'stale', now: '2026-08-22T00:00:00.000Z' })
  assert.equal(evidence.uploadHealth(staleClaim, { now: '2026-08-22T00:01:00.000Z', claimLeaseMs: 1000 }).stale, true)
  retry = evidence.recoverStaleUpload(stalePath, { now: '2026-08-22T00:01:00.000Z', claimLeaseMs: 1000 })
  assert.equal(retry.state, 'RETRY_WAIT')
  fs.writeFileSync(`${stalePath}.lock`, 'other\n')
  assert.throws(() => evidence.requeueUpload(stalePath, { now: '2026-08-22T00:01:01.000Z', nowMs: Date.now() }), error => error.code === 'UPLOAD_SPOOL_BUSY')
})

test('publication recomputes signed aggregate and authenticated upload state instead of trusting booleans', t => {
  const fixture = buildEvidenceFixture(t, 'publication')
  const report = aggregate(fixture)
  write(path.join(fixture.evidenceRoot, 'publication', 'aggregate.json'), `${evidence.canonicalStringify(report)}\n`)
  const reportEvidence = evidence.describeEvidenceFile(fixture.evidenceRoot, 'publication/aggregate.json')
  const maximumCostPerAcceptedSolve = Math.max(...Object.values(report.costPerAcceptedSolve))
  const publicationInput = { report, reportEvidence, evidenceRoot: fixture.evidenceRoot, trustRegistry: TRUST_REGISTRY, maximumCostPerAcceptedSolve }
  const filename = path.join(fixture.directory, 'upload.json')
  const publicationObjects = [{ digest: reportEvidence.sha256, relativePath: reportEvidence.relativePath }, ...report.evidenceObjects]
  evidence.createUploadSpool(filename, { spoolId: 'publish', manifestDigest: fixture.manifest.manifestDigest, objects: publicationObjects, maxAttempts: 1, baseBackoffMs: 1000, maxBackoffMs: 1000, now: '2026-08-22T02:00:00.000Z' })
  evidence.claimUpload(filename, { claimId: 'publish-claim', now: '2026-08-22T02:00:00.000Z' })
  const uploaded = evidence.recordUploadSuccess(filename, { claimId: 'publish-claim', receipt: receiptInput('2026-08-22T02:00:01.000Z') })
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, uploadSpools: [uploaded] }), error =>
    error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('FIXTURE_ONLY_EVIDENCE') &&
    !error.details.blockers.some(blocker => blocker.startsWith('COST_PER_ACCEPTED_SOLVE_')))
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, maximumCostPerAcceptedSolve: undefined, uploadSpools: [uploaded] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('COST_PER_ACCEPTED_SOLVE_THRESHOLD_INVALID'))
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, maximumCostPerAcceptedSolve: maximumCostPerAcceptedSolve / 2, uploadSpools: [uploaded] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('COST_PER_ACCEPTED_SOLVE_LIMIT_EXCEEDED'))
  const missingCostPerSolve = { ...report, costPerAcceptedSolve: { ...report.costPerAcceptedSolve, base: null } }
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, report: missingCostPerSolve, uploadSpools: [uploaded] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('COST_PER_ACCEPTED_SOLVE_MISSING'))
  const missingPath = path.join(fixture.directory, 'missing-upload.json')
  evidence.createUploadSpool(missingPath, { spoolId: 'publish-missing', manifestDigest: fixture.manifest.manifestDigest, objects: publicationObjects.slice(0, -1), maxAttempts: 1, baseBackoffMs: 1000, maxBackoffMs: 1000, now: '2026-08-22T02:00:00.000Z' })
  evidence.claimUpload(missingPath, { claimId: 'missing-claim', now: '2026-08-22T02:00:00.000Z' })
  const missing = evidence.recordUploadSuccess(missingPath, { claimId: 'missing-claim', receipt: receiptInput('2026-08-22T02:00:01.000Z') })
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, uploadSpools: [missing] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('UPLOAD_OBJECT_SET_MISMATCH'))
  for (const [name, descriptor] of Object.entries(report.reconstructionInputs)) {
    const inputMissingPath = path.join(fixture.directory, `missing-${name}.json`)
    evidence.createUploadSpool(inputMissingPath, { spoolId: `missing-${name}`, manifestDigest: fixture.manifest.manifestDigest, objects: publicationObjects.filter(object => object.relativePath !== descriptor.relativePath), maxAttempts: 1, baseBackoffMs: 1000, maxBackoffMs: 1000, now: '2026-08-22T02:00:00.000Z' })
    evidence.claimUpload(inputMissingPath, { claimId: `missing-${name}`, now: '2026-08-22T02:00:00.000Z' })
    const inputMissing = evidence.recordUploadSuccess(inputMissingPath, { claimId: `missing-${name}`, receipt: receiptInput('2026-08-22T02:00:01.000Z') })
    assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, uploadSpools: [inputMissing] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('UPLOAD_OBJECT_SET_MISMATCH'))
  }
  const extraPath = path.join(fixture.directory, 'extra-upload.json')
  evidence.createUploadSpool(extraPath, { spoolId: 'publish-extra', manifestDigest: fixture.manifest.manifestDigest, objects: [...publicationObjects, { digest: 'f'.repeat(64), relativePath: 'extra.json' }], maxAttempts: 1, baseBackoffMs: 1000, maxBackoffMs: 1000, now: '2026-08-22T02:00:00.000Z' })
  evidence.claimUpload(extraPath, { claimId: 'extra-claim', now: '2026-08-22T02:00:00.000Z' })
  const extra = evidence.recordUploadSuccess(extraPath, { claimId: 'extra-claim', receipt: receiptInput('2026-08-22T02:00:01.000Z') })
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, uploadSpools: [extra] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('UPLOAD_OBJECT_SET_MISMATCH'))
  const unrelatedPath = path.join(fixture.directory, 'unrelated-upload.json')
  evidence.createUploadSpool(unrelatedPath, { spoolId: 'publish-unrelated', manifestDigest: fixture.manifest.manifestDigest, objects: [{ digest: 'a'.repeat(64), relativePath: 'other.json' }], maxAttempts: 1, baseBackoffMs: 1000, maxBackoffMs: 1000, now: '2026-08-22T02:00:00.000Z' })
  evidence.claimUpload(unrelatedPath, { claimId: 'unrelated-claim', now: '2026-08-22T02:00:00.000Z' })
  const unrelated = evidence.recordUploadSuccess(unrelatedPath, { claimId: 'unrelated-claim', receipt: receiptInput('2026-08-22T02:00:01.000Z') })
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, uploadSpools: [unrelated] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('UPLOAD_OBJECT_SET_MISMATCH'))
  const splitAt = Math.ceil(publicationObjects.length / 2)
  const firstHalfPath = path.join(fixture.directory, 'first-half-upload.json')
  const secondHalfPath = path.join(fixture.directory, 'second-half-upload.json')
  const overlap = publicationObjects[splitAt - 1]
  evidence.createUploadSpool(firstHalfPath, { spoolId: 'publish-first-half', manifestDigest: fixture.manifest.manifestDigest, objects: publicationObjects.slice(0, splitAt), maxAttempts: 1, baseBackoffMs: 1000, maxBackoffMs: 1000, now: '2026-08-22T02:00:00.000Z' })
  evidence.createUploadSpool(secondHalfPath, { spoolId: 'publish-second-half', manifestDigest: fixture.manifest.manifestDigest, objects: [overlap, ...publicationObjects.slice(splitAt)], maxAttempts: 1, baseBackoffMs: 1000, maxBackoffMs: 1000, now: '2026-08-22T02:00:00.000Z' })
  evidence.claimUpload(firstHalfPath, { claimId: 'first-half', now: '2026-08-22T02:00:00.000Z' })
  evidence.claimUpload(secondHalfPath, { claimId: 'second-half', now: '2026-08-22T02:00:00.000Z' })
  const firstHalf = evidence.recordUploadSuccess(firstHalfPath, { claimId: 'first-half', receipt: receiptInput('2026-08-22T02:00:01.000Z') })
  const secondHalf = evidence.recordUploadSuccess(secondHalfPath, { claimId: 'second-half', receipt: receiptInput('2026-08-22T02:00:01.000Z') })
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, uploadSpools: [firstHalf, secondHalf] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('UPLOAD_OBJECT_COLLISION'))
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, report: { ...report, controlledEffectEligible: false }, uploadSpools: [uploaded] }), error => error.code === 'PUBLICATION_BLOCKED')
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, trustRegistry: null, uploadSpools: [uploaded] }), error => error.code === 'PUBLICATION_BLOCKED')
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, reportEvidence: null, uploadSpools: [uploaded] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('AGGREGATE_EVIDENCE_INVALID'))
  fs.appendFileSync(path.join(fixture.evidenceRoot, reportEvidence.relativePath), 'tampered\n')
  assert.throws(() => evidence.assertPublicationReady({ ...publicationInput, uploadSpools: [uploaded] }), error => error.code === 'PUBLICATION_BLOCKED' && error.details.blockers.includes('AGGREGATE_EVIDENCE_INVALID'))
  assert.throws(() => evidence.assertPublicationReady({ report: { controlledEffectEligible: true, canarySummary: { ready: true } }, uploadSpools: [] }), error => error.code === 'PUBLICATION_BLOCKED')
})

test('real local runner consumes signed resources, collects structured output, and externally kills overruns', async t => {
  const producer = [
    "const fs=require('fs'),p=require('path'),o=process.env.AUTOPROMPT_EVALUATED_OUTPUT_DIR,id=process.env.AUTOPROMPT_BENCHMARK_ATTEMPT_ID",
    "fs.mkdirSync(p.join(o,'artifacts'),{recursive:true})",
    "fs.writeFileSync(p.join(o,'artifacts','answer.txt'),'evaluated output\\n')",
    "fs.writeFileSync(p.join(o,'sessions.jsonl'),JSON.stringify({schemaVersion:'benchmark-session.v2',sessionId:id+':root',parentSessionId:null,rootSessionId:id+':root',attemptId:id,role:'worker',model:{provider:'openai',name:'fixture-model',version:'2026-08-22'},startedAt:'2026-08-22T00:00:00.000Z',endedAt:'2026-08-22T00:00:01.000Z',usage:{inputTokens:1,cachedInputTokens:0,outputTokens:1,reasoningTokens:1},spans:[{spanId:id+':span',kind:'execution',startedAt:'2026-08-22T00:00:00.000Z',endedAt:'2026-08-22T00:00:01.000Z'}]})+'\\n')",
  ].join(';')
  const timeoutProducer = `${producer};setInterval(()=>{},1000)`
  const normalCommand = [process.execPath, '-e', producer]
  const timeoutCommand = [process.execPath, '-e', timeoutProducer]
  const { catalog, manifest } = signedFixture({ agentTimeoutMs: 25, verifierTimeoutMs: 2000, hostKillMs: 3000 }, { base: normalCommand, current: timeoutCommand, redesign: normalCommand })
  const directory = temporary(t, 'runner')
  const evidenceRoot = path.join(directory, 'evidence')
  fs.mkdirSync(evidenceRoot, { recursive: true })
  materializeControls(evidenceRoot)
  const leaseRegistryPath = path.join(directory, 'run-leases.json')
  evidence.createRunLeaseRegistry(leaseRegistryPath, { registryId: 'runner-registry', issuer: manifest.runLease.issuer })
  const runLease = evidence.consumeRunLease(leaseRegistryPath, manifest, { now: '2026-08-22T00:00:00.001Z', consumptionId: 'runner-consumption' })
  assert.throws(() => evidence.consumeRunLease(leaseRegistryPath, manifest, { now: '2026-08-22T00:00:00.002Z' }), error => error.code === 'RUN_LEASE_REPLAY')
  const executionLedgerPath = path.join(evidenceRoot, 'ledger', 'runner.jsonl')
  const plan = manifest.plannedAttempts[0]
  for (const [index, attemptId] of manifest.executionOrder.slice(0, manifest.executionOrder.indexOf(plan.attemptId)).entries()) {
    evidence.appendExecutionLedger(executionLedgerPath, {
      manifest, trustRegistry: TRUST_REGISTRY, signer: ROLE_KEYS.controller.signer, attemptId,
      startedAt: new Date(Date.parse('2026-08-22T00:00:00.010Z') + index * 3).toISOString(),
      endedAt: new Date(Date.parse('2026-08-22T00:00:00.010Z') + index * 3 + 1).toISOString(),
      terminalState: 'PASS', evidenceChecksum: index.toString(16).padStart(64, '0'),
    })
  }
  const authorityModule = path.join(ROOT, 'scripts', 'benchmark-evidence', 'authority.cjs')
  const coreModule = path.join(ROOT, 'scripts', 'benchmark-evidence', 'core.cjs')
  const verifierKeyPath = path.join(directory, 'verifier-key.pem')
  write(verifierKeyPath, ROLE_KEYS.verifier.signer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  const verifier = [
    `const fs=require('fs'),p=require('path'),a=require(${JSON.stringify(authorityModule)}),c=require(${JSON.stringify(coreModule)}),o=process.env.AUTOPROMPT_VERIFIER_OUTPUT_DIR`,
    "const harbor={status:'completed',result:'pass',reward:1,grader:{verdict:'pass',score:1}},hb=c.canonicalStringify(harbor)+'\\n',vb='{\"verified\":true}\\n'",
    "fs.writeFileSync(p.join(o,'harbor.json'),hb);fs.writeFileSync(p.join(o,'grader-details.json'),vb)",
    "const producer={name:process.env.AUTOPROMPT_BENCHMARK_PRODUCER_NAME,version:process.env.AUTOPROMPT_BENCHMARK_PRODUCER_VERSION,buildDigest:process.env.AUTOPROMPT_BENCHMARK_PRODUCER_BUILD_DIGEST}",
    "const att=a.signVerifierAttestation({manifestDigest:process.env.AUTOPROMPT_BENCHMARK_MANIFEST_DIGEST,taskId:process.env.AUTOPROMPT_BENCHMARK_TASK_ID,attemptId:process.env.AUTOPROMPT_BENCHMARK_ATTEMPT_ID,issuedAt:new Date().toISOString(),verdict:'pass',reward:1,grader:{verdict:'pass',score:1},producer,rawHarborSha256:c.sha256(hb),verifierSha256:c.sha256(vb),resourceEvidenceSha256:c.sha256(fs.readFileSync(process.env.AUTOPROMPT_BENCHMARK_RESOURCE_EVIDENCE_PATH))},{privateKey:fs.readFileSync(process.env.AUTOPROMPT_VERIFIER_KEY_HANDLE,'utf8'),issuer:process.env.AUTOPROMPT_VERIFIER_ISSUER,keyId:process.env.AUTOPROMPT_VERIFIER_KEY_ID})",
    "fs.writeFileSync(p.join(o,'verifier-env.json'),JSON.stringify(process.env)+'\\n')",
    "fs.writeFileSync(p.join(o,'verifier-attestation.json'),c.canonicalStringify(att)+'\\n')",
  ].join(';')
  const verifierEnv = {
    AUTOPROMPT_VERIFIER_KEY_HANDLE: verifierKeyPath,
    AUTOPROMPT_VERIFIER_ISSUER: ROLE_KEYS.verifier.signer.issuer,
    AUTOPROMPT_VERIFIER_KEY_ID: ROLE_KEYS.verifier.signer.keyId,
  }
  const hostEnvironment = { ...process.env, AUTOPROMPT_BENCHMARK_CONTROLLER_PRIVATE_KEY: 'controller-secret-sentinel', AUTOPROMPT_BENCHMARK_AGGREGATE_PRIVATE_KEY: 'aggregate-secret-sentinel' }
  const common = { manifest, catalog, trustRegistry: TRUST_REGISTRY, resources: manifest.resources, evidenceRoot, costs: { hostSeconds: 1, storageByteMonths: 1, setupUnits: 1 }, leaseRegistryPath, runLease, executionLedgerPath, controllerSigner: ROLE_KEYS.controller.signer, hostEnvironment }
  assert.throws(() => evidence.buildVerifierEnvironment({ verifierEnv: { AUTOPROMPT_VERIFIER_PRIVATE_KEY: 'forbidden' } }), error => error.code === 'VERIFIER_ENV_INVALID')
  await assert.rejects(() => evidence.runLocalAttempt({ ...common, attemptId: plan.attemptId, command: normalCommand, snapshotId: 'runner-no-verifier' }), error => error.code === 'VERIFIER_SIGNER_REQUIRED')
  await assert.rejects(() => evidence.runLocalAttempt({ ...common, attemptId: plan.attemptId, command: normalCommand, verifierCommand: [process.execPath, '-e', verifier], verifierEnv: { AUTOPROMPT_VERIFIER_ISSUER: verifierEnv.AUTOPROMPT_VERIFIER_ISSUER, AUTOPROMPT_VERIFIER_KEY_ID: verifierEnv.AUTOPROMPT_VERIFIER_KEY_ID }, snapshotId: 'runner-incomplete-verifier' }), error => error.code === 'VERIFIER_SIGNER_REQUIRED')
  await assert.rejects(() => evidence.runLocalAttempt({ ...common, attemptId: plan.attemptId, command: normalCommand, verifierCommand: [process.execPath, '-e', verifier], verifierEnv: { ...verifierEnv, AUTOPROMPT_VERIFIER_KEY_ID: 'untrusted-verifier' }, snapshotId: 'runner-wrong-verifier' }), error => error.code === 'VERIFIER_SIGNER_UNTRUSTED')
  const completed = await evidence.runLocalAttempt({ ...common, attemptId: plan.attemptId, command: normalCommand, verifierCommand: [process.execPath, '-e', verifier], verifierEnv, snapshotId: 'runner-normal' })
  assert.equal(evidence.validateAttemptShape(completed.record, manifest, { evidenceRoot, trustRegistry: TRUST_REGISTRY }).terminalState, 'PASS')
  assert.notEqual(completed.record.authority, null)
  const verifierEnvironmentArtifact = completed.record.artifacts.find(item => item.relativePath.endsWith('/artifacts/controller-verifier/verifier-env.json'))
  assert.ok(verifierEnvironmentArtifact)
  const observedVerifierEnvironment = evidence.readVerifiedJson(evidenceRoot, verifierEnvironmentArtifact)
  assert.equal(observedVerifierEnvironment.AUTOPROMPT_BENCHMARK_CONTROLLER_PRIVATE_KEY, undefined)
  assert.equal(observedVerifierEnvironment.AUTOPROMPT_BENCHMARK_AGGREGATE_PRIVATE_KEY, undefined)
  assert.ok(Object.values(observedVerifierEnvironment).every(value => typeof value !== 'string' || !value.includes('PRIVATE KEY')))
  assert.throws(() => evidence.assertManifestResources(manifest, { ...manifest.resources, bucket: 'wrong' }), error => error.code === 'EVIDENCE_RESOURCE_MISMATCH')
  const timeoutPlan = manifest.plannedAttempts[1]
  await assert.rejects(() => evidence.runLocalAttempt({ ...common, attemptId: timeoutPlan.attemptId, command: normalCommand, verifierCommand: [process.execPath, '-e', verifier], verifierEnv, snapshotId: 'runner-mismatch' }), error => error.code === 'SCORED_EXECUTION_MISMATCH')
  const censored = await evidence.runLocalAttempt({ ...common, attemptId: timeoutPlan.attemptId, command: timeoutCommand, verifierCommand: [process.execPath, '-e', verifier], verifierEnv, snapshotId: 'runner-timeout' })
  assert.equal(censored.record.system.hostKillTriggered, true)
  assert.equal(evidence.validateAttemptShape(censored.record, manifest, { evidenceRoot, trustRegistry: TRUST_REGISTRY }).terminalState, 'CENSORED')
  assert.equal(producer.includes('CANARY_FAULT'), false)
  assert.equal(producer.includes('EXPECTED_DIAGNOSIS'), false)
})

test('negative canary fault and diagnosis remain controller-only during real child execution', async t => {
  const canaryProducer = [
    "const fs=require('fs'),p=require('path'),o=process.env.AUTOPROMPT_EVALUATED_OUTPUT_DIR,id=process.env.AUTOPROMPT_BENCHMARK_ATTEMPT_ID",
    "fs.mkdirSync(p.join(o,'artifacts'),{recursive:true})",
    "const visible=Object.fromEntries(Object.entries(process.env).filter(([key])=>/(FAULT|DIAGNOSIS|POLARITY|CANARY_ID)/.test(key)))",
    "fs.writeFileSync(p.join(o,'artifacts','controller-env.json'),JSON.stringify(visible)+'\\n')",
    "fs.writeFileSync(p.join(o,'canary.json'),JSON.stringify({checks:{'model-version':'fail'}})+'\\n')",
    "fs.writeFileSync(p.join(o,'sessions.jsonl'),JSON.stringify({schemaVersion:'benchmark-session.v2',sessionId:id+':root',parentSessionId:null,rootSessionId:id+':root',attemptId:id,role:'worker',model:{provider:'openai',name:'fixture-model',version:'2026-08-22'},startedAt:'2026-08-22T00:00:00.020Z',endedAt:'2026-08-22T00:00:00.021Z',usage:{inputTokens:1,cachedInputTokens:0,outputTokens:1,reasoningTokens:1},spans:[{spanId:id+':execution',kind:'execution',startedAt:'2026-08-22T00:00:00.020Z',endedAt:'2026-08-22T00:00:00.021Z'}]})+'\\n')",
  ].join(';')
  const canaryCommand = [process.execPath, '-e', canaryProducer]
  const faultCommand = [process.execPath, '-e', 'process.exit(0)']
  const { catalog, manifest } = signedFixture({}, { canary: canaryCommand, faultInjector: faultCommand })
  const directory = temporary(t, 'canary-runner')
  const evidenceRoot = path.join(directory, 'evidence')
  fs.mkdirSync(evidenceRoot, { recursive: true })
  materializeControls(evidenceRoot)
  const leaseRegistryPath = path.join(directory, 'run-leases.json')
  evidence.createRunLeaseRegistry(leaseRegistryPath, { registryId: 'canary-runner-registry', issuer: manifest.runLease.issuer })
  const runLease = evidence.consumeRunLease(leaseRegistryPath, manifest, { now: '2026-08-22T00:00:00.001Z', consumptionId: 'canary-runner-consumption' })
  const executionLedgerPath = path.join(evidenceRoot, 'ledger', 'canary-runner.jsonl')
  const target = evidence.buildCanaryAttempts(manifest).find(item => item.stage === 'pre' && item.canaryId === 'wrong-model-negative' && item.armId === 'base')
  const prefix = manifest.executionOrder.slice(0, manifest.executionOrder.indexOf(target.attemptId))
  for (const [index, attemptId] of prefix.entries()) evidence.appendExecutionLedger(executionLedgerPath, {
    manifest, trustRegistry: TRUST_REGISTRY, signer: ROLE_KEYS.controller.signer, attemptId,
    startedAt: new Date(Date.parse('2026-08-22T00:00:00.002Z') + index * 3).toISOString(),
    endedAt: new Date(Date.parse('2026-08-22T00:00:00.003Z') + index * 3).toISOString(),
    terminalState: 'PASS', evidenceChecksum: (index + 1).toString(16).padStart(64, '0'),
  })
  const completed = await evidence.runLocalAttempt({
    manifest, catalog, trustRegistry: TRUST_REGISTRY, resources: manifest.resources, evidenceRoot,
    attemptId: target.attemptId, command: canaryCommand, faultInjectorCommand: faultCommand,
    costs: { hostSeconds: 1, storageByteMonths: 1, setupUnits: 1 }, leaseRegistryPath, runLease,
    executionLedgerPath, controllerSigner: ROLE_KEYS.controller.signer, snapshotId: 'runner-canary-negative',
    startedAt: '2026-08-22T00:00:00.020Z', endedAt: '2026-08-22T00:00:00.021Z',
  })
  assert.deepEqual(completed.record.canary, { passed: true, diagnosis: 'WRONG_MODEL', evidence: completed.record.canary.evidence, controllerEvidence: completed.record.canary.controllerEvidence })
  const environmentArtifact = completed.record.artifacts.find(item => item.relativePath.endsWith('/artifacts/evaluated/artifacts/controller-env.json'))
  assert.ok(environmentArtifact)
  assert.deepEqual(evidence.readVerifiedJson(evidenceRoot, environmentArtifact), {})
  const controller = evidence.readVerifiedJson(evidenceRoot, completed.record.canary.controllerEvidence)
  assert.equal(controller.injectedFault, 'wrong-model')
  assert.equal(Object.hasOwn(controller, 'expectedDiagnosis'), false)
})

test('file, catalog, and structured-session collector helpers fail closed on unsafe or malformed input', t => {
  const directory = temporary(t, 'collector-helpers')
  const catalog = catalogFixture()
  const catalogPath = path.join(directory, 'catalog.json')
  write(catalogPath, `${evidence.canonicalStringify(catalog)}\n`)
  assert.equal(evidence.loadTaskCatalog(catalogPath, TRUST_REGISTRY).digest, catalog.digest)
  write(catalogPath, '{}\n')
  assert.throws(() => evidence.loadTaskCatalog(catalogPath, TRUST_REGISTRY), error => error.code === 'TASK_CATALOG_INVALID')

  const sessionPath = path.join(directory, 'sessions.jsonl')
  const session = sessionFixture('attempt-helper')
  assert.equal(evidence.writeSessionJsonl(sessionPath, [session], { attemptId: 'attempt-helper' }).length, 1)
  assert.throws(() => evidence.validateSessionSet([{ ...session, parentSessionId: 'missing' }], { attemptId: 'attempt-helper' }), error => error.code === 'SESSION_PARENT_MISSING')

  const root = path.join(directory, 'evidence')
  fs.mkdirSync(root)
  write(path.join(root, 'bad.json'), '{not-json}\n')
  const bad = evidence.describeEvidenceFile(root, 'bad.json')
  assert.throws(() => evidence.readVerifiedJson(root, bad), error => error.code === 'EVIDENCE_JSON_INVALID')
  assert.throws(() => evidence.resolveContained(root, '../escape'), error => error.code === 'EVIDENCE_PATH_INVALID')
  assert.throws(() => evidence.resolveContained(path.join(directory, 'missing'), 'x'), error => error.code === 'EVIDENCE_ROOT_INVALID')
  assert.throws(() => evidence.validateBlobDescriptor({ relativePath: 'x', sha256: 'bad', bytes: 1 }), error => error.code === 'EVIDENCE_BLOB_INVALID')
  assert.throws(() => evidence.resolveContained(root, 'bad.json', { directory: true }), error => error.code === 'EVIDENCE_PATH_INVALID')

  const runnerConfig = path.join(directory, 'untrusted-runner-config.json')
  write(runnerConfig, `${JSON.stringify({ trustRegistryPath: 'artifact-supplied-trust.json', runLeasePath: 'lease.json' })}\n`)
  const runner = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'benchmark-evidence', 'runner.cjs'), runnerConfig], { encoding: 'utf8', windowsHide: true })
  assert.equal(runner.status, 1)
  assert.match(runner.stderr, /RUNNER_CONFIG_INVALID: trust registry authority cannot be supplied by the run request/)
})
