#!/usr/bin/env python3
"""Source-owned capability initialization seams; never grants native acceptance."""
import argparse,ctypes,difflib,hashlib,json,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--source',type=pathlib.Path,help='Exact pristine complete MSYS source tree')
parser.add_argument('--windows-cxx',help='Explicit Windows-target compiler for PE section controls')
args=parser.parse_args()
sha=lambda data:hashlib.sha256(data).hexdigest()
binding=json.loads((ROOT/'binding.json').read_text())
cpp=(ROOT/'original-wincap.cc').read_text();header=(ROOT/'original-wincap.h').read_text()
assert sha(cpp.encode())==binding['sourceSha256']
assert sha(header.encode())==binding['headerSha256']
patch=ROOT.parent/'pipe-security.patch';assert sha(patch.read_bytes())==binding['patchSha256']
lock=json.loads((ROOT.parent/'build-lock.json').read_text());assert lock['source']['commit']==binding['sourceCommit']
old='wincapc wincap __attribute__((section (".cygwin_dll_common"), shared));'
new='wincapc wincap NO_COPY;'
assert cpp.count(old)==1
candidate=cpp.replace(old,new);assert sha(candidate.encode())==binding['candidateSha256']
marker='diff --git a/winsup/cygwin/wincap.cc b/winsup/cygwin/wincap.cc\n'
assert patch.read_text().count(marker)==1
expected=''.join(difflib.unified_diff(cpp.splitlines(True),candidate.splitlines(True),'a/winsup/cygwin/wincap.cc','b/winsup/cygwin/wincap.cc'))
assert patch.read_text().split(marker)[1].split('\ndiff --git ')[0]==expected
layout_bytes=(ROOT/'layout-excerpts.json').read_bytes();assert sha(layout_bytes)==binding['layoutSha256']
layout=json.loads(layout_bytes)
link=layout[0]['text'];assert link.index('__data_end__ = .;')<link.index('*(.data_cygwin_nocopy)')
dcrt=layout[1]['text'];assert '#define dll_data_end &__data_end__' in dcrt and '"dll data", dll_data_start, dll_data_end,' in dcrt
early=layout[2]['text'];assert early.index('  wincap.init ();')<early.index('  do_global_ctors (&__CTOR_LIST__, 1);')
disk=layout[3]['text'];mutation=disk.index('wincap.disable_case_sensitive_dirs ();');assert disk.rfind('#if 0',0,mutation)>disk.rfind('#endif',0,mutation)
if args.source:
 assert sha((args.source/'winsup/cygwin/wincap.cc').read_bytes())==binding['sourceSha256']
 assert sha((args.source/'winsup/cygwin/local_includes/wincap.h').read_bytes())==binding['headerSha256']
 for item in layout:
  raw=(args.source/item['path']).read_bytes();assert sha(raw)==item['sourceSha256']
  assert ''.join(raw.decode().splitlines(True)[item['firstLine']-1:item['lastLine']])==item['text']
 init_callers=[];mutation_callers=[]
 for unit in (args.source/'winsup/cygwin').rglob('*.cc'):
  text=unit.read_text(errors='strict')
  if re.search(r'\bwincap\.init\s*\(',text):init_callers.append(unit.relative_to(args.source).as_posix())
  if re.search(r'\bwincap\.disable_case_sensitive_dirs\s*\(',text):mutation_callers.append(unit.relative_to(args.source).as_posix())
 assert init_callers==['winsup/cygwin/dcrt0.cc']
 assert mutation_callers==['winsup/cygwin/fhandler/disk_file.cc']
 with tempfile.TemporaryDirectory(prefix='wincap-full-source-') as temporary:
  adapted=pathlib.Path(temporary)/'source';shutil.copytree(args.source,adapted)
  subprocess.run(['git','apply','--check',str(patch)],cwd=adapted,check=True,timeout=30)
  subprocess.run(['git','apply',str(patch)],cwd=adapted,check=True,timeout=30)
  assert (adapted/'winsup/cygwin/wincap.cc').read_text()==candidate
 print('complete source verification, base patch composition, unique early init and inactive mutator caller scan passed')
# Exact actual class and init algorithm; only visibility is exposed for observing
# the otherwise private pointer in this local source seam. APIs are simulated.
header=header.replace('#include "memory_layout.h"','').replace('class wincapc\n{','class wincapc\n{\npublic:')
candidate='\n'.join(l for l in candidate.splitlines() if not l.startswith('#include '))+'\n'
stubs=r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdarg>
#include <cstddef>
using DWORD=uint32_t;using WORD=uint16_t;using USHORT=uint16_t;using DWORD_PTR=uintptr_t;using LPBYTE=unsigned char*;
struct SYSTEM_INFO {WORD wProcessorArchitecture=0;WORD wProcessorLevel=0;DWORD dwPageSize=0;DWORD dwNumberOfProcessors=0;DWORD_PTR dwActiveProcessorMask=0;DWORD dwAllocationGranularity=0;};
struct RTL_OSVERSIONINFOEXW {DWORD dwOSVersionInfoSize=0,dwMajorVersion=0,dwMinorVersion=0,dwBuildNumber=0;unsigned char wProductType=0;};
struct IMAGE_NT_HEADERS {struct {USHORT Machine;} FileHeader;};using PIMAGE_NT_HEADERS=IMAGE_NT_HEADERS*;
struct IMAGE_DOS_HEADER {intptr_t e_lfanew;IMAGE_NT_HEADERS nt;};
IMAGE_DOS_HEADER __image_base__={offsetof(IMAGE_DOS_HEADER,nt),{{0x8664}}};
#define NO_COPY __attribute__((nocommon,section(".data_cygwin_nocopy")))
#define DEFAULT_GUARD_PAGE_COUNT 2
#define VER_NT_WORKSTATION 1
#define IMAGE_FILE_MACHINE_AMD64 0x8664
#define likely(x) (x)
static unsigned sys_calls,ver_calls,ntver_calls,wow_calls;
static DWORD os_major=10,os_build=22000;static USHORT native_arch=0x8664;static bool wow_success=true;
static void GetSystemInfo(SYSTEM_INFO*p){++sys_calls;p->dwPageSize=4096;p->dwNumberOfProcessors=4;p->dwActiveProcessorMask=15;p->dwAllocationGranularity=65536;}
static void RtlGetVersion(RTL_OSVERSIONINFOEXW*p){++ver_calls;p->dwMajorVersion=os_major;p->dwMinorVersion=0;p->dwBuildNumber=os_build;p->wProductType=1;}
static void RtlGetNtVersionNumbers(DWORD*a,DWORD*b,DWORD*c){++ntver_calls;*a=os_major;*b=0;*c=os_build|0xf0000000;}
static int IsWow64Process2(void*,USHORT*a,USHORT*b){++wow_calls;*a=0;*b=native_arch;return wow_success;}
static void* GetCurrentProcess(){return nullptr;}
static int __small_sprintf(char*out,const char*fmt,...){va_list ap;va_start(ap,fmt);int n=vsnprintf(out,40,fmt,ap);va_end(ap);return n;}
'''
main=r'''
int main(){
 assert(wincap.caps==nullptr);wincap.init();assert(wincap.caps==&wincap_11);assert(wincap.has_extended_mem_api());
 assert(wincap.page_size()==4096&&wincap.cpu_count()==4&&wincap.cpu_mask()==15);assert(wincap.build_number()==22000);assert(wincap.host_machine()==0x8664&&wincap.cygwin_machine()==0x8664);assert(std::strcmp(wincap.osname(),"NT-10.0")==0);
 const void* parent_caps=wincap.caps;os_major=6;os_build=9600;wincap.init();assert(wincap.caps==parent_caps&&sys_calls==1&&ver_calls==1&&ntver_calls==1&&wow_calls==1);
 wincapc child{};assert(child.caps==nullptr);native_arch=0xaa64;child.init();assert(child.caps==&wincap_8_1&&!child.has_extended_mem_api());assert(child.host_machine()==0xaa64);assert(wincap.caps==parent_caps);
 // Simulate foreign module table bytes, not a native fork. The unchanged early
 // return cannot repair a non-null pointer inherited from another mapping.
 wincaps foreign{};wincapc copied{};copied.caps=&foreign;unsigned before=sys_calls;copied.init();assert(copied.caps==&foreign&&sys_calls==before);
 const DWORD builds[]={10240,14393,15063,16299,17134,17763,18362,19041,22000};
 const void* expected[]={&wincap_10_1507,&wincap_10_1607,&wincap_10_1703,&wincap_10_1709,&wincap_10_1803,&wincap_10_1809,&wincap_10_1903,&wincap_10_2004,&wincap_11};
 os_major=10;for(unsigned i=0;i<9;++i){os_build=builds[i];wincapc fresh{};fresh.init();assert(fresh.caps==expected[i]);assert(fresh.has_extended_mem_api()==(i>=4));}
 wow_success=false;wincapc fallback{};fallback.init();assert(fallback.host_machine()==0x8664);
 // Existing mutator behavior is tested against explicitly writable table
 // storage; actual upstream selected tables are const and are not rewritten.
 wincaps writable{};writable.has_case_sensitive_dirs=true;wincapc local_override{};local_override.caps=&writable;local_override.disable_case_sensitive_dirs();assert(!writable.has_case_sensitive_dirs);
 puts("actual init/class seam: idempotence, independent zero state, all OS table choices, host architecture fallback, foreign-pointer control, unchanged writable-table mutator passed; simulated APIs only");
}
'''
with tempfile.TemporaryDirectory(prefix='wincap-contract-') as temp:
 p=pathlib.Path(temp);f=p/'init.cc';f.write_text(stubs+header+candidate+main)
 subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-Werror','-Wno-ignored-qualifiers',str(f),'-o',str(p/'init')],check=True,timeout=30)
 subprocess.run([str(p/'init')],check=True,timeout=10)
 # Three independent ELF mappings of the exact source algorithm exercise
 # differing table addresses. This is a host rebase seam, not Windows evidence.
 exports=r'''
 extern "C" uintptr_t observed_caps(){return reinterpret_cast<uintptr_t>(wincap.caps);}
 extern "C" uintptr_t own_table(){return reinterpret_cast<uintptr_t>(&wincap_11);}
 extern "C" void initialize(){wincap.init();}
 extern "C" void inject_control(uintptr_t value){wincap.caps=reinterpret_cast<void*>(value);}
 '''
 libs=[]
 for index in range(3):
  unit=p/('mapping'+str(index)+'.cc');unit.write_text(stubs+header+candidate+exports)
  library=p/('mapping'+str(index)+'.so')
  subprocess.run(['g++','-std=c++17','-fPIC','-shared','-Wl,-Bsymbolic','-Wall','-Wextra','-Werror','-Wno-ignored-qualifiers',str(unit),'-o',str(library)],check=True,timeout=30)
  loaded=ctypes.CDLL(str(library));loaded.observed_caps.restype=ctypes.c_size_t;loaded.own_table.restype=ctypes.c_size_t;loaded.inject_control.argtypes=[ctypes.c_size_t];libs.append(loaded)
 assert len({item.own_table() for item in libs})==3
 assert all(item.observed_caps()==0 for item in libs)
 libs[0].initialize();assert libs[0].observed_caps()==libs[0].own_table()
 assert libs[1].observed_caps()==0
 libs[1].initialize();assert libs[1].observed_caps()==libs[1].own_table()
 libs[2].inject_control(libs[0].own_table());libs[2].initialize()
 assert libs[2].observed_caps()==libs[0].own_table() # unchanged early-return negative control
 libs[2].inject_control(0);libs[2].initialize();assert libs[2].observed_caps()==libs[2].own_table()
 assert all(item.observed_caps()==item.own_table() for item in libs)
 print('three independent host module mappings: distinct local table addresses/private initialization; injected foreign-pointer negative control; no Windows fork claim')
 compiler=args.windows_cxx
 for label,declaration in ([('original',old),('candidate',new)] if compiler else []):
  f=p/(label+'.cc');f.write_text('#define NO_COPY __attribute__((nocommon,section(".data_cygwin_nocopy")))\nstruct wincapc { const void* caps; };\n'+declaration+'\n')
  obj=p/(label+'.o');subprocess.run([compiler,'-c',str(f),'-o',str(obj)],check=True,timeout=30)
  info=subprocess.check_output(['objdump','-h',str(obj)],text=True)
  if label=='original':assert '.cygwin_dll_common' in info and 'SHARED' in info
  else:assert '.data_cygwin_nocopy' in info and 'SHARED' not in info
 if compiler:print('actual Windows-target object declaration: original shared section versus candidate private NO_COPY section verified')

assert candidate.replace(new,old)== '\n'.join(l for l in cpp.splitlines() if not l.startswith('#include '))+'\n'
print('one declaration only; original init/getters/mutator unchanged; fork-copy linker exclusion verified; no native acceptance')
