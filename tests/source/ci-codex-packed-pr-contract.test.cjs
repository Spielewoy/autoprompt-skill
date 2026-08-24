#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')

const CODEX_CORE_SUITES = [
  'tests/source/codex-activation-preflight-v2.test.cjs',
  'tests/source/codex-explicit-activation-v2.test.cjs',
  'tests/source/codex-recovery-checkpoint-v2.test.cjs',
  'tests/source/codex-router-v2.test.cjs',
  'tests/source/codex-run-record-v2.test.cjs',
  'tests/source/codex-runtime-evidence-gates-r5.test.cjs',
  'tests/source/codex-runtime-state-v2.test.cjs',
  'tests/source/codex-scheduler-v2.test.cjs',
  'tests/source/codex-supervisor-integration-v2.test.cjs',
  'tests/source/codex-v2-conformance.test.cjs',
  'tests/source/codex-v2-contracts.test.cjs',
]

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

test('benchmark and deterministic Codex core suites are each wired exactly once', () => {
  const packageJson = JSON.parse(read('package.json'))
  const workflow = read('.github/workflows/ci.yml')
  const benchmark = packageJson.scripts['test:benchmark']
  const core = packageJson.scripts['test:codex-core']

  assert.match(benchmark, /tests\/benchmarks\/autoprompt-benchmark\.test\.cjs/)
  assert.doesNotMatch(benchmark, /tests\/benchmarks\/autoprompt-benchmark\.cjs(?:\s|$)/)
  assert.doesNotMatch(benchmark, /test:codex-runtime-evidence|codex-runtime-evidence-gates-r5/)
  assert.deepEqual(
    [...core.matchAll(/tests\/source\/codex-[\w.-]+\.test\.cjs/g)].map(match => match[0]),
    CODEX_CORE_SUITES,
  )
  assert.equal(core.match(/codex-runtime-evidence-gates-r5\.test\.cjs/g)?.length, 1)
  assert.equal(packageJson.scripts.verify.match(/npm run test:codex-core/g)?.length, 1)
  assert.doesNotMatch(workflow, /run: npm run test:codex-runtime-evidence/)
})
