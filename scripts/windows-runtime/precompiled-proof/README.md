# Fixed precompiled physical capture proof

This is a diagnostic native experiment. It changes no installed runtime selection or admission. The helper compiles `../physical-proof/audit.cs` directly, with no copied lease implementation. The runtime executable has no PowerShell wrapper, Add-Type, source loading, reflection, commands, or child creation.

`lease-main.cs` checks IsWow64Process2 for native x64/ARM64 and accepts one bounded ASCII JSON line of exactly `{"root":STRING,"files":[STRING,...]}`. Unicode root characters use JSON escapes. It opens the existing physical lease, emits `bundle-lease-ready-v1`, requires `finish` and stdin EOF, validates/releases the lease, emits `bundle-lease-finished-v1`, and exits zero. It rejects additional/duplicate/reordered fields, malformed escapes/surrogates, non-ASCII wire bytes, and the original input/deadline overflows. The unchanged lease rejects duplicate inventory paths.

## Native build and test

Use inbox Windows PowerShell5.1, not pwsh7 (which does not support ConsoleApplication output):

```powershell
$build = Join-Path $env:RUNNER_TEMP 'precompiled-capture'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -File scripts/windows-runtime/precompiled-proof/build.ps1 -OutputDirectory $build
if ($LASTEXITCODE -ne 0) { throw 'precompiled-helper-build-failed' }
$env:AUTOPROMPT_CAPTURE_BUILD = $build
node --test --test-reporter=tap scripts/windows-runtime/precompiled-proof/native.test.cjs > "$build/native.tap"
if ($LASTEXITCODE -ne 0) { throw 'precompiled-helper-proof-failed' }
node scripts/windows-runtime/precompiled-proof/verify-output.cjs "$build/native.tap"
if ($LASTEXITCODE -ne 0) { throw 'precompiled-helper-output-refused' }
```

The build directory must be new. Build-time CodeDOM compilation emits AnyCPU CLR4 with an exact config requesting .NET Framework4.8. Windows PowerShell5.1 rejects combining Add-Type's CompilerParameters with OutputAssembly at runtime; the builder calls CSharpCodeProvider directly with one explicit compiler policy. Native ARM64 requires the system's native ARM64 .NET Framework runtime; x64 emulation on ARM64 fails the executable's architecture check. `build.json` binds source bytes before and after compile and executable/config bytes, but says `compiled-native-identity-only`. Its hashes are fixture identity, not independent release authority. The native tests bind all recorded source bytes back to the current checkout.

The seven native TAP cases require actual Windows and zero skips in CI. Six exercise the executable transport: held capture above the old16MiB limit (17MiB file), concurrent overwrite/rename refusal, wrong finish, trailing input, termination before/after capture, and wrong helper identity. The seventh executes all17 existing NTFS controls after loading the **same compiled helper executable's assembly**: no second audit.cs compilation. The unchanged `native-controls.cs` supplies attack primitives, and local tests verify the17-control body stays identical to the established suite. These17 cases are component conformance against the compiled lease type; the other six separately prove subprocess transport and capture composition. They are not represented as17 independent executable-handshake tests.

`verify-output.cjs` requires all seven exact names in order, one complete plan, successful results, zero skips/todos/failures, and exact unique totals. Native tests explicitly skip on Linux; the verifier refuses such output. Local tests compile both complete C# sources and run40 actual parser/read/deadline/lease-shape assertions. Run `node --test local.test.cjs verify-output.test.cjs`; set `AUTOPROMPT_CAPTURE_PWSH` to the local PowerShell executable if it is not on PATH. Missing compiler fails explicitly.

## Capture and lifecycle limits

`adapter.cjs` is adapted from the diagnostic physical adapter. It validates externally supplied executable/config hashes, copies those captured bytes into the existing private-ACL controller directory, and spawns that fixed private copy directly. The parent exposes captured bytes only after two audits, final native acknowledgement, empty stderr, zero exit, and actual helper close. Unknown close preserves the private helper directory and reports cleanupConfirmed:false. Direct termination-and-close applies only to this fixed no-descendant helper, never an arbitrary executable.

The original129-file/128-directory/322-handle limits remain. The byte limits are128MiB per file and256MiB total, matching the decoder's default compressed input capacity. Raising them does not itself prove native large-file capture. This proof does not establish a hard RSS limit. A production composition must capture its externally authorized manifest in the same inventory, then hand those exact owned bytes to the decoder without reopening bundle paths.

Production must independently authenticate and bind the bootstrap executable/config, source/build identities, and probe/cache identity. A colocated build.json cannot establish that authority. None of these fixture passes select a worker bundle or establish platform admission. Both native architectures must execute the helper and full proof before promotion.

The existing ProcessOwner transport uses durable files rather than streaming pipes; it cannot directly replace this handshake. Rewriting it would require a new bounded state protocol and equivalent recovery proofs, and its existing helper currently invokes Add-Type. The fixed no-descendant executable removes that compiler-descendant gap for physical capture without introducing a second process manager. Components that create descendants must continue to use the established owner/job lifecycle.

References: [Windows PowerShell5.1 Add-Type](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type?view=powershell-5.1), [PowerShell7 executable-output limitation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type?view=powershell-7.5).
