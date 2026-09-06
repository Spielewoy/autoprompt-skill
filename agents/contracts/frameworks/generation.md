# Generated procedure contract

Use this procedure only when selection returns `FRAMEWORK: MISS`. Generated procedures
are one-off projections of canonical contracts; they do not invent a competing route or
check sequence.

## Shape

Classify `deliverableKind`, `targetLocus`, and an `acceptanceOverlays` array. The array
must be non-empty, contain no duplicate ids, and preserve every independently requested
effect. Each item has exactly:

```json
{
  "id": "unit-coverage",
  "oracle": "named observable pass condition",
  "evidenceSchema": "agents/contracts/schemas/evidence.schema.json",
  "owner": "ap-independent-checker",
  "retryPolicy": { "maximumAttempts": 2, "retryableResults": ["TRANSIENT_RUNTIME"] }
}
```

Supported overlay ids include `unit-coverage`, `test-set-flip`, `metric-threshold`,
`dry-run-diff`, and `receipts`. Compound acceptance is an array, never a scalar. For
example, a data migration may require both `dry-run-diff` and `receipts`, with distinct
observable checks, evidence, owners, and retries.

## Output

Emit a stable name derived from the three axes, the original acceptance overlays, an
execution-harness reference, typed scenarios, and the canonical compiled route graph.
Do not add surrounding prose that restates, reorders, or omits checks from that graph.

Before generation, compute the immutable MISS cache identity from the route-schema
digest, classified axes, acceptance overlays, and risk overlays. A validated descriptor
is reusable only under that exact identity. An identical identity performs zero new
generator or validator model calls; any route-schema digest change is a cache miss.

Validation rejects unknown overlays, empty observable checks, missing schemas, owners
that are not permitted to check the result, unbounded retries, more than one terminal
`DONE`, or any typed failure without a destination.

## Blocked result

A repairable generated-output defect returns once to the generator. After the bounded
retry, return the typed failure. An external, authority, environment, or policy blocker
terminates with the attempted check, evidence, and concrete unblock requirement. It
does not loop indefinitely and never becomes a claimed pass.
