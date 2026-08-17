# Codex modes contract

`SKILL.md` is authoritative. This file defines the runtime knobs and must not
reintroduce legacy workflow governance.

## Roadmap-first invariant

New runs start useful-first work after the chooser. There is no separate intake round
trip, mandatory preflight agent, scope-map, or separate plan bureaucracy. A
trusted launch attestation with complete bindings may skip probing; otherwise the
first roadmap author proves RUN, READ, and WRITE on a disposable scratch path, then
continues directly into repository inspection. Failure hard-stops before build.

Scope produces one canonical, executable `ROADMAP.md`:

- **bounded scope = 3 agents, 2 rounds**, target **under one minute**: roadmap
  author, then concurrent independent reviewer and blind fresh verifier;
- **multi-surface scope = exactly 5 agents, 3 rounds**, target **under five
  minutes**: retain the complete author roadmap and evidence, add exactly two
  complementary scouts, then run the reviewer and blind fresh verifier
  concurrently without a redundant ordinary synthesis dispatch;
- **unusually-large scope:** exceed the 6-agent ordinary scope budget only for a
  concrete reason recorded in `GATELOG.md`.

On rejection, preserve accepted evidence and repair only named defects. The
approved roadmap owns scope, stable item ids, dependency edges, launch groups,
file/surface ownership, integration, acceptance, unhappy paths, tests, coverage,
and real verification. Implementation-ready items dispatch directly; add detailed
planning only for a roadmap-marked need, debug/depth-lock work, a named unresolved
design fork, or a worker-reported plan conflict.

New-run governance is **exactly three files**:

1. `PROMPTS.txt` - exact append-only prompt blocks;
2. `ROADMAP.md` - the one executable scope/decomposition/plan source;
3. `GATELOG.md` - append-only transitions, provenance, verdicts, elapsed time,
   assumptions, escalation reasons, and resume frontier.

Do not create governance-only `BRIEF.md`, `PLAN.md`, `AGENTS.md`, `COVERAGE.md`,
`BACKLOG.md`, `ANCHOR.md`, `bucketlist.md`, `intake.md`, `scope-map.md`, per-angle
scope files, or equivalents. Substantive implementation, test, review, and
verification evidence remains valid. Legacy formats are **resume-only**: read them
only to continue an existing run, never emit them for a new run. Contradictory
mixed governance fails closed.

After the first author stores the exact mission in `PROMPTS.txt`, briefs use a
compact mission pointer:

```text
MISSION POINTER: verify the exact prompt ledger before acting.
path=<PROMPTS.txt> hash=sha256:<64 hex> bytes=<UTF-8 byte length> nonce=<RUN-NONCE>
```

Include only role, objective, owned boundary, dependencies, acceptance criteria,
hashed roadmap/evidence pointers, output contract, and truthful model/effort
status. Do not paste the full mission into every brief, the full roadmap,
transcript, doctrine, or prior adversarial reasoning. Workers verify pointers
before acting; blind reviewers remain blind.

## Orthogonal runtime knobs

Concurrency, attendance, agent selection, and roadmap work shape are independent.
Concurrency changes how many ready agents run; agent selection changes only model
and reasoning effort; neither changes the roadmap's gates or dependencies.

### Concurrency

| Mode | Contract |
|---|---|
| `tokensaver` | Default. Up to six live agents, constrained further by the runtime ceiling. |
| `wide` | Dispatch all ready, genuinely disjoint lanes together, up to the runtime/global ceiling. |
| `billionaire` | Accepted legacy spelling of `wide`; no separate semantics. |
| `custom max_subs=N` | Wide dispatch with an explicit positive live-agent cap. |

`agents.max_threads` is always a hard runtime ceiling; `max_subs` can only lower
it. Limits are ceilings, not targets. Reuse valid evidence, deduplicate ownership,
and spawn no agent merely to fill capacity. A single bounded lane skips L2;
disjoint ready lanes launch together spawn-all-then-collect: issue every spawn of
a ready group before collecting any report - parallel background dispatch is the
default shape, and serialization is allowed only for declared real dependencies.
When three or more lanes are ready and achievable width is at least three, at
least three workers must run concurrently; lower explicit ceilings remain
truthful and valid. Stream completions rather than waiting for an entire wave.

Every dispatch is collect-then-stop: stop that agent explicitly once its final
report is collected; a parked resumable agent is still a live agent and counts
against the ceiling. DONE requires zero live subagents.

Accepted directives are `mode=tokensaver|wide|billionaire|custom`, a leading bare
mode word, and `max_subs=N`. Strip runtime directives from the mission. Reject an
invalid custom cap instead of silently inventing one.

### Chooser and attendance

Resolve only undefined operator knobs before repository/tool work. In an attended
session, ask once for all missing values:

- concurrency: Tokensaver, Wide, or Custom;
- agent selection: Inherit, Auto-tier, or Custom set;
- effort capability: first report exactly `selectable`, `inherited-only`,
  `unsupported`, or `unknown`; name a verified maximum only when `selectable`.

Do not ask the user to restate, narrow, or approve the mission. In a supervisor-
launched unattended run, never ask: default missing concurrency to `tokensaver`
and missing agent selection to `off`, and record both assumptions in `GATELOG.md`.
A permission-bypass flag alone does not make a run unattended.

An explicit operator control deterministically overrides unattended defaults;
resolve any knob conflict in the operator's favor and record it in `GATELOG.md`,
never defer it into a silent default.

The arbiter resolves technical forks. Mid-run user questions are limited to
user-owned irreversible/destructive actions, real money or quota, unavailable
credentials, or product direction. Capability failure, blockers, coverage, and
real verification cannot be arbitrated away.

### Codex agent selection and reasoning effort

Codex casting uses the installed custom-agent TOMLs and their exact `model` and
`model_reasoning_effort` fields. It does **not** use Claude Code model-family
aliases, alias routing, or environment-variable inheritance claims.

- `agents=off` or omitted: use installed definitions without a requested cast;
  omitted model/effort fields inherit only when the live Codex runtime verifies
  that behavior.
- `agents=auto`: use a pre-exported cast ranked from the configured model registry.
- `agents=<comma-list>`: preserve operator order, strongest to weakest, using
  registered exact-case names or exact provider model strings.
- `agents=auto:<comma-list>`: rank only that registered pool.

Casting is a pre-launch configuration step. Exported definitions, selector
metadata, and the live launch must match; an explicit mismatch fails rather than
pretending the selection applied. One selected model routes every role to it.
With multiple models, assign stronger models to reasoning-heavy roles without
inverting operator order.

Record effort truthfully:

- `selectable`: set `model_reasoning_effort`; use the verified maximum for scope,
  coordination, scouting, synthesis, planning, review, blind/runtime verification,
  juries, goal check, arbitration, and depth-lock; ordinary implementation defaults
  high; mechanical records/cleanup may be lower;
- `inherited-only`, `unsupported`, or `unknown`: omit the effort field and record
  that exact fallback; never claim a requested or maximum effort was applied.

## Steering, resume, and authority

A non-urgent steer is queued into the next continuation and appended as the next
exact prompt block in `PROMPTS.txt`; existing work continues. A steer that clearly
invalidates live work is urgent: checkpoint the frontier in `GATELOG.md`, cancel,
append the prompt, and redispatch from the checkpoint. Never cancel before the
checkpoint.

Resume is explicit: only an explicit `resume` instruction or a supervisor
relaunch resumes a run. The resuming context reads only the `GATELOG.md` tail -
the last frontier row - verifies its mission pointer hash, and dispatches the
open frontier with compact pointer briefs. Workers, not the resuming context,
read `ROADMAP.md` sections and substantive evidence. Treat empty, temporary,
malformed, or hash-mismatched artifacts as absent. Re-verify the last accepted
frontier and continue idempotently. Legacy ledgers may supply a resume frontier
but must not be extended with new legacy governance files.

No external or git action is implied by invoking Autoprompt or by unattended mode.
Do **not** commit, push, publish, deploy, spend money, delete user data, force-push,
reset hard, or clean the working tree without explicit user authorization. The
supervisor provides relaunch/resume only; it grants no publication or git authority.
