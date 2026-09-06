#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  CODEX_SOURCE_TEST_OWNERS,
  CODEX_SOURCE_TESTS_WIRED_ELSEWHERE,
  codexSourceTestInventory,
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

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-discovery-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('non-Codex release wiring invokes recursive Codex source-test discovery', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(packageJson.scripts['test:cli'], /tests\/source\/test-codex-source-discovery\.test\.cjs/u)
  assert.equal(packageJson.scripts['test:codex-core'], 'node scripts/run-codex-source-tests.cjs')
  assert.equal(literalOccurrences(packageJson.scripts.test, 'npm run test:cli'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.test, 'npm run test:providers'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.test, 'npm run test:benchmark'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.verify, 'npm test'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.verify, 'npm run test:codex-core'), 1)
  assert.equal(literalOccurrences(packageJson.scripts.verify, 'npm run test:lifecycle'), 1)

  const inventory = codexSourceTestInventory()
  assert.ok(inventory.tests.includes('tests/source/codex-checker-policy-regression.test.cjs'))
  assert.equal(inventory.tests.some(item => CODEX_SOURCE_TESTS_WIRED_ELSEWHERE.includes(item)), false)
  const allCodexTests = discoverCodexSourceTests({ excludedTests: [] })
  assert.ok(allCodexTests.length > CODEX_SOURCE_TESTS_WIRED_ELSEWHERE.length)
  assert.deepEqual(
    allCodexTests,
    [...inventory.tests, ...CODEX_SOURCE_TESTS_WIRED_ELSEWHERE].sort(),
  )
  assert.deepEqual(Object.keys(CODEX_SOURCE_TEST_OWNERS).sort(), CODEX_SOURCE_TESTS_WIRED_ELSEWHERE)
  const coverage = new Map(allCodexTests.map(sourceTest => [sourceTest, 0]))
  for (const sourceTest of inventory.tests) coverage.set(sourceTest, coverage.get(sourceTest) + 1)
  for (const [sourceTest, owner] of Object.entries(CODEX_SOURCE_TEST_OWNERS)) {
    assert.ok(VERIFY_REACHABLE_TEST_SCRIPTS.includes(owner), `${sourceTest} has a verify-reachable owner`)
    assert.equal(literalOccurrences(packageJson.scripts[owner], sourceTest), 1,
      `${sourceTest} is wired exactly once by ${owner}`)
    for (const otherOwner of VERIFY_REACHABLE_TEST_SCRIPTS.filter(candidate => candidate !== owner)) {
      assert.equal(literalOccurrences(packageJson.scripts[otherOwner], sourceTest), 0,
        `${sourceTest} is not duplicated by ${otherOwner}`)
    }
    coverage.set(sourceTest, coverage.get(sourceTest) + 1)
  }
  assert.deepEqual([...coverage.entries()].filter(([, count]) => count !== 1), [])
  assert.deepEqual(inventory.tests, [...inventory.tests].sort())
  assert.equal(new Set(inventory.tests).size, inventory.tests.length)
  assert.equal(
    inventory.digest,
    crypto.createHash('sha256').update(`${inventory.tests.join('\n')}\n`, 'utf8').digest('hex'),
  )
})

test('Codex discovery is recursive and rejects empty or nonregular inventories', t => {
  const sourceTestRoot = temporaryDirectory(t)
  assert.throws(
    () => discoverCodexSourceTests({ sourceTestRoot, relativeRoot: sourceTestRoot, excludedTests: [] }),
    error => error.code === 'CODEX_TEST_INVENTORY_EMPTY',
  )

  fs.mkdirSync(path.join(sourceTestRoot, 'nested', 'deeper'), { recursive: true })
  fs.writeFileSync(path.join(sourceTestRoot, 'codex-z.test.cjs'), '')
  fs.writeFileSync(path.join(sourceTestRoot, 'nested', 'deeper', 'codex-a.test.cjs'), '')
  fs.writeFileSync(path.join(sourceTestRoot, 'nested', 'ignored.test.cjs'), '')
  assert.deepEqual(
    discoverCodexSourceTests({ sourceTestRoot, relativeRoot: sourceTestRoot, excludedTests: [] }),
    ['codex-z.test.cjs', 'nested/deeper/codex-a.test.cjs'],
  )

  fs.mkdirSync(path.join(sourceTestRoot, 'nested', 'codex-not-a-file.test.cjs'))
  assert.throws(
    () => discoverCodexSourceTests({ sourceTestRoot, relativeRoot: sourceTestRoot, excludedTests: [] }),
    error => error.code === 'CODEX_TEST_NONREGULAR',
  )
})

test('Codex discovery rejects symlink and duplicate physical test aliases', t => {
  const sourceTestRoot = temporaryDirectory(t)
  const original = path.join(sourceTestRoot, 'codex-original.test.cjs')
  fs.writeFileSync(original, '')
  const duplicate = path.join(sourceTestRoot, 'codex-duplicate.test.cjs')
  try {
    fs.linkSync(original, duplicate)
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`hard links are unavailable: ${error.code}`)
      return
    }
    throw error
  }
  assert.throws(
    () => discoverCodexSourceTests({ sourceTestRoot, relativeRoot: sourceTestRoot, excludedTests: [] }),
    error => error.code === 'CODEX_TEST_DUPLICATE',
  )

  fs.unlinkSync(duplicate)
  const symlink = path.join(sourceTestRoot, 'codex-symlink.test.cjs')
  try {
    fs.symlinkSync(original, symlink)
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symlinks are unavailable: ${error.code}`)
      return
    }
    throw error
  }
  assert.throws(
    () => discoverCodexSourceTests({ sourceTestRoot, relativeRoot: sourceTestRoot }),
    error => error.code === 'CODEX_TEST_SYMLINK_FORBIDDEN',
  )
})
