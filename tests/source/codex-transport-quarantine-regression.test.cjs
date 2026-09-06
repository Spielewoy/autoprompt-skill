'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  WorkerWorkspaceManager,
  repositorySnapshot,
} = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'worker-workspace.js'))
const { stableStringify } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'event-log.js'))

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function git(repository, argv) {
  const result = spawnSync('git', ['-C', repository, ...argv], {
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

function targetRepository(t) {
  const repository = tempDirectory(t, 'autoprompt-transport-target-')
  git(repository, ['init', '-q'])
  git(repository, ['config', 'user.email', 'test@example.invalid'])
  git(repository, ['config', 'user.name', 'Autoprompt Test'])
  fs.mkdirSync(path.join(repository, 'src'))
  fs.writeFileSync(path.join(repository, 'src', 'item.js'), "module.exports = 'base'\n")
  git(repository, ['add', '.'])
  git(repository, ['commit', '-qm', 'fixture'])
  return repository
}

function assignment(workItemId, identity = 'workspace', kind = 'directory') {
  return Object.freeze({
    schemaVersion: '2.0.0',
    assignmentId: workItemId,
    requestedResult: 'Complete the assigned local change.',
    resources: Object.freeze([{
      kind, identity, access: 'write',
      owner: workItemId, ownershipMode: 'single-owner',
    }]),
    successChecklist: Object.freeze([{ id: 'success-1', description: 'The local result is complete.' }]),
    checks: Object.freeze(['Run the focused local check.']),
  })
}

function managerFor(t, target) {
  return new WorkerWorkspaceManager({
    targetRoot: target,
    privateRoot: tempDirectory(t, 'autoprompt-transport-private-'),
    environment: process.env,
    runId: 'transport-run',
    activationId: 'transport-activation',
  })
}

test('transport timeout freezes edited bytes and seeds the exact single retry without model context', t => {
  const target = targetRepository(t)
  const manager = managerFor(t, target)
  const baseAssignment = assignment('work-1')
  const retryAssignment = assignment('work-1-transport-retry-1')
  const source = manager.prepare({ assignment: baseAssignment, workItemId: 'work-1' })
  const sentinel = `module.exports = '${'x'.repeat(640 * 1024)}'\n`
  fs.writeFileSync(path.join(source.workspacePath, 'src', 'item.js'), sentinel)
  const transportReceiptHash = crypto.createHash('sha256').update('transport-receipt').digest('hex')

  const pointer = manager.quarantine(source, {
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash,
  })
  assert.equal(pointer.transportReceiptHash, transportReceiptHash)
  assert.equal(pointer.candidateHash, crypto.createHash('sha256')
    .update(stableStringify(repositorySnapshot(source.workspacePath, process.env))).digest('hex'))
  assert.ok(JSON.stringify(pointer).length < 2048)
  assert.equal(JSON.stringify(pointer).includes('x'.repeat(64)), false)
  assert.equal(Object.hasOwn(pointer, 'filesChanged'), false)
  assert.throws(
    () => manager.promote(source, { actualFilesChanged: [], after: [] }),
    error => error.code === 'WORKER_PROMOTION_INVALID',
  )

  const retry = manager.prepareFromQuarantine({
    assignment: retryAssignment,
    workItemId: 'work-1-transport-retry-1',
    quarantine: pointer,
  })
  assert.notEqual(retry.workspacePath, source.workspacePath)
  assert.equal(fs.readFileSync(path.join(retry.workspacePath, 'src', 'item.js'), 'utf8'), sentinel)
  const retryAdmission = manager.inspect(retry, { filesChanged: ['src/item.js'] })
  assert.deepEqual(retryAdmission.actualFilesChanged, ['src/item.js'])

  const reopened = manager.prepareFromQuarantine({
    assignment: retryAssignment,
    workItemId: 'work-1-transport-retry-1',
    quarantine: pointer,
  })
  assert.equal(reopened.workspaceId, retry.workspaceId, 'crash replay reopens the same one-use retry workspace')
  assert.throws(
    () => manager.prepareFromQuarantine({
      assignment: assignment('work-1-transport-retry-1-transport-retry-1'),
      workItemId: 'work-1-transport-retry-1-transport-retry-1',
      quarantine: pointer,
    }),
    error => error.code === 'WORKER_QUARANTINE_INVALID',
  )
})

test('an empty timeout candidate is discarded and the retry starts from the original base', t => {
  const target = targetRepository(t)
  const manager = managerFor(t, target)
  const source = manager.prepare({ assignment: assignment('work-1'), workItemId: 'work-1' })
  const pointer = manager.quarantine(source, {
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: 'a'.repeat(64),
  })
  assert.equal(pointer, null)
  assert.equal(fs.existsSync(source.workspacePath), false)

  const retry = manager.prepare({
    assignment: assignment('work-1-transport-retry-1'),
    workItemId: 'work-1-transport-retry-1',
  })
  assert.equal(
    fs.readFileSync(path.join(retry.workspacePath, 'src', 'item.js'), 'utf8'),
    "module.exports = 'base'\n",
  )
})

test('transport quarantine tamper fails before a retry workspace can be admitted', t => {
  const target = targetRepository(t)
  const manager = managerFor(t, target)
  const source = manager.prepare({ assignment: assignment('work-1'), workItemId: 'work-1' })
  fs.writeFileSync(path.join(source.workspacePath, 'src', 'item.js'), "module.exports = 'partial'\n")
  const pointer = manager.quarantine(source, {
    retryWorkItemId: 'work-1-transport-retry-1',
    transportReceiptHash: 'b'.repeat(64),
  })
  fs.writeFileSync(path.join(source.workspacePath, 'src', 'item.js'), "module.exports = 'tampered'\n")

  assert.throws(
    () => manager.prepareFromQuarantine({
      assignment: assignment('work-1-transport-retry-1'),
      workItemId: 'work-1-transport-retry-1',
      quarantine: pointer,
    }),
    error => error.code === 'WORKER_QUARANTINE_TAMPERED',
  )
  assert.equal(
    fs.readFileSync(path.join(target, 'src', 'item.js'), 'utf8'),
    "module.exports = 'base'\n",
    'neither quarantine nor tamper handling promotes bytes to the real target',
  )
  assert.equal(
    fs.readdirSync(path.join(path.dirname(pointer.recordPath), '..', 'records'))
      .filter(name => /^[a-f0-9]{40}\.json$/u.test(name)).length,
    1,
    'tamper rejection occurs before a retry workspace journal is created',
  )
})

test('out-of-scope and linked partial candidates are rejected without promotion', t => {
  const target = targetRepository(t)
  const manager = managerFor(t, target)
  const scopedAssignment = assignment('scoped-work', 'src/item.js', 'file')
  const source = manager.prepare({ assignment: scopedAssignment, workItemId: 'scoped-work' })
  fs.writeFileSync(path.join(source.workspacePath, 'outside.js'), 'outside\n')
  assert.throws(
    () => manager.quarantine(source, {
      retryWorkItemId: 'scoped-work-transport-retry-1',
      transportReceiptHash: 'c'.repeat(64),
    }),
    error => error.code === 'OWNERSHIP_SCOPE_VIOLATION',
  )
  assert.equal(fs.existsSync(path.join(target, 'outside.js')), false)

  fs.unlinkSync(path.join(source.workspacePath, 'outside.js'))
  fs.unlinkSync(path.join(source.workspacePath, 'src', 'item.js'))
  fs.symlinkSync(path.join(target, 'src', 'item.js'), path.join(source.workspacePath, 'src', 'item.js'))
  assert.throws(
    () => manager.quarantine(source, {
      retryWorkItemId: 'scoped-work-transport-retry-1',
      transportReceiptHash: 'd'.repeat(64),
    }),
    error => error.code === 'WORKER_WORKSPACE_UNSAFE_ENTRY',
  )
  assert.equal(
    fs.readFileSync(path.join(target, 'src', 'item.js'), 'utf8'),
    "module.exports = 'base'\n",
  )
})
