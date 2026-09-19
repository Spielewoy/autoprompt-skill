// Native regression: uses the actual resource lifecycle and launcher sources.
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

public static class GitAclProof {
  static string Phase="startup";
  static Dictionary<string,object> Prelaunch=null;
  static string BoundedStage(string value){return value!=null&&System.Text.RegularExpressions.Regex.IsMatch(value,"^[A-Za-z0-9_-]{1,80}$")?value:"unclassified";}
  public static Dictionary<string,object> FailureDetails(Exception error){
    var native=error as System.ComponentModel.Win32Exception;
    return new Dictionary<string,object>{{"schema",1},{"fixturePhase",BoundedStage(Phase)},{"exceptionType",BoundedStage(error.GetType().Name)},{"nativeErrorCode",native==null?(object)null:native.NativeErrorCode},{"hresult",error.HResult},{"launcherStage",BoundedStage(WindowsAppContainerNative.LastStage)},{"launcherWin32",WindowsAppContainerNative.LastWin32},{"prelaunch",Prelaunch}};
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsWow64Process2(IntPtr process,out ushort machine,out ushort native);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int length,out int returned);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string path,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  static void Need(bool value,string code){if(!value)throw new InvalidOperationException(code);}
  static string Hash(string path){using(var stream=File.OpenRead(path))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
  static string NativeArchitecture(){ushort machine,native;Need(IsWow64Process2(new IntPtr(-1),out machine,out native)&&machine==0&&(native==0x8664||native==0xaa64),"native-controller-architecture");return native==0x8664?"x64":"arm64";}
  static bool Protected(RawSecurityDescriptor sd){return (sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0;}
  static RawSecurityDescriptor Security(string path){IntPtr owner,group,dacl,sacl,sd;Need(GetNamedSecurityInfo(path,1,0x15,out owner,out group,out dacl,out sacl,out sd)==0,"snapshot-security");try{uint length=GetSecurityDescriptorLength(sd);Need(length>0&&length<=65536,"snapshot-bound");byte[] bytes=new byte[(int)length];Marshal.Copy(sd,bytes,0,bytes.Length);return new RawSecurityDescriptor(bytes,0);}finally{if(sd!=IntPtr.Zero)LocalFree(sd);}}
  static string Label(RawSecurityDescriptor sd){if(sd.SystemAcl==null)return "";byte[] bytes=new byte[sd.SystemAcl.BinaryLength];sd.SystemAcl.GetBinaryForm(bytes,0);return Convert.ToBase64String(bytes);}
  static object GrantObservation(string path,string sid){
    var security=Security(path);string label=Label(security);Need(label.Length<=5464,"diagnostic-label-bound");
    return new{owner=security.Owner.Value,daclProtected=Protected(security),label=label,packageAces=security.DiscretionaryAcl.Cast<GenericAce>().OfType<CommonAce>().Where(ace=>ace.SecurityIdentifier.Value==sid).Select(ace=>new{mask=ace.AccessMask,flags=(int)ace.AceFlags,qualifier=ace.AceQualifier.ToString()}).ToArray()};
  }
  static string[] Aces(RawSecurityDescriptor sd,string exclude){var values=new List<string>();foreach(GenericAce ace in sd.DiscretionaryAcl){var q=ace as QualifiedAce;Need(q!=null,"qualified-ace");if(q.SecurityIdentifier.Value==exclude)continue;byte[] bytes=new byte[ace.BinaryLength];ace.GetBinaryForm(bytes,0);values.Add(Convert.ToBase64String(bytes));}values.Sort(StringComparer.Ordinal);return values.ToArray();}
  static RawSecurityDescriptor WithAces(RawSecurityDescriptor baseline,string[] entries){var acl=new RawAcl(baseline.DiscretionaryAcl.Revision,entries.Length);foreach(string encoded in entries)acl.InsertAce(acl.Count,GenericAce.CreateFromBinaryForm(Convert.FromBase64String(encoded),0));return new RawSecurityDescriptor(baseline.ControlFlags,baseline.Owner,baseline.Group,baseline.SystemAcl,acl);}
  static object AceObservation(RawSecurityDescriptor sd,string sid){
    Need(sd.DiscretionaryAcl.Count<=32,"diagnostic-ACE-count-bound");var values=new List<object>();
    foreach(string encoded in Aces(sd,sid)){byte[] bytes=Convert.FromBase64String(encoded);Need(bytes.Length<=512,"diagnostic-ACE-byte-bound");var ace=(QualifiedAce)GenericAce.CreateFromBinaryForm(bytes,0);values.Add(new{base64=encoded,type=ace.AceType.ToString(),flags=(int)ace.AceFlags,qualifier=ace.AceQualifier.ToString(),sid=ace.SecurityIdentifier.Value,mask=ace.AccessMask});}
    return new{daclProtected=Protected(sd),count=values.Count,aces=values};
  }
  static void ObserveRestoreMismatch(string file,string target,string scratch,string control,string sid,RawSecurityDescriptor baseline,RawSecurityDescriptor applied,RawSecurityDescriptor beforeRestore,RawSecurityDescriptor expected,RawSecurityDescriptor actual){
    string root=file==target||file.StartsWith(target+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)?target:scratch;string relative=(root==target?"target":"scratch")+file.Substring(root.Length).Replace('\\','/');
    Need(System.Text.RegularExpressions.Regex.IsMatch(relative,"^[A-Za-z0-9_./-]{1,256}$"),"diagnostic-role-bound");
    string record=new JavaScriptSerializer().Serialize(new{schema=1,relative=relative,baseline=AceObservation(baseline,sid),applied=AceObservation(applied,sid),beforeRestore=AceObservation(beforeRestore,sid),expected=AceObservation(expected,sid),actual=AceObservation(actual,sid)});Need(record.Length<=32768,"diagnostic-restore-bound");
    File.WriteAllText(Path.Combine(control,"restore-mismatch.json"),record);Console.Error.WriteLine("GIT_ACL_RESTORE_MISMATCH:"+record);
  }
  static string[] Paths(string root){return new[]{root}.Concat(Directory.GetDirectories(root,"*",SearchOption.AllDirectories)).Concat(Directory.GetFiles(root,"*",SearchOption.AllDirectories)).OrderBy(x=>x,StringComparer.Ordinal).ToArray();}
  static void CheckToken(string sid){IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero;try{Need(OpenProcessToken(new IntPtr(-1),8,out token),"child-token-open");buffer=Marshal.AllocHGlobal(512);int returned;Need(GetTokenInformation(token,29,buffer,512,out returned)&&returned==4&&Marshal.ReadInt32(buffer)==1,"child-is-AppContainer");Need(GetTokenInformation(token,31,buffer,512,out returned)&&new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value==sid,"child-package-SID");}finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(token!=IntPtr.Zero)CloseHandle(token);}}
  public sealed class ChildResult { public bool appContainer; public string architecture; public string[] denials; public int positiveOperations; }
  static readonly string[] DenialNames={"overwrite","append","rename-file","delete-file","rename-git","new-git-file","nested-write","nested-create","protected-write","git-file-WRITE_DAC","git-directory-WRITE_DAC","target-WRITE_DAC","target-DELETE_CHILD","git-DELETE_CHILD"};
  static void Denied(string name,Action action,List<string> outcomes){try{action();}catch(UnauthorizedAccessException error){Need((error.HResult&65535)==5,"unexpected-denial:"+name+":"+(error.HResult&65535));outcomes.Add(name+":5");return;}catch(IOException error){Need((error.HResult&65535)==5,"unexpected-io:"+name+":"+(error.HResult&65535));outcomes.Add(name+":5");return;}throw new InvalidOperationException("WRITE_SUCCEEDED:"+name);}
  static void DeniedHandle(string path,uint access,string name,List<string> outcomes){IntPtr handle=CreateFile(path,access,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);if(handle!=new IntPtr(-1)){if(handle!=IntPtr.Zero)CloseHandle(handle);throw new InvalidOperationException("HANDLE_GRANTED:"+name);}int error=Marshal.GetLastWin32Error();Need(error==5,"unexpected-handle-denial:"+name+":"+error);outcomes.Add(name+":5");}
  static int Child(string target,string scratch,string sid){Phase="child-controls";CheckToken(sid);var outcomes=new List<string>();string git=Path.Combine(target,".git"),guard=Path.Combine(git,"guard"),nested=Path.Combine(git,"nested"),protectedFile=Path.Combine(git,"protected","guard");
    Need(File.ReadAllText(guard)=="controller git"&&File.ReadAllText(Path.Combine(target,"allowed"))=="allowed","read-positive");
    File.WriteAllText(Path.Combine(target,"allowed"),"worker allowed");File.WriteAllText(Path.Combine(target,"new-worker"),"new");File.AppendAllText(Path.Combine(target,"new-worker")," append");Directory.CreateDirectory(Path.Combine(target,"new-directory"));File.WriteAllText(Path.Combine(target,"new-directory","child"),"child");File.WriteAllText(Path.Combine(scratch,"new-worker"),"scratch");
    Denied("overwrite",()=>File.WriteAllText(guard,"bad"),outcomes);Denied("append",()=>File.AppendAllText(guard,"bad"),outcomes);Denied("rename-file",()=>File.Move(guard,Path.Combine(git,"moved-guard")),outcomes);Denied("delete-file",()=>File.Delete(guard),outcomes);Denied("rename-git",()=>Directory.Move(git,Path.Combine(target,"moved-git")),outcomes);Denied("new-git-file",()=>File.WriteAllText(Path.Combine(git,"new"),"bad"),outcomes);Denied("nested-write",()=>File.WriteAllText(Path.Combine(nested,"guard"),"bad"),outcomes);Denied("nested-create",()=>File.WriteAllText(Path.Combine(nested,"new"),"bad"),outcomes);Denied("protected-write",()=>File.WriteAllText(protectedFile,"bad"),outcomes);
    DeniedHandle(guard,0x40000,"git-file-WRITE_DAC",outcomes);DeniedHandle(git,0x40000,"git-directory-WRITE_DAC",outcomes);DeniedHandle(target,0x40000,"target-WRITE_DAC",outcomes);DeniedHandle(target,0x40,"target-DELETE_CHILD",outcomes);DeniedHandle(git,0x40,"git-DELETE_CHILD",outcomes);
    Need(outcomes.SequenceEqual(DenialNames.Select(x=>x+":5")),"closed-child-outcomes");Console.Write(new JavaScriptSerializer().Serialize(new{appContainer=true,architecture=NativeArchitecture(),denials=outcomes,positiveOperations=8}));return 0;
  }
  static void Refuses(string expected,Action action){try{action();}catch(WindowsAppContainerResourcesNative.Refusal error){Need(error.Code==expected,"exact-refusal:expected="+expected+":actual="+error.Code);return;}throw new InvalidOperationException("expected-refusal:"+expected);}
  static void InvalidPlans(string json){
    Refuses("WINDOWS_RESOURCE_INVALID",()=>WindowsAppContainerResourcesNative.ReadPlan(json.Replace("\"schemaVersion\":3","\"schemaVersion\":1")));
    Refuses("WINDOWS_RESOURCE_INVALID",()=>WindowsAppContainerResourcesNative.ReadPlan(json.Replace("\"schemaVersion\":3","\"schemaVersion\":2")));
    var serializer=new JavaScriptSerializer();var missing=serializer.DeserializeObject(json) as Dictionary<string,object>;var entry=((object[])missing["entries"]).Cast<Dictionary<string,object>>().First(value=>!(bool)value["daclProtected"]);entry.Remove("daclProtected");Refuses("WINDOWS_RESOURCE_INVALID",()=>WindowsAppContainerResourcesNative.ReadPlan(serializer.Serialize(missing)));
    Refuses("WINDOWS_RESOURCE_INVALID",()=>WindowsAppContainerResourcesNative.ReadPlan(json.Replace("\"daclProtected\":false","\"daclProtected\":\"false\"")));
    Refuses("WINDOWS_RESOURCE_INVALID",()=>WindowsAppContainerResourcesNative.ReadPlan(json.Substring(0,json.Length-1)+",\"extra\":true}"));
    Action<Action<Dictionary<string,object>>> invalid=change=>{var wire=serializer.DeserializeObject(json) as Dictionary<string,object>;var git=((object[])wire["entries"]).Cast<Dictionary<string,object>>().First(value=>(bool)value["git"]&&!(bool)value["daclProtected"]&&((object[])value["inheritedAces"]).Length>0);change(git);Refuses("WINDOWS_RESOURCE_INVALID",()=>WindowsAppContainerResourcesNative.ReadPlan(serializer.Serialize(wire)));};
    invalid(git=>git.Remove("inheritedAces"));invalid(git=>git["explicitAces"]=null);invalid(git=>git["inheritedAces"]="not-an-array");invalid(git=>git["inheritedAces"]=new object[]{null});
    invalid(git=>git["inheritedAces"]=new[]{"invalid-base64"});
    invalid(git=>{var raw=Convert.FromBase64String((string)((object[])git["inheritedAces"])[0]);raw[1]&=239;git["inheritedAces"]=new[]{Convert.ToBase64String(raw)};});
    invalid(git=>git["explicitAces"]=git["inheritedAces"]);
    invalid(git=>{var raw=Convert.FromBase64String((string)((object[])git["inheritedAces"])[0]);raw[1]&=239;raw[4]^=2;git["explicitAces"]=new[]{Convert.ToBase64String(raw)};});
    invalid(git=>git["daclProtected"]=true);invalid(git=>git["git"]=false);
    // AclSize is a USHORT: aligned 65532 bytes is valid, 65536 is not.
    string system="ABMUAP8BHwABAQAAAAAABRIAAAA=";byte[] administrator=new byte[24];Array.Copy(Convert.FromBase64String(system),administrator,20);administrator[2]=24;administrator[9]=2;BitConverter.GetBytes(32u).CopyTo(administrator,16);BitConverter.GetBytes(544u).CopyTo(administrator,20);string longer=Convert.ToBase64String(administrator);
    var boundary=serializer.DeserializeObject(json) as Dictionary<string,object>;var boundaryGit=((object[])boundary["entries"]).Cast<Dictionary<string,object>>().First(value=>(bool)value["git"]&&!(bool)value["daclProtected"]);boundaryGit["inheritedAces"]=Enumerable.Repeat(system,3275).Concat(new[]{longer}).ToArray();boundaryGit["explicitAces"]=new string[0];WindowsAppContainerResourcesNative.ReadPlan(serializer.Serialize(boundary));
    boundaryGit["inheritedAces"]=Enumerable.Repeat(system,3274).Concat(new[]{longer,longer}).ToArray();Refuses("WINDOWS_RESOURCE_INVALID",()=>WindowsAppContainerResourcesNative.ReadPlan(serializer.Serialize(boundary)));
  }
  static void PartialRecovery(string parent){
    string target=Path.Combine(parent,"partial-target");Directory.CreateDirectory(target);Protect(target,true);string git=Path.Combine(target,".git");Directory.CreateDirectory(git);File.WriteAllText(Path.Combine(git,"guard"),"partial guard");
    var before=Paths(target).ToDictionary(x=>x,Security);string name="Autoprompt_"+Guid.NewGuid().ToString("N");var plan=WindowsAppContainerResourcesNative.Plan(name,new[]{new WindowsAppContainerResourcesNative.RootSpec{path=target,kind="directory",writable=true}});File.WriteAllText(Path.Combine(parent,"partial-resource-plan.json"),new JavaScriptSerializer().Serialize(plan));IntPtr package=IntPtr.Zero;
    try{Need(WindowsAppContainerNative.CreateAppContainerProfile(name,name,name,IntPtr.Zero,0,out package)==0,"partial-profile");var info=new DirectoryInfo(target);var acl=info.GetAccessControl();acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(plan.profileSid),(FileSystemRights)0x001201bf,InheritanceFlags.ObjectInherit|InheritanceFlags.ContainerInherit,PropagationFlags.None,AccessControlType.Allow));info.SetAccessControl(acl);
      Need(!Protected(Security(git))&&Security(git).DiscretionaryAcl.Cast<GenericAce>().OfType<CommonAce>().Any(ace=>ace.SecurityIdentifier.Value==plan.profileSid&&(ace.AccessMask&2)!=0&&(ace.AceFlags&AceFlags.Inherited)!=0),"actual-partial-inherited-write-grant");
      WindowsAppContainerResourcesNative.Restore(plan);
      foreach(var item in before){var after=Security(item.Key);Need(Protected(after)==Protected(item.Value)&&Aces(after,plan.profileSid).SequenceEqual(Aces(item.Value,plan.profileSid))&&!after.DiscretionaryAcl.Cast<GenericAce>().OfType<QualifiedAce>().Any(ace=>ace.SecurityIdentifier.Value==plan.profileSid),"partial-apply-restored");}
    }finally{if(package!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(package);}
  }
  static void Protect(string path,bool directory){if(directory){var info=new DirectoryInfo(path);var acl=info.GetAccessControl();acl.SetAccessRuleProtection(true,true);info.SetAccessControl(acl);}else{var info=new FileInfo(path);var acl=info.GetAccessControl();acl.SetAccessRuleProtection(true,true);info.SetAccessControl(acl);}}
  static void AddUnrelated(string path){var info=new FileInfo(path);var acl=info.GetAccessControl();acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-19"),FileSystemRights.ReadAttributes,AccessControlType.Allow));info.SetAccessControl(acl);}
  static void OwnedAceDrift(string parent){
    string target=Path.Combine(parent,"drift-target"),git=Path.Combine(target,".git");Directory.CreateDirectory(git);Protect(target,true);File.WriteAllText(Path.Combine(git,"guard"),"drift fixture");
    var baseline=Paths(target).ToDictionary(x=>x,Security);var plan=WindowsAppContainerResourcesNative.Plan("Autoprompt_"+Guid.NewGuid().ToString("N"),new[]{new WindowsAppContainerResourcesNative.RootSpec{path=target,kind="directory",writable=true}});
    WindowsAppContainerResourcesNative.Apply(plan);var info=new DirectoryInfo(git);var saved=info.GetAccessControl();var changed=info.GetAccessControl();
    // Change one owned permission while retaining the controller's exact
    // inventory/recovery access; otherwise the fixture tests an earlier open
    // denial instead of the provenance refusal it is intended to exercise.
    FileSystemRights driftRights=(FileSystemRights)((int)FileSystemRights.FullControl&~2);
    changed.SetAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,driftRights,InheritanceFlags.ObjectInherit|InheritanceFlags.ContainerInherit,PropagationFlags.None,AccessControlType.Allow));info.SetAccessControl(changed);var beforeRefusal=Security(git);
    IntPtr inspection=CreateFile(git,0x001e0081,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);int inspectionError=Marshal.GetLastWin32Error();Need(inspection!=IntPtr.Zero&&inspection!=new IntPtr(-1),"drift-controller-inspection:"+inspectionError);Need(CloseHandle(inspection),"drift-controller-inspection-close");
    Need(beforeRefusal.DiscretionaryAcl.Cast<GenericAce>().OfType<CommonAce>().Any(ace=>ace.SecurityIdentifier.Value==WindowsIdentity.GetCurrent().User.Value&&ace.AccessMask==(int)driftRights&&(ace.AceFlags&AceFlags.Inherited)==0),"drift-owned-permission-changed");
    Refuses("WINDOWS_ACL_INHERITANCE_CHANGED",()=>WindowsAppContainerResourcesNative.Restore(plan));var refused=Security(git);Need(Protected(refused)&&Aces(refused,plan.profileSid).SequenceEqual(Aces(beforeRefusal,plan.profileSid))&&refused.DiscretionaryAcl.Cast<GenericAce>().OfType<QualifiedAce>().Any(ace=>ace.SecurityIdentifier.Value==plan.profileSid),"changed-owned-ACE-retained");
    // Reverse only this fixture's deliberate edit, then exercise resumed and
    // repeated recovery against the same journal after the parent was restored.
    var repair=new DirectorySecurity();repair.SetSecurityDescriptorBinaryForm(saved.GetSecurityDescriptorBinaryForm(),AccessControlSections.Access);info.SetAccessControl(repair);WindowsAppContainerResourcesNative.Restore(plan);WindowsAppContainerResourcesNative.Restore(plan);
    foreach(var item in baseline){var after=Security(item.Key);Need(Protected(after)==Protected(item.Value)&&Aces(after,plan.profileSid).SequenceEqual(Aces(item.Value,plan.profileSid)),"drift-recovery-baseline");}
  }
  static int Controller(string target,string scratch,string executable,string control){
    Phase="fixture-setup";
    string git=Path.Combine(target,".git"),nested=Path.Combine(git,"nested"),protectedRoot=Path.Combine(git,"protected");Directory.CreateDirectory(nested);Directory.CreateDirectory(protectedRoot);File.WriteAllText(Path.Combine(git,"guard"),"controller git");File.WriteAllText(Path.Combine(nested,"guard"),"nested git");File.WriteAllText(Path.Combine(protectedRoot,"guard"),"protected git");File.WriteAllText(Path.Combine(target,"allowed"),"allowed");Protect(protectedRoot,true);Protect(Path.Combine(protectedRoot,"guard"),false);
    var originals=Paths(target).Concat(Paths(scratch)).ToDictionary(x=>x,Security);Need(!Protected(originals[git])&&Protected(originals[protectedRoot]),"mixed-original-protection");
    var roots=new[]{new WindowsAppContainerResourcesNative.RootSpec{path=target,kind="directory",writable=true},new WindowsAppContainerResourcesNative.RootSpec{path=scratch,kind="directory",writable=true},new WindowsAppContainerResourcesNative.RootSpec{path=Path.GetDirectoryName(executable),kind="directory",writable=false}};
    Phase="resource-plan";
    string name="Autoprompt_"+Guid.NewGuid().ToString("N");var plan=WindowsAppContainerResourcesNative.Plan(name,roots);Need(plan.schemaVersion==3,"plan-version");var serializer=new JavaScriptSerializer();string serializedPlan=serializer.Serialize(plan);InvalidPlans(serializedPlan);plan=WindowsAppContainerResourcesNative.ReadPlan(serializedPlan);File.WriteAllText(Path.Combine(control,"resource-plan.json"),serializer.Serialize(plan));string sid=plan.profileSid;IntPtr package=IntPtr.Zero;bool prepared=false,drained=false,restored=false;
    try{
      Phase="resource-apply";var appliedProfile=WindowsAppContainerResourcesNative.Apply(plan);prepared=true;Need(WindowsAppContainerNative.DeriveAppContainerSidFromAppContainerName(name,out package)==0&&package!=IntPtr.Zero,"derive-package");
      var applied=Paths(git).ToDictionary(x=>x,Security);foreach(var sd in applied.Values){Need(Protected(sd),"git-must-be-protected");var packageAces=sd.DiscretionaryAcl.Cast<GenericAce>().OfType<CommonAce>().Where(x=>x.SecurityIdentifier.Value==sid).ToArray();Need(packageAces.Length==1&&packageAces[0].AceQualifier==AceQualifier.AccessAllowed&&packageAces[0].AccessMask==0x1200a9&&(packageAces[0].AceFlags&AceFlags.Inherited)==0,"git-read-only-package-ACE");}
      var appliedOriginals=originals.Keys.ToDictionary(x=>x,Security);
      string system=Environment.GetEnvironmentVariable("SystemRoot");var env=new[]{"SystemRoot="+system,"WINDIR="+system,"SystemDrive="+system.Substring(0,2),"PATH="+Path.Combine(system,"System32"),"TEMP="+scratch,"TMP="+scratch};
      Phase="prelaunch-observation";
      Prelaunch=new Dictionary<string,object>{{"profilePathExists",Directory.Exists((string)appliedProfile["profilePath"])},{"executableSha256",Hash(executable)},{"managedArchitecture",typeof(System.Reflection.AssemblyName).GetProperty("ProcessorArchitecture").GetValue(System.Reflection.AssemblyName.GetAssemblyName(executable),null).ToString()},{"base",GrantObservation(Path.GetDirectoryName(target),sid)},{"runtime",GrantObservation(Path.GetDirectoryName(executable),sid)},{"executable",GrantObservation(executable,sid)},{"target",GrantObservation(target,sid)},{"scratch",GrantObservation(scratch,sid)},{"git",GrantObservation(git,sid)}};
      string prelaunchJson=serializer.Serialize(Prelaunch);Need(prelaunchJson.Length<=49152,"diagnostic-prelaunch-bound");File.WriteAllText(Path.Combine(control,"launch-inputs.json"),prelaunchJson);
      Phase="native-launch";
      var result=WindowsAppContainerNative.Launch(executable,Hash(executable),new[]{"child",target,scratch,sid},target,env,15000,32768,package,sid,Path.Combine(control,"never-cancelled"));drained=result.Drained;
      Phase="child-result";
      string stdout=Encoding.UTF8.GetString(Convert.FromBase64String(result.StdoutBase64)),stderr=Encoding.UTF8.GetString(Convert.FromBase64String(result.StderrBase64));Need(result.Drained&&!result.TimedOut&&!result.Cancelled&&!result.OutputLimit&&result.RootImageMatches,"native-owned-drain");Need(result.ExitCode==0&&stderr.Length==0,"child-result:"+result.ExitCode+":"+stderr);var child=serializer.Deserialize<ChildResult>(stdout);Need(child.appContainer&&child.architecture==NativeArchitecture()&&child.positiveOperations==8&&child.denials.SequenceEqual(DenialNames.Select(x=>x+":5")),"child-proof");
      Need(File.ReadAllText(Path.Combine(git,"guard"))=="controller git"&&File.ReadAllText(Path.Combine(nested,"guard"))=="nested git"&&File.ReadAllText(Path.Combine(protectedRoot,"guard"))=="protected git","guard-bytes-preserved");Need(File.ReadAllText(Path.Combine(target,"new-worker"))=="new append"&&File.ReadAllText(Path.Combine(scratch,"new-worker"))=="scratch","worker-positive-bytes");
      File.WriteAllText(Path.Combine(control,"child-proof.json"),serializer.Serialize(new{schema=1,architecture=child.architecture,appContainer=child.appContainer,drained=result.Drained,rootImageMatched=result.RootImageMatches,denials=child.denials,positiveOperations=child.positiveOperations,accepted=false}));
      // A legitimate unrelated ACE and controller-created .git file must survive
      // cleanup; new .git objects do not own any mandatory-label transition.
      string concurrent=Path.Combine(git,"guard");var beforeAdd=Aces(Security(concurrent),sid).ToList();AddUnrelated(concurrent);var added=Aces(Security(concurrent),sid).ToList();foreach(string ace in beforeAdd)Need(added.Remove(ace),"controller-addition-preserves-existing-ACEs");Need(added.Count==1,"one-controller-explicit-ACE");string[] concurrentAces=Aces(originals[concurrent],sid).Concat(added).OrderBy(x=>x,StringComparer.Ordinal).ToArray();string newGit=Path.Combine(git,"controller-new");File.WriteAllText(newGit,"controller new");var newGitBefore=Security(newGit);
      var beforeRestore=originals.Keys.ToDictionary(x=>x,Security);
      Phase="resource-restore";var cleanup=WindowsAppContainerResourcesNative.Restore(plan);restored=true;Need(Convert.ToInt32(cleanup["newEntries"])>=5,"dynamic-entries-restored");
      foreach(var item in originals){var after=Security(item.Key);Need(Protected(after)==Protected(item.Value)&&after.Owner.Value==item.Value.Owner.Value&&Label(after)==Label(item.Value),"original-metadata-restored");bool same=Aces(after,sid).SequenceEqual(item.Key==concurrent?concurrentAces:Aces(item.Value,sid));if(!same)ObserveRestoreMismatch(item.Key,target,scratch,control,sid,item.Value,appliedOriginals[item.Key],beforeRestore[item.Key],item.Key==concurrent?WithAces(item.Value,concurrentAces):item.Value,after);Need(same,"unrelated-ACEs-preserved");}
      var newGitAfter=Security(newGit);Need(Protected(newGitAfter)==Protected(newGitBefore)&&Label(newGitAfter)==Label(newGitBefore),"new-git-metadata-untouched");
      foreach(var root in new[]{target,scratch,Path.GetDirectoryName(executable)})foreach(var file in Paths(root))Need(!Security(file).DiscretionaryAcl.Cast<GenericAce>().OfType<QualifiedAce>().Any(x=>x.SecurityIdentifier.Value==sid),"package-grants-removed");
      var stable=originals.Keys.ToDictionary(x=>x,Security);WindowsAppContainerResourcesNative.Restore(plan);foreach(var item in stable){var after=Security(item.Key);Need(Protected(after)==Protected(item.Value)&&after.Owner.Value==item.Value.Owner.Value&&Label(after)==Label(item.Value)&&Aces(after,sid).SequenceEqual(Aces(item.Value,sid)),"repeated-restore-stable");}
      // A foreign protection change after completion is never ours to undo.
      Protect(git,true);Refuses("WINDOWS_ACL_PROTECTION_CHANGED",()=>WindowsAppContainerResourcesNative.Restore(plan));Need(Protected(Security(git)),"foreign-protection-retained");var gitInfo=new DirectoryInfo(git);var gitAcl=gitInfo.GetAccessControl();gitAcl.SetAccessRuleProtection(false,true);gitInfo.SetAccessControl(gitAcl);WindowsAppContainerResourcesNative.Restore(plan);
      Phase="partial-recovery";PartialRecovery(Path.GetDirectoryName(target));
      Phase="owned-ACE-drift";OwnedAceDrift(Path.GetDirectoryName(target));
      Console.Write(serializer.Serialize(new{schema=1,nativeWindows=true,architecture=NativeArchitecture(),appContainer=true,drained=true,denials=DenialNames,positiveOperations=8,originalObjects=originals.Count,restoredProtection=true,partialApplyRestored=true,foreignProtectionRefused=true,unrelatedAcePreserved=true,newGitLabelPreserved=true,packageGrantsRemoved=true,ownedAceDriftRefused=true,repeatedRestoreStable=true,gitOwner=originals[git].Owner.Value,gitLabelBefore=Label(originals[git]),gitLabelApplied=Label(applied[git]),accepted=false}));return 0;
    }finally{if(package!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(package);if(prepared&&!restored&&drained){WindowsAppContainerResourcesNative.Restore(plan);}else if(prepared&&!restored)Console.Error.WriteLine("retained-native-resource-plan-after-unconfirmed-drain");}
  }
  public static int Main(string[] args){try{NativeArchitecture();if(args.Length==4&&args[0]=="child")return Child(args[1],args[2],args[3]);Need(args.Length==4,"controller-arguments");return Controller(args[0],args[1],args[2],args[3]);}catch(Exception error){Console.Error.WriteLine("GIT_ACL_NATIVE_FAILURE:"+new JavaScriptSerializer().Serialize(FailureDetails(error)));Console.Error.WriteLine(error);return 1;}}
}
