# Grok Build modes contract

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

The runtime task ceiling is always a hard cap; `max_subs` can only lower
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
- agent selection: Inherit only;
- effort capability: report exactly `inherited-only`.

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

### Grok Build agent selection and effort

Grok Build casting is `inherited-only`: every installed `ap-*` definition pins
`model: inherit`, so each child process runs the model the launcher resolved for
the run.

- `agents=off` or omitted: the routable mode; every role inherits the run model.
- any explicit model selector: not routable through these definitions; record
  `inherited-only` and do not claim that a selection applied.

Record effort as exactly `inherited-only` unless the operator set one run-wide
reasoning effort, which the dispatcher applies unchanged to every child and carries
forward so deeper hops keep it.

Grok Build caps native subagent nesting at one level, so `spawn_subagent` can never carry the L0-L4 topology. Every `ap-*` definition therefore denies the native task tool, and every edge runs through the sealed dispatcher: it validates the launch activation, the caller persona, the canonical child allowlist, the depth ceiling of 4, the framework registry, and the exact bytes of the prompt ledger before it starts the child as its own `grok --prompt-file <envelope> --agent <definition>` process. Dispatch roles reach it through the `autoprompt` MCP server (`autoprompt__dispatch`); non-dispatch roles have MCP discovery removed, and the dispatcher refuses terminal callers regardless. Because Grok Build offers user-scoped MCP servers to every session, an activation token minted by the launcher is required before any dispatch: a session Autoprompt did not start has none and is refused, never treated as the conductor.

Dispatch a ready group in one call by passing `jobs`: every job is admitted before any child starts, the group then runs concurrently, and all reports are collected together. That is the spawn-all-then-collect shape, so reviewers, verifiers, and disjoint lanes really do run in parallel. The live-child ceiling is run-global, not per group: because every hop is its own process, the dispatchers of a run share file-backed slots keyed to the run activation, so the conductor, each coordinator, and each manager all draw from the same set. A dispatcher waiting on its own children yields its slot for that wait, which is what keeps a full run from deadlocking. The ceiling is `AUTOPROMPT_GROK_MAX_SUBS`, defaulting to the six live children `tokensaver` allows; raise it for `wide` or `custom max_subs=N`. A denied job cancels its whole group rather than leaving half a fleet running. Each slot is held by a lease id rather than by its path: claiming hard-links a fully written file into place, and releasing or reclaiming happens only while the lease on disk still matches, so a stale holder cannot evict its successor and one dead holder is reclaimed exactly once. The slot root therefore has to be a local filesystem that supports hard links and exclusive creation - a POSIX temp directory or NTFS does, FAT and network shares do not - and `AUTOPROMPT_GROK_SLOT_ROOT` moves it when the default temp directory is not one. A root that cannot hold exclusive claims fails the dispatch loudly instead of quietly oversubscribing the run.

Scope of the seal: the activation token, persona, and depth travel in the child process environment. That stops an ordinary Grok Build session from entering a run and keeps a cooperating cast inside the canonical topology, and it is not a sandbox against a worker that goes out of contract: a role holding `Bash` can read its own environment and re-run the dispatcher with different values. Treat the allowlist as run correctness, and rely on Grok Build permission modes and the persona tool allowlists for containment.

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
