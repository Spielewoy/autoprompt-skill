# Which coding agents are supported?

The current public support set contains ten working providers:

| Coding agent | Audited requirement | Package |
|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/setup) | 2.1.219+; audited 2.1.233 | [Source](../../agents/claude/) |
| [Codex](https://github.com/openai/codex) | Subagent-capable build; audited 0.147.0 | [Source](../../agents/codex/) |
| [OpenCode](https://opencode.ai/docs/agents) | 1.18.7+; audited 1.18.18 | [Source](../../agents/opencode/) |
| [Kilo](https://kilo.ai/docs/customize/custom-subagents) | 7.4.22+; audited 7.4.22 | [Source](../../agents/kilo/) |
| [Grok Build](https://github.com/xai-org/grok-build) | 1.0.0+; source-checked 1.0.5 | [Source](../../agents/grok/) |
| [VS Code](https://code.visualstudio.com/docs/agents/subagents) | 1.133+; audited 1.133.0 with Copilot 0.61.0 | [Source](../../agents/vscode/) |
| [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | 0.7.2; audited 0.7.2 | [Native package adapter](../../agents/prime/) |
| [Oh My Pi](https://omp.sh/) | 17.4.0+; adapter contract, install lifecycle, and native role payload verified for 17.4.0 | [Source](../../agents/omp/) |
| [DeepSeek Harness](https://deepseek.com/harness/en/) | 0.1.0-rc.7+; adapter contract, install lifecycle, and native role payload verified for 0.1.0-rc.7 | [Source](../../agents/deepseek/) |
| [Reasonix](https://reasonix.io/docs/) | 1.30.0+; adapter contract, install lifecycle, and native role payload verified for 1.30.0 | [Source](../../agents/reasonix/) |

The installer shows only this vetted set. OMP, DeepSeek Harness, and Reasonix are listed because their adapter contracts, install targets, root resolution, recursive wiring, reversible lifecycle, and native `ap-fresh-verifier` payloads are covered by local tests. Use the [custom coding agent compatibility guide](../guides/custom-agent-compatibility.md) to assess another CLI or IDE and define the adapter proof it still needs.

Grok Build caps native subagent nesting at one level, so its package denies the native task tool and routes every Autoprompt edge through a sealed dispatcher that starts each child as its own `grok --prompt-file <envelope> --agent <definition>` process. Installation registers one `[mcp_servers.autoprompt]` stdio server in `config.toml` transactionally, keeps a byte-exact backup, and restores the prior bytes on rollback or uninstall. Grok Build offers user-scoped MCP servers to every session, so the dispatcher additionally requires an activation token minted by `launch-grok`: a session Autoprompt did not start is refused rather than treated as the conductor. A ready group dispatches in one call and runs concurrently up to `AUTOPROMPT_GROK_MAX_SUBS` (six by default, matching `tokensaver`); because every hop is its own process, that ceiling is enforced run-globally through file-backed slots keyed to the run activation, and a dispatcher waiting on its own children yields its slot so a full run cannot deadlock. The activation token, persona, and depth travel in the child environment: that keeps ordinary sessions out and a cooperating cast inside the canonical topology, but it is not a sandbox against a role that goes out of contract, so containment stays with Grok Build permission modes and the per-persona tool allowlists. The adapter is built against the published Grok Build source at 1.0.5, pinned to upstream commit `d92c5b0b8582` (whose declared internal source revision is `9dccd1f00ec1`); it has not yet been audited on a live Grok Build install, so treat its audited-requirement column as source-checked rather than run-checked. The CLI uses `GROK_HOME` when set, otherwise `~/.grok`.

Prime uses a sealed adapter for Autoprompt dispatch. Raw host `rlm` remains available outside Autoprompt, so this is not a global sandbox boundary. The CLI uses `PRIME_AGENT_CODING_AGENT_DIR` when set, otherwise `~/.prime/agent`.

Oh My Pi loads the skill and settings from `PI_CODING_AGENT_DIR` when that override is set, while default-profile task agents remain under `${HOME}/${PI_CONFIG_DIR:-.omp}/agent/agents`; a named `OMP_PROFILE` (or legacy `PI_PROFILE`) instead keeps the skill and all 25 roles together under that profile's `agent` directory. Invoke the skill with `/skill:autoprompt`. DeepSeek Harness installs an `Autoprompt` user preset under `DSH_HOME/.agent-presets/autoprompt`; headless sessions use the installed `headless.patch.yml`. Reasonix installs 25 manual subagent profiles under `REASONIX_HOME/skills`. On Windows, Reasonix defaults to `%APPDATA%/reasonix`; elsewhere it defaults to `~/.reasonix`.
