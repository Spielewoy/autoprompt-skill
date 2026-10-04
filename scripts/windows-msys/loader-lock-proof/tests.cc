namespace appcontainer_nt { extern "C" {
ULONG RtlNtStatusToDosError(LONG status){assert(status<0);return 5;}
LONG NtOpenProcessToken(HANDLE process,ACCESS_MASK access,PHANDLE result){assert(process==(void*)1&&access==8);calls++;if(next_status>=0)*result=(void*)2;return next_status;}
LONG NtQueryInformationToken(HANDLE token,TOKEN_INFORMATION_CLASS kind,PVOID data,ULONG size,PULONG returned){assert(token==(void*)2&&kind==TokenIsAppContainer&&size==4);calls++;*returned=4;if(next_status>=0)*static_cast<ULONG*>(data)=1;return next_status;}
LONG RtlGetControlSecurityDescriptor(PSECURITY_DESCRIPTOR sd,PSECURITY_DESCRIPTOR_CONTROL control,PULONG revision){assert(sd);calls++;*control=control_value;*revision=revision_value;return next_status;}
BOOLEAN RtlValidSecurityDescriptor(PSECURITY_DESCRIPTOR sd){assert(sd);absolute_calls++;return valid_absolute;}
BOOLEAN RtlValidRelativeSecurityDescriptor(PSECURITY_DESCRIPTOR sd,ULONG size,SECURITY_INFORMATION info){assert(sd&&size==relative_size&&info==0);relative_calls++;return valid_relative;}
ULONG RtlLengthSecurityDescriptor(PSECURITY_DESCRIPTOR sd){assert(sd);return relative_size;}
LONG RtlGetOwnerSecurityDescriptor(PSECURITY_DESCRIPTOR sd,PSID *sid,PBOOLEAN flag){assert(sd);*sid=(void*)3;*flag=1;return next_status;}
LONG RtlGetGroupSecurityDescriptor(PSECURITY_DESCRIPTOR sd,PSID *sid,PBOOLEAN flag){return RtlGetOwnerSecurityDescriptor(sd,sid,flag);}
LONG RtlGetDaclSecurityDescriptor(PSECURITY_DESCRIPTOR sd,PBOOLEAN present,PACL *acl,PBOOLEAN flag){assert(sd);*present=1;*flag=0;*acl=(void*)4;return next_status;}
LONG RtlGetSaclSecurityDescriptor(PSECURITY_DESCRIPTOR sd,PBOOLEAN present,PACL *acl,PBOOLEAN flag){return RtlGetDaclSecurityDescriptor(sd,present,acl,flag);}
BOOLEAN RtlGetSecurityDescriptorRMControl(PSECURITY_DESCRIPTOR sd,PUCHAR value){assert(sd);if(rm_present)*value=rm_value;return rm_present;}
VOID RtlSetSecurityDescriptorRMControl(PSECURITY_DESCRIPTOR sd,PUCHAR value){assert(sd);rm_value=*value;}
LONG RtlInitializeSid(PSID sid,PSID_IDENTIFIER_AUTHORITY authority,UCHAR count){assert(sid&&authority->Value[5]==5&&count==1);calls++;return next_status;}
PULONG RtlSubAuthoritySid(PSID sid,ULONG index){assert(sid&&index==0);return &sid_subauthority;}
LONG RtlSetOwnerSecurityDescriptor(PSECURITY_DESCRIPTOR sd,PSID sid,BOOLEAN flag){assert(sd&&sid&&flag==1);return next_status;}
LONG RtlSetGroupSecurityDescriptor(PSECURITY_DESCRIPTOR sd,PSID sid,BOOLEAN flag){return RtlSetOwnerSecurityDescriptor(sd,sid,flag);}
LONG RtlSetDaclSecurityDescriptor(PSECURITY_DESCRIPTOR sd,BOOLEAN present,PACL acl,BOOLEAN flag){assert(sd&&present==1&&acl&&flag==0);return next_status;}
LONG RtlSetSaclSecurityDescriptor(PSECURITY_DESCRIPTOR sd,BOOLEAN present,PACL acl,BOOLEAN flag){return RtlSetDaclSecurityDescriptor(sd,present,acl,flag);}
} }
int main(){namespace n=appcontainer_nt;int checks=0;auto test=[&](bool value){assert(value);checks++;};void* sd=(void*)1;
 test(n::success(0)&&last_error==777);test(n::success(1));test(!n::success(-1)&&last_error==5);
 HANDLE token=nullptr;test(n::OpenProcessToken(sd,8,&token)&&token==(void*)2);next_status=-1;test(!n::OpenProcessToken(sd,8,&token)&&last_error==5);next_status=0;
 ULONG value=0;DWORD returned=0;test(n::GetTokenInformation(token,TokenIsAppContainer,&value,4,&returned)&&value==1&&returned==4);next_status=-1;test(!n::GetTokenInformation(token,TokenIsAppContainer,&value,4,&returned)&&returned==4&&last_error==5);next_status=0;
 int previous=calls;test(!n::IsValidSecurityDescriptor(nullptr)&&calls==previous);test(n::IsValidSecurityDescriptor(sd)&&absolute_calls==1&&relative_calls==0);valid_absolute=false;test(!n::IsValidSecurityDescriptor(sd));valid_absolute=true;
 control_value=SE_SELF_RELATIVE;test(n::IsValidSecurityDescriptor(sd)&&relative_calls==1&&absolute_calls==2);relative_size=19;test(!n::IsValidSecurityDescriptor(sd)&&relative_calls==1);relative_size=128*1024+1;test(!n::IsValidSecurityDescriptor(sd)&&relative_calls==1);relative_size=20;valid_relative=false;test(!n::IsValidSecurityDescriptor(sd));valid_relative=true;revision_value=2;test(!n::IsValidSecurityDescriptor(sd));revision_value=1;next_status=-1;test(!n::IsValidSecurityDescriptor(sd));next_status=0;
 BOOL flag=-1,present=-1;PSID sid=nullptr;PACL acl=nullptr;test(n::GetSecurityDescriptorOwner(sd,&sid,&flag)&&flag==1&&sid==(void*)3);flag=-1;test(n::GetSecurityDescriptorGroup(sd,&sid,&flag)&&flag==1);test(n::GetSecurityDescriptorDacl(sd,&present,&acl,&flag)&&present==1&&flag==0&&acl==(void*)4);present=flag=-1;test(n::GetSecurityDescriptorSacl(sd,&present,&acl,&flag)&&present==1&&flag==0);next_status=-1;present=flag=123;test(!n::GetSecurityDescriptorDacl(sd,&present,&acl,&flag)&&present==123&&flag==123&&last_error==5);next_status=0;
 UCHAR rm=0;test(n::GetSecurityDescriptorRMControl(sd,&rm)==0&&rm==42);rm_present=false;test(n::GetSecurityDescriptorRMControl(sd,&rm)==ERROR_INVALID_SECURITY_DESCR);rm_present=true;rm=91;test(n::SetSecurityDescriptorRMControl(sd,&rm)==0&&rm_value==91);rm_present=false;test(n::SetSecurityDescriptorRMControl(sd,&rm)==ERROR_INVALID_SECURITY_DESCR);rm_present=true;
 DWORD size=12;test(n::CreateWellKnownSid(WinLocalSystemSid,nullptr,sd,&size)&&size==12&&sid_subauthority==18);size=11;test(!n::CreateWellKnownSid(WinLocalSystemSid,nullptr,sd,&size)&&last_error==87);size=12;test(!n::CreateWellKnownSid(OtherSid,nullptr,sd,&size));test(!n::CreateWellKnownSid(WinLocalSystemSid,sd,sd,&size));
 test(n::SetSecurityDescriptorOwner(sd,sid,123));test(n::SetSecurityDescriptorGroup(sd,sid,-1));test(n::SetSecurityDescriptorDacl(sd,123,acl,0));test(n::SetSecurityDescriptorSacl(sd,-1,acl,0));next_status=-1;test(!n::SetSecurityDescriptorSacl(sd,1,acl,0)&&last_error==5);
 std::printf("Direct Nt/Rtl ABI contracts passed: %d\n",checks);
}
