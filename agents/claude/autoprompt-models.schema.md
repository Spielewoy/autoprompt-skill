# Model registry: the precise contract

The optional Claude Code model registry lives at
`~/.claude/autoprompt-models.json`. It maps exact-case names used in `agents=`
selectors to provider model strings and the one process-wide provider context a
Claude Code child will use.

The registry is a JSON array of objects. Unknown fields are rejected.

## Schema

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Exact-case selector name, such as `DeepSeek-V3` |
| `provider` | yes | Informational provider label; arbitrary non-empty strings are accepted |
| `modelString` | yes | Exact provider model identifier bound to a Claude alias |
| `baseUrl` | no | Absolute HTTP(S) endpoint used by the child |
| `apiKeyEnv` | no | **Name** of the environment variable holding the child endpoint credential |
| `effortHint` | no | Auto-ranking hint: `max`, `high`, `medium`, or `low` |

`apiKeyEnv` is never a key value. The registry and serialized casting metadata
contain only the variable name. The supervisor reads that named variable and
passes its value to the child as `ANTHROPIC_AUTH_TOKEN`; it never serializes the
secret.

## Selection semantics

- `agents=off` does not read or resolve the registry.
- `agents=auto` reads the full registry and ranks it by `effortHint`; registry
  order breaks ties. The default path must exist.
- `agents=<comma-list>` preserves the supplied strongest-to-weakest order. With a
  registry, every item is resolved by exact-case `name`. Without one, each item
  is treated directly as an exact provider model string using the inherited
  endpoint and authentication.
- `agents=auto:<comma-list>` resolves the exact-case names from the registry,
  restricts the pool to those entries, and ranks that pool automatically.

Control words are case-insensitive. Names and provider model strings are not.
Duplicates are detected case-sensitively.

## Registry and proxy responsibilities

The registry supplies an exact `modelString` plus the child endpoint metadata.
It does not create or provision 9Router or other reverse-proxy aliases.
Autoprompt assigns the configured string unchanged to a casting alias; Claude
Code may interpret client qualifiers such as `[1m]` before provider transmission.
The proxy target-not the virtual client ID-determines the actual backend.

See
[`docs/guides/9router-multi-provider-setup.md`](../../docs/guides/9router-multi-provider-setup.md)
for the verified alias and context-tier example.

## Claude Code pool constraints

The registry may contain any number of entries. A selected Claude Code pool
must contain one, two, or three unique provider model strings. More than three
fails because Autoprompt's current casting architecture binds only `opus`,
`sonnet`, and `haiku`; Claude Code's separate Fable family is outside R1-R5
casting.

Every selected entry must resolve to the same effective `baseUrl` and the same
effective `apiKeyEnv`. Omitting both from every selected entry means “inherit the
child's provider endpoint and authentication.” Mixing omitted and explicit
values, or selecting different values, fails. Claude Code cannot switch endpoint
or credentials per persona.

Heterogeneous upstream providers are valid when one model-aware reverse proxy
exposes every selected model through one endpoint and one credential source.

## Valid example: three upstreams behind one proxy

```json
[
  {
    "name": "DeepSeek-V3",
    "provider": "deepseek-via-router",
    "modelString": "deepseek-chat",
    "baseUrl": "http://localhost:20128/v1",
    "apiKeyEnv": "AUTOPROMPT_ROUTER_TOKEN",
    "effortHint": "high"
  },
  {
    "name": "Qwen-Max",
    "provider": "alibaba-via-router",
    "modelString": "qwen-max",
    "baseUrl": "http://localhost:20128/v1",
    "apiKeyEnv": "AUTOPROMPT_ROUTER_TOKEN",
    "effortHint": "high"
  },
  {
    "name": "GLM4",
    "provider": "zhipu-via-router",
    "modelString": "glm-4-plus",
    "baseUrl": "http://localhost:20128/v1",
    "apiKeyEnv": "AUTOPROMPT_ROUTER_TOKEN",
    "effortHint": "medium"
  }
]
```

This pool is executable in one child because all three entries share the proxy
endpoint and credential variable. `agents=auto` ranks `DeepSeek-V3`, `Qwen-Max`,
and `GLM4` by hint, with registry order breaking the high/high tie.

Direct provider endpoints can also be registered, but entries with different
direct endpoints or credential variables may only be selected in separate
Claude Code runs unless a shared proxy unifies them.

## Consumption

`agents/claude/workflow/model-casting.js` is the authoritative resolver. The POSIX and
PowerShell supervisors run it before launching the child, bind the selected
provider strings to `ANTHROPIC_DEFAULT_OPUS_MODEL`,
`ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL`, and export
non-secret `AUTOPROMPT_AGENT_CASTING` metadata. PREFLIGHT reports installed state
for diagnostics; INTAKE validates and records it. Neither can install new aliases
after the child has started.
