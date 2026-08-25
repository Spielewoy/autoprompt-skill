# Codex v2 local run records

<!-- codex-v2-release-status: local-v1.0.13-build-not-published -->
> Release status: this guide describes the local Codex v1.0.13 build.
> The build has not been published or pushed.

Codex v2 saves an exact local record so a run can be checked and resumed without
depending on conversation memory. The record can contain the ordered request,
attachments and application references, route messages, tool output, runtime state,
and checking evidence. Treat the whole record as potentially confidential.

## Local build route control

The optional `path=auto|direct|light|roadmap` control is present in the local v1.0.13
build and has not been published. Put it first in the Codex request
after `--`. Omitted `path=` and
`path=auto` run automatic route analysis and selection. `path=direct`, `path=light`,
and `path=roadmap` skip that model work and enter the exact named route. They do not
skip the local route record, safety or authority checks, required deliverables,
execution, or independent verification. Invalid, conflicting, or unusable values fail
closed without silently changing routes.

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
