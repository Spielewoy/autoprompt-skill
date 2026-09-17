static LONG query_object(HANDLE handle,ULONG kind,void*output,ULONG size,ULONG*returned){
 uintptr_t n=(uintptr_t)handle;assert(n!=0x100&&n<512&&mock.handles[n].active);mock.queries++;if(mock.query_status)return -1;
 if(kind==0){assert(size==56&&size==sizeof(null_basic_t));null_basic_t*basic=(null_basic_t*)output;memset(basic,0,size);basic->granted_access=mock.handles[n].access;*returned=mock.query_short?4:size;return 0;}
 assert((kind==1||kind==2)&&size==4096);null_string_t*name=(null_string_t*)output;
 const WCHAR*value=kind==2?L"File":mock.handles[n].object==1?L"\\Device\\Null":L"\\Device\\Other";
 size_t length=wide_length(value);name->length=(USHORT)(length*sizeof(WCHAR));name->maximum_length=name->length+sizeof(WCHAR);name->buffer=(WCHAR*)((unsigned char*)output+sizeof(*name));
 memcpy(name->buffer,value,(length+1)*sizeof(WCHAR));*returned=(ULONG)(sizeof(*name)+(length+1)*sizeof(WCHAR));
 if(mock.malformed_string==1)name->maximum_length=0xffff;
 if(mock.malformed_string==2)name->buffer=(WCHAR*)((unsigned char*)name->buffer+1);
 if(mock.malformed_string==3)*returned=4097;
 if(mock.malformed_string==4)*returned=0;
 if(mock.query_pointer_bad)name->buffer=(WCHAR*)((unsigned char*)output+4096);
 return 0;
}
