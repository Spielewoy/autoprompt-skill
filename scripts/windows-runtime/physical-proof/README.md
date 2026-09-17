# Windows physical bundle capture proof

Diagnostic-only native validation. This directory does not select, install, decode, or execute a worker runtime. It does not contain an accepted runtime bundle.

Run with Node20 or24:

```sh
node --test scripts/windows-runtime/physical-proof/audit.test.cjs
```

Windows tests explicitly use inbox Windows PowerShell5.1 under the controller's SystemRoot. Linux C# contracts use `pwsh` from PATH, or an explicit `PWSH=/absolute/path/to/pwsh`. There are22 Node tests:15 portable/compilation contracts and7 mandatory native Windows tests. Linux skips exactly those7 native cases. Windows runs all22; its C# compile checks require the same installed inbox PowerShell used by the native fixture.

The native filesystem test asserts17 ordered controls: a positive closed tree; a hardlinked file; junctions at the root, an intermediate directory and a declared file position; a preexisting writable file handle and release positive; a writable mapping with its creating file handle already closed and release positive; held write/delete/file-rename/root-rename refusal and release positive; extra/missing entries; and a new child during capture. The last control requires either creation refusal or final closed-tree refusal. Junctions are directory reparse points; the file-position control deliberately verifies that neither following the target nor accepting the wrong physical type can satisfy the regular-file inventory. The fixture creates junctions using native NTFS reparse data without asking for symlink privileges or changing ACLs.

Six additional native tests execute actual captured helper code over owned pipes. They prove exact byte capture, helper termination both before reads and before final acknowledgement, malformed finish, trailing finish input, and content mismatch with confirmed helper cleanup. No successful case supplies an always-true audit callback. Closed state-machine unit tests also require both audits, final acknowledgement, and zero process exit. Real C# compilation executes34 path/type/snapshot cases; the actual driver's extracted bounded reader executes4 success/refusal/deadline cases.

## Physical lease

`audit.cs` holds noninheritable native handles from before capture until final validation. Files use GENERIC_READ and FILE_SHARE_READ only, excluding writers, writable mappings, deletion and replacement. Ancestor/directory handles also exclude deletion. OPEN_REPARSE_POINT, native file type, link count, canonical final path and NTFS identity are checked. A native enumerator admits only declared files and their necessary parent directories, with bounded entries, depth and handles. FILE_BASIC_INFO write/change timestamps and held/reopened identities are compared after enumeration/capture; unrelated ancestor child changes do not invalidate the bundle, but ancestor identity/type/canonical path remain checked. No permissions are changed.

`adapter.cjs` takes a closed list of `{path,length,sha256}` records with independently supplied hashes. For this physical-only proof, records are authored from the known generated fixture bytes. A real bundle loader must derive them from its externally authenticated manifest, including the manifest itself, compressed files and all source/notices/acceptance records. The adapter's proof-specific limits are129 files,16MiB per file and32MiB total; they are intentionally smaller than a full worker bundle. Do not use this proof entrypoint to load production bundles.

The adapter executes only captured, hash-checked C# and driver bytes. PowerShell receives the captured driver as an encoded command and source over the owned stdin pipe, so it never reopens either source path. Its systemRoot input comes from trusted controller platform identity. Before launching, the adapter exclusively creates a canonical controller temporary directory outside the audited bundle and applies the existing exact private DACL helper. Only this directory is supplied as TEMP/TMP and cwd; the driver checks that actual .NET GetTempPath matches before Add-Type. This avoids depending on administrator access to WINDIR when PowerShell compiles C#. No worker receives the directory or a permission grant. It is removed only after actual helper close and retained with an explicit error path on unconfirmed cleanup. The test computes helper hashes from repository-controlled source only to bind those exact fixture bytes; production expected hashes must originate in payload/release authority.

The driver disables only PowerShell progress records before loading modules. Windows PowerShell's encoded-command transport can serialize these records as CLIXML on stderr even when the command succeeds. The native transport controls in the inventory contract execute the driver's exact preference prefix and require a visible progress record without suppression, empty stderr with suppression, and unchanged visibility of both direct stderr and terminating PowerShell errors. The adapter never filters CLIXML or allows nonempty stderr. On failure, it retains at most1024 raw stderr bytes and256 pending stdout bytes as Base64 diagnostics, with the total stderr byte count and actual helper phase/close/exit state. Three portable protocol tests check strict refusal and diagnostic bounds independently of Windows.

A live lease's two audit calls surround actual file reads and hash checks. The adapter returns bytes only after native final inventory/identity validation, exact acknowledgement, empty stderr and actual zero exit. Stale or interrupted helpers cannot authorize a result. The driver requires EOF after the finish command and independently bounds input using a CLR thread-pool read, avoiding .NET Framework Console.In.ReadAsync synchronous behavior. The controller bounds the helper to60 seconds; on failure it requests termination and waits up to5 seconds for close. Unconfirmed cleanup is reported explicitly, and the fixture tree is retained. A helper failure never returns captured bytes.

The lease owns the noninheritable filesystem handles in its PowerShell process. It does not claim that Add-Type compiler descendants are contained in a job. Production composition should use the existing owned-helper process lifecycle. This proof also does not claim resistance to privileged kernel tampering. Attribute-only access is not excluded by Win32 sharing modes; signed content hashes, native snapshots and the held file lease remain necessary.

Native x64/ARM64 execution is required before promotion. Local Linux C# compilation and mocked state-machine tests do not establish actual NTFS sharing, junction or mutation behavior. Kernel/API refusal is never converted into a passing compatibility result.

Primary contract: [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) documents persistent share restrictions, write-mapping conflicts, no-delete behavior, OPEN_REPARSE_POINT and BACKUP_SEMANTICS, and distinguishes attribute access from data sharing.

CI must retain and verify the unfiltered TAP output, in addition to checking Node's exit status:

```sh
node --test --test-reporter=tap scripts/windows-runtime/physical-proof/audit.test.cjs
node scripts/windows-runtime/physical-proof/verify-output.cjs PATH_TO_CAPTURED_TAP_LOG
node --test scripts/windows-runtime/physical-proof/verify-output.test.cjs
node --test scripts/windows-runtime/physical-proof/protocol.test.cjs
```

The verifier requires exactly22 ordered top-level passing cases, each native case exactly once without SKIP/TODO, and consistent zero-failure/zero-cancellation/zero-skip totals. Its18 parser regressions include missing, duplicate, failed and skipped native cases, parser-only lookalikes, wrong totals and incomplete plans. The verifier intentionally rejects Linux output because its native cases must skip there.
