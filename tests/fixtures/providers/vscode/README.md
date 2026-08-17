# VS Code 1.133 custom agent fixture

This is the minimal Autoprompt acceptance fixture for VS Code `.agent.md` files. It is pinned to VS Code `1.133.0`, commit `a5b500951314efd502d07465bd138dfbd714a960`, and the bundled GitHub Copilot `0.61.0`, whose engine range is `^1.133.0`.

`custom-agent-frontmatter.schema.json` is a focused acceptance schema, not an upstream standalone schema. VS Code expresses this contract through its parser constants, editor metadata, tests, and bundled Copilot guidance.

## Proven forms

| Field | Autoprompt form | VS Code 1.133 behavior |
| --- | --- | --- |
| `name` | Non-empty string | Optional upstream, but required by this renderer contract for stable allowlist names. |
| `description` | Non-empty string | Supplies the agent purpose and model discovery text. |
| `tools` | String or string array | `agent` is the documented alias for subagent use. `[]` gives a leaf no tools. |
| `agents` | String array | A name list is an allowlist. `[]` prevents subagent use. `*` is also accepted upstream but is intentionally not emitted here. |
| `model` | Omitted | VS Code uses the currently selected model when omitted. A custom agent otherwise accepts one model string or a prioritized non-empty string array. |
| `user-invocable` | Boolean | `true` exposes the root to users. `false` makes internal agents programmatic or subagent-only. |
| `disable-model-invocation` | Boolean | `true` prevents model invocation. Internal allowlisted agents use `false`. |

The three agents prove one nested chain: `autoprompt` invokes `ap-feature-coordinator`, which can invoke `ap-implementer`. Both invoking agents include only the proven `agent` alias. The leaf has `tools: []` and `agents: []`.

Nested invocation from a subagent is disabled by default in VS Code. A user who needs this chain must enable `chat.subagents.allowInvocationsFromSubagents`; the fixture does not mutate settings. VS Code 1.133 documents a maximum nesting depth of five.

## Primary evidence

- [VS Code parser field spellings at commit a5b5009513](https://github.com/microsoft/vscode/blob/a5b500951314efd502d07465bd138dfbd714a960/src/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts#L65-L85)
- [VS Code accepted scalar and sequence forms](https://github.com/microsoft/vscode/blob/a5b500951314efd502d07465bd138dfbd714a960/src/vs/workbench/contrib/chat/common/promptSyntax/languageProviders/promptFileAttributes.ts#L106-L155)
- [VS Code tool aliases, including `agent`](https://github.com/microsoft/vscode/blob/a5b500951314efd502d07465bd138dfbd714a960/src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts#L725-L737)
- [VS Code parser tests for allowlists and empty agent lists](https://github.com/microsoft/vscode/blob/a5b500951314efd502d07465bd138dfbd714a960/src/vs/workbench/contrib/chat/test/common/promptSyntax/service/promptFileParser.test.ts#L445-L490)
- [Bundled Copilot 0.61.0 agent reference](https://github.com/microsoft/vscode/blob/a5b500951314efd502d07465bd138dfbd714a960/extensions/copilot/assets/prompts/skills/agent-customization/references/agents.md#L12-L68)
- [Bundled Copilot version and VS Code engine pin](https://github.com/microsoft/vscode/blob/a5b500951314efd502d07465bd138dfbd714a960/extensions/copilot/package.json#L5-L25)
- [VS Code 1.133 custom agent documentation source](https://github.com/microsoft/vscode-docs/blob/d5cf10999259064912a02cb7be177d0abcc56093/docs/agent-customization/custom-agents.md#L107-L114)
- [VS Code 1.133 subagent inheritance documentation source](https://github.com/microsoft/vscode-docs/blob/d5cf10999259064912a02cb7be177d0abcc56093/docs/agents/run/subagents.md#L189-L193)
- [VS Code 1.133 subagent model priority documentation source](https://github.com/microsoft/vscode-docs/blob/d5cf10999259064912a02cb7be177d0abcc56093/docs/agents/run/subagents.md#L252-L258)
- [VS Code 1.133 recursive subagent documentation source](https://github.com/microsoft/vscode-docs/blob/d5cf10999259064912a02cb7be177d0abcc56093/docs/agents/run/subagents.md#L274-L284)

Live documentation:

- https://code.visualstudio.com/docs/agent-customization/custom-agents
- https://code.visualstudio.com/docs/agents/subagents
