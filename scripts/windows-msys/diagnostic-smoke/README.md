# Compiler-output native smoke diagnostic

These modules select only an exact caller-pinned diagnostic tuple. Installed
production commands and tests continue to use the production loader. No installed
module imports this directory, and no environment variable enables this path.

The x64 compiler controller supplies its current Node executable hash and marks
that component `compiler-controller`; it does not claim to test the adapted Node
worker. The ARM portable harness supplies its already authenticated adapted Node
hash, marks it `adapted-worker`, and creates the Bash/MSYS pins only from its opaque
native-capture capability. Both pass a private context file and its exact SHA256
as child arguments. Ambient Bash discovery and fallback are absent. The diagnostic
rechecks Node identity and the complete Bash dependency set before every launch.

`command.cjs` and `probe.cjs` are derived from the frozen source at the commit in
`lineage.json`. `derive.py --check` checks original hashes and reconstructs all
reviewed changes: workflow import paths, explicit pinned selection, the additional
Node hash check, diagnostic identity, removal of the shared probe cache, bounded
Git-write observations, and retention after unconfirmed cleanup. Command recovery
and final cleanup preserve the primary error, annotate secondary cleanup failures,
and retain runtime roots when cleanup is unknown. Cleanup failure after confirmed
drain refuses success. The launcher,
resource leases, protected-root tests, IPv4/IPv6 denial tests, descendant handling,
positive job-drain checks and release ordering otherwise retain the source body.

The production test and dedicated diagnostic entry share
`tests/helpers/windows-bash-native-smoke.cjs`. Its original assertions remain
identical: prerequisite probe, scratch success, candidate/controller denial,
read-only mount table, real Bash IPC fixture and Node roundtrip. The one cleanup
change retains the root when the native launch reports unconfirmed cleanup or an
unresolved recovery journal. A source-preservation test covers the transformation.

A `.git` write failure now records whether the write actually succeeded or which
bounded errno occurred; only the original EACCES/EPERM results count as denial.
After the command returns with drain confirmed, the controller independently
records whether the guard is unchanged, changed or unreadable. No new errno is
accepted. These records diagnose a refusal; they do not authorize a runtime.

Run `node --test scripts/windows-msys/diagnostic-smoke/diagnostic-smoke.test.cjs`
and the existing compiler/portable harness suites. The actual entry uses
`node --test-reporter=tap native.cjs CONTEXT SHA256` without `--test`, preserving
context arguments while emitting strict TAP. The Linux source tests are not a
substitute for the next real Windows x64 and ARM diagnostics.
