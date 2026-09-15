$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'driver.ps1'))
$m=[regex]::Match($text,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
if(-not $m.Success){throw 'source-extraction'}
Add-Type -TypeDefinition ($m.Groups[1].Value + @'
public sealed class StalledBundleReader : System.IO.TextReader { public override int Read() { System.Threading.Thread.Sleep(1000); return -1; } }
'@)
[Console]::SetIn([IO.StringReader]::new("ok`n"))
if([BundleLeaseInput]::Line(2,1000) -cne 'ok'){throw 'valid'}
foreach($text in @('eof',"long`n")){[Console]::SetIn([IO.StringReader]::new($text));$failed=$false;try{[void][BundleLeaseInput]::Line(2,1000)}catch{$failed=$true};if(-not $failed){throw 'bound'}}
[Console]::SetIn([StalledBundleReader]::new())
$clock=[Diagnostics.Stopwatch]::StartNew();$failed=$false
try{[void][BundleLeaseInput]::Line(2,20)}catch{$failed=$true}
if(-not $failed -or $clock.ElapsedMilliseconds -gt 700){throw 'not-independently-bounded'}
[Console]::WriteLine('actual-driver-reader-contracts:4')
