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

The scripts verify source and package hashes, require package signatures, use
the SDK's MSYS host compiler, and install only into a separate staging directory.
They record compiler/package provenance and verify that the bootstrap runtime
was not replaced. Original source notices accompany staged output.

Syntax and patch-application checks passed locally. Windows compilation,
functional compatibility, native isolation, reproducibility, and distribution
packaging remain acceptance work. No passing compiler result alone establishes
Git Bash support. Existing native Bash and installed-provider gates remain
mandatory.

Upstream build instructions: https://gitforwindows.org/building-msys2-runtime.html
