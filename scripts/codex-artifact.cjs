#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const TEMPLATE_ROOT = path.join(ROOT, 'packages', 'codex')
const HASH_PATTERN = /^[a-f0-9]{64}$/
const ARTIFACT_INVENTORY = 'artifact-inventory.json'
const RELEASE_MEASUREMENT_FIELDS = Object.freeze([
  'packedBytes', 'fileCount', 'externalDependencyCount',
])
const EXPLICIT_PACKAGE_FILES = Object.freeze([
  ['packages/codex/release-history.json', 'release-history.json'],
  ['scripts/install/codex-package-registry.json', 'scripts/install/codex-package-registry.json'],
  ['scripts/install/codex-discovery-shim.md', 'scripts/install/codex-discovery-shim.md'],
  ['scripts/install/legacy-codex-compat.json', 'scripts/install/legacy-codex-compat.json'],
  ['scripts/install/legacy-codex-role-hashes.json', 'scripts/install/legacy-codex-role-hashes.json'],
  ['scripts/install/legacy-compat.cjs', 'scripts/install/legacy-compat.cjs'],
  ['scripts/install/operation-lock.cjs', 'scripts/install/operation-lock.cjs'],
  ['scripts/runtime-payload.cjs', 'scripts/runtime-payload.cjs'],
  ['scripts/codex-runtime-identity.cjs', 'scripts/codex-runtime-identity.cjs'],
  ['scripts/codex-configure.cjs', 'scripts/codex-configure.cjs'],
  ['scripts/codex-evidence-bundle.cjs', 'scripts/codex-evidence-bundle.cjs'],
  ['scripts/codex-evidence/verification-bundle.cjs', 'scripts/codex-evidence/verification-bundle.cjs'],
  ['scripts/benchmark-evidence/core.cjs', 'scripts/benchmark-evidence/core.cjs'],
  ['agents/manifests/codex-runtime.json', 'agents/manifests/codex-runtime.json'],
])
const FROZEN_PROVIDER_ADMISSION_SHA256 = '70921cc6f09b742f31766a915d8a9ea30aaa267576e276b6e6081e6db74dd222'
const FROZEN_PROVIDER_CONTRACT_CORE_SHA256 = '5750d35c00d98503e6dbb11459ab4c1baba22ccf5dd56da41e3cdda14fca3745'
const { assertCurrentPublicFailEvidence } = require(
  './benchmark-evidence/codex-public-conformance.cjs')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function metadata(root = ROOT) {
  const packageTemplate = readJson(path.join(root, 'packages', 'codex', 'package.json'))
  const release = readJson(path.join(root, 'packages', 'codex', 'release.json'))
  const releaseHistory = readJson(path.join(root, 'packages', 'codex', 'release-history.json'))
  const packageRegistry = readJson(path.join(root, 'scripts', 'install', 'codex-package-registry.json'))
  const manifest = readJson(path.join(root, 'agents', 'manifests', 'codex-runtime.json'))
  const codexVersion = fs.readFileSync(path.join(root, 'agents', 'codex', 'VERSION'), 'utf8').trim()
  return { codexVersion, manifest, packageRegistry, packageTemplate, release, releaseHistory }
}

function releaseRecordDigest(record) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: record.version,
    payloadGeneration: record.payloadGeneration,
    payloadDigest: record.payloadDigest,
    previousRecordDigest: record.previousRecordDigest,
  })).digest('hex')
}

function semverTuple(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Codex release history requires stable semantic versions')
  return version.split('.').map(Number)
}

function compareSemver(left, right) {
  const a = semverTuple(left)
  const b = semverTuple(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function checkReleaseHistory(metadataRecord) {
  const { manifest, packageRegistry, packageTemplate, release, releaseHistory } = metadataRecord
  assert.equal(packageRegistry.releaseHistory?.path, 'packages/codex/release-history.json')
  assert.equal(packageRegistry.releaseHistory?.algorithm, 'sha256-chain-v1')
  assert.match(packageRegistry.releaseHistory?.genesisRecordDigest || '', HASH_PATTERN)
  assert.deepEqual(Object.keys(releaseHistory), ['schemaVersion', 'name', 'algorithm', 'releases'])
  assert.equal(releaseHistory.schemaVersion, 1)
  assert.equal(releaseHistory.name, packageTemplate.name)
  assert.equal(releaseHistory.algorithm, 'sha256-chain-v1')
  assert.ok(Array.isArray(releaseHistory.releases) && releaseHistory.releases.length >= 2,
    'Codex release history must preserve at least one predecessor')
  const versions = new Set()
  let previous = null
  for (const record of releaseHistory.releases) {
    assert.deepEqual(Object.keys(record), [
      'version', 'payloadGeneration', 'payloadDigest', 'previousRecordDigest', 'recordDigest',
    ])
    assert.equal(versions.has(record.version), false, `Codex release version reused: ${record.version}`)
    versions.add(record.version)
    assert.match(record.payloadDigest, HASH_PATTERN)
    assert.equal(record.payloadGeneration, `codex-v2.0.0-${record.payloadDigest.slice(0, 16)}`)
    assert.equal(record.previousRecordDigest, previous?.recordDigest || null)
    assert.equal(record.recordDigest, releaseRecordDigest(record),
      `Codex release history record was mutated: ${record.version}`)
    if (previous) assert.ok(compareSemver(record.version, previous.version) > 0,
      'Codex release history versions must increase monotonically')
    previous = record
  }
  assert.equal(releaseHistory.releases[0].recordDigest,
    packageRegistry.releaseHistory.genesisRecordDigest,
    'Codex release history genesis was replaced')
  assert.equal(release.historyPath, 'release-history.json')
  assert.equal(release.historyHeadDigest, previous.recordDigest)
  assert.equal(previous.version, packageTemplate.version)
  assert.equal(previous.payloadGeneration, manifest.payloadGeneration)
  assert.equal(previous.payloadDigest, manifest.payloadDigest)
  return previous
}

function checkRelease(root = ROOT) {
  const details = metadata(root)
  const { codexVersion, manifest, packageTemplate, release } = details
  assert.equal(packageTemplate.name, '@autoprompt-skill/codex-runtime')
  assert.equal(packageTemplate.private, true,
    'Codex source package template must remain private and directly unpublishable')
  assert.equal(packageTemplate.version, codexVersion,
    'Codex artifact package and provider VERSION must move together')
  const baseReleaseFields = [
    'schemaVersion', 'name', 'version', 'payloadGeneration', 'payloadDigest',
    'historyPath', 'historyHeadDigest',
  ]
  const measurementFields = RELEASE_MEASUREMENT_FIELDS.filter(field =>
    Object.prototype.hasOwnProperty.call(release, field))
  assert.ok(measurementFields.length === 0 || measurementFields.length === RELEASE_MEASUREMENT_FIELDS.length,
    'Codex release measurements must be absent or committed together')
  assert.deepEqual(Object.keys(release), [...baseReleaseFields, ...measurementFields])
  assert.equal(release.schemaVersion, 2)
  assert.equal(release.name, packageTemplate.name)
  assert.equal(release.version, packageTemplate.version)
  assert.equal(release.payloadGeneration, manifest.payloadGeneration,
    'Codex release payloadGeneration is stale; bump the artifact version and record the new generation')
  assert.equal(release.payloadDigest, manifest.payloadDigest,
    'Codex release payloadDigest reuse detected; bump the artifact version and bind the new digest')
  assert.match(release.payloadDigest, HASH_PATTERN)
  for (const field of measurementFields) {
    assert.equal(Number.isSafeInteger(release[field]) && release[field] > 0, true,
      `Codex release ${field} must be a positive integer`)
  }
  if (measurementFields.length) {
    assert.equal(release.externalDependencyCount, manifest.externalDependencies.length,
      'Codex release externalDependencyCount is stale')
  }
  checkReleaseHistory(details)
  return { codexVersion, manifest, packageTemplate, release }
}

function assertCanonicalReleaseTrust(root = ROOT, options = {}) {
  const configure = options.configure || require(path.join(root, 'scripts', 'codex-configure.cjs'))
  let runtimeIdentity
  let trustedPublicKeys
  try {
    runtimeIdentity = configure.deriveCurrentCodexRuntimeIdentity(options.identityOptions || {})
    trustedPublicKeys = configure.loadReleaseCodexTrustedPublicKeys({
      now: options.now,
      providerTrustedKeyRingPath: path.join(
        root, 'agents', 'contracts', 'codex-trusted-public-keys.json',
      ),
    })
  } catch (error) {
    throw new Error(`Codex artifact release trust is unavailable: ${error.code || error.message}`)
  }
  const registry = options.registry || readJson(path.join(root, 'agents', 'contracts', 'providers.json'))
  const evaluation = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    registry, runtimeIdentity, { now: options.now, trustedPublicKeys },
  )
  if (!evaluation?.ready || !Array.isArray(evaluation.blockers) || evaluation.blockers.length) {
    throw new Error(`Codex artifact release trust blocked: ${
      Array.isArray(evaluation?.blockers) && evaluation.blockers.length
        ? evaluation.blockers.join(',') : 'canonical-signed-pass-required'}`)
  }
  return evaluation
}

function checkArtifactRelease(root = ROOT, options = {}) {
  const release = checkRelease(root)
  const trust = assertCanonicalReleaseTrust(root, options)
  return { ...release, trust }
}

function assertConformanceOnlyTrust(root = ROOT, options = {}) {
  const configure = options.configure || require(path.join(root, 'scripts', 'codex-configure.cjs'))
  const identity = options.identity || require(path.join(root, 'scripts', 'codex-runtime-identity.cjs'))
  const registry = readJson(path.join(root, 'agents', 'contracts', 'providers.json'))
  const provider = registry.providers?.find(candidate => candidate?.id === 'codex')
  const evidencePath = path.join(root, 'agents', 'contracts', 'codex-live-conformance-evidence.json')
  const evidenceBytes = fs.readFileSync(evidencePath)
  const evidence = assertCurrentPublicFailEvidence(evidenceBytes)
  const canonicalEvidence = Buffer.from(configure.stableJsonV1(evidence), 'utf8')
  const notRunEnvelope = evidence.result === 'NOT_RUN' && evidence.fixtureOnly === true &&
    evidence.runtimeIdentityHash === '0'.repeat(64) &&
    evidence.evidence?.canaryResult === 'NOT_RUN'
  const failedLiveEnvelope = evidence.result === 'FAIL' && evidence.fixtureOnly === false &&
    HASH_PATTERN.test(evidence.runtimeIdentityHash || '') &&
    evidence.evidence?.canaryResult === 'FAIL'
  const unsignedExact = evidenceBytes.equals(canonicalEvidence) &&
    evidence.schemaVersion === 'codex-live-conformance-evidence.v1' &&
    evidence.evidence?.canarySchema === 'codex-live-canary.v1' &&
    (notRunEnvelope || failedLiveEnvelope)
  const pendingExact = unsignedExact &&
    provider?.implementationStatus === 'verified' && provider?.currentIsolationClass === 'strict' &&
    provider?.defaultAdmission === 'allow-verified-required-capabilities' &&
    provider?.attestationRequired === true && provider?.verificationAttestation === null &&
    identity.codexProviderAdmissionSha256(provider) === FROZEN_PROVIDER_ADMISSION_SHA256 &&
    identity.providerContractCoreSha256(registry) === FROZEN_PROVIDER_CONTRACT_CORE_SHA256
  if (!pendingExact) {
    throw new Error('Codex conformance-only trust envelope is not canonical unsigned NOT_RUN or FAIL evidence')
  }
  const runtimeIdentity = configure.deriveCurrentCodexRuntimeIdentity(options.identityOptions || {})
  const trustedPublicKeys = configure.loadReleaseCodexTrustedPublicKeys({
    now: options.now,
    providerTrustedKeyRingPath: path.join(
      root, 'agents', 'contracts', 'codex-trusted-public-keys.json',
    ),
  })
  if (!Object.keys(trustedPublicKeys).length ||
      runtimeIdentity.providerAdmissionSha256 !== FROZEN_PROVIDER_ADMISSION_SHA256 ||
      runtimeIdentity.providerContractCoreSha256 !== FROZEN_PROVIDER_CONTRACT_CORE_SHA256) {
    throw new Error('Codex conformance-only key-bound runtime identity is invalid')
  }
  const refusal = configure.evaluateCanonicalCodexCapabilityTrustAgainstIdentity(
    registry, runtimeIdentity, { now: options.now, trustedPublicKeys },
  )
  if (refusal?.ready || !refusal?.blockers?.includes('external-attestation-missing') ||
      !refusal.blockers.includes('canonical-live-evidence-invalid')) {
    throw new Error('Codex conformance-only candidate did not remain fail-closed')
  }
  return {
    evidenceActivationNonce: crypto.createHash('sha256').update(evidenceBytes).digest('base64url'),
    evidenceResult: evidence.result,
    evidenceRuntimeIdentityHash: evidence.runtimeIdentityHash,
    evidenceSha256: crypto.createHash('sha256').update(evidenceBytes).digest('hex'),
    runtimeIdentity,
    refusal,
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function canonicalRelative(relative, label = 'artifact path') {
  assert.equal(typeof relative, 'string', `${label} must be a string`)
  assert.ok(relative.length > 0 && !relative.includes('\\') && !path.posix.isAbsolute(relative),
    `${label} must be a canonical relative POSIX path: ${relative}`)
  const parts = relative.split('/')
  assert.equal(parts.some(part => !part || part === '.' || part === '..'), false,
    `${label} escapes the artifact root: ${relative}`)
  assert.equal(path.posix.normalize(relative), relative,
    `${label} is not canonical: ${relative}`)
  return relative
}

function assertRegularSource(root, relative, label = 'artifact source') {
  canonicalRelative(relative, label)
  const resolvedRoot = path.resolve(root)
  let cursor = resolvedRoot
  const rootStat = fs.lstatSync(cursor)
  assert.equal(rootStat.isSymbolicLink(), false, `${label} root must not be a symlink: ${root}`)
  assert.equal(rootStat.isDirectory(), true, `${label} root must be a directory: ${root}`)
  for (const [index, part] of relative.split('/').entries()) {
    cursor = path.join(cursor, part)
    const stat = fs.lstatSync(cursor)
    assert.equal(stat.isSymbolicLink(), false, `${label} must not traverse a symlink: ${relative}`)
    if (index + 1 === relative.split('/').length) {
      assert.equal(stat.isFile(), true, `${label} must be a regular file: ${relative}`)
    } else {
      assert.equal(stat.isDirectory(), true, `${label} parent must be a directory: ${relative}`)
    }
  }
  return cursor
}

function copyBoundFile(root, sourceRelative, destination, destinationRelative, expectedSha256 = null) {
  const source = assertRegularSource(root, sourceRelative)
  canonicalRelative(destinationRelative, 'artifact destination')
  const before = sha256File(source)
  if (expectedSha256 !== null) {
    assert.match(expectedSha256, HASH_PATTERN, `invalid declared SHA-256: ${sourceRelative}`)
    assert.equal(before, expectedSha256, `declared source hash is stale: ${sourceRelative}`)
  }
  const target = path.join(destination, ...destinationRelative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  const after = sha256File(source)
  const landed = sha256File(target)
  assert.equal(after, before, `source changed while staging: ${sourceRelative}`)
  assert.equal(landed, before, `staged hash mismatch: ${destinationRelative}`)
  return before
}

function artifactCopyPlan(root, manifest, conformanceOnly) {
  assert.equal(manifest.sourceRoot, 'agents/codex', 'Codex manifest sourceRoot is not canonical')
  assert.ok(Array.isArray(manifest.files), 'Codex manifest file inventory is missing')
  assert.ok(manifest.sha256 && typeof manifest.sha256 === 'object' && !Array.isArray(manifest.sha256),
    'Codex manifest hash inventory is missing')
  const files = [...manifest.files]
  assert.deepEqual(files, [...new Set(files)].sort(),
    'Codex manifest file inventory must be unique and sorted')
  assert.deepEqual(Object.keys(manifest.sha256).sort(), files,
    'Codex manifest hashes must bind exactly the declared file inventory')
  assert.ok(Array.isArray(manifest.externalDependencies),
    'Codex manifest external dependency inventory is missing')
  const dependencySources = manifest.externalDependencies.map(dependency => dependency?.source)
  assert.deepEqual(dependencySources, [...new Set(dependencySources)].sort(),
    'Codex external dependency inventory must be unique and sorted')

  const plan = new Map()
  const add = (source, destination, expectedSha256, kind) => {
    canonicalRelative(source, `${kind} source`)
    canonicalRelative(destination, `${kind} destination`)
    assert.equal(plan.has(destination), false, `duplicate artifact destination: ${destination}`)
    plan.set(destination, { source, destination, expectedSha256, kind })
  }
  for (const relative of files) {
    add(`${manifest.sourceRoot}/${relative}`, `${manifest.sourceRoot}/${relative}`,
      manifest.sha256[relative], 'runtime-manifest')
  }
  for (const dependency of manifest.externalDependencies) {
    assert.ok(dependency && typeof dependency === 'object' && !Array.isArray(dependency),
      'Codex external dependency entry is invalid')
    add(dependency.source, dependency.source, dependency.sha256, 'external-dependency')
  }
  for (const [source, destination] of EXPLICIT_PACKAGE_FILES) {
    if (!plan.has(destination)) add(source, destination, null, 'explicit-package-dependency')
  }
  if (!conformanceOnly) {
    add('packages/codex/bin/autoprompt-codex.cjs', 'bin/autoprompt-codex.cjs', null,
      'publishable-entrypoint')
  }
  return [...plan.values()].sort((left, right) => left.destination.localeCompare(right.destination))
}

function listFiles(directory, prefix = '') {
  const rootStat = fs.lstatSync(directory)
  assert.equal(rootStat.isSymbolicLink(), false, `artifact inventory root is a symlink: ${directory}`)
  assert.equal(rootStat.isDirectory(), true, `artifact inventory root is not a directory: ${directory}`)
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const target = path.join(directory, entry.name)
    assert.equal(entry.isSymbolicLink(), false, `artifact inventory rejects symlink: ${relative}`)
    if (entry.isDirectory()) files.push(...listFiles(target, relative))
    else {
      assert.equal(entry.isFile(), true, `artifact inventory rejects non-file: ${relative}`)
      files.push(relative)
    }
  }
  return files.sort()
}

function inventoryEntries(directory, exclusions = []) {
  const excluded = new Set(exclusions)
  return listFiles(directory).filter(relative => !excluded.has(relative)).map(relative => ({
    path: relative,
    sha256: sha256File(path.join(directory, ...relative.split('/'))),
  }))
}

function validateArtifactInventory(directory) {
  const inventoryPath = assertRegularSource(directory, ARTIFACT_INVENTORY, 'artifact inventory')
  const inventoryBytes = fs.readFileSync(inventoryPath)
  const inventory = JSON.parse(inventoryBytes.toString('utf8'))
  assert.deepEqual(Object.keys(inventory), ['schemaVersion', 'algorithm', 'files'])
  assert.equal(inventory.schemaVersion, 1)
  assert.equal(inventory.algorithm, 'sha256')
  assert.ok(Array.isArray(inventory.files), 'artifact inventory files are missing')
  const declared = inventory.files.map(entry => entry?.path)
  assert.deepEqual(declared, [...new Set(declared)].sort(),
    'artifact inventory paths must be unique and sorted')
  for (const entry of inventory.files) {
    assert.deepEqual(Object.keys(entry), ['path', 'sha256'])
    canonicalRelative(entry.path, 'artifact inventory path')
    assert.match(entry.sha256, HASH_PATTERN)
  }
  const actual = listFiles(directory)
  assert.deepEqual(actual, [...declared, ARTIFACT_INVENTORY].sort(),
    'artifact final inventory contains missing or untracked files')
  for (const entry of inventory.files) {
    const file = assertRegularSource(directory, entry.path, 'inventoried artifact file')
    assert.equal(sha256File(file), entry.sha256, `artifact inventory hash mismatch: ${entry.path}`)
  }
  return Object.freeze({
    fileCount: actual.length,
    files: Object.freeze(inventory.files.map(entry => Object.freeze({ ...entry }))),
    inventorySha256: crypto.createHash('sha256').update(inventoryBytes).digest('hex'),
  })
}

function assertFreshDestination(destination, label) {
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false })
  if (!stat) return false
  assert.equal(stat.isSymbolicLink(), false, `${label} destination must not be a symlink`)
  assert.equal(stat.isDirectory(), true, `${label} destination must be a directory`)
  assert.deepEqual(fs.readdirSync(destination), [], `${label} destination must be empty`)
  return true
}

function commitDirectory(staged, destination, destinationExisted) {
  if (destinationExisted) fs.rmdirSync(destination)
  fs.renameSync(staged, destination)
}

function buildArtifact(destination, root, release, trust, conformanceOnly) {
  const { manifest, packageTemplate } = release
  const plan = artifactCopyPlan(root, manifest, conformanceOnly)
  const generated = [
    'package.json', ARTIFACT_INVENTORY,
    ...(conformanceOnly ? ['.autoprompt-conformance-only.json'] : []),
  ]
  const packageFiles = [...plan.map(entry => entry.destination), ...generated]
    .filter(relative => relative !== 'package.json')
    .sort()
  const stagedPackage = {
    ...packageTemplate,
    private: conformanceOnly ? true : undefined,
    bin: conformanceOnly ? undefined : packageTemplate.bin,
    files: packageFiles,
    autoprompt: {
      ...packageTemplate.autoprompt,
      ...(conformanceOnly ? { conformanceOnly: true } : {}),
      payloadDigest: manifest.payloadDigest,
      payloadGeneration: manifest.payloadGeneration,
    },
  }
  fs.writeFileSync(path.join(destination, 'package.json'),
    `${JSON.stringify(stagedPackage, null, 2)}\n`, { flag: 'wx' })
  if (conformanceOnly) {
    fs.writeFileSync(path.join(destination, '.autoprompt-conformance-only.json'),
      JSON.stringify({
        schemaVersion: 2,
        publishable: false,
        installable: false,
        evidenceResult: trust.evidenceResult,
        evidenceSha256: trust.evidenceSha256,
        evidenceActivationNonce: trust.evidenceActivationNonce,
        evidenceRuntimeIdentityHash: trust.evidenceRuntimeIdentityHash,
        currentRuntimeIdentityHash: trust.runtimeIdentity.runtimeIdentityHash,
      }), { flag: 'wx' })
  }
  for (const entry of plan) {
    copyBoundFile(root, entry.source, destination, entry.destination, entry.expectedSha256)
  }
  if (!conformanceOnly) fs.chmodSync(path.join(destination, 'bin', 'autoprompt-codex.cjs'), 0o755)
  fs.chmodSync(path.join(destination, 'scripts', 'codex-evidence-bundle.cjs'), 0o755)
  const inventory = {
    schemaVersion: 1,
    algorithm: 'sha256',
    files: inventoryEntries(destination),
  }
  fs.writeFileSync(path.join(destination, ARTIFACT_INVENTORY),
    `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' })
  return { packageRecord: stagedPackage, inventory: validateArtifactInventory(destination) }
}

function releaseContext(root, options, conformanceOnly) {
  const release = checkRelease(root)
  const trust = conformanceOnly
    ? assertConformanceOnlyTrust(root, options)
    : assertCanonicalReleaseTrust(root, options)
  return { release, trust }
}

function stageArtifact(destination, root = ROOT, options = {}) {
  const conformanceOnly = options.conformanceOnly === true
  const target = path.resolve(destination)
  const context = releaseContext(root, options, conformanceOnly)
  const existed = assertFreshDestination(target, 'Codex artifact stage')
  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.stage-`))
  try {
    const built = buildArtifact(temporary, root, context.release, context.trust, conformanceOnly)
    commitDirectory(temporary, target, existed)
    return built.packageRecord
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const candidate = candidates.find(file => fs.existsSync(file))
  if (!candidate) throw new Error(`could not locate npm CLI; checked ${candidates.join(', ')}`)
  return candidate
}

function writeReleaseMeasurements(root, expectedBytes, measurements) {
  const releasePath = assertRegularSource(root, 'packages/codex/release.json', 'Codex release metadata')
  const currentBytes = fs.readFileSync(releasePath)
  assert.equal(currentBytes.equals(expectedBytes), true,
    'Codex release metadata changed while packing; measurements were not committed')
  const current = JSON.parse(currentBytes.toString('utf8'))
  const updated = { ...current, ...measurements }
  const temporary = path.join(path.dirname(releasePath),
    `.${path.basename(releasePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(updated, null, 2)}\n`)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, releasePath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
  return updated
}

function packArtifact(destination, root = ROOT, options = {}) {
  const target = path.resolve(destination)
  const releaseBytes = fs.readFileSync(path.join(root, 'packages', 'codex', 'release.json'))
  const context = releaseContext(root, options, false)
  const existed = assertFreshDestination(target, 'Codex artifact pack')
  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.pack-`))
  const stage = path.join(temporary, 'stage')
  const packedOutput = path.join(temporary, 'packed')
  const reopened = path.join(temporary, 'reopened')
  fs.mkdirSync(stage)
  fs.mkdirSync(packedOutput)
  fs.mkdirSync(reopened)
  try {
    const built = buildArtifact(stage, root, context.release, context.trust, false)
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === 'npm_config_dry_run') delete environment[key]
    }
    Object.assign(environment, {
      npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    })
    const packed = childProcess.spawnSync(process.execPath, [
      npmCliPath(), 'pack', '--ignore-scripts', '--json', '--pack-destination', packedOutput,
    ], { cwd: stage, encoding: 'utf8', env: environment, timeout: 120000 })
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`)
    const [record] = JSON.parse(packed.stdout)
    assert.ok(record && typeof record.filename === 'string', 'npm pack did not return one tarball')
    const temporaryTarball = assertRegularSource(packedOutput, record.filename, 'packed tarball')
    const unpacked = childProcess.spawnSync('tar', ['-xf', temporaryTarball, '-C', reopened], {
      encoding: 'utf8', timeout: 120000,
    })
    if (unpacked.status !== 0) throw new Error(`packed tarball could not be reopened: ${unpacked.stderr || unpacked.stdout}`)
    const packageRoot = path.join(reopened, 'package')
    const reopenedInventory = validateArtifactInventory(packageRoot)
    assert.equal(reopenedInventory.inventorySha256, built.inventory.inventorySha256,
      'reopened tarball inventory digest differs from the staged inventory')
    assert.deepEqual(reopenedInventory.files, built.inventory.files,
      'reopened tarball file hashes differ from the staged inventory')
    const npmFiles = Array.isArray(record.files)
      ? record.files.map(file => file?.path).sort()
      : []
    assert.deepEqual(npmFiles, listFiles(packageRoot),
      'npm pack report differs from reopened tarball inventory')
    const measurements = Object.freeze({
      packedBytes: fs.statSync(temporaryTarball).size,
      fileCount: reopenedInventory.fileCount,
      externalDependencyCount: context.release.manifest.externalDependencies.length,
    })
    const tarballSha256 = sha256File(temporaryTarball)
    commitDirectory(packedOutput, target, existed)
    writeReleaseMeasurements(root, releaseBytes, measurements)
    return Object.freeze({
      ...measurements,
      inventorySha256: reopenedInventory.inventorySha256,
      name: built.packageRecord.name,
      tarball: path.join(target, record.filename),
      tarballSha256,
      version: built.packageRecord.version,
    })
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function parse(argv) {
  if (argv.length === 1 && argv[0] === '--check') return { action: 'check' }
  if (argv.length === 2 && argv[0] === '--stage') {
    return { action: 'stage', destination: path.resolve(argv[1]) }
  }
  if (argv.length === 3 && argv[0] === '--stage' && argv[2] === '--conformance-only') {
    return { action: 'stage', destination: path.resolve(argv[1]), conformanceOnly: true }
  }
  if (argv.length === 3 && argv[0] === '--pack' && argv[1] === '--destination') {
    return { action: 'pack', destination: path.resolve(argv[2]) }
  }
  throw new Error('usage: codex-artifact.cjs --check | --stage <directory> [--conformance-only] | --pack --destination <directory>')
}

function run(argv = process.argv.slice(2), io = process) {
  try {
    const command = parse(argv)
    if (command.action === 'check') {
      const result = checkArtifactRelease()
      io.stdout.write(`${JSON.stringify({
        name: result.packageTemplate.name,
        payloadDigest: result.manifest.payloadDigest,
        payloadGeneration: result.manifest.payloadGeneration,
        version: result.codexVersion,
      })}\n`)
      return 0
    }
    const result = command.action === 'stage'
      ? stageArtifact(command.destination, ROOT, { conformanceOnly: command.conformanceOnly === true })
      : packArtifact(command.destination)
    io.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`codex-artifact: ${error.message}\n`)
    return 1
  }
}

if (require.main === module) process.exitCode = run()

module.exports = {
  assertConformanceOnlyTrust,
  assertCanonicalReleaseTrust,
  checkArtifactRelease,
  checkRelease,
  listFiles,
  metadata,
  releaseRecordDigest,
  packArtifact,
  parse,
  run,
  stageArtifact,
  validateArtifactInventory,
}
