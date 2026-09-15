// Observational Windows fixture: it does not certify Git Bash compatibility.
// Keep the signal-pipe flags aligned with MSYS fhandler_pipe::create.
using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

public static class MsysPipeProof {
 [StructLayout(LayoutKind.Sequential)] struct SA { public Int32 Length; public IntPtr Descriptor; public Int32 Inherit; }
 [StructLayout(LayoutKind.Sequential)] struct US { public UInt16 Length,MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct OA { public Int32 Length; public IntPtr RootDirectory,ObjectName; public UInt32 Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public IntPtr Status,Information; }
 [DllImport("ntdll.dll")] static extern Int32 NtOpenFile(out IntPtr handle,UInt32 access,ref OA attributes,out IO io,UInt32 share,UInt32 options);
 [DllImport("ntdll.dll")] static extern Int32 NtCreateNamedPipeFile(out IntPtr handle,UInt32 access,ref OA attributes,out IO io,UInt32 share,UInt32 disposition,UInt32 options,UInt32 type,UInt32 readMode,UInt32 completionMode,UInt32 instances,UInt32 inbound,UInt32 outbound,ref Int64 timeout);
 [DllImport("ntdll.dll")] static extern UInt32 RtlNtStatusToDosError(Int32 status);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateNamedPipeW(String name,UInt32 openMode,UInt32 pipeMode,UInt32 instances,UInt32 outSize,UInt32 inSize,UInt32 timeout,ref SA attributes);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(String name,UInt32 access,UInt32 share,ref SA attributes,UInt32 disposition,UInt32 flags,IntPtr template);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Boolean ConvertStringSecurityDescriptorToSecurityDescriptor(String text,UInt32 revision,out IntPtr descriptor,out UInt32 size);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean OpenProcessToken(IntPtr process,UInt32 access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean GetTokenInformation(IntPtr token,Int32 information,out Int32 value,UInt32 length,out UInt32 returned);
 [DllImport("kernel32.dll")] static extern Boolean CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 static readonly IntPtr Invalid = new IntPtr(-1);
 static void Require(Boolean condition,String reason){if(!condition)throw new InvalidOperationException(reason);}
 static Boolean Valid(IntPtr handle){return handle!=IntPtr.Zero&&handle!=Invalid;}
 sealed class Attributes : IDisposable {
  IntPtr text,name;public OA Value;
  public Attributes(String value,IntPtr root,IntPtr descriptor){text=Marshal.StringToHGlobalUni(value);var unicode=new US{Length=checked((UInt16)(value.Length*2)),MaximumLength=checked((UInt16)(value.Length*2+2)),Buffer=text};name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));Marshal.StructureToPtr(unicode,name,false);Value=new OA{Length=Marshal.SizeOf(typeof(OA)),RootDirectory=root,ObjectName=name,SecurityDescriptor=descriptor};}
  public void Dispose(){Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(text);}
 }
 static String NtStatus(Int32? status){return status.HasValue?"{\"status\":\""+unchecked((UInt32)status.Value).ToString("X8")+"\",\"win32Error\":"+RtlNtStatusToDosError(status.Value)+"}":"null";}
 static String ProbeNt(String user,String package,Boolean controller){
  var output=new StringBuilder("[");Int32 count=0;
  foreach(Boolean local in new[]{false,true}){
   IntPtr root=IntPtr.Zero,server=IntPtr.Zero,client=IntPtr.Zero,descriptor=IntPtr.Zero;Int32 rootStatus;Int32? serverStatus=null,clientStatus=null;
   try{IO io;using(var attributes=new Attributes(@"\Device\NamedPipe\"+(local?@"LOCAL\":""),IntPtr.Zero,IntPtr.Zero))rootStatus=NtOpenFile(out root,0x100080,ref attributes.Value,out io,3,0);
    if(rootStatus>=0){Require(Valid(root),"NT-root-empty");UInt32 size;Require(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;"+user+")(A;;GA;;;SY)(A;;GA;;;"+package+")",1,out descriptor,out size),"NT-pipe-descriptor");using(var attributes=new Attributes("autoprompt-msys-proof-"+Guid.NewGuid().ToString("N"),root,descriptor)){
     // MSYS ordinary-pipe path: relative name under its held NPFS root,
     // FILE_CREATE, synchronous inbound server; never retry ACCESS_DENIED.
     Int64 timeout=-500000;serverStatus=NtCreateNamedPipeFile(out server,0x80100100,ref attributes.Value,out io,3,2,0x20,1,0,0,1,8192,8192,ref timeout);
     if(serverStatus.Value>=0){Require(Valid(server),"NT-server-empty");clientStatus=NtOpenFile(out client,0x40100080,ref attributes.Value,out io,0,0);if(clientStatus.Value>=0)Require(Valid(client),"NT-client-empty");}
    }}
    if(controller&&!local)Require(rootStatus>=0&&serverStatus.HasValue&&serverStatus.Value>=0&&clientStatus.HasValue&&clientStatus.Value>=0,"controller-NT-control:"+NtStatus(rootStatus)+":"+NtStatus(serverStatus)+":"+NtStatus(clientStatus));
    if(count++>0)output.Append(',');output.Append("{\"namespace\":\"").Append(local?"local":"bare").Append("\",\"root\":").Append(NtStatus(rootStatus)).Append(",\"server\":").Append(NtStatus(serverStatus)).Append(",\"client\":").Append(NtStatus(clientStatus)).Append('}');
   }finally{if(Valid(client))Require(CloseHandle(client),"close-NT-client");if(Valid(server))Require(CloseHandle(server),"close-NT-server");if(Valid(root))Require(CloseHandle(root),"close-NT-root");if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
  }return output.Append(']').ToString();
 }
 static Boolean IsAppContainer(){IntPtr token;Require(OpenProcessToken(new IntPtr(-1),8,out token),"open-token:"+Marshal.GetLastWin32Error());try{Int32 value;UInt32 returned;Require(GetTokenInformation(token,29,out value,4,out returned)&&returned==4,"query-token:"+Marshal.GetLastWin32Error());Require(value==0||value==1,"invalid-token-value");return value==1;}finally{CloseHandle(token);}}
 static String Hash(String file){using(var stream=File.OpenRead(file))using(var hash=SHA256.Create())return String.Concat(hash.ComputeHash(stream).Select(b=>b.ToString("x2")));}
 static String Probe(String user,String package,Boolean requireSuccess){
  var output=new StringBuilder("[");Int32 count=0;
  foreach(Boolean local in new[]{false,true})foreach(String variant in new[]{"world","user","package"}){
   // The user cell models sec_user_nih: current/saved user (identical in
   // this fixture), Administrators and SYSTEM, with no protected-DACL bit.
   // The package cell grants only that user, SYSTEM and this exact profile.
   String sddl=variant=="world"?"D:(A;;GA;;;WD)":"D:(A;;GA;;;"+user+")(A;;GA;;;SY)"+(variant=="package"?"(A;;GA;;;"+package+")":"(A;;GA;;;BA)");
   IntPtr descriptor=IntPtr.Zero,server=IntPtr.Zero,client=IntPtr.Zero;Int32 serverError=0;Int32? clientError=null;
   try{UInt32 size;Require(ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out descriptor,out size),"pipe-descriptor:"+Marshal.GetLastWin32Error());var attributes=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=descriptor,Inherit=0};
    String name=@"\\.\pipe\"+(local?@"LOCAL\":"")+"autoprompt-msys-proof-"+Guid.NewGuid().ToString("N");
    // PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE; message pipe,
    // byte read mode, remote clients rejected, one instance, no retry.
    server=CreateNamedPipeW(name,0x80001,0x0c,1,8192,8192,0,ref attributes);
    if(!Valid(server))serverError=Marshal.GetLastWin32Error();
    else{
     // MSYS opens its write end with GENERIC_WRITE | FILE_READ_ATTRIBUTES.
     // Opening the sole owned listener does not wait for another process.
     client=CreateFileW(name,0x40000080,0,ref attributes,3,0,IntPtr.Zero);
     clientError=Valid(client)?0:Marshal.GetLastWin32Error();
    }
    Require(Valid(server)||serverError!=0,"server-failure-without-error");
    Require(!clientError.HasValue||Valid(client)||clientError.Value!=0,"client-failure-without-error");
    if(requireSuccess)Require(Valid(server)&&Valid(client),"controller-pipe-control:"+(local?"local":"bare")+":"+variant+":"+serverError+":"+clientError);
    if(count++>0)output.Append(',');output.Append("{\"namespace\":\"").Append(local?"local":"bare").Append("\",\"descriptor\":\"").Append(variant).Append("\",\"serverError\":").Append(serverError).Append(",\"clientError\":").Append(clientError.HasValue?clientError.Value.ToString(System.Globalization.CultureInfo.InvariantCulture):"null").Append('}');
   }finally{if(Valid(client))Require(CloseHandle(client),"close-client");if(Valid(server))Require(CloseHandle(server),"close-server");if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
  }return output.Append(']').ToString();
 }
 // Protect the child file before removing directory inheritance, preserving
 // its current owner rights throughout the fixture-only ACL transition.
 static void GrantFixture(String directory,String executable,String package){var user=WindowsIdentity.GetCurrent().User;var ds=new DirectorySecurity();ds.SetOwner(user);ds.SetAccessRuleProtection(true,false);foreach(String sid in new[]{user.Value,"S-1-5-18",package})ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));var fs=new FileSecurity();fs.SetOwner(user);fs.SetAccessRuleProtection(true,false);foreach(String sid in new[]{user.Value,"S-1-5-18",package})fs.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,AccessControlType.Allow));new FileInfo(executable).SetAccessControl(fs);new DirectoryInfo(directory).SetAccessControl(ds);}
 // Use the same bounded Windows essentials as the production launcher.
 // CLR process creation can consult the controller environment as well.
 static String[] FixtureEnvironment(){String root=Environment.GetEnvironmentVariable("SystemRoot");Require(!String.IsNullOrEmpty(root)&&root.Length>=3&&root.Length<=32700&&root[1]==':'&&root[2]=='\\',"fixture-system-root");return new[]{"SystemRoot="+root,"WINDIR="+root,"SystemDrive="+root.Substring(0,2),"PATH="+Path.Combine(root,"System32")};}
 static void ReportFailure(Exception error){Console.Error.WriteLine(error);Int32 depth=0;for(Exception current=error;current!=null&&depth<8;current=current.InnerException,depth++){var native=current as System.ComponentModel.Win32Exception;if(native!=null)Console.Error.WriteLine("fixture-native-error depth="+depth+" code="+native.NativeErrorCode+" message="+new System.ComponentModel.Win32Exception(native.NativeErrorCode).Message);}}
 public static Int32 Main(String[] args){try{
  if(args.Length==3&&args[0]=="child"){Require(IsAppContainer(),"child-is-not-AppContainer");Require(WindowsIdentity.GetCurrent().User.Value==args[1],"child-user-mismatch");Console.Write("{\"appContainer\":true,\"cases\":"+Probe(args[1],args[2],false)+",\"ntRoots\":"+ProbeNt(args[1],args[2],false)+"}");return 0;}
  Require(args.Length==1,"controller-arguments");Require(!IsAppContainer(),"controller-token");String executable=Path.GetFullPath(args[0]),profileName="Autoprompt_"+Guid.NewGuid().ToString("N");IntPtr profile=IntPtr.Zero;Boolean created=false;
  try{Int32 status=WindowsAppContainerNative.CreateAppContainerProfile(profileName,profileName,profileName,IntPtr.Zero,0,out profile);Require(status>=0,"create-profile:"+unchecked((UInt32)status).ToString("X8"));created=true;String package=new SecurityIdentifier(profile).Value,user=WindowsIdentity.GetCurrent().User.Value;GrantFixture(Path.GetDirectoryName(executable),executable,package);String controls=Probe(user,package,true),ntControls=ProbeNt(user,package,true);
   var result=WindowsAppContainerNative.Launch(executable,Hash(executable),new[]{"child",user,package},Path.GetDirectoryName(executable),FixtureEnvironment(),15000,16384,profile,package,Path.Combine(Path.GetDirectoryName(executable),"never-created-cancellation"));
   Require(result.Drained&&!result.TimedOut&&!result.OutputLimit&&!result.Cancelled&&result.RootImageMatches&&result.AppContainerSid==package,"child-launch-evidence");String output=Encoding.UTF8.GetString(Convert.FromBase64String(result.StdoutBase64)),errors=Encoding.UTF8.GetString(Convert.FromBase64String(result.StderrBase64));Require(result.ExitCode==0&&errors.Length==0,"child-result:"+result.ExitCode+":"+output+":"+errors);Console.Write("{\"controller\":"+controls+",\"ntController\":"+ntControls+",\"child\":"+output+"}");
  }finally{if(profile!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(profile);if(created)Require(WindowsAppContainerNative.DeleteAppContainerProfile(profileName)==0,"delete-profile");}return 0;
 }catch(Exception error){ReportFailure(error);return 1;}}
}
