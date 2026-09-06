#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

function emitHarnessEvent(event, callback) {
  process.stdout.write(`${JSON.stringify(event)}\n`, callback)
}

function holdHarnessProcess() {
  const interval = setInterval(() => {}, 1_000)
  process.once('SIGTERM', () => clearInterval(interval))
  process.once('SIGINT', () => clearInterval(interval))
}

function runHarnessScenario(scenario) {
  if (!['success', 'escalation', 'timeout', 'crash'].includes(scenario)) {
    process.stderr.write(`unknown harness scenario: ${scenario}\n`)
    return 64
  }

  const helper = childProcess.spawn(process.execPath, [__filename, '--harness-helper'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  helper.unref()
  emitHarnessEvent({
    type: 'helper.started',
    scenario,
    processGroupId: helper.pid,
    ownership: 'registered-process-group',
  })
  emitHarnessEvent({
    type: 'generation.started',
    generation: 1,
    resume: false,
    budgetWindow: {
      id: 'scope-window-1',
      openedBy: 'fresh-launch',
      initialBudgetUnits: 30,
      consumedUnits: 30,
      remainingUnits: 0,
      previousWindowId: null,
    },
  })
  emitHarnessEvent({
    type: 'scope.budget-exhausted',
    generation: 1,
    residual: ['repository', 'tests'],
  })
  emitHarnessEvent({ type: 'scope.resume-requested', fromGeneration: 1, toGeneration: 2 })
  emitHarnessEvent({
    type: 'generation.started',
    generation: 2,
    resume: true,
    budgetWindow: {
      id: 'scope-window-2',
      openedBy: 'resume-launch',
      initialBudgetUnits: 30,
      consumedUnits: 0,
      remainingUnits: 30,
      previousWindowId: 'scope-window-1',
    },
  })

  if (scenario === 'success') {
    emitHarnessEvent({ type: 'scenario.completed', generation: 2, outcome: 'DONE' })
    holdHarnessProcess()
    return undefined
  }
  if (scenario === 'escalation') {
    emitHarnessEvent({
      type: 'reset-cap-escalated', generation: 2, maxScopeResets: 1,
      residual: ['repository', 'tests'], outcome: 'BLOCKED',
    })
    emitHarnessEvent({ type: 'scenario.completed', generation: 2, outcome: 'BLOCKED' })
    holdHarnessProcess()
    return undefined
  }
  if (scenario === 'timeout') {
    emitHarnessEvent({ type: 'scenario.waiting', generation: 2 })
    holdHarnessProcess()
    return undefined
  }

  // Flush the final protocol record synchronously. On Windows, waiting for the
  // asynchronous stdout callback can lose the child-close race to the outer
  // watchdog even though this scenario is an intentional crash.
  require('node:fs').writeSync(1, `${JSON.stringify({
    type: 'scenario.crashing', generation: 2, exitCode: 17,
  })}\n`)
  process.exit(17)
  return undefined
}

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

async function runOwnedHarnessScenario(scenario, { watchdogMs = 1_000 } = {}) {
  const child = childProcess.spawn(process.execPath, [__filename, '--harness-scenario', scenario], {
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
        settle({ outcome: event.outcome, trigger: 'terminal-event' })
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

function main() {
  if (process.argv.includes('--harness-helper')) {
    holdHarnessProcess()
    return undefined
  }
  const harnessIndex = process.argv.indexOf('--harness-scenario')
  if (harnessIndex >= 0) return runHarnessScenario(process.argv[harnessIndex + 1])

  const mode = process.env.AUTOPROMPT_MODE || 'tokensaver'
  if (mode === 'custom') {
    const raw = process.env.AUTOPROMPT_MAX_CONCURRENT || ''
    if (!/^[+]?[0-9]+(?:\.[0-9]+)?$/.test(raw) || Number(raw) < 1) {
      process.stderr.write('supervisor: custom mode requires a positive numeric AUTOPROMPT_MAX_CONCURRENT\n')
      return 2
    }
    process.stdout.write(`mode=custom; per-L3 fan-out=up to ${Math.floor(Number(raw))} live per wave (AUTOPROMPT_MAX_CONCURRENT)\n`)
  }
  const firstExit = Number(String(process.env.FAKE_EXITS || '1').trim().split(/\s+/)[0])
  return Number.isSafeInteger(firstExit) ? firstExit : 1
}

if (require.main === module) {
  const exitCode = main()
  if (Number.isSafeInteger(exitCode)) process.exitCode = exitCode
}

module.exports = { runOwnedHarnessScenario }
