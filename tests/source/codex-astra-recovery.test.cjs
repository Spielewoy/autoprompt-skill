'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const workflow = path.resolve(__dirname, '../../agents/codex/workflow')
const runRecord = require(path.join(workflow, 'run-record.js'))
const { Finalizer } = require(path.join(workflow, 'finalizer.js'))
const { atomicWriteJson, sha256 } = require(path.join(workflow, 'event-log.js'))

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-astra-recovery-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const project = path.join(directory, 'project')
  fs.mkdirSync(project)
  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    exactTree: true,
    runId: 'astra-publication-recovery-run',
    assertStartBoundary: false,
  })
  return { directory, record }
}

function finalizer(record) {
  return new Finalizer({
    stateStore: { registeredPaths: record.paths.stateStore.paths },
    processOwner: {}, missionLock: {}, capability: {}, cleanupRegistry: {},
  })
}

function crashTerminalPublication(record, boundary) {
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs')
    const { Finalizer } = require(process.argv[1])
    const input = JSON.parse(process.argv[2])
    const fsImpl = Object.create(fs)
    fsImpl.linkSync = (source, destination) => {
      if (input.boundary === 'after-link') fs.linkSync(source, destination)
      process.exit(75)
    }
    new Finalizer({
      stateStore: { registeredPaths: input.paths },
      processOwner: {}, missionLock: {}, capability: {}, cleanupRegistry: {}, fsImpl,
    })._createOrVerifyTerminal(input.terminal)
  `, path.join(workflow, 'finalizer.js'), JSON.stringify({
    paths: record.paths.stateStore.paths,
    boundary,
    terminal: { schemaVersion: 2, runId: record.runId, outcome: 'PARTIAL' },
  })], { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 75, child.stderr)
  return child.pid
}

for (const boundary of ['before-link', 'after-link']) {
  test(`a real ${boundary} terminal publication crash remains reopenable`, t => {
    const { record } = fixture(t)
    crashTerminalPublication(record, boundary)
    const terminalPath = record.paths.terminalPath
    const published = boundary === 'after-link' ? fs.readFileSync(terminalPath) : null
    if (published) assert.equal(fs.lstatSync(terminalPath).nlink, 2)
    const reopened = runRecord.openRunRecord(record.runPath)
    assert.equal(reopened.runId, record.runId)
    const saved = finalizer(reopened)._createOrVerifyTerminal({
      schemaVersion: 2, runId: record.runId, outcome: 'PARTIAL',
    })
    assert.equal(finalizer(reopened)._readTerminalRecord().checksum, saved.checksum)
    assert.equal(fs.lstatSync(terminalPath).nlink, 1)
    if (published) assert.deepEqual(fs.readFileSync(terminalPath), published)
    assert.equal(fs.readdirSync(path.dirname(terminalPath)).some(name => name.endsWith('.create')), false)
  })
}

test('terminal retry reconciles a dead publisher without reopening the run record', t => {
  const { record } = fixture(t)
  crashTerminalPublication(record, 'after-link')
  const saved = finalizer(record)._createOrVerifyTerminal({
    schemaVersion: 2, runId: record.runId, outcome: 'PARTIAL',
  })
  assert.equal(finalizer(record)._readTerminalRecord().checksum, saved.checksum)
})

test('terminal recovery refuses a live writer and ambiguous extra hard links', t => {
  const { record, directory } = fixture(t)
  const terminalPath = record.paths.terminalPath
  const terminal = { schemaVersion: 2, runId: record.runId, outcome: 'PARTIAL' }
  finalizer(record)._createOrVerifyTerminal(terminal)
  const liveResidue = path.join(path.dirname(terminalPath), `.terminal.json.${process.pid}.${'a'.repeat(16)}.create`)
  fs.linkSync(terminalPath, liveResidue)
  assert.throws(() => runRecord.openRunRecord(record.runPath), error => error.code === 'RUN_RECORD_BUSY')
  assert.equal(fs.existsSync(liveResidue), true)
  fs.unlinkSync(liveResidue)
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.equal(dead.status, 0)
  const deadResidue = path.join(path.dirname(terminalPath), `.terminal.json.${dead.pid}.${'b'.repeat(16)}.create`)
  fs.linkSync(terminalPath, deadResidue)
  const foreignLink = path.join(directory, 'foreign-terminal-link')
  fs.linkSync(terminalPath, foreignLink)
  const before = fs.readFileSync(terminalPath)
  assert.throws(() => runRecord.openRunRecord(record.runPath), error => error.code === 'RUN_RECORD_UNSAFE')
  assert.deepEqual(fs.readFileSync(terminalPath), before)
  assert.equal(fs.existsSync(deadResidue), true)
  assert.equal(fs.existsSync(foreignLink), true)
})

test('a state atomic-write crash preserves the previous state and permits reopening', t => {
  const { record } = fixture(t)
  const statePath = record.paths.stateStore.paths.statePath
  record.write('runtime/state.json', '{"prior":"durable"}\n')
  const before = fs.readFileSync(statePath)
  const child = spawnSync(process.execPath, ['-e', `
    const { atomicWriteJson } = require(process.argv[1])
    atomicWriteJson(process.argv[2], { replacement: 'never published' }, {
      beforeCommit: () => process.exit(76),
    })
  `, path.join(workflow, 'event-log.js'), statePath], { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 76, child.stderr)
  assert.equal(runRecord.openRunRecord(record.runPath).runId, record.runId)
  assert.deepEqual(fs.readFileSync(statePath), before)
  assert.equal(fs.readdirSync(path.dirname(statePath)).some(name => name.endsWith('.tmp')), false)
})

test('terminal validation binds the saved explanation and release evidence to canonical state', t => {
  const { record } = fixture(t)
  const event = { sequence: 3, type: 'CONTROLLER_FAILED_FINAL', hash: sha256('release event') }
  const terminal = {
    schemaVersion: '2.0.0', outcome: 'PARTIAL', runId: record.runId,
    activationId: 'activation-recovery-001', generation: 1, sequence: 3,
    missionHash: sha256('mission'), requestEnvelopeHash: sha256('request'), workspaceEpoch: 0,
    completedAt: '2026-09-04T00:00:00.000Z', deliverableManifest: [],
    deliverableManifestHash: sha256('[]'), producedEvidenceHashes: [],
    terminalEnvelope: { code: 'PARTIAL', description: 'The existing output has not passed verification.' },
    releaseIntent: { eventId: event.type, eventSequence: event.sequence, eventHash: event.hash },
  }
  const state = { state: 'PARTIAL', terminal, activation: { id: terminal.activationId } }
  const instance = new Finalizer({
    stateStore: {
      registeredPaths: { runRecordRoot: record.runPath, terminalPath: record.paths.terminalPath },
      load: () => state,
      validateTerminal: () => ({ valid: true }),
      eventLog: { readAll: () => [null, null, event] },
    },
    processOwner: {}, missionLock: {}, capability: {}, cleanupRegistry: {},
  })
  const original = instance._createOrVerifyTerminal({
    ...terminal, schemaVersion: 2,
    terminalEventSequence: event.sequence, terminalEventHash: event.hash, terminalEventType: event.type,
  })
  assert.equal(instance.validateTerminalRecord().valid, true)
  const mutations = [
    { terminalEnvelope: { code: 'DONE', description: 'Everything passed.' } },
    { releaseIntent: { ...terminal.releaseIntent, eventHash: sha256('foreign release') } },
    { completedAt: '2026-09-05T00:00:00.000Z' },
    { terminalEventType: 'VERIFIED' },
  ]
  for (const mutation of mutations) {
    atomicWriteJson(record.paths.terminalPath, { ...original, ...mutation })
    assert.equal(instance.validateTerminalRecord().valid, false, Object.keys(mutation)[0])
  }
})

test('candidate survival preserves read-only product files without requiring write access', {
  skip: process.platform === 'win32',
}, t => {
  const dropPrivileges = typeof process.getuid === 'function' && process.getuid() === 0
  const temporaryRoot = dropPrivileges && (fs.statSync(os.tmpdir()).mode & 0o001) === 0
    ? '/var/tmp' : os.tmpdir()
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'codex-astra-unprivileged-'))
  t.after(() => {
    const makeRemovable = target => {
      const stat = fs.lstatSync(target)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return
      fs.chmodSync(target, 0o700)
      for (const name of fs.readdirSync(target)) makeRemovable(path.join(target, name))
    }
    makeRemovable(directory)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  if (dropPrivileges) fs.chownSync(directory, 65534, 65534)
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict')
    const fs = require('node:fs')
    const path = require('node:path')
    const childProcess = require('node:child_process')
    const { WorkerWorkspaceManager } = require(process.argv[1])
    const directory = process.argv[2]
    process.chdir(directory)
    if (process.argv[3] === 'drop') { process.setgid(65534); process.setuid(65534) }
    const target = path.join(directory, 'target')
    const privateRoot = path.join(directory, 'private')
    fs.mkdirSync(target); fs.mkdirSync(privateRoot)
    for (const args of [['init', '-b', 'fixture'], ['config', 'user.name', 'Fixture'],
      ['config', 'user.email', 'fixture@example.invalid']]) {
      const result = childProcess.spawnSync('git', ['-C', target, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    fs.writeFileSync(path.join(target, 'input.txt'), 'original input\\n')
    for (const args of [['add', 'input.txt'], ['commit', '-m', 'fixture']]) {
      const result = childProcess.spawnSync('git', ['-C', target, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    const manager = new WorkerWorkspaceManager({
      targetRoot: target, privateRoot, runId: 'readonly-survival', activationId: 'readonly-activation',
    })
    const session = manager.prepare({
      workItemId: 'work-1', assignment: { resources: [{ kind: 'directory', identity: '.', access: 'write' }] },
    })
    const output = path.join(session.workspacePath, 'output.txt')
    fs.writeFileSync(output, 'read-only product\\n', { mode: 0o444 })
    const admission = manager.inspect(session, { filesChanged: ['output.txt'] })
    const preserved = manager.preserveCandidate(session, { admission })
    assert.equal(fs.readFileSync(path.join(preserved.candidateRoot, 'output.txt'), 'utf8'), 'read-only product\\n')
    assert.equal(fs.statSync(path.join(preserved.candidateRoot, 'output.txt')).mode & 0o777, 0o444)
    assert.deepEqual(manager.preserveCandidate(session, { admission }), preserved)
    for (const boundary of ['before-manifest', 'after-manifest']) {
      const fsImpl = Object.create(fs)
      let interrupted = false
      fsImpl.renameSync = (source, destination) => {
        if (!interrupted && String(destination).includes('/candidate-survivals/') &&
            path.basename(destination) === 'manifest.json') {
          interrupted = true
          if (boundary === 'after-manifest') fs.renameSync(source, destination)
          throw Object.assign(new Error(boundary), { code: 'EIO' })
        }
        return fs.renameSync(source, destination)
      }
      const retryManager = new WorkerWorkspaceManager({
        targetRoot: target, privateRoot, fsImpl, runId: 'readonly-survival', activationId: 'readonly-activation',
      })
      const retrySession = retryManager.prepare({
        workItemId: boundary, assignment: { resources: [{ kind: 'directory', identity: '.', access: 'write' }] },
      })
      fs.writeFileSync(path.join(retrySession.workspacePath, 'output.txt'), boundary, { mode: 0o444 })
      const retryAdmission = retryManager.inspect(retrySession, { filesChanged: ['output.txt'] })
      assert.throws(() => retryManager.preserveCandidate(retrySession, { admission: retryAdmission }), { code: 'EIO' })
      const recovered = retryManager.preserveCandidate(retrySession, { admission: retryAdmission })
      assert.equal(fs.readFileSync(path.join(recovered.candidateRoot, 'output.txt'), 'utf8'), boundary)
      assert.equal(fs.statSync(path.join(recovered.candidateRoot, 'output.txt')).mode & 0o777, 0o444)
    }
  `, path.join(workflow, 'worker-workspace.js'), directory, dropPrivileges ? 'drop' : 'same-user'], {
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
})
