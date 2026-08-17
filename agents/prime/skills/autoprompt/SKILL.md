---
name: autoprompt
description: Run the Autoprompt orchestration loop on Prime Agent through a topology-enforcing native RLM dispatcher. Use only when the user explicitly invokes Autoprompt or asks to run the loop.
---

# Autoprompt for Prime Agent

This package targets Prime Agent 0.7.2. Before recursive use, set `rlmMaxDepth` to `4` in Prime Agent settings and start a fresh session so this Python-backed skill and its extension are loaded.

Start only for an explicit `/autoprompt <mission>` request. A bare invocation reports the recorded frontier and stops; resume requires an explicit `resume` request.

Before spawning, resolve only undefined operator knobs:

- **Concurrency:** `tokensaver`, `wide`, or `custom max_subs=N`.
- **Agent selection:** `off`/inherit only. Confirm that every child inherits the already-selected parent model; no per-child model routing selector is available.

In an attended session, ask all undefined knobs in one question before repository/tool work. In an unattended supervisor run, default missing concurrency to `tokensaver` and agent selection to `off`, then record both assumptions.

After the chooser, use the native dispatcher to start `ap-scope-coordinator`.

## Native dispatcher

Import the installed Python skill in the IPython kernel and route every child through it:

```python
import autoprompt
binding = autoprompt.bind("PROMPTS.txt", nonce="<RUN-NONCE>")
child = await autoprompt.dispatch(
    "ap-scope-coordinator",
    "Produce the bounded scope and roadmap for the mission.",
    binding=binding,
    framework="plan-scope",
)
```

`dispatch()` reads `agent_message.list_agents` through Prime Agent's host bridge, validates the daemon-derived current identity and parent edge, applies the exact canonical child allowlist, rejects terminal roles, and calls Prime Agent's real `rlm()` with `name` only. It never passes `model`, so the child inherits the selected parent model.

`bind()` reads the exact prompt ledger, requires a valid run nonce, and records its resolved path, SHA-256, and UTF-8 byte length. Every dispatch revalidates those bytes and seals the exact `AUTOPROMPT-RUN-MARKER`, `RUN-NONCE`, mission pointer, and binding recreation call into the child brief. Descendants must recreate the same binding with `autoprompt.bind(...)` before dispatching.

Use the optional `instance` argument (lowercase letters, digits, and hyphens) when multiple siblings need the same persona. The sealed session name is `<persona>--<instance>`.

At depth 0, routine dispatch is limited to `ap-scope-coordinator`, `ap-feature-coordinator`, and `ap-sweep-coordinator`. `ap-preflight-probe` and `ap-intake` are diagnostic or legacy-resume exceptions, not routine launches. Every deeper call is checked against the current persona's canonical child list. Roles with an empty child list are code-level terminals.

Prime Agent returns an admission handle from native RLM dispatch. Use its native subagent registry and the bundled `agent_message` skill to observe work and exchange results; do not treat admission as completion.

## Framework prompt templates

Pass only one of these allowlisted IDs as `framework`. The dispatcher reads the installed immutable package path and seals the selected text into the child envelope:

- `apply`: [apply.md](../../prompts/frameworks/apply.md)
- `backend-build`: [backend-build.md](../../prompts/frameworks/backend-build.md)
- `backend-fix`: [backend-fix.md](../../prompts/frameworks/backend-fix.md)
- `backend-implement`: [backend-implement.md](../../prompts/frameworks/backend-implement.md)
- `composition`: [composition.md](../../prompts/frameworks/composition.md)
- `docs`: [docs.md](../../prompts/frameworks/docs.md)
- `frontend-build`: [frontend-build.md](../../prompts/frameworks/frontend-build.md)
- `frontend-fix`: [frontend-fix.md](../../prompts/frameworks/frontend-fix.md)
- `frontend-implement`: [frontend-implement.md](../../prompts/frameworks/frontend-implement.md)
- `frontend-review`: [frontend-review.md](../../prompts/frameworks/frontend-review.md)
- `generation`: [generation.md](../../prompts/frameworks/generation.md)
- `plan-design`: [plan-design.md](../../prompts/frameworks/plan-design.md)
- `plan-research`: [plan-research.md](../../prompts/frameworks/plan-research.md)
- `plan-scope`: [plan-scope.md](../../prompts/frameworks/plan-scope.md)
- `polish`: [polish.md](../../prompts/frameworks/polish.md)
- `QUICKSTART`: [QUICKSTART.md](../../prompts/frameworks/QUICKSTART.md)
- `README`: [README.md](../../prompts/frameworks/README.md)
- `refactor`: [refactor.md](../../prompts/frameworks/refactor.md)

Preserve the framework gates, strict behavioral RED before implementation, independent review, real verification, >=95% changed-line coverage, negative-verdict repair loops, goal checking, and zero open findings before DONE.

## Canonical Autoprompt protocol

# Autoprompt: provider-neutral protocol

Autoprompt is an explicit-only, useful-first orchestration loop. It stores the exact mission once, produces one executable roadmap, builds dependency-safe lanes, and independently verifies completion.

## Invocation and resume

Run Autoprompt only after an explicit invocation. Loading this protocol, finding prior files, or receiving an ordinary request never starts or resumes a run. A bare invocation reports the `GATELOG.md` frontier and stops. Resume requires an explicit `resume` instruction or a supervisor relaunch.

## Useful-first start

Resolve only undefined operator controls, then dispatch the first useful roadmap author. There is no mandatory preflight or intake round trip. Without a trusted launch attestation, that author proves RUN, READ, and WRITE against disposable scratch space before inspecting the repository. Capability failure stops before implementation.

## Adaptive roadmap

Create one canonical `ROADMAP.md`:

- **bounded:** one author, then independent reviewer and blind fresh verifier concurrently; three agents in two rounds;
- **multi-surface:** retain the author roadmap, add exactly two complementary scouts, then concurrent reviewer and fresh verifier; five agents in three rounds;
- **unusually-large:** exceed the ordinary budget only with a concrete recorded escalation reason.

Every item carries a stable id, objective, category/tag/tier/framework, owned boundary, dependencies, launch group, implementation steps, positive acceptance criteria, unhappy paths, tests first, real verification, and the required coverage contract. Implementation-ready items dispatch directly to build. Add detailed planning only for debug depth-lock, a named unresolved design fork, an explicit roadmap requirement, or a reported plan conflict.

## Three-file governance

New runs use exactly:

1. `PROMPTS.txt`: append-only exact prompt blocks;
2. `ROADMAP.md`: canonical executable roadmap;
3. `GATELOG.md`: append-only transitions, provenance, verdicts, hashes, elapsed time, and resume frontier.

Legacy ledgers are read-only compatibility inputs. Contradictory mixed formats fail closed.

## Compact briefs

The first roadmap author stores the exact mission. Every later worker receives a **MISSION POINTER** containing path, SHA-256 hash, UTF-8 byte length, and run nonce. The worker verifies those bindings before acting. Send only role, objective, owned boundary, dependencies, acceptance criteria, roadmap/evidence pointers, output contract, and truthful model/effort status. Do not paste transcripts, doctrine, the full roadmap, or prior adversarial reasoning.

## Hierarchy and independence

The conductor coordinates and reports. Coordinators own fleet state. Managers are optional context holders for multi-lane slices. Executors perform work. Leaves perform bounded terminal duties. Dispatch ready disjoint work spawn-all-then-collect; sequence only real dependencies. No agent reviews or verifies work it authored. A worker that cannot safely fit its owned boundary returns a split request rather than silently recursing.

## Verification and completion

Use real systems and real test commands. Tests assert specific behavior and failure modes. Never mock the system under test. A returned verdict never overrides evidence: missing green evidence, regressions, open blockers, open P0/P1 findings, unmet roadmap items, or unusable delivery block completion. Completion requires exact mission and roadmap closure, independent verification, and a nonce-bound DONE sentinel.

## Failure and user boundaries

Retry only classified transient failures within bounded attempt and wall-clock budgets. Technical choices go to an arbiter. Ask the user only for irreversible or destructive action, real money or quota, unavailable credentials, or product direction they must own. Never arbitrate away capability failure, coverage, real verification, or blockers.

## Runtime portability

A host with custom agents registers the neutral personas and capability overlays generated from `agents/contracts/autoprompt.contract.json`. A host without recursive agents executes the same dependency and independence contract as fresh isolated contexts in dependency order. Transport may degrade; behavior and completion criteria do not.
