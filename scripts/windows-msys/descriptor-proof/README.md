# Source-bound native descriptor controller proposal

This proof builds a native C++ fixture linked to the exact prepared AppContainer descriptor helper; it does not select, install, or replace a production runtime. Native Windows/MSVC execution is pending.

Inputs:

- `binding.json` anchors the independently reviewed fixture/helper/patch/source/SDK digests shared by extraction and the controller.
- `PREPARED` contains the output of this directory’s `prepare.py`: the exact standalone helper, header, fixture and `source-binding.json`.
- `BASH` and `BUILT_DLL` identify the copied-runtime namespace identity. `EXPECTED_DLL_SHA256` must come from the separately admitted build result, not be recomputed inside this invocation as a substitute for provenance.
- `NEW_OUTPUT` must not exist. Its parent and all input paths must be physical and canonical.
- `TOOLCHAIN_JSON` has exactly `cl`, `link`, `include`, `lib`, `sdkVersion`, `arch`. Executables and include/library directories are explicit physical absolute paths. `arch` must be `x64` or `arm64` and match the running Node process; `sdkVersion` is `10.0.<number>.0`. For ARM64 use the actual ARM64-target compiler/linker/library paths. No cross-architecture native-proof claim is made.

First run `python prepare.py REPO NEW_PREPARED_DIRECTORY`. Then run `pwsh -File discover-toolchain.ps1 -WorkRoot C:\owned-parent\descriptor-toolchain` with a fresh ASCII path containing no spaces or command metacharacters. The script selects installed VS2022 17.14+ or VS2026 18.x x64 MSVC and writes `toolchain.json` plus discovery logs in that owned directory. It changes only child process environment and the newly created directory. The selected installation version is retained in the discovery log; the concrete compiler/linker paths and hashes remain bound by the controller. VS2026 support is needed because [GitHub migrated windows-latest in June2026](https://github.com/actions/runner-images/issues/14017). No older or future unknown major version is admitted.

Invocation on Windows:

    node run.cjs REPO PREPARED BASH BUILT_DLL NEW_OUTPUT TOOLCHAIN_JSON EXPECTED_DLL_SHA256

`run.cjs` compiles each bound C++ source with `/MT /EHsc /std:c++17 /W4`, records compiler version/include output, links with explicit linker and system libraries, verifies PE architecture and system-only imports, then runs the strict ordinary-host control. Compiler/linker bytes, prepared input bytes, source pins and patch digest are bound and checked. No ambient `CL`, `_CL_`, `LINK` or `_LINK_` switches are forwarded.

`controller.cs` creates two fresh AppContainer profiles, grants the native fixture executable read/execute access to both, and creates one writable low-integrity communications directory available only to profile A. It uses production `CreateMsysNamespaceLease` with the held Bash/DLL identity and gives the native creator only the resulting opaque namespace path. No global namespace/root ACL changes occur.

The actual production launcher starts the creator in profile A and keeps it running while separately launching the profile-A and profile-B openers. Every job must positively drain. Creator output must prove all 16 existing effective descriptors and actual peer effects plus one `winpid.*` NT symbolic-link descriptor. The link starts from the pinfo-shaped WORLD `SYMBOLIC_LINK_QUERY` descriptor; the actual helper must preserve WORLD `0x1` and append package `GENERIC_ALL`, while the effective object must contain WORLD `0x1`, package `SYMBOLIC_LINK_ALL_ACCESS` (`0xf0001`), and the exact low label. The same-profile process must open and operate on all 16 existing objects and open/query the link's exact numeric target. The other-profile process must receive exact access-denied statuses for all 16 objects and the link. The independently parsed stdout protocol requires every ordered object record plus the final effect witnesses. The namespace is held until all jobs drain. Exceptions cancel unfinished jobs and require positive aggregate drain before releasing namespace/profile resources. Unknown cleanup retains the owned profiles and fixture work tree and returns failure. It does not explicitly dispose the namespace lease before the controller exits; the OS closes process-owned namespace handles at process exit. This is not persistent namespace-handle retention and does not establish positive job drain.

The controller uses concurrent launcher calls for the creator and one peer. Security/resource state in those calls is local; production `Last*` diagnostic fields are shared and can interleave. This proposal does not use those shared diagnostics as proof or rely on their attribution. Any launch failure remains a failure.

Artifacts remain in `NEW_OUTPUT/artifacts`: source snapshots, compiler/linker logs, exact commands, binary, controller logs and `manifest.json`. Only the private working runtime is removed after all native assertions succeed. Failure retains it. `nativeExecution` stays `pending` until the complete native proof and strict parser succeed.

Local validation completed:

- JavaScript syntax check.
- Actual PowerShell `Add-Type` compilation of `controller.cs` with the complete current production native C# source (Linux syntax/assembly proof only).
- 16 parser cases, including missing drain, missing object, wrong-profile success, absent effective descriptor check, duplicate object, each PID-link mask/target/access mismatch, noncanonical base64 and absent final effects. The additional low-label contract compiles the actual controller/native C# sources. Run them with `node --test scripts/windows-msys/descriptor-proof/parser.test.cjs`.

No MSVC compilation, Windows token creation, native descriptor behavior or job cleanup has been exercised by these local checks. Those are mandatory actual-Windows acceptance gates.
