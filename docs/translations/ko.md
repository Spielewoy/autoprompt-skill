<p align="center">
  <img src="../../assets/banner.svg" alt="Autoprompt Skill: 분홍색 구름과 날아가는 기러기" width="1000"/>
</p>

<p align="center">Autoprompt는 작업을 검토하고, 수정하고, 다시 검증하여 실패를 45% 줄이는 코딩 에이전트 워크플로입니다.</p>

<p align="center">
  <a href="#벤치마크"><img src="https://img.shields.io/badge/Terminal--Bench%202.1-%2B14.61%EC%A0%90-965477?style=flat-square&labelColor=302335" alt="Terminal-Bench 2.1: 14.61점 향상"/></a>
  <a href="https://github.com/Spielewoy/autoprompt-skill/releases/latest"><img src="https://img.shields.io/github/v/release/Spielewoy/autoprompt-skill?style=flat-square&label=%EB%B2%84%EC%A0%84&color=965477&labelColor=302335" alt="버전: v1.0.4"/></a>
  <a href="#설치"><img src="https://img.shields.io/badge/%EC%A7%80%EC%9B%90-9-965477?style=flat-square&labelColor=302335" alt="지원: 9"/></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/%EB%9D%BC%EC%9D%B4%EC%84%A0%EC%8A%A4-MIT-965477?style=flat-square&labelColor=302335" alt="라이선스: MIT"/></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="zh.md">中文</a> |
  <a href="ko.md"><b>한국어</b></a> |
  <a href="es.md">Español</a> |
  <a href="ar.md">العربية</a>
</p>

## 목차

[설치](#설치) · [벤치마크](#벤치마크) · [호출](#호출-구조) · [실행 제어](#실행-제어) · [작동 방식](#작동-방식) · [에이전트](#에이전트) · [예시](#예시) · [FAQ](#자주-묻는-질문) · [라이선스](#라이선스)

## 설치

아래 CLI를 사용하거나 [GitHub Releases](https://github.com/Spielewoy/autoprompt-skill/releases/tag/v1.0.4)에서 설치 프로그램을 받으세요.

### 1. CLI 설치

```bash
npm install -g autoprompt-skill
```

### 2. 설치 프로그램 실행

```bash
autoprompt
```

### 3. 설치

코딩 에이전트를 고르고 경로를 확인한 뒤 설치하세요. `N`은 다른 경로 입력입니다.

다른 CLI나 IDE에서는 `Custom coding agent`를 선택하고 [호환성 가이드](../guides/custom-agent-compatibility.md)를 따르세요.

<details>
<summary><strong>소스에서 설치</strong></summary>

```bash
git clone https://github.com/Spielewoy/autoprompt-skill
cd autoprompt-skill
npm install -g .
autoprompt
```

</details>

### 요구 사항

- [Node.js 20+](https://nodejs.org/en/download)
- `python` 명령으로 제공되는 [Python 3.11+](https://www.python.org/downloads/)와 [PyYAML](https://pypi.org/project/PyYAML/)
- macOS 또는 Linux에서는 [Bash 4.3+](https://www.gnu.org/software/bash/)
- GitHub에서 설치할 때만 [Git](https://git-scm.com/downloads)

### 지원 범위

| 상태 | 코딩 도구 | 검증 기준 | 키 |
|---|---|---|---|
| 지원 | [Claude Code](https://code.claude.com/docs/en/setup) | 2.1.219+; 2.1.233 검증 완료 | `claude` |
| 지원 | [Codex](https://github.com/openai/codex) | 서브에이전트 지원 빌드; 0.148.0 검증 완료 | `codex` |
| 지원 | [OpenCode](https://opencode.ai/docs/agents) | 1.18.7+; 1.18.18 검증 완료 | `opencode` |
| 지원 | [Kilo Code](https://kilo.ai/docs/customize/custom-subagents) | 7.4.22+; 7.4.22 검증 완료 | `kilo` |
| 지원 | [VS Code](https://code.visualstudio.com/docs/agents/subagents) | 1.133+; VS Code 1.133.0 및 Copilot 0.61.0 검증 완료 | `vscode` |
| 지원 | [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | 0.7.2; 0.7.2 검증 완료; 네이티브 패키지 어댑터 | `prime` |
| 지원 | [Oh My Pi](https://omp.sh/) | 17.4.0+; 17.4.0에서 어댑터 계약, 설치 수명주기, 네이티브 역할 페이로드 검증 완료 | `omp` |
| 지원 | [DeepSeek Harness](https://deepseek.com/harness/en/) | 0.1.0-rc.7+; 0.1.0-rc.7에서 어댑터 계약, 설치 수명주기, 네이티브 역할 페이로드 검증 완료 | `deepseek` |
| 지원 | [Reasonix](https://reasonix.io/docs/) | 1.30.0+; 1.30.0에서 어댑터 계약, 설치 수명주기, 네이티브 역할 페이로드 검증 완료 | `reasonix` |

[지원 및 검증 정보](../faq/which-coding-agents-are-supported.md)를 참고하세요.

### 검사, 업데이트 또는 제거

- 감지된 모든 설치 검사: `autoprompt doctor --strict`
- 한 코딩 에이전트 검사: `autoprompt doctor PROVIDER --strict`
- 업데이트 또는 복구: `autoprompt`를 실행하고 설치된 에이전트 선택
- 대화형 제거: `autoprompt uninstall`
- 한 코딩 에이전트 제거: `autoprompt uninstall PROVIDER`
- 전체 명령 보기: `autoprompt help`

`PROVIDER`는 지원 표의 키로 바꾸세요. 예: `claude`, `codex`, `prime`.

## 벤치마크

아래는 **버전 1 벤치마크**입니다. 버전 2 결과는 추후 공개됩니다.

<p align="center">
  <img src="../../assets/i18n/ko/terminal-bench-2.1-leaderboard.svg" width="1000" alt="Terminal-Bench 2.1 순위표: Artificial Analysis 참조 점수 18개와 Autoprompt 사용 전후의 DeepSeek V4 Flash 0731 실측 점수."/>
</p>

<details>
<summary><strong>직접 측정한 OpenCode 비교</strong></summary>

<p align="center">
  <img src="../../assets/i18n/ko/terminal-bench-2.1.svg" width="900" alt="Terminal-Bench 2.1의 OpenCode 1.18.7 결과: OpenCode는 89개 중 60개, Autoprompt를 사용한 OpenCode는 73개를 해결했습니다."/>
</p>

| 실행 | 해결 수 | 점수 | 실패 수 |
|---|---:|---:|---:|
| OpenCode | 60/89 | 67.42% | 29 |
| **OpenCode + Autoprompt** | **73/89** | **82.02%** | **16** |
| **변화** | **+13개 해결** | **+14.61점** | **45% 감소** |

</details>

DeepSeek의 82.7%는 자체 테스트 설정에서 나온 결과이므로 직접 비교할 수 있는 세 번째 실행이 아닙니다. [테스트 설정과 근거 범위](../benchmarks/terminal-bench-2.1.md)를 확인하거나 [새 벤치마크를 요청](https://github.com/Spielewoy/autoprompt-skill/issues/new)하세요.

<details>
<summary><strong>예상 비용:</strong> 시간은 약 3x, 토큰은 약 2x입니다.</summary>

시간과 토큰 로그를 남기지 않았으므로, 이 수치는 실측 벤치마크가 아니라 사용자 경험을 바탕으로 한 계획용 추정치입니다. 실제 측정에서는 실패가 29개에서 16개로 줄었고(45% 감소), 실수가 약 절반으로 줄어든 셈입니다(약 2x 개선). 아주 작은 작업에서는 결과가 크게 다를 수 있습니다.

</details>

## 호출 구조

```text
/autoprompt mode=custom max_subs=4 agents=auto <goal>
```

| 항목 | 설명 |
|---|---|
| `/autoprompt` | 스킬을 시작합니다. |
| `mode=custom` | 동시 실행: tokensaver, wide 또는 custom. |
| `max_subs=4` | 하위 에이전트를 최대 네 개까지 동시에 실행합니다. |
| `agents=auto` | 자동 선택, 현재 모델(off) 또는 모델 목록. |
| `<goal>` | 원하는 결과, 제약, 검증 방법을 설명합니다. |
| `path=` | 작업 경로: auto, direct, light 또는 roadmap. |

Codex 예시:

```bash
autoprompt activate codex -- path=light "<goal>"
```


## 실행 제어

`mode=`로 동시 실행을 설정하고, 호스트가 지원하면 `agents=`로 모델을 라우팅하세요.

| 제어 | Claude Code | Codex | OpenCode | Kilo | VS Code | Prime Agent | Oh My Pi | DeepSeek Harness | Reasonix |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `mode=` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 사용자 지정 `agents=` 라우팅 | ✓ | ✓ | ✕ 미지원 - 활성 모델 사용 | ✕ 미지원 - 활성 모델 사용 | ✕ 미지원 - 활성 모델 사용 | ✕ 미지원 - 선택한 부모 모델 사용 | ✕ 미지원 - 선택한 부모 모델 사용 | ✕ 미지원 - 선택한 부모 모델 사용 | ✕ 미지원 - 선택한 부모 모델 사용 |

## 작동 방식

<p align="center">
  <a href="../../assets/i18n/ko/how-it-works-loop.svg"><img src="../../assets/i18n/ko/how-it-works-loop.svg" alt="프롬프트에서 계획, 구현, 검토, 테스트, 승인, 전체 점검까지 이어지는 Autoprompt 흐름" width="1100"/></a>
</p>

## 에이전트

<p align="center">
  <a href="../../assets/i18n/ko/how-it-works-hierarchy.svg"><img src="../../assets/i18n/ko/how-it-works-hierarchy.svg" alt="프롬프트, 조정자, 관리자, 실행 레인, 독립 검사로 구성된 Autoprompt 에이전트 계층" width="1100"/></a>
</p>

## 예시

| 목표 | 프롬프트 |
|---|---|
| 수정 | `/autoprompt 등록 경쟁 조건을 수정하고 회귀 테스트를 추가해 줘` |
| 구축 | `/autoprompt mode=wide API부터 결제까지 예약 흐름을 구축해 줘` |
| 조사 | `/autoprompt 이 코드베이스에 맞는 작업 큐를 비교하고 하나를 추천해 줘` |
| 동시 실행 제한 | `/autoprompt mode=custom max_subs=4 모든 모델을 마이그레이션해 줘` |

Codex에서는 `/autoprompt` 대신 `autoprompt activate codex -- "<goal>"`를 사용하세요. Oh My Pi에서는 `/skill:autoprompt`를 사용하세요.

## 자주 묻는 질문

<details>
<summary><strong>Autoprompt를 쓰면 정말 프롬프트를 작성하지 않아도 되나요?</strong></summary>

아니요. 명확한 목표, 제약 조건, 성공 기준을 제공해야 합니다. Autoprompt가 실행 루프를 담당하므로 단계마다 프롬프트를 작성할 필요는 없습니다. [자세히 보기](../faq/does-autoprompt-mean-i-do-not-have-to-prompt.md)

</details>

<details>
<summary><strong>Autoprompt는 어디까지 자율적으로 처리하나요?</strong></summary>

목표의 범위를 정하고 구현, 테스트, 검토, 수정, 검증할 수 있습니다. 결과를 바꾸는 선택, 사용자 권한이 필요한 작업, 안전하게 해결할 수 없는 장애물에서는 멈춥니다. [자세히 보기](../faq/how-autonomous-is-autoprompt.md)

</details>

<details>
<summary><strong>계층을 나눈 이유는 무엇인가요?</strong></summary>

각 계층은 조정, 관리, 실행, 독립 판단을 분리합니다. 이 구조 덕분에 한 에이전트가 자신의 작업을 계획하고 승인하고 검증하는 일을 모두 맡지 않습니다. [자세히 보기](../faq/what-are-the-layers-for.md)

</details>

<details>
<summary><strong>작업 경로란 무엇인가요?</strong></summary>

`path=auto`는 경로를 선택합니다. `direct`는 명확한 작업을 시작하고, `light`는 간단한 계획을 추가하며, `roadmap`은 의존 관계가 있는 작업을 구성합니다. 모든 경로에 독립 검증이 포함됩니다. [자세히](../faq/work-paths.md)

</details>

<details>
<summary><strong>`mode`, `max_subs`, `agents`는 무엇을 제어하나요?</strong></summary>

`mode=tokensaver`는 활성 서브에이전트를 6개로 제한하고, `mode=wide`는 준비된 모든 작업을 엽니다. `mode=custom max_subs=N`은 사용자 지정 상한을 정하며, `agents`는 호스트가 지원할 때 모델 라우팅을 제어합니다. [자세히 보기](../faq/tokensaver-vs-wide-vs-custom.md)

</details>

<details>
<summary><strong>Autoprompt가 백그라운드에서 시작되지 않는 이유는 무엇인가요?</strong></summary>

비용, 시간, 작업 흐름이 달라지기 때문입니다. `/autoprompt <목표>`로 명시적으로 시작하고, Codex에서는 `autoprompt activate codex -- "<goal>"`를 사용하세요.

</details>

## 라이선스

[MIT](../../LICENSE). 저작권 2026 [Spielewoy](https://github.com/Spielewoy).

커뮤니티: [기여 안내](../CONTRIBUTING.md), [행동 강령](../CODE_OF_CONDUCT.md), [보안 정책](../SECURITY.md), [지원](../SUPPORT.md).
