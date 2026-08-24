# Procedure quickstart

1. Select the route from the exact request and shallow target facts before creating a
   plan or roadmap.
2. In `README.md`, choose the procedure by the requested action. Evidence availability
   changes the evidence mode, not the requested action.
3. Open the named procedure page. Follow its purpose, evidence rules, ownership rules,
   and typed outcomes. Use only the compiled route graph appended to that page for the
   check sequence.

If no named procedure fits, return `FRAMEWORK: MISS` and use `generation.md`. Do not
default to implementation, invent a route, or copy a sequence from surrounding prose.

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
