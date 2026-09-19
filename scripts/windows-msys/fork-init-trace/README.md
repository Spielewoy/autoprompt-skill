# Separate fork initialization trace

This is a diagnostic variant, never an accepted runtime. CI24's exact dff1f67d
patch and 05929607 DLL compiled and passed descriptor/entropy tests, but four
fork children still failed initialization with 0xC0000142. The trace introduces
no speculative behavior fix. A successful traced child would not prove that
the uninstrumented candidate is correct.

`generate.py SOURCE BASE_PATCH NEW_OUTPUT` binds four exact source files and
the reviewed base patch, then generates an independent trace patch/manifest.
The recipe additionally verifies the full source archive hash. The only
original-source changes are inserted includes and finite stage calls. Existing
statements/control scopes are unchanged. The source generator never writes its
inputs. `source-pins.json` refers to source commit 270ba2980700e6e2a0813944d506eecea0f86402.

`trace.h` scans the native Windows environment (bounded 32768 WCHARs) for an
explicit 16-digit hexadecimal handle locator. Only the separate diagnostic launcher creates
this variable. It queries the handle's write access, synchronous mode and pipe
type with direct Nt calls, then emits a fixed 19-byte ASCII record:
`AT:00000123:000a:1\n` means PID 0x123, stage 10, nonempty LOCALAPPDATA present.
No paths, environment values, addresses or arbitrary strings are disclosed.
It preserves TEB LastErrorValue and LastStatusValue. There is no heap, CRT,
Win32 autoload, global mutable counter, or standard-handle substitution.
Native queries must return exact STATUS_SUCCESS; failure yields no trace.
No records cannot establish that the DLL entry point was never reached.

`derive-native.py ORIGINAL_NATIVE EXPECTED_SHA NEW_OUTPUT` changes a captured,
externally pinned native launcher only inside this diagnostic output. It adds
one inheritable duplicate of the launcher's synchronous stderr write pipe to
the explicit handle list and a diagnostic locator entry. Both normal launch
and fork keep their original standard handles and creation flags. The alias
is closed on the parent success path and in all finally paths. Existing token,
image, namespace, job membership, limits, cancellation and drain code remains.
The controller continuously drains ordinary stderr, including these records.

Stages: 1–5 DLL_PROCESS_ATTACH; 10–28 dll_crt0_0; 40–48 fork child memory restore;
60–65 cygheap restore; 80–84 shared/user memory creation. Every marker follows
its named source anchor, except 23 before handle_fork. Generated patch is the
source of truth for precise placement. Stage 14 measures native environment
following initial_env; the fork CreateProcessW passes NULL lpEnvironment, so
initial child DLL attach inherits the parent's Windows environment before
MSYS rebuilds POSIX state.

## Native workflow integration

The existing `windows-latest` / Node 24 producer runs
`Trace failed MSYS fork initialization in a separate diagnostic build` only
when the normal compiler proof succeeds and the normal process/thread proof
fails. Normal candidate export, descriptor, smoke, entropy, fork and applicable
POSIX steps run first. The failed normal proof still fails the required final
gate; collecting a trace cannot turn it into a pass. No CI job is added.

The workflow selects scalar executable paths using Python `sys.executable` and
Node `process.execPath`, then runs the parser tests and generator against the
normal pinned source tree. The generator creates fresh
`msys-compiler-proof/sdk/issue27-fork-trace`; the workflow applies its private
ACL and copies the diagnostic recipe there. It passes the freshly computed
trace patch SHA and locked source epoch directly to the existing SDK Bash.

`build-trace.sh` extracts a separate source tree, applies the exact base patch
and diagnostic patch, and builds into separate source/build/stage directories.
Its configure flags match the normal proof, including `--with-cross-bootstrap`,
`--disable-doc` and `--disable-dumper`. It installs no packages, downloads no
inputs and never replaces the SDK DLL or original candidate. Original stage,
bootstrap and compiler bytes are checked before and after compilation.

The workflow then hashes the traced DLL, generated manifest, original normal
proof manifest and actual Python executable into the exact context below. The
runner materializes a fresh private closure using the verified original Bash,
dependencies and already compiled process/thread fixture; only the DLL changes.
The derived controller preserves the original assertions and adds one final
drain observation. Its ordinary stderr checks deliberately reject trace bytes
even if fork starts. The runner retains bounded raw output before parsing and
always reports `accepted: false`.

The step has a 30-minute timeout. The one producer's overall cap is 120 minutes;
other matrix jobs keep their 90-minute cap. An always-run upload preserves
`windows-msys-fork-initialization-trace` separately, including runner evidence,
generated inputs, configure/build/install logs and the trace stage. Normal
candidate artifacts are uploaded before tracing. Every diagnostic root is
retained; unknown drain never authorizes deletion. This output has no candidate
export, consumer, import or production admission path.

## Local checks and remaining native work

`g++ -std=c++17 -Wall -Wextra -Werror test.cc -o /tmp/trace-test && /tmp/trace-test`
executes 17 simulated NT transport contracts. These are not Windows semantics.
The complete derived C# launcher compiles using local PowerShell/Roslyn. A
source-stripping check verifies original bytes across all four instrumented
files. Independent native_ci_audit review found no current source blocker.

Actual Cygwin compilation/linking, loader-time native queries, pipe inheritance
and AppContainer execution remain unproved until a Windows trace run. In
particular, trace silence may mean unsupported pipe query/access rather than
failure before stage 1. Keep bounded normal stderr with all original errors.

## Runner and current verification commands

The diagnostic entry point is:

```
node scripts/windows-msys/fork-init-trace/run.cjs REPO CONTEXT_JSON CONTEXT_SHA NEW_OUTPUT SYSTEM_ROOT
```

The trusted workflow writes the following exact context schema and supplies its
fresh SHA separately. All paths are absolute; all digests are lowercase SHA256:

```json
{
  "schema": 1,
  "workRoot": "normal compiler WorkRoot",
  "traceDll": "separate trace stage/usr/bin/msys-2.0.dll",
  "traceDllSha256": "fresh trace build DLL SHA",
  "traceManifest": "generated trace-manifest.json",
  "traceManifestSha256": "generated manifest SHA",
  "normalManifest": "normal msys-process-security-proof/native-manifest.json",
  "normalManifestSha256": "normal proof manifest SHA",
  "python": "actual Python sys.executable",
  "pythonSha256": "actual Python executable SHA"
}
```

The original normal proof may fail, but must have captured its compiled fixture,
normal candidate closure and exact controller/native source identities first.
The runner consumes those bytes and hashes rather than inventing a proof. It
copies the original closure into a fresh private directory, substitutes only
the explicitly supplied trace DLL, and rebinds the closed imports. The normal
fixture and unchanged controller assertions remain. The derived controller adds
one `TRACE-DRAIN:confirmed|unknown` observation after its original final drain;
this is diagnostic cleanup evidence, not runtime acceptance. Raw bounded output
is written before parsing. Every diagnostic root is retained, including on a
confirmed drain. Normal SDK/compiler/candidate/closure source hashes are checked
again after execution, and the manifest always carries `accepted: false`.

Local checks:

```
python scripts/windows-msys/fork-init-trace/test.py --source PINNED_EXTRACTED_SOURCE --pwsh PWSH
node --test scripts/windows-msys/fork-init-trace/parser.test.cjs
```

The Python test compiles and runs 17 transport seams, verifies the closed NT call
set, source drift refusal, CRLF derivation, all 44 unique stage insertions,
original source preservation, actual full derived C# compilation and shell syntax.
The Node suite checks strict bounded stage/drain parsing and actual dependency
composition. Node 20 and Node 24 each pass all three cases without skips. None of
these local checks claim native Windows execution.
