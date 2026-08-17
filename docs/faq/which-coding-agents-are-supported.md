# Which coding agents are supported?

The current public support set contains six working providers:

| Coding agent | Audited requirement | Package |
|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/setup) | 2.1.219+; audited 2.1.233 | [Source](../../agents/claude/) |
| [Codex](https://github.com/openai/codex) | Subagent-capable build; audited 0.147.0 | [Source](../../agents/codex/) |
| [OpenCode](https://opencode.ai/docs/agents) | 1.18.7+; audited 1.18.18 | [Source](../../agents/opencode/) |
| [Kilo](https://kilo.ai/docs/customize/custom-subagents) | 7.4.22+; audited 7.4.22 | [Source](../../agents/kilo/) |
| [VS Code](https://code.visualstudio.com/docs/agents/subagents) | 1.133+; audited 1.133.0 with Copilot 0.61.0 | [Source](../../agents/vscode/) |
| [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | 0.7.2; audited 0.7.2 | [Native package adapter](../../agents/prime/) |

The installer shows only this audited set. A provider is added here after its package, install path, recursive behavior, and cleanup flow have been verified together. Use the [custom coding agent compatibility guide](../guides/custom-agent-compatibility.md) to assess another CLI or IDE and define the adapter proof it still needs.

Prime uses a sealed adapter for Autoprompt dispatch. Raw host `rlm` remains available outside Autoprompt, so this is not a global sandbox boundary. The CLI uses `PRIME_AGENT_CODING_AGENT_DIR` when set, otherwise `~/.prime/agent`.
