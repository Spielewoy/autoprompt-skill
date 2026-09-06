#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')

const args = process.argv.slice(2)
const output = value => process.stdout.write(`${value}\n`)

if (args.length === 1 && args[0] === '--help') {
  output('--profile --strict-config --cd')
  process.exit(0)
}
if (args.length === 1 && args[0] === '--version') {
  output('codex-cli installed-canary-1.0.0')
  process.exit(0)
}
if (args[0] === 'features' && args[1] === 'list') {
  output('multi_agent stable true')
  process.exit(0)
}
if (args[0] === 'exec' && args.includes('--help')) {
  output('--json --output-schema --profile --cd --strict-config')
  process.exit(0)
}
if (args[0] === 'sandbox') {
  const joined = args.join(' ')
  output(joined.includes('AUTOPROMPT_NETWORK')
    ? 'AUTOPROMPT_NETWORK_DENIED'
    : 'AUTOPROMPT_SANDBOX_OK')
  process.exit(0)
}
if (args[0] !== 'exec') process.exit(64)

const schemaIndex = args.indexOf('--output-schema')
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : ''
if (!schemaPath || !fs.existsSync(schemaPath)) {
  process.stderr.write('Failed to read output schema file: missing\n')
  process.exit(1)
}

const input = fs.readFileSync(0, 'utf8')
const role = (/^role=(.+)$/m.exec(input) || [, 'unknown'])[1]
const assignmentText = /^Canonical assignment: (.+)$/m.exec(input)
const contextText = /^Canonical context envelope: (.+)$/m.exec(input)
const assignment = assignmentText ? JSON.parse(assignmentText[1]) : null
const context = contextText ? JSON.parse(contextText[1]) : null
const tracePath = process.env.AUTOPROMPT_FAKE_CODEX_TRACE
if (tracePath) fs.appendFileSync(tracePath, `${JSON.stringify({ role, args })}\n`)
const now = new Date().toISOString()
let typed
if (/checker|reviewer|tester/.test(role)) {
  typed = {
    schemaVersion: '2.0.0', code: 'PASS',
    description: 'The contained local observational result satisfies the assigned check.',
    stateClass: 'terminal', runId: assignment.runId,
    requestEnvelopeHash: assignment.requestEnvelopeHash,
    currentVersionHash: context.candidateHash, completedResults: [], nextReadyWork: [],
    cause: { event: 'CHECK_COMPLETE', reason: 'Offline exact-path fixture accepted the candidate.', unblockPath: null },
    payloadSchemaId: 'autoprompt.check.installed-canary.v2', payload: {}, recordedAt: now,
  }
} else {
  typed = {
    schemaVersion: '2.0.0', reportType: 'result', reportId: `result:${assignment.assignmentId}`,
    runId: assignment.runId, assignmentId: assignment.assignmentId,
    logicalRoleId: assignment.logicalRoleId, physicalRoleId: assignment.physicalRoleId,
    requestEnvelopeHash: assignment.requestEnvelopeHash, findingIds: assignment.findingIds,
    startedAt: now, endedAt: now, filesChanged: [], resourcesChanged: [],
    behaviorChanged: ['Inspected the contained local source without mutation.'], commands: [],
    successItems: assignment.successChecklist.map(item => ({ id: item.id, status: 'pass', evidenceIds: ['installed-cli-canary'] })),
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: { event: 'WORK_ITEM_VERIFIED', reason: 'All assigned observations passed.', invalidateEvidenceIds: [] },
  }
}
output(JSON.stringify({ type: 'thread.started', thread_id: crypto.randomUUID() }))
output(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(typed) } }))
output(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0 } }))
