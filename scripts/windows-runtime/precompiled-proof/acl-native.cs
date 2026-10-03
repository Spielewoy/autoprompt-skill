// Native test controller only; never packaged as the capture executable.
using System;
using System.IO;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Collections.Generic;
using System.Web.Script.Serialization;
public static class BundleAclNativeControls {
  static void Need(bool value,string code){if(!value)throw new InvalidOperationException(code);}
  static string Hash(string path){using(var input=File.OpenRead(path))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(input)).Replace("-","").ToLowerInvariant();}
  public static int Main(string[] args){
    try{Run(args);return 0;}catch(Exception error){Console.Error.WriteLine(error.ToString());return 1;}
  }
  static void Run(string[] args){
    Need(args.Length==6,"native-arguments");string target=args[0],scratch=args[1],helper=args[2],control=args[3],identity=args[4],architecture=args[5];
    string name="Autoprompt_"+Guid.NewGuid().ToString("N");var plan=WindowsAppContainerResourcesNative.Plan(name,new[]{new WindowsAppContainerResourcesNative.RootSpec{path=target,kind="directory",writable=true},new WindowsAppContainerResourcesNative.RootSpec{path=scratch,kind="directory",writable=true},new WindowsAppContainerResourcesNative.RootSpec{path=Path.GetDirectoryName(helper),kind="directory",writable=false}});
    File.WriteAllText(Path.Combine(control,"resource-plan.json"),new JavaScriptSerializer().Serialize(plan));
    IntPtr package=IntPtr.Zero;bool prepared=false,drained=true;string sid=plan.profileSid;var outcomes=new List<string>();
    try{
      WindowsAppContainerResourcesNative.Apply(plan);prepared=true;Need(WindowsAppContainerNative.DeriveAppContainerSidFromAppContainerName(name,out package)==0&&package!=IntPtr.Zero,"derive-profile");
      string system=Environment.GetEnvironmentVariable("SystemRoot");var env=new[]{"SystemRoot="+system,"WINDIR="+system,"PATH="+Path.Combine(system,"System32"),"TEMP="+scratch,"TMP="+scratch};
      Action<string,string,string,string,string> probe=(label,expectedSid,path,id,expected)=>{
        drained=false;var result=WindowsAppContainerNative.Launch(helper,Hash(helper),new[]{"--acl-probe",expectedSid,path,id},scratch,env,15000,4096,package,sid,Path.Combine(control,"never-cancelled"));
        drained=result.Drained;Need(drained&&!result.TimedOut&&!result.Cancelled&&!result.OutputLimit&&result.RootImageMatches,"native-owned-drain:"+label);
        string stdout=Encoding.UTF8.GetString(Convert.FromBase64String(result.StdoutBase64)),stderr=Encoding.UTF8.GetString(Convert.FromBase64String(result.StderrBase64));
        File.WriteAllText(Path.Combine(control,label+".stdout"),stdout);File.WriteAllText(Path.Combine(control,label+".stderr"),stderr);
        if(expected=="denied")Need(result.ExitCode==0&&stderr==""&&stdout=="bundle-acl-denied-v1:"+architecture+":"+identity+":5\r\n","exact-kernel-denial:"+label+":"+stderr);
        else if(expected=="missing-target")Need(result.ExitCode==1&&stdout==""&&(stderr=="bundle-acl-probe-refused:acl-positive-open-target-2\r\n"||stderr=="bundle-acl-probe-refused:acl-positive-open-target-3\r\n"),"missing-target-refusal:"+stderr);
        else Need(result.ExitCode==1&&stdout==""&&stderr=="bundle-acl-probe-refused:"+expected+"\r\n","exact-refusal:"+label+":"+stderr);
        outcomes.Add(label);
      };
      probe("actual-AppContainer-denial",sid,target,identity,"denied");
      probe("wrong-profile-SID",sid.EndsWith("-1",StringComparison.Ordinal)?"S-1-15-2-1-2-3-4-5-6-2":"S-1-15-2-1-2-3-4-5-6-1",target,identity,"acl-package-mismatch");
      string wrong=identity.Substring(0,24)+(identity[24]=='0'?"1":"0");
      probe("wrong-directory-identity",sid,target,wrong,"acl-identity-mismatch");
      probe("missing-target",sid,Path.Combine(target,"missing"),identity,"missing-target");
      // Grant WRITE_DAC explicitly while keeping the same real AppContainer.
      // This is a test of the refusal path, never a product permission change.
      var directory=new DirectoryInfo(target);var acl=directory.GetAccessControl();byte[] appliedAcl=acl.GetSecurityDescriptorBinaryForm();acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),(FileSystemRights)0x40000,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));directory.SetAccessControl(acl);
      probe("actual-WRITE_DAC-grant-refused",sid,target,identity,"acl-WRITE_DAC-granted");
      // Restore exactly the applied mask before resource cleanup; the control
      // grant is not an unrelated application edit for the lifecycle to keep.
      acl=new DirectorySecurity();acl.SetSecurityDescriptorBinaryForm(appliedAcl,AccessControlSections.Access);directory.SetAccessControl(acl);
      WindowsAppContainerResourcesNative.Restore(plan);prepared=false;
      Need(outcomes.Count==5,"all-native-controls");File.WriteAllText(Path.Combine(control,"cleanup-confirmed"),"owned-drain-and-resource-restore");foreach(string value in outcomes)Console.WriteLine("native-acl-control:"+value);
    }finally{if(package!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(package);if(prepared&&drained)WindowsAppContainerResourcesNative.Restore(plan);}
  }
}
