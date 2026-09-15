# Diagnostic compiler only; never installs or selects a worker runtime.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$WorkRoot,[string]$InputCache,[ValidateRange(60,5400)][int]$BuildTimeoutSeconds=3600)
[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Windows PowerShell Core 7+ is required for bounded process-tree cleanup' }
if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -ne 'X64') { throw 'This first compiler proof requires native x64 Windows' }
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
  if($InputCache) { $cached=Physical (Join-Path $InputCache $Name); if((Hash $cached) -ne $Digest){throw "Input cache digest mismatch: $Name"};[IO.File]::Copy($cached,$destination,$false) }
  else { Invoke-WebRequest -Uri $Url -OutFile $destination -TimeoutSec 120 }
  if((Hash $destination) -ne $Digest){throw "Downloaded input digest mismatch: $Name"}
  return $destination
}
$sourceArchive=Fetch $lock.source.file $lock.source.url $lock.source.sha256
$nasmArchive=Fetch $lock.nasm.file $lock.nasm.url $lock.nasm.sha256
$patch=Physical (Join-Path $PSScriptRoot $lock.patch.file)
if((Hash $patch) -ne $lock.patch.sha256){throw 'Patch digest differs from reviewed lock'}
[IO.File]::Copy($patch,(Join-Path $work 'inputs\libuv-appcontainer-pipes.patch'),$false)
[IO.File]::Copy($lockPath,(Join-Path $work 'inputs\build-lock.json'),$false)
$system=Physical $env:SystemRoot
$tar=Physical (Join-Path $system 'System32\tar.exe')
$cmd=Physical (Join-Path $system 'System32\cmd.exe')
$python=Physical (Get-Command python.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$git=Physical (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$vswhere=Physical (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe')
# Build tools run on the host, with only explicitly selected compiler inputs.
# No ambient compiler/linker flags or project credentials enter the child.
$environment=@{
 SystemRoot=$system;WINDIR=$system;SystemDrive=[IO.Path]::GetPathRoot($system).TrimEnd('\');ComSpec=$cmd
 PATH=([IO.Path]::GetDirectoryName($python)+';'+[IO.Path]::GetDirectoryName($git)+';'+[IO.Path]::GetDirectoryName($vswhere)+';'+(Join-Path $system 'System32')+';'+$system)
 PATHEXT='.COM;.EXE;.BAT;.CMD';TEMP=(Join-Path $work 'temp');TMP=(Join-Path $work 'temp')
 NUMBER_OF_PROCESSORS='4';PROCESSOR_ARCHITECTURE='AMD64'
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
  try {
    if(-not $process.Start()){throw "Failed to start $Name"};$process.StandardInput.Close()
    $outTask=$process.StandardOutput.BaseStream.CopyToAsync($out);$errTask=$process.StandardError.BaseStream.CopyToAsync($err)
    if(-not $process.WaitForExit($Timeout*1000)) {
      $timedOut=$true
      try { $process.Kill($true) } catch { Write-Warning "Could not request complete compiler tree termination: $Name" }
      # Waiting for the root does not prove every descendant terminated.
      # No output tree is deleted, reused or declared safe on this path.
      [void]$process.WaitForExit(10000)
    }
    $copies=[Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($outTask,$errTask))
    if(-not $copies.Wait(10000)){throw "Compiler output drain unconfirmed; owned work tree retained: $Name"}
    if($timedOut){throw "Compiler timed out; tree termination requested, descendant state unconfirmed; owned work tree retained: $Name"}
    if($process.ExitCode -ne 0){throw "Compiler operation failed: $Name, exit $($process.ExitCode); see $logs"}
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
Run $tar @('-xf',$nasmArchive,'-C',(Join-Path $work 'tools')) 'extract-nasm'
$source=Physical (Join-Path $work 'source\node-v24.20.0')
$nasm=Physical (Join-Path $work 'tools\nasm-2.16.03\nasm.exe')
if((Hash $nasm) -ne $lock.nasm.executableSha256){throw 'Extracted NASM executable digest mismatch'}
$environment.PATH=[IO.Path]::GetDirectoryName($nasm)+';'+$environment.PATH
Run $nasm @('-v') 'nasm-version'
Run $python @('-V') 'python-version'
$requirements=@('Microsoft.VisualStudio.Component.VC.Tools.x86.x64','Microsoft.VisualStudio.Component.VC.Llvm.Clang','Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset')
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
$clang=Physical (Join-Path $vs 'VC\Tools\Llvm\x64\bin\clang-cl.exe')
$clangDriver=Physical (Join-Path $vs 'VC\Tools\Llvm\x64\bin\clang.exe')
$environment.PATH=[IO.Path]::GetDirectoryName($clang)+';'+$environment.PATH
Run $clang @('--version') 'clang-cl-version'
Run $git @('-C',$source,'apply','--check','--whitespace=error',$patch) 'patch-check'
if((Hash (Join-Path $source 'deps\uv\src\win\pipe.c')) -ne $lock.patch.originalFileSha256){throw 'Pristine libuv source differs from its pin'}
Run $git @('-C',$source,'apply','--whitespace=error',$patch) 'patch-apply'
if((Hash (Join-Path $source 'deps\uv\src\win\pipe.c')) -ne $lock.patch.patchedFileSha256){throw 'Patched libuv source differs from candidate'}
$build=Join-Path $work 'build.cmd'
# Variables expanded by cmd derive only from validated owned paths or fixed VS
# installation paths. Keep the build command itself fixed and unconfigurable.
$batch=@"
@echo off
setlocal
call "$vcvars" amd64
if errorlevel 1 exit /b 1
where clang-cl.exe > "$logs\actual-clang-cl.txt"
if errorlevel 1 exit /b 1
where link.exe > "$logs\actual-link.txt"
if errorlevel 1 exit /b 1
where msbuild.exe > "$logs\actual-msbuild.txt"
if errorlevel 1 exit /b 1
where dumpbin.exe > "$logs\actual-dumpbin.txt"
if errorlevel 1 exit /b 1
(set VSCMD_VER&set WindowsSDKVersion&set VCToolsVersion&set WindowsSdkDir) > "$logs\toolchain-environment.txt"
call vcbuild.bat x64 $visualStudioTarget clang-cl nonpm nocorepack no-cctest
exit /b %errorlevel%
"@
[IO.File]::WriteAllText($build,$batch,[Text.Encoding]::ASCII)
$toolsBefore=@{};foreach($tool in @($python,$git,$tar,$vswhere,$clang,$clangDriver,$nasm)){$toolsBefore[$tool]=Hash $tool}
Run $cmd @('/d','/v:off','/c',$build) 'node-build' $BuildTimeoutSeconds $source
foreach($tool in $toolsBefore.Keys){if((Hash $tool) -ne $toolsBefore[$tool]){throw 'Compiler input changed during build'}}
$node=Physical (Join-Path $source 'Release\node.exe')
Run $node @('-p','JSON.stringify({node:process.version,uv:process.versions.uv,arch:process.arch,platform:process.platform})') 'built-node-identity'
$identity=Get-Content -LiteralPath (Join-Path $logs 'built-node-identity.stdout.txt') -Raw | ConvertFrom-Json
if($identity.node -ne 'v24.20.0' -or $identity.arch -ne 'x64' -or $identity.platform -ne 'win32'){throw 'Built Node identity mismatch'}
$stage=Join-Path $work 'stage';[IO.File]::Copy($node,(Join-Path $stage 'node.exe'),$false)
[IO.File]::Copy((Join-Path $source 'LICENSE'),(Join-Path $stage 'LICENSE'),$false)
[IO.File]::Copy((Join-Path $source 'config.gypi'),(Join-Path $stage 'config.gypi'),$false)
$actualTools=@{};foreach($name in @('clang-cl','link','msbuild','dumpbin')){
 $lines=@(Get-Content -LiteralPath (Join-Path $logs ('actual-'+$name+'.txt')) | Where-Object {$_})
 if($lines.Count -lt 1){throw 'Missing actual tool path'};$actual=Physical $lines[0];$actualTools[$name]=@{path=$actual;sha256=(Hash $actual)}
}
if($actualTools['clang-cl'].path -ine $clang){throw 'Unexpected ClangCL selected'}
Run $actualTools['dumpbin'].path @('/dependents',$node) 'built-node-dependencies'
[IO.File]::Copy((Join-Path $logs 'built-node-dependencies.stdout.txt'),(Join-Path $stage 'dependencies.txt'),$false)
$record=@{schema=1;purpose='candidate Node compiler proof; native AppContainer compatibility not established';lockSha256=(Hash $lockPath);source=$lock.source;patch=$lock.patch;nasm=$lock.nasm;identity=$identity;visualStudio=$instances[0];compilerInputs=$toolsBefore;actualTools=$actualTools;command="vcbuild.bat x64 $visualStudioTarget clang-cl nonpm nocorepack no-cctest";nodeSha256=(Hash (Join-Path $stage 'node.exe'));licenseSha256=(Hash (Join-Path $stage 'LICENSE'));configSha256=(Hash (Join-Path $stage 'config.gypi'))}
[IO.File]::WriteAllText((Join-Path $stage 'provenance.json'),($record | ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))
Write-Host "Node compiler proof staged: $stage"
Write-Host "Native AppContainer pipe/IPC acceptance remains required."
