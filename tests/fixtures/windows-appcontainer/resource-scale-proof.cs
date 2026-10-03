// Native scale proof: actual source lifecycle, AppContainer and owned job drain.
// No worker/runtime acceptance is inferred from this resource component test.
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

public static class ResourceScaleProof {
  const int Admission=16384,Recovery=32768,PlanBytes=8*1024*1024;
  static string Phase="startup";
  public static bool LimitsMatch(){return WindowsAppContainerResourcesNative.MaxResourceEntries==Admission&&WindowsAppContainerResourcesNative.MaxRecoveryEntries==Recovery;}
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=PlanBytes};
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsWow64Process2(IntPtr p,out ushort machine,out ushort native);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr t,int kind,IntPtr b,int length,out int returned);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string path,int type,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr sd);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low,High; public long Value {get{return ((long)High<<32)|Low;}} }
  [StructLayout(LayoutKind.Sequential)] struct FILE_INFORMATION { public uint Attributes;public FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_ID_DESCRIPTOR { public uint Size,Type;public ulong Low,High; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out FILE_INFORMATION info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenFileById(IntPtr hint,ref FILE_ID_DESCRIPTOR id,uint access,uint share,IntPtr security,uint flags);
  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length,MaximumLength;public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public int Length;public IntPtr RootDirectory,ObjectName;public uint Attributes;public IntPtr SecurityDescriptor,SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status,Information; }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h,uint access,ref OBJECT_ATTRIBUTES attributes,ref IO_STATUS_BLOCK status,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
  const uint IdOpenOptions=0x00206020,IdAccess=0x001e0081;
  static string StatusHex(IntPtr status){return unchecked((uint)status.ToInt64()).ToString("x8");}
  static string NativeInformationHex(IntPtr information){return unchecked((ulong)information.ToInt64()).ToString(IntPtr.Size==8?"x16":"x8");}
  static UNICODE_STRING BinaryId(IntPtr bytes,ulong id,ushort length){Marshal.WriteInt64(bytes,unchecked((long)id));return new UNICODE_STRING{Length=length,MaximumLength=length,Buffer=bytes};}
  // Diagnostic only: preserve original Win32 refusal regardless of this result.
  // FILE_OPEN_BY_FILE_ID uses a binary NTFS ID, never a text filename.
  static object ObserveNativeIdentity(IntPtr hint,Identity original,ushort length){
    IntPtr bytes=IntPtr.Zero,name=IntPtr.Zero,h=IntPtr.Zero;
    try{bytes=Marshal.AllocHGlobal(8);var unicode=BinaryId(bytes,Convert.ToUInt64(original.identity.Substring(9),16),length);name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));Marshal.StructureToPtr(unicode,name,false);
      var attributes=new OBJECT_ATTRIBUTES{Length=Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),RootDirectory=hint,ObjectName=name,Attributes=0};var io=new IO_STATUS_BLOCK{Status=new IntPtr(0x7fffffff),Information=new IntPtr(-1)};
      int status=NtCreateFile(out h,IdAccess,ref attributes,ref io,IntPtr.Zero,0,7,1,IdOpenOptions,IntPtr.Zero,0);string returned=unchecked((uint)status).ToString("x8"),ioStatus=StatusHex(io.Status),information=NativeInformationHex(io.Information);bool opened=ValidHandle(h),matched=false,identityRead=false;int identityError=0;
      if(opened){FILE_INFORMATION info;identityRead=GetFileInformationByHandle(h,out info);identityError=identityRead?0:Marshal.GetLastWin32Error();if(identityRead){string id=info.Volume.ToString("x8")+":"+(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString("x16");matched=id==original.identity&&info.Creation.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)==original.creation;}}
      return new{role=original.role,identity=original.identity,creation=original.creation,binaryLength=(int)length,returnedStatus=returned,ioStatus=ioStatus,ioInformation=information,opened=opened,identityRead=identityRead,identityError=identityError,identityMatched=matched};
    }finally{try{if(ValidHandle(h))Need(CloseHandle(h),"diagnostic-native-id-close");}finally{if(name!=IntPtr.Zero)Marshal.FreeHGlobal(name);if(bytes!=IntPtr.Zero)Marshal.FreeHGlobal(bytes);}}
  }
  sealed class Identity { public string role,identity,creation; }
  static Identity[] BaselineIdentities=new Identity[0];
  static bool ValidHandle(IntPtr h){return h!=IntPtr.Zero&&h!=new IntPtr(-1);}
  static Identity ReadIdentity(IntPtr h,string role){FILE_INFORMATION info;Need(GetFileInformationByHandle(h,out info),"diagnostic-identity-read");return new Identity{role=role,identity=info.Volume.ToString("x8")+":"+(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString("x16"),creation=info.Creation.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)};}
  static Identity PathIdentity(string path,string role){IntPtr h=CreateFileW("\\\\?\\"+path,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Need(ValidHandle(h),"diagnostic-identity-open");try{return ReadIdentity(h,role);}finally{Need(CloseHandle(h),"diagnostic-identity-close");}}
  static void ObserveIdentities(string target){
    IntPtr hint=CreateFileW("\\\\?\\"+Path.GetPathRoot(target),0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);int hintError=ValidHandle(hint)?0:Marshal.GetLastWin32Error();var records=new List<object>();object malformed=null;
    try{if(ValidHandle(hint))foreach(var original in BaselineIdentities){var id=new FILE_ID_DESCRIPTOR{Size=(uint)Marshal.SizeOf(typeof(FILE_ID_DESCRIPTOR)),Type=0,Low=Convert.ToUInt64(original.identity.Substring(9),16),High=0};IntPtr h=OpenFileById(hint,ref id,0x001e0081,7,IntPtr.Zero,0x02200000);int error=ValidHandle(h)?0:Marshal.GetLastWin32Error();bool matched=false;if(ValidHandle(h)){try{var actual=ReadIdentity(h,original.role);matched=actual.identity==original.identity&&actual.creation==original.creation;}finally{Need(CloseHandle(h),"diagnostic-by-id-close");}}records.Add(new{role=original.role,identity=original.identity,creation=original.creation,opened=ValidHandle(h),error=error,identityMatched=matched,native=ObserveNativeIdentity(hint,original,8)});}if(ValidHandle(hint))malformed=ObserveNativeIdentity(hint,BaselineIdentities[0],7);}
    finally{if(ValidHandle(hint))Need(CloseHandle(hint),"diagnostic-hint-close");}
    Console.Error.WriteLine("RESOURCE_SCALE_ID_OBSERVATIONS:"+Json.Serialize(new{schema=1,scope="controller-after-owned-child-drain-no-absence-classification",hintOpened=ValidHandle(hint),hintError=hintError,baseline=BaselineIdentities,records=records.ToArray(),malformedLengthControl=malformed}));
  }
  static string BoundedData(Exception error,string key,string pattern){var value=error.Data[key] as string;return value!=null&&value.Length<=32&&System.Text.RegularExpressions.Regex.IsMatch(value,pattern)?value:null;}
  public static Dictionary<string,object> FailureDiagnostic(Exception error){
    int? win32=null;string identity=null,creation=null;int depth=0;Exception current=error;
    for(;current!=null&&depth<8;depth++,current=current.InnerException){var native=current as System.ComponentModel.Win32Exception;if(native!=null&&win32==null)win32=native.NativeErrorCode;if(identity==null)identity=BoundedData(current,"resourceIdentity","^[a-f0-9]{8}:[a-f0-9]{16}$");if(creation==null)creation=BoundedData(current,"resourceCreation","^[0-9]{1,19}$");}
    var refusal=error as WindowsAppContainerResourcesNative.Refusal;string code=refusal!=null&&System.Text.RegularExpressions.Regex.IsMatch(refusal.Code,"^[A-Z_]{1,80}$")?refusal.Code:"FIXTURE_FAILURE";
    return new Dictionary<string,object>{{"schema",1},{"phase",Phase},{"code",code},{"hresult",error.HResult},{"win32",win32},{"identity",identity},{"creation",creation},{"innerDepth",depth},{"chainTruncated",current!=null}};
  }
  public static bool DiagnosticContracts(){
    Need(IntPtr.Size==8&&Marshal.SizeOf(typeof(UNICODE_STRING))==16&&Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES))==48&&Marshal.SizeOf(typeof(IO_STATUS_BLOCK))==16,"diagnostic-native-ABI");Need(IdAccess==0x001e0081&&IdOpenOptions==0x00206020&&(IdAccess&0x100000)!=0,"diagnostic-native-options");
    Need(StatusHex(new IntPtr(unchecked((long)0x11223344c000000dUL)))=="c000000d"&&NativeInformationHex(new IntPtr(-1))=="ffffffffffffffff","diagnostic-native-width");
    IntPtr bytes=Marshal.AllocHGlobal(8);try{var id=BinaryId(bytes,0xfedcba9876543210UL,8);Need(id.Length==8&&id.MaximumLength==8&&id.Buffer==bytes&&unchecked((ulong)Marshal.ReadInt64(bytes))==0xfedcba9876543210UL&&Marshal.ReadByte(bytes,0)==0x10&&Marshal.ReadByte(bytes,7)==0xfe,"diagnostic-binary-id");id=BinaryId(bytes,0xfedcba9876543210UL,7);Need(id.Length==7&&id.MaximumLength==7&&unchecked((ulong)Marshal.ReadInt64(bytes))==0xfedcba9876543210UL,"diagnostic-malformed-length-only");}finally{Marshal.FreeHGlobal(bytes);}
    var e=new WindowsAppContainerResourcesNative.Refusal("WINDOWS_ACL_IDENTITY_UNAVAILABLE",new System.ComponentModel.Win32Exception(5));e.Data["resourceIdentity"]="1234abcd:000000000000002a";e.Data["resourceCreation"]="123";var d=FailureDiagnostic(e);Need((int)d["win32"]==5&&(string)d["identity"]=="1234abcd:000000000000002a"&&(string)d["creation"]=="123"&&!(bool)d["chainTruncated"],"diagnostic-exact-fields");e.Data["resourceIdentity"]="C:\\private\\path";e.Data["resourceCreation"]="-1";d=FailureDiagnostic(e);Need(d["identity"]==null&&d["creation"]==null,"diagnostic-untrusted-data-refused");Exception deep=new System.ComponentModel.Win32Exception(87);for(int i=0;i<9;i++)deep=new Exception("untrusted",deep);d=FailureDiagnostic(deep);Need(d["win32"]==null&&(bool)d["chainTruncated"]&&(int)d["innerDepth"]==8&&(string)d["code"]=="FIXTURE_FAILURE","diagnostic-chain-bound");return true;
  }
  static void Need(bool value,string code){if(!value)throw new InvalidOperationException(code);}
  static string Architecture(){ushort m,n;Need(IsWow64Process2(new IntPtr(-1),out m,out n)&&m==0&&(n==0x8664||n==0xaa64),"native-architecture");return n==0x8664?"x64":"arm64";}
  static string Hash(byte[] bytes){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static string HashFile(string file){return Hash(File.ReadAllBytes(file));}
  static RawSecurityDescriptor Security(string file){IntPtr o,g,d,s,sd;Need(GetNamedSecurityInfo(file,1,0x17,out o,out g,out d,out s,out sd)==0,"security-read");try{uint length=GetSecurityDescriptorLength(sd);Need(length>0&&length<=65536,"security-bound");byte[] b=new byte[(int)length];Marshal.Copy(sd,b,0,b.Length);return new RawSecurityDescriptor(b,0);}finally{if(sd!=IntPtr.Zero)LocalFree(sd);}}
  static string[] Aces(RawAcl acl){if(acl==null)return new string[0];return acl.Cast<GenericAce>().Select(a=>{byte[] b=new byte[a.BinaryLength];a.GetBinaryForm(b,0);return Convert.ToBase64String(b);}).OrderBy(x=>x,StringComparer.Ordinal).ToArray();}
  static string Snapshot(string file){var sd=Security(file);Need(sd.Owner!=null&&sd.Group!=null,"snapshot-owner-group");return Json.Serialize(new{owner=sd.Owner.Value,group=sd.Group.Value,protection=(sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0,dacl=Aces(sd.DiscretionaryAcl),mandatoryLabels=Aces(sd.SystemAcl)});}
  static string[] Paths(string root){return new[]{root}.Concat(Directory.GetDirectories(root,"*",SearchOption.AllDirectories)).Concat(Directory.GetFiles(root,"*",SearchOption.AllDirectories)).OrderBy(x=>x,StringComparer.Ordinal).ToArray();}
  static Dictionary<string,string> Snapshots(params string[] roots){return roots.SelectMany(Paths).ToDictionary(x=>x,Snapshot,StringComparer.OrdinalIgnoreCase);}
  static string SnapshotDigest(Dictionary<string,string> values){using(var hash=SHA256.Create()){foreach(var item in values.OrderBy(x=>x.Key,StringComparer.Ordinal)){byte[] bytes=Encoding.UTF8.GetBytes(Json.Serialize(new[]{item.Key,item.Value})+"\n");hash.TransformBlock(bytes,0,bytes.Length,bytes,0);}hash.TransformFinalBlock(new byte[0],0,0);return BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();}}
  static void Private(string root){var info=new DirectoryInfo(root);var acl=info.GetAccessControl();acl.SetAccessRuleProtection(true,true);info.SetAccessControl(acl);}
  static void CheckToken(string sid){IntPtr t=IntPtr.Zero,b=IntPtr.Zero;try{Need(OpenProcessToken(new IntPtr(-1),8,out t),"token-open");b=Marshal.AllocHGlobal(512);int n;Need(GetTokenInformation(t,29,b,512,out n)&&n==4&&Marshal.ReadInt32(b)==1,"AppContainer-required");Need(GetTokenInformation(t,31,b,512,out n)&&new SecurityIdentifier(Marshal.ReadIntPtr(b)).Value==sid,"package-SID-required");}finally{if(b!=IntPtr.Zero)Marshal.FreeHGlobal(b);if(t!=IntPtr.Zero)Need(CloseHandle(t),"token-close");}}
  static void Denied(Action operation){try{operation();}catch(UnauthorizedAccessException e){Need((e.HResult&65535)==5,"denial-must-be-error5");return;}catch(IOException e){Need((e.HResult&65535)==5,"denial-must-be-error5");return;}throw new InvalidOperationException("git-write-succeeded");}
  static void Populate(string target,bool nested){
    Directory.CreateDirectory(Path.Combine(target,".git"));File.WriteAllText(Path.Combine(target,".git","guard"),"protected git");
    foreach(string name in new[]{"edit","delete","rename"})File.WriteAllText(Path.Combine(target,name),"original");
    if(!nested){string flat=Path.Combine(target,"flat");Directory.CreateDirectory(flat);for(int i=0;i<5000;i++)File.WriteAllText(Path.Combine(flat,"f"+i.ToString("D5")),"data");}
    else{int remaining=8192-6;for(int d=0;remaining>0;d++){string dir=Path.Combine(target,"d"+d.ToString("D3"));Directory.CreateDirectory(dir);remaining--;for(int i=0;i<127&&remaining>0;i++,remaining--)File.WriteAllText(Path.Combine(dir,"f"+i.ToString("D3")),"data");}Need(Paths(target).Length==8192,"nested-exact-count");}
  }
  static int Child(string target,string scratch,string sid,int growth){
    Phase="child";CheckToken(sid);string arch=Architecture();Need(File.ReadAllText(Path.Combine(target,"edit"))=="original","read-positive");
    Denied(()=>File.WriteAllText(Path.Combine(target,".git","guard"),"bad"));Denied(()=>File.WriteAllText(Path.Combine(target,".git","new"),"bad"));
    File.WriteAllText(Path.Combine(target,"edit"),"changed");File.Delete(Path.Combine(target,"delete"));File.Move(Path.Combine(target,"rename"),Path.Combine(target,"renamed"));
    string created=Path.Combine(target,"growth");Directory.CreateDirectory(created);for(int i=0;i<growth;i++)File.WriteAllText(Path.Combine(created,"f"+i.ToString("D5")),"created");File.WriteAllText(Path.Combine(scratch,"worker"),"scratch");
    Console.Write(Json.Serialize(new{schema=1,architecture=arch,appContainer=true,denials=new[]{"git-overwrite:5","git-create:5"},createdFiles=growth,edited=true,deleted=true,renamed=true}));return 0;
  }
  public sealed class ChildProof { public int schema,createdFiles;public string architecture;public bool appContainer,edited,deleted,renamed;public string[] denials; }
  sealed class Monitor : IDisposable {
    readonly ManualResetEvent stop=new ManualResetEvent(false);readonly Thread thread;bool disposed;public int peakHandles;public long peakWorkingSet;
    public Monitor(){thread=new Thread(()=>{using(var p=Process.GetCurrentProcess()){do{p.Refresh();peakHandles=Math.Max(peakHandles,p.HandleCount);peakWorkingSet=Math.Max(peakWorkingSet,p.WorkingSet64);}while(!stop.WaitOne(20));}});thread.IsBackground=true;thread.Start();}
    public void Dispose(){if(disposed)return;stop.Set();Need(thread.Join(5000),"monitor-drain");stop.Dispose();disposed=true;}
  }
  static T Timed<T>(string name,Dictionary<string,long> times,Func<T> action){Phase=name;var watch=Stopwatch.StartNew();T value=action();times[name]=watch.ElapsedMilliseconds;Need(watch.ElapsedMilliseconds<=120000,"resource-phase-time-bound:"+name);return value;}
  static void RemovedProfile(string name){IntPtr fresh=IntPtr.Zero;int created=WindowsAppContainerNative.CreateAppContainerProfile(name,name,name,IntPtr.Zero,0,out fresh);try{Need(created==0&&fresh!=IntPtr.Zero,"profile-name-must-be-free-after-restore");}finally{if(fresh!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(fresh);if(created==0)Need(WindowsAppContainerNative.DeleteAppContainerProfile(name)==0,"verification-profile-remove");}}
  static object Case(string root,string worker,string control,bool nested){
    string label=nested?"nested8192":"flat5000",home=Path.Combine(root,label);Directory.CreateDirectory(home);Private(home);
    string target=Path.Combine(home,"target"),scratch=Path.Combine(home,"scratch");Directory.CreateDirectory(target);Directory.CreateDirectory(scratch);Private(target);Private(scratch);Populate(target,nested);
    BaselineIdentities=new[]{PathIdentity(Path.Combine(target,"edit"),"live"),PathIdentity(Path.Combine(target,"delete"),"deleted"),PathIdentity(Path.Combine(target,"rename"),"renamed")};
    int targetCount=Paths(target).Length,growth=nested?9000:3;var before=Snapshots(target,scratch,Path.GetDirectoryName(worker));var times=new Dictionary<string,long>();
    string name="Autoprompt_"+Guid.NewGuid().ToString("N");var specs=new[]{new WindowsAppContainerResourcesNative.RootSpec{path=target,kind="directory",writable=true},new WindowsAppContainerResourcesNative.RootSpec{path=scratch,kind="directory",writable=true},new WindowsAppContainerResourcesNative.RootSpec{path=Path.GetDirectoryName(worker),kind="directory",writable=false}};
    var plan=Timed(label+"-plan",times,()=>WindowsAppContainerResourcesNative.Plan(name,specs));Need(plan.entries.Length>4096&&plan.entries.Length<=Admission,"large-plan-count");string serialized=Json.Serialize(plan);int planSize=Encoding.UTF8.GetByteCount(serialized);Need(planSize<=PlanBytes-4096,"journal-byte-bound");plan=WindowsAppContainerResourcesNative.ReadPlan(serialized);foreach(var identity in BaselineIdentities)Need(plan.entries.Count(x=>x.identity==identity.identity&&x.creation==identity.creation)==1,"diagnostic-plan-identity-join");File.WriteAllText(Path.Combine(control,label+"-plan.json"),serialized,new UTF8Encoding(false));
    IntPtr sid=IntPtr.Zero;bool mutated=false,drained=false,restored=false;var monitor=new Monitor();
    try{
      mutated=true;Timed(label+"-apply",times,()=>WindowsAppContainerResourcesNative.Apply(plan));Need(WindowsAppContainerNative.DeriveAppContainerSidFromAppContainerName(name,out sid)==0&&sid!=IntPtr.Zero,"derive-SID");
      string system=Environment.GetEnvironmentVariable("SystemRoot");string[] env={"SystemRoot="+system,"WINDIR="+system,"SystemDrive="+system.Substring(0,2),"PATH="+Path.Combine(system,"System32"),"TEMP="+scratch,"TMP="+scratch};Phase=label+"-launch";
      var result=WindowsAppContainerNative.Launch(worker,HashFile(worker),new[]{"child",target,scratch,plan.profileSid,growth.ToString()},target,env,120000,32768,sid,plan.profileSid,Path.Combine(control,label+"-cancel"));drained=result.Drained;
      File.WriteAllText(Path.Combine(control,label+"-launch.json"),Json.Serialize(result));Need(drained&&!result.TimedOut&&!result.Cancelled&&!result.OutputLimit&&result.RootImageMatches,"owned-drain-required");Need(result.ExitCode==0&&result.StderrBase64=="","child-result");var child=Json.Deserialize<ChildProof>(Encoding.UTF8.GetString(Convert.FromBase64String(result.StdoutBase64)));Need(child.schema==1&&child.architecture==Architecture()&&child.appContainer&&child.createdFiles==growth&&child.edited&&child.deleted&&child.renamed&&child.denials.SequenceEqual(new[]{"git-overwrite:5","git-create:5"}),"child-proof");
      Need(File.ReadAllText(Path.Combine(target,".git","guard"))=="protected git"&&File.ReadAllText(Path.Combine(target,"edit"))=="changed"&&!File.Exists(Path.Combine(target,"delete"))&&File.ReadAllText(Path.Combine(target,"renamed"))=="original","actual-child-effects");
      int liveCount=Paths(target).Length+Paths(scratch).Length+Paths(Path.GetDirectoryName(worker)).Length;Need(liveCount<=Recovery&&(!nested||liveCount>Admission),"recovery-growth-required");
      var restoredResult=Timed(label+"-restore",times,()=>WindowsAppContainerResourcesNative.Restore(plan));restored=true;Need(Convert.ToInt32(restoredResult["restored"])==plan.entries.Length-1&&Convert.ToInt32(restoredResult["deletedEntries"])==1&&Convert.ToInt32(restoredResult["newEntries"])==growth+2,"exact-restore-counts");
      foreach(var old in before){if(old.Key==Path.Combine(target,"delete"))continue;string now=old.Key==Path.Combine(target,"rename")?Path.Combine(target,"renamed"):old.Key;Need(Snapshot(now)==old.Value,"exact-original-security-restored");}
      foreach(string file in Paths(target).Concat(Paths(scratch)).Concat(Paths(Path.GetDirectoryName(worker))))Need(!Security(file).DiscretionaryAcl.Cast<GenericAce>().OfType<QualifiedAce>().Any(a=>a.SecurityIdentifier.Value==plan.profileSid),"all-package-grants-removed");
      var after=Snapshots(target,scratch,Path.GetDirectoryName(worker));var again=Timed(label+"-repeat",times,()=>WindowsAppContainerResourcesNative.Restore(plan));Need(Json.Serialize(again)==Json.Serialize(restoredResult),"repeat-counts");var repeated=Snapshots(target,scratch,Path.GetDirectoryName(worker));Need(after.Count==repeated.Count&&after.All(x=>repeated[x.Key]==x.Value),"repeated-restore-unchanged");RemovedProfile(name);monitor.Dispose();
      return new{scenario=label,targetObjects=targetCount,planEntries=plan.entries.Length,planBytes=planSize,liveRecoveryObjects=liveCount,createdFiles=growth,drained=true,appContainer=true,architecture=child.architecture,denials=child.denials,exactRestoration=true,repeatedRecovery=true,profileRemoved=true,restore=restoredResult,phaseMilliseconds=times,handleSamplingScope="apply-launch-restore",sampledPeakHandles=monitor.peakHandles,sampledPeakWorkingSet=monitor.peakWorkingSet,accepted=false};
    }catch{if(mutated&&!restored){Console.Error.WriteLine("SCALE_RETAINED:"+label+":drained="+drained);if(drained){try{ObserveIdentities(target);}catch(Exception diagnosticError){Console.Error.WriteLine("RESOURCE_SCALE_ID_OBSERVATION_FAILURE:"+Json.Serialize(FailureDiagnostic(diagnosticError)));}}}throw;}
    finally{monitor.Dispose();if(sid!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(sid);}
  }
  static object Boundary(string root,string control){
    Phase="boundary-setup";string target=Path.Combine(root,"boundary16385");Directory.CreateDirectory(target);Private(target);for(int i=0;i<Admission;i++)File.WriteAllText(Path.Combine(target,"f"+i.ToString("D5")),"");
    Need(Paths(target).Length==Admission+1,"boundary-count");var before=Snapshots(target);string name="Autoprompt_"+Guid.NewGuid().ToString("N");bool refused=false;var watch=Stopwatch.StartNew();Phase="boundary-plan";
    try{WindowsAppContainerResourcesNative.Plan(name,new[]{new WindowsAppContainerResourcesNative.RootSpec{path=target,kind="directory",writable=true}});}catch(WindowsAppContainerResourcesNative.Refusal e){Need(e.Code=="WINDOWS_RESOURCE_LIMIT","boundary-exact-code:"+e.Code);refused=true;}
    Need(refused&&watch.ElapsedMilliseconds<=120000,"boundary-refused");long planMs=watch.ElapsedMilliseconds;var after=Snapshots(target);Need(before.Count==after.Count&&before.All(x=>after[x.Key]==x.Value),"boundary-no-security-mutation");RemovedProfile(name);
    var proof=new{objects=Admission+1,refused=true,code="WINDOWS_RESOURCE_LIMIT",securityUnchanged=true,profileNotCreated=true,elapsedMs=planMs,beforeSha256=SnapshotDigest(before),afterSha256=SnapshotDigest(after)};File.WriteAllText(Path.Combine(control,"boundary-proof.json"),Json.Serialize(proof));return proof;
  }
  public static int Main(string[] args){try{Need(LimitsMatch(),"actual-resource-limits");string arch=Architecture();if(args.Length==4&&args[0]=="snapshot"){var values=Snapshots(args[1],args[2],args[3]);Console.Write(Json.Serialize(new{schema=1,architecture=arch,objects=values.Count,securitySha256=SnapshotDigest(values)}));return 0;}if(args.Length==5&&args[0]=="child")return Child(args[1],args[2],args[3],Int32.Parse(args[4]));Need(args.Length==3,"controller-arguments");var cases=new[]{Case(args[0],args[1],args[2],false),Case(args[0],args[1],args[2],true)};object boundary=Boundary(args[0],args[2]);Console.Write(Json.Serialize(new{schema=1,nativeWindows=true,architecture=arch,cases=cases,boundary=boundary,cleanupConfirmed=true,accepted=false}));return 0;}catch(Exception e){Console.Error.WriteLine("RESOURCE_SCALE_FAILURE:"+Phase+":"+e.GetType().Name+":"+e.Message);Console.Error.WriteLine("RESOURCE_SCALE_FAILURE_DETAIL:"+Json.Serialize(FailureDiagnostic(e)));return 1;}}
}
