'use strict'

// Portable discovery coverage. Native AppContainer recovery owns the Windows
// ACL proof; this VM exercises the transport's fail-closed orphan accounting.
const nodeTest = require('node:test')
const test = (name, run) => nodeTest(name, { skip: process.platform === 'win32' ? 'portable Windows discovery fixture' : false }, run)
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const TRANSPORT = path.join(ROOT, 'scripts/harness-v2-transport.cjs')
const H64 = character => character.repeat(64)
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function privateDirectory(directory) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); return directory }
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-resource-recovery-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const nativeRoot = privateDirectory(path.join(base, 'native'))
  const module = { exports: {} }, localRequire = createRequire(TRANSPORT)
  const processFixture = Object.create(process)
  Object.defineProperty(processFixture, 'platform', { value: 'win32' })
  vm.runInNewContext(fs.readFileSync(TRANSPORT, 'utf8'), {
    require(name) {
      if (name === './harness-v2-bridge/grok/windows-sandbox.cjs') return { recoverDiscoveredWindowsGrokSandbox() { assert.fail('orphan fixture has no broker request') } }
      return localRequire(name)
    },
    module, exports: module.exports, __dirname: path.dirname(TRANSPORT), __filename: TRANSPORT,
    process: processFixture, Buffer, console, URL, setTimeout, clearTimeout, AbortController,
  }, { filename: 'windows-grok-resource-recovery-vm.cjs' })
  const runner = { run() {}, stop() {}, targetKey: 'target', processOwner: { listRecords: () => [] } }
  const adapter = new module.exports.HarnessExecAdapter({ provider: 'grok', runner, nativeRoot,
    executableBinding: { provider: 'grok', path: process.execPath, sha256: 'a'.repeat(64) }, connection: { model: 'fixture' },
    rolePrompt: () => '', outputSchemaResolver: () => '{}' })
  const controlRoot = privateDirectory(path.join(nativeRoot, 'grok', H64('a'), H64('b'), 'broker-control'))
  const addJournal = ({ restored = false, mutateReceipt = false, malformedPlan = false, hardlinkReceipt = false } = {}) => {
    const leaseId = 'c'.repeat(32), journalPath = path.join(controlRoot, `${leaseId}.resources.json`)
    const identity = '12345678:0000000000000001', creation = '132000000000000000', root = 'C:\\grok-target'
    const plan = { schemaVersion: 3, profileName: `Autoprompt_${leaseId}`, profileSid: 'S-1-15-2-1-2-3-4-5-6-7',
      roots: [{ path: root, kind: 'directory', identity, creation, writable: true }],
      entries: [{ identity, creation, label: '', directory: true, writable: true, git: false, root: true,
        daclProtected: true, inheritedAces: [], explicitAces: [] }] }
    if (malformedPlan) plan.entries[0].identity = 'not-an-object-identity'
    const body = { schemaVersion: 1, leaseId, plan }
    fs.writeFileSync(journalPath, `${JSON.stringify({ ...body, sha256: sha256(JSON.stringify(body)) })}\n`, { mode: 0o600 })
    if (restored) {
      const receiptPath = `${journalPath}.restored`
      fs.writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, leaseId,
        profileSid: mutateReceipt ? `${plan.profileSid}-9` : plan.profileSid, result: { restored: 1, newEntries: 0, deletedEntries: 0 } })}\n`, { mode: 0o600 })
      if (hardlinkReceipt) fs.linkSync(receiptPath, `${receiptPath}.foreign-link`)
    }
    return journalPath
  }
  return { adapter, addJournal }
}

test('Windows Grok recovery reports a prepublication resource journal and requireDrained refuses it', async t => {
  const f = fixture(t), journalPath = f.addJournal()
  const result = await f.adapter.recoverResources()
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { cleaned: 0, retained: [{ journalPath, code: 'GROK_WINDOWS_RESOURCE_ORPHANED' }] })
  await assert.rejects(f.adapter.recoverResources({ requireDrained: true }), error => error.code === 'PROCESS_DRAIN_TIMEOUT')
})

test('Windows Grok recovery accepts only a journal-bound completed restoration receipt', async t => {
  const completed = fixture(t); completed.addJournal({ restored: true })
  assert.deepEqual(JSON.parse(JSON.stringify(await completed.adapter.recoverResources({ requireDrained: true }))), { cleaned: 0, retained: [] })

  const changed = fixture(t), journalPath = changed.addJournal({ restored: true, mutateReceipt: true })
  assert.deepEqual(JSON.parse(JSON.stringify(await changed.adapter.recoverResources())), { cleaned: 0,
    retained: [{ journalPath, code: 'GROK_WINDOWS_RESOURCE_ORPHANED' }] })
})

for (const [name, options] of [
  ['malformed resource plan', { malformedPlan: true }],
  ['hardlinked completion receipt', { hardlinkReceipt: true }],
]) test(`Windows Grok recovery retains a completed journal with a ${name}`, async t => {
  const f = fixture(t), journalPath = f.addJournal({ restored: true, ...options })
  assert.deepEqual(JSON.parse(JSON.stringify(await f.adapter.recoverResources())), { cleaned: 0,
    retained: [{ journalPath, code: 'GROK_WINDOWS_RESOURCE_ORPHANED' }] })
})
