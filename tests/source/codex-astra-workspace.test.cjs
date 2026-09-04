'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { WorkerWorkspaceManager } = require('../../agents/codex/workflow/worker-workspace.js')

function fixture(t, filesystem = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-workspace-survival-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  const privateRoot = path.join(root, 'private')
  fs.mkdirSync(target)
  fs.mkdirSync(privateRoot)
  const git = args => {
    const result = childProcess.spawnSync('git', ['-C', target, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  git(['init', '-b', 'fixture'])
  git(['config', 'user.email', 'fixture@example.invalid'])
  git(['config', 'user.name', 'Fixture'])
  fs.writeFileSync(path.join(target, 'input.txt'), 'unchanged input\n')
  git(['add', 'input.txt'])
  git(['commit', '-m', 'fixture'])
  const manager = new WorkerWorkspaceManager({
    targetRoot: target, privateRoot, fsImpl: filesystem,
    runId: 'survival-run', activationId: 'survival-activation',
  })
  const session = manager.prepare({
    workItemId: 'work-1',
    assignment: { resources: [{ kind: 'directory', identity: '.', access: 'write' }] },
  })
  fs.writeFileSync(path.join(session.workspacePath, 'output.txt'), 'recoverable product\n')
  const admission = () => manager.inspect(session, { filesChanged: ['output.txt'] })
  return { target, privateRoot, manager, session, admission }
}

test('quarantined product can be preserved after its transport retry becomes unavailable', t => {
  const f = fixture(t)
  const admission = f.admission()
  f.manager.quarantine(f.session, {
    admission, retryWorkItemId: 'work-1-transport-retry-1', transportReceiptHash: 'a'.repeat(64),
  })
  const preserved = f.manager.preserveCandidate(f.session, { admission, reasonCode: 'TRANSPORT_UNAVAILABLE' })
  assert.equal(fs.readFileSync(path.join(preserved.candidateRoot, 'output.txt'), 'utf8'), 'recoverable product\n')
  assert.deepEqual(f.manager.preserveCandidate(f.session, { admission, reasonCode: 'TRANSPORT_UNAVAILABLE' }), preserved)
  assert.equal(fs.readFileSync(path.join(f.target, 'input.txt'), 'utf8'), 'unchanged input\n')
})

test('candidate preservation resumes a failed copy without losing or recopying complete product bytes', t => {
  let interrupted = false
  let copies = 0
  const filesystem = Object.create(fs)
  filesystem.copyFileSync = (source, destination, flags) => {
    fs.copyFileSync(source, destination, flags)
    if (String(destination).includes(`${path.sep}candidate-survivals${path.sep}`)) {
      copies += 1
      if (!interrupted) {
        interrupted = true
        throw Object.assign(new Error('interrupted after physical copy'), { code: 'EIO' })
      }
    }
  }
  const f = fixture(t, filesystem)
  const admission = f.admission()
  assert.throws(() => f.manager.preserveCandidate(f.session, { admission }), { code: 'EIO' })
  const preserved = f.manager.preserveCandidate(f.session, { admission })
  assert.equal(copies, 1, 'the exact surviving copy must be adopted')
  assert.equal(fs.readFileSync(path.join(preserved.candidateRoot, 'output.txt'), 'utf8'), 'recoverable product\n')
})

test('candidate preservation retains executable permissions despite a restrictive umask', {
  skip: process.platform === 'win32',
}, t => {
  const f = fixture(t)
  fs.chmodSync(path.join(f.session.workspacePath, 'output.txt'), 0o775)
  const admission = f.admission()
  const previousMask = process.umask(0o077)
  try {
    const preserved = f.manager.preserveCandidate(f.session, { admission })
    assert.equal(fs.statSync(path.join(preserved.candidateRoot, 'output.txt')).mode & 0o777, 0o775)
  } finally {
    process.umask(previousMask)
  }
})

test('candidate preservation rejects a replaced partial copy without overwriting it', t => {
  let failedDestination
  const filesystem = Object.create(fs)
  filesystem.copyFileSync = (source, destination, flags) => {
    fs.copyFileSync(source, destination, flags)
    if (!failedDestination && String(destination).includes(`${path.sep}candidate-survivals${path.sep}`)) {
      failedDestination = destination
      throw Object.assign(new Error('interrupted copy'), { code: 'EIO' })
    }
  }
  const f = fixture(t, filesystem)
  const admission = f.admission()
  assert.throws(() => f.manager.preserveCandidate(f.session, { admission }), { code: 'EIO' })
  fs.writeFileSync(failedDestination, 'foreign bytes\n')
  assert.throws(() => f.manager.preserveCandidate(f.session, { admission }), error =>
    ['WORKER_SURVIVAL_TAMPERED', 'WORKER_SURVIVAL_INVALID'].includes(error.code))
  assert.equal(fs.readFileSync(failedDestination, 'utf8'), 'foreign bytes\n')
})
