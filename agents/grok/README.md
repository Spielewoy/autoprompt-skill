# Grok Build package

This deterministic adapter targets Grok Build 1.0.5, checked against the published source at `9dccd1f00ec1`.

- [`SKILL.md`](SKILL.md): L0 conductor prompt
- [`agents`](agents/): 25 native Grok Build agent definitions
- [`frameworks`](frameworks/): 18 task and gate workflows
- [`workflow`](workflow/): the sealed dispatcher, its MCP server, and the launchers
- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts

Grok Build caps native subagent nesting at one level, so `spawn_subagent` can never carry the L0-L4 topology. Every `ap-*` definition therefore denies the native task tool, and every edge runs through the sealed dispatcher: it validates the caller persona, the canonical child allowlist, the depth ceiling of 4, the framework registry, and the exact bytes of the prompt ledger before it starts the child as its own `grok -p --agent <definition>` process. Dispatch roles reach it through the `autoprompt` MCP server (`autoprompt__dispatch`); non-dispatch roles have MCP discovery removed, and the dispatcher refuses terminal callers regardless.

The definitions pin `model: inherit`, so every role runs the model the launcher resolved. Installation adds one `[mcp_servers.autoprompt]` registration to `config.toml` transactionally, stores a byte-exact backup, and restores the prior bytes on rollback or uninstall.
