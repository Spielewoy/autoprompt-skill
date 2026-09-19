# Unwired Windows HANDLE-relative file and tree capture primitive.
#
# The protocol is deliberately closed: stdin contains one JSON object with a
# physical NTFS drive root, a bounded sequence of child names, a maximum byte
# count and `read`, `hash`, or `tree`.  It does not accept paths below the root,
# native symbol names, access masks, or output paths.  Data for `read` is
# returned as bounded base64 JSON; Windows HANDLE inheritance is intentionally
# not treated as POSIX fd 3.
[CmdletBinding()]
param([switch]$Request)

$captureClock = [System.Diagnostics.Stopwatch]::StartNew()
# Windows PowerShell may reconstruct an empty inherited module path on first
# cmdlet lookup. Pin the inbox path after startup, before any module autoload.
[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$capturePhases = $env:AUTOPROMPT_CAPTURE_PHASES -ceq '1'
$captureLastPhase = $null
function Write-CapturePhase([string]$phase) {
  $script:captureLastPhase = $phase
  if ($capturePhases) {
    $elapsed = $captureClock.ElapsedMilliseconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    [Console]::Error.WriteLine('AUTOPROMPT_CAPTURE_PHASE:' + $phase + ':' + $elapsed)
  }
}

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

public static class AutopromptWindowsCapture {
  const uint FILE_READ_DATA = 0x00000001, FILE_READ_ATTRIBUTES = 0x00000080, SYNCHRONIZE = 0x00100000;
  const uint FILE_SHARE_READ = 0x00000001, FILE_SHARE_WRITE = 0x00000002, FILE_SHARE_DELETE = 0x00000004, FILE_OPEN = 1;
  const uint FILE_DIRECTORY_FILE = 0x00000001, FILE_NON_DIRECTORY_FILE = 0x00000040;
  const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020, FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint OBJ_CASE_INSENSITIVE = 0x00000040, FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const uint FILE_TYPE_DISK = 1, DRIVE_FIXED = 3;
  const int MaxBytes = 64 * 1024 * 1024, MaxRecordBytes = 8 * 1024 * 1024 + 1;
  const int MaxTreeEntries = 16384, MaxCleanupEntries = 32768, MaxRecordEntries = 4096;

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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr input, uint inputLength, IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr h, System.Text.StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetDriveType(string root);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandle(IntPtr h, IntPtr name, uint nameSize,
    out uint serial, out uint maxComponent, out uint flags, System.Text.StringBuilder fsName, uint fsNameSize);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint QueryDosDevice(string device, System.Text.StringBuilder target, uint targetSize);

  public sealed class Refusal : Exception { public readonly string Code; public Refusal(string code) { Code = code; } }
  // This is a bounded JSON token reader, not a property-name regex.  It
  // decodes JSON string escapes before checking duplicates, so `root` and
  // `r\\u006fot` cannot be silently collapsed by ConvertFrom-Json.
  sealed class JsonTokens {
    readonly string Text; int Position; const int MaxDepth = 32, MaxProperties = 1024; int Properties;
    JsonTokens(string text) { Text = text; }
    static void Fail() { throw new Refusal("FILESYSTEM_REQUEST_INVALID"); }
    void White() { while (Position < Text.Length && (Text[Position] == ' ' || Text[Position] == '\t' || Text[Position] == '\r' || Text[Position] == '\n')) Position++; }
    char Take() { if (Position >= Text.Length) Fail(); return Text[Position++]; }
    void Word(string word) { for (int i = 0; i < word.Length; i++) if (Take() != word[i]) Fail(); }
    static int Hex(char c) { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; if (c >= 'A' && c <= 'F') return c - 'A' + 10; Fail(); return 0; }
    string String() {
      if (Take() != '"') Fail(); var value = new System.Text.StringBuilder();
      while (true) {
        char c = Take(); if (c == '"') return value.ToString(); if (c < 0x20) Fail();
        if (c != '\\') { value.Append(c); continue; }
        c = Take(); if (c == '"' || c == '\\' || c == '/') value.Append(c);
        else if (c == 'b') value.Append('\b'); else if (c == 'f') value.Append('\f'); else if (c == 'n') value.Append('\n'); else if (c == 'r') value.Append('\r'); else if (c == 't') value.Append('\t');
        else if (c == 'u') { int code = (Hex(Take()) << 12) | (Hex(Take()) << 8) | (Hex(Take()) << 4) | Hex(Take()); value.Append((char)code); }
        else Fail();
      }
    }
    void Number() {
      if (Position < Text.Length && Text[Position] == '-') Position++; if (Position >= Text.Length) Fail();
      if (Text[Position] == '0') Position++; else { if (Text[Position] < '1' || Text[Position] > '9') Fail(); while (Position < Text.Length && Text[Position] >= '0' && Text[Position] <= '9') Position++; }
      if (Position < Text.Length && Text[Position] == '.') { Position++; int start = Position; while (Position < Text.Length && Text[Position] >= '0' && Text[Position] <= '9') Position++; if (Position == start) Fail(); }
      if (Position < Text.Length && (Text[Position] == 'e' || Text[Position] == 'E')) { Position++; if (Position < Text.Length && (Text[Position] == '+' || Text[Position] == '-')) Position++; int start = Position; while (Position < Text.Length && Text[Position] >= '0' && Text[Position] <= '9') Position++; if (Position == start) Fail(); }
    }
    void Value(int depth) {
      if (depth > MaxDepth) Fail(); White(); if (Position >= Text.Length) Fail(); char c = Text[Position];
      if (c == '{') Object(depth + 1); else if (c == '[') Array(depth + 1); else if (c == '"') String(); else if (c == 't') Word("true"); else if (c == 'f') Word("false"); else if (c == 'n') Word("null"); else Number();
    }
    void Object(int depth) {
      Take(); White(); var keys = new HashSet<string>(StringComparer.Ordinal); if (Position < Text.Length && Text[Position] == '}') { Position++; return; }
      while (true) { White(); string key = String(); if (++Properties > MaxProperties || !keys.Add(key)) Fail(); White(); if (Take() != ':') Fail(); Value(depth); White(); char end = Take(); if (end == '}') return; if (end != ',') Fail(); }
    }
    void Array(int depth) {
      Take(); White(); if (Position < Text.Length && Text[Position] == ']') { Position++; return; }
      while (true) { Value(depth); White(); char end = Take(); if (end == ']') return; if (end != ',') Fail(); }
    }
    public static void Validate(string text) {
      if (text == null || text.Length == 0 || text.Length > 12 * 1024 * 1024) Fail(); var parser = new JsonTokens(text); parser.White();
      if (parser.Position == text.Length || text[parser.Position] != '{') Fail(); parser.Object(1); parser.White(); if (parser.Position != text.Length) Fail();
    }
  }
  sealed class Snapshot {
    public uint Volume, Attributes, Links, SizeHigh, SizeLow, IndexHigh, IndexLow; public long LastWrite;
    public long Size { get { return ((long)SizeHigh << 32) | SizeLow; } }
    public string Id { get { return Volume.ToString("x8") + ":" + IndexHigh.ToString("x8") + IndexLow.ToString("x8"); } }
    public bool Same(Snapshot other) { return other != null && Volume == other.Volume && Attributes == other.Attributes && Links == other.Links &&
      SizeHigh == other.SizeHigh && SizeLow == other.SizeLow && IndexHigh == other.IndexHigh && IndexLow == other.IndexLow && LastWrite == other.LastWrite; }
  }
  sealed class Opened { public IntPtr Handle; public string Name; public Snapshot Snapshot; public bool Directory; }

  static void Need(bool condition, string code) { if (!condition) throw new Refusal(code); }
  public static void ValidateJson(string text) { JsonTokens.Validate(text); }
  static Snapshot Info(IntPtr h) {
    BY_HANDLE_FILE_INFORMATION i;
    if (!GetFileInformationByHandle(h, out i)) throw new Refusal("PREIMAGE_UNSAFE");
    if (GetFileType(h) != FILE_TYPE_DISK || (i.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new Refusal("PREIMAGE_UNSAFE");
    return new Snapshot { Volume=i.VolumeSerialNumber, Attributes=i.FileAttributes, Links=i.NumberOfLinks, SizeHigh=i.FileSizeHigh, SizeLow=i.FileSizeLow,
      IndexHigh=i.FileIndexHigh, IndexLow=i.FileIndexLow, LastWrite=i.LastWriteTime.Value };
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
  static IntPtr Open(string name, IntPtr parent, bool directory, bool createWritable = false, bool shareAll = false, bool readSecurity = false, bool deleteExisting = false, bool anyType = false, bool allowMissing = false, uint extraAccess = 0, bool shareDelete = false) {
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
      uint share = directory || shareAll ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_READ | (shareDelete ? FILE_SHARE_DELETE : 0u);
      uint desired = FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE | (createWritable ? 0x00030002u : 0u) | (readSecurity ? 0x00020000u : 0u) | (deleteExisting ? 0x00010000u : 0u) | extraAccess;
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
      Need(SameDirectoryIdentity(held[0].Snapshot, Info(fresh)), "PREIMAGE_UNSAFE");
      for (int i = 1; i < held.Count; i++) {
        IntPtr child = IntPtr.Zero;
        try { child = Open(held[i].Name, held[i - 1].Handle, held[i].Directory); CheckCanonicalComponentName(child, held[i].Name); Need(held[i].Directory ? SameDirectoryIdentity(held[i].Snapshot, Info(child)) : held[i].Snapshot.Same(Info(child)), "PREIMAGE_UNSAFE"); }
        finally { if (child != IntPtr.Zero) CloseHandle(child); }
      }
      // Ancestors name the held target; their unrelated children are outside
      // this capture. Preserve identity/type/attributes/link checks without
      // treating an unrelated sibling update as a changed target preimage.
      for (int i = 0; i < held.Count; i++) Need(held[i].Directory ? SameDirectoryIdentity(held[i].Snapshot, Info(held[i].Handle)) : held[i].Snapshot.Same(Info(held[i].Handle)), "PREIMAGE_UNSAFE");
    } finally { if (fresh != IntPtr.Zero) CloseHandle(fresh); }
  }
  sealed class DirectoryEntry {
    public string Name; public uint Attributes; public ulong Id;
    public bool Same(DirectoryEntry other) { return Name == other.Name && Attributes == other.Attributes && Id == other.Id; }
  }
  sealed class TreeNode {
    public Opened Opened, Parent; public string Path; public List<DirectoryEntry> Children;
    public Dictionary<string, object> Result;
  }
  // FileIdFullDirectoryInformation (class 38) is enumerated exclusively from
  // a held directory HANDLE. Dot records are structural, never child opens.
  static List<DirectoryEntry> EnumerateHeld(IntPtr directory, int maxEntries) {
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
            Need(ValidComponent(name) && names.Add(name) && (attrs & FILE_ATTRIBUTE_REPARSE_POINT) == 0, "PREIMAGE_UNSAFE");
            Need(result.Count < maxEntries, "FILESYSTEM_CAPTURE_LIMIT");
            result.Add(new DirectoryEntry { Name=name, Attributes=attrs, Id=id });
          }
          if (next == 0) break;
          offset += next;
        }
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    result.Sort((a, b) => StringComparer.Ordinal.Compare(a.Name, b.Name)); return result;
  }
  static Dictionary<string, object> Stat(Snapshot snapshot) {
    bool directory = (snapshot.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0, readOnly = (snapshot.Attributes & 1) != 0;
    int mode = directory ? 16384 | (readOnly ? 292 : 438) : 32768 | (readOnly ? 292 : 438);
    return new Dictionary<string, object> { {"dev", snapshot.Volume.ToString()}, {"ino", (((ulong)snapshot.IndexHigh << 32) | snapshot.IndexLow).ToString()},
      {"mode", mode}, {"nlink", snapshot.Links}, {"size", snapshot.Size} };
  }
  static int ReadBufferLength(long length) {
    Need(length >= 0 && length <= MaxBytes, "FILESYSTEM_CAPTURE_LIMIT");
    return checked((int)Math.Min(1024L * 1024, Math.Max(1L, length)));
  }
  static Dictionary<string, object> ReadCapturedFile(Opened file, bool includeBytes, int maxBytes) {
    Need(file.Snapshot.Size >= 0 && file.Snapshot.Size <= maxBytes, "FILESYSTEM_CAPTURE_LIMIT");
    long length = file.Snapshot.Size; byte[] firstBytes = includeBytes ? new byte[(int)length] : null;
    string digest = null;
    // Re-read while holding the non-write/non-delete-shared HANDLE. Existing
    // writable mappings still require owned-writer quiescence for atomicity.
    for (int pass = 0; pass < 2; pass++) {
      long reset; Need(SetFilePointerEx(file.Handle, 0, out reset, 0) && reset == 0, "PREIMAGE_UNSAFE");
      using (SHA256 hash = SHA256.Create()) {
        long remaining = length; int offset = 0; byte[] buffer = new byte[ReadBufferLength(length)];
        while (remaining > 0) {
          uint got, wanted = (uint)Math.Min((long)buffer.Length, remaining);
          Need(ReadFile(file.Handle, buffer, wanted, out got, IntPtr.Zero) && got > 0 && got <= wanted, "PREIMAGE_UNSAFE");
          hash.TransformBlock(buffer, 0, (int)got, null, 0);
          if (firstBytes != null) {
            if (pass == 0) Buffer.BlockCopy(buffer, 0, firstBytes, offset, (int)got);
            else for (int i = 0; i < (int)got; i++) Need(firstBytes[offset + i] == buffer[i], "PREIMAGE_UNSAFE");
          }
          remaining -= got; offset += (int)got;
        }
        uint extra; Need(ReadFile(file.Handle, buffer, 1, out extra, IntPtr.Zero) && extra == 0, "PREIMAGE_UNSAFE");
        hash.TransformFinalBlock(new byte[0], 0, 0);
        string current = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
        if (pass == 0) digest = current; else Need(current == digest, "PREIMAGE_UNSAFE");
      }
    }
    Need(file.Snapshot.Same(Info(file.Handle)), "PREIMAGE_UNSAFE");
    var result = new Dictionary<string, object> { {"identity", file.Snapshot.Id}, {"length", length}, {"sha256", digest}, {"stat", Stat(file.Snapshot)} };
    if (includeBytes) result["dataBase64"] = Convert.ToBase64String(firstBytes);
    return result;
  }
  static void WalkTree(TreeNode node, List<TreeNode> nodes, List<Opened> all, ref long total, int maxBytes, int depth, int maxEntries, bool cleanup = false) {
    Need(depth <= 128, "FILESYSTEM_CAPTURE_LIMIT");
    node.Children = EnumerateHeld(node.Opened.Handle, maxEntries);
    foreach (DirectoryEntry entry in node.Children) {
      Need(nodes.Count < maxEntries && depth < 128, "FILESYSTEM_CAPTURE_LIMIT");
      bool directory = (entry.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      Opened child = cleanup ? OpenOwned(entry.Name, node.Opened.Handle, true, false) : OpenChecked(entry.Name, node.Opened.Handle, directory, !directory, true); all.Add(child);
      Need(child.Directory == directory, "PREIMAGE_UNSAFE");
      Need(child.Snapshot.Volume == node.Opened.Snapshot.Volume && child.Snapshot.Attributes == entry.Attributes &&
        (((ulong)child.Snapshot.IndexHigh << 32) | child.Snapshot.IndexLow) == entry.Id, "PREIMAGE_UNSAFE");
      var item = new TreeNode { Opened=child, Parent=node.Opened, Path=node.Path.Length == 0 ? entry.Name : node.Path + "/" + entry.Name };
      nodes.Add(item);
      if (directory) WalkTree(item, nodes, all, ref total, maxBytes, depth + 1, maxEntries, cleanup);
      else { item.Result = ReadCapturedFile(child, true, (int)(maxBytes - total)); total += child.Snapshot.Size; }
    }
  }
  public static Dictionary<string, object> CaptureTree(string root, string[] components, int maxBytes) {
    ValidateCaptureRequest(root, components, maxBytes);
    string rootMapping = PhysicalDriveMapping(root), nativeRoot = "\\??\\" + root;
    var chain = new List<Opened>(); var all = new List<Opened>(); var nodes = new List<TreeNode>();
    try {
      Opened drive = OpenChecked(nativeRoot, IntPtr.Zero, true, false, false); all.Add(drive); chain.Add(drive);
      ValidateRootVolume(drive.Handle, root, rootMapping);
      foreach (string part in components) { Opened child = OpenChecked(part, chain[chain.Count - 1].Handle, true, false, true); all.Add(child); chain.Add(child); }
      var top = new TreeNode { Opened=chain[chain.Count - 1], Path="" }; nodes.Add(top);
      long total = 0; WalkTree(top, nodes, all, ref total, maxBytes, 0, MaxTreeEntries);
      // Every parent and child remains open through full re-enumeration and
      // relative reopen validation, including the final file-content pass.
      foreach (TreeNode node in nodes) {
        if (node.Opened.Directory) {
          List<DirectoryEntry> again = EnumerateHeld(node.Opened.Handle, MaxTreeEntries);
          Need(again.Count == node.Children.Count, "PREIMAGE_UNSAFE");
          for (int i = 0; i < again.Count; i++) Need(again[i].Same(node.Children[i]), "PREIMAGE_UNSAFE");
        } else {
          var again = ReadCapturedFile(node.Opened, false, (int)node.Opened.Snapshot.Size);
          Need((string)again["sha256"] == (string)node.Result["sha256"], "PREIMAGE_UNSAFE");
        }
        if (node.Parent != null) {
          IntPtr fresh = IntPtr.Zero;
          try { fresh = Open(node.Opened.Name, node.Parent.Handle, node.Opened.Directory); CheckCanonicalComponentName(fresh, node.Opened.Name); Need(node.Opened.Snapshot.Same(Info(fresh)), "PREIMAGE_UNSAFE"); }
          finally { if (fresh != IntPtr.Zero) CloseHandle(fresh); }
        }
      }
      Verify(chain, nativeRoot); ValidateRootVolume(drive.Handle, root, rootMapping);
      // Opened has reference identity: preserve the exact membership predicate
      // without scanning the captured tree once for every retained handle.
      var capturedHandles = new HashSet<Opened>();
      foreach (TreeNode node in nodes) capturedHandles.Add(node.Opened);
      foreach (Opened item in all) {
        bool captured = capturedHandles.Contains(item);
        Need(captured ? item.Snapshot.Same(Info(item.Handle)) : SameDirectoryIdentity(item.Snapshot, Info(item.Handle)), "PREIMAGE_UNSAFE");
      }
      var entries = new List<Dictionary<string, object>>();
      foreach (TreeNode node in nodes) {
        var entry = node.Result ?? new Dictionary<string, object> { {"identity", node.Opened.Snapshot.Id}, {"stat", Stat(node.Opened.Snapshot)} };
        entry["path"] = node.Path; entry["type"] = node.Opened.Directory ? "directory" : "file"; entry["attributes"] = node.Opened.Snapshot.Attributes;
        entries.Add(entry);
      }
      return new Dictionary<string, object> { {"bytes", total}, {"entries", entries} };
    } finally { for (int i = all.Count - 1; i >= 0; i--) CloseHandle(all[i].Handle); }
  }
  static bool SameDirectoryIdentity(Snapshot a, Snapshot b) {
    return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow && a.Attributes == b.Attributes && a.Links == b.Links;
  }
  static void VerifyMutationParents(List<Opened> chain, string nativeRoot) {
    for (int i = 0; i < chain.Count; i++) {
      IntPtr fresh = IntPtr.Zero;
      try {
        fresh = Open(i == 0 ? nativeRoot : chain[i].Name, i == 0 ? IntPtr.Zero : chain[i - 1].Handle, true);
        if (i > 0) CheckCanonicalComponentName(fresh, chain[i].Name);
        Need(SameDirectoryIdentity(chain[i].Snapshot, Info(fresh)) && SameDirectoryIdentity(chain[i].Snapshot, Info(chain[i].Handle)), "PREIMAGE_UNSAFE");
      } finally { if (fresh != IntPtr.Zero) CloseHandle(fresh); }
    }
  }
  static void RenameRecord(IntPtr file, IntPtr parent, string leaf) {
    byte[] name = System.Text.Encoding.Unicode.GetBytes(leaf);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4, lengthOffset = rootOffset + IntPtr.Size, nameOffset = lengthOffset + 4;
    IntPtr information = Marshal.AllocHGlobal(nameOffset + name.Length);
    try {
      for (int i = 0; i < nameOffset; i++) Marshal.WriteByte(information, i, 0); // ReplaceIfExists = FALSE
      Marshal.WriteIntPtr(information, rootOffset, parent); Marshal.WriteInt32(information, lengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(information, nameOffset), name.Length);
      IO_STATUS_BLOCK io; int status = NtSetInformationFile(file, out io, information, (uint)(nameOffset + name.Length), 10);
      if (status == unchecked((int)0xc0000035)) throw new Refusal("FILESYSTEM_ALREADY_EXISTS");
      if (status == unchecked((int)0xc00000d4)) throw new Refusal("FILESYSTEM_CROSS_DEVICE");
      Need(status == 0, "PREIMAGE_UNSAFE");
    } finally { Marshal.FreeHGlobal(information); }
  }
  static void DeleteOwnedTemporary(IntPtr file) {
    IntPtr information = Marshal.AllocHGlobal(1);
    try { Marshal.WriteByte(information, 1); IO_STATUS_BLOCK io; NtSetInformationFile(file, out io, information, 1, 13); }
    finally { Marshal.FreeHGlobal(information); }
  }
  static void RequirePrivateAcl(IntPtr file) {
    IntPtr owner, group, dacl, sacl, descriptor;
    Need(GetSecurityInfo(file, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) == 0, "PREIMAGE_UNSAFE");
    try {
      uint length = GetSecurityDescriptorLength(descriptor); Need(length > 0 && length <= 65536, "PREIMAGE_UNSAFE");
      byte[] raw = new byte[(int)length]; Marshal.Copy(descriptor, raw, 0, raw.Length);
      var security = new System.Security.AccessControl.RawSecurityDescriptor(raw, 0);
      var current = System.Security.Principal.WindowsIdentity.GetCurrent().User;
      Need(current != null && current.Equals(security.Owner) && security.DiscretionaryAcl != null, "PREIMAGE_UNSAFE");
      foreach (System.Security.AccessControl.GenericAce ace in security.DiscretionaryAcl) {
        var common = ace as System.Security.AccessControl.CommonAce;
        Need(common != null && !common.IsCallback, "PREIMAGE_UNSAFE");
        if (common.AceQualifier == System.Security.AccessControl.AceQualifier.AccessDenied) continue;
        Need(common.AceQualifier == System.Security.AccessControl.AceQualifier.AccessAllowed, "PREIMAGE_UNSAFE");
        string sid = common.SecurityIdentifier.Value;
        Need(sid == current.Value || sid == "S-1-5-18" || sid == "S-1-5-32-544" ||
          (sid == "S-1-3-0" && (common.AceFlags & System.Security.AccessControl.AceFlags.InheritOnly) != 0), "PREIMAGE_UNSAFE");
      }
    } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
  }
  static void RequireDeadWriter(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) { Need(Marshal.GetLastWin32Error() == 87, "RUN_RECORD_BUSY"); return; }
    try { uint code; Need(GetExitCodeProcess(process, out code) && code != 259, "RUN_RECORD_BUSY"); }
    finally { CloseHandle(process); }
  }
  static List<string> RecoverRecord(Opened parent, string leaf) {
    RequirePrivateAcl(parent.Handle);
    var removed = new List<string>();
    var pattern = new System.Text.RegularExpressions.Regex("^\\." + System.Text.RegularExpressions.Regex.Escape(leaf) + "\\.([1-9][0-9]{0,9})\\.[0-9a-f]{16}\\.(?:tmp|create)$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    // Complete bounded enumeration precedes any residue deletion. Tree growth
    // does not increase private record-recovery authority.
    foreach (DirectoryEntry entry in EnumerateHeld(parent.Handle, MaxRecordEntries)) {
      var match = pattern.Match(entry.Name); if (!match.Success) continue;
      uint pid; Need(UInt32.TryParse(match.Groups[1].Value, out pid) && pid > 0, "PREIMAGE_UNSAFE"); RequireDeadWriter(pid);
      IntPtr file = IntPtr.Zero;
      try {
        file = Open(entry.Name, parent.Handle, false, false, false, true, true);
        Snapshot held = Info(file);
        Need(held.Links == 1 && held.Size >= 0 && held.Size <= MaxRecordBytes && held.Volume == parent.Snapshot.Volume && held.Attributes == entry.Attributes &&
          (((ulong)held.IndexHigh << 32) | held.IndexLow) == entry.Id, "PREIMAGE_UNSAFE");
        CheckCanonicalComponentName(file, entry.Name); RequirePrivateAcl(file); RequireDeadWriter(pid);
        // The DELETE-capable handle denies concurrent write/delete sharing.
        // Disposition affects this exact object even if ancestors are renamed.
        Need(held.Same(Info(file)), "PREIMAGE_UNSAFE");
        IntPtr information = Marshal.AllocHGlobal(1);
        try { Marshal.WriteByte(information, 1); IO_STATUS_BLOCK io; Need(NtSetInformationFile(file, out io, information, 1, 13) == 0, "PREIMAGE_UNSAFE"); }
        finally { Marshal.FreeHGlobal(information); }
        removed.Add(entry.Name);
      } finally { if (file != IntPtr.Zero) CloseHandle(file); }
    }
    return removed;
  }
  public static Dictionary<string, object> RecordOperation(string operation, string root, string[] components, string bytesBase64) {
    ValidateCaptureRequest(root, components, MaxRecordBytes);
    Need(operation == "assert-record-parent" || operation == "publish-record-exclusive" || operation == "recover-record-publication", "FILESYSTEM_REQUEST_INVALID");
    byte[] bytes = null;
    if (operation == "publish-record-exclusive") {
      Need(bytesBase64 != null && bytesBase64.Length <= ((MaxRecordBytes + 2) / 3) * 4, "FILESYSTEM_CAPTURE_LIMIT");
      try { bytes = Convert.FromBase64String(bytesBase64); } catch { throw new Refusal("FILESYSTEM_REQUEST_INVALID"); }
      Need(bytes.Length <= MaxRecordBytes && Convert.ToBase64String(bytes) == bytesBase64, "FILESYSTEM_REQUEST_INVALID");
    }
    string mapping = PhysicalDriveMapping(root), nativeRoot = "\\??\\" + root;
    var chain = new List<Opened>(); IntPtr file = IntPtr.Zero; bool published = false;
    try {
      chain.Add(OpenChecked(nativeRoot, IntPtr.Zero, true, false, false, true)); ValidateRootVolume(chain[0].Handle, root, mapping);
      for (int i = 0; i < components.Length - 1; i++) chain.Add(OpenChecked(components[i], chain[chain.Count - 1].Handle, true, false, true, true));
      Verify(chain, nativeRoot);
      Opened parent = chain[chain.Count - 1]; string leaf = components[components.Length - 1];
      RequirePrivateAcl(parent.Handle);
      if (operation == "recover-record-publication") {
        List<string> removed = RecoverRecord(parent, leaf); VerifyMutationParents(chain, nativeRoot); ValidateRootVolume(chain[0].Handle, root, mapping);
        return new Dictionary<string, object> { {"removed", removed} };
      }
      if (operation == "assert-record-parent") return new Dictionary<string, object> { {"identity", parent.Snapshot.Id}, {"stat", Stat(parent.Snapshot)} };
      string temporary = "." + leaf + "." + GetCurrentProcessId().ToString() + "." + Guid.NewGuid().ToString("N").Substring(0, 16) + (leaf == "terminal-finalization-intent.json" ? ".tmp" : ".create");
      Need(ValidComponent(temporary), "FILESYSTEM_CAPTURE_LIMIT");
      file = Open(temporary, parent.Handle, false, true);
      Snapshot created = Info(file); Need(created.Links == 1 && created.Size == 0 && (created.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0, "PREIMAGE_UNSAFE");
      CheckCanonicalComponentName(file, temporary); RequirePrivateAcl(file);
      int offset = 0;
      while (offset < bytes.Length) {
        byte[] remaining = new byte[bytes.Length - offset]; Buffer.BlockCopy(bytes, offset, remaining, 0, remaining.Length);
        uint written; Need(WriteFile(file, remaining, (uint)remaining.Length, out written, IntPtr.Zero) && written > 0 && written <= remaining.Length, "PREIMAGE_UNSAFE"); offset += (int)written;
      }
      Need(FlushFileBuffers(file), "PREIMAGE_UNSAFE");
      Snapshot beforeRename = Info(file); Need(created.Id == beforeRename.Id && beforeRename.Links == 1 && beforeRename.Size == bytes.Length, "PREIMAGE_UNSAFE");
      var opened = new Opened { Handle=file, Name=temporary, Snapshot=beforeRename, Directory=false };
      var captured = ReadCapturedFile(opened, true, MaxRecordBytes);
      Need((string)captured["dataBase64"] == bytesBase64, "PREIMAGE_UNSAFE");
      VerifyMutationParents(chain, nativeRoot); ValidateRootVolume(chain[0].Handle, root, mapping);
      RenameRecord(file, parent.Handle, leaf); published = true;
      // File flushing includes this handle's metadata; this is a process-crash
      // publication boundary, not a volume-wide power-loss guarantee.
      Need(FlushFileBuffers(file), "PREIMAGE_UNSAFE"); CheckCanonicalComponentName(file, leaf);
      Snapshot final = Info(file); Need(final.Id == beforeRename.Id && final.Links == 1 && final.Size == bytes.Length, "PREIMAGE_UNSAFE");
      IntPtr fresh = IntPtr.Zero;
      try { fresh = Open(leaf, parent.Handle, false, false, true); CheckCanonicalComponentName(fresh, leaf); Need(final.Same(Info(fresh)), "PREIMAGE_UNSAFE"); }
      finally { if (fresh != IntPtr.Zero) CloseHandle(fresh); }
      VerifyMutationParents(chain, nativeRoot); ValidateRootVolume(chain[0].Handle, root, mapping);
      return new Dictionary<string, object> { {"identity", final.Id}, {"stat", Stat(final)}, {"length", final.Size}, {"sha256", captured["sha256"]} };
    } finally {
      // Cleanup authority is the original, still-open temporary HANDLE. A
      // crash residue has no terminal authority and is never deleted by name.
      if (file != IntPtr.Zero) { if (!published) DeleteOwnedTemporary(file); CloseHandle(file); }
      for (int i = chain.Count - 1; i >= 0; i--) CloseHandle(chain[i].Handle);
    }
  }
  static Opened OpenOwned(string name, IntPtr parent, bool deleting, bool allowMissing) {
    IntPtr handle = Open(name, parent, false, false, false, false, deleting, true, allowMissing);
    try {
      Snapshot snapshot = Info(handle); bool directory = (snapshot.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      Need(directory || snapshot.Links == 1, "PREIMAGE_UNSAFE"); CheckCanonicalComponentName(handle, name);
      return new Opened { Handle=handle, Snapshot=snapshot, Directory=directory, Name=name };
    } catch { CloseHandle(handle); throw; }
  }
  static Dictionary<string, object> OwnedIdentity(Opened item, bool includeType) {
    var result = new Dictionary<string, object> { {"dev", item.Snapshot.Volume.ToString()}, {"ino", (((ulong)item.Snapshot.IndexHigh << 32) | item.Snapshot.IndexLow).ToString()} };
    if (includeType) result["type"] = item.Directory ? "directory" : "file";
    return result;
  }
  static bool MatchesOwned(Opened item, string dev, string ino) {
    return item.Snapshot.Volume.ToString() == dev && (((ulong)item.Snapshot.IndexHigh << 32) | item.Snapshot.IndexLow).ToString() == ino;
  }
  [DllImport("ntdll.dll")] static extern int NtFlushBuffersFileEx(IntPtr handle, uint flags, IntPtr parameters, uint size, out IO_STATUS_BLOCK io);
  sealed class TransactionParent : IDisposable {
    public string Root, Mapping, NativeRoot, Leaf; public List<Opened> Chain = new List<Opened>();
    public Opened Parent { get { return Chain[Chain.Count-1]; } }
    public TransactionParent(string root,string[] parts,bool writable) {
      ValidateCaptureRequest(root,parts,MaxBytes); Root=root;Mapping=PhysicalDriveMapping(root);NativeRoot="\\??\\"+root;Leaf=parts[parts.Length-1];
      try {
        Chain.Add(TransactionOpen(NativeRoot,IntPtr.Zero,true,false,parts.Length==1 && writable?4u:0u,false,false,false));ValidateRootVolume(Chain[0].Handle,Root,Mapping);
        for(int i=0;i<parts.Length-1;i++)Chain.Add(TransactionOpen(parts[i],Parent.Handle,true,false,i==parts.Length-2 && writable?4u:0u,false,false,false));
        VerifyNow();
      } catch {Dispose();throw;}
    }
    public void VerifyNow() {VerifyMutationParents(Chain,NativeRoot);ValidateRootVolume(Chain[0].Handle,Root,Mapping);}
    public void Dispose() {for(int i=Chain.Count-1;i>=0;i--)CloseHandle(Chain[i].Handle);Chain.Clear();}
  }
  static Opened TransactionOpen(string name,IntPtr parent,bool directory,bool create,uint extra,bool any,bool missing,bool shareDelete) {
    IntPtr handle=Open(name,parent,directory,create,false,false,false,any,missing,extra,shareDelete);
    try {var info=Info(handle);bool isDirectory=(info.Attributes&FILE_ATTRIBUTE_DIRECTORY)!=0;Need((any || isDirectory==directory) && (isDirectory || info.Links==1),"PREIMAGE_UNSAFE");if(parent!=IntPtr.Zero)CheckCanonicalComponentName(handle,name);return new Opened{Handle=handle,Snapshot=info,Directory=isDirectory,Name=name};}
    catch {CloseHandle(handle);throw;}
  }
  static void TransactionFlush(IntPtr handle) {
    IO_STATUS_BLOCK io;Need(NtFlushBuffersFileEx(handle,0,IntPtr.Zero,0,out io)==0,"FILESYSTEM_DURABILITY_UNAVAILABLE");
  }
  static long TransactionUsn(IntPtr handle) {
    const uint FSCTL_READ_FILE_USN_DATA=0x000900eb;IntPtr buffer=Marshal.AllocHGlobal(512);
    try {
      uint returned;Need(DeviceIoControl(handle,FSCTL_READ_FILE_USN_DATA,IntPtr.Zero,0,buffer,512,out returned,IntPtr.Zero) && returned>=60,"FILESYSTEM_DURABILITY_UNAVAILABLE");
      int recordLength=Marshal.ReadInt32(buffer,0);short major=Marshal.ReadInt16(buffer,4);
      // The USN offset below is the documented USN_RECORD_V2 layout. Fail
      // closed if NTFS returns V3/V4 or a truncated record rather than reading
      // a different version at the V2 offset.
      Need(major==2 && recordLength>=60 && recordLength<=returned,"FILESYSTEM_DURABILITY_UNAVAILABLE");return Marshal.ReadInt64(buffer,24);
    }
    finally {Marshal.FreeHGlobal(buffer);}
  }
  static void TransactionReadonly(Opened item,bool readOnly) {
    Snapshot before=Info(item.Handle);uint attributes=(before.Attributes&~0x11u)|(readOnly?1u:0u);if(attributes==0)attributes=0x80;
    IntPtr basic=Marshal.AllocHGlobal(40);
    try {for(int i=0;i<40;i++)Marshal.WriteByte(basic,i,0);Marshal.WriteInt32(basic,32,unchecked((int)attributes));IO_STATUS_BLOCK io;Need(NtSetInformationFile(item.Handle,out io,basic,40,4)==0,"PREIMAGE_UNSAFE");}
    finally {Marshal.FreeHGlobal(basic);}
    var after=Info(item.Handle);Need(before.Id==after.Id && before.Size==after.Size && before.Links==after.Links && ((after.Attributes&1)!=0)==readOnly,"PREIMAGE_UNSAFE");item.Snapshot=after;
  }
  static void TransactionWrite(Opened item,byte[] bytes) {
    int offset=0;
    while(offset<bytes.Length) {int amount=Math.Min(1024*1024,bytes.Length-offset);byte[] block=new byte[amount];Buffer.BlockCopy(bytes,offset,block,0,amount);uint written;Need(WriteFile(item.Handle,block,(uint)amount,out written,IntPtr.Zero) && written>0 && written<=amount,"PREIMAGE_UNSAFE");offset+=(int)written;}
    TransactionFlush(item.Handle);item.Snapshot=Info(item.Handle);
    Need(item.Snapshot.Size==bytes.Length && (string)ReadCapturedFile(item,true,MaxBytes)["dataBase64"]==Convert.ToBase64String(bytes),"PREIMAGE_UNSAFE");
  }
  static void TransactionWalk(TreeNode node,List<TreeNode> nodes,List<Opened> handles,ref long total,int depth,bool flush,bool rename) {
    Need(depth<=128,"FILESYSTEM_CAPTURE_LIMIT");
    if(!node.Opened.Directory) {node.Result=ReadCapturedFile(node.Opened,true,(int)(MaxBytes-total));total+=node.Opened.Snapshot.Size;return;}
    node.Children=EnumerateHeld(node.Opened.Handle,MaxTreeEntries);
    foreach(var entry in node.Children) {
      Need(nodes.Count<MaxTreeEntries && depth<128,"FILESYSTEM_CAPTURE_LIMIT");bool directory=(entry.Attributes&FILE_ATTRIBUTE_DIRECTORY)!=0;
      Opened child=TransactionOpen(entry.Name,node.Opened.Handle,directory,false,flush?4u:0u,false,false,rename);handles.Add(child);
      Need(child.Snapshot.Volume==node.Opened.Snapshot.Volume && child.Snapshot.Attributes==entry.Attributes && (((ulong)child.Snapshot.IndexHigh<<32)|child.Snapshot.IndexLow)==entry.Id,"PREIMAGE_UNSAFE");
      var item=new TreeNode{Opened=child,Parent=node.Opened,Path=node.Path.Length==0?entry.Name:node.Path+"/"+entry.Name};nodes.Add(item);TransactionWalk(item,nodes,handles,ref total,depth+1,flush,rename);
    }
  }
  static void TransactionValidate(List<TreeNode> nodes) {
    foreach(var node in nodes) {
      Need(node.Opened.Snapshot.Same(Info(node.Opened.Handle)),"PREIMAGE_UNSAFE");
      if(node.Opened.Directory) {var children=EnumerateHeld(node.Opened.Handle,MaxTreeEntries);Need(children.Count==node.Children.Count,"PREIMAGE_UNSAFE");for(int i=0;i<children.Count;i++)Need(children[i].Same(node.Children[i]),"PREIMAGE_UNSAFE");}
      else Need((string)ReadCapturedFile(node.Opened,false,MaxBytes)["sha256"]==(string)node.Result["sha256"],"PREIMAGE_UNSAFE");
      IntPtr fresh=IntPtr.Zero;try {fresh=Open(node.Opened.Name,node.Parent.Handle,node.Opened.Directory,false,true);CheckCanonicalComponentName(fresh,node.Opened.Name);Need(node.Opened.Snapshot.Same(Info(fresh)),"PREIMAGE_UNSAFE");}finally{if(fresh!=IntPtr.Zero)CloseHandle(fresh);}
    }
  }
  static void TransactionAbsent(Opened parent,string leaf) {
    bool missing=false;try {var found=OpenOwned(leaf,parent.Handle,false,true);CloseHandle(found.Handle);}catch(Refusal error){if(error.Code!="FILESYSTEM_NOT_FOUND")throw;missing=true;}
    Need(missing,"FILESYSTEM_ALREADY_EXISTS");
  }
  static Dictionary<string,object> TransactionStat(Opened item) {var current=Info(item.Handle);Need(item.Snapshot.Id==current.Id && (item.Directory || current.Links==1),"PREIMAGE_UNSAFE");return new Dictionary<string,object>{{"identity",current.Id},{"stat",Stat(current)},{"type",item.Directory?"directory":"file"}};}
  public static Dictionary<string,object> TransactionOperation(string operation,string root,string[] components,string destinationRoot,string[] destinationComponents,string bytesBase64,int mode) {
    bool copy=operation=="copy-tree-exclusive",rename=operation=="rename-tree-no-replace",mkdir=operation=="mkdir-exclusive",write=operation=="write-exclusive",flushTree=operation=="fsync-tree",flushDirectory=operation=="fsync-directory";
    Need(copy || rename || mkdir || write || flushTree || flushDirectory,"FILESYSTEM_REQUEST_INVALID");
    Need(mode>=0 && mode<=4095,"FILESYSTEM_REQUEST_INVALID");
    byte[] bytes=null;if(write){Need(bytesBase64!=null && bytesBase64.Length<=((MaxRecordBytes+2)/3)*4,"FILESYSTEM_CAPTURE_LIMIT");try{bytes=Convert.FromBase64String(bytesBase64);}catch{throw new Refusal("FILESYSTEM_REQUEST_INVALID");}Need(bytes.Length<=MaxRecordBytes && Convert.ToBase64String(bytes)==bytesBase64,"FILESYSTEM_REQUEST_INVALID");}
    if(copy || rename){ValidateCaptureRequest(destinationRoot,destinationComponents,MaxBytes);string sourcePath=root+String.Join("\\",components),destinationPath=destinationRoot+String.Join("\\",destinationComponents);Need(!destinationPath.StartsWith(sourcePath+"\\",StringComparison.OrdinalIgnoreCase),"FILESYSTEM_REQUEST_INVALID");}
    var handles=new List<Opened>();var created=new List<Opened>();bool success=false;
    try {
      using(var source=new TransactionParent(root,components,mkdir || write || rename || flushTree)) {
        if(mkdir || write) {
          TransactionAbsent(source.Parent,source.Leaf);source.VerifyNow();
          var made=TransactionOpen(source.Leaf,source.Parent.Handle,mkdir,true,0x104u,false,false,false);created.Add(made);
          if(write)TransactionWrite(made,bytes);
          TransactionReadonly(made,(mode&146)==0);TransactionFlush(made.Handle);source.VerifyNow();TransactionFlush(source.Parent.Handle);
          var check=new List<TreeNode>{new TreeNode{Opened=made,Parent=source.Parent,Path="",Children=mkdir?new List<DirectoryEntry>():null,Result=write?ReadCapturedFile(made,true,MaxRecordBytes):null}};
          TransactionValidate(check);source.VerifyNow();success=true;var result=TransactionStat(made);
          if(write){result["length"]=bytes.Length;result["sha256"]=check[0].Result["sha256"];}return result;
        }
        Opened target;
        try {target=TransactionOpen(source.Leaf,source.Parent.Handle,flushDirectory,false,(rename?0x10000u:0u)|((flushTree || flushDirectory)?4u:0u),!flushDirectory,true,rename);}
        catch(Refusal error){if(error.Code!="FILESYSTEM_NOT_FOUND")throw;source.VerifyNow();if(!flushTree)throw;TransactionFlush(source.Parent.Handle);source.VerifyNow();return new Dictionary<string,object>{{"flushed",false}};}
        handles.Add(target);var top=new TreeNode{Opened=target,Parent=source.Parent,Path=""};var nodes=new List<TreeNode>{top};long total=0;
        if(flushDirectory){source.VerifyNow();TransactionFlush(target.Handle);Need(target.Snapshot.Same(Info(target.Handle)),"PREIMAGE_UNSAFE");source.VerifyNow();success=true;return new Dictionary<string,object>{{"flushed",true}};}
        TransactionWalk(top,nodes,handles,ref total,0,flushTree,rename);TransactionValidate(nodes);source.VerifyNow();
        if(flushTree){for(int i=nodes.Count-1;i>=0;i--)TransactionFlush(nodes[i].Opened.Handle);TransactionValidate(nodes);source.VerifyNow();TransactionFlush(source.Parent.Handle);source.VerifyNow();success=true;return new Dictionary<string,object>{{"flushed",true}};}
        using(var destination=new TransactionParent(destinationRoot,destinationComponents,true)) {
          if(rename)Need(source.Mapping==destination.Mapping,"FILESYSTEM_CROSS_DEVICE");
          TransactionAbsent(destination.Parent,destination.Leaf);source.VerifyNow();destination.VerifyNow();
          if(rename) {
            // Windows refuses a directory rename while any descendant HANDLE
            // remains open, even when every handle shares delete access. Bind
            // each descendant to its NTFS USN before closing those handles;
            // after the atomic root rename, reopen the complete tree and
            // require the same identities, metadata, bytes, and USNs. A
            // mutate-and-restore race changes a USN and is therefore refused.
            var originalUsn=new Dictionary<string,long>(StringComparer.Ordinal);
            for(int i=1;i<nodes.Count;i++)originalUsn[nodes[i].Path]=TransactionUsn(nodes[i].Opened.Handle);
            for(int i=handles.Count-1;i>=1;i--)CloseHandle(handles[i].Handle);
            if(handles.Count>1)handles.RemoveRange(1,handles.Count-1);
            Snapshot originalTop=target.Snapshot;
            RenameRecord(target.Handle,destination.Parent.Handle,destination.Leaf);target.Name=destination.Leaf;target.Snapshot=Info(target.Handle);
            try {
              Need(target.Directory?SameDirectoryIdentity(originalTop,target.Snapshot):originalTop.Same(target.Snapshot),"PREIMAGE_UNSAFE");
              var renamedTop=new TreeNode{Opened=target,Parent=destination.Parent,Path=""};var renamedNodes=new List<TreeNode>{renamedTop};long renamedTotal=0;
              TransactionWalk(renamedTop,renamedNodes,handles,ref renamedTotal,0,false,false);Need(renamedNodes.Count==nodes.Count,"PREIMAGE_UNSAFE");
              for(int i=1;i<nodes.Count;i++) {
                Need(nodes[i].Path==renamedNodes[i].Path && nodes[i].Opened.Directory==renamedNodes[i].Opened.Directory && nodes[i].Opened.Snapshot.Same(renamedNodes[i].Opened.Snapshot),"PREIMAGE_UNSAFE");
                Need(originalUsn[nodes[i].Path]==TransactionUsn(renamedNodes[i].Opened.Handle),"PREIMAGE_UNSAFE");
                if(!nodes[i].Opened.Directory)Need((string)nodes[i].Result["sha256"]==(string)renamedNodes[i].Result["sha256"] && (string)nodes[i].Result["dataBase64"]==(string)renamedNodes[i].Result["dataBase64"],"PREIMAGE_UNSAFE");
              }
              TransactionValidate(renamedNodes);source.VerifyNow();destination.VerifyNow();
            } catch(Refusal validation) {
              // A detected gap race must not leave a seemingly-published
              // destination behind. Close reopened descendants and move the
              // still-held root identity back to its original absent name.
              for(int i=handles.Count-1;i>=1;i--)CloseHandle(handles[i].Handle);
              if(handles.Count>1)handles.RemoveRange(1,handles.Count-1);
              try {
                TransactionAbsent(source.Parent,source.Leaf);RenameRecord(target.Handle,source.Parent.Handle,source.Leaf);target.Name=source.Leaf;target.Snapshot=Info(target.Handle);
                TransactionAbsent(destination.Parent,destination.Leaf);TransactionFlush(source.Parent.Handle);TransactionFlush(destination.Parent.Handle);source.VerifyNow();destination.VerifyNow();
              } catch {throw new Refusal("FILESYSTEM_RECOVERY_REQUIRED");}
              throw validation;
            }
            TransactionAbsent(source.Parent,source.Leaf);TransactionFlush(source.Parent.Handle);TransactionFlush(destination.Parent.Handle);source.VerifyNow();destination.VerifyNow();success=true;return TransactionStat(target);
          }
          var copies=new List<TreeNode>();var byPath=new Dictionary<string,TreeNode>(StringComparer.Ordinal);
          foreach(var node in nodes) {
            string parentPath=node.Path.IndexOf('/')<0?"":node.Path.Substring(0,node.Path.LastIndexOf('/'));
            var parent=node.Path.Length==0?destination.Parent:byPath[parentPath].Opened;string name=node.Path.Length==0?destination.Leaf:node.Opened.Name;
            var made=TransactionOpen(name,parent.Handle,node.Opened.Directory,true,0x104u,false,false,false);created.Add(made);
            var copied=new TreeNode{Opened=made,Parent=parent,Path=node.Path,Result=node.Result};copies.Add(copied);byPath[node.Path]=copied;
            if(!made.Directory)TransactionWrite(made,Convert.FromBase64String((string)node.Result["dataBase64"]));
          }
          for(int i=copies.Count-1;i>=0;i--){TransactionReadonly(copies[i].Opened,(nodes[i].Opened.Snapshot.Attributes&1)!=0);TransactionFlush(copies[i].Opened.Handle);}
          // Index parents by the same Opened reference identity used by the
          // original child scan; every copied edge is visited exactly once.
          var copiedDirectories=new Dictionary<Opened,TreeNode>();
          foreach(var node in copies) {
            if(!node.Opened.Directory)continue;
            node.Children=new List<DirectoryEntry>();copiedDirectories.Add(node.Opened,node);
          }
          // Capture expected child attributes BEFORE refreshing child snapshots,
          // as the original parent-before-child scan did. Concurrent attribute
          // drift must still disagree with the subsequent held enumeration.
          foreach(var child in copies) {
            TreeNode parent;if(copiedDirectories.TryGetValue(child.Parent,out parent))parent.Children.Add(new DirectoryEntry{Name=child.Opened.Name,Attributes=child.Opened.Snapshot.Attributes,Id=((ulong)child.Opened.Snapshot.IndexHigh<<32)|child.Opened.Snapshot.IndexLow});
          }
          foreach(var node in copies) {
            node.Opened.Snapshot=Info(node.Opened.Handle);
            if(node.Opened.Directory)node.Children.Sort((a,b)=>StringComparer.Ordinal.Compare(a.Name,b.Name));
          }
          TransactionValidate(nodes);TransactionValidate(copies);source.VerifyNow();destination.VerifyNow();TransactionFlush(destination.Parent.Handle);destination.VerifyNow();success=true;return TransactionStat(copies[0].Opened);
        }
      }
    } finally {
      for(int i=created.Count-1;i>=0;i--){if(!success){try{TransactionReadonly(created[i],false);DeleteOwnedTemporary(created[i].Handle);}catch{}}CloseHandle(created[i].Handle);}
      for(int i=handles.Count-1;i>=0;i--)CloseHandle(handles[i].Handle);
    }
  }
  public static Dictionary<string, object> OwnedOperation(string operation, string root, string[] components, string parentDev, string parentIno, string targetType, string targetDev, string targetIno) {
    ValidateCaptureRequest(root, components, MaxBytes);
    bool deleting = operation == "remove-owned-target"; Need(deleting || operation == "inspect-owned-target", "FILESYSTEM_REQUEST_INVALID");
    string mapping = PhysicalDriveMapping(root), nativeRoot = "\\??\\" + root;
    var chain = new List<Opened>(); var all = new List<Opened>(); var nodes = new List<TreeNode>();
    try {
      chain.Add(OpenChecked(nativeRoot, IntPtr.Zero, true, false, false)); ValidateRootVolume(chain[0].Handle, root, mapping);
      for (int i = 0; i < components.Length - 1; i++) chain.Add(OpenChecked(components[i], chain[chain.Count - 1].Handle, true, false, true));
      Verify(chain, nativeRoot); Opened parent = chain[chain.Count - 1], target;
      if (deleting) Need(MatchesOwned(parent, parentDev, parentIno), "PREIMAGE_UNSAFE");
      try { target = OpenOwned(components[components.Length - 1], parent.Handle, deleting, true); }
      catch (Refusal refused) {
        if (refused.Code != "FILESYSTEM_NOT_FOUND") throw;
        Verify(chain, nativeRoot); ValidateRootVolume(chain[0].Handle, root, mapping);
        if (!deleting) throw;
        return new Dictionary<string, object> { {"removed", false} };
      }
      all.Add(target);
      if (!deleting) {
        Verify(chain, nativeRoot); Need(target.Snapshot.Same(Info(target.Handle)), "PREIMAGE_UNSAFE");
        IntPtr fresh = IntPtr.Zero;
        try { fresh = Open(target.Name, parent.Handle, false, false, true, false, false, true); CheckCanonicalComponentName(fresh, target.Name); Need(target.Snapshot.Same(Info(fresh)), "PREIMAGE_UNSAFE"); }
        finally { if (fresh != IntPtr.Zero) CloseHandle(fresh); }
        ValidateRootVolume(chain[0].Handle, root, mapping);
        return new Dictionary<string, object> { {"parentIdentity", OwnedIdentity(parent, false)}, {"targetIdentity", OwnedIdentity(target, true)} };
      }
      Need(MatchesOwned(target, targetDev, targetIno) && targetType == (target.Directory ? "directory" : "file"), "PREIMAGE_UNSAFE");
      var top = new TreeNode { Opened=target, Parent=parent, Path="" }; nodes.Add(top); long total = 0;
      if (target.Directory) WalkTree(top, nodes, all, ref total, MaxBytes, 0, MaxCleanupEntries, true);
      else top.Result = ReadCapturedFile(target, true, MaxBytes);
      // Validate the complete bounded subtree before the first deletion.
      foreach (TreeNode node in nodes) {
        Need(node.Opened.Snapshot.Same(Info(node.Opened.Handle)), "PREIMAGE_UNSAFE");
        if (node.Opened.Directory) {
          List<DirectoryEntry> again = EnumerateHeld(node.Opened.Handle, MaxCleanupEntries); Need(again.Count == node.Children.Count, "PREIMAGE_UNSAFE");
          for (int i = 0; i < again.Count; i++) Need(again[i].Same(node.Children[i]), "PREIMAGE_UNSAFE");
        } else Need((string)ReadCapturedFile(node.Opened, false, MaxBytes)["sha256"] == (string)node.Result["sha256"], "PREIMAGE_UNSAFE");
        IntPtr fresh = IntPtr.Zero;
        try { fresh = Open(node.Opened.Name, node.Parent.Handle, false, false, true, false, false, true); CheckCanonicalComponentName(fresh, node.Opened.Name); Need(node.Opened.Snapshot.Same(Info(fresh)), "PREIMAGE_UNSAFE"); }
        finally { if (fresh != IntPtr.Zero) CloseHandle(fresh); }
      }
      Verify(chain, nativeRoot); ValidateRootVolume(chain[0].Handle, root, mapping);
      for (int i = nodes.Count - 1; i >= 0; i--) {
        Opened item = nodes[i].Opened; Snapshot now = Info(item.Handle);
        Need(item.Directory ? SameDirectoryIdentity(item.Snapshot, now) : item.Snapshot.Same(now), "PREIMAGE_UNSAFE");
        IntPtr information = Marshal.AllocHGlobal(1);
        try { Marshal.WriteByte(information, 1); IO_STATUS_BLOCK io; Need(NtSetInformationFile(item.Handle, out io, information, 1, 13) == 0, "PREIMAGE_UNSAFE"); }
        finally { Marshal.FreeHGlobal(information); }
        CloseHandle(item.Handle); item.Handle = IntPtr.Zero;
      }
      VerifyMutationParents(chain, nativeRoot); ValidateRootVolume(chain[0].Handle, root, mapping);
      bool absent = false;
      try { Opened remaining = OpenOwned(target.Name, parent.Handle, false, true); CloseHandle(remaining.Handle); }
      catch (Refusal refused) { if (refused.Code != "FILESYSTEM_NOT_FOUND") throw; absent = true; }
      Need(absent, "PREIMAGE_UNSAFE");
      return new Dictionary<string, object> { {"removed", true} };
    } finally {
      for (int i = all.Count - 1; i >= 0; i--) if (all[i].Handle != IntPtr.Zero) CloseHandle(all[i].Handle);
      for (int i = chain.Count - 1; i >= 0; i--) CloseHandle(chain[i].Handle);
    }
  }
  static void ValidateCaptureRequest(string root, string[] components, int maxBytes) {
    Need(ValidRoot(root) && components != null && components.Length >= 1 && components.Length <= 128 && maxBytes >= 0 && maxBytes <= MaxBytes, "FILESYSTEM_REQUEST_INVALID");
    foreach (string part in components) Need(ValidComponent(part), "FILESYSTEM_REQUEST_INVALID");
  }
  public static Dictionary<string, object> Capture(string operation, string root, string[] components, int maxBytes) {
    if ((operation != "read" && operation != "hash") || !ValidRoot(root) || components == null || components.Length < 1 || components.Length > 128 || maxBytes < 0 || maxBytes > MaxBytes)
      throw new Refusal("FILESYSTEM_REQUEST_INVALID");
    for (int i = 0; i < components.Length; i++) if (!ValidComponent(components[i])) throw new Refusal("FILESYSTEM_REQUEST_INVALID");
    string rootMapping = PhysicalDriveMapping(root);
    string nativeRoot = "\\??\\" + root; var held = new List<Opened>();
    try {
      held.Add(OpenChecked(nativeRoot, IntPtr.Zero, true, false, false));
      ValidateRootVolume(held[0].Handle, root, rootMapping);
      try { for (int i = 0; i < components.Length; i++) held.Add(OpenChecked(components[i], held[held.Count - 1].Handle, i + 1 < components.Length, i + 1 == components.Length, true, false, i + 1 == components.Length)); }
      catch (Refusal refused) { if (refused.Code == "FILESYSTEM_NOT_FOUND") { Verify(held, nativeRoot); ValidateRootVolume(held[0].Handle, root, rootMapping); } throw; }
      Opened file = held[held.Count - 1];
      var result = ReadCapturedFile(file, operation == "read", maxBytes);
      Verify(held, nativeRoot); ValidateRootVolume(held[0].Handle, root, rootMapping);
      return result;
    } finally { for (int i = held.Count - 1; i >= 0; i--) if (held[i].Handle != IntPtr.Zero) CloseHandle(held[i].Handle); }
  }
}
'@

function Get-RefusalCode([System.Exception]$Exception) {
  $known = $Exception
  for ($depth = 0; $depth -lt 3 -and $null -ne $known; $depth++) {
    if ($known.GetType().FullName -eq 'AutopromptWindowsCapture+Refusal') { return [string]$known.Code }
    if ($known -is [System.Management.Automation.MethodInvocationException] -or $known -is [System.Reflection.TargetInvocationException]) {
      $known = $known.InnerException
      continue
    }
    break
  }
  return $null
}

try {
  if (-not $Request) { throw 'request mode required' }
  # Fixed diagnostic phases use stderr only when the bound controller requests
  # them. They never carry paths, request fields, captured bytes, or authority.
  Write-CapturePhase 'input'
  $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
  Write-CapturePhase 'input-encoding-created'
  [Console]::InputEncoding = $strictUtf8
  [Console]::OutputEncoding = $strictUtf8
  Write-CapturePhase 'input-encoding-set'
  # Consume at most the closed request cap and one sentinel character.  Do
  # not allocate an attacker-controlled stdin string before rejecting it.
  $maximumRequest = 12 * 1024 * 1024
  $requestText = New-Object System.Text.StringBuilder
  $requestBuffer = New-Object char[] 1024
  Write-CapturePhase 'input-initialized'
  # Separate Console.In initialization from the bounded blocking read itself.
  # Keep the same reader for the complete request; do not change EOF semantics.
  $requestReader = [Console]::In
  Write-CapturePhase 'input-reading'
  while ($true) {
    $readLimit = [Math]::Min($requestBuffer.Length, ($maximumRequest + 1) - $requestText.Length)
    $read = $requestReader.Read($requestBuffer, 0, $readLimit)
    if ($read -le 0) { break }
    [void]$requestText.Append($requestBuffer, 0, $read)
    if ($requestText.Length -gt $maximumRequest) { throw 'invalid request' }
  }
  Write-CapturePhase 'input-eof'
  $raw = $requestText.ToString()
  if ($raw.Length -eq 0) { throw 'invalid request' }
  Write-CapturePhase 'compile'
  Add-Type -TypeDefinition $source -Language CSharp
  Write-CapturePhase 'compiled'
  [AutopromptWindowsCapture]::ValidateJson($raw)
  $requestObject = $raw | ConvertFrom-Json
  $names = @($requestObject.PSObject.Properties.Name)
  $transaction = $requestObject.operation -cin @('fsync-directory','fsync-tree','mkdir-exclusive','write-exclusive','copy-tree-exclusive','rename-tree-no-replace')
  if ($transaction) {
    $pair = $requestObject.operation -cin @('copy-tree-exclusive','rename-tree-no-replace')
    $writeExclusive = $requestObject.operation -ceq 'write-exclusive'
    $mkdirExclusive = $requestObject.operation -ceq 'mkdir-exclusive'
    $allowed = @('schemaVersion','operation','root','components') + $(if ($pair) { @('destination') } elseif ($writeExclusive) { @('mode','bytesBase64') } elseif ($mkdirExclusive) { @('mode') } else { @('maxBytes') })
    if ($names.Count -ne $allowed.Count -or @($names | Where-Object { $_ -cnotin $allowed }).Count -ne 0 -or
        (-not ($requestObject.schemaVersion -is [int] -or $requestObject.schemaVersion -is [long])) -or $requestObject.schemaVersion -ne 1 -or $requestObject.root -isnot [string] -or $requestObject.components -isnot [Array]) { throw 'invalid transaction request' }
    if (-not $writeExclusive -and $raw.Length -gt 16384) { throw 'invalid transaction request' }
    $parts = @($requestObject.components | ForEach-Object { if ($_ -isnot [string]) { throw 'invalid transaction request' }; [string]$_ })
    $destinationRoot=$null; $destinationParts=$null; $transactionBytes=$null; $transactionMode=438
    if ($pair) {
      if (@($requestObject.destination.PSObject.Properties.Name).Count -ne 2 -or @($requestObject.destination.PSObject.Properties.Name | Where-Object { $_ -cnotin @('root','components') }).Count -ne 0 -or $requestObject.destination.root -isnot [string] -or $requestObject.destination.components -isnot [Array]) { throw 'invalid transaction request' }
      $destinationRoot=[string]$requestObject.destination.root
      $destinationParts=@($requestObject.destination.components | ForEach-Object { if ($_ -isnot [string]) { throw 'invalid transaction request' }; [string]$_ })
    } elseif ($mkdirExclusive -or $writeExclusive) {
      if ((-not ($requestObject.mode -is [int] -or $requestObject.mode -is [long])) -or $requestObject.mode -lt 0 -or $requestObject.mode -gt 4095) { throw 'invalid transaction request' }
      $transactionMode=[int]$requestObject.mode
      if ($writeExclusive) { if ($requestObject.bytesBase64 -isnot [string]) { throw 'invalid transaction request' }; $transactionBytes=[string]$requestObject.bytesBase64 }
    } elseif ((-not ($requestObject.maxBytes -is [int] -or $requestObject.maxBytes -is [long])) -or $requestObject.maxBytes -ne 67108864) { throw 'invalid transaction request' }
    Write-CapturePhase 'dispatch'
    $transactionResult=[AutopromptWindowsCapture]::TransactionOperation([string]$requestObject.operation,[string]$requestObject.root,[string[]]$parts,$destinationRoot,[string[]]$destinationParts,$transactionBytes,$transactionMode)
    Write-CapturePhase 'completed'
    [ordered]@{schemaVersion=1;status='TRANSACTED';operation=$requestObject.operation;result=$transactionResult} | ConvertTo-Json -Compress -Depth 8
    exit 0
  }
  $publish = $requestObject.operation -ceq 'publish-record-exclusive'
  $remove = $requestObject.operation -ceq 'remove-owned-target'
  $allowed = if ($publish) { @('schemaVersion', 'operation', 'root', 'components', 'bytesBase64') } elseif ($remove) { @('schemaVersion', 'operation', 'root', 'components', 'parentIdentity', 'targetIdentity') } else { @('schemaVersion', 'operation', 'root', 'components', 'maxBytes') }
  if ($names.Count -ne $allowed.Count -or @($names | Where-Object { $_ -cnotin $allowed }).Count -ne 0 -or
      (-not ($requestObject.schemaVersion -is [int] -or $requestObject.schemaVersion -is [long])) -or $requestObject.schemaVersion -ne 1 -or
      $requestObject.operation -isnot [string] -or $requestObject.root -isnot [string] -or $requestObject.components -isnot [System.Array]) { throw 'invalid request' }
  if ($publish) { if ($requestObject.bytesBase64 -isnot [string]) { throw 'invalid request' } }
  elseif ($remove) {
    if ($raw.Length -gt 16384 -or @($requestObject.parentIdentity.PSObject.Properties.Name).Count -ne 2 -or @($requestObject.targetIdentity.PSObject.Properties.Name).Count -ne 3 -or $requestObject.parentIdentity.dev -isnot [string] -or $requestObject.parentIdentity.ino -isnot [string] -or $requestObject.targetIdentity.type -isnot [string] -or $requestObject.targetIdentity.dev -isnot [string] -or $requestObject.targetIdentity.ino -isnot [string]) { throw 'invalid request' }
  }
  elseif ($raw.Length -gt 16384 -or (-not ($requestObject.maxBytes -is [int] -or $requestObject.maxBytes -is [long])) -or $requestObject.maxBytes -lt 0 -or $requestObject.maxBytes -gt 67108864) { throw 'invalid request' }
  $components = @($requestObject.components | ForEach-Object { if ($_ -isnot [string]) { throw 'invalid request' }; [string]$_ })
  if ($remove -or $requestObject.operation -ceq 'inspect-owned-target') {
    Write-CapturePhase 'dispatch'
    if ($remove) { $owned = [AutopromptWindowsCapture]::OwnedOperation([string]$requestObject.operation, [string]$requestObject.root, [string[]]$components, [string]$requestObject.parentIdentity.dev, [string]$requestObject.parentIdentity.ino, [string]$requestObject.targetIdentity.type, [string]$requestObject.targetIdentity.dev, [string]$requestObject.targetIdentity.ino) }
    else { $owned = [AutopromptWindowsCapture]::OwnedOperation([string]$requestObject.operation, [string]$requestObject.root, [string[]]$components, $null, $null, $null, $null, $null) }
    Write-CapturePhase 'completed'
    if ($remove) { [ordered]@{ schemaVersion = 1; status = 'REMOVED'; removed = $owned.removed } | ConvertTo-Json -Compress }
    else { [ordered]@{ schemaVersion = 1; status = 'INSPECTED'; parentIdentity = $owned.parentIdentity; targetIdentity = $owned.targetIdentity } | ConvertTo-Json -Compress -Depth 8 }
    exit 0
  }
  if ($publish -or $requestObject.operation -ceq 'assert-record-parent' -or $requestObject.operation -ceq 'recover-record-publication') {
    $recordBytes = if ($publish) { [string]$requestObject.bytesBase64 } else { $null }
    Write-CapturePhase 'dispatch'
    $record = [AutopromptWindowsCapture]::RecordOperation([string]$requestObject.operation, [string]$requestObject.root, [string[]]$components, $recordBytes)
    Write-CapturePhase 'completed'
    if ($requestObject.operation -ceq 'recover-record-publication') {
      [ordered]@{ schemaVersion = 1; status = 'RECOVERED'; removed = @($record.removed) } | ConvertTo-Json -Compress -Depth 8
      exit 0
    }
    $out = [ordered]@{ schemaVersion = 1; status = $(if ($publish) { 'PUBLISHED' } else { 'PARENT_VERIFIED' }); identity = $record.identity; stat = $record.stat }
    if ($publish) { $out.length = $record.length; $out.sha256 = $record.sha256 }
    $out | ConvertTo-Json -Compress -Depth 8
    exit 0
  }
  if ($requestObject.operation -ceq 'tree') {
    Write-CapturePhase 'dispatch'
    $tree = [AutopromptWindowsCapture]::CaptureTree([string]$requestObject.root, [string[]]$components, [int]$requestObject.maxBytes)
    Write-CapturePhase 'completed'
    [ordered]@{ schemaVersion = 1; status = 'TREE_CAPTURED'; operation = 'tree'; bytes = $tree.bytes; entries = @($tree.entries) } | ConvertTo-Json -Compress -Depth 8
    exit 0
  }
  Write-CapturePhase 'dispatch'
  $captured = [AutopromptWindowsCapture]::Capture([string]$requestObject.operation, [string]$requestObject.root, [string[]]$components, [int]$requestObject.maxBytes)
  Write-CapturePhase 'completed'
  $out = [ordered]@{ schemaVersion = 1; status = 'CAPTURED'; operation = $requestObject.operation; identity = $captured.identity; length = $captured.length; sha256 = $captured.sha256; stat = $captured.stat }
  if ($requestObject.operation -eq 'read') { $out.dataBase64 = $captured.dataBase64 }
  $out | ConvertTo-Json -Compress -Depth 8
} catch {
  if ($captureLastPhase -ceq 'dispatch') { Write-CapturePhase 'completed' }
  $code = Get-RefusalCode $_.Exception
  if ([string]::IsNullOrEmpty($code)) { $code = 'FILESYSTEM_REQUEST_INVALID' }
  [ordered]@{ schemaVersion = 1; status = 'REFUSED'; code = $code } | ConvertTo-Json -Compress
}
