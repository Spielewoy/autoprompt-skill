'use strict'

const childProcess = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { canonicalStringify, exactKeys, fail, nonEmpty } = require('./core.cjs')

const ROUTES = Object.freeze(['DIRECT', 'LIGHT', 'ROADMAP'])

function admitSupervisorSimulation(input, launcher) {
  if (!input || !Number.isSafeInteger(input.heartbeatIntervalSeconds) || input.heartbeatIntervalSeconds < 1) {
    fail('SUPERVISOR_HEARTBEAT_INVALID', 'heartbeat interval must be a positive integer before spawn')
  }
  const environment = input.environment || {}
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) fail('SUPERVISOR_ENV_INVALID', 'supervisor environment must be an object')
  if (Object.hasOwn(environment, 'AUTOPROMPT_RESUME')) fail('INHERITED_RESUME_FORBIDDEN', 'resume activation must come from explicit persisted state, never inherited environment')
  if (typeof launcher !== 'function') fail('SUPERVISOR_LAUNCHER_INVALID', 'a counted launcher is required')
  return launcher(Object.freeze({ heartbeatIntervalSeconds: input.heartbeatIntervalSeconds, resume: null }))
}

function runJsonProcess(command, args, options, code) {
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || !value)) fail(code, 'executable fixture command is required')
  const started = performance.now()
  const result = childProcess.spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: options.cwd, env: options.env || process.env, encoding: 'utf8', shell: false,
    windowsHide: true, timeout: options.timeoutMs || 10000, maxBuffer: 1024 * 1024,
  })
  const processLatencyMs = performance.now() - started
  if (result.error || result.status !== 0 || result.signal) fail(code, 'executable conformance replay failed', {
    errorCode: result.error?.code || null, exitCode: result.status, signal: result.signal, stderr: String(result.stderr || '').trim(),
  })
  let record
  try { record = JSON.parse(String(result.stdout).trim()) } catch (error) { fail(code, 'executable conformance replay returned invalid JSON', { cause: error.message }) }
  return { record, processLatencyMs }
}

function replayFailureTaxonomy(corpus, options = {}) {
  exactKeys(corpus, ['schemaVersion', 'evidenceClass', 'entries'], 'FAILURE_REPLAY_INVALID', 'failure taxonomy')
  if (corpus.evidenceClass !== 'deterministic-failure-replay' || !Array.isArray(corpus.entries) || !corpus.entries.length) fail('FAILURE_REPLAY_INVALID', 'failure taxonomy is not executable')
  const results = []
  for (const entry of corpus.entries) {
    const { record } = runJsonProcess(options.command, ['--case', entry.id], options, 'FAILURE_REPLAY_PROCESS_FAILED')
    exactKeys(record, ['schemaVersion', 'id', 'injectionObserved', 'status', 'boundary', 'transitionIds'], 'FAILURE_REPLAY_INVALID', `failure replay ${entry.id}`)
    if (record.schemaVersion !== 'codex-failure-replay.v1' || record.id !== entry.id || record.injectionObserved !== true ||
        record.status !== entry.expectedStatus || record.boundary !== entry.expectedBoundary ||
        canonicalStringify(record.transitionIds) !== canonicalStringify(entry.transitionIds) || record.transitionIds.length > entry.maxTransitions) {
      fail('FAILURE_REPLAY_MISMATCH', `failure replay did not reach its declared bounded terminal: ${entry.id}`, { expectedBoundary: entry.expectedBoundary, actual: record })
    }
    results.push(Object.freeze({ id: entry.id, status: record.status, boundary: record.boundary, transitions: record.transitionIds.length }))
  }
  return Object.freeze({ ready: true, results: Object.freeze(results) })
}

function runEconomicRouteSimulations(corpus, options = {}) {
  exactKeys(corpus, ['schemaVersion', 'evidenceClass', 'routeCaps', 'simulations'], 'ECONOMIC_CONFORMANCE_INVALID', 'economic conformance corpus')
  if (!String(corpus.evidenceClass).includes('not-provider-canary')) fail('ECONOMIC_CONFORMANCE_INVALID', 'synthetic route simulations must not be promoted as provider canaries')
  const results = []
  for (const simulation of corpus.simulations) {
    const { record, processLatencyMs } = runJsonProcess(options.command, ['--case', simulation.id], options, 'ECONOMIC_SIMULATION_PROCESS_FAILED')
    exactKeys(record, ['schemaVersion', 'id', 'route', 'childLaunches', 'contextBytes', 'usage', 'effort', 'productionModules'], 'ECONOMIC_CONFORMANCE_INVALID', `route simulation ${simulation.id}`)
    if (record.schemaVersion !== 'codex-route-simulation.v1' || record.id !== simulation.id || !ROUTES.includes(record.route) || record.route !== simulation.route ||
        record.productionModules.router !== true || record.productionModules.effortPolicy !== true) fail('ECONOMIC_CONFORMANCE_INVALID', `route simulation did not exercise the production policy: ${simulation.id}`)
    const cap = corpus.routeCaps[record.route]
    const measured = {
      childLaunches: record.childLaunches, contextBytes: record.contextBytes,
      noncachedInputTokens: record.usage.inputTokens - record.usage.cachedInputTokens,
      outputTokens: record.usage.outputTokens, usefulWorkLatencyMs: processLatencyMs, effort: record.effort,
    }
    for (const field of ['childLaunches', 'contextBytes', 'noncachedInputTokens', 'outputTokens', 'usefulWorkLatencyMs']) {
      if (!Number.isFinite(measured[field]) || measured[field] < 0 || measured[field] > cap[field]) fail('ECONOMIC_ROUTE_LIMIT_EXCEEDED', `${simulation.id} exceeded ${field}`, { measured: measured[field], limit: cap[field] })
    }
    nonEmpty(measured.effort, 'ECONOMIC_CONFORMANCE_INVALID', 'effort')
    if (!cap.allowedEfforts.includes(measured.effort)) fail('ECONOMIC_EFFORT_INVALID', `${simulation.id} selected an unsupported effort`)
    results.push(Object.freeze({ id: simulation.id, route: record.route, measured: Object.freeze(measured) }))
  }
  return Object.freeze({ conformant: true, evidenceClass: corpus.evidenceClass, results: Object.freeze(results) })
}

module.exports = { admitSupervisorSimulation, replayFailureTaxonomy, runEconomicRouteSimulations }
