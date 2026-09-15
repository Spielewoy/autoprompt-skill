// The loader replaces only three DllImport boundaries in the complete production
// source. These are adversarial native return values, not Windows execution.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
public static class NullCapabilityMock {
 [StructLayout(LayoutKind.Sequential)] public struct Unicode { public UInt16 Length,MaximumLength; public IntPtr Buffer; }
 public static UInt32 Kind,Flags,Access; public static Boolean FlagSuccess;
 public static Int32 BadQuery,Status,Queries; public static String Fault;
 public static readonly List<Int32> Order=new List<Int32>();
 public const UInt32 Required=0x0012019f;
 public static void Reset(){Kind=2;Flags=1;Access=Required;FlagSuccess=true;BadQuery=-1;Status=0;Fault="";Queries=0;Order.Clear();}
 static void Handle(IntPtr handle){if(handle!=new IntPtr(0xabcdef))throw new InvalidOperationException("unexpected-handle");}
 public static UInt32 GetFileType(IntPtr handle){Handle(handle);return Kind;}
 public static Boolean GetHandleInformation(IntPtr handle,out UInt32 flags){Handle(handle);flags=Flags;return FlagSuccess;}
 public static Int32 NtQueryObject(IntPtr handle,Int32 information,IntPtr buffer,UInt32 length,out UInt32 required){
  Handle(handle);if(length!=512||buffer==IntPtr.Zero)throw new InvalidOperationException("unbounded-query");Queries++;Order.Add(information);
  for(Int32 i=0;i<512;i++)Marshal.WriteByte(buffer,i,0);
  Boolean bad=information==BadQuery;required=512;
  if(information==0){Marshal.WriteInt32(buffer,4,unchecked((Int32)Access));if(bad&&Fault=="short")required=7;else if(bad&&Fault=="oversize")required=513;else if(bad&&Fault=="minimal")required=8;}
  else{
   if(information!=1&&information!=2)throw new InvalidOperationException("unexpected-query-kind");
   String text=information==2?"File":@"\Device\Null";
   if(bad&&Fault=="case")text=text.ToUpperInvariant();
   if(bad&&Fault=="wrong")text=new String('X',text.Length);
   Int32 header=Marshal.SizeOf(typeof(Unicode)),bytes=text.Length*2;
   var value=new Unicode{Length=(UInt16)bytes,MaximumLength=(UInt16)bytes,Buffer=IntPtr.Add(buffer,header)};
   Marshal.Copy(text.ToCharArray(),0,value.Buffer,text.Length);required=(UInt32)(header+bytes);
   if(bad){
    if(Fault=="short")required=(UInt32)(header-1);
    if(Fault=="oversize")required=513;
    if(Fault=="header-only")required=(UInt32)header;
    if(Fault=="odd")value.Length--;
    if(Fault=="long")value.Length+=2;
    if(Fault=="capacity")value.MaximumLength--;
    if(Fault=="null")value.Buffer=IntPtr.Zero;
    if(Fault=="before")value.Buffer=IntPtr.Add(buffer,-2);
    if(Fault=="header-overlap")value.Buffer=IntPtr.Add(buffer,header-2);
    if(Fault=="past-return")value.Buffer=IntPtr.Add(buffer,header+2);
    if(Fault=="outside")value.Buffer=IntPtr.Add(buffer,512);
   }
   Marshal.StructureToPtr(value,buffer,false);
  }
  return bad?Status:0;
 }
}
public static class NullCapabilityContract {
 static Int32 cases;static readonly IntPtr Handle=new IntPtr(0xabcdef);
 static Object Call(String name,params Object[] args){try{return typeof(WindowsAppContainerNative).GetMethod(name,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}catch(TargetInvocationException error){throw error.InnerException;}}
 static void Need(Boolean condition,String code){if(!condition)throw new InvalidOperationException(code);}
 static void Refuses(String code,Action action){try{action();}catch(InvalidOperationException error){Need(error.Message==code,"wrong-refusal:"+error.Message+":"+code);return;}throw new InvalidOperationException("accepted:"+code);}
 static void Verify(){Call("VerifyPrivateNullHandle",Handle);}
 static String[] Owned(String[] entries){return (String[])Call("OwnedNullEnvironment",entries,Handle);}
 static String Block(String[] entries){IntPtr value=(IntPtr)Call("EnvironmentBlock",(Object)entries);try{return Marshal.PtrToStringUni(value,entries.Sum(x=>x.Length+1)+1);}finally{Marshal.FreeHGlobal(value);}}
 static void NativeCase(Action change,String expected){NullCapabilityMock.Reset();change();if(expected==null)Verify();else Refuses(expected,Verify);cases++;}
 static String[] Entries(Int32 count){return Enumerable.Range(0,count).Select(i=>i==0?"SystemRoot=C:\\Windows":"K"+i+"=v").ToArray();}
 public static void Run(){
  NativeCase(()=>{},null);Need(NullCapabilityMock.Order.SequenceEqual(new[]{0,2,1}),"all-object-identities-required");
  foreach(UInt32 kind in new UInt32[]{0,1,3})NativeCase(()=>NullCapabilityMock.Kind=kind,"WINDOWS_NULL_CAPABILITY_INVALID");
  NativeCase(()=>NullCapabilityMock.FlagSuccess=false,"WINDOWS_NULL_CAPABILITY_INVALID");
  NativeCase(()=>NullCapabilityMock.Flags=0,"WINDOWS_NULL_CAPABILITY_INVALID");
  Need(NullCapabilityMock.Queries==0,"invalid-handle-must-not-query-object");
  NativeCase(()=>NullCapabilityMock.Access|=0x00040000,null);
  for(Int32 bit=0;bit<32;bit++){UInt32 mask=1u<<bit;if((NullCapabilityMock.Required&mask)!=0)NativeCase(()=>NullCapabilityMock.Access&=~mask,"WINDOWS_NULL_CAPABILITY_ACCESS");}
  foreach(String fault in new[]{"short","oversize"})NativeCase(()=>{NullCapabilityMock.BadQuery=0;NullCapabilityMock.Fault=fault;},"WINDOWS_NULL_CAPABILITY_ACCESS");
  NativeCase(()=>{NullCapabilityMock.BadQuery=0;NullCapabilityMock.Fault="minimal";},null);
  foreach(Int32 kind in new[]{0,2,1})foreach(Int32 status in new[]{unchecked((Int32)0xc0000022),1})NativeCase(()=>{NullCapabilityMock.BadQuery=kind;NullCapabilityMock.Status=status;},kind==0?"WINDOWS_NULL_CAPABILITY_ACCESS":"WINDOWS_NULL_CAPABILITY_IDENTITY");
  foreach(Int32 kind in new[]{2,1}){
   foreach(String fault in new[]{"short","oversize","header-only","odd","long","capacity","null","before","header-overlap","past-return","outside","wrong"})NativeCase(()=>{NullCapabilityMock.BadQuery=kind;NullCapabilityMock.Fault=fault;},"WINDOWS_NULL_CAPABILITY_IDENTITY");
   NativeCase(()=>{NullCapabilityMock.BadQuery=kind;NullCapabilityMock.Fault="case";},null);
  }
  String key="AUTOPROMPT_PRIVATE_NUL_HANDLE",hex=IntPtr.Size==8?"0000000000abcdef":"00abcdef";
  String[] original={"z=last","SystemRoot=C:\\Windows","a=Ω=value"},saved=(String[])original.Clone();
  var culture=CultureInfo.CurrentCulture;String[] owned;
  try{CultureInfo.CurrentCulture=new CultureInfo("tr-TR");owned=Owned(original);}finally{CultureInfo.CurrentCulture=culture;}
  Need(!Object.ReferenceEquals(owned,original)&&original.SequenceEqual(saved)&&owned.Take(original.Length).SequenceEqual(saved)&&owned.Last()==key+"="+hex,"immutable-exact-hex-environment");cases++;
  Need(Block(owned)=="a=Ω=value\0"+key+"="+hex+"\0SystemRoot=C:\\Windows\0z=last\0\0"&&original.SequenceEqual(saved),"sorted-double-null-utf16-block");cases++;
  foreach(String alias in new[]{key,key.ToLowerInvariant(),"Autoprompt_Private_Nul_Handle"})foreach(String value in new[]{"","x=y"}){Refuses("WINDOWS_NULL_CAPABILITY_RESERVED",()=>Owned(new[]{"SystemRoot=x",alias+"="+value}));cases++;}
  foreach(String entry in new[]{"x="+key+"=value",key+"_OTHER=x","X"+key+"=x"}){Block(Owned(new[]{"SystemRoot=x",entry}));cases++;}
  foreach(IntPtr invalid in new[]{IntPtr.Zero,new IntPtr(-1)}){Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Call("OwnedNullEnvironment",original,invalid));cases++;}
  Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Owned(null));cases++;
  Need(Owned(Entries(64)).Length==65,"preserve-64-caller-capacity");Block(Owned(Entries(64)));cases++;
  Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Owned(Entries(65)));cases++;
  Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Block(Entries(66)));cases++;
  foreach(String[] invalid in new[]{new String[]{null},new[]{"=x","SystemRoot=x"},new[]{"bad","SystemRoot=x"},new[]{"x=a\0b","SystemRoot=x"},new[]{"SystemRoot=x","systemroot=y"},new[]{"x=y"}}){Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Block(Owned(invalid)));cases++;}
  Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Call("EnvironmentBlock",(Object)null));cases++;
  String[] sized=Owned(new[]{"SystemRoot=x","x="});Int32 filler=32760-sized.Sum(x=>x.Length+1);sized[1]+=new String('a',filler);
  Need(Block(sized).Length==32761,"exact-utf16-entry-length-limit");cases++;
  sized[1]+="a";Refuses("WINDOWS_ENVIRONMENT_INVALID",()=>Block(sized));cases++;
  Console.Write("{\"contractCases\":"+cases+",\"nativeApiBoundaries\":3}");
 }
}
