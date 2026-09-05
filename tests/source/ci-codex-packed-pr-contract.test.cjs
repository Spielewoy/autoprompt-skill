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
  assert.doesNotMatch(install, /^        if:/mu, 'every supported Node job needs the native dependency before npm test')
  assert.match(install, /npm install --global --prefix "\$\{\{ runner\.temp \}\}\/autoprompt-codex-cli" --install-strategy=nested/u)
  assert.match(install, /node tests\/helpers\/export-pinned-codex-ci\.cjs/u)
  assert.ok(steps.findIndex(step => /^        run: npm test$/mu.test(step)) > installIndex)
  for (const command of ['npm run test:codex-core', 'npm run test:codex-lifecycle']) {
    const index = steps.findIndex(step => step.includes(`        run: ${command}\n`))
    assert.ok(index > installIndex, `${command} runs after installing the pinned CLI`)
    assert.match(steps[index], /^        if: matrix\.node == '24'$/mu)
  }
  assert.equal(literalOccurrences(job, 'run: npm run test:codex-core'), 1)
  assert.equal(literalOccurrences(job, 'run: npm run test:codex-lifecycle'), 1)
})

test('all CI package jobs declare and validate the native CLI before dependent tests', () => {
  const workflow = read('.github/workflows/ci.yml').replaceAll('\r\n', '\n')
  for (const id of ['node-compatibility', 'windows-provider-contracts', 'pull-request-lifecycle']) {
    const steps = workflowJob(workflow, id).split(/^      - name: /mu).slice(1)
    const installIndex = steps.findIndex(step => step.includes('@openai/codex@0.148.0'))
    const testIndex = steps.findIndex(step => /^        run: npm (?:test|run verify)$/mu.test(step))
    assert.ok(installIndex >= 0 && installIndex < testIndex, `${id}: pin installation precedes tests`)
    assert.doesNotMatch(steps[installIndex], /^        if:/mu)
    assert.match(steps[installIndex], /--global[\s\S]*--install-strategy=nested[\s\S]*--ignore-scripts/u)
    assert.match(steps[installIndex], /tests\/helpers\/export-pinned-codex-ci\.cjs/u)
  }
  const setup = read('tests/helpers/export-pinned-codex-ci.cjs')
  assert.match(setup, /resolveCodexExecutable\('codex', \{ environment: \{ PATH: bin \} \}\)/u)
  assert.match(setup, /pinnedCodexCli\(/u)
  assert.match(setup, /AUTOPROMPT_PINNED_CODEX=/u)
  assert.match(setup, /AUTOPROMPT_REQUIRE_PINNED_CODEX=1/u)
  assert.match(setup, /CODEX_MANAGED_PACKAGE_ROOT=\$\{packageRoot\}/u)
  const configureTest = read('tests/source/codex-configure.test.cjs')
  assert.doesNotMatch(configureTest, /hostCodexHome|os\.homedir\(\)/u)
  assert.doesNotMatch(configureTest, /echo codex-cli|printf.*codex-cli/u)
  assert.match(configureTest, /pinnedCodexPackageFixture\(/u)
  assert.match(configureTest, /reason=codex-windows-sandbox-identity-unavailable/u)
})

test('Linux full-core CI supplies frozen Git history and native namespace prerequisites without root tests', () => {
  const workflow = read('.github/workflows/ci.yml').replaceAll('\r\n', '\n')
  for (const id of ['node-compatibility', 'pull-request-lifecycle']) {
    const job = workflowJob(workflow, id)
    assert.match(job, /^          fetch-depth: 0$/mu, 'historically frozen empirical fixtures require their actual commits')
    assert.match(job, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/u)
    assert.ok(job.indexOf('sudo sysctl') < job.indexOf('run: npm '))
    assert.doesNotMatch(job, /sudo (?:npm|node)\b/u, 'permission-sensitive tests must execute as the runner, not root')
  }
})

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
