#!/bin/sh
# autoprompt supervisor - external auto-relaunch for a one-sitting unattended run.
#
# This is a STANDALONE OS PROCESS, NOT a Claude Code hook. It touches no
# settings.json, registers no hook, and is launched by the operator (or a
# tmux/nohup line). It honors the global no-hooks rule.
#
# It relaunches the autoprompt CLI with RESUME on any unexpected exit, loops
# until the JANITOR has written the DONE-sentinel (autoprompt/DONE-<nonce>),
# and has a crash-loop/poison-restart guard that distinguishes:
#   - a FINISHED run (sentinel present)        -> clean halt
#   - a HEALTHY-LONG run (frontier advances)   -> keep relaunching, no escalation
#   - a TRULY-STUCK run (no frontier progress) -> escalate, stop relaunching
#
# Usage:
#   supervisor.sh --launcher apidemo|codexdemo "<mission>"
#   supervisor.sh --cmd "claude --dangerously-skip-permissions -p" "<mission>"
#
# The launch command is resolved in this precedence:
#   1. --cmd "<command>" / AUTOPROMPT_LAUNCH_CMD  (used VERBATIM, word-split,
#      with the mission appended) -- the explicit, copy-pasteable escape hatch.
#   2. --launcher <label> / AUTOPROMPT_LAUNCHER   (the bare command name, e.g.
#      apidemo|codexdemo, exec'd directly -- requires that name to be on PATH).
# A fresh user with no apidemo/codexdemo alias uses --cmd with their real CLI.
# Env (all optional):
#   AUTOPROMPT_LAUNCH_CMD  verbatim launch command (overrides --launcher)
#   AUTOPROMPT_LAUNCHER   default launcher label if --launcher is omitted
#   LEDGER_DIR             default "autoprompt"
#   SENTINEL               explicit sentinel glob/patterns (default <LEDGER_DIR>/DONE-*).
#                          When SET, the value is WORD-SPLIT into one-or-more shell
#                          globs (an explicit multi-pattern escape hatch) and so MUST
#                          NOT contain spaces in any single path. When UNSET (the
#                          default -- every real run) the glob is "$LEDGER_DIR"/DONE-*
#                          with the DIR QUOTED and only the * unquoted, so a LEDGER_DIR
#                          containing spaces (e.g. a Windows path) still matches its
#                          DONE-* sentinel. NOTE: the .ps1 port passes an explicit
#                          SENTINEL as ONE Get-ChildItem -Path pattern (no word-split),
#                          so a space-separated multi-pattern SENTINEL is a .sh-only
#                          feature; on PowerShell use a single dir-wildcard instead.
#   MAX_RESTARTS           rapid restarts allowed in WINDOW without progress (default 5)
#   WINDOW                 rolling window seconds for the poison guard (default 600)
#   RETRY_BASE             base backoff seconds between relaunches (default 5; 0 in tests)
#   RETRY_CAP              max backoff seconds (default 300)
#   AUTOPROMPT_MODE       tokensaver | wide | billionaire | custom (default
#                          tokensaver). WIDE and BILLIONAIRE share wide semantics.
#                          CUSTOM requires a positive numeric
#                          AUTOPROMPT_MAX_CONCURRENT value, floors it to a whole-agent
#                          ceiling, and passes both values through to the harness.
# The 5-level topology (L0 conductor -> L1 coordinators -> L2 managers -> L3
# executors -> L4 leaves) lives in the harness; rule 68 (L1 never executes) and
# rule 67 (single-block spawns) are enforced there. This OS-level supervisor only
# relaunches the L0 entry process and passes the mode through; it spawns no agents.
# Test hooks (only honored with --dry-run):
#   FAKE_EXITS             space-separated exit codes the fake launcher returns in turn
#   FAKE_SENTINEL_AFTER    write the sentinel before the launch with this 1-based index
#   FAKE_POISON            1 => fake never advances the frontier and always exits non-zero

# MODEL INHERITANCE NOTE (codex stack):
# The Codex defeater is .codex/config.toml model= (operator config, git-untracked,
# out of scope to rewrite). This supervisor has no env-var neutralization because
# the pin is a file, not an env var. The agents/claude/workflow/supervisor.sh DOES
# neutralize CLAUDE_CODE_SUBAGENT_MODEL (an env var) at launch. See agents/codex/SKILL.md
# for operator guidance on setting model = "inherit" in .codex/config.toml.

set -u

LAUNCHER="${AUTOPROMPT_LAUNCHER:-}"
LAUNCH_CMD="${AUTOPROMPT_LAUNCH_CMD:-}"
AGENTS_SELECTOR="${AUTOPROMPT_AGENTS:-off}"
MODEL_REGISTRY="${AUTOPROMPT_MODEL_REGISTRY:-}"
LEDGER_DIR="${LEDGER_DIR:-autoprompt}"
MAX_RESTARTS="${MAX_RESTARTS:-5}"
WINDOW="${WINDOW:-600}"
RETRY_BASE="${RETRY_BASE:-5}"
RETRY_CAP="${RETRY_CAP:-300}"
IDLE_TIMEOUT="${AUTOPROMPT_IDLE_TIMEOUT:-1800}"      # seconds of frontier-count staleness while alive -> kill -> relaunch (continue)
HEARTBEAT_INTERVAL="${AUTOPROMPT_HEARTBEAT_INTERVAL:-60}"  # poll cadence while the child is alive
# IDLE_TIMEOUT defaults to 1800s (30 min) so a long-but-progressing build/test does NOT
# trip the heartbeat - the frontier count grows on ANY artifact write and resets the
# timer; operators with long single atomic steps raise AUTOPROMPT_IDLE_TIMEOUT.
# PLAN-auto-compact-threshold: proactive, SUPERVISOR-FIRED compaction below the harness
# ~400k ceiling. The supervisor observes the parent's context size from OUTSIDE (it
# parses the parent's own Codex/Claude session transcript; watermark/ledger-byte
# fallbacks) and, when it crosses COMPACT_AT, writes COMPACT-REQUEST (a heads-up so the
# parent checkpoints + STOPS its subagents at the next gate boundary) and, on grace
# timeout, fires the kill->RESUME itself (the parent cannot /compact itself).
COMPACT_AT="${AUTOPROMPT_COMPACT_AT:-200000}"          # proactive compaction watermark (tokens); below the harness ~400k ceiling
BYTES_PER_TOKEN="${AUTOPROMPT_BYTES_PER_TOKEN:-4}"     # bytes->tokens divisor for the fallback proxies
COMPACT_COOLDOWN="${AUTOPROMPT_COMPACT_COOLDOWN:-120}" # seconds after a compaction before another may be requested
COMPACT_GRACE="${AUTOPROMPT_COMPACT_GRACE:-180}"       # seconds to let the parent honor a request before the forced fallback
EXTERNAL_COMPACT_DELTA="${AUTOPROMPT_EXTERNAL_COMPACT_DELTA:-50000}"  # an estimate DROP >= this across ticks = a harness-fired compaction
# Validate COMPACT_AT to a positive integer; an absurd/non-numeric value falls back to
# the default (never disables the guard, never fires every tick -- the zero-threshold trap).
case "$COMPACT_AT" in (*[!0-9]*|"") COMPACT_AT=200000 ;; esac
[ "$COMPACT_AT" -gt 0 ] 2>/dev/null || COMPACT_AT=200000
[ "$COMPACT_AT" -lt 10000000 ] 2>/dev/null || COMPACT_AT=200000
case "$BYTES_PER_TOKEN" in (*[!0-9]*|""|0) BYTES_PER_TOKEN=4 ;; esac
# F-SPEED steer-2 B3: PHASE WALL-CLOCK BUDGET for the SCOPE phase. IDLE_TIMEOUT
# (above) fires only on frontier STALENESS; steer 2's "scope supervisor often takes
# 30min or more ... hella time consuming" scope IS progressing (each scope-<angle>-vN
# write bumps frontier_count), so it resets the idle clock every tick and is NEVER
# bounded. This budget is anchored to scope-phase ENTRY and NOT reset by frontier
# growth - the exact hole IDLE_TIMEOUT leaves. Soft => a converge REQUEST; hard (or an
# unhonored converge past grace) => a durable breach marker + REAL kill->RESUME on the
# honest landed set; a re-breach past the reset cap => SUPERVISOR-ESCALATE. It NEVER
# fabricates a roadmap. Each knob is validated with the SAME positive-integer idiom as
# COMPACT_AT: an absurd/non-numeric value falls back to the default (never disables the
# guard, never a zero-budget trap that fires every tick).
SCOPE_SOFT_SEC="${AUTOPROMPT_SCOPE_SOFT_SEC:-60}"      # bounded scope target (converge request)
SCOPE_HARD_SEC="${AUTOPROMPT_SCOPE_HARD_SEC:-300}"     # ordinary multi-surface ceiling (forced kill->RESUME)
SCOPE_GRACE_SEC="${AUTOPROMPT_SCOPE_GRACE:-60}"        # unhonored-converge grace before the forced reset
MAX_SCOPE_RESETS="${AUTOPROMPT_MAX_SCOPE_RESETS:-1}"  # budget-forced scope resets before escalation
case "$SCOPE_SOFT_SEC" in (*[!0-9]*|"") SCOPE_SOFT_SEC=60 ;; esac
[ "$SCOPE_SOFT_SEC" -gt 0 ] 2>/dev/null || SCOPE_SOFT_SEC=60
case "$SCOPE_HARD_SEC" in (*[!0-9]*|"") SCOPE_HARD_SEC=300 ;; esac
[ "$SCOPE_HARD_SEC" -gt 0 ] 2>/dev/null || SCOPE_HARD_SEC=300
case "$SCOPE_GRACE_SEC" in (*[!0-9]*|"") SCOPE_GRACE_SEC=60 ;; esac
[ "$SCOPE_GRACE_SEC" -ge 0 ] 2>/dev/null || SCOPE_GRACE_SEC=60
case "$MAX_SCOPE_RESETS" in (*[!0-9]*|"") MAX_SCOPE_RESETS=1 ;; esac
[ "$MAX_SCOPE_RESETS" -ge 0 ] 2>/dev/null || MAX_SCOPE_RESETS=1
# F-SPEED steer-2 B3: derive the phase-budget verdict CLI path from this script's own
# location (codex has no ledger-check.js sibling, so SCRIPT_DIR is derived here). An
# operator override wins; the [ -r ] guard at the call site fail-opens if node/module
# are absent. CDPATH= guards a hostile CDPATH; -- ends option parsing for an odd $0.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PHASE_BUDGET_PATH="${AUTOPROMPT_PHASE_BUDGET:-$SCRIPT_DIR/phase-budget.js}"
CODEX_CASTING_PATH="${AUTOPROMPT_CODEX_CASTING:-$SCRIPT_DIR/codex-agent-casting.js}"
CODEX_PROFILE_TOOL="${AUTOPROMPT_CODEX_PROFILE_TOOL:-$SCRIPT_DIR/codex-agent-profile.js}"
CODEX_AGENTS_PATH="${AUTOPROMPT_CODEX_AGENTS_DIR:-$SCRIPT_DIR/../agents-runtime}"
CODEX_PROFILE_NAME="${AUTOPROMPT_CODEX_PROFILE_NAME:-autoprompt}"
CODEX_PROFILE_PATH="${AUTOPROMPT_CODEX_PROFILE_FILE:-${CODEX_HOME:-$HOME/.codex}/autoprompt.config.toml}"
# Execution mode selects the 5-level topology's wave cap. Unknown modes retain the
# safe tokensaver fallback. CUSTOM is different: it is an explicit request for a
# caller-supplied ceiling, so a missing or invalid ceiling fails closed.
AUTOPROMPT_MODE="${AUTOPROMPT_MODE:-tokensaver}"
case "$AUTOPROMPT_MODE" in
  tokensaver) FANOUT="up to 6 live per wave"; L3_TRACKS="parallel" ;;
  wide|billionaire) FANOUT="wide up to the runtime ceiling"; L3_TRACKS="parallel" ;;
  custom)
    CUSTOM_MAX=$(awk -v raw="${AUTOPROMPT_MAX_CONCURRENT:-}" 'BEGIN {
      if (raw ~ /^[+]?[0-9]+([.][0-9]+)?$/ && (raw + 0) >= 1) printf "%d", int(raw + 0)
    }')
    if [ -z "$CUSTOM_MAX" ]; then
      echo "supervisor: custom mode requires a positive numeric AUTOPROMPT_MAX_CONCURRENT" >&2
      exit 2
    fi
    AUTOPROMPT_MAX_CONCURRENT="$CUSTOM_MAX"
    export AUTOPROMPT_MAX_CONCURRENT
    FANOUT="up to $CUSTOM_MAX live per wave (AUTOPROMPT_MAX_CONCURRENT)"
    L3_TRACKS="parallel"
    ;;
  *) AUTOPROMPT_MODE="tokensaver"; FANOUT="up to 6 live per wave"; L3_TRACKS="parallel" ;;
esac
# EDIT 23: per-conversation session token, defaulted here for `set -u` safety. The
# supervisor is the durable producer across relaunches of one conversation: it seeds
# this token (env > file > empty) before the loop and HARVESTs the resolver-minted
# marker token after each launch, re-exporting the SAME token so a 2nd prompt lands
# in the SAME session_NN (SPEC-1 S2). RESUME is always same-session regardless.
AUTOPROMPT_SESSION_TOKEN="${AUTOPROMPT_SESSION_TOKEN:-}"
INITIAL_RESUME="${AUTOPROMPT_RESUME:-}"
case "$(printf '%s' "$INITIAL_RESUME" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes) INITIAL_RESUME=1 ;;
  *) INITIAL_RESUME=0 ;;
esac
SCOPE_MISSION_BINDING="unbound"
RUN_NONCE="${AUTOPROMPT_RUN_NONCE:-}"
LEGACY_SENTINEL="${AUTOPROMPT_LEGACY_SENTINEL:-0}"
SCOPE_BUDGET_TERMINAL=0
DRY_RUN=0
MISSION=""

require_flag_value() {
  [ "$2" -ge 2 ] && return 0
  echo "supervisor: $1 requires a value" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --launcher) require_flag_value "$1" "$#"; LAUNCHER="$2"; shift 2 ;;
    --cmd) require_flag_value "$1" "$#"; LAUNCH_CMD="$2"; shift 2 ;;
    --agents) require_flag_value "$1" "$#"; AGENTS_SELECTOR="$2"; shift 2 ;;
    --model-registry) require_flag_value "$1" "$#"; MODEL_REGISTRY="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --ledger-dir) require_flag_value "$1" "$#"; LEDGER_DIR="$2"; shift 2 ;;
    --) shift; MISSION="$*"; break ;;
    -*) echo "supervisor: unknown flag $1" >&2; exit 2 ;;
    *) MISSION="$1"; shift ;;
  esac
done

if command -v node >/dev/null 2>&1; then
  SCOPE_MISSION_BINDING=$(printf '%s' "$MISSION" | node -e '
const crypto = require("crypto")
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => { input += chunk })
process.stdin.on("end", () => process.stdout.write("sha256:" + crypto.createHash("sha256").update(input, "utf8").digest("hex")))
' 2>/dev/null || echo unbound)
fi

if [ "$LEGACY_SENTINEL" != "1" ]; then
  case "$RUN_NONCE" in
    NONCE-[A-Za-z0-9_-]*) ;;
    "")
      if command -v node >/dev/null 2>&1; then
        RUN_NONCE="NONCE-$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))' 2>/dev/null || true)"
      fi
      case "$RUN_NONCE" in
        NONCE-[A-Za-z0-9_-]*) ;;
        *) echo "supervisor: could not mint a cryptographically strong activation nonce" >&2; exit 2 ;;
      esac
      ;;
    *) echo "supervisor: AUTOPROMPT_RUN_NONCE is malformed" >&2; exit 2 ;;
  esac
fi

# Sentinel matching has two modes. DEFAULT (SENTINEL unset -- every real run):
# the glob is "$LEDGER_DIR"/DONE-* iterated with the DIR QUOTED and only the *
# unquoted, so a LEDGER_DIR containing spaces (a Windows path) still matches its
# own DONE-* sentinel. EXPLICIT (SENTINEL set): the value is word-split into one
# or more shell globs -- an intentional multi-pattern escape hatch -- so no single
# path in it may contain spaces. SENTINEL_SET records which mode is active; the
# unquoted word-split is confined to the explicit case where the user opted in.
if [ -n "${SENTINEL:-}" ]; then
  SENTINEL_SET=1
  SENTINEL_GLOB="$SENTINEL"
else
  SENTINEL_SET=0
  SENTINEL_GLOB="$LEDGER_DIR/DONE-*"   # reference/logging only; never iterated unquoted
fi
ESCALATE_FILE="$LEDGER_DIR/SUPERVISOR-ESCALATE"
SNAPSHOT_FILE="$LEDGER_DIR/.sentinel-snapshot"
# EDIT 23: the durable session-token store, under the ledger dir so it survives across
# relaunches of one conversation. Seeded before the loop, harvested after each launch.
SESSION_TOKEN_FILE="$LEDGER_DIR/.session-token"
# PLAN-auto-compact-threshold path vars. Discovery is CWD-AGNOSTIC and slug-free: it
# matches the supervisor's own RUN_CWD (POSIX on gitbash) against each transcript's
# embedded OS-native "cwd" after normalization -- NO slug derivation, NO launcher edit.
RUN_CWD="${RUN_CWD:-$PWD}"                              # run cwd; matched against each transcript's embedded "cwd"
PARENT_TRANSCRIPT="${AUTOPROMPT_PARENT_TRANSCRIPT:-}"  # OPTIONAL explicit override of the parent .jsonl path
WATERMARK_FILE="$LEDGER_DIR/.context-watermark"        # FALLBACK: parent-emitted watermark (only when transcript unreadable)
COMPACT_REQUEST_FILE="$LEDGER_DIR/COMPACT-REQUEST"
COMPACT_STATE_FILE="$LEDGER_DIR/.compaction-state"     # holds: last_compact_epoch + last seen estimate (for cooldown + drop-detection)
# F-SPEED steer-2 B3 scope-phase state files (under the ledger dir, durable across
# relaunches). SCOPE_PHASE_START holds the scope-entry epoch so elapsed = now - start
# and does NOT reset on frontier growth; SCOPE_RESETS_FILE counts budget-forced resets
# (cleared on scope-exit so a fresh mission starts at 0).
SCOPE_PHASE_START_FILE="$LEDGER_DIR/.scope-phase-start"
SCOPE_RESETS_FILE="$LEDGER_DIR/.scope-forced-resets"
SNAPSHOT_OK=0
mkdir -p "$LEDGER_DIR" 2>/dev/null || true

# Supervisor start epoch (captured BEFORE the first launch). It is no longer part
# of the stale-sentinel guarantee (see below) -- it is kept only to name the
# quarantine target (superseded-<epoch>-...) and is read fail-safe: if `date +%s`
# fails we leave it EMPTY (not 0), so the quarantine name degrades to
# superseded-unknown-... rather than colliding on a fixed "0".
SUPERVISOR_START_EPOCH=$(date +%s 2>/dev/null || echo)

# THE stale-sentinel guarantee is a STARTUP SNAPSHOT, not mtime. Before the first
# launch we record every pre-existing DONE-* PATH into $SNAPSHOT_FILE.
# sentinel_present then REFUSES any DONE-* whose path is still in that snapshot --
# regardless of mtime. THE LIVE INVARIANT: a path stays in the snapshot IFF its
# stale occupant still physically exists. Quarantine renames each pre-existing
# done:true sentinel aside; on a SUCCESSFUL rename the path is now empty, so it is
# PRUNED from the snapshot -- the only thing that can later appear there is a
# genuinely fresh this-run sentinel, which must be honored (otherwise the
# same-activation DONE-<nonce> - the supervisor-minted CSPRNG nonce re-exported
# unchanged to every relaunched child, with NO clock - would be vetoed forever
# and the supervisor would relaunch without end --
# the livelock). A path whose rename FAILED is NOT pruned: its stale occupant is
# still there, so it stays vetoed and a failed quarantine degrades to RELAUNCH,
# never a false halt. The mtime `>=start` belt is gone -- it could not backstop
# the same-second class, which is the whole reason this defense exists. FAIL-SAFE:
# if the snapshot cannot be written or read, ALL DONE-* are treated as suspect ->
# relaunch, never halt.

log() { echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S' 2>/dev/null)] $*"; }

CAPABILITY_PROVIDER="codex"
CAPABILITY_CLI_VERSION="unknown"
CAPABILITY_PERMISSION_PROFILE="${AUTOPROMPT_PERMISSION_PROFILE:-default}"
CAPABILITY_AGENT_DEFINITIONS_HASH="unknown"
CAPABILITY_CASTING_HASH="unknown"
CAPABILITY_EFFORT_STATUS="unknown"
CAPABILITY_EFFORT_SOURCE="unverified"
CODEX_CASTING_JSON=""
AUTOPROMPT_CAPABILITY_ATTESTATION="${AUTOPROMPT_CAPABILITY_ATTESTATION:-}"

casting_json_field() {
  field="$1"
  printf '%s' "$CODEX_CASTING_JSON" | node -e '
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => { input += chunk })
process.stdin.on("end", () => {
  let value = JSON.parse(input)
  for (const key of process.argv[1].split(".")) value = value == null ? undefined : value[key]
  if (value != null) process.stdout.write(String(value))
})
' "$field"
}

resolve_codex_casting() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  command -v node >/dev/null 2>&1 || {
    echo "supervisor: Codex capability binding requires node on PATH" >&2
    return 2
  }
  [ -r "$CODEX_CASTING_PATH" ] || {
    echo "supervisor: Codex casting validator is not readable: $CODEX_CASTING_PATH" >&2
    return 2
  }
  set -- "$CODEX_CASTING_PATH" --resolve --agents-dir "$CODEX_AGENTS_PATH" --selector "$AGENTS_SELECTOR"
  if [ -n "$MODEL_REGISTRY" ]; then set -- "$@" --registry "$MODEL_REGISTRY"; fi
  CODEX_CASTING_JSON=$(node "$@") || return 2
  CAPABILITY_AGENT_DEFINITIONS_HASH=$(casting_json_field agentDefinitionsHash) || return 2
  CAPABILITY_CASTING_HASH=$(casting_json_field castingHash) || return 2
  CAPABILITY_EFFORT_STATUS=$(casting_json_field effort.status) || return 2
  CAPABILITY_EFFORT_SOURCE=$(casting_json_field effort.source) || return 2
}

verify_codex_profile() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  [ -r "$CODEX_PROFILE_TOOL" ] || {
    echo "supervisor: Codex profile validator is not readable: $CODEX_PROFILE_TOOL" >&2
    return 2
  }
  node "$CODEX_PROFILE_TOOL" --verify --agents-dir "$CODEX_AGENTS_PATH" \
    --profile "$CODEX_PROFILE_PATH" --workspace "$PWD" >/dev/null || return 2
}

reject_profile_conflict() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  case " $LAUNCH_CMD " in
    *" --profile "*|*" -p "*)
      echo "supervisor: launch command must not select a profile; Autoprompt owns --profile $CODEX_PROFILE_NAME" >&2
      return 2
      ;;
  esac
}

resolve_capability_binding() {
  supplied_attestation="$AUTOPROMPT_CAPABILITY_ATTESTATION"
  AUTOPROMPT_CAPABILITY_ATTESTATION=""
  [ "$DRY_RUN" -eq 1 ] && return 0
  cli_cmd="${LAUNCH_CMD%% *}"
  [ -n "$cli_cmd" ] || cli_cmd="$LAUNCHER"
  if [ -n "${AUTOPROMPT_CLI_VERSION:-}" ]; then
    CAPABILITY_CLI_VERSION="$AUTOPROMPT_CLI_VERSION"
  elif [ -n "$cli_cmd" ] && command -v "$cli_cmd" >/dev/null 2>&1; then
    CAPABILITY_CLI_VERSION=$($cli_cmd --version 2>/dev/null | head -n1 || true)
  fi
  [ -n "$CAPABILITY_CLI_VERSION" ] || CAPABILITY_CLI_VERSION="unknown"
  [ "$CAPABILITY_CLI_VERSION" != "unknown" ] || return 0
  [ -n "$supplied_attestation" ] || return 0
  AUTOPROMPT_CAPABILITY_ATTESTATION=$(node -e '
const crypto = require("crypto")
const raw = process.argv[1]
const expected = process.argv.slice(2)
let attestation
try { attestation = JSON.parse(raw) } catch { process.exit(1) }
const bindings = [
  "provider", "cliVersion", "permissionProfile", "agentSelector",
  "agentDefinitionsHash", "castingHash", "effortStatus", "effortSource",
]
const proofBytesOk = typeof attestation.proofBytes === "string" &&
  attestation.proofBytes !== "" && attestation.proofBytes.length <= 4096
const proofOk = proofBytesOk &&
  "sha256:" + crypto.createHash("sha256").update(attestation.proofBytes, "utf8").digest("hex") === attestation.proofHash
const valid = attestation && attestation.schemaVersion === 4 &&
  attestation.run === true && attestation.read === true && attestation.write === true &&
  attestation.proofKind === "disposable-scratch" &&
  typeof attestation.proofHash === "string" && /^sha256:[a-f0-9]{64}$/.test(attestation.proofHash) &&
  proofOk &&
  bindings.every((field, index) => attestation[field] === expected[index])
if (!valid) process.exit(1)
process.stdout.write(JSON.stringify(attestation))
' "$supplied_attestation" "$CAPABILITY_PROVIDER" "$CAPABILITY_CLI_VERSION" \
  "$CAPABILITY_PERMISSION_PROFILE" "$AGENTS_SELECTOR" "$CAPABILITY_AGENT_DEFINITIONS_HASH" \
  "$CAPABILITY_CASTING_HASH" "$CAPABILITY_EFFORT_STATUS" "$CAPABILITY_EFFORT_SOURCE" 2>/dev/null) || {
    AUTOPROMPT_CAPABILITY_ATTESTATION=""
    return 0
  }
}

# Take the startup snapshot of pre-existing DONE-* PATHS, BEFORE the first launch
# and BEFORE any sentinel check or quarantine. Each path is written on its own
# line to $SNAPSHOT_FILE. SNAPSHOT_OK=1 marks a trustworthy snapshot; if writing
# fails we leave it 0, and sentinel_present then treats EVERY DONE-* as suspect
# (relaunch), the fail-safe direction. The snapshot is the authoritative record
# of "what was already here", so it is taken from the live glob exactly once.
snapshot_pre_existing_sentinels() {
  SNAPSHOT_OK=0
  # `:` is a POSIX SPECIAL builtin: under dash a redirection error on it aborts
  # the whole non-interactive shell BEFORE `|| return` can run (bash only
  # returns). Wrapping it in a subshell isolates the abort to the subshell, so
  # an unwritable snapshot file degrades to RELAUNCH (fail-safe) under dash too.
  ( : > "$SNAPSHOT_FILE" ) 2>/dev/null || return
  if [ "$SENTINEL_SET" -eq 1 ]; then set -- $SENTINEL_GLOB; else set -- "$LEDGER_DIR"/DONE-*; fi
  for f in "$@"; do
    [ -e "$f" ] || continue
    printf '%s\n' "$f" >> "$SNAPSHOT_FILE" 2>/dev/null || return
  done
  SNAPSHOT_OK=1
}

# Is $1 one of the paths recorded in the startup snapshot? Exact whole-line match.
# If the snapshot is not trustworthy (SNAPSHOT_OK=0) we answer YES for every path
# -> every DONE-* is treated as pre-existing -> never halts -> relaunch. That is
# the deliberate fail-safe: a missing/unreadable snapshot must never permit a halt.
path_in_snapshot() {
  [ "$SNAPSHOT_OK" -eq 1 ] 2>/dev/null || return 0
  # If the snapshot file became unreadable/removed after SNAPSHOT_OK was set, the
  # read loop below would never run and we would fall through to `return 1` (= not
  # snapshotted = halt ALLOWED) -- fail-OPEN. The header contract says a snapshot
  # that cannot be READ makes every path suspect, so veto here too (return 0).
  [ -r "$SNAPSHOT_FILE" ] || return 0
  while IFS= read -r line; do
    [ "$line" = "$1" ] && return 0
  done < "$SNAPSHOT_FILE" 2>/dev/null
  return 1
}

# Drop one path from the live snapshot (in $SNAPSHOT_FILE) so a genuinely-fresh
# sentinel can later reclaim it. Called by quarantine ONLY after a SUCCESSFUL
# rename: once the stale occupant has been moved aside, the path is empty, so the
# ONLY thing that can appear there is a fresh sentinel written by THIS run. The
# activation nonce is minted once (CSPRNG) and re-exported unchanged to every
# relaunched child (no clock), so a re-launch of the SAME activation writes the
# SAME path the snapshot recorded -- if
# the snapshot kept vetoing it, that fresh sentinel would be refused forever and
# the supervisor would relaunch without end (the livelock). Rewrite is atomic via
# a temp file. If the rewrite itself fails we KEEP the path (over-veto = relaunch,
# never a false halt) -- the safe direction. A path whose rename FAILED is never
# pruned, so it stays vetoed while its stale occupant still physically exists.
prune_path_from_snapshot() {
  [ "$SNAPSHOT_OK" -eq 1 ] 2>/dev/null || return 0
  pruned="$SNAPSHOT_FILE.prune"
  ( : > "$pruned" ) 2>/dev/null || return 0
  while IFS= read -r line; do
    [ "$line" = "$1" ] && continue
    printf '%s\n' "$line" >> "$pruned" 2>/dev/null || { rm -f "$pruned" 2>/dev/null; return 0; }
  done < "$SNAPSHOT_FILE" 2>/dev/null
  mv "$pruned" "$SNAPSHOT_FILE" 2>/dev/null || rm -f "$pruned" 2>/dev/null
}

sentinel_json_matches() {
  file="$1"
  expected_nonce="$2"
  node -e '
const fs = require("fs")
let value
try { value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) }
catch { process.exit(1) }
process.exit(value && value.done === true && value.nonce === process.argv[2] ? 0 : 1)
' "$file" "$expected_nonce" >/dev/null 2>&1
}

sentinel_present() {
  if [ "$LEGACY_SENTINEL" != "1" ]; then
    f="$LEDGER_DIR/DONE-$RUN_NONCE"
    [ -f "$f" ] || return 1
    path_in_snapshot "$f" && return 1
    sentinel_json_matches "$f" "$RUN_NONCE"
    return $?
  fi
  if [ "$SENTINEL_SET" -eq 1 ]; then set -- $SENTINEL_GLOB; else set -- "$LEDGER_DIR"/DONE-*; fi
  for f in "$@"; do
    [ -f "$f" ] || continue
    grep -q '"done"[[:space:]]*:[[:space:]]*true' "$f" 2>/dev/null || continue
    path_in_snapshot "$f" && continue
    return 0
  done
  return 1
}

# At startup, BEFORE the first launch, QUARANTINE every pre-existing done:true
# DONE-* sentinel: rename it aside to <dir>/superseded-<start-epoch>-<name> so the
# new name no longer starts with DONE- and thus no longer matches the live DONE-*
# glob -- it cannot halt this fresh mission. (Prefixing, NOT suffixing: a
# DONE-X.superseded-N name would STILL match DONE-* and re-trip the same-second
# halt, so the leading DONE- must be displaced.) This is the PRIMARY fix for the
# whole stale-sentinel class -- after quarantine there is no leftover sentinel
# left to race, so a same-second / zero-epoch / sub-second mtime collision is
# moot. We RENAME, never delete (deleting artifacts is the JANITOR's job; never
# silently rm operator files) and log a loud line naming each quarantined file.
# On a SUCCESSFUL rename the path is pruned from the live snapshot so a genuine
# fresh same-activation DONE-<nonce> (the minted nonce is re-exported to every
# relaunched child, no clock) can reclaim it -- else the snapshot would veto that
# fresh sentinel forever and the supervisor would relaunch without end (livelock).
# If a rename FAILS (read-only dir / permissions / clobber) the leftover DONE-*
# still matches the live glob, its path is NOT pruned, and sentinel_present
# unconditionally refuses it. A failed rename degrades to RELAUNCH, never a halt.
# Net invariant: the snapshot vetoes a path IFF its stale occupant still exists.
quarantine_stale_sentinels() {
  if [ "$SENTINEL_SET" -eq 1 ]; then set -- $SENTINEL_GLOB; else set -- "$LEDGER_DIR"/DONE-*; fi
  for f in "$@"; do
    [ -f "$f" ] || continue
    if grep -q '"done"[[:space:]]*:[[:space:]]*true' "$f" 2>/dev/null; then
      dir=$(dirname "$f"); base=$(basename "$f")
      quarantined="$dir/superseded-${SUPERVISOR_START_EPOCH:-unknown}-$base"
      if mv "$f" "$quarantined" 2>/dev/null; then
        # The stale occupant is gone, so this path can no longer hold anything
        # but a FRESH this-run sentinel. Drop it from the live snapshot so the
        # same-activation DONE-<nonce> is reclaimable -- otherwise the
        # snapshot would veto the genuine fresh sentinel forever (the livelock).
        prune_path_from_snapshot "$f"
        log "QUARANTINE: pre-existing DONE-sentinel '$f' (from a prior run) renamed to '$quarantined' so it cannot halt this fresh mission. It is preserved, not deleted."
      else
        log "WARNING: could not quarantine pre-existing DONE-sentinel '$f' -- it is IGNORED for halting by the startup snapshot and will not stop this mission. Remove it if it is no longer relevant."
      fi
    fi
  done
}

# The frontier marker: how much forward progress exists on disk. It is a
# MONOTONIC progress counter, not a success counter - it counts EVERY gate
# artifact across the whole lifecycle (intake, scope/roadmap, plan draft/review/
# fresh-verify, plan-final, impl, impl-review, verify, signoff, sweep-round,
# arbiter, goal-check). Versioned (-vN), per-feature (Fx-), retained roadmap-scout,
# legacy scope-angle, and per-round (sweep-round-N) artifacts MULTIPLY as work
# proceeds, so a run that is genuinely advancing - even one crash-looping through
# the memory-heavy pre-build SCOPE phase, which writes roadmap/scout evidence
# long before the first plan-final - bumps the count every relaunch and resets
# the poison window. A run that relaunches writing NOTHING new keeps the count
# flat and still trips poison. Counting only plan-final/verify (the old globs)
# pinned the count at 0 for that whole early phase and KILLED healthy runs.
frontier_count() {
  if [ "$DRY_RUN" -eq 1 ]; then
    # In dry-run, a poison fake never advances; a healthy fake bumps a counter file.
    if [ "${FAKE_POISON:-0}" = "1" ]; then echo 0; return; fi
    if [ -f "$LEDGER_DIR/.fake-frontier" ]; then cat "$LEDGER_DIR/.fake-frontier"; else echo 0; fi
    return
  fi
  count=0
  # Three artifact layouts must ALL be counted, or a run driven by one of them is
  # invisible to the frontier and a healthy-long run trips POISON:
  #   prose/agent (SKILL.md/GATES.md): autoprompt/prompt-NNN-<slug>/artifacts/
  #   harness (autoprompt-gate.js ARTIFACT_DIR): autoprompt/.artifacts/<run-tag>/
  #   session ledger (SPEC-1 SCRIBE): autoprompt/session_NN/prompt_NN-<slug>/ and
  #     its optional artifacts/ subdir. The per-prompt ledger .md files (BRIEF/
  #     GATELOG/COVERAGE...) count as forward progress (monotonic; same rationale as
  #     the multiplying-artifacts globs), so a run advancing ONLY in the new layout
  #     is never falsely poisoned.
  # The leading-dot harness dir is NOT matched by "*" (POSIX glob skips dotfiles),
  # and its nesting differs, so it needs its own glob - which also stops the prose
  # glob from double-counting it. Ledger-root prose files (BRIEF/PLAN/GATELOG...)
  # live ONE level above artifacts/ so they are not counted by the first two globs;
  # the session-ledger glob counts them at their nested depth. The DONE sentinel
  # lives at the ledger root, not under any artifacts/ dir. Plain shell `for` over an
  # unmatched glob leaves the literal pattern (nullglob off); `[ -f ]` filters it.
  for f in "$LEDGER_DIR"/*/artifacts/*.md \
           "$LEDGER_DIR"/.artifacts/*/*.md \
           "$LEDGER_DIR"/session_*/prompt_*/artifacts/*.md \
           "$LEDGER_DIR"/session_*/prompt_*/*.md; do
    [ -f "$f" ] && count=$((count + 1))
  done
  echo "$count"
}

# === F-SPEED steer-2 B3: PHASE WALL-CLOCK BUDGET for the SCOPE phase =================
# The scope phase may keep writing roadmap/scout evidence, so IDLE_TIMEOUT - which
# resets on any artifact write - cannot bound it. These helpers enforce a wall-clock
# budget anchored to scope entry and never reset by frontier growth.

# The durable pre-execution clock starts before the roadmap author and remains active
# through every plan/review/fresh-verify revision. Only real G4 implementation evidence
# proves execution started; planning artifacts are never execution progress.
scope_phase_elapsed() {
  if [ "$DRY_RUN" -eq 1 ]; then
    [ -n "${FAKE_SCOPE_ELAPSED:-}" ] && echo "$FAKE_SCOPE_ELAPSED"
    return
  fi
  for f in "$LEDGER_DIR"/.artifacts/*/*-impl-v*.md \
           "$LEDGER_DIR"/*/artifacts/*-impl-v*.md \
           "$LEDGER_DIR"/session_*/prompt_*/artifacts/*-impl-v*.md; do
    [ -f "$f" ] && {
      rm -f "$SCOPE_PHASE_START_FILE" "$SCOPE_RESETS_FILE" \
        "$LEDGER_DIR/SCOPE-CONVERGE-REQUEST" \
        "$LEDGER_DIR/SCOPE-BUDGET-BREACH" 2>/dev/null
      return
    }
  done
  now_s=$(date +%s 2>/dev/null || echo 0)
  # Seed the scope-entry epoch ONCE, then read it back - so elapsed does NOT reset on
  # frontier growth (the whole point vs IDLE_TIMEOUT). A missing/corrupt start file
  # re-seeds to now (worst case: the budget clock restarts, never a false breach).
  start_s=""
  stored_binding=""
  if [ -r "$SCOPE_PHASE_START_FILE" ]; then
    start_s=$(awk 'NR==1{print $1; exit}' "$SCOPE_PHASE_START_FILE" 2>/dev/null || echo)
    stored_binding=$(awk 'NR==1{print $2; exit}' "$SCOPE_PHASE_START_FILE" 2>/dev/null || echo)
  fi
  case "$start_s" in (*[!0-9]*|"") start_s="" ;; esac
  if [ "$stored_binding" != "$SCOPE_MISSION_BINDING" ]; then
    start_s=""
    rm -f "$LEDGER_DIR/SCOPE-CONVERGE-REQUEST" \
      "$LEDGER_DIR/SCOPE-BUDGET-BREACH" "$SCOPE_RESETS_FILE" 2>/dev/null
  fi
  if [ -z "$start_s" ] || [ "$start_s" -le 0 ] 2>/dev/null; then
    start_s="$now_s"
    printf '%s %s\n' "$start_s" "$SCOPE_MISSION_BINDING" \
      > "$SCOPE_PHASE_START_FILE.tmp" 2>/dev/null \
      && mv "$SCOPE_PHASE_START_FILE.tmp" "$SCOPE_PHASE_START_FILE" 2>/dev/null
  fi
  el=$((now_s - start_s))
  [ "$el" -lt 0 ] 2>/dev/null && el=0
  echo "$el"
}

# The honest retained-scout residual: distinct roadmap-scout keys plus readable legacy
# scope keys present on disk. The supervisor reports only evidence that actually landed.
scope_landed_angles() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "${FAKE_SCOPE_LANDED:-}"
    return
  fi
  keys=""
  for f in "$LEDGER_DIR"/.artifacts/*/roadmap-scout-*.md \
           "$LEDGER_DIR"/*/artifacts/roadmap-scout-*.md \
           "$LEDGER_DIR"/session_*/prompt_*/artifacts/roadmap-scout-*.md \
           "$LEDGER_DIR"/.artifacts/*/scope-*.md \
           "$LEDGER_DIR"/*/artifacts/scope-*.md \
           "$LEDGER_DIR"/session_*/prompt_*/artifacts/scope-*.md; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    case "$base" in
      roadmap-scout-*.md) key=$(printf '%s' "$base" | sed -e 's/\.md$//') ;;
      *) key=$(printf '%s' "$base" | sed -e 's/^scope-//' -e 's/-v[0-9]*\.md$//' -e 's/\.md$//') ;;
    esac
    [ -n "$key" ] || continue
    case " $keys " in (*" $key "*) ;; (*) keys="$keys $key" ;; esac
  done
  printf '%s' "$keys" | sed -e 's/^ *//' -e 's/ *$//' -e 's/  */,/g'
}

# Age (seconds) of the pending SCOPE-CONVERGE-REQUEST, or 0 when none exists.
scope_converge_request_age() {
  req="$LEDGER_DIR/SCOPE-CONVERGE-REQUEST"
  [ -r "$req" ] || { echo 0; return; }
  now_s=$(date +%s 2>/dev/null || echo 0)
  req_ts=$(awk 'NR==1{print $1+0; exit}' "$req" 2>/dev/null || echo 0)
  case "$req_ts" in (*[!0-9]*|"") req_ts=0 ;; esac
  age=$((now_s - req_ts))
  [ "$age" -lt 0 ] 2>/dev/null && age=0
  echo "$age"
}

# === PLAN-auto-compact-threshold: proactive supervisor-fired compaction ============
# The supervisor cannot introspect the live CLI's RAM, and the parent cannot /compact
# itself. So the supervisor OBSERVES the parent's context size from disk (the parent's
# own session transcript; watermark/ledger-byte fallbacks) and, on crossing COMPACT_AT,
# writes COMPACT-REQUEST then -- on grace timeout -- fires a process-group kill so the
# outer relaunch loop RESUMEs a fresh, smaller context that re-reads ANCHOR.md.
# IDENTICAL behavior to agents/claude/workflow/supervisor.sh (the slug-free discovery rule must
# not diverge between the two ports).

# Canonicalize a path for cross-platform cwd comparison (win32/gitbash AND posix):
# lowercase; collapse \ and / runs to a single /; map a leading "<drive>:" to "/<drive>".
canon_path() {  # $1 = raw path ; echoes canonical form
  printf '%s' "$1" \
    | tr 'A-Z\\' 'a-z/' \
    | sed -e 's#//*#/#g' -e 's#^\([a-z]\):#/\1#'
}

# Find the live parent session .jsonl. Slug-free: matches RUN_CWD against each
# transcript's embedded "cwd" after canonicalization. Single-level glob excludes nested
# subagent/tool-result transcripts. Echoes the newest cwd-matching transcript path.
find_parent_transcript() {  # $1 = child_launch_epoch
  if [ -n "$PARENT_TRANSCRIPT" ] && [ -r "$PARENT_TRANSCRIPT" ]; then echo "$PARENT_TRANSCRIPT"; return; fi
  cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  want=$(canon_path "$RUN_CWD")
  newest=""; newest_mt=0
  for f in "$cfg"/projects/*/*.jsonl; do
    [ -f "$f" ] || continue
    mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
    [ "$mt" -lt "${1:-0}" ] 2>/dev/null && continue
    tcwd=$(grep -o '"cwd":"[^"]*"' "$f" 2>/dev/null | head -n1 | sed 's/.*"cwd":"//; s/"$//')
    [ -n "$tcwd" ] || continue
    tcwd=$(printf '%s' "$tcwd" | sed 's/\\\\/\\/g')
    [ "$(canon_path "$tcwd")" = "$want" ] || continue
    [ "$mt" -gt "$newest_mt" ] 2>/dev/null && { newest="$f"; newest_mt=$mt; }
  done
  [ -n "$newest" ] && echo "$newest"
}

# Read the PARENT's context size in three tiers; echoes an integer (0 = unavailable).
# TIER 1 parse transcript usage (byte proxy of THAT .jsonl on parse failure); TIER 2
# parent watermark (stale-rejected); TIER 3 coarse ledger-byte proxy. Honors
# FAKE_WATERMARK in dry-run.
read_context_estimate() {  # $1 = child_launch_epoch (for staleness)
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -n "${FAKE_WATERMARK:-}" ]; then echo "$FAKE_WATERMARK"; else echo 0; fi
    return
  fi
  tx=$(find_parent_transcript "${1:-0}")
  if [ -n "$tx" ] && [ -r "$tx" ]; then
    if command -v jq >/dev/null 2>&1; then
      est=$(jq -r 'select(.message.usage) | .message.usage
                   | ((.input_tokens//0)+(.cache_read_input_tokens//0)+(.cache_creation_input_tokens//0))' \
               "$tx" 2>/dev/null | awk 'NF{v=$1} END{if(v!="")print v}')
    else
      est=$(grep -o '"usage":[^}]*}' "$tx" 2>/dev/null | tail -n1 \
            | grep -oE '"(input_tokens|cache_read_input_tokens|cache_creation_input_tokens)":[0-9]+' \
            | awk -F: '{s+=$2} END{if(s>0)print s}')
    fi
    case "$est" in (*[0-9]*) [ "$est" -gt 0 ] 2>/dev/null && { echo "$est"; return; } ;; esac
    sz=$(wc -c < "$tx" 2>/dev/null || echo 0)
    [ "$sz" -gt 0 ] 2>/dev/null && { echo $((sz / BYTES_PER_TOKEN)); return; }
  fi
  if [ -r "$WATERMARK_FILE" ]; then
    wm_tok=$(awk 'NR==1{print $1; exit}' "$WATERMARK_FILE" 2>/dev/null || echo)
    wm_ts=$(awk 'NR==1{print $2; exit}'  "$WATERMARK_FILE" 2>/dev/null || echo)
    case "$wm_tok" in (*[0-9]*) ;; (*) wm_tok="" ;; esac
    if [ -n "$wm_tok" ] && { [ -z "$wm_ts" ] || [ "${wm_ts:-0}" -ge "${1:-0}" ] 2>/dev/null; }; then
      echo "$wm_tok"; return
    fi
  fi
  bytes=0
  for f in "$LEDGER_DIR"/session_*/prompt_*/*.md "$LEDGER_DIR"/session_*/prompt_*/artifacts/*.md "$LEDGER_DIR"/*/artifacts/*.md; do
    [ -f "$f" ] || continue
    sz=$(wc -c < "$f" 2>/dev/null || echo 0); bytes=$((bytes + sz))
  done
  echo $((bytes / BYTES_PER_TOKEN))
}

# Detect a harness-fired compaction (sharp estimate DROP across ticks): arm the cooldown
# and clear any pending request so the supervisor does NOT double-fire. $1=now $2=est.
note_external_compaction() {  # $1=now $2=current_est
  prev_est=0
  [ -r "$COMPACT_STATE_FILE" ] && prev_est=$(awk 'NR==1{print $2+0; exit}' "$COMPACT_STATE_FILE" 2>/dev/null || echo 0)
  if [ "${prev_est:-0}" -gt 0 ] 2>/dev/null \
     && [ $(( prev_est - ${2:-0} )) -ge "$EXTERNAL_COMPACT_DELTA" ] 2>/dev/null; then
    printf '%s %s external_compaction\n' "$1" "${2:-0}" > "$COMPACT_STATE_FILE.tmp" 2>/dev/null \
      && mv "$COMPACT_STATE_FILE.tmp" "$COMPACT_STATE_FILE" 2>/dev/null
    rm -f "$COMPACT_REQUEST_FILE" 2>/dev/null || true
    log "EXTERNAL COMPACTION detected: context estimate dropped ${prev_est}->${2:-0} (>=${EXTERNAL_COMPACT_DELTA}) - arming cooldown and clearing any pending COMPACT-REQUEST (no double-fire)."
    return 0
  fi
  last_compact=0; [ -r "$COMPACT_STATE_FILE" ] && last_compact=$(awk 'NR==1{print $1+0; exit}' "$COMPACT_STATE_FILE" 2>/dev/null || echo 0)
  printf '%s %s\n' "$last_compact" "${2:-0}" > "$COMPACT_STATE_FILE.tmp" 2>/dev/null \
    && mv "$COMPACT_STATE_FILE.tmp" "$COMPACT_STATE_FILE" 2>/dev/null
  return 1
}

# Decide whether to request/force a compaction. Sets COMPACT_FORCE=1 when a written
# request has gone unhonored past COMPACT_GRACE. Returns 0 when the caller should act.
maybe_request_compaction() {  # $1=child_launch_epoch $2=now
  COMPACT_FORCE=0
  est=$(read_context_estimate "$1")
  note_external_compaction "$2" "$est" && return 1
  last_compact=0; [ -r "$COMPACT_STATE_FILE" ] && last_compact=$(awk 'NR==1{print $1+0; exit}' "$COMPACT_STATE_FILE" 2>/dev/null || echo 0)
  if [ "${last_compact:-0}" -gt 0 ] 2>/dev/null && [ $(( $2 - last_compact )) -lt "$COMPACT_COOLDOWN" ] 2>/dev/null; then
    return 1
  fi
  if [ -f "$COMPACT_REQUEST_FILE" ]; then
    req_ts=$(awk 'NR==1{print $1+0; exit}' "$COMPACT_REQUEST_FILE" 2>/dev/null || echo 0)
    if [ $(( $2 - req_ts )) -ge "$COMPACT_GRACE" ] 2>/dev/null; then COMPACT_FORCE=1; return 0; fi
    return 1
  fi
  if [ "$est" -ge "$COMPACT_AT" ] 2>/dev/null; then
    printf '%s proactive est=%s threshold=%s\n' "$2" "$est" "$COMPACT_AT" > "$COMPACT_REQUEST_FILE.tmp" 2>/dev/null \
      && mv "$COMPACT_REQUEST_FILE.tmp" "$COMPACT_REQUEST_FILE" 2>/dev/null \
      && log "COMPACT-REQUEST written: context est=${est} tokens >= AUTOPROMPT_COMPACT_AT=${COMPACT_AT}. Parent will checkpoint+compact at its next gate boundary (not a wipe, not a stop)."
    return 0
  fi
  return 1
}

# Kill the child's whole process GROUP so a wedged parent leaves NO orphaned subagent.
kill_tree() {  # $1 = child pid
  pid="$1"
  [ -n "$pid" ] || return 0
  if command -v taskkill.exe >/dev/null 2>&1; then
    win_pid=$(ps -W -p "$pid" -l 2>/dev/null | awk 'NR==2{print $4; exit}')
    case "$win_pid" in (*[!0-9]*|"") win_pid="" ;; esac
    if [ -n "$win_pid" ] && taskkill.exe /T /F /PID "$win_pid" >/dev/null 2>&1; then
      return 0
    fi
  fi
  descendants=""
  pending="$pid"
  while [ -n "$pending" ]; do
    parent=${pending%% *}
    case "$pending" in (*" "*) pending=${pending#* } ;; (*) pending="" ;; esac
    children=$(ps -ef 2>/dev/null | awk -v parent="$parent" 'NR>1 && $3 == parent { print $2 }')
    for child in $children; do
      case " $descendants " in (*" $child "*) ;; (*) descendants="$child $descendants"; pending="$pending $child" ;; esac
    done
    pending=$(printf '%s' "$pending" | sed 's/^ *//')
  done
  for victim in $descendants "$pid"; do kill -TERM "$victim" 2>/dev/null || true; done
  i=0
  while [ "$i" -lt 4 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.5 2>/dev/null || sleep 1; i=$((i + 1)); done
  for victim in $descendants "$pid"; do
    kill -0 "$victim" 2>/dev/null && kill -KILL "$victim" 2>/dev/null || true
  done
}

# Run the real or fake launcher once; return its exit code.
LAUNCH_INDEX=0
run_launcher() {
  LAUNCH_INDEX=$((LAUNCH_INDEX + 1))
  child_launch_epoch=$(date +%s 2>/dev/null || echo 0)
  if [ "$DRY_RUN" -eq 0 ]; then
    stored_binding=""
    [ -r "$SCOPE_PHASE_START_FILE" ] && stored_binding=$(awk 'NR==1{print $2; exit}' "$SCOPE_PHASE_START_FILE" 2>/dev/null || echo)
    if [ "$stored_binding" != "$SCOPE_MISSION_BINDING" ]; then
      rm -f "$LEDGER_DIR/SCOPE-CONVERGE-REQUEST" \
        "$LEDGER_DIR/SCOPE-BUDGET-BREACH" "$SCOPE_RESETS_FILE" 2>/dev/null
      printf '%s %s\n' "$child_launch_epoch" "$SCOPE_MISSION_BINDING" \
        > "$SCOPE_PHASE_START_FILE.tmp" 2>/dev/null \
        && mv "$SCOPE_PHASE_START_FILE.tmp" "$SCOPE_PHASE_START_FILE" 2>/dev/null
    fi
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    # Pop the next exit code from FAKE_EXITS in the PARENT (LAUNCH_INDEX-indexed);
    # default 0 once the list is spent. The fork below exits with this code.
    set -- ${FAKE_EXITS:-0}
    idx="$LAUNCH_INDEX"
    code=0; n=0
    for c in "$@"; do n=$((n + 1)); if [ "$n" -eq "$idx" ]; then code="$c"; fi; done
    (
      # The backgrounded fake child (PLAN-idle-watchdog: background on BOTH paths so
      # the heartbeat poll loop is exercised under --dry-run). Write the sentinel,
      # advance the frontier unless poisoned, optionally STAY ALIVE (FAKE_CHILD_ALIVE)
      # so the poll loop has a real PID to watch, then exit with the popped code.
      if [ -n "${FAKE_SENTINEL_AFTER:-}" ] && [ "$idx" -ge "$FAKE_SENTINEL_AFTER" ]; then
        printf '{"done": true, "nonce": "FAKE", "verdict": "fake done", "ts": "now"}' \
          > "$LEDGER_DIR/DONE-FAKE.tmp" && mv "$LEDGER_DIR/DONE-FAKE.tmp" "$LEDGER_DIR/DONE-FAKE"
      fi
      if [ "${FAKE_POISON:-0}" != "1" ]; then
        cur=0; [ -f "$LEDGER_DIR/.fake-frontier" ] && cur=$(cat "$LEDGER_DIR/.fake-frontier")
        echo $((cur + 1)) > "$LEDGER_DIR/.fake-frontier"
      fi
      sleep "${FAKE_CHILD_ALIVE:-0}" 2>/dev/null || true
      exit "$code"
    ) &
  else
    # Launch one is fresh unless the operator explicitly invoked this supervisor as a
    # resume. Relaunches always export AUTOPROMPT_RESUME=1.
    # When LAUNCH_CMD is set it is used VERBATIM (word-split into command + args,
    # mission appended) so a fresh user can pass their real CLI; otherwise the
    # bare LAUNCHER label is exec'd as before.
    # MODEL-INHERITANCE NOTE: unlike agents/claude/workflow/supervisor.sh, this codex
    # supervisor has NO CLAUDE_CODE_SUBAGENT_MODEL neutralization - the Codex pin is
    # .codex/config.toml model= (an operator file, not an env var), so there is no
    # env to strip. See the MODEL INHERITANCE NOTE header above.
    # EDIT 23: pass the per-conversation session token to the child ONLY when the
    # supervisor holds one (env-seeded or harvested from a prior launch's marker). An
    # empty token is omitted entirely so the first SCRIBE-run resolver MINTS one; a
    # held token re-exports the SAME value so a 2nd prompt rejoins the same session_NN.
    # The token is carried as an `env VAR=value` argument, NOT a bare `VAR=value`
    # word: after `$LAUNCH_PREFIX` expands and is re-split, a bare assignment word is
    # parsed as a COMMAND NAME (not a shell assignment) and fails 127. Folding it into
    # an `env` invocation sets it correctly. Tokens are single shell words (no spaces),
    # so the SC2086 word-split of the prefix is safe.
    (
      export AUTOPROMPT_UNATTENDED=1
      if [ "$LAUNCH_INDEX" -gt 1 ] || [ "$INITIAL_RESUME" -eq 1 ]; then
        export AUTOPROMPT_RESUME=1
      else
        unset AUTOPROMPT_RESUME
      fi
      export AUTOPROMPT_MODE
      if [ "$LEGACY_SENTINEL" != "1" ]; then export AUTOPROMPT_RUN_NONCE="$RUN_NONCE"; fi
      export AUTOPROMPT_AGENTS="$AGENTS_SELECTOR"
      export AUTOPROMPT_PROVIDER="$CAPABILITY_PROVIDER"
      export AUTOPROMPT_CLI_VERSION="$CAPABILITY_CLI_VERSION"
      export AUTOPROMPT_PERMISSION_PROFILE="$CAPABILITY_PERMISSION_PROFILE"
      export AUTOPROMPT_AGENT_DEFINITIONS_HASH="$CAPABILITY_AGENT_DEFINITIONS_HASH"
      export AUTOPROMPT_CASTING_HASH="$CAPABILITY_CASTING_HASH"
      export AUTOPROMPT_EFFORT_STATUS="$CAPABILITY_EFFORT_STATUS"
      export AUTOPROMPT_EFFORT_SOURCE="$CAPABILITY_EFFORT_SOURCE"
      if [ -n "$AUTOPROMPT_SESSION_TOKEN" ]; then export AUTOPROMPT_SESSION_TOKEN; else unset AUTOPROMPT_SESSION_TOKEN; fi
      if [ -n "$AUTOPROMPT_CAPABILITY_ATTESTATION" ]; then export AUTOPROMPT_CAPABILITY_ATTESTATION; else unset AUTOPROMPT_CAPABILITY_ATTESTATION; fi
      if [ -n "$LAUNCH_CMD" ]; then
        # shellcheck disable=SC2086  # intentional word-split of the operator's verbatim command
        $LAUNCH_CMD --profile "$CODEX_PROFILE_NAME" "$MISSION"
      else
        "$LAUNCHER" --profile "$CODEX_PROFILE_NAME" "$MISSION"
      fi
    ) &
  fi
  # HEARTBEAT (PLAN-idle-watchdog): poll the backgrounded child for liveness +
  # frontier-COUNT staleness, killing it on an idle-timeout so the outer relaunch loop
  # RESUMEs it (the automatic CONTINUE). DISTINCT from the EXIT-keyed poison guard and
  # FEEDS it: a heartbeat kill that produced no count growth is a no-progress restart,
  # so a wedged child still trips POISON after MAX_RESTARTS (anti-thrash). The poll wakes
  # on a RESPONSIVE 1s slice so a fast-exiting child is detected promptly; the staleness
  # evaluation runs once per HEARTBEAT_INTERVAL of elapsed wall-clock. `date +%s` is used
  # ONLY for elapsed time (its `|| echo 0` can at worst DELAY, never fabricate, a timeout);
  # the progress decision is purely the integer frontier-count delta (no mtime probe).
  child_pid=$!
  last_progress=$(date +%s 2>/dev/null || echo 0)
  last_seen_count=$(frontier_count)
  poll_slice="$HEARTBEAT_INTERVAL"; [ "$poll_slice" -gt 1 ] 2>/dev/null && poll_slice=1
  last_eval="$last_progress"
  while kill -0 "$child_pid" 2>/dev/null; do
    sleep "$poll_slice" 2>/dev/null || true
    sentinel_present && break
    now=$(date +%s 2>/dev/null || echo 0)
    [ $((now - last_eval)) -ge "$HEARTBEAT_INTERVAL" ] || continue
    last_eval="$now"
    cur_count=$(frontier_count)
    if [ "$cur_count" -gt "$last_seen_count" ]; then
      last_seen_count="$cur_count"; last_progress="$now"
    elif [ $((now - last_progress)) -ge "$IDLE_TIMEOUT" ]; then
      log "HEARTBEAT: no frontier progress for >=${IDLE_TIMEOUT}s while alive and no sentinel - killing to relaunch with RESUME (auto-continue an idle agent)."
      kill "$child_pid" 2>/dev/null || true; break
    fi
    # PLAN-auto-compact-threshold: proactive supervisor-fired compaction check.
    if maybe_request_compaction "$child_launch_epoch" "$now"; then
      if [ "$COMPACT_FORCE" -eq 1 ]; then
        log "COMPACT FALLBACK: request unhonored for >=${COMPACT_GRACE}s (parent likely wedged) - recording a .forced-reset marker, then killing the WHOLE child process group so no subagent is orphaned; the outer loop RESUMEs from the SCRIBE-refreshed ANCHOR.md."
        printf '%s forced est_unhonored grace=%s\n' "$now" "$COMPACT_GRACE" > "$COMPACT_STATE_FILE.forced.tmp" 2>/dev/null \
          && mv "$COMPACT_STATE_FILE.forced.tmp" "$LEDGER_DIR/.forced-reset" 2>/dev/null
        printf '%s forced\n' "$now" > "$COMPACT_STATE_FILE.tmp" 2>/dev/null \
          && mv "$COMPACT_STATE_FILE.tmp" "$COMPACT_STATE_FILE" 2>/dev/null
        rm -f "$COMPACT_REQUEST_FILE" 2>/dev/null || true
        kill_tree "$child_pid"
        break
      fi
    fi
    # F-SPEED steer-2 B3: PHASE WALL-CLOCK BUDGET check. Once per tick, while no
    # downstream build artifact exists, consult phase-budget.js. It is anchored to scope
    # entry before the first roadmap artifact and never reset by frontier growth.
    # Fail-open: an absent
    # node/module skips the block (guarded by [ -r ]) and the run proceeds on IDLE_TIMEOUT.
    scope_el=$(scope_phase_elapsed)
    if [ -n "$scope_el" ] && [ -r "$PHASE_BUDGET_PATH" ]; then
      req_age=$(scope_converge_request_age)
      prior=$(awk 'NR==1{print $1+0; exit}' "$SCOPE_RESETS_FILE" 2>/dev/null || echo 0)
      case "$prior" in (*[!0-9]*|"") prior=0 ;; esac
      landed=$(scope_landed_angles)
      node "$PHASE_BUDGET_PATH" --verdict --phase scope --elapsed "$scope_el" \
           --soft "$SCOPE_SOFT_SEC" --hard "$SCOPE_HARD_SEC" --request-age "$req_age" \
           --grace "$SCOPE_GRACE_SEC" --prior-resets "$prior" --max-resets "$MAX_SCOPE_RESETS" \
           --landed "$landed" >/dev/null 2>&1
      case $? in
        10)  # SOFT breach: write the converge heads-up ONCE (idempotent), keep running.
            if [ ! -f "$LEDGER_DIR/SCOPE-CONVERGE-REQUEST" ]; then
              printf '%s soft scope budget: mission=%s elapsed=%ss soft=%ss landed=%s - converge on the landed angles; do NOT fabricate unscoped ones.\n' \
                "$now" "$SCOPE_MISSION_BINDING" "$scope_el" "$SCOPE_SOFT_SEC" "$landed" \
                > "$LEDGER_DIR/SCOPE-CONVERGE-REQUEST.tmp" 2>/dev/null \
                && mv "$LEDGER_DIR/SCOPE-CONVERGE-REQUEST.tmp" "$LEDGER_DIR/SCOPE-CONVERGE-REQUEST" 2>/dev/null
              log "SCOPE BUDGET soft breach at ${scope_el}s (>= ${SCOPE_SOFT_SEC}s, frontier advancing) - wrote SCOPE-CONVERGE-REQUEST (converge on landed=${landed}); child NOT killed."
            fi ;;
        20)  # HARD/grace breach: durable breach marker (honest landed residual), bump the
             # forced-reset counter, then REAL kill->RESUME via the existing idle-kill path.
            printf '%s hard scope budget breach: mission=%s elapsed=%ss hard=%ss landed=%s residual=%s - converge on landed, surface any unscoped angle; DO NOT fabricate.\n' \
              "$now" "$SCOPE_MISSION_BINDING" "$scope_el" "$SCOPE_HARD_SEC" "$landed" "$landed" \
              > "$LEDGER_DIR/SCOPE-BUDGET-BREACH.tmp" 2>/dev/null \
              && mv "$LEDGER_DIR/SCOPE-BUDGET-BREACH.tmp" "$LEDGER_DIR/SCOPE-BUDGET-BREACH" 2>/dev/null
            echo $((prior + 1)) > "$SCOPE_RESETS_FILE.tmp" 2>/dev/null \
              && mv "$SCOPE_RESETS_FILE.tmp" "$SCOPE_RESETS_FILE" 2>/dev/null
            log "SCOPE BUDGET hard breach at ${scope_el}s (frontier was advancing) - wrote SCOPE-BUDGET-BREACH (residual=${landed}); killing the process tree and terminating this supervisor run."
            SCOPE_BUDGET_TERMINAL=1
            kill_tree "$child_pid"; break ;;
        30)  # RE-BREACH past the reset cap: escalate honestly, never fake a roadmap.
            {
              echo "supervisor escalation: scope budget breached past MAX_SCOPE_RESETS=$MAX_SCOPE_RESETS"
              echo "scope_elapsed=$scope_el hard=$SCOPE_HARD_SEC prior_resets=$prior landed=$landed"
              echo "converge unreachable - landed angles surfaced as the honest residual; NO fabricated roadmap"
              echo "ts=$(date 2>/dev/null)"
            } > "$ESCALATE_FILE" 2>/dev/null || true
            log "SCOPE BUDGET escalation at ${scope_el}s - breached past MAX_SCOPE_RESETS=${MAX_SCOPE_RESETS}; landed=${landed} surfaced as residual; killing and exiting 1."
            kill_tree "$child_pid"
            wait "$child_pid" 2>/dev/null
            exit 1 ;;
      esac
    fi
  done
  wait "$child_pid" 2>/dev/null
  exit_code=$?
  [ "$SCOPE_BUDGET_TERMINAL" -eq 1 ] && return 124
  return "$exit_code"
}

# EDIT 23: seed the per-conversation session token BEFORE the relaunch loop. The
# supervisor is the durable producer across relaunches of one conversation; this
# establishes the token precedence ONCE: an env-supplied token (operator or a prior
# same-conversation export) wins and is persisted to the durable file; else a
# previously-harvested token is read back from the file; else the token stays empty
# and the first SCRIBE-run resolver MINTS one (which we then harvest, below).
# Fail-soft: an unwritable/unreadable token file never aborts the run - the token
# just stays empty and the next launch re-mints (worst case a fresh session).
seed_session_token() {
  if [ -n "$AUTOPROMPT_SESSION_TOKEN" ]; then
    printf '%s\n' "$AUTOPROMPT_SESSION_TOKEN" > "$SESSION_TOKEN_FILE" 2>/dev/null || true
  elif [ -r "$SESSION_TOKEN_FILE" ]; then
    AUTOPROMPT_SESSION_TOKEN=$(head -n1 "$SESSION_TOKEN_FILE" 2>/dev/null || echo)
  fi
}

# EDIT 23: HARVEST the resolver-minted token after a launch when the supervisor holds
# none yet. The SCRIBE-run `--resolve-prompt-dir` CLI writes the marker
# "$LEDGER_DIR/.session-current" as "session_NN  <token>" (two whitespace-separated
# fields - the EDIT 7 contract). We read the 2nd field and persist it so the NEXT
# launch re-exports the SAME token and a 2nd prompt rejoins the same session_NN.
# Fail-soft: an absent/corrupt marker (no 2nd field) leaves the token empty and the
# next launch mints again - a fresh session, never a crash.
harvest_session_token() {
  [ -n "$AUTOPROMPT_SESSION_TOKEN" ] && return 0
  marker="$LEDGER_DIR/.session-current"
  [ -r "$marker" ] || return 0
  harvested=$(awk 'NR==1{print $2; exit}' "$marker" 2>/dev/null || echo)
  if [ -n "$harvested" ]; then
    AUTOPROMPT_SESSION_TOKEN="$harvested"
    printf '%s\n' "$AUTOPROMPT_SESSION_TOKEN" > "$SESSION_TOKEN_FILE" 2>/dev/null || true
  fi
}

# PLAN-auto-compact-threshold: a discovery-level test sources this script to call
# canon_path / find_parent_transcript directly. AUTOPROMPT_SOURCE_ONLY=1 stops here,
# AFTER every function + path var is defined but BEFORE the launch loop runs.
[ "${AUTOPROMPT_SOURCE_ONLY:-0}" = "1" ] && return 0 2>/dev/null

# Legacy broad DONE-* matching is a DOWNGRADE honored only for a verified legacy
# resume: the operator opted in explicitly AND the ledger directory carries
# physical evidence of a pre-nonce run (legacy governance files a three-file
# new-format run never creates). A fresh or new-format directory fails closed so
# the downgrade can never weaken a current-format run. Checked on the launch
# path only (after the source-only return) so sourced function evaluation is
# not subjected to launch-time validation.
if [ "$LEGACY_SENTINEL" = "1" ]; then
  LEGACY_EVIDENCE=0
  for marker in BRIEF.md AGENTS.md bucketlist.md ANCHOR.md; do
    if [ -f "$LEDGER_DIR/$marker" ]; then LEGACY_EVIDENCE=1; break; fi
  done
  if [ "$LEGACY_EVIDENCE" -ne 1 ]; then
    echo "supervisor: AUTOPROMPT_LEGACY_SENTINEL=1 requires a verified legacy resume (legacy governance files under $LEDGER_DIR); unset it for new runs" >&2
    exit 2
  fi
fi

if [ -z "$LAUNCHER" ] && [ -z "$LAUNCH_CMD" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "supervisor: no launch command (use --cmd \"<your CLI>\" / AUTOPROMPT_LAUNCH_CMD, or --launcher apidemo|codexdemo / AUTOPROMPT_LAUNCHER)" >&2
  exit 2
fi

resolve_codex_casting || exit $?
verify_codex_profile || exit $?
reject_profile_conflict || exit $?
resolve_capability_binding || exit $?

LAUNCH_LABEL="${LAUNCH_CMD:-${LAUNCHER:-<dry-run>}}"
log "starting: launcher=$LAUNCH_LABEL ledger=$LEDGER_DIR mission=\"$MISSION\""
log "topology: 5-level L0->L4; mode=$AUTOPROMPT_MODE; per-L3 fan-out=$FANOUT; L3 tracks=$L3_TRACKS; L1 never executes (rule 68); single-block spawns (rule 67) - enforced in the harness."
# THE stale-sentinel guarantee: snapshot every pre-existing DONE-* PATH BEFORE the
# first launch and BEFORE quarantine. sentinel_present refuses any path still in
# this snapshot, so a prior-run sentinel can never halt this mission -- even if the
# quarantine rename below fails (read-only dir / permissions). ORDER IS LOAD-BEARING:
# snapshot first (records the dir as it was), THEN quarantine -- which prunes each
# SUCCESSFULLY-renamed path from the live snapshot so the same-activation
# DONE-<nonce> can be reclaimed by a genuine fresh sentinel. A path whose rename
# FAILS stays snapshotted and vetoed. Both run before the first sentinel_present.
snapshot_pre_existing_sentinels
# Quarantine renames each stale sentinel aside, emits a loud log line, and prunes
# every successfully-cleared path from the snapshot so a fresh same-path sentinel is
# honored; a failed rename leaves the path vetoed and degrades to RELAUNCH.
quarantine_stale_sentinels
# EDIT 23: seed the session token once, after the ledger dir exists and before the
# first launch, so run_launcher can re-export it and harvest_session_token can fill it.
seed_session_token

restart_times=""    # space-separated epoch seconds of recent restarts (no progress)
last_frontier=$(frontier_count)
backoff="$RETRY_BASE"

while :; do
  if sentinel_present; then
    log "DONE-sentinel present - run complete, halting cleanly."
    exit 0
  fi

  run_launcher
  exit_code=$?
  if [ "$SCOPE_BUDGET_TERMINAL" -eq 1 ]; then
    log "SCOPE BUDGET terminal stop - no same-mission relaunch will consume another worker."
    exit 124
  fi

  if sentinel_present; then
    log "DONE-sentinel present after launch (exit $exit_code) - run complete, halting cleanly."
    exit 0
  fi

  # V5 (terminal marker, PLAN-idle-watchdog): the child EXITED with no DONE-sentinel -
  # a TERMINAL boundary. Write RUN-ENDED so a downstream audit treats this as run-ended.
  # (Codex has NO JS autoprompt-ledger-check.js, so unlike the claude port there is no
  # `node --terminal` audit to invoke here; the marker is the doctrine signal.) Written
  # every exit-without-sentinel; idempotent. The clean-DONE path short-circuits at the
  # sentinel checks above, so RUN-ENDED is only ever written when the run is not done.
  printf 'run-ended exit=%s ts=%s\n' "$exit_code" "$(date 2>/dev/null)" > "$LEDGER_DIR/RUN-ENDED" 2>/dev/null || true

  now=$(date +%s 2>/dev/null || echo 0)
  cur_frontier=$(frontier_count)
  # EDIT 23: harvest the resolver-minted session token (no-op once we hold one) so
  # the next relaunch re-exports the SAME token and a 2nd prompt rejoins the session.
  harvest_session_token
  log "launcher exited ($exit_code); frontier $last_frontier -> $cur_frontier; no sentinel - relaunching with RESUME."

  if [ "$cur_frontier" -gt "$last_frontier" ]; then
    # Healthy-long: progress was made. Reset the poison window and backoff.
    restart_times=""
    backoff="$RETRY_BASE"
    last_frontier="$cur_frontier"
  else
    # No progress since the last launch. Record this restart in the rolling
    # window and check the poison guard.
    new_times=""
    rapid=1
    for t in $restart_times; do
      if [ $((now - t)) -lt "$WINDOW" ]; then
        new_times="$new_times $t"
        rapid=$((rapid + 1))
      fi
    done
    restart_times="$new_times $now"
    if [ "$rapid" -ge "$MAX_RESTARTS" ]; then
      log "POISON: $rapid restarts within ${WINDOW}s with NO frontier progress - escalating, not relaunching."
      {
        echo "supervisor escalation: crash-loop with no frontier progress"
        echo "restarts_in_window=$rapid window_s=$WINDOW last_exit=$exit_code frontier=$cur_frontier"
        echo "ts=$(date 2>/dev/null)"
      } > "$ESCALATE_FILE"
      exit 1
    fi
    # Exponential backoff, capped, between unproductive relaunches.
    if [ "$backoff" -gt 0 ] 2>/dev/null; then sleep "$backoff" 2>/dev/null || true; fi
    next=$((backoff * 2)); [ "$next" -gt "$RETRY_CAP" ] && next="$RETRY_CAP"
    backoff="$next"
  fi
done
