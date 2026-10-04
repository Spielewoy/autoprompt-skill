#!/usr/bin/env bash
# Private v2 package routing shared by the public POSIX entrypoints.
is_harness_v2() {
  case "$1" in claude|opencode|kilo|vscode|prime|omp|deepseek|hermes|grok) return 0 ;; *) return 1 ;; esac
}
harness_v2_root() {
  node -e 'process.stdout.write(require(process.argv[1]).resolveRoot(process.argv[2]))' \
    "$REPO_ROOT/scripts/harness-v2-package.cjs" "$1"
}
install_harness_v2_lifecycle() {
  local client="$1" destination
  if ! destination="$(harness_v2_root "$client")"; then
    RESULT_ROWS+=("RESULT=FAIL client=$client stage=root"); ANY_FAIL=1; return 1
  fi
  if node "$REPO_ROOT/scripts/harness-v2-package.cjs" install "$client" --root "$destination"; then
    add_pass_result "$client" "$destination" private-v2
  else
    RESULT_ROWS+=("RESULT=FAIL client=$client stage=lifecycle"); ANY_FAIL=1; return 1
  fi
}
uninstall_harness_v2_lifecycle() {
  local client="$1" destination output status
  if ! destination="$(harness_v2_root "$client")"; then
    RESULT_ROWS+=("RESULT=FAIL client=$client code=1"); UNINSTALL_EXIT_CODE=1; return 1
  fi
  if ! output="$(node "$REPO_ROOT/scripts/harness-v2-package.cjs" uninstall "$client" --root "$destination")"; then
    RESULT_ROWS+=("RESULT=FAIL client=$client code=1"); UNINSTALL_EXIT_CODE=1; return 1
  fi
  if ! status="$(node -e 'const result=JSON.parse(process.argv[1]); if (!["uninstalled","not-installed"].includes(result.status)) process.exit(1); process.stdout.write(result.status)' "$output" 2>/dev/null)"; then
    RESULT_ROWS+=("RESULT=FAIL client=$client code=1"); UNINSTALL_EXIT_CODE=1; return 1
  fi
  if [ "$status" = uninstalled ]; then
    RESULT_ROWS+=("RESULT=OK client=$client removed=private-v2")
  elif [ "$status" = not-installed ]; then
    RESULT_ROWS+=("SKIP=skip client=$client reason=no-receipt")
  else
    RESULT_ROWS+=("RESULT=FAIL client=$client code=1"); UNINSTALL_EXIT_CODE=1; return 1
  fi
}
probe_harness_v2() {
  local client="$1" root detected=no installed=no verifies=no version=- reason=not-installed extras=missing activation=unavailable payload=unverified output fields message='' code=0
  if ! root="$(if [ "$client" = reasonix ]; then config_root reasonix; else harness_v2_root "$client"; fi)"; then
    printf 'no no no version=- reason=invalid-root extras=missing'; return 0
  fi
  if [ -e "$root/.autoprompt-$client-v2.json" ] || [ -L "$root/.autoprompt-$client-v2.json" ]; then
    installed=yes
    if [ "$client" = reasonix ]; then
      output="$(node "$REPO_ROOT/scripts/reasonix-package.cjs" doctor --root "$root" 2>/dev/null)" || code=$?
    else
      output="$(node "$REPO_ROOT/scripts/harness-v2-package.cjs" doctor "$client" --root "$root" 2>/dev/null)" || code=$?
    fi
    if fields="$(node -e 'const r=JSON.parse(process.argv[1]); if(r.payload!=="verified" || !["unavailable","local-canary-required","static-ready;dynamic-preflight-required"].includes(r.activation)) process.exit(1); const version=typeof r.nativeVersion==="string" && /^[A-Za-z0-9.+-]+$/.test(r.nativeVersion) ? r.nativeVersion : "-"; process.stdout.write([r.detected===true ? "yes" : "no",version,r.activation,r.reason,JSON.stringify(String(r.message||""))].join(" "))' "$output" 2>/dev/null)"; then
      payload=verified; extras=complete
      detected="${fields%% *}"; fields="${fields#* }"; version="${fields%% *}"; fields="${fields#* }"
      activation="${fields%% *}"; fields="${fields#* }"; reason="${fields%% *}"; message="${fields#* }"
      if [ "$code" -eq 0 ] && [ "$activation" != unavailable ]; then verifies=yes; fi
    else reason=payload-invalid; fi
  elif command -v "${AUTOPROMPT_CLIENT_BIN[$client]}" >/dev/null 2>&1; then
    # An uninstalled provider has no verified runtime to probe. Locate it only.
    detected=yes
  fi
  printf '%s %s %s version=%s reason=%s extras=%s payload=%s activation=%s' "$detected" "$installed" "$verifies" "$version" "$reason" "$extras" "$payload" "$activation"
  [ "$message" = '""' ] || [ -z "$message" ] || printf ' message=%s' "$message"
}
