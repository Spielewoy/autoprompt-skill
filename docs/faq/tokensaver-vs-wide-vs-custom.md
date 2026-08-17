# What do mode, max_subs, and agents do?

These controls change concurrency and model routing. They do not remove checks.

| Control | Effect |
|---|---|
| `mode=tokensaver` | Runs at most six live subagents. This is the bounded default. |
| `mode=wide` | Opens every ready independent lane, up to the host limit. |
| `mode=custom max_subs=N` | Sets a hard ceiling of `N` live subagents. |
| `agents=off` | Makes children inherit the active model. |
| `agents=auto` or a model list | Routes models on Claude Code and Codex. Other hosts inherit their selected parent model. |

`max_subs` is a ceiling, not a target. Small jobs may use fewer agents, and wider modes can increase time and token use.
