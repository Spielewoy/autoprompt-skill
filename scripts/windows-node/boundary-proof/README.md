# Reproducible libuv boundary proof

Run with Python 3.10+, Git, and an explicitly selected GCC or Clang C compiler.
Provide either the already downloaded official archive identified by
`../build-lock.json`, or an extracted source tree containing its original
`deps/uv/src/win/pipe.c`. This driver performs no downloads.

From the repository root:

```sh
python3 scripts/windows-node/boundary-proof/run.py \
  --source /absolute/path/node-v24.20.0.tar.xz \
  --cc /usr/bin/gcc
```

For a source tree and a selected Clang:

```sh
python3 scripts/windows-node/boundary-proof/run.py \
  --source /absolute/path/node-v24.20.0 \
  --cc /absolute/path/clang \
  --git /absolute/path/git
```

Archive mode verifies the complete archive SHA256 before reading its unique
regular-file member. Tree mode verifies the exact original file SHA256; it
does not certify unrelated files in that tree. Both modes verify the patch,
apply it in a fresh temporary directory, and verify the resulting source.
Original inputs remain untouched. Only the four exact candidate function
bodies are extracted. The complete client creation function must remain
byte-for-byte equal to the original source.

The driver combines those functions with these reviewable mock boundaries,
compiles with warnings treated as errors, and requires all 26 cases. Generated
C bodies and executables exist only in the temporary directory. JSON output
records source, patch, function, mock, and compiler identities.

The cases cover:

- Original host naming and retry behavior, including more than eight retries.
- Flat AppContainer LOCAL naming, seven collisions then success, and refusal
  after eight access-denied or busy results.
- Actual-token query argument shape, bounded returned data, invalid flag values,
  open/query/close failures, error preservation, and per-pair fresh queries.
- Truncated names and maximum 64-bit sequence / 32-bit PID formatting.
- Read, write, and duplex client rights including `WRITE_DAC`, inheritance and
  NULL descriptor preservation, plus client and connection failure cleanup.

`DWORD` is explicitly 32 bits. The PID return mock uses the host `unsigned long`
type solely to match `%lu` varargs when compiling the unchanged function on an
LP64 host. No native Windows API executes here: `nativeWindows` is always false.
Actual AppContainer permission semantics, especially the full `WRITE_DAC`
request, still require the strict selected-worker Windows pipe/IPC tests.
