using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Every mutation is limited to a fresh test-owned directory.
public static class BundlePhysicalControls {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateHardLinkW(string name, string existing, IntPtr security);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint capacity, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(IntPtr file, uint code, byte[] input, uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateFileMappingW(IntPtr file, IntPtr security, uint protect, uint high, uint low, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr MapViewOfFile(IntPtr mapping, uint access, uint high, uint low, UIntPtr length);
  [DllImport("kernel32.dll")] static extern bool UnmapViewOfFile(IntPtr view);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool result) {
    if (!result) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static string CanonicalOwnedDirectory(string path) {
    IntPtr handle = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      StringBuilder result = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, result, (uint)result.Capacity, 0);
      if (length == 0 || length >= result.Capacity || !result.ToString().StartsWith(@"\\?\", StringComparison.Ordinal)) {
        throw new InvalidOperationException("fixture-canonical-path");
      }
      return result.ToString().Substring(4);
    } finally { CloseHandle(handle); }
  }
  public static void HardLink(string name, string existing) {
    Check(CreateHardLinkW(name, existing, IntPtr.Zero));
  }
  public static void Junction(string name, string target) {
    // NTFS mount-point reparse data: substitute and print names are counted
    // UTF-16 byte strings, with distinct terminators inside the path buffer.
    Directory.CreateDirectory(name);
    byte[] substitute = Encoding.Unicode.GetBytes(@"\??\" + Path.GetFullPath(target));
    byte[] print = Encoding.Unicode.GetBytes(Path.GetFullPath(target));
    byte[] buffer = new byte[16 + substitute.Length + 2 + print.Length + 2];
    Array.Copy(BitConverter.GetBytes(0xa0000003u), 0, buffer, 0, 4);
    Array.Copy(BitConverter.GetBytes((ushort)(buffer.Length - 8)), 0, buffer, 4, 2);
    Array.Copy(BitConverter.GetBytes((ushort)substitute.Length), 0, buffer, 10, 2);
    Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length + 2)), 0, buffer, 12, 2);
    Array.Copy(BitConverter.GetBytes((ushort)print.Length), 0, buffer, 14, 2);
    Array.Copy(substitute, 0, buffer, 16, substitute.Length);
    Array.Copy(print, 0, buffer, 18 + substitute.Length, print.Length);
    IntPtr handle = CreateFileW(name, 0x40000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      uint returned;
      Check(DeviceIoControl(handle, 0x000900a4, buffer, (uint)buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero));
    } finally { CloseHandle(handle); }
  }
  public sealed class WritableMapping : IDisposable {
    IntPtr mapping, view;
    public WritableMapping(string path) {
      IntPtr file = CreateFileW(path, 0xc0000000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (file == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        mapping = CreateFileMappingW(file, IntPtr.Zero, 4, 0, 0, null);
        if (mapping == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        view = MapViewOfFile(mapping, 2, 0, 0, UIntPtr.Zero);
        if (view == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      } catch { Dispose(); throw; }
      finally { CloseHandle(file); }
      // The writable section and view survive; the creating file handle does
      // not. This tests the mapping restriction independently of a writer fd.
    }
    public void Dispose() {
      if (view != IntPtr.Zero) { UnmapViewOfFile(view); view = IntPtr.Zero; }
      if (mapping != IntPtr.Zero) { CloseHandle(mapping); mapping = IntPtr.Zero; }
    }
  }
}
