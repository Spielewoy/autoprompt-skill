#!/usr/bin/env bash
# install-lib.sh - Shared autoprompt installer library (sourced, not executed).
#
# Two-port pair with install-lib.ps1. Functions are APPENDED below in F-LIB order
# (DETECT, RESOLVE, FORMAT, PRECHECK, ...); each is fenced so later features add
# theirs without touching earlier blocks.
#
# Detect-record grammar (the canonical line emitted by detect_client on the
# success/absent paths; consumed by RESOLVE/VERIFY without re-guessing):
#
#   client=<name> present=<true|false> version=<VERSION>
#
#   VERSION in {
#     SEMVER    a SemVer token, including optional prerelease/build suffixes
#     "unknown" present binary, version unparseable (probe failed/hung/no token)
#     "-"       absent client (no version by definition)
#   }
#
# Channel discipline (.sh port): the RECORD goes to stdout, the VERDICT is the
# integer return (0 present, 1 absent, 2 unknown-client). POSIX keeps these two
# channels separate by language design, so no extra pin is needed here. The .ps1
# twin MUST pin its record to [Console]::Out.WriteLine to get the same separation
# (a PowerShell function returns its whole pipeline); do NOT "align" this .sh port
# back to that mechanism.

[ -n "${AUTOPROMPT_INSTALL_LIB_SH:-}" ] && return 0
AUTOPROMPT_INSTALL_LIB_SH=1
AUTOPROMPT_INSTALL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

declare -A AUTOPROMPT_CLIENT_BIN=(
  [claude]=claude [codex]=codex [cursor]=cursor-agent [roo]=roo
  [opencode]=opencode [kilo]=kilo [vscode]=code
  [prime]=prime-agent
  [omp]=omp [deepseek]=dsh [reasonix]=reasonix
  [dcode]=dcode [gemini]=gemini [cline]=cline [goose]=goose
)
AUTOPROMPT_VERSION_FLAG="--version"
AUTOPROMPT_PROBE_TIMEOUT=10

# Public install compatibility is a closed nine-provider registry. Historical
# path resolvers remain below only for receipt-owned cleanup of earlier installs.
declare -A AUTOPROMPT_PROVIDER_STATUS=(
  [claude]=supported [codex]=supported [opencode]=supported
  [kilo]=supported [vscode]=supported [prime]=supported
  [omp]=supported [deepseek]=supported [reasonix]=supported
)
declare -A AUTOPROMPT_PROVIDER_BLOCK_REASON=()

provider_status() {
  local name="$1"
  [ -n "${AUTOPROMPT_PROVIDER_STATUS[$name]+set}" ] || return 2
  printf '%s' "${AUTOPROMPT_PROVIDER_STATUS[$name]}"
}

provider_block_reason() {
  local name="$1"
  [ -n "${AUTOPROMPT_PROVIDER_BLOCK_REASON[$name]+set}" ] || return 1
  printf '%s' "${AUTOPROMPT_PROVIDER_BLOCK_REASON[$name]}"
}

# AUTOPROMPT_INSTALL_ROOT is the one-client exact config-root contract shared by
# every lifecycle entry point. It never rewrites HOME/XDG/CODEX_HOME.
AUTOPROMPT_INSTALL_ROOT_CLIENT=""

autoprompt_install_root_override_present() {
  [ "${AUTOPROMPT_INSTALL_ROOT+x}" = x ]
}

_autoprompt_normalized_install_root() {
  local raw="${AUTOPROMPT_INSTALL_ROOT-}" normalized trimmed
  [ -n "$raw" ] || return 1
  trimmed="${raw#"${raw%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [ "$trimmed" = "$raw" ] || return 1
  case "$raw" in *$'\n'*|*$'\r'*|*$'\t'*) return 1 ;; esac
  raw="${raw//\\//}"
  case "/$raw/" in */../*) return 1 ;; esac
  _uninstall_lexical_path "$raw" normalized || return 1
  case "$normalized" in /|[A-Za-z]:) return 1 ;; esac
  case "${OSTYPE:-}:${MSYSTEM:-}:$normalized" in
    msys*:*:/[A-Za-z]|cygwin*:*:/[A-Za-z]|mingw*:*:/[A-Za-z]|*:MSYS*:/[A-Za-z]|*:MINGW*:/[A-Za-z])
      return 1
      ;;
  esac
  printf '%s' "$normalized"
}

_autoprompt_install_root_error() {
  local target="$1" reason="$2"
  printf '%s\n' "client=$target error=invalid-install-root reason=$reason" >&2
  printf '%s\n' \
    'Autoprompt: AUTOPROMPT_INSTALL_ROOT must name one safe absolute provider config root (not all, a filesystem root, or a traversal path).' >&2
}

test_autoprompt_install_root_contract() {
  local target="${1:-}" status raw normalized filesystem_root
  AUTOPROMPT_INSTALL_ROOT_CLIENT=""
  autoprompt_install_root_override_present || return 0
  if [ -z "$target" ] || [ "$target" = all ]; then
    _autoprompt_install_root_error "$target" explicit-client-required
    return 1
  fi
  status="$(provider_status "$target" 2>/dev/null)" || status=""
  case "$status" in
    supported|degraded) ;;
    *) _autoprompt_install_root_error "$target" client-not-installable; return 1 ;;
  esac
  raw="${AUTOPROMPT_INSTALL_ROOT-}"
  if [ -z "$raw" ]; then
    _autoprompt_install_root_error "$target" empty
    return 1
  fi
  case "${raw//\\//}" in
    /*|[A-Za-z]:/*) ;;
    *) _autoprompt_install_root_error "$target" not-absolute; return 1 ;;
  esac
  case "/${raw//\\///}/" in
    */../*) _autoprompt_install_root_error "$target" traversal; return 1 ;;
  esac
  normalized="$(_autoprompt_normalized_install_root)" || {
    _autoprompt_install_root_error "$target" filesystem-root-refused
    return 1
  }
  _uninstall_filesystem_path "$normalized" filesystem_root || {
    _autoprompt_install_root_error "$target" path-conversion-failed
    return 1
  }
  if [ -L "$filesystem_root" ]; then
    _autoprompt_install_root_error "$target" symlink-root-refused
    return 1
  fi
  if [ -e "$filesystem_root" ] && [ ! -d "$filesystem_root" ]; then
    _autoprompt_install_root_error "$target" not-directory
    return 1
  fi
  AUTOPROMPT_INSTALL_ROOT_CLIENT="$target"
}

autoprompt_omp_profile() {
  local raw profile upper
  if [ "${OMP_PROFILE+x}" = x ]; then
    raw="$OMP_PROFILE"
  else
    raw="${PI_PROFILE-}"
  fi
  profile="${raw#"${raw%%[![:space:]]*}"}"
  profile="${profile%"${profile##*[![:space:]]}"}"
  [ -n "$profile" ] || return 1
  [ "$profile" != default ] || return 1
  if [ "${profile: -1}" = . ] ||
     ! [[ "$profile" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    printf 'error=invalid-omp-profile value=%q\n' "$raw" >&2
    return 2
  fi
  upper="${profile^^}"
  case "$upper" in
    CON|CON.*|PRN|PRN.*|AUX|AUX.*|NUL|NUL.*|COM[0-9]|COM[0-9].*|LPT[0-9]|LPT[0-9].*)
      printf 'error=invalid-omp-profile value=%q\n' "$raw" >&2
      return 2
      ;;
  esac
  printf '%s' "$profile"
}

autoprompt_omp_default_agent_root() {
  local home
  home="$(resolve_home omp)" || return $?
  printf '%s/%s/agent' "$home" "${PI_CONFIG_DIR:-.omp}"
}

autoprompt_omp_install_root() {
  local home profile profile_status
  home="$(resolve_home omp)" || return $?
  profile="$(autoprompt_omp_profile)"; profile_status=$?
  case "$profile_status" in
    0)
      printf '%s/%s/profiles/%s/agent' "$home" "${PI_CONFIG_DIR:-.omp}" "$profile"
      return
      ;;
    1) ;;
    *) return "$profile_status" ;;
  esac
  printf '%s' "${PI_CODING_AGENT_DIR:-$(autoprompt_omp_default_agent_root)}"
}

autoprompt_config_root() {
  local name="$1" home
  if autoprompt_install_root_override_present; then
    _autoprompt_normalized_install_root
    return
  fi
  home="$(resolve_home "$name")" || return $?
  case "$name" in
    codex) printf '%s' "${CODEX_HOME:-$home/.codex}" ;;
    opencode|kilo) resolve_xdg "$home" ;;
    vibe) printf '%s' "${VIBE_HOME:-$home/.vibe}" ;;
    prime) printf '%s' "${PRIME_AGENT_CODING_AGENT_DIR:-$home/.prime/agent}" ;;
    omp) autoprompt_omp_install_root ;;
    deepseek) printf '%s' "${DSH_HOME:-$home/.dsh}" ;;
    reasonix)
      if [ -n "${REASONIX_HOME:-}" ]; then
        printf '%s' "$REASONIX_HOME"
      elif [ "${OS:-}" = Windows_NT ] || [ -n "${MSYSTEM:-}" ]; then
        printf '%s/reasonix' "${APPDATA:-$home/AppData/Roaming}"
      else
        printf '%s/.reasonix' "$home"
      fi
      ;;
    *) printf '%s' "$home" ;;
  esac
}

autoprompt_skill_root() {
  local name="$1" home root
  if autoprompt_install_root_override_present; then
    root="$(_autoprompt_normalized_install_root)" || return 1
    printf '%s/skills/autoprompt' "$root"
    return
  fi
  home="$(resolve_home "$name")" || return $?
  case "$name" in
    claude) printf '%s/.claude/skills/autoprompt' "$home" ;;
    codex) printf '%s/skills/autoprompt' "$(autoprompt_config_root codex)" ;;
    opencode) printf '%s/opencode/skills/autoprompt' "$(autoprompt_config_root opencode)" ;;
    kilo) printf '%s/.kilo/skills/autoprompt' "$home" ;;
    vscode) printf '%s/.copilot/skills/autoprompt' "$home" ;;
    omp|deepseek|reasonix) printf '%s/skills/autoprompt' "$(autoprompt_config_root "$name")" ;;
    *) return 1 ;;
  esac
}

autoprompt_runtime_root() {
  autoprompt_skill_root "$1"
}

autoprompt_codex_payload_generation() {
  local manifest="$AUTOPROMPT_INSTALL_REPO_ROOT/agents/manifests/codex-runtime.json"
  command -v node >/dev/null 2>&1 && [ -f "$manifest" ] || return 1
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^codex-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$/.test(manifest.payloadGeneration || "")) process.exit(1);
    process.stdout.write(manifest.payloadGeneration);
  ' "$manifest"
}

autoprompt_codex_bundle_skill_root() {
  local generation
  generation="$(autoprompt_codex_payload_generation)" || return 1
  printf '%s/.autoprompt-private/bundles/%s/skills/autoprompt' \
    "$(autoprompt_config_root codex)" "$generation"
}

autoprompt_codex_generated_agents_root() {
  local skill_root
  skill_root="$(autoprompt_codex_bundle_skill_root)" || return 1
  printf '%s/agents-runtime' "$skill_root"
}

autoprompt_native_agents_root() {
  local name="$1" home root omp_profile_status
  if autoprompt_install_root_override_present; then
    root="$(_autoprompt_normalized_install_root)" || return 1
    if [ "$name" = codex ]; then
      autoprompt_codex_generated_agents_root
    else
      printf '%s/agents' "$root"
    fi
    return
  fi
  home="$(resolve_home "$name")" || return $?
  case "$name" in
    claude) printf '%s/.claude/agents' "$home" ;;
    codex) autoprompt_codex_generated_agents_root ;;
    opencode) printf '%s/opencode/agents' "$(autoprompt_config_root opencode)" ;;
    kilo) printf '%s/kilo/agents' "$(autoprompt_config_root kilo)" ;;
    vscode) printf '%s/.copilot/agents' "$home" ;;
    omp)
      autoprompt_omp_profile >/dev/null; omp_profile_status=$?
      case "$omp_profile_status" in
        0) printf '%s/agents' "$(autoprompt_config_root omp)" ;;
        1)
          if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
            # OMP 17.4.0 still discovers native task agents through PI_CONFIG_DIR
            # even when PI_CODING_AGENT_DIR relocates skills, settings, and state.
            printf '%s/agents' "$(autoprompt_omp_default_agent_root)"
          else
            printf '%s/agents' "$(autoprompt_config_root omp)"
          fi
          ;;
        *) return "$omp_profile_status" ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

autoprompt_profile_file() {
  local name="$1" root
  root="$(autoprompt_config_root "$name")" || return $?
  case "$name" in
    codex) printf '%s/autoprompt.config.toml' "$root" ;;
    opencode)
      if autoprompt_install_root_override_present; then
        printf '%s/autoprompt.opencode.json' "$root"
      else
        printf '%s/opencode/autoprompt.opencode.json' "$root"
      fi
      ;;
    kilo)
      if autoprompt_install_root_override_present; then
        printf '%s/autoprompt.kilo.json' "$root"
      else
        printf '%s/kilo/autoprompt.kilo.json' "$root"
      fi
      ;;
    *) return 1 ;;
  esac
}

# Codex v2 durable activation state is deliberately outside every provider-global
# discovery root. Other providers keep their existing layouts unchanged.
autoprompt_private_state_root() {
  local name="$1"
  [ "$name" = codex ] || return 1
  printf '%s/.autoprompt-private' "$(autoprompt_config_root codex)"
}

autoprompt_provider_activation_capabilities() {
  local name="$1"
  [ "$name" = codex ] || return 1
  printf '%s' \
    'isolation=strict topology-enforcement=prompt-guarded private-skill-root=true process-ownership=false event-streaming=false tool-output-capture=false stable-child-identity=false same-context-continuation=false cancellation=false isolated-checking=false model-routing=true'
}

# --- F-LIB-DETECT (begin) ---
_codex_probe_home_is_safe() {
  local probe_home="$1" temp_root="$2" probe_name probe_parent
  [ -n "$probe_home" ] && [ -n "$temp_root" ] || return 1
  probe_name="${probe_home##*/}"
  probe_parent="${probe_home%/*}"
  [ "$probe_parent" = "$temp_root" ] || return 1
  case "$probe_name" in
    autoprompt-codex-probe-????????) ;;
    *) return 1 ;;
  esac
  [ -d "$probe_home" ] && [ ! -L "$probe_home" ]
}

_remove_codex_probe_home() {
  local probe_home="$1" temp_root="$2"
  [ -e "$probe_home" ] || [ -L "$probe_home" ] || return 0
  _codex_probe_home_is_safe "$probe_home" "$temp_root" || return 1
  command rm -rf -- "$probe_home" 2>/dev/null
}

detect_client() {
  local name="$1"
  if [ -z "$name" ] || [ -z "${AUTOPROMPT_CLIENT_BIN[$name]+set}" ]; then
    printf '%s\n' "client=$name present=false version=- error=unknown-client" >&2
    return 2
  fi

  local bin="${AUTOPROMPT_CLIENT_BIN[$name]}"
  if ! command -v "$bin" >/dev/null 2>&1; then
    printf '%s\n' "client=$name present=false version=-"
    return 1
  fi

  local raw rc probe_output="" codex_probe_home="" codex_temp_root=""
  if [ "$name" = codex ]; then
    codex_temp_root="$(cd -P -- "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || true
    if [ -n "$codex_temp_root" ]; then
      codex_probe_home="$(mktemp -d \
        "$codex_temp_root/autoprompt-codex-probe-XXXXXXXX" 2>/dev/null)" || true
    fi
    if ! _codex_probe_home_is_safe "$codex_probe_home" "$codex_temp_root"; then
      [ -z "$codex_probe_home" ] || \
        _remove_codex_probe_home "$codex_probe_home" "$codex_temp_root" || true
      codex_probe_home=""
      raw=""
      rc=1
    fi
  fi

  if command -v timeout >/dev/null 2>&1; then
    probe_output="$(mktemp 2>/dev/null)" || true
    if [ -z "$probe_output" ]; then
      raw=""
      rc=1
    elif [ "$name" = codex ] && [ -z "$codex_probe_home" ]; then
      raw=""
      rc=1
      rm -f -- "$probe_output" 2>/dev/null
    else
      if [ "$name" = codex ]; then
        CODEX_HOME="$codex_probe_home" timeout -k 1 "$AUTOPROMPT_PROBE_TIMEOUT" \
          "$bin" "$AUTOPROMPT_VERSION_FLAG" > "$probe_output" 2>/dev/null
      elif [ "$name" = prime ]; then
        timeout -k 1 "$AUTOPROMPT_PROBE_TIMEOUT" "$bin" \
          "$AUTOPROMPT_VERSION_FLAG" > "$probe_output" 2>&1
      else
        timeout -k 1 "$AUTOPROMPT_PROBE_TIMEOUT" "$bin" \
          "$AUTOPROMPT_VERSION_FLAG" > "$probe_output" 2>/dev/null
      fi
      rc=$?
      raw="$(command cat -- "$probe_output" 2>/dev/null)"
      rm -f -- "$probe_output" 2>/dev/null
    fi
  else
    if [ "$name" = codex ] && [ -z "$codex_probe_home" ]; then
      raw=""
      rc=1
    elif [ "$name" = codex ]; then
      raw=$(CODEX_HOME="$codex_probe_home" \
        "$bin" "$AUTOPROMPT_VERSION_FLAG" 2>/dev/null)
      rc=$?
    elif [ "$name" = prime ]; then
      raw=$("$bin" "$AUTOPROMPT_VERSION_FLAG" 2>&1)
      rc=$?
    else
      raw=$("$bin" "$AUTOPROMPT_VERSION_FLAG" 2>/dev/null)
      rc=$?
    fi
  fi

  if [ "$name" = codex ] && [ -n "$codex_probe_home" ]; then
    if ! _remove_codex_probe_home "$codex_probe_home" "$codex_temp_root"; then
      raw=""
      rc=1
    fi
  fi

  local token
  token=$(printf '%s\n' "$raw" | head -n 1 | grep -oE \
    '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?' | head -n 1)

  local version
  if [ "$rc" -ne 0 ] || [ -z "$token" ]; then
    version="unknown"
  else
    version="$token"
  fi

  printf '%s\n' "client=$name present=true version=$version"
  return 0
}
# --- F-LIB-DETECT (end) ---

# --- F-LIB-RESOLVE (begin) ---
# resolve_destination emits the EXACT absolute install destination + a format
# token for a client, doing PATH MATH ONLY (no mkdir, no stat - that is
# PRECHECK/COPY territory). Record grammar (stdout, success path):
#
#   client=<name> dest=<ABSOLUTE-PATH> format=<FORMAT-TOKEN>
#
#   FORMAT-TOKEN in { md-yaml, md-claude, md-codex, md-reasonix, mdc,
#                     roomodes, gemini-toml, md-rules, goose-recipe, md-agents }
#
# Channel discipline (mirrors detect_client): RECORD -> stdout; VERDICT -> the
# integer return (0 resolved, 2 unknown-client / no-such-variant, 3 no-home).
# Error record -> stderr: client=<name> dest=- format=- error=<class>.
#
# Each value is a packed spec RELKIND|RELPATH|FORMAT where RELKIND in {HOME,XDG,CODEX}
# selects the base ($home vs $xdg). Trailing-slash RELPATHs (kilo modes dir)
# carry the slash verbatim into the record.
declare -A AUTOPROMPT_CLIENT_DEST=(
  [claude]='HOME|.claude/skills/autoprompt/SKILL.md|md-claude'
  [codex]='CODEX|skills/autoprompt/SKILL.md|md-codex'
  [cursor]='HOME|.cursor/skills/autoprompt/SKILL.md|md-yaml'
  [roo]='HOME|.roomodes|roomodes'
  [gemini]='HOME|.gemini/commands/autoprompt.toml|gemini-toml'
  [cline]='HOME|.clinerules/autoprompt.md|md-rules'
  [goose]='HOME|.config/goose/recipes/autoprompt.yaml|goose-recipe'
  [opencode]='XDG|opencode/skills/autoprompt/SKILL.md|md-yaml'
  [kilo]='HOME|.kilo/skills/autoprompt/SKILL.md|md-yaml'
  [vscode]='HOME|.copilot/skills/autoprompt/SKILL.md|md-yaml'
  [omp]='OMP|skills/autoprompt/SKILL.md|md-claude'
  [deepseek]='DSH|skills/autoprompt/SKILL.md|md-claude'
  [reasonix]='REASONIX|skills/autoprompt/SKILL.md|md-reasonix'
)

# Per-client OPTIONAL variants (cursor secondary, goose fallback). Same packed
# RELKIND|RELPATH|FORMAT grammar. A variant requested for a client with no entry
# here is a no-such-variant error.
declare -A AUTOPROMPT_CLIENT_VARIANT=(
  [cursor:secondary]='HOME|.cursor/rules/autoprompt.mdc|mdc'
  [goose:fallback]='HOME|AGENTS.md|md-agents'
)

# resolve_home: echo $HOME, or return 3 + loud no-home record if unset/empty.
resolve_home() {
  local name="$1"
  if [ -z "${HOME:-}" ]; then
    printf '%s\n' "client=$name dest=- format=- error=no-home" >&2
    return 3
  fi
  printf '%s' "$HOME"
}

# resolve_xdg: $XDG_CONFIG_HOME when set, else $home/.config. No mkdir.
resolve_xdg() {
  local home="$1"
  printf '%s' "${XDG_CONFIG_HOME:-$home/.config}"
}

resolve_destination() {
  local name="$1" variant="${2:-}"

  if [ -z "$name" ] || [ -z "${AUTOPROMPT_CLIENT_DEST[$name]+set}" ]; then
    printf '%s\n' "client=$name dest=- format=- error=unknown-client" >&2
    return 2
  fi

  local spec
  if [ -n "$variant" ]; then
    if [ -z "${AUTOPROMPT_CLIENT_VARIANT[$name:$variant]+set}" ]; then
      printf '%s\n' "client=$name dest=- format=- error=no-such-variant" >&2
      return 2
    fi
    spec="${AUTOPROMPT_CLIENT_VARIANT[$name:$variant]}"
  else
    spec="${AUTOPROMPT_CLIENT_DEST[$name]}"
  fi

  local relkind="${spec%%|*}"
  local rest="${spec#*|}"
  local relpath="${rest%%|*}"
  local format="${rest##*|}"

  if autoprompt_install_root_override_present; then
    local custom_root status
    custom_root="$(_autoprompt_normalized_install_root)" || {
      printf '%s\n' "client=$name dest=- format=- error=invalid-install-root" >&2
      return 4
    }
    status="$(provider_status "$name" 2>/dev/null)" || status=""
    case "$status" in
      supported|degraded) ;;
      *)
        printf '%s\n' "client=$name dest=- format=- error=invalid-install-root" >&2
        return 4
        ;;
    esac
    printf '%s\n' "client=$name dest=$custom_root/skills/autoprompt/SKILL.md format=$format"
    return 0
  fi

  local home
  home="$(resolve_home "$name")" || return 3

  local base
  if [ "$relkind" = "XDG" ]; then
    base="$(resolve_xdg "$home")"
  elif [ "$relkind" = "CODEX" ]; then
    base="${CODEX_HOME:-$home/.codex}"
  elif [ "$relkind" = "OMP" ]; then
    base="$(autoprompt_config_root omp)"
  elif [ "$relkind" = "DSH" ]; then
    base="${DSH_HOME:-$home/.dsh}"
  elif [ "$relkind" = "REASONIX" ]; then
    base="$(autoprompt_config_root reasonix)"
  else
    base="$home"
  fi

  printf '%s\n' "client=$name dest=$base/$relpath format=$format"
  return 0
}
# --- F-LIB-RESOLVE (end) ---

# --- F-LIB-FORMAT (begin) ---
# format_skill mints the EXACT bytes to write on disk for a given FORMAT token,
# doing STRING MATH ONLY (it reads no files - the caller passes the body). It is
# the single place the installed-file bytes are produced, so it is where the P0
# is enforced: the frontmatter it emits is a FIXED literal of only name +
# description (description/globs/alwaysApply for .mdc, a description key for
# TOML) - there is structurally no code path that adds a tool-restricting key.
#
# Channel discipline (mirrors detect/resolve): the rendered bytes go to stdout
# (RECORD), the integer return is the VERDICT, the error record goes to stderr.
#   return 0  rendered OK
#   return 2  unknown / empty format token   (stderr error=unknown-format)
#   return 5  empty body                      (stderr error=empty-body)
#   return 6  body already carries its own --- frontmatter fence
#             (stderr error=body-has-frontmatter) - refuses to emit a
#             double-fence file so a body's disallowed-tools cannot slip in.
# (code 4 format-not-implemented is RETIRED: every token now has a real emitter.)
#
# Byte-parity invariant (F-OP-DUALPARITY): both ports emit '\n'-only separators
# and exactly one trailing newline. printf '%s\n' gives that natively here; the
# .ps1 twin must build the same string with explicit "`n" joins (never WriteLine).

# True when $1 begins with a YAML/.mdc frontmatter fence (first line is '---').
_format_body_has_frontmatter() {
  case "$1" in
    '---'$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Emit md + YAML frontmatter over the body. Codex receives an exact explicit-only
# discovery contract in addition to name + description; other md-family formats
# retain their existing provider-specific keys.
_format_md_yaml() {
  local token="$1" name="$2" description="$3" body="$4"
  if [ "$token" = "md-codex" ]; then
    # Single-quoted YAML scalar (INSTALL.md:24): a literal ' is escaped by doubling.
    local single="${description//\'/\'\'}"
    printf '%s\n' "---" "name: $name" "description: '$single'" \
      "activation: explicit-only" "allow-implicit-invocation: false" \
      "---" "" "$body"
    return
  fi

  # Double-quoted YAML scalar so a ':' (or other) in the description stays a
  # scalar and never reads as a nested mapping; \ and " are escaped.
  local double="${description//\\/\\\\}"
  double="${double//\"/\\\"}"
  if [ "$token" = "md-claude" ]; then
    printf '%s\n' "---" "name: $name" "description: \"$double\"" \
      "disable-model-invocation: true" "user-invocable: true" "---" "" "$body"
    return
  fi
  if [ "$token" = "md-reasonix" ]; then
    printf '%s\n' "---" "name: $name" "description: \"$double\"" \
      "invocation: manual" "---" "" "$body"
    return
  fi
  printf '%s\n' "---" "name: $name" "description: \"$double\"" "---" "" "$body"
}

# Emit .mdc frontmatter: description / globs (empty) / alwaysApply. 'description'
# is the .mdc signal (name is not an .mdc key). No tool-restricting key.
_format_mdc() {
  local description="$1" body="$2"
  # Double-quote the description so a ':' in it stays a scalar (parses as YAML).
  local double="${description//\\/\\\\}"
  double="${double//\"/\\\"}"
  printf '%s\n' "---" "description: \"$double\"" "globs:" "alwaysApply: true" "---" "" "$body"
}

# Emit Gemini TOML: a description basic-string + a prompt multi-line string
# holding the body with a trailing {{args}} (INSTALL.md:38). The description is
# a basic string so " and \ are escaped; the body sits in a """ block.
_format_gemini_toml() {
  local description="$1" body="$2"
  # description: a basic string -> escape \ then " .
  local descEsc="${description//\\/\\\\}"
  descEsc="${descEsc//\"/\\\"}"
  # body: a multi-line basic string still interprets backslash escapes, so escape
  # every \ ; then neutralize any literal """ (the closing delimiter) by escaping
  # the middle quote, so the body can never terminate the block early.
  local bodyEsc="${body//\\/\\\\}"
  bodyEsc="${bodyEsc//\"\"\"/\"\"\\\"}"
  printf '%s\n' "description = \"$descEsc\"" "" 'prompt = """' "$bodyEsc" "" "{{args}}" '"""'
}

# _format_yaml_dquote <s>: a YAML double-quoted scalar BODY (no surrounding quotes)
# for $s - escape \ then ", so a ':' or '#' in name/description stays a scalar and
# never reads as a mapping/comment. Mirrors _format_md_yaml's double-quote rule.
_format_yaml_dquote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# _format_yaml_block <indent> <body>: emit $body as the LINES of a YAML literal
# block scalar (the caller writes the `key: |` line + this), each line prefixed by
# <indent> spaces. A literal block takes every line VERBATIM - no quoting, no
# escape interpretation - so arbitrary markdown (colons, quotes, backslashes, the
# protocol phrases) round-trips byte-for-byte. A blank body line is emitted as a
# truly empty line (no trailing indent) so the YAML parser keeps it inside the
# block without a trailing-whitespace surprise.
_format_yaml_block() {
  local indent="$1" body="$2"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -z "$line" ]; then
      printf '\n'
    else
      printf '%s%s\n' "$indent" "$line"
    fi
  done <<< "$body"
}

# Emit a Roo Code .roomodes document (YAML): a customModes list with the PRIMARY
# slug=autoprompt mode plus a retained slug=autoprompt ALIAS mode (so the old
# trigger still resolves), each carrying a quoted name + roleDefinition +
# description and the skill body as a customInstructions literal block. NO
# `groups` key is emitted on either mode - omitting it leaves the modes at Roo's
# default full tool access, which is the P0 (F-OP-NORESTRICT): there is
# structurally no path that writes a tool allowlist. Schema fields
# (slug/name/roleDefinition/description/customInstructions) follow Roo Code's
# custom-mode format.
_format_roomodes() {
  local name="$1" description="$2" body="$3"
  local nameQ descQ
  nameQ="$(_format_yaml_dquote "$name")"
  descQ="$(_format_yaml_dquote "$description")"
  printf '%s\n' \
    "customModes:" \
    "  - slug: autoprompt" \
    "    name: \"$nameQ\"" \
    "    roleDefinition: \"$descQ\"" \
    "    description: \"$descQ\"" \
    "    customInstructions: |"
  _format_yaml_block "      " "$body"
  printf '%s\n' \
    "  - slug: autoprompt" \
    "    name: \"$nameQ\"" \
    "    roleDefinition: \"$descQ\"" \
    "    description: \"$descQ\"" \
    "    customInstructions: |"
  _format_yaml_block "      " "$body"
}

# Emit a Goose recipe (YAML): version + title + quoted description + the skill body
# as an `instructions` literal block. `instructions` satisfies Goose's
# validate_prompt_or_instructions rule (at least one of instructions/prompt). NO
# extensions/tool key is emitted - the recipe runs with the agent's default tool
# access, the P0 (F-OP-NORESTRICT). Fields per the Goose Recipe Reference Guide.
AUTOPROMPT_GOOSE_RECIPE_VERSION="1.0.0"
_format_goose_recipe() {
  local name="$1" description="$2" body="$3"
  local titleQ descQ
  titleQ="$(_format_yaml_dquote "$name")"
  descQ="$(_format_yaml_dquote "$description")"
  printf '%s\n' \
    "version: \"$AUTOPROMPT_GOOSE_RECIPE_VERSION\"" \
    "title: \"$titleQ\"" \
    "description: \"$descQ\"" \
    "instructions: |"
  _format_yaml_block "  " "$body"
}

format_skill() {
  local format="$1" name="$2" description="$3" body="$4"

  case "$format" in
    md-yaml|md-claude|md-codex|md-reasonix|mdc|md-rules|md-agents|gemini-toml|roomodes|goose-recipe) ;;
    *)
      printf '%s\n' "format=$format error=unknown-format" >&2
      return 2
      ;;
  esac

  if [ -z "$body" ]; then
    printf '%s\n' "format=$format error=empty-body" >&2
    return 5
  fi

  if _format_body_has_frontmatter "$body"; then
    printf '%s\n' "format=$format error=body-has-frontmatter" >&2
    return 6
  fi

  case "$format" in
    md-yaml|md-claude|md-codex|md-reasonix|md-rules|md-agents) _format_md_yaml "$format" "$name" "$description" "$body" ;;
    mdc) _format_mdc "$description" "$body" ;;
    gemini-toml) _format_gemini_toml "$description" "$body" ;;
    roomodes) _format_roomodes "$name" "$description" "$body" ;;
    goose-recipe) _format_goose_recipe "$name" "$description" "$body" ;;
  esac
  return 0
}
# --- F-LIB-FORMAT (end) ---

# --- F-LIB-PRECHECK (begin) ---
# precheck_install proves the three install PRECONDITIONS for a client BEFORE any
# byte is written: (1) the CLI is on PATH, (2) the config dir exists+writable or
# is creatable under a writable ancestor, (3) the detected version meets a CITED
# floor (Claude/Cursor/Cline only). The first failing precondition decides the
# verdict (fail-fast: a missing binary makes the version floor moot).
#
# WHY side-effect-free: the writability probe creates+removes a temp marker in an
# already-writable dir and NEVER leaves the config dir created (the real mkdir is
# F-LIB-COPY's job), so a precheck call writes no install bytes.
#
# Channel discipline (mirrors detect/resolve/format): the OK RECORD -> stdout, the
# operator-actionable failure line + machine record -> stderr, the VERDICT is the
# integer return. Codes: 0 ok, 10 binary-missing, 11 dir-unwritable,
# 12 version-below-floor, 13 version-unknown-on-floored, plus delegated
# 2 unknown-client and 3 no-home. No path returns 0 without all three proven.
#
# Version floors are compatibility claims, so prerelease suffixes are significant.
declare -A AUTOPROMPT_VERSION_FLOOR=(
  [claude]=2.1.219 [cursor]=2.5 [cline]=3.58 [opencode]=1.18.7 [kilo]=7.4.22
  [vscode]=1.133.0 [prime]=0.7.2
  [omp]=17.4.0 [deepseek]=0.1.0-rc.7 [reasonix]=1.30.0
)
AUTOPROMPT_PRECHECK_MARKER_PREFIX=".autoprompt-precheck"

# Compare arbitrarily long numeric identifiers without shell-integer overflow.
# Prints -1, 0, or 1 when left is below, equal to, or above right.
_precheck_numeric_compare() {
  local left="$1" right="$2"
  [[ "$left" =~ ^[0-9]+$ ]] && [[ "$right" =~ ^[0-9]+$ ]] || return 1
  while [ "${#left}" -gt 1 ] && [ "${left#0}" != "$left" ]; do left="${left#0}"; done
  while [ "${#right}" -gt 1 ] && [ "${right#0}" != "$right" ]; do right="${right#0}"; done
  if [ "${#left}" -lt "${#right}" ]; then printf '%s' -1; return 0; fi
  if [ "${#left}" -gt "${#right}" ]; then printf '%s' 1; return 0; fi
  if [[ "$left" < "$right" ]]; then printf '%s' -1; return 0; fi
  if [[ "$left" > "$right" ]]; then printf '%s' 1; return 0; fi
  printf '%s' 0
}

# _precheck_version_ge <found> <floor>: SemVer precedence with numeric core
# segments and standard prerelease identifier ordering. Missing core segments
# zero-pad so historical two-segment floors still compare cleanly. Build metadata
# is ignored for precedence. "unknown" and malformed versions never meet a floor.
_precheck_version_ge() {
  local found="$1" floor="$2"
  [ "$found" = "unknown" ] && return 1

  local found_precedence="${found%%+*}" floor_precedence="${floor%%+*}"
  local found_core="${found_precedence%%-*}" floor_core="${floor_precedence%%-*}"
  local found_pre="" floor_pre="" comparison
  [[ "$found_precedence" == *-* ]] && found_pre="${found_precedence#*-}"
  [[ "$floor_precedence" == *-* ]] && floor_pre="${floor_precedence#*-}"
  [[ "$found_core" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
  [[ "$floor_core" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
  [ -z "$found_pre" ] || [[ "$found_pre" =~ ^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$ ]] || return 1
  [ -z "$floor_pre" ] || [[ "$floor_pre" =~ ^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$ ]] || return 1

  local IFS=.
  local -a fseg=($found_core) lseg=($floor_core)
  local i count=${#fseg[@]}
  [ "${#lseg[@]}" -gt "$count" ] && count=${#lseg[@]}
  for ((i = 0; i < count; i++)); do
    comparison="$(_precheck_numeric_compare "${fseg[i]:-0}" "${lseg[i]:-0}")" || return 1
    [ "$comparison" -gt 0 ] && return 0
    [ "$comparison" -lt 0 ] && return 1
  done

  [ -z "$found_pre" ] && [ -z "$floor_pre" ] && return 0
  [ -z "$found_pre" ] && return 0
  [ -z "$floor_pre" ] && return 1

  local -a fpre=($found_pre) lpre=($floor_pre)
  count=${#fpre[@]}
  [ "${#lpre[@]}" -lt "$count" ] && count=${#lpre[@]}
  for ((i = 0; i < count; i++)); do
    if [[ "${fpre[i]}" =~ ^[0-9]+$ ]] && [[ "${lpre[i]}" =~ ^[0-9]+$ ]]; then
      comparison="$(_precheck_numeric_compare "${fpre[i]}" "${lpre[i]}")" || return 1
      [ "$comparison" -gt 0 ] && return 0
      [ "$comparison" -lt 0 ] && return 1
    elif [[ "${fpre[i]}" =~ ^[0-9]+$ ]]; then
      return 1
    elif [[ "${lpre[i]}" =~ ^[0-9]+$ ]]; then
      return 0
    elif [[ "${fpre[i]}" < "${lpre[i]}" ]]; then
      return 1
    elif [[ "${fpre[i]}" > "${lpre[i]}" ]]; then
      return 0
    fi
  done
  [ "${#fpre[@]}" -ge "${#lpre[@]}" ]
}

# _precheck_dir_writable <dir>: 0 iff <dir> is writable OR creatable. Walks up to
# the nearest existing ancestor and proves writability with a REAL create+remove
# of a temp marker (catches read-only mounts that pass -w but fail on write). The
# probe leaves nothing behind - no install dir is created here.
_precheck_dir_writable() {
  local dir="$1"

  local probe="$dir"
  while [ -n "$probe" ] && [ ! -e "$probe" ]; do
    local parent="${probe%/*}"
    [ "$parent" = "$probe" ] && parent=""
    probe="$parent"
  done
  [ -z "$probe" ] && probe="/"

  [ -d "$probe" ] || return 1
  [ -w "$probe" ] || return 1

  local marker="$probe/$AUTOPROMPT_PRECHECK_MARKER_PREFIX-$$"
  if : > "$marker" 2>/dev/null; then
    rm -f "$marker"
    return 0
  fi
  return 1
}

_precheck_validate_version() {
  local name="$1" version_name="$2" bin="$3" floor
  local -n checked_version="$version_name"
  if [ "$name" = codex ]; then
    floor="$(node -e '
      const fs = require("node:fs");
      const registry = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const floor = registry.compatibility && registry.compatibility.cliMinimum;
      if (!/^\d+\.\d+\.\d+$/.test(floor || "")) process.exit(1);
      process.stdout.write(floor);
    ' "$AUTOPROMPT_INSTALL_REPO_ROOT/scripts/install/codex-package-registry.json" 2>/dev/null)" || {
      printf '%s\n' "client=codex precheck=fail reason=registry-invalid error=missing-version-floor" >&2
      return 13
    }
  elif [ -n "${AUTOPROMPT_VERSION_FLOOR[$name]+set}" ]; then
    floor="${AUTOPROMPT_VERSION_FLOOR[$name]}"
  else
    checked_version="na"
    return 0
  fi
  if [ "$checked_version" = "unknown" ]; then
    printf '%s\n' "client=$name precheck=fail reason=version-unknown required=$floor found=unknown error=unreadable-version" >&2
    printf 'Autoprompt precheck (%s): could not read %s'\''s version (got '\''unknown'\'') and a minimum of %s is required. Verify '\''%s --version'\'' works, then re-run.\n' "$name" "$name" "$floor" "$bin" >&2
    return 13
  fi
  if ! _precheck_version_ge "$checked_version" "$floor"; then
    printf '%s\n' "client=$name precheck=fail reason=version-below-floor required=$floor found=$checked_version error=too-old" >&2
    printf 'Autoprompt precheck (%s): %s %s is below the required %s. Update %s to %s or newer and re-run.\n' "$name" "$name" "$checked_version" "$floor" "$name" "$floor" >&2
    return 12
  fi
}

precheck_install() {
  local name="$1" variant="${2:-}" rec detect_code bin dest resolve_code
  rec="$(detect_client "$name")"; detect_code=$?
  [ "$detect_code" -ne 2 ] || return 2
  bin="${AUTOPROMPT_CLIENT_BIN[$name]}"
  if [ "$detect_code" -eq 1 ]; then
    printf '%s\n' "client=$name precheck=fail reason=binary-missing bin=$bin error=not-on-path" >&2
    printf 'Autoprompt precheck (%s): the '\''%s'\'' CLI is not on your PATH. Install it and re-run, or add its directory to PATH.\n' "$name" "$bin" >&2
    return 10
  fi
  dest="$(resolve_destination "$name" "$variant")"; resolve_code=$?
  [ "$resolve_code" -eq 0 ] || return "$resolve_code"
  local destpath="${dest#client=* dest=}" config_dir version
  destpath="${destpath% format=*}"
  case "$destpath" in */) config_dir="${destpath%/}" ;; *) config_dir="${destpath%/*}" ;; esac
  if ! _precheck_dir_writable "$config_dir"; then
    printf '%s\n' "client=$name precheck=fail reason=dir-unwritable dir=$config_dir error=permission-denied" >&2
    printf 'Autoprompt precheck (%s): cannot write the config directory '\''%s'\'' (permission denied). Fix its permissions or run as a user who can write it.\n' "$name" "$config_dir" >&2
    return 11
  fi
  version="${rec#client=* present=* version=}"
  _precheck_validate_version "$name" version "$bin" || return $?
  printf '%s\n' "client=$name precheck=ok bin=$bin dir=$config_dir version=$version"
}
# --- F-LIB-PRECHECK (end) ---

# --- F-LIB-RECEIPT (begin) ---
# write_receipt records the install's black box: the single source of truth that
# makes uninstall exact and a non-owned config edit reversible. It serializes a
# JSON receipt to <config-root>/.autoprompt-install-receipt.json carrying the
# nonce, a pre-install backup path, every created file, and every config edit
# (with its priorValue, null when the key did not exist). It is a PURE RECORDER:
# the caller has already created the files + applied the edits and passes the
# data in; write_receipt re-resolves/re-detects nothing.
#
# Inputs (module-scope arrays the caller fills BEFORE the call - bash cannot pass
# arrays by value cleanly, and the lib already uses module-scope maps):
#   AUTOPROMPT_RECEIPT_FILES   indexed array of absolute created-file paths
#   AUTOPROMPT_RECEIPT_EDITS   indexed array of packed edit specs, one per edit:
#         FILE<US>KEY<US>NEWVAL<US>PRIORVAL   (US = 0x1f; cannot appear in a path,
#         a config key, or a normal value). PRIORVAL absent is carried by the
#         sentinel below, distinguishing "" (RESTORE empty) from absent (DELETE).
# write_receipt <config-root> <nonce> [backup-path]
#
# Channel discipline (mirrors detect/resolve/format/precheck): the receipt BYTES
# go to the FILE (never stdout); the canonical one-line RECORD -> stdout; errors
# -> stderr; the integer return is the VERDICT. Codes: 0 ok, 20 no-config-root,
# 21 config-root-uncreatable, 22 receipt-tmp-write-failed, 23 receipt-rename-failed.
#
# Atomicity: the bytes are written to <root>/<name>.tmp first, then mv -f onto the
# canonical path. A crash mid-write leaves the canonical path untouched (old or
# absent) and a stray .tmp - never a half-JSON at the canonical name. The receipt
# is written LAST by the orchestrator, so its presence signals install completion.
#
# Byte-parity (F-OP-DUALPARITY): the document is built with a FIXED key order
# (nonce, backup, files, createdDirectories, ompManaged, ompDetachedRoot,
# configEdits), a FIXED 2-space indent,
# '\n'-only newlines, and exactly one trailing '\n'. The .ps1 twin hand-rolls the
# same serializer so the receipt bytes are byte-identical.
AUTOPROMPT_RECEIPT_NAME=".autoprompt-install-receipt.json"
# US-delimited sentinel marking an ABSENT priorValue (serialized as bare null).
AUTOPROMPT_RECEIPT_ABSENT=$'\037__CL_ABSENT__\037'
[ -n "${AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES+set}" ] ||
  declare -a AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=()
[ -n "${AUTOPROMPT_RECEIPT_OMP_MANAGED+set}" ] ||
  AUTOPROMPT_RECEIPT_OMP_MANAGED=0
[ -n "${AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT+set}" ] ||
  AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT=""

# _receipt_json_escape <s> [output-name]: emit or assign the JSON string body
# (without surrounding quotes), escaping special characters for parser round-trips.
_receipt_json_escape() {
  local s="$1" output_name="${2:-}" out="" i ch code
  s="${s//\\/\\\\}"   # backslash first, so later escapes' backslashes are not re-escaped
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  # Remaining control chars (< 0x20) become \u00XX. Scan only when one is present.
  case "$s" in
    *[$'\001'-$'\037']*)
      for ((i = 0; i < ${#s}; i++)); do
        ch="${s:i:1}"
        case "$ch" in
          [$'\001'-$'\037'])
            printf -v code '%02x' "'$ch"
            out+="\\u00$code"
            ;;
          *) out+="$ch" ;;
        esac
      done
      s="$out"
      ;;
  esac
  if [ -n "$output_name" ]; then
    printf -v "$output_name" '%s' "$s"
  else
    printf '%s' "$s"
  fi
}

_receipt_path_array() {
  local array_name="$1" output_name="${2:-}" count i escaped body
  local -n paths="$array_name"
  count="${#paths[@]}"
  if [ "$count" -eq 0 ]; then
    if [ -n "$output_name" ]; then
      printf -v "$output_name" '%s' '[]'
    else
      printf '[]'
    fi
    return 0
  fi
  body='['
  for ((i = 0; i < count; i++)); do
    _receipt_json_escape "${paths[i]}" escaped
    body+=$'\n'"    \"$escaped\""
    [ "$i" -lt $((count - 1)) ] && body+=','
  done
  body+=$'\n  ]'
  if [ -n "$output_name" ]; then
    printf -v "$output_name" '%s' "$body"
  else
    printf '%s' "$body"
  fi
}

_receipt_files_array() {
  _receipt_path_array AUTOPROMPT_RECEIPT_FILES
}

_receipt_created_directories_array() {
  _receipt_path_array AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES
}

# _receipt_edits_array: the JSON array body for AUTOPROMPT_RECEIPT_EDITS. Each
# packed FILE<US>KEY<US>NEWVAL<US>PRIORVAL becomes a {file,key,value,priorValue}
# object; priorValue is bare null when the absent sentinel is present. Empty -> "[]".
_receipt_edits_array() {
  local array_name="${1:-AUTOPROMPT_RECEIPT_EDITS}" output_name="${2:-}" i
  local -n edits="$array_name"
  local count="${#edits[@]}" body escaped_file escaped_key escaped_value escaped_prior
  if [ "$count" -eq 0 ]; then
    if [ -n "$output_name" ]; then
      printf -v "$output_name" '%s' '[]'
    else
      printf '[]'
    fi
    return 0
  fi
  body='['
  for ((i = 0; i < count; i++)); do
    local packed="${edits[i]}"
    local file="${packed%%$'\037'*}"; local rest="${packed#*$'\037'}"
    local key="${rest%%$'\037'*}"; rest="${rest#*$'\037'}"
    local value="${rest%%$'\037'*}"; local prior="${rest#*$'\037'}"
    local priorJson
    if [ "$prior" = "$AUTOPROMPT_RECEIPT_ABSENT" ]; then
      priorJson='null'
    else
      _receipt_json_escape "$prior" escaped_prior
      priorJson="\"$escaped_prior\""
    fi
    _receipt_json_escape "$file" escaped_file
    _receipt_json_escape "$key" escaped_key
    _receipt_json_escape "$value" escaped_value
    body+=$'\n'"    {"$'\n'
    body+="      \"file\": \"$escaped_file\","$'\n'
    body+="      \"key\": \"$escaped_key\","$'\n'
    body+="      \"value\": \"$escaped_value\","$'\n'
    body+="      \"priorValue\": $priorJson"$'\n'
    body+='    }'
    [ "$i" -lt $((count - 1)) ] && body+=','
  done
  body+=$'\n  ]'
  if [ -n "$output_name" ]; then
    printf -v "$output_name" '%s' "$body"
  else
    printf '%s' "$body"
  fi
}

write_receipt() {
  local root="$1" nonce="$2" backup="${3:-}"

  if [ -z "$root" ]; then
    printf '%s\n' "error=no-config-root" >&2
    return 20
  fi
  if [ ! -d "$root" ] && ! mkdir -p "$root" 2>/dev/null; then
    printf '%s\n' "error=config-root-uncreatable dir=$root" >&2
    return 21
  fi
  if _idem_root_transaction_matches "$root"; then
    _idem_materialize_root_manifest
    local manifest_code=$?
    [ "$manifest_code" -eq 0 ] || return "$manifest_code"
  fi

  local backupJson detachedJson escaped_backup escaped_detached escaped_nonce
  local files_json directories_json edits_json file_sha256_json prior_manifest_json
  local owned recorded_hash
  local -a file_sha256=()
  if [ -z "$backup" ] || [ "$backup" = "none" ]; then
    backupJson='null'
  else
    _receipt_json_escape "$backup" escaped_backup
    backupJson="\"$escaped_backup\""
  fi
  if [ -z "$AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT" ]; then
    detachedJson='null'
  else
    _receipt_json_escape "$AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT" escaped_detached
    detachedJson="\"$escaped_detached\""
  fi

  local json
  _receipt_json_escape "$nonce" escaped_nonce
  _receipt_path_array AUTOPROMPT_RECEIPT_FILES files_json
  for owned in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
    recorded_hash=""
    _idem_read_manifest_hash "$root" "$owned" recorded_hash || return 40
    [ -z "$recorded_hash" ] || file_sha256+=("$owned=$recorded_hash")
  done
  _receipt_path_array file_sha256 file_sha256_json
  if [[ "${AUTOPROMPT_RECEIPT_PRIOR_MANIFEST_SHA256:-}" =~ ^[a-f0-9]{64}$ ]]; then
    prior_manifest_json="\"$AUTOPROMPT_RECEIPT_PRIOR_MANIFEST_SHA256\""
  else
    prior_manifest_json=null
  fi
  _receipt_path_array AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES directories_json
  _receipt_edits_array AUTOPROMPT_RECEIPT_EDITS edits_json
  local omp_managed_json=false
  [ "$AUTOPROMPT_RECEIPT_OMP_MANAGED" -eq 0 ] || omp_managed_json=true
  printf -v json '{\n  "nonce": "%s",\n  "priorManifestSha256": %s,\n  "fileSha256": %s,\n  "backup": %s,\n  "files": %s,\n  "createdDirectories": %s,\n  "ompManaged": %s,\n  "ompDetachedRoot": %s,\n  "configEdits": %s\n}' \
    "$escaped_nonce" "$prior_manifest_json" "$file_sha256_json" "$backupJson" "$files_json" "$directories_json" \
    "$omp_managed_json" "$detachedJson" "$edits_json"

  local final="$root/$AUTOPROMPT_RECEIPT_NAME"
  local tmp="$final.tmp"
  if ! printf '%s\n' "$json" > "$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    printf '%s\n' "error=receipt-tmp-write-failed path=$tmp" >&2
    return 22
  fi
  if [ -f "$final" ] && cmp -s "$tmp" "$final"; then
    rm -f "$tmp"
  elif ! mv -f "$tmp" "$final" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    printf '%s\n' "error=receipt-rename-failed path=$final" >&2
    return 23
  fi

  printf '%s\n' "receipt=$final nonce=$nonce files=${#AUTOPROMPT_RECEIPT_FILES[@]} edits=${#AUTOPROMPT_RECEIPT_EDITS[@]}"
  return 0
}
# --- F-LIB-RECEIPT (end) ---

# --- F-LIB-COPY (begin) ---
# install_copy is "the real copy": it chains resolve_destination -> format_skill
# -> write+record to turn a resolved path + a format token + the skill payload
# into an ACTUAL file on disk in the client's native format. It REUSES the three
# pure transformers (resolve = path math, format = string math, the receipt files
# channel) and adds the only filesystem mutation in the lib.
#
# Signature: install_copy <client> <name> <description> <body> [variant] [config-root]
#   <client> selects the destination/format (the resolve_destination key);
#   <name> is the frontmatter name: value; <body> is passed in ALREADY STRIPPED
#   of any source frontmatter (the file-read + split belongs to the wrapper
#   layer). Because COPY re-mints frontmatter through format_skill (a FIXED
#   name+description literal, no tool-key path), a source body's allowed-tools is
#   structurally DROPPED - this is the P0 (F-OP-NORESTRICT) posture.
#
# Order matters (and is itself the correctness argument): render to a SYSTEM-TEMP
# stage FIRST (no install-tree mutation), capture format's status UN-negated on
# the next line, and only AFTER a successful render mkdir-parents + atomically
# land (stage -> dest.tmp -> mv -f). A deferred/failed format leaves NO
# install-tree dir and NO stray .tmp.
#
# Channel discipline (mirrors detect/resolve/format/receipt): the stdout RECORD
# is `client=<n> copy=ok dest=<path> bytes=<size> format=<fmt>`-shaped; the
# integer return is the VERDICT; all error records go to stderr. Codes:
#   0  landed OK
#   2/3      delegated VERBATIM from resolve (unknown-client / no-such-variant; no-home)
#   2/4/5/6  delegated VERBATIM from format (unknown/empty; deferred; empty-body; body-has-frontmatter)
#   30 parent dir uncreatable (an ancestor is a regular file)
#   31 staging/landing write failed (mktemp or stage->dest copy blocked)
#   32 rename failed (mv -f of dest.tmp onto dest failed)
# 30/31/32 are COPY-OWNED and disjoint from precheck's 10-13 and receipt's 20-23.
#
# Byte-parity (F-OP-DUALPARITY): format_skill already emits '\n'-only + one
# trailing '\n'; COPY streams those bytes verbatim via `> "$stage"` (a redirect,
# NOT $(...) which would strip the trailing newline) and `cp` preserves them.
#
# The kilo trailing-slash directory destination (dest ends in /) lands SKILL.md
# inside it; every other (flat) destination lands at the path itself.

# Init the receipt accumulator once at module scope (guard against clobbering a
# caller-prefilled array, since write_receipt reads it; and so a set -u consumer
# never trips on an unset array). A re-source does not wipe accumulated entries.
[ -n "${AUTOPROMPT_RECEIPT_FILES+set}" ] || declare -a AUTOPROMPT_RECEIPT_FILES=()
[ -n "${AUTOPROMPT_RECEIPT_PRIOR_MANIFEST_SHA256+set}" ] || AUTOPROMPT_RECEIPT_PRIOR_MANIFEST_SHA256=""

_copy_render_stage() {
  local client="$1" fmt="$2" name="$3" description="$4" body="$5"
  local output_name="$6" rendered_path render_code
  local -n rendered_stage="$output_name"
  rendered_path="$(mktemp 2>/dev/null)" || {
    printf '%s\n' "client=$client error=copy-write-failed path=stage" >&2
    return 31
  }
  format_skill "$fmt" "$name" "$description" "$body" > "$rendered_path"
  render_code=$?
  if [ "$render_code" -ne 0 ]; then
    rm -f "$rendered_path" 2>/dev/null
    return "$render_code"
  fi
  rendered_stage="$rendered_path"
}

_copy_land_stage() {
  local client="$1" root="$2" stage="$3" landed="$4"
  local parent="${landed%/*}" existing_parent tmp="$landed.tmp"
  existing_parent="$(_idem_nearest_existing_parent "$landed")"
  if ! mkdir -p "$parent" 2>/dev/null; then
    rm -f "$stage" 2>/dev/null
    printf '%s\n' "client=$client error=parent-uncreatable dir=$parent" >&2
    return 30
  fi
  if ! cp -f "$stage" "$tmp" 2>/dev/null; then
    rm -f "$stage" "$tmp" 2>/dev/null
    printf '%s\n' "client=$client error=copy-write-failed path=$tmp" >&2
    return 31
  fi
  rm -f "$stage" 2>/dev/null
  if ! mv -f "$tmp" "$landed" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    printf '%s\n' "client=$client error=copy-rename-failed path=$landed" >&2
    return 32
  fi
  _idem_register_created_directories "$root" "$landed" "$existing_parent"
  _idem_receipt_owns "$landed" || AUTOPROMPT_RECEIPT_FILES+=("$landed")
}

install_copy() {
  local client="$1" name="$2" description="$3" body="$4" variant="${5:-}"
  local root="${6:-}" rec resolve_code destpath fmt landed stage bytes
  rec="$(resolve_destination "$client" "$variant")"; resolve_code=$?
  [ "$resolve_code" -eq 0 ] || return "$resolve_code"
  destpath="${rec#client=* dest=}"; destpath="${destpath% format=*}"
  fmt="${rec##* format=}"
  case "$destpath" in */) landed="${destpath}SKILL.md" ;; *) landed="$destpath" ;; esac
  _copy_render_stage "$client" "$fmt" "$name" "$description" "$body" stage || return $?
  _copy_land_stage "$client" "$root" "$stage" "$landed" || return $?
  bytes="$(wc -c < "$landed" 2>/dev/null | tr -d ' ')"
  printf '%s\n' "client=$client copy=ok dest=$landed format=$fmt bytes=$bytes"
}
# --- F-LIB-COPY (end) ---

# --- F-LIB-IDEM (begin) ---
# install_idempotent makes a re-run SAFE and SILENT: before any write it decides
# whether the already-landed file is already correct, and writes ONLY when it must.
# It REUSES resolve_destination (path math), format_skill (the bytes), and
# install_copy (the only filesystem mutation); IDEM adds the content-hash, the
# manifest read/write, the receipt-presence check, the decision table, and the
# records. It touches none of those reused functions.
#
# Config-root is an EXPLICIT PARAMETER (mirrors write_receipt's contract): the
# orchestrator passes the SAME root it passes to write_receipt. IDEM does ZERO
# config-root derivation, which is correct for XDG clients BY CONSTRUCTION - the
# receipt-presence check and the manifest both key off the directory the receipt
# actually lives in, whether that root is $HOME (claude) or the XDG base
# (opencode/kilo). Empty config-root => code 41.
#
# Signature: install_idempotent <config-root> <client> <name> <description> <body> [variant]
#
# SHA-256 is computed over the NORMALIZED format_skill payload (\n-only, one
# trailing \n, no BOM): _idem_sha256 falls back sha256sum -> shasum -> openssl,
# lowercase 64-hex; none present => code 42. Because the payload normalization is
# identical across ports, .sh and .ps1 hashes are IDENTICAL hex for the same input
# (F-OP-DUALPARITY).
#
# The manifest sidecar (<config-root>/.autoprompt-install-hashes.json) is
# RECEIPT-TRACKED: after a successful manifest write its absolute path is appended
# (once-guarded) to AUTOPROMPT_RECEIPT_FILES, so the EXISTING uninstall sweeps it
# (zero residue) with no uninstall edit.
#
# Decision table (first matching row wins; R1 = disk-correct never writes,
# R2 = drift wins, UPDATE requires a clean prior install):
#   1  !fileExists                                          -> REPAIR  reason=missing-file
#   2  fileExists && live==expected                         -> NO-WRITE (already-installed v<hash>)
#   3  receiptPresent && live==recorded && recorded!="" && live!=expected -> UPDATE
#   4  !receiptPresent && live==recorded && recorded!=""   -> REPAIR  reason=missing-receipt
#   5/6 live!=recorded (recorded==""? no-fingerprint : hash-drift) -> REPAIR
# UPDATE and REPAIR both re-mint via install_copy, so they only ever land
# expectedHash bytes - a byte change is ALWAYS announced (never silent overwrite).
#
# Records (stdout): NO-WRITE => `already-installed v<hash>` (literal v, no space,
# the content hash IS the version - no skill semver exists); UPDATE =>
# `client=<n> idem=update dest=<l> oldhash=<rec> newhash=<exp>`; REPAIR =>
# `client=<n> idem=repair dest=<l> reason=<…> hash=<exp>`.
#
# Return-code band (IDEM-OWNED 40-49, disjoint from 1-2/2-3/2,4,5,6/10-13/20-23/
# 30-32): 0 any outcome ok; 2/3 delegated from resolve; 2/4/5/6 delegated from
# format; 30/31/32 delegated from install_copy on a re-copy; 40 manifest write
# failed (file IS landed); 41 config-root empty; 42 no sha256 tool; 43 unowned
# OpenCode destination; 44 compensation restore failed; 45 cleanup failed with
# retained recovery state (or a root transaction is already active).
#
# Channel discipline (mirrors the lib): RECORD -> stdout, errors -> stderr, the
# integer return is the VERDICT; never 2>/dev/null a delegated call's stderr.
AUTOPROMPT_HASH_MANIFEST_NAME=".autoprompt-install-hashes.json"

# _idem_sha256 <file>: lowercase 64-hex SHA-256 of <file>, via the documented
# fallback order. Returns 42 + an operator-actionable stderr line if no tool exists.
_idem_sha256() {
  local file="$1" out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$file" 2>/dev/null)" || return 42
    printf '%s' "${out%% *}"
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$file" 2>/dev/null)" || return 42
    printf '%s' "${out%% *}"
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    out="$(openssl dgst -sha256 "$file" 2>/dev/null)" || return 42
    printf '%s' "${out##*= }"
    return 0
  fi
  printf '%s\n' "error=no-sha256-tool" >&2
  printf 'Autoprompt idempotency: no SHA-256 tool found (need sha256sum, shasum, or openssl). Install one and re-run.\n' >&2
  return 42
}

# _idem_read_manifest_hash <root> <key>: echo the recorded hex for <key> from the
# manifest, or empty when the manifest or the key is absent. The manifest is a flat
# JSON object { "<abs-path>": "<hex>", ... } written by _idem_write_manifest; this
# reader matches that exact serialization (4-space-indented "key": "value" lines).
_idem_paths_equal() {
  local left right
  _idem_cached_comparable_path "$1" left || return 1
  _idem_cached_comparable_path "$2" right || return 1
  [ "$left" = "$right" ]
}

_idem_receipt_owns_created_directory() {
  local path="$1" owned comparable owned_comparable
  _idem_cached_comparable_path "$path" comparable || return 1
  for owned in "${AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES[@]:-}"; do
    _idem_cached_comparable_path "$owned" owned_comparable || continue
    [ "$owned_comparable" = "$comparable" ] && return 0
  done
  return 1
}

_idem_add_receipt_created_directory() {
  local path="$1"
  _idem_receipt_owns_created_directory "$path" ||
    AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES+=("$path")
}

_idem_remove_receipt_created_directory() {
  local path="$1" owned
  local -a retained=()
  for owned in "${AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES[@]:-}"; do
    _idem_paths_equal "$owned" "$path" || retained+=("$owned")
  done
  AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=("${retained[@]}")
}

_idem_nearest_existing_parent() {
  local path="$1" directory="${1%/*}" parent
  while [ -n "$directory" ] && [ ! -d "$directory" ]; do
    parent="${directory%/*}"
    [ "$parent" != "$directory" ] || { directory=""; break; }
    directory="$parent"
  done
  printf '%s' "$directory"
}

_idem_register_created_directories() {
  local root="$1" target="$2" existing_parent="$3"
  local directory="${target%/*}" parent candidate index insert
  local -a created=() ordered=()
  while [ -n "$directory" ] &&
        ! _idem_paths_equal "$directory" "$existing_parent" &&
        { [ -z "$root" ] || ! _idem_paths_equal "$directory" "$root"; }; do
    [ -d "$directory" ] && created+=("$directory")
    parent="${directory%/*}"
    [ "$parent" != "$directory" ] || break
    directory="$parent"
  done
  for candidate in "${created[@]:-}"; do
    insert="${#ordered[@]}"
    for ((index = 0; index < ${#ordered[@]}; index++)); do
      [[ "$candidate" < "${ordered[index]}" ]] || continue
      insert="$index"
      break
    done
    ordered=("${ordered[@]:0:insert}" "$candidate" "${ordered[@]:insert}")
  done
  for directory in "${ordered[@]:-}"; do
    [ -n "$directory" ] && _idem_add_receipt_created_directory "$directory"
  done
}

_idem_parse_manifest_entry() {
  local entry="$1" expects_comma="$2"
  local spelling_name="$3" identity_name="$4" hash_name="$5" line_name="$6"
  local escaped canonical_escape comma indent indent_width
  local -n parsed_spelling="$spelling_name" parsed_identity="$identity_name"
  local -n parsed_hash="$hash_name" canonical_line="$line_name"
  if [ "$expects_comma" -eq 1 ]; then
    [ "${entry: -1}" = ',' ] || return 1
    entry="${entry:0:${#entry}-1}"
    comma=','
  else
    [ "${entry: -1}" != ',' ] || return 1
    comma=''
  fi
  case "$entry" in
    '    "'*) indent='    ' ;;
    '  "'*) indent='  ' ;;
    *) return 1 ;;
  esac
  indent_width="${#indent}"
  [ "${#entry}" -ge $((indent_width + 70)) ] || return 1
  [ "${entry: -1}" = '"' ] || return 1
  parsed_hash="${entry: -65:64}"
  [[ "$parsed_hash" =~ ^[a-f0-9]{64}$ ]] || return 1
  entry="${entry:0:${#entry}-65}"
  [ "${entry: -4}" = '": "' ] || return 1
  escaped="${entry:$((indent_width + 1)):${#entry}-$((indent_width + 5))}"
  _uninstall_json_unescape "$escaped" parsed_spelling || return 1
  [ -n "$parsed_spelling" ] || return 1
  _receipt_json_escape "$parsed_spelling" canonical_escape
  [ "$canonical_escape" = "$escaped" ] || return 1
  _idem_cached_comparable_path "$parsed_spelling" parsed_identity || return 1
  [ -n "$parsed_identity" ] || return 1
  canonical_line="$indent\"$canonical_escape\": \"$parsed_hash\"$comma"
}

_idem_parse_manifest() {
  local manifest="$1" spellings_name="$2" identities_name="$3" hashes_name="$4"
  local document="" read_code index spelling identity hash line canonical="{" line_count
  local -a lines=() parsed_spellings=() parsed_identities=() parsed_hashes=()
  declare -A seen_spellings=() seen_identities=()
  local -n published_spellings="$spellings_name" published_identities="$identities_name"
  local -n published_hashes="$hashes_name"
  if [ ! -f "$manifest" ]; then
    published_spellings=(); published_identities=(); published_hashes=()
    return 0
  fi
  IFS= read -r -d '' document < "$manifest"; read_code=$?
  [ "$read_code" -ne 0 ] || return 1
  case "$document" in *$'\r'*) return 1 ;; esac
  mapfile -t lines < <(printf '%s' "$document")
  line_count="${#lines[@]}"
  [ "$line_count" -ge 2 ] || return 1
  [ "${lines[0]}" = '{' ] && [ "${lines[line_count-1]}" = '}' ] || return 1
  for ((index = 1; index < line_count - 1; index++)); do
    _idem_parse_manifest_entry "${lines[index]}" \
      "$((index < line_count - 2))" spelling identity hash line || return 1
    [ -z "${seen_spellings["$spelling"]+set}" ] || return 1
    [ -z "${seen_identities["$identity"]+set}" ] || return 1
    seen_spellings["$spelling"]=1
    seen_identities["$identity"]=1
    parsed_spellings+=("$spelling")
    parsed_identities+=("$identity")
    parsed_hashes+=("$hash")
    canonical+=$'\n'"$line"
  done
  canonical+=$'\n}\n'
  [ "$document" = "$canonical" ] || return 1
  published_spellings=("${parsed_spellings[@]}")
  published_identities=("${parsed_identities[@]}")
  published_hashes=("${parsed_hashes[@]}")
}

_idem_manifest_recorded_key() {
  local manifest="$1" key="$2" output_name="${3:-}" comparable index
  local -a spellings=() identities=() hashes=()
  _idem_parse_manifest "$manifest" spellings identities hashes || return 2
  _idem_cached_comparable_path "$key" comparable || return 2
  for ((index = 0; index < ${#identities[@]}; index++)); do
    [ "${identities[index]}" = "$comparable" ] || continue
    if [ -n "$output_name" ]; then
      printf -v "$output_name" '%s' "${spellings[index]}"
    else
      printf '%s' "${spellings[index]}"
    fi
    return 0
  done
  return 1
}

_idem_assign_manifest_hash() {
  local output_name="$1" hash="$2"
  if [ -n "$output_name" ]; then
    printf -v "$output_name" '%s' "$hash"
  else
    printf '%s' "$hash"
  fi
}

_idem_read_manifest_hash() {
  local root="$1" key="$2" output_name="${3:-}" hash="" comparable index
  local manifest="$root/$AUTOPROMPT_HASH_MANIFEST_NAME"
  local -a spellings=() identities=() hashes=()
  _idem_cached_comparable_path "$key" comparable || return 1
  if _idem_root_transaction_matches "$root"; then
    if [ -n "${AUTOPROMPT_ROOT_MANIFEST_SPELLINGS["$comparable"]+set}" ]; then
      hash="${AUTOPROMPT_ROOT_MANIFEST_HASHES["$comparable"]}"
    fi
    _idem_assign_manifest_hash "$output_name" "$hash"
    return 0
  fi
  _idem_parse_manifest "$manifest" spellings identities hashes || return 1
  for ((index = 0; index < ${#identities[@]}; index++)); do
    [ "${identities[index]}" = "$comparable" ] || continue
    hash="${hashes[index]}"
    break
  done
  _idem_assign_manifest_hash "$output_name" "$hash"
}

_idem_manifest_lines() {
  local manifest="$1" skip_key="$2" comparable index escaped hash
  local -a spellings=() identities=() hashes=()
  _idem_parse_manifest "$manifest" spellings identities hashes || return 1
  _idem_cached_comparable_path "$skip_key" comparable || return 1
  for ((index = 0; index < ${#identities[@]}; index++)); do
    [ "${identities[index]}" = "$comparable" ] && continue
    _receipt_json_escape "${spellings[index]}" escaped
    hash="${hashes[index]}"
    printf '    "%s": "%s"\n' "$escaped" "$hash"
  done
}

_idem_transaction_rewrite_manifest() {
  local root="$1" key="$2" hash="$3" mode="$4" comparable existing_hash=""
  local has_existing=0
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]] || [ "$mode" = "remove" ] || return 40
  _idem_cached_comparable_path "$key" comparable || return 1
  if [ -n "${AUTOPROMPT_ROOT_MANIFEST_SPELLINGS["$comparable"]+set}" ]; then
    has_existing=1
    existing_hash="${AUTOPROMPT_ROOT_MANIFEST_HASHES["$comparable"]}"
  fi
  if [ "$mode" = "remove" ]; then
    [ "$has_existing" -eq 1 ] || return 0
    unset 'AUTOPROMPT_ROOT_MANIFEST_SPELLINGS["$comparable"]'
    unset 'AUTOPROMPT_ROOT_MANIFEST_HASHES["$comparable"]'
  else
    if [ "$has_existing" -eq 1 ] && [ "$existing_hash" = "$hash" ] &&
       [ "${AUTOPROMPT_ROOT_MANIFEST_ORDER[${#AUTOPROMPT_ROOT_MANIFEST_ORDER[@]}-1]:-}" = "$comparable" ]; then
      return 0
    fi
    [ "$has_existing" -eq 1 ] || AUTOPROMPT_ROOT_MANIFEST_SPELLINGS["$comparable"]="$key"
    AUTOPROMPT_ROOT_MANIFEST_HASHES["$comparable"]="$hash"
  fi
  AUTOPROMPT_ROOT_MANIFEST_ORDER+=("$comparable")
  AUTOPROMPT_ROOT_MANIFEST_DIRTY=1
  _idem_mark_root_transaction_changed "$root"
}

_idem_rewrite_manifest() {
  local root="$1" key="$2" hash="${3:-}" mode="${4:-upsert}"
  if _idem_root_transaction_matches "$root"; then
    _idem_transaction_rewrite_manifest "$root" "$key" "$hash" "$mode"
    return $?
  fi
  local manifest="$root/$AUTOPROMPT_HASH_MANIFEST_NAME" comparable index spelling escaped
  local has_existing=0
  local -a spellings=() identities=() hashes=() lines=()
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]] || [ "$mode" = "remove" ] || return 40
  _idem_parse_manifest "$manifest" spellings identities hashes || return 40
  _idem_cached_comparable_path "$key" comparable || return 40
  for ((index = 0; index < ${#identities[@]}; index++)); do
    if [ "${identities[index]}" = "$comparable" ]; then
      has_existing=1
      spelling="${spellings[index]}"
      continue
    fi
    _receipt_json_escape "${spellings[index]}" escaped
    lines+=("    \"$escaped\": \"${hashes[index]}\"")
  done
  if [ "$mode" = "remove" ]; then
    [ "$has_existing" -eq 1 ] || return 0
  else
    [ "$has_existing" -eq 1 ] || spelling="$key"
    _receipt_json_escape "$spelling" escaped
    lines+=("    \"$escaped\": \"$hash\"")
  fi
  _idem_materialize_manifest_lines "$manifest" "${lines[@]}"
}

_idem_materialize_manifest_lines() {
  local manifest="$1"; shift
  local tmp="$manifest.tmp" body="{" index
  local -a lines=("$@")
  for ((index = 0; index < ${#lines[@]}; index++)); do
    body+=$'\n'"${lines[index]}"
    [ "$index" -lt $((${#lines[@]} - 1)) ] && body+=","
  done
  body+=$'\n'"}"
  if ! printf '%s\n' "$body" > "$tmp" 2>/dev/null; then
    rm -f -- "$tmp" 2>/dev/null
    printf '%s\n' "error=hash-manifest-write-failed path=$tmp" >&2
    return 40
  fi
  if [ -f "$manifest" ] && cmp -s "$tmp" "$manifest"; then
    rm -f -- "$tmp"
    return 0
  fi
  if ! mv -f -- "$tmp" "$manifest" 2>/dev/null; then
    rm -f -- "$tmp" 2>/dev/null
    printf '%s\n' "error=hash-manifest-write-failed path=$manifest" >&2
    return 40
  fi
}

_idem_write_manifest() {
  _idem_rewrite_manifest "$1" "$2" "$3" upsert
}

_idem_remove_manifest_hash() {
  _idem_rewrite_manifest "$1" "$2" "" remove
}

_idem_receipt_owns() {
  local target="$1" owned comparable owned_comparable
  _idem_cached_comparable_path "$target" comparable || return 1
  for owned in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
    _idem_cached_comparable_path "$owned" owned_comparable || continue
    [ "$owned_comparable" = "$comparable" ] && return 0
  done
  return 1
}

_idem_register_manifest() {
  local manifest="$1/$AUTOPROMPT_HASH_MANIFEST_NAME"
  _idem_receipt_owns "$manifest" || AUTOPROMPT_RECEIPT_FILES+=("$manifest")
}

_idem_register_managed_file() {
  local root="$1" file="$2" hash
  hash="$(_idem_sha256 "$file")" || return $?
  _idem_write_manifest "$root" "$file" "$hash" || return $?
  _idem_receipt_owns "$file" || AUTOPROMPT_RECEIPT_FILES+=("$file")
  _idem_register_manifest "$root"
}

_idem_atomic_copy() {
  local source="$1" target="$2" parent="${2%/*}" tmp="${2}.autoprompt.tmp"
  if [ -f "$target" ] && cmp -s "$source" "$target"; then return 0; fi
  mkdir -p -- "$parent" 2>/dev/null || return 1
  cp -- "$source" "$tmp" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; return 1; }
  mv -f -- "$tmp" "$target" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; return 1; }
}

_idem_codex_stable_source_copy() {
  local root="$1" source="$2" target="$3" expected_hash="$4"
  local before_copy="${5:-}" parent="${3%/*}"
  local tmp="${3}.autoprompt.codex.tmp.$$" copied_hash source_post_hash relative
  relative="${target#"$root"/}"
  [ "$relative" != "$target" ] || relative="${target##*/}"
  mkdir -p -- "$parent" 2>/dev/null || return 39
  if [ -n "$before_copy" ]; then
    "$before_copy" "$source" "$target" || {
      rm -f -- "$tmp" 2>/dev/null
      return 39
    }
  fi
  cp -- "$source" "$tmp" 2>/dev/null || {
    rm -f -- "$tmp" 2>/dev/null
    return 39
  }
  copied_hash="$(_idem_sha256 "$tmp")" || {
    rm -f -- "$tmp" 2>/dev/null
    return 39
  }
  source_post_hash="$(_idem_sha256 "$source")" || {
    rm -f -- "$tmp" 2>/dev/null
    return 39
  }
  if [ "$copied_hash" != "$expected_hash" ] ||
     [ "$source_post_hash" != "$expected_hash" ]; then
    printf '%s\n' \
      "client=codex error=SOURCE_CHANGED_DURING_COPY file=$relative expected=$expected_hash copied=$copied_hash source_post=$source_post_hash" >&2
    rm -f -- "$tmp" 2>/dev/null
    return 46
  fi
  mv -f -- "$tmp" "$target" 2>/dev/null || {
    rm -f -- "$tmp" 2>/dev/null
    return 39
  }
}

[ -n "${AUTOPROMPT_MANAGED_UNDO_JOURNAL+set}" ] || declare -a AUTOPROMPT_MANAGED_UNDO_JOURNAL=()
[ -n "${AUTOPROMPT_ROOT_TRANSACTION_DIR+set}" ] || AUTOPROMPT_ROOT_TRANSACTION_DIR=""
[ -n "${AUTOPROMPT_ROOT_TRANSACTION_ROOT+set}" ] || AUTOPROMPT_ROOT_TRANSACTION_ROOT=""
[ -n "${AUTOPROMPT_ROOT_TRANSACTION_PATHS+set}" ] || declare -a AUTOPROMPT_ROOT_TRANSACTION_PATHS=()
[ -n "${AUTOPROMPT_ROOT_TRANSACTION_SNAPSHOTS+set}" ] || declare -a AUTOPROMPT_ROOT_TRANSACTION_SNAPSHOTS=()
[ -n "${AUTOPROMPT_ROOT_TRANSACTION_CHANGED+set}" ] || AUTOPROMPT_ROOT_TRANSACTION_CHANGED=0
[ -n "${AUTOPROMPT_ROOT_MANIFEST_ORDER+set}" ] || declare -a AUTOPROMPT_ROOT_MANIFEST_ORDER=()
[ -n "${AUTOPROMPT_ROOT_MANIFEST_SPELLINGS+set}" ] || declare -A AUTOPROMPT_ROOT_MANIFEST_SPELLINGS=()
[ -n "${AUTOPROMPT_ROOT_MANIFEST_HASHES+set}" ] || declare -A AUTOPROMPT_ROOT_MANIFEST_HASHES=()
[ -n "${AUTOPROMPT_ROOT_MANIFEST_DIRTY+set}" ] || AUTOPROMPT_ROOT_MANIFEST_DIRTY=0

_idem_root_transaction_matches() {
  [ -n "$AUTOPROMPT_ROOT_TRANSACTION_DIR" ] &&
    [ "$AUTOPROMPT_ROOT_TRANSACTION_ROOT" = "$1" ]
}

_idem_mark_root_transaction_changed() {
  _idem_root_transaction_matches "$1" &&
    AUTOPROMPT_ROOT_TRANSACTION_CHANGED=1
  return 0
}

_idem_clear_root_manifest_state() {
  AUTOPROMPT_ROOT_MANIFEST_ORDER=()
  AUTOPROMPT_ROOT_MANIFEST_SPELLINGS=()
  AUTOPROMPT_ROOT_MANIFEST_HASHES=()
  AUTOPROMPT_ROOT_MANIFEST_DIRTY=0
}

_idem_load_root_manifest() {
  local root="$1" manifest="$1/$AUTOPROMPT_HASH_MANIFEST_NAME" index
  local -a spellings=() identities=() hashes=()
  local -a parsed_order=()
  declare -A parsed_spellings=() parsed_hashes=()
  _idem_parse_manifest "$manifest" spellings identities hashes || return 1
  for ((index = 0; index < ${#identities[@]}; index++)); do
    parsed_order+=("${identities[index]}")
    parsed_spellings["${identities[index]}"]="${spellings[index]}"
    parsed_hashes["${identities[index]}"]="${hashes[index]}"
  done
  AUTOPROMPT_ROOT_MANIFEST_ORDER=("${parsed_order[@]}")
  AUTOPROMPT_ROOT_MANIFEST_SPELLINGS=()
  AUTOPROMPT_ROOT_MANIFEST_HASHES=()
  for ((index = 0; index < ${#parsed_order[@]}; index++)); do
    AUTOPROMPT_ROOT_MANIFEST_SPELLINGS["${parsed_order[index]}"]="${parsed_spellings["${parsed_order[index]}"]}"
    AUTOPROMPT_ROOT_MANIFEST_HASHES["${parsed_order[index]}"]="${parsed_hashes["${parsed_order[index]}"]}"
  done
  AUTOPROMPT_ROOT_MANIFEST_DIRTY=0
}

_idem_materialize_root_manifest() {
  [ "$AUTOPROMPT_ROOT_MANIFEST_DIRTY" -eq 1 ] || return 0
  local manifest="$AUTOPROMPT_ROOT_TRANSACTION_ROOT/$AUTOPROMPT_HASH_MANIFEST_NAME"
  local identity spelling hash esc_spelling esc_hash index
  local -a lines=()
  declare -A latest_index=()
  for ((index = 0; index < ${#AUTOPROMPT_ROOT_MANIFEST_ORDER[@]}; index++)); do
    identity="${AUTOPROMPT_ROOT_MANIFEST_ORDER[index]}"
    latest_index["$identity"]="$index"
  done
  for ((index = 0; index < ${#AUTOPROMPT_ROOT_MANIFEST_ORDER[@]}; index++)); do
    identity="${AUTOPROMPT_ROOT_MANIFEST_ORDER[index]}"
    [ -n "${AUTOPROMPT_ROOT_MANIFEST_SPELLINGS[$identity]+set}" ] || continue
    [ "${latest_index["$identity"]}" = "$index" ] || continue
    spelling="${AUTOPROMPT_ROOT_MANIFEST_SPELLINGS[$identity]}"
    hash="${AUTOPROMPT_ROOT_MANIFEST_HASHES[$identity]}"
    _receipt_json_escape "$spelling" esc_spelling
    _receipt_json_escape "$hash" esc_hash
    lines+=("    \"$esc_spelling\": \"$esc_hash\"")
  done
  _idem_materialize_manifest_lines "$manifest" "${lines[@]}" || return $?
  AUTOPROMPT_ROOT_MANIFEST_DIRTY=0
}

_idem_snapshot_root_path() {
  local path="$1" existing index snapshot existing_parent parent mode
  [ -n "$AUTOPROMPT_ROOT_TRANSACTION_DIR" ] || return 0
  for existing in "${AUTOPROMPT_ROOT_TRANSACTION_PATHS[@]:-}"; do
    [ "$existing" = "$path" ] && return 0
  done

  existing_parent="${path%/*}"
  while [ -n "$existing_parent" ] && [ ! -d "$existing_parent" ]; do
    parent="${existing_parent%/*}"
    [ "$parent" != "$existing_parent" ] || { existing_parent=""; break; }
    existing_parent="$parent"
  done
  index="${#AUTOPROMPT_ROOT_TRANSACTION_PATHS[@]}"
  snapshot="$AUTOPROMPT_ROOT_TRANSACTION_DIR/paths/$index"
  mkdir -p -- "$snapshot" || return 1
  printf 'SNAPSHOT_PATH=%q\nSNAPSHOT_EXISTING_PARENT=%q\n' \
    "$path" "$existing_parent" > "$snapshot/meta" || return 1
  if [ -f "$path" ]; then
    cp -p -- "$path" "$snapshot/file" || return 1
  elif [ -d "$path" ]; then
    mode="$(stat -c %a "$path" 2>/dev/null || stat -f %Lp "$path" 2>/dev/null)" || return 1
    printf 'SNAPSHOT_DIRECTORY=1\nSNAPSHOT_DIRECTORY_MODE=%q\n' \
      "$mode" >> "$snapshot/meta" || return 1
    : > "$snapshot/directory-time" || return 1
    touch -r "$path" "$snapshot/directory-time" || return 1
  fi
  AUTOPROMPT_ROOT_TRANSACTION_PATHS+=("$path")
  AUTOPROMPT_ROOT_TRANSACTION_SNAPSHOTS+=("$snapshot")
}

_idem_snapshot_root_parent_directories() {
  local root="$1" path="$2" directory parent index
  local -a directories=()
  directory="${path%/*}"
  _idem_path_under_root "$directory" "$root" || return 0
  while [ -n "$directory" ] && [ -d "$directory" ]; do
    directories+=("$directory")
    _idem_paths_equal "$directory" "$root" && break
    parent="${directory%/*}"
    [ "$parent" != "$directory" ] || break
    directory="$parent"
  done
  for ((index = ${#directories[@]} - 1; index >= 0; index--)); do
    _idem_snapshot_root_path "${directories[index]}" || return 1
  done
}

_idem_snapshot_root_config_state() {
  local packed file backup
  for packed in "${AUTOPROMPT_RECEIPT_EDITS[@]:-}"; do
    file="${packed%%$'\037'*}"
    [ -n "$file" ] || continue
    command -v cygpath >/dev/null 2>&1 && file="$(cygpath -u -- "$file")"
    _idem_snapshot_root_parent_directories "$AUTOPROMPT_ROOT_TRANSACTION_ROOT" "$file" || return 1
    _idem_snapshot_root_path "$file" || return 1
    _idem_snapshot_root_path "$file$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" || return 1
  done
  backup="$AUTOPROMPT_CONFIGEDIT_LAST_BACKUP"
  if [ -n "$backup" ] && [ "$backup" != "none" ]; then
    command -v cygpath >/dev/null 2>&1 && backup="$(cygpath -u -- "$backup")"
    _idem_snapshot_root_parent_directories "$AUTOPROMPT_ROOT_TRANSACTION_ROOT" "$backup" || return 1
    _idem_snapshot_root_path "$backup" || return 1
  fi
  return 0
}

_idem_begin_root_transaction() {
  local root="$1" state
  [ -n "$root" ] || return 41
  [ -z "$AUTOPROMPT_ROOT_TRANSACTION_DIR" ] || return 45
  state="$(mktemp -d 2>/dev/null)" || return 39

  AUTOPROMPT_ROOT_TRANSACTION_DIR="$state"
  AUTOPROMPT_ROOT_TRANSACTION_ROOT="$root"
  AUTOPROMPT_ROOT_TRANSACTION_PATHS=()
  AUTOPROMPT_ROOT_TRANSACTION_SNAPSHOTS=()
  AUTOPROMPT_ROOT_TRANSACTION_CHANGED=0
  printf '%s\0' "${AUTOPROMPT_RECEIPT_FILES[@]:-}" > "$state/receipt-files"
  printf '%s\0' "${AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES[@]:-}" \
    > "$state/receipt-created-directories"
  printf '%s\0' "${AUTOPROMPT_RECEIPT_EDITS[@]:-}" > "$state/receipt-edits"
  printf '%s' "$AUTOPROMPT_CONFIGEDIT_LAST_BACKUP" > "$state/last-backup"
  printf '%s' "$AUTOPROMPT_RECEIPT_OMP_MANAGED" > "$state/omp-managed"
  printf '%s' "$AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT" > "$state/omp-detached-root"

  _idem_snapshot_root_path "$root/$AUTOPROMPT_HASH_MANIFEST_NAME" &&
    _idem_snapshot_root_path "$root/$AUTOPROMPT_RECEIPT_NAME" &&
    _idem_snapshot_root_config_state &&
    _idem_load_root_manifest "$root" && return 0

  rm -rf -- "$state"
  AUTOPROMPT_ROOT_TRANSACTION_DIR=""
  AUTOPROMPT_ROOT_TRANSACTION_ROOT=""
  AUTOPROMPT_ROOT_TRANSACTION_PATHS=()
  AUTOPROMPT_ROOT_TRANSACTION_SNAPSHOTS=()
  AUTOPROMPT_ROOT_TRANSACTION_CHANGED=0
  _idem_clear_root_manifest_state
  return 39
}

_idem_restore_root_path() {
  local snapshot="$1" SNAPSHOT_PATH SNAPSHOT_EXISTING_PARENT=""
  local SNAPSHOT_DIRECTORY=0 SNAPSHOT_DIRECTORY_MODE="" had_file=0
  [ -f "$snapshot/meta" ] || return 1
  . "$snapshot/meta"
  if [ -f "$snapshot/file" ]; then
    had_file=1
    _idem_restore_snapshot_file "$snapshot/file" "$SNAPSHOT_PATH" || return 1
  elif [ "$SNAPSHOT_DIRECTORY" -eq 1 ]; then
    mkdir -p -- "$SNAPSHOT_PATH" || return 1
    chmod "$SNAPSHOT_DIRECTORY_MODE" "$SNAPSHOT_PATH" || return 1
    touch -r "$snapshot/directory-time" "$SNAPSHOT_PATH" || return 1
  else
    _idem_restore_snapshot_file "$snapshot/file" "$SNAPSHOT_PATH" || return 1
  fi
  if [ "$had_file" -eq 0 ] && [ "$SNAPSHOT_DIRECTORY" -eq 0 ]; then
    _uninstall_remove_empty_dirs \
      "${SNAPSHOT_EXISTING_PARENT:-$AUTOPROMPT_ROOT_TRANSACTION_ROOT}" "$SNAPSHOT_PATH"
  fi
}

_idem_restore_root_accumulators() {
  local state="$1" owned
  AUTOPROMPT_RECEIPT_FILES=()
  while IFS= read -r -d '' owned; do
    [ -n "$owned" ] && AUTOPROMPT_RECEIPT_FILES+=("$owned")
  done < "$state/receipt-files"
  AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=()
  if [ -f "$state/receipt-created-directories" ]; then
    while IFS= read -r -d '' owned; do
      [ -n "$owned" ] && AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES+=("$owned")
    done < "$state/receipt-created-directories"
  fi
  AUTOPROMPT_RECEIPT_EDITS=()
  while IFS= read -r -d '' owned; do
    [ -n "$owned" ] && AUTOPROMPT_RECEIPT_EDITS+=("$owned")
  done < "$state/receipt-edits"
  AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="$(cat "$state/last-backup")" || return 1
  if [ -f "$state/omp-managed" ]; then
    AUTOPROMPT_RECEIPT_OMP_MANAGED="$(cat "$state/omp-managed")" || return 1
  else
    AUTOPROMPT_RECEIPT_OMP_MANAGED=0
  fi
  if [ -f "$state/omp-detached-root" ]; then
    AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT="$(cat "$state/omp-detached-root")" ||
      return 1
  else
    AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT=""
  fi
}

_idem_clear_root_transaction() {
  local state="$AUTOPROMPT_ROOT_TRANSACTION_DIR"
  rm -rf -- "$state" || return 1
  AUTOPROMPT_ROOT_TRANSACTION_DIR=""
  AUTOPROMPT_ROOT_TRANSACTION_ROOT=""
  AUTOPROMPT_ROOT_TRANSACTION_PATHS=()
  AUTOPROMPT_ROOT_TRANSACTION_SNAPSHOTS=()
  AUTOPROMPT_ROOT_TRANSACTION_CHANGED=0
  _idem_clear_root_manifest_state
}

_idem_rollback_root_transaction() {
  local index restored=0 state="$AUTOPROMPT_ROOT_TRANSACTION_DIR"
  [ -n "$state" ] && [ -d "$state" ] || return 1
  for ((index = ${#AUTOPROMPT_ROOT_TRANSACTION_SNAPSHOTS[@]} - 1;
        index >= 0;
        index--)); do
    _idem_restore_root_path \
      "${AUTOPROMPT_ROOT_TRANSACTION_SNAPSHOTS[index]}" || restored=1
  done
  _idem_restore_root_accumulators "$state" || restored=1
  [ "$restored" -eq 0 ] || return 1
  _idem_clear_root_transaction
}

_idem_commit_root_transaction() {
  [ -n "$AUTOPROMPT_ROOT_TRANSACTION_DIR" ] || return 1
  if [ "$AUTOPROMPT_ROOT_MANIFEST_DIRTY" -eq 1 ] &&
     { [ -f "$AUTOPROMPT_ROOT_TRANSACTION_ROOT/$AUTOPROMPT_HASH_MANIFEST_NAME" ] ||
       [ -f "$AUTOPROMPT_ROOT_TRANSACTION_ROOT/$AUTOPROMPT_RECEIPT_NAME" ]; }; then
    _idem_materialize_root_manifest || return $?
  fi
  _idem_clear_root_transaction
}

_idem_new_managed_snapshot() {
  local root="$1" target="$2" snapshot manifest existing_parent parent
  local existing_parent_mode root_mode
  manifest="$root/$AUTOPROMPT_HASH_MANIFEST_NAME"
  existing_parent="${target%/*}"
  while [ -n "$existing_parent" ] && [ ! -d "$existing_parent" ]; do
    parent="${existing_parent%/*}"
    [ "$parent" != "$existing_parent" ] || { existing_parent=""; break; }
    existing_parent="$parent"
  done
  snapshot="$(mktemp -d 2>/dev/null)" || return 1
  printf 'SNAPSHOT_ROOT=%q\nSNAPSHOT_TARGET=%q\nSNAPSHOT_EXISTING_PARENT=%q\n' \
    "$root" "$target" "$existing_parent" > "$snapshot/meta"
  if [ -d "$existing_parent" ]; then
    existing_parent_mode="$(stat -c %a "$existing_parent" 2>/dev/null || \
      stat -f %Lp "$existing_parent" 2>/dev/null)" || {
      rm -rf -- "$snapshot"
      return 1
    }
    printf 'SNAPSHOT_EXISTING_PARENT_MODE=%q\n' "$existing_parent_mode" \
      >> "$snapshot/meta"
    : > "$snapshot/existing-parent-time"
    touch -r "$existing_parent" "$snapshot/existing-parent-time" || {
      rm -rf -- "$snapshot"
      return 1
    }
  fi
  if [ -d "$root" ]; then
    root_mode="$(stat -c %a "$root" 2>/dev/null || \
      stat -f %Lp "$root" 2>/dev/null)" || {
      rm -rf -- "$snapshot"
      return 1
    }
    printf 'SNAPSHOT_ROOT_MODE=%q\n' "$root_mode" >> "$snapshot/meta"
    : > "$snapshot/root-time"
    touch -r "$root" "$snapshot/root-time" || {
      rm -rf -- "$snapshot"
      return 1
    }
  fi
  if [ -f "$target" ]; then cp -p -- "$target" "$snapshot/target" || { rm -rf -- "$snapshot"; return 1; }; fi
  if [ -f "$manifest" ]; then cp -p -- "$manifest" "$snapshot/manifest" || { rm -rf -- "$snapshot"; return 1; }; fi
  printf '%s\0' "${AUTOPROMPT_RECEIPT_FILES[@]:-}" > "$snapshot/receipt-files"
  printf '%s\0' "${AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES[@]:-}" \
    > "$snapshot/receipt-created-directories"
  printf '%s\0' "${AUTOPROMPT_RECEIPT_EDITS[@]:-}" > "$snapshot/receipt-edits"
  printf '%s' "$AUTOPROMPT_CONFIGEDIT_LAST_BACKUP" > "$snapshot/last-backup"
  printf '%s' "$AUTOPROMPT_RECEIPT_OMP_MANAGED" > "$snapshot/omp-managed"
  printf '%s' "$AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT" > "$snapshot/omp-detached-root"
  printf '%s' "$snapshot"
}

_idem_restore_snapshot_file() {
  local backup="$1" target="$2" tmp="${2}.autoprompt.restore.tmp"
  if [ ! -f "$backup" ]; then rm -f -- "$target" "$tmp"; return 0; fi
  mkdir -p -- "${target%/*}" || return 1
  cp -p -- "$backup" "$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$target" || { rm -f -- "$tmp"; return 1; }
}

_idem_restore_managed_snapshot() {
  local snapshot="$1" SNAPSHOT_ROOT SNAPSHOT_TARGET SNAPSHOT_EXISTING_PARENT=""
  local SNAPSHOT_EXISTING_PARENT_MODE="" SNAPSHOT_ROOT_MODE=""
  local restored=0 owned had_target=0
  [ -d "$snapshot" ] && [ -f "$snapshot/meta" ] || return 1
  . "$snapshot/meta"
  [ -f "$snapshot/target" ] && had_target=1
  _idem_restore_snapshot_file "$snapshot/target" "$SNAPSHOT_TARGET" || restored=1
  _idem_restore_snapshot_file "$snapshot/manifest" "$SNAPSHOT_ROOT/$AUTOPROMPT_HASH_MANIFEST_NAME" || restored=1
  [ "$restored" -eq 0 ] || return 1
  [ "$had_target" -eq 1 ] || _uninstall_remove_empty_dirs \
    "${SNAPSHOT_EXISTING_PARENT:-$SNAPSHOT_ROOT}" "$SNAPSHOT_TARGET"
  if [ -f "$snapshot/existing-parent-time" ]; then
    chmod "$SNAPSHOT_EXISTING_PARENT_MODE" "$SNAPSHOT_EXISTING_PARENT" || restored=1
    touch -r "$snapshot/existing-parent-time" "$SNAPSHOT_EXISTING_PARENT" || restored=1
  fi
  if [ -f "$snapshot/root-time" ]; then
    chmod "$SNAPSHOT_ROOT_MODE" "$SNAPSHOT_ROOT" || restored=1
    touch -r "$snapshot/root-time" "$SNAPSHOT_ROOT" || restored=1
  fi
  [ "$restored" -eq 0 ] || return 1
  AUTOPROMPT_RECEIPT_FILES=()
  while IFS= read -r -d '' owned; do [ -n "$owned" ] && AUTOPROMPT_RECEIPT_FILES+=("$owned"); done < "$snapshot/receipt-files"
  AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=()
  if [ -f "$snapshot/receipt-created-directories" ]; then
    while IFS= read -r -d '' owned; do
      [ -n "$owned" ] && AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES+=("$owned")
    done < "$snapshot/receipt-created-directories"
  fi
  AUTOPROMPT_RECEIPT_EDITS=()
  while IFS= read -r -d '' owned; do [ -n "$owned" ] && AUTOPROMPT_RECEIPT_EDITS+=("$owned"); done < "$snapshot/receipt-edits"
  AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="$(cat "$snapshot/last-backup")"
  if [ -f "$snapshot/omp-managed" ]; then
    AUTOPROMPT_RECEIPT_OMP_MANAGED="$(cat "$snapshot/omp-managed")"
  else
    AUTOPROMPT_RECEIPT_OMP_MANAGED=0
  fi
  if [ -f "$snapshot/omp-detached-root" ]; then
    AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT="$(cat "$snapshot/omp-detached-root")"
  else
    AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT=""
  fi
  rm -rf -- "$snapshot"
}

_idem_add_managed_undo() {
  AUTOPROMPT_MANAGED_UNDO_JOURNAL+=("$1")
}

_idem_undo_managed_changes() {
  local from="${1:-0}" index snapshot restored=0
  for ((index = ${#AUTOPROMPT_MANAGED_UNDO_JOURNAL[@]} - 1; index >= from; index--)); do
    snapshot="${AUTOPROMPT_MANAGED_UNDO_JOURNAL[index]}"
    if _idem_restore_managed_snapshot "$snapshot"; then
      unset 'AUTOPROMPT_MANAGED_UNDO_JOURNAL[index]'
    else
      restored=1
    fi
  done
  AUTOPROMPT_MANAGED_UNDO_JOURNAL=("${AUTOPROMPT_MANAGED_UNDO_JOURNAL[@]}")
  return "$restored"
}

_idem_complete_managed_changes() {
  local from="${1:-0}" index snapshot failed=0
  for ((index = ${#AUTOPROMPT_MANAGED_UNDO_JOURNAL[@]} - 1; index >= from; index--)); do
    snapshot="${AUTOPROMPT_MANAGED_UNDO_JOURNAL[index]}"
    if rm -rf -- "$snapshot"; then
      unset 'AUTOPROMPT_MANAGED_UNDO_JOURNAL[index]'
    else
      failed=1
    fi
  done
  AUTOPROMPT_MANAGED_UNDO_JOURNAL=("${AUTOPROMPT_MANAGED_UNDO_JOURNAL[@]}")
  return "$failed"
}

_idem_target_is_unowned_collision() {
  local target="$1"
  { [ -e "$target" ] || [ -L "$target" ]; } &&
    { [ ! -f "$target" ] || [ -L "$target" ] ||
      ! _idem_receipt_owns "$target"; }
}

_idem_managed_file_is_current() {
  local root="$1" target="$2" source_hash="$3" recorded_hash="$4"
  [ -f "$target" ] &&
    [ "$(_idem_sha256 "$target")" = "$source_hash" ] &&
    [ "$recorded_hash" = "$source_hash" ] &&
    _idem_receipt_owns "$target" &&
    _idem_receipt_owns "$root/$AUTOPROMPT_HASH_MANIFEST_NAME"
}

_idem_prepare_managed_install() {
  local root="$1" target="$2" snapshot_name="$3" transaction_name="$4"
  local -n prepared_snapshot="$snapshot_name" transaction_ref="$transaction_name"
  if _idem_root_transaction_matches "$root"; then
    _idem_snapshot_root_parent_directories "$root" "$target" || return 39
    _idem_snapshot_root_path "$target" || return 39
    transaction_ref=1
    return 0
  fi
  prepared_snapshot="$(_idem_new_managed_snapshot "$root" "$target")" || return 39
}

_idem_restore_managed_install_failure() {
  local snapshot="$1" is_root_transaction="$2" failure_code="$3"
  [ "$is_root_transaction" -eq 0 ] || return "$failure_code"
  if ! _idem_restore_managed_snapshot "$snapshot"; then
    _idem_add_managed_undo "$snapshot"
    return 44
  fi
  return "$failure_code"
}

_idem_install_managed_file() {
  local root="$1" source="$2" target="$3" refuse_unowned="${4:-0}"
  local track_managed="${5:-1}" allow_unowned="${6:-0}"
  local stable_source="${7:-0}" before_copy="${8:-}"
  local source_hash recorded_hash snapshot="" rc is_root_transaction=0
  local existing_parent
  existing_parent="$(_idem_nearest_existing_parent "$target")"
  if [ "$refuse_unowned" -eq 1 ] && { [ -e "$target" ] || [ -L "$target" ]; }; then
    if [ "$allow_unowned" -eq 1 ]; then
      [ -f "$target" ] && [ ! -L "$target" ] || return 43
    elif _idem_target_is_unowned_collision "$target"; then
      return 43
    fi
  fi
  source_hash="$(_idem_sha256 "$source")" || return $?
  if [ "$track_managed" -eq 0 ] && [ -f "$target" ] &&
     cmp -s "$source" "$target"; then
    return 0
  fi
  if ! _idem_read_manifest_hash "$root" "$target" recorded_hash; then
    printf '%s\n' \
      "error=hash-manifest-read-failed path=$root/$AUTOPROMPT_HASH_MANIFEST_NAME" >&2
    return 40
  fi
  if [ "$track_managed" -eq 1 ]; then
    _idem_managed_file_is_current \
      "$root" "$target" "$source_hash" "$recorded_hash" && return 0
  fi
  _idem_prepare_managed_install \
    "$root" "$target" snapshot is_root_transaction || return $?
  if [ "$stable_source" -eq 1 ]; then
    _idem_codex_stable_source_copy \
      "$root" "$source" "$target" "$source_hash" "$before_copy"
    rc=$?
  else
    _idem_atomic_copy "$source" "$target"
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    _idem_restore_managed_install_failure \
      "$snapshot" "$is_root_transaction" "$rc"
    return $?
  fi
  if [ "$track_managed" -eq 1 ]; then
    _idem_register_created_directories "$root" "$target" "$existing_parent"
    _idem_register_managed_file "$root" "$target"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      _idem_restore_managed_install_failure \
        "$snapshot" "$is_root_transaction" "$rc"
      return $?
    fi
  fi
  if [ "$is_root_transaction" -eq 1 ]; then
    _idem_mark_root_transaction_changed "$root"
  else
    _idem_add_managed_undo "$snapshot"
  fi
}

_idem_remove_managed_file() {
  local root="$1" target="$2" receipt_target="${3:-$2}"
  local manifest_target="${4:-$receipt_target}" snapshot=""
  local is_root_transaction=0 changed=0
  [ -e "$target" ] && changed=1
  local recorded_hash
  if ! _idem_read_manifest_hash "$root" "$manifest_target" recorded_hash; then
    printf '%s\n' \
      "error=hash-manifest-read-failed path=$root/$AUTOPROMPT_HASH_MANIFEST_NAME" >&2
    return 1
  fi
  [ -n "$recorded_hash" ] && changed=1
  _idem_receipt_owns "$receipt_target" && changed=1
  if _idem_root_transaction_matches "$root"; then
    _idem_snapshot_root_path "$target" || return 1
    is_root_transaction=1
  else
    snapshot="$(_idem_new_managed_snapshot "$root" "$target")" || return 1
  fi

  if { [ ! -e "$target" ] || rm -f -- "$target"; } &&
     _idem_remove_manifest_hash "$root" "$manifest_target"; then
    local -a kept=()
    local owned
    for owned in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
      _idem_paths_equal "$owned" "$receipt_target" || kept+=("$owned")
    done
    AUTOPROMPT_RECEIPT_FILES=("${kept[@]}")
    if [ "$is_root_transaction" -eq 1 ]; then
      [ "$changed" -eq 0 ] || _idem_mark_root_transaction_changed "$root"
    else
      _idem_add_managed_undo "$snapshot"
    fi
    return 0
  fi
  [ "$is_root_transaction" -eq 1 ] && return 1
  _idem_restore_managed_snapshot "$snapshot" || {
    _idem_add_managed_undo "$snapshot"
    return 2
  }
  return 1
}

_idem_relinquish_retired_codex_file() {
  local root="$1" file="$2" owned
  local -a kept=()
  _idem_remove_manifest_hash "$root" "$file" || return 1
  for owned in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
    _idem_paths_equal "$owned" "$file" || kept+=("$owned")
  done
  AUTOPROMPT_RECEIPT_FILES=("${kept[@]}")
  _idem_root_transaction_matches "$root" &&
    _idem_mark_root_transaction_changed "$root"
  return 0
}

_idem_reconcile_retired_codex_files() {
  local root="$1" targets_name="$2" file target current path
  local recorded_hash live_hash reason
  local -n current_targets_ref="$targets_name"
  local -a prior_files=("${AUTOPROMPT_RECEIPT_FILES[@]:-}")
  for file in "${prior_files[@]}"; do
    [ -n "$file" ] || continue
    _uninstall_provider_owns_path "$root" codex "$file" || continue
    current=0
    for target in "${current_targets_ref[@]}"; do
      if _idem_paths_equal "$target" "$file"; then current=1; break; fi
    done
    [ "$current" -eq 0 ] || continue

    path="$(_uninstall_filesystem_path "$file")" || return 94
    recorded_hash=""
    _idem_read_manifest_hash "$root" "$file" recorded_hash || return 94
    reason=""
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      reason=already-absent
    elif [ -L "$path" ] || [ ! -f "$path" ]; then
      reason=linked-or-unsafe
    elif [ -z "$recorded_hash" ]; then
      reason=unfingerprinted
    else
      live_hash="$(_idem_sha256 "$path")" || reason=hash-unreadable
      [ -n "$reason" ] || [ "$live_hash" = "$recorded_hash" ] || reason=hash-drift
    fi

    if [ -z "$reason" ] || [ "$reason" = already-absent ]; then
      _idem_remove_managed_file "$root" "$path" "$file" || {
        printf '%s\n' "client=codex error=retired-file-prune-failed path=$file" >&2
        return 94
      }
      printf '%s\n' "client=codex update-pruned=$file reason=prior-only"
      continue
    fi

    _idem_relinquish_retired_codex_file "$root" "$file" || return 94
    printf '%s\n' \
      "client=codex update-retained=$file reason=$reason ownership=relinquished"
  done
}

_idem_resolve_install_target() {
  local client="$1" variant="$2" landed_name="$3" format_name="$4"
  local rec resolve_code destpath
  local -n resolved_landed="$landed_name" resolved_format="$format_name"
  rec="$(resolve_destination "$client" "$variant")"; resolve_code=$?
  [ "$resolve_code" -eq 0 ] || return "$resolve_code"
  destpath="${rec#client=* dest=}"; destpath="${destpath% format=*}"
  resolved_format="${rec##* format=}"
  case "$destpath" in */) resolved_landed="${destpath}SKILL.md" ;; *) resolved_landed="$destpath" ;; esac
  if _idem_target_is_unowned_collision "$resolved_landed"; then
    printf '%s\n' \
      "client=$client error=unowned-skill-refused dest=$resolved_landed" >&2
    return 43
  fi
}

_idem_render_expected_hash() {
  local client="$1" fmt="$2" name="$3" description="$4" body="$5"
  local output_name="$6" stage render_code hash hash_code
  local -n expected_hash_ref="$output_name"
  stage="$(mktemp 2>/dev/null)" || {
    printf '%s\n' "client=$client error=idem-stage-failed" >&2
    return 42
  }
  format_skill "$fmt" "$name" "$description" "$body" > "$stage"
  render_code=$?
  if [ "$render_code" -ne 0 ]; then rm -f "$stage" 2>/dev/null; return "$render_code"; fi
  hash="$(_idem_sha256 "$stage")"; hash_code=$?
  rm -f "$stage" 2>/dev/null
  [ "$hash_code" -eq 0 ] || return "$hash_code"
  expected_hash_ref="$hash"
}

_idem_read_install_state() {
  local root="$1" client="$2" landed="$3" file_name="$4" live_name="$5"
  local recorded_name="$6" receipt_name="$7"
  local -n file_ref="$file_name" live_ref="$live_name"
  local -n recorded_ref="$recorded_name" receipt_ref="$receipt_name"
  if ! _idem_read_manifest_hash "$root" "$landed" recorded_ref; then
    printf '%s\n' "client=$client error=hash-manifest-read-failed path=$root/$AUTOPROMPT_HASH_MANIFEST_NAME" >&2
    return 40
  fi
  [ -f "$root/$AUTOPROMPT_RECEIPT_NAME" ] && receipt_ref=true
  if [ -f "$landed" ]; then
    file_ref=true
    live_ref="$(_idem_sha256 "$landed")" || return 42
  fi
}

_idem_repair_current_metadata() {
  local root="$1" client="$2" landed="$3" expected_hash="$4" journal_start="$5"
  if [ "$(_idem_read_manifest_hash "$root" "$landed")" = "$expected_hash" ] &&
     _idem_receipt_owns "$landed" &&
     _idem_receipt_owns "$root/$AUTOPROMPT_HASH_MANIFEST_NAME"; then
    printf '%s\n' "already-installed v$expected_hash"
    return 0
  fi
  local snapshot metadata_code
  if _idem_root_transaction_matches "$root"; then
    _idem_register_managed_file "$root" "$landed"; metadata_code=$?
    [ "$metadata_code" -eq 0 ] || return "$metadata_code"
    _idem_mark_root_transaction_changed "$root"
  else
    snapshot="$(_idem_new_managed_snapshot "$root" "$landed")" || return 39
    _idem_register_managed_file "$root" "$landed"; metadata_code=$?
    if [ "$metadata_code" -ne 0 ]; then
      _idem_restore_managed_snapshot "$snapshot" || {
        _idem_add_managed_undo "$snapshot"
        return 44
      }
      return "$metadata_code"
    fi
    _idem_add_managed_undo "$snapshot"
  fi
  if ! _idem_root_transaction_matches "$root" &&
     ! _idem_complete_managed_changes "$journal_start"; then
    printf '%s\n' "client=$client error=idem-cleanup-failed state=retained" >&2
    return 45
  fi
  printf '%s\n' "client=$client idem=repair dest=$landed reason=missing-metadata hash=$expected_hash"
}

_idem_select_outcome() {
  local file_exists="$1" receipt_present="$2" live_hash="$3" recorded_hash="$4"
  local outcome_name="$5" reason_name="$6"
  local -n selected_outcome="$outcome_name" selected_reason="$reason_name"
  if [ "$file_exists" = false ]; then
    selected_outcome=repair; selected_reason=missing-file
  elif [ "$receipt_present" = true ] && [ -n "$recorded_hash" ] &&
       [ "$live_hash" = "$recorded_hash" ]; then
    selected_outcome=update
  elif [ -n "$recorded_hash" ] && [ "$live_hash" = "$recorded_hash" ]; then
    selected_outcome=repair; selected_reason=missing-receipt
  elif [ -z "$recorded_hash" ]; then
    selected_outcome=repair; selected_reason=no-fingerprint
  else
    selected_outcome=repair; selected_reason=hash-drift
  fi
}

_idem_recopy_payload() {
  local root="$1" client="$2" name="$3" description="$4" body="$5"
  local variant="$6" landed="$7" expected_hash="$8" snapshot="" copy_code
  local is_root_transaction=0
  if _idem_root_transaction_matches "$root"; then
    _idem_snapshot_root_parent_directories "$root" "$landed" || return 39
    _idem_snapshot_root_path "$landed" || return 39
    is_root_transaction=1
  else
    snapshot="$(_idem_new_managed_snapshot "$root" "$landed")" || return 39
  fi
  install_copy "$client" "$name" "$description" "$body" "$variant" "$root" >/dev/null
  copy_code=$?
  if [ "$copy_code" -ne 0 ]; then
    _idem_restore_managed_install_failure "$snapshot" "$is_root_transaction" "$copy_code"
    return $?
  fi
  if ! _idem_write_manifest "$root" "$landed" "$expected_hash"; then
    _idem_restore_managed_install_failure "$snapshot" "$is_root_transaction" 40
    return $?
  fi
  _idem_register_manifest "$root"
  [ "$is_root_transaction" -eq 1 ] || _idem_add_managed_undo "$snapshot"
}

_idem_publish_outcome() {
  local root="$1" client="$2" landed="$3" expected_hash="$4" recorded_hash="$5"
  local outcome="$6" reason="$7" journal_start="$8"
  if ! _idem_root_transaction_matches "$root" &&
     ! _idem_complete_managed_changes "$journal_start"; then
    printf '%s\n' "client=$client error=idem-cleanup-failed state=retained" >&2
    return 45
  fi
  if [ "$outcome" = update ]; then
    printf '%s\n' "client=$client idem=update dest=$landed oldhash=$recorded_hash newhash=$expected_hash"
  else
    printf '%s\n' "client=$client idem=repair dest=$landed reason=$reason hash=$expected_hash"
  fi
}

install_idempotent() {
  local root="$1" client="$2" name="$3" description="$4" body="$5" variant="${6:-}"
  local journal_start="${#AUTOPROMPT_MANAGED_UNDO_JOURNAL[@]}"
  if [ -z "$root" ]; then
    printf '%s\n' "error=idem-no-config-root" >&2
    return 41
  fi
  local landed fmt expected_hash recorded_hash="" live_hash=""
  local file_exists=false receipt_present=false outcome reason=""
  _idem_resolve_install_target "$client" "$variant" landed fmt || return $?
  _idem_render_expected_hash "$client" "$fmt" "$name" "$description" \
    "$body" expected_hash || return $?
  _idem_read_install_state "$root" "$client" "$landed" file_exists live_hash \
    recorded_hash receipt_present || return $?
  if [ "$file_exists" = true ] && [ "$live_hash" = "$expected_hash" ]; then
    _idem_repair_current_metadata "$root" "$client" "$landed" \
      "$expected_hash" "$journal_start"
    return $?
  fi
  _idem_select_outcome "$file_exists" "$receipt_present" "$live_hash" \
    "$recorded_hash" outcome reason
  _idem_recopy_payload "$root" "$client" "$name" "$description" "$body" \
    "$variant" "$landed" "$expected_hash" || return $?
  _idem_publish_outcome "$root" "$client" "$landed" "$expected_hash" \
    "$recorded_hash" "$outcome" "$reason" "$journal_start"
}
# --- F-LIB-IDEM (end) ---

# --- F-LIB-CONFIGEDIT (begin) ---
# configedit_codex_agents performs the SURGICAL Codex [agents] config bump into a
# config.toml the installer does NOT own. It sets/raises max_depth + max_threads to
# 10 across the four mandated cases - keys-absent-under-existing-[agents] (ADD),
# present-and-lower (RAISE), present-and-higher (LEAVE, never lower), and
# [agents]-absent (CREATE) - preserving every other key/section/comment/formatting
# byte-for-byte except the minimal bytes of the two target keys. Before any write it
# makes a WHOLE-FILE backup (the revert source) and records, per CHANGED key, the
# prior value (or the absent-sentinel) via the EXISTING receipt arrays - it does NOT
# reimplement receipt logic. A re-run is a strict NO-OP (zero writes, zero backups,
# zero edits). The surgical edit is hand-rolled line work, NOT a TOML library:
# tomllib has no writer and a full re-emit would reorder/destroy siblings + comments.
#
# Signature: configedit_codex_agents <config-file> [target_depth] [target_threads]
#   <config-file>  absolute path to the file to edit (active profile config; may be
#                  missing). REQUIRED - empty => error 50.
#   target_depth   default 10; target_threads default 10.
#
# Channel discipline (mirrors the lib): RECORD -> stdout, errors -> stderr, the
# integer return is the VERDICT. Stdout RECORD grammar (single parseable line):
#   file=<path> configedit=<noop|applied> depth=<old->new|kept> threads=<...> \
#       table=<existing|created|added-to> backup=<path|none>
#
# Return-code band CONFIGEDIT-OWNED 50-59 (disjoint from every prior band):
#   0   ok (added / raised / created / noop / a mix)
#   50  no-config-file-arg (empty <config-file>)
#   51  config-file-unreadable (path exists but is not a regular file, or read fails)
#   52  malformed-toml-cannot-locate-agents-safely -> NO write, file untouched
#       (duplicate [agents], array-of-tables [[agents]], or a top-level dotted
#       agents.* / inline agents = {...} key - we refuse loudly rather than guess
#       which definition to edit and risk clobbering; coding-style "no silent fallback")
#   53  backup-write-failed (the whole-file backup copy could not be created) -> NO edit
#   54  edit-write-failed (the atomic .tmp write or rename of the edited file failed)
AUTOPROMPT_CONFIGEDIT_AGENTS_DEPTH=10
AUTOPROMPT_CONFIGEDIT_AGENTS_THREADS=10
AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX=".autoprompt.bak"

# The whole-file backup path of the LAST applied edit (the .ps1 analog is
# $script:AutopromptConfigEditLastBackup). The orchestrator passes this as
# write_receipt's 3rd arg; "none" when no backup was made (case-4 on a missing file).
AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="none"

# Guard-init the EDITS accumulator (the .ps1 twin is $script:AutopromptReceiptEdits),
# mirroring COPY's FILES guard so a set -u consumer never trips and a re-source keeps
# accumulated entries. CONFIGEDIT appends packed FILE<US>KEY<US>NEWVAL<US>PRIORVAL.
[ -n "${AUTOPROMPT_RECEIPT_EDITS+set}" ] || declare -a AUTOPROMPT_RECEIPT_EDITS=()

# _configedit_first_int <token>: a complete non-negative integer, optionally
# followed by whitespace and an inline comment. Anything else needs replacement.
_configedit_first_int() {
  local token="$1" digits remainder
  token="${token#"${token%%[![:space:]]*}"}"
  digits="${token%%[!0-9]*}"
  [ -n "$digits" ] || return 0
  remainder="${token#"$digits"}"
  remainder="${remainder#"${remainder%%[![:space:]]*}"}"
  case "$remainder" in ''|'#'*) printf '%s' "$digits" ;; esac
}

# _configedit_backup <file>: cp -p the whole file to <file><SUFFIX>; echo the backup
# path on success; non-zero rc on failure (and clean any partial backup).
_configedit_backup() {
  local file="$1"
  local backup="$file$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX"
  if cp -p -- "$file" "$backup" 2>/dev/null; then
    printf '%s' "$backup"
    return 0
  fi
  rm -f -- "$backup" 2>/dev/null
  return 1
}

# _configedit_atomic_write <file> <content>: write <content> to <file>.tmp then
# mv -f onto <file>. A tmp-write or rename failure cleans the .tmp and returns rc 1.
# <content> is written EXACTLY (printf '%s'); the caller already appended the correct
# trailing newline flag, so no extra newline is added here.
_configedit_atomic_write() {
  local file="$1" content="$2"
  local tmp="$file.tmp"
  if ! printf '%s' "$content" > "$tmp" 2>/dev/null; then
    rm -f -- "$tmp" 2>/dev/null
    return 1
  fi
  if ! mv -f -- "$tmp" "$file" 2>/dev/null; then
    rm -f -- "$tmp" 2>/dev/null
    return 1
  fi
  return 0
}

declare -a CONFIGEDIT_LINES=()
declare -a CONFIGEDIT_OUTPUT_LINES=()
CONFIGEDIT_FILE_EXISTS=0
CONFIGEDIT_NEWLINE=$'\n'
CONFIGEDIT_TRAILING_NEWLINES=0
CONFIGEDIT_CURRENT_TABLE=""
CONFIGEDIT_AGENTS_SEEN=0
CONFIGEDIT_INSERT_AFTER=-1
CONFIGEDIT_DEPTH_INDEX=-1
CONFIGEDIT_THREADS_INDEX=-1
CONFIGEDIT_DEPTH_PRIOR=""
CONFIGEDIT_THREADS_PRIOR=""
CONFIGEDIT_DEPTH_INDENT=""
CONFIGEDIT_THREADS_INDENT=""
CONFIGEDIT_DEPTH_CHANGE=0
CONFIGEDIT_THREADS_CHANGE=0
CONFIGEDIT_DEPTH_OLD="absent"
CONFIGEDIT_THREADS_OLD="absent"
CONFIGEDIT_TABLE_STATE="absent"

_configedit_validate_input() {
  local file="$1"
  if [ -z "$file" ]; then
    printf '%s\n' "error=no-config-file-arg" >&2
    return 50
  fi
  if [ -e "$file" ] && [ ! -f "$file" ]; then
    printf '%s\n' "error=config-file-unreadable path=$file" >&2
    return 51
  fi
}

_configedit_read_document() {
  local file="$1" raw="" body line uses_crlf=0
  CONFIGEDIT_LINES=()
  CONFIGEDIT_FILE_EXISTS=0
  CONFIGEDIT_NEWLINE=$'\n'
  CONFIGEDIT_TRAILING_NEWLINES=0
  [ -f "$file" ] || return 0
  CONFIGEDIT_FILE_EXISTS=1
  IFS= read -rd '' raw < <(cat -- "$file" 2>/dev/null) || true
  if [ -s "$file" ] && [ -z "$raw" ]; then
    printf '%s\n' "error=config-file-unreadable path=$file" >&2
    return 51
  fi
  case "$raw" in *$'\r\n'*) uses_crlf=1; CONFIGEDIT_NEWLINE=$'\r\n' ;; esac
  body="$raw"
  while [ -n "$body" ] && [ "${body: -1}" = $'\n' ]; do
    body="${body%$'\n'}"
    if [ "$uses_crlf" -eq 1 ] && [ -n "$body" ] && [ "${body: -1}" = $'\r' ]; then
      body="${body%$'\r'}"
    fi
    CONFIGEDIT_TRAILING_NEWLINES=$((CONFIGEDIT_TRAILING_NEWLINES + 1))
  done
  [ -n "$body" ] || return 0
  while IFS= read -r line; do
    [ "$uses_crlf" -eq 0 ] || line="${line%$'\r'}"
    CONFIGEDIT_LINES+=("$line")
  done <<< "$body"
}

_configedit_structure_error() {
  printf '%s\n' \
    "error=malformed-toml-cannot-locate-agents-safely path=$1 detail=$2" >&2
  return 52
}

_configedit_scan_table_line() {
  local file="$1" stripped="$2" index="$3" name
  case "$stripped" in
    '[['*']]')
      name="${stripped#\[\[}"; name="${name%\]\]}"
      name="${name#"${name%%[![:space:]]*}"}"
      name="${name%"${name##*[![:space:]]}"}"
      [ "$name" != agents ] || {
        _configedit_structure_error "$file" array-of-tables
        return 52
      }
      CONFIGEDIT_CURRENT_TABLE="$name"
      return 0
      ;;
    '['*']')
      name="${stripped#\[}"; name="${name%\]}"
      name="${name#"${name%%[![:space:]]*}"}"
      name="${name%"${name##*[![:space:]]}"}"
      if [ "$name" = agents ]; then
        [ "$CONFIGEDIT_AGENTS_SEEN" -eq 0 ] || {
          _configedit_structure_error "$file" duplicate-header
          return 52
        }
        CONFIGEDIT_AGENTS_SEEN=1
        CONFIGEDIT_INSERT_AFTER="$index"
      fi
      CONFIGEDIT_CURRENT_TABLE="$name"
      return 0
      ;;
  esac
  return 1
}

_configedit_scan_key_line() {
  local file="$1" stripped="$2" index="$3" key value indent
  case "$stripped" in *'='*) ;; *) return 0 ;; esac
  key="${stripped%%=*}"; key="${key%"${key##*[![:space:]]}"}"
  value="${stripped#*=}"; value="${value#"${value%%[![:space:]]*}"}"
  case "$key" in
    agents.*|agents)
      [ -n "$CONFIGEDIT_CURRENT_TABLE" ] || {
        _configedit_structure_error "$file" top-level-agents-key
        return 52
      }
      ;;
  esac
  [ "$CONFIGEDIT_CURRENT_TABLE" = agents ] || return 0
  CONFIGEDIT_INSERT_AFTER="$index"
  indent="${CONFIGEDIT_LINES[index]%%[![:space:]]*}"
  if [ "$key" = max_depth ]; then
    CONFIGEDIT_DEPTH_INDEX="$index"
    CONFIGEDIT_DEPTH_PRIOR="$value"
    CONFIGEDIT_DEPTH_INDENT="$indent"
  elif [ "$key" = max_threads ]; then
    CONFIGEDIT_THREADS_INDEX="$index"
    CONFIGEDIT_THREADS_PRIOR="$value"
    CONFIGEDIT_THREADS_INDENT="$indent"
  fi
}

_configedit_scan_document() {
  local file="$1" index stripped table_code
  CONFIGEDIT_CURRENT_TABLE=""; CONFIGEDIT_AGENTS_SEEN=0; CONFIGEDIT_INSERT_AFTER=-1
  CONFIGEDIT_DEPTH_INDEX=-1; CONFIGEDIT_THREADS_INDEX=-1
  CONFIGEDIT_DEPTH_PRIOR=""; CONFIGEDIT_THREADS_PRIOR=""
  CONFIGEDIT_DEPTH_INDENT=""; CONFIGEDIT_THREADS_INDENT=""
  for ((index = 0; index < ${#CONFIGEDIT_LINES[@]}; index++)); do
    stripped="${CONFIGEDIT_LINES[index]#"${CONFIGEDIT_LINES[index]%%[![:space:]]*}"}"
    stripped="${stripped%"${stripped##*[![:space:]]}"}"
    case "$stripped" in ''|'#'*) continue ;; esac
    _configedit_scan_table_line "$file" "$stripped" "$index"
    table_code=$?
    [ "$table_code" -ne 52 ] || return 52
    [ "$table_code" -ne 0 ] || continue
    _configedit_scan_key_line "$file" "$stripped" "$index" || return $?
  done
}

_configedit_plan_changes() {
  local target_depth="$1" target_threads="$2" parsed
  CONFIGEDIT_DEPTH_CHANGE=0; CONFIGEDIT_THREADS_CHANGE=0
  CONFIGEDIT_DEPTH_OLD=absent; CONFIGEDIT_THREADS_OLD=absent
  CONFIGEDIT_TABLE_STATE=absent
  if [ "$CONFIGEDIT_DEPTH_INDEX" -ge 0 ]; then
    parsed="$(_configedit_first_int "$CONFIGEDIT_DEPTH_PRIOR")"
    CONFIGEDIT_DEPTH_OLD="${parsed:-$CONFIGEDIT_DEPTH_PRIOR}"
    if [ -z "$parsed" ] || [ "$parsed" -lt "$target_depth" ]; then
      CONFIGEDIT_DEPTH_CHANGE=1
    fi
  else
    CONFIGEDIT_DEPTH_CHANGE=1
  fi
  if [ "$CONFIGEDIT_THREADS_INDEX" -ge 0 ]; then
    parsed="$(_configedit_first_int "$CONFIGEDIT_THREADS_PRIOR")"
    CONFIGEDIT_THREADS_OLD="${parsed:-$CONFIGEDIT_THREADS_PRIOR}"
    if [ -z "$parsed" ] || [ "$parsed" -lt "$target_threads" ]; then
      CONFIGEDIT_THREADS_CHANGE=1
    fi
  else
    CONFIGEDIT_THREADS_CHANGE=1
  fi
  [ "$CONFIGEDIT_AGENTS_SEEN" -eq 0 ] || CONFIGEDIT_TABLE_STATE=existing
}

_configedit_build_existing_table() {
  local target_depth="$1" target_threads="$2" index
  for ((index = 0; index < ${#CONFIGEDIT_LINES[@]}; index++)); do
    if [ "$index" -eq "$CONFIGEDIT_DEPTH_INDEX" ] &&
       [ "$CONFIGEDIT_DEPTH_CHANGE" -eq 1 ]; then
      CONFIGEDIT_OUTPUT_LINES+=("${CONFIGEDIT_DEPTH_INDENT}max_depth = $target_depth")
    elif [ "$index" -eq "$CONFIGEDIT_THREADS_INDEX" ] &&
         [ "$CONFIGEDIT_THREADS_CHANGE" -eq 1 ]; then
      CONFIGEDIT_OUTPUT_LINES+=("${CONFIGEDIT_THREADS_INDENT}max_threads = $target_threads")
    else
      CONFIGEDIT_OUTPUT_LINES+=("${CONFIGEDIT_LINES[index]}")
    fi
    [ "$index" -eq "$CONFIGEDIT_INSERT_AFTER" ] || continue
    if [ "$CONFIGEDIT_DEPTH_INDEX" -lt 0 ] && [ "$CONFIGEDIT_DEPTH_CHANGE" -eq 1 ]; then
      CONFIGEDIT_OUTPUT_LINES+=("max_depth = $target_depth")
    fi
    if [ "$CONFIGEDIT_THREADS_INDEX" -lt 0 ] && [ "$CONFIGEDIT_THREADS_CHANGE" -eq 1 ]; then
      CONFIGEDIT_OUTPUT_LINES+=("max_threads = $target_threads")
    fi
  done
  CONFIGEDIT_TABLE_STATE=added-to
  if [ "$CONFIGEDIT_DEPTH_INDEX" -ge 0 ] && [ "$CONFIGEDIT_THREADS_INDEX" -ge 0 ]; then
    CONFIGEDIT_TABLE_STATE=existing
  fi
}

_configedit_build_created_table() {
  local target_depth="$1" target_threads="$2" line
  for line in "${CONFIGEDIT_LINES[@]}"; do CONFIGEDIT_OUTPUT_LINES+=("$line"); done
  if [ "${#CONFIGEDIT_LINES[@]}" -gt 0 ] &&
     [ -n "${CONFIGEDIT_LINES[${#CONFIGEDIT_LINES[@]}-1]}" ]; then
    CONFIGEDIT_OUTPUT_LINES+=("")
  fi
  CONFIGEDIT_OUTPUT_LINES+=(
    "[agents]" "max_depth = $target_depth" "max_threads = $target_threads"
  )
  CONFIGEDIT_TABLE_STATE=created
}

_configedit_build_document() {
  local target_depth="$1" target_threads="$2"
  CONFIGEDIT_OUTPUT_LINES=()
  if [ "$CONFIGEDIT_AGENTS_SEEN" -eq 1 ]; then
    _configedit_build_existing_table "$target_depth" "$target_threads"
  else
    _configedit_build_created_table "$target_depth" "$target_threads"
  fi
}

_configedit_serialize_document() {
  local output_name="$1" serialized="" first=1 line count index
  local -n serialized_content_ref="$output_name"
  for line in "${CONFIGEDIT_OUTPUT_LINES[@]}"; do
    if [ "$first" -eq 1 ]; then serialized="$line"; first=0
    else serialized="$serialized$CONFIGEDIT_NEWLINE$line"
    fi
  done
  count="$CONFIGEDIT_TRAILING_NEWLINES"
  [ "$CONFIGEDIT_FILE_EXISTS" -eq 1 ] || count=1
  for ((index = 0; index < count; index++)); do
    serialized="$serialized$CONFIGEDIT_NEWLINE"
  done
  serialized_content_ref="$serialized"
}

_configedit_save_document() {
  local file="$1" content="$2" output_name="$3"
  local root="${AUTOPROMPT_ROOT_TRANSACTION_ROOT:-}" backup_path=none
  local -n saved_backup_ref="$output_name"
  if [ -n "$root" ] && _idem_root_transaction_matches "$root"; then
    _idem_snapshot_root_path "$file" || return 53
    _idem_snapshot_root_path "$file$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" || return 53
  fi
  if [ "$CONFIGEDIT_FILE_EXISTS" -eq 1 ] && [ -s "$file" ]; then
    backup_path="$(_configedit_backup "$file")" || {
      printf '%s\n' "error=backup-write-failed path=$file$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" >&2
      return 53
    }
  fi
  if ! _configedit_atomic_write "$file" "$content"; then
    printf '%s\n' "error=edit-write-failed path=$file" >&2
    return 54
  fi
  saved_backup_ref="$backup_path"
  [ -z "$root" ] || _idem_mark_root_transaction_changed "$root"
}

_configedit_record_receipt_edits() {
  local file="$1" target_depth="$2" target_threads="$3" separator=$'\037' prior
  if [ "$CONFIGEDIT_DEPTH_CHANGE" -eq 1 ]; then
    prior="$AUTOPROMPT_RECEIPT_ABSENT"
    [ "$CONFIGEDIT_DEPTH_INDEX" -lt 0 ] || prior="$CONFIGEDIT_DEPTH_OLD"
    AUTOPROMPT_RECEIPT_EDITS+=(
      "$file$separator""agents.max_depth$separator$target_depth$separator$prior"
    )
  fi
  if [ "$CONFIGEDIT_THREADS_CHANGE" -eq 1 ]; then
    prior="$AUTOPROMPT_RECEIPT_ABSENT"
    [ "$CONFIGEDIT_THREADS_INDEX" -lt 0 ] || prior="$CONFIGEDIT_THREADS_OLD"
    AUTOPROMPT_RECEIPT_EDITS+=(
      "$file$separator""agents.max_threads$separator$target_threads$separator$prior"
    )
  fi
}

_configedit_publish_record() {
  local file="$1" target_depth="$2" target_threads="$3" backup="$4"
  local depth_record=kept threads_record=kept
  [ "$CONFIGEDIT_DEPTH_CHANGE" -eq 0 ] ||
    depth_record="$CONFIGEDIT_DEPTH_OLD->$target_depth"
  [ "$CONFIGEDIT_THREADS_CHANGE" -eq 0 ] ||
    threads_record="$CONFIGEDIT_THREADS_OLD->$target_threads"
  printf '%s\n' "file=$file configedit=applied depth=$depth_record threads=$threads_record table=$CONFIGEDIT_TABLE_STATE backup=$backup"
}

configedit_codex_agents() {
  local file="$1" target_depth="${2:-$AUTOPROMPT_CONFIGEDIT_AGENTS_DEPTH}"
  local target_threads="${3:-$AUTOPROMPT_CONFIGEDIT_AGENTS_THREADS}"
  local content backup
  _configedit_validate_input "$file" || return $?
  _configedit_read_document "$file" || return $?
  _configedit_scan_document "$file" || return $?
  _configedit_plan_changes "$target_depth" "$target_threads"
  if [ "$CONFIGEDIT_DEPTH_CHANGE" -eq 0 ] &&
     [ "$CONFIGEDIT_THREADS_CHANGE" -eq 0 ]; then
    printf '%s\n' "file=$file configedit=noop depth=kept threads=kept table=$CONFIGEDIT_TABLE_STATE backup=none"
    return 0
  fi
  _configedit_build_document "$target_depth" "$target_threads"
  _configedit_serialize_document content
  _configedit_save_document "$file" "$content" backup || return $?
  _configedit_record_receipt_edits "$file" "$target_depth" "$target_threads"
  AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="$backup"
  _configedit_publish_record "$file" "$target_depth" "$target_threads" "$backup"
}
# --- F-LIB-CONFIGEDIT (end) ---

# --- F-LIB-VERIFY (begin) ---
# verify_install confirms a LANDED skill is genuinely usable by a client: it
# PASSES only when the resolved load-path file (1) EXISTS, (2) PARSES in the
# client's native format, AND (3) sits AT that load path. Any miss returns a
# DISTINCT named reason emitted by THIS function: absent(60) / unparseable(61) /
# wrong-path(62), plus parser-unavailable(65) and delegated 2/3 from resolve. It
# does PATH MATH + a single resolved-parent-dir listing + a REAL parser invocation
# only - never a filesystem search/guess, no detect_client (binary presence is
# PRECHECK's job), no re-render (bytes-on-disk parse-validity, not expected-content
# match, which is IDEM's job).
#
# Channel discipline (mirrors detect/resolve/precheck): the PASS RECORD goes to
# stdout, every FAIL record goes to stderr (stdout stays empty on FAIL), and the
# integer return is the VERDICT. Return-code band 60-69 is VERIFY-OWNED, disjoint
# from DETECT/RESOLVE/FORMAT/PRECHECK/RECEIPT/COPY/IDEM/CONFIGEDIT.
#   0   PASS  (client=<n> verify=pass dest=<load-path> format=<tok> on stdout)
#   60  FAIL reason=absent          (nothing at load path AND nothing else in parent)
#   61  FAIL reason=unparseable     (load-path file present but bytes do not parse)
#   62  FAIL reason=wrong-path      (load-path file missing but a file IS in parent)
#   63  FAIL reason=codex-description-too-long (md-codex landed description > 1024
#         chars - Codex's hard cap; it silently DROPS the skill, so we fail loud)
#   65  FAIL reason=parser-unavailable (python yaml/tomllib absent - loud, never PASS)
#   2/3 delegated VERBATIM from resolve (unknown-client/no-such-variant; no-home)
# (code 64 format-deferred is RETIRED: every token now has a real emitter+parser.)
#
# Codex enforces a 1024-character maximum on a skill's frontmatter description
# (proven live: "invalid description: exceeds maximum length of 1024 characters").
# An over-long description makes Codex DROP the skill WITHOUT loading it, so for
# the md-codex format verify must fail loud rather than report a PASS on a file
# Codex will never honor.
AUTOPROMPT_CODEX_DESCRIPTION_MAX=1024

# _verify_parse_yaml_frontmatter <file> <required-key>: split the leading
# ---...--- frontmatter and run it through REAL python+yaml. Returns 0 (loads to
# a mapping carrying <required-key>), 61 (parse error / not a mapping / key
# absent), or 65 (no python+yaml tool). Probes the parser first so a missing tool
# is a loud distinct code, never a silent FAIL.
_verify_parse_yaml_frontmatter() {
  local file="$1" required="$2"
  if ! python -c "import yaml" >/dev/null 2>&1; then
    return 65
  fi
  python - "$file" "$required" <<'PY' >/dev/null 2>&1
import sys, yaml
text = open(sys.argv[1], encoding="utf-8").read()
parts = text.split("---")
if len(parts) < 3:
    sys.exit(1)
fm = yaml.safe_load(parts[1])
if not isinstance(fm, dict) or sys.argv[2] not in fm:
    sys.exit(1)
sys.exit(0)
PY
  [ $? -eq 0 ] && return 0
  return 61
}

# _verify_codex_description_len <file>: echo the CHARACTER length of the landed
# md-codex frontmatter `description` (the value Codex measures against its 1024
# cap), parsing the YAML so an escaped/quoted scalar is counted as Codex sees it.
# Returns 0 (length printed to stdout), 61 (no parseable description), or 65 (no
# python+yaml). Reuses the same parser-probe discipline as the parse helpers.
_verify_codex_description_len() {
  local file="$1"
  if ! python -c "import yaml" >/dev/null 2>&1; then
    return 65
  fi
  local out
  out="$(python - "$file" <<'PY' 2>/dev/null
import sys, yaml
text = open(sys.argv[1], encoding="utf-8").read()
parts = text.split("---")
if len(parts) < 3:
    sys.exit(1)
fm = yaml.safe_load(parts[1])
if not isinstance(fm, dict) or "description" not in fm:
    sys.exit(1)
print(len(str(fm["description"])))
sys.exit(0)
PY
)"
  [ -n "$out" ] || return 61
  printf '%s' "$out"
  return 0
}
_verify_parse_toml() {
  local file="$1"
  if ! python -c "import tomllib" >/dev/null 2>&1; then
    return 65
  fi
  python - "$file" <<'PY' >/dev/null 2>&1
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
if "prompt" not in d:
    sys.exit(1)
sys.exit(0)
PY
  [ $? -eq 0 ] && return 0
  return 61
}

# _verify_parse_roomodes <file>: parse the WHOLE file via REAL python+yaml and
# require a customModes list carrying the autoprompt mode (slug=autoprompt) with
# a non-empty customInstructions. Returns 0 / 61 (parse error / shape wrong / mode
# absent) / 65 (no python+yaml tool).
_verify_parse_roomodes() {
  local file="$1"
  if ! python -c "import yaml" >/dev/null 2>&1; then
    return 65
  fi
  python - "$file" <<'PY' >/dev/null 2>&1
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1], encoding="utf-8").read())
if not isinstance(doc, dict):
    sys.exit(1)
modes = doc.get("customModes")
if not isinstance(modes, list):
    sys.exit(1)
mode = next((m for m in modes if isinstance(m, dict) and m.get("slug") == "autoprompt"), None)
if mode is None or not mode.get("customInstructions"):
    sys.exit(1)
sys.exit(0)
PY
  [ $? -eq 0 ] && return 0
  return 61
}

# _verify_parse_goose_recipe <file>: parse the WHOLE file via REAL python+yaml and
# require a mapping with a non-empty `instructions` OR `prompt` (Goose's
# validate_prompt_or_instructions rule). Returns 0 / 61 / 65, same discipline.
_verify_parse_goose_recipe() {
  local file="$1"
  if ! python -c "import yaml" >/dev/null 2>&1; then
    return 65
  fi
  python - "$file" <<'PY' >/dev/null 2>&1
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1], encoding="utf-8").read())
if not isinstance(doc, dict):
    sys.exit(1)
if not (doc.get("instructions") or doc.get("prompt")):
    sys.exit(1)
sys.exit(0)
PY
  [ $? -eq 0 ] && return 0
  return 61
}

_verify_resolve_target() {
  local client="$1" variant="$2" landed_name="$3" format_name="$4"
  local rec resolve_code destpath
  local -n verify_landed="$landed_name" verify_format="$format_name"
  rec="$(resolve_destination "$client" "$variant")"; resolve_code=$?
  [ "$resolve_code" -eq 0 ] || return "$resolve_code"
  destpath="${rec#client=* dest=}"; destpath="${destpath% format=*}"
  verify_format="${rec##* format=}"
  case "$destpath" in */) verify_landed="${destpath}SKILL.md" ;; *) verify_landed="$destpath" ;; esac
}

_verify_missing_target() {
  local client="$1" landed="$2" parent="${2%/*}" had_nullglob found="" path
  case "$(shopt nullglob)" in *on) had_nullglob=1 ;; *) had_nullglob=0 ;; esac
  shopt -s nullglob
  for path in "$parent"/* "$parent"/.[!.]*; do
    if [ -f "$path" ]; then found="$path"; break; fi
  done
  [ "$had_nullglob" -eq 0 ] && shopt -u nullglob
  if [ -n "$found" ]; then
    printf '%s\n' "client=$client verify=fail reason=wrong-path expected=$landed found=$found error=not-at-load-path" >&2
    return 62
  fi
  printf '%s\n' "client=$client verify=fail reason=absent dest=$landed error=file-missing" >&2
  return 60
}

_verify_landed_format() {
  local client="$1" landed="$2" fmt="$3" parse_code
  case "$fmt" in
    mdc) _verify_parse_yaml_frontmatter "$landed" description; parse_code=$? ;;
    gemini-toml) _verify_parse_toml "$landed"; parse_code=$? ;;
    roomodes) _verify_parse_roomodes "$landed"; parse_code=$? ;;
    goose-recipe) _verify_parse_goose_recipe "$landed"; parse_code=$? ;;
    *) _verify_parse_yaml_frontmatter "$landed" name; parse_code=$? ;;
  esac
  if [ "$parse_code" -eq 65 ]; then
    printf '%s\n' "client=$client verify=fail reason=parser-unavailable format=$fmt error=no-parser-tool" >&2
    printf 'Autoprompt verify (%s): need python with yaml/tomllib to validate the %s format. Install python + PyYAML (and tomllib via python>=3.11) and re-run.\n' "$client" "$fmt" >&2
    return 65
  fi
  if [ "$parse_code" -ne 0 ]; then
    printf '%s\n' "client=$client verify=fail reason=unparseable dest=$landed format=$fmt error=parse-failed" >&2
    return 61
  fi
}

_verify_codex_description() {
  local client="$1" landed="$2" length code
  length="$(_verify_codex_description_len "$landed")"; code=$?
  if [ "$code" -eq 65 ]; then
    printf '%s\n' "client=$client verify=fail reason=parser-unavailable format=md-codex error=no-parser-tool" >&2
    printf 'Autoprompt verify (%s): need python with yaml to measure the codex description. Install python + PyYAML and re-run.\n' "$client" >&2
    return 65
  fi
  if [ "$code" -ne 0 ]; then
    printf '%s\n' "client=$client verify=fail reason=unparseable dest=$landed format=md-codex error=parse-failed" >&2
    return 61
  fi
  [ "$length" -le "$AUTOPROMPT_CODEX_DESCRIPTION_MAX" ] && return 0
  printf '%s\n' "client=$client verify=fail reason=codex-description-too-long len=$length max=$AUTOPROMPT_CODEX_DESCRIPTION_MAX dest=$landed error=description-exceeds-codex-cap" >&2
  printf 'Autoprompt verify (%s): the codex SKILL.md description is %s chars, over Codex'\''s %s cap - Codex will silently drop the skill. Shorten the description to %s chars or fewer and re-run.\n' "$client" "$length" "$AUTOPROMPT_CODEX_DESCRIPTION_MAX" "$AUTOPROMPT_CODEX_DESCRIPTION_MAX" >&2
  return 63
}

verify_install() {
  local client="$1" variant="${2:-}" landed fmt
  _verify_resolve_target "$client" "$variant" landed fmt || return $?
  if [ ! -f "$landed" ]; then
    _verify_missing_target "$client" "$landed"
    return $?
  fi
  _verify_landed_format "$client" "$landed" "$fmt" || return $?
  if [ "$fmt" = md-codex ]; then
    _verify_codex_description "$client" "$landed" || return $?
  fi
  printf '%s\n' "client=$client verify=pass dest=$landed format=$fmt"
}
# --- F-LIB-VERIFY (end) ---

# --- F-LIB-UNINSTALL (begin) ---
# uninstall_client + uninstall_repair reverse an install to ZERO residue and repair
# a corrupted install back to the RECORDED bytes. They read the receipt that
# write_receipt produced (the single source of truth) and never re-resolve/re-detect.
#
# uninstall_client <config-root> <client>: removes ONLY receipt files[], restores
# every configEdits[] file BYTE-IDENTICAL to pre-install (PRIMARY: whole-file
# <file>.autoprompt.bak restore - byte-exact by construction; FALLBACK: surgical
# priorValue undo when no .bak, which is the create-from-empty/absent case), removes
# created-and-now-empty dirs walking UPWARD with hard stops (never config-root/HOME/
# XDG/drive-root or a non-empty/pre-existing dir), and deletes the receipt LAST.
#
# uninstall_repair <config-root> <client> <name> <description> <body> [variant]:
# GATES on the recorded manifest hash - renders the caller payload, hashes it,
# compares to the recorded hash BEFORE any write; on mismatch REFUSES (76, file
# byte-unchanged); on pass re-mints via install_idempotent then POST-WRITE verifies
# live==recorded (73 otherwise). Reports each restore from its OWN post-write hash.
#
# Channel discipline (mirrors the lib): RECORD -> stdout, errors -> stderr, the
# integer return is the VERDICT. The shipped lib HAND-PARSES the receipt JSON (no
# python in the lib - mirrors _idem_read_manifest_hash's prefix-strip style).
#
# Return-code band UNINSTALL-OWNED 70-79 (disjoint from 1-3/10-13/20-23/30-32/
# 40-42/50-54/60-65): 0 ok; 70 no-config-root; 71 no-receipt (loud "nothing left");
# 72 corrupt-receipt (refuse before touching anything); 73 repair-restore-failed
# (post-write hash != recorded OR delegate non-zero); 74 file-remove-failed;
# 75 configrestore-failed (post-restore priorValue oracle mismatch); 76
# repair-payload-mismatch (refuse, file unchanged).

# _uninstall_json_unescape <s> [output-name]: decode only escapes emitted by
# _receipt_json_escape. Failure publishes no output and leaves output-name unchanged.
_uninstall_json_unescape() {
  local s="$1" output_name="${2:-}" decoded="" index char escape unicode hex byte
  local length=${#s}
  for ((index = 0; index < length; index++)); do
    char="${s:index:1}"
    case "$char" in
      '"'|[$'\001'-$'\037']) return 1 ;;
      \\)
        [ $((index + 1)) -lt "$length" ] || return 1
        escape="${s:index+1:1}"
        case "$escape" in
          n) decoded+=$'\n'; index=$((index + 1)) ;;
          t) decoded+=$'\t'; index=$((index + 1)) ;;
          r) decoded+=$'\r'; index=$((index + 1)) ;;
          '"') decoded+='"'; index=$((index + 1)) ;;
          \\) decoded+='\'; index=$((index + 1)) ;;
          u)
            unicode="${s:index:6}"
            [[ "$unicode" =~ ^\\u00[[:xdigit:]]{2}$ ]] || return 1
            hex="${unicode:4:2}"
            [ "$hex" != "00" ] || return 1
            printf -v byte '%b' "\\x$hex" || return 1
            decoded+="$byte"
            index=$((index + 5))
            ;;
          *) return 1 ;;
        esac
        ;;
      *) decoded+="$char" ;;
    esac
  done
  if [ -n "$output_name" ]; then
    printf -v "$output_name" '%s' "$decoded"
  else
    printf '%s' "$decoded"
  fi
}

# Receipt grammar helpers use namerefs so parsing stays in the current shell and
# no partially decoded value crosses a command-substitution boundary.
_uninstall_parse_json_string() {
  local token="$1" output_name="$2" body parsed_value
  local -n output_ref="$output_name"
  [ "${#token}" -ge 2 ] || return 1
  [ "${token:0:1}" = '"' ] && [ "${token: -1}" = '"' ] || return 1
  body="${token:1:${#token}-2}"
  _uninstall_json_unescape "$body" parsed_value || return 1
  output_ref="$parsed_value"
}

_uninstall_parse_string_member() {
  local line="$1" prefix="$2" suffix="$3" output_name="$4" token
  [ "${line:0:${#prefix}}" = "$prefix" ] || return 1
  token="${line:${#prefix}}"
  if [ -n "$suffix" ]; then
    [ "${token: -${#suffix}}" = "$suffix" ] || return 1
    token="${token:0:${#token}-${#suffix}}"
  fi
  _uninstall_parse_json_string "$token" "$output_name"
}

_uninstall_parse_string_array() {
  local lines_name="$1" index_name="$2" key="$3" trailer="$4" output_name="$5"
  local -n source_lines="$lines_name" line_index="$index_name" parsed_paths="$output_name"
  local prefix="  \"$key\": " closing="  ]$trailer" entry token value has_comma
  [ "$line_index" -lt "${#source_lines[@]}" ] || return 1
  if [ "${source_lines[line_index]}" = "${prefix}[]$trailer" ]; then
    line_index=$((line_index + 1))
    return 0
  fi
  [ "${source_lines[line_index]}" = "${prefix}[" ] || return 1
  line_index=$((line_index + 1))
  while [ "$line_index" -lt "${#source_lines[@]}" ]; do
    entry="${source_lines[line_index]}"
    [ "${entry:0:4}" = "    " ] || return 1
    token="${entry:4}"
    has_comma=0
    if [ "${token: -1}" = ',' ]; then
      has_comma=1
      token="${token:0:${#token}-1}"
    fi
    _uninstall_parse_json_string "$token" value || return 1
    parsed_paths+=("$value")
    line_index=$((line_index + 1))
    if [ "$has_comma" -eq 1 ]; then
      [ "${source_lines[line_index]:-}" != "$closing" ] || return 1
      continue
    fi
    [ "${source_lines[line_index]:-}" = "$closing" ] || return 1
    line_index=$((line_index + 1))
    return 0
  done
  return 1
}

_uninstall_parse_edit_object() {
  local lines_name="$1" index_name="$2" edits_name="$3"
  local files_name="$4" keys_name="$5" values_name="$6" priors_name="$7" nulls_name="$8"
  local -n source_lines="$lines_name" line_index="$index_name" parsed_edits="$edits_name"
  local -n parsed_edit_files="$files_name" parsed_edit_keys="$keys_name"
  local -n parsed_edit_values="$values_name" parsed_edit_priors="$priors_name"
  local -n parsed_edit_nulls="$nulls_name"
  local file key value prior="" is_null=0 us=$'\037'
  [ "${source_lines[line_index]:-}" = '    {' ] || return 1
  _uninstall_parse_string_member "${source_lines[line_index+1]:-}" '      "file": ' ',' file || return 1
  _uninstall_parse_string_member "${source_lines[line_index+2]:-}" '      "key": ' ',' key || return 1
  _uninstall_parse_string_member "${source_lines[line_index+3]:-}" '      "value": ' ',' value || return 1
  if [ "${source_lines[line_index+4]:-}" = '      "priorValue": null' ]; then
    is_null=1
  else
    _uninstall_parse_string_member "${source_lines[line_index+4]:-}" \
      '      "priorValue": ' '' prior || return 1
  fi
  parsed_edit_files+=("$file"); parsed_edit_keys+=("$key")
  parsed_edit_values+=("$value"); parsed_edit_priors+=("$prior")
  parsed_edit_nulls+=("$is_null")
  [ "$is_null" -eq 1 ] && prior="$AUTOPROMPT_RECEIPT_ABSENT"
  parsed_edits+=("$file$us$key$us$value$us$prior")
  line_index=$((line_index + 5))
}

_uninstall_parse_edits_array() {
  local lines_name="$1" index_name="$2" edits_name="$3"
  local files_name="$4" keys_name="$5" values_name="$6" priors_name="$7" nulls_name="$8"
  local -n source_lines="$lines_name" line_index="$index_name"
  if [ "${source_lines[line_index]:-}" = '  "configEdits": []' ]; then
    line_index=$((line_index + 1))
    return 0
  fi
  [ "${source_lines[line_index]:-}" = '  "configEdits": [' ] || return 1
  line_index=$((line_index + 1))
  while true; do
    _uninstall_parse_edit_object "$lines_name" "$index_name" "$edits_name" \
      "$files_name" "$keys_name" "$values_name" "$priors_name" "$nulls_name" || return 1
    case "${source_lines[line_index]:-}" in
      '    },') line_index=$((line_index + 1)) ;;
      '    }')
        line_index=$((line_index + 1))
        [ "${source_lines[line_index]:-}" = '  ]' ] || return 1
        line_index=$((line_index + 1))
        return 0
        ;;
      *) return 1 ;;
    esac
  done
}

_uninstall_corrupt_receipt() {
  printf '%s\n' "error=corrupt-receipt path=$1 detail=$2" >&2
  return 72
}

_uninstall_publish_receipt() {
  UNINSTALL_RC_NONCE="$1"
  UNINSTALL_RC_BACKUP="$2"
  UNINSTALL_RC_OMP_MANAGED="$3"
  UNINSTALL_RC_HAS_OMP_MANAGED="$4"
  UNINSTALL_RC_OMP_DETACHED_ROOT="$5"
  UNINSTALL_RC_OMP_MANAGED_INFERRED="${13:-0}"
  UNINSTALL_RC_OMP_DETACHED_ROOT_INFERRED="${14:-0}"
  local -n published_files="$6" published_directories="$7"
  local -n published_edit_files="$8" published_edit_keys="$9"
  local -n published_edit_values="${10}" published_edit_priors="${11}"
  local -n published_edit_nulls="${12}"
  UNINSTALL_RC_FILES=("${published_files[@]}")
  UNINSTALL_RC_CREATED_DIRECTORIES=("${published_directories[@]}")
  UNINSTALL_RC_EDIT_FILE=("${published_edit_files[@]}")
  UNINSTALL_RC_EDIT_KEY=("${published_edit_keys[@]}")
  UNINSTALL_RC_EDIT_VALUE=("${published_edit_values[@]}")
  UNINSTALL_RC_EDIT_PRIOR=("${published_edit_priors[@]}")
  UNINSTALL_RC_EDIT_PRIOR_ISNULL=("${published_edit_nulls[@]}")
}

_uninstall_canonical_receipt() {
  local nonce="$1" backup="$2" has_directories="$3"
  local has_omp_managed="$4" omp_managed="$5"
  local has_detached_root="$6" detached_root="$7"
  local files_name="$8" directories_name="$9" edits_name="${10}"
  local output_name="${11:-}" has_hash_binding="${12:-0}"
  local prior_manifest_sha256="${13:-}" file_sha256_name="${14:-}"
  local backup_json detached_json escaped_backup escaped_detached escaped_nonce
  local files_json directories_json edits_json document
  if [ -z "$backup" ]; then
    backup_json=null
  else
    _receipt_json_escape "$backup" escaped_backup
    backup_json="\"$escaped_backup\""
  fi
  _receipt_json_escape "$nonce" escaped_nonce
  _receipt_path_array "$files_name" files_json
  _receipt_edits_array "$edits_name" edits_json
  printf -v document '{\n  "nonce": "%s",\n' "$escaped_nonce"
  if [ "$has_hash_binding" -eq 1 ]; then
    local prior_json=null file_sha256_json
    [ -z "$prior_manifest_sha256" ] || prior_json="\"$prior_manifest_sha256\""
    _receipt_path_array "$file_sha256_name" file_sha256_json
    document+="  \"priorManifestSha256\": $prior_json,"$'\n'
    document+="  \"fileSha256\": $file_sha256_json,"$'\n'
  fi
  document+="  \"backup\": $backup_json,"$'\n'
  document+="  \"files\": $files_json,"$'\n'
  if [ "$has_directories" -eq 1 ]; then
    _receipt_path_array "$directories_name" directories_json
    document+="  \"createdDirectories\": $directories_json,"$'\n'
  fi
  if [ "$has_omp_managed" -eq 1 ]; then
    if [ "$omp_managed" -eq 1 ]; then
      document+='  "ompManaged": true,'$'\n'
    else
      document+='  "ompManaged": false,'$'\n'
    fi
  fi
  if [ "$has_detached_root" -eq 1 ]; then
    if [ -z "$detached_root" ]; then
      detached_json=null
    else
      _receipt_json_escape "$detached_root" escaped_detached
      detached_json="\"$escaped_detached\""
    fi
    document+="  \"ompDetachedRoot\": $detached_json,"$'\n'
  fi
  document+="  \"configEdits\": $edits_json"$'\n}'
  if [ -n "$output_name" ]; then
    printf -v "$output_name" '%s' "$document"
  else
    printf '%s' "$document"
  fi
}

_uninstall_lexical_path() {
  local path="${1//\\//}" output_name="$2" prefix remaining segment parent
  local -a parts=()
  local -n normalized_output="$output_name"
  case "$path" in
    [A-Za-z]:/*) prefix="${path:0:2}"; remaining="${path:3}" ;;
    /*) prefix="/"; remaining="${path:1}" ;;
    *) return 1 ;;
  esac
  while true; do
    case "$remaining" in
      */*) segment="${remaining%%/*}"; remaining="${remaining#*/}" ;;
      *) segment="$remaining"; remaining="" ;;
    esac
    case "$segment" in
      ''|.) ;;
      ..)
        [ "${#parts[@]}" -gt 0 ] || return 1
        unset 'parts[${#parts[@]}-1]'
        parts=("${parts[@]}")
        ;;
      *) parts+=("$segment") ;;
    esac
    [ -z "$remaining" ] && break
  done
  normalized_output="$prefix"
  [ "$prefix" = "/" ] || normalized_output="$prefix/"
  for parent in "${parts[@]:-}"; do
    [ -n "$parent" ] || continue
    if [ "$normalized_output" = "/" ]; then
      normalized_output="/$parent"
    else
      normalized_output="${normalized_output%/}/$parent"
    fi
  done
}

_uninstall_physical_path() {
  local path="$1" output_name="$2" directory="$1" parent component suffix=""
  local resolved_directory saved_directory="$PWD"
  local -n physical_output="$output_name"
  [ ! -L "$path" ] || [ -d "$path" ] || return 1
  while [ ! -d "$directory" ]; do
    component="${directory##*/}"
    parent="${directory%/*}"
    [ "$parent" != "$directory" ] || return 1
    [ -n "$parent" ] || parent="/"
    suffix="/$component$suffix"
    directory="$parent"
  done
  cd -P -- "$directory" >/dev/null 2>&1 || return 1
  resolved_directory="$PWD"
  cd -- "$saved_directory" >/dev/null 2>&1 || return 1
  physical_output="${resolved_directory%/}$suffix"
  [ -n "$physical_output" ] || physical_output="/"
}

_uninstall_receipt_path_under_root() {
  local root="$1" path="$2" normalized_root normalized_path root_identity path_identity
  local filesystem_root filesystem_path physical_root physical_path
  _uninstall_lexical_path "$root" normalized_root || return 1
  _uninstall_lexical_path "$path" normalized_path || return 1
  _idem_cached_comparable_path "$normalized_root" root_identity || return 1
  _idem_cached_comparable_path "$normalized_path" path_identity || return 1
  [ "$path_identity" = "$root_identity" ] || [[ "$path_identity" == "$root_identity"/* ]] || return 1
  _uninstall_filesystem_path "$normalized_root" filesystem_root || return 1
  _uninstall_filesystem_path "$normalized_path" filesystem_path || return 1
  _uninstall_physical_path "$filesystem_root" physical_root || return 1
  _uninstall_physical_path "$filesystem_path" physical_path || return 1
  _idem_cached_comparable_path "$physical_root" root_identity || return 1
  _idem_cached_comparable_path "$physical_path" path_identity || return 1
  [ "$path_identity" = "$root_identity" ] || [[ "$path_identity" == "$root_identity"/* ]]
}

_uninstall_omp_detached_root_valid() {
  # PowerShell receipts use native Windows separators.  Normalize the receipt
  # value before suffix slicing so the same sealed receipt is authoritative
  # when Git Bash performs the later repair or uninstall.
  local omp_default_root="${1//\\//}" home
  [ -n "$omp_default_root" ] || return 1
  case "$omp_default_root" in */agent) ;; *) return 1 ;; esac
  home="$(resolve_home omp)" || return 1
  _idem_paths_equal "$home" "${omp_default_root%/agent}" && return 1
  _uninstall_receipt_path_under_root "$home" "$omp_default_root"
}

_uninstall_omp_detached_receipt_path_allowed() {
  local omp_default_root="${1//\\//}" path="$2" omp_config_dir omp_native_root
  _uninstall_omp_detached_root_valid "$omp_default_root" || return 1
  omp_config_dir="${omp_default_root%/agent}"
  omp_native_root="$omp_default_root/agents"
  _idem_paths_equal "$path" "$omp_config_dir" && return 0
  _idem_paths_equal "$path" "$omp_default_root" && return 0
  # The native path must be spelled beneath `agents` while also resolving
  # beneath the detached root.  Using `agents` as the sole physical root would
  # authorize its outside target when that directory is replaced by a symlink.
  _uninstall_receipt_path_under_root "$omp_native_root" "$path" || return 1
  _uninstall_receipt_path_under_root "$omp_default_root" "$path"
}

_uninstall_omp_detached_manifest_valid() {
  local root="$1" omp_default_root="${2//\\//}" files_name="$3"
  local manifest="$root/$AUTOPROMPT_HASH_MANIFEST_NAME" native_root
  local path parent basename recorded_hash="" index native_count=0
  local receipt_path receipt_matches
  local -a spellings=() identities=() hashes=()
  local -n receipt_files="$files_name"
  _uninstall_omp_detached_root_valid "$omp_default_root" || return 1
  _idem_parse_manifest "$manifest" spellings identities hashes || return 1
  native_root="$omp_default_root/agents"
  for ((index = 0; index < ${#spellings[@]}; index++)); do
    path="${spellings[index]//\\//}"
    parent="${path%/*}"; basename="${path##*/}"
    if _idem_paths_equal "$parent" "$native_root"; then
      case "$basename" in
        ap-*.md)
          _uninstall_omp_detached_receipt_path_allowed \
            "$omp_default_root" "${spellings[index]}" || return 1
          native_count=$((native_count + 1))
          receipt_matches=0
          for receipt_path in "${receipt_files[@]}"; do
            _idem_paths_equal "$receipt_path" "${spellings[index]}" &&
              receipt_matches=$((receipt_matches + 1))
          done
          [ "$receipt_matches" -eq 1 ] || return 1
          ;;
      esac
    fi
  done
  [ "$native_count" -eq 25 ] || return 1
  for path in "${receipt_files[@]}"; do
    _uninstall_receipt_path_under_root "$root" "$path" && continue
    _uninstall_omp_detached_receipt_path_allowed \
      "$omp_default_root" "$path" || continue
    _idem_read_manifest_hash "$root" "$path" recorded_hash || return 1
    [ -n "$recorded_hash" ] || return 1
  done
}

_uninstall_infer_legacy_omp_detached_root() {
  local root="$1" files_name="$2" output_name="$3"
  local manifest="$root/$AUTOPROMPT_HASH_MANIFEST_NAME"
  local path parent candidate="" candidate_identity="" identity="" index count=0
  local -a spellings=() identities=() hashes=()
  _idem_parse_manifest "$manifest" spellings identities hashes || return 1
  for ((index = 0; index < ${#spellings[@]}; index++)); do
    path="${spellings[index]//\\//}"
    case "${path##*/}" in ap-*.md) ;; *) continue ;; esac
    parent="${path%/*}"
    case "$parent" in */agent/agents) ;; *) continue ;; esac
    candidate="${parent%/agents}"
    _uninstall_omp_detached_root_valid "$candidate" || return 1
    _idem_cached_comparable_path "$candidate" identity || return 1
    if [ -n "$candidate_identity" ] && [ "$candidate_identity" != "$identity" ]; then
      return 1
    fi
    candidate_identity="$identity"
    count=$((count + 1))
  done
  [ -n "$candidate" ] && [ "$count" -eq 25 ] || return 1
  _uninstall_omp_detached_manifest_valid "$root" "$candidate" "$files_name" ||
    return 1
  printf -v "$output_name" '%s' "$candidate"
}

_uninstall_legacy_self_contained_omp_authority() {
  local root="$1" files_name="$2" edit_files_name="$3" edit_keys_name="$4"
  local index path normalized parent basename source recorded_hash expected_hash
  local -n receipt_files="$files_name" receipt_edit_files="$edit_files_name"
  local -n receipt_edit_keys="$edit_keys_name"
  for ((index = 0; index < ${#receipt_edit_files[@]}; index++)); do
    if [ "${receipt_edit_keys[index]}" = task.maxRecursionDepth ] &&
       _idem_paths_equal "${receipt_edit_files[index]}" "$root/config.yml"; then
      return 0
    fi
  done
  for path in "${receipt_files[@]}"; do
    normalized="${path//\\//}"
    parent="${normalized%/*}"; basename="${normalized##*/}"
    _idem_paths_equal "$parent" "$root/agents" || continue
    case "$basename" in ap-*.md) ;; *) continue ;; esac
    source="$AUTOPROMPT_INSTALL_REPO_ROOT/agents/omp/agents/$basename"
    [ -f "$source" ] || continue
    recorded_hash=""
    _idem_read_manifest_hash "$root" "$path" recorded_hash || continue
    [ -n "$recorded_hash" ] || continue
    expected_hash="$(_idem_sha256 "$source")" || continue
    [ "$recorded_hash" = "$expected_hash" ] && return 0
  done
  return 1
}

_uninstall_omp_detached_directory_allowed() {
  local omp_default_root="${1//\\//}" path="$2"
  local omp_config_dir="${omp_default_root%/agent}"
  _uninstall_omp_detached_receipt_path_allowed \
    "$omp_default_root" "$path" || return 1
  _idem_paths_equal "$path" "$omp_config_dir" && return 0
  _idem_paths_equal "$path" "$omp_default_root" && return 0
  _idem_paths_equal "$path" "$omp_default_root/agents"
}

_uninstall_receipt_path_allowed() {
  local root="$1" path="$2" omp_detached_root="${3:-}"
  local kilo_home="$HOME/.kilo" vscode_settings
  _uninstall_receipt_path_under_root "$root" "$path" && return 0
  if [ -n "$omp_detached_root" ] &&
     _uninstall_omp_detached_receipt_path_allowed "$omp_detached_root" "$path"; then
    return 0
  fi
  if autoprompt_install_root_override_present; then
    case "$AUTOPROMPT_INSTALL_ROOT_CLIENT" in
      vscode)
        vscode_settings="$(vscode_settings_file)"
        _idem_paths_equal "$path" "$vscode_settings" && return 0
        _idem_paths_equal "$path" "$vscode_settings$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX"
        return $?
        ;;
      *) return 1 ;;
    esac
  fi
  _idem_paths_equal "$path" "$kilo_home" && return 0
  _idem_paths_equal "$path" "$kilo_home/skills" && return 0
  _uninstall_receipt_path_under_root "$kilo_home/skills/autoprompt" "$path" && return 0
  vscode_settings="$(vscode_settings_file)"
  _idem_paths_equal "$path" "$vscode_settings" && return 0
  _idem_paths_equal "$path" "$vscode_settings$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX"
}

_uninstall_validate_receipt_paths() {
  local root="$1" backup="$2" omp_detached_root="$3"
  local files_name="$4" directories_name="$5" edit_files_name="$6" path
  local -n receipt_files="$files_name" receipt_directories="$directories_name"
  local -n receipt_edit_files="$edit_files_name"
  if [ -n "$omp_detached_root" ]; then
    _uninstall_omp_detached_manifest_valid \
      "$root" "$omp_detached_root" "$files_name" || return 1
    for path in "${receipt_directories[@]}"; do
      _uninstall_receipt_path_under_root "$root" "$path" && continue
      if _uninstall_omp_detached_receipt_path_allowed \
           "$omp_detached_root" "$path" &&
         ! _uninstall_omp_detached_directory_allowed \
           "$omp_detached_root" "$path"; then
        return 1
      fi
    done
    for path in "${receipt_edit_files[@]}"; do
      _uninstall_receipt_path_under_root "$root" "$path" && continue
      _uninstall_omp_detached_receipt_path_allowed \
        "$omp_detached_root" "$path" && return 1
    done
    if [ -n "$backup" ] && [ "$backup" != "none" ] &&
       ! _uninstall_receipt_path_under_root "$root" "$backup" &&
       _uninstall_omp_detached_receipt_path_allowed \
         "$omp_detached_root" "$backup"; then
      return 1
    fi
  fi
  for path in "${receipt_files[@]}" "${receipt_directories[@]}" \
    "${receipt_edit_files[@]}"; do
    [ -n "$path" ] || return 1
    if ! _uninstall_receipt_path_allowed "$root" "$path" "$omp_detached_root"; then
      printf '%s\n' "error=receipt-path-not-allowed path=$path" >&2
      return 1
    fi
  done
  [ -z "$backup" ] || [ "$backup" = "none" ] ||
    _uninstall_receipt_path_allowed "$root" "$backup" "$omp_detached_root"
}

_uninstall_parse_receipt_document() {
  local root="$1" receipt="$2" document="$3" index=0 nonce backup=""
  local has_directories=0 has_omp_managed=0 omp_managed=0 has_hash_binding=0
  local prior_manifest_sha256=""
  local has_detached_root=0 detached_root="" canonical
  local omp_managed_inferred=0 detached_root_inferred=0
  local -a lines=() files=() directories=() packed_edits=() file_sha256=()
  local -a edit_files=() edit_keys=() edit_values=() edit_priors=() edit_nulls=()
  mapfile -t lines < <(printf '%s' "$document")
  [ "${lines[index]:-}" = '{' ] || return 1
  index=$((index + 1))
  _uninstall_parse_string_member "${lines[index]:-}" '  "nonce": ' ',' nonce || return 1
  index=$((index + 1))
  if [[ "${lines[index]:-}" == '  "priorManifestSha256": '* ]]; then
    has_hash_binding=1
    if [ "${lines[index]:-}" != '  "priorManifestSha256": null,' ]; then
      _uninstall_parse_string_member "${lines[index]:-}" \
        '  "priorManifestSha256": ' ',' prior_manifest_sha256 || return 1
      [[ "$prior_manifest_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
    fi
    index=$((index + 1))
    _uninstall_parse_string_array lines index fileSha256 ',' file_sha256 || return 1
    local binding
    for binding in "${file_sha256[@]}"; do
      [[ "$binding" =~ =([a-f0-9]{64})$ ]] || return 1
    done
  fi
  if [ "${lines[index]:-}" != '  "backup": null,' ]; then
    _uninstall_parse_string_member "${lines[index]:-}" '  "backup": ' ',' backup || return 1
  fi
  index=$((index + 1))
  _uninstall_parse_string_array lines index files ',' files || return 1
  if [ "${lines[index]:-}" = '  "createdDirectories": [],' ] ||
     [ "${lines[index]:-}" = '  "createdDirectories": [' ]; then
    has_directories=1
    _uninstall_parse_string_array lines index createdDirectories ',' directories || return 1
  fi
  case "${lines[index]:-}" in
    '  "ompManaged": true,')
      has_omp_managed=1; omp_managed=1; index=$((index + 1))
      ;;
    '  "ompManaged": false,')
      has_omp_managed=1; omp_managed=0; index=$((index + 1))
      ;;
  esac
  if [ "${lines[index]:-}" = '  "ompDetachedRoot": null,' ]; then
    has_detached_root=1
    index=$((index + 1))
  elif [[ "${lines[index]:-}" == '  "ompDetachedRoot": '* ]]; then
    has_detached_root=1
    _uninstall_parse_string_member "${lines[index]:-}" \
      '  "ompDetachedRoot": ' ',' detached_root || return 1
    index=$((index + 1))
  fi
  _uninstall_parse_edits_array lines index packed_edits edit_files edit_keys \
    edit_values edit_priors edit_nulls || return 1
  [ "${lines[index]:-}" = '}' ] && [ $((index + 1)) -eq "${#lines[@]}" ] || return 1
  _uninstall_canonical_receipt "$nonce" "$backup" "$has_directories" \
    "$has_omp_managed" "$omp_managed" "$has_detached_root" "$detached_root" \
    files directories packed_edits canonical "$has_hash_binding" \
    "$prior_manifest_sha256" file_sha256 || return 1
  [ "$document" = "$canonical"$'\n' ] || return 1
  if [ "$has_detached_root" -eq 0 ]; then
    if _uninstall_infer_legacy_omp_detached_root \
         "$root" files detached_root; then
      detached_root_inferred=1
    else
      detached_root=""
    fi
  fi
  if [ "$has_omp_managed" -eq 0 ] &&
     { [ -n "$detached_root" ] ||
       _uninstall_legacy_self_contained_omp_authority \
         "$root" files edit_files edit_keys; }; then
    omp_managed=1
    omp_managed_inferred=1
  fi
  [ "$omp_managed" -eq 1 ] || [ -z "$detached_root" ] || return 1
  _uninstall_validate_receipt_paths "$root" "$backup" "$detached_root" \
    files directories edit_files || return 2
  _uninstall_publish_receipt "$nonce" "$backup" "$omp_managed" \
    "$has_omp_managed" "$detached_root" files directories edit_files \
    edit_keys edit_values edit_priors edit_nulls \
    "$omp_managed_inferred" "$detached_root_inferred"
}

# _uninstall_read_receipt validates the complete canonical document before it
# publishes parser globals. Legacy receipts may omit createdDirectories and
# ompManaged and ompDetachedRoot.
_uninstall_read_receipt() {
  local root="$1" receipt="$1/$AUTOPROMPT_RECEIPT_NAME" document="" read_code
  if [ ! -f "$receipt" ]; then
    printf '%s\n' "error=no-receipt path=$receipt" >&2
    printf 'Autoprompt uninstall: no install receipt found at %s - nothing to remove (re-run the installer, or remove files manually).\n' "$receipt" >&2
    return 71
  fi
  IFS= read -r -d '' document < "$receipt"; read_code=$?
  if [ "$read_code" -eq 0 ]; then
    _uninstall_corrupt_receipt "$receipt" nul-byte
    return 72
  fi
  case "$document" in
    *$'\r'*) _uninstall_corrupt_receipt "$receipt" newline; return 72 ;;
  esac
  _uninstall_parse_receipt_document "$root" "$receipt" "$document"
  read_code=$?
  case "$read_code" in
    0) return 0 ;;
    2) _uninstall_corrupt_receipt "$receipt" path-outside-root; return 72 ;;
    *) _uninstall_corrupt_receipt "$receipt" grammar; return 72 ;;
  esac
}

# _uninstall_parse_key_value <file> <dotted-key>: hand-parse <file> as TOML enough
# to echo the raw value token for <dotted-key> (only the agents.* keys we own),
# or the sentinel __CL_ABSENT__ when the key is absent. Mirrors configedit's scan:
# track the current table, match `key = value` on the stripped form. Inline comments
# and surrounding whitespace are trimmed off the value token (the post-restore
# oracle compares the integer/string token, not byte spacing).
_uninstall_parse_key_value() {
  local file="$1" dotted="$2"
  local want_table="${dotted%.*}" want_key="${dotted##*.}"
  [ -f "$file" ] || { printf '%s' "__CL_ABSENT__"; return 0; }
  local cur_table="" raw stripped key val
  while IFS= read -r raw || [ -n "$raw" ]; do
    stripped="${raw#"${raw%%[![:space:]]*}"}"
    stripped="${stripped%"${stripped##*[![:space:]]}"}"
    case "$stripped" in
      ''|'#'*) continue ;;
      '['*']')
        local n="${stripped#\[}"; n="${n%\]}"
        n="${n#"${n%%[![:space:]]*}"}"; n="${n%"${n##*[![:space:]]}"}"
        cur_table="$n"; continue ;;
    esac
    case "$stripped" in
      *'='*)
        key="${stripped%%=*}"; key="${key%"${key##*[![:space:]]}"}"
        if [ "$cur_table" = "$want_table" ] && [ "$key" = "$want_key" ]; then
          val="${stripped#*=}"; val="${val#"${val%%[![:space:]]*}"}"
          # Strip a trailing inline comment (TOML: ` # ...`) and surrounding ws.
          val="${val%%#*}"
          val="${val%"${val##*[![:space:]]}"}"
          # Unquote a basic-string value.
          case "$val" in '"'*'"') val="${val#\"}"; val="${val%\"}" ;; esac
          printf '%s' "$val"
          return 0
        fi
        ;;
    esac
  done < "$file"
  printf '%s' "__CL_ABSENT__"
}

# _uninstall_verify_priorvalues <file> <i...>: post-restore oracle. For each edit
# index in $@ (all edits of THIS file), assert the recorded key equals its
# priorValue (or is absent when priorValue was null). Returns 0 on all-match, 75
# on the first mismatch (loud - the .bak was stale/wrong, or surgical undo failed).
_uninstall_verify_priorvalues() {
  local file="$1"; shift
  local idx live want isnull
  for idx in "$@"; do
    isnull="${UNINSTALL_RC_EDIT_PRIOR_ISNULL[idx]}"
    want="${UNINSTALL_RC_EDIT_PRIOR[idx]}"
    live="$(_uninstall_parse_key_value "$file" "${UNINSTALL_RC_EDIT_KEY[idx]}")"
    if [ "$isnull" -eq 1 ]; then
      if [ "$live" != "__CL_ABSENT__" ]; then
        printf '%s\n' "error=configrestore-failed path=$file key=${UNINSTALL_RC_EDIT_KEY[idx]} detail=expected-absent found=$live" >&2
        return 75
      fi
    else
      # Compare the integer/string token. The recorded priorValue for our keys is
      # the bare prior token (configedit records the first-int or raw token).
      if [ "$live" != "$want" ]; then
        printf '%s\n' "error=configrestore-failed path=$file key=${UNINSTALL_RC_EDIT_KEY[idx]} detail=expected=$want found=$live" >&2
        return 75
      fi
    fi
  done
  return 0
}

# _uninstall_surgical_remove_keys <file> <i...>: the no-.bak FALLBACK. The writer
# made no .bak iff the pre-edit file was empty/absent (create-from-scratch): every
# recorded key for this file has priorValue==null and the writer appended its
# canonical block. Reconstruct the pre-edit state = remove exactly the lines for the
# recorded keys and any now-orphaned `[agents]` header the writer created, then if
# the file is left with no meaningful content, truncate to zero / delete. Returns 0.
_uninstall_collect_key_names() {
  local output_name="$1"; shift
  local -n published_key_names="$output_name"
  local index
  for index in "$@"; do
    published_key_names+=("${UNINSTALL_RC_EDIT_KEY[index]##*.}")
  done
}

_uninstall_filter_key_lines() {
  local file="$1" keys_name="$2" output_name="$3"
  local -n source_key_names="$keys_name" filtered_lines_ref="$output_name"
  local raw stripped key keep wanted
  while IFS= read -r raw || [ -n "$raw" ]; do
    stripped="${raw#"${raw%%[![:space:]]*}"}"
    stripped="${stripped%"${stripped##*[![:space:]]}"}"
    keep=1
    case "$stripped" in
      *'='*)
        key="${stripped%%=*}"; key="${key%"${key##*[![:space:]]}"}"
        for wanted in "${source_key_names[@]}"; do
          [ "$key" = "$wanted" ] && { keep=0; break; }
        done
        ;;
    esac
    [ "$keep" -eq 1 ] && filtered_lines_ref+=("$raw")
  done < "$file"
}

_uninstall_trim_agents_tail() {
  local lines_name="$1" last stripped
  local -n trimmed_lines="$lines_name"
  while [ "${#trimmed_lines[@]}" -gt 0 ]; do
    last="${trimmed_lines[${#trimmed_lines[@]}-1]}"
    stripped="${last#"${last%%[![:space:]]*}"}"
    stripped="${stripped%"${stripped##*[![:space:]]}"}"
    [ "$stripped" = "[agents]" ] || [ -z "$stripped" ] || break
    unset 'trimmed_lines[${#trimmed_lines[@]}-1]'
    trimmed_lines=("${trimmed_lines[@]}")
  done
}

_uninstall_write_restored_lines() {
  local file="$1" lines_name="$2" content="" first=1 line
  local -n restored_lines_ref="$lines_name"
  if [ "${#restored_lines_ref[@]}" -eq 0 ]; then
    : > "$file"
    return 0
  fi
  for line in "${restored_lines_ref[@]}"; do
    if [ "$first" -eq 1 ]; then content="$line"; first=0
    else content="$content"$'\n'"$line"
    fi
  done
  printf '%s' "$content"$'\n' > "$file"
}

_uninstall_surgical_remove_keys() {
  local file="$1"; shift
  [ -f "$file" ] || return 0
  local -a key_names=() restored_lines=()
  _uninstall_collect_key_names key_names "$@"
  _uninstall_filter_key_lines "$file" key_names restored_lines
  _uninstall_trim_agents_tail restored_lines
  _uninstall_write_restored_lines "$file" restored_lines
}

# _uninstall_strip_keylines <file> <i...>: echo <file>'s NON-BLANK lines with the
# recorded key lines (and any line that is exactly the [agents] header) removed, so
# two files can be compared "modulo our edits + blank separators". Blanks are
# dropped because the writer may insert a blank separator before a created [agents]
# block (UN3) that is not in the .bak; ignoring blanks isolates a genuine user edit
# (UN16) from that benign formatting difference.
_uninstall_strip_keylines() {
  local file="$1"; shift
  [ -f "$file" ] || return 0
  local -a wantkeys=()
  local idx
  for idx in "$@"; do wantkeys+=("${UNINSTALL_RC_EDIT_KEY[idx]##*.}"); done
  local raw stripped key keep w
  while IFS= read -r raw || [ -n "$raw" ]; do
    stripped="${raw#"${raw%%[![:space:]]*}"}"
    stripped="${stripped%"${stripped##*[![:space:]]}"}"
    keep=1
    [ -z "$stripped" ] && keep=0
    [ "$stripped" = "[agents]" ] && keep=0
    case "$stripped" in
      *'='*)
        key="${stripped%%=*}"; key="${key%"${key##*[![:space:]]}"}"
        for w in "${wantkeys[@]}"; do [ "$key" = "$w" ] && { keep=0; break; }; done
        ;;
    esac
    [ "$keep" -eq 1 ] && printf '%s\n' "$stripped"
  done < "$file"
}

_uninstall_remove_config_backup() {
  local file="$1" backup="$2"
  [ -f "$backup" ] || return 0
  if ! rm -f -- "$backup" 2>/dev/null; then
    printf '%s\n' \
      "error=configrestore-failed path=$file detail=backup-remove backup=$backup" >&2
    return 75
  fi
}

# _uninstall_restore_one_configfile <file> <i...>: restore ONE edited config file
# given all its edit indices. PRIMARY whole-file .bak restore; FALLBACK surgical
# undo when no .bak; config-absent skip (never resurrect); divergence guard (a
# recorded key no longer holds its installed value => surgical, preserving the
# user's unrelated edits). Post-restore priorValue oracle. Returns 0 / 74 / 75.
_uninstall_get_config_divergence() {
  local file="$1" backup="$2" indices_name="$3" output_name="$4"
  local -n edit_indices_ref="$indices_name" divergence_ref="$output_name"
  local index live live_stripped backup_stripped
  for index in "${edit_indices_ref[@]}"; do
    live="$(_uninstall_parse_key_value "$file" "${UNINSTALL_RC_EDIT_KEY[index]}")"
    if [ "$live" != "${UNINSTALL_RC_EDIT_VALUE[index]}" ]; then
      divergence_ref=1
      return 0
    fi
  done
  [ -f "$backup" ] || return 0
  live_stripped="$(_uninstall_strip_keylines "$file" "${edit_indices_ref[@]}")"
  backup_stripped="$(_uninstall_strip_keylines "$backup" "${edit_indices_ref[@]}")"
  [ "$live_stripped" = "$backup_stripped" ] || divergence_ref=1
}

_uninstall_restore_config_backup() {
  local file="$1" backup="$2" indices_name="$3" tmp="$1.cl-restore.tmp"
  local -n edit_indices_ref="$indices_name"
  if ! cp -p -- "$backup" "$tmp" 2>/dev/null ||
     ! mv -f -- "$tmp" "$file" 2>/dev/null; then
    rm -f -- "$tmp" 2>/dev/null
    printf '%s\n' "error=configrestore-failed path=$file detail=bak-restore-write" >&2
    return 75
  fi
  _uninstall_remove_config_backup "$file" "$backup" || return $?
  _uninstall_verify_priorvalues "$file" "${edit_indices_ref[@]}" || return 75
  printf '%s\n' "configrestore=$file via=bak keys=${#edit_indices_ref[@]}"
}

_uninstall_restore_diverged_config() {
  local file="$1" backup="$2" indices_name="$3"
  local -n edit_indices_ref="$indices_name"
  _uninstall_surgical_restore_priors "$file" "${edit_indices_ref[@]}" || return 75
  _uninstall_remove_config_backup "$file" "$backup" || return $?
  _uninstall_verify_priorvalues "$file" "${edit_indices_ref[@]}" || return 75
  printf '%s\n' "configrestore=$file via=surgical-diverged note=user-modified-since-install keys=${#edit_indices_ref[@]}"
}

_uninstall_restore_surgical_config() {
  local file="$1" indices_name="$2"
  local -n edit_indices_ref="$indices_name"
  _uninstall_surgical_remove_keys "$file" "${edit_indices_ref[@]}"
  _uninstall_verify_priorvalues "$file" "${edit_indices_ref[@]}" || return 75
  printf '%s\n' "configrestore=$file via=surgical keys=${#edit_indices_ref[@]} table=removed"
}

_uninstall_restore_one_configfile() {
  local file="$1"; shift
  local -a indices=("$@")
  local backup="$file$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" is_diverged=0
  if [ "${#indices[@]}" -eq 1 ] &&
     [ "${UNINSTALL_RC_EDIT_KEY[indices[0]]}" = "$AUTOPROMPT_VSCODE_ACTIVATION_KEY" ]; then
    local prior="${UNINSTALL_RC_EDIT_PRIOR[indices[0]]}"
    [ "${UNINSTALL_RC_EDIT_PRIOR_ISNULL[indices[0]]}" -eq 0 ] || prior=absent
    node "$(vscode_settings_helper)" restore --file "$file" \
      --backup "$backup" --prior "$prior" || return 75
    return 0
  fi
  if [ "${#indices[@]}" -eq 1 ]; then
    local harness_provider="" harness_key="${UNINSTALL_RC_EDIT_KEY[indices[0]]}"
    case "$harness_key" in
      task.maxRecursionDepth) harness_provider=omp ;;
      agent.max_subagent_depth) harness_provider=reasonix ;;
    esac
    if [ -n "$harness_provider" ]; then
      local harness_prior="${UNINSTALL_RC_EDIT_PRIOR[indices[0]]}"
      [ "${UNINSTALL_RC_EDIT_PRIOR_ISNULL[indices[0]]}" -eq 0 ] || harness_prior=absent-key
      node "$AUTOPROMPT_INSTALL_REPO_ROOT/scripts/harness-provider-config.cjs" \
        restore --provider "$harness_provider" --file "$file" \
        --backup "$backup" --prior "$harness_prior" --expected 4 || return 75
      return 0
    fi
  fi
  if [ ! -f "$file" ]; then
    _uninstall_remove_config_backup "$file" "$backup" || return $?
    printf '%s\n' "configrestore=$file note=config-absent"
    return 0
  fi
  _uninstall_get_config_divergence "$file" "$backup" indices is_diverged
  if [ -f "$backup" ] && [ "$is_diverged" -eq 0 ]; then
    _uninstall_restore_config_backup "$file" "$backup" indices
    return $?
  fi
  if [ -f "$backup" ]; then
    _uninstall_restore_diverged_config "$file" "$backup" indices
    return $?
  fi
  _uninstall_restore_surgical_config "$file" indices
}

# _uninstall_surgical_restore_priors <file> <i...>: set each recorded key back to
# its priorValue (null => delete the key line; non-null => rewrite `key = prior`),
# preserving every other byte/line. Used only on the diverged path (no .bak trust).
_uninstall_surgical_restore_priors() {
  local file="$1"; shift
  local -a idxs=("$@")
  local -a out=()
  local raw stripped key handled
  while IFS= read -r raw || [ -n "$raw" ]; do
    stripped="${raw#"${raw%%[![:space:]]*}"}"
    stripped="${stripped%"${stripped##*[![:space:]]}"}"
    handled=0
    case "$stripped" in
      *'='*)
        key="${stripped%%=*}"; key="${key%"${key##*[![:space:]]}"}"
        local idx
        for idx in "${idxs[@]}"; do
          local wk="${UNINSTALL_RC_EDIT_KEY[idx]##*.}"
          if [ "$key" = "$wk" ]; then
            handled=1
            if [ "${UNINSTALL_RC_EDIT_PRIOR_ISNULL[idx]}" -eq 1 ]; then
              :   # null prior => drop the line (key was absent at install)
            else
              local indent="${raw%%[![:space:]]*}"
              out+=("$indent$wk = ${UNINSTALL_RC_EDIT_PRIOR[idx]}")
            fi
            break
          fi
        done
        ;;
    esac
    [ "$handled" -eq 0 ] && out+=("$raw")
  done < "$file"

  local content="" first=1 ln
  for ln in "${out[@]}"; do
    if [ "$first" -eq 1 ]; then content="$ln"; first=0; else content="$content"$'\n'"$ln"; fi
  done
  [ "${#out[@]}" -gt 0 ] && content="$content"$'\n'
  if ! _configedit_atomic_write "$file" "$content"; then
    printf '%s\n' "error=configrestore-failed path=$file detail=surgical-write" >&2
    return 75
  fi
  return 0
}

# _uninstall_restore_configedits: group UNINSTALL_RC_EDIT_* by file, restore EACH
# distinct file. Cross-check the receipt top-level backup field against the last
# edited file's derived .bak (informational warn only). Echoes a count of files
# restored on the LAST line is the caller's job; here we just restore. Returns the
# first non-zero per-file code (74/75) or 0.
_uninstall_restore_configedits() {
  local n="${#UNINSTALL_RC_EDIT_FILE[@]}"
  [ "$n" -eq 0 ] && { UNINSTALL_RESTORED_EDIT_FILES=0; return 0; }

  local -a seen_files=()
  local i j found
  UNINSTALL_RESTORED_EDIT_FILES=0
  for ((i = 0; i < n; i++)); do
    local f="${UNINSTALL_RC_EDIT_FILE[i]}"
    found=0
    for ((j = 0; j < ${#seen_files[@]}; j++)); do
      [ "${seen_files[j]}" = "$f" ] && { found=1; break; }
    done
    [ "$found" -eq 1 ] && continue
    seen_files+=("$f")
    # Collect every edit index for this file.
    local -a fidx=()
    for ((j = 0; j < n; j++)); do
      [ "${UNINSTALL_RC_EDIT_FILE[j]}" = "$f" ] && fidx+=("$j")
    done
    _uninstall_restore_one_configfile "$f" "${fidx[@]}" || return $?
    UNINSTALL_RESTORED_EDIT_FILES=$((UNINSTALL_RESTORED_EDIT_FILES + 1))
  done
  return 0
}

# _uninstall_remove_empty_dirs <config-root> <file>: walk UPWARD from the removed
# file's parent toward (never past) config-root/HOME/XDG/drive-root, rmdir ONLY when
# the dir is now empty. The empty-test IS the safety: a populated dir survives.
_uninstall_remove_empty_dirs() {
  local root="$1" file="$2"
  local xdg="${XDG_CONFIG_HOME:-}"
  local dir="${file%/*}"
  while [ -n "$dir" ] && [ -d "$dir" ]; do
    case "$dir" in
      "$root"|"${HOME:-/__no_home__}"|"/"|"") break ;;
    esac
    [ -n "$xdg" ] && [ "$dir" = "$xdg" ] && break
    case "$dir" in */) : ;; *) ;; esac
    # Drive-root guard (Windows / MSYS: e.g. /c or C:/).
    case "$dir" in
      [A-Za-z]:|[A-Za-z]:/) break ;;
    esac
    rmdir -- "$dir" 2>/dev/null || break   # non-empty => rmdir fails => stop
    dir="${dir%/*}"
    [ "$dir" = "$file" ] && break
  done
}

[ -n "${AUTOPROMPT_COMPARABLE_PATH_CACHE+set}" ] ||
  declare -A AUTOPROMPT_COMPARABLE_PATH_CACHE=()

_idem_windows_long_path() {
  local input_path="${1//\\//}" output_name="$2"
  local filesystem_path directory parent component suffix="" long_directory
  filesystem_path="$(cygpath -au -- "$input_path" 2>/dev/null)" || return 1
  directory="$filesystem_path"
  while [ ! -e "$directory" ] && [ ! -L "$directory" ]; do
    component="${directory##*/}"
    parent="${directory%/*}"
    [ "$parent" != "$directory" ] || return 1
    [ -n "$parent" ] || parent="/"
    suffix="/$component$suffix"
    directory="$parent"
  done
  long_directory="$(cygpath -alm -- "$directory" 2>/dev/null)" || return 1
  printf -v "$output_name" '%s' "${long_directory%/}$suffix"
}

_idem_comparable_path() {
  local input_path="$1" output_name="${2:-}" result_value windows_path=0
  input_path="${input_path//\\//}"
  case "${OSTYPE:-}:${MSYSTEM:-}" in
    msys*:*|cygwin*:*|mingw*:*|*:MSYS*|*:MINGW*) windows_path=1 ;;
  esac
  if [ "$windows_path" -eq 1 ]; then
    if command -v cygpath >/dev/null 2>&1; then
      _idem_windows_long_path "$input_path" result_value || return 1
    else
      case "$input_path" in
        [A-Za-z]:/*) result_value="$input_path" ;;
        /[A-Za-z]/*) result_value="${input_path:1:1}:${input_path:2}" ;;
        /[A-Za-z]) result_value="${input_path:1:1}:" ;;
        *) result_value="$input_path" ;;
      esac
    fi
    result_value="${result_value,,}"
  else
    result_value="$input_path"
  fi
  result_value="${result_value%/}"
  if [ -n "$output_name" ]; then
    printf -v "$output_name" '%s' "$result_value"
  else
    printf '%s' "$result_value"
  fi
}

_idem_cached_comparable_path() {
  local path="$1" output_name="$2" converted
  [ -n "$path" ] || { printf -v "$output_name" '%s' ""; return 0; }
  if [ -n "${AUTOPROMPT_COMPARABLE_PATH_CACHE[$path]+set}" ]; then
    printf -v "$output_name" '%s' "${AUTOPROMPT_COMPARABLE_PATH_CACHE[$path]}"
    return 0
  fi
  _idem_comparable_path "$path" converted || return 1
  AUTOPROMPT_COMPARABLE_PATH_CACHE["$path"]="$converted"
  printf -v "$output_name" '%s' "$converted"
}

_idem_path_under_root() {
  local path_identity root_identity
  _idem_cached_comparable_path "$1" path_identity || return 1
  _idem_cached_comparable_path "$2" root_identity || return 1
  path_identity="${path_identity%/}"; root_identity="${root_identity%/}"
  [ "$path_identity" = "$root_identity" ] || [[ "$path_identity" == "$root_identity"/* ]]
}

_uninstall_filesystem_path() {
  local input_path="$1" output_name="${2:-}" result_value drive windows_path=0
  input_path="${input_path//\\//}"
  case "${OSTYPE:-}:${MSYSTEM:-}" in
    msys*:*|cygwin*:*|mingw*:*|*:MSYS*|*:MINGW*) windows_path=1 ;;
  esac
  if [ "$windows_path" -eq 1 ]; then
    case "$input_path" in
      /*) result_value="$input_path" ;;
      [A-Za-z]:/*)
        drive="${input_path:0:1}"
        result_value="/${drive,,}${input_path:2}"
        ;;
      *) result_value="$(cygpath -u -- "$input_path" 2>/dev/null)" || return 1 ;;
    esac
  else
    result_value="$input_path"
  fi
  if [ -n "$output_name" ]; then
    printf -v "$output_name" '%s' "$result_value"
  else
    printf '%s' "$result_value"
  fi
}

_opencode_owned_path() {
  local root="$1" path="$2" basename parent comparable_path
  local comparable_profile comparable_agents
  _idem_path_under_root "$path" "$root/opencode/skills/autoprompt" && return 0
  comparable_path="$(_idem_comparable_path "$path")" || return 1
  comparable_profile="$(_idem_comparable_path "$root/opencode/autoprompt.opencode.json")" || return 1
  [ "$comparable_path" = "$comparable_profile" ] && return 0
  comparable_agents="$(_idem_comparable_path "$root/opencode/agents")" || return 1
  parent="${comparable_path%/*}"
  [ "$parent" = "$comparable_agents" ] || return 1
  basename="${comparable_path##*/}"
  case "$basename" in ap-*.md) return 0 ;; esac
  return 1
}

_custom_install_root_owned_path() {
  # Receipts sealed by the PowerShell port carry native Windows separators.
  # Authorization comparisons already canonicalize them, but provider-specific
  # parent/basename slicing must use slash form as well or detached OMP files are
  # incorrectly retained before they ever reach the filesystem removal path.
  local root="$1" provider="$2" path="${3//\\//}" skills="$1/skills"
  local skill="$1/skills/autoprompt" agents="$1/agents" parent basename settings
  local omp_config_dir omp_default_root omp_native_agents
  if [ -n "$AUTOPROMPT_INSTALL_ROOT_CLIENT" ] &&
     [ "$provider" != "$AUTOPROMPT_INSTALL_ROOT_CLIENT" ]; then
    return 1
  fi
  _idem_paths_equal "$path" "$skills" && return 0
  _idem_paths_equal "$path" "$skill" && return 0
  _idem_path_under_root "$path" "$skill" && return 0
  [ "$provider" = vibe ] && { _vibe_owned_path "$root" "$path"; return $?; }
  [ "$provider" = codex ] && {
    _idem_paths_equal "$path" "$root/autoprompt.config.toml" && return 0
    _idem_paths_equal "$path" "$root/config.toml" && return 0
    _idem_paths_equal "$path" "$root/config.toml$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" && return 0
    _idem_paths_equal "$path" "$root/scripts" && return 0
    _idem_paths_equal "$path" "$root/scripts/local-only-safety.cjs" && return 0
    _idem_paths_equal "$path" "$root/skills/contracts" && return 0
    _idem_path_under_root "$path" "$root/skills/contracts"
    return $?
  }
  parent="${path%/*}"; basename="${path##*/}"
  case "$provider" in
    claude)
      _idem_paths_equal "$path" "$agents" && return 0
      _idem_paths_equal "$parent" "$agents" && case "$basename" in ap-*.md) return 0 ;; esac
      ;;
    opencode)
      _idem_paths_equal "$path" "$agents" && return 0
      _idem_paths_equal "$path" "$root/autoprompt.opencode.json" && return 0
      _idem_paths_equal "$parent" "$agents" && case "$basename" in ap-*.md) return 0 ;; esac
      ;;
    kilo)
      _idem_paths_equal "$path" "$agents" && return 0
      _idem_paths_equal "$path" "$root/autoprompt.kilo.json" && return 0
      _idem_paths_equal "$parent" "$agents" && case "$basename" in ap-*.md) return 0 ;; esac
      ;;
    vscode)
      _idem_paths_equal "$path" "$agents" && return 0
      _idem_paths_equal "$parent" "$agents" && case "$basename" in ap-*.agent.md) return 0 ;; esac
      settings="$(vscode_settings_file)"
      _idem_paths_equal "$path" "$settings" && return 0
      _idem_paths_equal "$path" "$settings$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" && return 0
      ;;
    omp)
      omp_default_root="${UNINSTALL_RC_OMP_DETACHED_ROOT:-}"
      omp_default_root="${omp_default_root//\\//}"
      if [ -n "$omp_default_root" ]; then
        omp_config_dir="${omp_default_root%/agent}"
        omp_native_agents="$omp_default_root/agents"
        _idem_paths_equal "$path" "$omp_config_dir" && return 0
        _idem_paths_equal "$path" "$omp_default_root" && return 0
        if _idem_paths_equal "$path" "$omp_native_agents"; then
          _uninstall_omp_detached_receipt_path_allowed \
            "$omp_default_root" "$path"
          return $?
        fi
        if _idem_paths_equal "$parent" "$omp_native_agents"; then
          _uninstall_omp_detached_receipt_path_allowed \
            "$omp_default_root" "$path" || return 1
          case "$basename" in ap-*.md) return 0 ;; esac
        fi
      elif [ "${UNINSTALL_RC_OMP_MANAGED:-0}" -eq 1 ]; then
        _idem_paths_equal "$path" "$agents" && return 0
        _idem_paths_equal "$parent" "$agents" &&
          case "$basename" in ap-*.md) return 0 ;; esac
      fi
      _idem_paths_equal "$path" "$root/config.yml" && return 0
      _idem_paths_equal "$path" "$root/config.yml$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" && return 0
      ;;
    deepseek)
      _idem_paths_equal "$path" "$root/.agent-presets" && return 0
      _idem_paths_equal "$path" "$root/.agent-presets/autoprompt" && return 0
      _idem_paths_equal "$parent" "$root/.agent-presets/autoprompt" &&
        case "$basename" in agent.cordis.yml|preset.yml) return 0 ;; esac
      ;;
    reasonix)
      _idem_paths_equal "$path" "$root/config.toml" && return 0
      _idem_paths_equal "$path" "$root/config.toml$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" && return 0
      if _idem_paths_equal "$parent" "$skills"; then
        case "$basename" in ap-*) return 0 ;; esac
      fi
      if [ "$basename" = SKILL.md ]; then
        local profile_dir="${path%/*}" profile_parent profile_name
        profile_parent="${profile_dir%/*}"; profile_name="${profile_dir##*/}"
        _idem_paths_equal "$profile_parent" "$skills" &&
          case "$profile_name" in ap-*) return 0 ;; esac
      fi
      ;;
  esac
  return 1
}

_opencode_owned_config_path() {
  local root="$1" path="$2" comparable_path comparable_profile
  comparable_path="$(_idem_comparable_path "$path")" || return 1
  comparable_profile="$(_idem_comparable_path "$root/opencode/autoprompt.opencode.json")" || return 1
  [ "$comparable_path" = "$comparable_profile" ]
}

_kilo_owned_path() {
  local root="$1" path="$2"
  _idem_path_under_root "$path" "$HOME/.kilo/skills/autoprompt" && return 0
  _idem_paths_equal "$path" "$HOME/.kilo" && return 0
  _idem_paths_equal "$path" "$HOME/.kilo/skills" && return 0
  _idem_path_under_root "$path" "$root/kilo"
}

_kilo_owned_config_path() {
  _idem_path_under_root "$2" "$1/kilo"
}

_vscode_owned_path() {
  local path="$2" comparable parent basename
  _idem_path_under_root "$path" "$HOME/.copilot/skills/autoprompt" && return 0
  comparable="$(_idem_comparable_path "$path")" || return 1
  parent="${comparable%/*}"
  _idem_paths_equal "$parent" "$HOME/.copilot/agents" || return 1
  basename="${comparable##*/}"
  case "$basename" in ap-*.agent.md) return 0 ;; esac
  return 1
}

_vscode_owned_config_path() {
  _idem_paths_equal "$2" "$(vscode_settings_file)"
}

_vibe_owned_path() {
  local root="$1" path="$2" comparable parent basename root_id
  comparable="$(_idem_comparable_path "$path")" || return 1
  root_id="$(_idem_comparable_path "$root")" || return 1
  comparable="${comparable%/}"; root_id="${root_id%/}"
  [ "$comparable" = "$root_id" ] && return 0
  parent="${comparable%/*}"; basename="${comparable##*/}"
  if [ "$parent" = "$root_id" ]; then
    case "$basename" in
      gates.md|modes.md|playbooks.md|readme.md|agents|frameworks|prompts|skills)
        return 0
        ;;
    esac
  fi
  if _idem_paths_equal "$parent" "$root/agents"; then
    case "$basename" in autoprompt.toml|ap-*.toml) return 0 ;; esac
  fi
  if _idem_paths_equal "$parent" "$root/prompts"; then
    case "$basename" in autoprompt.md|ap-*.md) return 0 ;; esac
  fi
  if _idem_paths_equal "$comparable" "$root/frameworks"; then return 0; fi
  if _idem_paths_equal "$parent" "$root/frameworks"; then
    case "$basename" in *.md) return 0 ;; esac
  fi
  _idem_paths_equal "$comparable" "$root/skills" && return 0
  _idem_path_under_root "$comparable" "$root/skills/autoprompt"
}

_legacy_provider_owned_path() {
  local root="$1" provider="$2" path="$3" comparable parent basename
  comparable="$(_idem_comparable_path "$path")" || return 1
  parent="${comparable%/*}"
  basename="${comparable##*/}"
  case "$provider" in
    claude)
      _idem_path_under_root "$path" "$root/.claude/skills/autoprompt" && return 0
      if _idem_paths_equal "$parent" "$root/.claude/agents"; then
        case "$basename" in ap-*.md) return 0 ;; esac
      fi
      ;;
    codex)
      _idem_path_under_root "$path" "$root/skills/autoprompt" && return 0
      _idem_paths_equal "$path" "$root/autoprompt.config.toml" && return 0
      _idem_paths_equal "$path" "$root/config.toml$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX" && return 0
      _idem_paths_equal "$path" "$root/scripts" && return 0
      _idem_paths_equal "$path" "$root/scripts/local-only-safety.cjs" && return 0
      _idem_paths_equal "$path" "$root/skills/contracts" && return 0
      _idem_path_under_root "$path" "$root/skills/contracts" && return 0
      ;;
    cursor)
      _idem_path_under_root "$path" "$root/.cursor/skills/autoprompt" && return 0
      _idem_paths_equal "$path" "$root/.cursor/rules/autoprompt.mdc" && return 0
      ;;
    roo)    _idem_paths_equal "$path" "$root/.roomodes" && return 0 ;;
    gemini) _idem_paths_equal "$path" "$root/.gemini/commands/autoprompt.toml" && return 0 ;;
    cline)  _idem_paths_equal "$path" "$root/.clinerules/autoprompt.md" && return 0 ;;
    goose)
      _idem_paths_equal "$path" "$root/.config/goose/recipes/autoprompt.yaml" && return 0
      _idem_paths_equal "$path" "$root/AGENTS.md" && return 0
      ;;
  esac
  return 1
}

_uninstall_provider_owns_path() {
  local root="$1" provider="$2" path="$3"
  if autoprompt_install_root_override_present; then
    _custom_install_root_owned_path "$root" "$provider" "$path"
    return $?
  fi
  case "$provider" in
    opencode) _opencode_owned_path "$root" "$path" ;;
    kilo) _kilo_owned_path "$root" "$path" ;;
    vscode) _vscode_owned_path "$root" "$path" ;;
    vibe) _vibe_owned_path "$root" "$path" ;;
    omp|deepseek|reasonix)
      _custom_install_root_owned_path "$root" "$provider" "$path"
      ;;
    claude|codex|cursor|roo|gemini|cline|goose)
      _legacy_provider_owned_path "$root" "$provider" "$path"
      ;;
    dcode) return 1 ;;
    *) return 1 ;;
  esac
}

_uninstall_provider_owns_config_path() {
  local root="$1" provider="$2" path="$3"
  if autoprompt_install_root_override_present; then
    [ -z "$AUTOPROMPT_INSTALL_ROOT_CLIENT" ] ||
      [ "$provider" = "$AUTOPROMPT_INSTALL_ROOT_CLIENT" ] || return 1
    case "$provider" in
      opencode) _idem_paths_equal "$path" "$root/autoprompt.opencode.json" ;;
      kilo) _idem_paths_equal "$path" "$root/autoprompt.kilo.json" ;;
      vscode) _idem_paths_equal "$path" "$(vscode_settings_file)" ;;
      codex) _idem_paths_equal "$path" "$root/config.toml" ;;
      omp) _idem_paths_equal "$path" "$root/config.yml" ;;
      reasonix) _idem_paths_equal "$path" "$root/config.toml" ;;
      *) return 1 ;;
    esac
    return $?
  fi
  case "$provider" in
    opencode) _opencode_owned_config_path "$root" "$path" ;;
    kilo) _kilo_owned_config_path "$root" "$path" ;;
    vscode) _vscode_owned_config_path "$root" "$path" ;;
    codex) _idem_paths_equal "$path" "$root/config.toml" ;;
    omp) _idem_paths_equal "$path" "$root/config.yml" ;;
    reasonix) _idem_paths_equal "$path" "$root/config.toml" ;;
    vibe) return 1 ;;
    *) return 1 ;;
  esac
}

_uninstall_provider_owns_directory() {
  local root="$1" provider="$2" path="$3"
  local provider_root="$root/$provider" skills="$root/$provider/skills"
  local skill="$skills/autoprompt" agents="$root/opencode/agents"
  if _uninstall_provider_owns_path "$root" "$provider" "$path"; then
    return 0
  fi
  case "$provider" in
    claude)
      _idem_paths_equal "$path" "$root/.claude" && return 0
      _idem_paths_equal "$path" "$root/.claude/skills" && return 0
      _idem_paths_equal "$path" "$root/.claude/agents" && return 0
      ;;
    codex) _idem_paths_equal "$path" "$root/skills" && return 0 ;;
    cursor)
      _idem_paths_equal "$path" "$root/.cursor" && return 0
      _idem_paths_equal "$path" "$root/.cursor/skills" && return 0
      _idem_paths_equal "$path" "$root/.cursor/rules" && return 0
      ;;
    gemini)
      _idem_paths_equal "$path" "$root/.gemini" && return 0
      _idem_paths_equal "$path" "$root/.gemini/commands" && return 0
      ;;
    cline) _idem_paths_equal "$path" "$root/.clinerules" && return 0 ;;
    goose)
      _idem_paths_equal "$path" "$root/.config/goose" && return 0
      _idem_paths_equal "$path" "$root/.config/goose/recipes" && return 0
      ;;
  esac
  if [ "$provider" = "kilo" ]; then
    _idem_paths_equal "$path" "$HOME/.kilo" && return 0
    _idem_paths_equal "$path" "$HOME/.kilo/skills" && return 0
    _idem_paths_equal "$path" "$HOME/.kilo/skills/autoprompt" && return 0
    _idem_path_under_root "$path" "$HOME/.kilo/skills/autoprompt" && return 0
    _idem_path_under_root "$path" "$provider_root" && return 0
  fi
  if [ "$provider" = "vscode" ]; then
    _idem_paths_equal "$path" "$HOME/.copilot" && return 0
    _idem_paths_equal "$path" "$HOME/.copilot/skills" && return 0
    _idem_paths_equal "$path" "$HOME/.copilot/agents" && return 0
    _idem_path_under_root "$path" "$HOME/.copilot/skills/autoprompt" && return 0
    return 1
  fi
  if [ "$provider" = "vibe" ]; then
    _vibe_owned_path "$root" "$path"
    return $?
  fi
  _idem_paths_equal "$path" "$provider_root" && return 0
  _idem_paths_equal "$path" "$skills" && return 0
  if _idem_paths_equal "$path" "$skill" || _idem_path_under_root "$path" "$skill"; then
    return 0
  fi
  [ "$provider" = "opencode" ] && _idem_paths_equal "$path" "$agents"
}

_uninstall_remove_owned_directories() {
  local root="$1" provider="${2:-}" directory filesystem_directory index insert
  local -a candidates=() ordered=()
  for directory in "${AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES[@]:-}"; do
    [ -n "$directory" ] || continue
    if [ -n "$provider" ] &&
       ! _uninstall_provider_owns_directory "$root" "$provider" "$directory"; then
      continue
    fi
    insert="${#ordered[@]}"
    for ((index = 0; index < ${#ordered[@]}; index++)); do
      [ "${#directory}" -gt "${#ordered[index]}" ] || continue
      insert="$index"
      break
    done
    ordered=("${ordered[@]:0:insert}" "$directory" "${ordered[@]:insert}")
  done
  for directory in "${ordered[@]:-}"; do
    [ -n "$directory" ] || continue
    filesystem_directory="$(_uninstall_filesystem_path "$directory")" || return 1
    [ -d "$filesystem_directory" ] || continue
    [ -z "$(command ls -A -- "$filesystem_directory" 2>/dev/null)" ] || continue
    rmdir -- "$filesystem_directory" 2>/dev/null || return 1
    _idem_remove_receipt_created_directory "$directory"
  done
}

_uninstall_remove_path() {
  local root="$1" path="$2"
  if [ ! -e "$path" ]; then
    printf '%s\n' "uninstall-file=$path note=already-absent"
    return 0
  fi
  if ! rm -f -- "$path" 2>/dev/null; then
    printf '%s\n' "error=file-remove-failed path=$path" >&2
    printf 'Autoprompt uninstall: could not remove %s (permission denied?). Remove it manually and re-run.\n' "$path" >&2
    return 74
  fi
}

_uninstall_load_receipt_accumulators() {
  local f index prior us=$'\037'
  AUTOPROMPT_RECEIPT_FILES=()
  for f in "${UNINSTALL_RC_FILES[@]:-}"; do
    [ -n "$f" ] && AUTOPROMPT_RECEIPT_FILES+=("$f")
  done
  AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=()
  for f in "${UNINSTALL_RC_CREATED_DIRECTORIES[@]:-}"; do
    [ -n "$f" ] && _idem_add_receipt_created_directory "$f"
  done
  AUTOPROMPT_RECEIPT_EDITS=()
  for ((index = 0; index < ${#UNINSTALL_RC_EDIT_FILE[@]}; index++)); do
    prior="${UNINSTALL_RC_EDIT_PRIOR[index]}"
    [ "${UNINSTALL_RC_EDIT_PRIOR_ISNULL[index]}" -eq 0 ] || prior="$AUTOPROMPT_RECEIPT_ABSENT"
    AUTOPROMPT_RECEIPT_EDITS+=(
      "${UNINSTALL_RC_EDIT_FILE[index]}$us${UNINSTALL_RC_EDIT_KEY[index]}$us${UNINSTALL_RC_EDIT_VALUE[index]}$us$prior"
    )
  done
  AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="${UNINSTALL_RC_BACKUP:-none}"
  AUTOPROMPT_RECEIPT_OMP_MANAGED="${UNINSTALL_RC_OMP_MANAGED:-0}"
  AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT="${UNINSTALL_RC_OMP_DETACHED_ROOT:-}"
}

_uninstall_select_provider_edits() {
  local root="$1" provider="$2" index edit_backup filesystem_backup comparable_backup
  local original_backup="$AUTOPROMPT_CONFIGEDIT_LAST_BACKUP"
  local retained_backup="" comparable_original=""
  local -a selected_files=() selected_keys=() selected_values=()
  local -a selected_priors=() selected_nulls=() retained_edits=()
  if [ -n "$original_backup" ] && [ "$original_backup" != "none" ]; then
    comparable_original="$(_idem_comparable_path "$original_backup" 2>/dev/null)" || comparable_original=""
  fi
  for ((index = 0; index < ${#UNINSTALL_RC_EDIT_FILE[@]}; index++)); do
    if _uninstall_provider_owns_config_path "$root" "$provider" "${UNINSTALL_RC_EDIT_FILE[index]}"; then
      selected_files+=("${UNINSTALL_RC_EDIT_FILE[index]}")
      selected_keys+=("${UNINSTALL_RC_EDIT_KEY[index]}")
      selected_values+=("${UNINSTALL_RC_EDIT_VALUE[index]}")
      selected_priors+=("${UNINSTALL_RC_EDIT_PRIOR[index]}")
      selected_nulls+=("${UNINSTALL_RC_EDIT_PRIOR_ISNULL[index]}")
      continue
    fi
    retained_edits+=("${AUTOPROMPT_RECEIPT_EDITS[index]}")
    edit_backup="${UNINSTALL_RC_EDIT_FILE[index]}$AUTOPROMPT_CONFIGEDIT_BACKUP_SUFFIX"
    filesystem_backup="$(_uninstall_filesystem_path "$edit_backup" 2>/dev/null)" || continue
    [ -f "$filesystem_backup" ] || continue
    comparable_backup="$(_idem_comparable_path "$edit_backup" 2>/dev/null)" || comparable_backup=""
    if [ -n "$comparable_original" ] && [ "$comparable_backup" = "$comparable_original" ]; then
      retained_backup="$original_backup"
    elif [ -z "$retained_backup" ]; then
      retained_backup="$edit_backup"
    fi
  done
  AUTOPROMPT_RECEIPT_EDITS=("${retained_edits[@]}")
  UNINSTALL_RC_EDIT_FILE=("${selected_files[@]}")
  UNINSTALL_RC_EDIT_KEY=("${selected_keys[@]}")
  UNINSTALL_RC_EDIT_VALUE=("${selected_values[@]}")
  UNINSTALL_RC_EDIT_PRIOR=("${selected_priors[@]}")
  UNINSTALL_RC_EDIT_PRIOR_ISNULL=("${selected_nulls[@]}")
  AUTOPROMPT_CONFIGEDIT_LAST_BACKUP="${retained_backup:-none}"
}

_uninstall_rollback_provider() {
  local operation_code="$1" state="$AUTOPROMPT_ROOT_TRANSACTION_DIR"
  if _idem_rollback_root_transaction; then
    return "$operation_code"
  fi
  printf '%s\n' "error=uninstall-rollback-failed state=$state" >&2
  printf 'Autoprompt uninstall: rollback failed; recovery state retained at %s. Restore it manually before retrying.\n' "$state" >&2
  return 77
}

_uninstall_snapshot_generic_paths() {
  local root="$1" receipt="$root/$AUTOPROMPT_RECEIPT_NAME" owned path
  for owned in "${AUTOPROMPT_RECEIPT_FILES[@]:-}"; do
    [ -n "$owned" ] || continue
    path="$(_uninstall_filesystem_path "$owned")" || return 1
    if ! _idem_snapshot_root_parent_directories "$root" "$path" ||
       ! _idem_snapshot_root_path "$path"; then
      printf '%s\n' "error=uninstall-snapshot-failed path=$path" >&2
      return 1
    fi
  done
  for owned in "${AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES[@]:-}"; do
    [ -n "$owned" ] || continue
    path="$(_uninstall_filesystem_path "$owned")" || return 1
    if ! _idem_snapshot_root_parent_directories "$root" "$path/owned-entry" ||
       ! _idem_snapshot_root_path "$path"; then
      printf '%s\n' "error=uninstall-snapshot-failed path=$path" >&2
      return 1
    fi
  done
  _idem_snapshot_root_path "$receipt" || {
    printf '%s\n' "error=uninstall-snapshot-failed path=$receipt" >&2
    return 1
  }
}

_uninstall_generic_provider() {
  local root="$1" client="$2" receipt="$root/$AUTOPROMPT_RECEIPT_NAME"
  local removed=0 owned path operation_code
  _uninstall_load_receipt_accumulators
  _idem_begin_root_transaction "$root" || return $?
  if ! _uninstall_snapshot_generic_paths "$root"; then
    _uninstall_rollback_provider 74
    return $?
  fi

  _uninstall_restore_configedits
  operation_code=$?
  if [ "$operation_code" -ne 0 ]; then
    _uninstall_rollback_provider "$operation_code"
    return $?
  fi
  for owned in "${UNINSTALL_RC_FILES[@]:-}"; do
    [ -n "$owned" ] || continue
    path="$(_uninstall_filesystem_path "$owned")" || {
      _uninstall_rollback_provider 74
      return $?
    }
    _uninstall_remove_path "$root" "$path" || {
      operation_code=$?
      _uninstall_rollback_provider "$operation_code"
      return $?
    }
    removed=$((removed + 1))
  done
  if ! _uninstall_remove_owned_directories "$root"; then
    printf '%s\n' "error=directory-remove-failed root=$root" >&2
    _uninstall_rollback_provider 74
    return $?
  fi
  if ! rm -f -- "$receipt" 2>/dev/null; then
    printf '%s\n' "error=receipt-remove-failed path=$receipt" >&2
    printf 'Autoprompt uninstall: could not remove the receipt at %s. Remove it manually and re-run.\n' "$receipt" >&2
    _uninstall_rollback_provider 74
    return $?
  fi
  _idem_commit_root_transaction || {
    _uninstall_rollback_provider 77
    return $?
  }
  printf '%s\n' "client=$client uninstall=ok removed=$removed restored-edits=${UNINSTALL_RESTORED_EDIT_FILES:-0}"
}

_uninstall_collect_provider_paths() {
  local root="$1" provider="$2" manifest="$3"
  local remove_name="$4" retained_name="$5" file path
  local -n remove_paths_ref="$remove_name" retained_files_ref="$retained_name"
  for file in "${UNINSTALL_RC_FILES[@]:-}"; do
    [ -z "$file" ] && continue
    _idem_paths_equal "$file" "$manifest" && continue
    if ! _uninstall_provider_owns_path "$root" "$provider" "$file"; then
      retained_files_ref+=("$file")
      continue
    fi
    remove_paths_ref+=("$file")
    path="$(_uninstall_filesystem_path "$file")" || return 74
    _idem_snapshot_root_path "$path" || return 74
  done
}

_uninstall_remove_provider_paths() {
  local root="$1" paths_name="$2" removed_name="$3" retained_name="$4" provider="$5"
  local file path operation_code recorded_hash live_hash reason
  local -n remove_paths_ref="$paths_name" removed_count_ref="$removed_name"
  local -n retained_count_ref="$retained_name"
  for file in "${remove_paths_ref[@]}"; do
    path="$(_uninstall_filesystem_path "$file")" || return 74
    if [ "$provider" = codex ]; then
      recorded_hash=""
      _idem_read_manifest_hash "$root" "$file" recorded_hash || return 74
      reason=""
      if [ ! -e "$path" ] && [ ! -L "$path" ]; then
        _idem_remove_manifest_hash "$root" "$file" || return 74
        printf '%s\n' "uninstall-file=$file note=already-absent"
        continue
      elif [ -L "$path" ] || [ ! -f "$path" ]; then
        reason=linked-or-unsafe
      elif [ -z "$recorded_hash" ]; then
        reason=unfingerprinted
      else
        live_hash="$(_idem_sha256 "$path")" || reason=hash-unreadable
        [ -n "$reason" ] || [ "$live_hash" = "$recorded_hash" ] || reason=hash-drift
      fi
      if [ -n "$reason" ]; then
        printf '%s\n' \
          "uninstall-retained=$file reason=$reason ownership=relinquished"
        _idem_remove_manifest_hash "$root" "$file" || return 74
        retained_count_ref=$((retained_count_ref + 1))
        continue
      fi
    fi
    _uninstall_remove_path "$root" "$path" || {
      operation_code=$?
      return "$operation_code"
    }
    _idem_remove_manifest_hash "$root" "$file" || return 74
    removed_count_ref=$((removed_count_ref + 1))
  done
}

_uninstall_seal_provider_receipt() {
  local root="$1" manifest="$2" receipt="$3"
  if [ "${#AUTOPROMPT_RECEIPT_FILES[@]}" -eq 0 ] &&
     [ "${#AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES[@]}" -eq 0 ] &&
     [ "${#AUTOPROMPT_RECEIPT_EDITS[@]}" -eq 0 ]; then
    rm -f -- "$manifest" "$receipt" 2>/dev/null
    return $?
  fi
  [ -f "$manifest" ] && AUTOPROMPT_RECEIPT_FILES+=("$manifest")
  write_receipt "$root" "${UNINSTALL_RC_NONCE:-uninstall-retained}" \
    "${AUTOPROMPT_CONFIGEDIT_LAST_BACKUP:-}" >/dev/null
}

_uninstall_shared_provider() {
  local root="$1" provider="$2" operation_code removed=0 retained=0 directory
  local manifest="$root/$AUTOPROMPT_HASH_MANIFEST_NAME"
  local receipt="$root/$AUTOPROMPT_RECEIPT_NAME"
  local -a remove_paths=() retained_files=() retained_directories=()
  _uninstall_load_receipt_accumulators
  _idem_begin_root_transaction "$root" || return $?
  _uninstall_collect_provider_paths \
    "$root" "$provider" "$manifest" remove_paths retained_files || {
    _uninstall_rollback_provider 74
    return $?
  }
  for directory in "${AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES[@]}"; do
    _uninstall_provider_owns_directory "$root" "$provider" "$directory" ||
      retained_directories+=("$directory")
  done
  _uninstall_select_provider_edits "$root" "$provider"
  _uninstall_restore_configedits; operation_code=$?
  if [ "$operation_code" -ne 0 ]; then
    _uninstall_rollback_provider "$operation_code"
    return $?
  fi
  AUTOPROMPT_RECEIPT_FILES=("${retained_files[@]}")
  _uninstall_remove_provider_paths "$root" remove_paths removed retained "$provider" || {
    operation_code=$?
    _uninstall_rollback_provider "$operation_code"
    return $?
  }
  _uninstall_remove_owned_directories "$root" "$provider" || {
    _uninstall_rollback_provider 74
    return $?
  }
  AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=("${retained_directories[@]}")
  if [ "$provider" = omp ]; then
    AUTOPROMPT_RECEIPT_OMP_MANAGED=0
    AUTOPROMPT_RECEIPT_OMP_DETACHED_ROOT=""
  fi
  _uninstall_seal_provider_receipt "$root" "$manifest" "$receipt" || {
    _uninstall_rollback_provider 74
    return $?
  }
  _idem_commit_root_transaction || {
    _uninstall_rollback_provider 77
    return $?
  }
  if [ "$provider" = codex ]; then
    printf '%s\n' "client=$provider uninstall=ok removed=$removed retained=$retained restored-edits=${UNINSTALL_RESTORED_EDIT_FILES:-0}"
  else
    printf '%s\n' "client=$provider uninstall=ok removed=$removed restored-edits=${UNINSTALL_RESTORED_EDIT_FILES:-0}"
  fi
}

uninstall_client() {
  local root="$1" client="$2"
  if [ -z "$root" ]; then
    printf '%s\n' "error=no-config-root" >&2
    printf 'Autoprompt uninstall: a config-root is required (the directory holding the install receipt).\n' >&2
    return 70
  fi
  _uninstall_read_receipt "$root" || return $?
  case "$client" in
    claude|codex|opencode|kilo|vscode|vibe|cursor|dcode|roo|gemini|cline|goose|omp|deepseek|reasonix)
      _uninstall_shared_provider "$root" "$client"
      return $?
      ;;
  esac
  _uninstall_generic_provider "$root" "$client"
}

declare -a AUTOPROMPT_REPAIR_LIVE_PATHS=()
declare -a AUTOPROMPT_REPAIR_STAGE_PATHS=()

_repair_stage_runtime_inventory() {
  local client="$1" stage_skill="$2" live_skill="$3" inventory relative
  local tool="$AUTOPROMPT_INSTALL_REPO_ROOT/scripts/runtime-payload.cjs"
  command -v node >/dev/null 2>&1 && [ -f "$tool" ] || return 1
  node "$tool" --install "$client" --destination "$stage_skill" \
    >/dev/null || return 1
  node "$tool" --verify "$client" --destination "$stage_skill" \
    >/dev/null || return 1
  inventory="$(node "$tool" --list "$client")" || return 1
  while IFS= read -r relative; do
    [ -z "$relative" ] && continue
    AUTOPROMPT_REPAIR_LIVE_PATHS+=("$live_skill/$relative")
    AUTOPROMPT_REPAIR_STAGE_PATHS+=("$stage_skill/$relative")
  done <<< "$inventory"
}

_repair_add_native_candidates() {
  local client="$1" root="$2" stage_skill="$3" generated profile had_nullglob
  local native_agents
  case "$(shopt nullglob)" in *on) had_nullglob=1 ;; *) had_nullglob=0 ;; esac
  shopt -s nullglob
  if [ "$client" = "claude" ]; then
    for generated in "$stage_skill"/agents/ap-*.md; do
      AUTOPROMPT_REPAIR_LIVE_PATHS+=("$(autoprompt_native_agents_root claude)/${generated##*/}")
      AUTOPROMPT_REPAIR_STAGE_PATHS+=("$generated")
    done
  elif [ "$client" = "opencode" ] || [ "$client" = "kilo" ]; then
    for generated in "$stage_skill"/agents/ap-*.md; do
      AUTOPROMPT_REPAIR_LIVE_PATHS+=("$(autoprompt_native_agents_root "$client")/${generated##*/}")
      AUTOPROMPT_REPAIR_STAGE_PATHS+=("$generated")
    done
    if [ "$client" = "kilo" ]; then
      AUTOPROMPT_REPAIR_LIVE_PATHS+=("$(autoprompt_profile_file kilo)")
      AUTOPROMPT_REPAIR_STAGE_PATHS+=("$stage_skill/autoprompt.kilo.json")
    else
      AUTOPROMPT_REPAIR_LIVE_PATHS+=("$(autoprompt_profile_file opencode)")
      AUTOPROMPT_REPAIR_STAGE_PATHS+=("$stage_skill/autoprompt.opencode.json")
    fi
  elif [ "$client" = "omp" ]; then
    if [ -n "${UNINSTALL_RC_OMP_DETACHED_ROOT:-}" ]; then
      native_agents="${UNINSTALL_RC_OMP_DETACHED_ROOT//\\//}/agents"
    else
      native_agents="$(autoprompt_native_agents_root omp)" || return 1
    fi
    for generated in "$stage_skill"/agents/ap-*.md; do
      AUTOPROMPT_REPAIR_LIVE_PATHS+=("$native_agents/${generated##*/}")
      AUTOPROMPT_REPAIR_STAGE_PATHS+=("$generated")
    done
  elif [ "$client" = "deepseek" ]; then
    for generated in "$stage_skill"/agent-preset/agent.cordis.yml \
                     "$stage_skill"/agent-preset/preset.yml; do
      [ -f "$generated" ] || continue
      AUTOPROMPT_REPAIR_LIVE_PATHS+=("$root/.agent-presets/autoprompt/${generated##*/}")
      AUTOPROMPT_REPAIR_STAGE_PATHS+=("$generated")
    done
  elif [ "$client" = "reasonix" ]; then
    for generated in "$stage_skill"/skills/ap-*/SKILL.md; do
      profile="${generated%/*}"
      profile="${profile##*/}"
      AUTOPROMPT_REPAIR_LIVE_PATHS+=("$root/skills/$profile/SKILL.md")
      AUTOPROMPT_REPAIR_STAGE_PATHS+=("$generated")
    done
  fi
  [ "$had_nullglob" -eq 0 ] && shopt -u nullglob
}

_repair_stage_codex_candidates() {
  local root="$1" live_skill="$2" stage="$3" stage_skill="$4"
  local source_agents="$AUTOPROMPT_INSTALL_REPO_ROOT/agents/codex/agents"
  local casting_tool="$stage_skill/workflow/codex-agent-casting.js"
  local profile_tool="$stage_skill/workflow/codex-agent-profile.js"
  local generation stage_layout_root stage_agents stage_profile generated had_nullglob expected_count
  generation="$(autoprompt_codex_payload_generation)" || return 1
  stage_layout_root="$stage/root"
  stage_agents="$stage_layout_root/.autoprompt-private/bundles/$generation/skills/autoprompt/agents-runtime"
  stage_profile="$stage_layout_root/autoprompt.config.toml"
  mkdir -p -- "$stage_agents" || return 1
  local generated_count=0 generated_role
  for generated_role in "$source_agents"/ap-*.toml; do
    [ -f "$generated_role" ] || continue
    cp -- "$generated_role" "$stage_agents/${generated_role##*/}" || return 1
    generated_count=$((generated_count + 1))
  done
  expected_count="$(node -e '
    const fs = require("node:fs");
    const policy = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(Object.keys(policy.physical_roles || {}).length));
  ' "$stage_skill/agents/role-policy.json")" || return 1
  [ "$expected_count" -gt 0 ] 2>/dev/null && \
    [ "$generated_count" -eq "$expected_count" ] || return 1
  CODEX_AGENTS_DIR="$stage_agents" node "$casting_tool" --write-manifest \
    --agents-dir "$stage_agents" --selector off >/dev/null || return 1
  node "$profile_tool" --write --agents-dir "$stage_agents" \
    --profile "$stage_profile" >/dev/null || return 1
  CODEX_AGENTS_DIR="$stage_agents" node "$casting_tool" --resolve \
    --agents-dir "$stage_agents" --selector off >/dev/null || return 1
  node "$profile_tool" --verify --agents-dir "$stage_agents" \
    --profile "$stage_profile" >/dev/null || return 1
  case "$(shopt nullglob)" in *on) had_nullglob=1 ;; *) had_nullglob=0 ;; esac
  shopt -s nullglob
  for generated in "$stage_agents"/ap-*.toml \
                   "$stage_agents"/.autoprompt-casting.json; do
    AUTOPROMPT_REPAIR_LIVE_PATHS+=("$live_skill/agents-runtime/${generated##*/}")
    AUTOPROMPT_REPAIR_STAGE_PATHS+=("$generated")
  done
  [ "$had_nullglob" -eq 0 ] && shopt -u nullglob
  AUTOPROMPT_REPAIR_LIVE_PATHS+=("$root/autoprompt.config.toml")
  AUTOPROMPT_REPAIR_STAGE_PATHS+=("$stage_profile")
}

_repair_stage_managed_payload() {
  local client="$1" root="$2" landed="$3" stage="$4"
  local stage_skill="$stage/skills/autoprompt" live_skill="${landed%/*}"
  AUTOPROMPT_REPAIR_LIVE_PATHS=()
  AUTOPROMPT_REPAIR_STAGE_PATHS=()
  case "$client" in
    claude|codex|opencode|kilo|omp|deepseek|reasonix) ;;
    *) return 0 ;;
  esac
  _repair_stage_runtime_inventory \
    "$client" "$stage_skill" "$live_skill" || return 1
  _repair_add_native_candidates "$client" "$root" "$stage_skill"
  [ "$client" = "codex" ] || return 0
  _repair_stage_codex_candidates \
    "$root" "$live_skill" "$stage" "$stage_skill"
}

_repair_new_provider_owns_path() {
  local root="$1" client="$2" file="$3" parent leaf profile
  if _idem_path_under_root "$file" "$root/skills/autoprompt"; then
    return 0
  fi
  parent="${file%/*}"
  leaf="${file##*/}"
  case "$client" in
    omp)
      if [ -n "${UNINSTALL_RC_OMP_DETACHED_ROOT:-}" ]; then
        local detached_root="${UNINSTALL_RC_OMP_DETACHED_ROOT//\\//}"
        _uninstall_omp_detached_receipt_path_allowed \
          "$detached_root" "$file" || return 1
        _idem_paths_equal \
          "$parent" "$detached_root/agents" || return 1
      else
        [ "${UNINSTALL_RC_OMP_MANAGED:-0}" -eq 1 ] || return 1
        _idem_paths_equal "$parent" "$root/agents" || return 1
      fi
      case "$leaf" in ap-*.md) return 0 ;; *) return 1 ;; esac
      ;;
    deepseek)
      _idem_paths_equal "$parent" "$root/.agent-presets/autoprompt" || return 1
      case "$leaf" in agent.cordis.yml|preset.yml) return 0 ;; *) return 1 ;; esac
      ;;
    reasonix)
      [ "$leaf" = "SKILL.md" ] || return 1
      profile="${parent##*/}"
      case "$profile" in ap-*) ;; *) return 1 ;; esac
      _idem_paths_equal "$parent" "$root/skills/$profile"
      ;;
    *) return 1 ;;
  esac
}

_repair_candidate_source() {
  local target="$1" index
  for ((index = 0; index < ${#AUTOPROMPT_REPAIR_LIVE_PATHS[@]}; index++)); do
    _idem_paths_equal "${AUTOPROMPT_REPAIR_LIVE_PATHS[index]}" "$target" && {
      printf '%s' "${AUTOPROMPT_REPAIR_STAGE_PATHS[index]}"
      return 0
    }
  done
  return 1
}

_repair_render_payload_hash() {
  local client="$1" fmt="$2" name="$3" description="$4" body="$5" output_name="$6"
  local -n payload_hash_ref="$output_name"
  local stage render_code hash hash_code
  stage="$(mktemp 2>/dev/null)" || {
    printf '%s\n' "client=$client error=repair-stage-failed" >&2
    return 73
  }
  format_skill "$fmt" "$name" "$description" "$body" > "$stage"
  render_code=$?
  if [ "$render_code" -ne 0 ]; then rm -f "$stage" 2>/dev/null; return "$render_code"; fi
  hash="$(_idem_sha256 "$stage")"; hash_code=$?
  rm -f "$stage" 2>/dev/null
  [ "$hash_code" -eq 0 ] || return "$hash_code"
  payload_hash_ref="$hash"
}

_repair_prepare_request() {
  local root="$1" client="$2" name="$3" description="$4" body="$5" variant="$6"
  local landed_name="$7" hash_name="$8" rec resolve_code destpath fmt
  local -n prepared_landed="$landed_name"
  if [ -z "$root" ]; then printf '%s\n' "error=no-config-root" >&2; return 70; fi
  _uninstall_read_receipt "$root" || return $?
  rec="$(resolve_destination "$client" "$variant")"; resolve_code=$?
  [ "$resolve_code" -eq 0 ] || return "$resolve_code"
  destpath="${rec#client=* dest=}"; destpath="${destpath% format=*}"
  fmt="${rec##* format=}"
  case "$destpath" in */) prepared_landed="${destpath}SKILL.md" ;; *) prepared_landed="$destpath" ;; esac
  _repair_render_payload_hash "$client" "$fmt" "$name" "$description" \
    "$body" "$hash_name"
}

_repair_should_process_file() {
  local root="$1" client="$2" file="$3"
  _idem_paths_equal "$file" "$root/$AUTOPROMPT_HASH_MANIFEST_NAME" && return 1
  case "$client" in
    omp|deepseek|reasonix)
      _repair_new_provider_owns_path "$root" "$client" "$file"
      ;;
    *)
      _uninstall_provider_owns_path "$root" "$client" "$file"
      ;;
  esac
}

_repair_read_file_state() {
  local root="$1" client="$2" file="$3" recorded_name="$4"
  local filesystem_name="$5" live_name="$6"
  local -n recorded_ref="$recorded_name" filesystem_ref="$filesystem_name"
  local -n live_ref="$live_name"
  if ! _idem_read_manifest_hash "$root" "$file" recorded_ref; then
    printf '%s\n' "client=$client error=hash-manifest-read-failed path=$root/$AUTOPROMPT_HASH_MANIFEST_NAME" >&2
    return 73
  fi
  [ -n "$recorded_ref" ] || return 0
  filesystem_ref="$(_uninstall_filesystem_path "$file")" || {
    printf '%s\n' "client=$client repair=failed dest=$file reason=path-conversion-failed" >&2
    return 73
  }
  if [ -f "$filesystem_ref" ]; then
    live_ref="$(_idem_sha256 "$filesystem_ref")" || return 42
  fi
}

_repair_restore_main_skill() {
  local root="$1" client="$2" name="$3" description="$4" body="$5" variant="$6"
  local file="$7" payload_hash="$8" recorded_hash="$9" install_code
  if [ "$payload_hash" != "$recorded_hash" ]; then
    printf '%s\n' "client=$client repair=refused dest=$file recorded=$recorded_hash would-be=$payload_hash reason=payload-mismatch" >&2
    printf 'Autoprompt repair: the supplied payload renders to %s but the recorded hash is %s for %s - refusing to write (supply the matching payload).\n' "$payload_hash" "$recorded_hash" "$file" >&2
    return 76
  fi
  install_idempotent "$root" "$client" "$name" "$description" "$body" "$variant" >/dev/null
  install_code=$?
  if [ "$install_code" -ne 0 ]; then
    printf '%s\n' "client=$client repair=failed dest=$file reason=delegate-rc=$install_code" >&2
    return 73
  fi
}

_repair_restore_extra_file() {
  local client="$1" root="$2" landed="$3" file="$4" recorded_hash="$5"
  local filesystem_path="$6" stage_name="$7" candidate source_hash
  local -n candidate_stage_ref="$stage_name"
  if [ -z "$candidate_stage_ref" ]; then
    candidate_stage_ref="$(mktemp -d 2>/dev/null)" || {
      printf '%s\n' "client=$client error=repair-stage-failed" >&2
      return 73
    }
    if ! _repair_stage_managed_payload "$client" "$root" "$landed" "$candidate_stage_ref"; then
      printf '%s\n' "client=$client repair=failed reason=candidate-stage-failed" >&2
      return 73
    fi
  fi
  candidate="$(_repair_candidate_source "$file")" || true
  if [ -z "$candidate" ] || [ ! -f "$candidate" ]; then
    printf '%s\n' "client=$client repair=refused dest=$file recorded=$recorded_hash reason=cannot-remint-non-skill" >&2
    return 76
  fi
  source_hash="$(_idem_sha256 "$candidate")" || return 42
  if [ "$source_hash" != "$recorded_hash" ]; then
    printf '%s\n' "client=$client repair=refused dest=$file recorded=$recorded_hash would-be=$source_hash reason=payload-mismatch" >&2
    return 76
  fi
  if ! _idem_atomic_copy "$candidate" "$filesystem_path"; then
    printf '%s\n' "client=$client repair=failed dest=$file reason=restore-write-failed" >&2
    return 73
  fi
}

_repair_restore_file() {
  local root="$1" client="$2" name="$3" description="$4" body="$5" variant="$6"
  local landed="$7" payload_hash="$8" file="$9" recorded_hash="${10}"
  local filesystem_path="${11}" stage_name="${12}" reason=hash-drift post_hash
  [ -f "$filesystem_path" ] || reason=missing-file
  if _idem_paths_equal "$file" "$landed"; then
    _repair_restore_main_skill "$root" "$client" "$name" "$description" \
      "$body" "$variant" "$file" "$payload_hash" "$recorded_hash" || return $?
  else
    _repair_restore_extra_file "$client" "$root" "$landed" "$file" \
      "$recorded_hash" "$filesystem_path" "$stage_name" || return $?
  fi
  post_hash="$(_idem_sha256 "$filesystem_path")" || return 42
  if [ "$post_hash" != "$recorded_hash" ]; then
    printf '%s\n' "client=$client repair=failed dest=$file recorded=$recorded_hash post=$post_hash reason=post-write-mismatch" >&2
    return 73
  fi
  printf '%s\n' "client=$client repair=restored dest=$file hash=$post_hash reason=$reason"
}

_repair_process_file() {
  local root="$1" client="$2" name="$3" description="$4" body="$5" variant="$6"
  local landed="$7" payload_hash="$8" file="$9" stage_name="${10}"
  local restored_name="${11}" ok_name="${12}" unfingerprinted_name="${13}"
  local -n restored_ref="$restored_name" ok_ref="$ok_name"
  local -n unfingerprinted_ref="$unfingerprinted_name"
  local recorded_hash="" filesystem_path="" live_hash=""
  _repair_should_process_file "$root" "$client" "$file" || return 0
  _repair_read_file_state "$root" "$client" "$file" recorded_hash \
    filesystem_path live_hash || return $?
  if [ -z "$recorded_hash" ]; then
    printf '%s\n' "client=$client repair=unfingerprinted dest=$file"
    unfingerprinted_ref=$((unfingerprinted_ref + 1))
    return 0
  fi
  if [ "$live_hash" = "$recorded_hash" ]; then
    printf '%s\n' "client=$client repair=ok dest=$file hash=$recorded_hash"
    ok_ref=$((ok_ref + 1))
    return 0
  fi
  _repair_restore_file "$root" "$client" "$name" "$description" "$body" \
    "$variant" "$landed" "$payload_hash" "$file" "$recorded_hash" \
    "$filesystem_path" "$stage_name" || return $?
  restored_ref=$((restored_ref + 1))
}

_repair_persist_inferred_omp_receipt() {
  local root="$1" client="$2"
  [ "$client" = omp ] || return 0
  if [ "${UNINSTALL_RC_OMP_MANAGED_INFERRED:-0}" -ne 1 ] &&
     [ "${UNINSTALL_RC_OMP_DETACHED_ROOT_INFERRED:-0}" -ne 1 ]; then
    return 0
  fi
  [ "${UNINSTALL_RC_OMP_MANAGED:-0}" -eq 1 ] || return 73
  # Rebuild the receipt from the fully validated parser state.  This preserves
  # every recorded path/edit spelling and manifest-owned file while adding only
  # the OMP provider/layout authority inferred from legacy ownership evidence.
  _uninstall_load_receipt_accumulators
  if ! write_receipt "$root" "${UNINSTALL_RC_NONCE:-repair-migrated}" \
       "${UNINSTALL_RC_BACKUP:-}" >/dev/null; then
    printf '%s\n' \
      "client=$client repair=failed reason=omp-receipt-migration-failed" >&2
    return 73
  fi
}

uninstall_repair() {
  local root="$1" client="$2" name="$3" description="$4" body="$5" variant="${6:-}"
  local landed payload_hash candidate_stage="" restored=0 ok=0 unfingerprinted=0
  local file repair_code
  _repair_prepare_request "$root" "$client" "$name" "$description" "$body" \
    "$variant" landed payload_hash || return $?
  for file in "${UNINSTALL_RC_FILES[@]:-}"; do
    [ -n "$file" ] || continue
    _repair_process_file "$root" "$client" "$name" "$description" "$body" \
      "$variant" "$landed" "$payload_hash" "$file" candidate_stage \
      restored ok unfingerprinted
    repair_code=$?
    if [ "$repair_code" -ne 0 ]; then
      [ -z "$candidate_stage" ] || rm -rf -- "$candidate_stage" 2>/dev/null
      return "$repair_code"
    fi
  done
  [ -z "$candidate_stage" ] || rm -rf -- "$candidate_stage" 2>/dev/null
  _repair_persist_inferred_omp_receipt "$root" "$client" || return $?
  printf '%s\n' "client=$client repair=done restored=$restored ok=$ok unfingerprinted=$unfingerprinted"
}
# --- F-LIB-UNINSTALL (end) ---

# --- F-LIB-EXTRAS (begin) ---
AUTOPROMPT_VSCODE_ACTIVATION_KEY='chat.subagents.allowInvocationsFromSubagents'

vscode_settings_file() {
  if [ -n "${AUTOPROMPT_VSCODE_SETTINGS_PATH:-}" ]; then
    printf '%s' "$AUTOPROMPT_VSCODE_SETTINGS_PATH"
    return 0
  fi
  local platform
  platform="$(uname -s 2>/dev/null || printf unknown)"
  case "$platform" in
    Darwin*) printf '%s/Library/Application Support/Code/User/settings.json' "$HOME" ;;
    MINGW*|MSYS*|CYGWIN*)
      printf '%s/Code/User/settings.json' "${APPDATA:-$HOME/AppData/Roaming}"
      ;;
    *) printf '%s/Code/User/settings.json' "${XDG_CONFIG_HOME:-$HOME/.config}" ;;
  esac
}

vscode_settings_helper() {
  printf '%s/scripts/install/vscode-settings.cjs' "$AUTOPROMPT_INSTALL_REPO_ROOT"
}

vscode_settings_status() {
  local helper settings
  helper="$(vscode_settings_helper)"
  settings="$(vscode_settings_file)"
  [ -f "$helper" ] && command -v node >/dev/null 2>&1 || {
    printf '%s\n' 'status=activation-missing reason=settings-helper-unavailable'
    return 3
  }
  node "$helper" inspect --file "$settings"
}

validate_kilo_profile() {
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
      and profile['$schema'] == 'https://app.kilo.ai/config.json'
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

kilo_config_dir() {
  printf '%s/kilo' "${XDG_CONFIG_HOME:-$HOME/.config}"
}

kilo_agents_dir() {
  printf '%s/agents' "$(kilo_config_dir)"
}

kilo_profile_file() {
  printf '%s/autoprompt.kilo.json' "$(kilo_config_dir)"
}

# install_extras delegates the package boundary to scripts/runtime-payload.cjs. The
# checked-in provider manifest is the only inventory, and the helper verifies source
# hashes, copies exact managed bytes without pruning sibling files, and verifies the
# landed payload before returning. Every exact destination is hash- and receipt-owned.
_extras_rollback_changes() {
  local client="$1" root="$2" journal_start="$3"
  _idem_root_transaction_matches "$root" && return 0
  _idem_undo_managed_changes "$journal_start" >/dev/null && return 0
  printf '%s\n' "client=$client error=extras-rollback-failed state=retained" >&2
  return 85
}

_extras_stage_payload() {
  local tool="$1" client="$2" stage="$3" inventory_name="$4" inventory_text
  local -n published_inventory="$inventory_name"
  local runtime_destination="$stage"
  [ "$client" != codex ] || runtime_destination="$stage/skills/autoprompt"
  node "$tool" --install "$client" --destination "$runtime_destination" >/dev/null || return 1
  node "$tool" --verify "$client" --destination "$runtime_destination" >/dev/null || return 1
  if [ "$client" = codex ]; then
    inventory_text="$(node -e '
      const runtime = require(process.argv[1]);
      const plan = runtime.installationPlan("codex", process.argv[2]);
      for (const item of plan.files) {
        if (item.kind === "discovery-shim") continue;
        if (/[\t\r\n]/.test(item.receiptPath) || /[\t\r\n]/.test(item.target)) process.exit(2);
        process.stdout.write(`${item.receiptPath}\t${item.target}\n`);
      }
    ' "$tool" "$runtime_destination")" || return 1
  else
    inventory_text="$(node "$tool" --list "$client")" || return 1
  fi
  published_inventory="$inventory_text"
}

_extras_install_inventory() {
  local root="$1" stage="$2" skilldest="$3" inventory="$4"
  local landed_name="$5" agents_name="$6" stable_source="${7:-0}"
  local before_copy="${8:-}" relative receipt candidate target copy_rc
  local -n landed_count="$landed_name" agent_count="$agents_name"
  while IFS= read -r relative; do
    [ -z "$relative" ] && continue
    if [[ "$relative" == *$'\t'* ]]; then
      receipt="${relative%%$'\t'*}"
      candidate="${relative#*$'\t'}"
      case "/$receipt/" in
        /*/../*|/*/./*|//*|*/../*|*/./*) return 82 ;;
      esac
      target="$root/$receipt"
    else
      receipt="$relative"
      candidate="$stage/$relative"
      target="$skilldest/$relative"
    fi
    if [ ! -f "$candidate" ]; then
      return 82
    fi
    _idem_install_managed_file \
      "$root" "$candidate" "$target" 1 1 0 "$stable_source" "$before_copy"
    copy_rc=$?
    [ "$copy_rc" -eq 0 ] || return "$copy_rc"
    landed_count=$((landed_count + 1))
    case "$receipt" in
      agents/*|*/skills/autoprompt/agents/ap-*.toml) agent_count=$((agent_count + 1)) ;;
    esac
  done <<< "$inventory"
}

_extras_install_native_personas() {
  local root="$1" stage="$2" native_dest="$3" count_name="$4"
  local persona had_nullglob managed_code
  local -n native_count="$count_name"
  [ -d "$stage/agents" ] || return 82
  case "$(shopt nullglob)" in *on) had_nullglob=1 ;; *) had_nullglob=0 ;; esac
  shopt -s nullglob
  for persona in "$stage"/agents/ap-*.md; do
    [ -f "$persona" ] || continue
    _idem_install_managed_file \
      "$root" "$persona" "$native_dest/${persona##*/}" 1
    managed_code=$?
    if [ "$managed_code" -ne 0 ]; then
      EXTRAS_FAILED_NATIVE_PATH="$native_dest/${persona##*/}"
      [ "$had_nullglob" -eq 0 ] && shopt -u nullglob
      return 83
    fi
    native_count=$((native_count + 1))
  done
  [ "$had_nullglob" -eq 0 ] && shopt -u nullglob
  [ "$native_count" -eq 25 ] || return 86
}

_extras_resolve_native_destination() {
  local client="$1" agentsdest="$2" output_name="$3"
  local -n native_destination_ref="$output_name"
  [ -n "$agentsdest" ] || return 0
  case "$client" in
    claude|vscode|omp)
      native_destination_ref="$(autoprompt_native_agents_root "$client")" || return 3
      ;;
    *) native_destination_ref="" ;;
  esac
  [ "$agentsdest" = "$native_destination_ref" ] || return 84
}

_extras_prepare_install() {
  local client="$1" srcdir="$2" skilldest="$3" agentsdest="$4"
  local root_name="$5" native_name="$6" tool_name="$7" resolve_code
  local -n resolved_root_ref="$root_name" native_destination_ref="$native_name"
  local -n runtime_tool_ref="$tool_name"
  if [ -z "$srcdir" ] || [ ! -d "$srcdir" ]; then
    printf '%s\n' "client=$client error=extras-no-src-dir dir=$srcdir" >&2
    return 80
  fi
  if [ -z "$skilldest" ]; then
    printf '%s\n' "client=$client error=extras-no-skill-dest" >&2
    return 81
  fi
  _extras_resolve_native_destination \
    "$client" "$agentsdest" "$native_name"; resolve_code=$?
  if [ "$resolve_code" -eq 84 ]; then
    printf '%s\n' "client=$client error=extras-unsafe-agents-dest dest=$agentsdest expected=$native_destination_ref" >&2
    return 84
  fi
  [ "$resolve_code" -eq 0 ] || return "$resolve_code"
  runtime_tool_ref="$AUTOPROMPT_INSTALL_REPO_ROOT/scripts/runtime-payload.cjs"
  if [ ! -f "$runtime_tool_ref" ] || ! command -v node >/dev/null 2>&1; then
    printf '%s\n' "client=$client error=extras-runtime-tool-unavailable path=$runtime_tool_ref" >&2
    return 82
  fi
  [ -n "$resolved_root_ref" ] && return 0
  case "$client" in
    claude) resolved_root_ref="${skilldest%/.claude/skills/autoprompt}" ;;
    codex) resolved_root_ref="${skilldest%/skills/autoprompt}" ;;
    *) resolved_root_ref="${skilldest%/*}" ;;
  esac
}

install_extras() {
  local client="$1" srcdir="$2" skilldest="$3" agentsdest="${4:-}" root="${5:-}"
  local native_destdir="" tool="" stage inventory="" copy_code native_code
  local landed=0 agents=0 natives=0 journal_start stable_source=0
  _extras_prepare_install "$client" "$srcdir" "$skilldest" "$agentsdest" \
    root native_destdir tool || return $?
  journal_start="${#AUTOPROMPT_MANAGED_UNDO_JOURNAL[@]}"
  stage="$(mktemp -d 2>/dev/null)" || {
    printf '%s\n' "client=$client error=extras-copy-failed" >&2; return 83
  }
  if ! _extras_stage_payload "$tool" "$client" "$stage" inventory; then
    rm -rf -- "$stage" 2>/dev/null
    printf '%s\n' "client=$client error=extras-copy-failed" >&2; return 83
  fi
  [ "$client" != codex ] || stable_source=1
  _extras_install_inventory "$root" "$stage" "$skilldest" \
    "$inventory" landed agents "$stable_source"; copy_code=$?
  if [ "$copy_code" -ne 0 ]; then
    rm -rf -- "$stage" 2>/dev/null
    _extras_rollback_changes "$client" "$root" "$journal_start" || return 85
    if [ "$copy_code" -eq 46 ]; then return 46; fi
    printf '%s\n' "client=$client error=extras-copy-failed code=$copy_code" >&2; return 83
  fi
  if [ -n "$native_destdir" ]; then
    EXTRAS_FAILED_NATIVE_PATH=""
    _extras_install_native_personas \
      "$root" "$stage" "$native_destdir" natives; native_code=$?
    if [ "$native_code" -ne 0 ]; then
      rm -rf -- "$stage" 2>/dev/null
      _extras_rollback_changes "$client" "$root" "$journal_start" || return 85
      case "$native_code" in
        82) printf '%s\n' "client=$client error=extras-required-source-missing path=$srcdir/agents" >&2 ;;
        86) printf '%s\n' "client=$client error=extras-required-source-missing path=$srcdir/agents/ap-*.md" >&2 ;;
        *) printf '%s\n' "client=$client error=extras-copy-failed path=$EXTRAS_FAILED_NATIVE_PATH" >&2 ;;
      esac
      [ "$native_code" -eq 83 ] && return 83 || return 82
    fi
  fi
  rm -rf -- "$stage" 2>/dev/null
  if ! _idem_root_transaction_matches "$root" &&
     ! _idem_complete_managed_changes "$journal_start"; then
    printf '%s\n' "client=$client error=extras-cleanup-failed state=retained" >&2; return 85
  fi
  printf '%s\n' "client=$client extras=ok files=$landed agents=$agents native=$natives"
}
# --- F-LIB-EXTRAS (end) ---
