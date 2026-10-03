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

The reviewed release table records Linux runs. The local canary policy authorizes a fresh attempt for each of the ten non-Codex providers on Linux, Windows, and macOS when the installed runtime and platform adapter are available. Windows uses process and sandbox controls including AppContainer and Jobs; macOS uses the native sandbox and owned-process controls. This is authorization to attempt a local capability check, not a claim that every provider/platform has passed or that every machine is supported. Every required check must pass before a mission starts; an installer download or doctor result alone does not establish runtime support. Codex follows its separate canonical validation route.

Native Windows Codex has additional prerequisites. Start Autoprompt from an
administrator controller and initialize the official Codex Windows sandbox
before activation. Codex `windows.sandbox="elevated"` selects the official
sandbox mode but does not elevate the Autoprompt controller. Each activation
uses a fresh offline account and a Windows Filtering Platform policy bound to
that account's exact SID. Autoprompt retains their activation lease across a
pause or resume. Permanent cleanup requires independently verified owned-Job
drain before it removes the account and network policy. If admission, resume
verification, drain, or cleanup cannot be proved, activation fails closed and
keeps the private recovery journals for repair.

Run `autoprompt doctor PROVIDER --strict` to check an installation. `payload=verified` means the installed files match their receipt. The separate `activation` field explains whether that native executable can proceed:

- `unavailable`: a required executable, interface, or admission prerequisite failed. The message names the failure and strict doctor exits unsuccessfully.
- `local-canary-required`: the installed runtime can attempt its shipped capability tests. Activation must run all of them successfully before starting work; doctor does not run those tests or contact a model.
- `static-ready;dynamic-preflight-required`: static admission is available, and activation must still prove its dynamic prerequisites.

Doctor inspects installation state without modifying it. Native version and help probes use temporary isolated directories. An informational doctor without `--strict` prints problems while returning success; use `--strict` when checking readiness in scripts. A passing strict check is not a substitute for the capability checks performed during activation.

See [setup and runtime requirements](../guides/harness-v2-verification.md) and [custom model setup](how-to-add-custom-models.md).
