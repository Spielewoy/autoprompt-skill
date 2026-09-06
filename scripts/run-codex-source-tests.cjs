#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SOURCE_TEST_ROOT = path.join(ROOT, 'tests', 'source')
const CODEX_SOURCE_TEST_OWNERS = Object.freeze({
  'tests/source/codex-artifact.test.cjs': 'test:lifecycle',
  'tests/source/codex-configure.test.cjs': 'test:cli',
  'tests/source/codex-current-parity.test.cjs': 'test:providers',
  'tests/source/codex-receipt-lifecycle.test.cjs': 'test:lifecycle',
  'tests/source/codex-version-probe-isolation.test.cjs': 'test:lifecycle',
})
const CODEX_SOURCE_TESTS_WIRED_ELSEWHERE = Object.freeze(
  Object.keys(CODEX_SOURCE_TEST_OWNERS).sort(),
)

function discoveryError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details })
}

function discoverCodexSourceTests(options = {}) {
  const sourceTestRoot = path.resolve(options.sourceTestRoot || SOURCE_TEST_ROOT)
  const relativeRoot = path.resolve(options.relativeRoot || ROOT)
  const excludedTests = new Set(options.excludedTests === undefined
    ? CODEX_SOURCE_TESTS_WIRED_ELSEWHERE
    : options.excludedTests)
  const discovered = []
  const portablePaths = new Set()
  const physicalFiles = new Set()

  const visit = directory => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        throw discoveryError(
          'CODEX_TEST_SYMLINK_FORBIDDEN',
          `Codex source test discovery does not follow symlinks: ${absolute}`,
          { path: absolute },
        )
      }
      if (stat.isDirectory()) {
        if (/^codex-.*\.test\.cjs$/u.test(entry.name)) {
          throw discoveryError(
            'CODEX_TEST_NONREGULAR',
            `a Codex source test candidate is not a regular file: ${absolute}`,
            { path: absolute },
          )
        }
        visit(absolute)
        continue
      }
      if (!/^codex-.*\.test\.cjs$/u.test(entry.name)) continue
      if (!stat.isFile()) {
        throw discoveryError(
          'CODEX_TEST_NONREGULAR',
          `a Codex source test candidate is not a regular file: ${absolute}`,
          { path: absolute },
        )
      }
      const relative = path.relative(relativeRoot, absolute).split(path.sep).join('/')
      if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
        throw discoveryError(
          'CODEX_TEST_PATH_INVALID',
          `a discovered Codex source test escapes the configured relative root: ${absolute}`,
          { path: absolute, relativeRoot },
        )
      }
      const portableIdentity = relative.toLowerCase()
      const physicalIdentity = `${stat.dev}:${stat.ino}`
      if (portablePaths.has(portableIdentity) || physicalFiles.has(physicalIdentity)) {
        throw discoveryError(
          'CODEX_TEST_DUPLICATE',
          `a Codex source test is duplicated by path or physical identity: ${relative}`,
          { path: relative },
        )
      }
      portablePaths.add(portableIdentity)
      physicalFiles.add(physicalIdentity)
      if (excludedTests.has(relative)) continue
      discovered.push(relative)
    }
  }

  visit(sourceTestRoot)
  discovered.sort()
  if (discovered.length === 0) {
    throw discoveryError(
      'CODEX_TEST_INVENTORY_EMPTY',
      `no Codex source tests were discovered below ${sourceTestRoot}`,
      { sourceTestRoot },
    )
  }
  return discovered
}

function codexSourceTestInventory(options = {}) {
  const tests = discoverCodexSourceTests(options)
  const digest = crypto.createHash('sha256').update(`${tests.join('\n')}\n`, 'utf8').digest('hex')
  return Object.freeze({ tests: Object.freeze(tests), digest })
}

function main() {
  const inventory = codexSourceTestInventory()
  const tests = inventory.tests
  process.stdout.write(`Codex source test inventory: ${tests.length} files sha256=${inventory.digest}\n`)
  const result = childProcess.spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...tests],
    { cwd: ROOT, env: process.env, stdio: 'inherit' },
  )
  if (result.error) throw result.error
  process.exitCode = Number.isInteger(result.status) ? result.status : 1
}

if (require.main === module) main()

module.exports = {
  CODEX_SOURCE_TEST_OWNERS,
  CODEX_SOURCE_TESTS_WIRED_ELSEWHERE,
  codexSourceTestInventory,
  discoverCodexSourceTests,
}
