'use strict'

// CI drives the installed vendor binary and never substitutes a version stub.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')

function exportEnvironment(name, value) {
  assert.ok(process.env.GITHUB_ENV, 'This setup command requires GITHUB_ENV')
  assert.equal(/[\r\n]/.test(value), false)
  fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`)
}

const WINDOWS_NATIVE_CASES = Object.freeze([
  'native Windows host NUL basic query records exact and oversized buffer results',
  'native Windows Node pipe diagnostic records stdio and fork IPC support with owned job drain',
  'native Windows NUL diagnostic records exact device access under an AppContainer token',
  'native Windows Null capability stays distinct from stdin and excludes stray handles across concurrent profiles',
  'native Windows member authority verifies actual descendants and preserves root image binding',
  'native Windows pipe diagnostic records namespace and descriptor outcomes under an AppContainer token',
  'native Windows MSYS namespace isolates event and section leaves across profiles and releases owned names',
  'Windows resource ancestry tolerates sibling writes while refusing captured mutations and ancestor replacement',
  'native Windows .git grants deny mutation and restore inheritance after owned drain',
  'native Windows resource scale restores large trees after AppContainer mutation and refuses admission overflow',
  'native Windows resource identity recovery preserves moved originals and refuses ambiguous lookup failures',
  'native Windows filesystem scale captures copies renames flushes and cleans bounded large trees',
  'Windows HANDLE capture reads bounded bytes and returns a stable content digest',
  'Windows HANDLE capture accepts strict UTF-8 request bytes and rejects malformed UTF-8',
  'Windows HANDLE capture accepts canonical long components and refuses their 8.3 aliases',
  'Windows HANDLE capture refuses reparse points, hard links, devices and ambiguous components',
  'Windows HANDLE capture refuses a live writable mapped view after its stream closes',
  'Windows HANDLE capture rejects closed-protocol violations and size overrun',
  'Windows HANDLE tree capture includes empty directories, exact bytes, and held stat identities',
  'Windows HANDLE tree capture refuses hardlinked descendants and linked directories',
  'Windows HANDLE capture permits unrelated sibling activity while retaining the captured subtree checks',
  'Windows terminal publication is exclusive, byte-bound, and cleans only its held temporary',
  'Windows owned cleanup binds the target, validates the entire tree, and proves final absence',
  'Windows transaction operations durably create, copy readonly projection, and rename without replacement',
  'Windows transaction copy rejects hardlinks and reparse traversal before publication',
  'Windows transaction rename refuses mutate-and-restore USN races and rolls the root back',
  'native Windows Bash copied closure permits scratch writes and denies candidate writes and controller reads',
  'native Windows controller scratch has protected ownership and rejects inherited permissions on reuse',
  'native Windows worker clone is privately writable without relabeling the source or an occupied clone',
  'native capability command reads exact fixture bytes through the real platform shell',
  'failed native isolation assertion cannot emit a successful closed-canary challenge',
])

function assertHostPrimitiveCases(output, platform = process.platform) {
  if (platform === 'win32') {
    for (const name of WINDOWS_NATIVE_CASES) assertNamedCase(output, name)
    return WINDOWS_NATIVE_CASES.length
  }
  const requirements = {
    linux: { minimum: 8, names: /^(?:descriptor capture |capture spool |capture request |a later-file |capture rechecks |native capability command |failed native isolation assertion )/ },
    darwin: { minimum: 8, names: /^(?:native Darwin |actual Darwin observer |native capability command |failed native isolation assertion )/ },
  }
  const required = requirements[platform]
  assert.ok(required, `Unsupported primitive host: ${platform}`)
  const cases = [...output.matchAll(/^(ok|not ok) \d+ - (.+)$/gm)].filter(match => required.names.test(match[2]))
  assert.ok(cases.length >= required.minimum, `Expected at least ${required.minimum} actual ${platform} primitive cases; observed ${cases.length}`)
  for (const [, status, name] of cases) {
    assert.equal(status, 'ok', `Native primitive failed: ${name}`)
    assert.equal(/# (?:SKIP|TODO)\b/i.test(name), false, `Native primitive must execute: ${name}`)
  }
  return cases.length
}

function assertNamedCase(output, expected) {
  const cases = [...output.matchAll(/^(ok|not ok) \d+ - (.+)$/gm)]
    .filter(match => match[2].replace(/ # (?:SKIP|TODO)\b.*$/i, '') === expected)
  assert.equal(cases.length, 1, `Expected exactly one result for ${expected}`)
  assert.equal(cases[0][1], 'ok', `Required test failed: ${expected}`)
  assert.equal(/# (?:SKIP|TODO)\b/i.test(cases[0][2]), false, `Required test must execute: ${expected}`)
}

function assertDoctorCases(output, platform = process.platform) {
  const cases = [...output.matchAll(/^(ok|not ok) \d+ - (.+)$/gm)]
  assert.ok(cases.length >= 14, `Expected all 14 doctor readiness cases; observed ${cases.length}`)
  for (const [, status, name] of cases) {
    assert.equal(status, 'ok', `Doctor readiness failed: ${name}`)
    assert.equal(/# TODO\b/i.test(name), false, `Doctor readiness must execute: ${name}`)
    if (/# SKIP\b/i.test(name)) assert.ok(platform === 'win32' &&
      /^(?:POSIX doctor reports |(?:bash|powershell) (?:claude|reasonix) doctor never probes )/.test(name),
    `Only the explicit POSIX fixture cases may skip on Windows: ${name}`)
  }
  assertNamedCase(output, 'PowerShell doctor exposes activation failure and strict fails with an intact payload')
}

async function runTests(argv, environment, logPath) {
  // Preserve evidence as it arrives, including when a hung job is cancelled
  // before the child closes and the final assertions can run.
  const log = fs.openSync(logPath, 'w')
  try {
    const child = cp.spawn(process.execPath, argv, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { fs.writeSync(log, bytes); output += bytes; process.stdout.write(bytes) })
    child.stderr.on('data', bytes => { fs.writeSync(log, bytes); output += bytes; process.stderr.write(bytes) })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    return { code, output }
  } finally { fs.closeSync(log) }
}

async function main() {
  const action = process.argv[2]
  if (process.env.AUTOPROMPT_CI_EXPECTED_ARCH) assert.equal(process.arch, process.env.AUTOPROMPT_CI_EXPECTED_ARCH,
    'The runner must exercise the requested architecture, without silently using an emulated Node binary')
  if (action === 'doctor') {
    const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    cp.execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 30000 })
    const { code, output } = await runTests(['--test', '--test-reporter=tap', '--test-concurrency=1',
      'tests/source/harness-v2-doctor-readiness.test.cjs'], process.env, 'native-platform-doctor.log')
    assert.equal(code, 0, 'Doctor readiness and subprocess isolation failed')
    assertDoctorCases(output)
    return
  }
  if (action === 'kilo-shell') {
    const name = 'Bash custom Kilo root verifies activation refusal, tamper recovery, and uninstall'
    const { code, output } = await runTests(['--test', '--test-reporter=tap', '--test-concurrency=1',
      '--test-name-pattern', `^${name}$`, 'tests/source/install-custom-root.test.cjs'], process.env, 'native-platform-kilo-shell.log')
    assert.equal(code, 0, 'Kilo shell installer lifecycle failed')
    assertNamedCase(output, name)
    return
  }
  if (action === 'platform') {
    const command = require('../../package.json').scripts['test:platform'].split(/\s+/)
    assert.deepEqual(command.slice(0, 2), ['node', '--test'])
    assert.ok(command.slice(2).every(argument => /^tests\/source\/[A-Za-z0-9.-]+\.test\.cjs$/.test(argument)))
    const { code, output } = await runTests(['--test', '--test-reporter=tap', ...command.slice(2)], process.env, 'native-platform-primitives.log')
    assert.equal(code, 0, 'Platform primitives failed')
    const count = assertHostPrimitiveCases(output)
    process.stdout.write(`Executed ${count} required native ${process.platform}/${process.arch} primitive cases without skips.\n`)
    return
  }
  if (action === 'prepare') {
    assert.ok(['linux', 'win32'].includes(process.platform), 'Only Linux and Windows currently have a native command sandbox')
    assert.ok(['x64', 'arm64'].includes(process.arch))
    exportEnvironment('CLAUDE_NATIVE_PACKAGE', `@anthropic-ai/claude-code-${process.platform}-${process.arch}`)
    return
  }
  if (action === 'macos-primitives') {
    assert.equal(process.platform, 'darwin')
    const python = cp.execFileSync('python3', ['-I', '-S', '-c', 'import os,sys; print(os.path.realpath(sys.executable))'], { encoding: 'utf8' }).trim()
    exportEnvironment('AUTOPROMPT_REAL_DARWIN_PYTHON', python)
    exportEnvironment('AUTOPROMPT_REAL_DARWIN_PROCESS', '1')
    exportEnvironment('AUTOPROMPT_REAL_DARWIN_FILESYSTEM', '1')
    const sandbox = await boundary.probeCommandSandbox()
    assert.equal(sandbox.supported, false, 'Update the native capability matrix when macOS gains a supported command sandbox')
    assert.equal(sandbox.code, 'COMMAND_SANDBOX_UNSUPPORTED')
    process.stdout.write('macOS: native filesystem/process tests enabled. Native Claude activation remains unavailable; VM runtime is required.\n')
    return
  }
  assert.equal(action, 'run', 'Expected platform, doctor, kilo-shell, prepare, macos-primitives or run')
  assert.ok(['linux', 'win32'].includes(process.platform))
  const version = process.env.CLAUDE_CODE_VERSION
  assert.match(version || '', /^\d+\.\d+\.\d+$/)
  const packageName = `@anthropic-ai/claude-code-${process.platform}-${process.arch}`
  const packageRoot = path.resolve('.native-claude', 'node_modules', packageName)
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(metadata.name, packageName)
  assert.equal(metadata.version, version)
  const executable = fs.realpathSync.native(path.join(packageRoot, process.platform === 'win32' ? 'claude.exe' : 'claude'))
  const observedVersion = cp.execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim()
  assert.match(observedVersion, new RegExp(`(?:^|\\s)${version.replaceAll('.', '\\.')}\\s`))
  const evidence = { platform: process.platform, architecture: process.arch, node: process.version,
    package: packageName, packageVersion: metadata.version, observedVersion, executable,
    sandbox: await boundary.probeCommandSandbox(), nativeCapabilitiesPassed: false }
  const publish = () => fs.writeFileSync('native-platform-evidence.json', JSON.stringify(evidence, null, 2) + '\n')
  publish()
  assert.equal(evidence.sandbox.supported, true, `Native sandbox prerequisite failed: ${JSON.stringify(evidence.sandbox)}`)
  const { code, output } = await runTests(['--test', '--test-reporter=tap', '--test-concurrency=1',
    'tests/source/harness-v2-claude-capability-native.test.cjs',
    'tests/source/harness-v2-installed-canary-native.test.cjs'],
  { ...process.env, AUTOPROMPT_CLAUDE_TEST_CLI: executable, AUTOPROMPT_REQUIRE_NATIVE_TESTS: '1' }, 'native-platform-tests.log')
  evidence.exitCode = code
  evidence.skipped = /# SKIP\b/i.test(output) || !/^# skipped 0\s*$/m.test(output)
  evidence.nativeCapabilitiesPassed = code === 0 && !evidence.skipped
  publish()
  assert.equal(code, 0, 'Installed native Claude capability tests failed')
  assert.equal(evidence.skipped, false, 'Native capability certification must execute every case without skips')
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
module.exports = { WINDOWS_NATIVE_CASES, assertHostPrimitiveCases, assertDoctorCases, assertNamedCase }
