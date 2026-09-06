#!/usr/bin/env node
'use strict'

const fs = require('node:fs')

const argument = name => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

const mode = argument('--mode')
if (mode === 'crash') process.exit(19)
if (mode === 'non-return') {
  setInterval(() => {}, 1000)
} else if (mode === 'flaky-check') {
  const attempt = Number(argument('--attempt'))
  if (![1, 2].includes(attempt)) throw new Error('flaky-check requires attempt 1 or 2')
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: 'check-observation', attempt, status: attempt === 1 ? 'PASS' : 'FAIL' })}\n`)
  process.exit(0)
} else if (mode === 'unavailable-oracle') {
  try {
    require.resolve('./deliberately-absent-oracle.cjs')
  } catch (error) {
    process.stderr.write(`${error.code}: required check implementation is unavailable\n`)
    process.exit(44)
  }
  process.exit(0)
} else if (mode === 'usage') {
  const input = fs.readFileSync(0)
  const request = JSON.parse(input.toString('utf8'))
  const output = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'bounded-work-result',
    workItemId: request.workItemId,
    role: request.role,
    status: 'PASS',
  }), 'utf8')
  const usage = {
    noncachedInput: Math.max(1, Math.ceil(input.length / 4)),
    cachedInput: 0,
    output: Math.max(1, Math.ceil(output.length / 4)),
    reasoning: 0,
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: 'model-boundary-record', usage, output: JSON.parse(output) })}\n`)
  process.exit(0)
} else {
  throw new Error(`unknown runtime boundary mode: ${mode}`)
}
