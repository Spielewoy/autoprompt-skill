# Native NUL diagnostic

The source test runs a standalone host baseline and a separate child under the
current production `WindowsAppContainerNative.Launch`. The child must report its
actual expected AppContainer SID without thread impersonation. Its executable
bytes are bound before launch and checked afterward. The controller stays in a
separate private directory; only the new probe image and its new leaf directory
receive the exact package read/execute grant. No existing directory, device ACL,
global namespace, or capability list is changed.

Each process attempts twenty ordered cells: four fixed NUL spellings and five
access masks. The first masks reproduce libuv's ignored stdin and stdout/stderr
requests exactly. Additional minimal and zero-access masks help distinguish
metadata rights from data rights. Every open uses OPEN_EXISTING, share read/write,
and libuv's inherited SECURITY_ATTRIBUTES with a NULL descriptor.

Every successful handle is queried while held. One-byte I/O occurs only when its
native object name is exactly Device/Null. Device security is queried read-only.
Denied access remains an observation, not a claim that ignored stdio works. The
host must successfully open NUL with both exact libuv masks. The AppContainer may
report access denial; the existing strict Node support tests remain responsible
for the product compatibility gate.

Success requires all ordered observations, exact token identity, unchanged image,
zero controller/child error output, and positive job drain. An uncertain controller
or launch outcome retains the owned fixture and profile instead of deleting them.

For a Windows early CI step, run from the repository root:

```powershell
node --test --test-reporter=tap tests/source/windows-appcontainer-nul.test.cjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The exact native case name is:

`native Windows NUL diagnostic records exact device access under an AppContainer token`

Capture TAP as an artifact; diagnostics are split into short lines for live logs.
The test has a ten-minute total setup budget, a ten-second native job deadline,
and a thirty-second outer controller bound. The local compilation case skips on
Windows because the native case compiles both executable assemblies itself.

Local non-Windows proof comprises parser rejection cases and actual PowerShell
compilation of the fixture/controller with production C#. It does not establish
Windows device behavior.

Primary source context:

- https://github.com/nodejs/node/blob/v24.20.0/deps/uv/src/win/process-stdio.c
- https://github.com/nodejs/node/blob/v24.20.0/deps/uv/src/win/error.c
- https://github.com/microsoft/mxc/blob/main/docs/host-prep.md#prepare-null-device
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea
- https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
