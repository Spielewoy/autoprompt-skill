# Codex custom agents

These are the complete native Codex definitions for the Autoprompt L1 to L4 cast. They are generated from [`../../contracts/personas`](../../contracts/personas/) and committed so the full prompts remain visible and usable without running a generator first.

| Layer | Agents |
|---|---|
| L1 | `ap-scope-coordinator`, `ap-feature-coordinator`, `ap-sweep-coordinator` |
| L2 | `ap-manager` |
| L3 | `ap-scoper`, `ap-synthesizer`, `ap-researcher`, `ap-planner`, `ap-reviewer`, `ap-implementer`, `ap-verifier`, `ap-sweeper`, `ap-framework-generator`, `ap-execharness-resolver`, `ap-intake` |
| L4 | `ap-fresh-verifier`, `ap-depth-prober`, `ap-framework-validator`, `ap-juror`, `ap-goal-checker`, `ap-arbiter`, `ap-re-anchor`, `ap-scribe`, `ap-janitor`, `ap-preflight-probe` |

L0 is [`../SKILL.md`](../SKILL.md). `openai.yaml` keeps implicit invocation disabled. The installer writes the selected model and effort cast into the active Codex agent directory.
