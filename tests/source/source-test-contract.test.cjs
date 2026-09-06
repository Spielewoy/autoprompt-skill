#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
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

test('Windows-style checkouts preserve every hash-bound Codex external and install registry byte', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-crlf-contract-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const manifest = JSON.parse(read('agents/manifests/codex-runtime.json'))
  const files = [...new Set([
    ...manifest.externalDependencies.map(entry => entry.source),
    'scripts/install/legacy-codex-role-hashes.json',
    'scripts/install/legacy-codex-compat.json',
    'scripts/install/codex-package-registry.json',
    'scripts/install/codex-discovery-shim.md',
  ])].sort()
  const attrs = childProcess.spawnSync('git', ['check-attr', 'eol', '--', ...files], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(attrs.status, 0, attrs.stderr)
  assert.equal(attrs.stdout.trim().split('\n').length, files.length)
  for (const row of attrs.stdout.trim().split('\n')) assert.match(row, /: eol: lf$/u)
  const checkout = childProcess.spawnSync('git', [
    '-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', 'checkout-index',
    `--prefix=${temporary.split(path.sep).join('/')}/`, '--', ...files,
  ], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(checkout.status, 0, checkout.stderr)
  for (const file of files) {
    const indexed = childProcess.spawnSync('git', ['show', `:${file}`], { cwd: ROOT, encoding: null })
    assert.equal(indexed.status, 0)
    assert.deepEqual(fs.readFileSync(path.join(temporary, file)), indexed.stdout, file)
  }
})

test('benchmark and every Codex source suite are each wired exactly once', () => {
  const packageJson = JSON.parse(read('package.json'))
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
})
