# Grok Build package

This deterministic adapter targets Grok Build 1.0.5, checked against the published source at `d92c5b0b8582` (upstream source revision `9dccd1f00ec1`).

- [`SKILL.md`](SKILL.md): L0 conductor prompt
- [`agents`](agents/): 25 native Grok Build agent definitions
- [`frameworks`](frameworks/): 18 task and gate workflows
- [`workflow`](workflow/): the sealed dispatcher, its MCP server, and the launchers

Dispatch a ready group in one call by passing `jobs`: every job is admitted before any child starts, the group then runs concurrently, and all reports are collected together. That is the spawn-all-then-collect shape, so reviewers, verifiers, and disjoint lanes really do run in parallel. The live-child ceiling is run-global, not per group: because every hop is its own process, the dispatchers of a run share file-backed slots keyed to the run activation, so the conductor, each coordinator, and each manager all draw from the same set. A dispatcher waiting on its own children yields its slot for that wait, which is what keeps a full run from deadlocking. The ceiling is `AUTOPROMPT_GROK_MAX_SUBS`, defaulting to the six live children `tokensaver` allows; raise it for `wide` or `custom max_subs=N`. A denied job cancels its whole group rather than leaving half a fleet running.
- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts

Grok Build caps native subagent nesting at one level, so `spawn_subagent` can never carry the L0-L4 topology. Every `ap-*` definition therefore denies the native task tool, and every edge runs through the sealed dispatcher: it validates the launch activation, the caller persona, the canonical child allowlist, the depth ceiling of 4, the framework registry, and the exact bytes of the prompt ledger before it starts the child as its own `grok --prompt-file <envelope> --agent <definition>` process. Dispatch roles reach it through the `autoprompt` MCP server (`autoprompt__dispatch`); non-dispatch roles have MCP discovery removed, and the dispatcher refuses terminal callers regardless. Because Grok Build offers user-scoped MCP servers to every session, an activation token minted by the launcher is required before any dispatch: a session Autoprompt did not start has none and is refused, never treated as the conductor.

The definitions pin `model: inherit`, so every role runs the model the launcher resolved. Installation adds one `[mcp_servers.autoprompt]` registration to `config.toml` transactionally, stores a byte-exact backup, and restores the prior bytes on rollback or uninstall.
