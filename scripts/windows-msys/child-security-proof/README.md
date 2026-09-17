# Same-token child security regression

CI 35028032161 isolated the failure under one AppContainer profile: the direct
native child could query its primary token, reopen its process and thread, and
use both BCrypt and legacy CryptoAPI. The identical executable launched through
MSYS Bash received access denied from token/process/thread queries and legacy
`CryptAcquireContextW`, while BCrypt still succeeded. The MSYS-created process
and thread descriptors omitted the actual package SID.

`pipe-security.patch` now adapts only the explicit descriptors used by
`CreateProcessW` in `spawn.cc` and `fork.cc`. Its existing descriptor helper copies
owner, group, SACL, DACL ACE bytes/order, inheritance controls and inheritance
flag, then appends the actual primary-token package SID. Ordinary host calls
retain their original descriptor pointer. `CreateProcessAsUserW` remains unchanged
because its target token need not match the parent's token. Preparation errors
refuse creation, and descriptor/token destruction cannot clobber the error seen
by the original caller's cleanup path.

Run `python3 scripts/windows-msys/child-security-proof/run.py`. This compiles the
exact adapter and exact patched CreateProcessW blocks with narrow Windows API
seams. Forty cases cover both callsites, host/private tokens, NULL/supplied
attributes, successful/failed creation, preparation failures, pointer lifetime,
source immutability, fresh package selection, and unchanged creation arguments.
These cases do not establish Windows kernel ACL behavior or full MSYS compilation.
The existing descriptor proof independently exercises the reused descriptor
implementation and must remain bound to the updated complete patch.

## Required native acceptance

1. Compile the full pinned MSYS runtime. Rerun the paired direct/Bash entropy
   fixture under the same profile, checking successful primary-token identity,
   matching package SID, real process/thread query opens, BCrypt and legacy
   CryptoAPI. Run actual Node crypto startup through Bash, then the complete
   Bash smoke and POSIX fork/exec tests with positive Job Object drains.
2. Keep a Bash-created child alive in profile A and record its PID, TID and
   effective process/thread descriptors. Open query/read handles from a peer
   child in A and require success; open the same rights from a distinct profile
   B and require `ERROR_ACCESS_DENIED`. Attempt terminate, VM-write and thread
   mutation rights from B and require denial. Assert the exact package A grant,
   preserved original ACEs/labels, and absence of a package B or broad application
   grant. Drain all three jobs before profile/resource release.
3. Include an explicit-deny descriptor control using the exact helper: an
   original deny covering the requested package rights must still deny access
   after adaptation. The appended allow must never precede or remove the deny.
4. Repeat with two unrelated profiles and both supported native architectures.
   Success from the direct fixture alone, source contracts, or x64-only compiler
   output is insufficient for runtime admission.
