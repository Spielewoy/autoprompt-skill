[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NativeSha256,[switch]$Request,[string]$RequestPath,[string]$RequestSha256)
# Pin inbox modules after PowerShell's startup environment reconstruction.
[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$sid=[IntPtr]::Zero
$streaming=$false
try {
 $fileRequest=-not [string]::IsNullOrEmpty($RequestPath)
 if(($Request -and $fileRequest)-or (!$Request -and !$fileRequest)-or $NativeSha256-cnotmatch '^[a-f0-9]{64}$'){throw 'WINDOWS_LAUNCH_INVALID'}
 [Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
 if(![string]::IsNullOrEmpty($RequestPath)){
  if($RequestPath.IndexOf([char]0)-ge 0-or ![IO.Path]::IsPathRooted($RequestPath)-or $RequestSha256-cnotmatch '^[a-f0-9]{64}$'){throw 'WINDOWS_LAUNCH_INVALID'}
  $expectedRequest=[IO.Path]::Combine([IO.Path]::GetFullPath($env:TEMP),'request.json')
  if(![string]::Equals([IO.Path]::GetFullPath($RequestPath),$expectedRequest,[StringComparison]::OrdinalIgnoreCase)){throw 'WINDOWS_LAUNCH_INVALID'}
  $parent=[IO.Path]::GetDirectoryName($RequestPath)
  while($parent){$item=Get-Item -LiteralPath $parent -Force;if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'WINDOWS_LAUNCH_INVALID'};$next=[IO.Path]::GetDirectoryName($parent);if($next-eq $parent){break};$parent=$next}
  $requestItem=Get-Item -LiteralPath $RequestPath -Force
  if($requestItem.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)-or $requestItem.PSIsContainer-or $requestItem.Length-gt 131072){throw 'WINDOWS_LAUNCH_INVALID'}
  $requestBytes=[IO.File]::ReadAllBytes($RequestPath);if($requestBytes.Length -gt 131072){throw 'WINDOWS_LAUNCH_INVALID'}
  $hash=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($hash.ComputeHash($requestBytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
  if($actual-cne $RequestSha256){throw 'WINDOWS_RUNTIME_MISMATCH'}
  $inputObject=([Text.UTF8Encoding]::new($false,$true).GetString($requestBytes))|ConvertFrom-Json
 } else {
  $buffer=New-Object char[] 4096;$text=[Text.StringBuilder]::new()
  while($true){$n=[Console]::In.Read($buffer,0,[Math]::Min(4096,131073-$text.Length));if($n-le 0){break};[void]$text.Append($buffer,0,$n);if($text.Length-gt 131072){throw 'WINDOWS_LAUNCH_INVALID'}}
  $inputObject=$text.ToString()|ConvertFrom-Json
 }
 $allowed=@('schemaVersion','profileName','profileSid','executable','executableSha256','arguments','cwd','environment','timeoutMs','outputLimit','cancellationPath')
 $names=@($inputObject.PSObject.Properties.Name)
 $hasMsys=$names-ccontains 'msysRuntime';$hasRelay=$names-ccontains 'relayStdin';$hasStream=$names-ccontains 'streamOutput'
 if($hasMsys){$allowed+=@('msysRuntime')}
 if($hasRelay){$allowed+=@('relayStdin')}
 if($hasStream){$allowed+=@('streamOutput')}
 if($names.Count-ne $allowed.Count-or @($names|Where-Object{$_-cnotin $allowed}).Count-ne 0-or $inputObject.schemaVersion-ne 1-or $inputObject.profileName-cnotmatch '^Autoprompt_[a-f0-9]{32}$'-or $inputObject.profileSid-cnotmatch '^S-1-15-2-(?:[0-9]+-){6}[0-9]+$'-or $inputObject.arguments-isnot [Array]-or $inputObject.environment-isnot [Array]){throw 'WINDOWS_LAUNCH_INVALID'}
 if($hasMsys){
  $msys=$inputObject.msysRuntime
  if($null-eq $msys-or $msys-isnot [PSCustomObject]){throw 'WINDOWS_MSYS_NAMESPACE_INVALID'}
  $msysNames=@($msys.PSObject.Properties.Name)
  if($msysNames.Count-ne 3-or @($msysNames|Where-Object{$_-cnotin @('dllPath','dllSha256','sharedId')}).Count-ne 0-or $msys.dllPath-isnot [string]-or $msys.dllSha256-isnot [string]-or $msys.sharedId-isnot [string]-or $msys.dllSha256-cnotmatch '^[a-f0-9]{64}$'-or $msys.sharedId-cnotmatch '^msys-2\.0S[1-9][0-9]{0,8}$'){throw 'WINDOWS_MSYS_NAMESPACE_INVALID'}
 }
 if($hasRelay-ne $fileRequest-or ($hasRelay -and ($inputObject.relayStdin-isnot [bool]-or $inputObject.relayStdin-ne $true))){throw 'WINDOWS_LAUNCH_INVALID'}
 if($hasStream -and ($inputObject.streamOutput-isnot [bool]-or $inputObject.streamOutput-ne $true)){throw 'WINDOWS_LAUNCH_INVALID'}
 $streaming=$hasStream
 $native=Join-Path $PSScriptRoot 'windows-appcontainer-native.cs'
 $bytes=[IO.File]::ReadAllBytes($native);$hash=[Security.Cryptography.SHA256]::Create()
 try{$actual=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 if($actual-cne $NativeSha256){throw 'WINDOWS_RUNTIME_MISMATCH'}
 Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString($bytes)) -Language CSharp
 if([WindowsAppContainerNative]::DeriveAppContainerSidFromAppContainerName([string]$inputObject.profileName,[ref]$sid)-ne 0-or $sid-eq [IntPtr]::Zero){throw 'WINDOWS_PROFILE_UNAVAILABLE'}
 $msysRequest=$null
 if($hasMsys){$msysRequest=[WindowsAppContainerNative+MsysNamespaceRequest]::new();$msysRequest.DllPath=$msys.dllPath;$msysRequest.DllSha256=$msys.dllSha256;$msysRequest.SharedId=$msys.sharedId}
 $callback=$null;$sequence=0
 if($streaming){
  $callback=[Action[string,byte[]]]{param($stream,$data)$script:sequence++;$frame=[ordered]@{schemaVersion=2;status='STREAM';stream=$stream;sequence=$script:sequence;dataBase64=[Convert]::ToBase64String($data)};[Console]::Out.WriteLine(($frame|ConvertTo-Json -Compress));[Console]::Out.Flush()}
 }
 $result=[WindowsAppContainerNative]::Launch([string]$inputObject.executable,[string]$inputObject.executableSha256,[string[]]$inputObject.arguments,[string]$inputObject.cwd,[string[]]$inputObject.environment,[int]$inputObject.timeoutMs,[int]$inputObject.outputLimit,$sid,[string]$inputObject.profileSid,[string]$inputObject.cancellationPath,$msysRequest,$hasRelay,$callback)
 if($streaming){[ordered]@{schemaVersion=2;status='COMPLETED';result=$result}|ConvertTo-Json -Depth 4 -Compress}
 else {
  $legacy=[ordered]@{RootPid=$result.RootPid;ExitCode=$result.ExitCode;ObservedJobMembers=$result.ObservedJobMembers;LauncherSessionId=$result.LauncherSessionId;AppContainerSid=$result.AppContainerSid;StdoutBase64=$result.StdoutBase64;StderrBase64=$result.StderrBase64;RootImageMatches=$result.RootImageMatches;Drained=$result.Drained;TimedOut=$result.TimedOut;OutputLimit=$result.OutputLimit;Cancelled=$result.Cancelled}
  [ordered]@{schemaVersion=1;status='COMPLETED';result=$legacy}|ConvertTo-Json -Depth 4 -Compress
 }
} catch {
 $code='WINDOWS_LAUNCH_REFUSED';$exception=$_.Exception;$diagnostic='unknown'
 for($i=0;$i-lt 8-and $null-ne $exception;$i++){
  if($exception.Message-eq 'APPCONTAINER_CLEANUP_UNCONFIRMED'){$code='APPCONTAINER_CLEANUP_UNCONFIRMED';break}
  if($exception.Message-cmatch '^WINDOWS_[A-Z_]{1,64}$'){$code=$exception.Message}
  $kind=$exception.GetType().Name;$site='unknown'
  if($null-ne $exception.TargetSite){$site=$exception.TargetSite.Name}
  if($kind-cmatch '^[A-Za-z0-9_]{1,80}$'-and $site-cmatch '^[A-Za-z0-9_]{1,80}$'){
   $diagnostic=$kind+':'+$site
   if($exception-is [ComponentModel.Win32Exception]){$diagnostic+=':'+([string]$exception.NativeErrorCode)}
   if($exception.Message-cmatch '^[A-Za-z0-9_ .:()-]{1,80}$'){$diagnostic+=':'+ $exception.Message}
  }
  $exception=$exception.InnerException
 }
 $schema=1;if($streaming){$schema=2}
 [ordered]@{schemaVersion=$schema;status='REFUSED';code=$code;diagnostic=$diagnostic}|ConvertTo-Json -Compress
} finally {if($sid-ne [IntPtr]::Zero){[void][WindowsAppContainerNative]::FreeSid($sid)}}
