'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { createWindowsAppContainerResources, resourceRoots, validatePlan } = require('../../agents/codex/workflow/windows-appcontainer-resources.js')
const controlRoot = 'C:\\controller'
const policy = { provider: 'claude', schemaVersion: 1, readOnly: false, targetPath: 'C:\\clone', scratchPath: 'C:\\scratch', readableRoots: ['C:\\clone', 'C:\\scratch'], writableRoots: ['C:\\clone', 'C:\\scratch'] }
const executableRoots = [{ path: 'C:\\runtime\\node.exe', kind: 'file' }, { path: 'C:\\controller\\command.cmd', kind: 'file' }]
const profileSid = 'S-1-15-2-1-2-3-4-5-6-7'
function harness(applyResult) {
  const events = [], records = new Map(), branded = new WeakSet()
  let applied
  const capture = {
    assertRecordParent(file) { events.push(['parent', file]); return { stat: {} } },
    publishRecordExclusive(file, bytes) { events.push(['publish', file]); if (records.has(file)) { const error = new Error('exists'); error.code = 'EEXIST'; throw error } records.set(file, Buffer.from(bytes)); return { stat: {} } },
    captureFileBytes(file) { if (!records.has(file)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error } return { content: Buffer.from(records.get(file)) } },
  }
  const invoke = request => {
    events.push([request.operation, request])
    if (request.operation === 'plan') {
      const roots = request.roots.map((root, index) => ({ ...root, identity: `12345678:${(index + 1).toString(16).padStart(16, '0')}`, creation: '132000000000000000' }))
      return { schemaVersion: 1, profileName: request.profileName, profileSid, roots,
        entries: roots.map(root => ({ identity: root.identity, creation: root.creation, label: '', directory: root.kind === 'directory', writable: root.writable, git: false, root: true })) }
    }
    if (request.operation === 'apply') {
      applied = request.plan
      assert.equal(records.size, 1, 'journal must be durable before ACL/profile side effects')
      return applyResult || { profileName: request.plan.profileName, profileSid, profilePath: 'C:\\profiles\\owned' }
    }
    assert.deepEqual(request.plan, applied, 'recovery must retain every original object identity and label')
    return { restored: applied.entries.length, newEntries: 2, deletedEntries: 0 }
  }
  const api = createWindowsAppContainerResources(() => ({ capture, invoke }))
  const verifyDrainEvidence = (evidence, binding) => branded.has(evidence) && binding.profileSid === profileSid && evidence.leaseId === binding.leaseId
  return { api, events, records, verifyDrainEvidence, options: { policy, controlRoot, executableRoots, verifyDrainEvidence }, evidence(lease) { const evidence = { leaseId: lease.recovery.leaseId }; branded.add(evidence); return evidence } }
}
test('resource scope accepts boundary metadata and grants executable files without their parents', () => {
  const roots = resourceRoots(policy, controlRoot, executableRoots)
  assert.equal(roots.length, 4)
  assert.deepEqual(roots.filter(root => root.kind === 'file'), executableRoots.map(root => ({ ...root, writable: false })))
  assert.ok(!roots.some(root => root.path === 'C:\\runtime' || root.path === controlRoot || root.path === 'C:\\'))
  assert.throws(() => resourceRoots({ ...policy, writableRoots: ['C:\\scratch'] }, controlRoot, executableRoots), { code: 'WINDOWS_RESOURCE_INVALID' })
  assert.throws(() => resourceRoots(policy, 'C:\\clone\\control', executableRoots), { code: 'WINDOWS_RESOURCE_INVALID' })
  assert.throws(() => resourceRoots(policy, controlRoot, [{ path: controlRoot, kind: 'directory' }]), { code: 'WINDOWS_RESOURCE_INVALID' })
})
test('read-only resource scope cannot relabel canonical target', () => {
  const read = { ...policy, readOnly: true, writableRoots: ['C:\\scratch'] }
  const roots = resourceRoots(read, controlRoot, executableRoots)
  assert.equal(roots.find(root => root.path === read.targetPath).writable, false)
  assert.throws(() => resourceRoots({ ...read, writableRoots: ['C:\\clone', 'C:\\scratch'] }, controlRoot, executableRoots), { code: 'WINDOWS_RESOURCE_INVALID' })
})
test('prepare journals identities before apply and release requires branded exact-lease drain', async () => {
  const h = harness(), lease = await h.api.prepareWindowsAppContainerResources(h.options)
  assert.match(lease.profileName, /^Autoprompt_[0-9a-f]{32}$/)
  assert.equal(h.events.findIndex(event => event[0] === 'publish') < h.events.findIndex(event => event[0] === 'apply'), true)
  await assert.rejects(lease.release({ drained: true, profileSid }), { code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' })
  assert.equal(h.events.filter(event => event[0] === 'restore').length, 0)
  const evidence = h.evidence(lease)
  assert.deepEqual(await lease.release(evidence), { restored: 4, newEntries: 2, deletedEntries: 0 })
  await lease.release(evidence)
  assert.equal(h.events.filter(event => event[0] === 'restore').length, 1)
  assert.ok(h.records.has(lease.recovery.journalPath + '.restored'))
})
test('recovery validates the private journal and refuses an unproven crash drain', async () => {
  const h = harness(), lease = await h.api.prepareWindowsAppContainerResources(h.options)
  const options = { controlRoot, ...lease.recovery, verifyDrainEvidence: h.verifyDrainEvidence }
  await assert.rejects(h.api.recoverWindowsAppContainerResources({ ...options, evidence: { drained: true } }), { code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' })
  await h.api.recoverWindowsAppContainerResources({ ...options, evidence: h.evidence(lease) })
  const saved = JSON.parse(h.records.get(lease.recovery.journalPath)); saved.plan.entries[0].creation = '1'
  h.records.set(lease.recovery.journalPath, Buffer.from(JSON.stringify(saved)))
  await assert.rejects(h.api.recoverWindowsAppContainerResources({ ...options, evidence: h.evidence(lease) }), { code: 'WINDOWS_RESOURCE_JOURNAL_INVALID' })
})
test('closed plans reject unknown keys, duplicated identities, and replacement roots', async () => {
  const h = harness(), lease = await h.api.prepareWindowsAppContainerResources(h.options)
  const plan = JSON.parse(h.records.get(lease.recovery.journalPath)).plan
  assert.equal(validatePlan(plan), plan)
  assert.throws(() => validatePlan({ ...plan, extra: true }), { code: 'WINDOWS_RESOURCE_INVALID' })
  assert.throws(() => validatePlan({ ...plan, entries: [...plan.entries, plan.entries[0]] }), { code: 'WINDOWS_RESOURCE_INVALID' })
  assert.throws(() => validatePlan({ ...plan, roots: [{ ...plan.roots[0], creation: '1' }, ...plan.roots.slice(1)] }), { code: 'WINDOWS_RESOURCE_INVALID' })
})

test('invalid native apply replies retain the journal recovery binding', async () => {
  const h = harness({ profileName: 'wrong', profileSid, profilePath: 'C:\\profiles\\owned' })
  let error
  try { await h.api.prepareWindowsAppContainerResources(h.options) } catch (caught) { error = caught }
  assert.equal(error.code, 'WINDOWS_RESOURCE_PROTOCOL')
  assert.equal(error.recovery.profileSid, profileSid)
  assert.ok(h.records.has(error.recovery.journalPath))
  assert.match(error.recovery.leaseId, /^[a-f0-9]{32}$/)
  const evidence = h.evidence({ recovery: error.recovery })
  await h.api.recoverWindowsAppContainerResources({ controlRoot, ...error.recovery, verifyDrainEvidence: h.verifyDrainEvidence, evidence })
})

test('completion receipt permits exact recovery after private scratch removal without another native restore', async () => {
  const h = harness(), lease = await h.api.prepareWindowsAppContainerResources(h.options)
  const evidence = h.evidence(lease)
  await lease.release(evidence)
  const count = h.events.filter(event => event[0] === 'restore').length
  await h.api.recoverWindowsAppContainerResources({ controlRoot, ...lease.recovery, verifyDrainEvidence: h.verifyDrainEvidence, evidence })
  assert.equal(h.events.filter(event => event[0] === 'restore').length, count)
  const receipt = JSON.parse(h.records.get(lease.recovery.journalPath + '.restored')); receipt.profileSid += '-9'
  h.records.set(lease.recovery.journalPath + '.restored', Buffer.from(JSON.stringify(receipt)))
  await assert.rejects(h.api.recoverWindowsAppContainerResources({ controlRoot, ...lease.recovery, verifyDrainEvidence: h.verifyDrainEvidence, evidence }), { code: 'WINDOWS_RESOURCE_JOURNAL_MISMATCH' })
})

test('Windows resource ancestry tolerates sibling writes while refusing captured mutations and ancestor replacement', { skip: process.platform !== 'win32' }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-resource-stable-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workflow = path.resolve(__dirname, '../../agents/codex/workflow')
  const script = path.join(root, 'windows-appcontainer-resources.ps1')
  fs.copyFileSync(path.join(workflow, 'windows-appcontainer-resources.ps1'), script)
  const source = fs.readFileSync(path.join(workflow, 'windows-appcontainer-resources-native.cs'), 'utf8')
  const marker = '  static void Stable(Forest forest) {'
  assert.equal(source.includes(marker), true)
  const injected = source.replace(marker, marker + `
    string mode=Environment.GetEnvironmentVariable("AUTOPROMPT_STABLE_TEST_MODE");
    string target=forest.roots[0].path; string parent=Directory.GetParent(target).FullName;
    System.Threading.Thread.Sleep(20);
    if(mode=="sibling")File.WriteAllText(Path.Combine(parent,"unrelated.tmp"),"sibling");
    if(mode=="resource")File.WriteAllText(Path.Combine(target,"changed.tmp"),"mutation");
    if(mode=="ancestor"){Directory.Move(parent,parent+"-moved");Directory.CreateDirectory(parent);Directory.CreateDirectory(target);}
`)
  fs.writeFileSync(path.join(root, 'windows-appcontainer-resources-native.cs'), injected)
  const hash = crypto.createHash('sha256').update(injected).digest('hex')
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
  for (const mode of ['sibling', 'resource', 'ancestor']) {
    const target = path.join(root, mode, 'target'); fs.mkdirSync(target, { recursive: true })
    const request = { schemaVersion: 1, operation: 'plan', profileName: 'Autoprompt_' + crypto.randomBytes(16).toString('hex'),
      roots: [{ path: target, kind: 'directory', writable: false }] }
    const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-NativeSha256', hash, '-Request'], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 120000,
      env: { ...environment, AUTOPROMPT_STABLE_TEST_MODE: mode },
    })
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '')
    const wire = JSON.parse(result.stdout)
    if (mode === 'sibling') { assert.equal(wire.status, 'PLANNED', result.stdout); assert.equal(wire.plan.entries.length, 1) }
    else { assert.equal(wire.status, 'REFUSED', result.stdout); assert.equal(wire.code, 'PREIMAGE_UNSAFE', result.stdout) }
  }
})
