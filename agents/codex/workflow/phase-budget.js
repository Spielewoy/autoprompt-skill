#!/usr/bin/env node
// F-SPEED (steer 2) B3 - PHASE WALL-CLOCK BUDGET verdict + CLI.
//
// Steer 2: "scope supervisor often takes 30min or more. come on this is like holy
// over engineering ... it does work but its hella time consuming." IDLE_TIMEOUT
// (supervisor.sh:74) only fires on frontier STALENESS; a scope phase that keeps
// writing ROADMAP.md and retained roadmap-scout artifacts IS advancing, so it resets the idle clock every
// tick and is never bounded. This module is the pure decision the supervisor
// heartbeat consults once per tick to bound the SCOPE phase by WALL-CLOCK, anchored
// to scope-phase entry and NOT reset by frontier growth - the exact hole IDLE_TIMEOUT
// leaves. It is require()-able (pure fn, unit-testable to 100% branches) AND a CLI so
// the /bin/sh + PowerShell heartbeat can branch on a distinct exit code per action,
// mirroring autoprompt-ledger-check.js (both require-able and a --resolver CLI).
//
// INVARIANT: the action token is NEVER 'fake'/'fabricate'; the residual is ALWAYS the
// honest landed-angle list the caller passed (never invented). A budget breach seals
// and surfaces the landed set for an honest converge - it never manufactures coverage.
'use strict'

const SCOPE_SOFT_SEC = 60     // bounded scope should converge within one minute
const SCOPE_HARD_SEC = 300    // ordinary multi-surface scope has a five-minute ceiling
const SCOPE_GRACE_SEC = 60    // one minute to honor a converge request
const MAX_FORCED_RESETS = 1   // budget-forced scope resets before escalation

// Coerce to a non-negative integer, or fall back to `fallback` on non-numeric/negative.
// Mirrors the supervisor COMPACT_AT validation: an absurd value never disables the
// guard and never becomes a zero-budget trap.
function clampNonNegInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

// phaseBudgetVerdict(state) -> { verdict, action, residual, escalate }
//   state: { phase, elapsedSec, softSec, hardSec, convergeRequestAgeSec, graceSec,
//            priorForcedResets, maxForcedResets, landedAngles:[] }
// Decision (in order):
//   phase !== 'scope' OR elapsed < soft            -> ok       / continue
//   soft <= elapsed < hard AND grace NOT elapsed   -> converge / request-converge
//   elapsed >= hard OR convergeRequestAge >= grace  -> seal:
//       priorForcedResets >= maxForcedResets ?  escalate  :  force-reset
function phaseBudgetVerdict(state) {
  const s = state || {}
  const elapsed = clampNonNegInt(s.elapsedSec, 0)
  const soft = clampNonNegInt(s.softSec, SCOPE_SOFT_SEC)
  const hard = clampNonNegInt(s.hardSec, SCOPE_HARD_SEC)
  const requestAge = clampNonNegInt(s.convergeRequestAgeSec, 0)
  const grace = clampNonNegInt(s.graceSec, SCOPE_GRACE_SEC)
  const priorResets = clampNonNegInt(s.priorForcedResets, 0)
  const maxResets = clampNonNegInt(s.maxForcedResets, MAX_FORCED_RESETS)
  const landed = Array.isArray(s.landedAngles) ? s.landedAngles.slice() : []

  const ok = () => ({ verdict: 'ok', action: 'continue', residual: [], escalate: false })

  if (s.phase !== 'scope' || elapsed < soft) return ok()

  // Past soft. A hard breach OR an unhonored converge request past grace seals the phase.
  const graceElapsed = requestAge >= grace
  const hardBreach = elapsed >= hard
  if (hardBreach || graceElapsed) {
    if (priorResets >= maxResets) {
      return { verdict: 'seal', action: 'escalate', residual: landed, escalate: true }
    }
    return { verdict: 'seal', action: 'force-reset', residual: landed, escalate: false }
  }

  // Soft breach, converge not yet unhonored-past-grace: request a converge, keep running.
  return { verdict: 'converge', action: 'request-converge', residual: [], escalate: false }
}

// Exit codes let the shell branch WITHOUT parsing stdout; stdout still carries the
// action token and (on seal) the honest residual list.
const EXIT_CODE = {
  'continue': 0,
  'request-converge': 10,
  'force-reset': 20,
  'escalate': 30,
}

// Parse `--flag value` pairs from argv into a plain object keyed by flag name.
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.slice(0, 2) !== '--') continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.slice(0, 2) === '--') { out[key] = true; continue }
    out[key] = next
    i++
  }
  return out
}

// CLI: node phase-budget.js --verdict --phase scope --elapsed E --soft S --hard H \
//        --request-age R --grace G --prior-resets P --max-resets M --landed a,b
function runCli(argv) {
  const args = parseArgs(argv)
  const landed = typeof args.landed === 'string' && args.landed.length > 0
    ? args.landed.split(',').filter((a) => a.length > 0)
    : []
  const verdict = phaseBudgetVerdict({
    phase: args.phase,
    elapsedSec: args.elapsed,
    softSec: args.soft,
    hardSec: args.hard,
    convergeRequestAgeSec: args['request-age'],
    graceSec: args.grace,
    priorForcedResets: args['prior-resets'],
    maxForcedResets: args['max-resets'],
    landedAngles: landed,
  })
  const residual = verdict.residual.join(',')
  process.stdout.write(`${verdict.action} landed=${residual}\n`)
  return EXIT_CODE[verdict.action]
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  if (argv.includes('--verdict')) {
    process.exit(runCli(argv.filter((a) => a !== '--verdict')))
  }
  process.stderr.write('usage: node phase-budget.js --verdict --phase scope --elapsed E ...\n')
  process.exit(2)
}

module.exports = {
  phaseBudgetVerdict,
  clampNonNegInt,
  SCOPE_SOFT_SEC,
  SCOPE_HARD_SEC,
  SCOPE_GRACE_SEC,
  MAX_FORCED_RESETS,
}
