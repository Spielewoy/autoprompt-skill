#!/usr/bin/env python3
"""Compile the exact added anonymous-pipe functions from the reviewed patch."""
from pathlib import Path
import hashlib
import re
import subprocess
import tempfile
def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


BASE = Path(__file__).resolve().parent
patch = (BASE.parent / 'pipe-security.patch').read_bytes()
require(hashlib.sha256(patch).hexdigest() == '06fa1606ee05e3e411d1d9a00a5ad6c728bd033388cfb98efedefe82b2bce541',
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
pty = patch.decode().split('diff --git a/winsup/cygwin/fhandler/pty.cc b/winsup/cygwin/fhandler/pty.cc\n', 1)[1].split('\ndiff --git ', 1)[0]
declarations = re.findall(r'^\+(  HANDLE hr[^\n]+)\n', pty, re.M)
calls = re.findall(r'^\+(      hr = hw = NULL;\n)\+(      if \(!appcontainer_create_pipe \(&hr, &hw, &sec_none, 0\)\)\n)\+(\tgoto cleanup_event_and_pipes;\n)', pty, re.M)
require(len(declarations) == 1 and len(calls) == 1, 'Exactly one reviewed PTY declaration and initialized callsite required')
# Reproduce the original function's early forward goto and cleanup outside its
# do-scope, using the exact changed declaration/callsite from the bound patch.
# Unrelated ConPTY setup is deliberately omitted; this is a C++ scope and
# failure-output regression, not compilation of the full Windows translation unit.
flow = '''#include <cstddef>
#include <cstdlib>
using HANDLE = void *;
static int calls, closed;
static bool succeeds;
static int sec_none;
static bool appcontainer_create_pipe(HANDLE *read, HANDLE *write, int *, int) {
  ++calls;
  if (*read != NULL || *write != NULL) std::abort();
  if (!succeeds) return false;
  *read = &calls; *write = &closed; return true;
}
static bool exercise(bool existing) {
  if (existing) goto skip_create;
DECLARATION
  do {
CALLSITE
    if (hr != &calls || hw != &closed) std::abort();
  } while (false);
skip_create:
  return true;
cleanup_event_and_pipes:
  if (hr != NULL || hw != NULL) std::abort();
  ++closed;
  return false;
}
int main() {
  if (!exercise(true) || calls || closed) return 1;
  if (exercise(false) || calls != 1 || closed != 1) return 2;
  succeeds = true;
  if (!exercise(false) || calls != 2 || closed != 1) return 3;
}
'''.replace('DECLARATION', declarations[0]).replace('CALLSITE', ''.join(calls[0]))
with tempfile.TemporaryDirectory(prefix='msys-anonymous-proof-') as folder:
    folder = Path(folder)
    source = folder / 'proof.cc'
    source.write_text((BASE / 'prefix.cc').read_text() + body + (BASE / 'suffix.cc').read_text())
    subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(folder / 'proof')], check=True, timeout=60)
    subprocess.run([str(folder / 'proof')], check=True, timeout=15)
    control = folder / 'pty-scope.cc'
    control.write_text(flow)
    subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror', str(control), '-o', str(folder / 'pty-scope')], check=True, timeout=60)
    subprocess.run([str(folder / 'pty-scope')], check=True, timeout=15)
    control.write_text(flow.replace(declarations[0], '  HANDLE hr = NULL, hw = NULL;'))
    failed = subprocess.run(['g++', '-std=c++17', '-fsyntax-only', str(control)], capture_output=True, text=True, timeout=60)
    require(failed.returncode != 0 and 'skip_create' in failed.stderr and 'crosses initialization' in failed.stderr,
            'Historical PTY initialized-declaration regression must fail compilation')
print('PTY scope: early reuse, pipe failure, success and historical compile-failure control passed.')
print('Exact patch function digest verified; native Windows execution remains required.')
