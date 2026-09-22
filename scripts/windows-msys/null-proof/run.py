#!/usr/bin/env python3
"""Compile the exact combined-patch Null helper; optionally verify pinned source integration."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--source', help='Prepared pinned source BEFORE the Null adapter; enables three additional source contracts')
parser.add_argument('--environ-source', help='Pristine pinned source for the supplied-only native NUL environment contract')
parser.add_argument('--cxx', default='g++')
args = parser.parse_args()
binding = json.loads((HERE / 'binding.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
patch = (HERE.parent / 'pipe-security.patch').read_bytes()
assert sha(patch) == binding['patchSha256']
marker = 'diff --git a/winsup/cygwin/sec/appcontainer_null.cc b/winsup/cygwin/sec/appcontainer_null.cc\n'
text = patch.decode()
assert text.count(marker) == 1
section = text.split(marker)[1].split('diff --git ')[0]
lines = section.splitlines(keepends=True)
hunks = [i for i, line in enumerate(lines) if line.startswith('@@ ')]
assert len(hunks) == 1 and '--- /dev/null\n' in lines
match = re.fullmatch(r'@@ -0,0 \+1,(\d+) @@\n', lines[hunks[0]])
added = lines[hunks[0] + 1:]
assert match and len(added) == int(match[1]) and all(line.startswith('+') for line in added)
helper = ''.join(line[1:] for line in added)
assert sha(helper.encode()) == binding['helperSha256']
env = {k: v for k, v in os.environ.items() if not k.upper().startswith('GIT_') and k.upper() not in
       {'CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'GCC_EXEC_PREFIX', 'COMPILER_PATH'}}
compiler = Path(shutil.which(args.cxx) or args.cxx).resolve(strict=True)

def run(command, cwd):
    result = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout

with tempfile.TemporaryDirectory(prefix='msys-null-proof-') as temporary:
    work = Path(temporary)
    empty = work / 'empty.gitconfig'
    empty.write_text('')
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(empty), GIT_CONFIG_SYSTEM=str(empty))
    # Windows WCHAR/DWORD layouts are intentional; this is still a local API
    # seam and makes no claim about native Windows object access checks.
    body = '\n'.join(line for line in helper.splitlines() if not line.startswith('#include'))
    code = '#include <initializer_list>\n' + (HERE / 'mock-prefix.cc').read_text() + body + '\n'
    code += (HERE / 'mock-query.cc').read_text() + (HERE / 'mock-tests.cc').read_text()
    (work / 'proof.cc').write_text(code)
    run([str(compiler), '-std=c++17', '-fshort-wchar', '-Wall', '-Wextra', '-Werror',
         '-Wno-unused-function', '-O2', 'proof.cc', '-o', 'proof'], work)
    result = json.loads(run([str(work / 'proof')], work))
    assert result == {'cases': 68, 'nativeWindows': False, 'wcharBytes': 2, 'dwordBytes': 4}
    result['sourceContracts'] = {'executed': False, 'reason': '--source not supplied'}
    (work / 'combined.patch').write_bytes(patch)
    if args.environ_source:
        environ_source = Path(args.environ_source).resolve(strict=True) / 'winsup/cygwin/environ.cc'
        original_environ = environ_source.read_bytes()
        assert sha(original_environ) == binding['originalEnvironSha256'], 'Pinned pre-locator environ.cc required'
        environ_output = work / 'winsup/cygwin/environ.cc'
        environ_output.parent.mkdir(parents=True)
        environ_output.write_bytes(original_environ)
        command = ['git', 'apply', '--whitespace=error', '--include=winsup/cygwin/environ.cc']
        run(command + ['--check', str(work / 'combined.patch')], work)
        run(command + [str(work / 'combined.patch')], work)
        candidate = environ_output.read_bytes()
        assert sha(candidate) == binding['candidateEnvironSha256']
        added = ('  /* The private NUL adapter reads the native environment after MSYS exec.\n'
                 '     Preserve a supplied locator; never synthesize the handle capability. */\n'
                 '  {NL ("AUTOPROMPT_PRIVATE_NUL_HANDLE="), false, true, NULL},\n')
        candidate_text = candidate.decode()
        assert candidate_text.count(added) == 1
        assert sha(candidate_text.replace(added, '').encode()) == binding['originalEnvironSha256']
        result['environContract'] = {'executed': True, 'passed': 1}
    else:
        result['environContract'] = {'executed': False, 'reason': '--environ-source not supplied'}
    if args.source:
        source = Path(args.source).resolve(strict=True)
        name = 'winsup/cygwin/fhandler/base.cc'
        original_bytes = (source / name).read_bytes()
        assert sha(original_bytes) == binding['originalBaseSha256'], 'Pinned pre-Null base.cc required'
        output = work / name
        output.parent.mkdir(parents=True)
        output.write_bytes(original_bytes)
        command = ['git', 'apply', '--whitespace=error', '--include=' + name]
        run(command + ['--check', 'combined.patch'], work)
        run(command + ['combined.patch'], work)
        base = output.read_text()
        assert sha(output.read_bytes()) == binding['candidateBaseSha256']
        original = original_bytes.decode()
        normalized = base.replace('#include "appcontainer_null.h"\n', '').replace('  HANDLE fh = NULL;', '  HANDLE fh;')
        normalized = normalized.replace('  NTSTATUS status = STATUS_UNSUCCESSFUL;\n  DWORD null_error = 0;', '  NTSTATUS status;')
        for start, end in [('fhandler_base::open_null (', '/* Open system call handler function. */'),
                           ('fhandler_base::open (', 'fhandler_base::fd_reopen (')]:
            old = original[original.index(start):original.index(end, original.index(start))]
            call = re.search(r'  status = NtCreateFile \(&fh,[\s\S]*?;', old).group(0)
            pattern = r'  if \((?:appcontainer_null_open|get_device \(\) == FH_NULL)[\s\S]*?\n  else\n    status = NtCreateFile \(&fh,[\s\S]*?;'
            normalized, count = re.subn(pattern, lambda _: call, normalized, count=1)
            assert count == 1
        assert normalized == original, 'Original host/absent capability path changed'
        assert 'flags & O_CLOEXEC,\n                              &null_error)' in base
        assert 'void set_unique_id () { NtAllocateLocallyUniqueId ((PLUID) &unique_id); }' in (source / 'winsup/cygwin/local_includes/fhandler.h').read_text()
        result['sourceContracts'] = {'executed': True, 'passed': 3}
    result.update(patchSha256=sha(patch), helperSha256=sha(helper.encode()), compilerSha256=sha(compiler.read_bytes()))
    print(json.dumps(result, indent=2))
