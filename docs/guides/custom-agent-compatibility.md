# Check another coding agent or IDE

Paste this into your preferred coding agent or LLM to check compatibility with https://github.com/Spielewoy/autoprompt-skill/. Replace [TOOL NAME] with the coding agent, CLI, IDE, or harness you want to check. For common tools, the name alone is enough. For niche tools, replace [TOOL DOCS] with its official documentation or repository. Example: [TOOL NAME] = Claude Code, [TOOL DOCS] = Claude Code documentation link.

## Paste-ready prompt

```text
We are checking compatibility for Autoprompt Skill:
https://github.com/Spielewoy/autoprompt-skill/

Check whether [TOOL NAME] can run it safely and natively.

Tool documentation or repository:
[TOOL DOCS]

Read the Autoprompt repository and the tool's official documentation or source. Do not guess from filenames, marketing claims, or another provider's adapter.

Check every requirement:
1. Explicit entry: Autoprompt starts only when the user explicitly invokes it. An ordinary task must not start it automatically.
2. Native discovery: the host loads a stable skill, instruction, plugin, or package entry path.
3. Named workers: it can expose and dispatch 25 isolated roles, return each result, and support recursion to depth 4 directly or through an adapter.
4. Run controls: it can enforce tokensaver, wide, and custom concurrency plus a harness-specific agent cap.
5. Worker tools: scoped filesystem access, shell commands, and real test execution are available to workers.
6. Durable state: run plans, evidence, failures, and resumable state can be stored in the workspace.
7. Independent checks: reviewers can start without inheriting another reviewer's verdict.
8. Failure delivery: denials, timeouts, tool errors, and child failures return to the coordinator.
9. Model behavior: document whether workers inherit the active model or support explicit routing.
10. Safe lifecycle: install, strict doctor, repair, update, custom roots, collision checks, rollback, and receipt-scoped uninstall can be implemented without following unsafe symlinks or reparse points.

Return:
- A PASS, FAIL, or UNKNOWN table for all 10 requirements.
- An official source link and exact evidence for every PASS.
- The native paths and formats an adapter would use.
- The smallest adapter changes and real-host tests still needed.
- One conclusion: Compatible, Adapter required, or Not compatible.

Treat UNKNOWN as not yet compatible. Do not claim support until a real install, invocation, worker dispatch, failure path, repair, and uninstall have been checked.
```

A copied `SKILL.md` is not enough. The host needs a native adapter and a safe lifecycle.

## Shipped adapters

| Host | Requirement | Integration | Model routing |
|---|---|---|---|
| Claude Code | 2.1.219+; checked on 2.1.233 | Skill, Markdown agents, frameworks, recursive runtime | Custom routing |
| Codex | Subagent-capable; checked on 0.147.0 | Skill, TOML roles, frameworks, multi-agent runtime | Custom routing |
| OpenCode | 1.18.7+; checked on 1.18.18 | Skill, Markdown agents, activation profile | Inherits active model |
| Kilo | 7.4.22+; checked on 7.4.22 | Skill, Markdown subagents, activation profile | Inherits active model |
| VS Code | 1.133+ with Copilot 0.61.0 | Copilot skill, `.agent.md` roles, recursive setting | Inherits active model |
| Prime Agent | 0.7.2; checked on 0.7.2 | Native package, personas, framework prompts, guarded recursion | Inherits selected parent model |

See the [support notes](../faq/which-coding-agents-are-supported.md).

## Build and check an adapter

1. Map the entry, 25 roles, 18 frameworks, and runtime to native formats.
2. Validate default and custom roots. Never trust a folder name.
3. Fail closed when version or capability checks fail.
4. Add transactional install, strict doctor, repair, update, receipt-scoped uninstall, collision checks, and rollback.
5. Check repeat install, repair, update, custom root, rollback, and uninstall on each operating system.
6. Run the real host and check discovery, explicit invocation, isolated workers, recursion, failure delivery, bounded concurrency, and final evidence collection.

Add the host to the installer only after every required check passes.
