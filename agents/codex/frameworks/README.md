# Framework selection and evidence contract

Select the route before creating any roadmap. Cold-start selection uses only the exact
user request and shallow target facts allowed by `agents/contracts/routes.json`. A
roadmap, success card, plan, file count, repository size, or failed attempt is never a
prerequisite or selector.

After route selection, choose a procedure by the requested action:

- `apply`: perform an exact, decision-free transformation.
- `backend-fix` or `frontend-fix`: correct observed broken behavior.
- `backend-implement` or `frontend-implement`: change one bounded capability.
- `backend-build` or `frontend-build`: create a whole new component or surface.
- `frontend-review`: inspect and report on a user-facing surface without changing it.
- `polish`: change visual, copy, or interaction details.
- `refactor`: restructure while preserving behavior.
- `plan-scope`, `plan-research`, or `plan-design`: produce the named planning result.
- `docs`: produce documentation.

Browser and runnable-surface availability are evidence conditions, not action
selectors. A requested review always remains read-only. With a browser it may collect
live screenshots; without one it returns a clearly marked static review. Findings may
become separate downstream fix requests, but the review procedure does not implement
them.

## Canonical check graph

The route graphs compiled from `agents/contracts/gates.json` are authoritative. A
procedure describes purpose, evidence, and typed outcomes; it must not declare a
competing sequence. Generated Codex procedure pages append exactly one compiled graph.

One independent final verifier owns ordinary completeness: it compares the frozen exact
version being checked with the request and executes the acceptance checks. An extra independent-checking seat
requires a named distinct risk, a distinct check responsibility, and distinct underlying evidence;
edit count, tier, or a second label for the same evidence never adds reviewer,
verification, sign-off, or goal-check work.

For debug fixes the default path is reproduce, implement, then verify. Add detailed
planning or a depth specialist only after recorded wrong-layer evidence, repeated
failure, or cross-module uncertainty. A reproduced bounded local defect does not pay
those gates automatically.

## Test doubles and contract fixtures

A unit fake may isolate local logic or force an error path. It is never a substitute
for integration evidence required by the selected acceptance overlay. Any behavior at
an external boundary needs a paired contract fixture whose schema and provenance are
checked, plus a separate real integration or provider-contract result when that result
is required. Record both results independently; neither can silently satisfy the
other.

## Independent overlays

Scope, acceptance, and risk are independent. Select every applicable risk overlay even
for a one-line change. Authorization, privacy, destructive action, external effects,
performance, concurrency, migration, and rollback each add their own evidence.

Performance work records a baseline, the named SLO or metric threshold, the measured
result under a stated workload, regression bounds, and rollback criteria. External or
destructive work records authority before mutation and a tested recovery or rollback
path.

Blocking findings remain open work. Advisory residual risk may close only with an exact
authority receipt naming every accepted finding. A P1 non-defect decision additionally
binds immutable evidence and its original severity to that receipt; it is never achieved
by relabeling or downgrading severity.

## Event records and migrated logs

Write run events to schema-validated `events.jsonl`. Validate every route, category,
procedure, tier, state, and check id before dispatch or append. Older captured logs are
inputs only after an explicit migration names the source version, target version, row
transform, rejected rows, and resulting digest. Replay the migrated corpus through the
current schema and reject unknown ids; prose logs never bypass validation.

## Composition

Concurrent work requires disjoint writable ownership. Work on the same file uses an
ordered ownership transfer as defined in `composition.md`. A non-matching shape returns
`FRAMEWORK: MISS` and uses `generation.md`; it never silently becomes an implementation
procedure.

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
