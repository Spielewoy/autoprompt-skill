using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Security.Principal;
using System.Globalization;
using System.Text.RegularExpressions;

// Fixed protocol executable. No source loading, reflection, commands, or child creation.
public static class BundleLeaseMain {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process2(IntPtr process, out ushort machine, out ushort native);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static void Need(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
  public sealed class Request { public string Root; public string[] Files; }
  // Closed canonical field order, no extra/duplicate fields, and ASCII wire JSON.
  // Unicode paths are represented by JSON escapes, then checked by the lease.
  sealed class Json {
    readonly string text; int at;
    public Json(string value) { text=value; }
    void Literal(string value) {
      Need(at + value.Length <= text.Length && String.CompareOrdinal(text, at, value, 0, value.Length)==0, "request-shape");
      at += value.Length;
    }
    string StringValue() {
      Literal("\""); var result=new StringBuilder(); bool closed=false;
      while(at<text.Length) {
        char c=text[at++];
        if(c=='"') { closed=true; break; }
        Need(c>=32 && c<=126, "request-ascii-required");
        if(c=='\\') {
          Need(at<text.Length, "request-escape"); c=text[at++];
          switch(c) {
            case '"': case '\\': case '/': break;
            case 'b': c='\b'; break; case 'f': c='\f'; break;
            case 'n': c='\n'; break; case 'r': c='\r'; break; case 't': c='\t'; break;
            case 'u':
              Need(at+4<=text.Length,"request-unicode"); int code=0;
              for(int i=0;i<4;i++) { char h=text[at++]; int n=h>='0'&&h<='9'?h-'0':h>='a'&&h<='f'?h-'a'+10:h>='A'&&h<='F'?h-'A'+10:-1; Need(n>=0,"request-unicode"); code=(code<<4)|n; }
              c=(char)code; break;
            default: throw new InvalidOperationException("request-escape");
          }
        }
        result.Append(c); Need(result.Length<=2048,"request-string-bound");
      }
      Need(closed,"request-string-unclosed"); string output=result.ToString();
      for(int i=0;i<output.Length;i++) if(Char.IsSurrogate(output[i])) {
        Need(Char.IsHighSurrogate(output[i]) && i+1<output.Length && Char.IsLowSurrogate(output[i+1]),"request-surrogate"); i++;
      }
      return output;
    }
    public Request Read() {
      Literal("{\"root\":"); string root=StringValue(); Literal(",\"files\":[");
      var files=new List<string>();
      for(;;) { Need(files.Count<129,"inventory-bound"); string file=StringValue(); Need(BundlePhysicalLease.ValidRelative(file),"inventory-path-refused"); files.Add(file); if(at<text.Length && text[at]==',') { at++; continue; } break; }
      Literal("]}"); Need(at==text.Length,"request-trailing");
      Need(root.Length>0 && root.Length<=2048,"root-bound");
      return new Request { Root=root, Files=files.ToArray() };
    }
  }
  public static Request Parse(string text) { Need(text!=null && text.Length<=65536,"request-bound"); return new Json(text).Read(); }
  public static string Line(TextReader input, int limit, int milliseconds) {
    Need(milliseconds>0,"lease-deadline");
    Task<string> task=Task.Run(delegate {
      var b=new StringBuilder(); for(;;) { int c=input.Read(); Need(c>=0,"eof"); if(c==10)return b.ToString(); Need(c>=32 && c<=126 && b.Length<limit,"line-bound"); b.Append((char)c); }
    });
    if(!task.Wait(milliseconds)) throw new TimeoutException("lease-deadline"); return task.Result;
  }
  public static void End(TextReader input, int milliseconds) {
    Need(milliseconds>0,"lease-deadline"); Task<int> task=Task.Run(delegate {return input.Read();});
    if(!task.Wait(milliseconds)) throw new TimeoutException("lease-deadline"); Need(task.Result==-1,"trailing-input");
  }
  public static int Main(string[] args) {
    if(Environment.OSVersion.Platform!=PlatformID.Win32NT) { Console.Error.WriteLine("native-windows-required"); return 1; }
    try {
      ushort machine,native; Need(IsWow64Process2(GetCurrentProcess(),out machine,out native),"native-architecture-query");
      Need(machine==0 && (native==0x8664 || native==0xaa64) && IntPtr.Size==8,"native-helper-required");
      if(args.Length==1 && args[0]=="--identity") { Console.Out.WriteLine(native==0x8664?"bundle-lease-helper-v1:x64":"bundle-lease-helper-v1:arm64"); return 0; }
      if(args.Length>0 && args[0]=="--acl-probe") {
        Console.Out.WriteLine(BundleAclProbe.Run(args,native==0x8664?"x64":"arm64")); return 0;
      }
      Need(args.Length==0,"arguments-refused");
      var clock=Stopwatch.StartNew();
      using(var input=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false,true),false,1024)) {
        Request request=Parse(Line(input,65536,60000-(int)clock.ElapsedMilliseconds));
        using(var lease=new BundlePhysicalLease(request.Root,request.Files)) {
          Console.Out.WriteLine("bundle-lease-ready-v1"); Console.Out.Flush();
          Need(Line(input,16,60000-(int)clock.ElapsedMilliseconds)=="finish","finish-required");
          End(input,60000-(int)clock.ElapsedMilliseconds);
          lease.Finish();
        }
        Console.Out.WriteLine("bundle-lease-finished-v1"); Console.Out.Flush();
      }
      return 0;
    } catch(BundleAclProbe.Refusal error) { Console.Error.WriteLine("bundle-acl-probe-refused:"+error.Code); return 1; }
    catch { Console.Error.WriteLine("bundle-lease-refused"); return 1; }
  }
}

// A fixed non-mutating kernel access check, executed only in the worker token.
// The parent supplies the directory identity; the helper never invents authority.
public static class BundleAclProbe {
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attr; public FT Created,Access,Write;
    public uint Volume,High,Low,Links,IdHigh,IdLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string p,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct UnicodeName { public ushort Length,MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public uint Length; public IntPtr RootDirectory,ObjectName; public uint Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [DllImport("ntdll.dll",ExactSpelling=true)] static extern int NtOpenFile(out IntPtr handle,uint access,ref ObjectAttributes attributes,out IoStatus status,uint sharing,uint options);
  const uint RelativeOptions=0x00200021; // DIRECTORY | OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT
  const uint RelativeReadAccess=0x00120080,RelativeWriteAccess=0x00140000; // Both require SYNCHRONIZE.
  const uint RelativeSharing=3; // No FILE_SHARE_DELETE.
  static ObjectAttributes RelativeAttributes(IntPtr root,IntPtr name) {
    return new ObjectAttributes { Length=(uint)Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=root,ObjectName=name,Attributes=0x40 };
  }
  static bool ValidHandle(IntPtr handle) { return handle!=IntPtr.Zero&&handle!=new IntPtr(-1); }
  static bool ExactGranted(int status,IntPtr handle) { return status==0&&ValidHandle(handle); }
  static bool ExactDenied(int status,IntPtr handle) { return status==unchecked((int)0xc0000022)&&!ValidHandle(handle); }
  static IntPtr OpenRelative(IntPtr root,uint access,out int status) {
    // An empty name reopens the held directory; no DOS path or ancestor lookup.
    // Native matrix controls must prove this operation, including a real grant.
    Need(IntPtr.Size==8&&Marshal.SizeOf(typeof(UnicodeName))==16&&Marshal.SizeOf(typeof(ObjectAttributes))==48&&Marshal.SizeOf(typeof(IoStatus))==16,"acl-relative-ABI");
    IntPtr name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
    try {
      Marshal.StructureToPtr(new UnicodeName(),name,false);
      ObjectAttributes attributes=RelativeAttributes(root,name);IoStatus io;IntPtr handle=IntPtr.Zero;
      status=NtOpenFile(out handle,access,ref attributes,out io,RelativeSharing,RelativeOptions);
      return handle;
    } finally { Marshal.FreeHGlobal(name); }
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out Info info);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle,StringBuilder path,uint length,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(IntPtr handle,IntPtr name,uint size,out uint serial,out uint maxComponent,out uint flags,StringBuilder fs,uint fsSize);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string path);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int length,out int returned);
  [DllImport("advapi32.dll")] static extern bool IsValidSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  public sealed class Refusal : Exception { public readonly string Code; internal Refusal(string code) { Code=code; } }
  static void Need(bool value,string code) { if(!value)throw new Refusal(code); }
  public sealed class Request { public string Sid,Target,Identity; }
  public static Request Parse(string[] args) {
    Need(args!=null&&args.Length==4&&args[0]=="--acl-probe","acl-arguments");
    Need(args[1]!=null&&Regex.IsMatch(args[1],@"\AS-1-15-2(?:-(?:0|[1-9][0-9]{0,9})){7}\z"),"acl-sid");
    foreach(string part in args[1].Substring(9).Split('-')) { uint value;Need(UInt32.TryParse(part,NumberStyles.None,CultureInfo.InvariantCulture,out value),"acl-sid-range"); }
    Need(args[2]!=null&&args[2].Length<=2048&&Regex.IsMatch(args[2],@"\A[A-Za-z]:\\[^\x00-\x1f/]+\z")&&!args[2].EndsWith("\\",StringComparison.Ordinal),"acl-target");
    foreach(string part in args[2].Substring(3).Split('\\'))Need(part.Length>0&&part!="."&&part!=".."&&!part.EndsWith(".",StringComparison.Ordinal)&&!part.EndsWith(" ",StringComparison.Ordinal)&&part.IndexOf(':')<0,"acl-target-component");
    Need(args[3]!=null&&Regex.IsMatch(args[3],@"\A[0-9a-f]{8}:[0-9a-f]{16}\z"),"acl-identity");
    return new Request{Sid=args[1],Target=args[2],Identity=args[3]};
  }
  static void Close(IntPtr handle) { Need(CloseHandle(handle),"acl-close"); }
  static void Token(string expected) {
    IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero;
    try {
      Need(OpenProcessToken(new IntPtr(-1),8,out token),"acl-token-open");buffer=Marshal.AllocHGlobal(4096);int returned;
      Need(GetTokenInformation(token,29,buffer,4096,out returned)&&returned==4&&Marshal.ReadInt32(buffer)==1,"acl-AppContainer-required");
      Need(GetTokenInformation(token,31,buffer,4096,out returned)&&returned>=IntPtr.Size&&returned<=4096,"acl-package-query");
      IntPtr sid=Marshal.ReadIntPtr(buffer);long offset=sid.ToInt64()-buffer.ToInt64();
      Need(offset>=IntPtr.Size&&offset<=returned-8&&IsValidSid(sid),"acl-package-buffer");
      uint length=GetLengthSid(sid);Need(length>=8&&length<=returned-offset,"acl-package-length");
      Need(new SecurityIdentifier(sid).Value==expected,"acl-package-mismatch");
    } finally { if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(token!=IntPtr.Zero)Close(token); }
  }
  static string PathObservation(uint flags,uint length,int error,string value,string expected) {
    string kind=value.StartsWith(@"\\?\Volume{",StringComparison.OrdinalIgnoreCase)?"GUID":
      Regex.IsMatch(value,@"\A\\\\\?\\[A-Za-z]:\\")?"DOS":value.StartsWith(@"\Device\",StringComparison.OrdinalIgnoreCase)?"NT":"other";
    bool valid=length>0&&length<32768;
    string wanted=(flags&4)!=0?expected.Substring(2):NativePath(expected);
    return "f"+flags.ToString(CultureInfo.InvariantCulture)+",len="+length.ToString(CultureInfo.InvariantCulture)+",error="+(length==0?((uint)error).ToString(CultureInfo.InvariantCulture):"0")+",kind="+kind+",equal="+(valid&&String.Equals(value,wanted,StringComparison.OrdinalIgnoreCase)?"1":"0")+",exact="+(valid&&String.Equals(value,wanted,StringComparison.Ordinal)?"1":"0");
  }
  // CI30 native x64/ARM64 evidence: DOS queries (0/8) fail error5 inside the
  // AppContainer, while normalized volume-relative query4 exactly matches.
  // Volume and file ID remain separately bound to the parent's NTFS identity.
  const uint NormalizedVolumePath=4; // FILE_NAME_NORMALIZED | VOLUME_NAME_NONE
  static bool MatchesNormalizedPath(uint length,string value,string expected) {
    return length>0&&length<32768&&String.Equals(value,expected.Substring(2),StringComparison.OrdinalIgnoreCase);
  }
  static string Read(IntPtr handle,string expectedPath) {
    Info info=new Info();Need(GetFileType(handle)==1&&GetFileInformationByHandle(handle,out info),"acl-directory-query");
    Need((info.Attr&0x400)==0&&(info.Attr&0x10)!=0,"acl-physical-directory");
    var path=new StringBuilder(32768);uint length=GetFinalPathNameByHandleW(handle,path,(uint)path.Capacity,NormalizedVolumePath);int error=Marshal.GetLastWin32Error();
    if(!MatchesNormalizedPath(length,path.ToString(),expectedPath)) {
      // Observation only: no alternative query can authorize this failed check.
      string detail=PathObservation(NormalizedVolumePath,length,error,path.ToString(),expectedPath);
      foreach(uint flags in new uint[]{0,8,12}) { var other=new StringBuilder(32768);uint count=GetFinalPathNameByHandleW(handle,other,(uint)other.Capacity,flags);int last=Marshal.GetLastWin32Error();detail+=";"+PathObservation(flags,count,last,other.ToString(),expectedPath); }
      throw new Refusal("acl-canonical-directory:"+detail);
    }
    return info.Volume.ToString("x8",CultureInfo.InvariantCulture)+":"+info.IdHigh.ToString("x8",CultureInfo.InvariantCulture)+info.IdLow.ToString("x8",CultureInfo.InvariantCulture);
  }
  static string NativePath(string path) { return "\\\\?\\"+path; }
  static IntPtr Open(string path,uint access) {
    // READ|WRITE sharing permits ordinary work, but denies replacement/rename.
    IntPtr handle=CreateFileW(NativePath(path),access,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);int error=Marshal.GetLastWin32Error();
    if(handle==new IntPtr(-1)||handle==IntPtr.Zero)throw new Refusal("acl-positive-open-target-"+((uint)error).ToString(CultureInfo.InvariantCulture));
    try { Read(handle,path);return handle; } catch { Close(handle);throw; }
  }
  public static string Run(string[] args,string architecture) {
    Request request=Parse(args);Need(architecture=="x64"||architecture=="arm64","acl-architecture");
    Need(GetDriveTypeW(request.Target.Substring(0,3))==3,"acl-local-canonical-target");
    Token(request.Sid);var handles=new List<IntPtr>();
    try {
      // The object is bound by identity, not by permission to inspect ancestors.
      // The relative NtOpenFile below addresses this object if parent names move.
      IntPtr target=Open(request.Target,0x20080);handles.Add(target);Need(Read(target,request.Target)==request.Identity,"acl-identity-mismatch");
      uint serial,maxComponent,flags;var fs=new StringBuilder(32);
      Need(GetVolumeInformationByHandleW(target,IntPtr.Zero,0,out serial,out maxComponent,out flags,fs,(uint)fs.Capacity)&&fs.ToString()=="NTFS","acl-ntfs-required");
      int positiveStatus;IntPtr positive=OpenRelative(target,RelativeReadAccess,out positiveStatus);
      if(ValidHandle(positive))handles.Add(positive);
      Need(ExactGranted(positiveStatus,positive),"acl-positive-relative-"+((uint)positiveStatus).ToString("x8",CultureInfo.InvariantCulture));
      Need(Read(positive,request.Target)==request.Identity,"acl-reopen-identity-mismatch");
      int writeStatus;IntPtr write=OpenRelative(target,RelativeWriteAccess,out writeStatus);
      if(ValidHandle(write)) { Close(write);Need(ExactGranted(writeStatus,write),"acl-WRITE_DAC-status-"+((uint)writeStatus).ToString("x8",CultureInfo.InvariantCulture));throw new Refusal("acl-WRITE_DAC-granted"); }
      Need(ExactDenied(writeStatus,write),"acl-exact-access-denied-required-"+((uint)writeStatus).ToString("x8",CultureInfo.InvariantCulture));
      Need(Read(target,request.Target)==request.Identity,"acl-held-identity-changed");
    } finally { Exception failure=null;for(int i=handles.Count-1;i>=0;i--)try{Close(handles[i]);}catch(Exception error){failure=error;}if(failure!=null)throw failure; }
    return "bundle-acl-denied-v1:"+architecture+":"+request.Identity+":5";
  }
}
