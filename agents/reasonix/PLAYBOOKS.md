# Decomposition and playbooks

Every roadmap item has three independent axes:

1. **Category** - `plan`, `backend`, `frontend`, `data`, `integration`, `infra`, or `docs`.
2. **Optional playbook tag** - `debug`, `research`, `user-facing`, `polish`, or `external-target`.
3. **Tier** - `T0` trivial, `T1` bounded, `T2` feature, or `T3` ambitious.

The category defines ownership, the tag changes how planning or verification is performed, and the tier is a depth ceiling. A framework leaf declares the actual gate path. These axes never replace one another.

## Useful-first scope

There is no separate intake round trip on a new run. The first useful roadmap author proves RUN/READ/WRITE when no trusted launch attestation exists, inspects the repository, classifies scope, selects frameworks, and writes the executable `ROADMAP.md`.

- **Bounded:** one roadmap author, then independent reviewer and blind fresh verifier concurrently: 3 agents, 2 rounds.
- **Multi-surface:** retain the author's complete roadmap and evidence, run exactly two complementary scouts concurrently, then run reviewer and fresh verifier concurrently: exactly 5 agents, 3 rounds, with no redundant ordinary synthesis dispatch.
- **Unusually large:** may exceed 6 agents only when `ROADMAP.md` records a concrete escalation reason.

The accounting covers useful scope workers. Runtime orchestration does not add dedicated preflight, intake, or scope-coordinator round trips.

External research runs only when current external facts are necessary. Repository-only work does not pay a research round trip. A rejected roadmap keeps accepted scout evidence and repairs only named items.

## Executable roadmap

`ROADMAP.md` is the sole scope, decomposition, framework, and lane source of truth. Every item records:

- id, title, category, optional tag, proportional tier, and selected framework leaf;
- owned boundary, dependencies, launch group, and integration lane;
- implementation steps and positive acceptance criteria;
- unhappy paths and tests to write first;
- real verification instructions;
- the >=95% changed-line and touched-module coverage requirement;
- `requiresDetailedPlan` only when another design pass is truly required.

An implementation-ready item dispatches directly to implementation. G1 runs only for debug/depth-lock work, an explicit unresolved design fork, `requiresDetailedPlan: true`, or a worker-reported `PLAN-CONFLICT`.

Framework selection is a hard gate. An absent or unknown framework is invalid dispatch. A selector miss routes through framework generation and validation before implementation.

## Tier ladder

| Tier | Shape | Default depth |
|---|---|---|
| **T0** | obvious mechanical change | roadmap item -> implement -> review + verify -> goal-check |
| **T1** | one bounded change | roadmap item -> implement -> review + verify -> goal-check |
| **T2** | coherent multi-file feature | conditional plan only when required -> implement -> review + verify -> sign-off -> goal-check |
| **T3** | ambitious multi-feature mission | executable roadmap -> conditional per-item planning -> full build/verification -> sweep convergence -> goal-check |

A framework may declare a leaner sequence. GOAL-CHECK remains the universal floor. Workers may return `OUT-OF-SCOPE`, causing one-tier escalation; de-escalation never occurs.

## Ownership and parallelism

Split until each roadmap item has a truthful, disjoint boundary. Integration is its own item whenever independent parts must be wired together. Decompose the mission into every genuinely disjoint lane; never collapse a multi-surface mission into one "bounded" lane.

- Independent items share a launch group and run concurrently when the runtime permits.
- Dependencies create later launch groups.
- Homogeneous same-target edits belong in one batched implementation, not one agent per edit.
- Independent within-feature parts may fan out when boundaries are disjoint.
- Thin, duplicate, or recursive fan-out is invalid.

Use the minimum gates that catch the work's real failure modes and the maximum honest parallelism the dependency graph allows.

## Compact dispatch envelope

The exact mission is stored once in `PROMPTS.txt`. Later briefs contain only:

- role and objective;
- owned boundary and dependencies;
- positive acceptance criteria;
- mission pointer with canonical path, SHA-256 hash, UTF-8 byte length, and RUN-NONCE;
- roadmap section and evidence pointers with hashes;
- output schema;
- truthful model and effort status.

Do not paste the full mission, full roadmap, transcripts, doctrine, prior reviews, or implementer claims. A worker reads and verifies the pointers before acting. A mismatch is `INVALID-BRIEF`.

Never spawn read-relay agents: a coordinator reads the files it needs itself. Roadmap and plan size stay proportional to the change size.

New-run governance is exactly `PROMPTS.txt`, `ROADMAP.md`, and append-only `GATELOG.md`. Governance lives at the run's governance root outside the mission target repository: the three files are never written into the target working tree and must never appear in its diff. Do not create governance-only `BRIEF.md`, `PLAN.md`, `AGENTS.md`, `COVERAGE.md`, `BACKLOG.md`, `ANCHOR.md`, `bucketlist.md`, `intake.md`, `scope-map.md`, or per-angle files. Legacy files remain readable on explicit resumes.

## Playbook tags

### `debug`

For EVERY debug feature, prove the problem RED before changing production code. Record a falsifiable root-cause hypothesis and at least two competing causes, including one investigator explicitly briefed: "the fix is NOT in the symptom layer - find the function that DECIDES the behavior." This is the mandatory DEPTH FLOOR. G1 and fresh depth verification are mandatory. Fix the deepest evidenced cause. Verification must prove the repro RED before and GREEN after, with no green-to-red regression in touched modules or direct dependents.

### `research`

Use only when the mission asks to discover or choose a target. Research changing external facts with live receipts, rank the options, and bind the chosen direction into `ROADMAP.md`. Do not create a second private scope or repeat research already accepted by roadmap assurance.

### `user-facing`

Verify through the real user surface. Exercise representative first-time, power-user, accessibility, skeptical-evaluator, and constrained-device perspectives where relevant. Convert material findings into named roadmap repair or implementation findings; do not manufacture persona theater.

### `polish`

Define the artifact-specific quality bar, build, judge independently, repair named flaws, and re-judge until the applicable sign-off bar passes. Contradictory aesthetic findings go to arbitration, which freezes one mission-consistent standard.

### `external-target`

Inspect the real external system, select a scalable test-safe integration path, respect auth/rate/cost/terms constraints, and verify end to end against the real target or a verified contract fixture. Never substitute a toy local demonstration for the requested external behavior.

## Closed-loop failures

A failed review or verification, sign-off failure, sweep P0/P1, or NOT-DONE goal check re-enters the owning roadmap item or creates a bounded debug item. Accepted evidence survives. Repairs target only named failures. Arbitration chooses among safe mission-advancing options but cannot waive an open P0/P1, the coverage floor, or required real verification.
