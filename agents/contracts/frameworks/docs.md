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
