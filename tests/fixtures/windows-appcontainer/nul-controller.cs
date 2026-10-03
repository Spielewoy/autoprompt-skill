using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
public static class NulController {
 static void Need(Boolean value,String reason){if(!value)throw new InvalidOperationException(reason);}
 static String Hash(String file){using(var stream=File.OpenRead(file))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
 static void GrantOwnedFixture(String executable,String package){
  var user=WindowsIdentity.GetCurrent().User;var file=new FileSecurity();file.SetOwner(user);file.SetAccessRuleProtection(true,false);
  foreach(String sid in new[]{user.Value,"S-1-5-18",package})file.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,AccessControlType.Allow));
  // Only the fresh, unmapped probe image and its owned leaf directory receive
  // package access. The controller and the system Null device are untouched.
  new FileInfo(executable).SetAccessControl(file);
  var directory=new DirectorySecurity();directory.SetOwner(user);directory.SetAccessRuleProtection(true,false);
  foreach(String sid in new[]{user.Value,"S-1-5-18",package})directory.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));
  new DirectoryInfo(Path.GetDirectoryName(executable)).SetAccessControl(directory);
 }
 static String[] ChildEnvironment(){String root=Environment.GetEnvironmentVariable("SystemRoot"),local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);Need(!String.IsNullOrEmpty(root)&&!String.IsNullOrEmpty(local)&&Directory.Exists(local),"known-Windows-folders");return new[]{"SystemRoot="+root,"WINDIR="+root,"SystemDrive="+root.Substring(0,2),"PATH="+Path.Combine(root,"System32"),"LOCALAPPDATA="+local};}
 public static Int32 Main(String[] args){
  String profileName="Autoprompt_"+Guid.NewGuid().ToString("N");IntPtr profile=IntPtr.Zero;Boolean created=false,drained=true;String proof=null;Exception failure=null;
  try{
   Need(args.Length==2,"expected-owned-executable-and-sha256");String executable=Path.GetFullPath(args[0]);Need(Hash(executable)==args[1],"bound-fixture-bytes");
   Need(WindowsAppContainerNative.CreateAppContainerProfile(profileName,profileName,profileName,IntPtr.Zero,0,out profile)>=0,"create-owned-profile");created=true;String package=new SecurityIdentifier(profile).Value;
   GrantOwnedFixture(executable,package);var environment=ChildEnvironment();Environment.SetEnvironmentVariable("LOCALAPPDATA",null,EnvironmentVariableTarget.Process);
   drained=false;
   var result=WindowsAppContainerNative.Launch(executable,args[1],new[]{package},Path.GetDirectoryName(executable),environment,10000,262144,profile,package,null);
   drained=result.Drained;
   Need(result.Drained&&result.RootImageMatches&&result.AppContainerSid==package&&!result.TimedOut&&!result.Cancelled&&!result.OutputLimit,"exact-owned-launch-and-positive-drain");
   Need(result.ExitCode==0&&result.StderrBase64=="","probe-successful-completion");
   Need(Hash(executable)==args[1],"fixture-bytes-remain-bound");
   proof="{\"schemaVersion\":1,\"packageSid\":\""+package+"\",\"drained\":true,\"rootImageMatches\":true,\"exitCode\":0,\"timedOut\":false,\"cancelled\":false,\"outputLimit\":false,\"observedJobMembers\":"+result.ObservedJobMembers+",\"stdoutBase64\":\""+result.StdoutBase64+"\",\"stderrBase64\":\"\"}";
  }catch(Exception error){failure=error;}
  finally{
   if(created&&drained){if(WindowsAppContainerNative.DeleteAppContainerProfile(profileName)!=0)failure=new InvalidOperationException("delete-owned-profile",failure);}
   else if(created)Console.Error.WriteLine("retained-profile-after-unconfirmed-launch:"+profileName);
   if(profile!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(profile);
  }
  if(failure!=null){Console.Error.WriteLine(failure);for(Exception current=failure;current!=null;current=current.InnerException){var native=current as System.ComponentModel.Win32Exception;if(native!=null)Console.Error.WriteLine("native-error="+native.NativeErrorCode);}return 1;}
  Need(proof!=null&&drained,"completed-proof");Console.WriteLine(proof);return 0;
 }
}
