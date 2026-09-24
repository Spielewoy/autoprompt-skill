'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const test = require('node:test')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const serverModule = require('../../scripts/harness-v2-tool-server.cjs')

function privateRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-tool-phases-'))
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return fs.realpathSync.native(root)
}

function records(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('private Hermes phase journal is exclusive, bounded, and contains fixed fields only', t => {
  const root = privateRoot(t)
  const journal = serverModule.createPrivatePhaseJournal(root, 'hermes')
  assert.ok(journal)
  assert.equal(path.basename(journal.path), serverModule.HERMES_PHASE_JOURNAL)
  const stat = fs.lstatSync(journal.path)
  assert.equal(stat.isFile(), true)
  assert.equal(stat.isSymbolicLink(), false)
  assert.equal(stat.nlink, 1)
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600)

  assert.equal(journal.record({ stage: 'tool-call-start', request: 'must-not-persist' }), true)
  assert.equal(journal.record({ stage: 'worker-command-failed', code: 'bad message and secret' }), true)
  assert.equal(journal.record({ stage: 'unknown-stage', code: 'TOOL_FAILED' }), false)
  journal.close()
  assert.equal(journal.record({ stage: 'tool-call-result' }), false)
  assert.deepEqual(records(journal.path), [
    { schemaVersion: 1, sequence: 1, stage: 'tool-call-start' },
    { schemaVersion: 1, sequence: 2, stage: 'worker-command-failed', code: 'INTERNAL_ERROR' },
  ])

  const original = fs.readFileSync(journal.path)
  assert.equal(serverModule.createPrivatePhaseJournal(root, 'hermes'), null)
  assert.deepEqual(fs.readFileSync(journal.path), original, 'a second server must not overwrite prior evidence')
  assert.equal(serverModule.createPrivatePhaseJournal(root, 'claude'), null)

  const boundedRoot = path.join(root, 'bounded')
  fs.mkdirSync(boundedRoot, { mode: 0o700 })
  const bounded = serverModule.createPrivatePhaseJournal(boundedRoot, 'hermes')
  for (let index = 0; index < 300; index++) bounded.record({ stage: 'tool-call-start' })
  bounded.close()
  assert.equal(records(bounded.path).length, 256)
})

test('private phase observer refuses a replaced journal without touching the replacement', t => {
  const root = privateRoot(t), journal = serverModule.createPrivatePhaseJournal(root, 'hermes')
  const held = `${journal.path}.held`
  fs.renameSync(journal.path, held)
  fs.writeFileSync(journal.path, 'foreign-bytes', { flag: 'wx', mode: 0o600 })
  assert.equal(journal.record({ stage: 'worker-command-start' }), false)
  journal.close()
  assert.equal(fs.readFileSync(journal.path, 'utf8'), 'foreign-bytes')
  assert.equal(fs.readFileSync(held, 'utf8'), '')
})

test('rejected synchronous Hermes startup creates no phase journal', t => {
  const root = privateRoot(t), target = path.join(root, 'target'), control = path.join(root, 'control')
  fs.mkdirSync(target, { mode: 0o700 }); fs.mkdirSync(control, { mode: 0o700 })
  const prepared = boundary.prepareBoundary({ provider: 'hermes', root: control, policy: {
    provider: 'hermes', readOnly: true, targetPath: target, scratchPath: null,
    readableRoots: [target], writableRoots: [], nestedDispatch: false,
    commandBoundary: true, externalWrites: false,
  } })
  const phaseFile = path.join(prepared.root, serverModule.HERMES_PHASE_JOURNAL)
  const priorProjection = process.env.AUTOPROMPT_HERMES_TOOL_PROJECTIONS
  process.env.AUTOPROMPT_HERMES_TOOL_PROJECTIONS = path.join(root, 'foreign-projection')
  try { assert.throws(() => serverModule.start({ boundary: prepared }), { code: 'TOOL_POLICY_INVALID' }) }
  finally {
    if (priorProjection === undefined) delete process.env.AUTOPROMPT_HERMES_TOOL_PROJECTIONS
    else process.env.AUTOPROMPT_HERMES_TOOL_PROJECTIONS = priorProjection
  }
  assert.equal(fs.existsSync(phaseFile), false)

  fs.writeFileSync(path.join(prepared.root, 'server.lock'), 'collision', { flag: 'wx', mode: 0o600 })
  assert.throws(() => serverModule.start({ boundary: prepared, platform: 'linux' }), { code: 'EEXIST' })
  assert.equal(fs.existsSync(phaseFile), false)
})

test('Hermes tool server commits lifecycle phases without request or output data', async t => {
  const root = privateRoot(t), target = path.join(root, 'target'), control = path.join(root, 'control')
  fs.mkdirSync(target, { mode: 0o700 }); fs.mkdirSync(control, { mode: 0o700 })
  fs.writeFileSync(path.join(target, 'input.txt'), 'private-payload-that-must-not-enter-phases')
  const prepared = boundary.prepareBoundary({ provider: 'hermes', root: control, policy: {
    provider: 'hermes', readOnly: true, targetPath: target, scratchPath: null,
    readableRoots: [target], writableRoots: [], nestedDispatch: false,
    commandBoundary: true, externalWrites: false,
  } })
  const input = new PassThrough(), output = new PassThrough(), messages = []
  let pending = '', wake
  output.on('data', bytes => {
    pending += bytes.toString('utf8')
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(pending.slice(0, newline))); pending = pending.slice(newline + 1); wake?.()
    }
  })
  const next = async () => {
    if (!messages.length) await new Promise(resolve => { wake = resolve })
    wake = null
    return messages.shift()
  }
  const server = serverModule.start({ boundary: prepared, input, output, platform: 'linux' })
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`)
  assert.ok((await next()).result)
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { path: 'input.txt' } } })}\n`)
  assert.equal((await next()).result.structuredContent.status, 'completed')
  input.end(); await server.closed

  const phaseFile = path.join(prepared.root, serverModule.HERMES_PHASE_JOURNAL)
  const observed = records(phaseFile)
  assert.deepEqual(observed.map(record => record.stage), [
    'tool-server-start', 'tool-call-start', 'tool-call-result', 'tool-receipt-committed', 'tool-server-close',
  ])
  assert.equal(observed.every(record => Object.keys(record).every(key => ['schemaVersion', 'sequence', 'stage', 'code'].includes(key))), true)
  assert.equal(fs.readFileSync(phaseFile, 'utf8').includes('private-payload'), false)
})
