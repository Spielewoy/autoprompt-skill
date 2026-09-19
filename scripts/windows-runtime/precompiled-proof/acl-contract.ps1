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
$match=[BundleAclProbe].GetMethod('MatchesNormalizedPath',[Reflection.BindingFlags]'NonPublic,Static')
Assert ([BundleAclProbe].GetField('NormalizedVolumePath',[Reflection.BindingFlags]'NonPublic,Static').GetRawConstantValue() -eq 4)
Assert ($match.Invoke($null,@([uint32]15,'\private-target','C:\private-target')))
Assert ($match.Invoke($null,@([uint32]15,'\PRIVATE-target','C:\private-target')))
Assert (-not $match.Invoke($null,@([uint32]21,'\\?\C:\private-target','C:\private-target')))
Assert (-not $match.Invoke($null,@([uint32]6,'\other','C:\private-target')))
Assert (-not $match.Invoke($null,@([uint32]0,'\private-target','C:\private-target')))
Assert (-not $match.Invoke($null,@([uint32]32768,'\private-target','C:\private-target')))
$hidden=[Reflection.BindingFlags]'NonPublic,Static'
$unicode=[BundleAclProbe].GetNestedType('UnicodeName',[Reflection.BindingFlags]'NonPublic')
$attributes=[BundleAclProbe].GetNestedType('ObjectAttributes',[Reflection.BindingFlags]'NonPublic')
$io=[BundleAclProbe].GetNestedType('IoStatus',[Reflection.BindingFlags]'NonPublic')
Assert ([Runtime.InteropServices.Marshal]::SizeOf([type]$unicode) -eq 16)
Assert ([Runtime.InteropServices.Marshal]::SizeOf([type]$attributes) -eq 48)
Assert ([Runtime.InteropServices.Marshal]::SizeOf([type]$io) -eq 16)
foreach($item in @(@($unicode,'Buffer',8),@($attributes,'RootDirectory',8),@($attributes,'ObjectName',16),@($attributes,'Attributes',24),@($attributes,'SecurityDescriptor',32),@($attributes,'SecurityQualityOfService',40),@($io,'Information',8))){Assert ([Runtime.InteropServices.Marshal]::OffsetOf([type]$item[0],[string]$item[1]).ToInt64() -eq $item[2])}
$name=[Activator]::CreateInstance($unicode)
Assert ($name.Length -eq 0 -and $name.MaximumLength -eq 0 -and $name.Buffer -eq [IntPtr]::Zero)
$attrs=[BundleAclProbe].GetMethod('RelativeAttributes',$hidden).Invoke($null,@([IntPtr]123,[IntPtr]456))
Assert ($attrs.Length -eq 48 -and $attrs.RootDirectory -eq [IntPtr]123 -and $attrs.ObjectName -eq [IntPtr]456 -and $attrs.Attributes -eq 64)
Assert ($attrs.SecurityDescriptor -eq [IntPtr]::Zero -and $attrs.SecurityQualityOfService -eq [IntPtr]::Zero)
Assert ([BundleAclProbe].GetField('RelativeOptions',$hidden).GetRawConstantValue() -eq 0x00200021)
Assert ([BundleAclProbe].GetField('RelativeSharing',$hidden).GetRawConstantValue() -eq 3)
$readAccess=[BundleAclProbe].GetField('RelativeReadAccess',$hidden).GetRawConstantValue()
$writeAccess=[BundleAclProbe].GetField('RelativeWriteAccess',$hidden).GetRawConstantValue()
Assert ($readAccess -eq 0x00120080)
Assert ($writeAccess -eq 0x00140000)
Assert (($readAccess -band $writeAccess) -eq 0x00100000)
$denied=[BundleAclProbe].GetMethod('ExactDenied',$hidden)
Assert ($denied.Invoke($null,@([int]-1073741790,[IntPtr]::Zero)))
Assert ($denied.Invoke($null,@([int]-1073741790,[IntPtr](-1))))
Assert (-not $denied.Invoke($null,@([int]-1073741790,[IntPtr]123)))
foreach($status in @([int]0,[int]259,[int]-1073741795,[int]5)){Assert (-not $denied.Invoke($null,@($status,[IntPtr]::Zero)))}
$granted=[BundleAclProbe].GetMethod('ExactGranted',$hidden)
Assert ($granted.Invoke($null,@([int]0,[IntPtr]123)))
Assert (-not $granted.Invoke($null,@([int]0,[IntPtr]::Zero)))
Assert (-not $granted.Invoke($null,@([int]0,[IntPtr](-1))))
foreach($status in @([int]259,[int]1,[int]-1073741790)){Assert (-not $granted.Invoke($null,@($status,[IntPtr]123)))}
[Console]::WriteLine("actual-compiled-acl-parser-contracts:$count")
