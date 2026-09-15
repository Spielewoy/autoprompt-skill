# Candidate Windows Node build

This is an experimental Node 24.20.0 x64 build route, not a selected production runtime. Keep this directory and its nul-proof subdirectory together: the compiler consumes both separately pinned patch files. Archives, extracted source, generated mock executables, and local proof inputs are outside-repository artifacts.

The lock binds the official Node source archive, the official NASM 2.16.03 Windows archive and executable, and original and patched libuv sources for both adaptations. The NUL patch separately pins internal.h, process-stdio.c, and process.c, plus the new nul-capability.h whose absence is required before application. All four resulting hashes are checked before compilation; both patches are captured with staged provenance. Node's archive SHA256 was checked against its official HTTPS release manifest. NASM's SHA256 was calculated from its official HTTPS distribution. Detached release signatures were not verified.

The pipe patch queries the actual process token once per pipe pair. Ordinary host names and retry behavior remain unchanged. AppContainer pairs use a flat LOCAL name and stop after eight access-denied/busy collisions. Token-query and name-truncation errors fail closed. The server's NULL security attributes and all client access, inheritance, connection, and cleanup code remain unchanged.

The existing native NULL-SA LOCAL probe proves basic generic read/write creation and connection. It does not establish libuv's additional WRITE_DAC access. The source-derived mock proof checks the exact read, write, duplex, WRITE_DAC and inheritance arguments, plus failure cleanup; only real selected-worker Windows tests can prove compatibility.

The private NUL patch uses the separate inherited capability supplied by the production launcher. It queries the actual AppContainer token, duplicates the locator before checking the held File object is exactly \Device\Null, validates its granted rights, and gives ignored stdio exact-rights duplicates. Each spawn propagates a new owned locator in a local environment copy, including custom empty environments; it never mutates global environment state. Host direct-open behavior remains unchanged. Invalid configured locators, aliases and wrong objects fail closed. See nul-proof/README.md for the protocol and independent source-derived proof.

The builder requires PowerShell 7, Windows x64, a new ASCII path without spaces, Visual Studio 2022 17.14+ or Visual Studio 2026 18.x with LLVM and C++ tools, Python, Git, and Windows tar. It captures selected compiler identities, configuration, logs, copied LICENSE, and staged node.exe provenance. It uses vcbuild's default Release configuration with x64, the exact selected vs2022/vs2026 target, and clang-cl nonpm nocorepack no-cctest; full OpenSSL assembly remains enabled with the pinned NASM.

Work trees are retained on failure. Timeout cleanup requests process-tree termination but does not claim every descendant was independently verified. Output copies are bounded and unfinished stream owners remain retained.

Local evidence:
- Both exact patches apply together cleanly to the verified pristine sources; all original and resulting hashes match the lock.
- 26 source-derived C boundary cases pass with gcc -Wall -Wextra -Werror. The mock DWORD is explicitly uint32_t; its PID-return varargs shim models Windows %lu while compiling on Linux.
- 41 additional source-derived C cases cover NUL identity, exact access, duplicate-first handling, environment propagation, size bounds, and failure cleanup. These use 2-byte WCHAR and 4-byte DWORD mocks.
- build-boundaries.test.cjs passes 4 tests, including three actual process cases for drain/failure/timeout and eleven real filesystem cases against the builder's AST-extracted source verifier. Changed originals, a pre-existing new header, changed outputs, and a missing generated header refuse.
- PowerShell parses the builder successfully.

No Windows build or native execution of the combined pipe and private NUL candidate has yet been completed. Before acceptance, the staged, hash-bound worker must pass real AppContainer inherit, pipe, IPC, and ignored-stdin tests, nested custom/empty environments, changed stdin, and concurrent-profile handle isolation with positive job-drain evidence. No stock-worker fallback is permitted for that proof.
