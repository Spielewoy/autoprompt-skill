$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'audit.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'native-controls.cs')
$count=0
function Assert($value) { if (-not $value) { throw "contract-$script:count" }; $script:count++ }
foreach($p in @('manifest.json','assets/node.br','source/v24.20.0.tar.gz')) { Assert ([BundlePhysicalLease]::ValidRelative($p)) }
foreach($p in @('','../x','A','a//b','a\b','con','a/nul.txt','a:ads','a.','a ','a/COM1')) { Assert (-not [BundlePhysicalLease]::ValidRelative($p)) }
Assert ([BundlePhysicalLease]::ValidState(1,32,1,$false))
Assert ([BundlePhysicalLease]::ValidState(1,16,9,$true))
foreach($v in @(@(2,32,1,$false),@(1,1056,1,$false),@(1,32,2,$false),@(1,32,0,$false),@(1,16,1,$false),@(1,32,1,$true))) { Assert (-not [BundlePhysicalLease]::ValidState($v[0],$v[1],$v[2],$v[3])) }
# Invoke the actual private snapshot comparator; never a handwritten substitute.
$t=[BundlePhysicalLease]; $flags=[Reflection.BindingFlags]'NonPublic,Static'; $nested=[Reflection.BindingFlags]'NonPublic'
$info=$t.GetNestedType('Info',$nested);$basic=$t.GetNestedType('Basic',$nested);$same=$t.GetMethod('Same',$flags)
$a=[Activator]::CreateInstance($info);$b=[Activator]::CreateInstance($info);$x=[Activator]::CreateInstance($basic);$y=[Activator]::CreateInstance($basic)
Assert ($same.Invoke($null,@($a,$b,$x,$y,$false)))
foreach($field in @('Volume','IdHigh','IdLow','Attr','Links','High','Low')) { $b=[Activator]::CreateInstance($info);$info.GetField($field).SetValue($b,[uint32]1);Assert (-not $same.Invoke($null,@($a,$b,$x,$y,$false))) }
$b=[Activator]::CreateInstance($info)
foreach($field in @('Write','Change')) {$y=[Activator]::CreateInstance($basic);$basic.GetField($field).SetValue($y,[long]1);Assert (-not $same.Invoke($null,@($a,$b,$x,$y,$false)));Assert ($same.Invoke($null,@($a,$b,$x,$y,$true)))}
[Console]::WriteLine("actual-csharp-contracts:$count")
