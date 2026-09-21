# MSYS mapping diagnostic proposal

This is a standalone, unaccepted Windows diagnostic. It reads the authenticated CI38 packet supplied by the existing workflow, requires its pinned manifest/Bash/DLL digests, and validates its full portable-runtime file set. It does not rebuild MSYS or change the repository.

`node test-pe.cjs PACKET/runtime/msys-2.0.dll` checks the authenticated candidate; without its optional argument it checks the synthetic PE patcher. The runner creates the DYNAMIC_BASE-only copy in its private output root; it differs from the authenticated baseline only in `IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE` and the PE checksum. The baseline DLL is rehashed before and after every native arm.

On the authenticated Windows workflow, run `node run.cjs REPO PACKET EXISTING_OUTPUT`. Each arm creates a fresh AppContainer profile and uses the current production `windows-appcontainer-native.cs` launcher copied from `REPO`. Bash reads `/proc/self/winpid` with a builtin, writes a ready marker, then spins using only shell builtins until the host records the root `msys-2.0.dll` module path/base and `GetProcessMitigationPolicy(ProcessASLRPolicy)` flags. The host releases Bash only then; Bash runs `x=$(printf child)` and the controller records any `dll data read copy failed` ranges and derives a child base from the PE `.data` RVA.

The two arms are baseline and DYNAMIC_BASE-only. Both are observations, not runtime acceptance. There is no mitigation-disable or forced-ASLR-off arm. A failed run retains its working directory and refuses profile deletion unless the launcher reports positive drain.
