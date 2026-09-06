# Behavior-preserving refactor

Make the requested structural improvement while preserving observable behavior.

## Assignment and control

Use the selected route and its canonical compiled checks. DIRECT and LIGHT use no
coordinator, manager, or roadmap. ROADMAP execution follows the accepted plan and
recorded dependencies. Only the run owner selects independent checkers; workers do
not start other agents. Follow the ownership rules in `composition.md`.

## Work and evidence

Read the existing contracts and establish the behavior to preserve before editing.
Run relevant existing tests on the unchanged code. Add characterization tests only
where the current checks leave behavior at risk; they must pass before the refactor.
Record any known quirks that are part of the current contract.

Make the assigned structural changes in owned resources, retaining the behavior checks.
Remove dead code only when evidence establishes it is unused and its removal belongs
to the requested refactor. If the task actually needs changed behavior, report that
conflict to the run owner for the appropriate procedure and acceptance requirements.

The independent checker compares the structural result with the request and verifies
that characterization and regression checks still pass. Test results support the
specific behavior they exercise; do not claim universal equivalence from a finite
suite. Investigate new failures and correct the refactor instead of rewriting expected
behavior solely to make the tests pass.

## Independent checking

One independent checker reviews and tests the frozen result by default. An additional
checker requires a named distinct risk or responsibility and separate evidence. Check
the requested behavior, relevant failure cases, and the existing tests of touched
modules and direct dependents. Compare failures with the recorded baseline; an
unrelated pre-existing failure is not a new regression. Investigate every new failure
before acceptance. Meet the request's coverage requirements and the 95% changed-line
floor for executable code, recording the measurement and any applicable exclusions.

## Recovery and result

A failed command starts diagnosis. Check the command, working directory, supported
runtime, and available dependencies; repair authorized local setup or an owned defect
within the recorded allowance. A changed result or check invalidates its dependent
evidence. Repeat those checks before reporting success. Do not weaken tests, conceal
regressions, or replace a required real result with a simulated pass.

Return repairable failures to the responsible owner. A repeated failure with unchanged
evidence requires strategy reassessment, not equivalent new workers. Preserve valid
results and all run-wide limits. Report `BLOCKED` only when an external, authority,
environment, or policy condition still prevents required work after permitted diagnosis
and recovery; include the command, observed failure, and concrete unblock condition.
Report an unresolved scope or ownership conflict to the run owner without editing
unowned resources. Only new route facts justify changing the route.

Return the exact result version, requested items completed, commands and exit codes,
check evidence, remaining defects, and attempted recovery. The run owner requests
completion only after every requested result passes its current required checks and
all working agents have stopped. The deterministic control plane records `DONE`.
