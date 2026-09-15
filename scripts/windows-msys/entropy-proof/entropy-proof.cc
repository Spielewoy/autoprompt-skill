/* Observational Win32 entropy diagnostic. Never emits random bytes or changes
   token privileges, capabilities, device ACLs or environment. */
#include <windows.h>
#include <sddl.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <stdexcept>
#include <cstring>
#include <cwchar>

namespace {
constexpr DWORD text_limit = 2048;
std::string quoted(const std::wstring &value) {
  if(value.size()>text_limit) throw std::runtime_error("text-bound");
  std::string out="\""; char part[7];
  for(wchar_t c:value){sprintf_s(part,"\\u%04x",static_cast<unsigned>(static_cast<uint16_t>(c)));out+=part;}
  return out+'"';
}
std::string number(DWORD value){return std::to_string(value);}
std::string json_boolean(bool value){return value?"true":"false";}
std::string status(LONG value){char text[11];sprintf_s(text,"\"%08x\"",static_cast<unsigned>(value));return text;}
struct Handle {HANDLE value=NULL;~Handle(){if(value)CloseHandle(value);}};
struct Identity {
 DWORD error=0; bool app=false; DWORD integrity=0; std::wstring user,package;
 std::string json() const {return "{\"error\":"+number(error)+",\"appContainer\":"+(error?"null":json_boolean(app))+",\"userSid\":"+(error?"null":quoted(user))+",\"packageSid\":"+(error?"null":quoted(package))+",\"integrityRid\":"+(error?"null":number(integrity))+"}";}
};
struct Query { union {ULONG_PTR align;BYTE bytes[4096];} data; DWORD length=0,error=0;
 bool get(HANDLE token,TOKEN_INFORMATION_CLASS kind){if(!GetTokenInformation(token,kind,data.bytes,sizeof data.bytes,&length)){error=GetLastError();return false;}if(length>sizeof data.bytes){error=ERROR_INVALID_DATA;return false;}return true;}
 PSID sid(size_t header,PSID value){uintptr_t begin=reinterpret_cast<uintptr_t>(data.bytes),p=reinterpret_cast<uintptr_t>(value);if(length<header||p<begin||p-begin<header||p-begin>length||length-(p-begin)<8){error=ERROR_INVALID_SID;return NULL;}BYTE count=*(reinterpret_cast<BYTE*>(value)+1);DWORD size=GetSidLengthRequired(count);if(size>length-(p-begin)||size>SECURITY_MAX_SID_SIZE||!IsValidSid(value)){error=ERROR_INVALID_SID;return NULL;}return value;}
};
bool sid_text(PSID sid,std::wstring &out,DWORD &error){LPWSTR text=NULL;if(!ConvertSidToStringSidW(sid,&text)){error=GetLastError();return false;}size_t length=wcsnlen_s(text,256);if(length>=256){LocalFree(text);error=ERROR_INVALID_DATA;return false;}out.assign(text,length);LocalFree(text);return true;}
Identity identity(HANDLE token){Identity id;Query q;
 if(!q.get(token,TokenIsAppContainer)||q.length!=sizeof(DWORD)){id.error=q.error?q.error:ERROR_INVALID_DATA;return id;}
 DWORD app=*reinterpret_cast<DWORD*>(q.data.bytes);if(app>1){id.error=ERROR_INVALID_DATA;return id;}id.app=app==1;
 if(!q.get(token,TokenUser)||q.length<sizeof(TOKEN_USER)){id.error=q.error?q.error:ERROR_INVALID_DATA;return id;}
 PSID user=q.sid(sizeof(TOKEN_USER),reinterpret_cast<TOKEN_USER*>(q.data.bytes)->User.Sid);if(!user||!sid_text(user,id.user,q.error)){id.error=q.error;return id;}
 if(id.app){if(!q.get(token,TokenAppContainerSid)||q.length<sizeof(TOKEN_APPCONTAINER_INFORMATION)){id.error=q.error?q.error:ERROR_INVALID_DATA;return id;}PSID package=q.sid(sizeof(TOKEN_APPCONTAINER_INFORMATION),reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(q.data.bytes)->TokenAppContainer);if(!package||!sid_text(package,id.package,q.error)){id.error=q.error;return id;}}
 if(!q.get(token,TokenIntegrityLevel)||q.length<sizeof(TOKEN_MANDATORY_LABEL)){id.error=q.error?q.error:ERROR_INVALID_DATA;return id;}
 PSID label=q.sid(sizeof(TOKEN_MANDATORY_LABEL),reinterpret_cast<TOKEN_MANDATORY_LABEL*>(q.data.bytes)->Label.Sid);if(!label){id.error=q.error;return id;}BYTE count=*GetSidSubAuthorityCount(label);if(count!=1||memcmp(GetSidIdentifierAuthority(label)->Value,"\0\0\0\0\0\20",6)!=0){id.error=ERROR_INVALID_SID;return id;}id.integrity=*GetSidSubAuthority(label,0);return id;
}
struct Library {
 HMODULE module=NULL;DWORD load_error=0,path_error=0,symbol_error=0;std::wstring path;
 explicit Library(const wchar_t *name){module=LoadLibraryExW(name,NULL,LOAD_LIBRARY_SEARCH_SYSTEM32);if(!module){load_error=GetLastError();return;}wchar_t text[text_limit+1];DWORD size=GetModuleFileNameW(module,text,text_limit+1);if(!size){path_error=GetLastError();return;}if(size>text_limit){path_error=ERROR_MORE_DATA;return;}path.assign(text,size);}
 ~Library(){if(module)FreeLibrary(module);}
 template<class T>T symbol(const char *name){if(!module)return NULL;FARPROC result=GetProcAddress(module,name);if(!result&&!symbol_error){symbol_error=GetLastError();if(!symbol_error)symbol_error=ERROR_PROC_NOT_FOUND;}return reinterpret_cast<T>(result);}
 std::string json()const{return "{\"loadError\":"+number(load_error)+",\"path\":"+(path_error||load_error?"null":quoted(path))+",\"pathError\":"+number(path_error)+",\"symbolError\":"+number(symbol_error)+"}";}
};
std::string environment(const wchar_t *name){wchar_t value[text_limit+1];SetLastError(ERROR_SUCCESS);DWORD size=GetEnvironmentVariableW(name,value,text_limit+1),error=GetLastError();if(!size&&error==ERROR_ENVVAR_NOT_FOUND)return "{\"present\":false,\"error\":203,\"value\":null}";if(size>text_limit)return "{\"present\":true,\"error\":234,\"value\":null}";if(!size&&error!=ERROR_SUCCESS)return "{\"present\":false,\"error\":"+number(error)+",\"value\":null}";return "{\"present\":true,\"error\":0,\"value\":"+quoted(std::wstring(value,size))+"}";}
std::string access_result(DWORD access,HANDLE handle,DWORD error){if(handle)CloseHandle(handle);return "{\"access\":"+number(access)+",\"success\":"+json_boolean(handle!=NULL)+",\"error\":"+number(handle?0:error)+"}";}
std::string self_access(bool process){const DWORD process_masks[]={PROCESS_QUERY_LIMITED_INFORMATION,PROCESS_QUERY_INFORMATION,PROCESS_QUERY_INFORMATION|PROCESS_VM_READ};const DWORD thread_masks[]={THREAD_QUERY_LIMITED_INFORMATION,THREAD_QUERY_INFORMATION};std::string result="[";size_t count=process?3:2;for(size_t i=0;i<count;i++){DWORD access=process?process_masks[i]:thread_masks[i];HANDLE h=process?OpenProcess(access,FALSE,GetCurrentProcessId()):OpenThread(access,FALSE,GetCurrentThreadId());DWORD error=h?0:GetLastError();if(i)result+=',';result+=access_result(access,h,error);}return result+']';}
std::string security(HANDLE handle){union {ULONG_PTR align;BYTE bytes[16384];} buffer;DWORD needed=0,error=0;LPWSTR sddl=NULL;std::string result="null";
 if(!GetKernelObjectSecurity(handle,DACL_SECURITY_INFORMATION,buffer.bytes,sizeof buffer.bytes,&needed))error=GetLastError();
 else if(!needed||needed>sizeof buffer.bytes||!IsValidSecurityDescriptor(buffer.bytes))error=ERROR_INVALID_SECURITY_DESCR;
 else if(!ConvertSecurityDescriptorToStringSecurityDescriptorW(buffer.bytes,SDDL_REVISION_1,DACL_SECURITY_INFORMATION,&sddl,NULL))error=GetLastError();
 else {size_t size=wcsnlen_s(sddl,text_limit+1);if(size>text_limit)error=ERROR_MORE_DATA;else result=quoted(std::wstring(sddl,size));LocalFree(sddl);}
 return "{\"error\":"+number(error)+",\"sddl\":"+result+"}";
}
std::string legacy_rng(){HCRYPTPROV provider=0;BYTE bytes[32]={};BOOL acquired=CryptAcquireContextW(&provider,NULL,NULL,PROV_RSA_FULL,CRYPT_VERIFYCONTEXT|CRYPT_SILENT);DWORD acquire_error=acquired?0:GetLastError();std::string generated="null",generate_error="null",released="null",release_error="null";
 if(acquired){BOOL success=CryptGenRandom(provider,sizeof bytes,bytes);DWORD error=success?0:GetLastError();generated=json_boolean(success!=FALSE);generate_error=number(error);SecureZeroMemory(bytes,sizeof bytes);success=CryptReleaseContext(provider,0);error=success?0:GetLastError();released=json_boolean(success!=FALSE);release_error=number(error);}
 return "{\"acquireSuccess\":"+json_boolean(acquired!=FALSE)+",\"acquireError\":"+number(acquire_error)+",\"generateSuccess\":"+generated+",\"generateError\":"+generate_error+",\"releaseSuccess\":"+released+",\"releaseError\":"+release_error+"}";
}

}
int wmain(int argc,wchar_t **){try{
 if(argc!=1)throw std::runtime_error("no-arguments-accepted");
 Handle primary,thread;Identity primary_id,thread_id;bool has_thread=OpenThreadToken(GetCurrentThread(),TOKEN_QUERY,TRUE,&thread.value)!=FALSE;DWORD thread_error=has_thread?0:GetLastError();
 if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&primary.value))primary_id.error=GetLastError();else primary_id=identity(primary.value);
 if(has_thread)thread_id=identity(thread.value);
 using Wow=BOOL(WINAPI*)(HANDLE,USHORT*,USHORT*);auto wow=reinterpret_cast<Wow>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"),"IsWow64Process2"));USHORT process_machine=0,native_machine=0;DWORD arch_error=0;if(!wow)arch_error=ERROR_PROC_NOT_FOUND;else if(!wow(GetCurrentProcess(),&process_machine,&native_machine))arch_error=GetLastError();
 Library bcrypt(L"bcrypt.dll"),advapi(L"advapi32.dll");
 using Generate=NTSTATUS(WINAPI*)(BCRYPT_ALG_HANDLE,PUCHAR,ULONG,ULONG);using Open=NTSTATUS(WINAPI*)(BCRYPT_ALG_HANDLE*,LPCWSTR,LPCWSTR,ULONG);using Close=NTSTATUS(WINAPI*)(BCRYPT_ALG_HANDLE,ULONG);using Rtl=BOOLEAN(APIENTRY*)(PVOID,ULONG);
 auto generate=bcrypt.symbol<Generate>("BCryptGenRandom");auto open=bcrypt.symbol<Open>("BCryptOpenAlgorithmProvider");auto close=bcrypt.symbol<Close>("BCryptCloseAlgorithmProvider");auto rtl=advapi.symbol<Rtl>("SystemFunction036");
 BYTE random[32]={};std::string system_status="null",open_status="null",provider_status="null",close_status="null",rtl_success="null",rtl_error="null";
 if(generate)system_status=status(generate(NULL,random,sizeof random,BCRYPT_USE_SYSTEM_PREFERRED_RNG));SecureZeroMemory(random,sizeof random);
 if(open&&close){BCRYPT_ALG_HANDLE provider=NULL;NTSTATUS result=open(&provider,BCRYPT_RNG_ALGORITHM,NULL,0);open_status=status(result);if(result==0&&!provider)throw std::runtime_error("null-rng-provider");if(result==0&&provider){if(generate)provider_status=status(generate(provider,random,sizeof random,0));SecureZeroMemory(random,sizeof random);close_status=status(close(provider,0));}else if(provider){close_status=status(close(provider,0));}}
 if(rtl){SetLastError(ERROR_SUCCESS);bool ok=rtl(random,sizeof random)!=FALSE;rtl_success=json_boolean(ok);rtl_error=number(ok?0:GetLastError());SecureZeroMemory(random,sizeof random);}
 const wchar_t *names[]={L"SYSTEMROOT",L"WINDIR",L"PATH",L"TEMP",L"TMP",L"LOCALAPPDATA",L"OPENSSL_CONF",L"OPENSSL_MODULES",L"NODE_OPTIONS",L"SYSTEMDRIVE",L"USERPROFILE",L"HOME",L"APPDATA"};
 std::string env="{";for(size_t i=0;i<sizeof(names)/sizeof(names[0]);i++){if(i)env+=',';env+=quoted(names[i])+':'+environment(names[i]);}env+='}';
 std::string legacy=legacy_rng(),process_access=self_access(true),thread_access=self_access(false),process_security=security(GetCurrentProcess()),thread_security=security(GetCurrentThread());
 std::string out="{\"schemaVersion\":1,\"identity\":{\"primary\":"+primary_id.json()+",\"threadTokenPresent\":"+json_boolean(has_thread)+",\"threadTokenError\":"+number(thread_error)+",\"thread\":"+(has_thread?thread_id.json():"null")+"},\"architecture\":{\"error\":"+number(arch_error)+",\"pointerBits\":"+number(sizeof(void*)*8)+",\"processMachine\":"+(arch_error?"null":number(process_machine))+",\"nativeMachine\":"+(arch_error?"null":number(native_machine))+"},\"libraries\":{\"bcrypt\":"+bcrypt.json()+",\"advapi\":"+advapi.json()+"},\"rng\":{\"systemStatus\":"+system_status+",\"openStatus\":"+open_status+",\"providerStatus\":"+provider_status+",\"closeStatus\":"+close_status+",\"rtlSuccess\":"+rtl_success+",\"rtlError\":"+rtl_error+"},\"environment\":"+env+",\"legacyRng\":"+legacy+",\"selfAccess\":{\"process\":"+process_access+",\"thread\":"+thread_access+"},\"security\":{\"process\":"+process_security+",\"thread\":"+thread_security+"}}\n";
 if(out.size()>131072)throw std::runtime_error("output-bound");if(fwrite(out.data(),1,out.size(),stdout)!=out.size()||fflush(stdout)!=0)return 1;return 0;
 }catch(const std::exception &error){fprintf(stderr,"entropy-diagnostic-refused:%s\n",error.what());return 1;}}
