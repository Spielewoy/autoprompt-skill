#include <cstdint>
#include <cwchar>
#include <string>
#include <vector>
#include <cassert>
#include <cstdio>
using DWORD=uint32_t; using BOOL=int; using BYTE=unsigned char; using WCHAR=wchar_t; using HANDLE=void*;using PHANDLE=HANDLE*;
struct SECURITY_ATTRIBUTES {DWORD nLength;void* lpSecurityDescriptor;BOOL bInheritHandle;};using LPSECURITY_ATTRIBUTES=SECURITY_ATTRIBUTES*;
#define TRUE 1
#define FALSE 0
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
const DWORD ERROR_INVALID_PARAMETER=87,ERROR_GEN_FAILURE=31,ERROR_PIPE_BUSY=231,ERROR_ACCESS_DENIED=5;
const DWORD PIPE_ACCESS_INBOUND=1,FILE_FLAG_FIRST_PIPE_INSTANCE=0x80000,PIPE_TYPE_BYTE=0,PIPE_READMODE_BYTE=0,PIPE_WAIT=0,PIPE_REJECT_REMOTE_CLIENTS=8,GENERIC_WRITE=0x40000000,OPEN_EXISTING=3;
DWORD last_error=0,prepare_error=0,server_error=0,client_error=0,host_size=0;bool ac=true,random_ok=true,descriptor_alive=false;int creates=0,opens=0,closes=0,randoms=0,hosts=0,busy_count=0;LPSECURITY_ATTRIBUTES input_sa=nullptr,host_sa=nullptr;SECURITY_ATTRIBUTES effective{};std::wstring server_name;std::vector<std::wstring> names;
DWORD GetLastError(){return last_error;} void SetLastError(DWORD x){last_error=x;}
struct appcontainer_pipe_security {appcontainer_pipe_security(){assert(!descriptor_alive);descriptor_alive=true;}DWORD prepare(LPSECURITY_ATTRIBUTES s){input_sa=s;effective={sizeof(effective),(void*)99,s?s->bInheritHandle:FALSE};return prepare_error;}bool is_appcontainer(){return ac;}LPSECURITY_ATTRIBUTES get(){assert(descriptor_alive);return &effective;}~appcontainer_pipe_security(){assert(descriptor_alive);descriptor_alive=false;SetLastError(999);}};
BOOL RtlGenRandom(void* p,DWORD n){assert(n==16);++randoms;for(DWORD i=0;i<n;i++)((BYTE*)p)[i]=(BYTE)(i+randoms);return random_ok;}
HANDLE CreateNamedPipeW(const WCHAR* name,DWORD open,DWORD mode,DWORD instances,DWORD out,DWORD in,DWORD wait,LPSECURITY_ATTRIBUTES sa){++creates;assert(descriptor_alive);assert(open==(PIPE_ACCESS_INBOUND|FILE_FLAG_FIRST_PIPE_INSTANCE));assert(mode==PIPE_REJECT_REMOTE_CLIENTS);assert(instances==1&&out==in&&wait==0&&sa==&effective);server_name=name;names.push_back(name);assert(server_name.rfind(L"\\\\.\\pipe\\LOCAL\\msys-anon-",0)==0);assert(server_name.size()==25+32);if(creates<=busy_count){SetLastError(ERROR_PIPE_BUSY);return INVALID_HANDLE_VALUE;}if(server_error){SetLastError(server_error);return INVALID_HANDLE_VALUE;}return (HANDLE)11;}
HANDLE CreateFileW(const WCHAR* name,DWORD access,DWORD share,LPSECURITY_ATTRIBUTES sa,DWORD disposition,DWORD flags,HANDLE templ){++opens;assert(descriptor_alive);assert(name==server_name);assert(access==GENERIC_WRITE&&share==0&&sa==&effective&&disposition==OPEN_EXISTING&&flags==0&&!templ);if(client_error){SetLastError(client_error);return INVALID_HANDLE_VALUE;}return(HANDLE)12;}
BOOL CloseHandle(HANDLE h){assert(h==(HANDLE)11);++closes;SetLastError(777);return TRUE;}
BOOL CreatePipe(PHANDLE r,PHANDLE w,LPSECURITY_ATTRIBUTES sa,DWORD size){++hosts;host_sa=sa;host_size=size;assert(GetLastError()==42);if(r)*r=(HANDLE)21;if(w)*w=(HANDLE)22;SetLastError(123);return size!=999;}
void reset(){assert(!descriptor_alive);last_error=42;prepare_error=server_error=client_error=host_size=0;ac=random_ok=true;creates=opens=closes=randoms=hosts=busy_count=0;input_sa=host_sa=nullptr;server_name.clear();names.clear();}
