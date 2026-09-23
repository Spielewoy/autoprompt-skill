'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { atomicWriteJson, sha256, stableStringify } = require('../../agents/codex/workflow/event-log.js')

const WINDOWS = process.platform === 'win32'
function loadAliasModule() {
  if (WINDOWS) return {}
  const filename = path.resolve(__dirname, '../../scripts/harness-v2-vscode-ipc-alias.cjs')
  if (process.platform !== 'darwin') return require(filename)
  const localRequire = createRequire(filename), module = { exports: {} }
  const unitProcess = new Proxy(process, { get(target, property) {
    return property === 'platform' ? 'linux' : Reflect.get(target, property)
  } })
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: localRequire,
    __dirname: path.dirname(filename), __filename: filename, process: unitProcess, Buffer,
  }, { filename })
  return module.exports
}
const { prepare, recover } = loadAliasModule()
const aliasTest = (name, fn) => test(name, { skip: WINDOWS ? 'Darwin-only POSIX alias lifecycle' : false }, fn)

const binding = Object.freeze({ reservationId: 'reservation-vscode-1', sessionId: 'session-vscode-1', targetKey: 'vscode-owned' })

class FakeOwner {
  constructor() { this.issueCalls = []; this.receipts = new WeakMap(); this.failure = null }
  async issueBoundDrainReceipt(expected, ...rest) {
    this.issueCalls.push({ expected, rest })
    if (this.failure) throw this.failure
    const receipt = Object.freeze({ receipt: this.issueCalls.length })
    this.receipts.set(receipt, JSON.stringify(expected))
    return receipt
  }
  verifyBoundDrainReceipt(receipt, expected) {
    if (this.receipts.get(receipt) !== JSON.stringify(expected)) throw Object.assign(new Error('foreign receipt'), { code: 'PROCESS_IDENTITY_INVALID' })
    return true
  }
}

function fixture(t, label = 'fixture') {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `vscode-ipc-${label}-`)))
  fs.chmodSync(base, 0o700)
  const shortParent = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir()
  const shortRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(shortParent, 'av-')))
  fs.chmodSync(shortRoot, 0o700)
  const deep = path.join(base, ...Array.from({ length: 8 }, (_, index) => `deep-segment-${index}-${'x'.repeat(18)}`))
  const target = path.join(deep, 'home', 'user-data')
  const journalRoot = path.join(deep, 'owner-journal')
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.mkdirSync(journalRoot, { recursive: true, mode: 0o700 })
  fs.chmodSync(target, 0o700); fs.chmodSync(journalRoot, 0o700)
  const journalPath = path.join(journalRoot, 'vscode-ipc.json')
  const owner = new FakeOwner()
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(shortRoot, { recursive: true, force: true }) })
  return { base, shortRoot, target: fs.realpathSync.native(target), journalPath, owner,
    options: { journalPath, targetPath: fs.realpathSync.native(target), binding, processOwner: owner, _testShortRoot: shortRoot } }
}
function journal(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }

aliasTest('deep VS Code storage receives a short private alias with immutable launch binding', async t => {
  const f = fixture(t, 'short')
  assert.ok(Buffer.byteLength(path.join(f.target, '0000-main.sock')) >= 103)
  const resource = prepare(f.options)
  const initialHash = resource.launchBindingHash
  assert.match(initialHash, /^[a-f0-9]{64}$/)
  assert.ok(Buffer.byteLength(path.join(resource.userDataDir, '0000-main.sock')) < 103)
  assert.equal(fs.readlinkSync(resource.userDataDir), f.target)
  fs.writeFileSync(path.join(resource.userDataDir, 'settings-proof'), 'deep')
  assert.equal(fs.readFileSync(path.join(f.target, 'settings-proof'), 'utf8'), 'deep')
  fs.unlinkSync(path.join(f.target, 'settings-proof'))
  assert.equal(journal(f.journalPath).launchBindingHash, initialHash)
  resource.markReservationEntered()
  assert.equal(journal(f.journalPath).launchBindingHash, initialHash)
  await assert.rejects(async () => resource.abortBeforeReservation(), { code: 'VSCODE_IPC_ALIAS_STATE_INVALID' })
  await resource.release()
  assert.equal(f.owner.issueCalls.length, 1)
  assert.deepEqual(f.owner.issueCalls[0].rest, [], 'release must not request an implicit running drain')
  assert.deepEqual(f.owner.issueCalls[0].expected, { ...binding, launchBindingHash: initialHash })
  assert.equal(fs.existsSync(path.dirname(resource.userDataDir)), false)
  assert.equal(journal(f.journalPath).state, 'CLEANED')
  assert.equal(fs.existsSync(f.target), true)
  const recovered = await recover({ journalPath: f.journalPath, processOwner: f.owner, _testShortRoot: f.shortRoot })
  assert.equal(recovered.cleaned, true)
  assert.equal(f.owner.issueCalls.length, 1)
})

aliasTest('same-process pre-reservation capability aborts without ProcessOwner evidence', t => {
  const f = fixture(t, 'abort')
  const resource = prepare(f.options)
  resource.abortBeforeReservation()
  assert.equal(f.owner.issueCalls.length, 0)
  assert.equal(fs.existsSync(path.dirname(resource.userDataDir)), false)
  assert.equal(journal(f.journalPath).state, 'CLEANED')
})

aliasTest('fresh recovery retains absent, pending, or live ownership without touching the alias', async t => {
  for (const [index, code] of ['PROCESS_IDENTITY_INVALID', 'OWNERSHIP_RECOVERY_PENDING', 'PROCESS_DRAIN_TIMEOUT'].entries()) {
    await t.test(code, async child => {
      const f = fixture(child, `retain-${index}`)
      const resource = prepare(f.options)
      resource.markReservationEntered()
      f.owner.failure = Object.assign(new Error(code), { code })
      await assert.rejects(recover({ journalPath: f.journalPath, processOwner: f.owner, _testShortRoot: f.shortRoot }), { code })
      assert.equal(fs.readlinkSync(resource.userDataDir), f.target)
      assert.equal(journal(f.journalPath).state, 'RESERVATION_ENTERED')
    })
  }
})

aliasTest('rebound alias identity is retained instead of unlinked after a terminal receipt', async t => {
  const f = fixture(t, 'swap')
  const resource = prepare(f.options)
  resource.markReservationEntered()
  const foreign = path.join(f.base, 'foreign'); fs.mkdirSync(foreign, { mode: 0o700 })
  fs.unlinkSync(resource.userDataDir); fs.symlinkSync(foreign, resource.userDataDir, 'dir')
  await assert.rejects(resource.release(), { code: 'VSCODE_IPC_ALIAS_UNSAFE' })
  assert.equal(fs.readlinkSync(resource.userDataDir), foreign)
  assert.equal(fs.existsSync(path.dirname(resource.userDataDir)), true)
})

aliasTest('failed cleanup retains its physical child and resumes idempotently from RELEASING', async t => {
  const f = fixture(t, 'resume')
  const resource = prepare(f.options)
  resource.markReservationEntered()
  const residue = path.join(path.dirname(resource.userDataDir), 'unexpected')
  fs.writeFileSync(residue, 'retain')
  await assert.rejects(resource.release(), { code: 'VSCODE_IPC_ALIAS_UNSAFE' })
  assert.equal(journal(f.journalPath).state, 'RELEASING')
  assert.equal(fs.existsSync(path.dirname(resource.userDataDir)), true)
  assert.equal(fs.existsSync(resource.userDataDir), false)
  fs.unlinkSync(residue)
  await recover({ journalPath: f.journalPath, processOwner: f.owner, _testShortRoot: f.shortRoot })
  assert.equal(fs.existsSync(path.dirname(resource.userDataDir)), false)
  assert.equal(journal(f.journalPath).state, 'CLEANED')
})

aliasTest('journal binding or checksum mutation fails closed without touching the alias', async t => {
  const f = fixture(t, 'tamper')
  const resource = prepare(f.options)
  resource.markReservationEntered()
  const changed = journal(f.journalPath)
  changed.binding.targetKey = 'foreign'
  delete changed.checksum
  atomicWriteJson(f.journalPath, changed)
  await assert.rejects(recover({ journalPath: f.journalPath, processOwner: f.owner, _testShortRoot: f.shortRoot }), { code: 'VSCODE_IPC_ALIAS_JOURNAL_INVALID' })
  assert.equal(fs.readlinkSync(resource.userDataDir), f.target)
})

aliasTest('same-process handle refuses a checksummed identity rebinding', async t => {
  const f = fixture(t, 'rebind')
  const resource = prepare(f.options)
  const changed = journal(f.journalPath)
  changed.link.identity.ino = String(BigInt(changed.link.identity.ino) + 1n)
  changed.launchBindingHash = sha256(stableStringify({
    schemaVersion: changed.schemaVersion,
    resourceType: changed.resourceType,
    binding: changed.binding,
    target: changed.target,
    shortRoot: changed.shortRoot,
    child: changed.child,
    link: changed.link,
  }))
  delete changed.checksum
  atomicWriteJson(f.journalPath, changed)
  assert.throws(() => resource.markReservationEntered(), { code: 'VSCODE_IPC_ALIAS_STATE_INVALID' })
  assert.equal(fs.readlinkSync(resource.userDataDir), f.target)
})

aliasTest('duplicate preparation preserves the winner journal and alias', t => {
  const f = fixture(t, 'duplicate')
  const winner = prepare(f.options)
  const before = fs.readFileSync(f.journalPath)
  assert.throws(() => prepare(f.options), { code: 'VSCODE_IPC_ALIAS_STATE_INVALID' })
  assert.deepEqual(fs.readFileSync(f.journalPath), before)
  assert.equal(fs.readlinkSync(winner.userDataDir), f.target)
  winner.abortBeforeReservation()
})

aliasTest('known post-allocation preparation failure retires the exact unlaunched alias', t => {
  const f = fixture(t, 'prepare-failure')
  const longRoot = path.join(f.base, 's'.repeat(70))
  const options = { ...f.options, _testShortRoot: longRoot }
  assert.throws(() => prepare(options), { code: 'VSCODE_IPC_ALIAS_UNSAFE' })
  const retained = journal(f.journalPath)
  assert.equal(retained.state, 'CLEANED')
  assert.equal(fs.existsSync(retained.child.path), false)
  assert.equal(fs.existsSync(f.target), true)
})
