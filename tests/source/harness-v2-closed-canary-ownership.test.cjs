'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { inspectPathNoFollow } = require('../../agents/codex/workflow/safe-run-root.js')
const { ownedTest, drainRegistered, claimPrivateCanaryDirectory, closedCanaryBatchTimeout, closedEnvironment, stageWindowsOpenCodeShortEnvironment, validateWindowsOpenCodeShortEnvironment, removeWindowsOpenCodeShortEnvironment, finalizeClosedCanary, WINDOWS_OPENCODE_SHORT_ENV_RECORD } = require('../../scripts/harness-v2-closed-canary.cjs')

function privateDirectory(file) { fs.mkdirSync(file, { recursive: true, mode: 0o700 }); return fs.realpathSync.native(file) }
function binding(root) {
  return { provider: 'claude', activationId: 'closed-owner-regression', generation: 1,
    challenge: crypto.randomBytes(32).toString('base64url'), ownershipRoot: path.join(root, 'nested') }
}
function environment(value) {
  return { PATH: process.env.PATH, AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT: value.ownershipRoot,
    AUTOPROMPT_CLOSED_CANARY_PROVIDER: value.provider, AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID: value.activationId,
    AUTOPROMPT_CLOSED_CANARY_GENERATION: String(value.generation), AUTOPROMPT_CLOSED_CANARY_CHALLENGE: value.challenge }
}
async function liveOwner(root, name) {
  const adapter = createPosixProcessAdapter(), owner = new ProcessOwner({ adapter, registryPath: path.join(root, `${name}.json`), pollMs: 10 })
  const reservationId = `${name}-${crypto.randomUUID()}`
  await owner.launch({ executable: process.execPath, argv: ['-e', 'setTimeout(()=>{},30000)'], cwd: root,
    env: prepareProcessLaunchEnvironment(adapter, reservationId, { PATH: process.env.PATH }), reservationId, sessionId: reservationId,
    targetKey: name, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', forWork: false })
  return owner
}

test('closed owned-test durably publishes synchronous spawn refusal and bounded live logs', t => {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-sync-spawn-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const id = crypto.randomUUID(), stem = path.join(root, `outer-${id}`)
  const preload = path.join(root, 'refuse-spawn.cjs')
  fs.writeFileSync(preload, "const cp=require('node:child_process');cp.spawn=()=>{const e=new Error('forced closed spawn refusal');e.code='ENAMETOOLONG';throw e}\n")
  const request = { argv: ['-e', 'process.exit(0)'], cwd: root, env: { PATH: process.env.PATH },
    status: `${stem}.status.json`, stdoutPath: `${stem}.stdout.log`, stderrPath: `${stem}.stderr.log`,
    failureMarker: `${stem}.failure.json`, failFastTap: false, postStatusDelayMs: 0 }
  const requestPath = `${stem}.json`
  fs.writeFileSync(requestPath, JSON.stringify(request))
  const result = cp.spawnSync(process.execPath, ['--require', preload,
    path.resolve(__dirname, '../../scripts/harness-v2-closed-canary.cjs'), '--closed-owned-test', requestPath],
  { cwd: root, encoding: 'utf8', timeout: 10000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  const status = JSON.parse(fs.readFileSync(request.status, 'utf8'))
  assert.equal(status.code, 1)
  assert.equal(status.signal, null)
  assert.equal(status.errorCode, 'ENAMETOOLONG')
  assert.equal(status.error, 'forced closed spawn refusal')
  assert.equal(fs.readFileSync(request.stdoutPath, 'utf8'), '')
  assert.match(fs.readFileSync(request.stderrPath, 'utf8'), /^CLOSED_OWNED_TEST_FAILED:.*ENAMETOOLONG/m)

  const foreign = path.join(root, 'foreign.status.json')
  fs.writeFileSync(foreign, 'foreign-owner')
  const malformedId = crypto.randomUUID(), malformedStem = path.join(root, `outer-${malformedId}`)
  const malformedPath = `${malformedStem}.json`
  fs.writeFileSync(malformedPath, JSON.stringify({ ...request, status: foreign,
    stdoutPath: `${malformedStem}.stdout.log`, stderrPath: `${malformedStem}.stderr.log`, failureMarker: `${malformedStem}.failure.json` }))
  const malformed = cp.spawnSync(process.execPath,
    [path.resolve(__dirname, '../../scripts/harness-v2-closed-canary.cjs'), '--closed-owned-test', malformedPath],
    { cwd: root, encoding: 'utf8', timeout: 10000 })
  assert.ifError(malformed.error)
  assert.equal(malformed.status, 1)
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign-owner')
  assert.equal(fs.existsSync(`${malformedStem}.stdout.log`), false)
  assert.equal(fs.existsSync(`${malformedStem}.stderr.log`), false)

  const overflowId = crypto.randomUUID(), overflowStem = path.join(root, `outer-${overflowId}`)
  const overflowRequest = { ...request, argv: ['-e', "process.stdout.write(Buffer.alloc(4*1024*1024+65536,120))"],
    status: `${overflowStem}.status.json`, stdoutPath: `${overflowStem}.stdout.log`, stderrPath: `${overflowStem}.stderr.log`,
    failureMarker: `${overflowStem}.failure.json` }
  const overflowPath = `${overflowStem}.json`
  fs.writeFileSync(overflowPath, JSON.stringify(overflowRequest))
  const overflow = cp.spawnSync(process.execPath,
    [path.resolve(__dirname, '../../scripts/harness-v2-closed-canary.cjs'), '--closed-owned-test', overflowPath],
    { cwd: root, encoding: 'utf8', timeout: 10000 })
  assert.ifError(overflow.error)
  const overflowStatus = JSON.parse(fs.readFileSync(overflowRequest.status, 'utf8'))
  assert.notEqual(overflowStatus.code, 0)
  assert.equal(overflowStatus.errorCode, 'LOCAL_CANARY_OUTPUT_LIMIT')
  assert.ok(fs.statSync(overflowRequest.stdoutPath).size <= 4 * 1024 * 1024)
})

test('closed canary timeout retains bounded live child output before terminal status', { timeout: 10000 }, async t => {
  if (process.platform === 'win32') return t.skip('portable POSIX process-group regression')
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-live-output-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const value = binding(root); privateDirectory(value.ownershipRoot)
  const owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(root, 'outer.json'), pollMs: 10 })
  await assert.rejects(ownedTest(owner, root, environment(value), ['-e',
    "process.stdout.write('live-stdout\\nnot ok 1 - default owned test does not fail fast\\n');process.stderr.write('live-stderr\\n');setTimeout(()=>{},30000)"], 500), { code: 'LOCAL_CANARY_TIMEOUT' })
  const stdoutPath = fs.readdirSync(root).find(name => /^outer-[a-f0-9-]{36}\.stdout\.log$/.test(name))
  const stderrPath = fs.readdirSync(root).find(name => /^outer-[a-f0-9-]{36}\.stderr\.log$/.test(name))
  assert.equal(fs.readFileSync(path.join(root, stdoutPath), 'utf8'), 'live-stdout\nnot ok 1 - default owned test does not fail fast\n')
  assert.equal(fs.readFileSync(path.join(root, stderrPath), 'utf8'), 'live-stderr\n')
  assert.equal(fs.readdirSync(root).some(name => /^outer-[a-f0-9-]{36}\.status\.json$/.test(name)), false)
  assert.equal(fs.readdirSync(root).some(name => /^outer-[a-f0-9-]{36}\.failure\.json$/.test(name)), false)
})

test('closed canary capability batch fails promptly on one complete top-level TAP failure marker', async t => {
  if (process.platform === 'win32') return t.skip('portable POSIX process-group regression')
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-tap-failure-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const value = binding(root); privateDirectory(value.ownershipRoot)
  const owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(root, 'outer.json'), pollMs: 10 })
  const began = Date.now()
  await assert.rejects(ownedTest(owner, root, environment(value), ['-e',
    "process.stdout.write('TAP version 13\\nnot ok 1 - first failing native case\\n');setTimeout(()=>process.stdout.write('# late vendor startup diagnostic\\n'),50);setTimeout(()=>{},30000)"],
  10000, undefined, { failFastTap: true }), error => error.code === 'LOCAL_CANARY_FAILED' && /first failing native case/.test(error.message))
  assert.ok(Date.now() - began < 2000)
  assert.deepEqual(owner.ownershipIdentities(), [])
  const markerName = fs.readdirSync(root).find(name => /^outer-[a-f0-9-]{36}\.failure\.json$/.test(name))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, markerName), 'utf8')),
    { schemaVersion: 1, case: 'first failing native case', message: 'not ok 1 - first failing native case' })
  const stdoutName = fs.readdirSync(root).find(name => /^outer-[a-f0-9-]{36}\.stdout\.log$/.test(name))
  assert.match(fs.readFileSync(path.join(root, stdoutName), 'utf8'), /# late vendor startup diagnostic/)

  const oversizedRoot = privateDirectory(path.join(root, 'oversized-line'))
  const oversizedValue = binding(oversizedRoot); privateDirectory(oversizedValue.ownershipRoot)
  const oversizedOwner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(oversizedRoot, 'outer.json'), pollMs: 10 })
  await assert.rejects(ownedTest(oversizedOwner, oversizedRoot, environment(oversizedValue), ['-e',
    "process.stdout.write('x'.repeat(5000));setTimeout(()=>process.stdout.write('not ok 9 - mid-line false failure\\n'),50);setTimeout(()=>{},30000)"],
  500, undefined, { failFastTap: true }), { code: 'LOCAL_CANARY_TIMEOUT' })
  assert.equal(fs.readdirSync(oversizedRoot).some(name => name.endsWith('.failure.json')), false)
})

test('closed canary capability batch treats a malformed TAP failure marker as a failure', async () => {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-bad-marker-')))
  const value = binding(root); privateDirectory(value.ownershipRoot)
  let requestPath, cancelled = false
  const owner = {
    adapter: { async listOwned() { return [123] } },
    async launch(spec) {
      requestPath = spec.argv[2]
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
      fs.writeFileSync(request.failureMarker, Buffer.alloc(4097, 120))
      return { ownershipId: 'bad-marker', groupIdentity: 'bad-marker-group' }
    },
    async cancelAll() { cancelled = true },
  }
  try {
    await assert.rejects(ownedTest(owner, root, environment(value), ['-e', 'process.exit(0)'],
      10000, undefined, { failFastTap: true }), { code: 'LOCAL_CANARY_FAILED' })
    assert.equal(cancelled, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('closed canary detects an empty owned launcher before its batch deadline', async () => {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-empty-launcher-')))
  const value = binding(root); privateDirectory(value.ownershipRoot)
  let cancelled = false, observations = 0
  const owner = {
    adapter: { async listOwned(identity) { assert.equal(identity, 'empty-launcher-group'); observations += 1; return [] } },
    async launch() { return { ownershipId: 'empty-launcher', groupIdentity: 'empty-launcher-group' } },
    async cancelAll() { cancelled = true },
  }
  const began = Date.now()
  try {
    await assert.rejects(ownedTest(owner, root, environment(value), ['-e', 'process.exit(0)'], 10000),
      { code: 'LOCAL_CANARY_FAILED' })
    assert.ok(Date.now() - began < 1000)
    assert.ok(observations >= 2)
    assert.equal(cancelled, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('closed canary preserves cancellation and deadline authority across an awaited owned-group query', async () => {
  const abortRoot = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-query-abort-')))
  const abortValue = binding(abortRoot); privateDirectory(abortValue.ownershipRoot)
  const controller = new AbortController()
  let abortCancelled = false, abortRequestPath
  const abortOwner = {
    adapter: { async listOwned() {
      const request = JSON.parse(fs.readFileSync(abortRequestPath, 'utf8'))
      fs.writeFileSync(request.failureMarker, JSON.stringify({ schemaVersion: 1, case: 'late failure', message: 'not ok 1 - late failure' }))
      controller.abort(); return []
    } },
    async launch(spec) { abortRequestPath = spec.argv[2]; return { ownershipId: 'query-abort', groupIdentity: 'query-abort-group' } },
    async cancelAll() { abortCancelled = true },
  }
  try {
    await assert.rejects(ownedTest(abortOwner, abortRoot, environment(abortValue), ['-e', 'process.exit(0)'],
      10000, controller.signal, { failFastTap: true }), { code: 'CHILD_CANCELLED' })
    assert.equal(abortCancelled, true)
  } finally { fs.rmSync(abortRoot, { recursive: true, force: true }) }

  const deadlineRoot = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-query-deadline-')))
  const deadlineValue = binding(deadlineRoot); privateDirectory(deadlineValue.ownershipRoot)
  let now = 100, requestPath, deadlineCancelled = false
  const deadlineOwner = {
    adapter: { async listOwned() {
      now = 111
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
      fs.writeFileSync(request.failureMarker, JSON.stringify({ schemaVersion: 1, case: 'late failure', message: 'not ok 1 - late failure' }))
      fs.writeFileSync(request.status, JSON.stringify({ code: 0, signal: null, error: null, stdout: '', stderr: '' }))
      return []
    } },
    async launch(spec) { requestPath = spec.argv[2]; return { ownershipId: 'query-deadline', groupIdentity: 'query-deadline-group' } },
    async cancelAll() { deadlineCancelled = true },
  }
  try {
    await assert.rejects(ownedTest(deadlineOwner, deadlineRoot, environment(deadlineValue), ['-e', 'process.exit(0)'],
      10, undefined, { wallNowMs: () => now, failFastTap: true }), { code: 'LOCAL_CANARY_TIMEOUT' })
    assert.equal(deadlineCancelled, true)
  } finally { fs.rmSync(deadlineRoot, { recursive: true, force: true }) }
})

test('closed canary batch timeout adds only bounded Windows Job startup allowances under authority deadlines', () => {
  assert.equal(closedCanaryBatchTimeout({ platform: 'win32', caseCount: 11,
    approvalRemainingMs: 10_000_000, activationRemainingMs: 10_000_000 }), 2_040_000)
  assert.equal(closedCanaryBatchTimeout({ platform: 'linux', caseCount: 11,
    approvalRemainingMs: 10_000_000, activationRemainingMs: 10_000_000 }), 720_000)
  assert.equal(closedCanaryBatchTimeout({ platform: 'win32', caseCount: 11,
    approvalRemainingMs: 300_000, activationRemainingMs: 400_000 }), 300_000)
  assert.equal(closedCanaryBatchTimeout({ platform: 'win32', caseCount: 11,
    approvalRemainingMs: 400_000, activationRemainingMs: 200_000 }), 200_000)
  assert.equal(closedCanaryBatchTimeout({ platform: 'win32', caseCount: 11,
    approvalRemainingMs: -1, activationRemainingMs: 10_000_000 }), -1)
  assert.throws(() => closedCanaryBatchTimeout({ platform: 'win32', caseCount: 0,
    approvalRemainingMs: 1, activationRemainingMs: 1 }), { code: 'LOCAL_CANARY_INVALID' })
})

test('closed canary owned-test startup consumes the same finite batch deadline', async () => {
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-startup-')))
  const value = binding(root)
  privateDirectory(value.ownershipRoot)
  let now = 1000
  let cancelled = false
  const owner = {
    adapter: {},
    async launch(spec) {
      await new Promise(resolve => setTimeout(resolve, 10))
      now += 21
      const request = JSON.parse(fs.readFileSync(spec.argv[2], 'utf8'))
      fs.writeFileSync(request.status, JSON.stringify({ code: 0, signal: null, stdout: '', stderr: '' }))
      return { ownershipId: 'completed-after-deadline' }
    },
    async cancelAll() { cancelled = true },
  }
  try {
    await assert.rejects(ownedTest(owner, root, environment(value), ['-e', 'process.exit(0)'], 20, undefined, {
      wallNowMs() { return now },
    }), { code: 'LOCAL_CANARY_TIMEOUT' })
    assert.equal(cancelled, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})


function shortCanaryFixture() {
  const base = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-short-env-')))
  const local = privateDirectory(path.join(base, 'local-app-data'))
  const generation = privateDirectory(path.join(base, 'generation-1'))
  const state = { local, removals: [], beforeOwnedRemove: null }
  const exactIdentity = value => ({ dev: String(value.dev), ino: String(value.ino) })
  const windowsFilesystem = {
    removeOwnedTarget(target, parentIdentity, targetIdentity) {
      if (state.beforeOwnedRemove) state.beforeOwnedRemove(target, parentIdentity, targetIdentity)
      const parent = fs.lstatSync(path.dirname(target), { bigint: true })
      const actual = fs.lstatSync(target, { bigint: true })
      assert.deepEqual(exactIdentity(parent), { dev: String(parentIdentity.dev), ino: String(parentIdentity.ino) })
      assert.deepEqual(exactIdentity(actual), { dev: String(targetIdentity.dev), ino: String(targetIdentity.ino) })
      if (targetIdentity.type === 'directory') {
        assert.equal(actual.isDirectory(), true)
        fs.rmSync(target, { recursive: true, force: false })
      } else {
        assert.equal(targetIdentity.type, 'file')
        assert.equal(actual.isFile(), true)
        fs.unlinkSync(target)
      }
      state.removals.push({ target, type: targetIdentity.type })
    },
  }
  const options = {
    platform: 'win32', systemRoot: 'C:\\Windows',
    createWindowsCompilerDirectory(prefix) { return fs.mkdtempSync(path.join(state.local, prefix)) },
    windowsControllerEnvironment() { return { LOCALAPPDATA: state.local } },
    auditPrivatePermissions(directory, auditOptions) { assert.deepEqual(auditOptions, { recurse: false }); assert.ok(fs.existsSync(directory)) },
    windowsFilesystem,
  }
  return { base, local, generation, state, options,
    input: { provider: 'opencode', root: generation, activationId: 'short-canary-activation', generation: 1, challenge: crypto.randomBytes(32).toString('base64url') } }
}

test('Windows OpenCode short canary environment is token-parent bound, sealed, and projected without moving durable state', async t => {
  const fixture = shortCanaryFixture()
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
  const staged = await stageWindowsOpenCodeShortEnvironment(fixture.input, fixture.options)
  assert.equal(path.dirname(staged.root), fixture.local)
  assert.equal(fs.existsSync(path.join(fixture.generation, WINDOWS_OPENCODE_SHORT_ENV_RECORD)), true)
  for (const directory of [staged.home, staged.temporary, staged.config, staged.data, staged.state, staged.cache]) assert.equal(fs.statSync(directory).isDirectory(), true)
  const env = closedEnvironment({ PATH: process.env.PATH, SYSTEMROOT: 'C:\\Windows' }, 'opencode', fixture.generation, {
    platform: 'win32', windowsShortEnvironment: staged,
  })
  assert.equal(env.HOME, staged.home)
  assert.equal(env.TEMP, staged.temporary)
  assert.equal(env.XDG_CONFIG_HOME, staged.config)
  assert.equal(path.join(fixture.generation, 'outer-processes.json').startsWith(fixture.generation + path.sep), true)
  await removeWindowsOpenCodeShortEnvironment(staged, fixture.options)
  assert.equal(fs.existsSync(staged.root), false)
  assert.equal(fs.existsSync(staged.recordPath), false)
})

test('Windows OpenCode short canary environment retains its journal on root replacement or token-parent drift', async t => {
  const replaced = shortCanaryFixture()
  t.after(() => fs.rmSync(replaced.base, { recursive: true, force: true }))
  const staged = await stageWindowsOpenCodeShortEnvironment(replaced.input, replaced.options)
  fs.rmSync(staged.root, { recursive: true, force: true })
  fs.writeFileSync(staged.root, 'replacement', { mode: 0o600 })
  await assert.rejects(removeWindowsOpenCodeShortEnvironment(staged, replaced.options), error => error.code === 'RUN_RECORD_UNSAFE' || error.code === 'LOCAL_CANARY_INVALID')
  assert.equal(fs.existsSync(staged.recordPath), true)
  assert.equal(fs.existsSync(staged.root), true)

  const drifted = shortCanaryFixture()
  t.after(() => fs.rmSync(drifted.base, { recursive: true, force: true }))
  const second = await stageWindowsOpenCodeShortEnvironment(drifted.input, drifted.options)
  const foreign = privateDirectory(path.join(drifted.base, 'foreign-local-app-data'))
  drifted.state.local = foreign
  await assert.rejects(removeWindowsOpenCodeShortEnvironment(second, drifted.options), { code: 'LOCAL_CANARY_INVALID' })
  assert.equal(fs.existsSync(second.recordPath), true)
  assert.equal(fs.existsSync(second.root), true)
})

test('Windows OpenCode short canary refuses a replaced journal parent even when the original journal inode is moved back', async t => {
  const fixture = shortCanaryFixture()
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
  const staged = await stageWindowsOpenCodeShortEnvironment(fixture.input, fixture.options)
  const held = path.join(fixture.base, 'held-generation')
  fs.renameSync(fixture.generation, held)
  privateDirectory(fixture.generation)
  fs.renameSync(path.join(held, WINDOWS_OPENCODE_SHORT_ENV_RECORD), staged.recordPath)
  assert.throws(() => validateWindowsOpenCodeShortEnvironment(staged, fixture.options), { code: 'LOCAL_CANARY_INVALID' })
  assert.equal(fs.existsSync(staged.root), true)
  assert.equal(fs.existsSync(staged.recordPath), true)
})

test('Windows OpenCode short canary refuses a same-byte journal inode replacement between inspection and read', async t => {
  const fixture = shortCanaryFixture()
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
  const staged = await stageWindowsOpenCodeShortEnvironment(fixture.input, fixture.options)
  let replaced = false
  const held = `${staged.recordPath}.held`
  const replacingInspect = (candidate, options) => {
    const inspected = inspectPathNoFollow(candidate, options)
    if (!replaced && path.resolve(candidate) === path.resolve(staged.recordPath)) {
      const bytes = fs.readFileSync(staged.recordPath)
      fs.renameSync(staged.recordPath, held)
      fs.writeFileSync(staged.recordPath, bytes, { flag: 'wx', mode: 0o600 })
      replaced = true
    }
    return inspected
  }
  assert.throws(() => validateWindowsOpenCodeShortEnvironment(staged, { ...fixture.options, inspectPathNoFollow: replacingInspect }), { code: 'LOCAL_CANARY_INVALID' })
  assert.equal(replaced, true)
  assert.equal(fs.existsSync(staged.root), true)
  assert.equal(fs.existsSync(staged.recordPath), true)
})

test('Windows OpenCode short canary revalidates every projected directory before child launch', async t => {
  for (const field of ['home', 'temporary']) {
    await t.test(field, async t => {
      const fixture = shortCanaryFixture()
      t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
      const staged = await stageWindowsOpenCodeShortEnvironment(fixture.input, fixture.options)
      const held = `${staged[field]}.held`
      const foreign = privateDirectory(path.join(fixture.base, `foreign-${field}`))
      fs.renameSync(staged[field], held)
      fs.symlinkSync(foreign, staged[field], process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(() => validateWindowsOpenCodeShortEnvironment(staged, fixture.options), error => error.code === 'RUN_RECORD_UNSAFE' || error.code === 'LOCAL_CANARY_INVALID')
      assert.equal(fs.existsSync(staged.recordPath), true)
      assert.equal(fs.existsSync(foreign), true)
    })
  }
})

test('Windows OpenCode short canary retains allocations after uncertain publication failures', async t => {
  await t.test('post-link failure', async t => {
    const fixture = shortCanaryFixture()
    t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
    let created
    const fsImpl = Object.create(fs)
    fsImpl.linkSync = (...args) => {
      fs.linkSync(...args)
      throw Object.assign(new Error('injected post-link failure'), { code: 'INJECTED_POST_LINK' })
    }
    await assert.rejects(stageWindowsOpenCodeShortEnvironment(fixture.input, { ...fixture.options, fsImpl,
      createWindowsCompilerDirectory(prefix) { created = fs.mkdtempSync(path.join(fixture.local, prefix)); return created },
    }), { code: 'INJECTED_POST_LINK' })
    assert.equal(fs.existsSync(created), true)
    assert.equal(fs.existsSync(path.join(fixture.generation, WINDOWS_OPENCODE_SHORT_ENV_RECORD)), true)
  })

  await t.test('staging-alias unlink failure', async t => {
    const fixture = shortCanaryFixture()
    t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
    let created, refused = false
    const fsImpl = Object.create(fs)
    fsImpl.unlinkSync = candidate => {
      if (path.basename(candidate).endsWith('.create')) {
        refused = true
        throw Object.assign(new Error('injected staging-alias unlink failure'), { code: 'INJECTED_UNLINK' })
      }
      return fs.unlinkSync(candidate)
    }
    await assert.rejects(stageWindowsOpenCodeShortEnvironment(fixture.input, { ...fixture.options, fsImpl,
      createWindowsCompilerDirectory(prefix) { created = fs.mkdtempSync(path.join(fixture.local, prefix)); return created },
    }), { code: 'INJECTED_UNLINK' })
    assert.equal(refused, true)
    assert.equal(fs.existsSync(created), true)
    assert.equal(fs.existsSync(path.join(fixture.generation, WINDOWS_OPENCODE_SHORT_ENV_RECORD)), true)
  })

  await t.test('post-publication inspection failure', async t => {
    const fixture = shortCanaryFixture()
    t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
    let created, publicationObserved = false
    const inspect = (candidate, options) => {
      if (path.basename(candidate) === WINDOWS_OPENCODE_SHORT_ENV_RECORD && fs.existsSync(candidate)) {
        publicationObserved = true
        throw Object.assign(new Error('injected journal inspection failure'), { code: 'INJECTED_INSPECT' })
      }
      return inspectPathNoFollow(candidate, options)
    }
    await assert.rejects(stageWindowsOpenCodeShortEnvironment(fixture.input, { ...fixture.options, inspectPathNoFollow: inspect,
      createWindowsCompilerDirectory(prefix) { created = fs.mkdtempSync(path.join(fixture.local, prefix)); return created },
    }), { code: 'INJECTED_INSPECT' })
    assert.equal(publicationObserved, true)
    assert.equal(fs.existsSync(created), true)
    assert.equal(fs.existsSync(path.join(fixture.generation, WINDOWS_OPENCODE_SHORT_ENV_RECORD)), true)
  })
})

test('Windows OpenCode short canary reports an unknown first capture as retained', async t => {
  const fixture = shortCanaryFixture()
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
  let created
  const failure = await stageWindowsOpenCodeShortEnvironment(fixture.input, { ...fixture.options,
    createWindowsCompilerDirectory(prefix) { created = fs.mkdtempSync(path.join(fixture.local, prefix)); return created },
    inspectPathNoFollow(candidate, options) {
      if (candidate === created) throw Object.assign(new Error('injected first capture failure'), { code: 'INJECTED_CAPTURE' })
      return inspectPathNoFollow(candidate, options)
    },
  }).then(() => null, error => error)
  assert.equal(failure.code, 'INJECTED_CAPTURE')
  assert.equal(failure.cleanupConfirmed, false)
  assert.equal(failure.retainedShortEnvironment, created)
  assert.equal(fs.existsSync(created), true)
})

test('Windows OpenCode short canary identity-bound remover refuses a replacement introduced at helper entry', async t => {
  const fixture = shortCanaryFixture()
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
  const staged = await stageWindowsOpenCodeShortEnvironment(fixture.input, fixture.options)
  const held = `${staged.root}.held`
  const sentinel = path.join(staged.root, 'foreign.txt')
  fixture.state.beforeOwnedRemove = target => {
    if (path.resolve(target) !== path.resolve(staged.root)) return
    fixture.state.beforeOwnedRemove = null
    fs.renameSync(staged.root, held)
    fs.mkdirSync(staged.root, { mode: 0o700 })
    fs.writeFileSync(sentinel, 'foreign', { mode: 0o600 })
  }
  await assert.rejects(removeWindowsOpenCodeShortEnvironment(staged, fixture.options))
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign')
  assert.equal(fs.existsSync(staged.recordPath), true)
})

test('Windows OpenCode short canary setup removes only its unpublished allocation on setup failure', async t => {
  const fixture = shortCanaryFixture()
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }))
  let created
  await assert.rejects(stageWindowsOpenCodeShortEnvironment(fixture.input, { ...fixture.options,
    createWindowsCompilerDirectory(prefix) { created = fs.mkdtempSync(path.join(fixture.local, prefix)); return created },
    auditPrivatePermissions() { throw Object.assign(new Error('injected DACL audit failure'), { code: 'PRIVACY_VIOLATION' }) },
  }), { code: 'PRIVACY_VIOLATION' })
  assert.equal(fs.existsSync(created), false)
  assert.equal(fs.existsSync(path.join(fixture.generation, WINDOWS_OPENCODE_SHORT_ENV_RECORD)), false)
})

test('closed canary short environment removal runs only after outer and nested drains and preserves the primary failure', async () => {
  const order = [], retained = { value: false }
  const shortEnvironment = { marker: 'short-environment' }
  await finalizeClosedCanary({ owner: { async cancelAll() { order.push('outer') } },
    env: { AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT: '/owned/nested' }, provider: 'opencode', activationId: 'a', generation: 1,
    challenge: crypto.randomBytes(32).toString('base64url'), platform: 'win32', shortEnvironment,
    async drainRegistered() { order.push('nested') }, async drainDarwinCommandDiscovery() { order.push('darwin') },
    async removeWindowsOpenCodeShortEnvironment(value) { assert.equal(value, shortEnvironment); order.push('short') },
  })
  assert.deepEqual(order, ['outer', 'nested', 'darwin', 'short'])

  const primary = Object.assign(new Error('native case failed'), { code: 'LOCAL_CANARY_FAILED' })
  await finalizeClosedCanary({ owner: { async cancelAll() { order.push('outer-failed') } },
    env: { AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT: '/owned/nested' }, provider: 'opencode', activationId: 'a', generation: 1,
    challenge: crypto.randomBytes(32).toString('base64url'), platform: 'win32', shortEnvironment, primaryError: primary,
    async drainRegistered() { order.push('nested-failed'); throw Object.assign(new Error('nested retained'), { code: 'PROCESS_DRAIN_TIMEOUT' }) },
    async drainDarwinCommandDiscovery() { order.push('darwin-failed') },
    async removeWindowsOpenCodeShortEnvironment() { retained.value = true },
  })
  assert.equal(primary.cleanupConfirmed, false)
  assert.equal(primary.cleanupFailure.code, 'PROCESS_DRAIN_TIMEOUT')
  assert.equal(retained.value, false, 'a nested drain failure must retain the short root')

  await assert.rejects(finalizeClosedCanary({ owner: { async cancelAll() { throw Object.assign(new Error('outer retained'), { code: 'PROCESS_DRAIN_TIMEOUT' }) } },
    env: { AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT: '/owned/nested' }, provider: 'opencode', activationId: 'a', generation: 1,
    challenge: crypto.randomBytes(32).toString('base64url'), platform: 'win32', shortEnvironment,
    async drainRegistered() { order.push('nested-after-outer') }, async drainDarwinCommandDiscovery() {},
    async removeWindowsOpenCodeShortEnvironment() { retained.value = true },
  }), { code: 'PROCESS_DRAIN_TIMEOUT' })
  assert.equal(retained.value, false, 'an outer drain failure must retain the short root')
})

test('closed canary establishes new Windows directories and audits existing directories without relabeling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-private-'))
  const established = []
  try {
    const generation = path.join(root, 'generation-1')
    assert.equal(claimPrivateCanaryDirectory(generation, {
      platform: 'win32',
      ensureWindowsPrivateAcl(directory) { established.push(directory) },
    }), generation)
    assert.deepEqual(established, [generation])
    let audited = false
    assert.equal(claimPrivateCanaryDirectory(generation, {
      platform: 'win32',
      allowExisting: true,
      ensureWindowsPrivateAcl() { assert.fail('an existing directory must not be relabeled') },
      auditPrivatePermissions(directory, options) {
        audited = true
        assert.equal(directory, generation)
        assert.deepEqual(options, { recurse: false })
      },
    }), generation)
    assert.equal(audited, true)
    assert.throws(() => claimPrivateCanaryDirectory(generation, {
      platform: 'win32',
      allowExisting: true,
      ensureWindowsPrivateAcl() { assert.fail('an unsafe existing directory must not be relabeled') },
      auditPrivatePermissions() { throw Object.assign(new Error('unsafe existing ACL'), { code: 'PRIVACY_VIOLATION' }) },
    }), { code: 'PRIVACY_VIOLATION' })
    const sentinel = path.join(generation, 'exclusive')
    fs.mkdirSync(sentinel)
    fs.writeFileSync(path.join(sentinel, 'foreign'), 'preserve')
    assert.throws(() => claimPrivateCanaryDirectory(sentinel, {
      platform: 'win32',
      ensureWindowsPrivateAcl() { assert.fail('an exclusive collision must not be relabeled') },
      auditPrivatePermissions() { assert.fail('an exclusive collision must not be accepted') },
    }), { code: 'EEXIST' })
    assert.equal(fs.readFileSync(path.join(sentinel, 'foreign'), 'utf8'), 'preserve')
    const file = path.join(generation, 'file')
    fs.writeFileSync(file, 'foreign')
    assert.throws(() => claimPrivateCanaryDirectory(file, {
      platform: 'win32', allowExisting: true,
      ensureWindowsPrivateAcl() { assert.fail('an existing file must not be relabeled') },
      auditPrivatePermissions() { assert.fail('an existing file must not reach ACL audit') },
    }), { code: 'RUN_RECORD_UNSAFE' })
    const linked = path.join(generation, 'linked')
    fs.symlinkSync(sentinel, linked, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => claimPrivateCanaryDirectory(linked, {
      platform: 'win32', allowExisting: true,
      ensureWindowsPrivateAcl() { assert.fail('a linked directory must not be relabeled') },
      auditPrivatePermissions() { assert.fail('a linked directory must not reach ACL audit') },
    }), { code: 'RUN_RECORD_UNSAFE' })
    const denied = path.join(generation, 'denied')
    const failure = Object.assign(new Error('exact ACL unavailable'), { code: 'PRIVACY_UNSUPPORTED' })
    assert.throws(() => claimPrivateCanaryDirectory(denied, {
      platform: 'win32',
      ensureWindowsPrivateAcl() { throw failure },
    }), error => error === failure)
    assert.equal(fs.existsSync(denied), false, 'a fresh directory with an unestablished ACL must be removed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('closed canary timeout drains registered nested child group and descendant without touching an unrelated owner', { timeout: 30000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group regression')
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-owner-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const value = binding(root); privateDirectory(value.ownershipRoot)
  const sibling = await liveOwner(root, 'unrelated-sibling')
  t.after(() => sibling.cancelAll({ reason: 'test cleanup', graceMs: 0, killMs: 1000 }))
  const outerAdapter = createPosixProcessAdapter()
  const outer = new ProcessOwner({ adapter: outerAdapter, registryPath: path.join(root, 'outer.json'), pollMs: 10 })
  const ownerModule = path.resolve(__dirname, '../../agents/codex/workflow/process-owner.js')
  const script = `
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const {ProcessOwner,createPosixProcessAdapter,prepareProcessLaunchEnvironment}=require(${JSON.stringify(ownerModule)});
    const root=process.env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT, id='claude-'+crypto.randomUUID(), dir=path.join(root,id);
    fs.mkdirSync(dir,{mode:0o700}); const registryPath=path.join(dir,'processes.json');
    fs.writeFileSync(path.join(dir,'registration.json'),JSON.stringify({schemaVersion:1,provider:process.env.AUTOPROMPT_CLOSED_CANARY_PROVIDER,activationId:process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID,generation:Number(process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION),challenge:process.env.AUTOPROMPT_CLOSED_CANARY_CHALLENGE,registryPath}),{mode:0o600});
    const adapter=createPosixProcessAdapter(), owner=new ProcessOwner({adapter,registryPath,pollMs:10}), reservationId='nested-'+crypto.randomUUID();
    owner.launch({executable:process.execPath,argv:['-e',\"require('node:child_process').spawn('sleep',['30'],{stdio:'ignore'});setTimeout(()=>{},30000)\"],cwd:dir,env:prepareProcessLaunchEnvironment(adapter,reservationId,{PATH:process.env.PATH}),reservationId,sessionId:reservationId,targetKey:'nested',stdin:'ignore',stdout:'ignore',stderr:'ignore',forWork:false}).then(()=>setInterval(()=>{},1000));
  `
  await assert.rejects(ownedTest(outer, root, environment(value), ['-e', script], 700), { code: 'LOCAL_CANARY_TIMEOUT' })
  assert.deepEqual(outer.ownershipIdentities(), [])
  assert.ok(sibling.ownershipIdentities().length === 1, 'timeout recovery signalled unrelated owner')
  await drainRegistered(value.ownershipRoot, value)
  for (const entry of fs.readdirSync(value.ownershipRoot)) {
    const registry = path.join(value.ownershipRoot, entry, 'processes.json')
    if (fs.existsSync(registry)) {
      const recovered = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: registry, pollMs: 10 })
      await recovered.cancelAll({ reason: 'assert drained', graceMs: 0, killMs: 1000 })
      assert.deepEqual(recovered.ownershipIdentities(), [])
    }
  }
})

test('closed canary waits for its actual outer root after a payload completion callback, then persists a drained terminal', { timeout: 30000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group regression')
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-root-exit-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(root, 'outer.json'), pollMs: 10 })
  const began = Date.now()
  const result = await ownedTest(owner, root, { PATH: process.env.PATH }, ['-e', 'process.exit(0)'], 5000, undefined, { postStatusDelayMs: 150 })
  assert.equal(result.code, 0)
  assert.ok(Date.now() - began >= 120, 'completion callback must not be treated as the outer root exit')
  const [record] = owner.listRecords()
  assert.equal(record.status, 'DONE')
  assert.equal(record.rootExit.code, 0)
  assert.equal(record.terminal.reason, 'root exited and group drained')
  assert.deepEqual(owner.ownershipIdentities(), [])
})

test('foreign or malformed nested registration is rejected without signalling its unregistered owner', { timeout: 30000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group regression')
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-owner-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const value = binding(root); privateDirectory(value.ownershipRoot)
  const sibling = await liveOwner(root, 'foreign-sibling')
  t.after(() => sibling.cancelAll({ reason: 'test cleanup', graceMs: 0, killMs: 1000 }))
  const foreign = privateDirectory(path.join(value.ownershipRoot, 'foreign'))
  fs.writeFileSync(path.join(foreign, 'registration.json'), JSON.stringify({ schemaVersion: 1, provider: 'other', activationId: value.activationId,
    generation: value.generation, challenge: value.challenge, registryPath: path.join(root, 'foreign-sibling.json') }), { mode: 0o600 })
  await assert.rejects(drainRegistered(value.ownershipRoot, value), { code: 'LOCAL_CANARY_INVALID' })
  assert.equal(sibling.ownershipIdentities().length, 1, 'foreign registration caused a signal outside the canary root')
})

test('closed runner accepts exact successful cases and retains activation-bound observations', { timeout: 30000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group regression')
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-runner-success-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = 'native-case.cjs'
  const bytes = Buffer.from(`const test=require('node:test'),assert=require('node:assert/strict');test('specific native witness',()=>{assert.equal(process.env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID,'actual-activation');assert.equal(process.env.AUTOPROMPT_CLOSED_CANARY_GENERATION,'7');assert.match(process.env.AUTOPROMPT_CLOSED_CANARY_CHALLENGE,/^[A-Za-z0-9_-]{43}$/);});`)
  fs.writeFileSync(path.join(root, source), bytes, { mode: 0o600 })
  const hash = value => crypto.createHash('sha256').update(value).digest('hex')
  const executable = { path: process.execPath, sha256: hash(fs.readFileSync(process.execPath)) }
  const activation = { activationId: 'actual-activation', activationRoot: path.join(root, 'activation'), executable,
    installed: { bundle: root, payloadDigest: hash('payload') }, enforcementProof: { sha256: hash('proof') },
    record: { capability: { generation: 7, expiresAt: new Date(Date.now() + 60000).toISOString() }, request: { sha256: hash('request') }, target: { realpath: root }, connectionSha256: hash('connection') } }
  privateDirectory(activation.activationRoot)
  const result = await require('../../scripts/harness-v2-closed-canary.cjs').run({ activation, executable, provider: 'claude',
    pending: { expiresAt: new Date(Date.now() + 60000).toISOString(), reviewDigest: hash('unit-only-review'), capabilityCases: {
      testCapability: { source, sha256: hash(bytes), testName: 'specific native witness' },
    } } })
  assert.equal(result.observations.length, 1)
  assert.equal(result.observations[0].status, 'passed')
  const observation = JSON.parse(fs.readFileSync(result.artifacts[0].path, 'utf8'))
  assert.equal(observation.activationId, 'actual-activation')
  assert.equal(observation.generation, 7)
  assert.equal(observation.challenge, result.challenge)
  const runner = require('../../scripts/harness-v2-closed-canary.cjs')
  const past = { ...activation, activationRoot: path.join(root, 'expired'), record: { ...activation.record, capability: { generation: 7, expiresAt: new Date(Date.now() - 1).toISOString() } } }
  await assert.rejects(runner.run({ activation: past, executable, provider: 'claude', pending: { expiresAt: new Date(Date.now() + 60000).toISOString() } }), { code: 'LOCAL_CANARY_EXPIRED' })
  assert.equal(fs.existsSync(past.activationRoot), false, 'expired activation must not create native launch state')
  const expiredReview = { ...activation, activationRoot: path.join(root, 'expired-review') }
  await assert.rejects(runner.run({ activation: expiredReview, executable, provider: 'claude', pending: { expiresAt: new Date(Date.now() - 1).toISOString() } }), { code: 'LOCAL_CANARY_EXPIRED' })
  assert.equal(fs.existsSync(expiredReview.activationRoot), false, 'expired review must not create native launch state')
  const held = Buffer.from(`const test=require('node:test');test('held deadline witness',async()=>{await new Promise(resolve=>setTimeout(resolve,10000));});`)
  fs.writeFileSync(path.join(root, source), held)
  const short = { ...activation, activationRoot: path.join(root, 'short'), record: { ...activation.record, capability: { generation: 8, expiresAt: new Date(Date.now() + 750).toISOString() } } }
  privateDirectory(short.activationRoot)
  const began = Date.now()
  await assert.rejects(runner.run({ activation: short, executable, provider: 'claude', pending: { expiresAt: new Date(Date.now() + 60000).toISOString(), reviewDigest: hash('unit-only-review'), capabilityCases: { testCapability: { source, sha256: hash(held), testName: 'held deadline witness' } } } }), { code: 'LOCAL_CANARY_TIMEOUT' })
  assert.ok(Date.now() - began < 5000, 'activation deadline must bound a held native test batch')
})

test('closed canary discovers and drains a secondary command owner registered below a separate fixture-native root', { timeout: 30000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group regression')
  const root = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-command-discovery-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const value = binding(root)
  const commandBinding = { provider: value.provider, activationId: value.activationId, generation: value.generation }
  privateDirectory(value.ownershipRoot)
  const discovery = require('../../scripts/harness-v2-command-owner-discovery.cjs')
  const nativeRoot = privateDirectory(path.join(root, 'fixture-controller', 'native'))
  const target = privateDirectory(path.join(root, 'candidate'))
  const scratch = privateDirectory(path.join(root, 'scratch'))
  const policyRoot = privateDirectory(path.join(nativeRoot, 'fixture-session', 'tool-policy'))
  const stateRoot = path.join(policyRoot, discovery.STATE_CHILD)
  const commandOwner = {
    schemaVersion: 1,
    manifestRoot: discovery.createDiscoveryRoot(nativeRoot, commandBinding),
    providerPrivateOwnershipRoot: nativeRoot,
    stateRoot,
    registryPath: path.join(stateRoot, 'processes.json'),
    controlRoot: path.join(stateRoot, 'process-control'),
    nodeExecutable: { path: process.execPath, sha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') },
  }
  const policy = {
    provider: value.provider, activationId: value.activationId, generation: value.generation,
    targetPath: target, scratchPath: scratch, readableRoots: [target, scratch], writableRoots: [scratch],
    darwinCommandOwner: commandOwner,
  }
  const policyPath = path.join(policyRoot, 'policy.json')
  const policyBytes = Buffer.from(JSON.stringify(policy))
  fs.writeFileSync(policyPath, policyBytes, { mode: 0o600 })
  const policySha256 = crypto.createHash('sha256').update(policyBytes).digest('hex')
  const registration = discovery.register(policyPath, policySha256, commandOwner.manifestRoot, commandBinding)
  assert.equal(registration.registryPath, commandOwner.registryPath)
  const pointer = discovery.registerCanaryDiscovery(policyPath, policySha256, commandOwner, environment(value))
  assert.ok(pointer)
  const adapter = createPosixProcessAdapter()
  const owner = new ProcessOwner({ adapter, registryPath: commandOwner.registryPath, pollMs: 10 })
  const reservationId = `secondary-${crypto.randomUUID()}`
  const launched = await owner.launch({ executable: process.execPath, argv: ['-e', 'setTimeout(()=>{},30000)'], cwd: nativeRoot,
    env: prepareProcessLaunchEnvironment(adapter, reservationId, { PATH: process.env.PATH }), reservationId, sessionId: reservationId,
    targetKey: 'fixture-secondary', stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', forWork: false })
  t.after(() => owner.cancelAll({ reason: 'test cleanup', graceMs: 0, killMs: 1000 }).catch(() => {}))
  assert.ok((await adapter.listOwned(launched.groupIdentity)).length > 0)
  const result = await discovery.drainTrustedProviderRoot(nativeRoot, commandBinding, {
    platform: 'linux', createPlatformAdapter: createPosixProcessAdapter, environment: environment(value),
  })
  assert.deepEqual(result, { discovered: 1 })
  assert.deepEqual(await adapter.listOwned(launched.groupIdentity), [])
  assert.deepEqual(discovery.unregisterCanaryDiscovery(policyPath, policySha256, commandOwner, environment(value)), { removed: false })
  const recovered = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: commandOwner.registryPath, pollMs: 10 })
  await recovered.recoverReservations()
  await recovered.assertDrained()
})
