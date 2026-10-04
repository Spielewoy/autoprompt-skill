// Complete production source, with only native API/last-error boundaries
// substituted by the test loader. Authority and root binding code stay intact.
using System;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class MemberAuthorityMock {
 public static Int32 LastError,AppFlag,ImageQueries,Waits,Opened,Closed;
 public static Boolean OpenFailure,TokenOpenFailure,TokenInfoFailure,JobApiFailure,InJob,ImageAvailable;
 public static UInt32 WaitResult;public static String Package,ImagePath;
 public const String Expected="S-1-15-2-1-2-3-4-5-6-7";
 public static void Reset(){LastError=5;AppFlag=1;ImageQueries=Waits=Opened=Closed=0;OpenFailure=TokenOpenFailure=TokenInfoFailure=JobApiFailure=false;InJob=true;ImageAvailable=false;WaitResult=258;Package=Expected;ImagePath="";}
 public static IntPtr OpenProcessForToken(Int32 access,Boolean inherit,Int32 pid){if(access!=0x101000||inherit||pid!=123)throw new InvalidOperationException("unexpected-process-open");if(OpenFailure)return IntPtr.Zero;Opened++;return new IntPtr(123);}
 public static Boolean OpenProcessToken(IntPtr process,UInt32 access,out IntPtr token){token=TokenOpenFailure?IntPtr.Zero:new IntPtr(201);return !TokenOpenFailure;}
 public static Boolean GetTokenInformation(IntPtr token,Int32 kind,IntPtr data,Int32 size,out Int32 required){required=kind==29?4:IntPtr.Size;if(data==IntPtr.Zero)return false;if(TokenInfoFailure)return false;if(kind==29)Marshal.WriteInt32(data,AppFlag);else if(kind==31)Marshal.WriteIntPtr(data,new IntPtr(301));else throw new InvalidOperationException("unexpected-token-kind");return true;}
 public static Boolean ConvertSidToStringSid(IntPtr sid,out IntPtr text){text=Marshal.StringToHGlobalUni(Package);return true;}
 public static IntPtr LocalFree(IntPtr memory){Marshal.FreeHGlobal(memory);return IntPtr.Zero;}
 public static Boolean IsProcessInJob(IntPtr process,IntPtr job,out Boolean result){result=InJob;return !JobApiFailure;}
 public static Boolean QueryInformationJobObject(IntPtr job,Int32 kind,IntPtr data,UInt32 size,out UInt32 returned){if(kind!=3)throw new InvalidOperationException("unexpected-job-query");returned=(UInt32)(8+IntPtr.Size);Marshal.WriteInt32(data,0,1);Marshal.WriteInt32(data,4,1);Marshal.WriteIntPtr(data,8,new IntPtr(123));return true;}
 public static Boolean CloseHandle(IntPtr handle){if(handle==new IntPtr(123))Closed++;return true;}
 public static UInt32 WaitForSingleObject(IntPtr handle,UInt32 milliseconds){if(milliseconds!=0)throw new InvalidOperationException("authority-must-not-block");Waits++;return WaitResult;}
 public static Boolean QueryFullProcessImageName(IntPtr process,UInt32 flags,StringBuilder image,ref UInt32 length){ImageQueries++;if(!ImageAvailable)return false;image.Append(ImagePath);length=(UInt32)ImagePath.Length;return true;}
}
public static class MemberImageContract {
 static readonly Type Native=typeof(WindowsAppContainerNative);
 static Object Call(String name,params Object[] args){try{return Native.GetMethod(name,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args);}catch(TargetInvocationException error){throw error.InnerException;}}
 static Int32 Members(){return (Int32)Call("VerifyMembers",new IntPtr(401),MemberAuthorityMock.Expected);}
 static void Need(Boolean value,String code){if(!value)throw new InvalidOperationException(code);}
 static void Refuses(String code,Action operation,Boolean native=false){try{operation();}catch(Exception error){Need(native?error is Win32Exception:error is InvalidOperationException&&error.Message==code,"wrong-refusal:"+code+":"+error.GetType()+":"+error.Message);return;}throw new InvalidOperationException("expected-refusal:"+code);}
 static Object Binding(String file,String digest){var type=Native.GetNestedType("ImageBinding",BindingFlags.NonPublic);try{return Activator.CreateInstance(type,new Object[]{file,digest});}catch(TargetInvocationException error){throw error.InnerException;}}
 static String Hash(String file){using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(File.ReadAllBytes(file))).Replace("-","").ToLowerInvariant();}
 public static void Run(String directory){Int32 count=0;
  MemberAuthorityMock.Reset();Need(Members()==1&&MemberAuthorityMock.ImageQueries==0&&MemberAuthorityMock.Waits==0&&MemberAuthorityMock.Opened==1&&MemberAuthorityMock.Closed==1,"unreadable-member-image-not-an-authority-query");count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.AppFlag=0;Refuses("APP_PROBE_MEMBER_TOKEN_NOT_APPCONTAINER",()=>Members());Need(MemberAuthorityMock.Waits==0,"token-mismatch-must-not-use-exit-fallback");count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.Package="S-1-15-2-7-6-5-4-3-2-1";Refuses("APP_PROBE_MEMBER_SID_MISMATCH",()=>Members());count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.InJob=false;Refuses("APP_PROBE_MEMBER_JOB_MISMATCH",()=>Members());count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.TokenOpenFailure=true;Refuses("live-token-open-error",()=>Members(),true);count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.TokenInfoFailure=true;Refuses("live-token-info-error",()=>Members(),true);count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.JobApiFailure=true;Refuses("live-job-query-error",()=>Members(),true);count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.OpenFailure=true;Refuses("live-process-open-error",()=>Members(),true);count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.TokenOpenFailure=true;MemberAuthorityMock.WaitResult=0;Need(Members()==1&&MemberAuthorityMock.Waits==1&&MemberAuthorityMock.Closed==1,"confirmed-exit-retains-existing-lifecycle-rule");count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.TokenOpenFailure=true;MemberAuthorityMock.WaitResult=UInt32.MaxValue;Refuses("wait-failure-never-proves-exit",()=>Members(),true);count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.TokenOpenFailure=true;MemberAuthorityMock.WaitResult=128;Refuses("unknown-wait-never-proves-exit",()=>Members(),true);count++;
  MemberAuthorityMock.Reset();MemberAuthorityMock.Package="wrong";MemberAuthorityMock.WaitResult=0;Refuses("APP_PROBE_MEMBER_SID_MISMATCH",()=>Members());Need(MemberAuthorityMock.Waits==0,"signaled-invariant-mismatch-not-swallowed");count++;
  String file=Path.Combine(directory,"bound-root-image.bin");File.WriteAllText(file,"exact-root-bytes");String digest=Hash(file);Object binding=Binding(file,digest);
  try{
   MemberAuthorityMock.Reset();MemberAuthorityMock.ImageAvailable=true;MemberAuthorityMock.ImagePath=Path.GetFullPath(file);Call("VerifyRootImage",new IntPtr(123),binding);Need(MemberAuthorityMock.ImageQueries==1&&WindowsAppContainerNative.LastRootImageMatches==1,"root-image-required");count++;
   MemberAuthorityMock.Reset();MemberAuthorityMock.ImageAvailable=true;MemberAuthorityMock.ImagePath=Path.Combine(directory,"different.exe");Refuses("APP_PROBE_ROOT_IMAGE_MISMATCH",()=>Call("VerifyRootImage",new IntPtr(123),binding));count++;
   MemberAuthorityMock.Reset();Refuses("unreadable-root-image-refused",()=>Call("VerifyRootImage",new IntPtr(123),binding),true);count++;
   MemberAuthorityMock.Reset();MemberAuthorityMock.AppFlag=0;Refuses("APP_PROBE_ROOT_TOKEN_NOT_APPCONTAINER",()=>Call("VerifyAppContainerTokenAndJob",new IntPtr(123),MemberAuthorityMock.Expected,new IntPtr(401),true));count++;
  }finally{((IDisposable)binding).Dispose();}
  Refuses("image hash mismatch",()=>Binding(file,new String('0',64)));count++;
  Console.Write("{\"contractCases\":"+count+"}");
 }
}
