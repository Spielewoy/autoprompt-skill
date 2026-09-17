#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
typedef void* HANDLE;
typedef uint32_t DWORD;
typedef uint32_t ULONG;
typedef uint32_t ACCESS_MASK;
typedef uint16_t USHORT;
typedef int32_t LONG;
typedef wchar_t WCHAR;
typedef void (*FARPROC)(void);
#define NTAPI
#define TRUE 1
#define FALSE 0
#define TOKEN_QUERY 8
#define TokenIsAppContainer 29
#define ERROR_INVALID_DATA 13
#define ERROR_INVALID_HANDLE 6
#define ERROR_ACCESS_DENIED 5
#define ERROR_PROC_NOT_FOUND 127
#define ERROR_INVALID_PARAMETER 87
#define ERROR_ENVVAR_NOT_FOUND 203
#define ERROR_NOT_ENOUGH_MEMORY 8
#define DUPLICATE_SAME_ACCESS 2
#define FILE_TYPE_CHAR 2
#define FILE_GENERIC_READ 0x120089u
#define FILE_GENERIC_WRITE 0x120116u
#define FILE_READ_ATTRIBUTES 0x80u
#define FILE_SHARE_READ 1
#define FILE_SHARE_WRITE 2
#define OPEN_EXISTING 3
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
typedef struct {DWORD nLength;void*lpSecurityDescriptor;int bInheritHandle;} SECURITY_ATTRIBUTES;
#define HANDLE_FLAG_INHERIT 1
#define CSTR_EQUAL 2
typedef struct {HANDLE handle;uintptr_t locator;} uv__nul_capability_t;
typedef struct {int active,type,object,inherit;DWORD access;} MockHandle;
static struct {
 DWORD error,value,returned;
 int token_ok,query_ok,env_present,duplicates,queries,type_queries,closed,env_reads;
 int replace_source,query_short,query_pointer_bad,missing_api,set_inherit_ok;
 int env_frees,allocations,allocation_calls,fail_allocation;
 int duplicate_error,duplicate_extra,token_closed,direct_opens;int fail_duplicate_at,extra_duplicate_at,malformed_string,query_status;DWORD direct_access;
 WCHAR locator[80];WCHAR inherited[160];size_t inherited_length;
 MockHandle handles[512];unsigned next;
} mock;
static size_t wide_length(const WCHAR* s){size_t n=0;while(s[n])n++;return n;}
static void wide_copy(WCHAR* d,const WCHAR* s){size_t n=wide_length(s)+1;memcpy(d,s,n*sizeof(WCHAR));}
static int wide_equal(const WCHAR*a,const WCHAR*b){while(*a&&*a==*b){a++;b++;}return *a==*b;}
static void reset(void){
 memset(&mock,0,sizeof mock);mock.token_ok=mock.query_ok=mock.set_inherit_ok=1;mock.value=1;mock.returned=4;mock.env_present=1;wide_copy(mock.locator,L"0000000000000100");mock.next=0x104;
 mock.handles[0x100]=(MockHandle){1,2,1,1,0x12019f};mock.inherited[0]=mock.inherited[1]=0;mock.inherited_length=2;
}
static HANDLE GetCurrentProcess(void){return(HANDLE)(intptr_t)-1;}
static DWORD GetLastError(void){return mock.error;}
static void SetLastError(DWORD error){mock.error=error;}
static int OpenProcessToken(HANDLE process,DWORD access,HANDLE*token){assert(process==GetCurrentProcess()&&access==TOKEN_QUERY);if(!mock.token_ok){mock.error=5;return 0;}*token=(HANDLE)(uintptr_t)0x900;return 1;}
static int GetTokenInformation(HANDLE token,int kind,void*data,DWORD size,DWORD*returned){assert(token==(HANDLE)(uintptr_t)0x900&&kind==29&&size==4);*returned=mock.returned;*(DWORD*)data=mock.value;if(!mock.query_ok){mock.error=5;return 0;}return 1;}
static int CloseHandle(HANDLE handle){uintptr_t n=(uintptr_t)handle;if(n==0x900){mock.token_closed++;return 1;}assert(n<512&&mock.handles[n].active);mock.handles[n].active=0;mock.closed++;mock.error=999;return 1;}
static DWORD GetEnvironmentVariableW(const WCHAR*key,WCHAR*buffer,DWORD capacity){assert(wide_equal(key,L"AUTOPROMPT_PRIVATE_NUL_HANDLE"));mock.env_reads++;if(!mock.env_present){mock.error=203;return 0;}size_t n=wide_length(mock.locator);if(n>=capacity)return(DWORD)n+1;memcpy(buffer,mock.locator,(n+1)*sizeof(WCHAR));return(DWORD)n;}
static int DuplicateHandle(HANDLE from,HANDLE source,HANDLE to,HANDLE*result,DWORD access,int inherit,DWORD flags){
 assert(from==GetCurrentProcess()&&to==GetCurrentProcess());uintptr_t n=(uintptr_t)source;mock.duplicates++;
 if(mock.duplicate_error||mock.fail_duplicate_at==mock.duplicates||n>=512||!mock.handles[n].active){mock.error=5;return 0;}
 unsigned next=mock.next++;assert(next<512);mock.handles[next]=mock.handles[n];mock.handles[next].inherit=inherit;mock.handles[next].access=flags==DUPLICATE_SAME_ACCESS?mock.handles[n].access:access;
 if(mock.duplicate_extra||mock.extra_duplicate_at==mock.duplicates)mock.handles[next].access|=0x1000000;
 *result=(HANDLE)(uintptr_t)next;
 if(mock.replace_source&&n==0x100){mock.handles[n].type=3;mock.handles[n].object=2;}
 return 1;
}
static int SetHandleInformation(HANDLE handle,DWORD mask,DWORD flags){assert(mask==1&&flags==1);if(!mock.set_inherit_ok){mock.error=5;return 0;}mock.handles[(uintptr_t)handle].inherit=1;return 1;}
static DWORD GetFileType(HANDLE handle){uintptr_t n=(uintptr_t)handle;assert(n!=0x100&&n<512&&mock.handles[n].active);assert(mock.handles[n].inherit==0 || mock.duplicates==2);mock.type_queries++;return(DWORD)mock.handles[n].type;}
static HANDLE GetModuleHandleW(const WCHAR*name){assert(wide_equal(name,L"ntdll.dll"));return(HANDLE)(uintptr_t)0x777;}
static LONG query_object(HANDLE,ULONG,void*,ULONG,ULONG*);
static FARPROC GetProcAddress(HANDLE module,const char*name){assert(module==(HANDLE)(uintptr_t)0x777&&strcmp(name,"NtQueryObject")==0);if(mock.missing_api)return NULL;union{FARPROC generic;LONG(*specific)(HANDLE,ULONG,void*,ULONG,ULONG*);}u;u.specific=query_object;return u.generic;}
static int CompareStringOrdinal(const WCHAR*a,int alen,const WCHAR*b,int blen,int ignore){assert(ignore);if(alen<0)alen=(int)wide_length(a);if(blen<0)blen=(int)wide_length(b);for(int i=0;i<alen&&i<blen;i++){WCHAR x=a[i],y=b[i];if(x>=L'a'&&x<=L'z')x-=32;if(y>=L'a'&&y<=L'z')y-=32;if(x!=y)return x<y?1:3;}return alen==blen?2:alen<blen?1:3;}

#define ERROR_DIRECTORY 267
#define ERROR_FILE_EXISTS 80
#define FILE_OPEN 1
#define FILE_CREATE 2
#define FILE_OPEN_IF 3
#define FILE_OPEN_FOR_BACKUP_INTENT 0x4000
#define FILE_SYNCHRONOUS_IO_NONALERT 0x20
#define FILE_WRITE_THROUGH 2
#define FILE_NO_INTERMEDIATE_BUFFERING 8
#define GENERIC_READ 0x80000000u
#define GENERIC_WRITE 0x40000000u
#define O_CLOEXEC 0x40000
#define O_DIRECTORY 0x200000
#define O_TMPFILE 0x800000
