# Compose work from independent dimensions

The `composition` object in `agents/contracts/gates.json` is authoritative. Select
exactly one base work type, one or more result-format overlays, one or more acceptance
overlays, every applicable risk overlay, and evidence for each selected risk. Reject
unknown ids, duplicates, missing evidence, and incompatible combinations before
dispatch.

Overlay selection adds evidence requirements. It does not replace the route graph or
create a fixed number of workers. By default one independent checker reviews and tests
the exact result. Add another only for a named distinct responsibility that cannot be
checked independently in the same context.

## Writable ownership

Concurrent work is allowed only for disjoint writable resources. Sharing a file does
not collapse all work into one task; it requires an ordered ownership transfer:

1. The first owner records the exact file identity, starting hash, permitted change,
   and completion checks.
2. After finishing, that owner freezes the file, records the resulting hash and check
   evidence, releases write ownership, and stops writing it.
3. The controller verifies the released hash and translates ownership to the next
   named owner with a new permitted change and acceptance record.
4. The next owner accepts only that exact hash, records its own resulting hash, and
   never edits before the release is durable.
5. An independent checker verifies both transitions and the integrated result.

For example, implementation may own `ui/card.css`, release its tested hash, and then
polish may accept that exact hash and own the same file. Implementation and polish are
separate ordered work items, not concurrent writers and not one collapsed assignment.

If the released hash differs, ownership is ambiguous, or the prior owner is still
writing, return `OWNERSHIP_CONFLICT`. Do not merge concurrent bytes or infer a transfer.

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
