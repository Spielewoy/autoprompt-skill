#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')

const {
  CODEX_SOURCE_TEST_OWNERS,
  CODEX_SOURCE_TESTS_WIRED_ELSEWHERE,
  discoverCodexSourceTests,
} = require('../../scripts/run-codex-source-tests.cjs')

const VERIFY_REACHABLE_TEST_SCRIPTS = Object.freeze([
  'test:cli',
  'test:providers',
  'test:benchmark',
  'test:lifecycle',
])

function literalOccurrences(source, value) {
  return String(source).split(value).length - 1
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

function workflowJob(workflow, id) {
  const startMarker = `  ${id}:\n`
  const start = workflow.indexOf(startMarker)
  assert.notEqual(start, -1, `missing ${id} CI job`)

  const remainder = workflow.slice(start + startMarker.length)
  const nextJob = remainder.search(/^  [a-z0-9_-]+:\s*$/m)
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob)
}

test('AP-TEST-015 pull requests run the full packed Codex lifecycle on Linux and Windows', () => {
  const workflow = read('.github/workflows/ci.yml').replaceAll('\r\n', '\n')
  const job = workflowJob(workflow, 'pull-request-lifecycle')
  const packageJson = JSON.parse(read('package.json'))

  assert.match(job, /^    if: github\.event_name == 'pull_request'$/m)
  assert.match(job, /^    runs-on: \$\{\{ matrix\.os \}\}$/m)
  assert.match(job, /^          - ubuntu-latest$/m)
  assert.match(job, /^          - windows-latest$/m)
  assert.match(job, /^        run: node --test tests\/source\/ci-codex-packed-pr-contract\.test\.cjs$/m)
  assert.match(job, /^        run: npm run verify$/m)

  assert.match(packageJson.scripts.verify, /(?:^|&&\s*)npm run test:lifecycle(?:\s*&&|$)/)
  assert.match(packageJson.scripts['test:lifecycle'], /tests\/source\/packed-codex-lifecycle\.test\.cjs/)
})

test('beta pushes run the Codex source and packed lifecycle suites with a mandatory pinned native CLI', () => {
  const workflow = read('.github/workflows/ci.yml').replaceAll('\r\n', '\n')
  const trigger = workflow.slice(workflow.indexOf('  push:\n'), workflow.indexOf('  pull_request:\n'))
  assert.match(trigger, /^      - main$/mu)
  assert.match(trigger, /^      - beta-test\/codex-v2$/mu)
  const job = workflowJob(workflow, 'node-compatibility')
  assert.match(job, /^    runs-on: ubuntu-latest$/mu)
  assert.doesNotMatch(job, /^    if:/mu)
  assert.match(job, /^    timeout-minutes: \$\{\{ matrix\.node == '24' && 90 \|\| 15 \}\}$/mu)
  const steps = job.split(/^      - name: /mu).slice(1)
  const installIndex = steps.findIndex(step => step.includes('@openai/codex@0.148.0'))
  assert.notEqual(installIndex, -1)
  const install = steps[installIndex]
  assert.match(install, /^        if: matrix\.node == '24'$/mu)
  assert.match(install, /npm install --prefix "\$\{\{ runner\.temp \}\}\/autoprompt-codex-cli"/u)
  assert.match(install, /node_modules\/\.bin" >> "\$GITHUB_PATH"/u)
  for (const command of ['npm run test:codex-core', 'npm run test:codex-lifecycle']) {
    const index = steps.findIndex(step => step.includes(`        run: ${command}\n`))
    assert.ok(index > installIndex, `${command} runs after installing the pinned CLI`)
    assert.match(steps[index], /^        if: matrix\.node == '24'$/mu)
    assert.match(steps[index], /^          AUTOPROMPT_PINNED_CODEX: \$\{\{ runner\.temp \}\}\/autoprompt-codex-cli\/node_modules\/@openai\/codex\/bin\/codex\.js$/mu)
  }
  assert.equal(literalOccurrences(job, 'run: npm run test:codex-core'), 1)
  assert.equal(literalOccurrences(job, 'run: npm run test:codex-lifecycle'), 1)
})

test('benchmark and every Codex source suite are each wired exactly once', () => {
  const packageJson = JSON.parse(read('package.json'))
  const workflow = read('.github/workflows/ci.yml')
  const benchmark = packageJson.scripts['test:benchmark']
  const core = packageJson.scripts['test:codex-core']

  assert.match(benchmark, /tests\/benchmarks\/autoprompt-benchmark\.test\.cjs/)
  assert.doesNotMatch(benchmark, /tests\/benchmarks\/autoprompt-benchmark\.cjs(?:\s|$)/)
  assert.doesNotMatch(benchmark, /test:codex-runtime-evidence|codex-runtime-evidence-gates-r5/)
  assert.equal(core, 'node scripts/run-codex-source-tests.cjs')
  const allCodexTests = discoverCodexSourceTests({ excludedTests: [] })
  assert.deepEqual(
    allCodexTests,
    [...discoverCodexSourceTests(), ...CODEX_SOURCE_TESTS_WIRED_ELSEWHERE].sort(),
  )
  assert.equal(new Set(discoverCodexSourceTests()).size, discoverCodexSourceTests().length)
  assert.deepEqual(Object.keys(CODEX_SOURCE_TEST_OWNERS).sort(), CODEX_SOURCE_TESTS_WIRED_ELSEWHERE)
  for (const [wiredElsewhere, owner] of Object.entries(CODEX_SOURCE_TEST_OWNERS)) {
    assert.ok(VERIFY_REACHABLE_TEST_SCRIPTS.includes(owner), `${wiredElsewhere} has a verify-reachable owner`)
    assert.equal(literalOccurrences(packageJson.scripts[owner], wiredElsewhere), 1,
      `${wiredElsewhere} must be wired exactly once by ${owner}`)
    for (const otherOwner of VERIFY_REACHABLE_TEST_SCRIPTS.filter(candidate => candidate !== owner)) {
      assert.equal(literalOccurrences(packageJson.scripts[otherOwner], wiredElsewhere), 0,
        `${wiredElsewhere} must not also be wired by ${otherOwner}`)
    }
  }
  assert.equal(literalOccurrences(packageJson.scripts.test, 'npm run test:cli'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.test, 'npm run test:providers'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.test, 'npm run test:benchmark'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.verify, 'npm test'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.verify, 'npm run test:codex-core'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.verify, 'npm run test:lifecycle'), 1)
  assert.doesNotMatch(workflow, /run: npm run test:codex-runtime-evidence/)
})
