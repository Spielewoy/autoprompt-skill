#!/usr/bin/env bash

# Fixed entry point for the POSIX half of codex-version-probe-isolation.test.cjs.
# Paths stay positional arguments so checkout-derived values are never parsed as
# part of a dynamically constructed shell command.

source "$1"
AUTOPROMPT_PROBE_TIMEOUT="$2"

record="$(detect_client codex)"
code=$?
printf 'RESULT_CODE=%s\nRESULT_RECORD=%s\n' "$code" "$record"
exit 0
