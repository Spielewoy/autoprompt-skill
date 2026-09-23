'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')

function appFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-bundle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = path.join(root, 'Visual Studio Code.app')
  const contents = path.join(app, 'Contents')
  const resources = path.join(contents, 'Resources')
  const bin = path.join(resources, 'app', 'bin')
  const macos = path.join(contents, 'MacOS')
  const frameworks = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(macos, { recursive: true })
  fs.mkdirSync(frameworks, { recursive: true })
  fs.writeFileSync(path.join(resources, 'app', 'product.json'), '{}')
  fs.writeFileSync(path.join(resources, 'app', 'package.json'), '{}')
  fs.writeFileSync(path.join(bin, 'code'), '#!/bin/sh\n')
  fs.chmodSync(path.join(bin, 'code'), 0o755)
  fs.writeFileSync(path.join(macos, 'Electron'), 'electron')
  fs.chmodSync(path.join(macos, 'Electron'), 0o755)
  fs.mkdirSync(path.join(frameworks, 'A'))
  fs.mkdirSync(path.join(frameworks, 'B'))
  fs.writeFileSync(path.join(frameworks, 'A', 'framework'), 'A')
  fs.writeFileSync(path.join(frameworks, 'B', 'framework'), 'B')
  fs.symlinkSync('A', path.join(frameworks, 'Current'))
  return { root, app, electron: path.join(macos, 'Electron'), shim: path.join(bin, 'code'), current: path.join(frameworks, 'Current') }
}

test('VS Code Linux bundle lookup preserves the existing bin/code binding', t => {
  const f = appFixture(t)
  const binding = native.locateExecutable({ provider: 'vscode', executable: f.shim, platform: 'linux' })
  assert.equal(binding.path, fs.realpathSync.native(f.shim))
})

test('VS Code macOS bundle lookup binds the Electron executable', t => {
  const f = appFixture(t)
  const binding = native.locateExecutable({ provider: 'vscode', executable: f.shim, platform: 'darwin' })
  assert.equal(binding.path, fs.realpathSync.native(f.electron))
})

test('VS Code framework link targets are bound and retargeting changes both identities', t => {
  const f = appFixture(t)
  const runtimeBefore = native.runtimeDependencyIdentity(f.electron)
  const portableBefore = native.portableRuntimeDependencyIdentity('vscode', f.electron)
  fs.unlinkSync(f.current)
  fs.symlinkSync('B', f.current)
  const runtimeAfter = native.runtimeDependencyIdentity(f.electron)
  const portableAfter = native.portableRuntimeDependencyIdentity('vscode', f.electron)
  assert.notEqual(runtimeAfter.sha256, runtimeBefore.sha256)
  assert.notEqual(portableAfter.sha256, portableBefore.sha256)
})

test('VS Code bundle identities reject external links and directory-link cycles', t => {
  const escape = appFixture(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.unlinkSync(escape.current)
  fs.symlinkSync(outside, escape.current)
  assert.throws(() => native.runtimeDependencyIdentity(escape.electron), /escapes its application root/)
  assert.throws(() => native.portableRuntimeDependencyIdentity('vscode', escape.electron), /escapes its application root/)

  const cycle = appFixture(t)
  fs.symlinkSync(cycle.app, path.join(cycle.app, 'Contents', 'Cycle'))
  assert.throws(() => native.runtimeDependencyIdentity(cycle.electron), /directory-link cycle/)
  assert.throws(() => native.portableRuntimeDependencyIdentity('vscode', cycle.electron), /directory-link cycle/)
})
