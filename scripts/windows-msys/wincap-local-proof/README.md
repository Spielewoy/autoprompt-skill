# Process-local Windows capability source proof

The base patch changes only the `wincap` declaration from a shared section to
`NO_COPY`. Its absolute capability-table pointer then belongs to the current
process. The existing initialization algorithm, class layout, ten read-only
tables, getters, and dormant mutator remain unchanged.

CI34's authenticated diagnostic localized four fork failures to the thread
allocator constructor, whose actual DLL code dereferences that pointer. The
shared pointer can refer to a different DLL mapping, while `init()` returns for
any non-null value. This source defect justifies testing the candidate; it does
not establish the precise native fault or make the candidate accepted. CI37
retains the original candidate and separate pointer-classification diagnostics.

The sole initialization caller runs before global constructors. `NO_COPY`
preserves exclusion from parent memory restoration: the linker places it after
`__data_end__`, and fork copies only the data start/end interval. An ordinary
writable global would not provide that protection. The only capability mutator
call is inside `#if 0`; active getter behavior remains unchanged.

Run source contracts on Linux:

```
python3 scripts/windows-msys/wincap-local-proof/test.py
python3 scripts/windows-msys/wincap-local-proof/audit-pe.test.py
```

For complete pristine-source verification and Windows-target section controls:

```
python3 scripts/windows-msys/wincap-local-proof/test.py --source PINNED_PRISTINE_SOURCE --windows-cxx WINDOWS_TARGET_GXX
```

The default test compiles the exact bound original class and patched initializer
against simulated Windows APIs. Test-only visibility exposes the private pointer
for observation. It covers all version selections, host architecture/fallback,
idempotence, independent initialization, and the unchanged non-null early return.
Three distinct host ELF mappings select their own tables; an injected foreign
pointer is the negative control. Host mapping behavior is not Windows fork proof.
The optional cross compile verifies the exact old/new declarations' section
attributes using a minimal pointer-containing class, not the full class ABI.

Original complete source/header fixtures and bounded linker/caller excerpts are
hash-bound in `binding.json`. With `--source`, the test verifies complete source
hashes, every excerpt, the complete `.cc` caller scan, and full base-patch
application before asserting that only the declaration changed in `wincap.cc`.
No generated files are written into the repository.

After compiling the complete candidate, audit the actual staged DLL:

```
python3 scripts/windows-msys/wincap-local-proof/audit-pe.py STAGED_MSYS_DLL --output FRESH_RESULT_JSON
```

This bounded COFF parser requires a unique `wincap` in readable/writable,
non-executable, non-shared final `.data`, after `__data_end__` and outside the BSS
copy interval. It hashes the actual DLL and records both copy intervals and the
next distinct symbol distance. COFF does not establish this object's complete
size: the output explicitly reports `objectSize: null` and a point-bound scope.
Do not interpret symbol distance as object extent. Final full-object layout or
native compiler-derived size still needs independent inspection before bundle
acceptance. The parser refuses the authenticated old shared-section DLL.
Synthetic parser controls are labeled and cannot replace actual compiler output.

Every output remains unaccepted. Real complete compilation and native Bash
substitution/pipe/subshell, process/thread fork, descriptor isolation, entropy,
POSIX and ARM-host execution with explicit drains remain required. No security
mode, fallback, or acceptance gate is relaxed.
