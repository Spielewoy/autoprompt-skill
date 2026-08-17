# VS Code package

This deterministic adapter targets VS Code 1.133 custom agents with the bundled GitHub Copilot 0.61 contract.

- [`SKILL.md`](SKILL.md): L0 conductor prompt
- [`agents`](agents/): 25 native `.agent.md` internal roles
- [`frameworks`](frameworks/): 18 task and gate workflows
- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts

The installer transactionally sets `chat.subagents.allowInvocationsFromSubagents=true` in the VS Code user `settings.json`. When it changes an existing file, it stores a byte-exact backup and restores the prior bytes on rollback or uninstall. It refuses unsafe JSONC and conflicting state instead of overwriting user configuration.

The agent files omit `model`, so every role inherits the currently selected model. All roles are internal, hidden from direct user invocation, and restricted by explicit canonical child allowlists.
