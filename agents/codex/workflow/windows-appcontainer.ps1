[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NativeSha256,[switch]$Request)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$sid=[IntPtr]::Zero
try {
 if(!$Request-or $NativeSha256-cnotmatch '^[a-f0-9]{64}$'){throw 'WINDOWS_LAUNCH_INVALID'}
 [Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
 $buffer=New-Object char[] 4096;$text=[Text.StringBuilder]::new()
 while($true){$n=[Console]::In.Read($buffer,0,[Math]::Min(4096,131073-$text.Length));if($n-le 0){break};[void]$text.Append($buffer,0,$n);if($text.Length-gt 131072){throw 'WINDOWS_LAUNCH_INVALID'}}
 $inputObject=$text.ToString()|ConvertFrom-Json
 $allowed=@('schemaVersion','profileName','profileSid','executable','executableSha256','arguments','cwd','environment','timeoutMs','outputLimit','cancellationPath')
 $names=@($inputObject.PSObject.Properties.Name)
 if($names.Count-ne $allowed.Count-or @($names|Where-Object{$_-cnotin $allowed}).Count-ne 0-or $inputObject.schemaVersion-ne 1-or $inputObject.profileName-cnotmatch '^Autoprompt_[a-f0-9]{32}$'-or $inputObject.profileSid-cnotmatch '^S-1-15-2-(?:[0-9]+-){6}[0-9]+$'-or $inputObject.arguments-isnot [Array]-or $inputObject.environment-isnot [Array]){throw 'WINDOWS_LAUNCH_INVALID'}
 $native=Join-Path $PSScriptRoot 'windows-appcontainer-native.cs'
 $bytes=[IO.File]::ReadAllBytes($native);$hash=[Security.Cryptography.SHA256]::Create()
 try{$actual=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 if($actual-cne $NativeSha256){throw 'WINDOWS_RUNTIME_MISMATCH'}
 Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString($bytes)) -Language CSharp
 if([WindowsAppContainerNative]::DeriveAppContainerSidFromAppContainerName([string]$inputObject.profileName,[ref]$sid)-ne 0-or $sid-eq [IntPtr]::Zero){throw 'WINDOWS_PROFILE_UNAVAILABLE'}
 $result=[WindowsAppContainerNative]::Launch([string]$inputObject.executable,[string]$inputObject.executableSha256,[string[]]$inputObject.arguments,[string]$inputObject.cwd,[string[]]$inputObject.environment,[int]$inputObject.timeoutMs,[int]$inputObject.outputLimit,$sid,[string]$inputObject.profileSid,[string]$inputObject.cancellationPath)
 [ordered]@{schemaVersion=1;status='COMPLETED';result=$result}|ConvertTo-Json -Depth 4 -Compress
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
 [ordered]@{schemaVersion=1;status='REFUSED';code=$code;diagnostic=$diagnostic}|ConvertTo-Json -Compress
} finally {if($sid-ne [IntPtr]::Zero){[void][WindowsAppContainerNative]::FreeSid($sid)}}
