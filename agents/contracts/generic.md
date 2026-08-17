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
