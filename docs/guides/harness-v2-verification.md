# Run Autoprompt v2

Autoprompt supports eleven providers. See the [README support table](../../README.md#support) for provider keys and tested versions.

## Install and run

```sh
autoprompt install opencode
autoprompt configure opencode --agents off
autoprompt doctor opencode --strict
autoprompt activate opencode --target /absolute/project -- "fix the bug and test it"
```

Replace `opencode` with your provider. Use `--root /absolute/provider-config` on each command if you installed to a custom location. Finish or cancel a run before updating or uninstalling its runtime.

## Models and effort

Set up the provider's BYOK connection, then select its model:

```sh
autoprompt configure opencode --agents provider/model --effort high
```

The model must support the selected effort. Automatic selection and model lists also need `--model-map /absolute/measured-registry.json`. See [custom models](../faq/how-to-add-custom-models.md).

| Provider | Native effort values |
|---|---|
| Claude Code | `low`, `medium`, `high`, `xhigh`, `max` |
| Codex | `low`, `medium`, `high`, `xhigh` within its supported model catalog |
| OpenCode, Kilo | Model-specific variants: `low`, `medium`, `high`, `xhigh`, `max` |
| Prime Agent, Oh My Pi | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| DeepSeek Harness | `off`, `low`, `high`, `max` |
| VS Code | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| Grok Build | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| Hermes Agent | Grok's values plus `ultra`; OpenRouter maps `ultra` to `max` |
| Reasonix | Depends on the selected model and provider connection |

For custom OpenCode or Kilo models, define the selected variant's matching `reasoningEffort`. Unsupported values are rejected rather than silently ignored.

## Runtime requirements

The verified v2 execution path is Linux with Bubblewrap. VS Code also needs a graphical session or headless display. macOS and Windows installation support does not establish native execution support; see [configured Linux runtimes](../lima-runtime.md) for the explicit VM/WSL options.

Matching reviewed releases can activate after their local capability checks pass. Claude also has an explicit local capability policy, so it does not require imported signing keys or a pre-existing reviewed release record: all 11 fresh native checks must pass for the exact installed runtime and executable. `PROVIDER_UNSUPPORTED` means the installed runtime, native executable, or required capability does not match an accepted configuration. Run `autoprompt doctor PROVIDER --strict` and check the tested versions before retrying.

## Resume

```sh
autoprompt activate opencode --resume ACTIVATION_ID --target /absolute/project -- "the original request"
```

Keep the original request, target, provider configuration, and deadline. The activation ID identifies the saved run; resume does not start a new budget.
