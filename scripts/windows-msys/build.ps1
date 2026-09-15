# Windows x64 research bootstrap; native compilation remains unverified.
# Downloads the large pinned SDK only when explicitly invoked.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$WorkRoot,
  [ValidateSet('proof','full')][string]$Mode='proof',
  [string]$LockPath=(Join-Path $PSScriptRoot 'build-lock.json'),
  [string]$ShellPath=(Join-Path $PSScriptRoot 'build.sh'),
  [string]$AdaptationPatch,
  [string]$AdaptationSha256,
  [ValidateRange(1,16)][int]$Jobs=2
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Write-Utf8Lf([string]$Destination,[string]$Content) {
  $normalized=$Content.Replace("`r`n","`n")
  if ($normalized.Contains("`r")) { throw 'Bare carriage return in cross-shell text.' }
  [IO.File]::WriteAllText($Destination,$normalized,[Text.UTF8Encoding]::new($false))
}
function Write-BuildChecksums([string]$Destination,[string[]]$Records) {
  # WriteAllLines uses CRLF on Windows, which sha256sum reads as filename data.
  Write-Utf8Lf $Destination ([string]::Join("`n",$Records)+"`n")
}
function Assert-LfPatch([string]$PatchPath) {
  $bytes=[IO.File]::ReadAllBytes($PatchPath)
  if ($bytes -contains 13 -or ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)) {
    throw 'Adaptation patch must use LF without a UTF-8 BOM; do not rewrite a hash-bound patch.'
  }
}
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Initial compiler proof requires native Windows x64.' }
$WorkRoot=[IO.Path]::GetFullPath($WorkRoot)
if ($WorkRoot -notmatch '^[A-Za-z]:\\[A-Za-z0-9_\\.-]+$') { throw 'Use an absolute local path without spaces/metacharacters for this compiler proof.' }
if (Test-Path -LiteralPath $WorkRoot) { throw 'WorkRoot must not exist; SDK and build output are disposable and isolated.' }
$lock=Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
if ($lock.schema -ne 1 -or $lock.sdk.commit -ne 'e3cc14afd549778c2f2d3bcc6e89307f40f5c2c1' -or $lock.source.commit -ne '270ba2980700e6e2a0813944d506eecea0f86402') { throw 'Unexpected lock identity.' }
if ($AdaptationPatch -and $AdaptationSha256 -notmatch '^[a-f0-9]{64}$') { throw 'An adaptation requires an explicit SHA256.' }
$git=(Get-Command git.exe -ErrorAction Stop).Source
function Run-Git([string[]]$Arguments) { & $git @Arguments; if ($LASTEXITCODE -ne 0) { throw 'Pinned SDK checkout failed.' } }
function Fetch-Verified([string]$Url,[string]$Destination,[string]$Sha256) {
  if ($Sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid digest in lock.' }
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 300
  if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw "Digest mismatch: $Destination" }
}
[void](New-Item -ItemType Directory -Path $WorkRoot)
$sdk=Join-Path $WorkRoot 'sdk'
Run-Git -Arguments @('init',$sdk)
Run-Git -Arguments @('-C',$sdk,'config','core.autocrlf','false')
Run-Git -Arguments @('-C',$sdk,'config','core.symlinks','true')
Run-Git -Arguments @('-C',$sdk,'remote','add','origin',$lock.sdk.repository)
Run-Git -Arguments @('-C',$sdk,'fetch','--depth=1','origin',$lock.sdk.commit)
Run-Git -Arguments @('-C',$sdk,'checkout','--detach',$lock.sdk.commit)
$head=(& $git -C $sdk rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $lock.sdk.commit) { throw 'SDK commit mismatch.' }
$payload=Join-Path $sdk 'issue27-build'
[void](New-Item -ItemType Directory -Path $payload)
[void](New-Item -ItemType Directory -Path (Join-Path $payload 'archives'))
Write-Utf8Lf (Join-Path $payload 'lock.json') ([IO.File]::ReadAllText($LockPath))
Write-Utf8Lf (Join-Path $payload 'build.sh') ([IO.File]::ReadAllText($ShellPath))
Fetch-Verified $lock.source.url (Join-Path $payload 'source.tar.gz') $lock.source.sha256
$records=New-Object 'System.Collections.Generic.List[string]'
foreach ($package in $lock.modes.$Mode.packages) {
  if ($package.filename -notmatch '^[a-zA-Z0-9+_.-]+\.pkg\.tar\.(xz|zst)$' -or $package.url -ne ('https://repo.msys2.org/msys/x86_64/'+$package.filename)) { throw 'Invalid package archive identity.' }
  if (-not $package.signatureBase64) { throw 'Unsigned package metadata refused.' }
  $destination=Join-Path (Join-Path $payload 'archives') $package.filename
  Fetch-Verified $package.url $destination $package.sha256
  [IO.File]::WriteAllBytes($destination+'.sig',[Convert]::FromBase64String($package.signatureBase64))
  $records.Add($package.sha256+'  archives/'+$package.filename)
}
Write-BuildChecksums (Join-Path $payload 'archives.sha256') $records.ToArray()
if ($AdaptationPatch) {
  if ((Get-FileHash -LiteralPath $AdaptationPatch -Algorithm SHA256).Hash.ToLowerInvariant() -ne $AdaptationSha256) { throw 'Adaptation digest mismatch.' }
  Assert-LfPatch $AdaptationPatch
  Copy-Item -LiteralPath $AdaptationPatch -Destination (Join-Path $payload 'adaptation.patch')
  Write-BuildChecksums (Join-Path $payload 'adaptation.sha256') @($AdaptationSha256+'  adaptation.patch')
}
# Build through only this checkout's MSYS host tools; never modify an installed SDK.
$env:MSYSTEM='MSYS'
$env:MSYS2_PATH_TYPE='strict'
$env:CHERE_INVOKING='1'
$env:PATH=(Join-Path $sdk 'usr\bin')+';'+(Join-Path $env:SystemRoot 'System32')
& (Join-Path $sdk 'usr\bin\bash.exe') --noprofile --norc /issue27-build/build.sh $Mode ([string]$Jobs) ([string]$lock.source.sourceDateEpoch) $lock.source.sha256
if ($LASTEXITCODE -ne 0) { throw 'Isolated proof build failed; preserve output/config.log for diagnosis.' }
Write-Output ('Compiler proof staged in '+(Join-Path $payload 'stage')+'. Native behavior and reproducibility remain unverified.')
