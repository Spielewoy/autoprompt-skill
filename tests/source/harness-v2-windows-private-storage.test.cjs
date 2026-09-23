'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createCheckerScratchFactory } = require('../../agents/codex/workflow/phase-budget.js')
const { atomicWriteJson, readChecksummedJson, sha256, stableStringify } = require('../../agents/codex/workflow/event-log.js')
const { CleanupRegistry } = require('../../agents/codex/workflow/finalizer.js')
const { ensureWindowsPrivateAcl, auditPrivatePermissions } = require('../../agents/codex/workflow/safe-run-root.js')
const {
  createWindowsGitRootValidator,
  resolveWorkerWorkspaceRoot,
} = require('../../agents/codex/workflow/windows-checker-root.js')
const {
  retainWorkerWorkspaceForRecovery,
  WorkerWorkspaceManager,
} = require('../../agents/codex/workflow/worker-workspace.js')

test('native Windows controller scratch has protected ownership and rejects inherited permissions on reuse', { skip: process.platform !== 'win32', timeout: 180000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-checker-private-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // This fresh owned fixture deliberately starts with an explicit foreign
  // grant. Disabling inheritance and replacing only user/SYSTEM entries
  // would leave it behind, so the production helper must replace the DACL.
  const addForeignGrant = item => {
    const grant = cp.spawnSync('icacls.exe', [item, '/grant', '*S-1-1-0:R'], { encoding: 'utf8', timeout: 30000 })
    assert.ifError(grant.error)
    assert.equal(grant.status, 0, grant.stderr || grant.stdout)
  }
  addForeignGrant(root)
  ensureWindowsPrivateAcl(root)
  assert.equal(auditPrivatePermissions(root, { recurse: false }).valid, true)
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
  addForeignGrant(file)
  assert.throws(() => auditPrivatePermissions(file), { code: 'PRIVACY_VIOLATION' })
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
    const environment = { ...process.env, AUTOPROMPT_WORKER_ACL_PATH: file }
    // The CI shell can export PowerShell Core's module path. Windows
    // PowerShell must discover its own Microsoft.PowerShell.Security module.
    for (const key of Object.keys(environment)) if (key.toLowerCase() === 'psmodulepath') delete environment[key]
    const result = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop";[Console]::Out.Write((Get-Acl -LiteralPath $env:AUTOPROMPT_WORKER_ACL_PATH).Sddl)'], {
      encoding: 'utf8', timeout: 30000, env: environment,
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

test('native Windows worker clone uses short registered storage and cleanup retains only recoverable journals', { skip: process.platform !== 'win32', timeout: 180000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-external-')))
  const target = path.join(root, 'user-project')
  fs.mkdirSync(target)
  const git = argv => {
    const result = cp.spawnSync('git', ['-C', target, ...argv], { encoding: 'utf8', timeout: 30000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  git(['init', '-b', 'fixture'])
  git(['config', 'user.email', 'fixture@example.invalid'])
  git(['config', 'user.name', 'Fixture'])
  fs.writeFileSync(path.join(target, 'input.txt'), 'original project bytes\n')
  git(['add', 'input.txt']); git(['commit', '-m', 'fixture'])

  let activationRoot = root
  for (let index = 0; index < 6; index += 1) {
    activationRoot = path.join(activationRoot, `${index}-${'deep-activation-segment-'.repeat(2)}`)
  }
  fs.mkdirSync(activationRoot, { recursive: true })
  activationRoot = fs.realpathSync.native(activationRoot)
  assert.ok(activationRoot.length > 300, `fixture activation path was only ${activationRoot.length} characters`)
  const fakeHome = path.join(activationRoot, 'fake-home')
  fs.mkdirSync(fakeHome)
  const environment = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
  }
  const registryDirectory = path.join(activationRoot, 'cleanup')
  fs.mkdirSync(registryDirectory)
  const activationId = 'native-worker-external-activation'
  let manager = null
  const native = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemCapture()
  const runtimeFs = Object.assign(Object.create(fs), {
    windowsCapture: native,
    windowsMutations: native,
  })
  const cleanupRegistry = new CleanupRegistry({
    registryPath: path.join(registryDirectory, 'registry.json'),
    allowedRoots: [activationRoot],
    controlBinding: { activationId, generationId: 1 },
    externalRootValidator: createWindowsGitRootValidator({ owner: activationId }),
    fsImpl: runtimeFs,
    retainEntry: entry => entry.kind === 'worker-workspace'
      ? manager.retainWorkspaceForRecovery(entry) : false,
  })
  const workspaceRoot = resolveWorkerWorkspaceRoot({
    workspaceRoot: path.join(activationRoot, 'worker-workspaces', 'workspaces'),
    cleanupRegistry,
    owner: activationId,
  })
  let session = null
  t.after(() => {
    try {
      if (session && fs.existsSync(session.recordPath)) manager.abort(session)
    } catch {}
    try { cleanupRegistry.run() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })

  const managerOptions = {
    targetRoot: target,
    privateRoot: path.join(activationRoot, 'worker-workspaces'),
    workspaceRoot,
    cleanupRegistry,
    environment,
    runId: activationId,
    activationId,
    hardenWorkspace: clone => ({ accepted: auditPrivatePermissions(clone).valid }),
  }
  manager = new WorkerWorkspaceManager(managerOptions)
  const request = {
    workItemId: 'work-1',
    assignment: { resources: [{ kind: 'directory', identity: '.', access: 'write' }] },
  }
  session = manager.prepare(request)
  assert.equal(path.dirname(session.workspacePath).toLowerCase(), workspaceRoot.toLowerCase())
  assert.match(path.basename(session.workspacePath), /^[a-f0-9]{40}$/)
  assert.ok(path.join(session.workspacePath, '.git').length < 260)
  assert.equal(auditPrivatePermissions(session.workspacePath).valid, true)
  const registered = cleanupRegistry.load().entries.find(entry => entry.path.toLowerCase() === session.workspacePath.toLowerCase())
  assert.equal(registered.kind, 'worker-workspace')
  assert.equal(registered.owner, session.workspaceId)

  const preparedIdentity = fs.lstatSync(session.workspacePath, { bigint: true })
  manager = new WorkerWorkspaceManager(managerOptions)
  session = manager.prepare(request)
  const reopenedIdentity = fs.lstatSync(session.workspacePath, { bigint: true })
  assert.equal(reopenedIdentity.dev, preparedIdentity.dev)
  assert.equal(reopenedIdentity.ino, preparedIdentity.ino)

  const originalSpawnSync = cp.spawnSync
  cp.spawnSync = (command, ...args) => {
    if (path.basename(String(command)).toLowerCase().startsWith('git')) {
      throw new Error('authority-only retention unexpectedly started Git')
    }
    return originalSpawnSync(command, ...args)
  }
  try {
    assert.equal(retainWorkerWorkspaceForRecovery({
      targetRoot: target,
      privateRoot: managerOptions.privateRoot,
      workspaceRoot,
      cleanupRegistry,
      runId: activationId,
      activationId,
      // Retention deliberately has no environment or expiring proof input.
      environment: null,
      enforcementProof: null,
      activationExpiresAt: '2000-01-01T00:00:00.000Z',
    }, registered), true)
  } finally {
    cp.spawnSync = originalSpawnSync
  }

  const preparedRecord = readChecksummedJson(session.recordPath)
  try {
    const foreignBinding = { ...preparedRecord.binding, workspaceId: 'a'.repeat(40) }
    foreignBinding.bindingHash = sha256(stableStringify({
      schemaVersion: foreignBinding.schemaVersion,
      workspaceId: foreignBinding.workspaceId,
      assignmentHash: foreignBinding.assignmentHash,
      targetSnapshotHash: foreignBinding.targetSnapshotHash,
    }))
    atomicWriteJson(session.recordPath, { ...preparedRecord, binding: foreignBinding })
    assert.throws(() => cleanupRegistry.run(), { code: 'WORKER_WORKSPACE_RECOVERY_FAILED' })
    assert.equal(fs.existsSync(session.workspacePath), true)
    atomicWriteJson(session.recordPath, { ...preparedRecord, status: 'UNKNOWN_TEST_STATE' })
    assert.throws(() => cleanupRegistry.run(), { code: 'WORKER_WORKSPACE_RECOVERY_FAILED' })
    assert.equal(fs.existsSync(session.workspacePath), true)
    fs.writeFileSync(session.recordPath, '{"truncated":')
    assert.throws(() => cleanupRegistry.run())
    assert.equal(fs.existsSync(session.workspacePath), true)
  } finally {
    atomicWriteJson(session.recordPath, preparedRecord)
  }

  const failedPrepareId = 'f'.repeat(40)
  const failedPreparePath = path.join(workspaceRoot, failedPrepareId)
  fs.mkdirSync(failedPreparePath)
  ensureWindowsPrivateAcl(failedPreparePath)
  cleanupRegistry.register({ path: failedPreparePath, kind: 'worker-workspace', owner: failedPrepareId })

  cleanupRegistry.run()
  assert.equal(fs.existsSync(session.workspacePath), true, 'PREPARED workspace must survive generic cleanup')
  assert.equal(fs.existsSync(failedPreparePath), false, 'failed prepare without a journal must be retired')
  assert.equal(fs.existsSync(workspaceRoot), true, 'external root must survive with a recoverable workspace')

  const childScript = [
    "const fs=require('node:fs')",
    'const [workerFile,finalizerFile,rootFile,target,privateRoot,workspaceRoot,registryPath,activationRoot,activationId,requestText]=process.argv.slice(1)',
    'const {WorkerWorkspaceManager}=require(workerFile)',
    'const {CleanupRegistry}=require(finalizerFile)',
    'const {createWindowsGitRootValidator}=require(rootFile)',
    "const native=require(require('node:path').join(require('node:path').dirname(rootFile),'windows-filesystem.js')).createWindowsFilesystemCapture()",
    'const runtimeFs=Object.assign(Object.create(fs),{windowsCapture:native,windowsMutations:native})',
    'const cleanupRegistry=new CleanupRegistry({registryPath,allowedRoots:[activationRoot],controlBinding:{activationId,generationId:1},externalRootValidator:createWindowsGitRootValidator({owner:activationId}),fsImpl:runtimeFs})',
    'const manager=new WorkerWorkspaceManager({targetRoot:target,privateRoot,workspaceRoot,cleanupRegistry,environment:process.env,runId:activationId,activationId,afterPromotionStep(){process.exit(77)}})',
    'const request=JSON.parse(requestText)',
    'const session=manager.prepare(request)',
    "fs.writeFileSync(require('node:path').join(session.workspacePath,'input.txt'),'crash postimage\\n')",
    "const admission=manager.inspect(session,{filesChanged:['input.txt']})",
    'manager.promote(session,admission)',
  ].join(';')
  const crashed = cp.spawnSync(process.execPath, [
    '-e', childScript,
    path.resolve(__dirname, '../../agents/codex/workflow/worker-workspace.js'),
    path.resolve(__dirname, '../../agents/codex/workflow/finalizer.js'),
    path.resolve(__dirname, '../../agents/codex/workflow/windows-checker-root.js'),
    target, managerOptions.privateRoot, workspaceRoot, path.join(registryDirectory, 'registry.json'),
    activationRoot, activationId, JSON.stringify(request),
  ], { encoding: 'utf8', windowsHide: true, env: environment, timeout: 60000 })
  assert.ifError(crashed.error)
  assert.equal(crashed.status, 77, crashed.stderr || crashed.stdout)
  const guardianDeadline = Date.now() + 20_000
  let guardianRecord = null
  while (Date.now() < guardianDeadline) {
    try { guardianRecord = readChecksummedJson(session.recordPath) } catch {}
    if (guardianRecord?.status === 'ROLLED_BACK' && guardianRecord.guardianOutcome === 'ROLLED_BACK' &&
        fs.readFileSync(path.join(target, 'input.txt'), 'utf8') === 'original project bytes\n') break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
  assert.equal(guardianRecord?.status, 'ROLLED_BACK')
  assert.equal(guardianRecord?.guardianOutcome, 'ROLLED_BACK')
  assert.equal(fs.readFileSync(path.join(target, 'input.txt'), 'utf8'), 'original project bytes\n')
  manager = new WorkerWorkspaceManager(managerOptions)
  session = manager.prepare(request)

  manager.abort(session)
  const capture = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemCapture()
  const interrupted = capture.removeOwnedTarget(
    session.workspacePath, registered.parentIdentity, registered.targetIdentity,
  )
  assert.equal(interrupted.removed, true)
  assert.equal(fs.existsSync(session.workspacePath), false)
  cleanupRegistry.run()
  assert.equal(fs.existsSync(session.workspacePath), false, 'ABORTED workspace must be retired by identity-bound cleanup')
  assert.equal(fs.existsSync(workspaceRoot), false, 'empty registered external root must be retired')
  session = null
})
