# Fork memory diagnostic

This manual-only diagnostic materializes the authenticated bundled Windows
worker tuple and derives copies of the AppContainer launcher and mapping
controller. The production sources and bundled runtime stay unchanged. The
derived launcher adds `DEBUG_PROCESS`, pumps debug events on the creating
thread, and scans only Cygwin's fixed cygheap interval
`[0x800000000, 0xa00000000)` before continuing each process-create and
DLL-load event.

The command is:

```
node scripts/windows-msys/fork-memory-diagnostic/run.cjs REPO NEW_OUTPUT
```

It requires Windows x64, Node 24, Python, Windows PowerShell, and a configured
bundled worker. The fixed workload performs 256 iterations without accepting
or hiding Bash retry diagnostics. Output is bounded to 65,536 debug events,
2,048 processes, 4,096 distinct occupied spans, and one MiB of span records.
Only numeric memory metadata and file IDs are retained; paths and memory bytes
are excluded. The report always has `accepted:false`. A query error, overflow,
missing failing PID, or missing process-create span is explicitly
inconclusive. Cleanup still requires the original job drain and profile
deletion proof.
