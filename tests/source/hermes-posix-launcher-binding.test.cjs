'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { parseHermesPosixLauncher, bindHermesPosixLauncher, canonicalHermesPosixIdentity } = require('../../scripts/harness-v2-bridge/hermes/posix-launcher.cjs')

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
function officialWrapper(root) {
  return `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${root}/venv/bin/python" "${root}/hermes" "$@"\n`
}
function fixture(t, { aliasRoot = false, externalInterpreter = false } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-posix-launcher-')))
  const physicalRoot = path.join(base, 'home', 'hermes-agent'), launcherDir = path.join(base, 'home', '.local', 'bin')
  fs.mkdirSync(path.dirname(physicalRoot), { recursive: true })
  if (aliasRoot) fs.symlinkSync(path.dirname(physicalRoot), path.join(base, 'alias-home'))
  const root = aliasRoot ? path.join(base, 'alias-home', 'hermes-agent') : physicalRoot
  const runtimeRoot = externalInterpreter ? path.join(base, 'managed-uv') : path.join(root, 'runtime')
  fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true })
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.mkdirSync(launcherDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'hermes'), '#!/usr/bin/env python3\n', { mode: 0o700 })
  fs.writeFileSync(path.join(runtimeRoot, 'python'), 'fixture interpreter', { mode: 0o700 })
  fs.symlinkSync(path.relative(path.join(root, 'venv', 'bin'), path.join(runtimeRoot, 'python')), path.join(root, 'venv', 'bin', 'python'))
  fs.writeFileSync(path.join(root, 'venv', 'pyvenv.cfg'), `home = ${runtimeRoot}\nexecutable = ${path.join(runtimeRoot, 'python')}\ninclude-system-site-packages = false\n`, { mode: 0o600 })
  const launcher = path.join(launcherDir, 'hermes')
  fs.writeFileSync(launcher, officialWrapper(root), { mode: 0o700 })
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return { root, physicalRoot, runtimeRoot, launcher }
}

test('Hermes POSIX parser accepts only the exact upstream install.sh wrapper shape', () => {
  const root = '/private/hermes-home/hermes-agent', bytes = Buffer.from(officialWrapper(root))
  assert.deepEqual(parseHermesPosixLauncher(bytes), {
    schemaVersion: 1, kind: 'official-hermes-posix-launcher-v1', launcherSha256: sha256(bytes), root,
    interpreterPath: `${root}/venv/bin/python`, entrypointPath: `${root}/hermes`,
    authenticatingConfigPaths: [`${root}/venv/pyvenv.cfg`],
  })
})

test('Hermes POSIX canonical identity removes only proved launcher and venv paths', { skip: process.platform === 'win32' }, t => {
  const first = fixture(t, { externalInterpreter: true }), second = fixture(t, { externalInterpreter: true })
  const identity = item => canonicalHermesPosixIdentity(bindHermesPosixLauncher(item.launcher))
  const a = identity(first), b = identity(second)
  assert.deepEqual(a.canonicalFiles.map(item => item.sha256), b.canonicalFiles.map(item => item.sha256))
  fs.appendFileSync(path.join(second.root, 'venv', 'pyvenv.cfg'), 'prompt = changed\n')
  assert.notEqual(identity(second).canonicalFiles[1].sha256, b.canonicalFiles[1].sha256)
  assert.ok(a.canonicalFiles.every(item => /^[a-f0-9]{64}$/.test(item.rawSha256)))
})

test('Hermes POSIX canonical identity preserves root-like text in unknown fields', { skip: process.platform === 'win32' }, t => {
  const item = fixture(t, { externalInterpreter: true }), config = path.join(item.root, 'venv', 'pyvenv.cfg')
  fs.appendFileSync(config, `prompt = ${item.root}\n`)
  const before = canonicalHermesPosixIdentity(item.launcher)
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(`prompt = ${item.root}`, `prompt = ${item.root}-changed`))
  const after = canonicalHermesPosixIdentity(item.launcher)
  assert.notEqual(after.canonicalFiles[1].sha256, before.canonicalFiles[1].sha256)
})

test('Hermes POSIX canonical identity rejects a stale captured binding', { skip: process.platform === 'win32' }, t => {
  const item = fixture(t, { externalInterpreter: true }), captured = bindHermesPosixLauncher(item.launcher)
  fs.appendFileSync(path.join(item.root, 'venv', 'pyvenv.cfg'), 'prompt = changed\n')
  assert.throws(() => canonicalHermesPosixIdentity(captured), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
})

test('Hermes POSIX canonical identity rejects an unbound venv interpreter home or executable', { skip: process.platform === 'win32' }, t => {
  const item = fixture(t, { externalInterpreter: true }), config = path.join(item.root, 'venv', 'pyvenv.cfg')
  fs.writeFileSync(config, `home = ${item.root}\nexecutable = ${path.join(item.runtimeRoot, 'python')}\n`, { mode: 0o600 })
  assert.throws(() => canonicalHermesPosixIdentity(bindHermesPosixLauncher(item.launcher)), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
  fs.writeFileSync(config, `home = ${item.runtimeRoot}\nexecutable = ${path.join(item.root, 'hermes')}\n`, { mode: 0o600 })
  assert.throws(() => canonicalHermesPosixIdentity(bindHermesPosixLauncher(item.launcher)), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
})

test('Hermes POSIX parser rejects shell expansion, extra commands, and mismatched roots', () => {
  const root = '/private/hermes-home/hermes-agent'
  for (const text of [
    officialWrapper(root).replace('"$@"', '"$@"; curl https://example.invalid'),
    officialWrapper(root).replace(`${root}/venv/bin/python`, '${PYTHON}'),
    officialWrapper(root).replace(`${root}/hermes`, '/other/hermes'),
    officialWrapper(root).replace('unset PYTHONHOME\n', ''),
    officialWrapper(root).replace('#!/usr/bin/env bash', '#!/bin/sh'),
  ]) assert.throws(() => parseHermesPosixLauncher(Buffer.from(text)), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
})

test('Hermes POSIX binding hashes the wrapper, entrypoint, and venv configuration under one physical root', { skip: process.platform === 'win32' }, t => {
  const { root, launcher } = fixture(t), binding = bindHermesPosixLauncher(launcher)
  assert.equal(binding.root, root)
  assert.equal(binding.interpreter.path, path.join(root, 'venv', 'bin', 'python'))
  assert.equal(binding.interpreter.physicalPath, path.join(root, 'runtime', 'python'))
  assert.deepEqual(binding.authenticatingFiles.map(file => file.path), [
    launcher, path.join(root, 'hermes'), path.join(root, 'venv', 'pyvenv.cfg'),
  ])
  assert.ok(binding.authenticatingFiles.every(file => /^[a-f0-9]{64}$/.test(file.sha256)))
})

test('Hermes POSIX binding permits an official venv link to a separately managed private interpreter', { skip: process.platform === 'win32' }, t => {
  const { root, physicalRoot, runtimeRoot, launcher } = fixture(t, { aliasRoot: true, externalInterpreter: true })
  const binding = bindHermesPosixLauncher(launcher)
  assert.equal(binding.declaredRoot, root)
  assert.equal(binding.root, physicalRoot)
  assert.equal(binding.interpreter.physicalPath, path.join(runtimeRoot, 'python'))
  assert.equal(binding.authenticatingFiles.some(file => file.path === binding.interpreter.physicalPath), false)
})

test('Hermes POSIX binding rejects linked entrypoints and configuration escaping its installed root', { skip: process.platform === 'win32' }, t => {
  const { root, launcher } = fixture(t)
  fs.rmSync(path.join(root, 'hermes'))
  fs.symlinkSync('/bin/sh', path.join(root, 'hermes'))
  assert.throws(() => bindHermesPosixLauncher(launcher), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')

  fs.rmSync(path.join(root, 'hermes'))
  fs.writeFileSync(path.join(root, 'hermes'), '#!/usr/bin/env python3\n', { mode: 0o700 })
  fs.rmSync(path.join(root, 'venv', 'pyvenv.cfg'))
  fs.symlinkSync('/etc/hosts', path.join(root, 'venv', 'pyvenv.cfg'))
  assert.throws(() => bindHermesPosixLauncher(launcher), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
})


test('Hermes native identity binds the official POSIX wrapper configuration and selected interpreter', { skip: process.platform === 'win32' }, t => {
  const native = require('../../scripts/harness-v2-native.cjs')
  const cp = require('node:child_process'), original = cp.spawnSync
  const { root, launcher } = fixture(t, { externalInterpreter: true })
  const packageFile = path.join(root, 'package.py')
  fs.writeFileSync(packageFile, 'VALUE = 1\n')
  const inventory = { files: [packageFile], packageCount: 1, missing: [], rootConflicts: [], roots: [{ logicalPath: 'editable/source/hermes', path: root }] }
  cp.spawnSync = () => ({ status: 0, stdout: JSON.stringify(inventory), stderr: '' })
  try {
    assert.equal(native.hermesPythonInterpreter(launcher), path.join(root, 'venv', 'bin', 'python'))
    const capture = native.hermesPythonDependencyInventory(launcher)
    for (const file of [launcher, path.join(root, 'hermes'), path.join(root, 'venv', 'pyvenv.cfg')]) assert.equal(new Map(capture.files).get(file), sha256(fs.readFileSync(file)))
    const before = native.hermesRuntimeDependencyIdentity(launcher, {}, capture)
    fs.appendFileSync(path.join(root, 'venv', 'pyvenv.cfg'), 'prompt = changed\n')
    assert.notEqual(native.hermesRuntimeDependencyIdentity(launcher).sha256, before.sha256)
    const portable = native.hermesPortableRuntimeDependencyIdentity(launcher)
    assert.ok(portable.files.some(([label]) => label === 'hermes/venv-config'))
    cp.spawnSync = () => { fs.appendFileSync(path.join(root, 'hermes'), '# raced\n'); return { status: 0, stdout: JSON.stringify(inventory), stderr: '' } }
    assert.throws(() => native.hermesPythonDependencyInventory(launcher), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
  } finally { cp.spawnSync = original }
})

test('native portable identity agrees across relocated official POSIX installations', { skip: process.platform === 'win32' }, t => {
  const native = require('../../scripts/harness-v2-native.cjs'), cp = require('node:child_process'), original = cp.spawnSync
  const subjects = [fixture(t, { externalInterpreter: true }), fixture(t, { externalInterpreter: true })]
  for (const subject of subjects) fs.writeFileSync(path.join(subject.root, 'package.py'), 'VALUE = 1\n')
  cp.spawnSync = interpreter => {
    const subject = subjects.find(item => interpreter.startsWith(item.root + path.sep))
    assert.ok(subject)
    return { status: 0, stderr: '', stdout: JSON.stringify({ files: [path.join(subject.root, 'package.py')], packageCount: 1,
      missing: [], rootConflicts: [], roots: [{ logicalPath: 'editable/source/hermes', path: subject.root }] }) }
  }
  try {
    const identities = subjects.map(subject => native.hermesPortableRuntimeDependencyIdentity(subject.launcher))
    assert.equal(identities[0].sha256, identities[1].sha256)
    fs.appendFileSync(path.join(subjects[1].root, 'hermes'), '# changed executable source\n')
    assert.notEqual(native.hermesPortableRuntimeDependencyIdentity(subjects[1].launcher).sha256, identities[0].sha256)
  } finally { cp.spawnSync = original }
})
