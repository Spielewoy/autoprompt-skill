#!/usr/bin/env python3
"""Compile the actual patched initialization function against an API seam."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import tempfile


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def function(source):
    marker = 'void\ncygheap_user::init ()\n{'
    require(source.count(marker) == 1, 'Unique complete initialization function required')
    start = source.index(marker)
    return source[start:source.index('\n}\n', start) + 3]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path,
                        help='Optional exact, unpatched MSYS source directory')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    binding = json.loads((root / 'binding.json').read_text())
    patch = (root.parent / 'pipe-security.patch').read_bytes()
    require(sha(patch) == binding['patchSha256'], 'Combined patch binding changed')
    original = function((root / 'original-function.cc').read_text())
    require(sha(original.encode()) == binding['originalFunctionSha256'],
            'Original complete function binding changed')
    source_verified = False
    if args.source:
        source = (args.source / binding['sourcePath']).read_bytes()
        require(sha(source) == binding['sourceFileSha256'],
                'Complete upstream source file binding changed')
        require(function(source.decode()) == original,
                'Fixture differs from complete pinned source function')
        source_verified = True

    marker = 'diff --git a/winsup/cygwin/uinfo.cc b/winsup/cygwin/uinfo.cc\n'
    text = patch.decode()
    require(text.count(marker) == 1, 'Unique uinfo patch required')
    section = text.split(marker)[1].split('\ndiff --git ')[0]
    lines = section.splitlines(keepends=True)
    require(lines[:2] == ['--- a/winsup/cygwin/uinfo.cc\n',
                         '+++ b/winsup/cygwin/uinfo.cc\n'], 'Exact source paths required')
    require(len([line for line in lines if line.startswith('@@')]) == 1,
            'Exactly one initialization hunk required')
    match = re.fullmatch(r'@@ -(\d+),(\d+) \+(\d+),(\d+) @@\n', lines[2])
    require(match is not None, 'Exact unified hunk framing required')
    body = lines[3:]
    require(body and all(line[0] in ' +-' for line in body), 'Invalid patch body')
    before = ''.join(line[1:] for line in body if line[0] in ' -')
    after = ''.join(line[1:] for line in body if line[0] in ' +')
    require(len(before.splitlines()) == int(match[2]) and
            len(after.splitlines()) == int(match[4]), 'Hunk line counts differ')
    require(original.count(before) == 1, 'Hunk must match complete original function')
    candidate = original.replace(before, after)
    require(sha(candidate.encode()) == binding['candidateFunctionSha256'],
            'Candidate complete function binding changed')
    start = candidate.index('  /* The launcher supplies')
    end = candidate.index('  /* Set token owner')
    require(candidate[:start] + candidate[end:] == original,
            'Original host behavior changed outside the added guard')

    with tempfile.TemporaryDirectory(prefix='msys-token-default-') as directory:
        work = Path(directory)
        (work / 'contract.cc').write_text((root / 'contract-prefix.cc').read_text() +
                                        candidate + (root / 'contract-tests.cc').read_text())
        subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        '-o', str(work / 'contract'), str(work / 'contract.cc')], check=True)
        subprocess.run([str(work / 'contract')], check=True)
    print(json.dumps({'candidateFunctionSha256': binding['candidateFunctionSha256'],
                      'patchSha256': binding['patchSha256'],
                      'completeSourceVerified': source_verified,
                      'nativeWindowsExecuted': False}))


if __name__ == '__main__':
    main()
