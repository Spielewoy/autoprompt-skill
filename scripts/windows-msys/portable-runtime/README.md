# Portable MSYS candidate transport

This module exports and imports **candidate bytes and provenance only**. It never
executes a binary, installs a worker, performs a sandbox probe, writes a successful
smoke receipt, or claims runtime acceptance. It is deliberately not a replacement
for the fresh native ARM64 mixed-tuple tests. Transport remains separate from runtime acceptance.

Files:

- `cli.cjs`: trusted-checkout, workflow-context command interface.
- `cli.test.cjs`: external context, checkout source and archive authority controls.
- `producer-context.cjs`: bounded current-run GitHub identity and owned tool receipts.
- `portable.cjs`: exporter/importer and closed manifest validation.
- `pe.cjs`: bounded PE dependency parser copied from the repository; only its error
  class was replaced by plain Error. The fixed candidate closure must import the
  exact observed pinned SDK dependency sets, with no ambient dependency search.
- `native-adapter.cjs`: trusted bridge to the existing native Windows physical
  capture proof, with caller-authorized helper source hashes and private ACLs.
- `portable.test.cjs`: synthetic PE fixtures and mutation/refusal cases. Synthetic
  bytes contain no executable code and are never launched.

## API and authority

```js
const { exportCandidate, importCandidate } = require('./portable.cjs')
const exported = await exportCandidate({ buildRoot, expected, destination: packetRoot, native })
const imported = await importCandidate({
  packetRoot,
  manifestSha256: exported.manifestSha256, // supplied by the trusted producer channel
  expected,
  destination: freshConsumerRoot,
  native,
})
```

`expected` is a trusted caller configuration, not data discovered from the packet.
It has exactly `bindings` and `producer`:

- `bindings`: sdkCommit, sourceCommit, sourceArchiveSha256, lockSha256, patchSha256,
  buildRecipeSha256, posixRecipeSha256, posixSourceSha256, gccSha256, linkerSha256,
  bootstrapRuntimeSha256, bashSha256.
- `producer`: repository, headSha, runId, runAttempt, jobId, architecture (`x64`).

Commits are lowercase SHA1 identifiers; all byte bindings use lowercase SHA256.
Producer identifiers must be matched by the eventual GitHub artifact downloader
against the intended repository, exact run/attempt/head and producer job. **This
module performs no network requests and cannot authenticate GitHub provenance.**
The downloader must retain the immutable artifact ID/digest and manifest hash as
external authority; reading an unknown manifest and adopting its hash is not
verification. Likewise, an `expected.linkerSha256` computed from arbitrary packet
contents is not external authority. Obtain it from the trusted builder/toolchain
selection, alongside its immutable before/after tool receipt.

The exporter reads the existing build root with exact fixed paths, including
pinned SDK Bash, staged MSYS DLL, POSIX fixture and source receipt. It requires:

1. Source archive hash, current SDK GCC/linker/bootstrap DLL hashes and exact
   source/SDK/recipe/patch bindings.
2. Identical two-entry `toolchain-inputs.sha256` and `toolchain-outputs.sha256`
   records for `/usr/bin/gcc.exe` and `/usr/bin/ld.exe`.
3. A bounded, syntactically validated staged checksum receipt whose selected
   required records match the DLL, lock, compiler/linker version files, installed
   package inventory and both tool receipts. Untransported staged files are not
   rehashed by this prototype; the packet inventory itself is closed and exact.
4. The exact x64 PE roles and expected import closure for Bash, MSYS and POSIX.

The original compiler uses other SDK tools and headers too. This packet is not
an independently reproducible/hermetic build attestation, and version strings are
not treated as compiler executable identity. Exact SDK/package authority remains
separate. The new before/after receipts are observed mutation checks, not a proof
that tool bytes could never change during compilation.

## Limits and physical capture

The packet has exactly nineteen fixed data files plus canonical `manifest.json`.
Each file is bounded to16MiB; aggregate bytes are bounded to32MiB. Metadata parsing
is bounded to1MiB where applicable. Relative names are lowercase portable paths;
traversal, absolute paths, alternate data streams, Windows device names, case
aliases, extra files, extra empty directories, symbolic links and hardlinks are
refused. Manifest JSON is canonical, including key order and terminal LF; duplicate
keys or alternate serialization are rejected before any destination is created.

Linux local tests perform bounded descriptor reads with identity/stat checks and
closed-tree rechecks. **That is not equivalent to a Windows physical lease.** On
Windows the caller must provide a trusted native adapter; it requires the existing
C# held-file lease and actual finish acknowledgement plus direct helper close,
with no test hooks. This is the diagnostic helper lifecycle; compiler descendant
containment is unproven, and helper close is not a whole-job drain claim.
The adapter must not originate in the downloaded packet. `native-adapter.cjs`
binds the trusted controller/ACL/C#/PowerShell sources and calls the existing
`captureForProof` implementation. Its32MiB/16MiB limits align with this prototype.
After capture returns, leases are closed; a later consumer must recapture and
revalidate before use. The receipt does not make paths permanently immutable.
All helper dependencies and the host process remain part of the trusted controller
codebase; module source hashes do not sandbox JavaScript imports.

Source files are copied from bounded snapshots on the trusted build host, then
the closed exported packet is physically recaptured. Import recaptures the entire
closed packet under the lease before writing immutable captured bytes into a
fresh private destination, and recaptures that output too. Neither operation
mutates source inputs or silently removes existing destinations. Failure after
creating an owned directory leaves it for inspection; unknown native cleanup
state propagates unchanged.

## Import receipt and integration gap

The fresh destination retains the original canonical manifest and original bytes,
then adds `import.json`. Its status is always `not-native-accepted`; its native
acceptance field is always `not-performed`. The receipt records the external
manifest hash and local process platform/architecture. Process architecture is
an observation only, not proof of native OS architecture.

No producer absolute paths are carried into the transport manifest. The importer
intentionally does **not** fabricate `built-runtime-manifest.json`, SDK checkout
metadata, or `built-runtime-proof.txt`. The repository's existing smoke/POSIX
probes still need a portable-input adapter that takes this validated packet and
runs fresh local native probes. A separate ARM64 Node candidate/provenance import
is also required. Current source requires the new toolchain receipts; olderCI19
artifacts lack them and cannot pass export by inventing records after the fact.

## Verification

```sh
node --test scripts/windows-msys/portable-runtime/*.test.cjs
```

The 35 transport tests cover successful bounded candidate transport; byte mutations;
source/producer substitution; rehashed malformed manifests; missing/duplicate and
unsafe paths; links, extras and empty directories; missing toolchain receipts;
changed source/compiler/linker bytes; and unexpected dynamic dependencies.
The exact PE role/import arrays were also checked against the retained realCI19
Bash, adapted MSYS DLL and POSIX executable:3/3 passed; raw identities remain in the local investigation evidence, outside this transport directory. This is static byte inspection, not native execution.
An additional 17 CLI tests check external context and archive authority. These tests do not perform native Windows execution or a real candidate export. Run the synthetic transport tests on Linux; they intentionally cannot substitute a fake native lease on Windows. Production integration and ARM compatibility remain pending.

## Diagnostic CLI

The CLI always requires native Windows and the actual held-file adapter. It never
executes the transported binaries. Both commands require a checkout whose HEAD
matches the producer head and whose tracked MSYS/native-capture sources have no
local changes. It hashes the reviewed source/recipes from that checkout, matching
the compiler's documented UTF-8/LF normalization; patch bytes must already use LF.

```text
node scripts/windows-msys/portable-runtime/cli.cjs export REPO BUILD_ROOT PRODUCER_CONTEXT_JSON NEW_PACKET
node scripts/windows-msys/portable-runtime/cli.cjs import REPO PACKET EXPECTED_CONTEXT_JSON NEW_DESTINATION
```

Context files must be generated by trusted workflow code and serialized with
`require('./portable.cjs').canonical(value)`. They are separate from the candidate
packet. The exporter context has exactly:

```js
{
  schema: 1,
  producer: {
    repository: 'owner/repository', headSha: '<40 lowercase hex>',
    runId: '<numeric GitHub run ID>', runAttempt: 1,
    jobId: '<numeric GitHub job ID>', architecture: 'x64'
  },
  observedTools: {
    linkerSha256: '<64 lowercase hex>',
    bootstrapRuntimeSha256: '<64 lowercase hex>'
  }
}
```

The job ID is the numeric API job ID, not GitHub's symbolic `github.job` value.
The workflow supplies linker/bootstrap observations from its owned build output,
checks identical before/after tool receipts, and authenticates repository/run/job
identity. The exporter independently checks those hashes against the actual
current tool bytes and the compiler receipts. These observed hashes are not an
independent SDK attestation. Source, compiler, SDK and Bash pins come from the
reviewed checkout. Stdout is one canonical JSON result containing `expected` and
`manifestSha256`; retain those through the trusted producer channel.

The importer context has exactly:

```js
{
  schema: 1,
  expected: /* trusted export result's exact authority object */,
  transport: {
    artifactId: '<immutable numeric GitHub artifact ID>',
    archivePath: '<absolute local downloaded archive path>',
    archiveSha256: '<externally expected 64 lowercase hex>',
    manifestSha256: '<externally expected 64 lowercase hex>'
  }
}
```

The importer hashes the actual archive (maximum 64 MiB), verifies the manifest
against the separately supplied hash and expected authority, and performs native
physical capture of the exact closed packet. It preserves artifact/archive
identity in stdout. This command does not authenticate GitHub or extract ZIPs:
the trusted downloader must authenticate the current run/head/attempt/producer,
select the immutable artifact ID, and safely extract the already authenticated
archive. Supplying an arbitrary archive and adopting the packet's own digest is
not authentication. A missing context field or mismatched byte fails before a
successful import result; destinations are never reused or silently deleted.

Import success still means `candidate-imported-not-accepted`. It creates no SDK
checkout, successful smoke receipt, native capability or worker admission. A
subsequent native consumer must recapture the candidate and run its own tests.

### Current workflow producer helper

```text
node scripts/windows-msys/portable-runtime/producer-context.cjs REPO BUILD_ROOT NEW_CONTEXT_JSON
```

Provide `GITHUB_TOKEN` through the workflow environment with `actions: read`.
The helper writes the context exclusively, refuses an existing file, and reports
only its path, digest and nonsecret producer identity. It never logs the token,
HTTP bodies, request headers or network exception details.

The helper accepts only the current branch's push/manual native Windows x64
`platform-primitives` job. It reads the declared GitHub repository, SHA, run and
attempt from the workflow environment, then checks them against the current run
API before and after querying attempt-specific jobs. Exactly one running job
must match `Platform and installer / windows-latest / Node 24.x`. Pagination is
limited to two 100-job pages, each response to 2 MiB, and each HTTPS request to a
10-second absolute deadline. Redirects are refused; requests go only to the
fixed `api.github.com` origin. No completed run or previous attempt is adopted.

It compares owned compiler/linker before-and-after receipts, reads the bootstrap
receipt, rehashes all three actual SDK tools, and checks the compiler against the
reviewed source lock before writing context. These remain trusted builder
observations. The 17 producer-helper tests exercise identity substitution,
pagination ambiguity and bounds, run changes, and tool/receipt mutations. The
[GitHub run-job API](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)
provides numeric job identity; this helper does not infer it from display text
without checking the authenticated current-run response.
