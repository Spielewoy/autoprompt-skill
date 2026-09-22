'use strict'
// Controller regression fixtures only. These records never enter release trust.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const canary = require('../../scripts/harness-v2-canary.cjs')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const ROOT = path.resolve(__dirname, '../..')
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 })
}
function fixture(t, provider, usePolicy = false, nativeSnapshot = false) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-local-proof-safety-')))
  if (!nativeSnapshot) t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  fs.mkdirSync(target)
  assert.equal(cp.spawnSync('git', ['init', '-b', 'fixture', target]).status, 0)
  const sources = ['scripts/local-only-safety.cjs', 'scripts/harness-v2-canary.cjs']
  if (nativeSnapshot) {
    const add = directory => {
      for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes:true })) {
        const relative = `${directory}/${entry.name}`
        if (entry.isDirectory() && directory.startsWith('agents/contracts')) add(relative)
        else if (entry.isFile() && /\.(?:js|json|ps1)$/.test(entry.name)) sources.push(relative)
      }
    }
    add('agents/codex/workflow'); add('agents/contracts')
  }
  const files = Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))]))
  files['tests/native-fixture.cjs'] = hash('unit-only fixture')
  const portableBody = { schemaVersion:1, provider, platform:process.platform, architecture:process.arch,
    files:[['entrypoint/native', hash(fs.readFileSync(process.execPath))]] }
  const executable = { path:fs.realpathSync.native(process.execPath), sha256:portableBody.files[0][1], version:'fixture',
    runtimeIdentity:{ sha256:hash('unit-only local inventory'), fileCount:1, packageCount:0 },
    portableRuntimeIdentity:{ ...portableBody, sha256:hash(JSON.stringify(portableBody)), fileCount:1, packageCount:0 } }
  const initial = { files, payloadDigest:hash('pending receipt') }
  const review = { schemaVersion:'harness-v2-reviewed-local-canary.v1', policy:'reviewed-local-release-v1', provider, status:'reviewed',
    releaseScope:canary.portableIdentity(provider, initial, executable), releaseIdentityHash:canary.releaseIdentity(provider, initial, executable),
    protocol:{ source:sources[0], sha256:files[sources[0]] }, canaryImplementation:{ source:sources[1], sha256:files[sources[1]] },
    capabilityCases:Object.fromEntries(canary.REQUIRED.map(capability => [capability, { source:'tests/native-fixture.cjs', sha256:files['tests/native-fixture.cjs'], testName:`unit-only native ${capability}` }])),
    liveEvidence:[{ id:'unit-only-not-live-evidence', sha256:hash('fixture') }],
    reviewer:{ issuer:'unit-only-not-release-authority', reviewId:'unit-fixture-12345' },
    issuedAt:new Date(Date.now() - 60000).toISOString(), expiresAt:new Date(Date.now() + 60000).toISOString() }
  review.reviewDigest = hash(canary.canonical(review))
  const policy = { schemaVersion: 'harness-v2-local-canary-policy.v1', provider,
    platforms: ['linux', 'win32', 'darwin'], architectures: ['x64', 'arm64'],
    protocol: sources[0], canaryImplementation: sources[1],
    capabilityCases: Object.fromEntries(Object.entries(review.capabilityCases).map(([key, value]) =>
      [key, { source: value.source, testName: value.testName }])) }
  const evidenceBytes = JSON.stringify({ schemaVersion:'harness-v2-live-conformance.v1', records:[],
    reviewedLocalRecords:[review], ...(usePolicy ? { localCanaryPolicies: [policy] } : {}) })
  files['scripts/harness-v2-trust/evidence.json'] = hash(evidenceBytes)
  const receipt = { schemaVersion:2, provider, contractVersion:'2.0.0', files, payloadDigest:hash(JSON.stringify(files)) }
  if (usePolicy) Object.assign(review, canary.verifyPolicy(policy, provider, receipt, executable))
  receipt.payloadGeneration = `${provider}-v2.0.0-${receipt.payloadDigest.slice(0, 16)}`
  const bundle = path.join(root, '.autoprompt-private', 'bundles', receipt.payloadGeneration)
  for (const file of sources) write(path.join(bundle, file), fs.readFileSync(path.join(ROOT, file)))
  write(path.join(bundle, 'tests/native-fixture.cjs'), 'unit-only fixture')
  write(path.join(bundle, 'scripts/harness-v2-trust/evidence.json'), evidenceBytes)
  write(path.join(root, `.autoprompt-${provider}-v2.json`), receipt)
  const activationId = `apv2-${'1'.repeat(32)}`, activationRoot = path.join(root, '.autoprompt-private', 'activations', activationId)
  const profilePath = path.join(activationRoot, 'profile.json')
  write(profilePath, { provider, contractVersion:'2.0.0', commandSandbox:'enforce', commandNetwork:false,
    configurationIsolation:'private-home-and-empty-launch-directory', implicitSkills:false, externalTools:false, nestedDispatch:false })
  const profileSha256 = hash(fs.readFileSync(profilePath))
  const proof = { schemaVersion:1, provider, nativeExecutable:executable.path, profilePath, profileSha256,
    checkerProfilePath:profilePath, checkerProfileSha256:profileSha256, selectedProfile:'autoprompt', checkerSelectedProfile:'autoprompt-checker',
    strictConfig:true, admissionTrust:{ kind:usePolicy ? 'local-canary-pending' : 'reviewed-local-pending', reviewDigest:review.reviewDigest } }
  const proofPath = path.join(activationRoot, 'enforcement-proof.json')
  write(proofPath, proof)
  const proofSha256 = hash(fs.readFileSync(proofPath)), challenge = crypto.randomBytes(32).toString('base64url')
  const record = { schemaVersion:2, providerId:provider, activationId, activationRoot,
    payloadDigest:receipt.payloadDigest, createdAt:new Date(Date.now() - 10000).toISOString(),
    target:{ realpath:fs.realpathSync.native(target) }, executable, connectionSha256:hash('fixture connection'), request:{ sha256:hash('fixture request') },
    capability:{ generation:1, expiresAt:new Date(Date.now() + (nativeSnapshot ? 600000 : 60000)).toISOString() },
    activationBoundary:{ enforcementProof:{ sha256:proofSha256 } } }
  const artifacts = canary.REQUIRED.map(capability => {
    const item = review.capabilityCases[capability], file = path.join(activationRoot, 'reviewed-local-canary', 'generation-1', `${capability}.json`)
    write(file, { schemaVersion:'harness-v2-closed-canary-observation.v1', capability, caseSha256:item.sha256, testName:item.testName,
      activationId, generation:1, challenge, requestSha256:record.request.sha256, target:record.target.realpath,
      executableSha256:executable.sha256, executableRuntimeIdentity:executable.runtimeIdentity, connectionSha256:record.connectionSha256,
      payloadDigest:receipt.payloadDigest, enforcementProofSha256:proofSha256, reviewDigest:review.reviewDigest, outputSha256:hash(capability) })
    return { capability, path:file, sha256:hash(fs.readFileSync(file)) }
  })
  record.reviewedLocalCanary = { reviewDigest:review.reviewDigest, releaseIdentityHash:review.releaseIdentityHash,
    executableSha256:executable.sha256, nativeRuntimeIdentity:executable.portableRuntimeIdentity,
    observedAt:new Date().toISOString(), challenge, artifacts,
    observations:artifacts.map(a => ({ capability:a.capability, status:'passed', caseSha256:review.capabilityCases[a.capability].sha256, observationSha256:a.sha256 })) }
  const recordPath = path.join(activationRoot, 'activation.json'); write(recordPath, record)
  const gitConfig = path.join(activationRoot, 'gitconfig'), ghConfig = path.join(activationRoot, 'gh')
  write(gitConfig, ''); fs.mkdirSync(ghConfig, { mode:0o700 })
  const safety = require(path.join(bundle, 'scripts/local-only-safety.cjs'))
  const env = safety.createSafeChildGitEnvironment(target, process.env, { expectedBranch:'fixture', configIsolationPath:gitConfig, ghConfigDir:ghConfig, enforcementProof:proof })
  const inspect = (repository = target) => safety.inspect(safety.discoverRepository(repository), 'fixture', env, { enforcementProof:proof }).channels.providerConnectorApiWriteToolDenial
  return { root, activationRoot, record, recordPath, inspect, artifacts }
}

test('Windows local canary safety admits only its live registered external checker snapshot', {
  skip: process.platform !== 'win32', timeout: 600000,
}, t => {
  const f = fixture(t, 'claude', true, true)
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  ensureWindowsPrivateAcl(f.activationRoot)
  const run = require('../../agents/codex/workflow/run-record.js').createRunRecord({
    targetPath:f.record.target.realpath, providerId:'claude', runId:f.record.activationId,
    readOnly:true, exactTree:true, canonicalProviderPrivateRoot:path.join(f.activationRoot, 'r'), assertStartBoundary:false,
  })
  f.record.status = 'active'
  f.record.supervisorRuntime = { runPath:run.runPath, runId:run.runId, targetIdentity:run.targetIdentity,
    metadataSha256:hash(fs.readFileSync(path.join(run.runPath, 'metadata.json'))), createdAt:new Date().toISOString() }
  write(f.recordPath, f.record)
  const native = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemCapture()
  const { CleanupRegistry } = require('../../agents/codex/workflow/finalizer.js')
  const { resolveCheckerSnapshotRoot, createWindowsCheckerRootValidator } = require('../../agents/codex/workflow/windows-checker-root.js')
  const registry = new CleanupRegistry({ ...run.paths.cleanupRegistry,
    fsImpl:Object.assign(Object.create(fs), { windowsCapture:native, windowsMutations:native }),
    allowedRoots:[f.activationRoot], controlBinding:{ activationId:f.record.activationId, generationId:1 },
    externalRootValidator:createWindowsCheckerRootValidator({ owner:f.record.activationId }),
  })
  const root = resolveCheckerSnapshotRoot({ snapshotRoot:path.join(f.activationRoot, 'checker-snapshots'),
    cleanupRegistry:registry, owner:f.record.activationId })
  t.after(() => {
    try { registry.run(); assert.equal(fs.existsSync(root), false) }
    finally { fs.rmSync(f.root, { recursive:true, force:true }) }
  })
  const snapshot = path.join(root, `${'b'.repeat(64)}-${'c'.repeat(16)}`)
  fs.mkdirSync(snapshot)
  assert.equal(cp.spawnSync('git', ['init', '-b', 'fixture', snapshot]).status, 0)
  // Exact path and valid native proof alone do not confer cleanup authority.
  assert.equal(f.inspect(snapshot).enforced, false)
  registry.register({ path:snapshot, kind:'checker-snapshot', owner:f.record.activationId })
  const accepted = f.inspect(snapshot)
  assert.equal(accepted.enforced, true, JSON.stringify(accepted))
  f.record.capability.generation++
  write(f.recordPath, f.record)
  assert.equal(f.inspect(snapshot).enforced, false)
})
for (const provider of ['claude', 'reasonix']) for (const usePolicy of [false, true]) test(`${provider} ${usePolicy ? 'native policy' : 'release review'} safety reopens local proof and refuses changed generation or linked artifacts`, t => {
  const f = fixture(t, provider, usePolicy)
  assert.equal(f.inspect().enforced, true, JSON.stringify(f.inspect()))
  f.record.capability.generation++
  write(f.recordPath, f.record)
  assert.equal(f.inspect().enforced, false)
  f.record.capability.generation--
  write(f.recordPath, f.record)
  assert.equal(f.inspect().enforced, true)
  for (const [relative, allowed] of [[`worker-workspaces/workspaces/${'a'.repeat(40)}`, true], [`checker-snapshots/${'b'.repeat(64)}-${'c'.repeat(16)}`, true], ['unrelated-project', false]]) {
    const repo = path.join(f.activationRoot, relative); fs.mkdirSync(repo, { recursive:true, mode:0o700 })
    assert.equal(cp.spawnSync('git', ['init', '-b', 'fixture', repo]).status, 0)
    assert.equal(f.inspect(repo).enforced, allowed, relative)
  }
  const artifact = f.artifacts[0].path, outside = path.join(f.root, 'linked-artifact.json')
  fs.renameSync(artifact, outside); fs.symlinkSync(outside, artifact)
  assert.equal(f.inspect().enforced, false)
})
