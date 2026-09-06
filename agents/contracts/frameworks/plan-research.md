# Research for planning

Answer the requested research question with inspectable sources and a useful written result.

## Assignment and control

Use the selected route and its canonical compiled checks. DIRECT and LIGHT use no
coordinator, manager, or roadmap. ROADMAP execution follows the accepted plan and
recorded dependencies. Only the run owner selects independent checkers; workers do
not start other agents. Follow the ownership rules in `composition.md`.

## Work and evidence

State the question and required output, such as a comparison, catalog, or decision memo.
Use at most three non-overlapping themes when decomposition is useful; do not create
extra agents merely to match that count. The run owner assigns research to permitted
workers according to the selected route.

Each theme has a bounded initial batch of at most six searches and six fetches, subject
to the tighter remaining run limits. Record the source and observed result for every
claimed search or inspection. Produce the named output from the evidence obtained;
progress is substantive findings, not tool-call counts. If a batch produces no useful
output, return its concrete unresolved question without repeating the same broad batch.
One targeted follow-up may address a remaining gap after accepted output exists.

If live search fails, diagnose the tool and use available authorized primary sources
where they can answer the question. A local authoritative source may support stable
facts; it cannot establish current claims that require live verification. Preserve
useful findings and identify evidence that remains unavailable without inventing sources.

Combine findings in the requested format, distinguishing observations, inference, and
uncertainty. Rank alternatives only when comparison or recommendation is requested.
The independent checker verifies material claims against cited sources and confirms
that the result answers the request. Research findings alone do not authorize downstream
implementation.

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
