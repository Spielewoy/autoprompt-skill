#!/usr/bin/env node
// FX-INTEGRITY FIX-05 + FIX-06 - the STANDALONE, cross-session provenance
// validator. The in-harness seal (autoprompt-gate.js sealDoneProvenance) is the
// THIS-SESSION spawn-linkage authority; this file is the CROSS-SESSION on-disk
// authority. For new runs it reconciles each compact GATELOG.md gate row's
// inline persona/model/effort provenance against a matching artifact. Legacy
// resumes may instead use the older GATELOG.md + AGENTS.md split. It also flags
// the F5-18 one-context self-review signature (one transcript that both edits a
// production file and runs that feature's verify/goal-check test).
//
// Runs at 0% user input, read-only on the ledger + transcripts, non-destructive:
// it writes only its own findings to stdout and exits 0 (clean) or 1 (a P0
// finding). git fully restores the tree.
//
// SCOPE: ONLY the FIX-05 reconcile + the FIX-06 F5-18 rule are implemented. The
// six FX-HIERARCHY linter rules (FIX-10/11/12/13/14/17) are OUT OF SCOPE; the
// RULE_REGISTRY is left extensible so they append with zero rework.
//
// Usage: node autoprompt-ledger-check.js --ledger-dir <dir> --artifact-dir <dir> --transcript-dir <dir>
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// SPD-4 / P-26: the prose decision tree in agents/claude/frameworks/README.md is now the
// SINGLE routing source of truth (the competing framework-selector.js was deleted).
// The pure leaf<->tier consistency helper - a lint concern, not a routing concern -
// lives here so the frameworkTierFindings rule keeps its teeth with no external dep.
// LEAF_TIER_BANDS: each seeded leaf's allowed tier band, transcribed VERBATIM from
// README §1. A recorded tier OUTSIDE its leaf's band is the FRAMEWORK-TIER MISMATCH.
const LEAF_TIER_BANDS = {
  'apply': ['T0', 'T1'],
  'backend-fix': ['T1', 'T2'],
  'backend-implement': ['T2'],
  'backend-build': ['T2', 'T3'],
  'frontend-fix': ['T1', 'T2'],
  'frontend-implement': ['T2'],
  'frontend-build': ['T2', 'T3'],
  'frontend-review': ['T1', 'T2', 'T3'],
  'polish': ['T1', 'T2'],
  'refactor': ['T1', 'T2'],
  'docs': ['T0', 'T1', 'T2'],
  'plan-scope': ['T2', 'T3'],
  'plan-research': ['T2'],
  'plan-design': ['T2'],
}
// leafTierConsistent(leaf, tier) -> { known, ok }. PURE, total. `known` is true ONLY
// when BOTH the leaf is a seeded band entry AND the tier is a recognized token (T0..T3),
// so the rule fails-closed on an unknown/generated leaf or an unparseable tier. When
// known, `ok` is true IFF the leaf's band admits the tier. Garbage -> { known:false, ok:false }.
const RECOGNIZED_TIERS = new Set(['T0', 'T1', 'T2', 'T3'])
function leafTierConsistent(leaf, tier) {
  const band = typeof leaf === 'string' ? LEAF_TIER_BANDS[leaf] : undefined
  if (!Array.isArray(band) || typeof tier !== 'string' || !RECOGNIZED_TIERS.has(tier)) {
    return { known: false, ok: false }
  }
  return { known: true, ok: band.includes(tier) }
}

// The canonical gate->expected-persona map. Kept in lockstep with the same
// constant in autoprompt-gate.js (gate.js is an ES module and cannot be
// require()d here, so the two copies are duplicated by necessity). A claimed
// gate backed by a spawn under a DIFFERENT persona is a substitution.
const GATE_EXPECTED_PERSONA = {
  G1: 'ap-planner', G2: 'ap-reviewer', G3: 'ap-fresh-verifier',
  'G3.5': 'ap-depth-prober',
  G4: 'ap-implementer', G5: 'ap-reviewer', G6: 'ap-verifier',
  G7: 'ap-juror', G8: 'ap-scribe',
}

// A GATELOG verdict counts as a PASS-family claim (and therefore demands a spawn
// + an artifact) only when it carries one of these tokens. SMASH/FAILED/REJECT
// rows record a failed attempt and are never required to be backed.
const PASS_VERDICT_RE = /\b(PASS|VERIFIED|APPROVE|UNANIMOUS|COMPLETE|DONE)\b/i

// A real test-runner invocation (same family as gate.js REAL_RUNNER_RE / FIX-01).
const REAL_RUNNER_RE = /\b(pytest|py\.test|python -m pytest|unittest|nose2?|tox|go test|jest|mocha|cargo test)\b/

// PLAN-substance-provenance - a PASS verdict is legitimate only when its artifact
// carries real, re-derivable substance (CONV-38 anti-fabrication). A capture gate
// (G3/G6) PASS rests on a captured run (a real runner token OR the structured verify-
// schema green field); a bare fence/row count NEVER substantiates the capture leg (v3).
const MIN_SUBSTANCE_CHARS = 200      // non-whitespace body chars below this == stub/hollow
const MIN_CAPTURE_ITEMS = 1          // a clean/zero-gap claim needs >=1 SUBSTANTIVE captured item
const MIN_FENCE_CONTENT_CHARS = 12   // a fenced block below this (no runner/exit/pass) is decorative
const GATE_SUBSTANCE_KIND = {
  G1: 'prose', G2: 'prose', G3: 'capture', G4: 'prose',
  'G3.5': 'prose',
  G5: 'prose', G6: 'capture', G7: 'prose', G8: 'prose',
}
const BROAD_RUNNER_RE = /\b(pytest|py\.test|python -m pytest|unittest|nose2?|tox|go test|jest|mocha|vitest|bun test|deno test|cargo test|rspec|bundle exec rspec|phpunit|dotnet test|gradle(\.\w+)? test|mvn(\.\w+)? test|ctest)\b|\bnode\b[^\n`]*\.test\.[cm]?js\b|\bc8\b|\bnyc\b/i
const VERIFY_GREEN_RE = /\breproNowGreen\s*[=:]\s*true\b|\btestCommand\s*[=:]/i
const VERIFY_EVIDENCE_RE = /\bcoveragePercent\b|\brunnerInvocation\b|\bexit\s*[=:]\s*0\b|\bexit code\s*0\b/i
const VERIFY_NOT_GREEN_RE = /\breproNowGreen\s*[=:]\s*false\b/i
const REGRESSIONS_NONEMPTY_RE = /\bpreExistingRegressions\s*[=:]\s*\[\s*[^\]\s]/i
const CLEAN_CLAIM_RE = /\bhardGapCount\s+0\b|\b(0|zero)\s+(hard\s+)?gaps?\b|\bno\s+(hard\s+)?gaps?\b|\ball[-\s]?pass(ed|ing)?\b/i
const COUNT_CLAIM_RE = /\bhardGapCount\s+(\d+)\b|\b(\d+)\s+(?:hard\s+)?gaps?\b|\b(\d+)\s+of\s+(\d+)\b/i

// SPEC-3 (PLAN-spec3) commit-doctrine constants. FEATURE_ID_RE tolerates the real id
// forms (F1, F01, FX-KEYSTONE, F-LIB-COPY). GOALCHECK_DONE_RE marks a GOAL-CHECK line;
// a DONE seal additionally needs /\bDONE\b/ and NOT /\bNOT-?DONE\b/i. GIT_ADD_ALL_RE
// matches bulk staging (-A/--all/.) but not an explicit pathspec. COMMIT_ROW_RE is the
// rule-8 checkpoint row, with __RUN__ (single-feature seal) as the first alternative.
const FEATURE_ID_RE = /\bF(?:X-[A-Z0-9-]+|-[A-Z0-9-]+|\d+)\b/
const GOALCHECK_DONE_RE = /GOAL-?CHECK\b/i
const GIT_ADD_ALL_RE = /\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/
const GIT_COMMIT_RE = /\bgit\s+commit\b/
const COMMIT_ROW_RE = /^COMMIT\s+(__RUN__|F(?:X-[A-Z0-9-]+|-[A-Z0-9-]+|\d+))\s+([0-9a-f]{7,40})\s+branch=(\S+)\s+push=(\S+)/

// PLAN-no-idle-pushwork - lean-as-idle detection. A turn is a lean-as-idle excuse when
// it carries a lean token AND an idle/wait token AND NO legitimate dependency/
// convergence justification.
const LEAN_TOKEN_RE = /\b(stay(?:ing)?\s+lean|keep(?:ing)?\s+(?:it\s+)?lean|lean(?:ness)?)\b/i
const IDLE_TOKEN_RE = /\b(wait(?:ing)?|idl(?:e|ing)|nothing\s+to\s+(?:do|dispatch)|standing\s+by|hold(?:ing)?\s+off)\b/i
const LEGIT_WAIT_RE = /\b(BLOCKED|depends?\s+on|needs?\s+\S|ALL\s+CONVERGED|dependenc(?:y|ies)|dependent|gate[- ]order)\b/i

// PLAN-lean-L0-coordinator - the L0 conductor must stay LEAN: ingest <=150-word
// verdicts, never full gate detail. An over-budget tool_result (or one carrying a diff
// / test-runner dump), or a fleet-state table rebuilt across turns, is parent-side
// synthesis that belongs to the COORDINATOR.
const VERDICT_BUDGET_CHARS = 1200            // ~150-200 words; the <=150-word report budget
const DIFF_RE = /^(diff --git |@@ |\+\+\+ |--- )/m
const FLEET_ROW_RE = /\bF\d+\b[^\n]*\b(in[- ]?flight|pending|done|blocked|PASS|SMASH|G[1-8])\b/i
const FLEET_ROW_MIN = 3                       // <3 rows = an incidental mention, not a rebuilt table
const FLEET_TABLE_TURN_MIN = 2                // rebuilt across >=2 turns = accumulation, not a one-off

// PLAN-liveness-reconcile (FIX-016-2 / P18) - per-turn liveness reconcile constants.
// RUNNING_NARRATION_RE matches the narrate-as-running-SUBAGENT shape ONLY (not a
// generic "running the test suite"). AGENT_ID_RE extracts a poll's target id to bind it
// to the claimed id. FEATURE_LABEL_RE (v4 narrowed) matches ONLY FX-/SPEC- frontier
// keys. DEAD_SIGNAL_RE marks a poll RESULT that proves an agent is dead.
const RUNNING_NARRATION_RE =
  /\b(still running\.?\s*holding|running\s*\(\s*\d|in flight|agents? (are|is) coming back|standing by for|waiting (for|on)\b[^.]{0,48}\b(subagent|agent|report|scout|spec|reader|worker|supervisor)|awaiting\b[^.]{0,40}\b(subagent|agent|report)|holding (for|on)\b[^.]{0,40}\b(report|agent|worker))/i
const BASH_POLL_RE = /\b(pgrep|ps -ef|ps aux|ps -e|ps -a|\bjobs\b)\b/
const POLL_TOOL_NAMES = new Set(['TaskOutput', 'BashOutput'])
const POLL_READ_RE =
  /(^|[\/\\])(AGENTS\.md|RESUME\.md|resume\.md|resume\.json|ANCHOR\.md|[A-Za-z0-9-]*frontier[A-Za-z0-9-]*\.md)$/i
const AGENT_ID_RE = /\b(F\d{1,3}|(?:ap|cl)-[a-z0-9]+(?:-[a-z0-9]+)*|sub-[a-z0-9]+(?:-[a-z0-9]+)*)\b/gi
const FEATURE_LABEL_RE = /\b(FX-[A-Z][A-Z0-9]+|SPEC-\d{1,3})\b/g
const DEAD_SIGNAL_RE = /\b(no such process|not running|stalled|connection ?refused|econnrefused|exited|killed|terminated|appears stalled)\b/i
const LIVENESS_FRESH_WINDOW_MS = 15 * 60 * 1000
const FRONTIER_LIVE_RE = /\b(in[- ]?flight|alive|live|running|G[1-7]\b|not[- ]?(?:sealed|complete)|incomplete)\b/i
const FRONTIER_DEAD_RE = /\b(sealed|complete|completed|done|closed|merged|landed|shipped|G8|VERIFIED|sign-?off)\b/i
const TRANSCRIPT_DONE_RE = /\b(LOOP-DONE|DONE-SENTINEL|wrote .*done|terminated|process exited)\b/i

// FIX-016 (false-negative liveness, the MIRROR of livenessReconcileFindings). A turn concluding a spawned
// agent is dead/absent - distinct from the false-POSITIVE "Running…" narration. Keyed on dead/absent/gone +
// re-spawn vocabulary so a slow-but-alive agent declared dead from disk-absence is caught.
const DEAD_CONCLUSION_RE = /\b(appears? (?:dead|absent|gone)|looks? (?:dead|absent)|(?:is|seems?) (?:dead|absent|gone|missing)|no (?:artifact|plan|output|file)s? (?:yet|written|present|on disk)|nothing on disk|produced no (?:artifact|plan|output)|must have (?:died|crashed)|treating (?:it |this )?as (?:dead|absent)|declaring (?:it |this )?dead|re-?spawn(?:ing)?|spawning a (?:replacement|duplicate|second)|duplicate (?:agent|spawn))/i
// A task-status poll result that proves the agent is GENUINELY GONE (dead OR completed-without-artifact).
// Reuses DEAD_SIGNAL_RE's death markers PLUS a completed/exited-0 done marker - the only sound basis for a
// dead conclusion. A "running"/"in progress"/live-PID result is NOT here (alive-in-progress).
const TASK_STATUS_DEAD_RE = /\b(no such process|not running|killed|terminated|exited(?:\s+(?:0|[1-9]\d*))?|completed|done|finished|process exited)\b/i

// PLAN-time-optimization - serialGateFindings (P1) constants. A BILLIONAIRE feature-manager must dispatch a
// STATICALLY-INDEPENDENT gate pair concurrently (one batched turn), never serially (two turns). The pairs are
// independent by gate contract: {G2 plan-review, G3 fresh-verify} and {G5 impl-review, G6 verify}. The gate
// label is read PER-TURN from each spawn's description - NOT a flat count (the unsound lint the prior G3s
// rejected). Detection is priority-ordered so "fresh-verify" classifies as G3, never G6.
const INDEPENDENT_GATE_PAIRS = [['G2', 'G3'], ['G5', 'G6']]

// serialFeatureFindings (PLAN-autoprompt-enforcement) constants. The mission's literal headline
// is "always fewer than 6 subagents" - a WIDTH throttle at the FEATURE tier. Below the floor never
// fires (proportionality). Feature independence is DECLARED (NOT static like gate pairs) -> the rule
// reads the mandatory DECOMPOSE rows for the cohort; a legacy/malformed ledger with no rows
// fail-closes (no cohort, no finding) as a defensive guard only.
const SERIAL_FEATURE_FLOOR = 6
// FID_RE_SRC: the ONE canonical feature-id grammar (GATES.md feature ids). Four forms:
//   F-digit  F1 .. F999          (\d{1,3})
//   FX-NAME  FX-FOO              (X-[A-Z][A-Z0-9]*)
//   F-NAME   F-QUAL / F-DEPTH    (-[A-Z][A-Z0-9]*)   <- the form v1 dropped at the parser
//   SPEC-n   SPEC-3              (SPEC-\d{1,3})
// The NAME bodies are [A-Z][A-Z0-9]* - letters/digits, NO embedded hyphen. This is
// load-bearing for the FILENAME matcher: a hyphen-permissive body would greedily eat the
// "-NN" turn-index suffix of `sub-ap-manager-F-QUAL-01.jsonl` and capture `F-QUAL-01`.
// The no-hyphen body stops cleanly at the '-' before the turn index -> `F-QUAL`. In a
// ledger row the trailing `\s+phase=`/`\s+wave=` delimits, so the same body is correct there.
// EVERY parser that lifts an FID derives from THIS string. Drift is impossible by construction
// and asserted by a drift-guard test against the pre-existing FEATURE_META_RE / FEATURE_TARGET_RE.
const FID_RE_SRC = 'F(?:X-[A-Z][A-Z0-9]*|-[A-Z][A-Z0-9]*|\\d{1,3})|SPEC-\\d{1,3}'
// FEATURE_DECL_RE: parse a DECOMPOSE ledger row ([at …] prefix stripped before matching):
//   DECOMPOSE <FID> phase=<token> deps=<none|FID[,FID...]> owns=<path[,path...]>
// Derives from FID_RE_SRC (Change 1) - F-digit/SPEC match byte-identically to the prior form;
// the FX arm relaxes to a 1-char name; the ONLY genuinely new admission is the F-NAME arm.
const FEATURE_DECL_RE = new RegExp(`^DECOMPOSE\\s+(${FID_RE_SRC})\\s+phase=(\\S+)\\s+deps=(\\S+)\\s+owns=(\\S+)`)
// DISPATCH_RE: parse a mandatory DISPATCH ledger row ([at …] prefix stripped first):
//   DISPATCH <FID> wave=<W>
// The GUARANTEED firing signal - width is grouped by wave from these rows ALONE, never from prose
// descriptions (which a mission-first run leaves FID-less). Derives from the SAME FID_RE_SRC so the
// DECOMPOSE cohort and the DISPATCH width can never drift on the id grammar.
const DISPATCH_RE = new RegExp(`^DISPATCH\\s+(${FID_RE_SRC})\\s+wave=(\\S+)`)

// SPD-1 (tierProportionalityFindings) - the machine-readable per-feature row
// derived from ROADMAP.md on new runs, or INTAKE on a legacy resume, beside any
// DECOMPOSE/COMMIT rows: `FEATURE-META <FID> tier=<T0|T1|T2|T3> framework=<leaf> issues=<N> [tag=<playbook>]`.
// The single-file derivation reuses the DECOMPOSE owns= set (NOT a field here). Byte-exact to GATES.md.
// The OPTIONAL trailing `tag=` captures the authoritative playbook classification
// (debug/research/...) - depthLockFindings keys "is this a debug feature" on THIS
// recorded metadata, NOT on a self-applied inline token an author can omit. The feature-id group accepts the F-NAME
// shape (F-DEPTH/F-PYL) as well as F123/FX-NAME/SPEC-N (mirrors FEATURE_TARGET_RE) so a real run parses.
const FEATURE_META_RE = /^FEATURE-META\s+(F(?:X-[A-Z0-9-]+|-[A-Z0-9-]+|\d+)|SPEC-\d{1,3})\s+tier=(T[0-3])\s+framework=(\S+)\s+issues=(\d+)(?:\s+tag=([A-Za-z][A-Za-z-]*))?/
// The over-tiering ceremony rows attributed to a feature (DIAGNOSIS §3 reproducible tax). A
// SCOPE-AND-ROADMAP or SCOPE row, or a whole-mission END-VERDICT, attributed to a single-file
// single-issue feature is over-tiering. plan-scope as a feature's recorded framework is the same signal.
const SCOPE_ROW_RE = /^SCOPE(?:-AND-ROADMAP)?\s+(F\d{1,3}|FX-[A-Z][A-Z0-9]+|SPEC-\d{1,3})\b/
const END_VERDICT_ROW_RE = /^END-VERDICT\s+(F\d{1,3}|FX-[A-Z][A-Z0-9]+|SPEC-\d{1,3})\b/
// A single-file feature ran a 3-juror G7 panel when >= this many G7 SIGN-OFF rows are attributed to it.
const THREE_JUROR_PANEL = 3

// SUPERVISOR_WAVE_FLOOR (PLAN-supervisor-collapse): a SECOND ap-feature-coordinator in ONE L0 wave
// is already the supervisor-per-feature anti-pattern - there is only ever ONE feature-build scope
// per run, so >=2 feature-supervisors batched in a single conductor turn is the defect.
const SUPERVISOR_WAVE_FLOOR = 2

// PLAN-proportional-gates - the mission's core fix made structural. A run must NOT
// wrap mechanical/frozen-spec application or batchable homogeneous units in per-unit
// full pipelines. PROPORTIONAL_SIBLING_FLOOR is the minimum count of sibling features
// that each ran a full G1..G8 pipeline over ONE shared file before ARM B fires.
// DESIGN_GATES are the G1-G3 design cycle; FULL_PIPELINE_GATES is the complete ladder.
// The frozen plan is recognized by the canonical <feature>-plan-final.md name OR a
// <feature>-fresh-verify*.md artifact whose body carries APPROVE (FROZEN_FRESHVERIFY_RE /
// FRESHVERIFY_APPROVE_RE). FEATURE_TARGET_RE extracts the explicit per-feature target token.
const PROPORTIONAL_SIBLING_FLOOR = 3
const DESIGN_GATES = ['G1', 'G2', 'G3']
const FULL_PIPELINE_GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']
const FROZEN_FRESHVERIFY_RE = /-fresh-?verify.*\.md$/i
const FRESHVERIFY_APPROVE_RE = /\bAPPROVE\b/
const FEATURE_TARGET_RE = /\b(F(?:X-[A-Z0-9-]+|-[A-Z0-9-]+|\d+))\b[^\n]*?\b(?:target|file)=(\S+)/

// F-DEPTH (depthLockFindings, P0) - the DEPTH-LOCK mechanical teeth. DEPTHLOCK_D3_RE
// pulls the independently-derived deepest-cause function from a depth-lock artifact's
// `D3:` line (file.py::function, tolerating Class.method). DEPTHLOCK_FIXLAYER_RE pulls
// the frozen fix-layer token from a GATELOG G3.5/G4 row. DEPTHLOCK_D4_RED_RE proves the
// D4 adversarial repro was captured RED. DEPTHLOCK_PYFN_RE is the file.py::function shape
// the layer-equality compares on (normalized to ignore decorative trailing text).
const DEPTHLOCK_D3_RE = /^\s*D3[:\s][^\n]*?([A-Za-z0-9_./-]+\.py::[A-Za-z0-9_.]+)/m
const DEPTHLOCK_FIXLAYER_RE = /\bfixlayer=([A-Za-z0-9_./:.-]+)/
const DEPTHLOCK_D4_RED_RE = /\bD4\b[\s\S]*?\bRED\b/i

// PLAN-fanout-fix - thinSprawlFindings constants. THIN_SPRAWL_REPEAT identical
// (persona, description) spawns in one transcript is a templated 1-per-query sprawl.
// L3_MAY_FAN_OUT are the only L3 executor personas that legitimately dispatch their
// own L4 leaves; any OTHER L3-named transcript that spawned is a recursion smell.
const THIN_SPRAWL_REPEAT = 5
const L3_MAY_FAN_OUT = new Set(['ap-implementer', 'ap-intake'])
const L3_NON_SPAWNING = new Set([
  'ap-planner', 'ap-reviewer', 'ap-verifier', 'ap-scoper', 'ap-synthesizer',
  'ap-researcher', 'ap-sweeper', 'ap-execharness-resolver', 'ap-framework-generator',
])

// parseLedgerLines: tolerant line parser for a GATELOG.md or AGENTS.md file.
// kind === 'gatelog' -> rows of the form
//   [at HH:MM DD.MM.YYYY] <FEATURE> <GATE> <NAME> (<persona>): <VERDICT> - artifact <file>
// kind === 'agents'   -> rows of the form
//   [at HH:MM DD.MM.YYYY] <persona> (<GATE>, <Lx>): <description> ... Artifact <file>.
// Unparseable lines are collected in `malformed` (fail-closed: never synthesized
// into a backing). Returns { records, malformed }.
function parseLedgerLines(text, kind) {
  const records = []
  const malformed = []
  const lines = (typeof text === 'string' ? text : '').split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (!line.startsWith('[at ')) continue
    const body = line.replace(/^\[at[^\]]*\]\s*/, '')
    if (kind === 'gatelog') {
      const rec = parseGatelogRow(body)
      if (rec) records.push(rec)
      else malformed.push(line)
    } else if (kind === 'agents') {
      const rec = parseAgentsRow(body)
      if (rec) records.push(rec)
      else malformed.push(line)
    }
  }
  return { records, malformed }
}

// A GATELOG row: <FEATURE> ... <GATE> ... (<persona>...): <VERDICT...> - artifact(s) <files>
// FEATURE is the leading token (F1, F2, ...). GATE is the first G\d token.
// persona is the first ap-* token inside parentheses. verdict is the text after
// the first colon up to the em-dash/artifact pointer. Artifacts are every
// <id>-*.md filename mentioned. A row missing a feature or gate is malformed.
function parseGatelogRow(body) {
  const featureMatch = body.match(/^(F(?:X-[A-Z0-9-]+|-[A-Z0-9-]+|\d+))\b/)
  if (!featureMatch) return null
  const gateMatch = body.match(/\b(G[1-8](?:\.\d+)?)\b/)
  if (!gateMatch) return null
  const personaMatch = body.match(/\(((?:ap|cl)-[a-z-]+)\)/)
  const persona = personaMatch ? personaMatch[1] : ''
  const colonIdx = body.indexOf(':')
  const afterColon = colonIdx >= 0 ? body.slice(colonIdx + 1) : body
  const verdict = afterColon.split(/[--]/)[0].trim()
  const artifacts = (body.match(/[A-Za-z0-9_]+-[A-Za-z0-9_.-]+\.md/g) || [])
  // F-DEPTH: capture the optional debug tag + the frozen fix-layer token, mirroring
  // deriveFeatureTargets' explicit-token discipline (fail-closed: an absent token is '').
  const tagMatch = body.match(/\btag=([A-Za-z0-9_-]+)/)
  const fixlayerMatch = body.match(DEPTHLOCK_FIXLAYER_RE)
  const modelMatch = body.match(/\bmodel=([^\s:]+)/)
  const effortMatch = body.match(/\beffort=([^\s:]+(?::[^\s:]+)?)/)
  return {
    feature: featureMatch[1], gate: gateMatch[1], persona, verdict, artifacts,
    tag: tagMatch ? tagMatch[1] : '',
    fixlayer: fixlayerMatch ? fixlayerMatch[1] : '',
    model: modelMatch ? modelMatch[1] : '',
    effort: effortMatch ? effortMatch[1] : '',
  }
}

// An AGENTS row: <persona> (<GATE>..., <Lx>): <desc> ... Artifact <file>.
function parseAgentsRow(body) {
  const personaMatch = body.match(/^((?:ap|cl)-[a-z-]+)/)
  if (!personaMatch) return null
  const gateMatch = body.match(/\b(G[1-8](?:\.\d+)?)\b/)
  return {
    persona: personaMatch[1],
    gate: gateMatch ? gateMatch[1] : '',
    artifacts: (body.match(/[A-Za-z0-9_]+-[A-Za-z0-9_.-]+\.md/g) || []),
  }
}

// parseGoalCheckRows (SPEC-3): the terminal-seal scanner. Scans RAW lines (independent
// of parseGatelogRow so heterogeneous prefixes parse). A line is a DONE seal when it
// matches GOALCHECK_DONE_RE AND /\bDONE\b/ AND NOT /\bNOT-?DONE\b/i. Feature id via
// FEATURE_ID_RE; a run-level DONE seal with no id -> { feature: '__RUN__' }. Deduped.
// [] on non-string (fail-closed).
function parseGoalCheckRows(text) {
  if (typeof text !== 'string') return []
  const seen = new Set()
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\[at[^\]]*\]\s*/, '').trim()
    if (!GOALCHECK_DONE_RE.test(line)) continue
    if (!/\bDONE\b/.test(line) || /\bNOT-?DONE\b/i.test(line)) continue
    const m = line.match(FEATURE_ID_RE)
    const feature = m ? m[0] : '__RUN__'
    if (seen.has(feature)) continue
    seen.add(feature)
    out.push({ feature })
  }
  return out
}

function parseGoalCheckFrontiers(text) {
  const frontiers = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\[at[^\]]*\]\s*/, '').trim()
    if (!GOALCHECK_DONE_RE.test(line)) continue
    const featureMatch = line.match(FEATURE_ID_RE)
    if (!featureMatch) continue
    const isDone = /\bDONE\b/.test(line) && !/\bNOT-?DONE\b/i.test(line)
    frontiers.push({ feature: featureMatch[0], isDone })
  }
  return frontiers
}

// parseCommitRows (SPEC-3): scans the SAME raw GATELOG text; strips the [at …] prefix,
// applies COMMIT_ROW_RE; on match pushes { feature, sha, branch, push }. [] on
// non-string (fail-closed).
function parseCommitRows(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\[at[^\]]*\]\s*/, '').trim()
    const m = COMMIT_ROW_RE.exec(line)
    if (m) out.push({ feature: m[1], sha: m[2], branch: m[3], push: m[4] })
  }
  return out
}

// commitCheckpointFindings (SPEC-3 - commit doctrine, GATES.md G8): P1 (surfaced, does
// NOT flip ok). ARM A - a sealed feature (GOAL-CHECK DONE) with no COMMIT row, or with a
// deferred push, is a recoverability gap. ARM B - any transcript with a bulk `git add`
// is a feature-scoping breach. Fail-closed on non-array ctx fields.
function commitCheckpointFindings(ctx) {
  const findings = []
  const goalChecks = Array.isArray(ctx.goalChecks) ? ctx.goalChecks : []
  const commits = Array.isArray(ctx.commits) ? ctx.commits : []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  const commitByFeature = new Map()
  for (const c of commits) if (c && c.feature) commitByFeature.set(c.feature, c)
  for (const seal of goalChecks) {
    if (!seal || !seal.feature) continue
    const commit = commitByFeature.get(seal.feature)
    if (!commit) {
      findings.push({
        severity: 'P1',
        rule: 'commitCheckpointFindings',
        title: `sealed ${seal.feature} (GOAL-CHECK DONE) has no COMMIT row - each feature must commit AND push at its end and record the checkpoint (commit doctrine, GATES.md G8); RESUME cannot fall back to this boundary.`,
      })
      continue
    }
    const push = String(commit.push || '')
    if (/^deferred:/.test(push)) {
      findings.push({
        severity: 'P1',
        rule: 'commitCheckpointFindings',
        title: `sealed ${seal.feature} committed but push deferred (${push.replace(/^deferred:/, '')}) - the remote checkpoint is missing; resolve the branch/remote and push (rules 4-6).`,
      })
    }
  }
  for (const t of transcripts) {
    if (!t || typeof t !== 'object') continue
    if (t.hasGitAddAll === true) {
      findings.push({
        severity: 'P1',
        rule: 'commitCheckpointFindings',
        title: `\`git add -A\`/\`.\` in ${t.path || '(unknown transcript)'} - staging must be feature-scoped by explicit pathspec (rule 2); a bulk add sweeps unrelated changes into the checkpoint.`,
      })
    }
  }
  return findings
}

// reconcileProvenance (FIX-05 core): for every GATELOG PASS-family row, require
// (a) AGENTS.md carries the gate's expected persona for that feature AND (b) at
// least one of the row's artifact files exists on disk. A breach is a P0
// `fabricated <gate> attestation` finding. PERMISSIVE-ON-ABSENCE: a gate absent
// from GATELOG is never synthesized or required. artifactExists is injected so
// tests run without touching disk; the CLI passes a real fs-backed checker.
const PERSONA_CASTING_TIER = {
  'ap-planner': 'R3', 'ap-reviewer': 'R2', 'ap-fresh-verifier': 'R2',
  'ap-depth-prober': 'R2', 'ap-implementer': 'R3', 'ap-verifier': 'R2',
  'ap-juror': 'R2', 'ap-scribe': 'R4',
}
const MODEL_SELECTOR_BY_TIER = { R2: 'sonnet', R3: 'sonnet', R4: 'haiku' }
const EFFORT_BY_TIER = { R2: 'xhigh', R3: 'high', R4: 'medium' }
const MAXIMUM_EFFORT_PERSONAS = new Set([
  'ap-reviewer', 'ap-fresh-verifier', 'ap-verifier', 'ap-juror',
  'ap-depth-prober', 'ap-planner',
])

function expectedEffortForRow(row, launchBinding) {
  const effort = launchBinding && launchBinding.effort
  if (!effort || typeof effort.status !== 'string') return ''
  if (effort.status !== 'selectable') return effort.status
  const tier = PERSONA_CASTING_TIER[row.persona]
  const requestedEffort = MAXIMUM_EFFORT_PERSONAS.has(row.persona)
    ? effort.maximum
    : EFFORT_BY_TIER[tier]
  const selected = resolveAcceptedEffort(requestedEffort, effort)
  return typeof selected === 'string' && selected !== ''
    ? `selectable:${selected}`
    : ''
}

function resolveAcceptedEffort(requestedEffort, capability) {
  const acceptedValues = capability.acceptedValues
  if (!Array.isArray(acceptedValues) || acceptedValues.length === 0) {
    return requestedEffort
  }
  if (acceptedValues.includes(requestedEffort)) return requestedEffort

  return acceptedValues.reduce((closest, candidate) => {
    const closestDistance = Math.abs(
      effortRank(closest) - effortRank(requestedEffort),
    )
    const candidateDistance = Math.abs(
      effortRank(candidate) - effortRank(requestedEffort),
    )
    return candidateDistance < closestDistance
      ? candidate
      : closest
  }, capability.maximum)
}

function effortRank(effort) {
  return ['low', 'medium', 'high', 'xhigh'].indexOf(effort)
}

function expectedModelForRow(row, launchBinding) {
  if (launchBinding && launchBinding.enabled === false) return 'inherit'
  return MODEL_SELECTOR_BY_TIER[PERSONA_CASTING_TIER[row.persona]] || ''
}

function launchProvenanceFindings(row, launchBinding) {
  if (!launchBinding || typeof launchBinding !== 'object') return []
  const findings = []
  const expectedModel = expectedModelForRow(row, launchBinding)
  const aliases = launchBinding.aliases
  const hasBoundModel = launchBinding.enabled === false ||
    (aliases && typeof aliases === 'object' && typeof aliases[expectedModel] === 'string' && aliases[expectedModel] !== '')
  if (expectedModel === '' || !hasBoundModel || row.model !== expectedModel) {
    findings.push({
      severity: 'P0', rule: 'reconcileProvenance',
      title: `model provenance for ${row.gate} (${row.feature}) does not match immutable launch binding: recorded ${row.model}, expected ${expectedModel || '(unbound)'}`,
    })
  }
  const expectedEffort = expectedEffortForRow(row, launchBinding)
  if (expectedEffort !== '' && row.effort !== expectedEffort) {
    findings.push({
      severity: 'P0', rule: 'reconcileProvenance',
      title: `effort provenance for ${row.gate} (${row.feature}) does not match immutable launch binding: recorded ${row.effort}, expected ${expectedEffort}`,
    })
  }
  return findings
}

function reconcileProvenance(ctx) {
  const findings = []
  const gatelog = Array.isArray(ctx.gatelog) ? ctx.gatelog : []
  const agents = Array.isArray(ctx.agents) ? ctx.agents : []
  const compactLedger = ctx.compactLedger === true
  const artifactExists = typeof ctx.artifactExists === 'function' ? ctx.artifactExists : () => false
  for (const row of gatelog) {
    if (!PASS_VERDICT_RE.test(row.verdict || '')) continue
    const expectedPersona = GATE_EXPECTED_PERSONA[row.gate]
    if (!expectedPersona) continue

    const legacySpawn = agents.some(a => a.persona === expectedPersona && (a.gate === row.gate || a.gate === ''))
    const inlinePersonaMatches = row.persona === expectedPersona
    const hasSpawn = compactLedger ? inlinePersonaMatches : legacySpawn
    if (row.persona && row.persona !== expectedPersona) {
      findings.push({
        severity: 'P0',
        rule: 'reconcileProvenance',
        title: `contradictory persona provenance for ${row.gate} (${row.feature}): GATELOG names ${row.persona}, expected ${expectedPersona}`,
      })
    } else if (!hasSpawn) {
      findings.push({
        severity: 'P0',
        rule: 'reconcileProvenance',
        title: `fabricated ${row.gate} attestation (${row.feature}): claimed PASS with no distinct ${expectedPersona} spawn in ${compactLedger ? 'GATELOG' : 'AGENTS.md'}`,
      })
    }
    if (compactLedger && (!row.model || !row.effort)) {
      findings.push({
        severity: 'P0',
        rule: 'reconcileProvenance',
        title: `incomplete ${row.gate} attestation (${row.feature}): compact GATELOG row has no model/effort provenance`,
      })
    } else if (compactLedger) {
      findings.push(...launchProvenanceFindings(row, ctx.launchBinding))
    }
    if (!(row.artifacts || []).some(artifactExists)) {
      findings.push({
        severity: 'P0',
        rule: 'reconcileProvenance',
        title: `fabricated ${row.gate} attestation (${row.feature}): claimed PASS with no matching artifact file on disk`,
      })
    }
  }
  return findings
}

// countSubstantiveCaptures (PLAN-substance-provenance): enumerated REAL evidence in a
// markdown body - SUBSTANTIVE fenced blocks (a lone decorative empty fence does NOT
// count), table DATA rows (not the |---| separator), and broad-runner invocations. PURE.
function countSubstantiveCaptures(text) {
  const segments = String(text).split('```')
  let fences = 0
  for (let i = 1; i < segments.length; i += 2) {
    const inner = segments[i] || ''
    const innerNonWs = inner.replace(/\s/g, '').length
    if (innerNonWs >= MIN_FENCE_CONTENT_CHARS || BROAD_RUNNER_RE.test(inner) || /\bexit\b|\bpass|\bfail|\bok\b/i.test(inner)) {
      fences++
    }
  }
  const tableRows = (text.match(/^\s*\|.+\|\s*$/gm) || [])
    .filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).length
  const runners = (text.match(new RegExp(BROAD_RUNNER_RE.source, 'gi')) || []).length
  return fences + tableRows + runners
}

// artifactSubstantiationReasons (PLAN-substance-provenance v3): the per-body reasons a
// verdict is UNSUBSTANTIATED. (b) non-empty/non-stub floor; (c) on-point per gate TYPE
// - a capture gate PASS rests ONLY on a runner token or the structured schema green
// field (a bare fence/row count NEVER substantiates - v3 fix); (d) count-reconcile.
function artifactSubstantiationReasons(row, body) {
  const reasons = []
  const text = typeof body === 'string' ? body : ''
  const nonWs = text.replace(/\s/g, '').length
  if (nonWs < MIN_SUBSTANCE_CHARS) {
    reasons.push(`empty/stub artifact (${nonWs} non-ws chars < ${MIN_SUBSTANCE_CHARS}) - a present file is not substance`)
    return reasons
  }
  const captureCount = countSubstantiveCaptures(text)
  const claimsPass = PASS_VERDICT_RE.test(row.verdict || '')
  const kind = GATE_SUBSTANCE_KIND[row.gate] || 'prose'
  if (kind === 'capture') {
    if (claimsPass) {
      const hasGreenSchema = VERIFY_GREEN_RE.test(text)
      const hasCapturedRun = BROAD_RUNNER_RE.test(text) || VERIFY_EVIDENCE_RE.test(text)
      if (!hasGreenSchema && !hasCapturedRun) {
        reasons.push(`${row.gate} verdict claims pass but body carries NO captured-run evidence - no verify-schema green field (reproNowGreen=true / testCommand / coveragePercent), no recognized runner invocation. A bare fence or table row is NOT a captured run.`)
      }
      if (VERIFY_NOT_GREEN_RE.test(text)) {
        reasons.push(`${row.gate} claims pass but body states reproNowGreen=false - the artifact's own schema contradicts the verdict`)
      }
      if (REGRESSIONS_NONEMPTY_RE.test(text)) {
        reasons.push(`${row.gate} claims pass but body lists a non-empty preExistingRegressions - a green->red flip is NOT a pass (GATES.md G6)`)
      }
    }
  } else {
    const onPoint = (row.feature && text.includes(row.feature)) || new RegExp(`\\b${row.gate}\\b`).test(text)
    if (!onPoint) {
      reasons.push(`${row.gate} artifact does not reference feature ${row.feature || '(none)'} or gate ${row.gate} - off-point / not the claimed evidence`)
    }
  }
  const claimsClean = CLEAN_CLAIM_RE.test(row.verdict || '') || CLEAN_CLAIM_RE.test(text)
  if (claimsClean && captureCount < MIN_CAPTURE_ITEMS) {
    reasons.push(`claims clean/zero-gap but body enumerates ZERO substantive captured items (CONV-38 hollow verdict) - a "hardGapCount 0" over no captures is fabricated`)
  }
  const m = COUNT_CLAIM_RE.exec(row.verdict || '') || COUNT_CLAIM_RE.exec(text)
  if (m) {
    const claimed = Number(m[1] || m[2] || m[3])
    if (claimed > 0 && captureCount === 0) {
      reasons.push(`claims ${claimed} checked item(s) but body enumerates none - claimed count contradicts the artifact body`)
    }
  }
  return reasons
}

// artifactSubstanceFindings (PLAN-substance-provenance): a GATELOG PASS-family verdict
// is legitimate only when at least ONE named artifact is present AND substantiates the
// verdict (re-derived from the body, not asserted in prose). reconcileProvenance proved
// PRESENCE; this proves SUBSTANCE. .some over the artifact set - reordering cannot
// launder a hollow file behind a decoy. Permissive-on-absence: pure absence is
// reconcileProvenance's P0, not ours.
function artifactSubstanceFindings(ctx) {
  const findings = []
  const gatelog = Array.isArray(ctx.gatelog) ? ctx.gatelog : []
  const artifactExists = typeof ctx.artifactExists === 'function' ? ctx.artifactExists : () => false
  const readArtifact = typeof ctx.readArtifact === 'function' ? ctx.readArtifact : () => null
  for (const row of gatelog) {
    if (!PASS_VERDICT_RE.test(row.verdict || '')) continue
    const present = (row.artifacts || []).filter(artifactExists)
    if (present.length === 0) continue
    const bodies = present.map(readArtifact).filter(b => typeof b === 'string')
    if (bodies.length === 0) {
      findings.push({
        severity: 'P0', rule: 'artifactSubstanceFindings',
        title: `unsubstantiated ${row.gate} verdict (${row.feature}): ${present.length} artifact(s) present on disk but UNREADABLE - a verdict cannot rest on a file that cannot be opened`,
      })
      continue
    }
    const reasonsPerBody = bodies.map(b => artifactSubstantiationReasons(row, b))
    if (reasonsPerBody.some(r => r.length === 0)) continue
    const best = reasonsPerBody.reduce((a, b) => (b.length < a.length ? b : a))
    findings.push({
      severity: 'P0', rule: 'artifactSubstanceFindings',
      title: `unsubstantiated ${row.gate} verdict (${row.feature}): NONE of ${bodies.length} present artifact(s) substantiates the verdict - ${best.join('; ')}`,
    })
  }
  return findings
}

function parseRoadmapItems(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  try {
    const parsed = JSON.parse(text)
    if (parsed && Array.isArray(parsed.items)) {
      return parsed.items
        .filter(item => item && typeof item.id === 'string' && item.id.trim() !== '')
        .map(item => ({ id: item.id.trim(), title: typeof item.title === 'string' ? item.title.trim() : '' }))
    }
  } catch {
    // Markdown roadmaps are a supported compatibility input.
  }
  const items = []
  const seen = new Set()
  for (const line of text.split('\n')) {
    const match = line.match(/^#{1,6}\s+(F(?:X-[A-Z0-9-]+|-[A-Z0-9-]+|\d+)|SPEC-\d+)\s*(?::|-|-)\s*(.+)$/)
    if (!match || seen.has(match[1])) continue
    seen.add(match[1])
    items.push({ id: match[1], title: match[2].trim() })
  }
  return items
}

function rowHasSubstantiveEvidence(row, ctx) {
  if (typeof ctx.artifactExists !== 'function' || typeof ctx.readArtifact !== 'function') {
    return false
  }
  const { artifactExists, readArtifact } = ctx
  for (const artifact of row.artifacts) {
    if (!artifactExists(artifact)) continue
    const body = readArtifact(artifact)
    if (typeof body !== 'string') continue
    const verifyRow = { ...row, gate: 'G6', verdict: 'VERIFIED' }
    if (artifactSubstantiationReasons(verifyRow, body).length === 0) return true
  }
  return false
}

function roadmapClosureFindings(ctx) {
  if (ctx.terminal !== true || ctx.compactLedger !== true) return []
  const items = Array.isArray(ctx.roadmapItems) ? ctx.roadmapItems : []
  if (items.length === 0) {
    return [{ severity: 'P0', rule: 'roadmapClosureFindings', title: 'terminal new-format run has no parseable ROADMAP.md items - closure cannot be reconstructed' }]
  }
  const gatelog = Array.isArray(ctx.gatelog) ? ctx.gatelog : []
  if (typeof ctx.gatelogText !== 'string' || ctx.gatelogText.trim() === '') {
    return [{ severity: 'P0', rule: 'roadmapClosureFindings', title: 'terminal new-format run has GATELOG.md empty - no roadmap frontier can be proven' }]
  }
  const goalFrontiers = parseGoalCheckFrontiers(ctx.gatelogText)
  const findings = []
  for (const item of items) {
    const rows = gatelog.filter(row => row && row.feature === item.id)
    const hasDone = goalFrontiers.some(frontier => frontier.feature === item.id && frontier.isDone)
    if (!hasDone) {
      findings.push({ severity: 'P0', rule: 'roadmapClosureFindings', title: `${item.id} (${item.title || 'roadmap item'}) has no terminal frontier in GATELOG.md` })
      continue
    }
    const terminalEvidence = rows.filter(row => row.gate === 'G6')
    if (!terminalEvidence.some(row => rowHasSubstantiveEvidence(row, ctx))) {
      findings.push({ severity: 'P0', rule: 'roadmapClosureFindings', title: `${item.id} (${item.title || 'roadmap item'}) has no substantive terminal evidence backing its DONE frontier` })
    }
  }
  return findings
}

// mixedLedgerFormatFindings: a new-format run (PROMPTS.txt + ROADMAP.md + GATELOG.md)
// whose directory ALSO carries parseable legacy AGENTS.md spawn rows has two provenance
// sources claiming the same run. That contradiction fails closed - the checker cannot
// know which source is authoritative, and a stale file must never silently reroute
// provenance through the legacy table. An AGENTS.md that exists but parses to ZERO
// spawn rows (heading-only residue) is harmless: no finding, closure proceeds.
function mixedLedgerFormatFindings(ctx) {
  const findings = []
  if (ctx == null || ctx.compactLedger !== true) return findings
  const agents = Array.isArray(ctx.agents) ? ctx.agents : []
  if (agents.length > 0) {
    findings.push({
      severity: 'P0',
      rule: 'mixedLedgerFormatFindings',
      title: `CONTRADICTORY MIXED-FORMAT LEDGER: new-format PROMPTS.txt/ROADMAP.md/GATELOG.md coexist with ${agents.length} AGENTS.md spawn row(s) - two provenance sources claim the same run. Remove the stale legacy file, or resume explicitly against the legacy prompt directory.`,
    })
  }
  return findings
}

// scanTranscript (pure): classify ONE transcript's tool_use events.
// production Edit/Write = an Edit/Write/MultiEdit tool_use whose file_path is NOT
// under tests/ and NOT an artifact/ledger path. verify/goal-check pytest = a Bash
// tool_use whose command matches REAL_RUNNER_RE. Returns the booleans the F5-18
// rule + the five FX-HIERARCHY rules key on, all derived from the SAME tool_use
// walk. Tolerant of format drift: tool_use found by name + a path heuristic; an
// unparseable transcript yields all-false / empty.
//
// FX-HIERARCHY derived fields:
//   hasBashEditWrite   - ANY Bash OR Edit/Write/MultiEdit, regardless of path
//                        (FIX-10 ap-manager exec guard).
//   hasNonAgentToolUse - ANY tool_use whose name is NOT Agent and NOT Task
//                        (FIX-11 L0 conductor Agent-only guard).
//   wroteDoneSentinel  - a Write/Edit/MultiEdit to a DONE-<nonce> or .../DONE path
//                        (FIX-14 only ap-janitor may write the sentinel).
//   wroteGoalCheck     - a Write/Edit/MultiEdit to a goal-check*.md path
//                        (FIX-14 only ap-goal-checker authors the verdict).
//   spawnedTypes       - every subagent_type on an Agent/Task tool_use
//                        (FIX-13 an L1 node's children must all be ap-manager).
const DONE_SENTINEL_RE = /(^|[\/\\])DONE-|[\/\\]DONE$/
const GOAL_CHECK_FILE_RE = /goal-check[^\/\\]*\.md$/
// PLAN-e2e-verify: the goal-check artifact's machine lines. E2E_AXIS_RE captures the
// tri-axis line `E2E: scope=<pass|gap> prompt=<pass|gap> flaws=<n> ran=<rest-of-line>`;
// `ran` is terminal (greedy to EOL) so a run description with spaces survives. OPEN_
// BLOCKERS_RE reads the `OPEN-BLOCKERS:<n>` count. GOAL_CHECK_ARTIFACT_RE selects the
// goal-check-vN.md artifact bodies threaded into ctx.goalCheckArtifacts.
const E2E_AXIS_RE = /^E2E:\s*scope=(pass|gap)\s+prompt=(pass|gap)\s+flaws=(\d+)\s+ran=(.*)$/im
const OPEN_BLOCKERS_RE = /^OPEN-BLOCKERS:\s*(\d+)\s*$/im
const GOAL_CHECK_ARTIFACT_RE = /goal-check[^\/\\]*\.md$/i
// FIX-016 (PLAN-anchor): the SCRIBE-maintained parent-anchor resume file.
const ANCHOR_FILE_RE = /(^|[\/\\])ANCHOR\.md$/
function scanTranscript(jsonlText) {
  let hasProductionEditOrWrite = false
  let hasVerifyOrGoalCheckPytest = false
  let hasBashEditWrite = false
  let hasWriteEditBashWebTool = false
  let hasNonAgentToolUse = false
  let wroteDoneSentinel = false
  let wroteGoalCheck = false
  let hasUserInterrupt = false
  let wroteAnchor = false
  let hasGitAddAll = false
  let hasGitCommit = false
  // PLAN-startup-handshake: the name of the FIRST tool_use seen anywhere in this
  // transcript, in scan order ('' if the transcript emitted none). startupHandshake
  // Findings reads it on the 00-conductor ROOT to tell "asked the handshake FIRST"
  // (AskUserQuestion) from "did some other tool first" (the startup-drift signature).
  let firstToolUseName = ''
  const spawnedTypes = []
  const spawnedDescriptions = []
  const assistantTextParts = []
  let maxToolResultChars = 0
  let hasOversizedReport = false
  let fleetTableTurns = 0
  // SPEC-2 wave-barrier: per-event (per-turn) spawn batching. maxBatchedSpawns is
  // the widest single-turn Agent/Task batch; hadFoldOrDispatchAfterWave is true when
  // a later assistant turn carried a text fold OR a further spawn. totalSpawnCount is
  // diagnostics only.
  let maxBatchedSpawns = 0
  let maxBatchIndex = -1
  let totalSpawnCount = 0
  // PLAN-supervisor-collapse: the widest single-turn count of ap-feature-coordinator children
  // (the supervisor-per-feature signature). Fail-closed: no such spawn anywhere -> 0.
  let maxFeatureSupervisorWave = 0
  const eventTurns = []
  const parsedEvents = []
  const livenessTurns = []
  // PLAN-time-optimization (serialGateFindings): per-turn gate labels read from each turn's
  // SPAWN descriptions, so the rule can tell a batched independent pair (one turn) from a
  // serialized one (two turns). PLAN-false-negative-liveness: dead-conclusion turns +
  // transcript-level respawn targets.
  const gateSpawnTurns = []
  const deadConclusionTurns = []
  const respawnTargets = new Set()
  // SPD-2 evidence-pack: the Set of PRODUCTION file paths this transcript opened with the Read tool
  // (filtered by isProductionPath - test/artifact reads excluded). Used by evidencePackFindings to
  // count how many gates of one feature re-Read the SAME prod file with no <feature>-context.md pack.
  const readsProductionFiles = new Set()
  const lines = (typeof jsonlText === 'string' ? jsonlText : '').split('\n')
  let eventIndex = -1
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try { event = JSON.parse(trimmed) } catch (e) { continue }
    parsedEvents.push(event)
    eventIndex++
    let spawnsThisEvent = 0
    let featureSupervisorsThisEvent = 0
    let hasTextBlock = hasAssistantText(event)
    const turnText = assistantText(event)
    if (turnText) assistantTextParts.push(turnText)
    const gateLabelsThisTurn = new Set()
    // PLAN-lean-L0-coordinator: ingested tool_result size + fleet-table-rebuild signals.
    for (const result of toolResults(event)) {
      const len = result.length
      if (len > maxToolResultChars) maxToolResultChars = len
      if (len > VERDICT_BUDGET_CHARS || REAL_RUNNER_RE.test(result) || DIFF_RE.test(result)) hasOversizedReport = true
    }
    if (turnText) {
      const fleetRows = (turnText.match(new RegExp(FLEET_ROW_RE.source, 'gim')) || []).length
      const hasFleetHeader = /\|\s*feature\s*\|[^\n]*\|\s*status\s*\|/i.test(turnText)
      if (fleetRows >= FLEET_ROW_MIN || hasFleetHeader) fleetTableTurns++
    }
    for (const use of toolUses(event)) {
      const name = String(use.name)
      const input = use.input || {}
      if (name !== '' && firstToolUseName === '') firstToolUseName = name   // PLAN-startup-handshake: first tool in scan order
      if (name !== '' && name !== 'Agent' && name !== 'Task') hasNonAgentToolUse = true
      // hasWriteEditBashWebTool marks GENERAL mutation/web I/O (Write/Edit/MultiEdit/
      // Bash/WebSearch/WebFetch), used by non-L1 checks. It is NOT the L1 gate: an L1
      // coordinator is Agent-ONLY (base:68), so the L1 doctrine keys on hasNonAgentToolUse
      // (Read/Glob/Grep included) - see l1ChildrenFindings.
      if (name === 'WebSearch' || name === 'WebFetch') hasWriteEditBashWebTool = true
      if (name === 'AskUserQuestion') hasUserInterrupt = true
      if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
        hasBashEditWrite = true
        hasWriteEditBashWebTool = true
        const filePath = String(input.file_path || input.path || '')
        if (filePath && isProductionPath(filePath)) hasProductionEditOrWrite = true
        if (filePath && DONE_SENTINEL_RE.test(filePath)) wroteDoneSentinel = true
        if (filePath && GOAL_CHECK_FILE_RE.test(filePath)) wroteGoalCheck = true
        if (filePath && ANCHOR_FILE_RE.test(filePath)) wroteAnchor = true
      } else if (name === 'Bash') {
        hasBashEditWrite = true
        hasWriteEditBashWebTool = true
        const command = String(input.command || '')
        if (REAL_RUNNER_RE.test(command)) hasVerifyOrGoalCheckPytest = true
        if (GIT_ADD_ALL_RE.test(command)) hasGitAddAll = true
        if (GIT_COMMIT_RE.test(command)) hasGitCommit = true
      } else if (name === 'Read') {
        const filePath = String(input.file_path || input.path || '')
        if (filePath && isProductionPath(filePath)) readsProductionFiles.add(filePath)
      } else if (name === 'Agent' || name === 'Task') {
        const childType = input.subagent_type || input.agentType
        if (typeof childType === 'string' && childType !== '') spawnedTypes.push(childType)
        if (childType === 'ap-feature-supervisor' || childType === 'ap-feature-coordinator') featureSupervisorsThisEvent++
        spawnsThisEvent++
        totalSpawnCount++
        const desc = typeof input.description === 'string' && input.description.trim() !== ''
          ? input.description.trim()
          : (typeof input.prompt === 'string' && input.prompt.trim() !== '' ? input.prompt.trim().slice(0, 40) : '')
        if (desc !== '') spawnedDescriptions.push(desc)
        // PLAN-time-optimization: classify this spawn's gate from its description + child persona.
        const gate = gateLabelFromSpawn(desc, typeof childType === 'string' ? childType : '')
        if (gate) gateLabelsThisTurn.add(gate)
      }
    }
    if (gateLabelsThisTurn.size > 0) gateSpawnTurns.push({ index: eventIndex, gateLabels: gateLabelsThisTurn })
    if (spawnsThisEvent > maxBatchedSpawns) { maxBatchedSpawns = spawnsThisEvent; maxBatchIndex = eventIndex }
    if (featureSupervisorsThisEvent > maxFeatureSupervisorWave) maxFeatureSupervisorWave = featureSupervisorsThisEvent
    eventTurns.push({ index: eventIndex, spawnCount: spawnsThisEvent, hasTextBlock })
  }
  const hadFoldOrDispatchAfterWave = maxBatchIndex >= 0 &&
    eventTurns.some(t => t.index > maxBatchIndex && (t.hasTextBlock === true || t.spawnCount > 0))
  const assistantTextAll = assistantTextParts.join('\n')
  const hasLeanAsIdleNarration = LEAN_TOKEN_RE.test(assistantTextAll) && IDLE_TOKEN_RE.test(assistantTextAll) && !LEGIT_WAIT_RE.test(assistantTextAll)
  const dispatchedAnyTrack = spawnedTypes.length >= 1
  // PLAN-liveness-reconcile: per-turn walk. A turn that narrates the fleet as running
  // records its claimed ids/labels + the same-turn poll (its result bound from the NEXT
  // event; a DEAD_SIGNAL result strips that id/label from the backing poll set).
  for (let i = 0; i < parsedEvents.length; i++) {
    const event = parsedEvents[i]
    const text = assistantText(event)
    if (!RUNNING_NARRATION_RE.test(text)) continue
    const claimedAgentIds = new Set([...text.matchAll(AGENT_ID_RE)].map(m => m[1].toLowerCase()))
    const claimedLabels = new Set([...text.matchAll(FEATURE_LABEL_RE)].map(m => m[1].toUpperCase()))
    if (claimedAgentIds.size === 0 && claimedLabels.size === 0) claimedAgentIds.add('__unnamed__')
    const resultText = pollResultsText(parsedEvents, i)
    let polledThisTurn = false
    const polledAgentIds = new Set()
    const polledLabels = new Set()
    for (const use of toolUses(event)) {
      const name = String(use.name)
      const input = use.input || {}
      const isPoll = POLL_TOOL_NAMES.has(name) ||
        (name === 'Bash' && BASH_POLL_RE.test(String(input.command || ''))) ||
        ((name === 'Read' || name === 'Edit') && POLL_READ_RE.test(String(input.file_path || input.path || '')))
      if (!isPoll) continue
      polledThisTurn = true
      const probe = `${input.command || ''} ${input.file_path || input.path || ''} ${input.description || ''}`
      for (const m of probe.matchAll(AGENT_ID_RE)) polledAgentIds.add(m[1].toLowerCase())
      for (const m of probe.matchAll(FEATURE_LABEL_RE)) polledLabels.add(m[1].toUpperCase())
    }
    // result-bind: a poll whose result is a DEAD signal does NOT back the claim - the
    // polled ids/labels (whose liveness the dead result refutes) are dropped.
    if (DEAD_SIGNAL_RE.test(resultText)) {
      polledAgentIds.clear()
      polledLabels.clear()
      polledThisTurn = false
    }
    livenessTurns.push({ index: i, claimedAgentIds, claimedLabels, polledThisTurn, polledAgentIds, polledLabels })
  }
  // PLAN-false-negative-liveness (EDIT 2): a PARALLEL per-turn walk capturing DEAD-CONCLUSION turns. A turn
  // that narrates a spawned agent dead/absent + the same-turn task-status polls (bound PER-USE so a poll of A
  // never clears a conclusion about B) + any disk-only read + any spawn (the duplicate-onto-owned arm's input).
  for (let i = 0; i < parsedEvents.length; i++) {
    const event = parsedEvents[i]
    const text = assistantText(event)
    if (!DEAD_CONCLUSION_RE.test(text)) continue
    const deadConcludedIds = new Set([...text.matchAll(AGENT_ID_RE)].map(m => m[1].toLowerCase()))
    const deadConcludedLabels = new Set([...text.matchAll(FEATURE_LABEL_RE)].map(m => m[1].toUpperCase()))
    const taskStatusDeadIds = new Set()
    const taskStatusDeadLabels = new Set()
    const taskStatusRunningIds = new Set()
    const taskStatusRunningLabels = new Set()
    const spawnedIdsThisTurn = new Set()
    const spawnedLabelsThisTurn = new Set()
    let diskReadThisTurn = false
    for (const use of toolUses(event)) {
      const name = String(use.name)
      const input = use.input || {}
      const isTaskStatusPoll = POLL_TOOL_NAMES.has(name) ||
        (name === 'Bash' && BASH_POLL_RE.test(String(input.command || '')))
      const isDiskRead = (name === 'Read' || name === 'Edit') &&
        POLL_READ_RE.test(String(input.file_path || input.path || ''))
      if (isTaskStatusPoll) {
        const probe = `${input.command || ''} ${input.description || ''}`
        const polledIds = [...probe.matchAll(AGENT_ID_RE)].map(m => m[1].toLowerCase())
        const polledLbls = [...probe.matchAll(FEATURE_LABEL_RE)].map(m => m[1].toUpperCase())
        const result = toolResultForUse(parsedEvents, i, use.id)
        const confirmsDead = TASK_STATUS_DEAD_RE.test(result) || DEAD_SIGNAL_RE.test(result)
        for (const id of polledIds) (confirmsDead ? taskStatusDeadIds : taskStatusRunningIds).add(id)
        for (const lbl of polledLbls) (confirmsDead ? taskStatusDeadLabels : taskStatusRunningLabels).add(lbl)
      } else if (isDiskRead) {
        diskReadThisTurn = true
      } else if (name === 'Agent' || name === 'Task') {
        const desc = typeof input.description === 'string' ? input.description
          : (typeof input.prompt === 'string' ? input.prompt : '')
        for (const m of desc.matchAll(AGENT_ID_RE)) { spawnedIdsThisTurn.add(m[1].toLowerCase()); respawnTargets.add(m[1].toLowerCase()) }
        for (const m of desc.matchAll(FEATURE_LABEL_RE)) { spawnedLabelsThisTurn.add(m[1].toUpperCase()); respawnTargets.add(m[1].toUpperCase()) }
      }
    }
    deadConclusionTurns.push({
      index: i, deadConcludedIds, deadConcludedLabels, diskReadThisTurn,
      taskStatusDeadIds, taskStatusDeadLabels, taskStatusRunningIds, taskStatusRunningLabels,
      spawnedIdsThisTurn, spawnedLabelsThisTurn,
    })
  }
  return {
    hasProductionEditOrWrite, hasVerifyOrGoalCheckPytest,
    hasBashEditWrite, hasWriteEditBashWebTool, hasNonAgentToolUse, wroteDoneSentinel, wroteGoalCheck, spawnedTypes,
    hasUserInterrupt, wroteAnchor,
    maxBatchedSpawns, hadFoldOrDispatchAfterWave, totalSpawnCount,
    maxFeatureSupervisorWave,
    hasGitAddAll, hasGitCommit,
    spawnedDescriptions,
    hasLeanAsIdleNarration, dispatchedAnyTrack,
    maxToolResultChars, hasOversizedReport, fleetTableTurns,
    livenessTurns,
    gateSpawnTurns,
    deadConclusionTurns, respawnTargets,
    readsProductionFiles: [...readsProductionFiles],
    firstUserTurnText: firstUserText(parsedEvents),
    userTurnTexts: allUserTexts(parsedEvents),
    firstToolUseName,
  }
}

// gateLabelFromSpawn (PLAN-time-optimization): classify ONE spawn's gate from its description + child
// persona. Priority-ordered so "fresh-verify" -> G3 (never G6) and "impl-review" -> G5 (never G2). Returns
// '' when no gate is identifiable (fail-closed: serialGateFindings never fires on an unclassifiable spawn).
function gateLabelFromSpawn(description, childType) {
  const d = `${description || ''} ${childType || ''}`.toLowerCase()
  if (/\bg3\b|fresh-?verif|ap-fresh-verifier/.test(d)) return 'G3'
  if (/\bg2\b|plan-?review|ap-reviewer.*plan|review.*plan/.test(d)) return 'G2'
  if (/\bg6\b|\bverif(?:y|ier|ication)\b|ap-verifier/.test(d)) return 'G6'
  if (/\bg5\b|impl-?review|implementation review|ap-reviewer/.test(d)) return 'G5'
  return ''
}

// toolResultForUse (PLAN-false-negative-liveness EDIT 2b): the tool_result text bound to ONE tool_use by
// tool_use_id (the next event carries the results; multiple same-turn polls each return their own block).
// '' when unpaired/absent - the caller then treats the id as NOT-confirmed-dead (alive), the mission's
// fail-direction (never declare dead on an unconfirmable check). Per-USE binding is what makes the
// dead-confirmation per-ID, not per-turn.
function toolResultForUse(events, fromIndex, useId) {
  const next = events[fromIndex + 1]
  if (!next || useId == null) return ''
  const msg = next.message || next
  const blocks = Array.isArray(msg.content) ? msg.content : (Array.isArray(next.content) ? next.content : [])
  for (const b of blocks) {
    if (!b || b.type !== 'tool_result' || b.tool_use_id !== useId) continue
    const c = b.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(x => (x && typeof x.text === 'string') ? x.text : (typeof x === 'string' ? x : '')).join('\n')
    if (c && typeof c.text === 'string') return c.text
  }
  return ''
}

// pollResultsText: gather the tool_result content text from the event AFTER fromIndex
// (a poll's result returns in the following user/tool_result event). '' if none.
function pollResultsText(events, fromIndex) {
  const next = events[fromIndex + 1]
  if (!next) return ''
  return toolResults(next).join('\n')
}

// assistantText: pull the assistant-authored TEXT out of one event (string content,
// or content[] blocks of type 'text'). Tolerant: a non-assistant or tool-only event
// yields ''. Shared by the lean-idle and liveness rules.
function assistantText(event) {
  if (!event || typeof event !== 'object') return ''
  const msg = event.message || event
  const role = msg.role || event.type
  if (role !== 'assistant') return ''
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text).join('\n')
}

// firstUserText (INH-5): the first user-role TEXT turn - the spawn BRIEF - string
// content, or content[] text blocks joined. SKIPS tool_result-only user turns (gate
// results, not the brief) and whitespace-only content. '' when none. Pure, total;
// tolerant of {message:{role,content}} and {role|type,content}. The inverse of
// assistantText (role==='user'); used by missionFidelityFindings to diff the received
// brief against PROMPTS.txt.
function firstUserText(events) {
  for (const event of (Array.isArray(events) ? events : [])) {
    if (!event || typeof event !== 'object') continue
    const msg = event.message || event
    const role = msg.role || event.type
    if (role !== 'user') continue
    const content = msg.content
    if (typeof content === 'string') { if (content.trim() !== '') return content }
    else if (Array.isArray(content)) {
      const textParts = content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
      if (textParts.length) return textParts.join('\n')
    }
  }
  return ''
}

// === MISSION-FIDELITY (INH-5) =================================================
// Lockstep duplicates of gate.js's brief() framing (gate.js is ESM-shaped, not
// require-able here - the same necessity as GATE_EXPECTED_PERSONA). The test asserts
// each is a verbatim substring of autoprompt-gate.js, so a future label edit there
// fails the lockstep tripwire loudly.
const MISSION_BLOCK_LABEL = 'ORIGINAL MISSION (the user prompt, verbatim, the constitution for this work; it OUTRANKS every plan, artifact, and reviewer note below; verify against THIS text, never against what another agent told you):'
const MISSION_POINTER_LABEL = 'MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.'
const PRIOR_STEERS_BLOCK_LABEL = 'PROMPTS-SO-FAR (the user\'s later steers in this session; they ride ALONGSIDE the ORIGINAL MISSION and refine HOW to do it, but the ORIGINAL MISSION above OUTRANKS them - a steer can never override what the mission asks):'

// Tells DIFFERS(paraphrase) from ABSENT - both P0. Run ONLY over the received brief,
// never the source. A mission-labelled header (the gate label OR a bare "MISSION:")
// present without the verbatim bytes is a paraphrase; no header at all is an omission.
const MISSION_HEADER_RE = /ORIGINAL MISSION|MISSION POINTER|^MISSION:/im
const MISSION_POINTER_LINE_RE = /^path=(\S+) hash=sha256:([a-f0-9]{64}) bytes=(\d+) nonce=(\S+)$/m
// The ONLY legal bytes before the mission anchor: the "You are <role>.\n\n" persona line.
const PERSONA_PREAMBLE_RE = /^You are [^\n]*\.\n\n$/
// INH-4 / Arbiter A1: the UNSPOOFABLE one-per-run conductor ROOT, keyed on the
// 00-conductor ROOT FILENAME (never the spoofable cl-conductor persona). Exactly the
// live idiom at scanTranscriptDir (`/(^|[\/\\])00-conductor/`). A cl-conductor-PERSONA
// subagent spawn (sub-cl-conductor-NN.jsonl) does NOT match and is mission-diffed.
const CONDUCTOR_ROOT_RE = /(^|[\/\\])00-conductor/

// parsePromptsTxt: split the verbatim PROMPTS.txt ledger into ordered prompt blocks on
// "=== PROMPT N ===". block0 = mission, block1.. = later steers. Strips a trailing
// newline run; PRESERVES internal blank lines (a multi-paragraph mission). Pure, total;
// no markers -> [] (no usable source -> the brief-diff arm goes inert).
function parsePromptsTxt(text) {
  const lines = String(text == null ? '' : text).split('\n')
  const blocks = []
  let current = null
  const MARKER = /^=== PROMPT \d+ ===\s*$/
  for (const line of lines) {
    if (MARKER.test(line)) { current = []; blocks.push(current); continue }
    if (current) current.push(line)
  }
  return blocks.map(b => b.join('\n').replace(/\n+$/, ''))
}

// missionFidelityFindings (INH-5 - TEXT-DIFF canary; the mission's "not some LLM
// rewritten slop version" made structural). P0. INERT when PROMPTS.txt is absent
// (ctx.promptsText == null): no source -> nothing to diff -> [] (missionSourceOfTruth
// Findings owns the "absent on a DONE run" case so this arm is never the false-positive
// vector v1 died on). Arbiter A1: the 00-conductor ROOT (matched on its FILENAME, the
// unspoofable one-per-run signal) is EXEMPT - its first user turn is the RAW user
// prompt, the human boundary, with no MISSION_BLOCK_LABEL by construction. A
// cl-conductor-PERSONA subagent spawn is NOT the root (its filename is
// sub-cl-conductor-NN.jsonl), does NOT match CONDUCTOR_ROOT_RE, and IS mission-diffed.
// When PROMPTS.txt IS present, for each non-root transcript's received brief
// (firstUserTurnText): the verbatim mission must lead (only "You are <role>.\n\n"
// before it) and every later steer must appear verbatim.
function missionPointerReasons(ctx, brief) {
  const reasons = []
  const match = brief.match(MISSION_POINTER_LINE_RE)
  if (!match) return ['MALFORMED: expected path, sha256 hash, byte length, and nonce']
  if (ctx.promptsText == null) return ['SOURCE MISSING: PROMPTS.txt could not be read']

  const [, pointerPath, pointerHash, pointerBytes, pointerNonce] = match
  const expectedPath = typeof ctx.promptsPath === 'string' ? ctx.promptsPath : ''
  const expectedNonce = typeof ctx.runNonce === 'string' ? ctx.runNonce : ''
  const actualHash = crypto.createHash('sha256').update(ctx.promptsText, 'utf8').digest('hex')
  const actualBytes = Buffer.byteLength(ctx.promptsText, 'utf8')

  if (expectedPath !== '' && path.resolve(pointerPath) !== path.resolve(expectedPath)) reasons.push('PATH MISMATCH')
  if (pointerHash !== actualHash) reasons.push('HASH MISMATCH')
  if (Number(pointerBytes) !== actualBytes) reasons.push('BYTE-LENGTH MISMATCH')
  if (expectedNonce !== '' && pointerNonce !== expectedNonce) reasons.push('NONCE MISMATCH')
  return reasons
}

function missionFidelityFindings(ctx) {
  const findings = []
  if (ctx == null) return findings
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  const prompts = ctx.promptsText == null ? [] : parsePromptsTxt(ctx.promptsText)
  const mission = prompts[0]
  const steers = prompts.slice(1)
  const anchor = mission === undefined ? '' : MISSION_BLOCK_LABEL + '\n' + mission + '\n'

  for (const t of transcripts) {
    if (!t || typeof t !== 'object') continue
    if (CONDUCTOR_ROOT_RE.test(t.path || '')) continue
    const brief = typeof t.firstUserTurnText === 'string' ? t.firstUserTurnText : ''
    if (brief === '') continue
    const where = t.path || '(unknown transcript)'

    if (brief.includes(MISSION_POINTER_LABEL)) {
      const pointerIdx = brief.indexOf(MISSION_POINTER_LABEL)
      const prefix = brief.slice(0, pointerIdx)
      const reasons = missionPointerReasons(ctx, brief)
      if (prefix !== '' && !PERSONA_PREAMBLE_RE.test(prefix)) reasons.unshift('PRESENT-BUT-NOT-FIRST')
      for (const reason of reasons) {
        findings.push({
          severity: 'P0', rule: 'missionFidelityFindings',
          title: `MISSION POINTER ${reason} in ${where}: compact briefs must reference the exact PROMPTS.txt bytes with the canonical path, SHA-256 hash, byte length, and run nonce.`,
        })
      }
      continue
    }

    if (mission === undefined) continue
    const idx = brief.indexOf(anchor)
    if (idx === -1) {
      const hasHeader = MISSION_HEADER_RE.test(brief)
      findings.push({
        severity: 'P0', rule: 'missionFidelityFindings',
        title: hasHeader
          ? `MISSION DIFFERS (paraphrase) in ${where}: a mission-labelled header is present but its text is NOT byte-identical to PROMPTS.txt prompt 1 - an LLM-rewritten/bulletized mission ("slop") reached the spawn. Splice the mission from PROMPTS.txt bytes, never re-type it.`
          : `MISSION ABSENT in ${where}: this spawned subagent's brief carries neither the verbatim ORIGINAL MISSION nor a verified mission pointer envelope.`,
      })
      continue
    }
    const prefix = brief.slice(0, idx)
    if (prefix !== '' && !PERSONA_PREAMBLE_RE.test(prefix)) {
      findings.push({
        severity: 'P0', rule: 'missionFidelityFindings',
        title: `MISSION PRESENT-BUT-NOT-FIRST in ${where}: the verbatim mission block appears at offset ${idx}, after non-persona content - the ORIGINAL MISSION must come FIRST, preceded only by "You are <role>.". Re-splice with the mission on top.`,
      })
      continue
    }
    for (let i = 0; i < steers.length; i++) {
      if (steers[i] !== '' && !brief.includes(steers[i])) {
        findings.push({
          severity: 'P0', rule: 'missionFidelityFindings',
          title: `STEER DROPPED/PARAPHRASED (prompt ${i + 2}) in ${where}: the verbatim later-steer bytes from PROMPTS.txt are not present in the brief - use the verified pointer envelope for compact workers or carry the full PROMPTS-SO-FAR bytes.`,
        })
      }
    }
  }
  return findings
}

// missionSourceOfTruthFindings (INH-1 teeth): a run that REACHED DONE (a DONE-* sentinel
// with done:true) with real gate activity but NO PROMPTS.txt on disk never created the
// verbatim source of truth, so missionFidelityFindings could diff nothing and an
// operational spawn could have dropped the mission unflagged. P0 - a run cannot seal
// DONE without the source of truth. PERMISSIVE-ON-ABSENCE done right: keyed on REACHING
// DONE (ctx.missionDone), NOT on bare gatelog presence - a literal "gatelog present + no
// PROMPTS.txt" P0 would flip ~15 existing ok-true fixtures (GOOD_GATELOG, no PROMPTS.txt,
// not done) and re-create the v1-class false-positive storm. DONE is the exact mission
// boundary ("…drop the mission and still reach DONE") and the ONLY signal separating a
// real run from those fixtures (none of which write a DONE sentinel).
function missionSourceOfTruthFindings(ctx) {
  const findings = []
  if (ctx == null) return findings
  if (ctx.promptsText != null) return findings                  // source of truth present -> brief-diff arm owns the rest
  const gatelog = Array.isArray(ctx.gatelog) ? ctx.gatelog : []
  if (ctx.missionDone === true && gatelog.length > 0) {
    findings.push({
      severity: 'P0', rule: 'missionSourceOfTruthFindings',
      title: `MISSION SOURCE OF TRUTH ABSENT: the run reached DONE (a DONE-* done:true sentinel) with real gate activity but no PROMPTS.txt on disk - the verbatim user-prompt ledger (INH-1) was never written, so no operational/steering spawn's brief could be diffed against the mission. A run cannot seal DONE without the source of truth; INTAKE/SCRIBE must write PROMPTS.txt (=== PROMPT N === blocks) before any spawn.`,
    })
  }
  return findings
}

// === SELFWRITTEN-CAPTURE-SLICE:START - test-only export seam; sliced by
// selfwritten-capture-coverage.cjs. Self-contained: pure array/string helpers over
// injected transcripts/promptsText, NO fs; the ONE external dep (CONDUCTOR_ROOT_RE)
// is prepended by the coverage wrapper. ===

// allUserTexts (INH-1 capture): EVERY user-role TEXT turn in order - the full sequence
// of self-written human inputs in a session - as an array. The ALL-turns sibling of
// firstUserText (which returns only the first); selfWrittenCaptureFindings needs the
// whole sequence to prove each typed turn (answer / note / clarification / steer) rode
// verbatim into PROMPTS.txt. SKIPS tool_result-only user turns (gate results and canned
// menu answers, not typed text) and whitespace-only content - so a bare `mode=wide`
// selection never appears here. Pure, total; fail-closed ([]) on non-array/garbage.
function allUserTexts(events) {
  const out = []
  for (const event of (Array.isArray(events) ? events : [])) {
    if (!event || typeof event !== 'object') continue
    const msg = event.message || event
    const role = msg.role || event.type
    if (role !== 'user') continue
    const content = msg.content
    if (typeof content === 'string') { if (content.trim() !== '') out.push(content) }
    else if (Array.isArray(content)) {
      const textParts = content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
      if (textParts.length) out.push(textParts.join('\n'))
    }
  }
  return out
}

// selfWrittenCaptureFindings (INH-1 capture teeth): a run that REACHED DONE
// (ctx.missionDone === true, the SAME sentinel guard as missionSourceOfTruthFindings so
// NONE of the ~15 not-done fixtures flip) whose 00-conductor ROOT transcript shows a
// SELF-WRITTEN user text turn (a typed answer / note / re-catch / clarification / steer)
// that is NOT present verbatim in PROMPTS.txt. This is the "user answers a handshake
// question or sends a clarification and it's never added to the mission" bug, made
// structural - the dropped input never rode into every brief the way a steer does.
//
// Scoped to the UNSPOOFABLE 00-conductor ROOT (CONDUCTOR_ROOT_RE on the filename, the
// human boundary - a cl-conductor PERSONA subagent does not match, exactly as in
// missionFidelityFindings). Subagent briefs are machine-spliced (persona + mission +
// steers), NOT self-written, and are already owned by missionFidelityFindings; diffing
// them here would false-flag the whole spliced brief as an uncaptured "turn".
//
// Severity P1 (surfaced, NOT run-failing): the classifier of what MUST be captured lives
// in prose (SKILL.md / GATES.md) + the writers (intake / scribe); this validator only
// surfaces the structural gap. A benign conductor-root conversational turn the writers
// legitimately did not capture must be SEEN, not FAIL the run - so P1, never P0 (a P0
// would turn every "thanks, continue" into a run failure). P1 also keeps `ok`, which
// keys only on P0, byte-identical on every green fixture.
//
// PERMISSIVE-ON-ABSENCE: ctx null, promptsText == null (missionSourceOfTruthFindings owns
// that absent-source case - no double-fire), missionDone !== true, or no root user turns
// => []. A turn whose trimmed bytes appear anywhere in PROMPTS.txt is captured.
function selfWrittenCaptureFindings(ctx) {
  const findings = []
  if (ctx == null) return findings
  if (ctx.promptsText == null) return findings                 // no source of truth -> SOT arm owns it
  if (ctx.missionDone !== true) return findings                // same DONE guard: no not-done fixture flips
  const promptsText = String(ctx.promptsText)
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || typeof t !== 'object') continue
    if (!CONDUCTOR_ROOT_RE.test(t.path || '')) continue        // ONLY the human boundary (unspoofable root filename)
    const turns = Array.isArray(t.userTurnTexts) ? t.userTurnTexts : []
    for (const turn of turns) {
      const typed = typeof turn === 'string' ? turn.trim() : ''
      if (typed === '') continue
      if (promptsText.includes(typed)) continue                // captured verbatim -> ok
      const where = t.path                                     // truthy: it already matched CONDUCTOR_ROOT_RE above
      const snippet = typed.length > 80 ? typed.slice(0, 80) + '…' : typed
      findings.push({
        severity: 'P1', rule: 'selfWrittenCaptureFindings',
        title: `SELF-WRITTEN INPUT DROPPED in ${where}: a user text turn ("${snippet}") is NOT present verbatim in PROMPTS.txt on a DONE run - a typed answer/note/clarification never rode into the mission ledger (INH-1). Append it as the next "=== PROMPT N ===" block so it inherits into every brief, exactly like a steer.`,
      })
    }
  }
  return findings
}
// === SELFWRITTEN-CAPTURE-SLICE:END ===
// === END MISSION-FIDELITY =====================================================

// === E2E-VERIFY-SLICE:START - test-only export seam; sliced by e2e-verify-coverage.cjs.
// Self-contained: PURE string helpers + one ctx-rule over injected goalCheckArtifacts,
// NO fs. ===

// parseE2EAxis (PLAN-e2e-verify axis B): read the tri-axis machine line
// `E2E: scope=<pass|gap> prompt=<pass|gap> flaws=<n> ran=<what-was-executed>` from a
// goal-check artifact body. Returns { present, scope, prompt, flaws, ran }. A missing
// or malformed line is FAIL-CLOSED: { present:false, scope:null, prompt:null,
// flaws:null, ran:'' } - an absent axis can only make openFlawFindings fire, never
// falsely clear it. `ran` trims trailing whitespace but preserves internal spaces.
function parseE2EAxis(text) {
  const fail = { present: false, scope: null, prompt: null, flaws: null, ran: '' }
  if (typeof text !== 'string') return fail
  const m = E2E_AXIS_RE.exec(text)
  if (!m) return fail
  return { present: true, scope: m[1], prompt: m[2], flaws: Number(m[3]), ran: m[4].trim() }
}

// parseOpenBlockers (PLAN-e2e-verify axis A - the zero-open-any-severity count): read
// the `OPEN-BLOCKERS:<n>` machine line from a goal-check artifact body -> the integer.
// Fail-closed: an absent line or non-string -> null (the caller treats null as "count
// not attested" = a blocker, never as zero).
function parseOpenBlockers(text) {
  if (typeof text !== 'string') return null
  const m = OPEN_BLOCKERS_RE.exec(text)
  return m ? Number(m[1]) : null
}

// openFlawFindings (PLAN-e2e-verify teeth): a run that REACHED DONE (ctx.missionDone
// === true, the SAME sentinel guard as missionSourceOfTruthFindings so NONE of the
// not-done fixtures flip) whose LATEST goal-check artifact does not carry a CLEAN seal
// is a P0. Clean = OPEN-BLOCKERS:0 AND the E2E axis reads scope=pass prompt=pass
// flaws=0 with a non-empty, non-`none` ran=. ANY open finding at ANY severity
// (OPEN-BLOCKERS>0 or flaws>0), a scope/prompt gap, an empty/`none` run, or an absent
// machine line blocks DONE - the zero-open-any-severity bar (§A/§B). The latest
// artifact wins (append-only vN chronology: the last entry is the frontier).
//
// PERMISSIVE-ON-ABSENCE done right, keyed on REACHING DONE not on bare artifact
// presence: ctx null, missionDone !== true, or NO goal-check artifact -> [] (a run
// that never sealed, or one with no goal-check on disk, is owned elsewhere - this rule
// only refuses to let a DONE seal ride over its OWN goal-check's open flaws).
function openFlawFindings(ctx) {
  const findings = []
  if (ctx == null) return findings
  if (ctx.missionDone !== true) return findings                 // same DONE guard: no not-done fixture flips
  const artifacts = Array.isArray(ctx.goalCheckArtifacts) ? ctx.goalCheckArtifacts : []
  let latest = null
  for (const a of artifacts) {
    if (!a || typeof a !== 'object' || typeof a.text !== 'string') continue
    latest = a                                                  // append-only order: last valid entry is the frontier
  }
  if (latest == null) return findings                           // no goal-check on disk -> not this rule's business
  const where = latest.path || '(unknown goal-check)'
  const open = parseOpenBlockers(latest.text)
  const axis = parseE2EAxis(latest.text)
  const blockers = []
  if (open == null) blockers.push('OPEN-BLOCKERS line absent (count not attested - fail-closed)')
  else if (open > 0) blockers.push(`OPEN-BLOCKERS=${open} (>0 - a flaw at ANY severity is still a flaw that must be fixed before DONE)`)
  if (!axis.present) {
    blockers.push('E2E axis line absent (the tri-axis end-to-end verification was never recorded - fail-closed)')
  } else {
    if (axis.scope !== 'pass') blockers.push('scope=gap (a scope-map/roadmap item was not delivered)')
    if (axis.prompt !== 'pass') blockers.push('prompt=gap (an ask re-derived from the ORIGINAL mission text was not delivered - a too-small scope cannot hide it)')
    if (axis.flaws > 0) blockers.push(`flaws=${axis.flaws} (open adversarial findings remain - must be 0 to seal)`)
    if (axis.ran === '' || /^none$/i.test(axis.ran)) blockers.push('ran= empty/none (no captured end-to-end exercise - "run the thing" evidence is missing)')
  }
  if (blockers.length > 0) {
    findings.push({
      severity: 'P0', rule: 'openFlawFindings',
      title: `DONE SEALED OVER OPEN FLAWS in ${where}: the run reached DONE but its latest goal-check does not carry a clean tri-axis seal - ${blockers.join('; ')}. Every task ends with a real end-to-end run judged against scope + ORIGINAL prompt + potential flaws, and EVERY finding is fixed (or CLOSED with an evidenced WONTFIX-with-reason) before DONE - zero open findings at any severity.`,
    })
  }
  return findings
}
// === E2E-VERIFY-SLICE:END ===

// === STARTUP-HANDSHAKE-SLICE:START - test-only export seam; sliced by
// startup-handshake-coverage.cjs. Self-contained: one pure BRIEF.md parser + one
// ctx-rule over injected transcripts, NO fs; the ONE external dep (CONDUCTOR_ROOT_RE)
// is defined above this block in the module. ===

// parseUnattendedFromBrief (PLAN-startup-handshake): read the `UNATTENDED: yes|no` line
// BRIEF.md records (SKILL.md/MODES.md §Axis-3: INTAKE/SCRIBE writes it). Returns true
// ONLY for an explicit `yes`. ABSENT or `no` -> false (ATTENDED) - the stricter default
// per spec (absent treated as attended so the gate still fires). Non-string -> false.
function parseUnattendedFromBrief(text) {
  if (typeof text !== 'string') return false
  return /^\s*UNATTENDED:\s*yes\s*$/im.test(text)
}

// startupHandshakeFindings (PLAN-startup-handshake teeth - the pre-spawn handshake HARD
// GATE, JA4-Factory bug). P0. The startup-drift signature: an ATTENDED run whose ONE
// unspoofable 00-conductor ROOT (CONDUCTOR_ROOT_RE on the filename) did some OTHER tool
// call before ever asking the forced handshake question - it "ran git status, read files,
// drifted, and NEVER asked" whether the user wants billionaire/tokensaver + which agents.
//
// SIGNAL SET (strongest UNAMBIGUOUS scoping, per .handshake-gate-spec.md lines 62-67):
// the honest on-disk signals cannot separate "knob supplied as a flag" from "knob answered
// via the question" without circularity (the AskUserQuestion-turn presence IS the
// disambiguator, so keying knob-given on it would be circular). So the rule is scoped to
// the two signals it CAN source cleanly:
//   - attended: ctx.attended (runLedgerCheck derives it from BRIEF.md `UNATTENDED:` via
//     parseUnattendedFromBrief; absent BRIEF -> attended, the stricter default).
//   - drift: the ROOT's FIRST tool_use (ctx-scan firstToolUseName, captured in scan order)
//     is not AskUserQuestion, AND the root shows NO
//     AskUserQuestion turn anywhere (hasUserInterrupt !== true - asked-then-proceeded is
//     safe). Agent/Task dispatch is repository work too: missing attended knobs must be
//     resolved before the hierarchy starts, not silently defaulted by the conductor.
//
// Fail-closed (return []): ctx null, transcripts non-array, no 00-conductor ROOT on disk,
// UNATTENDED (ctx.attended !== true), the ROOT emitted no tool_use (firstToolUseName ''),
// the first tool IS AskUserQuestion, or an AskUserQuestion turn appears anywhere in the root.
function startupHandshakeFindings(ctx) {
  const findings = []
  if (ctx == null) return findings
  if (ctx.attended !== true) return findings                    // UNATTENDED / unknown -> handshake legitimately skipped
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || typeof t !== 'object') continue
    if (!CONDUCTOR_ROOT_RE.test(t.path || '')) continue         // ONLY the unspoofable 00-conductor ROOT filename
    if (t.hasUserInterrupt === true) continue                   // asked (anywhere) -> safe
    const first = typeof t.firstToolUseName === 'string' ? t.firstToolUseName : ''
    if (first === '') continue                                  // no tool_use -> nothing to judge
    if (first === 'AskUserQuestion') continue                   // asked FIRST -> correct behavior
    findings.push({
      severity: 'P0', rule: 'startupHandshakeFindings',
      title: `STARTUP HANDSHAKE SKIPPED in ${t.path}: an ATTENDED run's 00-conductor ROOT emitted "${first}" as its FIRST tool call and never fired the pre-spawn handshake AskUserQuestion. The handshake is a HARD GATE - before any other tool use the conductor must resolve all missing concurrency and agent-selection knobs in ONE AskUserQuestion. Ask FIRST, then dispatch.`,
    })
  }
  return findings
}
// === STARTUP-HANDSHAKE-SLICE:END ===

// toolResults: pull tool_result text out of one event (role:user messages whose
// content[] carry {type:'tool_result'}; result text is block.content joined, tolerant
// of string|array shapes). Returns [] for any event with none. Shared by the lean-L0
// parent-fleet-synthesis rule.
function toolResults(event) {
  const out = []
  if (!event || typeof event !== 'object') return out
  const msg = event.message || event
  const content = msg.content
  const blocks = Array.isArray(content) ? content : (Array.isArray(event.content) ? event.content : [])
  for (const b of blocks) {
    if (!b || b.type !== 'tool_result') continue
    const c = b.content
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) out.push(c.map(x => (x && typeof x.text === 'string') ? x.text : (typeof x === 'string' ? x : '')).join('\n'))
    else if (c && typeof c.text === 'string') out.push(c.text)
  }
  return out
}

// hasAssistantText: true when an event is an assistant message carrying a non-empty
// text block (a fold/narration turn). Tolerant of the string and content[] shapes.
function hasAssistantText(event) {
  if (!event || typeof event !== 'object') return false
  const msg = event.message || event
  const role = msg.role || event.type
  if (role !== 'assistant') return false
  const content = msg.content
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return false
  return content.some(b => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
}

// A path is "production" when it is a source file the work changed, NOT a test
// file and NOT a run artifact/ledger checkpoint. Editing a test or reading/
// running the repo's own tests is always allowed (FIX-01 freedom).
function isProductionPath(filePath) {
  const p = filePath.replace(/\\/g, '/').toLowerCase()
  if (/(^|\/)tests?\//.test(p)) return false
  if (/(^|\/)test_[^/]*$/.test(p) || /_test\.[a-z]+$/.test(p) || /\.test\.[a-z]+$/.test(p) || /\.spec\.[a-z]+$/.test(p)) return false
  if (/(^|\/)(artifacts|\.artifacts)\//.test(p)) return false
  if (/(gatelog|agents|coverage|brief|backlog|bucketlist|roadmap|plan)\.md$/.test(p)) return false
  return true
}

// Pull tool_use objects out of one transcript event, tolerant of the common
// shapes: a top-level {type:'tool_use'}, or an assistant message whose content
// array carries tool_use blocks.
function toolUses(event) {
  const uses = []
  if (!event || typeof event !== 'object') return uses
  if (event.type === 'tool_use' && event.name) uses.push(event)
  const content = event.message && event.message.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'tool_use' && block.name) uses.push(block)
    }
  }
  if (Array.isArray(event.content)) {
    for (const block of event.content) {
      if (block && block.type === 'tool_use' && block.name) uses.push(block)
    }
  }
  return uses
}

// selfReviewSignatureFindings (FIX-06 #5 - the REAL F5-18 catch): a single
// transcript that BOTH edited a production file AND ran that feature's verify/
// goal-check pytest is a one-context implement+verify (self-review) signature -
// the exact F5-18 failure. Each such transcript is a P0 finding.
// ctx.transcripts = [{ path, feature, hasProductionEditOrWrite, hasVerifyOrGoalCheckPytest }].
function selfReviewSignatureFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (t && t.hasProductionEditOrWrite === true && t.hasVerifyOrGoalCheckPytest === true) {
      findings.push({
        severity: 'P0',
        rule: 'selfReviewSignatureFindings',
        title: `F5-18 one-context implement+verify (self-review) in ${t.path || '(unknown transcript)'}${t.feature ? ` for ${t.feature}` : ''}: a single transcript both edited a production file AND ran the verify/goal-check test`,
      })
    }
  }
  return findings
}

// The L1 COORDINATOR personas. Kept in lockstep with gate.js LEVEL_OF (duplicated
// by necessity, same as GATE_EXPECTED_PERSONA). The live harness spawns the
// -coordinator names; the -supervisor names are accepted here for BACKWARD COMPAT
// so a historical transcript (recorded before the rename) still parses to L1 and is
// held to the same L1 doctrine. New-name and old-name both classify as L1.
// (BACKWARD-COMPAT ACCEPTOR: parses both -coordinator and -supervisor L1 strings.)
const L1_PERSONAS = new Set([
  'ap-scope-coordinator', 'ap-feature-coordinator', 'ap-sweep-coordinator',
  'ap-scope-supervisor', 'ap-feature-supervisor', 'ap-sweep-supervisor',
])

// isFeatureL1 - the feature-owning L1 under either naming (live -coordinator or the
// -supervisor legacy string). BACKWARD-COMPAT ACCEPTOR used by the billionaire
// serial-feature parser so a historical feature-supervisor transcript still parses.
function isFeatureL1(persona) {
  return persona === 'ap-feature-coordinator' || persona === 'ap-feature-supervisor'
}

// The L3 EXECUTOR personas - the "workers" an L2 ap-manager fans for a feature's real
// disjoint parts. L4 leaves (fresh-verifier/juror/scribe/janitor/goal-checker/depth-prober/
// arbiter/re-anchor/preflight-probe) are terminal attestors, NOT splittable-work workers,
// so they are EXCLUDED from the worker-starvation count.
const L3_EXECUTORS = new Set([
  'ap-scoper', 'ap-planner', 'ap-synthesizer', 'ap-implementer',
  'ap-reviewer', 'ap-verifier', 'ap-sweeper', 'ap-researcher',
  'ap-execharness-resolver', 'ap-framework-generator',
])

// L1_LEGAL_CHILDREN (SCOPE-AT-EVERY-TIER / manager-optional doctrine): an L1
// coordinator may spawn the L2 ap-manager (multi-feature slice) OR - for a single
// bounded feature - dispatch L3 executors + L4 leaves DIRECTLY (the L1->L3 hop is a
// legal manager-skip). Mirrors gate.js LEGAL_CHILDREN_BY_LEVEL.L1. The only ILLEGAL
// L1 children are L0 pre-hierarchy leaves and other L1 coordinators (a coordinator
// may not stand up preflight/intake or a sibling coordinator).
const L4_LEAVES = new Set([
  'ap-fresh-verifier', 'ap-depth-prober', 'ap-framework-validator', 'ap-juror',
  'ap-goal-checker', 'ap-preflight-probe', 'ap-arbiter', 'ap-re-anchor', 'ap-scribe',
  'ap-janitor',
])
const L1_LEGAL_CHILDREN = new Set(['ap-manager', ...L3_EXECUTORS, ...L4_LEAVES,
  // ap-intake is L0-only; ap-preflight-probe already in L4_LEAVES as a leaf spawn.
])
// ap-preflight-probe is the one leaf an L1 must NOT re-spawn (L0 owns it); drop it
// from the L1-legal set so a coordinator re-standing preflight is caught.
L1_LEGAL_CHILDREN.delete('ap-preflight-probe')

// PLAN-dispatch-contract-enforcement - L0's ENTIRE legal spawn set (the CANONICAL
// new-name allowlist the live conductor spawns). Every other persona (the L2
// ap-manager, all L3/L4 workers) is reached ONLY through an L1 coordinator.
const L0_LEGAL_SPAWN_TYPES = new Set([
  'ap-preflight-probe', 'ap-intake',
  'ap-scope-coordinator', 'ap-feature-coordinator', 'ap-sweep-coordinator',
])

// BACKWARD-COMPAT ACCEPTOR: a historical conductor transcript (recorded before the
// supervisor->coordinator rename) that spawned the old L1 -supervisor names is still
// a LEGAL L0 spawn - the allowlist check tolerates these so old ledgers never
// retroactively fail. The live path only ever emits the -coordinator names above.
const L0_LEGACY_SPAWN_TYPES = new Set([
  'ap-scope-supervisor', 'ap-feature-supervisor', 'ap-sweep-supervisor',
])

// managerExecFindings (FIX-10 - F5-04/07/10/15/23): an L2 ap-manager coordinates
// only; it emits ZERO Bash/Edit/Write. A ap-manager transcript that ran any such
// tool is a P0. Fail-closed: a persona-less ('') or non-manager transcript never
// fires; an absent/non-true hasBashEditWrite never fires.
function managerExecFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (t && t.persona === 'ap-manager' && t.hasBashEditWrite === true) {
      findings.push({
        severity: 'P0',
        rule: 'managerExecFindings',
        title: `L2 manager executed in ${t.path || '(unknown transcript)'}: a ap-manager transcript carries a Bash/Edit/Write tool_use, but the manager coordinates only (FIX-10) - execution belongs to the L3 executors it dispatches`,
      })
    }
  }
  return findings
}

// conductorToolUseFindings (FIX-11 / SMASH-1 - F5-19): the L0 conductor is Agent-
// only. A 00-conductor transcript (isConductor) carrying ANY non-Agent tool_use is
// a P0. Fail-closed: a non-conductor transcript NEVER fires, no matter how many
// non-Agent tool_uses it has; an absent/non-true hasNonAgentToolUse never fires.
function conductorToolUseFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (t && t.isConductor === true && t.hasNonAgentToolUse === true) {
      findings.push({
        severity: 'P0',
        rule: 'conductorToolUseFindings',
        title: `L0 conductor emitted a non-Agent tool in ${t.path || '(unknown transcript)'}: the conductor is Agent-only (FIX-11) - it dispatches the hierarchy and touches nothing itself; every Read/Edit/Write/Bash/Grep/Glob is a subagent's job`,
      })
    }
  }
  return findings
}

// l1ChildrenFindings (FIX-13, MANAGER-OPTIONAL doctrine): an L1 coordinator may
// spawn the L2 ap-manager (multi-feature slice) OR dispatch L3 executors + L4 leaves
// DIRECTLY (single bounded feature; the L1->L3 hop is a legal manager-skip). The only
// ILLEGAL L1 children are L0 pre-hierarchy leaves (ap-intake/ap-preflight-probe) and
// sibling L1 coordinators. SEPARATELY enforces the L1 TOOL DOCTRINE (base:68): an L1
// coordinator is Agent-ONLY - ANY non-Agent tool use (Read/Glob/Grep included, plus
// Write/Edit/Bash/WebSearch/WebFetch) is a P0; it keys on hasNonAgentToolUse, not the
// general hasWriteEditBashWebTool flag. Fleet state flows up via Agent-tool results, or
// a reader-leaf reads on its behalf. Fail-closed: a non-L1 persona never fires; an
// absent/non-array spawnedTypes never fires; a clean Agent-only L1 returns [].
function l1ChildrenFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || !L1_PERSONAS.has(t.persona)) continue
    const children = Array.isArray(t.spawnedTypes) ? t.spawnedTypes : []
    const illegal = children.filter(c => !L1_LEGAL_CHILDREN.has(c))
    if (illegal.length) {
      findings.push({
        severity: 'P0',
        rule: 'l1ChildrenFindings',
        title: `L1 coordinator spawned an out-of-band child in ${t.path || '(unknown transcript)'}: "${t.persona}" spawned ${illegal.join(', ')}, but an L1 coordinator's legal children are the L2 ap-manager (multi-feature) OR L3 executors + L4 leaves dispatched directly (single feature) - never an L0 leaf or a sibling L1 (FIX-13, manager-optional)`,
      })
    }
    if (t.hasNonAgentToolUse === true) {
      findings.push({
        severity: 'P0',
        rule: 'l1ChildrenFindings',
        title: `L1 coordinator used a non-Agent tool in ${t.path || '(unknown transcript)'}: "${t.persona}" - an L1 coordinator is Agent-only - Read/Glob/Grep included; fleet state flows up via Agent-tool results, a reader-leaf reads on its behalf`,
      })
    }
  }
  return findings
}

// goalCheckJanitorFindings (FIX-14 - F5-07/F5-15): the GOAL-CHECK verdict is
// authored by ap-goal-checker; the DONE-sentinel is written by ap-janitor. A
// transcript that wrote the sentinel but is not ap-janitor, or authored the
// goal-check but is not ap-goal-checker, is a P0. Fail-closed: absent booleans
// never fire; the correct author returns [].
function goalCheckJanitorFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t) continue
    if (t.wroteDoneSentinel === true && t.persona !== 'ap-janitor') {
      findings.push({
        severity: 'P0',
        rule: 'goalCheckJanitorFindings',
        title: `non-janitor wrote the DONE-sentinel in ${t.path || '(unknown transcript)'}: persona "${t.persona || '(none)'}" wrote /DONE, but only the typed L4 leaf ap-janitor may write the sentinel (FIX-14) - an L2-written /DONE is INVALID`,
      })
    }
    if (t.wroteGoalCheck === true && t.persona !== 'ap-goal-checker') {
      findings.push({
        severity: 'P0',
        rule: 'goalCheckJanitorFindings',
        title: `non-goal-checker authored the goal-check in ${t.path || '(unknown transcript)'}: persona "${t.persona || '(none)'}" wrote the goal-check verdict, but only the typed L4 leaf ap-goal-checker may author it (FIX-14) - a manager-authored goal-check is INVALID`,
      })
    }
    if (t.wroteAnchor === true && t.persona !== 'ap-scribe') {
      findings.push({
        severity: 'P0',
        rule: 'goalCheckJanitorFindings',
        title: `non-scribe wrote ANCHOR.md in ${t.path || '(unknown transcript)'}: persona "${t.persona || '(none)'}" wrote the parent anchor file, but ANCHOR.md is SCRIBE-only (the upper levels never write files) - an L0/L1/L2-written ANCHOR.md is INVALID`,
      })
    }
  }
  return findings
}

// preflightEditFindings (FIX-17 - F5-22): the PREFLIGHT probe proves RUN/READ/WRITE
// on a SCRATCH file then returns; it NEVER edits a production source file (the G4
// IMPLEMENT role is a separate dispatched ap-implementer). A ap-preflight-probe
// transcript with a production Edit/Write is a P0. Fail-closed: a non-probe persona
// never fires (the implementer SHOULD edit production); a scratch/artifact write
// (editsProductionFile false) returns []. editsProductionFile is the existing
// hasProductionEditOrWrite field surfaced per-persona.
function preflightEditFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (t && t.persona === 'ap-preflight-probe' && t.editsProductionFile === true) {
      findings.push({
        severity: 'P0',
        rule: 'preflightEditFindings',
        title: `PREFLIGHT probe edited production in ${t.path || '(unknown transcript)'}: a ap-preflight-probe transcript edited a production source file, but the probe only proves RUN/READ/WRITE on a SCRATCH file then returns (FIX-17) - IMPLEMENT belongs to a dispatched ap-implementer`,
      })
    }
  }
  return findings
}

// normalizeFrontier: array|string|null -> a stable comparable string. An array of
// {feature,status} (or strings) is sorted and joined; a string is trimmed; null/
// undefined -> '' (so empty===empty is a match). Pure, total.
function normalizeFrontier(frontier) {
  if (frontier == null) return ''
  if (Array.isArray(frontier)) {
    return frontier
      .map(e => (e && typeof e === 'object') ? `${e.feature || ''}:${e.status || ''}` : String(e))
      .map(s => s.trim()).filter(Boolean).sort().join('|')
  }
  return String(frontier).trim()
}

// selfBlockYieldFindings (PLAN-anchor - MISSION: "theres no such thing as a self
// block"; "dont interrupt this shit ever again"): FLAGS (P0) a run where L0 RETURNED
// CONTROL to the user with open in-flight tracks AND no irreversible question
// pending. ctx.yieldState = { returnedToUser, openInFlightTracks,
// irreversibleQuestionPending }. Fail-closed: absent/malformed yieldState -> [].
// A legitimate ATTENDED irreversible/credential yield (arbiter-deferred ->
// irreversibleQuestionPending true) NEVER fires. openInFlightTracks coerced:
// a non-finite/negative value is treated as 0 (no open tracks -> no finding).
function selfBlockYieldFindings(ctx) {
  const findings = []
  const y = ctx && typeof ctx.yieldState === 'object' && ctx.yieldState ? ctx.yieldState : null
  if (!y) return findings
  const openTracks = Number.isFinite(y.openInFlightTracks) && y.openInFlightTracks > 0 ? y.openInFlightTracks : 0
  if (y.returnedToUser === true && openTracks > 0 && y.irreversibleQuestionPending !== true) {
    findings.push({
      severity: 'P0',
      rule: 'selfBlockYieldFindings',
      title: `SELF-BLOCK / MID-LOOP YIELD: L0 returned control to the user with ${openTracks} open in-flight track(s) and no ARBITER-deferred irreversible question pending - a closed loop drives its own dependencies to done (LAW 3c) and never self-blocks or interrupts`,
    })
  }
  return findings
}

// idleFinishFindings (MISSION: "agents go IDLE ... finish doing nothing for HOURS ...
// an agent can never again sit idle / finish having done nothing"): FLAGS (P0) a run
// that ENDED (terminal audit) with the mission NOT done, open in-flight tracks, NO
// live agents, and NO irreversible/credential blocker - the SILENT idle-finish the
// mid-run lints structurally miss. The conjunction of five directly-observable facts:
//   (1) runEnded === true                  - a terminal audit (--terminal / RUN-ENDED marker);
//                                             a mid-run snapshot NEVER fires (no false-positive
//                                             on a healthy between-wave lull)
//   (2) missionDone !== true               - no DONE-sentinel sealing the mission
//   (3) openInFlightTracks > 0             - work remains (a feature with gate rows, no G8 seal)
//   (4) hasLiveAgents !== true             - no fresh sub-*.jsonl, no LIVE frontier entry:
//                                             nobody is actually driving
//   (5) irreversibleQuestionPending !== true - not a legitimate ATTENDED credential park
// DISTINCT from leanIdleFindings (mid-run, P1, keyed on lean+idle NARRATION) and from
// selfBlockYieldFindings (keyed on an explicit AskUserQuestion user-yield). This rule
// needs NEITHER a narration nor a yield - it fires on the ABSENCE of progress at the
// run boundary, which is why it catches the silent stop the others miss. Fail-closed:
// a non-terminal audit, a sealed mission, zero open tracks, any live agent, or a pending
// irreversible question all suppress it.
function idleFinishFindings(ctx) {
  const findings = []
  const s = ctx && typeof ctx.idleFinishState === 'object' && ctx.idleFinishState ? ctx.idleFinishState : null
  if (!s) return findings
  if (s.runEnded !== true) return findings
  if (s.missionDone === true) return findings
  if (s.irreversibleQuestionPending === true) return findings
  if (s.hasLiveAgents === true) return findings
  const openTracks = Number.isFinite(s.openInFlightTracks) && s.openInFlightTracks > 0 ? s.openInFlightTracks : 0
  if (openTracks > 0) {
    findings.push({
      severity: 'P0',
      rule: 'idleFinishFindings',
      title: `IDLE-FINISH: the run ENDED with ${openTracks} open in-flight track(s), no DONE-sentinel, no live agent on disk, and no ARBITER-deferred irreversible question - a closed loop self-drives to done (LAW 3, iron rule 10) and must never finish having done nothing; the COORDINATOR's progress-heartbeat must re-drive the next unblocked wave`,
    })
  }
  return findings
}

// anchorIntegrityFindings (PLAN-anchor - MISSION: parent-anchor file refilled,
// "compacts... not wipes... new agent gets that file- can resume normal"): PAST THE
// FIRST COMPACTION the anchor file MUST EXIST and its LIVE FRONTIER MUST MATCH
// GATELOG. ctx.anchorState = { compactionOccurred, anchorExists, anchorFrontier,
// gatelogFrontier }. Fail-closed: absent/malformed anchorState -> []. Before any
// compaction (compactionOccurred !== true) the anchor is not yet required -> [].
// Frontier compared by normalized string equality; empty===empty is a MATCH.
function anchorIntegrityFindings(ctx) {
  const findings = []
  const a = ctx && typeof ctx.anchorState === 'object' && ctx.anchorState ? ctx.anchorState : null
  if (!a || a.compactionOccurred !== true) return findings
  if (a.anchorExists !== true) {
    findings.push({
      severity: 'P0',
      rule: 'anchorIntegrityFindings',
      title: `ANCHOR.md missing after a compaction: a compacted run has no SCRIBE-maintained ANCHOR.md, so a fresh-context agent cannot resume the hierarchy at the frontier - the parent-anchor refill file is mandatory once the run has compacted`,
    })
    return findings
  }
  const normA = normalizeFrontier(a.anchorFrontier)
  const normG = normalizeFrontier(a.gatelogFrontier)
  if (normA !== normG) {
    findings.push({
      severity: 'P0',
      rule: 'anchorIntegrityFindings',
      title: `ANCHOR.md frontier drifted from GATELOG after a compaction: anchor frontier "${normA}" != gatelog frontier "${normG}" - the resume anchor no longer matches the real gate state; the SCRIBE must rebuild ANCHOR.md from GATELOG`,
    })
  }
  return findings
}

// parseModeFromBrief (SHARED - SPEC-2 wave-barrier + no-idle): resolve the run mode
// from BRIEF.md text. 'billionaire' / 'tokensaver' / '' (unknown -> fail-closed, the
// mode-scoped rules never fire). Add ONCE; reused by both rules.
function parseModeFromBrief(text) {
  const t = typeof text === 'string' ? text : ''
  // WIDE is the professional primary name; BILLIONAIRE is the retained alias; CUSTOM
  // is wide-fan-out bounded by max_subs. All three are parallel, so they resolve to
  // the canonical INTERNAL 'billionaire' token, keeping every billionaire-keyed lint
  // (serial-gate/feature, wave-barrier, provenance) firing for them.
  if (/EXECUTION MODE:\s*(BILLIONAIRE|WIDE|CUSTOM)/i.test(t)) return 'billionaire'
  if (/EXECUTION MODE:\s*TOKENSAVER/i.test(t)) return 'tokensaver'
  return ''
}

// parseSerializationEnforcement (SPD-3): true when BRIEF.md carries the F-SPEED-era marker
// `SERIALIZATION ENFORCEMENT: P0` (case/spacing tolerant). The BILLIONAIRE default brief writes it,
// which escalates serialGateFindings + serialFeatureFindings from surfaced-P1 to run-failing P0. A
// pre-F-SPEED brief lacks the marker -> the rules stay P1 -> a historical run is never retroactively
// failed. Non-string -> false (fail-closed).
function parseSerializationEnforcement(text) {
  if (typeof text !== 'string') return false
  return /SERIALIZATION ENFORCEMENT:\s*P0/i.test(text)
}

// isWaveBarrier (SPEC-2): a BILLIONAIRE conductor that batched a >=2-spawn wave in one
// turn then made NO further fold/dispatch - the wave-stall ("hallucinates subagents
// are running and simply waits"). The correct streamed pattern always has a post-wave
// fold/dispatch, so it is cleared. Fail-closed on missing fields / non-billionaire.
function isWaveBarrier(scan) {
  if (!scan || scan.isConductor !== true || scan.isBillionaire !== true) return false
  return (scan.maxBatchedSpawns || 0) >= 2 && scan.hadFoldOrDispatchAfterWave !== true
}

// waveBarrierFindings (SPEC-2 - MISSION wave-stall): each BILLIONAIRE conductor
// transcript that dispatched a wave then stalled is a P0. DISTINCT from
// conductorToolUseFindings (tool misuse) and livenessReconcileFindings (narrate-
// without-poll). Fail-closed: non-conductor / non-billionaire / no-wave never fires.
function waveBarrierFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (isWaveBarrier(t)) {
      findings.push({
        severity: 'P0',
        rule: 'waveBarrierFindings',
        title: `WAVE-BARRIER in ${t.path || '(unknown transcript)'}: a BILLIONAIRE conductor batched ${t.maxBatchedSpawns} tracks in one wave then made NO further fold/dispatch (SPEC-2 wave-stall) - it dispatched the wave and "hallucinates subagents are running and simply waits"; stream completions and dispatch the next track as results arrive, never stall on the wave (see ASSESSMENT-ARCHIVE.md round-2)`,
      })
    }
  }
  return findings
}

// thinSprawlFindings (PLAN-fanout-fix - DEFECT-1's preserved anti-sprawl guard): a P0
// for either (i) a non-spawning L3 persona that recursed (spawned anything), or (ii)
// identical (persona, description) spawns repeated >= THIN_SPRAWL_REPEAT in one
// transcript (templated 1-per-query batch). The ONLY new fanout rule - NO count rule.
// Fail-closed: absent/empty spawnedTypes never fires; ap-implementer with distinct
// descriptions (the L3 that MAY fan out) is never flagged.
function thinSprawlFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || typeof t !== 'object') continue
    const spawns = Array.isArray(t.spawnedTypes) ? t.spawnedTypes : []
    if (spawns.length === 0) continue
    if (L3_NON_SPAWNING.has(t.persona)) {
      findings.push({
        severity: 'P0',
        rule: 'thinSprawlFindings',
        title: `thin-sprawl in ${t.path || '(unknown transcript)'}: an L3 recursed on its own job - the non-spawning L3 persona "${t.persona}" spawned ${spawns.join(', ')}, but only ap-implementer/ap-intake may fan out; every other L3 does its one job in its own context`,
      })
      continue
    }
    const descriptions = Array.isArray(t.spawnedDescriptions) ? t.spawnedDescriptions : []
    const counts = new Map()
    for (let i = 0; i < descriptions.length; i++) {
      const key = `${spawns[i] || ''}::${descriptions[i]}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    const maxRepeat = counts.size ? Math.max(...counts.values()) : 0
    if (maxRepeat >= THIN_SPRAWL_REPEAT) {
      findings.push({
        severity: 'P0',
        rule: 'thinSprawlFindings',
        title: `thin-sprawl in ${t.path || '(unknown transcript)'}: ${maxRepeat} identical (persona, description) spawns in one transcript (batch 1..N / 1-per-query) - fan out by genuine distinct work, never by templated identical leaves`,
      })
    }
  }
  return findings
}

// conductorSpawnAllowlistFindings (PLAN-dispatch-contract-enforcement): the L0
// conductor's ENTIRE legal spawn set is the L0_LEGAL_SPAWN_TYPES allowlist. A
// conductor transcript that spawned anything outside it skipped the supervisor
// (solo-collapse) - P0, naming every illegal child. Reuses the existing isConductor
// + spawnedTypes fields (NO scanner change). Fail-closed: non-conductor never fires.
function conductorSpawnAllowlistFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || t.isConductor !== true) continue
    const children = Array.isArray(t.spawnedTypes) ? t.spawnedTypes : []
    const illegal = children.filter(c => !L0_LEGAL_SPAWN_TYPES.has(c) && !L0_LEGACY_SPAWN_TYPES.has(c))
    if (illegal.length) {
      findings.push({
        severity: 'P0',
        rule: 'conductorSpawnAllowlistFindings',
        title: `L0 conductor spawned a worker directly in ${t.path || '(unknown transcript)'}: spawned ${illegal.join(', ')}, but L0's ENTIRE legal spawn set is ap-preflight-probe / ap-intake / cl-scope|feature|sweep-coordinator - every other persona (the L2 ap-manager, all L3/L4 workers) is reached ONLY through an L1 coordinator (skip-the-supervisor solo-collapse)`,
      })
    }
  }
  return findings
}

// leanIdleFindings (PLAN-no-idle-pushwork - MISSION: "lean means lean on CONTEXT, not
// lean on WORK"): P1 (surfaced, not run-failing) for a BILLIONAIRE conductor turn that
// idled on a lean-excuse (lean+idle narration, no dependency justification) AND
// dispatched ZERO tracks. Fail-closed: non-conductor / non-billionaire / absent flag /
// a turn that DID dispatch never fires.
function leanIdleFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || t.isConductor !== true) continue
    if (t.mode !== 'billionaire') continue
    if (t.hasLeanAsIdleNarration !== true) continue
    if (t.dispatchedAnyTrack !== false) continue
    findings.push({
      severity: 'P1',
      rule: 'leanIdleFindings',
      title: `LEAN-AS-IDLE in ${t.path || '(unknown transcript)'}: a BILLIONAIRE L0 conductor turn idled on a "staying lean" excuse (lean + wait narration, no dependency/convergence justification) and dispatched NO track - leanness is a CONTEXT directive, never a reason to withhold dispatchable independent work (PUSH-WORK LOOP); only genuine dependency-blocks wait`,
    })
  }
  return findings
}

// parentFleetSynthesisFindings (PLAN-lean-L0-coordinator - MISSION: "parent agent ...
// getting dumber by each time someone finishes ... HAS TO STAY LEAN"): FLAGS (P0) a
// CONDUCTOR transcript doing the COORDINATOR's job in L0's own context - synthesis
// accumulation. Either an over-budget ingested report OR a fleet-table rebuilt across
// turns fires. Fail-closed: non-conductor / absent flags never fire.
function parentFleetSynthesisFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || t.isConductor !== true) continue
    const oversized = t.hasOversizedReport === true
    const tableTurns = Number.isFinite(t.fleetTableTurns) && t.fleetTableTurns > 0 ? t.fleetTableTurns : 0
    if (oversized) {
      findings.push({
        severity: 'P0',
        rule: 'parentFleetSynthesisFindings',
        title: `PARENT-SIDE FLEET SYNTHESIS in ${t.path || '(unknown transcript)'}: the L0 conductor ingested an over-budget report (${t.maxToolResultChars || 0} chars, or a diff / test-runner dump) instead of a <=150-word verdict - the collecting belongs to the COORDINATOR (disk-sourced), L0 stays lean`,
      })
    }
    if (tableTurns >= FLEET_TABLE_TURN_MIN) {
      findings.push({
        severity: 'P0',
        rule: 'parentFleetSynthesisFindings',
        title: `PARENT-SIDE FLEET SYNTHESIS in ${t.path || '(unknown transcript)'}: the L0 conductor rebuilt a fleet-state table across ${tableTurns} turns - re-synthesizing fleet state each time a track finishes is what makes the parent "dumber each time someone finishes"; that reasoning is the COORDINATOR's job`,
      })
    }
  }
  return findings
}

// midRunCancelCheckpointFindings (PLAN-midrun-insertion - MISSION: "if its urgent:
// save state, cancel the prompt, continue"): FLAGS (P0) an URGENT mid-run steer that
// CANCELLED a track WITHOUT first checkpointing its frontier to disk. The save MUST
// precede the cancel. ctx.steerState = { urgentCancels: [{feature,
// checkpointedBeforeCancel}] }. Fail-closed: absent/malformed steerState -> [];
// checkpointedBeforeCancel must be EXACTLY true to be safe.
function midRunCancelCheckpointFindings(ctx) {
  const findings = []
  const s = ctx && typeof ctx.steerState === 'object' && ctx.steerState ? ctx.steerState : null
  if (!s) return findings
  const cancels = Array.isArray(s.urgentCancels) ? s.urgentCancels : []
  for (const c of cancels) {
    if (!c || typeof c !== 'object') continue
    if (c.checkpointedBeforeCancel !== true) {
      findings.push({
        severity: 'P0',
        rule: 'midRunCancelCheckpointFindings',
        title: `MID-RUN STEER data loss: track "${c.feature || '(unknown)'}" was CANCELLED (TaskStop) for an urgent steer WITHOUT its frontier checkpointed to disk first - the URGENT mode MUST save state (ANCHOR.md/GATELOG frontier, atomic .tmp->rename) BEFORE the cancel, else the track's progress is lost`,
      })
    }
  }
  return findings
}

// deriveSteerCancels (PLAN-midrun-insertion): own raw line-scan over GATELOG lines
// (NOT parseGatelogRow). For each `STEER URGENT <feature>`, checkpointedBeforeCancel is
// true IFF a `CHECKPOINT <feature>` row precedes the matching `CANCEL <feature>` row in
// append-only chronological order. A CANCEL with no preceding CHECKPOINT -> false.
// Pure, total; [] on no urgent steer rows. Accepts an array of raw line strings.
function deriveSteerCancels(lines) {
  const rows = Array.isArray(lines) ? lines : []
  const urgentFeatures = new Set()
  const checkpointIndex = new Map()
  const cancelIndex = new Map()
  for (let i = 0; i < rows.length; i++) {
    const line = String(rows[i] || '').replace(/^\[at[^\]]*\]\s*/, '').trim()
    let m
    if ((m = line.match(/^STEER\s+URGENT\s+(\S+)/))) {
      if (m[1] !== 'GLOBAL') urgentFeatures.add(m[1])
    } else if ((m = line.match(/^CHECKPOINT\s+(\S+)/))) {
      if (!checkpointIndex.has(m[1])) checkpointIndex.set(m[1], i)
    } else if ((m = line.match(/^CANCEL\s+(\S+)/))) {
      if (!cancelIndex.has(m[1])) cancelIndex.set(m[1], i)
    }
  }
  const out = []
  for (const feature of urgentFeatures) {
    if (!cancelIndex.has(feature)) continue
    const cancelAt = cancelIndex.get(feature)
    const checkpointAt = checkpointIndex.has(feature) ? checkpointIndex.get(feature) : Infinity
    out.push({ feature, checkpointedBeforeCancel: checkpointAt < cancelAt })
  }
  return out
}

// deriveFeatureTargets (PLAN-proportional-gates): own raw line-scan over GATELOG lines
// for the EXPLICIT per-feature target-file token (`target=<path>` or `file=<path>`).
// The soundness bar forbids guessing a feature's file from prose - only an explicit
// token counts, so an absent token yields nothing (fail-closed). Pure, total; [] on a
// non-array input. Deduped on feature+file. Accepts an array of raw line strings.
function deriveFeatureTargets(lines) {
  const rows = Array.isArray(lines) ? lines : []
  const seen = new Set()
  const out = []
  for (const raw of rows) {
    const line = String(raw || '').replace(/^\[at[^\]]*\]\s*/, '').trim()
    const m = FEATURE_TARGET_RE.exec(line)
    if (!m) continue
    const key = `${m[1]}::${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ feature: m[1], file: m[2] })
  }
  return out
}

// deriveFeatureDecomposition (cohort): parse the mandatory DECOMPOSE rows from raw GATELOG
// lines into [{feature, phase, deps:Set, owns:Set}]. Pure, total; [] on non-array. First decl wins.
function deriveFeatureDecomposition(lines) {
  const rows = Array.isArray(lines) ? lines : []
  const byFeature = new Map()
  for (const raw of rows) {
    const line = String(raw || '').replace(/^\[at[^\]]*\]\s*/, '').trim()
    const m = FEATURE_DECL_RE.exec(line)
    if (!m) continue
    const feature = m[1].toUpperCase()
    if (byFeature.has(feature)) continue
    const deps = new Set(m[3].toLowerCase() === 'none' ? [] : m[3].split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
    const owns = new Set(m[4].split(',').map(s => s.trim()).filter(Boolean))
    byFeature.set(feature, { feature, phase: m[2], deps, owns })
  }
  return [...byFeature.values()]
}

// deriveFeatureDispatches (the FIRING signal): parse the mandatory DISPATCH rows from raw GATELOG
// lines into [{feature, wave}]. The [at …] prefix is stripped before matching. Deduped on
// feature|wave so a duplicated row never inflates wave cardinality. Pure, total; [] on non-array.
function deriveFeatureDispatches(lines) {
  const rows = Array.isArray(lines) ? lines : []
  const seen = new Set()
  const out = []
  for (const raw of rows) {
    const line = String(raw || '').replace(/^\[at[^\]]*\]\s*/, '').trim()
    const m = DISPATCH_RE.exec(line)
    if (!m) continue
    const key = `${m[1].toUpperCase()}|${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ feature: m[1].toUpperCase(), wave: m[2] })
  }
  return out
}

// deriveFeatureMeta (SPD-1): parse the mandatory FEATURE-META rows from raw GATELOG lines into
// [{feature, tier, framework, issues, tag}]. The [at …] prefix is stripped before matching. First-decl-wins
// per feature. issues coerced to a number. The optional trailing `tag=` carries the AUTHORITATIVE playbook
// classification derived from ROADMAP.md on new runs or INTAKE on legacy resumes ('' when absent). Pure, total; [] on non-array.
// Byte-identical pattern to deriveFeatureDispatches/deriveFeatureDecomposition.
function deriveFeatureMeta(lines) {
  const rows = Array.isArray(lines) ? lines : []
  const byFeature = new Map()
  for (const raw of rows) {
    const line = String(raw || '').replace(/^\[at[^\]]*\]\s*/, '').trim()
    const m = FEATURE_META_RE.exec(line)
    if (!m) continue
    const feature = m[1].toUpperCase()
    if (byFeature.has(feature)) continue
    byFeature.set(feature, { feature, tier: m[2], framework: m[3], issues: parseInt(m[4], 10), tag: m[5] || '' })
  }
  return [...byFeature.values()]
}

// deriveCeremonyRows (SPD-1): own raw line-scan over GATELOG lines for the over-tiering ceremony rows
// attributed to a feature - SCOPE / SCOPE-AND-ROADMAP and END-VERDICT. Returns two Sets of feature ids.
// Pure, total; empty sets on a non-array input (fail-closed).
function deriveCeremonyRows(lines) {
  const rows = Array.isArray(lines) ? lines : []
  const scopeFeatures = new Set()
  const endVerdictFeatures = new Set()
  for (const raw of rows) {
    const line = String(raw || '').replace(/^\[at[^\]]*\]\s*/, '').trim()
    let m
    if ((m = SCOPE_ROW_RE.exec(line))) scopeFeatures.add(m[1].toUpperCase())
    else if ((m = END_VERDICT_ROW_RE.exec(line))) endVerdictFeatures.add(m[1].toUpperCase())
  }
  return { scopeFeatures, endVerdictFeatures }
}

// isSingleFileSingleIssue (SPD-1 helper): a feature is the lean-T1 class when its FEATURE-META issues
// count is exactly 1 AND its DECOMPOSE owns set is exactly ONE concrete path (no glob wildcard). The
// single owned path is returned for the finding title; null when the feature is NOT single-file+single-
// issue (multi-file, glob, multi-issue, or no DECOMPOSE owns) so the rule fail-closes.
function singleOwnedFile(metaRow, decompByFeature) {
  if (!metaRow || metaRow.issues !== 1) return null
  const decomp = decompByFeature.get(metaRow.feature)
  if (!decomp || !(decomp.owns instanceof Set) || decomp.owns.size !== 1) return null
  const only = [...decomp.owns][0]
  if (typeof only !== 'string' || only === '' || only.includes('*')) return null
  return only
}

// tierProportionalityFindings (SPD-1 - P0, fail-closed): a single-file + single-issue feature that
// recorded an over-tiered shape ran the T2/T3 ceremony the DIAGNOSIS §3 lever targets. ANY of FOUR
// signals fires it: (1) recorded tier T2/T3; (2) a SCOPE-AND-ROADMAP row attributed to it, OR a
// plan-scope framework on a single-file fix; (3) a 3-juror (>=3) G7 panel; (4) an over-tiered END-VERDICT
// row. The single-file+single-issue floor is the GATE: a multi-file/glob/multi-issue feature, or one
// with no FEATURE-META row, NEVER fires (a legacy ledger is never retroactively failed; pylint-7080's
// correct lean T1 produces ZERO). Severity P0 -> flips ok to false.
function tierProportionalityFindings(ctx) {
  const findings = []
  const featureMeta = Array.isArray(ctx.featureMeta) ? ctx.featureMeta : []
  if (featureMeta.length === 0) return findings
  const gatelog = Array.isArray(ctx.gatelog) ? ctx.gatelog : []
  const decomp = Array.isArray(ctx.featureDecomposition) ? ctx.featureDecomposition : []
  const ceremony = ctx.ceremonyRows && typeof ctx.ceremonyRows === 'object'
    ? ctx.ceremonyRows : { scopeFeatures: new Set(), endVerdictFeatures: new Set() }
  const scopeFeatures = ceremony.scopeFeatures instanceof Set ? ceremony.scopeFeatures : new Set()
  const endVerdictFeatures = ceremony.endVerdictFeatures instanceof Set ? ceremony.endVerdictFeatures : new Set()
  const decompByFeature = new Map()
  for (const d of decomp) if (d && d.feature) decompByFeature.set(d.feature, d)
  const g7CountByFeature = new Map()
  for (const r of gatelog) {
    if (!r || r.gate !== 'G7' || !r.feature) continue
    g7CountByFeature.set(r.feature, (g7CountByFeature.get(r.feature) || 0) + 1)
  }
  for (const metaRow of featureMeta) {
    const file = singleOwnedFile(metaRow, decompByFeature)
    if (!file) continue                                            // fail-closed: not single-file+single-issue
    const signals = []
    if (metaRow.tier === 'T2' || metaRow.tier === 'T3') signals.push(`tier ${metaRow.tier}`)
    if (scopeFeatures.has(metaRow.feature) || metaRow.framework === 'plan-scope') signals.push('SCOPE-AND-ROADMAP')
    if ((g7CountByFeature.get(metaRow.feature) || 0) >= THREE_JUROR_PANEL) signals.push('3-juror G7 panel')
    if (endVerdictFeatures.has(metaRow.feature)) signals.push('END-VERDICT')
    if (signals.length === 0) continue
    findings.push({
      severity: 'P0',
      rule: 'tierProportionalityFindings',
      title: `OVER-TIERED in ${metaRow.feature}: a single-file (${file}) single-issue feature recorded ${signals.join(' / ')} - a single-file single-issue bug fix runs the T1 debug path (implement->review->verify-once->goal-check->scribe), never the T2/T3 ceremony (SCOPE-AND-ROADMAP, a 3-juror G7 panel, an over-tiered END-VERDICT). DIAGNOSIS §3: the lever is the T2 threshold + single-issue floor, not a blanket de-tier`,
    })
  }
  return findings
}

// evidencePackFindings (SPD-2 - P1, fail-closed): when >1 gate transcript of the SAME feature
// independently Reads the SAME production file AND no <feature>-context.md evidence pack exists on
// disk, the L2 manager skipped the once-per-feature pack and every gate re-Read the repo - the
// DIAGNOSIS §3 main-orchestrator + intake re-read cost (42%+ of spend). NOTE the honest scope: this
// rule proves DUPLICATE gate prod-file reads with no pack; it does NOT itself prove the 42%
// main-orchestrator figure (that burn is addressed by F-INH's cached-prefix work per DIAGNOSIS §6,
// not by these teeth). P1 surfaces it; ok is unaffected. Fail-closed: <2 readers of a file, the pack
// present, a feature with no label, or non-array fields -> nothing.
function evidencePackFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  const artifactExists = typeof ctx.artifactExists === 'function' ? ctx.artifactExists : () => false
  // group: feature -> (file -> count of distinct gate transcripts that Read it)
  const byFeature = new Map()
  for (const t of transcripts) {
    if (!t || typeof t !== 'object' || !t.feature) continue
    const reads = Array.isArray(t.readsProductionFiles) ? t.readsProductionFiles : []
    if (reads.length === 0) continue
    if (!byFeature.has(t.feature)) byFeature.set(t.feature, new Map())
    const fileCounts = byFeature.get(t.feature)
    for (const file of new Set(reads)) fileCounts.set(file, (fileCounts.get(file) || 0) + 1)
  }
  for (const [feature, fileCounts] of byFeature) {
    if (artifactExists(`${feature}-context.md`)) continue          // the pack did its job
    for (const [file, count] of fileCounts) {
      if (count < 2) continue                                      // a single reader needs no pack
      findings.push({
        severity: 'P1',
        rule: 'evidencePackFindings',
        title: `EVIDENCE-PACK MISSING in ${feature}: ${count} gates independently Read ${file} with no ${feature}-context.md pack on disk - the L2 manager must assemble the touched-file evidence pack ONCE before the first gate (DIAGNOSIS §3: main-orchestrator + intake re-read is 42%+ of spend); gates pull from the pack, not re-Read the repo`,
      })
    }
  }
  return findings
}

// frameworkTierFindings (SPD-4 - P1, fail-closed): every feature records a FEATURE-META tier+framework
// row; a recorded leaf whose tier band does NOT admit the recorded tier (a T3-only build leaf on a T1
// single-file fix) is a FRAMEWORK-TIER MISMATCH. Uses the pure leafTierConsistent inlined above:
// only a KNOWN leaf with a KNOWN-bad tier fires; an unknown leaf (a generated gen-* leaf, MISS) or an
// unparseable tier yields { known:false } -> no fire (fail-closed). Absent FEATURE-META -> nothing.
function frameworkTierFindings(ctx) {
  const findings = []
  const featureMeta = Array.isArray(ctx.featureMeta) ? ctx.featureMeta : []
  for (const metaRow of featureMeta) {
    if (!metaRow || typeof metaRow.framework !== 'string' || typeof metaRow.tier !== 'string') continue
    const verdict = leafTierConsistent(metaRow.framework, metaRow.tier)
    if (!verdict.known || verdict.ok) continue                     // unknown leaf/tier or consistent -> no fire
    const band = LEAF_TIER_BANDS[metaRow.framework].join('/')
    findings.push({
      severity: 'P1',
      rule: 'frameworkTierFindings',
      title: `FRAMEWORK-TIER MISMATCH in ${metaRow.feature}: framework '${metaRow.framework}' (tiers ${band}) recorded on a tier ${metaRow.tier} feature - the recorded leaf must match the feature's true tier; no T3 leaf on T1 work (SPD-4)`,
    })
  }
  return findings
}

// proportionalGatesFindings (PLAN-proportional-gates - the mission's core fix): P1
// (surfaced, does NOT flip ok - same class as commitCheckpointFindings/leanIdleFindings).
// ARM A - a feature whose GATELOG carries a FRESH G1/G2/G3 design row AND a frozen-plan
// artifact for it already exists on disk that those design rows did NOT produce (it was
// not named among their own artifacts) - re-running G1-G3 over a frozen spec, which earns
// apply->diff-review->verify-green (G4-G6) only. ARM B - >= PROPORTIONAL_SIBLING_FLOOR
// distinct sibling features that EACH ran a full G1..G8 pipeline yet all target ONE file -
// N gated features where the mission demands ONE batched implementer pass + ONE verify.
// Soundness: every signal is derived from ledger data actually present (GATELOG gate rows,
// on-disk frozen artifacts, explicit per-feature target tokens). A missing discriminator
// is never guessed -> fail-closed (emit nothing). Fail-closed on non-array ctx fields.
function proportionalGatesFindings(ctx) {
  const findings = []
  const gatelog = Array.isArray(ctx.gatelog) ? ctx.gatelog : []
  const artifactExists = typeof ctx.artifactExists === 'function' ? ctx.artifactExists : () => false
  const readArtifact = typeof ctx.readArtifact === 'function' ? ctx.readArtifact : () => null
  const featureTargets = Array.isArray(ctx.featureTargets) ? ctx.featureTargets : []

  const gatesByFeature = new Map()
  const designArtifactsByFeature = new Map()
  for (const r of gatelog) {
    if (!r || !r.feature || !r.gate) continue
    if (!gatesByFeature.has(r.feature)) {
      gatesByFeature.set(r.feature, new Set())
      designArtifactsByFeature.set(r.feature, new Set())
    }
    gatesByFeature.get(r.feature).add(r.gate)
    if (DESIGN_GATES.includes(r.gate)) {
      for (const a of (Array.isArray(r.artifacts) ? r.artifacts : [])) designArtifactsByFeature.get(r.feature).add(a)
    }
  }

  for (const [feature, gates] of gatesByFeature) {
    const ranDesign = DESIGN_GATES.some(g => gates.has(g))
    if (!ranDesign) continue
    const frozen = findFrozenPlanArtifact(feature, designArtifactsByFeature.get(feature), artifactExists, readArtifact)
    if (frozen) {
      findings.push({
        severity: 'P1',
        rule: 'proportionalGatesFindings',
        title: `OVER-CEREMONY (re-ran design on a frozen spec) in ${feature}: a fresh G1-G3 design cycle ran while the frozen plan ${frozen} already exists on disk and was not produced by those rows - applying an already-frozen/reviewed/fresh-verified spec earns apply->diff-review->verify-green (G4-G6) ONLY, never a fresh G1-G3 design cycle`,
      })
    }
  }

  const targetByFeature = new Map()
  for (const e of featureTargets) {
    if (e && e.feature && typeof e.file === 'string') targetByFeature.set(e.feature, e.file)
  }
  const siblingsByFile = new Map()
  for (const [feature, gates] of gatesByFeature) {
    const ranFullPipeline = FULL_PIPELINE_GATES.every(g => gates.has(g))
    if (!ranFullPipeline) continue
    const file = targetByFeature.get(feature)
    if (!file) continue
    if (!siblingsByFile.has(file)) siblingsByFile.set(file, [])
    siblingsByFile.get(file).push(feature)
  }
  for (const [file, siblings] of siblingsByFile) {
    if (siblings.length < PROPORTIONAL_SIBLING_FLOOR) continue
    findings.push({
      severity: 'P1',
      rule: 'proportionalGatesFindings',
      title: `BATCHABLE SIBLINGS over-gated: ${siblings.length} sibling features (${siblings.join(', ')}) each ran a full G1..G8 pipeline yet all target the single file ${file} - N homogeneous units into one file demand ONE batched implementer pass + ONE verify, not ${siblings.length} per-unit gated features`,
    })
  }
  return findings
}

// findFrozenPlanArtifact (PLAN-proportional-gates): the frozen-plan artifact that proves a
// feature's spec was already frozen BEFORE the design rows in question - a /-plan-final.md/
// for the feature, OR a /-fresh-verify*.md/ whose body carries an APPROVE verdict. It must
// exist on disk AND NOT be one of the design rows' OWN cited artifacts (else it is the
// legitimate first-time freeze those rows produced). Returns the artifact name, or '' when
// none qualifies (fail-closed). ownArtifacts is the Set of artifacts cited by the rows.
function findFrozenPlanArtifact(feature, ownArtifacts, artifactExists, readArtifact) {
  const own = ownArtifacts
  const planFinal = `${feature}-plan-final.md`
  if (artifactExists(planFinal) && !own.has(planFinal)) return planFinal
  for (const candidate of frozenFreshverifyCandidates(feature, own, artifactExists)) {
    if (own.has(candidate)) continue
    const body = readArtifact(candidate)
    if (typeof body === 'string' && FRESHVERIFY_APPROVE_RE.test(body)) return candidate
  }
  return ''
}

// frozenFreshverifyCandidates: the on-disk -fresh-verify artifacts to test for an APPROVE.
// The conventional name is <feature>-fresh-verify*.md; a few real ledgers also revise to
// -fresh-verify-vN.md. We probe the bare and -v2..-v4 forms (best-effort, fail-closed: a
// name that does not exist on disk is skipped).
function frozenFreshverifyCandidates(feature, own, artifactExists) {
  const out = []
  const probes = [
    `${feature}-fresh-verify.md`, `${feature}-fresh-verify-v2.md`,
    `${feature}-fresh-verify-v3.md`, `${feature}-fresh-verify-v4.md`,
    `${feature}-freshverify.md`,
  ]
  for (const name of probes) if (artifactExists(name)) out.push(name)
  for (const name of own) if (FROZEN_FRESHVERIFY_RE.test(name) && artifactExists(name)) out.push(name)
  return out
}

// isLivenessGap (PLAN-liveness-reconcile v4): a transcript has a per-turn liveness gap
// when ANY narrating turn names a claimed id OR feature label with NO backing ground-
// truth signal - a result-bound same-turn poll of THAT id/label, a fresh on-disk
// sub-<id>.jsonl, or a LIVE (non-sealed) FRONTIER entry for it. Lean L0 EXEMPT (cannot
// poll by design). Fail-closed: absent/empty fields never fire.
function isLivenessGap(t, liveSignals) {
  if (!t) return false
  const isPureLeanConductor = t.isConductor === true && t.hasNonAgentToolUse !== true
  if (isPureLeanConductor) return false
  const turns = Array.isArray(t.livenessTurns) ? t.livenessTurns : []
  const signals = liveSignals || {
    freshTranscriptIds: new Set(), agentsMdIds: new Set(),
    frontierIds: new Set(), frontierLabels: new Set(),
  }
  for (const turn of turns) {
    for (const id of turn.claimedAgentIds) {
      const backedBySameTurnPoll = turn.polledThisTurn === true &&
        (turn.polledAgentIds.has(id) || (id === '__unnamed__' && turn.polledAgentIds.size > 0))
      const backedOnDisk = signals.freshTranscriptIds.has(id) || signals.agentsMdIds.has(id) ||
        signals.frontierIds.has(id)
      if (!backedBySameTurnPoll && !backedOnDisk) return true
    }
    for (const label of turn.claimedLabels) {
      const backedBySameTurnPoll = turn.polledThisTurn === true && turn.polledLabels.has(label)
      const backedByFrontier = signals.frontierLabels.has(label)
      if (!backedBySameTurnPoll && !backedByFrontier) return true
    }
  }
  return false
}

// livenessReconcileFindings (PLAN-liveness-reconcile / P18 - the hallucinated-running
// catch): each non-lean-L0 transcript with a per-turn liveness gap is a P0. Reads
// ctx.liveSignals. Fail-closed on empty input.
function livenessReconcileFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!isLivenessGap(t, ctx.liveSignals)) continue
    findings.push({
      severity: 'P0',
      rule: 'livenessReconcileFindings',
      title: `HALLUCINATED-RUNNING (per-turn liveness gap) in ${t.path || '(unknown transcript)'}: a turn narrated an agent as "Running / in flight / standing by" but that claimed id had NO backing live signal - no result-bound same-turn poll of it, no fresh sub-<id>.jsonl, no LIVE FRONTIER entry. Reconcile EACH turn against ACTUAL liveness per agent (poll, never assume; a poll of A never clears a claim of B; a "dead"/ConnectionRefused/stale signal never clears). COORDINATOR's job, not lean L0's (FIX-016-2)`,
    })
  }
  return findings
}

// idTokenMatch (PLAN-false-negative-liveness EDIT 3): a spawned id (the bare token a spawn description names,
// e.g. "f09") matches an ownership key (the FILENAME-derived id collectLiveSignals produces, e.g.
// "ap-planner-f09" / "sub-ap-planner-f09") when they are equal OR one is a hyphen-delimited SUFFIX of the
// other. Hyphen-boundary anchored so "f09" matches "ap-planner-f09" but NOT "f090"/"f9".
const idTokenMatch = (key, id) => key === id || key.endsWith('-' + id) || id.endsWith('-' + key)

// isFalseNegativeLivenessGap (FIX-016 MIRROR of isLivenessGap): a transcript has a false-NEGATIVE liveness
// gap when a dead-conclusion turn (a) SPAWNS an Agent onto an id/label OWNED by a live signal (fresh
// sub-<id>.jsonl, AGENTS.md row, or LIVE frontier - reconciled by idTokenMatch) AND that id/label is NOT
// task-status-confirmed-dead this turn, OR (b) concludes a SPECIFIC id/label DEAD while a disk read shows
// no-artifact-yet and NO task-status poll confirmed THAT id dead. Per-ID. BOTH arms skip taskStatusDeadIds
// (a re-spawn of a CONFIRMED-DEAD agent is a legit re-dispatch the mission requires). Lean L0 EXEMPT.
// Fail-closed: absent/empty fields never fire.
function isFalseNegativeLivenessGap(t, liveSignals) {
  if (!t) return false
  const isPureLeanConductor = t.isConductor === true && t.hasNonAgentToolUse !== true
  if (isPureLeanConductor) return false
  const turns = Array.isArray(t.deadConclusionTurns) ? t.deadConclusionTurns : []
  const signals = liveSignals || { freshTranscriptIds: new Set(), agentsMdIds: new Set(), frontierIds: new Set(), frontierLabels: new Set() }
  const ownedById = (id) => {
    for (const set of [signals.freshTranscriptIds, signals.agentsMdIds, signals.frontierIds]) {
      if (!set) continue
      if (set.has(id)) return true
      for (const k of set) if (idTokenMatch(k, id)) return true
    }
    return false
  }
  const ownedByLabel = (label) => {
    if (!signals.frontierLabels) return false
    if (signals.frontierLabels.has(label)) return true
    for (const k of signals.frontierLabels) if (idTokenMatch(k, label)) return true
    return false
  }
  const inSet = (set, id) => { if (set.has(id)) return true; for (const k of set) if (idTokenMatch(k, id)) return true; return false }
  for (const turn of turns) {
    // arm (a): a SPAWN onto an OWNED id/label = duplicate onto live-owned work, UNLESS task-status-confirmed dead.
    for (const id of turn.spawnedIdsThisTurn) {
      if (inSet(turn.taskStatusDeadIds, id)) continue
      if (ownedById(id)) return true
    }
    for (const label of turn.spawnedLabelsThisTurn) {
      if (inSet(turn.taskStatusDeadLabels, label)) continue
      if (ownedByLabel(label)) return true
    }
    // arm (b): per dead-concluded id, the conclusion is LEGIT only if a task-status poll confirmed THAT id dead.
    for (const id of turn.deadConcludedIds) {
      if (inSet(turn.taskStatusDeadIds, id)) continue
      if (turn.diskReadThisTurn === true) return true
      if (inSet(turn.taskStatusRunningIds, id)) return true
    }
    for (const label of turn.deadConcludedLabels) {
      if (inSet(turn.taskStatusDeadLabels, label)) continue
      if (turn.diskReadThisTurn === true) return true
      if (inSet(turn.taskStatusRunningLabels, label)) return true
    }
  }
  return false
}

// falseNegativeLivenessFindings (PLAN-false-negative-liveness EDIT 4 - the MIRROR of
// livenessReconcileFindings): each non-lean-L0 transcript with a false-negative liveness gap is a P0. Reads
// ctx.liveSignals. Fail-closed on empty input.
function falseNegativeLivenessFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!isFalseNegativeLivenessGap(t, ctx.liveSignals)) continue
    findings.push({
      severity: 'P0',
      rule: 'falseNegativeLivenessFindings',
      title: `DECLARED-DEAD / DUPLICATE-SPAWN (false-negative liveness gap) in ${t.path || '(unknown transcript)'}: a turn concluded a spawned agent DEAD/absent from a DISK-ONLY read (no artifact yet) WITHOUT a task-status poll confirming death, and/or SPAWNED a DUPLICATE onto an id a live agent already OWNED (fresh sub-<id>.jsonl / AGENTS.md / LIVE frontier / running task-status). 'no artifact yet' is AMBIGUOUS - a slow-but-alive agent looks identical to a dead one on disk; check TASK-STATUS before concluding dead (running-no-artifact-yet = ALIVE, never re-spawn). The MIRROR of livenessReconcileFindings (FIX-016)`,
    })
  }
  return findings
}

// serialGateFindings (PLAN-time-optimization - P1, EXTENDING the waveBarrier/leanIdle family): a BILLIONAIRE
// feature-manager that dispatched a STATICALLY-INDEPENDENT gate pair ({G2,G3} or {G5,G6} for the same feature)
// in TWO different turns rather than ONE batched turn. The pair independence is STATIC (always true by gate
// contract), so the only question is batched-vs-serialized - answered by the per-turn gateSpawnTurns data,
// identical in kind to wave-barrier, NOT a flat count. Fail-closed: non-billionaire, non-manager, or
// unclassifiable gate labels never fire. A pair seen in ONE turn (batched, the win state) never fires.
function serialGateFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  const severity = ctx.serializationEnforcement === true ? 'P0' : 'P1'
  for (const t of transcripts) {
    if (!t || t.mode !== 'billionaire' || t.persona !== 'ap-manager') continue
    const turns = Array.isArray(t.gateSpawnTurns) ? t.gateSpawnTurns : []
    if (turns.length === 0) continue
    for (const [a, b] of INDEPENDENT_GATE_PAIRS) {
      const batchedTogether = turns.some(turn => turn.gateLabels.has(a) && turn.gateLabels.has(b))
      if (batchedTogether) continue
      const turnA = turns.find(turn => turn.gateLabels.has(a))
      const turnB = turns.find(turn => turn.gateLabels.has(b))
      if (turnA && turnB && turnA.index !== turnB.index) {
        findings.push({
          severity,
          rule: 'serialGateFindings',
          title: `GATE-CHAIN-SERIALIZATION in ${t.path || '(unknown transcript)'}: a BILLIONAIRE feature-manager dispatched the INDEPENDENT gate pair {${a}, ${b}} in two separate turns (serial) instead of one batched turn - ${a} and ${b} are independent by gate contract and run CONCURRENTLY by default in BILLIONAIRE (the within-feature gate-DAG); batch the pair, never serialize it`,
        })
      }
    }
  }
  return findings
}

// serialFeatureFindings (PLAN-autoprompt-enforcement - P1, EXTENDING the serialGate/leanIdle family):
// a BILLIONAIRE ap-feature-coordinator that dispatched a cohort of DECLARED-DISJOINT same-phase features
// SERIALLY / never wider than the floor. The COHORT is built ONLY from the mandatory DECOMPOSE rows;
// features with a dep edge, shared file ownership, a different phase, or no DECOMPOSE row are EXCLUDED.
// The FIRING WIDTH is grouped by wave from the mandatory DISPATCH rows ALONE - the guaranteed signal,
// NOT prose descriptions (which a mission-first run leaves FID-less). Fires once per cohort per
// transcript when a cohort >= SERIAL_FEATURE_FLOOR existed yet max wave width < the floor.
function serialFeatureFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  const decomp = Array.isArray(ctx.featureDecomposition) ? ctx.featureDecomposition : []
  if (decomp.length === 0) return findings                       // defensive fail-closed: no DECOMPOSE rows
  const dispatches = Array.isArray(ctx.featureDispatches) ? ctx.featureDispatches : []
  const severity = ctx.serializationEnforcement === true ? 'P0' : 'P1'
  for (const t of transcripts) {
    if (!t || t.mode !== 'billionaire' || !isFeatureL1(t.persona)) continue
    const byPhase = new Map()
    for (const f of decomp) {
      if (!byPhase.has(f.phase)) byPhase.set(f.phase, [])
      byPhase.get(f.phase).push(f)
    }
    for (const [, members] of byPhase) {
      const cohort = members.filter(f => members.every(g =>
        g.feature === f.feature ||
        (!f.deps.has(g.feature) && !g.deps.has(f.feature) && disjointOwns(f.owns, g.owns))))
      const ids = new Set(cohort.map(f => f.feature))
      if (ids.size < SERIAL_FEATURE_FLOOR) continue              // proportionality floor
      const byWave = new Map()
      const dispatched = new Set()
      for (const d of dispatches) {
        if (!ids.has(d.feature)) continue
        dispatched.add(d.feature)
        if (!byWave.has(d.wave)) byWave.set(d.wave, new Set())
        byWave.get(d.wave).add(d.feature)
      }
      if (dispatched.size < SERIAL_FEATURE_FLOOR) continue       // judge only a cohort actually dispatched
      let maxWidth = 0
      for (const [, w] of byWave) if (w.size > maxWidth) maxWidth = w.size
      if (maxWidth < SERIAL_FEATURE_FLOOR) {
        findings.push({
          severity,
          rule: 'serialFeatureFindings',
          title: `SERIAL-FEATURE in ${t.path || '(unknown transcript)'}: a BILLIONAIRE feature-supervisor dispatched ${dispatched.size} declared-disjoint same-phase features at max concurrent wave width ${maxWidth} (< ${SERIAL_FEATURE_FLOOR}) - independent features MUST be dispatched in ONE wide PUSH-WORK wave, not one-after-another like TOKENSAVER`,
        })
      }
    }
  }
  return findings
}

// serialDispatchFindings (P-22 non-blocking dispatch - P1, the mode-AGNOSTIC mirror of
// serialFeatureFindings). serialFeatureFindings owns ONLY the BILLIONAIRE floor-6 case;
// the OTHER parallel modes (wide / custom / tokensaver) had the never-serialize invariant
// UNENFORCED - yet the harness fans out in every one of them (all EXECUTION_MODES set
// parallelFeatures:true). This rule closes that gap: a parallel-mode feature-coordinator
// that dispatched a DECLARED-DISJOINT same-phase cohort of >= SERIAL_DISPATCH_FLOOR features
// STRICTLY one at a time (every DISPATCH wave width 1 - pure spawn-wait-spawn) is the F-5
// "firing N then fired 1" defect. Cohort independence is DECLARED via DECOMPOSE rows (the
// same disjointness test serialFeatureFindings uses - SOUND, no static-independence guess);
// the width is grouped from DISPATCH rows ALONE. Scoped to NON-billionaire (billionaire is
// owned above) so the two rules never double-fire. Fail-closed: billionaire, non-coordinator,
// no DECOMPOSE rows, a cohort < floor, or ANY wave wider than 1 -> no finding.
const SERIAL_DISPATCH_FLOOR = 2
const PARALLEL_NONBILLIONAIRE_MODES = new Set(['wide', 'custom', 'tokensaver'])
function serialDispatchFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  const decomp = Array.isArray(ctx.featureDecomposition) ? ctx.featureDecomposition : []
  if (decomp.length === 0) return findings                       // defensive fail-closed: no DECOMPOSE rows
  const dispatches = Array.isArray(ctx.featureDispatches) ? ctx.featureDispatches : []
  for (const t of transcripts) {
    if (!t || !PARALLEL_NONBILLIONAIRE_MODES.has(t.mode) || !isFeatureL1(t.persona)) continue
    const byPhase = new Map()
    for (const f of decomp) {
      if (!byPhase.has(f.phase)) byPhase.set(f.phase, [])
      byPhase.get(f.phase).push(f)
    }
    for (const [, members] of byPhase) {
      const cohort = members.filter(f => members.every(g =>
        g.feature === f.feature ||
        (!f.deps.has(g.feature) && !g.deps.has(f.feature) && disjointOwns(f.owns, g.owns))))
      const ids = new Set(cohort.map(f => f.feature))
      if (ids.size < SERIAL_DISPATCH_FLOOR) continue             // proportionality floor
      const byWave = new Map()
      const dispatched = new Set()
      for (const d of dispatches) {
        if (!ids.has(d.feature)) continue
        dispatched.add(d.feature)
        if (!byWave.has(d.wave)) byWave.set(d.wave, new Set())
        byWave.get(d.wave).add(d.feature)
      }
      if (dispatched.size < SERIAL_DISPATCH_FLOOR) continue      // judge only a cohort actually dispatched
      let maxWidth = 0
      for (const [, w] of byWave) if (w.size > maxWidth) maxWidth = w.size
      if (maxWidth === 1) {                                      // STRICTLY serial: every wave a single feature
        findings.push({
          severity: 'P1', rule: 'serialDispatchFindings',
          title: `SERIAL-DISPATCH in ${t.path || '(unknown transcript)'}: a ${String(t.mode).toUpperCase()} feature-coordinator dispatched ${dispatched.size} declared-disjoint same-phase features STRICTLY one at a time (every wave width 1 - spawn-wait-spawn) though ${String(t.mode).toUpperCase()} fans out concurrently - independent ready work must be spawn-all-then-collect, never serialized (P-22 / F-5 "firing N then fired 1")`,
        })
      }
    }
  }
  return findings
}

// === P-28 SPAWN-SPLIT (spawn-format hygiene) =================================
// base:67: "you format it weirdly and the prompt ends up splitting into 2" - one part
// sends, the tail is queued and lost. gate.js assertSingleBlock is the PRE-dispatch throw
// (control split markers at brief assembly); spawnSplitFindings is the POST-HOC P1 teeth
// over the brief that actually REACHED a spawned subagent (firstUserTurnText on disk) -
// the same deliberate-duplication pattern as GATE_EXPECTED_PERSONA. Three unambiguous
// split signatures: a control split marker, a truncation/continuation sentinel, or a
// DOUBLE ORIGINAL-MISSION block (two briefs concatenated = split-then-both-sent).
const SPAWN_SPLIT_MARKERS = [0x0000, 0x2028, 0x2029].map(c => String.fromCharCode(c))       // NUL / line-separator / paragraph-separator
const TRUNCATION_SENTINEL_RE = /\[(?:truncated|continued|cont'd|message split|brief split|prompt split)\]|<<<\s*split\s*>>>/i
// briefSplitReasons(text, missionLabel): the reasons a received brief shows a split /
// double-block. PURE, total; '' / non-string -> [] (fail-closed, never false-flags).
function briefSplitReasons(text, missionLabel) {
  const reasons = []
  const s = typeof text === 'string' ? text : ''
  if (s === '') return reasons
  if (SPAWN_SPLIT_MARKERS.some(m => s.indexOf(m) !== -1)) {
    reasons.push('carries a control split marker (NUL/LS/PS) - it split in transit (one part sent, the tail queued)')
  }
  if (TRUNCATION_SENTINEL_RE.test(s)) {
    reasons.push('carries a truncation/continuation sentinel - the brief was cut and the remainder queued as a second block')
  }
  if (typeof missionLabel === 'string' && missionLabel !== '') {
    let idx = s.indexOf(missionLabel)
    let count = 0
    while (idx !== -1) { count++; idx = s.indexOf(missionLabel, idx + missionLabel.length) }
    if (count >= 2) reasons.push(`carries ${count} ORIGINAL MISSION blocks - a double-block: two briefs concatenated (the split-then-both-sent signature)`)
  }
  return reasons
}
// spawnSplitFindings (P-28 teeth, P1): each spawned transcript whose received brief shows a
// split signature. Fail-closed: ctx null, no transcripts, or an empty firstUserTurnText ->
// []. The conductor ROOT's first user turn is the RAW human prompt (no mission label / no
// markers) and never trips.
function spawnSplitFindings(ctx) {
  const findings = []
  if (ctx == null) return findings
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || typeof t !== 'object') continue
    const brief = typeof t.firstUserTurnText === 'string' ? t.firstUserTurnText : ''
    if (brief === '') continue
    const reasons = briefSplitReasons(brief, MISSION_BLOCK_LABEL)
    if (reasons.length) {
      findings.push({
        severity: 'P1', rule: 'spawnSplitFindings',
        title: `SPLIT SPAWN BRIEF in ${t.path || '(unknown transcript)'}: the brief that reached this spawn ${reasons.join('; ')} - a spawned brief must be ONE clean block (base:67). Emit the whole brief in a single block; never let it split into a sent part + a queued part.`,
      })
    }
  }
  return findings
}

// === P-27 DEPLOYED==SOURCE VERIFY ===========================================
// F-11: subagents ran an OLD installed skill for a whole session; a deployed profile was
// 397 lines stale, and NOTHING verified installed==built. verifyDeployedMatchesSource hashes
// the KEY skill files in the installed dir and the source tree and reports every file whose
// deployed bytes DIFFER (or is missing on either side). The ship ritual calls the
// `--verify-deployed` CLI and refuses to ship on a MISMATCH. Standalone from runLedgerCheck.
const DEPLOY_KEY_TOPLEVEL = ['SKILL.md', 'GATES.md']
const DEPLOY_KEY_DIR_GLOBS = [
  { dir: 'agents', ext: '.md' },
  { dir: 'frameworks', ext: '.md' },
  { dir: 'workflow', ext: '.js' },
]
// A workflow/*.js file that is test/coverage scaffolding, NOT shipped runtime - excluded so
// a source tree carrying test seams the deploy legitimately drops never reads as a mismatch.
const NON_RUNTIME_JS_RE = /\.(?:test|slice)\.[cm]?js$|-coverage\.[cm]?js$|(?:^|[\/\\])cov-fill|(?:^|[\/\\])smoke-test\.js$/i
// Normalize CRLF->LF before hashing so a checkout line-ending flip is not a false mismatch.
function normalizeForHash(text) { return String(text).replace(/\r\n/g, '\n') }
function hashContent(text) { return crypto.createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex') }
// listDeployKeyFiles(rootDir, io): sorted relative key-file paths under rootDir. io.readdir
// is injectable for hermetic tests; the default swallows a missing dir (fail-soft -> []).
function listDeployKeyFiles(rootDir, io) {
  const readdir = io && typeof io.readdir === 'function'
    ? io.readdir
    : (d => { try { return fs.readdirSync(d) } catch (e) { return [] } })
  const rels = [...DEPLOY_KEY_TOPLEVEL]
  for (const g of DEPLOY_KEY_DIR_GLOBS) {
    const entries = readdir(path.join(rootDir, g.dir)) || []
    for (const e of [...entries].sort()) {
      if (typeof e !== 'string' || !e.endsWith(g.ext)) continue
      if (g.dir === 'workflow' && NON_RUNTIME_JS_RE.test(e)) continue
      rels.push(`${g.dir}/${e}`)
    }
  }
  return rels
}
// verifyDeployedMatchesSource({installedDir, sourceDir, io}): compares the UNION of key files
// across both trees. Returns { ok, checked, mismatched, missingInDeployed, missingInSource }.
// identical bytes pass; differing bytes -> mismatched; present in source but absent/unreadable
// in the deploy -> missingInDeployed (the stale-deploy case F-11 describes). io.readFile is
// injectable ((dir, rel) -> string|null) for hermetic tests; the default reads real fs.
function verifyDeployedMatchesSource(o) {
  const { installedDir, sourceDir } = o
  const io = o.io || null
  const readFile = io && typeof io.readFile === 'function'
    ? io.readFile
    : ((d, rel) => { try { return fs.readFileSync(path.join(d, rel), 'utf8') } catch (e) { return null } })
  const srcRels = listDeployKeyFiles(sourceDir, io)
  const depRels = listDeployKeyFiles(installedDir, io)
  const all = [...new Set([...srcRels, ...depRels])].sort()
  const mismatched = []
  const missingInDeployed = []
  const missingInSource = []
  for (const rel of all) {
    const srcBody = readFile(sourceDir, rel)
    const depBody = readFile(installedDir, rel)
    if (srcBody == null && depBody == null) continue
    if (srcBody == null) { missingInSource.push(rel); continue }
    if (depBody == null) { missingInDeployed.push(rel); continue }
    if (hashContent(srcBody) !== hashContent(depBody)) mismatched.push(rel)
  }
  const ok = mismatched.length === 0 && missingInDeployed.length === 0 && missingInSource.length === 0
  return { ok, checked: all.length, mismatched, missingInDeployed, missingInSource }
}

// disjointOwns: two features' file-ownership sets share no path. Pure, total.
function disjointOwns(a, b) {
  for (const p of a) if (b.has(p)) return false
  return true
}

// splittableConcreteParts (worker-starvation): the count of DISTINCT, CONCRETE (non-glob)
// owned paths in a feature's DECOMPOSE owns set. >=2 concrete paths = >=2 separable parts the
// L2 manager MUST fan to sibling L3 workers. A glob is ambiguous and NOT counted - fail-closed:
// a one-file or single-glob feature returns < 2 and never trips the rule. Pure, total.
function splittableConcreteParts(owns) {
  if (!(owns instanceof Set)) return 0
  let n = 0
  for (const p of owns) if (typeof p === 'string' && p !== '' && !p.includes('*')) n++
  return n
}

// managerWorkerStarvationFindings (steer-4b HIERARCHY-CORRECTNESS - the (ii) teeth, the missing
// half; (i) skip-the-supervisor is owned by conductorSpawnAllowlistFindings + l1ChildrenFindings,
// never duplicated here): a BILLIONAIRE L2 ap-manager that dispatched EXACTLY ONE L3 worker for a
// feature whose mandatory DECOMPOSE owns set holds >=2 DISTINCT CONCRETE paths - worker-starvation
// (steer 4: "managers had only ONE worker each"). NO concurrency floor (steer 5): the fire keys on
// exactly-one-worker over demonstrably-splittable work, NOT on "fewer than N". Splittability is the
// decompose-time owns meta (the guaranteed signal); worker count reuses the existing spawnedTypes (no
// scanner change). Severity escalates P1->P0 under serializationEnforcement, identical to the serial
// family. Fail-closed: non-billionaire / non-manager / no feature join / owns<2 concrete / workerCount!==1 -> [].
function managerWorkerStarvationFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  const decomp = Array.isArray(ctx.featureDecomposition) ? ctx.featureDecomposition : []
  if (decomp.length === 0) return findings                     // fail-closed: no DECOMPOSE meta
  const byFeature = new Map(decomp.map(f => [f.feature, f]))   // f.feature is UPPER-CASED by deriveFeatureDecomposition
  const severity = ctx.serializationEnforcement === true ? 'P0' : 'P1'
  for (const t of transcripts) {
    if (!t || t.mode !== 'billionaire' || t.persona !== 'ap-manager') continue
    const fid = typeof t.feature === 'string' ? t.feature.toUpperCase() : ''
    const row = fid ? byFeature.get(fid) : undefined
    if (!row) continue                                         // no join -> cannot prove splittable
    const parts = splittableConcreteParts(row.owns)
    if (parts < 2) continue                                    // atomic/one-file/glob -> never fires (NO floor)
    const children = Array.isArray(t.spawnedTypes) ? t.spawnedTypes : []
    const workerCount = children.filter(c => L3_EXECUTORS.has(c)).length
    if (workerCount !== 1) continue                            // exactly-one-worker is the steer-4 shape
    findings.push({
      severity,
      rule: 'managerWorkerStarvationFindings',
      title: `WORKER-STARVATION in ${t.path || '(unknown transcript)'}: a BILLIONAIRE L2 ap-manager for ${fid} dispatched exactly ONE L3 worker on demonstrably-splittable work (its DECOMPOSE owns ${parts} disjoint concrete parts) - independent parts MUST run as sibling L3 workers in parallel (the L2->L3 split site), not one worker serially (steer 4 "managers had only ONE worker each"). This is NOT a concurrency floor: a one-file/atomic feature with one worker is correct and never trips this rule.`,
    })
  }
  return findings
}

// supervisorWaveCountFindings (PLAN-supervisor-collapse - P1): an L0 conductor that spawned
// >= SUPERVISOR_WAVE_FLOOR ap-feature-coordinator instances in ONE wave (the supervisor-per-feature
// signature: there is EXACTLY ONE feature-coordinator per run; features are MANAGER-level concerns).
// Keys on maxFeatureSupervisorWave (the widest single-turn feature-coordinator count) - NOT a flat
// total, so sequential convergence re-spawns (one per turn) never trip it. Fail-closed: non-conductor,
// absent/non-numeric/zero wave -> []. Orthogonal to waveBarrier: fires whether or not the wave folded.
function supervisorWaveCountFindings(ctx) {
  const findings = []
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : []
  for (const t of transcripts) {
    if (!t || t.isConductor !== true) continue
    const wave = Number(t.maxFeatureSupervisorWave)
    if (!Number.isFinite(wave) || wave < SUPERVISOR_WAVE_FLOOR) continue
    findings.push({
      severity: 'P1',
      rule: 'supervisorWaveCountFindings',
      title: `SUPERVISOR-PER-FEATURE in ${t.path || '(unknown transcript)'}: the L0 conductor spawned ${wave} ap-feature-coordinator instances in ONE wave, but there is EXACTLY ONE feature-coordinator per run - features are MANAGER-level concerns (ONE L2 ap-manager per feature under the single coordinator). Collapse the ${wave} coordinators to ONE feature-coordinator fanning ${wave} managers (SKILL.md dispatch-contract step 4).`,
    })
  }
  return findings
}

// compactThresholdFindings (PLAN-auto-compact-threshold - P1, LIGHT): a run whose RECORDED PEAK
// context watermark exceeded the proactive threshold while the supervisor was attached, yet NO
// compaction occurred - it missed its proactive compaction and rode toward the harness ceiling.
// ctx.compactState = { peakWatermark, threshold, compactionOccurred, supervisorAttached }. Fail-closed:
// absent/malformed compactState, non-numeric peak/threshold, compactionOccurred===true, or
// supervisorAttached!==true -> [].
function compactThresholdFindings(ctx) {
  const findings = []
  const c = ctx && ctx.compactState
  if (!c || c.supervisorAttached !== true || c.compactionOccurred === true) return findings
  const peak = Number(c.peakWatermark)
  const thr = Number(c.threshold)
  if (!Number.isFinite(peak) || !Number.isFinite(thr) || thr <= 0) return findings
  if (peak >= thr) {
    findings.push({
      severity: 'P1',
      rule: 'compactThresholdFindings',
      title: `proactive compaction missed: peak context watermark ${peak} reached/exceeded AUTOPROMPT_COMPACT_AT ${thr} while the supervisor was attached, but no compaction occurred - the run rode toward the harness ceiling instead of compacting proactively`,
    })
  }
  return findings
}
// F-FRAMEWORK SMASH-1 - frameworkFallthroughFindings: a structural regression guard on
// the skill's OWN on-disk routing spec (NOT a phantom GATELOG row). P-26: the prose
// decision tree in agents/claude/frameworks/README.md is the SINGLE routing source of truth
// (the competing framework-selector.js was deleted), so this rule no longer keys on the
// selector module's existence - only on the spec itself:
//   - README still carries the silent `return backend-implement` global fallback -> P0
//     (the exact regression the mission forbids - an unmatched task degrades instead of
//     routing to GENERATE - INV-13 "never silent fallthrough").
//   - README no longer names the routing authority (the framework-selector token or the
//     prose GENERATE route) -> P1 (spec-drift guard, non-blocking).
// FAIL-CLOSED: README unreadable (null) -> emit nothing. A non-skill target repo, or a
// path the run does not contain, is NEVER false-FAILed. The rule fires ONLY on genuine,
// present, regressed evidence.
const FRAMEWORK_README_REL = 'agents/omp/frameworks/README.md'
const SILENT_FALLBACK_RE = /GLOBAL FALLBACK[^\n]*return\s+backend-implement/i
const SELECTOR_AUTHORITY_RE = /framework-selector(\.js)?|GENERATE/
function frameworkFallthroughFindings(ctx) {
  const findings = []
  const readRepoFile = ctx && typeof ctx.readRepoFile === 'function' ? ctx.readRepoFile : null
  if (!readRepoFile) return findings
  const readme = readRepoFile(FRAMEWORK_README_REL)
  if (readme == null) return findings // fail-closed: non-skill repo, never false-FAIL
  if (SILENT_FALLBACK_RE.test(readme)) {
    findings.push({
      severity: 'P0',
      rule: 'frameworkFallthroughFindings',
      title: 'silent backend-implement fallthrough still present in framework selector spec - an unmatched task degrades instead of routing to GENERATE',
    })
  }
  if (!SELECTOR_AUTHORITY_RE.test(readme)) {
    findings.push({
      severity: 'P1',
      rule: 'frameworkFallthroughFindings',
      title: 'README §3 no longer names the routing authority (the GENERATE route / selector) - prose<->spec drift',
    })
  }
  return findings
}

// depthLockFindings (F-DEPTH - P0, the DEPTH-LOCK mechanical teeth): a `debug`
// feature must not ship a wrong-LAYER / symptom fix whose self-written repro went
// green. The independently-derived deepest cause (ap-depth-prober's D3) must EQUAL
// the frozen fix-layer AND the D4 adversarial repro must be proven RED unpatched.
//
// AUTHORITATIVE CLASSIFICATION (G5/G6 fix): "is this a debug feature" is NO LONGER
// keyed on a self-applied inline `tag=debug` token an author can omit. It keys on
// the RECORDED FEATURE-META `tag=debug` derived from the roadmap on new runs or
// assigned by INTAKE on legacy resumes - a debug feature cannot hide by dropping a flag.
// The legacy inline `tag=debug` on a GATELOG row is still honored (back-compat), but
// the FEATURE-META metadata is the un-omittable source.
//
// Three P0 arms, fail-closed everywhere (a non-debug or legacy/unannotated run is
// never false-FAILed - the discipline proportionalGatesFindings uses):
//   ARM A - a debug feature that REACHED the fix (a G4 IMPLEMENT row OR a G6 VERIFY
//           row OR a GOAL-CHECK DONE seal) with NO <feature>-depth-lock.md on disk.
//           This fires REGARDLESS of session/resume: a debug feature cannot seal
//           DONE with DEPTH-LOCK skipped, even on a resume path (DEP-5 clause 1).
//   ARM B - the frozen fix-layer (the `fixlayer=` token a LIVE depthLock row emits)
//           != the D3 deepest-cause parsed from the depth-lock artifact (DEP-5 cl.2).
//   ARM C - the depth-lock artifact lacks a captured-RED marker for D4 (DEP-4).
function depthLockFindings(ctx) {
  const findings = []
  const gatelog = Array.isArray(ctx.gatelog) ? ctx.gatelog : []
  const featureMeta = Array.isArray(ctx.featureMeta) ? ctx.featureMeta : []
  const goalChecks = Array.isArray(ctx.goalChecks) ? ctx.goalChecks : []
  const artifactExists = typeof ctx.artifactExists === 'function' ? ctx.artifactExists : () => false
  const readArtifact = typeof ctx.readArtifact === 'function' ? ctx.readArtifact : () => null

  // AUTHORITATIVE debug set: the recorded FEATURE-META tag (un-omittable, decompose-time)
  // is the primary source; a legacy inline GATELOG `tag=debug` is still honored.
  const isDebugByFeature = new Map()
  for (const m of featureMeta) {
    if (m && m.feature && m.tag === 'debug') isDebugByFeature.set(m.feature.toUpperCase(), true)
  }
  const gatesByFeature = new Map()
  const fixlayerByFeature = new Map()
  for (const r of gatelog) {
    if (!r || !r.feature || !r.gate) continue
    const fid = r.feature.toUpperCase()
    if (!gatesByFeature.has(fid)) gatesByFeature.set(fid, new Set())
    gatesByFeature.get(fid).add(r.gate)
    if (r.tag === 'debug') isDebugByFeature.set(fid, true)
    if (r.fixlayer && !fixlayerByFeature.has(fid)) fixlayerByFeature.set(fid, r.fixlayer)
  }
  // DONE seals (resume-proof teeth): a feature sealed DONE without a depth-lock
  // artifact must fire ARM A even when its build was sealed on a resume path that
  // never re-recorded a G4/G6 row this session.
  const doneFeatures = new Set()
  for (const g of goalChecks) if (g && g.feature) doneFeatures.add(String(g.feature).toUpperCase())

  // every feature that is debug AND reached the fix is a candidate (NOT only those
  // with a gate row - a DONE seal alone is enough to require the artifact).
  const candidates = new Set([...isDebugByFeature.keys()].filter(f => isDebugByFeature.get(f) === true))
  for (const feature of candidates) {
    const gates = gatesByFeature.get(feature) || new Set()
    const reachedFix = gates.has('G4') || gates.has('G6') || doneFeatures.has(feature)
    if (!reachedFix) continue                              // a debug feature still in PLAN has nothing to lock yet
    const artifactName = `${feature}-depth-lock.md`
    // ARM A - missing prober artifact (resume-proof: keyed on the authoritative tag).
    if (!artifactExists(artifactName)) {
      findings.push({
        severity: 'P0', rule: 'depthLockFindings',
        title: `depth-lock missing (${feature}): a debug feature reached the fix (G4/G6/DONE) with NO ${artifactName} on disk - every debug fix must pass an independent G3.5 DEPTH-LOCK (ap-depth-prober) that derives the deepest cause from the issue text BEFORE the fix is built; DEPTH-LOCK cannot be skipped on any session/resume path`,
      })
      continue
    }
    const body = readArtifact(artifactName)
    if (typeof body !== 'string') continue                 // unreadable -> fail-closed (ARM B/C need the body)
    const d3Match = DEPTHLOCK_D3_RE.exec(body)
    const fixlayer = fixlayerByFeature.get(feature) || ''
    // ARM B - layer mismatch (only when BOTH discriminators are present; else fail-closed).
    if (d3Match && fixlayer) {
      const d3 = d3Match[1]
      if (normalizeLayer(fixlayer) !== normalizeLayer(d3)) {
        findings.push({
          severity: 'P0', rule: 'depthLockFindings',
          title: `depth-miss (${feature}): frozen fix-layer ${fixlayer} != independently-derived deepest-cause ${d3} - a wrong-LAYER / symptom fix (right neighborhood, wrong function) cannot ship; the fix must land at the function that DECIDES the behavior, not a downstream guard`,
        })
        continue
      }
    }
    // ARM C - D4 repro not proven RED unpatched.
    if (!DEPTHLOCK_D4_RED_RE.test(body)) {
      findings.push({
        severity: 'P0', rule: 'depthLockFindings',
        title: `depth-miss (${feature}): the D4 adversarial issue-derived repro in ${artifactName} is not proven RED against unpatched code - a depth-lock without a captured-red baseline cannot prove the chosen layer fixes the real failure`,
      })
    }
  }
  return findings
}

// normalizeLayer (F-DEPTH): a file.py::function token compared case-sensitively but
// tolerant of a leading "./" and surrounding whitespace, so an equal layer in two
// spellings reconciles while a genuinely different function still differs. Callers
// guard both operands non-empty before comparing, so the input is always a string.
function normalizeLayer(layer) {
  return String(layer).trim().replace(/^\.\//, '')
}

// FIX-06's F5-18 rule, plus the five FX-HIERARCHY linters (FIX-10/11/13/14/17).
// FX-HIERARCHY appended its rules here with no change to parsing or the CLI.
const RULE_REGISTRY = [
  reconcileProvenance,
  roadmapClosureFindings,
  mixedLedgerFormatFindings,
  selfReviewSignatureFindings,
  managerExecFindings,
  conductorToolUseFindings,
  l1ChildrenFindings,
  goalCheckJanitorFindings,
  preflightEditFindings,
  selfBlockYieldFindings,
  anchorIntegrityFindings,
  waveBarrierFindings,
  commitCheckpointFindings,
  thinSprawlFindings,
  conductorSpawnAllowlistFindings,
  leanIdleFindings,
  artifactSubstanceFindings,
  parentFleetSynthesisFindings,
  midRunCancelCheckpointFindings,
  livenessReconcileFindings,
  proportionalGatesFindings,
  idleFinishFindings,
  falseNegativeLivenessFindings,
  serialGateFindings,
  serialFeatureFindings,
  serialDispatchFindings,
  spawnSplitFindings,
  managerWorkerStarvationFindings,
  supervisorWaveCountFindings,
  compactThresholdFindings,
  frameworkFallthroughFindings,
  tierProportionalityFindings,
  evidencePackFindings,
  frameworkTierFindings,
  depthLockFindings,
  missionFidelityFindings,
  missionSourceOfTruthFindings,
  selfWrittenCaptureFindings,
  openFlawFindings,
  startupHandshakeFindings,
]

// runLedgerCheck: read the ledger + transcripts with real fs, build ctx, run
// every registered rule, and decide ok (no P0 finding). The transcript-keyed
// hierarchy rules (managerExec/conductorToolUse/l1Children/goalCheckJanitor/
// preflightEdit) ALWAYS run when a transcript dir holds transcripts, EVEN with
// no GATELOG/AGENTS present - the mission's 0%-input self-test feeds a
// transcript-only dir and a breach there MUST be caught (no fail-open). The
// FIX-05 reconcileProvenance rule stays permissive-on-absence: with no GATELOG
// it sees an empty gatelog and produces nothing, exactly as before. Only a
// TRULY empty run (no ledger files AND no transcripts) takes the clean-by-
// absence INFO path, so a non-benchmark interactive run is never false-FAILed.
function parseJsonObject(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function resolveLaunchBinding(options) {
  if (options && options.launchBinding && typeof options.launchBinding === 'object') {
    return options.launchBinding
  }
  const environment = options && options.environment && typeof options.environment === 'object'
    ? options.environment
    : process.env
  const casting = parseJsonObject(environment.AUTOPROMPT_AGENT_CASTING)
  if (casting) return casting
  const attestation = parseJsonObject(environment.AUTOPROMPT_CAPABILITY_ATTESTATION)
  if (!attestation || typeof attestation.effortStatus !== 'string') return null
  return {
    enabled: false,
    aliases: {},
    effort: { status: attestation.effortStatus, maximum: null },
  }
}

function runLedgerCheck(opts) {
  const options = opts || {}
  const ledgerDir = options.ledgerDir
  const artifactDir = options.artifactDir
  const transcriptDir = options.transcriptDir
  const promptsPath = options.promptsPath || (ledgerDir ? path.join(ledgerDir, 'PROMPTS.txt') : '')
  const info = []

  const gatelogText = readIfExists(ledgerDir, 'GATELOG.md')
  const agentsText = readIfExists(ledgerDir, 'AGENTS.md')
  const roadmapText = readIfExists(ledgerDir, 'ROADMAP.md')
  const promptsText = readIfExists(ledgerDir, 'PROMPTS.txt')
  const transcripts = scanTranscriptDir(transcriptDir)
  // New-format detection no longer requires AGENTS.md to be ABSENT: a stale
  // legacy file must not silently disable root roadmap closure or reroute
  // provenance through the legacy spawn table. Coexisting parseable AGENTS.md
  // spawn rows are a CONTRADICTION owned by mixedLedgerFormatFindings (P0);
  // an empty/heading-only leftover is harmless residue and closure proceeds.
  const compactLedger = gatelogText != null && roadmapText != null && promptsText != null
  const hasLedger = gatelogText != null || agentsText != null || roadmapText != null || promptsText != null
  const roadmapItems = parseRoadmapItems(roadmapText || '')
  const launchBinding = resolveLaunchBinding(options)

  if (!hasLedger && transcripts.length === 0) {
    info.push('no GATELOG.md/AGENTS.md found - nothing to reconcile (clean by absence)')
    return { ok: true, findings: [], info }
  }

  const gatelog = parseLedgerLines(gatelogText || '', 'gatelog')
  const agents = parseLedgerLines(agentsText || '', 'agents')
  const artifactExists = (name) => {
    if (!artifactDir || !name) return false
    try { return fs.existsSync(path.join(artifactDir, name)) } catch (e) { return false }
  }
  const readArtifact = (name) => {
    try { return fs.readFileSync(path.join(artifactDir, name), 'utf8') } catch (e) { return null }
  }
  // F-FRAMEWORK SMASH-1: read the skill's OWN repo files via a derivable root. Default root
  // is three levels above this module (agents/claude/workflow -> repo root); options.repoRoot
  // overrides it (the tests inject a tmp root). Fail-closed: any read error -> null.
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..', '..')
  const readRepoFile = (rel) => {
    try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8') } catch (e) { return null }
  }

  // SPEC-2 / no-idle: stamp the run mode (from BRIEF.md) onto every transcript so the
  // mode-scoped rules (wave-barrier, lean-idle) stay per-transcript and unit-testable.
  const briefText = readIfExists(ledgerDir, 'BRIEF.md')
  const mode = parseModeFromBrief(briefText || '')
  for (const t of transcripts) t.mode = mode
  // PLAN-startup-handshake: ATTENDED is the negation of the BRIEF.md `UNATTENDED: yes`
  // line (absent -> attended, the stricter default that makes the handshake gate fire).
  const attended = parseUnattendedFromBrief(briefText || '') === false
  // SPD-3: the serialization-enforcement marker escalates serialGate/serialFeature P1->P0.
  const serializationEnforcement = parseSerializationEnforcement(briefText || '')

  // PLAN-e2e-verify: the goal-check-vN.md artifact BODIES from the artifact dir (the
  // carriers of the OPEN-BLOCKERS / E2E: machine lines). Read the SAME fail-closed way
  // anyArbiterDeferral/detectCompaction read the dir; openFlawFindings reads the latest.
  const goalCheckArtifacts = collectGoalCheckArtifacts(artifactDir)

  // SPEC-3 commit doctrine: the GOAL-CHECK DONE seals + COMMIT rows from the raw GATELOG.
  const goalChecks = parseGoalCheckRows(gatelogText || '')
  const commits = parseCommitRows(gatelogText || '')

  // PLAN-midrun-insertion: urgent-steer cancel/checkpoint ordering from raw GATELOG lines.
  const steerState = { urgentCancels: deriveSteerCancels((gatelogText || '').split('\n')) }

  // PLAN-proportional-gates: per-feature target file from explicit target=/file= tokens in
  // the raw GATELOG (fail-closed - never guessed from prose). Feeds proportionalGatesFindings ARM B.
  const featureTargets = deriveFeatureTargets((gatelogText || '').split('\n'))

  // PLAN-autoprompt-enforcement: the declared-disjoint cohort (DECOMPOSE rows) + the per-feature
  // wave assignment (DISPATCH rows) that feed serialFeatureFindings. Both from the SAME gatelogText.
  const featureDecomposition = deriveFeatureDecomposition((gatelogText || '').split('\n'))
  const featureDispatches = deriveFeatureDispatches((gatelogText || '').split('\n'))

  // SPD-1 tier-proportionality: the FEATURE-META rows + the over-tiering ceremony rows, both from the
  // SAME raw gatelogText. Fail-closed - an absent FEATURE-META row yields no firing (legacy ledger safe).
  const featureMeta = deriveFeatureMeta((gatelogText || '').split('\n'))
  const ceremonyRows = deriveCeremonyRows((gatelogText || '').split('\n'))

  // PLAN-anchor - yieldState: a run is a self-block when L0 returned control (a
  // conductor AskUserQuestion turn) with open in-flight tracks and no arbiter
  // deferral to the user. anchorState: a compaction is observed when a
  // post-compaction artifact exists; once compacted, ANCHOR.md must exist and its
  // live frontier must match the GATELOG-derived frontier.
  const yieldState = {
    returnedToUser: transcripts.some(t => t.isConductor === true && t.hasUserInterrupt === true),
    openInFlightTracks: countOpenInFlightTracks(gatelog.records),
    irreversibleQuestionPending: anyArbiterDeferral(artifactDir),
  }
  const anchorText = readIfExists(ledgerDir, 'ANCHOR.md')
  const anchorState = {
    compactionOccurred: detectCompaction(artifactDir),
    anchorExists: anchorText != null,
    anchorFrontier: parseAnchorFrontier(anchorText || ''),
    gatelogFrontier: deriveGatelogFrontier(gatelog.records),
  }

  // PLAN-auto-compact-threshold - compactState: the LIGHT proactive-miss signal. peakWatermark
  // from the .context-watermark file (token field) OR a GATELOG peak row; threshold from
  // AUTOPROMPT_COMPACT_AT (default 200000); compactionOccurred reuses the anchor derivation;
  // supervisorAttached when a RUN-ENDED marker is present. Fail-closed: any read error -> the rule
  // sees a malformed/absent peak and returns [].
  const compactState = deriveCompactState(ledgerDir, anchorState.compactionOccurred)

  // PLAN-liveness-reconcile: the THREE ground-truth signal sets from disk.
  const liveSignals = collectLiveSignals(transcriptDir, artifactDir)

  // PLAN-idle-watchdog L1 - idleFinishState: the run-boundary signals the terminal
  // IDLE-FINISH rule reads. `terminal` makes the audit run-ended: the CLI --terminal
  // flag (options.terminal) OR a RUN-ENDED marker the supervisor writes on child-exit-
  // without-sentinel (§2.4 V5). Both absent -> a mid-run snapshot, the rule never fires.
  // hasLiveAgents reuses the SAME liveSignals the liveness rule uses (a fresh sub-*.jsonl
  // OR a LIVE/in-flight FRONTIER entry = real work in flight); each .size read defensively.
  // missionDone is the DONE-* sentinel at the ledger root. openInFlightTracks /
  // irreversibleQuestionPending are reused from yieldState - no recomputation.
  const terminal = options.terminal === true || readIfExists(ledgerDir, 'RUN-ENDED') != null
  const hasLiveAgents =
    (liveSignals && liveSignals.freshTranscriptIds && liveSignals.freshTranscriptIds.size > 0) ||
    (liveSignals && liveSignals.frontierIds && liveSignals.frontierIds.size > 0) ||
    (liveSignals && liveSignals.frontierLabels && liveSignals.frontierLabels.size > 0)
  const idleFinishState = {
    runEnded: terminal,
    missionDone: detectDoneSentinel(ledgerDir, options.runNonce),
    openInFlightTracks: yieldState.openInFlightTracks,
    hasLiveAgents,
    irreversibleQuestionPending: yieldState.irreversibleQuestionPending,
  }

  const ctx = {
    gatelog: gatelog.records,
    gatelogText: gatelogText || '',
    agents: agents.records,
    compactLedger,
    roadmapItems,
    terminal,
    launchBinding,
    artifactExists,
    readArtifact,
    readRepoFile,
    transcripts,
    yieldState,
    anchorState,
    goalChecks,
    goalCheckArtifacts,
    commits,
    steerState,
    featureTargets,
    featureDecomposition,
    featureDispatches,
    featureMeta,
    ceremonyRows,
    serializationEnforcement,
    compactState,
    liveSignals,
    idleFinishState,
    // INH-1/INH-5 mission-fidelity inputs: the verbatim user-prompt ledger (PROMPTS.txt)
    // for the brief-diff arm, and the DONE-sentinel signal for the source-of-truth arm
    // (reuses the same detectDoneSentinel idleFinishState reads - no recomputation).
    promptsText,
    promptsPath,
    runNonce: typeof options.runNonce === 'string' ? options.runNonce : '',
    missionDone: idleFinishState.missionDone,
    // PLAN-startup-handshake: ATTENDED signal (from BRIEF.md UNATTENDED) for the
    // pre-spawn handshake HARD-GATE teeth; the drift signal is the root scan's firstToolUseName.
    attended,
  }
  const findings = []
  for (const rule of RULE_REGISTRY) findings.push(...rule(ctx))
  const ok = findings.every(f => f.severity !== 'P0')
  return { ok, findings, info }
}

// countOpenInFlightTracks: a feature is in-flight when it has >=1 GATELOG gate row
// but no terminal G8 SCRIBE seal. Pure over parsed gatelog records.
function countOpenInFlightTracks(gatelogRecords) {
  const records = Array.isArray(gatelogRecords) ? gatelogRecords : []
  const sealed = new Set()
  const seen = new Set()
  for (const r of records) {
    if (!r || !r.feature) continue
    seen.add(r.feature)
    if (r.gate === 'G8') sealed.add(r.feature)
  }
  let open = 0
  for (const f of seen) if (!sealed.has(f)) open++
  return open
}

// anyArbiterDeferral: scans the artifact dir's arbiter-*.md rulings for an explicit
// defer-to-user / userRequired ruling (the only legitimate ATTENDED yield). Best-
// effort; absent dir or unreadable file -> false (fail-closed: no deferral found).
function anyArbiterDeferral(artifactDir) {
  if (!artifactDir) return false
  let entries
  try { entries = fs.readdirSync(artifactDir) } catch (e) { return false }
  for (const name of entries) {
    if (!/arbiter[^\/\\]*\.md$/i.test(name)) continue
    let text
    try { text = fs.readFileSync(path.join(artifactDir, name), 'utf8') } catch (e) { continue }
    if (/userRequired["'\s:]+true/i.test(text) || /defer to user/i.test(text)) return true
  }
  return false
}

// collectGoalCheckArtifacts (PLAN-e2e-verify): read every goal-check-vN.md artifact
// BODY from the artifact dir into [{ path, text }], sorted by name so the append-only
// vN chronology puts the frontier last (openFlawFindings reads the latest). Best-
// effort, fail-closed: absent dir or unreadable entry -> [] / skipped (no artifact ==
// nothing for the rule to seal over, exactly the permissive-on-absence contract).
function collectGoalCheckArtifacts(artifactDir) {
  if (!artifactDir) return []
  let entries
  try { entries = fs.readdirSync(artifactDir) } catch (e) { return [] }
  const out = []
  for (const name of entries.slice().sort()) {
    if (!GOAL_CHECK_ARTIFACT_RE.test(name)) continue
    let text
    try { text = fs.readFileSync(path.join(artifactDir, name), 'utf8') } catch (e) { continue }
    out.push({ path: name, text })
  }
  return out
}

// detectCompaction: a run has compacted when a post-compaction / re-anchor artifact
// is present on disk. Best-effort; absent dir -> false (not yet compacted).
function detectCompaction(artifactDir) {
  if (!artifactDir) return false
  let entries
  try { entries = fs.readdirSync(artifactDir) } catch (e) { return false }
  return entries.some(name => /(post-?compaction|re-?anchor)[^\/\\]*\.md$/i.test(name))
}

// detectDoneSentinel (PLAN-idle-watchdog L3): when runNonce is supplied, only the
// active run's exact DONE-<nonce> file with parsed JSON (done===true, embedded
// nonce === runNonce) seals the mission - another activation's fresh DONE-* must
// never terminate this run. Without a nonce, the legacy broad scan for any DONE-*
// entry sealing done:true preserves readability of historical ledgers. Fail-closed:
// an absent dir, an unreadable entry, malformed JSON, or no match all -> false (an
// unverifiable sentinel is treated as NOT done - the safe direction: it can only
// make IDLE-FINISH fire on a genuinely-open run, never falsely suppress it).
function detectDoneSentinel(ledgerDir, runNonce) {
  if (!ledgerDir) return false
  if (typeof runNonce === 'string' && runNonce !== '') {
    let value
    try {
      value = JSON.parse(fs.readFileSync(path.join(ledgerDir, `DONE-${runNonce}`), 'utf8'))
    } catch (e) { return false }
    return value != null && value.done === true && value.nonce === runNonce
  }
  let entries
  try { entries = fs.readdirSync(ledgerDir) } catch (e) { return false }
  for (const name of entries) {
    if (!/^DONE-/.test(name)) continue
    let text
    try { text = fs.readFileSync(path.join(ledgerDir, name), 'utf8') } catch (e) { continue }
    if (/"done"\s*:\s*true/.test(text)) return true
  }
  return false
}

// parseAnchorFrontier: parse the LIVE FRONTIER section of ANCHOR.md into
// [{feature,status}]. Lines after a "LIVE FRONTIER" header of the form
// "- <FEATURE>: <STATUS>" are collected. Returns [] on no header / empty text.
function parseAnchorFrontier(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.split('\n')
  const frontier = []
  let inFrontier = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/LIVE FRONTIER/i.test(line)) { inFrontier = true; continue }
    if (!inFrontier) continue
    if (line.startsWith('#')) { inFrontier = false; continue }
    const m = line.match(/^-\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
    if (m) frontier.push({ feature: m[1], status: m[2].trim() })
  }
  return frontier
}

// deriveGatelogFrontier: the latest verdict per feature -> [{feature,status}].
// Append-only chronology means the last gatelog row for a feature is its frontier.
function deriveGatelogFrontier(gatelogRecords) {
  const records = Array.isArray(gatelogRecords) ? gatelogRecords : []
  const latest = new Map()
  for (const r of records) {
    if (!r || !r.feature) continue
    latest.set(r.feature, (r.verdict || '').trim())
  }
  return [...latest.entries()].map(([feature, status]) => ({ feature, status }))
}

function readIfExists(dir, name) {
  if (!dir) return null
  const full = path.join(dir, name)
  try {
    if (!fs.existsSync(full)) return null
    return fs.readFileSync(full, 'utf8')
  } catch (e) {
    return null
  }
}

// === SESSION-RESOLVE-SLICE:START - test-only export seam; sliced by session-resolve.test.js. Self-contained: PURE path-NAME helpers over injected arrays/strings, NO fs. ===
// SPEC-1 session ledger: the path-NAME ALGORITHM lives here as pure functions over
// injected arrays/strings (the fs-backed resolvePromptDir below applies these names to
// disk). Fully unit-testable with plain arrays - no fs inside any of these.
const SESSION_NAME_RE = /^session_(\d+)$/
const PROMPT_NAME_RE = /^prompt_(\d+)-/

// pad a positive integer to >=2 digits, widening to 3 once it reaches 100.
function padSession(n) {
  const s = String(n)
  return s.length >= 3 ? s : s.padStart(2, '0')
}

// nextSessionName(existingNames) -> "session_<pad of max+1>"; "session_01" on empty/garbage.
function nextSessionName(existingNames) {
  const names = Array.isArray(existingNames) ? existingNames : []
  let max = 0
  for (const raw of names) {
    const m = SESSION_NAME_RE.exec(String(raw || ''))
    if (!m) continue
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `session_${padSession(max + 1)}`
}

// nextPromptName(existingNames, slug) -> "prompt_<pad of max+1>-<slug>"; "prompt_01-<slug>" on empty.
function nextPromptName(existingNames, slug) {
  const names = Array.isArray(existingNames) ? existingNames : []
  let max = 0
  for (const raw of names) {
    const m = PROMPT_NAME_RE.exec(String(raw || ''))
    if (!m) continue
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `prompt_${padSession(max + 1)}-${slug}`
}

// parseMarker(text) -> {name, token} from "session_NN  <token>". Missing token -> token:'';
// garbage / non-string -> {name:'', token:''}.
function parseMarker(text) {
  if (typeof text !== 'string') return { name: '', token: '' }
  const m = /^\s*(session_\d+)(?:\s+(\S+))?\s*$/.exec(text)
  if (!m) return { name: '', token: '' }
  return { name: m[1], token: m[2] || '' }
}

// decideSession({markerLine, markerDirExists, liveToken, isResume}) -> {sameSession}: true IFF
// isResume===true OR (markerDirExists===true AND parsed marker token === non-empty liveToken).
function decideSession({ markerLine, markerDirExists, liveToken, isResume } = {}) {
  if (isResume === true) return { sameSession: true }
  if (markerDirExists !== true) return { sameSession: false }
  const token = parseMarker(markerLine).token
  const live = typeof liveToken === 'string' ? liveToken : ''
  return { sameSession: live !== '' && token === live }
}

// pickPromptDir(entries, slug) -> {name, reenter}. entries = [{name, hasGatelog, hasArtifacts,
// hasDone}]. An unfinished prompt (gatelog/artifacts present, no DONE) is re-entered (highest-
// numbered); else a fresh nextPromptName is minted.
function pickPromptDir(entries, slug) {
  const rows = Array.isArray(entries) ? entries : []
  const unfinished = rows.filter(e => e && (e.hasGatelog || e.hasArtifacts) && !e.hasDone)
  if (unfinished.length > 0) {
    let best = unfinished[0]
    let bestNum = -1
    for (const e of unfinished) {
      const m = PROMPT_NAME_RE.exec(String(e.name || ''))
      const n = m ? parseInt(m[1], 10) : 0
      if (n > bestNum) { bestNum = n; best = e }
    }
    return { name: best.name, reenter: true }
  }
  return { name: nextPromptName(rows.map(e => (e && e.name) || ''), slug), reenter: false }
}
// === SESSION-RESOLVE-SLICE:END ===

// resolvePromptDir (SPEC-1 - the fs OWNER; OUTSIDE the pure slice). Applies the pure
// Make a fresh user's repo ignore the ledger by default: drop a self-ignoring .gitignore
// (the "*" idiom) into the ledger root the first time it is created. The ledger is generated
// run state, not source - it should never land in the user's git history unless they opt in.
// Idempotent and best-effort: a pre-existing .gitignore (e.g. a user override) is left alone,
// and an fs error here never blocks a run (the ledger still works untracked or not).
function ensureLedgerGitignore(ledgerRoot) {
  const gitignorePath = path.join(ledgerRoot, '.gitignore')
  if (fs.existsSync(gitignorePath)) return
  try {
    fs.writeFileSync(gitignorePath, '# Auto-generated by autoprompt: the ledger is run state, not source.\n*\n')
  } catch {
    // best-effort: ledger creation must not fail because the ignore file could not be written
  }
}

// path-NAME helpers to disk: decide same-vs-new session from the .session-current marker,
// pick/re-enter the prompt folder, mkdir, write the marker atomically, return the resolved
// PROMPT_DIR. FAIL-LOUD: on an unrecoverable fs error it THROWS (the CLI exits non-zero with
// no stdout) - never a silent flat-dir fallback (which would defeat SPEC-1 S1-S3/S6).
function resolvePromptDir({ ledgerRoot, slug, isResume, token, mintToken } = {}) {
  if (typeof ledgerRoot !== 'string' || ledgerRoot === '') {
    throw new Error(`resolvePromptDir: ledgerRoot must be a non-empty string (got ${typeof ledgerRoot})`)
  }
  const safeSlug = typeof slug === 'string' && slug.trim() !== '' ? slug.trim() : 'run'
  fs.mkdirSync(ledgerRoot, { recursive: true })
  ensureLedgerGitignore(ledgerRoot)
  const markerPath = path.join(ledgerRoot, '.session-current')
  const markerLine = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : ''
  const marker = parseMarker(markerLine)
  const markerDirExists = marker.name !== '' && fs.existsSync(path.join(ledgerRoot, marker.name))
  const liveToken = typeof token === 'string' ? token : ''
  const { sameSession } = decideSession({ markerLine, markerDirExists, liveToken, isResume: isResume === true })

  let sessionName
  let effectiveToken
  if (sameSession) {
    sessionName = marker.name
    effectiveToken = marker.token || liveToken
  } else {
    const existing = fs.readdirSync(ledgerRoot).filter(n => SESSION_NAME_RE.test(n))
    sessionName = nextSessionName(existing)
    fs.mkdirSync(path.join(ledgerRoot, sessionName), { recursive: true })
    const mint = typeof mintToken === 'function' ? mintToken : () => `tok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    effectiveToken = liveToken || mint()
  }
  const tmp = `${markerPath}.tmp`
  fs.writeFileSync(tmp, `${sessionName}  ${effectiveToken}`)
  fs.renameSync(tmp, markerPath)

  const sessionDir = path.join(ledgerRoot, sessionName)
  const promptNames = fs.readdirSync(sessionDir).filter(n => PROMPT_NAME_RE.test(n))
  const entries = promptNames.map(name => {
    const full = path.join(sessionDir, name)
    return {
      name,
      hasGatelog: fs.existsSync(path.join(full, 'GATELOG.md')),
      hasArtifacts: fs.existsSync(path.join(full, 'artifacts')),
      hasDone: fs.existsSync(path.join(full, 'DONE')),
    }
  })
  const picked = pickPromptDir(entries, safeSlug)
  const promptDir = path.join(sessionDir, picked.name)
  if (!picked.reenter) fs.mkdirSync(promptDir, { recursive: true })
  return promptDir
}

// deriveCompactState (PLAN-auto-compact-threshold): build the LIGHT proactive-miss signal from disk.
// peakWatermark = the token field of the .context-watermark file; threshold = AUTOPROMPT_COMPACT_AT
// env (default 200000); supervisorAttached when a RUN-ENDED marker exists. Fail-closed: any unreadable
// input -> peakWatermark 0 -> the rule returns []. compactionOccurred is passed in (reuses the anchor
// derivation, no double read).
function deriveCompactState(ledgerDir, compactionOccurred) {
  if (!ledgerDir) return undefined
  const COMPACT_DEFAULT = 200000
  const env = (typeof process === 'object' && process && process.env && process.env.AUTOPROMPT_COMPACT_AT) || ''
  const parsedEnv = parseInt(env, 10)
  const threshold = Number.isFinite(parsedEnv) && parsedEnv > 0 ? parsedEnv : COMPACT_DEFAULT
  let peakWatermark = 0
  const watermark = readIfExists(ledgerDir, '.context-watermark')
  if (watermark != null) {
    const m = /(\d+)/.exec(watermark)
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n)) peakWatermark = n }
  }
  const supervisorAttached = readIfExists(ledgerDir, 'RUN-ENDED') != null
  return { peakWatermark, threshold, compactionOccurred: compactionOccurred === true, supervisorAttached }
}

// collectLiveSignals (PLAN-liveness-reconcile): the THREE ground-truth signal sets that
// can back a "running" claim - fresh non-terminated on-disk sub-*.jsonl ids, AGENTS.md
// ids, and LIVE (non-sealed) FRONTIER ids+labels. All reads try/catch -> empty set on
// failure (fail-closed: an absent signal never fabricates liveness).
function collectLiveSignals(transcriptDir, artifactDir) {
  const freshTranscriptIds = new Set()
  const agentsMdIds = new Set()
  const frontierIds = new Set()
  const frontierLabels = new Set()
  const addIds = (text, set) => { for (const m of String(text).matchAll(AGENT_ID_RE)) set.add(m[1].toLowerCase()) }
  if (transcriptDir) {
    let entries = []
    try { entries = fs.readdirSync(transcriptDir) } catch (e) { entries = [] }
    for (const name of entries) {
      if (!/^sub-.*\.jsonl$/.test(name)) continue
      const full = path.join(transcriptDir, name)
      try {
        const stat = fs.statSync(full)
        if (Date.now() - stat.mtimeMs > LIVENESS_FRESH_WINDOW_MS) continue
        const text = fs.readFileSync(full, 'utf8')
        if (TRANSCRIPT_DONE_RE.test(text.slice(-2000))) continue
        const m = name.match(/sub-([a-z0-9-]+)/i)
        if (m) freshTranscriptIds.add(m[1].toLowerCase())
        addIds(name, freshTranscriptIds)
      } catch (e) { continue }
    }
  }
  for (const dir of [transcriptDir, artifactDir]) {
    if (!dir) continue
    let entries = []
    try { entries = fs.readdirSync(dir) } catch (e) { entries = [] }
    for (const name of entries) {
      if (/^AGENTS\.md$/i.test(name)) {
        try { addIds(fs.readFileSync(path.join(dir, name), 'utf8'), agentsMdIds) } catch (e) { /* fail-closed */ }
      }
      if (/ANCHOR\.md$/i.test(name) || /frontier.*\.md$/i.test(name)) {
        let text = ''
        try { text = fs.readFileSync(path.join(dir, name), 'utf8') } catch (e) { continue }
        for (const line of text.split('\n')) {
          if (!FRONTIER_LIVE_RE.test(line) || FRONTIER_DEAD_RE.test(line)) continue
          addIds(line, frontierIds)
          for (const m of line.matchAll(FEATURE_LABEL_RE)) frontierLabels.add(m[1].toUpperCase())
        }
      }
    }
  }
  return { freshTranscriptIds, agentsMdIds, frontierIds, frontierLabels }
}

// Scan a transcript dir of sub-*.jsonl files into the {path, feature, persona,
// isConductor, ...flags} shape the F5-18 rule + the five FX-HIERARCHY rules read.
// Absent dir -> [] (the rules then yield nothing - a non-benchmark run is never
// false-FAILed). The feature id + persona are best-effort parsed from the filename
// (the run names transcripts sub-<persona>-NN.jsonl); a persona-less name yields
// persona '' (fail-closed - a rule keyed on a specific persona never fires) and a
// 00-conductor* filename (or a cl-conductor persona) marks the conductor turn.
function scanTranscriptDir(transcriptDir) {
  if (!transcriptDir) return []
  let entries
  try { entries = fs.readdirSync(transcriptDir) } catch (e) { return [] }
  const transcripts = []
  for (const name of entries) {
    if (!/\.jsonl$/.test(name)) continue
    let text
    try { text = fs.readFileSync(path.join(transcriptDir, name), 'utf8') } catch (e) { continue }
    const scan = scanTranscript(text)
    // FID matcher derives from the SAME FID_RE_SRC as FEATURE_DECL_RE (Change 3): the
    // no-embedded-hyphen NAME body makes `sub-ap-manager-F-QUAL-01.jsonl` extract `F-QUAL`
    // (NOT `F-QUAL-01`) - \b anchors and a persona token cannot match (no leading F/SPEC-).
    const featureMatch = name.match(new RegExp(`\\b(${FID_RE_SRC})\\b`))
    const personaMatch = name.match(/\b((?:ap|cl)-[a-z]+(?:-[a-z]+)*)\b/)
    const persona = personaMatch ? personaMatch[1] : ''
    const isConductor = persona === 'cl-conductor' || /(^|[\/\\])00-conductor/.test(name)
    // SPEC-2: a conductor transcript is BILLIONAIRE when its filename carries the tag
    // OR it actually spawned (totalSpawnCount >= 1). TOKENSAVER/unflagged -> false.
    const isBillionaire = /billionaire|wide/i.test(name) || scan.totalSpawnCount >= 1
    transcripts.push({
      path: name,
      feature: featureMatch ? featureMatch[1] : '',
      persona,
      isConductor,
      hasProductionEditOrWrite: scan.hasProductionEditOrWrite,
      hasVerifyOrGoalCheckPytest: scan.hasVerifyOrGoalCheckPytest,
      hasBashEditWrite: scan.hasBashEditWrite,
      hasWriteEditBashWebTool: scan.hasWriteEditBashWebTool,
      hasNonAgentToolUse: scan.hasNonAgentToolUse,
      wroteDoneSentinel: scan.wroteDoneSentinel,
      wroteGoalCheck: scan.wroteGoalCheck,
      spawnedTypes: scan.spawnedTypes,
      editsProductionFile: scan.hasProductionEditOrWrite,
      hasUserInterrupt: scan.hasUserInterrupt,
      wroteAnchor: scan.wroteAnchor,
      maxBatchedSpawns: scan.maxBatchedSpawns,
      hadFoldOrDispatchAfterWave: scan.hadFoldOrDispatchAfterWave,
      totalSpawnCount: scan.totalSpawnCount,
      maxFeatureSupervisorWave: scan.maxFeatureSupervisorWave,
      isBillionaire,
      hasGitAddAll: scan.hasGitAddAll,
      hasGitCommit: scan.hasGitCommit,
      spawnedDescriptions: scan.spawnedDescriptions,
      hasLeanAsIdleNarration: scan.hasLeanAsIdleNarration,
      dispatchedAnyTrack: scan.dispatchedAnyTrack,
      maxToolResultChars: scan.maxToolResultChars,
      hasOversizedReport: scan.hasOversizedReport,
      fleetTableTurns: scan.fleetTableTurns,
      livenessTurns: scan.livenessTurns,
      gateSpawnTurns: scan.gateSpawnTurns,
      deadConclusionTurns: scan.deadConclusionTurns,
      respawnTargets: scan.respawnTargets,
      readsProductionFiles: scan.readsProductionFiles,
      firstUserTurnText: scan.firstUserTurnText,
      userTurnTexts: scan.userTurnTexts,
      firstToolUseName: scan.firstToolUseName,
    })
  }
  return transcripts
}

// parseArgs: minimal --flag value parser for the three dir flags.
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ledger-dir') out.ledgerDir = argv[++i]
    else if (a === '--artifact-dir') out.artifactDir = argv[++i]
    else if (a === '--transcript-dir') out.transcriptDir = argv[++i]
    else if (a === '--terminal') out.terminal = true
    else if (a === '--run-nonce') out.runNonce = argv[++i]
    else if (a === '--resolve-prompt-dir') out.resolvePromptDir = true
    else if (a === '--slug') out.slug = argv[++i]
    else if (a === '--resume') out.resume = true
    else if (a === '--verify-deployed') { out.verifyDeployed = true; out.deployInstalledDir = argv[++i]; out.deploySourceDir = argv[++i] }
  }
  return out
}

module.exports = {
  parseLedgerLines,
  parseRoadmapItems,
  roadmapClosureFindings,
  mixedLedgerFormatFindings,
  reconcileProvenance,
  selfReviewSignatureFindings,
  managerExecFindings,
  conductorToolUseFindings,
  l1ChildrenFindings,
  goalCheckJanitorFindings,
  preflightEditFindings,
  selfBlockYieldFindings,
  anchorIntegrityFindings,
  normalizeFrontier,
  waveBarrierFindings,
  isWaveBarrier,
  parseModeFromBrief,
  parseSerializationEnforcement,
  commitCheckpointFindings,
  parseGoalCheckRows,
  parseCommitRows,
  thinSprawlFindings,
  conductorSpawnAllowlistFindings,
  L0_LEGAL_SPAWN_TYPES,
  leanIdleFindings,
  artifactSubstanceFindings,
  artifactSubstantiationReasons,
  countSubstantiveCaptures,
  parentFleetSynthesisFindings,
  toolResults,
  VERDICT_BUDGET_CHARS,
  FLEET_TABLE_TURN_MIN,
  FLEET_ROW_RE,
  DIFF_RE,
  midRunCancelCheckpointFindings,
  deriveSteerCancels,
  proportionalGatesFindings,
  deriveFeatureTargets,
  PROPORTIONAL_SIBLING_FLOOR,
  livenessReconcileFindings,
  isLivenessGap,
  falseNegativeLivenessFindings,
  isFalseNegativeLivenessGap,
  toolResultForUse,
  serialGateFindings,
  serialFeatureFindings,
  serialDispatchFindings,
  SERIAL_DISPATCH_FLOOR,
  spawnSplitFindings,
  briefSplitReasons,
  verifyDeployedMatchesSource,
  listDeployKeyFiles,
  hashContent,
  managerWorkerStarvationFindings,
  splittableConcreteParts,
  L3_EXECUTORS,
  FID_RE_SRC,
  deriveFeatureDecomposition,
  deriveFeatureDispatches,
  disjointOwns,
  SERIAL_FEATURE_FLOOR,
  DISPATCH_RE,
  supervisorWaveCountFindings,
  SUPERVISOR_WAVE_FLOOR,
  compactThresholdFindings,
  frameworkFallthroughFindings,
  tierProportionalityFindings,
  deriveFeatureMeta,
  deriveCeremonyRows,
  evidencePackFindings,
  frameworkTierFindings,
  depthLockFindings,
  DEPTHLOCK_D3_RE,
  DEPTHLOCK_FIXLAYER_RE,
  DEPTHLOCK_D4_RED_RE,
  assistantText,
  leafTierConsistent,
  rowHasSubstantiveEvidence,
  parseJsonObject,
  resolveLaunchBinding,
  ensureLedgerGitignore,
  collectLiveSignals,
  countOpenInFlightTracks,
  anyArbiterDeferral,
  detectCompaction,
  detectDoneSentinel,
  idleFinishFindings,
  parseAnchorFrontier,
  deriveGatelogFrontier,
  scanTranscript,
  scanTranscriptDir,
  isProductionPath,
  nextSessionName,
  nextPromptName,
  parseMarker,
  decideSession,
  pickPromptDir,
  resolvePromptDir,
  RULE_REGISTRY,
  runLedgerCheck,
  parseArgs,
  resolvePromptDirCli,
  verifyDeployedCli,
  ledgerCheckCli,
  runCli,
  writeCliOutput,
  GATE_EXPECTED_PERSONA,
  REAL_RUNNER_RE,
  L1_PERSONAS,
  firstUserText,
  allUserTexts,
  parsePromptsTxt,
  missionFidelityFindings,
  missionSourceOfTruthFindings,
  selfWrittenCaptureFindings,
  openFlawFindings,
  startupHandshakeFindings,
  parseUnattendedFromBrief,
  parseE2EAxis,
  parseOpenBlockers,
  collectGoalCheckArtifacts,
  MISSION_BLOCK_LABEL,
  MISSION_POINTER_LABEL,
  PRIOR_STEERS_BLOCK_LABEL,
}

function resolvePromptDirCli(opts, environment = process.env) {
  try {
    const promptDir = resolvePromptDir({
      ledgerRoot: opts.ledgerDir,
      slug: opts.slug,
      isResume: opts.resume === true,
      token: environment.AUTOPROMPT_SESSION_TOKEN || '',
    })
    return { exitCode: 0, stdout: `${promptDir}\n`, stderr: '' }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    return { exitCode: 1, stdout: '', stderr: `RESOLVE-PROMPT-DIR FAILED: ${message}\n` }
  }
}

function verifyDeployedCli(opts) {
  if (!opts.deployInstalledDir || !opts.deploySourceDir) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'VERIFY-DEPLOYED FAILED: usage is --verify-deployed <installedDir> <sourceDir> (both required)\n',
    }
  }
  const { ok, checked, mismatched, missingInDeployed, missingInSource } =
    verifyDeployedMatchesSource({
      installedDir: opts.deployInstalledDir,
      sourceDir: opts.deploySourceDir,
    })
  if (ok) {
    return {
      exitCode: 0,
      stdout: `DEPLOYED==SOURCE OK: ${checked} key file(s) byte-identical (${opts.deployInstalledDir} == ${opts.deploySourceDir}).\n`,
      stderr: '',
    }
  }
  const stale = [
    ...mismatched.map(file => `DIFFERS ${file}`),
    ...missingInDeployed.map(file => `MISSING-IN-DEPLOYED ${file}`),
    ...missingInSource.map(file => `MISSING-IN-SOURCE ${file}`),
  ]
  return {
    exitCode: 1,
    stdout: '',
    stderr:
      `DEPLOYED!=SOURCE MISMATCH: ${stale.length} of ${checked} key file(s) stale - ` +
      'the installed skill does NOT match source. Re-deploy before shipping (F-11):\n' +
      stale.map(line => `  ${line}`).join('\n') + '\n',
  }
}

function ledgerCheckCli(opts) {
  const { ok, findings, info } = runLedgerCheck(opts)
  const stdout = [
    ...info.map(note => `INFO: ${note}`),
    ...findings.map(finding => `${finding.severity} [${finding.rule}] ${finding.title}`),
  ]
  if (ok) {
    stdout.push('LEDGER-CHECK PASSED: every claimed gate is backed by a distinct spawn + artifact; no self-review signature.')
    return { exitCode: 0, stdout: `${stdout.join('\n')}\n`, stderr: '' }
  }
  return {
    exitCode: 1,
    stdout: `${stdout.join('\n')}\n`,
    stderr: `LEDGER-CHECK FAILED: ${findings.filter(finding => finding.severity === 'P0').length} P0 provenance finding(s).\n`,
  }
}

function runCli(argv, environment = process.env) {
  const opts = parseArgs(argv)
  if (opts.resolvePromptDir === true) return resolvePromptDirCli(opts, environment)
  if (opts.verifyDeployed === true) return verifyDeployedCli(opts)
  return ledgerCheckCli(opts)
}

function writeCliOutput(output) {
  process.stdout.write(output.stdout)
  process.stderr.write(output.stderr)
  process.exitCode = output.exitCode
}

if (require.main === module) {
  writeCliOutput(runCli(process.argv.slice(2)))
}
