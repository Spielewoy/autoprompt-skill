# Gate contracts

`SKILL.md` is authoritative. This file defines the concise roadmap-first gate contract for Codex.

## 1. Runtime and governance

New runs are useful-first. There is no separate intake round trip, mandatory preflight agent, scope-map, or full-mission-first brief.

A trusted launch attestation may skip capability probing only when its provider/runtime, CLI version, permission profile, selector, agent-definition hash, casting hash, effort status/source, and RUN/READ/WRITE results all match the live launch. Otherwise the first roadmap author proves RUN, READ, and WRITE on a disposable scratch path, then continues into repository inspection. Failure hard-stops before implementation. The preflight persona is diagnostic/recovery only.

New-run governance is exactly:

1. `PROMPTS.txt` - exact append-only prompt blocks;
2. `ROADMAP.md` - the canonical executable scope, decomposition, and plan;
3. `GATELOG.md` - append-only transitions, provenance, verdicts, hashes, elapsed time, assumptions, escalation reasons, and resume frontier.

Do not create governance-only `BRIEF.md`, `AGENTS.md`, `bucketlist.md`, `PLAN.md`, `COVERAGE.md`, `BACKLOG.md`, `ANCHOR.md`, `intake.md`, `scope-map.md`, per-angle scope files, or equivalents. Substantive implementation, test, review, and verification evidence remains valid. Legacy formats are readable only to resume an existing run; never emit or extend them for a new run. Contradictory mixed governance fails closed.

Governance lives at the run's governance root outside the mission target repository: `PROMPTS.txt`, `ROADMAP.md`, and `GATELOG.md` are never written into the target working tree and must never appear in its diff.

The first roadmap author stores the exact mission in `PROMPTS.txt`. Every later brief starts with this verified mission pointer:

```text
MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.
path=<PROMPTS.txt> hash=sha256:<64 hex> bytes=<UTF-8 byte length> nonce=<RUN-NONCE>
```

The worker verifies path, hash, byte length, and nonce before acting. Then provide only role, objective, owned boundary, dependencies, acceptance criteria, hashed roadmap/evidence pointers, output contract/path, and truthful model/effort status. Do not paste the mission, transcript, full roadmap, doctrine, or prior adversarial reasoning. A missing or mismatched pointer is `INVALID-BRIEF`; do not guess or proceed.

Every gate uses a fresh context and writes substantive evidence before reporting. Negative verdicts also write evidence. No gate author reviews or verifies its own work.

## 2. Roadmap gate

Scope produces one canonical `ROADMAP.md`.

- **bounded:** one roadmap author, then an independent reviewer and blind fresh verifier concurrently - **3 agents, 2 rounds**;
- **multi-surface:** **exactly 5 agents, 3 rounds**; retain the complete author roadmap and evidence, add exactly two complementary scouts, then concurrent independent reviewer and blind fresh verifier without a redundant ordinary synthesis dispatch;
- **unusually-large:** exceed the 6-agent ordinary scope budget only with a concrete reason recorded in `GATELOG.md`.

External research runs only when current external facts are required. On rejection, retain accepted evidence and repair only named defects; do not restart accepted scope work.

`ROADMAP.md` must contain:

- mission pointer/hash and run nonce;
- scope profile and any escalation reason;
- repository intelligence and framework/tool decisions;
- stable item ids, category, optional tag, tier, and framework;
- owned boundaries, dependencies, launch groups, and an integration lane;
- implementation steps, positive acceptance criteria, unhappy paths, and tests-first steps;
- real verification commands and `>=95%` changed-line/touched-module coverage requirements;
- `requiresDetailedPlan: true|false` with a reason when true.

Empty roadmaps, invalid DAGs, overlapping ownership, missing frameworks or tests, and failed capability checks are hard failures.

The roadmap reviewer returns `SMASH | PASS`. The blind fresh verifier sees only the verified mission pointer and roadmap, reopens reality, and returns `REJECT | APPROVE`. They run concurrently and do not consume each other's reasoning. Freeze the roadmap only at the parent join when `review=PASS AND fresh=APPROVE`; otherwise repair the named defects and repeat the review pair.

Record each approved item before dispatch using the mechanically readable grammar:

```text
[at HH:MM DD.MM.YYYY] FEATURE-META <FID> tier=<T0|T1|T2|T3> framework=<leaf> issues=<N> [tag=<playbook>]
```

## 3. Gate routing

The approved roadmap is the default implementation contract. Dispatch ready items directly to G4. Add G1 only when an item is debug/depth-lock work, has a named unresolved design fork, sets `requiresDetailedPlan: true`, or returns `PLAN-CONFLICT` from implementation.

| Route | Gate path |
|---|---|
| implementation-ready roadmap item | G4 → {G5 ‖ G6} → optional G7 → G8 → GOAL-CHECK |
| conditional detailed plan | G1 → {G2 ‖ G3} → G4 → {G5 ‖ G6} → optional G7 → G8 → GOAL-CHECK |
| **T1** debug/depth-lock | G1 → {G2 ‖ G3} → G3.5 → G4 → {G5 ‖ G6} → G8 → GOAL-CHECK |

Tiers describe depth ceilings and risk, not a mandatory full pipeline. A framework may omit unnecessary gates but may not remove strict TDD, independent implementation review, runtime verification, the coverage floor, depth-lock for debug work, or GOAL-CHECK.

Ready disjoint items launch together within the selected concurrency and `agents.max_threads` ceilings, spawn-all-then-collect: issue every spawn of a ready group before collecting any report - parallel background dispatch is the default shape, and serialization is allowed only for declared real dependencies. Do not spawn agents merely to fill capacity, duplicate ownership, or recursively split a single analytical job.

Every dispatch is collect-then-stop: stop that agent explicitly once its final report is collected; a parked resumable agent is still a live agent and counts against the ceiling. Never leave a finished agent idling for possible follow-ups.

A wait on a dispatch is bounded: an `INVALID-DISPATCH` is a terminal dispatch failure that loops upward, never a wait-forever. Uncollected verdicts block DONE. Ending a turn while holding an uncollected dispatch is a failure, not a pause.

Author-independent verification is mandatory at every scope: the independent-verification floor never collapses with fan-out width - even a bounded lane with zero fan-out ends in independent review and verification. Verification must exercise the actual graded oracle target: the verifier names and runs the real fail-to-pass or oracle tests against the candidate diff; running only pre-patch suites or roadmap-conformance checks is NOT-VERIFIED, never a PASS. Dismissing a red test as documenting buggy behavior requires independent adjudication by an agent that did not author the change; the author never dismisses a red test alone. Concurrent blind assurance agents share no verdict channel: neither reads ledger rows carrying the other's verdict before reporting its own.

## G1: PLAN

G1 is conditional, never the default round trip. A planner reads the real artifact and writes `<artifacts>/<FID>-plan-vN.md` covering success, file-by-file changes, unhappy paths, tests first, real-system verification, risks, and the `>=95%` coverage argument. It does not write production code.

`PLAN-CONFLICT` returns here with the conflict and opened evidence. Do not silently diverge from the roadmap.

## G2: PLAN REVIEW

A reviewer distinct from the planner checks the detailed plan against the verified mission, roadmap item, real repository, unhappy paths, test strategy, and scope. Verdict:

```text
SMASH - numbered, evidence-backed reasons
PASS - every criterion is covered
```

G2 runs concurrently with G3. It never reads G3's verdict.

## G3: FRESH VERIFY

A blind verifier distinct from the planner and G2 reviewer receives the verified mission pointer and proposed detailed plan, but no review reasoning. It reads the real artifact and returns:

```text
REJECT - numbered mission, reality, or test gaps
APPROVE - the plan is complete and executable
```

For debug work, anchor independent re-derivation on the issue text and D4 adversarial repro. Reject a layer-shaped repro phrased in terms of the proposed patch's own mechanism.

G3 runs concurrently with G2 and never freezes the plan. The parent freezes substantive plan evidence only when `G2=PASS AND G3=APPROVE`; any negative returns to G1.

## G3.5: DEPTH-LOCK

G3.5 is mandatory and default-FAIL for every debug item. A fresh depth prober sees the verified mission, issue text, real code, and the proposed fix layer last. It derives D1-D5 blind to the proposed layer:

```text
D1 HOME FUNCTION - file:function where the behavior is decided, with why.
D2 WHOLE-CONTRACT INPUT-CLASS TABLE - every input, parameter, branch, and invariant; provenance must be issue-derived.
D3 DEEPEST CAUSE - the single deepest file:function that fixes all D2 classes; identify shallower symptom layers.
D4 ADVERSARIAL HIDDEN-ORACLE REPRO - issue-derived behavior test, not patch-mechanism-shaped, captured RED on unpatched code.
D5 DEPTH-LOCK VERDICT - PASS only when frozen fix LAYER == D3 deepest cause AND D4 is RED unpatched; otherwise REJECT - depth-miss.
```

Write `<artifacts>/<FID>-depth-lock.md` with D1-D5 and captured D4 output. Record the result using:

```text
[at HH:MM DD.MM.YYYY] <FID> G3.5 DEPTH-LOCK (ap-depth-prober): PASS - artifact <FID>-depth-lock.md tag=debug fixlayer=<file:function>
```

`REJECT - depth-miss` returns to G1. Never implement over a wrong-layer plan. The fix LAYER must equal the D3 deepest cause, and D4 must be a real captured red baseline.

## G4: IMPLEMENT

The implementer follows the roadmap item or approved G1 plan using strict TDD:

1. write the correct behavior test first;
2. run it and capture the expected failure;
3. implement the minimum change;
4. refactor under green;
5. run touched modules and direct dependents;
6. prove `>=95%` changed-line and touched-module coverage.

Use real runners and systems. Do not mock the system under test or databases in integration tests. Handle unhappy paths explicitly. If the contract is wrong, stop with `PLAN-CONFLICT` rather than improvising.

Write `<artifacts>/<FID>-impl-vN.md` with changed files, tests, real output, coverage, and deviations. Record G4 only after the TDD red and green evidence exists.

## G5: IMPLEMENTATION REVIEW

A reviewer who did not implement the item checks mission/roadmap coverage, claim versus diff, correctness, unhappy paths, test quality, coverage evidence, dead code, and scope creep. Verdict is `SMASH | PASS`, with file:line evidence for every failure. Write `<artifacts>/<FID>-impl-review-vN.md`.

G5 runs concurrently with G6 because both consume the G4 diff, not each other's verdict. A SMASH returns to G4, or G1 when the contract itself is wrong.

## G6: VERIFY

A verifier distinct from the implementer and G5 reviewer proves behavior by running it. Write `<artifacts>/<FID>-verify-vN.md` containing exact commands and captured output for:

- the target behavior after the change;
- for debug work, the issue-derived D4 repro RED before and GREEN after;
- pre-existing tests for touched modules and direct dependents, with zero green-to-red regressions;
- adversarial unhappy-path inputs;
- `coveragePercent >= 95` for changed lines and touched modules.

Verdict is `VERIFIED | FAILED`. A decorative verdict without captured runner output, a debug fix without red-to-green evidence, any green-to-red regression, or coverage below 95 is `FAILED`. FAILED returns to G4.

G6 runs concurrently with G5. Advance only when `G5=PASS AND G6=VERIFIED`. Concurrent execution never permits self-review.

## G7: SIGN-OFF

Run G7 only when the roadmap or selected framework requires independent risk sign-off. Jurors are fresh, independent of G1-G6, and run concurrently. Each sees the verified mission pointer, roadmap item, diff, and hashed evidence pointers, but no prior adversarial reasoning.

Each juror is default-FAIL and returns `PASS | FAIL` with opened evidence. Required seats must be unanimous. A P0/P1 failure cannot be arbitrated into PASS.

## G8: SCRIBE

The scribe evaluates nothing and edits no production code. It appends the gate transition, persona, exact model/effort status, artifact hash, verdict, elapsed time, and frontier to `GATELOG.md`. It may write or update substantive evidence named by the gate, but creates no additional governance ledger.

G8 does not commit or push. No git, publication, deployment, money, quota, or destructive action is authorized by the run.

## SWEEP

After implementation lanes join, a fresh sweeper re-derives mission and roadmap coverage from the verified pointers, inspects the touched neighborhood, and reports severity-ranked findings with file:line evidence. It must not trust prior verdicts or repeat already closed findings.

Open findings re-enter as roadmap items at the lowest correct gate: G4 for a local implementation defect; G1 for debug/depth-lock, an unresolved design issue, or a true plan conflict. Reuse valid evidence.

## GOAL-CHECK

A fresh, adversarial, default-FAIL goal checker sees the verified mission and evidence pointers, not prior reasoning. DONE requires all of:

- every prompt block and roadmap item delivered on opened evidence;
- zero open findings and no silent severity downgrade;
- a usable entry point and real end-to-end exercise;
- zero pre-existing green-to-red regressions;
- changed-line and touched-module coverage `>=95%`;
- for debug work, issue-derived D4 red-to-green proof and fix LAYER equal to the D3 deepest cause;
- successful validation of `PROMPTS.txt`, `ROADMAP.md`, `GATELOG.md`, and substantive evidence;
- zero live subagents - every spawned agent is stopped, none left parked.

Verdict is `DONE | NOT-DONE`. NOT-DONE names every unmet item and routes it back through the gate rule above. Arbitration cannot waive capability failure, blockers, coverage, depth-lock, or real verification.

## 4. GATELOG grammar

Gate rows are append-only and mechanically readable:

```text
[at HH:MM DD.MM.YYYY] <FID> G1 PLAN (ap-planner): <PASS|SMASH> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G2 PLAN REVIEW (ap-reviewer): <PASS|SMASH> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G3 FRESH VERIFY (ap-fresh-verifier): <APPROVE|REJECT> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G4 IMPLEMENT (ap-implementer): <PASS|PLAN-CONFLICT> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G5 IMPLEMENTATION REVIEW (ap-reviewer): <PASS|SMASH> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G6 VERIFY (ap-verifier): <VERIFIED|FAILED> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G7 SIGN-OFF (ap-juror): <PASS|FAIL> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G8 SCRIBE (ap-scribe): logged - frontier=<state>
[at HH:MM DD.MM.YYYY] <FID> GOAL-CHECK (ap-goal-checker): <DONE|NOT-DONE> - artifact <path>
```

Preserve the G3.5 and FEATURE-META forms exactly as defined above. Legacy rows remain parseable but never become templates for new writes.

## 5. Resume, Codex configuration, and authority

Resume is explicit: only an explicit `resume` instruction or a supervisor relaunch resumes a run. The resuming context reads only the `GATELOG.md` tail - the last frontier row with its mission pointer/hash, nonce, last accepted gate, and open item ids - verifies the pointer hash, and dispatches the open frontier with compact pointer briefs. Workers, not the resuming context, read `ROADMAP.md`, `PROMPTS.txt`, and substantive evidence. Treat temporary, empty, malformed, or hash-mismatched artifacts as absent. Re-verify the last accepted frontier and continue idempotently. Legacy ledgers may supply a frontier, but are read-only compatibility inputs.

Codex agent selection uses installed custom-agent TOML and its exact `model` and `model_reasoning_effort` capabilities. It does not use Claude Code model aliases or alias routing. One selected model routes every role to that model; multiple models preserve operator order and assign stronger models to reasoning-heavy roles without changing gates or concurrency.

Record effort as exactly `selectable`, `inherited-only`, `unsupported`, or `unknown`. When selectable, use the verified maximum for roadmap work, planning, review, blind/runtime verification, juries, goal check, arbitration, and depth-lock; ordinary implementation defaults high. Otherwise omit the effort field and record the truthful fallback. Exported definitions, selector metadata, and the live launch must match or explicit selection fails.

Configure sufficient `agents.max_depth` and `agents.max_threads` for the chosen hierarchy and concurrency. These are ceilings, never spawn targets.

Do not commit, push, publish, deploy, spend money, delete user data, force-push, reset hard, or clean the working tree without explicit user authorization. The supervisor grants relaunch and resume only.
