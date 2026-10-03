static unsigned cases;
static HANDLE result;
static DWORD error;
static bool invoke(DWORD access=GENERIC_READ,ULONG disposition=FILE_OPEN,ULONG options=FILE_SYNCHRONOUS_IO_NONALERT,int flags=0) {
 result=(HANDLE)(uintptr_t)0x999;error=123;
 return appcontainer_null_open(&result,access,disposition,options,flags,&error);
}
static void refused(DWORD expected=0) {
 assert(invoke());assert(error!=0);if(expected)assert(error==expected);
 assert(result==(HANDLE)(uintptr_t)0x999);
 for(unsigned n=0x104;n<mock.next;n++)assert(!mock.handles[n].active);
 assert(mock.handles[0x100].active);cases++;
}
static void success(DWORD access,DWORD expected,int flags=0,ULONG disposition=FILE_OPEN,ULONG options=FILE_SYNCHRONOUS_IO_NONALERT) {
 assert(invoke(access,disposition,options,flags)&&error==0);
 assert(mock.duplicates==2&&mock.closed==1);
 MockHandle out=mock.handles[(uintptr_t)result];assert(out.active&&out.type==2&&out.object==1);
 assert(out.access==expected&&out.inherit==!(flags&O_CLOEXEC));
 assert(mock.handles[0x100].active&&mock.handles[0x100].inherit==1);
 CloseHandle(result);cases++;
}
int main() {
 assert(sizeof(WCHAR)==2&&sizeof(DWORD)==4&&sizeof(null_basic_t)==56);
 reset();mock.value=0;assert(!invoke()&&error==0&&mock.env_reads==0&&mock.duplicates==0);cases++;
 reset();mock.env_present=0;assert(!invoke()&&error==0&&mock.duplicates==0);cases++;
 reset();mock.locator[0]=0;refused(ERROR_INVALID_DATA);
 const WCHAR*bad[]={L"100",L"0000000000000000",L"ffffffffffffffff",L"8000000000000000",L"000000000000010G",L"000000000000010A",L"00000000000001000"};
 for(auto value:bad){reset();wide_copy(mock.locator,value);refused();assert(mock.duplicates==0);}
 reset();mock.token_ok=0;refused(5);assert(mock.env_reads==0);
 reset();mock.query_ok=0;refused(5);assert(mock.token_closed==1);
 reset();mock.returned=8;refused(13);assert(mock.duplicates==0);
 reset();mock.value=2;refused(13);assert(mock.duplicates==0);
 reset();mock.duplicate_error=1;refused(5);assert(mock.queries==0);
 for(int type:{1,3}){reset();mock.handles[0x100].type=type;refused(6);assert(mock.queries==0&&mock.closed==1);}
 reset();mock.handles[0x100].object=2;refused();
 reset();mock.handles[0x100].access=FILE_GENERIC_READ;refused(5);
 reset();mock.handles[0x100].access|=0x1000000;refused(5);
 reset();mock.query_pointer_bad=1;refused(13);
 reset();mock.query_short=1;refused(13);
 reset();mock.missing_api=1;refused(127);
 reset();mock.query_status=1;refused(13);
 for(int kind=1;kind<=4;kind++){reset();mock.malformed_string=kind;refused(13);}
 reset();mock.replace_source=1;success(GENERIC_READ,FILE_GENERIC_READ);assert(mock.handles[0x100].type==3);
 reset();mock.fail_duplicate_at=2;refused(5);assert(mock.closed==1);
 reset();mock.extra_duplicate_at=2;refused(5);assert(mock.closed==2);
 const DWORD requests[]={GENERIC_READ,GENERIC_WRITE,GENERIC_READ|GENERIC_WRITE,GENERIC_WRITE|0x20080,0x20080,0x20000,0x180,GENERIC_READ|0x100000};
 const DWORD expected[]={FILE_GENERIC_READ,FILE_GENERIC_WRITE,0x12019f,FILE_GENERIC_WRITE|0x20080,0x20080,0x20000,0x180,FILE_GENERIC_READ};
 for(unsigned n=0;n<8;n++)for(int inherit:{0,O_CLOEXEC}){reset();success(requests[n],expected[n],inherit);}
 for(DWORD access:{0u,0x02000000u,0x10000000u,0x20000000u,0x40000u,0x80000u,0x10000u,0xffffffffu}){reset();assert(invoke(access)&&error==ERROR_ACCESS_DENIED&&mock.closed==1);cases++;}
 for(ULONG disposition:{0u,2u,4u,5u,6u}){reset();assert(invoke(GENERIC_READ,disposition)&&error==(disposition==2?ERROR_FILE_EXISTS:ERROR_INVALID_PARAMETER)&&mock.closed==1);cases++;}
 for(int flag:{O_DIRECTORY,O_TMPFILE}){reset();assert(invoke(GENERIC_READ,FILE_OPEN,0,flag)&&error==ERROR_DIRECTORY&&mock.closed==1);cases++;}
 for(ULONG option:{1u,0x10u,0x1000u,0xffffffffu}){reset();assert(invoke(GENERIC_READ,FILE_OPEN,option)&&error==ERROR_INVALID_PARAMETER&&mock.closed==1);cases++;}
 reset();success(GENERIC_READ,FILE_GENERIC_READ,0,FILE_OPEN_IF,0x402a);
 reset();mock.error=456;{null_owner owner;owner.value=(HANDLE)(uintptr_t)0x100;}assert(GetLastError()==456);cases++;
 printf("{\"cases\":%u,\"nativeWindows\":false,\"wcharBytes\":%zu,\"dwordBytes\":%zu}\n",cases,sizeof(WCHAR),sizeof(DWORD));
}
