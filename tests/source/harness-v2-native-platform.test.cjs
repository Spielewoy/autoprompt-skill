'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { nodeCommand, readCommand, withChallenge } = require('../helpers/native-platform.cjs')
const { WINDOWS_NATIVE_CASES, assertHostPrimitiveCases } = require('../helpers/native-platform-ci.cjs')

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
