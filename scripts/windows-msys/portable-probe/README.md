# Portable native diagnostic harness

This diagnostic runs the existing Bash smoke assertion and native POSIX experiment
against a freshly captured imported MSYS candidate, under a separately verified
adapted native Node process. It never fabricates an SDK checkout, compiler
manifest, producer smoke output, runtime acceptance, or installed worker selection.

The entry point separately binds `consumerHeadSha` to the clean current checkout
and workflow SHA. This permits an explicitly pinned historical candidate while
retaining its original producer authority and all current-source joins.

`harness.cjs` holds an opaque process-local capability in a private WeakMap. The
capture path requires actual Windows and the real precompiled physical helper;
there is no injected fake capture implementation and no Linux native pass mode.
It captures all 21 imported files together, including original manifest.json and
local import.json, then validates exact closed inventory, original authority,
canonical manifests, every byte/hash, PE closure and separate external manifest
and import-receipt digests. Mutable incoming buffers are copied into private owned
snapshots. Plain objects cannot authorize materialization or execution.

The controller must already be executing under the separately authenticated
adapted Node binary. The harness rehashes its actual process.execPath, checks PE
machine against the externally expected architecture, and uses the fixed helper's
native `IsWow64Process2` identity to require that architecture equals actual
Windows architecture. A native ARM64 Node/controller with x64 Bash/MSYS is an
explicit mixed tuple; x64 Node emulation on ARM64 is refused. Node provenance and
native-proof hashes come from the trusted Node artifact verifier, not Node's own
candidate metadata. Merely supplying plausible hash strings is not verification.

The existing command implementation is unchanged. Running its whole diagnostic
child under the verified adapted Node makes its existing process.execPath copy
select that exact Node. Only the test child's explicit AUTOPROMPT_WINDOWS_BASH is
changed. The materialized private `runtime/usr/bin` closure must match exactly
captured Bash and MSYS bytes, and resolver results must match that explicit path.
There is no ambient fallback. The existing fstab layout and protection remain.

`runSmoke` invokes the exact repository native Bash test, which probes the real
sandbox and checks shell IPC, private /tmp, scratch writes, read-only fstab,
candidate write denial and controller secret read denial. It requires the exact
named test once, without SKIP/TODO, plus a successful child and unchanged closure.
Only actual success issues a separate opaque smoke capability bound to the same
captured candidate. `portable-bash-smoke.json` is a new consumer receipt, never a
replacement for built-runtime-proof.txt. The receipt is not an importable smoke
capability and cannot authorize another process or another tuple.

`posix.cjs` preserves the current native experiment's actual execution body,
launcher/job evidence, cleanup refusal, six modes, blocked-FIFO cancellation and
all three null negative controls. Only its SDK/smoke input binder is replaced with the
captured candidate and exact smoke capability. It checks captured fixture source
and executable bytes, then runs pipe/fork, FIFO, locks, blocked-FIFO, null, and
AF_LOCAL. AF_LOCAL failure remains failure; mqueue stays explicitly not tested.

`derive-posix.py` is a development-only deterministic factoring aid, not a runtime
source evaluator. It writes ordinary JavaScript and a lineage digest; no eval or
Module._compile is used. Tests compare the preserved execution region to the
current original source with the documented binder substitutions. Future cleanup can factor this body into a shared function; the source-preservation test currently refuses drift between these two diagnostic adapters. Neither local source comparison nor parser tests count as native
execution.

## Invocation

The trusted downloader verifies current-run MSYS artifact metadata/archive and
safe ZIP extraction, then the existing portable CLI imports it on Windows. Keep
its receiptSha256 as controller-owned state. The Node artifact verifier separately
checks the adapted binary/provenance/native proof and launches this script using
that binary, with NODE_OPTIONS/NODE_PATH removed and a trusted working directory.

```text
VERIFIED_ADAPTED_NODE.exe scripts/windows-msys/portable-probe/run.cjs REPO IMPORTED_ROOT AUTHORITY_JSON NEW_OUTPUT
```

AUTHORITY_JSON is canonical JSON produced by the trusted controller, outside the
candidate packet, with exactly:

```js
{
  candidate: {
    authority: /* authenticated producer result.expected */,
    manifestSha256: /* authenticated manifest digest */,
    receiptSha256: /* fresh local importer result.receiptSha256 */
  },
  node: {
    architecture: 'arm64', // or x64
    executableSha256: /* independently verified adapted Node */,
    provenanceSha256: /* verified provenance file */,
    nativeProofSha256: /* verified producer Node native TAP */
  },
  helper: {
    executable: /* absolute trusted precompiled helper */,
    executableSha256: /* independently bound helper executable */,
    configSha256: /* bound adjacent helper config */,
    systemRoot: 'C:\\Windows'
  },
  captureAdapterSha256: /* trusted checkout precompiled-proof/adapter.cjs hash */
}
```

The CLI checks checkout HEAD against producer head and refuses changed tracked
agents/scripts/selected-test inputs. Source/recipe/patch authority is also compared
to the current checkout. The probe is trusted controller code from the current reviewed checkout. It is not code loaded from the artifact.

Everything writes to a fresh private output. Errors preserve evidence and never
produce result.json success. Native outputs still report accepted:false even if
all experiments pass. A failed/hung unknown-drain worker retains the existing
resource journal/deployment, following the original native experiment.

## Remaining diagnostic seams

- **Descriptor:** existing descriptor-proof/run.cjs already accepts explicit
  Bash/DLL paths without an SDK. Materialize from captured capability and pass
  those exact paths/hash. Its prepared C++ helper/header/fixture inputs must be
  independently source-bound by the existing binding.json (or prepared from the
  separately fetched pinned source); do not invent an SDK. Bind fresh local
  toolchain.json to its externally expected SHA before/after the run. Existing
  controller tests16 same-profile opens,16 other-profile denials and3 job drains.
- **Entropy:** factor its lines that load sdk/issue27-build/built-runtime-manifest
  into an input adapter consuming `inputsAfterSmoke`. Keep all8 launches, exact
  entropy parsers, native helper/compiler source hashes, per-launch drain evidence
  and finally/recovery logic. Replace its payload-relative output paths with an
  explicit fresh output. It is observational; a completed diagnostic is never
  runtime admission.
- **Process/thread:** factor only the initial compiled closure binder into the
  same captured input adapter. Retain native fixture compilation, controller,
  12 same-profile rights,12 other-profile ERROR_ACCESS_DENIED results and all3
  positive drains. Its new receipt should record candidateManifestSha256 and
  tuple hashes rather than invent runtimeManifestSha256 from a nonexistent SDK
  smoke file. Local fixture toolchain/source pins remain mandatory.

These three extensions are identified and remain outside this diagnostic scope. The
practical executable path currently covers smoke plus all six POSIX modes.

## Local evidence

Node20 and24 each pass20 parser/capability-refusal/source-preservation and bounded-progress tests with
zero skips. Synthetic PE data is never executed or used to issue a native
capability. Tests explicitly prove non-Windows cannot issue a native capability.
Native Windows execution of this harness has not yet occurred. Precompiled helper
native acceptance remains its separate current CI gate, and no production code
has been changed by this work.


## Fresh progress and bounded evidence

Each CLI invocation requires a new private output directory and exclusively
creates `progress.jsonl`. Progress records follow capture → Bash smoke → POSIX,
with a monotonic sequence and one immutable tuple digest after capture. They
cannot change tuple, skip stages or continue after a terminal observation. No
progress record grants a capability or says the runtime is accepted.

Progress is bounded to 16 KiB per record and 256 KiB total. Refusal messages are
bounded and preserve unknown cleanup state and a retained helper path. Bash
stdout and stderr are each retained up to 8 MiB, with explicit truncation metadata;
truncation fails the probe. POSIX JSONL uses 256 KiB per record, 2 MiB total and 64
records; exceeding a limit preserves earlier evidence and fails. The existing
owned-job cancellation/recovery logic is unchanged.

Run local parser/refusal tests on Linux:

```sh
node --test scripts/windows-msys/portable-probe/*.test.cjs
```

Synthetic transport setup is a parser fixture and intentionally cannot substitute
for the mandatory Windows held-file lease. The exact native CLI must run on both
actual Windows architectures before a compatibility claim.
