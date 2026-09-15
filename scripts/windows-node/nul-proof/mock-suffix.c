static LONG query_object(HANDLE handle,ULONG kind,void*output,ULONG size,ULONG*returned){
 uintptr_t n=(uintptr_t)handle;assert(n!=0x100&&n<512&&mock.handles[n].active);mock.queries++;
 if(kind==0){assert(size==sizeof(uv__nul_basic_t));uv__nul_basic_t*basic=output;memset(basic,0,size);basic->granted_access=mock.handles[n].access;*returned=mock.query_short?4:size;return 0;}
 assert((kind==1||kind==2)&&size==4096);uv__nul_string_t*name=output;
 const WCHAR*value=kind==2?L"File":mock.handles[n].object==1?L"\\Device\\Null":L"\\Device\\Other";
 size_t length=wide_length(value);name->length=(USHORT)(length*sizeof(WCHAR));name->maximum_length=name->length+sizeof(WCHAR);name->buffer=(WCHAR*)((unsigned char*)output+sizeof(*name));
 memcpy(name->buffer,value,(length+1)*sizeof(WCHAR));*returned=(ULONG)(sizeof(*name)+(length+1)*sizeof(WCHAR));
 if(mock.query_pointer_bad)name->buffer=(WCHAR*)((unsigned char*)output+4096);
 return 0;
}
static void close_cap(uv__nul_capability_t*cap){if(cap->handle){CloseHandle(cap->handle);cap->handle=NULL;}}
static WCHAR* block(const WCHAR*data,size_t units){WCHAR*p=uv__malloc(units*sizeof(WCHAR));assert(p);memcpy(p,data,units*sizeof(WCHAR));return p;}
static int contains(const WCHAR*env,const WCHAR*entry){for(size_t i=0;env[i];i+=wide_length(env+i)+1)if(wide_equal(env+i,entry))return 1;return 0;}
static void prepare_good(uv__nul_capability_t*cap){assert(uv__nul_capability_prepare(cap)==0&&cap->handle!=NULL);assert(mock.handles[(uintptr_t)cap->handle].inherit==1);assert(cap->locator==0x100);}
int main(void){
 assert(sizeof(WCHAR)==2&&sizeof(DWORD)==4&&sizeof(uintptr_t)==8);
 unsigned cases=0;uv__nul_capability_t cap;HANDLE out;WCHAR*env;
 reset();mock.value=0;assert(uv__nul_capability_prepare(&cap)==0&&cap.handle==NULL&&mock.env_reads==0&&mock.duplicates==0);env=NULL;assert(uv__nul_capability_environment(&cap,&env)==0&&env==NULL);cases++;
 reset();mock.env_present=0;assert(uv__nul_capability_prepare(&cap)==0&&cap.handle==NULL&&mock.duplicates==0);cases++;
 reset();mock.locator[0]=0;assert(uv__nul_capability_prepare(&cap)==13&&mock.duplicates==0);cases++;
 const WCHAR*bad[]={L"100",L"0000000000000000",L"ffffffffffffffff",L"000000000000010G",L"000000000000010A",L"00000000000001000"};
 for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);i++){reset();wide_copy(mock.locator,bad[i]);assert(uv__nul_capability_prepare(&cap)!=0&&mock.duplicates==0&&cap.handle==NULL);cases++;}
 reset();mock.token_ok=0;assert(uv__nul_capability_prepare(&cap)==5&&mock.env_reads==0);cases++;
 reset();mock.query_ok=0;assert(uv__nul_capability_prepare(&cap)==5&&mock.token_closed==1);cases++;
 reset();mock.returned=8;assert(uv__nul_capability_prepare(&cap)==13&&mock.duplicates==0);cases++;
 reset();mock.value=2;assert(uv__nul_capability_prepare(&cap)==13&&mock.duplicates==0);cases++;
 reset();mock.duplicate_error=1;assert(uv__nul_capability_prepare(&cap)==5&&mock.queries==0);cases++;
 for(int type=1;type<=3;type+=2){reset();mock.handles[0x100].type=type;assert(uv__nul_capability_prepare(&cap)==6&&mock.queries==0&&mock.closed==1);cases++;}
 reset();mock.handles[0x100].object=2;assert(uv__nul_capability_prepare(&cap)==13&&mock.closed==1);cases++;
 reset();mock.handles[0x100].access=FILE_GENERIC_READ;assert(uv__nul_capability_prepare(&cap)==5&&mock.closed==1);cases++;
 reset();mock.query_pointer_bad=1;assert(uv__nul_capability_prepare(&cap)==13&&mock.closed==1);cases++;
 reset();mock.query_short=1;assert(uv__nul_capability_prepare(&cap)==13&&mock.closed==1);cases++;
 reset();mock.missing_api=1;assert(uv__nul_capability_prepare(&cap)==127&&mock.closed==1);cases++;
 reset();mock.set_inherit_ok=0;assert(uv__nul_capability_prepare(&cap)==5&&mock.closed==1);cases++;
 reset();mock.replace_source=1;prepare_good(&cap);assert(mock.handles[0x100].type==3&&mock.handles[(uintptr_t)cap.handle].type==2);close_cap(&cap);cases++;
 for(unsigned mode=0;mode<2;mode++){reset();prepare_good(&cap);out=NULL;DWORD access=mode?FILE_GENERIC_WRITE|FILE_READ_ATTRIBUTES:FILE_GENERIC_READ;assert(uv__nul_capability_duplicate(cap.handle,access,&out)==0);assert(mock.handles[(uintptr_t)out].access==access&&mock.handles[(uintptr_t)out].inherit==1);CloseHandle(out);close_cap(&cap);cases++;}
 reset();prepare_good(&cap);out=(HANDLE)(uintptr_t)0x999;assert(uv__nul_capability_duplicate(cap.handle,0xffffffff,&out)==87&&out==(HANDLE)(uintptr_t)0x999);close_cap(&cap);cases++;
 reset();prepare_good(&cap);mock.duplicate_extra=1;out=(HANDLE)(uintptr_t)0x999;assert(uv__nul_capability_duplicate(cap.handle,FILE_GENERIC_READ,&out)==5&&out==(HANDLE)(uintptr_t)0x999);close_cap(&cap);cases++;
 reset();prepare_good(&cap);{const WCHAR initial[]=L"Z=2\0A=1\0";env=block(initial,sizeof(initial)/sizeof(WCHAR));assert(uv__nul_capability_environment(&cap,&env)==0);assert(contains(env,L"A=1")&&contains(env,L"Z=2")&&contains(env,L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000104"));assert(wide_equal(env,L"A=1"));uv__free(env);}close_cap(&cap);assert(mock.allocations==0&&mock.env_frees==0);cases++;
 reset();prepare_good(&cap);{const WCHAR initial[]=L"";env=block(initial,1);assert(uv__nul_capability_environment(&cap,&env)==0&&contains(env,L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000104"));uv__free(env);}close_cap(&cap);assert(mock.allocations==0);cases++;
 reset();prepare_good(&cap);{const WCHAR initial[]=L"Z=3\0AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000100\0";memcpy(mock.inherited,initial,sizeof initial);mock.inherited_length=sizeof(initial)/sizeof(WCHAR);env=NULL;assert(uv__nul_capability_environment(&cap,&env)==0&&mock.env_frees==1);assert(contains(env,L"Z=3")&&contains(env,L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000104"));assert(contains(mock.inherited,L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000100"));uv__free(env);}close_cap(&cap);assert(mock.allocations==0);cases++;
 const WCHAR*badenv[]={L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000101\0",L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000100\0autoprompt_private_nul_handle=0000000000000100\0",L"AUTOPROMPT_PRIVATE_NUL_HANDLE=invalid\0"};
 const size_t badunits[]={sizeof(L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000101\0")/2,sizeof(L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000100\0autoprompt_private_nul_handle=0000000000000100\0")/2,sizeof(L"AUTOPROMPT_PRIVATE_NUL_HANDLE=invalid\0")/2};
 for(unsigned i=0;i<3;i++){reset();prepare_good(&cap);env=block(badenv[i],badunits[i]);WCHAR*original=env;assert(uv__nul_capability_environment(&cap,&env)!=0&&env==original);uv__free(env);close_cap(&cap);assert(mock.allocations==0);cases++;}
 for(int fail=1;fail<=2;fail++){reset();prepare_good(&cap);env=NULL;mock.fail_allocation=fail;assert(uv__nul_capability_environment(&cap,&env)==8&&env==NULL&&mock.env_frees==1&&mock.allocations==0);close_cap(&cap);cases++;}
 reset();prepare_good(&cap);close_cap(&cap);mock.value=0;assert(uv__nul_capability_prepare(&cap)==0&&cap.handle==NULL&&mock.token_closed==2);cases++;

 for(unsigned mode=0;mode<2;mode++){reset();mock.value=0;out=NULL;DWORD access=mode?FILE_GENERIC_WRITE|FILE_READ_ATTRIBUTES:FILE_GENERIC_READ;assert(uv__create_nul_handle(&out,access,NULL)==0&&out==(HANDLE)(uintptr_t)0x800&&mock.direct_opens==1&&mock.direct_access==access&&mock.duplicates==0);cases++;}
 reset();prepare_good(&cap);out=NULL;assert(uv__create_nul_handle(&out,FILE_GENERIC_READ,cap.handle)==0&&mock.direct_opens==0);CloseHandle(out);close_cap(&cap);cases++;

 reset();prepare_good(&cap);{const WCHAR entry[]=L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000100";size_t units=32760,first=units-(wide_length(entry)+1)-1;env=uv__malloc(units*sizeof(WCHAR));env[0]=L'Z';env[1]=L'=';for(size_t i=2;i<first-1;i++)env[i]=L'x';env[first-1]=0;wide_copy(env+first,entry);env[units-1]=0;assert(uv__nul_capability_environment(&cap,&env)==0&&contains(env,L"AUTOPROMPT_PRIVATE_NUL_HANDLE=0000000000000104"));uv__free(env);}close_cap(&cap);assert(mock.allocations==0);cases++;
 reset();prepare_good(&cap);{size_t units=32760;env=uv__malloc(units*sizeof(WCHAR));env[0]=L'Z';env[1]=L'=';for(size_t i=2;i<units-2;i++)env[i]=L'x';env[units-2]=env[units-1]=0;WCHAR*original=env;assert(uv__nul_capability_environment(&cap,&env)==13&&env==original);uv__free(env);}close_cap(&cap);assert(mock.allocations==0);cases++;
 printf("{\"cases\":%u,\"nativeWindows\":false,\"wcharBytes\":%zu,\"dwordBytes\":%zu}\n",cases,sizeof(WCHAR),sizeof(DWORD));return 0;
}
