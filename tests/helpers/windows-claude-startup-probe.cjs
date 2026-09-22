'use strict'

// Diagnostic only: this probe compares Claude startup across physical cwd and
// profile path shapes. Its records are never native capability receipts.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const native = require('../../scripts/harness-v2-native.cjs')
const { modelService } = require('./harness-native-service.cjs')
const { nativeProcessAdapter, nativeEnvironment } = require('./native-platform.cjs')
const { OwnedCodexProxyRunner } = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, createWindowsJobAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { createWindowsCompilerDirectory, ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
const { ownedTest } = require('../../scripts/harness-v2-closed-canary.cjs')

const VARIANTS = Object.freeze([
  Object.freeze({ id: 'deep-home-profile', fieldGroup: Object.freeze(['HOME', 'USERPROFILE']) }),
  Object.freeze({ id: 'deep-temporary-profile', fieldGroup: Object.freeze(['TEMP', 'TMP', 'TMPDIR']) }),
  Object.freeze({ id: 'deep-claude-config', fieldGroup: Object.freeze(['CLAUDE_CONFIG_DIR']) }),
  Object.freeze({ id: 'deep-settings', fieldGroup: Object.freeze(['--settings']) }),
  Object.freeze({ id: 'deep-xdg-git-profile', fieldGroup: Object.freeze(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'GIT_CONFIG_GLOBAL']) }),
  Object.freeze({ id: 'shallow-alias-entire-profile', fieldGroup: Object.freeze(['entire-profile']), aliasProfile: true }),
])

const boundedError = error => ({
  name: String(error?.name || 'Error').slice(0, 64),
  code: String(error?.code || 'STARTUP_PROBE_FAILED').slice(0, 80),
  message: String(error?.message || error || 'startup probe failed').replace(/[\r\n]+/gu, ' ').slice(0, 512),
})

function writeEvidence(outputRoot, body) {
  if (!outputRoot) return
  if (!path.isAbsolute(outputRoot)) throw new Error('AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT must be absolute')
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 })
  const file = path.join(outputRoot, 'native-platform-evidence.json')
  const temporary = path.join(outputRoot, `.startup-probe-${crypto.randomUUID()}.json`)
  fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, file)
}

function retainedVariants(outputRoot) {
  try {
    const file = path.join(outputRoot, 'native-platform-evidence.json')
    if (fs.statSync(file).size > 1024 * 1024) return []
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed.variants) ? parsed.variants.slice(0, 6) : []
  } catch { return [] }
}

function deepDirectory(root, leaf) {
  let directory = root
  while (directory.length < 320) directory = path.join(directory, 'deep-claude-startup-profile')
  directory = path.join(directory, leaf)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  return fs.realpathSync.native(directory)
}

function isDescendant(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function projectVariantProfile(variant, launch, base, profileRoot, platform) {
  const settingsIndex = launch.argv.indexOf('--settings')
  assert.ok(settingsIndex >= 0 && typeof launch.argv[settingsIndex + 1] === 'string')
  let alias = null
  if (variant.aliasProfile) {
    alias = path.join(base, `profile-alias-${crypto.randomUUID()}`)
    fs.symlinkSync(profileRoot, alias, platform === 'win32' ? 'junction' : 'dir')
    const linked = fs.lstatSync(alias)
    assert.equal(linked.isSymbolicLink(), true)
    assert.equal(fs.realpathSync.native(alias).toLowerCase(), fs.realpathSync.native(profileRoot).toLowerCase())
    for (const [key, value] of Object.entries(launch.env)) {
      if (typeof value === 'string' && path.isAbsolute(value) && isDescendant(profileRoot, value)) {
        launch.env[key] = path.join(alias, path.relative(profileRoot, value))
      }
    }
    const settings = launch.argv[settingsIndex + 1]
    assert.equal(isDescendant(profileRoot, settings), true)
    launch.argv[settingsIndex + 1] = path.join(alias, path.relative(profileRoot, settings))
    return { alias, aliasTargetLength: profileRoot.length }
  }
  const deep = deepDirectory(base, `override-${variant.id}`)
  const directory = name => {
    const value = path.join(deep, name)
    fs.mkdirSync(value, { recursive: true, mode: 0o700 })
    return value
  }
  if (variant.id === 'deep-home-profile') {
    launch.env.HOME = directory('home')
    launch.env.USERPROFILE = launch.env.HOME
  } else if (variant.id === 'deep-temporary-profile') {
    launch.env.TEMP = directory('tmp')
    launch.env.TMP = launch.env.TEMP
    launch.env.TMPDIR = launch.env.TEMP
  } else if (variant.id === 'deep-claude-config') {
    launch.env.CLAUDE_CONFIG_DIR = directory('claude')
  } else if (variant.id === 'deep-settings') {
    const settings = path.join(deep, 'settings.json')
    fs.copyFileSync(launch.argv[settingsIndex + 1], settings, fs.constants.COPYFILE_EXCL)
    assert.deepEqual(fs.readFileSync(settings), fs.readFileSync(launch.argv[settingsIndex + 1]))
    launch.argv[settingsIndex + 1] = settings
  } else if (variant.id === 'deep-xdg-git-profile') {
    for (const [key, name] of [['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'],
      ['XDG_STATE_HOME', 'state'], ['XDG_CACHE_HOME', 'cache']]) launch.env[key] = directory(name)
    const gitconfig = path.join(deep, 'gitconfig')
    fs.copyFileSync(launch.env.GIT_CONFIG_GLOBAL, gitconfig, fs.constants.COPYFILE_EXCL)
    assert.deepEqual(fs.readFileSync(gitconfig), fs.readFileSync(launch.env.GIT_CONFIG_GLOBAL))
    launch.env.GIT_CONFIG_GLOBAL = gitconfig
  } else throw new Error(`Unknown startup probe variant: ${variant.id}`)
  return { alias: null, aliasTargetLength: null }
}

function inspectLine(line, observation) {
  if (observation.lineCount >= 64 || observation.stdoutBytes >= 65536) return
  observation.lineCount++
  observation.stdoutBytes += Buffer.byteLength(line) + 1
  if (observation.stdoutBytes > 65536) return
  try {
    const event = JSON.parse(line)
    if (event?.type === 'system' && event.subtype === 'init') observation.cliInit = true
    if (event?.type === 'result') {
      observation.result = {
        subtype: typeof event.subtype === 'string' ? event.subtype.slice(0, 80) : undefined,
        isError: event.is_error === true,
        sessionIdPresent: typeof event.session_id === 'string' && event.session_id.length > 0,
      }
    }
  } catch { observation.nonJsonLines++ }
}

async function runWithStartupDeadline(runner, owner, spec, startupMs = 30000, outerMs = 120000) {
  let launchReady
  const ready = new Promise(resolve => { launchReady = resolve })
  const originalLaunch = owner.launch.bind(owner)
  owner.launch = async launchSpec => {
    try {
      const owned = await originalLaunch(launchSpec)
      launchReady()
      return owned
    } finally { owner.launch = originalLaunch }
  }
  const pending = runner.run(spec).then(value => ({ kind: 'result', value }), error => ({ kind: 'error', error }))
  let outerTimer, startupTimer
  const outerDeadline = new Promise(resolve => { outerTimer = setTimeout(() => resolve({ kind: 'outer-timeout' }), outerMs) })
  const first = await Promise.race([ready.then(() => ({ kind: 'ready' })), pending, outerDeadline])
  clearTimeout(outerTimer)
  if (first.kind === 'result' || first.kind === 'error') return { ...first, startupTimedOut: false, outerTimedOut: false }
  if (first.kind === 'outer-timeout') {
    await owner.cancelAll({ reason: 'Claude startup probe outer launch timeout', graceMs: 0, killMs: 10000, waitForPending: true })
    await pending
    return { kind: 'timeout', startupTimedOut: false, outerTimedOut: true }
  }
  const startupDeadline = new Promise(resolve => { startupTimer = setTimeout(() => resolve({ kind: 'startup-timeout' }), startupMs) })
  const settled = await Promise.race([pending, startupDeadline])
  clearTimeout(startupTimer)
  if (settled.kind !== 'startup-timeout') return { ...settled, startupTimedOut: false, outerTimedOut: false }
  await runner.stop({ sessionId: spec.sessionId, reason: 'Claude startup probe deadline' })
  await pending
  return { kind: 'timeout', startupTimedOut: true, outerTimedOut: false }
}

async function runStartupVariants({ cli, base, outputRoot, variants = VARIANTS, platform = process.platform } = {}) {
  if (!path.isAbsolute(cli || '') || !fs.statSync(cli).isFile()) throw new Error('AUTOPROMPT_CLAUDE_TEST_CLI must name an actual file')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  if (platform === 'win32') ensureWindowsPrivateAcl(base)
  const shortCwd = path.join(base, 'short-cwd')
  const shortProfiles = path.join(base, 'short-profiles')
  fs.mkdirSync(shortCwd, { mode: 0o700 }); fs.mkdirSync(shortProfiles, { mode: 0o700 })
  const registryPath = path.join(base, 'processes.json')
  const owner = new ProcessOwner({ adapter: nativeProcessAdapter(registryPath, base), registryPath, pollMs: 25 })
  const results = []
  let drained = false
  try {
    for (const [index, variant] of variants.entries()) {
      const cwd = shortCwd
      const profileRoot = variant.aliasProfile
        ? deepDirectory(base, `canonical-${variant.id}`)
        : path.join(shortProfiles, variant.id)
      const home = path.join(profileRoot, 'home'), sessionRoot = path.join(profileRoot, 'session')
      const service = await modelService('claude', { name: 'unused-startup-probe', args: {} }, { noTool: true })
      const proxyRoot = path.join(base, `proxy-${index}`)
      fs.mkdirSync(proxyRoot, { mode: 0o700 })
      if (platform === 'win32') ensureWindowsPrivateAcl(proxyRoot)
      const runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot, targetKey: `claude-startup-${index}`, pollMs: 25 })
      const observation = { lineCount: 0, stdoutBytes: 0, nonJsonLines: 0, cliInit: false, result: null }
      const sessionId = crypto.randomUUID(), reservationId = crypto.randomUUID()
      let outcome, profileProjection = { alias: null, aliasTargetLength: null }
      try {
        const launch = native.createLaunch({ provider: 'claude', home, sessionRoot, targetPath: cwd, cwd,
          prompt: 'Return exactly one JSON object.', input: 'Return {"ok":true}.', toolFree: true, readOnly: true,
          connection: { model: 'claude-sonnet-4-6', environment: { ANTHROPIC_BASE_URL: service.url } },
          credentials: { ANTHROPIC_API_KEY: '<local-startup-probe>' }, environment: nativeEnvironment() })
        profileProjection = projectVariantProfile(variant, launch, base, profileRoot, platform)
        const settingsIndex = launch.argv.indexOf('--settings')
        launch.env = prepareProcessLaunchEnvironment(owner.adapter, reservationId, launch.env)
        outcome = await runWithStartupDeadline(runner, owner, { ...launch, executable: cli, sessionId, reservationId,
          onStdoutLine: line => inspectLine(line, observation) })
        const result = {
          id: variant.id, fieldGroup: [...variant.fieldGroup],
          pathLengths: { cwd: cwd.length, cwdReal: fs.realpathSync.native(cwd).length,
            home: launch.env.HOME?.length ?? null, userProfile: launch.env.USERPROFILE?.length ?? null,
            temp: launch.env.TEMP?.length ?? null, tmp: launch.env.TMP?.length ?? null,
            tmpdir: launch.env.TMPDIR?.length ?? null, claudeConfig: launch.env.CLAUDE_CONFIG_DIR?.length ?? null,
            settings: settingsIndex >= 0 ? launch.argv[settingsIndex + 1].length : null,
            xdgConfig: launch.env.XDG_CONFIG_HOME?.length ?? null, xdgData: launch.env.XDG_DATA_HOME?.length ?? null,
            xdgState: launch.env.XDG_STATE_HOME?.length ?? null, xdgCache: launch.env.XDG_CACHE_HOME?.length ?? null,
            gitConfig: launch.env.GIT_CONFIG_GLOBAL?.length ?? null },
          alias: { used: Boolean(profileProjection.alias), length: profileProjection.alias?.length ?? null,
            targetLength: profileProjection.aliasTargetLength, physicalTargetValidated: Boolean(profileProjection.alias) },
          startupTimedOut: outcome.startupTimedOut, outerTimedOut: outcome.outerTimedOut,
          cliInit: observation.cliInit,
          modelRequestCount: service.requests.filter(request => request.path.includes('/messages')).length,
          requestPaths: service.requests.slice(-8).map(request => String(request.path).slice(0, 256)),
          result: observation.result, stdoutBytes: observation.stdoutBytes, nonJsonLines: observation.nonJsonLines,
          execution: outcome.kind === 'result' ? { status: outcome.value.status, signal: outcome.value.signal,
            drained: outcome.value.drained === true, stderrBytes: outcome.value.stderrByteCount,
            stderrTail: String(outcome.value.stderr || '').slice(-1024) } : null,
          error: outcome.kind === 'error' ? boundedError(outcome.error) : null,
          serviceErrors: service.errors.slice(-4).map(value => String(value).slice(0, 512)),
        }
        results.push(result)
        writeEvidence(outputRoot, { schemaVersion: 1, diagnosticOnly: true, nativeCapabilitiesPassed: false,
          platform, architecture: process.arch, nestedJobLevels: platform === 'win32' ? 3 : 1,
          status: 'running', variants: results })
      } finally {
        try { await runner.stop({ sessionId, reason: 'Claude startup variant cleanup' }) } catch {}
        let serviceCloseError = null
        try { await service.close() } catch (error) { serviceCloseError = error }
        await owner.assertTargetDrained(`claude-startup-${index}`)
        if (profileProjection.alias) fs.unlinkSync(profileProjection.alias)
        if (serviceCloseError) throw serviceCloseError
      }
    }
    await owner.assertDrained()
    drained = true
    return results
  } finally {
    if (!drained) {
      await owner.cancelAll({ reason: 'Claude startup probe cleanup', graceMs: 0, killMs: 10000, waitForPending: true })
      await owner.assertDrained()
    }
  }
}

function childEnvironment(cli, outputRoot) {
  const env = { AUTOPROMPT_CLAUDE_TEST_CLI: cli, AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT: outputRoot,
    PATH: process.env.PATH, PROCESSOR_ARCHITECTURE: process.arch === 'arm64' ? 'ARM64' : 'AMD64' }
  for (const wanted of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    const actual = Object.keys(process.env).find(key => key.toLowerCase() === wanted.toLowerCase())
    if (actual) env[wanted] = process.env[actual]
  }
  return env
}

async function nestedLayer(next, cli, outputRoot, timeoutMs) {
  const root = createWindowsCompilerDirectory(`ap-claude-${next.slice(2)}-`)
  const executionRoot = path.join(root, 'execution')
  fs.mkdirSync(executionRoot, { mode: 0o700 }); ensureWindowsPrivateAcl(executionRoot)
  const adapter = createWindowsJobAdapter({ controlRoot: path.join(root, 'control'), providerPrivateOwnershipRoot: root })
  const owner = new ProcessOwner({ adapter, registryPath: path.join(root, 'processes.json'), pollMs: 25 })
  let drained = false
  try {
    const result = await ownedTest(owner, executionRoot, childEnvironment(cli, outputRoot), [__filename, next], timeoutMs,
      undefined, { platform: 'win32', providerPrivateOwnershipRoot: root, trustedOwnershipRoots: [root] })
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.equal(result.signal, null)
    assert.equal(result.error, null)
    await owner.assertDrained()
    drained = true
    return JSON.parse(result.stdout)
  } finally {
    if (!drained) {
      await owner.cancelAll({ reason: 'Claude startup nested layer cleanup', graceMs: 0, killMs: 10000, waitForPending: true })
      await owner.assertDrained()
      drained = true
    }
    if (drained) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function defaultClaudeCli() {
  const packageName = `claude-code-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const packageRoot = path.join(REPO, '.native-claude', 'node_modules', '@anthropic-ai', packageName)
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== `@anthropic-ai/${packageName}` || manifest.version !== '2.1.270') {
    throw new Error('Windows Claude startup probe requires the exact installed Claude 2.1.270 package')
  }
  return path.join(packageRoot, 'claude.exe')
}

function verifyClaudeCli(cli) {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  assert.ok(['x64', 'arm64'].includes(process.arch), `unsupported Windows probe architecture: ${process.arch}`)
  const packageName = `@anthropic-ai/claude-code-win32-${architecture}`
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), 'package.json'), 'utf8'))
  assert.equal(manifest.name, packageName)
  assert.equal(manifest.version, '2.1.270')
  assert.equal(path.basename(cli).toLowerCase(), 'claude.exe')
  const version = cp.execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 30000,
    windowsHide: true, maxBuffer: 4096 }).trim()
  assert.equal(version, '2.1.270 (Claude Code)')
  return { package: packageName, version }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows Claude startup probe requires Windows')
  const cli = process.env.AUTOPROMPT_CLAUDE_TEST_CLI || defaultClaudeCli()
  const outputRoot = process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT || process.cwd()
  if (!path.isAbsolute(outputRoot || '')) throw new Error('AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT must be absolute')
  if (process.argv[2] === '--inner') {
    const base = createWindowsCompilerDirectory('ap-claude-variants-')
    const variants = await runStartupVariants({ cli, base, outputRoot })
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    process.stdout.write(`${JSON.stringify({ variants })}\n`)
    return
  }
  if (process.argv[2] === '--middle') {
    process.stdout.write(`${JSON.stringify(await nestedLayer('--inner', cli, outputRoot, 600000))}\n`)
    return
  }
  const vendor = verifyClaudeCli(cli)
  writeEvidence(outputRoot, { schemaVersion: 1, diagnosticOnly: true, nativeCapabilitiesPassed: false,
    platform: process.platform, architecture: process.arch, vendor, nestedJobLevels: 3, status: 'starting', variants: [] })
  const result = await nestedLayer('--middle', cli, outputRoot, 720000)
  const evidence = { schemaVersion: 1, diagnosticOnly: true, nativeCapabilitiesPassed: false,
    platform: process.platform, architecture: process.arch, vendor, nestedJobLevels: 3, status: 'complete', variants: result.variants }
  writeEvidence(outputRoot, evidence)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
}

if (require.main === module) main().catch(error => {
  const outputRoot = process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT || process.cwd()
  try { writeEvidence(outputRoot, { schemaVersion: 1, diagnosticOnly: true,
    nativeCapabilitiesPassed: false, platform: process.platform, architecture: process.arch,
    nestedJobLevels: 3, status: 'infrastructure-failure', error: boundedError(error),
    variants: retainedVariants(outputRoot) }) } catch {}
  console.error(error)
  process.exitCode = 1
})

module.exports = { VARIANTS, runStartupVariants }
