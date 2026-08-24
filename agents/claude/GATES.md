# Gate contracts

This is the authoritative roadmap-first gate contract. New runs are useful-first: store the mission once, approve one executable roadmap, dispatch implementation-ready lanes directly, and verify independently. There is no separate intake round trip and no mandatory preflight agent.

## Start and scope

Resolve only undefined operator knobs before repository work. In attended runs, ask concurrency and agent selection together once. In unattended runs, default deterministically and record the assumptions. A permission-bypass flag is not unattendedness.

A trusted launch attestation or trusted supervisor attestation may satisfy RUN/READ/WRITE capability only when its version and live-launch bindings match. Otherwise the first useful roadmap author probes RUN, READ, and WRITE through a disposable scratch path, then continues immediately. Failure is a hard stop. `ap-preflight-probe` and `ap-intake` are diagnostic, recovery, and legacy-resume personas, not active new-run stages.

Scope produces one canonical `ROADMAP.md`:

- **Bounded:** one author, then an independent reviewer and blind fresh verifier concurrently; **3 agents, 2 rounds**.
- **Multi-surface:** **exactly 5 agents, 3 rounds**; retain the first author's complete roadmap, add exactly two complementary scouts concurrently, then run reviewer and fresh verifier concurrently. No redundant ordinary synthesis dispatch.
- **Unusually large:** may exceed the 6-agent ordinary budget only when the roadmap records a concrete escalation reason. Extra scouts own disjoint themes.

Assurance failures repair only named roadmap items while preserving accepted evidence. Structural failures - empty roadmap, invalid dependencies, overlapping ownership, missing frameworks/tests, or failed capability - fail closed.

## Executable roadmap

`ROADMAP.md` is the sole scope, decomposition, and implementation-plan source for a new run. It records:

- mission pointer/hash and RUN-NONCE;
- scope profile and any escalation reason;
- repository intelligence and framework/tool decisions;
- stable feature/lane id, objective, category, optional playbook tag, tier, and framework leaf;
- owned paths or boundary, dependencies, launch group, and integration lane;
- implementation steps, positive acceptance criteria, unhappy paths, and tests-first work;
- real verification commands or discovery instructions;
- strict TDD and the >=95% changed-line and touched-module coverage bar;
- `requiresDetailedPlan: true` only when a separate G1 plan is genuinely required.

Every feature classification written to the gate log uses exactly:

```text
FEATURE-META <FID> tier=<T0|T1|T2|T3> framework=<leaf> issues=<N> [tag=<playbook>]
```

A known implementation-ready roadmap lane dispatches directly to G4. G1 is conditional: use it for debug/depth-lock work, an unresolved design fork, `requiresDetailedPlan: true`, or a worker-reported PLAN-CONFLICT. G1 is never a compulsory restatement of an already executable roadmap item.

## New-run governance

New-run governance is exactly:

1. `PROMPTS.txt` - exact, append-only `=== PROMPT N ===` blocks;
2. `ROADMAP.md` - the approved canonical executable roadmap;
3. `GATELOG.md` - append-only transitions, persona/model/effort provenance, verdicts, artifact hashes, elapsed scope topology, and the resume frontier.

Do not create new-run governance-only `BRIEF.md`, `PLAN.md`, `AGENTS.md`, `COVERAGE.md`, `BACKLOG.md`, `ANCHOR.md`, `bucketlist.md`, `intake.md`, `scope-map.md`, or per-angle scope files. Keep substantive implementation, test, review, verification, sign-off, and sweep evidence while needed.

Governance lives at the run's governance root outside the mission target repository: `PROMPTS.txt`, `ROADMAP.md`, and `GATELOG.md` are never written into the target working tree and must never appear in its diff.

Legacy formats remain readable only for resume compatibility. Never require or rewrite them for a new run. Contradictory mixed-format claims fail closed.

## Compact pointer briefs

The first roadmap author receives the exact mission and writes `PROMPTS.txt`. Every later brief uses a verified mission pointer envelope:

```text
MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.
path=<PROMPTS.txt> hash=sha256:<64 hex> bytes=<UTF-8 byte length> nonce=<RUN-NONCE>
```

The worker verifies path, hash, byte length, and nonce before acting. The brief then carries only role, objective, owned boundary, dependencies, acceptance criteria, roadmap section pointer/hash, optional raw-evidence pointer, output schema/artifact path, and resolved model/effort status.

Do not paste the full mission, transcript, roadmap, doctrine, or prior adversarial reasoning into later briefs. Reviewer independence is load-bearing: send the mission pointer, candidate artifact, real repository, and raw evidence, never another reviewer's verdict or reasoning.

## Routing and independence

- L0 starts the run and reports the end verdict. On a new run it dispatches only the named L1 coordinators, never an L2 manager or an L3/L4 worker directly; a direct worker spawn is a skip-the-coordinator collapse.
- L1 coordinators (`ap-scope-coordinator`, `ap-feature-coordinator`, `ap-sweep-coordinator`) own scope, feature-fleet, or convergence state and dispatch only.
- L2 (`ap-manager`) is optional for a multi-feature or multi-track slice.
- L3 executors plan, implement, review, verify, synthesize, research, or sweep.
- L4 leaves independently fresh-verify, depth-probe, judge, goal-check, arbitrate, record, or clean.

A single bounded lane skips L2. Dispatch ready disjoint work spawn-all-then-collect: issue every spawn of a ready group before collecting any report - parallel background dispatch is the default shape, and serialization is allowed only for declared real dependencies. Never duplicate live ownership.

Every dispatch is collect-then-stop: stop that agent explicitly once its final report is collected; a parked resumable agent is still a live agent and counts against the ceiling. Never leave a finished agent idling for possible follow-ups.

A wait on a dispatch is bounded: an `INVALID-DISPATCH` is a terminal dispatch failure that loops upward, never a wait-forever. Uncollected verdicts block DONE. Ending a turn while holding an uncollected dispatch is a failure, not a pause.

No agent reviews, verifies, signs off, or goal-checks work it authored. Author-independent verification is mandatory at every scope: the independent-verification floor never collapses with fan-out width - even a bounded lane with zero fan-out ends in independent review and verification. Verification must exercise the actual graded oracle target: the verifier names and runs the real fail-to-pass or oracle tests against the candidate diff; running only pre-patch suites or roadmap-conformance checks is NOT-VERIFIED, never a PASS. Dismissing a red test as documenting buggy behavior requires independent adjudication by an agent that did not author the change; the author never dismisses a red test alone. Concurrent blind assurance agents share no verdict channel: neither reads ledger rows carrying the other's verdict before reporting its own. Personas are fixed: G1 `ap-planner`; G2/G5 `ap-reviewer`; G3 `ap-fresh-verifier`; G3.5 `ap-depth-prober`; G4 `ap-implementer`; G6 `ap-verifier`; G7 `ap-juror`; G8 `ap-scribe`. G2 and G3 run concurrently when both apply. G5 and G6 run concurrently when both apply. Neither sibling receives the other's verdict. All required siblings complete before the join; a negative verdict loops upward.

## Tier contracts

The roadmap assigns the tier. The framework leaf may narrow a path, and a local lane escalates one tier when its redo budget is spent or reality reveals broader scope. Never de-escalate completed depth.

| Tier | Gate path ceiling |
|---|---|
| **T0** | implementation-ready roadmap → G4 → {G5, G6} → GOAL-CHECK. Debug adds conditional G1/G3, then G3.5 before G4. |
| **T1** | implementation-ready roadmap → G4 → {G5, G6} → GOAL-CHECK. Debug: G1 → G3 → G3.5 → G4 → {G5, G6}. |
| **T2** | roadmap-direct G4 unless G1 is conditional; then {G5, G6} → one G7 juror → mini-sweep → GOAL-CHECK. Debug always includes G3.5 before G4. |
| **T3** | conditional G1; if used, {G2, G3} jointly freeze it; then G3.5 for debug, G4, {G5, G6}, unanimous G7 panel, convergence sweep, GOAL-CHECK. |

`apply` remains a narrow framework path: G4 → G5 → G6 → GOAL-CHECK. Framework selection is mandatory before dispatch. Unknown or absent leaves are invalid until a valid leaf is generated and validated.

## G1: PLAN

**Use only when conditional routing requires it. Persona:** `ap-planner`.

Inputs: verified mission pointer; exact roadmap item and boundary; repository/raw-evidence pointer; named trigger for G1; any numbered rejection or PLAN-CONFLICT reasons.

Output: a focused plan with success criteria, file-by-file changes, unhappy paths, strict TDD sequence, real-system steps, risks, and a >=95% coverage argument. A debug plan must capture the issue-derived RED repro before choosing a fix layer, state a falsifiable root-cause hypothesis, enumerate at least two competing causes, and name the proposed layer as `file::function`.

For a full plan loop, dispatch G2 and G3 concurrently. Freeze only when G2 returns PASS and G3 returns APPROVE. Any failure returns to G1 with numbered reasons. A depth-miss also returns to G1.

## G2: PLAN REVIEW

**Persona:** `ap-reviewer`. The reviewer did not author the plan.

Review the mission, roadmap item, real repository, raw evidence, and proposed plan. Check mission coverage, reality, ownership, dependencies, unhappy paths, test strength, executable commands, and scope creep. Return `PASS` or `SMASH` with numbered repair reasons. Do not read G3's verdict.

## G3: FRESH VERIFY

**Persona:** `ap-fresh-verifier`. Fresh context, default-REJECT.

Read only the verified mission, candidate plan or roadmap item, real repository, and raw evidence. Do not read G2 or any prior adversarial reasoning. APPROVE only when exact execution would satisfy the mission without hand-waving or untested assumptions.

For debug re-derivation, anchor on the issue text and D4 evidence: independently reconstruct the failing behavior and reject a patch-shaped or layer-shaped repro. The issue text, not a proposed mechanism, defines the behavioral oracle. Return `APPROVE` or `REJECT` with numbered reasons. The joint controller freezes only after every required assurance verdict passes.

## G3.5: DEPTH-LOCK

**Persona:** `ap-depth-prober`. Mandatory for every debug feature at every tier, after a candidate fix layer exists and before G4. Default-FAIL. It cannot be skipped on resume.

The prober sees the verified issue-text mission and real repository first, blind to the proposed fix layer. It derives and records:

- **D1 HOME FUNCTION:** the file:function where the behavior is decided, with why.
- **D2 WHOLE-CONTRACT INPUT-CLASS TABLE:** every relevant input, parameter, branch, state, and invariant class; include the issue-derived gold-revealing class.
- **D3 DEEPEST CAUSE:** the single deepest `file::function` whose correction fixes all D2 classes. Mark any symptom-layer candidate `SHALLOW - deeper cause at <file:function>`.
- **D4 ADVERSARIAL HIDDEN-ORACLE REPRO:** the strongest maintainer assertion derived from the issue title/text, never phrased in terms of the proposed patch mechanism. Run it against unpatched code and capture real RED output. Planned or prose-only failure is not RED evidence.
- **D5 DEPTH-LOCK VERDICT:** PASS only when the frozen fix layer equals D3 exactly and D4 is proven RED unpatched; otherwise REJECT with `depth-miss` reasons.

Only after D1-D4 are fixed may the prober reveal and compare the sealed proposed layer. Mechanically recompute the verdict; do not trust prose. A missing artifact, missing RED proof, mismatched `fixlayer=`, or skipped resume path is P0. On PASS, append a G3.5 row carrying `tag=debug fixlayer=<frozen-layer>` and retain the D1-D5 artifact. On REJECT, return to G1; never implement at the wrong layer.

## G4: IMPLEMENT

**Persona:** `ap-implementer`.

Inputs: verified mission pointer; implementation-ready roadmap lane or frozen conditional plan; boundary/dependencies; acceptance and unhappy paths; optional raw evidence; G3.5 artifact for debug.

Use strict TDD:

1. write a behavior/regression test that fails for the right reason;
2. run it and capture RED;
3. implement the minimum change;
4. refactor under green;
5. run touched modules and direct dependents;
6. prove >=95% changed-line and touched-module coverage.

Use real runners and real systems. Do not mock the system under test or a database in integration tests. Treat unhappy paths at happy-path detail. Stay inside ownership. If reality contradicts the roadmap or frozen plan, stop and return `PLAN-CONFLICT`; never silently diverge.

## G5: IMPLEMENTATION REVIEW

**Persona:** `ap-reviewer`, distinct from the implementer.

Inspect mission, roadmap/plan, real diff, tests, and raw evidence. Match every implementation claim to file:line evidence. Check correctness, code quality, scope, unhappy paths, and test adequacy. Return `PASS` or `SMASH` with numbered file:line reasons. Do not consume G6's verdict.

## G6: VERIFY

**Persona:** `ap-verifier`, distinct from implementer and reviewers.

Prove behavior by running it. Record exact commands and verbatim before/after output. For debug work, prove the issue-derived asserting test RED on unpatched or safely stashed code and GREEN after; name the real runner, collected count, and asserting test id. Re-run pre-existing tests for every touched module and direct dependents; any green-to-red regression is a hard failure. Exercise adversarial inputs and measure >=95% changed-line and touched-module coverage. Return `VERIFIED` only when structured evidence agrees; otherwise `FAILED` and loop to G4.

## G7: SIGN-OFF

**Persona:** one or more fresh `ap-juror` leaves, never an author of the work.

Judge the verified mission, roadmap/plan, real diff, and opened evidence. Return binary `PASS` or `FAIL` with numbered evidence. The full required panel must convene and pass unanimously. A missing juror or a P0/P1 finding cannot be arbitrated into PASS.

## G8: SCRIBE

**Persona:** `ap-scribe`. Records; never evaluates or edits production code.

For a new run, keep only `PROMPTS.txt`, `ROADMAP.md`, and append-only `GATELOG.md` as governance. Record exact feature/gate transitions, persona/model/effort provenance, verdict, artifact/hash, framework, tier, elapsed scope topology, and dependency/resume frontier. Preserve required `FEATURE-META` and debug G3.5 tokens. Legacy files may be read for resume but are not created, required, modernized, or rewritten.

G8 does not imply git authority. Do not commit, push, publish, deploy, spend money, delete user data, force-push, reset hard, or clean the working tree unless the user explicitly authorized that action.

## SWEEP

The sweep is fresh and mission-first. Re-derive all asks from the mission pointer, inspect the delivered code and neighborhood, run the thing, and report deduplicated P0-P3 findings with file:line evidence. T0/T1 may rely on GOAL-CHECK; T2 uses one mini-sweep; T3 converges. New P0/P1 findings re-enter the appropriate lane and gates. Never downgrade a blocker to make DONE possible.

## GOAL-CHECK

A fresh `ap-goal-checker` is independent, adversarial, and default-NOT-DONE. Re-derive every mission and roadmap ask from the exact prompt ledger. DONE requires all of the following:

- every mission and roadmap item is evidenced complete;
- zero open findings at any severity and zero open P0/P1 blockers;
- the deliverable is user-usable through a real entry point;
- no pre-existing green-to-red regression;
- changed-line and touched-module coverage is >=95%;
- a real end-to-end exercise covers scope, original prompt, and potential flaws;
- all required gate and ledger provenance reconciles;
- zero live subagents - every spawned agent is stopped, none left parked.

For issue-derived acceptance, the fix LAYER must equal the D3 deepest cause and the D4 repro must be captured RED before the patch and GREEN after. Verdict prose never overrides structured negative evidence.

## Resume, steering, and external actions

Resume is explicit: only an explicit `resume` instruction or a supervisor relaunch resumes a run. The resuming context reads only the tail of append-only `GATELOG.md` - the last frontier row (mission pointer/hash, nonce, last accepted gate, open item ids) - verifies the pointer hash, and dispatches the open frontier with compact pointer briefs. Workers, not the resuming context, read root `PROMPTS.txt`, their `ROADMAP.md` sections, and substantive surviving evidence. Treat `.tmp`, empty, hollow, or unparsable artifacts as absent. Reuse valid evidence and rerun only incomplete or rejected gates. A debug resume re-runs G3.5 before G4/G6/DONE.

Append later self-written steering bytes as the next prompt block; never overwrite earlier prompts. Route urgent changes to affected lanes and queue additive changes for the next dependency boundary.

The arbiter resolves technical forks and continues. Ask the user mid-run only for genuinely user-owned destructive/irreversible actions, real money or quota, credentials only the user holds, or product direction. Arbitration cannot waive capability failure, open blockers, no-self-review, strict TDD, real verification, depth-lock, or the >=95% coverage floor.
