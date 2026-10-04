int main(){int cases=0;HANDLE r,w;SECURITY_ATTRIBUTES sa{sizeof(sa),(void*)3,FALSE};
for(auto size:{0u,16u,65536u}){reset();assert(appcontainer_create_pipe(&r,&w,&sa,size));assert(r==(HANDLE)11&&w==(HANDLE)12&&creates==1&&opens==1&&randoms==1&&hosts==0&&closes==0);assert(effective.bInheritHandle==FALSE);cases++;}
reset();sa.bInheritHandle=TRUE;assert(appcontainer_create_pipe(&r,&w,&sa,16));assert(effective.bInheritHandle==TRUE);cases++;
reset();assert(appcontainer_create_pipe(&r,&w,nullptr,0));assert(input_sa==nullptr&&!effective.bInheritHandle);cases++;
for(auto size:{0u,999u,100000u}){reset();ac=false;assert(appcontainer_create_pipe(&r,&w,&sa,size)==(size!=999));assert(hosts==1&&creates==0&&randoms==0&&host_sa==&sa&&host_size==size&&GetLastError()==123);cases++;}
reset();ac=false;assert(appcontainer_create_pipe(nullptr,nullptr,nullptr,0));assert(hosts==1&&host_sa==nullptr);cases++;
reset();prepare_error=5;r=(HANDLE)4;w=(HANDLE)5;assert(!appcontainer_create_pipe(&r,&w,&sa,0));assert(GetLastError()==5&&creates==0&&hosts==0&&r==(HANDLE)4&&w==(HANDLE)5);cases++;
reset();random_ok=false;assert(!appcontainer_create_pipe(&r,&w,&sa,0));assert(!r&&!w&&GetLastError()==31&&creates==0);cases++;
reset();server_error=5;assert(!appcontainer_create_pipe(&r,&w,&sa,0));assert(!r&&!w&&GetLastError()==5&&creates==1&&closes==0&&opens==0);cases++;
reset();server_error=55;assert(!appcontainer_create_pipe(&r,&w,&sa,0));assert(GetLastError()==55&&creates==1);cases++;
reset();client_error=5;assert(!appcontainer_create_pipe(&r,&w,&sa,0));assert(!r&&!w&&GetLastError()==5&&creates==1&&opens==1&&closes==1);cases++;
reset();busy_count=7;assert(appcontainer_create_pipe(&r,&w,&sa,16));assert(creates==8&&opens==1&&randoms==8);for(size_t i=1;i<names.size();i++)assert(names[i]!=names[i-1]);cases++;
reset();busy_count=8;assert(!appcontainer_create_pipe(&r,&w,&sa,16));assert(!r&&!w&&creates==8&&opens==0&&GetLastError()==231);cases++;
reset();assert(!appcontainer_create_pipe(&r,&w,&sa,65537));assert(GetLastError()==87&&randoms==0);cases++;
reset();assert(!appcontainer_create_pipe(nullptr,&w,&sa,16));assert(GetLastError()==87&&randoms==0);cases++;
reset();assert(!appcontainer_create_pipe(&r,nullptr,&sa,16));assert(GetLastError()==87&&randoms==0);cases++;
reset();assert(!appcontainer_create_pipe(&r,&r,&sa,16));assert(GetLastError()==87&&randoms==0);cases++;
assert(!descriptor_alive);printf("anonymous pipe exact-function contract: %d cases passed\n",cases);}
