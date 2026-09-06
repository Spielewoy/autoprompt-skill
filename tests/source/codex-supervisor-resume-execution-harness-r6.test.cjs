#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'codex-supervisor-contract-dry-run.cjs')

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return
  if (process.platform === 'win32') {
    childProcess.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true, timeout: 5_000,
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

async function waitForNoResidue(pids, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (pids.some(processIsAlive) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return pids.filter(processIsAlive)
}

async function runScenario(scenario, { watchdogMs = 1_000 } = {}) {
  const child = childProcess.spawn(process.execPath, [FIXTURE, '--harness-scenario', scenario], {
    cwd: ROOT,
    detached: true,
    env: { ...process.env, AUTOPROMPT_TEST_HARNESS: 'codex-resume-r6' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const ownedGroups = new Set([child.pid])
  const events = []
  let stdout = ''
  let stderr = ''
  let watchdogFired = false
  let settled = false
  let watchdog = null
  let resolveOutcome
  const outcome = new Promise(resolve => { resolveOutcome = resolve })
  const settle = value => {
    if (settled) return
    settled = true
    resolveOutcome(value)
  }
  const acceptLine = line => {
    if (!line) return
    try {
      const event = JSON.parse(line)
      events.push(event)
      if (Number.isSafeInteger(event.processGroupId)) ownedGroups.add(event.processGroupId)
      if (event.type === 'helper.started' && watchdog === null) {
        clearTimeout(startupWatchdog)
        watchdog = setTimeout(() => {
          watchdogFired = true
          settle({ outcome: 'HARNESS_WATCHDOG_TIMEOUT', trigger: 'outer-watchdog' })
        }, watchdogMs)
        watchdog.unref?.()
      }
      if (event.type === 'scenario.completed') {
        settle({ outcome: 'DONE', trigger: 'terminal-event' })
      }
    } catch (error) {
      settle({ outcome: 'HARNESS_PROTOCOL_ERROR', trigger: 'invalid-event', error })
    }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
    let newline
    while ((newline = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      acceptLine(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', error => settle({ outcome: 'HARNESS_CHILD_CRASH', trigger: 'spawn-error', error }))
  child.once('close', (code, signal) => {
    acceptLine(stdout)
    if (!settled) settle({ outcome: 'HARNESS_CHILD_CRASH', trigger: 'child-close', code, signal })
  })
  const startupWatchdog = setTimeout(() => {
    watchdogFired = true
    settle({ outcome: 'HARNESS_WATCHDOG_TIMEOUT', trigger: 'startup-watchdog' })
  }, Math.max(5_000, watchdogMs * 4))
  startupWatchdog.unref?.()

  let result
  let residue
  try {
    result = await outcome
  } finally {
    clearTimeout(startupWatchdog)
    if (watchdog !== null) clearTimeout(watchdog)
    for (const pid of [...ownedGroups].reverse()) killProcessGroup(pid)
    child.stdout.destroy()
    child.stderr.destroy()
    residue = await waitForNoResidue([...ownedGroups])
  }
  return { ...result, events, ownedGroups: [...ownedGroups], residue, stderr, watchdogFired }
}

test('AP-RUN-037/038 successful resume completes by event and opens a fresh budget window', {
  timeout: 10_000,
}, async () => {
  const result = await runScenario('success')
  assert.equal(result.outcome, 'DONE', result.stderr)
  assert.equal(result.trigger, 'terminal-event')
  assert.equal(result.watchdogFired, false)

  const launches = result.events.filter(event => event.type === 'generation.started')
  assert.equal(launches.length, 2)
  assert.deepEqual(launches.map(event => [event.generation, event.resume]), [[1, false], [2, true]])
  assert.notEqual(launches[1].budgetWindow.id, launches[0].budgetWindow.id)
  assert.deepEqual(launches[1].budgetWindow, {
    id: 'scope-window-2',
    openedBy: 'resume-launch',
    initialBudgetUnits: 30,
    consumedUnits: 0,
    remainingUnits: 30,
    previousWindowId: 'scope-window-1',
  })
  assert.equal(result.events.some(event => event.type === 'reset-cap-escalated'), false)
  assert.deepEqual(result.residue, [], `owned process residue: ${result.residue.join(', ')}`)
})

test('AP-RUN-037/TEST-033 timeout and crash fail closed and drain every registered process group', {
  timeout: 15_000,
}, async t => {
  for (const [scenario, expected] of [
    ['timeout', 'HARNESS_WATCHDOG_TIMEOUT'],
    ['crash', 'HARNESS_CHILD_CRASH'],
  ]) {
    await t.test(scenario, async () => {
      const result = await runScenario(scenario, { watchdogMs: 500 })
      assert.equal(result.outcome, expected, result.stderr)
      assert.ok(result.ownedGroups.length >= 2, 'fixture must register its helper process group')
      assert.deepEqual(result.residue, [], `owned process residue: ${result.residue.join(', ')}`)
      assert.equal(result.events.some(event => event.type === 'scenario.completed'), false)
      assert.equal(result.watchdogFired, scenario === 'timeout')
    })
  }
})
