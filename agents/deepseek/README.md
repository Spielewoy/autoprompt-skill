# DeepSeek Harness package

This package targets DeepSeek Harness 0.1.0-rc.7.

- [`SKILL.md`](SKILL.md): L0 conductor prompt
- [`agents`](agents/): 25 generated role definitions
- [`frameworks`](frameworks/): 18 task and gate workflows
- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts

Select the Autoprompt agent preset for Web sessions. For headless runs, pass the installed `headless.patch.yml` with `--patch`. Each role tool denies non-allowlisted role tools and uses a depth ceiling of four.

Every role inherits the selected parent model. Custom `agents=` model routing is not available.
