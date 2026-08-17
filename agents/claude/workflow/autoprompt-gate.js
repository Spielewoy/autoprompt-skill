export const meta = {
  name: 'autoprompt-gate',
  description: 'Useful-first Autoprompt runtime: produce one executable roadmap, independently approve it, dispatch ready dependency lanes, and verify real behavior under deterministic gates. The first roadmap author receives the exact mission; later typed workers receive a cryptographically bound mission pointer.',
  whenToUse: 'When you want roadmap-first execution with fail-closed capability checks, adaptive scope, strict TDD, independent review and verification, and resumable three-file governance. Pass args.mission plus optional mode, selector, concurrency, resume, and ledger settings.',
  phases: [
    { title: 'Roadmap', detail: 'useful-first capability proof, repository inspection, adaptive scope, and concurrent assurance' },
    { title: 'Plan', detail: 'conditional G1 only for debug, unresolved design, explicit detailed-plan, or plan conflict' },
    { title: 'Build', detail: 'implementation, independent review, and real runtime verification' },
    { title: 'Sign-off', detail: 'independent risk sign-off when the selected route requires it' },
    { title: 'Sweep', detail: 'production sweep and adversarial goal check' },
    { title: 'Scribe', detail: 'append PROMPTS.txt, ROADMAP.md, and GATELOG.md; clean scratch only after sealed DONE' },
  ],
}

// Model and effort routing are centralized in applyPersonaCasting. With agent
// selection off, dispatch inherits the session. An explicit pre-launch cast is
// validated against the live aliases before any per-call model/effort is added.
// Selectable effort uses the provider's verified maximum for reasoning-heavy
// roles; inherited-only, unsupported, and unknown omit the per-call field.

// ----- execution modes (the easily-customizable block) -------------------
// TOKENSAVER (default): bounded fan-out - up to 6 agents live per wave (the
//   MODE_LIVE_CAP teeth below), so a lean run still parallelizes a little while
//   staying cheap and checkpoint-friendly.
// WIDE (professional primary name) / BILLIONAIRE (retained working alias):
//   unbounded fan-out. Every independent unit at once, no script-imposed cap
//   (not 3, not 30 - the harness queues past its own per-workflow slot limit),
//   bounded only by MAX_CONCURRENT. Use when speed matters and budget does not.
// CUSTOM: wide fan-out bounded by the operator's max_subs (feeds MAX_CONCURRENT).
// Select with args.mode: 'tokensaver' | 'wide' | 'billionaire' | 'custom'.
const EXECUTION_MODES = {
  tokensaver:  { parallelFeatures: true,  parallelPanel: true },
  wide:        { parallelFeatures: true,  parallelPanel: true },
  billionaire: { parallelFeatures: true,  parallelPanel: true }, // alias of wide
  custom:      { parallelFeatures: true,  parallelPanel: true },
}
const DEFAULT_MODE = 'tokensaver'

// ----- 5-level hierarchical topology (L0 -> L4) --------------------------
// base-instructions.Md re-architects the loop into FIVE levels. The harness is
// gate-based, but it MUST be level-aware so it can (a) forbid execution at L1
// (rule 68), (b) cap each L3's L4 leaf fan-out by mode, and (c) drive L3 tracks
// serially (TOKENSAVER) or in parallel (BILLIONAIRE) - the global throttle axis,
// distinct from the per-L3 fan-out (no numeric ceiling in BILLIONAIRE).
//
//   L0  lean conductor - start-dispatch + end-verdict only; touches nothing.
//   L1  coordinators - determine work/scope + own fleet-state reasoning; Agent-ONLY.
//       base:68 forbids ALL tools but Agent (no Read/Glob/Grep/Write/Edit/Bash) - fleet
//       state flows up via Agent-tool results / a reader-leaf on RESUME. For a single
//       bounded feature an L1 dispatches L3 executors DIRECTLY (manager optional).
//   L2  manager - holds context, builds the 5-field handoff; Read/Glob/Grep only.
//   L3  EXECUTORS - own one task, WRITE an artifact as their core function;
//       execute directly and/or fan to L4 leaves.
//   L4  terminal leaves - single-shot, independent, no fan-out (no Agent); they
//       still execute (write/run), they just spawn nothing further.
//
// Every gate persona is classified to its level here, matching the binding
// arbiter ruling and each persona file. The execution gates route to L3/L4
// personas; the supervisory roles to L0/L1; the manager to L2. A gate wired to
// an L0/L1/L2 persona is a programmer error caught by assertExecLevel.
const LEVEL_OF = {
  // L0 conductor (the harness/driver itself acts as L0 in code form)
  'cl-conductor': 'L0',
  // L1 coordinators - Agent-ONLY; own fleet-state reasoning, but base:68 forbids ALL
  // Read/Glob/Grep/Write/Edit/Bash (L1 never reads a file, nothing) - fleet state flows
  // up via Agent-tool results / a reader-leaf on RESUME
  'ap-scope-coordinator': 'L1',
  'ap-feature-coordinator': 'L1',
  'ap-sweep-coordinator': 'L1',
  // L2 manager - OPTIONAL; coordinates a multi-feature slice, may Read/Glob/Grep, writes nothing
  'ap-manager': 'L2',
  // L3 executors - own one task, write artifacts as their core function, fan to L4
  'ap-scoper': 'L3',
  'ap-planner': 'L3',
  'ap-synthesizer': 'L3',
  'ap-intake': 'L3',
  'ap-implementer': 'L3',
  'ap-reviewer': 'L3',
  'ap-verifier': 'L3',
  'ap-sweeper': 'L3',
  'ap-researcher': 'L3',
  'ap-execharness-resolver': 'L3',
  'ap-framework-generator': 'L3',
  // L4 terminal leaves - single-shot, independent, no fan-out (no Agent)
  'ap-fresh-verifier': 'L4',
  'ap-depth-prober': 'L4',
  'ap-framework-validator': 'L4',
  'ap-juror': 'L4',
  'ap-goal-checker': 'L4',
  'ap-preflight-probe': 'L4',
  'ap-arbiter': 'L4',
  'ap-re-anchor': 'L4',
  'ap-scribe': 'L4',
  'ap-janitor': 'L4',
}

// Per-L3 fan-out by mode. base-instructions line 27's "10" was a DEFAULT working
// set, NOT a hard cap; line 64 ("we can even have 50 agents, it really doesnt
// matter") + the mission govern. TOKENSAVER = up to 6 leaves per wave (the lean
// bounded fan-out). WIDE/BILLIONAIRE/CUSTOM = null = NO numeric per-L3 leaf
// ceiling: an L3 fans to as many disjoint L4 leaves as the work genuinely needs,
// bounded by MAX_CONCURRENT + disjoint ownership + real need + dedupe + the
// iron-rule-9 token budget - never a per-L3 number. This is NOT the global
// throttle (which decides whether sibling L3 tracks run serially or in parallel -
// modeled by EXECUTION_MODES.parallelFeatures). Consumed by resolveTopology's
// published summary AND, via MODE_LIVE_CAP below, given REAL teeth in the fanout
// chunker (TOKENSAVER waves of <=6; WIDE/CUSTOM up to MAX_CONCURRENT).
const LEAF_CAP = { tokensaver: 6, wide: null, billionaire: null, custom: null }

// Per-mode LIVE cap with REAL teeth: the fanout chunker bounds each parallel wave
// at min(MAX_CONCURRENT, MODE_LIVE_CAP[MODE]). null => no per-mode cap (only the
// global MAX_CONCURRENT ceiling applies). TOKENSAVER's 6 is what makes "up to 6
// concurrent" a hard runtime bound, not a cosmetic label; WIDE/BILLIONAIRE/CUSTOM
// stay null so they fan out to the global ceiling.
const MODE_LIVE_CAP = { tokensaver: 6, wide: null, billionaire: null, custom: null }

// ----- the user-settable GLOBAL max-concurrent knob (base 200) ------------
// The single number a user can set to bound how many agents run live at once
// across the WHOLE run, regardless of mode. It is a CEILING, not a target:
// TOKENSAVER still runs one at a time; BILLIONAIRE still fans out - but never
// wider than this many concurrent agents in any one parallel wave. Set it in
// ~/.claude/settings.json under env.AUTOPROMPT_MAX_CONCURRENT, or export the
// env var, or pass args.maxConcurrent. Base default is 200. A value < 1 or
// non-numeric falls back to the base. This is the knob the README points at.
// The GATES.md tier numbers (T0..T3) are an ADVISORY total-work / anti-sprawl
// target enforced by MODEL DISCIPLINE (dedupe), NOT a code-enforced concurrency
// cap. The real live ceiling is THIS knob; BILLIONAIRE parallelism is bounded by
// MAX_CONCURRENT + disjoint ownership + real need + dedupe, never by a per-L3 leaf
// number and never by a tier number.
const MAX_CONCURRENT_BASE = 200
function resolveMaxConcurrent() {
  // args may be a string (the mission) or undefined, so read maxConcurrent only
  // when args is a real object; otherwise treat it as absent (NOT false) so the
  // env var is still consulted. A bare-string args must never shadow the env knob.
  const fromArg = (typeof args === 'object' && args && args.maxConcurrent != null)
    ? args.maxConcurrent
    : undefined
  // max_subs=<N> operator alias: a lower-precedence source than the explicit
  // maxConcurrent knob, feeding the SAME ceiling. args.maxConcurrent wins when
  // both are set; args.maxSubs then wins over the env var.
  const fromSubs = (typeof args === 'object' && args && args.maxSubs != null)
    ? args.maxSubs
    : undefined
  const fromEnv = (typeof process === 'object' && process && process.env)
    ? process.env.AUTOPROMPT_MAX_CONCURRENT
    : undefined
  const picked = fromArg != null ? fromArg : (fromSubs != null ? fromSubs : fromEnv)
  const raw = Number(picked)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : MAX_CONCURRENT_BASE
}
const MAX_CONCURRENT = resolveMaxConcurrent()

// Levels at which execution (file writes, shell, real work) is FORBIDDEN. L0
// and L1 are Agent-ONLY - they touch NOTHING (base:68: L1 never reads a file,
// nothing); fleet state flows up via Agent-tool results / a reader-leaf. L2 may
// Read/Glob/Grep to scope but writes no code. Only L3 (the executor) and its L4
// leaves execute (write/run).
const NON_EXEC_LEVELS = new Set(['L0', 'L1', 'L2'])

// assertExecLevel (rule-68 guard): every executor gate site passes its agentType
// here before spawning. If a gate that does real work is ever wired to an L0/L1/
// L2 persona, this throws a deterministic programmer error (NON-transient) rather
// than letting a non-executing level silently run an execution gate. L1 in
// particular must never reach an execution site (base-instructions line 68).
function assertExecLevel(agentType, site) {
  const level = LEVEL_OF[agentType]
  if (!level) {
    throw new TypeError(`RULE-68 GUARD: executor site "${site}" wired to unknown persona "${agentType}" (no level mapping); fix LEVEL_OF`)
  }
  if (NON_EXEC_LEVELS.has(level)) {
    throw new TypeError(`RULE-68 GUARD: executor site "${site}" wired to a ${level} persona "${agentType}", but ${level} must NOT execute (base-instructions line 68 - L1 is Agent-only, never reads/writes/runs). Wire it to an L3/L4 executor.`)
  }
  return level
}

// assertSingleBlock (rule-67 spawn hygiene): every brief the harness assembles
// is ONE clean, single block. A malformed/oversized spawn splits in transit -
// one part sends, the rest is queued and lost (base-instructions line 67). A
// brief carrying a control split marker (NUL / line- or paragraph-separator) or
// an empty body would split downstream, so it is rejected here at assembly time.
const SPLIT_MARKERS = [0x0000, 0x2028, 0x2029].map(c => String.fromCharCode(c))
function assertSingleBlock(text, site) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError(`RULE-67 SPAWN HYGIENE: brief for "${site}" is empty/non-string; a brief must be one whole block`)
  }
  for (const marker of SPLIT_MARKERS) {
    if (text.indexOf(marker) !== -1) {
      throw new TypeError(`RULE-67 SPAWN HYGIENE: brief for "${site}" carries a control split marker; it would split in transit (one part sent, the tail queued). Emit ONE clean block.`)
    }
  }
  return text
}

// resolveTopology: the run-stable 5-level topology the harness actually computed
// from MODE. Published in the summary so the level map, the per-L3 fan-out, and
// the global throttle axis are inspectable behaviorally (not just grep-able).
function resolveTopology(mode) {
  const personasByLevel = { L0: [], L1: [], L2: [], L3: [], L4: [] }
  for (const [persona, level] of Object.entries(LEVEL_OF)) personasByLevel[level].push(persona)
  const ROLE = {
    L0: 'lean conductor - start-dispatch + end-verdict only; touches nothing',
    L1: 'coordinators - determine work/scope + own fleet-state; read to scope, never write/run (rule 68)',
    L2: 'managers (optional) - hold context for a multi-feature slice, build the handoff; Read/Glob/Grep only',
    L3: 'executors - own one task; execute directly and/or fan to L4 leaves',
    L4: 'fan-out leaves - parallel hands; terminal',
  }
  return {
    levels: ['L0', 'L1', 'L2', 'L3', 'L4'].map(level => ({
      level,
      role: ROLE[level],
      canExecute: !NON_EXEC_LEVELS.has(level),
      personas: personasByLevel[level],
    })),
    leafCap: Object.prototype.hasOwnProperty.call(LEAF_CAP, mode) ? LEAF_CAP[mode] : LEAF_CAP[DEFAULT_MODE],
    liveCap: (Object.prototype.hasOwnProperty.call(MODE_LIVE_CAP, mode) ? MODE_LIVE_CAP[mode] : MODE_LIVE_CAP[DEFAULT_MODE]) ?? null,
    parallelTracks: !!(EXECUTION_MODES[mode] || EXECUTION_MODES[DEFAULT_MODE]).parallelFeatures,
    multiTaskSplitSite: 'L2->L3',
    depthCap: 5,
  }
}

// ----- config -----------------------------------------------------------
const MAX_PLAN_CYCLES = 2          // G1<->G2 SMASH cycles before arbiter
const MAX_FRESH_CYCLES = 1         // G3 REJECT cycles before a binding decision
const PLAN_ATTEMPT_BUDGET = 3      // hard cap on total plan attempts; arbiter cannot reset past this
const IMPL_ATTEMPT_BUDGET = 3      // hard cap on total implement+verify attempts; survives arbiter resets
const MAX_IMPL_CYCLES = 2          // G4<->G5 SMASH cycles before arbiter
const MAX_VERIFY_CYCLES = 1        // G6 FAILED -> G4 retry budget before arbiter
const PANEL_SIZE = 3               // G7 independent sign-off agents
const MAX_SWEEP_ROUNDS = 2         // hard cap on sweep rounds (cost + termination guard)
const REQUIRED_CLEAN_SWEEPS = 1    // one clean sweep closes a bounded convergence pass
const MIN_BUDGET_TO_SPAWN = 60000  // stop opening NEW work below this many output tokens remaining
const COVERAGE_FLOOR = 95          // the mission's hard coverage floor; a <95 number FAILS verify and blocks DONE
const MAX_SCOPE_CYCLES = 2         // one targeted repair after the initial assurance cycle
const RETRY_MAX_ATTEMPTS = 3       // one call may consume at most three provider dispatches
const RETRY_MAX_ELAPSED_MS = 90 * 1000
// === USEFUL-OUTPUT-BUDGET-SLICE:START ===
function retryBudgetVerdict({
  attempt,
  elapsedMs,
  maxAttempts,
  maxElapsedMs,
}) {
  if (attempt >= maxAttempts) {
    return {
      canRetry: false,
      reason:
        `transient retry attempt budget exhausted ` +
        `(${attempt}/${maxAttempts})`,
    }
  }
  if (elapsedMs >= maxElapsedMs) {
    return {
      canRetry: false,
      reason:
        `transient retry wall-clock budget exhausted ` +
        `(${elapsedMs}ms/${maxElapsedMs}ms)`,
    }
  }
  return { canRetry: true, reason: '' }
}

function researchProgressReasons(progress) {
  const value = progress && typeof progress === 'object'
    ? progress
    : {}
  const reasons = []
  const pairs = [
    ['search', value.searchesClaimed, value.searchesReceipted, 6],
    ['fetch', value.fetchesClaimed, value.fetchesReceipted, 6],
    [
      'usable-inspection',
      value.usableInspectionsClaimed,
      value.usableInspectionsReceipted,
      null,
    ],
  ]

  for (const [label, claimed, receipted, budget] of pairs) {
    const areValidCounts =
      Number.isInteger(claimed) &&
      claimed >= 0 &&
      Number.isInteger(receipted) &&
      receipted >= 0
    if (!areValidCounts) {
      reasons.push(
        `${label} counts must be non-negative integers`,
      )
      continue
    }
    if (claimed > receipted) {
      reasons.push(
        `${label} claims exceed inspectable receipts ` +
        `(${claimed} claimed, ${receipted} receipted)`,
      )
    } else if (receipted > claimed) {
      reasons.push(
        `${label} receipts exceed claims ` +
        `(${receipted} receipted, ${claimed} claimed)`,
      )
    } else if (budget !== null && claimed > budget) {
      reasons.push(`${label} budget exceeded (${claimed}/${budget})`)
    }
  }

  if (
    !Number.isInteger(value.materializedOutputs) ||
    value.materializedOutputs < 1
  ) {
    reasons.push('research produced zero materialized outputs')
  }
  return reasons
}

function hashResearchReceiptText(text) {
  const getBuiltin =
    typeof process === 'object' &&
    process &&
    typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule.bind(process)
      : null
  const crypto = getBuiltin &&
    (getBuiltin('node:crypto') || getBuiltin('crypto'))
  if (!crypto) return ''
  return crypto.createHash('sha256').update(text).digest('hex')
}

function readResearchReceiptArtifact(artifactPath) {
  const getBuiltin =
    typeof process === 'object' &&
    process &&
    typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule.bind(process)
      : null
  const fileSystem = getBuiltin &&
    (getBuiltin('node:fs') || getBuiltin('fs'))
  if (!fileSystem) {
    throw new TypeError('filesystem inspection is unavailable')
  }
  return fileSystem.readFileSync(artifactPath, 'utf8')
}

function researchReceiptReasons(
  progress,
  readReceipt = readResearchReceiptArtifact,
  hashText = hashResearchReceiptText,
) {
  const value = progress && typeof progress === 'object'
    ? progress
    : {}
  const binding = value.receiptArtifact
  if (
    !binding ||
    typeof binding.path !== 'string' ||
    binding.path === '' ||
    /\.tmp$/i.test(binding.path) ||
    !/^sha256:[a-f0-9]{64}$/.test(binding.hash || '') ||
    !Number.isInteger(binding.bytes) ||
    binding.bytes < 1
  ) {
    return ['research receipt artifact binding is missing or malformed']
  }

  let receiptText
  try {
    receiptText = readReceipt(binding.path)
  } catch (error) {
    return [
      `research receipt artifact is not inspectable (${error && error.code || 'read failed'})`,
    ]
  }
  const reasons = []
  const actualHash = typeof hashText === 'function'
    ? `sha256:${hashText(receiptText)}`
    : ''
  if (actualHash !== binding.hash) {
    reasons.push(
      'research receipt artifact hash does not match durable bytes',
    )
  }
  const actualBytes = unescape(encodeURIComponent(receiptText)).length
  if (actualBytes !== binding.bytes) {
    reasons.push(
      'research receipt artifact byte count does not match durable bytes',
    )
  }
  if (reasons.length) return reasons

  let rows
  try {
    rows = JSON.parse(receiptText)
  } catch {
    return ['research receipt artifact is not valid JSON']
  }
  if (!Array.isArray(rows)) {
    return ['research receipt artifact must contain an array of call receipts']
  }

  const counts = {
    search: 0,
    fetch: 0,
    'usable-inspection': 0,
  }
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || !(row.kind in counts)) {
      reasons.push(`research receipt row ${index + 1} has an invalid kind`)
      return
    }
    counts[row.kind]++
    if (typeof row.request !== 'string' || row.request.trim() === '') {
      reasons.push(`research receipt row ${index + 1} has no request`)
    }
    if (typeof row.source !== 'string' || row.source.trim() === '') {
      reasons.push(`research receipt row ${index + 1} has no source`)
    }
    if (
      typeof row.contribution !== 'string' ||
      row.contribution.trim() === ''
    ) {
      reasons.push(
        `research receipt row ${index + 1} has no material contribution`,
      )
    }
  })
  for (const [kind, reported] of [
    ['search', value.searchesReceipted],
    ['fetch', value.fetchesReceipted],
    ['usable-inspection', value.usableInspectionsReceipted],
  ]) {
    if (Number.isInteger(reported) && counts[kind] !== reported) {
      reasons.push(
        `${kind} receipt rows do not match the reported count ` +
        `(${counts[kind]} rows, ${reported} reported)`,
      )
    }
  }
  return reasons
}
// === USEFUL-OUTPUT-BUDGET-SLICE:END ===

const SCOPING_ANGLES = [           // ordered complementary evidence themes used only when the classified profile needs scouts
  { key: 'domain', label: 'DOMAIN & LANDSCAPE', research: true },
  { key: 'capability', label: 'CAPABILITY / FEATURE TREE', research: false },
  { key: 'experience', label: 'EXPERIENCE / INTERFACE SURFACES', research: false },
  { key: 'architecture', label: 'REAL-SYSTEMS / ARCHITECTURE + STRESS', research: false },
  { key: 'operability', label: 'OPERABILITY / QUALITY', research: false },
]

// ----- TIER LADDER (the proportionality fix; GATES.md "TIER CONTRACTS") ----
// The gate sequence is NOT one fixed pipeline. ROADMAP.md assigns each item a
// TIER (T0-T3, rubric in PLAYBOOKS.md) and the feature runs ONLY that tier's
// gate SUBSET. The full G1-G6 + 3-juror panel + converge-SWEEP stack is T3 -
// the ceiling, not the default. This is the mechanical fix for the benchmark's
// always-heavy 22x cost: a four-line bug fix (T1) must not run the same gates
// as "build me a SaaS" (T3). Every tier still ends in the run-level default-FAIL
// GOAL-CHECK (the keeper that caught the one real benchmark defect).
//
//   plan       - a tier may run G1 when the roadmap marks a conditional-plan reason
//   planLoop   - a conditional G1 plan gets review+fresh-verify assurance at T3
//   implReview - G5 IMPL-REVIEW runs after IMPLEMENT
//   verify     - G6 VERIFY runs (T1 once / T2-T3 with retries)
//   panelSize  - G7 SIGN-OFF jurors (0 = no panel, 1 = T2, 3 = T3 unanimous)
//   redoBudget - in-tier FAIL redos before the feature ESCALATES one tier up
const TIER_PIPELINE = {
  T0: { plan: false, planLoop: false, implReview: true,  verify: true,  panelSize: 0, redoBudget: 1 },
  T1: { plan: false, planLoop: false, implReview: true,  verify: true,  panelSize: 0, redoBudget: 1, freshVerifyDebug: true },
  T2: { plan: true,  planLoop: false, implReview: true,  verify: true,  panelSize: 1, redoBudget: 2 },
  T3: { plan: true,  planLoop: true,  implReview: true,  verify: true,  panelSize: PANEL_SIZE, redoBudget: MAX_IMPL_CYCLES },
}
const TIER_ORDER = ['T0', 'T1', 'T2', 'T3']
const DEFAULT_TIER = 'T3'   // an omitted/unknown tier resolves to the safe ceiling

// Run-level SWEEP scaled by the mission's highest feature tier (PLAYBOOKS:
// T0/T1 no sweep - GOAL-CHECK is the backstop; T2 mini-sweep 1 round; T3 sweep
// to convergence). This is the lean win at the run level: a bounded mission
// skips the whole sweeper wave and goes straight to the terminal GOAL-CHECK.
const SWEEP_BY_TIER = {
  T0: { rounds: 0, cleanRequired: 0 },
  T1: { rounds: 0, cleanRequired: 0 },
  T2: { rounds: 1, cleanRequired: 1 },
  T3: { rounds: MAX_SWEEP_ROUNDS, cleanRequired: REQUIRED_CLEAN_SWEEPS },
}

// Every run enters the adaptive roadmap flow once. The roadmap author classifies
// scope as bounded, multi-surface, or unusually-large; scopeTopology() then fixes
// the agent/round budget. ROADMAP.md carries the repository intelligence, ordered
// dependency lanes, framework choices, tests, and verification needed by build.

// resolveTier: an explicit, recognized tier is honored; anything else (omitted,
// null, unknown) resolves to a SAFE FALLBACK so a feature can never silently
// take a leaner path than it earns. The fallback is the T3 ceiling for an
// expand-mission (ambitious) run, but drops to T1 when EXPAND_MISSION is off -
// a bounded run's omitted tier is a bounded task, not a moonshot. An explicit
// tier from ROADMAP.md always wins either way; the fallback only fills a blank.
function resolveTier(feature) {
  const t = feature && feature.tier
  if (TIER_PIPELINE[t]) return t
  return (typeof EXPAND_MISSION !== 'undefined' && !EXPAND_MISSION) ? 'T1' : DEFAULT_TIER
}

// nextTier: a feature climbs exactly ONE tier on FAIL/OUT-OF-SCOPE and re-runs
// there. T3 is the ceiling and never climbs (it arbitrates instead).
function nextTier(tier) {
  const i = TIER_ORDER.indexOf(tier)
  return i < 0 || i >= TIER_ORDER.length - 1 ? DEFAULT_TIER : TIER_ORDER[i + 1]
}

// ----- FRAMEWORK HARD GATE (SPD-4 / F-FRAMEWORK) --------------------------
// Framework selection is a HARD GATE at dispatch. Every feature builds under a
// framework LEAF; the leaf's declared `GATE PATH:` line is the gate sequence and
// its tier is the depth ceiling. An ABSENT or UNKNOWN framework at dispatch is an
// INVALID-DISPATCH: the feature routes to ap-framework-generator to MINT one before
// any build gate runs (mirrors the ledger-side frameworkTierFindings/Fallthrough
// rules, which are the post-hoc teeth; this is the pre-dispatch teeth).
// The 14 leaves are lockstep with agents/claude/frameworks/*.md (the prose decision tree,
// the single routing source of truth since framework-selector.js was deleted, P-26).
const KNOWN_FRAMEWORK_LEAVES = new Set([
  'apply', 'backend-build', 'backend-fix', 'backend-implement', 'docs',
  'frontend-build', 'frontend-fix', 'frontend-implement', 'frontend-review',
  'plan-design', 'plan-research', 'plan-scope', 'polish', 'refactor',
])
// The `apply` leaf's GATE PATH skips G1-G3 (no PLAN/FRESH-VERIFY) and G7 (no
// SIGN-OFF): APPLY -> DIFF-REVIEW -> VERIFY-GREEN, i.e. G4 -> G5 -> G6 + the
// GOAL-CHECK floor. NARROW GATE-PATH INTERPRETATION: this is the one leaf whose
// declared path materially reshapes the tier pipeline (like the debug playbook's
// G3.5), so it is special-cased here. FULL interpretation would parse every leaf's
// `GATE PATH:` line and drive the exact sequence per leaf; that is deferred - the
// tier ladder + this apply special-case cover the material cases today.
const APPLY_FRAMEWORK = 'apply'

// frameworkDispatchVerdict: the pre-dispatch hard-gate verdict for a feature.
// Returns { ok:true, framework } when the leaf is known, else { ok:false, reason,
// framework } naming the INVALID-DISPATCH so the caller routes to the generator.
function frameworkDispatchVerdict(feature) {
  const framework = feature && typeof feature.framework === 'string' ? feature.framework.trim() : ''
  if (framework === '') {
    return { ok: false, framework: '', reason: 'absent framework - no leaf selected for this feature' }
  }
  if (!KNOWN_FRAMEWORK_LEAVES.has(framework)) {
    return { ok: false, framework, reason: `unknown framework leaf "${framework}" - not one of the ${KNOWN_FRAMEWORK_LEAVES.size} declared leaves` }
  }
  return { ok: true, framework }
}

// defaultFrameworkForCategory: the deterministic leaf ap-framework-generator would
// MINT for a feature whose framework is absent/unknown, derived from its category +
// tag. This is the narrow generator: it never blocks the run, but it ALWAYS names a
// concrete known leaf so no build gate runs framework-less (the ledger-side rules
// then attest the FEATURE-META framework= token). FULL routing spawns the
// ap-framework-generator agent; this deterministic mapping is the narrow stand-in.
function defaultFrameworkForCategory(feature) {
  const category = feature && typeof feature.category === 'string' ? feature.category : ''
  const isDebug = feature && feature.tag === 'debug'
  switch (category) {
    case 'frontend': return isDebug ? 'frontend-fix' : 'frontend-build'
    case 'plan':     return 'plan-design'
    case 'docs':     return 'docs'
    case 'data':
    case 'integration':
    case 'infra':
    case 'backend':
    default:         return isDebug ? 'backend-fix' : 'backend-build'
  }
}

// resolveFramework: the HARD GATE applied once at dispatch. A known leaf passes
// through; an absent/unknown one is an INVALID-DISPATCH that the narrow generator
// repairs by MINTING a category-derived leaf (logged loudly), so the feature never
// builds framework-less. Returns the resolved known leaf and mutates feature.framework.
function resolveFramework(feature) {
  const verdict = frameworkDispatchVerdict(feature)
  if (verdict.ok) return verdict.framework
  const minted = defaultFrameworkForCategory(feature)
  log(`INVALID-DISPATCH ${feature.id}: ${verdict.reason}; routing to ap-framework-generator - minted framework="${minted}" (${feature.category}${feature.tag ? `/${feature.tag}` : ''}). No build gate runs framework-less.`)
  feature.framework = minted
  return minted
}


// maxTier: the mission-level tier is the HIGHEST feature tier; it decides the
// run-level sweep depth and is recorded in the summary.
function maxTier(featureList) {
  let top = 'T0'
  for (const f of featureList) {
    const t = resolveTier(f)
    if (TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(top)) top = t
  }
  return top
}

// ----- persona routing (v4.0 hierarchical personas) -----------------------
// Each gate maps to a specific custom agent definition (in agents/claude/agents/).
// agentType routes agent() to the right persona. When recursive depth is
// available, supervisors (L1) handle pipeline orchestration; when unavailable,
// the parent drives the gates directly via the L3 executor / L4 leaf personas.
const PERSONA = {
  preflight: 'ap-preflight-probe',
  intake: 'ap-intake',
  scopeSupervisor: 'ap-scope-coordinator',
  scoper: 'ap-scoper',
  researcher: 'ap-researcher',
  synthesizer: 'ap-synthesizer',
  featureSupervisor: 'ap-feature-coordinator',
  planner: 'ap-planner',
  reviewer: 'ap-reviewer',
  freshVerifier: 'ap-fresh-verifier',
  depthProber: 'ap-depth-prober',
  implementer: 'ap-implementer',
  verifier: 'ap-verifier',
  execharnessResolver: 'ap-execharness-resolver',
  frameworkGenerator: 'ap-framework-generator',
  frameworkValidator: 'ap-framework-validator',
  juror: 'ap-juror',
  scribe: 'ap-scribe',
  sweepSupervisor: 'ap-sweep-coordinator',
  sweeper: 'ap-sweeper',
  goalChecker: 'ap-goal-checker',
  arbiter: 'ap-arbiter',
  reAnchor: 'ap-re-anchor',
  janitor: 'ap-janitor',
}

// ----- wait-and-retry policy --------------------------------------------
// A transient interruption retries the SAME call, but a provider outage cannot
// hold one gate for hours. The attempt and wall-clock budgets above terminate
// the call loudly; the external supervisor can resume from durable state.
const RETRY_BASE_MS = 1000
const RETRY_FACTOR = 2
const RETRY_CAP_MS = 15 * 1000
const RETRY_JITTER = 0.2
// CONTEXT IS NON-TERMINAL: a full context window is a COMPACTION event, never a
// stop. In a model-discipline run the loop compacts (preserving mission text,
// RUN-NONCE, current phase, frozen plans, completed artifacts), runs the
// POST-COMPACTION RE-ANCHOR, and resumes the in-flight gate. This can fire any
// number of times, anywhere; the harness never voluntarily yields the loop.

// ----- schemas ----------------------------------------------------------
// ROADMAP.md is the single executable scope contract. It replaces intake.md,
// scope-map.md, bucketlist.md, and redundant lane-local plans on new runs.
const ROADMAP_ITEM_PROPERTIES = {
  id: { type: 'string', description: 'stable feature id' },
  title: { type: 'string' },
  category: { type: 'string', enum: ['plan', 'backend', 'frontend', 'data', 'integration', 'infra', 'docs'] },
  tag: { type: 'string', enum: ['debug', 'research', 'user-facing', 'polish', 'external-target'] },
  tier: { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'] },
  framework: { type: 'string', description: 'selected framework leaf' },
  boundary: { type: 'string', description: 'owned paths/area; parallel lanes must not overlap' },
  dependsOn: { type: 'array', items: { type: 'string' } },
  launchGroup: { type: 'integer', minimum: 0 },
  integrationLane: { type: 'string', description: 'where and how this item joins the final deliverable' },
  doneMeans: { type: 'string' },
  implementationSteps: { type: 'array', minItems: 1, items: { type: 'string' } },
  acceptanceCriteria: { type: 'array', minItems: 1, items: { type: 'string' } },
  unhappyPaths: { type: 'array', minItems: 1, items: { type: 'string' } },
  testsFirst: { type: 'array', minItems: 1, items: { type: 'string' } },
  verification: { type: 'array', minItems: 1, items: { type: 'string' } },
  coverageRequirement: { type: 'string', pattern: '95%' },
  requiresDetailedPlan: { type: 'boolean' },
}
const ROADMAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['capability', 'resolvedModel', 'effortStatus', 'promptLedgerPath', 'missionPointer', 'scopeProfile', 'repositoryIntel', 'toolDecisions', 'frameworkDecisions', 'items', 'ordered', 'hasTimeEstimates', 'roadmapPath', 'roadmapHash', 'roadmapBytes'],
  properties: {
    capability: {
      type: 'object',
      additionalProperties: false,
      required: ['run', 'read', 'write', 'evidence'],
      properties: {
        run: { type: 'boolean' },
        read: { type: 'boolean' },
        write: { type: 'boolean' },
        evidence: { type: 'string' },
      },
    },
    resolvedModel: { type: 'string' },
    effortStatus: { type: 'string', enum: ['selectable', 'inherited-only', 'unsupported', 'unknown'] },
    promptLedgerPath: { type: 'string' },
    missionPointer: {
      type: 'object', additionalProperties: false,
      required: ['path', 'hash', 'bytes', 'nonce'],
      properties: {
        path: { type: 'string' },
        hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        bytes: { type: 'integer', minimum: 1 },
        nonce: { type: 'string' },
      },
    },
    scopeProfile: { type: 'string', enum: ['bounded', 'multi-surface', 'unusually-large'] },
    escalationReason: { type: 'string' },
    repositoryIntel: { type: 'string' },
    toolDecisions: { type: 'array', minItems: 1, items: { type: 'string' } },
    frameworkDecisions: { type: 'array', minItems: 1, items: { type: 'string' } },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'category', 'tier', 'framework', 'boundary', 'dependsOn', 'launchGroup', 'integrationLane', 'doneMeans', 'implementationSteps', 'acceptanceCriteria', 'unhappyPaths', 'testsFirst', 'verification', 'coverageRequirement', 'requiresDetailedPlan'],
        properties: ROADMAP_ITEM_PROPERTIES,
      },
    },
    ordered: { type: 'boolean' },
    hasTimeEstimates: { type: 'boolean' },
    roadmapPath: { type: 'string' },
    roadmapHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    roadmapBytes: { type: 'integer', minimum: 1 },
    nonce: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasons'],
  properties: {
    verdict: { type: 'string', enum: ['SMASH', 'PASS'] },
    reasons: { type: 'array', items: { type: 'string' }, description: 'numbered, specific; what to change if SMASH' },
    suggestions: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'boolean', description: 'true ONLY if this task is larger/riskier than its assigned tier (touches >1 subsystem, needs a real design decision, a hidden cross-cutting failure surfaced) - it climbs ONE tier and re-runs there. A fixable local defect is NOT out-of-scope; that is an ordinary SMASH.' },
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}

const PUBLICATION_PROPERTIES = {
  transition: { type: 'string' },
  featureId: { type: 'string' },
  artifactPath: { type: 'string' },
  artifactExists: { type: 'boolean' },
  artifactHash: {
    type: 'string',
    pattern: '^sha256:[a-f0-9]{64}$',
  },
  artifactBytes: { type: 'integer', minimum: 1 },
  nonce: { type: 'string' },
  producerGate: { type: 'string' },
  producerPersona: { type: 'string' },
  verdict: { type: 'string' },
  ledgerPath: { type: 'string' },
  ledgerRow: { type: 'string' },
  ledgerRowHash: {
    type: 'string',
    pattern: '^sha256:[a-f0-9]{64}$',
  },
  ledgerRowDurable: { type: 'boolean' },
}

const PUBLICATION_REQUIRED = Object.keys(
  PUBLICATION_PROPERTIES,
)

const PUBLICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: PUBLICATION_REQUIRED,
  properties: PUBLICATION_PROPERTIES,
}

const FRESH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasons'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REJECT'] },
    reasons: { type: 'array', items: { type: 'string' } },
    publication: PUBLICATION_SCHEMA,
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}

const PLAN_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'publication'],
  properties: {
    plan: { type: 'string' },
    publication: PUBLICATION_SCHEMA,
    nonce: { type: 'string' },
  },
}

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'evidence',
    'corrections',
    'evidenceHash',
    'evidenceBytes',
    'researchRequired',
    'searchesClaimed',
    'searchesReceipted',
    'fetchesClaimed',
    'fetchesReceipted',
    'usableInspectionsClaimed',
    'usableInspectionsReceipted',
    'materializedOutputs',
  ],
  properties: {
    evidence: { type: 'array', items: { type: 'string' } },
    corrections: { type: 'array', items: { type: 'string' } },
    evidenceHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    evidenceBytes: { type: 'integer', minimum: 1 },
    researchRequired: { type: 'boolean' },
    searchesClaimed: { type: 'integer', minimum: 0 },
    searchesReceipted: { type: 'integer', minimum: 0 },
    fetchesClaimed: { type: 'integer', minimum: 0 },
    fetchesReceipted: { type: 'integer', minimum: 0 },
    usableInspectionsClaimed: { type: 'integer', minimum: 0 },
    usableInspectionsReceipted: { type: 'integer', minimum: 0 },
    materializedOutputs: { type: 'integer', minimum: 0 },
    receiptArtifact: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'hash', 'bytes'],
      properties: {
        path: { type: 'string' },
        hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        bytes: { type: 'integer', minimum: 1 },
      },
    },
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'filesChanged',
    'testsWritten',
    'testEvidence',
    'conflictReason',
  ],
  properties: {
    status: { type: 'string', enum: ['COMPLETE', 'PLAN-CONFLICT', 'SPLIT-REQUEST'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsWritten: { type: 'array', items: { type: 'string' } },
    testEvidence: { type: 'string' },
    conflictReason: { type: 'string' },
    splitBoundaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['boundary', 'dependsOn'],
        properties: {
          boundary: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    publication: PUBLICATION_SCHEMA,
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}

// F-DEPTH G3.5 DEPTH-LOCK schema. The ap-depth-prober derives D1-D5 from the
// issue text BLIND to the proposed fix layer, then compares. The verdict is
// RECOMPUTED in code via depthLockPass (never trusted from the string): a PASS
// over a layer that does not equal d3DeepestCause, or a D4 repro not proven RED
// unpatched, is overridden to depth-miss.
const DEPTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'd3DeepestCause', 'reproRed'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'REJECT'] },
    d1HomeFunction: { type: 'string', description: 'file:function where the behavior is DECIDED, derived from the issue text alone' },
    d3DeepestCause: { type: 'string', description: 'the single deepest point (file.py::function) fixing ALL D2 input classes - derived BLIND to the proposed fix layer' },
    reproRed: { type: 'boolean', description: 'was the D4 adversarial issue-derived repro proven RED against UNPATCHED code (real captured red output on record)?' },
    reasons: { type: 'array', items: { type: 'string' } },
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'evidence', 'coveragePercent'],
  properties: {
    verdict: { type: 'string', enum: ['VERIFIED', 'FAILED'] },
    evidence: { type: 'string', description: 'key command output proving the verdict - the VERBATIM before/after test runs, not a paraphrase' },
    coveragePercent: { type: 'number' },
    // GROUNDED BEFORE/AFTER FIELDS (the anti-coverage-theater fix). VERIFIED is
    // RECOMPUTED in code from these, never trusted from the verdict string: a
    // model that says VERIFIED while a pre-existing test regressed (the
    // astropy-7606 failure) is overridden to FAILED.
    testCommand: { type: 'string', description: 'the exact command run to exercise the tests (so the run is reproducible and auditable)' },
    reproWasRed: { type: 'boolean', description: 'DEBUG: did the issue reproduction case provably FAIL on the code BEFORE the fix (real captured red output)? A debug fix with no red baseline is invalid - you cannot prove you fixed what you never reproduced. Non-debug features may report true vacuously only if there is genuinely no repro to run.' },
    reproNowGreen: { type: 'boolean', description: 'did the reproduction case / the feature\'s target behavior provably PASS after the fix (real captured green output)? Required true for VERIFIED.' },
    preExistingRegressions: { type: 'array', items: { type: 'string' }, description: 'test ids that were GREEN before the change and are RED after it, across every touched module AND its direct dependents. ANY entry is a hard FAILED - a green→red flip is a regression, never arbitrable into DONE. Empty list = no regressions found (you MUST have actually run those tests to claim this).' },
    outOfScope: { type: 'boolean', description: 'true ONLY if verifying revealed the task is larger/riskier than its assigned tier (a hidden cross-cutting failure surfaced, it needs a real design decision) - it climbs ONE tier and re-runs there. A plain failing test is NOT out-of-scope; that is an ordinary FAILED.' },
    // REAL-RUNNER EVIDENCE FIELDS (the keystone anti-MVCE fix). Optional in the
    // schema, RECOMPUTED in code on a debug verify (never trusted): a verifier
    // that ran only a `python -c "...print..."` MVCE instead of a real test
    // runner is overridden to FAILED. The non-debug vacuous path co-exists, so
    // these are not in `required` - the recompute is the enforcement locus.
    runnerKind: { type: 'string', enum: ['pytest', 'unittest', 'nose', 'tox', 'go-test', 'jest', 'cargo', 'other', 'none'], description: 'the test-runner family actually invoked; `none` means no real runner ran (auto-FAIL on a debug verify).' },
    runnerInvocation: { type: 'string', description: 'the exact runner command executed, e.g. python -m pytest path::node. A python -c "..." MVCE re-run is NOT a runner invocation.' },
    collectedTestCount: { type: 'integer', minimum: 0, description: 'how many tests the runner collected (the "collected N items" line). <1 is auto-FAIL on a debug verify.' },
    assertingTestNodeId: { type: 'string', description: 'the specific test node id that reproduces the bug, e.g. tests/test_x.py::TestY::test_z. Required non-empty whenever reproNowGreen===true on a debug verify.' },
    redBaselineStashGated: { type: 'boolean', description: 'DEBUG: was the authored asserting test proven RED on a git-stashed CLEAN tree (git stash -> run -> assert red -> git stash pop) before counting as the red baseline? A claimed reproWasRed=true without a stash-gated red run is recomputed to FAILED (the red baseline must be git-restorable proof, not a trusted assertion).' },
    inputClassesCovered: { type: 'integer', minimum: 0, description: 'ADVISORY: how many DISTINCT input FORMS/classes the repro + fix exercise (e.g. foo / ./foo / /abs/foo / foo/ for path matching; the structural post-conditions for a state bug). On a debug verify, < 2 is a SOFT floor fed back to G4 (arbitrable, not a hard FAIL).' },
    branchCoveragePercent: { type: 'number', description: 'ADVISORY: branch coverage on the changed lines, measured by the coverage tool. On a debug verify, below the named branch floor is a SOFT floor fed back to G4 (arbitrable, not a hard FAIL).' },
    reasons: { type: 'array', items: { type: 'string' } },
    publication: PUBLICATION_SCHEMA,
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}

// === KEYSTONE-RECOMPUTE-SLICE:START - test-only export seam; sliced by keystone-grounded-verify.test.js. Self-contained: references only these symbols + built-ins. ===
const REAL_RUNNER_RE = /\b(pytest|py\.test|python -m pytest|unittest|nose2?|tox|go test|jest|mocha|cargo test)\b/
const MIN_INPUT_CLASSES = 2                 // FIX-03 soft floor: a debug repro must exercise >= 2 distinct input classes
const BRANCH_COVERAGE_FLOOR = 90            // FIX-15 soft floor: branch coverage on changed lines (distinct from the 95% LINE floor; branch coverage is structurally harder, and matplotlib's verify-fragile pass sat at ~71%)

// Recompute the grounded-verify failure reasons from CAPTURED fields, never the
// verdict string. The three runner rules are DEBUG-GATED (isDebug): the forensic
// 0/6 failures were all debug/SWE-bench, and a non-debug feature may legitimately
// have no runnable test target (docs/config/pure-refactor) - gating them there
// avoids a false-FAIL while still trapping every debug fix. Non-debug still clears
// the ungated reproNowGreen / preExistingRegressions rules.
function groundedVerifyReasons(verify, isDebug) {
  const reasons = []
  // Ungated affirmative-evidence rules: an omitted field is NEVER clean
  // evidence. VERIFIED requires an explicit green and an explicit (possibly
  // empty) regression sweep, on debug and non-debug alike.
  const regressions = Array.isArray(verify.preExistingRegressions) ? verify.preExistingRegressions : null
  if (verify.reproNowGreen === false) reasons.push('repro/target is not green after the fix (reproNowGreen=false)')
  else if (verify.reproNowGreen !== true) reasons.push('no affirmative post-change green evidence (reproNowGreen omitted) - an omitted field is not a green run')
  if (regressions === null) reasons.push('no affirmative regression-sweep evidence (preExistingRegressions omitted) - an omitted field is not a clean sweep')
  else if (regressions.length) reasons.push(`pre-existing test regression(s) green->red (hard FAILED, never arbitrable into DONE): ${regressions.join(', ')}`)
  if (isDebug) {
    if (verify.reproWasRed !== true) reasons.push('debug fix has no proven RED baseline (reproWasRed!=true) - cannot claim a fix for a bug never shown failing first')
    const invocation = typeof verify.runnerInvocation === 'string' ? verify.runnerInvocation.trim() : ''
    if (verify.runnerKind === 'none' || !REAL_RUNNER_RE.test(invocation)) reasons.push('G6 artifact contains no real test-runner invocation (a `python -c` MVCE re-run is not evidence)')
    if (!(typeof verify.collectedTestCount === 'number' && verify.collectedTestCount >= 1)) reasons.push('zero tests collected (collectedTestCount < 1)')
    const node = typeof verify.assertingTestNodeId === 'string' ? verify.assertingTestNodeId.trim() : ''
    if (verify.reproNowGreen === true && node === '') reasons.push('no asserting test named (reproNowGreen=true but assertingTestNodeId empty)')
    if (verify.reproWasRed === true && verify.redBaselineStashGated !== true) reasons.push('red baseline not git-stash-gated (the authored test must FAIL on a git-stashed clean tree: git stash -> run -> assert red -> git stash pop, before it counts as the red baseline)')
  }
  return reasons
}

// SOFT rigor floors (FIX-03 input-domain, FIX-15 branch coverage). Advisory and
// DEBUG-GATED: a breach is fed back to G4 like the COVERAGE_FLOOR (arbitrable),
// NOT a hard verdict override. Permissive-on-absence (mirrors COVERAGE_FLOOR): a
// missing/non-number field does not trip the floor, so non-debug and field-less
// verifies are never false-FAILed and the keystone HARD rules are not made soft.
function softFloorReasons(verify, isDebug) {
  const reasons = []
  if (!isDebug) return reasons
  const inputClasses = verify.inputClassesCovered
  if (typeof inputClasses === 'number' && inputClasses < MIN_INPUT_CLASSES) reasons.push(`input-domain too narrow: only ${inputClasses} distinct input class(es) exercised (< ${MIN_INPUT_CLASSES}); enumerate and cover more input forms, then re-verify`)
  const branch = verify.branchCoveragePercent
  if (typeof branch === 'number' && branch < BRANCH_COVERAGE_FLOOR) reasons.push(`branch coverage ${branch}% on changed lines is below the ${BRANCH_COVERAGE_FLOOR}% branch floor; exercise the un-hit branches, then re-verify`)
  return reasons
}

// Apply the override: mutate the verify object to FAILED and append the reasons.
// Returns true when an override was applied (so the caller logs it). The log line
// stays at the call site because it needs feature.id/attempts from the loop closure.
function applyGroundedOverride(verify, reasons) {
  if (!reasons.length) return false
  verify.verdict = 'FAILED'
  verify.reasons = [...(verify.reasons || []), ...reasons]
  return true
}
// === KEYSTONE-RECOMPUTE-SLICE:END ===

// === INTAKE-CONTRACT-SLICE:START - test-only export seam; sliced by intake-contract-reject.test.js. Self-contained: references only these symbols + built-ins. ===
const SYMPTOM_RE = /no (longer )?(raise|throw|error|exception|crash)/i
const SYMPTOM_REJECT_REASON = 'symptom-shaped criterion - state the behavioral contract'

// A debug-tagged feature MUST carry at least one POSITIVE post-condition: a
// stated (non-empty) acceptanceCriteria entry that does NOT match SYMPTOM_RE.
// Returns true only when such a positive entry exists. Absent / empty /
// all-whitespace / non-array / all-symptom => false (no contract).
function hasPositivePostCondition(criteria) {
  const stated = (Array.isArray(criteria) ? criteria : [])
    .filter(c => typeof c === 'string' && c.trim() !== '')
  if (stated.length === 0) return false
  return stated.some(c => !SYMPTOM_RE.test(c))
}

// Returns the {id, reason} of every DEBUG feature lacking a behavioral
// contract (empty list => clean). Debug-gated, exactly like
// groundedVerifyReasons(verify, isDebug): a non-debug feature is NEVER
// rejected, so existing non-debug fixtures and the legacy schema are safe.
// Absence is itself a reject (no escape hatch): the ONLY structurally
// available path for a debug feature is to state a positive post-condition.
function debugContractRejects(features) {
  return (Array.isArray(features) ? features : [])
    .filter(f => f && f.tag === 'debug')
    .filter(f => !hasPositivePostCondition(f.acceptanceCriteria))
    .map(f => ({ id: f.id, reason: SYMPTOM_REJECT_REASON }))
}
// === INTAKE-CONTRACT-SLICE:END ===

// === DEBUGPATH-FRESHVERIFY-SLICE:START - test-only export seam; sliced by debugpath-freshverify.test.js. Self-contained: references only its params + built-ins. ===
//
// FIX-07: a debug-tagged feature on a freshVerifyDebug tier (T1) must run a G1
// plan draft + a G3 fresh-verify (ap-fresh-verifier, mission+plan only) that
// RE-DERIVES the root cause independently BEFORE the fix (G4). The predicate is
// the single decision the live runFeatureInner branches on, so the flag is
// consumed, never dead. Proportionality: true ONLY for tag==='debug' on a tier
// whose cfg carries freshVerifyDebug===true (T1). T0 (no flag) and non-debug
// features are always false.
function debugFreshVerifyRequired(feature, tierCfg) {
  return !!(tierCfg && tierCfg.freshVerifyDebug === true && feature && feature.tag === 'debug')
}
// === DEBUGPATH-FRESHVERIFY-SLICE:END ===

// === DEPTHLOCK-SLICE:START - test-only export seam; sliced by depth-lock.test.js. Self-contained: references only its params + built-ins. ===
//
// F-DEPTH (G3.5 DEPTH-LOCK): the single binary decision the gate verdict turns
// on. A debug fix is depth-locked ONLY when the frozen fix LAYER EQUALS the
// independently-derived deepest-cause function (D3) AND the adversarial D4 repro
// was proven RED against unpatched code. Strict `=== true` on reproRed (a truthy
// non-true never passes) and strict layer equality (the pylint-7080 wrong-layer
// slip - pylinter.py != expand_modules.py::_is_ignored_file - returns false).
// Fail-safe: any null/undefined arg yields false, never throws.
function depthLockPass(frozenLayer, d3DeepestCause, reproRed) {
  if (typeof frozenLayer !== 'string' || frozenLayer === '') return false
  if (typeof d3DeepestCause !== 'string' || d3DeepestCause === '') return false
  return frozenLayer === d3DeepestCause && reproRed === true
}
// === DEPTHLOCK-SLICE:END ===

// === PROVENANCE-SLICE:START - test-only export seam; sliced by integrity-provenance.test.js. Self-contained: references only these symbols + built-ins. ===

// FIX-06 #4 (S2/B3): assertDistinctImplementVerify is DEFENSIVE CODIFICATION of
// the implement!=verify invariant, in the assertExecLevel family. On the live
// PERSONA map implementer ('ap-implementer') and verifier ('ap-verifier') are
// already distinct, so this NEVER throws in the live path - a regression
// tripwire that fails loudly if a FUTURE refactor points both spawns at one
// persona. NOT the catch for F5-18; selfReviewSignatureFindings (ledger-check)
// is. Throws a deterministic TypeError (nonTransient -> loud escalate) for every
// tier because independent implementation review and runtime verification are floors.
const TIERS_REQUIRING_DISTINCT_VERIFY = new Set(['T0', 'T1', 'T2', 'T3'])
function assertDistinctImplementVerify(implementer, verifier, tier, site) {
  if (!TIERS_REQUIRING_DISTINCT_VERIFY.has(tier)) return true
  if (!implementer || !verifier) {
    throw new TypeError(`NO-SELF-REVIEW GUARD: ${site} missing an implement/verify persona (implementer=${implementer}, verifier=${verifier})`)
  }
  if (implementer === verifier) {
    throw new TypeError(`NO-SELF-REVIEW GUARD: ${site} would let one persona ("${implementer}") BOTH implement and verify at tier ${tier} (FIX-06). implement and verify must be distinct subagent_type.`)
  }
  return true
}

// FIX-05 #1: the canonical gate->expected-persona map. A recorded spawn whose
// persona disagrees is a substitution (self-review-via-relabel). Duplicated in
// ledger-check.js (gate.js is an ES module, cannot be require()d) - keep the two
// copies in lockstep (non-blocking note in the review).
const GATE_EXPECTED_PERSONA = {
  'G1': 'ap-planner', 'G2': 'ap-reviewer', 'G3': 'ap-fresh-verifier',
  'G3.5': 'ap-depth-prober',
  'G4': 'ap-implementer', 'G5': 'ap-reviewer', 'G6': 'ap-verifier',
  'G7': 'ap-juror', 'G8': 'ap-scribe',
}

// gateProvenanceReasons: the PURE reconcile the in-harness seal and (a sibling
// copy in) the standalone validator share. Each claimed gate is
// { gate, persona, artifactPresent }: persona is the spawned subagent_type
// actually recorded ('' == no spawn == fabrication); artifactPresent is whether
// evidence backs it. PERMISSIVE-ON-ABSENCE: only CLAIMED gates are passed in; a
// gate the tier never runs is never in the list and never flagged.
function gateProvenanceReasons(claimedGates) {
  const reasons = []
  for (const c of (Array.isArray(claimedGates) ? claimedGates : [])) {
    if (!c || typeof c.gate !== 'string') continue
    const expected = GATE_EXPECTED_PERSONA[c.gate]
    const persona = typeof c.persona === 'string' ? c.persona.trim() : ''
    if (persona === '') reasons.push(`${c.gate} claimed PASS with no spawned agent (fabricated attestation - F1-03)`)
    else if (expected && persona !== expected) reasons.push(`${c.gate} claimed PASS by "${persona}" but the gate routes to ${expected} (persona substitution)`)
    if (c.artifactPresent !== true) reasons.push(`${c.gate} claimed PASS with no on-disk artifact (no captured evidence behind the verdict)`)
  }
  return reasons
}

// assertGateArtifact: the in-harness throw. Any unbacked claimed gate -> a
// deterministic (loud, nonTransient) error before the feature may reach DONE.
function assertGateArtifact(feature, claimedGates) {
  const reasons = gateProvenanceReasons(claimedGates)
  if (reasons.length) {
    throw new TypeError(`PROVENANCE GUARD (${feature && feature.id}): ${reasons.join('; ')}`)
  }
  return true
}

// FIX-05 #1 (live teeth): the REAL per-feature spawn ledger. recordGateSpawn is
// called at each real gate spawn site (§3.1.C) with the SAME agentType value the
// spawn used, so the recorded persona IS the spawned persona. markResumed flags
// a feature that completed via ANY resume/crash shortcut (its gates ran in a
// prior session). Both default to the module-global log for the live path and
// accept an injected Map for hermetic unit tests (no state bleed).
function recordGateSpawn(feature, gate, persona, log) {
  if (!feature || !feature.id) return
  const entry = log.get(feature.id) || { gates: [], resumed: false }
  entry.gates.push({ gate, persona: typeof persona === 'string' ? persona : '' })
  log.set(feature.id, entry)
}
function markResumed(feature, log) {
  if (!feature || !feature.id) return
  const entry = log.get(feature.id) || { gates: [], resumed: false }
  entry.resumed = true
  log.set(feature.id, entry)
}

// expectedGatesForTier: the gates a tier ACTUALLY runs, derived from the EXACT
// flags the harness branches on (NEW-1 fix). planUntilApproved (gate.js ~957)
// keys the plan-review/fresh-verify SMASH loop on tierCfg.planLoop, NOT plan:
// at T2 (plan:true, planLoop:false) it takes the single-draft early branch that
// spawns ONLY the planner (G1). So G1 is gated on cfg.plan, but G2+G3 are gated
// on cfg.planLoop (T3 only) - mirroring the live spawn topology exactly. This is
// what makes the seal PERMISSIVE-ON-ABSENCE WITH TEETH: a tier never expects a
// gate it does not run, but a tier that DOES run a gate must have recorded it.
function expectedGatesForTier(tierCfg, isDebug, hasDetailedPlan) {
  const cfg = tierCfg || {}
  const gates = []
  if (cfg.plan && hasDetailedPlan) gates.push('G1')
  if (cfg.planLoop && hasDetailedPlan) gates.push('G2', 'G3')
  if (cfg.freshVerifyDebug && isDebug) {        // FIX-07: a debug feature on a freshVerifyDebug tier (T1) ran a G1 draft + G3 fresh-verify
    if (!gates.includes('G1')) gates.push('G1')
    if (!gates.includes('G3')) gates.push('G3')
  }
  // F-DEPTH (G3.5 DEPTH-LOCK): a debug feature runs DEPTH-LOCK after the plan freezes
  // and before G4 at EVERY tier (resolvePlan + the resume branches call lockDebugPlan
  // unconditionally for tag==='debug'). It is therefore a STRUCTURAL expectation for
  // any debug feature - the seal requires the gate to have recorded a G3.5 spawn, so a
  // debug feature cannot reach DONE with DEPTH-LOCK skipped. Non-debug features never
  // run it and never expect it (proportionality).
  if (isDebug) gates.push('G3.5')
  gates.push('G4')                              // implement always runs
  if (cfg.implReview) gates.push('G5')
  if (cfg.verify) gates.push('G6')
  if ((cfg.panelSize || 0) > 0) gates.push('G7')
  return gates
}

// MIN_ARTIFACT_SUBSTANCE_CHARS: the same 200-char substance floor the standalone
// validator (autoprompt-ledger-check.js artifactSubstantiationReasons) enforces on
// disk. Kept in lockstep with that constant by necessity (gate.js is an ES module,
// cannot require the CJS validator).
const MIN_ARTIFACT_SUBSTANCE_CHARS = 200

// hasArtifactSubstance: true only when `text` is a captured artifact body with at
// least MIN_ARTIFACT_SUBSTANCE_CHARS of real (whitespace-collapsed) content beyond
// the mandatory ARTIFACT scaffolding. PURE, total: a null / non-string / template-
// only body returns false. This is the substance predicate the seal AUGMENTS
// byGate.has with when a disk reader is injected - it never reads fs itself.
function hasArtifactSubstance(text) {
  if (typeof text !== 'string') return false
  const collapsed = text
    .replace(/^\s*ARTIFACT\b.*$/gim, '')       // drop the mandatory ARTIFACT header scaffold
    .replace(/\s+/g, ' ')
    .trim()
  return collapsed.length >= MIN_ARTIFACT_SUBSTANCE_CHARS
}

// claimedGatesFromLog: build the claimed set for a FRESH completion from the
// tier's expected gates reconciled against the recorded spawn ledger. A gate the
// tier runs but the ledger never recorded -> persona '' + artifactPresent false
// (two trip reasons). A recorded gate carries its REAL recorded persona (so a
// substitution trips via GATE_EXPECTED_PERSONA). First recorded spawn per gate
// wins (plan retries / multiple jurors append duplicates - harmless).
// P-01 #2 AUGMENT: `artifactSubstantial(gate) -> boolean` is an OPTIONAL injected
// disk-substance probe. When supplied (a fs-capable caller or a unit test), a gate
// counts as backed ONLY when it was recorded AND its on-disk artifact clears the
// 200-char substance floor - so a recorded spawn that wrote a hollow/template file
// no longer passes on the spawn record alone. When absent (the fs-less live seal),
// artifactPresent falls back to byGate.has and the on-disk+substance authority is
// the wired runLedgerCheck hard-stop at the SCRIBE->JANITOR boundary.
function claimedGatesFromLog(feature, tierCfg, log, artifactSubstantial) {
  const entry = log.get(feature && feature.id) || { gates: [] }
  const byGate = new Map()
  for (const g of entry.gates) if (!byGate.has(g.gate)) byGate.set(g.gate, g.persona)
  const hasDetailedPlan = byGate.has('G1') || !!feature && (
    feature.requiresDetailedPlan === true ||
    feature.tag === 'debug'
  )
  return expectedGatesForTier(tierCfg, feature && feature.tag === 'debug', hasDetailedPlan).map(gate => ({
    gate,
    persona: byGate.has(gate) ? byGate.get(gate) : '',
    artifactPresent: byGate.has(gate) && (artifactSubstantial ? artifactSubstantial(gate) === true : true),
  }))
}

// claimedGatesResumed: a resumed/crash completion reconciles ONLY the gates it
// re-spawned THIS session (NEW-2 fix). Prior-session frozen-artifact gates are
// absent from this session's log and are NOT required here - that cross-session
// on-disk check is the standalone validator's job. Every gate present in the
// session log is treated as backed (it really spawned + wrote its artifact this
// session); a wrong-persona re-spawn still trips via GATE_EXPECTED_PERSONA.
function claimedGatesResumed(entry) {
  const byGate = new Map()
  for (const g of entry.gates) if (!byGate.has(g.gate)) byGate.set(g.gate, g.persona)
  return [...byGate].map(([gate, persona]) => ({ gate, persona, artifactPresent: true }))
}

// sealDoneProvenance: the SINGLE funnel guard (B1). Applied to EVERY runFeature
// return. A non-DONE result passes straight through. A FRESH DONE is reconciled
// against the tier's expected gates (teeth). A RESUMED/crash DONE is checked only
// against the gates it re-ran THIS session (S4 - prior-session gates are the
// standalone validator's cross-session job). Throws on an unbacked claim.
function sealDoneProvenance(feature, result, tierCfg, log, artifactSubstantial) {
  if (!result || result.status !== 'DONE') return result
  const entry = log.get(feature && feature.id) || { gates: [], resumed: false }
  const claimed = entry.resumed
    ? claimedGatesResumed(entry)
    : claimedGatesFromLog(feature, tierCfg, log, artifactSubstantial)
  assertGateArtifact(feature, claimed)
  return result
}
// === PROVENANCE-SLICE:END ===

// === HIERARCHY-DISPATCH-SLICE:START - test-only export seam; sliced by hierarchy-dispatch.test.js. Self-contained: references only these symbols + built-ins. ===
//
// FX-HIERARCHY (FIX-11/12/13/14) gate-side dispatch guards, in the assertExecLevel
// family. These are PURE, deterministic functions - a breach throws a NON-transient
// TypeError (a loud-escalate programmer error), the legal path passes untouched.
// FIX-12's assertTypedPersona is WIRED LIVE into the rebound agent() dispatch choke
// point below (so every harness spawn is validated); FIX-14's assertGateRouting is
// wired defensively at the goal-check + janitor sites. The slice duplicates a
// minimal level/registry map (lockstep with LEVEL_OF), the same necessity as
// GATE_EXPECTED_PERSONA - the PERSONA-membership test is the lockstep tripwire.

// The lockstep level mirror - every autoprompt persona keyed to its level. Kept
// in sync with LEVEL_OF above (gate.js evaluates top-to-bottom; this self-contained
// copy lets the slice classify a spawner's level without reaching outside itself).
const HIERARCHY_LEVEL_OF = {
  'cl-conductor': 'L0',
  'ap-scope-coordinator': 'L1', 'ap-feature-coordinator': 'L1', 'ap-sweep-coordinator': 'L1',
  'ap-manager': 'L2',
  'ap-scoper': 'L3', 'ap-planner': 'L3', 'ap-synthesizer': 'L3', 'ap-intake': 'L3',
  'ap-implementer': 'L3', 'ap-reviewer': 'L3', 'ap-verifier': 'L3', 'ap-sweeper': 'L3',
  'ap-researcher': 'L3', 'ap-execharness-resolver': 'L3', 'ap-framework-generator': 'L3',
  'ap-fresh-verifier': 'L4', 'ap-depth-prober': 'L4', 'ap-framework-validator': 'L4',
  'ap-juror': 'L4', 'ap-goal-checker': 'L4',
  'ap-preflight-probe': 'L4', 'ap-arbiter': 'L4', 'ap-re-anchor': 'L4',
  'ap-scribe': 'L4', 'ap-janitor': 'L4',
}

// FIX-12: the registry of every spawnable ap-* persona (= every key of the level
// mirror, so it contains every live PERSONA.* value - the registry tripwire test
// asserts this). A spawn whose agentType is not in here (general-purpose, an
// undefined type, a typo'd cl-bogus) is structurally un-spawnable.
const CL_PERSONA_REGISTRY = new Set(Object.keys(HIERARCHY_LEVEL_OF))

// assertTypedPersona (FIX-12 live teeth): the rebound agent() choke point calls
// this before every spawn. A non-ap-* / undefined / unregistered agentType throws
// a deterministic TypeError (general-purpose un-spawnable). The thrown message
// names the offending type.
function assertTypedPersona(childType, site) {
  if (typeof childType !== 'string' || !CL_PERSONA_REGISTRY.has(childType)) {
    throw new TypeError(`TYPED-PERSONA GUARD: spawn at "${site}" names persona "${childType}", which is not a registered ap-* autoprompt persona - general-purpose is un-spawnable in a autoprompt run; name a typed ap-* persona.`)
  }
  return true
}

// FIX-13: the legal child set per spawner level, locked to the ledger's stricter
// roster (L1_LEGAL_CHILDREN / thinSprawlFindings in autoprompt-ledger-check.js).
// L0 may stand up an L1 coordinator (or the two pre-hierarchy personas
// preflight/intake, which L0 ALONE owns - neither is ever a legal L1/L2 child);
// an L1 coordinator may spawn an L2 ap-manager (for a MULTI-FEATURE slice) OR -
// for a single bounded feature - dispatch L3 executors and single-shot L4 leaves
// DIRECTLY (L1→L3 is a legal hop; the manager is OPTIONAL, merged into the L1's
// own fleet-state reasoning); an L2 dispatches L3 executors + L4 leaves; an L3 is
// normally terminal - ONLY ap-implementer/ap-intake may fan out, and only to L4
// leaves (thin-sprawl); an L4 is terminal. ap-preflight-probe is never re-stood
// below L0. (JS const name L1_SUPERVISORS unchanged; the persona STRINGS are the
// -coordinators.)
const L1_SUPERVISORS = ['ap-scope-coordinator', 'ap-feature-coordinator', 'ap-sweep-coordinator']
const L3_EXECUTORS = [
  'ap-scoper', 'ap-planner', 'ap-synthesizer', 'ap-implementer', 'ap-reviewer',
  'ap-verifier', 'ap-sweeper', 'ap-researcher', 'ap-execharness-resolver',
  'ap-framework-generator',
]
const L4_LEAVES = [
  'ap-fresh-verifier', 'ap-depth-prober', 'ap-framework-validator', 'ap-juror',
  'ap-goal-checker', 'ap-preflight-probe', 'ap-arbiter', 'ap-re-anchor', 'ap-scribe',
  'ap-janitor',
]
const L4_SPAWNABLE = L4_LEAVES.filter(leaf => leaf !== 'ap-preflight-probe')
const L3_FANOUT_PERSONAS = new Set(['ap-implementer', 'ap-intake'])
const LEGAL_CHILDREN_BY_LEVEL = {
  L0: new Set([...L1_SUPERVISORS, 'ap-preflight-probe', 'ap-intake']),
  // L1 coordinator: ap-manager for a multi-feature slice, OR L3 executors + L4 leaves
  // dispatched DIRECTLY for a single bounded feature (L1→L3 legal hop; manager optional).
  L1: new Set(['ap-manager', ...L3_EXECUTORS, ...L4_SPAWNABLE]),
  L2: new Set([...L3_EXECUTORS, ...L4_SPAWNABLE]),
  L3: new Set(L4_SPAWNABLE),
  L4: new Set(),
}

// assertLegalChild (FIX-13 defensive): throws when a spawner's child is illegal for
// its level. An unknown spawner -> throw (fail-closed). An L3 spawner outside
// L3_FANOUT_PERSONAS -> throw (thin-sprawl: only ap-implementer/ap-intake fan out).
// The legal path returns true.
function assertLegalChild(spawnerType, childType, site) {
  const level = HIERARCHY_LEVEL_OF[spawnerType]
  const legal = level && LEGAL_CHILDREN_BY_LEVEL[level]
  if (!legal) {
    throw new TypeError(`LEGAL-CHILD GUARD: spawner "${spawnerType}" at "${site}" has no known level / legal-child set; cannot validate its children (fail-closed).`)
  }
  if (level === 'L3' && !L3_FANOUT_PERSONAS.has(spawnerType)) {
    throw new TypeError(`LEGAL-CHILD GUARD: L3 persona "${spawnerType}" at "${site}" may not spawn "${childType}" - only ap-implementer/ap-intake fan out; every other L3 does its one job in its own context.`)
  }
  if (!legal.has(childType)) {
    throw new TypeError(`LEGAL-CHILD GUARD: ${level} persona "${spawnerType}" at "${site}" may not spawn "${childType}" - legal children: ${[...legal].join(', ') || '(none - terminal leaf)'}.`)
  }
  return true
}

// conductorToolViolation (FIX-11 belt-and-suspenders): given the tool names the L0
// conductor emitted, return the offending NON-spawn tools (Agent/Task are the only
// legal conductor tools). Empty array = clean. Non-array / null input -> [] (no
// crash). The live ledger linter (conductorToolUseFindings in ledger-check.js) is
// the primary teeth; this is the second layer wherever the conductor's tool list
// is observable.
function conductorToolViolation(toolNames) {
  if (!Array.isArray(toolNames)) return []
  return toolNames.filter(name => typeof name === 'string' && name !== 'Agent' && name !== 'Task')
}

// FIX-14: the gates whose author/writer persona is fixed. GOAL-CHECK's verdict is
// authored by ap-goal-checker; the DONE-sentinel is written by ap-janitor. Each is
// a dispatched typed L4 leaf (the F5-07/F5-15 defect: the L2 manager itself did
// GOAL-CHECK + JANITOR and wrote the sentinel).
const GATE_ROUTING = { GOALCHECK: 'ap-goal-checker', LEDGERCHECK: 'ap-goal-checker', JANITOR: 'ap-janitor' }

// assertGateRouting (FIX-14 defensive teeth): throws when a routed gate is wired to
// the wrong persona; permissive (returns true) for a gate this map does not own.
function assertGateRouting(gate, persona, site) {
  const expected = GATE_ROUTING[gate]
  if (!expected) return true
  if (persona !== expected) {
    throw new TypeError(`GATE-ROUTING GUARD: ${gate} at "${site}" must be authored by the typed L4 leaf ${expected}, not "${persona}".`)
  }
  return true
}
// === HIERARCHY-DISPATCH-SLICE:END ===

// === SESSION-SLUG-SLICE:START - test-only export seam; sliced by session-slug.test.js. Self-contained: references only its param + built-ins, NO fs. ===
// deriveSlug (SPEC-1): a PURE, deterministic kebab-case slug builder over the
// mission STRING gate.js already holds. NO fs, NO env, NO clock - the same
// mission always yields the same slug, so the SCRIBE's ledger folder is stable
// across supervisor relaunches. The SCRIBE picks the session/prompt NUMBER via
// the ledger-check --resolve-prompt-dir CLI; this only produces the <slug> tail.
const SLUG_FALLBACK = 'run'      // deterministic fallback when the mission yields no usable words
const MAX_SLUG_WORDS = 5         // keep the leading handful of words; a 6-word mission drops its trailing word
const MAX_SLUG_LENGTH = 48       // hard cap so a pathological single token cannot blow the folder name
function deriveSlug(mission) {
  if (typeof mission !== 'string') return SLUG_FALLBACK
  const words = mission
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SLUG_WORDS)
  if (words.length === 0) return SLUG_FALLBACK
  const joined = words.join('-')
  if (joined.length <= MAX_SLUG_LENGTH) return joined
  return joined.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '')
}
// === SESSION-SLUG-SLICE:END ===

// The module-global per-feature spawn ledger the LIVE path uses. recordGateSpawn
// writes here at each real spawn site; sealDoneProvenance reads it at the single
// runFeature DONE funnel. Hermetic unit tests inject their own Map instead.
const featureSpawnLog = new Map()

const PANEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasons'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    reasons: { type: 'array', items: { type: 'string' } },
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}

const SWEEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'where', 'impact'],
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          title: { type: 'string' },
          where: { type: 'string', description: 'file:line' },
          impact: { type: 'string' },
        },
      },
    },
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}

const ARBITER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'proceed', 'userRequired'],
  properties: {
    decision: { type: 'string' },
    proceed: { type: 'boolean' },
    risk: { type: 'string' },
    userRequired: { type: 'boolean', description: 'true ONLY if irreversible/destructive, real money, a credential only the user holds, or a product-direction call the user must own' },
    userQuestion: { type: 'string', description: 'if userRequired, the precise question to ask the user; else empty' },
  },
}

// ----- mission source ---------------------------------------------------
// The first useful roadmap author receives the exact mission and stores it in
// PROMPTS.txt. Every later dispatch receives a cryptographically bound pointer.
const MISSION = typeof args === 'object' && args && Object.hasOwn(args, 'mission')
  ? String(args.mission || '')
  : String(args || '')

// Later steers are appended as exact numbered blocks in PROMPTS.txt. They refine
// the mission without rewriting its original bytes.
function resolvePriorSteers() {
  const fromArg = (typeof args === 'object' && args && args.priorSteers != null) ? args.priorSteers : undefined
  const fromEnv = (typeof process === 'object' && process && process.env) ? process.env.AUTOPROMPT_PRIOR_STEERS : undefined
  const raw = fromArg != null ? fromArg : fromEnv
  if (raw == null) return ''
  const text = Array.isArray(raw) ? raw.map(String).join('\n') : String(raw)
  return text.trim()
}
const PRIOR_STEERS = resolvePriorSteers()

const LEDGER_DIR = (typeof args === 'object' && args && args.ledgerDir) ? String(args.ledgerDir) : 'autoprompt'

if (!MISSION.trim()) {
  log('No mission provided. Pass args.mission (the user prompt, verbatim).')
  return { error: 'missing mission' }
}

const MODE_RAW = (typeof args === 'object' && args && args.mode) ? String(args.mode).toLowerCase().trim() : DEFAULT_MODE
const MODE = EXECUTION_MODES[MODE_RAW] ? MODE_RAW : DEFAULT_MODE
if (MODE !== MODE_RAW) log(`Unknown mode "${MODE_RAW}", falling back to ${DEFAULT_MODE.toUpperCase()}.`)
const MODE_CFG = EXECUTION_MODES[MODE]
const TOPOLOGY = resolveTopology(MODE)
log(`Execution mode: ${MODE.toUpperCase()} (${TOPOLOGY.liveCap == null ? 'unbounded fan-out, bounded by MAX_CONCURRENT' : `bounded fan-out, up to ${TOPOLOGY.liveCap} live per wave`})`)
log(`Topology: 5-level L0->L4; per-L3 fan-out ${TOPOLOGY.leafCap === null ? 'NO numeric ceiling (bounded by MAX_CONCURRENT + disjointness + real need)' : `<=${TOPOLOGY.leafCap} live per wave`}; L3 tracks ${TOPOLOGY.parallelTracks ? 'PARALLEL' : 'SEQUENTIAL'}; multi-task split at ${TOPOLOGY.multiTaskSplitSite}; L1 never executes (rule 68).`)
log(`Global max-concurrent ceiling: ${MAX_CONCURRENT} live agent(s) per parallel wave${MAX_CONCURRENT === MAX_CONCURRENT_BASE ? ' (base default)' : ' (user-set)'}.`)

// ----- agents selector (agent-model selection) --------------------------
// === MODEL-CASTING-DISPATCH-SLICE:START - test-only export seam; sliced by model-casting-dispatch.test.cjs. Self-contained: references only these symbols + built-ins. ===
const CASTING_ALIAS_BY_TIER = Object.freeze({ R1: 'opus', R2: 'sonnet', R3: 'sonnet', R4: 'haiku', R5: 'haiku' })
const CASTING_EFFORT_BY_TIER = Object.freeze({ R1: 'xhigh', R2: 'xhigh', R3: 'high', R4: 'medium', R5: 'low' })
const CASTING_MAXIMUM_EFFORT_PERSONAS = new Set([
  'ap-scope-coordinator', 'ap-manager', 'ap-reviewer', 'ap-fresh-verifier',
  'ap-verifier', 'ap-juror', 'ap-goal-checker', 'ap-depth-prober', 'ap-arbiter',
  'ap-framework-validator', 'ap-re-anchor', 'ap-planner', 'ap-researcher',
  'ap-scoper', 'ap-synthesizer',
])
const CASTING_EFFORT_STATUSES = new Set(['selectable', 'inherited-only', 'unsupported', 'unknown'])
const INHERITED_CASTING_EFFORT = Object.freeze({
  status: 'inherited-only', acceptedValues: [], maximum: null, source: 'session-inheritance',
})
const CASTING_PERSONAS_BY_TIER = Object.freeze({
  R1: ['ap-scope-coordinator', 'ap-feature-coordinator', 'ap-sweep-coordinator', 'ap-manager'],
  R2: ['ap-reviewer', 'ap-fresh-verifier', 'ap-verifier', 'ap-juror', 'ap-goal-checker', 'ap-depth-prober', 'ap-arbiter', 'ap-framework-validator', 'ap-re-anchor'],
  R3: ['ap-implementer', 'ap-planner', 'ap-researcher', 'ap-scoper', 'ap-synthesizer', 'ap-execharness-resolver', 'ap-framework-generator'],
  R4: ['ap-preflight-probe', 'ap-intake', 'ap-scribe'],
  R5: ['ap-sweeper', 'ap-janitor'],
})

function parseSelectorModels(value) {
  const models = value.split(',').map(model => model.trim())
  if (models.some(model => model === '')) throw new TypeError('agents selector contains an empty model identifier')
  const seen = new Set()
  for (const model of models) {
    if (seen.has(model)) throw new TypeError(`agents selector contains duplicate model identifier: ${model}`)
    seen.add(model)
  }
  return models
}

function parseAgentsSelectorValue(value) {
  const selector = value == null ? 'off' : String(value).trim()
  const control = selector.toLowerCase()
  if (selector === '' || control === 'off') return { mode: 'off', models: [] }
  if (control === 'auto') return { mode: 'auto', models: [] }
  if (control.startsWith('auto:')) {
    const pool = selector.slice(selector.indexOf(':') + 1)
    return pool.trim() === '' ? { mode: 'auto', models: [] } : { mode: 'auto-list', models: parseSelectorModels(pool) }
  }
  return { mode: 'list', models: parseSelectorModels(selector) }
}

function sameSelector(left, right) {
  return left.mode === right.mode && left.models.length === right.models.length &&
    left.models.every((model, index) => model === right.models[index])
}

function resolveAgentsSelector(workflowArgs, environment) {
  const hasArgument = typeof workflowArgs === 'object' && workflowArgs && workflowArgs.agents != null
  const hasEnvironment = environment && environment.AUTOPROMPT_AGENTS != null
  const fromArgument = hasArgument ? parseAgentsSelectorValue(workflowArgs.agents) : null
  const fromEnvironment = hasEnvironment ? parseAgentsSelectorValue(environment.AUTOPROMPT_AGENTS) : null
  if (fromArgument && fromEnvironment && !sameSelector(fromArgument, fromEnvironment)) {
    throw new TypeError('agents selector does not match AUTOPROMPT_AGENTS from the pre-launch model cast')
  }
  return fromArgument || fromEnvironment || parseAgentsSelectorValue('off')
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new TypeError(`AUTOPROMPT_AGENT_CASTING ${name} must be a non-empty string array`)
  }
  if (new Set(value).size !== value.length) throw new TypeError(`AUTOPROMPT_AGENT_CASTING ${name} must contain unique values`)
  return value
}

function expectedAliasModels(models) {
  if (models.length < 1 || models.length > 3) throw new TypeError('AUTOPROMPT_AGENT_CASTING must select one to three provider models')
  if (models.length === 1) return { opus: models[0], sonnet: models[0], haiku: models[0] }
  if (models.length === 2) return { opus: models[0], sonnet: models[0], haiku: models[1] }
  return { opus: models[0], sonnet: models[1], haiku: models[2] }
}

function sameStringMap(actual, expected) {
  return actual && typeof actual === 'object' && Object.keys(expected).every(key => actual[key] === expected[key])
}

function validateCastingSelection(selector, casting) {
  if (casting.mode !== selector.mode) throw new TypeError('AUTOPROMPT_AGENT_CASTING mode does not match the agents selector')
  const names = requireStringArray(casting.names, 'names')
  const selected = selector.models
  const matches = selector.mode === 'auto-list'
    ? names.length === selected.length && selected.every(name => names.includes(name))
    : selector.mode === 'auto' || (names.length === selected.length && names.every((name, index) => name === selected[index]))
  if (!matches) throw new TypeError('AUTOPROMPT_AGENT_CASTING selected names do not match the agents selector')
}

function validateCastingAliases(casting, environment) {
  const models = requireStringArray(casting.models, 'models')
  if (models.length !== casting.names.length) {
    throw new TypeError('AUTOPROMPT_AGENT_CASTING names and models must have equal length')
  }
  const expected = expectedAliasModels(models)
  if (!sameStringMap(casting.aliases, expected)) {
    throw new TypeError('AUTOPROMPT_AGENT_CASTING aliases do not match the selected provider models')
  }
  const liveAliases = {
    opus: environment.ANTHROPIC_DEFAULT_OPUS_MODEL,
    sonnet: environment.ANTHROPIC_DEFAULT_SONNET_MODEL,
    haiku: environment.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  }
  for (const alias of Object.keys(expected)) {
    if (liveAliases[alias] !== expected[alias]) {
      throw new TypeError(`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL does not match AUTOPROMPT_AGENT_CASTING`)
    }
  }
}

function validateEffortCapability(effort) {
  if (!effort || typeof effort !== 'object' || !CASTING_EFFORT_STATUSES.has(effort.status)) {
    throw new TypeError('AUTOPROMPT_AGENT_CASTING effort status must be selectable, inherited-only, unsupported, or unknown')
  }
  if (!Array.isArray(effort.acceptedValues) || effort.acceptedValues.some(value => typeof value !== 'string')) {
    throw new TypeError('AUTOPROMPT_AGENT_CASTING effort acceptedValues must be a string array')
  }
  if (effort.status === 'selectable') {
    if (typeof effort.maximum !== 'string' || !effort.acceptedValues.includes(effort.maximum)) {
      throw new TypeError('AUTOPROMPT_AGENT_CASTING selectable effort maximum must be one of acceptedValues')
    }
  } else if (effort.maximum !== null) {
    throw new TypeError('AUTOPROMPT_AGENT_CASTING non-selectable effort maximum must be null')
  }
  return effort
}

function resolveWorkflowCasting(selector, environment) {
  if (selector.mode === 'off') return { enabled: false, effort: { ...INHERITED_CASTING_EFFORT, acceptedValues: [] } }
  const raw = environment && environment.AUTOPROMPT_AGENT_CASTING
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TypeError('custom agent selection requires pre-launch AUTOPROMPT_AGENT_CASTING metadata and Claude alias configuration')
  }
  let casting
  try { casting = JSON.parse(raw) } catch (error) {
    throw new TypeError(`AUTOPROMPT_AGENT_CASTING is not valid JSON: ${error.message}`)
  }
  if (!casting || typeof casting !== 'object' || casting.enabled !== true) {
    throw new TypeError('AUTOPROMPT_AGENT_CASTING must be an enabled casting object')
  }
  validateCastingSelection(selector, casting)
  validateCastingAliases(casting, environment)
  validateEffortCapability(casting.effort)
  if (!sameStringMap(casting.tierAliases, CASTING_ALIAS_BY_TIER)) {
    throw new TypeError('AUTOPROMPT_AGENT_CASTING tierAliases do not match the fixed persona routing')
  }
  if (environment && typeof environment.CLAUDE_CODE_SUBAGENT_MODEL === 'string' && environment.CLAUDE_CODE_SUBAGENT_MODEL.trim() !== '') {
    throw new TypeError('CLAUDE_CODE_SUBAGENT_MODEL must be unset when custom agent model casting is enabled')
  }
  return casting
}

function applyPersonaCasting(options, casting) {
  if (!casting || casting.enabled !== true) return options
  const persona = options && options.agentType
  const tier = Object.keys(CASTING_PERSONAS_BY_TIER).find(candidate => CASTING_PERSONAS_BY_TIER[candidate].includes(persona))
  if (!tier) throw new TypeError(`Persona ${persona} has no model-casting tier`)
  const cast = { ...options, model: CASTING_ALIAS_BY_TIER[tier] }
  if (casting.effort.status === 'selectable') {
    const requestedEffort = CASTING_MAXIMUM_EFFORT_PERSONAS.has(persona)
      ? casting.effort.maximum
      : CASTING_EFFORT_BY_TIER[tier]
    cast.effort = resolveAcceptedCastingEffort(
      requestedEffort,
      casting.effort,
    )
  } else {
    delete cast.effort
  }
  return cast
}

function resolveAcceptedCastingEffort(requestedEffort, capability) {
  if (capability.acceptedValues.includes(requestedEffort)) return requestedEffort
  return capability.acceptedValues.reduce((closest, candidate) => {
    const closestDistance = Math.abs(castingEffortRank(closest) - castingEffortRank(requestedEffort))
    const candidateDistance = Math.abs(castingEffortRank(candidate) - castingEffortRank(requestedEffort))
    return candidateDistance < closestDistance ? candidate : closest
  }, capability.maximum)
}

function castingEffortRank(effort) {
  return ['low', 'medium', 'high', 'xhigh'].indexOf(effort)
}
// === MODEL-CASTING-DISPATCH-SLICE:END ===

const WORKFLOW_ENV = (typeof process === 'object' && process && process.env) ? process.env : {}
const AGENTS = resolveAgentsSelector(args, WORKFLOW_ENV)
const MODEL_CASTING = resolveWorkflowCasting(AGENTS, WORKFLOW_ENV)
log(`Agent selection: ${AGENTS.mode}${AGENTS.models.length ? ` [${AGENTS.models.join(', ')}]` : ''}.`)

// ----- UNATTENDED mode (LAW 3 / binding arbiter F5) ---------------------
// ATTENDED is the default for a bare interactive run. UNATTENDED is set by the
// supervisor or an explicit flag, and resolves to a single boolean here. Under
// UNATTENDED the arbiter's user-required escape is DISABLED at the one push site
// (it rules and continues, logging an ASSUMED answer); AskUserQuestion is never
// reached. The supervisor exports AUTOPROMPT_UNATTENDED=1; the env→arg bridge
// below maps that export onto the boolean so a supervisor-launched run is
// genuinely UNATTENDED. Either path (args.unattended:true OR the env var set to
// a truthy "1"/"true") resolves UNATTENDED; the invocation-directive token-strip
// remains the parent's job (prose). A truthy env value is "1" or "true" (case-
// insensitive); "0"/"false"/unset is ATTENDED.
function envFlagTrue(name) {
  const v = (typeof process === 'object' && process && process.env) ? process.env[name] : undefined
  if (v == null) return false
  const s = String(v).trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}
const UNATTENDED = (typeof args === 'object' && args && args.unattended === true) || envFlagTrue('AUTOPROMPT_UNATTENDED')
log(`Attendance: ${UNATTENDED ? 'UNATTENDED (arbiter rules and continues; no user escalation)' : 'ATTENDED (a user-required credential question may surface)'}`)

// IS_RESUME (Pillar 2): set by the supervisor (AUTOPROMPT_RESUME=1 -> threaded
// as args.resume, OR read straight from the env export here). On a resume the
// frontier probe is mandatory and honored (it already is); this makes the
// relaunch explicit and logged for the supervisor.
const IS_RESUME = (typeof args === 'object' && args && args.resume === true) || envFlagTrue('AUTOPROMPT_RESUME')
if (IS_RESUME) log('RESUME: supervisor relaunch - frontier probe is mandatory; finished -vN artifacts are never clobbered.')

// SLUG (SPEC-1, EDIT 2): the deterministic ledger-folder slug, stable across
// relaunches. NO fs here - the SCRIBE resolves the session/prompt NUMBER via the
// ledger-check --resolve-prompt-dir CLI; this only supplies the <slug> tail.
const SLUG = deriveSlug(MISSION)
// LEDGER_CHECK_PATH (SPEC-1, EDIT 4a): the absolute resolver path the SCRIBE/JANITOR
// RUN. A STRING read of the env var the supervisor exports (same process.env idiom
// as envFlagTrue/envFlagFalse) - NO require, NO fs, so gate.js stays fs-free. The
// documented relative fallback is for a direct (non-supervised) run whose CWD is the
// project root. A wrong path => the resolver command fails => the SCRIBE fails LOUD.
const LEDGER_CHECK_PATH = ((typeof process === 'object' && process && process.env && process.env.AUTOPROMPT_LEDGER_CHECK) || 'autoprompt-skill/agents/claude/workflow/autoprompt-ledger-check.js')

// TRANSCRIPT_DIR (P-02 handshake teeth): this session's conductor transcript
// directory, exported by the supervisor (AUTOPROMPT_TRANSCRIPT_DIR) or the harness
// (CLAUDE_TRANSCRIPT_DIR). When present, the LEDGER-CHECK leaf is handed
// --transcript-dir so the SKIPPED pre-spawn handshake lint can fire against the real
// on-disk transcripts. NEVER hard-required - a headless run may have none; there the
// lint is DISARMED (logged loud) while reconcile + substance checks still run, and
// the load-time frontmatter prose stays the primary handshake gate.
const TRANSCRIPT_DIR = ((typeof process === 'object' && process && process.env &&
  (process.env.AUTOPROMPT_TRANSCRIPT_DIR || process.env.CLAUDE_TRANSCRIPT_DIR)) || '').trim()

// EXPAND_MISSION controls default ambition, not whether useful scope runs.
// Open-ended work starts provisionally multi-surface. A caller that knows the
// task is bounded sets AUTOPROMPT_EXPAND_MISSION=0 (or
// args.expandMission:false): the roadmap author still inspects and classifies
// the repository, but does not expand beyond the ask and omitted tiers default
// to T1. The roadmap's authoritative scopeProfile sets the final topology.
function envFlagFalse(name) {
  const v = (typeof process === 'object' && process && process.env) ? process.env[name] : undefined
  if (v == null) return false
  const s = String(v).trim().toLowerCase()
  return s === '0' || s === 'false' || s === 'no'
}
const EXPAND_MISSION = !((typeof args === 'object' && args && args.expandMission === false) || envFlagFalse('AUTOPROMPT_EXPAND_MISSION'))
if (!EXPAND_MISSION) log('EXPAND_MISSION off: bounded default - useful roadmap scope still runs, no auto-expansion, omitted-tier fallback is T1 (fix only what is asked).')

// ----- wait-and-retry primitive (LAW 3, binding F1/FIX 2/FIX 3) ---------
// sleep: injectable so tests run instantly; defaults to a real timer.
const sleepFn = (typeof sleep === 'function')
  ? sleep
  : (ms => new Promise(resolve => setTimeout(resolve, ms)))

// A distinct error for a classified NON-transient throw (a deterministic bug /
// malformed request). It is never retried; it surfaces loudly so the process
// exits non-zero and the external supervisor RESUMEs at the frontier.
class NonTransientError extends Error {
  constructor(label, cause) {
    super(`NON-TRANSIENT failure at ${label}: ${cause && cause.message ? cause.message : String(cause)}`)
    this.name = 'NonTransientError'
    this.label = label
    this.cause = cause
  }
}

function describeThrow(err) {
  if (!err) return 'unknown error'
  const code = err.code ? ` code=${err.code}` : ''
  const status = (err.status || err.statusCode) ? ` status=${err.status || err.statusCode}` : ''
  return `${err.name || 'Error'}: ${err.message || String(err)}${code}${status}`
}

// classifyThrow: a THROWN infra error is transient (retry forever) unless it is
// clearly deterministic (a programming bug or a malformed/unauthorized request
// retrying cannot fix), which is 'nonTransient' (loud escalate). It inspects
// err.status/err.code AND the message string so it is robust to either shape.
// Unknown throws DEFAULT to transient (never-fatal wins) but are logged loudly.
function classifyThrow(err) {
  if (!err) return 'unknown'
  const status = Number(err.status || err.statusCode || (err.response && err.response.status)) || 0
  const code = String(err.code || err.type || '')
  const msg = String((err && err.message) || err || '')
  // NON-transient FIRST so a deterministic bug never spins forever.
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) return 'nonTransient'
  if ([400, 401, 403, 404, 422].includes(status)) return 'nonTransient'
  // transient classes
  const NETWORK = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|ESOCKETTIMEDOUT|socket hang ?up/i
  if (NETWORK.test(code) || NETWORK.test(msg)) return 'transient'
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return 'httpTransient'
  if (/rate[_ -]?limit|rate-?limited|usage limit|quota|overloaded|capacity|retry-?after|too many requests/i.test(code + ' ' + msg)) return 'rateUsage'
  if (/timed out|timeout|AbortError/i.test(code + ' ' + msg) || err.name === 'AbortError') return 'timeout'
  // default: never fatal, but loud.
  return 'unknown'
}

// withRetry: the single choke point. Returned negative verdicts pass through;
// only thrown infrastructure failures retry. Exhaustion is loud and resumable.
async function withRetry(thunk, label) {
  const startedAt = Date.now()
  for (
    let attempt = 1;
    attempt <= RETRY_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      return await thunk()
    } catch (err) {
      const kind = classifyThrow(err)
      if (kind === 'nonTransient') {
        log(
          `NON-TRANSIENT throw at ${label} ` +
          `(attempt ${attempt}): ${describeThrow(err)} - ` +
          `escalating to supervisor, NOT retrying`,
        )
        throw new NonTransientError(label, err)
      }

      const elapsedMs = Math.max(0, Date.now() - startedAt)
      const retry = retryBudgetVerdict({
        attempt,
        elapsedMs,
        maxAttempts: RETRY_MAX_ATTEMPTS,
        maxElapsedMs: RETRY_MAX_ELAPSED_MS,
      })
      if (!retry.canRetry) {
        log(
          `TRANSIENT budget exhausted at ${label}: ` +
          `${retry.reason}; last error ${describeThrow(err)}`,
        )
        throw new NonTransientError(
          label,
          new Error(retry.reason),
        )
      }

      const base = Math.min(
        RETRY_CAP_MS,
        RETRY_BASE_MS * RETRY_FACTOR ** (attempt - 1),
      )
      const jittered = Math.round(
        base *
        (
          1 +
          (
            ((attempt * 7919) % 100) / 100 -
            0.5
          ) * 2 * RETRY_JITTER
        ),
      )
      log(
        `TRANSIENT at ${label} (attempt ${attempt}, ${kind}): ` +
        `${describeThrow(err)} - waiting ${jittered}ms then ` +
        `re-dispatching the SAME call`,
      )
      await sleepFn(jittered)
    }
  }
  throw new NonTransientError(
    label,
    new Error('transient retry budget exhausted'),
  )
}

// Rebind agent so every useful, assurance, build, resume, and record dispatch
// inherits the same transient handling, casting policy, and run binding.
// === AUTOPROMPT-RUN-BINDING-SLICE:START - pure run-envelope helpers. ===
function formatRunMarker(nonce, promptHash) {
  return `AUTOPROMPT-RUN-MARKER: runtime=autoprompt-gate-v1 nonce=${nonce} prompt=${promptHash}`
}

function assertRunBinding(prompt, label, expectedMarker) {
  const lines = typeof prompt === 'string' ? prompt.split(/\r?\n/) : []
  if (!lines.includes(expectedMarker)) {
    throw new TypeError(`AUTOPROMPT-RUN GUARD: spawn at "${label}" lacks the active run marker; ap-* personas are internal to Autoprompt and cannot be dispatched from an ordinary request.`)
  }
  return true
}

function activationNonce(environment) {
  const supplied = environment && environment.AUTOPROMPT_RUN_NONCE
  if (supplied !== undefined && supplied !== null && supplied !== '') {
    if (typeof supplied !== 'string' || !/^NONCE-[A-Za-z0-9_-]+$/.test(supplied)) {
      throw new TypeError(`AUTOPROMPT activation nonce is malformed: ${JSON.stringify(supplied)}`)
    }
    return supplied
  }
  const getBuiltin =
    typeof process === 'object' && process &&
    typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule.bind(process)
      : null
  const crypto = getBuiltin &&
    (getBuiltin('node:crypto') || getBuiltin('crypto'))
  if (crypto && typeof crypto.randomBytes === 'function') {
    return `NONCE-${crypto.randomBytes(16).toString('hex')}`
  }
  throw new TypeError('AUTOPROMPT activation identity is unavailable: no cryptographically strong random source')
}
// === AUTOPROMPT-RUN-BINDING-SLICE:END ===

function autopromptRunMarker() {
  const pointer = missionPointerBinding()
  return formatRunMarker(RUN_NONCE, pointer.hash)
}

const rawAgent = agent
agent = (prompt, opts) => {
  const label = (opts && opts.label) || 'agent'
  assertTypedPersona(opts && opts.agentType, label)
  assertRunBinding(prompt, label, autopromptRunMarker())
  const dispatchOptions = applyPersonaCasting(opts, MODEL_CASTING)
  return withRetry(() => rawAgent(prompt, dispatchOptions), label)
}

// The supervisor mints this cryptographically strong activation identity and
// re-exports it unchanged across child relaunches. Direct harness execution
// mints one locally. Concurrent identical missions therefore never share
// artifact directories or completion sentinels. There is no deterministic
// fallback: without a CSPRNG the run fails closed instead of risking a
// collision between two identical concurrent missions.
const RUN_NONCE = activationNonce(
  typeof process === 'object' && process ? process.env : null,
)
const RUN_TAG = `run-${RUN_NONCE.slice('NONCE-'.length)}`
const ARTIFACT_DIR = `${LEDGER_DIR}/.artifacts/${RUN_TAG}`
let canaryTrips = 0

// === CANARY-CONTRACT-SLICE:START - test-only export seam; sliced by canary-contract.test.js. Self-contained: references only these symbols + built-ins. ===
// Legacy full-mission validation remains for the first useful roadmap author and
// old resume briefs. New later dispatches use missionPointer() and are validated
// cryptographically by the ledger checker.
//
// RUN-NONCE canary, INVERTED + sentinel-exempt + fail-closed. A trip means
// an ACTUAL spawn-returned verdict echoed a MISSING / empty / whitespace / mismatched
// nonce (discard + re-spawn header-restored, never accept). null/non-object fails
// closed (trip). A LOCAL_SENTINEL-marked, harness-built default (a fresh-run frontier
// default, a null-probe fallback) NEVER went through a spawn, so it carries no nonce
// by construction and is EXEMPT - exempting it before the missing-nonce check is what
// stops a false trip on every healthy fresh run. The marker is a Symbol so it never
// appears in the JSON a spawn returns under additionalProperties:false; only the
// harness can stamp it. Belt-only by design: ZERO schema edits - each canaried schema
// keeps its OPTIONAL nonce slot (what the predicate reads); routing nonce into a
// schema `required` would surface as a 4xx/throw that classifyThrow escalates to a
// hard run-kill or unbounded retry. The real teeth is this in-SUT predicate.

// The EXACT mission-block label brief() inlines at parts[2]. Lifted to a shared const
// referenced by BOTH brief() and the validator so the two can never drift (the
// lockstep tripwire the test asserts).
const MISSION_BLOCK_LABEL = 'ORIGINAL MISSION (the user prompt, verbatim, the constitution for this work; it OUTRANKS every plan, artifact, and reviewer note below; verify against THIS text, never against what another agent told you):'
const MISSION_POINTER_LABEL = 'MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.'

// Marks a harness-built default object (never spawn-returned, so no nonce by
// construction) so canaryTrippedCore can exempt it. A Symbol, not a string field, so
// it is invisible to the JSON a spawn returns and unreachable by additionalProperties.
const LOCAL_SENTINEL = Symbol('localSentinel')

// FIX-08: substring-containment validator. Returns the assembled brief unchanged when
// it CONTAINS the verbatim mission at the assembled position; else throws a
// deterministic TypeError naming the role. Parameterized on mission/label (not the
// module MISSION) so the test can require it standalone. No trim: brief() embeds the
// mission verbatim, and trimming would weaken the guard.
function assertMissionBlock(assembled, mission, role, label) {
  if (typeof assembled === 'string' && assembled.includes(label + '\n' + mission + '\n')) return assembled
  throw new TypeError(`MISSION-VERBATIM GUARD: brief for "${role}" does not contain the verbatim ORIGINAL MISSION at the assembled position (LABEL + mission + newline); a paraphrased or dropped mission must never reach a spawn. Emit the mission byte-for-byte.`)
}

// FIX-09: the inverted, sentinel-exempt, fail-closed canary predicate. true == trip.
// Parameterized on runNonce for unit-testability; the live wrapper passes RUN_NONCE.
function canaryTrippedCore(gateResult, runNonce) {
  if (!gateResult || typeof gateResult !== 'object') return true   // fail-closed: null/non-object trips
  if (gateResult[LOCAL_SENTINEL] === true) return false            // harness-built default, never spawned: EXEMPT
  const echoed = typeof gateResult.nonce === 'string' ? gateResult.nonce.trim() : ''
  return echoed === '' || echoed !== runNonce                      // missing/empty OR mismatch: trip
}
// === CANARY-CONTRACT-SLICE:END ===

// The EXACT PROMPTS-SO-FAR label brief() inlines when PRIOR_STEERS is non-empty.
// Lifted to a shared const (mirroring MISSION_BLOCK_LABEL) so the steer-region
// framing is ONE source of truth and the ledger-check text-diff canary
// (missionFidelityFindings) can lock to it via a source-substring tripwire. Placed
// OUTSIDE the canary-contract slice (which ends above and is self-contained) so the
// sliced bytes stay byte-identical and canary-contract.test.js is provably untouched.
const PRIOR_STEERS_BLOCK_LABEL = "PROMPTS-SO-FAR (the user's later steers in this session; they ride ALONGSIDE the ORIGINAL MISSION and refine HOW to do it, but the ORIGINAL MISSION above OUTRANKS them - a steer can never override what the mission asks):"

function promptLedgerText() {
  const prompts = [`=== PROMPT 1 ===\n${MISSION}`]
  if (PRIOR_STEERS) prompts.push(`=== PROMPT 2 ===\n${PRIOR_STEERS}`)
  return prompts.join('\n')
}

function utf8Bytes(text) {
  return unescape(encodeURIComponent(text)).length
}

function sha256Hex(text) {
  const bytes = unescape(encodeURIComponent(text))
  const words = []
  const bitLength = bytes.length * 8
  for (let i = 0; i < bytes.length; i++) words[i >> 2] = (words[i >> 2] || 0) | bytes.charCodeAt(i) << (24 - (i % 4) * 8)
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | 0x80 << (24 - bitLength % 32)
  words[((bitLength + 64 >> 9) << 4) + 15] = bitLength
  const constants = sha256Constants()
  let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  for (let offset = 0; offset < words.length; offset += 16) hash = sha256Block(hash, words, offset, constants)
  return hash.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('')
}

function sha256Constants() {
  const constants = []
  for (let candidate = 2; constants.length < 64; candidate++) {
    let isPrime = true
    for (let divisor = 2; divisor * divisor <= candidate; divisor++) if (candidate % divisor === 0) { isPrime = false; break }
    if (isPrime) constants.push(Math.floor((Math.pow(candidate, 1 / 3) % 1) * 0x100000000))
  }
  return constants
}

function rotateRight(value, count) {
  return value >>> count | value << (32 - count)
}

function sha256Block(initial, words, offset, constants) {
  const schedule = new Array(64)
  for (let i = 0; i < 16; i++) schedule[i] = words[offset + i] | 0
  for (let i = 16; i < 64; i++) {
    const s0 = rotateRight(schedule[i - 15], 7) ^ rotateRight(schedule[i - 15], 18) ^ schedule[i - 15] >>> 3
    const s1 = rotateRight(schedule[i - 2], 17) ^ rotateRight(schedule[i - 2], 19) ^ schedule[i - 2] >>> 10
    schedule[i] = schedule[i - 16] + s0 + schedule[i - 7] + s1 | 0
  }
  let [a, b, c, d, e, f, g, h] = initial
  for (let i = 0; i < 64; i++) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
    const choice = e & f ^ ~e & g
    const temp1 = h + sum1 + choice + constants[i] + schedule[i] | 0
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
    const majority = a & b ^ a & c ^ b & c
    const temp2 = sum0 + majority | 0
    h = g; g = f; f = e; e = d + temp1 | 0; d = c; c = b; b = a; a = temp1 + temp2 | 0
  }
  return initial.map((value, index) => value + [a, b, c, d, e, f, g, h][index] | 0)
}

// === DURABLE-DISPATCH-BARRIER-SLICE:START ===
function publicationIdentityReasons(publication, expected) {
  const reasons = []
  const fields = [
    ['transition', 'transition does not match'],
    ['featureId', 'feature id does not match'],
    ['artifactPath', 'artifact path does not match'],
    ['artifactHash', 'artifact hash does not match the expected binding'],
    ['artifactBytes', 'artifact byte count does not match'],
    ['nonce', 'nonce does not match the active run'],
    ['producerGate', 'producer gate does not match'],
    ['producerPersona', 'producer persona does not match'],
    ['verdict', 'producer verdict does not match'],
    ['ledgerPath', 'ledger path does not match'],
  ]
  for (const [field, message] of fields) {
    if (
      expected[field] !== undefined &&
      publication[field] !== expected[field]
    ) reasons.push(`prerequisite ${message}${field === 'artifactPath' ? ` ${expected[field]}` : ''}`)
  }
  return reasons
}

function publicationShapeReasons(publication) {
  const reasons = []
  if (!publication || typeof publication !== 'object') {
    return ['prerequisite publication receipt is missing']
  }
  if (publication.artifactExists !== true) {
    reasons.push('prerequisite artifact is not durably present')
  }
  if (/\.tmp$/i.test(publication.artifactPath || '')) {
    reasons.push('prerequisite artifact path is temporary')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(publication.artifactHash || '')) {
    reasons.push('prerequisite artifact hash is missing or malformed')
  }
  if (!Number.isInteger(publication.artifactBytes) || publication.artifactBytes < 1) {
    reasons.push('prerequisite artifact byte count is missing or invalid')
  }
  return reasons
}

function durableLedgerReasons(publication, expected, hashText) {
  const reasons = []
  if (publication.ledgerRowDurable !== true) {
    return ['prerequisite ledger row is not durably present']
  }
  if (typeof publication.ledgerRow !== 'string' || publication.ledgerRow === '') {
    return ['prerequisite ledger row bytes are missing']
  }
  const actualHash = `sha256:${hashText(publication.ledgerRow)}`
  if (publication.ledgerRowHash !== actualHash) {
    reasons.push('prerequisite ledger row hash does not match its exact bytes')
  }
  const bindings = [
    ['transition', publication.transition, 'transition'],
    ['feature', publication.featureId, 'feature id'],
    ['path', publication.artifactPath, 'artifact path'],
    ['hash', publication.artifactHash, 'hash'],
    ['bytes', publication.artifactBytes, 'bytes'],
    ['nonce', publication.nonce, 'nonce'],
    ['gate', publication.producerGate, 'gate'],
    ['persona', publication.producerPersona, 'persona'],
    ['verdict', publication.verdict, 'verdict'],
  ]
  // Exact field-token binding: substring inclusion would accept a suffixed
  // value (nonce=NONCE-x-extra), a value hidden inside another field
  // (xpath=nonce=NONCE-x), or a conflicting duplicate token. Each bound field
  // must appear as EXACTLY ONE <name>=<value> token whose value matches.
  const rowTokens = publication.ledgerRow.split(/\s+/).filter(token => token !== '')
  for (const [name, value, label] of bindings) {
    if (value === undefined) continue
    const fieldTokens = rowTokens.filter(token => {
      const eq = token.indexOf('=')
      return eq > 0 && token.slice(0, eq) === name
    })
    if (
      fieldTokens.length !== 1 ||
      fieldTokens[0].slice(fieldTokens[0].indexOf('=') + 1) !== String(value)
    ) {
      reasons.push(`durable ledger row does not bind ${label}`)
    }
  }
  return reasons
}

function publicationBarrierReasons(publication, expected, hashText) {
  const shapeReasons = publicationShapeReasons(publication)
  if (!publication || typeof publication !== 'object') return shapeReasons
  return [
    ...shapeReasons,
    ...publicationIdentityReasons(publication, expected || {}),
    ...durableLedgerReasons(publication, expected || {}, hashText),
  ]
}
// === DURABLE-DISPATCH-BARRIER-SLICE:END ===

function publicationExpected(
  transition,
  artifactPath,
  artifactHash,
  artifactBytes,
  producerGate,
  producerPersona,
  verdict,
  featureId,
  sourceArtifact,
) {
  return {
    transition,
    artifactPath,
    artifactHash,
    artifactBytes,
    nonce: RUN_NONCE,
    producerGate,
    producerPersona,
    verdict,
    ledgerPath: `${LEDGER_DIR}/GATELOG.md`,
    ...(featureId ? { featureId } : {}),
    ...(sourceArtifact ? { sourceArtifact } : {}),
  }
}

function readUtf8File(fileSystem, filePath) {
  try {
    return {
      text: fileSystem.readFileSync(filePath, 'utf8'),
      errorCode: '',
    }
  } catch (error) {
    return {
      text: null,
      errorCode:
        error && error.code
          ? String(error.code)
          : 'read failed',
    }
  }
}

function observeArtifact(fileSystem, artifactPath) {
  const read = readUtf8File(fileSystem, artifactPath)
  if (typeof read.text !== 'string') {
    return {
      exists: false,
      hash: '',
      bytes: null,
      errorCode: read.errorCode,
    }
  }
  return {
    exists: true,
    hash: `sha256:${sha256Hex(read.text)}`,
    bytes: utf8Bytes(read.text),
    errorCode: '',
  }
}

function readDurablePublication(publication, expected) {
  const inspected = {
    ...publication,
    artifactExists: false,
    ledgerRowDurable: false,
  }
  const getBuiltin =
    typeof process === 'object' &&
    process &&
    typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule.bind(process)
      : null
  if (!getBuiltin) {
    inspected.inspectionError =
      'filesystem inspection is unavailable'
    return inspected
  }
  const fileSystem =
    getBuiltin('node:fs') || getBuiltin('fs')
  if (!fileSystem) {
    inspected.inspectionError =
      'filesystem inspection is unavailable'
    return inspected
  }

  const artifact = observeArtifact(
    fileSystem,
    publication.artifactPath,
  )
  inspected.artifactExists = artifact.exists
  inspected.observedArtifactHash = artifact.hash
  inspected.observedArtifactBytes = artifact.bytes
  inspected.artifactReadError = artifact.errorCode

  const ledger = readUtf8File(
    fileSystem,
    publication.ledgerPath,
  )
  inspected.ledgerRowDurable =
    typeof ledger.text === 'string' &&
    ledger.text.split(/\r?\n/).includes(publication.ledgerRow)
  inspected.ledgerReadError = ledger.errorCode

  if (expected && expected.sourceArtifact) {
    const source = observeArtifact(
      fileSystem,
      expected.sourceArtifact.path,
    )
    inspected.sourceArtifactExists = source.exists
    inspected.observedSourceArtifactHash = source.hash
    inspected.observedSourceArtifactBytes = source.bytes
    inspected.sourceArtifactReadError = source.errorCode
  }
  return inspected
}

function requireDurablePublication(
  publication,
  expected,
  transition,
) {
  const inspected = readDurablePublication(
    publication || {},
    expected,
  )
  const reasons = publicationBarrierReasons(
    inspected,
    expected,
    sha256Hex,
  )
  if (typeof inspected.inspectionError === 'string') {
    reasons.push(inspected.inspectionError)
  }
  if (
    typeof inspected.observedArtifactHash === 'string' &&
    inspected.observedArtifactHash !== '' &&
    inspected.observedArtifactHash !== publication.artifactHash
  ) {
    reasons.push(
      'prerequisite artifact hash differs from durable bytes',
    )
  }
  if (
    Number.isInteger(inspected.observedArtifactBytes) &&
    inspected.observedArtifactBytes !== publication.artifactBytes
  ) {
    reasons.push(
      'prerequisite artifact byte count differs from durable bytes',
    )
  }
  const sourceArtifact = expected && expected.sourceArtifact
  if (sourceArtifact) {
    if (inspected.sourceArtifactExists !== true) {
      reasons.push(
        'prerequisite source artifact is not durably present',
      )
    }
    if (
      typeof sourceArtifact.hash === 'string' &&
      inspected.observedSourceArtifactHash !== sourceArtifact.hash
    ) {
      reasons.push(
        'prerequisite source artifact hash does not match the expected binding',
      )
    }
    if (
      Number.isInteger(sourceArtifact.bytes) &&
      inspected.observedSourceArtifactBytes !== sourceArtifact.bytes
    ) {
      reasons.push(
        'prerequisite source artifact byte count does not match the expected binding',
      )
    }
    if (
      sourceArtifact.mustMatchFinal === true &&
      inspected.observedSourceArtifactHash !==
        inspected.observedArtifactHash
    ) {
      reasons.push(
        'frozen artifact differs from the approved source artifact',
      )
    }
  }
  if (reasons.length) {
    throw new TypeError(
      `BLOCKED ${transition}: ${reasons.join('; ')}`,
    )
  }
  return inspected
}

function publicationInstruction(
  transition,
  artifactPath,
  producerGate,
  producerPersona,
  verdict,
  featureId,
) {
  const featureBinding = featureId
    ? ` feature=${featureId}`
    : ''
  return `After atomically publishing "${artifactPath}", re-read its final bytes, compute SHA-256 and UTF-8 byte count, and append exactly one PREREQUISITE row to "${LEDGER_DIR}/GATELOG.md" with transition=${transition}${featureBinding} path=${artifactPath} hash=<computed> bytes=<computed> nonce=${RUN_NONCE} gate=${producerGate} persona=${producerPersona} verdict=${verdict}. Flush and re-read that row. Return publication {transition${featureId ? `, featureId: "${featureId}"` : ''}, artifactPath, artifactExists, artifactHash, artifactBytes, nonce, producerGate, producerPersona, verdict, ledgerPath, ledgerRow, ledgerRowHash, ledgerRowDurable}; artifactExists and ledgerRowDurable may be true only after those re-reads, and ledgerRowHash is SHA-256 of the exact appended row bytes.`
}

function missionPointerBinding() {
  const ledger = promptLedgerText()
  return {
    path: `${LEDGER_DIR}/PROMPTS.txt`,
    hash: `sha256:${sha256Hex(ledger)}`,
    bytes: utf8Bytes(ledger),
    nonce: RUN_NONCE,
  }
}

function missionPointer() {
  const pointer = missionPointerBinding()
  return `${MISSION_POINTER_LABEL}\npath=${pointer.path} hash=${pointer.hash} bytes=${pointer.bytes} nonce=${pointer.nonce}`
}

function assembleBrief(role, body, artifactPath, includeMission) {
  const parts = [`You are ${role}.`, '']
  if (includeMission) {
    parts.push(MISSION_BLOCK_LABEL, MISSION, '')
    if (PRIOR_STEERS) parts.push(PRIOR_STEERS_BLOCK_LABEL, PRIOR_STEERS, '')
  } else {
    parts.push(missionPointer(), '')
  }
  parts.push(
    autopromptRunMarker(),
    `RUN-NONCE: ${RUN_NONCE} (echo this token verbatim in your report; it proves your brief was not corrupted by a context compaction or a crossed wire)`,
    '',
    'AUTOPROMPT WORKER CONTRACT: Your registered persona file and this task brief are already your complete operating context. Do not load, invoke, or re-invoke the Autoprompt skill, and do not start a nested Autoprompt run. Execute only your assigned persona and brief. If this persona may spawn, dispatch only a registered ap-* persona.',
    '',
    body,
  )
  if (artifactPath) {
    parts.push('', `ARTIFACT (required): before returning your report, write your full output verbatim to "${artifactPath}" (create parent directories if needed). Write it ATOMICALLY - write "${artifactPath}.tmp" then \`mv\` (rename) it onto "${artifactPath}" - so a crash mid-write never leaves a half-written checkpoint a resume probe could mistrust; never overwrite an existing finished -vN artifact, write the next -v(N+1) instead. Artifacts are the run's checkpoints: they stay on disk for the whole session and only a janitor deletes them at the very end. Write the file even when your verdict is negative.`)
  }
  return assertSingleBlock(parts.join('\n'), role)
}

function brief(role, body, artifactPath) {
  const assembled = assembleBrief(role, body, artifactPath, true)
  return assertMissionBlock(assembled, MISSION, role, MISSION_BLOCK_LABEL)
}

function compactBrief(role, body, artifactPath) {
  return assembleBrief(role, body, artifactPath, false)
}

// === SERIAL-DISPATCH-SLICE:START - test-only export seam; sliced by remaining-harness.test.js.
// Self-contained: references only its params + built-ins. ===
//
// P-22 (non-blocking dispatch BY CONSTRUCTION): when the orchestrator holds a wave of
// INDEPENDENT ready work it must spawn-all-then-collect (parallel), never spawn-wait-spawn
// (serial). fanout() IS that primitive - it runs an independent wave through a single
// parallel() call - and it records every wave it runs into dispatchLedger. serialDispatch
// Findings replays that record and flags any wave that ran >=2 independent thunks SERIALLY
// while the execution mode supported concurrent fan-out - the F-5 "firing N then fired 1"
// defect made a mechanical in-harness tripwire. Two arms:
//   FLAG arm (legacy): the wave was dispatched with isParallel!==true while the mode
//     supports parallelism - a serial DECISION at the choke point.
//   OBSERVED arm: the wave record carries the peak concurrency the runtime actually
//     reached (fanout measures it around every thunk). A parallel-FLAGGED wave whose
//     observed peak never reached the achievable width ran spawn-wait-spawn behind a
//     blocking spawn - the run_in_background:false / "Review Wave (concurrent)"-over-
//     sequential-reality collapse, invisible to the flag arm. Records WITHOUT observed
//     evidence (historical, hand-built) are judged by the flag arm only and never
//     retro-fail. A wave chunked by the DECLARED live cap (peak === achievableWidth <
//     count) is not a violation. A trip BLOCKS the DONE seal. PURE, total: a
//     non-object/short wave -> no trip.
const SERIAL_DISPATCH_MIN_WAVE = 2      // a wave of >= this many independent thunks must go parallel
function serialDispatchViolation(wave) {
  if (!wave || typeof wave !== 'object') return false
  const count = Number.isFinite(wave.count) ? wave.count : 0
  if (count < SERIAL_DISPATCH_MIN_WAVE || wave.parallelSupported !== true) return false
  if (wave.isParallel !== true) return true
  if (Number.isFinite(wave.peakLive) && Number.isFinite(wave.achievableWidth) &&
      wave.achievableWidth >= SERIAL_DISPATCH_MIN_WAVE) {
    return wave.peakLive < wave.achievableWidth
  }
  return false
}
function serialDispatchFindings(waves) {
  const findings = []
  for (const w of (Array.isArray(waves) ? waves : [])) {
    if (!serialDispatchViolation(w)) continue
    const at = w.label ? ` at ${w.label}` : ''
    const observed = w.isParallel === true && Number.isFinite(w.peakLive) && Number.isFinite(w.achievableWidth)
    findings.push({
      severity: 'P1', rule: 'serialDispatchFindings',
      title: observed
        ? `SERIAL-DISPATCH of independent work${at}: observed peak concurrency ${w.peakLive} of ${w.achievableWidth} achievable - ${w.count} independent ready thunks were held behind blocking spawns (spawn-wait-spawn) though the wave was dispatched parallel-flagged and the mode supports concurrent fan-out - independent work must be spawn-all-then-collect (P-22 / F-5 never-serialize).`
        : `SERIAL-DISPATCH of independent work${at}: ${w.count} independent ready thunks were dispatched SERIALLY (spawn-wait-spawn) though the execution mode supports concurrent fan-out - independent work must be spawn-all-then-collect (P-22 / F-5 never-serialize).`,
    })
  }
  return findings
}
// === SERIAL-DISPATCH-SLICE:END ===

// The module-global dispatch ledger the LIVE path fills: fanout() pushes one record per
// wave it runs; the DONE seal replays it through serialDispatchFindings so a serial dispatch
// of independent work cannot reach DONE. Hermetic unit tests build their own wave arrays.
const dispatchLedger = []

// Sentinel marker: a thunk that classified a NON-transient throw wraps it in
// this instead of letting the wave's catch flatten it to an indistinguishable
// null. A LEGITIMATE null return (a skipped/abandoned agent) stays null; only a
// genuine non-transient escalation is tagged, so fanout can tell the two apart
// and re-propagate the escalation to the driver (loud exit -> supervisor RESUME).
const NON_TRANSIENT_SENTINEL = Symbol('nonTransientEscalation')

// Sequential-or-parallel fan-out, per the execution mode. A transient throw is
// already waited out UNBOUNDED inside each thunk by withRetry, so it never
// reaches here. A NON-transient throw (a bug, or 4xx) MUST escalate exactly as
// it does at a sequential agent() call: we capture it as a tagged sentinel
// (surviving any parallel() primitive that swallows throws to null), then
// re-throw it after the wave so the driver takes the loud escalate path. A
// thunk that legitimately RETURNS null is preserved as null, never escalated.
async function fanout(thunks, isParallel, label) {
  if (!thunks.length) return []   // empty wave: never depends on parallel([])'s contract
  // Effective per-wave cap = the GLOBAL MAX_CONCURRENT ceiling AND the per-mode
  // MODE_LIVE_CAP (the REAL teeth): a TOKENSAVER wave never exceeds 6 live agents,
  // WIDE/CUSTOM never exceed MAX_CONCURRENT. A null MODE_LIVE_CAP[MODE] means no
  // per-mode cap, so only the global ceiling applies. A wave wider than the cap is
  // split into sequential chunks of `cap`, each chunk run in parallel - without
  // this, "unbounded" WIDE could spawn an arbitrarily wide wave.
  const cap = Math.min(MAX_CONCURRENT, (MODE_LIVE_CAP[MODE] == null ? MAX_CONCURRENT : MODE_LIVE_CAP[MODE]))
  // P-22: record the wave's shape so the DONE seal can prove independent work was
  // spawn-all-then-collect (parallel), never spawn-wait-spawn. parallelSupported is the
  // mode's own parallel flag; a wave of >=2 thunks dispatched with isParallel!==true while
  // the mode supports parallelism is the serial-when-parallel-possible defect.
  // achievableWidth is the width a genuinely concurrent runtime MUST reach
  // (min(count, cap)); peakLive (filled in after the wave) is the peak concurrency the
  // runtime ACTUALLY reached - the observed-shape evidence that catches a
  // parallel-flagged wave that physically ran spawn-wait-spawn.
  const record = {
    count: thunks.length,
    isParallel: !!isParallel,
    parallelSupported: !!(typeof MODE_CFG === 'object' && MODE_CFG && MODE_CFG.parallelFeatures),
    label: typeof label === 'string' ? label : '',
    achievableWidth: Math.min(thunks.length, cap),
    peakLive: 0,
  }
  dispatchLedger.push(record)
  let liveNow = 0
  let peakLive = 0
  const guarded = thunks.map(t => async () => {
    // A genuinely concurrent parallel() invokes EVERY thunk before the first one
    // settles (invocation is synchronous; settlement always takes a later microtask),
    // so peakLive reaches achievableWidth. A serial spawn-wait-spawn primitive never
    // holds more than one live thunk - the measured peak is the concurrency proof.
    liveNow += 1
    if (liveNow > peakLive) peakLive = liveNow
    try { return await t() }
    catch (error) {
      if (error instanceof NonTransientError) {
        return { [NON_TRANSIENT_SENTINEL]: error }
      }
      if (classifyThrow(error) === 'nonTransient') {
        return {
          [NON_TRANSIENT_SENTINEL]: new NonTransientError(
            label || 'fanout',
            error,
          ),
        }
      }
      throw error
    } finally {
      liveNow -= 1
    }
  })
  let raw
  if (!isParallel) {
    raw = await runSequential(guarded)
  } else if (guarded.length <= cap) {
    raw = await parallel(guarded)
  } else {
    raw = []
    for (let i = 0; i < guarded.length; i += cap) {
      raw.push(...await parallel(guarded.slice(i, i + cap)))
    }
  }
  record.peakLive = peakLive
  const escalation = raw.find(r => r && r[NON_TRANSIENT_SENTINEL])
  if (escalation) throw escalation[NON_TRANSIENT_SENTINEL]
  return raw
}

// Sequential fan-out helper: run thunks one at a time, preserving order. A
// returned null stays null; a thrown error propagates (the guarded wrapper
// above has already converted a non-transient escalation into a sentinel value,
// so nothing genuinely throws here except a defensive re-throw).
async function runSequential(thunks) {
  const results = []
  for (const t of thunks) results.push(await t())
  return results
}

// Canary check (FIX-09): the live one-arg wrapper over canaryTrippedCore (in the
// CANARY-CONTRACT-SLICE). A trip means an ACTUAL spawn-returned verdict echoed a
// MISSING/empty/whitespace/mismatched nonce, OR is null/non-object (fail-closed) -
// the caller DISCARDS and re-spawns (brief() restores the header). A
// LOCAL_SENTINEL-marked, harness-built default is exempt (it never went through a
// spawn). Belt-only on the schema side: nonce stays OPTIONAL on every canaried
// schema; do NOT move it to `required` - that would route a missing echo through
// the injected runtime's validation into a 4xx/throw that classifyThrow escalates
// to a hard run-kill or unbounded retry. The teeth is THIS in-SUT predicate.
function canaryTripped(gateResult) {
  return canaryTrippedCore(gateResult, RUN_NONCE)
}

// Group features into ascending-phase buckets. Within a bucket, all features
// are independent (disjoint boundaries); dependsOn edges that cross buckets
// are satisfied because lower phases complete before higher ones run.
function phasesOf(features) {
  return dependencyWaves(features)
}

// Validate dependsOn edges: every referenced id must exist, and the
// dependency graph must be acyclic (a cycle would deadlock phase advancement).
function validateDependencies(features) {
  const ids = new Set(features.map(f => f.id))
  for (const f of features) {
    for (const dep of f.dependsOn || []) {
      if (!ids.has(dep)) return { ok: false, reason: `${f.id} dependsOn unknown feature "${dep}"` }
    }
  }
  // DFS cycle detection over the dependsOn edges.
  const WHITE = 0, GREY = 1, BLACK = 2
  const color = {}
  for (const f of features) color[f.id] = WHITE
  const byIdLocal = {}
  for (const f of features) byIdLocal[f.id] = f
  function visit(id, trail) {
    color[id] = GREY
    for (const dep of (byIdLocal[id].dependsOn) || []) {
      if (color[dep] === GREY) return `${[...trail, id, dep].join(' -> ')}`
      if (color[dep] === WHITE) {
        const cyc = visit(dep, [...trail, id])
        if (cyc) return cyc
      }
    }
    color[id] = BLACK
    return null
  }
  for (const f of features) {
    if (color[f.id] === WHITE) {
      const cyc = visit(f.id, [])
      if (cyc) return { ok: false, reason: `dependsOn cycle: ${cyc}` }
    }
  }
  try {
    dependencyWaves(features)
  } catch (error) {
    return { ok: false, reason: error.message }
  }
  return { ok: true }
}

// Budget guard: stop opening NEW work when the token target is nearly spent,
// rather than burning to zero (the cloud-budget-exhausted failure mode).
function canSpawnNewWork() {
  if (!budget || !budget.total) return true
  return budget.remaining() > MIN_BUDGET_TO_SPAWN
}

// ----- arbiter: rules and continues; transient calls are waited out by the --
// ----- withRetry primitive (no give-up). Under UNATTENDED it never escalates --
const userQuestions = []  // arbiter-escalated questions genuinely needing the user (attended only)
const assumed = []         // unattended ASSUMED answers, recorded for observability
const allSuggestions = []  // reviewer suggestions retained in the compact run summary
let arbiterCount = 0

async function arbiter(decisionBody, phaseName) {
  arbiterCount++
  const ruling = await agent(
    compactBrief('an independent arbiter, questions route to you BEFORE the user; be ~99% autonomous',
      `THE QUESTION / DECISION:\n${decisionBody}\n\n` +
      (UNATTENDED
        ? `THIS RUN IS UNATTENDED: the user is unreachable by design. You may NOT set userRequired:true. Choose the option that best serves the mission, set proceed accordingly, and record your assumed answer in decision (prefix it "ASSUMED: "). Ruling and continuing is the only valid output.\n`
        : '') +
      `Two jobs: decide it if a competent senior engineer could (almost everything, pick what best serves the mission and clean code and 95% coverage), and judge whether it GENUINELY requires the user. ` +
      `It is userRequired ONLY if irreversible/destructive, spends real money/quota, needs a credential only the user holds, or is a product-direction call the user must own, not a technical choice an engineer would just make. If userRequired, do not guess; set userQuestion to the precise question. ` +
      `Set proceed=true to continue/accept, false to stop/drop. State the one risk you accept. Your ruling is binding.`,
      `${ARTIFACT_DIR}/arbiter-${arbiterCount}.md`),
    { label: `arbiter ${arbiterCount}`, phase: phaseName || 'Build', schema: ARBITER_SCHEMA, agentType: PERSONA.arbiter },
  )
  if (ruling.userRequired && ruling.userQuestion) {
    if (UNATTENDED) {
      ruling.userRequired = false
      ruling.proceed = true   // rule AND continue: the user is unreachable, the arbiter assumes the mission-serving answer and proceeds
      assumed.push(ruling.userQuestion)
      log(`ARBITER (unattended): ASSUMED an answer instead of asking - ${ruling.userQuestion}`)
    } else {
      userQuestions.push(ruling.userQuestion)
      log(`ARBITER flagged a user-required question (surfaced, not guessed): ${ruling.userQuestion}`)
    }
  }
  return { ...ruling, errored: false }
}

// ----- gate loops -------------------------------------------------------
async function planUntilApproved(feature, tierCfg) {
  const ph = 'Plan'
  const fullLoop = !tierCfg || tierCfg.planLoop !== false  // T3 default: full G1-G2-G3 loop
  const finalPlanPath = `${ARTIFACT_DIR}/${feature.id}-plan-final.md`
  let plan = null
  let lastReasons = []
  let planAttempts = 0
  let freshRejects = 0

  // TIER T2: a single plan DRAFT precedes the build - no plan-review / fresh-
  // verify SMASH loop (that depth is the T3 ceiling). The draft is the contract
  // the implementer reads; the IMPL-REVIEW + VERIFY gates still police it.
  if (!fullLoop) {
    assertExecLevel(PERSONA.planner, `${feature.id} plan-draft`)
    const drafted = await agent(
      compactBrief('a planner, produce a concise implementation plan, no production code',
        `YOUR FEATURE: ${feature.name} (${feature.id}), boundary: ${feature.boundary}\n` +
        `CATEGORY: ${feature.category}${feature.tag ? `\nPLAYBOOK TAG: ${feature.tag}` : ''}\n` +
        `Look at the real artifact before planning (read files, run the failing case). See PLAYBOOKS.md.\n` +
        `Deliver a focused plan: success in the mission's terms; the changes file-by-file; edge/unhappy paths; a test strategy that proves behavior; the one real design choice this feature carries. ` +
        publicationInstruction(
          'plan-to-implementation',
          finalPlanPath,
          'G1-DRAFT',
          PERSONA.planner,
          'APPROVED',
          feature.id,
        ),
        finalPlanPath),
      { label: `${feature.id} plan-draft`, phase: ph, schema: PLAN_DRAFT_SCHEMA, agentType: PERSONA.planner },
    )
    recordGateSpawn(feature, 'G1', PERSONA.planner, featureSpawnLog)
    requireDurablePublication(
      drafted.publication,
      publicationExpected(
        'plan-to-implementation',
        drafted.publication.artifactPath,
        drafted.publication.artifactHash,
        drafted.publication.artifactBytes,
        'G1-DRAFT',
        PERSONA.planner,
        'APPROVED',
        feature.id,
      ),
      'plan-to-implementation',
    )
    plan = drafted.plan
    return { plan, ok: true, planPublication: drafted.publication }
  }

  while (planAttempts < PLAN_ATTEMPT_BUDGET) {
    planAttempts++
    assertExecLevel(PERSONA.planner, `${feature.id} plan #${planAttempts}`)
    plan = await agent(
      compactBrief('a planner, produce an implementation/research plan, no production code',
        `YOUR FEATURE: ${feature.name} (${feature.id}), boundary: ${feature.boundary}\n` +
        `CATEGORY: ${feature.category}${feature.tag ? `\nPLAYBOOK TAG: ${feature.tag}` : ''}\n` +
        `Look at the real artifact before planning (read files, fetch pages, run the failing case). See PLAYBOOKS.md for the decomposition spine and playbook tags.\n` +
        (lastReasons.length ? `A prior plan was rejected. Fix these and resubmit:\n- ${lastReasons.join('\n- ')}\n` : '') +
        `Deliver the full plan: success in the mission's terms; every change file-by-file; edge/unhappy paths; test strategy that proves behavior; real-system steps; risks; a coverage argument for why this is 100% against the mission.`,
        `${ARTIFACT_DIR}/${feature.id}-plan-v${planAttempts}.md`),
      { label: `${feature.id} plan #${planAttempts}`, phase: ph, agentType: PERSONA.planner },
    )
    recordGateSpawn(feature, 'G1', PERSONA.planner, featureSpawnLog)

    // EDIT A (gate-DAG {G2‖G3}): G2 plan-review and G3 fresh-verify are
    // INDEPENDENT (both consume only mission+plan; neither reads the other), so
    // they dispatch CONCURRENTLY via the existing fanout helper - sequential in
    // TOKENSAVER (one-live-at-a-time invariant untouched), concurrent in
    // BILLIONAIRE (capped by MAX_CONCURRENT). Running them concurrently makes G3
    // blind to G2 BY CONSTRUCTION: G2's verdict does not exist when G3 runs.
    // NO short-circuit/cancel (§3(a) REJECT): both siblings run to completion and
    // the loser is discarded at the join - recordGateSpawn fires for both.
    const planPath = `${ARTIFACT_DIR}/${feature.id}-plan-v${planAttempts}.md`
    const g2thunk = async () => {
      const review = await agent(
        compactBrief('a plan reviewer, you did NOT write this plan',
          `PLAN UNDER REVIEW: read "${planPath}".\n` +
          `Check coverage vs the exact mission ledger, coverage vs reality, edge cases, behavior-proving tests, scope creep, and foolproofness. ` +
          `Return SMASH with numbered reasons and the affected section, or PASS only if you would stake your name on complete mission coverage.` +
          packPointer(feature),
          `${ARTIFACT_DIR}/${feature.id}-plan-review-v${planAttempts}.md`),
        { label: `${feature.id} plan-review #${planAttempts}`, phase: ph, schema: REVIEW_SCHEMA, agentType: PERSONA.reviewer },
      )
      recordGateSpawn(feature, 'G2', PERSONA.reviewer, featureSpawnLog)
      return review
    }
    const g3thunk = async () => freshVerifyOnly(feature, planPath)  // records G3 internally; reports APPROVE/REJECT only, NO freeze
    const [review, fresh] = await fanout([g2thunk, g3thunk], MODE_CFG.parallelFeatures)

    if (review && Array.isArray(review.suggestions)) {
      for (const s of review.suggestions) allSuggestions.push(`${feature.id} (${ph}): ${s}`)
    }
    if (canaryTripped(review)) {
      canaryTrips++
      log(`CANARY: nonce mismatch at ${feature.id} plan-review #${planAttempts}; treating verdict as untrusted (SMASH)`)
      lastReasons = ['canary trip: brief nonce mismatch, re-running the plan gate']
      continue
    }

    // JOIN: the parent freezes IFF G2=PASS && G3=APPROVE (correctness wall §4 -
    // a SMASHed plan is never frozen; the freeze is enforced by the orchestrator,
    // not the blind G3 agent).
    if (review && review.verdict === 'PASS' && fresh && fresh.approved) {
      const frozen = await writeFrozenPlan(feature, planPath)
      const planPublication = requireDurablePublication(
        frozen.publication,
        publicationExpected(
          'plan-to-implementation',
          frozen.publication.artifactPath,
          frozen.publication.artifactHash,
          frozen.publication.artifactBytes,
          'G1-FREEZE',
          PERSONA.scribe,
          'APPROVED',
          feature.id,
          {
            path: planPath,
            hash: frozen.publication.artifactHash,
            bytes: frozen.publication.artifactBytes,
            mustMatchFinal: true,
          },
        ),
        'plan-to-implementation',
      )
      return {
        plan: frozen.plan || plan,
        ok: true,
        planPublication,
      }
    }
    // G2 SMASH precedence: if G2 is not PASS, loop on G2 reasons (the G3 result
    // is discarded - G2 is the authoritative plan-review gate).
    if (!review || review.verdict !== 'PASS') {
      lastReasons = (review && review.reasons) || ['reviewer returned no usable verdict']
      if (planAttempts % MAX_PLAN_CYCLES === 0) {
        const ruling = await arbiter(`Plan for ${feature.id} (${feature.name}) SMASHED ${MAX_PLAN_CYCLES}x. Read the candidate at "${planPath}". Outstanding reasons:\n- ${lastReasons.join('\n- ')}\nDecide: good enough to build, keep iterating, or drop the feature?`, ph)
        if (ruling.proceed) continue
      }
      continue
    }
    // G2 PASS but G3 REJECT: loop on G3 reasons under the separate fresh budget.
    freshRejects++
    lastReasons = (fresh && fresh.reasons) || ['fresh verifier rejected without stated reason']
    if (freshRejects >= MAX_FRESH_CYCLES) {
      const ruling = await arbiter(`Plan for ${feature.id} passed review but a fresh verifier REJECTED it ${freshRejects}x. Read the candidate at "${planPath}". Reasons:\n- ${lastReasons.join('\n- ')}\nDecide: build it, or send back for re-scope?`, ph)
      if (ruling.proceed) continue
      freshRejects = 0
    }
  }

  return { plan, ok: false, reasons: lastReasons.length ? lastReasons : ['plan attempt budget exhausted'] }
}

async function freshVerify(feature, planPath) {
  assertExecLevel(PERSONA.freshVerifier, `${feature.id} fresh-verify`)
  const fresh = await agent(
    compactBrief('a fresh verifier, you have seen NO prior discussion, only the mission and this plan',
      `PROPOSED PLAN: read "${planPath}". The planner report for this attempt is the candidate; do not read any review verdict.\n` +
      `Read the real repository yourself before deciding. Answer: does the plan deliver everything the exact mission ledger asks? Is any step hand-wavy, untested, or assuming success? Below complete satisfaction means REJECT with the specific gap.\n` +
      `If APPROVE, copy the candidate plan bytes to "${ARTIFACT_DIR}/${feature.id}-plan-final.md" as the frozen contract. If APPROVE, ` +
      publicationInstruction(
        'plan-to-implementation',
        `${ARTIFACT_DIR}/${feature.id}-plan-final.md`,
        'G3-FREEZE',
        PERSONA.freshVerifier,
        'APPROVED',
        feature.id,
      ),
      `${ARTIFACT_DIR}/${feature.id}-fresh-verify.md`),
    { label: `${feature.id} fresh-verify`, phase: 'Plan', schema: FRESH_SCHEMA, agentType: PERSONA.freshVerifier },
  )
  recordGateSpawn(feature, 'G3', PERSONA.freshVerifier, featureSpawnLog)
  if (canaryTripped(fresh)) {
    canaryTrips++
    log(`CANARY: nonce mismatch at ${feature.id} fresh-verify; treating verdict as REJECT`)
    return { approved: false, reasons: ['canary trip: brief nonce mismatch, re-anchoring the plan'] }
  }
  if (fresh && fresh.verdict === 'APPROVE') {
    const planPublication = requireDurablePublication(
      fresh.publication,
      publicationExpected(
        'plan-to-implementation',
        fresh.publication && fresh.publication.artifactPath,
        fresh.publication && fresh.publication.artifactHash,
        fresh.publication && fresh.publication.artifactBytes,
        'G3-FREEZE',
        PERSONA.freshVerifier,
        'APPROVED',
        feature.id,
      ),
      'plan-to-implementation',
    )
    return {
      approved: true,
      reasons: fresh.reasons || [],
      planPublication,
    }
  }
  return { approved: false, reasons: (fresh && fresh.reasons) || [] }
}

// EDIT B (gate-DAG): freshVerifyOnly is the G3 leaf for the T3 {G2‖G3} JOIN - it
// runs the blind fresh-verify and reports APPROVE/REJECT ONLY; it does NOT write
// the frozen `-plan-final.md`. The freeze moves OUT of the blind G3 agent into
// the parent join (writeFrozenPlan), so G3 can never freeze a plan G2 has not
// also passed, and - running CONCURRENTLY with G2 - G3 is blind to G2's verdict
// BY CONSTRUCTION (G2's verdict does not exist when G3 runs). freshVerify (above)
// keeps its inline freeze for the T1-debug path (debugFreshVerify), whose G3 is
// dependent on its own G1 draft and is NOT part of a G2‖G3 join (R3 asymmetry).
async function freshVerifyOnly(feature, planPath) {
  assertExecLevel(PERSONA.freshVerifier, `${feature.id} fresh-verify`)
  const fresh = await agent(
    compactBrief('a fresh verifier, you have seen NO prior discussion, only the mission and this plan',
      `PROPOSED PLAN: read "${planPath}".\n` +
      `Read the real repository yourself before deciding. Answer: does the plan deliver everything the exact mission ledger asks? Is any step hand-wavy, untested, or assuming success? Below complete satisfaction means REJECT with the specific gap.\n` +
      `Report APPROVE or REJECT only - you do NOT freeze the plan; the parent freezes it on the joint verdict.` +
      packPointer(feature),
      `${ARTIFACT_DIR}/${feature.id}-fresh-verify.md`),
    { label: `${feature.id} fresh-verify`, phase: 'Plan', schema: FRESH_SCHEMA, agentType: PERSONA.freshVerifier },
  )
  recordGateSpawn(feature, 'G3', PERSONA.freshVerifier, featureSpawnLog)
  if (canaryTripped(fresh)) {
    canaryTrips++
    log(`CANARY: nonce mismatch at ${feature.id} fresh-verify; treating verdict as REJECT`)
    return { approved: false, reasons: ['canary trip: brief nonce mismatch, re-anchoring the plan'] }
  }
  return { approved: !!fresh && fresh.verdict === 'APPROVE', reasons: (fresh && fresh.reasons) || [] }
}

// writeFrozenPlan (EDIT B): the parent-side freeze. Called by the {G2‖G3} join
// in planUntilApproved ONLY when G2=PASS && G3=APPROVE - never by the blind G3
// agent. gate.js is fs-free, so the write is performed by a typed write-only L4
// leaf (no judgement, no verdict): it copies the approved plan verbatim into the
// frozen contract `-plan-final.md` the late jurors read. This is the orchestrator
// enforcing the freeze condition, not the agent - a SMASHed plan can never be
// frozen (correctness wall §4: "a SMASHed plan must NOT be frozen").
async function writeFrozenPlan(feature, planPath) {
  const finalPlanPath =
    `${ARTIFACT_DIR}/${feature.id}-plan-final.md`
  return agent(
    compactBrief('a plan-freeze writer; you make NO judgement, you only copy the jointly approved plan as the frozen contract',
      `The plan at "${planPath}" passed plan-review and fresh verification. Copy those exact bytes to "${finalPlanPath}" with no edits or commentary; it becomes the frozen contract read by implementation and later assurance. ` +
      publicationInstruction(
        'plan-to-implementation',
        finalPlanPath,
        'G1-FREEZE',
        PERSONA.scribe,
        'APPROVED',
        feature.id,
      ),
      finalPlanPath),
    { label: `${feature.id} freeze-plan`, phase: 'Plan', schema: PLAN_DRAFT_SCHEMA, agentType: PERSONA.scribe },
  )
}

// FIX-07 consumer: a G1 plan draft (forces the issue-derived repro + a FALSIFIABLE
// root-cause hypothesis BEFORE a fix layer) then a G3 fresh-verify that re-derives
// the root cause from mission+plan only. A REJECT loops back to a fresh draft; an
// exhausted loop arbitrates, and a denial returns ok:false -> BLOCKED_AT_PLAN (no
// fix is implemented). This is the proportionality-narrow form: only a debug
// feature on a freshVerifyDebug tier (T1) reaches here. It adds G1+G3 only (NOT
// the G2 plan-review - that depth stays the T3 ceiling, per FIX-07's "does NOT
// make every T1 heavy").
async function debugFreshVerify(feature, tier, tierCfg) {
  const ph = 'Plan'
  let plan = null
  let lastReasons = []
  let freshRejects = 0
  let attempts = 0
  while (attempts < PLAN_ATTEMPT_BUDGET) {
    attempts++
    assertExecLevel(PERSONA.planner, `${feature.id} debug-plan #${attempts}`)
    const debugPlanPath = `${ARTIFACT_DIR}/${feature.id}-plan-v${attempts}.md`
    plan = await agent(
      compactBrief('a planner, produce a debug plan, no production code',
        `YOUR FEATURE: ${feature.name} (${feature.id}), boundary: ${feature.boundary}\n` +
        `CATEGORY: ${feature.category}\nPLAYBOOK TAG: debug\n` +
        `Follow the debug playbook (PLAYBOOKS.md): FIRST capture an issue-derived RED repro you actually ran, THEN state a FALSIFIABLE root-cause hypothesis and enumerate >=2 competing causes (one explicitly elsewhere than the obvious file). Choose a fix LAYER only AFTER the repro + hypothesis are on record - never lock a root cause inside scope.\n` +
        (lastReasons.length ? `A prior plan was REJECTED by the fresh verifier. Fix these and resubmit:\n- ${lastReasons.join('\n- ')}\n` : '') +
        `Deliver: the issue-derived repro (captured red), the falsifiable hypothesis + competing causes, the chosen fix layer with why, file-by-file changes, unhappy paths, a test strategy proving behavior, a coverage argument.`,
        debugPlanPath),
      { label: `${feature.id} debug-plan #${attempts}`, phase: ph, agentType: PERSONA.planner },
    )
    recordGateSpawn(feature, 'G1', PERSONA.planner, featureSpawnLog)

    const fresh = await freshVerify(feature, debugPlanPath)   // records G3, sees mission+plan only
    if (fresh.approved) {
      return {
        plan,
        ok: true,
        planPublication: fresh.planPublication,
      }
    }
    freshRejects++
    lastReasons = fresh.reasons
    if (freshRejects >= MAX_FRESH_CYCLES) {
      const ruling = await arbiter(`Debug fix for ${feature.id} had its plan REJECTED by an independent fresh verifier ${freshRejects}x. Read the candidate at "${debugPlanPath}". Reasons:\n- ${lastReasons.join('\n- ')}\nDecide: build it, or send back for re-scope?`, ph)
      if (ruling.proceed) continue
      freshRejects = 0
    }
  }
  return { plan, ok: false, reasons: lastReasons.length ? lastReasons : ['debug fresh-verify budget exhausted'] }
}

// F-DEPTH G3.5 DEPTH-LOCK runner. AFTER the plan is frozen (the fix LAYER is
// known) and BEFORE G4, a debug feature spawns the ap-depth-prober L4 leaf with
// the issue text + repo + the PROPOSED fix layer LAST/sealed. The prober derives
// D1-D5 from the issue text FIRST, blind to the proposed layer, and reports its
// independently-derived D3 deepest-cause + whether the D4 repro is RED unpatched.
// The verdict is RECOMPUTED via depthLockPass (never trusted from the string):
// PASS only when frozenLayer === d3 AND reproRed === true. A FAIL returns
// { pass:false, depthMiss:true, reasons } so the supervisor re-enters at G1 with
// `depth-miss` (mirrors the BLOCKED_AT_PLAN shape). Proportionality-narrow: only
// debug features reach here; the gate is never skipped at any tier (light single
// prober at T0/T1, adversarial at T2/T3) - speed is never bought by thinning it.
async function depthLock(feature, plan, frozenLayer) {
  assertExecLevel(PERSONA.depthProber, `${feature.id} depth-lock`)
  const prober = await agent(
    compactBrief('a depth prober; you have seen NO prior discussion. Derive the bug\'s deepest-cause function from the ISSUE TEXT alone, BLIND to the proposed fix layer; default-FAIL',
      `YOUR FEATURE: ${feature.name} (${feature.id}), boundary: ${feature.boundary}\nPLAYBOOK TAG: debug\n` +
      `Derive, from the ISSUE TEXT + the REAL code FIRST (blind to the proposed fix layer): ` +
      `D1 the HOME FUNCTION where the behavior is DECIDED (file:function + why); ` +
      `D2 a WHOLE-CONTRACT INPUT-CLASS table (every input/param/branch/invariant; the gold-revealing class MUST appear, issue-derived); ` +
      `D3 the single DEEPEST point that fixes ALL D2 classes (flag any shallower layer verbatim "SHALLOW - deeper cause at <file:function>"); ` +
      `D4 the most adversarial maintainer assertion from the issue TITLE+TEXT alone - a binding repro you may NOT phrase in terms of the patch's own mechanism, proven RED against UNPATCHED code (capture the real red output). ` +
      `ONLY THEN read the PROPOSED FIX LAYER (sealed, last) to compare against your own D3 - never to seed D1-D3.\n\n` +
      `PROPOSED FIX LAYER (read LAST, for comparison only): ${frozenLayer || '(none recorded)'}\n\n` +
      `Report d3DeepestCause (file.py::function) and reproRed (true only with captured red on record). VERDICT PASS only when the proposed layer EQUALS your D3 AND the D4 repro is RED unpatched; else REJECT - depth-miss.`,
      `${ARTIFACT_DIR}/${feature.id}-depth-lock.md`),
    { label: `${feature.id} depth-lock`, phase: 'Plan', schema: DEPTH_SCHEMA, agentType: PERSONA.depthProber },
  )
  recordGateSpawn(feature, 'G3.5', PERSONA.depthProber, featureSpawnLog)
  if (canaryTripped(prober)) {
    canaryTrips++
    log(`CANARY: nonce mismatch at ${feature.id} depth-lock; treating verdict as depth-miss`)
    return { pass: false, depthMiss: true, reasons: ['canary trip: brief nonce mismatch at DEPTH-LOCK'] }
  }
  const d3 = prober && typeof prober.d3DeepestCause === 'string' ? prober.d3DeepestCause : ''
  const reproRed = prober && prober.reproRed === true
  const pass = depthLockPass(frozenLayer, d3, reproRed)
  if (pass) return { pass: true, d3, reproRed }
  const reasons = (prober && Array.isArray(prober.reasons) && prober.reasons.length)
    ? prober.reasons
    : [`depth-miss: frozen fix-layer "${frozenLayer}" != independently-derived deepest-cause "${d3 || '(none)'}"${reproRed ? '' : '; D4 repro not proven RED unpatched'}`]
  return { pass: false, depthMiss: true, d3, reproRed, reasons }
}

// extractFixLayer (F-DEPTH): pull the chosen fix LAYER (file.py::function) from a
// frozen plan body. The debug planner records it as "fix layer ... <file>::<fn>"
// or a bare file.py::function token. Returns '' when none is found (the prober
// then compares against an empty proposed layer - a default-FAIL depth-miss).
const FIXLAYER_TOKEN_RE = /([A-Za-z0-9_./-]+\.py::[A-Za-z0-9_.]+)/
function extractFixLayer(plan) {
  if (typeof plan !== 'string') return ''
  const m = FIXLAYER_TOKEN_RE.exec(plan)
  return m ? m[1] : ''
}

// resolvePlan: the single plan-entry funnel all three runFeatureInner sites use,
// so a debug-T1 routes through debugFreshVerify (G1+G3) wherever a plan is
// resolved - the freshVerifyDebug flag is CONSUMED here, never dead. A
// plan-bearing tier (T2/T3) keeps planUntilApproved; a debug feature on a
// freshVerifyDebug tier gets the fresh-verify; everything else takes the
// synthetic no-plan placeholder exactly as before. F-DEPTH: AFTER the plan is
// frozen (the fix layer is known) and BEFORE G4, a debug feature runs G3.5
// DEPTH-LOCK; a depth-miss returns ok:false depthMiss:true so the supervisor
// re-enters at G1 (no fix is implemented over a wrong-layer plan).
async function resolvePlan(feature, tier, tierCfg) {
  let planResult
  if (feature.roadmapPlan && feature.requiresDetailedPlan !== true && feature.tag !== 'debug') {
    planResult = { plan: feature.roadmapPlan, ok: true }
  } else if (tierCfg.plan) planResult = await planUntilApproved(feature, tierCfg)
  else if (debugFreshVerifyRequired(feature, tierCfg)) planResult = await debugFreshVerify(feature, tier, tierCfg)
  else planResult = { plan: `(${tier} tier: no separate plan phase; the implementer works directly from the mission and the feature boundary "${feature.boundary}")`, ok: true }
  if (!planResult.ok) return planResult
  const lock = await lockDebugPlan(feature, planResult.plan)
  if (!lock.ok) return { ...planResult, ok: false, depthMiss: true, reasons: lock.reasons }
  return planResult
}

// lockDebugPlan (F-DEPTH G3.5, shared by resolvePlan AND the resume branches): run
// DEPTH-LOCK for a debug feature against a (fresh or resume-frozen) plan. A pass
// records the LIVE depth-lock result on the feature reference that flows into every
// result -> summary.features -> the SCRIBE GATELOG brief, which emits `fixlayer=`/
// `tag=debug` onto the real G3.5 row + FEATURE-META BY CONSTRUCTION (plan R1). This
// is what gives depthLockFindings ARM A/B/C real inputs on a real run, and what
// closes the RESUME BYPASS: a debug feature resumed past plan-freeze re-runs the gate
// rather than sealing DONE with DEPTH-LOCK skipped. A non-debug feature is a no-op.
async function lockDebugPlan(feature, plan) {
  if (!feature || feature.tag !== 'debug') return { ok: true }
  const frozenLayer = extractFixLayer(plan)
  const lock = await depthLock(feature, plan, frozenLayer)
  if (!lock.pass) return { ok: false, reasons: lock.reasons }
  feature.depthLock = { frozenLayer, d3: lock.d3 || '', reproRed: lock.reproRed === true }
  return { ok: true }
}

function diffScope(feature) {
  return `Scope your inspection to this feature's boundary (${feature.boundary}); run \`git diff -- <those paths>\` so you review THIS feature, not work from parallel features on the shared tree.`
}

// Gates receive the same compact roadmap and mission pointers. A separate
// context-pack worker would add a full agent round trip before useful work; each
// gate reads only the boundary evidence it needs directly.
function packPointer() {
  return ''
}

// A panel/sweep reason "names a blocker" if it cites a P0 or P1. Such a reason
// is never arbitrable into DONE (Pillar B M1/N2): the arbiter may log it
// PARTIAL but can never declare an open P0/P1 shippable.
function panelNamesBlocker(reasons) {
  return (reasons || []).some(r => /\bP0\b|\bP1\b/i.test(String(r)))
}

// === ADAPTIVE-SCOPE-SLICE:START - pure topology and roadmap derivation. ===
const MAX_FEATURES = 12            // refuse runaway roadmap decomposition (cost guard)
const SCOPE_TOPOLOGY = Object.freeze({
  bounded: Object.freeze({ profile: 'bounded', scouts: 0, totalAgents: 3, sequentialRounds: 2 }),
  'multi-surface': Object.freeze({ profile: 'multi-surface', scouts: 2, totalAgents: 5, sequentialRounds: 3 }),
  'unusually-large': Object.freeze({ profile: 'unusually-large', scouts: 5, totalAgents: 9, sequentialRounds: 4 }),
})

function scopeTopology(profile) {
  return { ...(SCOPE_TOPOLOGY[profile] || SCOPE_TOPOLOGY['multi-surface']) }
}

function sameMissionPointer(actual, expected) {
  if (!expected) return true
  return actual.path === expected.path && actual.hash === expected.hash &&
    actual.bytes === expected.bytes && actual.nonce === expected.nonce
}

function validateRoadmapStructure(roadmap, expectedMissionPointer) {
  const items = roadmap && Array.isArray(roadmap.items) ? roadmap.items : []
  if (items.length === 0) return ['roadmap has no items']
  if (items.length > MAX_FEATURES) {
    return [`roadmap has ${items.length} items, exceeding the supported limit of ${MAX_FEATURES} - split the mission into separate runs instead of dropping lanes`]
  }
  const mission = roadmap && roadmap.missionPointer
  if (!mission || typeof mission.path !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(mission.hash || '') ||
      !Number.isInteger(mission.bytes) || mission.bytes < 1 || typeof mission.nonce !== 'string' || mission.nonce === '') {
    return ['roadmap mission pointer has no complete path/hash/bytes/nonce binding']
  }
  if (!sameMissionPointer(mission, expectedMissionPointer)) return ['roadmap mission pointer does not match the canonical prompt ledger']
  if (typeof roadmap.repositoryIntel !== 'string' || roadmap.repositoryIntel.trim() === '') return ['roadmap has no repository intelligence']
  if (!Array.isArray(roadmap.toolDecisions) || roadmap.toolDecisions.length === 0) return ['roadmap has no tool decisions']
  if (!Array.isArray(roadmap.frameworkDecisions) || roadmap.frameworkDecisions.length === 0) return ['roadmap has no framework decisions']
  if (roadmap.scopeProfile === 'unusually-large' &&
      (typeof roadmap.escalationReason !== 'string' || roadmap.escalationReason.trim() === '')) {
    return ['unusually-large scope has no concrete escalation reason']
  }
  const ids = new Set()
  const boundaries = new Map()
  for (const item of items) {
    const id = item && typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '') return ['roadmap item has no stable id']
    if (ids.has(id)) return [`roadmap has duplicate item id ${id}`]
    ids.add(id)
    if (typeof item.framework !== 'string' || item.framework.trim() === '') return [`${id} has no framework`]
    const boundary = typeof item.boundary === 'string' ? item.boundary.trim() : ''
    if (boundary === '') return [`${id} has no owned boundary`]
    const owner = boundaries.get(boundary)
    if (owner) return [`${id} overlaps ${owner} on owned boundary ${boundary}`]
    boundaries.set(boundary, id)
    if (!Array.isArray(item.dependsOn)) return [`${id} dependencies are not an array`]
    if (!Number.isInteger(item.launchGroup) || item.launchGroup < 0) return [`${id} has no valid launch group`]
    if (typeof item.integrationLane !== 'string' || item.integrationLane.trim() === '') return [`${id} has no integration lane`]
    if (typeof item.coverageRequirement !== 'string' || !/95%/.test(item.coverageRequirement)) return [`${id} has no >=95% coverage contract`]
  }
  return []
}

function dependencyWaves(features) {
  const list = Array.isArray(features) ? features : []
  const byId = new Map(list.map(feature => [feature.id, feature]))
  const pending = new Set(byId.keys())
  const completed = new Set()
  const waves = []
  for (const feature of list) {
    for (const dependency of feature.dependsOn || []) {
      if (!byId.has(dependency)) throw new TypeError(`${feature.id} dependsOn unknown feature "${dependency}"`)
    }
  }
  while (pending.size) {
    const ready = list.filter(feature => pending.has(feature.id) &&
      (feature.dependsOn || []).every(dependency => completed.has(dependency)))
    if (ready.length === 0) throw new TypeError(`dependsOn cycle: ${[...pending].join(' -> ')}`)
    waves.push(ready)
    for (const feature of ready) {
      pending.delete(feature.id)
      completed.add(feature.id)
    }
  }
  return waves
}

function roadmapPointer(binding) {
  const path = binding && binding.roadmapPath
  const hash = binding && binding.roadmapHash
  const bytes = binding && binding.roadmapBytes
  const nonce = binding && binding.runNonce
  if (typeof path !== 'string' || path === '' || !/^sha256:[a-f0-9]{64}$/.test(hash || '') ||
      !Number.isInteger(bytes) || bytes < 1 || typeof nonce !== 'string' || nonce === '') {
    throw new TypeError('roadmap pointer has no complete cryptographic binding')
  }
  return `ROADMAP POINTER: path=${path} hash=${hash} bytes=${bytes} nonce=${nonce}`
}

function roadmapPlan(item) {
  return [
    `Done means: ${item.doneMeans}`,
    `Implementation: ${(item.implementationSteps || []).join('; ')}`,
    `Unhappy paths: ${(item.unhappyPaths || []).join('; ')}`,
    `Tests first: ${(item.testsFirst || []).join('; ')}`,
    `Verification: ${(item.verification || []).join('; ')}`,
  ].join('\n')
}

function deriveRoadmapFeatures(roadmap) {
  return (roadmap.items || []).map((item, index) => ({
    id: item.id || `F${index + 1}`,
    name: item.title,
    category: item.category || 'backend',
    tag: item.tag,
    tier: ['T0', 'T1', 'T2', 'T3'].includes(item.tier) ? item.tier : 'T2',
    framework: item.framework,
    boundary: item.boundary,
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [],
    phase: Number.isInteger(item.launchGroup) ? item.launchGroup : 0,
    acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria : [],
    requiresDetailedPlan: item.requiresDetailedPlan === true,
    roadmapPlan: roadmapPlan(item),
    roadmapPath: roadmap.roadmapPath,
    roadmapHash: roadmap.roadmapHash,
    roadmapBytes: roadmap.roadmapBytes,
  }))
}

function scoutEvidencePointer(index, artifactDir) {
  return `${artifactDir}/roadmap-scout-${index + 1}.md`
}

function scoutEvidencePointers(reports, artifactDir) {
  return (Array.isArray(reports) ? reports : []).map((report, index) => {
    const isValidHash = report && typeof report.evidenceHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(report.evidenceHash)
    const isValidBytes = report && Number.isInteger(report.evidenceBytes) && report.evidenceBytes > 0
    const hash = isValidHash ? report.evidenceHash : '(missing)'
    const bytes = isValidBytes ? report.evidenceBytes : '(missing)'
    return `- scout ${index + 1}: read "${scoutEvidencePointer(index, artifactDir)}" hash=${hash} bytes=${bytes}`
  }).join('\n')
}

function validateScoutReports(
  reports,
  expectedCount,
  runNonce,
  expectedResearch = [],
) {
  const list = Array.isArray(reports) ? reports : []
  const reasons = []
  for (let index = 0; index < expectedCount; index++) {
    const report = list[index]
    if (!report || typeof report !== 'object') {
      reasons.push(`scout ${index + 1} returned no structured evidence report`)
      continue
    }
    if (typeof runNonce === 'string' && runNonce !== '' && report.nonce !== runNonce) {
      reasons.push(`scout ${index + 1} canary nonce is missing or mismatched`)
    }
    if (typeof report.evidenceHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(report.evidenceHash)) {
      reasons.push(`scout ${index + 1} evidence hash is missing or malformed`)
    }
    if (!Number.isInteger(report.evidenceBytes) || report.evidenceBytes < 1) {
      reasons.push(`scout ${index + 1} evidence byte length is missing or invalid`)
    }
    const hasResearchExpectation =
      expectedResearch.length > index
    const mustResearch = expectedResearch[index] === true
    if (
      hasResearchExpectation &&
      report.researchRequired !== mustResearch
    ) {
      reasons.push(
        `scout ${index + 1} research requirement is mismatched`,
      )
      continue
    }
    if (hasResearchExpectation) {
      reasons.push(...researchProgressReasons(report).map(
        reason => `scout ${index + 1} ${reason}`,
      ))
    }
    if (mustResearch) {
      reasons.push(...researchReceiptReasons(report).map(
        reason => `scout ${index + 1} ${reason}`,
      ))
    }
  }
  return reasons
}
// === ADAPTIVE-SCOPE-SLICE:END ===

// ----- ADAPTIVE SCOPE-AND-ROADMAP ----------------------------------------
// Every run starts with one useful author that writes a complete executable
// ROADMAP.md. Multi-surface work adds retained complementary evidence before
// concurrent independent assurance; unusually-large work alone pays a separate
// synthesis round. Capability failure stops before any scout or build dispatch.
const ROADMAP_OUTPUT_CONTRACT =
  `Write the candidate to "${ARTIFACT_DIR}/ROADMAP.md" and copy those exact bytes atomically to the canonical root "${LEDGER_DIR}/ROADMAP.md". Report structured capability {run, read, write, evidence}, resolvedModel, effortStatus, promptLedgerPath, and missionPointer {path, hash, bytes, nonce}. ` +
  `Include repositoryIntel, concrete toolDecisions, frameworkDecisions, and for every item: id, title, category, optional tag, tier, selected framework leaf, owned boundary, dependencies, launchGroup, integrationLane, doneMeans, implementationSteps, positive acceptanceCriteria, unhappyPaths, testsFirst, real verification commands/discovery, coverageRequirement explicitly requiring >=95% changed-line and touched-module coverage, and requiresDetailedPlan. ` +
  `Set scopeProfile to bounded, multi-surface, or unusually-large. Use unusually-large only with a concrete escalationReason. Order by dependency; no time estimates. Append one SCOPE-CANDIDATE line to "${LEDGER_DIR}/GATELOG.md" with path/hash/bytes/nonce and candidate source; create no other root governance file. After atomically writing both roadmap copies, report the candidate roadmapPath, its SHA-256 roadmapHash, and UTF-8 roadmapBytes.`

async function assureRoadmap(cycle, roadmap, scouts) {
  const pointer = roadmapPointer({
    roadmapPath: roadmap.roadmapPath,
    roadmapHash: roadmap.roadmapHash,
    roadmapBytes: roadmap.roadmapBytes,
    runNonce: RUN_NONCE,
  })
  const evidencePointers = scouts.length
    ? `\nRetained scout evidence (verify hashes and lengths before use):\n${scoutEvidencePointers(scouts, ARTIFACT_DIR)}`
    : ''
  const reviewThunk = () => agent(
    compactBrief('an independent roadmap reviewer',
      `${pointer}\nRead and hash-check the candidate before judging.${evidencePointers} SMASH only with specific affected item ids or structural gaps; PASS only when mission coverage, retained evidence, frameworks, boundaries, tests, and dependency lanes are executable. Append one ROADMAP-REVIEW line to "${LEDGER_DIR}/GATELOG.md" with path/hash/bytes/nonce and your PASS/SMASH verdict. Append only; do not rewrite the log or roadmap and create no other governance file.`,
      null),
    { label: `roadmap-review #${cycle}`, phase: 'Scope', schema: REVIEW_SCHEMA, agentType: PERSONA.reviewer },
  )
  const freshThunk = () => agent(
    compactBrief('a blind roadmap fresh verifier',
      `${pointer}\nRead only the original mission, real repository, hash-checked candidate, and raw evidence pointers below.${evidencePointers} APPROVE only if the candidate is consistent with that evidence and executing it would fully satisfy the mission; otherwise name the affected item ids. On APPROVE, append one PRE-BUILD-APPROVED line to "${LEDGER_DIR}/GATELOG.md" with transition=roadmap-to-implementation feature=RUN path=${roadmap.roadmapPath} hash=${roadmap.roadmapHash} bytes=${roadmap.roadmapBytes} nonce=${RUN_NONCE} gate=ROADMAP-APPROVAL persona=${PERSONA.freshVerifier} verdict=APPROVE. Append only; flush the write before returning. Return publication with the exact artifact and ledger bindings, exact ledgerRow bytes and their SHA-256, artifactExists=true only after re-reading the final non-.tmp roadmap, and ledgerRowDurable=true only after re-reading the appended row. On REJECT append the same binding with verdict=REJECT but return no approval publication. Do not copy or edit the roadmap and create no other governance file.`,
      null),
    { label: `roadmap-fresh-verify #${cycle}`, phase: 'Scope', schema: FRESH_SCHEMA, agentType: PERSONA.freshVerifier },
  )
  return fanout([reviewThunk, freshThunk], true, `roadmap-assurance-${cycle}`)
}

function roadmapAuthorThunk(capabilityInstruction) {
  return () => agent(
    brief('the useful-first roadmap author; inspect the real repository and produce the executable roadmap',
      `This is the first useful worker, not a ceremony probe. Before any other work, create "${LEDGER_DIR}/PROMPTS.txt" atomically with the exact mission under an "=== PROMPT 1 ===" header, and append PRIOR_STEERS as later numbered prompt blocks when present. ${capabilityInstruction} Then inspect the repository and produce the complete roadmap. ${ROADMAP_OUTPUT_CONTRACT}`,
      `${ARTIFACT_DIR}/ROADMAP.md`),
    { label: 'roadmap author', phase: 'Scope', schema: ROADMAP_SCHEMA, agentType: PERSONA.scoper },
  )
}

function roadmapScoutThunks(profile, startIndex = 0) {
  const endIndex = scopeTopology(profile).scouts
  return SCOPING_ANGLES.slice(startIndex, endIndex).map((angle, offset) => {
    const index = startIndex + offset
    return () => agent(
      compactBrief(`a retained roadmap scout for ${angle.label}`,
        `Inspect only this complementary angle: ${angle.label}. Write concise raw evidence and concrete roadmap corrections to "${scoutEvidencePointer(index, ARTIFACT_DIR)}". Report its SHA-256 hash and UTF-8 byte length. Set researchRequired=${angle.research}. ${angle.research ? `If current external facts are necessary, use at most 6 searches and 6 fetches, write the named usable output first, and write one JSON receipt row per call to "${scoutEvidencePointer(index, ARTIFACT_DIR)}.receipts.json". Every row must contain kind (search, fetch, or usable-inspection), request, source URL/path, and its material contribution. Re-read the final receipt artifact and report receiptArtifact {path, hash, bytes} plus exact claimed/receipted search, fetch, and usable-inspection counts and materializedOutputs. Zero output, a missing receipt artifact, or unreconciled rows is NO-USEFUL-OUTPUT; do not broaden or repeat the wave.` : 'Use repository evidence only. Report zero search/fetch/usable-inspection counts and materializedOutputs as the count of concrete repository findings written.'} Do not read or modify ROADMAP.md, do not write a separate governance artifact, and do not assume another scope worker's findings.`,
        `${scoutEvidencePointer(index, ARTIFACT_DIR)}`),
      { label: `roadmap scout ${angle.key}`, phase: 'Scope', schema: SCOUT_SCHEMA, agentType: PERSONA.scoper },
    )
  })
}

function capabilityFailure(roadmap) {
  const capability = roadmap && roadmap.capability
  if (!capability || capability.run !== true || capability.read !== true || capability.write !== true) {
    return `bootstrap capability failed: ${capability && capability.evidence || 'structured RUN/READ/WRITE evidence missing'}`
  }
  if (roadmap.promptLedgerPath !== `${LEDGER_DIR}/PROMPTS.txt`) {
    return `prompt ledger was not created at ${LEDGER_DIR}/PROMPTS.txt`
  }
  return ''
}

async function firstRoadmapPass(capabilityInstruction) {
  return { roadmap: await roadmapAuthorThunk(capabilityInstruction)(), scouts: [] }
}

async function scopeAndRoadmap() {
  phase('Scope')
  const startedAt = Date.now()
  let roadmap
  let profile = EXPAND_MISSION ? 'multi-surface' : 'bounded'
  let lastReasons = []
  let scouts = []
  let dispatchedAgents = 0
  let dependencyRounds = 0
  const metrics = () => ({
    profile,
    agents: dispatchedAgents,
    rounds: dependencyRounds,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  })

  for (let cycle = 1; cycle <= MAX_SCOPE_CYCLES; cycle++) {
    if (!roadmap) {
      const capabilityInstruction = capabilityAttested
        ? `The supervisor supplied a trusted RUN/READ/WRITE attestation. Set capability to run/read/write=true and evidence="trusted supervisor attestation"; do not repeat the scratch probe.`
        : `Before repository inspection, prove shell execution and file read/write with a disposable scratch file. Set capability from the observed checks; do not claim success on a denied operation.`
      const provisionalProfile = profile
      const firstPass = await firstRoadmapPass(capabilityInstruction)
      dispatchedAgents++
      dependencyRounds++
      roadmap = firstPass.roadmap
      scouts = firstPass.scouts
      if (canaryTripped(roadmap)) {
        canaryTrips++
        return { approved: false, reasons: ['roadmap author canary nonce is missing or mismatched'], metrics: metrics() }
      }
      const failure = capabilityFailure(roadmap)
      if (failure) return { approved: false, capabilityFailed: true, reasons: [failure], metrics: metrics() }
      profile = roadmap && roadmap.scopeProfile || provisionalProfile
      if (profile !== provisionalProfile && profile !== 'unusually-large') scouts = []
    }

    const structuralReasons = validateRoadmapStructure(roadmap, missionPointerBinding())
    if (roadmap && roadmap.hasTimeEstimates === true) structuralReasons.push('roadmap contains time estimates')
    if (structuralReasons.length) return { approved: false, reasons: structuralReasons, metrics: metrics() }

    const topology = scopeTopology(profile)
    if (topology.scouts > scouts.length) {
      const scoutThunks = roadmapScoutThunks(profile, scouts.length)
      const additionalScouts = await fanout(scoutThunks, true, 'roadmap-scouts')
      dispatchedAgents += scoutThunks.length
      dependencyRounds++
      scouts = [...scouts, ...additionalScouts]
    }
    if (topology.scouts > 0) {
      const expectedResearch = SCOPING_ANGLES
        .slice(0, topology.scouts)
        .map(angle => angle.research)
      const scoutReasons = validateScoutReports(
        scouts,
        topology.scouts,
        RUN_NONCE,
        expectedResearch,
      )
      if (scoutReasons.length) return { approved: false, reasons: scoutReasons, metrics: metrics() }
    }
    if (profile === 'unusually-large') {
      roadmap = await agent(
        compactBrief('the roadmap synthesizer',
          `Update the one canonical roadmap at "${ARTIFACT_DIR}/ROADMAP.md" using only the retained evidence artifacts below. Verify each report's evidenceHash and evidenceBytes before using it. Do not invent evidence for a missing or mismatched scout.\n\nSCOUT EVIDENCE POINTERS:\n${scoutEvidencePointers(scouts, ARTIFACT_DIR)}\n\n${ROADMAP_OUTPUT_CONTRACT}`,
          `${ARTIFACT_DIR}/ROADMAP.md`),
        { label: `roadmap synthesis #${cycle}`, phase: 'Scope', schema: ROADMAP_SCHEMA, agentType: PERSONA.synthesizer },
      )
      dispatchedAgents++
      dependencyRounds++
      if (canaryTripped(roadmap)) {
        canaryTrips++
        return { approved: false, reasons: ['roadmap synthesizer canary nonce is missing or mismatched'], metrics: metrics() }
      }
    }

    const [review, fresh] = await assureRoadmap(cycle, roadmap, scouts)
    dispatchedAgents += 2
    dependencyRounds++
    if (canaryTripped(review) || canaryTripped(fresh)) {
      canaryTrips += Number(canaryTripped(review)) + Number(canaryTripped(fresh))
      lastReasons = [
        ...(canaryTripped(review) ? ['roadmap reviewer canary nonce is missing or mismatched'] : []),
        ...(canaryTripped(fresh) ? ['roadmap fresh verifier canary nonce is missing or mismatched'] : []),
      ]
    } else if (review.verdict === 'PASS' && fresh.verdict === 'APPROVE') {
      const roadmapApproval = requireDurablePublication(
        fresh.publication,
        publicationExpected(
          'roadmap-to-implementation',
          roadmap.roadmapPath,
          roadmap.roadmapHash,
          roadmap.roadmapBytes,
          'ROADMAP-APPROVAL',
          PERSONA.freshVerifier,
          'APPROVE',
          'RUN',
        ),
        'roadmap-to-implementation',
      )
      return {
        approved: true,
        roadmap,
        roadmapApproval,
        features: deriveRoadmapFeatures(roadmap).map(feature => ({
          ...feature,
          roadmapApproval,
        })),
        topology,
        metrics: metrics(),
      }
    } else {
      lastReasons = [
        ...((review && review.reasons) || ['roadmap reviewer returned no verdict']),
        ...((fresh && fresh.reasons) || ['roadmap fresh verifier returned no verdict']),
      ]
    }
    if (cycle === MAX_SCOPE_CYCLES) break
    roadmap = await agent(
      compactBrief('the roadmap repair author',
        `Repair only the named affected items in "${ARTIFACT_DIR}/ROADMAP.md"; retain valid repository evidence.${scouts.length ? ` Verify and reuse the retained scout evidence below; do not invent or replace it.\n\nSCOUT EVIDENCE POINTERS:\n${scoutEvidencePointers(scouts, ARTIFACT_DIR)}` : ''}\n\nReasons:\n- ${lastReasons.join('\n- ')}\n${ROADMAP_OUTPUT_CONTRACT}`,
        `${ARTIFACT_DIR}/ROADMAP.md`),
      { label: `roadmap repair #${cycle}`, phase: 'Scope', schema: ROADMAP_SCHEMA, agentType: PERSONA.synthesizer },
    )
    dispatchedAgents++
    dependencyRounds++
    if (canaryTripped(roadmap)) {
      canaryTrips++
      return { approved: false, reasons: ['roadmap repair author canary nonce is missing or mismatched'], metrics: metrics() }
    }
  }
  return { approved: false, reasons: lastReasons, metrics: metrics() }
}


// The harness has no fs binding (it runs in the workflow sandbox), so frontier
// detection goes through a single read-only probe agent. A resumed run reuses
// prior -vN artifacts instead of clobbering them: a feature that already froze
// its plan skips planning; one that already passed verify skips straight to the
// (cheap, re-confirming) sign-off panel. A missing dir or failed probe yields
// the all-false default, so a fresh run is byte-for-byte identical to today.
const RESUME_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [
    'planFinalPresent',
    'verifyPassPresent',
    'planPublication',
    'verifyPublication',
  ],
  properties: {
    planFinalPresent: { type: 'boolean', description: 'true only if <id>-plan-final.md exists and is non-empty' },
    verifyPassPresent: { type: 'boolean', description: 'true only if a <id>-verify-vN.md exists whose verdict is VERIFIED' },
    partialGatePresent: { type: 'boolean', description: 'true if an <id>-impl-vN.md exists with NO matching <id>-impl-review-vN / <id>-verify-vN - a mid-gate crash; the gate is NOT done and must be re-run as a fresh -v(N+1)' },
    frozenPlan: { type: 'string', description: 'verbatim contents of <id>-plan-final.md if present, else empty' },
    planPublication: PUBLICATION_SCHEMA,
    lastVerifyEvidence: { type: 'string', description: 'the evidence line from the passing verify artifact if present, else empty' },
    verifyPublication: PUBLICATION_SCHEMA,
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}
async function detectFrontier(feature) {
  const probe = await agent(
    compactBrief('a resume probe; read the artifact dir, report what is already frozen, change nothing',
      `Check "${ARTIFACT_DIR}" for this feature's checkpoints. Report planFinalPresent (does a non-empty "${feature.id}-plan-final.md" exist?), verifyPassPresent (does any "${feature.id}-verify-v*.md" exist whose JSON/verdict says VERIFIED?), partialGatePresent (does an "${feature.id}-impl-v*.md" exist with NO matching "-impl-review-v*"/"-verify-v*" - a half-finished gate from a mid-gate crash?), and copy the frozen plan + last passing evidence verbatim if present. Treat ANY lingering "*.tmp" or an empty/unparseable final file as ABSENT (a mid-write crash; never trust a partial). Read only; never write, never re-run a gate.`,
      null),
    { label: `${feature.id} resume-probe`, phase: 'Plan', schema: RESUME_SCHEMA, agentType: PERSONA.preflight },
  )
  // FIX-09: a NULL probe falls back to a harness-built default. Mark it
  // LOCAL_SENTINEL so the canary exempts it - a default never went through a
  // spawn and has no nonce by construction; an unmarked default would false-trip.
  return probe || {
    [LOCAL_SENTINEL]: true,
    planFinalPresent: false,
    verifyPassPresent: false,
    partialGatePresent: false,
    frozenPlan: '',
    planPublication: null,
    lastVerifyEvidence: '',
    verifyPublication: null,
  }
}

async function buildUntilVerified(
  feature,
  plan,
  tier,
  tierCfg,
  planPublication,
) {
  const cfg = tierCfg || TIER_PIPELINE[DEFAULT_TIER]
  const planPath = `${ARTIFACT_DIR}/${feature.id}-plan-final.md`
  requireDurablePublication(
    feature.roadmapApproval,
    publicationExpected(
      'roadmap-to-implementation',
      feature.roadmapPath,
      feature.roadmapHash,
      feature.roadmapBytes,
      'ROADMAP-APPROVAL',
      PERSONA.freshVerifier,
      'APPROVE',
      'RUN',
    ),
    'roadmap-to-implementation',
  )
  const hasPlanGate =
    (cfg.plan === true && feature.requiresDetailedPlan === true) ||
    debugFreshVerifyRequired(feature, cfg)
  if (hasPlanGate) {
    if (!planPublication) {
      throw new TypeError(
        'BLOCKED plan-to-implementation: approved plan publication is missing',
      )
    }
    requireDurablePublication(
      planPublication,
      publicationExpected(
        'plan-to-implementation',
        planPublication.artifactPath,
        planPublication.artifactHash,
        planPublication.artifactBytes,
        planPublication.producerGate,
        planPublication.producerPersona,
        'APPROVED',
        feature.id,
      ),
      'plan-to-implementation',
    )
  }
  const approvedRoadmapPointer = roadmapPointer({
    roadmapPath: feature.roadmapPath,
    roadmapHash: feature.roadmapHash,
    roadmapBytes: feature.roadmapBytes,
    runNonce: RUN_NONCE,
  })
  const roadmapItemSpec = `${approvedRoadmapPointer}\nROADMAP ITEM: hash-check the candidate, then read ${feature.id}.`
  let implementationSpec = feature.roadmapPlan === plan && feature.requiresDetailedPlan !== true
    ? roadmapItemSpec
    : `${approvedRoadmapPointer}\nFROZEN PLAN: read "${planPath}".`
  const isCeiling = tier === 'T3' || !tier
  // The redo trigger: at the T3 ceiling the existing arbiter cadence is honored
  // verbatim (SMASH at MAX_IMPL_CYCLES, FAIL at MAX_VERIFY_CYCLES); a leaner tier
  // escalates ONE tier up once its in-tier redo budget is spent (GATES.md
  // ESCALATION). T3 never escalates - it arbitrates instead.
  const smashTrigger = isCeiling ? MAX_IMPL_CYCLES : cfg.redoBudget
  const verifyTrigger = isCeiling ? MAX_VERIFY_CYCLES : cfg.redoBudget
  const ph = 'Build'
  let attempts = 0
  let smashCycles = 0
  let verifyCycles = 0
  let lastReasons = []

  while (attempts < IMPL_ATTEMPT_BUDGET) {
    attempts++
    assertExecLevel(PERSONA.implementer, `${feature.id} implement #${attempts}`)
    const impl = await agent(
      compactBrief('an implementer, execute the approved plan exactly; top-tier code; TDD (failing test first)',
        `${implementationSpec} Read the implementation contract before editing; report PLAN-CONFLICT rather than silently diverging.\n` +
        (lastReasons.length ? `Prior attempt was rejected. Address only these named findings:\n- ${lastReasons.join('\n- ')}\n` : '') +
        `Real systems only, real test runs, real services in a test env, no mocks of the system under test, no mocked DB in integration tests. Coverage >= 95% on changed lines. ` +
        `Stay within your boundary: ${feature.boundary}. Report structured status, filesChanged, testsWritten, testEvidence, and conflictReason when status is PLAN-CONFLICT. If the item exceeds one owned executor boundary, return SPLIT-REQUEST with splitBoundaries [{boundary, dependsOn}] before editing or publication; do not spawn. A PLAN-CONFLICT or SPLIT-REQUEST must not claim COMPLETE evidence. For COMPLETE, ` +
        publicationInstruction(
          'implementation-to-review-verification',
          `${ARTIFACT_DIR}/${feature.id}-impl-v${attempts}.md`,
          'G4',
          PERSONA.implementer,
          'COMPLETE',
          feature.id,
        ) +
        packPointer(feature),
        `${ARTIFACT_DIR}/${feature.id}-impl-v${attempts}.md`),
      { label: `${feature.id} implement #${attempts}`, phase: ph, schema: IMPLEMENT_SCHEMA, agentType: PERSONA.implementer },
    )
    recordGateSpawn(feature, 'G4', PERSONA.implementer, featureSpawnLog)
    if (canaryTripped(impl)) {
      canaryTrips++
      lastReasons = ['canary trip: implementer nonce mismatch, re-running G4']
      continue
    }
    if (impl.status === 'PLAN-CONFLICT') {
      const conflictReason = typeof impl.conflictReason === 'string' && impl.conflictReason.trim() !== ''
        ? impl.conflictReason.trim()
        : 'implementer reported PLAN-CONFLICT without a reason'
      const conflictFeature = { ...feature, requiresDetailedPlan: true }
      const conflictPlan = await planUntilApproved(conflictFeature, { planLoop: true })
      if (!conflictPlan.ok) {
        return { ok: false, partial: true, reasons: [conflictReason, ...(conflictPlan.reasons || [])] }
      }
      requireDurablePublication(
        conflictPlan.planPublication,
        publicationExpected(
          'plan-to-implementation',
          conflictPlan.planPublication.artifactPath,
          conflictPlan.planPublication.artifactHash,
          conflictPlan.planPublication.artifactBytes,
          conflictPlan.planPublication.producerGate,
          conflictPlan.planPublication.producerPersona,
          'APPROVED',
          feature.id,
        ),
        'plan-to-implementation',
      )
      implementationSpec = `${approvedRoadmapPointer}\nPLAN-CONFLICT RESOLUTION: the revised G1 plan below supersedes the roadmap item where they conflict.\n${conflictPlan.plan}`
      lastReasons = [`PLAN-CONFLICT resolved through G1: ${conflictReason}`]
      continue
    }

    if (impl.status === 'SPLIT-REQUEST') {
      const splitBoundaries = Array.isArray(impl.splitBoundaries)
        ? impl.splitBoundaries.filter(item =>
            item &&
            typeof item.boundary === 'string' &&
            item.boundary.trim() !== '' &&
            Array.isArray(item.dependsOn),
          )
        : []
      if (splitBoundaries.length < 2) {
        return {
          ok: false,
          partial: true,
          splitRequest: true,
          reasons: ['SPLIT-REQUEST must name at least two disjoint implementation boundaries and their dependencies'],
        }
      }
      return {
        ok: false,
        partial: true,
        splitRequest: true,
        reasons: splitBoundaries.map(item =>
          `split boundary ${item.boundary}; dependsOn=${item.dependsOn.join(',') || 'none'}`,
        ),
      }
    }

    if (!impl.publication) {
      lastReasons = [
        'implementation publication receipt is missing',
      ]
      continue
    }
    requireDurablePublication(
      impl.publication,
      publicationExpected(
        'implementation-to-review-verification',
        `${ARTIFACT_DIR}/${feature.id}-impl-v${attempts}.md`,
        impl.publication.artifactHash,
        impl.publication.artifactBytes,
        'G4',
        PERSONA.implementer,
        'COMPLETE',
        feature.id,
      ),
      'implementation-to-review-verification',
    )

    // EDIT C (gate-DAG {G5‖G6}): G5 impl-review and G6 verify are INDEPENDENT
    // (both consume the G4 diff + plan; review reads, verify runs the tests;
    // neither reads the other's output), so they dispatch CONCURRENTLY via the
    // existing fanout helper - concurrent in every mode, with TOKENSAVER bounded
    // by its six-live wave cap. The implement≠verify keystone guard
    // (assertDistinctImplementVerify) is called BEFORE the G6 thunk is built -
    // UNCHANGED. NO short-circuit/cancel (§3(a) REJECT): both siblings run to
    // completion and recordGateSpawn fires for BOTH even when G5 SMASHes; the
    // loser is discarded at the join (G5-SMASH precedence).
    const isDebug = feature.tag === 'debug'
    const g5thunk = async () => agent(
      compactBrief('an implementation reviewer, you did NOT write this code',
        `${roadmapItemSpec}\n${implementationSpec}\nIMPLEMENTATION ARTIFACT: read "${ARTIFACT_DIR}/${feature.id}-impl-v${attempts}.md" and verify every claim against the real diff.\n` +
        `${diffScope(feature)} Verify complete coverage against the exact mission ledger and implementation contract, with file:line evidence. A claim with no backing diff is an automatic SMASH. Flag broken code, weak tests, or scope creep. ` +
        (isCeiling ? '' : `If this task is genuinely LARGER/RISKIER than its tier (${tier}: touches >1 subsystem, needs a real design decision, a hidden cross-cutting failure surfaced), set outOfScope=true so it climbs one tier; a fixable local defect is an ordinary SMASH, not out-of-scope. `) +
        `Return SMASH with numbered file:line reasons, or PASS only if every line is clean.` +
        packPointer(feature),
        `${ARTIFACT_DIR}/${feature.id}-impl-review-v${attempts}.md`),
      { label: `${feature.id} impl-review #${attempts}`, phase: ph, schema: REVIEW_SCHEMA, agentType: PERSONA.reviewer },
    )
    // The implement≠verify keystone: asserted BEFORE the G6 thunk is constructed.
    assertExecLevel(PERSONA.verifier, `${feature.id} verify #${attempts}`)
    assertDistinctImplementVerify(PERSONA.implementer, PERSONA.verifier, tier, `${feature.id} verify #${attempts}`)
    const g6thunk = async () => agent(
      compactBrief('a verifier, prove it works by RUNNING it, not by reading it',
        `WHAT TO VERIFY: ${feature.name} (${feature.boundary}).\n` +
        `${roadmapItemSpec}\n${implementationSpec} Map every claim to the exact mission ledger and this implementation contract.\n` +
        `IMPLEMENTATION ARTIFACT: read "${ARTIFACT_DIR}/${feature.id}-impl-v${attempts}.md" but independently reproduce its claims.\n` +
        `GROUNDED BEFORE/AFTER PROTOCOL (mandatory - DONE is recomputed from these, never from your prose verdict):\n` +
        (isDebug
          ? `1. RED BASELINE: run the issue's reproduction case against the CURRENT (pre-fix or stashed-fix) code and capture the VERBATIM failing output. A debug fix with no proven red baseline is INVALID - set reproWasRed=false and verdict FAILED if you cannot show the bug failing first.\n`
          : `1. BASELINE: establish the target behavior's current state with a real run; set reproWasRed accordingly (true only if there is a genuine failing case you captured).\n`) +
        `2. REGRESSION BASELINE: run the FULL pre-existing test file(s) of every TOUCHED module AND its direct dependents; record which were GREEN before the change. Report the exact command in testCommand.\n` +
        `3. AFTER THE FIX: re-run both. The repro/target must now be GREEN (set reproNowGreen). Re-run the same pre-existing tests; ANY test that was green before and is red now is a regression - list its id in preExistingRegressions. A green→red flip is a hard FAILED, never acceptable.\n` +
        `Also confirm coverage >= 95% on changed lines with the coverage tool, and try to break it with bad/empty input. Put the verbatim before/after command output in evidence.\n` +
        `Report runnerKind, runnerInvocation (the exact runner command), collectedTestCount (the "collected N items" count), and assertingTestNodeId (the specific failing->passing test node).\n` +
        `A model-authored python -c "...print..." MVCE re-run is NOT acceptable evidence; on a debug verify, no real test-runner invocation, zero collected tests, or no named asserting test is recomputed to FAILED.\n` +
        `On a debug verify, prove the authored asserting test RED on a git-stashed clean tree (\`git stash\` -> run -> assert red -> \`git stash pop\`) and report redBaselineStashGated; reading and RUNNING the repo's own existing tests and authoring a scratch repro are always permitted even when the mission forbids EDITING the repo's test files.\n` +
        `Report inputClassesCovered (distinct input forms the repro+fix exercise) and branchCoveragePercent (branch coverage on changed lines); on a debug verify, fewer than 2 input classes or branch coverage below the branch floor is fed back to G4 to raise.\n` +
        (isCeiling ? '' : `If verifying reveals the task is LARGER/RISKIER than its tier (${tier}: a hidden cross-cutting failure, a real design decision), set outOfScope=true so it climbs one tier; a plain failing test is an ordinary FAILED. `) +
        `Return VERIFIED only when reproNowGreen=true AND preExistingRegressions is empty${isDebug ? ' AND reproWasRed=true' : ''}; otherwise FAILED with the failing evidence. The harness RECOMPUTES the verdict from these fields - a VERIFIED that contradicts them is overridden to FAILED. If VERIFIED, ` +
        publicationInstruction(
          'verification-to-signoff',
          `${ARTIFACT_DIR}/${feature.id}-verify-v${attempts}.md`,
          'G6',
          PERSONA.verifier,
          'VERIFIED',
          feature.id,
        ) + '\n' +
        packPointer(feature),
        `${ARTIFACT_DIR}/${feature.id}-verify-v${attempts}.md`),
      { label: `${feature.id} verify #${attempts}`, phase: ph, schema: VERIFY_SCHEMA, agentType: PERSONA.verifier },
    )
    const [review, verify] = await fanout([g5thunk, g6thunk], MODE_CFG.parallelFeatures)
    recordGateSpawn(feature, 'G5', PERSONA.reviewer, featureSpawnLog)
    recordGateSpawn(feature, 'G6', PERSONA.verifier, featureSpawnLog)

    if (review && Array.isArray(review.suggestions)) {
      for (const s of review.suggestions) allSuggestions.push(`${feature.id} (${ph}): ${s}`)
    }
    if (canaryTripped(review)) {
      canaryTrips++
      log(`CANARY: nonce mismatch at ${feature.id} impl-review #${attempts}; treating verdict as untrusted (SMASH)`)
      lastReasons = ['canary trip: brief nonce mismatch, re-running the impl gate']
      continue
    }

    // G5-SMASH precedence: a not-PASS impl-review loops the implementer and the
    // concurrently-run G6 verify result is DISCARDED at the join (never consumed
    // downstream - no advance to G7). Both siblings still ran to completion.
    if (!review || review.verdict !== 'PASS') {
      smashCycles++
      lastReasons = (review && review.reasons) || ['reviewer returned no usable verdict']
      // OUT-OF-SCOPE: a worker flagged the task is bigger than its tier; climb now.
      if (!isCeiling && review && review.outOfScope === true) {
        log(`${feature.id}: impl-review returned OUT-OF-SCOPE at ${tier}; escalating one tier up`)
        return { ok: false, partial: true, escalate: true, reasons: [`OUT-OF-SCOPE at ${tier}: ${lastReasons.join('; ')}`] }
      }
      if (smashCycles >= smashTrigger) {
        if (!isCeiling) {
          log(`${feature.id}: impl-review SMASHED ${smashCycles}x (> ${tier} redo budget ${cfg.redoBudget}); escalating one tier up`)
          return { ok: false, partial: true, escalate: true, reasons: lastReasons }
        }
        const ruling = await arbiter(`Implementation of ${feature.id} SMASHED ${smashCycles}x (total attempts ${attempts}/${IMPL_ATTEMPT_BUDGET}). Reasons:\n- ${lastReasons.join('\n- ')}\nDecide: accept as partial, or keep iterating?`, ph)
        if (!ruling.proceed) return { ok: false, partial: true, reasons: lastReasons, arbiter: ruling.decision }
        smashCycles = 0  // arbiter granted more, but the global IMPL_ATTEMPT_BUDGET still bounds the loop
      }
      continue
    }

    // G5 PASSed - JOIN now consumes the concurrently-run G6 verify result.

    if (canaryTripped(verify)) {
      canaryTrips++
      log(`CANARY: nonce mismatch at ${feature.id} verify #${attempts}; treating verdict as FAILED`)
      verifyCycles++
      lastReasons = ['canary trip: brief nonce mismatch, re-verifying with a fresh brief']
      if (verifyCycles >= verifyTrigger) {
        if (!isCeiling) return { ok: false, partial: true, escalate: true, reasons: lastReasons }
        const ruling = await arbiter(`Verification of ${feature.id} canary-tripped ${verifyCycles}x (total attempts ${attempts}/${IMPL_ATTEMPT_BUDGET}). Decide: accept as partial, or iterate once more?`, ph)
        if (!ruling.proceed) return { ok: false, partial: true, reasons: lastReasons, arbiter: ruling.decision }
        verifyCycles = 0
      }
      continue
    }

    // GROUNDED-VERIFY RECOMPUTE (the anti-coverage-theater gate). VERIFIED is
    // NOT trusted from the verdict string. The fix must clear three real-test
    // facts: a debug fix proved a RED baseline (reproWasRed), the repro/target
    // is now GREEN (reproNowGreen), and there are ZERO pre-existing regressions
    // (a green->red flip in a touched module or its dependents - the exact
    // astropy-7606 failure the official grader caught as a PASS_TO_PASS break).
    // Any breach OVERRIDES VERIFIED -> FAILED, which loops back to G4 like any
    // other failing verify; a regressed feature thus can never reach ok:true and
    // therefore can never be DONE (the feature-status path is the DONE gate).
    if (verify && verify.verdict === 'VERIFIED') {
      const groundedReasons = groundedVerifyReasons(verify, isDebug)
      if (applyGroundedOverride(verify, groundedReasons)) {
        log(`${feature.id} verify #${attempts}: GROUNDED-VERIFY override VERIFIED->FAILED - ${groundedReasons.join('; ')}`)
      }
    }

    // SOFT rigor floors (FIX-03/FIX-15): a debug verify still claiming VERIFIED
    // after the HARD override is checked against the advisory floors. A breach is
    // fed back to G4 exactly like the COVERAGE_FLOOR below - arbitrable, verdict
    // NOT mutated, NO `GROUNDED-VERIFY override` log (that string is reserved for
    // the HARD rules). A HARD breach already flipped the verdict to FAILED above,
    // so this block is skipped on a hard-failed verify (hard wins, soft never masks).
    if (verify && verify.verdict === 'VERIFIED') {
      const softReasons = softFloorReasons(verify, isDebug)
      if (softReasons.length) {
        verifyCycles++
        lastReasons = softReasons
        if (verifyCycles >= verifyTrigger) {
          if (!isCeiling) return { ok: false, partial: true, escalate: true, reasons: lastReasons }
          const ruling = await arbiter(`Verification of ${feature.id} reported VERIFIED but a soft rigor floor was breached, ${verifyCycles}x (total attempts ${attempts}/${IMPL_ATTEMPT_BUDGET}):\n- ${lastReasons.join('\n- ')}\nDecide: accept as partial, or iterate once more?`, ph)
          if (!ruling.proceed) return { ok: false, partial: true, reasons: lastReasons, arbiter: ruling.decision }
          verifyCycles = 0
        }
        continue
      }
    }

    if (verify && verify.verdict === 'VERIFIED') {
      // VERIFIED verdict that reports a number below COVERAGE_FLOOR is treated
      // as a verification FAILURE (the floor is the mission's, not the model's).
      const cov = verify.coveragePercent
      const coverageMissing =
        typeof cov !== 'number' || !Number.isFinite(cov)
      if (coverageMissing || cov < COVERAGE_FLOOR) {
        verifyCycles++
        lastReasons = [coverageMissing
          ? `coveragePercent is missing or non-finite; report measured changed-line coverage >= ${COVERAGE_FLOOR}% and re-verify`
          : `coverage ${cov}% is below the ${COVERAGE_FLOOR}% floor; raise coverage on changed lines and re-verify`]
        if (verifyCycles >= verifyTrigger) {
          if (!isCeiling) return { ok: false, partial: true, escalate: true, reasons: lastReasons }
          const coverageLabel = coverageMissing ? 'missing/non-finite' : `${cov}%`
          const ruling = await arbiter(`Verification of ${feature.id} reported VERIFIED but coverage is ${coverageLabel} (required >= ${COVERAGE_FLOOR}%), ${verifyCycles}x (total attempts ${attempts}/${IMPL_ATTEMPT_BUDGET}). The floor and measured coverage field are not negotiable. Decide: accept as partial, or iterate once more?`, ph)
          if (!ruling.proceed) return { ok: false, partial: true, reasons: lastReasons, arbiter: ruling.decision }
          verifyCycles = 0
        }
        continue
      }
      if (!verify.publication) {
        lastReasons = [
          'verification publication receipt is missing',
        ]
        continue
      }
      const verifyPublication = requireDurablePublication(
        verify.publication,
        publicationExpected(
          'verification-to-signoff',
          `${ARTIFACT_DIR}/${feature.id}-verify-v${attempts}.md`,
          verify.publication.artifactHash,
          verify.publication.artifactBytes,
          'G6',
          PERSONA.verifier,
          'VERIFIED',
          feature.id,
        ),
        'verification-to-signoff',
      )
      return {
        ok: true,
        evidence: verify.evidence,
        coverage: cov,
        verifyPublication,
      }
    }
    // OUT-OF-SCOPE at verify: the task is bigger than its tier; climb now.
    if (!isCeiling && verify && verify.outOfScope === true) {
      log(`${feature.id}: verify returned OUT-OF-SCOPE at ${tier}; escalating one tier up`)
      return { ok: false, partial: true, escalate: true, reasons: [`OUT-OF-SCOPE at ${tier}: ${((verify && verify.reasons) || ['verify out of scope']).join('; ')}`] }
    }
    verifyCycles++
    lastReasons = (verify && verify.reasons) || ['verification failed without stated reason']
    if (verifyCycles >= verifyTrigger) {
      if (!isCeiling) {
        log(`${feature.id}: verify FAILED ${verifyCycles}x (> ${tier} redo budget ${cfg.redoBudget}); escalating one tier up`)
        return { ok: false, partial: true, escalate: true, reasons: lastReasons }
      }
      const ruling = await arbiter(`Verification of ${feature.id} FAILED ${verifyCycles}x (total attempts ${attempts}/${IMPL_ATTEMPT_BUDGET}). Evidence:\n${verify ? verify.evidence : 'none'}\nDecide: accept as partial, or iterate once more?`, ph)
      if (!ruling.proceed) return { ok: false, partial: true, reasons: lastReasons, arbiter: ruling.decision }
      verifyCycles = 0
    }
  }

  return { ok: false, partial: true, reasons: lastReasons.length ? lastReasons : ['implement attempt budget exhausted'] }
}

async function signOffPanel(feature, plan, buildResult, panelSize) {
  requireDurablePublication(
    buildResult && buildResult.verifyPublication,
    publicationExpected(
      'verification-to-signoff',
      buildResult && buildResult.verifyPublication &&
        buildResult.verifyPublication.artifactPath,
      buildResult && buildResult.verifyPublication &&
        buildResult.verifyPublication.artifactHash,
      buildResult && buildResult.verifyPublication &&
        buildResult.verifyPublication.artifactBytes,
      'G6',
      PERSONA.verifier,
      'VERIFIED',
      feature.id,
    ),
    'verification-to-signoff',
  )
  const size = Number.isInteger(panelSize) && panelSize > 0 ? panelSize : PANEL_SIZE
  assertExecLevel(PERSONA.juror, `${feature.id} sign-off panel`)
  const judges = await fanout(
    Array.from({ length: size }, (_unused, i) => async () => {
      const verdict = await agent(
        compactBrief(`an independent sign-off reviewer (juror ${i + 1}), you have seen NONE of the work that produced this`,
          `ROADMAP ITEM: read ${feature.id} in "${ARTIFACT_DIR}/ROADMAP.md".\n` +
          `FROZEN PLAN: read "${ARTIFACT_DIR}/${feature.id}-plan-final.md" when it exists.\n` +
          `IMPLEMENTATION AND VERIFICATION EVIDENCE: inspect the substantive ${feature.id} artifacts under "${ARTIFACT_DIR}/" and run any check needed; do not inherit another gate's verdict.\n` +
          `${diffScope(feature)} Judge against the exact mission ledger first and the roadmap/plan second, with the project's coding-style and testing rules as the bar. Look for anything that hurts a real user or loses data in production. ` +
          `Return PASS only if you would ship this and put your name on it; otherwise FAIL with numbered evidence-backed reasons. Approach a distinct correctness, security, or real-runtime angle.`,
          `${ARTIFACT_DIR}/${feature.id}-signoff-j${i + 1}.md`),
        { label: `${feature.id} signoff j${i + 1}`, phase: 'Sign-off', schema: PANEL_SCHEMA, agentType: PERSONA.juror },
      )
      recordGateSpawn(feature, 'G7', PERSONA.juror, featureSpawnLog)
      return verdict
    }),
    MODE_CFG.parallelPanel,
  )
  const valid = judges.filter(Boolean)
  for (const j of valid) {
    if (canaryTripped(j)) {
      canaryTrips++
      log(`CANARY: nonce mismatch at ${feature.id} sign-off juror; forcing FAIL`)
      j.verdict = 'FAIL'
      j.reasons = [...(j.reasons || []), 'canary trip: brief nonce mismatch, juror verdict untrusted']
    }
  }
  // PANEL-SIZE HARD GUARD: a unanimous PASS requires the FULL panel to convene.
  // A missing/null juror result (a juror that did not return a valid verdict for
  // ANY reason) shrinks the panel below its required size; that is an UNSIGNED-OFF
  // juror, never a pass and never arbitrable into DONE. A short panel is hard
  // non-unanimous, so finishFromBuild can never mint DONE over a panel that did
  // not fully convene.
  const panelShort = valid.length < size
  if (panelShort) {
    log(`${feature.id}: sign-off panel SHORT (${valid.length}/${size} jurors convened) - hard non-arbitrable, cannot reach DONE`)
  }
  const unanimous = valid.length === size && valid.every(j => j.verdict === 'PASS')
  const fails = valid.filter(j => j.verdict === 'FAIL').flatMap(j => j.reasons || [])
  return { unanimous, fails, jurorVerdicts: valid.map(j => j.verdict), panelShort, panelSize: size }
}

// ----- one feature, full pipeline G1..G7 --------------------------------
// runFeature is the thin OUTER funnel (B1): EVERY feature outcome - fresh,
// resumed, escalated, panel, arbiter-minted - returns through this one wrapper,
// where sealDoneProvenance reconciles a DONE against the gates that really
// spawned this session before the result may escape. runFeatureInner holds the
// unchanged pipeline body (plus the three markResumed calls on the resume
// branches). A FUTURE new DONE return inside runFeatureInner is sealed for free.
async function runFeature(feature) {
  const result = await runFeatureInner(feature)
  const tierCfg = TIER_PIPELINE[result && result.tier] || TIER_PIPELINE[DEFAULT_TIER]
  const sealed = sealDoneProvenance(
    feature,
    result,
    tierCfg,
    featureSpawnLog,
  )
  if (!sealed || sealed.status !== 'DONE') return sealed

  const verification = sealed.verifyPublication
  if (!verification) {
    throw new TypeError(
      `BLOCKED feature terminal publication: ${feature.id} ` +
      `has no durable verification receipt`,
    )
  }
  sealed.terminalPublication = requireDurablePublication(
    verification,
    publicationExpected(
      'verification-to-signoff',
      verification.artifactPath,
      verification.artifactHash,
      verification.artifactBytes,
      'G6',
      PERSONA.verifier,
      'VERIFIED',
      feature.id,
    ),
    'feature terminal publication',
  )
  return sealed
}

async function runFeatureInner(feature) {
  // The TIER picks how many gates run (proportionality fix). An explicit
  // recognized tier is honored; an omitted/unknown one resolves to the T3
  // ceiling. A feature ESCALATES one tier up (re-running here) when its in-tier
  // redo budget is spent or a worker returns OUT-OF-SCOPE; de-escalation never
  // happens - a climbed feature keeps its highest tier for the rest of the run.
  const tier = resolveTier(feature)
  const baseTierCfg = TIER_PIPELINE[tier]

  // FRAMEWORK HARD GATE (F-FRAMEWORK): resolve the feature's framework leaf ONCE at
  // dispatch before any build gate. Absent/unknown -> INVALID-DISPATCH, repaired by
  // the narrow generator (a category-derived known leaf, logged). The resolved leaf
  // rides feature.framework into the result -> summary -> the SCRIBE FEATURE-META row
  // (framework=<leaf>), the token the ledger frameworkTierFindings rule attests.
  const framework = resolveFramework(feature)
  // The `apply` leaf's GATE PATH is APPLY -> DIFF-REVIEW -> VERIFY-GREEN + GOAL-CHECK
  // floor: it SKIPS G1 PLAN, G3 FRESH-VERIFY, and G7 SIGN-OFF regardless of tier.
  // NARROW GATE-PATH INTERPRETATION (documented above): override the tier flags to
  // plan/planLoop off + panelSize 0, keeping G5 DIFF-REVIEW (implReview) and G6
  // VERIFY-GREEN (verify). FULL per-leaf GATE-PATH parsing is deferred.
  const tierCfg = framework === APPLY_FRAMEWORK
    ? { ...baseTierCfg, plan: false, planLoop: false, panelSize: 0, freshVerifyDebug: false }
    : baseTierCfg

  // Budget guard (iron rule 9): if the token target is nearly spent, defer
  // this feature instead of opening a fresh ~40-agent pipeline. With the
  // concurrency cap, later features in a wide wave hit this as budget drains.
  if (!canSpawnNewWork()) {
    return { feature, status: 'DEFERRED', reasons: ['token budget guard, deferred before planning'] }
  }

  // RESUME frontier probe: skip work that a prior session already froze, so we
  // reuse prior -vN artifacts instead of clobbering them. The probe's own claim
  // is canary-checked first: a tainted/hallucinated probe (mismatched nonce)
  // could otherwise skip the whole build/verify pipeline straight to sign-off,
  // so on a trip we treat the probe as untrusted and fall through to the normal
  // pipeline (the re-verification duty GATES.md demands).
  // COST GUARD: the probe only has anything to find on a SUPERVISOR RELAUNCH.
  // On a fresh run nothing is frozen yet, so spawning a probe per feature is one
  // wasted agent each - the dominant fixed tax on the small SWE-bench tasks that
  // never resume. Skip it unless IS_RESUME; a fresh run gets the all-false
  // default and goes straight to planning/building.
  // FIX-09: the fresh-run frontier is a harness-built default (no spawn, no
  // nonce). Mark it LOCAL_SENTINEL so canaryTripped exempts it - without the
  // marker the inverted predicate would false-trip canaryTrips on every fresh run.
  const frontier = IS_RESUME
    ? await detectFrontier(feature)
    : {
        [LOCAL_SENTINEL]: true,
        planFinalPresent: false,
        verifyPassPresent: false,
        partialGatePresent: false,
        frozenPlan: '',
        planPublication: null,
        lastVerifyEvidence: '',
        verifyPublication: null,
      }
  const frontierTrusted = !canaryTripped(frontier)
  if (!frontierTrusted) {
    canaryTrips++
    log(`CANARY: nonce mismatch at ${feature.id} resume-probe; distrusting frontier detection, running the full pipeline`)
  }
  // Mid-gate-crash rule (F6): an impl artifact with no matching review/verify is
  // a half-finished gate. It is NOT done; never take the verify/plan skip
  // shortcut over it - re-run build/verify, which writes a fresh -v(N+1) beside
  // the survivors, never clobbering them.
  const midGateCrash = frontierTrusted && frontier.partialGatePresent === true && !frontier.verifyPassPresent
  if (midGateCrash) {
    markResumed(feature, featureSpawnLog)
    log(`${feature.id}: resume - a half-finished gate (impl present, no verify) detected; re-running build/verify as a fresh -vN (never trusting a started-but-unconfirmed gate)`)
    const resolved = frontier.frozenPlan
      ? {
          plan: frontier.frozenPlan,
          planPublication: frontier.planPublication,
        }
      : await resolvePlan(feature, tier, tierCfg)
    const plan = resolved.plan
    // RESUME-BYPASS fix: a debug feature resumed past plan-freeze MUST still pass
    // DEPTH-LOCK before its fix is re-built - never seal DONE with the gate skipped.
    const lock = await lockDebugPlan(feature, plan)
    if (!lock.ok) return { feature, status: 'BLOCKED_AT_PLAN', tier, reasons: lock.reasons, depthMiss: true, plan }
    return finishFromBuild(
      feature,
      plan,
      await buildUntilVerified(
        feature,
        plan,
        tier,
        tierCfg,
        resolved.planPublication,
      ),
      tier,
      tierCfg,
      resolved.planPublication,
    )
  }
  if (frontierTrusted && frontier.verifyPassPresent && frontier.frozenPlan) {
    markResumed(feature, featureSpawnLog)
    log(`${feature.id}: resume - verify already passed in a prior session, re-confirming via sign-off only`)
    // RESUME-BYPASS fix: even a verify-passed debug resume must carry a DEPTH-LOCK -
    // re-run the gate so a debug feature cannot reach DONE with DEPTH-LOCK skipped.
    const lock = await lockDebugPlan(feature, frontier.frozenPlan)
    if (!lock.ok) return { feature, status: 'BLOCKED_AT_PLAN', tier, reasons: lock.reasons, depthMiss: true, plan: frontier.frozenPlan }
    const resumedBuild = {
      ok: true,
      evidence: frontier.lastVerifyEvidence,
      coverage: undefined,
      verifyPublication: frontier.verifyPublication,
    }
    // T0/T1 carry no sign-off panel; a resumed verified feature at those tiers is
    // DONE without re-convening a panel that never ran (proportionality).
    if (tierCfg.panelSize <= 0) {
      return { feature, status: 'DONE', tier, coverage: undefined, evidence: resumedBuild.evidence, plan: frontier.frozenPlan, verifyPublication: resumedBuild.verifyPublication, jurorVerdicts: [], panelFails: [] }
    }
    const panel = await signOffPanel(feature, frontier.frozenPlan, resumedBuild, tierCfg.panelSize)
    return {
      feature, tier,
      status: panel.unanimous ? 'DONE' : 'PARTIAL',
      coverage: resumedBuild.coverage, evidence: resumedBuild.evidence, plan: frontier.frozenPlan,
      verifyPublication: resumedBuild.verifyPublication,
      jurorVerdicts: panel.jurorVerdicts, panelFails: panel.unanimous ? [] : panel.fails,
    }
  }
  if (frontierTrusted && frontier.planFinalPresent && frontier.frozenPlan) {
    markResumed(feature, featureSpawnLog)
    log(`${feature.id}: resume - plan already frozen in a prior session, skipping to build`)
    // RESUME-BYPASS fix: a plan-frozen debug resume re-enters DEPTH-LOCK before build.
    const lock = await lockDebugPlan(feature, frontier.frozenPlan)
    if (!lock.ok) return { feature, status: 'BLOCKED_AT_PLAN', tier, reasons: lock.reasons, depthMiss: true, plan: frontier.frozenPlan }
    return finishFromBuild(
      feature,
      frontier.frozenPlan,
      await buildUntilVerified(
        feature,
        frontier.frozenPlan,
        tier,
        tierCfg,
        frontier.planPublication,
      ),
      tier,
      tierCfg,
      frontier.planPublication,
    )
  }

  log(`${feature.id} (${feature.category}${feature.tag ? `/${feature.tag}` : ''}, ${tier}), ${feature.name}: ${tierCfg.plan ? 'planning' : (debugFreshVerifyRequired(feature, tierCfg) ? 'debug plan + fresh-verify (freshVerifyDebug)' : 'building (no plan phase at this tier)')}`)
  const planResult = await resolvePlan(feature, tier, tierCfg)
  if (!planResult.ok) {
    return { feature, status: 'BLOCKED_AT_PLAN', tier, reasons: planResult.reasons, depthMiss: planResult.depthMiss === true, plan: planResult.plan }
  }

  log(`${feature.id}: building`)
  const build = await buildUntilVerified(
    feature,
    planResult.plan,
    tier,
    tierCfg,
    planResult.planPublication,
  )
  return finishFromBuild(
    feature,
    planResult.plan,
    build,
    tier,
    tierCfg,
    planResult.planPublication,
  )
}

// Shared tail: take a build result through the (tier-sized) sign-off panel (and
// one remediation cycle on a split) to a final feature status. A build that
// flagged ESCALATE climbs ONE tier and re-runs the whole feature there.
async function finishFromBuild(
  feature,
  plan,
  build,
  tier,
  tierCfg,
  planPublication,
) {
  const t = tier || DEFAULT_TIER
  const cfg = tierCfg || TIER_PIPELINE[DEFAULT_TIER]

  // ESCALATION (GATES.md): a leaner tier whose redo budget was spent (or whose
  // worker returned OUT-OF-SCOPE) climbs ONE tier and re-runs the feature there
  // with the same cryptographically bound mission pointer. T3 is the ceiling and never escalates.
  if (build.escalate && t !== 'T3') {
    const climbed = nextTier(t)
    log(`${feature.id}: ESCALATE ${t} -> ${climbed} (${(build.reasons || []).join('; ') || 'tier redo budget spent'}); re-running at the higher tier`)
    return runFeature({ ...feature, tier: climbed })
  }

  if (!build.ok) {
    return { feature, status: 'PARTIAL', tier: t, reasons: build.reasons, arbiter: build.arbiter, plan }
  }

  requireDurablePublication(
    build.verifyPublication,
    publicationExpected(
      'verification-to-signoff',
      build.verifyPublication &&
        build.verifyPublication.artifactPath,
      build.verifyPublication &&
        build.verifyPublication.artifactHash,
      build.verifyPublication &&
        build.verifyPublication.artifactBytes,
      'G6',
      PERSONA.verifier,
      'VERIFIED',
      feature.id,
    ),
    'verification-to-signoff',
  )

  // T0/T1: no sign-off panel (GATES.md tier table). The IMPL-REVIEW + VERIFY
  // gates already policed the work; the run-level GOAL-CHECK is the final
  // default-FAIL backstop. A verified build at these tiers is DONE.
  if (cfg.panelSize <= 0) {
    return { feature, status: 'DONE', tier: t, coverage: build.coverage, evidence: build.evidence, plan, verifyPublication: build.verifyPublication, jurorVerdicts: [], panelFails: [] }
  }

  log(`${feature.id}: sign-off panel (${cfg.panelSize} juror${cfg.panelSize === 1 ? '' : 's'})`)
  let panel = await signOffPanel(feature, plan, build, cfg.panelSize)
  if (!panel.unanimous) {
    log(`${feature.id}: panel split (${panel.jurorVerdicts.join('/')}), one remediation cycle`)
    const remed = await buildUntilVerified(
      { ...feature, name: `${feature.name} (panel remediation: ${panel.fails.join('; ')})` },
      plan,
      t,
      cfg,
      planPublication,
    )
    if (remed.ok) {
      build.evidence = remed.evidence
      build.coverage = remed.coverage
      build.verifyPublication = remed.verifyPublication
      panel = await signOffPanel(feature, plan, build, cfg.panelSize)
    }
    if (!panel.unanimous) {
      // Pillar B M1/N2: a persistent split is normally an arbiter call, BUT a
      // FAIL that names a P0/P1 blocker is NOT arbitrable into DONE. The arbiter
      // may decide HOW to log it, never that a blocker is acceptable to ship.
      // A SHORT panel (a juror result missing/null) is likewise NON-ARBITRABLE:
      // an unsigned-off juror is never shippable, so a sub-panel-size panel can
      // only be logged PARTIAL - the arbiter cannot mint DONE over it.
      const namesBlocker = panelNamesBlocker(panel.fails)
      const panelShort = panel.panelShort === true
      const hardBlock = namesBlocker || panelShort
      const ruling = await arbiter(`Sign-off panel for ${feature.id} still split after remediation (${panel.jurorVerdicts.join('/')}). FAIL reasons:\n- ${panel.fails.join('\n- ')}\n${namesBlocker ? 'NOTE: a FAIL names a P0/P1 blocker; an open blocker is NOT shippable, so this can only be logged PARTIAL, never DONE. ' : ''}${panelShort ? `NOTE: only ${panel.jurorVerdicts.length}/${panel.panelSize} jurors convened (a juror result is missing); an incompletely-convened panel is NOT a valid unanimous sign-off, so this can only be logged PARTIAL, never DONE. ` : ''}Decide: ${hardBlock ? 'log partial (the only valid option over an open blocker / incomplete panel).' : 'ship as-is, or log partial?'}`, 'Sign-off')
      return {
        feature, tier: t,
        status: (ruling.proceed && !hardBlock) ? 'DONE' : 'PARTIAL',
        coverage: build.coverage, evidence: build.evidence, plan,
        verifyPublication: build.verifyPublication,
        jurorVerdicts: panel.jurorVerdicts, panelFails: panel.fails, arbiter: ruling.decision,
        blockerNamed: namesBlocker, panelShort,
      }
    }
  }

  return {
    feature, tier: t,
    status: 'DONE',
    coverage: build.coverage,
    evidence: build.evidence,
    plan,
    verifyPublication: build.verifyPublication,
    jurorVerdicts: panel.jurorVerdicts,
    panelFails: [],
  }
}

// ----- USEFUL-FIRST BOOTSTRAP + ADAPTIVE ROADMAP ------------------------
// A trusted supervisor attestation lets the first roadmap worker skip redundant
// capability work. Without one, that same useful worker proves RUN/READ/WRITE
// before it scopes; there is no dedicated preflight or intake round trip.
// === CAPABILITY-ATTESTATION-SLICE:START ===
const CAPABILITY_ATTESTATION_VERSION = 4
const MAX_CAPABILITY_PROOF_BYTES = 4096
const CAPABILITY_BINDING_FIELDS = [
  'provider',
  'cliVersion',
  'permissionProfile',
  'agentSelector',
  'agentDefinitionsHash',
  'castingHash',
  'effortStatus',
  'effortSource',
]

function verifyCapabilityAttestation(raw, expected, hashText) {
  if (typeof raw !== 'string' || raw.trim() === '') return { trusted: false, reason: 'attestation missing' }
  let attestation
  try { attestation = JSON.parse(raw) } catch { return { trusted: false, reason: 'attestation is not valid JSON' } }
  if (!attestation || attestation.schemaVersion !== CAPABILITY_ATTESTATION_VERSION) {
    return { trusted: false, reason: `schemaVersion must be ${CAPABILITY_ATTESTATION_VERSION}` }
  }
  if (attestation.run !== true || attestation.read !== true || attestation.write !== true) {
    return { trusted: false, reason: 'RUN/READ/WRITE capability is incomplete' }
  }
  if (attestation.proofKind !== 'disposable-scratch') {
    return { trusted: false, reason: 'RUN/READ/WRITE proofKind is not disposable-scratch' }
  }
  if (typeof attestation.proofHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(attestation.proofHash)) {
    return { trusted: false, reason: 'RUN/READ/WRITE proofHash is missing or malformed' }
  }
  // The proof hash must recompute from inspectable scratch bytes carried in
  // the attestation itself (the gate is fs-free); a bare well-formed hash
  // string proves nothing.
  if (
    typeof attestation.proofBytes !== 'string' ||
    attestation.proofBytes === '' ||
    attestation.proofBytes.length > MAX_CAPABILITY_PROOF_BYTES
  ) {
    return { trusted: false, reason: 'RUN/READ/WRITE proof bytes are missing or oversized' }
  }
  if (typeof hashText !== 'function') {
    return { trusted: false, reason: 'RUN/READ/WRITE proof cannot be recomputed' }
  }
  if (`sha256:${hashText(attestation.proofBytes)}` !== attestation.proofHash) {
    return { trusted: false, reason: 'RUN/READ/WRITE proofHash does not match the scratch proof bytes' }
  }
  for (const field of CAPABILITY_BINDING_FIELDS) {
    if (typeof attestation[field] !== 'string' || attestation[field] === '' || attestation[field] === 'unknown') {
      return { trusted: false, reason: `${field} binding is missing or unverified` }
    }
    if (!expected || attestation[field] !== expected[field]) {
      return { trusted: false, reason: `${field} binding does not match the live launch` }
    }
  }
  return { trusted: true, reason: 'trusted supervisor attestation' }
}
// === CAPABILITY-ATTESTATION-SLICE:END ===

const CAPABILITY_BINDING = Object.freeze({
  provider: WORKFLOW_ENV.AUTOPROMPT_PROVIDER || 'unknown',
  cliVersion: WORKFLOW_ENV.AUTOPROMPT_CLI_VERSION || 'unknown',
  permissionProfile: WORKFLOW_ENV.AUTOPROMPT_PERMISSION_PROFILE || 'unknown',
  agentSelector: WORKFLOW_ENV.AUTOPROMPT_AGENTS || 'off',
  agentDefinitionsHash: WORKFLOW_ENV.AUTOPROMPT_AGENT_DEFINITIONS_HASH || 'unknown',
  castingHash: WORKFLOW_ENV.AUTOPROMPT_CASTING_HASH || 'none',
  effortStatus: MODEL_CASTING.effort.status,
  effortSource: MODEL_CASTING.effort.source,
})
const capabilityVerdict = verifyCapabilityAttestation(
  WORKFLOW_ENV.AUTOPROMPT_CAPABILITY_ATTESTATION,
  CAPABILITY_BINDING,
  sha256Hex,
)
const capabilityAttested = capabilityVerdict.trusted
log(capabilityAttested
  ? 'Bootstrap capability attestation verified; no preflight agent call.'
  : `No trusted capability attestation (${capabilityVerdict.reason}); the useful-first roadmap author will prove RUN/READ/WRITE.`)

function preExecutionSealReason() {
  const getBuiltin =
    typeof process === 'object' &&
    process &&
    typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule.bind(process)
      : null
  const fileSystem = getBuiltin &&
    (getBuiltin('node:fs') || getBuiltin('fs'))
  if (!fileSystem) return ''
  for (const marker of [
    'SCOPE-BUDGET-BREACH',
    'SCOPE-CONVERGE-REQUEST',
  ]) {
    const read = readUtf8File(fileSystem, `${LEDGER_DIR}/${marker}`)
    if (typeof read.text === 'string') {
      const missionBinding = read.text.match(
        /(?:^|\s)mission=(sha256:[a-f0-9]{64})(?:\s|$)/,
      )
      const expectedBinding = `sha256:${sha256Hex(MISSION)}`
      if (!missionBinding || missionBinding[1] !== expectedBinding) {
        continue
      }
      return `${marker}: ${read.text.trim()}`
    }
  }
  return ''
}

const preExecutionSeal = preExecutionSealReason()
if (preExecutionSeal) {
  log(`PRE-EXECUTION SEALED: ${preExecutionSeal}`)
  return {
    error: 'pre-execution budget sealed before roadmap dispatch',
    scopeReasons: [preExecutionSeal],
    mission: MISSION,
  }
}

const REANCHOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['ALIGNED', 'DRIFT'] },
    reasons: { type: 'array', items: { type: 'string' }, description: 'if DRIFT, the specific mismatch between the on-disk frontier and the ORIGINAL MISSION' },
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}
if (IS_RESUME && canSpawnNewWork()) {
  phase('Re-anchor')
  const reAnchor = await agent(
    compactBrief('the post-resume re-anchor',
      `Read "${ARTIFACT_DIR}/ROADMAP.md" and the current gate log, compare them with the original mission, and report either ALIGNED or DRIFT with specific reasons. Change nothing.`,
      null),
    { label: 're-anchor', phase: 'Re-anchor', schema: REANCHOR_SCHEMA, agentType: PERSONA.reAnchor },
  )
  if (canaryTripped(reAnchor)) {
    canaryTrips++
    return {
      error: 'post-resume re-anchor failed its run binding',
      scopeReasons: ['re-anchor canary nonce is missing or mismatched'],
      mission: MISSION,
    }
  }
  if (reAnchor.verdict !== 'ALIGNED') {
    return {
      error: 'post-resume re-anchor found mission drift',
      scopeReasons: Array.isArray(reAnchor.reasons) && reAnchor.reasons.length
        ? reAnchor.reasons
        : ['re-anchor returned no specific drift reasons'],
      mission: MISSION,
    }
  }
}

const scope = await scopeAndRoadmap()
if (!scope.approved) {
  return {
    error: scope.capabilityFailed
      ? 'bootstrap capability check failed; build was not started'
      : 'mission has no approved executable roadmap; scope gate did not converge',
    scopeReasons: scope.reasons || [],
    scope: scope.metrics,
    mission: MISSION,
  }
}
const features = scope.features
const scopeDep = validateDependencies(features)
if (!scopeDep.ok) {
  return { error: `roadmap-derived dependency graph invalid: ${scopeDep.reason}`, mission: MISSION }
}
const contractRejects = debugContractRejects(features)
if (contractRejects.length) {
  return { error: `roadmap debug-contract invalid: ${contractRejects.map(item => item.id).join(', ')}`, mission: MISSION }
}
const scopeLanes = phasesOf(features).map(lane => lane.map(feature => feature.id))
log(`Roadmap APPROVED via ${scope.topology.profile}: ${scope.metrics.agents} actual scope agents / ${scope.metrics.rounds} actual rounds / ${scope.metrics.elapsedMs}ms; ${features.length} executable feature(s).`)

// ----- run features (per the execution mode; disjoint boundaries) -----
phase('Plan')
if (!canSpawnNewWork()) {
  log('Token budget already low after roadmap approval, deferring the build wave.')
}
const built = []
const builtById = new Map()

function dependencyBlockReasons(feature) {
  const reasons = []
  for (const dependencyId of feature.dependsOn || []) {
    const dependency = builtById.get(dependencyId)
    if (!dependency) {
      reasons.push(`${dependencyId} has no completed result`)
      continue
    }
    if (dependency.status !== 'DONE') {
      reasons.push(
        `${dependencyId} reached ${dependency.status || 'UNKNOWN'}, not DONE`,
      )
      continue
    }
    if (!dependency.terminalPublication) {
      reasons.push(`${dependencyId} has no durable terminal publication`)
      continue
    }
    requireDurablePublication(
      dependency.terminalPublication,
      publicationExpected(
        'verification-to-signoff',
        dependency.terminalPublication.artifactPath,
        dependency.terminalPublication.artifactHash,
        dependency.terminalPublication.artifactBytes,
        'G6',
        PERSONA.verifier,
        'VERIFIED',
        dependencyId,
      ),
      'feature-to-dependent',
    )
  }
  return reasons
}

function recordFeatureResult(result) {
  if (!result || !result.feature) return
  built.push(result)
  builtById.set(result.feature.id, result)
}

function blockDependent(feature, reasons) {
  const result = {
    feature,
    status: 'BLOCKED_AT_DEPENDENCY',
    reasons,
  }
  recordFeatureResult(result)
  log(
    `BLOCKED dependency-to-feature ${feature.id}: ${reasons.join('; ')}`,
  )
}

const buckets = phasesOf(features)
for (const bucket of buckets) {
  const ready = []
  for (const feature of bucket) {
    const reasons = dependencyBlockReasons(feature)
    if (reasons.length) blockDependent(feature, reasons)
    else ready.push(feature)
  }
  if (!ready.length) continue

  if (!canSpawnNewWork()) {
    for (const feature of ready) {
      recordFeatureResult({
        feature,
        status: 'DEFERRED',
        reasons: ['token budget guard, deferred before planning'],
      })
    }
    continue
  }

  if (MODE_CFG.parallelFeatures) {
    log(`${MODE.toUpperCase()}: fanning out phase bucket of ${ready.length} feature(s)${TOPOLOGY.liveCap == null ? ' at once' : ` (up to ${TOPOLOGY.liveCap} live per wave)`}.${scopeLanes.length ? ` (ROADMAP.md declared ${scopeLanes.length} launch lane(s); the phase bucket is the widest disjoint wave)` : ''}`)
    const results = await fanout(
      ready.map(feature => () => runFeature(feature)),
      true,
      `phase-bucket(${ready.length})`,
    )
    for (const result of results.filter(Boolean)) recordFeatureResult(result)
    continue
  }

  for (const feature of ready) {
    const result = await runFeature(feature)
    if (result) recordFeatureResult(result)
  }
}
const byId = {}
for (const r of built) byId[r.feature.id] = r
const deferredFeatures = built.filter(r => r.status === 'DEFERRED').length
if (deferredFeatures) log(`${deferredFeatures} feature(s) deferred by the budget guard.`)

// The run-level SWEEP depth is scaled by the mission's highest feature tier
// (PLAYBOOKS): T0/T1 skip the sweeper wave entirely (GOAL-CHECK is the
// backstop), T2 runs a single mini-sweep round, T3 sweeps to convergence. A
// feature that escalated at runtime carries its climbed tier in the result, so
// the mission tier reflects the highest tier ACTUALLY reached.
const reachedTiers = built.map(r => r.tier).filter(Boolean)
const MISSION_TIER = reachedTiers.length
  ? reachedTiers.reduce((top, t) => TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(top) ? t : top, 'T0')
  : maxTier(features)
const SWEEP_CFG = SWEEP_BY_TIER[MISSION_TIER] || SWEEP_BY_TIER[DEFAULT_TIER]
const SWEEP_ROUND_CAP = SWEEP_CFG.rounds
const SWEEP_CLEAN_REQUIRED = SWEEP_CFG.cleanRequired
log(`Mission tier ${MISSION_TIER}: sweep depth ${SWEEP_ROUND_CAP === 0 ? 'NONE (GOAL-CHECK is the backstop)' : `${SWEEP_ROUND_CAP} round cap, ${SWEEP_CLEAN_REQUIRED} clean sweep(s) to converge`}.`)

// ----- SWEEP to convergence --------------------------------------------
phase('Sweep')
const seen = new Set()
const key = f => `${(f.where || '').trim().toLowerCase()}::${(f.title || '').trim().toLowerCase()}`
const allFindings = []
let cleanStreak = 0
let sweepRound = 0
let convergedReason = ''

// The sweepers are the run's last line of defense, so they get everything:
// the mission (first, prioritized), every approved plan, and the artifact
// checkpoints - and they re-derive mission coverage themselves instead of
// trusting the gate verdicts. The plans are passed as POINTERS (the frozen
// -plan-final.md paths the sweeper reads on demand), not inlined verbatim: a
// sweeper has Read and is told to open them, so inlining every full plan into
// every sweep round was pure duplicated payload on the widest fan-out.
function approvedPlansBlock() {
  const withPlans = Object.values(byId).filter(r => r.plan)
  if (!withPlans.length) return '(no approved plans on record)'
  return withPlans
    .map(r => `- ${r.feature.id} (${r.feature.name}) [${r.status}]: read "${ARTIFACT_DIR}/${r.feature.id}-plan-final.md"`)
    .join('\n')
}

while (sweepRound < SWEEP_ROUND_CAP && cleanStreak < SWEEP_CLEAN_REQUIRED) {
  sweepRound++
  if (!canSpawnNewWork()) { convergedReason = 'token budget guard, stopped opening new work'; break }

  assertExecLevel(PERSONA.sweeper, `sweep round ${sweepRound}`)
  const sweep = await agent(
    compactBrief('a production-readiness sweeper (problem-finder grade), you have seen none of the work that produced this',
      `THE APPROVED IMPLEMENTATION PLANS (what was supposed to be built; the ORIGINAL MISSION above outranks them):\n${approvedPlansBlock()}\n\n` +
      `RUN STATE: read the canonical ROADMAP.md plus substantive implementation and verification evidence under "${ARTIFACT_DIR}/". Trust no prior verdict over the mission.\n\n` +
      `Do, in order:\n` +
      `1. MISSION COVERAGE FIRST. Re-derive every ask from the ORIGINAL MISSION text alone, not from the plans, not from the gate verdicts. Check each ask against the actually-delivered work (read the code, run \`git diff\`, run the thing). Any mission ask not provably delivered is a P0 finding, even if every gate passed it.\n` +
      `2. THEN the neighborhood: run \`git diff\` and read the touched code plus its surroundings. Find what the mission did NOT explicitly ask for but a senior engineer would catch: adjacent bugs, missing edge cases, untested paths, security holes, data-integrity risks, operability gaps. This is the "while fixing login I found 20 other bugs" pass.\n` +
      (seen.size ? `ALREADY-KNOWN findings (do NOT repeat these; only report findings NOT in this list):\n- ${[...seen].join('\n- ')}\n` : '') +
      `Return a severity-ranked findings list (P0..P3) with file:line and impact. If you find nothing new and genuinely material, return an empty list, do not invent nits to look thorough.`,
      `${ARTIFACT_DIR}/sweep-round-${sweepRound}.md`),
    { label: `sweep round ${sweepRound}`, phase: 'Sweep', schema: SWEEP_SCHEMA, agentType: PERSONA.sweeper },
  )

  if (canaryTripped(sweep)) {
    canaryTrips++
    cleanStreak = 0
    log(`CANARY: nonce mismatch at sweep round ${sweepRound}; discarding the round and not advancing the clean streak`)
    continue
  }

  const found = (sweep && sweep.findings) || []
  const fresh = found.filter(f => !seen.has(key(f)))
  for (const f of fresh) { seen.add(key(f)); allFindings.push(f) }

  const newReentry = fresh.filter(f => f.severity === 'P0' || f.severity === 'P1')
  if (!newReentry.length) {
    cleanStreak++
    log(`Sweep round ${sweepRound}: no new P0/P1 (clean streak ${cleanStreak}/${SWEEP_CLEAN_REQUIRED})`)
    continue
  }

  cleanStreak = 0
  if (!canSpawnNewWork()) { convergedReason = 'token budget guard, P0/P1 left for next run'; break }
  log(`Sweep round ${sweepRound}: ${newReentry.length} new P0/P1, re-entering the gates`)
  if (newReentry.length > MAX_FEATURES) {
    log(`Sweep round ${sweepRound}: ${newReentry.length - MAX_FEATURES} P0/P1 finding(s) exceed the per-round re-entry limit of ${MAX_FEATURES} and remain open as residual for the next run`)
  }
  // A swept P0/P1 re-enters as a T1 debug feature (a root-cause fix is bounded
  // work); it escalates on its own if a worker finds it cross-cutting.
  const reentryFeatures = newReentry
    .slice(0, MAX_FEATURES)
    .map((finding, index) => ({
      id: `S${sweepRound}.${index + 1}`,
      name: finding.title,
      category: 'backend',
      tag: 'debug',
      tier: 'T1',
      boundary: finding.where,
      acceptanceCriteria: [
        `the ${finding.title} finding is fixed and its reported impact no longer occurs`,
      ],
      requiresDetailedPlan: true,
      roadmapPlan:
        `Sweep remediation: ${finding.title} at ${finding.where}. ` +
        `Impact: ${finding.impact}`,
      roadmapPath: scope.roadmap.roadmapPath,
      roadmapHash: scope.roadmap.roadmapHash,
      roadmapBytes: scope.roadmap.roadmapBytes,
      roadmapApproval: scope.roadmapApproval,
    }))
  const reentryResults = (await fanout(reentryFeatures.map(f => () => runFeature(f)), MODE_CFG.parallelFeatures, `sweep-reentry(${reentryFeatures.length})`)).filter(Boolean)
  for (const r of reentryResults) byId[r.feature.id] = r
}
if (!convergedReason) {
  convergedReason = SWEEP_ROUND_CAP === 0
    ? `tier ${MISSION_TIER}: no sweep wave (GOAL-CHECK is the backstop)`
    : (cleanStreak >= SWEEP_CLEAN_REQUIRED
      ? `converged: ${SWEEP_CLEAN_REQUIRED} consecutive clean sweep(s)`
      : `sweep round cap (${SWEEP_ROUND_CAP}) reached`)
}

// ----- result -----------------------------------------------------------
const allResults = Object.values(byId)
const blocked = allResults.filter(r => r.status !== 'DONE')
const deferred = allFindings.filter(f => f.severity === 'P2' || f.severity === 'P3')
const openP01 = allResults.filter(r => r.feature.id.startsWith('S') && r.status !== 'DONE')
// Pillar B N1/2.3: isDone is BLOCKER-AWARE. Any sweep P0/P1 whose re-entry
// feature did not reach DONE is an open blocker that hard-blocks DONE,
// independent of feature status. A clean streak alone is necessary, not
// sufficient. (allFindings carry the raw severities the sweep surfaced; an
// open re-entry means a found blocker was not fixed-and-re-verified.)
// The clean-streak bar is the tier-scaled SWEEP_CLEAN_REQUIRED: at T0/T1 it is
// 0 (no sweep wave runs), so the GOAL-CHECK below is the sole DONE backstop.
const openSweepBlockers = openP01.length > 0
const isDone = blocked.length === 0 && cleanStreak >= SWEEP_CLEAN_REQUIRED && !openSweepBlockers

// GOAL-CHECK (the "are we really done?" backstop the mission demands): a fresh
// agent re-derives every ask from the MISSION text alone and default-FAILs.
// Every ask starts NOT-DONE and only flips on evidence the agent opens itself.
// It runs exactly once, outside the sweep loop, and never re-enters the gates,
// so it cannot recurse. A NOT-DONE verdict blocks the DONE claim.
const GOAL_CHECK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [
    'verdict',
    'unmetAsks',
    'openBlockers',
    'usable',
    'coverageFloorOk',
    'severityDowngrades',
  ],
  properties: {
    verdict: { type: 'string', enum: ['DONE', 'NOT-DONE'] },
    unmetAsks: { type: 'array', items: { type: 'string' }, description: 'every mission ask not provably delivered; empty only if truly all met' },
    openBlockers: {
      type: 'array',
      description: 'every still-open P0/P1 anywhere (feature gate, sweep, your own check); any entry forces NOT-DONE',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'title', 'where'],
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1'] },
          title: { type: 'string' },
          where: { type: 'string', description: 'file:line' },
        },
      },
    },
    usable: {
      type: 'object', additionalProperties: false,
      description: 'is the deliverable actually usable, generalized by deliverable type',
      required: ['entryPoint', 'roadmap', 'onboarding'],
      properties: {
        entryPoint: { type: 'boolean', description: 'a reachable entry point exists (local run path / CLI command / library API), no false claim' },
        roadmap: { type: 'boolean', description: 'a ROADMAP/PRD artifact is on disk (for an ambitious mission, the approved master ROADMAP.md)' },
        onboarding: { type: 'boolean', description: 'basic onboarding/first-run path is present (README/quickstart/--help)' },
      },
    },
    coverageFloorOk: { type: 'boolean', description: `true only if changed-line coverage is >= ${COVERAGE_FLOOR}%` },
    severityDowngrades: {
      type: 'array',
      description: 'any P0/P1 silently reclassified to P2/P3 at the DONE boundary without a justified, evidenced reason; any entry blocks DONE',
      items: {
        type: 'object', additionalProperties: false,
        required: ['from', 'to', 'where'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          where: { type: 'string' },
        },
      },
    },
    nonce: { type: 'string' },
  },
}
let goalCheck = null
let goalCheckPassed = false
if (isDone && canSpawnNewWork()) {
  assertGateRouting('GOALCHECK', PERSONA.goalChecker, 'goal-check')
  goalCheck = await agent(
    compactBrief('the GOAL-CHECK gate; INDEPENDENT and ADVERSARIAL, default-FAIL; fresh context, you have seen none of the work and did NOT author it; answer ARE WE REALLY DONE',
      `Re-derive EVERY ask from the ORIGINAL MISSION text alone. Default-FAIL: every ask starts NOT-DONE and flips to DONE only on evidence you open yourself (read the code, run git diff, run the thing under "${ARTIFACT_DIR}" and the project). ` +
      `Report, structurally: (1) unmetAsks: every mission ask not provably delivered; (2) openBlockers: every still-open P0/P1 anywhere - a "PASS with P0 notes" is itself a finding, list the P0; (3) usable: does the deliverable have a reachable entry point, a ROADMAP/PRD artifact on disk, and a basic onboarding/first-run path (generalize by deliverable type - CLI command/--help, library API/docs, etc.); (4) coverageFloorOk: is changed-line coverage >= ${COVERAGE_FLOOR}%; (5) severityDowngrades: any P0/P1 silently reclassified to P2/P3 without a justified evidenced reason. ` +
      `Return verdict DONE ONLY if every mission ask is provably delivered AND openBlockers is empty AND all three usable sub-criteria hold AND coverageFloorOk is true AND there are no unjustified severity downgrades; otherwise NOT-DONE. A single unmet ask, a single open P0/P1, a missing usable sub-criterion, a sub-floor coverage number, or a silent downgrade each means NOT-DONE.`,
      `${ARTIFACT_DIR}/goal-check.md`),
    { label: 'goal-check', phase: 'Sweep', schema: GOAL_CHECK_SCHEMA, agentType: PERSONA.goalChecker },
  )
  if (canaryTripped(goalCheck)) {
    canaryTrips++
    log('CANARY: nonce mismatch at goal-check; treating verdict as NOT-DONE')
  }
  // Pillar B 2.2: DONE is RECOMPUTED in code from the structured fields, never
  // trusted from the model's verdict string. Every evidence collection must be
  // present in its declared shape; omission is NOT equivalent to clean.
  const gc = goalCheck || {}
  const asksMet = Array.isArray(gc.unmetAsks) && gc.unmetAsks.length === 0
  const blockerFree = Array.isArray(gc.openBlockers) && gc.openBlockers.length === 0
  const u = gc.usable || {}
  const usableOk = u.entryPoint === true && u.roadmap === true && u.onboarding === true
  const coverageOk = gc.coverageFloorOk === true
  const downgradesClean = Array.isArray(gc.severityDowngrades) && gc.severityDowngrades.length === 0
  goalCheckPassed = !!goalCheck
    && goalCheck.verdict === 'DONE'
    && asksMet && blockerFree && usableOk && coverageOk && downgradesClean
    && !canaryTripped(goalCheck)
}
const isDoneFinal = isDone && goalCheckPassed

// DONE-sentinel (binding F2): the supervisor's process-external, mission-scoped
// "is this DONE?" signal. Written by the JANITOR/SCRIBE subagent (never the
// parent) ONLY when isDoneFinal (which requires OPEN-BLOCKERS:0). A NOT-DONE run
// writes NO sentinel, so "no sentinel" == "not yet done OR crashed" == relaunch.
const DONE_SENTINEL = `${LEDGER_DIR}/DONE-${RUN_NONCE}`

// Which DONE precondition failed (Pillar B 2.6: the verdict names the reason).
function goalCheckFailReason() {
  const gc = goalCheck || {}
  if (!goalCheck) return 'goal-check did not run'
  if (canaryTripped(goalCheck)) return 'goal-check canary trip (nonce mismatch)'
  if (!Array.isArray(gc.unmetAsks)) return 'unmetAsks is missing or malformed'
  if (gc.unmetAsks.length) return `unmet ask(s): ${gc.unmetAsks.join('; ')}`
  if (!Array.isArray(gc.openBlockers)) return 'openBlockers is missing or malformed'
  if (gc.openBlockers.length) return `open blocker(s): ${gc.openBlockers.map(b => `${b.severity} ${b.title} @ ${b.where}`).join('; ')}`
  if (!gc.usable || typeof gc.usable !== 'object') return 'usable is missing or malformed'
  const u = gc.usable
  if (!(u.entryPoint === true && u.roadmap === true && u.onboarding === true)) return `not user-usable (entry=${u.entryPoint} roadmap=${u.roadmap} onboarding=${u.onboarding})`
  if (gc.coverageFloorOk === false) return `coverage below the ${COVERAGE_FLOOR}% floor`
  if (gc.coverageFloorOk !== true) return 'coverageFloorOk is missing or malformed'
  if (!Array.isArray(gc.severityDowngrades)) return 'severityDowngrades is missing or malformed'
  if (gc.severityDowngrades.length) return `unjustified severity downgrade(s): ${gc.severityDowngrades.map(d => `${d.from}->${d.to} @ ${d.where}`).join('; ')}`
  if (goalCheck.verdict !== 'DONE') return 'goal-check verdict is NOT-DONE'
  return 'a DONE precondition failed'
}

const summary = {
  mission: MISSION,
  mode: MODE,
  missionTier: MISSION_TIER,
  topology: resolveTopology(MODE),
  scope: scope.metrics,
  maxConcurrent: MAX_CONCURRENT,
  agents: AGENTS,
  artifacts: { dir: ARTIFACT_DIR, deletedAtEnd: isDoneFinal },
  featureCount: features.length,
  features: allResults.map(r => ({
    id: r.feature.id, name: r.feature.name, category: r.feature.category, tag: r.feature.tag,
    tier: r.tier || resolveTier(r.feature), status: r.status,
    framework: r.feature.framework || undefined,
    coverage: r.coverage, jurors: r.jurorVerdicts,
    // F-DEPTH live writer: the DEPTH-LOCK result the SCRIBE turns into the real
    // `fixlayer=`/`tag=debug` G3.5 row + FEATURE-META tag= token (BY CONSTRUCTION).
    depthLock: r.feature.depthLock || undefined,
    openReasons: r.status === 'DONE' ? [] : ((r.panelFails && r.panelFails.length ? r.panelFails : r.reasons) || []),
  })),
  sweep: { rounds: sweepRound, roundCap: SWEEP_ROUND_CAP, totalFindings: allFindings.length, deferred, convergence: convergedReason, openReentry: openP01.length },
  deferredFeatures,
  canaryTrips,
  goalCheck: goalCheck ? {
    verdict: goalCheck.verdict,
    unmetAsks: goalCheck.unmetAsks || [],
    openBlockers: goalCheck.openBlockers || [],
    usable: goalCheck.usable || null,
    coverageFloorOk: goalCheck.coverageFloorOk,
    severityDowngrades: goalCheck.severityDowngrades || [],
  } : undefined,
  coverageFloor: COVERAGE_FLOOR,
  suggestions: allSuggestions.length ? [...new Set(allSuggestions)] : undefined,
  userQuestions: userQuestions.length ? [...new Set(userQuestions)] : undefined,
  assumed: assumed.length ? [...new Set(assumed)] : undefined,
  done: isDoneFinal,
  doneSentinel: isDoneFinal ? DONE_SENTINEL : undefined,
  verdict: isDoneFinal
    ? `All features unanimous PASS; sweep converged clean; GOAL-CHECK (independent, adversarial) confirmed zero open blockers, user-usable, coverage >= ${COVERAGE_FLOOR}%, no severity downgrade.`
    : (isDone && !goalCheckPassed
      ? `GOAL-CHECK says NOT-DONE - ${goalCheckFailReason()}; artifacts kept, re-run to continue.`
      : `${blocked.length} feature(s) not DONE${openSweepBlockers ? ` (${openP01.length} open sweep blocker(s))` : ''}${deferredFeatures ? ` (${deferredFeatures} deferred by budget guard)` : ''} / sweep not converged, logged partial; re-run to continue.`),
}

// ----- SCRIBE: append the compact run checkpoint -------------------------
phase('Scribe')
await agent(
  compactBrief('the scribe; append compact run checkpoints, never evaluate or edit code',
    `Keep the canonical root prompt ledger at "${LEDGER_DIR}/PROMPTS.txt" unchanged. Copy the approved "${ARTIFACT_DIR}/ROADMAP.md" to "${LEDGER_DIR}/ROADMAP.md". Append one line per feature/gate transition to "${LEDGER_DIR}/GATELOG.md", including persona, model selector, requested/applied effort status, verdict, elapsed scope topology, artifact path, framework, tier, and dependency frontier. Write atomically where replacing and append-only where appending. ` +
    `These three root files are the normal governance state: PROMPTS.txt, ROADMAP.md, GATELOG.md. Do NOT resolve or create a nested prompt directory for a new run. Do NOT create BRIEF.md, PLAN.md, AGENTS.md, COVERAGE.md, BACKLOG.md, ANCHOR.md, bucketlist.md, intake.md, or scope-map.md for this run. ` +
    `For every debug feature, the G3.5 line must include tag=debug fixlayer=<depthLock.frozenLayer>; append the trailing tag=debug token to its FEATURE-META fields in the same GATELOG line. ` +
    `Legacy files may exist from an older resumed run; do not delete or rewrite them. Do not touch track.md until the run is sealed and verified. RUN SUMMARY (the exact mission remains in PROMPTS.txt and is intentionally omitted here):\n${JSON.stringify({ ...summary, mission: undefined }, null, 2)}`),
  { label: 'scribe', phase: 'Scribe', agentType: PERSONA.scribe },
)

// ----- LEDGER-CHECK: the disk + substance HARD-STOP (P-01 / P-02 / P-22) -----
// The load-bearing anti-fabrication teeth that previously existed but never ran.
// The SCRIBE has just written the canonical GATELOG/ROADMAP state; NOW an
// INDEPENDENT default-FAIL leaf RUNS the standalone on-disk validator
// (autoprompt-ledger-check.js runLedgerCheck) against that state + the real -vN
// artifacts + this session's transcripts, and reconciles roadmap closure.
// gate.js is fs-less, so the validator runs in the leaf's shell; its REAL process
// EXIT CODE (1 = any P0: a gate claimed with no distinct spawn, an artifact under
// the 200-char substance floor, a SKIPPED pre-spawn handshake, a tier/framework
// mismatch, a self-review signature) and any still-open roadmap item BLOCK the
// DONE seal in code here. Legacy bucketlist closure remains readable on resume.
// A would-be DONE run whose written ledger does not
// reconcile to real substance on disk is downgraded to NOT-DONE - no sentinel, the
// supervisor re-runs. This is the seam audit-D flagged: the strongest teeth in the
// repo, finally on the live path.
const LEDGER_CHECK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['exitCode', 'p0Findings', 'openBucketlistItems'],
  properties: {
    exitCode: { type: 'integer', description: 'the EXACT process exit code of `node autoprompt-ledger-check.js --ledger-dir ... --artifact-dir ...` (0 = every claimed gate reconciles to a distinct spawn + a >=200-char on-disk artifact and no P0 lint fired; 1 = at least one P0). Report the real captured code, never a guess.' },
    p0Findings: { type: 'array', items: { type: 'string' }, description: 'every "P0 [rule] title" line the validator printed; empty ONLY when the validator exited 0' },
    openBucketlistItems: { type: 'array', items: { type: 'string' }, description: 'legacy compatibility only; new runs derive closure from ROADMAP.md and return []' },
    ranCommand: { type: 'string', description: 'the exact validator command you executed (for audit)' },
    nonce: { type: 'string', description: 'echo RUN-NONCE verbatim from your brief header' },
  },
}
let ledgerCheckPassed = false
let ledgerCheckFailReason = ''
if (isDoneFinal) {
  assertGateRouting('LEDGERCHECK', PERSONA.goalChecker, 'ledger-check')
  // Arm the P-02 skipped-handshake lint whenever a transcript dir is available:
  // gate.js wires --transcript-dir directly into the validator command so the teeth
  // do not depend on the leaf self-locating a folder. Absent (headless) => log loud,
  // omit the flag, run the reconcile + substance checks anyway (never a hard stop).
  const transcriptFlag = TRANSCRIPT_DIR ? ` --transcript-dir "${TRANSCRIPT_DIR}"` : ''
  const transcriptNote = TRANSCRIPT_DIR
    ? 'The harness resolved this session\'s transcript dir and wired --transcript-dir into the command above, so the P-02 skipped-handshake lint is ARMED - run it verbatim.'
    : 'No transcript dir was available to the harness, so --transcript-dir is omitted and the P-02 skipped-handshake lint is DISARMED this run; if you can locate this session\'s conductor transcript directory (e.g. under ~/.claude/projects/), ALSO pass --transcript-dir "<that dir>" to arm it. The reconcile + substance checks still run either way.'
  if (!TRANSCRIPT_DIR) log('LEDGER-CHECK WARNING: no transcript dir available (set AUTOPROMPT_TRANSCRIPT_DIR) - the P-02 skipped-handshake lint is DISARMED this run; reconcile + substance checks still run, and the load-time frontmatter prose remains the primary handshake gate.')
  const ledgerCheck = await agent(
    compactBrief('the LEDGER-CHECK gate; INDEPENDENT and default-FAIL; you did NOT write this ledger; RUN the on-disk provenance validator and report its EXACT captured exit code, never a guessed pass',
      `The SCRIBE has written the canonical root run ledger. RUN the standalone validator against real disk state and reconcile roadmap closure. Report REAL captured results only.\n` +
      `1. RUN THE VALIDATOR and capture its exit code VERBATIM (new runs reconcile root GATELOG persona/model/effort rows against immutable launch/casting metadata and substantive artifacts; legacy nested resumes remain readable when explicitly invoked on their prompt directory):\n` +
      `   node "${LEDGER_CHECK_PATH}" --ledger-dir "${LEDGER_DIR}" --artifact-dir "${ARTIFACT_DIR}" --run-nonce "${RUN_NONCE}" --terminal${transcriptFlag}; echo "EXITCODE=$?"\n` +
      `   ${transcriptNote} Set exitCode to the EXITCODE you captured and p0Findings to every "P0 [...]" line the validator printed.\n` +
      `2. ROADMAP CLOSURE: compare every ROADMAP.md item with the GATELOG frontier and substantive evidence. Set openBucketlistItems=[] for a closed new-format run; on a legacy resume, preserve the legacy bucketlist check.\n` +
      `Echo the RUN-NONCE. Change NOTHING: do not edit code, do not delete anything, do not write the sentinel - only run the checks and report.`,
      `${ARTIFACT_DIR}/ledger-check.md`),
    { label: 'ledger-check', phase: 'Scribe', schema: LEDGER_CHECK_SCHEMA, agentType: PERSONA.goalChecker },
  )
  if (canaryTripped(ledgerCheck)) {
    canaryTrips++
    log('CANARY: nonce mismatch at ledger-check; treating the disk validator as NOT clean (DONE blocked)')
  }
  // Default-FAIL, RECOMPUTED in code from the captured fields (never a verdict
  // string): DONE is sealed only when the validator EXITED 0, printed NO P0, and
  // closed every roadmap item (or legacy bucketlist item on resume) - a non-zero
  // exit / any P0 / any open item blocks.
  const lc = ledgerCheck || {}
  const exitClean = lc.exitCode === 0
  const p0Clean = !(Array.isArray(lc.p0Findings) && lc.p0Findings.length > 0)
  const bucketlistClean = !(Array.isArray(lc.openBucketlistItems) && lc.openBucketlistItems.length > 0)
  ledgerCheckPassed = !!ledgerCheck && exitClean && p0Clean && bucketlistClean && !canaryTripped(ledgerCheck)
  if (!ledgerCheckPassed) {
    if (!ledgerCheck) ledgerCheckFailReason = 'ledger-check did not run'
    else if (!exitClean) ledgerCheckFailReason = `disk validator exited ${lc.exitCode} (P0 provenance finding)`
    else if (!p0Clean) ledgerCheckFailReason = `P0 provenance finding(s): ${lc.p0Findings.join('; ')}`
    else if (!bucketlistClean) ledgerCheckFailReason = `open legacy bucketlist item(s): ${lc.openBucketlistItems.join('; ')}`
    else ledgerCheckFailReason = 'ledger-check canary trip (nonce mismatch)'
    log(`LEDGER-CHECK blocked DONE: ${ledgerCheckFailReason}`)
  }
}

// P-22 (non-blocking dispatch, in-harness teeth): replay the dispatch ledger - a wave of
// independent ready work that ran SERIALLY while the mode supported parallel fan-out blocks
// the DONE seal, exactly like an open roadmap item. Serial now means TWO things: a serial
// dispatch DECISION (the wave's isParallel flag) and an observed serial COLLAPSE (the
// wave's measured peakLive never reached its achievableWidth - a parallel-flagged wave
// that physically ran spawn-wait-spawn behind blocking spawns). On a genuinely concurrent
// runtime this is always empty, so it only ever fires on a serialization regression -
// spawn-all-then-collect, by construction AND by measurement.
const serialDispatchViolations = serialDispatchFindings(dispatchLedger)
if (serialDispatchViolations.length) {
  log(`P-22 SERIAL-DISPATCH blocked DONE: ${serialDispatchViolations.length} independent wave(s) ran serially - ${serialDispatchViolations.map(v => v.title).join(' | ')}`)
}
summary.serialDispatchFindings = serialDispatchViolations
// The recorded dispatch waves (intended AND observed shape) are run evidence:
// operators, the ledger, and E2E harnesses read peakLive vs achievableWidth to
// prove fan-out happened rather than trusting a concurrency claim.
summary.dispatchWaves = dispatchLedger.map(wave => ({ ...wave }))

// The DONE seal is now the goal-check AND the on-disk ledger validator AND a proof that
// no independent work was dispatched serially (spawn-all-then-collect).
const isDoneSealed = isDoneFinal && ledgerCheckPassed && serialDispatchViolations.length === 0
summary.done = isDoneSealed
summary.doneSentinel = isDoneSealed ? DONE_SENTINEL : undefined
summary.artifacts.deletedAtEnd = isDoneSealed
if (isDoneFinal && !isDoneSealed) {
  summary.verdict = !ledgerCheckPassed
    ? `LEDGER-CHECK blocked DONE - the on-disk provenance validator did not pass (${ledgerCheckFailReason}); artifacts kept, re-run to continue.`
    : `SERIAL-DISPATCH blocked DONE - ${serialDispatchViolations.length} independent dispatch wave(s) ran serially (P-22 non-blocking dispatch violated); artifacts kept, re-run to continue.`
}

// ----- JANITOR: artifacts live for the whole session, deleted only at DONE --
// The JANITOR/SCRIBE subagent (never the parent) also writes the DONE-sentinel
// the external supervisor polls - only on a genuinely DONE + disk-sealed run,
// atomically.
if (isDoneSealed) {
  assertGateRouting('JANITOR', PERSONA.janitor, 'janitor')
  await agent(
    compactBrief('the janitor, end-of-run cleanup; write the DONE-sentinel, then delete the scratch artifacts, touch nothing else',
      `The run is DONE and the canonical root ledger is written.\n` +
      `1. Write the DONE-sentinel ATOMICALLY (binding F2/F6): write the JSON {"done": true, "nonce": "${RUN_NONCE}", "verdict": "${(summary.verdict || 'DONE').replace(/"/g, "'").slice(0, 200)}", "ts": "<output of \`date -Iseconds\` or \`date\`>"} to "${DONE_SENTINEL}.tmp" then \`mv\` (rename) it to "${DONE_SENTINEL}" - write-temp-then-rename so a reader never sees a half-written file. NEVER write the sentinel if the run were not DONE; it is the supervisor's halt signal.\n` +
      `2. THEN delete the artifact directory "${ARTIFACT_DIR}" entirely, and "${LEDGER_DIR}/.artifacts" too if it is now empty. ` +
      `NEVER touch PROMPTS.txt, ROADMAP.md, GATELOG.md, track.md, the DONE-sentinel you just wrote, or any project code. ` +
      `BEFORE deleting, verify "${LEDGER_DIR}" contains non-empty PROMPTS.txt, ROADMAP.md, and GATELOG.md; if any is missing or empty, do NOT delete anything and report the gap instead. ` +
      `Report under 40 words: the sentinel path, what you deleted, what you kept.`),
    { label: 'janitor', phase: 'Scribe', agentType: PERSONA.janitor },
  )
} else {
  log(`Run not fully DONE - artifacts kept at ${ARTIFACT_DIR} as the resume checkpoint (the janitor only runs on a DONE run).`)
}

return summary
