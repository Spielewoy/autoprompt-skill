RUN-DATE: 2026-06-20 (cosmetic only - NOT part of the matched nonce)

# QUICKSTART - the framework on-ramp

You have a task. This framework ecosystem routes that task to exactly ONE named
workflow, and you follow that workflow step by step. You do not design the
process - you pick the right framework, open its file, and obey its numbered
steps. This page is the on-ramp; it gets you from "I have a task" to "I am
following the right framework" in three moves.

---

## The 3-step on-ramp

1. **SELECT.** Run the SELECTOR RUBRIC in `frameworks/README.md` §3. Walk
   it top to bottom, FIRST MATCH WINS. It hands you exactly ONE framework name.
2. **OPEN.** Open `frameworks/<that-framework>.md` (e.g. `backend-fix.md`).
3. **FOLLOW.** Do its numbered steps top to bottom, obeying every if/else
   scenario it lists. That's it.

---

## Worked example

Task: "fix a crash in the API." Run the §3 selector → STEP 1c (server logic →
`backend`) → STEP 2d (something is broken) → framework name **`backend-fix`**.
Open `frameworks/backend-fix.md`. Follow its steps: reproduce the crash
red, root-cause it, fix it, prove green. Done when its workflow says done.

---

## The 14-leaf map at a glance (name → when)

- **`apply`** - the WHAT is fully specified (frozen spec, "rename X to Y everywhere", scaffold, config, dep bump): apply it, diff-review, prove green. No plan gate.
- **`backend-fix`** - a backend behavior is broken: reproduce red, root-cause, fix, prove green.
- **`backend-implement`** - add/change ONE bounded backend capability (endpoint, rule, job) with tests.
- **`backend-build`** - build a whole NEW backend component/surface from scratch, incl. wiring.
- **`frontend-fix`** - a UI/client behavior is broken: reproduce red, root-cause, prove green.
- **`frontend-implement`** - add/change ONE bounded UI/client piece with tests + a usability check.
- **`frontend-build`** - build a whole NEW UI surface/flow from scratch.
- **`frontend-review`** - multi-persona live-site review: N real-user personas visit the RUNNING app, screenshot each step, report bugs/visual/UX/copy/customer-engagement findings into one deduped artifact; P0/P1s route back as fix lanes. Degrades to a marked static walkthrough when no browser.
- **`polish`** - visual/copy/detail polish pass over an existing working surface (spacing, states, microcopy, responsiveness); pairs with `frontend-review` findings.
- **`refactor`** - behavior-preserving restructuring: characterization tests first, then reshape + dead-code removal, PROVEN zero behavior change.
- **`plan-scope`** - turn a mission into a scoped, dependency-ordered feature breakdown/roadmap.
- **`plan-research`** - find/define an UNKNOWN target via real research-with-receipts (thesis + shortlist).
- **`plan-design`** - produce an architecture/design decision for a KNOWN target (the blueprint a build framework consumes).
- **`docs`** - a documentation deliverable (README/API docs/guide): audience analysis, accuracy-against-code verification, an example that runs.

---

## TWO hard rules you must NEVER violate

1. **FOLLOW LITERALLY.** Do the chosen framework's numbered steps and its if/else
   scenarios exactly as written. Do not improvise, reorder, or skip. The framework
   is the contract - no more, no less.
2. **THE BLOCKED INVARIANT.** On ANY blocker, STOP: report the attempt + the concrete
   unblock path and loop the verdict UP to your dispatcher - never fake a pass, never
   fabricate evidence, never declare DONE over a red or un-runnable check, and NEVER
   yield to the user. Each leaf carries this ~5-line invariant verbatim; obey it.

---

## Multi-part / stacked tasks

If your task spans more than one framework (e.g. fix a backend bug AND build a
new page), see `frameworks/composition.md` for how frameworks stack and
run simultaneously.
