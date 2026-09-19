# Separate fork initialization trace

This is a diagnostic variant, never an accepted runtime. CI24's exact dff1f67d
patch and 05929607 DLL compiled and passed descriptor/entropy tests, but four
fork children still failed initialization with 0xC0000142. The trace introduces
no speculative behavior fix. A successful traced child would not prove that
the uninstrumented candidate is correct.

`generate.py SOURCE BASE_PATCH NEW_OUTPUT` takes the normal compiler source tree
after the reviewed base patch has been applied. It binds eight exact adapted
source files and that base patch, then generates an independent trace patch/manifest.
The recipe additionally verifies the full source archive hash. The only
original-source changes are inserted includes and finite stage calls. The
constructor loop gains a compound body solely to bracket its original call;
its condition, call count and reverse order are unchanged. The source generator never writes its
inputs. `source-pins.json` refers to source commit
270ba2980700e6e2a0813944d506eecea0f86402 plus the exact base patch. In particular,
`autoload.cc` includes the base patch's added thunks; its pristine hash is refused.

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
60–65 cygheap restore; 80–84 shared/user memory creation; 90 follows
`device::init`, immediately before DLL constructors. Stages91–96 bracket
`getentropy` entry, its original RtlGenRandom call, successful/failed return and
exception path. Stages100–103 bracket `dll_load` entry, first LoadLibrary call,
passing the optional fallback block and successful handle assignment. Stage102
does not establish that fallback ran: the first load may already have succeeded.
Before the original `wincapc::init` early return, stage110 means `caps` is null,
111 means it equals one of this module's ten known capability tables, and112
means a non-null foreign pointer. This classification compares addresses without
dereferencing the pointer or changing it. Stages113/114 bracket the original
`thr_alloc` constructor body; 113 follows its `current` member initializer.
These statements still
execute unchanged; marker calls preserve thread error/status. Constructor index `i` has
pre/post stages `0x100+i`/`0x200+i`, only for the forced DLL table and indices
1 through64. The existing loop still calls every constructor even beyond that
diagnostic bound. The runner independently rejects tables exceeding64.
Every fixed marker follows
its named source anchor, except 23 before handle_fork, 92 before RtlGenRandom,
and the110–112 classification before the existing caps check. Generated patch is the
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

`constructor-map.cjs` reads the exact captured trace DLL's bounded COFF symbol
and constructor tables. It writes `constructor-map.json` with the DLL digest,
reverse execution order, symbol, relative address and pre/post marker for each
index. The diagnostic manifest binds the map's bytes and source module; the
runner rejects observed constructor indices absent from that exact DLL. No
address comes from the child trace, and no map grants runtime acceptance.

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
source-stripping check verifies original bytes across all eight instrumented
files. CI32 produced no trace artifact: the added `autoload.cc` pin described
pristine source although the compiler tree already contained the base patch.
Reproducing that exact sequence fails before the output directory is created.
The corrected pin and full base-patch composition regression address this
setup error. CI34 compiled and executed that corrected trace. All four failing
fork children completed constructors18 through2, including successful RNG, and
stopped inside constructor1 `_GLOBAL__sub_I_pthread_wrapper`, which initializes
`thr_alloc` using `wincap.caps`. The original candidate was unchanged and the
owned drain was confirmed. The new110–114 pointer/body markers still require
actual Windows compilation and execution; they do not assert a faulty pointer.

CI28 run35457714006 compiled and executed the original trace, confirmed the
owned drain and preserved original candidate/SDK hashes. All four failed fork
children reached stage18 with LOCALAPPDATA present, then failed before19.
The source's `device::init` is empty, so this narrows the interval to global
constructor traversal. Both actual normal and trace DLL tables start with
`__stack_chk_init`, which invokes `arc4random_buf`; this is a lead, not proof of
the failing constructor. The new per-constructor markers still need native
execution. Trace silence remains ambiguous: it can reflect unsupported pipe
query/access rather than failure before stage1. Keep all original errors.

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
python scripts/windows-msys/fork-init-trace/test.py --source PINNED_PRISTINE_SOURCE --pwsh PWSH
node --test scripts/windows-msys/fork-init-trace/parser.test.cjs
```

The Python test copies the pristine source and applies the complete exact base
patch before generating and applying the trace patch. It also verifies direct
generation from pristine source is refused before output is created. It compiles
and runs 17 transport seams, verifies the closed NT call
set, source drift refusal, CRLF derivation, all60 closed fixed stage values,
adapted source preservation, compiled constructor call-order/count/exception
contracts, exact pointer classification for null/all ten local tables/foreign,
allocator choice and exception behavior, actual full derived C# compilation
and shell syntax.
The Node suite checks strict bounded stage/drain parsing and actual dependency
composition plus strict DLL-map/malformed-COFF cases. None of
these local checks claim native Windows execution.
