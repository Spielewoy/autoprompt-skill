# omp package (oh-my-pi)

These are the native oh-my-pi roles used by Autoprompt.

The installer places:

- the skill payload under `<agent-dir>/skills/autoprompt/` (the omp-native
  skill discovery path `skills/<name>/SKILL.md`),
- the 25 `ap-*` personas under `<agent-dir>/agents/` (omp-native named-agent
  discovery, dispatched by registered name),
- the `/autoprompt` command file under `<agent-dir>/commands/autoprompt.md`
  (omp-native slash-command entry with `$ARGUMENTS` expansion),
- and sets `task.maxRecursionDepth` to at least 4 in `<agent-dir>/config.yml`
  so the L0->L1->L2->L3->L4 hierarchy can spawn (omp default is 2).

`<agent-dir>` is omp's active agent config directory: `~/.omp/agent` for the
default profile (relocated by `PI_CODING_AGENT_DIR`, or by a named profile via
`~/.omp/profiles/<name>/agent`).

## Layers

| Layer | Agents |
|---|---|
| L1 | `ap-scope-coordinator`, `ap-feature-coordinator`, `ap-sweep-coordinator` |
| L2 | `ap-manager` |
| L3 | `ap-scoper`, `ap-synthesizer`, `ap-researcher`, `ap-planner`, `ap-reviewer`, `ap-implementer`, `ap-verifier`, `ap-sweeper`, `ap-framework-generator`, `ap-execharness-resolver`, `ap-intake` |
| L4 | `ap-fresh-verifier`, `ap-depth-prober`, `ap-framework-validator`, `ap-juror`, `ap-goal-checker`, `ap-arbiter`, `ap-re-anchor`, `ap-scribe`, `ap-janitor`, `ap-preflight-probe` |

L0 is [`../SKILL.md`](../SKILL.md), the provider skill running in the parent
session.

## omp specifics

- Every persona declares an omp-native frontmatter: `tools` (restricted per
  layer), `spawns` (the registered `ap-*` names it may dispatch; enforced by the
  harness), and no `model` key (workers inherit the parent's active model unless
  casting is enabled).
- L1 coordinators and the L2 manager carry no read/write tools; dispatch goes
  through the `task` tool binding the registered persona name as `agent`.
- Concurrency is enforced by wave-batching the parallel task dispatch against
  `task.maxConcurrency` (default 32, the harness-specific agent cap).
- `model-casting.js` resolves `agents=` selectors; the supervisors hand the
  serialized casting to the child via `AUTOPROMPT_AGENT_CASTING`.
- Unattended runs use the shipped supervisors driving `omp -p --auto-approve`
  (omp headless print mode).