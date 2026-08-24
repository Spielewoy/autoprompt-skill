# Codex custom agents

These Codex definitions implement the proportional Autoprompt role model. L0 is the root task: it owns the route decision, success criteria, independent-checker selection, and user communication. L0 is not a child agent.

| Layer | Canonical roles | When used |
|---|---|---|
| Before routing | `ap-route-analyst` | Exactly one read-only recommendation per explicit run |
| L0 | `ap-run-owner` | Chooses the route, owns the success checklist, dispatches legal children, and returns the final result |
| L1 | `ap-run-coordinator` | ROADMAP only, when connected work groups need coordination |
| L2 | `ap-work-group-manager` | ROADMAP only, for one genuinely multi-worker group with disjoint ownership |
| L3 | `ap-roadmap-author`, `ap-roadmap-scout`, `ap-worker` | Produces the roadmap, bounded discovery, code, research, or another assigned result |
| L4 | `ap-independent-checker`, `ap-independent-reviewer`, `ap-independent-tester`, `ap-technical-decision-reviewer`, `ap-diagnostic-probe` | Checks an exact candidate or performs one explicitly admitted diagnostic |

The package contains 32 physical TOMLs because canonical roles and transition aliases
must remain separately hashable during migration. The runtime exposes 13 launchable
logical child roles. Older `ap-*` ids are compatibility aliases; they do not restore
the old fixed sequence. `ap-scribe` and `ap-janitor` resolve to deterministic control
code rather than model sessions, and legacy fleet roles that are not in a legal route
edge are rejected.

The deterministic control plane launches the route analyst and L0. L0 dispatches the
run; among custom children, only L1 and L2 may dispatch, and their permitted children
are checked by the supervisor. L3 and L4 roles are closed. Independent checkers use a
read-only production target and require isolated or exclusive resources for commands
that write caches, generated files, databases, ports, or services.

`openai.yaml` keeps implicit invocation disabled. Model and effort values are installed separately. The supported external entry is `autoprompt activate codex -- <mission>`; `$autoprompt` is an activation-private envelope injected by the launcher.
