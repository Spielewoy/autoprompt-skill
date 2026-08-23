
# The framework map (route a feature to its workflow)

**From the approved executable `ROADMAP.md`,** walk the SELECTOR (§3) ONCE for
each feature's category/tag/tier (first-match-wins) to land on exactly ONE named
framework; record `FRAMEWORK: <leaf>`. **L0 spawns the run's SINGLE
ap-feature-coordinator (L1) - once per run, owning ALL features - and hands it
the roadmap feature set plus each framework name. For a multi-feature slice the coordinator fans ONE L2 ap-manager PER FEATURE;
for a single bounded feature it builds the handoff itself and dispatches the L3
executor(s) DIRECTLY (managers are optional). Whoever dispatches - manager or
coordinator - opens the feature's leaf spec and DRIVES it** (dispatches its gates
to L3/L4 workers). The leaf specs are end-to-end workflows driven by the feature's
dispatcher under the one coordinator.

A framework = one CATEGORY × one SUB-SECTION + a default tag and tier. It names the
end-to-end workflow + closed if/else scenarios the dispatcher follows, INCLUDING its
declared `GATE PATH` (the shape names which gates run; the tier stays the depth
ceiling). Each leaf spec carries an explicit `GATE PATH:` line; the list below mirrors
it so this doc doubles as the routing table. The 3 front doors route all seven roadmap
categories (PLAYBOOKS.md): **backend** = `backend`/`data`/`integration`/`infra`;
**frontend** = `frontend`; **plan** = `plan`/`docs` - plus the category-agnostic
`apply` front door for fully-specified mechanical changes.

---

## 1. The 14 leaves (each → its spec file under `frameworks/`)

**(APPLY) - category-agnostic, fully-specified mechanical change**
- `apply` - WHAT is already fully known (frozen spec, "rename X to Y", scaffold, config, dep bump): apply it, prove green. no tag, T0/T1. GATE PATH: `APPLY → DIFF-REVIEW → VERIFY-GREEN` (no plan gate, no fresh-verify, no juror - PROPORTIONAL-GATES minimal path).

**(A) backend** - server / data / integration / infra
- `backend-fix` - broken behavior: reproduce red, root-cause, prove green. `debug`, T1/T2. **Carries the BLOCKED invariant.** GATE PATH: `G1 PLAN → G3.5 DEPTH-LOCK → G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY → GOAL-CHECK` (T2 adds a juror).
- `backend-implement` - add/change ONE bounded capability with tests. no tag, T2. GATE PATH: `G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY → G7 SIGN-OFF → GOAL-CHECK`; prepend G1 only for `requiresDetailedPlan`, an unresolved design fork, or `PLAN-CONFLICT`.
- `backend-build` - a whole new component from scratch + wiring. no tag (`external-target` overlay if it joins an external system), T2/T3. GATE PATH: `G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY → G7 SIGN-OFF → GOAL-CHECK`; prepend G1 only for `requiresDetailedPlan`, an unresolved design fork, or `PLAN-CONFLICT` (T3 adds SCOPE-AND-ROADMAP + 3 jurors).

**(B) frontend** - any human-touched UI / client / CLI surface
- `frontend-fix` - broken UI behavior: reproduce red, prove green. `debug`, T1/T2. GATE PATH: `G1 PLAN → G3.5 DEPTH-LOCK → G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY → GOAL-CHECK` (T2 adds a juror).
- `frontend-implement` - one bounded UI piece + tests + usability check. `user-facing`, T2. GATE PATH: `G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY(+usability) → G7 SIGN-OFF → GOAL-CHECK`; prepend G1 only for `requiresDetailedPlan`, an unresolved design fork, or `PLAN-CONFLICT`.
- `frontend-build` - a whole new UI surface/flow. `user-facing`, T2/T3. GATE PATH: `G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY(+usability) → G7 SIGN-OFF → GOAL-CHECK`; prepend G1 only for `requiresDetailedPlan`, an unresolved design fork, or `PLAN-CONFLICT` (T3 adds SCOPE-AND-ROADMAP + 3 jurors).
- `frontend-review` - multi-persona live-site review: N personas visit the RUNNING app, screenshot each step, report bugs/visual/UX/copy/engagement findings into one deduped artifact; P0/P1s route back as fix lanes. `user-facing`, T1/T2/T3. GATE PATH: `G0 SURFACE-PROBE → G1 PLAN(personas) → PERSONA-FANOUT(live visits + screenshots) → DEDUPE → G6 REVIEW-VERIFY → ROUTE-FIXES → GOAL-CHECK`. Degrades to a marked UNVERIFIED-VISUALLY static walkthrough when no browser - never a faked screenshot.
- `polish` - visual/copy/detail polish pass over an existing working surface (spacing, states, microcopy, responsiveness). `polish`, T1/T2. GATE PATH: `G1 PLAN(inventory) → G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY(+rendered) → G7 SIGN-OFF(polish gate) → GOAL-CHECK`; T1 omits G7 but retains G5/G6. Pairs with `frontend-review` findings.

**(C) plan** - spec/design/research/docs (owns no production code)
- `plan-scope` - mission → dependency-ordered feature roadmap. no tag, T2/T3. GATE PATH: `AUTHOR → REVIEW + FRESH-VERIFY → DONE` for bounded scope; multi-surface adds exactly two concurrent scouts between author and assurance.
- `plan-research` - find/define an UNKNOWN target via real research-with-receipts. `research`, T2. GATE PATH: `FRAME + DIVIDE → RESEARCH per theme → SYNTHESIZE → FRESH-VERIFY → DONE`.
- `plan-design` - architecture decision for a KNOWN target (the build's blueprint). no tag, T2. GATE PATH: `FRAME → ENUMERATE options → DECIDE + BLUEPRINT → FRESH-VERIFY → DONE`.
- `docs` - documentation deliverable (README/API docs/guide): audience analysis + accuracy-against-code verification + an example that runs. no tag, T0/T1/T2. GATE PATH: `G4 WRITE → G5 DOC-REVIEW → G6 ACCURACY-VERIFY(against code + example runs) → GOAL-CHECK`; T1/T2 prepend G1 audience planning.

**(REFACTOR) - behavior-preserving restructuring (backend or frontend)**
- `refactor` - characterization tests first, then reshape + dead-code removal, PROVEN zero behavior change. no tag, T1/T2. GATE PATH: `G0 CHARACTERIZE → G1 PLAN(reshape) → G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY(zero delta) → GOAL-CHECK`; both tiers retain independent review and verification.

---

## 2. Stacking (multi-surface tasks)

A task spanning surfaces is split in ROADMAP.md into disjoint-ownership features; the
selector runs per feature and each feature runs as a sibling L2 ap-manager under
the one ap-feature-coordinator (parallel in WIDE, a small ≤6 wave in TOKENSAVER),
each manager driving its framework's gates as L3/L4 work. Full mechanism + scenarios:
`frameworks/composition.md`.

---

## 3. The SELECTOR (closed tree, FIRST MATCH WINS, no judgment step)

```
SELECT-FRAMEWORK(task):

STEP 0 - APPLY front door (fully-specified mechanical change), first:
  0a. the mission LITERALLY carries an exact diff OR an explicit command/edit list
      (frozen patch, "rename X to Y everywhere", scaffold emission, config change,
      dep bump) AND no design decision remains. No such artifact in hand => apply
      is INELIGIBLE; fall through to STEP 1 (never self-declare "spec complete") -> apply

STEP 1 - CATEGORY (front-door surface), first match wins:
  1a. OUTPUT is a spec/plan/roadmap/research finding/architecture decision/
      documentation AND no production code changes              -> plan
  1b. elif it touches a HUMAN-FACING surface (UI, web/client screen,
      a CLI command a person types)                             -> frontend
  1c. else (server logic, data, integration, infra - DEFAULT)   -> backend

STEP 2 - SUB-SECTION, first match wins:
  if plan:
    2a. target is UNKNOWN, must be discovered/researched         -> plan-research
    2b. elif a known target needs an architecture decision       -> plan-design
    2c. elif the output is DOCUMENTATION (README/API docs/guide)  -> docs
    2d. else (scope into features - DEFAULT)                      -> plan-scope
  if backend OR frontend:
    2e. behavior-preserving RESTRUCTURING (no behavior change)    -> refactor
    2f. elif something is BROKEN / behaves wrong / a test is red  -> <category>-fix
    2g. elif (frontend) a multi-persona LIVE REVIEW of a running
        surface (needs a runnable surface signal)                -> frontend-review
    2h. elif (frontend) a visual/copy/detail POLISH pass          -> polish
    2i. elif building a WHOLE NEW component/surface from scratch  -> <category>-build
    2j. else (change one bounded piece - DEFAULT build arm)      -> <category>-implement

If STEP 0 / STEP 1 / STEP 2 do not produce a CONFIDENT match (category ∧ sub-section),
the selector returns `FRAMEWORK: MISS` and routes to the GENERATOR (`frameworks/generation.md`).
There is NO silent default - a non-matching task NEVER lands on backend-implement.
A `frontend-review` with no runnable-surface signal is NOT a confident review match - it
falls to `frontend-fix` (if broken) or `frontend-implement`, deterministically, never a
faked live review. **This prose tree (§3) is the SINGLE SOURCE OF TRUTH for routing** -
walk it by hand, first-match-wins; the former `workflow/framework-selector.js`
has been removed, so never defer routing to it. A confident branch ends at a seeded leaf; a
non-confident task returns MISS and routes to the GENERATOR (`frameworks/generation.md`).
```

Closure: closure is over SELECT ∪ GENERATE. Every routed leaf exists; every seeded leaf
is reachable; a confident branch ends at a leaf; a non-confident task returns MISS and
routes to GENERATE (never a silent backend-implement); a genuinely two-piece task is
decomposed then stacked (§2).
