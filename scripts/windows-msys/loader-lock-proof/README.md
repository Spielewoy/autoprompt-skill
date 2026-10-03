# Direct NT security helper contracts

The compiled MSYS helper is reached while a fork child is inside
`DLL_PROCESS_ATTACH`: `dll_crt0_0` → `handle_fork` → `memory_init` →
`open_shared` → the adapted `CreateFileMappingW`. The original helper called
ADVAPI32 security APIs through MSYS's autoload machinery from this path.
The pinned MSYS source explicitly avoids autoload during fork initialization.

`appcontainer_nt_security.h`, carried in the reviewed patch, translates those
security calls to direct imported Nt/Rtl APIs. The descriptor algorithm still
owns its copied storage, preserves the existing ACE order and control flags,
appends only the actual package SID, and leaves ordinary host descriptors alone.
No library preload, cached token, environment SID or weaker access mask is used.

Run the portable contracts with:

```sh
python scripts/windows-msys/loader-lock-proof/run.py
```

The exact header is extracted from the bound patch and compiled against small
controlled API seams. The 34 checks cover NTSTATUS conversion, byte-sized BOOLEAN
outputs, token-query lengths, absolute versus relative descriptor validation,
relative computed-length limits, RM control, the fixed SYSTEM SID and setters.
The relative descriptor length is computed from caller-owned readable storage;
it is not a proof of that storage's allocation extent.

An optional Windows cross-compiler verifies the complete helper's unresolved
symbols contain only direct Nt/Rtl, existing Kernel32 operations and `memcpy`:

```sh
python scripts/windows-msys/loader-lock-proof/run.py \
  --windows-cxx /absolute/path/to/x86_64-w64-mingw32-g++ \
  --sdk-ntdll /absolute/path/to/libntdll.a
```

The optional import-library check pins
`git-for-windows/git-sdk-64@e3cc14afd549778c2f2d3bcc6e89307f40f5c2c1`,
`usr/lib/w32api/libntdll.a`, SHA256
`e59aa942c948ee8917c585e7abd15528fa27bf41ebe3bf904c99b92d7be7f9f2`.
All 31 direct security symbols must be present.

These are source and ABI checks. CI22's child exit `0xC0000142` and this unsafe
autoload path motivate the change; they do not prove its runtime cause. Complete
native MSYS compilation, the unchanged 16-object descriptor proof, real Bash
fork and three-job process/thread isolation must pass before the fix is accepted.
