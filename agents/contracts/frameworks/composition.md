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
