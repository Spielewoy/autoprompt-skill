#!/usr/bin/env python3
"""Compile the exact added anonymous-pipe functions from the reviewed patch."""
from pathlib import Path
import hashlib
import subprocess
import tempfile
def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


BASE = Path(__file__).resolve().parent
patch = (BASE.parent / 'pipe-security.patch').read_bytes()
require(hashlib.sha256(patch).hexdigest() == 'd79dab618fa0b0336320d5f2e80310567349f0b452d70fac45ae2da06e918be2',
        'Reviewed patch digest mismatch')
section = patch.decode().split('diff --git a/winsup/cygwin/kernel32.cc b/winsup/cygwin/kernel32.cc\n', 1)[1].split('\ndiff --git ', 1)[0]
start = section.index('+/* CreatePipe chooses')
end = section.index(' /* Implement CreateEvent/OpenEvent', start)
added = section[start:end].splitlines(keepends=True)
require(bool(added) and all(line.startswith('+') for line in added),
        'Anonymous implementation must contain only added source lines')
body = ''.join(line[1:] for line in added)
require(hashlib.sha256(body.encode()).hexdigest() == '1f92812b24be09fc13d134b52f1fe04e935f6432698b63cb8e539e2d43b93eca',
        'Reviewed anonymous implementation digest mismatch')
with tempfile.TemporaryDirectory(prefix='msys-anonymous-proof-') as folder:
    folder = Path(folder)
    source = folder / 'proof.cc'
    source.write_text((BASE / 'prefix.cc').read_text() + body + (BASE / 'suffix.cc').read_text())
    subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(folder / 'proof')], check=True, timeout=60)
    subprocess.run([str(folder / 'proof')], check=True, timeout=15)
print('Exact patch function digest verified; native Windows execution remains required.')
