# Research bootstrap: Windows x64 only. Not yet executed on Windows.
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
Copy-Item -LiteralPath $LockPath -Destination (Join-Path $payload 'lock.json')
Copy-Item -LiteralPath $ShellPath -Destination (Join-Path $payload 'build.sh')
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
[IO.File]::WriteAllLines((Join-Path $payload 'archives.sha256'),$records,[Text.UTF8Encoding]::new($false))
if ($AdaptationPatch) {
  if ((Get-FileHash -LiteralPath $AdaptationPatch -Algorithm SHA256).Hash.ToLowerInvariant() -ne $AdaptationSha256) { throw 'Adaptation digest mismatch.' }
  Copy-Item -LiteralPath $AdaptationPatch -Destination (Join-Path $payload 'adaptation.patch')
  [IO.File]::WriteAllText((Join-Path $payload 'adaptation.sha256'),$AdaptationSha256+'  adaptation.patch'+"`n",[Text.UTF8Encoding]::new($false))
}
# Build through only this checkout's MSYS host tools; never modify an installed SDK.
$env:MSYSTEM='MSYS'
$env:MSYS2_PATH_TYPE='strict'
$env:CHERE_INVOKING='1'
$env:PATH=(Join-Path $sdk 'usr\bin')+';'+(Join-Path $env:SystemRoot 'System32')
& (Join-Path $sdk 'usr\bin\bash.exe') --noprofile --norc /issue27-build/build.sh $Mode ([string]$Jobs) ([string]$lock.source.sourceDateEpoch) $lock.source.sha256
if ($LASTEXITCODE -ne 0) { throw 'Isolated proof build failed; preserve output/config.log for diagnosis.' }
Write-Output ('Compiler proof staged in '+(Join-Path $payload 'stage')+'. Native behavior and reproducibility remain unverified.')
