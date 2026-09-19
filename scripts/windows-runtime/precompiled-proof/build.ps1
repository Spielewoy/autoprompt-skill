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
[void]$compiler.ReferencedAssemblies.Add('System.dll')
[void]$compiler.ReferencedAssemblies.Add('System.Core.dll')
Add-Type -Path @((Join-Path $PSScriptRoot '../physical-proof/audit.cs'),(Join-Path $PSScriptRoot 'lease-main.cs')) -OutputAssembly $exe -OutputType ConsoleApplication -CompilerParameters $compiler
$config='<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>'
[IO.File]::WriteAllText(($exe+'.config'),$config,[Text.UTF8Encoding]::new($false))
$identity=& $exe --identity
if($LASTEXITCODE -ne 0 -or $identity -notin @('bundle-lease-helper-v1:x64','bundle-lease-helper-v1:arm64')) { throw 'native-helper-identity-required' }
foreach($file in $files) { if ((Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $file.path)).Hash.ToLowerInvariant() -cne $file.sha256) { throw 'source-changed-during-build' } }
$record=[ordered]@{schema=1;status='compiled-native-identity-only';identity=$identity;source=$files;files=@('bundle-lease.exe','bundle-lease.exe.config') | ForEach-Object { [ordered]@{path=$_;length=([IO.FileInfo](Join-Path $out $_)).Length;sha256=(Get-FileHash -Algorithm SHA256 (Join-Path $out $_)).Hash.ToLowerInvariant()} }}
[IO.File]::WriteAllText((Join-Path $out 'build.json'),(($record | ConvertTo-Json -Depth 8 -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
