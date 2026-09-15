static int invoke(size_t length) {
  char name[64];HANDLE result=(HANDLE)(intptr_t)0x333;
  int error=uv__pipe_server(&result,0x40000003,name,length,7);
  assert(result==(error==0?(HANDLE)(intptr_t)0xbeef:(HANDLE)(intptr_t)0x333));
  return error;
}
int main(void){unsigned cases=0;
 reset();assert(invoke(64)==0);assert(strcmp(state.names[0],"\\\\?\\pipe\\uv\\7-4242")==0);assert(state.close_calls==1);cases++;
 reset();state.value=1;assert(invoke(64)==0);assert(strcmp(state.names[0],"\\\\.\\pipe\\LOCAL\\uv-7-4242")==0);assert(state.close_calls==1);cases++;
 reset();state.error_count=20;for(int i=0;i<20;i++)state.errors[i]=5;assert(invoke(64)==0);assert(state.creates==21);assert(strcmp(state.names[20],"\\\\?\\pipe\\uv\\27-4242")==0);cases++;
 reset();state.value=1;state.error_count=7;for(int i=0;i<7;i++)state.errors[i]=5;assert(invoke(64)==0);assert(state.creates==8);cases++;
 reset();state.value=1;state.error_count=8;for(int i=0;i<8;i++)state.errors[i]=5;assert(invoke(64)==5);assert(state.creates==8);cases++;
 reset();state.value=1;state.error_count=8;for(int i=0;i<8;i++)state.errors[i]=231;assert(invoke(64)==231);assert(state.creates==8);cases++;
 reset();state.value=1;state.error_count=3;state.errors[0]=231;state.errors[1]=5;state.errors[2]=123;assert(invoke(64)==123);assert(state.creates==3);cases++;
 reset();state.open_ok=0;state.open_error=5;assert(invoke(64)==5);assert(state.creates==0&&state.close_calls==0&&state.query_calls==0);cases++;
 reset();state.open_ok=0;assert(invoke(64)==13);assert(state.creates==0&&state.close_calls==0);cases++;
 reset();state.query_ok=0;state.query_error=5;assert(invoke(64)==5);assert(state.creates==0&&state.close_calls==1);cases++;
 reset();state.query_ok=0;assert(invoke(64)==13);assert(state.creates==0&&state.close_calls==1);cases++;
 reset();state.returned=sizeof(DWORD)-1;assert(invoke(64)==13);assert(state.creates==0&&state.close_calls==1);cases++;
 reset();state.value=2;assert(invoke(64)==13);assert(state.creates==0&&state.close_calls==1);cases++;
 reset();state.close_ok=0;state.close_error=6;assert(invoke(64)==6);assert(state.creates==0&&state.close_calls==1);cases++;
 reset();state.query_ok=0;state.query_error=5;state.close_ok=0;state.close_error=6;assert(invoke(64)==5);assert(state.creates==0&&state.close_calls==1);cases++;
 reset();state.value=1;assert(invoke(3)==122);assert(state.creates==0&&state.close_calls==1);cases++;
 reset();state.value=1;state.pid=4294967295UL;{char name[64];assert(uv__unique_pipe_name(ULLONG_MAX,name,sizeof name,1)==0);assert(strcmp(name,"\\\\.\\pipe\\LOCAL\\uv-18446744073709551615-4294967295")==0);}cases++;
 reset();state.returned=0;assert(invoke(64)==13);assert(state.creates==0&&state.close_calls==1);cases++;
 reset();assert(invoke(64)==0);state.value=1;assert(invoke(64)==0);assert(state.query_calls==2&&state.close_calls==2&&state.creates==2);assert(strstr(state.names[1],"LOCAL")!=NULL);cases++;
 reset();state.value=1;state.error_count=1;state.errors[0]=87;assert(invoke(64)==87&&state.creates==1);cases++;
 reset();state.close_ok=0;assert(invoke(64)==13);assert(state.creates==0&&state.close_calls==1);cases++;
 for(int shape=0;shape<5;shape++){
  reset();state.value=1;HANDLE server=(HANDLE)(intptr_t)0x333,client=(HANDLE)(intptr_t)0x444;
  unsigned sf,cf;
  if(shape==0){sf=UV_READABLE_PIPE|UV_NONBLOCK_PIPE;cf=UV_WRITABLE_PIPE|UV_NONBLOCK_PIPE;state.inherit=1;state.server_access=PIPE_ACCESS_INBOUND|FILE_FLAG_OVERLAPPED|WRITE_DAC;state.client_access=GENERIC_WRITE|FILE_READ_ATTRIBUTES|WRITE_DAC;state.client_flags=FILE_FLAG_OVERLAPPED;}
  else if(shape==1){sf=UV_WRITABLE_PIPE;cf=UV_READABLE_PIPE;state.server_access=PIPE_ACCESS_OUTBOUND|WRITE_DAC;state.client_access=GENERIC_READ|FILE_WRITE_ATTRIBUTES|WRITE_DAC;}
  else{sf=UV_READABLE_PIPE|UV_WRITABLE_PIPE;cf=sf;state.server_access=PIPE_ACCESS_INBOUND|PIPE_ACCESS_OUTBOUND|WRITE_DAC;state.client_access=GENERIC_READ|GENERIC_WRITE|WRITE_DAC;}
  if(shape==3)state.client_error=5;
  if(shape==4)state.connect_error=87;
  int result=uv__create_pipe_pair(&server,&client,sf,cf,state.inherit,7);
  assert(result==(shape==3?5:shape==4?87:0));assert(state.client_calls==1&&state.close_calls==1);
  if(shape<3){assert(server==(HANDLE)(intptr_t)0xbeef&&client==(HANDLE)(intptr_t)0xcafe&&state.pipe_closes==0);}
  else{assert(server==(HANDLE)(intptr_t)0x333&&client==(HANDLE)(intptr_t)0x444);assert(state.pipe_closes==(shape==3?1:2));}
  cases++;
 }
 printf("{\"boundaryCases\":%u,\"nativeWindows\":false}\n",cases);return 0;
}
