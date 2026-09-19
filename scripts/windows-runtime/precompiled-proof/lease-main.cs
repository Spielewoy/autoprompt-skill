using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

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
    } catch { Console.Error.WriteLine("bundle-lease-refused"); return 1; }
  }
}
