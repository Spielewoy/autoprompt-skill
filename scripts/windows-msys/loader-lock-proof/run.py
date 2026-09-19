#!/usr/bin/env python3
"""Compile the exact direct-NT adapter against controlled ABI/error seams.

This is local C++ contract coverage, not native Windows or a fork proof.
"""
from pathlib import Path
import argparse, hashlib, importlib.util, json, re, subprocess, sys, tempfile
sys.dont_write_bytecode=True
parser=argparse.ArgumentParser()
parser.add_argument('--windows-cxx', help='Explicit Windows-target cross compiler for a complete helper object audit')
parser.add_argument('--sdk-ntdll', help='Exact pinned SDK libntdll.a for symbol resolution audit')
args=parser.parse_args()
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('prepare',HERE.parent/'descriptor-proof/prepare.py')
prepare=importlib.util.module_from_spec(spec);spec.loader.exec_module(prepare)
patch=(HERE.parent/'pipe-security.patch').read_bytes();binding=json.loads((HERE.parent/'descriptor-proof/binding.json').read_text())
sha=lambda data:hashlib.sha256(data).hexdigest()
assert sha(patch)==binding['patchSha256']
header=prepare.extract_new_file(patch.decode(),'winsup/cygwin/local_includes/appcontainer_nt_security.h')
helper=prepare.extract_new_file(patch.decode(),'winsup/cygwin/sec/appcontainer_pipe.cc')
assert sha(header)==binding['ntSecuritySha256'] and sha(helper)==binding['helperSha256']
wrappers=re.findall(r'inline (?:BOOL|DWORD|PUCHAR) ([A-Z][A-Za-z0-9]+) \(',header.decode())
def no_autoload(text):
 for name in wrappers:
  assert re.search(r'(?<!::)\b'+name+r'\s*\(',text) is None, name+' must not enter Win32 autoload'
 calls=set(re.findall(r'(?<![:\w])([A-Z][A-Za-z0-9_]*)\s*\(',text))
 assert calls=={'CloseHandle','GetCurrentProcess','GetLastError','GetProcessHeap','HeapAlloc','HeapFree','SetLastError'},sorted(calls)
no_autoload(helper.decode())
for mutated in [helper.decode().replace('appcontainer_nt::OpenProcessToken','OpenProcessToken',1),helper.decode().replace('HeapFree (','RegOpenKeyExW (',1)]:
 try:no_autoload(mutated)
 except AssertionError:pass
 else:raise AssertionError('autoload mutation was not rejected')
assert not re.search(r'\b(?:LoadLibrary|GetProcAddress|GetModuleHandle|VirtualProtect)\w*\s*\(',header.decode())
with tempfile.TemporaryDirectory(prefix='msys-loader-lock-') as temporary:
 root=Path(temporary);source=root/'contract.cc'
 source.write_bytes((HERE/'prefix.cc').read_bytes()+header+(HERE/'tests.cc').read_bytes())
 subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-Werror',str(source),'-o',str(root/'contract')],check=True,timeout=60)
 subprocess.run([str(root/'contract')],check=True,timeout=15)
 if args.windows_cxx:
  (root/'appcontainer_nt_security.h').write_bytes(header)
  (root/'appcontainer_pipe_security.h').write_bytes(prepare.extract_new_file(patch.decode(),'winsup/cygwin/local_includes/appcontainer_pipe_security.h'))
  (root/'appcontainer_pipe.cc').write_bytes(helper.replace(b'#include "winsup.h"\n',b'#include <windows.h>\n'))
  object_file=root/'helper.o'
  subprocess.run([args.windows_cxx,'-std=c++17','-Wall','-Wextra','-Werror','-fno-exceptions','-fno-rtti','-c',str(root/'appcontainer_pipe.cc'),'-o',str(object_file)],check=True,timeout=60)
  symbols={line.split()[-1] for line in subprocess.check_output(['nm','-u',str(object_file)],text=True).splitlines()}
  native=set(re.findall(r'NTAPI ([A-Za-z0-9_]+) \(',header.decode()))
  kernel={'__imp_'+name for name in ['CloseHandle','GetCurrentProcess','GetLastError','GetProcessHeap','HeapAlloc','HeapFree','SetLastError']}
  assert symbols <= native|kernel|{'memcpy'}, sorted(symbols-native-kernel-{'memcpy'})
  assert native <= symbols, 'all direct security imports must occur in the compiled helper'
  print('Complete Windows helper object has only direct Nt/Rtl, Kernel32 and memcpy imports:',len(symbols))
  if args.sdk_ntdll:
   library=Path(args.sdk_ntdll).read_bytes()
   assert sha(library)=='e59aa942c948ee8917c585e7abd15528fa27bf41ebe3bf904c99b92d7be7f9f2','exact pinned SDK import library required'
   table=subprocess.check_output(['nm','-g',args.sdk_ntdll],text=True,stderr=subprocess.DEVNULL)
   assert all(re.search(r'\bT '+name+r'$',table,re.M) for name in native),'pinned SDK import symbol missing'
   print('All31 direct security imports exist in the pinned SDK import library.')
print('Exact NT adapter SHA256:',sha(header))
print('Native descriptor variants, complete MSYS compilation and actual fork execution remain required.')
