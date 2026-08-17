#!/bin/sh

set -eu

fail() {
  printf 'opencode activation error: %s\n' "$1" >&2
  exit 1
}

policy_json_is_safe() {
  awk -v require_schema="${1:-0}" '
    BEGIN {
      schema = 0
      depth = 0
      share = 0
      permission = 0
      task = 0
      task_step = 0
      task_ok = 0
      bad = 0
    }
    /^  "\$schema": "https:\/\/opencode\.ai\/config\.json",?$/ {
      schema++
      next
    }
    /^  "subagent_depth": 4,?$/ {
      depth++
      next
    }
    /^  "share": "disabled",?$/ {
      share++
      next
    }
    /^  "permission": \{$/ {
      permission++
      next
    }
    permission == 1 && /^    "task": \{$/ {
      task++
      task_step = 0
      next
    }
    task == 1 && task_ok == 0 {
      if (task_step == 0 && $0 ~ /^      "\*": "deny",$/) {
        task_step = 1
        next
      }
      if (task_step == 1 && $0 ~ /^      "ap-\*": "allow"$/) {
        task_step = 2
        next
      }
      if (task_step == 2 && $0 ~ /^    },?$/) {
        task_ok = 1
        next
      }
      bad = 1
    }
    END {
      schema_ok = require_schema == 0 || schema == 1
      exit !(schema_ok && depth == 1 && share == 1 && permission == 1 && task == 1 && task_ok == 1 && bad == 0)
    }
  '
}

version_is_supported() {
  candidate=$1
  major=${candidate%%.*}
  remainder=${candidate#*.}
  minor=${remainder%%.*}
  patch=${remainder#*.}

  case "$major:$minor:$patch" in
    *[!0-9:]*|'::') return 1 ;;
  esac

  [ "$major" -gt 1 ] && return 0
  [ "$major" -lt 1 ] && return 1
  [ "$minor" -gt 18 ] && return 0
  [ "$minor" -lt 18 ] && return 1
  [ "$patch" -ge 7 ]
}

check_only=0
if [ "${1-}" = '--check' ]; then
  check_only=1
  shift
fi
if [ "$check_only" -eq 1 ] && [ "$#" -ne 0 ]; then
  fail '--check does not accept OpenCode arguments'
fi

if [ -n "${XDG_CONFIG_HOME-}" ]; then
  config_root=$XDG_CONFIG_HOME
elif [ -n "${HOME-}" ]; then
  config_root=$HOME/.config
else
  fail 'HOME or XDG_CONFIG_HOME is required to locate the activation profile'
fi

profile=$config_root/opencode/autoprompt.opencode.json
[ -f "$profile" ] || fail "dedicated activation profile not found: $profile"

if ! tr -d '\r' < "$profile" | policy_json_is_safe 1; then
  fail "dedicated activation profile is unsafe: $profile"
fi

opencode_bin=$(command -v opencode 2>/dev/null || true)
[ -n "$opencode_bin" ] || fail 'opencode executable not found on PATH'

# These values are scoped to this wrapper process and its OpenCode children.
# Inline config wins over project config. OPENCODE_PERMISSION is applied last by
# OpenCode 1.18.7+ and closes task rules added by lower-precedence sources.
OPENCODE_CONFIG=$profile
OPENCODE_CONFIG_CONTENT='{"subagent_depth":4,"share":"disabled","permission":{"task":{"*":"deny","ap-*":"allow"}}}'
OPENCODE_PERMISSION='{"task":{"*":"deny","ap-*":"allow"}}'
OPENCODE_DISABLE_EXTERNAL_SKILLS=1
export OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_PERMISSION OPENCODE_DISABLE_EXTERNAL_SKILLS

if ! version_output=$("$opencode_bin" --version 2>/dev/null); then
  fail 'could not read the OpenCode version'
fi
version=$(printf '%s\n' "$version_output" |
  sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p' |
  sed -n '1p')
[ -n "$version" ] || fail 'could not parse the OpenCode version'
version_is_supported "$version" || fail "OpenCode $version is older than required 1.18.7"

if ! resolved=$("$opencode_bin" debug config --pure 2>/dev/null); then
  fail 'could not resolve the activation configuration'
fi
if ! printf '%s\n' "$resolved" | tr -d '\r' | policy_json_is_safe 0; then
  fail 'resolved activation policy is unsafe'
fi

if [ "$check_only" -eq 1 ]; then
  printf 'opencode activation policy: ok profile=%s version=%s\n' "$profile" "$version"
  exit 0
fi

exec "$opencode_bin" "$@"
