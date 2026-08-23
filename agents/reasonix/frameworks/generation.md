
# The GENERATOR (custom framework per task, universally)

When the README §3 SELECTOR returns `FRAMEWORK: MISS` - a task whose shape no seeded
leaf confidently matches - the loop does NOT degrade onto `backend-implement`. It
GENERATES a custom framework for that exact task shape. This file is the algorithm +
the persona-facing contract the ap-framework-generator follows.

## 1. AXES - classify the task on three orthogonal dimensions (HRN-4 step 1)

`classifyAxes(task)` projects any task onto:

- **deliverableKind**: `code-change` | `new-build` | `data-pipeline` | `infra-apply` |
  `ml-eval` | `research` | `docs` | `perf` | `migration`
- **acceptanceKind**: `unit-coverage` | `test-set-flip` | `metric-threshold` |
  `dry-run-diff` | `receipts`
- **targetLocus**: `in-repo` | `external-system`

Explicit task axis fields win; otherwise the axes are inferred from the seeded signals
(`isBroken`/`isNewComponent`/`category`). Fail-closed: a null/garbage task → all `unknown`.

The deterministic **axis-signature** (`axisSignature(axes)`) is the kebab slug
`<deliverable>-<acceptance>-<locus>` (e.g. `ml-eval-metricthreshold-in-repo`). It is the
generated leaf's NAME (`gen-<signature>`).

## 2. GATE-LIBRARY - compose the gate sequence (HRN-4 step 2)

`composeGateSequence(axes)` draws from the GATE-LIBRARY and substitutes the axis-specific
verify gate for the meaningless one:

| acceptanceKind | verify gate |
|---|---|
| unit-coverage / test-set-flip | `unit-coverage-verify` |
| metric-threshold | `metric-threshold-verify` |
| dry-run-diff | `apply-dry-run` |
| receipts | `receipts-verify` |

Deliverable adds an extra gate where the shape demands it: `data-pipeline` →
`idempotent-replay`; `infra-apply` → `apply-dry-run`; `perf` → `measure-first-baseline`.
The sequence always opens with `plan-verify`/`fresh-verify`/`implement` and closes with
`goal-check`/`sign-off`.

## 3. The generated leaf template - `gen-<axis-signature>.md` (HRN-4 steps 3-4)

`generateFramework(task)` emits a leaf DESCRIPTOR in the S1-S5 leaf shape:

- `name`: `gen-<axis-signature>`
- `gates`: the composed sequence (§2)
- `invariant`: the BLOCKED INVARIANT, verbatim (below)
- `scenarios`: S1..S5, every negative verdict loops UP, exactly one terminal DONE (S5)
- `execharnessRef`: `execharness-<signature>.json` (the two-sided gate, HRN-2)
- `acceptance`: the mission's acceptance asks, echoed into `failToPass` (HRN-8)

### THE BLOCKED INVARIANT (non-negotiable) - verbatim in every generated leaf

The exact same ~5-line block every seeded leaf carries (byte-for-byte), so a generated
leaf is indistinguishable from a seeded one to the validator:

> Verification runs the REAL check in its REAL environment - NEVER fake a pass, NEVER
> fabricate evidence, NEVER declare DONE over a red or un-runnable check. On ANY blocker,
> STOP and report the attempt + the concrete unblock path, then loop that verdict UP to
> your dispatcher (never sideways) - stay in the closed loop and resolve every open
> question through a subagent, NEVER yielding to the user.

## 4. VALIDATE before driving (HRN-5 - default-FAIL)

`validateGeneratedFramework(leaf)` is a fresh, default-FAIL juror. A leaf is SOUND only if
ALL hold; any breach → `{ok:false, reasons}` and the leaf is NEVER driven:

- (a) every gate ∈ GATE_LIBRARY (no unmapped gate)
- (b) exactly one terminal DONE scenario; every negative scenario loops UP
- (c) the BLOCKED INVARIANT present verbatim
- (d) a non-empty acceptance set (the two-sided gate has something to flip)

On FAIL the generator re-mints ONCE; a second FAIL escalates OUT-OF-SCOPE.

## 5. One-off by design (no promotion registry)

A generated leaf is a ONE-OFF for the task that minted it - it is validated (§4), driven,
then discarded. There is deliberately NO promotion registry: if an identical MISS shape
recurs, it is simply GENERATED again (cheap and deterministic from the axis-signature). A
persistent promoted-leaves registry is not built until a real recurring MISS is actually
observed in the wild - until then it is unexercised machinery, and its absence is not a
silent fallthrough (INV-13): a MISS still mints + validates a fresh leaf, never degrades
onto `backend-implement`.

## 6. Worked example - an ML/eval task

Task: "raise the recommender's held-out F1 to >= 0.85." No seeded leaf fits.

- `classifyAxes` → `{deliverable:'ml-eval', acceptance:'metric-threshold', locus:'in-repo'}`
- `axisSignature` → `ml-eval-metricthreshold-in-repo`
- `generateFramework` → `gen-ml-eval-metricthreshold-in-repo` whose gate sequence carries
  `metric-threshold-verify` (NOT a meaningless `unit-coverage-verify`), binds
  `execharness-ml-eval-metricthreshold-in-repo.json`, and echoes "F1 >= 0.85 on the
  held-out set" into `failToPass`.
- `validateGeneratedFramework` PASSES it → it may be driven. It is a one-off; an identical
  shape in a later run is simply GENERATED again (no promotion registry).

## Alignment (point at, don't restate)

README §3 SELECTOR (MISS → here; the single source of truth for routing); composition.md
(stacking generated siblings); GATES.md TIER CONTRACTS (gates per tier).
