# UI polish

Apply the requested visual, copy, or interaction-detail improvements to the existing surface.

## Assignment and control

Use the selected route and its canonical compiled checks. DIRECT and LIGHT use no
coordinator, manager, or roadmap. ROADMAP execution follows the accepted plan and
recorded dependencies. Only the run owner selects independent checkers; workers do
not start other agents. Follow the ownership rules in `composition.md`.

## Work and evidence

Inspect the rendered surface and record the specific improvements and affected states.
Resolve routine choices using the existing design conventions. A material redesign,
new capability, or broken behavior needs the run owner's procedure and scope decision;
it is not implicitly authorized by a polish assignment.

Record the real build and relevant test baseline. Make the listed changes in owned
files. Preserve responsiveness, accessibility, focus, and existing behavior. Add a
behavior check when the change creates or alters testable behavior; use rendered
comparison for purely visual details instead of tests that only repeat the source.

The independent checker compares the requested changes with the actual rendered
surface at the relevant states and viewports, and runs affected behavior and regression
checks. Source inspection alone cannot establish visual quality. Report concrete
remaining defects rather than a subjective claim that the surface feels finished.

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

<!-- AUTOPROMPT-FRAMEWORK-GATES:BEGIN v2 sha256=b41cfc5bbf3088c61389449ea26a55f47cdbac2bb5c670ea684bd05d615526e1 -->
## Generated route checks

This compact section is generated from the versioned check registry.

### Applicable route `DIRECT`
- Leaves: `["final-record","freeze-version","independent-check","join-check-results","produce-work","success-definition"]`
- Edges: `[{"before":"freeze-version","after":"independent-check"},{"before":"independent-check","after":"join-check-results"},{"before":"join-check-results","after":"final-record"},{"before":"produce-work","after":"freeze-version"},{"before":"success-definition","after":"produce-work"}]`
- Order: `["success-definition","produce-work","freeze-version","independent-check","join-check-results","final-record"]`
- Maximum transitions: `14`

### Applicable route `LIGHT`
- Leaves: `["final-record","freeze-version","independent-check","join-check-results","produce-work","short-plan","success-definition"]`
- Edges: `[{"before":"freeze-version","after":"independent-check"},{"before":"independent-check","after":"join-check-results"},{"before":"join-check-results","after":"final-record"},{"before":"produce-work","after":"freeze-version"},{"before":"short-plan","after":"produce-work"},{"before":"success-definition","after":"short-plan"}]`
- Order: `["success-definition","short-plan","produce-work","freeze-version","independent-check","join-check-results","final-record"]`
- Maximum transitions: `16`

### Applicable route `ROADMAP`
- Leaves: `["coordinate-work","final-record","freeze-version","independent-check","integration","join-check-results","plan-check","produce-work","roadmap-authoring","success-definition"]`
- Edges: `[{"before":"coordinate-work","after":"produce-work"},{"before":"freeze-version","after":"independent-check"},{"before":"independent-check","after":"join-check-results"},{"before":"integration","after":"freeze-version"},{"before":"join-check-results","after":"final-record"},{"before":"plan-check","after":"coordinate-work"},{"before":"produce-work","after":"integration"},{"before":"roadmap-authoring","after":"plan-check"},{"before":"success-definition","after":"roadmap-authoring"}]`
- Order: `["success-definition","roadmap-authoring","plan-check","coordinate-work","produce-work","integration","freeze-version","independent-check","join-check-results","final-record"]`
- Maximum transitions: `23`

<!-- AUTOPROMPT-FRAMEWORK-GATES:END -->
