'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const sourcePath = path.resolve(__dirname, '../../agents/codex/workflow/windows-checker-root.js')

function fixture(overrides = {}) {
  const activationId = `apv2-${'1'.repeat(32)}`
  const activationRoot = 'C:\\private\\activation'
  const runPath = `${activationRoot}\\r\\runs\\${activationId}`
  const rootPath = 'C:\\Users\\Owner\\AppData\\Local\\ap-git-Ab12Cd'
  const leaf = `${'a'.repeat(64)}-${'b'.repeat(16)}`
  const candidate = `${rootPath}\\${leaf}`
  const metadata = {
    run_id: activationId, run_path: runPath, target_path: 'C:\\project', target_identity: 'target-id',
    provider_id: 'codex', local_only: true, automatic_export_allowed: false,
    runtime_authority: { cleanup_registry: 'cleanup/registry.json' },
  }
  const metadataBytes = Buffer.from(JSON.stringify(metadata))
  const metadataSha256 = crypto.createHash('sha256').update(metadataBytes).digest('hex')
  const root = {
    id: 'windows-checker-snapshots', kind: 'windows-checker-snapshots', owner: activationId,
    path: rootPath, status: 'REGISTERED', targetIdentity: { type: 'directory', dev: '1', ino: '2' },
  }
  const entry = {
    status: 'REGISTERED', kind: 'checker-snapshot', path: candidate,
    parentIdentity: { dev: '1', ino: '2' }, targetIdentity: { type: 'directory', dev: '1', ino: '3' },
  }
  return {
    activationId, activationRoot, runPath, rootPath, candidate, metadataBytes, metadataSha256,
    record: {
      schemaVersion: 2, providerId: 'codex', status: 'active', activationId, activationRoot,
      target: { realpath: 'C:\\project' }, capability: { generation: 4, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      supervisorRuntime: { runPath, runId: activationId, metadataSha256, targetIdentity: 'target-id' },
    },
    root, registry: { activationId, generationId: 4, entries: [entry] },
    live: { parentIdentity: { ...entry.parentIdentity }, targetIdentity: { ...entry.targetIdentity } },
    ...overrides,
  }
}

function loadVerifier(state, method = 'verifyRegisteredGitWorkspace') {
  class RunRecordError extends Error {
    constructor(code, message) { super(message); this.code = code }
  }
  const winPath = path.win32
  const metadataPath = winPath.join(state.runPath, 'metadata.json')
  const digestPath = winPath.join(state.runPath, 'metadata.sha256')
  const registryPath = winPath.join(state.runPath, 'cleanup', 'registry.json')
  const registryBytes = Buffer.from('{"fixture":"stable"}')
  const fileSystem = {
    realpathSync: { native: filename => winPath.resolve(filename) },
    existsSync: () => true,
    readFileSync: () => { throw new Error('unexpected ambient read') },
  }
  const safeRunRoot = {
    RunRecordError,
    inspectPathNoFollow(filename) {
      const absolute = winPath.resolve(filename)
      if (absolute.toLowerCase() === 'c:\\users\\owner\\appdata\\local') return { exists: true, realpath: 'C:\\Users\\Owner\\AppData\\Local' }
      if (absolute.toLowerCase() === state.rootPath.toLowerCase()) return { exists: true, realpath: state.rootPath }
      return { exists: true, realpath: absolute }
    },
    auditPrivatePermissions() { state.audits = (state.audits || 0) + 1 },
    createWindowsCompilerDirectory() { throw new Error('allocation is not part of verification') },
    pathIsInside(parent, child) {
      const relative = winPath.relative(parent, child)
      return relative !== '' && !winPath.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${winPath.sep}`)
    },
    readFileNoFollow(filename) {
      const absolute = winPath.resolve(filename).toLowerCase()
      if (absolute === metadataPath.toLowerCase()) return Buffer.from(state.metadataBytes)
      if (absolute === digestPath.toLowerCase()) return Buffer.from(`${state.metadataSha256}\n`)
      if (absolute === registryPath.toLowerCase()) {
        if (state.registryLinked) throw new RunRecordError('RUN_RECORD_UNSAFE', 'linked registry')
        return Buffer.from(registryBytes)
      }
      throw new RunRecordError('RUN_RECORD_UNSAFE', `unexpected file ${filename}`)
    },
  }
  class CleanupRegistry {
    constructor(options) {
      this.options = options
      if (state.registry.generationId !== options.controlBinding.generationId ||
          state.registry.activationId !== options.controlBinding.activationId) {
        throw new RunRecordError('CLEANUP_CONTROL_BINDING_MISMATCH', 'stale registry')
      }
      assert.equal(options.fsImpl.readFileSync(registryPath, 'utf8'), registryBytes.toString())
      assert.equal(options.fsImpl.readFileSync(registryPath, 'utf8'), registryBytes.toString())
    }
    getExternalRoot(id) {
      if (!state.root || state.root.id !== id || state.root.status !== 'REGISTERED') return null
      this.options.externalRootValidator(state.root, 'use')
      return state.root
    }
    load() { return state.registry }
  }
  const capture = { inspectOwnedTarget: () => state.live }
  const module = { exports: {} }
  const context = vm.createContext({ Buffer, console, process: { platform: 'win32' }, require: name => {
    if (name === 'node:crypto') return crypto
    if (name === 'node:fs') return fileSystem
    if (name === 'node:os') return { userInfo: () => ({ homedir: 'C:\\Users\\Owner' }) }
    if (name === 'node:path') return winPath
    if (name === './safe-run-root.js') return safeRunRoot
    if (name === './finalizer.js') return { CleanupRegistry }
    if (name === './windows-filesystem.js') return { createWindowsFilesystemCapture: () => capture }
    throw new Error(`unexpected require ${name}`)
  }, module, exports: module.exports, __filename: sourcePath, __dirname: path.dirname(sourcePath) })
  const wrapper = new vm.Script(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(sourcePath, 'utf8')}\n})`, { filename: sourcePath })
  wrapper.runInContext(context)(context.require, module, module.exports, sourcePath, path.dirname(sourcePath))
  return module.exports[method]
}

function refused(state, candidate = state.candidate) {
  const verify = loadVerifier(state)
  assert.throws(() => verify({ record: state.record, candidate }), error =>
    ['SNAPSHOT_ROOT_UNSAFE', 'CLEANUP_CONTROL_BINDING_MISMATCH',
      'CLEANUP_EXTERNAL_ROOT_UNSAFE', 'RUN_RECORD_UNSAFE'].includes(error?.code))
}

test('registered checker snapshot proof accepts only the exact live durable child', () => {
  const state = fixture()
  assert.equal(loadVerifier(state)({ record: state.record, candidate: state.candidate }), true)
  assert.equal(state.audits, 2)
})

test('registered checker snapshot proof rejects stale, cleaned, foreign, or changed authority', () => {
  const stale = fixture(); stale.registry.generationId = 3; refused(stale)
  const foreignRegistry = fixture(); foreignRegistry.registry.activationId = 'foreign-activation'; refused(foreignRegistry)
  const expired = fixture(); expired.record.capability.expiresAt = new Date(Date.now() - 1).toISOString(); refused(expired)
  const cleanedRoot = fixture(); cleanedRoot.root.status = 'CLEANED'; refused(cleanedRoot)
  const cleanedChild = fixture(); cleanedChild.registry.entries[0].status = 'CLEANED'; refused(cleanedChild)
  const foreign = fixture(); foreign.root.owner = 'foreign-activation'; refused(foreign)
  const outside = fixture(); outside.root.path = 'C:\\foreign\\ap-git-Ab12Cd'; refused(outside)
  const wrongKind = fixture(); wrongKind.registry.entries[0].kind = 'scratch'; refused(wrongKind)
  const wrongParent = fixture(); wrongParent.registry.entries[0].parentIdentity.ino = '9'; refused(wrongParent)
  const wrongTarget = fixture(); wrongTarget.live.targetIdentity.ino = '9'; refused(wrongTarget)
  const fileTarget = fixture(); fileTarget.live.targetIdentity.type = 'file'; refused(fileTarget)
  const linkedRegistry = fixture(); linkedRegistry.registryLinked = true; refused(linkedRegistry)
})

test('registered checker snapshot proof rejects sibling and grandchild path shapes', () => {
  const sibling = fixture()
  refused(sibling, `${sibling.rootPath}\\${'c'.repeat(64)}-${'d'.repeat(16)}`)
  const grandchild = fixture()
  refused(grandchild, `${grandchild.candidate}\\child`)
})

function workerFixture() {
  const state = fixture()
  state.rootPath = 'C:\\Users\\Owner\\AppData\\Local\\ap-work-Ab12Cd'
  state.candidate = `${state.rootPath}\\${'a'.repeat(40)}`
  Object.assign(state.root, { id: 'windows-worker-workspaces', kind: 'windows-worker-workspaces', path: state.rootPath })
  Object.assign(state.registry.entries[0], { kind: 'worker-workspace', owner: 'a'.repeat(40), path: state.candidate })
  return state
}

test('registered worker proof admits only its exact live activation-owned clone', () => {
  const state = workerFixture()
  assert.equal(loadVerifier(state)({ record: state.record, candidate: state.candidate }), true)
  assert.throws(() => loadVerifier(state, 'verifyRegisteredCheckerSnapshot')({ record: state.record, candidate: state.candidate }),
    error => error.code === 'SNAPSHOT_ROOT_UNSAFE')
})

test('registered worker proof rejects stale, retired, foreign, replaced, and misclassified clones', () => {
  for (const mutate of [
    state => { state.registry.generationId-- },
    state => { state.root.status = 'CLEANED' },
    state => { state.registry.entries[0].status = 'CLEANED' },
    state => { state.root.owner = 'foreign' },
    state => { state.root.kind = 'windows-checker-snapshots' },
    state => { state.registry.entries[0].owner = 'foreign' },
    state => { state.registry.entries[0].kind = 'checker-snapshot' },
    state => { state.registry.entries[0].parentIdentity.ino = '99' },
    state => { state.live.targetIdentity.ino = '99' },
    state => { state.live.targetIdentity.type = 'file' },
    state => { state.registryLinked = true },
    state => { state.record.capability.expiresAt = new Date(Date.now() - 1).toISOString() },
  ]) { const state = workerFixture(); mutate(state); refused(state) }
  const sibling = workerFixture(); refused(sibling, `${sibling.rootPath}\\${'c'.repeat(40)}`)
  const grandchild = workerFixture(); refused(grandchild, `${grandchild.candidate}\\child`)
})
