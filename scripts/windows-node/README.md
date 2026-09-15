# Candidate Windows Node build

This is an experimental Node 24.20.0 x64 build route, not a selected production runtime. Copy build.ps1, build-lock.json, libuv-appcontainer-pipes.patch, .gitattributes, build-boundaries.test.cjs, process-contract.ps1, and this README together. Archives, extracted source, generated mock executables, and local proof inputs are outside-repository artifacts.

The lock binds the official Node source archive, the official NASM 2.16.03 Windows archive and executable, and both original and patched libuv pipe.c. Node's archive SHA256 was checked against its official HTTPS release manifest. NASM's SHA256 was calculated from its official HTTPS distribution. Detached release signatures were not verified.

The patch queries the actual process token once per pipe pair. Ordinary host names and retry behavior remain unchanged. AppContainer pairs use a flat LOCAL name and stop after eight access-denied/busy collisions. Token-query and name-truncation errors fail closed. The server's NULL security attributes and all client access, inheritance, connection, and cleanup code remain unchanged.

The existing native NULL-SA LOCAL probe proves basic generic read/write creation and connection. It does not establish libuv's additional WRITE_DAC access. The source-derived mock proof checks the exact read, write, duplex, WRITE_DAC and inheritance arguments, plus failure cleanup; only real selected-worker Windows tests can prove compatibility.

The builder requires PowerShell 7, Windows x64, a new ASCII path without spaces, Visual Studio 2022 17.14+ with LLVM and C++ tools, Python, Git, and Windows tar. It captures selected compiler identities, configuration, logs, copied LICENSE, and staged node.exe provenance. It uses vcbuild's default Release configuration with x64 vs2022 clang-cl nonpm nocorepack no-cctest; full OpenSSL assembly remains enabled with the pinned NASM.

Work trees are retained on failure. Timeout cleanup requests process-tree termination but does not claim every descendant was independently verified. Output copies are bounded and unfinished stream owners remain retained.

Local evidence:
- Exact patch applies cleanly to the verified pristine source.
- 26 source-derived C boundary cases pass with gcc -Wall -Wextra -Werror. The mock DWORD is explicitly uint32_t; its PID-return varargs shim models Windows %lu while compiling on Linux.
- build-boundaries.test.cjs passes 2 tests, including three actual process cases for stdout/stderr drain, nonzero exit propagation, and timeout handling through the builder's AST-extracted Run function.
- PowerShell parses the builder successfully.

No Windows build or adapted Node native execution has yet been completed. Before acceptance, the staged, hash-bound worker must pass real AppContainer inherit, pipe, IPC, and ignored-stdin tests with positive job-drain evidence. No stock-worker fallback is permitted for that proof.
