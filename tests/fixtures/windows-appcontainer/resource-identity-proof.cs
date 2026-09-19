// Actual-source resource identity controls. Host-directed; no worker is started.
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

public static class ResourceIdentityProof {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=1024*1024};
  [StructLayout(LayoutKind.Sequential)] struct TIME { public uint Low,High;public long Value{get{return ((long)High<<32)|Low;}} }
  [StructLayout(LayoutKind.Sequential)] struct INFO {public uint Attributes;public TIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [StructLayout(LayoutKind.Sequential)] struct STANDARD {public long Allocation,EndOfFile;public uint Links;[MarshalAs(UnmanagedType.U1)]public bool DeletePending;[MarshalAs(UnmanagedType.U1)]public bool Directory;}
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool IsWow64Process2(IntPtr h,out ushort process,out ushort native);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(IntPtr h,out INFO info);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandleEx(IntPtr h,int kind,out STANDARD info,uint length);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)]static extern uint GetNamedSecurityInfo(string path,int type,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr sd);
  [DllImport("advapi32.dll")]static extern uint GetSecurityDescriptorLength(IntPtr sd);
  [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);
  static void Need(bool value,string code){if(!value)throw new InvalidOperationException(code);}
  static bool Valid(IntPtr h){return h!=IntPtr.Zero&&h!=new IntPtr(-1);}
  static string Architecture(){ushort p,n;Need(IsWow64Process2(new IntPtr(-1),out p,out n)&&p==0&&(n==0x8664||n==0xaa64),"native-architecture");return n==0x8664?"x64":"arm64";}
  static string Sha(byte[] b){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
  public static bool Contracts(){Need(IntPtr.Size==8&&Marshal.SizeOf(typeof(STANDARD))==24&&Marshal.SizeOf(typeof(INFO))==52,"native-layout");Need(WindowsAppContainerResourcesNative.MaxResourceEntries==16384,"actual-resource-source");
    var method=typeof(WindowsAppContainerResourcesNative).GetMethod("IdentityDescriptor",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static);Need(method!=null,"descriptor-method");
    foreach(string value in new[]{"00000000:0000000000000000","ffffffff:ffffffffffffffff","1234abcd:8000000000000001"}) {
      object descriptor=method.Invoke(null,new object[]{value});Type type=descriptor.GetType();Need(Marshal.SizeOf(type)==24,"descriptor-size");
      Need((uint)type.GetField("Size").GetValue(descriptor)==24&&(uint)type.GetField("Type").GetValue(descriptor)==0&&(ulong)type.GetField("High").GetValue(descriptor)==0&&(ulong)type.GetField("Low").GetValue(descriptor)==Convert.ToUInt64(value.Substring(9),16),"descriptor-fields");
      string[] fields={"Size","Type","Low","High"};int[] offsets={0,4,8,16};for(int i=0;i<fields.Length;i++)Need(Marshal.OffsetOf(type,fields[i]).ToInt32()==offsets[i],"descriptor-offset");
    }
    foreach(string value in new string[]{null,"","1234abcd:000000000000000","1234abcd:00000000000000000","1234ABCD:0000000000000001","1234abcd/0000000000000001"}) {
      bool refused=false;try{method.Invoke(null,new object[]{value});}catch(System.Reflection.TargetInvocationException e){var refusal=e.InnerException as WindowsAppContainerResourcesNative.Refusal;Need(refusal!=null&&refusal.Code=="WINDOWS_RESOURCE_INVALID","descriptor-refusal-code");refused=true;}Need(refused,"descriptor-malformed-refusal");
    }
    return true;}
  sealed class Identity {public string identity,creation;}
  static Identity Id(string file){IntPtr h=CreateFileW("\\\\?\\"+file,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero);Need(Valid(h),"identity-open");try{INFO i;Need(GetFileInformationByHandle(h,out i)&&i.Links==1&&(i.Attributes&0x400)==0,"identity-read");return new Identity{identity=i.Volume.ToString("x8")+":"+(((ulong)i.IndexHigh<<32)|i.IndexLow).ToString("x16"),creation=i.Creation.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)};}finally{Need(CloseHandle(h),"identity-close");}}
  static RawSecurityDescriptor Security(string file){IntPtr o,g,d,s,sd;Need(GetNamedSecurityInfo(file,1,0x17,out o,out g,out d,out s,out sd)==0,"security-read");try{uint n=GetSecurityDescriptorLength(sd);Need(n>0&&n<=65536,"security-bound");byte[] b=new byte[n];Marshal.Copy(sd,b,0,b.Length);return new RawSecurityDescriptor(b,0);}finally{if(sd!=IntPtr.Zero)LocalFree(sd);}}
  static string[] Aces(RawAcl acl){return acl==null?new string[0]:acl.Cast<GenericAce>().Select(a=>{byte[] b=new byte[a.BinaryLength];a.GetBinaryForm(b,0);return Convert.ToBase64String(b);}).OrderBy(x=>x,StringComparer.Ordinal).ToArray();}
  static string Snapshot(string file){var s=Security(file);Need(s.Owner!=null&&s.Group!=null,"owner-group");return Json.Serialize(new{owner=s.Owner.Value,group=s.Group.Value,protection=(s.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0,dacl=Aces(s.DiscretionaryAcl),mandatoryLabels=Aces(s.SystemAcl)});}
  static void PrivateDirectory(string file){Directory.CreateDirectory(file);var d=new DirectoryInfo(file);var s=d.GetAccessControl();s.SetAccessRuleProtection(true,true);d.SetAccessControl(s);}
  static void ProtectFile(string file){var d=new FileInfo(file);var s=d.GetAccessControl();s.SetAccessRuleProtection(true,true);d.SetAccessControl(s);}
  static bool HasPackage(string file,string sid){return Security(file).DiscretionaryAcl.Cast<GenericAce>().OfType<QualifiedAce>().Any(a=>a.SecurityIdentifier.Value==sid);}
  static void ProfilePresent(string name){IntPtr sid=IntPtr.Zero;int code=WindowsAppContainerNative.CreateAppContainerProfile(name,name,name,IntPtr.Zero,0,out sid);try{Need(code==unchecked((int)0x800700b7),"profile-must-remain-after-refusal");}finally{if(sid!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(sid);if(code==0)WindowsAppContainerNative.DeleteAppContainerProfile(name);}}
  static void ProfileRemoved(string name){IntPtr sid=IntPtr.Zero;int code=WindowsAppContainerNative.CreateAppContainerProfile(name,name,name,IntPtr.Zero,0,out sid);try{Need(code==0&&sid!=IntPtr.Zero,"profile-must-be-removed");}finally{if(sid!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(sid);if(code==0)Need(WindowsAppContainerNative.DeleteAppContainerProfile(name)==0,"verification-profile-remove");}}
  static int? Win32(Exception e){for(int n=0;e!=null&&n<8;n++,e=e.InnerException){var w=e as System.ComponentModel.Win32Exception;if(w!=null)return w.NativeErrorCode;}return null;}
  sealed class Context {
    public string name,home,target,scratch,outside,subject,guard,outsideGuard,profile,planFile,phase="setup";public Identity original;public string subjectSecurity,guardSecurity,outsideSecurity,targetSecurity,scratchSecurity;public WindowsAppContainerResourcesNative.ResourcePlan plan;public Dictionary<string,object> proof=new Dictionary<string,object>();public bool applied,recovered;
  }
  static void Setup(Context c,string root,string name){
    c.home=Path.Combine(root,name);c.profile="Autoprompt_"+Guid.NewGuid().ToString("N");PrivateDirectory(c.home);c.target=Path.Combine(c.home,"target");c.scratch=Path.Combine(c.home,"scratch");c.outside=Path.Combine(c.home,"outside");foreach(string d in new[]{c.target,c.scratch,c.outside})PrivateDirectory(d);
    c.subject=Path.Combine(c.target,"subject");c.guard=Path.Combine(c.target,"guard");c.outsideGuard=Path.Combine(c.outside,"guard");File.WriteAllText(c.subject,"original");File.WriteAllText(c.guard,"guard");File.WriteAllText(c.outsideGuard,"outside");ProtectFile(c.subject);c.original=Id(c.subject);c.subjectSecurity=Snapshot(c.subject);c.guardSecurity=Snapshot(c.guard);c.outsideSecurity=Snapshot(c.outsideGuard);c.targetSecurity=Snapshot(c.target);c.scratchSecurity=Snapshot(c.scratch);
    c.phase="plan";c.plan=WindowsAppContainerResourcesNative.Plan(c.profile,new[]{new WindowsAppContainerResourcesNative.RootSpec{path=c.target,kind="directory",writable=true},new WindowsAppContainerResourcesNative.RootSpec{path=c.scratch,kind="directory",writable=true}});Need(c.plan.entries.Length==4&&c.plan.entries.Count(e=>e.identity==c.original.identity&&e.creation==c.original.creation)==1,"original-plan-binding");string bytes=Json.Serialize(c.plan);c.plan=WindowsAppContainerResourcesNative.ReadPlan(bytes);c.planFile=Path.Combine(c.home,"plan.json");File.WriteAllText(c.planFile,bytes,new UTF8Encoding(false));
    c.proof["case"]=name;c.proof["original"]=c.original;c.proof["planEntries"]=c.plan.entries.Length;c.proof["planSha256"]=Sha(File.ReadAllBytes(c.planFile));c.phase="apply";c.applied=true;WindowsAppContainerResourcesNative.Apply(c.plan);Need(HasPackage(c.subject,c.plan.profileSid),"applied-grant");
  }
  static string MoveOutside(Context c){string moved=Path.Combine(c.outside,"moved");File.Move(c.subject,moved);var id=Id(moved);Need(id.identity==c.original.identity&&id.creation==c.original.creation&&!File.Exists(c.subject)&&HasPackage(moved,c.plan.profileSid),"outside-rename-binding");c.proof["outsideIdentityMatched"]=true;return moved;}
  static void Refused(Context c,WindowsAppContainerResourcesNative.ResourcePlan plan,string code,int? win32){
    c.phase="negative-restore";bool refused=false;try{WindowsAppContainerResourcesNative.Restore(plan);}catch(WindowsAppContainerResourcesNative.Refusal e){Need(e.Code==code&&(win32==null||Win32(e)==win32),"exact-refusal-required");refused=true;c.proof["refusal"]=new{code=e.Code,win32=Win32(e)};}Need(refused,"restore-must-refuse");Need(File.Exists(c.planFile),"journal-retained");ProfilePresent(c.profile);c.proof["refusalRetainedProfileAndPlan"]=true;
  }
  static void Recover(Context c,string survivingSubject,bool replacement){
    c.phase="restore";var result=WindowsAppContainerResourcesNative.Restore(c.plan);Need(Convert.ToInt32(result["restored"])==(replacement?3:4)&&Convert.ToInt32(result["newEntries"])==(replacement?1:0)&&Convert.ToInt32(result["deletedEntries"])==(replacement?1:0),"restore-counts");
    Need(Snapshot(c.guard)==c.guardSecurity&&Snapshot(c.outsideGuard)==c.outsideSecurity&&Snapshot(c.target)==c.targetSecurity&&Snapshot(c.scratch)==c.scratchSecurity&&File.ReadAllText(c.outsideGuard)=="outside","unrelated-security-preserved");
    if(survivingSubject!=null){Need(!HasPackage(survivingSubject,c.plan.profileSid),"subject-package-removed");if(!replacement)Need(Snapshot(survivingSubject)==c.subjectSecurity,"original-security-restored");else Need(File.ReadAllText(survivingSubject)=="replacement"&&(Security(survivingSubject).ControlFlags&ControlFlags.DiscretionaryAclProtected)==0,"replacement-not-old-security");}
    foreach(string path in new[]{c.target,c.scratch,c.guard})Need(!HasPackage(path,c.plan.profileSid),"package-removed");c.phase="repeat-restore";var repeated=WindowsAppContainerResourcesNative.Restore(c.plan);Need(Json.Serialize(repeated)==Json.Serialize(result),"repeated-restore-counts");ProfileRemoved(c.profile);c.recovered=true;c.proof["restore"]=result;c.proof["repeatedRestore"]=true;c.proof["profileRemoved"]=true;c.proof["outsideGuardUnchanged"]=true;c.proof["cleanupConfirmed"]=true;
  }
  static object Run(string root,string name){Context c=new Context{name=name};c.proof["case"]=name;IntPtr owned=IntPtr.Zero;try{
    Setup(c,root,name);c.phase="controlled-mutation";
    if(name=="no-change"){c.proof["noMutation"]=true;Recover(c,c.subject,false);}
    else if(name=="outside-rename")Recover(c,MoveOutside(c),false);
    else if(name=="creation-mismatch"){string moved=MoveOutside(c);var wrong=WindowsAppContainerResourcesNative.ReadPlan(Json.Serialize(c.plan));var entry=wrong.entries.Single(e=>e.identity==c.original.identity);entry.creation=(Int64.Parse(entry.creation)+1).ToString(System.Globalization.CultureInfo.InvariantCulture);wrong=WindowsAppContainerResourcesNative.ReadPlan(Json.Serialize(wrong));string before=Snapshot(moved);Refused(c,wrong,"WINDOWS_ACL_IDENTITY_MISMATCH",null);Need(Snapshot(moved)==before,"mismatch-no-subject-mutation");Recover(c,moved,false);}
    else if(name=="sharing-denial"){string moved=MoveOutside(c);owned=CreateFileW("\\\\?\\"+moved,0x80000000,0,IntPtr.Zero,3,0x00200000,IntPtr.Zero);Need(Valid(owned),"exclusive-handle-open");Refused(c,c.plan,"WINDOWS_ACL_IDENTITY_UNAVAILABLE",32);Need(CloseHandle(owned),"exclusive-handle-close");owned=IntPtr.Zero;Recover(c,moved,false);}
    else if(name=="deleted-replacement"){File.Delete(c.subject);File.WriteAllText(c.subject,"replacement");var replacement=Id(c.subject);Need(replacement.identity!=c.original.identity,"replacement-new-identity");c.proof["replacement"]=replacement;Recover(c,c.subject,true);}
    else if(name=="delete-pending"){string moved=MoveOutside(c);owned=CreateFileW("\\\\?\\"+moved,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero);Need(Valid(owned),"pending-handle-open");File.Delete(moved);STANDARD standard;Need(GetFileInformationByHandleEx(owned,1,out standard,(uint)Marshal.SizeOf(typeof(STANDARD)))&&standard.DeletePending&&!standard.Directory,"actual-delete-pending-required");c.proof["deletePendingObserved"]=true;Refused(c,c.plan,"WINDOWS_ACL_IDENTITY_UNAVAILABLE",5);Need(CloseHandle(owned),"pending-handle-close");owned=IntPtr.Zero;c.phase="post-pending-restore";var result=WindowsAppContainerResourcesNative.Restore(c.plan);Need(Convert.ToInt32(result["restored"])==3&&Convert.ToInt32(result["newEntries"])==0&&Convert.ToInt32(result["deletedEntries"])==1,"pending-restore-counts");Need(Json.Serialize(WindowsAppContainerResourcesNative.Restore(c.plan))==Json.Serialize(result),"pending-repeat-counts");Need(Snapshot(c.guard)==c.guardSecurity&&Snapshot(c.outsideGuard)==c.outsideSecurity&&Snapshot(c.target)==c.targetSecurity&&Snapshot(c.scratch)==c.scratchSecurity,"pending-security-restored");ProfileRemoved(c.profile);c.recovered=true;c.proof["restore"]=result;c.proof["repeatedRestore"]=true;c.proof["profileRemoved"]=true;c.proof["outsideGuardUnchanged"]=true;c.proof["cleanupConfirmed"]=true;}
    else throw new InvalidOperationException("unknown-case");c.proof["passed"]=true;return c.proof;
  }catch(Exception e){var refusal=e as WindowsAppContainerResourcesNative.Refusal;var result=c==null?new Dictionary<string,object>{{"case",name}}:c.proof;result["passed"]=false;result["cleanupConfirmed"]=false;result["phase"]=c==null?"setup":c.phase;result["code"]=refusal==null?"FIXTURE_FAILURE":refusal.Code;result["win32"]=Win32(e);result["hresult"]=e.HResult;if(e is InvalidOperationException&&System.Text.RegularExpressions.Regex.IsMatch(e.Message,"^[a-z0-9-]{1,80}$"))result["assertion"]=e.Message;result["retained"]=true;return result;
  }finally{if(Valid(owned)){bool closed=CloseHandle(owned);if(!closed){if(c!=null){bool wasPassed=c.proof.ContainsKey("passed")&&(bool)c.proof["passed"];c.proof["passed"]=false;c.proof["cleanupConfirmed"]=false;c.proof["retained"]=true;c.proof["ownedHandleCloseFailed"]=true;if(wasPassed)c.proof["code"]="OWNED_HANDLE_CLOSE_FAILED";}Console.Error.WriteLine("IDENTITY_OWNED_HANDLE_CLOSE_FAILED");}}}}
  public static int Main(string[] args){try{Need(args.Length==1&&Contracts(),"controller-contract");string architecture=Architecture();string[] names={"no-change","outside-rename","creation-mismatch","sharing-denial","deleted-replacement","delete-pending"};var cases=names.Select(name=>(Dictionary<string,object>)Run(args[0],name)).ToArray();bool success=cases.All(c=>(bool)c["passed"]);string output=Json.Serialize(new{schema=1,scope="actual-source-resource-recovery-host-controls-no-worker-started",architecture=architecture,cases=cases,cleanupConfirmed=success,accepted=false});Need(Encoding.UTF8.GetByteCount(output)<=32768,"proof-bound");Console.Write(output);return success?0:1;}catch(Exception e){Console.Error.WriteLine("IDENTITY_FIXTURE_CONTROLLER_FAILED:"+e.GetType().Name);return 2;}}
}
