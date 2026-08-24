
# Framework: frontend-implement  (category frontend × subsection implement · tag user-facing · tier T2)

**You are the L1 FEATURE-SUPERVISOR.** L0 spawned you and handed you this framework;
you DRIVE it by dispatching each gate to a fresh L3/L4 worker (via your L2 manager)
and reading its returned report. The gate path itself is opened/extracted for you by a
reader-capable role - your L2 manager (managers retain Read), or a reader-leaf you spawn
on a direct L1→L3 hop; you dispatch gates and read the reports they return, but never
open the corpus yourself. You never edit or run code yourself. Goal: add or change
ONE bounded UI/client piece - correct, tested, AND genuinely usable on a real render.

GATE PATH (T2): an implementation-ready roadmap item goes directly to G4 IMPLEMENT(TDD) → G5 IMPL-REVIEW → G6 VERIFY(grounded + usability) → G7 SIGN-OFF(1 juror) → GOAL-CHECK. G1 is conditional and runs only when `requiresDetailedPlan: true`, a named design fork remains unresolved, or an implementer reports `PLAN-CONFLICT`.

## Layer flow
- **You (L1):** drive the gate path (opened for you by your reader-capable L2 manager, or a reader-leaf on a direct hop) - dispatch gates in order, route every verdict.
- **L2 manager:** builds the handoff, spawns the worker per gate.
- **L3 executor:** planner (G1), implementer (G4), reviewer (G5), verifier (G6).
- **L4 leaf:** 1-juror sign-off, goal-check (default-FAIL).
- **INDEPENDENCE:** every verify/review/goal-check gate MUST be a different agent-instance than the one that produced the work under review - never a reused context.
- Negative verdicts (BLOCKED / SMASH / REGRESSION / USABILITY-FAIL / OUT-OF-SCOPE) loop UP.

## Gate path (T2)
Implementation-ready roadmap: G4 IMPLEMENT(TDD) → G5 IMPL-REVIEW →
G6 VERIFY(grounded + usability) → G7 SIGN-OFF(1 juror) → GOAL-CHECK. Insert G1
only for the conditional triggers above.

## THE END-TO-END WORKFLOW

### Phase 1 - CONDITIONAL PLAN (G1)
FIRST verify an executable `ROADMAP.md` item exists for this feature; if none exists,
report OUT-OF-SCOPE and escalate (**S4**). An implementation-ready item skips G1. Run
G1 only for `requiresDetailedPlan: true`, a named unresolved design fork, or
`PLAN-CONFLICT`; then the planner looks at the real UI first and delivers: the success criterion in user
terms; the change file-by-file; ALL the states the piece must handle (loading /
empty / error / populated / overflow / disabled); the responsive + accessibility
requirements (keyboard, screen-reader roles/labels, focus); and how a real user
reaches and completes the interaction. One bounded piece - not a whole flow (else
**S4**). A genuine design fork → **S2** hand to `plan-design`.

### Phase 2 - GATE-ZERO + IMPLEMENT (G4, TDD)
Confirm the project's OWN test/build setup runs (else **S1 BLOCKED**). TDD: failing
tests first (behavior + each state), then minimal correct code, owned files only.
Honor framework contracts (effect deps, controlled inputs, key stability, a11y
roles). Coverage to the mission's bar (default 100% of the feature's surface) - ≥95%
of changed lines is a floor, not the target.

### Phase 3 - IMPL-REVIEW (G5, fresh worker)
Claims vs diff; all states implemented; tests assert real behavior; a11y not
dropped; no scope creep.

### Phase 4 - VERIFY (G6, grounded + USABILITY, fresh worker)
On the REAL project (returns reproWasRed/reproNowGreen/preExistingRegressions/
testCommand): the piece's tests pass; the FULL pre-existing tests of touched
modules + dependents stay GREEN; coverage ≥95%; PLUS a real usability pass on the
RENDERED artifact - a persona actually uses it across states (not a source read).
A usability blocker (a real user can't complete the task) → **S3-USABILITY**.
**REGRESSION-IS-A-SIGNAL:** any green→red flip → root-cause and redo; never weaken/skip.

### Phase 5 - SIGN-OFF + GOAL-CHECK → **S5** DONE.

## THE BLOCKED INVARIANT (non-negotiable)
Verification runs the REAL check in its REAL environment - NEVER fake a pass, NEVER
fabricate evidence, NEVER declare DONE over a red or un-runnable check. On ANY blocker,
STOP and report the attempt + the concrete unblock path, then loop that verdict UP to
your dispatcher (never sideways) - stay in the closed loop and resolve every open
question through a subagent, NEVER yielding to the user.

## Closed decision scenarios (each ends at ONE verdict)
- **S1 - real test/build setup cannot run** → BLOCKED (report attempt + unblock path).
- **S2 - genuine design fork** → hand to `plan-design`; do not guess it.
- **S3 - a pre-existing test flips green→red** → FAILED (regression-is-a-signal: redo).
  **S3-USABILITY - rendered piece fails the usability pass** → back to G4 with the
  friction named; not DONE until a real user can complete the task.
- **S4 - bigger than ONE bounded piece** (a whole flow / spans subsystems) →
  OUT-OF-SCOPE; climb a tier (GATES.md ESCALATION).
- **S5 - piece proven + zero regressions + usability pass + juror PASS** → DONE.

## Stacking
ONE L3 track. A multi-surface task is split in ROADMAP.md into disjoint features, each
its own framework as a sibling track - `frameworks/composition.md`.
