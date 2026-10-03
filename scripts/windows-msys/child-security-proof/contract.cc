#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
using DWORD = uint32_t; using DWORD64 = uint64_t; using SIZE_T = size_t; using BOOL = int;
constexpr BOOL FALSE=0,TRUE=1;
constexpr DWORD ERROR_SUCCESS=0,ERROR_INVALID_PARAMETER=87,ERROR_INSUFFICIENT_BUFFER=122,ERROR_NOT_ENOUGH_MEMORY=8;
constexpr DWORD EXTENDED_STARTUPINFO_PRESENT=0x00080000;
constexpr uintptr_t PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY=0x00020007;
struct SECURITY_ATTRIBUTES{DWORD marker;}; using LPSECURITY_ATTRIBUTES=SECURITY_ATTRIBUTES *;
struct STARTUPINFOW{DWORD cb,marker[8];unsigned char *lpReserved2;uint16_t cbReserved2;}; using LPSTARTUPINFOW=STARTUPINFOW *;
struct PROC_THREAD_ATTRIBUTE_LIST{uint64_t marker[8];}; using PPROC_THREAD_ATTRIBUTE_LIST=PROC_THREAD_ATTRIBUTE_LIST *;
struct STARTUPINFOEXW{STARTUPINFOW StartupInfo;PPROC_THREAD_ATTRIBUTE_LIST lpAttributeList;};
static DWORD last_error,prepare_error,native_error=5,current_package;
static bool container,native_success,spawn_cygwin;
static int prepared,destroyed,native_calls,live,heap_allocs,heap_frees,attr_initializes,attr_deletes,attr_updates,attr_failure;
static LPSECURITY_ATTRIBUTES expected_source;static SECURITY_ATTRIBUTES owned;static PROC_THREAD_ATTRIBUTE_LIST attribute_storage;static int process_heap;
static DWORD GetLastError(){return last_error;} static void SetLastError(DWORD value){last_error=value;} static void require(bool value){if(!value)std::abort();}
static void *GetProcessHeap(){return &process_heap;}
static void *HeapAlloc(void *heap,DWORD flags,SIZE_T bytes){require(heap==&process_heap&&flags==0&&bytes==sizeof attribute_storage);++heap_allocs;if(attr_failure==2)return nullptr;return &attribute_storage;}
static BOOL HeapFree(void *heap,DWORD flags,void *value){require(heap==&process_heap&&flags==0&&value==&attribute_storage);++heap_frees;SetLastError(9001);return TRUE;}
static BOOL InitializeProcThreadAttributeList(PPROC_THREAD_ATTRIBUTE_LIST list,DWORD count,DWORD flags,SIZE_T *bytes){
 require(count==1&&flags==0&&bytes);if(!list){*bytes=attr_failure==1?0:sizeof attribute_storage;SetLastError(attr_failure==1?5:ERROR_INSUFFICIENT_BUFFER);return FALSE;}
 require(list==&attribute_storage&&*bytes==sizeof attribute_storage);++attr_initializes;if(attr_failure==3){SetLastError(50);return FALSE;}return TRUE;
}
static BOOL UpdateProcThreadAttribute(PPROC_THREAD_ATTRIBUTE_LIST list,DWORD flags,uintptr_t attribute,void *value,SIZE_T bytes,void *previous,SIZE_T *returned){
 require(list==&attribute_storage&&flags==0&&attribute==PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY&&bytes==sizeof(DWORD64)&&!previous&&!returned);
 require(*static_cast<DWORD64 *>(value)==(2ULL<<20));++attr_updates;if(attr_failure==4){SetLastError(87);return FALSE;}return TRUE;
}
static void DeleteProcThreadAttributeList(PPROC_THREAD_ATTRIBUTE_LIST list){require(list==&attribute_storage);++attr_deletes;SetLastError(9002);}
class appcontainer_pipe_security{
 LPSECURITY_ATTRIBUTES result_=nullptr;
public:
 appcontainer_pipe_security(){++live;}~appcontainer_pipe_security(){--live;++destroyed;SetLastError(9999);}
 DWORD prepare(LPSECURITY_ATTRIBUTES source){++prepared;require(source==expected_source);if(prepare_error)return prepare_error;owned.marker=current_package;result_=container?&owned:source;return 0;}
 LPSECURITY_ATTRIBUTES get()const{return result_;}bool is_appcontainer()const{return container;}
};
/* EXACT_ADAPTER */

static wchar_t image[]=L"child.exe",command[]=L"child.exe input";static wchar_t *forking_progname=image,*runpath=image,*wcmd=command;
static void *envblock=&native_calls;static DWORD c_flags=0x123456;static STARTUPINFOW si;static int pi;
static wchar_t *GetCommandLineW(){return command;}static struct{wchar_t *wcs(wchar_t *buffer){require(buffer==command);return buffer;}}cmd;
static struct{bool iscygexec()const{return spawn_cygwin;}}real_path;static bool fork_call;
static BOOL CreateProcessW(wchar_t *image_arg,wchar_t *command_arg,LPSECURITY_ATTRIBUTES process,LPSECURITY_ATTRIBUTES thread,BOOL inherit,DWORD flags,void *environment,void *cwd,LPSTARTUPINFOW startup,int *process_info){
 ++native_calls;require(live==1&&process==thread&&process==(container?&owned:expected_source));if(container)require(process->marker==current_package);
 require(image_arg==image&&command_arg==command&&inherit==TRUE&&cwd==nullptr&&process_info==&pi);bool policy=container&&(fork_call||spawn_cygwin);
 require(flags==(policy?(c_flags|EXTENDED_STARTUPINFO_PRESENT):c_flags));if(policy){require(startup!=&si&&startup->cb==sizeof(STARTUPINFOEXW));STARTUPINFOW expected=si;expected.cb=sizeof(STARTUPINFOEXW);require(std::memcmp(startup,&expected,sizeof expected)==0);}else require(startup==&si);
 require(environment==(fork_call?nullptr:envblock));SetLastError(native_error);return native_success;
}
static BOOL fork_create(LPSECURITY_ATTRIBUTES sa){BOOL rc;/* EXACT_FORK_CALL */return rc;}
static BOOL spawn_create(LPSECURITY_ATTRIBUTES sa){BOOL rc;/* EXACT_SPAWN_CALL */return rc;}
static void reset(){prepared=destroyed=native_calls=live=heap_allocs=heap_frees=attr_initializes=attr_deletes=attr_updates=0;}
int main(){
 SECURITY_ATTRIBUTES source{0xabc};std::memset(&si,0x5a,sizeof si);si.cb=sizeof si;static unsigned char reserved[]={1,2,3,4};si.lpReserved2=reserved;si.cbReserved2=sizeof reserved;int cases=0;
 for(bool is_fork:{false,true}){fork_call=is_fork;for(bool is_container:{false,true})for(bool cygwin:{false,true}){container=is_container;spawn_cygwin=cygwin;for(auto original:{&source,static_cast<LPSECURITY_ATTRIBUTES>(nullptr)}){expected_source=original;for(bool succeeds:{false,true}){
  native_success=succeeds;prepare_error=attr_failure=0;native_error=succeeds?4321:5;++current_package;reset();BOOL result=is_fork?fork_create(original):spawn_create(original);bool policy=container&&(is_fork||cygwin);
  require(result==succeeds&&GetLastError()==native_error&&prepared==1&&destroyed==1&&native_calls==1&&live==0);require(heap_allocs==(policy?1:0)&&heap_frees==heap_allocs);require(attr_initializes==(policy?1:0)&&attr_updates==(policy?1:0)&&attr_deletes==(policy?1:0));require(source.marker==0xabc);++cases;
 }}}}
 container=true;spawn_cygwin=true;fork_call=false;expected_source=&source;
 for(DWORD error:{DWORD(5),DWORD(8),DWORD(1338)}){prepare_error=error;attr_failure=0;reset();require(!spawn_create(&source)&&GetLastError()==error&&native_calls==0&&heap_allocs==0&&live==0);++cases;}
 prepare_error=0;for(int stage:{1,2,3,4}){attr_failure=stage;reset();require(!spawn_create(&source)&&native_calls==0&&live==0);require(GetLastError()==(stage==1?5:stage==2?ERROR_NOT_ENOUGH_MEMORY:stage==3?50:87));require(heap_frees==(stage>=3?1:0)&&attr_deletes==(stage==4?1:0));++cases;}
 attr_failure=0;c_flags|=EXTENDED_STARTUPINFO_PRESENT;reset();require(!spawn_create(&source)&&GetLastError()==ERROR_INVALID_PARAMETER&&native_calls==0&&heap_allocs==0&&live==0);++cases;c_flags&=~EXTENDED_STARTUPINFO_PRESENT;
 std::printf("Child creation: %d exact-source contract cases passed.\n",cases);
}
