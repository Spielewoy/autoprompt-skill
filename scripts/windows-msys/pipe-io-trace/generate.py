#!/usr/bin/env python3
"""Generate a separate base-plus-instrumentation patch; never edit input source."""
import difflib, hashlib, json, pathlib, re, shutil, subprocess, sys, tempfile
HERE = pathlib.Path(__file__).resolve().parent
BASE = '8bc01e2694245b271699128399aba48777fa44b878376ee9d84b82b8929eea87'
SOURCE = '270ba2980700e6e2a0813944d506eecea0f86402'
SOURCE_PINS = {'winsup/cygwin/fhandler/pipe.cc': 'af33c5fde35c35e8de9104cd51e7cdc60e9984c54b779875d7f7f1c5fc5fbb99', 'winsup/cygwin/cygwait.cc': '921b698deb9c2fa02f5b2894e78d570e1bd35c0245458c7d9bb561ee7cd5b95f'}

def sha(data): return hashlib.sha256(data).hexdigest()
def git(root, *args):
    subprocess.run(['git', '-C', str(root), *args], check=True, stdout=subprocess.DEVNULL)
def once(text, old, new):
    if text.count(old) != 1: raise ValueError('Expected one source anchor: ' + repr(old))
    return text.replace(old, new)
def after(text, anchor, record): return once(text, anchor, anchor + record)
def write(path, text): path.write_bytes(text.encode('utf-8'))
def main(args):
    if len(args) != 3: raise ValueError('PRISTINE_SOURCE BASE_PATCH NEW_OUTPUT')
    src, base, out = [pathlib.Path(p).resolve() for p in args]
    base_bytes = base.read_bytes()
    if sha(base_bytes) != BASE: raise ValueError('base patch identity')
    for name, digest in SOURCE_PINS.items():
        if sha((src/name).read_bytes()) != digest: raise ValueError('pristine source identity: ' + name)
    out.mkdir(exist_ok=False)
    with tempfile.TemporaryDirectory(prefix='pipe-io-trace-') as temporary:
        work = pathlib.Path(temporary)/'source'
        shutil.copytree(src, work, ignore=shutil.ignore_patterns('.git'))
        git(work, 'init'); git(work, 'config', 'core.autocrlf', 'false'); git(work, 'config', 'core.symlinks', 'true')
        git(work, 'apply', '--check', str(base)); git(work, 'apply', str(base))
        paths = set(re.findall(r'^\+\+\+ b/(.+)$', base_bytes.decode(), re.M))
        names = ['winsup/cygwin/fhandler/pipe.cc', 'winsup/cygwin/cygwait.cc']
        adapted = {name: (work/name).read_bytes() for name in names}
        text = adapted[names[0]].decode()
        text = once(text, '#include <assert.h>\n', '#include <assert.h>\n#include "ntdll.h"\n#include "pipe_io_trace.h"\n')
        start = text.index('void\nfhandler_pipe::raw_read ('); end = text.index('\nssize_t\nfhandler_pipe_fifo::raw_write (', start)
        read = text[start:end]
        read = once(read, '  DWORD waitret = cygwait (pipe_mtx, timeout);\n', '  autoprompt_pipe_trace ("read-enter", get_handle (), pipe_mtx, (ULONG) len, 0);\n  DWORD waitret = cygwait (pipe_mtx, timeout);\n  autoprompt_pipe_trace ("read-wait", get_handle (), pipe_mtx, waitret, GetLastError ());\n')
        read = after(read, '\t\t\t\t       FilePipeLocalInformation);\n', '      autoprompt_pipe_trace ("read-query", get_handle (), pipe_mtx, status, NT_SUCCESS (status) ? fpli.NamedPipeState : 0xffffffff);\n')
        read = after(read, '\t\t\t   len1, NULL, NULL);\n', '      autoprompt_pipe_trace ("read-nt", get_handle (), pipe_mtx, status, (status == STATUS_SUCCESS || status == STATUS_BUFFER_OVERFLOW) ? (ULONG) io.Information : 0xffffffff);\n')
        read = after(read, '\t      waitret = cygwait (select_sem, select_sem_timeout);\n', '\t      autoprompt_pipe_trace ("read-select", select_sem, get_handle (), waitret, GetLastError ());\n')
        text = text[:start] + read + text[end:]
        start = text.index('ssize_t\nfhandler_pipe_fifo::raw_write ('); end = text.index('\nvoid\nfhandler_pipe::fixup_after_fork', start)
        chunk = text[start:end]
        chunk = once(chunk, '      DWORD waitret = cygwait (pipe_mtx, timeout);\n', '      autoprompt_pipe_trace ("write-enter", get_handle (), pipe_mtx, (ULONG) len, 0);\n      DWORD waitret = cygwait (pipe_mtx, timeout);\n      autoprompt_pipe_trace ("write-wait", get_handle (), pipe_mtx, waitret, GetLastError ());\n')
        chunk = once(chunk, '  if (!(evt = CreateEvent (NULL, false, false, NULL)))\n', '  evt = CreateEvent (NULL, false, false, NULL);\n  autoprompt_pipe_trace ("write-event", evt, get_handle (), GetLastError (), 0);\n  if (!evt)\n')
        chunk = after(chunk, '\t\t\t\t  (PVOID) ptr, len1, NULL, NULL);\n', '\t  autoprompt_pipe_trace ("write-nt", get_handle (), evt, status, len1);\n')
        chunk = once(chunk, '\t  if (!NT_SUCCESS (status))\n\t    break;\n', '\t  autoprompt_pipe_trace ("write-result", get_handle (), evt, status, status == STATUS_SUCCESS ? (ULONG) io.Information : 0xffffffff);\n\t  if (!NT_SUCCESS (status))\n\t    break;\n')
        text = text[:start] + chunk + text[end:]; write(work/names[0], text)
        text = adapted[names[1]].decode()
        text = once(text, '#include "ntdll.h"\n', '#include "ntdll.h"\n#include "pipe_io_trace.h"\n')
        anchor = '      res = WaitForMultipleObjects (num, wait_objects, FALSE, INFINITE);\n'
        text = once(text, anchor, '      for (DWORD trace_index = 0; trace_index < num; ++trace_index)\n        autoprompt_pipe_trace ("wait-handle", wait_objects[trace_index], object, trace_index, mask);\n' + anchor + '      autoprompt_pipe_trace ("wait-result", object, NULL, res, GetLastError ());\n')
        write(work/names[1], text)
        header = 'winsup/cygwin/pipe_io_trace.h'; (work/header).write_bytes((HERE/'trace.h').read_bytes()); paths.update(names + [header])
        patch = []; records = []
        for name in sorted(paths):
            before = (src/name).read_bytes() if (src/name).exists() else b''; result = (work/name).read_bytes()
            patch.extend(difflib.unified_diff(before.decode().splitlines(True), result.decode().splitlines(True), 'a/'+name if before else '/dev/null', 'b/'+name))
            records.append({'path': name, 'pristineSha256': sha(before) if before else None, 'adaptedSha256': sha(adapted[name]) if name in adapted else None, 'resultSha256': sha(result)})
        combined = ''.join(patch).encode(); (out/'combined.patch').write_bytes(combined)
        # Reset just the patch paths to pristine and verify the complete patch independently.
        for name in paths:
            target = work/name
            if (src/name).exists(): target.write_bytes((src/name).read_bytes())
            else: target.unlink()
        git(work, 'apply', '--check', str(out/'combined.patch')); git(work, 'apply', str(out/'combined.patch'))
        for record in records:
            if sha((work/record['path']).read_bytes()) != record['resultSha256']: raise ValueError('combined patch result mismatch')
        manifest = {'schema': 1, 'status': 'diagnostic-only', 'sourceCommit': SOURCE, 'basePatchSha256': BASE, 'combinedPatchSha256': sha(combined), 'generatorSha256': sha(pathlib.Path(__file__).read_bytes()), 'headerSha256': sha((HERE/'trace.h').read_bytes()), 'recordLimitPerTranslationUnitPerProcess': 128, 'records': records}
        write(out/'manifest.json', json.dumps(manifest, indent=2)+'\n')
if __name__ == '__main__': main(sys.argv[1:])
