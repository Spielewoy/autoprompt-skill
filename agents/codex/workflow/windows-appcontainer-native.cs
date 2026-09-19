// Controller-owned Windows AppContainer launch primitive.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;
public static class WindowsAppContainerNative {
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern Int32 DeriveAppContainerSidFromAppContainerName(String name,out IntPtr sid);
 [StructLayout(LayoutKind.Sequential)] public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid,Capabilities; public UInt32 CapabilityCount,Reserved; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct STARTUPINFO { public Int32 cb; public String lpReserved,lpDesktop,lpTitle; public UInt32 dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public UInt16 wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr AttributeList; }
 [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public UInt32 dwProcessId,dwThreadId; }
 [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public Int32 nLength; public IntPtr securityDescriptor; public Boolean inherit; }
 [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public Int64 PerProcessUserTimeLimit,PerJobUserTimeLimit; public UInt32 LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public UInt32 ActiveProcessLimit; public UIntPtr Affinity; public UInt32 PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public UInt64 ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public Int64 TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public UInt32 TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
 const UInt32 EXTENDED_STARTUPINFO_PRESENT=0x00080000,CREATE_SUSPENDED=0x4,CREATE_UNICODE_ENVIRONMENT=0x400,CREATE_NO_WINDOW=0x08000000,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES=0x00020009,PROC_THREAD_ATTRIBUTE_HANDLE_LIST=0x00020002,JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000,TOKEN_QUERY=0x8,STARTF_USESTDHANDLES=0x100,GENERIC_READ=0x80000000,GENERIC_WRITE=0x40000000,FILE_SHARE_READ=1,FILE_SHARE_WRITE=2,OPEN_EXISTING=3,FILE_ATTRIBUTE_NORMAL=0x80,HANDLE_FLAG_INHERIT=1,ERROR_BROKEN_PIPE=109;
 const Int32 JobObjectBasicAccountingInformation=1,JobObjectBasicProcessIdList=3,JobObjectExtendedLimitInformation=9,TokenIsAppContainer=29,TokenAppContainerSid=31,SE_FILE_OBJECT=1; const UInt32 LABEL_SECURITY_INFORMATION=0x10;
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern Int32 CreateAppContainerProfile(String name,String display,String description,IntPtr caps,UInt32 count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern Int32 DeleteAppContainerProfile(String name);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern Int32 GetAppContainerFolderPath(String sid,out IntPtr path);
 [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr memory);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern IntPtr FreeSid(IntPtr sid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,UInt32 rights,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,Int32 type,IntPtr data,Int32 length,out Int32 required);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,EntryPoint="ConvertSidToStringSidW",SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern UInt32 GetNamedSecurityInfo(String name,Int32 objectType,UInt32 information,out IntPtr owner,IntPtr group,IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,UInt32 revision,UInt32 information,out IntPtr text,out UInt32 textLength);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr LocalFree(IntPtr memory);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,String name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,Int32 infoClass,IntPtr info,UInt32 length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,Int32 infoClass,IntPtr info,UInt32 length,out UInt32 returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UInt32 ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UInt32 WaitForSingleObject(IntPtr handle,UInt32 milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out UInt32 code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,UInt32 code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,UInt32 code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,UInt32 size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,UInt32 mask,UInt32 flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(String name,UInt32 access,UInt32 share,ref SECURITY_ATTRIBUTES attributes,UInt32 disposition,UInt32 flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool PeekNamedPipe(IntPtr pipe,IntPtr buffer,UInt32 bufferSize,IntPtr bytesRead,out UInt32 available,IntPtr bytesLeft);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr handle,Byte[] buffer,UInt32 size,out UInt32 read,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,Int32 count,Int32 flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,UInt32 flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(String app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,UInt32 flags,IntPtr environment,String cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION information);
 public sealed class LaunchResult { public UInt32 RootPid,ExitCode; public Int32 ObservedJobMembers,LauncherSessionId; public String AppContainerSid,StdoutBase64,StderrBase64; public Boolean RootImageMatches,Drained,TimedOut,OutputLimit,Cancelled; }
 [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public UInt16 Length,MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public Int32 Length; public IntPtr RootDirectory,ObjectName; public UInt32 Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
 [DllImport("ntdll.dll")] static extern Int32 NtCreateDirectoryObject(out IntPtr handle,UInt32 access,ref OBJECT_ATTRIBUTES attributes);
 [DllImport("ntdll.dll")] static extern Int32 NtQuerySecurityObject(IntPtr handle,UInt32 information,IntPtr descriptor,UInt32 length,out UInt32 required);
 [DllImport("ntdll.dll")] static extern Int32 NtQueryObject(IntPtr handle,Int32 information,IntPtr buffer,UInt32 length,out UInt32 required);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UInt32 GetFileType(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean GetHandleInformation(IntPtr handle,out UInt32 flags);
 [DllImport("ntdll.dll")] static extern UInt16 RtlUpcaseUnicodeChar(UInt16 value);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern UInt32 GetFinalPathNameByHandle(IntPtr handle,StringBuilder name,UInt32 length,UInt32 flags);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Boolean ConvertStringSecurityDescriptorToSecurityDescriptor(String text,UInt32 revision,out IntPtr descriptor,out UInt32 size);
 public sealed class MsysNamespaceRequest { public String DllPath,DllSha256,SharedId; }

 // MSYS hashes the final full DLL path, before removing its filename. These
 // names and the embedded shared ABI come from the exact bound copied DLL;
 // the caller cannot select a global namespace or execute Bash to discover it.
 public sealed class MsysNamespaceLease : IDisposable {
  readonly List<IntPtr> handles=new List<IntPtr>(); ImageBinding dllBinding;
  public readonly String[] Names;
  internal MsysNamespaceLease(String executable,MsysNamespaceRequest request,String expectedSid) {
   if(request==null||!Regex.IsMatch(expectedSid??"",@"\AS-1-15-2-(?:[0-9]+-){6}[0-9]+\z")||
      !Regex.IsMatch(request.SharedId??"",@"\Amsys-2\.0S[1-9][0-9]{0,8}\z")||
      !Regex.IsMatch(request.DllSha256??"",@"\A[a-f0-9]{64}\z")||
      !Path.IsPathRooted(request.DllPath??"")||!String.Equals(Path.GetFileName(request.DllPath),"msys-2.0.dll",StringComparison.OrdinalIgnoreCase)||
      !String.Equals(Path.GetDirectoryName(Path.GetFullPath(request.DllPath)),Path.GetDirectoryName(Path.GetFullPath(executable)),StringComparison.OrdinalIgnoreCase)||
      !String.Equals(Path.GetFileName(executable),"bash.exe",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_INVALID");
   try {
    dllBinding=new ImageBinding(request.DllPath,request.DllSha256);
    if(!String.Equals(request.DllPath,dllBinding.FullPath,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");
    if(dllBinding.Stream.Length>33554432)throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");
    dllBinding.Stream.Position=0;var bytes=new Byte[(Int32)dllBinding.Stream.Length];Int32 read=0;
    while(read<bytes.Length){Int32 n=dllBinding.Stream.Read(bytes,read,bytes.Length-read);if(n==0)throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");read+=n;}
    String binary=Encoding.ASCII.GetString(bytes);const String begin="BEGIN_CYGWIN_VERSION_INFO\n",end="END_CYGWIN_VERSION_INFO";
    Int32 start=binary.IndexOf(begin,StringComparison.Ordinal),finish=binary.IndexOf(end,StringComparison.Ordinal);
    if(start<0||finish<start+begin.Length||finish-start>8192||binary.IndexOf(begin,start+begin.Length,StringComparison.Ordinal)>=0||binary.IndexOf(end,finish+end.Length,StringComparison.Ordinal)>=0)throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");
    for(Int32 i=start+begin.Length;i<finish;i++)if(bytes[i]!=10&&(bytes[i]<32||bytes[i]>126))throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");
    String block=binary.Substring(start+begin.Length,finish-start-begin.Length);var lines=block.Split('\n');
    if(lines.Length<2||lines[lines.Length-1]!=""||lines.Take(lines.Length-1).Any(line=>!line.StartsWith("%%% MSYS ",StringComparison.Ordinal)))throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");
    var ids=lines.Where(line=>line.StartsWith("%%% MSYS shared id: ",StringComparison.Ordinal)).ToArray();
    var abi=lines.Where(line=>line.StartsWith("%%% MSYS shared data: ",StringComparison.Ordinal)).ToArray();
    if(ids.Length!=1||abi.Length!=1||ids[0]!="%%% MSYS shared id: "+request.SharedId||abi[0]!="%%% MSYS shared data: "+request.SharedId.Substring("msys-2.0S".Length))throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");
    var final=new StringBuilder(32768);UInt32 length=GetFinalPathNameByHandle(dllBinding.Stream.SafeFileHandle.DangerousGetHandle(),final,(UInt32)final.Capacity,0);
    if(length==0||length>=final.Capacity||!final.ToString().StartsWith(@"\\?\",StringComparison.Ordinal))throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");
    String finalPath=final.ToString().StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)?@"\\"+final.ToString().Substring(8):final.ToString().Substring(4);
    if(!String.Equals(finalPath,dllBinding.FullPath,StringComparison.OrdinalIgnoreCase)||!PhysicalDirectoryAncestry(Path.GetDirectoryName(dllBinding.FullPath)))throw new InvalidOperationException("WINDOWS_MSYS_RUNTIME_INVALID");
    String nativePath=@"\??\"+final.ToString().Substring(4);UInt64 hash=0;
    unchecked{foreach(Char value in nativePath)hash=(UInt64)RtlUpcaseUnicodeChar(value)+(hash<<6)+(hash<<16)-hash;}
    String leaf=request.SharedId+"-"+hash.ToString("x16");Int32 session=Process.GetCurrentProcess().SessionId;
    Names=session==0?new[]{@"\BaseNamedObjects\"+leaf}:new[]{@"\BaseNamedObjects\"+leaf,@"\Sessions\BNOLINKS\"+session+@"\"+leaf};
    String user;using(var identity=WindowsIdentity.GetCurrent()){if(identity.User==null)throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_INVALID");user=identity.User.Value;}
    // Direct namespace rights exclude WRITE_DAC/WRITE_OWNER/DELETE. The
    // separate inheritance-only grant applies only to new child objects.
    String sddl="O:"+user+"G:"+user+"D:P(A;;0xf000f;;;"+user+")(A;;0xf000f;;;SY)(A;;0x2000f;;;"+expectedSid+")(A;OICIIO;GA;;;"+user+")(A;OICIIO;GA;;;SY)(A;OICIIO;GA;;;"+expectedSid+")S:(ML;;NW;;;LW)";
    foreach(String name in Names)Create(name,sddl,user,expectedSid);
   }catch{Dispose();throw;}
  }
  void Create(String name,String sddl,String user,String profileSid) {
   IntPtr text=IntPtr.Zero,unicode=IntPtr.Zero,descriptor=IntPtr.Zero,handle=IntPtr.Zero;
   try {
    UInt32 descriptorSize;Check(ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out descriptor,out descriptorSize),"MSYS-private-descriptor");
    text=Marshal.StringToHGlobalUni(name);var value=new UNICODE_STRING{Length=checked((UInt16)(name.Length*2)),MaximumLength=checked((UInt16)(name.Length*2+2)),Buffer=text};
    unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));Marshal.StructureToPtr(value,unicode,false);
    // No OBJ_OPENIF, OBJ_PERMANENT, or inherited handle: a preexisting name
    // is a collision, never a directory whose security we replace or trust.
    var attributes=new OBJECT_ATTRIBUTES{Length=Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),ObjectName=unicode,Attributes=0x40,SecurityDescriptor=descriptor};
    Int32 status=NtCreateDirectoryObject(out handle,0x000f000f,ref attributes);
    if(status==unchecked((Int32)0xc0000035)||status==0x40000000)throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_COLLISION");
    if(status<0)throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_CREATE_"+unchecked((UInt32)status).ToString("X8"));
    VerifyDescriptor(handle,user,profileSid);handles.Add(handle);handle=IntPtr.Zero;
   }finally{if(handle!=IntPtr.Zero)CloseHandle(handle);if(descriptor!=IntPtr.Zero)LocalFree(descriptor);if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);if(text!=IntPtr.Zero)Marshal.FreeHGlobal(text);}
  }
  static void VerifyDescriptor(IntPtr handle,String user,String profileSid) {
   UInt32 required;NtQuerySecurityObject(handle,0x17,IntPtr.Zero,0,out required);
   if(required==0||required>16384)throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_SECURITY");
   IntPtr memory=Marshal.AllocHGlobal((Int32)required);
   try {
    Int32 status=NtQuerySecurityObject(handle,0x17,memory,required,out required);if(status<0)throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_SECURITY");
    var bytes=new Byte[required];Marshal.Copy(memory,bytes,0,bytes.Length);var security=new RawSecurityDescriptor(bytes,0);
    if(security.Owner==null||security.Owner.Value!=user||(security.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0||security.DiscretionaryAcl==null||security.DiscretionaryAcl.Count!=6)throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_SECURITY");
    var expected=new HashSet<String>{user+":0:983055","S-1-5-18:0:983055",profileSid+":0:131087",user+":11:268435456","S-1-5-18:11:268435456",profileSid+":11:268435456"};
    foreach(GenericAce item in security.DiscretionaryAcl){var ace=item as CommonAce;if(ace==null||ace.AceQualifier!=AceQualifier.AccessAllowed||!expected.Remove(ace.SecurityIdentifier.Value+":"+(Int32)ace.AceFlags+":"+ace.AccessMask))throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_SECURITY");}
    if(expected.Count!=0||security.SystemAcl==null||security.SystemAcl.Count!=1)throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_SECURITY");
    // Mandatory labels are SYSTEM_MANDATORY_LABEL_ACE (0x11), mask NW=1,
    // SID S-1-16-4096. RawSecurityDescriptor retains this ACE as custom bytes.
    GenericAce label=security.SystemAcl[0];var labelBytes=new Byte[label.BinaryLength];label.GetBinaryForm(labelBytes,0);
    if(labelBytes[0]!=0x11||labelBytes[1]!=0||BitConverter.ToUInt32(labelBytes,4)!=1||new SecurityIdentifier(labelBytes,8).Value!="S-1-16-4096")throw new InvalidOperationException("WINDOWS_MSYS_NAMESPACE_SECURITY");
   }finally{Marshal.FreeHGlobal(memory);}
  }
  public void Dispose(){for(Int32 i=handles.Count-1;i>=0;i--)CloseHandle(handles[i]);handles.Clear();if(dllBinding!=null){dllBinding.Dispose();dllBinding=null;}}
 }
 public static MsysNamespaceLease CreateMsysNamespaceLease(String executable,MsysNamespaceRequest request,String expectedSid){return request==null?null:new MsysNamespaceLease(executable,request,expectedSid);}
 // An unconfirmed drain is terminal for this helper. Keep these handles (and
 // the DLL binding) alive until helper exit rather than release a namespace
 // whose owned process family might still be using it.
 static readonly List<MsysNamespaceLease> undrainedNamespaces=new List<MsysNamespaceLease>();
 sealed class ImageBinding : IDisposable { public readonly String FullPath; internal readonly FileStream Stream; public ImageBinding(String path,String expectedHash){if(String.IsNullOrEmpty(expectedHash)||expectedHash.Length!=64||expectedHash.Any(c=>!((c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F'))))throw new InvalidOperationException("image hash invalid");FullPath=Path.GetFullPath(path);if((File.GetAttributes(FullPath)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("image reparse");FileStream stream=null;try{stream=new FileStream(FullPath,FileMode.Open,FileAccess.Read,FileShare.Read);if(stream.Length<=0||stream.Length>536870912)throw new InvalidOperationException("image size invalid");String actual;using(var hash=SHA256.Create()){actual=String.Concat(hash.ComputeHash(stream).Select(b=>b.ToString("x2")));}if(actual.Length!=expectedHash.Length)throw new InvalidOperationException("image hash mismatch");Int32 diff=0;for(Int32 i=0;i<actual.Length;i++)diff|=Char.ToLowerInvariant(actual[i])^Char.ToLowerInvariant(expectedHash[i]);if(diff!=0)throw new InvalidOperationException("image hash mismatch");Stream=stream;stream=null;}finally{if(stream!=null)stream.Dispose();}} public void Dispose(){Stream.Dispose();} }
 public static String LastStage="initial"; public static Int32 LastWin32=0; public static UInt32 LastRootWait=UInt32.MaxValue,LastRootExit=UInt32.MaxValue,LastJobActive=UInt32.MaxValue,LastObservedMembers=UInt32.MaxValue,LastCatchRootWait=UInt32.MaxValue,LastCatchRootExit=UInt32.MaxValue; public static Int32 LastRootImageMatches=-1,LastStderrCategory=-1,LastStderrCode=0,LastStderrSyscall=0,LastStderrTargetRelation=0,LastSetupMs=-1,LastPrelaunchMs=-1,LastObserveMs=-1,LastWaitMs=-1,LastCleanupMs=-1;
 static void Mark(String stage){LastStage=stage;LastWin32=0;}
 static void Check(bool value,String action){Mark(action);if(!value){LastWin32=Marshal.GetLastWin32Error();throw new Win32Exception(LastWin32,action);}}
 static String Sid(IntPtr sid){IntPtr text=IntPtr.Zero;try{if(sid==IntPtr.Zero)throw new InvalidOperationException("invalid sid");Check(ConvertSidToStringSid(sid,out text),"ConvertSidToStringSidW");return Marshal.PtrToStringUni(text);}finally{if(text!=IntPtr.Zero)LocalFree(text);}}
 public static Boolean IsExactLowNoWriteUpLabel(String path){IntPtr owner=IntPtr.Zero,sacl=IntPtr.Zero,descriptor=IntPtr.Zero,text=IntPtr.Zero;try{UInt32 status=GetNamedSecurityInfo(path,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,out owner,IntPtr.Zero,IntPtr.Zero,out sacl,out descriptor);if(status!=0||descriptor==IntPtr.Zero)return false;UInt32 length;if(!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,LABEL_SECURITY_INFORMATION,out text,out length)||text==IntPtr.Zero)return false;String sddl=Marshal.PtrToStringUni(text);const String ace="(ML;;NW;;;LW)";if(sddl==null||!sddl.StartsWith("S:",StringComparison.Ordinal)||!sddl.EndsWith(ace,StringComparison.Ordinal))return false;String flags=sddl.Substring(2,sddl.Length-2-ace.Length);return flags.Length==0||String.Equals(flags,"PAI",StringComparison.Ordinal);}finally{if(text!=IntPtr.Zero)LocalFree(text);if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}}
 static IntPtr Info(IntPtr token,Int32 kind){Int32 required;GetTokenInformation(token,kind,IntPtr.Zero,0,out required);if(required<=0)throw new Win32Exception(Marshal.GetLastWin32Error(),"GetTokenInformation-size");IntPtr result=Marshal.AllocHGlobal(required);try{Check(GetTokenInformation(token,kind,result,required,out required),"GetTokenInformation");return result;}catch{Marshal.FreeHGlobal(result);throw;}}
 static void VerifyAppContainerTokenAndJob(IntPtr process,String expectedSid,IntPtr job,Boolean root){String role=root?"ROOT":"MEMBER";IntPtr token=IntPtr.Zero,isApp=IntPtr.Zero,sid=IntPtr.Zero;try{Check(OpenProcessToken(process,TOKEN_QUERY,out token),"OpenProcessToken");isApp=Info(token,TokenIsAppContainer);if(Marshal.ReadInt32(isApp)==0){Mark(root?"root-token-appcontainer-result":"member-token-appcontainer-result");throw new InvalidOperationException("APP_PROBE_"+role+"_TOKEN_NOT_APPCONTAINER");}sid=Info(token,TokenAppContainerSid);if(Sid(Marshal.ReadIntPtr(sid))!=expectedSid){Mark(root?"root-sid-result":"member-sid-result");throw new InvalidOperationException("APP_PROBE_"+role+"_SID_MISMATCH");}bool inJob;Check(IsProcessInJob(process,job,out inJob),"IsProcessInJob");if(!inJob){Mark(root?"root-job-membership-result":"member-job-membership-result");throw new InvalidOperationException("APP_PROBE_"+role+"_JOB_MISMATCH");}}finally{if(sid!=IntPtr.Zero)Marshal.FreeHGlobal(sid);if(isApp!=IntPtr.Zero)Marshal.FreeHGlobal(isApp);if(token!=IntPtr.Zero)CloseHandle(token);}}
 static void VerifyRootImage(IntPtr process,ImageBinding imageBinding) {
  var name=new StringBuilder(32768);UInt32 length=(UInt32)name.Capacity;
  if(!QueryFullProcessImageName(process,0,name,ref length)){Int32 error=Marshal.GetLastWin32Error();Mark("QueryFullProcessImageName-root");LastWin32=error;throw new Win32Exception(error,"QueryFullProcessImageName-root");}
  if(!String.Equals(Path.GetFullPath(name.ToString()),imageBinding.FullPath,StringComparison.OrdinalIgnoreCase)){LastRootImageMatches=0;Mark("root-image-identity-result");throw new InvalidOperationException("APP_PROBE_ROOT_IMAGE_MISMATCH");}
  LastRootImageMatches=1;
 }
 static UInt32 Active(IntPtr job){Int32 size=Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));IntPtr pointer=Marshal.AllocHGlobal(size);try{UInt32 returned;Check(QueryInformationJobObject(job,JobObjectBasicAccountingInformation,pointer,(UInt32)size,out returned),"QueryInformationJobObject-accounting");return ((JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(pointer,typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION))).ActiveProcesses;}finally{Marshal.FreeHGlobal(pointer);}}
 // Descendant authority is the actual AppContainer token, expected package SID
 // and owned job. Different child executables are permitted by this sandbox;
 // image-path classification did not restrict them and is not an authority
 // check. Only the root image is queried and bound before it can execute.
 static Int32 VerifyMembers(IntPtr job,String expectedSid) {
  Int32 capacity=16;
  for(;;){IntPtr pointer=Marshal.AllocHGlobal(8+capacity*IntPtr.Size);try{
   UInt32 returned;
   if(QueryInformationJobObject(job,JobObjectBasicProcessIdList,pointer,(UInt32)(8+capacity*IntPtr.Size),out returned)){
    Int32 count=Marshal.ReadInt32(pointer,4);LastObservedMembers=(UInt32)count;
    if(count<0||count>capacity){Mark("job-member-count-result");throw new InvalidOperationException("APP_PROBE_JOB_MEMBER_COUNT_INVALID");}
    for(Int32 i=0;i<count;i++){
     IntPtr process=OpenProcessForToken((Int32)Marshal.ReadIntPtr(pointer,8+i*IntPtr.Size).ToInt64());if(process==IntPtr.Zero)continue;
     try{try{VerifyAppContainerTokenAndJob(process,expectedSid,job,false);}
      catch(Win32Exception){if(WaitForSingleObject(process,0)!=0)throw;}
     }finally{CloseHandle(process);}
    }
    return count;
   }
   if(Marshal.GetLastWin32Error()!=234||capacity>=1024)throw new Win32Exception(Marshal.GetLastWin32Error(),"QueryInformationJobObject-members");
   capacity*=2;
  }finally{Marshal.FreeHGlobal(pointer);}}
 }
 [DllImport("kernel32.dll",SetLastError=true,EntryPoint="OpenProcess")] static extern IntPtr OpenProcessForToken(Int32 access,Boolean inherit,Int32 pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="QueryFullProcessImageNameW")] static extern Boolean QueryFullProcessImageName(IntPtr process,UInt32 flags,StringBuilder image,ref UInt32 length);
 static IntPtr OpenProcessForToken(Int32 pid){IntPtr process=OpenProcessForToken(0x101000,false,pid);if(process==IntPtr.Zero&&Marshal.GetLastWin32Error()!=87)throw new Win32Exception(Marshal.GetLastWin32Error(),"OpenProcess");return process;}
 static Boolean Drain(IntPtr job,Int32 milliseconds){for(Int32 elapsed=0;elapsed<=milliseconds;elapsed+=50){try{if(Active(job)==0)return true;}catch{return false;}System.Threading.Thread.Sleep(50);}return false;}
 static Int32 DrainStderr(IntPtr pipe,Byte[] kept,ref Int32 keptLength,ref Int32 total){for(;;){UInt32 available;if(!PeekNamedPipe(pipe,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)){Int32 error=Marshal.GetLastWin32Error();return error==ERROR_BROKEN_PIPE?0:2;}if(available==0)return 0;UInt32 requested=available>4096u?4096u:available;Byte[] chunk=new Byte[(Int32)requested];UInt32 read;if(!ReadFile(pipe,chunk,(UInt32)chunk.Length,out read,IntPtr.Zero)){Int32 error=Marshal.GetLastWin32Error();return error==ERROR_BROKEN_PIPE?0:2;}if(read==0)return 0;total+=(Int32)read;if(total>65536)return 1;Int32 copy=Math.Min((Int32)read,kept.Length-keptLength);if(copy>0){Buffer.BlockCopy(chunk,0,kept,keptLength,copy);keptLength+=copy;}}}
 static Int32 ElapsedMs(Stopwatch clock){Int64 value=clock.ElapsedMilliseconds;return value>Int32.MaxValue?Int32.MaxValue:(Int32)value;}
 static Boolean SameOrWithin(String value,String root){if(String.Equals(value,root,StringComparison.OrdinalIgnoreCase))return true;String prefix=root.EndsWith("\\",StringComparison.Ordinal)||root.EndsWith("/",StringComparison.Ordinal)?root:root+"\\";return value.StartsWith(prefix,StringComparison.OrdinalIgnoreCase);}
 static void CaptureRootPreMembership(IntPtr process,IntPtr job){LastRootWait=WaitForSingleObject(process,0);UInt32 exit;Check(GetExitCodeProcess(process,out exit),"GetExitCodeProcess-root-pre-membership");LastRootExit=exit;LastJobActive=Active(job);Mark("root-pre-membership-snapshot");}
 static void CaptureRootAtCatch(IntPtr process){if(process==IntPtr.Zero)return;LastCatchRootWait=WaitForSingleObject(process,0);UInt32 exit;if(GetExitCodeProcess(process,out exit))LastCatchRootExit=exit;}
 static String Quote(String value){if(value.Length==0)return "\"\"";if(!value.Any(c=>Char.IsWhiteSpace(c)||c=='\"'))return value;var result=new StringBuilder("\"");Int32 slash=0;foreach(Char c in value){if(c=='\\'){slash++;continue;}if(c=='\"'){result.Append('\\',slash*2+1);result.Append('\"');slash=0;continue;}result.Append('\\',slash);slash=0;result.Append(c);}result.Append('\\',slash*2);result.Append('\"');return result.ToString();}
 static String NormalizePath(String value){if(String.IsNullOrEmpty(value))throw new InvalidOperationException("profile path unavailable");String full=Path.GetFullPath(value).TrimEnd('\\','/');if(full.Length<3)throw new InvalidOperationException("profile path invalid");return full.ToUpperInvariant();}
 static String ProfilePathForSid(String sid){IntPtr text=IntPtr.Zero;try{Int32 status=GetAppContainerFolderPath(sid,out text);if(status!=0||text==IntPtr.Zero)throw new InvalidOperationException("AppContainer profile unavailable");return NormalizePath(Marshal.PtrToStringUni(text));}finally{if(text!=IntPtr.Zero)CoTaskMemFree(text);}}
 static String Sha256(String value){using(var hash=SHA256.Create()){return String.Concat(hash.ComputeHash(Encoding.UTF8.GetBytes(value)).Select(b=>b.ToString("x2")));}}
 static Boolean PhysicalDirectoryAncestry(String path){try{for(DirectoryInfo current=new DirectoryInfo(path);current!=null;current=current.Parent){if(!current.Exists||(current.Attributes&FileAttributes.ReparsePoint)!=0)return false;}return true;}catch{return false;}}

 const String PrivateNullEnvironmentName="AUTOPROMPT_PRIVATE_NUL_HANDLE";
 const UInt32 PrivateNullAccess=0x0012019f;
 // The locator carries no authority. Only the separately inherited, exact
 // owned device handle can supply read-EOF/discard-write access to the worker.
 static void VerifyPrivateNullHandle(IntPtr handle) {
  UInt32 flags;if(GetFileType(handle)!=2||!GetHandleInformation(handle,out flags)||(flags&HANDLE_FLAG_INHERIT)==0)throw new InvalidOperationException("WINDOWS_NULL_CAPABILITY_INVALID");
  IntPtr memory=Marshal.AllocHGlobal(512);
  try{
   // PUBLIC_OBJECT_BASIC_INFORMATION is fourteen 32-bit fields on both
   // supported architectures. Query its exact fixed size, unlike variable strings.
   const UInt32 basicLength=56;
   UInt32 returned;Int32 status=NtQueryObject(handle,0,memory,basicLength,out returned);
   UInt32 granted=status==0&&returned==basicLength?unchecked((UInt32)Marshal.ReadInt32(memory,4)):0;
   if(status!=0||returned!=basicLength||(granted&PrivateNullAccess)!=PrivateNullAccess)throw new InvalidOperationException("WINDOWS_NULL_CAPABILITY_ACCESS",new InvalidOperationException("NtQueryObjectBasic status:"+unchecked((UInt32)status).ToString("x8")+" returned:"+returned+" granted:"+granted.ToString("x8")));
   foreach(var query in new[]{new KeyValuePair<Int32,String>(2,"File"),new KeyValuePair<Int32,String>(1,@"\Device\Null")}){
    status=NtQueryObject(handle,query.Key,memory,512,out returned);
    Int32 header=Marshal.SizeOf(typeof(UNICODE_STRING));
    if(status!=0||returned<header||returned>512)throw new InvalidOperationException("WINDOWS_NULL_CAPABILITY_IDENTITY");
    var value=(UNICODE_STRING)Marshal.PtrToStructure(memory,typeof(UNICODE_STRING));
    Int64 offset=value.Buffer.ToInt64()-memory.ToInt64();
    if(value.Length!=query.Value.Length*2||value.MaximumLength<value.Length||offset<header||offset>(Int64)returned-value.Length||!String.Equals(Marshal.PtrToStringUni(value.Buffer,value.Length/2),query.Value,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("WINDOWS_NULL_CAPABILITY_IDENTITY");
   }
  }finally{Marshal.FreeHGlobal(memory);}
 }
 static String[] OwnedNullEnvironment(String[] entries,IntPtr handle) {
  if(entries==null||entries.Length>64||handle.ToInt64()<=0)throw new InvalidOperationException("WINDOWS_ENVIRONMENT_INVALID");
  foreach(String entry in entries){Int32 at=entry==null?-1:entry.IndexOf('=');if(at>0&&String.Equals(entry.Substring(0,at),PrivateNullEnvironmentName,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("WINDOWS_NULL_CAPABILITY_RESERVED");}
  return entries.Concat(new[]{PrivateNullEnvironmentName+"="+handle.ToInt64().ToString(IntPtr.Size==8?"x16":"x8",System.Globalization.CultureInfo.InvariantCulture)}).ToArray();
 }
 static void ValidateEnvironmentEntries(String[] entries,Int32 maximum) {
  if(entries==null||entries.Length>maximum)throw new InvalidOperationException("WINDOWS_ENVIRONMENT_INVALID");
  var seen=new HashSet<String>(StringComparer.OrdinalIgnoreCase);Int32 length=0;
  foreach(String entry in entries){Int32 at=entry==null?-1:entry.IndexOf('=');if(at<=0||entry.IndexOf('\0')>=0||!seen.Add(entry.Substring(0,at)))throw new InvalidOperationException("WINDOWS_ENVIRONMENT_INVALID");length+=entry.Length+1;}
  if(length>32760||!seen.Contains("SystemRoot"))throw new InvalidOperationException("WINDOWS_ENVIRONMENT_INVALID");
 }
 static IntPtr EnvironmentBlock(String[] entries) {
  ValidateEnvironmentEntries(entries,65);
  return Marshal.StringToHGlobalUni(String.Join("\0",entries.OrderBy(x=>x,StringComparer.OrdinalIgnoreCase))+"\0\0");
 }
 static Boolean ReadOutput(IntPtr pipe,MemoryStream output,ref Int32 total,Int32 bound) {
  for(;;){UInt32 available;if(!PeekNamedPipe(pipe,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)){if(Marshal.GetLastWin32Error()==ERROR_BROKEN_PIPE)return true;throw new Win32Exception(Marshal.GetLastWin32Error(),"PeekNamedPipe");}if(available==0)return true;
   UInt32 count=Math.Min(available,4096u);byte[] bytes=new byte[count];UInt32 read;if(!ReadFile(pipe,bytes,count,out read,IntPtr.Zero)){if(Marshal.GetLastWin32Error()==ERROR_BROKEN_PIPE)return true;throw new Win32Exception(Marshal.GetLastWin32Error(),"ReadFile");}if(total+(long)read>bound)return false;output.Write(bytes,0,(int)read);total+=(int)read;
  }
 }
 // CreateProcess requires LOCALAPPDATA in both the controller and explicit
 // child environment. Resolve the controller user's known folder instead of
 // trusting ambient or caller-provided values. This adds no filesystem grant.
 static String[] PrepareControllerProfileEnvironment(String[] entries){
  ValidateEnvironmentEntries(entries,64);
  foreach(String entry in entries)if(String.Equals(entry.Substring(0,entry.IndexOf('=')),PrivateNullEnvironmentName,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("WINDOWS_NULL_CAPABILITY_RESERVED");
  String local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
  if(String.IsNullOrEmpty(local)||local.Length>32700||!Path.IsPathRooted(local)||!String.Equals(Path.GetFullPath(local),local,StringComparison.OrdinalIgnoreCase)||!Directory.Exists(local))throw new InvalidOperationException("WINDOWS_CONTROLLER_PROFILE_UNAVAILABLE");
  String[] result=entries.Where(entry=>!String.Equals(entry.Substring(0,entry.IndexOf('=')),"LOCALAPPDATA",StringComparison.OrdinalIgnoreCase)).Concat(new[]{"LOCALAPPDATA="+local}).ToArray();
  ValidateEnvironmentEntries(result,64);
  Environment.SetEnvironmentVariable("LOCALAPPDATA",local,EnvironmentVariableTarget.Process);
  return result;
 }
 // Called only by the controller after validating its private deployment and
 // resource grants. No caller handles, network capabilities, or breakaway flag
 // are accepted. The executable remains open without write/delete sharing.
 public static LaunchResult Launch(String executable,String executableSha256,String[] arguments,String cwd,String[] environmentEntries,Int32 timeoutMs,Int32 outputLimit,IntPtr appSid,String expectedSid,String cancellationPath) {
  return Launch(executable,executableSha256,arguments,cwd,environmentEntries,timeoutMs,outputLimit,appSid,expectedSid,cancellationPath,null);
 }
 public static LaunchResult Launch(String executable,String executableSha256,String[] arguments,String cwd,String[] environmentEntries,Int32 timeoutMs,Int32 outputLimit,IntPtr appSid,String expectedSid,String cancellationPath,MsysNamespaceRequest msysRuntime) {
  lock(undrainedNamespaces){if(undrainedNamespaces.Count!=0)throw new InvalidOperationException("APPCONTAINER_CLEANUP_UNCONFIRMED");}
  if(arguments==null||arguments.Length>256||arguments.Any(x=>x==null||x.IndexOf('\0')>=0)||timeoutMs<1||timeoutMs>300000||outputLimit<1||outputLimit>1048576||Sid(appSid)!=expectedSid)throw new InvalidOperationException("WINDOWS_LAUNCH_INVALID");
  environmentEntries=PrepareControllerProfileEnvironment(environmentEntries);
  var command=new StringBuilder(String.Join(" ",(new[]{executable}).Concat(arguments).Select(Quote)));if(command.Length>32760)throw new InvalidOperationException("WINDOWS_COMMAND_LIMIT");
  IntPtr size=IntPtr.Zero,list=IntPtr.Zero,caps=IntPtr.Zero,job=IntPtr.Zero,limit=IntPtr.Zero,environment=IntPtr.Zero,stdoutRead=IntPtr.Zero,stdoutWrite=IntPtr.Zero,stderrRead=IntPtr.Zero,stderrWrite=IntPtr.Zero,nulRead=IntPtr.Zero,privateNull=IntPtr.Zero,handleList=IntPtr.Zero;PROCESS_INFORMATION pi=new PROCESS_INFORMATION();Boolean assigned=false,confirmedDrain=true;ImageBinding imageBinding=null;MsysNamespaceLease namespaceLease=null;
  try {
   InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);if(size==IntPtr.Zero)throw new InvalidOperationException("attribute-list size");list=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(list,2,0,ref size),"InitializeProcThreadAttributeList");
   var security=new SECURITY_CAPABILITIES{AppContainerSid=appSid,Capabilities=IntPtr.Zero,CapabilityCount=0,Reserved=0};int capsSize=Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));caps=Marshal.AllocHGlobal(capsSize);Marshal.StructureToPtr(security,caps,false);Check(UpdateProcThreadAttribute(list,0,(IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,caps,(IntPtr)capsSize,IntPtr.Zero,IntPtr.Zero),"security-capabilities");
   var inherit=new SECURITY_ATTRIBUTES{nLength=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),inherit=true};Check(CreatePipe(out stdoutRead,out stdoutWrite,ref inherit,0),"stdout-pipe");Check(CreatePipe(out stderrRead,out stderrWrite,ref inherit,0),"stderr-pipe");Check(SetHandleInformation(stdoutRead,HANDLE_FLAG_INHERIT,0),"stdout-private");Check(SetHandleInformation(stderrRead,HANDLE_FLAG_INHERIT,0),"stderr-private");
   nulRead=CreateFile("NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,ref inherit,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);if(nulRead==new IntPtr(-1)){nulRead=IntPtr.Zero;throw new Win32Exception(Marshal.GetLastWin32Error(),"stdin-nul");}
   privateNull=CreateFile("NUL",PrivateNullAccess,FILE_SHARE_READ|FILE_SHARE_WRITE,ref inherit,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);if(privateNull==new IntPtr(-1)){privateNull=IntPtr.Zero;throw new Win32Exception(Marshal.GetLastWin32Error(),"private-nul");}
   VerifyPrivateNullHandle(privateNull);
   handleList=Marshal.AllocHGlobal(IntPtr.Size*4);Marshal.WriteIntPtr(handleList,0,nulRead);Marshal.WriteIntPtr(handleList,IntPtr.Size,stdoutWrite);Marshal.WriteIntPtr(handleList,IntPtr.Size*2,stderrWrite);Marshal.WriteIntPtr(handleList,IntPtr.Size*3,privateNull);Check(UpdateProcThreadAttribute(list,0,(IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handleList,(IntPtr)(IntPtr.Size*4),IntPtr.Zero,IntPtr.Zero),"owned-handle-list");
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateJobObject");var limits=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;int limitSize=Marshal.SizeOf(limits);limit=Marshal.AllocHGlobal(limitSize);Marshal.StructureToPtr(limits,limit,false);Check(SetInformationJobObject(job,JobObjectExtendedLimitInformation,limit,(UInt32)limitSize),"job-kill-on-close");
   imageBinding=new ImageBinding(executable,executableSha256);environment=EnvironmentBlock(OwnedNullEnvironment(environmentEntries,privateNull));var startup=new STARTUPINFOEX();startup.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=nulRead;startup.StartupInfo.hStdOutput=stdoutWrite;startup.StartupInfo.hStdError=stderrWrite;startup.AttributeList=list;
   namespaceLease=CreateMsysNamespaceLease(executable,msysRuntime,expectedSid);
   Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,environment,cwd,ref startup,out pi),"CreateProcess-suspended");
   confirmedDrain=false;
   Check(CloseHandle(stdoutWrite),"stdout-close-parent-write");stdoutWrite=IntPtr.Zero;Check(CloseHandle(stderrWrite),"stderr-close-parent-write");stderrWrite=IntPtr.Zero;Check(CloseHandle(nulRead),"stdin-close-parent-read");nulRead=IntPtr.Zero;Check(CloseHandle(privateNull),"private-nul-close-parent");privateNull=IntPtr.Zero;
   Check(AssignProcessToJobObject(job,pi.hProcess),"AssignProcessToJobObject");assigned=true;VerifyAppContainerTokenAndJob(pi.hProcess,expectedSid,job,true);VerifyRootImage(pi.hProcess,imageBinding);if((String.IsNullOrEmpty(cancellationPath)||!File.Exists(cancellationPath))&&ResumeThread(pi.hThread)==UInt32.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread");CloseHandle(pi.hThread);pi.hThread=IntPtr.Zero;
   using(var stdout=new MemoryStream())using(var stderr=new MemoryStream()){
    var clock=Stopwatch.StartNew();int total=0,members=1;bool timedOut=false,limited=false,cancelled=false;
    for(;;){if(!String.IsNullOrEmpty(cancellationPath)&&File.Exists(cancellationPath)){cancelled=true;break;}if(!ReadOutput(stdoutRead,stdout,ref total,outputLimit)||!ReadOutput(stderrRead,stderr,ref total,outputLimit)){limited=true;break;}uint wait=WaitForSingleObject(pi.hProcess,0);if(wait==0)break;if(wait==UInt32.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error(),"WaitForSingleObject");if(clock.ElapsedMilliseconds>=timeoutMs){timedOut=true;break;}members=Math.Max(members,VerifyMembers(job,expectedSid));System.Threading.Thread.Sleep(25);}
    // Root exit never transfers detached descendants to the host. Terminate and
    // positively drain the entire owned job before returning any result.
    if(Active(job)>0)Check(TerminateJobObject(job,125),"TerminateJobObject");if(!Drain(job,5000))throw new InvalidOperationException("APPCONTAINER_CLEANUP_UNCONFIRMED");confirmedDrain=true;
    if(!ReadOutput(stdoutRead,stdout,ref total,outputLimit)||!ReadOutput(stderrRead,stderr,ref total,outputLimit))limited=true;
    UInt32 exit;Check(GetExitCodeProcess(pi.hProcess,out exit),"GetExitCodeProcess");return new LaunchResult{RootPid=pi.dwProcessId,ExitCode=exit,ObservedJobMembers=members,LauncherSessionId=Process.GetCurrentProcess().SessionId,AppContainerSid=expectedSid,RootImageMatches=true,Drained=true,TimedOut=timedOut,OutputLimit=limited,Cancelled=cancelled,StdoutBase64=Convert.ToBase64String(stdout.ToArray()),StderrBase64=Convert.ToBase64String(stderr.ToArray())};
   }
  } catch {
   bool drained=true;if(assigned&&job!=IntPtr.Zero){try{if(Active(job)>0&&!TerminateJobObject(job,125))drained=false;if(!Drain(job,5000))drained=false;}catch{drained=false;}}else if(pi.hProcess!=IntPtr.Zero){try{if(!TerminateProcess(pi.hProcess,125)||WaitForSingleObject(pi.hProcess,5000)!=0)drained=false;}catch{drained=false;}}confirmedDrain=drained;if(!drained)throw new InvalidOperationException("APPCONTAINER_CLEANUP_UNCONFIRMED");throw;
  } finally {
   if(pi.hThread!=IntPtr.Zero)CloseHandle(pi.hThread);if(pi.hProcess!=IntPtr.Zero)CloseHandle(pi.hProcess);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(limit!=IntPtr.Zero)Marshal.FreeHGlobal(limit);if(job!=IntPtr.Zero)CloseHandle(job);
   if(namespaceLease!=null){if(confirmedDrain)namespaceLease.Dispose();else lock(undrainedNamespaces){undrainedNamespaces.Add(namespaceLease);}}
   if(caps!=IntPtr.Zero)Marshal.FreeHGlobal(caps);if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}if(imageBinding!=null)imageBinding.Dispose();foreach(IntPtr handle in new[]{stdoutRead,stdoutWrite,stderrRead,stderrWrite,nulRead,privateNull})if(handle!=IntPtr.Zero)CloseHandle(handle);if(handleList!=IntPtr.Zero)Marshal.FreeHGlobal(handleList);
  }
 }
}
