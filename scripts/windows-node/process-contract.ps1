$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PROOF_BUILD_SCRIPT,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Builder parser errors'}
$functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Run'},$true))
if($functions.Count -ne 1){throw 'One actual Run helper required'}
. ([ScriptBlock]::Create($functions[0].Extent.Text))
$work=$env:PROOF_WORK;$logs=Join-Path $work 'logs';[IO.Directory]::CreateDirectory($logs)|Out-Null
$script:PendingCompilerStreams=[Collections.Generic.List[object]]::new()
$environment=@{};if($env:SystemRoot){$environment.SystemRoot=$env:SystemRoot}
Run $env:PROOF_NODE @('-e','process.stdout.write("out");process.stderr.write("err")') 'success' 5
if([IO.File]::ReadAllText((Join-Path $logs 'success.stdout.txt')) -cne 'out' -or [IO.File]::ReadAllText((Join-Path $logs 'success.stderr.txt')) -cne 'err'){throw 'Output not preserved'}
$failed=$false;try{Run $env:PROOF_NODE @('-e','process.exit(7)') 'failure' 5}catch{if($_.Exception.Message -notmatch 'exit 7'){throw};$failed=$true}
if(-not $failed){throw 'Exit failure accepted'}
$clock=[Diagnostics.Stopwatch]::StartNew();$failed=$false
try{Run $env:PROOF_NODE @('-e','setInterval(()=>{},1000)') 'timeout' 1}catch{if($_.Exception.Message -notmatch 'timed out.*descendant state unconfirmed'){throw};$failed=$true}
if(-not $failed -or $clock.ElapsedMilliseconds -gt 15000){throw 'Timeout was not bounded'}
if($script:PendingCompilerStreams.Count -ne 0){throw 'Known closed streams should have drained'}
'{"processCases":3}'
