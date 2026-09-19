param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { throw 'inbox-windows-powershell-required' }
if ([IO.Directory]::Exists($OutputDirectory)) { throw 'new-output-directory-required' }
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$out=[IO.Path]::GetFullPath($OutputDirectory)
$exe=[IO.Path]::Combine($out,'bundle-lease.exe')
$files=@('../physical-proof/audit.cs','lease-main.cs','build.ps1') | ForEach-Object { [ordered]@{path=$_;sha256=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $_)).Hash.ToLowerInvariant()} }
# Build time only. Runtime launches the fixed hashed executable directly.
$compiler=[CodeDom.Compiler.CompilerParameters]::new()
$compiler.CompilerOptions='/optimize+ /platform:anycpu'
$compiler.GenerateExecutable=$true
$compiler.GenerateInMemory=$false
$compiler.OutputAssembly=$exe
$compiler.MainClass='BundleLeaseMain'
$compiler.TreatWarningsAsErrors=$true
$compiler.WarningLevel=4
[void]$compiler.ReferencedAssemblies.Add('System.dll')
[void]$compiler.ReferencedAssemblies.Add('System.Core.dll')
# PS5.1 rejects combining Add-Type CompilerParameters with OutputAssembly at
# runtime, despite advertising both in its parameter-set syntax. Use CodeDOM
# directly so one explicit CompilerParameters object controls the build.
$providerOptions=[Collections.Generic.Dictionary[string,string]]::new()
$providerOptions.Add('CompilerVersion','v4.0')
$provider=[Microsoft.CSharp.CSharpCodeProvider]::new($providerOptions)
try {
  $result=$provider.CompileAssemblyFromFile($compiler,[string[]]@(
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../physical-proof/audit.cs')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'lease-main.cs'))))
  if ($result.NativeCompilerReturnValue -ne 0 -or $result.Errors.HasErrors -or $result.Errors.HasWarnings) {
    # Compiler text is evidence only, bounded independently of the compiler's
    # diagnostic count; don't emit arbitrary command-line/source dumps.
    $details=@($result.Errors | Select-Object -First 16 | ForEach-Object {
      $message=[string]$_.ErrorText
      if ($message.Length -gt 512) { $message=$message.Substring(0,512) }
      '{0}:{1}:{2}' -f $_.ErrorNumber,$_.Line,$message
    }) -join "`n"
    throw ('helper-compile-refused:{0}: {1}' -f $result.NativeCompilerReturnValue,$details)
  }
  if (-not [IO.File]::Exists($exe) -or [IO.Path]::GetFullPath($result.PathToAssembly) -ine $exe) { throw 'compiled-helper-path-required' }
  $executableLength=([IO.FileInfo]$exe).Length
  if ($executableLength -lt 1 -or $executableLength -gt 1048576) { throw 'compiled-helper-size-bound' }
} finally { $provider.Dispose() }
$config='<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>'
[IO.File]::WriteAllText(($exe+'.config'),$config,[Text.UTF8Encoding]::new($false))
$identity=& $exe --identity
if($LASTEXITCODE -ne 0 -or $identity -notin @('bundle-lease-helper-v1:x64','bundle-lease-helper-v1:arm64')) { throw 'native-helper-identity-required' }
foreach($file in $files) { if ((Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $file.path)).Hash.ToLowerInvariant() -cne $file.sha256) { throw 'source-changed-during-build' } }
$record=[ordered]@{schema=1;status='compiled-native-identity-only';identity=$identity;source=$files;files=@('bundle-lease.exe','bundle-lease.exe.config') | ForEach-Object { [ordered]@{path=$_;length=([IO.FileInfo](Join-Path $out $_)).Length;sha256=(Get-FileHash -Algorithm SHA256 (Join-Path $out $_)).Hash.ToLowerInvariant()} }}
[IO.File]::WriteAllText((Join-Path $out 'build.json'),(($record | ConvertTo-Json -Depth 8 -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
