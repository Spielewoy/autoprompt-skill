param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$ExpectedSha256)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
if ((Get-FileHash -Algorithm SHA256 $Executable).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'compiled-helper-identity' }
[void][Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
Add-Type -Path (Join-Path $PSScriptRoot '../physical-proof/native-controls.cs')
$base = Join-Path ([IO.Path]::GetTempPath()) ('bundle-audit-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($base)
$base = [BundlePhysicalControls]::CanonicalOwnedDirectory($base)
$results = [Collections.Generic.List[string]]::new()
$junctions = [Collections.Generic.List[string]]::new()
$lease = $null
$writer = $null
$mapping = $null
function New-Case([string]$Name) {
  $root = Join-Path $base $Name
  [void][IO.Directory]::CreateDirectory($root)
  [IO.File]::WriteAllText((Join-Path $root 'manifest.json'), '{}')
  return $root
}
function Refuses([string]$Name, [scriptblock]$Body) {
  $failed = $false
  try { & $Body } catch { $failed = $true }
  if (-not $failed) { throw "negative-control-succeeded:$Name" }
  $results.Add($Name)
}
function Acquire-And-Finish([string]$Root, [string[]]$Files) {
  $l = [BundlePhysicalLease]::new($Root, $Files)
  try { $l.Finish() } finally { $l.Dispose() }
}
try {
  $root = New-Case 'valid'
  Acquire-And-Finish $root @('manifest.json')
  $results.Add('valid-closed-tree')

  $root = New-Case 'hardlink'
  [BundlePhysicalControls]::HardLink((Join-Path $base 'hardlink-alias'), (Join-Path $root 'manifest.json'))
  Refuses 'hardlinked-file' { Acquire-And-Finish $root @('manifest.json') }

  $target = New-Case 'junction-target'
  $root = Join-Path $base 'junction-root'
  [BundlePhysicalControls]::Junction($root, $target)
  $junctions.Add($root)
  Refuses 'junction-root' { Acquire-And-Finish $root @('manifest.json') }

  $root = New-Case 'junction-intermediate'
  $link = Join-Path $root 'assets'
  [BundlePhysicalControls]::Junction($link, $target)
  $junctions.Add($link)
  Refuses 'junction-intermediate' { Acquire-And-Finish $root @('manifest.json', 'assets/manifest.json') }

  # Junctions are directory reparse points. Put one at a declared regular-file
  # position too; it must not be accepted by following its target or its type.
  $root = New-Case 'junction-file-position'
  [IO.File]::Delete((Join-Path $root 'manifest.json'))
  $link = Join-Path $root 'manifest.json'
  [BundlePhysicalControls]::Junction($link, $target)
  $junctions.Add($link)
  Refuses 'junction-at-file-position' { Acquire-And-Finish $root @('manifest.json') }

  $root = New-Case 'writer'
  $writer = [IO.File]::Open((Join-Path $root 'manifest.json'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
  Refuses 'preexisting-writer' { Acquire-And-Finish $root @('manifest.json') }
  $writer.Dispose(); $writer = $null
  Acquire-And-Finish $root @('manifest.json')
  $results.Add('writer-release-positive-control')

  $root = New-Case 'mapping'
  $mapping = [BundlePhysicalControls+WritableMapping]::new((Join-Path $root 'manifest.json'))
  Refuses 'preexisting-writable-mapping' { Acquire-And-Finish $root @('manifest.json') }
  $mapping.Dispose(); $mapping = $null
  Acquire-And-Finish $root @('manifest.json')
  $results.Add('mapping-release-positive-control')

  $root = New-Case 'held'
  $file = Join-Path $root 'manifest.json'
  $lease = [BundlePhysicalLease]::new($root, @('manifest.json'))
  Refuses 'held-write' { [IO.File]::WriteAllText($file, 'changed') }
  Refuses 'held-delete' { [IO.File]::Delete($file) }
  Refuses 'held-file-rename' { [IO.File]::Move($file, (Join-Path $root 'renamed')) }
  Refuses 'held-root-rename' { [IO.Directory]::Move($root, ($root + '-renamed')) }
  $lease.Finish(); $lease.Dispose(); $lease = $null
  [IO.File]::WriteAllText($file, 'after-release')
  $results.Add('held-release-positive-control')

  $root = New-Case 'extra'
  [IO.File]::WriteAllText((Join-Path $root 'extra'), 'extra')
  Refuses 'extra-file' { Acquire-And-Finish $root @('manifest.json') }
  [IO.File]::Delete((Join-Path $root 'extra'))
  Refuses 'missing-file' { Acquire-And-Finish $root @('manifest.json', 'missing') }

  $root = New-Case 'mutation'
  $lease = [BundlePhysicalLease]::new($root, @('manifest.json'))
  $created = $false
  try { [IO.File]::WriteAllText((Join-Path $root 'extra'), 'extra'); $created = $true } catch {}
  if ($created) { Refuses 'held-extra-final-refusal' { $lease.Finish() } }
  else { $lease.Finish(); $results.Add('held-extra-creation-refused') }
  $lease.Dispose(); $lease = $null
  foreach ($name in $results) { [Console]::WriteLine('native-physical-control:' + $name) }
  [Console]::WriteLine('native-physical-count:' + $results.Count)
} finally {
  if ($null -ne $lease) { $lease.Dispose() }
  if ($null -ne $writer) { $writer.Dispose() }
  if ($null -ne $mapping) { $mapping.Dispose() }
  # Remove reparse objects non-recursively before touching the owned tree.
  foreach ($link in $junctions) { [IO.Directory]::Delete($link, $false) }
  [IO.Directory]::Delete($base, $true)
}
