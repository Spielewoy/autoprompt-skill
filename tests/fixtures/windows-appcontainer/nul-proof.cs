// Read-only device permission diagnostic. No ACL/capability changes.
// Run as --host, or with one exact expected AppContainer SID under the
// production launcher. The controller must enforce its own timeout/drain.
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class NulProof {
 [StructLayout(LayoutKind.Sequential)] struct SA { public Int32 Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public Boolean Inherit; }
 [StructLayout(LayoutKind.Sequential)] struct Unicode { public UInt16 Length,MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Version { public UInt32 Size,Major,Minor,Build,Platform; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public String ServicePack; }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean OpenProcessToken(IntPtr process,UInt32 rights,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean OpenThreadToken(IntPtr thread,UInt32 rights,Boolean self,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean GetTokenInformation(IntPtr token,Int32 type,IntPtr output,Int32 size,out Int32 needed);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(String path,UInt32 access,UInt32 share,ref SA sa,UInt32 disposition,UInt32 flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean GetHandleInformation(IntPtr handle,out UInt32 flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UInt32 GetFileType(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean ReadFile(IntPtr handle,Byte[] bytes,UInt32 length,out UInt32 read,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean WriteFile(IntPtr handle,Byte[] bytes,UInt32 length,out UInt32 written,IntPtr overlapped);
 [DllImport("ntdll.dll")] static extern Int32 NtQueryObject(IntPtr handle,Int32 kind,IntPtr output,UInt32 size,out UInt32 needed);
 [DllImport("ntdll.dll")] static extern Int32 RtlGetVersion(ref Version version);
 [DllImport("advapi32.dll")] static extern UInt32 GetSecurityInfo(IntPtr handle,Int32 objectType,UInt32 info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Boolean ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,UInt32 revision,UInt32 info,out IntPtr text,out UInt32 length);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 static void Need(Boolean value,String reason){if(!value)throw new InvalidOperationException(reason);}
 static String Quote(String text){return "\""+text.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n")+"\"";}
 static IntPtr TokenInfo(IntPtr token,Int32 type){Int32 needed;GetTokenInformation(token,type,IntPtr.Zero,0,out needed);Need(needed>0&&needed<=4096,"bounded-token-info");IntPtr result=Marshal.AllocHGlobal(needed);if(!GetTokenInformation(token,type,result,needed,out needed)){Marshal.FreeHGlobal(result);throw new InvalidOperationException("token-info:"+Marshal.GetLastWin32Error());}return result;}
 static void Identity(String expected){
  IntPtr thread=IntPtr.Zero;Boolean impersonating=OpenThreadToken(GetCurrentThread(),8,true,out thread);Int32 threadError=impersonating?0:Marshal.GetLastWin32Error();if(thread!=IntPtr.Zero)CloseHandle(thread);Need(!impersonating&&threadError==1008,"no-impersonation");
  IntPtr token=IntPtr.Zero,flag=IntPtr.Zero,user=IntPtr.Zero,package=IntPtr.Zero;
  try{Need(OpenProcessToken(GetCurrentProcess(),8,out token),"open-process-token");flag=TokenInfo(token,29);Int32 app=Marshal.ReadInt32(flag);Need(app==0||app==1,"valid-appcontainer-flag");user=TokenInfo(token,1);String userSid=new SecurityIdentifier(Marshal.ReadIntPtr(user)).Value,packageSid="";if(app==1){package=TokenInfo(token,31);packageSid=new SecurityIdentifier(Marshal.ReadIntPtr(package)).Value;}Need(expected=="--host"?app==0:app==1&&packageSid==expected,"expected-token-identity");var version=new Version{Size=(UInt32)Marshal.SizeOf(typeof(Version))};Need(RtlGetVersion(ref version)==0,"os-version");Console.WriteLine("{\"kind\":\"identity\",\"appContainer\":"+app+",\"userSid\":"+Quote(userSid)+",\"packageSid\":"+Quote(packageSid)+",\"osBuild\":"+version.Build+",\"pointerBits\":"+(IntPtr.Size*8)+"}");}
  finally{if(package!=IntPtr.Zero)Marshal.FreeHGlobal(package);if(user!=IntPtr.Zero)Marshal.FreeHGlobal(user);if(flag!=IntPtr.Zero)Marshal.FreeHGlobal(flag);if(token!=IntPtr.Zero)Need(CloseHandle(token),"close-token");}
 }
 static String ObjectName(IntPtr handle,out Int32 status){
  IntPtr data=Marshal.AllocHGlobal(4096);try{UInt32 needed;status=NtQueryObject(handle,1,data,4096,out needed);if(status!=0)return "";Need(needed<=4096,"object-name-bound");var name=(Unicode)Marshal.PtrToStructure(data,typeof(Unicode));Need(name.Length<=512&&(name.Length&1)==0,"object-name-length");Int64 offset=name.Buffer.ToInt64()-data.ToInt64();Need(offset>=0&&offset+name.Length<=4096,"object-name-pointer");return Marshal.PtrToStringUni(name.Buffer,name.Length/2);}finally{Marshal.FreeHGlobal(data);}
 }
 static void Security(IntPtr handle,Int32 name,Int32 access){
  IntPtr owner,group,dacl,sacl,descriptor=IntPtr.Zero,text=IntPtr.Zero;UInt32 status=GetSecurityInfo(handle,1,0x17,out owner,out group,out dacl,out sacl,out descriptor);
  try{String encoded="";Int32 convertError=0;if(status==0){UInt32 length;if(ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,0x17,out text,out length)){Need(length<=4096,"sddl-bound");encoded=Convert.ToBase64String(Encoding.UTF8.GetBytes(Marshal.PtrToStringUni(text)));}else convertError=Marshal.GetLastWin32Error();}
   Console.WriteLine("{\"kind\":\"security\",\"nameIndex\":"+name+",\"accessIndex\":"+access+",\"status\":"+status+",\"convertError\":"+convertError+",\"sddlBase64\":"+Quote(encoded)+"}");
  }finally{if(text!=IntPtr.Zero)LocalFree(text);if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
 }
 static void Probe(Int32 nameIndex,String name,Int32 accessIndex,UInt32 access,Boolean write){
  var sa=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=IntPtr.Zero,Inherit=true};
  IntPtr handle=CreateFileW(name,access,3,ref sa,3,0,IntPtr.Zero);Int32 error=handle==new IntPtr(-1)?Marshal.GetLastWin32Error():0;
  if(handle==new IntPtr(-1)){Console.WriteLine("{\"kind\":\"open\",\"nameIndex\":"+nameIndex+",\"accessIndex\":"+accessIndex+",\"access\":"+access+",\"error\":"+error+"}");return;}
  try{UInt32 flags;Boolean flagOk=GetHandleInformation(handle,out flags);Int32 flagError=flagOk?0:Marshal.GetLastWin32Error();Int32 status;String objectName=ObjectName(handle,out status);UInt32 type=GetFileType(handle);Int32 ioError=-1;UInt32 bytes=0;
   // Never perform I/O on a name that resolved to an unexpected object.
   if(status==0&&String.Equals(objectName,@"\Device\Null",StringComparison.OrdinalIgnoreCase)&&access!=0){Boolean ok=write?WriteFile(handle,new Byte[]{65},1,out bytes,IntPtr.Zero):ReadFile(handle,new Byte[1],1,out bytes,IntPtr.Zero);ioError=ok?0:Marshal.GetLastWin32Error();}
   Console.WriteLine("{\"kind\":\"open\",\"nameIndex\":"+nameIndex+",\"accessIndex\":"+accessIndex+",\"access\":"+access+",\"error\":0,\"handleFlags\":"+flags+",\"flagsError\":"+flagError+",\"objectStatus\":"+Quote(unchecked((UInt32)status).ToString("x8"))+",\"objectName\":"+Quote(objectName)+",\"fileType\":"+type+",\"ioError\":"+ioError+",\"ioBytes\":"+bytes+"}");Security(handle,nameIndex,accessIndex);
  }finally{Need(CloseHandle(handle),"close-device");}
 }
 public static Int32 Main(String[] args){try{
  Need(args.Length==1,"expected-SID-or-host");Identity(args[0]);
  String[] names={"NUL",@"\\.\NUL",@"\\?\NUL",@"\\?\GLOBALROOT\Device\Null"};
  // Exact libuv stdin/output masks first; minimal masks distinguish READ_CONTROL,
  // EA/attribute requests from data access. Every attempt uses OPEN_EXISTING.
  UInt32[] access={0x00120089,0x00120196,0x00100001,0x00100002,0};
  for(Int32 i=0;i<names.Length;i++){Console.WriteLine("{\"kind\":\"name\",\"index\":"+i+",\"value\":"+Quote(names[i])+"}");for(Int32 a=0;a<access.Length;a++)Probe(i,names[i],a,access[a],a==1||a==3);}
  Console.WriteLine("{\"kind\":\"completed\",\"cells\":20}");return 0;
 }catch(Exception error){Console.Error.WriteLine("nul-probe-refused:"+error.Message);return 1;}}
}
