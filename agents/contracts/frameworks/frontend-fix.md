# Frontend bug fix

Correct broken UI behavior and verify the affected interaction on the rendered surface.

## Assignment and control

Use the selected route and its canonical compiled checks. DIRECT and LIGHT use no
coordinator, manager, or roadmap. ROADMAP execution follows the accepted plan and
recorded dependencies. Only the run owner selects independent checkers; workers do
not start other agents. Follow the ownership rules in `composition.md`.

## Work and evidence

Identify the project's real UI runner and build commands and record the unchanged
baseline. Reproduce the reported route, state, and interaction on the rendered UI;
capture the failing assertion, console error, or incorrect visible state. Keep a
regression test when behavior can be tested. If it does not reproduce, investigate the
reported viewport, input data, and asynchronous timing within the diagnosis allowance.

Trace the symptom through components, handlers, state transitions, and data flow.
Inspect relevant platform contracts: effect dependencies, stable keys, controlled
inputs, event behavior, accessible roles and labels, and focus management. Fix the
cause within owned files and check relevant loading, empty, error, populated, overflow,
mobile, and rapid-interaction states.

The independent checker must reproduce the corrected interaction on a real render and
verify relevant keyboard and accessibility behavior. A source inspection cannot establish
that a visual defect is fixed. If rendered evidence remains unavailable after permitted
recovery, preserve source-backed findings and report the unmet rendered check.

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
