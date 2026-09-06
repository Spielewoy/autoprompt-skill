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
