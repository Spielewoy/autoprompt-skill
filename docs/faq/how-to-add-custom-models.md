# How do I add custom models?

Custom `agents=` routing is available in Claude Code and Codex. OpenCode, Kilo, and VS Code inherit the active model. Prime Agent inherits the selected parent model. Grok Build children inherit the run model the launcher resolved; set `AUTOPROMPT_GROK_MODEL` or `AUTOPROMPT_GROK_EFFORT` once for the whole run instead of per role.

Create a registry whose names match the values used in `agents=`:

```json
[
  {
    "name": "Strong",
    "provider": "router",
    "modelString": "provider/model-strong",
    "baseUrl": "http://localhost:20128/v1",
    "apiKeyEnv": "AUTOPROMPT_ROUTER_TOKEN",
    "effortHint": "high"
  }
]
```

`name`, `provider`, and `modelString` are required. `baseUrl`, `apiKeyEnv`, and `effortHint` are optional. Store only an environment variable name in `apiKeyEnv`, never a secret.

Claude Code accepts up to three selected models from one endpoint-compatible pool. Codex accepts up to five models available through its active provider. The selectors are:

| Selector | Result |
|---|---|
| `agents=off` | Inherit the current model. |
| `agents=Strong,Fast` | Use the named models in that order. |
| `agents=auto` | Rank the registry by `effortHint`. |
| `agents=auto:Strong,Fast` | Rank only the named entries. |

For the registry schema and launch details, see the [Claude model schema](../../agents/claude/autoprompt-models.schema.md) and [multi-provider guide](../guides/9router-multi-provider-setup.md).
