# MSYS AppContainer compiler investigation

This directory builds an isolated compiler proof from the exact source and SDK
commits in `build-lock.json`. It does not replace an installed Git/MSYS runtime
or select the resulting DLL for production commands. The initial patch only
adds the pipe security adapter and its build/import registration; pipe creation
sites are not yet connected to it.

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

Upstream build instructions: https://gitforwindows.org/building-msys2-runtime.html
