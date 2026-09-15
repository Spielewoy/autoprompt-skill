[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NativeSha256,[switch]$Request)
# Pin inbox modules after PowerShell's startup environment reconstruction.
[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
 if(!$Request-or $NativeSha256-cnotmatch '^[a-f0-9]{64}$'){throw 'WINDOWS_RESOURCE_INVALID'}
 [Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
 $buffer=New-Object char[] 4096;$text=[Text.StringBuilder]::new()
 while($true){$n=[Console]::In.Read($buffer,0,[Math]::Min(4096,12582913-$text.Length));if($n-le 0){break};[void]$text.Append($buffer,0,$n);if($text.Length-gt 12582912){throw 'WINDOWS_RESOURCE_LIMIT'}}
 $inputObject=$text.ToString()|ConvertFrom-Json
 $allowed=if($inputObject.operation-ceq 'plan'){@('schemaVersion','operation','profileName','roots')}else{@('schemaVersion','operation','plan')}
 $names=@($inputObject.PSObject.Properties.Name)
 if($names.Count-ne $allowed.Count-or @($names|Where-Object{$_-cnotin $allowed}).Count-ne 0-or $inputObject.schemaVersion-ne 1-or $inputObject.operation-cnotin @('plan','apply','restore')){throw 'WINDOWS_RESOURCE_INVALID'}
 $native=Join-Path $PSScriptRoot 'windows-appcontainer-resources-native.cs'
 $bytes=[IO.File]::ReadAllBytes($native);$hash=[Security.Cryptography.SHA256]::Create()
 try{$actual=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 if($actual-cne $NativeSha256){throw 'WINDOWS_RUNTIME_MISMATCH'}
 Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString($bytes)) -Language CSharp -ReferencedAssemblies @('System.dll','System.Core.dll','System.Security.dll','System.Web.Extensions.dll')
 if($inputObject.operation-ceq 'plan'){
  if($inputObject.profileName-isnot [string]-or $inputObject.roots-isnot [Array]-or $inputObject.roots.Count-lt 1-or $inputObject.roots.Count-gt 64){throw 'WINDOWS_RESOURCE_INVALID'}
  $specs=@($inputObject.roots|ForEach-Object{
   if(@($_.PSObject.Properties.Name).Count-ne 3-or $_.path-isnot [string]-or $_.kind-cnotin @('file','directory')-or $_.writable-isnot [bool]){throw 'WINDOWS_RESOURCE_INVALID'}
   $spec=New-Object WindowsAppContainerResourcesNative+RootSpec;$spec.path=$_.path;$spec.kind=$_.kind;$spec.writable=$_.writable;$spec
  })
  $plan=[WindowsAppContainerResourcesNative]::Plan([string]$inputObject.profileName,[WindowsAppContainerResourcesNative+RootSpec[]]$specs)
  [ordered]@{schemaVersion=1;status='PLANNED';plan=$plan}|ConvertTo-Json -Depth 12 -Compress
 }else{
  $plan=[WindowsAppContainerResourcesNative]::ReadPlan(($inputObject.plan|ConvertTo-Json -Depth 12 -Compress))
  if($inputObject.operation-ceq 'apply'){$result=[WindowsAppContainerResourcesNative]::Apply($plan);$status='PREPARED'}else{$result=[WindowsAppContainerResourcesNative]::Restore($plan);$status='RESTORED'}
  [ordered]@{schemaVersion=1;status=$status;result=$result}|ConvertTo-Json -Depth 12 -Compress
 }
}catch{
 $code='WINDOWS_RESOURCE_REFUSED';$exception=$_.Exception;$diagnostic='unknown'
 for($i=0;$i-lt 8-and $null-ne $exception;$i++){
  if($exception.Message-cmatch '^(?:WINDOWS|FILESYSTEM|PREIMAGE)_[A-Z_]{1,80}$'){$code=$exception.Message}
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
}
