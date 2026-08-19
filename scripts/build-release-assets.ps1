[CmdletBinding()]
param(
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'dist'
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

$packageJson = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "package.json has an invalid release version: $version"
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
if ([IO.Path]::GetPathRoot($output) -eq $output) {
    throw 'Refusing to use a filesystem root as the release output directory.'
}
if ($output -eq [IO.Path]::GetFullPath($repoRoot)) {
    throw 'Refusing to use the repository root as the release output directory.'
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
Get-ChildItem -LiteralPath $output -Force | Remove-Item -Recurse -Force

$packedJson = & npm pack --json --ignore-scripts --pack-destination $output
if ($LASTEXITCODE -ne 0) {
    throw "npm pack failed with exit code $LASTEXITCODE."
}
$packed = $packedJson | ConvertFrom-Json
$tarball = Join-Path $output $packed[0].filename
if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) {
    throw "npm pack did not create $tarball"
}

$readme = @"
Autoprompt skill $version

Requirements:
- Node.js 20 or newer
- Python 3.11 or newer, exposed as python
- PyYAML: python -m pip install PyYAML
- Bash 4.3 or newer on Linux and macOS

Install:
- Windows: right-click install.ps1 and run it with PowerShell, or run .\install.ps1
- Linux or macOS: run bash ./install.sh

The installer uses the bundled npm archive, then launches the provider chooser when the terminal is interactive.
"@

$stage = Join-Path $output '.stage'
try {
    foreach ($platform in @('windows', 'linux', 'macos')) {
        $directory = Join-Path $stage $platform
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
        Copy-Item -LiteralPath $tarball -Destination $directory
        Set-Content -LiteralPath (Join-Path $directory 'README.txt') -Value $readme -Encoding utf8
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/release/install.ps1') -Destination (Join-Path $stage 'windows/install.ps1')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/release/install.sh') -Destination (Join-Path $stage 'linux/install.sh')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/release/install.sh') -Destination (Join-Path $stage 'macos/install.sh')

    Compress-Archive -Path (Join-Path $stage 'windows/*') -DestinationPath (Join-Path $output "autoprompt-skill-$version-windows.zip") -CompressionLevel Optimal
    & tar -czf (Join-Path $output "autoprompt-skill-$version-linux.tar.gz") -C (Join-Path $stage 'linux') .
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the Linux release kit.' }
    & tar -czf (Join-Path $output "autoprompt-skill-$version-macos.tar.gz") -C (Join-Path $stage 'macos') .
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the macOS release kit.' }
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}

Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/release/install.ps1') -Destination (Join-Path $output 'autoprompt-install.ps1')
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/release/install.sh') -Destination (Join-Path $output 'autoprompt-install.sh')

$assets = Get-ChildItem -LiteralPath $output -File | Sort-Object Name
$checksums = foreach ($asset in $assets) {
    $hash = Get-Sha256Hex -Path $asset.FullName
    "$hash  $($asset.Name)"
}
Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Value $checksums -Encoding ascii

$releaseNotes = @'
# Autoprompt Skill __VERSION__

Autoprompt turns one explicit goal into a closed plan, build, test, review, repair, and verification loop.

## Highlights

- 45% fewer failures in the published Terminal-Bench 2.1 run: 29 failures fell to 16
- State-aware CLI scans six coding agents, reports installed versions, and offers install, update, repair, doctor, and uninstall flows
- Older Codex installs are detected and updated in place
- Explicit invocation keeps the orchestration loop isolated from ordinary coding requests
- Native provider packages for Claude Code, Codex, OpenCode, Kilo Code, VS Code, and Prime Agent
- Deterministic English, Chinese, Korean, Spanish, and Arabic documentation visuals

## Install

```bash
npm install -g autoprompt-skill
autoprompt
```

## Supported coding agents

- Claude Code
- Codex
- OpenCode
- Kilo Code
- VS Code
- Prime Agent

## Release assets

- npm archive for package managers and offline installation
- Windows kit with PowerShell bootstrap
- Linux kit with Bash bootstrap
- macOS kit with Bash bootstrap
- standalone bootstrap scripts
- SHA-256 checksums for every downloadable asset

## Requirements

Node.js 20 or newer, Python 3.11 or newer with PyYAML, and Bash 4.3 or newer on Linux or macOS.

See the README for provider versions, custom roots, model routing, and benchmark evidence.
'@
$releaseNotes = $releaseNotes.Replace('__VERSION__', $version)
Set-Content -LiteralPath (Join-Path $output 'RELEASE_NOTES.md') -Value $releaseNotes -Encoding utf8

Write-Host "Built Autoprompt skill $version release assets in $output"
