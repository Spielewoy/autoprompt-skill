# Primary token default DACL preservation

Run `python3 scripts/windows-msys/token-default-proof/run.py`. An optional
`--source PATH` also verifies the complete unpatched `winsup/cygwin/uinfo.cc`
against the pinned source hash and compares the fixture to that source.

The test reconstructs the complete candidate `cygheap_user::init()` function
from the actual, hash-bound combined patch and an exact upstream function
fixture. It compiles that function against narrow C++ API seams with a
four-byte Windows `ULONG`. The 33 cases check normal host initialization,
preservation of all inherited security for an actual AppContainer token,
query failures, malformed returned sizes and boolean values, and the existing
host security-write error paths. The original host code must remain unchanged
outside the added guard. The original source copyright remains with the fixture.

The query uses the already-open primary token and the existing ntdll API.
It does not load advapi32 during early initialization or derive identity from
environment variables. An unknown AppContainer state aborts initialization.
For an actual AppContainer, it leaves the launcher-supplied token owner,
default DACL, and process DACL intact. No package or global ACE is added here.

These are source contracts, not native Windows acceptance. Real Bash startup,
child token queries, legacy entropy initialization, fork, and cross-profile
process/thread denial must still pass with the compiled runtime. Explicit
setuid/foreign-token and impersonating `CreateProcessAsUser` paths are outside
this narrow change.
