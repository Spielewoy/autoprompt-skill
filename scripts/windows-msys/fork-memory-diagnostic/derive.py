#!/usr/bin/env python3
"""Create diagnostic-only launcher/controller copies; never mutates production."""
import argparse, hashlib, json, pathlib

sha = lambda value: hashlib.sha256(value).hexdigest()

def once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("source anchor is not unique: " + old[:120])
    return text.replace(old, new)

DEBUG_SUPPORT = r'''
 // Diagnostic-only debugger. DEBUG_PROCESS is used only in this derived copy.
 const UInt32 DEBUG_PROCESS=1,EXCEPTION_DEBUG_EVENT=1,CREATE_PROCESS_DEBUG_EVENT=3,EXIT_PROCESS_DEBUG_EVENT=5,LOAD_DLL_DEBUG_EVENT=6,DBG_CONTINUE=0x00010002,DBG_EXCEPTION_NOT_HANDLED=0x80010001,EXCEPTION_BREAKPOINT=0x80000003,ERROR_INVALID_HANDLE=6,ERROR_SEM_TIMEOUT=121,MEM_FREE=0x10000;
 [StructLayout(LayoutKind.Sequential)] struct EXCEPTION_RECORD { public UInt32 Code,Flags; public IntPtr Record,Address; public UInt32 ParameterCount; public UIntPtr P0,P1,P2,P3,P4,P5,P6,P7,P8,P9,P10,P11,P12,P13,P14; }
 [StructLayout(LayoutKind.Sequential)] struct EXCEPTION_DEBUG_INFO { public EXCEPTION_RECORD Record; public UInt32 FirstChance; }
 [StructLayout(LayoutKind.Sequential)] struct CREATE_PROCESS_DEBUG_INFO { public IntPtr File,Process,Thread,ImageBase; public UInt32 DebugOffset,DebugSize; public IntPtr ThreadLocalBase,StartAddress,ImageName; public UInt16 Unicode; }
 [StructLayout(LayoutKind.Sequential)] struct LOAD_DLL_DEBUG_INFO { public IntPtr File,Base; public UInt32 DebugOffset,DebugSize; public IntPtr ImageName; public UInt16 Unicode; }
 [StructLayout(LayoutKind.Explicit)] struct DEBUG_INFO { [FieldOffset(0)] public EXCEPTION_DEBUG_INFO Exception; [FieldOffset(0)] public CREATE_PROCESS_DEBUG_INFO Create; [FieldOffset(0)] public LOAD_DLL_DEBUG_INFO Load; }
 [StructLayout(LayoutKind.Sequential)] struct DEBUG_EVENT { public UInt32 Code,ProcessId,ThreadId; public DEBUG_INFO Info; }
 [StructLayout(LayoutKind.Sequential)] struct MEMORY_BASIC_INFORMATION { public IntPtr BaseAddress,AllocationBase; public UInt32 AllocationProtect; public UIntPtr RegionSize; public UInt32 State,Protect,Type; }
 [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION { public UInt32 Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,VolumeSerial,SizeHigh,SizeLow,Links,FileIndexHigh,FileIndexLow; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean WaitForDebugEvent(out DEBUG_EVENT debugEvent,UInt32 milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean ContinueDebugEvent(UInt32 processId,UInt32 threadId,UInt32 status);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr process,IntPtr address,out MEMORY_BASIC_INFORMATION information,UIntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern Boolean GetFileInformationByHandle(IntPtr file,out BY_HANDLE_FILE_INFORMATION information);
 sealed class ForkMemoryTrace { public readonly StringBuilder Text=new StringBuilder();public readonly HashSet<UInt32> InitialBreakpoints=new HashSet<UInt32>();public readonly HashSet<UInt32> Active=new HashSet<UInt32>();public readonly Dictionary<UInt32,IntPtr> ProcessHandles=new Dictionary<UInt32,IntPtr>();public readonly HashSet<String> Seen=new HashSet<String>();public Int32 Events,Processes,Loads,Spans,QueryError;public Boolean Overflow,Started; }
 static String Hex(UInt64 value){return "0x"+value.ToString("x");}
 static String FileIdentity(IntPtr file){if(file==IntPtr.Zero||file==new IntPtr(-1))return "none";BY_HANDLE_FILE_INFORMATION value;if(!GetFileInformationByHandle(file,out value))return "error:"+Marshal.GetLastWin32Error();return value.VolumeSerial.ToString("x8")+":"+value.FileIndexHigh.ToString("x8")+value.FileIndexLow.ToString("x8");}
 static void ScanCygheap(ForkMemoryTrace trace,IntPtr process,UInt32 pid,UInt32 eventCode,UInt64 loadBase,String fileIdentity){
  const UInt64 low=0x800000000,high=0xa00000000;UInt64 cursor=low;
  while(cursor<high){MEMORY_BASIC_INFORMATION value;UIntPtr got=VirtualQueryEx(process,new IntPtr(unchecked((Int64)cursor)),out value,(UIntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION)));if(got==UIntPtr.Zero){trace.QueryError=Marshal.GetLastWin32Error();return;}UInt64 baseAddress=unchecked((UInt64)value.BaseAddress.ToInt64()),size=value.RegionSize.ToUInt64();if(size==0||baseAddress>UInt64.MaxValue-size){trace.QueryError=-1;return;}UInt64 next=baseAddress+size;if(value.State!=MEM_FREE&&next>low&&baseAddress<high){UInt64 allocation=unchecked((UInt64)value.AllocationBase.ToInt64());String key=pid+":"+eventCode+":"+allocation+":"+baseAddress+":"+size+":"+value.State+":"+value.Type;if(trace.Seen.Add(key)){if(trace.Spans>=4096){trace.Overflow=true;return;}trace.Spans++;trace.Text.Append("span pid=").Append(pid).Append(" event=").Append(eventCode).Append(" load=").Append(Hex(loadBase)).Append(" eventFile=").Append(fileIdentity).Append(" base=").Append(Hex(baseAddress)).Append(" allocation=").Append(Hex(allocation)).Append(" size=").Append(Hex(size)).Append(" state=").Append(Hex(value.State)).Append(" type=").Append(Hex(value.Type)).Append(" protect=").Append(Hex(value.Protect)).Append('\n');}}if(next<=cursor){trace.QueryError=-2;return;}cursor=next;}
 }
 static Boolean PumpDebug(ForkMemoryTrace trace,UInt32 wait){
  DEBUG_EVENT value;if(!WaitForDebugEvent(out value,wait)){Int32 error=Marshal.GetLastWin32Error();if(error==ERROR_SEM_TIMEOUT||(error==ERROR_INVALID_HANDLE&&trace.Started&&trace.Active.Count==0))return false;throw new Win32Exception(error,"WaitForDebugEvent");}trace.Events++;if(trace.Events>65536)trace.Overflow=true;UInt32 continuation=DBG_CONTINUE;
  try {if(value.Code==CREATE_PROCESS_DEBUG_EVENT){trace.Started=true;trace.Active.Add(value.ProcessId);trace.ProcessHandles[value.ProcessId]=value.Info.Create.Process;trace.Processes++;if(trace.Processes>2048)trace.Overflow=true;if(!trace.Overflow)ScanCygheap(trace,value.Info.Create.Process,value.ProcessId,value.Code,unchecked((UInt64)value.Info.Create.ImageBase.ToInt64()),FileIdentity(value.Info.Create.File));}
   else if(value.Code==LOAD_DLL_DEBUG_EVENT){trace.Loads++;IntPtr process;if(!trace.Overflow&&trace.ProcessHandles.TryGetValue(value.ProcessId,out process))ScanCygheap(trace,process,value.ProcessId,value.Code,unchecked((UInt64)value.Info.Load.Base.ToInt64()),FileIdentity(value.Info.Load.File));else if(!trace.Overflow)trace.QueryError=-3;}
   else if(value.Code==EXCEPTION_DEBUG_EVENT){Boolean initial=value.Info.Exception.Record.Code==EXCEPTION_BREAKPOINT&&trace.InitialBreakpoints.Add(value.ProcessId);continuation=initial?DBG_CONTINUE:DBG_EXCEPTION_NOT_HANDLED;}
  } finally {if(value.Code==CREATE_PROCESS_DEBUG_EVENT&&value.Info.Create.File!=IntPtr.Zero)CloseHandle(value.Info.Create.File);else if(value.Code==LOAD_DLL_DEBUG_EVENT&&value.Info.Load.File!=IntPtr.Zero)CloseHandle(value.Info.Load.File);Check(ContinueDebugEvent(value.ProcessId,value.ThreadId,continuation),"ContinueDebugEvent");if(value.Code==EXIT_PROCESS_DEBUG_EVENT){trace.Active.Remove(value.ProcessId);trace.ProcessHandles.Remove(value.ProcessId);}}
  return true;
 }
 static void PumpAvailable(ForkMemoryTrace trace){while(PumpDebug(trace,0)){} }
 static Boolean DrainDebugJob(IntPtr job,Int32 timeout,ForkMemoryTrace trace){var clock=Stopwatch.StartNew();do{PumpDebug(trace,10);PumpAvailable(trace);if(Active(job)==0){PumpAvailable(trace);return true;}}while(clock.ElapsedMilliseconds<timeout);return false;}
 static Boolean TerminateAndDrainDebugProcess(IntPtr process,Int32 timeout,ForkMemoryTrace trace){if(!TerminateProcess(process,125))return false;var clock=Stopwatch.StartNew();do{PumpDebug(trace,10);PumpAvailable(trace);UInt32 wait=WaitForSingleObject(process,0);if(wait==UInt32.MaxValue)return false;if(wait==0&&trace.Active.Count==0)return true;}while(clock.ElapsedMilliseconds<timeout);return false;}
'''

def derive_native(data):
    text = data.decode('utf-8').replace('\r\n', '\n')
    text = once(text, 'public static class WindowsAppContainerNative {', 'public static class WindowsAppContainerNative {' + DEBUG_SUPPORT)
    text = once(text, 'public String AppContainerSid,StdoutBase64,StderrBase64;', 'public String AppContainerSid,StdoutBase64,StderrBase64,ForkMemoryDiagnosticBase64; public Int32 ForkMemoryEvents,ForkMemoryProcesses,ForkMemoryLoads,ForkMemorySpans,ForkMemoryQueryError; public Boolean ForkMemoryOverflow;')
    text = once(text, 'PROCESS_INFORMATION pi=new PROCESS_INFORMATION();Boolean assigned=false,confirmedDrain=true;', 'PROCESS_INFORMATION pi=new PROCESS_INFORMATION();Boolean assigned=false,confirmedDrain=true;var forkMemoryTrace=new ForkMemoryTrace();')
    text = once(text, 'EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW', 'EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW|DEBUG_PROCESS')
    text = once(text, 'for(;;){if(!String.IsNullOrEmpty(cancellationPath)', 'for(;;){PumpAvailable(forkMemoryTrace);if(!String.IsNullOrEmpty(cancellationPath)')
    text = once(text, 'if(Active(job)>0)Check(TerminateJobObject(job,125),"TerminateJobObject");if(!Drain(job,5000))', 'if(Active(job)>0)Check(TerminateJobObject(job,125),"TerminateJobObject");if(!DrainDebugJob(job,5000,forkMemoryTrace))')
    text = once(text, 'Cancelled=cancelled,StdoutBase64=Convert.ToBase64String(stdout.ToArray()),StderrBase64=Convert.ToBase64String(stderr.ToArray())', 'Cancelled=cancelled,StdoutBase64=Convert.ToBase64String(stdout.ToArray()),StderrBase64=Convert.ToBase64String(stderr.ToArray()),ForkMemoryDiagnosticBase64=Convert.ToBase64String(Encoding.ASCII.GetBytes(forkMemoryTrace.Text.ToString())),ForkMemoryEvents=forkMemoryTrace.Events,ForkMemoryProcesses=forkMemoryTrace.Processes,ForkMemoryLoads=forkMemoryTrace.Loads,ForkMemorySpans=forkMemoryTrace.Spans,ForkMemoryQueryError=forkMemoryTrace.QueryError,ForkMemoryOverflow=forkMemoryTrace.Overflow')
    text = once(text, 'if(!Drain(job,5000))drained=false;', 'if(!DrainDebugJob(job,5000,forkMemoryTrace))drained=false;')
    text = once(text, 'if(!TerminateProcess(pi.hProcess,125)||WaitForSingleObject(pi.hProcess,5000)!=0)drained=false;', 'if(!TerminateAndDrainDebugProcess(pi.hProcess,5000,forkMemoryTrace))drained=false;')
    return text.encode()

FORK_SCRIPT = ''' static String Script(String ready,String release,String before,String child,String after) { return "set -euo pipefail; if ! IFS= read -r pid < /proc/self/winpid; then exit 125; fi; printf '%s\\n' \\"$pid\\" > "+Shell(ready.Replace('\\\\','/'))+"; while [[ ! -e "+Shell(release.Replace('\\\\','/'))+" ]]; do :; done; printf 'before:%s\\n' \\"$pid\\" > "+Shell(before.Replace('\\\\','/'))+"; for ((i=0;i<256;i++)); do substituted=$(printf '%s' \\"$i\\"); [[ \\"$substituted\\" == \\"$i\\" ]]; ( : ); printf '%s\\n' \\"$i\\" | { IFS= read -r piped; [[ \\"$piped\\" == \\"$i\\" ]]; }; IFS= read -r processed < <(printf '%s\\n' \\"$i\\"); [[ \\"$processed\\" == \\"$i\\" ]]; { :; } & fork_child=$!; wait \\"$fork_child\\"; done; printf 'fork-ok:256'; printf 'fork-ok:256\\n' > "+Shell(child.Replace('\\\\','/'))+"; printf '%s:fork-ok:256\\n' \\"$pid\\" > "+Shell(after.Replace('\\\\','/')); }'''

def derive_controller(data):
    text = data.decode('utf-8').replace('\r\n', '\n')
    start = text.index(' static String Script(')
    end = text.index('\n static String ProbeScript(', start)
    text = text[:start] + FORK_SCRIPT + text[end:]
    text = once(text, 'env,90000,262144', 'env,150000,262144')
    text = once(text, 'Need(launch.task.Wait(95000),"launch-timeout")', 'Need(launch.task.Wait(155000),"launch-timeout")')
    text = once(text, 'Boolean success=completed.ExitCode==0&&stdout=="mapping-start\\nmapping-before\\nmapping-child=child\\n"&&stderr=="mapping-stderr-start\\n";', 'Boolean success=completed.ExitCode==0&&stdout=="fork-ok:256"&&stderr=="";')
    text = once(text, ',\\"stderrBase64\\":"+Json(completed.StderrBase64)+"}";', ',\\"stderrBase64\\":"+Json(completed.StderrBase64)+",\\"forkMemory\\":{\\"recordsBase64\\":"+Json(completed.ForkMemoryDiagnosticBase64)+",\\"events\\":"+completed.ForkMemoryEvents+",\\"processes\\":"+completed.ForkMemoryProcesses+",\\"loads\\":"+completed.ForkMemoryLoads+",\\"spans\\":"+completed.ForkMemorySpans+",\\"queryError\\":"+completed.ForkMemoryQueryError+",\\"overflow\\":"+(completed.ForkMemoryOverflow?"true":"false")+"}}";')
    return text.encode()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('native', type=pathlib.Path)
    parser.add_argument('native_sha256')
    parser.add_argument('controller', type=pathlib.Path)
    parser.add_argument('controller_sha256')
    parser.add_argument('output', type=pathlib.Path)
    args = parser.parse_args()
    native, controller = args.native.read_bytes(), args.controller.read_bytes()
    if sha(native) != args.native_sha256: raise ValueError('bound native source changed')
    if sha(controller) != args.controller_sha256: raise ValueError('bound controller source changed')
    derived_native, derived_controller = derive_native(native), derive_controller(controller)
    args.output.mkdir(exist_ok=False)
    (args.output/'windows-appcontainer-native-diagnostic.cs').write_bytes(derived_native)
    (args.output/'fork-memory-controller.cs').write_bytes(derived_controller)
    manifest = {'schema':1,'accepted':False,'purpose':'fork-memory-diagnostic-only','originalNativeSha256':sha(native),'derivedNativeSha256':sha(derived_native),'originalControllerSha256':sha(controller),'derivedControllerSha256':sha(derived_controller),'deriverSha256':sha(pathlib.Path(__file__).read_bytes())}
    (args.output/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n')

if __name__ == '__main__': main()
