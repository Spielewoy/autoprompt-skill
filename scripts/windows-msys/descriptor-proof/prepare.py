#!/usr/bin/env python3
"""Extract exact helper bytes from the bound reviewed patch; never alter repository files."""
import hashlib
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
BINDING = json.loads((HERE / 'binding.json').read_text())
def sha(data): return hashlib.sha256(data).hexdigest()
def require(ok, why):
    if not ok: raise RuntimeError(why)
def extract_new_file(patch, name):
    marker = f'diff --git a/{name} b/{name}\n'
    require(patch.count(marker) == 1, 'exact patch file section required')
    part = patch.split(marker, 1)[1].split('\ndiff --git ', 1)[0]
    lines = part.splitlines(keepends=True)
    require('new file mode 100644\n' in lines and '--- /dev/null\n' in lines, 'new file required')
    hunks = [i for i, line in enumerate(lines) if line.startswith('@@ ')]
    require(len(hunks) == 1, 'exactly one complete new-file hunk required')
    index = hunks[0]
    match = re.fullmatch(r'@@ -0,0 \+1,(\d+) @@\n', lines[index])
    require(match is not None, 'complete new-file hunk header required')
    body = lines[index + 1:]
    require(len(body) == int(match[1]) and all(line.startswith('+') for line in body), 'complete added lines required')
    return ''.join(line[1:] for line in body).encode('utf-8')

def main():
    require(len(sys.argv) == 3, 'usage: prepare.py REPOSITORY NEW_OUTPUT_DIRECTORY')
    repository = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2]).absolute()
    require(not output.exists(), 'output must be a fresh owned directory')
    patch = (repository / 'scripts/windows-msys/pipe-security.patch').read_bytes()
    lock_bytes = (repository / 'scripts/windows-msys/build-lock.json').read_bytes()
    fixture = (HERE / 'descriptor-proof.cc').read_bytes()
    require(sha(patch) == BINDING['patchSha256'], 'reviewed patch digest mismatch')
    require(sha(fixture) == BINDING['fixtureSha256'], 'reviewed fixture digest mismatch')
    lock = json.loads(lock_bytes)
    require(lock['source']['commit'] == BINDING['sourceCommit'] and lock['sdk']['commit'] == BINDING['sdkCommit'], 'pinned source/SDK mismatch')
    source = extract_new_file(patch.decode('utf-8'), 'winsup/cygwin/sec/appcontainer_pipe.cc')
    header = extract_new_file(patch.decode('utf-8'), 'winsup/cygwin/local_includes/appcontainer_pipe_security.h')
    require(sha(source) == BINDING['helperSha256'] and sha(header) == BINDING['headerSha256'], 'helper digest mismatch')
    old = b'#include "winsup.h"\n'
    new = b'#include <windows.h>\n'
    require(source.count(old) == 1, 'one exact platform umbrella include required')
    standalone = source.replace(old, new)
    require(sha(standalone) == BINDING['standaloneHelperSha256'], 'single-include transformation mismatch')
    output.mkdir(mode=0o700)
    files = {'appcontainer_pipe.cc': standalone, 'appcontainer_pipe_security.h': header, 'descriptor-proof.cc': fixture}
    for name, data in files.items():
        with (output / name).open('xb') as target: target.write(data)
    record = {**BINDING, 'lockSha256': sha(lock_bytes), 'transformation': 'Replace exactly one winsup.h include with windows.h; all other helper/header bytes unchanged', 'generated': {name: sha(data) for name, data in files.items()}, 'nativeCompile': 'pending', 'nativeExecution': 'pending'}
    with (output / 'source-binding.json').open('x') as target: json.dump(record, target, indent=2); target.write('\n')
    print(json.dumps(record, indent=2))
if __name__ == '__main__': main()
