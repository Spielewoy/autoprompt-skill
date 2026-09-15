# Diagnostic compiler only; never installs or selects a worker runtime.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$WorkRoot,[Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture,[string]$InputCache,[ValidateRange(60,5400)][int]$BuildTimeoutSeconds=3600)
[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Windows PowerShell Core 7+ is required for bounded process-tree cleanup' }
function SelectNodeBuildPlan([string]$Target,[string]$ProcessArchitecture,[string]$OSArchitecture) {
  $targetName=$Target.ToLowerInvariant()
  if($targetName -cnotin @('x64','arm64') -or $ProcessArchitecture.ToLowerInvariant() -cne $targetName -or $OSArchitecture.ToLowerInvariant() -cne $targetName){throw 'Node proof target must match the native process and OS architecture'}
  $arm=$targetName -ceq 'arm64'
  $requirements=@($(if($arm){'Microsoft.VisualStudio.Component.VC.Tools.ARM64'}else{'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'}),'Microsoft.VisualStudio.Component.VC.Llvm.Clang','Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset')
  if($arm){$requirements+='Microsoft.VisualStudio.Component.VC.ATL.ARM64'}
  return [pscustomobject]@{architecture=$targetName;processorArchitecture=$(if($arm){'ARM64'}else{'AMD64'});vcvars=$(if($arm){'arm64'}else{'amd64'});nasmRequired=(-not $arm);machine=$(if($arm){0xaa64}else{0x8664});requirements=$requirements}
}
function NodeBuildCommand($Plan,[string]$VisualStudio) {
  if($Plan.architecture -cnotin @('x64','arm64') -or $VisualStudio -cnotin @('vs2022','vs2026')){throw 'Invalid closed Node build command'}
  return "vcbuild.bat $($Plan.architecture) $VisualStudio clang-cl nonpm nocorepack no-cctest"
}
function AssertNodePeBytes([byte[]]$Bytes,$Plan) {
  if($null -eq $Bytes -or $Bytes.Length -lt 90 -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a){throw 'Built Node lacks bounded DOS header'}
  $offset=[BitConverter]::ToUInt32($Bytes,60)
  if($offset -lt 64 -or $offset -gt $Bytes.Length-26 -or [BitConverter]::ToUInt32($Bytes,[int]$offset) -ne 0x4550){throw 'Built Node lacks bounded PE header'}
  $machine=[BitConverter]::ToUInt16($Bytes,[int]$offset+4)
  $optional=[BitConverter]::ToUInt16($Bytes,[int]$offset+20)
  $flags=[BitConverter]::ToUInt16($Bytes,[int]$offset+22)
  if($machine -ne $Plan.machine -or $optional -lt 112 -or $optional -gt $Bytes.Length-$offset-24 -or [BitConverter]::ToUInt16($Bytes,[int]$offset+24) -ne 0x20b -or ($flags -band 2) -eq 0 -or ($flags -band 0x2000) -ne 0){throw 'Built Node PE architecture or executable kind mismatch'}
}
function ReadNodeToolMachine([string]$Path) {
  $stream=[IO.File]::OpenRead($Path);$reader=[IO.BinaryReader]::new($stream)
  try {
    $header=$reader.ReadBytes(64)
    if($header.Length -ne 64 -or $header[0] -ne 0x4d -or $header[1] -ne 0x5a){throw 'Compiler tool lacks DOS header'}
    $offset=[BitConverter]::ToUInt32($header,60)
    if($offset -lt 64 -or $offset -gt $stream.Length-6){throw 'Compiler tool lacks bounded PE header'}
    [void]$stream.Seek($offset,[IO.SeekOrigin]::Begin)
    if($reader.ReadUInt32() -ne 0x4550){throw 'Compiler tool lacks PE signature'}
    return $reader.ReadUInt16()
  } finally {$reader.Dispose();$stream.Dispose()}
}
function AssertNodeIdentity($Identity,$Plan) {
  if($Identity.node -cne 'v24.20.0' -or $Identity.arch -cne $Plan.architecture -or $Identity.platform -cne 'win32'){throw 'Built Node identity mismatch'}
}
function WriteNodeBuildProgress([string]$Stage,[string]$State,[long]$ElapsedMs) {
  if($Stage -cnotmatch '^[a-z0-9][a-z0-9.-]{0,63}$' -or $State -cnotin @('start','running','exit','timeout','failure','drain-unconfirmed') -or $ElapsedMs -lt 0){throw 'Invalid bounded build progress record'}
  Write-Host "node-build stage=$Stage state=$State elapsedMs=$ElapsedMs"
}
$plan=SelectNodeBuildPlan $Architecture ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()) ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString())
$lockPath=Join-Path $PSScriptRoot 'build-lock.json'
$lock=Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
if ($lock.schema -ne 1 -or $lock.version -ne '24.20.0') { throw 'Unexpected compiler lock' }
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Physical([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  if (-not [IO.Path]::IsPathRooted($Path) -or -not (Test-Path -LiteralPath $full)) { throw 'Existing absolute path required' }
  for($p=$full;$p;$p=[IO.Path]::GetDirectoryName($p)) {
    if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked compiler path refused' }
  }
  return $full
}
function FindNodeVswhere([string[]]$Roots) {
  foreach($root in $Roots) {
    if([string]::IsNullOrEmpty($root)){continue}
    $candidate=Join-Path $root 'Microsoft Visual Studio\Installer\vswhere.exe'
    if(Test-Path -LiteralPath $candidate -PathType Leaf){return (Physical $candidate)}
  }
  throw 'Visual Studio Installer vswhere.exe is required in a declared Program Files root'
}
# Check every existing source before mutation, and require the new header to
# be absent. The same function verifies all generated bytes after application.
function AssertNodePatchSources([string]$Source,$Pin,[bool]$Patched) {
  foreach($file in $Pin.files.PSObject.Properties) {
    $target=Join-Path $Source $file.Name
    $expected=if($Patched){$file.Value.candidateSha256}else{$file.Value.originalSha256}
    if($null -eq $expected) {
      if(Test-Path -LiteralPath $target){throw 'New private NUL header already exists'}
    } else {
      $physical=Physical $target
      if((Hash $physical) -cne $expected){throw "Private NUL source digest mismatch: $($file.Name)"}
    }
  }
}
$work=[IO.Path]::GetFullPath($WorkRoot)
if ($work -cnotmatch '^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$' -or $work.Contains('..') -or (Test-Path -LiteralPath $work)) { throw 'WorkRoot must be a fresh absolute ASCII directory without spaces or command metacharacters' }
$parent=Physical ([IO.Path]::GetDirectoryName($work))
[IO.Directory]::CreateDirectory($work) | Out-Null
# Only this newly created owned directory is relabeled. Never change source,
# SDK, cache, user-project or existing workspace ACLs.
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($user.Value,'S-1-5-18') | Select-Object -Unique) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
}
[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($work),$acl)
foreach($name in @('inputs','logs','temp','source','tools','stage')) { [IO.Directory]::CreateDirectory((Join-Path $work $name)) | Out-Null }
$logs=Join-Path $work 'logs'
function Fetch([string]$Name,[string]$Url,[string]$Digest) {
  $destination=Join-Path $work ('inputs\'+$Name)
  $fetchClock=[Diagnostics.Stopwatch]::StartNew();WriteNodeBuildProgress ('fetch-'+$Name) 'start' 0
  if($InputCache) { $cached=Physical (Join-Path $InputCache $Name); if((Hash $cached) -ne $Digest){throw "Input cache digest mismatch: $Name"};[IO.File]::Copy($cached,$destination,$false) }
  else { Invoke-WebRequest -Uri $Url -OutFile $destination -TimeoutSec 120 }
  if((Hash $destination) -ne $Digest){throw "Downloaded input digest mismatch: $Name"}
  WriteNodeBuildProgress ('fetch-'+$Name) 'exit' $fetchClock.ElapsedMilliseconds
  return $destination
}
$sourceArchive=Fetch $lock.source.file $lock.source.url $lock.source.sha256
$nasmArchive=$null
if($plan.nasmRequired){$nasmArchive=Fetch $lock.nasm.file $lock.nasm.url $lock.nasm.sha256}
$patch=Physical (Join-Path $PSScriptRoot $lock.patch.file)
if((Hash $patch) -ne $lock.patch.sha256){throw 'Patch digest differs from reviewed lock'}
[IO.File]::Copy($patch,(Join-Path $work 'inputs\libuv-appcontainer-pipes.patch'),$false)
$nulPatch=Physical (Join-Path $PSScriptRoot $lock.nulPatch.file)
if((Hash $nulPatch) -ne $lock.nulPatch.sha256){throw 'Private NUL patch digest differs from reviewed lock'}
[IO.File]::Copy($nulPatch,(Join-Path $work 'inputs\libuv-private-nul-capability.patch'),$false)
[IO.File]::Copy($lockPath,(Join-Path $work 'inputs\build-lock.json'),$false)
$system=Physical $env:SystemRoot
$tar=Physical (Join-Path $system 'System32\tar.exe')
$cmd=Physical (Join-Path $system 'System32\cmd.exe')
$python=Physical (Get-Command python.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$git=Physical (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
# Match upstream's two explicit installer roots; never select an ambient PATH tool.
$vswhere=FindNodeVswhere @(${env:ProgramFiles(x86)},$env:ProgramFiles)
# Build tools run on the host, with only explicitly selected compiler inputs.
# No ambient compiler/linker flags or project credentials enter the child.
$environment=@{
 SystemRoot=$system;WINDIR=$system;SystemDrive=[IO.Path]::GetPathRoot($system).TrimEnd('\');ComSpec=$cmd
 PATH=([IO.Path]::GetDirectoryName($python)+';'+[IO.Path]::GetDirectoryName($git)+';'+[IO.Path]::GetDirectoryName($vswhere)+';'+(Join-Path $system 'System32')+';'+$system)
 PATHEXT='.COM;.EXE;.BAT;.CMD';TEMP=(Join-Path $work 'temp');TMP=(Join-Path $work 'temp')
 NUMBER_OF_PROCESSORS='4';PROCESSOR_ARCHITECTURE=$plan.processorArchitecture
 ProgramFiles=$env:ProgramFiles;'ProgramFiles(x86)'=${env:ProgramFiles(x86)};ProgramW6432=$env:ProgramW6432
 USERPROFILE=[Environment]::GetFolderPath('UserProfile');LOCALAPPDATA=[Environment]::GetFolderPath('LocalApplicationData');APPDATA=[Environment]::GetFolderPath('ApplicationData');ProgramData=[Environment]::GetFolderPath('CommonApplicationData')
 GIT_CONFIG_NOSYSTEM='1';GIT_CONFIG_SYSTEM='NUL';GIT_CONFIG_GLOBAL='NUL';GIT_TERMINAL_PROMPT='0'
}
$script:PendingCompilerStreams=[Collections.Generic.List[object]]::new()
function Run([string]$Exe,[string[]]$Arguments,[string]$Name,[int]$Timeout=120,[string]$Cwd=$work) {
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Exe;$info.WorkingDirectory=$Cwd;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.Environment.Clear();foreach($key in $environment.Keys){$info.Environment[$key]=[string]$environment[$key]}
  foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
  $out=[IO.File]::Open((Join-Path $logs ($Name+'.stdout.txt')),[IO.FileMode]::CreateNew)
  $err=[IO.File]::Open((Join-Path $logs ($Name+'.stderr.txt')),[IO.FileMode]::CreateNew)
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info
  $outTask=$null;$errTask=$null;$timedOut=$false
  $clock=[Diagnostics.Stopwatch]::StartNew()
  try {
    if(-not $process.Start()){throw "Failed to start $Name"};$clock.Restart();WriteNodeBuildProgress $Name 'start' 0;$process.StandardInput.Close()
    $outTask=$process.StandardOutput.BaseStream.CopyToAsync($out);$errTask=$process.StandardError.BaseStream.CopyToAsync($err)
    $nextProgress=60000L;$exited=$false
    for(;;) {
      $remaining=([long]$Timeout*1000)-$clock.ElapsedMilliseconds
      if($remaining -le 0){$exited=$process.WaitForExit(0);break}
      if($process.WaitForExit([int][Math]::Min(1000L,$remaining))){$exited=$true;break}
      if($clock.ElapsedMilliseconds -ge $nextProgress){WriteNodeBuildProgress $Name 'running' $clock.ElapsedMilliseconds;$nextProgress=$clock.ElapsedMilliseconds+60000L}
    }
    if(-not $exited) {
      $timedOut=$true;WriteNodeBuildProgress $Name 'timeout' $clock.ElapsedMilliseconds
      try { $process.Kill($true) } catch { Write-Warning "Could not request complete compiler tree termination: $Name" }
      # Waiting for the root does not prove every descendant terminated.
      # No output tree is deleted, reused or declared safe on this path.
      [void]$process.WaitForExit(10000)
    }
    $copies=[Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($outTask,$errTask))
    if(-not $copies.Wait(10000)){WriteNodeBuildProgress $Name 'drain-unconfirmed' $clock.ElapsedMilliseconds;throw "Compiler output drain unconfirmed; owned work tree retained: $Name"}
    if($timedOut){throw "Compiler timed out; tree termination requested, descendant state unconfirmed; owned work tree retained: $Name"}
    if($process.ExitCode -ne 0){throw "Compiler operation failed: $Name, exit $($process.ExitCode); see $logs"}
    WriteNodeBuildProgress $Name 'exit' $clock.ElapsedMilliseconds
  } catch {
    WriteNodeBuildProgress $Name 'failure' $clock.ElapsedMilliseconds
    throw
  } finally {
    if(($null -eq $outTask -or $outTask.IsCompleted) -and ($null -eq $errTask -or $errTask.IsCompleted)) {
      $out.Dispose();$err.Dispose();$process.Dispose()
    } else {
      # Do not close files underneath pending asynchronous copies. Keep their
      # objects alive until the disposable build-host process exits.
      $script:PendingCompilerStreams.Add(@{process=$process;stdout=$out;stderr=$err;stdoutTask=$outTask;stderrTask=$errTask})
    }
  }
}
Run $tar @('-xf',$sourceArchive,'-C',(Join-Path $work 'source')) 'extract-node'
if($plan.nasmRequired){Run $tar @('-xf',$nasmArchive,'-C',(Join-Path $work 'tools')) 'extract-nasm'}
$source=Physical (Join-Path $work 'source\node-v24.20.0')
$nasm=$null
if($plan.nasmRequired){
 $nasm=Physical (Join-Path $work 'tools\nasm-2.16.03\nasm.exe')
 if((Hash $nasm) -ne $lock.nasm.executableSha256){throw 'Extracted NASM executable digest mismatch'}
 $environment.PATH=[IO.Path]::GetDirectoryName($nasm)+';'+$environment.PATH
 Run $nasm @('-v') 'nasm-version'
}
Run $python @('-V') 'python-version'
$requirements=$plan.requirements
function SelectNodeVisualStudio([string]$Version) {
  $parsed=$null
  if(-not [Version]::TryParse($Version,[ref]$parsed)){throw 'Invalid Visual Studio version'}
  if($parsed.Major -eq 18){return 'vs2026'}
  if($parsed.Major -eq 17 -and $parsed.Minor -ge 14){return 'vs2022'}
  throw 'Node requires Visual Studio 2022 17.14+ or Visual Studio 2026 18.x'
}
Run $vswhere (@('-latest','-prerelease','-products','*','-version','[17.14,19.0)','-requires')+$requirements+@('-format','json')) 'visual-studio'
$instances=@(Get-Content -LiteralPath (Join-Path $logs 'visual-studio.stdout.txt') -Raw | ConvertFrom-Json)
if($instances.Count -ne 1){throw 'One suitable Visual Studio 2022 or 2026 instance is required'}
$visualStudioTarget=SelectNodeVisualStudio $instances[0].installationVersion
$vs=Physical $instances[0].installationPath
$vcvars=Physical (Join-Path $vs 'VC\Auxiliary\Build\vcvarsall.bat')
if($vcvars -match '[%"!&|<>^]' -or $vcvars -match '[^\x20-\x7e]'){throw 'Unsupported Visual Studio command path'}
# Upstream vcbuild deliberately uses this VS x64 LLVM location for both
# host architectures. Record actual PE machines; do not claim all tools are native ARM64.
$clang=Physical (Join-Path $vs 'VC\Tools\Llvm\x64\bin\clang-cl.exe')
$clangDriver=Physical (Join-Path $vs 'VC\Tools\Llvm\x64\bin\clang.exe')
$environment.PATH=[IO.Path]::GetDirectoryName($clang)+';'+$environment.PATH
Run $clang @('--version') 'clang-cl-version'
Run $git @('-C',$source,'apply','--check','--whitespace=error',$patch) 'patch-check'
if((Hash (Join-Path $source 'deps\uv\src\win\pipe.c')) -ne $lock.patch.originalFileSha256){throw 'Pristine libuv source differs from its pin'}
Run $git @('-C',$source,'apply','--whitespace=error',$patch) 'patch-apply'
if((Hash (Join-Path $source 'deps\uv\src\win\pipe.c')) -ne $lock.patch.patchedFileSha256){throw 'Patched libuv source differs from candidate'}
AssertNodePatchSources $source $lock.nulPatch $false
Run $git @('-C',$source,'apply','--check','--whitespace=error',$nulPatch) 'nul-patch-check'
Run $git @('-C',$source,'apply','--whitespace=error',$nulPatch) 'nul-patch-apply'
AssertNodePatchSources $source $lock.nulPatch $true
$build=Join-Path $work 'build.cmd'
$buildCommand=NodeBuildCommand $plan $visualStudioTarget
# Variables expanded by cmd derive only from validated owned paths or fixed VS
# installation paths. Keep the build command itself fixed and unconfigurable.
$batch=@"
@echo off
setlocal
call "$vcvars" $($plan.vcvars)
if errorlevel 1 exit /b 1
if /i not "%VSCMD_ARG_HOST_ARCH%"=="$($plan.architecture)" exit /b 1
if /i not "%VSCMD_ARG_TGT_ARCH%"=="$($plan.architecture)" exit /b 1
where clang-cl.exe > "$logs\actual-clang-cl.txt"
if errorlevel 1 exit /b 1
where link.exe > "$logs\actual-link.txt"
if errorlevel 1 exit /b 1
where msbuild.exe > "$logs\actual-msbuild.txt"
if errorlevel 1 exit /b 1
where dumpbin.exe > "$logs\actual-dumpbin.txt"
if errorlevel 1 exit /b 1
(set VSCMD_VER&set VSCMD_ARG_HOST_ARCH&set VSCMD_ARG_TGT_ARCH&set WindowsSDKVersion&set VCToolsVersion&set WindowsSdkDir) > "$logs\toolchain-environment.txt"
call $buildCommand
exit /b %errorlevel%
"@
[IO.File]::WriteAllText($build,$batch,[Text.Encoding]::ASCII)
$compilerInputs=@($python,$git,$tar,$vswhere,$clang,$clangDriver);if($plan.nasmRequired){$compilerInputs+=$nasm}
$toolsBefore=@{};$compilerMachines=@{};foreach($tool in $compilerInputs){$toolsBefore[$tool]=Hash $tool;$compilerMachines[$tool]=ReadNodeToolMachine $tool}
Run $cmd @('/d','/v:off','/c',$build) 'node-build' $BuildTimeoutSeconds $source
foreach($tool in $toolsBefore.Keys){if((Hash $tool) -ne $toolsBefore[$tool]){throw 'Compiler input changed during build'}}
$node=Physical (Join-Path $source 'Release\node.exe')
AssertNodePeBytes ([IO.File]::ReadAllBytes($node)) $plan
Run $node @('-p','JSON.stringify({node:process.version,uv:process.versions.uv,arch:process.arch,platform:process.platform})') 'built-node-identity'
$identity=Get-Content -LiteralPath (Join-Path $logs 'built-node-identity.stdout.txt') -Raw | ConvertFrom-Json
AssertNodeIdentity $identity $plan
$stage=Join-Path $work 'stage';[IO.File]::Copy($node,(Join-Path $stage 'node.exe'),$false)
[IO.File]::Copy((Join-Path $source 'LICENSE'),(Join-Path $stage 'LICENSE'),$false)
[IO.File]::Copy((Join-Path $source 'config.gypi'),(Join-Path $stage 'config.gypi'),$false)
$actualTools=@{};foreach($name in @('clang-cl','link','msbuild','dumpbin')){
 $lines=@(Get-Content -LiteralPath (Join-Path $logs ('actual-'+$name+'.txt')) | Where-Object {$_})
 if($lines.Count -lt 1){throw 'Missing actual tool path'};$actual=Physical $lines[0];$actualTools[$name]=@{path=$actual;sha256=(Hash $actual);machine=(ReadNodeToolMachine $actual)}
}
if($actualTools['clang-cl'].path -ine $clang){throw 'Unexpected ClangCL selected'}
Run $actualTools['dumpbin'].path @('/dependents',$node) 'built-node-dependencies'
[IO.File]::Copy((Join-Path $logs 'built-node-dependencies.stdout.txt'),(Join-Path $stage 'dependencies.txt'),$false)
$record=@{schema=1;purpose='candidate Node compiler proof; native AppContainer compatibility not established';lockSha256=(Hash $lockPath);source=$lock.source;patch=$lock.patch;nulPatch=$lock.nulPatch;architecture=$plan.architecture;processArchitecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString();osArchitecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString();nasmRequired=$plan.nasmRequired;nasm=$(if($plan.nasmRequired){$lock.nasm}else{$null});identity=$identity;visualStudio=$instances[0];compilerInputs=$toolsBefore;compilerMachines=$compilerMachines;actualTools=$actualTools;command=$buildCommand;nodeSha256=(Hash (Join-Path $stage 'node.exe'));licenseSha256=(Hash (Join-Path $stage 'LICENSE'));configSha256=(Hash (Join-Path $stage 'config.gypi'))}
[IO.File]::WriteAllText((Join-Path $stage 'provenance.json'),($record | ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))
Write-Host "Node compiler proof staged: $stage"
Write-Host "Native AppContainer pipe/IPC acceptance remains required."
