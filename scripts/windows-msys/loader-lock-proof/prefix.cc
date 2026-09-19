// Portable ABI seam only; these mocks do not model Windows access enforcement.
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#define NTAPI
using LONG=int32_t;using ULONG=uint32_t;using DWORD=uint32_t;using BOOL=int32_t;using BOOLEAN=uint8_t;using UCHAR=uint8_t;using ACCESS_MASK=uint32_t;using SECURITY_INFORMATION=uint32_t;using SECURITY_DESCRIPTOR_CONTROL=uint16_t;
using VOID=void;using HANDLE=void*;using PVOID=void*;using PSID=void*;using PSECURITY_DESCRIPTOR=void*;using PACL=void*;using PHANDLE=HANDLE*;using PULONG=ULONG*;using PDWORD=DWORD*;using PBOOLEAN=BOOLEAN*;using PUCHAR=UCHAR*;using PBOOL=BOOL*;using PSECURITY_DESCRIPTOR_CONTROL=SECURITY_DESCRIPTOR_CONTROL*;
struct SID_IDENTIFIER_AUTHORITY{UCHAR Value[6];};using PSID_IDENTIFIER_AUTHORITY=SID_IDENTIFIER_AUTHORITY*;
struct SECURITY_DESCRIPTOR_RELATIVE{UCHAR revision,rm;uint16_t control;uint32_t offsets[4];};
enum TOKEN_INFORMATION_CLASS{TokenUser,TokenIsAppContainer};enum ACL_INFORMATION_CLASS{AclSizeInformation};enum WELL_KNOWN_SID_TYPE{WinLocalSystemSid,OtherSid};
constexpr BOOL TRUE=1,FALSE=0;constexpr DWORD ERROR_SUCCESS=0,ERROR_INVALID_PARAMETER=87,ERROR_INVALID_SECURITY_DESCR=1338;constexpr ULONG SECURITY_LOCAL_SYSTEM_RID=18;constexpr DWORD SECURITY_DESCRIPTOR_REVISION=1;constexpr SECURITY_DESCRIPTOR_CONTROL SE_SELF_RELATIVE=0x8000;
#define SECURITY_NT_AUTHORITY {{0,0,0,0,0,5}}
static DWORD last_error=777;static LONG next_status=0;static int calls=0;static ULONG relative_size=20,revision_value=1;static SECURITY_DESCRIPTOR_CONTROL control_value=0;static bool valid_absolute=true,valid_relative=true,rm_present=true;static UCHAR rm_value=42;static ULONG sid_subauthority=0;static int absolute_calls=0,relative_calls=0;
void SetLastError(DWORD e){last_error=e;}
