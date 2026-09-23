'use strict'

// Portable routing/lifecycle coverage only. The alias module itself owns its
// Darwin identity checks and has separate tests; this VM makes the transport
// take its Darwin recovery branch while all discovery paths use real private
// filesystem objects.
const nodeTest = require('node:test')
const test = (name, run) => nodeTest(name, { skip: process.platform === 'win32' ? 'Darwin POSIX discovery fixture' : false }, run)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const TRANSPORT = path.join(ROOT, 'scripts/harness-v2-transport.cjs')
const HEX = value => value.toString(16).padStart(64, '0')
function privateDirectory(directory) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); return directory }
function fixture(t, recover) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ipc-recovery-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const nativeRoot = privateDirectory(path.join(base, 'native'))
  const module = { exports: {} }, localRequire = createRequire(TRANSPORT)
  const processFixture = Object.create(process)
  Object.defineProperty(processFixture, 'platform', { value: 'darwin' })
  vm.runInNewContext(fs.readFileSync(TRANSPORT, 'utf8'), {
    require(name) { return name === './harness-v2-vscode-ipc-alias.cjs' ? { recover } : localRequire(name) },
    module, exports: module.exports, __dirname: path.dirname(TRANSPORT), __filename: TRANSPORT,
    process: processFixture, Buffer, console, URL, setTimeout, clearTimeout, AbortController,
  }, { filename: 'darwin-transport-recovery-vm.cjs' })
  const runner = { run() {}, stop() {}, processOwner: { id: 'exact-owner' } }
  const adapter = new module.exports.HarnessExecAdapter({ provider: 'vscode', runner, nativeRoot,
    executableBinding: { provider: 'vscode', path: process.execPath, sha256: 'a'.repeat(64) }, connection: { model: 'fixture' },
    rolePrompt: () => '', outputSchemaResolver: () => '{}' })
  const addJournal = (context, reservation) => {
    const directory = privateDirectory(path.join(nativeRoot, 'vscode', HEX(context), HEX(reservation)))
    const journalPath = path.join(directory, 'vscode-ipc-alias.json')
    fs.writeFileSync(journalPath, '{}', { mode: 0o600 })
    return journalPath
  }
  return { nativeRoot, adapter, addJournal }
}
function coded(code) { const error = Error(code); error.code = code; return error }

test('Darwin VS Code recovery ignores more than 4096 authenticated completed journals', async t => {
  const calls = []
  const f = fixture(t, async ({ journalPath }) => { calls.push(journalPath); return { alreadyCleaned: true } })
  for (let i = 0; i < 4097; i++) f.addJournal(1, i)
  const result = await f.adapter.recoverResources({ requireDrained: true })
  assert.equal(calls.length, 4097)
  assert.equal(result.cleaned, 0); assert.equal(result.retained.length, 0)
})

test('Darwin VS Code recovery retains pending aliases and requireDrained refuses them', async t => {
  const f = fixture(t, async () => { throw coded('OWNERSHIP_RECOVERY_PENDING') })
  const journalPath = f.addJournal(2, 1)
  const relaxed = await f.adapter.recoverResources()
  assert.equal(relaxed.cleaned, 0); assert.equal(relaxed.retained.length, 1); assert.equal(relaxed.retained[0].journalPath, journalPath); assert.equal(relaxed.retained[0].code, 'OWNERSHIP_RECOVERY_PENDING')
  await assert.rejects(f.adapter.recoverResources({ requireDrained: true }), error => error.code === 'PROCESS_DRAIN_TIMEOUT')
})

for (const kind of ['non-directory', 'linked']) test(`Darwin VS Code recovery refuses a ${kind} hash entry`, async t => {
  const f = fixture(t, async () => ({ alreadyCleaned: true }))
  const root = privateDirectory(path.join(f.nativeRoot, 'vscode'))
  const name = HEX(7)
  if (kind === 'non-directory') fs.writeFileSync(path.join(root, name), 'foreign', { mode: 0o600 })
  else {
    const target = privateDirectory(path.join(f.nativeRoot, 'private-target'))
    fs.symlinkSync(target, path.join(root, name), 'dir')
  }
  await assert.rejects(f.adapter.recoverResources(), error => error.code === 'VSCODE_IPC_ALIAS_UNSAFE')
})

test('concurrent Darwin VS Code recovery callers share one in-flight scan', async t => {
  let calls = 0, unblock
  const pending = new Promise(resolve => { unblock = resolve })
  const f = fixture(t, async () => { calls++; await pending; return { alreadyCleaned: false } })
  f.addJournal(3, 1)
  const first = f.adapter.recoverResources(), second = f.adapter.recoverResources()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  unblock()
  const [one, two] = await Promise.all([first, second])
  assert.equal(one.cleaned, 1); assert.equal(one.retained.length, 0)
  assert.equal(two, one)
})
