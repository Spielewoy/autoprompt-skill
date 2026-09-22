'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { ownedTest, drainRegistered, claimPrivateCanaryDirectory, closedCanaryBatchTimeout } = require('../../scripts/harness-v2-closed-canary.cjs')

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
    status: `${stem}.status.json`, stdoutPath: `${stem}.stdout.log`, stderrPath: `${stem}.stderr.log`, postStatusDelayMs: 0 }
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
    stdoutPath: `${malformedStem}.stdout.log`, stderrPath: `${malformedStem}.stderr.log` }))
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
    status: `${overflowStem}.status.json`, stdoutPath: `${overflowStem}.stdout.log`, stderrPath: `${overflowStem}.stderr.log` }
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
    "process.stdout.write('live-stdout\\n');process.stderr.write('live-stderr\\n');setTimeout(()=>{},30000)"], 500), { code: 'LOCAL_CANARY_TIMEOUT' })
  const stdoutPath = fs.readdirSync(root).find(name => /^outer-[a-f0-9-]{36}\.stdout\.log$/.test(name))
  const stderrPath = fs.readdirSync(root).find(name => /^outer-[a-f0-9-]{36}\.stderr\.log$/.test(name))
  assert.equal(fs.readFileSync(path.join(root, stdoutPath), 'utf8'), 'live-stdout\n')
  assert.equal(fs.readFileSync(path.join(root, stderrPath), 'utf8'), 'live-stderr\n')
  assert.equal(fs.readdirSync(root).some(name => /^outer-[a-f0-9-]{36}\.status\.json$/.test(name)), false)
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
  let abortCancelled = false
  const abortOwner = {
    adapter: { async listOwned() { controller.abort(); return [] } },
    async launch() { return { ownershipId: 'query-abort', groupIdentity: 'query-abort-group' } },
    async cancelAll() { abortCancelled = true },
  }
  try {
    await assert.rejects(ownedTest(abortOwner, abortRoot, environment(abortValue), ['-e', 'process.exit(0)'],
      10000, controller.signal), { code: 'CHILD_CANCELLED' })
    assert.equal(abortCancelled, true)
  } finally { fs.rmSync(abortRoot, { recursive: true, force: true }) }

  const deadlineRoot = privateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'closed-canary-query-deadline-')))
  const deadlineValue = binding(deadlineRoot); privateDirectory(deadlineValue.ownershipRoot)
  let now = 100, requestPath, deadlineCancelled = false
  const deadlineOwner = {
    adapter: { async listOwned() {
      now = 111
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
      fs.writeFileSync(request.status, JSON.stringify({ code: 0, signal: null, error: null, stdout: '', stderr: '' }))
      return []
    } },
    async launch(spec) { requestPath = spec.argv[2]; return { ownershipId: 'query-deadline', groupIdentity: 'query-deadline-group' } },
    async cancelAll() { deadlineCancelled = true },
  }
  try {
    await assert.rejects(ownedTest(deadlineOwner, deadlineRoot, environment(deadlineValue), ['-e', 'process.exit(0)'],
      10, undefined, { wallNowMs: () => now }), { code: 'LOCAL_CANARY_TIMEOUT' })
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
