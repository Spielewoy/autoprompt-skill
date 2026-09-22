'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { nodeCommand, readCommand, withChallenge, waitForNativeObservation } = require('../helpers/native-platform.cjs')
const { WINDOWS_NATIVE_CASES, DIAGNOSTIC_STAGES, assertHostPrimitiveCases, runDiagnosticStages } = require('../helpers/native-platform-ci.cjs')

test('Claude diagnostic plan failfasts infrastructure and direct checks before packed activation', () => {
  assert.deepEqual(DIAGNOSTIC_STAGES.map(stage => stage.id), ['command-cwd', 'infra', 'direct', 'packed'])
  assert.equal(DIAGNOSTIC_STAGES[0].cases.length, 1)
  assert.equal(DIAGNOSTIC_STAGES[1].cases.length, 2)
  assert.equal(DIAGNOSTIC_STAGES[2].cases.length, 1)
  assert.equal(DIAGNOSTIC_STAGES[3].cases.length, 1)
  assert.deepEqual(DIAGNOSTIC_STAGES.flatMap(stage => stage.cases), [
    'native Windows Bash bridges a deep canonical cwd for the admitted command child',
    'native Windows owned proxy preserves deep semantic cwd through the nested child launch',
    'native Windows owned proxy projects canonical Claude temp through a forced short cwd bridge',
    'claude closed native capability: full canonical role schema is accepted and validated',
    'packed actual Claude activation requires all local native observations before mission admission',
  ])
  assert.match(DIAGNOSTIC_STAGES[2].cases[0], /^claude closed native capability:/)
  assert.match(DIAGNOSTIC_STAGES[3].cases[0], /^packed actual Claude activation/)
})

test('native observation wait preserves early failures and rejects premature success', async () => {
  const original = new Error('original native launch failure')
  const rejected = Promise.reject(original)
  await assert.rejects(waitForNativeObservation(rejected, () => false, 100, 'fixture observation'), error => error === original)
  await assert.rejects(waitForNativeObservation(Promise.resolve('done'), () => false, 100, 'fixture observation'), /settled before readiness/)
})

test('native observation wait reaches a condition and leaves no polling requirement', async () => {
  let ready = false, complete
  const pending = new Promise(resolve => { complete = resolve })
  const flip = setTimeout(() => { ready = true }, 20)
  try { assert.equal(await waitForNativeObservation(pending, () => ready, 500, 'fixture observation'), true) }
  finally { clearTimeout(flip); complete() }
})

test('native observation wait bounds stalled execution and propagates predicate failures', { timeout: 1000 }, async () => {
  const pending = new Promise(() => {})
  await assert.rejects(waitForNativeObservation(pending, () => false, 30, 'stalled fixture'), /Timed out waiting for stalled fixture/)
  const original = new Error('predicate failed')
  await assert.rejects(waitForNativeObservation(pending, () => { throw original }, 100, 'predicate fixture'), error => error === original)
})

test('Claude diagnostic runner stops before packed activation and publishes skipped-stage evidence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-diagnostic-'))
  const aggregate = path.join(directory, 'aggregate.log')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = [], snapshots = [], evidence = {}
  const run = async (argv, _environment, stageLog, aggregateLog) => {
    const id = argv.includes('tests/source/harness-v2-claude-capability-native.test.cjs') ? 'direct' : argv.includes('tests/source/harness-v2-installed-canary-native.test.cjs') ? 'packed' : argv.includes('tests/source/windows-bash-runtime.test.cjs') ? 'command-cwd' : 'infra'
    calls.push(id)
    const stage = DIAGNOSTIC_STAGES.find(item => item.id === id)
    const output = id === 'direct'
      ? `ok 1 - ${stage.cases[0]} # SKIP fixture unavailable\n`
      : stage.cases.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')
    fs.writeFileSync(stageLog, output); fs.appendFileSync(aggregateLog, output)
    return { code: 0, output }
  }
  await assert.rejects(runDiagnosticStages({ environment: {}, evidence, aggregateLog: aggregate, stageLogPrefix: path.join(directory, 'stage-'), publish: () => snapshots.push(JSON.parse(JSON.stringify(evidence))), run }), /Required test must execute|Expected exactly one result/)
  assert.deepEqual(calls, ['command-cwd', 'infra', 'direct'])
  assert.equal(evidence.diagnosticStages.length, 3)
  assert.equal(evidence.diagnosticStages[2].passed, false)
  assert.equal(evidence.diagnosticStages[2].exitCode, 1)
  assert.ok(evidence.diagnosticStages[2].error)
  assert.ok(snapshots.length >= 4, 'initial, command, infra, and failed-stage evidence must be published')
  assert.match(fs.readFileSync(aggregate, 'utf8'), /native Windows owned proxy preserves deep semantic cwd through the nested child launch/)
})

test('Claude diagnostic runner preserves spawn errors and never advances to later stages', async t => {
  const aggregate = path.join(os.tmpdir(), `native-diagnostic-spawn-${process.pid}-${Date.now()}.log`)
  t.after(() => { try { fs.rmSync(aggregate, { force: true }) } catch {} })
  const calls = [], evidence = {}, snapshots = []
  await assert.rejects(runDiagnosticStages({ environment: {}, evidence, aggregateLog: aggregate,
    publish: () => snapshots.push(JSON.parse(JSON.stringify(evidence))), run: async (_argv, _env, stageLog) => {
      calls.push(stageLog)
      throw new Error('fixture spawn failed')
    } }), /fixture spawn failed/)
  assert.equal(calls.length, 1)
  assert.equal(evidence.diagnosticStages[0].id, 'command-cwd')
  assert.equal(evidence.diagnosticStages[0].passed, false)
  assert.match(evidence.diagnosticStages[0].error, /fixture spawn failed/)
  assert.ok(snapshots.length >= 2)
})

test('packed-only diagnostic executes and records only its required native case', async () => {
  const evidence = {}, calls = []
  const name = DIAGNOSTIC_STAGES.find(stage => stage.id === 'packed').cases[0]
  await runDiagnosticStages({ environment: {}, evidence, publish() {}, packedOnly: true,
    run: async argv => { calls.push(argv); return { code: 0, output: `ok 1 - ${name}\n` } } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].at(-1), 'tests/source/harness-v2-installed-canary-native.test.cjs')
  assert.deepEqual(evidence.selectedCases, [name])
  assert.deepEqual(evidence.diagnosticStages.map(stage => stage.id), ['packed'])
  assert.equal(evidence.diagnosticOnly, true)
  assert.equal(evidence.nativeCapabilitiesPassed, undefined)
  await assert.rejects(runDiagnosticStages({ environment: {}, evidence: {}, publish() {}, packedOnly: true,
    run: async () => ({ code: 0, output: `ok 1 - ${name} # SKIP missing CLI\n` }) }), /Required test must execute/)
})

test('Windows native CI guard requires each exact native case and excludes parser lookalikes', () => {
  const transcript = names => names.map((name, index) => `ok ${index + 1} - ${name}`).join('\n')
  const complete = transcript(WINDOWS_NATIVE_CASES)
  assert.equal(assertHostPrimitiveCases(complete, 'win32'), WINDOWS_NATIVE_CASES.length)
  const parsers = ['Windows owned cleanup parser closes identity and removal framing',
    'Windows transaction results bind exclusive bytes, readonly projection, and closed operation identity',
    'Windows transaction protocol distinguishes missing tree, required directory, collisions, and cross-device refusal']
  assert.throws(() => assertHostPrimitiveCases(transcript(Array(20).fill(parsers).flat()), 'win32'), /Expected exactly one result/)
  for (const name of WINDOWS_NATIVE_CASES) {
    assert.throws(() => assertHostPrimitiveCases(transcript(WINDOWS_NATIVE_CASES.filter(item => item !== name)), 'win32'), /Expected exactly one result/)
    assert.throws(() => assertHostPrimitiveCases(`${complete}\nok 999 - ${name}`, 'win32'), /Expected exactly one result/)
    for (const directive of ['SKIP native prerequisite absent', 'TODO native case pending']) {
      assert.throws(() => assertHostPrimitiveCases(complete.replace(`- ${name}`, `- ${name} # ${directive}`), 'win32'), /Required test must execute/)
    }
    assert.throws(() => assertHostPrimitiveCases(complete.replace(`- ${name}`, `- parser-only replacement for ${name}`), 'win32'), /Expected exactly one result/)
    assert.throws(() => assertHostPrimitiveCases(complete.replace(new RegExp(`ok (\\d+) - ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'not ok $1 - ' + name), 'win32'), /Required test failed/)
  }
})

function run(command) {
  const bash = process.platform === 'win32'
    ? require('../../agents/codex/workflow/windows-appcontainer-command.js').resolveWindowsBash().bash.path
    : '/bin/bash'
  return cp.spawnSync(bash, ['--noprofile', '--norc', '-c', command], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` } })
}

test('native capability command reads exact fixture bytes through the real platform shell', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native command ' $ ; é "))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'candidate.txt'), contents = 'exact native fixture\n'
  fs.writeFileSync(file, contents)
  const result = run(withChallenge(readCommand(file), 'fixture-challenge'))
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${contents}\nCLOSED_CANARY_CHALLENGE:fixture-challenge\n`)
})

test('failed native isolation assertion cannot emit a successful closed-canary challenge', () => {
  const result = run(withChallenge(nodeCommand("throw Error('deliberate isolation assertion failure')"), 'must-not-pass'))
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /deliberate isolation assertion failure/)
  assert.equal(result.stdout.includes('CLOSED_CANARY_CHALLENGE'), false)
})

test('required native certification refuses a missing CLI instead of skipping', () => {
  const environment = { ...process.env, AUTOPROMPT_REQUIRE_NATIVE_TESTS: '1' }
  delete environment.AUTOPROMPT_CLAUDE_TEST_CLI
  delete environment.NODE_TEST_CONTEXT
  const result = cp.spawnSync(process.execPath, ['--test', 'tests/source/harness-v2-claude-capability-native.test.cjs'], {
    cwd: path.resolve(__dirname, '../..'), env: environment, encoding: 'utf8', timeout: 10000,
  })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /native certification cannot skip/)
})
