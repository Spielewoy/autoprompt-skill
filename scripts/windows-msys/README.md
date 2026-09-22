# MSYS AppContainer compiler investigation

This directory builds an isolated compiler proof from the exact source and SDK
commits in `build-lock.json`. It does not replace an installed Git/MSYS runtime
or select the resulting DLL for production commands. The adaptation connects
actual-token pipe descriptors and LOCAL names to signal pipes, ordinary native
pipes, FIFOs and PTY control pipes. Named events, mutexes, semaphores, mappings,
flock directories, socket state and queues receive the exact package grant.
Host calls retain their original descriptors and names.

The PID-link descriptor uses the same exact-package adapter. A paired native
trace found that creating `winpid.<Windows PID>` succeeded with the stock WORLD
query descriptor, but the parent could not reopen it inside the AppContainer.
The failed lookup returned zero, which made the parent take Bash's child path.
The adapted descriptor restored the lookup and exact command-substitution
witnesses. The fork parent also rejects invalid mapped PIDs before creating its
process-table entry, returning EAGAIN instead of a false child result.

The DLL link explicitly enables DYNAMIC_BASE. `bash-relocation.cjs` derives the
private Bash image from its exact pinned SDK hash by changing only that flag
and the PE checksum. It verifies the expected output hash and records both
identities and changed offsets. The SDK image and candidate transport packet
remain original; compiler and ARM consumer proofs execute the derived private
copy and retain its transformation receipt. This is a binary-header adaptation,
not a Bash rebuild. Untraced functional and cross-profile tests must pass before
these bytes can become a production worker.

Native Windows observations establish that both LOCAL names and exact package
permissions are needed. Native pipe names use the observed opaque AppContainer
prefix under the bare NPFS root; apparent intermediate paths are not directories.
The adapter discovers that prefix through a fresh, connected, privately owned
pipe pair and validates both kernel-reported endpoint names. No environment
variable supplies an object namespace or package identity.

On a native Windows x64 runner with Git and PowerShell, choose a fresh local
directory without spaces and run `build.ps1 -WorkRoot <directory> -Mode proof`.
To include `pipe-security.patch`, also pass `-AdaptationPatch` with its absolute
path and `-AdaptationSha256` with its verified SHA256. The default proof omits
unneeded MinGW utilities and documentation. `-Mode full` installs the complete
locked recipe dependency closure instead.

The pinned SDK's MSYS GCC 15.3.0 identifies its target as
`x86_64-pc-cygwin`; its `etc/makepkg.conf` sets the same `CHOST`. The lock
therefore requires that exact compiler target and configure build triplet,
and verifies the pinned `gcc.exe` hash. This does not select a MinGW compiler.
Compiler/linker versions and the exact target output bytes are saved before
the target assertion. Failures include a build stage, line and exit status in
`bootstrap-output.txt`; target records accept only exact LF or CRLF endings.

The scripts verify source and package hashes, require package signatures, use
the SDK's MSYS host compiler, and install only into a separate staging directory.
They record compiler/package provenance and verify that the bootstrap runtime
was not replaced. Original source notices accompany staged output.

PowerShell writes Bash scripts and checksum manifests as UTF-8 without a BOM,
using explicit LF endings. Hash-bound adaptation patches are copied unchanged;
CRLF or BOM patches are rejected. The cross-shell regression can be run with
`node --test scripts/windows-msys/build-boundaries.test.cjs` with PowerShell
(`pwsh`) and Bash available; it exercises Windows CRLF input and verifies the
generated LF manifests with the real `sha256sum` command. Some host versions
accept CRLF checksums; the pinned MSYS reader rejected them in native CI.

Syntax and patch-application checks passed locally. Windows compilation,
functional compatibility, native isolation, reproducibility, and distribution
packaging remain acceptance work. No passing compiler result alone establishes
Git Bash support. Existing native Bash and installed-provider gates remain
mandatory.

After a successful build, `node scripts/windows-msys/probe-built-runtime.cjs
<WorkRoot>` assembles a separate private closure from the pinned SDK Bash files
and the checksum-bound staged DLL. It verifies source Git blobs, copied hashes
and explicit runtime selection, then runs the existing native Bash scratch-write
and denied-access test followed by 96 cycles of command substitution, subshells,
pipelines, process substitution, and background children. Any fork retry output
fails the proof. Its manifest and log accompany the compiler artifacts.
The installed SDK and ordinary full-suite runtime selection are unchanged.

The pinned default build does not define `__WITH_AF_UNIX`; its experimental
`socket_unix.cc` implementation is excluded. This patch leaves that dormant
implementation unchanged. Default AF_LOCAL uses the existing Winsock-backed
implementation. Compiler flags are explicit and do not inherit CPPFLAGS or
LDFLAGS from the host.

Upstream build instructions: https://gitforwindows.org/building-msys2-runtime.html

AppContainer enables high-entropy ASLR even for the MSYS images that omit its
PE flag. Native memory traces showed allocations in the fixed 32–40 GiB fork
heap before MSYS initialized. Disabling high entropy on the Bash root alone
did not carry over to its children. The launcher therefore requests and verifies
the compatible policy on the bound Bash root, and this patch reapplies exactly
`PROCESS_CREATION_MITIGATION_POLICY_HIGH_ENTROPY_ASLR_ALWAYS_OFF` to
same-token AppContainer MSYS fork/spawn children. Ordinary ASLR, child access
controls, handle inheritance, and the other creation flags are preserved.
Native Windows children and host MSYS processes keep their existing startup
parameters. The child adapter contract compiles the actual patched callsites;
native build and execution proofs are still required.
