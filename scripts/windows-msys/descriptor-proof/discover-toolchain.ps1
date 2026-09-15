# Native test build discovery only; never installs tools or changes machine/user environment.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$WorkRoot)
[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Native Windows PowerShell 7+ is required' }
if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -ne 'X64') { throw 'Native x64 toolchain discovery is required' }
function Physical([string]$Path,[bool]$Directory=$false) {
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw 'Absolute toolchain path required' }
  $full=[IO.Path]::GetFullPath($Path)
  for($cursor=$full;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
    $attributes=[IO.File]::GetAttributes($cursor)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked toolchain path refused' }
    if (($Directory -or $cursor -ne $full) -and ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Toolchain ancestor must be a directory' }
  }
  if (-not $Directory -and -not [IO.File]::Exists($full)) { throw 'Regular toolchain file required' }
  return $full
}
$work=[IO.Path]::GetFullPath($WorkRoot)
if ($work -cnotmatch '^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$' -or $work.Contains('..') -or (Test-Path -LiteralPath $work)) { throw 'Fresh absolute ASCII WorkRoot without spaces or command metacharacters required' }
[void](Physical ([IO.Path]::GetDirectoryName($work)) $true)
[void][IO.Directory]::CreateDirectory($work)
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($user.Value,'S-1-5-18') | Select-Object -Unique) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
}
[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($work),$acl)
$system=Physical $env:SystemRoot $true
$cmd=Physical (Join-Path $system 'System32\cmd.exe')
$vswhere=Physical (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe')
$environment=@{
 SystemRoot=$system;WINDIR=$system;SystemDrive=[IO.Path]::GetPathRoot($system).TrimEnd('\');ComSpec=$cmd
 PATH=(Join-Path $system 'System32')+';'+$system;PATHEXT='.COM;.EXE;.BAT;.CMD';TEMP=$work;TMP=$work
 PROCESSOR_ARCHITECTURE='AMD64';NUMBER_OF_PROCESSORS='2'
 ProgramFiles=$env:ProgramFiles;'ProgramFiles(x86)'=${env:ProgramFiles(x86)};ProgramW6432=$env:ProgramW6432
 USERPROFILE=[Environment]::GetFolderPath('UserProfile');LOCALAPPDATA=[Environment]::GetFolderPath('LocalApplicationData');APPDATA=[Environment]::GetFolderPath('ApplicationData');ProgramData=[Environment]::GetFolderPath('CommonApplicationData')
}
$script:RetainedStreams=[Collections.Generic.List[object]]::new()
function Run([string]$Executable,[string[]]$Arguments,[string]$Name) {
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Executable;$info.WorkingDirectory=$work;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.Environment.Clear();foreach($key in $environment.Keys){$info.Environment[$key]=[string]$environment[$key]}
  foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
  $stdout=[IO.File]::Open((Join-Path $work ($Name+'.stdout.txt')),[IO.FileMode]::CreateNew)
  $stderr=[IO.File]::Open((Join-Path $work ($Name+'.stderr.txt')),[IO.FileMode]::CreateNew)
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$outTask=$null;$errTask=$null;$reason=$null;$started=$false
  try {
    $started=$process.Start();if(-not $started){throw 'Discovery process did not start'};$process.StandardInput.Close()
    $outTask=$process.StandardOutput.BaseStream.CopyToAsync($stdout);$errTask=$process.StandardError.BaseStream.CopyToAsync($stderr)
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while(-not $process.WaitForExit(50)) {
      if($clock.ElapsedMilliseconds -ge 60000){$reason='Discovery exceeded 60 seconds';break}
      if($stdout.Length -gt 1048576 -or $stderr.Length -gt 1048576){$reason='Discovery output exceeded 1 MiB';break}
      $vcLog=Join-Path $work 'vcvars.log'
      if([IO.File]::Exists($vcLog) -and ([IO.FileInfo]::new($vcLog)).Length -gt 1048576){$reason='Toolchain setup log exceeded 1 MiB';break}
    }
    if($reason){try{$process.Kill($true)}catch{};[void]$process.WaitForExit(5000)}
    $copies=[Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($outTask,$errTask))
    if(-not $copies.Wait(5000)){throw 'Discovery stream drain unconfirmed; work retained'}
    if($reason){throw ($reason+'; process-tree termination requested, descendant state unconfirmed; work retained')}
    if($stdout.Length -gt 1048576 -or $stderr.Length -gt 1048576){throw 'Discovery output exceeded 1 MiB'}
    $vcLog=Join-Path $work 'vcvars.log'
    if([IO.File]::Exists($vcLog) -and ([IO.FileInfo]::new($vcLog)).Length -gt 1048576){throw 'Toolchain setup log exceeded 1 MiB'}
    if($process.ExitCode -ne 0){throw ('Discovery failed: '+$Name+'; see owned logs')}
  } catch {
    if($started){try{if(-not $process.HasExited){$process.Kill($true);[void]$process.WaitForExit(5000)}}catch{}}
    throw
  } finally {
    if(($null -eq $outTask -or $outTask.IsCompleted) -and ($null -eq $errTask -or $errTask.IsCompleted)){$stdout.Dispose();$stderr.Dispose();$process.Dispose()}
    else{$script:RetainedStreams.Add(@{process=$process;stdout=$stdout;stderr=$stderr;stdoutTask=$outTask;stderrTask=$errTask})}
  }
}
Run $vswhere @('-latest','-products','*','-version','[17.14,19.0)','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-format','json','-utf8') 'vswhere'
$instances=@([IO.File]::ReadAllText((Join-Path $work 'vswhere.stdout.txt'),[Text.Encoding]::UTF8) | ConvertFrom-Json)
if($instances.Count -ne 1){throw 'Exactly one selected VS2022 17.14+ or VS2026 18.x instance is required'}
$visualStudioVersion=[version]$instances[0].installationVersion
if($visualStudioVersion -lt [version]'17.14' -or $visualStudioVersion -ge [version]'19.0'){throw 'Unsupported Visual Studio installation version'}
$vs=Physical $instances[0].installationPath $true
$vcvars=Physical (Join-Path $vs 'VC\Auxiliary\Build\vcvarsall.bat')
if($vcvars -match '[%"!&|<>^]' -or $vcvars -match '[^\x20-\x7e]'){throw 'Unsupported Visual Studio command path'}
$batch=Join-Path $work 'discover.cmd'
# Only the fixed discovered VS path enters batch text; work has no metacharacters.
# SET prints values without expanding them into executable command text.
$text="@echo off`r`nsetlocal DisableDelayedExpansion`r`nchcp 65001 >nul`r`ncall `"$vcvars`" amd64 > `"$work\vcvars.log`" 2>&1`r`nif errorlevel 1 exit /b 1`r`nset`r`n"
[IO.File]::WriteAllText($batch,$text,[Text.ASCIIEncoding]::new())
Run $cmd @('/d','/s','/c',$batch) 'environment'
$values=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($line in [IO.File]::ReadAllLines((Join-Path $work 'environment.stdout.txt'),[Text.UTF8Encoding]::new($false,$true))) {
  if($line -match '^=[A-Za-z]:='){continue}
  $separator=$line.IndexOf('=');if($separator -lt 1){throw 'Unexpected compiler environment output'}
  $key=$line.Substring(0,$separator);if($values.ContainsKey($key)){throw 'Duplicate compiler environment key'}
  $values.Add($key,$line.Substring($separator+1))
}
foreach($key in @('VCToolsInstallDir','WindowsSDKVersion','INCLUDE','LIB')){if(-not $values.ContainsKey($key) -or -not $values[$key]){throw ('Missing compiler environment: '+$key)}}
$tools=Physical $values['VCToolsInstallDir'] $true
if(-not $tools.StartsWith($vs.TrimEnd('\')+'\VC\Tools\MSVC\',[StringComparison]::OrdinalIgnoreCase)){throw 'Compiler is outside selected VS installation'}
$cl=Physical (Join-Path $tools 'bin\Hostx64\x64\cl.exe')
$link=Physical (Join-Path $tools 'bin\Hostx64\x64\link.exe')
function Directories([string]$List) {
  $result=[Collections.Generic.List[string]]::new()
  foreach($directory in $List.Split(';')){if($directory){$result.Add((Physical $directory $true))}}
  if($result.Count -lt 1 -or $result.Count -gt 16){throw 'Compiler include/library directory count refused'}
  return ,$result.ToArray()
}
$includes=Directories $values['INCLUDE'];$libraries=Directories $values['LIB']
$sdk=$values['WindowsSDKVersion'].TrimEnd('\');if($sdk -cnotmatch '^10\.0\.[0-9]+\.0$'){throw 'Unexpected Windows SDK version'}
$toolchain=[ordered]@{cl=$cl;link=$link;include=$includes;lib=$libraries;sdkVersion=$sdk;arch='x64'}
$destination=Join-Path $work 'toolchain.json'
[IO.File]::WriteAllText($destination,($toolchain | ConvertTo-Json -Depth 4)+"`n",[Text.UTF8Encoding]::new($false))
Write-Output $destination
