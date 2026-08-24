# Canonical checks for Codex

Generated from `agents/contracts/gates.json`.

<!-- AUTOPROMPT-COMPILED-GATES:BEGIN v2 sha256=b41cfc5bbf3088c61389449ea26a55f47cdbac2bb5c670ea684bd05d615526e1 -->
## Compiled required-check registry

This section is generated from the versioned check registry. Edit the registry, not this projection.
Technical identifiers keep their exact contract spelling: `oracle-rejected` means the observable check rejected a result, `mission-coordinator` means the run coordinator, and `candidateVersionHash` or names containing `-candidate-` refer to the exact version being checked.

### Route `DIRECT`
- Leaf: `final-record`
- Leaf: `freeze-version`
- Leaf: `independent-check`
- Leaf: `join-check-results`
- Leaf: `produce-work`
- Leaf: `success-definition`
- Edge: `freeze-version` -> `independent-check`
- Edge: `independent-check` -> `join-check-results`
- Edge: `join-check-results` -> `final-record`
- Edge: `produce-work` -> `freeze-version`
- Edge: `success-definition` -> `produce-work`

#### Order
1. `success-definition`
2. `produce-work`
3. `freeze-version`
4. `independent-check`
5. `join-check-results`
6. `final-record`
- Maximum transitions: 14

### Route `LIGHT`
- Leaf: `final-record`
- Leaf: `freeze-version`
- Leaf: `independent-check`
- Leaf: `join-check-results`
- Leaf: `produce-work`
- Leaf: `short-plan`
- Leaf: `success-definition`
- Edge: `freeze-version` -> `independent-check`
- Edge: `independent-check` -> `join-check-results`
- Edge: `join-check-results` -> `final-record`
- Edge: `produce-work` -> `freeze-version`
- Edge: `short-plan` -> `produce-work`
- Edge: `success-definition` -> `short-plan`

#### Order
1. `success-definition`
2. `short-plan`
3. `produce-work`
4. `freeze-version`
5. `independent-check`
6. `join-check-results`
7. `final-record`
- Maximum transitions: 16

### Route `ROADMAP`
- Leaf: `coordinate-work`
- Leaf: `final-record`
- Leaf: `freeze-version`
- Leaf: `independent-check`
- Leaf: `integration`
- Leaf: `join-check-results`
- Leaf: `plan-check`
- Leaf: `produce-work`
- Leaf: `roadmap-authoring`
- Leaf: `success-definition`
- Edge: `coordinate-work` -> `produce-work`
- Edge: `freeze-version` -> `independent-check`
- Edge: `independent-check` -> `join-check-results`
- Edge: `integration` -> `freeze-version`
- Edge: `join-check-results` -> `final-record`
- Edge: `plan-check` -> `coordinate-work`
- Edge: `produce-work` -> `integration`
- Edge: `roadmap-authoring` -> `plan-check`
- Edge: `success-definition` -> `roadmap-authoring`

#### Order
1. `success-definition`
2. `roadmap-authoring`
3. `plan-check`
4. `coordinate-work`
5. `produce-work`
6. `integration`
7. `freeze-version`
8. `independent-check`
9. `join-check-results`
10. `final-record`
- Maximum transitions: 23

### Check `behavior-test`
- Owner: `"independent-tester"`
- Command kind: `"contract-operation"`
- Operation: `"test-frozen-version"`
- Arguments: `["autoprompt-gate-runner","--check","behavior-test"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["independent-checking","isolated-execution"]`
- Observable check kind: `"behavior-test-oracle"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["independent-checking","isolated-execution","evidence-capture"]`
- Observable check success condition: `"Every declared output of behavior-test exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["INPUT_FINGERPRINT_CHANGED","TRANSIENT_TOOL_FAILURE"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"BLOCKED"`
- Exhaustion outcome code: `"BLOCKED"`

### Check `coordinate-work`
- Owner: `"mission-coordinator"`
- Command kind: `"contract-operation"`
- Operation: `"coordinate-ready-work"`
- Arguments: `["autoprompt-gate-runner","--check","coordinate-work"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["task-dispatch","ownership-enforcement"]`
- Observable check kind: `"ownership-and-readiness"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["task-dispatch","ownership-enforcement","evidence-capture"]`
- Observable check success condition: `"Every declared output of coordinate-work exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["DEPENDENCY_CHANGED","OWNERSHIP_CHANGED"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"BLOCKED"`
- Exhaustion outcome code: `"BLOCKED"`

### Check `final-record`
- Owner: `"deterministic-control-plane"`
- Command kind: `"contract-operation"`
- Operation: `"write-final-record"`
- Arguments: `["autoprompt-gate-runner","--check","final-record"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["durable-state-write","read-after-write-verification"]`
- Observable check kind: `"terminal-record-readback"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["durable-state-write","read-after-write-verification","evidence-capture"]`
- Observable check success condition: `"Every declared output of final-record exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["TRANSIENT_STATE_STORE_FAILURE"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"FAILED"`
- Exhaustion outcome code: `"FAILED"`

### Check `freeze-version`
- Owner: `"deterministic-control-plane"`
- Command kind: `"contract-operation"`
- Operation: `"freeze-candidate-version"`
- Arguments: `["autoprompt-gate-runner","--check","freeze-version"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["cryptographic-hashing","candidate-freeze"]`
- Observable check kind: `"hash-and-manifest"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["cryptographic-hashing","candidate-freeze","evidence-capture"]`
- Observable check success condition: `"Every declared output of freeze-version exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["INPUT_FINGERPRINT_CHANGED"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"BLOCKED"`
- Exhaustion outcome code: `"BLOCKED"`

### Check `independent-check`
- Owner: `"independent-checker"`
- Command kind: `"contract-operation"`
- Operation: `"check-frozen-version"`
- Arguments: `["autoprompt-gate-runner","--check","independent-check"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["independent-checking","isolated-execution"]`
- Observable check kind: `"static-and-behavior-oracle"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["independent-checking","isolated-execution","evidence-capture"]`
- Observable check success condition: `"Every declared output of independent-check exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"CHECK_INCONCLUSIVE","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["INPUT_FINGERPRINT_CHANGED","TRANSIENT_TOOL_FAILURE"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"BLOCKED"`
- Exhaustion outcome code: `"BLOCKED"`

### Check `integration`
- Owner: `"mission-coordinator"`
- Command kind: `"contract-operation"`
- Operation: `"integrate-owned-results"`
- Arguments: `["autoprompt-gate-runner","--check","integration"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["artifact-mutation","ownership-enforcement"]`
- Observable check kind: `"preimage-and-conflict"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["artifact-mutation","ownership-enforcement","evidence-capture"]`
- Observable check success condition: `"Every declared output of integration exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["CONFLICT_RESOLVED","INPUT_FINGERPRINT_CHANGED"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"BLOCKED"`
- Exhaustion outcome code: `"BLOCKED"`

### Check `join-check-results`
- Owner: `"deterministic-control-plane"`
- Command kind: `"contract-operation"`
- Operation: `"join-check-results"`
- Arguments: `["autoprompt-gate-runner","--check","join-check-results"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["deterministic-control-plane","json-schema-validation"]`
- Observable check kind: `"deterministic-result-join"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["deterministic-control-plane","json-schema-validation","evidence-capture"]`
- Observable check success condition: `"Every declared output of join-check-results exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"CHECK_INCONCLUSIVE","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["INPUT_FINGERPRINT_CHANGED"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"FAILED"`
- Exhaustion outcome code: `"FAILED"`

### Check `named-risk-check`
- Owner: `"independent-reviewer-or-tester"`
- Command kind: `"contract-operation"`
- Operation: `"check-named-risk"`
- Arguments: `["autoprompt-gate-runner","--check","named-risk-check"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["independent-checking","risk-specific-validation"]`
- Observable check kind: `"risk-specific-oracle"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["independent-checking","risk-specific-validation","evidence-capture"]`
- Observable check success condition: `"Every declared output of named-risk-check exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"CHECK_INCONCLUSIVE","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["INPUT_FINGERPRINT_CHANGED","TRANSIENT_TOOL_FAILURE"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"BLOCKED"`
- Exhaustion outcome code: `"BLOCKED"`

### Check `plan-check`
- Owner: `"plan-checker"`
- Command kind: `"contract-operation"`
- Operation: `"check-roadmap"`
- Arguments: `["autoprompt-gate-runner","--check","plan-check"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["independent-checking","roadmap-validation"]`
- Observable check kind: `"independent-roadmap-check"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["independent-checking","roadmap-validation","evidence-capture"]`
- Observable check success condition: `"Every declared output of plan-check exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"CHECK_INCONCLUSIVE","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["INPUT_FINGERPRINT_CHANGED","TRANSIENT_TOOL_FAILURE"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"BLOCKED"`
- Exhaustion outcome code: `"BLOCKED"`

### Check `produce-work`
- Owner: `"worker"`
- Command kind: `"contract-operation"`
- Operation: `"produce-assigned-result"`
- Arguments: `["autoprompt-gate-runner","--check","produce-work"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `900`
- Command availability: `"required-preflight"`
- Command required capabilities: `["artifact-mutation","effect-specific-acceptance"]`
- Observable check kind: `"effect-specific-result"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["artifact-mutation","effect-specific-acceptance","evidence-capture"]`
- Observable check success condition: `"Every declared output of produce-work exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `3`
- Retryable failures: `["INPUT_FINGERPRINT_CHANGED","EVIDENCE_FINGERPRINT_CHANGED","TRANSIENT_TOOL_FAILURE"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"FAILED"`
- Exhaustion outcome code: `"FAILED"`

### Check `roadmap-authoring`
- Owner: `"roadmap-author"`
- Command kind: `"contract-operation"`
- Operation: `"author-roadmap"`
- Arguments: `["autoprompt-gate-runner","--check","roadmap-authoring"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `900`
- Command availability: `"required-preflight"`
- Command required capabilities: `["roadmap-authoring","dependency-analysis"]`
- Observable check kind: `"roadmap-coverage-and-order"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["roadmap-authoring","dependency-analysis","evidence-capture"]`
- Observable check success condition: `"Every declared output of roadmap-authoring exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `3`
- Retryable failures: `["SCHEMA_INVALID","INPUT_FINGERPRINT_CHANGED","EVIDENCE_FINGERPRINT_CHANGED"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"FAILED"`
- Exhaustion outcome code: `"FAILED"`

### Check `short-plan`
- Owner: `"run-owner"`
- Command kind: `"contract-operation"`
- Operation: `"compile-light-plan"`
- Arguments: `["autoprompt-gate-runner","--check","short-plan"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["json-schema-validation","dependency-analysis"]`
- Observable check kind: `"schema-and-dependency"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["json-schema-validation","dependency-analysis","evidence-capture"]`
- Observable check success condition: `"Every declared output of short-plan exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["SCHEMA_INVALID"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"FAILED"`
- Exhaustion outcome code: `"FAILED"`

### Check `static-review`
- Owner: `"independent-reviewer"`
- Command kind: `"contract-operation"`
- Operation: `"review-frozen-version"`
- Arguments: `["autoprompt-gate-runner","--check","static-review"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["independent-checking","static-analysis"]`
- Observable check kind: `"static-review-oracle"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["independent-checking","static-analysis","evidence-capture"]`
- Observable check success condition: `"Every declared output of static-review exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["INPUT_FINGERPRINT_CHANGED"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"BLOCKED"`
- Exhaustion outcome code: `"BLOCKED"`

### Check `success-definition`
- Owner: `"run-owner"`
- Command kind: `"contract-operation"`
- Operation: `"compile-success-definition"`
- Arguments: `["autoprompt-gate-runner","--check","success-definition"]`
- Working directory: `"declared-workspace"`
- Command timeout seconds: `300`
- Command availability: `"required-preflight"`
- Command required capabilities: `["json-schema-validation","effect-specific-acceptance"]`
- Observable check kind: `"schema-and-effect-acceptance"`
- Observable check availability: `"required-preflight"`
- Observable check required capabilities: `["json-schema-validation","effect-specific-acceptance","evidence-capture"]`
- Observable check success condition: `"Every declared output of success-definition exists, is bound to the frozen inputs, and satisfies its effect-specific acceptance."`
- Negative path: `{"id":"command-unavailable","condition":"The command or a required capability is unavailable at preflight or execution time.","expectedOutcome":"PROVIDER_UNSUPPORTED","requiredEvidence":["capability-attestation","availability-probe"]}`
- Negative path: `{"id":"oracle-rejected","condition":"The command returns but the observable check rejects an output or required negative-path check.","expectedOutcome":"FAILED","requiredEvidence":["command-receipt","oracle-result","negative-path-result"]}`
- Retry kind: `"bounded-progress"`
- Maximum attempts: `2`
- Retryable failures: `["SCHEMA_INVALID"]`
- Requires progress after failure: `true`
- Progress fingerprint fields: `["inputHashes","candidateVersionHash","oracleEvidenceHash"]`
- Maximum unchanged failures: `1`
- Exhaustion state: `"FAILED"`
- Exhaustion outcome code: `"FAILED"`

<!-- AUTOPROMPT-COMPILED-GATES:END -->
