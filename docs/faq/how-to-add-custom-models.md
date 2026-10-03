# How do I add custom models?

Version 2 resolves model choices through the public `autoprompt configure` command. This applies to every declared provider; configuration acceptance and runtime admission are separate checks. Start with an installed provider and its working native BYOK connection.

For one exact model identifier:

```sh
autoprompt configure claude --agents provider/model --effort low
```

Replace `claude` with the intended provider and use a model and effort that its adapter supports. To inherit the configured native default:

```sh
autoprompt configure claude --agents off
```

`--root /absolute/provider-config` selects a custom installation root. Supply the same root when installing, configuring, inspecting, and activating the provider.

## Multiple models and automatic selection

Multiple models require a fresh measured registry receipt. The receipt binds model capabilities, supported efforts, prices, observed latency, success measurements, and its validity period. A list of names or an `effortHint` does not establish those measurements.

```sh
autoprompt configure claude --agents provider/strong,provider/fast \
  --model-map /absolute/measured-registry.json --effort low
autoprompt configure claude --agents auto \
  --model-map /absolute/measured-registry.json
```

The shared adapters use the `codex-model-registry.v1` receipt contract; Reasonix retains `reasonix-model-registry.v1`. The validators reject stale, incomplete, or modified receipts. An explicit list limits the eligible models; it does not assign fixed models to historical role aliases. Selection uses the assignment's workload and verified effort capabilities. Model selection never changes the DIRECT, LIGHT, or ROADMAP task route.

Keep credentials in the provider's supported private credential source. Model selection does not create an upstream account, model alias, endpoint, or quota. Endpoint configuration belongs to the native connection, not the measured registry.

Codex's controlled BYOK catalog includes `z-ai/glm-5.3-flash` and `openai/gpt-5.6-luna` at `low` effort. Both have native OpenRouter transport evidence; full workflow acceptance remains a separate check. Use the exact identifiers, including the provider prefix. An arbitrary model name accepted by configuration does not establish a supported controlled transport. DeepSeek Flash returned invalid terminal envelopes in testing and is not enabled in Codex's controlled catalog.

See [v2 verification and native effort mappings](../guides/harness-v2-verification.md), the [provider support table](which-coding-agents-are-supported.md), and the [router connection guide](../guides/9router-multi-provider-setup.md). Non-Codex admission requires imported independent signed conformance, an exact matching reviewed release with a fresh native canary, or an explicit provider policy authorizing fresh local capability checks. Claude uses the local capability policy: all 11 checks must pass for the exact installed runtime and native executable before admission. Selecting a model does not bypass these checks.
