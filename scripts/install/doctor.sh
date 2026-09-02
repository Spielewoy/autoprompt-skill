#!/usr/bin/env bash
# doctor.sh - status matrix for every known Autoprompt provider key.
#
# Read-only diagnostics over lib/install-lib.sh. For each client it answers three
# questions, each from the library's own verdict (no guessing):
#   detected?  detect_client      (CLI on PATH + a readable version)
#   installed? receipt presence   (an install receipt under the client's config-root)
#   verifies?  verify_install     (landed file EXISTS, PARSES, sits AT the load path)
#
# It writes NOTHING and edits NOTHING. Usage: doctor.sh   (no arguments).
# HOME / XDG_CONFIG_HOME are honored if set, so it inspects the same tree an
# isolated install used.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/install-lib.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ ! -f "$LIB" ]; then
  printf 'Autoprompt doctor: library not found at %s - is the repo intact?\n' "$LIB" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$LIB"

CLIENTS_ALL=(claude codex opencode kilo grok vscode prime omp deepseek reasonix)

config_root() {
  local client="$1"
  autoprompt_config_root "$client"
}

# opencode_activation_status: completeness of the activation-only OpenCode extras
# beyond the hash-bound payload - the profile beside the user's opencode.json and
# the full native subagent set at the global agents load path.
opencode_activation_status() {
  local base skill
  base="$(dirname -- "$(autoprompt_profile_file opencode)")"
  skill="$(autoprompt_runtime_root opencode)"
  if [ ! -f "$base/autoprompt.opencode.json" ]; then
    printf 'missing:autoprompt.opencode.json'
    return 0
  fi
  local status
  status="$(python - "$skill" "$base" <<'PY' 2>/dev/null
import hashlib
import json
import pathlib
import re
import sys
import yaml

skill = pathlib.Path(sys.argv[1])
base = pathlib.Path(sys.argv[2])
profile_path = base / 'autoprompt.opencode.json'
try:
    profile = json.loads(profile_path.read_text(encoding='utf-8'))
except Exception:
    print('invalid:profile-policy')
    sys.exit(0)
expected_profile = {
    '$schema': 'https://opencode.ai/config.json',
    'subagent_depth': 4,
    'share': 'disabled',
    'permission': {'task': {'*': 'deny', 'ap-*': 'allow'}},
}
if profile != expected_profile or type(profile.get('subagent_depth')) is not int:
    print('invalid:profile-policy')
    sys.exit(0)

source_files = sorted((skill / 'agents').glob('ap-*.md'))
native_files = sorted((base / 'agents').glob('ap-*.md'))
if len(source_files) != 25 or len(native_files) != 25:
    print('invalid:opencode-native-count')
    sys.exit(0)
if [file.name for file in source_files] != [file.name for file in native_files]:
    print('invalid:opencode-native-names')
    sys.exit(0)

names = set()
permission_keys = {
    'read', 'edit', 'glob', 'grep', 'bash', 'task', 'webfetch', 'websearch', 'skill'
}
for file in native_files:
    name = file.stem
    if not re.fullmatch(r'ap-[a-z0-9-]+', name) or name in names:
        print('invalid:opencode-native-names')
        sys.exit(0)
    names.add(name)
    text = file.read_text(encoding='utf-8')
    match = re.match(r'^---\r?\n([\s\S]*?)\r?\n---\r?\n', text)
    if match is None:
        print('invalid:opencode-native-frontmatter')
        sys.exit(0)
    try:
        frontmatter = yaml.safe_load(match.group(1))
    except Exception:
        print('invalid:opencode-native-frontmatter')
        sys.exit(0)
    if not isinstance(frontmatter, dict) or set(frontmatter) != {
        'description', 'mode', 'permission'
    }:
        print('invalid:opencode-native-frontmatter')
        sys.exit(0)
    permission = frontmatter.get('permission')
    if (not isinstance(frontmatter.get('description'), str)
            or not frontmatter['description']
            or frontmatter.get('mode') != 'subagent'
            or not isinstance(permission, dict)
            or set(permission) != permission_keys
            or permission.get('skill') != 'deny'):
        print('invalid:opencode-native-frontmatter')
        sys.exit(0)
    for key, value in permission.items():
        if key == 'task' and isinstance(value, dict):
            if value != {'*': 'deny', 'ap-*': 'allow'}:
                print('invalid:opencode-native-frontmatter')
                sys.exit(0)
        elif value not in {'allow', 'deny'}:
            print('invalid:opencode-native-frontmatter')
            sys.exit(0)

for source, native in zip(source_files, native_files):
    if hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(native.read_bytes()).digest():
        print('invalid:opencode-native-hash')
        sys.exit(0)
print('complete')
PY
)" || status='invalid:opencode-native-frontmatter'
  if [ -z "$status" ]; then
    printf 'invalid:opencode-native-frontmatter'
    return 0
  fi
  printf '%s' "$status"
}

claude_native_status() {
  local skill source_dir native_dir
  skill="$(autoprompt_runtime_root claude)"
  source_dir="$skill/agents"
  native_dir="$(autoprompt_native_agents_root claude)"
  local validator="$skill/workflow/agent-definitions-cli.js"
  local source_file native_file had_nullglob
  local -a expected=() actual=()
  case "$(shopt nullglob)" in *on) had_nullglob=1 ;; *) had_nullglob=0 ;; esac
  shopt -s nullglob
  expected=("$source_dir"/ap-*.md)
  actual=("$native_dir"/ap-*.md)
  [ "$had_nullglob" -eq 0 ] && shopt -u nullglob
  if [ "${#expected[@]}" -ne 25 ] ||
     [ "${#actual[@]}" -ne "${#expected[@]}" ]; then
    printf 'invalid:claude-native-count'
    return 0
  fi
  if [ ! -f "$validator" ] || ! node - "$validator" "$native_dir" <<'NODE' >/dev/null 2>&1
const fs = require('node:fs')
const path = require('node:path')
const { parseAgentDefinition } = require(process.argv[2])
const directory = process.argv[3]
const files = fs.readdirSync(directory).filter(name => /^ap-.*\.md$/.test(name)).sort()
if (files.length !== 25) throw new Error('unexpected agent count')
const names = new Set()
for (const file of files) {
  const [name] = parseAgentDefinition(path.join(directory, file))
  if (name !== path.basename(file, '.md')) throw new Error('agent name does not match filename')
  if (names.has(name)) throw new Error('duplicate agent name')
  names.add(name)
}
NODE
  then
    printf 'invalid:claude-native-frontmatter'
    return 0
  fi
  for source_file in "${expected[@]}"; do
    native_file="$native_dir/${source_file##*/}"
    if [ ! -f "$native_file" ] || ! cmp -s "$source_file" "$native_file"; then
      printf 'invalid:claude-native-hash'
      return 0
    fi
  done
  printf 'complete'
}

kilo_activation_status() {
  local skill base profile
  skill="$(autoprompt_runtime_root kilo)"
  profile="$(autoprompt_profile_file kilo)"
  base="${profile%/*}"
  [ -f "$profile" ] || { printf 'missing:autoprompt.kilo.json'; return 0; }
  validate_kilo_profile "$profile" || { printf 'invalid:profile-policy'; return 0; }
  local source_agent landed agents=0
  for source_agent in "$skill/agents"/ap-*.md; do
    [ -f "$source_agent" ] || continue
    agents=$((agents + 1))
    landed="$base/agents/${source_agent##*/}"
    if [ ! -f "$landed" ] || ! cmp -s "$source_agent" "$landed"; then
      printf 'invalid:agent-mismatch'
      return 0
    fi
  done
  [ "$agents" -eq 25 ] && printf 'complete' || printf 'missing:agents'
}

# grok_activation_status: the activation state beyond the hash-bound payload -
# the harness profile beside config.toml, the sealed dispatcher, and the one MCP
# registration Autoprompt owns inside the user's Grok Build configuration.
grok_activation_status() {
  local skill profile runtime status rc reason
  skill="$(autoprompt_runtime_root grok)"
  profile="$(autoprompt_profile_file grok)"
  [ -f "$profile" ] || { printf 'missing:autoprompt.grok.toml'; return 0; }
  validate_grok_profile "$profile" || { printf 'invalid:profile-policy'; return 0; }
  runtime="$skill/workflow"
  if [ ! -f "$runtime/grok-dispatch.js" ] || [ ! -f "$runtime/grok-dispatch-server.js" ] ||
     [ ! -f "$runtime/autoprompt-topology.json" ]; then
    printf 'missing:dispatcher'
    return 0
  fi
  local source_agent agents=0
  for source_agent in "$skill/agents"/ap-*.md; do
    [ -f "$source_agent" ] && agents=$((agents + 1))
  done
  [ "$agents" -eq 25 ] || { printf 'missing:agents'; return 0; }
  status="$(grok_config_status 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    reason="${status#*reason=}"
    printf 'activation-missing:%s' "${reason// /-}"
    return 0
  fi
  printf 'complete'
}

vscode_activation_status() {
  local skill agents_dir
  skill="$(autoprompt_runtime_root vscode)"
  agents_dir="$(autoprompt_native_agents_root vscode)"
  local source_agent landed agents=0 status rc reason
  for source_agent in "$skill/agents"/ap-*.agent.md; do
    [ -f "$source_agent" ] || continue
    agents=$((agents + 1))
    landed="$agents_dir/${source_agent##*/}"
    if [ ! -f "$landed" ] || ! cmp -s "$source_agent" "$landed"; then
      printf 'invalid:agent-mismatch'
      return 0
    fi
  done
  [ "$agents" -eq 25 ] || { printf 'missing:agents'; return 0; }
  status="$(vscode_settings_status 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    reason="${status#*reason=}"
    printf 'activation-missing:%s' "${reason// /-}"
    return 0
  fi
  printf 'complete'
}

omp_activation_status() {
  local skill agents_dir source_agent landed agents=0 helper config
  skill="$(autoprompt_runtime_root omp)"
  agents_dir="$(autoprompt_native_agents_root omp)"
  for source_agent in "$skill/agents"/ap-*.md; do
    [ -f "$source_agent" ] || continue
    agents=$((agents + 1))
    landed="$agents_dir/${source_agent##*/}"
    if [ ! -f "$landed" ] || ! cmp -s "$source_agent" "$landed"; then
      printf 'invalid:agent-mismatch'
      return 0
    fi
  done
  [ "$agents" -eq 25 ] || { printf 'missing:agents'; return 0; }
  helper="$SCRIPT_DIR/../harness-provider-config.cjs"
  config="$(autoprompt_config_root omp)/config.yml"
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$helper" ] ||
     ! node "$helper" inspect --provider omp --file "$config" \
       --minimum 4 >/dev/null 2>&1; then
    printf 'activation-missing:recursion-depth'
    return 0
  fi
  printf 'complete'
}

deepseek_activation_status() {
  local root skill source target file
  root="$(autoprompt_config_root deepseek)"
  skill="$(autoprompt_runtime_root deepseek)"
  source="$skill/agent-preset"
  target="$root/.agent-presets/autoprompt"
  for file in agent.cordis.yml preset.yml; do
    if [ ! -f "$source/$file" ] || [ ! -f "$target/$file" ] ||
       ! cmp -s "$source/$file" "$target/$file"; then
      printf 'invalid:preset-mismatch'
      return 0
    fi
  done
  printf 'complete'
}

reasonix_activation_status() {
  local root skill profile name target count=0 helper config
  root="$(autoprompt_config_root reasonix)"
  skill="$(autoprompt_runtime_root reasonix)"
  for profile in "$skill/skills"/ap-*/SKILL.md; do
    [ -f "$profile" ] || continue
    count=$((count + 1))
    name="${profile%/SKILL.md}"; name="${name##*/}"
    target="$root/skills/$name/SKILL.md"
    if [ ! -f "$target" ] || ! cmp -s "$profile" "$target"; then
      printf 'invalid:profile-mismatch'
      return 0
    fi
  done
  [ "$count" -eq 25 ] || { printf 'missing:profiles'; return 0; }
  helper="$SCRIPT_DIR/../harness-provider-config.cjs"
  config="$root/config.toml"
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$helper" ] ||
     ! node "$helper" inspect --provider reasonix --file "$config" \
       --minimum 4 >/dev/null 2>&1; then
    printf 'activation-missing:recursion-depth'
    return 0
  fi
  printf 'complete'
}

# check_extras <client>: verify the exact hash-bound runtime inventory through the
# same manifest tool used by install and deployment. Prime returns na.
check_extras() {
  local client="$1" skill tool="$SCRIPT_DIR/../runtime-payload.cjs"
  case "$client" in
    claude|codex|opencode|kilo|grok|vscode|omp|deepseek|reasonix)
      skill="$(autoprompt_runtime_root "$client")"
      ;;
    *)        printf 'na'; return 0 ;;
  esac
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$tool" ]; then
    printf 'invalid:runtime-tool-unavailable'
    return 0
  fi
  local error_file error reason
  error_file="$(mktemp)"
  if node "$tool" --verify "$client" --destination "$skill" >/dev/null 2>"$error_file"; then
    rm -f "$error_file"
    if [ "$client" = "codex" ] && [ ! -f "$(autoprompt_profile_file codex)" ]; then
      printf 'missing:autoprompt.config.toml'
    elif [ "$client" = "claude" ]; then
      claude_native_status
    elif [ "$client" = "opencode" ]; then
      opencode_activation_status
    elif [ "$client" = "kilo" ]; then
      kilo_activation_status
    elif [ "$client" = "grok" ]; then
      grok_activation_status
    elif [ "$client" = "vscode" ]; then
      vscode_activation_status
    elif [ "$client" = "omp" ]; then
      omp_activation_status
    elif [ "$client" = "deepseek" ]; then
      deepseek_activation_status
    elif [ "$client" = "reasonix" ]; then
      reasonix_activation_status
    else
      printf 'complete'
    fi
    return 0
  fi
  error="$(cat "$error_file")"; rm -f "$error_file"
  reason="${error#runtime-payload: }"
  printf 'invalid:%s' "${reason// /-}"
}

receipt_owns_client() {
  local client="$1" root="$2" record target owned
  [ -f "$root/$AUTOPROMPT_RECEIPT_NAME" ] || return 1
  _uninstall_read_receipt "$root" >/dev/null 2>&1 || return 1
  record="$(resolve_destination "$client")" || return 1
  target="${record#client=* dest=}"; target="${target% format=*}"
  case "$target" in */) target="${target}SKILL.md" ;; esac
  for owned in "${UNINSTALL_RC_FILES[@]:-}"; do
    _idem_paths_equal "$owned" "$target" && return 0
  done
  return 1
}

legacy_codex_installed() {
  local root="$1" helper
  _idem_paths_equal "$root" "$(config_root codex)" || return 1
  command -v node >/dev/null 2>&1 || return 1
  helper="$REPO_ROOT/scripts/install/legacy-compat.cjs"
  node "$helper" match codex "$root" >/dev/null 2>&1
}

# probe_client <client>: echo "<detected> <installed> <verifies> <detail>" where each
# of the first three is yes/no and detail carries the version, verify reason, and the
# extras completeness (full runtime set for claude/codex).
probe_client() {
  local client="$1"
  if [ "$client" = prime ]; then
    local root helper det_rec version="-" detected="no" installed="no"
    local verifies="no" reason="-" extras="invalid:prime-lifecycle" output rc prime_cli=""
    root="$(config_root prime)"
    helper="$SCRIPT_DIR/prime-lifecycle.cjs"
    if det_rec="$(detect_client prime 2>/dev/null)"; then
      detected="yes"
      version="${det_rec##*version=}"
      prime_cli="$(type -P -- "${AUTOPROMPT_CLIENT_BIN[prime]}" 2>/dev/null)" || prime_cli=""
    fi
    [ -f "$root/.autoprompt-prime-install.json" ] && installed="yes"
    if ! command -v node >/dev/null 2>&1 || [ ! -f "$helper" ] || {
      [ "$detected" = yes ] && [ -z "$prime_cli" ]
    }; then
      reason="runtime-unavailable"
    else
      if [ "$detected" = yes ]; then
        output="$(node "$helper" doctor --repo-root "$REPO_ROOT" \
          --prime-cli "$prime_cli" 2>&1)"
      else
        output="$(node "$helper" doctor --repo-root "$REPO_ROOT" 2>&1)"
      fi
      rc=$?
      if [ "$rc" -eq 0 ]; then
        verifies="yes"
        extras="complete"
      else
        reason="$(printf '%s' "$output" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' | head -n 1)"
        [ -n "$reason" ] || reason="prime-lifecycle-invalid"
      fi
    fi
    if [ "$detected" = yes ] && [ "$version" != 0.7.2 ]; then
      verifies="no"
      reason="version-mismatch"
      extras="invalid:version-mismatch"
    fi
    printf '%s %s %s version=%s reason=%s extras=%s' \
      "$detected" "$installed" "$verifies" "$version" "$reason" "$extras"
    return 0
  fi
  local root; root="$(config_root "$client")"
  local support reason
  support="$(provider_status "$client")" || support=""

  local det_rec version="-" detected="no"
  if det_rec="$(detect_client "$client" 2>/dev/null)"; then
    detected="yes"
    version="${det_rec##*version=}"
  fi

  local installed="no" legacy=0
  receipt_owns_client "$client" "$root" && installed="yes"
  if [ "$installed" = no ] && [ "$client" = codex ] && legacy_codex_installed "$root"; then
    installed="yes"
    legacy=1
  fi

  local verifies="no"
  reason="-"
  case "$support" in
    blocked|retired|unverified)
      reason="$(provider_block_reason "$client")"
      printf '%s %s no version=%s reason=%s extras=%s support=%s' \
        "$detected" "$installed" "$version" "$reason" "$support" "$support"
      return 0
      ;;
  esac
  if [ "$legacy" -eq 1 ]; then
    printf '%s %s no version=%s reason=%s extras=%s' \
      "$detected" "$installed" "$version" older-install older-install
    return 0
  fi
  if verify_install "$client" >/dev/null 2>&1; then
    verifies="yes"
  else
    # Re-run capturing stderr to surface the named reason (absent / unparseable / ...).
    local verr; verr="$(verify_install "$client" 2>&1 >/dev/null)"
    reason="${verr##*reason=}"; reason="${reason%% *}"
    [ -z "$reason" ] && reason="-"
  fi

  local extras; extras="$(check_extras "$client")"

  printf '%s %s %s version=%s reason=%s extras=%s' \
    "$detected" "$installed" "$verifies" "$version" "$reason" "$extras"
}

main() {
  local strict=0 target=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --strict) strict=1 ;;
      *)
        if [ -n "$target" ]; then
          printf 'Usage: %s [--strict] [client]\n' "$(basename "$0")" >&2
          return 2
        fi
        target="$1"
        ;;
    esac
    shift
  done

  test_autoprompt_install_root_contract "$target" || return 2

  printf '==== Autoprompt doctor ====\n'
  printf '%-9s %-9s %-10s %-10s %s\n' "client" "detected" "installed" "verifies" "detail"
  printf -- '---------------------------------------------------------------\n'
  local c fields detected installed verifies detail extras known=0 strict_failed=0
  local clients=("${CLIENTS_ALL[@]}")
  if [ -n "$target" ]; then
    for c in "${CLIENTS_ALL[@]}"; do [ "$c" = "$target" ] && known=1; done
    if [ "$known" -eq 0 ]; then
      printf 'Autoprompt doctor: unknown client %s.\n' "$target" >&2
      return 2
    fi
    clients=("$target")
  fi
  for c in "${clients[@]}"; do
    fields="$(probe_client "$c")"
    detected="${fields%% *}"; fields="${fields#* }"
    installed="${fields%% *}"; fields="${fields#* }"
    verifies="${fields%% *}"; detail="${fields#* }"
    printf '%-9s %-9s %-10s %-10s %s\n' "$c" "$detected" "$installed" "$verifies" "$detail"
    extras="${detail#*extras=}"; extras="${extras%% *}"
    if [ "$strict" -eq 1 ] && {
      [ "$detected" != yes ] || [ "$installed" != yes ] ||
      [ "$verifies" != yes ] || { [ "$extras" != complete ] && [ "$extras" != na ]; }
    }; then
      strict_failed=1
    fi
  done
  printf '============================\n'
  [ "$strict_failed" -eq 0 ]
}

main "$@"
