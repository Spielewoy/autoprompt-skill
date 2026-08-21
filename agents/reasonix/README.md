# Reasonix package

This package targets Reasonix 1.30.0.

- [`SKILL.md`](SKILL.md): L0 conductor prompt
- [`skills`](skills/): 25 native subagent profiles
- [`frameworks`](frameworks/): 18 task and gate workflows
- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts

Reasonix discovers the installed top-level skill and `ap-*` subagent profiles from its skill directory. Canonical role prompts define the recursive child edges.

Every role inherits the selected parent model. Custom `agents=` model routing is not available.
