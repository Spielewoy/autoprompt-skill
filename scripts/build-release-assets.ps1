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

function Get-BundledDependencyNames {
    param([Parameter(Mandatory = $true)]$PackageJson)

    $bundle = $PackageJson.PSObject.Properties['bundleDependencies']
    $bundled = $PackageJson.PSObject.Properties['bundledDependencies']
    if ($bundle -and $bundled) {
        throw 'package.json must declare bundled dependencies through only one supported field.'
    }
    if (-not $bundle -and -not $bundled) { return @() }
    $configuredProperty = if ($bundle) { $bundle } else { $bundled }
    $configuredValue = $configuredProperty.Value
    if ($configuredValue -is [bool]) {
        throw 'Boolean bundleDependencies is not supported for release assets; list every bundled dependency explicitly.'
    }
    if ($null -eq $configuredValue -or $configuredValue -is [string] -or $configuredValue -isnot [System.Collections.IEnumerable]) {
        throw 'Bundled dependencies must be an explicit JSON array.'
    }
    $configured = @($configuredValue)
    $names = @($configured | ForEach-Object {
        if ($_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) -or $_ -notmatch '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$') {
            throw 'Bundled dependency names must be normalized npm package names.'
        }
        $_
    })
    if (@($names | Sort-Object -Unique).Count -ne $names.Count) {
        throw 'Bundled dependency names must be unique.'
    }
    return @($names | Sort-Object)
}

function Assert-BundledDependenciesInstalled {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string[]]$Names
    )

    foreach ($name in $Names) {
        $directory = Join-Path (Join-Path $RepoRoot 'node_modules') $name
        $manifest = Join-Path $directory 'package.json'
        if (-not (Test-Path -LiteralPath $directory -PathType Container) -or -not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
            throw "Bundled dependency $name is missing from node_modules. Run npm ci before building release assets."
        }
        try { $metadata = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json } catch {
            throw "Bundled dependency $name has an unreadable package.json. Run npm ci before building release assets."
        }
        if ([string]$metadata.name -cne $name) {
            throw "Bundled dependency $name has a mismatched package.json name. Run npm ci before building release assets."
        }
    }
}

function Assert-PackedBundledDependencies {
    param(
        [Parameter(Mandatory = $true)]$PackRecord,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )

    $reported = @($PackRecord.bundled | ForEach-Object { [string]$_ } | Sort-Object)
    if (($reported -join "`n") -cne ($Names -join "`n")) {
        throw 'npm pack did not bundle exactly the declared bundled dependencies.'
    }
    $packedPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($file in @($PackRecord.files)) {
        if ($file -and $file.path -is [string]) { [void]$packedPaths.Add($file.path.Replace('\', '/')) }
    }
    foreach ($name in $Names) {
        $prefix = "node_modules/$name/"
        $manifestPath = "${prefix}package.json"
        if (-not $packedPaths.Contains($manifestPath)) {
            throw "npm pack omitted $manifestPath from the bundled dependency closure."
        }
        $manifest = Join-Path (Join-Path (Join-Path $RepoRoot 'node_modules') $name) 'package.json'
        $metadata = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if ($metadata.main -is [string] -and -not [string]::IsNullOrWhiteSpace($metadata.main)) {
            $main = $metadata.main.Replace('\', '/')
            if ($main -match '(^|/)\.\.(/|$)' -or [IO.Path]::IsPathRooted($metadata.main)) {
                throw "Bundled dependency $name has an unsafe main entry."
            }
            if ($main.StartsWith('./')) { $main = $main.Substring(2) }
            if ([string]::IsNullOrWhiteSpace($main)) { throw "Bundled dependency $name has an empty main entry." }
            if (-not $packedPaths.Contains("$prefix$main")) {
                throw "npm pack omitted bundled dependency $name main entry $main."
            }
        }
    }
}

function Test-OfflineBundledArchiveInstall {
    param(
        [Parameter(Mandatory = $true)][string]$Tarball,
        [Parameter(Mandatory = $true)][string[]]$Names
    )

    $root = Join-Path ([IO.Path]::GetTempPath()) ("autoprompt-release-offline-" + [Guid]::NewGuid().ToString('N'))
    $cache = Join-Path $root 'empty-cache'
    $prefix = Join-Path $root 'prefix'
    try {
        New-Item -ItemType Directory -Force -Path $cache, $prefix | Out-Null
        & npm install --offline --ignore-scripts --no-audit --no-fund --cache $cache --prefix $prefix $Tarball
        if ($LASTEXITCODE -ne 0) { throw 'Offline npm install of the packaged archive failed.' }
        foreach ($name in $Names) {
            $modulePath = Join-Path (Join-Path $prefix 'node_modules/autoprompt-skill/node_modules') $name
            $manifest = Join-Path $modulePath 'package.json'
            if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
                throw "Offline npm install omitted bundled dependency $name."
            }
            # Resolve the module by its absolute installed package path so a
            # dependency in the builder's parent node_modules cannot mask an
            # incomplete archive closure.
            & node -e "require(process.argv[1])" $modulePath
            if ($LASTEXITCODE -ne 0) { throw "Offline npm install cannot load bundled dependency $name." }
        }
    } finally {
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    }
}

$packageJson = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$bundledDependencies = @(Get-BundledDependencyNames -PackageJson $packageJson)
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
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
$outputItem = Get-Item -LiteralPath $output -Force
if ($outputItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing to build release assets through a linked output directory.'
}
$previousAssets = @(Get-ChildItem -LiteralPath $output -Force)
foreach ($item in $previousAssets) {
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.Name -notmatch '^(?:autoprompt-skill-[0-9A-Za-z.+-]+(?:\.tgz|-(?:windows\.zip|linux\.tar\.gz|macos\.tar\.gz))|autoprompt-install\.(?:ps1|sh)|SHA256SUMS\.txt|RELEASE_NOTES\.md)$') {
        throw "Release output contains an unrelated file or directory: $($item.Name)"
    }
}

# Resolve package commands from this script's checkout, even when the caller's
# current directory is another project. Check payload bindings before deleting
# any previous release assets or packing an unusable snapshot.
Push-Location -LiteralPath $repoRoot
try {
    # Detect a partial snapshot before prior assets can be removed. npm pack
    # otherwise silently produces an archive that resolves these dependencies
    # from the network during installation.
    Assert-BundledDependenciesInstalled -RepoRoot $repoRoot -Names $bundledDependencies
    & node scripts/runtime-payload.cjs --check
    if ($LASTEXITCODE -ne 0) { throw 'Runtime payloads are stale; regenerate and verify them before building a release.' }
    # This builds the public installer package. Verify its Codex payload/history
    # binding; runtime admission still performs its own signed/local canary checks.
    # The separate private Codex artifact publisher retains --check's signed gate.
    & node -e "require('./scripts/codex-artifact.cjs').checkRelease()"
    if ($LASTEXITCODE -ne 0) { throw 'Codex artifact release bindings are invalid.' }
    $previousAssets | Remove-Item -Force
    $packedJson = & npm pack --json --ignore-scripts --pack-destination $output
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }
$packed = $packedJson | ConvertFrom-Json
if (@($packed).Count -ne 1 -or $packed[0].name -ne $packageJson.name -or $packed[0].version -ne $version) {
    throw 'npm packed a different package or version than the release checkout.'
}
$tarball = Join-Path $output $packed[0].filename
if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) {
    throw "npm pack did not create $tarball"
}
Assert-PackedBundledDependencies -PackRecord $packed[0] -Names $bundledDependencies -RepoRoot $repoRoot
Test-OfflineBundledArchiveInstall -Tarball $tarball -Names $bundledDependencies

$readme = @"
Autoprompt skill $version

Requirements:
- Node.js 20 or newer
- Python 3.11 or newer, exposed as python3 or python
- PyYAML installed in that interpreter
- AUTOPROMPT_PYTHON may select an exact interpreter path
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

# Standalone downloads install this exact release archive, including when
# the npm registry has not published this version yet.
$standaloneSources = @(
    @{ Name = 'install.sh'; Marker = "package='autoprompt-skill'"; Pinned = "package='https://github.com/Spielewoy/autoprompt-skill/releases/download/v$version/autoprompt-skill-$version.tgz'" },
    @{ Name = 'install.ps1'; Marker = "else { 'autoprompt-skill' }"; Pinned = "else { 'https://github.com/Spielewoy/autoprompt-skill/releases/download/v$version/autoprompt-skill-$version.tgz' }" }
)
foreach ($bootstrap in $standaloneSources) {
    $source = [IO.File]::ReadAllText((Join-Path $repoRoot "scripts/release/$($bootstrap.Name)"))
    if (-not $source.Contains($bootstrap.Marker)) {
        throw "Release bootstrap has no recognized package fallback: $($bootstrap.Name)"
    }
    $pinned = $source.Replace($bootstrap.Marker, $bootstrap.Pinned)
    [IO.File]::WriteAllText((Join-Path $output "autoprompt-$($bootstrap.Name)"), $pinned, [Text.UTF8Encoding]::new($false))
}

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

- Native Windows runtime support without WSL2 or a VM, including Claude Code 2.1.270
- OpenCode activation through npm-generated native executable shims and PowerShell argument forwarding
- Platform fixes and native verification on Windows, macOS, and Linux, including x64 and ARM64
- Windows Codex activation-bound network enforcement, credential isolation, and process cleanup
- Benchmark claims remain withheld until a preregistered run has complete independently verifiable evidence
- State-aware CLI scans eleven coding agents, reports installed versions, and offers install, update, repair, doctor, and uninstall flows
- Older Codex installs are detected and updated in place
- Explicit invocation keeps the orchestration loop isolated from ordinary coding requests
- Native provider packages for Claude Code, Codex, OpenCode, Kilo Code, VS Code, Prime Agent, Oh My Pi, DeepSeek Harness, Hermes Agent, Grok Build, and Reasonix
- Current v2 instructions and diagrams in English, Chinese, Korean, Spanish, and Arabic

## Install

```bash
npm install -g ./autoprompt-skill-__VERSION__.tgz
autoprompt
```

## Installer providers

- Claude Code
- Codex
- OpenCode
- Kilo Code
- VS Code
- Prime Agent
- Oh My Pi
- DeepSeek Harness
- Hermes Agent
- Grok Build
- Reasonix

## Release assets

- npm archive for package managers and offline installation
- Windows kit with PowerShell bootstrap
- Linux kit with Bash bootstrap
- macOS kit with Bash bootstrap
- standalone bootstrap scripts
- SHA-256 checksums for every downloadable asset

## Requirements

Node.js 20 or newer, Python 3.11 or newer with PyYAML (available as `python3` or `python`), and Bash 4.3 or newer on Linux or macOS.

Installer support and native runtime admission are separate. Native Windows execution does not require WSL2 or a VM. Windows Codex requires an administrator-started controller and an initialized official sandbox. Codex verification covers native activation, sandbox enforcement, and cleanup with zero model calls; it does not certify live-model missions. See the README and v2 verification guide for provider requirements.

## Contributors

Thanks to @Oscar-Williams for the native Windows npm-shim fix in PR #29. His original commit and authorship are preserved.
'@
$releaseNotes = $releaseNotes.Replace('__VERSION__', $version)
Set-Content -LiteralPath (Join-Path $output 'RELEASE_NOTES.md') -Value $releaseNotes -Encoding utf8

Write-Host "Built Autoprompt skill $version release assets in $output"
