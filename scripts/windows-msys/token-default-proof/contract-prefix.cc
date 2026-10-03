#include <cassert>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>
#include <iostream>
using DWORD=uint32_t; using ULONG=uint32_t; using NTSTATUS=int32_t; using BOOLEAN=uint8_t; using WCHAR=wchar_t;
static_assert(sizeof(ULONG)==4);
#define UNLEN 256
#define NT_SUCCESS(s) ((s)>=0)
struct cygsid { uint32_t value; };
struct ACL { int sentinel=77; }; using PACL=ACL*;
struct SD { ACL acl; }; using PSECURITY_DESCRIPTOR=SD*;
struct SECURITY_ATTRIBUTES { SD* lpSecurityDescriptor; }; using PSECURITY_ATTRIBUTES=SECURITY_ATTRIBUTES*;
struct TOKEN_DEFAULT_DACL { PACL DefaultDacl; };
enum { TokenPrimaryGroup=5, TokenUser=1, TokenOwner=4, TokenDefaultDacl=6, TokenIsAppContainer=29, DACL_SECURITY_INFORMATION=4 };
static int hProcToken=99;
struct Config { ULONG app=0, size=4; NTSTATUS query=0, user=0, group=0, owner=0, daclSet=0, processSet=0, getDacl=0; BOOLEAN aclExists=1; bool nullDacl=false; } cfg;
static std::vector<std::string> calls;
static SD inherited; static SECURITY_ATTRIBUTES sa{&inherited};
struct cygheap_user { struct { cygsid pgsid; } groups; cygsid effec_cygsid; std::string name; void init(); void set_name(const char*s){name=s;} cygsid* sid(){return &effec_cygsid;} };
DWORD GetEnvironmentVariableW(const WCHAR*,WCHAR*,DWORD){return 0;}
ULONG sys_wcstombs(char*,DWORD,const WCHAR*){return 0;}
NTSTATUS NtQueryInformationToken(int token,int klass,void*buf,ULONG length,ULONG*size){
 assert(token==99); calls.push_back("query:"+std::to_string(klass));
 if(klass==TokenIsAppContainer){assert(length==4); *size=cfg.size; std::memcpy(buf,&cfg.app,4);return cfg.query;}
 assert(length==sizeof(cygsid));*size=length; static_cast<cygsid*>(buf)->value=klass; return klass==TokenUser?cfg.user:cfg.group;
}
NTSTATUS NtSetInformationToken(int token,int klass,void*buf,ULONG size){assert(token==99);calls.push_back("set:"+std::to_string(klass));if(klass==TokenOwner){assert(size==sizeof(cygsid));return cfg.owner;}assert(klass==TokenDefaultDacl&&size==sizeof(TOKEN_DEFAULT_DACL));assert(static_cast<TOKEN_DEFAULT_DACL*>(buf)->DefaultDacl==&inherited.acl);return cfg.daclSet;}
PSECURITY_ATTRIBUTES sec_user_nih(PSECURITY_ATTRIBUTES,cygsid*){calls.push_back("sec_user_nih");return &sa;}
NTSTATUS RtlGetDaclSecurityDescriptor(SD*sd,BOOLEAN*exists,PACL*out,BOOLEAN*dummy){assert(sd==&inherited);calls.push_back("getdacl");*exists=cfg.aclExists;*dummy=0;*out=cfg.nullDacl?nullptr:&inherited.acl;return cfg.getDacl;}
int NtCurrentProcess(){return -1;}
NTSTATUS NtSetSecurityObject(int process,int klass,SD*sd){assert(process==-1&&klass==DACL_SECURITY_INFORMATION&&sd==&inherited);calls.push_back("setprocess");return cfg.processSet;}
void system_printf(const char*,...){calls.push_back("systemlog");}
void debug_printf(const char*,...){calls.push_back("debuglog");}
[[noreturn]] void api_fatal(const char*,...){calls.push_back("fatal");throw std::runtime_error("fatal");}
