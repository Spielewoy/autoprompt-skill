using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Collections.Generic;

public static class MemberImageProof {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(UInt32 access,Boolean inherit,Int32 pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UInt32 WaitForSingleObject(IntPtr handle,UInt32 timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,String name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Boolean QueryFullProcessImageName(IntPtr process,UInt32 flags,StringBuilder value,ref UInt32 length);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean OpenProcessToken(IntPtr process,UInt32 access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean GetTokenInformation(IntPtr token,Int32 kind,IntPtr value,Int32 length,out Int32 returned);
 static void Need(Boolean value,String name){if(!value)throw new InvalidOperationException(name);}
 static String Hash(String file){using(var stream=File.OpenRead(file))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
 static void CheckToken(String expectedSid){IntPtr token=IntPtr.Zero,value=IntPtr.Zero;try{Need(OpenProcessToken(new IntPtr(-1),8,out token),"token-open");value=Marshal.AllocHGlobal(256);Int32 returned;Need(GetTokenInformation(token,29,value,256,out returned)&&returned==4&&Marshal.ReadInt32(value)==1,"actual-AppContainer-token");Need(GetTokenInformation(token,31,value,256,out returned),"package-query");Need(new SecurityIdentifier(Marshal.ReadIntPtr(value)).Value==expectedSid,"actual-package-SID");}finally{if(value!=IntPtr.Zero)Marshal.FreeHGlobal(value);if(token!=IntPtr.Zero)CloseHandle(token);}}
 static Object Call(String name,params Object[] args){try{return typeof(WindowsAppContainerNative).GetMethod(name,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args);}catch(TargetInvocationException error){throw error.InnerException;}}
 static Object Binding(String executable,String digest){try{return Activator.CreateInstance(typeof(WindowsAppContainerNative).GetNestedType("ImageBinding",BindingFlags.NonPublic),new Object[]{executable,digest});}catch(TargetInvocationException error){throw error.InnerException;}}
 static void Refuses(String reason,Action action){try{action();}catch(InvalidOperationException error){Need(error.Message==reason,"exact-refusal:"+reason);return;}throw new InvalidOperationException("expected-refusal:"+reason);}
 static void RootBinding(String executable){
  using(var child=new Process()){child.StartInfo=new ProcessStartInfo(executable,"hold"){UseShellExecute=false,CreateNoWindow=true};Need(child.Start(),"start-held-child");IntPtr denied=IntPtr.Zero,query=IntPtr.Zero;Object bound=null,other=null;
   try{
    denied=OpenProcess(0x100000,false,child.Id);query=OpenProcess(0x101000,false,child.Id);Need(denied!=IntPtr.Zero&&query!=IntPtr.Zero,"owned-process-handles");Need(WaitForSingleObject(query,0)==258,"child-live");
    bound=Binding(executable,Hash(executable));
    try{Call("VerifyRootImage",denied,bound);throw new InvalidOperationException("unreadable-root-accepted");}catch(Win32Exception error){Need(error.NativeErrorCode==5,"actual-root-image-query-denial");}
    Need(WaitForSingleObject(query,0)==258,"query-denied-child-still-live");Call("VerifyRootImage",query,bound);Need(WindowsAppContainerNative.LastRootImageMatches==1,"actual-root-image-match");
    String controller=Assembly.GetExecutingAssembly().Location;Need(controller!=executable,"different-root-path");other=Binding(controller,Hash(controller));Refuses("APP_PROBE_ROOT_IMAGE_MISMATCH",()=>Call("VerifyRootImage",query,other));
    Refuses("image hash mismatch",()=>Binding(executable,new String('0',64)));
    Refuses("APP_PROBE_MEMBER_TOKEN_NOT_APPCONTAINER",()=>Call("VerifyAppContainerTokenAndJob",query,"S-1-15-2-1-2-3-4-5-6-7",IntPtr.Zero,false));
   }finally{if(!child.HasExited){child.Kill();Need(child.WaitForExit(5000),"held-child-cleanup");}if(denied!=IntPtr.Zero)CloseHandle(denied);if(query!=IntPtr.Zero)CloseHandle(query);if(other!=null)((IDisposable)other).Dispose();if(bound!=null)((IDisposable)bound).Dispose();}
  }
 }
 static void NegativeAuthority(String package){
  Refuses("APP_PROBE_MEMBER_SID_MISMATCH",()=>Call("VerifyAppContainerTokenAndJob",new IntPtr(-1),"S-1-15-2-1-2-3-4-5-6-7",IntPtr.Zero,false));
  IntPtr emptyJob=CreateJobObject(IntPtr.Zero,null);Need(emptyJob!=IntPtr.Zero,"create-distinct-empty-job");
  try{Refuses("APP_PROBE_MEMBER_JOB_MISMATCH",()=>Call("VerifyAppContainerTokenAndJob",new IntPtr(-1),package,emptyJob,false));}finally{Need(CloseHandle(emptyJob),"close-distinct-empty-job");}
 }
 static void GrantFixture(String directory,String executable,String package){var user=WindowsIdentity.GetCurrent().User;var file=new FileSecurity();file.SetOwner(user);file.SetAccessRuleProtection(true,false);var dir=new DirectorySecurity();dir.SetOwner(user);dir.SetAccessRuleProtection(true,false);foreach(String sid in new[]{user.Value,"S-1-5-18",package}){var identity=new SecurityIdentifier(sid);var rights=sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl;file.AddAccessRule(new FileSystemAccessRule(identity,rights,AccessControlType.Allow));dir.AddAccessRule(new FileSystemAccessRule(identity,rights,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));}new FileInfo(executable).SetAccessControl(file);new DirectoryInfo(directory).SetAccessControl(dir);}
 static String[] EnvironmentEntries(){String root=Environment.GetEnvironmentVariable("SystemRoot"),local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);Need(!String.IsNullOrEmpty(root)&&!String.IsNullOrEmpty(local)&&Directory.Exists(local),"known-Windows-folders");return new[]{"SystemRoot="+root,"WINDIR="+root,"SystemDrive="+root.Substring(0,2),"PATH="+Path.Combine(root,"System32"),"LOCALAPPDATA="+local};}
 static Int32 Churn(String executable,String package){CheckToken(package);NegativeAuthority(package);var children=new List<Process>();try{for(Int32 i=0;i<12;i++){var child=new Process{StartInfo=new ProcessStartInfo(executable,"leaf "+package){UseShellExecute=false,CreateNoWindow=true}};Need(child.Start(),"start-AppContainer-descendant");children.Add(child);Thread.Sleep(10);}foreach(var child in children){Need(child.WaitForExit(5000),"descendant-exit");Need(child.ExitCode==0,"descendant-token-proof");}Console.Write("{\"appContainer\":true,\"children\":12,\"wrongSidDenied\":true,\"wrongJobDenied\":true}");return 0;}finally{foreach(var child in children){if(!child.HasExited){child.Kill();Need(child.WaitForExit(5000),"descendant-cleanup");}child.Dispose();}}}
 public static Int32 Main(String[] args){try{
  if(args.Length==1&&args[0]=="hold"){Thread.Sleep(30000);return 0;}
  if(args.Length==2&&args[0]=="leaf"){CheckToken(args[1]);Thread.Sleep(250);return 0;}
  if(args.Length==2&&args[0]=="churn")return Churn(Assembly.GetExecutingAssembly().Location,args[1]);
  Need(args.Length==1,"controller-arguments");String executable=Path.GetFullPath(args[0]);RootBinding(executable);String profileName="Autoprompt_"+Guid.NewGuid().ToString("N");IntPtr profile=IntPtr.Zero;Boolean created=false,safeToDelete=true;
  try{Need(WindowsAppContainerNative.CreateAppContainerProfile(profileName,profileName,profileName,IntPtr.Zero,0,out profile)>=0,"create-owned-profile");created=true;String package=new SecurityIdentifier(profile).Value;GrantFixture(Path.GetDirectoryName(executable),executable,package);var environment=EnvironmentEntries();Environment.SetEnvironmentVariable("LOCALAPPDATA",null,EnvironmentVariableTarget.Process);
   safeToDelete=false;
   var result=WindowsAppContainerNative.Launch(executable,Hash(executable),new[]{"churn",package},Path.GetDirectoryName(executable),environment,15000,16384,profile,package,Path.Combine(Path.GetDirectoryName(executable),"never-cancelled"));
   safeToDelete=result.Drained;
   String output=Encoding.UTF8.GetString(Convert.FromBase64String(result.StdoutBase64)),errors=Encoding.UTF8.GetString(Convert.FromBase64String(result.StderrBase64));Need(result.Drained&&!result.TimedOut&&!result.Cancelled&&!result.OutputLimit&&result.RootImageMatches&&result.AppContainerSid==package,"owned-launch-evidence");Need(result.ExitCode==0&&errors.Length==0,"child-result:"+result.ExitCode+":"+errors);Need(result.ObservedJobMembers>=2,"actual-descendants-observed");Need(output=="{\"appContainer\":true,\"children\":12,\"wrongSidDenied\":true,\"wrongJobDenied\":true}","descendant-output");Console.Write("{\"rootImageMatched\":true,\"rootMismatchDenied\":true,\"rootUnreadableDenied\":true,\"rootHashDenied\":true,\"hostTokenDenied\":true,\"wrongSidDenied\":true,\"wrongJobDenied\":true,\"children\":12,\"observedJobMembers\":"+result.ObservedJobMembers+",\"drained\":true}");
  }finally{if(profile!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(profile);if(created&&safeToDelete)Need(WindowsAppContainerNative.DeleteAppContainerProfile(profileName)==0,"delete-owned-profile");else if(created)Console.Error.WriteLine("retained-profile-after-unconfirmed-launch:"+profileName);}return 0;
 }catch(Exception error){Console.Error.WriteLine(error);for(Exception current=error;current!=null;current=current.InnerException){var native=current as Win32Exception;if(native!=null)Console.Error.WriteLine("native-error="+native.NativeErrorCode);}return 1;}}
}
