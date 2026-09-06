# Mechanical change

Use this procedure only when the exact transformation is already specified and no
placement, behavior, or product decision remains.

## Admission

Record the exact before/after rule, owned resources, relevant baseline, and observable
checks. If the request leaves a real decision unresolved, return
`SPEC_INCOMPLETE` and select implementation or design work; do not guess.

## Work and checking

One owner applies only the specified transformation. One independent final verifier
compares the exact diff with the rule, checks for missing or extra edits, runs the
focused assertion, and compares relevant pre-existing tests with the recorded baseline.
An unrelated red baseline does not block production; only a new or changed failure is a
regression. An extra independent-checking seat is admitted only for a named distinct
risk with a distinct check responsibility and underlying evidence.

Unit fakes may exercise local error paths. When the change affects an integration
boundary, keep the unit result separate from the paired contract fixture and required
real integration result.

## Typed outcomes

- `DONE`: the diff exactly matches the rule and relevant checks pass.
- `SPEC_INCOMPLETE`: a decision remains; return it to selection.
- `DIFF_MISMATCH` or `REGRESSION`: repair within the recorded retry limit, then return
  the typed failure with evidence.
- `BLOCKED`: after bounded diagnosis, an external, authority, environment, or policy
  condition still prevents a required check. Terminate honestly with the attempted
  command, observed result, and concrete unblock requirement. Do not retry forever and
  do not replace the check with a claimed pass.

<!-- AUTOPROMPT-FRAMEWORK-GATES:BEGIN v2 sha256=b41cfc5bbf3088c61389449ea26a55f47cdbac2bb5c670ea684bd05d615526e1 -->
## Generated route checks

This compact section is generated from the versioned check registry.

### Applicable route `DIRECT`
- Leaves: `["final-record","freeze-version","independent-check","join-check-results","produce-work","success-definition"]`
- Edges: `[{"before":"freeze-version","after":"independent-check"},{"before":"independent-check","after":"join-check-results"},{"before":"join-check-results","after":"final-record"},{"before":"produce-work","after":"freeze-version"},{"before":"success-definition","after":"produce-work"}]`
- Order: `["success-definition","produce-work","freeze-version","independent-check","join-check-results","final-record"]`
- Maximum transitions: `14`

<!-- AUTOPROMPT-FRAMEWORK-GATES:END -->
