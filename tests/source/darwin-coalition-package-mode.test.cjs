'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const harnessPackage = require('../../scripts/harness-v2-package.cjs')
const reasonixPackage = require('../../scripts/reasonix-package.cjs')

const HELPERS = [
  'agents/codex/workflow/darwin-coalition-runtime/coalition-helper-x64',
  'agents/codex/workflow/darwin-coalition-runtime/coalition-helper-arm64',
  'agents/codex/workflow/darwin-listener-runtime/listener-supervisor-x64',
  'agents/codex/workflow/darwin-listener-runtime/listener-supervisor-arm64',
]

function assertModes(bundle, expectedHashes) {
  for (const relative of HELPERS) {
    const file = path.join(bundle, relative)
    assert.equal(fs.statSync(file).mode & 0o777, 0o700, relative)
    assert.equal(require('../../agents/reasonix/workflow/native.js').sha256(fs.readFileSync(file)), expectedHashes[relative])
  }
  const ordinary = path.join(bundle, 'scripts/harness-v2-native.cjs')
  assert.equal(fs.statSync(ordinary).mode & 0o777, 0o600)
}

test('POSIX coalition and listener helpers retain bytes while staged as executable files', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coalition-package-mode-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const hashes = Object.fromEntries(HELPERS.map(relative => [relative, require('../../agents/reasonix/workflow/native.js').sha256(fs.readFileSync(path.join(__dirname, '..', '..', relative)))]))
  const harnessRoot = path.join(root, 'harness'), reasonixRoot = path.join(root, 'reasonix')
  const harness = harnessPackage.install('claude', harnessRoot)
  const reasonix = reasonixPackage.install(reasonixRoot)
  assertModes(harness.bundle, hashes)
  assertModes(reasonix.bundle, hashes)
  harnessPackage.uninstall('claude', harnessRoot)
  reasonixPackage.uninstall(reasonixRoot)
})
