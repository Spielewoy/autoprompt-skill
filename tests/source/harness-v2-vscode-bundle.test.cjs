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
  fs.writeFileSync(path.join(macos, 'Code'), 'code')
  fs.chmodSync(path.join(macos, 'Code'), 0o755)
  fs.mkdirSync(path.join(frameworks, 'A'))
  fs.mkdirSync(path.join(frameworks, 'B'))
  fs.writeFileSync(path.join(frameworks, 'A', 'framework'), 'A')
  fs.writeFileSync(path.join(frameworks, 'B', 'framework'), 'B')
  fs.symlinkSync('A', path.join(frameworks, 'Current'))
  return { root, app, code: path.join(macos, 'Code'), shim: path.join(bin, 'code'), current: path.join(frameworks, 'Current') }
}

test('VS Code Linux bundle lookup preserves the existing bin/code binding', t => {
  const f = appFixture(t)
  const binding = native.locateExecutable({ provider: 'vscode', executable: f.shim, platform: 'linux' })
  assert.equal(binding.path, fs.realpathSync.native(f.shim))
})

test('VS Code macOS bundle lookup binds the released Code executable', t => {
  const f = appFixture(t)
  const binding = native.locateExecutable({ provider: 'vscode', executable: f.shim, platform: 'darwin' })
  assert.equal(binding.path, fs.realpathSync.native(f.code))
})

test('VS Code framework link targets are bound and retargeting changes both identities', t => {
  const f = appFixture(t)
  const runtimeBefore = native.runtimeDependencyIdentity(f.code)
  const portableBefore = native.portableRuntimeDependencyIdentity('vscode', f.code)
  fs.unlinkSync(f.current)
  fs.symlinkSync('B', f.current)
  const runtimeAfter = native.runtimeDependencyIdentity(f.code)
  const portableAfter = native.portableRuntimeDependencyIdentity('vscode', f.code)
  assert.notEqual(runtimeAfter.sha256, runtimeBefore.sha256)
  assert.notEqual(portableAfter.sha256, portableBefore.sha256)
})

test('VS Code bundle identities reject external links and directory-link cycles', t => {
  const escape = appFixture(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.unlinkSync(escape.current)
  fs.symlinkSync(outside, escape.current)
  assert.throws(() => native.runtimeDependencyIdentity(escape.code), /escapes its application root/)
  assert.throws(() => native.portableRuntimeDependencyIdentity('vscode', escape.code), /escapes its application root/)

  const cycle = appFixture(t)
  fs.symlinkSync(cycle.app, path.join(cycle.app, 'Contents', 'Cycle'))
  assert.throws(() => native.runtimeDependencyIdentity(cycle.code), /directory-link cycle/)
  assert.throws(() => native.portableRuntimeDependencyIdentity('vscode', cycle.code), /directory-link cycle/)
})


function windowsArchiveFixture(t, { hashChildren = ['a44adf7f53e00964ab890f9f8758a334f1fc15bc'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-windows-layout-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const code = path.join(root, 'Code.exe')
  fs.writeFileSync(code, 'code')
  for (const name of hashChildren) {
    const cli = path.join(root, name, 'resources', 'app', 'out', 'cli.js')
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(cli, 'cli')
  }
  return { root, code, cli: path.join(root, hashChildren[0], 'resources', 'app', 'out', 'cli.js') }
}

test('VS Code CLI resolver binds the exact physical release-hash child from the official Windows archive layout', t => {
  const f = windowsArchiveFixture(t)
  assert.equal(native.vscodeCliPath(f.code), f.cli)
  const before = native.runtimeDependencyIdentity(f.code)
  fs.appendFileSync(f.cli, 'drift')
  assert.notEqual(native.runtimeDependencyIdentity(f.code).sha256, before.sha256,
    'the release-hash CLI must be covered by the Code executable runtime binding')
})

test('VS Code probe invokes the release-hash CLI through the bound Code executable', t => {
  const f = windowsArchiveFixture(t)
  fs.chmodSync(f.code, 0o755)
  const observed = []
  const probe = native.probeExecutable({ provider: 'vscode', executable: f.code, spawnSync(executable, argv) {
    observed.push({ executable, argv })
    return { status: 0, signal: null,
      stdout: argv.includes('--version') ? '1.136.1\n' : '--list-extensions --extensions-dir --user-data-dir\n', stderr: '' }
  } })
  assert.equal(probe.version, '1.136.1')
  assert.equal(observed.length, 2)
  assert.ok(observed.every(call => call.executable === f.code && call.argv[0] === f.cli))
})

test('VS Code CLI resolver rejects ambiguous or linked release-hash children', t => {
  const ambiguous = windowsArchiveFixture(t, { hashChildren: ['a44adf7f53e00964ab890f9f8758a334f1fc15bc', 'b55adf7f53e00964ab890f9f8758a334f1fc15bc'] })
  assert.equal(native.vscodeCliPath(ambiguous.code), null)

  const linked = windowsArchiveFixture(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-vscode-cli-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const externalCli = path.join(outside, 'cli.js')
  fs.writeFileSync(externalCli, 'external')
  fs.rmSync(linked.cli)
  fs.symlinkSync(externalCli, linked.cli)
  assert.equal(native.vscodeCliPath(linked.code), null)
})
