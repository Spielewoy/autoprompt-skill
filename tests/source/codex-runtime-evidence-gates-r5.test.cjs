'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const evidence = require(path.join(ROOT, 'scripts', 'benchmark-evidence'))
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'codex-v2-conformance')
const failureCorpus = require(path.join(FIXTURES, 'failure-taxonomy.json'))
const economicCorpus = require(path.join(FIXTURES, 'economic-route-envelope.json'))
const rolePolicy = require(path.join(ROOT, 'agents', 'codex', 'agents', 'role-policy.json'))
const { buildCheckerContext, writeRequestEnvelope } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'context-envelope.js'))
const H = 'a'.repeat(64)
const QUALITY_POLICY_PATH = path.join(ROOT, 'scripts', 'benchmark-evidence', 'release-quality-policy.json')
const QUALITY_POLICY = evidence.loadReleaseQualityPolicy(QUALITY_POLICY_PATH)

function canaryGateManifest() {
  const blob = { relativePath: 'x', sha256: H, bytes: 1 }
  const execution = { argv: ['node'], environment: blob, toolchain: blob }
  const canaryExecution = faultInjector => ({ argv: ['node'], input: blob, fixture: blob, environment: blob, toolchain: blob, faultInjector })
  const fault = name => ({ name, argv: ['node'], artifact: blob })
  const definitions = [
    { canaryId: 'positive', polarity: 'positive', checks: ['model-version', 'auth', 'tools', 'verifier', 'subagents', 'transcript', 'upload'], execution: canaryExecution(null) },
    ['wrong-model', 'WRONG_MODEL', 'model-version'], ['missing-subagent-trace', 'MISSING_SUBAGENT_TRACE', 'subagents'],
    ['broken-verifier', 'BROKEN_VERIFIER', 'verifier'], ['upload-denied', 'UPLOAD_DENIED', 'upload'],
  ].map(value => Array.isArray(value) ? { canaryId: value[0], polarity: 'negative', checks: [value[2]], expectedDiagnosis: value[1], execution: canaryExecution(fault(value[0])) } : value)
  const arms = ['base', 'current', 'redesign'].map((role, index) => ({ armId: role, role, producer: { name: role, version: '1', buildDigest: String(index + 1).repeat(64) }, execution }))
  const plannedAttempts = [
    { attemptId: 'scored-1', attemptClass: 'scored' }, { attemptId: 'scored-2', attemptClass: 'scored' },
  ]
  const manifest = { arms, canaries: { stages: ['pre', 'mid', 'post'], midAfterScoredAttempts: 1, definitions }, plannedAttempts }
  const canaries = evidence.buildCanaryAttempts(manifest)
  manifest.executionOrder = [...canaries.filter(item => item.stage === 'pre').map(item => item.attemptId), 'scored-1', ...canaries.filter(item => item.stage === 'mid').map(item => item.attemptId), 'scored-2', ...canaries.filter(item => item.stage === 'post').map(item => item.attemptId)]
  return { manifest, canaries }
}

function waitForMessages(children, count) {
  return new Promise((resolve, reject) => {
    const messages = []
    const timeoutMs = process.platform === 'win32' ? 60000 : 20000
    const timer = setTimeout(() => reject(new Error(`timed out after ${messages.length}/${count} messages`)), timeoutMs)
    for (const child of children) {
      child.on('error', reject)
      child.on('message', message => {
        messages.push({ child, message })
        if (messages.length === count) { clearTimeout(timer); resolve(messages) }
      })
    }
  })
}

function aggregateTrust() {
  const pair = crypto.generateKeyPairSync('ed25519')
  const signer = { privateKey: pair.privateKey, issuer: 'quality-fixture-issuer', keyId: 'quality-fixture-key' }
  const trustInput = {
    schemaVersion: 'benchmark-trust-registry.v2', catalogs: {}, roles: { aggregate: {
      issuer: signer.issuer, keyId: signer.keyId, algorithm: 'ed25519', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', fixtureOnly: false,
    } },
  }
  const trustRegistry = evidence.createTrustRegistry(trustInput)
  return { signer, trustInput, trustRegistry }
}

function qualityInput(treatmentAccepted = [true, true]) {
  return {
    schemaVersion: 'benchmark-paired-quality-evidence.v1', evidenceClass: 'controlled-effects', fixtureOnly: false,
    policy: { policyId: QUALITY_POLICY.policyId, policyDigest: QUALITY_POLICY.policyDigest },
    cohortId: 'focused-test-cohort', runManifestHash: H, issuedAt: '2026-08-23T12:00:00.000Z',
    pairs: treatmentAccepted.map((accepted, index) => ({
      pairId: `pair-${index + 1}`, taskId: `task-${index + 1}`, repetition: 1,
      baseline: { attemptId: `baseline-${index + 1}`, accepted: true, reward: 1, cost: 10, terminalState: 'PASS', snapshotHash: 'b'.repeat(64) },
      treatment: { attemptId: `treatment-${index + 1}`, accepted, reward: accepted ? 1 : 0, cost: 8, terminalState: accepted ? 'PASS' : 'FAIL', snapshotHash: 'c'.repeat(64) },
    })),
  }
}

function copyProductionSut(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.cpSync(path.join(ROOT, 'agents'), path.join(directory, 'agents'), { recursive: true })
  return directory
}

test('AP-TEST-014 scored launch requires successful pre-canary processes and passing observations', () => {
  const { manifest, canaries } = canaryGateManifest()
  const scored = manifest.plannedAttempts[0]
  const pre = canaries.filter(item => item.stage === 'pre')
  const passed = pre.map((item, index) => ({ attemptId: item.attemptId, terminalState: 'PASS', evidenceChecksum: String(index).padStart(64, '0') }))
  assert.deepEqual(evidence.assertCanaryLaunchReady(manifest, scored, passed), { ready: true, required: pre.length })
  const crashed = structuredClone(passed); crashed[2].terminalState = 'CRASH'
  assert.throws(() => evidence.assertCanaryLaunchReady(manifest, scored, crashed), error => error.code === 'CANARY_LAUNCH_BLOCKED' && error.details.blocked[0].terminalState === 'CRASH')
  assert.throws(() => evidence.assertCanaryLaunchReady(manifest, scored, passed.slice(1)), error => error.code === 'CANARY_LAUNCH_BLOCKED' && error.details.blocked[0].terminalState === 'MISSING')
})

test('AP-TEST-025 faults traverse production runtime-state records to every declared bounded result', t => {
  const result = evidence.replayFailureTaxonomy(failureCorpus, { command: [process.execPath, path.join(FIXTURES, 'failure-replay-child.cjs')], cwd: ROOT, timeoutMs: 3000 })
  assert.equal(result.ready, true)
  assert.deepEqual(result.results.map(item => item.boundary), failureCorpus.entries.map(item => item.expectedBoundary))
  const tampered = structuredClone(failureCorpus); tampered.entries[0].expectedBoundary = 'FAILED'
  assert.throws(() => evidence.replayFailureTaxonomy(tampered, { command: [process.execPath, path.join(FIXTURES, 'failure-replay-child.cjs')], cwd: ROOT }), error => error.code === 'FAILURE_REPLAY_MISMATCH')

  const mutatedRoot = copyProductionSut(t, 'autoprompt-failure-semantic-canary-')
  const timeoutOnly = { ...structuredClone(failureCorpus), entries: failureCorpus.entries.filter(item => item.id === 'non-return') }
  assert.equal(evidence.replayFailureTaxonomy(timeoutOnly, {
    command: [process.execPath, path.join(FIXTURES, 'failure-replay-child.cjs')], cwd: ROOT,
    env: { ...process.env, AUTOPROMPT_CONFORMANCE_SUT_ROOT: mutatedRoot }, timeoutMs: 3000,
  }).ready, true, 'isolated production copy must pass before semantic mutation')
  const machinePath = path.join(mutatedRoot, 'agents', 'contracts', 'state-machine.json')
  const machine = JSON.parse(fs.readFileSync(machinePath, 'utf8'))
  const timeoutTransition = machine.transitions.find(item => item.id === 'T022')
  assert.ok(timeoutTransition, 'production timeout transition must exist before mutation')
  timeoutTransition.id = 'T099'
  fs.writeFileSync(machinePath, `${JSON.stringify(machine, null, 2)}\n`)
  assert.throws(() => evidence.replayFailureTaxonomy(timeoutOnly, {
    command: [process.execPath, path.join(FIXTURES, 'failure-replay-child.cjs')], cwd: ROOT,
    env: { ...process.env, AUTOPROMPT_CONFORMANCE_SUT_ROOT: mutatedRoot }, timeoutMs: 3000,
  }), error => ['FAILURE_REPLAY_MISMATCH', 'FAILURE_REPLAY_PROCESS_FAILED'].includes(error.code))
})

test('AP-TEST-026 simultaneous supervisor contenders activate exactly one owner and write no loser identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-race-r5-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const targetPath = path.join(root, 'target'); const leaseRoot = path.join(root, 'leases'); fs.mkdirSync(targetPath)
  const worker = path.join(FIXTURES, 'lease-race-worker.cjs')
  const children = ['one', 'two'].map((name, index) => childProcess.fork(worker, [], { silent: true, windowsHide: true, env: { ...process.env, AUTOPROMPT_LEASE_RACE_INPUT: JSON.stringify({
    targetPath, leaseRoot, ledgerPath: path.join(targetPath, '.autoprompt'), runId: `run-${name}`, activationId: `activation-${name}`,
    missionHash: H, nonce: `nonce_${name.padEnd(16, String(index))}`, token: String(index + 1).repeat(48),
  }) } }))
  t.after(() => children.forEach(child => { if (!child.killed) child.kill() }))
  const ready = await waitForMessages(children, 2); assert.ok(ready.every(item => item.message.type === 'READY'))
  const outcomesReady = waitForMessages(children, 2)
  children.forEach(child => child.send('GO'))
  const outcomes = await outcomesReady
  const acquired = outcomes.filter(item => item.message.type === 'ACQUIRED')
  const rejected = outcomes.filter(item => item.message.type === 'REJECTED')
  assert.equal(acquired.length, 1); assert.equal(rejected.length, 1); assert.equal(rejected[0].message.code, 'WORKSPACE_LEASE_CONFLICT')
  const ownerFiles = fs.readdirSync(leaseRoot, { recursive: true }).filter(name => String(name).endsWith('owner.json'))
  assert.equal(ownerFiles.length, 1)
  const ownerBytes = fs.readFileSync(path.join(leaseRoot, ownerFiles[0]), 'utf8')
  assert.match(ownerBytes, new RegExp(acquired[0].message.activationId)); assert.doesNotMatch(ownerBytes, new RegExp(rejected[0].message.activationId))
  const released = new Promise((resolve, reject) => {
    acquired[0].child.once('error', reject)
    acquired[0].child.once('exit', resolve)
  })
  acquired[0].child.send('RELEASE')
  await released
})

test('AP-TEST-027 scheduler-backed route simulations measure emitted launch and token records against route caps', t => {
  const report = evidence.runEconomicRouteSimulations(economicCorpus, { command: [process.execPath, path.join(FIXTURES, 'route-simulation-child.cjs')], cwd: ROOT, timeoutMs: 10000 })
  assert.equal(report.conformant, true)
  assert.deepEqual(report.results.map(item => item.route), ['DIRECT', 'LIGHT', 'ROADMAP'])
  assert.deepEqual(report.results.map(item => item.measured.childLaunches), [3, 3, 3],
    'the compact automatic fixtures launch only analyst + one useful worker + one checker')
  assert.ok(report.results.every(item => item.measured.noncachedInputTokens > 0 && item.measured.outputTokens > 0 && item.measured.usefulWorkLatencyMs > 0))
  const tight = structuredClone(economicCorpus); tight.routeCaps.DIRECT.outputTokens = 1
  assert.throws(() => evidence.runEconomicRouteSimulations(tight, { command: [process.execPath, path.join(FIXTURES, 'route-simulation-child.cjs')], cwd: ROOT }), error => error.code === 'ECONOMIC_ROUTE_LIMIT_EXCEEDED')

  const mutatedRoot = copyProductionSut(t, 'autoprompt-scheduler-semantic-canary-')
  const directOnly = structuredClone(economicCorpus)
  directOnly.simulations = directOnly.simulations.filter(item => item.route === 'DIRECT')
  directOnly.routeCaps.DIRECT.childLaunches = report.results.find(item => item.route === 'DIRECT').measured.childLaunches
  assert.equal(evidence.runEconomicRouteSimulations(directOnly, {
    command: [process.execPath, path.join(FIXTURES, 'route-simulation-child.cjs')], cwd: ROOT,
    env: { ...process.env, AUTOPROMPT_CONFORMANCE_SUT_ROOT: mutatedRoot }, timeoutMs: 10000,
  }).conformant, true, 'isolated production copy must pass before semantic mutation')
  const schedulerPath = path.join(mutatedRoot, 'agents', 'codex', 'workflow', 'scheduler.js')
  const schedulerSource = fs.readFileSync(schedulerPath, 'utf8')
  const mutatedSource = schedulerSource.replace('this._metrics.totalLaunches++', 'this._metrics.totalLaunches += 2')
  assert.notEqual(mutatedSource, schedulerSource, 'production launch accounting mutation must be applied')
  fs.writeFileSync(schedulerPath, mutatedSource)
  assert.throws(() => evidence.runEconomicRouteSimulations(directOnly, {
    command: [process.execPath, path.join(FIXTURES, 'route-simulation-child.cjs')], cwd: ROOT,
    env: { ...process.env, AUTOPROMPT_CONFORMANCE_SUT_ROOT: mutatedRoot }, timeoutMs: 10000,
  }), error => ['ECONOMIC_ROUTE_LIMIT_EXCEEDED', 'ECONOMIC_SIMULATION_PROCESS_FAILED'].includes(error.code))
})

test('AP-TEST-028 release gate consumes paired aggregate-signed evidence and blocks quality regression or tampering', t => {
  const { signer, trustInput, trustRegistry } = aggregateTrust()
  const passing = evidence.signPairedQualityEvidence(qualityInput(), signer, QUALITY_POLICY)
  assert.equal(evidence.assertReleaseQualityReady({ qualityEvidence: passing, trustRegistry, qualityPolicy: QUALITY_POLICY }).ready, true)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-quality-r5-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const evidencePath = path.join(root, 'paired.json'); const trustPath = path.join(root, 'trust.json')
  fs.writeFileSync(evidencePath, `${JSON.stringify(passing)}\n`); fs.writeFileSync(trustPath, `${JSON.stringify(trustInput)}\n`)
  const cli = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'benchmark-evidence', 'quality-gate.cjs'), '--evidence', evidencePath, '--trust-registry', trustPath, '--policy', QUALITY_POLICY_PATH], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).ready, true)
  const regression = evidence.signPairedQualityEvidence(qualityInput([true, false]), signer, QUALITY_POLICY)
  assert.throws(() => evidence.assertReleaseQualityReady({ qualityEvidence: regression, trustRegistry, qualityPolicy: QUALITY_POLICY }), error => error.code === 'RELEASE_QUALITY_BLOCKED')
  const tampered = structuredClone(passing); tampered.pairs[0].treatment.reward = 0
  assert.throws(() => evidence.assertReleaseQualityReady({ qualityEvidence: tampered, trustRegistry, qualityPolicy: QUALITY_POLICY }), error => error.code === 'PAIRED_QUALITY_DIGEST_INVALID')
})

test('AP-TEST-030 zero heartbeat and every inherited resume value refuse before the counted spawn boundary', () => {
  let spawns = 0
  const launcher = () => { spawns += 1; return { launched: true } }
  for (const heartbeatIntervalSeconds of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => evidence.admitSupervisorSimulation({ heartbeatIntervalSeconds, environment: {} }, launcher), error => error.code === 'SUPERVISOR_HEARTBEAT_INVALID')
    assert.equal(spawns, 0, String(heartbeatIntervalSeconds))
  }
  for (const inherited of ['', '0', '1', 'false', 'true', '$autoprompt resume run-1']) {
    assert.throws(() => evidence.admitSupervisorSimulation({ heartbeatIntervalSeconds: 1, environment: { AUTOPROMPT_RESUME: inherited } }, launcher), error => error.code === 'INHERITED_RESUME_FORBIDDEN')
    assert.equal(spawns, 0, JSON.stringify(inherited))
  }
  assert.deepEqual(evidence.admitSupervisorSimulation({ heartbeatIntervalSeconds: 1, environment: {} }, launcher), { launched: true })
  assert.equal(spawns, 1)
})

test('AP-TEST-031 every L4 role loads the byte-identical request and ROADMAP context excludes history, roadmap, and prior verdicts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-l4-r5-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = Buffer.from('Preserve this exact ROADMAP request, including its newline.\n')
  const pointer = writeRequestEnvelope(root, original, { route: 'ROADMAP' })
  const capabilities = { eventStreaming: true, toolOutputCapture: true, stableChildIdentity: true, sameContextContinuation: true, isolatedChecking: true, cancellation: true }
  const l4Roles = Object.entries(rolePolicy.physical_roles).filter(([, policy]) => policy.layer === 'L4').map(([role]) => role).sort()
  assert.ok(l4Roles.length > 1)
  for (const role of l4Roles) {
    const recovery = role === 'ap-re-anchor' ? { purpose: 'recovery', forkTurns: 1, recoveryContext: { type: 'bounded-recovery', code: 'POST_COMPACTION_REANCHOR' } } : {}
    const context = buildCheckerContext({ role, route: 'ROADMAP', assignment: `Check as ${role}.`, requestPointer: pointer, expectedRequestHash: pointer.hash, candidateHash: H, providerCapabilities: capabilities, ...recovery }, { asBuffer: true })
    assert.deepEqual(context.exactRequest, original, role)
    assert.equal(context.exactRequestHash, pointer.hash, role)
    for (const excluded of ['roadmap', 'roadmapSlice', 'fullHistory', 'conversationHistory', 'priorVerdicts', 'foreignFrontier']) assert.equal(Object.hasOwn(context, excluded), false, `${role}:${excluded}`)
  }
})
