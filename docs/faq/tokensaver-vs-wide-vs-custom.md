# What do mode, max_subs, agents, and path do?

<!-- codex-v2-release-status: local-v1.0.9-build-not-published -->
> Codex v2 `path=` status: Local v1.0.9 build; not published.

These controls change concurrency, model routing, and, on Codex v2, work-route
selection. They do not remove checks.

| Control | Effect |
|---|---|
| `mode=tokensaver` | Runs at most six live subagents. This is the bounded default. |
| `mode=wide` | Opens every ready independent lane, up to the host limit. |
| `mode=custom max_subs=N` | Sets a hard ceiling of `N` live subagents. |
| `agents=off` | Makes children inherit the active model. |
| `agents=auto` or a model list | Routes models on Claude Code and Codex. Other hosts inherit their selected parent model. |
| `path=auto` or omitted | On Codex v2, runs the route analyst and lets L0 select DIRECT, LIGHT, or ROADMAP. |
| `path=direct`, `path=light`, or `path=roadmap` | On Codex v2, skips route-analysis and route-selection model work and enters that exact route. |

`max_subs` is a ceiling, not a target. Small jobs may use fewer agents, and wider modes can increase time and token use.

Put the optional path control at the start of the Codex request, after `--`:

```bash
autoprompt activate codex -- path=direct <mission>
```

An explicit path is not permission to bypass safety, authority, capability, execution,
or independent verification checks. It still creates the required route record and
route-specific deliverable. Codex does not silently upgrade or downgrade an explicit
path; invalid, conflicting, or unusable selections fail closed.
