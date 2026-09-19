int main(){
 int count=0;auto run=[&](bool fatal,std::vector<std::string> expected){calls.clear();cygheap_user u;bool threw=false;try{u.init();}catch(const std::runtime_error&){threw=true;}assert(threw==fatal);assert(calls==expected);assert(u.name=="unknown");assert(u.effec_cygsid.value==TokenUser);++count;};
 const std::vector<std::string> host={"query:5","query:1","query:29","set:4","sec_user_nih","getdacl","set:6","setprocess"};
 const std::vector<std::string> preserve={"query:5","query:1","query:29"};
 const std::vector<std::string> fatal={"query:5","query:1","query:29","fatal"};
 cfg={};run(false,host);
 cfg={};cfg.app=1;run(false,preserve);
 for(ULONG value:{2u,0xffffffffu}){cfg={};cfg.app=value;run(true,fatal);}
 for(ULONG size:{0u,1u,3u,5u,8u,0xffffffffu})for(ULONG app:{0u,1u}){cfg={};cfg.app=app;cfg.size=size;run(true,fatal);}
 for(NTSTATUS status:{int32_t(0xc0000022u),int32_t(0xc0000003u),int32_t(0xc0000004u),int32_t(0xc000000du)})for(ULONG app:{0u,1u}){cfg={};cfg.app=app;cfg.query=status;run(true,fatal);}
 cfg={};cfg.query=1;run(false,host);cfg.app=1;run(false,preserve);
 cfg={};cfg.owner=-1;auto e=host;e.insert(e.begin()+4,"debuglog");run(false,e);
 cfg={};cfg.daclSet=-1;e=host;e.insert(e.end()-1,"systemlog");run(false,e);
 cfg={};cfg.processSet=-1;e=host;e.push_back("systemlog");run(false,e);
 for(int which:{0,1,2}){cfg={};if(which==0)cfg.aclExists=0;if(which==1)cfg.nullDacl=true;if(which==2)cfg.getDacl=-1;run(false,{"query:5","query:1","query:29","set:4","sec_user_nih","getdacl","systemlog"});}
 cfg={};cfg.app=1;cfg.owner=-1;cfg.daclSet=-1;cfg.processSet=-1;run(false,preserve);
 std::cout<<"{\"cases\":"<<count<<",\"status\":\"exact extracted cygheap_user::init API seam passed; not native proof\"}\n";
}
