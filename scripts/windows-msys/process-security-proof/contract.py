#!/usr/bin/env python3
"""Compile actual ID parser and peer access loop with narrow API seams.
Does not emulate or claim Windows ACL enforcement.
"""
from pathlib import Path
import subprocess
import tempfile
HERE = Path(__file__).resolve().parent
source = (HERE / 'process-security.cc').read_text()
parser = source[source.index('DWORD decimal('):source.index('std::wstring package(')]
peer = source[source.index('void peer('):source.index('\n}\nint wmain')]
masks = source[source.index('const DWORD process_masks'):source.index('DWORD decimal(')]
contract = r'''
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <string>
#include <stdexcept>
using DWORD=uint32_t; using HANDLE=void*;
constexpr int FALSE=0; constexpr DWORD ERROR_ACCESS_DENIED=5;
static int calls=0,closed=0; static bool success=true,wrongIdentity=false; static DWORD lastError=0; static DWORD expectedMasks[]={4096,1024,1040,1,32,8,64,2048,64,16,2,32};
void need(bool ok,const char*why){if(!ok)throw std::runtime_error(why);}
struct Handle{HANDLE value=nullptr;~Handle(){if(value)++closed;}};
DWORD GetLastError(){return lastError;}
HANDLE open(bool thread,DWORD mask,int inherit,DWORD id){need(calls<12&&thread==(calls>=7)&&mask==expectedMasks[calls]&&inherit==FALSE&&id==(thread?12u:11u),"actual access/identity/argument ordering");++calls;return success?reinterpret_cast<HANDLE>(uintptr_t(id)):nullptr;}
HANDLE OpenProcess(DWORD mask,int inherit,DWORD id){return open(false,mask,inherit,id);}
HANDLE OpenThread(DWORD mask,int inherit,DWORD id){return open(true,mask,inherit,id);}
DWORD GetProcessId(HANDLE h){return wrongIdentity?999:static_cast<DWORD>(reinterpret_cast<uintptr_t>(h));}
DWORD GetThreadId(HANDLE h){return GetProcessId(h);}
std::wstring package(){return L"expected-package";}
/* SOURCE */
int main(){int cases=0;need(decimal(L"1")==1&&decimal(L"4294967295")==0xffffffff,"valid IDs");++cases;
for(const wchar_t*value:{L"",L"0",L"-1",L"+1",L"1x",L"4294967296",L"99999999999"}){bool refused=false;try{decimal(value);}catch(...){refused=true;}need(refused,"invalid ID accepted");++cases;}
for(bool allowed:{true,false}){calls=closed=0;success=allowed;lastError=allowed?999:5;peer(allowed,L"expected-package",11,12);need(calls==12&&closed==(allowed?12:0),"complete peer/close count");++cases;}
for(int mode:{0,1,2,3,4}){calls=closed=0;success=mode!=1&&mode!=2;lastError=mode==2?6:5;wrongIdentity=mode==3;bool refused=false;try{peer(mode!=0,mode==4?L"wrong-package":L"expected-package",11,12);}catch(...){refused=true;}need(refused,"wrong access/error/identity/package accepted");if(success&&calls)need(closed==1,"failed identity leaked owned handle");++cases;}
printf("source-contract:%d:passed\n",cases);}
'''.replace('/* SOURCE */', masks + parser + peer)
with tempfile.TemporaryDirectory(prefix='process-security-contract-') as directory:
    folder=Path(directory)
    (folder/'contract.cc').write_text(contract)
    subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-Werror',str(folder/'contract.cc'),'-o',str(folder/'contract')],check=True,timeout=30)
    result=subprocess.run([str(folder/'contract')],check=True,timeout=10,text=True,capture_output=True)
    assert result.stdout.endswith('source-contract:15:passed\n'), result.stdout
    assert not result.stderr
print('source-contract:15:passed')
