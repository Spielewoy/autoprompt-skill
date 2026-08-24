---
name: autoprompt
description: >
  Explicit-only useful-first orchestration. Invoke only when the user names autoprompt - typed
  as /autoprompt or in plain language such as "act in autoprompt mode" - to turn
  a mission into one executable roadmap, build dependency-safe lanes, and verify
  the result with independent reviewers. Do not infer invocation from requests
  that never name autoprompt. Never resume from leftover artifacts without an
  explicit resume instruction.
disable-model-invocation: true
user-invocable: true
argument-hint: "[mode=tokensaver|wide|custom] [max_subs=N] [agents=off|auto|<models>] <mission|resume>"
allowed-tools: Agent, AskUserQuestion, TaskCreate, TaskUpdate, TaskGet, TaskList, Workflow
---

# Autoprompt

Autoprompt is a useful-first orchestration loop. It stores the mission once, produces one independently approved executable roadmap, dispatches implementation-ready lanes directly, and proves the delivered behavior with real tests and fresh review.

## 1. Start contract

The invocation authorizes the mission. Do not ask the user to restate, narrow, or approve it.

Loading the skill or invoking it without a mission never starts or resumes a run, regardless of leftover artifacts. A bare invocation performs only the section-10 frontier check, reports the result, and stops.

Before spawning, resolve only undefined operator knobs:

- **Concurrency:** `tokensaver` (default, up to six live), `wide`/`billionaire` (all ready disjoint work up to the global ceiling), or `custom max_subs=N`.
- **Agent selection:** `off`/inherit, `auto`, or an explicit model list. Before offering this choice, state provider and effort capability as exactly `selectable`, `inherited-only`, `unsupported`, or `unknown`. If selectable, state the verified maximum.

In an attended session, ask all undefined knobs in one `AskUserQuestion` call before any repository/tool work. In an unattended supervisor run, do not ask: default to `tokensaver` and `agents=off` and record the assumptions. A permission-bypass flag is not unattendedness.

After the chooser, dispatch the L1 scope coordinator `ap-scope-coordinator`; it dispatches the useful-first roadmap author. There is no separate intake round trip and no mandatory preflight agent.

An invoked mission always enters orchestration: the bounded scope topology is the minimum topology, and the main agent never silently self-triages an invoked mission into direct execution. Skipping or narrowing dispatch is an explicit decision recorded in `GATELOG.md` with its rationale, never a silent one.

## 2. Capability fast path

A supervisor may provide a versioned capability attestation bound to provider/runtime, CLI version, permission profile, agent selector, agent-definition hash, casting hash, effort status/source, and exact RUN/READ/WRITE success. Use it only when every binding matches the live launch. Missing, malformed, stale, unknown, or contradictory values are safe misses.

Without a trusted attestation, the first useful roadmap author proves RUN, READ, and WRITE against a disposable scratch path before repository inspection, then immediately continues. Any failure hard-stops the run before implementation. `ap-preflight-probe` remains a diagnostic/recovery persona only.

## 3. Adaptive scope topology

Scope produces one canonical `ROADMAP.md`.

### Bounded

- One useful-first roadmap author.
- Independent roadmap reviewer and blind fresh verifier concurrently.
- **3 agents, 2 rounds.**
- Target: under one minute.

### Multi-surface

Multi-surface scope uses **exactly 5 agents, 3 rounds**:

- Retain the first author's complete roadmap and repository evidence.
- Add exactly two complementary scouts concurrently.
- Run reviewer and blind fresh verifier concurrently.
- Do not pay a redundant ordinary synthesis dispatch.
- Target: under five minutes.

### Unusually large

Unusually-large scope may exceed the 6-agent ordinary budget only when `ROADMAP.md` records a concrete escalation reason. Additional scouts own disjoint themes. External research runs only when current external facts are required; repository-only work does not pay a research round trip.

On assurance failure, retain accepted evidence and repair only named roadmap items. Never rerun the whole scope wave by default. Structural failures - empty roadmap, invalid dependency DAG, overlapping ownership, missing frameworks/tests, or failed capability - remain fail-closed.

## 4. Executable roadmap contract

`ROADMAP.md` is the sole scope/decomposition/plan source for a new run. It includes:

- mission pointer/hash and RUN-NONCE;
- scope profile and any escalation reason;
- repository intelligence and framework/tool decisions;
- stable feature/lane id, objective, category/tag, tier, and framework leaf;
- owned paths/boundary, dependencies, launch group, and integration lane;
- implementation steps, positive acceptance criteria, unhappy paths, and tests first;
- real verification commands/discovery instructions;
- the >=95% changed-line and touched-module coverage requirement;
- `requiresDetailedPlan` only when genuinely needed.

Approved implementation-ready items dispatch directly to implementation. Add G1 planning only for debug/depth-lock work, an explicit unresolved design fork, `requiresDetailedPlan: true`, or a worker-reported plan conflict.

Decompose the mission into every genuinely disjoint lane. Never collapse a multi-surface mission into one "bounded" lane to shrink the roadmap; disjoint surfaces get disjoint lanes with disjoint ownership.

## 5. New-run governance

New-run governance is exactly:

1. `PROMPTS.txt` - exact append-only `=== PROMPT N ===` blocks;
2. `ROADMAP.md` - canonical executable roadmap;
3. `GATELOG.md` - append-only transitions, persona/model/effort provenance, verdicts, artifact hashes, elapsed time, and resume frontier.

Do not create new-run governance-only `BRIEF.md`, `PLAN.md`, `AGENTS.md`, `COVERAGE.md`, `BACKLOG.md`, `ANCHOR.md`, `bucketlist.md`, `intake.md`, `scope-map.md`, or per-angle scope files. Keep substantive implementation, test, review, sign-off, sweep, and verification evidence while it is needed.

Governance lives at the run's governance root outside the mission target repository: `PROMPTS.txt`, `ROADMAP.md`, and `GATELOG.md` are never written into the target working tree and must never appear in its diff.

Legacy ledgers remain readable for resume compatibility. Contradictory mixed-format claims fail closed. Do not rewrite historical artifacts merely to modernize them. `track.md` is appended only after work is complete and verified under project rules.

## 6. Compact pointer briefs

The first roadmap author receives the exact mission and writes `PROMPTS.txt`. Later briefs carry:

```text
MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.
path=<PROMPTS.txt> hash=sha256:<64 hex> bytes=<UTF-8 byte length> nonce=<RUN-NONCE>
```

Every later worker verifies path, hash, byte length, and nonce before acting. Send only role, objective, owned boundary, dependencies, acceptance criteria, roadmap section pointer/hash, optional raw-evidence pointer, output schema/artifact path, and resolved model/effort status.

Do not paste the full mission, transcript, roadmap, doctrine, or previous adversarial reasoning. Preserve blind review: reviewer and fresh verifier receive the mission, candidate roadmap, real repository, and raw evidence only. Upward reports stay <=150 words.

## 7. Hierarchy and dispatch

Every worker is an installed, registered `ap-*` persona. Its agent file plus the dispatched task brief are its complete operating context. A worker must never load, invoke, or re-invoke the Autoprompt skill or start a nested Autoprompt run; it executes only its persona instructions and assigned brief. Every dispatch binds the intended persona's registered name as the agent type: an anonymous, `general-purpose`, or dynamically invented agent is an invalid dispatch, and any child dispatch must name another registered `ap-*` persona.

- **L0 conductor:** starts the run and reports the end verdict. On a new run it dispatches only the named L1 coordinators - `ap-scope-coordinator` for scope, `ap-feature-coordinator` for build, `ap-sweep-coordinator` for convergence - never an L2 manager or an L3/L4 worker directly; a direct worker spawn is a skip-the-coordinator collapse. `ap-preflight-probe` and `ap-intake` remain diagnostic and legacy-resume exceptions, never routine spawns.
- **L1 coordinators** (`ap-scope-coordinator`, `ap-feature-coordinator`, `ap-sweep-coordinator`): own scope, feature fleet, or convergence state; dispatch only. Each dispatches one `ap-manager` per multi-feature or multi-track slice, or named L3/L4 workers directly on a single bounded lane.
- **L2 manager** (`ap-manager`): optional for a multi-feature or multi-track slice; dispatches named L3/L4 workers and never executes.
- **L3 executors** (`ap-scoper`, `ap-researcher`, `ap-synthesizer`, `ap-planner`, `ap-implementer`, `ap-reviewer`, `ap-verifier`, `ap-sweeper`, `ap-execharness-resolver`, `ap-framework-generator`): roadmap/scout/research/synthesis/planning/implementation/review/verification/sweep work.
- **L4 leaves** (`ap-fresh-verifier`, `ap-depth-prober`, `ap-framework-validator`, `ap-juror`, `ap-goal-checker`, `ap-arbiter`, `ap-re-anchor`, `ap-scribe`, `ap-janitor`): blind verification, depth-lock, framework validation, jurors, goal check, arbitration, re-anchor, scribe, janitor.

L1 never reads/writes/runs. A single bounded lane skips L2 and dispatches L3 directly. Dispatch ready disjoint work spawn-all-then-collect: issue every spawn of a ready group before collecting any report - parallel background dispatch is the default shape, and serialization is allowed only for declared real dependencies. Do not duplicate live ownership. No agent reviews or verifies work it authored.

Subagents extend the dispatching agent's work; they never replace it. The dispatcher keeps synthesis, integration, and final judgment. Ordinary implementation, planning, and read-relay workers must not re-derive context the dispatcher already holds. Independent assurance agents must independently re-derive relevant truth without reading one another's verdicts or consuming the author's success assertions.

Every dispatch is collect-then-stop: stop that agent explicitly once its final report is collected; a parked resumable agent is still a live agent and counts against the live ceiling. Never leave a finished agent idling for possible follow-ups.

## 8. Model and effort

Agent selection changes only model/effort routing, not gates or concurrency.

### Claude Code

Claude Code routing uses `opus`, `sonnet`, and `haiku`. One selected model fills all three aliases. Therefore `agents=claude-fable-5` routes every role to canonical `claude-fable-5`. Two models map stronger to `opus`/`sonnet` and weaker to `haiku`; three map strongest/middle/weakest. More than three fails explicitly.

### Codex

Codex uses its actual per-agent model and reasoning-effort configuration. Do not copy Claude alias claims into Codex routing.

### Effort

When the provider exposes a verified selectable maximum, use it for scope/coordinator/scouts/synthesis, roadmap/planning, review/blind fresh verification, runtime verification, jurors/goal check, arbitration, and depth-lock. Ordinary implementation defaults high; design/root-cause-heavy implementation may use maximum. Mechanical record/cleanup roles may be lower.

If effort is `inherited-only`, `unsupported`, or `unknown`, omit the per-call field and record the truthful fallback.

## 9. Build and verification

Implementation uses strict TDD:

1. write a failing behavior/regression test;
2. run it and confirm the correct red reason;
3. implement the minimum change;
4. refactor under green;
5. run touched modules and direct dependents;
6. prove >=95% changed-line and touched-module coverage.

Use real runners and real systems. Do not mock the system under test or a database in integration tests. Handle unhappy paths at happy-path detail.

Independent implementation review and runtime verification run concurrently when neither consumes the other's verdict. A debug feature also requires issue-derived red-to-green evidence and depth-lock at the deepest responsible function.

DONE requires every mission and roadmap item delivered; zero open findings; user usability; no pre-existing green-to-red regressions; >=95% changed-line coverage; a real end-to-end exercise; successful ledger validation; zero live subagents; and janitor completion when enabled.

## 10. Resume, steering, and arbitration

Resume is explicit: only an explicit `resume` instruction or a supervisor relaunch resumes a run. Skill load, a bare invocation, or the mere presence of prior artifacts never does.

The frontier check is the only startup read: the tail of `GATELOG.md` alone. Its last frontier row carries the mission pointer/hash, nonce, last accepted gate, and open item ids; report that status in under 150 words. No active frontier means no active run - stop there.

On explicit resume, verify the frontier pointer hash, then dispatch the open frontier with section-6 pointer briefs. Workers read only their own roadmap sections and evidence; the resuming context never bulk-reads `PROMPTS.txt`, `ROADMAP.md`, or evidence. Treat half-written `.tmp`, empty, or unparsable artifacts as absent. Reuse valid evidence; rerun only incomplete or rejected gates.

Append later self-written steering bytes to the next prompt block in `PROMPTS.txt`. Route urgent steering to affected lanes; queue additive steering for the next boundary. Never overwrite earlier prompt blocks.

The arbiter decides technical forks and continues. Ask the user mid-run only for genuinely user-owned irreversible/destructive actions, real money/quota, credentials only the user holds, or product direction. Never let arbitration waive capability failure, open P0/P1 blockers, coverage, or real verification.

## 11. Git and external actions

Do not commit, push, publish, deploy, spend money, delete user data, force-push, reset hard, or clean the working tree unless the user explicitly authorized that action. Verification and ledger recording do not imply publication authority.

## 12. How to run

Attended:

```text
/autoprompt mode=wide agents=claude-fable-5 <mission>
```

Unattended:

```powershell
powershell -File agents/claude/workflow/supervisor.ps1 --agents claude-fable-5 --cmd "claude --dangerously-skip-permissions -p" "<mission>"
```

```sh
sh agents/claude/workflow/supervisor.sh --agents claude-fable-5 --cmd "claude --dangerously-skip-permissions -p" "<mission>"
```

The supervisor relaunches an interrupted child until a fresh DONE sentinel appears or a bounded poison/scope guard escalates. It does not grant permission for outward-facing git or publication actions.
