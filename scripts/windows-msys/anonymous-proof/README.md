# Anonymous pipe boundary proof

Run `python3 scripts/windows-msys/anonymous-proof/run.py` on a host with g++. It hashes the complete reviewed patch, extracts the exact two added function bodies, checks their independent digest, and compiles them against mocked Windows API boundaries in a fresh temporary directory. Digest and extraction checks remain active under Python `-O`. Compilation has a 60-second limit and execution has a 15-second limit.

The 20 cases exercise host argument preservation, actual-token branch selection, random-name failure and retry bounds, inheritance and byte-mode arguments, exact cleanup, descriptor lifetime through both endpoint calls and destruction after every invocation, and error preservation. DWORD is 32 bits. The host wchar_t mock models the ASCII-only name contents; this is not a Windows ABI or kernel execution test.

A separate C++ scope regression extracts the changed PTY handle declaration and pipe call directly from the same bound patch. It preserves the existing early `goto skip_create`, inner do-scope, and outer failure cleanup while omitting unrelated ConPTY setup. It compiles and executes early reuse, failed creation with null outputs, and successful creation. A negative control restores the historical outer handle initializers and must fail compilation because the early goto crosses initialization. This catches the actual CI15 compile failure; full MSYS translation-unit compilation still requires the native build.

The pinned Windows build and native Bash/POSIX tests are still required. No runtime is installed or selected by this proof.
