# Codex v2 local canary — 2026-08-22

This is a diagnostic record, not a benchmark result and not evidence for a quality,
speed, or cost claim.

## Scope

The canary used a disposable local Git repository with no remotes, `push.default`
set to `nothing`, and a rejecting pre-push hook. The task was intentionally small:
fix `normalizeTags` in `index.cjs` so it trims strings, removes empty values, removes
exact duplicates, preserves first-seen order, adds no dependency, and passes
`node --test`.

The recorded baseline was red: one focused test failed because the implementation
only trimmed the input array. The isolated Codex root was installed from the current
working tree. No normal Codex home or project outside the disposable canary was
modified.

## Expected route

The canonical facts describe one reversible local file mutation with a recorded
focused red baseline, one owner, no external effect, no unresolved design decision,
and an authoritative check. The deterministic classifier returned:

- status: `DECIDED`
- route: `DIRECT`
- precedence: `8`
- facts fingerprint: `f82a9bdd4d7c92fcb12525c5e6b711eef7f2b70b8fc9a0b88f394293b5c2f80b`
- classifier fingerprint: `6c083cdfe61e7856a75a04ee226f2b7fe97a5ba990e293b35bf05c7941b9f8ab`
- required terminal result: `CHANGE_VERIFIED`

## Live result

The installed launcher completed payload and static-prerequisite validation. During
the mandatory dynamic preflight, Codex CLI 0.148.0's Windows command sandbox accepted
a loopback TCP connection even with `--sandbox-state-disable-network`. Autoprompt
stopped with:

```text
PROVIDER_UNSUPPORTED provider=codex reason=codex-command-sandbox-network-open
```

This happened before the route analyst, L0, any worker, or any model call. Therefore
the run has no observed lane, completion, token usage, latency, or quality result. The
target remained at its recorded red baseline.

## What the failure taught

1. A fresh custom Codex root could pass strict doctor without `cap_sid`, then fail
   during activation. Doctor now validates this static Windows prerequisite and says
   explicitly that a dynamic preflight is still required.
2. Launching the Windows `codex.cmd` shim could hang after its wrapper was terminated.
   The Codex path now resolves and validates the official native `codex.exe`, and
   propagates its package-managed environment to every probe and child.
3. This host's remaining blocker is the provider sandbox capability, not routing. The
   correct response is a typed pre-route refusal; bypassing the network proof would
   convert an observed safety gap into an unverified claim.

## Retest condition

Repeat this same one-file canary only after the installed Codex command sandbox denies
the loopback probe. A valid rerun must preserve the red baseline, record `DIRECT`, make
only the bounded `index.cjs` change, run the focused test to green, produce a typed
candidate-bound checker result, revoke the activation, and leave zero descendant
processes or copied credentials behind.
