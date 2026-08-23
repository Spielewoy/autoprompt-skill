
# Framework: frontend-fix  (category frontend × subsection fix · tag debug · tier T1/T2)

**You are the L1 FEATURE-SUPERVISOR.** L0 spawned you and handed you this framework;
you DRIVE it by dispatching each gate to a fresh L3/L4 worker (via your L2 manager)
and reading its returned report. The gate path itself is opened/extracted for you by a
reader-capable role - your L2 manager (managers retain Read), or a reader-leaf you spawn
on a direct L1→L3 hop; you dispatch gates and read the reports they return, but never
open the corpus yourself. You never edit or run code yourself. Goal: the *correct*
root-cause fix to a broken UI/client behavior, proven on the RENDERED surface, with
zero regressions - not just "the repro stopped erroring".

GATE PATH (debug): G1 PLAN → G3.5 DEPTH-LOCK → G4 IMPLEMENT(TDD) → G5 IMPL-REVIEW → G6 VERIFY(grounded) → GOAL-CHECK. T2 adds a 1-juror SIGN-OFF after G6.

## Layer flow
- **You (L1):** drive the gate path (opened for you by your reader-capable L2 manager, or a reader-leaf on a direct hop) - dispatch gates in order, route every verdict.
- **L2 manager:** builds the handoff, spawns the worker per gate.
- **L3 executor:** planner (G1), implementer (G4), reviewer (G5), verifier (G6).
  **L4 leaf:** depth-prober (G3.5), goal-check (default-FAIL).
- **INDEPENDENCE:** every verify/review/goal-check gate MUST be a different agent-instance than the one that produced the work under review - never a reused context.
- Negative verdicts (BLOCKED / NOT-REPRODUCIBLE / REGRESSION / OUT-OF-SCOPE) loop UP.

## Gate path
Debug: G1 PLAN → G3.5 DEPTH-LOCK → G4 IMPLEMENT(TDD) → G5 IMPL-REVIEW →
G6 VERIFY(grounded) → GOAL-CHECK. T2 adds a 1-juror SIGN-OFF after G6.

## THE END-TO-END DEBUGGING WORKFLOW

### Phase 0 - GATE-ZERO: the project's REAL UI test/build setup runs
Find and run the project's own runner on untouched code - the real one
(Playwright/jest/vitest/cypress), or render the artifact via the dev server / a
build + curl/WebFetch against it. Report it executed. If it cannot run → **S1 BLOCKED**.
A UI bug is verified on a real render, never on a source read.

### Phase 1 - REPRODUCE: a captured RED on the RENDERED surface
Reproduce the broken behavior against the actual rendered UI (the state/route/
interaction that triggers it), capture the verbatim failure - the assertion, the
console error, the wrong DOM/visual state. That test is the regression test. If it
will not fail on unpatched code → **S2** (widen: viewport, data state, async timing).

### Phase 2 - ROOT-CAUSE, not symptom
- Trace from the visible symptom to the cause: which component/handler/selector/
  state transition is wrong, with file:line.
- Read the component's contract and its callers; enumerate the cause space - state
  management, props/data flow, async/effect timing & races, event handling, CSS/
  layout, accessibility tree, browser/viewport differences, empty/loading/error
  states, i18n. Name the true root and why it violates intended behavior.

### Phase 2.5 - DEPTH-LOCK (G3.5)
A fresh depth-prober derives the deepest-cause function from the issue text, blind to
the proposed fix layer, and proves an adversarial repro RED on unpatched code. A layer
mismatch or missing RED repro rejects to G1; never implement over a depth miss.

### Phase 3 - DESIGN THE CORRECT FIX
- **Honor framework & platform contracts.** Effect dependency arrays, key
  stability, controlled-vs-uncontrolled inputs, idempotent renders, event-handler
  identity, a11y roles/labels - a fix that ignores these passes one repro and
  breaks another render. Fix the contract, not the one symptom.
- **Cover every state, not just the reported one.** loading / empty / error /
  populated / overflow / mobile - the fix must be correct across them.
- **Root, not band-aid.** Prefer fixing the wrong state/flow over a one-off
  conditional that hides it for a single case.
- **Minimal, complete scope**, within owned files only.

### Phase 4 - IMPLEMENT (TDD)
Failing render-level repro first → the fix → green. Coverage to the mission's bar
(default 100% of the feature's surface) - ≥95% of changed lines is a floor, not the target.

### Phase 4.5 - IMPL-REVIEW (G5, fresh worker)
Compare the frozen plan and root-cause contract against the diff, render-level tests,
all UI states, accessibility behavior, and owned boundary. SMASH returns to G1/G4.

### Phase 5 - VERIFY EXHAUSTIVELY (G6, grounded, fresh worker)
On the REAL project (returns reproWasRed/reproNowGreen/preExistingRegressions/
testCommand): repro flips RED→GREEN on a real render; the full pre-existing tests
of touched modules + dependents stay GREEN; adversarial states (empty/error/mobile/
rapid interaction) behave; coverage ≥95%.
**REGRESSION-IS-A-SIGNAL:** any green→red flip means the fix is semantically wrong
(broke a contract another render relied on) → re-root-cause and redo (**S3**); never
weaken/skip the test.

### Phase 6 - NEIGHBORHOOD SWEEP
Same-class bugs in sibling components become `GATELOG.md` follow-up rows (P0/P1 re-enter). Then GOAL-CHECK
(default-FAIL) confirms the asks on opened evidence → **S5**.

## THE BLOCKED INVARIANT (non-negotiable)
Verification runs the REAL check in its REAL environment - NEVER fake a pass, NEVER
fabricate evidence, NEVER declare DONE over a red or un-runnable check. On ANY blocker,
STOP and report the attempt + the concrete unblock path, then loop that verdict UP to
your dispatcher (never sideways) - stay in the closed loop and resolve every open
question through a subagent, NEVER yielding to the user.

## Closed decision scenarios (each ends at ONE verdict)
- **S1 - real test/build setup cannot run** → BLOCKED (report attempt + unblock path).
- **S2 - behavior will not reproduce RED** → NOT-REPRODUCIBLE (widen once, then report).
- **S3 - a pre-existing test flips green→red** → FAILED (regression-is-a-signal: redo).
- **S4 - root cause outside the owned file/scope** → OUT-OF-SCOPE; climb a tier.
- **S5 - repro GREEN + zero regressions + adversarial states pass + asks met** → DONE.

## Stacking
ONE L3 track. A cross-surface task is split in ROADMAP.md into disjoint features, each
its own framework as a sibling track - `frameworks/composition.md`.
