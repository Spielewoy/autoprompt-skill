'use strict'

// Diagnostic transport only. Context files must come from trusted workflow code,
// separately from the candidate/downloaded archive. Nothing here admits a worker.
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const portable = require('./portable.cjs')
const { nativeAdapter } = require('./native-adapter.cjs')

const PINNED_SDK = 'e3cc14afd549778c2f2d3bcc6e89307f40f5c2c1'
const PINNED_SOURCE = '270ba2980700e6e2a0813944d506eecea0f86402'
// Observed directly in the pinned SDK checkout, not taken from a build packet.
const PINNED_BASH = '5490d0da5e7cf9d92068cc48fcc590f2bcf8564add8ff91c3b5fe541eb2d72e3'
const MAX_CONTEXT = 1024 * 1024
const MAX_ARCHIVE = 64 * 1024 * 1024

function exact(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected context fields')
}

function digest(value) {
  assert.match(value, /^[a-f0-9]{64}$/, 'Expected a lowercase SHA256')
  return value
}

function readContext(file) {
  // Canonical JSON also rejects duplicate keys and ambiguous encodings.
  return portable.parseCanonical(portable.read(path.resolve(file), MAX_CONTEXT))
}

function compiledText(bytes) {
  // Matches build.ps1 Write-Utf8Lf for the copied compiler input text.
  const text = bytes.toString('utf8')
  assert.ok(Buffer.from(text).equals(bytes), 'Invalid UTF-8 compiler input')
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  assert.ok(!normalized.includes('\r'), 'Bare carriage return in compiler input')
  return Buffer.from(normalized)
}

function sourceBindings(repoRoot, observedTools) {
  assert.ok(path.isAbsolute(repoRoot), 'Absolute trusted repository required')
  exact(observedTools, ['linkerSha256', 'bootstrapRuntimeSha256'])
  const source = name => {
    const bytes = portable.read(path.join(repoRoot, 'scripts/windows-msys', name), MAX_CONTEXT)
    if (name === 'pipe-security.patch') {
      assert.ok(!bytes.includes(13) && !bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])),
        'Adaptation patch must already use LF without BOM')
      return bytes
    }
    return compiledText(bytes)
  }
  const lockBytes = source('build-lock.json')
  const lock = JSON.parse(lockBytes)
  assert.equal(lock.schema, 1)
  assert.equal(lock.sdk.commit, PINNED_SDK)
  assert.equal(lock.source.commit, PINNED_SOURCE)
  assert.equal(lock.sdk.compilerTarget, 'x86_64-pc-cygwin')
  assert.equal(lock.sdk.configureBuild, 'x86_64-pc-cygwin')
  return {
    sdkCommit: PINNED_SDK,
    sourceCommit: PINNED_SOURCE,
    sourceArchiveSha256: digest(lock.source.sha256),
    lockSha256: portable.hash(lockBytes),
    patchSha256: portable.hash(source('pipe-security.patch')),
    buildRecipeSha256: portable.hash(source('build.sh')),
    posixRecipeSha256: portable.hash(source('compile-posix-fixture.sh')),
    posixSourceSha256: portable.hash(source('posix-proof.c')),
    gccSha256: digest(lock.sdk.compilerSha256),
    linkerSha256: digest(observedTools.linkerSha256),
    bootstrapRuntimeSha256: digest(observedTools.bootstrapRuntimeSha256),
    bashSha256: PINNED_BASH,
  }
}

function exportAuthority(repoRoot, context) {
  exact(context, ['schema', 'producer', 'observedTools'])
  assert.equal(context.schema, 1)
  return portable.authority({
    bindings: sourceBindings(repoRoot, context.observedTools),
    producer: context.producer,
  })
}

function importAuthority(repoRoot, context) {
  const replay = Object.hasOwn(context, 'consumerHeadSha')
  exact(context, ['schema', 'expected', 'transport', ...(replay ? ['consumerHeadSha'] : [])])
  assert.equal(context.schema, 1)
  if (replay) assert.match(context.consumerHeadSha, /^[a-f0-9]{40}$/, 'Expected a recorded consumer head')
  const expected = portable.authority(context.expected)
  // A new consumer must run the identical reviewed source/patch/recipe revision.
  assert.deepEqual(expected.bindings, sourceBindings(repoRoot, {
    linkerSha256: expected.bindings.linkerSha256,
    bootstrapRuntimeSha256: expected.bindings.bootstrapRuntimeSha256,
  }), 'Consumer checkout differs from expected producer source')
  exact(context.transport, ['artifactId', 'archivePath', 'archiveSha256', 'manifestSha256'])
  const transport = context.transport
  assert.match(transport.artifactId, /^[1-9][0-9]{0,19}$/)
  assert.ok(path.isAbsolute(transport.archivePath), 'Absolute downloaded archive path required')
  digest(transport.archiveSha256)
  digest(transport.manifestSha256)
  assert.equal(portable.hash(portable.read(transport.archivePath, MAX_ARCHIVE)),
    transport.archiveSha256, 'External downloaded archive digest mismatch')
  return { expected, transport: Object.freeze({ ...transport }),
    ...(replay ? { consumerHeadSha: context.consumerHeadSha } : {}) }
}

function verifyCheckout(repoRoot, producer, consumerHeadSha) {
  const head = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
  }).trim()
  assert.equal(head, consumerHeadSha ?? producer.headSha, 'Trusted checkout must match the recorded head')
  if (consumerHeadSha !== undefined)
    assert.equal(process.env.GITHUB_SHA, consumerHeadSha, 'Workflow SHA must match the recorded consumer head')
  execFileSync('git', ['-C', repoRoot, 'diff', '--exit-code', 'HEAD', '--',
    'scripts/windows-msys', 'scripts/windows-runtime/physical-proof',
    'agents/codex/workflow/safe-run-root.js'], { timeout: 10000, maxBuffer: MAX_CONTEXT })
  // The producer context still needs independent GitHub run/job authentication.
  // HEAD alone does not authenticate repository ownership or workflow provenance.
}

function trustedNative(repoRoot) {
  assert.equal(process.platform, 'win32', 'CLI requires an actual native Windows held-file capture')
  const systemRoot = process.env.SystemRoot
  assert.equal(typeof systemRoot, 'string')
  assert.ok(path.isAbsolute(systemRoot), 'Absolute Windows system root required')
  const helperHash = name => portable.hash(portable.read(path.join(repoRoot, name)))
  return nativeAdapter({ repoRoot, expected: {
    adapterSha256: helperHash('scripts/windows-runtime/physical-proof/adapter.cjs'),
    aclSha256: helperHash('agents/codex/workflow/safe-run-root.js'),
    sourceSha256: helperHash('scripts/windows-runtime/physical-proof/audit.cs'),
    driverSha256: helperHash('scripts/windows-runtime/physical-proof/driver.ps1'),
    systemRoot,
  } })
}

async function main(args) {
  assert.equal(args.length, 5,
    'Usage: cli.cjs export|import REPO BUILD_ROOT|PACKET CONTEXT_JSON NEW_DESTINATION')
  const [command, repoArg, inputArg, contextArg, destinationArg] = args
  assert.ok(command === 'export' || command === 'import', 'Unknown transport command')
  const repoRoot = path.resolve(repoArg)
  const context = readContext(contextArg)
  if (command === 'export') {
    assert.equal(process.arch, 'x64', 'MSYS candidate producer must run as native x64')
    const expected = exportAuthority(repoRoot, context)
    verifyCheckout(repoRoot, expected.producer)
    const native = trustedNative(repoRoot)
    const result = await portable.exportCandidate({
      buildRoot: path.resolve(inputArg), expected, destination: path.resolve(destinationArg), native,
    })
    return { ...result, expected,
      toolIdentityAuthority: 'trusted-builder-observation-not-independent-sdk-attestation',
      nativeAcceptance: 'not-performed' }
  }
  const { expected, transport, consumerHeadSha } = importAuthority(repoRoot, context)
  verifyCheckout(repoRoot, expected.producer, consumerHeadSha)
  const native = trustedNative(repoRoot)
  const result = await portable.importCandidate({
    packetRoot: path.resolve(inputArg), manifestSha256: transport.manifestSha256,
    expected, destination: path.resolve(destinationArg), native,
  })
  return { ...result, artifactId: transport.artifactId, archiveSha256: transport.archiveSha256,
    ...(consumerHeadSha ? { consumerHeadSha } : {}),
    githubProvenance: 'supplied-by-trusted-workflow-not-authenticated-by-this-command',
    nativeAcceptance: 'not-performed' }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(result => process.stdout.write(portable.canonical(result)))
    .catch(error => { process.stderr.write(`Candidate transport refused: ${error.message}\n`); process.exitCode = 1 })
}

module.exports = { main, readContext, sourceBindings, exportAuthority, importAuthority, compiledText, PINNED_BASH }
