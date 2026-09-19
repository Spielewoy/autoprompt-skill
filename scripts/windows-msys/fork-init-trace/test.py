#!/usr/bin/env python3
"""Source and compiled seams only. Actual loader behavior requires Windows CI."""
import argparse, hashlib, json, pathlib, re, runpy, subprocess, tempfile, shutil
HERE=pathlib.Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--source',type=pathlib.Path);p.add_argument('--pwsh',type=pathlib.Path);p.add_argument('--windows-cxx',type=pathlib.Path);a=p.parse_args()
repo=HERE.parents[2];derive=runpy.run_path(str(HERE/'derive-native.py'));generate=runpy.run_path(str(HERE/'generate.py'))
sha=lambda b:hashlib.sha256(b).hexdigest()
with tempfile.TemporaryDirectory(prefix='fork-trace-contract-') as temporary:
 root=pathlib.Path(temporary)
 subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-Werror',str(HERE/'test.cc'),'-o',str(root/'transport')],check=True,timeout=60)
 subprocess.run([str(root/'transport')],check=True,timeout=10)
 header=(HERE/'trace.h').read_text()
 calls=set(re.findall(r'\b([A-Z][A-Za-z0-9_]*)\(',header))
 assert calls=={'NtCurrentTeb','NtQueryObject','NtQueryInformationFile','NtWriteFile'},calls
 assert 'static ' not in header.replace('static inline ','')
 native=(repo/'agents/codex/workflow/windows-appcontainer-native.cs').read_bytes();controller=(HERE.parent/'process-security-proof/controller.cs').read_bytes()
 derived=derive['derive'](native);dc=derive['derive_controller'](controller)
 assert derive['derive'](native.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'))==derived
 marker=b' Console.Error.WriteLine("TRACE-DRAIN:"+(drained?"confirmed":"unknown"));\n'
 assert dc.replace(marker,b'')==controller.replace(b'\r\n',b'\n')
 assert derived.count(b'trace-close-parent-alias')==1
 assert b'stderrRead,stderrWrite,nulRead,privateNull,traceWrite' in derived
 assert b'Marshal.WriteIntPtr(handleList,IntPtr.Size*4,traceWrite)' in derived
 for altered in [native.replace(b'handleList=Marshal.AllocHGlobal(IntPtr.Size*4);',b'handleList=Marshal.AllocHGlobal(IntPtr.Size*6);'),native+b'public static class WindowsAppContainerNative {']:
  try:derive['derive'](altered)
  except ValueError:pass
  else:raise AssertionError('Source drift accepted')
 (root/'native.cs').write_bytes(derived);(root/'controller.cs').write_bytes(dc)
 if a.pwsh:
  env=__import__('os').environ.copy();env['AP_TRACE_NATIVE']=str(root/'native.cs');env['AP_TRACE_CONTROLLER']=str(root/'controller.cs')
  subprocess.run([str(a.pwsh),'-NoLogo','-NoProfile','-NonInteractive','-Command','Add-Type -Path @($env:AP_TRACE_NATIVE,$env:AP_TRACE_CONTROLLER) -ErrorAction Stop; "complete derived controller compiled"'],env=env,check=True,timeout=60)
 if a.source:
  generated=root/'generated';generate['generate'](a.source,HERE.parent/'pipe-security.patch',generated)
  check=root/'source';check.mkdir();pins=json.loads((HERE/'source-pins.json').read_text())
  for rel in pins:
   dest=check/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(a.source/rel,dest)
  subprocess.run(['git','apply','--check',str(generated/'trace.patch')],cwd=check,check=True)
  subprocess.run(['git','apply',str(generated/'trace.patch')],cwd=check,check=True)
  stages=[]
  for rel in pins:
   text=(check/rel).read_text();stages+=map(int,re.findall(r'autoprompt_fork_trace::emit \(([0-9]+)\);',text))
   cleaned=''.join(line for line in text.splitlines(True) if not line.strip().startswith('autoprompt_fork_trace::emit') and line!='#include "autoprompt-fork-trace.h"\n')
   at=cleaned.rfind('#include "ntdll.h"\n');cleaned=cleaned[:at]+cleaned[at+len('#include "ntdll.h"\n'):]
   assert cleaned==(a.source/rel).read_text(),rel
  assert len(stages)==44 and len(set(stages))==44
  bad=root/'bad.patch';bad.write_bytes(b'wrong patch')
  try:generate['generate'](a.source,bad,root/'bad-output')
  except ValueError:pass
  else:raise AssertionError('Wrong base authority accepted')
  print('44 unique stage insertions preserve all four original source files byte-for-byte')
 if a.windows_cxx:
  prefix=(HERE/'test.cc').read_text().split('static int fail=')[0]
  prefix+='extern "C" int NtQueryObject(HANDLE,int,OBJECT_BASIC_INFORMATION*,unsigned,void*);\nextern "C" int NtQueryInformationFile(HANDLE,IO_STATUS_BLOCK*,void*,unsigned,int);\nextern "C" int NtWriteFile(HANDLE,void*,void*,void*,IO_STATUS_BLOCK*,char*,unsigned,void*,void*);\n'
  cross=root/'cross.cc';cross.write_text(prefix+header+'\nextern "C" void trace_contract(unsigned n){autoprompt_fork_trace::emit(n); }\n')
  obj=root/'cross.o'
  subprocess.run([str(a.windows_cxx),'-std=c++17','-O2','-fno-exceptions','-fno-rtti','-Wall','-Wextra','-Werror','-c',str(cross),'-o',str(obj)],check=True,timeout=60)
  symbols={line.split()[-1] for line in subprocess.check_output(['nm','-u',str(obj)],text=True).splitlines()}
  assert symbols=={'NtQueryObject','NtQueryInformationFile','NtWriteFile'},symbols
  print('Windows-target helper seam imports exactly three direct Nt calls; no CRT/heap/autoload symbols')
 subprocess.run(['bash','-n',str(HERE/'build-trace.sh')],check=True)
 print('Trace transport, closed call allowlist, derivation, source-drift and recipe contracts passed; no native execution claimed')
