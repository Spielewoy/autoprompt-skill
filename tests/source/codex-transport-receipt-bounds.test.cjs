#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  CodexExecAdapter, OwnedCodexProxyRunner, bindCanonicalMissionForChild,
  createCanonicalMissionProjection, createCodexJsonlAccumulator, withTimeout,
} = require(
  path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js'),
)

const EXECUTION_POLICY = Object.freeze({
  logicalRole: 'worker',
  physicalRole: 'autoprompt.v2.worker',
  providerRole: 'ap-worker',
  sandboxMode: 'workspace-write',
  policyId: 'autoprompt.codex.role-policy',
  policyVersion: '2.0.0',
})

function canonicalWorkerResult() {
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: 'bounded-transport-result',
    runId: 'run-transport', assignmentId: 'work-transport', logicalRoleId: 'worker',
    physicalRoleId: 'autoprompt.v2.worker', requestEnvelopeHash: 'a'.repeat(64),
    findingIds: ['AP-RUN-026'], startedAt: '2026-08-27T12:00:00.000Z',
    endedAt: '2026-08-27T12:00:01.000Z', filesChanged: [], resourcesChanged: [],
    behaviorChanged: ['Completed the bounded transport fixture.'],
    commands: [{ command: 'true', exitCode: 0, result: 'passed' }],
    successItems: [{ id: 'fixture', status: 'pass', evidenceIds: ['command:true'] }],
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: {
      event: 'WORK_ITEM_VERIFIED', reason: 'Fixture passed.', invalidateEvidenceIds: [],
    },
  }
}

test('Codex JSONL retention evicts oldest parsed events by total bytes without losing stream identity', () => {
  const accumulator = createCodexJsonlAccumulator()
  const eventHash = crypto.createHash('sha256')
  const rawOutputHash = crypto.createHash('sha256')
  eventHash.update('[')
  let eventCount = 0
  const push = event => {
    const line = JSON.stringify(event)
    eventHash.update(eventCount === 0 ? '' : ',').update(line)
    rawOutputHash.update(`${line}\n`)
    eventCount += 1
    accumulator.push(line, eventCount)
  }
  push({ type: 'thread.started', thread_id: '38383838-3838-4838-8838-383838383838' })
  const largePayload = 'p'.repeat(512 * 1024)
  for (let index = 0; index < 24; index += 1) {
    push({
      type: 'item.completed',
      item: { id: `large-reasoning-${index}`, type: 'reasoning', text: `${index}:${largePayload}` },
    })
  }
  const terminalOutput = { outcome: 'DONE', marker: 'terminal-parsing-preserved' }
  push({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(terminalOutput) },
  })
  push({
    type: 'turn.completed',
    usage: {
      input_tokens: 10, cached_input_tokens: 2,
      output_tokens: 3, reasoning_output_tokens: 1,
    },
  })

  const snapshot = accumulator.snapshot()
  const measuredRetainedBytes = snapshot.events.reduce(
    (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
    0,
  )
  assert.deepEqual({
    eventCount: snapshot.eventCount,
    retainedEventCount: snapshot.retainedEventCount,
    retainedEventBytes: snapshot.retainedEventBytes,
    measuredRetainedBytes,
    terminalOutput: snapshot.output,
    boundaryReached: accumulator.boundaryReached(),
  }, {
    eventCount,
    retainedEventCount: snapshot.events.length,
    retainedEventBytes: measuredRetainedBytes,
    measuredRetainedBytes,
    terminalOutput,
    boundaryReached: true,
  })
  assert.ok(snapshot.retainedEventBytes <= 8 * 1024 * 1024)
  assert.ok(snapshot.retainedEventCount < snapshot.eventCount)
  assert.notEqual(snapshot.events[0].item && snapshot.events[0].item.id, 'large-reasoning-0')
  assert.equal(snapshot.events.at(-1).type, 'turn.completed')
  assert.equal(snapshot.eventStreamHash, eventHash.copy().update(']').digest('hex'))
  assert.equal(snapshot.rawOutputHash, rawOutputHash.digest('hex'))
})

test('Codex JSONL rejects unbounded unique todo identities without counting the rejected event', () => {
  const accumulator = createCodexJsonlAccumulator()
  for (let index = 0; index < 1024; index += 1) {
    accumulator.push(JSON.stringify({
      type: 'item.started',
      item: { id: `todo-${index}`, type: 'todo_list' },
    }), index + 1)
  }
  accumulator.push(JSON.stringify({
    type: 'item.updated',
    item: { id: 'todo-0', type: 'todo_list' },
  }), 1025)
  const beforeRejected = accumulator.snapshot()
  assert.throws(
    () => accumulator.push(JSON.stringify({
      type: 'item.started',
      item: { id: 'todo-overflow', type: 'todo_list' },
    }), 1026),
    error => error.code === 'CODEX_EVENT_STREAM_INVALID' &&
      error.details.maximumUniqueTodoItemIds === 1024 &&
      error.details.uniqueTodoItemIds === 1024,
  )
  const afterRejected = accumulator.snapshot()
  assert.equal(beforeRejected.eventCount, 1025)
  assert.equal(afterRejected.eventCount, beforeRejected.eventCount)
  assert.equal(afterRejected.eventStreamHash, beforeRejected.eventStreamHash)
  assert.equal(afterRejected.rawOutputHash, beforeRejected.rawOutputHash)
})

test('terminal Codex transport externalizes huge streams into bounded hash/count receipts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-transport-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const sentinel = `RAW_TOOL_OUTPUT_MUST_NOT_REACH_TERMINAL_RECEIPT_${'x'.repeat(16 * 1024)}`
  const noisyEvents = Array.from({ length: 300 }, (_, index) => ({
    type: 'item.completed',
    item: { id: `reasoning-${index}`, type: 'reasoning', text: `${index}:${sentinel}` },
  }))
  const output = canonicalWorkerResult()
  const events = [
    { type: 'thread.started', thread_id: '27272727-2727-4727-8727-272727272727' },
    ...noisyEvents,
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: JSON.stringify({ canonicalJson: JSON.stringify(output) }),
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 19000, cached_input_tokens: 1000,
        output_tokens: 2000, reasoning_output_tokens: 1500,
      },
    },
  ]
  let terminalResult = null
  let terminalEvidence = null
  let transportActivityCount = 0
  const adapter = new CodexExecAdapter({
    runner: {
      async run(spec) {
        for (const event of events) spec.onStdoutLine(JSON.stringify(event))
        return {
          status: 0, stdout: '', stderr: '', processOwned: true, exactArgv: true, drained: true,
        }
      },
      async stop() { return { drained: true } },
    },
    targetPath: ROOT,
    profilePath: path.join(ROOT, 'agents', 'codex', 'autoprompt.config.toml'),
    outputSchemaResolver: () => path.join(
      ROOT, 'agents', 'contracts', 'schemas', 'role-report.schema.json',
    ),
    providerSchemaRoot: path.join(directory, 'provider-schemas'),
  })
  const missionProjection = createCanonicalMissionProjection('Complete the bounded transport fixture.')
  const activationId = 'transport-bounds-activation'
  const generation = 1
  const workItemId = 'work-transport'
  const requestEnvelopeHash = 'hash'
  const result = await adapter.launch({
    ...EXECUTION_POLICY,
    activationId, generation, workItemId,
    canonicalMission: missionProjection.canonicalMission,
    missionBinding: bindCanonicalMissionForChild(missionProjection, {
      sourceRequestHash: missionProjection.sourceRequestHash,
      requestEnvelopeHash,
      activationId,
      generation,
      workItemId,
    }),
    physicalExecutionPolicy: EXECUTION_POLICY,
    dispatch: {
      brief: 'Do the bounded work.', requestPointer: { path: 'request', hash: requestEnvelopeHash },
    },
    environment: {}, sessionId: 'transport-bounds', reservationId: 'transport-bounds-reservation',
    onTransportActivity() { transportActivityCount += 1 },
    onTerminalResult(value, evidence) {
      terminalResult = value
      terminalEvidence = evidence
    },
  })

  await t.test('terminal result contains no retained raw event array or huge payload', () => {
    const serialized = JSON.stringify(result)
    assert.deepEqual({
      hasEvents: Object.hasOwn(result, 'events'),
      containsRawToolOutput: serialized.includes('RAW_TOOL_OUTPUT_MUST_NOT_REACH_TERMINAL_RECEIPT'),
      boundedBelow64KiB: Buffer.byteLength(serialized, 'utf8') < 64 * 1024,
    }, {
      hasEvents: false,
      containsRawToolOutput: false,
      boundedBelow64KiB: true,
    })
    assert.deepEqual(result, terminalResult)
  })

  await t.test('bounded transport evidence preserves stream counts and hashes', () => {
    const evidence = result.transportEvidence
    assert.deepEqual({
      schemaVersion: evidence.schemaVersion,
      eventCount: evidence.eventCount,
      retainedEventCount: evidence.retainedEventCount,
    }, {
      schemaVersion: 1,
      eventCount: events.length,
      retainedEventCount: 256,
    })
    assert.match(evidence.eventStreamHash, /^[a-f0-9]{64}$/)
    assert.match(evidence.rawOutputHash, /^[a-f0-9]{64}$/)
    assert.equal(transportActivityCount, events.length)
  })

  await t.test('separate terminal receipt contains only bounded audit metadata', () => {
    const serialized = JSON.stringify(terminalEvidence)
    assert.deepEqual({
      hasEvents: Object.hasOwn(terminalEvidence, 'events'),
      containsRawToolOutput: serialized.includes('RAW_TOOL_OUTPUT_MUST_NOT_REACH_TERMINAL_RECEIPT'),
    }, {
      hasEvents: false,
      containsRawToolOutput: false,
    })
    assert.match(terminalEvidence.eventStreamHash, /^[a-f0-9]{64}$/)
    assert.match(terminalEvidence.rawOutputHash, /^[a-f0-9]{64}$/)
    assert.equal(terminalEvidence.eventStreamHash, result.transportEvidence.eventStreamHash)
    assert.equal(terminalEvidence.rawOutputHash, result.transportEvidence.rawOutputHash)
  })
})

test('transport watchdog measures inactivity instead of total child runtime', async () => {
  const timerApi = { setTimeout, clearTimeout }
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const result = await withTimeout(
    async refresh => {
      for (let index = 0; index < 4; index += 1) {
        await delay(10)
        assert.equal(refresh(), true)
      }
      return 'completed-after-multiple-watchdog-windows'
    },
    20,
    timerApi,
    'CHILD_TRANSPORT_TIMEOUT',
  )
  assert.equal(result, 'completed-after-multiple-watchdog-windows')

  await assert.rejects(
    withTimeout(
      () => new Promise(() => {}),
      5,
      timerApi,
      'CHILD_TRANSPORT_TIMEOUT',
    ),
    error => error.code === 'CHILD_TRANSPORT_TIMEOUT',
  )
})

test('owned Codex proxy streams every complete large-output line while retaining only bounded tails', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-owned-proxy-bounds-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const controlRoot = path.join(directory, 'control')
  fs.mkdirSync(controlRoot)
  const payload = 'z'.repeat(8 * 1024)
  const lineCount = 2048
  const stdout = Buffer.from(Array.from({ length: lineCount }, (_, index) => JSON.stringify({
    type: 'item.completed', item: { type: 'reasoning', text: `${index}:${payload}` },
  })).join('\n') + '\n')
  const stderr = Buffer.from(`stderr-prefix\n${'e'.repeat(2 * 1024 * 1024)}\nstderr-tail\n`)
  const owner = {
    async launch(spec) {
      const request = JSON.parse(fs.readFileSync(spec.argv.at(-1), 'utf8'))
      fs.writeFileSync(request.stdoutPath, stdout)
      fs.writeFileSync(request.stderrPath, stderr)
      fs.writeFileSync(request.statusPath, `${JSON.stringify({
        schemaVersion: 2,
        activationId: request.activationId,
        generationId: request.generationId,
        sequence: request.sequence,
        argvHash: request.argvHash,
        codexPid: 4242,
        code: 0,
        signal: null,
        error: null,
      })}\n`)
      return { ownershipId: 'large-output-owner', groupIdentity: 'large-output-group' }
    },
    async observeRootExit() {
      return {
        ownershipId: 'large-output-owner', groupIdentity: 'large-output-group', status: 'DONE',
      }
    },
    async cancelGroup() {
      return {
        ownershipId: 'large-output-owner', groupIdentity: 'large-output-group', status: 'CANCELLED',
      }
    },
  }
  const runner = new OwnedCodexProxyRunner({
    processOwner: owner,
    controlRoot,
    targetKey: 'large-output-target',
    pollMs: 1,
  })
  let streamedLines = 0
  let firstLine = null
  let lastLine = null
  const result = await runner.run({
    executable: process.execPath,
    argv: ['-e', 'process.exit(0)'],
    cwd: directory,
    env: {},
    stdin: '',
    sessionId: 'large-output-session',
    reservationId: 'large-output-reservation',
    onStdoutLine(line) {
      streamedLines += 1
      if (firstLine === null) firstLine = line
      lastLine = line
    },
  })

  assert.equal(streamedLines, lineCount)
  assert.match(firstLine, /"text":"0:/)
  assert.match(lastLine, new RegExp(`"text":"${lineCount - 1}:`))
  assert.equal(result.stdoutByteCount, stdout.length)
  assert.equal(result.stdoutSha256, crypto.createHash('sha256').update(stdout).digest('hex'))
  assert.equal(result.stdoutTruncated, true)
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 512 * 1024 + 3)
  assert.equal(result.stderrByteCount, stderr.length)
  assert.equal(result.stderrTruncated, true)
  assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 64 * 1024 + 3)
  assert.match(result.stderr, /stderr-tail\n$/)
})

test('timeout cleanup has its own finite watchdog and never hides a failed drain', async () => {
  const timerApi = { setTimeout, clearTimeout }
  const startedAt = Date.now()
  await assert.rejects(
    withTimeout(
      () => new Promise(() => {}),
      5,
      timerApi,
      'CHILD_TRANSPORT_TIMEOUT',
      () => new Promise(() => {}),
      20,
    ),
    error => error.code === 'PROCESS_DRAIN_TIMEOUT' &&
      error.details.timeoutCode === 'CHILD_TRANSPORT_TIMEOUT' &&
      error.details.cleanupWatchdogMs === 20,
  )
  assert.ok(Date.now() - startedAt < 1000, 'hanging cleanup must settle at the finite drain watchdog')

  await assert.rejects(
    withTimeout(
      () => new Promise(() => {}),
      5,
      timerApi,
      'ROUTE_ANALYST_TIMEOUT',
      async () => { throw Object.assign(new Error('drain failed'), { code: 'ADAPTER_STUCK' }) },
      100,
    ),
    error => error.code === 'PROCESS_DRAIN_TIMEOUT' &&
      error.details.timeoutCode === 'ROUTE_ANALYST_TIMEOUT' &&
      error.details.cleanupFailure.code === 'ADAPTER_STUCK',
  )

  await assert.rejects(
    withTimeout(
      () => new Promise(() => {}),
      5,
      timerApi,
      'LIGHT_PLAN_TIMEOUT',
      async () => ({ drained: true }),
      100,
    ),
    error => error.code === 'LIGHT_PLAN_TIMEOUT',
  )
})
