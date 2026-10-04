// Test-only native-call substitutes. The compiled lease and wait state machine
// are copied verbatim from pipe-proof.cs; no substitute enters the native probe.
public static class PipeWaitFake {
 public static int Mode,Waits,Cancels,Closes,Submits;
 static System.IntPtr Request,Input,Signal,Root;
 static int Status(uint value){return unchecked((int)value);}
 public static uint Map(int status){return unchecked((uint)status);}
 public static System.IntPtr Event(System.IntPtr a,bool manual,bool initial,string name){
  if(!manual||initial||name!=null)throw new System.Exception("event-contract");return new System.IntPtr(200);
 }
 public static bool Close(System.IntPtr handle){if(handle!=Signal)throw new System.Exception("close-unowned");Closes++;return true;}
 public static int Submit(System.IntPtr root,System.IntPtr signal,System.IntPtr apc,System.IntPtr context,System.IntPtr io,uint code,System.IntPtr input,uint length,System.IntPtr output,uint outputLength){
  Submits++;Request=io;Input=input;Signal=signal;Root=root;
  if(code!=0x110018||apc!=System.IntPtr.Zero||context!=System.IntPtr.Zero||output!=System.IntPtr.Zero||outputLength!=0||length<16)throw new System.Exception("submit-contract");
  if(System.Runtime.InteropServices.Marshal.ReadInt64(input)!=-500000L||System.Runtime.InteropServices.Marshal.ReadByte(input,12)!=1||System.Runtime.InteropServices.Marshal.ReadInt32(input,8)!=length-14)throw new System.Exception("input-contract");
  if(Mode==0)return Status(0xc0000022);
  if(Mode==1){System.Runtime.InteropServices.Marshal.WriteInt32(io,0);return 0;}
  if(Mode==10)return 0; // Inconsistent success with a still-pending IOSB.
  return 0x103;
 }
 public static uint Wait(System.IntPtr signal,uint timeout){
  if(signal!=Signal||timeout!=2000)throw new System.Exception("wait-contract");Waits++;
  if(Waits==1&&Mode>=3&&Mode<=8)return Mode==5?uint.MaxValue:258;
  if(Mode==6)return 258;
  if(Mode==9)return 0; // Signaled event with pending IOSB must retain memory.
  System.Runtime.InteropServices.Marshal.WriteInt32(Request,Mode==2?Status(0xc00000b5):Mode==4?0:Status(0xc0000120));return 0;
 }
 public static int Cancel(System.IntPtr root,System.IntPtr request,System.IntPtr cancel){
  if(root!=Root||request!=Request||cancel==request||cancel==System.IntPtr.Zero)throw new System.Exception("targeted-cancel-contract");Cancels++;
  if(Mode==8)return 0x103;
  if(Mode!=7)System.Runtime.InteropServices.Marshal.WriteInt32(cancel,0);
  return Mode==4?Status(0xc0000225):0;
 }
 public static string Run(int mode){
  Mode=mode;Waits=Cancels=Closes=Submits=0;
  var type=typeof(MsysPipeProof);var flags=System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic;
  var method=type.GetMethod("ProbePipeWait",flags);var slot=type.GetField("RetainedPipeWait",flags);
  string report=null,error=null;bool retained=false,rootHeld=false,retryRefused=false,memoryReadable=false;
  try{report=(string)method.Invoke(null,new object[]{new System.IntPtr(100),@"Sessions\2\AppContainerNamedObjects\S-1-15-2-1\owned-proof"});}
  catch(System.Reflection.TargetInvocationException exception){error=exception.InnerException.Message.Split(':')[0];}
  var lease=slot.GetValue(null);retained=lease!=null;
  if(retained){
   if(Closes!=0)throw new System.Exception("pending-event-closed");
   var leaseType=lease.GetType();
   foreach(string field in new[]{"Input","RequestIo","CancelIo","Signal","Root"})if((System.IntPtr)leaseType.GetField(field).GetValue(lease)==System.IntPtr.Zero)throw new System.Exception("retained-null-"+field);
   memoryReadable=System.Runtime.InteropServices.Marshal.ReadInt64(Input)==-500000L;
   rootHeld=(bool)type.GetMethod("IsRetainedPipeRoot",flags).Invoke(null,new object[]{Root});
   try{method.Invoke(null,new object[]{Root,"owned-proof"});}catch(System.Reflection.TargetInvocationException exception){retryRefused=exception.InnerException.Message=="prior-flat-wait-undrained";}
   // No real I/O exists in this substitute. Only the test can retire this
   // otherwise deliberately leaked lease after proving all pointers survived.
   leaseType.GetField("Submitted").SetValue(lease,false);leaseType.GetMethod("Release").Invoke(lease,null);slot.SetValue(null,null);
  }
  return "{\"mode\":"+mode+",\"report\":"+(report??"null")+",\"error\":"+(error==null?"null":"\""+error+"\"")+",\"waits\":"+Waits+",\"cancels\":"+Cancels+",\"closes\":"+Closes+",\"submits\":"+Submits+",\"retained\":"+retained.ToString().ToLowerInvariant()+",\"rootHeld\":"+rootHeld.ToString().ToLowerInvariant()+",\"retryRefused\":"+retryRefused.ToString().ToLowerInvariant()+",\"memoryReadable\":"+memoryReadable.ToString().ToLowerInvariant()+"}";
 }
}
