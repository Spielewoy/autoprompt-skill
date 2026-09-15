// Actual Windows-only evidence. This fixture never grants host tool directories.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

public static class MsysNamespaceProof {
 [StructLayout(LayoutKind.Sequential)] struct US { public UInt16 Length,MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct OA { public Int32 Length; public IntPtr RootDirectory,ObjectName; public UInt32 Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
 [DllImport("ntdll.dll")] static extern Int32 NtCreateEvent(out IntPtr handle,UInt32 access,ref OA attributes,Int32 eventType,Boolean initialState);
 [DllImport("ntdll.dll")] static extern Int32 NtCreateSection(out IntPtr handle,UInt32 access,ref OA attributes,ref Int64 size,UInt32 protection,UInt32 allocation,IntPtr file);
 [DllImport("ntdll.dll")] static extern Int32 NtOpenEvent(out IntPtr handle,UInt32 access,ref OA attributes);
 [DllImport("ntdll.dll")] static extern Int32 NtOpenSection(out IntPtr handle,UInt32 access,ref OA attributes);
 [DllImport("ntdll.dll")] static extern Int32 NtOpenDirectoryObject(out IntPtr handle,UInt32 access,ref OA attributes);
 [DllImport("ntdll.dll")] static extern Int32 NtSetEvent(IntPtr handle,IntPtr previous);
 [DllImport("ntdll.dll")] static extern Int32 NtMapViewOfSection(IntPtr section,IntPtr process,ref IntPtr address,UIntPtr zeroBits,UIntPtr commit,IntPtr offset,ref UIntPtr size,Int32 inherit,UInt32 allocation,UInt32 protection);
 [DllImport("ntdll.dll")] static extern Int32 NtUnmapViewOfSection(IntPtr process,IntPtr address);
 [DllImport("ntdll.dll")] static extern Int32 NtSetSecurityObject(IntPtr handle,UInt32 information,IntPtr descriptor);
 [DllImport("ntdll.dll")] static extern Int32 NtQuerySecurityObject(IntPtr handle,UInt32 information,IntPtr buffer,UInt32 length,out UInt32 needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Boolean ConvertStringSecurityDescriptorToSecurityDescriptor(String text,UInt32 revision,out IntPtr descriptor,out UInt32 size);
 [DllImport("kernel32.dll")] static extern Boolean CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 sealed class Attributes : IDisposable {
  IntPtr name,text; public OA Value;
  public Attributes(String value,IntPtr descriptor){text=Marshal.StringToHGlobalUni(value);var unicode=new US{Length=checked((UInt16)(value.Length*2)),MaximumLength=checked((UInt16)(value.Length*2+2)),Buffer=text};name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));Marshal.StructureToPtr(unicode,name,false);Value=new OA{Length=Marshal.SizeOf(typeof(OA)),ObjectName=name,SecurityDescriptor=descriptor};}
  public void Dispose(){Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(text);}
 }
 static void Require(Boolean value,String reason){if(!value)throw new InvalidOperationException(reason);}
 static void Success(Int32 status,String operation){Require(status>=0,operation+":"+unchecked((UInt32)status).ToString("X8"));}
 static RawSecurityDescriptor Security(IntPtr handle){UInt32 needed;NtQuerySecurityObject(handle,0x17,IntPtr.Zero,0,out needed);Require(needed>0&&needed<65536,"security-size");IntPtr buffer=Marshal.AllocHGlobal((Int32)needed);try{Success(NtQuerySecurityObject(handle,0x17,buffer,needed,out needed),"query-security");Byte[] bytes=new Byte[needed];Marshal.Copy(buffer,bytes,0,bytes.Length);return new RawSecurityDescriptor(bytes,0);}finally{Marshal.FreeHGlobal(buffer);}}
 static Int32 OpenDirectory(String name,out IntPtr handle){using(var oa=new Attributes(name,IntPtr.Zero))return NtOpenDirectoryObject(out handle,1,ref oa.Value);}
 // MSYS creates these objects from a low-integrity child. The controller
 // holds fixture handles for two independent child launches, so reproduce
 // only that label here without changing each creation-DACL variant.
 static void SetLowLabel(IntPtr handle){IntPtr sd=IntPtr.Zero;try{UInt32 size;Require(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;;NW;;;LW)",1,out sd,out size),"low-leaf-descriptor");Success(NtSetSecurityObject(handle,0x10,sd),"set-low-leaf-label");}finally{if(sd!=IntPtr.Zero)LocalFree(sd);}}
 // Object Manager supplies effective package grants for a default descriptor,
 // without necessarily marking those ACEs Inherited. Explicit MSYS descriptors
 // remain explicit; they are tested as unsupported same-profile opens below.
 static void CheckLeafSecurity(IntPtr handle,String profile,String other,Int32 variant,Boolean section){
  var sd=Security(handle);Require(sd.SystemAcl!=null&&sd.SystemAcl.Count==1,"leaf-label-count");var label=sd.SystemAcl[0];Byte[] labelBytes=new Byte[label.BinaryLength];label.GetBinaryForm(labelBytes,0);Require(labelBytes[0]==0x11&&labelBytes[1]==0&&BitConverter.ToUInt32(labelBytes,4)==1&&new SecurityIdentifier(labelBytes,8).Value=="S-1-16-4096","leaf-low-label");
  Require((sd.ControlFlags&ControlFlags.DiscretionaryAclPresent)!=0&&(sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0,"leaf-DACL-control-flags");
  if(variant==1){Require(sd.DiscretionaryAcl==null,"NULL-fixture-DACL-changed");return;}
  Require(sd.DiscretionaryAcl!=null,"leaf-null-effective-DACL");
  String user=WindowsIdentity.GetCurrent().User.Value;
  var expected=new HashSet<String>(variant==0?new[]{"S-1-1-0"}:variant==2?new[]{user,"S-1-5-18",profile}:new[]{user,"S-1-5-32-544","S-1-5-18"},StringComparer.Ordinal);
  Require(sd.DiscretionaryAcl.Count==expected.Count,"leaf-DACL-ACE-count");
  foreach(GenericAce entry in sd.DiscretionaryAcl){
   var ace=entry as CommonAce;Require(ace!=null&&ace.AceQualifier==AceQualifier.AccessAllowed&&!ace.IsCallback,"leaf-DACL-ACE-type");
   String sid=ace.SecurityIdentifier.Value;Require(sid!=other&&sid!="S-1-15-2-1"&&sid!="S-1-15-2-2","foreign-profile-leaf-grant");
   Require(expected.Remove(sid),"unexpected-or-duplicate-leaf-grant");Require(ace.AccessMask==(section?0xf001f:0x1f0003),"leaf-effective-rights");
   // Default-descriptor provenance flags are not its access semantics. All
   // variants still require an effective ACE; explicit descriptors stay exact.
   Require(variant==2?(ace.AceFlags&~AceFlags.Inherited)==AceFlags.None:ace.AceFlags==AceFlags.None,"leaf-ACE-flags");
  }
  Require(expected.Count==0,"missing-effective-leaf-grant");
 }
 static void MapWitness(IntPtr section,Boolean initialize){IntPtr address=IntPtr.Zero;UIntPtr size=(UIntPtr)4096;Success(NtMapViewOfSection(section,new IntPtr(-1),ref address,UIntPtr.Zero,UIntPtr.Zero,IntPtr.Zero,ref size,2,0,4),"map-section");try{if(initialize)Marshal.WriteByte(address,0,90);else{Require(Marshal.ReadByte(address,0)==90,"section-witness");Marshal.WriteByte(address,1,91);}}finally{Success(NtUnmapViewOfSection(new IntPtr(-1),address),"unmap-section");}}
 static void Diagnostic(String kind,String detail){Require(detail.Length<=16384,"diagnostic-limit");Console.WriteLine("NAMESPACE_DIAGNOSTIC "+Convert.ToBase64String(Encoding.UTF8.GetBytes(kind+" "+detail)));}
 static Int32 LeafVariant(String name){String leaf=name.Substring(name.LastIndexOf('\\')+1);for(Int32 variant=0;variant<4;variant++)if(leaf=="proof-"+variant+"-event"||leaf=="proof-"+variant+"-section")return variant;throw new InvalidOperationException("unexpected-leaf-name");}
 static String ChildSummary(Boolean same,Int32 count){return same?"same:default-opens="+(count/4)+";unsupported-explicit-denied="+(count*3/4):"other:denied="+count;}
 static void Child(String[] args){
  Require(args.Length>=4&&(args.Length-2)%8==0&&(args[1]=="allow"||args[1]=="deny"),"child-arguments");
  Boolean same=args[1]=="allow";Int32 count=0,opened=0,denied=0;var failures=new List<String>();
  for(Int32 i=2;i<args.Length;i++){
   String name=args[i];Int32 variant=LeafVariant(name);Boolean shouldOpen=same&&variant==2;IntPtr handle=IntPtr.Zero;Int32 status;
   using(var oa=new Attributes(name,IntPtr.Zero)){status=name.EndsWith("event",StringComparison.Ordinal)?NtOpenEvent(out handle,0x100002,ref oa.Value):NtOpenSection(out handle,6,ref oa.Value);}
   try{
    Diagnostic("open",(same?"same":"other")+" index="+(i-2)+" variant="+variant+" status="+unchecked((UInt32)status).ToString("X8")+" handle="+(handle!=IntPtr.Zero));
    try{if(shouldOpen){Require(status==0,"default-same-profile-open:"+unchecked((UInt32)status).ToString("X8"));Require(handle!=IntPtr.Zero,"empty-leaf-handle");if(name.EndsWith("event",StringComparison.Ordinal))Success(NtSetEvent(handle,IntPtr.Zero),"set-event");else MapWitness(handle,false);opened++;}else{Require(status==unchecked((Int32)0xc0000022)&&handle==IntPtr.Zero,(same?"unsupported-explicit-not-denied:":"cross-profile-not-denied:")+unchecked((UInt32)status).ToString("X8"));denied++;}count++;}
    catch(InvalidOperationException error){failures.Add("index="+(i-2)+":"+error.Message);}
   }finally{if(handle!=IntPtr.Zero)CloseHandle(handle);}
  }
  Require(failures.Count==0,"leaf-open-failures:"+String.Join(";",failures));Require(opened==(same?count/4:0)&&denied==(same?count*3/4:count),"leaf-outcome-counts");Console.Write(ChildSummary(same,count));
 }
 static String Hash(String file){using(var stream=File.OpenRead(file))using(var hash=SHA256.Create())return String.Concat(hash.ComputeHash(stream).Select(b=>b.ToString("x2")));}
 static void GrantFixture(String directory,String executable,String sidA,String sidB){
  var user=WindowsIdentity.GetCurrent().User;
  // Protect the child file first. Removing directory inheritance first can
  // strip its inherited full-control grant before SetOwner is persisted.
  var fileSecurity=new FileSecurity();fileSecurity.SetOwner(user);fileSecurity.SetAccessRuleProtection(true,false);
  foreach(String sid in new[]{user.Value,"S-1-5-18",sidA,sidB})fileSecurity.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==sidA||sid==sidB?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,AccessControlType.Allow));
  try{new FileInfo(executable).SetAccessControl(fileSecurity);}catch(Exception error){throw new InvalidOperationException("fixture-child-image-grant",error);}
  var directorySecurity=new DirectorySecurity();directorySecurity.SetOwner(user);directorySecurity.SetAccessRuleProtection(true,false);
  foreach(String sid in new[]{user.Value,"S-1-5-18",sidA,sidB})directorySecurity.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==sidA||sid==sidB?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));
  try{new DirectoryInfo(directory).SetAccessControl(directorySecurity);}catch(Exception error){throw new InvalidOperationException("fixture-directory-grant",error);}
 }

 // Clear the controller prerequisite so the real launcher must restore it.
 // The child receives the production explicit environment, never ambient merge.
 static void RunChild(String executable,String profileSid,IntPtr profile,Boolean allowed,String[] names,String cwd){
  var arguments=new[]{"child",allowed?"allow":"deny"}.Concat(names).ToArray();Environment.SetEnvironmentVariable("LOCALAPPDATA",null,EnvironmentVariableTarget.Process);
  var result=WindowsAppContainerNative.Launch(executable,Hash(executable),arguments,cwd,FixtureEnvironment(),15000,8192,profile,profileSid,Path.Combine(cwd,"never-created-cancellation"));
  String output=Encoding.UTF8.GetString(Convert.FromBase64String(result.StdoutBase64)),errors=Encoding.UTF8.GetString(Convert.FromBase64String(result.StderrBase64));
  Diagnostic("child-"+(allowed?"same":"other"),"exit="+result.ExitCode+" stdout="+output+" stderr="+errors);
  Require(result.Drained&&!result.TimedOut&&!result.OutputLimit&&!result.Cancelled&&result.RootImageMatches&&result.AppContainerSid==profileSid,"child-launch-evidence");
  String[] lines=output.Split(new[]{"\r\n","\n"},StringSplitOptions.None);
  Require(lines.Length==names.Length+1&&lines.Take(names.Length).All(line=>line.StartsWith("NAMESPACE_DIAGNOSTIC ",StringComparison.Ordinal)),"child-observation-count");
  Require(result.ExitCode==0&&errors.Length==0&&lines[lines.Length-1]==ChildSummary(allowed,names.Length),"child-result:"+result.ExitCode+":"+errors);
 }
 // Use the same bounded Windows essentials as the production launcher.
 // LOCALAPPDATA is resolved through Windows and grants no filesystem access.
 static String[] FixtureEnvironment(){String root=Environment.GetEnvironmentVariable("SystemRoot");Require(!String.IsNullOrEmpty(root)&&root.Length>=3&&root.Length<=32700&&root[1]==':'&&root[2]=='\\',"fixture-system-root");String local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);Require(!String.IsNullOrEmpty(local)&&local.Length<=32700&&Path.IsPathRooted(local)&&String.Equals(Path.GetFullPath(local),local,StringComparison.OrdinalIgnoreCase)&&Directory.Exists(local),"fixture-local-application-data-unavailable");return new[]{"SystemRoot="+root,"WINDIR="+root,"SystemDrive="+root.Substring(0,2),"PATH="+Path.Combine(root,"System32"),"LOCALAPPDATA="+local};}
 static void ReportFailure(Exception error){Console.Error.WriteLine(error);Int32 depth=0;for(Exception current=error;current!=null&&depth<8;current=current.InnerException,depth++){var native=current as System.ComponentModel.Win32Exception;if(native!=null)Console.Error.WriteLine("fixture-native-error depth="+depth+" code="+native.NativeErrorCode+" message="+new System.ComponentModel.Win32Exception(native.NativeErrorCode).Message);}}
 public static Int32 Main(String[] args){try{if(args.Length>0&&args[0]=="child"){Child(args);return 0;}Controller(args);return 0;}catch(Exception error){ReportFailure(error);return 1;}}
 static void Controller(String[] args){Require(args.Length==5,"controller-arguments");String executable=args[0],bash=args[1];Require(!String.Equals(Path.GetFullPath(executable),System.Reflection.Assembly.GetExecutingAssembly().Location,StringComparison.OrdinalIgnoreCase),"controller-child-images-must-differ");Require(Hash(executable)==Hash(System.Reflection.Assembly.GetExecutingAssembly().Location),"child-fixture-bytes");var request=new WindowsAppContainerNative.MsysNamespaceRequest{DllPath=args[2],DllSha256=args[3],SharedId=args[4]};String nameA="Autoprompt_"+Guid.NewGuid().ToString("N"),nameB="Autoprompt_"+Guid.NewGuid().ToString("N");IntPtr appA=IntPtr.Zero,appB=IntPtr.Zero;Boolean createdA=false,createdB=false;var leaves=new List<IntPtr>();WindowsAppContainerNative.MsysNamespaceLease lease=null;
  try{Success(WindowsAppContainerNative.CreateAppContainerProfile(nameA,nameA,nameA,IntPtr.Zero,0,out appA),"profile-A");createdA=true;Success(WindowsAppContainerNative.CreateAppContainerProfile(nameB,nameB,nameB,IntPtr.Zero,0,out appB),"profile-B");createdB=true;String sidA=new SecurityIdentifier(appA).Value,sidB=new SecurityIdentifier(appB).Value;GrantFixture(Path.GetDirectoryName(executable),executable,sidA,sidB);lease=WindowsAppContainerNative.CreateMsysNamespaceLease(bash,request,sidA);String[] roots=(String[])lease.Names.Clone();Require(roots.Length==(System.Diagnostics.Process.GetCurrentProcess().SessionId==0?1:2),"namespace-count");Require(roots[0].StartsWith(@"\BaseNamedObjects\",StringComparison.Ordinal),"global-namespace");if(roots.Length==2)Require(roots[1].StartsWith(@"\Sessions\BNOLINKS\"+System.Diagnostics.Process.GetCurrentProcess().SessionId+@"\",StringComparison.Ordinal),"session-namespace");Boolean collision=false;try{using(var duplicate=WindowsAppContainerNative.CreateMsysNamespaceLease(bash,request,sidA)){} }catch(InvalidOperationException error){collision=error.Message=="WINDOWS_MSYS_NAMESPACE_COLLISION";}Require(collision,"namespace-collision-not-refused");var names=new List<String>();var failures=new List<String>();
   // Variant 3 models MSYS sec_user_nih: explicit user, Administrators, and
   // SYSTEM full access without a protected-DACL flag; no host object changes.
   foreach(String root in roots){IntPtr directory;Success(OpenDirectory(root,out directory),"held-directory");CloseHandle(directory);for(Int32 variant=0;variant<4;variant++){IntPtr sd=IntPtr.Zero;try{UInt32 ignored;if(variant==0)Require(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;WD)",1,out sd,out ignored),"WORLD-descriptor");if(variant==1)Require(ConvertStringSecurityDescriptorToSecurityDescriptor("D:NO_ACCESS_CONTROL",1,out sd,out ignored),"NULL-DACL-descriptor");if(variant==3)Require(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;"+WindowsIdentity.GetCurrent().User.Value+")(A;;GA;;;BA)(A;;GA;;;SY)",1,out sd,out ignored),"MSYS-user-descriptor");foreach(Boolean section in new[]{false,true}){String name=root+"\\proof-"+variant+(section?"-section":"-event");IntPtr leaf;using(var oa=new Attributes(name,sd)){if(section){Int64 size=4096;Success(NtCreateSection(out leaf,0xf001f,ref oa.Value,ref size,4,0x08000000,IntPtr.Zero),"create-section");}else Success(NtCreateEvent(out leaf,0x1f0003,ref oa.Value,0,false),"create-event");}leaves.Add(leaf);SetLowLabel(leaf);String actualSddl=Security(leaf).GetSddlForm(AccessControlSections.All);Require(actualSddl.Length<=4096,"leaf-SDDL-limit");Diagnostic("leaf","variant="+variant+" type="+(section?"section":"event")+" name="+name+" sddl="+actualSddl);try{CheckLeafSecurity(leaf,sidA,sidB,variant,section);}catch(InvalidOperationException error){failures.Add(name+":"+error.Message);}if(section)MapWitness(leaf,true);names.Add(name);}}finally{if(sd!=IntPtr.Zero)LocalFree(sd);}}}
   try{RunChild(executable,sidA,appA,true,names.ToArray(),Path.GetDirectoryName(executable));}catch(Exception error){ReportFailure(error);Diagnostic("same-profile-failure",error.ToString());failures.Add("same-profile:"+error.Message);}try{RunChild(executable,sidB,appB,false,names.ToArray(),Path.GetDirectoryName(executable));}catch(Exception error){ReportFailure(error);Diagnostic("other-profile-failure",error.ToString());failures.Add("other-profile:"+error.Message);}foreach(IntPtr leaf in leaves)Require(CloseHandle(leaf),"close-leaf");leaves.Clear();foreach(String root in roots){IntPtr held;Success(OpenDirectory(root,out held),"lease-still-held");CloseHandle(held);}lease.Dispose();lease=null;foreach(String root in roots){IntPtr gone;Int32 status=OpenDirectory(root,out gone);if(gone!=IntPtr.Zero)CloseHandle(gone);Require(status==unchecked((Int32)0xc0000034)||status==unchecked((Int32)0xc000003a),"namespace-name-survived-release");}using(var recreated=WindowsAppContainerNative.CreateMsysNamespaceLease(bash,request,sidA)){Require(recreated.Names.SequenceEqual(roots),"recreated-name-drift");}Require(failures.Count==0,"namespace-security-failures:"+String.Join(";",failures));Console.Write("{\"defaultSameProfileOpens\":"+(names.Count/4)+",\"unsupportedDescriptorSameProfileDenied\":"+(names.Count*3/4)+",\"wrongProfileDenied\":"+names.Count+",\"namespaceCount\":"+roots.Length+",\"collisionRefused\":true,\"released\":true}");
  }finally{foreach(IntPtr leaf in leaves)CloseHandle(leaf);if(lease!=null)lease.Dispose();if(appB!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(appB);if(appA!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(appA);if(createdB)Require(WindowsAppContainerNative.DeleteAppContainerProfile(nameB)==0,"delete-profile-B");if(createdA)Require(WindowsAppContainerNative.DeleteAppContainerProfile(nameA)==0,"delete-profile-A");}
 }
}
