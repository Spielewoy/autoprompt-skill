---
name: autoprompt
description: "Explicit-only useful-first orchestration. Invoke /autoprompt to turn a mission into one executable roadmap, build dependency-safe lanes, and verify the result with independent reviewers. Never infer invocation from ordinary requests. Never resume from leftover artifacts without an explicit resume instruction."
---

# Autoprompt

Autoprompt is a useful-first orchestration loop. It stores the mission once, produces one independently approved executable roadmap, dispatches implementation-ready lanes directly, and proves the delivered behavior with real tests and fresh review.

## 1. Start contract

The invocation authorizes the mission. Do not ask the user to restate, narrow, or approve it.

Loading the skill or invoking it without a mission never starts or resumes a run, regardless of leftover artifacts. A bare invocation performs only the section-10 frontier check, reports the result, and stops.

Before spawning, resolve only undefined operator knobs:

- **Concurrency:** `tokensaver` (default, up to six live), `wide`/`billionaire` (all ready disjoint work up to the global ceiling), or `custom max_subs=N`.
- **Agent selection:** `off`/inherit. Grok Build subagents inherit the runtime model, so effort capability is exactly `inherited-only`; never claim a selectable effort.

In an attended session, ask all undefined knobs in one question before repository/tool work. In an unattended supervisor run, do not ask: default to `tokensaver` and `agents=off` and record the assumptions. A permission-bypass flag is not unattendedness.

After the chooser, dispatch the L1 scope coordinator `ap-scope-coordinator`; it dispatches the useful-first roadmap author. There is no separate intake round trip and no mandatory preflight agent.

An invoked mission always enters orchestration: the bounded scope topology is the minimum topology, and the main agent never silently self-triages an invoked mission into direct execution. Skipping or narrowing dispatch is an explicit decision recorded in `GATELOG.md` with its rationale, never a silent one.

## 2. Capability fast path

A supervisor may provide a versioned capability attestation bound to provider/runtime, CLI version, permission profile, agent selector, agent-definition hash, casting hash, effort status/source, and exact RUN/READ/WRITE success. Use it only when every binding matches the live launch. Missing, malformed, stale, unknown, or contradictory values are safe misses.

Without a trusted attestation, the first useful roadmap author proves RUN, READ, and WRITE against a disposable scratch path before repository inspection and then immediately continues. Any failure hard-stops before implementation. The preflight persona is diagnostic/recovery only.

## 3. Adaptive scope topology

Scope produces one canonical `ROADMAP.md`.

- **bounded:** roadmap author, then independent reviewer and blind fresh verifier concurrently - **3 agents, 2 rounds**, target under one minute;
- **multi-surface:** **exactly 5 agents, 3 rounds**, target under five minutes; retain the complete author roadmap and evidence, add exactly two complementary scouts, then concurrent reviewer plus fresh verifier without a redundant synthesis dispatch;
- **unusually-large:** may exceed the 6-agent ordinary budget only with a concrete recorded escalation reason.

External research runs only when current external facts are required. On rejection, retain accepted evidence and repair only named items. Empty roadmaps, invalid DAGs, overlapping ownership, missing frameworks/tests, and failed capability are hard failures.

## 4. Executable roadmap

`ROADMAP.md` is the new run's sole scope/decomposition/plan source. It includes mission pointer/hash and nonce; scope profile/escalation; repository intelligence; framework/tool decisions; stable item ids; category/tag/tier/framework; owned boundaries; dependencies and launch groups; integration lane; implementation steps; positive acceptance criteria; unhappy paths; tests first; real verification; >=95% changed-line and touched-module coverage; and `requiresDetailedPlan` only when needed.

Implementation-ready items dispatch directly to build. Add G1 only for debug/depth-lock work, a named unresolved design fork, `requiresDetailedPlan: true`, or a worker-reported plan conflict.

Decompose the mission into every genuinely disjoint lane. Never collapse a multi-surface mission into one "bounded" lane to shrink the roadmap; disjoint surfaces get disjoint lanes with disjoint ownership.

## 5. New-run governance

New-run governance is exactly:

1. `PROMPTS.txt` - exact append-only prompt blocks;
2. `ROADMAP.md` - canonical executable roadmap;
3. `GATELOG.md` - append-only transitions, persona/model/effort provenance, verdicts, hashes, elapsed time, and resume frontier.

Do not create new-run governance-only `BRIEF.md`, `PLAN.md`, `AGENTS.md`, `COVERAGE.md`, `BACKLOG.md`, `ANCHOR.md`, `bucketlist.md`, `intake.md`, `scope-map.md`, or per-angle scope files. Preserve substantive implementation/test/review/verification evidence. Legacy ledgers remain readable and contradictory mixed formats fail closed.

Governance lives at the run's governance root outside the mission target repository: `PROMPTS.txt`, `ROADMAP.md`, and `GATELOG.md` are never written into the target working tree and must never appear in its diff.

## 6. Compact pointer briefs

The first roadmap author stores the exact mission in `PROMPTS.txt`. Later briefs carry:

```text
MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.
path=<PROMPTS.txt> hash=sha256:<64 hex> bytes=<UTF-8 byte length> nonce=<RUN-NONCE>
```

Workers verify path, hash, byte length, and nonce before acting. Send only role, objective, boundary, dependencies, acceptance criteria, roadmap/evidence pointers with hashes, output schema/path, and model/effort status. Do not paste the mission, transcript, full roadmap, doctrine, or prior adversarial reasoning. Preserve blind review.

## 7. Hierarchy and dispatch

Every worker is an installed, registered `ap-*` persona. Its custom-agent definition plus the dispatched task brief are its complete operating context. A worker must never load, invoke, or re-invoke the Autoprompt skill or start a nested Autoprompt run; it executes only its persona instructions and assigned brief. Every dispatch binds the intended persona's registered name as the agent type: an anonymous, `general-purpose`, or dynamically invented agent is an invalid dispatch, and any child dispatch must name another registered `ap-*` persona.

- **L0 conductor:** starts the run and reports the end verdict. On a new run it dispatches only the named L1 coordinators - `ap-scope-coordinator` for scope, `ap-feature-coordinator` for build, `ap-sweep-coordinator` for convergence - never an L2 manager or an L3/L4 worker directly; a direct worker spawn is a skip-the-coordinator collapse. `ap-preflight-probe` and `ap-intake` remain diagnostic and legacy-resume exceptions, never routine spawns.
- **L1 coordinators** (`ap-scope-coordinator`, `ap-feature-coordinator`, `ap-sweep-coordinator`): own scope, feature fleet, or convergence and dispatch only. Each dispatches `ap-manager` for a multi-feature or multi-track slice, or named L3/L4 workers directly on a single bounded lane.
- **L2 manager** (`ap-manager`): optional for a multi-feature or multi-track slice; dispatches named L3/L4 workers and never executes.
- **L3 executors** (`ap-scoper`, `ap-researcher`, `ap-synthesizer`, `ap-planner`, `ap-implementer`, `ap-reviewer`, `ap-verifier`, `ap-sweeper`, `ap-execharness-resolver`, `ap-framework-generator`): do roadmap/scout/research/synthesis/planning/build/review/verification/sweep work.
- **L4 terminal leaves** (`ap-fresh-verifier`, `ap-depth-prober`, `ap-framework-validator`, `ap-juror`, `ap-goal-checker`, `ap-arbiter`, `ap-re-anchor`, `ap-scribe`, `ap-janitor`): do blind verification, depth-lock, framework validation, juries, goal check, arbitration, re-anchor, records, and cleanup.

L1 never executes. A single bounded lane skips L2. Dispatch ready disjoint work together spawn-all-then-collect: issue every spawn of a ready group before collecting any report - parallel background dispatch is the default shape, and serialization is allowed only for declared real dependencies. No self-review. Reuse valid evidence and avoid duplicate ownership.

Subagents extend the dispatching agent's work; they never replace it. The dispatcher keeps synthesis, integration, and final judgment. Ordinary implementation, planning, and read-relay workers must not re-derive context the dispatcher already holds. Independent assurance agents must independently re-derive relevant truth without reading one another's verdicts or consuming the author's success assertions.

Every dispatch is collect-then-stop: stop that agent explicitly once its final report is collected; a parked resumable agent is still a live agent and counts against the live ceiling. Never leave a finished agent idling for possible follow-ups.

## 8. Grok Build model and effort

Grok Build `ap-*` roles are native agent definitions installed with the skill. Each one pins `model: inherit`, so a child uses the run model the launcher resolved; casting is `inherited-only` and no per-role model selector is available. Because every hop is a fresh top-level process, the dispatcher reapplies the run-wide model and reasoning effort on each child and carries both forward in the sealed environment, so depth 4 runs the same model as depth 1. The launcher resolves them from either `AUTOPROMPT_GROK_MODEL` and `AUTOPROMPT_GROK_EFFORT` or the `--model`, `-m`, `--reasoning-effort`, and `--effort` flags typed on its own command line, whichever the operator used. Record effort as exactly `inherited-only` unless the operator set one run-wide reasoning effort.

Grok Build caps native subagent nesting at one level, so `spawn_subagent` can never carry the L0-L4 topology. Every `ap-*` definition therefore denies the native task tool, and every edge runs through the sealed dispatcher: it validates the launch activation, the caller persona, the canonical child allowlist, the depth ceiling of 4, the framework registry, and the exact bytes of the prompt ledger before it starts the child as its own `grok --prompt-file <envelope> --agent <definition>` process. Dispatch roles reach it through the `autoprompt` MCP server (`autoprompt__dispatch`); non-dispatch roles have MCP discovery removed, and the dispatcher refuses terminal callers regardless. Because Grok Build offers user-scoped MCP servers to every session, an activation token minted by the launcher is required before any dispatch: a session Autoprompt did not start has none and is refused, never treated as the conductor.

Dispatch a ready group in one call by passing `jobs`: every job is admitted before any child starts, the group then runs concurrently, and all reports are collected together. That is the spawn-all-then-collect shape, so reviewers, verifiers, and disjoint lanes really do run in parallel. The live-child ceiling is run-global, not per group: because every hop is its own process, the dispatchers of a run share file-backed slots keyed to the run activation, so the conductor, each coordinator, and each manager all draw from the same set. A dispatcher waiting on its own children yields its slot for that wait, which is what keeps a full run from deadlocking. The ceiling is `AUTOPROMPT_GROK_MAX_SUBS`, defaulting to the six live children `tokensaver` allows; raise it for `wide` or `custom max_subs=N`. A denied job cancels its whole group rather than leaving half a fleet running.

Scope of the seal: the activation token, persona, and depth travel in the child process environment. That stops an ordinary Grok Build session from entering a run and keeps a cooperating cast inside the canonical topology, and it is not a sandbox against a worker that goes out of contract: a role holding `Bash` can read its own environment and re-run the dispatcher with different values. Treat the allowlist as run correctness, and rely on Grok Build permission modes and the persona tool allowlists for containment.

Each definition carries an explicit `tools` allowlist built from the persona's canonical capabilities, using the Claude-compatible tool names Grok Build resolves natively. Unattended runs need an explicit permission mode: set `AUTOPROMPT_GROK_PERMISSION_MODE` to a Grok Build mode such as `acceptEdits` or `dontAsk`. The default is `default`, and `bypassPermissions` additionally requires `AUTOPROMPT_GROK_ALLOW_BYPASS=1`.

## 9. Build and verification

Use strict TDD: write and run the correct failing behavior test, implement the minimum change, refactor under green, run touched modules and direct dependents, and prove >=95% changed-line/touched-module coverage. Use real runners and systems. Do not mock the system under test or databases in integration tests.

Independent implementation review and runtime verification run concurrently when neither consumes the other's verdict. Debug work requires issue-derived red-to-green evidence and depth-lock at the deepest responsible function.

DONE requires full mission/roadmap coverage, zero open findings, usability, no pre-existing green-to-red regressions, >=95% changed-line coverage, real end-to-end exercise, successful ledger validation, zero live subagents, and cleanup when enabled.

## 10. Resume, steering, arbitration, and git

Resume is explicit: only an explicit `resume` instruction or a supervisor relaunch resumes a run; skill load, bare invocation, or leftover artifacts never do. The only startup read is the `GATELOG.md` tail - its last frontier row carries the mission pointer/hash, nonce, last accepted gate, and open item ids; report that status in under 150 words and stop when no frontier is active. On explicit resume, verify the pointer hash and dispatch the open frontier with compact pointer briefs; workers, not the resuming context, read `ROADMAP.md`, `PROMPTS.txt`, and substantive evidence. Treat temporary, empty, or unparsable artifacts as absent. Append later self-written steering to the next `PROMPTS.txt` block without rewriting history.

The arbiter decides technical forks. Ask the user mid-run only for genuinely user-owned irreversible/destructive actions, real money/quota, unavailable credentials, or product direction. Never arbitrate away capability failure, blockers, coverage, or real verification.

Do not commit, push, publish, deploy, spend money, delete user data, force-push, reset hard, or clean the working tree without explicit user authorization.

## 11. Run

Use Grok Build 1.0.0 or later, install the skill, and start through the launcher so the activation profile, the MCP dispatch registration, and the sealed depth-0 identity are checked first:

```text
~/.grok/skills/autoprompt/workflow/launch-grok.sh
/autoprompt <mission>
```

For an unattended supervisor run, drive the same launcher headlessly:

```text
AUTOPROMPT_GROK_PERMISSION_MODE=acceptEdits \
  ~/.grok/skills/autoprompt/workflow/launch-grok.sh -p "/autoprompt <mission>"
```

A successful install leaves `autoprompt.grok.toml` beside `config.toml`, the sealed dispatcher under `skills/autoprompt/workflow/`, and one `[mcp_servers.autoprompt]` registration in `config.toml`. Doctor verifies all three before recursive use.
