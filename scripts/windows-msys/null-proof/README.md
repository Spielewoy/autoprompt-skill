# MSYS private NUL candidate

Source candidate in the combined MSYS adaptation patch; not yet Windows-compiled or accepted.
Baseline: git-for-windows/msys2-runtime 270ba2980700e6e2a0813944d506eecea0f86402. The helper is extracted directly from `../pipe-security.patch`, whose exact digest and helper digest are bound in `binding.json`. This directory carries no independently selected runtime or binary.

`appcontainer_null_open` returns false only for a verified ordinary primary token or absent locator. A present invalid locator or failed token/object query returns a refusal without direct device-open fallback. It duplicates the numeric locator first, without inheritance, before querying the actual object. The full incoming capability must be FILE_TYPE_CHAR, object type File, object name \\Device\\Null, exact access 0x12019f, and exact 56-byte ObjectBasicInformation. Both variable-size string query records are bounded, including their pointers, alignment and maximum length.

A second owned duplicate carries only the explicit mapped read/write access subset. It is independently validated and inherits exactly when O_CLOEXEC is absent. Source handles remain untouched; cleanup preserves LastError. GENERIC_ALL/EXECUTE, MAXIMUM_ALLOWED and rights outside the incoming capability are refused. FILE_CREATE preserves existing-file refusal; only FILE_OPEN/FILE_OPEN_IF are admitted. Supported options are the existing generic Null caller's backup-intent, synchronous-nonalert, write-through and no-buffering bits. These do not change the inherited Null file object's configuration; native validation is still required before treating these combinations as supported. Unknown options fail closed.

Both base::open_null and generic FH_NULL open use the adapter. The fake-lock open_null caller passes only O_CLOEXEC into it, because real directory fhandlers use this internal Null handle even with O_DIRECTORY. Generic FH_NULL still rejects O_DIRECTORY/O_TMPFILE. Existing O_TRUNC logic only applies to FH_FS, and existing open/create disposition choice is unchanged. Success initializes io.Information to FILE_OPENED. Failure diagnostics have initialized fh/status. Original NtCreateFile calls and the remainder of both methods are verified byte-for-byte after removing only the reviewed adapter branches.

No unique-file-ID patch is needed: pinned fhandler.h already uses NtAllocateLocallyUniqueId and open_setup assigns the ID independently of the shared Null file object. The source contract checks that invariant.

Run:

    python3 scripts/windows-msys/null-proof/run.py
    python3 scripts/windows-msys/null-proof/run.py --source PATH_TO_PINNED_SOURCE_BEFORE_NULL --cxx g++
    python3 scripts/windows-msys/null-proof/run.py --environ-source PATH_TO_PRISTINE_PINNED_SOURCE --cxx g++

This extracts and compiles the actual patch helper with 2-byte WCHAR and 4-byte DWORD mocks. 68 executable cases cover host/absent fallback, malformed locator/token/query records, duplicate-before-query and concurrent source replacement, exact capability and requested rights, inheritance, second-duplicate failure and excess-rights rejection, dispositions, options, directory/tempfile refusal and cleanup. The optional `--source` must point to the pinned tree before the Null adapter (the preceding pipe/process patch is allowed). The optional `--environ-source` checks the pristine `environ.cc` locator hunk independently: it applies the exact patch, verifies the candidate hash, then removes exactly the three added lines and verifies the original hash. The supplied-only `spenv` row preserves the locator through normal MSYS exec while still refusing to synthesize it for an absent or cleared environment. Without either source option, output reports those contracts as not executed; only the 68 helper cases run. No source tree is downloaded or modified. These are not native Windows tests.

Required native follow-up: rebuilt DLL, Bash background stdin, direct /dev/null EOF/write behavior, separate read/write opens and CLOEXEC, fork+exec, bad/closed/wrong-object locators, fake-lock directory handles, and existing job-drain controls. The adapter does not edit the environment or grant authority from its locator; absent-locator and `exec -c` execution remain unsupported and take the original device-open path, which can fail under AppContainer. No device ACL is changed.
