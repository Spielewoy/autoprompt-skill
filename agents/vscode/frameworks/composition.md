
# How frameworks COMPOSE (stack and run simultaneously)

**You are the PARENT.** This is how you run more than one framework for a task that
spans surfaces. It adds NO new scheduler/gate/level - it reuses the existing
L2→L3 sibling split, the per-L3 fan-out discipline (no numeric ceiling in
BILLIONAIRE), the TOKENSAVER/BILLIONAIRE modes, and the run-global budget (cited
by name, never restated).

## Two modes
- **HORIZONTAL STACK - N frameworks, simultaneous.** A task spanning disjoint
  surfaces is split into N disjoint-ownership sub-tasks; the README §3 selector
  runs once per sub-task → N frameworks, each becomes ONE sibling L3 track.
  WIDE runs them parallel (no per-L3 numeric cap, bounded by MAX_CONCURRENT);
  TOKENSAVER in a small ≤6 wave.
- **VERTICAL LAYER - one track + an overlay.** A single track's primary framework
  may carry ONE playbook-tag overlay (`debug`/`research`/`user-facing`/`polish`/
  `external-target` - never a category). The overlay reshapes only its tag's gate
  (G1/G6 for most; **G7** for `polish`). The `polish` pass is also a standalone leaf
  (`frameworks/polish.md`) when it is the whole task; as an overlay it applies that
  leaf's G7 sign-off gate over another track. Same gates run, same single track.

## The algorithm (you, the parent, run this - zero judgment)
1. **DECOMPOSE** the task from the executable `ROADMAP.md` into atomic sub-tasks,
   each with a SINGLE owned-file-set and no file in two sets. One sub-task → **S5**.
2. **SELECT** per sub-task: run README §3 once each → a STACK = list of
   `(framework, owned-file-set)`. A sub-task that returns `FRAMEWORK: MISS` (no confident
   seeded match) routes to the GENERATOR (`frameworks/generation.md`,
   HRN-1→HRN-4): a novel sub-surface stacks a GENERATED `gen-<axis-signature>` sibling
   leaf - never a silent backend-implement. A cross-cutting CONCERN outside the closed 5
   playbook tags is handled by a tiny `gen-overlay-<concern>` (a VERTICAL layer reshaping
   only G1/G6/G7, validated by `validateOverlay`), not a new category track.
3. **CHECK DISJOINTNESS:** every pairwise file-set intersection is empty. Any
   overlap → **S1**.
4. **MOUNT:** the L2 manager builds one L2→L3 handoff per row and dispatches each
   as a sibling track (mission verbatim + nonce + that framework). Over budget → **S4**.

## The invariant (deterministic)
Two frameworks STACK only if their owned file sets are DISJOINT. Empty intersection
→ mount. Overlap → the L2 manager re-splits; if they can't be made disjoint they
are ONE feature/one track, not two. A parallel WRITE to a shared file is NEVER
permitted.

## Worked examples
- **Horizontal - "fix the backend bug AND polish the landing page":** decompose →
  A=`src/api/orders.py` (→ `backend-fix`), B=`web/landing/*` (→ `frontend-implement`
  + `polish` overlay, `frameworks/polish.md`). Disjoint → two sibling tracks; parallel in BILLIONAIRE.
- **Vertical - "build a new landing flow, polished":** one owned-file-set → one
  track = `frontend-build` + `polish` overlay (the overlay adds the `frameworks/polish.md`
  G7 judge loop). One track, not a stack.

## Closed scenarios (each → ONE action)
- **S1 - two frameworks share a file** → L2 re-splits to disjoint, else COLLAPSE to
  one track. Never a parallel write to a shared file.
- **S2 - a "sub-task" is really two** → decompose further before selecting.
- **S3 - an overlay would be a CATEGORY, not a tag** → reject; route it as its own
  sibling track (a category is a track, never a vertical layer).
- **S4 - the stack exceeds the run-global budget** (GATES.md "RUN-GLOBAL SUBAGENT
  BUDGET"; max-concurrent base 200) → queue/serialize the overflow; never spawn past
  the ceiling.
- **S5 - one sub-task (degenerate)** → no stack; one L3 track (a vertical overlay
  may still apply).
- **S6 - two tracks have a gate-order dependency** → serialize by the edge; only
  independent tracks run in parallel.

## Alignment (point at, don't restate)
GATES.md "FAN-OUT IS THE EXCEPTION" (composition is the MANAGER dispatching sibling
tracks, never an L3 spawning) + "RUN-GLOBAL SUBAGENT BUDGET"; MODES.md Axis 1/2 +
max-concurrent; PLAYBOOKS.md L2→L3 split + playbook tags; README §3.
