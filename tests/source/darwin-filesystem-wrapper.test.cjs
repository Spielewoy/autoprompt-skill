'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const runtime = require('../../agents/codex/workflow/runtime-state.js')
const { validateDarwinRuntimeClosure } = require('../../agents/codex/workflow/darwin-runtime-closure.js')

const wrapperPath = path.resolve(__dirname, '../../agents/codex/workflow/darwin-filesystem.js')
const sourceHelper = path.resolve(__dirname, '../../agents/codex/workflow/darwin-filesystem.py')

function linuxFixtureWrapper() {
  const source = fs.readFileSync(wrapperPath, 'utf8')
  const marker = "const NATIVE_DARWIN = process.platform === 'darwin'"
  assert.equal(source.includes(marker), true)
  const local = new Module(wrapperPath + ':linux-fixture', module)
  local.filename = wrapperPath
  local.paths = Module._nodeModulePaths(path.dirname(wrapperPath))
  local._compile(source.replace(marker, 'const NATIVE_DARWIN = true'), wrapperPath)
  return local.exports
}

function physicalPython() {
  const probe = childProcess.spawnSync('python3', ['-c', 'import os,sys;print(os.path.realpath(sys.executable))'], {
    encoding: 'utf8', timeout: 10000,
  })
  if (probe.status !== 0) return null
  const executable = probe.stdout.trim()
  if (!path.isAbsolute(executable)) return null
  try {
    const stat = fs.statSync(executable)
    return stat.isFile() && stat.nlink === 1 ? executable : null
  } catch { return null }
}

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-darwin-wrapper-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const helper = path.join(root, 'helper.py')
  fs.copyFileSync(sourceHelper, helper)
  fs.chmodSync(helper, 0o600)
  return { root, helper }
}

function tree(root) {
  const target = path.join(root, 'tree')
  fs.mkdirSync(target, { mode: 0o700 })
  fs.writeFileSync(path.join(target, 'z.bin'), Buffer.from([0, 255, 10]))
  fs.writeFileSync(path.join(target, 'A.txt'), 'upper')
  fs.writeFileSync(path.join(target, 'a.txt'), 'lower')
  fs.mkdirSync(path.join(target, 'nested'), { mode: 0o700 })
  fs.writeFileSync(path.join(target, 'nested', 'large'), Buffer.alloc(2 * 1024 * 1024 + 3, 0xad))
  return target
}

const python = physicalPython()
const linuxExercise = process.platform === 'linux' && Boolean(python)

test('Darwin runtime closure manifest binds an exact controller-owned Python/helper set', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-runtime-closure-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const interpreter = fs.realpathSync.native(python || process.execPath)
  const copiedHelper = path.join(root, 'helper.py')
  fs.copyFileSync(sourceHelper, copiedHelper)
  fs.chmodSync(copiedHelper, 0o600)
  const manifest = path.join(root, 'runtime.json')
  const entry = (role, file, maxBytes) => ({ role, path: file,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), maxBytes })
  const body = { schemaVersion: 1, kind: 'darwin-python-runtime-closure-v1', entries: [
    entry('python', interpreter, 128 * 1024 * 1024), entry('helper', copiedHelper, 4 * 1024 * 1024),
  ] }
  fs.writeFileSync(manifest, JSON.stringify(body), { mode: 0o600 })
  const closure = validateDarwinRuntimeClosure({ manifest,
    manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') })
  assert.equal(closure.trustModel, 'controller-owned-exact-runtime-closure-v1')
  assert.equal(closure.entries[0].binding.path, interpreter)
  fs.appendFileSync(copiedHelper, '# changed\n')
  assert.throws(() => validateDarwinRuntimeClosure({ manifest,
    manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') }),
  { code: 'DARWIN_RUNTIME_CLOSURE_MISMATCH' })
})

for (const platform of ['darwin', 'win32']) test(`${platform} runtime-state hash dispatch accepts only an exact typed capture result`, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-runtime-dispatch-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  fs.mkdirSync(target, { mode: 0o700 })
  const runtimePath = path.resolve(__dirname, '../../agents/codex/workflow/runtime-state.js')
  const code = [
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })`,
    `const fs=require('node:fs'), r=require(${JSON.stringify(runtimePath)})`,
    `const target=${JSON.stringify(target)}`,
    "const shim=Object.create(fs), s=fs.lstatSync(target,{bigint:process.platform==='win32'}), root={type:'directory',path:'',stat:{dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode),nlink:Number(s.nlink),size:Number(s.size),mtimeNs:'0',ctimeNs:'0'}}; shim.darwinCapture={captureFile:()=>({hash:'a'.repeat(64),bytes:0,entries:[]}),captureTree:(value)=>{if(value!==target)throw Error('wrong path');return {hash:'b'.repeat(64),bytes:0,entries:[root]}}}",
    "if(r.hashFileStrict(target,shim)!=='a'.repeat(64)||r.hashDirectoryStateStrict(target,shim)!=='b'.repeat(64))process.exit(2)",
    "root.stat.ino=String(BigInt(root.stat.ino)+1n);try{r.hashDirectoryStateStrict(target,shim);process.exit(5)}catch(error){if(error.code!=='PREIMAGE_UNSAFE')process.exit(6)}",
    "shim.darwinCapture.captureTree=()=>({hash:'bad',bytes:0,entries:[]});try{r.hashDirectoryStateStrict(target,shim);process.exit(3)}catch(error){if(error.code!=='PREIMAGE_UNSAFE')process.exit(4)}",
  ].join(';').replaceAll('darwinCapture', platform === 'darwin' ? 'darwinCapture' : 'windowsCapture')
  const result = childProcess.spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
})

test('Darwin filesystem wrapper refuses production use away from Darwin', () => {
  if (process.platform === 'darwin') return
  const wrapper = require('../../agents/codex/workflow/darwin-filesystem.js')
  assert.throws(() => wrapper.createDarwinFilesystemCapture({ python: '/missing/python' }),
    { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
})

test('Darwin filesystem parser rejects partial, ambiguous, and malformed spool framing', () => {
  const { parseCapture } = require('../../agents/codex/workflow/darwin-filesystem.js')
  assert.throws(() => parseCapture('{"schemaVersion":1,"status":"CAPTURED","bytes":1,"entries":[]}\n', 'capture-file'),
    { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => parseCapture('{"schemaVersion":1,"status":"CAPTURED","bytes":1,"entries":[{"type":"file","path":"","stat":{"dev":"1","ino":"1","mode":384,"nlink":1,"size":1,"mtimeNs":"1","ctimeNs":"1"},"offset":1,"length":1}]}\n', 'capture-file'),
    { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => parseCapture('{"schemaVersion":1,"status":"REFUSED","code":"BAD\\nCODE"}\n', 'capture-file'),
    { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => parseCapture(JSON.stringify({ schemaVersion: 1, status: 'CAPTURED', bytes: 0,
    entries: [{ type: 'file', path: '', offset: 0, length: 0,
      stat: { dev: '1', ino: '1', mode: 2 ** 32 + 0o100600, nlink: 1, size: 0, mtimeNs: '1', ctimeNs: '1' } }],
  }) + '\n', 'capture-file'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => parseCapture('{"schemaVersion":1,"status":"CAPTURED","bytes":0,"entries":[{"type":"file","path":"","stat":{"dev":"1","ino":"1","mode":33152,"nlink":2,"size":0,"mtimeNs":"-1","ctimeNs":"-1"},"offset":0,"length":0}]}\n', 'capture-file'),
    { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => parseCapture('{"schemaVersion":1,"status":"CAPTURED","bytes":0,"entries":[{"type":"directory","path":"","stat":{"dev":"1","ino":"1","mode":33152,"nlink":1,"size":0,"mtimeNs":"-1","ctimeNs":"-1"}}]}\n', 'capture-tree'),
    { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  const backslash = parseCapture('{"schemaVersion":1,"status":"CAPTURED","bytes":0,"entries":[{"type":"directory","path":"","stat":{"dev":"1","ino":"1","mode":16832,"nlink":1,"size":0,"mtimeNs":"-1","ctimeNs":"-1"}},{"type":"file","path":"a\\\\b","stat":{"dev":"1","ino":"2","mode":33152,"nlink":1,"size":0,"mtimeNs":"-1","ctimeNs":"-1"},"offset":0,"length":0}]}\n', 'capture-tree')
  assert.equal(backslash.entries[1].path, 'a\\b')
})

test('Darwin mutation parser requires a single-link regular result with exact created bytes', () => {
  const { parseMutation } = require('../../agents/codex/workflow/darwin-filesystem.js')
  const stat = { dev: '1', ino: '1', mode: 0o100600, nlink: 1, size: 4, mtimeNs: '1', ctimeNs: '1' }
  assert.deepEqual(parseMutation(JSON.stringify({ schemaVersion: 1, status: 'CREATED', stat }) + '\n', 'CREATED', 4).stat, stat)
  for (const bad of [
    { ...stat, mode: 0o040700 }, { ...stat, nlink: 2 }, { ...stat, size: 3 },
    { ...stat, mode: 0o100644 },
  ]) assert.throws(() => parseMutation(JSON.stringify({ schemaVersion: 1, status: 'CREATED', stat: bad }) + '\n', 'CREATED', 4), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => parseMutation(JSON.stringify({ schemaVersion: 1, status: 'RENAMED', stat: { ...stat, size: 8193 } }) + '\n', 'RENAMED'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
})

test('test-only Linux module exercises held helper FD4, private spool FD3, and Node tree framing', { skip: !linuxExercise }, t => {
  const wrapper = linuxFixtureWrapper()
  const item = fixture(t)
  const target = tree(item.root)
  const capture = wrapper.createDarwinFilesystemCapture({ python, helper: item.helper, timeoutMs: 30000 })
  const file = capture.captureFile(path.join(target, 'z.bin'))
  assert.equal(file.hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(target, 'z.bin'))).digest('hex'))
  assert.equal(file.entries.length, 1)
  const directory = capture.captureTree(target)
  assert.equal(directory.hash, runtime.hashDirectoryStateStrict(target))
  assert.equal(directory.bytes, 2 * 1024 * 1024 + 3 + 3 + 5 + 5)
  assert.equal(directory.entries[0].type, 'directory')
  assert.ok(directory.entries.every(entry => !Object.hasOwn(entry, 'content')))
})

test('test-only Linux wrapper rechecks bound helper identity before every capture', { skip: !linuxExercise }, t => {
  const wrapper = linuxFixtureWrapper()
  const item = fixture(t)
  const target = tree(item.root)
  const capture = wrapper.createDarwinFilesystemCapture({ python, helper: item.helper })
  fs.appendFileSync(item.helper, '# changed\n')
  assert.throws(() => capture.captureFile(path.join(target, 'z.bin')), { code: 'FILESYSTEM_BACKEND_MISMATCH' })
})

test('test-only Linux wrapper creates a bounded exclusive durable record and refuses Darwin-only rename', { skip: !linuxExercise }, t => {
  const wrapper = linuxFixtureWrapper()
  const item = fixture(t)
  fs.mkdirSync(path.join(item.root, 'records'), { mode: 0o700 })
  const mutations = wrapper.createDarwinFilesystemMutations({ python, helper: item.helper })
  const bytes = Buffer.from([0, 255, 10])
  const created = mutations.writeRecordExclusive(item.root, ['records', 'one'], bytes)
  assert.equal(created.stat.size, bytes.length)
  assert.deepEqual(fs.readFileSync(path.join(item.root, 'records', 'one')), bytes)
  assert.throws(() => mutations.writeRecordExclusive(item.root, ['records', 'one'], bytes), { code: 'PREIMAGE_UNSAFE' })
  assert.throws(() => mutations.renameNoReplace(item.root, ['records', 'one'], item.root, ['records', 'two']), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => mutations.writeRecordExclusive(item.root, ['..'], bytes), { code: 'FILESYSTEM_BACKEND_INVALID' })
})

test('test-only Linux wrapper refuses a same-size record changed before held-descriptor readback', { skip: !linuxExercise }, t => {
  const wrapper = linuxFixtureWrapper()
  const item = fixture(t)
  fs.mkdirSync(path.join(item.root, 'records'), { mode: 0o700 })
  fs.writeFileSync(item.helper, [
    'import importlib.util, os',
    `spec=importlib.util.spec_from_file_location('original', ${JSON.stringify(sourceHelper)})`,
    'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'read=module.read_exact; changed=False',
    'def altered(fd, size):',
    ' global changed',
    " if not changed: changed=True; os.pwrite(fd, b'evil', 0)",
    ' return read(fd, size)',
    'module.read_exact=altered; module.main()',
  ].join('\n'))
  fs.chmodSync(item.helper, 0o600)
  const mutations = wrapper.createDarwinFilesystemMutations({ python, helper: item.helper })
  assert.throws(() => mutations.writeRecordExclusive(item.root, ['records', 'record'], Buffer.from('good')), { code: 'PREIMAGE_UNSAFE' })
  assert.deepEqual(fs.readFileSync(path.join(item.root, 'records', 'record')), Buffer.from('evil'))
})

test('test-only Linux wrapper cleans its private spool if the FD4 helper open fails', { skip: !linuxExercise }, t => {
  const wrapper = linuxFixtureWrapper()
  const item = fixture(t)
  const target = tree(item.root)
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('autoprompt-darwin-capture-')))
  const capture = wrapper.createDarwinFilesystemCapture({ python, helper: item.helper })
  const openSync = fs.openSync
  let helperOpens = 0
  fs.openSync = function patchedOpen(filename, ...args) {
    if (filename === item.helper && ++helperOpens === 2) {
      const error = new Error('injected FD4 helper open failure')
      error.code = 'EIO'
      throw error
    }
    return openSync.call(this, filename, ...args)
  }
  try {
    assert.throws(() => capture.captureFile(path.join(target, 'z.bin')), { code: 'EIO' })
  } finally {
    fs.openSync = openSync
  }
  const after = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('autoprompt-darwin-capture-')))
  assert.deepEqual([...after].filter(name => !before.has(name)), [])
})

const nativeDarwin = process.platform === 'darwin' && process.env.AUTOPROMPT_REAL_DARWIN_FILESYSTEM === '1'
test('native Darwin wrapper captures known APFS bytes through the physical Python helper', { skip: !nativeDarwin }, t => {
  const configuredPython = process.env.AUTOPROMPT_REAL_DARWIN_PYTHON
  assert.equal(typeof configuredPython, 'string')
  const capture = require('../../agents/codex/workflow/darwin-filesystem.js')
    .createDarwinFilesystemCapture({ python: configuredPython, helper: sourceHelper })
  const item = fixture(t)
  // The production strict descriptor-path implementation is Linux-only; it
  // cannot serve as a Darwin oracle. Use an independently framed known tree.
  const target = path.join(item.root, 'native-tree')
  fs.mkdirSync(target, { mode: 0o700 })
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 0xad)
  fs.writeFileSync(path.join(target, 'payload.bin'), bytes, { mode: 0o600 })
  const result = capture.captureTree(target)
  const expected = crypto.createHash('sha256').update(`file\0payload.bin\0${0o600}\0${bytes.length}\0`)
    .update(bytes).update('\0').digest('hex')
  assert.equal(result.hash, expected)
  assert.equal(result.bytes, bytes.length)
  assert.equal(capture.captureFile(path.join(target, 'payload.bin')).hash,
    crypto.createHash('sha256').update(bytes).digest('hex'))
})

test('native Darwin mutation wrapper exclusively publishes a durable record on APFS', { skip: !nativeDarwin }, t => {
  const configuredPython = process.env.AUTOPROMPT_REAL_DARWIN_PYTHON
  const item = fixture(t)
  fs.mkdirSync(path.join(item.root, 'records'), { mode: 0o700 })
  const mutations = require('../../agents/codex/workflow/darwin-filesystem.js')
    .createDarwinFilesystemMutations({ python: configuredPython, helper: sourceHelper })
  const bytes = Buffer.from([0, 255, 10, 65])
  mutations.writeRecordExclusive(item.root, ['records', 'source'], bytes)
  assert.throws(() => mutations.writeRecordExclusive(item.root, ['records', 'source'], bytes), { code: 'PREIMAGE_UNSAFE' })
  mutations.renameNoReplace(item.root, ['records', 'source'], item.root, ['records', 'target'])
  assert.deepEqual(fs.readFileSync(path.join(item.root, 'records', 'target')), bytes)
  fs.writeFileSync(path.join(item.root, 'records', 'occupied'), 'user')
  assert.throws(() => mutations.renameNoReplace(item.root, ['records', 'target'], item.root, ['records', 'occupied']), { code: 'PREIMAGE_UNSAFE' })
  assert.deepEqual(fs.readFileSync(path.join(item.root, 'records', 'occupied')), Buffer.from('user'))
})

test('native Darwin setup-bound publication atomically preserves occupied names and rejects redirected parents', { skip: !nativeDarwin }, t => {
  const item = fixture(t)
  const provider = path.join(item.root, 'provider')
  const activationRoot = path.join(item.root, 'activation')
  fs.mkdirSync(provider, { mode: 0o755 })
  fs.mkdirSync(activationRoot, { mode: 0o700 })
  const python = process.env.AUTOPROMPT_REAL_DARWIN_PYTHON
  const setup = require('../../scripts/darwin-runtime-setup.cjs')
  setup.setup({ provider: 'codex', root: provider, python, packageRoot: path.resolve(__dirname, '../..') })
  const binding = setup.bindActivation({ provider: 'codex', root: provider, activationRoot })
  const options = { python, helper: path.join(activationRoot, 'darwin-runtime-helper.py'),
    runtimeClosure: { manifest: binding.path, manifestSha256: binding.sha256 } }
  const wrapper = require('../../agents/codex/workflow/darwin-filesystem.js')
  const mutations = wrapper.createDarwinFilesystemMutations(options)
  const capture = wrapper.createDarwinFilesystemCapture(options)
  const target = path.join(item.root, 'terminal.json')
  mutations.assertRecordParent(target)
  assert.throws(() => capture.captureFileBytes(target), { code: 'ENOENT' })
  assert.throws(() => capture.captureFileBytes(path.join(item.root, 'absent-parent', 'terminal.json')), { code: 'PREIMAGE_UNSAFE' })
  const bytes = Buffer.alloc(64 * 1024 + 1, 0x61)
  mutations.publishRecordExclusive(target, bytes)
  assert.deepEqual(capture.captureFileBytes(target).content, bytes)
  assert.equal(fs.lstatSync(target).nlink, 1)
  assert.throws(() => mutations.publishRecordExclusive(target, Buffer.from('conflict')), { code: 'EEXIST' })
  assert.deepEqual(capture.captureFileBytes(target).content, bytes)
  const alias = path.join(item.root, 'alias')
  fs.symlinkSync(item.root, alias, 'dir')
  assert.throws(() => mutations.assertRecordParent(path.join(alias, 'new.json')), { code: 'PREIMAGE_UNSAFE' })
  assert.throws(() => mutations.publishRecordExclusive(path.join(alias, 'new.json'), Buffer.from('foreign')), { code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.existsSync(path.join(item.root, 'new.json')), false)
  const before = fs.readdirSync(item.root).sort()
  assert.throws(() => mutations.publishRecordExclusive(path.join(item.root, 'overflow'), Buffer.alloc(8 * 1024 * 1024 + 2)), { code: 'FILESYSTEM_BACKEND_INVALID' })
  assert.deepEqual(fs.readdirSync(item.root).sort(), before)
  const exited = childProcess.spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.equal(exited.status, 0)
  const residue = `.terminal.json.${exited.pid}.${'a'.repeat(16)}.create`
  fs.writeFileSync(path.join(item.root, residue), 'partial crash bytes', { mode: 0o600 })
  assert.deepEqual(mutations.recoverRecordPublication(target), [residue])
  assert.equal(fs.existsSync(path.join(item.root, residue)), false)
  const liveResidue = `.terminal.json.${process.pid}.${'b'.repeat(16)}.create`
  fs.writeFileSync(path.join(item.root, liveResidue), 'live writer', { mode: 0o600 })
  assert.throws(() => mutations.recoverRecordPublication(target), { code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.readFileSync(path.join(item.root, liveResidue), 'utf8'), 'live writer')
})

test('native Darwin owned cleanup binds exact identities and preflights the entire tree before deleting', { skip: !nativeDarwin }, t => {
  const item = fixture(t)
  const mutations = require('../../agents/codex/workflow/darwin-filesystem.js')
    .createDarwinFilesystemMutations({ python: process.env.AUTOPROMPT_REAL_DARWIN_PYTHON, helper: sourceHelper })
  const target = path.join(item.root, 'owned-scratch')
  fs.mkdirSync(path.join(target, 'nested'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(target, 'first.txt'), 'owned scratch')
  fs.writeFileSync(path.join(target, 'nested', 'last.bin'), Buffer.from([0, 255, 10]))
  const foreign = path.join(item.root, 'foreign.txt')
  fs.writeFileSync(foreign, 'user data')
  const inspected = mutations.inspectOwnedTarget(target)
  assert.equal(inspected.targetIdentity.type, 'directory')
  assert.throws(() => mutations.removeOwnedTarget(target, inspected.parentIdentity, { ...inspected.targetIdentity, ino: '0' }), { code: 'PREIMAGE_UNSAFE' })
  fs.symlinkSync(foreign, path.join(target, 'nested', 'unsafe-link'))
  assert.throws(() => mutations.removeOwnedTarget(target, inspected.parentIdentity, inspected.targetIdentity), { code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.readFileSync(path.join(target, 'first.txt'), 'utf8'), 'owned scratch')
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'user data')
  fs.unlinkSync(path.join(target, 'nested', 'unsafe-link'))
  assert.deepEqual(mutations.removeOwnedTarget(target, inspected.parentIdentity, inspected.targetIdentity), { removed: true })
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(mutations.removeOwnedTarget(target, inspected.parentIdentity, inspected.targetIdentity), { removed: false })
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'user data')
})
