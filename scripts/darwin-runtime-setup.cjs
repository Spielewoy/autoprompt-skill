#!/usr/bin/env node
'use strict'

// Creates the controller-private closure manifest consumed by phase-budget on
// Darwin. Discovery is persistent; bindActivation materializes a matching
// record after the activation payload helper is copied.
// node scripts/darwin-runtime-setup.cjs --provider codex --root /provider/root \
//   --python /physical/python3.12 --package-root /installed/package

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function fail(message) { throw new Error(`DARWIN_RUNTIME_SETUP_INVALID: ${message}`) }
const PROVIDERS = new Set(['claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'hermes', 'grok', 'reasonix'])
function directoryIdentity(item) {
  return { dev: String(item.dev), ino: String(item.ino) }
}
function sameDirectoryIdentity(left, right) {
  return left && right && left.dev === String(right.dev) && left.ino === String(right.ino)
}
function tightenInstallerPrivateRoot(directory) {
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null
  const before = fs.lstatSync(directory)
  if (!before.isDirectory() || before.isSymbolicLink() ||
      (expectedUid !== null && before.uid !== expectedUid) || (before.mode & 0o022) !== 0 ||
      fs.realpathSync(directory) !== directory) fail('controller private root is not private')
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  const descriptor = fs.openSync(directory, flags)
  try {
    const opened = fs.fstatSync(descriptor)
    const named = fs.lstatSync(directory)
    if (!opened.isDirectory() || (expectedUid !== null && opened.uid !== expectedUid) || (opened.mode & 0o022) !== 0 ||
        !sameDirectoryIdentity(directoryIdentity(before), opened) ||
        named.isSymbolicLink() || (named.mode & 0o022) !== 0 || !sameDirectoryIdentity(directoryIdentity(before), named)) {
      fail('controller private root changed while opened')
    }
    fs.fchmodSync(descriptor, 0o700)
    fs.fsyncSync(descriptor)
    const after = fs.fstatSync(descriptor)
    const renamed = fs.lstatSync(directory)
    if (!after.isDirectory() || (expectedUid !== null && after.uid !== expectedUid) ||
        (after.mode & 0o777) !== 0o700 || renamed.isSymbolicLink() ||
        !sameDirectoryIdentity(directoryIdentity(before), after) ||
        !sameDirectoryIdentity(directoryIdentity(before), renamed) || fs.realpathSync(directory) !== directory) {
      fail('controller private root changed while tightened')
    }
  } finally { fs.closeSync(descriptor) }
}
function persistentRoot(root, create = false) {
  const base = path.resolve(root)
  const baseItem = fs.lstatSync(base)
  if (!baseItem.isDirectory() || baseItem.isSymbolicLink() || fs.realpathSync(base) !== base) fail('provider root is not a physical directory')
  const privateRoot = path.join(base, '.autoprompt-private')
  const runtimeRoot = path.join(privateRoot, 'darwin-runtime')
  if (create) {
    try { fs.mkdirSync(privateRoot, { mode: 0o700 }) } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
    }
    // A public installer can leave this directory at 0755 under its umask.
    // Tighten only a stable directory owned by this user with no other writers;
    // links, foreign ownership, and group/other-writable roots
    // remain invalid rather than being repaired in place.
    tightenInstallerPrivateRoot(privateRoot)
    try { fs.mkdirSync(runtimeRoot, { mode: 0o700 }) } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
    }
  }
  const privateItem = fs.lstatSync(privateRoot)
  if (!privateItem.isDirectory() || privateItem.isSymbolicLink() || (privateItem.mode & 0o077) !== 0) fail('controller private root is not private')
  const item = fs.lstatSync(runtimeRoot)
  if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077) !== 0) fail('Darwin runtime root is not private')
  return runtimeRoot
}
function value(flag) {
  const index = process.argv.indexOf(flag)
  if (index < 0 || index + 1 >= process.argv.length) fail(`${flag} is required`)
  return process.argv[index + 1]
}
function physical(file, label) {
  if (!path.isAbsolute(file)) fail(`${label} must be absolute`)
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail(`${label} is not one physical file`)
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file)
  if (resolved !== file) fail(`${label} changes physical path`)
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.nlink !== 1 || String(opened.dev) !== String(before.dev) ||
        String(opened.ino) !== String(before.ino) || opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) fail(`${label} changed while opened`)
    const digest = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, opened.size))
    for (let offset = 0; offset < opened.size;) {
      const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size - offset), offset)
      if (read < 1) fail(`${label} was truncated`)
      digest.update(buffer.subarray(0, read)); offset += read
    }
    const after = fs.fstatSync(descriptor); const named = fs.lstatSync(resolved)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        String(after.dev) !== String(opened.dev) || String(after.ino) !== String(opened.ino) ||
        named.isSymbolicLink() || String(named.dev) !== String(opened.dev) || String(named.ino) !== String(opened.ino)) fail(`${label} changed while hashed`)
    return { path: resolved, sha256: digest.digest('hex'), maxBytes: 1024 * 1024 * 1024 }
  } finally { fs.closeSync(descriptor) }
}
function setup(input) {
  if (!input || !PROVIDERS.has(input.provider) || typeof input.root !== 'string' || !path.isAbsolute(input.root) ||
      typeof input.python !== 'string' || !path.isAbsolute(input.python) ||
      typeof input.packageRoot !== 'string' || !path.isAbsolute(input.packageRoot)) fail('provider, root, python, and packageRoot are required')
  if (process.platform !== 'darwin') fail('Darwin is required')
  if (input.refresh !== undefined && typeof input.refresh !== 'boolean') fail('refresh must be boolean')
  const root = persistentRoot(input.root, true)
  const lockPath = path.join(root, '.setup-lock')
  const ownerPath = path.join(lockPath, 'owner.json')
  try { fs.mkdirSync(lockPath, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const lock = fs.lstatSync(lockPath)
    if (!lock.isDirectory() || lock.isSymbolicLink() || (lock.mode & 0o077) !== 0) fail('runtime setup lock is unsafe')
    physical(ownerPath, 'runtime setup lock owner')
    let owner
    try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) } catch { fail('runtime setup lock owner is invalid') }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2147483647) fail('runtime setup lock owner is invalid')
    try { process.kill(owner.pid, 0); fail('runtime setup is already in progress') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    fs.unlinkSync(ownerPath); fs.rmdirSync(lockPath)
    fs.mkdirSync(lockPath, { mode: 0o700 })
  }
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' })
  try { return setupLocked(input, root) } finally { fs.unlinkSync(ownerPath); fs.rmdirSync(lockPath) }
}
function setupLocked(input, root) {
  const python = physical(input.python, 'python')
  const helperPath = path.join(path.resolve(input.packageRoot), 'agents', 'codex', 'workflow', 'darwin-filesystem.py')
  const helper = physical(helperPath, 'packaged Darwin filesystem helper')
  const output = path.join(root, 'darwin-runtime-closure.json')
  let previous = null
  let previousStat = null
  if (fs.existsSync(output)) {
    previous = physical(output, 'existing runtime closure')
    previousStat = fs.lstatSync(output)
    if ((previousStat.mode & 0o777) !== 0o600) fail('existing runtime closure is not private')
    const bytes = fs.readFileSync(output)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== previous.sha256) fail('existing runtime closure changed while read')
    let existing
    try { existing = JSON.parse(bytes.toString('utf8')) } catch { fail('existing runtime closure is invalid JSON') }
    if (!existing || existing.schemaVersion !== 1 || existing.kind !== 'darwin-python-runtime-closure-v1' || !Array.isArray(existing.entries)) fail('existing runtime closure is invalid')
    const pythonEntry = existing.entries.find(entry => entry && entry.role === 'python')
    const helperEntry = existing.entries.find(entry => entry && entry.role === 'helper')
    require('../agents/codex/workflow/darwin-runtime-closure.js').parseDarwinRuntimeClosureManifest(bytes)
    if (!input.refresh) {
      if (!pythonEntry || !helperEntry || pythonEntry.path !== python.path || pythonEntry.sha256 !== python.sha256 ||
          helperEntry.path !== helper.path || helperEntry.sha256 !== helper.sha256) fail('existing runtime closure does not match requested runtime; use --refresh to bind the updated installation')
      require(path.join(path.resolve(input.packageRoot), 'agents', 'codex', 'workflow', 'darwin-runtime-closure.js'))
        .validateDarwinRuntimeClosure({ manifest: output,
          manifestSha256: crypto.createHash('sha256').update(bytes).digest('hex') })
      return Object.freeze({ schemaVersion: 1, status: 'EXISTING', path: output,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'), entries: existing.entries.length })
    }
  }
  const probe = [
    // Keep this import list in lockstep with darwin-filesystem.py. The helper
    // opens libSystem for renameatx_np, so load it before enumerating images.
    'import json,os,stat,sys,base64,ctypes,errno',
    'libsystem=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)',
    'seen=[]',
    'for m in tuple(sys.modules.values()):',
    ' for p in (getattr(m,"__file__",None),getattr(m,"__cached__",None)):',
    '  if isinstance(p,str) and p.startswith("/") and os.path.isfile(p): seen.append(os.path.realpath(p))',
    'count=libsystem._dyld_image_count;count.restype=ctypes.c_uint32',
    'name=libsystem._dyld_get_image_name;name.argtypes=(ctypes.c_uint32,);name.restype=ctypes.c_char_p',
    'images=[];platform=[]',
    'for i in range(count()):',
    ' p=name(i)',
    ' if not p: continue',
    ' p=os.path.realpath(p.decode("utf-8","strict"))',
    ' if p.startswith("/System/") or p.startswith("/usr/lib/"): platform.append(p)',
    ' elif os.path.isfile(p): images.append(p)',
    'print(json.dumps({"modules":sorted(set(seen)),"nonSystemImages":sorted(set(images)),"platformImages":sorted(set(platform))},separators=(",",":")))',
  ].join('\n')
  const result = childProcess.spawnSync(python.path, ['-I', '-S', '-B', '-c', probe], {
    encoding: 'utf8', env: { HOME: path.dirname(output), LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }, shell: false, timeout: 30000,
  })
  if (result.error || result.status !== 0 || result.stderr) fail('isolated Python closure probe failed')
  const inventory = JSON.parse(result.stdout)
  if (!inventory || !Array.isArray(inventory.modules) || !Array.isArray(inventory.nonSystemImages) ||
      !Array.isArray(inventory.platformImages)) fail('isolated Python closure inventory is invalid')
  const dependencies = [...new Set([...inventory.modules, ...inventory.nonSystemImages])]
    .map(file => physical(file, 'Python dependency'))
  const entries = [
    { role: 'python', ...python }, { role: 'helper', ...helper },
    ...dependencies.filter(entry => entry.path !== python.path && entry.path !== helper.path).map(entry => ({ role: 'dependency', ...entry })),
  ]
  const body = JSON.stringify({ schemaVersion: 1, kind: 'darwin-python-runtime-closure-v1', entries }) + '\n'
  if (previous) {
    const temporary = path.join(root, `.darwin-runtime-closure.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
    fs.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' })
    const descriptor = fs.openSync(temporary, fs.constants.O_RDONLY)
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    const current = physical(output, 'existing runtime closure')
    const currentStat = fs.lstatSync(output)
    if (current.sha256 !== previous.sha256 || currentStat.dev !== previousStat.dev || currentStat.ino !== previousStat.ino ||
        currentStat.size !== previousStat.size || currentStat.mtimeMs !== previousStat.mtimeMs ||
        currentStat.ctimeMs !== previousStat.ctimeMs || currentStat.mode !== previousStat.mode) fail('existing runtime closure changed during refresh')
    persistentRoot(input.root)
    fs.renameSync(temporary, output)
    const directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } else fs.writeFileSync(output, body, { mode: 0o600, flag: 'wx' })
  const item = fs.statSync(output)
  if (!item.isFile() || item.nlink !== 1 || (item.mode & 0o777) !== 0o600) fail('output privacy check failed')
  return Object.freeze({ schemaVersion: 1, status: previous ? 'REFRESHED' : 'CREATED', path: output,
    sha256: crypto.createHash('sha256').update(body).digest('hex'), entries: entries.length,
    platformImages: inventory.platformImages.length })
}

function bindActivation(input) {
  if (!input || !PROVIDERS.has(input.provider) || typeof input.root !== 'string' || !path.isAbsolute(input.root) ||
      typeof input.activationRoot !== 'string' || !path.isAbsolute(input.activationRoot)) fail('provider, root, and activationRoot are required')
  const root = persistentRoot(input.root)
  const activationRoot = path.resolve(input.activationRoot)
  for (const [directory, label] of [[root, 'runtime root'], [activationRoot, 'activation root']]) {
    const item = fs.lstatSync(directory)
    if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077) !== 0 || fs.realpathSync(directory) !== directory) fail(`${label} is not private`)
  }
  const sourcePath = path.join(root, 'darwin-runtime-closure.json')
  const sourceBytes = fs.readFileSync(sourcePath)
  let source
  try { source = JSON.parse(sourceBytes.toString('utf8')) } catch { fail('persistent runtime closure is invalid JSON') }
  if (!source || source.schemaVersion !== 1 || source.kind !== 'darwin-python-runtime-closure-v1' || !Array.isArray(source.entries)) fail('persistent runtime closure is invalid')
  const sourceClosure = require('../agents/codex/workflow/darwin-runtime-closure.js').validateDarwinRuntimeClosure({
    manifest: sourcePath, manifestSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
  })
  const sourceHelper = sourceClosure.entries.find(entry => entry.role === 'helper')
  const helperDestination = path.join(activationRoot, 'darwin-runtime-helper.py')
  if (fs.existsSync(helperDestination)) fail('activation runtime helper already exists')
  fs.copyFileSync(sourceHelper.path, helperDestination, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(helperDestination, 0o600)
  const targetHelper = physical(helperDestination, 'activation Darwin filesystem helper')
  if (!sourceHelper || targetHelper.sha256 !== sourceHelper.sha256) fail('activation helper differs from persistent runtime closure')
  const entries = source.entries.map(entry => entry.role === 'helper'
    ? { role: 'helper', ...targetHelper } : entry)
  const output = path.join(activationRoot, 'darwin-runtime-closure.json')
  if (fs.existsSync(output)) fail('activation runtime closure record already exists')
  const body = JSON.stringify({ schemaVersion: 1, kind: 'darwin-python-runtime-closure-v1', entries }) + '\n'
  fs.writeFileSync(output, body, { mode: 0o600, flag: 'wx' })
  return Object.freeze({ schemaVersion: 1, status: 'BOUND', path: output,
    sha256: crypto.createHash('sha256').update(body).digest('hex'), entries: entries.length })
}

if (require.main === module) {
  try {
    if (process.argv.includes('--helper') || process.argv.includes('--output')) fail('helper and output are derived from --root')
    process.stdout.write(JSON.stringify(setup({ provider: value('--provider'), root: value('--root'), python: value('--python'), packageRoot: value('--package-root'), refresh: process.argv.includes('--refresh') })) + '\n')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2 }
}

module.exports = { setup, bindActivation }
