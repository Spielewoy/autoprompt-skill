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
  [StructLayout(LayoutKind.Sequential,Pack=1)] struct DISPOSITION {public byte DeleteFile;}
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetFileInformationByHandle(IntPtr h,int kind,ref DISPOSITION info,uint length);
  [StructLayout(LayoutKind.Sequential)] struct ID_DESCRIPTOR {public uint Size,Type;public ulong Low,High;}
  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenFileById(IntPtr volume,ref ID_DESCRIPTOR id,uint access,uint share,IntPtr security,uint flags);
  [DllImport("advapi32.dll")]static extern uint GetSecurityInfo(IntPtr handle,int type,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr sd);
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
  public static bool Contracts(){Need(Marshal.SizeOf(typeof(DISPOSITION))==1&&Marshal.OffsetOf(typeof(DISPOSITION),"DeleteFile").ToInt32()==0,"disposition-layout");Need(IntPtr.Size==8&&Marshal.SizeOf(typeof(STANDARD))==24&&Marshal.SizeOf(typeof(INFO))==52&&Marshal.SizeOf(typeof(ID_DESCRIPTOR))==24,"native-layout");Need(WindowsAppContainerResourcesNative.MaxResourceEntries==16384,"actual-resource-source");
    var method=typeof(WindowsAppContainerResourcesNative).GetMethod("IdentityDescriptor",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static);Need(method!=null,"descriptor-method");
    foreach(string value in new[]{"00000000:0000000000000000","ffffffff:ffffffffffffffff","1234abcd:8000000000000001"}) {
      object descriptor=method.Invoke(null,new object[]{value});Type type=descriptor.GetType();Need(Marshal.SizeOf(type)==24,"descriptor-size");
      Need((uint)type.GetField("Size").GetValue(descriptor)==24&&(uint)type.GetField("Type").GetValue(descriptor)==0&&(ulong)type.GetField("High").GetValue(descriptor)==0&&(ulong)type.GetField("Low").GetValue(descriptor)==Convert.ToUInt64(value.Substring(9),16),"descriptor-fields");
      string[] fields={"Size","Type","Low","High"};int[] offsets={0,4,8,16};for(int i=0;i<fields.Length;i++)Need(Marshal.OffsetOf(type,fields[i]).ToInt32()==offsets[i],"descriptor-offset");
    }
    foreach(string value in new string[]{null,"","1234abcd:000000000000000","1234abcd:00000000000000000","1234ABCD:0000000000000001","1234abcd/0000000000000001","1234abcd:0000000000000001\n","1234abcd:0000000000000001\r\n","1234abcd:0000000000000001\r"}) {
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
    c.phase="plan";c.plan=WindowsAppContainerResourcesNative.Plan(c.profile,new[]{new WindowsAppContainerResourcesNative.RootSpec{path=c.target,kind="directory",writable=true},new WindowsAppContainerResourcesNative.RootSpec{path=c.scratch,kind="directory",writable=true}});Need(c.plan.entries.Length==4&&c.plan.entries.Count(e=>e.identity==c.original.identity&&e.creation==c.original.creation)==1,"original-plan-binding");string bytes=Json.Serialize(c.plan);c.plan=WindowsAppContainerResourcesNative.ReadPlan(bytes);if(name=="no-change")PlanFormatContracts(c.plan);c.planFile=Path.Combine(c.home,"plan.json");File.WriteAllText(c.planFile,bytes,new UTF8Encoding(false));
    c.proof["case"]=name;c.proof["original"]=c.original;c.proof["planEntries"]=c.plan.entries.Length;c.proof["planSha256"]=Sha(File.ReadAllBytes(c.planFile));c.phase="apply";c.applied=true;WindowsAppContainerResourcesNative.Apply(c.plan);Need(HasPackage(c.subject,c.plan.profileSid),"applied-grant");
  }
  static void PlanFormatContracts(WindowsAppContainerResourcesNative.ResourcePlan plan) {
    foreach(string suffix in new[]{"\n","\r\n","\r"})foreach(string field in new[]{"identity","creation"})foreach(int scope in new[]{1,2,3}) {
      var bad=Json.Deserialize<WindowsAppContainerResourcesNative.ResourcePlan>(Json.Serialize(plan));
      if((scope&1)!=0){if(field=="identity")bad.entries[0].identity+=suffix;else bad.entries[0].creation+=suffix;}
      if((scope&2)!=0){if(field=="identity")bad.roots[0].identity+=suffix;else bad.roots[0].creation+=suffix;}
      bool refused=false;try{WindowsAppContainerResourcesNative.ReadPlan(Json.Serialize(bad));}catch(WindowsAppContainerResourcesNative.Refusal e){Need(e.Code=="WINDOWS_RESOURCE_INVALID","plan-format-refusal-code");refused=true;}Need(refused,"plan-format-must-refuse");
    }
  }
  static string MoveOutside(Context c){string moved=Path.Combine(c.outside,"moved");File.Move(c.subject,moved);var id=Id(moved);Need(id.identity==c.original.identity&&id.creation==c.original.creation&&!File.Exists(c.subject)&&HasPackage(moved,c.plan.profileSid),"outside-rename-binding");c.proof["outsideIdentityMatched"]=true;return moved;}
  static void Refused(Context c,WindowsAppContainerResourcesNative.ResourcePlan plan,string code,int? win32){
    c.phase="negative-restore";bool refused=false;try{c.proof["unexpectedRestore"]=WindowsAppContainerResourcesNative.Restore(plan);}catch(WindowsAppContainerResourcesNative.Refusal e){Need(e.Code==code&&(win32==null||Win32(e)==win32),"exact-refusal-required");refused=true;c.proof["refusal"]=new{code=e.Code,win32=Win32(e)};}Need(refused,"restore-must-refuse");Need(File.Exists(c.planFile),"journal-retained");ProfilePresent(c.profile);c.proof["refusalRetainedProfileAndPlan"]=true;
  }
  static Dictionary<string,object> HandleObservation(IntPtr handle,Identity expected,string sid,string baseline) {
    var result=new Dictionary<string,object>{{"opened",Valid(handle)}};if(!Valid(handle))return result;
    INFO info;bool read=GetFileInformationByHandle(handle,out info);int infoError=read?0:Marshal.GetLastWin32Error();result["identityRead"]=read;result["identityError"]=infoError;
    if(read){string identity=info.Volume.ToString("x8")+":"+(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString("x16");string creation=info.Creation.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);result["identity"]=identity;result["creation"]=creation;result["identityMatched"]=identity==expected.identity&&creation==expected.creation;}
    STANDARD standard;bool standardRead=GetFileInformationByHandleEx(handle,1,out standard,(uint)Marshal.SizeOf(typeof(STANDARD)));int standardError=standardRead?0:Marshal.GetLastWin32Error();result["standardRead"]=standardRead;result["standardError"]=standardError;if(standardRead){result["deletePending"]=standard.DeletePending;result["directory"]=standard.Directory;result["links"]=standard.Links;}
    IntPtr o,g,d,s,sd;uint securityError=GetSecurityInfo(handle,1,0x17,out o,out g,out d,out s,out sd);result["securityError"]=securityError;
    try{if(securityError==0){uint size=GetSecurityDescriptorLength(sd);Need(size>0&&size<=65536,"diagnostic-security-bound");byte[] bytes=new byte[size];Marshal.Copy(sd,bytes,0,bytes.Length);var security=new RawSecurityDescriptor(bytes,0);Need(security.Owner!=null&&security.Group!=null,"diagnostic-security-owner-group");string snapshot=Json.Serialize(new{owner=security.Owner.Value,group=security.Group.Value,protection=(security.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0,dacl=Aces(security.DiscretionaryAcl),mandatoryLabels=Aces(security.SystemAcl)});result["securitySha256"]=Sha(Encoding.UTF8.GetBytes(snapshot));result["baselineSecurityMatched"]=snapshot==baseline;result["packagePresent"]=security.DiscretionaryAcl!=null&&security.DiscretionaryAcl.Cast<GenericAce>().OfType<QualifiedAce>().Any(ace=>ace.SecurityIdentifier.Value==sid);}}finally{if(sd!=IntPtr.Zero)LocalFree(sd);}
    return result;
  }
  static object ObservePending(Context c,IntPtr held) {
    var result=new Dictionary<string,object>{{"schema",1},{"observationOnly",true},{"expectedIdentity",c.original.identity},{"expectedCreation",c.original.creation}};IntPtr volume=IntPtr.Zero;
    try {
      result["held"]=HandleObservation(held,c.original,c.plan.profileSid,c.subjectSecurity);
      volume=CreateFileW("\\\\?\\"+Path.GetPathRoot(c.target),0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);int volumeError=Valid(volume)?0:Marshal.GetLastWin32Error();result["volumeOpened"]=Valid(volume);result["volumeError"]=volumeError;
      if(Valid(volume)){INFO info;bool read=GetFileInformationByHandle(volume,out info);int error=read?0:Marshal.GetLastWin32Error();result["volumeRead"]=read;result["volumeReadError"]=error;result["volumeMatched"]=read&&info.Volume.ToString("x8")==c.original.identity.Substring(0,8);
        var lookups=new List<object>();result["lookups"]=lookups;foreach(uint access in new uint[]{0x001e0081,0x00100080}) {
          var descriptor=new ID_DESCRIPTOR{Size=24,Type=0,Low=Convert.ToUInt64(c.original.identity.Substring(9),16),High=0};IntPtr opened=OpenFileById(volume,ref descriptor,access,7,IntPtr.Zero,0x02200000);int openError=Valid(opened)?0:Marshal.GetLastWin32Error();var observation=new Dictionary<string,object>{{"access",access.ToString("x8")},{"opened",Valid(opened)},{"error",openError}};
          lookups.Add(observation);try{if(Valid(opened))observation["handle"]=HandleObservation(opened,c.original,c.plan.profileSid,c.subjectSecurity);}finally{if(Valid(opened)){bool closed=CloseHandle(opened);int closeError=closed?0:Marshal.GetLastWin32Error();observation["closed"]=closed;observation["closeError"]=closeError;if(!closed)c.proof["diagnosticCleanupUnconfirmed"]=true;}}
        }result["lookups"]=lookups;
      }
    }catch(Exception e){result["diagnosticFailureType"]=e.GetType().Name;}
    finally{if(Valid(volume)){bool closed=CloseHandle(volume);int error=closed?0:Marshal.GetLastWin32Error();result["volumeClosed"]=closed;result["volumeCloseError"]=error;if(!closed)c.proof["diagnosticCleanupUnconfirmed"]=true;}}
    return result;
  }
  static void Recover(Context c,string survivingSubject,bool replacement){
    c.phase="restore";var result=WindowsAppContainerResourcesNative.Restore(c.plan);Need(Convert.ToInt32(result["restored"])==(replacement?3:4)&&Convert.ToInt32(result["newEntries"])==(replacement?1:0)&&Convert.ToInt32(result["deletedEntries"])==(replacement?1:0),"restore-counts");
    Need(Snapshot(c.guard)==c.guardSecurity&&Snapshot(c.outsideGuard)==c.outsideSecurity&&Snapshot(c.target)==c.targetSecurity&&Snapshot(c.scratch)==c.scratchSecurity&&File.ReadAllText(c.outsideGuard)=="outside","unrelated-security-preserved");
    if(survivingSubject!=null){Need(!HasPackage(survivingSubject,c.plan.profileSid),"subject-package-removed");if(!replacement)Need(Snapshot(survivingSubject)==c.subjectSecurity,"original-security-restored");else Need(File.ReadAllText(survivingSubject)=="replacement"&&(Security(survivingSubject).ControlFlags&ControlFlags.DiscretionaryAclProtected)==0,"replacement-not-old-security");}
    foreach(string path in new[]{c.target,c.scratch,c.guard})Need(!HasPackage(path,c.plan.profileSid),"package-removed");c.phase="repeat-restore";var repeated=WindowsAppContainerResourcesNative.Restore(c.plan);Need(Json.Serialize(repeated)==Json.Serialize(result),"repeated-restore-counts");ProfileRemoved(c.profile);c.recovered=true;c.proof["restore"]=result;c.proof["repeatedRestore"]=true;c.proof["profileRemoved"]=true;c.proof["outsideGuardUnchanged"]=true;c.proof["cleanupConfirmed"]=true;
  }
  static Dictionary<string,object> RequireClassicObservation(Context c,IntPtr handle,bool pending,bool baseline,bool package,string stage) {
    var observation=HandleObservation(handle,c.original,c.plan.profileSid,c.subjectSecurity);c.proof[stage]=observation;
    Need((bool)observation["opened"]&&(bool)observation["identityRead"]&&(bool)observation["identityMatched"]&&(bool)observation["standardRead"]&&!(bool)observation["directory"]&&(bool)observation["deletePending"]==pending,"classic-held-object-state");
    Need((uint)observation["securityError"]==0&&(bool)observation["baselineSecurityMatched"]==baseline&&(bool)observation["packagePresent"]==package,"classic-held-object-security");return observation;
  }
  static void ClassicDisposition(Context c,IntPtr handle,bool delete,string stage) {
    var disposition=new DISPOSITION{DeleteFile=delete?(byte)1:(byte)0};bool success=SetFileInformationByHandle(handle,4,ref disposition,1);int error=success?0:Marshal.GetLastWin32Error();
    c.proof[stage]=new{informationClass=4,bytes=1,delete=delete,success=success,error=error};Need(success,delete?"classic-mark-failed":"classic-reset-failed");
  }
  static void CloseClassic(Context c,IntPtr handle,string stage) {
    if(!Valid(handle))return;bool closed=CloseHandle(handle);int error=closed?0:Marshal.GetLastWin32Error();c.proof[stage]=new{closed=closed,error=error};
    if(!closed)c.proof["diagnosticCleanupUnconfirmed"]=true;
  }
  static int RequireLookupObservation(Context c,object value) {
    var observation=(Dictionary<string,object>)value;Need(!observation.ContainsKey("diagnosticFailureType")&&(bool)observation["volumeOpened"]&&(bool)observation["volumeRead"]&&(bool)observation["volumeMatched"]&&(bool)observation["volumeClosed"],"lookup-context-required");
    var lookups=(List<object>)observation["lookups"];Need(lookups.Count==2,"lookup-count");int fullError=-1;
    for(int i=0;i<2;i++){var lookup=(Dictionary<string,object>)lookups[i];Need((string)lookup["access"]==(i==0?"001e0081":"00100080"),"lookup-access");int error=(int)lookup["error"];bool opened=(bool)lookup["opened"];Need((opened&&error==0)||(!opened&&error==5),"lookup-live-identity-must-open-or-deny");
      if(opened){var handle=(Dictionary<string,object>)lookup["handle"];Need((bool)lookup["closed"]&&(int)lookup["closeError"]==0&&(bool)handle["identityRead"]&&(bool)handle["identityMatched"]&&(string)handle["identity"]==c.original.identity&&(string)handle["creation"]==c.original.creation&&(bool)handle["standardRead"]&&(bool)handle["deletePending"]&&!(bool)handle["directory"],"lookup-exact-pending-object");}
      if(i==0){fullError=error;if(opened)Need((uint)((Dictionary<string,object>)lookup["handle"])["securityError"]==0,"lookup-full-security-positive");}else if(fullError==0)Need(error==0,"lookup-minimal-positive");
    }return fullError;
  }
  static void ModernPending(Context c) {
    string moved=MoveOutside(c);IntPtr observer=IntPtr.Zero;
    try {
      observer=CreateFileW("\\\\?\\"+moved,0x20080,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero);Need(Valid(observer),"pending-handle-open");File.Delete(moved);
      var before=RequireClassicObservation(c,observer,true,false,true,"modernPendingHeldBefore");Need((uint)before["links"]==0,"modern-unlinked-state");c.proof["deletePendingObserved"]=true;
      c.proof["pendingBeforeRestore"]=ObservePending(c,observer);Need(RequireLookupObservation(c,c.proof["pendingBeforeRestore"])==0,"modern-full-lookup-positive");
      c.phase="held-pending-restore";var heldResult=WindowsAppContainerResourcesNative.Restore(c.plan);c.proof["heldRestore"]=heldResult;Need(Convert.ToInt32(heldResult["restored"])==4&&Convert.ToInt32(heldResult["newEntries"])==0&&Convert.ToInt32(heldResult["deletedEntries"])==0,"modern-held-restore-counts");
      c.proof["pendingAfterRestore"]=ObservePending(c,observer);Need(RequireLookupObservation(c,c.proof["pendingAfterRestore"])==0,"modern-after-lookup-positive");Need((uint)RequireClassicObservation(c,observer,true,true,false,"modernPendingHeldAfter")["links"]==0,"modern-after-unlinked-state");
      Need(Json.Serialize(WindowsAppContainerResourcesNative.Restore(c.plan))==Json.Serialize(heldResult),"modern-held-repeat-counts");Need((uint)RequireClassicObservation(c,observer,true,true,false,"modernPendingHeldRepeated")["links"]==0,"modern-repeated-unlinked-state");c.proof["heldRepeatedRestore"]=true;
      bool closed=CloseHandle(observer);int error=closed?0:Marshal.GetLastWin32Error();c.proof["modernObserverClose"]=new{closed=closed,error=error};Need(closed,"pending-handle-close");observer=IntPtr.Zero;
      c.phase="post-pending-restore";var result=WindowsAppContainerResourcesNative.Restore(c.plan);Need(Convert.ToInt32(result["restored"])==3&&Convert.ToInt32(result["newEntries"])==0&&Convert.ToInt32(result["deletedEntries"])==1,"pending-restore-counts");Need(Json.Serialize(WindowsAppContainerResourcesNative.Restore(c.plan))==Json.Serialize(result),"pending-repeat-counts");
      Need(Snapshot(c.guard)==c.guardSecurity&&Snapshot(c.outsideGuard)==c.outsideSecurity&&Snapshot(c.target)==c.targetSecurity&&Snapshot(c.scratch)==c.scratchSecurity,"pending-security-restored");ProfileRemoved(c.profile);c.recovered=true;c.proof["restore"]=result;c.proof["repeatedRestore"]=true;c.proof["profileRemoved"]=true;c.proof["outsideGuardUnchanged"]=true;c.proof["cleanupConfirmed"]=true;
    } finally {CloseClassic(c,observer,"modernObserverClose");}
  }
  static void ClassicPending(Context c) {
    string moved=MoveOutside(c);IntPtr observer=IntPtr.Zero,disposer=IntPtr.Zero;string planHash=Sha(File.ReadAllBytes(c.planFile));
    try {
      c.phase="classic-open";observer=CreateFileW("\\\\?\\"+moved,0x20080,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero);int observerError=Valid(observer)?0:Marshal.GetLastWin32Error();c.proof["classicObserverOpen"]=new{access="00020080",share=7,error=observerError,opened=Valid(observer)};Need(Valid(observer),"classic-observer-open");
      disposer=CreateFileW("\\\\?\\"+moved,0x30080,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero);int disposerError=Valid(disposer)?0:Marshal.GetLastWin32Error();c.proof["classicDisposerOpen"]=new{access="00030080",share=7,error=disposerError,opened=Valid(disposer)};Need(Valid(disposer),"classic-disposer-open");
      var initial=RequireClassicObservation(c,observer,false,false,true,"classicObserverBefore");RequireClassicObservation(c,disposer,false,false,true,"classicDisposerBefore");
      c.phase="classic-mark";ClassicDisposition(c,disposer,true,"classicMark");RequireClassicObservation(c,observer,true,false,true,"classicPendingHeld");
      c.proof["classicPendingBeforeRestore"]=ObservePending(c,observer);
      int lookupError=RequireLookupObservation(c,c.proof["classicPendingBeforeRestore"]);bool restoredWhilePending=lookupError==0;c.proof["classicWhilePendingOutcome"]=restoredWhilePending?"restored":"refused";
      try{if(restoredWhilePending){var result=WindowsAppContainerResourcesNative.Restore(c.plan);c.proof["classicHeldRestore"]=result;Need(Convert.ToInt32(result["restored"])==4&&Convert.ToInt32(result["newEntries"])==0&&Convert.ToInt32(result["deletedEntries"])==0,"classic-held-restore-counts");Need(Json.Serialize(WindowsAppContainerResourcesNative.Restore(c.plan))==Json.Serialize(result),"classic-held-repeat-counts");c.proof["classicHeldRepeatedRestore"]=true;}
      else Refused(c,c.plan,"WINDOWS_ACL_IDENTITY_UNAVAILABLE",5);}
      finally{c.proof["classicPendingAfterRestore"]=ObservePending(c,observer);}Need(RequireLookupObservation(c,c.proof["classicPendingAfterRestore"])==lookupError,"classic-lookup-state-stable");
      var after=RequireClassicObservation(c,observer,true,restoredWhilePending,!restoredWhilePending,"classicAfterRestoreHeld");Need(Sha(File.ReadAllBytes(c.planFile))==planHash,"classic-plan-preserved");if(!restoredWhilePending)Need((string)initial["securitySha256"]==(string)after["securitySha256"],"classic-refusal-preserves-object");
      c.phase="classic-reset";ClassicDisposition(c,disposer,false,"classicReset");var reset=RequireClassicObservation(c,observer,false,restoredWhilePending,!restoredWhilePending,"classicResetHeld");Need((string)after["securitySha256"]==(string)reset["securitySha256"],"classic-reset-preserves-security");
      var reopened=Id(moved);Need(reopened.identity==c.original.identity&&reopened.creation==c.original.creation&&!File.Exists(c.subject),"classic-reset-same-original");c.proof["classicResetNameIdentity"]=reopened;
      Recover(c,moved,false);RequireClassicObservation(c,observer,false,true,false,"classicRecoveredHeld");c.proof["classicResetRecoveredOriginal"]=true;
    } finally {CloseClassic(c,disposer,"classicDisposerClose");CloseClassic(c,observer,"classicObserverClose");}
  }
  static object Run(string root,string name){Context c=new Context{name=name};c.proof["case"]=name;IntPtr owned=IntPtr.Zero;try{
    Setup(c,root,name);c.phase="controlled-mutation";
    if(name=="no-change"){c.proof["noMutation"]=true;Recover(c,c.subject,false);}
    else if(name=="outside-rename")Recover(c,MoveOutside(c),false);
    else if(name=="creation-mismatch"){string moved=MoveOutside(c);var wrong=WindowsAppContainerResourcesNative.ReadPlan(Json.Serialize(c.plan));var entry=wrong.entries.Single(e=>e.identity==c.original.identity);entry.creation=(Int64.Parse(entry.creation)+1).ToString(System.Globalization.CultureInfo.InvariantCulture);wrong=WindowsAppContainerResourcesNative.ReadPlan(Json.Serialize(wrong));string before=Snapshot(moved);Refused(c,wrong,"WINDOWS_ACL_IDENTITY_MISMATCH",null);Need(Snapshot(moved)==before,"mismatch-no-subject-mutation");Recover(c,moved,false);}
    else if(name=="sharing-denial"){string moved=MoveOutside(c);owned=CreateFileW("\\\\?\\"+moved,0x80000000,0,IntPtr.Zero,3,0x00200000,IntPtr.Zero);Need(Valid(owned),"exclusive-handle-open");Refused(c,c.plan,"WINDOWS_ACL_IDENTITY_UNAVAILABLE",32);Need(CloseHandle(owned),"exclusive-handle-close");owned=IntPtr.Zero;Recover(c,moved,false);}
    else if(name=="classic-delete-pending")ClassicPending(c);
    else if(name=="deleted-replacement"){File.Delete(c.subject);File.WriteAllText(c.subject,"replacement");var replacement=Id(c.subject);Need(replacement.identity!=c.original.identity,"replacement-new-identity");c.proof["replacement"]=replacement;Recover(c,c.subject,true);}
    else if(name=="delete-pending")ModernPending(c);
    else throw new InvalidOperationException("unknown-case");Need(!c.proof.ContainsKey("diagnosticCleanupUnconfirmed"),"diagnostic-cleanup-unconfirmed");c.proof["passed"]=true;return c.proof;
  }catch(Exception e){var refusal=e as WindowsAppContainerResourcesNative.Refusal;var result=c==null?new Dictionary<string,object>{{"case",name}}:c.proof;result["passed"]=false;result["cleanupConfirmed"]=false;result["phase"]=c==null?"setup":c.phase;result["code"]=refusal==null?"FIXTURE_FAILURE":refusal.Code;result["win32"]=Win32(e);result["hresult"]=e.HResult;if(e is InvalidOperationException&&System.Text.RegularExpressions.Regex.IsMatch(e.Message,"^[a-z0-9-]{1,80}$"))result["assertion"]=e.Message;result["retained"]=true;return result;
  }finally{if(Valid(owned)){bool closed=CloseHandle(owned);if(!closed){if(c!=null){bool wasPassed=c.proof.ContainsKey("passed")&&(bool)c.proof["passed"];c.proof["passed"]=false;c.proof["cleanupConfirmed"]=false;c.proof["retained"]=true;c.proof["ownedHandleCloseFailed"]=true;if(wasPassed)c.proof["code"]="OWNED_HANDLE_CLOSE_FAILED";}Console.Error.WriteLine("IDENTITY_OWNED_HANDLE_CLOSE_FAILED");}}}}
  public static int Main(string[] args){try{Need(args.Length==1&&Contracts(),"controller-contract");string architecture=Architecture();string[] names={"no-change","outside-rename","creation-mismatch","sharing-denial","deleted-replacement","delete-pending","classic-delete-pending"};var cases=names.Select(name=>(Dictionary<string,object>)Run(args[0],name)).ToArray();bool success=cases.All(c=>(bool)c["passed"]);string output=Json.Serialize(new{schema=1,scope="actual-source-resource-recovery-host-controls-no-worker-started",architecture=architecture,cases=cases,cleanupConfirmed=success,accepted=false});Need(Encoding.UTF8.GetByteCount(output)<=32768,"proof-bound");Console.Write(output);return success?0:1;}catch(Exception e){Console.Error.WriteLine("IDENTITY_FIXTURE_CONTROLLER_FAILED:"+e.GetType().Name);return 2;}}
}
