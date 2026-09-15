$clock = [Diagnostics.Stopwatch]::StartNew()
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
# Validate the real .NET compiler temporary path before the first Add-Type.
$helperTemp = [IO.Path]::GetFullPath($env:TEMP)
if ($env:TMP -cne $env:TEMP -or -not [IO.Directory]::Exists($helperTemp) -or
    [IO.Path]::GetTempPath().TrimEnd('\') -ine $helperTemp.TrimEnd('\')) {
  throw 'owned-helper-temp-required'
}
# ReadAsync on synchronized Console.In may block before returning on .NET
# Framework. Run the bounded synchronous read on a CLR pool worker instead.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading.Tasks;
public static class BundleLeaseInput {
 public static void End(int milliseconds) {
  if (milliseconds <= 0) throw new TimeoutException();
  Task<int> task = Task.Run(delegate { return Console.In.Read(); });
  if (!task.Wait(milliseconds) || task.Result != -1) throw new InvalidOperationException("trailing-input");
 }
 public static string Line(int limit, int milliseconds) {
  if(milliseconds<=0) throw new TimeoutException();
  Task<string> task=Task.Run(delegate {
   StringBuilder b=new StringBuilder();
   for(;;) { int c=Console.In.Read(); if(c<0) throw new InvalidOperationException("eof"); if(c==10) return b.ToString(); if(c==13||b.Length>=limit) throw new InvalidOperationException("line-bound"); b.Append((char)c); }
  });
  if(!task.Wait(milliseconds)) throw new TimeoutException();
  return task.Result;
 }
}
'@
function Read-BoundedLine([int]$Limit) {
  $left = 60000 - $clock.ElapsedMilliseconds
  if ($left -le 0) { throw 'lease-deadline' }
  [BundleLeaseInput]::Line($Limit, [int]$left)
}
$lease = $null
try {
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((Read-BoundedLine 32768)))
  Add-Type -TypeDefinition $source
  $request = ConvertFrom-Json (Read-BoundedLine 65536)
  if (($request.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'files,root') { throw 'request-shape' }
  $lease = [BundlePhysicalLease]::new([string]$request.root, [string[]]$request.files)
  [Console]::Out.WriteLine('bundle-lease-ready-v1'); [Console]::Out.Flush()
  if ((Read-BoundedLine 16) -cne 'finish') { throw 'finish-required' }
  [BundleLeaseInput]::End([int](60000 - $clock.ElapsedMilliseconds))
  $lease.Finish()
  $lease.Dispose(); $lease = $null
  [Console]::Out.WriteLine('bundle-lease-finished-v1'); [Console]::Out.Flush()
} catch { [Console]::Error.WriteLine('bundle-lease-refused'); exit 1 }
finally { if ($null -ne $lease) { $lease.Dispose() } }
