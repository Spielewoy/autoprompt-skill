# POSIX fixture experiment

This is a native acceptance experiment for a compiled MSYS candidate. It does not install or select a production runtime.

Pass `-CompilePosixFixture` to the existing `build.ps1` compiler job. This copies normalized LF source/script text into the owned SDK payload and compiles the fixed-hash C source under `/issue27-build/posix-compile-fixture`. Compiler/source hashes and the pinned SDK commit must match. The SDK's loaded DLL is never replaced.

After `probe-built-runtime.cjs` passes its actual copied-Bash test, run:

```powershell
node scripts/windows-msys/probe-posix-runtime.cjs $PWD.Path $WorkRoot (Join-Path $WorkRoot 'sdk/issue27-build/posix-compile-fixture')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The controller checks the preceding smoke result, source/stage/copy bindings, fixture checksum and x64 PE imports. Extra SDK/PATH DLLs are refused. It creates a fresh private copy and uses the production native launcher and resource leases with Bash as the root image. Each launch gets a25-second native deadline; the C fixture has its own20-second watchdog. Paths are separate arguments to a fixed Bash command.

Required operations are pipe/fork/wait, actual FIFO peer/EOF/transfer behavior, flock and fcntl contention plus shared bytes, and default Winsock-backed AF_LOCAL socket transfer. Denied or unsupported operations fail. Blocked FIFO cancellation starts only after a bounded physical readiness record proves the reader opened and remained incomplete for100ms. Cancellation must return authentic whole-job drain evidence before resource restoration. Missing readiness remains failure.

The controller retains `posix-proof-UUID/results.jsonl` and all proof artifacts. If drain or restoration is uncertain, it additionally retains the exact native helper deployment and resource journal. Do not delete or revoke resources based solely on elapsed time or an exited root PID. Preserve the existing finite compiler-job timeout and upload the compilation output and result logs.

Mqueue is explicitly **not run** by this controller. MSYS requires `/dev/mqueue` backing; an isolated owned backing directory and crash cleanup are prerequisites. No global directory grant is permitted. The C mode exists for later validation, with an owned name receipt, but cannot establish support before those prerequisites are implemented.

Local parser/refusal tests and a real Linux C fixture through the literal Bash wrapper are available in `probe-posix-runtime.test.cjs`. Windows compilation and execution, including ARM64-host control of this x64 MSYS fixture, require native CI evidence. One passed smoke or this partial syscall matrix does not establish complete Windows support.
