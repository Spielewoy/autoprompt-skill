// Executes the complete production environment preparation with the real known-
// folder API. No Windows process is launched by this portable contract.
using System;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
public static class ProfileEnvironmentContract {
 static int cases;
 static object Call(string method,params object[] arguments){try{return typeof(WindowsAppContainerNative).GetMethod(method,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,arguments);}catch(TargetInvocationException error){throw error.InnerException;}}
 static void Need(bool condition,string code){if(!condition)throw new InvalidOperationException(code);}
 static string[] Prepare(string[] entries){return (string[])Call("PrepareControllerProfileEnvironment",(object)entries);}
 static string[] Owned(string[] entries){return (string[])Call("OwnedNullEnvironment",entries,new IntPtr(0xabcdef));}
 static int Block(string[] entries){IntPtr pointer=(IntPtr)Call("EnvironmentBlock",(object)entries);try{return Marshal.PtrToStringUni(pointer,entries.Sum(x=>x.Length+1)+1).Length;}finally{Marshal.FreeHGlobal(pointer);}}
 static void Refuses(string code,Action action){try{action();}catch(InvalidOperationException error){Need(error.Message==code,"wrong-refusal:"+error.Message);cases++;return;}throw new InvalidOperationException("accepted:"+code);}
 static string[] Entries(int count){return Enumerable.Range(0,count).Select(i=>i==0?"SystemRoot=x":"K"+i+"=v").ToArray();}
 public static void Run(){
  string original=Environment.GetEnvironmentVariable("LOCALAPPDATA"),local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
  try{
   foreach(string entry in new string[]{null,"LOCALAPPDATA=","LOCALAPPDATA=incorrect","lOcAlApPdAtA=untrusted"}){
    Environment.SetEnvironmentVariable("LOCALAPPDATA",null,EnvironmentVariableTarget.Process);
    string[] input=entry==null?new[]{"SystemRoot=x","TEMP=owned","value=Ω=ok"}:new[]{"SystemRoot=x","TEMP=owned","value=Ω=ok",entry};string[] saved=(string[])input.Clone(),result=Prepare(input);
    Need(!Object.ReferenceEquals(result,input)&&input.SequenceEqual(saved),"input-preserved");
    Need(result.SequenceEqual(new[]{"SystemRoot=x","TEMP=owned","value=Ω=ok","LOCALAPPDATA="+local}),"known-folder-child-block");
    Need(Environment.GetEnvironmentVariable("LOCALAPPDATA")==local,"known-folder-controller-block");Block(Owned(result));cases++;
   }
   Environment.SetEnvironmentVariable("LOCALAPPDATA","untrusted-noncanonical-controller-value",EnvironmentVariableTarget.Process);
   string[] repaired=Prepare(new[]{"SystemRoot=x"});Need(repaired.SequenceEqual(new[]{"SystemRoot=x","LOCALAPPDATA="+local})&&Environment.GetEnvironmentVariable("LOCALAPPDATA")==local,"ambient-cannot-change-known-folder");cases++;
   Environment.SetEnvironmentVariable("LOCALAPPDATA","untrusted-noncanonical-controller-value",EnvironmentVariableTarget.Process);
   Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Prepare(new[]{"SystemRoot=x","systemroot=y"}));Need(Environment.GetEnvironmentVariable("LOCALAPPDATA")=="untrusted-noncanonical-controller-value","invalid-input-cannot-change-controller");
   string[] full=Entries(64);full[63]="localappdata=incorrect";Need(Prepare(full).Length==64&&Owned(Prepare(full)).Length==65,"existing-key-count-bound");Block(Owned(Prepare(full)));cases++;
   Need(Prepare(Entries(63)).Length==64&&Owned(Prepare(Entries(63))).Length==65,"added-key-count-bound");Block(Owned(Prepare(Entries(63))));cases++;
   foreach(string[] invalid in new[]{Entries(64),Entries(65),new string[0],new[]{"other=value"},new string[]{null,"SystemRoot=x"},new[]{"=bad","SystemRoot=x"},new[]{"bad","SystemRoot=x"},new[]{"LOCALAPPDATA=a\0b","SystemRoot=x"},new[]{"v=a\0b","SystemRoot=x"},new[]{"v\0=a","SystemRoot=x"},new[]{"SystemRoot=x","systemroot=y"},new[]{"SystemRoot=x","LOCALAPPDATA=x","localappdata=y"},new[]{"SystemRoot=x","LOCALAPPDATA="+new string('a',32760)}})Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Prepare(invalid));
   Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Prepare(null));
   foreach(string key in new[]{"AUTOPROMPT_PRIVATE_NUL_HANDLE","autoprompt_private_nul_handle"})Refuses("WINDOWS_NULL_CAPABILITY_RESERVED",()=>Prepare(new[]{"SystemRoot=x",key+"=incorrect"}));
   string[] sized={"SystemRoot=x","x="};int remaining=32760-Prepare(sized).Sum(x=>x.Length+1);sized[1]+=new string('a',remaining);Need(Prepare(sized).Sum(x=>x.Length+1)==32760,"normalized-exact-length");cases++;
   sized[1]+="a";Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Prepare(sized));
   string[] final={"SystemRoot=x","x="};remaining=32760-Owned(Prepare(final)).Sum(x=>x.Length+1);final[1]+=new string('a',remaining);Need(Block(Owned(Prepare(final)))==32761,"final-exact-length");cases++;
   final[1]+="a";Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Block(Owned(Prepare(final))));
   Console.Write("{\"contractCases\":"+cases+",\"knownFolderApi\":true,\"nativeLaunch\":false}");
  }finally{Environment.SetEnvironmentVariable("LOCALAPPDATA",original,EnvironmentVariableTarget.Process);}
 }
}
