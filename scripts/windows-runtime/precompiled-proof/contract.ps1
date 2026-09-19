$ErrorActionPreference='Stop'
Add-Type -Path @((Join-Path $PSScriptRoot '../physical-proof/audit.cs'),(Join-Path $PSScriptRoot 'lease-main.cs'))
Add-Type -TypeDefinition 'public sealed class StalledBundleReader : System.IO.TextReader { public override int Read() { System.Threading.Thread.Sleep(1000); return -1; } }'
$count=0
function Assert($value) { if(-not $value){throw "contract-$script:count"};$script:count++ }
function Reject([scriptblock]$Run) { $failed=$false;try{&$Run}catch{$failed=$true};Assert $failed }
$r=[BundleLeaseMain]::Parse('{"root":"C:\\bundle","files":["manifest.json","assets/node.br"]}')
Assert ($r.Root -ceq 'C:\bundle' -and $r.Files.Count -eq 2 -and $r.Files[1] -ceq 'assets/node.br')
$r=[BundleLeaseMain]::Parse('{"root":"C:\\b\u00e9\ud83d\ude00","files":["manifest.json"]}')
Assert ($r.Root -ceq ('C:\b'+[char]0xe9+[char]0xd83d+[char]0xde00))
foreach($text in @(
  '', '{}', '{"files":["manifest.json"],"root":"C:\\b"}',
  '{"root":"C:\\b","files":[]}', '{"root":"C:\\b","files":[null]}',
  '{"root":"C:\\b","files":["manifest.json"],"extra":true}',
  '{"root":"C:\\b","files":["manifest.json"],"files":["manifest.json"]}',
  '{"root":"C:\\b","files":["../x"]}', '{"root":"C:\\b","files":["con"]}',
  '{"root":"C:\\b","files":["A"]}', '{"root":"C:\\b","files":["manifest.json",]}',
  '{"root":"C:\\b","files":["manifest.json"]}x',
  '{"root":"C:\\b\ud800","files":["manifest.json"]}',
  '{"root":"C:\\b\udc00","files":["manifest.json"]}',
  '{"root":"C:\\b\ud800\u0041","files":["manifest.json"]}',
  '{"root":"C:\\b\uGGGG","files":["manifest.json"]}',
  '{"root":"C:\\b\x00","files":["manifest.json"]}',
  ('{"root":"C:\b'+[char]0xe9+'","files":["manifest.json"]}'),
  '{"root":"","files":["manifest.json"]}',
  ('{"root":"'+('a'*2049)+'","files":["manifest.json"]}'),
  ('{"root":"C:\\b","files":['+((1..130 | ForEach-Object { '"manifest.json"' }) -join ',')+']}'),
  ('x'*65537)
)) { Reject { [void][BundleLeaseMain]::Parse($text) } }
Assert ([BundleLeaseMain]::Line([IO.StringReader]::new("ok`n"),2,1000) -ceq 'ok')
foreach($text in @('eof',"long`n","bad`r`n",([char]0x80+"`n"))) { Reject { [void][BundleLeaseMain]::Line([IO.StringReader]::new($text),3,1000) } }
[BundleLeaseMain]::End([IO.StringReader]::new(''),1000);Assert $true
Reject {[BundleLeaseMain]::End([IO.StringReader]::new('x'),1000)}
foreach($method in @('Line','End')) {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  if($method -eq 'Line'){Reject {[void][BundleLeaseMain]::Line([StalledBundleReader]::new(),8,20)}}else{Reject {[BundleLeaseMain]::End([StalledBundleReader]::new(),20)}}
  Assert ($clock.ElapsedMilliseconds -lt 700)
}
Reject {[void][BundleLeaseMain]::Line([IO.StringReader]::new("x`n"),8,0)}
Reject {[BundleLeaseMain]::End([IO.StringReader]::new(''),0)}
# The production constructor's path/state checks are the copied exact source.
Assert ([BundlePhysicalLease]::ValidState(1,32,1,$false))
Assert (-not [BundlePhysicalLease]::ValidState(1,32,2,$false))
Assert (-not [BundlePhysicalLease]::ValidState(1,1056,1,$false))
[Console]::WriteLine("actual-compiled-helper-contracts:$count")
