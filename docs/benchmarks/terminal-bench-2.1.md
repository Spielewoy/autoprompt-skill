# Terminal-Bench 2.1

## Result

| Run | Solved | Failed | Score |
|---|---:|---:|---:|
| OpenCode | 60/89 | 29 | 67.42% |
| OpenCode + Autoprompt | 73/89 | 16 | 82.02% |
| Change | +13 solves | 13 fewer | +14.61 points |

Both runs used DeepSeek V4 Flash, OpenCode 1.18.7, and the same 89 tasks. Failures fell from 29 to 16, which is 45% fewer.

## Evidence boundary

The OpenCode baseline has [all 89 retained task verdicts](https://github.com/Spielewoy/autoprompt-skill/blob/main/benchmark/terminal-bench-2.1/evidence/opencode-deepseek-v4-flash-matched-plain-89/per-task-verdicts.json). The Autoprompt score is the recorded completed aggregate in the [comparison report](https://github.com/Spielewoy/autoprompt-skill/blob/main/benchmark/terminal-bench-2.1/OPENCODE-DEEPSEEK-V4-FLASH-COMPARISON-89.md), but its original per-task map was not retained, so that result cannot be rebuilt task by task.

[DeepSeek reported 82.7%](https://api-docs.deepseek.com/updates/#date-2026-07-31) with its own harness and settings. It is an external reference, not a comparable third run.
