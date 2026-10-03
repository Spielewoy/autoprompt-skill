'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const test = require('node:test')
const pkg = require('../../scripts/harness-v2-package.cjs')
const ROOT = path.resolve(__dirname, '../..')

function context(t, provider = 'claude') {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-doctor-readiness-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'config with spaces')
  const env = { ...process.env, HOME: path.join(directory, 'home'), USERPROFILE: path.join(directory, 'home'),
    AUTOPROMPT_INSTALL_ROOT: root, AUTOPROMPT_CLAUDE_CLI: path.join(directory, 'missing-native-executable') }
  if (provider === 'reasonix') require('../../scripts/reasonix-package.cjs').install(root)
  else pkg.install(provider, root)
  return { directory, root, env }
}
function snapshot(root) {
  return Object.fromEntries(pkg.walk(root).map(file => [file, fs.readFileSync(path.join(root, file)).toString('base64')]))
}

test('doctor separates a verified installation from unavailable native activation and preserves installed bytes', t => {
  const { root, env } = context(t)
  const before = snapshot(root)
  assert.equal(pkg.verify('claude', root).status, 'verified')
  const report = pkg.doctorPrerequisites('claude', root, { env })
  assert.equal(report.payload, 'verified')
  assert.equal(report.activation, 'unavailable')
  assert.equal(report.reason, 'provider-unsupported')
  assert.match(report.message, /not installed or executable/)
  assert.deepEqual(snapshot(root), before)
  assert.equal(fs.existsSync(path.join(root, '.autoprompt-private', 'activations')), false)
})

test('Reasonix doctor shares truthful activation readiness in its provider-specific package and shell route', t => {
  const { root, directory, env } = context(t, 'reasonix')
  env.AUTOPROMPT_REASONIX_CLI = path.join(directory, 'missing-reasonix')
  const reasonix = require('../../scripts/reasonix-package.cjs')
  const before = snapshot(root)
  const report = reasonix.doctorPrerequisites(root, { env })
  assert.equal(report.payload, 'verified')
  assert.equal(report.activation, 'unavailable')
  assert.match(report.message, /not installed|not executable|cannot|Cannot|not found/)
  assert.deepEqual(snapshot(root), before)
  if (process.platform !== 'win32') {
    const result = cp.spawnSync('bash', [path.join(ROOT, 'scripts/install/doctor.sh'), 'reasonix', '--strict'], { env, encoding: 'utf8', timeout: 120000 })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /payload=verified activation=unavailable/)
  }
})

test('Reasonix doctor version/help subprocesses receive neither ambient secrets nor workspace state', t => {
  const { root, env } = context(t, 'reasonix')
  const reasonix = require('../../scripts/reasonix-package.cjs')
  const native = require('../../agents/reasonix/workflow/native.js')
  let observed
  t.mock.method(native, 'probeExecutable', options => {
    const result = options.spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,secret:process.env.OPENAI_API_KEY,nodeOptions:process.env.NODE_OPTIONS}))'], { encoding: 'utf8', env: options.env, shell: false })
    assert.equal(result.status, 0, result.stderr)
    observed = JSON.parse(result.stdout)
    throw Object.assign(new Error('Stop after isolated diagnostic probe'), { code: 'PROVIDER_UNSUPPORTED' })
  })
  const report = reasonix.doctorPrerequisites(root, { env: { ...env, OPENAI_API_KEY: 'do-not-expose', NODE_OPTIONS: '--require nonexistent' } })
  assert.equal(report.activation, 'unavailable')
  assert.equal(observed.secret, undefined)
  assert.equal(observed.nodeOptions, undefined)
  assert.notEqual(observed.cwd, ROOT)
  assert.notEqual(observed.home, env.HOME)
  assert.equal(fs.existsSync(observed.cwd), false, 'temporary probe directory is removed')
})

test('doctor command returns an actionable machine-readable failure rather than payload-only success', t => {
  const { root, env } = context(t)
  const result = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts/harness-v2-package.cjs'), 'doctor', 'claude', '--root', root], { env, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.payload, 'verified')
  assert.equal(report.activation, 'unavailable')
  assert.match(report.message, /claude is not installed or executable/)
})

test('doctor refuses corrupt payloads before probing an executable', t => {
  const { root, env } = context(t)
  const installed = pkg.verify('claude', root)
  fs.appendFileSync(path.join(installed.bundle, 'scripts/harness-v2-native.cjs'), '\n// unexpected drift\n')
  assert.throws(() => pkg.doctorPrerequisites('claude', root, { env }), { code: 'PAYLOAD_INVALID' })
})

for (const mode of ['signed', 'local-canary', 'invalid-import']) test(`doctor admission routing: ${mode}`, t => {
  const { root, env } = context(t)
  const native = require('../../scripts/harness-v2-native.cjs')
  const admission = require('../../scripts/harness-v2-admission.cjs')
  const configure = require('../../scripts/harness-v2-configure.cjs')
  let pendingCalls = 0
  // These injected results exercise diagnostic routing only. They do not
  // constitute platform, executable, or live-conformance evidence.
  t.mock.method(native, 'probeExecutable', options => {
    assert.equal(options.provider, 'claude')
    assert.equal(options.env, env)
    return { version: '2.1.270' }
  })
  t.mock.method(configure, 'importedAdmission', () => mode === 'invalid-import' ? { trustDirectory: path.join(root, 'imported') } : null)
  t.mock.method(admission, 'verifyAdmission', () => {
    if (mode !== 'signed') throw Object.assign(new Error('exact runtime has no valid signed admission'), { code: 'PROVIDER_UNSUPPORTED' })
    return { valid: true }
  })
  t.mock.method(admission, 'reviewedLocalPending', () => { pendingCalls += 1; return { mode: 'local-canary-pending' } })
  t.mock.method(require('../../scripts/harness-v2-tool-boundary.cjs'), 'assertCommandSandboxPrerequisites', () => ({ backend: 'diagnostic-routing-fixture' }))
  const before = snapshot(root)
  const report = pkg.doctorPrerequisites('claude', root, { env })
  assert.equal(report.activation, mode === 'signed' ? 'static-ready;dynamic-preflight-required' : mode === 'local-canary' ? 'local-canary-required' : 'unavailable')
  assert.equal(pendingCalls, mode === 'local-canary' ? 1 : 0)
  if (mode === 'invalid-import') assert.match(report.message, /no valid signed admission/)
  assert.deepEqual(snapshot(root), before)
})

test('POSIX doctor reports unavailable activation and strict fails while informational doctor remains readable', { skip: process.platform === 'win32' }, t => {
  const { root, env } = context(t)
  const script = path.join(ROOT, 'scripts/install/doctor.sh')
  const invoke = args => cp.spawnSync('bash', [script, 'claude', ...args], { env, encoding: 'utf8', timeout: 120000 })
  const strict = invoke(['--strict'])
  assert.equal(strict.status, 1, strict.stderr)
  assert.match(strict.stdout, /payload=verified activation=unavailable/)
  assert.match(strict.stdout, /not installed or executable/)
  assert.equal(invoke([]).status, 0)
  assert.equal(fs.existsSync(path.join(root, '.autoprompt-private', 'activations')), false)
})

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const hasPowerShell = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0
test('PowerShell doctor exposes activation failure and strict fails with an intact payload', { skip: !hasPowerShell }, t => {
  const { env } = context(t)
  const result = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/install/doctor.ps1'), 'claude', '-Strict'], { env, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /payload=verified activation=unavailable/)
  assert.match(result.stdout, /not installed or executable/)
})

// These executable fixtures inspect wrapper process boundaries only. They
// intentionally lack a native help interface and cannot establish admission.
for (const provider of ['claude', 'reasonix']) for (const wrapper of ['bash', 'powershell']) {
  test(`${wrapper} ${provider} doctor never probes corrupt or absent payloads and isolates installed native diagnostics`, {
    skip: process.platform === 'win32' || (wrapper === 'powershell' && !hasPowerShell),
  }, t => {
    const { root, directory, env } = context(t, provider)
    const bin = path.join(directory, 'diagnostic bin'), log = path.join(directory, 'native-probe.jsonl')
    fs.mkdirSync(bin)
    const executable = path.join(bin, provider)
    fs.writeFileSync(executable, `#!${process.execPath}\n` +
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,secret:process.env.OPENAI_API_KEY,nodeOptions:process.env.NODE_OPTIONS})+'\\n');\n` +
      `console.log(${JSON.stringify(provider === 'reasonix' ? 'reasonix 1.30.0' : '2.1.270')});\n`, { mode: 0o700 })
    const isolatedEnv = { ...env, PATH: `${bin}${path.delimiter}${env.PATH}`,
      [`AUTOPROMPT_${provider.toUpperCase()}_CLI`]: executable,
      OPENAI_API_KEY: 'dummy-wrapper-review-sentinel', NODE_OPTIONS: '--trace-warnings' }
    const invoke = override => cp.spawnSync(wrapper === 'bash' ? 'bash' : powershell,
      wrapper === 'bash' ? [path.join(ROOT, 'scripts/install/doctor.sh'), provider, '--strict'] :
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/install/doctor.ps1'), provider, '-Strict'],
      { env: { ...isolatedEnv, ...override }, encoding: 'utf8', timeout: 120000 })

    const absent = invoke({ AUTOPROMPT_INSTALL_ROOT: path.join(directory, 'not installed') })
    assert.equal(absent.status, 1, absent.stderr)
    assert.match(absent.stdout, /version=- reason=not-installed/)
    assert.equal(fs.existsSync(log), false, 'locating an uninstalled provider must not run it')

    const healthy = invoke()
    assert.equal(healthy.status, 1, healthy.stderr)
    assert.match(healthy.stdout, /payload=verified activation=unavailable/)
    const observations = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(observations.length, 2, 'only the isolated version and help probes should run')
    for (const observation of observations) {
      assert.equal(observation.secret, undefined)
      assert.equal(observation.nodeOptions, undefined)
      assert.notEqual(observation.cwd, ROOT)
      assert.notEqual(observation.home, env.HOME)
      assert.equal(fs.existsSync(observation.cwd), false, 'the temporary diagnostic directory is removed')
    }

    const installed = provider === 'reasonix' ? require('../../scripts/reasonix-package.cjs').verify(root) : pkg.verify(provider, root)
    fs.appendFileSync(path.join(installed.bundle, 'scripts/harness-v2-canary.cjs'), '\n// corrupted wrapper fixture\n')
    fs.unlinkSync(log)
    const corrupt = invoke()
    assert.equal(corrupt.status, 1, corrupt.stderr)
    assert.match(corrupt.stdout, /reason=payload-invalid/)
    assert.equal(fs.existsSync(log), false, 'payload integrity must fail before any native subprocess')
  })
}
