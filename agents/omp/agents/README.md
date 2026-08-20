# Claude custom agents

These 25 `ap-*` files are the native Claude Code roles used by Autoprompt.

| Layer | Agents |
|---|---|
| L1 | `ap-scope-coordinator`, `ap-feature-coordinator`, `ap-sweep-coordinator` |
| L2 | `ap-manager` |
| L3 | `ap-scoper`, `ap-synthesizer`, `ap-researcher`, `ap-planner`, `ap-reviewer`, `ap-implementer`, `ap-verifier`, `ap-sweeper`, `ap-framework-generator`, `ap-execharness-resolver`, `ap-intake` |
| L4 | `ap-fresh-verifier`, `ap-depth-prober`, `ap-framework-validator`, `ap-juror`, `ap-goal-checker`, `ap-arbiter`, `ap-re-anchor`, `ap-scribe`, `ap-janitor`, `ap-preflight-probe` |

L0 is [`../SKILL.md`](../SKILL.md), the provider skill running in the parent session.
