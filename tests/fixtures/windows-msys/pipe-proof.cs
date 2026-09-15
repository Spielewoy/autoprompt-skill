// Observational Windows fixture: it does not certify Git Bash compatibility.
// Keep the signal-pipe flags aligned with MSYS fhandler_pipe::create.
using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

public static class MsysPipeProof {
 [StructLayout(LayoutKind.Sequential)] struct SA { public Int32 Length; public IntPtr Descriptor; public Int32 Inherit; }
 [StructLayout(LayoutKind.Sequential)] struct US { public UInt16 Length,MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct OA { public Int32 Length; public IntPtr RootDirectory,ObjectName; public UInt32 Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public IntPtr Status,Information; }
 [DllImport("ntdll.dll")] static extern Int32 NtFsControlFile(IntPtr handle,IntPtr signal,IntPtr apc,IntPtr context,IntPtr io,UInt32 control,IntPtr input,UInt32 inputLength,IntPtr output,UInt32 outputLength);
 [DllImport("ntdll.dll")] static extern Int32 NtCancelIoFileEx(IntPtr handle,IntPtr requestIo,IntPtr cancelIo);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateEventW(IntPtr attributes,Boolean manualReset,Boolean initialState,String name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UInt32 WaitForSingleObject(IntPtr handle,UInt32 milliseconds);
 [DllImport("ntdll.dll")] static extern Int32 NtQueryObject(IntPtr handle,Int32 information,IntPtr buffer,Int32 length,out UInt32 returned);
 [DllImport("ntdll.dll")] static extern Int32 NtOpenFile(out IntPtr handle,UInt32 access,ref OA attributes,out IO io,UInt32 share,UInt32 options);
 [DllImport("ntdll.dll")] static extern Int32 NtCreateNamedPipeFile(out IntPtr handle,UInt32 access,ref OA attributes,out IO io,UInt32 share,UInt32 disposition,UInt32 options,UInt32 type,UInt32 readMode,UInt32 completionMode,UInt32 instances,UInt32 inbound,UInt32 outbound,ref Int64 timeout);
 [DllImport("ntdll.dll")] static extern UInt32 RtlNtStatusToDosError(Int32 status);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateNamedPipeW(String name,UInt32 openMode,UInt32 pipeMode,UInt32 instances,UInt32 outSize,UInt32 inSize,UInt32 timeout,ref SA attributes);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(String name,UInt32 access,UInt32 share,ref SA attributes,UInt32 disposition,UInt32 flags,IntPtr template);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Boolean ConvertStringSecurityDescriptorToSecurityDescriptor(String text,UInt32 revision,out IntPtr descriptor,out UInt32 size);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean OpenProcessToken(IntPtr process,UInt32 access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern Boolean GetTokenInformation(IntPtr token,Int32 information,out Int32 value,UInt32 length,out UInt32 returned);
 [DllImport("kernel32.dll")] static extern Boolean CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 static readonly IntPtr Invalid = new IntPtr(-1);
 static void Require(Boolean condition,String reason){if(!condition)throw new InvalidOperationException(reason);}
 static Boolean Valid(IntPtr handle){return handle!=IntPtr.Zero&&handle!=Invalid;}
 sealed class Attributes : IDisposable {
  IntPtr text,name;public OA Value;
  public Attributes(String value,IntPtr root,IntPtr descriptor){text=Marshal.StringToHGlobalUni(value);var unicode=new US{Length=checked((UInt16)(value.Length*2)),MaximumLength=checked((UInt16)(value.Length*2+2)),Buffer=text};name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));Marshal.StructureToPtr(unicode,name,false);Value=new OA{Length=Marshal.SizeOf(typeof(OA)),RootDirectory=root,ObjectName=name,SecurityDescriptor=descriptor};}
  public void Dispose(){Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(text);}
 }
 static String NtStatus(Int32? status){return status.HasValue?"{\"status\":\""+unchecked((UInt32)status.Value).ToString("X8")+"\",\"win32Error\":"+RtlNtStatusToDosError(status.Value)+"}":"null";}
 // Fixed-size, single-call query: never log a partial/unvalidated kernel name.
 // These names belong only to this fixture's held, randomly named listener.
 static Int32 QueryOwnedPipeName(IntPtr handle,String suffix,out String name){
  name=null;const Int32 capacity=4096;IntPtr buffer=Marshal.AllocHGlobal(capacity);
  try{UInt32 returned;Int32 status=NtQueryObject(handle,1,buffer,capacity,out returned);
   if(status<0)return status;
   Int32 header=Marshal.SizeOf(typeof(US));Require(returned>=header&&returned<=capacity,"pipe-name-query-size");
   US value=(US)Marshal.PtrToStructure(buffer,typeof(US));
   Require(value.Length>0&&value.Length%2==0&&value.Length<=1024&&value.MaximumLength>=value.Length,"pipe-name-query-length");
   Int64 offset=value.Buffer.ToInt64()-buffer.ToInt64();Require(offset>=header&&offset<=returned&&value.Length<=returned-offset,"pipe-name-query-pointer");
   String candidate=Marshal.PtrToStringUni(value.Buffer,value.Length/2);
   Require(candidate.StartsWith(@"\Device\NamedPipe\",StringComparison.OrdinalIgnoreCase)&&candidate.EndsWith("\\"+suffix,StringComparison.Ordinal),"pipe-name-query-ownership");
   // Restrict to a bounded NPFS namespace, never arbitrary paths or controls.
   Require(candidate.All(c=>(c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='\\'||c=='-'||c=='_'||c=='.'||c=='{'||c=='}'),"pipe-name-query-characters");
   Require(!candidate.Split('\\').Any(part=>part=="."||part==".."),"pipe-name-query-components");
   name=candidate;return status;
  }finally{Marshal.FreeHGlobal(buffer);}
 }
 static String JsonPipeName(String name){return name==null?"null":"\""+name.Replace("\\","\\\\")+"\"";}
 // FILE_PIPE_WAIT_FOR_BUFFER: native LARGE_INTEGER, ULONG, BOOLEAN, then
 // WCHAR Name[1]. MS-FSCC 2.3.49 specifies the intervening padding byte;
 // pinned MSYS local_includes/ntdll.h uses this same declaration. Derive
 // offsets from the declaration and assert the ABI instead of packing it.
 [StructLayout(LayoutKind.Sequential)] struct PipeWaitHeader { public Int64 Timeout; public UInt32 NameLength; public Byte TimeoutSpecified; public UInt16 Name; }
 static Byte[] PipeWaitBuffer(String relative){
  Require(!String.IsNullOrEmpty(relative)&&relative.Length<=512&&!relative.StartsWith("\\",StringComparison.Ordinal)&&
   relative.All(c=>(c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='\\'||c=='-'||c=='_'||c=='.'||c=='{'||c=='}')&&
   !relative.Split('\\').Any(part=>part.Length==0||part=="."||part==".."),"flat-wait-name");
  Int32 timeoutOffset=Marshal.OffsetOf(typeof(PipeWaitHeader),"Timeout").ToInt32(),lengthOffset=Marshal.OffsetOf(typeof(PipeWaitHeader),"NameLength").ToInt32(),specifiedOffset=Marshal.OffsetOf(typeof(PipeWaitHeader),"TimeoutSpecified").ToInt32(),nameOffset=Marshal.OffsetOf(typeof(PipeWaitHeader),"Name").ToInt32();
  Require(timeoutOffset==0&&lengthOffset==8&&specifiedOffset==12&&nameOffset==14&&BitConverter.IsLittleEndian,"flat-wait-layout");
  Byte[] name=Encoding.Unicode.GetBytes(relative),buffer=new Byte[nameOffset+name.Length];
  // Native relative time is in 100ns units: -500000 is exactly 50ms.
  // See pinned MSYS fhandler/fifo.cc's negative 100ms pipe-wait timeout.
  Buffer.BlockCopy(BitConverter.GetBytes(-500000L),0,buffer,timeoutOffset,8);
  Buffer.BlockCopy(BitConverter.GetBytes((UInt32)name.Length),0,buffer,lengthOffset,4);
  buffer[specifiedOffset]=1;Buffer.BlockCopy(name,0,buffer,nameOffset,name.Length);return buffer;
 }
 // A failed cancellation never licenses freeing an outstanding request.
 // This single slot intentionally has no finalizer: the process stops after
 // uncertainty, retaining every request allocation and the borrowed root.
 static PipeWaitLease RetainedPipeWait;
 static Boolean IsRetainedPipeRoot(IntPtr root){return RetainedPipeWait!=null&&RetainedPipeWait.Root==root;}
 static String JsonUInt(UInt32? value){return value.HasValue?value.Value.ToString(System.Globalization.CultureInfo.InvariantCulture):"null";}
 sealed class PipeWaitLease {
  public IntPtr Root,Input,RequestIo,CancelIo,Signal;
  public Boolean Submitted,Drained,CancelPending,WatchdogExpired;
  public Int32? Submission,Completion,Cancellation;
  public UInt32? InitialWait,DrainWait,InitialWaitError,DrainWaitError;
  public readonly System.Diagnostics.Stopwatch Clock=System.Diagnostics.Stopwatch.StartNew();
  public String Report(){return "{\"submission\":"+NtStatus(Submission)+",\"completion\":"+NtStatus(Completion)+",\"cancellation\":"+NtStatus(Cancellation)+",\"initialWait\":"+JsonUInt(InitialWait)+",\"drainWait\":"+JsonUInt(DrainWait)+",\"initialWaitError\":"+JsonUInt(InitialWaitError)+",\"drainWaitError\":"+JsonUInt(DrainWaitError)+",\"watchdogExpired\":"+(WatchdogExpired?"true":"false")+",\"drained\":"+(Drained?"true":"false")+",\"elapsedMs\":"+Clock.ElapsedMilliseconds+",\"timeoutMs\":50}";}
  public void Release(){
   if(Submitted&&(!Drained||CancelPending)){RetainedPipeWait=this;return;}
   Boolean closed=!Valid(Signal)||CloseHandle(Signal);Signal=IntPtr.Zero;
   if(Input!=IntPtr.Zero){Marshal.FreeHGlobal(Input);Input=IntPtr.Zero;}
   if(RequestIo!=IntPtr.Zero){Marshal.FreeHGlobal(RequestIo);RequestIo=IntPtr.Zero;}
   if(CancelIo!=IntPtr.Zero){Marshal.FreeHGlobal(CancelIo);CancelIo=IntPtr.Zero;}
   Require(closed,"close-flat-wait-event");
  }
 }
 static IntPtr NewPipeWaitIo(){
  Int32 size=Marshal.SizeOf(typeof(IO));Require(size==IntPtr.Size*2,"flat-wait-io-layout");
  IntPtr value=Marshal.AllocHGlobal(size);Marshal.Copy(new Byte[size],0,value,size);
  Marshal.WriteInt32(value,0x103);return value;
 }
 static String ProbePipeWait(IntPtr asynchronousRoot,String relative){
  Require(RetainedPipeWait==null,"prior-flat-wait-undrained");
  Byte[] input=PipeWaitBuffer(relative);var lease=new PipeWaitLease{Root=asynchronousRoot};
  try{
   lease.Input=Marshal.AllocHGlobal(input.Length);Marshal.Copy(input,0,lease.Input,input.Length);
   lease.RequestIo=NewPipeWaitIo();lease.CancelIo=NewPipeWaitIo();
   lease.Signal=CreateEventW(IntPtr.Zero,true,false,null);Require(Valid(lease.Signal),"flat-wait-event:"+Marshal.GetLastWin32Error());
   // Asynchronous root + explicit event: no managed array or out/ref stack
   // storage can be reclaimed while NtFsControlFile owns a pending request.
   lease.Submitted=true;
   lease.Submission=NtFsControlFile(asynchronousRoot,lease.Signal,IntPtr.Zero,IntPtr.Zero,lease.RequestIo,0x110018,lease.Input,(UInt32)input.Length,IntPtr.Zero,0);
   if(lease.Submission.Value==0x103){
    lease.InitialWait=WaitForSingleObject(lease.Signal,2000);
    if(lease.InitialWait.Value!=0){
     lease.WatchdogExpired=lease.InitialWait.Value==258;
     if(lease.InitialWait.Value==UInt32.MaxValue)lease.InitialWaitError=unchecked((UInt32)Marshal.GetLastWin32Error());
     // Exact request identity, never cancellation of unrelated root I/O.
     lease.Cancellation=NtCancelIoFileEx(asynchronousRoot,lease.RequestIo,lease.CancelIo);
     lease.CancelPending=lease.Cancellation.Value==0x103||(lease.Cancellation.Value>=0&&Marshal.ReadInt32(lease.CancelIo)==0x103);
     lease.DrainWait=WaitForSingleObject(lease.Signal,2000);
     if(lease.DrainWait.Value==UInt32.MaxValue)lease.DrainWaitError=unchecked((UInt32)Marshal.GetLastWin32Error());
     if(lease.DrainWait.Value!=0)throw new InvalidOperationException("flat-wait-undrained:"+lease.Report());
    }
    // Event completion is the memory/lifetime barrier; cancellation success
    // or STATUS_NOT_FOUND alone never proves that the original I/O is done.
    lease.Completion=Marshal.ReadInt32(lease.RequestIo);
    if(lease.Completion.Value==0x103)throw new InvalidOperationException("flat-wait-pending-after-event:"+lease.Report());
    lease.Drained=true;
   }else if(lease.Submission.Value<0){
    // An immediate failing return did not leave an outstanding request.
    lease.Completion=lease.Submission;lease.Drained=true;
   }else{
    lease.Completion=Marshal.ReadInt32(lease.RequestIo);
    if(lease.Completion.Value==0x103)throw new InvalidOperationException("flat-wait-inconsistent-completion:"+lease.Report());
    lease.Drained=true;
   }
   if(lease.CancelPending)throw new InvalidOperationException("flat-wait-cancel-incomplete:"+lease.Report());
   Require(lease.Clock.ElapsedMilliseconds<=15000,"flat-wait-result-bound");
   return lease.Report();
  }finally{lease.Release();}
 }
 static String ProbeFlatRoot(String parent,String user,String package){
  const String npfs=@"\Device\NamedPipe\";
  Require(parent.StartsWith(npfs,StringComparison.OrdinalIgnoreCase)&&parent.EndsWith("\\",StringComparison.Ordinal)&&parent.Length<=512,"flat-parent");
  String suffix="autoprompt-msys-proof-"+Guid.NewGuid().ToString("N"),relative=parent.Substring(npfs.Length)+suffix,name=null;
  Require(relative.Length<=512&&parent.Length+suffix.Length<=512,"flat-name-bound");
  Int32? rootStatus=null,serverStatus=null,clientStatus=null,query=null;String beforeClient="null",afterClient="null";
  IntPtr root=IntPtr.Zero,server=IntPtr.Zero,client=IntPtr.Zero,descriptor=IntPtr.Zero;
  try{IO io;using(var attributes=new Attributes(npfs,IntPtr.Zero,IntPtr.Zero))rootStatus=NtOpenFile(out root,0x100080,ref attributes.Value,out io,3,0);
   if(rootStatus.Value>=0){
    Require(Valid(root),"flat-root-empty");UInt32 size;
    Require(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;"+user+")(A;;GA;;;SY)(A;;GA;;;"+package+")",1,out descriptor,out size),"flat-pipe-descriptor");
    using(var attributes=new Attributes(relative,root,descriptor)){
     Int64 timeout=-500000;serverStatus=NtCreateNamedPipeFile(out server,0x80100100,ref attributes.Value,out io,3,2,0x20,1,0,0,1,8192,8192,ref timeout);
     if(serverStatus.Value>=0){
      Require(Valid(server),"flat-server-empty");
      // These are observations, not a claim that an un-listened server is
      // already available. Each request explicitly allows only 50ms.
      beforeClient=ProbePipeWait(root,relative);
      clientStatus=NtOpenFile(out client,0x40100080,ref attributes.Value,out io,0,0);
      if(clientStatus.Value>=0){
       Require(Valid(client),"flat-client-empty");afterClient=ProbePipeWait(root,relative);
       query=QueryOwnedPipeName(server,suffix,out name);
       if(query.Value>=0)Require(String.Equals(name,parent+suffix,StringComparison.Ordinal),"flat-query-name-mismatch");
      }
     }
    }
   }
   return "{\"root\":"+NtStatus(rootStatus)+",\"server\":"+NtStatus(serverStatus)+",\"client\":"+NtStatus(clientStatus)+",\"query\":"+NtStatus(query)+",\"name\":"+JsonPipeName(name)+",\"relativeName\":"+JsonPipeName(relative)+",\"beforeClient\":"+beforeClient+",\"afterClient\":"+afterClient+"}";
  }finally{Boolean closed=true;if(Valid(client))closed=CloseHandle(client)&&closed;if(Valid(server))closed=CloseHandle(server)&&closed;if(Valid(root)&&!IsRetainedPipeRoot(root))closed=CloseHandle(root)&&closed;if(descriptor!=IntPtr.Zero)LocalFree(descriptor);Require(closed,"close-flat-handles");}
 }
 static String ProbeExpandedRoot(IntPtr firstServer,String firstSuffix,String user,String package,Boolean flatProof){
  String name,parent=null,relativeName=null,flat="null";Int32 query=QueryOwnedPipeName(firstServer,firstSuffix,out name);
  Int32? rootStatus=null,serverStatus=null,clientStatus=null,relativeQuery=null;
  IntPtr root=IntPtr.Zero,server=IntPtr.Zero,client=IntPtr.Zero,descriptor=IntPtr.Zero;
  try{
   if(query>=0){
    // The exact owned listener remains held while deriving/opening its parent.
    parent=name.Substring(0,name.Length-firstSuffix.Length);
    if(flatProof)flat=ProbeFlatRoot(parent,user,package);
    IO io;using(var attributes=new Attributes(parent,IntPtr.Zero,IntPtr.Zero))rootStatus=NtOpenFile(out root,0x100080,ref attributes.Value,out io,3,0);
    if(rootStatus.Value>=0){
     Require(Valid(root),"expanded-root-empty");UInt32 size;
     Require(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;"+user+")(A;;GA;;;SY)(A;;GA;;;"+package+")",1,out descriptor,out size),"expanded-pipe-descriptor");
     String suffix="autoprompt-msys-proof-"+Guid.NewGuid().ToString("N");
     using(var attributes=new Attributes(suffix,root,descriptor)){
      Int64 timeout=-500000;serverStatus=NtCreateNamedPipeFile(out server,0x80100100,ref attributes.Value,out io,3,2,0x20,1,0,0,1,8192,8192,ref timeout);
      if(serverStatus.Value>=0){
       Require(Valid(server),"expanded-server-empty");
       clientStatus=NtOpenFile(out client,0x40100080,ref attributes.Value,out io,0,0);
       if(clientStatus.Value>=0){
        Require(Valid(client),"expanded-client-empty");
        relativeQuery=QueryOwnedPipeName(server,suffix,out relativeName);
        if(relativeQuery.Value>=0)Require(String.Equals(relativeName,parent+suffix,StringComparison.Ordinal),"expanded-relative-name-mismatch");
       }
      }
     }
    }
   }
   return "{\"query\":"+NtStatus(query)+",\"name\":"+JsonPipeName(name)+",\"parent\":"+JsonPipeName(parent)+",\"root\":"+NtStatus(rootStatus)+",\"server\":"+NtStatus(serverStatus)+",\"client\":"+NtStatus(clientStatus)+",\"relativeQuery\":"+NtStatus(relativeQuery)+",\"relativeName\":"+JsonPipeName(relativeName)+",\"flat\":"+flat+"}";
  }finally{if(Valid(client))Require(CloseHandle(client),"close-expanded-client");if(Valid(server))Require(CloseHandle(server),"close-expanded-server");if(Valid(root))Require(CloseHandle(root),"close-expanded-root");if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
 }
 static String ProbeNt(String user,String package,Boolean controller){
  var output=new StringBuilder("[");Int32 count=0;
  foreach(Boolean local in new[]{false,true}){
   IntPtr root=IntPtr.Zero,server=IntPtr.Zero,client=IntPtr.Zero,descriptor=IntPtr.Zero;Int32 rootStatus;Int32? serverStatus=null,clientStatus=null;
   try{IO io;using(var attributes=new Attributes(@"\Device\NamedPipe\"+(local?@"LOCAL\":""),IntPtr.Zero,IntPtr.Zero))rootStatus=NtOpenFile(out root,0x100080,ref attributes.Value,out io,3,0);
    if(rootStatus>=0){Require(Valid(root),"NT-root-empty");UInt32 size;Require(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;"+user+")(A;;GA;;;SY)(A;;GA;;;"+package+")",1,out descriptor,out size),"NT-pipe-descriptor");using(var attributes=new Attributes("autoprompt-msys-proof-"+Guid.NewGuid().ToString("N"),root,descriptor)){
     // MSYS ordinary-pipe path: relative name under its held NPFS root,
     // FILE_CREATE, synchronous inbound server; never retry ACCESS_DENIED.
     Int64 timeout=-500000;serverStatus=NtCreateNamedPipeFile(out server,0x80100100,ref attributes.Value,out io,3,2,0x20,1,0,0,1,8192,8192,ref timeout);
     if(serverStatus.Value>=0){Require(Valid(server),"NT-server-empty");clientStatus=NtOpenFile(out client,0x40100080,ref attributes.Value,out io,0,0);if(clientStatus.Value>=0)Require(Valid(client),"NT-client-empty");}
    }}
    if(controller&&!local)Require(rootStatus>=0&&serverStatus.HasValue&&serverStatus.Value>=0&&clientStatus.HasValue&&clientStatus.Value>=0,"controller-NT-control:"+NtStatus(rootStatus)+":"+NtStatus(serverStatus)+":"+NtStatus(clientStatus));
    if(count++>0)output.Append(',');output.Append("{\"namespace\":\"").Append(local?"local":"bare").Append("\",\"root\":").Append(NtStatus(rootStatus)).Append(",\"server\":").Append(NtStatus(serverStatus)).Append(",\"client\":").Append(NtStatus(clientStatus)).Append('}');
   }finally{if(Valid(client))Require(CloseHandle(client),"close-NT-client");if(Valid(server))Require(CloseHandle(server),"close-NT-server");if(Valid(root))Require(CloseHandle(root),"close-NT-root");if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
  }return output.Append(']').ToString();
 }
 static Boolean IsAppContainer(){IntPtr token;Require(OpenProcessToken(new IntPtr(-1),8,out token),"open-token:"+Marshal.GetLastWin32Error());try{Int32 value;UInt32 returned;Require(GetTokenInformation(token,29,out value,4,out returned)&&returned==4,"query-token:"+Marshal.GetLastWin32Error());Require(value==0||value==1,"invalid-token-value");return value==1;}finally{CloseHandle(token);}}
 static String Hash(String file){using(var stream=File.OpenRead(file))using(var hash=SHA256.Create())return String.Concat(hash.ComputeHash(stream).Select(b=>b.ToString("x2")));}
 static String Probe(String user,String package,Boolean requireSuccess){
  var output=new StringBuilder("[");Int32 count=0;
  foreach(Boolean local in new[]{false,true})foreach(String variant in new[]{"world","user","package"}){
   // The user cell models sec_user_nih: current/saved user (identical in
   // this fixture), Administrators and SYSTEM, with no protected-DACL bit.
   // The package cell grants only that user, SYSTEM and this exact profile.
   String sddl=variant=="world"?"D:(A;;GA;;;WD)":"D:(A;;GA;;;"+user+")(A;;GA;;;SY)"+(variant=="package"?"(A;;GA;;;"+package+")":"(A;;GA;;;BA)");
   IntPtr descriptor=IntPtr.Zero,server=IntPtr.Zero,client=IntPtr.Zero;Int32 serverError=0;Int32? clientError=null;String expanded="null";
   try{UInt32 size;Require(ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out descriptor,out size),"pipe-descriptor:"+Marshal.GetLastWin32Error());var attributes=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=descriptor,Inherit=0};
    String suffix="autoprompt-msys-proof-"+Guid.NewGuid().ToString("N");
    String name=@"\\.\pipe\"+(local?@"LOCAL\":"")+suffix;
    // PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE; message pipe,
    // byte read mode, remote clients rejected, one instance, no retry.
    server=CreateNamedPipeW(name,0x80001,0x0c,1,8192,8192,0,ref attributes);
    if(!Valid(server))serverError=Marshal.GetLastWin32Error();
    else{
     // MSYS opens its write end with GENERIC_WRITE | FILE_READ_ATTRIBUTES.
     // Opening the sole owned listener does not wait for another process.
     client=CreateFileW(name,0x40000080,0,ref attributes,3,0,IntPtr.Zero);
     clientError=Valid(client)?0:Marshal.GetLastWin32Error();
     // Query only a connected, wholly owned pair. A denied client leaves
     // this extra observation untouched rather than querying an orphan listener.
     if(local&&Valid(client))expanded=ProbeExpandedRoot(server,suffix,user,package,variant=="package");
    }
    Require(Valid(server)||serverError!=0,"server-failure-without-error");
    Require(!clientError.HasValue||Valid(client)||clientError.Value!=0,"client-failure-without-error");
    if(requireSuccess)Require(Valid(server)&&Valid(client),"controller-pipe-control:"+(local?"local":"bare")+":"+variant+":"+serverError+":"+clientError);
    if(count++>0)output.Append(',');output.Append("{\"namespace\":\"").Append(local?"local":"bare").Append("\",\"descriptor\":\"").Append(variant).Append("\",\"serverError\":").Append(serverError).Append(",\"clientError\":").Append(clientError.HasValue?clientError.Value.ToString(System.Globalization.CultureInfo.InvariantCulture):"null").Append(",\"expanded\":").Append(expanded).Append('}');
   }finally{if(Valid(client))Require(CloseHandle(client),"close-client");if(Valid(server))Require(CloseHandle(server),"close-server");if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
  }return output.Append(']').ToString();
 }
 // Protect the child file before removing directory inheritance, preserving
 // its current owner rights throughout the fixture-only ACL transition.
 static void GrantFixture(String directory,String executable,String package){var user=WindowsIdentity.GetCurrent().User;var ds=new DirectorySecurity();ds.SetOwner(user);ds.SetAccessRuleProtection(true,false);foreach(String sid in new[]{user.Value,"S-1-5-18",package})ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));var fs=new FileSecurity();fs.SetOwner(user);fs.SetAccessRuleProtection(true,false);foreach(String sid in new[]{user.Value,"S-1-5-18",package})fs.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),sid==package?FileSystemRights.ReadAndExecute:FileSystemRights.FullControl,AccessControlType.Allow));new FileInfo(executable).SetAccessControl(fs);new DirectoryInfo(directory).SetAccessControl(ds);}
 // Use the same bounded Windows essentials as the production launcher.
 // LOCALAPPDATA is resolved through Windows and grants no filesystem access.
 static String[] FixtureEnvironment(){String root=Environment.GetEnvironmentVariable("SystemRoot");Require(!String.IsNullOrEmpty(root)&&root.Length>=3&&root.Length<=32700&&root[1]==':'&&root[2]=='\\',"fixture-system-root");String local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);Require(!String.IsNullOrEmpty(local)&&local.Length<=32700&&Path.IsPathRooted(local)&&String.Equals(Path.GetFullPath(local),local,StringComparison.OrdinalIgnoreCase)&&Directory.Exists(local),"fixture-local-application-data-unavailable");return new[]{"SystemRoot="+root,"WINDIR="+root,"SystemDrive="+root.Substring(0,2),"PATH="+Path.Combine(root,"System32"),"LOCALAPPDATA="+local};}
 static void ReportFailure(Exception error){Console.Error.WriteLine(error);Int32 depth=0;for(Exception current=error;current!=null&&depth<8;current=current.InnerException,depth++){var native=current as System.ComponentModel.Win32Exception;if(native!=null)Console.Error.WriteLine("fixture-native-error depth="+depth+" code="+native.NativeErrorCode+" message="+new System.ComponentModel.Win32Exception(native.NativeErrorCode).Message);}}
 public static Int32 Main(String[] args){try{
  if(args.Length==3&&args[0]=="child"){Require(IsAppContainer(),"child-is-not-AppContainer");Require(WindowsIdentity.GetCurrent().User.Value==args[1],"child-user-mismatch");Console.Write("{\"appContainer\":true,\"cases\":"+Probe(args[1],args[2],false)+",\"ntRoots\":"+ProbeNt(args[1],args[2],false)+"}");return 0;}
  Require(args.Length==1,"controller-arguments");Require(!IsAppContainer(),"controller-token");String executable=Path.GetFullPath(args[0]),profileName="Autoprompt_"+Guid.NewGuid().ToString("N");IntPtr profile=IntPtr.Zero;Boolean created=false;
  try{Int32 status=WindowsAppContainerNative.CreateAppContainerProfile(profileName,profileName,profileName,IntPtr.Zero,0,out profile);Require(status>=0,"create-profile:"+unchecked((UInt32)status).ToString("X8"));created=true;String package=new SecurityIdentifier(profile).Value,user=WindowsIdentity.GetCurrent().User.Value;GrantFixture(Path.GetDirectoryName(executable),executable,package);String controls=Probe(user,package,true),ntControls=ProbeNt(user,package,true);
   // Prove the production launcher restores its host-only prerequisite.
   Environment.SetEnvironmentVariable("LOCALAPPDATA",null,EnvironmentVariableTarget.Process);var result=WindowsAppContainerNative.Launch(executable,Hash(executable),new[]{"child",user,package},Path.GetDirectoryName(executable),FixtureEnvironment(),15000,16384,profile,package,Path.Combine(Path.GetDirectoryName(executable),"never-created-cancellation"));
   Require(result.Drained&&!result.TimedOut&&!result.OutputLimit&&!result.Cancelled&&result.RootImageMatches&&result.AppContainerSid==package,"child-launch-evidence");String output=Encoding.UTF8.GetString(Convert.FromBase64String(result.StdoutBase64)),errors=Encoding.UTF8.GetString(Convert.FromBase64String(result.StderrBase64));Require(result.ExitCode==0&&errors.Length==0,"child-result:"+result.ExitCode+":"+output+":"+errors);Console.Write("{\"controller\":"+controls+",\"ntController\":"+ntControls+",\"child\":"+output+"}");
  }finally{if(profile!=IntPtr.Zero)WindowsAppContainerNative.FreeSid(profile);if(created)Require(WindowsAppContainerNative.DeleteAppContainerProfile(profileName)==0,"delete-profile");}return 0;
 }catch(Exception error){ReportFailure(error);return 1;}}
}
