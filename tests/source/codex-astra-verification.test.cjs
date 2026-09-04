'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const {
  checkerResultBoundToCommandExecutionEvidence,
  createCheckerObservationBinding,
  createCodexJsonlAccumulator,
} = require('../../agents/codex/workflow/phase-budget.js')
const { stableStringify } = require('../../agents/codex/workflow/event-log.js')

const hash = value => crypto.createHash('sha256').update(value).digest('hex')

function executeTrustedCheck(t, source, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-astra-verification-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const candidate = path.join(root, 'candidate')
  const scratch = path.join(root, 'scratch')
  fs.mkdirSync(candidate)
  fs.mkdirSync(scratch)
  const harness = path.join(candidate, options.python ? 'check.py' : 'check.cjs')
  fs.writeFileSync(harness, source)
  const bytes = fs.readFileSync(harness)
  const artifacts = options.attested === false ? [] : [{
    kind: 'file',
    relativePath: path.basename(harness),
    digest: hash(stableStringify({
      schemaVersion: 1, kind: 'file', mode: fs.statSync(harness).mode & 0o777,
      bytes: bytes.length, contentHash: hash(bytes),
    })),
  }]
  const executable = options.python ? 'python3' : process.execPath
  const command = `${executable} ${harness}`
  const checkId = 'independent-product-behavior'
  const candidateHash = hash('frozen candidate identity')
  const requestEnvelopeHash = hash('exact request')
  const assignmentId = 'independent-check-1'
  const binding = createCheckerObservationBinding({
    candidateHash, requestEnvelopeHash, assignmentId, checkIds: [checkId],
    commandBindings: [{ checkId, command, artifacts }],
  })
  const record = {
    logicalRole: 'independent-reviewer', workItemId: assignmentId,
    candidateHash, requestEnvelopeHash,
    canonicalAssignment: {
      assignmentId, requestEnvelopeHash, checks: [checkId],
      verificationObservationBinding: binding,
    },
    checkerScratchBoundary: {
      schemaVersion: 2, runId: 'run-astra', checkerId: assignmentId, candidateHash,
      frozenCandidateRoot: candidate, writableScratchRoot: scratch,
      temporaryRoot: path.join(scratch, 'tmp'), outputRoot: path.join(scratch, 'output'),
      cacheRoot: path.join(scratch, 'cache'),
    },
    workingDirectory: scratch,
  }
  if (options.beforeExecution) options.beforeExecution(harness)
  const executed = spawnSync(executable, [harness], {
    cwd: scratch, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(executed.error, undefined)
  const accumulator = createCodexJsonlAccumulator(record)
  accumulator.push(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'real-check-command', type: 'command_execution', command,
      status: executed.status === 0 ? 'completed' : 'failed',
      exit_code: executed.status,
      aggregated_output: executed.stdout + executed.stderr,
    },
  }))
  const parsed = accumulator.snapshot()
  const claimedStatus = options.claimedStatus || 'PASS'
  const result = checkerResultBoundToCommandExecutionEvidence({
    code: claimedStatus,
    payload: { testOutcomes: [{ checkId, status: claimedStatus }] },
  }, parsed, record)
  return { executed, parsed, result }
}

test('trusted exact command cannot certify PASS when its zero-exit output explicitly fails', t => {
  for (const output of [
    'FAIL: distinct input identities collapsed to one token',
    JSON.stringify({ status: 'PASS', errors: ['distinct input identities collapsed'] }),
    'Ran 1 test in 0.001s\n\nFAILED (errors=1)',
  ]) {
    const { executed, result } = executeTrustedCheck(t, `console.log(${JSON.stringify(output)})\n`)
    assert.equal(executed.status, 0)
    assert.equal(result.code, 'CHECK_INCONCLUSIVE', output)
    assert.equal(result.payload.verificationAuthority, undefined)
  }
})

test('silent successful assertions have PASS authority only for an unchanged trusted exact command', t => {
  const source = "require('node:assert/strict').equal(2 + 2, 4)\n"
  const trusted = executeTrustedCheck(t, source)
  assert.equal(trusted.executed.stdout, '')
  assert.equal(trusted.executed.status, 0)
  assert.equal(trusted.result.code, 'PASS')
  assert.equal(trusted.result.payload.verificationAuthority.checks[0].authority, 'EXACT_COMMAND')
  const unattested = executeTrustedCheck(t, source, { attested: false })
  assert.equal(unattested.result.code, 'CHECK_INCONCLUSIVE')
  const pythonPass = executeTrustedCheck(t, 'assert 2 + 2 == 4\n', { python: true })
  assert.equal(pythonPass.executed.stdout, '')
  assert.equal(pythonPass.result.code, 'PASS')
  const pythonFail = executeTrustedCheck(t, 'assert 2 + 2 == 5\n', {
    python: true, claimedStatus: 'FAIL',
  })
  assert.equal(pythonFail.executed.status, 1)
  assert.equal(pythonFail.result.code, 'FAIL')
})

test('unexpected errors inside a real unittest remain a repairable failing observation', t => {
  const { executed, result } = executeTrustedCheck(t, [
    'import unittest',
    'class ProductTest(unittest.TestCase):',
    '    def test_required_output(self):',
    '        raise RuntimeError("product did not produce its required output")',
    'unittest.main()',
    '',
  ].join('\n'), { python: true, claimedStatus: 'FAIL' })
  assert.equal(executed.status, 1)
  assert.match(executed.stderr, /FAILED \(errors=1\)/u)
  assert.equal(result.code, 'FAIL')
  assert.equal(result.cause.event, 'ASSERTION_FAILED')
})

test('plain unavailable dependency output does not become an authenticated product failure', t => {
  const { result } = executeTrustedCheck(t,
    "import autoprompt_astra_deliberately_unavailable_importer\n",
    { python: true, claimedStatus: 'FAIL' })
  assert.equal(result.code, 'CHECK_INCONCLUSIVE')
})

test('changing a trusted silent harness after its declaration cannot certify PASS', t => {
  const { executed, result } = executeTrustedCheck(t, 'assert 2 + 2 == 5\n', {
    python: true,
    beforeExecution(harness) { fs.writeFileSync(harness, 'assert 2 + 2 == 4\n') },
  })
  assert.equal(executed.status, 0)
  assert.equal(result.code, 'CHECK_INCONCLUSIVE')
  assert.equal(result.payload.verificationAuthority, undefined)
})

function executeScratchChecks(t, scenarios) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-astra-scratch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const candidate = path.join(root, 'candidate')
  const scratch = path.join(root, 'scratch')
  fs.mkdirSync(candidate)
  fs.mkdirSync(scratch)
  fs.writeFileSync(path.join(candidate, 'product.txt'), 'complete\n')
  const candidateHash = hash('frozen scratch candidate')
  const requestEnvelopeHash = hash('scratch request')
  const assignmentId = 'independent-check-1'
  const checkId = 'required-product-behavior'
  const record = {
    logicalRole: 'independent-reviewer', workItemId: assignmentId,
    candidateHash, requestEnvelopeHash, workingDirectory: scratch,
    canonicalAssignment: {
      assignmentId, requestEnvelopeHash, checks: [checkId],
      verificationObservationBinding: createCheckerObservationBinding({
        assignmentId, candidateHash, requestEnvelopeHash, checkIds: [checkId],
      }),
    },
    checkerScratchBoundary: {
      schemaVersion: 2, runId: 'run-scratch', checkerId: assignmentId, candidateHash,
      frozenCandidateRoot: candidate, writableScratchRoot: scratch,
      temporaryRoot: path.join(scratch, 'tmp'), outputRoot: path.join(scratch, 'output'),
      cacheRoot: path.join(scratch, 'cache'),
    },
  }
  const accumulator = createCodexJsonlAccumulator(record)
  const executions = scenarios.map((scenario, index) => {
    const harness = path.join(scratch, scenario.name || `check-${index}.cjs`)
    if (scenario.source !== undefined) fs.writeFileSync(harness, scenario.source)
    const command = scenario.quoted
      ? `${process.execPath} ${JSON.stringify(harness)} ${JSON.stringify(candidate)}`
      : `${process.execPath} ${harness} ${candidate}`
    const id = `scratch-command-${index}`
    accumulator.push(JSON.stringify({
      type: 'item.started', item: { id, type: 'command_execution', command },
    }))
    const executed = spawnSync(process.execPath, [harness, candidate], {
      cwd: scratch, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(executed.error, undefined)
    if (scenario.afterExecution) scenario.afterExecution(harness)
    accumulator.push(JSON.stringify({
      type: 'item.completed', item: {
        id, type: 'command_execution', command,
        status: executed.status === 0 ? 'completed' : 'failed', exit_code: executed.status,
        aggregated_output: executed.stdout + executed.stderr,
      },
    }))
    return executed
  })
  const parsed = accumulator.snapshot()
  const verdict = (code = 'PASS') => checkerResultBoundToCommandExecutionEvidence({
    code, payload: { testOutcomes: [{ checkId, status: code }] },
  }, parsed, record)
  return { executions, parsed, verdict }
}

const SCRATCH_PRODUCT_READ = [
  "const fs = require('node:fs'), path = require('node:path')",
  "require('node:assert/strict').equal(fs.readFileSync(path.join(process.argv[2], 'product.txt'), 'utf8'), 'complete\\n')",
].join('\n')
const SCRATCH_PASS = `${SCRATCH_PRODUCT_READ}\nconsole.log(JSON.stringify({status:'PASS',passCount:2,failureCount:0}))\n`

test('fresh sealed scratch path corrects setup in the same turn and still requires independent confirmation', t => {
  const { executions, parsed, verdict } = executeScratchChecks(t, [
    { source: "require('autoprompt_astra_deliberately_unavailable_consumer')\n" },
    { source: SCRATCH_PASS },
  ])
  assert.equal(executions[0].status, 1)
  assert.equal(executions[1].status, 0)
  assert.equal(parsed.commandExecutionFailures.count, 1)
  assert.equal(parsed.verificationObservations.scratchHarnessInvocationCount, 2)
  const result = verdict()
  assert.equal(result.code, 'CHECK_INCONCLUSIVE')
  assert.equal(result.cause.event, 'CHECK_SCRATCH_CONFIRMATION_REQUIRED')
  assert.equal(result.payload.verificationAuthority.checks[0].authority, 'SCRATCH_HARNESS')
})

test('repeated same scratch command cannot select a PASS even when both executions agree', t => {
  const { verdict } = executeScratchChecks(t, [
    { name: 'same.cjs', source: SCRATCH_PASS }, { name: 'same.cjs' },
  ])
  const result = verdict()
  assert.equal(result.code, 'CHECK_INCONCLUSIVE')
  assert.notEqual(result.cause.event, 'CHECK_SCRATCH_CONFIRMATION_REQUIRED')
  assert.equal(result.payload.verificationAuthority, undefined)
})

test('different command spelling cannot reuse an executed scratch path after setup failure', t => {
  const { parsed, verdict } = executeScratchChecks(t, [
    { name: 'same.cjs', source: "require('autoprompt_astra_unavailable_consumer')\n" },
    { name: 'same.cjs', source: SCRATCH_PASS, quoted: true },
  ])
  const invocations = parsed.verificationObservations.scratchHarnessInvocations
  assert.notEqual(invocations[0].commandHash, invocations[1].commandHash)
  assert.equal(invocations[0].programPathHash, invocations[1].programPathHash)
  assert.equal(verdict().code, 'CHECK_INCONCLUSIVE')
  assert.equal(verdict().payload.verificationAuthority, undefined)
})

test('fresh scratch path cannot erase a prior authenticated product failure', t => {
  const { parsed, verdict } = executeScratchChecks(t, [
    { source: `${SCRATCH_PRODUCT_READ}\nconsole.log(JSON.stringify({status:'FAIL',failureCount:1})); process.exitCode=1\n` },
    { source: SCRATCH_PASS },
  ])
  assert.equal(parsed.verificationObservations.receipts[0].failureHarnessAdmissible, true)
  assert.equal(verdict().code, 'CHECK_INCONCLUSIVE')
  assert.equal(verdict().payload.verificationAuthority, undefined)
  assert.equal(verdict('FAIL').code, 'FAIL')
})

test('scratch harness modified after its start cannot supply provisional PASS', t => {
  const { verdict } = executeScratchChecks(t, [{
    source: SCRATCH_PASS,
    afterExecution(harness) { fs.appendFileSync(harness, '// changed after sealed start\n') },
  }])
  assert.equal(verdict().code, 'CHECK_INCONCLUSIVE')
  assert.equal(verdict().payload.verificationAuthority, undefined)
})
