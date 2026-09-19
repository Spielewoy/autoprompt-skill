#!/usr/bin/env python3
"""Generate a separate diagnostic patch; never modifies source or candidate."""
import argparse, hashlib, json, pathlib, difflib
HERE=pathlib.Path(__file__).resolve().parent
PATCH='dff1f67d63c434431527861c28da3f32b161ec665b01a453280bcbe003179aa6'
SOURCE='270ba2980700e6e2a0813944d506eecea0f86402'
sha=lambda b:hashlib.sha256(b).hexdigest()
CTOR_ORIGINAL='  while (--pfunc > in_pfunc)\n    (*pfunc) ();\n'
CTOR_TRACE='  while (--pfunc > in_pfunc)\n    {\n      if (force && pfunc - in_pfunc <= 64)\n        autoprompt_fork_trace::emit (0x100 + (pfunc - in_pfunc));\n      (*pfunc) ();\n      if (force && pfunc - in_pfunc <= 64)\n        autoprompt_fork_trace::emit (0x200 + (pfunc - in_pfunc));\n    }\n'
def once(text, old, new):
    if text.count(old)!=1: raise ValueError('Expected one source anchor: '+repr(old))
    return text.replace(old,new)
def mark(text, anchor, number, before=False):
    call='  autoprompt_fork_trace::emit (%d);\n'%number
    return once(text,anchor,call+anchor if before else anchor+call)
def generate(source, patch, out):
    if sha(patch.read_bytes())!=PATCH:raise ValueError('Base patch identity')
    pins=json.loads((HERE/'source-pins.json').read_text())
    stages={};diff=[];records=[]
    for rel, expected in pins.items():
        data=(source/rel).read_bytes()
        if sha(data)!=expected:raise ValueError('Pinned source identity: '+rel)
        original=data.decode();text=original
        if rel.endswith('/init.cc'):
            text=mark(text,'    case DLL_PROCESS_ATTACH:\n',1)
            text=mark(text,'      init_console_handler (false);\n',2)
            text=mark(text,'      memcpy (_REENT, _GLOBAL_REENT, sizeof (struct _reent));\n',3)
            text=mark(text,'      dll_crt0_0 ();\n',4)
            text=mark(text,'      dll_finished_loading = true;\n',5)
        elif rel.endswith('/dcrt0.cc'):
            text=once(text,CTOR_ORIGINAL,CTOR_TRACE)
            start=text.index('void\ndll_crt0_0 ()\n');end=text.index('\nstatic inline void\nmain_thread_sinit',start)
            chunk=text[start:end]
            markers=[('  wincap.init ();\n',11),('  child_proc_info = get_cygwin_startup_info ();\n',12),('  init_windows_system_directory ();\n',13),('  initial_env ();\n',14),('  user_data->impure_ptr_ptr = &_impure_ptr;\n',15),('\t\t   0, false, DUPLICATE_SAME_ACCESS);\n',16),('  NtOpenProcessToken (NtCurrentProcess (), MAXIMUM_ALLOWED, &hProcToken);\n',17),('  set_cygwin_privileges (hProcToken);\n',18),('  device::init ();\n',90),('  do_global_ctors (&__CTOR_LIST__, 1);\n',19),('  cygthread::init ();\n',20),('      setup_cygheap ();\n',21),('      memory_init ();\n',22),('\t  fork_info->handle_fork ();\n',24),('  user_data->threadinterface->Init ();\n',25),('  AddVectoredContinueHandler (0, myfault_altstack_handler);\n',27),('  debug_printf ("finished dll_crt0_0 initialization");\n',28)]
            chunk=mark(chunk,'dll_crt0_0 ()\n{\n',10)
            chunk=mark(chunk,'\t  fork_info->handle_fork ();\n',23,True)
            for anchor,num in markers:chunk=mark(chunk,anchor,num)
            # Do not insert into the unbraced sigproc conditional.
            chunk=mark(chunk,'    sigproc_init ();\n',26)
            text=text[:start]+chunk+text[end:]
            start=text.index('void\nchild_info_fork::handle_fork ()\n');end=text.index('\nbool\nchild_info_spawn::get_parent_handle',start)
            chunk=text[start:end]
            for anchor,num in [('child_info_fork::handle_fork ()\n{\n',40),('  cygheap_fixup_in_child (false);\n',41),('  memory_init ();\n',42),('  myself->gid = cygheap->user.real_gid;\n',43),('\t      "user heap", cygheap->user_heap.base, cygheap->user_heap.ptr,\n\t      NULL);\n',44),('  _pei386_runtime_relocator (user_data);\n',45),('\t      "bss", user_data->bss_start, user_data->bss_end,\n\t      NULL);\n',46),('    api_fatal ("recreate_mmaps_after_fork_failed");\n',47),('  dlls.reserve_space ();\n',48)]:chunk=mark(chunk,anchor,num)
            text=text[:start]+chunk+text[end:]
        elif rel.endswith('/getentropy.cc'):
            start=text.index('extern "C" int\ngetentropy (void *ptr, size_t len)\n');end=text.index('\nextern "C" ssize_t\ngetrandom',start)
            chunk=text[start:end]
            for anchor,num in [('getentropy (void *ptr, size_t len)\n{\n',91),('\t}\n',93),('  __except (EFAULT)\n    {\n',95),('  __endtry\n',96)]:chunk=mark(chunk,anchor,num)
            chunk=mark(chunk,'      if (!RtlGenRandom (ptr, len))\n',92,True)
            chunk=mark(chunk,'\t  debug_printf ("RtlGenRandom() = FALSE");\n',94,True)
            text=text[:start]+chunk+text[end:]
        elif rel.endswith('/autoload.cc'):
            start=text.index('static __inline bool\ndll_load (HANDLE& handle, PWCHAR name)\n');end=text.index('\n#define RETRY_COUNT',start)
            chunk=text[start:end]
            for anchor,num in [('dll_load (HANDLE& handle, PWCHAR name)\n{\n',100),('  h = LoadLibraryW (dll_path);\n',101),('    h = LoadLibraryW (name);\n',102),('  handle = h;\n',103)]:chunk=mark(chunk,anchor,num)
            text=text[:start]+chunk+text[end:]
        elif rel.endswith('/cygheap.cc'):
            start=text.index('void\ncygheap_fixup_in_child (bool execed)\n');end=text.index('\nvoid\ninit_cygheap::close_ctty',start)
            prefix,suffix=text[:start],text[end:];text=text[start:end]
            for anchor,num in [('cygheap_fixup_in_child (bool execed)\n{\n',60),('\t\t\t\t\t   MEM_RESERVE, PAGE_NOACCESS);\n',61),('\t\t\t\t\t   PAGE_READWRITE);\n',62),('\t      "cygheap", cygheap, cygheap_max, NULL);\n',63),('  cygheap_init ();\n',64),('  debug_fixup_after_fork_exec ();\n',65)]:text=mark(text,anchor,num)
            text=prefix+text+suffix
        elif rel.endswith('/shared.cc'):
            for anchor,num in [('memory_init ()\n{\n',80),('  shared_info::create ();\t/* Initialize global shared memory */\n',81),('  cygheap->user_heap.init ();\t/* Initialize user heap */\n',82),('  user_info::create (false);\t/* Initialize per-user shared memory */\n',83),('  tty_list::init_session ();\n',84)]:text=mark(text,anchor,num)
        includes='#include "ntdll.h"\n#include "autoprompt-fork-trace.h"\n'
        # winsup.h exposes NT declarations directly or via its local includes.
        last=max(i for i,l in enumerate(text.splitlines(True)) if l.startswith('#include '))
        lines=text.splitlines(True);lines.insert(last+1,includes);text=''.join(lines)
        diff.extend(difflib.unified_diff(original.splitlines(True),text.splitlines(True),'a/'+rel,'b/'+rel))
        records.append({'path':rel,'sourceSha256':sha(data),'tracedSha256':sha(text.encode())})
    header=(HERE/'trace.h').read_bytes();rel='winsup/cygwin/autoprompt-fork-trace.h'
    diff.extend(difflib.unified_diff([],header.decode().splitlines(True),'/dev/null','b/'+rel))
    output=''.join(diff).encode();out.mkdir(exist_ok=False)
    (out/'trace.patch').write_bytes(output)
    manifest={'schema':1,'purpose':'fork-initialization-diagnostic-only','accepted':False,'sourceCommit':SOURCE,'sourceArchiveSha256':'0571ad83f965bf7682a446a874830a560c8b12431e7d54e55f414a3851ba1146','generatorSha256':sha(pathlib.Path(__file__).read_bytes()),'sourcePinsSha256':sha((HERE/'source-pins.json').read_bytes()),'recipeSha256':sha((HERE/'build-trace.sh').read_bytes()),'basePatchSha256':PATCH,'tracePatchSha256':sha(output),'traceHeaderSha256':sha(header),'inputs':records,'transport':'dedicated-inherited-synchronous-pipe-alias','record':'AT:8hexPID:4hexStage:LOCALAPPDATA-presence\\n'}
    (out/'trace-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source',type=pathlib.Path);p.add_argument('patch',type=pathlib.Path);p.add_argument('output',type=pathlib.Path);a=p.parse_args();generate(a.source,a.patch,a.output)
