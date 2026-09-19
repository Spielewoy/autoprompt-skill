# Native ARM64 diagnostic consumer

This code authenticates candidate transport and runs fresh diagnostics. It does
not install a runtime, select a production worker, or issue platform acceptance.
A successful component proof is retained separately from the overall platform
job, which can still fail.

## Current workflow entry point

Run only in the native ARM64 `platform-primitives` job on
`codex/issue-27-native-platform-support`, after that lane's local precompiled
capture helper has passed all seven native cases:

```powershell
$controller = (Get-Command node -ErrorAction Stop).Source
$controllerHash = (Get-FileHash -LiteralPath $controller -Algorithm SHA256).Hash.ToLowerInvariant()
python scripts/windows-msys/portable-consumer/run.py `
  --repo $PWD.Path `
  --output (Join-Path $env:RUNNER_TEMP 'portable-arm-consumer') `
  --controller $controller --controller-sha256 $controllerHash `
  --helper-directory (Join-Path $env:RUNNER_TEMP 'precompiled-capture')
```

Supply the workflow token through `GITHUB_TOKEN` with `actions: read`. The script
checks the current GitHub repository, head, run, attempt, branch and ARM runner
role, plus a clean reviewed checkout. Its default artifact deadline is 2400
seconds; `--artifact-timeout` must be between 1 and 3600. It creates only fresh
output roots and retains them when failure or cleanup is uncertain.

The sequence is:

1. Verify the local helper build against the exact current checkout source bytes
   and its seven-case native TAP. Its executable identity remains a trusted local
   builder observation, not candidate-provided authority.
2. Poll for the exact current-run MSYS artifact name. Authenticate its immutable
   numeric ID, GitHub archive SHA, repository/head/attempt and producer identity.
3. Download the separately pinned historical CI20 ARM64 Node component and verify
   its executable, source provenance and retained native proof.
4. Run all four Node stdio/IPC modes again on this consumer host, requiring the
   strict five-test proof with no skips and positive drain/cleanup. This fresh
   proof digest is recorded in the later mixed tuple.
5. Use the existing portable import CLI to obtain an actual native held-file
   capture and a fresh local import receipt.
6. Run `portable-probe/run.cjs` with the adapted ARM64 Node and authenticated x64
   Bash/MSYS fixture bytes. It rechecks actual native OS architecture, runs a
   fresh Bash smoke, then the preserved POSIX/cancellation diagnostics.

Native stage output is bounded to 12 MiB. An outer timeout or output failure
retains the diagnostic root and reports unknown cleanup; it never manufactures
a successful drain. Mixed-probe progress is streamed while being retained. Failures identify a fixed
consumer stage and code-owned validation reason; external HTTP/URL/subprocess
exception text is withheld. The private writer reports only a fixed phase, known error
code, helper phase and bounded exit status. Preserve the outer console in a sibling
workflow log as well: an early refusal may leave the private output root empty.

## Authority and archive validation

The MSYS expectation comes from trusted current workflow metadata, never a packet
manifest. GitHub's artifact API does not expose `job_id` or `run_attempt`, so the
consumer joins the exact attempt's unique producer job, successful compile/export/
upload steps, immutable name containing head and attempt, artifact creation time,
repository/head/run metadata and the producer context inside the independently
hash-verified archive. This relies on the reviewed workflow being the sole writer
of its exact artifact name; it is not a hermetic compiler attestation.

The poller never chooses `latest`, another head or a previous attempt. Failed,
cancelled or skipped producer components abort promptly. Metadata inventories
are capped at 100 jobs/artifacts (the current workflow has 20 jobs).

`node-arm64-ci20.json` deliberately names historical CI20 run 35231596403 and
artifact 10504040551 separately. Its original native four-mode proof passed, while
its overall platform job failed later. These component bytes are inputs to the
new diagnostic, not proof that the mixed tuple works.

HTTPS metadata goes only to `api.github.com`; the credential is never forwarded
to storage. Artifact redirects are restricted to HTTPS
`productionresultssa*.blob.core.windows.net`, and storage redirects are refused.
API bodies are capped at 2 MiB, ZIPs at 64 MiB, decoded files at 128 MiB, total
archive content at 256 MiB, and entries at 96. Socket reads have a ten-second
bound, plus a 20/90-second response deadline; one blocked socket read can extend
that deadline by at most its socket timeout.

Before any file is written, the complete ZIP digest must match the independently
selected GitHub digest. Decoding rejects traversal, ADS, Windows device names,
case aliases, duplicate paths, links/reparse entries, nonregular files, directory
collisions, encryption, unsupported compression and archive comments. CRC and
size checks apply. Empty diagnostic logs are valid, but selected runtime and proof
files have separate exact hashes. The historical Node archive file set is pinned.
MSYS producer context/result and manifest form a closed archive inventory; the
native import CLI subsequently checks every packet hash and PE dependency.

Context and manifest JSON are canonical. The outer `producer-result.json` alone
permits the known PowerShell LF/CRLF conversion. No producer absolute path becomes
execution authority. The consumer does not fabricate SDK checkout metadata or
producer smoke files for the old SDK-based probes.

## Private Windows materialization

`native-writer.cjs` receives authenticated bytes through bounded framing. A trusted
caller pins the absolute controller executable, writer script and reviewed
`safe-run-root.js`. The writer requires actual Windows, calls the existing
`ensureWindowsPrivateAcl` on an empty fresh root before writing artifact contents,
and creates all descendants in that same Node process. This preserves the token
owner adjustment established by that helper; a separate Python writer would not
inherit it. `NODE_OPTIONS`, `NODE_PATH`, tokens and ambient search paths are not
passed to the writer.

Python checks physical ancestors, lstat reparse attributes, single-link regular
files, stable identities and final bytes. The writer returns only
`private-native-materialization-not-held-capture`. Actual held capture remains
the native importer's job. Local/Linux path checks are not called native leases.

For the lower-level transport CLI, provide `--native-writer-context FILE` on
Windows. That file has exactly `repoRoot`, `controllerPath`,
`controllerSha256`, `aclSha256`, and `writerSha256`, selected by trusted workflow
code rather than downloaded metadata. Direct source-authority evaluation uses an
explicit absolute `NODE_BINARY` plus `NODE_BINARY_SHA256` if no writer context is
provided.

## Verification and current evidence

```sh
python3 -m unittest discover -s scripts/windows-msys/portable-consumer -p 'test_*.py' -v
node --test scripts/windows-msys/portable-consumer/native-writer.test.cjs
```

Metadata fixtures retain bounded fields from the authenticated CI20 API, including
all 20 job IDs/names. Executable fixtures in unit tests are explicitly synthetic
nonexecutable strings. Tests require neither a persistent investigation cache nor
large binaries. Negative host guards refuse native execution on non-Windows.

The outside prototype downloaded the actual ARM64 artifact through its own API/
storage path and verified SHA256
`71d51c5b83530ed310cf350a5691853124cc9958712b89bf8a4a37311f240a95`
(36,787,200 bytes, 36 regular entries). Its selected executable/provenance/proof
also passed the current strict Node stage verifier. That rechecks retained CI20
evidence. The integrated consumer also resolved and downloaded actual CI22 MSYS
artifact 10587260646 through its own exact-run poller and API transport: 2,996,835
bytes, 22 regular entries, archive SHA256
`9dce1b13c260eae2046ceed97e853fb5c03c993f85589a68ca28d38581b26abd`.
Its closed producer/manifest authority matched the reviewed checkout. This was
transport/source verification on Linux; the Windows writer and complete native
ARM consumer still require their first live run.
