using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;
public static class NulCapabilityProof {
 [StructLayout(LayoutKind.Sequential)] struct Unicode { public UInt16 Length,MaximumLength; public IntPtr Buffer; }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern UInt64 GetTickCount64();
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(Int32 which);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,UInt32 access,Boolean inherit,UInt32 options);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean GetHandleInformation(IntPtr handle,out UInt32 flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean ReadFile(IntPtr handle,Byte[] bytes,UInt32 length,out UInt32 read,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean WriteFile(IntPtr handle,Byte[] bytes,UInt32 length,out UInt32 written,IntPtr overlapped);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean OpenProcessToken(IntPtr process,UInt32 rights,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean OpenThreadToken(IntPtr thread,UInt32 rights,Boolean self,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean GetTokenInformation(IntPtr token,Int32 kind,IntPtr data,Int32 size,out Int32 needed);
 [DllImport("ntdll.dll")] static extern Int32 NtQueryObject(IntPtr handle,Int32 kind,IntPtr data,UInt32 size,out UInt32 needed);
 static void Need(Boolean value,String reason){if(!value)throw new InvalidOperationException(reason);}
 static IntPtr Handle(String value){Need(IntPtr.Size==8&&Regex.IsMatch(value??"",@"\A[0-9a-f]{16}\z"),"canonical-handle");UInt64 raw=UInt64.Parse(value,System.Globalization.NumberStyles.HexNumber);Need(raw!=0&&raw<=Int64.MaxValue,"valid-handle");return new IntPtr(unchecked((Int64)raw));}
 static String ObjectText(IntPtr handle,Int32 kind){IntPtr data=Marshal.AllocHGlobal(4096);try{UInt32 needed;Need(NtQueryObject(handle,kind,data,4096,out needed)==0&&needed>=Marshal.SizeOf(typeof(Unicode))&&needed<=4096,"query-held-object");var text=(Unicode)Marshal.PtrToStructure(data,typeof(Unicode));Int64 offset=text.Buffer.ToInt64()-data.ToInt64();Need((text.Length&1)==0&&text.Length<=1024&&text.MaximumLength>=text.Length&&offset>=Marshal.SizeOf(typeof(Unicode))&&offset+text.Length<=needed,"bounded-object-text");return Marshal.PtrToStringUni(text.Buffer,text.Length/2);}finally{Marshal.FreeHGlobal(data);}}
 static UInt32 Access(IntPtr handle){IntPtr data=Marshal.AllocHGlobal(256);try{UInt32 needed;Need(NtQueryObject(handle,0,data,256,out needed)==0&&needed>=8&&needed<=256,"query-held-access");return unchecked((UInt32)Marshal.ReadInt32(data,4));}finally{Marshal.FreeHGlobal(data);}}
 static void Identity(String expected){IntPtr thread=IntPtr.Zero;Boolean impersonating=OpenThreadToken(GetCurrentThread(),8,true,out thread);Int32 threadError=impersonating?0:Marshal.GetLastWin32Error();if(thread!=IntPtr.Zero)CloseHandle(thread);Need(!impersonating&&threadError==1008,"no-impersonation");IntPtr token=IntPtr.Zero,data=Marshal.AllocHGlobal(4096);try{Need(OpenProcessToken(GetCurrentProcess(),8,out token),"process-token");Int32 needed;Need(GetTokenInformation(token,29,data,4096,out needed)&&needed==4&&Marshal.ReadInt32(data)==1,"actual-appcontainer");Need(GetTokenInformation(token,31,data,4096,out needed)&&needed>=IntPtr.Size&&needed<=4096,"package-token");Need(new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value==expected,"exact-package-token");}finally{Marshal.FreeHGlobal(data);if(token!=IntPtr.Zero)Need(CloseHandle(token),"close-token");}}
 public static Int32 Main(String[] args){IntPtr held=IntPtr.Zero,stray=IntPtr.Zero;try{
  Need(args.Length==3&&Regex.IsMatch(args[0],@"\AS-1-15-2-(?:[0-9]+-){6}[0-9]+\z"),"arguments");Identity(args[0]);UInt64 started=GetTickCount64();
  IntPtr original=Handle(Environment.GetEnvironmentVariable("AUTOPROMPT_PRIVATE_NUL_HANDLE"));
  // Duplicate before inspecting the untrusted numeric handle. Every identity,
  // access and I/O assertion below uses this held, noninheritable duplicate.
  Need(DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),out held,0,false,2),"duplicate-capability-first");
  Need(ObjectText(held,2)=="File"&&ObjectText(held,1)==@"\Device\Null","held-exact-null-object");UInt32 granted=Access(held);Need(granted==0x12019f,"exact-capability-access");
  UInt32 originalFlags,heldFlags;Need(GetHandleInformation(original,out originalFlags)&&originalFlags==1,"original-inheritable");Need(GetHandleInformation(held,out heldFlags)&&heldFlags==0,"duplicate-private");Need(original!=GetStdHandle(-10),"capability-distinct-from-stdin");
  UInt32 read;Boolean readOk=ReadFile(held,new Byte[1],1,out read,IntPtr.Zero);Int32 readError=readOk?0:Marshal.GetLastWin32Error();Need(read==0&&(readOk||readError==38),"null-read-eof");UInt32 written;Need(WriteFile(held,new Byte[]{65},1,out written,IntPtr.Zero)&&written==1,"null-write-one");
  // A child may reuse a noninherited numeric slot. Reject inheritance of the
  // actual unique Event object, not harmless reuse as another kernel object.
  IntPtr rawStray=Handle(args[1]);Boolean opened=DuplicateHandle(GetCurrentProcess(),rawStray,GetCurrentProcess(),out stray,0,false,2);Int32 strayError=opened?0:Marshal.GetLastWin32Error();
  if(opened)Need(ObjectText(stray,2)!="Event"||ObjectText(stray,1)!=args[2],"unrelated-host-event-not-inherited");else Need(strayError==6,"stray-duplicate-closed-handle");
  System.Threading.Thread.Sleep(3000);UInt64 finished=GetTickCount64();
  Console.WriteLine("{\"schemaVersion\":1,\"packageSid\":\""+args[0]+"\",\"objectType\":\"File\",\"objectName\":\"\\\\Device\\\\Null\",\"grantedAccess\":"+granted+",\"originalFlags\":"+originalFlags+",\"duplicateFlags\":"+heldFlags+",\"distinctStdin\":true,\"readError\":"+readError+",\"readBytes\":0,\"writtenBytes\":1,\"strayEventInherited\":false,\"startedMs\":"+started+",\"finishedMs\":"+finished+"}");return 0;
 }catch(Exception error){Console.Error.WriteLine("nul-capability-refused:"+error.Message);return 1;}finally{if(stray!=IntPtr.Zero)CloseHandle(stray);if(held!=IntPtr.Zero)CloseHandle(held);}}
}
