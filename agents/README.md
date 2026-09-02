# Autoprompt source

This folder contains the complete Autoprompt product. The prompts, custom agents, gates, frameworks, and runtime harness are published here as readable source files.

## Provider packages

| Package | Entry | Custom agents | Frameworks | Transport |
|---|---|---:|---:|---|
| [Claude Code](claude/) | [`SKILL.md`](claude/SKILL.md) | [25 Markdown personas](claude/agents/) | [18 workflows](claude/frameworks/) | Recursive, with a [runtime harness](claude/workflow/) |
| [Codex](codex/) | [`SKILL.md`](codex/SKILL.md) | [25 TOML agents](codex/agents/) | [18 workflows](codex/frameworks/) | Recursive, with a [runtime harness](codex/workflow/) |
| [OpenCode](opencode/) | [`SKILL.md`](opencode/SKILL.md) | [25 Markdown agents](opencode/agents/) | [18 workflows](opencode/frameworks/) | Recursive, with a guarded activation profile |
| [Kilo](kilo/) | [`SKILL.md`](kilo/SKILL.md) | [25 Markdown agents](kilo/agents/) | [18 workflows](kilo/frameworks/) | Kilo uses recursive dispatch with a guarded profile |
| [Grok Build](grok/) | [`SKILL.md`](grok/SKILL.md) | [25 agent definitions](grok/agents/) | [18 workflows](grok/frameworks/) | Sealed headless re-entry through the [dispatcher](grok/workflow/) |
| [VS Code](vscode/) | [`SKILL.md`](vscode/SKILL.md) | [25 `.agent.md` agents](vscode/agents/) | [18 workflows](vscode/frameworks/) | VS Code uses recursive dispatch when its required setting is enabled |
| [Prime Agent](prime/) | [Package adapter](prime/package.json) and [skill](prime/skills/autoprompt/SKILL.md) | [25 persona prompts](prime/personas/) | [18 workflows](prime/prompts/frameworks/) | Recursive through the native package adapter |
| [Oh My Pi](omp/) | [`SKILL.md`](omp/SKILL.md) | [25 Markdown agents](omp/agents/) | [18 workflows](omp/frameworks/) | Recursive through native `task` dispatch and `spawns` allowlists |
| [DeepSeek Harness](deepseek/) | [`SKILL.md`](deepseek/SKILL.md) | [25 fixed-persona tools](deepseek/agents/) | [18 workflows](deepseek/frameworks/) | Recursive through the user preset or headless patch |
| [Reasonix](reasonix/) | [`SKILL.md`](reasonix/SKILL.md) | [25 native profiles](reasonix/skills/) | [18 workflows](reasonix/frameworks/) | Recursive through native subagent profiles |

Installer floors and audited releases are tracked in the [support matrix](../docs/faq/which-coding-agents-are-supported.md). Every shipped package above is pinned by a runtime manifest and generated from the same 25-persona, 18-framework contract.

## The five levels

L0 is the active provider skill. L1 to L4 are named custom agents generated from the shared persona contract.

| Level | Roles | Source |
|---|---|---|
| L0 | Conductor | [Claude](claude/SKILL.md), [Codex](codex/SKILL.md), [OpenCode](opencode/SKILL.md), [Kilo](kilo/SKILL.md), [Grok Build](grok/SKILL.md), [VS Code](vscode/SKILL.md), [Prime Agent](prime/skills/autoprompt/SKILL.md), [Oh My Pi](omp/SKILL.md), [DeepSeek Harness](deepseek/SKILL.md), [Reasonix](reasonix/SKILL.md) |
| L1 | Scope, feature, and sweep coordinators | [`ap-scope-coordinator`](contracts/personas/ap-scope-coordinator.md), [`ap-feature-coordinator`](contracts/personas/ap-feature-coordinator.md), [`ap-sweep-coordinator`](contracts/personas/ap-sweep-coordinator.md) |
| L2 | Optional manager for multi-lane work | [`ap-manager`](contracts/personas/ap-manager.md) |
| L3 | Scope, research, planning, build, review, verification, and sweep executors | [Persona directory](contracts/personas/) |
| L4 | Fresh verification, jury, goal check, arbitration, recording, and cleanup leaves | [Persona directory](contracts/personas/) |

All ten public packages use the same logical roles, gates, and recursive level links.

## Source of truth

- [`contracts/autoprompt.contract.json`](contracts/autoprompt.contract.json) defines the exact persona and framework inventory.
- [`contracts/personas`](contracts/personas/) contains all 25 canonical role prompts.
- [`contracts/frameworks`](contracts/frameworks/) contains all 18 gate workflows.
- [`scripts/generate-provider-contracts.cjs`](../scripts/generate-provider-contracts.cjs) produces the provider-native files.
- [`manifests`](manifests/) pins every installable runtime file by SHA-256.

Check the published source with:

```text
node scripts/generate-provider-contracts.cjs --check
node scripts/runtime-payload.cjs --check
```

Use the [root installer](../README.md#install) to install the complete package.
