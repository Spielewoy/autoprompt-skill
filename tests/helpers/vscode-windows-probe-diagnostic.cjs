'use strict'

// Diagnostic only: every launch is placed in its own native Windows Job and
// must produce the runner's exact drain receipt before its private state goes
// away. It neither certifies VS Code nor changes production admission.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { OwnedCodexProxyRunner } = require('../../agents/codex/workflow/phase-budget.js')
const native = require('../../scripts/harness-v2-native.cjs')
const { privateDirectory, nativeProcessAdapter } = require('./native-platform.cjs')

const MAX_OUTPUT = 2048
const TIMEOUT = 10_000
const REGISTRATION_GRACE = 30_000
const SETTLEMENT_GRACE = 10_000
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const bounded = value => String(value || '').replace(/[\r\n]+/g, ' ').slice(0, MAX_OUTPUT)

function resolveLayout(executable = process.env.AUTOPROMPT_VSCODE_TEST_CLI) {
  assert.equal(process.platform, 'win32', 'VS Code Windows diagnostics require Windows')
  assert.ok(typeof executable === 'string' && path.isAbsolute(executable), 'AUTOPROMPT_VSCODE_TEST_CLI must be absolute')
  const code = fs.realpathSync.native(executable)
  assert.equal(path.basename(code).toLowerCase(), 'code.exe', 'diagnostic executable must be Code.exe')
  const root = path.dirname(code)
  const directCli = path.join(root, 'resources', 'app', 'out', 'cli.js')
  let cli = directCli
  if (!fs.existsSync(cli)) {
    // 1.136.1's official Windows archive keeps Code.exe at its extraction
    // root while placing resources beneath its immutable release hash. Bind
    // only that one physical direct child; do not recursively discover a CLI.
    const candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-f0-9]{10,64}$/i.test(entry.name))
      .map(entry => path.join(root, entry.name, 'resources', 'app', 'out', 'cli.js'))
      .filter(file => { try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync.native(file) === file } catch { return false } })
    assert.equal(candidates.length, 1, `VS Code archive must contain exactly one physical release-hash CLI: ${root}`)
    cli = candidates[0]
  }
  assert.ok(fs.statSync(cli).isFile(), `VS Code CLI is missing: ${cli}`)
  return { code, cli }
}

function recordVariant({ name, mode, executable, argv, timedOut, execution, error, drained, retainedRoot, elapsedMs }) {
  const stdout = bounded(execution?.stdout), stderr = bounded(execution?.stderr)
  return {
    name, mode, executable, argv: [...argv], timedOut, elapsedMs,
    status: execution?.status ?? null, signal: execution?.signal ?? null,
    error: error ? { code: bounded(error.code || 'RUNTIME_FAILURE'), message: bounded(error.message || error) } : null,
    stdout, stderr, version: /\b(\d+\.\d+\.\d+)\b/.exec(`${stdout}\n${stderr}`)?.[1] || null,
    drained, retainedRoot,
  }
}

async function superviseOwnedRun(options) {
  const registrationTimeoutMs = options.registrationTimeoutMs
  const executionTimeoutMs = options.executionTimeoutMs
  const settlementTimeoutMs = options.settlementTimeoutMs
  if (!options.runPromise || typeof options.runPromise.then !== 'function' || typeof options.isRegistered !== 'function' ||
      typeof options.stop !== 'function' || typeof options.forceStop !== 'function' ||
      !Number.isSafeInteger(registrationTimeoutMs) || registrationTimeoutMs < 1 ||
      !Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1 ||
      !Number.isSafeInteger(settlementTimeoutMs) || settlementTimeoutMs < 1) throw new TypeError('Invalid VS Code diagnostic supervision')
  const wait = options.wait || delay
  const now = options.now || Date.now
  let settled = false, execution = null, error = null, stopResult = null, stopFailure = null, timedOut = false
  const settledPromise = Promise.resolve(options.runPromise).then(value => { execution = value }, caught => { error = caught }).finally(() => { settled = true })
  const registrationDeadline = now() + registrationTimeoutMs
  while (!settled && !options.isRegistered() && now() < registrationDeadline) await Promise.race([settledPromise, wait(Math.min(20, registrationDeadline - now()))])
  if (!settled && !options.isRegistered()) {
    timedOut = true
    try { stopResult = await options.forceStop() } catch (caught) { stopFailure = caught }
  } else if (!settled) {
    const outcome = await Promise.race([settledPromise.then(() => 'settled'), wait(executionTimeoutMs).then(() => 'deadline')])
    if (outcome === 'deadline' && !settled) {
      timedOut = true
      try {
        stopResult = await options.stop()
        if (stopResult?.alreadyTerminal && !settled) stopResult = await options.forceStop()
      } catch (caught) { stopFailure = caught }
    }
  }
  let unsettled = false
  if (!settled) {
    const settlement = await Promise.race([settledPromise.then(() => 'settled'), wait(settlementTimeoutMs).then(() => 'deadline')])
    unsettled = settlement === 'deadline' && !settled
  }
  return { execution, error: error || stopFailure, stopResult, timedOut, unsettled }
}

async function runVariant(layout, root, definition) {
  const variantRoot = privateDirectory(path.join(root, definition.name))
  const registryPath = path.join(variantRoot, 'processes.json')
  const adapter = nativeProcessAdapter(registryPath, variantRoot)
  const owner = new ProcessOwner({ adapter, registryPath, pollMs: 20 })
  const runner = new OwnedCodexProxyRunner({
    processOwner: owner, controlRoot: privateDirectory(path.join(variantRoot, 'proxy')),
    targetKey: `vscode-windows-probe-${definition.name}`, activationId: `vscode-probe:${crypto.randomUUID()}`,
    generationId: 1, pollMs: 20,
  })
  const sessionId = crypto.randomUUID(), reservationId = crypto.randomUUID()
  const environment = prepareProcessLaunchEnvironment(adapter, reservationId, definition.environment(variantRoot))
  const startedAt = Date.now()
  const runPromise = runner.run({ executable: definition.executable(layout), argv: definition.argv(layout),
    cwd: path.dirname(layout.code), env: environment, stdin: '', shell: false, sessionId, reservationId })
  const supervised = await superviseOwnedRun({
    runPromise, isRegistered: () => runner.sessions.has(sessionId),
    registrationTimeoutMs: (Number.isSafeInteger(adapter.startupTimeoutMs) ? adapter.startupTimeoutMs : 120_000) + REGISTRATION_GRACE,
    executionTimeoutMs: TIMEOUT, settlementTimeoutMs: SETTLEMENT_GRACE,
    stop: () => runner.stop({ sessionId, reason: 'VS Code Windows diagnostic deadline', terminalStatus: 'CANCELLED' }),
    forceStop: async () => {
      await owner.cancelAll({ reason: 'VS Code Windows diagnostic registration deadline', graceMs: 0, killMs: 2000, waitForPending: true })
      await owner.assertDrained({ skipRecovery: true, skipRunningDrain: true })
      return { drained: true, forced: true }
    },
  })
  let { execution, error, stopResult, timedOut, unsettled } = supervised
  if (unsettled && !error) error = Object.assign(new Error('VS Code diagnostic run did not settle after its bounded ownership stop'), { code: 'DIAGNOSTIC_SETTLEMENT_UNKNOWN' })
  let drained = !unsettled && (execution?.drained === true || stopResult?.drained === true)
  if (!drained && !unsettled) {
    try {
      await owner.cancelAll({ reason: 'VS Code Windows diagnostic failure cleanup', graceMs: 0, killMs: 2000, waitForPending: true })
      await owner.assertDrained({ skipRecovery: true, skipRunningDrain: true })
      drained = true
    } catch (caught) { error ||= caught }
  }
  const result = recordVariant({ name: definition.name, mode: definition.mode, executable: definition.executable(layout),
    argv: definition.argv(layout), timedOut, execution, error, drained, retainedRoot: !drained, elapsedMs: Date.now() - startedAt })
  if (drained) fs.rmSync(variantRoot, { recursive: true, force: true })
  return { result, drained }
}

async function runDiagnostic(executable, options = {}) {
  const layout = resolveLayout(executable)
  const root = privateDirectory(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-probe-'))))
  const inherited = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  const isolated = variantRoot => ({ ...native.isolatedEnvironment(variantRoot, nativeEnvironment()), ELECTRON_RUN_AS_NODE: '1' })
  const privateKnownFolders = variantRoot => ({ ...isolated(variantRoot), APPDATA: privateDirectory(path.join(variantRoot, 'appdata')), LOCALAPPDATA: privateDirectory(path.join(variantRoot, 'localappdata')) })
  const definitions = [
    { name: 'code-node-e-inherited', mode: 'inherited', executable: value => value.code, argv: () => ['-e', 'process.stdout.write("NODE_OK")'], environment: inherited },
    { name: 'code-node-e-isolated', mode: 'isolated', executable: value => value.code, argv: () => ['-e', 'process.stdout.write("NODE_OK")'], environment: isolated },
    { name: 'cli-version-inherited', mode: 'inherited', executable: value => value.code, argv: value => [value.cli, '--version'], environment: inherited },
    { name: 'cli-version-isolated', mode: 'isolated', executable: value => value.code, argv: value => [value.cli, '--version'], environment: isolated },
    { name: 'cli-version-isolated-private-known-folders', mode: 'isolated-private-known-folders', executable: value => value.code, argv: value => [value.cli, '--version'], environment: privateKnownFolders },
  ]
  const selected = process.env.AUTOPROMPT_VSCODE_EXTENDED_DIAGNOSTIC === '1'
    ? definitions
    : definitions.filter(definition => ['code-node-e-inherited', 'cli-version-isolated'].includes(definition.name))
  const variants = [], retainedRoots = []
  for (const definition of selected) {
    const startedAt = Date.now()
    options.onEvent?.({ schemaVersion: 1, event: 'variant-start', name: definition.name, mode: definition.mode })
    let outcome
    try { outcome = await runVariant(layout, root, definition) } catch (error) {
      outcome = { drained: false, result: recordVariant({ name: definition.name, mode: definition.mode,
        executable: definition.executable(layout), argv: definition.argv(layout), timedOut: false, execution: null,
        error, drained: false, retainedRoot: true, elapsedMs: Date.now() - startedAt }) }
    }
    variants.push(outcome.result)
    options.onVariant?.(outcome.result)
    if (!outcome.drained) retainedRoots.push(path.join(root, definition.name))
  }
  if (retainedRoots.length === 0) fs.rmSync(root, { recursive: true, force: true })
  return { schemaVersion: 1, platform: process.platform, architecture: process.arch, node: process.version,
    executable: layout.code, cli: layout.cli, extended: selected.length === definitions.length, variants, retainedRoots: retainedRoots.length }
}

function nativeEnvironment() {
  const result = { PATH: process.env.PATH }
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    const key = Object.keys(process.env).find(candidate => candidate.toLowerCase() === name.toLowerCase())
    if (key) result[name] = process.env[key]
  }
  return result
}

if (require.main === module) {
  runDiagnostic(undefined, {
    onEvent: event => process.stdout.write(`${JSON.stringify(event)}\n`),
    onVariant: variant => process.stdout.write(`${JSON.stringify({ schemaVersion: 1, event: 'variant', variant })}\n`),
  }).then(value => process.stdout.write(`${JSON.stringify(value)}\n`), error => {
    process.stderr.write(`${bounded(error.stack || error)}\n`)
    process.exitCode = 1
  })
}

module.exports = { resolveLayout, runDiagnostic, runVariant, superviseOwnedRun }
