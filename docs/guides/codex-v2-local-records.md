# Codex v2 local run records

<!-- codex-v2-release-status: local-v1.0.28-build-not-published -->
> Release status: this guide describes the local Codex v1.0.28 build.
> The build has not been published as a package or release.

Codex v2 saves an exact local record so a run can be checked and resumed without
depending on conversation memory. The record can contain the ordered request,
attachments and application references, route messages, tool output, runtime state,
and checking evidence. Treat the whole record as potentially confidential.

## Local build route control

The optional `path=auto|direct|light|roadmap` control is present in the local v1.0.28
build and has not been published. Put it first in the Codex request
after `--`. Omitted `path=` and
`path=auto` run automatic route analysis and selection. `path=direct`, `path=light`,
and `path=roadmap` skip that model work and enter the exact named route. They do not
skip the local route record, safety or authority checks, required deliverables,
execution, or independent verification. Invalid, conflicting, or unusable values fail
closed without silently changing routes.

## Child-turn cost bounds

The local Codex launcher separates optional routing cost from required completion:

- Automatic route analysis runs at low effort, exposes no tools, has an 8,000-token
  provider envelope, and has a 60-second absolute watchdog. The following L0 route
  decision is deterministic local computation and consumes no provider tokens;
  injected external L0 turns are disabled, and legacy in-flight L0 continuations
  fail closed on adoption.
- Required workers and independent checkers have no hidden default activation-token,
  provider-spend, accepted-result, or tool-call ceiling. The admitted work graph is
  finite, and the prompts use eight worker calls and four checker calls as economical
  guidance, never as permission to abandon an unfinished required result.
- An embedding caller can still supply an explicit aggregate token budget or physical
  tool-call ceiling. Those explicit limits are enforced exactly, no over-limit child
  result is accepted, and a usable candidate is preserved when the supplied authority
  cannot fund further checking.
- Codex retains at most 1,000 tokens from each tool output in model context.

When an explicit tool ceiling exists, the owned process is stopped as soon as an
excess tool lifecycle item is observed. Provider lifecycle events can arrive after a
tool starts, so this boundary does not prove that the first excess tool did no work.
A private controlled model catalog forces Codex 0.148 into direct-tool mode, where
each permitted shell or patch call has its own lifecycle item. Required work retains
image inspection unless the caller installed an explicit physical tool ceiling;
unified exec remains disabled because its nested calls are not all exposed on the
public JSON lifecycle stream. The child MCP registry is forced empty, and the
isolated activation profile disables skills injection, apps, browser, plugins, web,
image generation, and multi-agent tools. PRE_ROUTE additionally disables shell,
patch, unified exec, and image inspection. The controlled provider sets request and
stream retries to zero.

A controller-owned loopback relay applies a preventive per-response token envelope
before each Responses API request. It computes a conservative input upper bound from
the exact UTF-8 request and injects `max_output_tokens` that fits both the controlled
272,000-token model context and any explicit remaining activation allowance. A
request that cannot fit an explicit allowance is refused before it reaches the
upstream provider. Each valid `response.completed` event is rewritten with total
input including cached input, then charged exactly once. Missing, malformed,
duplicate, truncated, or out-of-bound usage fails closed; a disconnected child
cancels its upstream request.

If a required default-budget request reached the provider but complete usage is
unavailable, the controller charges only that request's finite context-bound maximum
unaccounted allowance, releases the rest of the accounting-only reservation, and may
use exactly one fresh transport successor. Partial candidate bytes stay quarantined
until ownership validation. A second unknown provider response is not looped: its
exact safe candidate is preserved and surfaced for checking or as a concrete partial
result. Optional route analysis and explicitly budgeted work do not gain extra
authority from this successor rule.

There is no hidden second budget for verification and no hidden default budget that
can prevent a required checker from starting. Under an explicit caller budget, if
earlier exact usage leaves less than a later checker's conservative first-request
bound, the relay refuses that checker before any upstream call. It does not claim
that verification passed: it preserves the usable candidate as
`DONE_WITH_VERIFICATION_LIMITATIONS` with capability id
`autoprompt.independent-check-quota-envelope`. External independent checking or a
fresh activation with sufficient explicit authority is then required for acceptance.

Before the relay can send the first upstream byte, it durably records the request's
maximum unaccounted allowance. After a crash, exact request-bound usage is reconciled
without double charging; otherwise only that finite unresolved request allowance is
charged before resumed work is admitted. Explicit token acceptance limits remain
cumulative for an adopted child. Because a tool may start before its lifecycle event
is durable, a crash-adopted continuation under an explicit tool ceiling receives no
renewed allowance. Preventive guarantees depend on the upstream provider honoring
`max_output_tokens` and reporting truthful usage; a provider-side protocol violation
is stopped and rejected but cannot be retroactively unbilled by the local launcher.

`model_auto_compact_token_limit=32768` is separately configured to compact growing
context. Compaction is not a cumulative token or billing cap, and it must not be
presented as one.

## Where records are kept

The external Codex launcher currently creates its supervisor record in a
provider-private sidecar outside the target tree. The activation record's
`supervisorRuntime.runPath` is the authoritative location; the run's immutable
`metadata.json` repeats its `root_kind`, `root_path`, and `run_path`. Do not guess a
path or select a second sidecar root.

The lower-level run-record contract may use `<target>/.autoprompt/runs/<run-id>` only
for an eligible writable Git target. It adds `.autoprompt/` to the repository-local
`.git/info/exclude`, never to the committed `.gitignore`. Read-only, exact-tree,
package, non-Git, non-filesystem, unsafe-link, or otherwise ineligible targets use the
one provider-private sidecar instead.

On POSIX systems, private directories and files use `0700` and `0600`. On Windows,
the runtime applies and audits a protected owner-only DACL. Creation or reopening
fails closed if the private boundary cannot be established or has been widened. Run
records are rejected if they enter tracked files, staged files, a package, or an
archive boundary.

## Secret markers

The request envelope and route transcript scan exact bytes for likely credential
patterns. Markers record categories and event or block identifiers without copying
the detected value into marker metadata. Secret markers are advisory: they can miss
sensitive material and can report false positives. They do not redact or remove the
saved bytes. Review the exact content before any manual disclosure.

## Retention

Automatic deletion is disabled. The current metadata default is
`mode: explicit-local-policy` with `automatic_delete: false`; the versioned schema
also requires `automaticDeletionAllowed: false`. An `expiresAt` value is retention
metadata only: expiry is not deletion authority and does not start a deletion job.

Records therefore remain local until a user deliberately removes them or another
explicitly authorized lifecycle action removes their containing private directory.
Do not assume that finishing, revocation, age, an expiry value, update, or uninstall
is a retention promise. Before deleting a record, resolve the exact run path from its
activation record, verify that the path is the intended run, and decide whether any
required evidence must be kept. Deletion is outside the current Codex v2 run-record
command surface and may be unrecoverable.

## Export authority

There is no built-in export command. Automatic upload is disabled, and activation,
network access, permission to finish the task, or authority for an earlier transfer
does not authorize an export. Until an export mechanism can bind and record the
following instruction, Autoprompt must refuse the export:

1. The user names the exact run id and exact files, or explicitly says the complete
   run record.
2. The user names the destination and recipient or access boundary.
3. The user acknowledges that secret markers are advisory and that the selected
   exact files may contain unredacted requests, attachments, and tool output.
4. The authority applies to one transfer only. A retry, changed destination, added
   file, or added recipient requires a new instruction.

A user who still chooses to disclose data must do so manually outside Autoprompt
after reviewing `metadata.json`, `request/privacy.json`, the selected request objects,
and transcript sensitivity markers. Make a separate reviewed copy if redaction is
needed; never modify the authoritative local record to create an export.
