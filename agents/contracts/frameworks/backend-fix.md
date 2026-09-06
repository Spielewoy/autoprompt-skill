# Backend bug fix

Correct the reported backend behavior at its cause while preserving existing contracts.

## Assignment and control

Use the selected route and its canonical compiled checks. DIRECT and LIGHT use no
coordinator, manager, or roadmap. ROADMAP execution follows the accepted plan and
recorded dependencies. Only the run owner selects independent checkers; workers do
not start other agents. Follow the ownership rules in `composition.md`.

## Work and evidence

Find the project's real build and test commands and record the baseline on unchanged
code. Reproduce the reported failure with a deterministic regression test where
applicable; retain its failing output and show it passes after the fix. If the failure
does not reproduce, inspect the reported environment, version, input data, or concurrency
once within the diagnosis allowance and report the remaining uncertainty honestly.

Trace the failing path through the affected function, callers, and documented contract.
Use evidence to distinguish validation, data handling, concurrency, configuration, and
upstream failures. Respect language protocols, return types, idempotency, and API
compatibility. Cover the relevant boundary inputs rather than adding a special case
that leaves the underlying defect intact. Neither exception handling nor a conditional
is preferred categorically; choose the behavior the actual contract requires.

Write the regression test before changing behavior when feasible, then make the smallest
complete correction in owned resources. Wrong-layer evidence, repeated failure, or
cross-module uncertainty may justify a named root-cause check or a planning correction;
they do not authorize a retired role, extra reviewer, or larger route automatically.
Record adjacent findings with evidence and request ownership before any further edit.

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
