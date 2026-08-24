# Codex package

- [`SKILL.md`](SKILL.md): L0 coordinator prompt
- [`agents`](agents/): 32 physical Codex TOML roles
- [`frameworks`](frameworks/): 18 task and check workflows
- [`workflow`](workflow/): role casting, profile binding, budgeting, and supervisors
- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts

The committed TOMLs inherit the session model. Installation can recast the same roles with the selected model and effort configuration.

Internal roles remain inside one immutable generation-qualified private bundle. Ordinary review and merge requests do not load Autoprompt or any companion review skill. Start work only through exact explicit activation:

```bash
autoprompt activate codex --target <absolute-project-path> -- <request>
```

The launcher verifies the exact installed payload, request envelope, role projection, workspace-write profile, and separate read-only checker profile before starting the supervisor.
