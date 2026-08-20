# Model registry: the precise contract

The optional omp model registry lives at
`~/.omp/agent/autoprompt-models.json`. It maps exact-case names used in `agents=`
selectors to omp model selector strings and the one process-wide provider context
an omp child will use.

The registry is a JSON array of objects. Unknown fields are rejected.

## Schema

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Exact-case selector name, such as `DeepSeek-V3` |
| `provider` | yes | Informational provider label; arbitrary non-empty strings are accepted |
| `modelString` | yes | Exact omp model selector (e.g. `deepseek/deepseek-v4-flash`) assigned to the run's tiers |
| `baseUrl` | no | Absolute HTTP(S) endpoint used by the child |
| `apiKeyEnv` | no | **Name** of the environment variable holding the child endpoint credential |
| `effortHint` | no | Auto-ranking hint: `max`, `high`, `medium`, or `low` |

`apiKeyEnv` is never a key value. The registry and serialized casting metadata
contain only the variable name; the secret itself is never serialized.

## Selection semantics

- `agents=off` does not read or resolve the registry.
- `agents=auto` reads the full registry and ranks it by `effortHint`; registry
  order breaks ties. The default path must exist.
- `agents=<comma-list>` preserves the supplied strongest-to-weakest order. With a
  registry, every item is resolved by exact-case `name`. Without one, each item
  is treated directly as an exact omp model selector.
- `agents=auto:<comma-list>` resolves the exact-case names from the registry,
  restricts the pool to those entries, and ranks that pool automatically.

Control words are case-insensitive. Names and model selectors are not.
Duplicates are detected case-sensitively.

## Tier mapping

omp has no fixed alias pool. One to five selected model selectors map onto the
R1..R5 casting tiers: one selector fills every tier (all workers use it); more
selectors map strongest->R1 down to weakest->R5. The resolved per-tier selectors
are emitted as `selectors` in the serialized casting and applied by the conductor
as run-scoped `task.agentModelOverrides` project settings at the governance root,
so dispatch re-reads them without touching the user's global `config.yml`.

## Registry and proxy responsibilities

The registry supplies an exact `modelString` plus optional child endpoint
metadata. It does not create or provision 9Router or other reverse-proxy aliases.
Autoprompt assigns the configured string unchanged to the run's tiers. When the
selected pool carries no endpoint metadata, the child inherits its normal
provider configuration.

## omp pool constraints

The registry may contain any number of entries. A selected omp pool must contain
one to five unique model selectors; more than five fails because casting binds
only R1..R5.

Every selected entry must resolve to the same effective `baseUrl` and the same
effective `apiKeyEnv`. Omitting both from every selected entry means "inherit the
child's provider endpoint and authentication." Mixing omitted and explicit
values, or selecting different values, fails. omp cannot switch endpoint or
credentials per persona.

Heterogeneous upstream providers are valid when one model-aware reverse proxy
exposes every selected model through one endpoint and one credential source.

## Valid example: three upstreams behind one proxy

```json
[
  {
    "name": "DeepSeek-V3",
    "provider": "deepseek-via-router",
    "modelString": "deepseek/deepseek-chat",
    "baseUrl": "http://localhost:20128/v1",
    "apiKeyEnv": "AUTOPROMPT_ROUTER_TOKEN",
    "effortHint": "high"
  },
  {
    "name": "Qwen-Max",
    "provider": "alibaba-via-router",
    "modelString": "qwen/qwen-max",
    "baseUrl": "http://localhost:20128/v1",
    "apiKeyEnv": "AUTOPROMPT_ROUTER_TOKEN",
    "effortHint": "high"
  },
  {
    "name": "GLM4",
    "provider": "zhipu-via-router",
    "modelString": "zhipu/glm-4-plus",
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
direct endpoints or credential variables may only be selected in separate omp
runs unless a shared proxy unifies them.

## Consumption

`agents/omp/workflow/model-casting.js` is the authoritative resolver. The POSIX
and PowerShell supervisors run it before launching the child, verify every tier
selector resolved, and export the non-secret `AUTOPROMPT_AGENT_CASTING` metadata
to the child session; the conductor applies it as run-scoped
`task.agentModelOverrides` project settings. PREFLIGHT reports installed state
for diagnostics; INTAKE validates and records it. Neither can install new
selectors after the child has started.