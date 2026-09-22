# Which coding agents are supported?

Autoprompt v2 supports eleven providers. The [README](../../README.md#support) lists their tested versions.

| Provider key | Package | Native integration |
| --- | --- | --- |
| `claude` | [Claude Code](../../agents/claude/) | Streamed native runs with controlled MCP tools |
| `codex` | [Codex](../../agents/codex/) | Canonical v2 controller and owned native execution |
| `opencode` | [OpenCode](../../agents/opencode/) | Native runs with a private controller tool projection |
| `kilo` | [Kilo](../../agents/kilo/) | Native runs with a private controller tool projection |
| `vscode` | [VS Code](../../agents/vscode/) | Owned extension host, BYOK model provider, and private conversations |
| `prime` | [Prime Agent](../../agents/prime/) | Owned native session worker and fixed tools |
| `omp` | [Oh My Pi](../../agents/omp/) | Native session transport and fixed tools |
| `deepseek` | [DeepSeek Harness](../../agents/deepseek/) | Owned Cordis SDK bridge and durable history |
| `hermes` | [Hermes Agent](../../agents/hermes/) | Owned plugin, native chat sessions, and SQLite usage records |
| `grok` | [Grok Build](../../agents/grok/) | Controller model proxy and isolated native process |
| `reasonix` | [Reasonix](../../agents/reasonix/) | Native streamed sessions and controlled tools |

Start a run with `autoprompt activate PROVIDER --target /absolute/project -- "<goal>"`.

The previously verified execution path is Linux. Native Windows Claude Code uses the bundled Bash/MSYS/Node runtime and can attempt the same closed capability checks using Windows process and sandbox controls, without WSL2 or a VM. The supported local controller scope is Node 20 or 24 on Windows x64 or ARM64. This is a local capability check on the installed binary, not a claim that every Windows version or machine has already been tested. Every required check must pass before a mission starts. The other native provider paths remain limited to the platforms named by their shipped test policies; an installer download alone does not establish runtime support.

Run `autoprompt doctor PROVIDER --strict` to check an installation. `payload=verified` means the installed files match their receipt. The separate `activation` field explains whether that native executable can proceed:

- `unavailable`: a required executable, interface, or admission prerequisite failed. The message names the failure and strict doctor exits unsuccessfully.
- `local-canary-required`: the installed runtime can attempt its shipped capability tests. Activation must run all of them successfully before starting work; doctor does not run those tests or contact a model.
- `static-ready;dynamic-preflight-required`: static admission is available, and activation must still prove its dynamic prerequisites.

Doctor inspects installation state without modifying it. Native version and help probes use temporary isolated directories. An informational doctor without `--strict` prints problems while returning success; use `--strict` when checking readiness in scripts. A passing strict check is not a substitute for the capability checks performed during activation.

See [setup and runtime requirements](../guides/harness-v2-verification.md) and [custom model setup](how-to-add-custom-models.md).
