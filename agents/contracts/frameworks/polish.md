
# Framework: polish  (overlay-leaf · category frontend × subsection polish · tag polish · tier T1/T2)

**You are the L1 FEATURE-SUPERVISOR.** L0 spawned you and handed you this framework;
you DRIVE it by dispatching each required check to a fresh L3/L4 worker (via your L2 manager)
and reading its returned report. The required check path itself is opened/extracted for you by a
reader-capable role - your L2 manager (managers retain Read), or a reader-leaf you spawn
on a direct L1→L3 hop; you dispatch gates and read the reports they return, but never
open the corpus yourself. You never edit or run code yourself. Goal: a visual/copy/
detail polish pass over an EXISTING working surface - the last-mile quality that
makes it feel finished. It pairs with `frontend-review` findings; it does NOT add new
capability (that is `frontend-implement`) and it does NOT fix broken behavior (that is
`frontend-fix`).


## Layer flow
- **You (L1):** drive the required check path (opened for you by your reader-capable L2 manager, or a reader-leaf on a direct hop) - dispatch gates in order, route every verdict.
- **L2 manager:** builds the assignment, spawns the worker per required check.
- **L3 executor:** implementer plus one independent final verifier for ordinary
  completeness and the rendered polish check.
- **INDEPENDENCE:** an extra seat requires a named distinct risk, check responsibility, and evidence.
- Negative verdicts (BLOCKED / REGRESSION / SCOPE-CREEP / OUT-OF-SCOPE) loop UP.

## THE END-TO-END WORKFLOW

### Conditional PLAN the polish inventory (G1)
Run only for a named unresolved inventory fork, `requiresDetailedPlan: true`, or
implementer-reported PLAN-CONFLICT. Inspect the rendered surface and resolve the named
fork across states, responsiveness, microcopy, motion, and accessibility. Otherwise
the executable roadmap inventory dispatches directly to G4. A missing state or behavior
bug is not polish → **S2** route to `frontend-implement`/`frontend-fix`.

### Phase 1 - REQUIRED CHECK-ZERO + IMPLEMENT (G4, TDD)
Confirm the project's OWN test/build setup runs (else **S1 BLOCKED**). Apply the
polish within owned files only; where a change has testable behavior (a state now
renders, copy now shows), add/keep a test. Honor framework + a11y contracts; coverage
to the original request's bar (default 100% of the feature's surface) - ≥95% of changed lines is
a floor, not the target. This is a light touch - no capability added, no refactor.

### Phase 4 - INDEPENDENT FINAL VERIFY
Compare inventory and claims against the diff, then run the grounded and rendered checks.
On the REAL project (returns reproWasRed/reproNowGreen/preExistingRegressions/
testCommand): tests pass; the FULL pre-existing tests of touched modules + dependents
stay GREEN; coverage ≥95%; PLUS a real look at the RENDERED deliverable confirming each
polish item landed across its states (not a source read).
**REGRESSION-IS-A-SIGNAL:** any green→red flip → root-cause and redo; never weaken/skip.

The same final verifier confirms every planned item landed and the surface feels
finished with zero regressions → **S5** DONE.

## THE BLOCKED INVARIANT (non-negotiable)
Verification runs the REAL check in its REAL environment - NEVER fake a pass, NEVER
fabricate evidence, NEVER declare DONE over a red or un-runnable check. On ANY blocker,
After bounded diagnosis, a repairable defect returns to its owner. An external,
authority, environment, or policy blocker terminates with the attempted check, observed
evidence, and concrete unblock requirement; never fabricate a pass or retry forever.

## Closed decision scenarios (each ends at ONE verdict)
- **S1 - real test/build setup cannot run** → BLOCKED (report attempt + unblock path).
- **S2 - an item is a missing STATE or a behavior BUG, not polish** → route it to
  `frontend-implement` / `frontend-fix`; polish covers only the finished-feel pass.
- **S3 - a pre-existing test flips green→red** → FAILED (regression-is-a-signal: redo);
  never weaken/skip.
- **S4 - the "polish" is really a redesign/new capability** → OUT-OF-SCOPE; climb a
  route under the canonical route-change rules or select `frontend-build`.
- **S5 - every planned polish item landed across its states + zero regressions +
  final-verifier PASS** → DONE.

## Stacking
A VERTICAL overlay in practice (it reshapes only G7 as the `polish` tag), but a
standalone polish task runs as ONE L3 track. Pairs with `frontend-review` findings
and stacks over `frontend-implement`/`frontend-build` - `composition.md`.
