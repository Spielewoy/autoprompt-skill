using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
// Prototype: read-only held-handle lease. No ACL or file contents are changed.
public sealed class BundlePhysicalLease : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct FT {
    public uint Low, High;
  }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attr;
    public FT Created, Access, Write;
    public uint Volume, High, Low, Links, IdHigh, IdLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long Created, Access, Write, Change;
    public uint Attr;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Found {
    public uint Attr;
    public FT Created, Access, Write;
    public uint High, Low, Reserved0, Reserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string Alternate;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string p, uint a, uint s, IntPtr sec, uint c, uint f, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr h, out Info i);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(IntPtr h, int cls, out Basic i, uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetVolumeInformationByHandleW(IntPtr h, IntPtr name, uint size, out uint serial, out uint maxComponent, out uint flags, StringBuilder fs, uint fsSize);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder p, uint n, uint f);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveTypeW(string p);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindFirstFileW(string p, out Found f);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool FindNextFileW(IntPtr h, out Found f);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  sealed class Held {
    public IntPtr H;
    public string Path;
    public Info I;
    public Basic B;
    public bool Directory, Ancestor;
  }
  readonly List<Held> held = new List<Held>();
  readonly HashSet<string> expected = new HashSet<string>(StringComparer.Ordinal);
  readonly HashSet<string> dirs = new HashSet<string>(StringComparer.Ordinal);
  readonly string root;
  bool finished, disposed;
  static void Need(bool b, string code) {
    if (!b) throw new InvalidOperationException(code);
  }
  public static bool ValidRelative(string p) {
    if (p == null || p.Length>256 || p.Length == 0) return false;
    foreach (string part in p.Split('/')) if (part.Length>96 || !Regex.IsMatch(part, "^[a-z0-9]+(?:[._-][a-z0-9]+)*$") || Regex.IsMatch(part, "^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|[.])")) return false;
    return true;
  }
  public static bool ValidState(uint type, uint attr, uint links, bool directory) {
    return type == 1 && (attr&0x400) == 0 && ((attr&0x10) != 0) == directory && (directory || links == 1);
  }
  static bool Same(Info a, Info b, Basic x, Basic y, bool ancestor) {
    return a.Volume == b.Volume &&
        a.IdHigh == b.IdHigh &&
        a.IdLow == b.IdLow &&
        a.Attr == b.Attr &&
        a.Links == b.Links &&
        (ancestor || (a.High == b.High &&
        a.Low == b.Low &&
        x.Write == y.Write &&
        x.Change == y.Change));
  }
  static void Read(Held h, out Info i, out Basic b) {
    if (!GetFileInformationByHandle(h.H, out i) || !GetFileInformationByHandleEx(h.H, 0, out b, (uint)Marshal.SizeOf(typeof(Basic)))) throw new Win32Exception(Marshal.GetLastWin32Error());
    Need(ValidState(GetFileType(h.H), i.Attr, i.Links, h.Directory), "physical-type-refused");
  }
  static void Canonical(Held h) {
    StringBuilder b = new StringBuilder(32768);
    uint n = GetFinalPathNameByHandleW(h.H, b, (uint)b.Capacity, 0);
    Need(n>0 && n<b.Capacity, "canonical-query-refused");
    string p = b.ToString();
    Need(p.StartsWith("\\\\?\\", StringComparison.Ordinal), "canonical-prefix-refused");
    Need(String.Equals(p.Substring(4).TrimEnd('\\'), h.Path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase), "physical-alias-refused");
  }
  Held Open(string p, bool directory, bool ancestor) {
    // FILE_SHARE_READ only: held files exclude writable mappings, writers and
    // deletion/replacement. Directories/ancestors also exclude deletion.
    IntPtr h = CreateFileW(p, directory?0x80u:0x80000000u, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    Held v = new Held {
      H = h, Path = p, Directory = directory, Ancestor = ancestor
    };
    try {
      Read(v, out v.I, out v.B);
      Canonical(v);
      return v;
    }
    catch {
      CloseHandle(h);
      throw;
    }
  }
  public BundlePhysicalLease(string physicalRoot, string[] files) {
    Need(physicalRoot != null &&
        Regex.IsMatch(physicalRoot, @"^[A-Za-z]:\\") &&
        physicalRoot.Length <= 2048 &&
        physicalRoot == Path.GetFullPath(physicalRoot) &&
        !physicalRoot.EndsWith("\\"), "local-canonical-root-required");
    root = physicalRoot;
    Need(GetDriveTypeW(Path.GetPathRoot(root)) == 3, "fixed-local-drive-required");
    Need(files != null && files.Length>0 && files.Length <= 129, "inventory-bound");
    foreach (string f in files) {
      Need(ValidRelative(f) && expected.Add(f), "inventory-path-refused");
      string d = f;
      while (d.LastIndexOf('/') >= 0) {
        d = d.Substring(0, d.LastIndexOf('/'));
        dirs.Add(d);
      }
    }
    Need(expected.Contains("manifest.json") && dirs.Count <= 128, "manifest-or-directory-bound");
    foreach (string d in dirs) Need(!expected.Contains(d), "file-directory-collision");
    try {
      List<string> ancestors = new List<string>();
      for (string p = Path.GetDirectoryName(root);!String.IsNullOrEmpty(p);p = Path.GetDirectoryName(p)) ancestors.Add(p);
      Need(ancestors.Count <= 64, "ancestor-bound");
      ancestors.Reverse();
      foreach (string p in ancestors) held.Add(Open(p, true, true));
      held.Add(Open(root, true, false));
      uint serial, maxComponent, flags;
      var fs = new StringBuilder(32);
      Need(GetVolumeInformationByHandleW(held[held.Count-1].H, IntPtr.Zero, 0, out serial, out maxComponent, out flags, fs, (uint)fs.Capacity) &&
        fs.ToString() == "NTFS", "ntfs-required");
      Walk("", true);
      Validate();
    }
    catch {
      Dispose();
      throw;
    }
  }
  void Walk(string relative, bool acquire) {
    var seen = new HashSet<string>(StringComparer.Ordinal);
    Scan(relative, acquire, seen);
    Need(seen.Count == expected.Count+dirs.Count, "inventory-count");
  }
  void Scan(string relative, bool acquire, HashSet<string> seen) {
    string folder = relative == ""?root:Path.Combine(root, relative.Replace('/', '\\'));
    Found f;
    IntPtr scan = FindFirstFileW(Path.Combine(folder, "*"), out f);
    if (scan == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    int count = 0;
    try {
      do {
        if (f.Name == "." || f.Name == "..") continue;
        Need(++count <= 257, "directory-entry-bound");
        string name = relative == ""?f.Name:relative+"/"+f.Name;
        Need(ValidRelative(name) && seen.Add(name), "enumerated-name-refused");
        bool directory = (f.Attr&0x10) != 0;
        Need((f.Attr&0x400) == 0, "enumerated-reparse-refused");
        Need(directory?dirs.Contains(name):expected.Contains(name), "undeclared-entry");
        if (acquire) held.Add(Open(Path.Combine(root, name.Replace('/', '\\')), directory, false));
        if (directory) Scan(name, acquire, seen);
      }
      while (FindNextFileW(scan, out f));
      Need(Marshal.GetLastWin32Error() == 18, "enumeration-failed");
    }
    finally {
      FindClose(scan);
    }
  }
  void Validate() {
    Need(!disposed, "lease-disposed");
    Need(held.Count <= 322, "handle-bound");
    Walk("", false);
    int files = 0, directories = 0;
    foreach (Held h in held) {
      Info i;
      Basic b;
      Read(h, out i, out b);
      Need(Same(h.I, i, h.B, b, h.Ancestor), "held-object-changed");
      Canonical(h);
      if (!h.Ancestor) {
        if (h.Directory) directories++;
        else files++;
      }
      Held current = Open(h.Path, h.Directory, h.Ancestor);
      try {
        Need(Same(h.I, current.I, h.B, current.B, h.Ancestor), "path-object-changed");
      }
      finally {
        CloseHandle(current.H);
      }
    }
    Need(files == expected.Count && directories == dirs.Count+1, "missing-inventory-entry");
  }
  public void Finish() {
    Need(!finished, "duplicate-finish");
    Validate();
    finished = true;
  }
  public void Dispose() {
    if (disposed) return;
    disposed = true;
    for (int i = held.Count-1;i >= 0;i--) CloseHandle(held[i].H);
    held.Clear();
  }
}
