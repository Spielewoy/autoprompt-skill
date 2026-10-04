'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { bindActivation } = require('../../scripts/darwin-runtime-setup.cjs')

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-setup-binding-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'provider')
  const runtime = path.join(root, '.autoprompt-private', 'darwin-runtime')
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 })
  const activationRoot = path.join(base, 'activation')
  fs.mkdirSync(activationRoot, { mode: 0o700 })
  // These rejection-order tests model Darwin private directories on Windows.
  // Keep real file identities, bytes, and closure validation; native permission
  // enforcement is exercised by the actual Darwin setup test below.
  if (process.platform === 'win32') {
    const privateDirectories = new Set([path.dirname(runtime), runtime, activationRoot])
    const lstatSync = fs.lstatSync
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
      const stat = lstatSync(file, ...args)
      if (privateDirectories.has(file)) stat.mode &= ~0o077
      return stat
    })
  }
  const entries = ['python', 'helper', 'dependency'].map(role => {
    const file = path.join(base, role)
    fs.writeFileSync(file, role)
    return { role, path: file, sha256: crypto.createHash('sha256').update(role).digest('hex'), maxBytes: 1024 }
  })
  const record = path.join(runtime, 'darwin-runtime-closure.json')
  const write = value => fs.writeFileSync(record, JSON.stringify(value), { mode: 0o600 })
  const body = { schemaVersion: 1, kind: 'darwin-python-runtime-closure-v1', entries }
  write(body)
  return { base, root, activationRoot, entries, body, write }
}

test('Darwin activation binding rejects persistent dependency drift before publishing activation files', t => {
  const item = fixture(t)
  fs.appendFileSync(item.entries[2].path, 'changed')
  assert.throws(() => bindActivation({ provider: 'codex', ...item }), { code: 'DARWIN_RUNTIME_CLOSURE_MISMATCH' })
  assert.deepEqual(fs.readdirSync(item.activationRoot), [])
})

test('Darwin activation binding rejects a malformed closure before publishing activation files', t => {
  const item = fixture(t)
  item.write({ ...item.body, entries: item.entries.filter(entry => entry.role !== 'helper') })
  assert.throws(() => bindActivation({ provider: 'codex', ...item }), { code: 'DARWIN_RUNTIME_CLOSURE_INVALID' })
  assert.deepEqual(fs.readdirSync(item.activationRoot), [])
})

test('Darwin activation binding refuses redirected provider and activation ancestors', { skip: process.platform === 'win32' }, t => {
  const item = fixture(t)
  const alias = path.join(item.base, 'alias')
  fs.symlinkSync(item.base, alias, 'dir')
  assert.throws(() => bindActivation({ provider: 'codex', root: path.join(alias, 'provider'), activationRoot: item.activationRoot }), /provider root is not a physical directory/)
  assert.throws(() => bindActivation({ provider: 'codex', root: item.root, activationRoot: path.join(alias, 'activation') }), /activation root is not private/)
  assert.deepEqual(fs.readdirSync(item.activationRoot), [])
})

test('native Darwin explicit refresh atomically binds an updated packaged helper', { skip: process.platform !== 'darwin' || process.env.AUTOPROMPT_REAL_DARWIN_FILESYSTEM !== '1' }, t => {
  const item = fixture(t)
  fs.rmSync(path.join(item.root, '.autoprompt-private', 'darwin-runtime', 'darwin-runtime-closure.json'))
  const packageRoot = path.join(item.base, 'package')
  const workflow = path.join(packageRoot, 'agents', 'codex', 'workflow')
  fs.mkdirSync(workflow, { recursive: true, mode: 0o700 })
  for (const name of ['darwin-filesystem.py', 'darwin-runtime-closure.js']) fs.copyFileSync(path.resolve(__dirname, '../../agents/codex/workflow', name), path.join(workflow, name))
  const { setup } = require('../../scripts/darwin-runtime-setup.cjs')
  const input = { provider: 'codex', root: item.root, python: process.env.AUTOPROMPT_REAL_DARWIN_PYTHON, packageRoot }
  const initial = setup(input)
  assert.equal(initial.status, 'CREATED')
  fs.appendFileSync(path.join(workflow, 'darwin-filesystem.py'), '\n# upgraded packaged helper\n')
  assert.throws(() => setup(input), /use --refresh/)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(initial.path)).digest('hex'), initial.sha256)
  const refreshed = setup({ ...input, refresh: true })
  assert.equal(refreshed.status, 'REFRESHED')
  assert.notEqual(refreshed.sha256, initial.sha256)
  assert.equal(setup(input).status, 'EXISTING')
  const activation = bindActivation({ provider: 'codex', root: item.root, activationRoot: item.activationRoot })
  assert.equal(activation.status, 'BOUND')
  assert.match(fs.readFileSync(path.join(item.activationRoot, 'darwin-runtime-helper.py'), 'utf8'), /upgraded packaged helper/)
})
