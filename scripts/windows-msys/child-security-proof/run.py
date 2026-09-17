#!/usr/bin/env python3
"""Compile exact child adapter and both actual patched callsites with API seams.

This tests local C++ control flow, pointer lifetime, errors and call arguments.
It does not claim native Windows ACL enforcement or whole-MSYS compilation.
"""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
patch = (HERE.parent / 'pipe-security.patch').read_bytes()
binding = json.loads((HERE.parent / 'descriptor-proof/binding.json').read_text())
assert hashlib.sha256(patch).hexdigest() == binding['patchSha256']
text = patch.decode()

def section(name):
    marker = f'diff --git a/{name} b/{name}\n'
    assert text.count(marker) == 1
    return text.split(marker)[1].split('\ndiff --git ')[0]

part = section('winsup/cygwin/local_includes/appcontainer_child_security.h')
body = ''.join(line[1:] for line in part.splitlines(keepends=True) if line.startswith('+') and not line.startswith('+++'))
assert body.count('#include "appcontainer_pipe_security.h"\n') == 1
# Replace only its dependency include with the test API seam. The adapter body
# itself, including its scope/destruction and error handling, is unmodified.
body = body.replace('#include "appcontainer_pipe_security.h"\n', '')
callsite = []
for name in ['fork.cc', 'spawn.cc']:
    part = section('winsup/cygwin/' + name)
    after = ''.join(line[1:] for line in part.splitlines(keepends=True)
                    if line.startswith(('+', ' ')) and not line.startswith('+++'))
    begin = after.index('rc = appcontainer_child_create (sa,')
    end = after.index('});', begin) + 3
    callsite.append(after[begin:end])
    # No changed target-token path or unrelated source callsites.
    assert 'CreateProcessAsUser' not in part
    assert part.count('+      rc = appcontainer_child_create') + part.count('+\t  rc = appcontainer_child_create') == 1

with tempfile.TemporaryDirectory(prefix='msys-child-security-proof-') as folder:
    folder = Path(folder)
    source = (HERE / 'contract.cc').read_text()
    source = source.replace('/* EXACT_ADAPTER */', body)
    source = source.replace('/* EXACT_FORK_CALL */', callsite[0])
    source = source.replace('/* EXACT_SPAWN_CALL */', callsite[1])
    (folder / 'contract.cc').write_text(source)
    subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    str(folder / 'contract.cc'), '-o', str(folder / 'contract')], check=True, timeout=60)
    subprocess.run([str(folder / 'contract')], check=True, timeout=15)
print('Exact child adapter SHA256:', hashlib.sha256(body.encode()).hexdigest())
print('Native Windows ACL checks and full MSYS compilation remain required.')
