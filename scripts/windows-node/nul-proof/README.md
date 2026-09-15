# Experimental private NUL capability for Node 24.20.0

This directory preserves an experimental candidate and executable regression
proof. Its driver never selects, installs or replaces a production runtime. The patch targets the exact original source files recorded
in binding.json and is independent of the existing pipe-namespace patch.

Protocol: AUTOPROMPT_PRIVATE_NUL_HANDLE is exactly 16 lowercase hexadecimal digits
on x64/ARM64 (8 on a 32-bit target), without a prefix, sign or whitespace. Zero
and negative/pseudo-handle encodings are rejected. The launcher must supply a
separate inherited Null handle with FILE_GENERIC_READ|FILE_GENERIC_WRITE rights
(0x12019f), outside stdin/CRT descriptors. It must add only that owned handle to
its explicit HANDLE_LIST. The launcher must retain its explicit handle whitelist when adding this
capability; ambient inheritable handles must remain excluded.

The actual process token decides whether the private path applies. Ordinary host
calls do not read the locator. An AppContainer without a locator retains existing
direct-open behavior. A configured invalid locator refuses without fallback.
The helper duplicates into a held local handle before checking character-device
type, native File type, exact Device/Null name, and granted mask. This prevents
the original locator's close/reuse from changing the validated object.

One owned propagation duplicate is retained per uv_spawn. A local environment
copy replaces the parent's validated locator with the new duplicate, including
custom env={} and inherited env=NULL. Duplicate aliases and explicit conflicting
locators refuse. No process-global environment or handle cache is mutated.
The propagation handle is outside CRT/stdin so Node startup does not clear its
inheritability. uv_spawn closes its local copy in its normal cleanup path.
Each ignored stdio handle receives an exact-rights duplicate; the existing stdio
buffer owns its lifetime. Host direct CreateFileW behavior remains unchanged.

Run the source-derived proof with the verified source tree already on disk:

```sh
python3 scripts/windows-node/nul-proof/run-proof.py \
  --source /absolute/path/node-v24.20.0 --cc /usr/bin/gcc
```

The proof requires Python 3, Git, and GCC or Clang on a 64-bit POSIX host. It
uses -fshort-wchar for Windows-sized WCHAR and does not download anything.
Use the Node 24.20.0 source archive and SHA256 recorded in binding.json;
the driver verifies each consumed source file against its exact recorded hash.
All verification checks remain active under Python -O.

The driver verifies original/patch/result hashes, applies the patch in a fresh
temporary tree, and compiles the actual helper, actual internal capability type,
and actual modified NUL-open function against mocked native APIs. It also proves
that the cap=NULL direct-open body normalizes exactly to the original function.
41 cases pass with 2-byte WCHAR and 4-byte DWORD, covering malformed/absent
locators, actual-token boundary failures, duplicate-first source reuse, wrong
device kinds/names, insufficient masks, query bounds, exact stdio access,
custom/empty/inherited environments, duplicate keys, allocation cleanup, and
uncached host behavior. These are not native Windows compatibility results.

Before enabling the candidate: build the complete patched Node under the pinned Windows
toolchain; run the strict selected-worker pipe/IPC/ignore tests, including nested
children with env={} and changed stdin; validate the inherited capability's
rights/identity with the real launcher; test close/reuse and stray inheritable
handles across concurrent profiles. Keep the device's global DACL unchanged.

Observed CI14 explains why this is needed: x64 OS build26100 denies all twenty
direct device cells and its Null descriptor lacks application-package ACEs.
ARM OS build26200 includes AC and restricted-AC ACEs and accepts all twenty.
Alternative device spellings and minimal access therefore do not repair the
observed x64 restriction. No architecture-only inference is made.
