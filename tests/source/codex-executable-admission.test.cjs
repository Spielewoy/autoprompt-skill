'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const configure = require('../../scripts/codex-configure.cjs')
const {
  CodexExecutableError,
  admitCodexExecutable,
  bindAdmittedCodexExecutable,
  openCodexExecutableAdmission,
  platformBinding,
  queryAdmittedCodexVersion,
  resolveCodexExecutable,
  runtimeFromPackage,
  runtimeFromStandalonePackage,
} = require('../../agents/codex/workflow/codex-executable.js')
const shippedRegistry = require('../../agents/contracts/providers.json')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeOfficialPackage(packageRoot, version, executableBytes) {
  const [nativePackageName, targetTriple, executableName] = platformBinding()
  const nativeVersion = `${version}-${process.platform}-${process.arch}`
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@openai/codex',
    version,
    bin: { codex: 'bin/codex.js' },
    optionalDependencies: {
      [nativePackageName]: `npm:@openai/codex@${nativeVersion}`,
    },
  })}\n`)
  const nativeRoot = path.join(packageRoot, 'node_modules', ...nativePackageName.split('/'))
  const executable = path.join(nativeRoot, 'vendor', targetTriple, 'bin', executableName)
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(path.join(nativeRoot, 'package.json'), `${JSON.stringify({
    name: '@openai/codex', version: nativeVersion,
    os: [process.platform], cpu: [process.arch],
  })}\n`)
  fs.writeFileSync(executable, executableBytes)
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755)
  return executable
}

function writeStandalonePackage(packageRoot, version, executableBytes) {
  const [, target, executableName] = platformBinding()
  const executable = path.join(packageRoot, 'bin', executableName)
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1, version, target, variant: 'codex',
    entrypoint: `bin/${executableName}`, resourcesDir: 'codex-resources', pathDir: 'codex-path',
  }))
  fs.writeFileSync(executable, executableBytes)
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755)
  return executable
}

test('standalone package discovery stays inert and requires canonical signed trust', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-standalone-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const packageRoot = path.join(sandbox, 'release')
  const executable = writeStandalonePackage(packageRoot, '7.4.1', Buffer.from('untrusted-native-bytes'))
  let bin = path.dirname(executable)
  if (process.platform !== 'win32') {
    // The installer exposes a PATH symlink through a movable current release.
    fs.symlinkSync(packageRoot, path.join(sandbox, 'current'), 'dir')
    bin = path.join(sandbox, 'local-bin')
    fs.mkdirSync(bin)
    fs.symlinkSync(path.join(sandbox, 'current', 'bin', 'codex'), path.join(bin, 'codex'))
  }
  const environment = { PATH: bin }
  const candidate = resolveCodexExecutable('codex', { environment })
  assert.equal(candidate.source, 'standalone-package-runtime')
  assert.equal(candidate.provenance.kind, 'standalone-package-layout-v1')
  assert.equal(candidate.executable, fs.realpathSync.native(executable))
  assert.equal(candidate.identity.sha256, sha256(executable))
  assert.equal(candidate.identity.version, 'codex-cli 7.4.1')
  assert.deepEqual(candidate.environmentOverlay, {})
  let executions = 0
  const spawnSync = () => {
    executions += 1
    return { status: 0, stdout: 'codex-cli 7.4.1\n', stderr: '' }
  }
  assert.throws(() => queryAdmittedCodexVersion(candidate, { spawnSync }), CodexExecutableError)
  const trust = configure.evaluateCanonicalCodexCapabilityTrust(shippedRegistry, {
    env: environment, spawnSync,
  })
  assert.equal(trust.ready, false)
  assert.equal(trust.runtimeIdentity.codexExecutableRuntime.source, 'standalone-package-runtime')
  assert.ok(trust.blockers.includes('canonical-live-evidence-invalid'))
  assert.equal(executions, 0)
})

test('standalone admission reopens the exact metadata and rejects metadata or executable drift', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-standalone-binding-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const executable = writeStandalonePackage(sandbox, '7.4.1', Buffer.from('fixture-native-bytes'))
  const candidate = runtimeFromStandalonePackage(sandbox)
  const admitted = admitCodexExecutable(candidate, candidate.identity)
  const runtimeIdentityHash = 'a'.repeat(64)
  const binding = bindAdmittedCodexExecutable(admitted, runtimeIdentityHash)
  const reopened = openCodexExecutableAdmission(binding, runtimeIdentityHash)
  assert.deepEqual(reopened.identity, candidate.identity)
  assert.equal(queryAdmittedCodexVersion(reopened, {
    spawnSync: () => ({ status: 0, stdout: 'codex-cli 7.4.1\n' }),
  }), 'codex-cli 7.4.1')
  const metadataPath = path.join(sandbox, 'codex-package.json')
  const metadataBytes = fs.readFileSync(metadataPath)
  fs.appendFileSync(metadataPath, '\n')
  assert.throws(() => openCodexExecutableAdmission(binding, runtimeIdentityHash), CodexExecutableError)
  fs.writeFileSync(metadataPath, metadataBytes)
  fs.appendFileSync(executable, 'drift')
  assert.throws(() => openCodexExecutableAdmission(binding, runtimeIdentityHash), CodexExecutableError)
})

test('standalone discovery rejects incompatible, redirected and linked package metadata', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-standalone-invalid-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const executable = writeStandalonePackage(sandbox, '7.4.1', Buffer.from('fixture-native-bytes'))
  const metadataPath = path.join(sandbox, 'codex-package.json')
  const metadata = JSON.parse(fs.readFileSync(metadataPath))
  for (const patch of [
    { layoutVersion: 2 }, { version: 'malformed' }, { target: 'other-target' },
    { variant: 'other' }, { entrypoint: '../codex' }, { resourcesDir: '../resources' },
    { pathDir: '../path' },
  ]) {
    fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, ...patch }))
    assert.equal(runtimeFromStandalonePackage(sandbox), null, JSON.stringify(patch))
  }
  fs.writeFileSync(metadataPath, JSON.stringify(metadata))
  fs.linkSync(metadataPath, path.join(sandbox, 'linked-metadata.json'))
  assert.equal(runtimeFromStandalonePackage(sandbox), null)
  fs.unlinkSync(path.join(sandbox, 'linked-metadata.json'))
  fs.linkSync(executable, path.join(sandbox, 'linked-executable'))
  assert.equal(runtimeFromStandalonePackage(sandbox), null)
})

test('a PATH-selected malicious Codex is refused without executing any candidate bytes', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-path-admission-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const malicious = path.join(sandbox, process.platform === 'win32' ? 'codex.exe' : 'codex')
  fs.writeFileSync(malicious, Buffer.from('malicious-path-candidate', 'utf8'))
  if (process.platform !== 'win32') fs.chmodSync(malicious, 0o755)

  let executions = 0
  const trust = configure.evaluateCanonicalCodexCapabilityTrust(shippedRegistry, {
    env: { PATH: sandbox },
    spawnSync() {
      executions += 1
      return { status: 0, stdout: 'codex-cli malicious\n', stderr: '' }
    },
  })

  assert.equal(executions, 0)
  assert.equal(trust.ready, false)
  assert.equal(trust.runtimeIdentity, null)
  assert.ok(trust.blockers.includes('candidate-runtime-identity-unavailable'))
  assert.throws(
    () => resolveCodexExecutable('codex', { environment: { PATH: sandbox } }),
    error => error instanceof CodexExecutableError && error.code === 'PROVIDER_UNSUPPORTED',
  )
  assert.throws(() => configure.requireCanonicalCodexCapabilityTrust({
    providerRegistry: shippedRegistry,
    env: { PATH: sandbox },
    spawnSync() {
      executions += 1
      return { status: 0, stdout: 'codex-cli malicious\n', stderr: '' }
    },
  }), error => error.code === 'PROVIDER_UNSUPPORTED' &&
      error.reason === 'canonical-provider-capability-refusal')
  assert.equal(executions, 0)
})

test('an official-shaped PATH package remains inert until signed trust admits its exact identity', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-path-package-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const bin = path.join(sandbox, 'bin')
  fs.mkdirSync(bin)
  const packageRoot = process.platform === 'win32'
    ? path.join(bin, 'node_modules', '@openai', 'codex')
    : path.join(sandbox, 'codex-package')
  writeOfficialPackage(packageRoot, '6.6.6', Buffer.from('malicious-package-candidate', 'utf8'))
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n')
  } else {
    const launcher = path.join(packageRoot, 'bin', 'codex.js')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.writeFileSync(launcher, '#!/usr/bin/env node\nprocess.exit(99)\n')
    fs.chmodSync(launcher, 0o755)
    fs.symlinkSync(launcher, path.join(bin, 'codex'))
  }

  let executions = 0
  const trust = configure.evaluateCanonicalCodexCapabilityTrust(shippedRegistry, {
    env: { PATH: bin },
    spawnSync() {
      executions += 1
      return { status: 0, stdout: 'codex-cli 6.6.6\n', stderr: '' }
    },
  })
  assert.equal(executions, 0)
  assert.equal(trust.ready, false)
  assert.equal(trust.runtimeIdentity.codexExecutableRuntime.source, 'official-package-runtime')
  assert.ok(trust.blockers.includes('canonical-live-evidence-invalid'))
})

test('an explicit absolute fixture is hash-pinned before its version can be queried', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-pinned-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const executable = path.join(sandbox, process.platform === 'win32' ? 'codex.exe' : 'codex')
  fs.copyFileSync(process.execPath, executable)
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755)
  const expectedVersion = 'codex-cli fixture-7.4.1'
  const expectedSha256 = sha256(executable)
  const candidate = resolveCodexExecutable(executable, { expectedSha256, expectedVersion })

  assert.equal(candidate.source, 'explicit-configured-runtime')
  assert.equal(candidate.executable, fs.realpathSync.native(executable))
  assert.equal(candidate.identity.sha256, expectedSha256)
  assert.equal(candidate.identity.version, expectedVersion)

  let executions = 0
  const spawnSync = (command, args, options) => {
    executions += 1
    assert.equal(command, candidate.executable)
    assert.deepEqual(args, ['--version'])
    assert.equal(options.shell, false)
    return { status: 0, stdout: `${expectedVersion}\n`, stderr: '' }
  }
  assert.throws(
    () => queryAdmittedCodexVersion(candidate, { spawnSync }),
    error => error instanceof CodexExecutableError,
  )
  assert.equal(executions, 0)

  const admitted = admitCodexExecutable(candidate, {
    realpath: candidate.executable,
    platform: process.platform,
    arch: process.arch,
    basename: path.basename(candidate.executable),
    sha256: expectedSha256,
    version: expectedVersion,
  })
  assert.equal(queryAdmittedCodexVersion(admitted, { spawnSync }), expectedVersion)
  assert.equal(executions, 1)

  fs.appendFileSync(executable, Buffer.from('drift', 'utf8'))
  assert.throws(
    () => admitCodexExecutable(candidate, admitted.identity),
    error => error instanceof CodexExecutableError,
  )
  assert.equal(executions, 1)
})

test('official package metadata supplies the candidate version without an executable query', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-package-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  assert.ok(platformBinding(), `unsupported test platform ${process.platform}:${process.arch}`)
  const version = '7.4.1'
  const executable = writeOfficialPackage(
    sandbox, version, Buffer.from('fixture-native-bytes', 'utf8'),
  )

  const runtime = runtimeFromPackage(sandbox)
  assert.ok(runtime)
  assert.equal(runtime.identity.version, `codex-cli ${version}`)
  assert.equal(runtime.identity.sha256, sha256(executable))
  assert.equal(runtime.provenance.kind, 'official-npm-package-v1')
  assert.equal(runtime.provenance.packageVersion, version)
})

test('local npm discovery binds a hoisted native sibling and rejects sibling drift', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-hoisted-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const packageRoot = path.join(sandbox, 'node_modules', '@openai', 'codex')
  const [nativePackageName] = platformBinding()
  const nestedRoot = path.join(packageRoot, 'node_modules', ...nativePackageName.split('/'))
  const nativeRoot = path.join(sandbox, 'node_modules', ...nativePackageName.split('/'))
  const nestedExecutable = writeOfficialPackage(packageRoot, '7.4.1', Buffer.from('hoisted-native-bytes'))
  const executable = path.join(nativeRoot, path.relative(nestedRoot, nestedExecutable))
  fs.renameSync(nestedRoot, nativeRoot)
  const candidate = runtimeFromPackage(packageRoot)
  assert.ok(candidate)
  assert.equal(candidate.source, 'official-package-runtime')
  assert.equal(candidate.executable, fs.realpathSync.native(executable))
  assert.equal(candidate.identity.version, 'codex-cli 7.4.1')
  assert.equal(candidate.identity.sha256, sha256(executable))
  assert.equal(candidate.provenance.nativePackageMetadataSha256,
    sha256(path.join(nativeRoot, 'package.json')))

  if (process.platform !== 'win32') {
    const launcher = path.join(packageRoot, 'bin', 'codex.js')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.writeFileSync(launcher, '#!/usr/bin/env node\nthrow new Error("must stay inert")\n')
    const bin = path.join(sandbox, 'node_modules', '.bin')
    fs.mkdirSync(bin)
    fs.symlinkSync(launcher, path.join(bin, 'codex'))
    assert.deepEqual(resolveCodexExecutable('codex', { environment: { PATH: bin } }), candidate)
  }

  const identityHash = 'b'.repeat(64)
  const admitted = admitCodexExecutable(candidate, candidate.identity)
  const binding = bindAdmittedCodexExecutable(admitted, identityHash)
  assert.deepEqual(openCodexExecutableAdmission(binding, identityHash).identity, candidate.identity)
  const metadataPath = path.join(nativeRoot, 'package.json')
  const metadata = fs.readFileSync(metadataPath)
  fs.appendFileSync(metadataPath, '\n')
  assert.throws(() => openCodexExecutableAdmission(binding, identityHash), CodexExecutableError)
  fs.writeFileSync(metadataPath, JSON.stringify({
    name: '@openai/codex', version: `9.9.9-${process.platform}-${process.arch}`,
    os: [process.platform], cpu: [process.arch],
  }))
  assert.equal(runtimeFromPackage(packageRoot), null)
  fs.writeFileSync(metadataPath, metadata)
  fs.appendFileSync(executable, 'drift')
  assert.throws(() => openCodexExecutableAdmission(binding, identityHash), CodexExecutableError)
  if (process.platform !== 'win32') {
    const foreignRoot = path.join(sandbox, 'foreign-native-package')
    fs.renameSync(nativeRoot, foreignRoot)
    fs.symlinkSync(foreignRoot, nativeRoot, 'dir')
    assert.equal(runtimeFromPackage(packageRoot), null,
      'a hoisted sibling must not redirect outside its native package root')
  }
})

test('explicit executable aliases and hardlinks are refused before admission', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-link-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const source = path.join(sandbox, process.platform === 'win32' ? 'source.exe' : 'source')
  const linked = path.join(sandbox, process.platform === 'win32' ? 'codex.exe' : 'codex')
  fs.copyFileSync(process.execPath, source)
  fs.linkSync(source, linked)
  if (process.platform !== 'win32') fs.chmodSync(source, 0o755)

  assert.throws(
    () => resolveCodexExecutable(linked, {
      expectedSha256: sha256(linked),
      expectedVersion: 'codex-cli fixture-7.4.1',
    }),
    error => error instanceof CodexExecutableError && error.code === 'PROVIDER_UNSUPPORTED',
  )
  assert.throws(
    () => resolveCodexExecutable(path.join('.', 'relative', 'codex')),
    error => error instanceof CodexExecutableError && error.code === 'PROVIDER_UNSUPPORTED',
  )
})
