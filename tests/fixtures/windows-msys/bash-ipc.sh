#!/usr/bin/bash
# Only Bash builtins: every subprocess uses the same closed runtime.
set -euo pipefail
shell_witness=${1:?scratch witness path required}

substituted=$(printf '%s' 'command-substitution')
[[ "$substituted" == command-substitution ]]
( [[ "$substituted" == command-substitution ]] )
printf '%s\n' pipeline | { IFS= read -r piped; [[ "$piped" == pipeline ]]; }
IFS= read -r process_value < <(printf '%s\n' process-substitution)
[[ "$process_value" == process-substitution ]]

coproc AP_PROOF { IFS= read -r request; printf 'reply:%s\n' "$request"; }
proof_pid=$AP_PROOF_PID
# Duplicate both ends before the child exits and Bash closes its own originals.
exec {proof_read}<&"${AP_PROOF[0]}" {proof_write}>&"${AP_PROOF[1]}"
printf '%s\n' coprocess >&"$proof_write"
exec {proof_write}>&-
IFS= read -r reply <&"$proof_read"
[[ "$reply" == reply:coprocess ]]
exec {proof_read}<&-
wait "$proof_pid"

{ printf '%s\n' shell-write > "$shell_witness"; } &
writer_pid=$!
wait "$writer_pid"
IFS= read -r written < "$shell_witness"
[[ "$written" == shell-write ]]
