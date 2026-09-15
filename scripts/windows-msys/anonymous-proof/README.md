# Anonymous pipe boundary proof

Run `python3 scripts/windows-msys/anonymous-proof/run.py` on a host with g++. It hashes the complete reviewed patch, extracts the exact two added function bodies, checks their independent digest, and compiles them against mocked Windows API boundaries in a fresh temporary directory. Digest and extraction checks remain active under Python `-O`. Compilation has a 60-second limit and execution has a 15-second limit.

The 20 cases exercise host argument preservation, actual-token branch selection, random-name failure and retry bounds, inheritance and byte-mode arguments, exact cleanup, descriptor lifetime through both endpoint calls and destruction after every invocation, and error preservation. DWORD is 32 bits. The host wchar_t mock models the ASCII-only name contents; this is not a Windows ABI or kernel execution test.

The pinned Windows build and native Bash/POSIX tests are still required. No runtime is installed or selected by this proof.
