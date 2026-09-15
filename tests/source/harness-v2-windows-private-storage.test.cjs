'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createCheckerScratchFactory } = require('../../agents/codex/workflow/phase-budget.js')
const { ensureWindowsPrivateAcl, auditPrivatePermissions } = require('../../agents/codex/workflow/safe-run-root.js')

test('native Windows controller scratch has protected ownership and rejects inherited permissions on reuse', { skip: process.platform !== 'win32', timeout: 180000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-checker-private-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  ensureWindowsPrivateAcl(root)
  const target = path.join(root, 'target'), frozen = path.join(root, 'frozen')
  fs.mkdirSync(target); fs.mkdirSync(frozen)
  const entries = []
  const cleanupRegistry = {
    register(entry) { entries.push({ ...entry, status: 'REGISTERED' }) },
    load() { return { entries } },
  }
  const options = { scratchRoot: path.join(root, 'authority'), targetPath: target, runId: 'native-private-scratch', cleanupRegistry }
  const factory = createCheckerScratchFactory(options)
  const candidateHash = 'a'.repeat(64)
  const boundary = factory('checker', frozen, { candidateHash })
  assert.equal(auditPrivatePermissions(options.scratchRoot).valid, true)
  assert.equal(auditPrivatePermissions(boundary.writableScratchRoot).valid, true)
  assert.equal(factory.verify({ checkerScratchBoundary: boundary, sandboxAssignment: { checkerId: 'checker' },
    candidateHash, canonicalTargetPath: frozen, workingDirectory: boundary.writableScratchRoot }), boundary)
  const file = path.join(boundary.writableScratchRoot, 'private-file')
  fs.writeFileSync(file, 'private contents')
  ensureWindowsPrivateAcl(file)
  assert.equal(auditPrivatePermissions(file).valid, true)
  fs.appendFileSync(file, '\nstill writable')
  assert.equal(fs.readFileSync(file, 'utf8'), 'private contents\nstill writable')

  const changed = cp.spawnSync('icacls.exe', [options.scratchRoot, '/inheritance:e'], { encoding: 'utf8', timeout: 30000 })
  assert.ifError(changed.error)
  assert.equal(changed.status, 0, changed.stderr || changed.stdout)
  assert.throws(() => createCheckerScratchFactory(options), { code: 'CHECKER_SCRATCH_UNAVAILABLE' })
})

test('native Windows worker clone is privately writable without relabeling the source or an occupied clone', { skip: process.platform !== 'win32', timeout: 180000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-private-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'user-project'), controller = path.join(root, 'controller')
  fs.mkdirSync(target); fs.mkdirSync(controller)
  ensureWindowsPrivateAcl(controller)
  const git = argv => {
    const result = cp.spawnSync('git', ['-C', target, ...argv], { encoding: 'utf8', timeout: 30000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  const security = file => {
    const result = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::Out.Write((Get-Acl -LiteralPath $env:AUTOPROMPT_WORKER_ACL_PATH).Sddl)'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, AUTOPROMPT_WORKER_ACL_PATH: file },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return result.stdout
  }
  git(['init', '-b', 'fixture'])
  git(['config', 'user.email', 'fixture@example.invalid'])
  git(['config', 'user.name', 'Fixture'])
  fs.writeFileSync(path.join(target, 'input.txt'), 'original project bytes\n')
  git(['add', 'input.txt']); git(['commit', '-m', 'fixture'])
  const originalSecurity = security(target)
  const { WorkerWorkspaceManager } = require('../../agents/codex/workflow/worker-workspace.js')
  const manager = new WorkerWorkspaceManager({ targetRoot: target, privateRoot: path.join(controller, 'workers'),
    runId: 'native-worker-run', activationId: 'native-worker-activation' })
  const request = { workItemId: 'work-1', assignment: { resources: [{ kind: 'directory', identity: '.', access: 'write' }] } }
  const session = manager.prepare(request)
  assert.equal(auditPrivatePermissions(session.workspacePath).valid, true)
  const capture = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemCapture()
  assert.equal(capture.assertRecordParent(path.join(session.workspacePath, 'native-parent-check')).stat.ino,
    String(fs.lstatSync(session.workspacePath, { bigint: true }).ino))
  fs.writeFileSync(path.join(session.workspacePath, 'input.txt'), 'worker-only edit\n')
  assert.equal(fs.readFileSync(path.join(target, 'input.txt'), 'utf8'), 'original project bytes\n')
  assert.equal(security(target), originalSecurity, 'the real user project ACL must not be changed')

  // No receipt means this existing destination is not a prepared workspace.
  // A retry must refuse it, even when it is empty and Git could reuse it.
  fs.unlinkSync(session.recordPath)
  fs.rmSync(session.workspacePath, { recursive: true, force: true })
  fs.mkdirSync(session.workspacePath)
  const occupiedSecurity = security(session.workspacePath)
  assert.throws(() => manager.prepare(request), { code: 'WORKER_ISOLATION_UNSUPPORTED' })
  assert.equal(security(session.workspacePath), occupiedSecurity)
  assert.deepEqual(fs.readdirSync(session.workspacePath), [])
  assert.equal(security(target), originalSecurity)
})
