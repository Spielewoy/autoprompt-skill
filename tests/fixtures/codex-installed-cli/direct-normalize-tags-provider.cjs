#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const output = value => process.stdout.write(`${value}\n`)

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function appendTrace(event) {
  const tracePath = process.env.AUTOPROMPT_CANARY_TRACE
  if (!tracePath) return
  fs.appendFileSync(tracePath, `${JSON.stringify({
    ...event,
    cwd: process.cwd(),
    providerArgv: args,
  })}\n`)
}

function runFocusedCheck() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = childProcess.spawnSync(process.execPath, ['--test', 'test.cjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  })
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  }
}

function emitTypedResult(typed, commandObservation = null) {
  output(JSON.stringify({ type: 'thread.started', thread_id: crypto.randomUUID() }))
  if (commandObservation) {
    output(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'installed-canary-focused-check',
        type: 'command_execution',
        ...commandObservation,
      },
    }))
  }
  output(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(typed) },
  }))
  output(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
  }))
  setInterval(() => {}, 1_000)
}

function readScenario() {
  const scenarioPath = process.env.AUTOPROMPT_CANARY_SCENARIO
  if (!scenarioPath || !path.isAbsolute(scenarioPath)) {
    throw new Error('AUTOPROMPT_CANARY_SCENARIO must name the absolute controller-owned scenario')
  }
  return JSON.parse(fs.readFileSync(scenarioPath, 'utf8'))
}

function main() {
  const input = fs.readFileSync(0, 'utf8')
  const role = (/^role=(.+)$/m.exec(input) || [, 'unknown'])[1]
  const assignmentText = /^Canonical assignment: (.+)$/m.exec(input)
  const contextText = /^Canonical context envelope: (.+)$/m.exec(input)
  const assignment = assignmentText ? JSON.parse(assignmentText[1]) : null
  const context = contextText ? JSON.parse(contextText[1]) : null
  const logicalRole = assignment && assignment.logicalRoleId || role
  const scenario = readScenario()

  if (role === 'route-analyst') {
    appendTrace({ logicalRole, phase: 'automatic-route-analysis' })
    emitTypedResult(scenario.recommendation)
    return
  }
  if (role === 'run-owner') {
    appendTrace({ logicalRole, phase: 'automatic-route-decision' })
    emitTypedResult(scenario.decision)
    return
  }

  const now = new Date().toISOString()
  if (logicalRole === 'diagnostic-probe') {
    const inspectedFiles = ['index.cjs', 'test.cjs']
    const inspectionEvidence = `read-only-target:${sha256(inspectedFiles.map(file =>
      `${file}:${sha256(fs.readFileSync(path.join(process.cwd(), file)))}`).join('\n'))}`
    appendTrace({ logicalRole, phase: 'read-only-policy-probe', evidenceId: inspectionEvidence })
    emitTypedResult({
      schemaVersion: '2.0.0',
      reportType: 'result',
      code: 'PASS',
      reportId: `result:${assignment.assignmentId}`,
      runId: assignment.runId,
      assignmentId: assignment.assignmentId,
      logicalRoleId: assignment.logicalRoleId,
      physicalRoleId: assignment.physicalRoleId,
      requestEnvelopeHash: assignment.requestEnvelopeHash,
      findingIds: assignment.findingIds,
      startedAt: now,
      endedAt: new Date().toISOString(),
      filesChanged: [],
      resourcesChanged: [],
      behaviorChanged: [],
      commands: [{
        command: 'read-only inspection of index.cjs and test.cjs',
        exitCode: 0,
        result: inspectionEvidence,
      }],
      successItems: assignment.successChecklist.map(item => ({
        id: item.id,
        status: 'pass',
        evidenceIds: [inspectionEvidence],
      })),
      remainingConcerns: [],
      allAssignedItemsPass: true,
      requestedTransition: {
        event: 'WORK_ITEM_VERIFIED',
        reason: 'The representative role policy completed a bounded read-only target inspection.',
        invalidateEvidenceIds: [],
      },
    })
    return
  }

  if (logicalRole === 'worker') {
    const before = runFocusedCheck()
    if (before.exitCode === 0 || before.signal !== null) {
      throw new Error(`worker expected the preregistered focused check to be RED: ${JSON.stringify(before)}`)
    }
    const implementation = [
      "'use strict'",
      '',
      'function normalizeTags(tags) {',
      '  const seen = new Set()',
      '  const result = []',
      '  for (const tag of tags) {',
      '    const normalized = tag.trim()',
      '    if (!normalized || seen.has(normalized)) continue',
      '    seen.add(normalized)',
      '    result.push(normalized)',
      '  }',
      '  return result',
      '}',
      '',
      'module.exports = { normalizeTags }',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(process.cwd(), 'index.cjs'), implementation)
    const after = runFocusedCheck()
    if (after.exitCode !== 0 || after.signal !== null) {
      throw new Error(`worker focused check did not turn GREEN: ${JSON.stringify(after)}`)
    }
    const redEvidence = `focused-red:${sha256(`${before.stdout}\n${before.stderr}`)}`
    const greenEvidence = `focused-green:${sha256(`${after.stdout}\n${after.stderr}`)}`
    appendTrace({
      logicalRole,
      phase: 'red-edit-green',
      beforeExitCode: before.exitCode,
      afterExitCode: after.exitCode,
      redEvidence,
      greenEvidence,
    })
    emitTypedResult({
      schemaVersion: '2.0.0',
      reportType: 'result',
      reportId: `result:${assignment.assignmentId}`,
      runId: assignment.runId,
      assignmentId: assignment.assignmentId,
      logicalRoleId: assignment.logicalRoleId,
      physicalRoleId: assignment.physicalRoleId,
      requestEnvelopeHash: assignment.requestEnvelopeHash,
      findingIds: assignment.findingIds,
      startedAt: now,
      endedAt: new Date().toISOString(),
      filesChanged: ['index.cjs'],
      resourcesChanged: [],
      behaviorChanged: [
        'normalizeTags trims tags, removes empty values and exact duplicates, and preserves first-seen order.',
      ],
      commands: [
        { command: 'node --test test.cjs (before)', exitCode: before.exitCode, result: redEvidence },
        { command: 'node --test test.cjs (after)', exitCode: after.exitCode, result: greenEvidence },
      ],
      successItems: assignment.successChecklist.map(item => ({
        id: item.id,
        status: 'pass',
        evidenceIds: [redEvidence, greenEvidence],
      })),
      remainingConcerns: [],
      allAssignedItemsPass: true,
      requestedTransition: {
        event: 'WORK_ITEM_VERIFIED',
        reason: 'The preregistered focused check changed from RED to GREEN on the owned file.',
        invalidateEvidenceIds: [],
      },
    })
    return
  }

  if (/checker|reviewer|tester/u.test(logicalRole) || /checker|reviewer|tester/u.test(role)) {
    const check = runFocusedCheck()
    const passed = check.exitCode === 0 && check.signal === null
    if (scenario.recommendation.howSuccessCanBeChecked[0] !== 'node --test test.cjs') {
      throw new Error('installed canary route recommendation lost its exact focused-check identity')
    }
    const command = JSON.stringify([process.execPath, '--test', 'test.cjs'])
    const commandOutput = `${check.stdout}\n${check.stderr}`
    const evidenceId = `${logicalRole}:${sha256(commandOutput)}`
    appendTrace({
      logicalRole,
      phase: 'independent-focused-check',
      exitCode: check.exitCode,
      evidenceId,
    })
    emitTypedResult({
      schemaVersion: '2.0.0',
      code: passed ? 'PASS' : 'FAIL',
      description: passed
        ? 'The installed-runtime candidate passes the preregistered focused check.'
        : 'The installed-runtime candidate fails the preregistered focused check.',
      stateClass: 'terminal',
      runId: assignment.runId,
      requestEnvelopeHash: assignment.requestEnvelopeHash,
      currentVersionHash: context.candidateHash,
      completedResults: [],
      nextReadyWork: [],
      cause: {
        event: 'CHECK_COMPLETE',
        reason: passed ? 'The isolated focused check is GREEN.' : 'The isolated focused check is RED.',
        unblockPath: passed ? null : 'Return the focused failure to the owning worker.',
      },
      payloadSchemaId: 'autoprompt.check.installed-direct-normalize-tags.v2',
      payload: {
        evidenceIds: [evidenceId],
        findings: passed ? [] : [{ id: 'CANARY-FOCUSED-CHECK-RED', severity: 'P1' }],
        testOutcomes: assignment.checks.map(checkId => ({
          command: checkId,
          status: passed ? 'PASS' : 'FAIL',
        })),
      },
      recordedAt: new Date().toISOString(),
    }, {
      command,
      status: passed ? 'completed' : 'failed',
      exit_code: check.exitCode,
      aggregated_output: commandOutput,
    })
    return
  }

  throw new Error(`unexpected installed canary role: provider=${role} logical=${logicalRole}`)
}

try {
  main()
} catch (error) {
  appendTrace({ phase: 'provider-error', message: error.message, stack: error.stack })
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
}
