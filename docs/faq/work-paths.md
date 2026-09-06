# What are the paths?

`path=` controls how Autoprompt organizes the work before execution. Use `auto` when you want it to choose, or select `direct`, `light`, or `roadmap` explicitly. Every work path includes execution and independent verification.

| Path | Preparation | When it fits |
|---|---|---|
| `path=auto` or omitted | Examines the goal, dependencies, uncertainty, available checks, and effects; selects a work path. | You know the result you want and want Autoprompt to decide how much planning it needs. |
| `path=direct` | Records the goal and success checks, then starts focused work without a separate planning phase. | The change is bounded, the approach is known, and the result can be checked. |
| `path=light` | Makes a short plan to resolve the approach or order of work before execution. | One connected change needs a reversible design choice, characterization, or a few ordered steps. |
| `path=roadmap` | Defines scope, dependencies, work groups, and integration in a roadmap before execution. | Several dependent parts must come together, a public contract or multiple systems change, or rollout needs staging and rollback. |

For example, fixing a filter bypass with a known regression test fits `direct`. Adding retries with timeout, cancellation, and idempotency decisions fits `light`. Replacing authentication across an API, web client, mobile client, and stored sessions fits `roadmap`.

File count does not decide the path. A mechanical rename across twenty files can be `direct`; a three-file change across separately deployed services can need `roadmap`. A failed attempt alone does not justify a larger path either. Automatic selection changes only when the work reveals a relevant dependency, uncertainty, or risk.

In Codex, pass `path=` as a separate argument before the quoted goal:

```bash
autoprompt activate codex -- path=auto "fix the failing checkout tests"
autoprompt activate codex -- path=direct "fix the registration race and add a regression test"
autoprompt activate codex -- path=light "add retries with cancellation and idempotency checks"
autoprompt activate codex -- path=roadmap "migrate authentication across the API and clients"
```

An explicit path bypasses automatic route selection; it does not remove authorization, capability, budget, or verification requirements. Invalid or incompatible choices stop with an error instead of silently selecting another path.

`path=` controls planning and coordination. [`mode`, `max_subs`, and `agents`](tokensaver-vs-wide-vs-custom.md) control concurrency and model choice. A larger concurrency limit does not force a larger path or more workers.

For Codex, custom concurrency uses `--concurrency custom --max-subs N` after the
launcher's `--`, with automatic route selection. An exact path cannot be combined
with explicit concurrency controls. Text after an exact path is treated as the
goal, so putting `mode=custom` there does not configure concurrency.
