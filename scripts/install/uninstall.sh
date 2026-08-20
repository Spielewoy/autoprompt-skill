#!/usr/bin/env bash
# uninstall.sh - receipt-driven Autoprompt removal with shared-XDG provider scoping.
# OpenCode removal preserves Kilo ownership in the shared receipt; `all` then processes
# Kilo explicitly. Other roots retain the historical root-wide receipt semantics.
#
# Test isolation: HOME / XDG_CONFIG_HOME are honored if set. A root with no receipt is a
# non-fatal SKIP (nothing to remove).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/install-lib.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ ! -f "$LIB" ]; then
  printf 'Autoprompt uninstall: library not found at %s - is the repo intact?\n' "$LIB" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$LIB"

CLIENTS_ALL=(prime omp vscode claude codex opencode kilo)
LEGACY_CLEANUP_CLIENTS=(vibe cursor roo gemini cline goose dcode)
RESULT_ROWS=()
UNINSTALL_EXIT_CODE=0

usage() {
  printf 'Usage: %s <client>|all\n' "$(basename "$0")" >&2
  printf '  clients: %s\n' "${CLIENTS_ALL[*]}" >&2
}

config_root() {
  local client="$1"
  autoprompt_config_root "$client"
}

# uninstall_root <root> <label>: drive uninstall_client for one config-root. The <label>
# is the client name passed to the library (used only in its summary line). Emits a
# RESULT=/SKIP= row. The no-receipt case (library code 71) is a SKIP, not a failure.
uninstall_root() {
  local root="$1" label="$2"
  if [ ! -f "$root/$AUTOPROMPT_RECEIPT_NAME" ]; then
    printf 'Autoprompt uninstall (%s): SKIP - no install receipt under %s.\n' "$label" "$root" >&2
    RESULT_ROWS+=("SKIP=skip client=$label reason=no-receipt")
    return 0
  fi
  local rec rc output errors
  output="$(mktemp)"; errors="$(mktemp)"
  uninstall_client "$root" "$label" >"$output" 2>"$errors"
  rc=$?; rec="$(cat "$output")"
  if [ "$rc" -ne 0 ]; then
    [ -s "$errors" ] && command cat "$errors" >&2
    rm -f "$output" "$errors"
    printf 'Autoprompt uninstall (%s): failed (code %s, see message above).\n' "$label" "$rc" >&2
    RESULT_ROWS+=("RESULT=FAIL client=$label code=$rc")
    if [ "$rc" -eq 77 ]; then
      UNINSTALL_EXIT_CODE=77
    elif [ "$UNINSTALL_EXIT_CODE" -ne 77 ]; then
      UNINSTALL_EXIT_CODE=1
    fi
    return 0
  fi
  rm -f "$output" "$errors"
  local removed="${rec#*uninstall=ok removed=}"; removed="${removed%% *}"
  printf 'Autoprompt uninstall (%s): OK - %s\n' "$label" "$rec" >&2
  RESULT_ROWS+=("RESULT=OK client=$label removed=$removed")
  return 0
}

uninstall_prime_lifecycle() {
  local root helper output rc
  root="$(config_root prime)"
  if [ ! -f "$root/.autoprompt-prime-install.json" ]; then
    printf 'Autoprompt uninstall (prime): SKIP - no install receipt under %s.\n' \
      "$root" >&2
    RESULT_ROWS+=("SKIP=skip client=prime reason=no-receipt")
    return 0
  fi
  helper="$SCRIPT_DIR/prime-lifecycle.cjs"
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$helper" ]; then
    printf '%s\n' \
      'Autoprompt uninstall (prime): node or the Prime lifecycle helper is missing.' >&2
    RESULT_ROWS+=("RESULT=FAIL client=prime code=3")
    UNINSTALL_EXIT_CODE=1
    return 0
  fi
  output="$(node "$helper" uninstall --repo-root "$REPO_ROOT")"
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$output" ]; then
    printf 'Autoprompt uninstall (prime): failed (code %s).\n' "$rc" >&2
    RESULT_ROWS+=("RESULT=FAIL client=prime code=$rc")
    UNINSTALL_EXIT_CODE=1
    return 0
  fi
  printf '%s\n' \
    'Autoprompt uninstall (prime): OK - removed the 48-file package and owned settings.' >&2
  RESULT_ROWS+=("RESULT=OK client=prime removed=48")
}

uninstall_omp_lifecycle() {
  local root helper output rc
  root="$(config_root omp)"
  if [ ! -f "$root/.autoprompt-omp-install.json" ]; then
    printf 'Autoprompt uninstall (omp): SKIP - no install receipt under %s.\n' \
      "$root" >&2
    RESULT_ROWS+=("SKIP=skip client=omp reason=no-receipt")
    return 0
  fi
  helper="$SCRIPT_DIR/omp-lifecycle.cjs"
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$helper" ]; then
    printf '%s\n' \
      'Autoprompt uninstall (omp): node or the omp lifecycle helper is missing.' >&2
    RESULT_ROWS+=("RESULT=FAIL client=omp code=3")
    UNINSTALL_EXIT_CODE=1
    return 0
  fi
  output="$(node "$helper" uninstall --repo-root "$REPO_ROOT")"
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$output" ]; then
    printf 'Autoprompt uninstall (omp): failed (code %s).\n' "$rc" >&2
    RESULT_ROWS+=("RESULT=FAIL client=omp code=$rc")
    UNINSTALL_EXIT_CODE=1
    return 0
  fi
  printf '%s\n' \
    'Autoprompt uninstall (omp): OK - removed 59 files and owned config.' >&2
  RESULT_ROWS+=("RESULT=OK client=omp removed=59")
}

print_matrix() {
  local line client detail
  printf '\n==== Autoprompt uninstall matrix ====\n'
  for line in "${RESULT_ROWS[@]}"; do
    client="${line#* client=}"; client="${client%% *}"
    case "$line" in
      RESULT=OK*)   detail="${line#* removed=}"; printf '  OK    %-9s removed=%s\n' "$client" "${detail%% *}" ;;
      RESULT=FAIL*) detail="${line#* code=}"; printf '  FAIL  %-9s code=%s\n' "$client" "${detail%% *}" ;;
      SKIP=*)       detail="${line#* reason=}"; printf '  SKIP  %-9s reason=%s\n' "$client" "${detail%% *}" ;;
    esac
  done
  printf '======================================\n'
}

main() {
  if [ "$#" -ne 1 ]; then usage; exit 2; fi
  local target="$1"
  test_autoprompt_install_root_contract "$target" || exit 2

  if [ "$target" = "all" ]; then
    local c root
    for c in "${CLIENTS_ALL[@]}"; do
      if [ "$c" = prime ]; then uninstall_prime_lifecycle
      elif [ "$c" = omp ]; then uninstall_omp_lifecycle
      else
        root="$(config_root "$c")"
        uninstall_root "$root" "$c"
      fi
    done
    print_matrix
    exit "$UNINSTALL_EXIT_CODE"
  fi

  local known=0 c
  for c in "${CLIENTS_ALL[@]}"; do [ "$c" = "$target" ] && known=1; done
  for c in "${LEGACY_CLEANUP_CLIENTS[@]}"; do [ "$c" = "$target" ] && known=1; done
  if [ "$known" -eq 0 ]; then
    printf 'Autoprompt uninstall: unknown client %s.\n' "$target" >&2
    usage; exit 2
  fi
  if [ "$target" = prime ]; then uninstall_prime_lifecycle
  elif [ "$target" = omp ]; then uninstall_omp_lifecycle
  else uninstall_root "$(config_root "$target")" "$target"
  fi
  print_matrix
  exit "$UNINSTALL_EXIT_CODE"
}

main "$@"
