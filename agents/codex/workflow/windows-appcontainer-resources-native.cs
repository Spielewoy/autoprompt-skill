// Closed AppContainer resource lifecycle; no named-path ACL mutations.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Linq;

public static class WindowsAppContainerResourcesNative {
  const uint FILE_READ_DATA = 0x00000001, FILE_READ_ATTRIBUTES = 0x00000080, SYNCHRONIZE = 0x00100000;
  const uint FILE_SHARE_READ = 0x00000001, FILE_SHARE_WRITE = 0x00000002, FILE_SHARE_DELETE = 0x00000004, FILE_OPEN = 1;
  const uint FILE_DIRECTORY_FILE = 0x00000001, FILE_NON_DIRECTORY_FILE = 0x00000040;
  const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020, FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint OBJ_CASE_INSENSITIVE = 0x00000040, FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const uint FILE_TYPE_DISK = 1, DRIVE_FIXED = 3;
  public const int MaxResourceEntries = 16 * 1024, MaxRecoveryEntries = 2 * MaxResourceEntries;
  const int MaxBytes = 64 * 1024 * 1024, MaxRecordBytes = 8 * 1024 * 1024 + 1;

  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES {
    public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; public long Value { get { return ((long)High << 32) | Low; } } }
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes; public FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  [DllImport("ntdll.dll", CharSet=CharSet.Unicode)] static extern int NtCreateFile(out IntPtr h, uint desired, ref OBJECT_ATTRIBUTES oa,
    out IO_STATUS_BLOCK iosb, IntPtr allocation, uint attributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(IntPtr h, out IO_STATUS_BLOCK iosb, IntPtr information, uint length, uint informationClass);
  [DllImport("ntdll.dll")] static extern int NtQueryDirectoryFile(IntPtr h, IntPtr evt, IntPtr apc, IntPtr apcContext, out IO_STATUS_BLOCK iosb, IntPtr information, uint length, uint informationClass, bool singleEntry, IntPtr mask, bool restart);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr h, out IO_STATUS_BLOCK iosb, IntPtr information, uint length, uint informationClass);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr h, byte[] buffer, uint count, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle, uint type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, [Out] byte[] buffer, uint count, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(IntPtr h, long distance, out long position, uint method);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr h, System.Text.StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetDriveType(string root);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandle(IntPtr h, IntPtr name, uint nameSize,
    out uint serial, out uint maxComponent, out uint flags, System.Text.StringBuilder fsName, uint fsNameSize);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint QueryDosDevice(string device, System.Text.StringBuilder target, uint targetSize);

  public sealed class Refusal : Exception { public readonly string Code; public Refusal(string code) : base(code) { Code = code; } public Refusal(string code, Exception inner) : base(code,inner) { Code = code; } }
  sealed class Snapshot {
    public uint Volume, Attributes, Links, SizeHigh, SizeLow, IndexHigh, IndexLow; public long LastWrite, Creation;
    public long Size { get { return ((long)SizeHigh << 32) | SizeLow; } }
    public string Id { get { return Volume.ToString("x8") + ":" + IndexHigh.ToString("x8") + IndexLow.ToString("x8"); } }
    public bool Same(Snapshot other) { return other != null && Volume == other.Volume && Attributes == other.Attributes && Links == other.Links &&
      SizeHigh == other.SizeHigh && SizeLow == other.SizeLow && IndexHigh == other.IndexHigh && IndexLow == other.IndexLow && LastWrite == other.LastWrite && Creation == other.Creation; }
  }
  sealed class Opened { public IntPtr Handle; public string Name; public Snapshot Snapshot; public bool Directory; public Opened Parent; }

  static void Need(bool condition, string code) { if (!condition) throw new Refusal(code); }
  static Snapshot Info(IntPtr h, bool allowReparse = false) {
    BY_HANDLE_FILE_INFORMATION i;
    if (!GetFileInformationByHandle(h, out i)) throw new Refusal("PREIMAGE_UNSAFE");
    if (GetFileType(h) != FILE_TYPE_DISK || (!allowReparse && (i.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)) throw new Refusal("PREIMAGE_UNSAFE");
    return new Snapshot { Volume=i.VolumeSerialNumber, Attributes=i.FileAttributes, Links=i.NumberOfLinks, SizeHigh=i.FileSizeHigh, SizeLow=i.FileSizeLow,
      IndexHigh=i.FileIndexHigh, IndexLow=i.FileIndexLow, LastWrite=i.LastWriteTime.Value, Creation=i.CreationTime.Value };
  }
  static void CheckCanonicalComponentName(IntPtr h, string requested) {
    // FileNameInformation records the spelling used to open a file object on
    // NTFS, including an 8.3 alias.  Ask the held handle for its normalized
    // final path instead; this is comparison-only and is never reopened.
    const int capacity = 32768, FILE_NAME_NORMALIZED = 0, VOLUME_NAME_DOS = 0;
    var path = new System.Text.StringBuilder(capacity);
    uint chars = GetFinalPathNameByHandle(h, path, (uint)path.Capacity, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (chars == 0 || chars >= path.Capacity) throw new Refusal("PREIMAGE_UNSAFE");
    string full = path.ToString(); int slash = full.LastIndexOf('\\');
    string canonical = slash < 0 ? full : full.Substring(slash + 1);
    Need(!String.IsNullOrEmpty(canonical) && String.Equals(canonical, requested, StringComparison.OrdinalIgnoreCase), "PREIMAGE_UNSAFE");
  }
  static IntPtr Open(string name, IntPtr parent, bool directory, bool createWritable = false, bool shareAll = false, bool readSecurity = false, bool deleteExisting = false, bool anyType = false, bool allowMissing = false) {
    IntPtr chars = IntPtr.Zero, unicodePtr = IntPtr.Zero, securityPtr = IntPtr.Zero;
    try {
      chars = Marshal.StringToHGlobalUni(name);
      UNICODE_STRING us = new UNICODE_STRING { Length=(ushort)(name.Length * 2), MaximumLength=(ushort)((name.Length + 1) * 2), Buffer=chars };
      unicodePtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(us, unicodePtr, false);
      OBJECT_ATTRIBUTES oa = new OBJECT_ATTRIBUTES { Length=Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)), RootDirectory=parent, ObjectName=unicodePtr, Attributes=OBJ_CASE_INSENSITIVE };
      if (createWritable) {
        string sid; using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent()) sid = identity.User.Value;
        var security = new System.Security.AccessControl.RawSecurityDescriptor("O:" + sid + "D:P(A;;FA;;;" + sid + ")(A;;FA;;;SY)(A;;FA;;;BA)");
        byte[] binary = new byte[security.BinaryLength]; security.GetBinaryForm(binary, 0);
        securityPtr = Marshal.AllocHGlobal(binary.Length); Marshal.Copy(binary, 0, securityPtr, binary.Length); oa.SecurityDescriptor = securityPtr;
      }
      IO_STATUS_BLOCK io; IntPtr h;
      uint options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | (anyType ? 0u : (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE));
      // Ancestors may be shared so unrelated directory activity does not make
      // this primitive unavailable.  Their snapshots are checked at the end.
      // The leaf excludes write/delete sharing for native writer quiescence.
      uint share = directory || shareAll ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_READ;
      uint desired = FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE | (createWritable ? 0x00030002u : 0u) | (readSecurity ? 0x000e0000u : 0u) | (deleteExisting ? 0x00010000u : 0u);
      int status = NtCreateFile(out h, desired, ref oa, out io, IntPtr.Zero, 0, share, createWritable ? 2u : FILE_OPEN, options, IntPtr.Zero, 0);
      if (status == unchecked((int)0xc0000035)) throw new Refusal("FILESYSTEM_ALREADY_EXISTS");
      if (allowMissing && (status == unchecked((int)0xc0000034) || status == unchecked((int)0xc000000f))) throw new Refusal("FILESYSTEM_NOT_FOUND");
      if (status < 0 || h == IntPtr.Zero || h == new IntPtr(-1)) throw new Refusal("PREIMAGE_UNSAFE");
      return h;
    } finally { if (securityPtr != IntPtr.Zero) Marshal.FreeHGlobal(securityPtr); if (unicodePtr != IntPtr.Zero) Marshal.FreeHGlobal(unicodePtr); if (chars != IntPtr.Zero) Marshal.FreeHGlobal(chars); }
  }
  static Opened OpenChecked(string name, IntPtr parent, bool directory, bool requireSingleLink, bool requireCanonicalComponent, bool readSecurity = false, bool allowMissing = false) {
    IntPtr h = Open(name, parent, directory, false, false, readSecurity, false, false, allowMissing);
    try {
      Snapshot s = Info(h); bool isDirectory = (s.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      Need(isDirectory == directory, "PREIMAGE_UNSAFE");
      if (requireSingleLink) Need(s.Links == 1, "PREIMAGE_UNSAFE");
      if (requireCanonicalComponent) CheckCanonicalComponentName(h, name);
      return new Opened { Handle=h, Name=name, Snapshot=s, Directory=directory };
    } catch { CloseHandle(h); throw; }
  }
  static bool Reserved(string part) {
    string stem = part.Split('.')[0].ToUpperInvariant();
    if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL") return true;
    return stem.Length == 4 && (stem.StartsWith("COM") || stem.StartsWith("LPT")) && stem[3] >= '1' && stem[3] <= '9';
  }
  public static bool ValidRoot(string root) { return root != null && root.Length == 3 && ((root[0] >= 'A' && root[0] <= 'Z') || (root[0] >= 'a' && root[0] <= 'z')) && root[1] == ':' && root[2] == '\\'; }
  public static bool ValidComponent(string part) {
    if (String.IsNullOrEmpty(part) || part.Length > 255 || part == "." || part == ".." || part[part.Length - 1] == '.' || part[part.Length - 1] == ' ' || Reserved(part)) return false;
    for (int i = 0; i < part.Length; i++) { if (part[i] < 32) return false; if (Char.IsHighSurrogate(part[i])) { if (++i >= part.Length || !Char.IsLowSurrogate(part[i])) return false; } else if (Char.IsLowSurrogate(part[i])) return false; }
    return part.IndexOfAny(new char[] {'\\','/',':','\0','?','*','<','>','|','"'}) < 0;
  }
  static string PhysicalDriveMapping(string root) {
    Need(GetDriveType(root) == DRIVE_FIXED, "FILESYSTEM_REQUEST_INVALID");
    var target = new System.Text.StringBuilder(1024);
    Need(QueryDosDevice(root.Substring(0, 2), target, (uint)target.Capacity) != 0 &&
      target.ToString().StartsWith("\\Device\\HarddiskVolume", StringComparison.OrdinalIgnoreCase), "FILESYSTEM_REQUEST_INVALID");
    return target.ToString();
  }
  static void ValidateRootVolume(IntPtr rootHandle, string root, string expectedMapping) {
    Need(PhysicalDriveMapping(root) == expectedMapping, "PREIMAGE_UNSAFE");
    uint serial, maxComponent, flags; var fs = new System.Text.StringBuilder(32);
    Need(GetVolumeInformationByHandle(rootHandle, IntPtr.Zero, 0, out serial, out maxComponent, out flags, fs, (uint)fs.Capacity) && fs.ToString() == "NTFS", "FILESYSTEM_BACKEND_UNAVAILABLE");
    Need(Info(rootHandle).Volume == serial, "PREIMAGE_UNSAFE");
  }
  static void Verify(List<Opened> held, string nativeRoot) {
    IntPtr fresh = IntPtr.Zero;
    try {
      fresh = Open(nativeRoot, IntPtr.Zero, true);
      Need(held[0].Snapshot.Same(Info(fresh)), "PREIMAGE_UNSAFE");
      for (int i = 1; i < held.Count; i++) {
        IntPtr child = IntPtr.Zero;
        try { child = Open(held[i].Name, held[i - 1].Handle, held[i].Directory); CheckCanonicalComponentName(child, held[i].Name); Need(held[i].Snapshot.Same(Info(child)), "PREIMAGE_UNSAFE"); }
        finally { if (child != IntPtr.Zero) CloseHandle(child); }
      }
      for (int i = 0; i < held.Count; i++) Need(held[i].Snapshot.Same(Info(held[i].Handle)), "PREIMAGE_UNSAFE");
    } finally { if (fresh != IntPtr.Zero) CloseHandle(fresh); }
  }
  sealed class DirectoryEntry {
    public string Name; public uint Attributes; public ulong Id;
    public bool Same(DirectoryEntry other) { return Name == other.Name && Attributes == other.Attributes && Id == other.Id; }
  }
  // FileIdFullDirectoryInformation (class 38) is enumerated exclusively from
  // a held directory HANDLE. Dot records are structural, never child opens.
  static List<DirectoryEntry> EnumerateHeld(IntPtr directory, int maxEntries, bool allowReparse = false) {
    var result = new List<DirectoryEntry>(); var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      bool restart = true;
      while (true) {
        IO_STATUS_BLOCK io;
        int status = NtQueryDirectoryFile(directory, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out io, buffer, 65536, 38, false, IntPtr.Zero, restart);
        restart = false;
        if (status == unchecked((int)0x80000006)) break; // STATUS_NO_MORE_FILES
        Need(status == 0, "PREIMAGE_UNSAFE");
        long returned = io.Information.ToInt64(); Need(returned >= 80 && returned <= 65536, "PREIMAGE_UNSAFE");
        int used = (int)returned, offset = 0;
        while (true) {
          Need(used - offset >= 80, "PREIMAGE_UNSAFE");
          int next = Marshal.ReadInt32(buffer, offset), nameBytes = Marshal.ReadInt32(buffer, offset + 60);
          uint attrs = unchecked((uint)Marshal.ReadInt32(buffer, offset + 56));
          ulong id = unchecked((ulong)Marshal.ReadInt64(buffer, offset + 72));
          Need(nameBytes >= 2 && nameBytes <= 510 && (nameBytes & 1) == 0 && nameBytes <= used - offset - 80, "PREIMAGE_UNSAFE");
          Need(next == 0 || (next >= 80 + nameBytes && next % 8 == 0 && next <= used - offset - 80), "PREIMAGE_UNSAFE");
          string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 80), nameBytes / 2);
          if (name != "." && name != "..") {
            Need(ValidComponent(name) && names.Add(name) && (allowReparse || (attrs & FILE_ATTRIBUTE_REPARSE_POINT) == 0), "PREIMAGE_UNSAFE");
            Need(result.Count < maxEntries, "WINDOWS_RESOURCE_LIMIT");
            result.Add(new DirectoryEntry { Name=name, Attributes=attrs, Id=id });
          }
          if (next == 0) break;
          offset += next;
        }
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    result.Sort((a, b) => StringComparer.Ordinal.Compare(a.Name, b.Name)); return result;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILE_ID_DESCRIPTOR { public uint Size, Type; public ulong Low, High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenFileById(IntPtr volume, ref FILE_ID_DESCRIPTOR id, uint access, uint share, IntPtr security, uint flags);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint SetSecurityInfo(IntPtr h, uint type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr memory);
  public sealed class RootSpec { public string path, kind; public bool writable; }
  public sealed class RootRecord { public string path, kind, identity, creation; public bool writable; }
  // Provenance contains only ACEs whose inheritance flag this lease can own,
  // plus preexisting explicit duplicates that must never be converted.
  public sealed class EntryRecord { public string identity, creation, label; public string[] inheritedAces, explicitAces; public bool directory, writable, git, root, daclProtected; }
  public sealed class ResourcePlan { public int schemaVersion; public string profileName, profileSid; public RootRecord[] roots; public EntryRecord[] entries; }
  sealed class Item { public Opened opened; public string full; public bool writable, git, root; }
  sealed class Forest : IDisposable {
    public List<Opened> handles = new List<Opened>(); public List<Item> items = new List<Item>(); public List<RootRecord> roots = new List<RootRecord>();
    public Dictionary<string, Opened> volumes = new Dictionary<string, Opened>(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, string> mappings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    public void Dispose() { for (int i=handles.Count-1;i>=0;i--) if(handles[i].Handle!=IntPtr.Zero) CloseHandle(handles[i].Handle); }
  }
  static bool Within(string root, string child) { return String.Equals(root,child,StringComparison.OrdinalIgnoreCase) || child.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase); }
  static string CurrentSid() { using(var identity=WindowsIdentity.GetCurrent()) return identity.User.Value; }
  static void ProfileName(string name) { Need(name!=null && System.Text.RegularExpressions.Regex.IsMatch(name,"^Autoprompt_[a-f0-9]{32}$"),"WINDOWS_RESOURCE_INVALID"); }
  static string ProfileSid(string name) { ProfileName(name); IntPtr sid=IntPtr.Zero; try { Need(DeriveAppContainerSidFromAppContainerName(name,out sid)==0 && sid!=IntPtr.Zero,"WINDOWS_PROFILE_UNAVAILABLE"); return new SecurityIdentifier(sid).Value; } finally { if(sid!=IntPtr.Zero)FreeSid(sid); } }
  static void Specs(RootSpec[] roots) {
    Need(roots!=null && roots.Length>0 && roots.Length<=64,"WINDOWS_RESOURCE_INVALID");
    foreach(var root in roots) {
      Need(root!=null && root.path!=null && root.path.Length>3 && root.path.Length<=32760 && ValidRoot(root.path.Substring(0,3)) && (root.kind=="file" || root.kind=="directory") && (!root.writable || root.kind=="directory"),"WINDOWS_RESOURCE_INVALID");
      foreach(string part in root.path.Substring(3).Split('\\')) Need(ValidComponent(part),"WINDOWS_RESOURCE_INVALID");
    }
  }
  static RawSecurityDescriptor Security(IntPtr handle) {
    IntPtr owner,group,dacl,sacl,descriptor;
    Need(GetSecurityInfo(handle,1,0x15,out owner,out group,out dacl,out sacl,out descriptor)==0,"WINDOWS_ACL_UNAVAILABLE");
    try { uint length=GetSecurityDescriptorLength(descriptor); Need(length>0 && length<=65536,"WINDOWS_ACL_LIMIT"); byte[] bytes=new byte[(int)length]; Marshal.Copy(descriptor,bytes,0,bytes.Length); return new RawSecurityDescriptor(bytes,0); }
    finally { if(descriptor!=IntPtr.Zero)LocalFree(descriptor); }
  }
  static void Private(RawSecurityDescriptor security, bool root) {
    string current=CurrentSid(); Need(!root || (security.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0,"WINDOWS_WRITABLE_ROOT_NOT_PRIVATE"); Need(security.Owner!=null && (security.Owner.Value==current || (!root && (security.Owner.Value=="S-1-5-32-544" || security.Owner.Value=="S-1-5-18"))) && security.DiscretionaryAcl!=null,"WINDOWS_WRITABLE_ROOT_NOT_PRIVATE");
    foreach(GenericAce ace in security.DiscretionaryAcl) {
      var qualified=ace as QualifiedAce; Need(qualified!=null,"WINDOWS_WRITABLE_ROOT_NOT_PRIVATE");
      if(qualified.AceQualifier==AceQualifier.AccessDenied)continue;
      string sid=qualified.SecurityIdentifier.Value;
      Need(qualified.AceQualifier==AceQualifier.AccessAllowed && (sid==current || sid=="S-1-5-18" || sid=="S-1-5-32-544" || (sid=="S-1-3-0" && (ace.AceFlags&AceFlags.InheritOnly)!=0)),"WINDOWS_WRITABLE_ROOT_NOT_PRIVATE");
    }
  }
  static string Label(RawSecurityDescriptor security) {
    if(security.SystemAcl==null)return ""; Need(security.SystemAcl.BinaryLength<=4096,"WINDOWS_ACL_LIMIT");
    byte[] bytes=new byte[security.SystemAcl.BinaryLength];security.SystemAcl.GetBinaryForm(bytes,0);return Convert.ToBase64String(bytes);
  }
  static string LabelFor(string level) { return Label(new RawSecurityDescriptor("S:(ML;;NW;;;"+level+")")); }
  static bool HasSid(RawAcl acl,string sid) { Need(acl!=null,"WINDOWS_ACL_UNAVAILABLE"); foreach(GenericAce ace in acl){var qualified=ace as QualifiedAce;Need(qualified!=null,"WINDOWS_ACL_UNSUPPORTED");if(qualified.SecurityIdentifier.Value==sid)return true;}return false; }
  static RawAcl WithoutSid(RawAcl acl,string sid) {
    Need(acl!=null,"WINDOWS_ACL_UNAVAILABLE");var result=new RawAcl(acl.Revision,acl.Count);
    foreach(GenericAce ace in acl){var qualified=ace as QualifiedAce;Need(qualified!=null,"WINDOWS_ACL_UNSUPPORTED");if(qualified.SecurityIdentifier.Value!=sid)result.InsertAce(result.Count,ace.Copy());}return result;
  }
  static bool Protected(RawSecurityDescriptor security) { return (security.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0; }
  static byte[] AceBytes(string encoded) {
    Need(encoded!=null && encoded.Length<=87380,"WINDOWS_RESOURCE_INVALID");byte[] bytes;
    try{bytes=Convert.FromBase64String(encoded);}catch(FormatException){throw new Refusal("WINDOWS_RESOURCE_INVALID");}
    Need(bytes.Length>=4 && bytes.Length<=65528 && (bytes.Length&3)==0 && (bytes[2]|bytes[3]<<8)==bytes.Length && Convert.ToBase64String(bytes)==encoded,"WINDOWS_RESOURCE_INVALID");return bytes;
  }
  static bool Inherited(string encoded){return (AceBytes(encoded)[1]&16)!=0;}
  static string InheritanceBit(string encoded,bool inherited){byte[] bytes=AceBytes(encoded);bytes[1]=(byte)(inherited?bytes[1]|16:bytes[1]&~16);return Convert.ToBase64String(bytes);}
  static string[] EncodedAces(RawAcl acl){return acl.Cast<GenericAce>().Select(ace=>{byte[] bytes=new byte[ace.BinaryLength];ace.GetBinaryForm(bytes,0);return Convert.ToBase64String(bytes);}).ToArray();}
  static RawAcl DecodedAcl(byte revision,string[] entries){var acl=new RawAcl(revision,entries.Length);foreach(string entry in entries)acl.InsertAce(acl.Count,GenericAce.CreateFromBinaryForm(AceBytes(entry),0));return acl;}
  static bool SameAces(IEnumerable<string> left,IEnumerable<string> right){return left.OrderBy(x=>x,StringComparer.Ordinal).SequenceEqual(right.OrderBy(x=>x,StringComparer.Ordinal));}
  static void ValidateInheritanceRecord(EntryRecord entry,string packageSid){
    Need(entry.inheritedAces!=null && entry.explicitAces!=null && entry.inheritedAces.Length+entry.explicitAces.Length<=8192,"WINDOWS_RESOURCE_INVALID");
    Need((entry.git && !entry.daclProtected) || (entry.inheritedAces.Length==0 && entry.explicitAces.Length==0),"WINDOWS_RESOURCE_INVALID");
    int bytes=8;foreach(string encoded in entry.inheritedAces.Concat(entry.explicitAces)){byte[] raw=AceBytes(encoded);bytes+=raw.Length;Need(bytes<=65535,"WINDOWS_RESOURCE_INVALID");var ace=GenericAce.CreateFromBinaryForm(raw,0) as QualifiedAce;Need(ace!=null && ace.SecurityIdentifier.Value!=packageSid,"WINDOWS_RESOURCE_INVALID");}
    var flattened=new HashSet<string>(entry.inheritedAces.Select(ace=>InheritanceBit(ace,false)),StringComparer.Ordinal);
    Need(entry.inheritedAces.All(Inherited) && entry.explicitAces.All(ace=>!Inherited(ace)&&flattened.Contains(ace)),"WINDOWS_RESOURCE_INVALID");
  }
  static void VerifyInheritancePreimage(RawAcl acl,EntryRecord entry){
    if(!entry.git || entry.daclProtected)return;
    var entries=EncodedAces(acl);var flattened=new HashSet<string>(entry.inheritedAces.Select(ace=>InheritanceBit(ace,false)),StringComparer.Ordinal);
    Need(SameAces(entries.Where(Inherited),entry.inheritedAces) && SameAces(entries.Where(ace=>!Inherited(ace)&&flattened.Contains(ace)),entry.explicitAces),"WINDOWS_ACL_INHERITANCE_CHANGED");
  }
  // Protecting a DACL clears inherited bits. Reverse only the exact byte/count
  // transitions recorded before Apply; preserve every other live ACE. A changed
  // or merged owned ACE is ambiguous and must retain its recovery journal.
  static string[] RestoreInheritanceAces(string[] current,string[] inherited,string[] explicitBefore){
    Need(current!=null && inherited!=null && explicitBefore!=null && current.Length<=8192 && inherited.Length+explicitBefore.Length<=8192,"WINDOWS_RESOURCE_INVALID");
    var wanted=inherited.Select(ace=>{Need(Inherited(ace),"WINDOWS_RESOURCE_INVALID");return InheritanceBit(ace,false);}).GroupBy(x=>x,StringComparer.Ordinal).ToDictionary(g=>g.Key,g=>g.Count(),StringComparer.Ordinal);
    var explicitCounts=explicitBefore.GroupBy(x=>x,StringComparer.Ordinal).ToDictionary(g=>g.Key,g=>g.Count(),StringComparer.Ordinal);
    Need(explicitBefore.All(ace=>!Inherited(ace)&&wanted.ContainsKey(ace)),"WINDOWS_RESOURCE_INVALID");
    Need(current.All(ace=>!Inherited(ace)),"WINDOWS_ACL_INHERITANCE_CHANGED");
    var currentCounts=current.GroupBy(x=>x,StringComparer.Ordinal).ToDictionary(g=>g.Key,g=>g.Count(),StringComparer.Ordinal);
    foreach(var pair in wanted){int baseline,found;explicitCounts.TryGetValue(pair.Key,out baseline);currentCounts.TryGetValue(pair.Key,out found);Need(found>=pair.Value+baseline,"WINDOWS_ACL_INHERITANCE_CHANGED");}
    var result=(string[])current.Clone();for(int i=result.Length-1;i>=0;i--){int remaining;if(wanted.TryGetValue(result[i],out remaining)&&remaining>0){wanted[result[i]]=remaining-1;result[i]=InheritanceBit(result[i],true);}}
    return result;
  }
  static void SetAcl(IntPtr handle,RawAcl acl,bool label,bool? protection=null) {
    byte[] bytes=new byte[acl.BinaryLength];acl.GetBinaryForm(bytes,0);IntPtr pointer=Marshal.AllocHGlobal(bytes.Length);
    try { uint information=label?0x10u:4u;if(protection.HasValue){Need(!label,"WINDOWS_RESOURCE_INVALID");information|=protection.Value?0x80000000u:0x20000000u;}Marshal.Copy(bytes,0,pointer,bytes.Length);Need(SetSecurityInfo(handle,1,information,IntPtr.Zero,IntPtr.Zero,label?IntPtr.Zero:pointer,label?pointer:IntPtr.Zero)==0,"WINDOWS_ACL_WRITE_FAILED"); }
    finally { Marshal.FreeHGlobal(pointer); }
  }
  static void SetLabel(IntPtr handle,string encoded) { byte[] bytes=encoded.Length==0?null:Convert.FromBase64String(encoded);SetAcl(handle,bytes==null?new RawAcl(2,0):new RawAcl(bytes,0),true); }
  static Opened Volume(Forest forest,string path) {
    string root=path.Substring(0,3);Opened held;
    if(forest.volumes.TryGetValue(root,out held))return held;
    string mapping=PhysicalDriveMapping(root);held=OpenChecked("\\??\\"+root,IntPtr.Zero,true,false,false);forest.handles.Add(held);ValidateRootVolume(held.Handle,root,mapping);forest.volumes[root]=held;forest.mappings[root]=mapping;return held;
  }
  static Opened OpenRoot(Forest forest,RootSpec spec) {
    Opened parent=Volume(forest,spec.path);string[] parts=spec.path.Substring(3).Split('\\');Need(parts.Length<=128,"WINDOWS_RESOURCE_LIMIT");
    for(int i=0;i<parts.Length;i++){bool last=i==parts.Length-1;Opened child=OpenChecked(parts[i],parent.Handle,!last || spec.kind=="directory",last && spec.kind=="file",true,last);child.Parent=parent;parent=child;forest.handles.Add(parent);}return parent;
  }
  static void Walk(Forest forest,Opened node,string full,RootSpec[] specs,HashSet<string> seen,int depth,bool recovering) {
    Need(depth<=128,"WINDOWS_RESOURCE_LIMIT");if(!seen.Add(node.Snapshot.Id))return;Need(forest.items.Count<(recovering?MaxRecoveryEntries:MaxResourceEntries),"WINDOWS_RESOURCE_LIMIT");
    bool writable=specs.Any(root=>root.writable && Within(root.path,full));bool git=full.Split('\\').Any(part=>String.Equals(part,".git",StringComparison.OrdinalIgnoreCase));bool rootNode=specs.Any(root=>String.Equals(root.path,full,StringComparison.OrdinalIgnoreCase));
    forest.items.Add(new Item{opened=node,full=full,writable=writable,git=git,root=rootNode});
    if(!node.Directory || (node.Snapshot.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)return;
    foreach(var entry in EnumerateHeld(node.Handle,recovering?MaxRecoveryEntries:MaxResourceEntries,recovering)) {
      Need(depth<128,"WINDOWS_RESOURCE_LIMIT");bool directory=(entry.Attributes&FILE_ATTRIBUTE_DIRECTORY)!=0;
      IntPtr handle=Open(entry.Name,node.Handle,directory,false,false,true);
      Opened child;
      try { Snapshot snapshot=Info(handle,recovering);Need(snapshot.Volume==node.Snapshot.Volume && snapshot.Attributes==entry.Attributes && (((ulong)snapshot.IndexHigh<<32)|snapshot.IndexLow)==entry.Id && (recovering || directory || snapshot.Links==1),"PREIMAGE_UNSAFE");child=new Opened{Handle=handle,Name=entry.Name,Snapshot=snapshot,Directory=directory,Parent=node}; }
      catch{CloseHandle(handle);throw;}
      forest.handles.Add(child);Walk(forest,child,full+"\\"+entry.Name,specs,seen,depth+1,recovering);
    }
  }
  static Forest Inventory(RootSpec[] specs) {
    Specs(specs);var forest=new Forest();var seen=new HashSet<string>(StringComparer.Ordinal);
    try {foreach(var spec in specs){Opened root=OpenRoot(forest,spec);forest.roots.Add(new RootRecord{path=spec.path,kind=spec.kind,writable=spec.writable,identity=root.Snapshot.Id,creation=root.Snapshot.Creation.ToString()});Walk(forest,root,spec.path,specs,seen,0,false);}return forest;}
    catch{forest.Dispose();throw;}
  }
  static bool SameDirectoryIdentity(Snapshot before,Snapshot after) {
    return after!=null && before.Volume==after.Volume && before.Attributes==after.Attributes && before.Links==after.Links &&
      before.IndexHigh==after.IndexHigh && before.IndexLow==after.IndexLow && before.Creation==after.Creation;
  }
  static void Stable(Forest forest) {
    var resources=new HashSet<Opened>(forest.items.Select(item=>item.opened));
    foreach(var volume in forest.volumes)ValidateRootVolume(volume.Value.Handle,volume.Key,forest.mappings[volume.Key]);
    foreach(var held in forest.handles) {
      // Shared ancestry may contain unrelated active missions. Resource roots
      // and descendants retain complete snapshots; ancestors retain physical
      // identity and are reopened through the held parent to detect renames.
      bool resource=resources.Contains(held);Snapshot current=Info(held.Handle);
      Need(resource || !held.Directory?held.Snapshot.Same(current):SameDirectoryIdentity(held.Snapshot,current),"PREIMAGE_UNSAFE");
      IntPtr fresh=IntPtr.Zero;
      try {
        fresh=Open(held.Name,held.Parent==null?IntPtr.Zero:held.Parent.Handle,held.Directory);
        if(held.Parent!=null)CheckCanonicalComponentName(fresh,held.Name);
        current=Info(fresh);
        Need(resource || !held.Directory?held.Snapshot.Same(current):SameDirectoryIdentity(held.Snapshot,current),"PREIMAGE_UNSAFE");
      } finally {if(fresh!=IntPtr.Zero)CloseHandle(fresh);}
    }
  }
  public static ResourcePlan Plan(string profileName,RootSpec[] specs) {
    string sid=ProfileSid(profileName);
    using(var forest=Inventory(specs)) {
      var entries=new List<EntryRecord>();
      foreach(var item in forest.items){var security=Security(item.opened.Handle);Need(!HasSid(security.DiscretionaryAcl,sid),"WINDOWS_PROFILE_ALREADY_GRANTED");if(item.writable)Private(security,item.root);entries.Add(new EntryRecord{identity=item.opened.Snapshot.Id,creation=item.opened.Snapshot.Creation.ToString(),label=Label(security),directory=item.opened.Directory,writable=item.writable,git=item.git,root=item.root,daclProtected=Protected(security),inheritedAces=item.git&&!Protected(security)?EncodedAces(security.DiscretionaryAcl).Where(ace=>Inherited(ace)).ToArray():new string[0],explicitAces=new string[0]});var saved=entries.Last();var flattened=new HashSet<string>(saved.inheritedAces.Select(ace=>InheritanceBit(ace,false)),StringComparer.Ordinal);saved.explicitAces=EncodedAces(security.DiscretionaryAcl).Where(ace=>!Inherited(ace)&&flattened.Contains(ace)).ToArray();}
      Stable(forest);return new ResourcePlan{schemaVersion=3,profileName=profileName,profileSid=sid,roots=forest.roots.ToArray(),entries=entries.ToArray()};
    }
  }
  public static ResourcePlan ReadPlan(string json) {
    Need(json!=null && json.Length<=8*1024*1024,"WINDOWS_RESOURCE_LIMIT");
    var serializer=new System.Web.Script.Serialization.JavaScriptSerializer();serializer.MaxJsonLength=8*1024*1024;
    // Earlier plans do not bind inherited ACE provenance. Never guess their
    // ownership or silently upgrade them during crash recovery.
    var wire=serializer.DeserializeObject(json) as Dictionary<string,object>;
    Need(wire!=null && wire.Count==5 && new[]{"schemaVersion","profileName","profileSid","roots","entries"}.All(wire.ContainsKey),"WINDOWS_RESOURCE_INVALID");
    Need(wire["schemaVersion"] is int && (int)wire["schemaVersion"]==3 && wire["profileName"] is string && wire["profileSid"] is string,"WINDOWS_RESOURCE_INVALID");
    var rootsWire=wire["roots"] as object[];Need(rootsWire!=null && rootsWire.Length>0 && rootsWire.Length<=64,"WINDOWS_RESOURCE_INVALID");
    foreach(var value in rootsWire){var root=value as Dictionary<string,object>;Need(root!=null && root.Count==5 && new[]{"path","kind","writable","identity","creation"}.All(root.ContainsKey),"WINDOWS_RESOURCE_INVALID");Need(root["writable"] is bool && new[]{"path","kind","identity","creation"}.All(key=>root[key] is string),"WINDOWS_RESOURCE_INVALID");}
    var entriesWire=wire["entries"] as object[];Need(entriesWire!=null && entriesWire.Length>0 && entriesWire.Length<=MaxResourceEntries,"WINDOWS_RESOURCE_INVALID");
    foreach(var value in entriesWire){var entry=value as Dictionary<string,object>;Need(entry!=null && entry.Count==10 && new[]{"identity","creation","label","directory","writable","git","root","daclProtected","inheritedAces","explicitAces"}.All(entry.ContainsKey),"WINDOWS_RESOURCE_INVALID");Need(new[]{"directory","writable","git","root","daclProtected"}.All(key=>entry[key] is bool) && new[]{"identity","creation","label"}.All(key=>entry[key] is string),"WINDOWS_RESOURCE_INVALID");foreach(string key in new[]{"inheritedAces","explicitAces"}){var aces=entry[key] as object[];Need(aces!=null && aces.Length<=8192 && aces.All(ace=>ace is string),"WINDOWS_RESOURCE_INVALID");}}
    var plan=serializer.Deserialize<ResourcePlan>(json);
    Need(plan!=null && plan.schemaVersion==3 && plan.profileSid==ProfileSid(plan.profileName) && plan.roots!=null && plan.entries!=null && plan.entries.Length>0 && plan.entries.Length<=MaxResourceEntries,"WINDOWS_RESOURCE_INVALID");
    Specs(plan.roots.Select(r=>new RootSpec{path=r.path,kind=r.kind,writable=r.writable}).ToArray());
    var seen=new HashSet<string>();foreach(var entry in plan.entries){Need(entry!=null && entry.identity!=null && System.Text.RegularExpressions.Regex.IsMatch(entry.identity,"^[a-f0-9]{8}:[a-f0-9]{16}$") && seen.Add(entry.identity) && entry.creation!=null && System.Text.RegularExpressions.Regex.IsMatch(entry.creation,"^[0-9]{1,19}$") && entry.label!=null && entry.label.Length<=5464,"WINDOWS_RESOURCE_INVALID");if(entry.label.Length>0){byte[] raw=Convert.FromBase64String(entry.label);Need(Convert.ToBase64String(raw)==entry.label,"WINDOWS_RESOURCE_INVALID");new RawAcl(raw,0);}ValidateInheritanceRecord(entry,plan.profileSid);}
    foreach(var root in plan.roots)Need(plan.entries.Any(e=>e.identity==root.identity && e.creation==root.creation && e.directory==(root.kind=="directory")),"WINDOWS_RESOURCE_INVALID");return plan;
  }
  static int PackageRights(bool writable,bool git,bool root) {
    int rights=writable && !git?0x001301bf:0x001200a9;
    rights&=~0x40; // A writable parent cannot delete a protected child.
    if(root)rights&=~0x10000;
    return rights;
  }
  static void VerifyPackageGrant(RawSecurityDescriptor security,string sid,bool directory,bool writable,bool git,bool root) {
    Need(security.DiscretionaryAcl!=null && (!git || Protected(security)),"WINDOWS_ACL_WRITE_FAILED");
    int expected=PackageRights(writable,git,root),count=0;bool explicitGrant=false;
    AceFlags flags=directory?AceFlags.ObjectInherit|AceFlags.ContainerInherit:AceFlags.None;
    foreach(GenericAce ace in security.DiscretionaryAcl){var qualified=ace as QualifiedAce;Need(qualified!=null,"WINDOWS_ACL_UNSUPPORTED");if(qualified.SecurityIdentifier.Value!=sid)continue;var common=ace as CommonAce;Need(common!=null && !common.IsCallback && common.AceQualifier==AceQualifier.AccessAllowed && (common.AccessMask&~expected)==0,"WINDOWS_ACL_WRITE_FAILED");count++;if(common.AceFlags==flags && common.AccessMask==expected)explicitGrant=true;}
    Need(explicitGrant && count>0 && (!git || count==1),"WINDOWS_ACL_WRITE_FAILED");
  }
  public static Dictionary<string,object> Apply(ResourcePlan plan) {
    Need(plan!=null && plan.schemaVersion==3,"WINDOWS_RESOURCE_INVALID");
    RootSpec[] specs=plan.roots.Select(r=>new RootSpec{path=r.path,kind=r.kind,writable=r.writable}).ToArray();
    using(var forest=Inventory(specs)) {
      Need(forest.items.Count==plan.entries.Length && forest.roots.Count==plan.roots.Length,"PREIMAGE_UNSAFE");
      for(int i=0;i<forest.roots.Count;i++)Need(forest.roots[i].identity==plan.roots[i].identity && forest.roots[i].creation==plan.roots[i].creation,"PREIMAGE_UNSAFE");
      var baseline=plan.entries.ToDictionary(e=>e.identity);
      foreach(var item in forest.items){EntryRecord saved;Need(baseline.TryGetValue(item.opened.Snapshot.Id,out saved) && saved.creation==item.opened.Snapshot.Creation.ToString() && saved.directory==item.opened.Directory && saved.writable==item.writable && saved.git==item.git && saved.root==item.root,"PREIMAGE_UNSAFE");var security=Security(item.opened.Handle);Need(!HasSid(security.DiscretionaryAcl,plan.profileSid) && Label(security)==saved.label && Protected(security)==saved.daclProtected,"WINDOWS_ACL_CHANGED");if(item.writable)Private(security,item.root);VerifyInheritancePreimage(security.DiscretionaryAcl,saved);}
      Stable(forest);IntPtr created=IntPtr.Zero;
      try {int status=CreateAppContainerProfile(plan.profileName,plan.profileName,"Autoprompt owned worker resources",IntPtr.Zero,0,out created);Need(status==0 && created!=IntPtr.Zero,"WINDOWS_PROFILE_CREATE_FAILED");Need(new SecurityIdentifier(created).Value==plan.profileSid,"WINDOWS_PROFILE_MISMATCH");}
      finally{if(created!=IntPtr.Zero)FreeSid(created);}
      foreach(var item in forest.items) {
        var security=Security(item.opened.Handle);var acl=WithoutSid(security.DiscretionaryAcl,plan.profileSid);var sid=new SecurityIdentifier(plan.profileSid);
        AceFlags flags=item.opened.Directory?AceFlags.ObjectInherit|AceFlags.ContainerInherit:AceFlags.None;
        // AppContainer isolation is enforced by the granted package mask, not
        // a package DENY ACE. Protect .git from the parent's writable grant
        // being automatically re-inherited by SetSecurityInfo.
        int rights=PackageRights(item.writable,item.git,item.root);
        int insert=0;while(insert<acl.Count && (acl[insert].AceFlags&AceFlags.Inherited)==0)insert++;
        acl.InsertAce(insert,new CommonAce(flags,AceQualifier.AccessAllowed,rights,sid,false,null));SetAcl(item.opened.Handle,acl,false,item.git?(bool?)true:null);
        if(item.writable && !item.git)SetLabel(item.opened.Handle,LabelFor("LW"));
      }
      foreach(var item in forest.items){var security=Security(item.opened.Handle);VerifyPackageGrant(security,plan.profileSid,item.opened.Directory,item.writable,item.git,item.root);if(item.writable && !item.git)Need(Label(security)==LabelFor("LW"),"WINDOWS_LABEL_WRITE_FAILED");}
      IntPtr folder=IntPtr.Zero;try{Need(GetAppContainerFolderPath(plan.profileSid,out folder)==0 && folder!=IntPtr.Zero,"WINDOWS_PROFILE_UNAVAILABLE");return new Dictionary<string,object>{{"profileName",plan.profileName},{"profileSid",plan.profileSid},{"profilePath",Marshal.PtrToStringUni(folder)}};}finally{if(folder!=IntPtr.Zero)CoTaskMemFree(folder);}
    }
  }
  static Opened ById(Forest forest,RootRecord volumeHint,string identity,string creation) {
    Opened volume=Volume(forest,volumeHint.path);Need(identity.Substring(0,8)==volume.Snapshot.Volume.ToString("x8"),"PREIMAGE_UNSAFE");
    var id=new FILE_ID_DESCRIPTOR{Size=(uint)Marshal.SizeOf(typeof(FILE_ID_DESCRIPTOR)),Type=0,Low=Convert.ToUInt64(identity.Substring(9),16),High=0};
    IntPtr handle=OpenFileById(volume.Handle,ref id,0x001e0081,7,IntPtr.Zero,0x02200000);
    if(handle==IntPtr.Zero || handle==new IntPtr(-1)){int error=Marshal.GetLastWin32Error();if(error!=2){var refusal=new Refusal("WINDOWS_ACL_IDENTITY_UNAVAILABLE",new System.ComponentModel.Win32Exception(error));refusal.Data["resourceIdentity"]=identity;refusal.Data["resourceCreation"]=creation;throw refusal;}return null;}
    try{Snapshot snapshot=Info(handle,true);Need(snapshot.Id==identity && snapshot.Creation.ToString()==creation,"WINDOWS_ACL_IDENTITY_MISMATCH");var item=new Opened{Handle=handle,Snapshot=snapshot,Directory=(snapshot.Attributes&FILE_ATTRIBUTE_DIRECTORY)!=0};forest.handles.Add(item);return item;}catch{CloseHandle(handle);throw;}
  }
  public static Dictionary<string,object> Restore(ResourcePlan plan) {
    Need(plan!=null && plan.schemaVersion==3,"WINDOWS_RESOURCE_INVALID");
    var baseline=plan.entries.ToDictionary(e=>e.identity);RootSpec[] specs=plan.roots.Select(r=>new RootSpec{path=r.path,kind=r.kind,writable=r.writable}).ToArray();
    using(var forest=new Forest()) {
      var seen=new HashSet<string>();
      foreach(var root in plan.roots){Opened held=ById(forest,root,root.identity,root.creation);Need(held!=null,"WINDOWS_RESOURCE_ROOT_MISSING");Walk(forest,held,root.path,specs,seen,0,true);}
      // Original objects are found by NTFS file ID even after a rename outside
      // the original name. Missing originals are never matched to replacements.
      foreach(var old in plan.entries)if(!seen.Contains(old.identity)){var hint=plan.roots.First(r=>r.identity.Substring(0,8)==old.identity.Substring(0,8));Opened held=ById(forest,hint,old.identity,old.creation);if(held!=null){Need(forest.items.Count<MaxRecoveryEntries,"WINDOWS_RESOURCE_LIMIT");seen.Add(old.identity);forest.items.Add(new Item{opened=held,writable=old.writable,git=old.git,root=old.root});}}
      int restored=0,created=0;
      foreach(var item in forest.items) {
        var security=Security(item.opened.Handle);EntryRecord old;bool existed=baseline.TryGetValue(item.opened.Snapshot.Id,out old);
        if(existed)Need(old.creation==item.opened.Snapshot.Creation.ToString(),"WINDOWS_ACL_IDENTITY_MISMATCH");
        // Keep live unrelated ACEs. Only .git objects in the v3 baseline can
        // own a protection transition. A different transition without our
        // package grant is external and cannot be silently rolled back.
        bool hasPackage=HasSid(security.DiscretionaryAcl,plan.profileSid);bool? protection=null;
        if(existed && old.git && Protected(security)!=old.daclProtected){
          Need(!old.daclProtected && Protected(security) && hasPackage,"WINDOWS_ACL_PROTECTION_CHANGED");
          VerifyPackageGrant(security,plan.profileSid,item.opened.Directory,old.writable,true,old.root);protection=false;
        }
        if(hasPackage || protection.HasValue){var acl=WithoutSid(security.DiscretionaryAcl,plan.profileSid);if(protection==false)acl=DecodedAcl(acl.Revision,RestoreInheritanceAces(EncodedAces(acl),old.inheritedAces,old.explicitAces));SetAcl(item.opened.Handle,acl,false,protection);}
        if(existed && old.git)Need(Protected(Security(item.opened.Handle))==old.daclProtected,"WINDOWS_ACL_RESTORE_FAILED");
        bool labelOwned=existed?old.writable && !old.git:item.writable && !item.git;
        if(labelOwned){string label=Label(Security(item.opened.Handle));string wanted=existed?old.label:LabelFor("ME");Need(label==LabelFor("LW") || label==wanted || (!existed && label==""),"WINDOWS_LABEL_CHANGED");if(label!=wanted && !(label=="" && !existed))SetLabel(item.opened.Handle,wanted);}
        Need(!HasSid(Security(item.opened.Handle).DiscretionaryAcl,plan.profileSid),"WINDOWS_ACL_RESTORE_FAILED");if(existed)restored++;else created++;
      }
      int deleted=plan.entries.Length-restored;int result=DeleteAppContainerProfile(plan.profileName);Need(result==0 || result==unchecked((int)0x80070002),"WINDOWS_PROFILE_DELETE_FAILED");
      return new Dictionary<string,object>{{"restored",restored},{"newEntries",created},{"deletedEntries",deleted}};
    }
  }
}
