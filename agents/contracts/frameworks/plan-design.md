# Architecture and design decision

Produce a design for the requested target that an implementer can follow without inventing material decisions.

## Assignment and control

Use the selected route and its canonical compiled checks. DIRECT and LIGHT use no
coordinator, manager, or roadmap. ROADMAP execution follows the accepted plan and
recorded dependencies. Only the run owner selects independent checkers; workers do
not start other agents. Follow the ownership rules in `composition.md`.

## Work and evidence

Read the target system and identify the decisions the request requires. State relevant
performance, scale, compatibility, interface, and operational constraints. If a necessary
fact is unknown, perform or request bounded research within the selected route. This
procedure owns the design result, not production code.

Compare feasible alternatives against those constraints and cite the relevant existing
interfaces. Choose reversible technical alternatives within the assignment's authority;
return unresolved product or consequential choices to the run owner with the decision
needed. Do not fabricate a choice to make the design appear complete.

Document the selected interfaces, data flow, integration points, error behavior,
dependencies, and acceptance checks. An independent checker verifies request coverage,
feasibility, and whether each material decision is supported or explicitly unresolved.
Repair rejected design items while retaining accepted analysis. Completing a design
request does not authorize building or deploying it.

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
