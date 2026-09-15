$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PROOF_BUILD_SCRIPT,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Builder parser errors'}
foreach($name in @('Run','WriteNodeBuildProgress','SelectNodeVisualStudio','SelectNodeBuildPlan','NodeBuildCommand','AssertNodePeBytes','AssertNodeIdentity','ReadNodeToolMachine','FindNodeVswhere','Physical','NodeBuildOutput')) {
 $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true))
 if($functions.Count -ne 1){throw "One actual $name helper required"}
 . ([ScriptBlock]::Create($functions[0].Extent.Text))
}
function Need([bool]$Value,[string]$Reason){if(-not $Value){throw $Reason}}
function Refuses([scriptblock]$Action){$failed=$false;try{& $Action | Out-Null}catch{$failed=$true};if(-not $failed){throw 'Invalid input accepted'}}
foreach($case in @(@('17.14.37325.6','vs2022'),@('18.9.12009.81','vs2026'))) {
 Need ((SelectNodeVisualStudio $case[0]) -ceq $case[1]) 'Supported toolchain selection mismatch'
}
foreach($version in @('17.13.1','19.0.0','18.0&exit','')) {Refuses {SelectNodeVisualStudio $version}}
$planCases=0
foreach($architecture in @('x64','arm64')) {
 $plan=SelectNodeBuildPlan $architecture $architecture.ToUpperInvariant() $architecture.ToUpperInvariant()
 $arm=$architecture -ceq 'arm64'
 Need ($plan.architecture -ceq $architecture -and $plan.nasmRequired -eq (-not $arm)) 'Target or NASM plan mismatch'
 Need ($plan.processorArchitecture -ceq $(if($arm){'ARM64'}else{'AMD64'}) -and $plan.vcvars -ceq $(if($arm){'arm64'}else{'amd64'})) 'Host environment or vcvars mismatch'
 $components=@($(if($arm){'Microsoft.VisualStudio.Component.VC.Tools.ARM64'}else{'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'}),'Microsoft.VisualStudio.Component.VC.Llvm.Clang','Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset')
 if($arm){$components+='Microsoft.VisualStudio.Component.VC.ATL.ARM64'}
 Need (($plan.requirements -join '|') -ceq ($components -join '|')) 'Target component inventory mismatch';$planCases++
 foreach($vs in @('vs2022','vs2026')){Need ((NodeBuildCommand $plan $vs) -ceq "vcbuild.bat $architecture $vs clang-cl nonpm nocorepack no-cctest") 'Closed build command mismatch';$planCases++}
 Refuses {NodeBuildCommand $plan 'vs2026&exit'};$planCases++
 $identity=[pscustomobject]@{node='v24.20.0';arch=$architecture;platform='win32'}
 AssertNodeIdentity $identity $plan;$planCases++
 foreach($field in @('node','arch','platform')){$saved=$identity.$field;$identity.$field='wrong';Refuses {AssertNodeIdentity $identity $plan};$identity.$field=$saved;$planCases++}
}
foreach($tuple in @(@('x64','arm64','arm64'),@('arm64','x64','arm64'),@('arm64','arm64','x64'),@('x64','x64','arm64'),@('arm64','arm64','x86'),@('x86','x86','x86'),@('arm64&exit','arm64','arm64'))) {
 Refuses {SelectNodeBuildPlan $tuple[0] $tuple[1] $tuple[2]};$planCases++
}
$work=$env:PROOF_WORK;$logs=Join-Path $work 'logs';[IO.Directory]::CreateDirectory($logs)|Out-Null
$roots=@((Join-Path $work 'program-files-x86'),(Join-Path $work 'program-files'))
$installer=Join-Path $roots[1] 'Microsoft Visual Studio/Installer/vswhere.exe'
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($installer));[IO.File]::WriteAllText($installer,'fixture')
Need ((FindNodeVswhere $roots) -ceq [IO.Path]::GetFullPath($installer)) 'ARM installer-root fallback missing'
$preferred=Join-Path $roots[0] 'Microsoft Visual Studio/Installer/vswhere.exe'
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($preferred));[IO.File]::WriteAllText($preferred,'fixture')
Need ((FindNodeVswhere $roots) -ceq [IO.Path]::GetFullPath($preferred)) 'Existing x86 installer root preference changed'
Refuses {FindNodeVswhere @((Join-Path $work 'missing'))}
$outputSource=Join-Path $work 'output-source'
$expectedOutput=[IO.Path]::GetFullPath((Join-Path $outputSource 'out/Release/node.exe'))
Need ((NodeBuildOutput $outputSource) -ceq $expectedOutput) 'Build output did not select physical out/Release/node.exe'
Refuses {Physical (Join-Path $outputSource 'Release/node.exe')}
Refuses {NodeBuildOutput (Join-Path $work 'linked-output-source')}
Refuses {NodeBuildOutput (Join-Path $work 'missing-output-source')}
$peCases=0
foreach($architecture in @('x64','arm64')) {
 $plan=SelectNodeBuildPlan $architecture $architecture $architecture
 $bytes=[byte[]]::new(384);$bytes[0]=0x4d;$bytes[1]=0x5a
 [BitConverter]::GetBytes([uint32]64).CopyTo($bytes,60);[BitConverter]::GetBytes([uint32]0x4550).CopyTo($bytes,64)
 [BitConverter]::GetBytes([uint16]$plan.machine).CopyTo($bytes,68);[BitConverter]::GetBytes([uint16]240).CopyTo($bytes,84)
 [BitConverter]::GetBytes([uint16]2).CopyTo($bytes,86);[BitConverter]::GetBytes([uint16]0x20b).CopyTo($bytes,88)
 AssertNodePeBytes $bytes $plan;$peCases++
 $file=Join-Path $work ($architecture+'.exe');[IO.File]::WriteAllBytes($file,$bytes)
 Need ((ReadNodeToolMachine $file) -eq $plan.machine) 'Tool PE machine must be recorded accurately';$peCases++
 foreach($offset in @(0,60,64,68,88)){$bad=[byte[]]$bytes.Clone();$bad[$offset]=$bad[$offset] -bxor 1;Refuses {AssertNodePeBytes $bad $plan};$peCases++}
 $bad=[byte[]]$bytes.Clone();[BitConverter]::GetBytes([uint16]0x2002).CopyTo($bad,86);Refuses {AssertNodePeBytes $bad $plan};$peCases++
 $bad=[byte[]]$bytes.Clone();[BitConverter]::GetBytes([uint32]::MaxValue).CopyTo($bad,60);Refuses {AssertNodePeBytes $bad $plan};[IO.File]::WriteAllBytes($file,$bad);Refuses {ReadNodeToolMachine $file};$peCases+=2
 Refuses {AssertNodePeBytes ([byte[]]::new(89)) $plan};$peCases++
 foreach($size in @(1,65535)){$bad=[byte[]]$bytes.Clone();[BitConverter]::GetBytes([uint16]$size).CopyTo($bad,84);Refuses {AssertNodePeBytes $bad $plan};$peCases++}
 $bad=[byte[]]$bytes.Clone();$bad[86]=0;Refuses {AssertNodePeBytes $bad $plan};$peCases++
}
$script:PendingCompilerStreams=[Collections.Generic.List[object]]::new()
$environment=@{};if($env:SystemRoot){$environment.SystemRoot=$env:SystemRoot}
$script:Records=[Collections.Generic.List[string]]::new()
function Observe([scriptblock]$Action) {& $Action 6>&1 | ForEach-Object {$script:Records.Add($_.ToString())}}
Observe {Run $env:PROOF_NODE @('-e','process.stdout.write("out");process.stderr.write("err")') 'success' 5}
Need ([IO.File]::ReadAllText((Join-Path $logs 'success.stdout.txt')) -ceq 'out' -and [IO.File]::ReadAllText((Join-Path $logs 'success.stderr.txt')) -ceq 'err') 'Output not preserved'
$failed=$false;try{Observe {Run $env:PROOF_NODE @('-e','process.exit(7)') 'failure' 5}}catch{if($_.Exception.Message -notmatch 'exit 7'){throw};$failed=$true}
Need $failed 'Exit failure accepted'
$clock=[Diagnostics.Stopwatch]::StartNew();$failed=$false
try{Observe {Run $env:PROOF_NODE @('-e','setInterval(()=>{},1000)') 'timeout' 1}}catch{if($_.Exception.Message -notmatch 'timed out.*descendant state unconfirmed'){throw};$failed=$true}
Need ($failed -and $clock.ElapsedMilliseconds -le 15000) 'Timeout was not bounded'
Need ($script:PendingCompilerStreams.Count -eq 0) 'Known closed streams should have drained'
$expected=@('success:start','success:exit','failure:start','failure:failure','timeout:start','timeout:timeout','timeout:failure')
Need ($script:Records.Count -eq $expected.Count) 'Unexpected progress record count'
for($i=0;$i -lt $expected.Count;$i++) {
 $match=[regex]::Match($script:Records[$i],'^node-build stage=([a-z-]+) state=([a-z-]+) elapsedMs=([0-9]+)$')
 Need $match.Success 'Nonclosed progress protocol'
 Need (($match.Groups[1].Value+':'+$match.Groups[2].Value) -ceq $expected[$i]) 'Wrong progress phase'
 if($match.Groups[2].Value -ceq 'start'){Need ($match.Groups[3].Value -ceq '0') 'Start timing differs'}
}
@{processCases=3;toolchainCases=6;planCases=$planCases;peCases=$peCases;progressRecords=$script:Records.Count;installerCases=3;outputCases=4} | ConvertTo-Json -Compress
