using System;
using System.ComponentModel;
using System.Reflection;
public static class MsysAslrMock {
 public static UInt32 Flags,Policy;public static UIntPtr Length;public static IntPtr Process;public static Boolean Success=true;
}
public static class MsysAslrContract {
 public static void Run(){
  MethodInfo verify=typeof(WindowsAppContainerNative).GetMethod("VerifyMsysAslr",BindingFlags.NonPublic|BindingFlags.Static);
  if(verify==null)throw new InvalidOperationException("missing verifier");int cases=0;
  // Independently vary every ASLR flag. Only high entropy is incompatible.
  for(UInt32 flags=0;flags<32;flags++){
   MsysAslrMock.Flags=flags;Exception failure=null;
   try{verify.Invoke(null,new object[]{new IntPtr(123)});}catch(TargetInvocationException error){failure=error.InnerException;}
   if((flags&4)!=0){if(!(failure is InvalidOperationException)||failure.Message!="WINDOWS_MSYS_ASLR_INCOMPATIBLE")throw new InvalidOperationException("incompatible policy accepted");}
   else if(failure!=null)throw failure;
   if(MsysAslrMock.Process!=new IntPtr(123)||MsysAslrMock.Policy!=1||MsysAslrMock.Length.ToUInt64()!=4)throw new InvalidOperationException("incorrect query ABI");cases++;
  }
  MsysAslrMock.Success=false;
  try{verify.Invoke(null,new object[]{new IntPtr(123)});throw new InvalidOperationException("query failure accepted");}catch(TargetInvocationException error){if(!(error.InnerException is Win32Exception))throw;cases++;}
  Console.Write("{\"contractCases\":"+cases+",\"nativeApiBoundaries\":1}");
 }
}
