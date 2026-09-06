# What do mode, max_subs, agents, and path do?

Use `mode=` and `max_subs=` to control concurrency, `agents=` to choose models, and [`path=`](work-paths.md) to choose a work route.

| Control | Effect |
|---|---|
| `mode=tokensaver` | Runs at most six subagents at once. This is the default. |
| `mode=wide` | Starts all ready, independent work up to the host limit. |
| `mode=custom max_subs=N` | Sets a limit of `N` simultaneous subagents. |
| `agents=off` | Uses the active model for child agents. |
| `agents=auto` or a model list | Selects models on Claude Code and Codex. Other hosts use their selected parent model. |
| `path=auto` or omitted | Chooses a route to fit the task. |
| `path=direct` | Starts focused work without a separate plan. |
| `path=light` | Makes a short plan before starting work. |
| `path=roadmap` | Defines the scope and roadmap before starting work. |

`max_subs` is a limit, not a target. Small jobs may use fewer agents. More parallel work can increase time and token use.

In Codex, pass `path=` as a separate argument before the quoted request:

```bash
autoprompt activate codex -- path=direct "fix the registration race"
```

Every route includes execution and independent verification. An explicit route skips automatic selection; invalid or incompatible choices stop with an error.

For custom Codex concurrency, leave route selection automatic:

```bash
autoprompt activate codex -- --concurrency custom --max-subs 4 "fix the registration race"
```

Configure Codex model selection with `autoprompt configure codex --agents auto`
or `--agents MODEL`; text inside the quoted goal does not change that setting.
