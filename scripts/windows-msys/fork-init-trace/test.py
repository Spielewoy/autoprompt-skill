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
 # Compile the exact generated loop, proving call order/count and exception flow.
 loop_source=r'''#include <vector>
#include <stdexcept>
#include <cassert>
static std::vector<unsigned> events;
static unsigned calls;
namespace autoprompt_fork_trace { void emit(unsigned n){events.push_back(n);} }
static void first(){events.push_back(1);++calls;}
static void second(){events.push_back(2);++calls;}
static void third(){events.push_back(3);++calls;}
static void fails(){throw std::runtime_error("original");}
static void loop(void (**in_pfunc)(), int force){void (**pfunc)()=in_pfunc;while(*++pfunc);''' + generate['CTOR_TRACE'] + r'''}
int main(){
 void(*table[])()={nullptr,first,second,third,nullptr};
 loop(table,1);assert(calls==3);assert((events==std::vector<unsigned>{0x103,3,0x203,0x102,2,0x202,0x101,1,0x201}));
 events.clear();calls=0;loop(table,0);assert(calls==3);assert((events==std::vector<unsigned>{3,2,1}));
 events.clear();table[3]=fails;try{loop(table,1);assert(false);}catch(const std::runtime_error&){}assert((events==std::vector<unsigned>{0x103}));
 void(*large[67])()={nullptr};for(unsigned i=1;i<=65;i++)large[i]=first;
 events.clear();calls=0;loop(large,1);assert(calls==65);assert(events.front()==1);assert(events.size()==65+128);
}
'''
 (root/'constructor-loop.cc').write_text(loop_source)
 subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-Werror',str(root/'constructor-loop.cc'),'-o',str(root/'constructor-loop')],check=True,timeout=60)
 subprocess.run([str(root/'constructor-loop')],check=True,timeout=10)
 # Compile the exact pointer classification and allocator constructor edits.
 pointer_source='#include <vector>\n#include <cassert>\n#include <stdexcept>\nstatic std::vector<unsigned> events;\nnamespace autoprompt_fork_trace { void emit(unsigned n){events.push_back(n);} }\n'
 pointer_source+='\n'.join('static const int '+name+' = 0;' for name in generate['CAP_TABLES'])+'\n'
 pointer_source+='static void observe(const void *caps){'+generate['CAP_TRACE']+'}\n'
 pointer_source+='static unsigned getter_calls; static bool extended,fail_getter; struct Cap { bool has_extended_mem_api(){++getter_calls;if(fail_getter)throw std::runtime_error("original");return extended;} } wincap;\n'
 pointer_source+='static const unsigned THREAD_STORAGE_HIGH=1234; class thread_allocator { public: unsigned current; int(thread_allocator::*alloc_func)(); int _alloc(){return 1;} int _alloc_old(){return 2;}\n'+generate['ALLOC_TRACE']+'};\n'
 pointer_source+='int main(){observe(nullptr);assert(events.back()==110);\n'
 pointer_source+='\n'.join('observe(&'+name+');assert(events.back()==111);' for name in generate['CAP_TABLES'])
 pointer_source+='int foreign=0;observe(&foreign);assert(events.back()==112); for(bool value:{false,true}){extended=value;getter_calls=0;events.clear();thread_allocator a;assert(a.current==1234);assert((a.*a.alloc_func)()==(value?1:2));assert(getter_calls==1);assert((events==std::vector<unsigned>{113,114}));}events.clear();fail_getter=true;try{thread_allocator a;assert(false);}catch(const std::runtime_error&){}assert((events==std::vector<unsigned>{113}));}\n'
 (root/'pointer-state.cc').write_text(pointer_source)
 subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-Werror',str(root/'pointer-state.cc'),'-o',str(root/'pointer-state')],check=True,timeout=60)
 subprocess.run([str(root/'pointer-state')],check=True,timeout=10)
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
  # The producer generates diagnostics from its already-adapted compiler tree.
  # Reproduce the complete base-patch sequence from a pristine source fixture.
  patch=HERE.parent/'pipe-security.patch';assert sha(patch.read_bytes())==generate['PATCH']
  adapted=root/'adapted-source';shutil.copytree(a.source,adapted)
  subprocess.run(['git','apply','--check',str(patch)],cwd=adapted,check=True,timeout=30)
  subprocess.run(['git','apply',str(patch)],cwd=adapted,check=True,timeout=30)
  try:generate['generate'](a.source,patch,root/'pristine-output')
  except ValueError as error:assert str(error)=='Pinned source identity: winsup/cygwin/autoload.cc',str(error)
  else:raise AssertionError('Pristine source accepted as adapted compiler source')
  assert not (root/'pristine-output').exists()
  generated=root/'generated';generate['generate'](adapted,patch,generated)
  repeated=root/'repeated';generate['generate'](adapted,patch,repeated)
  for name in ['trace.patch','trace-manifest.json']:assert (generated/name).read_bytes()==(repeated/name).read_bytes(),name
  check=root/'source';check.mkdir();pins=json.loads((HERE/'source-pins.json').read_text())
  for rel in pins:
   dest=check/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(adapted/rel,dest)
  subprocess.run(['git','apply','--check',str(generated/'trace.patch')],cwd=check,check=True)
  subprocess.run(['git','apply',str(generated/'trace.patch')],cwd=check,check=True)
  stages=[]
  for rel in pins:
   text=(check/rel).read_text();stages+=map(int,re.findall(r'autoprompt_fork_trace::emit \(([0-9]+)\);',text))
   if rel.endswith('/dcrt0.cc'):
    assert text.count(generate['CTOR_TRACE'])==1
    text=text.replace(generate['CTOR_TRACE'],generate['CTOR_ORIGINAL'])
   cleaned=''.join(line for line in text.splitlines(True) if not line.strip().startswith('autoprompt_fork_trace::emit') and line!='#include "autoprompt-fork-trace.h"\n')
   at=cleaned.rfind('#include "ntdll.h"\n');cleaned=cleaned[:at]+cleaned[at+len('#include "ntdll.h"\n'):]
   assert cleaned==(adapted/rel).read_text(),rel
  assert (check/'winsup/cygwin/wincap.cc').read_text().count(generate['CAP_TRACE'])==1
  assert (check/'winsup/cygwin/create_posix_thread.cc').read_text().count(generate['ALLOC_TRACE'])==1
  assert len(stages)==57 and len(set(stages))==57
  assert len(set(stages)|{110,111,112})==60
  bad=root/'bad.patch';bad.write_bytes(b'wrong patch')
  try:generate['generate'](adapted,bad,root/'bad-output')
  except ValueError:pass
  else:raise AssertionError('Wrong base authority accepted')
  print('Full base-patch composition verified; pristine source refused; 60 closed stage values plus bounded constructor pre/post observations preserve all eight adapted source files byte-for-byte')
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
