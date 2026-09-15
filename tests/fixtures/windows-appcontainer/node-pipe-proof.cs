using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Collections.Generic;
public static class NodePipeProof {
 static void Need(Boolean value,String code){if(!value)throw new InvalidOperationException(code);}
 static String Hash(String file){using(var stream=File.OpenRead(file))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
 static void GrantFixture(String directory,String node,String worker,String package){var user=WindowsIdentity.GetCurrent().User;var dir=new DirectorySecurity();dir.SetOwner(user);dir.SetAccessRuleProtection(true,false);foreach(String sid in new[]{user.Value,"S-1-5-18",package})dir.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));foreach(String path in new[]{node,worker}){var file=new FileSecurity();file.SetOwner(user);file.SetAccessRuleProtection(true,false);foreach(String sid in new[]{user.Value,"S-1-5-18",package})file.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,AccessControlType.Allow));new FileInfo(path).SetAccessControl(file);}new DirectoryInfo(directory).SetAccessControl(dir);}
 static String[] EnvironmentEntries(){String root=Environment.GetEnvironmentVariable("SystemRoot"),local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);Need(!String.IsNullOrEmpty(root)&&!String.IsNullOrEmpty(local)&&Directory.Exists(local),"known-Windows-folders");return new[]{"SystemRoot="+root,"WINDIR="+root,"SystemDrive="+root.Substring(0,2),"PATH="+Path.Combine(root,"System32"),"LOCALAPPDATA="+local};}
 public static Int32 Main(String[] args){try{
  Need(args.Length==2,"controller-arguments");String node=Path.GetFullPath(args[0]),worker=Path.GetFullPath(args[1]),directory=Path.GetDirectoryName(node);Need(Path.GetDirectoryName(worker)==directory,"owned-runtime-directory");String nodeHash=Hash(node),workerHash=Hash(worker),profileName="Autoprompt_"+Guid.NewGuid().ToString("N");IntPtr profile=IntPtr.Zero;Boolean created=false,safeToDelete=true;
  try{Need(WindowsAppContainerNative.CreateAppContainerProfile(profileName,profileName,profileName,IntPtr.Zero,0,out profile)>=0,"create-owned-profile");created=true;String package=new SecurityIdentifier(profile).Value;GrantFixture(directory,node,worker,package);var environment=EnvironmentEntries();Environment.SetEnvironmentVariable("LOCALAPPDATA",null,EnvironmentVariableTarget.Process);
   foreach(String mode in new[]{"inherit","pipe","ipc","ignore"}){
    Need(Hash(node)==nodeHash&&Hash(worker)==workerHash,"worker-bytes-changed");
    safeToDelete=false;
    var result=WindowsAppContainerNative.Launch(node,nodeHash,new[]{"--preserve-symlinks","--preserve-symlinks-main",worker,mode},directory,environment,10000,16384,profile,package,Path.Combine(directory,"never-cancelled-"+mode));
    safeToDelete=result.Drained;
    Need(result.Drained&&result.RootImageMatches&&result.AppContainerSid==package&&!result.Cancelled&&!result.OutputLimit,"owned-launch-and-drain-required");
    Console.WriteLine("{\"mode\":\""+mode+"\",\"exitCode\":"+result.ExitCode+",\"timedOut\":"+(result.TimedOut?"true":"false")+",\"drained\":true,\"observedJobMembers\":"+result.ObservedJobMembers+",\"stdoutBase64\":\""+result.StdoutBase64+"\",\"stderrBase64\":\""+result.StderrBase64+"\"}");Console.Out.Flush();
   }
  }finally{if(profile!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(profile);if(created&&safeToDelete)Need(WindowsAppContainerNative.DeleteAppContainerProfile(profileName)==0,"delete-owned-profile");else if(created)Console.Error.WriteLine("retained-profile-after-unconfirmed-launch:"+profileName);}return 0;
 }catch(Exception error){Console.Error.WriteLine(error);for(Exception current=error;current!=null;current=current.InnerException){var native=current as System.ComponentModel.Win32Exception;if(native!=null)Console.Error.WriteLine("native-error="+native.NativeErrorCode);}return 1;}}
}
