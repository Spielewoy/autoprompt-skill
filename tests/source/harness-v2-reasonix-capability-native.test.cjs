'use strict'
// Every case drives the installed native CLI through the production adapter.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), test = require('node:test')
const { realFixture, resultPayload, assertNativeSurface } = require('./reasonix-controlled-native.test.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const native = require('../../agents/reasonix/workflow/native.js')
const { ReasonixExecAdapter } = require('../../agents/reasonix/workflow/transport.js')
const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')
const { privateDirectory, nativeProcessAdapter, nodeCommand, readCommand, withChallenge } = require('../helpers/native-platform.cjs')
const options = { skip: !process.env.AUTOPROMPT_REASONIX_TEST_CLI, timeout: 90000 }
const named = (name, fn) => test(`reasonix closed native capability: ${name}`, options, fn)
const results = f => f.events.filter(event => event.kind === 'tool_result').map(event => resultPayload(event.tool))
async function ready(t, command, extra = {}) {
  const f = await realFixture(t, [{ tool: 'bash', args: f => ({ command: withChallenge(command ? command(f) : nodeCommand("process.stdout.write('owned-native')"), f.challenge) }) }], extra)
  for (const directory of [f.root, f.target, f.controller, f.nativeRoot]) privateDirectory(directory)
  fs.writeFileSync(path.join(f.target, 'candidate.txt'), 'immutable-candidate')
  fs.writeFileSync(path.join(f.controller, 'private.txt'), 'private-controller-secret')
  return f
}
function good(f, result) {
  assert.equal(result.ok, true); assert.ok(result.contextId); assertNativeSurface(f)
  assert.ok(results(f).some(value => value.output.includes(`CLOSED_CANARY_CHALLENGE:${f.challenge}`)), 'native receipt must return the exact challenge')
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate) { for (let i = 0; i < 1500 && !predicate(); i++) await delay(10); assert.ok(predicate(), 'native request did not reach the required state') }
named('isolation', async t => {
  const net = require('node:net'); let contacted = false
  const server = net.createServer(socket => { contacted = true; socket.destroy() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const code = `const s=require('node:net').connect(${server.address().port},'127.0.0.1');s.on('connect',()=>process.exit(19));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),700)`
  const f = await ready(t, f => `${readCommand(path.join(f.target, 'candidate.txt'))}; ${nodeCommand(
    `require('node:fs').writeFileSync(${JSON.stringify(path.join(f.scratch, 'proof'))}, 'writable'); try { require('node:fs').writeFileSync(${JSON.stringify(path.join(f.target, 'candidate.txt'))}, 'bad'); process.exit(19) } catch {} ; try { require('node:fs').readFileSync(${JSON.stringify(path.join(f.controller, 'private.txt'))}); process.exit(20) } catch {} ; ${code}`
  )}`)
  good(f, await f.launch()); assert.equal(fs.readFileSync(path.join(f.target, 'candidate.txt'), 'utf8'), 'immutable-candidate'); assert.equal(fs.readFileSync(path.join(f.scratch, 'proof'), 'utf8'), 'writable'); assert.equal(contacted, false)
})
named('topology', async t => {
  const f = await realFixture(t, [{ name: 'task', args: { description: 'forbidden nested dispatch', prompt: 'write forbidden marker' } }])
  await assert.rejects(f.launch(), { code: 'ROLE_POLICY_DENIED' }); assert.ok(f.requests.length > 0); assert.deepEqual(fs.readdirSync(f.target), [])
  assert.ok(JSON.stringify(f.requests).includes(`CLOSED_CANARY_CHALLENGE:${f.challenge}`))
})
named('privateConfiguration', async t => {
  const f = await ready(t, () => nodeCommand("if (process.env.FIXTURE_KEY || process.env.UNRELATED_SECRET) process.exit(20); process.stdout.write('filtered')"))
  const poison = 'UNTRUSTED_AMBIENT_INSTRUCTIONS_92751'; fs.writeFileSync(path.join(f.target, 'AGENTS.md'), poison); fs.writeFileSync(path.join(f.target, 'REASONIX.md'), poison)
  good(f, await f.launch()); assert.equal(JSON.stringify(f.requests).includes(poison), false); assert.equal(JSON.stringify(f.events).includes('not-a-configured-provider-key'), false); assert.ok(results(f)[0].output.includes('filtered'))
})
named('intermediateEvents', async t => {
  const f = await ready(t); const output = await f.launch(); good(f, output)
  assert.ok(f.events.some(e => e.kind === 'tool_dispatch')); assert.ok(f.events.some(e => e.kind === 'tool_result')); assert.ok(output.transportEvidence.eventCount >= 4)
  assert.ok(f.events.some(e => JSON.stringify(e).includes(output.contextId)))
})
named('exactToolOutput', async t => {
  const f = await ready(t, () => nodeCommand("process.stdout.write('exact UTF-8: 雪 / é / 😀\\nsecond line\\n')")); const output = await f.launch(); good(f, output)
  const actual = results(f)[0]; assert.equal(actual.output, `exact UTF-8: 雪 / é / 😀\nsecond line\n\nCLOSED_CANARY_CHALLENGE:${f.challenge}\n`); assert.equal(actual.outputSha256, native.sha256(actual.output)); assert.equal(output.toolReceiptHashes.length, 1)
})
named('concurrency', async t => {
  const gates = []; const f = await realFixture(t, [], { responseGate: () => new Promise(resolve => gates.push(resolve)) })
  t.after(() => gates.forEach(resolve => resolve()))
  const first = f.launch(); first.catch(() => {}); await waitFor(() => gates.length === 1)
  const second = f.launch({ sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() }); second.catch(() => {}); await waitFor(() => gates.length === 2)
  assert.equal(f.owner.ownershipIdentities().length, 2); gates.forEach(resolve => resolve()); const outputs = await Promise.all([first, second]); assert.ok(outputs.every(o => o.ok)); assert.notEqual(outputs[0].contextId, outputs[1].contextId); assert.deepEqual(f.owner.ownershipIdentities(), [])
})
named('resume', async t => {
  const f = await ready(t); const first = await f.launch(); good(f, first); const before = f.requests.length
  const resumed = await f.launch({ reservationId: crypto.randomUUID(), continuationId: first.contextId }); assert.equal(resumed.contextId, first.contextId); assert.ok(JSON.stringify(f.requests.slice(before)).includes(`CLOSED_CANARY_CHALLENGE:${f.challenge}`))
  const foreign = privateDirectory(path.join(f.root, 'foreign'))
  await assert.rejects(f.launch({ reservationId: crypto.randomUUID(), continuationId: first.contextId, workingDirectory: foreign }), { code: 'SESSION_ID_MISMATCH' })
})
named('cancellation', async t => {
  const gates = []; const f = await realFixture(t, [], { responseGate: () => new Promise(resolve => gates.push(resolve)) }); t.after(() => gates.forEach(resolve => resolve()))
  const abort = new AbortController(); const first = f.launch({ signal: abort.signal }); first.catch(() => {}); await waitFor(() => gates.length === 1)
  const second = f.launch({ sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() }); second.catch(() => {}); await waitFor(() => gates.length === 2)
  assert.equal(f.owner.ownershipIdentities().length, 2); abort.abort(); await assert.rejects(first, { code: 'CHILD_CANCELLED' }); assert.equal(f.owner.ownershipIdentities().length, 1); gates[1](); assert.equal((await second).ok, true); assert.deepEqual(f.owner.ownershipIdentities(), [])
})
named('checker', async t => {
  let frozen, scratch
  const f = await ready(t, () => `${readCommand(path.join(frozen, 'candidate.txt'))}; ${nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(path.join(scratch, 'proof'))}, 'checked'); try { require('node:fs').writeFileSync(${JSON.stringify(path.join(frozen, 'candidate.txt'))}, 'bad'); process.exit(19) } catch {}`)}`)
  frozen = f.target; scratch = privateDirectory(path.join(f.root, 'checker'))
  for (const name of ['tmp', 'output', 'cache']) privateDirectory(path.join(scratch, name))
  const checker = { schemaVersion: 1, capability: native.sha256('checker-boundary'), runId: f.record.activationId, checkerId: 'native-checker', candidateHash: native.sha256('immutable-candidate'), frozenCandidateRoot: frozen, writableScratchRoot: scratch, temporaryRoot: path.join(scratch, 'tmp'), outputRoot: path.join(scratch, 'output'), cacheRoot: path.join(scratch, 'cache') }
  f.adapter.checkerScratchVerifier = () => checker
  const result = await f.launch({ logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', workingDirectory: scratch, canonicalTargetPath: frozen, candidateHash: checker.candidateHash, checkerScratchBoundary: checker, physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } } })
  good(f, result); assert.equal(fs.readFileSync(path.join(frozen, 'candidate.txt'), 'utf8'), 'immutable-candidate'); assert.equal(fs.readFileSync(path.join(scratch, 'proof'), 'utf8'), 'checked')
})
named('processOwnership', async t => {
  const f = await realFixture(t, [], { hang: true }); const abort = new AbortController(); const pending = f.launch({ signal: abort.signal }); pending.catch(() => {}); await waitFor(() => f.requests.length > 0)
  const recovered = new ProcessOwner({ adapter: nativeProcessAdapter(f.owner.registryPath, path.dirname(f.owner.registryPath)), registryPath: f.owner.registryPath, pollMs: 10 }); await recovered.recoverReservations(); assert.equal(recovered.ownershipIdentities().length, 1)
  await recovered.cancelAll({ reason: 'native recovery proof', graceMs: 0, killMs: 5000, waitForPending: true }); abort.abort(); await assert.rejects(pending); await f.owner.cancelAll({ reason: 'reconcile recovered exit', graceMs: 0, killMs: 5000, waitForPending: true }); assert.deepEqual(recovered.ownershipIdentities(), []); assert.deepEqual(f.owner.ownershipIdentities(), [])
})
named('modelEffort', async t => {
  const f = await ready(t); const output = await f.launch({ assignment: { model: 'fixture', effort: 'low' } }); good(f, output)
  assert.ok(f.requests.every(r => r.model === 'fixture')); assert.ok(f.requests.every(r => r.reasoning_effort === 'low'), JSON.stringify(f.requests.map(r => ({model:r.model,effort:r.reasoning_effort}))))
  await assert.rejects(f.launch({ sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), assignment: { model: 'fixture', effort: 'unauthorized' } }))
})

named('checker wire description projection', async t => {
  const outcomeSchema = require('../../agents/contracts/schemas/outcome.schema.json')
  const expectedDescription = outcomeSchema.allOf.find(clause => Array.isArray(clause.oneOf)).oneOf
    .find(branch => branch.properties?.code?.const === 'PASS').properties.description.const
  const hash = 'a'.repeat(64)
  const wirePass = {
    schemaVersion: '2.0.0', code: 'PASS', stateClass: 'terminal', runId: 'checker-run-1',
    requestEnvelopeHash: hash, currentVersionHash: hash, completedResults: [], nextReadyWork: [],
    cause: { event: 'CHECK_COMPLETE', reason: 'The local checker completed.', unblockPath: null },
    payloadSchemaId: 'autoprompt.independent-check.v2', payload: {}, recordedAt: '2026-09-08T00:00:00.000Z',
  }
  const checkerLaunch = f => ({
    logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker',
    physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } },
  })
  const f = await realFixture(t, [], { result: wirePass })
  fs.writeFileSync(f.schema, JSON.stringify(outcomeSchema))
  const terminalMetadata = []
  const accepted = await f.launch({ ...checkerLaunch(f), onTerminalResult: (_result, metadata) => terminalMetadata.push(metadata) })
  assert.equal(accepted.code, 'PASS')
  assert.equal(accepted.description, expectedDescription)
  assert.equal(Object.hasOwn(wirePass, 'description'), false)
  const nativeTerminal = f.events.find(event => event.type === 'result')
  assert.ok(nativeTerminal)
  assert.equal(Object.hasOwn(JSON.parse(nativeTerminal.result), 'description'), false, 'the native terminal and its raw receipt remain unmodified')
  assert.equal(terminalMetadata.length, 1)
  assert.equal(terminalMetadata[0].nativeWireProjection.version, 'native-outcome-description-v2')
  assert.match(terminalMetadata[0].nativeWireProjection.schemaSha256, /^[a-f0-9]{64}$/)
  assertNativeSurface(f)

  const fWrong = await realFixture(t, [], { result: { ...wirePass, description: 'contradictory model prose' } })
  fs.writeFileSync(fWrong.schema, JSON.stringify(outcomeSchema))
  await assert.rejects(fWrong.launch(checkerLaunch(fWrong)), { code: 'CHILD_RESULT_INVALID' })
  const wrongTerminal = fWrong.events.find(event => event.type === 'result')
  assert.ok(wrongTerminal)
  assert.equal(JSON.parse(wrongTerminal.result).description, 'contradictory model prose')
  assertNativeSurface(fWrong)
})
