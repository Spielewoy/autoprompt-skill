# OMP package

This package targets OMP 17.4.0.

- [`SKILL.md`](SKILL.md): L0 conductor prompt
- [`agents`](agents/): 25 generated role definitions
- [`frameworks`](frameworks/): 18 task and gate workflows
- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts

OMP discovers the installed skill and `ap-*` agent files from its agent directory. The native `spawns` lists enforce canonical child edges and OMP enforces the recursion ceiling.

Every role inherits the selected parent model. Custom `agents=` model routing is not available.
