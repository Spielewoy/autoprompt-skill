#!/usr/bin/env node
'use strict'

// Diagnostic only.  It compares the real owned Electron launch using a short
// physical profile with the production Darwin alias.  It is deliberately not
// a provider certification: the temporary test runner writes one private
// sentinel and exits before any model or tool protocol is configured.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { OwnedCodexProxyRunner } = require('../../agents/codex/workflow/phase-budget.js')
const native = require('../../scripts/harness-v2-native.cjs')
const alias = require('../../scripts/harness-v2-vscode-ipc-alias.cjs')
const { nativeProcessAdapter, privateDirectory, nativeEnvironment } = require('./native-platform.cjs')

const MAX_TAIL = 12 * 1024
const TIMEOUT_MS = 90_000
const textTail = file => {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null
    return fs.readFileSync(file).subarray(Math.max(0, stat.size - MAX_TAIL)).toString('utf8')
  } catch { return null }
}
function requireDarwin(executable = process.env.AUTOPROMPT_VSCODE_TEST_CLI) {
  assert.equal(process.platform, 'darwin', 'VS Code macOS diagnostic requires macOS')
  assert.ok(typeof executable === 'string' && path.isAbsolute(executable), 'AUTOPROMPT_VSCODE_TEST_CLI must be an absolute Code executable')
  const code = fs.realpathSync.native(executable)
  assert.equal(path.basename(code), 'Code', 'diagnostic executable must be the bundled Code binary')
  assert.ok(fs.lstatSync(code).isFile(), 'diagnostic Code binary must be regular')
  return code
}
function logs(root) {
  const directory = path.join(root, 'logs')
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 2).map(entry => {
      const base = path.join(directory, entry.name, 'window1')
      return { name: entry.name, main: textTail(path.join(directory, entry.name, 'main.log')),
        renderer: textTail(path.join(base, 'renderer.log')), extensionHost: textTail(path.join(base, 'exthost', 'exthost.log')) }
    })
  } catch { return [] }
}
function driver(file, sentinel) {
  fs.writeFileSync(file, [
    "'use strict'",
    "const fs = require('node:fs')",
    'exports.run = async () => {',
    `  fs.writeFileSync(${JSON.stringify(sentinel)}, 'VSCODE_MACOS_DIAGNOSTIC_OK\\n', { flag: 'wx', mode: 0o600 })`,
    "  console.log('AUTOPROMPT_VSCODE_MACOS_DIAGNOSTIC_DRIVER_ENTERED')",
    '}',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' })
}
function baseEnvironment(home, reservationId, adapter, extra) {
  return prepareProcessLaunchEnvironment(adapter, reservationId, {
    ...native.isolatedEnvironment(home, nativeEnvironment()), ...extra,
  })
}
async function variant(root, code, name, useAlias) {
  // The control root may use the normal deep Darwin temporary directory, but
  // the baseline profile must itself be genuinely short.  Otherwise its IPC
  // descendants would reproduce the very alias condition being compared.
  const directory = useAlias
    ? privateDirectory(path.join(root, name))
    : privateDirectory(fs.realpathSync.native(fs.mkdtempSync('/private/tmp/vm-')))
  const home = privateDirectory(path.join(directory, 'home'))
  const userData = privateDirectory(path.join(home, 'user-data'))
  const extensions = privateDirectory(path.join(home, 'extensions'))
  const registryPath = path.join(directory, 'processes.json')
  const adapter = nativeProcessAdapter(registryPath, directory)
  const owner = new ProcessOwner({ adapter, registryPath, pollMs: 20 })
  const runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: privateDirectory(path.join(directory, 'proxy')),
    targetKey: `vscode-macos-diagnostic-${name}`, activationId: `vscode-macos-diagnostic:${crypto.randomUUID()}`, generationId: 1, pollMs: 20 })
  const sessionId = crypto.randomUUID(), reservationId = crypto.randomUUID()
  const sentinel = path.join(directory, 'driver-sentinel')
  const testDriver = path.join(directory, 'driver.cjs')
  // This external test file is an intentional use of VS Code's documented
  // local-host fallback in findTestExtensionHost; the existing native bridge
  // probe uses that same test-file shape. It avoids modifying the development
  // extension merely to run a diagnostic.
  driver(testDriver, sentinel)
  if (!useAlias) assert.ok(Buffer.byteLength(path.join(userData, '0000-main.sock')) < 103, 'physical baseline profile must fit Darwin IPC')
  let resource = null, entered = false, execution = null, failure = null, retained = false, pending = null
  try {
    let profile = userData
    if (useAlias) {
      resource = await alias.prepare({ journalPath: path.join(directory, 'vscode-ipc-alias.json'), targetPath: userData,
        binding: { sessionId, reservationId, targetKey: runner.targetKey }, processOwner: owner })
      profile = resource.userDataDir
      assert.ok(Buffer.byteLength(path.join(userData, '0000-main.sock')) >= 103, 'alias target must retain the deep production IPC path')
    }
    const argv = ['--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--log', 'trace',
      '--user-data-dir', profile, '--extensions-dir', extensions,
      '--extensionDevelopmentPath', path.resolve(__dirname, '../../scripts/harness-v2-bridge/vscode'), '--extensionTestsPath', testDriver]
    const env = baseEnvironment(home, reservationId, adapter, useAlias ? { TMPDIR: path.join(profile, 't'), TMP: path.join(profile, 't'), TEMP: path.join(profile, 't') } : {})
    if (useAlias) fs.mkdirSync(path.join(userData, 't'), { mode: 0o700 })
    if (resource) { resource.markReservationEntered(); entered = true }
    pending = runner.run({ executable: code, argv, cwd: directory, env, stdin: '', shell: false, sessionId, reservationId,
      ...(resource ? { launchBindingHash: resource.launchBindingHash } : {}) })
    // Avoid an unhandled rejection if the ownership deadline wins the race.
    pending.catch(() => {})
    let timer
    try {
      execution = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('owned VS Code diagnostic timed out'), { code: 'DIAGNOSTIC_TIMEOUT' })), TIMEOUT_MS) })])
    } finally { clearTimeout(timer) }
    assert.equal(execution.processOwned, true)
    assert.equal(execution.drained, true)
    assert.equal(execution.status, 0, execution.stderr)
    assert.equal(execution.signal, null, execution.stderr)
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'VSCODE_MACOS_DIAGNOSTIC_OK\n')
  } catch (error) {
    failure = error
    try { await owner.cancelAll({ reason: 'VS Code macOS diagnostic failure', graceMs: 0, killMs: 2000, waitForPending: true }) } catch (cleanup) { failure.cleanupFailure = { code: cleanup.code || 'ERROR', message: cleanup.message } }
    // The proxy can still be publishing its terminal transcript after its
    // group drain.  Await it before examining files or retiring the root.
    if (pending) { try { await pending } catch {} }
  }
  let drained = false
  try { await owner.assertDrained(); drained = true } catch (error) { failure ||= error }
  try {
    if (resource) {
      if (entered) await resource.release()
      else resource.abortBeforeReservation()
    }
  } catch (error) {
    failure ||= error
    try { Object.defineProperty(failure, 'cleanupFailure', { value: { code: error.code || 'ERROR', message: error.message }, configurable: true }) } catch {}
  }
  const result = { name, alias: useAlias, status: execution?.status ?? null, signal: execution?.signal ?? null,
    stdout: execution?.stdout?.slice(-MAX_TAIL) || '', stderr: execution?.stderr?.slice(-MAX_TAIL) || '',
    sentinel: fs.existsSync(sentinel), logs: logs(userData), drained,
    error: failure ? { code: failure.code || 'ERROR', message: String(failure.message || failure).slice(0, 2048), cleanupFailure: failure.cleanupFailure || null } : null }
  retained = !drained || Boolean(failure?.cleanupFailure)
  if (useAlias) {
    const journalPath = path.join(directory, 'vscode-ipc-alias.json')
    try {
      if (fs.existsSync(journalPath) && JSON.parse(fs.readFileSync(journalPath, 'utf8')).state !== 'CLEANED') retained = true
    } catch { retained = true }
  }
  if (!retained) fs.rmSync(directory, { recursive: true, force: true })
  return { result, retained }
}
async function runDiagnostic(executable) {
  const code = requireDarwin(executable)
  const root = privateDirectory(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-macos-diagnostic-'))))
  const results = [], retained = []
  for (const [name, useAlias] of [['physical', false], ['production-alias', true]]) {
    const value = await variant(root, code, name, useAlias)
    results.push(value.result)
    if (value.retained) retained.push(name)
  }
  if (!retained.length) fs.rmSync(root, { recursive: true, force: true })
  return { schemaVersion: 1, platform: process.platform, architecture: process.arch, executable: code, variants: results, retained }
}
if (require.main === module) runDiagnostic().then(value => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  if (value.variants.some(variant => variant.error)) process.exitCode = 1
}, error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
module.exports = { requireDarwin, runDiagnostic, variant, logs }
