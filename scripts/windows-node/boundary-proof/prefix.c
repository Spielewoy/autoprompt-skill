/* Native boundaries are mocked. Compile exact candidate C function bodies.
 * This checks logic/arguments/lifetimes, not Windows token or NULL-SA behavior. */
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
typedef void* HANDLE;
typedef uint32_t DWORD; /* Windows DWORD is32-bit even on LP64 hosts. */
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define TOKEN_QUERY 8
#define TRUE 1
#define WRITE_DAC 0x40000
#define PIPE_ACCESS_INBOUND 1
#define PIPE_ACCESS_OUTBOUND 2
#define FILE_FLAG_OVERLAPPED 0x40000000
#define GENERIC_READ 0x80000000
#define GENERIC_WRITE 0x40000000
#define FILE_READ_ATTRIBUTES 0x80
#define FILE_WRITE_ATTRIBUTES 0x100
#define OPEN_EXISTING 3
#define ERROR_PIPE_CONNECTED 535
#define UV_READABLE_PIPE 1
#define UV_WRITABLE_PIPE 2
#define UV_NONBLOCK_PIPE 4
typedef int BOOL;
typedef struct { DWORD nLength;void* lpSecurityDescriptor;int bInheritHandle;} SECURITY_ATTRIBUTES;
#define TokenIsAppContainer 29
#define ERROR_INVALID_DATA 13
#define ERROR_INSUFFICIENT_BUFFER 122
#define ERROR_ACCESS_DENIED 5
#define ERROR_PIPE_BUSY 231
#define FILE_FLAG_FIRST_PIPE_INSTANCE 0x80000
#define PIPE_TYPE_BYTE 0
#define PIPE_READMODE_BYTE 0
#define PIPE_WAIT 0
static struct {
  int open_ok, query_ok, close_ok, open_calls, query_calls, close_calls, creates;
  DWORD value, returned, open_error, query_error, close_error, last_error, pid;
  int errors[64], error_count;
  char names[64][64];
  DWORD server_access,client_access,client_flags,client_error,connect_error;
  int inherit,client_calls,pipe_closes;
} state;
static void reset(void) {
  memset(&state,0,sizeof(state));state.open_ok=state.query_ok=state.close_ok=1;
  state.returned=sizeof(DWORD);state.pid=4242;state.server_access=0x40000003;
}
static HANDLE GetCurrentProcess(void){return(HANDLE)(intptr_t)0x111;}
/* Host-only varargs shim: Windows DWORD is unsigned long32, while Linux
 * printf %lu expects unsigned long64. Token/query DWORDs remain exact32-bit. */
static unsigned long GetCurrentProcessId(void){return (unsigned long)state.pid;}
static DWORD GetLastError(void){return state.last_error;}
static int OpenProcessToken(HANDLE process,DWORD access,HANDLE* token){
  assert(process==GetCurrentProcess()&&access==TOKEN_QUERY);state.open_calls++;
  if(!state.open_ok){state.last_error=state.open_error;return 0;}
  *token=(HANDLE)(intptr_t)0x222;return 1;
}
static int GetTokenInformation(HANDLE token,int kind,void* value,DWORD size,DWORD* returned){
  assert(token==(HANDLE)(intptr_t)0x222&&kind==TokenIsAppContainer&&size==sizeof(DWORD));
  state.query_calls++;*returned=state.returned;*(DWORD*)value=state.value;
  if(!state.query_ok){state.last_error=state.query_error;return 0;}return 1;
}
static int CloseHandle(HANDLE handle){
  if(handle==(HANDLE)(intptr_t)0xbeef||handle==(HANDLE)(intptr_t)0xcafe){state.pipe_closes++;return 1;}
  assert(handle==(HANDLE)(intptr_t)0x222);state.close_calls++;
  if(!state.close_ok){state.last_error=state.close_error;return 0;}return 1;
}
static HANDLE CreateNamedPipeA(const char* name,DWORD access,DWORD mode,DWORD instances,
                              DWORD out_size,DWORD in_size,DWORD timeout,void* attributes){
  assert(state.creates<64&&strlen(name)<64);strcpy(state.names[state.creates],name);
  assert(access==(state.server_access|FILE_FLAG_FIRST_PIPE_INSTANCE));
  assert(mode==0&&instances==1&&out_size==65536&&in_size==65536&&timeout==0);
  assert(attributes==NULL); /* Preserve actual default attributes; not an ACL proof. */
  int index=state.creates++;
  if(index<state.error_count){state.last_error=state.errors[index];return INVALID_HANDLE_VALUE;}
  return(HANDLE)(intptr_t)0xbeef;
}

static HANDLE CreateFileA(const char* name,DWORD access,DWORD share,SECURITY_ATTRIBUTES* sa,DWORD disposition,DWORD flags,void* template){
 assert(strcmp(name,state.names[state.creates-1])==0);assert(access==state.client_access&&share==0&&disposition==OPEN_EXISTING&&flags==state.client_flags&&template==NULL);
 assert(sa&&sa->nLength==sizeof(*sa)&&sa->lpSecurityDescriptor==NULL&&sa->bInheritHandle==state.inherit);state.client_calls++;
 if(state.client_error){state.last_error=state.client_error;return INVALID_HANDLE_VALUE;}return(HANDLE)(intptr_t)0xcafe;
}
static BOOL GetNamedPipeHandleState(HANDLE handle,DWORD* mode,void*a,void*b,void*c,void*d,int e){assert(handle==(HANDLE)(intptr_t)0xcafe&&!a&&!b&&!c&&!d&&!e);*mode=0;return TRUE;}
static BOOL ConnectNamedPipe(HANDLE handle,void* overlapped){assert(handle==(HANDLE)(intptr_t)0xbeef&&!overlapped);if(state.connect_error){state.last_error=state.connect_error;return 0;}return 1;}
