#include <cassert>
#include <cstdint>
#include <string>
#include <vector>
#include <cstdio>
using WCHAR=char16_t; using ULONG=uint32_t; using ULONG_PTR=uintptr_t; using HANDLE=void*;
struct IO_STATUS_BLOCK {}; struct OBJECT_BASIC_INFORMATION {ULONG GrantedAccess;};struct FILE_MODE_INFORMATION{ULONG Mode;};struct FILE_PIPE_LOCAL_INFORMATION{};
struct Parameters{void* Environment;}; struct PebType{Parameters* ProcessParameters;};struct Teb{ULONG LastErrorValue,LastStatusValue; PebType* Peb; struct{HANDLE UniqueProcess;}ClientId;};
static Parameters params;static PebType peb{&params};static Teb teb{77,88,&peb,{(HANDLE)0x123}};
Teb* NtCurrentTeb(){return &teb;}
constexpr int ObjectBasicInformation=0,FileModeInformation=16,FilePipeLocalInformation=24;
constexpr ULONG FILE_WRITE_DATA=2,FILE_SYNCHRONOUS_IO_ALERT=16,FILE_SYNCHRONOUS_IO_NONALERT=32;
#define NT_SUCCESS(x) ((x)>=0)
static int fail=0,writes=0;static ULONG access=2,mode=32;static std::string output;
int NtQueryObject(HANDLE,int,OBJECT_BASIC_INFORMATION* b,unsigned,void*){teb.LastErrorValue=900;teb.LastStatusValue=901;b->GrantedAccess=access;return fail==1?-1:0;}
int NtQueryInformationFile(HANDLE,IO_STATUS_BLOCK*,void* data,unsigned,int type){if(type==16)((FILE_MODE_INFORMATION*)data)->Mode=mode;return fail==(type==16?2:3)?-1:0;}
int NtWriteFile(HANDLE,void*,void*,void*,IO_STATUS_BLOCK*,char* data,unsigned len,void*,void*){++writes;output.assign(data,len);return 0;}
#include "trace.h"
static void run(std::u16string env,bool expected){env.push_back(0);env.push_back(0);params.Environment=env.data();teb.LastErrorValue=77;teb.LastStatusValue=88;int old=writes;autoprompt_fork_trace::emit(0x4567);assert(writes-old==(expected?1:0));assert(teb.LastErrorValue==77&&teb.LastStatusValue==88);}
int main(){
 const std::u16string key=u"AUTOPROMPT_DIAGNOSTIC_FORK_TRACE_HANDLE=";
 const auto good=key+u"0000000000000042";
 run(good,true);assert(output=="AT:00000123:4567:0\n");
 run(good+std::u16string(1,0)+u"LOCALAPPDATA=C:\\profile",true);assert(output=="AT:00000123:4567:1\n");
 run(u"autoprompt_diagnostic_fork_trace_handle=0000000000000042",true);
 run(u"",false);run(key+u"0000000000000000",false);run(key+u"ffffffffffffffff",false);
 run(key+u"42",false);run(key+u"000000000000004g",false);run(good+std::u16string(1,0)+good,false);
 for(int i=1;i<=3;i++){fail=i;run(good,false);}fail=0;
 access=0;run(good,false);access=2;mode=0;run(good,false);mode=16;run(good,true);
 std::vector<WCHAR> longenv(32768,'x');params.Environment=longenv.data();int old=writes;autoprompt_fork_trace::emit(1);assert(writes==old);
 params.Environment=nullptr;autoprompt_fork_trace::emit(1);assert(writes==old);
 puts("17 trace transport contracts passed (simulated NT APIs; not native proof)");
}
