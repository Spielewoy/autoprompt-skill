# Frontend review

Use this procedure only when the requested action is inspection and reporting. It is
read-only: reviewers, synthesizers, and checkers must not edit the surface, source,
configuration, or deployment.

## Evidence mode

Probe the surface and available browser tooling without mutation.

- A runnable surface and browser permit a live journey review with real screenshots.
- A surface without browser tooling permits a static review. Mark every visual claim
  `UNVERIFIED_VISUALLY` and never fabricate a screenshot.
- An unavailable surface does not turn the request into implementation. Perform the
  source-backed parts that remain valid, record the unavailable evidence, and return a
  typed terminal blocker if the requested result cannot otherwise be produced.

## Review work

Choose personas and journeys that cover distinct user needs. Each reviewer records the
route or source location, observed state, evidence mode, severity, and suggested
improvement. Merge duplicates without dropping affected personas. A fresh checker
replays each high-severity live finding or verifies the cited static source.

The result is one severity-ranked review. Potential fixes are recommendations only.
They may be copied into separately authorized downstream work, with new ownership and
acceptance evidence; this review never performs or dispatches those changes.

## Outcomes

- `DONE`: requested journeys were inspected and every claim names its evidence mode.
- `THIN_REVIEW`: evidence is missing or a live claim cannot be reproduced; repair the
  review within the bounded retry policy.
- `BLOCKED`: an external, authority, policy, or unavailable-surface condition remains
  after bounded diagnosis. Return the attempted check, evidence, and concrete unblock
  requirement; do not loop indefinitely.

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
