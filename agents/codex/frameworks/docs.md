# Documentation work

Produce documentation that is accurate against authoritative sources and usable by
its named audience. Documentation owns no production behavior unless the user
separately requests that change.

## Planning predicates

Planning depends on ambiguity, never tier. Set these three booleans from the request
and shallow target inspection:

- `audienceUnresolved`: more than one materially different audience remains plausible.
- `informationArchitectureUnresolved`: placement, navigation, or content order cannot
  be derived from an existing documentation structure or explicit request.
- `sourceAuthorityUnresolved`: two or more plausible sources disagree, or no source is
  designated for a material claim.

Run a planning step only when at least one predicate is true. The plan must resolve the
named predicate and cite its evidence. When all are false, proceed directly to writing,
regardless of size tier. If the subject itself is unknown, return a research request.

## Writing and checking

Record the audience, information structure, and authoritative source for each material
claim. Read actual signatures, flags, routes, configuration, and behavior. Include a
copyable example for runnable claims and at least one end-to-end example where the
target supports execution.

One independent final verifier checks audience fit, structure, completeness, clarity,
and every material claim against its source, then executes examples in the real
environment. An extra seat requires a named distinct risk, check responsibility, and underlying
evidence. A unit fake may demonstrate a local error case,
but external-boundary claims require a paired contract fixture and the separately
required real result.

## Outcomes

- `DONE`: audience needs are covered, material claims match their sources, and runnable
  examples pass.
- `INACCURATE` or `EXAMPLE_BROKEN`: repair within the bounded retry policy and recheck.
- `BLOCKED`: an external, authority, environment, or policy condition remains after
  bounded diagnosis. Return the attempted check and concrete unblock requirement;
  never invent a passing example.

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
