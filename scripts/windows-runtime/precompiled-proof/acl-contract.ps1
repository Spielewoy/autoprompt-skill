$ErrorActionPreference='Stop'
Add-Type -Path @((Join-Path $PSScriptRoot '../physical-proof/audit.cs'),(Join-Path $PSScriptRoot 'lease-main.cs'))
$count=0
function Assert($value){if(-not $value){throw "acl-contract-$script:count"};$script:count++}
function Reject([string[]]$Arguments){$failed=$false;try{[void][BundleAclProbe]::Parse($Arguments)}catch{$failed=$true};Assert $failed}
$sid='S-1-15-2-1-2-3-4-5-6-4294967295';$identity='01234567:fedcba9876543210'
$r=[BundleAclProbe]::Parse(@('--acl-probe',$sid,'C:\target directory',$identity))
Assert ($r.Sid -ceq $sid -and $r.Target -ceq 'C:\target directory' -and $r.Identity -ceq $identity)
$long=[BundleAclProbe]::Parse(@('--acl-probe',$sid,('C:\'+('long\'*60)+'target'),$identity));Assert ($long.Target.Length -gt 260)
$method=[BundleAclProbe].GetMethod('NativePath',[Reflection.BindingFlags]'NonPublic,Static')
Assert ($method.Invoke($null,@($long.Target)) -ceq ('\\?\'+$long.Target))
foreach($s in @('', 'S-1-15-2-1','S-1-15-2-1-2-3-4-5-6-4294967296','S-1-15-2-01-2-3-4-5-6-7','s-1-15-2-1-2-3-4-5-6-7',($sid+"`n"),($sid+"`0"))){Reject @('--acl-probe',$s,'C:\target',$identity)}
foreach($p in @('', 'target','\\server\target','\\?\C:\target','C:/target','C:\target\','C:\target\..\other','C:\target\.\other','C:\target\\other','C:\target.','C:\target ','C:\target:stream',"C:\bad`nname",('C:\'+('x'*2046)))){Reject @('--acl-probe',$sid,$p,$identity)}
foreach($id in @('', '01234567:1','01234567:FEDCBA9876543210',('x'+$identity.Substring(1)),($identity+"`n"),($identity+':5'))){Reject @('--acl-probe',$sid,'C:\target',$id)}
Reject @('--acl-probe',$sid,'C:\target',$identity,'extra');Reject @('--other',$sid,'C:\target',$identity);Reject @()
$observation=[BundleAclProbe].GetMethod('PathObservation',[Reflection.BindingFlags]'NonPublic,Static')
function Observe([uint32]$flags,[uint32]$length,[int]$error,[string]$value){return $observation.Invoke($null,@($flags,$length,$error,$value,'C:\private-target'))}
Assert ((Observe 0 21 123 '\\?\C:\private-target') -ceq 'f0,len=21,error=0,kind=DOS,equal=1,exact=1')
Assert ((Observe 0 0 5 '') -ceq 'f0,len=0,error=5,kind=other,equal=0,exact=0')
Assert ((Observe 4 15 55 '\private-target') -ceq 'f4,len=15,error=0,kind=other,equal=1,exact=1')
Assert ((Observe 8 21 0 '\\?\c:\private-target') -ceq 'f8,len=21,error=0,kind=DOS,equal=1,exact=0')
Assert ((Observe 12 32768 0 '\private-target') -ceq 'f12,len=32768,error=0,kind=other,equal=0,exact=0')
Assert ((Observe 0 28 0 '\Device\HarddiskVolume1\private') -match ',kind=NT,equal=0,exact=0$')
Assert ((Observe 0 40 0 '\\?\Volume{secret}\private') -match ',kind=GUID,equal=0,exact=0$')
Assert ((Observe 0 18 -1 'sensitive private text') -notmatch 'sensitive|private|text')
[Console]::WriteLine("actual-compiled-acl-parser-contracts:$count")
