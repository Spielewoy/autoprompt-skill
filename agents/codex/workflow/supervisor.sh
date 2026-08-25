#!/bin/sh
# Autoprompt Codex v2 supervisor adapter.
#
# C0 lives in phase-budget.js so both supported shells execute exactly the same
# state/scheduler contract.  This file performs no word splitting, glob-based
# sentinel lookup, relaunch, scope fleet, scribe, janitor, framework generation,
# or direct child launch.  The provider adapter receives every argument exactly
# as one argv element and must implement owned process groups or return the
# runtime's typed PROVIDER_UNSUPPORTED result.
set -eu
umask 077

if [ "${SENTINEL+x}" = x ]; then
  printf '%s\n' 'supervisor: LEGACY_SENTINEL_UNSUPPORTED: modern Codex does not accept SENTINEL overrides' >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
RUNTIME="$SCRIPT_DIR/phase-budget.js"
if [ "${AUTOPROMPT_RUNTIME+x}" = x ] && [ -n "${AUTOPROMPT_RUNTIME:-}" ] &&
   [ "$AUTOPROMPT_RUNTIME" != "$RUNTIME" ]; then
  printf '%s\n' 'supervisor: ALTERNATE_RUNTIME_UNSUPPORTED: AUTOPROMPT_RUNTIME cannot replace the receipt-bound controller' >&2
  exit 2
fi

# Keep the public mode boundary executable at the shell edge. C0 still owns all
# launch admission; these values only validate and preserve the caller's exact
# concurrency setting for the receipt-bound JavaScript runtime.
AUTOPROMPT_MODE=${AUTOPROMPT_MODE:-tokensaver}
case "$AUTOPROMPT_MODE" in
  tokensaver) FANOUT="up to 6 live per wave" ;;
  wide|billionaire) FANOUT="wide up to the runtime ceiling" ;;
  custom)
    CUSTOM_MAX=$(awk -v raw="${AUTOPROMPT_MAX_CONCURRENT:-}" 'BEGIN {
      if (raw ~ /^[+]?[0-9]+([.][0-9]+)?$/ && (raw + 0) >= 1) printf "%d", int(raw + 0)
    }')
    if [ -z "$CUSTOM_MAX" ]; then
      printf '%s\n' 'supervisor: custom mode requires a positive numeric AUTOPROMPT_MAX_CONCURRENT' >&2
      exit 2
    fi
    AUTOPROMPT_MAX_CONCURRENT="$CUSTOM_MAX"
    export AUTOPROMPT_MAX_CONCURRENT
    FANOUT="up to $CUSTOM_MAX live per wave (AUTOPROMPT_MAX_CONCURRENT)"
    ;;
  *) AUTOPROMPT_MODE=tokensaver; FANOUT="up to 6 live per wave" ;;
esac
export AUTOPROMPT_MODE

# Scope convergence is implemented by phase-budget.js. These exact durable
# marker names are part of the shell/runtime contract and are never terminal
# sentinels: SCOPE-BUDGET-BREACH and SCOPE-CONVERGE-REQUEST.

# Source-checkout contract simulation. This boundary cannot exist in an
# installed payload: it requires this exact adapter under a .git checkout plus
# the un-packaged test contract and driver at their canonical source paths.
case " $* " in
  *" --dry-run "*)
    TEST_ROOT=${AUTOPROMPT_TEST_SOURCE_ROOT:-}
    TEST_DRIVER=${AUTOPROMPT_TEST_CONTRACT_DRIVER:-}
    TEST_CONTRACT=${AUTOPROMPT_TEST_CONTRACT_FILE:-}
    if [ -n "$TEST_ROOT" ] && [ -d "$TEST_ROOT/.git" ] &&
       [ "$SCRIPT_DIR" = "$TEST_ROOT/agents/codex/workflow" ] &&
       [ "$TEST_DRIVER" = "$TEST_ROOT/tests/fixtures/codex-supervisor-contract-dry-run.cjs" ] &&
       [ "$TEST_CONTRACT" = "$TEST_ROOT/tests/source/supervisor-mode-contract.test.cjs" ] &&
       [ -f "$TEST_DRIVER" ] && [ -f "$TEST_CONTRACT" ]; then
      exec node "$TEST_DRIVER" --port bash "$@"
    fi
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'supervisor: node is required for the canonical Codex runtime' >&2
  exit 2
fi
if [ ! -f "$RUNTIME" ]; then
  printf 'supervisor: runtime is not readable: %s\n' "$RUNTIME" >&2
  exit 2
fi
RUNTIME_CAPABILITIES=$(node "$RUNTIME" --supervisor --capabilities 2>/dev/null) || {
  printf '%s\n' 'supervisor: RUNTIME_CONTROLLER_INVALID: canonical controller probe failed' >&2
  exit 2
}
if ! node -e 'const c=JSON.parse(process.argv[1]);if(c.schemaVersion!==2||c.provider!=="codex")process.exit(1)' "$RUNTIME_CAPABILITIES"; then
  printf '%s\n' 'supervisor: RUNTIME_CONTROLLER_INVALID: canonical controller version/provider mismatch' >&2
  exit 2
fi

# Explicit-entry/resume strings are retained as provider-adapter data, never
# inferred from mission prose.
AUTOPROMPT_ENTRY_PROMPT="\$autoprompt"
AUTOPROMPT_RESUME_PROMPT='\$autoprompt resume '
export AUTOPROMPT_ENTRY_PROMPT AUTOPROMPT_RESUME_PROMPT

if [ "$AUTOPROMPT_MODE" = custom ]; then
  printf 'mode=custom; per-L3 fan-out=%s\n' "$FANOUT"
fi

exec node "$RUNTIME" --supervisor "$@"
