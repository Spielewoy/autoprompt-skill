#!/usr/bin/env python3
"""Trace-only launcher transformation; original lifecycle remains intact."""
import pathlib,hashlib,json,argparse
sha=lambda b:hashlib.sha256(b).hexdigest()
def once(text,old,new):
    if text.count(old)!=1:raise ValueError('Source anchor not unique: '+old)
    return text.replace(old,new)
def derive_controller(data):
    text=data.decode('utf-8').replace('\r\n','\n')
    return once(text,' if(failure!=null){Console.Error.WriteLine(failure);', ' Console.Error.WriteLine("TRACE-DRAIN:"+(drained?"confirmed":"unknown"));\n if(failure!=null){Console.Error.WriteLine(failure);').encode()

def derive(data):
    text=data.decode('utf-8').replace('\r\n','\n')
    helper='''
 // Diagnostic DLL only: an additional alias, never a replacement standard handle.
 [DllImport("kernel32.dll",EntryPoint="DuplicateHandle",SetLastError=true)] static extern Boolean DuplicateTraceHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,UInt32 access,Boolean inherit,UInt32 options);
 static String[] TraceEnvironment(String[] entries,IntPtr handle) {
  const String key="AUTOPROMPT_DIAGNOSTIC_FORK_TRACE_HANDLE=";
  if(entries.Any(x=>x.StartsWith(key,StringComparison.OrdinalIgnoreCase)))throw new InvalidOperationException("TRACE_LOCATOR_ALREADY_PRESENT");
  return entries.Concat(new[]{key+handle.ToInt64().ToString("x16")}).ToArray();
 }
'''
    text=once(text,'public static class WindowsAppContainerNative {','public static class WindowsAppContainerNative {'+helper)
    text=once(text,'stderrWrite=IntPtr.Zero,nulRead=IntPtr.Zero','stderrWrite=IntPtr.Zero,traceWrite=IntPtr.Zero,nulRead=IntPtr.Zero')
    text=once(text,'   handleList=Marshal.AllocHGlobal(IntPtr.Size*4);','   Check(DuplicateTraceHandle(new IntPtr(-1),stderrWrite,new IntPtr(-1),out traceWrite,0,true,2),"trace-owned-pipe-alias");\n   handleList=Marshal.AllocHGlobal(IntPtr.Size*5);')
    text=once(text,'Marshal.WriteIntPtr(handleList,IntPtr.Size*3,privateNull);','Marshal.WriteIntPtr(handleList,IntPtr.Size*3,privateNull);Marshal.WriteIntPtr(handleList,IntPtr.Size*4,traceWrite);')
    text=once(text,'handleList,(IntPtr)(IntPtr.Size*4),','handleList,(IntPtr)(IntPtr.Size*5),')
    text=once(text,'EnvironmentBlock(OwnedNullEnvironment(environmentEntries,privateNull))','EnvironmentBlock(TraceEnvironment(OwnedNullEnvironment(environmentEntries,privateNull),traceWrite))')
    text=once(text,'stderrWrite=IntPtr.Zero;Check(CloseHandle(nulRead)','stderrWrite=IntPtr.Zero;Check(CloseHandle(traceWrite),"trace-close-parent-alias");traceWrite=IntPtr.Zero;Check(CloseHandle(nulRead)')
    text=once(text,'new[]{stdoutRead,stdoutWrite,stderrRead,stderrWrite,nulRead,privateNull}','new[]{stdoutRead,stdoutWrite,stderrRead,stderrWrite,nulRead,privateNull,traceWrite}')
    return text.encode()
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source',type=pathlib.Path);p.add_argument('expected');p.add_argument('output',type=pathlib.Path);p.add_argument('--controller',type=pathlib.Path);p.add_argument('--controller-sha');a=p.parse_args();data=a.source.read_bytes()
    if sha(data)!=a.expected:raise ValueError('Externally bound native source changed')
    result=derive(data);a.output.mkdir(exist_ok=False);
    if a.controller:
        controller=a.controller.read_bytes()
        if sha(controller)!=a.controller_sha:raise ValueError('Externally bound controller changed')
        (a.output/'controller-trace.cs').write_bytes(derive_controller(controller))
    (a.output/'native-trace.cs').write_bytes(result)
    (a.output/'native-trace-manifest.json').write_text(json.dumps({'schema':1,'purpose':'fork-initialization-diagnostic-only','accepted':False,'originalNativeSha256':sha(data),'derivedNativeSha256':sha(result),'deriverSha256':sha(pathlib.Path(__file__).read_bytes())},indent=2)+'\n')
