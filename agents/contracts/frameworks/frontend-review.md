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
