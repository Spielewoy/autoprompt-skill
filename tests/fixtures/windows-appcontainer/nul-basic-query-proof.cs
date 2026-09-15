using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Host-only diagnostic: no AppContainer launch, device ACL change or caller handle.
public static class NulBasicQueryProof {
 [StructLayout(LayoutKind.Sequential)] struct Security { public Int32 Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public Boolean Inherit; }
 [StructLayout(LayoutKind.Sequential)] struct Unicode { public UInt16 Length,MaximumLength; public IntPtr Buffer; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(String name,UInt32 access,UInt32 share,ref Security security,UInt32 disposition,UInt32 flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UInt32 GetFileType(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean GetHandleInformation(IntPtr handle,out UInt32 flags);
 [DllImport("ntdll.dll")] static extern Int32 NtQueryObject(IntPtr handle,Int32 kind,IntPtr buffer,UInt32 length,out UInt32 returned);
 static void Need(Boolean value,String reason){if(!value)throw new InvalidOperationException(reason);}
 static String ObjectText(IntPtr handle,Int32 kind){
  IntPtr buffer=Marshal.AllocHGlobal(4096);
  try {
   UInt32 returned;Int32 status=NtQueryObject(handle,kind,buffer,4096,out returned);Int32 header=Marshal.SizeOf(typeof(Unicode));
   Need(status==0&&returned>=header&&returned<=4096,"host-object-query:"+unchecked((UInt32)status).ToString("x8")+":"+returned);
   var value=(Unicode)Marshal.PtrToStructure(buffer,typeof(Unicode));Int64 offset=value.Buffer.ToInt64()-buffer.ToInt64();
   Need((value.Length&1)==0&&value.Length<=512&&value.MaximumLength>=value.Length&&offset>=header&&offset<=(Int64)returned-value.Length,"host-object-bound");
   return Marshal.PtrToStringUni(value.Buffer,value.Length/2);
  }finally{Marshal.FreeHGlobal(buffer);}
 }
 public static String Run(){
  var security=new Security{Length=Marshal.SizeOf(typeof(Security)),Inherit=true};
  IntPtr handle=CreateFileW("NUL",0x12019f,3,ref security,3,0x80,IntPtr.Zero);
  if(handle==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"host-owned-null-open");
  try {
   UInt32 flags;Need(GetFileType(handle)==2&&GetHandleInformation(handle,out flags)&&flags==1,"host-owned-null-type-flags");
   Need(ObjectText(handle,2)=="File"&&ObjectText(handle,1)==@"\Device\Null","host-owned-null-identity");
   var text=new StringBuilder("{\"schemaVersion\":1,\"pointerBits\":"+(IntPtr.Size*8)+",\"objectType\":\"File\",\"objectName\":\"\\\\Device\\\\Null\",\"requestedAccess\":1180063,\"queries\":[");
   Boolean first=true;
   foreach(UInt32 length in new UInt32[]{56,256,512}){
    IntPtr buffer=Marshal.AllocHGlobal((Int32)length);
    try {
     // Initialize storage and never interpret fields after an unsuccessful query.
     Marshal.Copy(new Byte[length],0,buffer,(Int32)length);
     UInt32 returned;Int32 status=NtQueryObject(handle,0,buffer,length,out returned);
     String granted=status==0&&returned>=8&&returned<=length?unchecked((UInt32)Marshal.ReadInt32(buffer,4)).ToString(System.Globalization.CultureInfo.InvariantCulture):"null";
     if(!first)text.Append(',');first=false;
     text.Append("{\"requested\":"+length+",\"returned\":"+returned+",\"status\":\""+unchecked((UInt32)status).ToString("x8")+"\",\"grantedAccess\":"+granted+"}");
    }finally{Marshal.FreeHGlobal(buffer);}
   }
   return text.Append("]}").ToString();
  }finally{Need(CloseHandle(handle),"host-owned-null-close");}
 }
}
