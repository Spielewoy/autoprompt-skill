<p align="center">
  <img src="../../assets/banner.svg" alt="Autoprompt Skill：粉色云朵与飞翔的大雁" width="1000"/>
</p>

<p align="center">Autoprompt 是一个编程智能体工作流，通过审查、修复和重新验证工作成果，将失败率降低 45%。</p>

<p align="center">
  <a href="#基准测试"><img src="https://img.shields.io/badge/Terminal--Bench%202.1-%2B14.61%20%E5%88%86-965477?style=flat-square&labelColor=302335" alt="Terminal-Bench 2.1：提高 14.61 分"/></a>
  <a href="https://github.com/Spielewoy/autoprompt-skill/releases/latest"><img src="https://img.shields.io/github/v/release/Spielewoy/autoprompt-skill?style=flat-square&label=%E7%89%88%E6%9C%AC&color=965477&labelColor=302335" alt="版本：v1.0.4"/></a>
  <a href="#安装"><img src="https://img.shields.io/badge/%E6%94%AF%E6%8C%81-9-965477?style=flat-square&labelColor=302335" alt="支持：9"/></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-965477?style=flat-square&labelColor=302335" alt="许可证：MIT"/></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="zh.md"><b>中文</b></a> |
  <a href="ko.md">한국어</a> |
  <a href="es.md">Español</a> |
  <a href="ar.md">العربية</a>
</p>

## 目录

[安装](#安装) · [基准测试](#基准测试) · [调用](#调用结构) · [运行控制](#运行控制) · [工作方式](#工作方式) · [智能体](#智能体) · [示例](#示例) · [常见问题](#常见问题) · [许可证](#许可证)

## 安装

使用下面的 CLI，或从 [GitHub Releases](https://github.com/Spielewoy/autoprompt-skill/releases/tag/v1.0.4) 下载安装程序。

### 1. 安装 CLI

```bash
npm install -g autoprompt-skill
```

### 2. 启动安装程序

```bash
autoprompt
```

### 3. 安装

选择编码工具，确认路径，然后安装。`N` 表示输入其他路径。

要使用其他 CLI 或 IDE，请选择 `Custom coding agent`，并参考[兼容性指南](../guides/custom-agent-compatibility.md)。

<details>
<summary><strong>从源码安装</strong></summary>

```bash
git clone https://github.com/Spielewoy/autoprompt-skill
cd autoprompt-skill
npm install -g .
autoprompt
```

</details>

### 要求

- [Node.js 20+](https://nodejs.org/en/download)
- [Python 3.11+](https://www.python.org/downloads/)，命令名为 `python`，并安装 [PyYAML](https://pypi.org/project/PyYAML/)
- macOS 或 Linux 需要 [Bash 4.3+](https://www.gnu.org/software/bash/)
- 只有从 GitHub 安装时需要 [Git](https://git-scm.com/downloads)

### 支持范围

| 状态 | 编码工具 | 已验证要求 | 标识 |
|---|---|---|---|
| 可用 | [Claude Code](https://code.claude.com/docs/en/setup) | 2.1.219+；已验证 2.1.233 | `claude` |
| 可用 | [Codex](https://github.com/openai/codex) | 支持子智能体的版本；已验证 0.148.0 | `codex` |
| 可用 | [OpenCode](https://opencode.ai/docs/agents) | 1.18.7+；已验证 1.18.18 | `opencode` |
| 可用 | [Kilo Code](https://kilo.ai/docs/customize/custom-subagents) | 7.4.22+；已验证 7.4.22 | `kilo` |
| 可用 | [VS Code](https://code.visualstudio.com/docs/agents/subagents) | 1.133+；已验证 VS Code 1.133.0 和 Copilot 0.61.0 | `vscode` |
| 可用 | [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | 0.7.2；已验证 0.7.2；原生包适配器 | `prime` |
| 可用 | [Oh My Pi](https://omp.sh/) | 17.4.0+；已在 17.4.0 上验证适配器契约、安装生命周期和原生角色载荷 | `omp` |
| 可用 | [DeepSeek Harness](https://deepseek.com/harness/en/) | 0.1.0-rc.7+；已在 0.1.0-rc.7 上验证适配器契约、安装生命周期和原生角色载荷 | `deepseek` |
| 可用 | [Reasonix](https://reasonix.io/docs/) | 1.30.0+；已在 1.30.0 上验证适配器契约、安装生命周期和原生角色载荷 | `reasonix` |

更多信息见[支持与验证说明](../faq/which-coding-agents-are-supported.md)。

### 检查、更新或卸载

- 检查所有检测到的安装：`autoprompt doctor --strict`
- 检查一个编码工具：`autoprompt doctor PROVIDER --strict`
- 更新或修复：运行 `autoprompt`，再选择已安装的编码工具
- 交互式卸载：`autoprompt uninstall`
- 卸载一个编码工具：`autoprompt uninstall PROVIDER`
- 查看所有命令：`autoprompt help`

请将 `PROVIDER` 替换为支持表中的标识，例如 `claude`、`codex` 或 `prime`。

## 基准测试

以下为 **版本 1 的基准测试**。版本 2 的测试结果将在之后发布。

<p align="center">
  <img src="../../assets/i18n/zh/terminal-bench-2.1-leaderboard.svg" width="1000" alt="Terminal-Bench 2.1 排行榜：18 个 Artificial Analysis 参考分数，以及 DeepSeek V4 Flash 0731 使用和不使用 Autoprompt 的实测分数。"/>
</p>

<details>
<summary><strong>OpenCode 实测对比</strong></summary>

<p align="center">
  <img src="../../assets/i18n/zh/terminal-bench-2.1.svg" width="900" alt="OpenCode 1.18.7 在 Terminal-Bench 2.1 上的结果：OpenCode 完成 89 项中的 60 项，加入 Autoprompt 后完成 73 项。"/>
</p>

| 运行方式 | 完成 | 得分 | 失败 |
|---|---:|---:|---:|
| OpenCode | 60/89 | 67.42% | 29 |
| **OpenCode + Autoprompt** | **73/89** | **82.02%** | **16** |
| **变化** | **+13 项** | **+14.61 分** | **在版本 1 测试中减少 45%** |

</details>

DeepSeek 的 82.7% 来自它自己的测试设置，不能当作可直接比较的第三次运行。请查看[测试设置与证据范围](../benchmarks/terminal-bench-2.1.md)，或[申请新的基准测试](https://github.com/Spielewoy/autoprompt-skill/issues/new)。

<details>
<summary><strong>预期开销：</strong>耗时约为 3x，token 约为 2x。</summary>

没有保留耗时和 token 日志，因此这些数字只是根据用户体验报告做出的规划估算，并非实测基准数据。本次实测的失败数从 29 降至 16（在版本 1 测试中减少 45%），也就是错误数约减半（约 2x 改善）。小任务上的结果可能相差很大。

</details>

## 调用结构

```text
/autoprompt mode=custom max_subs=4 agents=auto <goal>
```

| 参数 | 作用 |
|---|---|
| `/autoprompt` | 启动技能。 |
| `mode=custom` | 并发模式：tokensaver、wide 或 custom。 |
| `max_subs=4` | 最多同时运行四个子智能体。 |
| `agents=auto` | 自动选择、使用当前模型（off）或指定列表。 |
| `<goal>` | 描述目标、约束和验证方法。 |
| `path=` | 工作路径：auto、direct、light 或 roadmap。 |

Codex 示例:

```bash
autoprompt activate codex -- path=light "<goal>"
```


## 运行控制

使用 `mode=` 设置并发；编码工具支持时，可用 `agents=` 路由模型。

| 控制项 | Claude Code | Codex | OpenCode | Kilo | VS Code | Prime Agent | Oh My Pi | DeepSeek Harness | Reasonix |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `mode=` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 自定义 `agents=` 路由 | ✓ | ✓ | ✕ 不支持 - 沿用当前模型 | ✕ 不支持 - 沿用当前模型 | ✕ 不支持 - 沿用当前模型 | ✕ 不支持 - 沿用所选父模型 | ✕ 不支持 - 沿用所选父模型 | ✕ 不支持 - 沿用所选父模型 | ✕ 不支持 - 沿用所选父模型 |

## 工作方式

<p align="center">
  <a href="../../assets/i18n/zh/how-it-works-loop.svg"><img src="../../assets/i18n/zh/how-it-works-loop.svg" alt="Autoprompt 从提示词到规划、构建、审查、测试、签署和全面检查的流程" width="1100"/></a>
</p>

## 智能体

<p align="center">
  <a href="../../assets/i18n/zh/how-it-works-hierarchy.svg"><img src="../../assets/i18n/zh/how-it-works-hierarchy.svg" alt="Autoprompt 智能体层级：提示词、协调者、管理者、执行线路和独立检查" width="1100"/></a>
</p>

## 示例

| 目标 | 提示词 |
|---|---|
| 修复 | `/autoprompt 修复注册竞态问题并添加回归测试` |
| 构建 | `/autoprompt mode=wide 构建从 API 到结账的预订流程` |
| 研究 | `/autoprompt 对照此代码库比较任务队列并推荐一个方案` |
| 限制并发 | `/autoprompt mode=custom max_subs=4 迁移所有模型` |

在 Codex 中请使用 `autoprompt activate codex -- "<goal>"`，不要使用 `/autoprompt`。在 Oh My Pi 中请使用 `/skill:autoprompt`。

## 常见问题

<details>
<summary><strong>用了 Autoprompt，我真的就不用写提示词了吗？</strong></summary>

不是。你需要给出明确的目标、约束条件和成功标准。Autoprompt 会处理执行循环，因此你不必为每一步都写提示词。[详情](../faq/does-autoprompt-mean-i-do-not-have-to-prompt.md)

</details>

<details>
<summary><strong>Autoprompt 能自主完成到什么程度？</strong></summary>

它可以围绕目标确定工作范围，并完成实现、测试、审查、修复和验证。遇到会改变结果的选择、需要你授权的操作或无法安全解决的阻塞时，它会停下来。[详情](../faq/how-autonomous-is-autoprompt.md)

</details>

<details>
<summary><strong>分层有什么用？</strong></summary>

各层将协调、管理、执行和独立判断分开。这种分离可以避免同一个智能体同时规划、批准并验证自己的工作。[详情](../faq/what-are-the-layers-for.md)

</details>

<details>
<summary><strong>这些工作路径是什么？</strong></summary>

`path=auto` 自动选择路径。`direct` 直接执行明确的任务，`light` 先制定简要计划，`roadmap` 规划有依赖关系的工作。所有路径都包含独立验证。 [详情](../faq/work-paths.md)

</details>

<details>
<summary><strong>`mode`、`max_subs` 和 `agents` 分别控制什么？</strong></summary>

`mode=tokensaver` 将活跃子智能体限制为六个；`mode=wide` 打开所有就绪线路；`mode=custom max_subs=N` 设置自定义上限；`agents` 在工具支持时控制模型路由。[详情](../faq/tokensaver-vs-wide-vs-custom.md)

</details>

<details>
<summary><strong>为什么 Autoprompt 不会在后台启动？</strong></summary>

因为它会改变成本、耗时和工作流。请使用 `/autoprompt <目标>` 显式启动；Codex 中使用 `autoprompt activate codex -- "<goal>"`。

</details>

## 许可证

[MIT](../../LICENSE)。版权所有 2026 [Spielewoy](https://github.com/Spielewoy)。

社区：[贡献指南](../CONTRIBUTING.md)、[行为准则](../CODE_OF_CONDUCT.md)、[安全政策](../SECURITY.md)和[支持](../SUPPORT.md)。
