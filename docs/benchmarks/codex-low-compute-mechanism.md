# Codex low-compute three-arm mechanism canary

This harness is a mechanics check, not a quality benchmark. It uses one small
`DIRECT` task and one repetition across exactly three named arms:

1. `base` - single-agent base
2. `current` - frozen current Autoprompt
3. `redesign` - Codex redesign candidate

The caller must provide full, locally available baseline and candidate commit SHAs.
`base` and `current` bind to the baseline SHA; `redesign` binds to the candidate SHA.
Each arm gets a separate copy of the broken `normalizeTags` fixture. A controller-owned
focused check then proves whether that copy trims values, removes empty values and exact
duplicates, and preserves first-seen order.

The included arm runner is deterministic. It proves commit binding, workspace isolation,
three-arm ordering, terminal-state derivation, and focused-check execution with zero model
calls. Every emitted record permanently sets both `qualityClaimEligible` and
`comparisonClaimEligible` to `false`. Its results cannot support quality, cost, latency,
or redesign-effect claims.

The controller first requires the untouched fixture's focused check to be red. The commit
SHAs are verified and bound into each arm record, but the included deterministic runner does
not execute source from those commits; every attempt says
`sourceBinding=declared-existing-commit-not-executed`. A later real runner must replace that
binding before commit identity can support treatment provenance.

## Commit-bound integration run

Run this only after the integrated candidate is committed and the worktree is clean:

```text
node tests/benchmarks/autoprompt-benchmark.cjs --config tests/benchmarks/autoprompt-benchmark.json --baseline-sha <40-character-baseline-sha> --candidate-sha <40-character-candidate-sha> --output <evidence-json> --generated-at <canonical-ISO-time>
```

The harness rejects abbreviated, missing, non-commit, or identical SHAs. The focused test
suite also proves repeated runs produce the same canonical record.

## Real Codex boundary

The real Codex observation is carried from
[`codex-canary-2026-08-22.md`](./codex-canary-2026-08-22.md), not rerun or converted into a
score. It remains:

```text
PROVIDER_UNSUPPORTED provider=codex reason=codex-command-sandbox-network-open
```

That blocker happened before routing and before any model call. A real three-arm comparison
therefore remains open.

## Route-holdout boundary

The 16-row route fixture is now explicitly `synthetic-design-fixture` data with sealed byte
provenance. Readiness fails closed until independently human-created labels, at least two
raters, inter-rater agreement evidence, adjudication evidence, development/test separation,
and a pre-tuning freeze are supplied. Its perfect confusion matrix is mechanics evidence only.

Consequently, this work improves the local mechanics for `AP-TEST-017`, `AP-TEST-020`,
`AP-TEST-036`, and `AP-DESIGN-038`, but does not close their required real or human evidence.
`AP-TEST-002` remains partial because this canary intentionally has one task and one repetition.
