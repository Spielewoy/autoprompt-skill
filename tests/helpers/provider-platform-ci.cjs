'use strict'

// One installed provider and one real host per run. A named capability skip,
// missing binary or missing suite is a failure, never platform evidence.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { NATIVE_SUITES, CAPABILITIES, selectedCaseSummary, testSummary, suiteCompleted } = require('../../scripts/harness-v2-conformance.cjs')
const { probeCommandSandbox } = require('../../scripts/harness-v2-tool-boundary.cjs')

function testPlan(provider) {
  const suite = NATIVE_SUITES[provider]
  assert.ok(suite && suite.capabilityCases, `No complete native capability suite for ${provider}`)
  assert.deepEqual(Object.keys(suite.capabilityCases).sort(), [...CAPABILITIES].sort())
  assert.equal(suite.cases.length, 11)
  assert.equal(new Set(suite.cases).size, 11)
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return { cases: suite.cases, argv: ['--test', '--test-concurrency=1', '--test-reporter=tap',
    '--test-name-pattern', `^(?:${suite.cases.map(escape).join('|')})$`, path.resolve(__dirname, '../..', suite.file)] }
}

function verifyResult(plan, result, text) {
  const counts = testSummary(text)
  const cases = selectedCaseSummary(text, plan.cases)
  assert.equal(suiteCompleted({ ok: result.code === 0 && !result.signal }, counts, cases), true,
    `Required native capability evidence is incomplete: ${JSON.stringify({ result, counts, cases })}`)
  return { counts, cases }
}

async function main() {
  const provider = process.argv[2]
  const plan = testPlan(provider)
  if (process.env.AUTOPROMPT_CI_EXPECTED_ARCH) assert.equal(process.arch, process.env.AUTOPROMPT_CI_EXPECTED_ARCH)
  assert.ok(['linux', 'darwin', 'win32'].includes(process.platform))
  assert.ok([20, 24].includes(Number(process.versions.node.split('.')[0])), 'Use a tested Node major')
  const input = process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`]
  assert.ok(input && path.isAbsolute(input), 'An actual installed provider executable is required')
  const executable = fs.realpathSync.native(input)
  assert.ok(fs.statSync(executable).isFile())
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex')
  const executableSha256 = hash()
  const evidence = { schemaVersion: 1, provider, platform: process.platform, architecture: process.arch,
    node: process.version, executable, executableSha256, nativeCapabilitiesPassed: false,
    scope: 'installed-provider-controlled-model-service', commit: process.env.GITHUB_SHA || null }
  const evidenceFile = `native-${provider}-evidence.json`
  const logFile = `native-${provider}-tests.log`
  const publish = () => fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n')
  publish()
  try {
    evidence.sandbox = await probeCommandSandbox()
    assert.equal(evidence.sandbox.supported, true, JSON.stringify(evidence.sandbox))
    const native = provider === 'reasonix' ? require('../../agents/reasonix/workflow/native.js')
      : require('../../scripts/harness-v2-native.cjs')
    const binding = native.probeExecutable({ provider, executable })
    evidence.observedVersion = binding.version
    evidence.nativeRuntimeIdentity = binding.runtimeIdentity
    publish()
    const output = fs.openSync(logFile, 'wx', 0o600)
    let result
    try {
      result = await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, plan.argv, { shell: false, stdio: ['ignore', output, output],
          env: { ...process.env, AUTOPROMPT_REQUIRE_NATIVE_TESTS: '1' } })
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
    } finally { fs.closeSync(output) }
    const text = fs.readFileSync(logFile, 'utf8')
    Object.assign(evidence, verifyResult(plan, result, text))
    assert.equal(hash(), executableSha256, 'The installed executable changed during native testing')
    const after = native.probeExecutable({ provider, executable })
    assert.equal(after.version, binding.version)
    assert.deepEqual(after.runtimeIdentity, binding.runtimeIdentity, 'Provider runtime dependencies changed during testing')
    evidence.nativeCapabilitiesPassed = true
  } catch (error) {
    evidence.error = String(error.stack || error).slice(0, 8192)
    throw error
  } finally { publish() }
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
module.exports = { testPlan, verifyResult }
