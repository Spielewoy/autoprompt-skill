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
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Boolean QueryFullProcessImageName(IntPtr process,UInt32 flags,StringBuilder value,ref UInt32 length);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean OpenProcessToken(IntPtr process,UInt32 access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean GetTokenInformation(IntPtr token,Int32 kind,IntPtr value,Int32 length,out Int32 returned);
 static void Need(Boolean value,String name){if(!value)throw new InvalidOperationException(name);}
 static String Hash(String file){using(var stream=File.OpenRead(file))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
 static void CheckToken(String expectedSid){IntPtr token=IntPtr.Zero,value=IntPtr.Zero;try{Need(OpenProcessToken(new IntPtr(-1),8,out token),"token-open");value=Marshal.AllocHGlobal(256);Int32 returned;Need(GetTokenInformation(token,29,value,256,out returned)&&returned==4&&Marshal.ReadInt32(value)==1,"actual-AppContainer-token");Need(GetTokenInformation(token,31,value,256,out returned),"package-query");Need(new SecurityIdentifier(Marshal.ReadIntPtr(value)).Value==expectedSid,"actual-package-SID");}finally{if(value!=IntPtr.Zero)Marshal.FreeHGlobal(value);if(token!=IntPtr.Zero)CloseHandle(token);}}
 static MethodInfo Reconciliation(){var method=typeof(WindowsAppContainerNative).GetMethod("ReconcileMemberImageFailure",BindingFlags.NonPublic|BindingFlags.Static);Need(method!=null,"exact-production-reconciliation");return method;}
 delegate void ReconcileDelegate(IntPtr process,Int32 error,Stopwatch clock,Int32 deadline,ref Int32 budget);
 static Exception Invoke(IntPtr process,Int32 error,Stopwatch clock,Int32 deadline,ref Int32 budget){var invoke=(ReconcileDelegate)Delegate.CreateDelegate(typeof(ReconcileDelegate),Reconciliation());try{invoke(process,error,clock,deadline,ref budget);return null;}catch(Exception failure){return failure;}}

 static void LiveAndTerminated(String executable){
  using(var child=new Process()){child.StartInfo=new ProcessStartInfo(executable,"hold"){UseShellExecute=false,CreateNoWindow=true};Need(child.Start(),"start-held-child");IntPtr handle=IntPtr.Zero;
   try{handle=OpenProcess(0x100000,false,child.Id);Need(handle!=IntPtr.Zero,"synchronize-only-handle");Need(WaitForSingleObject(handle,0)==258,"child-live");var image=new StringBuilder(32768);UInt32 length=(UInt32)image.Capacity;Need(!QueryFullProcessImageName(handle,0,image,ref length),"real-image-denial");Int32 error=Marshal.GetLastWin32Error();Need(error==5,"real-image-denial-code");
    Int32 budget=25;var failure=Invoke(handle,error,Stopwatch.StartNew(),5000,ref budget) as Win32Exception;Need(failure!=null&&failure.NativeErrorCode==5&&failure.Message.Contains("wait:258.0:258.0 grace:25.")&&failure.Message.Length<=80,"live-denial-must-refuse");Need(budget==0,"shared-grace-charged");Need(WaitForSingleObject(handle,0)==258,"refused-child-still-live");
    // Terminate the same owned object, retain its original HANDLE, and require
    // positive signaling. PID reuse and a second OpenProcess cannot fake exit.
    child.Kill();Need(WaitForSingleObject(handle,5000)==0,"owned-child-confirmed-exit");budget=25;Need(Invoke(handle,5,Stopwatch.StartNew(),5000,ref budget)==null&&budget==25,"confirmed-exit-without-grace");budget=25;failure=Invoke(handle,87,Stopwatch.StartNew(),5000,ref budget) as Win32Exception;Need(failure!=null&&failure.NativeErrorCode==87&&budget==25,"non-image-denial-never-reconciles");
   }finally{if(!child.HasExited){child.Kill();Need(child.WaitForExit(5000),"held-child-cleanup");}if(handle!=IntPtr.Zero)CloseHandle(handle);}
  }
 }
 static void GrantFixture(String directory,String executable,String package){var user=WindowsIdentity.GetCurrent().User;var file=new FileSecurity();file.SetOwner(user);file.SetAccessRuleProtection(true,false);var dir=new DirectorySecurity();dir.SetOwner(user);dir.SetAccessRuleProtection(true,false);foreach(String sid in new[]{user.Value,"S-1-5-18",package}){var identity=new SecurityIdentifier(sid);var rights=sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl;file.AddAccessRule(new FileSystemAccessRule(identity,rights,AccessControlType.Allow));dir.AddAccessRule(new FileSystemAccessRule(identity,rights,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));}new FileInfo(executable).SetAccessControl(file);new DirectoryInfo(directory).SetAccessControl(dir);}
 static String[] EnvironmentEntries(){String root=Environment.GetEnvironmentVariable("SystemRoot"),local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);Need(!String.IsNullOrEmpty(root)&&!String.IsNullOrEmpty(local)&&Directory.Exists(local),"known-Windows-folders");return new[]{"SystemRoot="+root,"WINDIR="+root,"SystemDrive="+root.Substring(0,2),"PATH="+Path.Combine(root,"System32"),"LOCALAPPDATA="+local};}
 static Int32 Churn(String executable,String package){CheckToken(package);var children=new List<Process>();try{for(Int32 i=0;i<12;i++){var child=new Process{StartInfo=new ProcessStartInfo(executable,"leaf "+package){UseShellExecute=false,CreateNoWindow=true}};Need(child.Start(),"start-AppContainer-descendant");children.Add(child);Thread.Sleep(10);}foreach(var child in children){Need(child.WaitForExit(5000),"descendant-exit");Need(child.ExitCode==0,"descendant-token-proof");}Console.Write("{\"appContainer\":true,\"children\":12}");return 0;}finally{foreach(var child in children){if(!child.HasExited){child.Kill();Need(child.WaitForExit(5000),"descendant-cleanup");}child.Dispose();}}}
 public static Int32 Main(String[] args){try{
  if(args.Length==1&&args[0]=="hold"){Thread.Sleep(30000);return 0;}
  if(args.Length==2&&args[0]=="leaf"){CheckToken(args[1]);Thread.Sleep(250);return 0;}
  if(args.Length==2&&args[0]=="churn")return Churn(Assembly.GetExecutingAssembly().Location,args[1]);
  Need(args.Length==1,"controller-arguments");String executable=Path.GetFullPath(args[0]);LiveAndTerminated(executable);String profileName="Autoprompt_"+Guid.NewGuid().ToString("N");IntPtr profile=IntPtr.Zero;Boolean created=false;
  try{Need(WindowsAppContainerNative.CreateAppContainerProfile(profileName,profileName,profileName,IntPtr.Zero,0,out profile)>=0,"create-owned-profile");created=true;String package=new SecurityIdentifier(profile).Value;GrantFixture(Path.GetDirectoryName(executable),executable,package);var environment=EnvironmentEntries();Environment.SetEnvironmentVariable("LOCALAPPDATA",null,EnvironmentVariableTarget.Process);
   var result=WindowsAppContainerNative.Launch(executable,Hash(executable),new[]{"churn",package},Path.GetDirectoryName(executable),environment,15000,16384,profile,package,Path.Combine(Path.GetDirectoryName(executable),"never-cancelled"));
   String output=Encoding.UTF8.GetString(Convert.FromBase64String(result.StdoutBase64)),errors=Encoding.UTF8.GetString(Convert.FromBase64String(result.StderrBase64));Need(result.Drained&&!result.TimedOut&&!result.Cancelled&&!result.OutputLimit&&result.RootImageMatches&&result.AppContainerSid==package,"owned-launch-evidence");Need(result.ExitCode==0&&errors.Length==0,"child-result:"+result.ExitCode+":"+errors);Need(result.ObservedJobMembers>=2,"actual-descendants-observed");Need(output=="{\"appContainer\":true,\"children\":12}","descendant-output");Console.Write("{\"liveDenied\":true,\"terminatedReconciled\":true,\"nonAccessDeniedRefused\":true,\"children\":12,\"observedJobMembers\":"+result.ObservedJobMembers+",\"drained\":true}");
  }finally{if(profile!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(profile);if(created)Need(WindowsAppContainerNative.DeleteAppContainerProfile(profileName)==0,"delete-owned-profile");}return 0;
 }catch(Exception error){Console.Error.WriteLine(error);for(Exception current=error;current!=null;current=current.InnerException){var native=current as Win32Exception;if(native!=null)Console.Error.WriteLine("native-error="+native.NativeErrorCode);}return 1;}}
}
