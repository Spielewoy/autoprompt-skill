#!/bin/sh

set -eu

fail() {
  printf 'grok activation error: %s\n' "$1" >&2
  exit 1
}

# The activation profile is Autoprompt's own harness contract, not Grok Build
# configuration: the dispatcher reads it, so every pinned line must be present
# and unmodified before a run starts.
profile_is_safe() {
  awk '
    BEGIN { runtime = 0; depth = 0; dispatch = 0; server = 0; native = 0; bad = 0 }
    /^runtime = "grok-build-adapter-v1"$/ { runtime++; next }
    /^max_depth = 4$/ { depth++; next }
    /^dispatch = "sealed-headless-reentry"$/ { dispatch++; next }
    /^mcp_server = "autoprompt"$/ { server++; next }
    /^native_subagent_spawn = "denied"$/ { native++; next }
    /^\[autoprompt\]$/ { next }
    /^#/ { next }
    /^[[:space:]]*$/ { next }
    /^[a-z_]+ = / { next }
    /^\[[a-z_.]+\]$/ { next }
    { bad = 1 }
    END {
      exit !(runtime == 1 && depth == 1 && dispatch == 1 && server == 1 && native == 1 && bad == 0)
    }
  '
}

# The one registration Autoprompt needs inside Grok Build: an stdio MCP server
# named autoprompt whose command is the installed sealed dispatch server.
mcp_registration_is_present() {
  server_path=$1
  awk -v expected="$server_path" '
    BEGIN { section = 0; command = 0; args = 0 }
    /^\[mcp_servers\.autoprompt\]$/ { section = 1; next }
    /^\[/ { section = 0; next }
    section == 1 && /^command = / { command = 1 }
    section == 1 && index($0, expected) > 0 { args = 1 }
    END { exit !(command == 1 && args == 1) }
  '
}

# The activation capability. Grok Build serves user-scoped MCP servers to every
# session, so the dispatch tool alone cannot prove a run was started here. This
# token is minted per launch, lives only in this process tree, and is what the
# dispatcher requires before it will admit a depth-0 conductor.
mint_activation() {
  token=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  if [ ${#token} -ne 32 ]; then
    fail 'could not mint an Autoprompt activation token'
  fi
  printf 'ap%s' "$token"
}

version_is_supported() {
  candidate=$1
  major=${candidate%%.*}

  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac

  [ "$major" -ge 1 ]
}

check_only=0
if [ "${1-}" = '--check' ]; then
  check_only=1
  shift
fi
if [ "$check_only" -eq 1 ] && [ "$#" -ne 0 ]; then
  fail '--check does not accept Grok Build arguments'
fi

if [ -n "${GROK_HOME-}" ]; then
  config_root=$GROK_HOME
elif [ -n "${HOME-}" ]; then
  config_root=$HOME/.grok
else
  fail 'HOME or GROK_HOME is required to locate the activation profile'
fi

runtime_root=$config_root/skills/autoprompt
profile=$config_root/autoprompt.grok.toml
config=$config_root/config.toml
dispatch_server=$runtime_root/workflow/grok-dispatch-server.js

[ -f "$profile" ] || fail "activation profile not found: $profile"
[ -f "$dispatch_server" ] || fail "sealed dispatch server not found: $dispatch_server"
[ -d "$runtime_root/agents" ] || fail "persona definitions not found under $runtime_root/agents"

if ! tr -d '\r' < "$profile" | profile_is_safe; then
  fail "activation profile is unsafe: $profile"
fi

[ -f "$config" ] || fail "Grok Build configuration not found: $config"
if ! tr -d '\r' < "$config" | mcp_registration_is_present "$dispatch_server"; then
  fail "config.toml does not register the autoprompt dispatch server: $config"
fi

command -v node >/dev/null 2>&1 || fail 'node is required to run the sealed dispatcher'

grok_bin=$(command -v grok 2>/dev/null || true)
[ -n "$grok_bin" ] || fail 'grok executable not found on PATH'

if ! version_output=$("$grok_bin" --version 2>/dev/null); then
  fail 'could not read the Grok Build version'
fi
version=$(printf '%s\n' "$version_output" |
  sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p' |
  sed -n '1p')
[ -n "$version" ] || fail 'could not parse the Grok Build version'
version_is_supported "$version" || fail "Grok Build $version is older than required 1.0.0"

# Scoped to this wrapper process and the Grok Build session it starts. The
# dispatcher reads them to resolve the installed runtime, to prove activation, and
# to seal depth 0. Model and effort are run-wide: every process hop reapplies them,
# so they are validated once here and then travel with the run.
AUTOPROMPT_GROK_RUNTIME_ROOT=$runtime_root
AUTOPROMPT_GROK_BIN=$grok_bin
AUTOPROMPT_GROK_DEPTH=0
AUTOPROMPT_GROK_ACTIVATION=$(mint_activation)
GROK_DISABLE_AUTOUPDATER=1
export AUTOPROMPT_GROK_RUNTIME_ROOT AUTOPROMPT_GROK_BIN AUTOPROMPT_GROK_DEPTH
export AUTOPROMPT_GROK_ACTIVATION GROK_DISABLE_AUTOUPDATER
unset AUTOPROMPT_GROK_PERSONA AUTOPROMPT_GROK_BINDING AUTOPROMPT_GROK_NONCE 2>/dev/null || true

case "${AUTOPROMPT_GROK_MODEL-}" in
  '') ;;
  *[!A-Za-z0-9._:/-]*) fail 'AUTOPROMPT_GROK_MODEL is not a safe model identifier' ;;
  *) export AUTOPROMPT_GROK_MODEL ;;
esac
case "${AUTOPROMPT_GROK_EFFORT-}" in
  ''|low|medium|high|xhigh) [ -z "${AUTOPROMPT_GROK_EFFORT-}" ] || export AUTOPROMPT_GROK_EFFORT ;;
  *) fail 'AUTOPROMPT_GROK_EFFORT must be low, medium, high, or xhigh' ;;
esac

if [ "$check_only" -eq 1 ]; then
  printf 'grok activation policy: ok profile=%s runtime=%s version=%s activation=minted\n' \
    "$profile" "$runtime_root" "$version"
  exit 0
fi

exec "$grok_bin" "$@"
