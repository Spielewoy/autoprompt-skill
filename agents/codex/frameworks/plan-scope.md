# ROADMAP planning

Create one dependency-ordered roadmap covering the requested work without expanding its scope.

## Assignment and control

Use the selected route and its canonical compiled checks. DIRECT and LIGHT use no
coordinator, manager, or roadmap. ROADMAP execution follows the accepted plan and
recorded dependencies. Only the run owner selects independent checkers; workers do
not start other agents. Follow the ownership rules in `composition.md`.

## Work and evidence

Treat original-request acceptance as the scope ceiling. Admit an implied work item only
when repository evidence proves it necessary for an accepted ask and a recorded
marginal-value check shows its benefit exceeds its added cost; otherwise exclude it.
This procedure applies after ROADMAP selection, not as a prerequisite for selecting a
route. Pure documentation work uses `docs.md` unless the requested document is the plan.

The roadmap author inspects the relevant repository and writes work items, owners,
dependencies, integration points, implementation details, acceptance requirements,
applicable failure cases, and real verification commands. Preserve the request's
coverage requirements and the 95% changed-line and touched-module coverage floor where
applicable. Ask for a scout only to resolve a named planning question; repository size
or the number of surfaces does not mandate scouts, managers, or extra reviewers.

When the roadmap is written, record the exact count of its concrete behavior-change asks
and divide it by the count of original-request success-checklist asks (with a minimum
denominator of one). Bind both positive integer counts and the resulting ratio to the
frozen `ROADMAP.md` SHA-256, and preserve that measurement across scheduler restart.

One independent checker verifies coverage, dependencies, ownership, integration, and
acceptance checks against the original request. An additional checker requires a named
distinct responsibility. Rejections identify the affected items; repair those items
and retain valid observations. Preserve unresolved user-owned decisions explicitly
rather than inventing answers or starting their dependent work.

Accepting the roadmap permits its ready work only when implementation is included in
the user request. A planning-only request finishes with the verified plan.

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

### Applicable route `ROADMAP`
- Leaves: `["coordinate-work","final-record","freeze-version","independent-check","integration","join-check-results","plan-check","produce-work","roadmap-authoring","success-definition"]`
- Edges: `[{"before":"coordinate-work","after":"produce-work"},{"before":"freeze-version","after":"independent-check"},{"before":"independent-check","after":"join-check-results"},{"before":"integration","after":"freeze-version"},{"before":"join-check-results","after":"final-record"},{"before":"plan-check","after":"coordinate-work"},{"before":"produce-work","after":"integration"},{"before":"roadmap-authoring","after":"plan-check"},{"before":"success-definition","after":"roadmap-authoring"}]`
- Order: `["success-definition","roadmap-authoring","plan-check","coordinate-work","produce-work","integration","freeze-version","independent-check","join-check-results","final-record"]`
- Maximum transitions: `23`

<!-- AUTOPROMPT-FRAMEWORK-GATES:END -->
