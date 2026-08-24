#!/usr/bin/env bash
# install.sh - runnable entry point that installs Autoprompt for one client or all.
#
# THIN ORCHESTRATOR over the sourced library (lib/install-lib.sh). It reads the skill
# payload, strips its source frontmatter, and drives the library's public pipeline:
#
#   precheck_install -> install_idempotent -> (codex only) configedit_codex_agents
#                    -> write_receipt -> verify_install
#
# It owns NONE of the install mechanics; every byte and every verdict comes from the
# library. It adds only: payload loading, the per-client config-root + nonce, the codex
# config-file path, the absent-client SKIP, and the PASS/SKIP/FAIL matrix.
#
# RECEIPT MODEL (load-bearing): the library writes ONE receipt per CONFIG-ROOT and
# accumulates created files into module-scope arrays (AUTOPROMPT_RECEIPT_FILES/EDITS).
# Several clients can share a root ($HOME for claude/codex/cursor/roo/gemini/cline/goose;
# the XDG base for opencode/kilo). So `all` accumulates every client landing under a
# root, then writes that root's receipt ONCE at the end - otherwise a per-client receipt
# would overwrite its predecessor and strand files from uninstall. Because the library
# accumulates into module arrays, its mutators MUST run in THIS shell, never in $(...)
# (a subshell would discard the accumulation) - records are captured via temp files.
#
# Test isolation (F-OP-TESTISO): HOME and XDG_CONFIG_HOME are honored if already set, so
# a test can point them at a temp dir. Nothing here hardcodes the real home.
#
# Exit status: 0 iff nothing attempted FAILED (pure skips still exit 0); non-zero if any
# attempted install FAILED.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/install-lib.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ ! -f "$LIB" ]; then
  printf 'Autoprompt install: library not found at %s - is the repo intact?\n' "$LIB" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$LIB"

CLIENTS_ALL=(claude codex opencode kilo vscode prime omp deepseek reasonix hermes)

# Per-run result rows for the matrix (RESULT=/SKIP= lines), filled in this shell.
RESULT_ROWS=()
ANY_FAIL=0
RETAINED_RECOVERY=0
LEGACY_CODEX_RECOVERY_NAME='.autoprompt-legacy-codex-recovery'
AUTOPROMPT_LEGACY_CODEX_RECOVERY=''

install_exit_code() {
  if [ "$RETAINED_RECOVERY" -eq 1 ]; then
    printf '77'
    return
  fi
  printf '%s' "$ANY_FAIL"
}

usage() {
  printf 'Usage: %s <client>|all\n' "$(basename "$0")" >&2
  printf '  clients: %s\n' "${CLIENTS_ALL[*]}" >&2
}

mint_nonce() {
  printf 'CL-%s-%s-%s' "$(date +%Y%m%d%H%M%S)" "$$" "${RANDOM}${RANDOM}"
}

payload_file() {
  local client="$1"
  case "$client" in
    claude)   printf '%s' "$REPO_ROOT/agents/claude/SKILL.md" ;;
    codex)    printf '%s' "$REPO_ROOT/agents/codex/SKILL.md" ;;
    opencode) printf '%s' "$REPO_ROOT/agents/opencode/SKILL.md" ;;
    kilo)     printf '%s' "$REPO_ROOT/agents/kilo/SKILL.md" ;;
    vscode)   printf '%s' "$REPO_ROOT/agents/vscode/SKILL.md" ;;
    omp)      printf '%s' "$REPO_ROOT/agents/omp/SKILL.md" ;;
    deepseek) printf '%s' "$REPO_ROOT/agents/deepseek/SKILL.md" ;;
    reasonix) printf '%s' "$REPO_ROOT/agents/reasonix/SKILL.md" ;;
    hermes)   printf '%s' "$REPO_ROOT/agents/hermes/SKILL.md" ;;
    *) return 1 ;;
  esac
}

# payload_body <file>: the skill body with its source frontmatter STRIPPED (format_skill
# refuses a body that still carries a --- fence, code 6). Raw UTF-8 so glyphs survive.
payload_body() {
  python - "$1" <<'PY'
import sys
text = open(sys.argv[1], encoding="utf-8").read()
parts = text.split("---\n")
body = "---\n".join(parts[2:]) if len(parts) >= 3 else text
sys.stdout.buffer.write(body.encode("utf-8"))
PY
}

# payload_field <file> <key>: a top-level frontmatter scalar via the real YAML parser, so
# a single-quoted multi-line description round-trips exactly into what we hand the library.
payload_field() {
  python - "$1" "$2" <<'PY'
import sys, yaml
text = open(sys.argv[1], encoding="utf-8").read()
fm = yaml.safe_load(text.split("---\n")[1])
sys.stdout.buffer.write(str(fm[sys.argv[2]]).encode("utf-8"))
PY
}

# config_root <client>: the directory the receipt + manifest live in, derived with the
# SAME base math resolve_destination uses.
config_root() {
  local client="$1"
  autoprompt_config_root "$client"
}

install_prime_lifecycle() {
  local helper="$SCRIPT_DIR/prime-lifecycle.cjs" output rc destination prime_cli
  prime_cli="$(type -P -- "${AUTOPROMPT_CLIENT_BIN[prime]}" 2>/dev/null)" || prime_cli=""
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$helper" ] || [ -z "$prime_cli" ]; then
    printf '%s\n' \
      'Autoprompt install (prime): node or the Prime lifecycle helper is missing.' >&2
    RESULT_ROWS+=("RESULT=FAIL client=prime stage=runtime")
    ANY_FAIL=1
    return 1
  fi
  output="$(node "$helper" install --repo-root "$REPO_ROOT" --prime-cli "$prime_cli")"
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$output" ]; then
    printf 'Autoprompt install (prime): failed (code %s).\n' "$rc" >&2
    RESULT_ROWS+=("RESULT=FAIL client=prime stage=lifecycle")
    ANY_FAIL=1
    return 1
  fi
  destination="$(node -e \
    'const value=JSON.parse(process.argv[1]); process.stdout.write(value.health.packageRoot)' \
    "$output" 2>/dev/null)" || destination=""
  if [ -z "$destination" ]; then
    printf '%s\n' 'Autoprompt install (prime): invalid lifecycle result.' >&2
    RESULT_ROWS+=("RESULT=FAIL client=prime stage=lifecycle-output")
    ANY_FAIL=1
    return 1
  fi
  printf 'Autoprompt install (prime): PASS - landed %s (48 files, rlmMaxDepth=4).\n' \
    "$destination" >&2
  RESULT_ROWS+=("RESULT=PASS client=prime dest=$destination format=prime-package detail=files=48")
}

# codex_config_file, extras source + destination helpers.
codex_home() {
  autoprompt_config_root codex
}

codex_profile_file() {
  autoprompt_profile_file codex
}

codex_agents_dir() {
  autoprompt_native_agents_root codex
}

stage_codex_agents() {
  local skill_dir="$1" source="$2" stage_agents="$3" stage_profile="$4"
  CODEX_AGENTS_DIR="$stage_agents" node \
    "$skill_dir/workflow/codex-agent-casting.js" --export-inheritance \
    --source-agents "$source" --agents-dir "$stage_agents" \
    --selector off >/dev/null || return 91
  CODEX_AGENTS_DIR="$stage_agents" node \
    "$skill_dir/workflow/codex-agent-casting.js" --resolve \
    --agents-dir "$stage_agents" --selector off >/dev/null || return 91
  node "$skill_dir/workflow/codex-agent-profile.js" --write \
    --agents-dir "$stage_agents" --profile "$stage_profile" \
    >/dev/null || return 92
}

land_codex_agents() {
  local root="$1" stage_agents="$2" stage_profile="$3"
  local target="$4" profile="$5" file had_nullglob
  case "$(shopt nullglob)" in *on) had_nullglob=1 ;; *) had_nullglob=0 ;; esac
  shopt -s nullglob
  for file in "$stage_agents"/ap-*.toml \
              "$stage_agents"/.autoprompt-casting.json; do
    if ! _idem_install_managed_file \
      "$root" "$file" "$target/${file##*/}" 1; then
      [ "$had_nullglob" -eq 0 ] && shopt -u nullglob
      return 93
    fi
  done
  [ "$had_nullglob" -eq 0 ] && shopt -u nullglob
  _idem_install_managed_file "$root" "$stage_profile" "$profile" 1 || return 93
}

install_codex_agents() {
  local root source skill_dir stage stage_agents stage_profile target profile rc
  root="$(config_root codex)"
  source="$REPO_ROOT/agents/claude/agents"
  skill_dir="$(extras_skill_dir codex)"
  stage="$(mktemp -d 2>/dev/null)" || return 90
  target="$(codex_agents_dir)"
  profile="$(codex_profile_file)"
  stage_agents="$stage/root/skills/autoprompt/agents-runtime"
  stage_profile="$stage/root/autoprompt.config.toml"
  if ! command -v node >/dev/null 2>&1; then
    rm -rf -- "$stage"
    printf 'Autoprompt install (codex): node is required to export and bind custom agents.\n' >&2
    return 90
  fi
  stage_codex_agents "$skill_dir" "$source" "$stage_agents" "$stage_profile"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    land_codex_agents "$root" "$stage_agents" "$stage_profile" "$target" "$profile"
    rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    node "$skill_dir/workflow/codex-agent-profile.js" --verify \
      --agents-dir "$target" --profile "$profile" >/dev/null || rc=92
  fi
  rm -rf -- "$stage"
  return "$rc"
}

# extras_src_dir <client>: the repo CLI dir whose GATES/PLAYBOOKS/MODES/frameworks/
# workflow/agents feed install_extras. Only claude + codex ship the runtime set;
# every other client stays single-file (SKILL.md only). Empty => no extras.
extras_src_dir() {
  local client="$1"
  case "$client" in
    claude)   printf '%s' "$REPO_ROOT/agents/claude" ;;
    codex)    printf '%s' "$REPO_ROOT/agents/codex" ;;
    opencode) printf '%s' "$REPO_ROOT/agents/opencode" ;;
    kilo)     printf '%s' "$REPO_ROOT/agents/kilo" ;;
    vscode)   printf '%s' "$REPO_ROOT/agents/vscode" ;;
    omp)      printf '%s' "$REPO_ROOT/agents/omp" ;;
    deepseek) printf '%s' "$REPO_ROOT/agents/deepseek" ;;
    reasonix) printf '%s' "$REPO_ROOT/agents/reasonix" ;;
    hermes)   printf '%s' "$REPO_ROOT/agents/hermes" ;;
    *)        printf '%s' "" ;;
  esac
}

# extras_skill_dir <client>: the directory SKILL.md lands in for a client that ships
# extras (…/skills/autoprompt), derived with the SAME base math resolve_destination
# uses so the extras land beside the skill.
extras_skill_dir() {
  local client="$1"
  autoprompt_runtime_root "$client" 2>/dev/null || printf '%s' ""
}

# extras_agents_dir <client>: the native agent load path for clients that register
# personas outside the private skill payload.
extras_agents_dir() {
  local client="$1"
  case "$client" in
    claude|vscode|omp) autoprompt_native_agents_root "$client" ;;
    *)      printf '%s' "" ;;
  esac
}

verify_deepseek_activation() {
  local root source target file
  root="$(config_root deepseek)"
  source="$(extras_skill_dir deepseek)/agent-preset"
  target="$root/.agent-presets/autoprompt"
  for file in agent.cordis.yml preset.yml; do
    [ -f "$source/$file" ] && [ -f "$target/$file" ] &&
      cmp -s "$source/$file" "$target/$file" || return 1
  done
}

install_deepseek_activation() {
  local root source target file code
  root="$(config_root deepseek)"
  source="$(extras_skill_dir deepseek)/agent-preset"
  target="$root/.agent-presets/autoprompt"
  for file in agent.cordis.yml preset.yml; do
    [ -f "$source/$file" ] || return 1
    _idem_install_managed_file "$root" "$source/$file" "$target/$file" 1
    code=$?; [ "$code" -eq 0 ] || return "$code"
  done
  verify_deepseek_activation
}

harness_provider_config_helper() {
  printf '%s' "$REPO_ROOT/scripts/harness-provider-config.cjs"
}

harness_provider_config_file() {
  local provider="$1" root
  root="$(config_root "$provider")"
  case "$provider" in
    omp) printf '%s' "$root/config.yml" ;;
    reasonix) printf '%s' "$root/config.toml" ;;
    *) return 1 ;;
  esac
}

harness_provider_config_key() {
  case "$1" in
    omp) printf '%s' 'task.maxRecursionDepth' ;;
    reasonix) printf '%s' 'agent.max_subagent_depth' ;;
    *) return 1 ;;
  esac
}

verify_harness_provider_depth() {
  local provider="$1" helper file
  helper="$(harness_provider_config_helper)"
  file="$(harness_provider_config_file "$provider")" || return 1
  command -v node >/dev/null 2>&1 && [ -f "$helper" ] &&
    node "$helper" inspect --provider "$provider" --file "$file" \
      --minimum 4 >/dev/null
}

install_harness_provider_depth() {
  local provider="$1" root helper file key backup stage desired original record code
  local prior packed edit_file rest edit_key edit_prior existing=0 separator=$'\037'
  root="$(config_root "$provider")"
  helper="$(harness_provider_config_helper)"
  file="$(harness_provider_config_file "$provider")" || return 98
  key="$(harness_provider_config_key "$provider")" || return 98
  backup="$file$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX"
  command -v node >/dev/null 2>&1 && [ -f "$helper" ] || return 98
  stage="$(mktemp -d 2>/dev/null)" || return 98
  desired="$stage/desired"; original="$stage/original"
  record="$(node "$helper" plan --provider "$provider" --file "$file" \
    --desired "$desired" --original "$original" --minimum 4)"
  code=$?
  if [ "$code" -ne 0 ]; then
    rm -rf -- "$stage" 2>/dev/null
    return 98
  fi
  case "$record" in
    status=noop*)
      rm -rf -- "$stage" 2>/dev/null
      verify_harness_provider_depth "$provider"
      return $?
      ;;
    status=applied*)
      prior="${record#* prior=}"; prior="${prior%% *}"
      ;;
    *)
      rm -rf -- "$stage" 2>/dev/null
      return 98
      ;;
  esac
  for packed in "${AUTOPROMPT_RECEIPT_EDITS[@]:-}"; do
    [ -n "$packed" ] || continue
    edit_file="${packed%%$separator*}"; rest="${packed#*$separator}"
    edit_key="${rest%%$separator*}"; rest="${rest#*$separator}"
    edit_prior="${rest#*$separator}"
    if _idem_paths_equal "$edit_file" "$file" && [ "$edit_key" = "$key" ]; then
      existing=$((existing + 1))
      [ "$edit_prior" = "$AUTOPROMPT_RECEIPT_ABSENT" ] || prior="$edit_prior"
    fi
  done
  if [ "$existing" -gt 1 ] ||
     { [ "$existing" -eq 1 ] && [ "$prior" != absent-file ] && [ ! -f "$backup" ]; }; then
    rm -rf -- "$stage" 2>/dev/null
    return 98
  fi
  if [ ! -f "$backup" ] && [ -f "$original" ]; then
    _idem_install_managed_file "$root" "$original" "$backup" 1 0 0
    code=$?
    if [ "$code" -ne 0 ]; then
      rm -rf -- "$stage" 2>/dev/null
      return "$code"
    fi
  fi
  _idem_install_managed_file "$root" "$desired" "$file" 1 0 1
  code=$?
  if [ "$code" -ne 0 ]; then
    rm -rf -- "$stage" 2>/dev/null
    return "$code"
  fi
  if [ "$existing" -eq 0 ]; then
    AUTOPROMPT_RECEIPT_EDITS+=(
      "$file$separator$key${separator}4$separator$prior"
    )
  fi
  [ ! -f "$backup" ] || AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="$backup"
  rm -rf -- "$stage" 2>/dev/null
  verify_harness_provider_depth "$provider"
}

verify_hermes_activation() {
  local root source profile name target count=0
  root="$(config_root hermes)"
  source="$(extras_skill_dir hermes)/skills"
  for profile in "$source"/ap-*/SKILL.md; do
    [ -f "$profile" ] || continue
    count=$((count + 1))
    name="${profile%/SKILL.md}"; name="${name##*/}"
    target="$root/skills/$name/SKILL.md"
    [ -f "$target" ] && cmp -s "$profile" "$target" || return 1
  done
  [ "$count" -eq 25 ]
}

verify_reasonix_activation() {
  local root source profile name target count=0
  root="$(config_root reasonix)"
  source="$(extras_skill_dir reasonix)/skills"
  for profile in "$source"/ap-*/SKILL.md; do
    [ -f "$profile" ] || continue
    count=$((count + 1))
    name="${profile%/SKILL.md}"; name="${name##*/}"
    target="$root/skills/$name/SKILL.md"
    [ -f "$target" ] && cmp -s "$profile" "$target" || return 1
  done
  [ "$count" -eq 25 ]
}

function install_reasonix_activation() {
  local root source profile name target count=0 code
  root="$(config_root reasonix)"
  source="$(extras_skill_dir reasonix)/skills"
  for profile in "$source"/ap-*/SKILL.md; do
    [ -f "$profile" ] || continue
    count=$((count + 1))
    name="${profile%/SKILL.md}"; name="${name##*/}"
    target="$root/skills/$name/SKILL.md"
    _idem_install_managed_file "$root" "$profile" "$target" 1
    code=$?; [ "$code" -eq 0 ] || return "$code"
  done
  [ "$count" -eq 25 ] && verify_reasonix_activation &&
    install_harness_provider_depth reasonix
}

function install_hermes_activation() {
  local root source profile name target count=0 code
  root="$(config_root hermes)"
  source="$(extras_skill_dir hermes)/skills"
  for profile in "$source"/ap-*/SKILL.md; do
    [ -f "$profile" ] || continue
    count=$((count + 1))
    name="${profile%/SKILL.md}"; name="${name##*/}"
    target="$root/skills/$name/SKILL.md"
    _idem_install_managed_file "$root" "$profile" "$target" 1
    code=$?; [ "$code" -eq 0 ] || return "$code"
  done
  [ "$count" -eq 25 ] && verify_hermes_activation
}

verify_vscode_activation() {
  local source_dir target_dir source_agent landed agents=0 status
  source_dir="$(extras_skill_dir vscode)/agents"
  target_dir="$(extras_agents_dir vscode)"
  for source_agent in "$source_dir"/ap-*.agent.md; do
    [ -f "$source_agent" ] || continue
    agents=$((agents + 1))
    landed="$target_dir/${source_agent##*/}"
    if [ ! -f "$landed" ] || ! cmp -s "$source_agent" "$landed"; then
      printf '%s\n' "client=vscode verify=fail reason=agent-mismatch agent=${source_agent##*/}" >&2
      return 1
    fi
  done
  if [ "$agents" -ne 25 ]; then
    printf '%s\n' "client=vscode verify=fail reason=agent-count found=$agents expected=25" >&2
    return 1
  fi
  status="$(vscode_settings_status 2>&1)"
  if [ "$?" -ne 0 ]; then
    printf '%s\n' "client=vscode verify=fail reason=activation-missing detail=${status// /-}" >&2
    return 1
  fi
}

install_vscode_activation() {
  local root settings backup helper record prior separator=$'\037'
  local source_dir native_dir persona stage desired original managed_code agents=0
  root="$(config_root vscode)"
  settings="$(vscode_settings_file)"
  backup="$settings$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX"
  helper="$(vscode_settings_helper)"
  if [ ! -f "$helper" ] || ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'client=vscode error=activation-missing reason=settings-helper-unavailable' >&2
    return 98
  fi
  source_dir="$(extras_skill_dir vscode)/agents"
  native_dir="$(extras_agents_dir vscode)"
  stage="$(mktemp -d 2>/dev/null)" || return 98
  desired="$stage/settings.json"
  original="$stage/settings.original.json"
  if ! record="$(node "$helper" stage --file "$settings" \
      --output "$desired" --original "$original" 2>&1)"; then
    rm -rf -- "$stage" 2>/dev/null
    printf '%s\n' "client=vscode error=activation-missing detail=${record// /-}" >&2
    return 98
  fi

  for persona in "$source_dir"/ap-*.agent.md; do
    [ -f "$persona" ] || continue
    agents=$((agents + 1))
    _idem_install_managed_file \
      "$root" "$persona" "$native_dir/${persona##*/}" 1
    managed_code=$?
    if [ "$managed_code" -ne 0 ]; then
      rm -rf -- "$stage" 2>/dev/null
      printf '%s\n' "client=vscode error=activation-missing detail=agent-batch-code-$managed_code" >&2
      return 98
    fi
  done
  if [ "$agents" -ne 25 ]; then
    rm -rf -- "$stage" 2>/dev/null
    printf '%s\n' "client=vscode error=activation-missing detail=agent-count-$agents" >&2
    return 98
  fi

  case "$record" in
    status=applied*)
      prior="${record#* prior=}"
      prior="${prior%% *}"
      if [ -f "$original" ]; then
        _idem_install_managed_file "$root" "$original" "$backup" 1 0 0
        managed_code=$?
        if [ "$managed_code" -ne 0 ]; then
          rm -rf -- "$stage" 2>/dev/null
          printf '%s\n' "client=vscode error=activation-missing detail=backup-batch-code-$managed_code" >&2
          return 98
        fi
      fi
      _idem_install_managed_file "$root" "$desired" "$settings" 1 0 1
      managed_code=$?
      if [ "$managed_code" -ne 0 ]; then
        rm -rf -- "$stage" 2>/dev/null
        printf '%s\n' "client=vscode error=activation-missing detail=settings-batch-code-$managed_code" >&2
        return 98
      fi
      [ "$prior" != absent ] || prior="$AUTOPROMPT_RECEIPT_ABSENT"
      AUTOPROMPT_RECEIPT_EDITS+=(
        "$settings$separator$AUTOPROMPT_VSCODE_ACTIVATION_KEY${separator}true$separator$prior"
      )
      [ ! -f "$backup" ] || AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="$backup"
      ;;
    status=noop*) ;;
    *)
      rm -rf -- "$stage" 2>/dev/null
      printf '%s\n' 'client=vscode error=activation-missing detail=settings-stage-invalid-result' >&2
      return 98
      ;;
  esac
  rm -rf -- "$stage" 2>/dev/null
  verify_vscode_activation || return 99
}

opencode_config_dir() {
  dirname -- "$(autoprompt_profile_file opencode)"
}

opencode_agents_dir() {
  autoprompt_native_agents_root opencode
}

opencode_profile_file() {
  autoprompt_profile_file opencode
}

kilo_config_dir() {
  dirname -- "$(autoprompt_profile_file kilo)"
}

kilo_agents_dir() {
  autoprompt_native_agents_root kilo
}

kilo_profile_file() {
  autoprompt_profile_file kilo
}

verify_kilo_activation() {
  local source_dir target_dir source_agent landed agents=0
  source_dir="$(extras_skill_dir kilo)/agents"
  target_dir="$(kilo_agents_dir)"
  for source_agent in "$source_dir"/ap-*.md; do
    [ -f "$source_agent" ] || continue
    agents=$((agents + 1))
    landed="$target_dir/${source_agent##*/}"
    if [ ! -f "$landed" ] || ! cmp -s "$source_agent" "$landed"; then
      printf '%s\n' "client=kilo verify=fail reason=agent-mismatch agent=${source_agent##*/}" >&2
      return 1
    fi
  done
  if [ "$agents" -ne 25 ]; then
    printf '%s\n' "client=kilo verify=fail reason=agent-count found=$agents expected=25" >&2
    return 1
  fi
  validate_kilo_profile "$(kilo_profile_file)" || {
    printf '%s\n' "client=kilo verify=fail reason=profile-invalid" >&2
    return 1
  }
}

install_kilo_activation() {
  local root source_dir target_dir profile source_agent landed agents=0
  root="$(config_root kilo)"
  source_dir="$(extras_skill_dir kilo)/agents"
  target_dir="$(kilo_agents_dir)"
  profile="$(kilo_profile_file)"
  for source_agent in "$source_dir"/ap-*.md; do
    [ -f "$source_agent" ] || continue
    agents=$((agents + 1))
  done
  if [ "$agents" -ne 25 ] ||
     ! validate_kilo_profile "$(extras_skill_dir kilo)/autoprompt.kilo.json"; then
    printf 'Autoprompt install (kilo): activation payload is incomplete under %s.\n' "$(extras_skill_dir kilo)" >&2
    return 95
  fi
  for source_agent in "$source_dir"/ap-*.md; do
    landed="$target_dir/${source_agent##*/}"
    _idem_install_managed_file "$root" "$source_agent" "$landed" 1 || return 96
  done
  _idem_install_managed_file "$root" \
    "$(extras_skill_dir kilo)/autoprompt.kilo.json" "$profile" 1 || return 96
  verify_kilo_activation || return 97
}

validate_opencode_profile() {
  python - "$1" <<'PY' >/dev/null 2>&1
import json, sys
try:
    profile = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    sys.exit(1)
permission = profile.get('permission')
task = permission.get('task') if isinstance(permission, dict) else None
ok = (isinstance(profile, dict)
      and set(profile) == {'$schema', 'subagent_depth', 'share', 'permission'}
      and profile['$schema'] == 'https://opencode.ai/config.json'
      and type(profile['subagent_depth']) is int
      and profile['subagent_depth'] == 4
      and type(profile['share']) is str and profile['share'] == 'disabled'
      and isinstance(permission, dict) and set(permission) == {'task'}
      and isinstance(task, dict)
      and set(task) == {'*', 'ap-*'} and task['*'] == 'deny'
      and task['ap-*'] == 'allow')
sys.exit(0 if ok else 1)
PY
}

verify_opencode_activation() {
  local source_dir target_dir source_agent landed agents=0
  source_dir="$(extras_skill_dir opencode)/agents"
  target_dir="$(opencode_agents_dir)"
  for source_agent in "$source_dir"/ap-*.md; do
    [ -f "$source_agent" ] || continue
    agents=$((agents + 1))
    landed="$target_dir/${source_agent##*/}"
    if [ ! -f "$landed" ] || ! cmp -s "$source_agent" "$landed"; then
      printf '%s\n' "client=opencode verify=fail reason=agent-mismatch agent=${source_agent##*/}" >&2
      return 1
    fi
  done
  if [ "$agents" -ne 25 ]; then
    printf '%s\n' "client=opencode verify=fail reason=agent-count found=$agents expected=25" >&2
    return 1
  fi
  validate_opencode_profile "$(opencode_profile_file)"
  local rc=$?
  [ "$rc" -eq 0 ] || printf '%s\n' "client=opencode verify=fail reason=profile-invalid" >&2
  return "$rc"
}

install_opencode_activation() {
  local root source_dir target_dir profile source_agent landed agents=0
  root="$(config_root opencode)"
  source_dir="$(extras_skill_dir opencode)/agents"
  target_dir="$(opencode_agents_dir)"
  profile="$(opencode_profile_file)"
  for source_agent in "$source_dir"/ap-*.md; do
    [ -f "$source_agent" ] || continue
    agents=$((agents + 1))
  done
  if [ "$agents" -ne 25 ] || [ ! -f "$(extras_skill_dir opencode)/autoprompt.opencode.json" ]; then
    printf 'Autoprompt install (opencode): activation payload is incomplete under %s.\n' "$(extras_skill_dir opencode)" >&2
    return 95
  fi
  for source_agent in "$source_dir"/ap-*.md; do
    [ -f "$source_agent" ] || continue
    landed="$target_dir/${source_agent##*/}"
    if ! _idem_install_managed_file "$root" "$source_agent" "$landed" 1; then
      printf 'Autoprompt install (opencode): could not land native subagent %s.\n' "$landed" >&2
      return 96
    fi
  done
  if ! _idem_install_managed_file "$root" \
    "$(extras_skill_dir opencode)/autoprompt.opencode.json" "$profile" 1; then
    printf 'Autoprompt install (opencode): could not land activation profile %s.\n' "$profile" >&2
    return 96
  fi
  verify_opencode_activation || return 97
}

# canonical_legacy_path <path>: normalize an absolute receipt path for comparison.
# Git Bash needs cygpath to converge C:\... and /c/...; other shells compare normalized
# separators and fail closed when the path is not absolute.
canonical_legacy_path() {
  local value="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -alm -- "$value" 2>/dev/null | tr '[:upper:]' '[:lower:]'
    return ${PIPESTATUS[0]}
  fi
  value="${value//\\//}"
  case "$value" in
    /*) ;;
    [A-Za-z]:/*) value="$(printf '%s' "${value:0:1}" | tr '[:upper:]' '[:lower:]')${value:1}" ;;
    *) return 1 ;;
  esac
  while [[ "$value" == *//* ]]; do value="${value//\/\//\/}"; done
  printf '%s' "${value%/}"
}

prune_stale_opencode_agents() {
  local root target_dir source_dir canonical_target file candidate source_name native_file
  root="$(config_root opencode)"
  target_dir="$(opencode_agents_dir)"
  source_dir="$(extras_skill_dir opencode)/agents"
  [ -d "$target_dir" ] || return 0
  canonical_target="$(canonical_legacy_path "$target_dir")" || return 0
  local -a owned_files=("${AUTOPROMPT_RECEIPT_FILES[@]:-}")
  for file in "${owned_files[@]:-}"; do
    candidate="$(canonical_legacy_path "$file")" || candidate=""
    [ -n "$candidate" ] || continue
    [ "${candidate%/*}" = "$canonical_target" ] || continue
    case "${candidate##*/}" in ap-*.md) ;; *) continue ;; esac
    source_name="${candidate##*/}"
    [ -f "$source_dir/$source_name" ] && continue
    native_file="$file"
    command -v cygpath >/dev/null 2>&1 && native_file="$(cygpath -u -- "$file")"
    if ! _idem_remove_managed_file "$root" "$native_file" "$file"; then
      printf 'Autoprompt install (opencode): could not prune receipt-owned stale subagent %s.\n' "$native_file" >&2
      return 94
    fi
  done
}

prune_stale_kilo_agents() {
  local root target_dir source_dir canonical_target file candidate source_name native_file
  root="$(config_root kilo)"
  target_dir="$(kilo_agents_dir)"
  source_dir="$(extras_skill_dir kilo)/agents"
  [ -d "$target_dir" ] || return 0
  canonical_target="$(canonical_legacy_path "$target_dir")" || return 0
  local -a owned_files=("${AUTOPROMPT_RECEIPT_FILES[@]:-}")
  for file in "${owned_files[@]:-}"; do
    candidate="$(canonical_legacy_path "$file")" || candidate=""
    [ -n "$candidate" ] || continue
    [ "${candidate%/*}" = "$canonical_target" ] || continue
    case "${candidate##*/}" in ap-*.md) ;; *) continue ;; esac
    source_name="${candidate##*/}"
    [ -f "$source_dir/$source_name" ] && continue
    native_file="$file"
    command -v cygpath >/dev/null 2>&1 && native_file="$(cygpath -u -- "$file")"
    if ! _idem_remove_managed_file "$root" "$native_file" "$file"; then
      printf 'Autoprompt install (kilo): could not prune receipt-owned stale subagent %s.\n' "$native_file" >&2
      return 94
    fi
  done
}

# migrate_legacy_activation <client> <root>: remove only legacy global persona files
# and Codex base-config edits explicitly owned by the existing receipt. Unowned ap-*
# roles are never touched. The receipt remains until the new private payload is sealed.
_migrate_restore_codex_config() {
  local index
  [ "${#UNINSTALL_RC_EDIT_FILE[@]}" -gt 0 ] || return 0
  if command -v cygpath >/dev/null 2>&1; then
    for ((index = 0; index < ${#UNINSTALL_RC_EDIT_FILE[@]}; index++)); do
      UNINSTALL_RC_EDIT_FILE[index]="$(
        cygpath -u -- "${UNINSTALL_RC_EDIT_FILE[index]}"
      )"
    done
  fi
  _uninstall_restore_configedits || return $?
  AUTOPROMPT_RECEIPT_EDITS=()
  AUTOPROMPT_CONFIGEDIT_LAST_BACKUP=none
}

legacy_codex_ownership_state() {
  local root="$1" output_name="$2" helper
  local -n out="$output_name"
  local -a owned=()
  out=()
  _idem_paths_equal "$root" "$(config_root codex)" || return 1
  helper="$REPO_ROOT/scripts/install/legacy-compat.cjs"
  mapfile -d '' -t owned < <(node "$helper" files0 codex "$root" 2>/dev/null)
  [ "${#owned[@]}" -gt 0 ] || return 1
  out=("${owned[@]}")
}

_migrate_legacy_roles() {
  local client="$1" root="$2" expected_parent file native_file canonical_file
  local canonical_parent basename is_legacy
  local -a retained=()
  expected_parent="$(canonical_legacy_path "$(codex_home)/agents")" || return 0
  for file in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
    native_file="$file"
    if command -v cygpath >/dev/null 2>&1; then
      native_file="$(cygpath -u -- "$file")"
    fi
    canonical_file="$(canonical_legacy_path "$file")" || canonical_file=""
    canonical_parent="${canonical_file%/*}"
    basename="${canonical_file##*/}"
    is_legacy=0
    if [ "$canonical_parent" = "$expected_parent" ]; then
      case "$basename" in ap-*.toml) is_legacy=1 ;; esac
    fi
    if [ "$is_legacy" -eq 0 ]; then
      retained+=("$file")
      continue
    fi
    if ! _idem_remove_managed_file "$root" "$native_file" "$file"; then
      printf 'Autoprompt install (%s): could not migrate receipt-owned legacy role %s.\n' \
        "$client" "$native_file" >&2
      return 93
    fi
  done
  AUTOPROMPT_RECEIPT_FILES=("${retained[@]}")
}

remove_legacy_codex_skill_payload() {
  local root="$1" skill_root="$root/skills/autoprompt" file
  local recovery="$root/$LEGACY_CODEX_RECOVERY_NAME"
  [ -d "$skill_root" ] || return 0
  if [ -e "$recovery" ]; then
    printf 'Autoprompt install (codex): older upgrade recovery already exists at %s.\n' \
      "$recovery" >&2
    return 93
  fi
  mkdir -p -- "$recovery/skills" || return 93
  if ! mv -- "$skill_root" "$recovery/skills/autoprompt"; then
    rmdir -- "$recovery/skills" "$recovery" 2>/dev/null || true
    printf 'Autoprompt install (codex): could not preserve older skill recovery at %s.\n' \
      "$recovery" >&2
    return 93
  fi
  AUTOPROMPT_LEGACY_CODEX_RECOVERY="$recovery"
  local -a kept=()
  for file in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
    _idem_path_under_root "$file" "$skill_root" || kept+=("$file")
  done
  AUTOPROMPT_RECEIPT_FILES=("${kept[@]}")
}

legacy_codex_partial_is_safe() {
  local root="$1" skill_root="$root/skills/autoprompt" target identity file directory parent suffix
  AUTOPROMPT_LEGACY_PARTIAL_FILES=()
  AUTOPROMPT_LEGACY_PARTIAL_DIRECTORIES=()
  [ ! -e "$skill_root" ] && return 0
  [ -d "$skill_root" ] && [ ! -L "$skill_root" ] || return 1
  local -a targets=()
  _preflight_client_targets codex targets || return 1
  declare -A allowed_files=() allowed_directories=()
  allowed_directories["$(_idem_comparable_path "$skill_root")"]=1
  for target in "${targets[@]}"; do
    _idem_path_under_root "$target" "$skill_root" || continue
    identity="$(_idem_comparable_path "$target")" || return 1
    allowed_files["$identity"]=1
    for suffix in \
      '.tmp' \
      '.autoprompt.tmp' \
      '.autoprompt.replace.bak' \
      '.autoprompt.restore.tmp' \
      '.autoprompt.restore.bak'; do
      identity="$(_idem_comparable_path "$target$suffix")" || return 1
      allowed_files["$identity"]=1
    done
    directory="${target%/*}"
    while _idem_path_under_root "$directory" "$skill_root"; do
      identity="$(_idem_comparable_path "$directory")" || return 1
      allowed_directories["$identity"]=1
      _idem_paths_equal "$directory" "$skill_root" && break
      parent="${directory%/*}"
      [ "$parent" != "$directory" ] || break
      directory="$parent"
    done
  done
  while IFS= read -r -d '' file; do
    [ ! -L "$file" ] || return 1
    [ -f "$file" ] || [ -d "$file" ] || return 1
  done < <(find "$skill_root" -mindepth 1 -print0)
  while IFS= read -r -d '' file; do
    identity="$(_idem_comparable_path "$file")" || return 1
    [ -n "${allowed_files[$identity]+set}" ] || return 1
    AUTOPROMPT_LEGACY_PARTIAL_FILES+=("$file")
  done < <(find "$skill_root" -type f -print0)
  while IFS= read -r -d '' directory; do
    identity="$(_idem_comparable_path "$directory")" || return 1
    [ -n "${allowed_directories[$identity]+set}" ] || return 1
    AUTOPROMPT_LEGACY_PARTIAL_DIRECTORIES+=("$directory")
  done < <(find "$skill_root" -depth -type d -print0)
}

remove_legacy_codex_partial_tree() {
  local root="$1" file directory
  for file in "${AUTOPROMPT_LEGACY_PARTIAL_FILES[@]}"; do
    _uninstall_receipt_path_under_root "$root" "$file" || return 1
    [ -f "$file" ] && [ ! -L "$file" ] || return 1
    rm -- "$file" || return 1
  done
  for directory in "${AUTOPROMPT_LEGACY_PARTIAL_DIRECTORIES[@]}"; do
    _uninstall_receipt_path_under_root "$root" "$directory" || return 1
    [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
    rmdir -- "$directory" || return 1
  done
}

remove_exact_legacy_codex_recovery() {
  local root="$1" recovery="$1/$LEGACY_CODEX_RECOVERY_NAME"
  local helper file directory skill_root
  local -a files=() directories=()
  helper="$REPO_ROOT/scripts/install/legacy-compat.cjs"
  skill_root="$recovery/skills/autoprompt"
  [ -d "$root" ] && [ ! -L "$root" ] || return 1
  [ -d "$recovery" ] && [ ! -L "$recovery" ] || return 1
  [ -d "$recovery/skills" ] && [ ! -L "$recovery/skills" ] || return 1
  [ -d "$skill_root" ] && [ ! -L "$skill_root" ] || return 1
  _uninstall_receipt_path_under_root "$root" "$skill_root" || return 1
  node "$helper" match codex "$recovery" >/dev/null 2>&1 || return 1
  mapfile -d '' -t files < <(node "$helper" files0 codex "$recovery" 2>/dev/null)
  mapfile -d '' -t directories < <(
    node "$helper" directories0 codex "$recovery" 2>/dev/null
  )
  [ "${#files[@]}" -gt 0 ] || return 1
  for file in "${files[@]}"; do
    _idem_path_under_root "$file" "$skill_root" || return 1
    _uninstall_receipt_path_under_root "$root" "$file" || return 1
    [ -f "$file" ] && [ ! -L "$file" ] || return 1
    rm -- "$file" || return 1
  done
  for directory in "${directories[@]}"; do
    _idem_path_under_root "$directory" "$skill_root" || return 1
    _uninstall_receipt_path_under_root "$root" "$directory" || return 1
    [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
    rmdir -- "$directory" || return 1
  done
  rmdir -- "$skill_root" "$recovery/skills" "$recovery" || return 1
}

restore_interrupted_legacy_codex_migration() {
  local root="$1" recovery="$root/$LEGACY_CODEX_RECOVERY_NAME"
  local skill_root="$root/skills/autoprompt" helper
  [ -e "$recovery" ] || return 0
  [ -d "$root" ] && [ ! -L "$root" ] || return 1
  [ -d "$recovery" ] && [ ! -L "$recovery" ] || return 1
  _uninstall_receipt_path_under_root "$root" "$recovery" || return 1
  _uninstall_receipt_path_under_root "$root" "$skill_root" || return 1
  helper="$REPO_ROOT/scripts/install/legacy-compat.cjs"
  if ! node "$helper" match codex "$recovery" >/dev/null 2>&1; then
    printf 'Autoprompt install: older Codex recovery is invalid at %s.\n' \
      "$recovery" >&2
    return 1
  fi
  if [ -f "$root/$AUTOPROMPT_RECEIPT_NAME" ]; then
    remove_exact_legacy_codex_recovery "$root" || return 1
    AUTOPROMPT_LEGACY_CODEX_RECOVERY=''
    return 0
  fi
  if ! legacy_codex_partial_is_safe "$root"; then
    printf 'Autoprompt install: interrupted Codex upgrade has unrecognized files under %s.\n' \
      "$skill_root" >&2
    return 1
  fi
  remove_legacy_codex_partial_tree "$root" || return 1
  mkdir -p -- "${skill_root%/*}" || return 1
  mv -- "$recovery/skills/autoprompt" "$skill_root" || return 1
  rmdir -- "$recovery/skills" "$recovery" 2>/dev/null || return 1
  AUTOPROMPT_LEGACY_CODEX_RECOVERY=''
  printf 'Autoprompt install: restored an interrupted older Codex upgrade under %s.\n' \
    "$root" >&2
}

discard_legacy_codex_recovery() {
  local root="$1" recovery="$root/$LEGACY_CODEX_RECOVERY_NAME"
  [ -e "$recovery" ] || { AUTOPROMPT_LEGACY_CODEX_RECOVERY=''; return 0; }
  [ "$AUTOPROMPT_LEGACY_CODEX_RECOVERY" = "$recovery" ] || return 1
  remove_exact_legacy_codex_recovery "$root" || return 1
  AUTOPROMPT_LEGACY_CODEX_RECOVERY=''
}

migrate_legacy_activation() {
  local client="$1"
  [ "$client" = codex ] || return 0
  local root="$2"
  if [ -f "$root/$AUTOPROMPT_RECEIPT_NAME" ]; then
    _uninstall_read_receipt "$root" || return $?
    _migrate_restore_codex_config || return $?
    _migrate_legacy_roles "$client" "$root"
    return $?
  else
    local -a legacy_owned=()
    legacy_codex_ownership_state "$root" legacy_owned || return 0
  fi
  remove_legacy_codex_skill_payload "$root"
}

prune_stale_claude_personas() {
  local root source_dir private_agents native_agents file candidate parent source_name
  root="$(config_root claude)"
  source_dir="$REPO_ROOT/agents/claude/agents"
  private_agents="$(canonical_legacy_path "$(extras_skill_dir claude)/agents")" || return 0
  native_agents="$(canonical_legacy_path "$(extras_agents_dir claude)")" || return 0
  local -a owned_files=("${AUTOPROMPT_RECEIPT_FILES[@]:-}")
  for file in "${owned_files[@]:-}"; do
    candidate="$(canonical_legacy_path "$file")" || candidate=""
    [ -n "$candidate" ] || continue
    parent="${candidate%/*}"
    [ "$parent" = "$private_agents" ] || [ "$parent" = "$native_agents" ] || continue
    case "${candidate##*/}" in ap-*.md) ;; *) continue ;; esac
    source_name="${candidate##*/}"
    [ -f "$source_dir/$source_name" ] && continue
    local native_file="$file"
    command -v cygpath >/dev/null 2>&1 && native_file="$(cygpath -u -- "$file")"
    if ! _idem_remove_managed_file "$root" "$native_file" "$file"; then
      printf 'Autoprompt install (claude): could not prune receipt-owned stale persona %s.\n' "$native_file" >&2
      return 94
    fi
  done
}

# install_landing <client>: run precheck + install_idempotent for ONE present client IN
# THIS SHELL, accumulating into the shared receipt arrays. Records a RESULT= row. Does
# NOT write the receipt (that is per-root, done by the caller). Sets ANY_FAIL on failure.
_landing_fail() {
  local client="$1" stage="$2" message="$3"
  printf '%s\n' "$message" >&2
  RESULT_ROWS+=("RESULT=FAIL client=$client stage=$stage")
  ANY_FAIL=1
  return 1
}

_landing_load_payload() {
  local client="$1" file_name="$2" root_name="$3" name_name="$4"
  local description_name="$5" body_name="$6" extras_name="$7"
  local loaded_file loaded_root loaded_name loaded_description loaded_body loaded_extras
  local -n file_ref="$file_name" root_ref="$root_name" name_ref="$name_name"
  local -n description_ref="$description_name" body_ref="$body_name"
  local -n extras_ref="$extras_name"
  loaded_file="$(payload_file "$client")" || loaded_file=""
  loaded_root="$(config_root "$client")"
  if [ ! -f "$loaded_file" ]; then
    _landing_fail "$client" payload \
      "Autoprompt install ($client): payload not found at $loaded_file"
    return 1
  fi
  loaded_name="$(payload_field "$loaded_file" name)"
  loaded_description="$(payload_field "$loaded_file" description)"
  loaded_body="$(payload_body "$loaded_file")"
  if [ "$client" = vscode ]; then
    loaded_body="${loaded_body#$'\n'}"$'\n'
  fi
  if [ -z "$loaded_name" ] || [ -z "$loaded_body" ]; then
    _landing_fail "$client" payload \
      "Autoprompt install ($client): could not read name/body from $loaded_file (need python + PyYAML)"
    return 1
  fi
  loaded_extras="$(extras_src_dir "$client")"
  file_ref="$loaded_file"; root_ref="$loaded_root"; name_ref="$loaded_name"
  description_ref="$loaded_description"; body_ref="$loaded_body"
  extras_ref="$loaded_extras"
}

_landing_prepare_root() {
  local client="$1" root="$2"
  if ! precheck_install "$client" >/dev/null; then
    _landing_fail "$client" precheck \
      "Autoprompt install ($client): precheck failed (see message above)."
    return 1
  fi
  if ! migrate_legacy_activation "$client" "$root"; then
    _landing_fail "$client" migration \
      "Autoprompt install ($client): receipt-owned legacy activation migration failed."
    return 1
  fi
  if [ "$client" = claude ] && ! prune_stale_claude_personas; then
    _landing_fail "$client" migration \
      "Autoprompt install ($client): stale private persona migration failed."
    return 1
  fi
}

_landing_install_skill() {
  local client="$1" root="$2" name="$3" description="$4" body="$5"
  local output_name="$6" stdout_file stderr_file install_code record
  local -n install_record_ref="$output_name"
  stdout_file="$(mktemp)"; stderr_file="$(mktemp)"
  install_idempotent "$root" "$client" "$name" "$description" "$body" \
    >"$stdout_file" 2>"$stderr_file"
  install_code=$?
  record="$(cat "$stdout_file")"
  if [ "$install_code" -ne 0 ]; then
    [ -s "$stderr_file" ] && command cat "$stderr_file" >&2
    rm -f "$stdout_file" "$stderr_file"
    _landing_fail "$client" install \
      "Autoprompt install ($client): install_idempotent failed (code $install_code)."
    return 1
  fi
  rm -f "$stdout_file" "$stderr_file"
  install_record_ref="$record"
}

_landing_install_extras() {
  local client="$1" root="$2" extras_source="$3"
  local skill_dir agents_dir stderr_file extras_code
  [ -n "$extras_source" ] || return 0
  skill_dir="$(extras_skill_dir "$client")"
  agents_dir="$(extras_agents_dir "$client")"
  [ "$client" != vscode ] || agents_dir=""
  stderr_file="$(mktemp)"
  install_extras "$client" "$extras_source" "$skill_dir" "$agents_dir" "$root" \
    >/dev/null 2>"$stderr_file"
  extras_code=$?
  if [ "$extras_code" -ne 0 ]; then
    [ -s "$stderr_file" ] && command cat "$stderr_file" >&2
    rm -f "$stderr_file"
    _landing_fail "$client" extras \
      "Autoprompt install ($client): runtime extras copy failed (code $extras_code)."
    return 1
  fi
  rm -f "$stderr_file"
}

_landing_activate_client() {
  local client="$1"
  if [ "$client" = codex ] && ! install_codex_agents; then
    _landing_fail "$client" agents \
      "Autoprompt install ($client): private custom-agent profile export failed."
    return 1
  fi
  if [ "$client" = opencode ] &&
     { ! prune_stale_opencode_agents || ! install_opencode_activation; }; then
    _landing_fail "$client" agents \
      "Autoprompt install ($client): native activation failed."
    return 1
  fi
  if [ "$client" = kilo ] &&
     { ! prune_stale_kilo_agents || ! install_kilo_activation; }; then
    _landing_fail "$client" agents \
      "Autoprompt install ($client): native activation failed."
    return 1
  fi
  if [ "$client" = vscode ] && ! install_vscode_activation; then
    _landing_fail "$client" activation-missing \
      "Autoprompt install ($client): activation-missing; settings were not changed."
    return 1
  fi
  if [ "$client" = omp ] && ! install_harness_provider_depth omp; then
    _landing_fail "$client" activation-missing \
      "Autoprompt install ($client): required task recursion depth could not be configured."
    return 1
  fi
  if [ "$client" = deepseek ] && ! install_deepseek_activation; then
    _landing_fail "$client" agents \
      "Autoprompt install ($client): native agent preset landing failed."
    return 1
  fi
  if [ "$client" = reasonix ] && ! install_reasonix_activation; then
    _landing_fail "$client" agents \
      "Autoprompt install ($client): native subagent profile landing failed."
    return 1
  fi
  if [ "$client" = hermes ] && ! install_hermes_activation; then
    _landing_fail "$client" agents \
      "Autoprompt install ($client): native subagent profile landing failed."
    return 1
  fi
}

_landing_verify() {
  local client="$1" output_name="$2" stdout_file stderr_file verify_code record
  local -n verify_record_ref="$output_name"
  stdout_file="$(mktemp)"; stderr_file="$(mktemp)"
  verify_install "$client" >"$stdout_file" 2>"$stderr_file"
  verify_code=$?
  record="$(cat "$stdout_file")"
  if [ "$verify_code" -ne 0 ]; then
    [ -s "$stderr_file" ] && command cat "$stderr_file" >&2
    rm -f "$stdout_file" "$stderr_file"
    _landing_fail "$client" verify \
      "Autoprompt install ($client): post-install verify failed (code $verify_code)."
    return 1
  fi
  rm -f "$stdout_file" "$stderr_file"
  verify_record_ref="$record"
}

_landing_publish_success() {
  local client="$1" install_record="$2" verify_record="$3" landed format
  landed="${verify_record#client=* verify=pass dest=}"
  landed="${landed% format=*}"
  format="${verify_record##* format=}"
  RESULT_ROWS+=(
    "RESULT=PASS client=$client dest=$landed format=$format signal=verify=pass detail=$install_record"
  )
}

install_landing() {
  local client="$1" file root name description body extras_source
  local install_record verify_record
  _landing_load_payload "$client" file root name description body \
    extras_source || return 1
  _landing_prepare_root "$client" "$root" || return 1
  _landing_install_skill "$client" "$root" "$name" "$description" "$body" \
    install_record || return 1
  _landing_install_extras "$client" "$root" "$extras_source" || return 1
  _landing_activate_client "$client" || return 1
  _landing_verify "$client" verify_record || return 1
  if [ "$client" = omp ]; then
    AUTOPROMPT_RECEIPT_OMP_MANAGED=1
  fi
  if [ "$client" = omp ] && [ -n "${PI_CODING_AGENT_DIR:-}" ] &&
     ! autoprompt_install_root_override_present; then
    autoprompt_omp_profile >/dev/null
    local omp_profile_status=$?
    if [ "$omp_profile_status" -eq 1 ]; then
      AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT="$(autoprompt_omp_default_agent_root)" ||
        return 1
    fi
  fi
  _landing_publish_success "$client" "$install_record" "$verify_record"
}

_preflight_runtime_inventory() {
  local client="$1" output_name="$2" tool output relative
  local -n inventory_ref="$output_name"
  inventory_ref=()
  tool="$REPO_ROOT/scripts/runtime-payload.cjs"
  [ -f "$tool" ] && command -v node >/dev/null 2>&1 || return 82
  output="$(node "$tool" --inventory "$client")" || return 82
  [ -n "$output" ] || return 82
  while IFS= read -r relative; do
    [ -n "$relative" ] && inventory_ref+=("$relative")
  done <<< "$output"
  [ "${#inventory_ref[@]}" -gt 0 ] || return 82
}

_preflight_main_target() {
  local client="$1" output_name="$2" record target
  record="$(resolve_destination "$client")" || return 44
  target="${record#client=* dest=}"
  target="${target% format=*}"
  case "$target" in */) target="${target}SKILL.md" ;; esac
  printf -v "$output_name" '%s' "$target"
}

_preflight_append_agent_targets() {
  local extension="$1" destination="$2" inventory_name="$3" targets_name="$4"
  local relative basename
  local -n inventory_ref="$inventory_name" targets_ref="$targets_name"
  for relative in "${inventory_ref[@]}"; do
    case "$relative" in agents/ap-*.md) ;; *) continue ;; esac
    basename="${relative##*/}"
    [ "$basename" = "${relative#agents/}" ] || continue
    targets_ref+=("$destination/${basename%.md}$extension")
  done
}

_preflight_client_targets() {
  local client="$1" output_name="$2" main_target private_dir relative
  local -a inventory=() claude_inventory=()
  local -n targets_ref="$output_name"
  targets_ref=()
  _preflight_main_target "$client" main_target || return $?
  targets_ref+=("$main_target")
  case "$client" in
    claude|codex|opencode|kilo|vscode|omp|deepseek|reasonix)
      _preflight_runtime_inventory "$client" inventory || return $?
      private_dir="$(extras_skill_dir "$client")"
      for relative in "${inventory[@]}"; do
        [ "$client" != vscode ] || [ "$relative" != SKILL.md ] || continue
        targets_ref+=("$private_dir/$relative")
      done
      ;;
  esac
  case "$client" in
    claude) _preflight_append_agent_targets '.md' "$(extras_agents_dir claude)" inventory "$output_name" ;;
    codex)
      _preflight_runtime_inventory claude claude_inventory || return $?
      _preflight_append_agent_targets '.toml' "$(codex_agents_dir)" claude_inventory "$output_name"
      targets_ref+=("$(codex_agents_dir)/.autoprompt-casting.json" "$(codex_profile_file)")
      ;;
    opencode)
      _preflight_append_agent_targets '.md' "$(opencode_agents_dir)" inventory "$output_name"
      targets_ref+=("$(opencode_profile_file)")
      ;;
    kilo)
      _preflight_append_agent_targets '.md' "$(kilo_agents_dir)" inventory "$output_name"
      targets_ref+=("$(kilo_profile_file)")
      ;;
    vscode)
      _preflight_append_agent_targets '.md' "$(extras_agents_dir vscode)" inventory "$output_name"
      ;;
    omp)
      _preflight_append_agent_targets '.md' "$(extras_agents_dir omp)" inventory "$output_name"
      ;;
    deepseek)
      targets_ref+=(
        "$(config_root deepseek)/.agent-presets/autoprompt/agent.cordis.yml"
        "$(config_root deepseek)/.agent-presets/autoprompt/preset.yml"
      )
      ;;
    reasonix)
      for relative in "${inventory[@]}"; do
        case "$relative" in
          skills/ap-*/SKILL.md) targets_ref+=("$(config_root reasonix)/$relative") ;;
        esac
      done
      ;;
  esac
}

_preflight_same_root() {
  local left right left_identity right_identity
  _uninstall_lexical_path "$1" left || return 1
  _uninstall_lexical_path "$2" right || return 1
  left_identity="$(_idem_comparable_path "$left")" || return 1
  right_identity="$(_idem_comparable_path "$right")" || return 1
  [ "$left_identity" = "$right_identity" ]
}

_preflight_target_identity() {
  local root="$1" target="$2" output_name="$3" normalized comparable_identity
  local omp_root omp_detached_root omp_profile_status
  _uninstall_lexical_path "$target" normalized || return 1
  if ! _uninstall_receipt_path_allowed \
      "$root" "$normalized" "${AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT:-}"; then
    [ -n "${PI_CODING_AGENT_DIR:-}" ] || return 1
    autoprompt_omp_profile >/dev/null; omp_profile_status=$?
    [ "$omp_profile_status" -eq 1 ] || return 1
    omp_root="$(autoprompt_config_root omp)" || return 1
    _idem_paths_equal "$root" "$omp_root" || return 1
    omp_detached_root="$(autoprompt_omp_default_agent_root)" || return 1
    if [ -n "${AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT:-}" ] &&
       ! _idem_paths_equal \
         "$AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT" "$omp_detached_root"; then
      printf '%s\n' \
        "error=omp-detached-root-drift recorded=$AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT current=$omp_detached_root action=uninstall-first" >&2
      return 1
    fi
    _uninstall_omp_detached_receipt_path_allowed \
      "$omp_detached_root" "$normalized" || return 1
  fi
  comparable_identity="$(_idem_comparable_path "$normalized")" || return 1
  [ -n "$comparable_identity" ] || return 1
  printf -v "$output_name" '%s' "$comparable_identity"
}

# Refuse to reinterpret an existing OMP receipt in either layout direction.
# Switching between self-contained and detached native agents would broaden or
# strand receipt authority and leave the old layout's live files behind.
_preflight_receipt_owns_self_contained_omp_agents() {
  local root="$1" owned normalized parent basename packed edit_file rest edit_key
  local recorded_hash expected_hash source separator=$'\037'
  local -a root_agents=()
  for owned in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
    normalized="${owned//\\//}"
    parent="${normalized%/*}"
    basename="${normalized##*/}"
    _idem_paths_equal "$parent" "$root/agents" || continue
    case "$basename" in ap-*.md) root_agents+=("$owned") ;; esac
  done
  [ "${#root_agents[@]}" -gt 0 ] || return 1

  # The same root-local agent names can be owned by Claude.  An OMP activation
  # edit is provider-specific receipt evidence even when the agent payload was
  # later refreshed by another client sharing the root.
  for packed in "${AUTOPROMPT_RECEIPT_EDITS[@]:-}"; do
    [ -n "$packed" ] || continue
    edit_file="${packed%%$separator*}"
    rest="${packed#*$separator}"
    edit_key="${rest%%$separator*}"
    if _idem_paths_equal "$edit_file" "$root/config.yml" &&
       [ "$edit_key" = task.maxRecursionDepth ]; then
      return 0
    fi
  done

  # A pre-existing desired depth is a no-op and therefore has no config edit.
  # In that case, require the receipt manifest to fingerprint a root-local file
  # as the OMP payload rather than treating every client's ap-*.md as OMP-owned.
  for owned in "${root_agents[@]}"; do
    normalized="${owned//\\//}"
    basename="${normalized##*/}"
    source="$REPO_ROOT/agents/omp/agents/$basename"
    [ -f "$source" ] || continue
    recorded_hash=""
    _idem_read_manifest_hash "$root" "$owned" recorded_hash || continue
    [ -n "$recorded_hash" ] || continue
    expected_hash="$(_idem_sha256 "$source")" || continue
    [ "$recorded_hash" = "$expected_hash" ] && return 0
  done
  return 1
}

_preflight_omp_detached_layout() {
  local root="$1" client profile_status current_detached_root=""
  shift
  for client in "$@"; do
    [ "$client" = omp ] || continue
    _preflight_same_root "$(config_root omp)" "$root" || continue
    if [ -n "${PI_CODING_AGENT_DIR:-}" ] &&
       ! autoprompt_install_root_override_present; then
      autoprompt_omp_profile >/dev/null
      profile_status=$?
      case "$profile_status" in
        1)
          current_detached_root="$(autoprompt_omp_default_agent_root)" ||
            return 1
          ;;
        0) current_detached_root="" ;;
        *) return "$profile_status" ;;
      esac
    fi
    if [ -n "${AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT:-}" ] &&
       { [ -z "$current_detached_root" ] ||
         ! _idem_paths_equal \
           "$AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT" "$current_detached_root"; }; then
      printf '%s\n' \
        "error=omp-detached-root-layout-transition recorded=$AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT current=${current_detached_root:-self-contained} action=uninstall-first" >&2
      return 1
    fi
    if [ -z "${AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT:-}" ] &&
       [ -n "$current_detached_root" ]; then
      if [ "${AUTOPROMPT_RECEIPT_OMP_MANAGED:-0}" -eq 1 ]; then
        :
      elif [ "${AUTOPROMPT_RECEIPT_HAS_OMP_MANAGED:-0}" -eq 1 ]; then
        return 0
      elif ! _preflight_receipt_owns_self_contained_omp_agents "$root"; then
        return 0
      fi
      printf '%s\n' \
        "error=omp-detached-root-layout-transition recorded=<self-contained> current=$current_detached_root action=uninstall-first" >&2
      return 1
    fi
    return 0
  done
  return 0
}

preflight_root_exact_targets() {
  local root="$1" collision_client_output="$2" collision_target_output="$3"
  local client target identity code index
  local -a client_targets=() targets=() target_clients=()
  local -n collision_client_ref="$collision_client_output"
  local -n collision_target_ref="$collision_target_output"
  declare -A seen=()
  collision_client_ref=""
  collision_target_ref=""
  shift 3
  _preflight_omp_detached_layout "$root" "$@" || return 44
  for client in "$@"; do
    _preflight_same_root "$(config_root "$client")" "$root" || continue
    _preflight_client_targets "$client" client_targets
    code=$?
    [ "$code" -eq 0 ] || return "$code"
    for target in "${client_targets[@]}"; do
      targets+=("$target")
      target_clients+=("$client")
    done
  done
  for target in "${targets[@]}"; do
    _preflight_target_identity "$root" "$target" identity || return 44
    [ -z "${seen[$identity]+set}" ] || return 44
    seen["$identity"]=1
  done
  for ((index = 0; index < ${#targets[@]}; index++)); do
    target="${targets[index]}"
    if _idem_target_is_unowned_collision "$target"; then
      collision_client_ref="${target_clients[index]}"
      collision_target_ref="$target"
      return 43
    fi
  done
  return 0
}

mark_root_preflight_failed() {
  local root="$1" code="$2" collision_client="$3" collision_target="$4" client
  shift 4
  printf 'Autoprompt install: target preflight failed under %s (code %s).\n' \
    "$root" "$code" >&2
  if [ "$code" -eq 43 ] && [ -n "$collision_client" ] && [ -n "$collision_target" ]; then
    printf 'client=%s error=unowned-skill-refused dest=%s\n' \
      "$collision_client" "$collision_target" >&2
  fi
  for client in "$@"; do
    _preflight_same_root "$(config_root "$client")" "$root" || continue
    RESULT_ROWS+=("RESULT=FAIL client=$client stage=preflight")
  done
  ANY_FAIL=1
}

# preseed_root <root>: restore the existing shared-root ownership state. A corrupt
# receipt is a hard failure because treating it as fresh would strand owned paths.
preseed_root() {
  local root="$1"
  AUTOPROMPT_RECEIPT_FILES=(); AUTOPROMPT_RECEIPT_EDITS=()
  AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=()
  AUTOPROMPT_RECEIPT_OMP_MANAGED=0
  AUTOPROMPT_RECEIPT_HAS_OMP_MANAGED=0
  AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT=""
  AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="none"
  if [ -f "$root/$AUTOPROMPT_RECEIPT_NAME" ]; then
    _uninstall_read_receipt "$root" || return $?
  else
    local -a legacy_owned=()
    legacy_codex_ownership_state "$root" legacy_owned || return 0
    AUTOPROMPT_RECEIPT_FILES=("${legacy_owned[@]}")
    return 0
  fi
  local f i us=$'\037'
  for f in "${UNINSTALL_RC_FILES[@]:-}"; do
    [ -n "$f" ] && AUTOPROMPT_RECEIPT_FILES+=("$f")
  done
  for f in "${UNINSTALL_RC_CREATED_DIRECTORIES[@]:-}"; do
    [ -n "$f" ] && _idem_add_receipt_created_directory "$f"
  done
  for ((i = 0; i < ${#UNINSTALL_RC_EDIT_FILE[@]}; i++)); do
    local prior="${UNINSTALL_RC_EDIT_PRIOR[i]}"
    [ "${UNINSTALL_RC_EDIT_PRIOR_ISNULL[i]}" -eq 1 ] && prior="$AUTOPROMPT_RECEIPT_ABSENT"
    AUTOPROMPT_RECEIPT_EDITS+=("${UNINSTALL_RC_EDIT_FILE[i]}$us${UNINSTALL_RC_EDIT_KEY[i]}$us${UNINSTALL_RC_EDIT_VALUE[i]}$us$prior")
  done
  AUTOPROMPT_RECEIPT_OMP_MANAGED="${UNINSTALL_RC_OMP_MANAGED:-0}"
  AUTOPROMPT_RECEIPT_HAS_OMP_MANAGED="${UNINSTALL_RC_HAS_OMP_MANAGED:-0}"
  AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT="${UNINSTALL_RC_OMP_DETACHED_ROOT:-}"
  [ -n "${UNINSTALL_RC_BACKUP:-}" ] && AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="$UNINSTALL_RC_BACKUP"
  return 0
}

seal_root() {
  local root="$1" nonce
  [ "$AUTOPROMPT_ROOT_TRANSACTION_CHANGED" -eq 1 ] || return 0
  nonce="$(mint_nonce)"
  write_receipt "$root" "$nonce" "$AUTOPROMPT_CONFIGEDIT_LAST_BACKUP" >/dev/null
}

rollback_root() {
  local root="$1"
  if _idem_rollback_root_transaction; then
    if restore_interrupted_legacy_codex_migration "$root"; then
      return 0
    fi
  fi
  printf 'Autoprompt install: rollback failed under %s; recovery state retained at %s.\n' \
    "$root" "$AUTOPROMPT_ROOT_TRANSACTION_DIR" >&2
  ANY_FAIL=1
  RETAINED_RECOVERY=1
  return 1
}

print_matrix() {
  local line client detail
  printf '\n==== Autoprompt install matrix ====\n'
  for line in "${RESULT_ROWS[@]}"; do
    client="${line#* client=}"; client="${client%% *}"
    case "$line" in
      RESULT=PASS*) detail="${line#* dest=}"; printf '  PASS  %-9s dest=%s\n' "$client" "${detail%% *}" ;;
      RESULT=FAIL*) detail="${line#* stage=}"; printf '  FAIL  %-9s stage=%s\n' "$client" "${detail%% *}" ;;
      SKIP=*)       detail="${line#* reason=}"; printf '  SKIP  %-9s reason=%s\n' "$client" "${detail%% *}" ;;
    esac
  done
  printf '====================================\n'
}

# dedup_receipt_files: collapse duplicate paths in AUTOPROMPT_RECEIPT_FILES (a re-landed
# client appends its path again; the receipt should list each file once), preserving order.
dedup_receipt_files() {
  local -a out=()
  local f g found
  for f in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
    [ -z "$f" ] && continue
    found=0
    for g in "${out[@]:-}"; do
      _idem_paths_equal "$g" "$f" && { found=1; break; }
    done
    [ "$found" -eq 0 ] && out+=("$f")
  done
  AUTOPROMPT_RECEIPT_FILES=("${out[@]}")
}

mark_root_failed() {
  local from="$1" stage="$2" index line client
  for ((index = from; index < ${#RESULT_ROWS[@]}; index++)); do
    line="${RESULT_ROWS[index]}"
    case "$line" in
      RESULT=PASS*)
        client="${line#* client=}"
        client="${client%% *}"
        RESULT_ROWS[index]="RESULT=FAIL client=$client stage=$stage"
        ;;
    esac
  done
  ANY_FAIL=1
}

report_root_success() {
  local from="$1" index line client landed fmt detail
  for ((index = from; index < ${#RESULT_ROWS[@]}; index++)); do
    line="${RESULT_ROWS[index]}"
    case "$line" in
      RESULT=PASS*)
        client="${line#* client=}"; client="${client%% *}"
        landed="${line#* dest=}"; landed="${landed%% *}"
        fmt="${line#* format=}"; fmt="${fmt%% *}"
        detail="${line#* detail=}"
        printf 'Autoprompt install (%s): PASS - landed %s (format %s, %s)\n' \
          "$client" "$landed" "$fmt" "$detail" >&2
        ;;
    esac
  done
}

validate_root_opencode_payload() {
  local root="$1" client source_agent source_agent_count=0
  local source_agents="$REPO_ROOT/agents/opencode/agents"
  local source_profile="$REPO_ROOT/agents/opencode/autoprompt.opencode.json"
  shift
  for client in "$@"; do
    [ "$client" = "opencode" ] || continue
    [ "$(config_root "$client")" = "$root" ] || continue
    for source_agent in "$source_agents"/ap-*.md; do
      [ -f "$source_agent" ] && source_agent_count=$((source_agent_count + 1))
    done
    if [ "$source_agent_count" -ne 25 ]; then
      printf 'client=opencode error=required-agent-payload-invalid stage=payload count=%s expected=25 dir=%s\n' \
        "$source_agent_count" \
        "$source_agents" >&2
      printf 'Autoprompt install (opencode): current payload must contain exactly 25 native subagents.\n' >&2
      RESULT_ROWS+=("RESULT=FAIL client=opencode stage=payload")
      ANY_FAIL=1
      return 1
    fi
    if ! validate_opencode_profile "$source_profile"; then
      printf 'client=opencode error=activation-profile-invalid stage=profile path=%s\n' \
        "$source_profile" >&2
      printf 'Autoprompt install (opencode): source activation profile must use the exact supported key, depth, share, and task-permission values with no model override.\n' >&2
      RESULT_ROWS+=("RESULT=FAIL client=opencode stage=profile")
      ANY_FAIL=1
      return 1
    fi
    break
  done
}

validate_root_kilo_payload() {
  local root="$1" client source_agent source_agent_count=0
  local source_agents="$REPO_ROOT/agents/kilo/agents"
  local source_profile="$REPO_ROOT/agents/kilo/autoprompt.kilo.json"
  shift
  for client in "$@"; do
    [ "$client" = "kilo" ] || continue
    [ "$(config_root "$client")" = "$root" ] || continue
    for source_agent in "$source_agents"/ap-*.md; do
      [ -f "$source_agent" ] && source_agent_count=$((source_agent_count + 1))
    done
    if [ "$source_agent_count" -ne 25 ]; then
      printf 'client=kilo error=required-agent-payload-count stage=payload dir=%s found=%s expected=25\n' \
        "$source_agents" "$source_agent_count" >&2
      RESULT_ROWS+=("RESULT=FAIL client=kilo stage=payload")
      ANY_FAIL=1
      return 1
    fi
    if ! validate_kilo_profile "$source_profile"; then
      printf 'client=kilo error=activation-profile-invalid stage=profile path=%s\n' \
        "$source_profile" >&2
      RESULT_ROWS+=("RESULT=FAIL client=kilo stage=profile")
      ANY_FAIL=1
      return 1
    fi
    break
  done
}

install_root_clients() {
  local root="$1" result_start root_failed=0 client collision_client collision_target
  shift
  if ! restore_interrupted_legacy_codex_migration "$root"; then
    printf 'Autoprompt install: could not restore older Codex recovery under %s.\n' \
      "$root" >&2
    ANY_FAIL=1
    RETAINED_RECOVERY=1
    return 1
  fi
  if ! preseed_root "$root"; then
    printf 'Autoprompt install: existing receipt under %s is corrupt.\n' "$root" >&2
    ANY_FAIL=1
    return 1
  fi
  preflight_root_exact_targets \
    "$root" collision_client collision_target "$@"
  local preflight_code=$?
  if [ "$preflight_code" -ne 0 ]; then
    mark_root_preflight_failed \
      "$root" "$preflight_code" "$collision_client" "$collision_target" "$@"
    return 1
  fi
  if ! _idem_begin_root_transaction "$root"; then
    printf 'Autoprompt install: could not begin a transaction under %s.\n' "$root" >&2
    ANY_FAIL=1
    return 1
  fi
  result_start="${#RESULT_ROWS[@]}"
  for client in "$@"; do
    [ "$(config_root "$client")" = "$root" ] || continue
    install_landing "$client" || { root_failed=1; break; }
  done
  if [ "$root_failed" -eq 1 ]; then
    mark_root_failed "$result_start" landing
    rollback_root "$root" || true
    return 1
  fi
  dedup_receipt_files
  if ! seal_root "$root"; then
    printf 'Autoprompt install: could not seal the receipt under %s.\n' "$root" >&2
    mark_root_failed "$result_start" receipt
    rollback_root "$root" || true
    return 1
  fi
  if ! _idem_commit_root_transaction; then
    printf 'Autoprompt install: could not release transaction state under %s.\n' "$root" >&2
    mark_root_failed "$result_start" commit
    rollback_root "$root" || true
    return 1
  fi
  if ! discard_legacy_codex_recovery "$root"; then
    printf 'Autoprompt install: could not clear older Codex recovery under %s.\n' \
      "$root" >&2
    mark_root_failed "$result_start" recovery
    RETAINED_RECOVERY=1
    return 1
  fi
  report_root_success "$result_start"
}

# install_batch <client...>: one compensated transaction per distinct config root.
# Receipt sealing is the commit barrier; any earlier, sealing, or cleanup failure
# restores the root and invalidates provisional per-client PASS rows.
install_batch() {
  local clients=("$@") seen_roots=() client root seen_root is_seen
  for client in "${clients[@]}"; do
    root="$(config_root "$client")"
    is_seen=0
    for seen_root in "${seen_roots[@]:-}"; do
      [ "$seen_root" = "$root" ] && is_seen=1
    done
    [ "$is_seen" -eq 0 ] || continue
    seen_roots+=("$root")
    validate_root_opencode_payload "$root" "${clients[@]}" || continue
    validate_root_kilo_payload "$root" "${clients[@]}" || continue
    install_root_clients "$root" "${clients[@]}" || true
  done
}

main() {
  if [ "$#" -ne 1 ]; then usage; exit 2; fi
  local target="$1"
  test_autoprompt_install_root_contract "$target" || exit 2

  if [ "$target" = "all" ]; then
    local present=() c status reason
    for c in "${CLIENTS_ALL[@]}"; do
      status="$(provider_status "$c")" || status=""
      case "$status" in
        supported|degraded)
          if detect_client "$c" >/dev/null 2>&1; then
            present+=("$c")
          else
            printf 'Autoprompt install (%s): SKIP - CLI not detected on PATH.\n' "$c" >&2
            RESULT_ROWS+=("SKIP=skip client=$c reason=not-detected")
          fi
          ;;
        blocked|retired|unverified)
          reason="$(provider_block_reason "$c")"
          printf 'Autoprompt install (%s): SKIP - status=%s reason=%s.\n' \
            "$c" "$status" "$reason" >&2
          RESULT_ROWS+=("SKIP=skip client=$c reason=$reason")
          ;;
      esac
    done
    local -a ordinary=()
    for c in "${present[@]}"; do
      if [ "$c" = prime ]; then install_prime_lifecycle || true
      else ordinary+=("$c")
      fi
    done
    [ "${#ordinary[@]}" -gt 0 ] && install_batch "${ordinary[@]}"
    print_matrix
    exit "$(install_exit_code)"
  fi

  # Single client.
  local status reason
  status="$(provider_status "$target")" || status=""
  if [ -z "$status" ]; then
    printf 'Autoprompt install: unknown client %s.\n' "$target" >&2
    usage; exit 2
  fi
  case "$status" in
    blocked|retired|unverified)
      reason="$(provider_block_reason "$target")"
      printf 'Autoprompt install (%s): REFUSED - status=%s reason=%s.\n' \
        "$target" "$status" "$reason" >&2
      RESULT_ROWS+=("RESULT=FAIL client=$target stage=compatibility reason=$reason")
      print_matrix
      exit 3
      ;;
  esac
  if ! detect_client "$target" >/dev/null 2>&1; then
    printf 'Autoprompt install (%s): SKIP - CLI not detected on PATH. Install it and re-run.\n' "$target" >&2
    RESULT_ROWS+=("SKIP=skip client=$target reason=not-detected")
    print_matrix; exit 0
  fi
  if [ "$target" = prime ]; then
    install_prime_lifecycle || true
    print_matrix
    exit "$(install_exit_code)"
  fi
  install_batch "$target"
  print_matrix
  exit "$(install_exit_code)"
}

main "$@"
