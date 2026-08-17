# Modes contract

`SKILL.md` defines the loop. This file is the authoritative contract for runtime
choices: concurrency, attendance, model routing, effort, steering, and resume.
These axes change dispatch, not mission scope or the DONE bar.

## 1. Chooser

Invocation controls are not mission text:

- `mode=tokensaver|wide|custom`; `billionaire` remains an alias for `wide`;
- `max_subs=N` for `custom`;
- `agents=off|auto|<comma-list>|auto:<comma-list>`;
- `unattended`.

In an attended session, resolve every undefined control in one
`AskUserQuestion` call before repository or other tool work. Ask concurrency as
“how many subagents run at once,” never as a quality or speed grade. Before
presenting agent selection, report the provider and effort capability as exactly
`selectable`, `inherited-only`, `unsupported`, or `unknown`; when selectable,
report the verified maximum.

In an unattended supervisor run, do not ask. Default undefined controls to
`tokensaver` and `agents=off`, then record the assumptions in `GATELOG.md`. A
permission-bypass flag is not unattendedness.

An explicit operator control deterministically overrides unattended defaults;
resolve any knob conflict in the operator's favor and record it in `GATELOG.md`,
never defer it into a silent default.

Strip only recognized control tokens before storing the exact mission. A canned
chooser selection is control state, not a prompt. Preserve any self-written
instruction attached to a chooser response byte-for-byte in the next
`PROMPTS.txt` block.

## 2. Concurrency

Concurrency is a live-agent throttle. It never changes required gates,
verification, model routing, or roadmap content.

| Mode | Live dispatch contract |
|---|---|
| `tokensaver` | Default. Run up to six subagents at once. |
| `wide` / `billionaire` | Dispatch all ready, disjoint work concurrently, bounded by the runtime’s global ceiling. |
| `custom max_subs=N` | Use wide dispatch with `N` as the hard live ceiling. |

`max_subs` is a ceiling, not a target. Invalid or missing `N` does not authorize
an arbitrary custom ceiling. Dispatch ready disjoint work spawn-all-then-collect:
issue every spawn of a ready group before collecting any report - parallel
background dispatch is the default shape, and serialization is allowed only for
declared real dependencies. When three or more lanes are ready and achievable
width is at least three, at least three workers must run concurrently; lower
explicit ceilings remain truthful and valid. Never duplicate a live owner. A
single bounded lane skips L2 and dispatches its L3 executor directly.

Every dispatch is collect-then-stop: stop that agent explicitly once its final
report is collected; a parked resumable agent is still a live agent and counts
against the ceiling. DONE requires zero live subagents.

Scope-topology counts below are separate from the execution-mode live ceiling.
They count the roadmap authoring and assurance topology, not all agents that may
be needed to build and verify the approved roadmap.

## 3. Useful-first capability path

There is no separate intake round trip and no mandatory preflight agent.

A supervisor may supply a versioned capability attestation bound to the live
provider/runtime, CLI version, permission profile, agent selector,
agent-definition hash, casting hash, effort status/source, and exact
RUN/READ/WRITE success. Trust it only when every binding matches. Missing,
malformed, stale, unknown, or contradictory values are safe misses.

Without a trusted attestation, the first useful roadmap author proves RUN, READ,
and WRITE against a disposable scratch path before repository inspection, then
continues directly into roadmap work. Any capability failure hard-stops before
implementation. `ap-preflight-probe` is diagnostic/recovery-only.

## 4. Adaptive scope topology

Every new run produces one canonical executable `ROADMAP.md`.

### Bounded

- one useful-first roadmap author;
- independent roadmap reviewer and blind fresh verifier concurrently;
- **3 agents, 2 rounds**;
- target: **under one minute**.

### Multi-surface

**Multi-surface scope uses exactly 5 agents, 3 rounds:**

- retain the first author’s complete roadmap and repository evidence;
- add exactly two complementary scouts concurrently;
- run the independent reviewer and blind fresh verifier concurrently;
- do not pay a redundant ordinary synthesis dispatch;
- target: **under five minutes**.

### Unusually large

Unusually-large scope may exceed the 6-agent ordinary budget only when
`ROADMAP.md` records a concrete escalation reason. Additional scouts must own disjoint themes. External research
runs only when current external facts are required.

The timing targets are wall-clock goals, never permission to weaken assurance.
Record elapsed time truthfully. On review failure, retain accepted evidence and
repair only named roadmap items; do not rerun the whole scope wave by default.
Empty roadmaps, invalid dependency DAGs, overlapping ownership, missing
framework/test decisions, and capability failures remain fail-closed.

## 5. Roadmap and governance

`ROADMAP.md` is the sole scope, decomposition, and executable-plan source for a
new run. Each implementation-ready item carries its stable id, objective,
category/tag, tier, framework leaf, owned boundary, dependencies, launch group,
integration lane, implementation steps, positive and unhappy-path acceptance,
tests first, and real verification commands. It also records the mission
pointer/hash, RUN-NONCE, scope profile, any escalation reason, and the >=95%
changed-line and touched-module coverage requirement.

Dispatch approved implementation-ready items directly. Add a separate detailed
planning gate only for debug/depth-lock work, an unresolved design fork, an
explicit `requiresDetailedPlan`, or a worker-reported plan conflict.

New-run governance is exactly three files:

1. `PROMPTS.txt` - exact append-only `=== PROMPT N ===` blocks;
2. `ROADMAP.md` - the canonical executable roadmap;
3. `GATELOG.md` - append-only transitions, provenance, verdicts, artifact hashes,
   elapsed time, assumptions, steering, and resume frontier.

Do not create new-run governance-only `BRIEF.md`, `PLAN.md`, `AGENTS.md`,
`COVERAGE.md`, `BACKLOG.md`, `ANCHOR.md`, `bucketlist.md`, `intake.md`,
`scope-map.md`, or per-angle scope files. Substantive implementation, test,
review, sign-off, sweep, and verification evidence may exist while needed.

## 6. Compact briefs

The first roadmap author receives the exact mission and writes `PROMPTS.txt`.
Later briefs use a verified pointer envelope:

```text
MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.
path=<PROMPTS.txt> hash=sha256:<64 hex> bytes=<UTF-8 byte length> nonce=<RUN-NONCE>
```

Every recipient verifies path, hash, byte length, and nonce before acting. Send
only role, objective, owned boundary, dependencies, acceptance criteria, roadmap
section pointer/hash, optional raw-evidence pointer, output schema/artifact path,
and resolved model/effort status. Do not paste the full mission, transcript,
roadmap, doctrine, or previous adversarial reasoning. Preserve blind review and
keep upward reports compact.

## 7. Agent selection and effort

Agent selection changes only model and effort routing. It does not change the
personas, hierarchy, concurrency, roadmap, or gates.

- `agents=off` is the default: perform no discovery or per-call override; inherit
  the session model and effort.
- `agents=auto` ranks the configured registry by `effortHint`, preserving registry
  order for ties.
- `agents=<comma-list>` uses exactly the operator’s strongest-to-weakest order.
- `agents=auto:<comma-list>` restricts automatic ranking to that exact pool.

For Claude Code, enabled casting is a pre-launch supervisor responsibility.
Claude exposes only `opus`, `sonnet`, and `haiku` aliases: one selected model
fills all three; two map the stronger model to `opus`/`sonnet` and the weaker to
`haiku`; three map strongest/middle/weakest; more than three fails explicitly.
An already-running process may use casting only when trusted metadata and live
alias bindings match. Codex uses its actual per-agent model and reasoning-effort
configuration; do not copy Claude alias claims into Codex routing.

Effort reporting must be truthful:

- `selectable` - use the verified provider maximum for coordinators, roadmap,
  scouts/synthesis, planning, independent review/fresh verification, runtime
  verification, jurors/goal check, arbitration, and depth-lock;
- ordinary implementation defaults high; design- or root-cause-heavy
  implementation may use the verified maximum;
- mechanical recording and cleanup may use a lower selectable effort;
- `inherited-only`, `unsupported`, or `unknown` - omit the per-call effort field
  and record the actual fallback instead of claiming control.

## 8. Attendance, steering, and arbitration

Unattendedness may come from the invocation, workflow argument, or supervisor
launch signal. It controls questions, not permissions or assurance. Unattended
runs never prompt: the arbiter resolves technical forks and records assumptions,
but cannot waive capability failure, open P0/P1 blockers, coverage, real
verification, credentials, or authorization boundaries.

Append later user steering bytes exactly to the next `PROMPTS.txt` block. Queue
additive steering for the next safe boundary. For urgent steering, checkpoint the
affected frontier before cancelling or restarting its lane. Keep unaffected
lanes running, fold completed results as they arrive, and continue dispatching
ready work; never abandon accepted evidence or end the run merely because a
steer arrived.

In an attended run, ask mid-run only for a genuinely user-owned product decision,
credential, irreversible/destructive action, or real money/quota decision.
Technical ambiguity belongs to the arbiter.

## 9. Resume and authorization

Resume is explicit: only an explicit `resume` instruction or a supervisor
relaunch resumes a run. The resuming context reads only the `GATELOG.md` tail -
the last frontier row - verifies its mission pointer hash, and dispatches the
open frontier with compact pointer briefs. Workers, not the resuming context,
read `ROADMAP.md` sections and valid substantive evidence. Treat empty,
unparsable, or half-written `.tmp` artifacts as absent. Reuse accepted evidence
and rerun only incomplete or rejected work.

Legacy formats are resume-only. They may be read for compatibility but are never
created or made mandatory for a new run. Do not rewrite historical ledgers merely
to modernize them; contradictory mixed-format claims fail closed.

Do not commit, push, publish, deploy, spend money, delete user data, force-push,
reset hard, clean the working tree, or take any other external action without
explicit user authorization for that action. Unattended mode, verification,
ledger recording, and a successful DONE verdict do not imply authorization.
