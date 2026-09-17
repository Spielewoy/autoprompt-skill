# Compiled MSYS child process/thread isolation proof

This diagnostic runs the actual compiled MSYS DLL and pinned Bash. It does not
install, select, or admit a runtime. Windows execution is required for acceptance.

Run on the native compiler host:

    node scripts/windows-msys/process-security-proof/run.cjs REPO MSYS_BUILD_WORK TOOLCHAIN_JSON EXPECTED_TOOLCHAIN_SHA256 NEW_OUTPUT

`MSYS_BUILD_WORK` is the existing compiler work root. The preceding Bash smoke
step must have captured its copied closure manifest, even if that smoke failed.
The staged DLL hash, copied closure and exact `adaptation.sha256` must match the
current reviewed patch before this proof runs. The MSVC toolchain must match the
running Node architecture. Compiler, linker, source, executable, controller,
production launcher and copied runtime hashes are retained in the output.

The controller creates two unrelated AppContainer profiles. It launches bound
Bash in A, which creates the native fixture and waits for it. The fixture checks
its actual primary-token package SID and holds its initial thread alive. A fresh,
private, low-integrity ready file reports its PID and TID. The controller opens
and retains both object handles, confirms the TID belongs to that PID, and checks
that neither object has exited before or after peer operations. The Bash command
has a following status/exit statement, so its final command cannot replace Bash;
the completed creator job must report at least two observed members.

Effective descriptors must contain the exact five mapped `sec_acl` grants in
order: user full access, Authenticated Users query-limited, administrators full
access, SYSTEM full access, and only package A full access. The mandatory label
must be low integrity with no-write-up; its exact descriptor bytes and other
object-specific mandatory policy bits are retained. Windows supplies the owner
and primary group where the original descriptor leaves them unspecified.

A separate A process must successfully open seven process and five thread access
masks, including query/read and mutation rights. The first query handle verifies
the object ID. A B process must receive exact `ERROR_ACCESS_DENIED` for all twelve
identical masks. No mutation is performed. This covers process termination,
VM-write, VM-operation, handle duplication, and thread context, suspension and
information rights in addition to the rights needed by the original failure.

After both peers complete, descriptors must remain byte-identical and the held
objects still live. An exclusively written release marker lets the child exit.
The creator and both peer jobs must positively drain before profiles or resources
are released. Missing/incorrect records, unexpected status, timeouts or unknown
drain fail the proof and retain the owned work tree. The manifest remains pending
until parsing and bounded cleanup succeed. No original explicit-deny descriptor
is manufactured by this compiled Bash path; separate helper deny controls remain
a distinct component test, not a claim made by this proof.

Local validation:

    node --test scripts/windows-msys/process-security-proof/parser.test.cjs

Eleven parser cases validate complete ordered records and reject weakened or
incomplete evidence. A twelfth compiles the exact C++ ID parser and peer-open loop
with narrow API seams and runs fifteen control-flow cases. That contract executes
on Linux with Python 3 and g++; Windows instead builds the actual fixture with
MSVC. These local cases and PowerShell compilation of the complete C# controller
do not establish native ACL behavior. Actual native run results must be reviewed.
