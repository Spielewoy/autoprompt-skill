# Codex v2 local run records

<!-- codex-v2-release-status: local-v1.0.26-build-not-published -->
> Release status: this guide describes the local Codex v1.0.26 build.
> The build has not been published as a package or release.

Codex v2 saves an exact local record so a run can be checked and resumed without
depending on conversation memory. The record can contain the ordered request,
attachments and application references, route messages, tool output, runtime state,
and checking evidence. Treat the whole record as potentially confidential.

## Local build route control

The optional `path=auto|direct|light|roadmap` control is present in the local v1.0.26
build and has not been published. Put it first in the Codex request
after `--`. Omitted `path=` and
`path=auto` run automatic route analysis and selection. `path=direct`, `path=light`,
and `path=roadmap` skip that model work and enter the exact named route. They do not
skip the local route record, safety or authority checks, required deliverables,
execution, or independent verification. Invalid, conflicting, or unusable values fail
closed without silently changing routes.

## Child-turn cost bounds

The local Codex launcher bounds child turns independently of conversation context.
All counts below include noncached input, cached input, and output:

- One activation has a 24,000-token aggregate provider envelope by default. Before
  any child starts, the controller reserves its complete worst-case allowance;
  consumed tokens plus every concurrent live reservation never exceed 24,000.
- Automatic route analysis runs at low effort and exposes no tools. Its
  provider request envelope is at most 16,000 tokens, and a result above 8,000 reported tokens is rejected.
  The following L0 route decision is deterministic local
  computation and consumes no provider tokens; injected external L0 turns are
  disabled, and legacy in-flight L0 continuations fail closed on adoption.
- Each independent checker can invoke at most 2 tools. Its provider request envelope
  is at most 24,000 tokens, and a result above 16,000 reported tokens is rejected.
- Each worker can invoke at most 2 tools. Its provider request envelope and accepted
  result are both capped at 24,000 reported tokens.
- Codex retains at most 1,000 tokens from each tool output in model context.

The owned process is stopped as soon as an excess tool lifecycle item is observed,
and no over-limit child result is accepted. Provider lifecycle events can arrive
after a tool starts, so this boundary does not prove that the first excess tool did
no work. A private controlled model catalog forces Codex 0.148 into direct-tool mode,
where each permitted shell or patch call has its own lifecycle item. Unified exec and
image view are disabled because their nested calls are not all exposed on the public
JSON lifecycle stream. The child MCP registry is forced empty, and the isolated
activation profile disables skills injection, apps, browser, plugins, web, image
generation, and multi-agent tools. PRE_ROUTE additionally disables shell and patch
tools. The controlled provider sets request and stream retries to zero.

A controller-owned loopback relay applies the preventive token envelope before each
Responses API request. It computes a conservative input upper bound from the exact
UTF-8 request, subtracts prior exact cumulative usage and all activation reservations,
and injects the remaining `max_output_tokens`. A request that cannot fit is refused
before it reaches the upstream provider. Each valid `response.completed` event is
rewritten with total input including cached input for Codex's native rollout fallback,
then charged to the activation. Missing, malformed, duplicate, truncated, or
out-of-bound usage fails closed; a disconnected child cancels its upstream request.
A provider failure without complete usage is never automatically relaunched. If the
request already reached the upstream provider, the controller charges the entire
unused child reservation as an unknown-spend upper bound before releasing the child.
For example, an unaccountable 16,000-token route attempt leaves at most 8,000 tokens
for all later work in the same default activation.

The aggregate cap does not reserve a hidden second budget for verification. If
earlier exact usage leaves less than a later checker's conservative first-request
bound, the relay refuses that checker before any upstream call. The controller does
not retry the unaffordable request or claim that verification passed: it preserves
the usable candidate as `DONE_WITH_VERIFICATION_LIMITATIONS` with capability id
`autoprompt.independent-check-quota-envelope`. An external independent check or an
explicitly larger fresh activation is required for acceptance authority.

Before the relay can send the first upstream byte, it durably records the request's
maximum unaccounted allowance. After a crash, exact request-bound usage is reconciled
without double charging; otherwise the full unresolved allowance is charged before
any resumed work is admitted. Token acceptance limits remain cumulative for an
adopted child. Because a tool may start before its lifecycle event is durable, a
crash-adopted open continuation receives no renewed tool-call allowance.

The 8,000/16,000/24,000 result limits are stricter acceptance and immediate-stop
boundaries after each accounted provider response. The 16,000/24,000/24,000 request
envelopes are the preventive spend layer. Those preventive guarantees depend on the
upstream provider honoring `max_output_tokens` and reporting truthful usage; a
provider-side protocol violation is stopped and rejected but cannot be retroactively
unbilled by the local launcher.

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
