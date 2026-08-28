#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { TextDecoder } = require('node:util')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..', '..')
const PACKAGE_PATH = path.join(ROOT, 'package.json')
const COVERAGE_PATH = path.join(ROOT, 'AUTOPROMPT-IMPLEMENTATION-COVERAGE.json')
const CI_PATH = path.join(ROOT, '.github', 'workflows', 'ci.yml')
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')).version
const CODEX_PUBLIC_EVIDENCE_PATH = 'agents/contracts/codex-live-conformance-evidence.json'
const CODEX_RUNTIME_IDENTITY_HASH = '4f2bd92306b2f87156e7a9b3c5db169b8865a4f13ab6ba9d0d1c9df0c5c83a5e'
const CODEX_RAW_EVIDENCE_SHA256 = '2e24eda37043240b3cf3a008e6a3c628d87653741b21e38d4947d54955e01c59'
const EXPECTED_BENCHMARK_SCRIPT = 'node --test tests/source/benchmark-evidence-v2.test.cjs tests/source/benchmark-evidence-test-closures.test.cjs tests/benchmarks/autoprompt-benchmark.test.cjs'
const EXPECTED_CODEX_CORE_SCRIPT = 'node scripts/run-codex-source-tests.cjs'
const PRIVACY_SCHEMA_VOCABULARY_ALLOWLIST = new Set([
  'apiKey', 'argv', 'credential', 'password', 'pid', 'pids', 'processId',
  'secret', 'sessionId', 'sessionIds', 'stderr', 'stdout', 'telemetry',
  'threadId', 'threadIds', 'token', 'transcript',
])
const PROVIDERS = [
  'claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime',
  'omp', 'deepseek', 'reasonix',
]

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(target) : [target]
  })
}

function readmeReferenceClosure() {
  const queued = ['README.md']
  const visited = new Set()
  const references = new Map()

  while (queued.length > 0) {
    const source = queued.shift()
    if (visited.has(source)) continue
    visited.add(source)

    const sourcePath = path.join(ROOT, ...source.split('/'))
    if (!fs.existsSync(sourcePath)) continue
    const markdown = fs.readFileSync(sourcePath, 'utf8')
    const rawTargets = [
      ...[...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]),
      ...[...markdown.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map(match => match[1]),
    ]

    for (let rawTarget of rawTargets) {
      rawTarget = rawTarget.replace(/^<|>$/g, '')
      if (
        rawTarget.startsWith('#') ||
        rawTarget.startsWith('//') ||
        /^[a-z][a-z\d+.-]*:/i.test(rawTarget)
      ) continue

      let decoded
      try {
        decoded = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0])
      } catch {
        decoded = rawTarget.split(/[?#]/, 1)[0]
      }
      const directory = decoded.endsWith('/')
      const target = path.posix.normalize(path.posix.join(
        path.posix.dirname(source),
        decoded.replaceAll('\\', '/'),
      ))
      assert.equal(
        target === '..' || target.startsWith('../') || path.posix.isAbsolute(target),
        false,
        `${source}: local README reference escapes the package: ${rawTarget}`,
      )

      const key = `${directory ? 'directory' : 'file'}:${target}`
      if (!references.has(key)) references.set(key, { directory, from: source, target })
      if (!directory && target.endsWith('.md') && !visited.has(target)) queued.push(target)
    }
  }

  return [...references.values()]
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find(candidate => fs.existsSync(candidate))
  assert.ok(npmCli, `could not locate npm CLI; checked ${candidates.join(', ')}`)
  return npmCli
}

function runNpm(args, options = {}) {
  const env = { ...(options.env ?? process.env) }
  // npm exposes an outer dry-run to prepack through this environment key.
  // Nested pack and install commands must remain real so their output is verified.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_dry_run') {
      delete env[key]
    }
  }

  return childProcess.spawnSync(process.execPath, [npmCliPath(), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
    env,
  })
}

function packageFilesOnDisk() {
  const explicit = [
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'LICENSE'),
    ...filesBelow(path.join(ROOT, 'bin')),
    path.join(ROOT, 'scripts', 'codex-configure.cjs'),
    path.join(ROOT, 'scripts', 'codex-runtime-identity.cjs'),
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    path.join(ROOT, 'scripts', 'harness-provider-config.cjs'),
    path.join(ROOT, 'scripts', 'runtime-payload.cjs'),
    path.join(ROOT, 'scripts', 'codex-artifact.cjs'),
    path.join(ROOT, 'scripts', 'codex-evidence-bundle.cjs'),
    ...filesBelow(path.join(ROOT, 'scripts', 'codex-evidence')),
    ...filesBelow(path.join(ROOT, 'scripts', 'benchmark-evidence')),
    ...filesBelow(path.join(ROOT, 'scripts', 'install')),
    ...filesBelow(path.join(ROOT, 'agents', 'contracts')),
    ...PROVIDERS.map(provider => path.join(ROOT, 'agents', 'manifests', `${provider}-runtime.json`)),
    ...PROVIDERS.flatMap(provider => filesBelow(path.join(ROOT, 'agents', provider))),
    ...filesBelow(path.join(ROOT, 'packages', 'codex')),
    ...readmeReferenceClosure()
      .filter(reference => !reference.directory)
      .map(reference => path.join(ROOT, ...reference.target.split('/'))),
  ]
  return [...new Set(explicit.map(file => path.relative(ROOT, file).split(path.sep).join('/')))]
    // npm never packs .gitignore control files, even below an allowed directory.
    .filter(file => path.posix.basename(file) !== '.gitignore')
    .sort()
}

function isolatedEnvironment(root) {
  const home = path.join(root, 'home')
  const cache = path.join(root, 'npm-cache')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_audit: 'false',
    npm_config_cache: cache,
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
}

function dryRunPackResult() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt npm dry run '))
  try {
    const completed = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], {
      env: isolatedEnvironment(temporaryRoot),
    })
    assert.equal(completed.status, 0, completed.stderr)
    const [result] = JSON.parse(completed.stdout)
    return result
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function tarballEntries(tarballBytes) {
  const archive = zlib.gunzipSync(tarballBytes)
  const entries = new Map()
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length)
      .toString('utf8').replace(/\0.*$/s, '')
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/')
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    assert.equal(Number.isSafeInteger(size), true, `${name}: invalid tar size`)
    const type = field(156, 1) || '0'
    const dataStart = offset + 512
    if (type === '0') {
      assert.equal(entries.has(name), false, `${name}: duplicate tar entry`)
      entries.set(name, archive.subarray(dataStart, dataStart + size))
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function decodeTextualEntry(bytes) {
  if (bytes.includes(0)) return null
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
  return /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(text) ? null : text
}

function isEmptyPrivateValue(value) {
  if (value === null || value === false || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return value && typeof value === 'object' && Object.keys(value).length === 0
}

function assertNoPrivateJsonValues(value, entryPath, ancestors = []) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const schemaVocabulary = ['properties', '$defs', 'definitions'].some(container => ancestors.includes(container))
    if (PRIVACY_SCHEMA_VOCABULARY_ALLOWLIST.has(key) && !schemaVocabulary && !isEmptyPrivateValue(child)) {
      assert.fail(`${entryPath}: populated private runtime field ${[...ancestors, key].join('.')}`)
    }
    assertNoPrivateJsonValues(child, entryPath, [...ancestors, key])
  }
}

function assertPrivacySafeText(entryPath, text) {
  const genericPrivatePatterns = [
    { label: 'Windows user-home path', pattern: /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?!<|%|\$|\{)(?!(?:x|user|username|example|test|tester)(?:[\\/\s"'`]|$))[^\\/\s"'`]+/iu },
    { label: 'POSIX user-home path', pattern: /\/(?:Users|home)\/(?!<|\$|\{)(?!(?:x|user|username|example|test|tester)(?:[\/\s"'`]|$))[^/\s"'`]+/u },
    { label: 'runtime UUID', pattern: /\b(?!00000000-0000-0000-0000-000000000000)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu },
    { label: 'private key material', pattern: /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/u },
    { label: 'credential-bearing URL', pattern: /https?:\/\/[^\s/@:"']+:[^\s/@"']+@/iu },
    { label: 'assigned literal secret', pattern: /\b(?:authorization|api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["'](?!redacted\b|<)[A-Za-z0-9/+_.-]{16,}["']/iu },
  ]
  for (const { label, pattern } of genericPrivatePatterns) assert.doesNotMatch(text, pattern, `${entryPath}: ${label}`)

  if (entryPath.endsWith('.json')) {
    let parsed
    try { parsed = JSON.parse(text) } catch { return }
    assertNoPrivateJsonValues(parsed, entryPath)
  }
}

function expectedPublicCodexEvidence() {
  return {
    evidence: {
      canaryResult: 'FAIL',
      canarySchema: 'codex-live-canary.v1',
      providerAdmission: {
        verifiedCapabilities: [],
        verifiedCapabilitiesExact: false,
      },
      providerId: 'codex',
      result: 'FAIL',
      schemaVersion: 'codex-live-conformance-observation.v1',
    },
    fixtureOnly: false,
    publicProjection: {
      policy: 'codex-public-fail-evidence.v1',
      sourceEvidenceSha256: CODEX_RAW_EVIDENCE_SHA256,
    },
    result: 'FAIL',
    runtimeIdentityHash: CODEX_RUNTIME_IDENTITY_HASH,
    schemaVersion: 'codex-live-conformance-evidence.v1',
  }
}

test('AP-TEST-018 benchmark consequence suites remain continuously enforced and mapped', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'))
  const coverage = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf8'))
  const findings = new Map(coverage.findings.map(finding => [finding.id, finding]))
  const ci = fs.readFileSync(CI_PATH, 'utf8')

  assert.match(packageJson.scripts.test, /npm run test:benchmark/)
  assert.equal(packageJson.scripts['test:benchmark'], EXPECTED_BENCHMARK_SCRIPT)
  assert.equal(packageJson.scripts['test:codex-core'], EXPECTED_CODEX_CORE_SCRIPT)
  assert.equal(packageJson.scripts.verify.match(/npm run test:codex-core/g)?.length, 1)
  assert.doesNotMatch(ci, /run: npm run test:codex-runtime-evidence/)
  assert.match(ci, /run: npm test/)
  assert.ok(findings.get('AP-TEST-018')?.test_refs.includes('tests/source/npm-package.test.cjs'))

  for (const id of ['AP-TEST-010', 'AP-TEST-020', 'AP-TEST-022']) {
    assert.ok(findings.get(id)?.test_refs.includes('tests/source/benchmark-evidence-test-closures.test.cjs'), id)
  }
  for (const id of ['AP-TEST-025', 'AP-TEST-026', 'AP-TEST-027']) {
    assert.ok(findings.get(id)?.test_refs.includes('tests/source/codex-runtime-evidence-gates-r5.test.cjs'), id)
  }
})

test('package metadata is public-ready under the exact available name and remains dependency-free', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'))
  assert.equal(packageJson.name, 'autoprompt-skill')
  assert.equal(packageJson.version, PACKAGE_VERSION)
  assert.equal(
    packageJson.description,
    'Autoprompt is a coding-agent skill for explicit routing, bounded delegation, and evidence-backed checks.',
  )
  assert.equal(packageJson.private, undefined)
  assert.deepEqual(packageJson.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  })
  assert.deepEqual(packageJson.engines, { node: '>=20.0.0' })
  assert.deepEqual(packageJson.bin, {
    autoprompt: 'bin/autoprompt.cjs',
    'autoprompt-skill': 'bin/autoprompt.cjs',
  })
  assert.equal(packageJson.dependencies, undefined)
  assert.equal(packageJson.devDependencies, undefined)
  assert.equal(packageJson.optionalDependencies, undefined)
  assert.equal(packageJson.peerDependencies, undefined)
  for (const forbidden of ['install', 'postinstall', 'preinstall', 'prepare']) {
    assert.equal(packageJson.scripts[forbidden], undefined, forbidden)
  }
  assert.match(packageJson.scripts['test:providers'], /generate-provider-contracts\.cjs --check/)
  assert.match(packageJson.scripts['test:providers'], /runtime-payload\.cjs --check/)
  for (const suite of [
    'provider-generation',
    'runtime-payload',
    'vscode-custom-agent-fixture',
    'provider-compatibility-registry',
    'codex-current-parity',
    'prime-provider',
    'harness-provider-config',
  ]) {
    assert.match(packageJson.scripts['test:providers'], new RegExp(`${suite}\\.test\\.cjs`), suite)
  }
  for (const suite of [
    'claude-lifecycle',
    'kilo-provider',
    'opencode-lifecycle',
    'vscode-lifecycle',
    'install-custom-root',
    'prime-lifecycle',
    'new-harness-lifecycle',
    'packed-new-harness-lifecycle',
    'codex-receipt-lifecycle',
    'packed-codex-lifecycle',
    'codex-artifact',
  ]) {
    assert.match(packageJson.scripts['test:lifecycle'], new RegExp(`${suite}\\.test\\.cjs`), suite)
  }
  assert.match(packageJson.scripts['test:lifecycle'], /^node --test --test-concurrency=1\b/)
  assert.match(packageJson.scripts.test, /npm run test:cli/)
  assert.match(packageJson.scripts.test, /npm run test:providers/)
  assert.match(packageJson.scripts.test, /npm run test:benchmark/)
  assert.equal(
    packageJson.scripts['test:benchmark'],
    EXPECTED_BENCHMARK_SCRIPT,
  )
  assert.equal(packageJson.scripts['test:codex-core'], EXPECTED_CODEX_CORE_SCRIPT)
  assert.equal(
    packageJson.scripts['test:codex-lifecycle'],
    'node --test --test-concurrency=1 tests/source/codex-receipt-lifecycle.test.cjs tests/source/packed-codex-lifecycle.test.cjs tests/source/codex-artifact.test.cjs',
  )
  assert.equal(
    packageJson.scripts['test:codex-artifact'],
    'node --test --test-concurrency=1 tests/source/codex-artifact.test.cjs',
  )
  assert.equal(packageJson.scripts['benchmark:run'], 'node scripts/benchmark-evidence/runner.cjs')
  assert.equal(packageJson.scripts['artifact:codex:check'], 'node scripts/codex-artifact.cjs --check')
  assert.equal(
    packageJson.scripts['artifact:codex:pack'],
    'node scripts/codex-artifact.cjs --pack --destination dist/codex',
  )
  assert.doesNotMatch(packageJson.scripts.test, /npm run test:lifecycle/)
  assert.match(packageJson.scripts.prepack, /npm test/)
  assert.doesNotMatch(packageJson.scripts.prepack, /npm run test:lifecycle/)
  assert.match(packageJson.scripts.verify, /npm test/)
  assert.match(packageJson.scripts.verify, /npm run test:codex-core/)
  assert.match(packageJson.scripts.verify, /npm run test:lifecycle/)
  assert.equal(packageJson.scripts.prepublishOnly, 'npm run verify && npm run benchmark:release-quality-gate')
  assert.deepEqual(packageJson.files, [
    'bin/',
    'scripts/codex-configure.cjs',
    'scripts/codex-runtime-identity.cjs',
    'scripts/local-only-safety.cjs',
    'scripts/harness-provider-config.cjs',
    'scripts/install/',
    'scripts/codex-artifact.cjs',
    'scripts/codex-evidence-bundle.cjs',
    'scripts/codex-evidence/',
    'scripts/runtime-payload.cjs',
    'scripts/benchmark-evidence/',
    'agents/contracts/',
    'agents/claude/',
    'agents/codex/',
    'agents/opencode/',
    'agents/kilo/',
    'agents/vscode/',
    'agents/prime/',
    'agents/omp/',
    'agents/deepseek/',
    'agents/reasonix/',
    'agents/manifests/claude-runtime.json',
    'agents/manifests/codex-runtime.json',
    'agents/manifests/opencode-runtime.json',
    'agents/manifests/kilo-runtime.json',
    'agents/manifests/vscode-runtime.json',
    'agents/manifests/prime-runtime.json',
    'agents/manifests/omp-runtime.json',
    'agents/manifests/deepseek-runtime.json',
    'agents/manifests/reasonix-runtime.json',
    'packages/codex/',
    'assets/anatomy.svg',
    'assets/how-it-works-hierarchy.svg',
    'assets/how-it-works-loop.svg',
    'docs/CODE_OF_CONDUCT.md',
    'docs/CONTRIBUTING.md',
    'docs/SECURITY.md',
    'docs/SUPPORT.md',
    'docs/benchmarks/codex-canary-2026-08-22.md',
    'docs/benchmarks/terminal-bench-2.1.md',
    'docs/faq/does-autoprompt-mean-i-do-not-have-to-prompt.md',
    'docs/faq/how-autonomous-is-autoprompt.md',
    'docs/faq/how-to-add-custom-models.md',
    'docs/faq/tokensaver-vs-wide-vs-custom.md',
    'docs/faq/what-are-the-layers-for.md',
    'docs/faq/which-coding-agents-are-supported.md',
    'docs/guides/9router-multi-provider-setup.md',
    'docs/guides/9router-routing.png',
    'docs/guides/codex-v2-local-records.md',
    'docs/guides/custom-agent-compatibility.md',
  ])
  assert.equal(fs.existsSync(path.join(ROOT, 'package-lock.json')), false)
  assert.equal(fs.existsSync(path.join(ROOT, '.npmignore')), false)
})

test('npm dry-run inventory is an exact allowlist and excludes repository-only material', () => {
  const result = dryRunPackResult()
  assert.equal(result.name, 'autoprompt-skill')
  assert.equal(result.version, PACKAGE_VERSION)
  const actual = result.files.map(file => file.path).sort()
  assert.deepEqual(actual, packageFilesOnDisk())
  assert.ok(result.size > 0)
  assert.ok(result.unpackedSize > result.size)

  const forbiddenPrefixes = [
    '.git',
    '.github/',
    'coverage/',
    'node_modules/',
    'tests/',
    'agents/other/',
    'agents/vibe/',
    'agents/manifests/vibe-runtime.json',
    'scripts/generate-provider-contracts.cjs',
  ]
  for (const file of actual) {
    assert.equal(
      forbiddenPrefixes.some(prefix => file === prefix || file.startsWith(prefix)),
      false,
      file,
    )
  }
})

test('npm tarball generically scans every textual entry and ships only the deterministic privacy-safe Codex FAIL projection', t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt npm privacy '))
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
  const completed = runNpm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot,
  ], { env: isolatedEnvironment(temporaryRoot) })
  assert.equal(completed.status, 0, completed.stderr)
  const [packResult] = JSON.parse(completed.stdout)
  const entries = tarballEntries(fs.readFileSync(path.join(temporaryRoot, packResult.filename)))
  const packedPath = `package/${CODEX_PUBLIC_EVIDENCE_PATH}`
  const evidenceBytes = entries.get(packedPath)
  assert.ok(evidenceBytes, `${packedPath}: missing from npm tarball`)

  let textualEntries = 0
  for (const [entryPath, entryBytes] of entries) {
    const packedText = decodeTextualEntry(entryBytes)
    if (packedText === null) continue
    textualEntries += 1
    assertPrivacySafeText(entryPath, packedText)
  }
  assert.ok(textualEntries > 0, 'npm tarball contained no recognized textual entries')

  const expected = expectedPublicCodexEvidence()
  assert.deepEqual(JSON.parse(evidenceBytes), expected)
  assert.equal(evidenceBytes.toString('utf8'), JSON.stringify(expected),
    'public evidence must be the exact canonical projection')

  const serialized = evidenceBytes.toString('utf8')
  for (const forbidden of [
    /[A-Za-z]:[\\/]/,
    /\/(?:Users|home)\/[^/\s"']+/i,
    /braschki/i,
    /\b(?:pid|pids|sessionId|sessionIds|threadId|threadIds|argv|credential|transcript|telemetry|stdout|stderr)\b/i,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  ]) assert.doesNotMatch(serialized, forbidden)

  const registry = JSON.parse(entries.get('package/agents/contracts/providers.json'))
  const codex = registry.providers.find(provider => provider.id === 'codex')
  assert.equal(codex.verificationAttestation, null,
    'redaction must never fabricate or upgrade an attestation')

  const manifest = JSON.parse(entries.get('package/agents/manifests/codex-runtime.json'))
  const dependency = manifest.externalDependencies.find(candidate =>
    candidate.source === CODEX_PUBLIC_EVIDENCE_PATH)
  assert.equal(dependency.sha256,
    crypto.createHash('sha256').update(evidenceBytes).digest('hex'),
  'Codex manifest must independently bind the public projection bytes')
})

test('generic tarball privacy scanner permits only explicit schema vocabulary, not populated private values', () => {
  assert.doesNotThrow(() => assertPrivacySafeText('package/schema.json', JSON.stringify({
    properties: { pid: { type: 'integer' }, argv: { type: 'array' } },
  })))
  assert.throws(() => assertPrivacySafeText('package/evidence.json', JSON.stringify({ pid: 41922 })), /populated private runtime field pid/)
  assert.throws(() => assertPrivacySafeText('package/readme.md', 'local root C:\\Users\\private-person\\workspace'), /Windows user-home path/)
  assert.throws(() => assertPrivacySafeText('package/evidence.txt', 'thread 01a030c0-7c51-7f42-956d-82dcd94e463c'), /runtime UUID/)
})

test('Codex public FAIL projection strips sensitive raw telemetry deterministically', () => {
  const { projectPublicFailEvidence } = require(
    '../../scripts/benchmark-evidence/codex-public-conformance.cjs')
  const raw = Buffer.from(JSON.stringify({
    evidence: {
      canaryResult: 'FAIL', canarySchema: 'codex-live-canary.v1',
      codexExecutable: { realpath: 'C:\\Users\\private-user\\codex.exe' },
      execution: { launchedPids: [12345], argv: ['--secret', 'credential-value'] },
      providerAdmission: { verifiedCapabilities: [], verifiedCapabilitiesExact: false },
      providerId: 'codex', result: 'FAIL',
      schemaVersion: 'codex-live-conformance-observation.v1',
      transcript: { threadIds: ['01a030c0-7c51-7f42-956d-82dcd94e463c'] },
    },
    fixtureOnly: false, result: 'FAIL',
    runtimeIdentityHash: CODEX_RUNTIME_IDENTITY_HASH,
    schemaVersion: 'codex-live-conformance-evidence.v1',
  }))
  const first = projectPublicFailEvidence(raw)
  const second = projectPublicFailEvidence(Buffer.from(raw))
  assert.equal(first.canonicalJson, second.canonicalJson)
  assert.equal(first.sourceEvidenceSha256,
    crypto.createHash('sha256').update(raw).digest('hex'))
  for (const forbidden of [
    /private-user/i, /12345/, /credential-value/i, /01a030c0-7c51/i,
    /\b(?:pid|pids|sessionId|threadIds|argv|credential|transcript|telemetry)\b/i,
  ]) assert.doesNotMatch(first.canonicalJson, forbidden)
  assert.deepEqual(first.envelope.evidence.providerAdmission, {
    verifiedCapabilities: [], verifiedCapabilitiesExact: false,
  })
})

test('every local file and directory linked from npm README docs is packed', () => {
  const result = dryRunPackResult()
  const packed = result.files.map(file => file.path)
  const references = readmeReferenceClosure()

  const missingOnDisk = references
    .filter(reference => !fs.existsSync(path.join(ROOT, ...reference.target.split('/'))))
    .map(reference => `${reference.from} -> ${reference.target}`)
  assert.deepEqual(missingOnDisk, [], 'README docs contain missing local references')

  const missingFromTarball = references
    .filter(reference => reference.directory
      ? !packed.some(file => file.startsWith(`${reference.target.replace(/\/$/, '')}/`))
      : !packed.includes(reference.target))
    .map(reference => `${reference.from} -> ${reference.target}`)
  assert.deepEqual(missingFromTarball, [], 'README docs contain unpacked local references')
})

test('every npm-packaged POSIX shell script has an LF shebang and no carriage returns', () => {
  const result = dryRunPackResult()
  const shellScripts = result.files
    .map(file => file.path)
    .filter(file => file.endsWith('.sh'))
    .sort()

  assert.ok(shellScripts.length > 0, 'npm package must contain POSIX shell scripts')
  for (const relativePath of shellScripts) {
    const bytes = fs.readFileSync(path.join(ROOT, ...relativePath.split('/')))
    const firstLineEnd = bytes.indexOf(0x0a)
    assert.ok(firstLineEnd > 2, `${relativePath}: missing LF-terminated shebang`)
    assert.equal(
      bytes.subarray(0, firstLineEnd).toString('utf8').startsWith('#!'),
      true,
      `${relativePath}: first line is not a shebang`,
    )
    assert.equal(bytes.includes(0x0d), false, `${relativePath}: contains CR bytes`)
  }
})

test('every npm-packaged bin entrypoint has an LF shebang, no carriage returns, and the executable bit', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'))
  const binPaths = [...new Set(Object.values(packageJson.bin))].sort()
  assert.ok(binPaths.length > 0, 'package.json must declare bin entrypoints')

  const result = dryRunPackResult()
  for (const relativePath of binPaths) {
    const packedFile = result.files.find(file => file.path === relativePath)
    assert.ok(packedFile, `${relativePath}: not present in npm package`)
    // Windows filesystems do not represent POSIX executable bits. The release
    // workflow packs on Linux, where this assertion verifies the published mode.
    if (process.platform !== 'win32') {
      // eslint-disable-next-line no-bitwise
      assert.equal(packedFile.mode & 0o111, 0o111, `${relativePath}: packed without the executable bit`)
    }

    const bytes = fs.readFileSync(path.join(ROOT, ...relativePath.split('/')))
    const firstLineEnd = bytes.indexOf(0x0a)
    assert.ok(firstLineEnd > 2, `${relativePath}: missing LF-terminated shebang`)
    assert.equal(
      bytes.subarray(0, firstLineEnd).toString('utf8').startsWith('#!'),
      true,
      `${relativePath}: first line is not a shebang`,
    )
    assert.equal(bytes.includes(0x0d), false, `${relativePath}: contains CR bytes`)
  }
})

test('packed tarball installs into an isolated temporary global prefix and its shim runs', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt npm package '))
  const packDirectory = path.join(temporaryRoot, 'tarball output')
  const prefix = path.join(temporaryRoot, 'global prefix')
  const env = isolatedEnvironment(temporaryRoot)
  fs.mkdirSync(packDirectory, { recursive: true })
  fs.mkdirSync(prefix, { recursive: true })

  try {
    const packed = runNpm([
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory,
    ], { env })
    assert.equal(packed.status, 0, packed.stderr)
    const [packResult] = JSON.parse(packed.stdout)
    const tarball = path.join(packDirectory, packResult.filename)
    assert.equal(fs.existsSync(tarball), true)

    const installed = runNpm([
      'install',
      '--global',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      prefix,
      tarball,
    ], { env })
    assert.equal(installed.status, 0, installed.stderr)

    for (const command of ['autoprompt', 'autoprompt-skill']) {
      const shim = process.platform === 'win32'
        ? path.join(prefix, `${command}.cmd`)
        : path.join(prefix, 'bin', command)
      assert.equal(fs.existsSync(shim), true, shim)

      const invoked = process.platform === 'win32'
        ? childProcess.spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', `call "${shim}" version`],
          {
            cwd: temporaryRoot,
            encoding: 'utf8',
            env,
            shell: false,
            windowsVerbatimArguments: true,
          },
        )
        : childProcess.spawnSync(shim, ['version'], {
          cwd: temporaryRoot,
          encoding: 'utf8',
          env,
          shell: false,
        })
      assert.equal(invoked.status, 0, invoked.stderr)
      assert.equal(invoked.stdout, `${PACKAGE_VERSION}\n`)
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
