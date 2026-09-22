/* Native Windows proposal. Link the actual hash-bound descriptor helper,
   not a model. This fixture never changes a filesystem or namespace DACL. */
#include <windows.h>
#include <sddl.h>
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <algorithm>
#include "appcontainer_pipe_security.h"

namespace {
struct Unicode { USHORT Length, MaximumLength; PWSTR Buffer; };
struct Attributes { ULONG Length; HANDLE RootDirectory; Unicode *ObjectName;
  ULONG Attributes; PSECURITY_DESCRIPTOR SecurityDescriptor; void *SecurityQualityOfService; };
struct NativeName {
  std::wstring text; Unicode unicode; Attributes attributes;
  NativeName(const std::wstring &name, PSECURITY_DESCRIPTOR sd=NULL):text(name) {
    if (text.empty() || text.size()>512) throw std::runtime_error("name-bound");
    unicode={static_cast<USHORT>(text.size()*2),static_cast<USHORT>((text.size()+1)*2),&text[0]};
    attributes={sizeof attributes,NULL,&unicode,0,sd,NULL};
  }
};
struct Handle {
  HANDLE value; explicit Handle(HANDLE h=NULL):value(h) {}
  ~Handle(){if(value && value!=INVALID_HANDLE_VALUE) CloseHandle(value);}
  Handle(const Handle&)=delete; Handle &operator=(const Handle&)=delete;
};
struct Local { void *value; Local():value(NULL){} ~Local(){if(value)LocalFree(value);} };
void need(bool ok,const char *why){if(!ok)throw std::runtime_error(why);}
void win(bool ok,const char *why){if(!ok){fprintf(stderr,"win32:%s:%lu\n",why,GetLastError());throw std::runtime_error(why);}}
void nt(LONG status,const char *why){if(status!=0){fprintf(stderr,"nt:%s:%08lx\n",why,static_cast<ULONG>(status));throw std::runtime_error(why);}}
std::wstring sid_text(PSID sid){need(sid && IsValidSid(sid),"invalid-sid");LPWSTR text=NULL;win(ConvertSidToStringSidW(sid,&text)!=FALSE,"sid-text");std::wstring result(text);LocalFree(text);return result;}
std::vector<BYTE> token_info(HANDLE token,TOKEN_INFORMATION_CLASS kind){DWORD length=0;GetTokenInformation(token,kind,NULL,0,&length);need(length>0&&length<=4096,"token-size");std::vector<BYTE> data(length);win(GetTokenInformation(token,kind,data.data(),length,&length)!=FALSE,"token-info");return data;}
struct Identity { std::wstring user,package; bool app; };
Identity identity(){Handle token;win(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value)!=FALSE,"open-token");auto flag=token_info(token.value,TokenIsAppContainer);need(flag.size()==sizeof(DWORD),"app-flag-size");Identity result;result.app=*reinterpret_cast<DWORD*>(flag.data())==1;auto user=token_info(token.value,TokenUser);result.user=sid_text(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid);if(result.app){auto package=token_info(token.value,TokenAppContainerSid);result.package=sid_text(reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(package.data())->TokenAppContainer);}return result;}
struct Native {
  using CreateEvent=LONG(NTAPI*)(PHANDLE,ACCESS_MASK,Attributes*,int,BOOLEAN);
  using CreateMutant=LONG(NTAPI*)(PHANDLE,ACCESS_MASK,Attributes*,BOOLEAN);
  using CreateSemaphore=LONG(NTAPI*)(PHANDLE,ACCESS_MASK,Attributes*,LONG,LONG);
  using CreateSection=LONG(NTAPI*)(PHANDLE,ACCESS_MASK,Attributes*,LARGE_INTEGER*,ULONG,ULONG,HANDLE);
  using CreateSymbolicLink=LONG(NTAPI*)(PHANDLE,ACCESS_MASK,Attributes*,Unicode*);
  using Open=LONG(NTAPI*)(PHANDLE,ACCESS_MASK,Attributes*);
  using QuerySymbolicLink=LONG(NTAPI*)(HANDLE,Unicode*,PULONG);
  using Query=LONG(NTAPI*)(HANDLE,SECURITY_INFORMATION,PSECURITY_DESCRIPTOR,ULONG,PULONG);
  CreateEvent event;CreateMutant mutant;CreateSemaphore semaphore;CreateSection section;CreateSymbolicLink symbolic_link;
  Open open_event,open_mutant,open_semaphore,open_section,open_symbolic_link;QuerySymbolicLink query_symbolic_link;Query query;
  template<typename T>T symbol(const char *name){auto p=GetProcAddress(GetModuleHandleW(L"ntdll.dll"),name);need(p!=NULL,"native-symbol");return reinterpret_cast<T>(p);}
  Native(){event=symbol<CreateEvent>("NtCreateEvent");mutant=symbol<CreateMutant>("NtCreateMutant");semaphore=symbol<CreateSemaphore>("NtCreateSemaphore");section=symbol<CreateSection>("NtCreateSection");symbolic_link=symbol<CreateSymbolicLink>("NtCreateSymbolicLinkObject");open_event=symbol<Open>("NtOpenEvent");open_mutant=symbol<Open>("NtOpenMutant");open_semaphore=symbol<Open>("NtOpenSemaphore");open_section=symbol<Open>("NtOpenSection");open_symbolic_link=symbol<Open>("NtOpenSymbolicLinkObject");query_symbolic_link=symbol<QuerySymbolicLink>("NtQuerySymbolicLinkObject");query=symbol<Query>("NtQuerySecurityObject");}
};
const wchar_t *kinds[]={L"event",L"section",L"mutex",L"semaphore"};
const DWORD full_rights[]={0x1f0003,0xf001f,0x1f0001,0x1f0003};
const wchar_t *pid_link_target=L"314159";
std::wstring object_name(const std::wstring &prefix,int variant,int kind){return prefix+L"\\adapted-v"+std::to_wstring(variant)+L"-"+kinds[kind];}
std::wstring pid_link_name(const std::wstring &prefix){return prefix+L"\\winpid.424242";}
void check_prefix(const std::wstring &prefix){need(prefix.size()<384&&prefix.find(L"\\BaseNamedObjects\\msys-")==0&&prefix.find(L"..") == std::wstring::npos,"owned-namespace-required");need(prefix.find(L'\\',1)==17&&prefix.find(L'\\',18)==std::wstring::npos,"namespace-prefix");}
std::vector<std::wstring> expected_sids(const Identity &id,int variant){if(variant==0)return{L"S-1-1-0",id.package};if(variant==1)return{id.user,L"S-1-5-32-544",L"S-1-5-18",id.package};return{id.user,L"S-1-5-18",id.package};}
void check_dacl(PSECURITY_DESCRIPTOR sd,const Identity &id,int variant,DWORD mask){
  need(IsValidSecurityDescriptor(sd)!=FALSE,"invalid-descriptor");BOOL present=FALSE,defaulted=FALSE;PACL acl=NULL;win(GetSecurityDescriptorDacl(sd,&present,&acl,&defaulted)!=FALSE,"descriptor-dacl");need(present&&acl&&IsValidAcl(acl),"explicit-dacl-required");auto expected=expected_sids(id,variant);need(acl->AceCount==expected.size(),"exact-ace-count");DWORD package_count=0;
  for(DWORD i=0;i<acl->AceCount;i++){void *raw=NULL;win(GetAce(acl,i,&raw)!=FALSE,"get-ace");auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);need(ace->Header.AceType==ACCESS_ALLOWED_ACE_TYPE&&ace->Header.AceFlags==0,"exact-allow-ace");need(ace->Mask==mask,"exact-effective-rights");auto sid=sid_text(&ace->SidStart);need(sid==expected[i],"preserved-ace-order-and-sid");if(sid==id.package)package_count++;}
  need(package_count==1,"exactly-one-package-ace");
}
void check_pid_dacl(PSECURITY_DESCRIPTOR sd,const Identity &id,DWORD package_mask){
  need(IsValidSecurityDescriptor(sd)!=FALSE,"invalid-pid-link-descriptor");BOOL present=FALSE,defaulted=FALSE;PACL acl=NULL;win(GetSecurityDescriptorDacl(sd,&present,&acl,&defaulted)!=FALSE,"pid-link-dacl");need(present&&acl&&IsValidAcl(acl)&&acl->AceCount==2,"pid-link-exact-ace-count");
  const std::wstring expected_sid[]={L"S-1-1-0",id.package};const DWORD expected_mask[]={1,package_mask};
  for(DWORD i=0;i<2;i++){void *raw=NULL;win(GetAce(acl,i,&raw)!=FALSE,"pid-link-get-ace");auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);need(ace->Header.AceType==ACCESS_ALLOWED_ACE_TYPE&&ace->Header.AceFlags==0,"pid-link-exact-allow-ace");need(ace->Mask==expected_mask[i]&&sid_text(&ace->SidStart)==expected_sid[i],"pid-link-exact-sid-and-rights");}
}
void check_low_label(PSECURITY_DESCRIPTOR sd){BOOL present=FALSE,defaulted=FALSE;PACL acl=NULL;win(GetSecurityDescriptorSacl(sd,&present,&acl,&defaulted)!=FALSE,"descriptor-label");need(present&&acl&&acl->AceCount==1,"low-label-count");void *raw=NULL;win(GetAce(acl,0,&raw)!=FALSE,"get-label");auto ace=static_cast<SYSTEM_MANDATORY_LABEL_ACE*>(raw);need(ace->Header.AceType==SYSTEM_MANDATORY_LABEL_ACE_TYPE&&ace->Header.AceFlags==0&&ace->Mask==SYSTEM_MANDATORY_LABEL_NO_WRITE_UP&&sid_text(&ace->SidStart)==L"S-1-16-4096","exact-low-no-write-up");}
std::vector<BYTE> effective_security(Native &native,HANDLE handle){ULONG length=0;native.query(handle,0x17,NULL,0,&length);need(length>0&&length<=65536,"object-security-bound");std::vector<BYTE> data(length);nt(native.query(handle,0x17,data.data(),length,&length),"object-security");return data;}
std::wstring query_pid_link(Native &native,HANDLE handle){wchar_t buffer[32]={};Unicode target={0,static_cast<USHORT>(sizeof buffer),buffer};ULONG returned=0;nt(native.query_symbolic_link(handle,&target,&returned),"query-pid-link");need(target.Length==wcslen(pid_link_target)*sizeof(wchar_t)&&target.Length<target.MaximumLength,"pid-link-target-length");buffer[target.Length/sizeof(wchar_t)]=L'\0';std::wstring value(buffer,target.Length/sizeof(wchar_t));need(value==pid_link_target,"pid-link-exact-numeric-target");return value;}
std::vector<BYTE> sd_bytes(PSECURITY_DESCRIPTOR sd){if(!sd)return{};need(IsValidSecurityDescriptor(sd)!=FALSE,"source-sd");DWORD size=GetSecurityDescriptorLength(sd);need(size&&size<=65536,"source-sd-bound");BYTE *p=static_cast<BYTE*>(sd);return std::vector<BYTE>(p,p+size);}
void set_source(int variant,const Identity &id,Local &source){std::wstring text;if(variant==0)text=L"D:(A;;GA;;;WD)";if(variant==1)text=L"D:(A;;GA;;;"+id.user+L")(A;;GA;;;BA)(A;;GA;;;SY)";if(variant==2)text=L"D:NO_ACCESS_CONTROL";if(!text.empty()){ULONG bytes;win(ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(),1,&source.value,&bytes)!=FALSE,"source-descriptor");}}
void marker(const std::wstring &file){Handle handle(CreateFileW(file.c_str(),GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL));win(handle.value!=INVALID_HANDLE_VALUE,"ready-exclusive");DWORD written=0;win(WriteFile(handle.value,"ready",5,&written,NULL)!=FALSE&&written==5,"ready-write");win(FlushFileBuffers(handle.value)!=FALSE,"ready-flush");}
bool release_present(const std::wstring &file){DWORD attr=GetFileAttributesW(file.c_str());if(attr==INVALID_FILE_ATTRIBUTES){DWORD error=GetLastError();need(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND,"release-check");return false;}need((attr&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))==0,"release-type");return true;}
void section_bytes(HANDLE section,int mode){BYTE *p=static_cast<BYTE*>(MapViewOfFile(section,FILE_MAP_READ|FILE_MAP_WRITE,0,0,4096));win(p!=NULL,"map-view");try{if(mode==0){p[0]=90;p[1]=0;}else if(mode==1){need(p[0]==90,"section-read-witness");p[1]=91;}else need(p[0]==90&&p[1]==91,"section-write-witness");}catch(...){UnmapViewOfFile(p);throw;}win(UnmapViewOfFile(p)!=FALSE,"unmap-view");}
void host_check(){auto id=identity();need(!id.app,"ordinary-host-required");Local source;set_source(0,id,source);SECURITY_ATTRIBUTES attrs={sizeof attrs,source.value,TRUE};auto bytes=sd_bytes(source.value);{appcontainer_pipe_security helper;SetLastError(1777);need(helper.prepare(&attrs)==0&&!helper.is_appcontainer()&&helper.get()==&attrs&&GetLastError()==1777,"host-pointer-and-error");need(sd_bytes(source.value)==bytes,"host-source-unchanged");}{appcontainer_pipe_security helper;need(helper.prepare(NULL)==0&&helper.get()==NULL,"host-null-pointer");}puts("host-check:passed");}
void create_hold(const std::wstring &prefix,const std::wstring &sid,const std::wstring &ready,const std::wstring &release){
  auto id=identity();need(id.app&&id.package==sid,"creator-exact-appcontainer");check_prefix(prefix);Native native;std::vector<HANDLE> handles;HANDLE pid_link=NULL;
  try{for(int variant=0;variant<4;variant++){Local source;set_source(variant,id,source);auto original=sd_bytes(source.value);SECURITY_ATTRIBUTES attrs={sizeof attrs,source.value,FALSE};
    for(int kind=0;kind<4;kind++){
      HANDLE created=NULL;
      {appcontainer_pipe_security helper;DWORD error=helper.prepare(variant==3?NULL:&attrs);need(error==0&&helper.is_appcontainer()&&helper.get()!=NULL&&helper.get()!=&attrs,"actual-helper-adaptation");need(sd_bytes(source.value)==original,"source-buffer-preserved");check_dacl(helper.get()->lpSecurityDescriptor,id,variant,GENERIC_ALL);NativeName name(object_name(prefix,variant,kind),helper.get()->lpSecurityDescriptor);LONG status=0;
        if(kind==0)status=native.event(&created,full_rights[kind],&name.attributes,0,FALSE);
        else if(kind==1){LARGE_INTEGER size;size.QuadPart=4096;status=native.section(&created,full_rights[kind],&name.attributes,&size,PAGE_READWRITE,SEC_COMMIT,NULL);}
        else if(kind==2)status=native.mutant(&created,full_rights[kind],&name.attributes,FALSE);
        else status=native.semaphore(&created,full_rights[kind],&name.attributes,0,2);
        if(status!=0){if(created)CloseHandle(created);nt(status,"create-owned-object");}
      }
      // Query after destruction of the helper to prove the native object owns
      // its descriptor independently of the helper/caller storage lifetime.
      need(created!=NULL,"created-handle");handles.push_back(created);auto effective=effective_security(native,created);check_dacl(effective.data(),id,variant,full_rights[kind]);check_low_label(effective.data());if(kind==1)section_bytes(created,0);printf("created:variant=%d:kind=%d:effective-descriptor=passed\n",variant,kind);
    }
  }
  {Local source;ULONG bytes=0;win(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:(A;;0x00000001;;;WD)",1,&source.value,&bytes)!=FALSE,"pid-link-source-descriptor");auto original=sd_bytes(source.value);SECURITY_ATTRIBUTES attrs={sizeof attrs,source.value,FALSE};std::wstring target_text(pid_link_target);Unicode target={static_cast<USHORT>(target_text.size()*sizeof(wchar_t)),static_cast<USHORT>((target_text.size()+1)*sizeof(wchar_t)),&target_text[0]};
    {appcontainer_pipe_security helper;DWORD error=helper.prepare(&attrs);need(error==0&&helper.is_appcontainer()&&helper.get()!=NULL&&helper.get()!=&attrs,"pid-link-actual-helper-adaptation");need(sd_bytes(source.value)==original,"pid-link-source-buffer-preserved");check_pid_dacl(helper.get()->lpSecurityDescriptor,id,GENERIC_ALL);NativeName name(pid_link_name(prefix),helper.get()->lpSecurityDescriptor);name.attributes.Attributes=0x40;LONG status=native.symbolic_link(&pid_link,0xf0001,&name.attributes,&target);if(status!=0){if(pid_link)CloseHandle(pid_link);pid_link=NULL;nt(status,"create-pid-link");}}
    need(pid_link!=NULL,"created-pid-link-handle");auto effective=effective_security(native,pid_link);check_pid_dacl(effective.data(),id,0xf0001);check_low_label(effective.data());query_pid_link(native,pid_link);puts("created:pid-link:target=314159:helper-world=00000001:helper-package=10000000:effective-world=00000001:effective-package=000f0001:low-label=passed");
  }
  fflush(stdout);marker(ready);ULONGLONG start=GetTickCount64();while(!release_present(release)){need(GetTickCount64()-start<30000,"release-deadline");Sleep(10);}
  for(size_t i=0;i<handles.size();i++){int kind=i%4;if(kind==0||kind==3)need(WaitForSingleObject(handles[i],0)==WAIT_OBJECT_0,"peer-operation-witness");else if(kind==1)section_bytes(handles[i],2);}
  for(auto &handle:handles){HANDLE owned=handle;handle=NULL;win(CloseHandle(owned)!=FALSE,"close-owned-object");}handles.clear();{HANDLE owned=pid_link;pid_link=NULL;win(CloseHandle(owned)!=FALSE,"close-owned-pid-link");}puts("creator:16:descriptor-and-peer-effects-passed");
  }catch(...){for(auto handle:handles)if(handle)CloseHandle(handle);if(pid_link)CloseHandle(pid_link);throw;}
}
void open_all(const std::wstring &prefix,const std::wstring &sid,bool allowed){auto id=identity();need(id.app&&id.package==sid,"opener-exact-appcontainer");check_prefix(prefix);Native native;unsigned count=0;
  for(int variant=0;variant<4;variant++)for(int kind=0;kind<4;kind++){NativeName name(object_name(prefix,variant,kind));Handle handle;LONG status;
    if(kind==0)status=native.open_event(&handle.value,EVENT_MODIFY_STATE|SYNCHRONIZE,&name.attributes);
    else if(kind==1)status=native.open_section(&handle.value,SECTION_MAP_READ|SECTION_MAP_WRITE,&name.attributes);
    else if(kind==2)status=native.open_mutant(&handle.value,MUTEX_MODIFY_STATE|SYNCHRONIZE,&name.attributes);
    else status=native.open_semaphore(&handle.value,SEMAPHORE_MODIFY_STATE|SYNCHRONIZE,&name.attributes);
    if(!allowed)need(static_cast<ULONG>(status)==0xc0000022&&handle.value==NULL,"other-profile-must-deny");
    else{nt(status,"same-profile-open");need(handle.value!=NULL,"open-handle");if(kind==0)win(SetEvent(handle.value)!=FALSE,"signal-event");else if(kind==1)section_bytes(handle.value,1);else if(kind==2){need(WaitForSingleObject(handle.value,0)==WAIT_OBJECT_0,"acquire-mutex");win(ReleaseMutex(handle.value)!=FALSE,"release-mutex");}else win(ReleaseSemaphore(handle.value,1,NULL)!=FALSE,"release-semaphore");}
    printf("open:variant=%d:kind=%d:status=%08lx:allowed=%d\n",variant,kind,static_cast<ULONG>(status),allowed?1:0);count++;
  }{NativeName name(pid_link_name(prefix));name.attributes.Attributes=0x40;Handle handle;LONG status=native.open_symbolic_link(&handle.value,1,&name.attributes);if(!allowed)need(static_cast<ULONG>(status)==0xc0000022&&handle.value==NULL,"other-profile-pid-link-must-deny");else{nt(status,"same-profile-pid-link-open");need(handle.value!=NULL,"open-pid-link-handle");query_pid_link(native,handle.value);}printf("open:pid-link:status=%08lx:allowed=%d:target=%s\n",static_cast<ULONG>(status),allowed?1:0,allowed?"314159":"denied");}printf("%s:%u:passed\n",allowed?"same-profile":"other-profile",count);
}
}
int wmain(int argc,wchar_t **argv){try{if(argc==2&&std::wstring(argv[1])==L"host-check")host_check();else if(argc==6&&std::wstring(argv[1])==L"create-hold")create_hold(argv[2],argv[3],argv[4],argv[5]);else if(argc==4&&(std::wstring(argv[1])==L"same-profile"||std::wstring(argv[1])==L"other-profile"))open_all(argv[2],argv[3],std::wstring(argv[1])==L"same-profile");else throw std::runtime_error("arguments");return 0;}catch(const std::exception &error){fprintf(stderr,"descriptor-proof-refused:%s\n",error.what());return 1;}}
